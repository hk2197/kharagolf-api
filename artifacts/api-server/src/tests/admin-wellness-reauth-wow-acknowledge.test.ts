/**
 * Task #1578 — Tests for POST /api/admin/wellness-reauth-wow-drift/acknowledge.
 *
 * The drift tile in the admin dashboard surfaces the WoW needs_reauth drift
 * email rate-limit watermark. This endpoint lets admins click "Acknowledge
 * / snooze for N days" to bump that watermark forward so the cron evaluator
 * skips its next email; every click is recorded in
 * `wearable_reauth_wow_acknowledgments` for the postmortem audit trail.
 *
 * Covers:
 *   - 401 when unauthenticated.
 *   - 403 when the caller's role is not org_admin / tournament_director /
 *     super_admin.
 *   - 400 when snoozeDays is missing, non-numeric, fractional, < 1 or > 30.
 *   - Happy path: bumps watermark forward, inserts an audit row with the
 *     actor name/role + watermark before/after, and returns a fresh
 *     snapshot whose `nextEligibleAt` lands on `now + snoozeDays` and whose
 *     `lastAcknowledgment` reflects the just-inserted row.
 *   - Idempotent re-clicks: a second click overwrites the watermark again
 *     and inserts a *second* audit row (no UPSERT — the audit table is
 *     append-only).
 */
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
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
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

async function makeOrg(): Promise<number> {
  const slug = uid("ack-org");
  const [o] = await db.insert(organizationsTable).values({
    name: slug,
    slug,
  }).returning();
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeUser(orgId: number, role: string, name: { first: string; last: string }): Promise<number> {
  const username = uid("ack-user");
  // app_users has no first/last columns — display fields live on the
  // session user object that the route reads via req.user. We only need a
  // real DB row so the FK on the audit table resolves.
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: username,
    username,
    email: `${username}@example.test`,
    displayName: `${name.first} ${name.last}`,
    role: role as "org_admin" | "tournament_director" | "super_admin" | "player",
    organizationId: orgId,
  }).returning();
  createdUserIds.push(u.id);
  return u.id;
}

