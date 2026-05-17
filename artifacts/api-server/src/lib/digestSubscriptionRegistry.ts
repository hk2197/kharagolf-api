/**
 * Task #1832 — Shared "controller-facing email digest" subscription
 * registry.
 *
 * Each controller-facing digest (bounced-levy reminders schedule
 * change, stuck-erasure-cleanup, monthly member-prefs digest, …)
 * historically owned its own pair of public unsubscribe / re-subscribe
 * routes in `routes/public.ts` plus a bespoke storage layout (a flag on
 * `user_notification_prefs`, or a per-(user, org) opt-out table). The
 * pattern works but every new digest doubles the surface area of
 * `public.ts` and the unsubscribe-link UX has been silently drifting
 * between digests.
 *
 * This registry centralises everything that varies per digest behind a
 * uniform interface so:
 *   - The three near-identical handler pairs in `public.ts` collapse to
 *     a single `mountPublicDigestRoutes(router)` call, and a new digest
 *     adds itself by appending one entry below — no new bespoke routes.
 *   - The same registry powers the new in-portal "Email digests"
 *     section (`GET / PATCH /api/portal/digest-preferences`), so a
 *     controller can see and toggle every user-level digest opt-out
 *     they're eligible for in one place.
 *   - The token signer / verifier stays per-digest (each entry plugs
 *     in its own `verifyToken`), so a leaked link can still only opt
 *     out of the specific digest it was minted for.
 *
 * The persistence shape varies (`UserPrefStorage` for a flag column,
 * `OrgScopedTableStorage` for a per-(user, org) opt-outs table) so the
 * helper just delegates to the storage object on the entry — adding a
 * new persistence shape (e.g. multi-org opt-out matrix) only requires a
 * new `DigestStorage` implementation, not a fork of every handler.
 */
import type { IRouter, Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  appUsersTable,
  userNotificationPrefsTable,
  organizationsTable,
  orgMembershipsTable,
  bouncedDigestScheduleOptOutsTable,
} from "@workspace/db";

import {
  signBouncedDigestScheduleOptOutToken,
  verifyBouncedDigestScheduleOptOutToken,
  signErasureStorageDigestOptOutToken,
  verifyErasureStorageDigestOptOutToken,
  signMemberPrefsDigestOptOutToken,
  verifyMemberPrefsDigestOptOutToken,
} from "./bouncedDigestUnsubscribe";
import { recordMemberAudit } from "./auditMember";

// ---------------------------------------------------------------------------
// Storage adapters — abstract over "where does this digest's opt-out flag live?"
// ---------------------------------------------------------------------------

/** Verified-token shape: every digest's verifier returns this on success. */
export interface DigestTokenPayload {
  userId: number;
  orgId: number;
}

/**
 * Common contract for persisting a digest opt-out. Each digest plugs in
 * a `DigestStorage` so the route handler can flip it without knowing
 * whether the underlying row lives on `user_notification_prefs` or in a
 * per-(user, org) opt-outs table.
 *
 * The `optedIn` boolean is intentionally written from the user's
 * perspective ("am I subscribed?") even though some storages persist it
 * inverted (an opt-outs table holds rows for users who are OPTED OUT).
 * `getOptedIn` / `setOptedIn` translate between the two so the calling
 * code (route handler, portal endpoint) can stay uniform.
 */
export interface DigestStorage {
  /** Read the current opt-in state for a (user, org) pair. */
  getOptedIn(userId: number, orgId: number): Promise<boolean>;
  /**
   * Set the opt-in state. Returns the previous value so callers can
   * record a precise from→to in the audit trail.
   */
  setOptedIn(userId: number, orgId: number, optedIn: boolean): Promise<{ previousOptedIn: boolean }>;
  /**
   * Whether this storage supports "show me this user's single global
   * toggle". User-level storages (a flag on `user_notification_prefs`)
   * answer true; per-(user, org) storages (an opt-outs table) answer
   * false because a global toggle would be ambiguous when the user
   * controls multiple clubs. The portal "Email digests" section only
   * lists digests whose storage is `userScopedForPortal === true`.
   */
  userScopedForPortal: boolean;
  /**
   * For `userScopedForPortal === true` storages: read the user-level
   * flag without an org. Throws if the storage isn't user-scoped.
   */
  getOptedInForUser?(userId: number): Promise<boolean>;
  /** Same idea for writes — only defined when `userScopedForPortal`. */
  setOptedInForUser?(userId: number, optedIn: boolean): Promise<{ previousOptedIn: boolean }>;
}

