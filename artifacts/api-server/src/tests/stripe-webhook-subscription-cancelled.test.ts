/**
 * Task #1309 — Stripe `customer.subscription.deleted` syncs cancellations
 * back to the org's plan.
 *
 * Verifies the new branch in `POST /api/webhooks/stripe`:
 *   - When `metadata.organizationId` is present, the org is downgraded to
 *     `subscription_tier = 'free'` and `subscription_status = 'cancelled'`,
 *     mirroring the Razorpay `subscription.cancelled` branch in
 *     routes/onboarding.ts.
 *   - Events without an `organizationId` in metadata are acknowledged and
 *     skipped (no DB writes).
 *   - Events whose `organizationId` doesn't resolve to a known org are
 *     acknowledged and skipped.
 *
 * Task #1540 — additionally verifies that a successful cancellation
 *   sends a single confirmation email to each org admin (via the
 *   `sendBroadcastEmail` mailer), and that ignored events do not send
 *   any email at all.
 *
 * Task #1539 — paid-plan cancellations also fan out the realtime
 *   `notifySuperAdminsOfPlanMigration` email + push. Cancellations from an
 *   already-Free org stay silent so super admins aren't spammed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Mocks must be declared before importing the route under test
// (createTestApp pulls in the route modules transitively).
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

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  memberAuditLogTable,
  appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { sendBroadcastEmail, sendPlanMigrationDigestEmail } from "../lib/mailer.js";
import { sendTransactionalPush } from "../lib/comms.js";
import { _resetPlanMigrationDigestDedupForTest } from "../lib/planMigrationDigest.js";
import { createTestApp, uid } from "./helpers.js";

const sendBroadcastEmailMock = vi.mocked(sendBroadcastEmail);

const app = createTestApp();
const emailMock = vi.mocked(sendPlanMigrationDigestEmail);
const pushMock = vi.mocked(sendTransactionalPush);

let orgId: number;
let adminUserId: number;
let legacyAdminUserId: number;
let superAdminUserId: number;
const ADMIN_EMAIL = "task1540-membership-admin@example.com";
const LEGACY_ADMIN_EMAIL = "task1540-legacy-admin@example.com";
const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

let prevNodeEnv: string | undefined;
let prevWebhookSecret: string | undefined;

beforeAll(async () => {
  // Skip Stripe signature verification in dev-mode tests, matching the
  // pattern used by stripe-webhook-plan-migration.test.ts.
  prevNodeEnv = process.env.NODE_ENV;
  prevWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.NODE_ENV = "development";
  delete process.env.STRIPE_WEBHOOK_SECRET;

  const slug = uid("stripe-sub-cancel");
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
    replitUserId: `task1540-membership-${slug}`,
    username: `task1540-membership-${slug}`,
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
  // notifyOrgAdminsOfPlanCancellation.
  const [legacyAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `task1540-legacy-${slug}`,
    username: `task1540-legacy-${slug}`,
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
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  if (prevWebhookSecret !== undefined) process.env.STRIPE_WEBHOOK_SECRET = prevWebhookSecret;
});

beforeEach(async () => {
  emailMock.mockClear();
  pushMock.mockClear();
  sendBroadcastEmailMock.mockClear();
  _resetPlanMigrationDigestDedupForTest();
  // Reset to a paid, active state before each case so cancellation has
  // something meaningful to revert.
  await db.update(organizationsTable)
    .set({
      subscriptionTier: "pro",
      subscriptionStatus: "active",
      pendingSubscriptionTier: "enterprise",
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

function buildDeletedEvent(metadata: Record<string, string>) {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    type: "customer.subscription.deleted",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `sub_${Math.random().toString(36).slice(2, 10)}`,
        object: "subscription",
        status: "canceled",
        metadata,
      },
    },
  };
}

interface InvoicePaymentFailedEventOpts {
  /** Where to put the org id — under the invoice's own `metadata`,
   *  under `subscription_details.metadata`, or both. Mirrors the two
   *  Stripe API-version shapes the route handles. */
  metadataLocation?: "invoice" | "subscription_details" | "both" | "none";
  organizationId?: string;
  failureMessage?: string | null;
}

