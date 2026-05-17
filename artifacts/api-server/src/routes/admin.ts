import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac } from "crypto";
import { db, pool, dbCancellation } from "@workspace/db";
import { organizationsTable, tournamentsTable, playersTable, appUsersTable, clubCurrencyProfilesTable, stripeWebhookDeliveriesTable, notificationAuditLogTable, recapBroadcastsTable, recapShareEventsTable, recapShareDailyAggregatesTable, wearableReauthWowAcknowledgmentsTable, swingVideoFpsProbesTable, userNotificationPrefsTable, orgMembershipsTable } from "@workspace/db";
import {
  ADMIN_EVENT_MUTE_REGISTRY,
  adminEventNotificationKeys,
  getAdminEventMuteEntry,
  type AdminEventMuteEntry,
} from "../lib/adminEventMuteRegistry";
import { and, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { sendBroadcastEmail, sendNotificationEmail } from "../lib/mailer";
import { previewNotificationTemplate } from "../lib/notifyDispatch";
import { sendPushToUsers, classifyPushDelivery } from "../lib/push";
import { listRegisteredDetails } from "../lib/notificationRegistry";
import {
  getLastWellnessSweepResult,
  getWellnessSweepHistory,
  getWeeklyReauthDriftSnapshot,
  getWeeklyReauthDriftHistory,
  getWeeklyReauthDriftAcknowledgmentHistory,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_COUNT,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_SHARE_PCT,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_ATTEMPTED,
  WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA,
  WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS,
  WELLNESS_REAUTH_WOW_ACK_HISTORY_DEFAULT_LIMIT,
  WELLNESS_REAUTH_WOW_SNOOZE_COUNT_WINDOW_DAYS,
  getMaxSnoozesPer30d,
} from "../lib/wearables";
import {
  getLastStripeWebhookSweepResult,
  getStripeWebhookSweepHistory,
  isStripeWebhookSweepStale,
} from "../lib/stripeWebhookSweepStatus";
import { RECAP_NOTIFICATION_KEY } from "../lib/year-in-golf-cron";
import {
  getExhaustionHistoryByDay,
  getConfiguredOpsAlertRecipients,
  listExhaustedRowsForDay,
  clearChannelExhaustion,
  retryExhaustedChannel,
  type ExhaustionPipeline,
  type ExhaustionChannel,
} from "../lib/notifyExhaustionOpsAlert";
import {
  listExhaustedAdminNotifyRows,
  resendExhaustedAdminNotifyRow,
  type AdminNotifyFailurePipeline,
} from "../lib/notifyExhaustionAdminPanel";
import { enqueueFpsProbe, getFpsProbeQueueStats } from "../lib/swingFpsProbeQueue";

const router: IRouter = Router();

// GET /admin/channel-status — returns which comms channels are active (env secrets present)
// Restricted to authenticated org_admin / tournament_director users.
router.get("/admin/channel-status", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const smsProvider = process.env.SMS_PROVIDER?.toLowerCase();
  const waProvider = process.env.WHATSAPP_PROVIDER?.toLowerCase();

  const smsActive =
    (smsProvider === "msg91" && !!process.env.MSG91_AUTH_KEY && !!process.env.MSG91_SENDER_ID) ||
    (smsProvider === "twilio" && !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_FROM_NUMBER);

  const waActive =
    (waProvider === "msg91" && !!process.env.MSG91_WHATSAPP_AUTH_KEY && !!process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER) ||
    (waProvider === "twilio" && !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_WHATSAPP_FROM);

  const emailActive = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

  // Stripe webhook configuration — only material for non-INR clubs that route
  // checkout through Stripe. We surface the env state alongside the org's base
  // currency so the UI can decide whether to flag a misconfiguration.
  const stripeSecretKeyConfigured = !!process.env.STRIPE_SECRET_KEY;
  const stripeWebhookSecretConfigured = !!process.env.STRIPE_WEBHOOK_SECRET;
  const stripeWebhookEndpoint = "/api/webhooks/stripe";

  let baseCurrency: string | null = null;
  let usesStripe = false;
  const orgId = (req.user as { organizationId?: number | null } | undefined)?.organizationId ?? null;
  if (orgId) {
    try {
      const [profile] = await db
        .select({ baseCurrency: clubCurrencyProfilesTable.baseCurrency })
        .from(clubCurrencyProfilesTable)
        .where(eq(clubCurrencyProfilesTable.organizationId, orgId));
      baseCurrency = (profile?.baseCurrency ?? "INR").toUpperCase();
      usesStripe = baseCurrency !== "INR";
    } catch (err) {
      // Don't suppress the warning silently — log so misconfigurations surface.
      req.log?.warn({ err, orgId }, "[channel-status] failed to load currency profile; cannot determine Stripe applicability");
      baseCurrency = null;
    }
  }

  // We can only verify the secret env var presence here; we don't actively probe
  // the Stripe dashboard to confirm the endpoint is registered.
  const stripeWebhookWarning = usesStripe && !stripeWebhookSecretConfigured;

  res.json({
    channels: {
      email: {
        active: emailActive,
        provider: emailActive ? "gmail" : null,
        setupInstructions: emailActive ? null : "Set GMAIL_USER and GMAIL_APP_PASSWORD environment variables to enable email delivery.",
      },
      push: {
        active: true,
        provider: "expo",
        setupInstructions: null,
      },
      sms: {
        active: smsActive,
        provider: smsActive ? (smsProvider ?? null) : null,
        setupInstructions: smsActive
          ? null
          : "To enable SMS: set SMS_PROVIDER=msg91 and MSG91_AUTH_KEY + MSG91_SENDER_ID, or SMS_PROVIDER=twilio and TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER.",
      },
      whatsapp: {
        active: waActive,
        provider: waActive ? (waProvider ?? null) : null,
        setupInstructions: waActive
          ? null
          : "To enable WhatsApp: set WHATSAPP_PROVIDER=msg91 and MSG91_WHATSAPP_AUTH_KEY + MSG91_WHATSAPP_INTEGRATED_NUMBER, or WHATSAPP_PROVIDER=twilio and TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM.",
      },
    },
    payments: {
      stripe: {
        baseCurrency,
        usesStripe,
        secretKeyConfigured: stripeSecretKeyConfigured,
        webhookSecretConfigured: stripeWebhookSecretConfigured,
        webhookEndpoint: stripeWebhookEndpoint,
        warning: stripeWebhookWarning,
        setupInstructions: stripeWebhookSecretConfigured
          ? null
          : "Set STRIPE_WEBHOOK_SECRET (and STRIPE_SECRET_KEY) on the API server, then add an endpoint in the Stripe dashboard pointing to /api/webhooks/stripe so payment confirmations can reconcile automatically.",
      },
    },
  });
});

// POST /admin/test-email — sends a test email to the authenticated user's address
router.post("/admin/test-email", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const user = req.user as { id?: number; email?: string; firstName?: string; lastName?: string; role?: string } | undefined;
  if (!user?.email) { { res.status(400).json({ error: "No email address on your account" }); return; } }

  const gmailConfigured = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  if (!gmailConfigured) { { res.status(503).json({ error: "Email not configured — set GMAIL_USER and GMAIL_APP_PASSWORD" }); return; } }

  try {
    await sendBroadcastEmail(
      user.email,
      `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "Admin",
      "Email delivery test",
      `Your KHARAGOLF email delivery is working correctly.\n\nThis test was triggered from the Communications panel.\n\nSending address: ${process.env.GMAIL_USER}`,
      "KHARAGOLF",
    );
    res.json({ ok: true, sentTo: user.email, from: process.env.GMAIL_USER });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    req.log?.error({ email: user.email, errMsg }, "[test-email] failed");
    res.status(502).json({ error: errMsg });
  }
});

// POST /admin/test-stripe-webhook — sends a synthetic, signed
// `checkout.session.completed` event to our own /api/webhooks/stripe endpoint
// so admins can verify end-to-end that the webhook secret + endpoint wiring
// works. Uses the configured STRIPE_WEBHOOK_SECRET to sign per Stripe's v1
// scheme. The synthetic event uses an obviously fake session id with no
// matching DB row, so the handler will acknowledge it as "no matching row —
// event ignored" with no settlement side-effects.
router.post("/admin/test-stripe-webhook", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    res.status(503).json({
      ok: false,
      stage: "config",
      error: "STRIPE_WEBHOOK_SECRET not configured — set it on the API server before testing webhook delivery.",
    });
    return;
  }

  // Build a synthetic checkout.session.completed payload. The fake id prefix
  // (`cs_test_admin_panel_`) and metadata.test=true flag make it obvious in
  // logs that this was triggered by the admin test button rather than Stripe.
  const ts = Math.floor(Date.now() / 1000);
  const fakeId = `cs_test_admin_panel_${ts}_${Math.random().toString(36).slice(2, 10)}`;
  const event = {
    id: `evt_test_admin_panel_${ts}`,
    object: "event",
    type: "checkout.session.completed",
    created: ts,
    livemode: false,
    data: {
      object: {
        id: fakeId,
        object: "checkout.session",
        payment_status: "paid",
        amount_total: 0,
        currency: "usd",
        payment_intent: null,
        metadata: { test: "true", source: "admin_panel_test" },
      },
    },
  };
  const payload = JSON.stringify(event);
  const signature = createHmac("sha256", webhookSecret)
    .update(`${ts}.${payload}`)
    .digest("hex");
  const stripeSignatureHeader = `t=${ts},v1=${signature}`;

  // Resolve a *public* URL for the webhook endpoint so the probe traverses the
  // same DNS / TLS / reverse-proxy / firewall path Stripe would when delivering
  // a real event. Fall back to loopback only when no public hostname is
  // discoverable (and label the result accordingly so admins know).
  const publicBase =
    process.env.API_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : undefined);
  const port = process.env.PORT;
  let url: string;
  let usedPublicUrl = false;
  if (publicBase) {
    url = `${publicBase.replace(/\/+$/, "")}/api/webhooks/stripe`;
    usedPublicUrl = true;
  } else if (port) {
    url = `http://127.0.0.1:${port}/api/webhooks/stripe`;
  } else {
    res.status(500).json({
      ok: false,
      stage: "config",
      error: "Cannot determine a webhook URL — set API_BASE_URL or PUBLIC_BASE_URL so the probe matches the URL configured in your Stripe dashboard.",
    });
    return;
  }

  const startedAt = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignatureHeader,
      },
      body: payload,
    });
    const durationMs = Date.now() - startedAt;
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep as text */ }

    if (r.status === 200) {
      res.json({
        ok: true,
        stage: "delivered",
        httpStatus: r.status,
        durationMs,
        endpoint: url,
        usedPublicUrl,
        eventId: event.id,
        response: body,
      });
      return;
    }
    if (r.status === 401) {
      // The signing secret used for this probe IS the configured server
      // secret, so a 401 means the endpoint is reachable but rejected the
      // signature — almost always a stale/changed secret on one side.
      res.status(502).json({
        ok: false,
        stage: "signature_mismatch",
        httpStatus: r.status,
        durationMs,
        endpoint: url,
        usedPublicUrl,
        error: "Endpoint rejected the signed event (HTTP 401). The webhook process appears to be running with a different STRIPE_WEBHOOK_SECRET than this admin process — restart the API server after rotating the secret, and make sure the value in your Stripe dashboard matches.",
        response: body,
      });
      return;
    }
    res.status(502).json({
      ok: false,
      stage: "endpoint_error",
      httpStatus: r.status,
      durationMs,
      endpoint: url,
      usedPublicUrl,
      error: `Webhook endpoint returned HTTP ${r.status}. Check the API server logs for stack traces.`,
      response: body,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    req.log?.error({ err: errMsg, url }, "[test-stripe-webhook] delivery failed");
    res.status(502).json({
      ok: false,
      stage: "unreachable",
      durationMs: Date.now() - startedAt,
      endpoint: url,
      usedPublicUrl,
      error: usedPublicUrl
        ? `Could not reach ${url}: ${errMsg}. This is the same network path Stripe uses — check DNS, TLS, firewall, and that the URL configured in your Stripe dashboard matches.`
        : `Could not reach webhook endpoint over loopback: ${errMsg}`,
    });
  }
});

// GET /admin/stripe-webhook-deliveries — Task #974.
// Returns the most recent inbound POST /api/webhooks/stripe deliveries so the
// admin Communications panel can show whether real Stripe events have been
// arriving lately (the "Send test event" button only proves *current*
// reachability). Restricted to admins; capped at 50 rows.
router.get("/admin/stripe-webhook-deliveries", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const rawLimit = Number.parseInt(String(req.query.limit ?? "10"), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
  // Task #1295 — optional filter so admins can isolate non-2xx / bad-signature
  // rows after a secret rotation. Default behaviour is unchanged.
  const failuresOnly = String(req.query.status ?? "").toLowerCase() === "failures";
  try {
    const baseQuery = db
      .select({
        id: stripeWebhookDeliveriesTable.id,
        eventId: stripeWebhookDeliveriesTable.eventId,
        eventType: stripeWebhookDeliveriesTable.eventType,
        receivedAt: stripeWebhookDeliveriesTable.receivedAt,
        sourceIp: stripeWebhookDeliveriesTable.sourceIp,
        signatureValid: stripeWebhookDeliveriesTable.signatureValid,
        applied: stripeWebhookDeliveriesTable.applied,
        responseStatus: stripeWebhookDeliveriesTable.responseStatus,
        errorReason: stripeWebhookDeliveriesTable.errorReason,
      })
      .from(stripeWebhookDeliveriesTable);
    const failureCondition = or(
      gte(stripeWebhookDeliveriesTable.responseStatus, 300),
      eq(stripeWebhookDeliveriesTable.signatureValid, false),
    );
    const filtered = failuresOnly
      ? baseQuery.where(failureCondition)
      : baseQuery;
    // Task #1534 — also surface a `failureCount` so the "Failures only" toggle
    // can render a badge ("Failures only (3)") and admins can see at a glance
    // whether it's worth flipping the filter. The count covers the same
    // recent window the table represents — the 30-day retention sweep
    // (Task #1294) keeps this naturally bounded.
    // Task #1898 — also surface a per-reason breakdown
    // (`failureCountByReason`) so the badge tooltip can tell admins
    // *what kind* of failures make up the count without flipping the
    // filter. Lets them distinguish "all signature_mismatch" (secret
    // rotation) from "all reconciliation_failed" (downstream DB issue)
    // from a noisy mix at a glance.
    const [rows, failureCountRow, failureByReasonRows] = await Promise.all([
      filtered
        .orderBy(desc(stripeWebhookDeliveriesTable.receivedAt))
        .limit(limit),
      db
        .select({ value: count() })
        .from(stripeWebhookDeliveriesTable)
        .where(failureCondition),
      db
        .select({
          reason: stripeWebhookDeliveriesTable.errorReason,
          n: count(),
        })
        .from(stripeWebhookDeliveriesTable)
        .where(failureCondition)
        .groupBy(stripeWebhookDeliveriesTable.errorReason),
    ]);
    const failureCount = Number(failureCountRow[0]?.value ?? 0);
    // Bucket null `errorReason` (older rows or failure modes that didn't
    // capture a machine-readable label) under "unknown" so the breakdown
    // always sums to `failureCount`.
    const failureCountByReason: Record<string, number> = {};
    for (const row of failureByReasonRows) {
      const key = row.reason ?? "unknown";
      failureCountByReason[key] =
        (failureCountByReason[key] ?? 0) + Number(row.n ?? 0);
    }
    res.json({ deliveries: rows, failureCount, failureCountByReason });
  } catch (err) {
    req.log?.error({ err }, "[stripe-webhook-deliveries] query failed");
    res.status(500).json({ error: "Failed to load webhook deliveries" });
  }
});

// GET /admin/stripe-webhook-sweep-status — Task #1294.
// Returns the latest stripe-webhook-deliveries retention sweep summary
// (timestamp + how many old rows it removed) so the admin Stripe webhook
// audit page can show the retention behaviour next to the "last 10
// deliveries" table without admins having to grep server logs.
// Returns `{ lastSweep: null }` until the first sweep runs after deploy.
router.get("/admin/stripe-webhook-sweep-status", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const last = await getLastStripeWebhookSweepResult();
  // Task #1295 — Compute the "is the daily sweep silent for too long?" flag
  // server-side so the threshold (~36h) lives in one place and the admin UI
  // doesn't have to recompute it from `ranAt` on every render.
  res.json({ lastSweep: last, stale: isStripeWebhookSweepStale(last) });
});

// GET /admin/stripe-webhook-sweep-history — Task #1525.
// Returns up to 90 days of recent stripe-webhook sweep runs (most recent
// first) so the admin Stripe webhook audit page can render a short trend
// of removed-row counts next to the existing "last ran …" line. Lets
// admins spot a sudden spike in inbound webhook traffic, or a stretch
// where the sweep hasn't been firing, without grepping server logs.
// Defaults to the last 14 days, capped at the underlying table's ~90-day
// retention horizon.
router.get("/admin/stripe-webhook-sweep-history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const daysRaw = Number(req.query.days);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 90 ? Math.floor(daysRaw) : 14;
  const runs = await getStripeWebhookSweepHistory(days);
  res.json({ days, runs });
});

// Task #1705 — Surface persistent swing-video fps-probe failures.
//
// Task #1412 deliberately keeps `failed` rows in `swing_video_fps_probes`
// after MAX_FPS_PROBE_ATTEMPTS so persistent breakage stays visible, but
// until now the only way to act on them was to query the DB directly.
// These endpoints back a small admin diagnostics tile (modelled on the
// existing Stripe-webhook audit panel) so operators can see the most
// recent failed probes and either re-enqueue or dismiss them.
//
// Gating mirrors the rest of the diagnostics endpoints in this file —
// authenticated org_admin / tournament_director / super_admin only.
const FPS_PROBE_FAILURE_DEFAULT_LIMIT = 20;
const FPS_PROBE_FAILURE_MAX_LIMIT = 50;
// The error_message column is capped at 500 chars by the worker, but the
// table cell only needs the first slice for a quick scan; the full text
// goes into the row's `errorMessage` so the UI can show it on hover.
const FPS_PROBE_FAILURE_ERROR_PREVIEW_CHARS = 200;