/**
 * Storage adapter for digests whose opt-in lives as a boolean column
 * on `user_notification_prefs` (e.g. `notifyErasureStorageDigest`,
 * `notifyMemberPrefsDigest`). The schema default is true so a missing
 * prefs row reads as "opted in".
 */
export function userPrefStorage(
  column:
    | typeof userNotificationPrefsTable.notifyErasureStorageDigest
    | typeof userNotificationPrefsTable.notifyMemberPrefsDigest,
  columnName:
    | "notifyErasureStorageDigest"
    | "notifyMemberPrefsDigest",
): DigestStorage {
  async function readPrev(userId: number): Promise<boolean> {
    const [row] = await db
      .select({ flag: column })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId));
    return row?.flag ?? true;
  }
  async function write(userId: number, value: boolean): Promise<{ previousOptedIn: boolean }> {
    const previousOptedIn = await readPrev(userId);
    const insertValues: Record<string, unknown> = { userId };
    insertValues[columnName] = value;
    const updateSet: Record<string, unknown> = { updatedAt: new Date() };
    updateSet[columnName] = value;
    await db.insert(userNotificationPrefsTable).values(insertValues as never).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: updateSet,
    });
    return { previousOptedIn };
  }
  return {
    userScopedForPortal: true,
    getOptedIn: (userId) => readPrev(userId),
    setOptedIn: (userId, _orgId, optedIn) => write(userId, optedIn),
    getOptedInForUser: (userId) => readPrev(userId),
    setOptedInForUser: (userId, optedIn) => write(userId, optedIn),
  };
}

/**
 * Storage adapter for the per-(user, org) opt-outs TABLE shape used by
 * the bounced-digest schedule-change emails. A row in the table means
 * "opted OUT for this (user, org)" — absence of a row means "still
 * subscribed". The portal listing is intentionally not surfaced here:
 * a single global toggle would be ambiguous for a controller who runs
 * multiple clubs (the existing `EMAIL_SUBSCRIPTION_TYPES` registry on
 * `routes/portal.ts` already exposes the per-org list as a separate UI).
 */
export function bouncedScheduleOptOutTableStorage(): DigestStorage {
  return {
    userScopedForPortal: false,
    async getOptedIn(userId, orgId) {
      const [row] = await db
        .select({ id: bouncedDigestScheduleOptOutsTable.userId })
        .from(bouncedDigestScheduleOptOutsTable)
        .where(and(
          eq(bouncedDigestScheduleOptOutsTable.userId, userId),
          eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId),
        ));
      // No row → still subscribed (opted in).
      return row == null;
    },
    async setOptedIn(userId, orgId, optedIn) {
      const [row] = await db
        .select({ id: bouncedDigestScheduleOptOutsTable.userId })
        .from(bouncedDigestScheduleOptOutsTable)
        .where(and(
          eq(bouncedDigestScheduleOptOutsTable.userId, userId),
          eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId),
        ));
      const previousOptedIn = row == null;
      if (optedIn) {
        await db.delete(bouncedDigestScheduleOptOutsTable).where(and(
          eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId),
          eq(bouncedDigestScheduleOptOutsTable.userId, userId),
        ));
      } else {
        await db.insert(bouncedDigestScheduleOptOutsTable).values({
          organizationId: orgId,
          userId,
        }).onConflictDoNothing();
      }
      return { previousOptedIn };
    },
  };
}

