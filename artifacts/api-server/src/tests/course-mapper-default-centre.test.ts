/**
 * Integration tests: Task #1312 — "Remember each course's location so the
 * mapper opens there next time".
 *
 * Covers PUT /api/organizations/:orgId/courses/:courseId/map-center and
 * verifies the new `mapDefault*` columns are returned by GET /:courseId
 * so the mapper UI can fly straight to the saved centre.
 *
 *   - happy path: an org admin can save a lat/lng/zoom triple and read
 *     it back through the standard course detail endpoint.
 *   - clearing: passing { mapDefaultLat: null, mapDefaultLng: null }
 *     resets both columns and the optional zoom.
 *   - validation: non-finite or out-of-range lat/lng/zoom return 400; a
 *     half-supplied pair (lat without lng) is rejected; an out-of-range
 *     zoom is rejected.
 *   - authorization: unauthenticated 401, a player on the same org gets
 *     403 (admin-only mutation), a wrong-org admin gets 404 (tenant
 *     scoping — never reveal the course's existence cross-tenant).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let courseAId: number;
let adminUserId: number;
let playerUserId: number;
let otherOrgAdminUserId: number;
let admin: TestUser;
let player: TestUser;
let otherOrgAdmin: TestUser;

const URL = () => `/api/organizations/${orgAId}/courses/${courseAId}/map-center`;
const COURSE_URL = () => `/api/organizations/${orgAId}/courses/${courseAId}`;

beforeAll(async () => {
  const stamp = Date.now();
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_MapCentreA_${stamp}`,
    slug: `test-map-centre-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_MapCentreB_${stamp}`,
    slug: `test-map-centre-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [courseA] = await db.insert(coursesTable).values({
    organizationId: orgAId,
    name: "Map Centre Course A",
    slug: `map-centre-course-a-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseAId = courseA.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-map-centre-admin-${stamp}`,
    username: `map_centre_admin_${stamp}`,
    email: `map_centre_admin_${stamp}@example.com`,
    displayName: "Map Centre Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [playerRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-map-centre-player-${stamp}`,
    username: `map_centre_player_${stamp}`,
    email: `map_centre_player_${stamp}@example.com`,
    displayName: "Player",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerUserId = playerRow.id;

  const [otherAdminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-map-centre-other-admin-${stamp}`,
    username: `map_centre_other_admin_${stamp}`,
    email: `map_centre_other_admin_${stamp}@example.com`,
    displayName: "Other Org Admin",
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  otherOrgAdminUserId = otherAdminRow.id;

  admin = {
    id: adminUserId,
    username: `map_centre_admin_${stamp}`,
    role: "org_admin",
    organizationId: orgAId,
  };
  player = {
    id: playerUserId,
    username: `map_centre_player_${stamp}`,
    role: "player",
    organizationId: orgAId,
  };
  otherOrgAdmin = {
    id: otherOrgAdminUserId,
    username: `map_centre_other_admin_${stamp}`,
    role: "org_admin",
    organizationId: orgBId,
  };
});

afterAll(async () => {
  if (courseAId) await db.delete(coursesTable).where(eq(coursesTable.id, courseAId));
  for (const id of [adminUserId, playerUserId, otherOrgAdminUserId]) {
    if (id) await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

describe("PUT /courses/:id/map-center — happy path", () => {
  it("saves the centre and zoom and returns them on the next GET", async () => {
    const app = createTestApp(admin);

    const lat = 33.503;
    const lng = -82.0204;
    const zoom = 17;
    const put = await request(app).put(URL()).send({
      mapDefaultLat: lat,
      mapDefaultLng: lng,
      mapDefaultZoom: zoom,
    });
    expect(put.status).toBe(200);
    // numeric() round-trips as string from drizzle/pg; coerce in test.
    expect(Number(put.body.mapDefaultLat)).toBeCloseTo(lat, 5);
    expect(Number(put.body.mapDefaultLng)).toBeCloseTo(lng, 5);
    expect(put.body.mapDefaultZoom).toBe(zoom);

    const get = await request(app).get(COURSE_URL());
    expect(get.status).toBe(200);
    expect(Number(get.body.mapDefaultLat)).toBeCloseTo(lat, 5);
    expect(Number(get.body.mapDefaultLng)).toBeCloseTo(lng, 5);
    expect(get.body.mapDefaultZoom).toBe(zoom);
  });

  it("preserves a legitimate 0° lat/lng pair (equator / prime meridian)", async () => {
    // Regression for the truthiness-vs-null bug spotted in code review:
    // a course on the equator or prime meridian must not be treated as
    // "no centre" and silently overwritten on subsequent saves. Here we
    // exercise the storage layer directly — the frontend has its own
    // analogous fix in `noStoredCentre`.
    const app = createTestApp(admin);
    const put = await request(app).put(URL()).send({
      mapDefaultLat: 0,
      mapDefaultLng: 0,
      mapDefaultZoom: 12,
    });
    expect(put.status).toBe(200);
    expect(Number(put.body.mapDefaultLat)).toBe(0);
    expect(Number(put.body.mapDefaultLng)).toBe(0);
    expect(put.body.mapDefaultZoom).toBe(12);

    const get = await request(app).get(COURSE_URL());
    expect(get.status).toBe(200);
    expect(Number(get.body.mapDefaultLat)).toBe(0);
    expect(Number(get.body.mapDefaultLng)).toBe(0);
    expect(get.body.mapDefaultZoom).toBe(12);
  });

  it("clears the centre when both lat and lng are null", async () => {
    const app = createTestApp(admin);
    // Seed a value first so we can prove the clear actually clears.
    await request(app).put(URL()).send({
      mapDefaultLat: 10,
      mapDefaultLng: 20,
      mapDefaultZoom: 15,
    });

    const cleared = await request(app).put(URL()).send({
      mapDefaultLat: null,
      mapDefaultLng: null,
      mapDefaultZoom: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.mapDefaultLat).toBeNull();
    expect(cleared.body.mapDefaultLng).toBeNull();
    expect(cleared.body.mapDefaultZoom).toBeNull();
  });
});

describe("PUT /courses/:id/map-center — validation", () => {
  it("rejects out-of-range latitude", async () => {
    const app = createTestApp(admin);
    const res = await request(app).put(URL()).send({
      mapDefaultLat: 95,
      mapDefaultLng: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mapDefaultLat/);
  });

  it("rejects out-of-range longitude", async () => {
    const app = createTestApp(admin);
    const res = await request(app).put(URL()).send({
      mapDefaultLat: 0,
      mapDefaultLng: 200,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mapDefaultLng/);
  });

  it("rejects a half-supplied pair (lat without lng)", async () => {
    const app = createTestApp(admin);
    const res = await request(app).put(URL()).send({
      mapDefaultLat: 33.5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/together/);
  });

  it("rejects an out-of-range zoom", async () => {
    const app = createTestApp(admin);
    const res = await request(app).put(URL()).send({
      mapDefaultLat: 0,
      mapDefaultLng: 0,
      mapDefaultZoom: 99,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mapDefaultZoom/);
  });
});

describe("PUT /courses/:id/map-center — authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).put(URL()).send({
      mapDefaultLat: 0,
      mapDefaultLng: 0,
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin player on the same org", async () => {
    const app = createTestApp(player);
    const res = await request(app).put(URL()).send({
      mapDefaultLat: 0,
      mapDefaultLng: 0,
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an admin from a different org (tenant scoping)", async () => {
    const app = createTestApp(otherOrgAdmin);
    // The wrong-org admin has admin role, so requireOrgAdmin passes for
    // their own org id in the URL — but we wired the URL to orgAId
    // here, where they are NOT an admin, so we expect 403 from that
    // guard rather than a leak through to the not-found check.
    const res = await request(app)
      .put(`/api/organizations/${orgBId}/courses/${courseAId}/map-center`)
      .send({ mapDefaultLat: 0, mapDefaultLng: 0 });
    // The guard matches by user.organizationId vs URL :orgId, then the
    // route's tenant-scope SELECT confirms the course belongs to the
    // org. Course A lives in orgA, so the orgB admin's URL of orgB +
    // courseA returns 404 — never revealing that courseA exists.
    expect(res.status).toBe(404);
  });
});
