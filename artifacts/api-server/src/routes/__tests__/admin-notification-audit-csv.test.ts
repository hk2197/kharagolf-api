/**
 * Task #1360 — GET /api/admin/notification-audit.csv
 * Task #1623 — extended to cover streaming behaviour.
 *
 * Pins the contract on the CSV export of the notification audit feed:
 *   • Same role gating as the JSON list endpoint (401/403).
 *   • Org admin sees only their org's rows; super admin sees everything,
 *     including null-recipient (broadcast/admin) rows.
 *   • Reuses the same filter parsing — key, channel, status, userId,
 *     userQuery, since/until — and exports every matching row, not just
 *     the visible page.
 *   • Header row matches the documented column contract.
 *   • Recipient username and email are surfaced from the joined user.
 *   • Payload is flattened to a single JSON-string column.
 *   • Strings containing commas / quotes / newlines are escaped per
 *     RFC 4180 so spreadsheets parse the file correctly.
 *   • Content-Type and Content-Disposition headers trigger a download.
 *   • 400 errors propagate from the shared parser (malformed since).
 *   • Task #1623: response is streamed — chunked transfer-encoding,
 *     no Content-Length, header row arrives in the first chunk, and
 *     row counts spanning multiple cursor batches still come through
 *     correctly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

import {
  db,
  organizationsTable,
  appUsersTable,
  notificationAuditLogTable,
  dbCancellation,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let playerAId: number;
let superAdminId: number;
let userA1Id: number;
let userA2Id: number;
let userBId: number;

const auditIds: number[] = [];

const TS_OLD = new Date("2025-01-15T12:00:00Z");
const TS_MID = new Date("2025-06-15T12:00:00Z");
const TS_NEW = new Date("2025-12-15T12:00:00Z");

async function seedAudit(opts: {
  key: string; userId: number | null; channel: string; status: string;
  reason?: string | null; payload?: Record<string, unknown>; createdAt: Date;
}): Promise<number> {
  const [r] = await db.insert(notificationAuditLogTable).values({
    notificationKey: opts.key,
    userId: opts.userId,
    channel: opts.channel,
    status: opts.status,
    reason: opts.reason ?? null,
    payload: opts.payload ?? {},
    createdAt: opts.createdAt,
  }).returning({ id: notificationAuditLogTable.id });
  auditIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1360_A_${stamp}`, slug: `t1360-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1360_B_${stamp}`, slug: `t1360-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1360-admin-a-${stamp}`,
    username: `t1360_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1360.test`,
    role: "org_admin", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id;

  const [playerA] = await db.insert(appUsersTable).values({
    replitUserId: `t1360-player-a-${stamp}`,
    username: `t1360_player_a_${stamp}`,
    email: `player_a_${stamp}@t1360.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerAId = playerA.id;

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `t1360-super-${stamp}`,
    username: `t1360_super_${stamp}`,
    email: `super_${stamp}@t1360.test`,
    role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = su.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `t1360-recipA1-${stamp}`,
    username: `recipA1_${stamp}`,
    displayName: "Alice Anders",
    email: `alice_${stamp}@t1360.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA1Id = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `t1360-recipA2-${stamp}`,
    // Username with an embedded comma — exercises RFC 4180 quoting.
    username: `recipA2,with,commas_${stamp}`,
    displayName: 'Bob "Quote" Brown',
    email: `bob_${stamp}@t1360.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA2Id = u2.id;

  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `t1360-recipB-${stamp}`,
    username: `recipB_${stamp}`,
    displayName: "Carol Cross",
    email: `carol_${stamp}@t1360.test`,
    role: "player", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  userBId = u3.id;

  // Org A audit rows.
  await seedAudit({
    key: "handicap.committee.changed", userId: userA1Id,
    channel: "email", status: "sent", reason: null,
    payload: { from: 12.4, to: 11.8 }, createdAt: TS_OLD,
  });
  await seedAudit({
    key: "handicap.committee.changed", userId: userA1Id,
    channel: "push", status: "skipped",
    // Reason with a comma + newline — must be quoted in the CSV.
    reason: "no device tokens, last seen 5 days ago\nretry tomorrow",
    payload: {}, createdAt: TS_MID,
  });
  await seedAudit({
    key: "caddie.mode.blocked", userId: userA2Id,
    channel: "push", status: "sent", reason: null,
    payload: { mode: "tournament", note: 'has "quotes"' }, createdAt: TS_NEW,
  });
  // Org B audit row — must never leak to admin A.
  await seedAudit({
    key: "handicap.committee.changed", userId: userBId,
    channel: "email", status: "failed", reason: "smtp 550",
    payload: {}, createdAt: TS_MID,
  });
  // Null-recipient row (admin / broadcast alert).
  await seedAudit({
    key: "scheduled.email.failed", userId: null,
    channel: "email", status: "failed", reason: "ops alert",
    payload: { jobId: "abc" }, createdAt: TS_NEW,
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

async function call(user: TestUser | undefined, query = "") {
  const app = createTestApp(user);
  return request(app).get(`/api/admin/notification-audit.csv${query}`);
}

// Tiny RFC 4180 parser for CSV. Sufficient for asserting on our own
// well-formed output — handles quoted fields, doubled quotes, and
// embedded CR/LF.
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

describe("GET /api/admin/notification-audit.csv", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await call(undefined);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await call(asUser(playerAId, "player", orgAId));
    expect(res.status).toBe(403);
  });

  it("emits a CSV download with the documented header row for super admins", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment;.*notification-audit-.*\.csv/);
    expect(res.headers["cache-control"]).toMatch(/no-store/);

    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      "timestamp",
      "notification_key",
      "recipient_username",
      "recipient_email",
      "channel",
      "status",
      "reason",
      "payload",
    ]);
    // At least one data row, and every non-empty data row should match
    // the column count of the header.
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows.slice(1)) {
      expect(r.length).toBe(8);
    }
  });

  it("scopes rows to the org admin's own org and excludes null-recipient rows", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    const data = rows.slice(1);
    // Every data row must belong to one of Org A's recipients (we wrote
    // the email column with the joined user's email).
    const orgAEmails = data.map(r => r[3]);
    for (const email of orgAEmails) {
      expect(email).toMatch(/@t1360\.test$/);
      expect(email).not.toMatch(/^carol_/); // Org B recipient
    }
    // The null-recipient broadcast row has empty username + email.
    const blank = data.filter(r => r[2] === "" && r[3] === "");
    expect(blank).toHaveLength(0);
  });

  it("super admin sees Org B and null-recipient rows too", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    const emails = data.map(r => r[3]);
    expect(emails.some(e => /^carol_/.test(e))).toBe(true);
    // Null-recipient row: username + email columns are blank, key is the
    // ops-alert key.
    const broadcast = data.find(r => r[1] === "scheduled.email.failed");
    expect(broadcast).toBeDefined();
    expect(broadcast?.[2]).toBe("");
    expect(broadcast?.[3]).toBe("");
  });

  it("exports every row, not just the visible page (ignores limit / page)", async () => {
    // Org A has 3 rows. Even with limit=1, all 3 must be exported.
    const res = await call(asUser(adminAId, "org_admin", orgAId), "?limit=1&page=1");
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    expect(data.length).toBe(3);
  });

  it("applies the same filters as the JSON endpoint (key)", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId), "?key=caddie.mode.blocked");
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    expect(data.length).toBeGreaterThan(0);
    for (const r of data) expect(r[1]).toBe("caddie.mode.blocked");
  });

  it("applies the same filters as the JSON endpoint (channel + status + date range)", async () => {
    const res = await call(
      asUser(superAdminId, "super_admin", null),
      `?channel=push&status=sent&since=${encodeURIComponent("2025-12-01T00:00:00Z")}`,
    );
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    expect(data.length).toBeGreaterThan(0);
    for (const r of data) {
      expect(r[4]).toBe("push");
      expect(r[5]).toBe("sent");
      expect(new Date(r[0]).getTime()).toBeGreaterThanOrEqual(
        new Date("2025-12-01T00:00:00Z").getTime(),
      );
    }
  });

  it("applies the userQuery free-text filter", async () => {
    const res = await call(asUser(adminAId, "org_admin", orgAId), "?userQuery=Alice");
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    expect(data.length).toBeGreaterThan(0);
    for (const r of data) {
      // The `recipient_email` column should match Alice's address.
      expect(r[3]).toMatch(/^alice_/);
    }
  });

  it("flattens the payload to a single JSON-string column and round-trips", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null), "?key=caddie.mode.blocked");
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    expect(data.length).toBeGreaterThan(0);
    const payloadCol = data[0][7];
    // Must be valid JSON, and round-trip back to an object containing the
    // seeded keys (including a value that itself contains quotes).
    const parsed = JSON.parse(payloadCol) as Record<string, unknown>;
    expect(parsed.mode).toBe("tournament");
    expect(parsed.note).toBe('has "quotes"');
  });

  it("escapes commas / quotes / newlines per RFC 4180", async () => {
    // Org A row whose recipient username contains commas, displayName
    // contains quotes, and reason contains a comma + newline.
    const res = await call(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const data = parseCsv(res.text).slice(1);
    // Find the row whose username starts with "recipA2,with,commas_".
    const row = data.find(r => r[2].startsWith("recipA2,with,commas_"));
    expect(row).toBeDefined();
    // The parser already validated the comma-in-username made it through.
    // Find the row whose reason contains an embedded newline.
    const newlineRow = data.find(r => /\n/.test(r[6]));
    expect(newlineRow).toBeDefined();
    expect(newlineRow?.[6]).toContain("retry tomorrow");
  });

  it("returns 400 for malformed since (shared parser passthrough)", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null), "?since=not-a-date");
    expect(res.status).toBe(400);
  });

  it("rejects repeated query parameters with 400 (shared parser passthrough)", async () => {
    const res = await call(asUser(superAdminId, "super_admin", null), "?key=a&key=b");
    expect(res.status).toBe(400);
  });

  it("returns a header-only CSV for an org_admin with no organization", async () => {
    // Misconfigured org_admin — the JSON endpoint returns an empty
    // payload; the CSV endpoint should mirror that with just a header.
    const res = await call({ id: -1, username: "no_org", role: "org_admin" });
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe("timestamp");
  });

  // --- Task #1623: streaming behaviour ---------------------------------

  it("streams the response with chunked transfer-encoding and no Content-Length", async () => {
    // The streaming export must NOT pre-buffer the entire body — the
    // browser should be able to start receiving rows before the query
    // has finished. That's signalled by chunked transfer-encoding +
    // the absence of a Content-Length header.
    const res = await call(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    expect(res.headers["transfer-encoding"]).toBe("chunked");
    expect(res.headers["content-length"]).toBeUndefined();
  });

  it("buffers the empty / header-only response (no rows to stream)", async () => {
    // Sanity check: the streaming path is gated on having a real query
    // to run. The misconfigured-admin short-circuit just sends the
    // header row in one shot, so it can keep using a fixed-length
    // response — the contract here is just that the file is valid.
    const res = await call({ id: -1, username: "no_org", role: "org_admin" });
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(1);
  });

  it("returns every row when the matched set spans multiple cursor batches", async () => {
    // Internal FETCH batch size is 500 rows. Seed enough extra rows
    // (under a unique notification key so we can filter cleanly and
    // not perturb the other tests) that the export must loop through
    // multiple batches, then assert every single one came through.
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const batchKey = `t1623.streaming.batch.${stamp}`;
    const ROW_COUNT = 1_250; // > 2 full batches
    const insertedIds: number[] = [];
    try {
      // Bulk-insert in chunks to keep the seed itself fast — the
      // route's own batching is what we're exercising here.
      const baseTs = new Date("2025-03-01T00:00:00Z").getTime();
      const CHUNK = 250;
      for (let offset = 0; offset < ROW_COUNT; offset += CHUNK) {
        const values = [];
        for (let i = 0; i < CHUNK && offset + i < ROW_COUNT; i++) {
          values.push({
            notificationKey: batchKey,
            userId: userA1Id,
            channel: "email",
            status: "sent",
            reason: null,
            payload: { seq: offset + i },
            createdAt: new Date(baseTs + (offset + i) * 1000),
          });
        }
        const inserted = await db
          .insert(notificationAuditLogTable)
          .values(values)
          .returning({ id: notificationAuditLogTable.id });
        for (const r of inserted) insertedIds.push(r.id);
      }

      const res = await call(
        asUser(superAdminId, "super_admin", null),
        `?key=${encodeURIComponent(batchKey)}`,
      );
      expect(res.status).toBe(200);
      // Streaming headers must still be set on the multi-batch path.
      expect(res.headers["transfer-encoding"]).toBe("chunked");
      expect(res.headers["content-length"]).toBeUndefined();

      const data = parseCsv(res.text).slice(1);
      expect(data).toHaveLength(ROW_COUNT);
      // Spot-check that every row belongs to the seeded key (i.e. the
      // filter applied identically across batches).
      for (const r of data) expect(r[1]).toBe(batchKey);
      // And that the JSON payload column round-trips for both the
      // first and the last row — a regression in row formatting
      // would surface here if a batch boundary corrupted output.
      const firstSeq = (JSON.parse(data[0][7]) as { seq: number }).seq;
      const lastSeq = (JSON.parse(data[data.length - 1][7]) as { seq: number }).seq;
      // Sorted by createdAt DESC, so the first emitted row is the
      // newest seed (highest seq) and the last is the oldest (seq 0).
      expect(firstSeq).toBe(ROW_COUNT - 1);
      expect(lastSeq).toBe(0);
    } finally {
      if (insertedIds.length > 0) {
        await db
          .delete(notificationAuditLogTable)
          .where(inArray(notificationAuditLogTable.id, insertedIds));
      }
    }
  });

  it("releases the DB client cleanly when the admin aborts a streaming export", async () => {
    // Regression for Task #1623 review: the backpressure wait inside
    // `streamAuditCsv` used to listen only for `drain` and `error`.
    // If the client disconnected while the response stream was
    // backpressured, the promise would never resolve — leaving the
    // handler stuck mid-transaction and holding a pooled DB client.
    // We can't reliably force backpressure on loopback, but we can
    // verify the broader contract: aborting an in-flight streaming
    // export must not strand resources, so a follow-up export
    // succeeds promptly. With ~16 aborted requests against the
    // default pool size of 10, a strand would deadlock the next
    // request indefinitely.
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const probeKey = `t1623.streaming.abort.${stamp}`;
    const ROW_COUNT = 800; // span at least 2 cursor batches
    const baseTs = new Date("2025-05-01T00:00:00Z").getTime();
    const inserted = await db
      .insert(notificationAuditLogTable)
      .values(Array.from({ length: ROW_COUNT }, (_, i) => ({
        notificationKey: probeKey,
        userId: userA1Id,
        channel: "email",
        status: "sent",
        reason: null,
        payload: { i },
        createdAt: new Date(baseTs + i * 1000),
      })))
      .returning({ id: notificationAuditLogTable.id });
    const insertedIds = inserted.map(r => r.id);

    try {
      const app = createTestApp(asUser(superAdminId, "super_admin", null));
      const server = app.listen(0);
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const url = `http://127.0.0.1:${address.port}/api/admin/notification-audit.csv?key=${encodeURIComponent(probeKey)}`;
        const http = await import("node:http");

        // Fire ~16 streaming requests and abort each one as soon as
        // it returns its first byte. Any of them that leaked would
        // permanently hold a connection from the pool.
        const ABORT_COUNT = 16;
        await Promise.all(Array.from({ length: ABORT_COUNT }, () => new Promise<void>((resolve) => {
          const req = http.get(url, (resp) => {
            resp.once("data", () => {
              req.destroy();
              resolve();
            });
            resp.on("error", () => resolve());
            resp.on("close", () => resolve());
          });
          req.on("error", () => resolve());
        })));

        // Give the server a beat to run its `res.on('close')` cleanup
        // and release pool clients back to the pool.
        await new Promise((r) => setTimeout(r, 250));

        // A follow-up streaming request must complete normally and
        // promptly. If any prior abort had stranded its DB client,
        // this would block until the OS-level socket timeout fires
        // (orders of magnitude longer than the test timeout).
        const followUp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Follow-up request after aborts did not complete in time — pool likely stranded"));
          }, 5_000);
          http.get(url, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c: Buffer) => chunks.push(c));
            resp.on("end", () => {
              clearTimeout(timeout);
              resolve({
                status: resp.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
            resp.on("error", (err) => { clearTimeout(timeout); reject(err); });
          }).on("error", (err) => { clearTimeout(timeout); reject(err); });
        });

        expect(followUp.status).toBe(200);
        const data = parseCsv(followUp.body).slice(1);
        expect(data).toHaveLength(ROW_COUNT);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      if (insertedIds.length > 0) {
        await db
          .delete(notificationAuditLogTable)
          .where(inArray(notificationAuditLogTable.id, insertedIds));
      }
    }
  });

  it("issues a Postgres pg_cancel_backend when the admin aborts mid-stream", async () => {
    // Task #2016: closing the tab during a streaming export must
    // trigger a side-channel `pg_cancel_backend(pid)` so the in-flight
    // FETCH gets interrupted server-side instead of waiting for the
    // next batch boundary. We assert the contract by spying on the
    // cancel helper and aborting partway through.
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const probeKey = `t2016.cancel.invoked.${stamp}`;
    const ROW_COUNT = 800; // span at least 2 cursor batches
    const baseTs = new Date("2025-06-01T00:00:00Z").getTime();
    const inserted = await db
      .insert(notificationAuditLogTable)
      .values(Array.from({ length: ROW_COUNT }, (_, i) => ({
        notificationKey: probeKey,
        userId: userA1Id,
        channel: "email" as const,
        status: "sent" as const,
        reason: null,
        payload: { i },
        createdAt: new Date(baseTs + i * 1000),
      })))
      .returning({ id: notificationAuditLogTable.id });
    const insertedIds = inserted.map(r => r.id);

    const cancelSpy = vi.spyOn(dbCancellation, "cancelBackend");
    try {
      const app = createTestApp(asUser(superAdminId, "super_admin", null));
      const server = app.listen(0);
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const url = `http://127.0.0.1:${address.port}/api/admin/notification-audit.csv?key=${encodeURIComponent(probeKey)}`;
        const http = await import("node:http");

        // Open a streaming request, wait for the first byte (proves
        // the export has acquired its pool client and dispatched
        // FETCH), then abort.
        await new Promise<void>((resolve, reject) => {
          const req = http.get(url, (resp) => {
            resp.once("data", () => {
              req.destroy();
              resolve();
            });
            resp.on("error", () => resolve());
            resp.on("close", () => resolve());
          });
          req.on("error", reject);
        });

        // Give the server a beat to run the close handler. The cancel
        // is fire-and-forget — we don't await it from the route — so
        // we poll briefly for the spy to register the call.
        const deadline = Date.now() + 2_000;
        while (cancelSpy.mock.calls.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }

        expect(cancelSpy).toHaveBeenCalledTimes(1);
        const pidArg = cancelSpy.mock.calls[0]?.[0];
        expect(typeof pidArg).toBe("number");
        expect(pidArg as number).toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      cancelSpy.mockRestore();
      if (insertedIds.length > 0) {
        await db
          .delete(notificationAuditLogTable)
          .where(inArray(notificationAuditLogTable.id, insertedIds));
      }
    }
  });

  it("flushes the CSV header in the first chunk before the row body", async () => {
    // Use the raw HTTP layer (not supertest's buffered .text) so we
    // can inspect chunks individually. The first chunk must already
    // contain the header line — this is the user-visible "downloads
    // begin within a second" guarantee from the task spec.
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const probeKey = `t1623.streaming.firstchunk.${stamp}`;
    // Seed a handful of rows so there's body to follow the header.
    const inserted = await db
      .insert(notificationAuditLogTable)
      .values(Array.from({ length: 5 }, (_, i) => ({
        notificationKey: probeKey,
        userId: userA1Id,
        channel: "email" as const,
        status: "sent" as const,
        reason: null,
        payload: { i },
        createdAt: new Date(new Date("2025-04-01T00:00:00Z").getTime() + i * 1000),
      })))
      .returning({ id: notificationAuditLogTable.id });
    const insertedIds = inserted.map(r => r.id);

    try {
      const app = createTestApp(asUser(superAdminId, "super_admin", null));
      const server = app.listen(0);
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const url = `http://127.0.0.1:${address.port}/api/admin/notification-audit.csv?key=${encodeURIComponent(probeKey)}`;

        // Use Node's http directly so we can read chunks one-by-one.
        const http = await import("node:http");
        const chunks: string[] = await new Promise((resolve, reject) => {
          http.get(url, (resp) => {
            // The streaming contract: chunked encoding + no
            // Content-Length so the browser can start writing the
            // download to disk immediately.
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

        // The very first chunk must already include the CSV header
        // line — that's the byte the browser uses to open the
        // download dialog. With buffering, the first chunk would
        // only land after the entire SELECT had drained.
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]).toMatch(/^timestamp,notification_key,/);

        // And the assembled body must still be a well-formed CSV
        // covering every seeded row.
        const rows = parseCsv(chunks.join(""));
        expect(rows[0][0]).toBe("timestamp");
        expect(rows.slice(1)).toHaveLength(5);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      if (insertedIds.length > 0) {
        await db
          .delete(notificationAuditLogTable)
          .where(inArray(notificationAuditLogTable.id, insertedIds));
      }
    }
  });
});