// ---------------------------------------------------------------------------
// Confirmation-page copy generators
// ---------------------------------------------------------------------------

interface ConfirmationCopy {
  /** HTML body for the success page after unsubscribing. `safeOrg` is already escaped. */
  unsubscribed(safeOrg: string, resubUrl: string): string;
  /** HTML body for the success page after re-subscribing. `safeOrg` is already escaped. */
  resubscribed(safeOrg: string): string;
  /** Body used when the token cannot be verified. */
  invalidUnsubscribe: string;
  invalidResubscribe: string;
  /** Body used when the org referenced in the token no longer exists. */
  orgGoneUnsubscribe?: string;
  orgGoneResubscribe?: string;
  /** Page <title>s. Same on both success and error pages. */
  pageTitle: { unsubscribed: string; resubscribed: string };
}

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

export interface DigestSubscription {
  /**
   * Stable identifier used by the in-portal `PATCH
   * /api/portal/digest-preferences/:id` and as the `metadata.kind`
   * field on member-audit-log rows. Keep snake_case so it reads
   * cleanly inside JSON metadata.
   */
  id: string;

  /**
   * Public route paths under `/api/public`. Kept as separate fields
   * (rather than a derived string) so the existing back-compat URLs —
   * which the email links already point at — stay byte-identical
   * after the refactor.
   */
  routes: {
    unsubscribePath: string;
    resubscribePath: string;
    /**
     * Whether the unsubscribe handler also accepts POST (RFC 8058
     * one-click List-Unsubscribe-Post=List-Unsubscribe=One-Click).
     * The bounced-digest schedule pair predates that handling and
     * stays GET-only to keep its existing test contract intact.
     */
    acceptOneClickPostOnUnsubscribe: boolean;
  };

  /** Per-digest token verification — see file header. */
  verifyToken(token: string): DigestTokenPayload | null;

  /** How and where the opt-in state is persisted. */
  storage: DigestStorage;

  /**
   * If non-null, the public-route handler writes a member-audit-log
   * row tagged with `metadata.kind = auditKind` whenever the org from
   * the token still exists. Set to null for digests that don't audit
   * (e.g. the bounced-digest schedule pair, which records its opt-out
   * in the per-org table itself).
   */
  auditKind: string | null;

  /** Confirmation-page copy. Strings are owned by each entry to avoid drift. */
  copy: ConfirmationCopy;

  /**
   * Portal-side metadata for the "Email digests" section. Optional
   * so per-(user, org) digests like the bounced-digest schedule pair
   * can opt out of the listing (their portal UX lives elsewhere).
   */
  portalListing?: {
    label: string;
    description: string;
  };
}

// ---------------------------------------------------------------------------
// The registry itself — adding a new digest is one entry below.
// ---------------------------------------------------------------------------

