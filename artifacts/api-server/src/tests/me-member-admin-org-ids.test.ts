/**
 * Integration test: Task #2210 — `memberAdminOrgIds` on `me` payloads.
 *
 * The mobile home screen's stuck-erasure backlog widget and the web
 * dashboard's StuckErasure / Privacy / ExpiringReminderStats /
 * StalledExpiringReminder widgets used to be hard-gated to global
 * `org_admin` / `super_admin` (web) or rely on a 401/403 self-hide
 * (mobile). That silently excluded treasurers and membership secretaries
 * whose elevated role lives in `org_memberships`, even though the
 * server's `requireMemberAdmin` already authorises them.
 *
 * Both `/auth/me` (web) and `/portal/me` (mobile) now surface
 * `memberAdminOrgIds: number[]` so the shared
 * `@workspace/member-admin-roles` `isMemberAdmin` helper opens those
 * widgets to every role the server already accepts. This test pins the
 * contract so a future regression — dropping the field, breaking the
 * role allow-list, or accidentally loosening it to plain players — fails
 * here loudly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  orgRoleEnum,
} from "@workspace/db";
import { inArray } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `MemberAdminMe_${tag}`,
    slug: `member-admin-me-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

/**
 * Creates an `app_users` row + (optionally) an `org_memberships` row in
 * the given org. `globalRole` lives on `app_users.role`; `membershipRole`
 * lives on `org_memberships.role` and is the membership-derived role
 * `requireMemberAdmin` consults.
 *
 * Mirrors the row shapes used by the existing
 * `bounced-digest-prefs-api.test.ts` so our seeding stays consistent
 * with how member-admin behaviour is already tested.
 */
async function makeUserWithMembership(opts: {
  orgId: number;
  globalRole: OrgRole;
  membershipRole?: OrgRole | null;
  /** When the global role is org_admin, set the user's org so the
   *  global-role branch in `requireMemberAdmin` can match. */
  setGlobalOrg?: boolean;
}): Promise<TestUser & { replitUserId: string }> {
  const tag = uid(opts.membershipRole ?? opts.globalRole);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: opts.membershipRole ?? opts.globalRole,
    role: opts.globalRole,
    organizationId: opts.setGlobalOrg ? opts.orgId : null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);

  if (opts.membershipRole) {
    await db.insert(orgMembershipsTable).values({
      organizationId: opts.orgId, userId: u.id, role: opts.membershipRole,
    });
  }

  return {
    id: u.id,
    username: tag,
    displayName: opts.membershipRole ?? opts.globalRole,
    role: opts.globalRole,
    organizationId: opts.setGlobalOrg ? opts.orgId : undefined,
    replitUserId: tag,
  };
}

afterAll(async () => {
  if (createdUserIds.length) {
    await db
      .delete(orgMembershipsTable)
      .where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db
      .delete(appUsersTable)
      .where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db
      .delete(organizationsTable)
      .where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("GET /api/portal/me — memberAdminOrgIds (Task #2210)", () => {
  it("returns the org id for a treasurer with an org_memberships row", async () => {
    const orgId = await makeOrg("portal_treasurer");
    const treasurer = await makeUserWithMembership({
      orgId,
      globalRole: "player",
      membershipRole: "treasurer",
    });
    const app = createTestApp(treasurer);

    const res = await request(app).get("/api/portal/me");
    expect(res.status, res.text).toBe(200);
    expect(res.body.memberAdminOrgIds).toEqual([orgId]);
  });

  it("returns the org id for a membership_secretary", async () => {
    const orgId = await makeOrg("portal_membership_secretary");
    const ms = await makeUserWithMembership({
      orgId,
      globalRole: "player",
      membershipRole: "membership_secretary",
    });
    const app = createTestApp(ms);

    const res = await request(app).get("/api/portal/me");
    expect(res.status, res.text).toBe(200);
    expect(res.body.memberAdminOrgIds).toEqual([orgId]);
  });

  it("returns an empty array for a plain player with no membership-admin role", async () => {
    const orgId = await makeOrg("portal_plain_player");
    const player = await makeUserWithMembership({
      orgId,
      globalRole: "player",
      membershipRole: null,
    });
    const app = createTestApp(player);

    const res = await request(app).get("/api/portal/me");
    expect(res.status, res.text).toBe(200);
    expect(res.body.memberAdminOrgIds).toEqual([]);
  });

  it("does not list orgs where the user only holds tournament_director (excluded from member-360 scope)", async () => {
    const orgId = await makeOrg("portal_td");
    const td = await makeUserWithMembership({
      orgId,
      globalRole: "player",
      membershipRole: "tournament_director",
    });
    const app = createTestApp(td);

    const res = await request(app).get("/api/portal/me");
    expect(res.status, res.text).toBe(200);
    // tournament_director is intentionally NOT in
    // MEMBER_ADMIN_MEMBERSHIP_ROLES — `requireMemberAdmin`'s comment
    // calls this out explicitly because member-360 surfaces handle PII.
    expect(res.body.memberAdminOrgIds).toEqual([]);
  });

  it("lists every org where the user is a member-admin (sorted, de-duped)", async () => {
    const orgA = await makeOrg("portal_multi_a");
    const orgB = await makeOrg("portal_multi_b");
    const u = await makeUserWithMembership({
      orgId: orgA,
      globalRole: "player",
      membershipRole: "treasurer",
    });
    // Add a second org membership for the same user.
    await db.insert(orgMembershipsTable).values({
      organizationId: orgB, userId: u.id, role: "membership_secretary",
    });
    const app = createTestApp(u);

    const res = await request(app).get("/api/portal/me");
    expect(res.status, res.text).toBe(200);
    expect(res.body.memberAdminOrgIds).toEqual([orgA, orgB].sort((a, b) => a - b));
  });
});

describe("GET /api/auth/me — memberAdminOrgIds (Task #2210)", () => {
  it("returns the org id for a treasurer", async () => {
    const orgId = await makeOrg("auth_treasurer");
    const treasurer = await makeUserWithMembership({
      orgId,
      globalRole: "player",
      membershipRole: "treasurer",
    });
    const app = createTestApp(treasurer);

    const res = await request(app).get("/api/auth/me");
    expect(res.status, res.text).toBe(200);
    expect(res.body.memberAdminOrgIds).toEqual([orgId]);
  });

  it("returns the org id for a membership_secretary", async () => {
    const orgId = await makeOrg("auth_membership_secretary");
    const ms = await makeUserWithMembership({
      orgId,
      globalRole: "player",
      membershipRole: "membership_secretary",
    });
    const app = createTestApp(ms);

    const res = await request(app).get("/api/auth/me");
    expect(res.status, res.text).toBe(200);
    expect(res.body.memberAdminOrgIds).toEqual([orgId]);
  });

  it("returns an empty array for a player with no membership-admin role", async () => {
    const orgId = await makeOrg("auth_plain_player");
    const player = await makeUserWithMembership({
      orgId,
      globalRole: "player",
      membershipRole: null,
    });
    const app = createTestApp(player);

    const res = await request(app).get("/api/auth/me");
    expect(res.status, res.text).toBe(200);
    expect(res.body.memberAdminOrgIds).toEqual([]);
  });
});