// GET /admin/swing-fps-probe-failures?limit=N — most recent failed probes.
router.get("/admin/swing-fps-probe-failures", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const rawLimit = Number.parseInt(String(req.query.limit ?? FPS_PROBE_FAILURE_DEFAULT_LIMIT), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, FPS_PROBE_FAILURE_MAX_LIMIT)
    : FPS_PROBE_FAILURE_DEFAULT_LIMIT;
  try {
    // Newest failures first — that's the order admins want when triaging
    // an active incident. We order by `completedAt` (set when the worker
    // gives up) rather than `updatedAt` because retry attempts also
    // bump `updatedAt` while the row is still 'queued'.
    const [rows, totalRow] = await Promise.all([
      db.select({
        id: swingVideoFpsProbesTable.id,
        swingVideoId: swingVideoFpsProbesTable.swingVideoId,
        objectPath: swingVideoFpsProbesTable.objectPath,
        attempts: swingVideoFpsProbesTable.attempts,
        errorMessage: swingVideoFpsProbesTable.errorMessage,
        completedAt: swingVideoFpsProbesTable.completedAt,
        updatedAt: swingVideoFpsProbesTable.updatedAt,
      })
        .from(swingVideoFpsProbesTable)
        .where(eq(swingVideoFpsProbesTable.status, "failed"))
        .orderBy(desc(swingVideoFpsProbesTable.completedAt), desc(swingVideoFpsProbesTable.id))
        .limit(limit),
      db.select({ value: count() })
        .from(swingVideoFpsProbesTable)
        .where(eq(swingVideoFpsProbesTable.status, "failed")),
    ]);
    const failureCount = Number(totalRow[0]?.value ?? 0);
    const failures = rows.map(r => ({
      id: r.id,
      swingVideoId: r.swingVideoId,
      objectPath: r.objectPath,
      attempts: r.attempts,
      // Pre-truncated preview keeps the table compact; full text is
      // included separately so the cell can show it on hover/title.
      errorMessage: r.errorMessage,
      errorMessagePreview: r.errorMessage
        ? r.errorMessage.slice(0, FPS_PROBE_FAILURE_ERROR_PREVIEW_CHARS)
        : null,
      completedAt: r.completedAt,
      updatedAt: r.updatedAt,
    }));
    res.json({ failures, failureCount });
  } catch (err) {
    req.log?.error({ err }, "[swing-fps-probe-failures] query failed");
    res.status(500).json({ error: "Failed to load swing fps probe failures" });
  }
});

// POST /admin/swing-fps-probe-failures/:id/reenqueue — clear the failed
// row and re-enqueue a fresh probe for the same swing video. We delete
// the failed row first (rather than mutating it back to 'queued') so the
// retry starts from `attempts=0` with the standard backoff schedule —
// otherwise the row's exhausted attempt counter would cause the worker
// to give up again on the very next failure.
router.post("/admin/swing-fps-probe-failures/:id/reenqueue", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const probeId = Number.parseInt(String((req.params as Record<string, string>).id), 10);
  if (!Number.isFinite(probeId) || probeId <= 0) {
    res.status(400).json({ error: "Invalid probe id" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      // Lock + verify the row is still `failed`. Another admin clicking
      // "Re-enqueue" or "Dismiss" concurrently would otherwise race us
      // and we'd end up with two queued probes (one fresh, one stale).
      const [row] = await tx.select({
        id: swingVideoFpsProbesTable.id,
        swingVideoId: swingVideoFpsProbesTable.swingVideoId,
        objectPath: swingVideoFpsProbesTable.objectPath,
        status: swingVideoFpsProbesTable.status,
      })
        .from(swingVideoFpsProbesTable)
        .where(eq(swingVideoFpsProbesTable.id, probeId))
        .for("update");
      if (!row) return { ok: false as const, status: 404, error: "Probe not found" };
      if (row.status !== "failed") {
        return { ok: false as const, status: 409, error: `Probe is ${row.status}, not failed` };
      }
      await tx.delete(swingVideoFpsProbesTable).where(eq(swingVideoFpsProbesTable.id, probeId));
      await enqueueFpsProbe(row.swingVideoId, row.objectPath, tx);
      return { ok: true as const, swingVideoId: row.swingVideoId };
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    req.log?.info(
      { probeId, swingVideoId: result.swingVideoId, actorId: (req.user as { id?: number } | undefined)?.id },
      "[swing-fps-probe-failures] re-enqueued",
    );
    res.json({ ok: true, swingVideoId: result.swingVideoId });
  } catch (err) {
    req.log?.error({ err, probeId }, "[swing-fps-probe-failures] reenqueue failed");
    res.status(500).json({ error: "Failed to re-enqueue probe" });
  }
});

// POST /admin/swing-fps-probe-failures/:id/dismiss — drop the failed row
// without re-enqueuing. The swing video keeps fps=NULL; admins use this
// when the underlying object is known-bad (e.g. corrupt/deleted) and a
// retry would just fail again. Distinct from re-enqueue so the audit
// log shows the operator's intent.
router.post("/admin/swing-fps-probe-failures/:id/dismiss", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const probeId = Number.parseInt(String((req.params as Record<string, string>).id), 10);
  if (!Number.isFinite(probeId) || probeId <= 0) {
    res.status(400).json({ error: "Invalid probe id" });
    return;
  }
  try {
    const deleted = await db.delete(swingVideoFpsProbesTable)
      .where(and(
        eq(swingVideoFpsProbesTable.id, probeId),
        eq(swingVideoFpsProbesTable.status, "failed"),
      ))
      .returning({ id: swingVideoFpsProbesTable.id, swingVideoId: swingVideoFpsProbesTable.swingVideoId });
    if (deleted.length === 0) {
      // Either it never existed or it's no longer in `failed` state
      // (another admin dismissed/re-enqueued it first). Either way the
      // UI's row is stale; respond 404 so the client refetches.
      res.status(404).json({ error: "Probe not found or no longer failed" });
      return;
    }
    req.log?.info(
      { probeId, swingVideoId: deleted[0]?.swingVideoId, actorId: (req.user as { id?: number } | undefined)?.id },
      "[swing-fps-probe-failures] dismissed",
    );
    res.json({ ok: true });
  } catch (err) {
    req.log?.error({ err, probeId }, "[swing-fps-probe-failures] dismiss failed");
    res.status(500).json({ error: "Failed to dismiss probe" });
  }
});

// GET /admin/wellness-sweep-status — returns the latest wellness sweep result
// (attempted / succeeded / needsReauth + timestamp) so operators can see at a
// glance whether a Whoop / Google Fit credential rotation has invalidated many
// player tokens. Returns `null` until the first sweep has run after startup.
router.get("/admin/wellness-sweep-status", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const last = await getLastWellnessSweepResult();
  res.json({ lastSweep: last });
});

// GET /admin/wellness-sweep-history — returns up to 30 days of recent
// wellness-sweep runs (most recent first) so the admin dashboard can render
// a short trend of attempted / succeeded / needs_reauth counts. Persisted in
// `wellness_sweep_runs` so the history survives a server restart.
router.get("/admin/wellness-sweep-history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const daysRaw = Number(req.query.days);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 90 ? Math.floor(daysRaw) : 30;
  const runs = await getWellnessSweepHistory(days);
  res.json({ days, runs });
});

// GET /admin/wellness-reauth-wow-drift — Task #1324.
// Returns a read-only snapshot of the week-over-week needs_reauth drift
// (rolling 7-day averages of `wellness_sweep_runs.needs_reauth` for the
// recent and prior week, plus the configured threshold) so the admin
// dashboard can show the same drift signal the cron evaluator sends by
// email, without waiting for an alert.
//
// Also surfaces the caller org's per-week rate-limit watermark
// (`organizations.wearable_reauth_wow_alert_last_sent_at`) and the next
// eligible alert time so admins know how stale or imminent the next email is.
router.get("/admin/wellness-reauth-wow-drift", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  if (user?.role !== "org_admin" && user?.role !== "tournament_director" && user?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const snapshot = await getWeeklyReauthDriftSnapshot(user?.organizationId ?? null);
    res.json(snapshot);
  } catch (err) {
    req.log?.error({ err }, "[wellness-reauth-wow-drift] query failed");
    res.status(500).json({ error: "Failed to load week-over-week drift snapshot" });
  }
});

// GET /admin/wellness-reauth-wow-drift-history — Task #1577.
// Returns N consecutive non-overlapping 7-day buckets of average
// `wellness_sweep_runs.needs_reauth`, oldest-first, plus the configured
// alert threshold. Powers a small trend chart underneath the WoW drift tile
// so admins can see whether a spike is a one-off blip or a persistent climb,
// without computing the trend in their head from the per-day sweep history.
//
// Query: `?weeks=N` (clamped to [MIN, MAX]; defaults to DEFAULT). Malformed
// values fall back to the default rather than 4xx-ing — the chart should
// always render something.
router.get("/admin/wellness-reauth-wow-drift-history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = req.user as { role?: string } | undefined;
  if (user?.role !== "org_admin" && user?.role !== "tournament_director" && user?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const weeksRaw = Number(req.query.weeks ?? WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS);
  try {
    const history = await getWeeklyReauthDriftHistory({
      weeks: Number.isFinite(weeksRaw) ? weeksRaw : undefined,
    });
    res.json(history);
  } catch (err) {
    req.log?.error({ err }, "[wellness-reauth-wow-drift-history] query failed");
    res.status(500).json({ error: "Failed to load week-over-week drift history" });
  }
});

// GET /admin/wellness-reauth-wow-drift/history — Task #1969.
//
// Returns the most recent admin acknowledgments / snoozes for the caller's
// org's WoW drift alert, newest-first, capped at 20 by default (50 hard
// max). Powers the expandable "History" disclosure underneath the
// "Acknowledged by …" line on the dashboard tile so admins can do
// postmortems ("did somebody silence this five times in a row?") without
// dropping into the database.
//
// Read-only; gated behind the same role check as the snapshot endpoint
// (org_admin / tournament_director / super_admin). Scoped strictly to the
// caller's organization — even super_admins without an org get a 400, the
// audit trail is per-org by design.
//
// Query: `?limit=N` (clamped to [1, 50]; defaults to 20). Malformed values
// fall back to the default rather than 4xx-ing — the disclosure should
// always render something.
router.get("/admin/wellness-reauth-wow-drift/history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  if (user?.role !== "org_admin" && user?.role !== "tournament_director" && user?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const orgId = user?.organizationId ?? null;
  if (!orgId) {
    res.status(400).json({ error: "No organization is associated with your account." });
    return;
  }
  const limitRaw = Number(req.query.limit ?? WELLNESS_REAUTH_WOW_ACK_HISTORY_DEFAULT_LIMIT);
  try {
    const history = await getWeeklyReauthDriftAcknowledgmentHistory(orgId, {
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    });
    res.json(history);
  } catch (err) {
    req.log?.error({ err, orgId }, "[wellness-reauth-wow-drift] history query failed");
    res.status(500).json({ error: "Failed to load drift acknowledgment history" });
  }
});

// POST /admin/wellness-reauth-wow-drift/acknowledge — Task #1578.
//
// Lets an admin clear / snooze the drift badge from the dashboard tile.
// Bumps `organizations.wearable_reauth_wow_alert_last_sent_at` forward so
// `nextEligibleAt` (= watermark + rate-limit window) lands on
// `now + snoozeDays`. The cron evaluator's atomic conditional UPDATE
// (`IS NULL OR < now − 7d`) then refuses to re-send the email until the
// snooze elapses, regardless of how often the cron tick fires.
//
// Every click also appends a row to `wearable_reauth_wow_acknowledgments`
// with a snapshot of who clicked, the chosen duration and the watermark
// values before/after — so postmortems can reconstruct who silenced the
// alert and when even after the cron stamps the column again.
//
// Body: { snoozeDays: number }   — integer 1..30
//
// Returns the freshly-recomputed snapshot so the dashboard can re-render
// the new `nextEligibleAt` and "Acknowledged by …" line in one round-trip.
router.post("/admin/wellness-reauth-wow-drift/acknowledge", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = req.user as {
    id?: number; role?: string; organizationId?: number | null;
    firstName?: string | null; lastName?: string | null; username?: string | null;
  } | undefined;
  if (user?.role !== "org_admin" && user?.role !== "tournament_director" && user?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const orgId = user?.organizationId ?? null;
  if (!orgId) {
    res.status(400).json({ error: "No organization is associated with your account." });
    return;
  }
  const body = req.body as { snoozeDays?: unknown } | undefined;
  const snoozeRaw = body?.snoozeDays;
  const snoozeDays = typeof snoozeRaw === "number" ? snoozeRaw : Number(snoozeRaw);
  // 1..30 day cap. Snoozing for less than a day is silly (the next cron
  // tick is likely within an hour) and 30 days is the longest a human
  // operator should be muting an automated drift signal — anything beyond
  // that should be a config change to the threshold itself.
  if (!Number.isInteger(snoozeDays) || snoozeDays < 1 || snoozeDays > 30) {
    res.status(400).json({ error: "snoozeDays must be an integer between 1 and 30" });
    return;
  }
  try {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;

    // Task #1970 — runaway-snooze cap. Without this, the same admin can
    // click "snooze for 30 days" every single day and silence a
    // legitimate drift forever (the audit table makes the abuse
    // visible after the fact, but the dashboard never *prevented* it).
    // Count this org's Acknowledge clicks in the trailing 30 days
    // *before* writing the new audit row so the cap is "K already
    // landed", not "K including this click", which keeps the count
    // shown to admins on the banner consistent with what got saved.
    const snoozeWindowStart = new Date(
      now.getTime() - WELLNESS_REAUTH_WOW_SNOOZE_COUNT_WINDOW_DAYS * day,
    );
    const maxSnoozesPer30d = getMaxSnoozesPer30d();
    const [snoozeCountRow] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(wearableReauthWowAcknowledgmentsTable)
      .where(and(
        eq(wearableReauthWowAcknowledgmentsTable.organizationId, orgId),
        gte(wearableReauthWowAcknowledgmentsTable.createdAt, snoozeWindowStart),
      ));
    const snoozeCountLast30d = Number(snoozeCountRow?.value ?? 0) || 0;
    if (snoozeCountLast30d >= maxSnoozesPer30d) {
      // 429 Too Many Requests is the closest semantic match — the click is
      // syntactically valid but the org has burned through its 30-day
      // budget, so a super_admin should investigate the underlying drift
      // instead of snoozing it again.
      req.log?.warn({
        orgId,
        actorUserId: user.id ?? null,
        actorRole: user.role ?? null,
        snoozeCountLast30d,
        maxSnoozesPer30d,
      }, "[wellness-reauth-wow-drift] runaway-snooze cap reached; refusing acknowledge");
      res.status(429).json({
        error:
          `This drift alert has been snoozed ${snoozeCountLast30d} times in the last 30 days ` +
          `(cap is ${maxSnoozesPer30d}). Please investigate the underlying drift instead of ` +
          `snoozing again, or ask a super_admin to intervene.`,
        snoozeCountLast30d,
        maxSnoozesPer30d,
      });
      return;
    }

    // The cron evaluator considers an org eligible when the watermark is
    // null OR strictly before `now - 7d`. Setting the watermark to
    // `now + (snoozeDays - 7)*day` makes `nextEligibleAt` (= watermark +
    // 7d) land on exactly `now + snoozeDays`, which matches the snooze
    // semantics shown in the UI.
    const newWatermark = new Date(now.getTime() + (snoozeDays - 7) * day);

    // Capture the previous watermark so the audit row can reconstruct the
    // pre-click state. `returning()` gives us the post-update value too,
    // but we want the *previous* value, hence the read-then-update.
    const [orgBefore] = await db
      .select({ lastSentAt: organizationsTable.wearableReauthWowAlertLastSentAt })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    if (!orgBefore) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    const displayName = ((user.firstName ?? "") + " " + (user.lastName ?? "")).trim()
      || user.username
      || null;

    await db.transaction(async (tx) => {
      await tx.update(organizationsTable)
        .set({ wearableReauthWowAlertLastSentAt: newWatermark, updatedAt: now })
        .where(eq(organizationsTable.id, orgId));
      await tx.insert(wearableReauthWowAcknowledgmentsTable).values({
        organizationId: orgId,
        acknowledgedByUserId: user.id ?? null,
        acknowledgedByName: displayName,
        acknowledgedByRole: user.role ?? null,
        snoozeDays,
        prevWatermark: orgBefore.lastSentAt ?? null,
        newWatermark,
      });
    });

    req.log?.info({
      orgId,
      actorUserId: user.id ?? null,
      actorRole: user.role ?? null,
      snoozeDays,
      prevWatermark: orgBefore.lastSentAt?.toISOString() ?? null,
      newWatermark: newWatermark.toISOString(),
    }, "[wellness-reauth-wow-drift] admin acknowledged drift alert");

    const snapshot = await getWeeklyReauthDriftSnapshot(orgId);
    res.json(snapshot);
  } catch (err) {
    req.log?.error({ err, orgId }, "[wellness-reauth-wow-drift] acknowledge failed");
    res.status(500).json({ error: "Failed to acknowledge drift alert" });
  }
});

