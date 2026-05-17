/**
 * Task #626 — Coverage for the per-IP / per-course rate limit on the
 * unauthenticated public photo + review submission endpoints.
 *
 * The endpoints under test live in `routes/marketing-site.ts`:
 *   POST /api/public/clubs/:slug/courses/:courseSlug/photos/upload-url
 *   POST /api/public/clubs/:slug/courses/:courseSlug/photos
 *   POST /api/public/clubs/:slug/courses/:courseSlug/reviews
 *   POST /api/public/course-reviews/:reviewId/report
 *
 * We don't need real object storage to prove the limiter — the limit is
 * enforced *before* we touch storage on the upload-URL/finalise paths,
 * and the review + report paths don't touch storage at all. Each test
 * case resets the in-memory bucket map between runs so they're isolated.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-rl";
process.env.PRIVATE_OBJECT_DIR ||= "/test-bucket/private";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  courseReviewsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { _resetRateLimiterForTests } from "../lib/publicRateLimit.js";

/**
 * Production sets `app.set("trust proxy", true)` (see `src/app.ts`) so
 * `req.ip` reflects the real client address forwarded by the reverse
 * proxy. The shared test helper deliberately does not enable that, so
 * we opt-in here to mirror production behaviour for the trust-proxy
 * tests below.
 */
function makeTrustedApp() {
  const app = createTestApp();
  app.set("trust proxy", true);
  return app;
}

