/**
 * Tests for the admin CSV export of member notification preferences
 * (Task #1273).
 *
 * Endpoint: GET /organizations/:orgId/members/notification-prefs.csv
 *
 * Treasurers asked for a downloadable view of who is opted in/out of
 * which channels and category-specific notices for compliance and
 * outreach planning. Task #1106 also called for the new
 * `notifySideGameReceipts` flag to appear in the export.
 *
 * Covers:
 *   - 401 anonymous, 403 non-admin / wrong-org admin
 *   - 200 org_admin gets a CSV with the right Content-Type and filename
 *   - Header includes every per-channel and per-category column the task
 *     mandates (preferEmail/Push/Sms/Whatsapp + notifySideGameReceipts +
 *     the rest of the per-category flags + digestMode)
 *   - A member with custom prefs renders their actual values; a member
 *     with no row renders the schema defaults so the CSV always covers
 *     every member
 *   - Members of other orgs do not leak into this org's export
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let otherOrgId: number;
let adminUserId: number;
let otherOrgAdminUserId: number;
let nonAdminUserId: number;
let memberWithPrefsUserId: number;
let memberDefaultPrefsUserId: number;
let otherOrgMemberUserId: number;

let admin: TestUser;
let nonAdmin: TestUser;
let appAsAdmin: ReturnType<typeof createTestApp>;
let appAsNonAdmin: ReturnType<typeof createTestApp>;
let appAsOtherOrgAdmin: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

async function makeUser(suffix: string, displayName: string) {
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `notif-csv-${suffix}-${stamp}`,
    username: `notif_csv_${suffix}_${stamp}`,
    email: `notif_csv_${suffix}_${stamp}@example.com`,
    displayName,
    role: "player",
  }).returning({ id: appUsersTable.id });
  return u.id;
}

beforeAll(async () => {
  // Task #1449 — defensively ensure the new push-side opt-out column exists
  // before INSERT/SELECT touches the table. Mirrors the pattern in
  // `erasure-storage-failures-digest-opt-out.test.ts` so this CSV test does
  // not depend on the test runner having already applied the numbered
  // migration `0119_erasure_storage_digest_push_optout.sql`.
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_erasure_storage_digest_push boolean NOT NULL DEFAULT true`);
  // Task #1724 — same defensive pattern for the new per-event admin
  // payout re-verify opt-out column. The CSV export touches this field
  // for every member row, so missing it would surface as a SELECT failure
  // long before any column-index assertion runs.
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_admin_payout_reverify boolean NOT NULL DEFAULT true`);

  const [org] = await db.insert(organizationsTable).values({
    name: `NotifPrefsCsv_${stamp}`,
    slug: `notif-prefs-csv-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `NotifPrefsCsvOther_${stamp}`,
    slug: `notif-prefs-csv-other-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  adminUserId = await makeUser("admin", "Notif Admin");
  otherOrgAdminUserId = await makeUser("otheradmin", "Other Org Admin");
  nonAdminUserId = await makeUser("nonadmin", "Notif NonAdmin");
  memberWithPrefsUserId = await makeUser("custom", "Custom Prefs");
  memberDefaultPrefsUserId = await makeUser("default", "Default Prefs");
  otherOrgMemberUserId = await makeUser("other", "Other Org Member");

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: adminUserId, role: "org_admin" },
    { organizationId: orgId, userId: nonAdminUserId, role: "player" },
    { organizationId: orgId, userId: memberWithPrefsUserId, role: "player" },
    { organizationId: orgId, userId: memberDefaultPrefsUserId, role: "player" },
    { organizationId: otherOrgId, userId: otherOrgAdminUserId, role: "org_admin" },
    { organizationId: otherOrgId, userId: otherOrgMemberUserId, role: "player" },
  ]);

  // Custom prefs: opt out of side-game receipts + flip a couple of
  // channels so we can verify per-row values appear correctly.
  await db.insert(userNotificationPrefsTable).values({
    userId: memberWithPrefsUserId,
    preferEmail: true,
    preferPush: false,
    preferSms: true,
    preferWhatsapp: true,
    notifyMemberDocuments: true,
    notifyCommitteePeerDigest: false,
    notifySideGameReceipts: false,
    notifyManualEntryAlerts: true,
    notifyCoachPayoutAccountChanges: true,
    // Task #1724 — keep the new admin re-verify per-event opt-out true
    // on the custom-prefs row so we can assert it round-trips into the
    // CSV at its dedicated column (default-on for everyone else).
    notifyAdminPayoutReverify: true,
    notifyDataExportExpiring: false,
    notifyErasureStorageDigest: true,
    // Task #1449 — push-side opt-out is independent of the email column
    // above; flip it false on the custom-prefs row so the assertions below
    // can verify it round-trips into the CSV separately.
    notifyErasureStorageDigestPush: false,
    digestMode: true,
  });

  admin = { id: adminUserId, username: `notif_csv_admin_${stamp}`, role: "org_admin", organizationId: orgId };
  nonAdmin = { id: nonAdminUserId, username: `notif_csv_nonadmin_${stamp}`, role: "player", organizationId: orgId };
  const otherAdmin: TestUser = {
    id: otherOrgAdminUserId,
    username: `notif_csv_otheradmin_${stamp}`,
    role: "org_admin",
    organizationId: otherOrgId,
  };
  appAsAdmin = createTestApp(admin);
  appAsNonAdmin = createTestApp(nonAdmin);
  appAsOtherOrgAdmin = createTestApp(otherAdmin);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  const userIds = [
    adminUserId, otherOrgAdminUserId, nonAdminUserId, memberWithPrefsUserId,
    memberDefaultPrefsUserId, otherOrgMemberUserId,
  ].filter(Boolean);
  if (userIds.length) {
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, userIds));
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, userIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

describe("GET /organizations/:orgId/members/notification-prefs.csv", () => {
  it("requires authentication", async () => {
    const res = await request(appAnonymous)
      .get(`/api/organizations/${orgId}/members/notification-prefs.csv`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin caller in the same org", async () => {
    const res = await request(appAsNonAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs.csv`);
    expect(res.status).toBe(403);
  });

  it("returns 403 for an admin of a different org", async () => {
    const res = await request(appAsOtherOrgAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs.csv`);
    expect(res.status).toBe(403);
  });

  it("returns CSV with the correct content-type and filename", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs.csv`);
    expect(res.status, res.text).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toContain(`member-notification-prefs-org-${orgId}.csv`);
  });

  it("includes every per-channel and per-category column in the header", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs.csv`);
    expect(res.status).toBe(200);
    const [headerLine] = res.text.split("\n");
    // Per-channel columns
    expect(headerLine).toContain("Prefer Email");
    expect(headerLine).toContain("Prefer Push");
    expect(headerLine).toContain("Prefer SMS");
    expect(headerLine).toContain("Prefer WhatsApp");
    // Category flags — the task explicitly calls out side-game receipts
    expect(headerLine).toContain("Notify Side Game Receipts");
    expect(headerLine).toContain("Notify Member Documents");
    expect(headerLine).toContain("Notify Committee Peer Digest");
    expect(headerLine).toContain("Notify Manual Entry Alerts");
    expect(headerLine).toContain("Notify Coach Payout Account Changes");
    expect(headerLine).toContain("Notify Data Export Expiring");
    // Task #1449 — split into two columns: email-side keeps its original
    // semantics, push-side joins it as a sibling so admins can see who
    // muted each channel independently.
    expect(headerLine).toContain("Notify Erasure Storage Digest (Email)");
    expect(headerLine).toContain("Notify Erasure Storage Digest (Push)");
    expect(headerLine).toContain("Digest Mode");
    expect(headerLine).toContain("Has Custom Prefs");
  });

  it("renders custom prefs verbatim and falls back to schema defaults for members without a row", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs.csv`);
    expect(res.status).toBe(200);
    const lines = res.text.split("\n");
    const customLine = lines.find(l => l.includes(`"${memberWithPrefsUserId}"`));
    const defaultLine = lines.find(l => l.includes(`"${memberDefaultPrefsUserId}"`));
    expect(customLine, "custom-prefs row missing").toBeDefined();
    expect(defaultLine, "default-prefs row missing").toBeDefined();

    // The custom member opted out of side-game receipts and digest peer + data-export reminder.
    const customCells = customLine!.split('","').map(c => c.replace(/^"|"$/g, ""));
    // Task #1724 — column layout (new "Notify Admin Payout Re-verify"
    // column wedged between Coach Payout and Data Export, semantically
    // grouped with the other coach-payout signal). Every index from 14
    // onward shifts by +1 vs the previous Task #1449 layout:
    //   0=UserID, 1=Username, 2=DisplayName, 3=Email, 4=Role,
    //   5=Email,6=Push,7=SMS,8=WhatsApp,
    //   9=MemberDocs,10=CommitteePeer,11=SideGameReceipts,12=ManualEntry,
    //   13=CoachPayout,14=AdminPayoutReverify,15=DataExportExpiring,
    //   16=ErasureStorageEmail,17=ErasureStoragePush,
    //   18=DigestMode,19=HasCustomPrefs,20=UpdatedAt
    expect(customCells[5]).toBe("yes"); // preferEmail
    expect(customCells[6]).toBe("no");  // preferPush
    expect(customCells[7]).toBe("yes"); // preferSms
    expect(customCells[8]).toBe("yes"); // preferWhatsapp
    expect(customCells[10]).toBe("no"); // notifyCommitteePeerDigest
    expect(customCells[11]).toBe("no"); // notifySideGameReceipts (key flag from #1106)
    expect(customCells[13]).toBe("yes"); // notifyCoachPayoutAccountChanges
    expect(customCells[14]).toBe("yes"); // notifyAdminPayoutReverify (Task #1724, default-on)
    expect(customCells[15]).toBe("no"); // notifyDataExportExpiring
    expect(customCells[16]).toBe("yes"); // notifyErasureStorageDigest (email side, kept on)
    expect(customCells[17]).toBe("no");  // notifyErasureStorageDigestPush (push side, opted out)
    expect(customCells[18]).toBe("yes"); // digestMode
    expect(customCells[19]).toBe("yes"); // Has Custom Prefs

    // The default-prefs member has no row, so the schema defaults apply.
    const defaultCells = defaultLine!.split('","').map(c => c.replace(/^"|"$/g, ""));
    expect(defaultCells[5]).toBe("yes"); // preferEmail default
    expect(defaultCells[6]).toBe("yes"); // preferPush default
    expect(defaultCells[7]).toBe("no");  // preferSms default
    expect(defaultCells[8]).toBe("no");  // preferWhatsapp default
    expect(defaultCells[11]).toBe("yes"); // notifySideGameReceipts default
    expect(defaultCells[14]).toBe("yes"); // notifyAdminPayoutReverify default (Task #1724)
    expect(defaultCells[16]).toBe("yes"); // notifyErasureStorageDigest default
    expect(defaultCells[17]).toBe("yes"); // notifyErasureStorageDigestPush default
    expect(defaultCells[18]).toBe("no"); // digestMode default
    expect(defaultCells[19]).toBe("no"); // Has Custom Prefs
  });

  it("does not leak members of other organizations", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs.csv`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(`"${otherOrgMemberUserId}"`);
  });
});
