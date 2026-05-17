import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { orgMembershipsTable, appUsersTable, playersTable, leagueMembersTable, tournamentsTable, leaguesTable, userNotificationPrefsTable, clubMembersTable, memberAuditLogTable } from "@workspace/db";
import { eq, sql, and, gte, lte, inArray, desc } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm";
import { gateMemberAdd } from "../lib/featureGate";
import { dispatchWebhookEvent } from "../lib/webhookDispatch";
import { recordMemberAudit } from "../lib/auditMember";
import {
  notifyMemberOfAdminCommPrefOverride,
  ADMIN_OVERRIDABLE_PREF_LABELS,
} from "../lib/adminCommPrefOverrideNotify";

const router: IRouter = Router({ mergeParams: true });

// Authorization guard: caller must be authenticated AND be an org_admin or
// tournament_director for the given org (or a platform super_admin).
async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  if (req.user!.role === "super_admin") return true;
  if ((req.user!.role === "org_admin" || req.user!.role === "tournament_director") && Number((req.user! as any).organizationId) === orgId) return true;

  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, req.user!.id),
    ));

  if (!membership || !["org_admin", "tournament_director"].includes(membership.role)) {
    res.status(403).json({ error: "You do not have admin access to this organization." });
    return false;
  }
  return true;
}

// Task #1489 — Shared CSV builder for the per-org "member notification
// preferences" snapshot, extracted from the admin-only HTTP route below
// so the monthly controller digest cron (`sendMemberPrefsDigest` in
// `lib/cron.ts`) can reuse the exact same column set, default-fallback
// rules and CSV escaping. Mirrors the `buildLevyLedgerCsv` extraction
// pattern in `routes/member-360.ts`.
//
// Returns the rendered CSV blob, the row count (members; excludes the
// header) and the canonical filename so the cron's email attachment
// matches what an admin downloads from the UI to the byte.
//
// Members who have never adjusted their preferences (no row in
// `user_notification_prefs`) are emitted with the schema defaults so
// the CSV always covers every member.
export async function buildMemberNotificationPrefsCsv(opts: {
  orgId: number;
}): Promise<{ csv: string; rowCount: number; filename: string }> {
  const { orgId } = opts;
  const members = await db
    .select({
      userId: orgMembershipsTable.userId,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
      role: orgMembershipsTable.role,
    })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(eq(orgMembershipsTable.organizationId, orgId))
    .orderBy(orgMembershipsTable.joinedAt);

  const userIds = members.map(m => m.userId);
  const prefsByUser = new Map<number, typeof userNotificationPrefsTable.$inferSelect>();
  if (userIds.length > 0) {
    const prefs = await db
      .select()
      .from(userNotificationPrefsTable)
      .where(inArray(userNotificationPrefsTable.userId, userIds));
    for (const p of prefs) prefsByUser.set(p.userId, p);
  }

  // Schema defaults — must match `userNotificationPrefsTable` in
  // `lib/db/src/schema/golf.ts`. A member with no row gets these so the
  // CSV is never blank for opted-in defaults.
  const DEFAULTS = {
    preferEmail: true,
    preferPush: true,
    preferSms: false,
    preferWhatsapp: false,
    notifyMemberDocuments: true,
    notifyCommitteePeerDigest: true,
    notifySideGameReceipts: true,
    notifyManualEntryAlerts: true,
    notifyCoachPayoutAccountChanges: true,
    // Task #1724 — coach-side per-event opt-out for the admin courtesy
    // re-verify email. Mirrors the schema default so members without a
    // row appear opted-in in the CSV snapshot.
    notifyAdminPayoutReverify: true,
    notifyDataExportExpiring: true,
    notifyErasureStorageDigest: true,
    // Task #1449 — split push-side opt-out for the stuck-erasure
    // controller digest. Mirrors the schema default; the email-side
    // column above keeps its original semantics.
    notifyErasureStorageDigestPush: true,
    digestMode: false,
  } as const;

  const header = [
    "User ID", "Username", "Display Name", "Email", "Role",
    "Prefer Email", "Prefer Push", "Prefer SMS", "Prefer WhatsApp",
    "Notify Member Documents", "Notify Committee Peer Digest",
    "Notify Side Game Receipts", "Notify Manual Entry Alerts",
    "Notify Coach Payout Account Changes", "Notify Admin Payout Re-verify",
    "Notify Data Export Expiring",
    "Notify Erasure Storage Digest (Email)",
    "Notify Erasure Storage Digest (Push)",
    "Digest Mode",
    "Has Custom Prefs", "Updated At",
  ];

  const fmtBool = (v: boolean) => (v ? "yes" : "no");

  const rows: string[][] = [header];
  for (const m of members) {
    const p = prefsByUser.get(m.userId);
    const v = p ?? DEFAULTS;
    rows.push([
      String(m.userId),
      m.username,
      m.displayName ?? "",
      m.email ?? "",
      m.role,
      fmtBool(v.preferEmail),
      fmtBool(v.preferPush),
      fmtBool(v.preferSms),
      fmtBool(v.preferWhatsapp),
      fmtBool(v.notifyMemberDocuments),
      fmtBool(v.notifyCommitteePeerDigest),
      fmtBool(v.notifySideGameReceipts),
      fmtBool(v.notifyManualEntryAlerts),
      fmtBool(v.notifyCoachPayoutAccountChanges),
      fmtBool(v.notifyAdminPayoutReverify),
      fmtBool(v.notifyDataExportExpiring),
      fmtBool(v.notifyErasureStorageDigest),
      fmtBool(v.notifyErasureStorageDigestPush),
      fmtBool(v.digestMode),
      p ? "yes" : "no",
      p ? p.updatedAt.toISOString() : "",
    ]);
  }

  const csv = rows
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  return {
    csv,
    rowCount: members.length,
    filename: `member-notification-prefs-org-${orgId}.csv`,
  };
}

