/**
 * Task #1733 — /api/admin/event-mutes ops dashboard endpoints.
 *
 * Pins the contract on the four endpoints that back the head-of-ops
 * "alert mute settings" page:
 *   GET  /admin/event-mutes
 *   GET  /admin/event-mutes/:id/users
 *   POST /admin/event-mutes/:id/restore-all
 *   GET  /admin/event-mutes/audit-log
 *
 * Covers:
 *   • 401 unauthenticated, 403 for non-admin roles.
 *   • Org admin sees only users in their org; super admin sees everyone.
 *   • Mute counts agree with the seeded `false` columns.
 *   • Drill-down lists exactly the muted users in scope.
 *   • Bulk restore flips every false → true in scope and reports the
 *     count; rows in other orgs are untouched.
 *   • Recent `event_opted_out` audit rows are returned, scoped per role.
 *   • Unknown event-mute id returns 404.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import {
  db,
  organizationsTable,
  appUsersTable,
  userNotificationPrefsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminBId: number;
let playerAId: number;
let superAdminId: number;
let mutedAId: number;       // Org A user with wallet-refund + manual-entry muted
let mutedAOtherId: number;  // Org A user with side-game muted
let mutedBId: number;       // Org B user with wallet-refund muted

const auditIds: number[] = [];
const prefUserIds: number[] = [];

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1733_A_${stamp}`, slug: `t1733-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1733_B_${stamp}`, slug: `t1733-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  type AppRole = "super_admin" | "org_admin" | "player" | "tournament_director";
  async function mkUser(suffix: string, role: AppRole, organizationId: number | null) {
    const replitUserId = `t1733-${suffix}-${stamp}`;
    const username = `t1733_${suffix}_${stamp}`;
    const displayName = `T1733 ${suffix}`;
    const email = `${suffix}_${stamp}@t1733.test`;
    if (organizationId === null) {
      const [u] = await db.insert(appUsersTable).values({
        replitUserId, username, displayName, email, role,
      }).returning({ id: appUsersTable.id });
      return u.id;
    }
    const [u] = await db.insert(appUsersTable).values({
      replitUserId, username, displayName, email, role, organizationId,
    }).returning({ id: appUsersTable.id });
    return u.id;
  }

  adminAId = await mkUser("admin-a", "org_admin", orgAId);
  adminBId = await mkUser("admin-b", "org_admin", orgBId);
  playerAId = await mkUser("player-a", "player", orgAId);
  superAdminId = await mkUser("super", "super_admin", null);
  mutedAId = await mkUser("muted-a1", "org_admin", orgAId);
  mutedAOtherId = await mkUser("muted-a2", "tournament_director", orgAId);
  mutedBId = await mkUser("muted-b1", "org_admin", orgBId);

  // Seed notification prefs:
  //   • mutedAId      → wallet refund failed = false, manual entry = false,
  //                     levy ledger failed = false (Task #2206)
  //   • mutedAOtherId → side game receipt failed = false,
  //                     levy ledger org failed = false (Task #2206)
  //   • mutedBId      → wallet refund failed = false,
  //                     levy reminders failed = false (Task #2206)
  //   • adminAId / adminBId → row exists with all defaults (true)
  //
  // Task #2206 — also seed the three new levy/reminders mute columns so the
  // wiring tests at the bottom of this file can prove the registry-driven
  // /admin/event-mutes flow surfaces them, scopes them per-org, and
  // round-trips a restore back to a state the user-side Settings page reads
  // as opted-in.
  await db.insert(userNotificationPrefsTable).values({
    userId: mutedAId,
    notifyWalletRefundDigestFailed: false,
    notifyManualEntryAlerts: false,
    notifyLevyLedgerDigestFailed: false,
  });
  prefUserIds.push(mutedAId);
  await db.insert(userNotificationPrefsTable).values({
    userId: mutedAOtherId,
    notifySideGameReceiptDigestFailed: false,
    notifyLevyLedgerOrgDigestFailed: false,
  });
  prefUserIds.push(mutedAOtherId);
  await db.insert(userNotificationPrefsTable).values({
    userId: mutedBId,
    notifyWalletRefundDigestFailed: false,
    notifyLevyRemindersDigestFailed: false,
  });
  prefUserIds.push(mutedBId);
  await db.insert(userNotificationPrefsTable).values({ userId: adminAId });
  prefUserIds.push(adminAId);
  await db.insert(userNotificationPrefsTable).values({ userId: adminBId });
  prefUserIds.push(adminBId);

  // Seed event_opted_out audit rows — the ops page surfaces these.
  async function seed(opts: { key: string; userId: number | null; channel: string; status: string; reason: string | null }) {
    const [r] = await db.insert(notificationAuditLogTable).values({
      notificationKey: opts.key,
      userId: opts.userId,
      channel: opts.channel,
      status: opts.status,
      reason: opts.reason,
      payload: {},
    }).returning({ id: notificationAuditLogTable.id });
    auditIds.push(r.id);
  }
  await seed({ key: "wallet.refund.digest.failed", userId: mutedAId, channel: "skipped", status: "skipped", reason: "event_opted_out" });
  await seed({ key: "side_game.receipt.digest.failed", userId: mutedAOtherId, channel: "skipped", status: "skipped", reason: "event_opted_out" });
  await seed({ key: "wallet.refund.digest.failed", userId: mutedBId, channel: "skipped", status: "skipped", reason: "event_opted_out" });
  // A non-event_opted_out row that must NEVER show up in the audit-log surface.
  await seed({ key: "wallet.refund.digest.failed", userId: mutedAId, channel: "email", status: "sent", reason: null });
});

afterAll(async () => {
  if (auditIds.length > 0) {
    await db.delete(notificationAuditLogTable).where(inArray(notificationAuditLogTable.id, auditIds));
  }
  if (prefUserIds.length > 0) {
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, prefUserIds));
  }
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [
    adminAId, adminBId, playerAId, superAdminId, mutedAId, mutedAOtherId, mutedBId,
  ]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

describe("GET /api/admin/event-mutes", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/admin/event-mutes");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const app = createTestApp(asUser(playerAId, "player", orgAId));
    const res = await request(app).get("/api/admin/event-mutes");
    expect(res.status).toBe(403);
  });

  it("scopes mute counts to the org admin's own org", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).get("/api/admin/event-mutes");
    expect(res.status).toBe(200);
    const body = res.body as { totalUsersInScope: number; events: Array<{ id: string; mutedCount: number }> };
    const byId = Object.fromEntries(body.events.map(e => [e.id, e.mutedCount]));
    // Org A: mutedAId muted wallet-refund + manual-entry; mutedAOtherId muted side-game.
    expect(byId["wallet_refund_digest_failed"]).toBe(1);
    expect(byId["manual_entry_alerts"]).toBe(1);
    expect(byId["side_game_receipt_digest_failed"]).toBe(1);
    expect(byId["coach_payout_account_changes"]).toBe(0);
    // Org A has at least these users in scope.
    expect(body.totalUsersInScope).toBeGreaterThanOrEqual(4);
  });

  it("super admin sees both orgs combined", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get("/api/admin/event-mutes");
    expect(res.status).toBe(200);
    const body = res.body as { events: Array<{ id: string; mutedCount: number }> };
    const byId = Object.fromEntries(body.events.map(e => [e.id, e.mutedCount]));
    // Org A has 1 + Org B has 1 wallet-refund mute.
    expect(byId["wallet_refund_digest_failed"]).toBe(2);
    expect(byId["manual_entry_alerts"]).toBe(1);
    expect(byId["side_game_receipt_digest_failed"]).toBe(1);
  });

  it("super admin can scope to a specific org via ?orgId=", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get(`/api/admin/event-mutes?orgId=${orgBId}`);
    expect(res.status).toBe(200);
    const body = res.body as { events: Array<{ id: string; mutedCount: number }> };
    const byId = Object.fromEntries(body.events.map(e => [e.id, e.mutedCount]));
    expect(byId["wallet_refund_digest_failed"]).toBe(1);
    expect(byId["manual_entry_alerts"]).toBe(0);
  });
});

describe("GET /api/admin/event-mutes/:id/users", () => {
  it("returns 404 for an unknown id", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get("/api/admin/event-mutes/totally-not-real/users");
    expect(res.status).toBe(404);
  });

  it("lists only the org admin's own org", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).get("/api/admin/event-mutes/wallet_refund_digest_failed/users");
    expect(res.status).toBe(200);
    const body = res.body as { users: Array<{ userId: number }> };
    const ids = body.users.map(u => u.userId);
    expect(ids).toContain(mutedAId);
    expect(ids).not.toContain(mutedBId);
  });

  it("super admin sees users from every org", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get("/api/admin/event-mutes/wallet_refund_digest_failed/users");
    expect(res.status).toBe(200);
    const body = res.body as { users: Array<{ userId: number }> };
    const ids = body.users.map(u => u.userId);
    expect(ids).toContain(mutedAId);
    expect(ids).toContain(mutedBId);
  });
});

describe("POST /api/admin/event-mutes/:id/restore-all", () => {
  it("returns 404 for an unknown id", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).post("/api/admin/event-mutes/totally-not-real/restore-all");
    expect(res.status).toBe(404);
  });

  it("org admin restore touches only its own org", async () => {
    // Pre-flip: mutedAId.notifyManualEntryAlerts = false, restore should
    // flip it back to true. mutedBId is in another org and stays muted
    // for any wallet-refund test below.
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).post("/api/admin/event-mutes/manual_entry_alerts/restore-all");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ restored: 1, id: "manual_entry_alerts" });

    // Verify Org A row was flipped, Org B untouched.
    const [aRow] = await db
      .select({ v: userNotificationPrefsTable.notifyManualEntryAlerts })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, mutedAId));
    expect(aRow?.v).toBe(true);

    // A second restore-all is now a no-op — nothing left to flip.
    const res2 = await request(app).post("/api/admin/event-mutes/manual_entry_alerts/restore-all");
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({ restored: 0, id: "manual_entry_alerts" });
  });

  it("super admin restore covers every org", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).post("/api/admin/event-mutes/wallet_refund_digest_failed/restore-all");
    expect(res.status).toBe(200);
    // Both Org A's mutedAId and Org B's mutedBId had wallet-refund muted.
    const body = res.body as { restored: number; id: string };
    expect(body.id).toBe("wallet_refund_digest_failed");
    expect(body.restored).toBe(2);

    const rows = await db
      .select({ id: userNotificationPrefsTable.userId, v: userNotificationPrefsTable.notifyWalletRefundDigestFailed })
      .from(userNotificationPrefsTable)
      .where(inArray(userNotificationPrefsTable.userId, [mutedAId, mutedBId]));
    for (const r of rows) expect(r.v).toBe(true);
  });
});

describe("POST /api/admin/event-mutes/:id/restore-user", () => {
  // These cases run after the bulk-restore block above, which has
  // already flipped wallet_refund_digest_failed back to `true` for
  // both mutedAId and mutedBId. Re-seed the column to `false` for the
  // user we want to target so each per-user case starts from a known
  // state, mirroring how the bulk tests stage their own preconditions.
  async function muteWalletRefund(userId: number) {
    await db.execute(sql`
      UPDATE user_notification_prefs
      SET notify_wallet_refund_digest_failed = false
      WHERE user_id = ${userId}
    `);
  }

  it("returns 404 for an unknown event id", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app)
      .post("/api/admin/event-mutes/totally-not-real/restore-user")
      .send({ userId: mutedAId });
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/admin/event-mutes/wallet_refund_digest_failed/restore-user")
      .send({ userId: mutedAId });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const app = createTestApp(asUser(playerAId, "player", orgAId));
    const res = await request(app)
      .post("/api/admin/event-mutes/wallet_refund_digest_failed/restore-user")
      .send({ userId: mutedAId });
    expect(res.status).toBe(403);
  });

  it("returns 400 when userId is missing or invalid", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const noBody = await request(app)
      .post("/api/admin/event-mutes/wallet_refund_digest_failed/restore-user")
      .send({});
    expect(noBody.status).toBe(400);

    const negative = await request(app)
      .post("/api/admin/event-mutes/wallet_refund_digest_failed/restore-user")
      .send({ userId: -5 });
    expect(negative.status).toBe(400);
  });

  it("happy path: org admin restores just the targeted user in their org", async () => {
    await muteWalletRefund(mutedAId);
    await muteWalletRefund(mutedAOtherId);

    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app)
      .post("/api/admin/event-mutes/wallet_refund_digest_failed/restore-user")
      .send({ userId: mutedAId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      restored: 1,
      id: "wallet_refund_digest_failed",
      userId: mutedAId,
    });

    // Targeted user is back to true; the other Org A muted user is untouched.
    const rows = await db
      .select({
        id: userNotificationPrefsTable.userId,
        v: userNotificationPrefsTable.notifyWalletRefundDigestFailed,
      })
      .from(userNotificationPrefsTable)
      .where(inArray(userNotificationPrefsTable.userId, [mutedAId, mutedAOtherId]));
    const byId = Object.fromEntries(rows.map(r => [r.id, r.v]));
    expect(byId[mutedAId]).toBe(true);
    expect(byId[mutedAOtherId]).toBe(false);

    // A second restore on the same user is now a no-op (already true).
    const res2 = await request(app)
      .post("/api/admin/event-mutes/wallet_refund_digest_failed/restore-user")
      .send({ userId: mutedAId });
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({
      restored: 0,
      id: "wallet_refund_digest_failed",
      userId: mutedAId,
    });
  });

  it("returns empty-set (restored: 0) when the targeted user is outside the caller's org", async () => {
    await muteWalletRefund(mutedBId);

    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app)
      .post("/api/admin/event-mutes/wallet_refund_digest_failed/restore-user")
      .send({ userId: mutedBId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      restored: 0,
      id: "wallet_refund_digest_failed",
      userId: mutedBId,
    });

    // Org B's row must remain muted — the cross-org call must NOT have
    // flipped it.
    const [bRow] = await db
      .select({ v: userNotificationPrefsTable.notifyWalletRefundDigestFailed })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, mutedBId));
    expect(bRow?.v).toBe(false);
  });
});

describe("GET /api/admin/event-mutes/trend", () => {
  it("returns 401 unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/admin/event-mutes/trend");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const app = createTestApp(asUser(playerAId, "player", orgAId));
    const res = await request(app).get("/api/admin/event-mutes/trend");
    expect(res.status).toBe(403);
  });

  it("scopes daily counts to the org admin's own org and returns one bucket per day", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).get("/api/admin/event-mutes/trend?days=30");
    expect(res.status).toBe(200);
    const body = res.body as {
      sinceDays: number;
      days: string[];
      events: Array<{ id: string; counts: number[]; total: number }>;
    };
    // Window is 30 days with one bucket per day.
    expect(body.sinceDays).toBe(30);
    expect(body.days.length).toBe(30);
    for (const c of body.events) expect(c.counts.length).toBe(30);
    // Every event from the registry shows up (zero-filled where idle).
    const byId = Object.fromEntries(body.events.map(e => [e.id, e]));
    expect(byId["wallet_refund_digest_failed"]).toBeDefined();
    expect(byId["coach_payout_account_changes"]).toBeDefined();
    // Org A: one event_opted_out row for wallet-refund (mutedAId), one
    // for side-game (mutedAOtherId). Org B's wallet-refund row must
    // NOT be counted here.
    expect(byId["wallet_refund_digest_failed"].total).toBe(1);
    expect(byId["side_game_receipt_digest_failed"].total).toBe(1);
    expect(byId["coach_payout_account_changes"].total).toBe(0);
    // The single Org A wallet-refund opt-out lands in today's bucket
    // (the seed inserts use NOW()). Find it and assert the position is
    // the last day in the window.
    const lastDayIdx = body.days.length - 1;
    expect(byId["wallet_refund_digest_failed"].counts[lastDayIdx]).toBe(1);
  });

  it("super admin sees both orgs combined", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get("/api/admin/event-mutes/trend?days=30");
    expect(res.status).toBe(200);
    const body = res.body as { events: Array<{ id: string; total: number }> };
    const byId = Object.fromEntries(body.events.map(e => [e.id, e.total]));
    // Org A's wallet-refund + Org B's wallet-refund = 2 total.
    expect(byId["wallet_refund_digest_failed"]).toBe(2);
    expect(byId["side_game_receipt_digest_failed"]).toBe(1);
  });

  it("super admin can scope to a specific org via ?orgId=", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get(`/api/admin/event-mutes/trend?days=30&orgId=${orgBId}`);
    expect(res.status).toBe(200);
    const body = res.body as { events: Array<{ id: string; total: number }> };
    const byId = Object.fromEntries(body.events.map(e => [e.id, e.total]));
    expect(byId["wallet_refund_digest_failed"]).toBe(1);
    expect(byId["side_game_receipt_digest_failed"]).toBe(0);
  });

  it("filters to a single event when ?id= is supplied (drill-down 90-day chart)", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get(
      "/api/admin/event-mutes/trend?days=90&id=wallet_refund_digest_failed",
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      sinceDays: number;
      days: string[];
      events: Array<{ id: string; counts: number[]; total: number }>;
    };
    expect(body.sinceDays).toBe(90);
    expect(body.days.length).toBe(90);
    expect(body.events.length).toBe(1);
    expect(body.events[0].id).toBe("wallet_refund_digest_failed");
    expect(body.events[0].counts.length).toBe(90);
    // Both Org A's and Org B's seeded wallet-refund opt-outs land in
    // the most recent bucket since they're created via NOW().
    expect(body.events[0].total).toBe(2);
    expect(body.events[0].counts[89]).toBe(2);
  });

  it("returns 404 for an unknown id", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get("/api/admin/event-mutes/trend?id=totally-not-real");
    expect(res.status).toBe(404);
  });

  it("excludes audit rows that are not event_opted_out", async () => {
    // The setup seeded a `wallet.refund.digest.failed` row with
    // status=sent, reason=null for mutedAId. The trend endpoint must
    // count event_opted_out rows only — so Org A's wallet-refund total
    // is 1, not 2.
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).get("/api/admin/event-mutes/trend?days=30");
    expect(res.status).toBe(200);
    const body = res.body as { events: Array<{ id: string; total: number }> };
    const byId = Object.fromEntries(body.events.map(e => [e.id, e.total]));
    expect(byId["wallet_refund_digest_failed"]).toBe(1);
  });

  it("clamps days to the [1, 90] range and defaults to 30 on garbage input", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const oversized = await request(app).get("/api/admin/event-mutes/trend?days=999");
    expect(oversized.status).toBe(200);
    expect((oversized.body as { sinceDays: number }).sinceDays).toBe(30);
    const garbage = await request(app).get("/api/admin/event-mutes/trend?days=banana");
    expect(garbage.status).toBe(200);
    expect((garbage.body as { sinceDays: number }).sinceDays).toBe(30);
  });
});

describe("GET /api/admin/event-mutes/audit-log", () => {
  it("returns 401 unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/admin/event-mutes/audit-log");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const app = createTestApp(asUser(playerAId, "player", orgAId));
    const res = await request(app).get("/api/admin/event-mutes/audit-log");
    expect(res.status).toBe(403);
  });

  it("scopes event_opted_out rows to the org admin's own org and excludes other reasons", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).get("/api/admin/event-mutes/audit-log");
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ userId: number | null; reason: string | null; status: string }> };
    // Every returned row must be event_opted_out and from Org A.
    for (const e of body.entries) {
      expect(e.reason).toBe("event_opted_out");
      expect([mutedAId, mutedAOtherId]).toContain(e.userId);
    }
    const ids = body.entries.map(e => e.userId);
    expect(ids).not.toContain(mutedBId);
  });

  it("super admin sees event_opted_out rows from every org", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get("/api/admin/event-mutes/audit-log");
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ userId: number | null; reason: string | null }> };
    const ids = body.entries.map(e => e.userId);
    expect(ids).toContain(mutedAId);
    expect(ids).toContain(mutedAOtherId);
    expect(ids).toContain(mutedBId);
  });
});

// Task #2206 — pin the wiring of the three new levy/reminders digest-failed
// alerts (added to ADMIN_EVENT_MUTE_REGISTRY by Task #1762) into the
// admin event-mute surface so a future regression that breaks the
// data-driven flow is caught immediately. The page in
// `kharagolf-web/src/pages/admin-event-mutes.tsx` renders whatever the
// summary endpoint returns, so contract coverage on the endpoint is
// what guarantees the rows show up under the Billing category in the UI.
describe("Task #2206 — levy/reminders entries are surfaced on /admin/event-mutes", () => {
  const NEW_ENTRIES: Array<{
    id: string;
    columnName: string;
    notificationKey: string;
  }> = [
    {
      id: "levy_ledger_digest_failed",
      columnName: "notify_levy_ledger_digest_failed",
      notificationKey: "levy.ledger.digest.failed",
    },
    {
      id: "levy_ledger_org_digest_failed",
      columnName: "notify_levy_ledger_org_digest_failed",
      notificationKey: "levy.ledger.org.digest.failed",
    },
    {
      id: "levy_reminders_digest_failed",
      columnName: "notify_levy_reminders_digest_failed",
      notificationKey: "levy.reminders.digest.failed",
    },
  ];

  it("returns the three new entries with category=Billing and the right column/key", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get("/api/admin/event-mutes");
    expect(res.status).toBe(200);
    const body = res.body as {
      events: Array<{
        id: string;
        category: string;
        columnName: string;
        notificationKeys: string[];
      }>;
    };
    const byId = Object.fromEntries(body.events.map(e => [e.id, e]));
    for (const entry of NEW_ENTRIES) {
      const row = byId[entry.id];
      expect(row, `expected ${entry.id} to be exposed by /admin/event-mutes`).toBeDefined();
      expect(row.category).toBe("Billing");
      expect(row.columnName).toBe(entry.columnName);
      expect(row.notificationKeys).toContain(entry.notificationKey);
    }
  });

  it("counts seeded levy mutes per event id and scopes them per org", async () => {
    // Org A admin: mutedAId has notify_levy_ledger_digest_failed=false and
    // mutedAOtherId has notify_levy_ledger_org_digest_failed=false. Org B's
    // notify_levy_reminders_digest_failed mute (mutedBId) must NOT be
    // visible in this scope.
    const orgAApp = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const orgARes = await request(orgAApp).get("/api/admin/event-mutes");
    expect(orgARes.status).toBe(200);
    const orgABody = orgARes.body as { events: Array<{ id: string; mutedCount: number }> };
    const orgAById = Object.fromEntries(orgABody.events.map(e => [e.id, e.mutedCount]));
    expect(orgAById["levy_ledger_digest_failed"]).toBe(1);
    expect(orgAById["levy_ledger_org_digest_failed"]).toBe(1);
    expect(orgAById["levy_reminders_digest_failed"]).toBe(0);

    // Super admin sees Org A + Org B combined.
    const superApp = createTestApp(asUser(superAdminId, "super_admin", null));
    const superRes = await request(superApp).get("/api/admin/event-mutes");
    expect(superRes.status).toBe(200);
    const superBody = superRes.body as { events: Array<{ id: string; mutedCount: number }> };
    const superById = Object.fromEntries(superBody.events.map(e => [e.id, e.mutedCount]));
    expect(superById["levy_ledger_digest_failed"]).toBe(1);
    expect(superById["levy_ledger_org_digest_failed"]).toBe(1);
    expect(superById["levy_reminders_digest_failed"]).toBe(1);
  });

  it("drill-down user list returns the muted user for each levy entry", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const cases: Array<[string, number]> = [
      ["levy_ledger_digest_failed", mutedAId],
      ["levy_ledger_org_digest_failed", mutedAOtherId],
      ["levy_reminders_digest_failed", mutedBId],
    ];
    for (const [id, expectedUserId] of cases) {
      const res = await request(app).get(`/api/admin/event-mutes/${id}/users`);
      expect(res.status, `drill-down for ${id}`).toBe(200);
      const body = res.body as { users: Array<{ userId: number }> };
      const ids = body.users.map(u => u.userId);
      expect(ids).toContain(expectedUserId);
    }
  });

  it("restore-all flips the levy column back to true so the user-side Settings page reads opted-in", async () => {
    // Pre-flight: mutedAId starts with notify_levy_ledger_digest_failed = false.
    const [pre] = await db
      .select({ v: userNotificationPrefsTable.notifyLevyLedgerDigestFailed })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, mutedAId));
    expect(pre?.v).toBe(false);

    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).post("/api/admin/event-mutes/levy_ledger_digest_failed/restore-all");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ restored: 1, id: "levy_ledger_digest_failed" });

    // Post: column is now true — same value the user-side prefs endpoint
    // (which the Settings page reads) reports as "opted-in".
    const [post] = await db
      .select({ v: userNotificationPrefsTable.notifyLevyLedgerDigestFailed })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, mutedAId));
    expect(post?.v).toBe(true);

    // Org B's notify_levy_reminders_digest_failed mute on mutedBId is in
    // a different org and a different column — the Org A restore must
    // NOT have touched it.
    const [otherOrgUntouched] = await db
      .select({ v: userNotificationPrefsTable.notifyLevyRemindersDigestFailed })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, mutedBId));
    expect(otherOrgUntouched?.v).toBe(false);
  });

  it("restore-user targets a single levy mute and leaves siblings alone", async () => {
    // mutedAOtherId is in Org A and starts with
    // notify_levy_ledger_org_digest_failed = false. Restoring just that
    // user via the per-user endpoint must flip their column to true
    // without touching any other levy column on the same row.
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app)
      .post("/api/admin/event-mutes/levy_ledger_org_digest_failed/restore-user")
      .send({ userId: mutedAOtherId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      restored: 1,
      id: "levy_ledger_org_digest_failed",
      userId: mutedAOtherId,
    });

    const [row] = await db
      .select({
        org: userNotificationPrefsTable.notifyLevyLedgerOrgDigestFailed,
        ledger: userNotificationPrefsTable.notifyLevyLedgerDigestFailed,
        reminders: userNotificationPrefsTable.notifyLevyRemindersDigestFailed,
      })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, mutedAOtherId));
    expect(row?.org).toBe(true);
    // The other two levy columns on the same row started at the schema
    // default (true) and must still be true — restoring one must not
    // touch siblings.
    expect(row?.ledger).toBe(true);
    expect(row?.reminders).toBe(true);
  });
});