export const DIGEST_SUBSCRIPTIONS: DigestSubscription[] = [
  {
    id: "bounced_digest_schedule",
    routes: {
      unsubscribePath: "/bounced-digest-schedule-unsubscribe",
      resubscribePath: "/bounced-digest-schedule-resubscribe",
      acceptOneClickPostOnUnsubscribe: false,
    },
    verifyToken: verifyBouncedDigestScheduleOptOutToken,
    storage: bouncedScheduleOptOutTableStorage(),
    auditKind: null,
    copy: {
      pageTitle: { unsubscribed: "Unsubscribed", resubscribed: "Re-subscribed" },
      unsubscribed: (safeOrg, resubUrl) =>
        `<h1 class="ok">You're unsubscribed</h1>
    <p>You will no longer receive the "bounced-reminders digest schedule updated" notifications from <strong>${safeOrg}</strong>.</p>
    <p>The regular bounced-levy reminders digest itself will keep arriving as scheduled.</p>
    <p><a class="resub" href="${resubUrl}">Changed your mind? Re-subscribe</a></p>`,
      resubscribed: (safeOrg) =>
        `<h1 class="ok">You're re-subscribed</h1>
    <p>You'll receive the "bounced-reminders digest schedule updated" notifications from <strong>${safeOrg}</strong> again.</p>`,
      invalidUnsubscribe:
        `<h1>Invalid unsubscribe link</h1><p>This link is malformed or expired. If you keep getting unwanted schedule-change emails, ask your club admin to remove you from the recipient list.</p>`,
      invalidResubscribe:
        `<h1>Invalid re-subscribe link</h1><p>This link is malformed or expired. Ask your club admin to add you back to the recipient list.</p>`,
      orgGoneUnsubscribe:
        `<h1>Unknown organization</h1><p>The organization referenced by this link no longer exists.</p>`,
      orgGoneResubscribe:
        `<h1>Unknown organization</h1><p>The organization referenced by this link no longer exists.</p>`,
    },
    // Per-org digest, no portal listing — see comment on DigestStorage.
  },
  {
    id: "erasure_storage_digest",
    routes: {
      unsubscribePath: "/erasure-digest-unsubscribe",
      resubscribePath: "/erasure-digest-resubscribe",
      acceptOneClickPostOnUnsubscribe: true,
    },
    verifyToken: verifyErasureStorageDigestOptOutToken,
    storage: userPrefStorage(
      userNotificationPrefsTable.notifyErasureStorageDigest,
      "notifyErasureStorageDigest",
    ),
    auditKind: "erasure_storage_digest",
    copy: {
      pageTitle: { unsubscribed: "Unsubscribed", resubscribed: "Re-subscribed" },
      unsubscribed: (safeOrg, resubUrl) =>
        `<h1 class="ok">You're unsubscribed</h1>
    <p>You will no longer receive the "stuck erasure cleanup" daily digest from <strong>${safeOrg}</strong> (or any other club where you're a controller).</p>
    <p>Other org-admin emails, push notifications, and the in-app inbox are unaffected.</p>
    <p><a class="resub" href="${resubUrl}">Changed your mind? Re-subscribe</a></p>`,
      resubscribed: (safeOrg) =>
        `<h1 class="ok">You're re-subscribed</h1>
    <p>You'll receive the "stuck erasure cleanup" daily digest from <strong>${safeOrg}</strong> again whenever there's something to act on.</p>`,
      invalidUnsubscribe:
        `<h1>Invalid unsubscribe link</h1><p>This link is malformed or expired. You can also silence this digest from your KHARAGOLF notification preferences.</p>`,
      invalidResubscribe:
        `<h1>Invalid re-subscribe link</h1><p>This link is malformed or expired. You can manage your email preferences from your KHARAGOLF profile.</p>`,
    },
    // No `portalListing`: the stuck-erasure digest already has its own
    // rich row in `PortalCommPrefs.tsx` (Tasks #1449 + #1772 + #1774)
    // pairing the email toggle with a separate push toggle, a live
    // "which channels are silenced" status preview, a "both muted"
    // warning, and an unsubscribe-link audit-trail hint. Listing it
    // again under the new "Email digests" section would create two
    // controls on the same screen and inconsistent in-memory state
    // (the two sections would each maintain their own copy of the
    // opt-in flag and drift on every flip until reload). The shared
    // backend registry still owns the public-route handler, the token
    // signer, and the audit-row shape — only the in-portal listing is
    // suppressed.
  },
  {
    id: "member_prefs_digest",
    routes: {
      unsubscribePath: "/member-prefs-digest-unsubscribe",
      resubscribePath: "/member-prefs-digest-resubscribe",
      acceptOneClickPostOnUnsubscribe: true,
    },
    verifyToken: verifyMemberPrefsDigestOptOutToken,
    storage: userPrefStorage(
      userNotificationPrefsTable.notifyMemberPrefsDigest,
      "notifyMemberPrefsDigest",
    ),
    auditKind: "member_prefs_digest",
    copy: {
      pageTitle: { unsubscribed: "Unsubscribed", resubscribed: "Re-subscribed" },
      unsubscribed: (safeOrg, resubUrl) =>
        `<h1 class="ok">You're unsubscribed</h1>
    <p>You will no longer receive the monthly "member notification preferences" digest from <strong>${safeOrg}</strong> (or any other club where you're a controller).</p>
    <p>Other org-admin emails, push notifications, and the in-app inbox are unaffected.</p>
    <p><a class="resub" href="${resubUrl}">Changed your mind? Re-subscribe</a></p>`,
      resubscribed: (safeOrg) =>
        `<h1 class="ok">You're re-subscribed</h1>
    <p>You'll receive the monthly "member notification preferences" digest from <strong>${safeOrg}</strong> again at the start of each calendar month.</p>`,
      invalidUnsubscribe:
        `<h1>Invalid unsubscribe link</h1><p>This link is malformed or expired. You can also silence this digest from your KHARAGOLF notification preferences.</p>`,
      invalidResubscribe:
        `<h1>Invalid re-subscribe link</h1><p>This link is malformed or expired. You can manage your email preferences from your KHARAGOLF profile.</p>`,
    },
    portalListing: {
      label: "Monthly member-prefs digest",
      description:
        "Monthly CSV digest summarising every member's notification-preferences row. Sent to org admins, membership secretaries, and treasurers.",
    },
  },
];