// Task #850 — Per-org thresholds + alert email recipient for the wellness
// sweep needs_reauth alert. Larger clubs may want a higher absolute floor;
// smaller clubs may want to be alerted on any flip. Surfaced through the
// admin settings UI. Only org_admin / super_admin can read or write — the
// settings change who receives ops alerts so they're an admin concern, not
// a tournament-director concern.
router.get("/admin/wearable-reauth-alert-settings", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  if (user?.role !== "org_admin" && user?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const orgId = user?.organizationId ?? null;
  // Resolve the system-wide WoW drift threshold default — env > hardcoded.
  // Same logic as `evaluateWeeklyReauthDrift` so the UI reflects what the
  // evaluator would actually use as a fallback when an org has not picked
  // its own override.
  const wowMinDeltaDefault = (() => {
    const raw = process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA;
    if (!raw) return WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA;
  })();
  const defaults = {
    minCount: WELLNESS_REAUTH_ALERT_DEFAULT_MIN_COUNT,
    minSharePct: WELLNESS_REAUTH_ALERT_DEFAULT_MIN_SHARE_PCT,
    minAttempted: WELLNESS_REAUTH_ALERT_DEFAULT_MIN_ATTEMPTED,
    wowMinDelta: wowMinDeltaDefault,
    fallbackEmail: process.env.WELLNESS_REAUTH_ALERT_EMAIL ?? null,
  };
  if (!orgId) {
    res.json({
      orgId: null,
      settings: {
        minCount: defaults.minCount,
        minSharePct: defaults.minSharePct,
        minAttempted: defaults.minAttempted,
        wowMinDelta: defaults.wowMinDelta,
        email: null,
      },
      defaults,
    });
    return;
  }
  const [org] = await db.select({
    minCount: organizationsTable.wearableReauthAlertMinCount,
    minSharePct: organizationsTable.wearableReauthAlertMinSharePct,
    minAttempted: organizationsTable.wearableReauthAlertMinAttempted,
    wowMinDelta: organizationsTable.wearableReauthWowAlertMinDelta,
    email: organizationsTable.wearableReauthAlertEmail,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  // numeric() columns come back as strings — surface the explicit override
  // as a number so the UI doesn't have to repeat the parse, and as `null`
  // when the org is inheriting the system-wide default. The resolved
  // effective value (override OR inherited default) is also returned so
  // simple UIs can render a single number without re-implementing fallback.
  const wowMinDeltaOverride = (() => {
    const raw = org.wowMinDelta;
    if (raw == null || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  res.json({
    orgId,
    settings: {
      minCount: org.minCount,
      minSharePct: org.minSharePct,
      minAttempted: org.minAttempted,
      // null = inheriting the system-wide default exposed under `defaults`.
      wowMinDelta: wowMinDeltaOverride,
      wowMinDeltaEffective: wowMinDeltaOverride ?? defaults.wowMinDelta,
      email: org.email ?? null,
    },
    defaults,
  });
});

router.put("/admin/wearable-reauth-alert-settings", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  if (user?.role !== "org_admin" && user?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const orgId = user?.organizationId ?? null;
  if (!orgId) {
    res.status(400).json({ error: "No organization is associated with your account." });
    return;
  }

  const body = req.body as {
    minCount?: unknown; minSharePct?: unknown; minAttempted?: unknown;
    wowMinDelta?: unknown; email?: unknown;
  };

  const parseInt0 = (v: unknown, lo: number, hi: number, label: string):
    { ok: true; value: number } | { ok: false; error: string } => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      return { ok: false, error: `${label} must be an integer between ${lo} and ${hi}` };
    }
    return { ok: true, value: n };
  };

  const minCount = parseInt0(body.minCount, 1, 1000, "minCount");
  if (!minCount.ok) { { res.status(400).json({ error: minCount.error }); return; } }
  const minSharePct = parseInt0(body.minSharePct, 1, 100, "minSharePct");
  if (!minSharePct.ok) { { res.status(400).json({ error: minSharePct.error }); return; } }
  const minAttempted = parseInt0(body.minAttempted, 1, 1000, "minAttempted");
  if (!minAttempted.ok) { { res.status(400).json({ error: minAttempted.error }); return; } }

  // Task #1325 — Per-org override for the weekly WoW drift threshold.
  // Accepts a positive number (with up to 2 decimal places) between 0.01
  // and 9999.99 to match the column's `numeric(6, 2)` precision/scale.
  // Three semantics:
  //   - field absent  → leave existing value untouched (back-compat).
  //   - field == null → CLEAR the override; the org re-inherits the
  //                     system-wide default (`WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA`).
  //   - field is num  → set the explicit per-org override.
  // Sentinel: `WOW_MIN_DELTA_UNSET` distinguishes "no change" from "set to NULL"
  // since `undefined` would conflict with the optional-property pattern below.
  const WOW_MIN_DELTA_UNSET = Symbol("unset");
  let wowMinDeltaUpdate: string | null | typeof WOW_MIN_DELTA_UNSET = WOW_MIN_DELTA_UNSET;
  if (body.wowMinDelta === null) {
    wowMinDeltaUpdate = null;
  } else if (body.wowMinDelta !== undefined) {
    const n = typeof body.wowMinDelta === "number" ? body.wowMinDelta : Number(body.wowMinDelta);
    if (!Number.isFinite(n) || n <= 0 || n > 9999.99) {
      res.status(400).json({ error: "wowMinDelta must be a positive number ≤ 9999.99, or null to inherit the default" });
      return;
    }
    // Round to 2 decimals (matches the column's scale) and reject silently
    // truncated values that would round to zero (already covered by `n <= 0`).
    const rounded = Math.round(n * 100) / 100;
    if (rounded <= 0) {
      res.status(400).json({ error: "wowMinDelta must be > 0 after rounding to 2 decimals" });
      return;
    }
    wowMinDeltaUpdate = rounded.toFixed(2);
  }

  let email: string | null = null;
  if (body.email !== undefined && body.email !== null) {
    if (typeof body.email !== "string") {
      res.status(400).json({ error: "email must be a string or null" });
      return;
    }
    const trimmed = body.email.trim();
    if (trimmed === "") {
      email = null;
    } else {
      // Lightweight email validation — same shape used elsewhere in the codebase.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        res.status(400).json({ error: "email is not a valid address" });
        return;
      }
      email = trimmed;
    }
  }

  const updateSet: Record<string, unknown> = {
    wearableReauthAlertMinCount: minCount.value,
    wearableReauthAlertMinSharePct: minSharePct.value,
    wearableReauthAlertMinAttempted: minAttempted.value,
    wearableReauthAlertEmail: email,
    updatedAt: new Date(),
  };
  // Only touch the WoW override column when the request explicitly sent
  // the field — sentinel value preserves the absent-vs-null distinction.
  if (wowMinDeltaUpdate !== WOW_MIN_DELTA_UNSET) {
    updateSet.wearableReauthWowAlertMinDelta = wowMinDeltaUpdate;
  }

  const [updated] = await db.update(organizationsTable).set(updateSet)
    .where(eq(organizationsTable.id, orgId)).returning({
      minCount: organizationsTable.wearableReauthAlertMinCount,
      minSharePct: organizationsTable.wearableReauthAlertMinSharePct,
      minAttempted: organizationsTable.wearableReauthAlertMinAttempted,
      wowMinDelta: organizationsTable.wearableReauthWowAlertMinDelta,
      email: organizationsTable.wearableReauthAlertEmail,
    });
  if (!updated) { { res.status(404).json({ error: "Organization not found" }); return; } }
  // Recompute the env-derived inherited default so the response can echo
  // the resolved effective value the same way GET does.
  const wowMinDeltaInherited = (() => {
    const raw = process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA;
    if (!raw) return WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA;
  })();
  const wowMinDeltaOverride = (() => {
    const raw = updated.wowMinDelta;
    if (raw == null || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  res.json({
    orgId,
    settings: {
      minCount: updated.minCount,
      minSharePct: updated.minSharePct,
      minAttempted: updated.minAttempted,
      // null = inheriting the system-wide default.
      wowMinDelta: wowMinDeltaOverride,
      wowMinDeltaEffective: wowMinDeltaOverride ?? wowMinDeltaInherited,
      email: updated.email ?? null,
    },
  });
});

// Task #1005 — Notification template preview endpoints. Lets an admin
// see exactly what title/body/HTML the dispatcher will render for any
// registered key, without firing a real send.
router.get("/admin/notification-templates", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  // Task #1632 — surface each key's category, human description, default
  // dispatch channels, and auditRequired flag so the admin "Notification
  // template registry" panel can show what each key actually does instead
  // of just the bare key string. `keys` is kept as the response field for
  // backwards compatibility with the existing client query shape; entries
  // are now objects rather than plain strings.
  const entries = await listRegisteredDetails();
  res.json({ keys: entries });
});

router.get("/admin/notification-templates/:key/preview", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  // Task #1648 — optional `?lang=` re-renders branded templates in the
  // requested language so admins can preview translations before they
  // reach players. Unsupported / missing values fall back to English
  // inside `previewNotificationTemplate`.
  const langRaw = req.query.lang;
  const lang = typeof langRaw === "string" && langRaw.length > 0 ? langRaw : undefined;
  const preview = await previewNotificationTemplate(String((req.params as Record<string, string>).key), lang);
  if (!preview) { { res.status(404).json({ error: "unknown notification key" }); return; } }
  res.json(preview);
});

// Task #2023 — "Send test to me" companion to the preview endpoint.
//
// After previewing the canned title/body/HTML for a notification key,
// admins want a one-click way to actually fire that template at
// themselves to verify the live channel (email inbox, push device,
// SMS) works end-to-end. Without this they have to go trigger the
// real workflow that produces the notification, which often isn't
// possible on demand.
//
// Behaviour:
//   • Renders the template via `previewNotificationTemplate` (so the
//     calling admin sees exactly what they previewed in the dialog).
//   • Dispatches per-channel directly to the calling admin only —
//     never to anyone else — using the registry's `defaultChannels`.
//     We bypass `dispatchNotification` deliberately so user prefs and
//     digest mode don't suppress a test send (the whole point of the
//     test is to verify the live channel works).
//   • Writes one `notification_audit_log` row per attempted channel
//     with `reason: "admin-test"` so test sends are clearly tagged
//     and analytics queries can exclude them from real-delivery
//     dashboards.
//
// Gated to org_admin / super_admin (intentionally narrower than the
// preview endpoint, which also allows tournament_director — sending
// real mail/push to your own inbox is a heavier action).
router.post("/admin/notification-templates/:key/send-test", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const u = req.user as { id?: number; role?: string } | undefined;
  if (!u || (u.role !== "org_admin" && u.role !== "super_admin")) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  if (typeof u.id !== "number") {
    res.status(400).json({ error: "missing-admin-id" }); return;
  }
  const key = String((req.params as Record<string, string>).key);
  const langRaw = req.query.lang;
  const lang = typeof langRaw === "string" && langRaw.length > 0 ? langRaw : undefined;
  const preview = await previewNotificationTemplate(key, lang);
  if (!preview) {
    res.status(404).json({ error: "unknown notification key" }); return;
  }

  // Look up the calling admin's email + display name so the email
  // channel can address them. We never read any other user's contact
  // info here — the test send is strictly self-targeted.
  const [adminRow] = await db
    .select({
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, u.id))
    .limit(1);

  const results: { channel: string; status: "sent" | "failed" | "skipped"; reason?: string }[] = [];
  for (const ch of preview.defaultChannels) {
    if (ch === "email") {
      if (!adminRow?.email) {
        results.push({ channel: "email", status: "skipped", reason: "no_email_on_file" });
        continue;
      }
      try {
        // Branded templates already include the full club-branded
        // shell (header/footer/notification key); preview.branded
        // tells us whether to skip the generic envelope so we don't
        // double-render. This mirrors `dispatchNotification`'s own
        // `preRendered` flag.
        await sendNotificationEmail({
          to: adminRow.email,
          name: adminRow.displayName ?? null,
          subject: preview.sample.title,
          html: preview.sample.html,
          text: preview.sample.body,
          notificationKey: key,
          preRendered: preview.branded,
        });
        results.push({ channel: "email", status: "sent" });
      } catch (err) {
        req.log?.warn({ err, key }, "[admin-test] email send failed");
        results.push({ channel: "email", status: "failed", reason: "email_send_failed" });
      }
    } else if (ch === "push") {
      try {
        const r = await sendPushToUsers([u.id], preview.sample.title, preview.sample.body);
        const status = classifyPushDelivery(r);
        if (status === "sent") {
          results.push({ channel: "push", status: "sent" });
        } else if (status === "no_address") {
          results.push({
            channel: "push",
            status: "skipped",
            reason: r.invalid > 0 ? "no_valid_device_token" : "no_device_token",
          });
        } else {
          results.push({ channel: "push", status: "failed", reason: "push_provider_failed" });
        }
      } catch (err) {
        req.log?.warn({ err, key }, "[admin-test] push send threw");
        results.push({ channel: "push", status: "failed", reason: "push_threw" });
      }
    } else {
      // sms / whatsapp / inapp / digest — not wired into the admin
      // test path. Surfaced as a "skipped" entry so the dialog can
      // tell the admin which channels actually delivered vs which
      // weren't attempted, instead of pretending success.
      results.push({ channel: ch, status: "skipped", reason: "channel_not_supported_in_test" });
    }
  }

  // Audit trail — one row per attempted channel, tagged
  // `reason: "admin-test"` so analytics queries can exclude these
  // from real-delivery dashboards. Forced for every key (even
  // those whose spec sets `auditRequired = false`) so the audit feed
  // can prove a test fired and what its outcome was.
  for (const r of results) {
    try {
      await db.insert(notificationAuditLogTable).values({
        notificationKey: key,
        userId: u.id,
        channel: r.channel,
        status: r.status,
        reason: "admin-test",
        payload: {
          adminTest: true,
          lang: preview.lang,
          channelStatus: r.status,
          channelReason: r.reason ?? null,
        },
      });
    } catch (err) {
      req.log?.warn({ err, key }, "[admin-test] audit insert failed");
    }
  }

  res.json({ ok: true, key, lang: preview.lang, channels: results });
});

// Task #1172 — Notification audit feed.
//
// Surfaces rows from `notification_audit_log` (Task #1005) so admins can
// browse the live audit trail of every dispatch the system ran for a key
// flagged with `auditRequired = true`. Org admins see only rows whose
// recipient lives in their org; super admins see everything (including
// rows with no recipient — e.g. broadcast/admin alerts).
//
// Query params (all optional):
//   key       — exact notification key (e.g. "handicap.committee.changed")
//   userId    — recipient app-user id
//   userQuery — free-text match against username / displayName / email
//   channel   — "email" | "push" | "sms" | "whatsapp" | "inapp" | "digest"
//   status    — "sent" | "failed" | "skipped" | "queued" | ...
//   since     — ISO-8601 lower bound (inclusive) on createdAt
//   until     — ISO-8601 upper bound (inclusive) on createdAt
//   page      — 1-indexed (default 1)
//   limit     — 1..200 (default 50)

// Strict integer parser: rejects partial parses like "123abc".
function parseStrictInt(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Result of parsing & authorizing a notification-audit request. Either:
//   • response was already sent (auth/validation error) — caller stops.
//   • the caller's scope is provably empty — caller short-circuits with
//     an empty payload. This is the org-admin-without-org case and the
//     org-with-no-users case.
//   • ok — caller has WHERE clauses ready to compose into queries.
type AuditQueryParse =
  | { kind: "sent" }
  | { kind: "empty"; pageNum: number; limitNum: number }
  | {
      kind: "ok";
      pageNum: number;
      limitNum: number;
      whereClause: SQL | undefined;
      scopeWhere: SQL | undefined;
    };

// Task #1172 + Task #1360 — shared filter parsing for the JSON list and
// CSV export endpoints. Centralizing this guarantees the CSV export
// applies the exact same role-based scope and user-supplied filters as
// the on-screen list, so a downloaded report can never include rows the
// admin isn't allowed to see in the UI.
async function parseNotificationAuditQuery(
  req: Request,
  res: Response,
): Promise<AuditQueryParse> {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return { kind: "sent" };
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return { kind: "sent" };
  }

  // Express's req.query values can be `string | string[] | ParsedQs |
  // ParsedQs[]` if a client sends repeated params or nested objects (e.g.
  // `?key=a&key=b`). Calling `.trim()` directly on that would 500. Normalize
  // every accepted param to a flat `string | undefined` and reject anything
  // weirder with a 400 instead of crashing later.
  const rawQuery = req.query as Record<string, unknown>;
  const paramNames = [
    "page", "limit", "key", "channel", "status", "userId", "userQuery", "since", "until",
  ] as const;
  const q: Record<string, string | undefined> = {};
  for (const name of paramNames) {
    const v = rawQuery[name];
    if (v === undefined || v === null) { q[name] = undefined; continue; }
    if (typeof v === "string") { q[name] = v; continue; }
    res.status(400).json({ error: `${name} must be a single value` });
    return { kind: "sent" };
  }

  const pageRaw = (q.page ?? "1").trim();
  const limitRaw = (q.limit ?? "50").trim();
  const pageParsed = parseStrictInt(pageRaw);
  const limitParsed = parseStrictInt(limitRaw);
  if (pageParsed === null || limitParsed === null) {
    res.status(400).json({ error: "page and limit must be integers" });
    return { kind: "sent" };
  }
  const pageNum = Math.max(1, pageParsed);
  const limitNum = Math.min(200, Math.max(1, limitParsed));

  // We split conditions into:
  //   • scopeConds  — role-based authorization boundary (always applied).
  //                   Used by BOTH the entries query AND the facet queries
  //                   so org admins never see keys / channels / statuses
  //                   that only exist outside their tenant.
  //   • filterConds — user-selected filters from the UI. Applied to the
  //                   entries / total queries only; facets stay broad
  //                   within the caller's scope so the dropdowns remain
  //                   stable across selections.
  const scopeConds: SQL[] = [];
  const filterConds: SQL[] = [];

  // --- scope: org-admin tenant boundary -------------------------------
  // Rows with userId IS NULL (admin/broadcast alerts) are NOT shown to
  // org admins — they aren't tied to a specific org and could leak
  // signal about other clubs' activity. Super admins see everything.
  if (role === "org_admin") {
    const orgId = user?.organizationId;
    if (!orgId) {
      // An org_admin without an org is misconfigured; respond empty
      // rather than 500 so the UI degrades gracefully.
      return { kind: "empty", pageNum, limitNum };
    }
    const orgUserIds = await db
      .select({ id: appUsersTable.id })
      .from(appUsersTable)
      .where(eq(appUsersTable.organizationId, orgId));
    const ids = orgUserIds.map(r => r.id);
    if (ids.length === 0) {
      return { kind: "empty", pageNum, limitNum };
    }
    scopeConds.push(inArray(notificationAuditLogTable.userId, ids));
  }

  // --- filters: user-selected from the UI -----------------------------
  if (q.key && q.key.trim() !== "") {
    filterConds.push(eq(notificationAuditLogTable.notificationKey, q.key.trim()));
  }
  if (q.channel && q.channel.trim() !== "") {
    filterConds.push(eq(notificationAuditLogTable.channel, q.channel.trim()));
  }
  if (q.status && q.status.trim() !== "") {
    filterConds.push(eq(notificationAuditLogTable.status, q.status.trim()));
  }
  if (q.userId && q.userId.trim() !== "") {
    const uid = parseStrictInt(q.userId.trim());
    if (uid === null) {
      res.status(400).json({ error: "userId must be an integer" });
      return { kind: "sent" };
    }
    filterConds.push(eq(notificationAuditLogTable.userId, uid));
  }
  if (q.since && q.since.trim() !== "") {
    const d = new Date(q.since);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "since must be an ISO-8601 timestamp" });
      return { kind: "sent" };
    }
    filterConds.push(gte(notificationAuditLogTable.createdAt, d));
  }
  if (q.until && q.until.trim() !== "") {
    const d = new Date(q.until);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "until must be an ISO-8601 timestamp" });
      return { kind: "sent" };
    }
    filterConds.push(lte(notificationAuditLogTable.createdAt, d));
  }

  // Apply userQuery (free-text) by pre-resolving recipient ids and
  // pushing an inArray() filter. We deliberately resolve against the
  // *whole* appUsers table — the audit row's authorization boundary is
  // already enforced by scopeConds above; this is a recipient lookup.
  if (q.userQuery && q.userQuery.trim() !== "") {
    const term = `%${q.userQuery.trim()}%`;
    const matched = await db
      .select({ id: appUsersTable.id })
      .from(appUsersTable)
      .where(or(
        ilike(appUsersTable.username, term),
        ilike(appUsersTable.displayName, term),
        ilike(appUsersTable.email, term),
      ));
    const ids = matched.map(r => r.id);
    if (ids.length === 0) {
      // No recipients matched — push an unsatisfiable predicate so the
      // entries / total queries return empty, but facets still reflect
      // the caller's scoped catalogue.
      filterConds.push(sql`FALSE`);
    } else {
      filterConds.push(inArray(notificationAuditLogTable.userId, ids));
    }
  }

  const scopeWhere = scopeConds.length > 0 ? and(...scopeConds) : undefined;
  const allConds = [...scopeConds, ...filterConds];
  const whereClause = allConds.length > 0 ? and(...allConds) : undefined;

  return { kind: "ok", pageNum, limitNum, whereClause, scopeWhere };
}

