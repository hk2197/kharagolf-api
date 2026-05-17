/**
 * Integration tests for the server-side recap share endpoints (Task #451).
 *
 *   GET /api/public/recap/:handle/card.png
 *     - 404 for unknown handle
 *     - 404 when the user's public profile is disabled
 *     - 200 image/png for an enabled public profile
 *     - Task #1282: per-IP+handle rate limit returns 429 once exhausted
 *
 *   GET /api/public/recap/:handle/og
 *     - 404 for unknown handle
 *     - 200 text/html with og:image meta pointing at the card.png endpoint
 *     - Task #1282: shares the same per-IP+handle rate-limit bucket as
 *       the card.png endpoint
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { organizationsTable, appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { _resetRateLimiterForTests } from "../lib/publicRateLimit.js";

let orgId: number;
let userEnabledId: number;
let userDisabledId: number;
const stamp = Date.now();
const enabledHandle = `recap${stamp}`;
const disabledHandle = `recapoff${stamp}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_RecapShare_${stamp}`,
    slug: `test-recapshare-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `recap-on-${stamp}`,
    username: `recap_on_${stamp}`,
    email: `recap_on_${stamp}@example.com`,
    displayName: "Recap Player",
    role: "player",
    organizationId: orgId,
    publicHandle: enabledHandle,
    publicProfileEnabled: true,
  }).returning({ id: appUsersTable.id });
  userEnabledId = a.id;

  const [b] = await db.insert(appUsersTable).values({
    replitUserId: `recap-off-${stamp}`,
    username: `recap_off_${stamp}`,
    email: `recap_off_${stamp}@example.com`,
    displayName: "Hidden Player",
    role: "player",
    organizationId: orgId,
    publicHandle: disabledHandle,
    publicProfileEnabled: false,
  }).returning({ id: appUsersTable.id });
  userDisabledId = b.id;
});

afterAll(async () => {
  if (userEnabledId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userEnabledId));
  if (userDisabledId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userDisabledId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

// Each test starts with a clean rate-limit table so the per-IP+handle
// bucket is full at the top of every case. Without this, exhaustion in
// the rate-limit test would bleed into the cases that run after it
// (vitest runs `it` blocks sequentially within a file).
beforeEach(async () => {
  await _resetRateLimiterForTests();
});

describe("GET /api/public/recap/:handle/card.png", () => {
  it("returns 404 for an unknown handle", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/recap/no-such-${stamp}/card.png`);
    expect(r.status).toBe(404);
  });

  it("returns 404 when the public profile is disabled", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/recap/${disabledHandle}/card.png`);
    expect(r.status).toBe(404);
  });

  it("returns a 1080×1920 PNG for a public-profile-enabled handle", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/recap/${enabledHandle}/card.png?period=year&year=2026&chapter=0`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/image\/png/);
    expect(r.body.length).toBeGreaterThan(0);
    // PNG magic bytes
    expect(r.body[0]).toBe(0x89);
    expect(r.body[1]).toBe(0x50);
    // PNG IHDR at offset 16 holds width/height as big-endian uint32
    const width = r.body.readUInt32BE(16);
    const height = r.body.readUInt32BE(20);
    expect(width).toBe(1080);
    expect(height).toBe(1920);
  });

  // Task #1282 — A scraper or social-media crawler retry storm pointed at
  // this endpoint used to run the full year-in-golf aggregation on every
  // request. The per-IP+handle bucket caps that at 20/hr, so once the
  // bucket is drained the next request must come back 429 with a
  // Retry-After hint and *must not* render another PNG.
  it("returns 429 once the per-IP+handle rate-limit bucket is exhausted", async () => {
    const app = createTestApp();
    // Bucket capacity for `recap:ip+handle:` is 20 (publicRateLimit.ts).
    // Burn through it, then confirm the 21st request is throttled.
    for (let i = 0; i < 20; i++) {
      const r = await request(app).get(`/api/public/recap/${enabledHandle}/card.png?period=year&year=2026&chapter=0`);
      expect(r.status).toBe(200);
    }
    const blocked = await request(app).get(`/api/public/recap/${enabledHandle}/card.png?period=year&year=2026&chapter=0`);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });
});

describe("GET /api/public/recap/:handle/og", () => {
  it("returns 404 for an unknown handle", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/recap/no-such-${stamp}/og`);
    expect(r.status).toBe(404);
  });

  it("returns 404 when the public profile is disabled", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/recap/${disabledHandle}/og`);
    expect(r.status).toBe(404);
  });

  it("returns HTML with og:image meta pointing at card.png", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/recap/${enabledHandle}/og?period=year&year=2026`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.text).toContain('property="og:image"');
    expect(r.text).toContain(`/api/public/recap/${enabledHandle}/card.png`);
    expect(r.text).toContain('name="twitter:card"');
  });
});