// GET /organizations/:orgId/members/notification-prefs.csv
// Admin-only CSV export of every org member's notification preferences:
// per-channel toggles (email/push/SMS/WhatsApp) plus the per-category
// flags (including `notifySideGameReceipts` from Task #962/#1106) and the
// global `digestMode` flag. Treasurers asked for a single downloadable
// view of who is opted in/out of which channels and category-specific
// notices for compliance and outreach planning.
router.get("/notification-prefs.csv", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { csv, filename } = await buildMemberNotificationPrefsCsv({ orgId });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  res.send(csv);
});

// GET /organizations/:orgId/members/notification-prefs/recent-changes
// Admin-only summary of `user_notification_prefs.updated_at` activity in
// the last 30 days, scoped to members of this org. Treasurers want to
// spot a sudden spike in opt-outs (e.g. after a noisy email push) so they
// can investigate before the next billing run. The CSV export carries the
// raw "Updated At" + "Has Custom Prefs" columns, but the admin members
// page itself had no signal — this endpoint backs the new "Recently
// changed prefs" panel that powers the click-to-filter behaviour
// (see Task #1490).
//
// Returns one row per channel (email/push/SMS/WhatsApp) and per category
// (notify* flags) with the count of members who are *currently* opted-out
// (column = false) AND whose prefs row was updated inside the window.
// `userIds` lets the frontend filter the members table to that subset
// when an admin clicks a row. Members who never touched their prefs are
// excluded — they have no row in `user_notification_prefs` and therefore
// no `updated_at`.
//
// Task #1833 — also returns `currentWeekOptedOutCount` (members whose
// prefs row was updated in the last 7 days) and `priorWeekOptedOutCount`
// (members whose prefs row was updated in the prior 7-day window, i.e.
// 8–14 days ago). The frontend renders a week-over-week delta from these
// so treasurers can spot a sudden spike (e.g. "100 people opted out of
// side-game receipts in the last 7 days vs only 5 the week before") much
// faster than scanning the raw 30-day counts.
router.get("/notification-prefs/recent-changes", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const windowDays = 30;
  const now = Date.now();
  const cutoff = new Date(now - windowDays * 24 * 60 * 60 * 1000);
  const currentWeekCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const priorWeekCutoff = new Date(now - 14 * 24 * 60 * 60 * 1000);

  // Pull every prefs row for this org's members updated in the window.
  // Joining on `org_memberships` scopes to the current org so admins of
  // org A never see opt-out activity from org B (defence-in-depth on top
  // of the `requireOrgAdmin` check above).
  const recent = await db
    .select({
      userId: userNotificationPrefsTable.userId,
      updatedAt: userNotificationPrefsTable.updatedAt,
      preferEmail: userNotificationPrefsTable.preferEmail,
      preferPush: userNotificationPrefsTable.preferPush,
      preferSms: userNotificationPrefsTable.preferSms,
      preferWhatsapp: userNotificationPrefsTable.preferWhatsapp,
      notifyMemberDocuments: userNotificationPrefsTable.notifyMemberDocuments,
      notifyCommitteePeerDigest: userNotificationPrefsTable.notifyCommitteePeerDigest,
      notifySideGameReceipts: userNotificationPrefsTable.notifySideGameReceipts,
      notifyManualEntryAlerts: userNotificationPrefsTable.notifyManualEntryAlerts,
      notifyCoachPayoutAccountChanges: userNotificationPrefsTable.notifyCoachPayoutAccountChanges,
      notifyAdminPayoutReverify: userNotificationPrefsTable.notifyAdminPayoutReverify,
      notifyDataExportExpiring: userNotificationPrefsTable.notifyDataExportExpiring,
      notifyErasureStorageDigest: userNotificationPrefsTable.notifyErasureStorageDigest,
      notifyErasureStorageDigestPush: userNotificationPrefsTable.notifyErasureStorageDigestPush,
    })
    .from(userNotificationPrefsTable)
    .innerJoin(orgMembershipsTable, eq(orgMembershipsTable.userId, userNotificationPrefsTable.userId))
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      gte(userNotificationPrefsTable.updatedAt, cutoff),
    ));

  type PrefRow = typeof recent[number];
  type FlagKey = Exclude<keyof PrefRow, "userId" | "updatedAt">;

  // Display order matches what treasurers care about most — channels
  // first (email is the noisiest), then category opt-outs in the order
  // they were introduced.
  const FIELDS: ReadonlyArray<{ key: FlagKey; label: string; group: "channel" | "category" }> = [
    { key: "preferEmail",                     label: "Email channel",                            group: "channel" },
    { key: "preferPush",                      label: "Push channel",                             group: "channel" },
    { key: "preferSms",                       label: "SMS channel",                              group: "channel" },
    { key: "preferWhatsapp",                  label: "WhatsApp channel",                         group: "channel" },
    { key: "notifySideGameReceipts",          label: "Side-game receipt emails",                 group: "category" },
    { key: "notifyMemberDocuments",           label: "Member document alerts",                   group: "category" },
    { key: "notifyCommitteePeerDigest",       label: "Committee peer-response digest",           group: "category" },
    { key: "notifyManualEntryAlerts",         label: "Manual-entry data-quality alerts",         group: "category" },
    { key: "notifyCoachPayoutAccountChanges", label: "Coach payout account changes",             group: "category" },
    { key: "notifyAdminPayoutReverify",       label: "Admin payout re-verification notice",       group: "category" },
    { key: "notifyDataExportExpiring",        label: "Data export expiring reminder",            group: "category" },
    { key: "notifyErasureStorageDigest",      label: "Stuck-erasure controller digest (email)",  group: "category" },
    { key: "notifyErasureStorageDigestPush",  label: "Stuck-erasure controller digest (push)",   group: "category" },
  ];

  const rows = FIELDS.map(f => {
    const optedOut = recent.filter(r => r[f.key] === false);
    // Task #1833 — bucket the opted-out members into the current 7-day
    // window vs the prior 7-day window (8–14 days ago) so the frontend
    // can render a week-over-week delta. Members updated 15–30 days ago
    // contribute to `optedOutCount`/`userIds` (the existing 30-day total
    // and click-to-filter list) but to neither weekly bucket.
    const currentWeekOptedOut = optedOut.filter(r => r.updatedAt >= currentWeekCutoff);
    const priorWeekOptedOut = optedOut.filter(
      r => r.updatedAt >= priorWeekCutoff && r.updatedAt < currentWeekCutoff,
    );
    return {
      key: f.key,
      label: f.label,
      group: f.group,
      optedOutCount: optedOut.length,
      userIds: optedOut.map(r => r.userId),
      currentWeekOptedOutCount: currentWeekOptedOut.length,
      priorWeekOptedOutCount: priorWeekOptedOut.length,
    };
  });

  res.json({
    windowDays,
    cutoff: cutoff.toISOString(),
    totalUsersChanged: recent.length,
    rows,
  });
});