let orgId: number;
let courseId: number;
let courseSlug: string;
let orgSlug: string;
let reviewId: number;
const createdReviewIds: number[] = [];

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `RL_Org_${stamp}`,
    slug: `rl-org-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id, slug: organizationsTable.slug });
  orgId = org.id;
  orgSlug = org.slug!;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: `RL Course ${stamp}`,
    slug: `rl-course-${stamp}`.toLowerCase(),
  }).returning({ id: coursesTable.id, slug: coursesTable.slug });
  courseId = course.id;
  courseSlug = course.slug!;

  // Seed an approved review row to exercise the report endpoint.
  const [r] = await db.insert(courseReviewsTable).values({
    organizationId: orgId,
    courseId,
    reviewerDisplayName: "Test Reviewer",
    reviewerEmail: "rev@example.com",
    rating: 4,
    status: "approved",
  }).returning({ id: courseReviewsTable.id });
  reviewId = r.id;
  createdReviewIds.push(reviewId);
});

afterAll(async () => {
  if (createdReviewIds.length) {
    await db.delete(courseReviewsTable).where(inArray(courseReviewsTable.id, createdReviewIds));
  }
  await db.delete(coursesTable).where(inArray(coursesTable.id, [courseId]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgId]));
});

beforeEach(async () => {
  await _resetRateLimiterForTests();
});

const photoUploadUrl = () =>
  `/api/public/clubs/${orgSlug}/courses/${courseSlug}/photos/upload-url`;
const photoSubmit = () =>
  `/api/public/clubs/${orgSlug}/courses/${courseSlug}/photos`;
const reviewSubmit = () =>
  `/api/public/clubs/${orgSlug}/courses/${courseSlug}/reviews`;
const reportUrl = (id: number) => `/api/public/course-reviews/${id}/report`;

describe("public photo upload-URL rate limit", () => {
  it("returns 429 with Retry-After once the per-IP+course bucket is exhausted", async () => {
    const app = makeTrustedApp();
    // Per the limiter config: 10 photo-url calls per IP+course.
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const r = await request(app)
        .post(photoUploadUrl())
        .set("X-Forwarded-For", "9.9.9.1")
        .send({ contentType: "image/jpeg", size: 1000 });
      // Without real GCS the issuance can 500, but it must NOT be 429
      // for the first 10 calls regardless of storage outcome.
      expect(r.status).not.toBe(429);
      lastStatus = r.status;
    }
    expect(lastStatus).not.toBe(429);

    const blocked = await request(app)
      .post(photoUploadUrl())
      .set("X-Forwarded-For", "9.9.9.1")
      .send({ contentType: "image/jpeg", size: 1000 });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(parseInt(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.body.error).toMatch(/too many/i);
  });

  it("does not throttle a different IP for the same course", async () => {
    const app = makeTrustedApp();
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post(photoUploadUrl())
        .set("X-Forwarded-For", "1.1.1.1")
        .send({ contentType: "image/jpeg", size: 1000 });
    }
    // The first IP is now blocked at the IP+course bucket; a fresh IP
    // should still be allowed (its own IP bucket has a full allotment).
    const fresh = await request(app)
      .post(photoUploadUrl())
      .set("X-Forwarded-For", "2.2.2.2")
      .send({ contentType: "image/jpeg", size: 1000 });
    expect(fresh.status).not.toBe(429);
  });
});

describe("public photo submit rate limit", () => {
  it("returns 429 once the per-IP+course bucket is exhausted (before object validation)", async () => {
    const app = makeTrustedApp();
    // 10 per IP+course. Each call has a bogus token so it would otherwise
    // fall through to a 403 — but rate-limit fires first on the 11th call.
    for (let i = 0; i < 10; i++) {
      const r = await request(app)
        .post(photoSubmit())
        .set("X-Forwarded-For", "9.9.9.2")
        .send({ objectPath: "/objects/x", uploadToken: "bogus" });
      expect(r.status).not.toBe(429);
    }
    const blocked = await request(app)
      .post(photoSubmit())
      .set("X-Forwarded-For", "9.9.9.2")
      .send({ objectPath: "/objects/x", uploadToken: "bogus" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });
});

describe("public course-review submission rate limit", () => {
  it("blocks the same IP after 3 review submissions on one course", async () => {
    const app = makeTrustedApp();
    // Per-IP+course cap is 3/hr (the tightest bucket for a single IP
    // hammering one course).
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post(reviewSubmit())
        .set("X-Forwarded-For", "9.9.9.3")
        .send({
          rating: 5,
          reviewerDisplayName: `Spammer ${i}`,
          reviewerEmail: `s${i}@example.com`,
          body: "spam",
        });
      expect(r.status).toBe(201);
      createdReviewIds.push(r.body.id);
    }
    const blocked = await request(app)
      .post(reviewSubmit())
      .set("X-Forwarded-For", "9.9.9.3")
      .send({
        rating: 5,
        reviewerDisplayName: "Spammer extra",
        reviewerEmail: "extra@example.com",
        body: "spam",
      });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(parseInt(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("blocks the per-course bucket once it's drained across many IPs", async () => {
    const app = makeTrustedApp();
    // Per-course cap is 30/hr. Spread across unique IPs so the per-IP
    // cap (5) doesn't kick in first.
    for (let i = 0; i < 30; i++) {
      const r = await request(app)
        .post(reviewSubmit())
        .set("X-Forwarded-For", `10.0.0.${i + 10}`)
        .send({
          rating: 4,
          reviewerDisplayName: `Drive ${i}`,
          reviewerEmail: `drv${i}@example.com`,
          body: "ok",
        });
      expect(r.status).toBe(201);
      createdReviewIds.push(r.body.id);
    }
    const blocked = await request(app)
      .post(reviewSubmit())
      .set("X-Forwarded-For", "10.99.99.99")
      .send({
        rating: 3,
        reviewerDisplayName: "Last",
        reviewerEmail: "last@example.com",
        body: "ok",
      });
    expect(blocked.status).toBe(429);
  });
});

describe("spoof-resistance", () => {
  it("ignores X-Forwarded-For when trust-proxy is disabled (default test app)", async () => {
    // The default test app does NOT enable trust proxy, mirroring an
    // unconfigured deployment. A spammer rotating fake X-Forwarded-For
    // headers must not be able to refill their per-IP+course bucket —
    // every request should bucket against the real socket address.
    const app = createTestApp();
    let blockedAt = -1;
    for (let i = 0; i < 15; i++) {
      const r = await request(app)
        .post(photoSubmit())
        // Each request claims a different upstream client IP. If our
        // limiter were trusting this header without proxy verification
        // the spammer would never hit 429.
        .set("X-Forwarded-For", `5.5.5.${i}`)
        .send({ objectPath: "/objects/x", uploadToken: "bogus" });
      if (r.status === 429) { blockedAt = i; break; }
    }
    expect(blockedAt).toBeGreaterThanOrEqual(0);
    expect(blockedAt).toBeLessThanOrEqual(10);
  });
});

describe("horizontally-scaled enforcement (Task #784 regression)", () => {
  it("never lets two app instances jointly exceed the per-IP+course bucket", async () => {
    // Two independently-built Express apps, mimicking two API replicas
    // sitting behind a load balancer. They share the same Postgres-backed
    // bucket store, so the combined throughput across both must equal
    // the configured capacity exactly — never double-spend.
    const appA = makeTrustedApp();
    const appB = makeTrustedApp();

    // Per-IP+course cap on review submissions is 3/hr (the tightest
    // bucket for one IP hammering one course). Fire 5 requests at each
    // replica concurrently — 10 in total against capacity 3.
    const PER_REPLICA = 5;
    const CAPACITY = 3; // matches reviewSubmitScopes(...) per-IP+course
    const ip = "9.9.9.42";

    const fire = (app: ReturnType<typeof makeTrustedApp>, tag: string, i: number) =>
      request(app)
        .post(reviewSubmit())
        .set("X-Forwarded-For", ip)
        .send({
          rating: 5,
          reviewerDisplayName: `${tag}-${i}`,
          reviewerEmail: `${tag}-${i}@example.com`,
          body: "concurrent",
        });

    const launches: Promise<request.Response>[] = [];
    for (let i = 0; i < PER_REPLICA; i++) {
      launches.push(fire(appA, "A", i));
      launches.push(fire(appB, "B", i));
    }
    const results = await Promise.all(launches);

    const accepted = results.filter((r) => r.status === 201);
    const blocked = results.filter((r) => r.status === 429);

    // Track for cleanup so afterAll doesn't leak rows.
    for (const r of accepted) createdReviewIds.push(r.body.id);

    // The combined accepted count must equal capacity exactly, with the
    // remainder all 429s. No request may slip through on a double-spend
    // race, and no request may be wrongly rejected when capacity remains.
    expect(accepted.length).toBe(CAPACITY);
    expect(blocked.length).toBe(PER_REPLICA * 2 - CAPACITY);
    // And the 429s should still carry a valid Retry-After hint.
    for (const b of blocked) {
      expect(b.headers["retry-after"]).toBeDefined();
      expect(parseInt(b.headers["retry-after"])).toBeGreaterThan(0);
    }
  });
});

describe("public review-report rate limit", () => {
  it("blocks an IP after repeated reports against the same review", async () => {
    const app = makeTrustedApp();
    // Per-IP+review cap is 3/hr.
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post(reportUrl(reviewId))
        .set("X-Forwarded-For", "9.9.9.4")
        .send({ reason: `dupe report ${i}` });
      expect(r.status).toBe(202);
    }
    const blocked = await request(app)
      .post(reportUrl(reviewId))
      .set("X-Forwarded-For", "9.9.9.4")
      .send({ reason: "one more" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });
});