/** Lookup helper used by both the public and portal routes. */
export function findDigestSubscription(id: string): DigestSubscription | null {
  return DIGEST_SUBSCRIPTIONS.find(d => d.id === id) ?? null;
}

/**
 * Sign helper — re-exposed so callers (cron, mailers) keep importing
 * tokens from one place. The signers themselves still live in
 * `bouncedDigestUnsubscribe.ts` so the per-digest secrecy boundary is
 * preserved.
 */
export const DIGEST_TOKEN_SIGNERS = {
  bounced_digest_schedule: signBouncedDigestScheduleOptOutToken,
  erasure_storage_digest: signErasureStorageDigestOptOutToken,
  member_prefs_digest: signMemberPrefsDigestOptOutToken,
} as const;

// ---------------------------------------------------------------------------
// Public-route mounting
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, c =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&#39;" }[c]!));
}

function htmlPage(res: Response, title: string, body: string, status = 200): void {
  res.status(status).type("html").send(`<!DOCTYPE html>
<html><head><title>${title}</title><style>
  body{font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .box{max-width:480px;text-align:center;padding:40px;}
  h1{font-size:22px;margin:0 0 12px;}
  p{color:#9ca3af;line-height:1.6;margin:0 0 8px;}
  .ok{color:#4ade80;}
  a.resub{display:inline-block;margin-top:16px;color:#60a5fa;text-decoration:underline;}
</style></head><body><div class="box">${body}</div></body></html>`);
}

function readToken(req: Request): string {
  const fromQuery = typeof req.query.token === "string" ? req.query.token : "";
  const fromBody = typeof (req.body as { token?: unknown } | undefined)?.token === "string"
    ? (req.body as { token: string }).token
    : "";
  return fromQuery || fromBody;
}

