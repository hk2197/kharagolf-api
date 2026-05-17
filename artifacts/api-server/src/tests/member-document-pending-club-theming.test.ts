/**
 * Regression test for Task #2194 — the staff "new member document
 * awaiting review" notification email (`routes/portal.ts` ~line 10241,
 * via `lib/documentPendingStaffNotify.ts`) must honour the saved
 * `club_theming` row over the legacy `organizations.logo_url` column.
 *
 * Background: Task #1758 routed this notification's branding through
 * `resolveOrgBranding(orgId, org)` so the staff email carries the same
 * logo the admin most recently picked in the club-theming UI. This test
 * mocks the mailer + push transport and asserts the `logoUrl` field
 * passed into `sendBroadcastEmail` is the club_theming row's value, not
 * the legacy column.
 *
 * Mirrors `document-pending-notify-i18n.test.ts` (Task #1909) and
 * `broadcast-overlay-club-theming.test.ts` (Task #1758).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", async () => ({
  sendTransactionalPush: vi.fn(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  })),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  clubThemingTable,
  clubMembersTable,
  appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { notifyDocumentPendingStaff } from "../lib/documentPendingStaffNotify.js";
import { sendBroadcastEmail } from "../lib/mailer.js";
import { invalidateClubThemeCache } from "../lib/clubTheming.js";

const emailMock = vi.mocked(sendBroadcastEmail);

const LEGACY_LOGO = "https://example.com/memberdoc-legacy-logo.png";
const THEMED_LOGO = "https://example.com/memberdoc-club-theming-logo.png";

let testOrgId: number;
let testMemberId: number;
let staffUserId: number;
let staffMembershipId: number;

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_MemberDocCT_${suffix}`,
    slug: `test-member-doc-ct-${suffix}`,
    logoUrl: LEGACY_LOGO,
    primaryColor: "#aaaaaa",
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  await db.insert(clubThemingTable).values({
    organizationId: testOrgId,
    primaryColor: "#bada55",
    accentColor: "#112233",
    fontFamily: "Outfit",
    logoUrl: THEMED_LOGO,
    faviconUrl: null,
  });
  invalidateClubThemeCache(testOrgId);

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Asha",
    lastName: "Singh",
  }).returning({ id: clubMembersTable.id });
  testMemberId = m.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `memberdoc-ct-staff-${suffix}`,
    username: `memberdoc_ct_staff_${suffix}`,
    email: `staff_${suffix}@example.com`,
    displayName: "Staff Reviewer",
  }).returning({ id: appUsersTable.id });
  staffUserId = u.id;

  const [mem] = await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: staffUserId,
    role: "org_admin",
  }).returning({ id: orgMembershipsTable.id });
  staffMembershipId = mem.id;
});

afterAll(async () => {
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.id, staffMembershipId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, staffUserId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, testMemberId));
  await db.delete(clubThemingTable).where(eq(clubThemingTable.organizationId, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  emailMock.mockClear();
  emailMock.mockResolvedValue(undefined);
});

describe("Task #2194 — staff 'document awaiting review' email branding honours club_theming over legacy organizations.logo_url", () => {
  it("passes the saved club_theming logo URL to sendBroadcastEmail", async () => {
    const res = await notifyDocumentPendingStaff({
      organizationId: testOrgId,
      clubMemberId: testMemberId,
      documentId: 9001,
      documentType: "id_proof",
      title: "Driving License",
    });

    expect(res.recipients).toBe(1);
    expect(res.emailsSent).toBe(1);
    expect(res.emailsFailed).toBe(0);

    expect(emailMock).toHaveBeenCalledTimes(1);
    const opts = emailMock.mock.calls[0][5];
    expect(opts?.logoUrl).toBe(THEMED_LOGO);
    // Defensive: the legacy column must NOT win when a club_theming row
    // exists, otherwise admins who customised via the club-theming UI see
    // the old logo on every staff notification email again.
    expect(opts?.logoUrl).not.toBe(LEGACY_LOGO);
    expect(opts?.orgId).toBe(testOrgId);
  });
});
