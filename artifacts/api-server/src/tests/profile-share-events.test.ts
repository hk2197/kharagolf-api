/**
 * Integration tests for the profile-share analytics endpoints (Task #625).
 *
 *   POST /api/portal/me/profile-share-events
 *     - 401 when no portal session
 *     - 400 for invalid method
 *     - 400 when caller has no public handle reserved
 *     - 201 happy-path: row inserted with caller's handle, normalised
 *       method, and source whitelisted to "web"/"mobile"
 *
 *   GET  /api/portal/me/public-profile/share-stats
 *     - aggregates total + per-method counts for the caller only
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  profileShareEventsTable,
  profileShareDailyAggregatesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import { pruneAndRollupProfileShareEvents } from "../lib/profileShareRollup.js";

let orgId: number;
let userWithHandleId: number;
let userNoHandleId: number;
let userWithHandle: TestUser;
let userNoHandle: TestUser;

const stamp = Date.now();
const handle = `sharer${stamp}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_ProfileShare_${stamp}`,
    slug: `test-profileshare-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `pshare-a-${stamp}`,
    username: `pshare_a_${stamp}`,
    email: `pshare_a_${stamp}@example.com`,
    displayName: "Sharer Alpha",
    role: "player",
    organizationId: orgId,
    publicHandle: handle,
    publicProfileEnabled: true,
  }).returning({ id: appUsersTable.id });
  userWithHandleId = a.id;

  const [b] = await db.insert(appUsersTable).values({
    replitUserId: `pshare-b-${stamp}`,
    username: `pshare_b_${stamp}`,
    email: `pshare_b_${stamp}@example.com`,
    displayName: "No Handle",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userNoHandleId = b.id;

  userWithHandle = { id: userWithHandleId, username: `pshare_a_${stamp}`, role: "player", organizationId: orgId };
  userNoHandle = { id: userNoHandleId, username: `pshare_b_${stamp}`, role: "player", organizationId: orgId };
});

afterAll(async () => {
  await db.delete(profileShareEventsTable).where(eq(profileShareEventsTable.userId, userWithHandleId));
  await db.delete(profileShareEventsTable).where(eq(profileShareEventsTable.userId, userNoHandleId));
  await db.delete(profileShareDailyAggregatesTable).where(eq(profileShareDailyAggregatesTable.userId, userWithHandleId));
  await db.delete(profileShareDailyAggregatesTable).where(eq(profileShareDailyAggregatesTable.userId, userNoHandleId));
  if (userWithHandleId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userWithHandleId));
  if (userNoHandleId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userNoHandleId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("POST /api/portal/me/profile-share-events", () => {
  it("returns 401 when called without a portal session", async () => {
    const app = createTestApp();
    const r = await request(app)
      .post("/api/portal/me/profile-share-events")
      .send({ method: "copy", source: "web" });
    expect(r.status).toBe(401);
  });

  it("rejects unknown methods with 400", async () => {
    const app = createTestApp(userWithHandle);
    for (const bad of ["", "unknown", "click", "facebook", null]) {
      const r = await request(app)
        .post("/api/portal/me/profile-share-events")
        .send({ method: bad, source: "web" });
      expect(r.status, `method=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it("refuses to log a share when the caller has no public handle reserved", async () => {
    const app = createTestApp(userNoHandle);
    const r = await request(app)
      .post("/api/portal/me/profile-share-events")
      .send({ method: "copy", source: "web" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/handle/i);
  });

  it("inserts a row capturing handle, method, and a whitelisted source", async () => {
    const app = createTestApp(userWithHandle);
    const r = await request(app)
      .post("/api/portal/me/profile-share-events")
      .send({ method: "copy", source: "web" });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);

    const rows = await db
      .select()
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, userWithHandleId));
    const copyRow = rows.find(row => row.method === "copy");
    expect(copyRow).toBeDefined();
    expect(copyRow!.handle).toBe(handle);
    expect(copyRow!.source).toBe("web");
  });

  it("nulls out an unknown source rather than echoing client-supplied junk", async () => {
    const app = createTestApp(userWithHandle);
    const r = await request(app)
      .post("/api/portal/me/profile-share-events")
      .send({ method: "qr_open", source: "twitter" });
    expect(r.status).toBe(201);

    const rows = await db
      .select()
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, userWithHandleId));
    const qrRow = rows.find(row => row.method === "qr_open");
    expect(qrRow).toBeDefined();
    expect(qrRow!.source).toBeNull();
  });
});

describe("POST /api/public/p/:handle/share-events (Task #1083)", () => {
  it("inserts a row tagged with source=web for an unauthenticated visitor", async () => {
    const app = createTestApp(); // no session
    const r = await request(app)
      .post(`/api/public/p/${handle}/share-events`)
      .send({ method: "copy" });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    const rows = await db
      .select()
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, userWithHandleId));
    const visitorRow = rows.find(row => row.method === "copy" && row.source === "web");
    expect(visitorRow).toBeDefined();
    expect(visitorRow!.handle).toBe(handle);
    expect(visitorRow!.userId).toBe(userWithHandleId);
  });

  it("tags the row with source=mobile when a KHARAGOLF mobile visitor shares (Task #1243)", async () => {
    const app = createTestApp(); // no session — visitor flow
    const r = await request(app)
      .post(`/api/public/p/${handle}/share-events`)
      .send({ method: "native_share", source: "mobile" });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    const rows = await db
      .select()
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, userWithHandleId));
    const mobileRow = rows.find(row => row.method === "native_share" && row.source === "mobile");
    expect(mobileRow).toBeDefined();
    expect(mobileRow!.handle).toBe(handle);
    expect(mobileRow!.userId).toBe(userWithHandleId);
  });

  it("normalises an unknown source to 'web' rather than echoing client-supplied junk", async () => {
    // Snapshot the qr_open/web row count before, then send a qr_open with a
    // bogus source. The new row must land as source="web" — never echoed back
    // as "facebook" — so the unauthenticated endpoint can't be used to inject
    // arbitrary strings into the analytics column.
    const before = await db
      .select()
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, userWithHandleId));
    const beforeWebQr = before.filter(r => r.method === "qr_open" && r.source === "web").length;

    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/${handle}/share-events`)
      .send({ method: "qr_open", source: "facebook" });
    expect(r.status).toBe(201);

    const after = await db
      .select()
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, userWithHandleId));
    const afterWebQr = after.filter(r => r.method === "qr_open" && r.source === "web").length;
    expect(afterWebQr).toBe(beforeWebQr + 1);
    // And nothing landed with the junk source string.
    expect(after.some(r => r.source === "facebook")).toBe(false);
  });

  it("rejects unknown methods with 400", async () => {
    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/${handle}/share-events`)
      .send({ method: "facebook" });
    expect(r.status).toBe(400);
  });

  it("returns 404 for an unknown handle", async () => {
    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/no-such-handle-${stamp}/share-events`)
      .send({ method: "copy" });
    expect(r.status).toBe(404);
  });

  it("rate-limits a single IP hammering the same handle (429)", async () => {
    const { _resetRateLimiterForTests } = await import("../lib/publicRateLimit");
    await _resetRateLimiterForTests();
    const app = createTestApp();
    let saw429 = false;
    // The IP+handle bucket caps at 10; fire 12 to overflow.
    for (let i = 0; i < 12; i++) {
      const r = await request(app)
        .post(`/api/public/p/${handle}/share-events`)
        .send({ method: "copy" });
      if (r.status === 429) { saw429 = true; break; }
    }
    expect(saw429).toBe(true);
    await _resetRateLimiterForTests();
  });

  it("returns 404 for a profile that has opted out", async () => {
    const offHandle = `psevent-off-${stamp}`;
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `psevent-off-${stamp}`,
      username: `psevent_off_${stamp}`,
      email: `psevent_off_${stamp}@example.com`,
      displayName: "Opted Out",
      role: "player",
      organizationId: orgId,
      publicHandle: offHandle,
      publicProfileEnabled: false,
    }).returning({ id: appUsersTable.id });
    try {
      const app = createTestApp();
      const r = await request(app)
        .post(`/api/public/p/${offHandle}/share-events`)
        .send({ method: "copy" });
      expect(r.status).toBe(404);
    } finally {
      await db.delete(appUsersTable).where(eq(appUsersTable.id, u.id));
    }
  });
});

describe("GET /api/public/p/:handle/share-stats (Task #929)", () => {
  it("returns total share count for a public handle without auth", async () => {
    const app = createTestApp(); // no session
    const r = await request(app).get(`/api/public/p/${handle}/share-stats`);
    expect(r.status).toBe(200);
    expect(r.body.handle).toBe(handle);
    expect(typeof r.body.total).toBe("number");
    expect(r.body.total).toBeGreaterThanOrEqual(0);
  });

  it("returns 404 for an unknown handle", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/p/no-such-handle-${stamp}/share-stats`);
    expect(r.status).toBe(404);
  });

  it("returns 404 for a handle whose owner has disabled their public profile", async () => {
    // Reserve a handle but leave publicProfileEnabled = false so the share-stats
    // endpoint should treat the profile as if it doesn't exist (don't leak
    // existence of opted-out handles).
    const offHandle = `sharer-off-${stamp}`;
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `pshare-off-${stamp}`,
      username: `pshare_off_${stamp}`,
      email: `pshare_off_${stamp}@example.com`,
      displayName: "Opted Out",
      role: "player",
      organizationId: orgId,
      publicHandle: offHandle,
      publicProfileEnabled: false,
    }).returning({ id: appUsersTable.id });
    try {
      const app = createTestApp();
      const r = await request(app).get(`/api/public/p/${offHandle}/share-stats`);
      expect(r.status).toBe(404);
    } finally {
      await db.delete(appUsersTable).where(eq(appUsersTable.id, u.id));
    }
  });
});

describe("GET /api/portal/me/public-profile/share-stats", () => {
  it("aggregates total + per-method counts for the caller only", async () => {
    const app = createTestApp(userWithHandle);
    // Fire one more native_share so we have 3 distinct methods with counts.
    await request(app)
      .post("/api/portal/me/profile-share-events")
      .send({ method: "native_share", source: "mobile" });
    await request(app)
      .post("/api/portal/me/profile-share-events")
      .send({ method: "native_share", source: "mobile" });

    const r = await request(app).get("/api/portal/me/public-profile/share-stats");
    expect(r.status).toBe(200);
    expect(r.body.byMethod).toMatchObject({
      copy: expect.any(Number),
      web_share: expect.any(Number),
      native_share: expect.any(Number),
      qr_open: expect.any(Number),
    });
    // The previous block fired one `copy` and one `qr_open`; this block adds
    // two `native_share`s. `web_share` was never fired in this test run.
    expect(r.body.byMethod.copy).toBeGreaterThanOrEqual(1);
    expect(r.body.byMethod.qr_open).toBeGreaterThanOrEqual(1);
    expect(r.body.byMethod.native_share).toBeGreaterThanOrEqual(2);
    expect(r.body.byMethod.web_share).toBe(0);
    expect(r.body.total).toBe(
      r.body.byMethod.copy +
      r.body.byMethod.web_share +
      r.body.byMethod.native_share +
      r.body.byMethod.qr_open,
    );
  });

  it("splits raw events by source so the dashboard can show web vs mobile (Task #1458)", async () => {
    // Reset all events for this user so the source counts in this test are
    // deterministic regardless of what other blocks above persisted.
    await db.delete(profileShareEventsTable).where(eq(profileShareEventsTable.userId, userWithHandleId));

    const app = createTestApp(userWithHandle);
    // Two web shares (one from the authored portal copy + one from a public
    // visitor) and one mobile share — exactly the split the dashboard needs
    // to surface separately.
    await request(app)
      .post("/api/portal/me/profile-share-events")
      .send({ method: "copy", source: "web" });
    await request(app)
      .post(`/api/public/p/${handle}/share-events`)
      .send({ method: "copy", source: "web" });
    await request(app)
      .post(`/api/public/p/${handle}/share-events`)
      .send({ method: "native_share", source: "mobile" });

    const r = await request(app).get("/api/portal/me/public-profile/share-stats");
    expect(r.status).toBe(200);
    expect(r.body.bySource).toMatchObject({
      web: expect.any(Number),
      mobile: expect.any(Number),
    });
    expect(r.body.bySource.web).toBe(2);
    expect(r.body.bySource.mobile).toBe(1);
  });

  it("excludes legacy null-source rows from the bySource breakdown so untagged history doesn't skew the split (Task #1458)", async () => {
    // Replace the user's events with a mix of tagged + null-source rows.
    // The bySource split should only count tagged rows; the per-method
    // total continues to count everything (so owners still see complete
    // historical share volume).
    await db.delete(profileShareEventsTable).where(eq(profileShareEventsTable.userId, userWithHandleId));
    await db.insert(profileShareEventsTable).values([
      { userId: userWithHandleId, handle, method: "copy", source: "web" },
      { userId: userWithHandleId, handle, method: "copy", source: null },
      { userId: userWithHandleId, handle, method: "native_share", source: "mobile" },
    ]);

    const app = createTestApp(userWithHandle);
    const r = await request(app).get("/api/portal/me/public-profile/share-stats");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.bySource.web).toBe(1);
    expect(r.body.bySource.mobile).toBe(1);
    // Legacy null-source row is intentionally not counted in either bucket.
    expect(r.body.bySource.web + r.body.bySource.mobile).toBe(2);
  });

  it("keeps the bySource split accurate after old events get archived into the daily-aggregate rollup (Task #1781)", async () => {
    // Reset both tables for this user so the assertions are exact.
    await db.delete(profileShareEventsTable).where(eq(profileShareEventsTable.userId, userWithHandleId));
    await db.delete(profileShareDailyAggregatesTable).where(eq(profileShareDailyAggregatesTable.userId, userWithHandleId));

    // Backdate three events past the rollup window: 2 web + 1 mobile.
    // Without this fix, the daily aggregate would drop `source`, so
    // after the rollup the bySource chips would show 0/0 even though
    // total stays at 3.
    const aged = new Date("2024-04-05T08:00:00Z");
    await db.insert(profileShareEventsTable).values([
      { userId: userWithHandleId, handle, method: "copy", source: "web", createdAt: aged },
      { userId: userWithHandleId, handle, method: "copy", source: "web", createdAt: aged },
      { userId: userWithHandleId, handle, method: "native_share", source: "mobile", createdAt: aged },
    ]);

    const summary = await pruneAndRollupProfileShareEvents();
    expect(summary.rolledUpEvents).toBe(3);

    // The raw table is empty for this user post-rollup.
    const remaining = await db
      .select({ id: profileShareEventsTable.id })
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, userWithHandleId));
    expect(remaining).toHaveLength(0);

    // bySource is reconstructed entirely from the aggregate table.
    const app = createTestApp(userWithHandle);
    const r = await request(app).get("/api/portal/me/public-profile/share-stats");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.bySource).toEqual({ web: 2, mobile: 1 });
  });
});