router.get("/admin/notification-audit", async (req: Request, res: Response) => {
  const parsed = await parseNotificationAuditQuery(req, res);
  if (parsed.kind === "sent") return;
  if (parsed.kind === "empty") {
    res.json({
      entries: [], total: 0, page: parsed.pageNum, limit: parsed.limitNum,
      facets: { keys: [], channels: [], statuses: [] },
      // Task #2007 — Empty scope means no rows ever match, so the CSV is
      // header-only. Surface a stable hint anyway so the client never
      // has to special-case "no estimate available".
      csvEstimate: { avgRowBytes: null, headerBytes: AUDIT_CSV_HEADER_BYTES },
    });
    return;
  }
  const { pageNum, limitNum, whereClause, scopeWhere } = parsed;
  const offset = (pageNum - 1) * limitNum;

  const baseQuery = db
    .select({
      id: notificationAuditLogTable.id,
      notificationKey: notificationAuditLogTable.notificationKey,
      userId: notificationAuditLogTable.userId,
      channel: notificationAuditLogTable.channel,
      status: notificationAuditLogTable.status,
      reason: notificationAuditLogTable.reason,
      payload: notificationAuditLogTable.payload,
      createdAt: notificationAuditLogTable.createdAt,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
    })
    .from(notificationAuditLogTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, notificationAuditLogTable.userId));

  const rows = await (whereClause ? baseQuery.where(whereClause) : baseQuery)
    .orderBy(desc(notificationAuditLogTable.createdAt), desc(notificationAuditLogTable.id))
    .limit(limitNum)
    .offset(offset);

  const totalQuery = db.select({ count: count() }).from(notificationAuditLogTable);
  const [totalRow] = await (whereClause ? totalQuery.where(whereClause) : totalQuery);

  const entries = rows.map(r => ({
    id: r.id,
    notificationKey: r.notificationKey,
    userId: r.userId,
    userDisplayName: r.displayName ?? null,
    username: r.username ?? null,
    userEmail: r.email ?? null,
    channel: r.channel,
    status: r.status,
    reason: r.reason,
    payload: r.payload,
    createdAt: r.createdAt,
  }));

  // Task #2007 — Compute an avg-bytes-per-row hint for the CSV export
  // straight from the page of rows we just fetched. The streaming CSV
  // endpoint uses the exact same per-row encoding, so the average over
  // a 50-row page is a reliable proxy for the full export's per-row
  // size — payload shapes for a given filter set don't tend to vary
  // wildly. The client multiplies this by `total` (and adds
  // `headerBytes`) to show admins an estimated download size before
  // they commit to the download.
  const avgRowBytes = rows.length > 0
    ? Math.round(
        rows.reduce((sum, r) => sum + auditCsvRowByteLength(r), 0) / rows.length,
      )
    : null;

  // Distinct facets to power the filter dropdowns — scoped by the same
  // tenant boundary the entries query uses, so org admins never see
  // notification keys / channels / statuses that exist only outside
  // their org. We deliberately do NOT apply the user-selected filters
  // so the dropdowns remain stable across selections.
  const keyQuery = db.selectDistinct({ key: notificationAuditLogTable.notificationKey })
    .from(notificationAuditLogTable);
  const channelQuery = db.selectDistinct({ channel: notificationAuditLogTable.channel })
    .from(notificationAuditLogTable);
  const statusQuery = db.selectDistinct({ status: notificationAuditLogTable.status })
    .from(notificationAuditLogTable);

  const [keyRows, channelRows, statusRows] = await Promise.all([
    scopeWhere ? keyQuery.where(scopeWhere) : keyQuery,
    scopeWhere ? channelQuery.where(scopeWhere) : channelQuery,
    scopeWhere ? statusQuery.where(scopeWhere) : statusQuery,
  ]);

  res.json({
    entries,
    total: Number(totalRow?.count ?? 0),
    page: pageNum,
    limit: limitNum,
    facets: {
      keys: keyRows.map(r => r.key).sort(),
      channels: channelRows.map(r => r.channel).sort(),
      statuses: statusRows.map(r => r.status).sort(),
    },
    // Task #2007 — Size-estimate hint for the CSV export button. The
    // client multiplies `avgRowBytes` by `total` and adds `headerBytes`
    // to render an "~X MB" affordance next to the row count, so admins
    // can decide whether to start the download without finding out
    // post-hoc that it's 50 MB. `avgRowBytes` is null when the current
    // page returned no rows (filtered to nothing) — the client treats
    // that as "no estimate to show".
    csvEstimate: { avgRowBytes, headerBytes: AUDIT_CSV_HEADER_BYTES },
  });
});

// Task #1360 — CSV export of the notification audit feed.
//
// Sibling of GET /admin/notification-audit. Reuses the same role gate and
// filter parsing so a downloaded report contains exactly the rows the
// admin would see in the UI under the same filter selections — never any
// row outside their tenant boundary.
//
// Differences from the JSON endpoint:
//   • No pagination — exports every matching row (compliance reviews and
//     finance audits need the full filtered set, not just the visible
//     page). page / limit query params are accepted but ignored to keep
//     the URL contract identical.
//   • No facet queries (the dropdowns are a UI concern).
//   • Response is text/csv with a Content-Disposition attachment header
//     so the browser triggers a save dialog instead of navigating.
//   • Empty scopes (org_admin without an org / org with no users) still
//     produce a valid CSV containing just the header row, so downstream
//     tooling that expects a file always gets one.

// RFC 4180 CSV escaping. Quotes a field if it contains a comma, quote,
// CR, or LF, and doubles any embedded quote characters.
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields: unknown[]): string {
  return fields.map(csvEscape).join(",") + "\r\n";
}

const AUDIT_CSV_HEADER = csvRow([
  "timestamp",
  "notification_key",
  "recipient_username",
  "recipient_email",
  "channel",
  "status",
  "reason",
  "payload",
]);

// Byte length of the fixed CSV header line. Pre-computed so the JSON list
// endpoint can return it as part of the size-estimate hint without
// re-encoding the header on every request.
const AUDIT_CSV_HEADER_BYTES = Buffer.byteLength(AUDIT_CSV_HEADER, "utf8");

// Task #2007 — Estimate the on-the-wire byte length of a single CSV row
// for the audit export, given the same projected fields the JSON list
// endpoint returns. We format the row using the exact same encoding the
// streaming CSV endpoint uses (csvEscape + JSON.stringify of the
// payload) so the estimate matches the actual download to within
// rounding error of the average across the sampled page.
function auditCsvRowByteLength(r: {
  createdAt: Date | string;
  notificationKey: string;
  username: string | null;
  email: string | null;
  channel: string;
  status: string;
  reason: string | null;
  payload: Record<string, unknown> | null;
}): number {
  const line = csvRow([
    r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    r.notificationKey,
    r.username ?? "",
    r.email ?? "",
    r.channel,
    r.status,
    r.reason ?? "",
    JSON.stringify(r.payload ?? {}),
  ]);
  return Buffer.byteLength(line, "utf8");
}

