/**
 * Task #1133 — Stripe subscription webhook → plan-migration realtime alert.
 *
 * Verifies the new branch in `POST /api/webhooks/stripe` for
 * `customer.subscription.created` / `customer.subscription.updated`:
 *   - When `metadata.targetTier` is a known canonical tier, the org's
 *     subscription_tier is updated and NO migration audit row is written
 *     (no super-admin alert fires either).
 *   - When `metadata.targetTier` is missing or unknown, the org is
 *     downgraded to `free`, a `entity = 'organization_subscription_tier'`
 *     / `action = 'migrate'` audit row is written, and the realtime
 *     `notifySuperAdminsOfPlanMigration` helper fans out an email + push
 *     to super admins.
 *   - Events without an `organizationId` in metadata are acknowledged
 *     and skipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
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
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { sendPlanMigrationDigestEmail } from "../lib/mailer.js";
import { sendTransactionalPush } from "../lib/comms.js";
import { _resetPlanMigrationDigestDedupForTest } from "../lib/planMigrationDigest.js";
import { createTestApp, uid } from "./helpers.js";

const app = createTestApp();
const emailMock = vi.mocked(sendPlanMigrationDigestEmail);
const pushMock = vi.mocked(sendTransactionalPush);

let orgId: number;
const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

let prevNodeEnv: string | undefined;
let prevWebhookSecret: string | undefined;

beforeAll(async () => {
  // The Stripe webhook handler skips signature verification in development
  // when STRIPE_WEBHOOK_SECRET is unset — match the pattern used by
  // stripe-webhook-shop-receipt.test.ts.
  prevNodeEnv = process.env.NODE_ENV;
  prevWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.NODE_ENV = "development";
  delete process.env.STRIPE_WEBHOOK_SECRET;

  const slug = uid("stripe-plan-mig");
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg ${slug}`,
    slug,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  createdOrgIds.push(orgId);

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_a`,
    username: `su_${slug}_a`,
    email: `su_a_${slug}@example.com`,
    displayName: "Super A",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u1.id);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
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
  await _resetPlanMigrationDigestDedupForTest();
  // Reset org tier between cases so each test has a known starting state.
  await db.update(organizationsTable)
    .set({ subscriptionTier: "starter", updatedAt: new Date() })
    .where(eq(organizationsTable.id, orgId));
  // Wipe any prior migrate audit rows from previous tests on this org.
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, "organization_subscription_tier"),
    eq(memberAuditLogTable.action, "migrate"),
  ));
});

function buildSubscriptionEvent(opts: {
  type: "customer.subscription.created" | "customer.subscription.updated";
  metadata: Record<string, string>;
}) {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    type: opts.type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `sub_${Math.random().toString(36).slice(2, 10)}`,
        object: "subscription",
        status: "active",
        metadata: opts.metadata,
      },
    },
  };
}

describe("POST /api/webhooks/stripe — subscription tier sync (Task #1133)", () => {
  it("applies a known canonical tier without raising a migration alert", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildSubscriptionEvent({
        type: "customer.subscription.updated",
        metadata: { organizationId: String(orgId), targetTier: "pro" },
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, tier: "pro" });

    const [org] = await db.select({ tier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("pro");

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

  it("downgrades to free and fires the realtime plan-migration alert when the tier slug is unknown", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildSubscriptionEvent({
        type: "customer.subscription.created",
        metadata: { organizationId: String(orgId), targetTier: "platinum_legacy" },
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, tier: "free", migrated: true });

    const [org] = await db.select({ tier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("free");

    // The realtime helper writes a single migrate audit row.
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
    expect(fc?.tier?.from).toBe("starter");
    expect(fc?.tier?.to).toBe("free");
    expect(String(auditRows[0].reason)).toContain("platinum_legacy");

    // And the super-admin email + push fire immediately (no 23h dedup gate).
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [recipients, title, body] = pushMock.mock.calls[0];
    expect(recipients).toEqual([createdUserIds[0]]);
    // Task #1906 — unknown-tier auto-resets now use a dedicated push
    // title ("Club auto-reset (unknown tier)") so super admins can tell
    // a slug-mapping bug apart from a genuine paid-plan cancellation
    // without opening the alert.
    expect(String(title)).toMatch(/unknown tier/i);
    expect(String(body)).toContain("starter");
  });

  it("downgrades to free when targetTier metadata is missing entirely", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildSubscriptionEvent({
        type: "customer.subscription.updated",
        metadata: { organizationId: String(orgId) },
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, tier: "free", migrated: true });
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  // ── Task #1905 — mid-tier downgrade alerts ─────────────────────────────
  // The known-tier branch above used to silently apply any canonical
  // `targetTier`. A paying club moving from enterprise down to starter
  // would land here without any super-admin notification, even though
  // it's the same kind of churn signal as the `customer.subscription.deleted`
  // → Free path. These tests exercise the new realtime alert against
  // the up vs down vs same matrix.

  async function setOrgTier(tier: string) {
    await db.update(organizationsTable)
      .set({ subscriptionTier: tier as never, updatedAt: new Date() })
      .where(eq(organizationsTable.id, orgId));
  }

  async function fetchMigrateAuditRows() {
    return db.select({
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
  }

  it("fires the realtime alert when the known target tier is a downgrade (enterprise → starter)", async () => {
    await setOrgTier("enterprise");

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildSubscriptionEvent({
        type: "customer.subscription.updated",
        metadata: { organizationId: String(orgId), targetTier: "starter" },
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, tier: "starter" });

    const [org] = await db.select({ tier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("starter");

    const auditRows = await fetchMigrateAuditRows();
    expect(auditRows.length).toBe(1);
    const fc = auditRows[0].fieldChanges as { tier?: { from?: unknown; to?: unknown } } | null;
    expect(fc?.tier?.from).toBe("enterprise");
    expect(fc?.tier?.to).toBe("starter");
    expect(String(auditRows[0].reason)).toMatch(/downgraded enterprise.*starter/);

    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [recipients, , body] = pushMock.mock.calls[0];
    expect(recipients).toEqual([createdUserIds[0]]);
    expect(String(body)).toContain("enterprise");
    expect(String(body)).toContain("starter");
  });

  it("fires the realtime alert on a single-step paid downgrade (pro → starter)", async () => {
    await setOrgTier("pro");

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildSubscriptionEvent({
        type: "customer.subscription.updated",
        metadata: { organizationId: String(orgId), targetTier: "starter" },
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, tier: "starter" });

    const auditRows = await fetchMigrateAuditRows();
    expect(auditRows.length).toBe(1);
    expect(String(auditRows[0].reason)).toMatch(/downgraded pro.*starter/);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent on an upgrade between paid tiers (starter → enterprise)", async () => {
    await setOrgTier("starter");

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildSubscriptionEvent({
        type: "customer.subscription.updated",
        metadata: { organizationId: String(orgId), targetTier: "enterprise" },
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, tier: "enterprise" });

    const [org] = await db.select({ tier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("enterprise");

    expect(await fetchMigrateAuditRows()).toEqual([]);
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("stays silent on a same-tier renewal (pro → pro)", async () => {
    await setOrgTier("pro");

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildSubscriptionEvent({
        type: "customer.subscription.updated",
        metadata: { organizationId: String(orgId), targetTier: "pro" },
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, tier: "pro" });

    expect(await fetchMigrateAuditRows()).toEqual([]);
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("stays silent on a free → paid first-time activation (starter from free)", async () => {
    // First-time subscribers come in as free → starter, which is an
    // upgrade — must never fire the downgrade alert.
    await setOrgTier("free");

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildSubscriptionEvent({
        type: "customer.subscription.created",
        metadata: { organizationId: String(orgId), targetTier: "starter" },
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true, tier: "starter" });

    expect(await fetchMigrateAuditRows()).toEqual([]);
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("acknowledges and skips events without an organizationId in metadata", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .send(buildSubscriptionEvent({
        type: "customer.subscription.updated",
        metadata: { targetTier: "pro" },
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: true });

    const [org] = await db.select({ tier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    // Org tier remains untouched (still the beforeEach-reset value).
    expect(org.tier).toBe("starter");
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
