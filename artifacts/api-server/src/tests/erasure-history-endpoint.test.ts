/**
 * Integration tests: GET /:memberId/erasure-history(.csv) — Task #776.
 *
 * The account-erasure cron writes per-table row counts and object-storage
 * outcomes into `member_audit_log.metadata`. These two read-only endpoints
 * project that JSON into the structured shape the controller-facing UI and
 * the regulator CSV export need. This suite locks in:
 *
 *   1. JSON endpoint returns one entry per erasure audit row, with the
 *      per-table breakdown summed into `totalMediaRowsPurged`.
 *   2. Audit rows that are NOT erasures (e.g. unrelated club_member.delete
 *      with no `mediaTablesPurged`) are filtered out.
 *   3. CSV endpoint sets the right Content-Type / Content-Disposition and
 *      includes a column per table observed across all entries.
 *   4. `objectStorageFilesFailed` round-trips so the UI can render the
 *      "re-run cleanup" warning.
 *   5. Non-admin callers are rejected (403).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberAuditLogTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_audit_log (
      id serial PRIMARY KEY,
      club_member_id integer REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      actor_name text,
      actor_role text,
      entity text NOT NULL,
      entity_id integer,
      action text NOT NULL,
      field_changes jsonb,
      reason text,
      metadata jsonb,
      ip_address text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE member_audit_log ADD COLUMN IF NOT EXISTS metadata jsonb`);
}

let testOrgId: number;
let testMemberId: number;
let adminUserId: number;
let nonAdminUserId: number;
let admin: TestUser;
let nonAdmin: TestUser;
let app: ReturnType<typeof createTestApp>;
let nonAdminApp: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_ErasureHistory_${ts}`,
    slug: `test-erasure-history-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Erased",
    lastName: "Member",
    email: "erased@example.test",
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `eh-admin-${ts}`,
    username: `eh_admin_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: adminUserId,
    role: "org_admin",
  });

  const [nonAdminRow] = await db.insert(appUsersTable).values({
    replitUserId: `eh-player-${ts}`,
    username: `eh_player_${ts}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  nonAdminUserId = nonAdminRow.id;

  admin = { id: adminUserId, username: `eh_admin_${ts}`, role: "org_admin", organizationId: testOrgId };
  nonAdmin = { id: nonAdminUserId, username: `eh_player_${ts}`, role: "player" };
  app = createTestApp(admin);
  nonAdminApp = createTestApp(nonAdmin);

  // Two erasure runs (older + newer) so we can verify ordering, table-column
  // union in CSV, and that the warning surface honours the failed counter.
  await db.insert(memberAuditLogTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    entity: "club_member",
    entityId: testMemberId,
    action: "delete",
    actorName: "system",
    reason: "auto-erasure (cron) — first attempt",
    createdAt: new Date(Date.now() - 60_000),
    metadata: {
      source: "cron",
      autoErasure: true,
      dataRequestId: 42,
      playerRowsScrubbed: 1,
      mediaRowsScrubbed: 5,
      mediaTablesPurged: { media: 3, swing_videos: 2 },
      objectStorageFilesDeleted: 4,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: 1,
      objectStorageDisabled: false,
    },
  });
  await db.insert(memberAuditLogTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    entity: "club_member",
    entityId: testMemberId,
    action: "delete",
    actorName: "system",
    reason: "auto-erasure (cron) — re-run",
    createdAt: new Date(),
    metadata: {
      source: "cron",
      autoErasure: true,
      dataRequestId: 42,
      playerRowsScrubbed: 0,
      mediaRowsScrubbed: 0,
      mediaTablesPurged: { member_documents: 1 },
      objectStorageFilesDeleted: 1,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: 0,
      objectStorageDisabled: false,
    },
  });
  // Task #1794 — controller acknowledgement row recording why a stuck
  // cleanup alert was silenced. The CSV must surface the note + actor
  // for this row only (other rows leave the columns blank).
  await db.insert(memberAuditLogTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    entity: "club_member",
    entityId: testMemberId,
    action: "delete",
    actorName: "Reg U. Lator",
    reason: "auto-erasure storage cleanup acknowledged by controller — bucket purged out-of-band",
    createdAt: new Date(Date.now() + 60_000),
    metadata: {
      source: "controller_acknowledgement",
      autoErasure: true,
      dataRequestId: 42,
      playerRowsScrubbed: 0,
      mediaRowsScrubbed: 0,
      mediaTablesPurged: {},
      objectStorageFilesDeleted: 0,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: 1,
      objectStorageDisabled: false,
      acknowledgedAuditId: 999_999,
      // Includes a comma + quote so the CSV escaping path is exercised end-to-end.
      acknowledgementNote: 'bucket purged out-of-band, see "ticket #42"',
    },
  });
  // Noise: an unrelated club_member.delete row with no media metadata
  // (e.g. a manual hard-delete) — must NOT appear in the erasure history.
  await db.insert(memberAuditLogTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    entity: "club_member",
    entityId: testMemberId,
    action: "delete",
    actorName: "admin",
    reason: "manual delete",
    metadata: { source: "manual" },
  });
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, nonAdminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

const URL = `/api/organizations/${0}`;
const baseUrl = () => `/api/organizations/${testOrgId}/members-360/${testMemberId}`;

describe("GET /:memberId/erasure-history", () => {
  it("returns each erasure run with per-table counts and storage outcomes (most recent first)", async () => {
    const res = await request(app).get(`${baseUrl()}/erasure-history`);
    expect(res.status, res.text).toBe(200);
    const entries = res.body.entries as Array<{
      mediaTablesPurged: Record<string, number>;
      totalMediaRowsPurged: number;
      objectStorageFilesFailed: number;
      objectStorageFilesDeleted: number;
      dataRequestId: number;
      source: string;
    }>;
    // Two erasure runs + one controller_acknowledgement row (Task #1794).
    expect(entries.length).toBe(3);
    // Most recent is the controller acknowledgement row.
    expect(entries[0].source).toBe("controller_acknowledgement");
    // Then the re-run (no failures left).
    expect(entries[1].mediaTablesPurged.member_documents).toBe(1);
    expect(entries[1].totalMediaRowsPurged).toBe(1);
    expect(entries[1].objectStorageFilesFailed).toBe(0);
    // First attempt records the warning state controllers must investigate.
    expect(entries[2].mediaTablesPurged.media).toBe(3);
    expect(entries[2].mediaTablesPurged.swing_videos).toBe(2);
    expect(entries[2].totalMediaRowsPurged).toBe(5);
    expect(entries[2].objectStorageFilesFailed).toBe(1);
    expect(entries[2].objectStorageFilesDeleted).toBe(4);
    expect(entries[2].dataRequestId).toBe(42);
    expect(entries[2].source).toBe("cron");
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(nonAdminApp).get(`${baseUrl()}/erasure-history`);
    expect(res.status).toBe(403);
  });
});

describe("GET /:memberId/erasure-history.csv", () => {
  it("returns a CSV with one row per erasure and a column per table observed", async () => {
    const res = await request(app).get(`${baseUrl()}/erasure-history.csv`);
    expect(res.status, res.text).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toContain(`erasure-history-member-${testMemberId}.csv`);
    const csv = res.text;
    // Header includes union of tables across all entries.
    expect(csv).toMatch(/purged_media/);
    expect(csv).toMatch(/purged_swing_videos/);
    expect(csv).toMatch(/purged_member_documents/);
    expect(csv).toMatch(/object_storage_files_failed/);
    // Three data rows (two erasure runs + one acknowledgement) + header line.
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(4);
    // Failed counter from the older run is preserved.
    expect(csv).toContain('"1"'); // appears for objectStorageFilesFailed=1
  });

  it("includes acknowledgement_note + acknowledged_by columns alongside the existing object-storage counters", async () => {
    const res = await request(app).get(`${baseUrl()}/erasure-history.csv`);
    expect(res.status, res.text).toBe(200);

    // Proper RFC-4180-ish CSV parser (handles quoted commas + escaped quotes)
    // so we can trust the column indices and the round-tripped note value.
    const parseCsv = (text: string): string[][] => {
      const rows: string[][] = [];
      let row: string[] = [];
      let cell = "";
      let inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
          if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
          else if (ch === '"') { inQuotes = false; }
          else { cell += ch; }
        } else {
          if (ch === '"') inQuotes = true;
          else if (ch === ",") { row.push(cell); cell = ""; }
          else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
          else if (ch === "\r") { /* skip */ }
          else { cell += ch; }
        }
      }
      if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
      return rows;
    };

    const rows = parseCsv(res.text);
    const headerCells = rows[0];
    const dataRows = rows.slice(1);

    // Lock in positional contract: the two new columns sit immediately after
    // the existing object-storage counter block. If anyone reorders this in
    // the future the regulator-facing schema will visibly break.
    const disabledIdx = headerCells.indexOf("object_storage_disabled");
    expect(disabledIdx).toBeGreaterThan(-1);
    expect(headerCells[disabledIdx + 1]).toBe("acknowledgement_note");
    expect(headerCells[disabledIdx + 2]).toBe("acknowledged_by");
    expect(headerCells.length).toBe(disabledIdx + 3);

    const noteIdx = disabledIdx + 1;
    const actorIdx = disabledIdx + 2;
    const sourceIdx = headerCells.indexOf("source");

    const ackRow = dataRows.find(r => r[sourceIdx] === "controller_acknowledgement");
    expect(ackRow).toBeDefined();
    // Round-trips the note verbatim, including the embedded comma + quotes.
    expect(ackRow![noteIdx]).toBe('bucket purged out-of-band, see "ticket #42"');
    expect(ackRow![actorIdx]).toBe("Reg U. Lator");

    // Every non-acknowledgement row leaves both columns blank, even though
    // the underlying audit row carries an `actorName` ("system").
    const nonAckRows = dataRows.filter(r => r[sourceIdx] !== "controller_acknowledgement");
    expect(nonAckRows.length).toBe(2);
    for (const r of nonAckRows) {
      expect(r[noteIdx]).toBe("");
      expect(r[actorIdx]).toBe("");
    }
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(nonAdminApp).get(`${baseUrl()}/erasure-history.csv`);
    expect(res.status).toBe(403);
  });
});
