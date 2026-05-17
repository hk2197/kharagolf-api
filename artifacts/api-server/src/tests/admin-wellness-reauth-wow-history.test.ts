/**
 * Task #1969 — Tests for GET /api/admin/wellness-reauth-wow-drift/history.
 *
 * The drift tile in the admin dashboard already surfaces the *most recent*
 * Acknowledge / snooze click on a per-org basis. This endpoint backs the
 * expandable "View full snooze history" disclosure underneath that line:
 * it returns the N most recent rows from
 * `wearable_reauth_wow_acknowledgments` for the caller's org, newest-first,
 * capped at 20 by default and 50 hard max.
 *
 * Covers:
 *   - 401 when unauthenticated.
 *   - 403 when the caller's role is not org_admin / tournament_director /
 *     super_admin.
 *   - 400 when the caller has no organization (the audit trail is per-org
 *     by design — even super_admins without an org slot get a 400 rather
 *     than a global firehose).
 *   - Happy path: returns the org's audit rows newest-first, with each
 *     entry exposing actor name + role + snoozeDays + ISO timestamp, and
 *     the response includes the resolved `limit` value.
 *   - Strict org scoping: callers only see rows for *their* org, never a
 *     sibling org's clicks.
 *   - `?limit=N` clamping: 0 / negative / non-integer fall back to the
 *     default; values above the hard max are clamped to MAX_LIMIT; valid
 *     in-range values are honored.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/mailer.js")>();
  return { ...orig, sendBroadcastEmail: vi.fn(async () => undefined) };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  wearableReauthWowAcknowledgmentsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  WELLNESS_REAUTH_WOW_ACK_HISTORY_DEFAULT_LIMIT,
  WELLNESS_REAUTH_WOW_ACK_HISTORY_MAX_LIMIT,
} from "../lib/wearables.js";
import { createTestApp, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

async function makeOrg(): Promise<number> {
  const slug = uid("ack-hist-org");
  const [o] = await db.insert(organizationsTable).values({
    name: slug,
    slug,
  }).returning();
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeUser(orgId: number | null, role: string): Promise<number> {
  const username = uid("ack-hist-user");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: username,
    username,
    email: `${username}@example.test`,
    displayName: username,
    role: role as "org_admin" | "tournament_director" | "super_admin" | "player",
    organizationId: orgId,
  }).returning();
  createdUserIds.push(u.id);
  return u.id;
}

async function seedAck(opts: {
  orgId: number;
  userId?: number | null;
  name?: string | null;
  role?: string | null;
  snoozeDays: number;
  /** Offset from `now` in milliseconds for the row's createdAt timestamp. */
  offsetMs: number;
}): Promise<void> {
  const ts = new Date(Date.now() + opts.offsetMs);
  await db.insert(wearableReauthWowAcknowledgmentsTable).values({
    organizationId: opts.orgId,
    acknowledgedByUserId: opts.userId ?? null,
    acknowledgedByName: opts.name ?? null,
    acknowledgedByRole: opts.role ?? null,
    snoozeDays: opts.snoozeDays,
    prevWatermark: null,
    newWatermark: ts,
    createdAt: ts,
  });
}

