/**
 * Outbound Webhook Dispatch Service (Task #149)
 *
 * Accepts an event type + payload, looks up active subscribed endpoints,
 * signs the payload with HMAC-SHA256, dispatches HTTP POSTs, and logs
 * each attempt as a separate row for full history retention.
 *
 * Retry schedule: immediate → 1 min → 5 min → 30 min → 2 h (up to 5 attempts)
 * Each attempt creates its own delivery_log row (attemptCount = 1..5).
 *
 * SSRF protection: rejects loopback, link-local, and RFC-1918 private CIDR
 * targets before any network call is made.
 */

import { createHmac } from "crypto";
import { lookup } from "dns/promises";
import { db, webhookEndpointsTable, webhookDeliveryLogTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "webhookDispatch" });

export const WEBHOOK_EVENT_TYPES = [
  "player.registered",
  "player.checked_in",
  "score.submitted",
  "score.updated",
  "tournament.published",
  "tournament.completed",
  "league.round_completed",
  "payment.received",
  "handicap.updated",
  "member.joined",
  "member.removed",
] as const;

export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  org_id: number;
  data: Record<string, unknown>;
}

/** Back-off delays in milliseconds between retry attempts */
const BACKOFF_MS = [
  0,          // attempt 1: immediate
  60_000,     // attempt 2: 1 min
  300_000,    // attempt 3: 5 min
  1_800_000,  // attempt 4: 30 min
  7_200_000,  // attempt 5: 2 h
];

const MAX_ATTEMPTS = 5;

/** Signs the JSON body string with HMAC-SHA256 using the endpoint secret. */
function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * SSRF guard: resolve the hostname and reject private / loopback / link-local
 * IP addresses to prevent server-side request forgery.
 */
