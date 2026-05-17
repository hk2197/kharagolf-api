/**
 * Integration test (Task #777): the controller dashboard data feed
 * (GET /data-requests/open) surfaces self-serve data export "ready"
 * notices even though they sit on completed requests.
 *
 * Self-serve data exports complete synchronously (status='completed') and
 * the per-channel notification kind is 'completed_export'. Before this
 * task the dashboard's open-only filter hid those rows and admins could
 * not see whether the "Your data export is ready" notice reached the
 * member. This suite locks in:
 *
 *   1. A completed_export row inside the signed-URL validity window IS
 *      returned in the open-list response, with `lastNotificationKind`
 *      and `lastNotifiedAt` populated, and is reflected in the new
 *      `counts.exportReady` KPI.
 *   2. The KPI/filter does NOT inflate `counts.open`/`overdue`/`dueSoon`
 *      with completed export rows.
 *   3. A completed_export row whose lastNotifiedAt is older than the
 *      signed-URL validity window is NOT returned.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberDataRequestsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_data_requests (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      request_type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz NOT NULL DEFAULT now(),
      due_by timestamptz,
      resolved_at timestamptz,
      notes text,
      artifact_url text,
      handler_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      last_notification_kind text,
      last_notified_at timestamptz
    )
  `);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_notification_kind text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS last_notified_at timestamptz`);
}

let testOrgId: number;
let testMemberId: number;
let adminUserId: number;
let app: ReturnType<typeof createTestApp>;
const createdRequestIds: number[] = [];

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_ExportReady_${ts}`,
    slug: `test-export-ready-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Export",
    lastName: "Ready",
    email: "export-ready-member@example.test",
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `admin-export-ready-${ts}`,
    username: `admin_export_ready_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = u.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: adminUserId,
    role: "org_admin",
  });

  const admin: TestUser = {
    id: adminUserId,
    username: `admin_export_ready_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  for (const id of createdRequestIds) {
    await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, id));
  }
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

const OPEN_URL = () => `/api/organizations/${testOrgId}/members-360/data-requests/open`;

async function insertRequest(overrides: Partial<typeof memberDataRequestsTable.$inferInsert>) {
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: testOrgId,
    clubMemberId: testMemberId,
    requestType: "access",
    status: "pending",
    requestedAt: new Date(),
    ...overrides,
  }).returning();
  createdRequestIds.push(row.id);
  return row;
}

describe("GET /data-requests/open — completed_export visibility (Task #777)", () => {
  it("returns recent completed_export rows alongside open requests and reports them via counts.exportReady without inflating the open KPIs", async () => {
    const now = Date.now();
    const openReq = await insertRequest({
      status: "pending",
      dueBy: new Date(now + 30 * 86_400_000),
    });
    const recentExport = await insertRequest({
      status: "completed",
      resolvedAt: new Date(now - 60_000),
      lastNotificationKind: "completed_export",
      lastNotifiedAt: new Date(now - 60_000),
      // due_by was already in the past — would have been "overdue" if it counted.
      dueBy: new Date(now - 86_400_000),
    });
    // 30d-old completed_export — outside signed-URL validity window (7d).
    const staleExport = await insertRequest({
      status: "completed",
      resolvedAt: new Date(now - 30 * 86_400_000),
      lastNotificationKind: "completed_export",
      lastNotifiedAt: new Date(now - 30 * 86_400_000),
    });
    // Plain completed (no export notice) — must remain hidden.
    const completedNoExport = await insertRequest({
      status: "completed",
      resolvedAt: new Date(now - 60_000),
    });

    const res = await request(app).get(OPEN_URL());
    expect(res.status, res.text).toBe(200);

    const ids = (res.body.requests as Array<{ id: number; lastNotificationKind: string | null }>).map(r => r.id);
    expect(ids).toContain(openReq.id);
    expect(ids).toContain(recentExport.id);
    expect(ids).not.toContain(staleExport.id);
    expect(ids).not.toContain(completedNoExport.id);

    const exportRow = (res.body.requests as Array<{ id: number; lastNotificationKind: string | null; lastNotifiedAt: string | null }>).find(r => r.id === recentExport.id);
    expect(exportRow?.lastNotificationKind).toBe("completed_export");
    expect(exportRow?.lastNotifiedAt).toBeTruthy();

    // KPI semantics: exportReady reports the recent export count; open KPIs
    // reflect outstanding work only and are not inflated by completed rows.
    expect(res.body.counts.exportReady).toBe(1);
    expect(res.body.counts.open).toBe(1);
    // The open request's dueBy is 30d out → not overdue / not due-soon.
    expect(res.body.counts.overdue).toBe(0);
    expect(res.body.counts.dueSoon).toBe(0);
  });
});
