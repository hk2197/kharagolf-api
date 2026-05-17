/**
 * Task #1775 — GET /api/portal/notification-audit
 *
 * Backfills an audit-log surface so a controller who muted both email and
 * push channels for an alert (canonically
 * `privacy.erasure.storage_failures.controller_digest`) can still see that
 * the cron tried to reach them. Without this endpoint the only trace of a
 * fully-muted alert is a `skipped/event_opted_out` row in
 * `notification_audit_log` with no UI surface, so a real outage can hide
 * forever.
 *
 * These tests cover the *plumbing* between the Express route and the
 * `notification_audit_log` table:
 *  - Auth (anonymous callers get 401, no audit data leaks across users).
 *  - The `kind` discriminator (`event_opted_out` -> `user_muted`,
 *    everything else -> `system_suppressed`) — this is what powers the
 *    "you muted this" vs "system suppressed" badges in the portal UI.
 *  - The `?days` window (default 30, opt-in to a longer window, capped).
 *  - The `?key` filter and cursor pagination (`?before` + `nextBefore`).
 *  - Joining the registry to surface human-readable category/description
 *    so the UI can render rows without an extra round-trip.
 *
 * Dispatcher behaviour (when the audit row gets *written*) is covered in
 * `notification-dispatch-and-digest.test.ts`; this suite assumes those
 * rows already exist and only validates the read API.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  organizationsTable,
  notificationAuditLogTable,
  notificationTypeRegistryTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

const ERASURE_KEY = "privacy.erasure.storage_failures.controller_digest";
const ERASURE_DESC = "Stuck-erasure cleanup digest";
const ERASURE_CATEGORY = "privacy_admin";

let orgId: number;
let userId: number;
let otherUserId: number;
// Track every audit-row id we insert so the cleanup is exhaustive even if
// individual `it` blocks skip; otherwise leftovers would leak into other
// suites that read this table by user-id.
const insertedAuditIds: number[] = [];
let registrySeeded = false;
// Registry rows are global state shared across the test database, so the
// category/description we *observe* for ERASURE_KEY may have been seeded
// by a prior migration ("ops") rather than by this suite ("privacy_admin").
// We cache the actual values at startup and assert against those, so the
// test catches a regression where the JOIN goes null without false-failing
// on a benign seed-data choice.
let registryCategory: string | null = null;
let registryDescription: string | null = null;

async function insertAudit(opts: {
  userId: number;
  channel: string;
  reason: string | null;
  createdAt?: Date;
  notificationKey?: string;
}) {
  const [row] = await db.insert(notificationAuditLogTable).values({
    notificationKey: opts.notificationKey ?? ERASURE_KEY,
    userId: opts.userId,
    channel: opts.channel,
    status: "skipped",
    reason: opts.reason,
    payload: { test: true },
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  }).returning({ id: notificationAuditLogTable.id });
  insertedAuditIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const tag = uid("portal-notif-audit");
  const [org] = await db.insert(organizationsTable).values({
    name: `Portal Notification Audit ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-user`,
    username: `${tag}_user`,
    displayName: "Audit User",
    email: `${tag}@example.com`,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  const [other] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-other`,
    username: `${tag}_other`,
    displayName: "Other User",
    email: `${tag}-other@example.com`,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  otherUserId = other.id;

  // The registry row is shared global state — only seed it if some other
  // task hasn't already created it, so this suite is safe to run alongside
  // production-like fixtures. We track whether *we* created it so cleanup
  // doesn't yank a row another suite relied on.
  const [existing] = await db.select({
    key: notificationTypeRegistryTable.key,
    category: notificationTypeRegistryTable.category,
    description: notificationTypeRegistryTable.description,
  })
    .from(notificationTypeRegistryTable)
    .where(eq(notificationTypeRegistryTable.key, ERASURE_KEY));
  if (!existing) {
    await db.insert(notificationTypeRegistryTable).values({
      key: ERASURE_KEY,
      category: ERASURE_CATEGORY,
      description: ERASURE_DESC,
      defaultChannels: ["email", "push"],
      transactional: true,
      digestable: false,
      auditRequired: true,
    });
    registrySeeded = true;
    registryCategory = ERASURE_CATEGORY;
    registryDescription = ERASURE_DESC;
  } else {
    registryCategory = existing.category;
    registryDescription = existing.description;
  }
});

afterAll(async () => {
  if (insertedAuditIds.length > 0) {
    await db.delete(notificationAuditLogTable)
      .where(inArray(notificationAuditLogTable.id, insertedAuditIds));
  }
  if (registrySeeded) {
    await db.delete(notificationTypeRegistryTable)
      .where(eq(notificationTypeRegistryTable.key, ERASURE_KEY));
  }
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [userId, otherUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("GET /api/portal/notification-audit — auth", () => {
  it("returns 401 when the caller is not authenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/portal/notification-audit");
    expect(res.status).toBe(401);
  });

  // The audit log includes potentially sensitive notification payloads
  // (member ids, dataset keys). A regression that scoped the read by
  // `organizationId` instead of `userId` would silently leak across
  // controllers in the same club, so we assert isolation explicitly.
  it("never returns rows belonging to a different user", async () => {
    await insertAudit({ userId: otherUserId, channel: "email", reason: "event_opted_out" });
    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });

    const res = await request(app).get("/api/portal/notification-audit");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    for (const entry of res.body.entries as Array<{ id: number }>) {
      // The id space is shared, so we assert via "no row that belongs to
      // the other user is present" rather than just counting — the latter
      // would silently pass if the route also returned this user's rows.
      expect(insertedAuditIds).toContain(entry.id);
    }
    expect(res.body.entries.every((e: { id: number }) => e.id !== insertedAuditIds[0])).toBe(true);
  });
});

describe("GET /api/portal/notification-audit — kind discriminator", () => {
  it("labels event_opted_out rows as 'user_muted' and other reasons as 'system_suppressed'", async () => {
    // Seed both halves of the canonical scenario: a controller who muted
    // both channels for the stuck-erasure digest *and* a system-side
    // suppression (e.g. address bounced). The endpoint should return both
    // and tag them differently so the UI can render distinct badges.
    const mutedEmailId = await insertAudit({ userId, channel: "email", reason: "event_opted_out" });
    const mutedPushId = await insertAudit({ userId, channel: "push", reason: "event_opted_out" });
    const systemId = await insertAudit({ userId, channel: "email", reason: "no_address" });

    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });
    const res = await request(app).get("/api/portal/notification-audit");
    expect(res.status).toBe(200);

    const byId = new Map<number, { kind: string; reason: string | null; channel: string; category: string | null; description: string | null; notificationKey: string }>(
      (res.body.entries as Array<{ id: number; kind: string; reason: string | null; channel: string; category: string | null; description: string | null; notificationKey: string }>)
        .map(e => [e.id, e]),
    );

    expect(byId.get(mutedEmailId)?.kind).toBe("user_muted");
    expect(byId.get(mutedPushId)?.kind).toBe("user_muted");
    expect(byId.get(systemId)?.kind).toBe("system_suppressed");

    // The UI relies on the joined registry data to label each row without
    // a second round-trip; if the LEFT JOIN regresses to an INNER JOIN the
    // category/description fields will go null and the UI will render as
    // an unlabelled row. Assert the join shape explicitly.
    expect(byId.get(mutedEmailId)?.category).toBe(registryCategory);
    expect(byId.get(mutedEmailId)?.description).toBe(registryDescription);
    expect(byId.get(mutedEmailId)?.notificationKey).toBe(ERASURE_KEY);
    // Beyond the specific seed values, the join must always populate
    // *something* on a registered key — a regression to LEFT-of-NULL would
    // surface the row with bare metadata and the UI would render an
    // unlabelled badge.
    expect(byId.get(mutedEmailId)?.category).not.toBeNull();
    expect(byId.get(mutedEmailId)?.description).not.toBeNull();
  });
});

describe("GET /api/portal/notification-audit — windowing, filtering, paging", () => {
  it("hides rows older than the default 30-day window but reveals them with ?days=90", async () => {
    const old = await insertAudit({
      userId,
      channel: "email",
      reason: "event_opted_out",
      // 60 days ago — outside the 30-day default, inside a 90-day window.
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    });

    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });
    const def = await request(app).get("/api/portal/notification-audit");
    expect(def.status).toBe(200);
    expect(def.body.windowDays).toBe(30);
    expect((def.body.entries as Array<{ id: number }>).some(e => e.id === old)).toBe(false);

    const wide = await request(app).get("/api/portal/notification-audit?days=90");
    expect(wide.status).toBe(200);
    expect(wide.body.windowDays).toBe(90);
    expect((wide.body.entries as Array<{ id: number }>).some(e => e.id === old)).toBe(true);
  });

  it("filters to a single notificationKey when ?key= is supplied", async () => {
    const matching = await insertAudit({ userId, channel: "email", reason: "event_opted_out" });
    const otherKey = await insertAudit({
      userId,
      channel: "email",
      reason: "event_opted_out",
      notificationKey: "totally.unrelated.alert",
    });

    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });
    const res = await request(app).get(`/api/portal/notification-audit?key=${encodeURIComponent(ERASURE_KEY)}`);
    expect(res.status).toBe(200);

    const ids = (res.body.entries as Array<{ id: number; notificationKey: string }>).map(e => e.id);
    expect(ids).toContain(matching);
    expect(ids).not.toContain(otherKey);
    for (const e of res.body.entries as Array<{ notificationKey: string }>) {
      expect(e.notificationKey).toBe(ERASURE_KEY);
    }
  });

  it("paginates via ?limit and surfaces a usable nextBefore cursor", async () => {
    // Use a unique notificationKey for this test so the `?key=` filter
    // gives us total ownership of the result set — earlier `it` blocks
    // insert ERASURE_KEY rows whose `defaultNow` createdAt could otherwise
    // shuffle past our pinned timestamps and break the cursor invariants.
    const pagingKey = `task1775.paging.${uid("k")}`;
    // Seed 3 rows with strictly-decreasing createdAt so the cursor
    // ordering is deterministic. Spacing of seconds dodges any same-ms
    // collisions on systems with low-resolution clocks.
    const t0 = Date.now();
    const newest = await insertAudit({ userId, channel: "email", reason: "event_opted_out", notificationKey: pagingKey, createdAt: new Date(t0 - 1_000) });
    const middle = await insertAudit({ userId, channel: "email", reason: "event_opted_out", notificationKey: pagingKey, createdAt: new Date(t0 - 5_000) });
    const oldest = await insertAudit({ userId, channel: "email", reason: "event_opted_out", notificationKey: pagingKey, createdAt: new Date(t0 - 9_000) });

    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });
    const page1 = await request(app)
      .get(`/api/portal/notification-audit?key=${encodeURIComponent(pagingKey)}&limit=2`);
    expect(page1.status).toBe(200);
    expect(page1.body.limit).toBe(2);

    // With our unique key, the result set is exactly 3 rows in newest-first
    // order — page 1 must be [newest, middle], hasMore=true, and the
    // cursor must point at `middle.createdAt` so the next page starts
    // strictly older.
    const page1Ids = (page1.body.entries as Array<{ id: number }>).map(e => e.id);
    expect(page1Ids).toEqual([newest, middle]);
    expect(page1.body.hasMore).toBe(true);
    expect(typeof page1.body.nextBefore).toBe("string");

    const page2 = await request(app)
      .get(`/api/portal/notification-audit?key=${encodeURIComponent(pagingKey)}&limit=2&before=${encodeURIComponent(page1.body.nextBefore)}`);
    expect(page2.status).toBe(200);
    const page2Ids = (page2.body.entries as Array<{ id: number }>).map(e => e.id);
    // The cursor advances strictly older — `newest` must not re-appear
    // and `oldest` must show up. `middle` may or may not, depending on
    // whether the cursor is `<` or `<=` (we use `<`), but `oldest`
    // landing here proves the cursor walked the full window.
    expect(page2Ids).not.toContain(newest);
    expect(page2Ids).toContain(oldest);
    expect(page2.body.hasMore).toBe(false);
  });
});