// GET /organizations/:orgId/members/notification-prefs/last-digest
// Task #1831 — surfaces the most recent monthly "member notification
// preferences" digest send (cron `sendMemberPrefsDigest` in `lib/cron.ts`).
// The cron writes a `member_audit_log` row with entity='comm_prefs' and
// action='member_prefs_digest_sent' carrying recipient list + counts in
// `metadata`. Controllers asked for a small "Last digest sent" card on
// the admin notification-prefs panel so they can confirm who's still on
// the distribution list without poking the audit log table directly.
//
// Reads the latest matching audit row (newest first); returns
// `{ lastDigest: null }` when nothing has been sent yet for this org.
router.get("/notification-prefs/last-digest", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [row] = await db
    .select({
      id: memberAuditLogTable.id,
      createdAt: memberAuditLogTable.createdAt,
      metadata: memberAuditLogTable.metadata,
    })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.entity, "comm_prefs"),
      eq(memberAuditLogTable.action, "member_prefs_digest_sent"),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id))
    .limit(1);

  if (!row) {
    res.json({ lastDigest: null });
    return;
  }

  // The cron writes a structured metadata payload (see
  // `sendMemberPrefsDigest` in `lib/cron.ts`). Defensive parsing here
  // means an out-of-shape row (e.g. legacy/manual insert) still renders
  // useful pieces in the UI rather than 500ing the panel.
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const rawRecipients = Array.isArray(meta.recipients) ? meta.recipients : [];
  const recipients = rawRecipients
    .map((r): { userId: number; email: string } | null => {
      if (!r || typeof r !== "object") return null;
      const rec = r as Record<string, unknown>;
      const userId = typeof rec.userId === "number" ? rec.userId : null;
      const email = typeof rec.email === "string" ? rec.email : null;
      if (userId === null || email === null) return null;
      return { userId, email };
    })
    .filter((r): r is { userId: number; email: string } => r !== null);

  const numberOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const stringOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  // Prefer the explicit `sentAt` stamp the cron writes (so a backdated
  // re-insert by an admin still reflects the original send time), but fall
  // back to the audit row's `createdAt` if it's missing/malformed.
  const sentAtIso =
    stringOrNull(meta.sentAt) ?? row.createdAt.toISOString();

  res.json({
    lastDigest: {
      sentAt: sentAtIso,
      period: stringOrNull(meta.period),
      memberRows: numberOrNull(meta.memberRows) ?? 0,
      recipientsEmailed: numberOrNull(meta.recipientsEmailed) ?? 0,
      recipientsSuppressed: numberOrNull(meta.recipientsSuppressed) ?? 0,
      filename: stringOrNull(meta.filename),
      recipients,
    },
  });
});

// GET /organizations/:orgId/members
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const members = await db
    .select({
      id: orgMembershipsTable.id,
      userId: orgMembershipsTable.userId,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
      role: orgMembershipsTable.role,
      joinedAt: orgMembershipsTable.joinedAt,
      replitUserId: appUsersTable.replitUserId,
      emailVerified: appUsersTable.emailVerified,
      profileImage: appUsersTable.profileImage,
    })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(eq(orgMembershipsTable.organizationId, orgId))
    .orderBy(orgMembershipsTable.joinedAt);

  // Enrich with notification preferences
  const userIds = members.map(m => m.userId);
  const prefsMap = new Map<number, { preferEmail: boolean; preferPush: boolean; preferSms: boolean; preferWhatsapp: boolean; notifySideGameReceipts: boolean }>();
  if (userIds.length > 0) {
    const prefs = await db
      .select()
      .from(userNotificationPrefsTable)
      .where(inArray(userNotificationPrefsTable.userId, userIds));
    for (const p of prefs) {
      prefsMap.set(p.userId, { preferEmail: p.preferEmail, preferPush: p.preferPush, preferSms: p.preferSms, preferWhatsapp: p.preferWhatsapp, notifySideGameReceipts: p.notifySideGameReceipts });
    }
  }

  res.json(members.map(m => ({
    ...m,
    isLocalAuth: m.replitUserId.startsWith("ep_"),
    replitUserId: undefined,
    // Default to the schema defaults for users with no user_notification_prefs
    // row so admin tools (e.g. the side-game-receipt mute button) can target
    // members who have never touched their preferences.
    notifPrefs: prefsMap.get(m.userId) ?? {
      preferEmail: true,
      preferPush: true,
      preferSms: false,
      preferWhatsapp: false,
      notifySideGameReceipts: true,
    },
  })));
});

