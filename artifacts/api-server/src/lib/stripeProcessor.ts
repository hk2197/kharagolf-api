/**
 * Task #373 — Stripe processor adapter.
 *
 * Lightweight wrapper over Stripe's REST API for the multi-currency flow.
 * We deliberately use `fetch` against the bare REST API rather than the
 * `stripe` SDK to avoid pulling another large dependency into the API
 * server bundle just for the two endpoints we need (PaymentIntents create +
 * webhook signature verification).
 *
 * Configuration:
 *   - STRIPE_SECRET_KEY      — server-side secret (`sk_...`). Required for
 *                              non-INR Stripe payments. If missing, calls
 *                              throw a clear error so admins know to set it.
 *   - STRIPE_WEBHOOK_SECRET  — used by webhook signature verification.
 */

import crypto from "crypto";
import { logger } from "./logger";

const STRIPE_API = "https://api.stripe.com/v1";

export interface StripePaymentIntent {
  id: string;
  client_secret: string | null;
  amount: number;
  currency: string;
  status: string;
}

function getKey(): string {
  const k = process.env["STRIPE_SECRET_KEY"];
  if (!k) {
    throw new Error("[stripe] STRIPE_SECRET_KEY is not configured. Non-INR payments require Stripe credentials.");
  }
  return k;
}

function encodeForm(obj: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      parts.push(...encodeForm(value as Record<string, unknown>, k));
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

export async function createStripePaymentIntent(opts: {
  amountMinor: number;
  currency: string;
  description?: string;
  receiptEmail?: string;
  metadata?: Record<string, string | number | boolean>;
  automaticPaymentMethods?: boolean;
}): Promise<StripePaymentIntent> {
  const key = getKey();
  const body = encodeForm({
    amount: opts.amountMinor,
    currency: opts.currency.toLowerCase(),
    description: opts.description,
    receipt_email: opts.receiptEmail,
    metadata: opts.metadata as Record<string, unknown> | undefined,
    "automatic_payment_methods[enabled]": opts.automaticPaymentMethods !== false ? "true" : "false",
  }).join("&");
  const res = await fetch(`${STRIPE_API}/payment_intents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await res.json() as Record<string, unknown> & { id?: string; client_secret?: string };
  if (!res.ok) {
    const errMsg = (json?.error as { message?: string } | undefined)?.message ?? `Stripe error ${res.status}`;
    logger.error({ status: res.status, json }, "[stripe] createPaymentIntent failed");
    throw new Error(`[stripe] ${errMsg}`);
  }
  return json as unknown as StripePaymentIntent;
}

/**
 * Verify a Stripe webhook signature. Stripe's scheme is documented at
 * https://stripe.com/docs/webhooks/signatures — we re-implement the v1 HMAC
 * check to avoid the SDK dep.
 */
export function verifyStripeWebhookSignature(
  rawBody: Buffer | string,
  sigHeader: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v] as const;
    }),
  );
  const ts = parts["t"];
  const v1 = parts["v1"];
  if (!ts || !v1) return false;
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10));
  if (ageSec > toleranceSeconds) return false;
  const payload = `${ts}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // timingSafeEqual requires equal length buffers.
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** True iff Stripe credentials are present (used by health/diagnostic endpoints). */
export function isStripeConfigured(): boolean {
  return !!process.env["STRIPE_SECRET_KEY"];
}

/** Optional publishable key surfaced to clients for Stripe Elements bootstrap. */
export function getStripePublishableKey(): string | undefined {
  return process.env["STRIPE_PUBLISHABLE_KEY"];
}

export interface StripeVerificationResult {
  paid: boolean;
  amountMinor: number;
  currency: string;
  paymentRef: string;
  status: string;
  /** Object id (payment_intent or checkout_session) returned by Stripe — used by callers to bind the verification to a stored reference. */
  objectId: string;
  /** Custom metadata attached at creation time (used to bind the payment back to the originating invoice/order). */
  metadata: Record<string, string>;
}

/**
 * Verify a Stripe payment by paymentIntentId or checkoutSessionId. Used by
 * checkout verify endpoints as the Stripe equivalent of
 * `verifyPaymentSignature`. Returns paid=true when the upstream object is in
 * a settled state (`succeeded` PI or `paid` Checkout Session).
 */
export async function verifyStripePayment(opts: {
  paymentIntentId?: string;
  checkoutSessionId?: string;
}): Promise<StripeVerificationResult> {
  const key = getKey();
  let url: string;
  if (opts.paymentIntentId) url = `${STRIPE_API}/payment_intents/${encodeURIComponent(opts.paymentIntentId)}`;
  else if (opts.checkoutSessionId) url = `${STRIPE_API}/checkout/sessions/${encodeURIComponent(opts.checkoutSessionId)}`;
  else throw new Error("[stripe] verifyStripePayment requires paymentIntentId or checkoutSessionId");

  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errMsg = (json?.error as { message?: string } | undefined)?.message ?? `Stripe error ${res.status}`;
    throw new Error(`[stripe] ${errMsg}`);
  }
  const rawMeta = (json["metadata"] as Record<string, unknown> | null | undefined) ?? {};
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawMeta)) metadata[k] = v == null ? "" : String(v);

  if (opts.paymentIntentId) {
    const status = String(json["status"] ?? "");
    return {
      paid: status === "succeeded",
      amountMinor: Number(json["amount_received"] ?? json["amount"] ?? 0),
      currency: String(json["currency"] ?? "").toUpperCase(),
      paymentRef: String(json["id"] ?? opts.paymentIntentId),
      status,
      objectId: String(json["id"] ?? opts.paymentIntentId),
      metadata,
    };
  }
  // Checkout Session
  const status = String(json["payment_status"] ?? "");
  const piId = (json["payment_intent"] as string | null) ?? null;
  return {
    paid: status === "paid",
    amountMinor: Number(json["amount_total"] ?? 0),
    currency: String(json["currency"] ?? "").toUpperCase(),
    paymentRef: piId ?? String(json["id"] ?? opts.checkoutSessionId),
    status,
    objectId: String(json["id"] ?? opts.checkoutSessionId),
    metadata,
  };
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  amount_total: number | null;
  currency: string | null;
}

/**
 * Create a hosted Stripe Checkout Session — used as the Stripe equivalent of
 * a Razorpay Payment Link. Returns the redirect URL plus the session id.
 */
export async function createStripeCheckoutSession(opts: {
  amountMinor: number;
  currency: string;
  description: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string | number | boolean>;
}): Promise<StripeCheckoutSession> {
  const key = getKey();
  const body = encodeForm({
    mode: "payment",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    customer_email: opts.customerEmail,
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": opts.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": opts.amountMinor,
    "line_items[0][price_data][product_data][name]": opts.description,
    metadata: opts.metadata as Record<string, unknown> | undefined,
  }).join("&");
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errMsg = (json?.error as { message?: string } | undefined)?.message ?? `Stripe error ${res.status}`;
    logger.error({ status: res.status, json }, "[stripe] createCheckoutSession failed");
    throw new Error(`[stripe] ${errMsg}`);
  }
  return json as unknown as StripeCheckoutSession;
}
