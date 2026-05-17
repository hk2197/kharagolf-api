/**
 * Task #1296 — Coverage for the Stripe webhook failure-reason audit.
 *
 * Task #1126 added the `error_reason` column on `stripe_webhook_deliveries`
 * and made `recordDelivery` populate it for every non-2xx response. The
 * admin Communications panel surfaces this so ops can spot misrouted /
 * mis-signed deliveries without grepping logs. These tests pin the column
 * so a future refactor of `POST /api/webhooks/stripe` cannot silently
 * regress the admin visibility.
 *
 * Each failure path POSTs an event and asserts the resulting deliveries
 * row has the documented `response_status` + `error_reason`:
 *   - missing_secret      (NODE_ENV=production, secret unset → 503)
 *   - missing_header      (secret set, no signature header → 401)
 *   - missing_body        (secret set, no raw body buffer  → 400)
 *   - signature_mismatch  (secret set, wrong signature    → 401)
 *   - reconciliation_failed (handler throws mid-flight    → 500)
 *
 * The two 2xx paths (successful settlement + ignored event) assert
 * `error_reason IS NULL` so the column never leaks a stale failure
 * reason onto a successful delivery.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express, { type Request } from "express";
import request from "supertest";
import { createHmac } from "crypto";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  tournamentsTable,
  playersTable,
  stripeWebhookDeliveriesTable,
} from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";

const checkoutMock = vi.hoisted(() => ({
  recordCheckoutSettlement: vi.fn(async () => undefined),
}));
vi.mock("../lib/checkout", async () => {
  const actual = await vi.importActual<typeof import("../lib/checkout.js")>("../lib/checkout.js");
  return {
    ...actual,
    recordCheckoutSettlement: checkoutMock.recordCheckoutSettlement,
  };
});

// Silence outbound side-effects (email/push) so failure-path tests don't
// fall over because SMTP / object storage isn't wired in CI.
vi.mock("../lib/paymentReceipts", () => ({
  sendShopOrderReceiptEmail: vi.fn(async () => undefined),
  sendDuesReceiptEmail: vi.fn(async () => undefined),
  sendReceiptEmail: vi.fn(async () => undefined),
  currencySymbol: (c: string) => (c === "INR" ? "₹" : c),
}));
vi.mock("../lib/notifications", async () => {
  const actual = await vi.importActual<typeof import("../lib/notifications.js")>("../lib/notifications.js");
  return {
    ...actual,
    notifyPaymentSettled: vi.fn(async () => undefined),
  };
});

import router from "../routes/index.js";

const WEBHOOK_SECRET = "whsec_test_t1296";

function buildApp(captureRawBody: boolean) {
  const app = express();
  if (captureRawBody) {
    app.use(express.json({
      verify: (req: Request, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }));
  } else {
    app.use(express.json());
  }
  app.use("/api", router);
  return app;
}

const app = buildApp(true);
const appNoRaw = buildApp(false);

let prevNodeEnv: string | undefined;
let prevWebhookSecret: string | undefined;

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdEventIds: string[] = [];

function uniqueEventId(label: string): string {
  const id = `evt_t1296_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  createdEventIds.push(id);
  return id;
}

function buildPaymentIntentEvent(opts: {
  eventId: string;
  paymentIntentId: string;
  amountMinor: number;
  currency?: string;
  metadata?: Record<string, string>;
}) {
  return {
    id: opts.eventId,
    type: "payment_intent.succeeded",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.paymentIntentId,
        object: "payment_intent",
        amount_received: opts.amountMinor,
        amount: opts.amountMinor,
        currency: (opts.currency ?? "USD").toLowerCase(),
        metadata: opts.metadata ?? {},
      },
    },
  };
}

function buildIgnoredEvent(eventId: string) {
  // `customer.created` is not in the handler's switchlist, so it falls
  // through the "unhandled event" branch and returns 200 with no error.
  return {
    id: eventId,
    type: "customer.created",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: `cus_${Math.random().toString(36).slice(2, 10)}` } },
  };
}

function signStripeBody(body: string, secret: string, ts = Math.floor(Date.now() / 1000)) {
  const payload = `${ts}.${body}`;
  const v1 = createHmac("sha256", secret).update(payload).digest("hex");
  return `t=${ts},v1=${v1}`;
}

async function fetchDelivery(eventId: string) {
  const [row] = await db.select()
    .from(stripeWebhookDeliveriesTable)
    .where(eq(stripeWebhookDeliveriesTable.eventId, eventId))
    .orderBy(desc(stripeWebhookDeliveriesTable.id))
    .limit(1);
  return row;
}

async function setupPlayerForReconciliation(opts: { paymentIntentId: string }) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `T1296 Org ${suffix}`,
    slug: `t1296-${suffix}`,
  }).returning();
  createdOrgIds.push(org.id);

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `t1296-${suffix}`,
    username: `t1296_user_${suffix}`,
    role: "player",
  }).returning();
  createdUserIds.push(user.id);

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: org.id,
    name: `T1296 Tournament ${suffix}`,
    entryFee: "50.00",
    currency: "USD",
  }).returning();

  const [player] = await db.insert(playersTable).values({
    tournamentId: tournament.id,
    userId: user.id,
    firstName: "Recon",
    lastName: "Failure",
    email: `recon_${suffix}@example.com`,
    paymentStatus: "unpaid",
    razorpayOrderId: opts.paymentIntentId,
  }).returning();

  return { org, user, tournament, player };
}

beforeAll(() => {
  prevNodeEnv = process.env.NODE_ENV;
  prevWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
});

afterAll(async () => {
  if (createdEventIds.length > 0) {
    await db.delete(stripeWebhookDeliveriesTable)
      .where(inArray(stripeWebhookDeliveriesTable.eventId, createdEventIds));
  }
  if (createdOrgIds.length > 0) {
    // tournaments + players cascade off organizations.
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }

  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  if (prevWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = prevWebhookSecret;
});

beforeEach(() => {
  checkoutMock.recordCheckoutSettlement.mockReset();
  checkoutMock.recordCheckoutSettlement.mockImplementation(async () => undefined);
});

describe("POST /api/webhooks/stripe — failure-reason audit (Task #1296 / #1126)", () => {
  it("records error_reason='missing_secret' when the secret is unset in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const eventId = uniqueEventId("missing_secret");
    const event = buildPaymentIntentEvent({
      eventId,
      paymentIntentId: `pi_${eventId}`,
      amountMinor: 5000,
    });

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(503);
    const row = await fetchDelivery(eventId);
    expect(row).toBeDefined();
    expect(row.responseStatus).toBe(503);
    expect(row.errorReason).toBe("missing_secret");
    expect(row.applied).toBe(false);
    // Signature check was skipped because we never reached it.
    expect(row.signatureValid).toBeNull();
  });

  it("records error_reason='missing_header' when the signature header is absent", async () => {
    process.env.NODE_ENV = "test";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const eventId = uniqueEventId("missing_header");
    const event = buildPaymentIntentEvent({
      eventId,
      paymentIntentId: `pi_${eventId}`,
      amountMinor: 5000,
    });

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(401);
    const row = await fetchDelivery(eventId);
    expect(row).toBeDefined();
    expect(row.responseStatus).toBe(401);
    expect(row.errorReason).toBe("missing_header");
    expect(row.applied).toBe(false);
    expect(row.signatureValid).toBe(false);
  });

  it("records error_reason='missing_body' when the raw body buffer is unavailable", async () => {
    process.env.NODE_ENV = "test";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const eventId = uniqueEventId("missing_body");
    const event = buildPaymentIntentEvent({
      eventId,
      paymentIntentId: `pi_${eventId}`,
      amountMinor: 5000,
    });
    const body = JSON.stringify(event);
    // Use the appNoRaw app so req.rawBody is undefined even though we're
    // sending a parsed JSON body — mirrors the failure mode we hit if the
    // verify hook is ever removed from app.ts.
    const sigHeader = signStripeBody(body, WEBHOOK_SECRET);

    const res = await request(appNoRaw)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", sigHeader)
      .send(event);

    expect(res.status).toBe(400);
    const row = await fetchDelivery(eventId);
    expect(row).toBeDefined();
    expect(row.responseStatus).toBe(400);
    expect(row.errorReason).toBe("missing_body");
    expect(row.applied).toBe(false);
    expect(row.signatureValid).toBe(false);
  });

  it("records error_reason='signature_mismatch' when the signature does not verify", async () => {
    process.env.NODE_ENV = "test";
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const eventId = uniqueEventId("signature_mismatch");
    const event = buildPaymentIntentEvent({
      eventId,
      paymentIntentId: `pi_${eventId}`,
      amountMinor: 5000,
    });
    const body = JSON.stringify(event);
    // Sign with a *different* secret so verification fails.
    const sigHeader = signStripeBody(body, "whsec_wrong_secret_t1296");

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", sigHeader)
      .send(event);

    expect(res.status).toBe(401);
    const row = await fetchDelivery(eventId);
    expect(row).toBeDefined();
    expect(row.responseStatus).toBe(401);
    expect(row.errorReason).toBe("signature_mismatch");
    expect(row.applied).toBe(false);
    expect(row.signatureValid).toBe(false);
  });

  it("records error_reason='reconciliation_failed' when the handler throws mid-flight", async () => {
    // Use the dev path so we don't have to forge a signature for the
    // event to reach the reconciliation block.
    process.env.NODE_ENV = "development";
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const eventId = uniqueEventId("reconciliation_failed");
    const paymentIntentId = `pi_${eventId}`;

    await setupPlayerForReconciliation({ paymentIntentId });

    // Force the FX-ledger writer to blow up — the outer try/catch in
    // the handler converts that into a 500 + reconciliation_failed.
    checkoutMock.recordCheckoutSettlement.mockImplementationOnce(async () => {
      throw new Error("forced failure for reconciliation_failed test");
    });

    const event = buildPaymentIntentEvent({
      eventId,
      paymentIntentId,
      amountMinor: 5000,
      currency: "USD",
    });

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(500);
    expect(checkoutMock.recordCheckoutSettlement).toHaveBeenCalledTimes(1);

    const row = await fetchDelivery(eventId);
    expect(row).toBeDefined();
    expect(row.responseStatus).toBe(500);
    expect(row.errorReason).toBe("reconciliation_failed");
    expect(row.applied).toBe(false);
    // Dev path skipped signature verification → null, not false.
    expect(row.signatureValid).toBeNull();
  });

  it("records error_reason=NULL on a successful applied settlement", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const eventId = uniqueEventId("success_applied");
    const paymentIntentId = `pi_${eventId}`;

    await setupPlayerForReconciliation({ paymentIntentId });

    const event = buildPaymentIntentEvent({
      eventId,
      paymentIntentId,
      amountMinor: 5000,
      currency: "USD",
    });

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true });

    const row = await fetchDelivery(eventId);
    expect(row).toBeDefined();
    expect(row.responseStatus).toBe(200);
    expect(row.applied).toBe(true);
    expect(row.errorReason).toBeNull();
  });

  it("records error_reason=NULL on an unhandled / ignored event type", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const eventId = uniqueEventId("ignored");
    const event = buildIgnoredEvent(eventId);

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: true });

    const row = await fetchDelivery(eventId);
    expect(row).toBeDefined();
    expect(row.responseStatus).toBe(200);
    expect(row.applied).toBe(false);
    expect(row.errorReason).toBeNull();
  });
});
