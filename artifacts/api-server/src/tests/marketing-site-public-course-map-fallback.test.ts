/**
 * Task #1558 — Public course page falls back to the remembered mapper
 * centre (`mapDefaultLat`/`mapDefaultLng`, set by Task #1312) when an
 * admin hasn't explicitly entered course-level `latitude`/`longitude`.
 *
 * The public course detail endpoint feeds the schema.org GolfCourse
 * JSON-LD geo block and any future map markers on the public site, so a
 * silent fallback means newly mapped courses get a location pin without
 * the admin having to copy lat/lng twice.
 *
 * What's covered:
 *   - Course with explicit latitude/longitude returns those values
 *     verbatim, even if a remembered mapper centre is also stored
 *     (explicit values win).
 *   - Course with no latitude/longitude but a remembered mapper centre
 *     returns the remembered centre in the lat/lng fields.
 *   - Course with neither returns null lat/lng (no fabricated coords).
 */
process.env.SESSION_SECRET ||= "test-session-secret-public-course-map-fallback";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let orgSlug: string;
let courseExplicitId: number;
let courseFallbackId: number;
let courseUnknownId: number;
const slugExplicit = `course-explicit-${Date.now()}`;
const slugFallback = `course-fallback-${Date.now()}`;
const slugUnknown = `course-unknown-${Date.now()}`;

beforeAll(async () => {
  const stamp = Date.now();
  orgSlug = `test-public-course-map-fallback-${stamp}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PublicCourseMap_${stamp}`,
    slug: orgSlug,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  // Course with explicit lat/lng AND a separate remembered mapper centre.
  // The explicit values must win — we never want a mapper edit to silently
  // move a course that an admin has already pinned by hand.
  const [c1] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Explicit Coords Course",
    slug: slugExplicit,
    holes: 18,
    par: 72,
    isPublic: true,
    latitude: "40.0000000",
    longitude: "-75.0000000",
    mapDefaultLat: "10.0000000",
    mapDefaultLng: "-20.0000000",
    mapDefaultZoom: 15,
  }).returning({ id: coursesTable.id });
  courseExplicitId = c1.id;

  // Course with no explicit lat/lng but a remembered mapper centre.
  const [c2] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Mapper Centre Only Course",
    slug: slugFallback,
    holes: 18,
    par: 72,
    isPublic: true,
    mapDefaultLat: "37.7800000",
    mapDefaultLng: "-122.4200000",
    mapDefaultZoom: 16,
  }).returning({ id: coursesTable.id });
  courseFallbackId = c2.id;

  // Course with no coordinates at all.
  const [c3] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Unmapped Course",
    slug: slugUnknown,
    holes: 18,
    par: 72,
    isPublic: true,
  }).returning({ id: coursesTable.id });
  courseUnknownId = c3.id;
});

afterAll(async () => {
  await db.delete(coursesTable).where(inArray(coursesTable.id, [courseExplicitId, courseFallbackId, courseUnknownId]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgId]));
});

describe("Public course page — remembered mapper centre fallback (Task #1558)", () => {
  it("returns explicit latitude/longitude when set, even if a mapper centre also exists", async () => {
    const app = await createTestApp();
    const res = await request(app).get(`/api/public/clubs/${orgSlug}/courses/${slugExplicit}`);
    expect(res.status).toBe(200);
    expect(res.body.course.latitude).toBe("40.0000000");
    expect(res.body.course.longitude).toBe("-75.0000000");
  });

  it("falls back to the remembered mapper centre when latitude/longitude are unset", async () => {
    const app = await createTestApp();
    const res = await request(app).get(`/api/public/clubs/${orgSlug}/courses/${slugFallback}`);
    expect(res.status).toBe(200);
    expect(res.body.course.latitude).toBe("37.7800000");
    expect(res.body.course.longitude).toBe("-122.4200000");
  });

  it("returns null lat/lng when neither explicit coords nor a mapper centre are set", async () => {
    const app = await createTestApp();
    const res = await request(app).get(`/api/public/clubs/${orgSlug}/courses/${slugUnknown}`);
    expect(res.status).toBe(200);
    expect(res.body.course.latitude).toBeNull();
    expect(res.body.course.longitude).toBeNull();
  });
});