async function loadOrg(orgId: number): Promise<{ id: number; name: string | null } | null> {
  if (!orgId) return null;
  const [org] = await db
    .select({ id: organizationsTable.id, name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  return org ?? null;
}

async function maybeAuditPublicChange(
  digest: DigestSubscription,
  req: Request,
  parsed: DigestTokenPayload,
  previousFlag: boolean,
  newFlag: boolean,
  org: { id: number; name: string | null } | null,
  direction: "unsubscribe" | "resubscribe",
): Promise<void> {
  if (!digest.auditKind || !org) return;
  const change: Record<string, { from: boolean; to: boolean }> = {};
  // Mirror the original handlers' field name where the column is on
  // user_notification_prefs (so the audit log stays readable for the
  // existing Task #1454 / #1772 surfaces). For digests with no schema
  // column (none today) we'd fall back to a generic "optedIn" key.
  const colKey = digest.id === "erasure_storage_digest"
    ? "notifyErasureStorageDigest"
    : digest.id === "member_prefs_digest"
      ? "notifyMemberPrefsDigest"
      : "optedIn";
  change[colKey] = { from: previousFlag, to: newFlag };
  await recordMemberAudit({
    req,
    organizationId: parsed.orgId,
    clubMemberId: null,
    entity: "comm_prefs",
    entityId: parsed.userId,
    action: "update",
    changes: change,
    reason: direction === "unsubscribe"
      ? "Public unsubscribe link clicked"
      : "Public re-subscribe link clicked",
    metadata: {
      source: "public_unsubscribe_link",
      kind: digest.auditKind,
      direction,
      targetUserId: parsed.userId,
    },
  });
}

function makeUnsubscribeHandler(digest: DigestSubscription) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const token = readToken(req);
    const parsed = digest.verifyToken(token);
    if (!parsed) {
      htmlPage(res, "Invalid link", digest.copy.invalidUnsubscribe, 400);
      return;
    }
    const org = await loadOrg(parsed.orgId);
    // Per-org-table digests (bounced-digest schedule) require the org
    // to still exist before they can write to the opt-outs table (FK).
    // User-pref digests do NOT require it — the user-level opt-out
    // should succeed even if the org was deleted between the email
    // being sent and the controller clicking the link.
    if (digest.copy.orgGoneUnsubscribe && !org) {
      htmlPage(res, "Unknown organization", digest.copy.orgGoneUnsubscribe, 404);
      return;
    }
    const { previousOptedIn } = await digest.storage.setOptedIn(parsed.userId, parsed.orgId, false);
    await maybeAuditPublicChange(digest, req, parsed, previousOptedIn, false, org, "unsubscribe");
    const safeOrg = escapeHtml(String(org?.name ?? "your club"));
    const resubUrl = `/api/public${digest.routes.resubscribePath}?token=${encodeURIComponent(token)}`;
    htmlPage(res, digest.copy.pageTitle.unsubscribed, digest.copy.unsubscribed(safeOrg, resubUrl));
  };
}

function makeResubscribeHandler(digest: DigestSubscription) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const token = readToken(req);
    const parsed = digest.verifyToken(token);
    if (!parsed) {
      htmlPage(res, "Invalid link", digest.copy.invalidResubscribe, 400);
      return;
    }
    const org = await loadOrg(parsed.orgId);
    if (digest.copy.orgGoneResubscribe && !org) {
      htmlPage(res, "Unknown organization", digest.copy.orgGoneResubscribe, 404);
      return;
    }
    const { previousOptedIn } = await digest.storage.setOptedIn(parsed.userId, parsed.orgId, true);
    await maybeAuditPublicChange(digest, req, parsed, previousOptedIn, true, org, "resubscribe");
    const safeOrg = escapeHtml(String(org?.name ?? "your club"));
    htmlPage(res, digest.copy.pageTitle.resubscribed, digest.copy.resubscribed(safeOrg));
  };
}

/**
 * Mount one GET (and conditionally POST) unsubscribe + one GET
 * resubscribe route per registered digest. Call once from
 * `routes/public.ts`.
 */
export function mountPublicDigestRoutes(router: IRouter): void {
  for (const digest of DIGEST_SUBSCRIPTIONS) {
    const unsub = makeUnsubscribeHandler(digest);
    router.get(digest.routes.unsubscribePath, unsub);
    if (digest.routes.acceptOneClickPostOnUnsubscribe) {
      router.post(digest.routes.unsubscribePath, unsub);
    }
    router.get(digest.routes.resubscribePath, makeResubscribeHandler(digest));
  }
}

// ---------------------------------------------------------------------------
// Portal-facing helpers
// ---------------------------------------------------------------------------

export interface PortalDigestSubscriptionRow {
  id: string;
  label: string;
  description: string;
  optedIn: boolean;
}