// Set the headers that mark the response as a CSV download. Called
// before the first body byte so streaming responses get a sensible
// filename and never end up cached by an intermediary.
function setAuditCsvHeaders(res: Response): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="notification-audit-${stamp}.csv"`,
  );
  // Audit data is sensitive — never let an intermediary cache it.
  res.setHeader("Cache-Control", "no-store");
  res.status(200);
}

// Sends a header-only CSV (no data rows). Used for the empty-scope
// short-circuit so misconfigured admins still get a valid file.
function sendEmptyAuditCsv(res: Response): void {
  setAuditCsvHeaders(res);
  res.send(AUDIT_CSV_HEADER);
}

// Shape of a single joined audit row coming back from the streaming
// cursor. Drizzle's `.select({...})` projection emits the underlying
// column names without aliases (e.g. `"notification_audit_log"."notification_key"`),
// so when we run the raw SQL through pg the row keys are snake_case
// — drizzle's normal camelCase result mapping is bypassed here.
type AuditCsvRow = {
  id: number;
  notification_key: string;
  user_id: number | null;
  channel: string;
  status: string;
  reason: string | null;
  payload: Record<string, unknown> | null;
  created_at: Date | string;
  username: string | null;
  email: string | null;
};

function formatAuditCsvRow(r: AuditCsvRow): string {
  // Flatten the payload to a single JSON string column. Empty / null
  // payloads serialize as `{}` so the column is never blank for a
  // present row, which makes the CSV easier to consume in Excel.
  const payloadStr = JSON.stringify(r.payload ?? {});
  return csvRow([
    r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    r.notification_key,
    r.username ?? "",
    r.email ?? "",
    r.channel,
    r.status,
    r.reason ?? "",
    payloadStr,
  ]);
}

// How many rows to FETCH from the server-side cursor at a time. Big
// enough to keep round-trip overhead negligible on large exports;
// small enough that peak memory stays bounded (a few hundred KB)
// regardless of how many rows match the filters.
const AUDIT_CSV_CURSOR_BATCH = 500;

// Stream the matching audit rows row-by-row to `res` using a Postgres
// server-side cursor. Memory stays bounded to one batch (~500 rows) at
// a time, so a year of dispatch history doesn't spike the API process.
// The first byte (the CSV header) is flushed before the query runs so
// the browser's download dialog appears immediately.
async function streamAuditCsv(
  req: Request,
  res: Response,
  whereClause: SQL | undefined,
): Promise<void> {
  const baseQuery = db
    .select({
      id: notificationAuditLogTable.id,
      notificationKey: notificationAuditLogTable.notificationKey,
      userId: notificationAuditLogTable.userId,
      channel: notificationAuditLogTable.channel,
      status: notificationAuditLogTable.status,
      reason: notificationAuditLogTable.reason,
      payload: notificationAuditLogTable.payload,
      createdAt: notificationAuditLogTable.createdAt,
      username: appUsersTable.username,
      email: appUsersTable.email,
    })
    .from(notificationAuditLogTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, notificationAuditLogTable.userId));

  const finalQuery = whereClause ? baseQuery.where(whereClause) : baseQuery;
  const ordered = finalQuery.orderBy(
    desc(notificationAuditLogTable.createdAt),
    desc(notificationAuditLogTable.id),
  );
  const { sql: rawSql, params } = ordered.toSQL();

  // Flush the headers + header row before opening the cursor so the
  // download dialog appears within milliseconds even if the matched
  // rowset is huge. Express picks chunked transfer-encoding
  // automatically because we never set Content-Length.
  setAuditCsvHeaders(res);
  res.write(AUDIT_CSV_HEADER);

  // Detect a client disconnect (browser cancel, proxy timeout) so we
  // can stop fetching mid-export instead of pulling every remaining
  // row from disk just to throw it away.
  //
  // Task #2016 — Setting `aborted = true` alone isn't enough: the
  // currently-in-flight `client.query("FETCH …")` still has to wait
  // for Postgres to return the next batch before the loop can check
  // the flag and break. For very large exports on slow links that
  // can pin a pool connection for several extra seconds after the
  // admin's tab is already closed. To release the connection
  // promptly we *also* fire a fire-and-forget
  // `pg_cancel_backend(pid)` against a separate session, which
  // interrupts the running FETCH server-side and causes the in-flight
  // query to reject with a `query_canceled` (SQLSTATE 57014) error.
  // We swallow that specific error path below as a clean abort.
  let aborted = false;
  let cancelledByUs = false;
  // The PID for cancellation is only known once we've acquired a
  // pool client. If the admin aborts before then, we still set
  // `aborted` so the post-acquire path bails out without doing any
  // FETCH work — there's no statement in flight to cancel yet.
  let pidForCancel: number | null = null;
  const onClose = () => {
    if (aborted) return;
    aborted = true;
    if (pidForCancel != null) {
      cancelledByUs = true;
      // Don't await — the response is already gone, so there's
      // nothing to send back. Logging the failure is enough.
      dbCancellation.cancelBackend(pidForCancel).catch((err: unknown) => {
        req.log?.warn(
          { err, pid: pidForCancel },
          "[notification-audit-csv] pg_cancel_backend failed; falling back to natural FETCH-boundary abort",
        );
      });
    }
  };
  res.on("close", onClose);

  const client = await pool.connect();
  const cursorClient = client as unknown as { processID?: number | null };
  if (typeof cursorClient.processID === "number" && cursorClient.processID > 0) {
    pidForCancel = cursorClient.processID;
  }

  let cursorOpen = false;
  let inTransaction = false;
  try {
    await client.query("BEGIN READ ONLY");
    inTransaction = true;
    // DECLARE … CURSOR FOR <select> supports parameterized queries,
    // so we pass the drizzle-generated SQL through verbatim with the
    // matching parameter values. NO SCROLL because we only ever
    // FETCH forward — lets Postgres pick the cheapest plan.
    await client.query({
      text: `DECLARE notif_audit_csv NO SCROLL CURSOR FOR ${rawSql}`,
      values: params as unknown[],
    });
    cursorOpen = true;
    while (!aborted) {
      const result = await client.query<AuditCsvRow>(
        `FETCH ${AUDIT_CSV_CURSOR_BATCH} FROM notif_audit_csv`,
      );
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        if (aborted) break;
        const line = formatAuditCsvRow(row);
        if (!res.write(line)) {
          // Respect TCP backpressure — wait for the client to drain
          // before we shovel another batch in. Without this a slow
          // downloader could balloon the Node write buffer back up
          // to the same memory level we're trying to avoid.
          //
          // Critically, also resolve on `close` so a client that
          // disconnects while we're paused for backpressure can't
          // leave this promise pending forever — that would strand
          // the handler mid-transaction and hold the pooled DB
          // client open until some external timeout fires. The
          // surrounding loop checks `aborted` immediately after
          // resolving and exits cleanly.
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              res.off("drain", onDrain);
              res.off("error", onError);
              res.off("close", onClose);
            };
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (err: Error) => { cleanup(); reject(err); };
            const onClose = () => { cleanup(); resolve(); };
            res.once("drain", onDrain);
            res.once("error", onError);
            res.once("close", onClose);
          });
        }
        if (aborted) break;
      }
    }
    if (cursorOpen) {
      try { await client.query("CLOSE notif_audit_csv"); }
      catch { /* best-effort — COMMIT/ROLLBACK closes it anyway */ }
      cursorOpen = false;
    }
    await client.query("COMMIT");
    inTransaction = false;
  } catch (err) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); }
      catch { /* best-effort */ }
      inTransaction = false;
    }
    // Task #2016 — When the admin closes their tab we proactively
    // call `pg_cancel_backend(pid)` to interrupt the in-flight FETCH;
    // that surfaces as a 57014 (`query_canceled`) error here. It's a
    // clean abort, not a real failure, so we log at debug level and
    // don't re-throw. Anything else is still treated as a streaming
    // error.
    const code = (err as { code?: string } | null | undefined)?.code;
    if (cancelledByUs && code === "57014") {
      req.log?.debug(
        { pid: cursorClient.processID },
        "[notification-audit-csv] cancelled in-flight FETCH after client disconnect",
      );
    } else {
      req.log?.error({ err }, "[notification-audit-csv] streaming failed");
      throw err;
    }
  } finally {
    res.off("close", onClose);
    client.release();
  }

  if (!res.writableEnded) res.end();
}

router.get("/admin/notification-audit.csv", async (req: Request, res: Response) => {
  const parsed = await parseNotificationAuditQuery(req, res);
  if (parsed.kind === "sent") return;
  if (parsed.kind === "empty") {
    sendEmptyAuditCsv(res);
    return;
  }
  const { whereClause } = parsed;

  try {
    await streamAuditCsv(req, res, whereClause);
  } catch (err) {
    // If we never wrote anything we can still respond with a JSON
    // error. Once any bytes have been flushed the headers are sent,
    // so the best we can do is end the partial download — the client
    // will see a truncated file and our error log captures the cause.
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to export notification audit CSV" });
    } else if (!res.writableEnded) {
      res.end();
    }
    // Log already happened inside streamAuditCsv; swallow here so
    // Express doesn't double-log via its default error handler.
    void err;
  }
});

// GET /admin/notify-exhaustion-history — Task #1304.
//
// Surfaces the daily ops-alert (notification retry-exhaustion) data that
// the cron in `notifyExhaustionOpsAlert.ts` (Task #1130) emails out, so
// admins can see the same per-pipeline / per-channel counts in-app
// without grepping email. Read-only.
//
// Tenant scoping: super_admin sees the platform-wide totals (matching
// what the cron emails). org_admin / tournament_director see only their
// own organization's counts so an admin in club A can't enumerate
// exhaustion stats — or via the rows endpoint, ids — for club B. We
// still gate to the admin role triplet for parity with the other ops
// endpoints in this file.
//
// Query params (optional):
//   days — 1..90 (default 30). Number of UTC days of history to return.
router.get("/admin/notify-exhaustion-history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  // Tenant scope: super_admin sees the platform-wide totals (matching what
  // the cron emails). org_admin / tournament_director are scoped to their
  // own organization so they never see counts or rows for other clubs.
  // An org-bound admin without an org is a misconfiguration — empty out
  // their view rather than silently widening it to all clubs.
  let orgScope: number | null;
  if (role === "super_admin") {
    orgScope = null;
  } else {
    const oid = user?.organizationId;
    if (typeof oid !== "number") {
      res.json({ days: 0, buckets: [] }); return;
    }
    orgScope = oid;
  }
  const rawDays = Number.parseInt(String(req.query.days ?? "30"), 10);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 90) : 30;
  try {
    const buckets = await getExhaustionHistoryByDay({ days, organizationId: orgScope });
    // Surface the configured ops-alert recipients alongside the history
    // (Task #1541) so admins viewing a flagged day can confirm at a
    // glance who would have received the breach email — closing the
    // loop between the in-app history and the cron's outbound email.
    // Task #1910 — `source` now reflects the DB-or-env resolver, and
    // the envelope additionally exposes `envFallbackEmails` so the
    // page can render "currently inheriting from <env list>" when no
    // override is set or the override is empty (env recipients remain
    // the floor).
    const recipients = await getConfiguredOpsAlertRecipients();
    res.json({
      days,
      buckets,
      recipients: {
        emails: recipients.effective,
        source: recipients.source,
        envVar: recipients.envVar,
        envFallbackEmails: recipients.envList,
      },
    });
  } catch (err) {
    req.log?.error({ err }, "[notify-exhaustion-history] query failed");
    res.status(500).json({ error: "Failed to load exhaustion history" });
  }
});

// GET /admin/notify-exhaustion-rows — Task #1304.
//
// Drill-down companion to /notify-exhaustion-history: returns the
// individual coach-payout / levy-receipt rows whose chosen channel was
// marked exhausted within a UTC calendar day. The admin UI expands a day
// to show these so triagers can jump to the affected coach or member.
//
// Query params (all required):
//   pipeline — "coach_payout" | "levy_receipt"
//   channel  — "push" | "sms"
//   date     — UTC YYYY-MM-DD
// Optional:
//   limit    — 1..500 (default 100)
router.get("/admin/notify-exhaustion-rows", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  // Tenant scope (mirrors /admin/notify-exhaustion-history above): super
  // admins see all rows; non-super admins only their own org's. Without
  // this filter an org admin could enumerate other clubs' coach payout /
  // levy receipt ids, which is a tenant data leak.
  let orgScope: number | null;
  if (role === "super_admin") {
    orgScope = null;
  } else {
    const oid = user?.organizationId;
    if (typeof oid !== "number") {
      res.json({
        pipeline: req.query.pipeline ?? "",
        channel: req.query.channel ?? "",
        date: req.query.date ?? "",
        rows: [],
      });
      return;
    }
    orgScope = oid;
  }
  const pipelineRaw = String(req.query.pipeline ?? "");
  const channelRaw = String(req.query.channel ?? "");
  const dateRaw = String(req.query.date ?? "");
  if (pipelineRaw !== "coach_payout" && pipelineRaw !== "levy_receipt") {
    res.status(400).json({ error: "Invalid pipeline" }); return;
  }
  if (channelRaw !== "push" && channelRaw !== "sms") {
    res.status(400).json({ error: "Invalid channel" }); return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    res.status(400).json({ error: "Invalid date" }); return;
  }
  // Round-trip check rejects e.g. 2026-02-31 / 2026-13-99 that the regex
  // alone happily accepts.
  {
    const [y, m, d] = dateRaw.split("-").map((p) => parseInt(p, 10));
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (
      Number.isNaN(dt.getTime())
      || dt.getUTCFullYear() !== y
      || dt.getUTCMonth() !== m - 1
      || dt.getUTCDate() !== d
    ) {
      res.status(400).json({ error: "Invalid date" }); return;
    }
  }
  const rawLimit = Number.parseInt(String(req.query.limit ?? "100"), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
  try {
    const rows = await listExhaustedRowsForDay({
      pipeline: pipelineRaw as ExhaustionPipeline,
      channel: channelRaw as ExhaustionChannel,
      date: dateRaw,
      limit,
      organizationId: orgScope,
    });
    res.json({
      pipeline: pipelineRaw,
      channel: channelRaw,
      date: dateRaw,
      rows,
    });
  } catch (err) {
    req.log?.error({ err }, "[notify-exhaustion-rows] query failed");
    res.status(500).json({ error: "Failed to load exhaustion rows" });
  }
});

// POST /admin/notify-exhaustion-action — Task #1542.
//
// Companion action for the /notify-exhaustion-history drill-down: lets
// an admin retry one channel of an exhausted attempt or clear the
// exhaustion stamp without leaving the page.
//
// Body: {
//   pipeline:  "coach_payout" | "levy_receipt",
//   channel:   "push" | "sms",
//   attemptId: number,
//   action:    "retry" | "clear",
// }
//
// Tenant scoping mirrors the GET endpoints above: org_admin /
// tournament_director are pinned to their own org so they cannot act
// on another club's rows; super_admin sees the platform-wide pool.
// We re-load the row inside `clearChannelExhaustion` /
// `retryExhaustedChannel` with that scope so a cross-tenant attemptId
// returns 404 instead of leaking a write.
router.post("/admin/notify-exhaustion-action", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  let orgScope: number | null;
  if (role === "super_admin") {
    orgScope = null;
  } else {
    const oid = user?.organizationId;
    if (typeof oid !== "number") {
      // Misconfigured org-bound admin — refuse rather than silently
      // running the action against the platform-wide pool.
      res.status(404).json({ error: "Attempt not found" }); return;
    }
    orgScope = oid;
  }

  const body = (req.body ?? {}) as {
    pipeline?: unknown; channel?: unknown; attemptId?: unknown; action?: unknown;
  };
  const pipelineRaw = String(body.pipeline ?? "");
  const channelRaw = String(body.channel ?? "");
  const actionRaw = String(body.action ?? "");
  const attemptIdRaw = body.attemptId;
  if (pipelineRaw !== "coach_payout" && pipelineRaw !== "levy_receipt") {
    res.status(400).json({ error: "Invalid pipeline" }); return;
  }
  if (channelRaw !== "push" && channelRaw !== "sms") {
    res.status(400).json({ error: "Invalid channel" }); return;
  }
  if (actionRaw !== "retry" && actionRaw !== "clear") {
    res.status(400).json({ error: "Invalid action" }); return;
  }
  const attemptId = typeof attemptIdRaw === "number"
    ? attemptIdRaw
    : Number.parseInt(String(attemptIdRaw ?? ""), 10);
  if (!Number.isFinite(attemptId) || attemptId <= 0) {
    res.status(400).json({ error: "Invalid attemptId" }); return;
  }

  try {
    const result = actionRaw === "clear"
      ? await clearChannelExhaustion({
        pipeline: pipelineRaw as ExhaustionPipeline,
        channel: channelRaw as ExhaustionChannel,
        attemptId,
        organizationId: orgScope,
      })
      : await retryExhaustedChannel({
        pipeline: pipelineRaw as ExhaustionPipeline,
        channel: channelRaw as ExhaustionChannel,
        attemptId,
        organizationId: orgScope,
      });
    if (!result.ok) {
      res.status(404).json({ error: "Attempt not found" }); return;
    }
    res.json({
      pipeline: result.pipeline,
      channel: result.channel,
      attemptId: result.attemptId,
      action: actionRaw,
      attempt: result.attempt,
      retryResult: result.retryResult ?? null,
      noopReason: result.noopReason ?? null,
    });
  } catch (err) {
    req.log?.error({ err }, "[notify-exhaustion-action] action failed");
    res.status(500).json({ error: "Failed to apply exhaustion action" });
  }
});

// GET /admin/recap-broadcasts/recipients — Task #1496 + Task #1839.
//
// Drill-down companion to /admin/recap-broadcasts. Returns the per-recipient
// dispatch records the cron wrote to `notification_audit_log` for a single
// (year, period, day) tuple, so admins can answer "did Jane in club X
// actually get the recap?" without cross-referencing logs by hand.
//
// The cron writes one audit row per recipient with notification_key
// `recap.year.ready` and the year/period/day stamped into `payload`
// (see year-in-golf-cron.ts → RECAP_NOTIFICATION_KEY). We filter on
// those payload fields so a single key can serve every broadcast
// instead of polluting the registry with one key per (year, period, day).
//
// Task #1839 adds offset-based pagination + a total count so super admins
// looking at a platform-wide annual recap (which can dispatch to tens of
// thousands of members) aren't silently truncated at the per-page cap.
// We keep the per-page cap at 1000 to bound query cost, but admins can now
// page past it instead of losing every recipient beyond the first page.
//
// Query params:
//   year   — required, integer (e.g. 2025)
//   period — required, one of "year" | "q1" | "q2" | "q3" | "q4"
//   day    — required, integer 1..31 (cron only writes 1, 4, 7 today)
//   organizationId — optional. Super admins use it to scope to one club;
//                    for org_admin / tournament_director it's ignored
//                    (their tenant boundary is auto-applied below).
//   limit  — 1..1000 (default 200) — page size
//   page   — ≥ 1 (default 1) — 1-based page index
//
// Auth (mirrors GET /admin/recap-broadcasts):
//   • org_admin            — auto-scoped to req.user.organizationId
//   • tournament_director  — auto-scoped to req.user.organizationId
//   • super_admin          — sees every recipient; org filter optional
router.get("/admin/recap-broadcasts/recipients", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  // Required params: year + period + day. Refuse anything we can't parse
  // strictly so a typo produces a 400 instead of an empty result that
  // looks like a real "no recipients" case.
  const yearRaw = typeof req.query.year === "string" ? req.query.year : "";
  const periodRaw = typeof req.query.period === "string" ? req.query.period : "";
  const dayRaw = typeof req.query.day === "string" ? req.query.day : "";
  const year = parseStrictInt(yearRaw);
  const day = parseStrictInt(dayRaw);
  if (year === null || year < 1900 || year > 3100) {
    res.status(400).json({ error: "year is required and must be a 4-digit integer" }); return;
  }
  if (!["year", "q1", "q2", "q3", "q4"].includes(periodRaw)) {
    res.status(400).json({ error: "period is required and must be one of year, q1, q2, q3, q4" }); return;
  }
  if (day === null || day < 1 || day > 31) {
    res.status(400).json({ error: "day is required and must be an integer 1..31" }); return;
  }

  const rawLimit = Number.parseInt(String(req.query.limit ?? "200"), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 200;

  // Page is 1-based. Anything missing / non-numeric / non-positive falls
  // back to the first page so old bookmarks (which never sent ?page) keep
  // working unchanged. We don't cap page from above — the count query
  // tells us the real upper bound, and a page past the end just returns
  // an empty `recipients` array with the correct `total`.
  const rawPage = Number.parseInt(String(req.query.page ?? "1"), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const offset = (page - 1) * limit;

  // Tenant boundary. Super admins see every club; can optionally narrow
  // via ?organizationId=. Org admins / tournament directors are pinned
  // to their own org regardless of what they pass — we don't error on a
  // mismatched ?organizationId, we just ignore it (matches the silent
  // scope-down behaviour the rest of this file uses for parity).
  let scopedOrgId: number | null = null;
  if (role === "super_admin") {
    if (typeof req.query.organizationId === "string" && req.query.organizationId.trim() !== "") {
      const parsed = parseStrictInt(req.query.organizationId.trim());
      if (parsed === null) {
        res.status(400).json({ error: "organizationId must be an integer" }); return;
      }
      scopedOrgId = parsed;
    }
  } else {
    const orgId = user?.organizationId ?? null;
    if (!orgId) {
      // Misconfigured org_admin / tournament_director — degrade gracefully
      // with an empty list rather than 500. organizationId is null here
      // (rather than omitted) so clients always see the same shape.
      res.json({
        year, period: periodRaw, day, organizationId: null,
        recipients: [], limit, page, total: 0,
      });
      return;
    }
    scopedOrgId = orgId;
  }

  try {
    const conds: SQL[] = [
      eq(notificationAuditLogTable.notificationKey, RECAP_NOTIFICATION_KEY),
      // Match the (year, period, day) tuple the cron stamps into the
      // payload. Cast year/day to text on both sides so the JSON ->>
      // operator (which always returns text) compares cleanly.
      sql`${notificationAuditLogTable.payload}->>'year' = ${String(year)}`,
      sql`${notificationAuditLogTable.payload}->>'period' = ${periodRaw}`,
      sql`${notificationAuditLogTable.payload}->>'day' = ${String(day)}`,
    ];
    if (scopedOrgId !== null) {
      conds.push(eq(appUsersTable.organizationId, scopedOrgId));
    }

    // Fetch the page and the total in parallel. The total uses the same
    // join + filter set so the count stays consistent with the page rows
    // (e.g. the org filter on appUsersTable narrows both equally). We
    // always include the leftJoin even when there's no org filter so the
    // query plan matches the page query exactly — the row count of a
    // left-joined notification_audit_log row is still 1 per audit row,
    // because user_id is unique-per-row inside the audit log.
    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: notificationAuditLogTable.id,
          userId: notificationAuditLogTable.userId,
          channel: notificationAuditLogTable.channel,
          status: notificationAuditLogTable.status,
          reason: notificationAuditLogTable.reason,
          createdAt: notificationAuditLogTable.createdAt,
          username: appUsersTable.username,
          displayName: appUsersTable.displayName,
          email: appUsersTable.email,
          organizationId: appUsersTable.organizationId,
          organizationName: organizationsTable.name,
        })
        .from(notificationAuditLogTable)
        .leftJoin(appUsersTable, eq(appUsersTable.id, notificationAuditLogTable.userId))
        .leftJoin(organizationsTable, eq(organizationsTable.id, appUsersTable.organizationId))
        .where(and(...conds))
        .orderBy(
          // Group by club so the drill-down reads as "Club A: alice, bob;
          // Club B: carol" rather than a flat alphabetical mix. Within a
          // club we fall back to user display name so the order stays
          // stable across reloads even when names differ in case.
          organizationsTable.name,
          appUsersTable.displayName,
          notificationAuditLogTable.id,
        )
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(notificationAuditLogTable)
        .leftJoin(appUsersTable, eq(appUsersTable.id, notificationAuditLogTable.userId))
        .leftJoin(organizationsTable, eq(organizationsTable.id, appUsersTable.organizationId))
        .where(and(...conds)),
    ]);

    const total = Number(totalRows[0]?.value ?? 0);

    res.json({
      year,
      period: periodRaw,
      day,
      organizationId: scopedOrgId,
      limit,
      page,
      total,
      recipients: rows.map(r => ({
        id: r.id,
        userId: r.userId,
        username: r.username ?? null,
        displayName: r.displayName ?? null,
        email: r.email ?? null,
        organizationId: r.organizationId ?? null,
        organizationName: r.organizationName ?? null,
        channel: r.channel,
        status: r.status,
        reason: r.reason,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    req.log?.error({ err }, "[recap-broadcasts/recipients] query failed");
    res.status(500).json({ error: "Failed to load recap broadcast recipients" });
  }
});

// GET /admin/recap-broadcasts/recipients.csv — Task #1838.
//
// Sibling of GET /admin/recap-broadcasts/recipients. Reuses the same role
// gate, (year, period, day) tuple, and tenant boundary so a downloaded
// report contains exactly the recipients the admin would see in the
// drill-down panel under the same scope — never any row outside their
// tenant.
//
// Differences from the JSON endpoint:
//   • No row cap — the panel limits to 1000 to keep the inline list
//     scannable, but ops admins exporting for a support ticket / club
//     handoff need the full set, mirroring how /admin/notification-audit.csv
//     behaves vs its JSON sibling. The `limit` query param is accepted
//     but ignored to keep the URL contract identical.
//   • Response is text/csv with a Content-Disposition attachment header
//     so the browser triggers a save dialog instead of navigating.
//   • Empty scopes (org_admin without an org / no matching audit rows)
//     still produce a valid CSV containing just the header row, so
//     downstream tooling that expects a file always gets one.
//   • Streamed via a Postgres server-side cursor so even very large
//     clubs export with bounded memory and the download dialog appears
//     before the SELECT finishes.

const RECAP_RECIPIENTS_CSV_HEADER = csvRow([
  "display_name",
  "username",
  "email",
  "club",
  "channel",
  "status",
  "sent_at",
]);

function setRecapRecipientsCsvHeaders(res: Response): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="recap-recipients-${stamp}.csv"`,
  );
  // Recipient lists include member emails — never let an intermediary
  // cache them.
  res.setHeader("Cache-Control", "no-store");
  res.status(200);
}

function sendEmptyRecapRecipientsCsv(res: Response): void {
  setRecapRecipientsCsvHeaders(res);
  res.send(RECAP_RECIPIENTS_CSV_HEADER);
}

// Shape of a single joined recipient row coming back from the streaming
// cursor. Drizzle's `.select({...})` projection emits the underlying
// column names without aliases (e.g. `"organizations"."name"`), so when
// we run the raw SQL through pg the row keys are the bare DB column
// names — `name` from `organizations`, `display_name` from `app_users`,
// etc. (Drizzle's normal camelCase result mapping is bypassed here.)
//
// To avoid an `id`-vs-`id` collision across the joined tables we
// deliberately don't project any `id` column — only the columns the
// CSV needs.
type RecipientCsvRow = {
  channel: string;
  status: string;
  created_at: Date | string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  // From the LEFT-JOINed organizations table — the only `name` column
  // in this projection, so no aliasing is needed.
  name: string | null;
};

function formatRecipientCsvRow(r: RecipientCsvRow): string {
  return csvRow([
    r.display_name ?? "",
    r.username ?? "",
    r.email ?? "",
    r.name ?? "",
    r.channel,
    r.status,
    r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  ]);
}

const RECAP_RECIPIENTS_CSV_CURSOR_BATCH = 500;