// POST /organizations/:orgId/members
router.post("/", gateMemberAdd(), async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { username, role } = req.body;

  if (!username || !role) {
    res.status(400).json({ error: "username and role are required" });
    return;
  }

  // Find user by username
  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.username, username));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [membership] = await db
    .insert(orgMembershipsTable)
    .values({ organizationId: orgId, userId: user.id, role })
    .returning();

  dispatchWebhookEvent(orgId, "member.joined", {
    memberId: membership.id,
    userId: membership.userId,
    username: user.username,
    email: user.email,
    role: membership.role,
    joinedAt: membership.joinedAt.toISOString(),
  });

  res.status(201).json({
    id: membership.id,
    userId: membership.userId,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: membership.role,
    joinedAt: membership.joinedAt.toISOString(),
  });
});

// PUT /organizations/:orgId/members/:userId
router.put("/:userId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = parseInt(String((req.params as Record<string, string>).userId));
  const { role } = req.body;

  const [membership] = await db
    .update(orgMembershipsTable)
    .set({ role })
    .where(sql`${orgMembershipsTable.organizationId} = ${orgId} AND ${orgMembershipsTable.userId} = ${userId}`)
    .returning();

  if (!membership) { { res.status(404).json({ error: "Member not found" }); return; } }

  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, userId));
  res.json({
    id: membership.id,
    userId: membership.userId,
    username: user?.username,
    displayName: user?.displayName,
    email: user?.email,
    role: membership.role,
    joinedAt: membership.joinedAt.toISOString(),
  });
});

// DELETE /organizations/:orgId/members/:userId
router.delete("/:userId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = parseInt(String((req.params as Record<string, string>).userId));

  await db
    .delete(orgMembershipsTable)
    .where(sql`${orgMembershipsTable.organizationId} = ${orgId} AND ${orgMembershipsTable.userId} = ${userId}`);

  dispatchWebhookEvent(orgId, "member.removed", { userId, orgId });

  res.status(204).send();
});

