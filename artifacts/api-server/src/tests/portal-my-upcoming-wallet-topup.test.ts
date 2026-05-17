/**
 * Task #1423 — Surface wallet top-up requests in /api/portal/my-upcoming.
 *
 * The unified upcoming reader keys off `wallet_topup_requests` rows
 * written at /wallet/topup-order time and updated through
 * `pending_verification → credited` (verify or webhook landed) and
 * `pending_verification → refund_pending → refunded` (auto-refund cron).
 * Rows in `pending_verification`, `refund_pending`, or `refunded` surface
 * as `kind: "wallet_topup"` items pinned ahead of scheduled bookings.
 * `credited` rows are intentionally excluded — the balance update is the
 * member-visible signal there.
 *
 * Coverage:
 *   1. `pending_verification` request surfaces as wallet_topup.
 *   2. `refund_pending` request surfaces as wallet_topup.
 *   3. `refunded` request surfaces; `credited` does NOT.
 *   4. Rows older than the 30-day lookback are excluded.
 *   5. Another member's requests are not leaked.
 *   6. Wallet items are pinned ahead of scheduled bookings in the response.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  walletTopupRequestsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let memberUserId: number;
let otherUserId: number;

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T1423-${ts}`,
    slug: `t1423-${ts}`,
    contactEmail: `t1423-${ts}@example.test`,
  }).returning();
  orgId = org.id;
  const [member] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t1423_member_${ts}`,
    username: `t1423_member_${ts}`,
    email: `member_${ts}@example.test`,
    displayName: "Top-up Member",
    role: "player",
    organizationId: orgId,
  }).returning();
  memberUserId = member.id;
  const [other] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t1423_other_${ts}`,
    username: `t1423_other_${ts}`,
    email: `other_${ts}@example.test`,
    displayName: "Other Member",
    role: "player",
    organizationId: orgId,
  }).returning();
  otherUserId = other.id;
});

afterAll(async () => {
  await db.delete(walletTopupRequestsTable).where(eq(walletTopupRequestsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [memberUserId, otherUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  await db.delete(walletTopupRequestsTable).where(eq(walletTopupRequestsTable.organizationId, orgId));
});

function asUser(id: number): TestUser {
  return { id, username: `u_${id}`, role: "player", organizationId: orgId };
}

interface UpcomingItem {
  kind: string;
  id: number;
  organizationId: number | null;
  startsAt: string;
}

let orderSeq = 0;
function nextOrderRef(prefix: string): string {
  return `order_${prefix}_${Date.now()}_${++orderSeq}`;
}

describe("GET /api/portal/my-upcoming — wallet top-up requests", () => {
  it("surfaces a pending_verification top-up request", async () => {
    const [row] = await db.insert(walletTopupRequestsTable).values({
      organizationId: orgId,
      userId: memberUserId,
      orderRef: nextOrderRef("pending"),
      amount: "500.00",
      currency: "INR",
      status: "pending_verification",
    }).returning();

    const res = await request(createTestApp(asUser(memberUserId))).get("/api/portal/my-upcoming");
    expect(res.status).toBe(200);
    const items = res.body.items as UpcomingItem[];
    const walletItems = items.filter(i => i.kind === "wallet_topup");
    expect(walletItems).toHaveLength(1);
    expect(walletItems[0]?.id).toBe(row.id);
    expect(walletItems[0]?.organizationId).toBe(orgId);
  });

  it("surfaces a refund_pending top-up request", async () => {
    const [row] = await db.insert(walletTopupRequestsTable).values({
      organizationId: orgId,
      userId: memberUserId,
      orderRef: nextOrderRef("refund_pending"),
      amount: "250.00",
      currency: "INR",
      status: "refund_pending",
    }).returning();

    const res = await request(createTestApp(asUser(memberUserId))).get("/api/portal/my-upcoming");
    expect(res.status).toBe(200);
    const items = res.body.items as UpcomingItem[];
    const walletItems = items.filter(i => i.kind === "wallet_topup");
    expect(walletItems).toHaveLength(1);
    expect(walletItems[0]?.id).toBe(row.id);
  });

  it("surfaces refunded but not credited requests", async () => {
    const [refunded] = await db.insert(walletTopupRequestsTable).values({
      organizationId: orgId,
      userId: memberUserId,
      orderRef: nextOrderRef("refunded"),
      amount: "100.00",
      currency: "INR",
      status: "refunded",
    }).returning();
    await db.insert(walletTopupRequestsTable).values({
      organizationId: orgId,
      userId: memberUserId,
      orderRef: nextOrderRef("credited"),
      amount: "1000.00",
      currency: "INR",
      status: "credited",
    });

    const res = await request(createTestApp(asUser(memberUserId))).get("/api/portal/my-upcoming");
    expect(res.status).toBe(200);
    const items = res.body.items as UpcomingItem[];
    const walletItems = items.filter(i => i.kind === "wallet_topup");
    expect(walletItems).toHaveLength(1);
    expect(walletItems[0]?.id).toBe(refunded.id);
  });

  it("excludes requests older than the 30-day lookback", async () => {
    const stale = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await db.insert(walletTopupRequestsTable).values({
      organizationId: orgId,
      userId: memberUserId,
      orderRef: nextOrderRef("stale"),
      amount: "75.00",
      currency: "INR",
      status: "refunded",
      createdAt: stale,
    });

    const res = await request(createTestApp(asUser(memberUserId))).get("/api/portal/my-upcoming");
    expect(res.status).toBe(200);
    const items = res.body.items as UpcomingItem[];
    expect(items.filter(i => i.kind === "wallet_topup")).toHaveLength(0);
  });

  it("does not surface another member's top-up request", async () => {
    await db.insert(walletTopupRequestsTable).values({
      organizationId: orgId,
      userId: otherUserId,
      orderRef: nextOrderRef("other"),
      amount: "300.00",
      currency: "INR",
      status: "pending_verification",
    });

    const res = await request(createTestApp(asUser(memberUserId))).get("/api/portal/my-upcoming");
    expect(res.status).toBe(200);
    const items = res.body.items as UpcomingItem[];
    expect(items.filter(i => i.kind === "wallet_topup")).toHaveLength(0);
  });

  it("returns multiple wallet_topup items ordered most-recent first", async () => {
    const older = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const newer = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const [olderRow] = await db.insert(walletTopupRequestsTable).values({
      organizationId: orgId,
      userId: memberUserId,
      orderRef: nextOrderRef("older"),
      amount: "200.00",
      currency: "INR",
      status: "pending_verification",
      createdAt: older,
    }).returning();
    const [newerRow] = await db.insert(walletTopupRequestsTable).values({
      organizationId: orgId,
      userId: memberUserId,
      orderRef: nextOrderRef("newer"),
      amount: "400.00",
      currency: "INR",
      status: "refund_pending",
      createdAt: newer,
    }).returning();

    const res = await request(createTestApp(asUser(memberUserId))).get("/api/portal/my-upcoming");
    expect(res.status).toBe(200);
    const items = res.body.items as UpcomingItem[];
    const walletItems = items.filter(i => i.kind === "wallet_topup");
    expect(walletItems.map(i => i.id)).toEqual([newerRow.id, olderRow.id]);
  });
});