async function validateWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Webhook URL must use http or https (got ${parsed.protocol})`);
  }

  const hostname = parsed.hostname;

  // Block numeric IPv4 literals immediately (no DNS lookup needed)
  const ipv4Literal = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Literal) {
    const [, a, b, c, d] = ipv4Literal.map(Number);
    if (isPrivateIPv4(a, b, c, d)) {
      throw new Error(`Webhook URL resolves to a private/reserved IP address (${hostname})`);
    }
    return;
  }

  // Block IPv6 loopback/link-local literals
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "::1" || bare === "localhost" || bare.startsWith("fe80:")) {
    throw new Error(`Webhook URL resolves to a private/reserved IP address (${hostname})`);
  }

  // Resolve hostname and check each returned IP
  try {
    const addrs = await lookup(hostname, { all: true });
    for (const { address, family } of addrs) {
      if (family === 4) {
        const [a, b, c, d] = address.split(".").map(Number);
        if (isPrivateIPv4(a, b, c, d)) {
          throw new Error(`Webhook URL hostname '${hostname}' resolves to a private/reserved IP (${address})`);
        }
      }
      // IPv6: reject loopback and link-local
      if (family === 6) {
        const lower = address.toLowerCase();
        if (lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
          throw new Error(`Webhook URL hostname '${hostname}' resolves to a private/reserved IPv6 address (${address})`);
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOTFOUND") {
      throw new Error(`Webhook URL hostname '${hostname}' could not be resolved`);
    }
    throw err;
  }
}

function isPrivateIPv4(a: number, b: number, c: number, d: number): boolean {
  return (
    a === 10 ||                                      // 10.0.0.0/8
    a === 127 ||                                     // 127.0.0.0/8 (loopback)
    (a === 172 && b >= 16 && b <= 31) ||             // 172.16.0.0/12
    (a === 192 && b === 168) ||                      // 192.168.0.0/16
    (a === 169 && b === 254) ||                      // 169.254.0.0/16 (link-local / cloud metadata)
    (a === 100 && b >= 64 && b <= 127) ||            // 100.64.0.0/10 (shared address space)
    a === 0 ||                                       // 0.0.0.0/8
    (a === 192 && b === 0 && c === 2) ||             // 192.0.2.0/24 (TEST-NET-1)
    (a === 198 && b >= 18 && b <= 19) ||             // 198.18.0.0/15 (benchmarking)
    (a === 198 && b === 51 && c === 100) ||          // 198.51.100.0/24 (TEST-NET-2)
    (a === 203 && b === 0 && c === 113) ||           // 203.0.113.0/24 (TEST-NET-3)
    a >= 224                                         // 224+ (multicast, reserved, broadcast)
  );
}

/**
 * Dispatch a webhook event to all active subscribed endpoints for an org.
 * Fire-and-forget: returns immediately; delivery happens async.
 */
export function dispatchWebhookEvent(
  orgId: number,
  event: WebhookEventType,
  data: Record<string, unknown>,
): void {
  setImmediate(async () => {
    try {
      const endpoints = await db
        .select()
        .from(webhookEndpointsTable)
        .where(and(
          eq(webhookEndpointsTable.organizationId, orgId),
          eq(webhookEndpointsTable.isActive, true),
        ));

      const subscribed = endpoints.filter(ep =>
        ep.subscribedEvents.includes(event),
      );

      if (subscribed.length === 0) return;

      const payload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        org_id: orgId,
        data,
      };
      const body = JSON.stringify(payload);

      await Promise.all(subscribed.map(ep => deliverToEndpoint(ep.id, ep.url, ep.secret, event, payload, body)));
    } catch (err) {
      logger.error({ err, orgId, event }, "[webhookDispatch] Failed to query endpoints");
    }
  });
}

async function deliverToEndpoint(
  endpointId: number,
  url: string,
  secret: string,
  event: WebhookEventType,
  payload: WebhookPayload,
  body: string,
): Promise<void> {
  // SSRF guard: validate URL before any attempt
  try {
    await validateWebhookUrl(url);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn({ endpointId, url, err: errorMessage }, "[webhookDispatch] SSRF guard blocked delivery");
    await db.insert(webhookDeliveryLogTable).values({
      endpointId,
      eventType: event,
      payload: payload as unknown as Record<string, unknown>,
      statusCode: null,
      responseTimeMs: 0,
      attemptCount: 1,
      lastAttemptedAt: new Date(),
      errorMessage: `Blocked by SSRF guard: ${errorMessage}`,
    });
    return;
  }

  await attemptDelivery(endpointId, url, secret, event, payload, body, 0);
}

/**
 * Each call to attemptDelivery inserts a new delivery_log row for that
 * specific attempt so the full retry history is preserved.
 */
async function attemptDelivery(
  endpointId: number,
  url: string,
  secret: string,
  event: WebhookEventType,
  payload: WebhookPayload,
  body: string,
  attempt: number,
): Promise<void> {
  if (attempt >= MAX_ATTEMPTS) {
    logger.warn({ endpointId, url }, "[webhookDispatch] Max attempts reached — giving up");
    return;
  }

  const delay = BACKOFF_MS[attempt] ?? 0;
  if (delay > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, delay));
  }

  const signature = signPayload(secret, body);
  const start = Date.now();
  let statusCode: number | null = null;
  let errorMessage: string | null = null;
  let responseTimeMs = 0;
  let delivered = false;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-KharaGolf-Signature": `sha256=${signature}`,
        "X-KharaGolf-Event": event,
        "User-Agent": "KHARAGOLF-Webhooks/1.0",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    statusCode = resp.status;
    responseTimeMs = Date.now() - start;
    delivered = resp.status >= 200 && resp.status < 300;
    if (!delivered) {
      errorMessage = `HTTP ${statusCode}`;
    }
  } catch (err) {
    responseTimeMs = Date.now() - start;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  // Insert a fresh log row for this attempt (preserves full retry history)
  await db.insert(webhookDeliveryLogTable).values({
    endpointId,
    eventType: event,
    payload: payload as unknown as Record<string, unknown>,
    statusCode,
    responseTimeMs,
    attemptCount: attempt + 1,
    lastAttemptedAt: new Date(),
    deliveredAt: delivered ? new Date() : null,
    errorMessage,
  });

  if (delivered) {
    logger.info({ endpointId, url, statusCode, responseTimeMs, attempt: attempt + 1 }, "[webhookDispatch] Delivered");
    return;
  }

  logger.warn({ endpointId, url, statusCode, err: errorMessage, attempt: attempt + 1 }, "[webhookDispatch] Will retry");
  await attemptDelivery(endpointId, url, secret, event, payload, body, attempt + 1);
}

/**
 * Send a one-off test delivery to an endpoint.
 * Returns the HTTP status code or null on network failure.
 */
export async function sendTestDelivery(
  endpointId: number,
  url: string,
  secret: string,
  orgId: number,
): Promise<{ statusCode: number | null; responseTimeMs: number; ok: boolean; error?: string }> {
  // SSRF guard
  try {
    await validateWebhookUrl(url);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db.insert(webhookDeliveryLogTable).values({
      endpointId,
      eventType: "player.registered",
      payload: { test: true, blocked: true },
      statusCode: null,
      responseTimeMs: 0,
      attemptCount: 1,
      lastAttemptedAt: new Date(),
      errorMessage: `Blocked by SSRF guard: ${error}`,
    });
    return { statusCode: null, responseTimeMs: 0, ok: false, error };
  }

  const payload: WebhookPayload = {
    event: "player.registered",
    timestamp: new Date().toISOString(),
    org_id: orgId,
    data: { test: true, message: "This is a test delivery from KHARAGOLF webhooks." },
  };
  const body = JSON.stringify(payload);
  const signature = signPayload(secret, body);
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-KharaGolf-Signature": `sha256=${signature}`,
        "X-KharaGolf-Event": "player.registered",
        "User-Agent": "KHARAGOLF-Webhooks/1.0",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const responseTimeMs = Date.now() - start;
    const ok = resp.status >= 200 && resp.status < 300;

    await db.insert(webhookDeliveryLogTable).values({
      endpointId,
      eventType: "player.registered",
      payload: payload as unknown as Record<string, unknown>,
      statusCode: resp.status,
      responseTimeMs,
      attemptCount: 1,
      lastAttemptedAt: new Date(),
      deliveredAt: ok ? new Date() : null,
      errorMessage: ok ? null : `HTTP ${resp.status} (test delivery)`,
    });

    return { statusCode: resp.status, responseTimeMs, ok };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);

    await db.insert(webhookDeliveryLogTable).values({
      endpointId,
      eventType: "player.registered",
      payload: payload as unknown as Record<string, unknown>,
      statusCode: null,
      responseTimeMs,
      attemptCount: 1,
      lastAttemptedAt: new Date(),
      errorMessage: `Test delivery failed: ${error}`,
    });

    return { statusCode: null, responseTimeMs, ok: false, error };
  }
}
