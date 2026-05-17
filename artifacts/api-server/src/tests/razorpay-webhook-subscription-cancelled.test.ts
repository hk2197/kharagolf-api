/**
 * Task #1904 — Razorpay-side parity coverage for the paid-plan
 * cancellation alert wired up in Task #1539.
 *
 * The Stripe `customer.subscription.deleted` branch already has
 * stripe-webhook-subscription-cancelled.test.ts asserting that:
 *   - the org is downgraded to free + cancelled,
 *   - org admins receive a confirmation email (Task #1540), and
 *   - super admins receive the realtime email + push only when the org
 *     was on a paid tier (Task #1539).
 *
 * `routes/onboarding.ts` mirrors all three behaviours in its
 * `subscription.cancelled` branch, but until now Razorpay parity was
 * verified only by inspection. This file exercises that branch end-to-end
 * with a signed `subscription.cancelled` event so a regression on the
 * Razorpay side cannot silently re-introduce the original churn-blindness
 * gap.
 *
 * Mocks `sendPlanMigrationDigestEmail`, `sendTransactionalPush`, and
 * `sendBroadcastEmail` the same way the Stripe sibling does so the
 * assertions stay tight and the tests don't depend on a live mailer / push
 * provider. The Razorpay route requires a webhook secret + valid HMAC, so
 * each request is signed with the same crypto used by the route.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Mocks must be declared before importing the route under test.
vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendBroadcastEmail: vi.fn(async () => undefined),
    sendPlanMigrationDigestEmail: vi.fn(async () => undefined),
  };
});

vi.mock("../lib/comms.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/comms.js")>("../lib/comms.js");
  return {
    ...actual,
    sendTransactionalPush: vi.fn(async () => ({ attempted: 1, sent: 1, failed: 0, invalid: 0 })),
  };
});

import crypto from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  memberAuditLogTable,
  appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import router from "../routes/index.js";
import { sendBroadcastEmail, sendPlanMigrationDigestEmail } from "../lib/mailer.js";
import { sendTransactionalPush } from "../lib/comms.js";
import { _resetPlanMigrationDigestDedupForTest } from "../lib/planMigrationDigest.js";
import { uid } from "./helpers.js";

const sendBroadcastEmailMock = vi.mocked(sendBroadcastEmail);
const emailMock = vi.mocked(sendPlanMigrationDigestEmail);
const pushMock = vi.mocked(sendTransactionalPush);

const WEBHOOK_SECRET = "task1904_razorpay_secret";

/**
 * The Razorpay subscription webhook (unlike the Stripe webhook) has no
 * dev-mode signature bypass — it always recomputes the HMAC against the
 * raw request bytes. Mirror app.ts so `req.rawBody` is populated and the
 * route's verification sees the exact bytes supertest sent.
 */
