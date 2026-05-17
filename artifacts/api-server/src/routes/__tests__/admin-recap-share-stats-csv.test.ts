/**
 * Task #1866 — GET /api/admin/recap-share-stats.csv
 *
 * Sibling of the JSON GET /admin/recap-share-stats endpoint (Task #1510).
 * Pins the CSV export contract:
 *   • Same role gate as the JSON sibling (401 unauth / 403 non-admin).
 *   • Same tenant scope: org_admin sees only their own org; super_admin
 *     sees the platform-wide totals.
 *   • Misconfigured org_admin (no organizationId) gets a header-only
 *     CSV (every section's header row, no data rows) so downstream
 *     tooling always receives a valid file.
 *   • text/csv content type, attachment Content-Disposition, no-store
 *     cache headers.
 *   • Multi-section layout: summary → by_asset → by_source → by_period →
 *     top_sharers, separated by blank lines so each section is its own
 *     RFC 4180 sub-table.
 *   • The dataset embedded in the CSV matches the JSON endpoint's
 *     totals + top-sharer ordering for the same caller / scope / topN.
 *   • RFC 4180 escaping for embedded commas / quotes in member fields.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import {
  db,
  organizationsTable,
  appUsersTable,
  recapShareEventsTable,
  recapShareDailyAggregatesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminBId: number;
let playerAId: number;
let orphanAdminId: number;
let superAdminId: number;
let userA1Id: number;
let userA2Id: number;
let userA3Id: number;
let userBId: number;
// User A2 has a comma + quote in their identifying fields so we can
// confirm RFC 4180 escaping survives the round-trip through the CSV.
let userA2Username: string;
let userA2DisplayName: string;

const eventIds: number[] = [];

const Y = 2025;

async function seedRawEvent(opts: {
  userId: number;
  asset: "card_png" | "og";
  period: "year" | "q1" | "q2" | "q3" | "q4";
  source: string;
  count?: number;
  handle?: string;
}): Promise<void> {
  const n = opts.count ?? 1;
  for (let i = 0; i < n; i++) {
    const [r] = await db.insert(recapShareEventsTable).values({
      userId: opts.userId,
      handle: opts.handle ?? `t1866_${opts.userId}`,
      asset: opts.asset,
      period: opts.period,
      year: Y,
      source: opts.source,
    }).returning({ id: recapShareEventsTable.id });
    eventIds.push(r.id);
  }
}

async function seedAggregate(opts: {
  userId: number;
  asset: "card_png" | "og";
  period: "year" | "q1" | "q2" | "q3" | "q4";
  source: string;
  day: Date;
  count: number;
}): Promise<void> {
  await db.insert(recapShareDailyAggregatesTable).values({
    userId: opts.userId,
    asset: opts.asset,
    period: opts.period,
    year: Y,
    source: opts.source,
    day: opts.day,
    count: opts.count,
  });
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1866_A_${stamp}`, slug: `t1866-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1866_B_${stamp}`, slug: `t1866-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1866-admin-a-${stamp}`,
    username: `t1866_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1866.test`,
    role: "org_admin", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id;

  const [adminB] = await db.insert(appUsersTable).values({
    replitUserId: `t1866-admin-b-${stamp}`,
    username: `t1866_admin_b_${stamp}`,
    email: `admin_b_${stamp}@t1866.test`,
    role: "org_admin", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBId = adminB.id;

  const [playerA] = await db.insert(appUsersTable).values({
    replitUserId: `t1866-player-a-${stamp}`,
    username: `t1866_player_a_${stamp}`,
    email: `player_a_${stamp}@t1866.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerAId = playerA.id;

  const [orphan] = await db.insert(appUsersTable).values({
    replitUserId: `t1866-orphan-${stamp}`,
    username: `t1866_orphan_${stamp}`,
    email: `orphan_${stamp}@t1866.test`,
    role: "org_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  orphanAdminId = orphan.id;

  const [superUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1866-super-${stamp}`,
    username: `t1866_super_${stamp}`,
    email: `super_${stamp}@t1866.test`,
    role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = superUser.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `t1866-u1-${stamp}`,
    username: `t1866_u1_${stamp}`,
    displayName: "T1866 User One",
    email: `u1_${stamp}@t1866.test`,
    publicHandle: `t1866_handle_u1_${stamp}`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA1Id = u1.id;

  // Embedded comma + quote in the username + display name to exercise
  // RFC 4180 escaping inside the top-sharers section.
  userA2Username = `t1866,u2,${stamp}`;
  userA2DisplayName = 'T1866 "Quote" Two';
  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `t1866-u2-${stamp}`,
    username: userA2Username,
    displayName: userA2DisplayName,
    email: `u2_${stamp}@t1866.test`,
    publicHandle: `t1866_handle_u2_${stamp}`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA2Id = u2.id;

  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `t1866-u3-${stamp}`,
    username: `t1866_u3_${stamp}`,
    displayName: "T1866 User Three",
    email: `u3_${stamp}@t1866.test`,
    publicHandle: `t1866_handle_u3_${stamp}`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA3Id = u3.id;

  const [uB] = await db.insert(appUsersTable).values({
    replitUserId: `t1866-ub-${stamp}`,
    username: `t1866_ub_${stamp}`,
    displayName: "T1866 OtherOrg",
    email: `ub_${stamp}@t1866.test`,
    publicHandle: `t1866_handle_ub_${stamp}`,
    role: "player", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  userBId = uB.id;

  // Mirror the JSON endpoint's seed shape so the two test suites stay
  // in lockstep:
  //   user A1 — 5 og copy hits (year, raw) + 3 og crawler hits (year, raw)
  //             → opens 5, total 8
  //   user A2 — 2 card_png web_share hits (q1, raw) + 4 og copy hits (year,
  //             aggregates) → opens 6, total 6
  //   user A3 — 1 card_png native_share hit (q2, raw) → opens 1, total 1
  //   user B  — 10 og copy hits (year, raw)
  for (let i = 0; i < 5; i++) {
    await seedRawEvent({ userId: userA1Id, asset: "og", period: "year", source: "copy" });
  }
  for (let i = 0; i < 3; i++) {
    await seedRawEvent({ userId: userA1Id, asset: "og", period: "year", source: "crawler" });
  }
  await seedRawEvent({ userId: userA2Id, asset: "card_png", period: "q1", source: "web_share", count: 2 });
  await seedAggregate({
    userId: userA2Id, asset: "og", period: "year", source: "copy",
    day: new Date("2025-01-01T00:00:00Z"), count: 4,
  });
  await seedRawEvent({ userId: userA3Id, asset: "card_png", period: "q2", source: "native_share" });
  for (let i = 0; i < 10; i++) {
    await seedRawEvent({ userId: userBId, asset: "og", period: "year", source: "copy" });
  }
});

afterAll(async () => {
  if (eventIds.length) {
    await db.delete(recapShareEventsTable)
      .where(inArray(recapShareEventsTable.id, eventIds));
  }
  const testUserIds = [userA1Id, userA2Id, userA3Id, userBId]
    .filter((v): v is number => typeof v === "number");
  if (testUserIds.length) {
    await db.delete(recapShareDailyAggregatesTable)
      .where(inArray(recapShareDailyAggregatesTable.userId, testUserIds));
  }
  const allUsers = [
    adminAId, adminBId, playerAId, orphanAdminId, superAdminId,
    userA1Id, userA2Id, userA3Id, userBId,
  ].filter((v): v is number => typeof v === "number");
  if (allUsers.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, allUsers));
  }
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

function call(user: TestUser | undefined, query = "") {
  return request(createTestApp(user)).get(`/api/admin/recap-share-stats.csv${query}`);
}

// Tiny RFC 4180 parser for asserting on our own well-formed output —
// handles quoted fields, doubled quotes, and embedded CR/LF. Identical
// in spirit to the parser in admin-recap-broadcasts-recipients-csv.test.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
      continue;
    }
    field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field); rows.push(row);
  }
  return rows;
}

// Split parsed rows on blank lines (a single empty-string row), so we
// can assert each multi-section sub-table independently.
function splitSections(rows: string[][]): string[][][] {
  const sections: string[][][] = [];
  let current: string[][] = [];
  for (const r of rows) {
    if (r.length === 1 && r[0] === "") {
      if (current.length > 0) { sections.push(current); current = []; }
      continue;
    }
    current.push(r);
  }
  if (current.length > 0) sections.push(current);
  return sections;
}

describe("GET /api/admin/recap-share-stats.csv", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await call(undefined);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await call(asUser(playerAId, "player", orgAId));
    expect(res.status).toBe(403);
  });

  it("emits a CSV download with the documented headers", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(
      /attachment;.*recap-share-stats-.*\.csv/,
    );
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("emits five sections (summary, by_asset, by_source, by_period, top_sharers) for an org admin", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const sections = splitSections(parseCsv(res.text));
    expect(sections.length).toBe(5);

    // Section 1 — summary
    expect(sections[0][0]).toEqual([
      "section", "scope", "organization_id", "top_n", "total",
    ]);
    expect(sections[0][1][0]).toBe("summary");
    expect(sections[0][1][1]).toBe("org");
    expect(sections[0][1][2]).toBe(String(orgAId));
    expect(sections[0][1][3]).toBe("10"); // default topN
    // Org A seeded 15 hits (5+3+2+4+1).
    expect(Number(sections[0][1][4])).toBeGreaterThanOrEqual(15);

    // Section 2 — by_asset
    expect(sections[1][0]).toEqual(["asset", "count"]);
    const assetMap = new Map(sections[1].slice(1).map(r => [r[0], Number(r[1])]));
    expect(assetMap.get("card_png")).toBeGreaterThanOrEqual(3);
    expect(assetMap.get("og")).toBeGreaterThanOrEqual(12);

    // Section 3 — by_source
    expect(sections[2][0]).toEqual(["source", "count"]);
    const sourceMap = new Map(sections[2].slice(1).map(r => [r[0], Number(r[1])]));
    expect(sourceMap.get("copy")).toBeGreaterThanOrEqual(9);
    expect(sourceMap.get("crawler")).toBeGreaterThanOrEqual(3);
    expect(sourceMap.get("web_share")).toBeGreaterThanOrEqual(2);
    expect(sourceMap.get("native_share")).toBeGreaterThanOrEqual(1);

    // Section 4 — by_period (header includes per-asset + per-source columns)
    expect(sections[3][0]).toEqual([
      "year", "period", "total",
      "card_png", "og",
      "copy", "web_share", "native_share", "qr_open", "crawler", "unknown",
    ]);
    const yearRow = sections[3].slice(1).find(r => r[1] === "year");
    const q1Row = sections[3].slice(1).find(r => r[1] === "q1");
    const q2Row = sections[3].slice(1).find(r => r[1] === "q2");
    expect(yearRow).toBeDefined();
    expect(q1Row).toBeDefined();
    expect(q2Row).toBeDefined();
    expect(Number(yearRow![2])).toBeGreaterThanOrEqual(12);
    expect(Number(q1Row![3])).toBeGreaterThanOrEqual(2); // q1 card_png
    expect(Number(q2Row![3])).toBeGreaterThanOrEqual(1); // q2 card_png

    // Section 5 — top_sharers
    expect(sections[4][0]).toEqual([
      "rank", "user_id", "username", "display_name", "public_handle",
      "opens", "total",
    ]);
    const sharerRows = sections[4].slice(1);
    expect(sharerRows.length).toBeGreaterThanOrEqual(3);

    // Org A's three users present, org B user must not leak in.
    const sharerByUserId = new Map(sharerRows.map(r => [r[1], r]));
    expect(sharerByUserId.has(String(userA1Id))).toBe(true);
    expect(sharerByUserId.has(String(userA2Id))).toBe(true);
    expect(sharerByUserId.has(String(userA3Id))).toBe(true);
    expect(sharerByUserId.has(String(userBId))).toBe(false);

    // Ordering by opens (desc): A2 (6) before A1 (5) before A3 (1).
    const rankOf = (id: number) =>
      Number(sharerByUserId.get(String(id))![0]);
    expect(rankOf(userA2Id)).toBeLessThan(rankOf(userA1Id));
    expect(rankOf(userA1Id)).toBeLessThan(rankOf(userA3Id));

    // A1 → opens 5, total 8.
    const a1 = sharerByUserId.get(String(userA1Id))!;
    expect(Number(a1[5])).toBe(5);
    expect(Number(a1[6])).toBe(8);
  });

  it("scopes org admin's view strictly to their own organization", async () => {
    const res = await call(asUser(adminBId, "org_admin", orgBId));
    expect(res.status).toBe(200);
    const sections = splitSections(parseCsv(res.text));
    // summary row reports orgB
    expect(sections[0][1][2]).toBe(String(orgBId));
    // top_sharers section: only userB, none of org A's users
    const sharerRows = sections[4].slice(1);
    const ids = sharerRows.map(r => r[1]);
    expect(ids).toContain(String(userBId));
    expect(ids).not.toContain(String(userA1Id));
    expect(ids).not.toContain(String(userA2Id));
    expect(ids).not.toContain(String(userA3Id));
  });

  it("super admin sees the platform-wide totals across both orgs", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    const sections = splitSections(parseCsv(res.text));
    expect(sections[0][1][1]).toBe("platform");
    expect(sections[0][1][2]).toBe(""); // no organization_id for platform scope
    // Org A's 15 + Org B's 10 = >=25 total.
    expect(Number(sections[0][1][4])).toBeGreaterThanOrEqual(25);
    // Both orgs' top sharers visible.
    const sharerRows = sections[4].slice(1);
    const ids = sharerRows.map(r => r[1]);
    expect(ids).toContain(String(userBId));
  });

  it("clamps topN the same way the JSON endpoint does", async () => {
    const cap = await call(asUser(adminAId, "org_admin", orgAId), "?topN=2");
    expect(cap.status).toBe(200);
    const sections = splitSections(parseCsv(cap.text));
    expect(sections[0][1][3]).toBe("2");
    expect(sections[4].slice(1).length).toBeLessThanOrEqual(2);

    const hi = await call(asUser(adminAId, "org_admin", orgAId), "?topN=999");
    expect(hi.status).toBe(200);
    const hiSections = splitSections(parseCsv(hi.text));
    expect(Number(hiSections[0][1][3])).toBeLessThanOrEqual(50);
  });

  it("returns a header-only CSV (every section, zero data rows) for an org_admin with no organization", async () => {
    const res = await call(asUser(orphanAdminId, "org_admin", null));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    const sections = splitSections(parseCsv(res.text));
    // Five sections, each with its header row plus the relevant
    // fixed-key rows (asset & source enumerate every key with 0).
    expect(sections.length).toBe(5);
    expect(sections[0][0][0]).toBe("section");
    expect(sections[0][1][0]).toBe("summary");
    expect(sections[0][1][1]).toBe("org");
    expect(sections[0][1][2]).toBe("");
    expect(Number(sections[0][1][4])).toBe(0);
    // by_asset enumerates both assets even when zero.
    expect(sections[1].slice(1).map(r => r[0]).sort()).toEqual(["card_png", "og"]);
    for (const r of sections[1].slice(1)) expect(Number(r[1])).toBe(0);
    // by_source enumerates all six keys with zeros.
    expect(sections[2].slice(1).length).toBe(6);
    for (const r of sections[2].slice(1)) expect(Number(r[1])).toBe(0);
    // by_period and top_sharers are header-only.
    expect(sections[3].slice(1).length).toBe(0);
    expect(sections[4].slice(1).length).toBe(0);
  });

  it("escapes commas / quotes per RFC 4180 in member identifying fields", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const sections = splitSections(parseCsv(res.text));
    const sharerRows = sections[4].slice(1);
    const a2 = sharerRows.find(r => r[1] === String(userA2Id));
    expect(a2).toBeDefined();
    // Username with embedded commas comes back through the parser
    // unmangled — proves the field was quoted on the way out.
    expect(a2![2]).toBe(userA2Username);
    // Display name with embedded double quotes round-trips too.
    expect(a2![3]).toBe(userA2DisplayName);
  });
});