// PUT /organizations/:orgId/members/:userId/notification-prefs
// Lets an org admin / tournament director toggle one or more of a member's
// notification preferences on their behalf. Originally only
// `notifySideGameReceipts` was supported (Task #1272 / #1106); Task #1506
// extended this to cover the channel toggles (`preferEmail`, `preferPush`,
// `preferSms`, `preferWhatsapp`) so admins running phone-support workflows
// can flip them for members who can't navigate the portal themselves.
//
// Any subset of those five booleans may be supplied; unspecified fields are
// left unchanged. The change is recorded as a single `member_audit_log` row
// (entity = "comm_prefs", action = "update") whose `fieldChanges` lists every
// diff, so treasurers can prove who flipped what and why.
router.put("/:userId/notification-prefs", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(orgId) || isNaN(userId)) {
    res.status(400).json({ error: "Invalid orgId or userId" });
    return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const TOGGLEABLE_FIELDS = [
    "preferEmail",
    "preferPush",
    "preferSms",
    "preferWhatsapp",
    "notifySideGameReceipts",
  ] as const;
  type ToggleField = typeof TOGGLEABLE_FIELDS[number];

  const body = (req.body ?? {}) as Record<string, unknown>;
  const supplied: Partial<Record<ToggleField, boolean>> = {};
  for (const key of TOGGLEABLE_FIELDS) {
    if (key in body) {
      const value = body[key];
      if (typeof value !== "boolean") {
        res.status(400).json({ error: `${key} must be a boolean when supplied` });
        return;
      }
      supplied[key] = value;
    }
  }
  if (Object.keys(supplied).length === 0) {
    res.status(400).json({
      error: "At least one of preferEmail, preferPush, preferSms, preferWhatsapp, notifySideGameReceipts (boolean) is required",
    });
    return;
  }
  const reason = body.reason;
  const reasonText = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null;

  // The target must actually be a member of this org — prevents an admin in
  // org A from flipping the flag on a user who only belongs to org B.
  const [membership] = await db
    .select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, userId),
    ))
    .limit(1);
  if (!membership) {
    res.status(404).json({ error: "Member not found in this organization" });
    return;
  }

  const [existing] = await db
    .select()
    .from(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, userId))
    .limit(1);

  // Defaults mirror the user_notification_prefs schema defaults so the diff
  // reported in the audit log accurately reflects what the member had before
  // the admin override (insert path vs update path). Email/push default ON,
  // SMS/WhatsApp default OFF (opt-in), and notifySideGameReceipts defaults
  // ON per Task #962.
  const DEFAULTS: Record<ToggleField, boolean> = {
    preferEmail: true,
    preferPush: true,
    preferSms: false,
    preferWhatsapp: false,
    notifySideGameReceipts: true,
  };
  const previousValues: Record<ToggleField, boolean> = {
    preferEmail: existing?.preferEmail ?? DEFAULTS.preferEmail,
    preferPush: existing?.preferPush ?? DEFAULTS.preferPush,
    preferSms: existing?.preferSms ?? DEFAULTS.preferSms,
    preferWhatsapp: existing?.preferWhatsapp ?? DEFAULTS.preferWhatsapp,
    notifySideGameReceipts: existing?.notifySideGameReceipts ?? DEFAULTS.notifySideGameReceipts,
  };

  // Build the upsert payload. For the insert path we have to spell out every
  // toggleable column (otherwise Drizzle would insert NULL and rely on the
  // DB default — fine in practice, but we want the row to reflect
  // previousValues + the supplied overrides explicitly so subsequent reads
  // are deterministic).
  const insertValues: Record<string, unknown> = { userId };
  const updateSet: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of TOGGLEABLE_FIELDS) {
    insertValues[key] = supplied[key] ?? previousValues[key];
    if (key in supplied) {
      updateSet[key] = supplied[key];
    }
  }

  const [saved] = await db
    .insert(userNotificationPrefsTable)
    .values(insertValues as typeof userNotificationPrefsTable.$inferInsert)
    .onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: updateSet,
    })
    .returning();

  // Look up the matching club_member row (if any) so the audit entry shows
  // up on the member's 360 timeline. The user may not have a club_member
  // record (e.g. tournament-only player) — in that case we still record the
  // org-level audit row with clubMemberId=null.
  const [clubMember] = await db
    .select({ id: clubMembersTable.id })
    .from(clubMembersTable)
    .where(and(
      eq(clubMembersTable.organizationId, orgId),
      eq(clubMembersTable.userId, userId),
    ))
    .limit(1);

  // Record one audit row whose `fieldChanges` enumerates every diff. Single-
  // field callers (the original side-game receipts toggle) still produce a
  // row whose `fieldChanges.notifySideGameReceipts` matches the contract
  // existing tests assert against.
  const fieldChanges: Record<string, { from: boolean; to: boolean }> = {};
  for (const key of TOGGLEABLE_FIELDS) {
    if (key in supplied && supplied[key] !== previousValues[key]) {
      fieldChanges[key] = { from: previousValues[key], to: supplied[key]! };
    }
  }
  // Even if the new value matches the old value (no-op toggle), we still
  // want the per-field diff present so the audit log shows what was sent —
  // matches the behaviour of the original single-field implementation which
  // always recorded `notifySideGameReceipts: { from, to }` even if equal.
  for (const key of TOGGLEABLE_FIELDS) {
    if (key in supplied && !(key in fieldChanges)) {
      fieldChanges[key] = { from: previousValues[key], to: supplied[key]! };
    }
  }

  await recordMemberAudit({
    req,
    organizationId: orgId,
    clubMemberId: clubMember?.id ?? null,
    entity: "comm_prefs",
    entityId: userId,
    action: "update",
    changes: fieldChanges,
    reason: reasonText ?? undefined,
    metadata: { source: "admin_member_toggle", targetUserId: userId },
  });

  // Task #1504 / #1506 — Tell the affected member (email + in-app inbox)
  // that an admin flipped one of their notification preferences on their
  // behalf and why. We skip the notify entirely when an admin toggles
  // their OWN preference via this endpoint (a self-service flip
  // masquerading as an override) so we don't spam them about a change
  // they just made. Real self-service portal flips hit a different
  // endpoint and never reach this code path. Best-effort: failures are
  // caught inside the helper so a delivery glitch can't roll back the
  // already-saved preference. One notify is fired per *actually changed*
  // field — supplied-but-unchanged fields (`from === to`) don't trigger
  // a notify even though they show up in the audit row.
  const actingUser = req.user as { id?: number } | undefined;
  const actorUserId = actingUser?.id;
  if (typeof actorUserId === "number" && actorUserId !== userId) {
    for (const key of TOGGLEABLE_FIELDS) {
      if (!(key in supplied)) continue;
      const newValue = supplied[key]!;
      const previousValue = previousValues[key];
      if (previousValue === newValue) continue;
      void notifyMemberOfAdminCommPrefOverride({
        organizationId: orgId,
        targetUserId: userId,
        adminUserId: actorUserId,
        prefKey: key,
        prefLabel: ADMIN_OVERRIDABLE_PREF_LABELS[key] ?? key,
        previousValue,
        newValue,
        reason: reasonText,
        clubMemberId: clubMember?.id ?? null,
      });
    }
  }

  res.json({
    preferEmail: saved.preferEmail,
    preferPush: saved.preferPush,
    preferSms: saved.preferSms,
    preferWhatsapp: saved.preferWhatsapp,
    notifySideGameReceipts: saved.notifySideGameReceipts,
  });
});