async function streamRecapRecipientsCsv(
  req: Request,
  res: Response,
  whereClause: SQL,
): Promise<void> {
  const baseQuery = db
    .select({
      channel: notificationAuditLogTable.channel,
      status: notificationAuditLogTable.status,
      createdAt: notificationAuditLogTable.createdAt,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
      organizationName: organizationsTable.name,
    })
    .from(notificationAuditLogTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, notificationAuditLogTable.userId))
    .leftJoin(organizationsTable, eq(organizationsTable.id, appUsersTable.organizationId))
    .where(whereClause)
    .orderBy(
      // Mirror the JSON drill-down's ordering so the CSV reads the same
      // way the admin saw it on screen.
      organizationsTable.name,
      appUsersTable.displayName,
      notificationAuditLogTable.id,
    );

  const { sql: rawSql, params } = baseQuery.toSQL();

  setRecapRecipientsCsvHeaders(res);
  res.write(RECAP_RECIPIENTS_CSV_HEADER);

  let aborted = false;
  const onClose = () => { aborted = true; };
  res.on("close", onClose);

  const client = await pool.connect();
  let cursorOpen = false;
  let inTransaction = false;
  try {
    await client.query("BEGIN READ ONLY");
    inTransaction = true;
    await client.query({
      text: `DECLARE recap_recipients_csv NO SCROLL CURSOR FOR ${rawSql}`,
      values: params as unknown[],
    });
    cursorOpen = true;
    while (!aborted) {
      const result = await client.query<RecipientCsvRow>(
        `FETCH ${RECAP_RECIPIENTS_CSV_CURSOR_BATCH} FROM recap_recipients_csv`,
      );
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        if (aborted) break;
        const line = formatRecipientCsvRow(row);
        if (!res.write(line)) {
          // Wait for backpressure to clear, but resolve on `close` too
          // so a cancelled download can't strand this handler holding
          // a pooled DB client open. Mirrors the audit CSV cleanup.
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              res.off("drain", onDrain);
              res.off("error", onError);
              res.off("close", onAbort);
            };
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (err: Error) => { cleanup(); reject(err); };
            const onAbort = () => { cleanup(); resolve(); };
            res.once("drain", onDrain);
            res.once("error", onError);
            res.once("close", onAbort);
          });
        }
        if (aborted) break;
      }
    }
    if (cursorOpen) {
      try { await client.query("CLOSE recap_recipients_csv"); }
      catch { /* best-effort — COMMIT/ROLLBACK closes it anyway */ }
      cursorOpen = false;
    }
    await client.query("COMMIT");
    inTransaction = false;
  } catch (err) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); }
      catch { /* best-effort */ }
    }
    req.log?.error({ err }, "[recap-broadcasts/recipients.csv] streaming failed");
    throw err;
  } finally {
    res.off("close", onClose);
    client.release();
  }

  if (!res.writableEnded) res.end();
}

router.get("/admin/recap-broadcasts/recipients.csv", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  // Required params: year + period + day. Strict parsing so a typo
  // produces a 400 instead of an empty CSV that looks like a real
  // "no recipients" case.
  const yearRaw = typeof req.query.year === "string" ? req.query.year : "";
  const periodRaw = typeof req.query.period === "string" ? req.query.period : "";
  const dayRaw = typeof req.query.day === "string" ? req.query.day : "";
  const year = parseStrictInt(yearRaw);
  const day = parseStrictInt(dayRaw);
  if (year === null || year < 1900 || year > 3100) {
    res.status(400).json({ error: "year is required and must be a 4-digit integer" }); return;
  }
  if (!["year", "q1", "q2", "q3", "q4"].includes(periodRaw)) {
    res.status(400).json({ error: "period is required and must be one of year, q1, q2, q3, q4" }); return;
  }
  if (day === null || day < 1 || day > 31) {
    res.status(400).json({ error: "day is required and must be an integer 1..31" }); return;
  }

  // Tenant boundary mirrors the JSON endpoint above. Super admins can
  // optionally narrow via ?organizationId=; org admins / tournament
  // directors are pinned to their own org regardless of any param.
  let scopedOrgId: number | null = null;
  if (role === "super_admin") {
    if (typeof req.query.organizationId === "string" && req.query.organizationId.trim() !== "") {
      const parsed = parseStrictInt(req.query.organizationId.trim());
      if (parsed === null) {
        res.status(400).json({ error: "organizationId must be an integer" }); return;
      }
      scopedOrgId = parsed;
    }
  } else {
    const orgId = user?.organizationId ?? null;
    if (!orgId) {
      // Misconfigured org_admin — emit just the header row so the
      // browser still gets a valid file (parity with audit CSV).
      sendEmptyRecapRecipientsCsv(res); return;
    }
    scopedOrgId = orgId;
  }

  const conds: SQL[] = [
    eq(notificationAuditLogTable.notificationKey, RECAP_NOTIFICATION_KEY),
    sql`${notificationAuditLogTable.payload}->>'year' = ${String(year)}`,
    sql`${notificationAuditLogTable.payload}->>'period' = ${periodRaw}`,
    sql`${notificationAuditLogTable.payload}->>'day' = ${String(day)}`,
  ];
  if (scopedOrgId !== null) {
    conds.push(eq(appUsersTable.organizationId, scopedOrgId));
  }
  const whereClause = and(...conds) as SQL;

  try {
    await streamRecapRecipientsCsv(req, res, whereClause);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to export recap recipients CSV" });
    } else if (!res.writableEnded) {
      res.end();
    }
    void err;
  }
});

// GET /admin/recap-broadcasts — Task #1276.
//
// Returns the most recent rows from `recap_broadcasts` (Task #450) so
// admins can see at a glance which Year-in-Golf launch / reminder pushes
// the cron has actually fired, when each ran, and how many recipients it
// covered. Read-only — recap sends are owned by the cron, not by humans.
//
// The table is platform-wide (no org column): the launch cron sends to
// every opted-in user across every club, so an org_admin and a
// super_admin see the same set of rows here. We still gate to the
// admin role pair for parity with the other ops endpoints in this file.
//
// Query params (optional):
//   limit — 1..200 (default 50)
router.get("/admin/recap-broadcasts", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const rawLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  try {
    const rows = await db
      .select({
        year: recapBroadcastsTable.year,
        period: recapBroadcastsTable.period,
        day: recapBroadcastsTable.day,
        recipients: recapBroadcastsTable.recipients,
        sentAt: recapBroadcastsTable.sentAt,
      })
      .from(recapBroadcastsTable)
      .orderBy(desc(recapBroadcastsTable.sentAt))
      .limit(limit);
    res.json({ broadcasts: rows, limit });
  } catch (err) {
    req.log?.error({ err }, "[recap-broadcasts] query failed");
    res.status(500).json({ error: "Failed to load recap broadcasts" });
  }
});

// GET /admin/recap-share-stats — Task #1510.
//
// Org-wide companion to GET /api/portal/me/recap-share-stats (Task #1281).
// Surfaces aggregate counts for hits to public Year-in-Golf recap endpoints
// (`/api/public/recap/:handle/card.png` and `/api/public/recap/:handle/og`)
// scoped to the admin's organization, plus a top-N players-by-opens list so
// clubs can spot which members are driving the most public recap traffic
// (useful for marketing) and which look like bot/crawler abuse early.
//
// Auth (mirrors GET /admin/recap-broadcasts):
//   • org_admin / tournament_director — auto-scoped to req.user.organizationId
//   • super_admin                     — sees the platform-wide totals
// Players never reach this endpoint; the per-player breakdown lives on the
// portal endpoint above.
//
// Tenant scope: counts come from `recap_share_events` (recent rows) UNION'd
// with `recap_share_daily_aggregates` (older rows summarised per day after
// the rollup cron in `recapShareRollup.ts` runs). Filtering each by
// `userId IN (org users)` keeps the totals strictly tenant-bounded so
// org admins can't enumerate other clubs' recap traffic.
//
// The "opens" tally we sort the top-N list by deliberately excludes the
// `crawler` source — link-preview crawlers can fan a single share into
// many fetches, so counting them as "opens" would conflate a viral share
// with a viral player. Crawler hits remain visible in `totalsBySource`
// for a complete picture.
//
// Task #1867 — flagging crawler-only abuse: each top-N row is stamped with
//   crawlerHits           = total - opens
//   crawlerRatio          = crawlerHits / total       (0 when total = 0)
//   crawlerAbuseSuspected = crawlerRatio  >= ABUSE_CRAWLER_RATIO_THRESHOLD
//                           AND total      >= ABUSE_MIN_TOTAL_HITS
// The `total >= MIN` floor stops a single drive-by Slack/Discord unfurl
// from looking like abuse (1 crawler / 1 total = 100% ratio). The 0.8
// ratio is calibrated against `recapShareScopes` in publicRateLimit.ts —
// the per-(IP,handle) bucket caps a legitimate sharer at 20 hits/hour, so
// a player whose accumulated traffic is overwhelmingly crawlers is not
// being driven by normal social-share behaviour. Both knobs are surfaced
// on the response (`abuseThresholds`) so the UI can document them inline.
//
// Query params (optional):
//   topN — 1..50 (default 10) cap on `topPlayers` length.
//
// Response shape:
//   {
//     scope: "org" | "platform",
//     organizationId: number | null,
//     total: number,
//     totalsByAsset:  { card_png, og },
//     totalsBySource: { copy, web_share, native_share, qr_open, crawler, unknown },
//     byPeriod: Array<{ year, period, total, byAsset, bySource }>,
//     topPlayers: Array<{
//       userId, username, displayName, publicHandle,
//       total, opens,
//       crawlerHits, crawlerRatio, crawlerAbuseSuspected,
//     }>,
//     topN: number,
//     abuseThresholds: { minTotalHits: number; crawlerRatio: number },
//   }
const ADMIN_RECAP_SHARE_ASSETS = ["card_png", "og"] as const;
const ADMIN_RECAP_SHARE_SOURCES_OUT = [
  "copy", "web_share", "native_share", "qr_open", "crawler", "unknown",
] as const;
// Task #1867 — crawler-only abuse thresholds. Tunable here; the response
// echoes them so the admin UI can show "≥80% crawler & ≥20 hits" inline
// without hard-coding the numbers in two places.
const ADMIN_RECAP_ABUSE_MIN_TOTAL_HITS = 20;
const ADMIN_RECAP_ABUSE_CRAWLER_RATIO_THRESHOLD = 0.8;
type AdminRecapShareAssetKey = typeof ADMIN_RECAP_SHARE_ASSETS[number];
type AdminRecapShareSourceKey = typeof ADMIN_RECAP_SHARE_SOURCES_OUT[number];
function emptyAdminRecapAssetCounts(): Record<AdminRecapShareAssetKey, number> {
  return { card_png: 0, og: 0 };
}
function emptyAdminRecapSourceCounts(): Record<AdminRecapShareSourceKey, number> {
  return { copy: 0, web_share: 0, native_share: 0, qr_open: 0, crawler: 0, unknown: 0 };
}

// Result of resolving the admin / scope / topN pieces of a recap-share-stats
// request. Shared by the JSON endpoint and its `.csv` sibling so the two
// always agree on the auth gate, the org/platform boundary, and the topN
// clamp — the whole point of the CSV being a "sibling" is that it returns
// the same dataset as the JSON view.
type AdminRecapShareStatsScope =
  | { kind: "sent" }
  | { kind: "empty"; scope: "org"; organizationId: number | null; topN: number }
  | {
      kind: "ok";
      scope: "org" | "platform";
      organizationId: number | null;
      topN: number;
      // null  → super_admin, no org filter
      // [...] → org-bound admin; aggregation queries filter by these userIds
      orgUserIds: number[] | null;
    };

async function resolveAdminRecapShareStatsRequest(
  req: Request,
  res: Response,
): Promise<AdminRecapShareStatsScope> {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return { kind: "sent" };
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return { kind: "sent" };
  }

  // Tenant scope. super_admin sees the whole platform; org-bound admins are
  // restricted to users in their organization. An org-bound admin without
  // an organization is misconfigured — degrade to an empty payload rather
  // than silently widening their view to every club.
  const isSuperAdmin = role === "super_admin";
  const orgId = isSuperAdmin ? null : (user?.organizationId ?? null);

  const rawTopN = Number.parseInt(String(req.query.topN ?? "10"), 10);
  const topN = Number.isFinite(rawTopN) && rawTopN > 0 ? Math.min(rawTopN, 50) : 10;

  if (!isSuperAdmin && orgId === null) {
    return { kind: "empty", scope: "org", organizationId: null, topN };
  }

  // For org-scoped admins, resolve the userIds in their org once. We use
  // an inArray() filter rather than a JOIN so the subsequent GROUP BY
  // queries don't have to drag the appUsers row in for every share row.
  let orgUserIds: number[] | null = null;
  if (!isSuperAdmin && orgId !== null) {
    const rows = await db
      .select({ id: appUsersTable.id })
      .from(appUsersTable)
      .where(eq(appUsersTable.organizationId, orgId));
    orgUserIds = rows.map(r => r.id);
    if (orgUserIds.length === 0) {
      return { kind: "empty", scope: "org", organizationId: orgId, topN };
    }
  }
  return {
    kind: "ok",
    scope: isSuperAdmin ? "platform" : "org",
    organizationId: orgId,
    topN,
    orgUserIds,
  };
}

// The aggregated dataset surfaced by both the JSON endpoint and the CSV
// export. Kept as a plain shape (no `scope` / `organizationId` / `topN`)
// so the framing stays a concern of the calling handler.
type AdminRecapShareStatsResult = {
  total: number;
  totalsByAsset: Record<AdminRecapShareAssetKey, number>;
  totalsBySource: Record<AdminRecapShareSourceKey, number>;
  byPeriod: Array<{
    year: number;
    period: string;
    total: number;
    byAsset: Record<AdminRecapShareAssetKey, number>;
    bySource: Record<AdminRecapShareSourceKey, number>;
  }>;
  topPlayers: Array<{
    userId: number;
    username: string | null;
    displayName: string | null;
    publicHandle: string | null;
    total: number;
    opens: number;
    crawlerHits: number;
    crawlerRatio: number;
    crawlerAbuseSuspected: boolean;
  }>;
};

function emptyAdminRecapShareStatsResult(): AdminRecapShareStatsResult {
  return {
    total: 0,
    totalsByAsset: emptyAdminRecapAssetCounts(),
    totalsBySource: emptyAdminRecapSourceCounts(),
    byPeriod: [],
    topPlayers: [],
  };
}

async function loadAdminRecapShareStats(opts: {
  orgUserIds: number[] | null;
  topN: number;
}): Promise<AdminRecapShareStatsResult> {
  const { orgUserIds, topN } = opts;
  // We pull two grouped result sets — one from raw events (recent), one
  // from daily aggregates (older). The rollup deletes events once they
  // are aggregated so there is no double-count on the boundary.
  const rawWhere = orgUserIds === null
    ? undefined
    : inArray(recapShareEventsTable.userId, orgUserIds);
  const aggWhere = orgUserIds === null
    ? undefined
    : inArray(recapShareDailyAggregatesTable.userId, orgUserIds);

  const [rawRows, aggRows] = await Promise.all([
    (() => {
      const q = db
        .select({
          userId: recapShareEventsTable.userId,
          asset: recapShareEventsTable.asset,
          period: recapShareEventsTable.period,
          year: recapShareEventsTable.year,
          source: recapShareEventsTable.source,
          n: count(recapShareEventsTable.id),
        })
        .from(recapShareEventsTable);
      return rawWhere
        ? q.where(rawWhere).groupBy(
            recapShareEventsTable.userId,
            recapShareEventsTable.asset,
            recapShareEventsTable.period,
            recapShareEventsTable.year,
            recapShareEventsTable.source,
          )
        : q.groupBy(
            recapShareEventsTable.userId,
            recapShareEventsTable.asset,
            recapShareEventsTable.period,
            recapShareEventsTable.year,
            recapShareEventsTable.source,
          );
    })(),
    (() => {
      const q = db
        .select({
          userId: recapShareDailyAggregatesTable.userId,
          asset: recapShareDailyAggregatesTable.asset,
          period: recapShareDailyAggregatesTable.period,
          year: recapShareDailyAggregatesTable.year,
          source: recapShareDailyAggregatesTable.source,
          n: sql<number>`COALESCE(SUM(${recapShareDailyAggregatesTable.count}), 0)::int`,
        })
        .from(recapShareDailyAggregatesTable);
      return aggWhere
        ? q.where(aggWhere).groupBy(
            recapShareDailyAggregatesTable.userId,
            recapShareDailyAggregatesTable.asset,
            recapShareDailyAggregatesTable.period,
            recapShareDailyAggregatesTable.year,
            recapShareDailyAggregatesTable.source,
          )
        : q.groupBy(
            recapShareDailyAggregatesTable.userId,
            recapShareDailyAggregatesTable.asset,
            recapShareDailyAggregatesTable.period,
            recapShareDailyAggregatesTable.year,
            recapShareDailyAggregatesTable.source,
          );
    })(),
  ]);

  const totalsByAsset = emptyAdminRecapAssetCounts();
  const totalsBySource = emptyAdminRecapSourceCounts();
  let total = 0;
  const byPeriodMap = new Map<string, {
    year: number;
    period: string;
    total: number;
    byAsset: Record<AdminRecapShareAssetKey, number>;
    bySource: Record<AdminRecapShareSourceKey, number>;
  }>();
  // userId → { total, opens } where opens excludes crawler hits (see header).
  const perUser = new Map<number, { total: number; opens: number }>();

  for (const r of [...rawRows, ...aggRows]) {
    const n = Number(r.n) || 0;
    if (n === 0) continue;
    const asset = (ADMIN_RECAP_SHARE_ASSETS as readonly string[]).includes(r.asset)
      ? (r.asset as AdminRecapShareAssetKey)
      : null;
    const source: AdminRecapShareSourceKey = (ADMIN_RECAP_SHARE_SOURCES_OUT as readonly string[]).includes(r.source)
      ? (r.source as AdminRecapShareSourceKey)
      : "unknown";
    if (asset) totalsByAsset[asset] += n;
    totalsBySource[source] += n;
    total += n;

    const periodKey = `${r.year}|${r.period}`;
    let entry = byPeriodMap.get(periodKey);
    if (!entry) {
      entry = {
        year: Number(r.year),
        period: String(r.period),
        total: 0,
        byAsset: emptyAdminRecapAssetCounts(),
        bySource: emptyAdminRecapSourceCounts(),
      };
      byPeriodMap.set(periodKey, entry);
    }
    entry.total += n;
    if (asset) entry.byAsset[asset] += n;
    entry.bySource[source] += n;

    const uid = r.userId;
    let p = perUser.get(uid);
    if (!p) {
      p = { total: 0, opens: 0 };
      perUser.set(uid, p);
    }
    p.total += n;
    if (source !== "crawler") p.opens += n;
  }

  const byPeriod = Array.from(byPeriodMap.values())
    .sort((a, b) => (b.year - a.year) || a.period.localeCompare(b.period));

  // Pick top-N by opens (human clicks). Tie-break by total then userId so
  // the order is deterministic across requests when counts match.
  const ranked = Array.from(perUser.entries())
    .map(([userId, v]) => ({ userId, total: v.total, opens: v.opens }))
    .sort((a, b) => (b.opens - a.opens) || (b.total - a.total) || (a.userId - b.userId))
    .slice(0, topN);

  let topPlayers: AdminRecapShareStatsResult["topPlayers"] = [];
  if (ranked.length > 0) {
    const ids = ranked.map(r => r.userId);
    const userRows = await db
      .select({
        id: appUsersTable.id,
        username: appUsersTable.username,
        displayName: appUsersTable.displayName,
        publicHandle: appUsersTable.publicHandle,
      })
      .from(appUsersTable)
      .where(inArray(appUsersTable.id, ids));
    const byId = new Map(userRows.map(u => [u.id, u]));
    topPlayers = ranked.map(r => {
      const u = byId.get(r.userId);
      // Task #1867 — derive crawler-only abuse signal. opens already
      // excludes crawler hits, so total - opens is the pure crawler
      // count. Guard against div-by-zero (`ranked` only contains rows
      // with total > 0 today, but defend anyway so the contract is
      // safe if upstream bookkeeping ever changes).
      const crawlerHits = Math.max(0, r.total - r.opens);
      const crawlerRatio = r.total > 0 ? crawlerHits / r.total : 0;
      const crawlerAbuseSuspected =
        r.total >= ADMIN_RECAP_ABUSE_MIN_TOTAL_HITS &&
        crawlerRatio >= ADMIN_RECAP_ABUSE_CRAWLER_RATIO_THRESHOLD;
      return {
        userId: r.userId,
        username: u?.username ?? null,
        displayName: u?.displayName ?? null,
        publicHandle: u?.publicHandle ?? null,
        total: r.total,
        opens: r.opens,
        crawlerHits,
        crawlerRatio,
        crawlerAbuseSuspected,
      };
    });
  }

  return { total, totalsByAsset, totalsBySource, byPeriod, topPlayers };
}

