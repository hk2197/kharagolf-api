/**
 * Unit test: shared canonical `isMemberAdmin` helper (Task #2210).
 *
 * Pins the exact role allow-list the API server's `requireMemberAdmin`
 * already enforces so a regression in either place — the helper or the
 * server — surfaces here instead of on a controller's home screen.
 */
import { describe, it, expect } from "vitest";
import {
  MEMBER_ADMIN_GLOBAL_ROLES,
  MEMBER_ADMIN_MEMBERSHIP_ROLES,
  isMemberAdmin,
} from "../src/index";

describe("MEMBER_ADMIN_GLOBAL_ROLES", () => {
  it("contains exactly the roles `requireMemberAdmin` treats as global admins", () => {
    expect([...MEMBER_ADMIN_GLOBAL_ROLES].sort()).toEqual(
      ["org_admin", "super_admin"].sort(),
    );
  });
});

describe("MEMBER_ADMIN_MEMBERSHIP_ROLES", () => {
  it("matches the server's per-club membership allow-list", () => {
    expect([...MEMBER_ADMIN_MEMBERSHIP_ROLES].sort()).toEqual(
      ["membership_secretary", "org_admin", "treasurer"].sort(),
    );
  });
});

describe("isMemberAdmin", () => {
  it("returns false when the user is missing", () => {
    expect(isMemberAdmin(null, 1)).toBe(false);
    expect(isMemberAdmin(undefined, 1)).toBe(false);
  });

  it("returns false when the orgId is missing or non-finite", () => {
    expect(isMemberAdmin({ role: "super_admin" }, null)).toBe(false);
    expect(isMemberAdmin({ role: "super_admin" }, undefined)).toBe(false);
    expect(isMemberAdmin({ role: "super_admin" }, NaN)).toBe(false);
  });

  it("grants access to super_admin in any org, regardless of organizationId", () => {
    expect(
      isMemberAdmin({ role: "super_admin", organizationId: 99 }, 1),
    ).toBe(true);
    // No organizationId on the user — super_admin still works.
    expect(isMemberAdmin({ role: "super_admin" }, 42)).toBe(true);
  });

  it("grants access to org_admin only in their own organization", () => {
    expect(
      isMemberAdmin({ role: "org_admin", organizationId: 7 }, 7),
    ).toBe(true);
    // Wrong org → blocked. Mirrors `requireMemberAdmin`'s
    // `user.organizationId === orgId` check.
    expect(
      isMemberAdmin({ role: "org_admin", organizationId: 7 }, 8),
    ).toBe(false);
    // org_admin without organizationId → no implicit access.
    expect(isMemberAdmin({ role: "org_admin" }, 8)).toBe(false);
  });

  it("grants access to treasurer / membership_secretary via memberAdminOrgIds", () => {
    expect(
      isMemberAdmin(
        {
          role: "player",
          organizationId: 7,
          memberAdminOrgIds: [7, 9],
        },
        7,
      ),
    ).toBe(true);
    expect(
      isMemberAdmin(
        {
          role: "player",
          organizationId: 7,
          memberAdminOrgIds: [7, 9],
        },
        9,
      ),
    ).toBe(true);
    expect(
      isMemberAdmin(
        {
          role: "player",
          organizationId: 7,
          memberAdminOrgIds: [7, 9],
        },
        10,
      ),
    ).toBe(false);
  });

  it("returns false for plain players with no global or membership-derived role", () => {
    expect(
      isMemberAdmin(
        { role: "player", organizationId: 7, memberAdminOrgIds: [] },
        7,
      ),
    ).toBe(false);
    expect(
      isMemberAdmin({ role: "player", organizationId: 7 }, 7),
    ).toBe(false);
  });

  it("does not blow up when memberAdminOrgIds is null or undefined", () => {
    expect(
      isMemberAdmin(
        { role: "player", organizationId: 7, memberAdminOrgIds: null },
        7,
      ),
    ).toBe(false);
    expect(
      isMemberAdmin({ role: "player", organizationId: 7 }, 7),
    ).toBe(false);
  });
});