afterAll(async () => {
  if (createdOrgIds.length > 0) {
    await db.delete(wearableReauthWowAcknowledgmentsTable)
      .where(inArray(wearableReauthWowAcknowledgmentsTable.organizationId, createdOrgIds));
    if (createdUserIds.length > 0) {
      await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
    }
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("GET /api/admin/wellness-reauth-wow-drift/history — auth gating", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/admin/wellness-reauth-wow-drift/history");
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not an admin role", async () => {
    const orgId = await makeOrg();
    const userId = await makeUser(orgId, "player");
    const app = createTestApp({
      id: userId, username: "player", role: "player", organizationId: orgId,
    });
    const res = await request(app).get("/api/admin/wellness-reauth-wow-drift/history");
    expect(res.status).toBe(403);
  });

  it("returns 400 when the caller has no organization", async () => {
    const userId = await makeUser(null, "super_admin");
    const app = createTestApp({
      id: userId, username: "root", role: "super_admin", organizationId: null,
    });
    const res = await request(app).get("/api/admin/wellness-reauth-wow-drift/history");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/admin/wellness-reauth-wow-drift/history — happy path", () => {
  it("returns the org's audit rows newest-first with name + role + snoozeDays", async () => {
    const orgId = await makeOrg();
    const userId = await makeUser(orgId, "org_admin");
    // Seed three rows with strictly increasing offsets so the order is
    // unambiguous regardless of insert latency.
    await seedAck({ orgId, userId, name: "Alice Admin", role: "org_admin", snoozeDays: 1, offsetMs: -3 * 86_400_000 });
    await seedAck({ orgId, userId, name: "Tom Director", role: "tournament_director", snoozeDays: 7, offsetMs: -2 * 86_400_000 });
    await seedAck({ orgId, userId, name: "Carol Owner", role: "super_admin", snoozeDays: 30, offsetMs: -1 * 86_400_000 });

    const app = createTestApp({
      id: userId, username: "alice", role: "org_admin", organizationId: orgId,
    });
    const res = await request(app).get("/api/admin/wellness-reauth-wow-drift/history");
    expect(res.status).toBe(200);

    const body = res.body as {
      organizationId: number;
      limit: number;
      entries: Array<{
        acknowledgedAt: string;
        acknowledgedByName: string | null;
        acknowledgedByRole: string | null;
        snoozeDays: number;
      }>;
    };
    expect(body.organizationId).toBe(orgId);
    expect(body.limit).toBe(WELLNESS_REAUTH_WOW_ACK_HISTORY_DEFAULT_LIMIT);
    expect(body.entries).toHaveLength(3);
    // Newest-first: Carol (snoozed 30, t=-1d) > Tom (7, -2d) > Alice (1, -3d).
    expect(body.entries[0].acknowledgedByName).toBe("Carol Owner");
    expect(body.entries[0].acknowledgedByRole).toBe("super_admin");
    expect(body.entries[0].snoozeDays).toBe(30);
    expect(body.entries[1].acknowledgedByName).toBe("Tom Director");
    expect(body.entries[1].snoozeDays).toBe(7);
    expect(body.entries[2].acknowledgedByName).toBe("Alice Admin");
    expect(body.entries[2].snoozeDays).toBe(1);
    // Timestamps are ISO strings, monotonically decreasing.
    const timestamps = body.entries.map(e => Date.parse(e.acknowledgedAt));
    expect(timestamps[0]).toBeGreaterThan(timestamps[1]);
    expect(timestamps[1]).toBeGreaterThan(timestamps[2]);
  });

  it("scopes results strictly to the caller's org", async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const adminA = await makeUser(orgA, "org_admin");
    await seedAck({ orgId: orgA, userId: adminA, name: "A-1", role: "org_admin", snoozeDays: 5, offsetMs: -1 * 86_400_000 });
    await seedAck({ orgId: orgB, name: "B-1", role: "org_admin", snoozeDays: 10, offsetMs: -1 * 86_400_000 });
    await seedAck({ orgId: orgB, name: "B-2", role: "org_admin", snoozeDays: 20, offsetMs: -2 * 86_400_000 });

    const app = createTestApp({
      id: adminA, username: "a-admin", role: "org_admin", organizationId: orgA,
    });
    const res = await request(app).get("/api/admin/wellness-reauth-wow-drift/history");
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ acknowledgedByName: string | null }> };
    // Only the row for orgA should appear — no leak of orgB rows.
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].acknowledgedByName).toBe("A-1");
  });
});

describe("GET /api/admin/wellness-reauth-wow-drift/history — limit clamping", () => {
  it("honors a valid in-range ?limit and clamps above-MAX values to the hard max", async () => {
    const orgId = await makeOrg();
    const userId = await makeUser(orgId, "org_admin");
    // Seed 5 rows.
    for (let i = 0; i < 5; i++) {
      await seedAck({
        orgId, userId, name: `User-${i}`, role: "org_admin",
        snoozeDays: i + 1, offsetMs: -(i + 1) * 60_000,
      });
    }
    const app = createTestApp({
      id: userId, username: "alice", role: "org_admin", organizationId: orgId,
    });

    // Valid in-range limit honored.
    let res = await request(app).get("/api/admin/wellness-reauth-wow-drift/history?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(2);
    expect(res.body.entries).toHaveLength(2);

    // Above hard max clamps to MAX_LIMIT (still returns all 5 rows because
    // there are fewer than MAX_LIMIT seeded).
    res = await request(app).get("/api/admin/wellness-reauth-wow-drift/history?limit=999");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(WELLNESS_REAUTH_WOW_ACK_HISTORY_MAX_LIMIT);
    expect(res.body.entries).toHaveLength(5);
  });

  it("falls back to the default for malformed / non-positive ?limit values", async () => {
    const orgId = await makeOrg();
    const userId = await makeUser(orgId, "org_admin");
    await seedAck({ orgId, userId, name: "Alice", role: "org_admin", snoozeDays: 1, offsetMs: -60_000 });
    const app = createTestApp({
      id: userId, username: "alice", role: "org_admin", organizationId: orgId,
    });

    for (const bad of ["abc", "0", "-3", "1.5"]) {
      const res = await request(app).get(`/api/admin/wellness-reauth-wow-drift/history?limit=${bad}`);
      expect(res.status).toBe(200);
      // Even malformed values should produce a response, defaulted.
      expect(res.body.limit).toBe(WELLNESS_REAUTH_WOW_ACK_HISTORY_DEFAULT_LIMIT);
    }
  });
});