// Task #1851 — Shared CSV builder for the comm_prefs audit history
// (per-member or org-wide). Compliance/treasury staff asked for a CSV
// download alongside the in-page timeline added in Task #1505 so they can
// take the audit trail offline for review. Mirrors the column shape from
// the brief: timestamp, actor, role, field, before, after, reason.
//
// Each `member_audit_log` row may carry multiple `fieldChanges` (e.g.
// digest mode + channel toggles edited in one save), so we emit ONE CSV
// row per (audit row × field) pair. Rows with no `fieldChanges` map are
// still emitted as a single CSV row with empty field/before/after so
// non-update actions (e.g. `member_prefs_digest_sent`) still appear in
// the export. Returned newest-first to match the in-page timeline order.
export async function buildCommPrefsAuditCsv(opts: {
  orgId: number;
  // When set, scope the export to a single member (entityId match). When
  // omitted, the export covers every comm_prefs row in the org.
  userId?: number;
  // Audit `entity` slug. Defaults to "comm_prefs" to match the in-page
  // timeline default; pass "all" to include every entity for the scope.
  entity?: string;
}): Promise<{ csv: string; rowCount: number; filename: string }> {
  const entityFilter = opts.entity?.trim() || "comm_prefs";
  const actorUsers = aliasedTable(appUsersTable, "actorUsers");
  const targetUsers = aliasedTable(appUsersTable, "targetUsers");

  const conditions = [eq(memberAuditLogTable.organizationId, opts.orgId)];
  if (opts.userId !== undefined) {
    conditions.push(eq(memberAuditLogTable.entityId, opts.userId));
  }
  if (entityFilter !== "all") {
    conditions.push(eq(memberAuditLogTable.entity, entityFilter));
  }

  const rows = await db
    .select({
      id: memberAuditLogTable.id,
      createdAt: memberAuditLogTable.createdAt,
      actorUserId: memberAuditLogTable.actorUserId,
      actorName: memberAuditLogTable.actorName,
      actorRole: memberAuditLogTable.actorRole,
      entity: memberAuditLogTable.entity,
      entityId: memberAuditLogTable.entityId,
      action: memberAuditLogTable.action,
      fieldChanges: memberAuditLogTable.fieldChanges,
      reason: memberAuditLogTable.reason,
      currentActorDisplayName: actorUsers.displayName,
      currentActorEmail: actorUsers.email,
      targetUsername: targetUsers.username,
      targetDisplayName: targetUsers.displayName,
      targetEmail: targetUsers.email,
    })
    .from(memberAuditLogTable)
    .leftJoin(actorUsers, eq(actorUsers.id, memberAuditLogTable.actorUserId))
    .leftJoin(targetUsers, eq(targetUsers.id, memberAuditLogTable.entityId))
    .where(and(...conditions))
    .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id));

  const fmtValue = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    return JSON.stringify(v);
  };

  const header = [
    "Timestamp",
    "Member User ID",
    "Member",
    "Actor",
    "Role",
    "Entity",
    "Action",
    "Field",
    "Before",
    "After",
    "Reason",
  ];
  const csvRows: string[][] = [header];
  let dataRowCount = 0;

  for (const r of rows) {
    const actorLabel =
      r.currentActorDisplayName ?? r.actorName ?? r.currentActorEmail ?? "system";
    const memberLabel =
      r.targetDisplayName ?? r.targetUsername ?? r.targetEmail ?? "";
    const baseRow = [
      r.createdAt.toISOString(),
      r.entityId !== null ? String(r.entityId) : "",
      memberLabel,
      actorLabel,
      r.actorRole ?? "",
      r.entity,
      r.action,
    ];
    const changes = r.fieldChanges ?? {};
    const changeKeys = Object.keys(changes);
    if (changeKeys.length === 0) {
      csvRows.push([...baseRow, "", "", "", r.reason ?? ""]);
      dataRowCount++;
    } else {
      for (const key of changeKeys) {
        const c = changes[key];
        csvRows.push([
          ...baseRow,
          key,
          fmtValue(c?.from),
          fmtValue(c?.to),
          r.reason ?? "",
        ]);
        dataRowCount++;
      }
    }
  }

  const csv = csvRows
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const filename =
    opts.userId !== undefined
      ? `comm-prefs-audit-org-${opts.orgId}-user-${opts.userId}.csv`
      : `comm-prefs-audit-org-${opts.orgId}.csv`;

  return { csv, rowCount: dataRowCount, filename };
}

// GET /organizations/:orgId/members/audit-log.csv
// Task #1851 — Org-wide CSV export of the comm_prefs audit history that
// powers the in-page Players timeline (Task #1505). Compliance/treasury
// staff want one downloadable view of every preference change made in
// the org so they can review offline. Defaults to entity='comm_prefs' to
// match the timeline; pass `?entity=all` to include every entity.
router.get("/audit-log.csv", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const entityRaw = (req.query.entity ?? "comm_prefs").toString().trim();
  const entity = entityRaw || "comm_prefs";

  const { csv, filename } = await buildCommPrefsAuditCsv({ orgId, entity });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  res.send(csv);
});

// GET /organizations/:orgId/members/:userId/audit-log.csv
// Task #1851 — Per-member CSV export of the comm_prefs audit history.
// Backs the "Download history" button in the Players page expanded row,
// alongside the existing in-page timeline (Task #1505). Same auth and
// cross-org guards as the JSON endpoint below.
router.get("/:userId/audit-log.csv", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(orgId) || isNaN(userId)) {
    res.status(400).json({ error: "Invalid orgId or userId" });
    return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Confirm the target is a member of this org so an admin in org A
  // cannot probe audit history for a user who only belongs to org B
  // (mirrors the JSON endpoint below).
  const [membership] = await db
    .select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, userId),
    ))
    .limit(1);
  if (!membership) {
    res.status(404).json({ error: "Member not found in this organization" });
    return;
  }

  const entityRaw = (req.query.entity ?? "comm_prefs").toString().trim();
  const entity = entityRaw || "comm_prefs";

  const { csv, filename } = await buildCommPrefsAuditCsv({ orgId, userId, entity });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  res.send(csv);
});

