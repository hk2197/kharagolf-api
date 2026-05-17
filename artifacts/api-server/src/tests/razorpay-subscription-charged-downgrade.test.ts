/**
 * Task #1905 — Razorpay `subscription.charged` realtime alert when a paid
 * org is moved to a cheaper tier (e.g. enterprise → starter).
 *
 * Mirrors `stripe-webhook-plan-migration.test.ts` for the Razorpay branch
 * in `routes/onboarding.ts`. The handler used to silently apply any
 * canonical `notes.targetTier` here, so a club downgrading mid-cycle
 * landed without any super-admin notification — a churn signal worth
 * surfacing in real time.
 *
 * Cases:
 *   - downgrade enterprise → starter: realtime email + push fire,
 *     migrate audit row written.
 *   - upgrade starter → enterprise: silent.
 *   - same-tier renewal pro → pro: silent.
 *   - first-time activation free → starter: silent (free is treated as
 *     "no prior paid plan" so it's an upgrade, not a downgrade).
 */
import crypto from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
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

import router from "../routes/index.js";
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

const WEBHOOK_SECRET = "task1905_razorpay_secret";

/**
 * Build an app whose JSON parser also captures the raw body, so the
 * Razorpay HMAC signature check in the webhook route sees the exact
 * bytes we signed. Mirrors the production app.ts wiring.
 */
function buildWebhookApp() {
  const app = express();
  app.use(express.json({
    verify: (req: Request, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  app.use("/api", router);
  return app;
}

const app = buildWebhookApp();
const emailMock = vi.mocked(sendPlanMigrationDigestEmail);
const pushMock = vi.mocked(sendTransactionalPush);

let orgId: number;
let superAdminUserId: number;
const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

let prevWebhookSecret: string | undefined;
let prevNodeEnv: string | undefined;

beforeAll(async () => {
  prevWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  prevNodeEnv = process.env.NODE_ENV;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.NODE_ENV = "test";

  const slug = `rzp-mig-${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg ${slug}`,
    slug,
    subscriptionTier: "enterprise",
    subscriptionStatus: "active",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  createdOrgIds.push(orgId);

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_su`,
    username: `su_${slug}`,
    email: `su_${slug}@example.com`,
    displayName: "Super A",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminUserId = su.id;
  createdUserIds.push(superAdminUserId);
});

afterAll(async () => {
  if (createdOrgIds.length > 0) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (prevWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
  else process.env.RAZORPAY_WEBHOOK_SECRET = prevWebhookSecret;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
});

beforeEach(async () => {
  emailMock.mockClear();
  pushMock.mockClear();
  await _resetPlanMigrationDigestDedupForTest();
  // Wipe any prior migrate audit rows from previous tests on this org so
  // each case asserts cleanly against the alert-side audit row.
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, "organization_subscription_tier"),
    eq(memberAuditLogTable.action, "migrate"),
  ));
});

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

function buildChargedEvent(opts: { orgId: number; targetTier: string }) {
  return {
    event: "subscription.charged",
    payload: {
      subscription: {
        entity: {
          id: `sub_${Math.random().toString(36).slice(2, 10)}`,
          notes: {
            organizationId: String(opts.orgId),
            targetTier: opts.targetTier,
          },
        },
      },
      payment: {
        entity: { id: `pay_${Math.random().toString(36).slice(2, 10)}` },
      },
    },
  };
}

async function postSigned(body: unknown) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return request(app)
    .post("/api/onboarding/subscribe/webhook")
    .set("Content-Type", "application/json")
    .set("x-razorpay-signature", signature)
    .send(raw);
}

describe("POST /api/onboarding/subscribe/webhook — paid-tier downgrade alert (Task #1905)", () => {
  it("fires the realtime super-admin alert when an enterprise org charges down to starter", async () => {
    await setOrgTier("enterprise");

    const res = await postSigned(buildChargedEvent({ orgId, targetTier: "starter" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    // Tier was applied.
    const [org] = await db.select({ tier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("starter");

    // The realtime helper writes a single migrate audit row that mentions
    // the Razorpay downgrade reason and the from→to transition.
    const auditRows = await fetchMigrateAuditRows();
    expect(auditRows.length).toBe(1);
    const fc = auditRows[0].fieldChanges as { tier?: { from?: unknown; to?: unknown } } | null;
    expect(fc?.tier?.from).toBe("enterprise");
    expect(fc?.tier?.to).toBe("starter");
    expect(String(auditRows[0].reason)).toMatch(/Razorpay.*downgraded enterprise.*starter/);

    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [recipients, , body] = pushMock.mock.calls[0];
    expect(recipients).toEqual([superAdminUserId]);
    expect(String(body)).toContain("enterprise");
    expect(String(body)).toContain("starter");
  });

  it("fires the realtime alert on a single-step paid downgrade (pro → starter)", async () => {
    await setOrgTier("pro");

    const res = await postSigned(buildChargedEvent({ orgId, targetTier: "starter" }));
    expect(res.status).toBe(200);

    const [org] = await db.select({ tier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("starter");

    const auditRows = await fetchMigrateAuditRows();
    expect(auditRows.length).toBe(1);
    expect(String(auditRows[0].reason)).toMatch(/Razorpay.*downgraded pro.*starter/);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent on an upgrade between paid tiers (starter → enterprise)", async () => {
    await setOrgTier("starter");

    const res = await postSigned(buildChargedEvent({ orgId, targetTier: "enterprise" }));
    expect(res.status).toBe(200);

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

    const res = await postSigned(buildChargedEvent({ orgId, targetTier: "pro" }));
    expect(res.status).toBe(200);

    const [org] = await db.select({ tier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("pro");

    expect(await fetchMigrateAuditRows()).toEqual([]);
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("stays silent on a free → paid first-time activation (starter from free)", async () => {
    await setOrgTier("free");

    const res = await postSigned(buildChargedEvent({ orgId, targetTier: "starter" }));
    expect(res.status).toBe(200);

    const [org] = await db.select({ tier: organizationsTable.subscriptionTier })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.tier).toBe("starter");

    expect(await fetchMigrateAuditRows()).toEqual([]);
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
