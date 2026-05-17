/**
 * Task #1172 — GET /api/admin/notification-audit
 *
 * Pins the contract on the admin audit-feed endpoint that surfaces rows
 * from `notification_audit_log` (Task #1005) for an admin UI.
 *
 * Covers:
 *   • 401 when unauthenticated.
 *   • 403 for non-admin roles (player).
 *   • Org admin sees only rows whose recipient is in their org;
 *     never any other club's rows nor null-recipient rows.
 *   • Super admin sees every row, including null-recipient rows.
 *   • Filter by notification key.
 *   • Filter by channel.
 *   • Filter by status.
 *   • Filter by userId.
 *   • Filter by free-text userQuery (matches displayName / email).
 *   • Filter by since/until date range.
 *   • Pagination respects page/limit and reports an accurate total.
 *   • Facet lists (keys/channels/statuses) are returned for the dropdowns.
 *   • 400 on malformed since/until/userId values.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import {
  db,
  organizationsTable,
  appUsersTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminBId: number;
let playerAId: number;
let superAdminId: number;
let userA1Id: number;
let userA2Id: number;
let userBId: number;

const auditIds: number[] = [];

const TS_OLD = new Date("2025-01-15T12:00:00Z");
const TS_MID = new Date("2025-06-15T12:00:00Z");
const TS_NEW = new Date("2025-12-15T12:00:00Z");

async function seedAudit(opts: {
  key: string; userId: number | null; channel: string; status: string;
  reason?: string | null; payload?: Record<string, unknown>; createdAt: Date;
}): Promise<number> {
  const [r] = await db.insert(notificationAuditLogTable).values({
    notificationKey: opts.key,
    userId: opts.userId,
    channel: opts.channel,
    status: opts.status,
    reason: opts.reason ?? null,
    payload: opts.payload ?? {},
    createdAt: opts.createdAt,
  }).returning({ id: notificationAuditLogTable.id });
  auditIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1172_A_${stamp}`, slug: `t1172-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1172_B_${stamp}`, slug: `t1172-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1172-admin-a-${stamp}`,
    username: `t1172_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1172.test`,
    role: "org_admin", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id;

  const [adminB] = await db.insert(appUsersTable).values({
    replitUserId: `t1172-admin-b-${stamp}`,
    username: `t1172_admin_b_${stamp}`,
    email: `admin_b_${stamp}@t1172.test`,
    role: "org_admin", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBId = adminB.id;

  const [playerA] = await db.insert(appUsersTable).values({
    replitUserId: `t1172-player-a-${stamp}`,
    username: `t1172_player_a_${stamp}`,
    email: `player_a_${stamp}@t1172.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerAId = playerA.id;

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `t1172-super-${stamp}`,
    username: `t1172_super_${stamp}`,
    email: `super_${stamp}@t1172.test`,
    role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = su.id;

  // Recipient users — Org A has two; Org B has one.
  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `t1172-recipA1-${stamp}`,
    username: `recipA1_${stamp}`,
    displayName: "Alice Anders",
    email: `alice_${stamp}@t1172.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA1Id = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `t1172-recipA2-${stamp}`,
    username: `recipA2_${stamp}`,
    displayName: "Bob Brown",
    email: `bob_${stamp}@t1172.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA2Id = u2.id;

  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `t1172-recipB-${stamp}`,
    username: `recipB_${stamp}`,
    displayName: "Carol Cross",
    email: `carol_${stamp}@t1172.test`,
    role: "player", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  userBId = u3.id;

  // Org A audit rows.
  await seedAudit({
    key: "handicap.committee.changed", userId: userA1Id,
    channel: "email", status: "sent", reason: null,
    payload: { from: 12.4, to: 11.8 }, createdAt: TS_OLD,
  });
  await seedAudit({
    key: "handicap.committee.changed", userId: userA1Id,
    channel: "push", status: "skipped", reason: "no device tokens",
    payload: {}, createdAt: TS_MID,
  });
  await seedAudit({
    key: "caddie.mode.blocked", userId: userA2Id,
    channel: "push", status: "sent", reason: null,
    payload: { mode: "tournament" }, createdAt: TS_NEW,
  });
  // Org B audit row — must never leak to admin A.
  await seedAudit({
    key: "handicap.committee.changed", userId: userBId,
    channel: "email", status: "failed", reason: "smtp 550",
    payload: {}, createdAt: TS_MID,
  });
  // Null-recipient row (admin / broadcast alert).
  await seedAudit({
    key: "scheduled.email.failed", userId: null,
    channel: "email", status: "failed", reason: "ops alert",
    payload: { jobId: "abc" }, createdAt: TS_NEW,
  });
});

afterAll(async () => {
  if (auditIds.length > 0) {
    await db.delete(notificationAuditLogTable).where(inArray(notificationAuditLogTable.id, auditIds));
  }
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [
    adminAId, adminBId, playerAId, superAdminId, userA1Id, userA2Id, userBId,
  ]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

async function call(user: TestUser | undefined, query = "") {
  const app = createTestApp(user);
  return request(app).get(`/api/admin/notification-audit${query}`);
}

describe("GET /api/admin/notification-audit", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await call(undefined);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await call(asUser(playerAId, "player", orgAId));
    expect(res.status).toBe(403);
  });

  it("scopes results to the org admin's own org and excludes null-recipient rows", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ id: number; userId: number | null }> };
    const recipients = body.entries.map(e => e.userId);
    // All recipients must belong to Org A.
    for (const uid of recipients) {
      expect([userA1Id, userA2Id]).toContain(uid);
    }
    // Org B recipient and null-recipient rows must not appear.
    expect(recipients).not.toContain(userBId);
    expect(recipients).not.toContain(null);
  });

  it("returns every row including null-recipient ones for super admins", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ userId: number | null }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(5);
    const recipients = body.entries.map(e => e.userId);
    expect(recipients).toContain(null);
    expect(recipients).toContain(userBId);
  });

  it("filters by notification key", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId), "?key=caddie.mode.blocked");
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ notificationKey: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    for (const row of body.entries) {
      expect(row.notificationKey).toBe("caddie.mode.blocked");
    }
  });

  it("filters by channel", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId), "?channel=email");
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ channel: string }> };
    for (const row of body.entries) expect(row.channel).toBe("email");
  });

  it("filters by status", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId), "?status=skipped");
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ status: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    for (const row of body.entries) expect(row.status).toBe("skipped");
  });

  it("filters by userId", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId), `?userId=${userA2Id}`);
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ userId: number | null }> };
    expect(body.entries.length).toBeGreaterThan(0);
    for (const row of body.entries) expect(row.userId).toBe(userA2Id);
  });

  it("filters by free-text userQuery against display name / email", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId), `?userQuery=Alice`);
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ userId: number | null }> };
    expect(body.entries.length).toBeGreaterThan(0);
    for (const row of body.entries) expect(row.userId).toBe(userA1Id);
  });

  it("filters by since / until date range", async () => {
    const res = await call(
      asUser(adminAId, "org_admin", orgAId),
      `?since=${encodeURIComponent("2025-06-01T00:00:00Z")}&until=${encodeURIComponent("2025-07-01T00:00:00Z")}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ createdAt: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    for (const row of body.entries) {
      const t = new Date(row.createdAt).getTime();
      expect(t).toBeGreaterThanOrEqual(new Date("2025-06-01T00:00:00Z").getTime());
      expect(t).toBeLessThanOrEqual(new Date("2025-07-01T00:00:00Z").getTime());
    }
  });

  it("paginates results and reports an accurate total", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId), "?limit=1&page=1");
    expect(res.status).toBe(200);
    const body = res.body as { entries: unknown[]; total: number; page: number; limit: number };
    expect(body.entries.length).toBe(1);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(3);

    // Page 2 returns a different row.
    const res2 = await call(asUser(adminAId, "org_admin", orgAId), "?limit=1&page=2");
    expect(res2.status).toBe(200);
    const body2 = res2.body as { entries: Array<{ id: number }> };
    expect(body2.entries.length).toBe(1);
    expect(body2.entries[0].id).not.toBe((body.entries[0] as { id: number }).id);
  });

  it("returns facet lists for filter dropdowns to super admins", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    const body = res.body as {
      facets: { keys: string[]; channels: string[]; statuses: string[] };
    };
    expect(body.facets.keys).toEqual(expect.arrayContaining([
      "caddie.mode.blocked", "handicap.committee.changed", "scheduled.email.failed",
    ]));
    expect(body.facets.channels).toEqual(expect.arrayContaining(["email", "push"]));
    expect(body.facets.statuses).toEqual(expect.arrayContaining(["sent", "failed", "skipped"]));
  });

  it("scopes facet values for org admins (no cross-tenant leakage)", async () => {
    // Seed data summary:
    //   Org A (admin A) has rows for keys "handicap.committee.changed"
    //   (statuses sent + skipped) and "caddie.mode.blocked" (status sent),
    //   on channels "email" and "push".
    //   Org B has a "handicap.committee.changed" / email row with status
    //   "failed" — must not surface to admin A.
    //   A null-recipient "scheduled.email.failed" / email row exists too —
    //   must not surface to admin A either.
    const res = await call(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const body = res.body as {
      facets: { keys: string[]; channels: string[]; statuses: string[] };
    };
    // Keys: only those present in Org A.
    expect(body.facets.keys).toEqual(
      expect.arrayContaining(["caddie.mode.blocked", "handicap.committee.changed"]),
    );
    expect(body.facets.keys).not.toContain("scheduled.email.failed");
    // Statuses: "failed" only appeared in Org B's row and the null-recipient
    // row, so it must NOT show up in Org A's facet.
    expect(body.facets.statuses).toEqual(expect.arrayContaining(["sent", "skipped"]));
    expect(body.facets.statuses).not.toContain("failed");
    // Channels are shared across orgs in this fixture, so we only assert the
    // ones we know belong to Org A.
    expect(body.facets.channels).toEqual(expect.arrayContaining(["email", "push"]));
  });

  it("scopes facets the same way regardless of active filter selections", async () => {
    // Even if the admin narrows the entries with a key filter, the facets
    // should still expose every option available within their tenant — so
    // the dropdowns don't collapse to just the current selection.
    const res = await call(asUser(adminAId, "org_admin", orgAId), "?key=caddie.mode.blocked");
    expect(res.status).toBe(200);
    const body = res.body as {
      facets: { keys: string[]; channels: string[]; statuses: string[] };
    };
    expect(body.facets.keys).toEqual(
      expect.arrayContaining(["caddie.mode.blocked", "handicap.committee.changed"]),
    );
    expect(body.facets.keys).not.toContain("scheduled.email.failed");
  });

  // Task #2007 — Surface a per-row size hint for the CSV export so the
  // client can render "Download CSV (1,243 rows · ~480 KB)". The hint
  // is computed from the page rows already in memory and combined
  // with a fixed CSV-header byte count.
  it("returns a CSV size-estimate hint computed from the page rows", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    const body = res.body as {
      entries: unknown[];
      total: number;
      csvEstimate?: { avgRowBytes: number | null; headerBytes: number };
    };
    expect(body.csvEstimate).toBeDefined();
    expect(body.csvEstimate!.headerBytes).toBeGreaterThan(0);
    expect(body.entries.length).toBeGreaterThan(0);
    // Avg row bytes should be a positive integer when there are sample
    // rows on the page. Audit rows include a JSON payload column, an
    // ISO timestamp, an email and so on — comfortably > 30 bytes per
    // row in this fixture and well under a KB.
    expect(body.csvEstimate!.avgRowBytes).not.toBeNull();
    expect(body.csvEstimate!.avgRowBytes!).toBeGreaterThan(20);
    expect(body.csvEstimate!.avgRowBytes!).toBeLessThan(2048);
    expect(Number.isInteger(body.csvEstimate!.avgRowBytes!)).toBe(true);
  });

  it("reports avgRowBytes=null when the filtered page returned no rows", async () => {
    // A super-admin filter that matches zero rows in the seed exercises
    // the "no sample available" branch — the hint is still present so
    // the client never has to special-case its absence.
    const res = await call(
      asUser(superAdminId, "super_admin", null),
      "?key=does.not.exist.in.seed",
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      entries: unknown[];
      total: number;
      csvEstimate?: { avgRowBytes: number | null; headerBytes: number };
    };
    expect(body.entries.length).toBe(0);
    expect(body.total).toBe(0);
    expect(body.csvEstimate).toBeDefined();
    expect(body.csvEstimate!.avgRowBytes).toBeNull();
    expect(body.csvEstimate!.headerBytes).toBeGreaterThan(0);
  });

  it("returns 400 for malformed since / until / userId / page / limit", async () => {
    const su = asUser(superAdminId, "super_admin", null);
    expect((await call(su, "?since=not-a-date")).status).toBe(400);
    expect((await call(su, "?until=garbage")).status).toBe(400);
    expect((await call(su, "?userId=abc")).status).toBe(400);
    // Strict parsing rejects partial / non-integer values.
    expect((await call(su, "?userId=123abc")).status).toBe(400);
    expect((await call(su, "?page=oops")).status).toBe(400);
    expect((await call(su, "?limit=10x")).status).toBe(400);
  });

  it("rejects repeated query parameters with 400 instead of crashing", async () => {
    // Express parses `?key=a&key=b` into an array. A naive `.trim()` on that
    // would 500. We expect a clean 400 with a helpful message.
    const su = asUser(superAdminId, "super_admin", null);
    const res = await call(su, "?key=a&key=b");
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error ?? "").toMatch(/single value/i);
  });
});
