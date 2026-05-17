/**
 * Task #1748 — Rate-limit the wallet auto-refund "send preview" endpoint.
 *
 * The send-preview path fires a real digest email per click and bypasses
 * the suppression-pause logic the cron path uses, so a stuck UI loop or
 * a treasurer double-clicking the button could blast many emails into
 * the same inbox. We cap each (user, org) pair to one preview per
 * `WALLET_TOPUP_REFUND_SEND_PREVIEW_COOLDOWN_SECONDS` window.
 *
 * This test covers:
 *  - the first preview goes through (mailer called)
 *  - an immediate second preview is rejected with 429 + retryAfter, and
 *    the mailer is NOT called (no email burned)
 *  - the limit is per-(user, org): a different user in the same org
 *    still gets their first preview through, and the same user against
 *    a different org still gets their first preview through.
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
import { eq, inArray } from "drizzle-orm";
import { sendWalletTopupRefundScheduleEmail } from "../lib/mailer.js";
import { _resetRateLimiterForTests } from "../lib/publicRateLimit.js";
import { createTestApp, uid, type TestUser } from "./helpers.js";

const sendMock = vi.mocked(sendWalletTopupRefundScheduleEmail);

let orgIdA: number;
let orgIdB: number;
let adminAId: number;
let adminBId: number;
let adminAEmail: string;
let adminBEmail: string;
let adminA: TestUser;
let adminB: TestUser;
let adminAOnOrgB: TestUser;

beforeAll(async () => {
  const tag = uid("t1748");

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1748A ${tag}`,
    slug: `${tag}-a`,
    contactEmail: `${tag}-a@example.test`,
  }).returning({ id: organizationsTable.id });
  orgIdA = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1748B ${tag}`,
    slug: `${tag}-b`,
    contactEmail: `${tag}-b@example.test`,
  }).returning({ id: organizationsTable.id });
  orgIdB = orgB.id;

  adminAEmail = `admin_a_${tag}@example.test`;
  const [adminARow] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin-a`,
    username: `${tag}_admin_a`,
    email: adminAEmail,
    displayName: "Treasurer A",
    role: "org_admin",
    organizationId: orgIdA,
  }).returning({ id: appUsersTable.id });
  adminAId = adminARow.id;

  adminBEmail = `admin_b_${tag}@example.test`;
  const [adminBRow] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin-b`,
    username: `${tag}_admin_b`,
    email: adminBEmail,
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

describe("Task #1748 — wallet send-preview rate limit", () => {
  it("allows the first preview and rejects an immediate second one with 429 + retryAfter, without burning the email", async () => {
    const app = createTestApp(adminA);

    const first = await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgIdA}`)
      .expect(200);
    expect(first.body.sentTo).toBe(adminAEmail);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const second = await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgIdA}`)
      .expect(429);

    // 429 body shape: error message + retryAfter seconds + cooldownSeconds.
    expect(typeof second.body.error).toBe("string");
    expect(second.body.error.toLowerCase()).toMatch(/preview/);
    expect(second.body.retryAfter).toBeGreaterThanOrEqual(1);
    expect(second.body.cooldownSeconds).toBeGreaterThanOrEqual(1);
    expect(second.headers["retry-after"]).toBe(String(second.body.retryAfter));

    // Critically: the throttle fires BEFORE the mailer, so no extra
    // email was actually sent.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("scopes the cooldown per-(user, org): a different user in the same org still gets their first preview", async () => {
    const appA = createTestApp(adminA);
    const appB = createTestApp(adminB);

    await request(appA)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgIdA}`)
      .expect(200);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // adminB has not used their bucket yet — they should get through
    // even though adminA just consumed theirs against the same org.
    const otherUser = await request(appB)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgIdA}`)
      .expect(200);
    expect(otherUser.body.sentTo).toBe(adminBEmail);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("scopes the cooldown per-(user, org): the same user against a different org still gets their first preview", async () => {
    const appAOnA = createTestApp(adminA);
    const appAOnB = createTestApp(adminAOnOrgB);

    await request(appAOnA)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgIdA}`)
      .expect(200);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Same user, different org: a fresh bucket means the call goes
    // through. (Authorisation against orgB is granted via super_admin.)
    await request(appAOnB)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgIdB}`)
      .expect(200);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