afterAll(async () => {
  if (createdOrgIds.length > 0) {
    // ack rows cascade via FK; orgs cascade users via the existing
    // organization_id FK, but we drop users explicitly first so role
    // changes during the test don't leave dangling FK rows.
    await db.delete(wearableReauthWowAcknowledgmentsTable)
      .where(inArray(wearableReauthWowAcknowledgmentsTable.organizationId, createdOrgIds));
    if (createdUserIds.length > 0) {
      await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
    }
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("POST /api/admin/wellness-reauth-wow-drift/acknowledge — auth gating", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 7 });
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not an admin role", async () => {
    const orgId = await makeOrg();
    const userId = await makeUser(orgId, "player", { first: "Bob", last: "Player" });
    const app = createTestApp({
      id: userId,
      username: "bob",
      role: "player",
      organizationId: orgId,
    });
    const res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 7 });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/wellness-reauth-wow-drift/acknowledge — input validation", () => {
  it("returns 400 when snoozeDays is missing or out of 1..30", async () => {
    const orgId = await makeOrg();
    const userId = await makeUser(orgId, "org_admin", { first: "Alice", last: "Admin" });
    const app = createTestApp({
      id: userId,
      username: "alice",
      role: "org_admin",
      organizationId: orgId,
    });

    // Missing
    let res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({});
    expect(res.status).toBe(400);

    // Zero
    res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 0 });
    expect(res.status).toBe(400);

    // Negative
    res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: -3 });
    expect(res.status).toBe(400);

    // Above cap
    res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 31 });
    expect(res.status).toBe(400);

    // Fractional
    res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 1.5 });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/wellness-reauth-wow-drift/acknowledge — happy path", () => {
  it("bumps watermark forward, audits the click, and returns a fresh snapshot", async () => {
    const orgId = await makeOrg();
    const userId = await makeUser(orgId, "org_admin", { first: "Alice", last: "Admin" });
    // Cast: route reads optional firstName/lastName off req.user even
    // though the helper's TestUser interface only declares the core
    // fields. Match what real session middleware would attach.
    const app = createTestApp({
      id: userId,
      username: "alice",
      role: "org_admin",
      organizationId: orgId,
      firstName: "Alice",
      lastName: "Admin",
    } as Parameters<typeof createTestApp>[0]);

    const before = Date.now();
    const res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 14 });
    const after = Date.now();
    expect(res.status).toBe(200);

    // Watermark bumped to now + (14-7)*day so nextEligibleAt = now + 14d.
    const [org] = await db
      .select({ ts: organizationsTable.wearableReauthWowAlertLastSentAt })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(org.ts).not.toBeNull();
    const day = 24 * 60 * 60 * 1000;
    const wmMs = org.ts!.getTime();
    expect(wmMs).toBeGreaterThanOrEqual(before + 7 * day - 1000);
    expect(wmMs).toBeLessThanOrEqual(after + 7 * day + 1000);

    // Audit row inserted with snapshotted name/role and durations.
    const acks = await db.select().from(wearableReauthWowAcknowledgmentsTable)
      .where(eq(wearableReauthWowAcknowledgmentsTable.organizationId, orgId));
    expect(acks).toHaveLength(1);
    expect(acks[0].acknowledgedByUserId).toBe(userId);
    expect(acks[0].acknowledgedByName).toBe("Alice Admin");
    expect(acks[0].acknowledgedByRole).toBe("org_admin");
    expect(acks[0].snoozeDays).toBe(14);
    expect(acks[0].prevWatermark).toBeNull();
    expect(acks[0].newWatermark).not.toBeNull();

    // Returned snapshot exposes nextEligibleAt + lastAcknowledgment so the
    // dashboard can re-render in one round-trip.
    const snap = res.body as {
      org: {
        nextEligibleAt: string | null;
        lastAcknowledgment: { snoozeDays: number; acknowledgedByName: string | null } | null;
      } | null;
    };
    expect(snap.org).not.toBeNull();
    expect(snap.org!.nextEligibleAt).not.toBeNull();
    const nextMs = new Date(snap.org!.nextEligibleAt!).getTime();
    expect(nextMs).toBeGreaterThanOrEqual(before + 14 * day - 1000);
    expect(nextMs).toBeLessThanOrEqual(after + 14 * day + 1000);
    expect(snap.org!.lastAcknowledgment).not.toBeNull();
    expect(snap.org!.lastAcknowledgment!.snoozeDays).toBe(14);
    expect(snap.org!.lastAcknowledgment!.acknowledgedByName).toBe("Alice Admin");
  });

  // Task #1970 — runaway-snooze cap. Without this, the same admin can
  // click "snooze for 30 days" indefinitely and silence a real drift
  // forever. The endpoint must refuse with 429 once the org has logged
  // `WELLNESS_REAUTH_WOW_DEFAULT_MAX_SNOOZES_PER_30D` (= 5) clicks in
  // the trailing 30 days, while clicks older than 30 days must NOT
  // count toward the cap.
  it("refuses with 429 once the org has hit the 30-day snooze cap", async () => {
    const orgId = await makeOrg();
    const userId = await makeUser(orgId, "org_admin", { first: "Capped", last: "Admin" });
    const app = createTestApp({
      id: userId,
      username: "capped",
      role: "org_admin",
      organizationId: orgId,
    });

    // Pre-seed 5 fresh ack rows (within the trailing 30 days). The
    // cap is 5, so the next click should be rejected.
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await db.insert(wearableReauthWowAcknowledgmentsTable).values({
        organizationId: orgId,
        acknowledgedByUserId: userId,
        acknowledgedByName: "Capped Admin",
        acknowledgedByRole: "org_admin",
        snoozeDays: 7,
        prevWatermark: null,
        newWatermark: new Date(now - i * day + 7 * day),
        createdAt: new Date(now - i * day),
      });
    }

    const res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 7 });
    expect(res.status).toBe(429);
    const body = res.body as { error?: string; snoozeCountLast30d?: number; maxSnoozesPer30d?: number };
    expect(body.snoozeCountLast30d).toBe(5);
    expect(body.maxSnoozesPer30d).toBe(5);
    expect(body.error).toMatch(/snoozed 5 times in the last 30 days/);

    // No new audit row should have been written and the watermark
    // should not have been bumped.
    const rows = await db.select().from(wearableReauthWowAcknowledgmentsTable)
      .where(eq(wearableReauthWowAcknowledgmentsTable.organizationId, orgId));
    expect(rows).toHaveLength(5);
  });

  it("counts only ack rows from the trailing 30 days when enforcing the cap", async () => {
    const orgId = await makeOrg();
    const userId = await makeUser(orgId, "org_admin", { first: "Sliding", last: "Window" });
    const app = createTestApp({
      id: userId,
      username: "sliding",
      role: "org_admin",
      organizationId: orgId,
    });

    // 5 *ancient* clicks (>30 days ago) followed by 4 fresh clicks. The
    // ancient ones must NOT count, so the next click should still
    // succeed (4 + 1 = 5 ≤ cap 5).
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await db.insert(wearableReauthWowAcknowledgmentsTable).values({
        organizationId: orgId,
        acknowledgedByUserId: userId,
        acknowledgedByName: "Sliding Window",
        acknowledgedByRole: "org_admin",
        snoozeDays: 7,
        prevWatermark: null,
        newWatermark: new Date(now - (60 + i) * day + 7 * day),
        createdAt: new Date(now - (60 + i) * day),
      });
    }
    for (let i = 0; i < 4; i++) {
      await db.insert(wearableReauthWowAcknowledgmentsTable).values({
        organizationId: orgId,
        acknowledgedByUserId: userId,
        acknowledgedByName: "Sliding Window",
        acknowledgedByRole: "org_admin",
        snoozeDays: 7,
        prevWatermark: null,
        newWatermark: new Date(now - i * day + 7 * day),
        createdAt: new Date(now - i * day),
      });
    }

    // 5th fresh click — still within the cap.
    const ok = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 7 });
    expect(ok.status).toBe(200);

    // 6th fresh click — now over the cap; ancient rows are ignored.
    const blocked = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 7 });
    expect(blocked.status).toBe(429);
    expect((blocked.body as { snoozeCountLast30d?: number }).snoozeCountLast30d).toBe(5);
  });

  it("each click appends a new audit row and overwrites the watermark", async () => {
    const orgId = await makeOrg();
    const userId = await makeUser(orgId, "tournament_director", { first: "Tom", last: "Director" });
    const app = createTestApp({
      id: userId,
      username: "tom",
      role: "tournament_director",
      organizationId: orgId,
    });

    let res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 3 });
    expect(res.status).toBe(200);
    res = await request(app)
      .post("/api/admin/wellness-reauth-wow-drift/acknowledge")
      .send({ snoozeDays: 30 });
    expect(res.status).toBe(200);

    const acks = await db.select().from(wearableReauthWowAcknowledgmentsTable)
      .where(eq(wearableReauthWowAcknowledgmentsTable.organizationId, orgId));
    expect(acks).toHaveLength(2);
    // Second click captured the first click's watermark as prevWatermark.
    const second = acks.find(a => a.snoozeDays === 30)!;
    const first = acks.find(a => a.snoozeDays === 3)!;
    expect(second.prevWatermark).not.toBeNull();
    expect(first.newWatermark!.getTime()).toBe(second.prevWatermark!.getTime());
    expect(second.acknowledgedByRole).toBe("tournament_director");
  });
});
