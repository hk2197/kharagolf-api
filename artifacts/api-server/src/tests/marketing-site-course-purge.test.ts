/**
 * Task #799 — Verify that PATCH /api/organizations/:orgId/marketing-site/
 * courses/:courseId/public-fields fires a best-effort POST to the marketing
 * website's `/__ssr/purge` endpoint so admins see edits immediately rather
 * than waiting for the ~60s in-memory TTL (Task #632).
 *
 * The original SSR-cache implementation was hand-tested with curl. This
 * suite locks the call signature in so a future refactor of the purge
 * helper, the marketing-site router, or the env-var contract can't
 * silently break the invalidation chain.
 *
 * What's covered:
 *   - On a successful PATCH, exactly one POST to `<INTERNAL_URL>/__ssr/purge`
 *     is dispatched, with the shared-secret header and a JSON body of
 *     `{ clubSlug, courseSlug, kind: "course" }`.
 *   - When the slug itself is renamed, BOTH the old and new course slugs
 *     are purged (so the old crawler-cached URL clears too).
 *   - When the env vars (`MARKETING_SITE_INTERNAL_URL` /
 *     `SSR_CACHE_PURGE_TOKEN`) aren't set, no purge fetch is made — the
 *     cache silently falls back to its TTL.
 *   - A failing purge fetch never fails the parent PATCH request
 *     (best-effort semantics).
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-course-purge";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

const INTERNAL_URL = "http://marketing-site.test";
const PURGE_TOKEN = "shared-purge-token-for-tests";

let orgId: number;
let orgSlug: string;
let courseId: number;
let courseSlug: string;
let admin: TestUser;
const createdUserIds: number[] = [];

let originalFetch: typeof globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

function purgeCalls() {
  return fetchSpy.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    return url.endsWith("/__ssr/purge");
  });
}

/**
 * The purge is dispatched fire-and-forget (`void purgeMarketingSiteCourseCache(...)`)
 * so we poll briefly rather than relying on a fixed sleep. Returns once the
 * predicate is true, or throws after `timeoutMs`.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  if (!predicate()) throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
}

async function makeAdmin(orgIdArg: number): Promise<TestUser> {
  const tag = uid("course-purge-admin");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@example.com`,
    displayName: tag,
    role: "org_admin",
    organizationId: orgIdArg,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName: tag, role: "org_admin", organizationId: orgIdArg };
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  orgSlug = `course-purge-${stamp}`.toLowerCase();
  const [org] = await db.insert(organizationsTable).values({
    name: `CoursePurge_${stamp}`,
    slug: orgSlug,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  admin = await makeAdmin(orgId);

  courseSlug = `original-${stamp}`.toLowerCase();
  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Original Course",
    slug: courseSlug,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id, slug: coursesTable.slug });
  courseId = course.id;
  courseSlug = course.slug;
});

afterAll(async () => {
  await db.delete(coursesTable).where(eq(coursesTable.organizationId, orgId));
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  process.env.MARKETING_SITE_INTERNAL_URL = INTERNAL_URL;
  process.env.SSR_CACHE_PURGE_TOKEN = PURGE_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("PATCH /marketing-site/courses/:courseId/public-fields fires SSR purge (Task #632)", () => {
  it("dispatches one purge call with the shared secret and the correct body", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .patch(`/api/organizations/${orgId}/marketing-site/courses/${courseId}/public-fields`)
      .send({ description: "Updated copy for the homepage." });

    expect(res.status).toBe(200);

    // The purge is fire-and-forget (`void purgeMarketingSiteCourseCache(...)`)
    // so allow the microtask + the awaited org lookup to settle.
    await waitFor(() => purgeCalls().length >= 1);

    const calls = purgeCalls();
    expect(calls.length).toBe(1);
    const [input, init] = calls[0];
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    expect(url).toBe(`${INTERNAL_URL}/__ssr/purge`);
    expect(init?.method).toBe("POST");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-ssr-purge-token"]).toBe(PURGE_TOKEN);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ clubSlug: orgSlug, courseSlug, kind: "course" });
  });

  it("purges both the old and new slugs when the course slug is renamed", async () => {
    const app = createTestApp(admin);
    const newSlug = `renamed-${Date.now().toString(36)}`;
    const res = await request(app)
      .patch(`/api/organizations/${orgId}/marketing-site/courses/${courseId}/public-fields`)
      .send({ slug: newSlug });

    expect(res.status).toBe(200);
    await waitFor(() => purgeCalls().length >= 1);

    const calls = purgeCalls();
    // One per unique slug — old + new.
    expect(calls.length).toBe(2);
    const sentSlugs = calls
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).courseSlug as string)
      .sort();
    expect(sentSlugs).toEqual([courseSlug, newSlug].sort());

    // Restore the original slug for any later tests in this file.
    await db.update(coursesTable).set({ slug: courseSlug }).where(eq(coursesTable.id, courseId));
  });

  it("does NOT call the purge endpoint when env vars are not configured", async () => {
    delete process.env.MARKETING_SITE_INTERNAL_URL;
    delete process.env.SSR_CACHE_PURGE_TOKEN;

    const app = createTestApp(admin);
    const res = await request(app)
      .patch(`/api/organizations/${orgId}/marketing-site/courses/${courseId}/public-fields`)
      .send({ description: "Another edit." });

    expect(res.status).toBe(200);
    // Negative assertion — give the fire-and-forget dispatch a brief window
    // to (not) run, then assert no purge fetch ever happened.
    await new Promise(r => setTimeout(r, 100));
    expect(purgeCalls().length).toBe(0);
  });

  it("still returns 200 from PATCH even if the purge fetch fails", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .patch(`/api/organizations/${orgId}/marketing-site/courses/${courseId}/public-fields`)
      .send({ description: "Edit despite failing purge." });

    expect(res.status).toBe(200);
    await waitFor(() => purgeCalls().length >= 1);
    // It still tried.
    expect(purgeCalls().length).toBe(1);
  });
});