// GET /organizations/:orgId/members/:userId/audit-log
// Task #1505 — surfaces `member_audit_log` rows for a member so admins can
// self-audit "who muted this member's side-game receipts and when?". The PUT
// notification-prefs endpoint above writes rows with entity='comm_prefs' and
// entityId=userId; we filter on those by default but accept an `entity` query
// param (or `all`) for future extensibility.
//
// Returns reverse-chronological entries with the actor's freshest display
// name (left-joined back to `app_users`) so that even a renamed admin shows
// up correctly. Capped at 100 rows per request — the UI only renders the
// last 20 by default (Task brief), so this leaves headroom without paging.
router.get("/:userId/audit-log", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(orgId) || isNaN(userId)) {
    res.status(400).json({ error: "Invalid orgId or userId" });
    return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const rawLimit = parseInt(String(req.query.limit ?? "20"));
  const limit = Math.max(1, Math.min(isNaN(rawLimit) ? 20 : rawLimit, 100));
  const entityFilter = (req.query.entity ?? "comm_prefs").toString().trim() || "comm_prefs";

  // Task #1852 — optional date-range + actor filters so admins can drill into
  // a specific incident without scrolling the most-recent-20 timeline. All
  // three params are optional; bad input returns 400 so the UI never silently
  // shows the unfiltered list when the admin thought they had a filter on.
  const fromRaw = req.query.from;
  const toRaw = req.query.to;
  const actorRaw = req.query.actorUserId;

  let fromDate: Date | null = null;
  if (typeof fromRaw === "string" && fromRaw.trim().length > 0) {
    fromDate = new Date(fromRaw);
    if (isNaN(fromDate.getTime())) {
      res.status(400).json({ error: "`from` must be an ISO timestamp" });
      return;
    }
  }
  let toDate: Date | null = null;
  if (typeof toRaw === "string" && toRaw.trim().length > 0) {
    toDate = new Date(toRaw);
    if (isNaN(toDate.getTime())) {
      res.status(400).json({ error: "`to` must be an ISO timestamp" });
      return;
    }
  }
  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    res.status(400).json({ error: "`from` must be on or before `to`" });
    return;
  }

  let actorUserIdFilter: number | null = null;
  if (typeof actorRaw === "string" && actorRaw.trim().length > 0) {
    const parsed = parseInt(actorRaw, 10);
    if (isNaN(parsed)) {
      res.status(400).json({ error: "`actorUserId` must be an integer" });
      return;
    }
    actorUserIdFilter = parsed;
  }

  // Confirm the target is a member of this org so an admin in org A cannot
  // probe audit history for a user who only belongs to org B.
  const [membership] = await db
    .select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, userId),
    ))
    .limit(1);
  if (!membership) {
    res.status(404).json({ error: "Member not found in this organization" });
    return;
  }

  // The `comm_prefs` audit rows are written with entityId=userId (see the
  // PUT handler above), so we always need to match on entityId. They may be
  // stored with clubMemberId set OR null (member without a club_member row),
  // so filter by (entity, entityId, organizationId) which is unambiguous.
  const actorUsers = aliasedTable(appUsersTable, "actorUsers");
  const baseConditions = [
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entityId, userId),
  ];
  if (entityFilter !== "all") {
    baseConditions.push(eq(memberAuditLogTable.entity, entityFilter));
  }

  // Task #1852 — list of distinct actors that have ever touched this member's
  // audit history (within the same entity scope). Returned alongside results
  // so the UI's actor dropdown stays populated even when a date filter
  // narrows `entries` to zero rows. We grab the distinct `actorUserId`s
  // first, then look up the freshest display name in a second query so a
  // single admin who changed their name across rows still collapses to one
  // dropdown entry.
  const distinctActorIdRows = await db
    .selectDistinct({ actorUserId: memberAuditLogTable.actorUserId })
    .from(memberAuditLogTable)
    .where(and(...baseConditions));
  const distinctActorIds = distinctActorIdRows
    .map(r => r.actorUserId)
    .filter((id): id is number => id !== null);

  const actorUserDetails = distinctActorIds.length === 0
    ? []
    : await db
        .select({
          id: appUsersTable.id,
          displayName: appUsersTable.displayName,
          email: appUsersTable.email,
        })
        .from(appUsersTable)
        .where(inArray(appUsersTable.id, distinctActorIds));
  const actorDetailsById = new Map<number, { displayName: string | null; email: string | null }>();
  for (const u of actorUserDetails) {
    actorDetailsById.set(u.id, { displayName: u.displayName, email: u.email });
  }

  // Fall back to the most recent `actorName` snapshot for actors whose
  // `app_users` row was deleted (so the name still renders in the dropdown).
  const fallbackSnapshotRows = await db
    .select({
      actorUserId: memberAuditLogTable.actorUserId,
      actorName: memberAuditLogTable.actorName,
      createdAt: memberAuditLogTable.createdAt,
    })
    .from(memberAuditLogTable)
    .where(and(...baseConditions))
    .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id));
  const snapshotByActor = new Map<number, string | null>();
  for (const r of fallbackSnapshotRows) {
    if (r.actorUserId == null) continue;
    if (!snapshotByActor.has(r.actorUserId)) {
      snapshotByActor.set(r.actorUserId, r.actorName);
    }
  }

  const availableActors = distinctActorIds
    .map(id => {
      const live = actorDetailsById.get(id);
      const name =
        live?.displayName ?? snapshotByActor.get(id) ?? live?.email ?? null;
      return { actorUserId: id, actorName: name };
    })
    .sort((a, b) => (a.actorName ?? "").localeCompare(b.actorName ?? ""));

  const filterConditions = [...baseConditions];
  if (fromDate) {
    filterConditions.push(gte(memberAuditLogTable.createdAt, fromDate));
  }
  if (toDate) {
    filterConditions.push(lte(memberAuditLogTable.createdAt, toDate));
  }
  if (actorUserIdFilter !== null) {
    filterConditions.push(eq(memberAuditLogTable.actorUserId, actorUserIdFilter));
  }

  const rows = await db
    .select({
      id: memberAuditLogTable.id,
      createdAt: memberAuditLogTable.createdAt,
      actorUserId: memberAuditLogTable.actorUserId,
      actorName: memberAuditLogTable.actorName,
      actorRole: memberAuditLogTable.actorRole,
      entity: memberAuditLogTable.entity,
      entityId: memberAuditLogTable.entityId,
      action: memberAuditLogTable.action,
      fieldChanges: memberAuditLogTable.fieldChanges,
      reason: memberAuditLogTable.reason,
      metadata: memberAuditLogTable.metadata,
      currentActorDisplayName: actorUsers.displayName,
      currentActorEmail: actorUsers.email,
    })
    .from(memberAuditLogTable)
    .leftJoin(actorUsers, eq(actorUsers.id, memberAuditLogTable.actorUserId))
    .where(and(...filterConditions))
    .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id))
    .limit(limit);

  const entries = rows.map(r => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    actorUserId: r.actorUserId,
    // Prefer the freshest display name from app_users (handles renamed
    // admins) but fall back to the snapshot we wrote at audit time so
    // deleted users still render their name.
    actorName: r.currentActorDisplayName ?? r.actorName ?? r.currentActorEmail ?? null,
    actorRole: r.actorRole,
    entity: r.entity,
    entityId: r.entityId,
    action: r.action,
    fieldChanges: r.fieldChanges,
    reason: r.reason,
    metadata: r.metadata,
  }));

  res.json({
    entries,
    limit,
    availableActors,
    appliedFilters: {
      from: fromDate ? fromDate.toISOString() : null,
      to: toDate ? toDate.toISOString() : null,
      actorUserId: actorUserIdFilter,
    },
  });
});

