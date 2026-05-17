/**
 * Integration tests: public open + click telemetry endpoints for the
 * data-export `export_expiring` reminder (Task #1124).
 *
 *   GET /api/public/data-export-reminder-pixel?token=...
 *   GET /api/public/data-export-reminder-click?token=...
 *
 * Both routes are unauthenticated by design — possession of the
 * high-entropy `expiringReminderTrackingToken` (minted per request and
 * embedded in the reminder email's <img> + CTA) is the only signal
 * required. We verify:
 *   - pixel happy path: serves a 1x1 GIF + stamps `expiringReminderEmailOpenedAt`
 *   - pixel idempotency: a second request does NOT advance the open timestamp
 *   - pixel with unknown/missing token: still returns 200 + GIF (no leak)
 *   - click happy path: stamps `expiringReminderEmailClickedAt` + 302s
 *   - click back-fills `expiringReminderEmailOpenedAt` when the pixel was
 *     blocked by the mail client (Apple Mail Privacy Protection, etc.)
 *   - click with unknown token: 404
 *   - click with missing token: 400
 *
 * The controller dashboard widget is covered separately by the route tests
 * for `/api/organizations/:orgId/members-360/data-requests/expiring-reminder-stats`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({}) }) },
  ObjectStorageService: class {
    async getSignedDownloadUrl(): Promise<string> { return "https://example.test/signed-download"; }
    async saveRawBuffer(): Promise<string> { throw new Error("disabled"); }
    async getObjectEntityFile(): Promise<never> { throw new Error("disabled"); }
  },
}));

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDataRequestsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

async function ensureSchema() {
  // Mirrors the ALTERs in the migration so older test DBs that pre-date
  // Task #1124 still expose the columns + index this suite needs.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_tracking_token text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_email_opened_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_email_clicked_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_email_prefetched_at timestamptz`);
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS member_data_requests_expiring_tracking_token_unique ON member_data_requests(expiring_reminder_tracking_token)`);
  } catch {/* concurrent — fine */}
}

let testOrgId: number;
let testUserId: number;
let testMemberId: number;

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_Track_${ts}`,
    slug: `test-track-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `track-${ts}`,
    username: `track_${ts}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;
  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Track",
    lastName: "Tester",
    email: `track-${ts}@example.test`,
    userId: testUserId,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;
});

afterAll(async () => {
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

async function seedRequest(token: string, overrides: Partial<typeof memberDataRequestsTable.$inferInsert> = {}) {
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    requestType: "access",
    status: "completed",
    requestedAt: new Date(),
    artifactUrl: "/objects/exports/test.json",
    expiringReminderTrackingToken: token,
    ...overrides,
  }).returning();
  return row;
}

describe("GET /api/public/data-export-reminder-pixel", () => {
  it("serves a 1x1 GIF and stamps the first open", async () => {
    const token = `pixel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      const res = await request(app)
        .get("/api/public/data-export-reminder-pixel")
        .query({ token });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/image\/gif/);
      expect(res.body).toBeInstanceOf(Buffer);
      expect((res.body as Buffer).length).toBeGreaterThan(0);

      const [after] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(after.expiringReminderEmailOpenedAt).not.toBeNull();
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("does not advance the open timestamp on subsequent fetches (idempotent)", async () => {
    const token = `pixel-2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      await request(app).get("/api/public/data-export-reminder-pixel").query({ token });
      const [after1] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      const firstStamp = after1.expiringReminderEmailOpenedAt!.getTime();
      // Tiny delay so a buggy implementation that re-stamps on every hit
      // would produce a different timestamp.
      await new Promise(r => setTimeout(r, 10));
      await request(app).get("/api/public/data-export-reminder-pixel").query({ token });
      const [after2] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(after2.expiringReminderEmailOpenedAt!.getTime()).toBe(firstStamp);
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("still returns a 200 GIF for unknown tokens (no leak)", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get("/api/public/data-export-reminder-pixel")
      .query({ token: "nonexistent-pixel-token-xxxxxxxxxxxxx" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/gif/);
  });

  it("still returns a 200 GIF when the token is missing", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/public/data-export-reminder-pixel");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/gif/);
  });
});

describe("GET /api/public/data-export-reminder-click", () => {
  it("stamps clicked_at + redirects to a fresh signed download URL", async () => {
    const token = `click-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      const res = await request(app)
        .get("/api/public/data-export-reminder-click")
        .query({ token });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("https://example.test/signed-download");

      const [after] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(after.expiringReminderEmailClickedAt).not.toBeNull();
      // A click implies an open — back-fill should have stamped opened_at too.
      expect(after.expiringReminderEmailOpenedAt).not.toBeNull();
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("preserves an existing opened_at when the click arrives second", async () => {
    const token = `click-after-pixel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const earlierOpen = new Date(Date.now() - 60 * 60 * 1000);
    const seeded = await seedRequest(token, { expiringReminderEmailOpenedAt: earlierOpen });
    try {
      const app = createTestApp();
      await request(app).get("/api/public/data-export-reminder-click").query({ token });
      const [after] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(after.expiringReminderEmailClickedAt).not.toBeNull();
      // The earlier pixel-stamped open must NOT be overwritten — it's the
      // authoritative "first opened" timestamp.
      expect(after.expiringReminderEmailOpenedAt!.getTime()).toBe(earlierOpen.getTime());
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("rejects an unknown token with 404", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get("/api/public/data-export-reminder-click")
      .query({ token: "nonexistent-click-token-xxxxxxxxxxxx" });
    expect(res.status).toBe(404);
  });

  it("rejects a missing token with 400", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/public/data-export-reminder-click");
    expect(res.status).toBe(400);
  });

  it("does not advance the click timestamp on subsequent clicks (idempotent)", async () => {
    const token = `click-idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      await request(app).get("/api/public/data-export-reminder-click").query({ token });
      const [after1] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      const firstStamp = after1.expiringReminderEmailClickedAt!.getTime();
      await new Promise(r => setTimeout(r, 10));
      await request(app).get("/api/public/data-export-reminder-click").query({ token });
      const [after2] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(after2.expiringReminderEmailClickedAt!.getTime()).toBe(firstStamp);
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });
});
