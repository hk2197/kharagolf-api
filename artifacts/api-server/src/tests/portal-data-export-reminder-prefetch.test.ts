/**
 * Integration tests: Task #1298 — the open-pixel handler must distinguish
 * a likely-prefetch from a likely-human open and route the timestamp into
 * the right column.
 *
 *   GET /api/public/data-export-reminder-pixel?token=...
 *
 * Coverage:
 *   - DNT: 1 → stamps `expiringReminderEmailPrefetchedAt`, NOT `openedAt`
 *   - Sec-GPC: 1 → stamps `prefetchedAt`, NOT `openedAt`
 *   - GoogleImageProxy UA → stamps `prefetchedAt`, NOT `openedAt`
 *   - YahooMailProxy UA → stamps `prefetchedAt`, NOT `openedAt`
 *   - Apple AMPP `Mail/16.0` UA → stamps `prefetchedAt`, NOT `openedAt`
 *   - Source IP in Apple's 17.0.0.0/8 (via X-Forwarded-For) → prefetch
 *   - Plain Gecko/iPhone Safari UA → stamps `openedAt` (real human)
 *   - Idempotent: repeated prefetches don't advance `prefetchedAt`
 *   - A real human open after a prefetch still stamps `openedAt`
 *
 * The shared unit-level coverage of `looksLikeMailPrefetch` lives at the
 * bottom of the file as plain function calls — no HTTP needed.
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
import { looksLikeMailPrefetch } from "../lib/mailPrefetch.js";
import type { Request } from "express";

async function ensureSchema() {
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
    name: `TestOrg_Prefetch_${ts}`,
    slug: `test-prefetch-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `prefetch-${ts}`,
    username: `prefetch_${ts}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;
  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Pre",
    lastName: "Fetch",
    email: `prefetch-${ts}@example.test`,
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

function uniqToken(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

describe("GET /api/public/data-export-reminder-pixel — prefetch detection (Task #1298)", () => {
  it("stamps prefetchedAt (not openedAt) when DNT: 1 is sent", async () => {
    const token = uniqToken("dnt");
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      const res = await request(app)
        .get("/api/public/data-export-reminder-pixel")
        .set("DNT", "1")
        .query({ token });
      expect(res.status).toBe(200);
      const [after] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(after.expiringReminderEmailPrefetchedAt).not.toBeNull();
      expect(after.expiringReminderEmailOpenedAt).toBeNull();
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("stamps prefetchedAt when Sec-GPC: 1 is sent", async () => {
    const token = uniqToken("gpc");
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      await request(app)
        .get("/api/public/data-export-reminder-pixel")
        .set("Sec-GPC", "1")
        .query({ token });
      const [after] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(after.expiringReminderEmailPrefetchedAt).not.toBeNull();
      expect(after.expiringReminderEmailOpenedAt).toBeNull();
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("stamps prefetchedAt for the GoogleImageProxy User-Agent", async () => {
    const token = uniqToken("gip");
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      await request(app)
        .get("/api/public/data-export-reminder-pixel")
        .set("User-Agent", "Mozilla/5.0 (compatible; GoogleImageProxy)")
        .query({ token });
      const [after] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(after.expiringReminderEmailPrefetchedAt).not.toBeNull();
      expect(after.expiringReminderEmailOpenedAt).toBeNull();
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("stamps prefetchedAt for an Apple Mail (`Mail/16.0`) User-Agent", async () => {
    const token = uniqToken("ampp-ua");
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      await request(app)
        .get("/api/public/data-export-reminder-pixel")
        .set(
          "User-Agent",
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Mail/16.0",
        )
        .query({ token });
      const [after] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(after.expiringReminderEmailPrefetchedAt).not.toBeNull();
      expect(after.expiringReminderEmailOpenedAt).toBeNull();
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("stamps openedAt for a normal Safari (mobile) User-Agent — real human open", async () => {
    const token = uniqToken("real");
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      await request(app)
        .get("/api/public/data-export-reminder-pixel")
        .set(
          "User-Agent",
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
        )
        .query({ token });
      const [after] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(after.expiringReminderEmailOpenedAt).not.toBeNull();
      expect(after.expiringReminderEmailPrefetchedAt).toBeNull();
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("does not advance prefetchedAt on subsequent prefetches (idempotent)", async () => {
    const token = uniqToken("pf-idem");
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      await request(app)
        .get("/api/public/data-export-reminder-pixel")
        .set("DNT", "1")
        .query({ token });
      const [a1] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      const first = a1.expiringReminderEmailPrefetchedAt!.getTime();
      await new Promise(r => setTimeout(r, 10));
      await request(app)
        .get("/api/public/data-export-reminder-pixel")
        .set("DNT", "1")
        .query({ token });
      const [a2] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(a2.expiringReminderEmailPrefetchedAt!.getTime()).toBe(first);
      expect(a2.expiringReminderEmailOpenedAt).toBeNull();
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });

  it("a real open after a prefetch still stamps openedAt and preserves prefetchedAt", async () => {
    const token = uniqToken("pf-then-real");
    const seeded = await seedRequest(token);
    try {
      const app = createTestApp();
      // 1st: prefetch
      await request(app)
        .get("/api/public/data-export-reminder-pixel")
        .set("DNT", "1")
        .query({ token });
      const [a1] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      const prefetchStamp = a1.expiringReminderEmailPrefetchedAt!.getTime();
      // 2nd: real human open from same recipient
      await new Promise(r => setTimeout(r, 10));
      await request(app)
        .get("/api/public/data-export-reminder-pixel")
        .set(
          "User-Agent",
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
        )
        .query({ token });
      const [a2] = await db.select().from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, seeded.id));
      expect(a2.expiringReminderEmailOpenedAt).not.toBeNull();
      // Prefetch column must not be touched again.
      expect(a2.expiringReminderEmailPrefetchedAt!.getTime()).toBe(prefetchStamp);
    } finally {
      await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, seeded.id));
    }
  });
});

describe("looksLikeMailPrefetch (unit)", () => {
  // Build a minimal Express-shaped Request stub. Only the fields the
  // helper actually reads are populated; everything else is undefined.
  function mkReq(opts: {
    headers?: Record<string, string>;
    ip?: string;
  }): Request {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    return { headers, ip: opts.ip } as unknown as Request;
  }

  it("returns true when DNT or Sec-GPC asserts a privacy preference", () => {
    expect(looksLikeMailPrefetch(mkReq({ headers: { dnt: "1" } }))).toBe(true);
    expect(looksLikeMailPrefetch(mkReq({ headers: { "sec-gpc": "1" } }))).toBe(true);
  });

  it("returns true for known mail-proxy User-Agents", () => {
    expect(looksLikeMailPrefetch(mkReq({ headers: { "user-agent": "GoogleImageProxy" } }))).toBe(true);
    expect(looksLikeMailPrefetch(mkReq({ headers: { "user-agent": "YahooMailProxy/1.0" } }))).toBe(true);
    expect(looksLikeMailPrefetch(mkReq({ headers: { "user-agent": "AppleWebKit MailServices/1.0" } }))).toBe(true);
    expect(looksLikeMailPrefetch(mkReq({ headers: { "user-agent": "Mail/16.0" } }))).toBe(true);
  });

  it("returns true for IPs inside the curated AMPP CIDRs (incl. IPv6-mapped)", () => {
    // 17.57.144.0/22 covers 17.57.144.0 – 17.57.147.255.
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.57.144.0" }))).toBe(true);
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.57.144.10" }))).toBe(true);
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.57.147.255" }))).toBe(true);
    // IPv6-mapped IPv4 inside the same /22 is unwrapped before matching.
    expect(looksLikeMailPrefetch(mkReq({ ip: "::ffff:17.57.145.7" }))).toBe(true);
    // 17.58.85.0/24 — secondary AMPP relay block.
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.58.85.0" }))).toBe(true);
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.58.85.42" }))).toBe(true);
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.58.85.255" }))).toBe(true);
  });

  it("returns false for Apple IPs *outside* the AMPP CIDRs (Task #1532)", () => {
    // Just below 17.57.144.0/22.
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.57.143.255" }))).toBe(false);
    // Just above 17.57.144.0/22.
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.57.148.0" }))).toBe(false);
    // Just outside 17.58.85.0/24 on either side.
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.58.84.255" }))).toBe(false);
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.58.86.0" }))).toBe(false);
    // Apple corporate-network style address inside the old `/8` but
    // outside every AMPP CIDR — the bug Task #1532 fixes: a real human
    // on Apple's corporate VPN must NOT be classified as a prefetch.
    expect(looksLikeMailPrefetch(mkReq({ ip: "17.42.7.1" }))).toBe(false);
    expect(looksLikeMailPrefetch(mkReq({ ip: "::ffff:17.42.7.1" }))).toBe(false);
  });

  it("returns false for ordinary browser fetches", () => {
    expect(
      looksLikeMailPrefetch(
        mkReq({
          ip: "203.0.113.5",
          headers: {
            "user-agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
          },
        }),
      ),
    ).toBe(false);
    expect(looksLikeMailPrefetch(mkReq({ ip: "8.8.8.8", headers: { "user-agent": "curl/8.0" } }))).toBe(false);
    // DNT is only honoured when explicitly "1". Browsers that send "0"
    // are opting *in* to tracking and must be treated as a real open.
    expect(looksLikeMailPrefetch(mkReq({ headers: { dnt: "0" } }))).toBe(false);
  });
});