function buildWebhookApp() {
  const app = express();
  app.use(
    express.json({
      verify: (req: Request, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use("/api", router);
  return app;
}

const app = buildWebhookApp();

let orgId: number;
let adminUserId: number;
let legacyAdminUserId: number;
let superAdminUserId: number;
const ADMIN_EMAIL = "task1904-membership-admin@example.com";
const LEGACY_ADMIN_EMAIL = "task1904-legacy-admin@example.com";
const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

let prevWebhookSecret: string | undefined;

beforeAll(async () => {
  prevWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

  const slug = uid("rzp-sub-cancel");
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg ${slug}`,
    slug,
    subscriptionTier: "pro",
    subscriptionStatus: "active",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  createdOrgIds.push(orgId);

  // Seed an org admin via org_memberships (the modern path).
  const [adminUser] = await db.insert(appUsersTable).values({
    replitUserId: `task1904-membership-${slug}`,
    username: `task1904-membership-${slug}`,
    email: ADMIN_EMAIL,
    displayName: "Membership Admin",
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  adminUserId = adminUser.id;
  createdUserIds.push(adminUserId);
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: adminUserId,
    role: "org_admin",
  });

  // Seed a second admin via the legacy `app_users.role` + `organization_id`
  // path so we exercise the dual-source recipient resolver in
  // notifyOrgAdminsOfPlanCancellation (mirrors the Stripe sibling test).
  const [legacyAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `task1904-legacy-${slug}`,
    username: `task1904-legacy-${slug}`,
    email: LEGACY_ADMIN_EMAIL,
    displayName: "Legacy Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  legacyAdminUserId = legacyAdmin.id;
  createdUserIds.push(legacyAdminUserId);

  // A super_admin so the realtime fan-out (Task #1539) has at least one
  // recipient when the paid-plan cancellation alert fires.
  const [superAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_su`,
    username: `su_${slug}`,
    email: `su_${slug}@example.com`,
    displayName: "Super A",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminUserId = superAdmin.id;
  createdUserIds.push(superAdminUserId);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
  if (prevWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
  else process.env.RAZORPAY_WEBHOOK_SECRET = prevWebhookSecret;
});

beforeEach(async () => {
  emailMock.mockClear();
  pushMock.mockClear();
  sendBroadcastEmailMock.mockClear();
  await _resetPlanMigrationDigestDedupForTest();
  // Reset to a paid, active state with a known Razorpay subscription id +
  // pending upgrade before each case so cancellation has something
  // meaningful to revert.
  await db.update(organizationsTable)
    .set({
      subscriptionTier: "pro",
      subscriptionStatus: "active",
      pendingSubscriptionTier: "enterprise",
      razorpaySubscriptionId: "sub_task1904_seed",
      updatedAt: new Date(),
    })
    .where(eq(organizationsTable.id, orgId));
  // Wipe any prior migrate audit rows from previous tests on this org so
  // each Task #1539 case asserts cleanly against the alert-side audit row.
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, "organization_subscription_tier"),
    eq(memberAuditLogTable.action, "migrate"),
  ));
});

interface CancelledEventOpts {
  organizationId?: string;
  subscriptionId?: string;
}

function buildCancelledEvent(opts: CancelledEventOpts = {}) {
  const subscriptionId = opts.subscriptionId ?? `sub_${Math.random().toString(36).slice(2, 10)}`;
  const notes: Record<string, string> = {};
  if (opts.organizationId !== undefined) notes.organizationId = opts.organizationId;
  return {
    event: "subscription.cancelled",
    payload: {
      subscription: {
        entity: {
          id: subscriptionId,
          status: "cancelled",
          notes,
        },
      },
    },
  };
}

interface FailedEventOpts {
  /** Razorpay event type — `subscription.halted` carries only a subscription
   *  entity, `payment.failed` carries a payment entity with the failure
   *  description. The route handles both. */
  event: "subscription.halted" | "payment.failed";
  organizationId?: string;
  subscriptionId?: string;
  errorDescription?: string | null;
}

function buildFailedEvent(opts: FailedEventOpts) {
  const subscriptionId = opts.subscriptionId ?? `sub_${Math.random().toString(36).slice(2, 10)}`;
  const notes: Record<string, string> = {};
  if (opts.organizationId !== undefined) notes.organizationId = opts.organizationId;

  if (opts.event === "subscription.halted") {
    return {
      event: "subscription.halted",
      payload: {
        subscription: {
          entity: { id: subscriptionId, status: "halted", notes },
        },
      },
    };
  }
  // payment.failed
  return {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: `pay_${Math.random().toString(36).slice(2, 10)}`,
          status: "failed",
          subscription_id: subscriptionId,
          notes,
          error_description: opts.errorDescription ?? null,
        },
      },
    },
  };
}

function postSigned(event: unknown) {
  const body = JSON.stringify(event);
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  return request(app)
    .post("/api/onboarding/subscribe/webhook")
    .set("Content-Type", "application/json")
    .set("x-razorpay-signature", signature)
    .send(body);
}

