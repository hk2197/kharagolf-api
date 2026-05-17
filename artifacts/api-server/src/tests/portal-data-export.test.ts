/**
 * Integration tests: Self-serve data export (Task #468).
 *
 * Members can request a tracked archive of their personal data via:
 *   - GET  /api/portal/my-data-export                 → list with computed status
 *   - POST /api/portal/my-data-export                 → create + immediately fulfill
 *   - GET  /api/portal/my-data-export/:id/download    → stream the JSON archive
 *
 * Object storage is mocked because the test environment doesn't run the
 * Replit storage sidecar; the route is designed to fall back to on-demand
 * regeneration when storage is unreachable, so we exercise that fallback.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({}) }) },
  ObjectStorageService: class {
    async saveRawBuffer(): Promise<string> {
      throw new Error("object storage disabled in tests");
    }
    async getObjectEntityFile(): Promise<never> {
      throw new Error("object storage disabled in tests");
    }
  },
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
  sendTransactionalSms: vi.fn(async () => undefined),
  sendBroadcast: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
}));

vi.mock("../lib/dataRequestNotify.js", () => ({
  notifyDataRequest: vi.fn(async () => ({
    emailStatus: "skipped",
    pushStatus: "skipped",
    smsStatus: "skipped",
    inAppMessageId: null,
  })),
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
import { createTestApp, type TestUser } from "./helpers.js";

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_messages (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sender_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      channel text NOT NULL DEFAULT 'in_app',
      subject text, body text NOT NULL,
      status text NOT NULL DEFAULT 'sent',
      sent_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz, error_message text,
      related_entity text, related_entity_id integer
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_data_requests (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      request_type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz NOT NULL DEFAULT now(),
      due_by timestamptz, resolved_at timestamptz, notes text, artifact_url text,
      handler_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      last_notification_kind text, last_notified_at timestamptz,
      last_email_status text, last_email_at timestamptz, last_email_error text,
      last_in_app_message_id integer REFERENCES member_messages(id) ON DELETE SET NULL,
      last_in_app_at timestamptz,
      last_push_status text, last_push_at timestamptz, last_push_error text,
      last_sms_status text, last_sms_at timestamptz, last_sms_error text,
      push_attempts integer NOT NULL DEFAULT 0, sms_attempts integer NOT NULL DEFAULT 0,
      last_push_retry_at timestamptz, last_sms_retry_at timestamptz,
      push_retry_exhausted_at timestamptz, sms_retry_exhausted_at timestamptz,
      email_attempts integer NOT NULL DEFAULT 0,
      last_email_retry_at timestamptz, email_retry_exhausted_at timestamptz,
      email_exhaustion_notified_at timestamptz,
      push_exhaustion_notified_at timestamptz,
      sms_exhaustion_notified_at timestamptz
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_audit_log (
      id serial PRIMARY KEY,
      club_member_id integer REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      actor_name text, actor_role text,
      entity text NOT NULL, entity_id integer, action text NOT NULL,
      field_changes jsonb, reason text, metadata jsonb,
      ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
}

let testOrgId: number;
let testMemberId: number;
let testUserId: number;
let actor: TestUser;
let app: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  await ensureSchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_DataExport_${ts}`,
    slug: `test-data-export-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `data-export-${ts}`,
    username: `data_export_${ts}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Export",
    lastName: "Tester",
    email: `data-export-${ts}@example.test`,
    userId: testUserId,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  actor = { id: testUserId, username: `data_export_${ts}`, role: "player", organizationId: testOrgId };
  app = createTestApp(actor);
});

afterAll(async () => {
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

describe("portal /my-data-export", () => {
  it("creates a fulfilled access request and exposes a download link", async () => {
    const res = await request(app).post("/api/portal/my-data-export").send({});
    expect(res.status).toBe(201);
    expect(res.body.reused).toBe(false);
    expect(res.body.export.computedStatus).toBe("ready");
    expect(res.body.export.downloadUrl).toBe(`/api/portal/my-data-export/${res.body.export.id}/download`);
    expect(res.body.export.expiresAt).toBeTruthy();

    const [row] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, res.body.export.id));
    expect(row.requestType).toBe("access");
    expect(row.status).toBe("completed");
    expect(row.resolvedAt).toBeTruthy();
  });

  it("lists the export back to the member with its computed status", async () => {
    const list = await request(app).get("/api/portal/my-data-export");
    expect(list.status).toBe(200);
    expect(list.body.validForDays).toBe(7);
    expect(list.body.exports.length).toBeGreaterThan(0);
    const ready = list.body.exports.find((e: { computedStatus: string }) => e.computedStatus === "ready");
    expect(ready).toBeTruthy();
  });

  it("regenerates the JSON archive on download when object storage is unreachable", async () => {
    const list = await request(app).get("/api/portal/my-data-export");
    const ready = list.body.exports.find((e: { computedStatus: string }) => e.computedStatus === "ready");
    expect(ready).toBeTruthy();
    const dl = await request(app).get(`/api/portal/my-data-export/${ready.id}/download`);
    expect(dl.status).toBe(200);
    const json = JSON.parse(dl.text);
    expect(json.member.id).toBe(testMemberId);
    expect(Array.isArray(json.consents)).toBe(true);
    expect(Array.isArray(json.documents)).toBe(true);
    expect(json.exportedAt).toBeTruthy();
  });

  it("is idempotent when a pending export already exists", async () => {
    // Manually insert a pending row to simulate a queued (not yet fulfilled)
    // export, then verify a new POST returns the same row instead of queuing
    // a duplicate.
    const [pending] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "pending",
    }).returning();

    const res = await request(app).post("/api/portal/my-data-export").send({});
    expect(res.status).toBe(200);
    expect(res.body.reused).toBe(true);
    expect(res.body.export.id).toBe(pending.id);
    expect(res.body.export.computedStatus).toBe("pending");

    await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, pending.id));
  });

  it("returns 410 Gone when the archive has expired", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const [expired] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      requestType: "access",
      status: "completed",
      resolvedAt: eightDaysAgo,
    }).returning();
    const dl = await request(app).get(`/api/portal/my-data-export/${expired.id}/download`);
    expect(dl.status).toBe(410);
    await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, expired.id));
  });

  it("returns a download URL from /signed-url, falling back to the proxy when storage is unreachable", async () => {
    const list = await request(app).get("/api/portal/my-data-export");
    const ready = list.body.exports.find((e: { computedStatus: string }) => e.computedStatus === "ready");
    expect(ready).toBeTruthy();
    expect(ready.signedUrlEndpoint).toBe(`/api/portal/my-data-export/${ready.id}/signed-url`);
    const signed = await request(app).get(ready.signedUrlEndpoint);
    expect(signed.status).toBe(200);
    // Object storage is mocked unreachable in this test, so the endpoint
    // should gracefully return the proxy /download URL with signed=false.
    expect(signed.body.signed).toBe(false);
    expect(signed.body.url).toBe(`/api/portal/my-data-export/${ready.id}/download`);
  });

  it("rejects download for an export belonging to someone else", async () => {
    // Create another member in the same org with their own export.
    const [otherUser] = await db.insert(appUsersTable).values({
      replitUserId: `other-${Date.now()}`,
      username: `other_${Date.now()}`,
      role: "player",
      organizationId: testOrgId,
    }).returning({ id: appUsersTable.id });
    const [otherMember] = await db.insert(clubMembersTable).values({
      organizationId: testOrgId,
      firstName: "Other", lastName: "Member",
      email: `other-${Date.now()}@example.test`,
      userId: otherUser.id,
    }).returning({ id: clubMembersTable.id });
    const [theirExport] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: otherMember.id,
      requestType: "access",
      status: "completed",
      resolvedAt: new Date(),
    }).returning();

    const dl = await request(app).get(`/api/portal/my-data-export/${theirExport.id}/download`);
    expect(dl.status).toBe(404);

    await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, theirExport.id));
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, otherMember.id));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, otherUser.id));
  });
});