router.get("/admin/recap-share-stats", async (req: Request, res: Response) => {
  const parsed = await resolveAdminRecapShareStatsRequest(req, res);
  if (parsed.kind === "sent") return;
  if (parsed.kind === "empty") {
    res.json({
      scope: parsed.scope,
      organizationId: parsed.organizationId,
      total: 0,
      totalsByAsset: emptyAdminRecapAssetCounts(),
      totalsBySource: emptyAdminRecapSourceCounts(),
      byPeriod: [],
      topPlayers: [],
      topN: parsed.topN,
    });
    return;
  }
  try {
    const stats = await loadAdminRecapShareStats({
      orgUserIds: parsed.orgUserIds,
      topN: parsed.topN,
    });
    res.json({
      scope: parsed.scope,
      organizationId: parsed.organizationId,
      total: stats.total,
      totalsByAsset: stats.totalsByAsset,
      totalsBySource: stats.totalsBySource,
      byPeriod: stats.byPeriod,
      topPlayers: stats.topPlayers,
      topN: parsed.topN,
      abuseThresholds: {
        minTotalHits: ADMIN_RECAP_ABUSE_MIN_TOTAL_HITS,
        crawlerRatio: ADMIN_RECAP_ABUSE_CRAWLER_RATIO_THRESHOLD,
      },
    });
  } catch (err) {
    req.log?.error({ err }, "[recap-share-stats] query failed");
    res.status(500).json({ error: "Failed to load recap share stats" });
  }
});

// GET /admin/recap-share-stats/player/:userId — Task #1865.
//
// Drill-down for a single member surfaced in the parent endpoint's
// `topPlayers` list. Returns the same per-period / per-source breakdown
// shape that GET /api/portal/me/recap-share-stats returns for the
// player themselves, so admins can confirm whether a member's tally is
// driven by sustained activity across recap windows or by a single
// viral share — and whether their hits are mostly link-preview crawler
// fan-out vs. real human opens.
//
// Auth mirrors the parent endpoint:
//   • org_admin / tournament_director — auto-scoped to req.user.organizationId
//                                       and may only drill into members of
//                                       their own organization (404 otherwise
//                                       so we don't leak whether the userId
//                                       exists in some other tenant).
//   • super_admin                     — may drill into any user.
//
// Response shape (matches the per-player portal endpoint):
//   {
//     userId, username, displayName, publicHandle,
//     total: number,
//     totalsByAsset:  { card_png, og },
//     totalsBySource: { copy, web_share, native_share, qr_open, crawler, unknown },
//     byPeriod: Array<{ year, period, total, byAsset, bySource }>,
//   }
router.get("/admin/recap-share-stats/player/:userId", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const targetUserId = Number.parseInt(String(req.params.userId ?? ""), 10);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    res.status(400).json({ error: "Invalid userId" }); return;
  }

  const isSuperAdmin = role === "super_admin";
  const callerOrgId = isSuperAdmin ? null : (user?.organizationId ?? null);

  // Org-bound admin without an organization is misconfigured — refuse to
  // drill into anyone, same defensive posture as the parent endpoint.
  if (!isSuperAdmin && callerOrgId === null) {
    res.status(404).json({ error: "Player not found" }); return;
  }

  try {
    // Look up the target user. For org-bound admins we 404 (rather than
    // 403) when the target lives in a different org so we don't reveal
    // whether `userId` exists in some other tenant — matches how the
    // parent endpoint scopes top-N to the caller's org.
    const [targetRow] = await db
      .select({
        id: appUsersTable.id,
        username: appUsersTable.username,
        displayName: appUsersTable.displayName,
        publicHandle: appUsersTable.publicHandle,
        organizationId: appUsersTable.organizationId,
      })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, targetUserId));
    if (!targetRow) {
      res.status(404).json({ error: "Player not found" }); return;
    }
    if (!isSuperAdmin && targetRow.organizationId !== callerOrgId) {
      res.status(404).json({ error: "Player not found" }); return;
    }

    // Same union strategy as the parent endpoint: raw events (recent) +
    // daily aggregates (older). The rollup deletes raw events once they
    // are aggregated so the union doesn't double-count on the boundary.
    const [rawRows, aggRows] = await Promise.all([
      db
        .select({
          asset: recapShareEventsTable.asset,
          period: recapShareEventsTable.period,
          year: recapShareEventsTable.year,
          source: recapShareEventsTable.source,
          n: count(recapShareEventsTable.id),
        })
        .from(recapShareEventsTable)
        .where(eq(recapShareEventsTable.userId, targetUserId))
        .groupBy(
          recapShareEventsTable.asset,
          recapShareEventsTable.period,
          recapShareEventsTable.year,
          recapShareEventsTable.source,
        ),
      db
        .select({
          asset: recapShareDailyAggregatesTable.asset,
          period: recapShareDailyAggregatesTable.period,
          year: recapShareDailyAggregatesTable.year,
          source: recapShareDailyAggregatesTable.source,
          n: sql<number>`COALESCE(SUM(${recapShareDailyAggregatesTable.count}), 0)::int`,
        })
        .from(recapShareDailyAggregatesTable)
        .where(eq(recapShareDailyAggregatesTable.userId, targetUserId))
        .groupBy(
          recapShareDailyAggregatesTable.asset,
          recapShareDailyAggregatesTable.period,
          recapShareDailyAggregatesTable.year,
          recapShareDailyAggregatesTable.source,
        ),
    ]);

    const totalsByAsset = emptyAdminRecapAssetCounts();
    const totalsBySource = emptyAdminRecapSourceCounts();
    let total = 0;
    const byPeriodMap = new Map<string, {
      year: number;
      period: string;
      total: number;
      byAsset: Record<AdminRecapShareAssetKey, number>;
      bySource: Record<AdminRecapShareSourceKey, number>;
    }>();

    for (const r of [...rawRows, ...aggRows]) {
      const n = Number(r.n) || 0;
      if (n === 0) continue;
      const asset = (ADMIN_RECAP_SHARE_ASSETS as readonly string[]).includes(r.asset)
        ? (r.asset as AdminRecapShareAssetKey)
        : null;
      const source: AdminRecapShareSourceKey = (ADMIN_RECAP_SHARE_SOURCES_OUT as readonly string[]).includes(r.source)
        ? (r.source as AdminRecapShareSourceKey)
        : "unknown";
      if (asset) totalsByAsset[asset] += n;
      totalsBySource[source] += n;
      total += n;

      const periodKey = `${r.year}|${r.period}`;
      let entry = byPeriodMap.get(periodKey);
      if (!entry) {
        entry = {
          year: Number(r.year),
          period: String(r.period),
          total: 0,
          byAsset: emptyAdminRecapAssetCounts(),
          bySource: emptyAdminRecapSourceCounts(),
        };
        byPeriodMap.set(periodKey, entry);
      }
      entry.total += n;
      if (asset) entry.byAsset[asset] += n;
      entry.bySource[source] += n;
    }

    const byPeriod = Array.from(byPeriodMap.values())
      .sort((a, b) => (b.year - a.year) || a.period.localeCompare(b.period));

    res.json({
      userId: targetRow.id,
      username: targetRow.username,
      displayName: targetRow.displayName,
      publicHandle: targetRow.publicHandle,
      total,
      totalsByAsset,
      totalsBySource,
      byPeriod,
    });
  } catch (err) {
    req.log?.error({ err, targetUserId }, "[recap-share-stats] per-player query failed");
    res.status(500).json({ error: "Failed to load player recap share stats" });
  }
});

// GET /admin/recap-share-stats.csv — Task #1866.
//
// Sibling of GET /admin/recap-share-stats. Reuses the same role gate and
// tenant-scoping helper so a downloaded report matches exactly what the
// admin sees on screen — never any data outside their tenant boundary.
//
// The data here is a small aggregate (totals + a topN list, max 50 rows)
// rather than a row-by-row dump, so we build the CSV body in memory and
// send it in one go — no need for the server-side cursor / streaming
// pattern that /admin/notification-audit.csv uses.
//
// Format: a multi-section CSV (each section a self-describing header +
// rows, separated by a blank line) so marketing teams can paste the file
// straight into Excel / Sheets and see clearly labelled sub-tables. The
// JSON endpoint's nested shape doesn't fit a single flat table, but
// every section is itself a well-formed RFC 4180 CSV block.
//
// Sections (in order):
//   1. summary      — scope, organization_id, top_n, total
//   2. by_asset     — one row per asset with its count
//   3. by_source    — one row per source with its count
//   4. by_period    — one row per (year, period) with totals + breakdowns
//   5. top_sharers  — one row per top-N player (rank, identifying fields,
//                     opens, total)
//
// Empty-scope (org_admin without an org / org with no users) still emits
// the section headers with zero data rows so downstream tooling that
// expects a file always gets a parsable one.
function setRecapShareStatsCsvHeaders(res: Response): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="recap-share-stats-${stamp}.csv"`,
  );
  // The export contains member identifying fields (display name, handle)
  // — never let an intermediary cache it.
  res.setHeader("Cache-Control", "no-store");
  res.status(200);
}

function buildAdminRecapShareStatsCsv(
  result: AdminRecapShareStatsResult,
  framing: { scope: "org" | "platform"; organizationId: number | null; topN: number },
): string {
  const parts: string[] = [];
  // Blank line between sections — `csvRow` already terminates each row
  // with CRLF, so a bare CRLF produces a one-row gap.
  const SECTION_GAP = "\r\n";

  parts.push(csvRow(["section", "scope", "organization_id", "top_n", "total"]));
  parts.push(csvRow([
    "summary",
    framing.scope,
    framing.organizationId ?? "",
    framing.topN,
    result.total,
  ]));
  parts.push(SECTION_GAP);

  parts.push(csvRow(["asset", "count"]));
  for (const a of ADMIN_RECAP_SHARE_ASSETS) {
    parts.push(csvRow([a, result.totalsByAsset[a]]));
  }
  parts.push(SECTION_GAP);

  parts.push(csvRow(["source", "count"]));
  for (const s of ADMIN_RECAP_SHARE_SOURCES_OUT) {
    parts.push(csvRow([s, result.totalsBySource[s]]));
  }
  parts.push(SECTION_GAP);

  parts.push(csvRow([
    "year", "period", "total",
    "card_png", "og",
    "copy", "web_share", "native_share", "qr_open", "crawler", "unknown",
  ]));
  for (const p of result.byPeriod) {
    parts.push(csvRow([
      p.year, p.period, p.total,
      p.byAsset.card_png, p.byAsset.og,
      p.bySource.copy, p.bySource.web_share, p.bySource.native_share,
      p.bySource.qr_open, p.bySource.crawler, p.bySource.unknown,
    ]));
  }
  parts.push(SECTION_GAP);

  parts.push(csvRow([
    "rank", "user_id", "username", "display_name", "public_handle",
    "opens", "total",
  ]));
  result.topPlayers.forEach((p, i) => {
    parts.push(csvRow([
      i + 1,
      p.userId,
      p.username ?? "",
      p.displayName ?? "",
      p.publicHandle ?? "",
      p.opens,
      p.total,
    ]));
  });

  return parts.join("");
}

router.get("/admin/recap-share-stats.csv", async (req: Request, res: Response) => {
  const parsed = await resolveAdminRecapShareStatsRequest(req, res);
  if (parsed.kind === "sent") return;
  try {
    // Build the body BEFORE flipping any response headers so a query
    // failure can still cleanly reply with a JSON 500 instead of half a
    // CSV file. The dataset is small (max ~10s of rows even in the
    // worst case) so in-memory build is fine.
    const stats = parsed.kind === "empty"
      ? emptyAdminRecapShareStatsResult()
      : await loadAdminRecapShareStats({
          orgUserIds: parsed.orgUserIds,
          topN: parsed.topN,
        });
    const body = buildAdminRecapShareStatsCsv(stats, {
      scope: parsed.scope,
      organizationId: parsed.organizationId,
      topN: parsed.topN,
    });
    setRecapShareStatsCsvHeaders(res);
    res.send(body);
  } catch (err) {
    req.log?.error({ err }, "[recap-share-stats.csv] query failed");
    res.status(500).json({ error: "Failed to export recap share stats CSV" });
  }
});

// GET /admin/swing-fps-probes/stats — Task #1709.
//
// Returns counts of `swing_video_fps_probes` rows grouped by status plus
// the oldest queued `next_attempt_at`, so operators can confirm a
// `backfill:swing-video-fps` enqueue has fully drained without dropping
// into psql. Restricted to org_admin / tournament_director / super_admin
// like every other diagnostics endpoint in this file — the queue is an
// internal pipeline and exposing the counts to players would leak
// per-tenant upload activity (the table is global, not org-scoped).
router.get("/admin/swing-fps-probes/stats", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const role = (req.user as { role?: string } | undefined)?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const stats = await getFpsProbeQueueStats();
    res.json(stats);
  } catch (err) {
    req.log?.error({ err }, "[admin/swing-fps-probes/stats] query failed");
    res.status(500).json({ error: "Failed to load swing-fps probe stats" });
  }
});

// GET /admin/stats
router.get("/admin/stats", async (req: Request, res: Response) => {
  const [totalOrgs] = await db.select({ count: count() }).from(organizationsTable);
  const [totalTournaments] = await db.select({ count: count() }).from(tournamentsTable);
  const [totalPlayers] = await db.select({ count: count() }).from(playersTable);
  const [totalUsers] = await db.select({ count: count() }).from(appUsersTable);
  const [activeT] = await db.select({ count: count() }).from(tournamentsTable).where(sql`${tournamentsTable.status} = 'active'`);

  res.json({
    totalOrganizations: Number(totalOrgs?.count ?? 0),
    totalTournaments: Number(totalTournaments?.count ?? 0),
    totalPlayers: Number(totalPlayers?.count ?? 0),
    totalUsers: Number(totalUsers?.count ?? 0),
    activeTournaments: Number(activeT?.count ?? 0),
  });
});

// ════════════════════════════════════════════════════════════════════
// Task #1733 — Admin per-event mute ops dashboard
//
// Surfaces every admin-only per-event opt-out column on
// `user_notification_prefs` in one place so a head-of-ops can see at a
// glance which alerts are currently silenced and by how many people in
// the org. Without this, the only way to audit an org's mute state was
// to ask each user to open `PortalCommPrefs.tsx`.
//
// Endpoints (all prefixed `/api/admin/event-mutes`):
//   GET  /                       → per-event mute counts (summary)
//   GET  /:id/users              → drill-down: which users are muted
//   POST /:id/restore-all        → bulk restore (set column = true)
//   GET  /audit-log              → recent `event_opted_out` audit rows
//
// Authorization mirrors `/admin/notification-audit`:
//   • super_admin → sees everyone (and may pass `?orgId=` to scope)
//   • org_admin   → scoped automatically to users in their org
//   • everyone else → 403
//
// Scoping is enforced by resolving the in-scope user-id set up front
// and pushing an `inArray(...)` filter into every read/write — same
// pattern Task #1172 uses for the audit feed so the boundary is
// uniform across both surfaces.
// ════════════════════════════════════════════════════════════════════

type EventMuteScope =
  | { kind: "sent" }
  | { kind: "empty" }
  | { kind: "all" }
  | { kind: "ids"; userIds: number[] };

async function resolveEventMuteScope(req: Request, res: Response): Promise<EventMuteScope> {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return { kind: "sent" };
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return { kind: "sent" };
  }
  // Optional org scoping for super_admins (lets a head-of-ops zoom into
  // a single club). org_admins ignore the override — their boundary is
  // always their own org.
  const rawOrg = req.query.orgId;
  const orgIdParam = typeof rawOrg === "string" ? rawOrg.trim() : "";
  let scopeOrgId: number | null = null;
  if (role === "org_admin") {
    scopeOrgId = user?.organizationId ?? null;
    if (!scopeOrgId) return { kind: "empty" };
  } else if (orgIdParam) {
    const parsed = parseStrictInt(orgIdParam);
    if (parsed === null || parsed <= 0) {
      res.status(400).json({ error: "orgId must be a positive integer" });
      return { kind: "sent" };
    }
    scopeOrgId = parsed;
  }
  if (scopeOrgId === null) {
    // super_admin with no org filter → see everyone
    return { kind: "all" };
  }
  // Resolve users in scope as the union of:
  //   • appUsers.organizationId = scopeOrgId   (primary org binding)
  //   • org_memberships.userId where organizationId = scopeOrgId
  // org_memberships covers committee/director users who belong to the
  // org without `appUsers.organizationId` being set, mirroring how the
  // notification-audit page enforces tenant boundaries.
  const [byOrg, byMembership] = await Promise.all([
    db.select({ id: appUsersTable.id }).from(appUsersTable)
      .where(eq(appUsersTable.organizationId, scopeOrgId)),
    db.select({ id: orgMembershipsTable.userId }).from(orgMembershipsTable)
      .where(eq(orgMembershipsTable.organizationId, scopeOrgId)),
  ]);
  const ids = new Set<number>();
  for (const r of byOrg) ids.add(r.id);
  for (const r of byMembership) ids.add(r.id);
  if (ids.size === 0) return { kind: "empty" };
  return { kind: "ids", userIds: Array.from(ids) };
}

router.get("/admin/event-mutes", async (req: Request, res: Response) => {
  const scope = await resolveEventMuteScope(req, res);
  if (scope.kind === "sent") return;

  const rows = ADMIN_EVENT_MUTE_REGISTRY.map(e => ({
    id: e.id,
    label: e.label,
    description: e.description,
    category: e.category,
    columnName: e.columnName,
    notificationKeys: e.notificationKeys,
  }));

  if (scope.kind === "empty") {
    res.json({
      totalUsersInScope: 0,
      events: rows.map(r => ({ ...r, mutedCount: 0 })),
    });
    return;
  }

  // Compute mute counts: count `user_notification_prefs` rows where the
  // column is `false`. A user with no row at all is treated as opted-in
  // (the column defaults to `true`) and so won't appear in any mute
  // count — which matches the dispatcher's behaviour.
  const totalUsersInScope = scope.kind === "ids"
    ? scope.userIds.length
    : Number((await db.select({ count: count() }).from(appUsersTable))[0]?.count ?? 0);

  // One small count query per registry entry, fanned out in parallel.
  // The total round-trip count is bounded by registry size (<= ~10) so
  // this is well inside our latency budget and avoids dynamic-select
  // typing gymnastics.
  const muteCounts = await Promise.all(
    ADMIN_EVENT_MUTE_REGISTRY.map(async (entry) => {
      const conds: SQL[] = [eq(entry.column, false)];
      if (scope.kind === "ids") {
        conds.push(inArray(userNotificationPrefsTable.userId, scope.userIds));
      }
      const [row] = await db
        .select({ count: count() })
        .from(userNotificationPrefsTable)
        .where(and(...conds));
      return Number(row?.count ?? 0);
    })
  );

  const events = rows.map((r, i) => ({ ...r, mutedCount: muteCounts[i] }));

  res.json({ totalUsersInScope, events });
});

router.get("/admin/event-mutes/audit-log", async (req: Request, res: Response) => {
  const scope = await resolveEventMuteScope(req, res);
  if (scope.kind === "sent") return;

  const limitRaw = (typeof req.query.limit === "string" ? req.query.limit : "50").trim();
  const limitParsed = parseStrictInt(limitRaw);
  if (limitParsed === null) {
    res.status(400).json({ error: "limit must be an integer" });
    return;
  }
  const limitNum = Math.min(200, Math.max(1, limitParsed));

  const keys = adminEventNotificationKeys();

  if (scope.kind === "empty" || keys.length === 0) {
    res.json({ entries: [], limit: limitNum });
    return;
  }

  const conds: SQL[] = [
    inArray(notificationAuditLogTable.notificationKey, keys),
    eq(notificationAuditLogTable.reason, "event_opted_out"),
  ];
  if (scope.kind === "ids") {
    conds.push(inArray(notificationAuditLogTable.userId, scope.userIds));
  }

  const rows = await db
    .select({
      id: notificationAuditLogTable.id,
      notificationKey: notificationAuditLogTable.notificationKey,
      userId: notificationAuditLogTable.userId,
      channel: notificationAuditLogTable.channel,
      status: notificationAuditLogTable.status,
      reason: notificationAuditLogTable.reason,
      createdAt: notificationAuditLogTable.createdAt,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
    })
    .from(notificationAuditLogTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, notificationAuditLogTable.userId))
    .where(and(...conds))
    .orderBy(desc(notificationAuditLogTable.createdAt), desc(notificationAuditLogTable.id))
    .limit(limitNum);

  res.json({
    entries: rows.map(r => ({
      id: r.id,
      notificationKey: r.notificationKey,
      userId: r.userId,
      userDisplayName: r.displayName ?? null,
      username: r.username ?? null,
      userEmail: r.email ?? null,
      channel: r.channel,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt,
    })),
    limit: limitNum,
  });
});

router.get("/admin/event-mutes/:id/users", async (req: Request, res: Response) => {
  const entry = getAdminEventMuteEntry(String((req.params as Record<string, string>).id ?? ""));
  if (!entry) {
    res.status(404).json({ error: "Unknown event-mute id" });
    return;
  }
  const scope = await resolveEventMuteScope(req, res);
  if (scope.kind === "sent") return;
  if (scope.kind === "empty") {
    res.json({
      id: entry.id,
      label: entry.label,
      users: [],
    });
    return;
  }

  const conds: SQL[] = [eq(entry.column, false)];
  if (scope.kind === "ids") {
    conds.push(inArray(userNotificationPrefsTable.userId, scope.userIds));
  }

  const rows = await db
    .select({
      userId: userNotificationPrefsTable.userId,
      updatedAt: userNotificationPrefsTable.updatedAt,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
      role: appUsersTable.role,
      organizationId: appUsersTable.organizationId,
    })
    .from(userNotificationPrefsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, userNotificationPrefsTable.userId))
    .where(and(...conds))
    .orderBy(appUsersTable.displayName, appUsersTable.username);

  res.json({
    id: entry.id,
    label: entry.label,
    users: rows.map(r => ({
      userId: r.userId,
      username: r.username,
      displayName: r.displayName,
      email: r.email,
      role: r.role,
      organizationId: r.organizationId,
      mutedAt: r.updatedAt,
    })),
  });
});

// Task #2178 — per-user variant of `/restore-all`. The bulk endpoint
// is the right tool for a staffing handover; this one closes the gap
// when only a single person needs to be un-muted (e.g. a coach back
// from leave). Same auth/scope guarantees as the rest of the family —
// org_admin can only restore users in their own org, super_admin can
// reach across orgs.
//
// Body: { userId: number }
//
// Out-of-scope target → response is `{ restored: 0 }` rather than 403,
// for symmetry with restore-all (which silently reports 0 when an org
// has nothing to flip). That keeps the endpoint from leaking which
// user-ids belong to other orgs while still being honest that no row
// changed.
router.post("/admin/event-mutes/:id/restore-user", async (req: Request, res: Response) => {
  const entry = getAdminEventMuteEntry(String((req.params as Record<string, string>).id ?? ""));
  if (!entry) {
    res.status(404).json({ error: "Unknown event-mute id" });
    return;
  }

  const body = (req.body ?? {}) as { userId?: unknown };
  let targetUserId: number | null = null;
  if (typeof body.userId === "number" && Number.isInteger(body.userId) && body.userId > 0) {
    targetUserId = body.userId;
  } else if (typeof body.userId === "string") {
    const parsed = parseStrictInt(body.userId.trim());
    if (parsed !== null && parsed > 0) targetUserId = parsed;
  }
  if (targetUserId === null) {
    res.status(400).json({ error: "userId is required and must be a positive integer" });
    return;
  }

  const scope = await resolveEventMuteScope(req, res);
  if (scope.kind === "sent") return;
  if (scope.kind === "empty") {
    res.json({ restored: 0, id: entry.id, userId: targetUserId });
    return;
  }
  if (scope.kind === "ids" && !scope.userIds.includes(targetUserId)) {
    res.json({ restored: 0, id: entry.id, userId: targetUserId });
    return;
  }

  try {
    // See restore-all above for why we use sql.identifier on the SET
    // side and the column reference on the WHERE side. Adding `AND
    // user_id = ${targetUserId}` narrows the same UPDATE to a single
    // row, and RETURNING tells us whether it was already true (0) or
    // genuinely flipped from false → true (1).
    const colIdent = sql.identifier(entry.columnName);
    const result = await db.execute(sql`
      UPDATE user_notification_prefs
      SET ${colIdent} = true, updated_at = NOW()
      WHERE ${entry.column} = false AND user_id = ${targetUserId}
      RETURNING user_id
    `);
    res.json({ restored: result.rowCount ?? 0, id: entry.id, userId: targetUserId });
  } catch (err) {
    console.error("[admin/event-mutes restore-user]", err);
    res.status(500).json({ error: "Failed to restore mute" });
  }
});