describe("POST /api/onboarding/subscribe/webhook — subscription.cancelled DB sync (Task #1904 / mirrors #1309)", () => {
  it("downgrades the org to free + cancelled when Razorpay reports the subscription cancelled", async () => {
    const res = await postSigned(buildCancelledEvent({ organizationId: String(orgId) }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    const [org] = await db.select({
      tier: organizationsTable.subscriptionTier,
      status: organizationsTable.subscriptionStatus,
      pending: organizationsTable.pendingSubscriptionTier,
      rzpSubId: organizationsTable.razorpaySubscriptionId,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("free");
    expect(org.status).toBe("cancelled");
    // Any pending upgrade and the stored Razorpay subscription id should be
    // cleared too, mirroring the route's UPDATE.
    expect(org.pending).toBeNull();
    expect(org.rzpSubId).toBeNull();
  });

  it("acknowledges and skips cancelled events without an organizationId in notes", async () => {
    const res = await postSigned(buildCancelledEvent({}));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    const [org] = await db.select({
      tier: organizationsTable.subscriptionTier,
      status: organizationsTable.subscriptionStatus,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    // Untouched — still the beforeEach-reset paid state.
    expect(org.tier).toBe("pro");
    expect(org.status).toBe("active");
  });

  it("acknowledges and skips cancelled events whose organizationId does not match a known org", async () => {
    const res = await postSigned(buildCancelledEvent({ organizationId: "999999999" }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    const [org] = await db.select({
      tier: organizationsTable.subscriptionTier,
      status: organizationsTable.subscriptionStatus,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    // The seeded org is untouched; the unknown org id matches no rows.
    expect(org.tier).toBe("pro");
    expect(org.status).toBe("active");
  });
});

describe("POST /api/onboarding/subscribe/webhook — cancellation confirmation email (Task #1904 / mirrors #1540)", () => {
  it("emails each org admin exactly once per cancellation event", async () => {
    const res = await postSigned(buildCancelledEvent({ organizationId: String(orgId) }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    // Both the org_memberships admin and the legacy app_users admin
    // should be emailed — exactly once each, no duplicates.
    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(2);

    const recipients = sendBroadcastEmailMock.mock.calls.map((call) => call[0]);
    expect(recipients.sort()).toEqual([ADMIN_EMAIL, LEGACY_ADMIN_EMAIL].sort());

    // Spot-check the email shape: it should mention cancellation in the
    // subject and identify Razorpay as the source so the email is
    // distinguishable from the Stripe variant.
    for (const call of sendBroadcastEmailMock.mock.calls) {
      const [, , subject, body, , opts] = call;
      expect(subject).toMatch(/cancel/i);
      expect(body).toMatch(/Free/);
      expect(body).toMatch(/Razorpay/);
      expect(opts).toMatchObject({
        flow: "org_plan_cancelled",
        orgId,
      });
    }
  });

  it("does not send any email when the cancellation event is ignored (missing notes.organizationId)", async () => {
    const res = await postSigned(buildCancelledEvent({}));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(sendBroadcastEmailMock).not.toHaveBeenCalled();
  });

  it("does not send any email when the organizationId does not resolve to a known org", async () => {
    const res = await postSigned(buildCancelledEvent({ organizationId: "999999999" }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(sendBroadcastEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboarding/subscribe/webhook — past-due notice on failed payments (Task #1907)", () => {
  it("flips the org to past_due and emails each admin exactly once on payment.failed", async () => {
    const res = await postSigned(buildFailedEvent({
      event: "payment.failed",
      organizationId: String(orgId),
      errorDescription: "Card declined by issuing bank",
    }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    // DB now reflects past_due — the paid tier is preserved (only
    // `subscription.cancelled` flips it to free).
    const [org] = await db.select({
      tier: organizationsTable.subscriptionTier,
      status: organizationsTable.subscriptionStatus,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("pro");
    expect(org.status).toBe("past_due");

    // Both admins emailed — exactly once each per failure event.
    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(2);
    const recipients = sendBroadcastEmailMock.mock.calls.map((c) => c[0]);
    expect(recipients.sort()).toEqual([ADMIN_EMAIL, LEGACY_ADMIN_EMAIL].sort());

    for (const call of sendBroadcastEmailMock.mock.calls) {
      const [, , subject, body, , opts] = call;
      // Distinguishable from cancellation: subject mentions past-due,
      // not "cancelled".
      expect(subject).toMatch(/couldn'?t process|past due|action required/i);
      // Names Razorpay as the source, the at-risk paid tier, the
      // failure description Razorpay gave us, and links to billing.
      expect(body).toMatch(/Razorpay/);
      expect(body).toMatch(/Pro/);
      expect(body).toMatch(/Card declined by issuing bank/);
      expect(body).toMatch(/\/settings\/billing/);
      expect(opts).toMatchObject({
        flow: "org_plan_past_due",
        orgId,
      });
    }
  });

  it("flips the org to past_due and emails each admin exactly once on subscription.halted (no payment payload)", async () => {
    // `subscription.halted` carries only the subscription entity — no
    // payment.error_description — so the email falls back to the
    // generic reason line.
    const res = await postSigned(buildFailedEvent({
      event: "subscription.halted",
      organizationId: String(orgId),
    }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    const [org] = await db.select({
      status: organizationsTable.subscriptionStatus,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.status).toBe("past_due");

    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(2);
    for (const call of sendBroadcastEmailMock.mock.calls) {
      const [, , , body] = call;
      expect(body).toMatch(/did not give a specific reason/i);
      expect(body).toMatch(/Razorpay/);
      expect(body).toMatch(/\/settings\/billing/);
    }
  });

  it("does not send any email when the failure event has no notes.organizationId", async () => {
    const res = await postSigned(buildFailedEvent({ event: "payment.failed" }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(sendBroadcastEmailMock).not.toHaveBeenCalled();

    // Org untouched — still active on the seeded paid tier.
    const [org] = await db.select({
      status: organizationsTable.subscriptionStatus,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.status).toBe("active");
  });

  it("does not send any email when the organizationId does not resolve to a known org", async () => {
    const res = await postSigned(buildFailedEvent({
      event: "payment.failed",
      organizationId: "999999999",
    }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(sendBroadcastEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboarding/subscribe/webhook — paid-plan cancellation alerts super admins (Task #1904 / mirrors #1539)", () => {
  it("fires the realtime super-admin email + push when a paid org cancels", async () => {
    const res = await postSigned(buildCancelledEvent({ organizationId: String(orgId) }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    // The realtime helper writes a single migrate audit row that records
    // the Razorpay cancellation reason and the from→to transition.
    const auditRows = await db.select({
      id: memberAuditLogTable.id,
      fieldChanges: memberAuditLogTable.fieldChanges,
      reason: memberAuditLogTable.reason,
    })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "organization_subscription_tier"),
        eq(memberAuditLogTable.action, "migrate"),
      ));
    expect(auditRows.length).toBe(1);
    const fc = auditRows[0].fieldChanges as { tier?: { from?: unknown; to?: unknown } } | null;
    expect(fc?.tier?.from).toBe("pro");
    expect(fc?.tier?.to).toBe("free");
    expect(String(auditRows[0].reason)).toContain("Razorpay subscription cancelled");

    // And the super-admin email + push fire immediately (no 23h dedup gate).
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [recipients, title, body] = pushMock.mock.calls[0];
    expect(recipients).toEqual([superAdminUserId]);
    expect(String(title)).toContain("Free");
    expect(String(body)).toContain("pro");
  });

  it("does NOT fire the alert when an already-Free org's subscription is cancelled", async () => {
    // Flip the org back to Free before the cancellation event so this
    // case represents a stale free subscription being torn down.
    await db.update(organizationsTable)
      .set({
        subscriptionTier: "free",
        subscriptionStatus: "active",
        pendingSubscriptionTier: null,
        razorpaySubscriptionId: "sub_task1904_seed",
        updatedAt: new Date(),
      })
      .where(eq(organizationsTable.id, orgId));

    const res = await postSigned(buildCancelledEvent({ organizationId: String(orgId) }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    // Org still ends up on free + cancelled, but no migrate audit row was
    // recorded — the realtime helper was never invoked.
    const [org] = await db.select({
      tier: organizationsTable.subscriptionTier,
      status: organizationsTable.subscriptionStatus,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("free");
    expect(org.status).toBe("cancelled");

    const auditRows = await db.select({ id: memberAuditLogTable.id })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "organization_subscription_tier"),
        eq(memberAuditLogTable.action, "migrate"),
      ));
    expect(auditRows.length).toBe(0);

    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
