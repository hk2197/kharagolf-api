/**
 * Task #2174 — Rate-limit the wallet auto-refund "send now" endpoint.
 *
 * The send-now path triggers a real digest run that fans out to **every**
 * configured recipient (finance@, ops@, …). Unlike the preview path it
 * does honour the cron flow's bounce-aware suppression, but a 5-click
 * misfire still blasts up to 5 real digest emails to every non-suppressed
 * recipient. We cap each (user, org) pair to one manual run per
 * `WALLET_TOPUP_REFUND_SEND_NOW_COOLDOWN_SECONDS` window.
 *
 * This test mirrors `wallet-topup-refund-send-preview-rate-limit.test.ts`:
 *  - the first manual run goes through (mailer called, run row written)
 *  - an immediate second run is rejected with 429 + retryAfter, and the
 *    mailer is NOT called and no extra run row is written (no recipient
 *    burned)
 *  - the limit is per-(user, org): a different user in the same org
 *    still gets their first run through, and the same user against a
 *    different org still gets their first run through.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendWalletTopupRefundScheduleEmail: vi.fn(async () => {}),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  walletTopupRefundEmailSchedulesTable,
  walletTopupRefundEmailRunsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { sendWalletTopupRefundScheduleEmail } from "../lib/mailer.js";
import { _resetRateLimiterForTests } from "../lib/publicRateLimit.js";
import { createTestApp, uid, type TestUser } from "./helpers.js";

const sendMock = vi.mocked(sendWalletTopupRefundScheduleEmail);

let orgIdA: number;
let orgIdB: number;
let adminAId: number;
let adminBId: number;
let adminA: TestUser;
let adminB: TestUser;
let adminAOnOrgB: TestUser;

beforeAll(async () => {
  const tag = uid("t2174");

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T2174A ${tag}`,
    slug: `${tag}-a`,
    contactEmail: `${tag}-a@example.test`,
  }).returning({ id: organizationsTable.id });
  orgIdA = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T2174B ${tag}`,
    slug: `${tag}-b`,
    contactEmail: `${tag}-b@example.test`,
  }).returning({ id: organizationsTable.id });
  orgIdB = orgB.id;

  const [adminARow] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin-a`,
    username: `${tag}_admin_a`,
    email: `admin_a_${tag}@example.test`,
    displayName: "Treasurer A",
    role: "org_admin",
    organizationId: orgIdA,
  }).returning({ id: appUsersTable.id });
  adminAId = adminARow.id;

  const [adminBRow] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin-b`,
    username: `${tag}_admin_b`,
    email: `admin_b_${tag}@example.test`,
    displayName: "Treasurer B",
    role: "org_admin",
    organizationId: orgIdA,
  }).returning({ id: appUsersTable.id });
  adminBId = adminBRow.id;

  adminA = { id: adminAId, username: `${tag}_admin_a`, role: "org_admin", organizationId: orgIdA };
  adminB = { id: adminBId, username: `${tag}_admin_b`, role: "org_admin", organizationId: orgIdA };
  adminAOnOrgB = { id: adminAId, username: `${tag}_admin_a`, role: "super_admin", organizationId: orgIdB };
});

afterAll(async () => {
  await db.delete(walletTopupRefundEmailRunsTable).where(inArray(walletTopupRefundEmailRunsTable.organizationId, [orgIdA, orgIdB]));
  await db.delete(walletTopupRefundEmailSchedulesTable).where(inArray(walletTopupRefundEmailSchedulesTable.organizationId, [orgIdA, orgIdB]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminAId, adminBId]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgIdA, orgIdB]));
});

beforeEach(async () => {
  sendMock.mockClear();
  sendMock.mockImplementation(async () => {});
  await db.delete(walletTopupRefundEmailRunsTable).where(inArray(walletTopupRefundEmailRunsTable.organizationId, [orgIdA, orgIdB]));
  await db.delete(walletTopupRefundEmailSchedulesTable).where(inArray(walletTopupRefundEmailSchedulesTable.organizationId, [orgIdA, orgIdB]));

  for (const id of [orgIdA, orgIdB]) {
    await db.insert(walletTopupRefundEmailSchedulesTable).values({
      organizationId: id,
      frequency: "weekly",
      recipients: ["finance@example.test"],
      nextRunAt: new Date(),
    });
  }

  // Wipe the shared Postgres-backed rate-limit buckets between tests so
  // each case starts from a full token allotment.
  await _resetRateLimiterForTests();
});

async function countRunsForOrg(orgId: number): Promise<number> {
  const rows = await db.select({ id: walletTopupRefundEmailRunsTable.id })
    .from(walletTopupRefundEmailRunsTable)
    .where(inArray(walletTopupRefundEmailRunsTable.organizationId, [orgId]));
  return rows.length;
}

describe("Task #2174 — wallet send-now rate limit", () => {
  it("allows the first send-now and rejects an immediate second one with 429 + retryAfter, without burning extra emails", async () => {
    const app = createTestApp(adminA);

    const first = await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-now?organizationId=${orgIdA}`)
      .expect(200);
    expect(first.body.status).toBe("sent");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await countRunsForOrg(orgIdA)).toBe(1);

    const second = await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-now?organizationId=${orgIdA}`)
      .expect(429);

    // 429 body shape: error message + retryAfter seconds + cooldownSeconds.
    expect(typeof second.body.error).toBe("string");
    expect(second.body.error.toLowerCase()).toMatch(/digest/);
    expect(second.body.retryAfter).toBeGreaterThanOrEqual(1);
    expect(second.body.cooldownSeconds).toBeGreaterThanOrEqual(1);
    expect(second.headers["retry-after"]).toBe(String(second.body.retryAfter));

    // Critically: the throttle fires BEFORE the digest run, so no extra
    // email was actually sent and no extra run row was written.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await countRunsForOrg(orgIdA)).toBe(1);
  });

  it("scopes the cooldown per-(user, org): a different user in the same org still gets their first send-now", async () => {
    const appA = createTestApp(adminA);
    const appB = createTestApp(adminB);

    await request(appA)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-now?organizationId=${orgIdA}`)
      .expect(200);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // adminB has not used their bucket yet — they should get through
    // even though adminA just consumed theirs against the same org.
    const otherUser = await request(appB)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-now?organizationId=${orgIdA}`)
      .expect(200);
    expect(otherUser.body.status).toBe("sent");
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("scopes the cooldown per-(user, org): the same user against a different org still gets their first send-now", async () => {
    const appAOnA = createTestApp(adminA);
    const appAOnB = createTestApp(adminAOnOrgB);

    await request(appAOnA)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-now?organizationId=${orgIdA}`)
      .expect(200);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Same user, different org: a fresh bucket means the call goes
    // through. (Authorisation against orgB is granted via super_admin.)
    await request(appAOnB)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-now?organizationId=${orgIdB}`)
      .expect(200);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