function buildInvoicePaymentFailedEvent(opts: InvoicePaymentFailedEventOpts = {}) {
  const loc = opts.metadataLocation ?? "subscription_details";
  const meta: Record<string, string> = {};
  const subDetailsMeta: Record<string, string> = {};
  if (opts.organizationId !== undefined) {
    if (loc === "invoice" || loc === "both") meta.organizationId = opts.organizationId;
    if (loc === "subscription_details" || loc === "both") subDetailsMeta.organizationId = opts.organizationId;
  }
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    type: "invoice.payment_failed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `in_${Math.random().toString(36).slice(2, 10)}`,
        object: "invoice",
        subscription: `sub_${Math.random().toString(36).slice(2, 10)}`,
        metadata: meta,
        subscription_details: { metadata: subDetailsMeta },
        last_finalization_error: opts.failureMessage
          ? { message: opts.failureMessage }
          : null,
      },
    },
  };
}

describe("POST /api/webhooks/stripe — subscription cancellation sync (Task #1309)", () => {
  it("downgrades the org to free + cancelled when Stripe reports the subscription deleted", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildDeletedEvent({ organizationId: String(orgId) }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      received: true,
      applied: true,
      tier: "free",
      status: "cancelled",
    });

    const [org] = await db.select({
      tier: organizationsTable.subscriptionTier,
      status: organizationsTable.subscriptionStatus,
      pending: organizationsTable.pendingSubscriptionTier,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("free");
    expect(org.status).toBe("cancelled");
    // Any pending upgrade should be cleared too — mirrors the Razorpay
    // cancellation branch.
    expect(org.pending).toBeNull();
  });

  it("acknowledges and skips deleted events without an organizationId in metadata", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildDeletedEvent({}));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: true });

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

  it("acknowledges and skips deleted events whose organizationId does not match a known org", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildDeletedEvent({ organizationId: "999999999" }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: true });

    const [org] = await db.select({
      tier: organizationsTable.subscriptionTier,
      status: organizationsTable.subscriptionStatus,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("pro");
    expect(org.status).toBe("active");
  });
});

