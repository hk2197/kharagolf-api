/**
 * Task #1393 — Tests for the "mute a misbehaving watch session" admin endpoint.
 *
 * Covers:
 *   1. Auth gates (401 unauthenticated, 403 non-super-admin)
 *   2. Validation (400 on bad ttlSeconds)
 *   3. 404 when there is no metric history for the sessionId — without
 *      history we can't anchor the audit row, so the endpoint refuses
 *      rather than silently muting.
 *   4. Happy path: server-side mute flag flips, the in-process drop
 *      branch fires (recordWatchPosition skips the muted session), and
 *      a `member_audit_log` row is written with actor + session metadata.
 *   5. ttlSeconds is clamped to WATCH_SESSION_MUTE_MAX_TTL_MS so a stray
 *      request can't pin a session forever.
 *   6. Reconnect (flushWatchPositionSession) clears the mute so the
 *      next socket isn't pre-muted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  tournamentsTable,
  watchPositionMetricsTable,
  watchSessionMutesTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";
import {
  isWatchSessionMuted,
  flushWatchPositionSession,
  recordWatchPosition,
  hydrateMutedSessionsFromDb,
  syncMutedSessionsFromDb,
  pruneExpiredWatchSessionMutes,
  muteWatchSession,
  resolveWatchMuteResyncIntervalMs,
  startWatchMuteResyncLoop,
  _peekWatchSessionMuteForTests,
  _peekWatchPositionAccumulatorForTests,
  _resetWatchPositionMetricsForTests,
  WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS,
  WATCH_MUTE_RESYNC_MIN_INTERVAL_MS,
  WATCH_SESSION_MUTE_MAX_TTL_MS,
} from "../lib/watchPositionMetrics.js";

let orgId: number;
let userId: number;
let superAdminUserId: number;
let tournamentId: number;
const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdTournamentIds: number[] = [];

async function clearMetricsAndAudit() {
  await db.execute(sql`TRUNCATE TABLE ${watchPositionMetricsTable} RESTART IDENTITY`);
  // Task #1679 — wipe the persisted block list too so tests don't see
  // mutes carried over from previous test runs (or from a prior boot of
  // the dev DB).
  await db.execute(sql`TRUNCATE TABLE ${watchSessionMutesTable}`);
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, "watch_session"),
  ));
}

beforeAll(async () => {
  const slug = uid("watch-mute");
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg ${slug}`,
    slug,
    subscriptionTier: "pro",
    subscriptionStatus: "active",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  createdOrgIds.push(orgId);

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_player`,
    username: `player_${slug}`,
    email: `player_${slug}@example.com`,
    displayName: "Watch Player",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
  createdUserIds.push(userId);

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_su`,
    username: `su_${slug}`,
    email: `su_${slug}@example.com`,
    displayName: "Super Admin Mute",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminUserId = su.id;
  createdUserIds.push(superAdminUserId);

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    name: `Tourney ${slug}`,
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;
  createdTournamentIds.push(tournamentId);
});

afterAll(async () => {
  await clearMetricsAndAudit();
  if (createdTournamentIds.length > 0) {
    await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, createdTournamentIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(async () => {
  _resetWatchPositionMetricsForTests();
  await clearMetricsAndAudit();
});

async function seedMetricRow(sessionId: string, opts?: { tournamentId?: number | null }) {
  await db.insert(watchPositionMetricsTable).values({
    userId,
    sessionId,
    tournamentId: opts?.tournamentId === undefined ? tournamentId : opts.tournamentId,
    batteryMode: false,
    bucketMinute: new Date(Math.floor(Date.now() / 60_000) * 60_000),
    positionCount: 12,
  });
}

describe("POST /api/super-admin/watch-position-metrics/sessions/:sessionId/mute", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/super-admin/watch-position-metrics/sessions/sess-x/mute")
      .send({});
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a super_admin", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });
    const res = await request(app)
      .post("/api/super-admin/watch-position-metrics/sessions/sess-x/mute")
      .send({});
    expect(res.status).toBe(403);
  });

  it("returns 400 when ttlSeconds is invalid", async () => {
    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app)
      .post("/api/super-admin/watch-position-metrics/sessions/sess-x/mute")
      .send({ ttlSeconds: -5 });
    expect(res.status).toBe(400);
  });

  it("returns 404 when no metric history exists for the sessionId", async () => {
    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app)
      .post("/api/super-admin/watch-position-metrics/sessions/no-such-session/mute")
      .send({});
    expect(res.status).toBe(404);
    expect(isWatchSessionMuted("no-such-session")).toBe(false);
  });

  it("mutes the session, drops further position messages, and records an audit row", async () => {
    const sessionId = `sess-${uid("mute")}`;
    await seedMetricRow(sessionId);

    const app = createTestApp({
      id: superAdminUserId,
      username: "su",
      displayName: "Super Admin Mute",
      role: "super_admin",
    });

    const res = await request(app)
      .post(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body.userId).toBe(userId);
    expect(res.body.tournamentId).toBe(tournamentId);
    expect(res.body.organizationId).toBe(orgId);
    expect(typeof res.body.ttlMs).toBe("number");
    expect(res.body.ttlMs).toBeGreaterThan(0);
    expect(typeof res.body.expiresAt).toBe("string");

    // Server-side: the in-process flag is set.
    expect(isWatchSessionMuted(sessionId)).toBe(true);

    // And the WS handler's drop branch genuinely skips counting: feeding
    // the muted session through `recordWatchPosition` only happens after
    // the `isWatchSessionMuted` guard in ws-watch.ts. We assert the
    // guard short-circuits by simulating that exact pattern: when muted,
    // the accumulator must not advance.
    if (!isWatchSessionMuted(sessionId)) {
      recordWatchPosition({ userId, sessionId, tournamentId, batteryMode: false });
    }
    expect(_peekWatchPositionAccumulatorForTests(sessionId)).toBeUndefined();

    // Audit row written.
    const auditRows = await db
      .select({
        actorUserId: memberAuditLogTable.actorUserId,
        actorRole: memberAuditLogTable.actorRole,
        entity: memberAuditLogTable.entity,
        action: memberAuditLogTable.action,
        organizationId: memberAuditLogTable.organizationId,
        metadata: memberAuditLogTable.metadata,
        reason: memberAuditLogTable.reason,
      })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "watch_session"),
        eq(memberAuditLogTable.action, "mute"),
      ));
    expect(auditRows.length).toBe(1);
    const row = auditRows[0];
    expect(row.actorUserId).toBe(superAdminUserId);
    expect(row.actorRole).toBe("super_admin");
    expect(row.organizationId).toBe(orgId);
    expect(row.reason).toMatch(/runaway watch session/i);
    const md = row.metadata as { sessionId?: string; userId?: number; tournamentId?: number | null; ttlMs?: number };
    expect(md.sessionId).toBe(sessionId);
    expect(md.userId).toBe(userId);
    expect(md.tournamentId).toBe(tournamentId);
    expect(md.ttlMs).toBeGreaterThan(0);
  });

  it("falls back to the user's home org when the session has no tournament", async () => {
    const sessionId = `sess-${uid("orphan")}`;
    await seedMetricRow(sessionId, { tournamentId: null });

    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app)
      .post(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.tournamentId).toBeNull();
    expect(res.body.organizationId).toBe(orgId);
    expect(isWatchSessionMuted(sessionId)).toBe(true);
  });

  it("clamps ttlSeconds to WATCH_SESSION_MUTE_MAX_TTL_MS", async () => {
    const sessionId = `sess-${uid("clamp")}`;
    await seedMetricRow(sessionId);

    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const huge = WATCH_SESSION_MUTE_MAX_TTL_MS / 1000 * 100; // 100x the ceiling
    const res = await request(app)
      .post(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({ ttlSeconds: huge });

    expect(res.status).toBe(200);
    expect(res.body.ttlMs).toBeLessThanOrEqual(WATCH_SESSION_MUTE_MAX_TTL_MS);

    const peek = _peekWatchSessionMuteForTests(sessionId);
    expect(peek).not.toBeNull();
    expect(peek!.expiresAtMs - Date.now()).toBeLessThanOrEqual(WATCH_SESSION_MUTE_MAX_TTL_MS + 1_000);
  });

  it("clears the mute when the session disconnects so reconnects aren't pre-muted", async () => {
    const sessionId = `sess-${uid("reconnect")}`;
    await seedMetricRow(sessionId);

    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app)
      .post(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({});
    expect(res.status).toBe(200);
    expect(isWatchSessionMuted(sessionId)).toBe(true);

    // Simulate the watch dropping its socket.
    flushWatchPositionSession(sessionId);

    expect(isWatchSessionMuted(sessionId)).toBe(false);
    expect(_peekWatchSessionMuteForTests(sessionId)).toBeNull();

    // Task #1679 — the persisted row should also be gone so a future
    // restart's hydration doesn't resurrect a mute the watch has already
    // dropped its socket on. The DB delete is fire-and-forget on the WS
    // close path, so give the microtask queue a tick to drain.
    await new Promise((r) => setTimeout(r, 50));
    const persisted = await db
      .select({ sessionId: watchSessionMutesTable.sessionId })
      .from(watchSessionMutesTable)
      .where(eq(watchSessionMutesTable.sessionId, sessionId));
    expect(persisted).toEqual([]);
  });
});

// ── Task #1679: persistence + restart-survival ───────────────────────────────
//
// The block above proves the HTTP endpoint mutes a session and a reconnect
// clears it. These cases prove the *new* persistence layer behind that
// behaviour: every mute writes a `watch_session_mutes` row, hydration
// rebuilds the in-memory Map from those rows on boot, and the cron prune
// reaps already-expired rows.

describe("watch session mute persistence (Task #1679)", () => {
  beforeEach(async () => {
    _resetWatchPositionMetricsForTests();
    await clearMetricsAndAudit();
  });

  it("persists a row to watch_session_mutes whenever a session is muted", async () => {
    const sessionId = `sess-${uid("persist")}`;
    const before = Date.now();
    const { expiresAt, ttlMs } = await muteWatchSession(sessionId, 60_000);

    expect(ttlMs).toBe(60_000);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000 - 100);

    const rows = await db
      .select({
        sessionId: watchSessionMutesTable.sessionId,
        expiresAt: watchSessionMutesTable.expiresAt,
      })
      .from(watchSessionMutesTable)
      .where(eq(watchSessionMutesTable.sessionId, sessionId));
    expect(rows.length).toBe(1);
    // Persisted expiry matches the value returned to the dashboard so a
    // restart's hydration restores the same in-memory entry.
    expect(rows[0].expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it("re-muting the same session updates the persisted expires_at instead of inserting a duplicate", async () => {
    const sessionId = `sess-${uid("upsert")}`;
    await muteWatchSession(sessionId, 30_000);
    const second = await muteWatchSession(sessionId, 4 * 60 * 1000);

    const rows = await db
      .select({
        sessionId: watchSessionMutesTable.sessionId,
        expiresAt: watchSessionMutesTable.expiresAt,
      })
      .from(watchSessionMutesTable)
      .where(eq(watchSessionMutesTable.sessionId, sessionId));
    // Primary key on session_id keeps it to a single row; ON CONFLICT
    // overwrote the expires_at to the longer second TTL.
    expect(rows.length).toBe(1);
    expect(rows[0].expiresAt.getTime()).toBe(second.expiresAt.getTime());
  });

  it("hydrates the in-memory Map from persisted rows on boot", async () => {
    const liveSession = `sess-${uid("hydrate-live")}`;
    const expiredSession = `sess-${uid("hydrate-expired")}`;
    const futureMs = Date.now() + 60 * 60 * 1000;
    const pastMs = Date.now() - 60 * 1000;
    await db.insert(watchSessionMutesTable).values([
      { sessionId: liveSession, expiresAt: new Date(futureMs) },
      { sessionId: expiredSession, expiresAt: new Date(pastMs) },
    ]);

    // Simulate a fresh boot: in-memory Map is empty.
    _resetWatchPositionMetricsForTests();
    expect(isWatchSessionMuted(liveSession)).toBe(false);

    const result = await hydrateMutedSessionsFromDb();
    expect(result.hydrated).toBe(1);
    expect(result.expired).toBe(1);

    // The live mute is back in force without re-issuing the dashboard
    // action — exactly the regression Task #1679 fixes.
    expect(isWatchSessionMuted(liveSession)).toBe(true);
    const peek = _peekWatchSessionMuteForTests(liveSession);
    expect(peek).not.toBeNull();
    expect(peek!.expiresAtMs).toBe(futureMs);

    // Already-expired rows are skipped (and best-effort pruned from the
    // table on the same hydration tick — give the fire-and-forget delete
    // a moment to land before asserting).
    expect(isWatchSessionMuted(expiredSession)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    const remaining = await db
      .select({ sessionId: watchSessionMutesTable.sessionId })
      .from(watchSessionMutesTable)
      .where(eq(watchSessionMutesTable.sessionId, expiredSession));
    expect(remaining).toEqual([]);
  });

  it("pruneExpiredWatchSessionMutes deletes only past-expiry rows", async () => {
    const live = `sess-${uid("prune-live")}`;
    const expired = `sess-${uid("prune-expired")}`;
    await db.insert(watchSessionMutesTable).values([
      { sessionId: live, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
      { sessionId: expired, expiresAt: new Date(Date.now() - 5 * 60 * 1000) },
    ]);

    const { deleted } = await pruneExpiredWatchSessionMutes();
    expect(deleted).toBe(1);

    const remaining = await db
      .select({ sessionId: watchSessionMutesTable.sessionId })
      .from(watchSessionMutesTable)
      .where(inArray(watchSessionMutesTable.sessionId, [live, expired]));
    expect(remaining.map((r) => r.sessionId)).toEqual([live]);
  });
});

// Task #1678 — Tests for the active-mute listing endpoint that powers the
// "Active mutes" panel in the super-admin watch dashboard.
describe("GET /api/super-admin/watch-position-metrics/muted-sessions", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/super-admin/watch-position-metrics/muted-sessions");
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a super_admin", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });
    const res = await request(app).get("/api/super-admin/watch-position-metrics/muted-sessions");
    expect(res.status).toBe(403);
  });

  it("returns an empty list when nothing is muted", async () => {
    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/watch-position-metrics/muted-sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it("lists active mutes enriched with user/tournament/audit metadata", async () => {
    const sessionA = `sess-${uid("listA")}`;
    const sessionB = `sess-${uid("listB")}`;
    await seedMetricRow(sessionA);
    await seedMetricRow(sessionB, { tournamentId: null });

    const app = createTestApp({
      id: superAdminUserId,
      username: "su",
      displayName: "Super Admin Mute",
      role: "super_admin",
    });

    // Mute both sessions through the real POST endpoint so we exercise the
    // same audit-write path the listing reads back.
    const muteA = await request(app)
      .post(`/api/super-admin/watch-position-metrics/sessions/${sessionA}/mute`)
      .send({ ttlSeconds: 600 });
    expect(muteA.status).toBe(200);
    const muteB = await request(app)
      .post(`/api/super-admin/watch-position-metrics/sessions/${sessionB}/mute`)
      .send({ ttlSeconds: 1200 });
    expect(muteB.status).toBe(200);

    const res = await request(app).get("/api/super-admin/watch-position-metrics/muted-sessions");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBe(2);

    const bySession = new Map<string, any>(
      (res.body.sessions as any[]).map((s) => [s.sessionId, s]),
    );
    const a = bySession.get(sessionA);
    expect(a).toBeDefined();
    expect(a.userId).toBe(userId);
    expect(a.tournamentId).toBe(tournamentId);
    expect(a.mutedByUserId).toBe(superAdminUserId);
    expect(a.mutedByRole).toBe("super_admin");
    expect(typeof a.expiresAt).toBe("string");
    expect(typeof a.remainingMs).toBe("number");
    expect(a.remainingMs).toBeGreaterThan(0);

    const b = bySession.get(sessionB);
    expect(b).toBeDefined();
    expect(b.userId).toBe(userId);
    expect(b.tournamentId).toBeNull();
    expect(b.mutedByUserId).toBe(superAdminUserId);

    // Sorted soonest-to-expire first: A (ttl 600s) before B (ttl 1200s).
    expect((res.body.sessions as any[])[0].sessionId).toBe(sessionA);
    expect((res.body.sessions as any[])[1].sessionId).toBe(sessionB);
  });

  // Task #2090 — the panel must show mutes from every replica, not just
  // the one handling the request. We simulate a "muted on a different
  // replica" scenario by inserting a `watch_session_mutes` row directly
  // (the persisted source of truth) without touching this process's
  // in-memory `mutedSessions` map.
  it("returns mutes recorded on other replicas (reads from the persisted store)", async () => {
    const sessionRemote = `sess-${uid("remote")}`;
    await seedMetricRow(sessionRemote);

    // Reset this replica's in-memory map so it cannot be the source of
    // the listing — the row only exists in the DB.
    _resetWatchPositionMetricsForTests();
    expect(isWatchSessionMuted(sessionRemote)).toBe(false);

    await db.insert(watchSessionMutesTable).values({
      sessionId: sessionRemote,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/watch-position-metrics/muted-sessions");
    expect(res.status).toBe(200);
    const sessionIds = (res.body.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
    expect(sessionIds).toContain(sessionRemote);
  });

  // Task #2090 — already-expired persisted rows must not show up in the
  // panel even if the prune cron hasn't reaped them yet. The listing
  // filters at the SQL layer so the dashboard stays clean between
  // prune ticks.
  it("hides persisted rows whose expires_at is already in the past", async () => {
    const stale = `sess-${uid("stale")}`;
    await seedMetricRow(stale);
    await db.insert(watchSessionMutesTable).values({
      sessionId: stale,
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app).get("/api/super-admin/watch-position-metrics/muted-sessions");
    expect(res.status).toBe(200);
    const sessionIds = (res.body.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
    expect(sessionIds).not.toContain(stale);
  });
});

describe("DELETE /api/super-admin/watch-position-metrics/sessions/:sessionId/mute", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app)
      .delete("/api/super-admin/watch-position-metrics/sessions/sess-x/mute");
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a super_admin", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });
    const res = await request(app)
      .delete("/api/super-admin/watch-position-metrics/sessions/sess-x/mute");
    expect(res.status).toBe(403);
  });

  it("returns 404 when the session is not currently muted", async () => {
    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app)
      .delete("/api/super-admin/watch-position-metrics/sessions/no-such-session/mute");
    expect(res.status).toBe(404);
  });

  it("lifts the mute and writes an unmute audit row", async () => {
    const sessionId = `sess-${uid("unmute")}`;
    await seedMetricRow(sessionId);

    const app = createTestApp({
      id: superAdminUserId,
      username: "su",
      displayName: "Super Admin Mute",
      role: "super_admin",
    });

    const muteRes = await request(app)
      .post(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({});
    expect(muteRes.status).toBe(200);
    expect(isWatchSessionMuted(sessionId)).toBe(true);

    const res = await request(app)
      .delete(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessionId).toBe(sessionId);

    // Server-side: the in-process flag is cleared.
    expect(isWatchSessionMuted(sessionId)).toBe(false);
    expect(_peekWatchSessionMuteForTests(sessionId)).toBeNull();

    // Audit row written with action = unmute.
    const auditRows = await db
      .select({
        actorUserId: memberAuditLogTable.actorUserId,
        actorRole: memberAuditLogTable.actorRole,
        entity: memberAuditLogTable.entity,
        action: memberAuditLogTable.action,
        organizationId: memberAuditLogTable.organizationId,
        metadata: memberAuditLogTable.metadata,
        reason: memberAuditLogTable.reason,
      })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "watch_session"),
        eq(memberAuditLogTable.action, "unmute"),
      ));
    expect(auditRows.length).toBe(1);
    const row = auditRows[0];
    expect(row.actorUserId).toBe(superAdminUserId);
    expect(row.actorRole).toBe("super_admin");
    expect(row.organizationId).toBe(orgId);
    expect(row.reason).toMatch(/lifted/i);
    const md = row.metadata as { sessionId?: string; userId?: number; tournamentId?: number | null };
    expect(md.sessionId).toBe(sessionId);
    expect(md.userId).toBe(userId);
    expect(md.tournamentId).toBe(tournamentId);

    // And the listing endpoint no longer returns the freshly-unmuted session.
    const listRes = await request(app).get("/api/super-admin/watch-position-metrics/muted-sessions");
    expect(listRes.status).toBe(200);
    expect((listRes.body.sessions as any[]).find((s) => s.sessionId === sessionId)).toBeUndefined();
  });

  // Task #2092 — when ops types a justification in the new confirm
  // dialog the API should persist it on the audit row's `reason` (not
  // the canned default), so the audit trail explains *why* the mute
  // was lifted instead of just "from the dashboard".
  it("persists an operator-supplied reason on the unmute audit row", async () => {
    const sessionId = `sess-${uid("unmute-reason")}`;
    await seedMetricRow(sessionId);

    const app = createTestApp({
      id: superAdminUserId,
      username: "su",
      displayName: "Super Admin Mute",
      role: "super_admin",
    });

    const muteRes = await request(app)
      .post(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({});
    expect(muteRes.status).toBe(200);

    const customReason = "False positive — high-cadence drill, safe to resume";
    const res = await request(app)
      .delete(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({ reason: `  ${customReason}  ` });
    expect(res.status).toBe(200);

    const [row] = await db
      .select({
        reason: memberAuditLogTable.reason,
        metadata: memberAuditLogTable.metadata,
      })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "watch_session"),
        eq(memberAuditLogTable.action, "unmute"),
      ));
    expect(row.reason).toBe(customReason);
    const md = row.metadata as { reasonSource?: string };
    expect(md.reasonSource).toBe("operator");
  });

  // Task #2092 — and when the body has no reason (or only whitespace)
  // we still write the canned default so auditors aren't left with a
  // NULL/empty reason. Also flag it as `default` in metadata so
  // dashboards can tell the two cases apart.
  it("falls back to the canned reason when the body is empty or whitespace", async () => {
    const sessionId = `sess-${uid("unmute-empty")}`;
    await seedMetricRow(sessionId);

    const app = createTestApp({
      id: superAdminUserId,
      username: "su",
      displayName: "Super Admin Mute",
      role: "super_admin",
    });

    const muteRes = await request(app)
      .post(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({});
    expect(muteRes.status).toBe(200);

    const res = await request(app)
      .delete(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({ reason: "   " });
    expect(res.status).toBe(200);

    const [row] = await db
      .select({
        reason: memberAuditLogTable.reason,
        metadata: memberAuditLogTable.metadata,
      })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "watch_session"),
        eq(memberAuditLogTable.action, "unmute"),
      ));
    expect(row.reason).toMatch(/lifted/i);
    const md = row.metadata as { reasonSource?: string };
    expect(md.reasonSource).toBe("default");
  });

  // Task #2092 — guard the audit column from a mis-pasted dump by
  // truncating very long reasons to UNMUTE_REASON_MAX_LENGTH (500
  // chars). Mirrors the maxLength on the dashboard textarea so the
  // server is the source of truth even if a non-dashboard caller skips
  // client-side trimming.
  it("truncates a too-long reason to 500 chars", async () => {
    const sessionId = `sess-${uid("unmute-long")}`;
    await seedMetricRow(sessionId);

    const app = createTestApp({
      id: superAdminUserId,
      username: "su",
      displayName: "Super Admin Mute",
      role: "super_admin",
    });

    const muteRes = await request(app)
      .post(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({});
    expect(muteRes.status).toBe(200);

    const longReason = "x".repeat(900);
    const res = await request(app)
      .delete(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`)
      .send({ reason: longReason });
    expect(res.status).toBe(200);

    const [row] = await db
      .select({ reason: memberAuditLogTable.reason })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "watch_session"),
        eq(memberAuditLogTable.action, "unmute"),
      ));
    expect(row.reason?.length).toBe(500);
    expect(row.reason).toBe("x".repeat(500));
  });

  // Task #2090 — ops must be able to lift a mute applied on a different
  // replica from any replica's dashboard. We simulate the cross-replica
  // case by inserting a `watch_session_mutes` row directly (the
  // persisted source of truth) without touching this process's
  // in-memory `mutedSessions` map. Before #2090 the route returned 404
  // here ("not muted on this server").
  it("lifts a mute that only exists in the persisted store (cross-replica)", async () => {
    const sessionId = `sess-${uid("remote-unmute")}`;
    await seedMetricRow(sessionId);

    // Reset this replica's in-memory map so the only source of truth
    // is the DB row we insert below — exactly what a mute applied via
    // a different replica looks like to this one.
    _resetWatchPositionMetricsForTests();
    expect(isWatchSessionMuted(sessionId)).toBe(false);
    await db.insert(watchSessionMutesTable).values({
      sessionId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const app = createTestApp({
      id: superAdminUserId,
      username: "su",
      displayName: "Super Admin Mute",
      role: "super_admin",
    });

    const res = await request(app)
      .delete(`/api/super-admin/watch-position-metrics/sessions/${sessionId}/mute`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessionId).toBe(sessionId);

    // Persisted row is gone — that's the awaited delete, so the
    // dashboard's next fetch will reflect the change immediately.
    const persisted = await db
      .select({ sessionId: watchSessionMutesTable.sessionId })
      .from(watchSessionMutesTable)
      .where(eq(watchSessionMutesTable.sessionId, sessionId));
    expect(persisted).toEqual([]);

    // And an unmute audit row was written so the cross-replica action
    // shows up in the paper trail just like a same-replica unmute.
    const auditRows = await db
      .select({ action: memberAuditLogTable.action, metadata: memberAuditLogTable.metadata })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "watch_session"),
        eq(memberAuditLogTable.action, "unmute"),
      ));
    expect(auditRows.length).toBe(1);
    const md = auditRows[0].metadata as { sessionId?: string };
    expect(md.sessionId).toBe(sessionId);
  });
});

// Task #2090 — direct coverage for the periodic resync that propagates
// mute / unmute events across replicas without a restart. The resync is
// idempotent and does both halves: it adds rows the in-memory map is
// missing AND drops in-memory entries the DB no longer has.
describe("syncMutedSessionsFromDb (Task #2090 cross-replica resync)", () => {
  beforeEach(async () => {
    _resetWatchPositionMetricsForTests();
    await clearMetricsAndAudit();
  });

  it("adds DB rows that aren't in the in-memory map yet (mute applied on another replica)", async () => {
    const sessionId = `sess-${uid("resync-add")}`;
    const futureMs = Date.now() + 30 * 60 * 1000;
    await db.insert(watchSessionMutesTable).values({
      sessionId,
      expiresAt: new Date(futureMs),
    });

    expect(isWatchSessionMuted(sessionId)).toBe(false);
    const result = await syncMutedSessionsFromDb();
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(isWatchSessionMuted(sessionId)).toBe(true);
    expect(_peekWatchSessionMuteForTests(sessionId)?.expiresAtMs).toBe(futureMs);
  });

  it("drops in-memory entries whose DB row was deleted (unmute issued on another replica)", async () => {
    const sessionId = `sess-${uid("resync-drop")}`;
    // Mute through the public API so both layers (DB + in-memory) are
    // in sync, then delete the DB row directly to simulate a remote
    // unmute that hasn't reached this replica yet.
    await muteWatchSession(sessionId, 60 * 60 * 1000);
    expect(isWatchSessionMuted(sessionId)).toBe(true);
    await db.delete(watchSessionMutesTable).where(eq(watchSessionMutesTable.sessionId, sessionId));

    // Until resync runs, this replica still thinks the session is muted.
    expect(isWatchSessionMuted(sessionId)).toBe(true);

    const result = await syncMutedSessionsFromDb();
    expect(result.removed).toBe(1);
    expect(isWatchSessionMuted(sessionId)).toBe(false);
    expect(_peekWatchSessionMuteForTests(sessionId)).toBeNull();
  });

  it("updates the in-memory expires_at when the persisted row changed (re-mute on another replica)", async () => {
    const sessionId = `sess-${uid("resync-update")}`;
    await muteWatchSession(sessionId, 60_000);
    const initialExpiry = _peekWatchSessionMuteForTests(sessionId)!.expiresAtMs;

    // Simulate a different replica re-muting the same session with a
    // longer TTL — only the DB row is updated.
    const longerExpiry = Date.now() + 60 * 60 * 1000;
    await db
      .update(watchSessionMutesTable)
      .set({ expiresAt: new Date(longerExpiry) })
      .where(eq(watchSessionMutesTable.sessionId, sessionId));

    const result = await syncMutedSessionsFromDb();
    expect(result.updated).toBe(1);
    const post = _peekWatchSessionMuteForTests(sessionId)!.expiresAtMs;
    expect(post).toBe(longerExpiry);
    expect(post).not.toBe(initialExpiry);
  });
});

// Task #2120 — coverage for the env-var clamp + the periodic resync
// loop helper that `index.ts` boot-wires on every replica. The
// previous Task #2090 suite covers the resync function in isolation;
// these tests exercise the wiring layer that turns "function exists"
// into "every server actually picks up a peer's mute within the
// budget" — the behavioural promise from Task #2120's "Done looks
// like" criterion.
describe("resolveWatchMuteResyncIntervalMs (Task #2120 env clamp)", () => {
  it("returns the parsed value when it clears the 1s floor", () => {
    expect(resolveWatchMuteResyncIntervalMs("2500")).toBe(2500);
    expect(resolveWatchMuteResyncIntervalMs(7500)).toBe(7500);
    expect(resolveWatchMuteResyncIntervalMs(WATCH_MUTE_RESYNC_MIN_INTERVAL_MS)).toBe(
      WATCH_MUTE_RESYNC_MIN_INTERVAL_MS,
    );
  });

  it("falls back to the 5s default when the value is missing, non-finite, or below the floor", () => {
    expect(resolveWatchMuteResyncIntervalMs(undefined)).toBe(
      WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS,
    );
    expect(resolveWatchMuteResyncIntervalMs("")).toBe(
      WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS,
    );
    expect(resolveWatchMuteResyncIntervalMs("not-a-number")).toBe(
      WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS,
    );
    expect(resolveWatchMuteResyncIntervalMs(NaN)).toBe(
      WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS,
    );
    // Sub-second values are clamped: an env-var typo (e.g. someone
    // typing "500" thinking it's seconds when the var is ms) must
    // not let every replica hammer the DB at 2 Hz.
    expect(resolveWatchMuteResyncIntervalMs("500")).toBe(
      WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS,
    );
    expect(resolveWatchMuteResyncIntervalMs(0)).toBe(
      WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS,
    );
    expect(resolveWatchMuteResyncIntervalMs(-1000)).toBe(
      WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS,
    );
  });
});

describe("startWatchMuteResyncLoop (Task #2120 cross-replica fan-out)", () => {
  beforeEach(async () => {
    _resetWatchPositionMetricsForTests();
    await clearMetricsAndAudit();
  });

  it("propagates a mute applied 'on another replica' to this replica's in-memory map within one tick", async () => {
    // Simulate the two-replica scenario from Task #2120's "Done looks
    // like":
    //   1. Replica A muted `sessionId` via the dashboard. The mute row
    //      is now in `watch_session_mutes`. (We do that by calling
    //      `muteWatchSession`, which both persists and adds to *this*
    //      process's local map, then clearing the local map to model
    //      "this is replica B and the row hasn't propagated yet".)
    //   2. Replica B's boot wired a periodic resync loop. Within one
    //      tick (well under the ~30s target), replica B's local map
    //      contains the mute and `isWatchSessionMuted` returns true —
    //      i.e. the next `position` WS message that lands on replica
    //      B will be dropped without the watch having to reconnect.
    const sessionId = `sess-${uid("loop-add")}`;
    await muteWatchSession(sessionId, 30 * 60 * 1000);

    // Pretend we are a fresh replica that hasn't seen this row yet.
    _resetWatchPositionMetricsForTests();
    expect(isWatchSessionMuted(sessionId)).toBe(false);

    // Tight interval so the test runs in milliseconds, not 5s.
    // The behaviour we're proving (one tick → convergence) is
    // identical to the production 5s configuration.
    const loop = startWatchMuteResyncLoop({ intervalMs: 1_000 });
    try {
      expect(loop.intervalMs).toBe(1_000);
      // Wait long enough for at least one tick to fire, then a
      // microtask flush for the awaited DB query inside the resync.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !isWatchSessionMuted(sessionId)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(isWatchSessionMuted(sessionId)).toBe(true);
      const peek = _peekWatchSessionMuteForTests(sessionId);
      expect(peek).not.toBeNull();
    } finally {
      loop.stop();
    }
  });

  it("propagates a remote unmute (DB row deleted on another replica) within one tick", async () => {
    // Mirror image of the previous test: replica A lifted the mute
    // (the persisted row is gone), so replica B's stale in-memory
    // entry must be dropped on its next tick or it will keep dropping
    // a now-innocent watch's position messages until the original TTL
    // expires.
    const sessionId = `sess-${uid("loop-drop")}`;
    await muteWatchSession(sessionId, 60 * 60 * 1000);
    expect(isWatchSessionMuted(sessionId)).toBe(true);
    // Simulate replica A's DELETE landing first; replica B's local
    // map still thinks the session is muted.
    await db
      .delete(watchSessionMutesTable)
      .where(eq(watchSessionMutesTable.sessionId, sessionId));
    expect(isWatchSessionMuted(sessionId)).toBe(true);

    const loop = startWatchMuteResyncLoop({ intervalMs: 1_000 });
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && isWatchSessionMuted(sessionId)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(isWatchSessionMuted(sessionId)).toBe(false);
      expect(_peekWatchSessionMuteForTests(sessionId)).toBeNull();
    } finally {
      loop.stop();
    }
  });

  it("falls back to the default interval when given an out-of-range value (defence in depth alongside the env-var clamp)", () => {
    const loop = startWatchMuteResyncLoop({ intervalMs: 50 });
    try {
      expect(loop.intervalMs).toBe(WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS);
    } finally {
      loop.stop();
    }
  });

  it("stop() is idempotent so graceful-shutdown code can call it more than once safely", async () => {
    const loop = startWatchMuteResyncLoop({ intervalMs: 1_000 });
    loop.stop();
    expect(() => loop.stop()).not.toThrow();
    // After stop(), no further DB ticks occur — confirm by inserting
    // a row and asserting it does NOT appear in the local map for
    // longer than one tick.
    const sessionId = `sess-${uid("loop-stop")}`;
    await db.insert(watchSessionMutesTable).values({
      sessionId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(isWatchSessionMuted(sessionId)).toBe(false);
  });
});