// POST /organizations/:orgId/members/:userId/player-records
// Explicitly link a specific player record (by ID) to this member — scoped to this org (no cross-org linking)
router.post("/:userId/player-records", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const userId = parseInt(String((req.params as Record<string, string>).userId));
  const { playerId } = req.body;
  if (isNaN(orgId) || isNaN(userId) || !playerId || isNaN(parseInt(playerId))) {
    res.status(400).json({ error: "orgId, userId, and playerId (number) are required" });
    return;
  }
  const playerIdNum = parseInt(playerId);

  // Verify the player record belongs to a tournament in this org (prevents cross-org linking)
  const [record] = await db
    .select({ id: playersTable.id, userId: playersTable.userId })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(
      and(
        eq(playersTable.id, playerIdNum),
        eq(tournamentsTable.organizationId, orgId)
      )
    );

  if (!record) {
    res.status(404).json({ error: "Player record not found in this organization" });
    return;
  }

  if (record.userId != null && record.userId !== userId) {
    res.status(409).json({ error: "Player record is already linked to another portal account" });
    return;
  }

  await db.update(playersTable).set({ userId }).where(eq(playersTable.id, playerIdNum));
  res.json({ success: true, message: "Player record linked to portal account." });
});

// GET /organizations/:orgId/members/:userId/player-records
// Lists player records (tournament registrations) linked to this member, scoped to this org's tournaments only
router.get("/:userId/player-records", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(orgId) || isNaN(userId)) { { res.status(400).json({ error: "Invalid ID" }); return; } }
  const records = await db
    .select({
      playerId: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      email: playersTable.email,
      tournamentId: playersTable.tournamentId,
    })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(
      and(
        eq(playersTable.userId, userId),
        eq(tournamentsTable.organizationId, orgId)
      )
    );
  res.json(records);
});

// DELETE /organizations/:orgId/members/:userId/player-records/:playerId
// Unlinks a specific player record from this member — only if the record belongs to this org's tournament
router.delete("/:userId/player-records/:playerId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(orgId) || isNaN(playerId) || isNaN(userId)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }
  // Confirm the record belongs to a tournament in this org (prevents cross-org unlink)
  const [record] = await db
    .select({ id: playersTable.id })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(
      and(
        eq(playersTable.id, playerId),
        eq(playersTable.userId, userId),
        eq(tournamentsTable.organizationId, orgId)
      )
    );
  if (!record) {
    res.status(404).json({ error: "Player record not found or not linked to this user in this organization" });
    return;
  }
  await db.update(playersTable).set({ userId: null }).where(eq(playersTable.id, playerId));
  res.json({ success: true, message: "Player record unlinked." });
});

// POST /organizations/:orgId/members/:userId/sync-player-records
// Links tournament/league records matching the member's email — scoped to this org's tournaments/leagues only
router.post("/:userId/sync-player-records", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (isNaN(orgId) || isNaN(userId)) { { res.status(400).json({ error: "Invalid ID" }); return; } }

  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, userId));
  if (!user || !user.email) {
    res.status(404).json({ error: "User not found or has no email on file" });
    return;
  }

  // Collect IDs for this org's tournaments and leagues to prevent cross-org writes
  const [orgTournamentIds, orgLeagueIds] = await Promise.all([
    db.select({ id: tournamentsTable.id })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.organizationId, orgId))
      .then(rows => rows.map(r => r.id)),
    db.select({ id: leaguesTable.id })
      .from(leaguesTable)
      .where(eq(leaguesTable.organizationId, orgId))
      .then(rows => rows.map(r => r.id)),
  ]);

  const [updatedPlayers, updatedLeagues] = await Promise.all([
    orgTournamentIds.length === 0
      ? Promise.resolve([] as { id: number }[])
      : db.update(playersTable)
          .set({ userId })
          .where(
            and(
              sql`${playersTable.email} = ${user.email}`,
              sql`(${playersTable.userId} IS NULL OR ${playersTable.userId} != ${userId})`,
              inArray(playersTable.tournamentId, orgTournamentIds)
            )
          )
          .returning({ id: playersTable.id }),
    orgLeagueIds.length === 0
      ? Promise.resolve([] as { id: number }[])
      : db.update(leagueMembersTable)
          .set({ userId })
          .where(
            and(
              sql`${leagueMembersTable.email} = ${user.email}`,
              sql`(${leagueMembersTable.userId} IS NULL OR ${leagueMembersTable.userId} != ${userId})`,
              inArray(leagueMembersTable.leagueId, orgLeagueIds)
            )
          )
          .returning({ id: leagueMembersTable.id }),
  ]);

  res.json({
    message: `Synced ${updatedPlayers.length} tournament record(s) and ${updatedLeagues.length} league record(s).`,
    playerRecordsLinked: updatedPlayers.length,
    leagueRecordsLinked: updatedLeagues.length,
  });
});

export default router;