describe("POST /api/webhooks/stripe — cancellation confirmation email (Task #1540)", () => {
  it("emails each org admin exactly once per cancellation event", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildDeletedEvent({ organizationId: String(orgId) }));

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);

    // Both the org_memberships admin and the legacy app_users admin
    // should be emailed — exactly once each, no duplicates.
    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(2);

    const recipients = sendBroadcastEmailMock.mock.calls.map((call) => call[0]);
    expect(recipients.sort()).toEqual([ADMIN_EMAIL, LEGACY_ADMIN_EMAIL].sort());

    // Spot-check the email shape: it should mention cancellation in the
    // subject and pass through the org's branding to sendBroadcastEmail
    // so it matches every other transactional email sent for the org.
    for (const call of sendBroadcastEmailMock.mock.calls) {
      const [, , subject, body, , opts] = call;
      expect(subject).toMatch(/cancel/i);
      expect(body).toMatch(/Free/);
      expect(body).toMatch(/Stripe/);
      expect(opts).toMatchObject({
        flow: "org_plan_cancelled",
        orgId,
      });
    }
  });

  it("does not send any email when the cancellation event is ignored (missing metadata)", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildDeletedEvent({}));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: true });
    expect(sendBroadcastEmailMock).not.toHaveBeenCalled();
  });

  it("does not send any email when the organizationId does not resolve to a known org", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildDeletedEvent({ organizationId: "999999999" }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: true });
    expect(sendBroadcastEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — invoice.payment_failed past-due notice (Task #1907)", () => {
  it("flips the org to past_due and emails each admin exactly once per failure event", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildInvoicePaymentFailedEvent({
        organizationId: String(orgId),
        failureMessage: "Your card was declined.",
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, status: "past_due" });

    // DB now reflects past_due — the paid tier is preserved (only
    // `subscription.deleted` flips it to free).
    const [org] = await db.select({
      tier: organizationsTable.subscriptionTier,
      status: organizationsTable.subscriptionStatus,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("pro");
    expect(org.status).toBe("past_due");

    // Both admins are emailed — exactly once each.
    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(2);
    const recipients = sendBroadcastEmailMock.mock.calls.map((c) => c[0]);
    expect(recipients.sort()).toEqual([ADMIN_EMAIL, LEGACY_ADMIN_EMAIL].sort());

    for (const call of sendBroadcastEmailMock.mock.calls) {
      const [, , subject, body, , opts] = call;
      // Distinguishable from cancellation: subject mentions "couldn't
      // process" / past-due, not "cancelled".
      expect(subject).toMatch(/couldn'?t process|past due|action required/i);
      // Names the source provider, the at-risk tier, the failure reason
      // Stripe gave us, and links to billing settings.
      expect(body).toMatch(/Stripe/);
      expect(body).toMatch(/Pro/);
      expect(body).toMatch(/Your card was declined/);
      expect(body).toMatch(/\/settings\/billing/);
      expect(opts).toMatchObject({
        flow: "org_plan_past_due",
        orgId,
      });
    }
  });

  it("falls back to a generic reason line when Stripe omits last_finalization_error", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildInvoicePaymentFailedEvent({
        organizationId: String(orgId),
        failureMessage: null,
      }));

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);

    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(2);
    for (const call of sendBroadcastEmailMock.mock.calls) {
      const [, , , body] = call;
      // No specific reason — fall back to the generic line, but still
      // mention Stripe + the billing link.
      expect(body).toMatch(/did not give a specific reason/i);
      expect(body).toMatch(/Stripe/);
      expect(body).toMatch(/\/settings\/billing/);
    }
  });

  it("reads organizationId from the invoice's own metadata when subscription_details is empty", async () => {
    // Older Stripe API versions only populate `metadata` on the invoice
    // itself; the route must handle that shape too.
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildInvoicePaymentFailedEvent({
        organizationId: String(orgId),
        metadataLocation: "invoice",
        failureMessage: "insufficient_funds",
      }));

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(2);
  });

  it("acknowledges and skips invoice.payment_failed events without an organizationId", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildInvoicePaymentFailedEvent({ metadataLocation: "none" }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: true });
    expect(sendBroadcastEmailMock).not.toHaveBeenCalled();

    // Org is untouched — still active on the seeded paid tier.
    const [org] = await db.select({
      tier: organizationsTable.subscriptionTier,
      status: organizationsTable.subscriptionStatus,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.status).toBe("active");
  });

  it("acknowledges and skips invoice.payment_failed events whose organizationId does not match a known org", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildInvoicePaymentFailedEvent({ organizationId: "999999999" }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: true });
    expect(sendBroadcastEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — paid-plan cancellation alerts super admins (Task #1539)", () => {
  it("fires the realtime super-admin email + push when a paid org cancels", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildDeletedEvent({ organizationId: String(orgId) }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, tier: "free", status: "cancelled" });

    // The realtime helper writes a single migrate audit row that mentions
    // the Stripe cancellation reason and the from→to transition.
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
    expect(String(auditRows[0].reason)).toContain("Stripe subscription cancelled");

    // And the super-admin email + push fire immediately (no 23h dedup gate).
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [recipients, title, body, data] = pushMock.mock.calls[0];
    expect(recipients).toEqual([superAdminUserId]);
    // Task #1906 — paid-plan cancellations now use a dedicated push
    // title ("Club cancelled paid plan") so super admins triage them
    // as churn rather than as a slug-mapping bug. The push payload
    // also carries `triggerReason: "cancelled"` so downstream
    // dashboards / notification routers don't have to re-derive the
    // category from the title text.
    expect(String(title)).toMatch(/cancelled paid plan/i);
    expect(String(body)).toContain("pro");
    expect(data).toMatchObject({
      type: "plan_migration_audit",
      organizationId: orgId,
      fromTier: "pro",
      toTier: "free",
      triggerReason: "cancelled",
    });

    // Task #1906 — the email subject is also specialised so the inbox
    // can be triaged without opening individual messages.
    const emailArgs = emailMock.mock.calls[0]?.[0] as { triggerReason?: string } | undefined;
    expect(emailArgs?.triggerReason).toBe("cancelled");
  });

  it("does NOT fire the alert when an already-Free org's subscription is deleted", async () => {
    // Flip the org back to Free before the cancellation event so this
    // case represents a stale free subscription being torn down.
    await db.update(organizationsTable)
      .set({
        subscriptionTier: "free",
        subscriptionStatus: "active",
        pendingSubscriptionTier: null,
        updatedAt: new Date(),
      })
      .where(eq(organizationsTable.id, orgId));

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildDeletedEvent({ organizationId: String(orgId) }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, tier: "free", status: "cancelled" });

    // No migrate audit row — the realtime helper was never invoked.
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
