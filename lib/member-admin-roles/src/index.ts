/**
 * Canonical "is this user authorised for member-360 controller actions?"
 * helper, shared across the API server, web dashboard, and Expo mobile
 * home screen (Task #2210).
 *
 * Background — the server-side authoriser in
 * `artifacts/api-server/src/routes/member-360.ts` (`requireMemberAdmin`)
 * grants access to:
 *   - global super_admin                                  (any org)
 *   - global org_admin whose `app_users.organization_id` matches the
 *     URL's org id                                        (their own org)
 *   - any user with an `org_memberships` row in that org whose
 *     `role` is one of: org_admin / membership_secretary / treasurer
 *
 * The mobile home widget previously had no client-side role gate at all
 * and relied on a 401/403 from the server to self-hide — wasteful, and
 * the web counterpart hard-coded `['org_admin', 'super_admin']` which
 * silently excluded treasurers and membership secretaries who only carry
 * their elevated permissions via `org_memberships`. Both surfaces now
 * import this single helper so a future change to the role allow-list
 * (e.g. adding `competition_secretary`) is a one-line edit instead of a
 * three-file copy/paste hunt.
 */

/**
 * Roles on `app_users.role` that grant member-admin access regardless of
 * any per-org membership row. `super_admin` cuts across orgs;
 * `org_admin` is scoped to the user's own `app_users.organization_id`.
 */
export const MEMBER_ADMIN_GLOBAL_ROLES = ["super_admin", "org_admin"] as const;
export type MemberAdminGlobalRole = (typeof MEMBER_ADMIN_GLOBAL_ROLES)[number];

/**
 * Roles on `org_memberships.role` that grant member-admin access for
 * the matching `org_memberships.organization_id`. This is the set the
 * server's `requireMemberAdmin` consults via the per-club membership
 * lookup, so keeping the constant here lets the server import it
 * directly instead of redeclaring the same allow-list inline.
 */
export const MEMBER_ADMIN_MEMBERSHIP_ROLES = [
  "org_admin",
  "membership_secretary",
  "treasurer",
] as const;
export type MemberAdminMembershipRole =
  (typeof MEMBER_ADMIN_MEMBERSHIP_ROLES)[number];

/**
 * Minimum shape of the `me` payload required to evaluate
 * `isMemberAdmin`. Both web (`/api/auth/me` → `AuthUser`) and mobile
 * (`/api/portal/me` → `PlayerUser`) extend their existing user
 * interfaces with the optional `memberAdminOrgIds` field so the same
 * helper works on both surfaces.
 *
 * `memberAdminOrgIds` lists every org id where the user has a
 * membership-derived admin role (the server pre-computes it on `me` so
 * the client doesn't have to issue a separate "what are my memberships?"
 * call just to render a badge). It's optional so older mobile builds —
 * which may still have a cached `me` payload from a server version that
 * pre-dates this field — don't get a TypeScript error.
 */
export interface MemberAdminUser {
  role?: string | null;
  organizationId?: number | null;
  memberAdminOrgIds?: readonly number[] | null;
}

/**
 * Returns true iff the given user is authorised for member-360
 * controller actions (stuck-erasure cleanup, privacy-request triage,
 * stalled export reminders, etc.) in the given org.
 *
 * Mirrors the API server's `requireMemberAdmin` exactly so the client
 * gate never opens something the server won't, and never hides
 * something the server would have allowed.
 *
 * Returns false when either argument is missing so callers can skip
 * defensive null checks at the call site.
 */
export function isMemberAdmin(
  user: MemberAdminUser | null | undefined,
  orgId: number | null | undefined,
): boolean {
  if (!user || orgId == null || !Number.isFinite(orgId)) return false;

  const role = user.role ?? "";

  // super_admin is global — it works for any orgId.
  if (role === "super_admin") return true;

  // org_admin on app_users.role is only scoped to the user's own org.
  // A super-admin who's been demoted to org_admin in their own org
  // shouldn't suddenly be able to admin a different org via a stale
  // `me` payload, so this branch checks `organizationId` explicitly.
  if (
    role === "org_admin" &&
    user.organizationId != null &&
    user.organizationId === orgId
  ) {
    return true;
  }

  // Membership-derived roles (org_admin / membership_secretary /
  // treasurer in `org_memberships`). The server pre-computes the list
  // of authorising orgIds on `me` so we just check membership.
  if (Array.isArray(user.memberAdminOrgIds)) {
    return user.memberAdminOrgIds.includes(orgId);
  }
  return false;
}
