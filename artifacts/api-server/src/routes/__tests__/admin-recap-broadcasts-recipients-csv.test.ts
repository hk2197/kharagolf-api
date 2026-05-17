/**
 * Task #1838 — GET /api/admin/recap-broadcasts/recipients.csv
 *
 * Pins the contract on the CSV export of the recap recipient drill-down:
 *   • Same role gating as the JSON drill-down endpoint (401 unauth /
 *     403 non-admin).
 *   • Same (year, period, day) tuple validation (400 on missing /
 *     out-of-range).
 *   • Same tenant scope: org_admin sees only their org's recipients;
 *     super_admin sees every club, with an optional ?organizationId=
 *     filter.
 *   • Header row matches the documented column contract (display name,
 *     username, email, club, channel, status, sent-at).
 *   • Streamed via chunked transfer-encoding with no Content-Length
 *     so very large clubs export with bounded memory and the download
 *     dialog appears before the SELECT finishes.
 *   • Header row is flushed in the first chunk.
 *   • RFC 4180 escaping for embedded commas / quotes.
 *   • Misconfigured org_admin (no organizationId) gets a header-only
 *     CSV so downstream tooling always receives a valid file.
 *   • Unlike the JSON sibling, the CSV ignores the `limit` param and
 *     exports every matching recipient — ops admins exporting for a
 *     support ticket need the full set, not the visible page.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import {
  db,
  organizationsTable,
  appUsersTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";
import { RECAP_NOTIFICATION_KEY } from "../../lib/year-in-golf-cron.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let playerAId: number;
let superAdminId: number;
let userA1Id: number;
let userA2Id: number;
let userBId: number;

const auditIds: number[] = [];

const TEST_YEAR = 2025;
const TEST_PERIOD = "year";
const TEST_DAY = 1;

async function seedRecap(opts: {
  userId: number; channel: string; status: string;
  reason?: string | null;
  payload?: Record<string, unknown>;
  createdAt?: Date;
}): Promise<number> {
  const [r] = await db.insert(notificationAuditLogTable).values({
    notificationKey: RECAP_NOTIFICATION_KEY,
    userId: opts.userId,
    channel: opts.channel,
    status: opts.status,
    reason: opts.reason ?? null,
    payload: opts.payload ?? {
      year: TEST_YEAR, period: TEST_PERIOD, day: TEST_DAY,
    },
    createdAt: opts.createdAt ?? new Date("2025-01-01T12:00:00Z"),
  }).returning({ id: notificationAuditLogTable.id });
  auditIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1838_A_${stamp}`, slug: `t1838-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1838_B_${stamp}`, slug: `t1838-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1838-admin-a-${stamp}`,
    username: `t1838_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1838.test`,
    role: "org_admin", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id;

  const [playerA] = await db.insert(appUsersTable).values({
    replitUserId: `t1838-player-a-${stamp}`,
    username: `t1838_player_a_${stamp}`,
    email: `player_a_${stamp}@t1838.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerAId = playerA.id;

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `t1838-super-${stamp}`,
    username: `t1838_super_${stamp}`,
    email: `super_${stamp}@t1838.test`,
    role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = su.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `t1838-recipA1-${stamp}`,
    username: `recipA1_${stamp}`,
    displayName: "Alice Anders",
    email: `alice_${stamp}@t1838.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA1Id = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `t1838-recipA2-${stamp}`,
    // Username with embedded comma — exercises RFC 4180 quoting.
    username: `recipA2,with,commas_${stamp}`,
    displayName: 'Bob "Quote" Brown',
    email: `bob_${stamp}@t1838.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA2Id = u2.id;

  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `t1838-recipB-${stamp}`,
    username: `recipB_${stamp}`,
    displayName: "Carol Cross",
    email: `carol_${stamp}@t1838.test`,
    role: "player", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  userBId = u3.id;

  // Two recap dispatches in Org A for the (2025, year, 1) tuple, and
  // one in Org B. Plus one row for a different (year, period, day)
  // tuple that must NOT leak into the (2025, year, 1) export.
  await seedRecap({
    userId: userA1Id, channel: "push", status: "sent",
    createdAt: new Date("2025-01-01T12:00:00Z"),
  });
  await seedRecap({
    userId: userA2Id, channel: "email", status: "sent",
    createdAt: new Date("2025-01-01T12:00:01Z"),
  });
  await seedRecap({
    userId: userBId, channel: "push", status: "sent",
    createdAt: new Date("2025-01-01T12:00:02Z"),
  });
  // Different period — must not appear in the (2025, year, 1) export.
  await seedRecap({
    userId: userA1Id, channel: "push", status: "sent",
    payload: { year: TEST_YEAR, period: "q1", day: 1 },
    createdAt: new Date("2025-04-01T12:00:00Z"),
  });
});

afterAll(async () => {
  if (auditIds.length > 0) {
    await db.delete(notificationAuditLogTable).where(inArray(notificationAuditLogTable.id, auditIds));
  }
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [
    adminAId, playerAId, superAdminId, userA1Id, userA2Id, userBId,
  ]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

const VALID_QUERY = `year=${TEST_YEAR}&period=${TEST_PERIOD}&day=${TEST_DAY}`;

async function call(user: TestUser | undefined, query = `?${VALID_QUERY}`) {
  const app = createTestApp(user);
  return request(app).get(`/api/admin/recap-broadcasts/recipients.csv${query}`);
}

// Tiny RFC 4180 parser sufficient for asserting on our own well-formed
// output — handles quoted fields, doubled quotes, and embedded CR/LF.
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

describe("GET /api/admin/recap-broadcasts/recipients.csv", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await call(undefined);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await call(asUser(playerAId, "player", orgAId));
    expect(res.status).toBe(403);
  });

  it("returns 400 when year is missing or non-numeric", async () => {
    const missing = await call(asUser(adminAId, "org_admin", orgAId), `?period=${TEST_PERIOD}&day=${TEST_DAY}`);
    expect(missing.status).toBe(400);
    const garbage = await call(asUser(adminAId, "org_admin", orgAId), `?year=abc&period=${TEST_PERIOD}&day=${TEST_DAY}`);
    expect(garbage.status).toBe(400);
  });

  it("returns 400 when period is unknown", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId), `?year=${TEST_YEAR}&period=Q5&day=${TEST_DAY}`);
    expect(res.status).toBe(400);
  });

  it("returns 400 when day is out of range", async () => {
    const tooLow = await call(asUser(adminAId, "org_admin", orgAId), `?year=${TEST_YEAR}&period=${TEST_PERIOD}&day=0`);
    expect(tooLow.status).toBe(400);
    const tooHigh = await call(asUser(adminAId, "org_admin", orgAId), `?year=${TEST_YEAR}&period=${TEST_PERIOD}&day=99`);
    expect(tooHigh.status).toBe(400);
  });

  it("rejects super_admin's organizationId param when it isn't an integer", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null), `?${VALID_QUERY}&organizationId=abc`);
    expect(res.status).toBe(400);
  });

  it("emits a CSV download with the documented header row for super admins", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment;.*recap-recipients-.*\.csv/);
    expect(res.headers["cache-control"]).toMatch(/no-store/);

    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      "display_name",
      "username",
      "email",
      "club",
      "channel",
      "status",
      "sent_at",
    ]);
    // Three matching recipients across orgs A and B.
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows.slice(1)) {
      expect(r.length).toBe(7);
    }
  });

  it("scopes rows to the org admin's own org", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    // Only Org A's two recipients; Carol (Org B) must not appear.
    const emails = data.map(r => r[2]);
    expect(emails.length).toBe(2);
    for (const email of emails) {
      expect(email).not.toMatch(/^carol_/);
    }
    // Club column populated with the org name.
    for (const r of data) {
      expect(r[3]).toMatch(/^T1838_A_/);
    }
  });

  it("super admin sees every club", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    const emails = data.map(r => r[2]);
    expect(emails.some(e => /^carol_/.test(e))).toBe(true);
    expect(emails.some(e => /^alice_/.test(e))).toBe(true);
  });

  it("super admin can scope to a specific club via organizationId", async () => {
    const res = await call(
      asUser(superAdminId, "super_admin", null),
      `?${VALID_QUERY}&organizationId=${orgBId}`,
    );
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    expect(data.length).toBe(1);
    expect(data[0][2]).toMatch(/^carol_/);
  });

  it("excludes rows from a different (year, period, day) tuple", async () => {
    // Org A has two rows for (2025, year, 1) and one for (2025, q1, 1).
    // The (year, 1) export must NOT include the q1 row.
    const res = await call(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    expect(data.length).toBe(2);
  });

  it("ignores the limit query param (exports every matching row)", async () => {
    // Sibling JSON endpoint caps at 1000; CSV exports the full set.
    // With limit=1, the org_admin's two rows must still both come through.
    const res = await call(asUser(adminAId, "org_admin", orgAId), `?${VALID_QUERY}&limit=1`);
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    expect(data.length).toBe(2);
  });

  it("escapes commas / quotes per RFC 4180", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    // Find the row whose username starts with "recipA2,with,commas_"
    // — the parser already validated that the comma-in-username made
    // it through unmangled.
    const row = data.find(r => r[1].startsWith("recipA2,with,commas_"));
    expect(row).toBeDefined();
    // And the display name with embedded quotes round-trips.
    expect(row?.[0]).toBe('Bob "Quote" Brown');
  });

  it("returns a header-only CSV for an org_admin with no organization", async () => {
    const res = await call({ id: -1, username: "no_org", role: "org_admin" });
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe("display_name");
  });

  it("streams the response with chunked transfer-encoding and no Content-Length", async () => {
    // The streaming export must not pre-buffer the entire body — the
    // browser should be able to start receiving rows before the query
    // has finished. Signalled by chunked transfer-encoding + the
    // absence of a Content-Length header.
    const res = await call(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    expect(res.headers["transfer-encoding"]).toBe("chunked");
    expect(res.headers["content-length"]).toBeUndefined();
  });

  it("flushes the CSV header in the first chunk before the row body", async () => {
    // Use Node's http directly so we can read chunks one-by-one. The
    // very first chunk must include the header line — that's the byte
    // the browser uses to open the download dialog.
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const url = `http://127.0.0.1:${address.port}/api/admin/recap-broadcasts/recipients.csv?${VALID_QUERY}`;

      const http = await import("node:http");
      const chunks: string[] = await new Promise((resolve, reject) => {
        http.get(url, (resp) => {
          try {
            expect(resp.headers["transfer-encoding"]).toBe("chunked");
            expect(resp.headers["content-length"]).toBeUndefined();
          } catch (err) { reject(err); return; }
          const collected: string[] = [];
          resp.setEncoding("utf8");
          resp.on("data", (c: string) => collected.push(c));
          resp.on("end", () => resolve(collected));
          resp.on("error", reject);
        }).on("error", reject);
      });

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toMatch(/^display_name,username,/);

      const rows = parseCsv(chunks.join(""));
      expect(rows[0][0]).toBe("display_name");
      expect(rows.slice(1).length).toBeGreaterThanOrEqual(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