/**
 * Returns true when `userId` would actually receive any
 * controller-facing digest the cron jobs send out today (the
 * `recipients = direct org_admin app_users + org_memberships in
 * (org_admin, membership_secretary, treasurer)` SQL the
 * stuck-erasure / member-prefs / bounced-digest crons run before
 * fan-out). Listing a digest for a user who would never receive it
 * just creates an inert toggle and confuses non-controllers, so we
 * gate the consolidated portal section on this single shared rule.
 *
 * If a future digest needs a different RBAC (e.g. committee-only),
 * promote this to a per-digest `eligibility(userId)` callback on
 * `DigestSubscription`. Today every entry shares the controller
 * eligibility, so a single helper is the right level of generality.
 *
 * Exported so the portal PATCH handler can apply the same gate as
 * GET — without it a non-controller could still write the underlying
 * pref column via a hand-rolled request even though the UI never
 * shows the toggle.
 */
export async function isControllerEligibleForAnyOrg(userId: number): Promise<boolean> {
  const direct = await db
    .select({ id: appUsersTable.id })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.id, userId), eq(appUsersTable.role, "org_admin")))
    .limit(1);
  if (direct.length > 0) return true;
  const viaMembership = await db
    .select({ userId: orgMembershipsTable.userId })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.userId, userId),
      inArray(orgMembershipsTable.role, [
        "org_admin",
        "membership_secretary",
        "treasurer",
      ]),
    ))
    .limit(1);
  return viaMembership.length > 0;
}

/**
 * List every user-scoped digest subscription with the caller's
 * current opt-in state. Per-(user, org) digests are filtered out
 * (they live in the existing `EMAIL_SUBSCRIPTION_TYPES` registry on
 * `routes/portal.ts` which already exposes the per-org list), and
 * digests without a `portalListing` (e.g. `erasure_storage_digest`,
 * which has its own rich UI elsewhere on the page — see comment on
 * its registry entry) are also excluded so a controller never sees
 * two toggles for the same preference.
 *
 * Returns an empty array for non-controller users so the
 * consolidated "Email digests" section disappears for players /
 * spectators (the `<section hidden when digests.length === 0>`
 * gate in `PortalCommPrefs.tsx` does the rest).
 */
export async function listUserLevelDigestSubscriptionsForUser(
  userId: number,
): Promise<PortalDigestSubscriptionRow[]> {
  if (!(await isControllerEligibleForAnyOrg(userId))) return [];
  const rows: PortalDigestSubscriptionRow[] = [];
  for (const digest of DIGEST_SUBSCRIPTIONS) {
    if (!digest.storage.userScopedForPortal || !digest.portalListing) continue;
    const optedIn = digest.storage.getOptedInForUser
      ? await digest.storage.getOptedInForUser(userId)
      : await digest.storage.getOptedIn(userId, 0);
    rows.push({
      id: digest.id,
      label: digest.portalListing.label,
      description: digest.portalListing.description,
      optedIn,
    });
  }
  return rows;
}

/**
 * Flip a user-level digest opt-in from the in-portal "Email digests"
 * section. Returns the saved row plus the previous value so the
 * caller can short-circuit a no-op or surface "you just changed X"
 * messaging. Throws if the digest id is unknown or is per-(user, org).
 */
export async function setUserLevelDigestOptedIn(
  userId: number,
  digestId: string,
  optedIn: boolean,
): Promise<{ digest: DigestSubscription; previousOptedIn: boolean }> {
  const digest = findDigestSubscription(digestId);
  if (!digest) throw new Error(`Unknown digest subscription id: ${digestId}`);
  if (!digest.storage.userScopedForPortal || !digest.storage.setOptedInForUser) {
    throw new Error(`Digest ${digestId} is not user-scoped — cannot toggle from portal`);
  }
  const { previousOptedIn } = await digest.storage.setOptedInForUser(userId, optedIn);
  return { digest, previousOptedIn };
}