router.post("/admin/event-mutes/:id/restore-all", async (req: Request, res: Response) => {
  const entry = getAdminEventMuteEntry(String((req.params as Record<string, string>).id ?? ""));
  if (!entry) {
    res.status(404).json({ error: "Unknown event-mute id" });
    return;
  }
  const scope = await resolveEventMuteScope(req, res);
  if (scope.kind === "sent") return;
  if (scope.kind === "empty") {
    res.json({ restored: 0, id: entry.id });
    return;
  }
  try {

  // Only flip rows that are currently `false`. Counting before/after
  // would require two reads; instead let the UPDATE...RETURNING report
  // exactly which rows changed so the response count matches reality
  // even if another admin restored the same user concurrently.
  // We build the UPDATE in raw SQL because Drizzle's `.set()` keys must
  // be the *JS field names* on the schema object, but our registry only
  // stores the snake_case DB column name (the field-name → column-ref
  // map isn't available at runtime). Using the `entry.column`
  // `PgColumn` reference for both the WHERE and the SET clause keeps
  // us safe from string injection while staying on the right column,
  // and lets PG report (via RETURNING) exactly which rows changed so
  // the response count matches reality even if another admin restored
  // the same user concurrently.
  // sql.identifier renders just `"col"` (no table prefix), which is
  // what UPDATE ... SET requires on the left-hand side. The WHERE side
  // can use the column reference directly because Postgres allows
  // table-qualified names in WHERE clauses.
  const colIdent = sql.identifier(entry.columnName);
  const scopeFilter = scope.kind === "ids"
    ? sql` AND ${inArray(userNotificationPrefsTable.userId, scope.userIds)}`
    : sql``;
  const result = await db.execute(sql`
    UPDATE user_notification_prefs
    SET ${colIdent} = true, updated_at = NOW()
    WHERE ${entry.column} = false${scopeFilter}
    RETURNING user_id
  `);
  res.json({ restored: result.rowCount ?? 0, id: entry.id });
  } catch (err) {
    console.error("[admin/event-mutes restore-all]", err);
    res.status(500).json({ error: "Failed to restore mutes" });
  }
});

// GET /admin/event-mutes/trend — Task #2177.
//
// Daily count of `notification_audit_log` rows where
// `reason = 'event_opted_out'` for each admin-event mute entry, over the
// last `days` days (default 30, max 90). Powers the per-event sparkline
// on the ops dashboard plus the larger 90-day chart in the drill-down.
//
// Scoping mirrors the sibling endpoints:
//   • super_admin → all rows (and may pass `?orgId=` to scope to one club)
//   • org_admin   → users in their own org
//
// Query params:
//   • days  — 1..90 (default 30)
//   • id    — optional registry id; when set, returns just that one
//             event's series (used by the drill-down 90-day chart)
//   • orgId — super-admin only, mirrors the summary endpoint
//
// Response shape:
//   {
//     sinceDays: 30,
//     days: ["YYYY-MM-DD", ..., "YYYY-MM-DD"],   // UTC, oldest-first, length = sinceDays
//     events: [
//       { id: "wallet_refund_digest_failed", counts: number[], total: number },
//       ...
//     ]
//   }
//
// `days` array is always fully populated (zero-filled where no audit
// rows exist) so the chart's x-axis tick spacing is deterministic
// regardless of activity. Two registry entries that share the same
// notification key (e.g. the email + push erasure-storage entries) get
// the same trend — same dispatcher key, same audit row.
router.get("/admin/event-mutes/trend", async (req: Request, res: Response) => {
  const scope = await resolveEventMuteScope(req, res);
  if (scope.kind === "sent") return;

  const daysRaw = Number(req.query.days);
  const sinceDays = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 90
    ? Math.floor(daysRaw)
    : 30;

  const idParam = typeof req.query.id === "string" ? req.query.id.trim() : "";
  let entries: readonly AdminEventMuteEntry[] = ADMIN_EVENT_MUTE_REGISTRY;
  if (idParam) {
    const single = getAdminEventMuteEntry(idParam);
    if (!single) {
      res.status(404).json({ error: "Unknown event-mute id" });
      return;
    }
    entries = [single];
  }

  // Build the deterministic UTC day list, oldest-first, ending today.
  // The query window starts at midnight UTC `sinceDays - 1` days ago so
  // today's partial day is included as the final bucket.
  const todayUtc = new Date();
  const startUtc = new Date(Date.UTC(
    todayUtc.getUTCFullYear(),
    todayUtc.getUTCMonth(),
    todayUtc.getUTCDate() - (sinceDays - 1),
  ));
  const days: string[] = [];
  for (let i = 0; i < sinceDays; i++) {
    const d = new Date(startUtc);
    d.setUTCDate(startUtc.getUTCDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < days.length; i++) dayIndex.set(days[i], i);

  // Empty scope → respond with the zero-filled skeleton so the client
  // chart still renders an axis instead of "no data".
  if (scope.kind === "empty" || entries.length === 0) {
    res.json({
      sinceDays,
      days,
      events: entries.map(e => ({
        id: e.id,
        counts: new Array(sinceDays).fill(0),
        total: 0,
      })),
    });
    return;
  }

  // Union of every dispatcher key we care about — feeds an `IN (...)`
  // filter so a single SELECT returns every event's daily counts.
  const keySet = new Set<string>();
  for (const e of entries) for (const k of e.notificationKeys) keySet.add(k);
  const keys = Array.from(keySet);

  const conds: SQL[] = [
    inArray(notificationAuditLogTable.notificationKey, keys),
    eq(notificationAuditLogTable.reason, "event_opted_out"),
    gte(notificationAuditLogTable.createdAt, startUtc),
  ];
  if (scope.kind === "ids") {
    conds.push(inArray(notificationAuditLogTable.userId, scope.userIds));
  }

  // One aggregate per (day, notificationKey). We bucket via
  // `to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD')` so the bucket label
  // matches the JS-side ISO day string exactly.
  const dayExpr = sql<string>`to_char(${notificationAuditLogTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day: dayExpr,
      notificationKey: notificationAuditLogTable.notificationKey,
      n: count(),
    })
    .from(notificationAuditLogTable)
    .where(and(...conds))
    .groupBy(dayExpr, notificationAuditLogTable.notificationKey);

  // Index counts by (notificationKey → day → n) for fan-out into each
  // entry's series. A registry entry can list multiple keys, in which
  // case its day-bucket value is the sum across them.
  const byKeyDay = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const dayKey = String(r.day);
    if (!dayIndex.has(dayKey)) continue;  // outside window (defensive)
    const inner = byKeyDay.get(r.notificationKey) ?? new Map<string, number>();
    inner.set(dayKey, (inner.get(dayKey) ?? 0) + Number(r.n));
    byKeyDay.set(r.notificationKey, inner);
  }

  const events = entries.map(entry => {
    const counts = new Array<number>(sinceDays).fill(0);
    let total = 0;
    for (const k of entry.notificationKeys) {
      const inner = byKeyDay.get(k);
      if (!inner) continue;
      for (const [day, n] of inner.entries()) {
        const idx = dayIndex.get(day);
        if (idx === undefined) continue;
        counts[idx] += n;
        total += n;
      }
    }
    return { id: entry.id, counts, total };
  });

  res.json({ sinceDays, days, events });
});

// ─── Task #1854 — exhausted notify retries dashboard ──────────────────
//
// Surfaces the same wallet-refund / coach-payout-account-change
// exhausted-retry data the Task #1507 cron emails as a daily admin
// digest, so admins can:
//
//   • see currently-exhausted rows without waiting for tomorrow's email,
//   • see whether each row has already been included in a digest, and
//   • manually re-trigger a notification for a single row (the
//     "Resend now" action below clears the exhaustion stamps and
//     re-runs the channel-specific retry helper, mirroring the
//     Task #1542 ops-alert drill-down's semantics).
//
// Tenant scoping mirrors `/admin/notify-exhaustion-history`:
// super_admin sees the platform-wide pool; org_admin /
// tournament_director are pinned to their own org so they cannot
// enumerate or act on another club's rows.

// GET /admin/notify-failures — list rows where email or push retry is exhausted.
router.get("/admin/notify-failures", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  let orgScope: number | null;
  if (role === "super_admin") {
    orgScope = null;
  } else {
    const oid = user?.organizationId;
    if (typeof oid !== "number") {
      // An org-bound admin without an org is a misconfiguration —
      // empty out their view rather than silently widening it to all
      // clubs.
      res.json({ rows: [], limit: 0 });
      return;
    }
    orgScope = oid;
  }

  const rawLimit = Number.parseInt(String(req.query.limit ?? "200"), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

  try {
    const rows = await listExhaustedAdminNotifyRows({
      organizationId: orgScope,
      limit,
    });
    res.json({ rows, limit });
  } catch (err) {
    req.log?.error({ err }, "[notify-failures] query failed");
    res.status(500).json({ error: "Failed to load exhausted notify rows" });
  }
});

// POST /admin/notify-failures/resend — clear exhaustion stamps + re-dispatch.
//
// Body: { pipeline: "wallet_refund" | "coach_payout_account_change",
//         attemptId: number }
router.post("/admin/notify-failures/resend", async (req: Request, res: Response) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role !== "org_admin" && role !== "tournament_director" && role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  let orgScope: number | null;
  if (role === "super_admin") {
    orgScope = null;
  } else {
    const oid = user?.organizationId;
    if (typeof oid !== "number") {
      // Misconfigured org-bound admin — refuse rather than silently
      // running the action against the platform-wide pool.
      res.status(404).json({ error: "Attempt not found" }); return;
    }
    orgScope = oid;
  }

  const body = (req.body ?? {}) as { pipeline?: unknown; attemptId?: unknown };
  const pipelineRaw = String(body.pipeline ?? "");
  const attemptIdRaw = body.attemptId;
  if (
    pipelineRaw !== "wallet_refund"
    && pipelineRaw !== "coach_payout_account_change"
  ) {
    res.status(400).json({ error: "Invalid pipeline" }); return;
  }
  const attemptId = typeof attemptIdRaw === "number"
    ? attemptIdRaw
    : Number.parseInt(String(attemptIdRaw ?? ""), 10);
  if (!Number.isFinite(attemptId) || attemptId <= 0) {
    res.status(400).json({ error: "Invalid attemptId" }); return;
  }

  try {
    const result = await resendExhaustedAdminNotifyRow({
      pipeline: pipelineRaw as AdminNotifyFailurePipeline,
      attemptId,
      organizationId: orgScope,
    });
    if (!result.ok) {
      res.status(404).json({ error: "Attempt not found" }); return;
    }
    res.json({
      pipeline: result.pipeline,
      attemptId: result.attemptId,
      outcomes: result.outcomes,
    });
  } catch (err) {
    req.log?.error({ err }, "[notify-failures.resend] action failed");
    res.status(500).json({ error: "Failed to resend exhausted notify row" });
  }
});

export default router;
