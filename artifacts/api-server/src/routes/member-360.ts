/**
 * Member Management 360 — admin endpoints (Task #166).
 * Mounted at /api/organizations/:orgId/members-360.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import PDFDocument from "pdfkit";
import archiver from "archiver";

const orgIdOf = (req: Request) => parseInt(String((req.params as Record<string, string>).orgId));
const memberIdOf = (req: Request) => parseInt(String((req.params as Record<string, string>).memberId));

import { db } from "@workspace/db";
import {
  clubMembersTable, membershipTiersTable, memberSubscriptionsTable,
  memberProfileExtTable, memberDocumentsTable, memberDocumentVersionsTable, memberConsentsTable,
  memberCommPrefsTable, memberFamilyLinksTable, memberLifecycleEventsTable,
  memberDisciplinaryTable, memberInternalNotesTable, memberAuditLogTable,
  memberLeviesTable, memberLevyChargesTable, memberLevyChargeEventsTable, memberLevyChargePaymentsTable, memberLevyReceiptAttemptsTable, memberMilestonesTable,
  levyLedgerEmailSchedulesTable, levyLedgerEmailRunsTable,
  levyLedgerEmailOrgSchedulesTable, levyLedgerEmailOrgRunsTable,
  revenueByCurrencyEmailSchedulesTable, revenueByCurrencyEmailRunsTable,
  emailSuppressionsTable,
  memberAccessCardsTable, memberAccessLogTable, memberCommitteeRolesTable,
  memberSavedSegmentsTable, memberMessagesTable, memberDataRequestsTable,
  memberAccountChargesTable, storeCreditAccountsTable, storeCreditTransactionsTable,
  loyaltyAccountsTable, lockerAssignmentsTable, lockersTable,
  generalPlayRoundsTable, playersTable, tournamentsTable,
  appUsersTable, organizationsTable,
  financialLedgerTable,
  bracketMatchesTable, matchPlayBracketTable,
} from "@workspace/db";
import { eq, and, desc, asc, inArray, isNull, isNotNull, sql, count, ilike, like, gte, lte, or, aliasedTable } from "drizzle-orm";
import { recordMemberAudit, diffObjects } from "../lib/auditMember";
import { orgMembershipsTable } from "@workspace/db";
import { MEMBER_ADMIN_MEMBERSHIP_ROLES } from "@workspace/member-admin-roles";
import type { DataRequestEmailKind } from "../lib/mailer";
import {
  notifyDataRequest, retryDataRequestPush, retryDataRequestSms, retryDataRequestWhatsapp,
  notifyHandlerAssigned,
  DATA_REQUEST_MAX_PUSH_ATTEMPTS, DATA_REQUEST_MAX_SMS_ATTEMPTS, DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS,
} from "../lib/dataRequestNotify";
import { notifyDocumentRejected } from "../lib/documentRejectedNotify";
import { notifyDocumentUnrejected } from "../lib/documentUnrejectedNotify";
import { sendBroadcast, type DeliveryStats } from "../lib/comms";
import { DATA_EXPORT_VALID_DAYS } from "../lib/dataExportRetention";
import {
  sendLevyReceipt,
  LEVY_RECEIPT_MAX_PUSH_ATTEMPTS, LEVY_RECEIPT_MAX_SMS_ATTEMPTS, LEVY_RECEIPT_MAX_WHATSAPP_ATTEMPTS,
  retryLevyReceiptPush, retryLevyReceiptSms, retryLevyReceiptWhatsapp,
} from "../lib/levyReceiptNotify";
import { sendLevyLedgerScheduleEmail, sendLevyLedgerPdfEmail, sendOrgLevyLedgerScheduleEmail, sendRevenueByCurrencyScheduleEmail, buildRevenueByCurrencyScheduleEmailContent, buildOrgLevyLedgerScheduleEmailContent } from "../lib/mailer";
import { getBouncedLeviesForOrg } from "../lib/levyBouncedReminders";
import { pauseSuppressedRecipients, type DigestPausedRecipientSnapshot } from "../lib/digestRecipientPause";
import { logger as baseLogger } from "../lib/logger";
import { retryFailedObjectStoragePurgeForMember, acknowledgeStuckErasureForMember, PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS, ERASURE_AUTO_RETRY_MAX_ATTEMPTS, CRON_CAPPED_NOTIFICATION_SOURCE, CONTROLLER_ACKNOWLEDGEMENT_SOURCE } from "../lib/cron";
import { pendingStorageDeletionsTable } from "@workspace/db";

const router: IRouter = Router({ mergeParams: true });

/**
 * Member-admin authorization. Member 360 surfaces handle PII (KYC, addresses,
 * GDPR data, internal notes, financial), so tournament_director is intentionally
 * excluded from this scope — only org_admin/super_admin and the scoped
 * membership-admin roles (membership_secretary, treasurer) qualify.
 */
async function requireMemberAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required." }); return false; }
  const user = req.user as { id: number; role?: string; organizationId?: number | null };
  if (user.role === "super_admin") return true;
  if (user.role === "org_admin" && user.organizationId === orgId) return true;
  // Per-club membership-derived admin roles. Allow-list lives in the shared
  // `@workspace/member-admin-roles` package so the client gates on web and
  // mobile (Task #2210) consume the exact same set; updating the constant
  // updates all three surfaces in lock-step.
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  if (m && (MEMBER_ADMIN_MEMBERSHIP_ROLES as readonly string[]).includes(m.role)) return true;
  res.status(403).json({ error: "You do not have member-admin access to this organization." });
  return false;
}

const LIFECYCLE_EVENT_TYPES = new Set([
  "join", "freeze", "unfreeze", "suspend", "reinstate", "resign",
  "deceased", "transfer", "tier_change", "renewal", "upgrade", "downgrade",
]);

// ─── Resend audit-row channel helpers (Task #1891) ────────────────────────
// Per-channel delivery status persisted by the data-request resend handler
// in `memberAuditLogTable.metadata.channels`. Surfaced by the per-member
// resend-history popover and (Task #1891) by the dashboard's stalled-export
// widget so admins can see whether the personal nudge actually went out
// before deciding to retry.
type ResendChannelDetail = { status: string; at: string | null; error: string | null };
type ResendChannelsByName = {
  email: ResendChannelDetail | null;
  inApp: ResendChannelDetail | null;
  push: ResendChannelDetail | null;
  sms: ResendChannelDetail | null;
};

function normalizeResendChannelDetail(raw: unknown): ResendChannelDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { status?: unknown; at?: unknown; error?: unknown };
  if (typeof r.status !== "string") return null;
  return {
    status: r.status,
    at: typeof r.at === "string" ? r.at : null,
    error: typeof r.error === "string" ? r.error : null,
  };
}

// Legacy fallback for audit rows persisted *before* the resend handler
// started writing structured `metadata.channels`. The reason text was always
// "<kind> notice resent — email:<s>, in_app:<s>, push:<s>, sms:<s>" so we
// can recover the per-channel status (but not the timestamp or error).
function parseResendChannelsFromReason(reason: string | null): ResendChannelsByName {
  const out: ResendChannelsByName = { email: null, inApp: null, push: null, sms: null };
  if (!reason) return out;
  for (const m of reason.matchAll(/(email|in_app|push|sms):([a-z_]+)/gi)) {
    const key = m[1].toLowerCase();
    const status = m[2].toLowerCase();
    const detail: ResendChannelDetail = { status, at: null, error: null };
    if (key === "email") out.email = detail;
    else if (key === "in_app") out.inApp = detail;
    else if (key === "push") out.push = detail;
    else if (key === "sms") out.sms = detail;
  }
  return out;
}

// Combined view: prefer the structured `metadata.channels` (which carries
// the per-channel timestamp + provider error), and fall back to parsing the
// legacy free-form reason string. Returns null when neither source produced
// any per-channel detail so callers can short-circuit rendering.
function extractResendChannels(
  metadata: unknown,
  reason: string | null,
): ResendChannelsByName | null {
  const meta = metadata as { channels?: Record<string, unknown> } | null;
  const metaChannels = meta?.channels;
  if (metaChannels && typeof metaChannels === "object") {
    const channels: ResendChannelsByName = {
      email: normalizeResendChannelDetail(metaChannels.email),
      inApp: normalizeResendChannelDetail(metaChannels.inApp),
      push: normalizeResendChannelDetail(metaChannels.push),
      sms: normalizeResendChannelDetail(metaChannels.sms),
    };
    if (channels.email || channels.inApp || channels.push || channels.sms) {
      return channels;
    }
  }
  const fallback = parseResendChannelsFromReason(reason);
  if (fallback.email || fallback.inApp || fallback.push || fallback.sms) {
    return fallback;
  }
  return null;
}
const COMM_PREF_CATEGORIES = new Set([
  "billing", "events", "tournaments", "newsletters", "marketing",
  "operations", "service", "social",
  // Regulatory category for mandatory data-protection notices (Task 190).
  // Controls whether push/SMS are used for privacy-request notices.
  "privacy",
]);
const DISCIPLINARY_CATEGORIES = new Set([
  "dress_code", "pace_of_play", "course_etiquette", "facility_misuse",
  "guest_policy", "billing", "harassment", "safety", "other",
]);
const DISCIPLINARY_SEVERITIES = new Set(["warning", "minor", "major", "suspension", "expulsion"]);

async function loadMember(orgId: number, memberId: number) {
  const [m] = await db.select().from(clubMembersTable)
    .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));
  return m ?? null;
}

/**
 * Param middleware — runs before any `/:memberId/*` handler.
 * Validates RBAC and enforces that the member belongs to the URL's orgId.
 * Closes IDOR: a downstream handler that only filters by clubMemberId can
 * no longer touch a member from another org because this middleware 404s.
 */
router.param("memberId", async (req: Request, res: Response, next, value) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String(value));
  if (!Number.isFinite(orgId) || !Number.isFinite(memberId)) {
    res.status(400).json({ error: "Invalid org or member id" }); return;
  }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const member = await loadMember(orgId, memberId);
  if (!member) { { res.status(404).json({ error: "Member not found in this organization" }); return; } }
  (req as Request & { member?: unknown }).member = member;
  next();
});

async function ensureExt(memberId: number, orgId: number) {
  const [existing] = await db.select().from(memberProfileExtTable)
    .where(eq(memberProfileExtTable.clubMemberId, memberId));
  if (existing) return existing;
  const [created] = await db.insert(memberProfileExtTable)
    .values({ clubMemberId: memberId, organizationId: orgId })
    .returning();
  return created;
}

// ─── 360° SUMMARY ────────────────────────────────────────────────────────────

router.get("/:memberId/360", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);

  const member = await loadMember(orgId, memberId);
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }

  const ext = await ensureExt(memberId, orgId);
  const [tier] = member.tierId
    ? await db.select().from(membershipTiersTable).where(eq(membershipTiersTable.id, member.tierId))
    : [null];
  const [sub] = await db.select().from(memberSubscriptionsTable)
    .where(eq(memberSubscriptionsTable.clubMemberId, memberId))
    .orderBy(desc(memberSubscriptionsTable.createdAt)).limit(1);

  const [docCount] = await db.select({ c: count() }).from(memberDocumentsTable)
    .where(eq(memberDocumentsTable.clubMemberId, memberId));
  const [consentCount] = await db.select({ c: count() }).from(memberConsentsTable)
    .where(eq(memberConsentsTable.clubMemberId, memberId));
  const [familyCount] = await db.select({ c: count() }).from(memberFamilyLinksTable)
    .where(eq(memberFamilyLinksTable.primaryMemberId, memberId));
  const [discCount] = await db.select({ c: count() }).from(memberDisciplinaryTable)
    .where(and(eq(memberDisciplinaryTable.clubMemberId, memberId), eq(memberDisciplinaryTable.status, "open")));
  const [openLevies] = await db.select({ c: count() }).from(memberLevyChargesTable)
    .where(and(
      eq(memberLevyChargesTable.clubMemberId, memberId),
      inArray(memberLevyChargesTable.status, ["unpaid", "partial"]),
    ));

  // Financial: outstanding charges + store credit
  const charges = await db.select().from(memberAccountChargesTable)
    .where(eq(memberAccountChargesTable.clubMemberId, memberId));
  const outstanding = charges.reduce((s, c) =>
    c.isSettled ? s : s + parseFloat(String(c.amount ?? "0")), 0);
  const [credit] = await db.select().from(storeCreditAccountsTable)
    .where(and(eq(storeCreditAccountsTable.memberId, memberId), eq(storeCreditAccountsTable.organizationId, orgId)));
  const [loyalty] = member.userId
    ? await db.select().from(loyaltyAccountsTable)
      .where(and(eq(loyaltyAccountsTable.userId, member.userId), eq(loyaltyAccountsTable.organizationId, orgId)))
    : [null];

  // Activity counts (rounds + tournaments)
  const roundsCount = member.userId
    ? await db.select({ c: count() }).from(generalPlayRoundsTable)
      .where(and(eq(generalPlayRoundsTable.userId, member.userId), eq(generalPlayRoundsTable.organizationId, orgId)))
    : [{ c: 0 }];
  const tournPlayed = member.userId
    ? await db.select({ c: count() }).from(playersTable)
      .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
      .where(and(eq(playersTable.userId, member.userId), eq(tournamentsTable.organizationId, orgId)))
    : [{ c: 0 }];

  // Locker
  const [locker] = await db.select({
    id: lockerAssignmentsTable.id, lockerNumber: lockersTable.lockerNumber, expiryDate: lockerAssignmentsTable.expiryDate,
  }).from(lockerAssignmentsTable)
    .innerJoin(lockersTable, eq(lockerAssignmentsTable.lockerId, lockersTable.id))
    .where(and(eq(lockerAssignmentsTable.memberId, memberId), eq(lockerAssignmentsTable.status, "active")))
    .limit(1);

  // Active access cards
  const cards = await db.select().from(memberAccessCardsTable)
    .where(and(eq(memberAccessCardsTable.clubMemberId, memberId), eq(memberAccessCardsTable.isActive, true)));

  // Committee
  const committee = await db.select().from(memberCommitteeRolesTable)
    .where(and(eq(memberCommitteeRolesTable.clubMemberId, memberId),
      sql`(${memberCommitteeRolesTable.termEnd} IS NULL OR ${memberCommitteeRolesTable.termEnd} > now())`))
    .orderBy(desc(memberCommitteeRolesTable.termStart));

  res.json({
    member, ext, tier, subscription: sub,
    counts: {
      documents: Number(docCount?.c ?? 0),
      consents: Number(consentCount?.c ?? 0),
      familyLinks: Number(familyCount?.c ?? 0),
      openDisciplinary: Number(discCount?.c ?? 0),
      openLevies: Number(openLevies?.c ?? 0),
      roundsPlayed: Number(roundsCount[0]?.c ?? 0),
      tournamentsPlayed: Number(tournPlayed[0]?.c ?? 0),
    },
    financial: {
      outstandingBalance: outstanding.toFixed(2),
      storeCreditBalance: credit ? (credit.balancePaise / 100).toFixed(2) : "0.00",
      loyaltyPoints: loyalty?.pointsBalance ?? 0,
      loyaltyTier: loyalty?.currentTier ?? null,
      creditLimit: ext.creditLimit,
    },
    locker: locker ?? null,
    activeAccessCards: cards,
    activeCommittee: committee,
  });
});

// ─── EXTENDED PROFILE ────────────────────────────────────────────────────────

router.get("/:memberId/profile-ext", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const member = await loadMember(orgId, memberId);
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  const ext = await ensureExt(memberId, orgId);
  res.json(ext);
});

router.patch("/:memberId/profile-ext", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const member = await loadMember(orgId, memberId);
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }

  const before = await ensureExt(memberId, orgId);
  const body = req.body ?? {};
  const allowed: (keyof typeof memberProfileExtTable.$inferInsert)[] = [
    "middleName","preferredName","salutation","gender","pronouns","nationality","occupation","employer",
    "addressLine1","addressLine2","city","state","postalCode","country",
    "emergencyContactName","emergencyContactPhone","emergencyContactRelation",
    "preferredTee","dominantHand","preferredCart","shirtSize","shoeSize","glovesSize",
    "kycStatus","isVip","internalTags","twoFactorEnabled","twoFactorMethod",
    "joiningFee","refundableDeposit","creditLimit",
  ];
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of allowed) if (k in body) update[k] = body[k];
  if (body.kycStatus === "verified" && before.kycStatus !== "verified") {
    update.kycVerifiedAt = new Date();
    update.kycVerifiedByUserId = (req.user as { id: number }).id;
  }
  const [after] = await db.update(memberProfileExtTable).set(update)
    .where(eq(memberProfileExtTable.id, before.id)).returning();
  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: memberId,
    entity: "profile", entityId: before.id, action: "update",
    changes: diffObjects(before as Record<string, unknown>, after as Record<string, unknown>),
    reason: body.reason,
  });
  res.json(after);
});

// ─── DOCUMENTS ───────────────────────────────────────────────────────────────

router.get("/:memberId/documents", async (req: Request, res: Response) => {
  const memberId = memberIdOf(req);
  const statusQ = String(req.query.status ?? req.query.verified ?? "all").toLowerCase();
  const conds = [eq(memberDocumentsTable.clubMemberId, memberId)];
  if (statusQ === "true" || statusQ === "1" || statusQ === "verified") {
    conds.push(eq(memberDocumentsTable.isVerified, true));
  } else if (statusQ === "rejected") {
    conds.push(eq(memberDocumentsTable.isRejected, true));
  } else if (statusQ === "false" || statusQ === "0" || statusQ === "pending") {
    // Pending = not yet verified AND not rejected. Rejected docs are surfaced
    // separately so staff don't mistake them for items still awaiting review.
    conds.push(eq(memberDocumentsTable.isVerified, false));
    conds.push(eq(memberDocumentsTable.isRejected, false));
  }
  // Two left-joins on app_users via aliases so the UI can show both:
  //   - who originally uploaded the currently-live file (Task #228)
  //   - who rejected the document, when, and why (Task #240)
  const uploaderUsers = aliasedTable(appUsersTable, "uploaderUsers");
  const rejecterUsers = aliasedTable(appUsersTable, "rejecterUsers");
  const docs = await db.select({
    id: memberDocumentsTable.id,
    organizationId: memberDocumentsTable.organizationId,
    clubMemberId: memberDocumentsTable.clubMemberId,
    documentType: memberDocumentsTable.documentType,
    title: memberDocumentsTable.title,
    fileUrl: memberDocumentsTable.fileUrl,
    mimeType: memberDocumentsTable.mimeType,
    fileSize: memberDocumentsTable.fileSize,
    notes: memberDocumentsTable.notes,
    expiresAt: memberDocumentsTable.expiresAt,
    isVerified: memberDocumentsTable.isVerified,
    verifiedAt: memberDocumentsTable.verifiedAt,
    verifiedByUserId: memberDocumentsTable.verifiedByUserId,
    isRejected: memberDocumentsTable.isRejected,
    rejectedAt: memberDocumentsTable.rejectedAt,
    rejectedByUserId: memberDocumentsTable.rejectedByUserId,
    rejectionReason: memberDocumentsTable.rejectionReason,
    uploadedByUserId: memberDocumentsTable.uploadedByUserId,
    createdAt: memberDocumentsTable.createdAt,
    uploadedByDisplayName: uploaderUsers.displayName,
    uploadedByUsername: uploaderUsers.username,
    uploadedByEmail: uploaderUsers.email,
    rejectedByDisplayName: rejecterUsers.displayName,
    rejectedByUsername: rejecterUsers.username,
    rejectedByEmail: rejecterUsers.email,
  })
    .from(memberDocumentsTable)
    .leftJoin(uploaderUsers, eq(uploaderUsers.id, memberDocumentsTable.uploadedByUserId))
    .leftJoin(rejecterUsers, eq(rejecterUsers.id, memberDocumentsTable.rejectedByUserId))
    .where(and(...conds))
    .orderBy(desc(memberDocumentsTable.createdAt));

  // Task 329: surface a "previously rejected — withdrawn" inline note on docs
  // whose most recent audit action was a rejection withdrawal. Once a
  // withdrawal happens the doc row itself loses all rejection state, so
  // staff lose context unless we replay the audit log here. We pull the
  // latest audit row per doc id and only attach the indicator if that row
  // is a `rejection_withdrawn` event (so a subsequent verify or re-reject
  // suppresses the note naturally).
  const docIds = docs.map(d => d.id);
  const withdrawals = new Map<number, {
    withdrawnAt: string;
    withdrawnByUserId: number | null;
    withdrawnByName: string | null;
    previousReason: string | null;
    previousRejectedByUserId: number | null;
    previousRejectedByName: string | null;
    previousRejectedAt: string | null;
    withdrawalNote: string | null;
  }>();
  if (docIds.length > 0) {
    const auditActorUsers = aliasedTable(appUsersTable, "auditActorUsers");
    const auditRows = await db.select({
      entityId: memberAuditLogTable.entityId,
      reason: memberAuditLogTable.reason,
      metadata: memberAuditLogTable.metadata,
      createdAt: memberAuditLogTable.createdAt,
      actorUserId: memberAuditLogTable.actorUserId,
      actorName: memberAuditLogTable.actorName,
      actorDisplayName: auditActorUsers.displayName,
      actorUsername: auditActorUsers.username,
      actorEmail: auditActorUsers.email,
    })
      .from(memberAuditLogTable)
      .leftJoin(auditActorUsers, eq(auditActorUsers.id, memberAuditLogTable.actorUserId))
      .where(and(
        eq(memberAuditLogTable.entity, "document"),
        inArray(memberAuditLogTable.entityId, docIds),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id));

    type ParsedWithdrawal = {
      docId: number;
      withdrawnAt: Date;
      withdrawnByUserId: number | null;
      withdrawnByName: string | null;
      previousReason: string | null;
      previousRejectedByUserId: number | null;
      previousRejectedAt: string | null;
      withdrawalNote: string | null;
    };
    const seenLatest = new Set<number>();
    const parsed: ParsedWithdrawal[] = [];
    const origRejecterIds = new Set<number>();
    for (const r of auditRows) {
      const eid = r.entityId;
      if (eid == null || seenLatest.has(eid)) continue;
      seenLatest.add(eid);
      const md = r.metadata as Record<string, unknown> | null;
      const isWithdrawalByMeta = !!md && md.kind === "rejection_withdrawn";
      const isWithdrawalByReason = typeof r.reason === "string" && r.reason.startsWith("rejection withdrawn");
      if (!isWithdrawalByMeta && !isWithdrawalByReason) continue;

      let previousReason: string | null = null;
      let previousRejectedByUserId: number | null = null;
      let previousRejectedAt: string | null = null;
      let withdrawalNote: string | null = null;
      if (isWithdrawalByMeta) {
        previousReason = typeof md!.previousReason === "string" ? (md!.previousReason as string) : null;
        previousRejectedByUserId = typeof md!.previousRejectedByUserId === "number" ? (md!.previousRejectedByUserId as number) : null;
        previousRejectedAt = typeof md!.previousRejectedAt === "string" ? (md!.previousRejectedAt as string) : null;
        withdrawalNote = typeof md!.note === "string" ? (md!.note as string) : null;
      } else {
        // Fallback: parse the legacy reason string. Format:
        //   "rejection withdrawn — previous reason: X — previously rejected by user #N — previously rejected at <ISO> — note: Y"
        const reason = r.reason ?? "";
        const prevByMatch = reason.match(/previously rejected by user #(\d+)/);
        const prevAtMatch = reason.match(/previously rejected at (\S+)/);
        const noteMatch = reason.match(/(?: — |^)note: (.+)$/);
        const prevReasonMatch = reason.match(/previous reason: ([\s\S]+?)(?: — previously rejected by user #\d+| — previously rejected at \S+| — note: |$)/);
        previousReason = prevReasonMatch ? prevReasonMatch[1] : null;
        previousRejectedByUserId = prevByMatch ? parseInt(prevByMatch[1], 10) : null;
        previousRejectedAt = prevAtMatch ? prevAtMatch[1] : null;
        withdrawalNote = noteMatch ? noteMatch[1] : null;
      }
      if (previousRejectedByUserId != null) origRejecterIds.add(previousRejectedByUserId);
      parsed.push({
        docId: eid,
        withdrawnAt: r.createdAt,
        withdrawnByUserId: r.actorUserId,
        withdrawnByName: r.actorDisplayName ?? r.actorUsername ?? r.actorEmail ?? r.actorName ?? null,
        previousReason,
        previousRejectedByUserId,
        previousRejectedAt,
        withdrawalNote,
      });
    }

    const userMap = new Map<number, { displayName: string | null; username: string | null; email: string | null }>();
    if (origRejecterIds.size > 0) {
      const users = await db.select({
        id: appUsersTable.id,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        email: appUsersTable.email,
      }).from(appUsersTable).where(inArray(appUsersTable.id, [...origRejecterIds]));
      for (const u of users) userMap.set(u.id, u);
    }

    for (const p of parsed) {
      const u = p.previousRejectedByUserId != null ? userMap.get(p.previousRejectedByUserId) ?? null : null;
      const previousRejectedByName = u
        ? (u.displayName ?? u.username ?? u.email ?? `User #${p.previousRejectedByUserId}`)
        : (p.previousRejectedByUserId != null ? `User #${p.previousRejectedByUserId}` : null);
      withdrawals.set(p.docId, {
        withdrawnAt: p.withdrawnAt.toISOString(),
        withdrawnByUserId: p.withdrawnByUserId,
        withdrawnByName: p.withdrawnByName,
        previousReason: p.previousReason,
        previousRejectedByUserId: p.previousRejectedByUserId,
        previousRejectedByName,
        previousRejectedAt: p.previousRejectedAt,
        withdrawalNote: p.withdrawalNote,
      });
    }
  }

  const docsWithWithdrawal = docs.map(d => ({
    ...d,
    withdrawnRejection: withdrawals.get(d.id) ?? null,
  }));
  res.json(docsWithWithdrawal);
});

// Org-wide list of open privacy / data-subject requests — powers the admin
// dashboard "Privacy requests" widget (Task #178). Returns every member_data_request
// whose status is not completed/rejected, with the related member name + number
// joined in so the dashboard can render rows without fan-out fetching. Sorted by
// due date ascending (overdue first), then by requestedAt as a stable tiebreaker.
//
// Task #217: also surfaces the assigned handler (handlerUserId + display name)
// and supports `?assignedToMe=true` so admins can filter the queue down to the
// rows they personally own.
router.get("/data-requests/open", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const assignedToMe = String(req.query.assignedToMe ?? "") === "true";
  const currentUserId = (req.user as { id: number }).id;

  // Task #777: include rows that are still open OR have a recent
  // self-serve "completed_export" notice. Self-serve exports complete
  // synchronously and flip the request to status='completed', so the old
  // open-only filter would hide every export-ready notice from the
  // controller dashboard. We bound the export-ready window to the
  // signed-URL validity (DATA_EXPORT_VALID_DAYS) so the list stays small.
  const exportRecentSince = new Date(Date.now() - DATA_EXPORT_VALID_DAYS * 24 * 60 * 60 * 1000);
  const conds = [
    eq(memberDataRequestsTable.organizationId, orgId),
    or(
      sql`${memberDataRequestsTable.status} NOT IN ('completed', 'rejected')`,
      and(
        eq(memberDataRequestsTable.status, "completed"),
        // Task #777 + Task #922: surface both the original "Export ready"
        // notice and the follow-up "Export expiring" reminder so admins can
        // see the lifecycle of the same archive without drilling in.
        inArray(memberDataRequestsTable.lastNotificationKind, [
          "completed_export",
          "export_expiring",
        ]),
        gte(memberDataRequestsTable.lastNotifiedAt, exportRecentSince),
      ),
    )!,
  ];
  if (assignedToMe) {
    conds.push(eq(memberDataRequestsTable.handlerUserId, currentUserId));
  }

  const rows = await db.select({
    id: memberDataRequestsTable.id,
    clubMemberId: memberDataRequestsTable.clubMemberId,
    requestType: memberDataRequestsTable.requestType,
    status: memberDataRequestsTable.status,
    requestedAt: memberDataRequestsTable.requestedAt,
    dueBy: memberDataRequestsTable.dueBy,
    notes: memberDataRequestsTable.notes,
    handlerUserId: memberDataRequestsTable.handlerUserId,
    handlerDisplayName: appUsersTable.displayName,
    handlerUsername: appUsersTable.username,
    handlerEmail: appUsersTable.email,
    memberFirstName: clubMembersTable.firstName,
    memberLastName: clubMembersTable.lastName,
    memberNumber: clubMembersTable.memberNumber,
    // Per-channel push/SMS retry telemetry (Task #232) so the dashboard
    // privacy widget can surface attempt counts and "exhausted" state inline
    // without drilling into Member 360.
    lastPushStatus: memberDataRequestsTable.lastPushStatus,
    lastSmsStatus: memberDataRequestsTable.lastSmsStatus,
    lastWhatsappStatus: memberDataRequestsTable.lastWhatsappStatus,
    pushAttempts: memberDataRequestsTable.pushAttempts,
    smsAttempts: memberDataRequestsTable.smsAttempts,
    whatsappAttempts: memberDataRequestsTable.whatsappAttempts,
    pushRetryExhaustedAt: memberDataRequestsTable.pushRetryExhaustedAt,
    smsRetryExhaustedAt: memberDataRequestsTable.smsRetryExhaustedAt,
    whatsappRetryExhaustedAt: memberDataRequestsTable.whatsappRetryExhaustedAt,
    // Task #777: surface the latest notification template kind so the
    // controller dashboard can render a dedicated "Export ready" badge and
    // filter for the new `completed_export` notice without drilling into
    // Member 360.
    lastNotificationKind: memberDataRequestsTable.lastNotificationKind,
    lastNotifiedAt: memberDataRequestsTable.lastNotifiedAt,
  })
    .from(memberDataRequestsTable)
    .innerJoin(clubMembersTable, eq(clubMembersTable.id, memberDataRequestsTable.clubMemberId))
    .leftJoin(appUsersTable, eq(appUsersTable.id, memberDataRequestsTable.handlerUserId))
    .where(and(...conds))
    .orderBy(
      sql`${memberDataRequestsTable.dueBy} ASC NULLS LAST`,
      asc(memberDataRequestsTable.requestedAt),
    );

  const now = Date.now();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  let overdue = 0;
  let dueSoon = 0;
  let exportReady = 0;
  let exportExpiring = 0;
  let openCount = 0;
  for (const r of rows) {
    // Task #777: completed export-ready rows are surfaced for visibility
    // but should not inflate the open/overdue/due-soon KPIs which track
    // outstanding work.
    if (r.status !== "completed" && r.status !== "rejected") {
      openCount += 1;
      if (r.dueBy) {
        const days = Math.ceil((new Date(r.dueBy).getTime() - now) / MS_PER_DAY);
        if (days < 0) overdue += 1;
        else if (days <= 7) dueSoon += 1;
      }
    }
    if (r.lastNotificationKind === "completed_export") exportReady += 1;
    // Task #922: track the follow-up "expires in 24h" nudge as its own KPI
    // so admins can see at-a-glance how many archives are at risk of being
    // purged unread, mirroring the Task #777 exportReady tile.
    if (r.lastNotificationKind === "export_expiring") exportExpiring += 1;
  }

  // Task #284: surface an "unread assignment" indicator per row plus a
  // top-level count of newly-assigned (un-acknowledged) requests for the
  // viewer. The handler-assigned in-app message (Task #249) is the source of
  // truth: a request is "unread for the current handler" iff the latest
  // `data_request_handler_assigned` message linked to it has `read_at IS
  // NULL`. Reassignment writes a new message row so older notices for prior
  // handlers don't pollute the new owner's count.
  const requestIds = rows.map(r => r.id);
  const unreadRequestIds = new Set<number>();
  if (requestIds.length > 0) {
    const msgs = await db.select({
      requestId: memberMessagesTable.relatedEntityId,
      readAt: memberMessagesTable.readAt,
    }).from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.relatedEntity, "data_request_handler_assigned"),
        inArray(memberMessagesTable.relatedEntityId, requestIds),
      ))
      .orderBy(desc(memberMessagesTable.id));
    const seen = new Set<number>();
    for (const m of msgs) {
      const rid = m.requestId;
      if (rid == null || seen.has(rid)) continue;
      seen.add(rid);
      if (m.readAt == null) unreadRequestIds.add(rid);
    }
  }

  const enrichedRows = rows.map(r => ({
    ...r,
    assignmentUnread: r.handlerUserId === currentUserId && unreadRequestIds.has(r.id),
  }));
  const unreadAssignedToMe = enrichedRows.reduce(
    (n, r) => n + (r.assignmentUnread ? 1 : 0),
    0,
  );

  res.json({
    counts: { open: openCount, overdue, dueSoon, exportReady, exportExpiring },
    requests: enrichedRows,
    unreadAssignedToMe,
    maxPushAttempts: DATA_REQUEST_MAX_PUSH_ATTEMPTS,
    maxSmsAttempts: DATA_REQUEST_MAX_SMS_ATTEMPTS,
    maxWhatsappAttempts: DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS,
  });
});

// ─── Controller "export-expiring reminder open-rate" widget (Task #1124) ───
// Surfaces the open + click rate of the `export_expiring` courtesy notice
// so admins can judge whether the 24h-before reminder is actually being
// read before the archive is auto-purged. A low open rate suggests the
// notice isn't reducing the rate at which members re-request a fresh
// export the next day, and may warrant a delivery-channel rethink (e.g.
// promote push/SMS over email).
//
// Window defaults to the last 30 days (bounded 1..365). Counts are over
// the rows that actually had the notice dispatched (`expiringReminder
// TrackingToken IS NOT NULL`) — the older rows that pre-date Task #1124
// are excluded so the rate isn't artificially deflated by historical
// notices that never had a pixel embedded.
//
// Task #1298 — privacy-aware accounting. The pixel handler classifies
// fetches it believes came from a privacy-protecting mail proxy (Apple
// Mail Privacy Protection, GoogleImageProxy, YahooMailProxy, DNT/Sec-GPC
// signals, etc.) into `expiringReminderEmailPrefetchedAt` instead of
// `expiringReminderEmailOpenedAt`. Counting prefetches as opens
// inflates the open rate, so by default this endpoint excludes rows
// where only the prefetch timestamp is set. Pass `?includePrefetches=1`
// to fold prefetches back in (audit/debug only). The `prefetched` count
// is always returned so admins can see how much the heuristic caught.
router.get("/data-requests/expiring-reminder-stats", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const daysRaw = parseInt(String(req.query.days ?? "30"), 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? daysRaw : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Admin toggle — accept any of the common truthy spellings so the
  // dashboard URL is forgiving regardless of how the toggle component
  // serialises its state.
  const includePrefetchesRaw = String(req.query.includePrefetches ?? "").toLowerCase();
  const includePrefetches = includePrefetchesRaw === "1"
    || includePrefetchesRaw === "true"
    || includePrefetchesRaw === "yes";

  // When the admin opts in to including prefetches, fold the prefetch
  // timestamp back into the "opened" count via COALESCE so a row that
  // has only `prefetchedAt` set still counts as an open. The `prefetched`
  // count is always reported so the dashboard can show how many of the
  // visible opens were actually prefetches (and how many real opens were
  // suppressed by default).
  const openedExpr = includePrefetches
    ? sql<number>`COUNT(*) FILTER (WHERE ${memberDataRequestsTable.expiringReminderEmailOpenedAt} IS NOT NULL OR ${memberDataRequestsTable.expiringReminderEmailPrefetchedAt} IS NOT NULL)`
    : sql<number>`COUNT(*) FILTER (WHERE ${memberDataRequestsTable.expiringReminderEmailOpenedAt} IS NOT NULL)`;

  const [agg] = await db.select({
    sent: count(memberDataRequestsTable.id),
    opened: openedExpr,
    prefetched: sql<number>`COUNT(*) FILTER (WHERE ${memberDataRequestsTable.expiringReminderEmailPrefetchedAt} IS NOT NULL)`,
    clicked: sql<number>`COUNT(*) FILTER (WHERE ${memberDataRequestsTable.expiringReminderEmailClickedAt} IS NOT NULL)`,
  })
    .from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.organizationId, orgId),
      // Only count notices that were *actually* dispatched (the cron
      // stamps `expiringNoticeSentAt` when it hands off to notifyData
      // Request) and within the requested window.
      sql`${memberDataRequestsTable.expiringNoticeSentAt} IS NOT NULL`,
      gte(memberDataRequestsTable.expiringNoticeSentAt, since),
      // Exclude pre-Task-#1124 rows that never had a tracking pixel —
      // including them would deflate the open rate with notices that
      // could never have stamped an open in the first place.
      sql`${memberDataRequestsTable.expiringReminderTrackingToken} IS NOT NULL`,
    ));

  const sent = Number(agg?.sent ?? 0);
  const opened = Number(agg?.opened ?? 0);
  const prefetched = Number(agg?.prefetched ?? 0);
  const clicked = Number(agg?.clicked ?? 0);
  const openRate = sent > 0 ? opened / sent : null;
  const clickRate = sent > 0 ? clicked / sent : null;

  // Task #1890 — daily breakdown for the inline sparkline. We always
  // emit `opened` as the *real* (non-prefetched) opens and `prefetched`
  // separately so the dashboard can render the prefetched portion as a
  // visually-distinct stacked area regardless of the includePrefetches
  // toggle (which only affects the headline rate). The same eligibility
  // filters as the aggregate apply (sent + tracking token + window +
  // org scope), so the per-day counts are guaranteed to roll up to the
  // headline numbers above.
  const dailyRows = await db.select({
    day: sql<string>`to_char(date_trunc('day', ${memberDataRequestsTable.expiringNoticeSentAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
    sent: count(memberDataRequestsTable.id),
    opened: sql<number>`COUNT(*) FILTER (WHERE ${memberDataRequestsTable.expiringReminderEmailOpenedAt} IS NOT NULL)`,
    prefetched: sql<number>`COUNT(*) FILTER (WHERE ${memberDataRequestsTable.expiringReminderEmailPrefetchedAt} IS NOT NULL)`,
    clicked: sql<number>`COUNT(*) FILTER (WHERE ${memberDataRequestsTable.expiringReminderEmailClickedAt} IS NOT NULL)`,
  })
    .from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.organizationId, orgId),
      sql`${memberDataRequestsTable.expiringNoticeSentAt} IS NOT NULL`,
      gte(memberDataRequestsTable.expiringNoticeSentAt, since),
      sql`${memberDataRequestsTable.expiringReminderTrackingToken} IS NOT NULL`,
    ))
    .groupBy(sql`date_trunc('day', ${memberDataRequestsTable.expiringNoticeSentAt} AT TIME ZONE 'UTC')`)
    .orderBy(sql`date_trunc('day', ${memberDataRequestsTable.expiringNoticeSentAt} AT TIME ZONE 'UTC')`);

  // Pad missing days with zero buckets so the sparkline reads as a
  // continuous timeline (otherwise a streak of quiet days would
  // collapse and an admin couldn't tell a quiet week from a recent
  // outage). Buckets are keyed by UTC calendar date, matching the
  // `AT TIME ZONE 'UTC'` truncation above.
  const byDay = new Map<string, { sent: number; opened: number; prefetched: number; clicked: number }>();
  for (const r of dailyRows) {
    byDay.set(r.day, {
      sent: Number(r.sent ?? 0),
      opened: Number(r.opened ?? 0),
      prefetched: Number(r.prefetched ?? 0),
      clicked: Number(r.clicked ?? 0),
    });
  }
  const today = new Date();
  const startUTC = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate());
  const endUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daily: { date: string; sent: number; opened: number; prefetched: number; clicked: number }[] = [];
  for (let t = startUTC; t <= endUTC; t += 24 * 60 * 60 * 1000) {
    const d = new Date(t);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const b = byDay.get(key) ?? { sent: 0, opened: 0, prefetched: 0, clicked: 0 };
    daily.push({ date: key, ...b });
  }

  res.json({
    windowDays: days,
    since: since.toISOString(),
    sent,
    opened,
    prefetched,
    clicked,
    openRate,
    clickRate,
    includePrefetches,
    daily,
  });
});

// ─── Controller "stalled expiring reminders" drill-down (Task #1297) ────────
// Sibling to `/data-requests/expiring-reminder-stats` (Task #1124), but
// surfaces *which* members opened the courtesy reminder and then never
// came back to download their archive — exactly the cohort most at risk
// of being auto-purged. The aggregate widget tells admins "X% opened the
// reminder"; this list lets them act on the members behind that number
// before the daily purger runs.
//
// Eligibility (per row, all conjunctive):
//   • requestType = 'access' AND status = 'completed'         (export rows)
//   • expiringReminderEmailOpenedAt IS NOT NULL               (they saw it)
//   • artifactDownloadedAt IS NULL                            (still stalled)
//   • artifactUrl IS NOT NULL                                 (not yet purged)
//   • resolvedAt > now - DATA_EXPORT_VALID_DAYS days          (signed URL
//     still works — a nudge after the link has died is just noise; the
//     purge cron will drop the row off this list shortly afterwards).
//   • organizationId = :orgId                                 (scoped)
//
// Filters (`?filter=` query):
//   • 'all'         (default) — every stalled opened-not-downloaded row.
//   • 'opened-only' — opened but never clicked the download CTA. Most
//     likely passive readers who skimmed the email and forgot.
//   • 'clicked'     — clicked the CTA but the signed URL never landed
//     a download. More urgent: they tried but something blocked them
//     (browser issue, rotated session, expired tab, etc).
//
// Each row carries enough context to drive a personal nudge from the
// existing `POST /:memberId/data-requests/:id/resend` endpoint without a
// second round-trip: member name + number + email, when the reminder was
// opened/clicked, and when the archive will be purged.
router.get("/data-requests/expiring-reminder-stalled", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const filterRaw = String(req.query.filter ?? "all").toLowerCase();
  const filter: "all" | "opened-only" | "clicked" =
    filterRaw === "opened-only" || filterRaw === "clicked" ? filterRaw : "all";

  // Archive lifetime (signed URL validity). Mirrors the purge cron in
  // `lib/cron.ts` so a row drops off this list at the same instant the
  // daily purger would remove the file from object storage.
  const validityCutoff = new Date(
    Date.now() - DATA_EXPORT_VALID_DAYS * 24 * 60 * 60 * 1000,
  );

  const baseConds = [
    eq(memberDataRequestsTable.organizationId, orgId),
    eq(memberDataRequestsTable.requestType, "access"),
    eq(memberDataRequestsTable.status, "completed"),
    sql`${memberDataRequestsTable.expiringReminderEmailOpenedAt} IS NOT NULL`,
    isNull(memberDataRequestsTable.artifactDownloadedAt),
    sql`${memberDataRequestsTable.artifactUrl} IS NOT NULL`,
    sql`${memberDataRequestsTable.resolvedAt} IS NOT NULL`,
    gte(memberDataRequestsTable.resolvedAt, validityCutoff),
  ];

  const conds = [...baseConds];
  if (filter === "opened-only") {
    conds.push(isNull(memberDataRequestsTable.expiringReminderEmailClickedAt));
  } else if (filter === "clicked") {
    conds.push(sql`${memberDataRequestsTable.expiringReminderEmailClickedAt} IS NOT NULL`);
  }

  const rows = await db.select({
    id: memberDataRequestsTable.id,
    clubMemberId: memberDataRequestsTable.clubMemberId,
    memberFirstName: clubMembersTable.firstName,
    memberLastName: clubMembersTable.lastName,
    memberNumber: clubMembersTable.memberNumber,
    memberEmail: clubMembersTable.email,
    resolvedAt: memberDataRequestsTable.resolvedAt,
    expiringNoticeSentAt: memberDataRequestsTable.expiringNoticeSentAt,
    expiringReminderEmailOpenedAt: memberDataRequestsTable.expiringReminderEmailOpenedAt,
    expiringReminderEmailClickedAt: memberDataRequestsTable.expiringReminderEmailClickedAt,
    lastNotificationKind: memberDataRequestsTable.lastNotificationKind,
    lastNotifiedAt: memberDataRequestsTable.lastNotifiedAt,
  })
    .from(memberDataRequestsTable)
    .innerJoin(clubMembersTable, eq(clubMembersTable.id, memberDataRequestsTable.clubMemberId))
    .where(and(...conds))
    // Most-recently-opened first so admins see the freshest at-risk
    // archives at the top, with id as a stable tiebreaker.
    .orderBy(
      desc(memberDataRequestsTable.expiringReminderEmailOpenedAt),
      asc(memberDataRequestsTable.id),
    );

  // Counts are computed against the unfiltered eligibility surface so the
  // filter tabs can show the per-bucket totals without a second query.
  const [tally] = await db.select({
    total: count(memberDataRequestsTable.id),
    openedOnly: sql<number>`COUNT(*) FILTER (WHERE ${memberDataRequestsTable.expiringReminderEmailClickedAt} IS NULL)`,
    clicked: sql<number>`COUNT(*) FILTER (WHERE ${memberDataRequestsTable.expiringReminderEmailClickedAt} IS NOT NULL)`,
  })
    .from(memberDataRequestsTable)
    .where(and(...baseConds));

  // Task #1528 — join the latest resend audit row per request so the widget
  // can show "Nudged Xm ago by Asha" inline. Two admins working in parallel
  // could otherwise double-nudge the same member within minutes (a poor
  // experience for the member and harder to reason about). The "Send nudge"
  // button reuses POST .../resend, which records an audit row with
  // entity='data_request_notification', action='resend', entityId=requestId
  // — the same shape the per-member resend-history popover already reads.
  const requestIds = rows.map((r) => r.id);
  const lastNudgeByRequestId = new Map<number, {
    at: string;
    by: string | null;
    // Task #1891 — per-channel delivery status from the latest resend's
    // `metadata.channels` (or the legacy reason fallback). Null when the
    // audit row carried no channel detail at all.
    channels: ResendChannelsByName | null;
  }>();
  if (requestIds.length > 0) {
    const auditActorUsers = aliasedTable(appUsersTable, "stalledNudgeActorUsers");
    const nudgeRows = await db.select({
      entityId: memberAuditLogTable.entityId,
      createdAt: memberAuditLogTable.createdAt,
      actorName: memberAuditLogTable.actorName,
      actorDisplayName: auditActorUsers.displayName,
      actorUsername: auditActorUsers.username,
      actorEmail: auditActorUsers.email,
      // Task #1891 — pull metadata + reason so we can surface the per-
      // channel ✓/✗ row inline next to "Nudged Xm ago by Asha". Same
      // shape the resend-history popover already reads via
      // `extractResendChannels`.
      reason: memberAuditLogTable.reason,
      metadata: memberAuditLogTable.metadata,
    })
      .from(memberAuditLogTable)
      .leftJoin(auditActorUsers, eq(auditActorUsers.id, memberAuditLogTable.actorUserId))
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "data_request_notification"),
        eq(memberAuditLogTable.action, "resend"),
        inArray(memberAuditLogTable.entityId, requestIds),
      ))
      // Newest-first so the first hit per entityId wins.
      .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id));
    for (const r of nudgeRows) {
      if (r.entityId == null || lastNudgeByRequestId.has(r.entityId)) continue;
      lastNudgeByRequestId.set(r.entityId, {
        at: new Date(r.createdAt).toISOString(),
        // Prefer the live displayName (handles renames after the audit row
        // was written), then username/email, then the snapshot in
        // memberAuditLogTable.actorName captured at write time.
        by: r.actorDisplayName ?? r.actorUsername ?? r.actorEmail ?? r.actorName ?? null,
        channels: extractResendChannels(r.metadata, r.reason),
      });
    }
  }

  const purgeMs = DATA_EXPORT_VALID_DAYS * 24 * 60 * 60 * 1000;
  const items = rows.map((r) => {
    const nudge = lastNudgeByRequestId.get(r.id) ?? null;
    return {
      ...r,
      // Materialise the purge instant (resolvedAt + retention window) so the
      // UI can render a countdown without re-implementing the constant.
      purgesAt: r.resolvedAt
        ? new Date(new Date(r.resolvedAt).getTime() + purgeMs).toISOString()
        : null,
      // Task #1528 — most-recent admin-triggered resend, so the widget can
      // render "Nudged 12m ago by Asha" and the Send-nudge button can warn
      // before double-firing within a short window.
      lastNudgedAt: nudge?.at ?? null,
      lastNudgedByDisplayName: nudge?.by ?? null,
      // Task #1891 — per-channel delivery statuses from the latest resend
      // so the widget can show "✓ email · ✓ in-app · ✗ push" inline. Null
      // when there's no nudge yet, or when the audit row carried no
      // structured channel detail (legacy rows pre-metadata.channels with
      // a non-parseable reason).
      lastNudgedChannels: nudge?.channels ?? null,
    };
  });

  res.json({
    filter,
    validDays: DATA_EXPORT_VALID_DAYS,
    counts: {
      total: Number(tally?.total ?? 0),
      openedOnly: Number(tally?.openedOnly ?? 0),
      clicked: Number(tally?.clicked ?? 0),
    },
    items,
  });
});

// ─── Controller "consent health" dashboard (Task #381) ──────────────────────
// Aggregates the latest consent decision per member per consent type so club
// controllers can see, at a glance, opt-in rates across every data category
// (profile, scores, GPS, photos/video, health, social, AI, marketing). Also
// surfaces account-deletion grace-period totals so the controller can react
// before the deletion window elapses.
const CONSENT_HEALTH_TYPES = [
  "privacy", "terms",
  "marketing", "directory", "third_party_share",
  "photo", "video",
  "scores", "gps",
  "health_wellness",
  "social",
  "ai",
] as const;

router.get("/consent-health", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const [{ totalMembers = 0 } = {}] = await db.select({
    totalMembers: count(clubMembersTable.id),
  }).from(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));

  // Pull only the latest consent decision per (member, consentType).
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (club_member_id, consent_type)
      club_member_id, consent_type, granted, granted_at
    FROM ${memberConsentsTable}
    WHERE organization_id = ${orgId}
      AND consent_type IN (${sql.join(CONSENT_HEALTH_TYPES.map(t => sql`${t}`), sql`, `)})
    ORDER BY club_member_id, consent_type, granted_at DESC
  `);

  const tally: Record<string, { granted: number; withdrawn: number; recordedMembers: number }> = {};
  for (const t of CONSENT_HEALTH_TYPES) tally[t] = { granted: 0, withdrawn: 0, recordedMembers: 0 };
  // drizzle returns a result object; rows are on .rows for pg.
  const list = (rows as unknown as { rows: Array<{ consent_type: string; granted: boolean }> }).rows
    ?? (rows as unknown as Array<{ consent_type: string; granted: boolean }>);
  for (const r of list) {
    const t = r.consent_type;
    if (!tally[t]) continue;
    tally[t].recordedMembers += 1;
    if (r.granted) tally[t].granted += 1;
    else tally[t].withdrawn += 1;
  }
  const categories = CONSENT_HEALTH_TYPES.map(t => {
    const row = tally[t];
    const noDecision = Math.max(0, Number(totalMembers) - row.recordedMembers);
    const optInRate = totalMembers > 0 ? row.granted / Number(totalMembers) : 0;
    return {
      consentType: t,
      grantedMembers: row.granted,
      withdrawnMembers: row.withdrawn,
      noDecisionMembers: noDecision,
      optInRate: Number(optInRate.toFixed(4)),
    };
  });

  // Account deletions in grace period (filed but not yet resolved or past dueBy)
  const now = new Date();
  const deletions = await db.select({
    id: memberDataRequestsTable.id,
    clubMemberId: memberDataRequestsTable.clubMemberId,
    requestedAt: memberDataRequestsTable.requestedAt,
    dueBy: memberDataRequestsTable.dueBy,
    status: memberDataRequestsTable.status,
    memberFirstName: clubMembersTable.firstName,
    memberLastName: clubMembersTable.lastName,
    memberNumber: clubMembersTable.memberNumber,
  })
    .from(memberDataRequestsTable)
    .innerJoin(clubMembersTable, eq(clubMembersTable.id, memberDataRequestsTable.clubMemberId))
    .where(and(
      eq(memberDataRequestsTable.organizationId, orgId),
      eq(memberDataRequestsTable.requestType, "erasure"),
      sql`${memberDataRequestsTable.status} NOT IN ('completed', 'rejected')`,
    ))
    .orderBy(asc(memberDataRequestsTable.dueBy));

  const inGrace = deletions.filter(d => d.dueBy && new Date(d.dueBy).getTime() > now.getTime());
  const overdue = deletions.filter(d => d.dueBy && new Date(d.dueBy).getTime() <= now.getTime());

  // Self-serve data exports (Task #468). Report counts by computed status —
  // pending requests still need fulfillment, ready archives sit waiting for
  // download (7-day window after resolvedAt), and expired ones may indicate
  // a member who never collected their export. Only the most recent rows are
  // returned for the dashboard listing.
  const DATA_EXPORT_VALID_DAYS = 7;
  // Counts are aggregated server-side so the dashboard remains accurate at any
  // scale (the 50-row recent-rows query was previously the source of counts,
  // which silently under-reported once an org accumulated more than 50
  // exports). The detail rows themselves are still capped to the most recent
  // 20 — that's just for the UI table preview.
  const expiryCutoff = new Date(now.getTime() - DATA_EXPORT_VALID_DAYS * 24 * 60 * 60 * 1000);
  const [counts] = await db.select({
    pending: sql<number>`count(*) filter (where ${memberDataRequestsTable.status} not in ('completed','rejected'))`,
    ready: sql<number>`count(*) filter (where ${memberDataRequestsTable.status} = 'completed' and ${memberDataRequestsTable.resolvedAt} > ${expiryCutoff})`,
    expired: sql<number>`count(*) filter (where ${memberDataRequestsTable.status} = 'completed' and ${memberDataRequestsTable.resolvedAt} <= ${expiryCutoff})`,
    failed: sql<number>`count(*) filter (where ${memberDataRequestsTable.status} = 'rejected')`,
  })
    .from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.organizationId, orgId),
      eq(memberDataRequestsTable.requestType, "access"),
    ));
  const exportRows = await db.select({
    id: memberDataRequestsTable.id,
    clubMemberId: memberDataRequestsTable.clubMemberId,
    requestedAt: memberDataRequestsTable.requestedAt,
    resolvedAt: memberDataRequestsTable.resolvedAt,
    status: memberDataRequestsTable.status,
    artifactUrl: memberDataRequestsTable.artifactUrl,
    // Task #773: when the daily cron auto-deletes an expired archive it
    // stamps purgedAt so the dashboard can show the actual removal time
    // (not just the computed expiry against resolvedAt).
    purgedAt: memberDataRequestsTable.purgedAt,
    memberFirstName: clubMembersTable.firstName,
    memberLastName: clubMembersTable.lastName,
    memberNumber: clubMembersTable.memberNumber,
  })
    .from(memberDataRequestsTable)
    .innerJoin(clubMembersTable, eq(clubMembersTable.id, memberDataRequestsTable.clubMemberId))
    .where(and(
      eq(memberDataRequestsTable.organizationId, orgId),
      eq(memberDataRequestsTable.requestType, "access"),
    ))
    .orderBy(desc(memberDataRequestsTable.requestedAt))
    .limit(20);
  const decoratedExports = exportRows.map(r => {
    let computedStatus: "pending" | "ready" | "expired" | "failed";
    if (r.status === "rejected") computedStatus = "failed";
    else if (r.status !== "completed" || !r.resolvedAt) computedStatus = "pending";
    else {
      const ageMs = now.getTime() - new Date(r.resolvedAt).getTime();
      computedStatus = ageMs > DATA_EXPORT_VALID_DAYS * 24 * 60 * 60 * 1000 ? "expired" : "ready";
    }
    return { ...r, computedStatus };
  });
  const exportSummary = {
    pending: Number(counts?.pending ?? 0),
    ready: Number(counts?.ready ?? 0),
    expired: Number(counts?.expired ?? 0),
    failed: Number(counts?.failed ?? 0),
    rows: decoratedExports,
  };

  res.json({
    totalMembers: Number(totalMembers),
    categories,
    accountDeletions: {
      inGrace: inGrace.length,
      overdue: overdue.length,
      rows: deletions,
    },
    dataExports: exportSummary,
  });
});

// Org-wide list of documents pending verification — powers the admin "pending verification" queue.
router.get("/documents/pending", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const documentType = typeof req.query.documentType === "string" ? req.query.documentType.trim() : "";
  const memberSearch = typeof req.query.memberSearch === "string" ? req.query.memberSearch.trim() : "";
  // Uploader filter (Task 255) — narrows the queue to documents uploaded by a
  // specific staff/front-desk user. Accepts a numeric user id or a username
  // (case-insensitive) so callers can link by either handle.
  const uploadedByUserIdRaw = typeof req.query.uploadedByUserId === "string" ? req.query.uploadedByUserId.trim() : "";
  const uploadedByUsername = typeof req.query.uploadedByUsername === "string" ? req.query.uploadedByUsername.trim() : "";
  const uploadedByUserIdNum = uploadedByUserIdRaw && /^\d+$/.test(uploadedByUserIdRaw) ? parseInt(uploadedByUserIdRaw, 10) : null;
  const uploadedFromRaw = typeof req.query.uploadedFrom === "string" ? req.query.uploadedFrom : "";
  const uploadedToRaw = typeof req.query.uploadedTo === "string" ? req.query.uploadedTo : "";
  const uploadedFrom = uploadedFromRaw ? new Date(uploadedFromRaw) : null;
  const uploadedTo = uploadedToRaw ? new Date(uploadedToRaw) : null;
  if (uploadedTo && !Number.isNaN(uploadedTo.getTime())) {
    // Treat as inclusive end-of-day if a bare date was supplied.
    if (/^\d{4}-\d{2}-\d{2}$/.test(uploadedToRaw)) uploadedTo.setUTCHours(23, 59, 59, 999);
  }

  // "Waiting longer than" age preset (Task 224) — filters to documents whose
  // createdAt is older than the threshold so staff can quickly triage stale
  // items. Accepted values: 24h, 3d, 7d, 14d, 30d.
  const waitingLongerThanRaw = typeof req.query.waitingLongerThan === "string" ? req.query.waitingLongerThan.trim() : "";
  const WAITING_PRESETS: Record<string, number> = {
    "24h": 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "14d": 14 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  const waitingThresholdMs = WAITING_PRESETS[waitingLongerThanRaw];
  const waitingCutoff = waitingThresholdMs ? new Date(Date.now() - waitingThresholdMs) : null;

  // Sort toggle (Task 246) — staff can flip between newest-first (default) and
  // oldest-first to triage stale uploads. Sent to the API so it works for any
  // future paginated queue rather than just re-sorting the current page.
  const sortRaw = typeof req.query.sort === "string" ? req.query.sort.trim() : "";
  const sortOldestFirst = sortRaw === "oldest";

  const conds = [
    eq(memberDocumentsTable.organizationId, orgId),
    eq(memberDocumentsTable.isVerified, false),
    // Rejected documents (Task 209) are kept for audit but excluded from
    // the pending queue so the count badge reflects only docs awaiting review.
    eq(memberDocumentsTable.isRejected, false),
  ];
  if (documentType) conds.push(eq(memberDocumentsTable.documentType, documentType));
  if (memberSearch) {
    const like = `%${memberSearch}%`;
    const memberCond = or(
      ilike(clubMembersTable.firstName, like),
      ilike(clubMembersTable.lastName, like),
      ilike(clubMembersTable.memberNumber, like),
    );
    if (memberCond) conds.push(memberCond);
  }
  if (uploadedFrom && !Number.isNaN(uploadedFrom.getTime())) {
    conds.push(gte(memberDocumentsTable.createdAt, uploadedFrom));
  }
  if (uploadedTo && !Number.isNaN(uploadedTo.getTime())) {
    conds.push(lte(memberDocumentsTable.createdAt, uploadedTo));
  }
  if (waitingCutoff) {
    conds.push(lte(memberDocumentsTable.createdAt, waitingCutoff));
  }
  const uploaderUsers = aliasedTable(appUsersTable, "uploaderUsers");
  // Build the uploader options list from the queue *before* applying the
  // uploader filter itself, so the dropdown always shows every staff member
  // with pending uploads under the current other filters (date/type/etc).
  const uploaderOptionConds = [...conds];
  if (uploadedByUserIdNum !== null) {
    conds.push(eq(memberDocumentsTable.uploadedByUserId, uploadedByUserIdNum));
  } else if (uploadedByUsername) {
    conds.push(ilike(uploaderUsers.username, uploadedByUsername));
  }
  const rows = await db.select({
    id: memberDocumentsTable.id,
    clubMemberId: memberDocumentsTable.clubMemberId,
    documentType: memberDocumentsTable.documentType,
    title: memberDocumentsTable.title,
    fileUrl: memberDocumentsTable.fileUrl,
    mimeType: memberDocumentsTable.mimeType,
    fileSize: memberDocumentsTable.fileSize,
    expiresAt: memberDocumentsTable.expiresAt,
    uploadedByUserId: memberDocumentsTable.uploadedByUserId,
    uploadedByDisplayName: uploaderUsers.displayName,
    uploadedByUsername: uploaderUsers.username,
    uploadedByEmail: uploaderUsers.email,
    createdAt: memberDocumentsTable.createdAt,
    memberFirstName: clubMembersTable.firstName,
    memberLastName: clubMembersTable.lastName,
    memberNumber: clubMembersTable.memberNumber,
  })
    .from(memberDocumentsTable)
    .innerJoin(clubMembersTable, eq(clubMembersTable.id, memberDocumentsTable.clubMemberId))
    .leftJoin(uploaderUsers, eq(uploaderUsers.id, memberDocumentsTable.uploadedByUserId))
    .where(and(...conds))
    .orderBy(sortOldestFirst ? asc(memberDocumentsTable.createdAt) : desc(memberDocumentsTable.createdAt));

  // Distinct uploader options for the filter dropdown (Task 255). Built from
  // the queue ignoring the uploader filter so staff can switch between
  // uploaders without losing the option list.
  const uploaderRows = await db.selectDistinct({
    userId: appUsersTable.id,
    displayName: appUsersTable.displayName,
    username: appUsersTable.username,
    email: appUsersTable.email,
  })
    .from(memberDocumentsTable)
    .innerJoin(clubMembersTable, eq(clubMembersTable.id, memberDocumentsTable.clubMemberId))
    .innerJoin(appUsersTable, eq(appUsersTable.id, memberDocumentsTable.uploadedByUserId))
    .where(and(...uploaderOptionConds))
    .orderBy(asc(appUsersTable.displayName), asc(appUsersTable.username));

  res.json({ count: rows.length, documents: rows, uploaders: uploaderRows });
});

router.post("/:memberId/documents", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const { documentType, title, fileUrl, mimeType, fileSize, expiresAt, notes } = req.body;
  if (!documentType || !title || !fileUrl) { { res.status(400).json({ error: "documentType, title, fileUrl required" }); return; } }
  const [doc] = await db.insert(memberDocumentsTable).values({
    organizationId: orgId, clubMemberId: memberId,
    documentType, title, fileUrl, mimeType, fileSize,
    expiresAt: expiresAt ? new Date(expiresAt) : null, notes,
    uploadedByUserId: (req.user as { id: number }).id,
  }).returning();
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "document", entityId: doc.id, action: "create" });
  res.status(201).json(doc);
});

/**
 * Bulk verify several pending documents in one request (Task #225).
 *
 * Accepts a list of document ids and verifies each one independently. Errors
 * on individual documents (not found in this org, already verified, already
 * rejected) are collected and returned alongside the successes so the UI can
 * surface per-row failures without aborting the whole batch.
 *
 * Sits at the router root (no `:memberId`) because staff verify directly from
 * the org-wide pending queue, where each row may belong to a different member.
 * Org-scope is enforced by always filtering on `organizationId = :orgId`.
 */
router.post("/documents/verify-bulk", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const rawIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : null;
  if (!rawIds || rawIds.length === 0) {
    res.status(400).json({ error: "documentIds (non-empty array) is required." }); return;
  }
  if (rawIds.length > 200) {
    res.status(400).json({ error: "Cannot verify more than 200 documents in one request." }); return;
  }
  const ids: number[] = [];
  for (const v of rawIds) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  if (ids.length === 0) { { res.status(400).json({ error: "No valid documentIds supplied." }); return; } }

  const staffId = (req.user as { id: number }).id;
  const now = new Date();

  // Pre-load candidate rows so we can return precise per-row errors (not
  // found / already verified / already rejected) instead of failing silently.
  const existing = await db.select().from(memberDocumentsTable)
    .where(and(
      eq(memberDocumentsTable.organizationId, orgId),
      inArray(memberDocumentsTable.id, ids),
    ));
  const byId = new Map(existing.map((d) => [d.id, d]));

  const verified: typeof existing = [];
  const errors: Array<{ documentId: number; error: string }> = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) { errors.push({ documentId: id, error: "Document not found in this organization." }); continue; }
    if (row.isRejected) { errors.push({ documentId: id, error: "Document was rejected and cannot be verified." }); continue; }
    if (row.isVerified) { errors.push({ documentId: id, error: "Document is already verified." }); continue; }
    try {
      const [updated] = await db.update(memberDocumentsTable)
        .set({ isVerified: true, verifiedAt: now, verifiedByUserId: staffId })
        .where(and(
          eq(memberDocumentsTable.id, id),
          eq(memberDocumentsTable.organizationId, orgId),
          eq(memberDocumentsTable.isVerified, false),
          eq(memberDocumentsTable.isRejected, false),
        ))
        .returning();
      if (!updated) {
        errors.push({ documentId: id, error: "Document state changed before it could be verified." });
        continue;
      }
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: updated.clubMemberId,
        entity: "document", entityId: id, action: "update", reason: "verified (bulk)",
      });
      verified.push(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      baseLogger.error({ err: msg, docId: id }, "[member-360] bulk verify failed for document");
      errors.push({ documentId: id, error: "Internal error while verifying this document." });
    }
  }

  res.json({
    verifiedCount: verified.length,
    errorCount: errors.length,
    verified: verified.map((d) => ({ id: d.id, clubMemberId: d.clubMemberId })),
    errors,
  });
});

/**
 * Bulk-reject pending member documents in one request (Task #264).
 *
 * Mirrors the bulk-verify contract: a single staff-supplied reason is applied
 * to every selected document and shown to each affected member in the
 * rejection notification. Per-document failures (not found / wrong org /
 * already verified / already rejected / notification error) are captured
 * individually so the batch never aborts on the first bad row.
 *
 * The notification fan-out is awaited per row (best-effort, same as the
 * single-row endpoint) so the response can flag which members did not
 * receive the notice — the rejection itself stands either way.
 */
router.post("/documents/reject-bulk", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const rawIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : null;
  if (!rawIds || rawIds.length === 0) {
    res.status(400).json({ error: "documentIds (non-empty array) is required." }); return;
  }
  if (rawIds.length > 200) {
    res.status(400).json({ error: "Cannot reject more than 200 documents in one request." }); return;
  }
  const reasonRaw = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reasonRaw) { { res.status(400).json({ error: "A rejection reason is required so the member knows what to fix." }); return; } }
  if (reasonRaw.length > 1000) { { res.status(400).json({ error: "Rejection reason must be 1000 characters or fewer." }); return; } }

  const ids: number[] = [];
  for (const v of rawIds) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  if (ids.length === 0) { { res.status(400).json({ error: "No valid documentIds supplied." }); return; } }

  const staffId = (req.user as { id: number }).id;
  const now = new Date();

  const existing = await db.select().from(memberDocumentsTable)
    .where(and(
      eq(memberDocumentsTable.organizationId, orgId),
      inArray(memberDocumentsTable.id, ids),
    ));
  const byId = new Map(existing.map((d) => [d.id, d]));

  const rejected: Array<{ id: number; clubMemberId: number; notification: unknown }> = [];
  const errors: Array<{ documentId: number; error: string }> = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) { errors.push({ documentId: id, error: "Document not found in this organization." }); continue; }
    if (row.isVerified) { errors.push({ documentId: id, error: "Cannot reject a document that has already been verified." }); continue; }
    if (row.isRejected) { errors.push({ documentId: id, error: "Document is already rejected." }); continue; }
    try {
      const [updated] = await db.update(memberDocumentsTable)
        .set({
          isRejected: true,
          rejectedAt: now,
          rejectedByUserId: staffId,
          rejectionReason: reasonRaw,
        })
        .where(and(
          eq(memberDocumentsTable.id, id),
          eq(memberDocumentsTable.organizationId, orgId),
          eq(memberDocumentsTable.isVerified, false),
          eq(memberDocumentsTable.isRejected, false),
        ))
        .returning();
      if (!updated) {
        errors.push({ documentId: id, error: "Document state changed before it could be rejected." });
        continue;
      }
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: updated.clubMemberId,
        entity: "document", entityId: id, action: "update",
        reason: `rejected (bulk): ${reasonRaw}`,
      });
      const notification = await notifyDocumentRejected({
        organizationId: orgId,
        clubMemberId: updated.clubMemberId,
        document: updated,
        reason: reasonRaw,
        senderUserId: staffId,
      }).catch((err: unknown) => {
        baseLogger.error({ err: err instanceof Error ? err.message : String(err), docId: id }, "[member-360] document-rejected notification failed (bulk)");
        return { inAppMessageId: null as number | null, emailStatus: "failed" as const, pushStatus: "skipped" as const, smsStatus: "skipped" as const, whatsappStatus: "skipped" as const };
      });
      rejected.push({ id: updated.id, clubMemberId: updated.clubMemberId, notification });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      baseLogger.error({ err: msg, docId: id }, "[member-360] bulk reject failed for document");
      errors.push({ documentId: id, error: "Internal error while rejecting this document." });
    }
  }

  res.json({
    rejectedCount: rejected.length,
    errorCount: errors.length,
    rejected,
    errors,
  });
});

router.patch("/:memberId/documents/:docId/verify", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  const [doc] = await db.update(memberDocumentsTable)
    .set({ isVerified: true, verifiedAt: new Date(), verifiedByUserId: (req.user as { id: number }).id })
    .where(and(eq(memberDocumentsTable.id, docId), eq(memberDocumentsTable.clubMemberId, memberId)))
    .returning();
  if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "document", entityId: docId, action: "update", reason: "verified" });
  res.json(doc);
});

/**
 * Reject a pending member document with a reason (Task 209).
 *
 * Marks the document as rejected (kept for audit, not deleted) and notifies the
 * member via their preferred channels: an in-app message is always written, an
 * email is sent best-effort, and push/SMS are fanned out to members who have
 * opted in to the `operations` category in member_comm_prefs (KYC document
 * review is operational, not marketing).
 *
 * Rejected documents are excluded from the pending-verification queue and
 * count badge so the queue reflects only docs awaiting review.
 */
router.patch("/:memberId/documents/:docId/reject", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  const reasonRaw = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reasonRaw) { { res.status(400).json({ error: "A rejection reason is required so the member knows what to fix." }); return; } }
  if (reasonRaw.length > 1000) { { res.status(400).json({ error: "Rejection reason must be 1000 characters or fewer." }); return; } }

  const staffId = (req.user as { id: number }).id;

  // Load the document first so we can return a precise 4xx for already-handled
  // rows rather than silently no-op'ing the update.
  const [existing] = await db.select().from(memberDocumentsTable)
    .where(and(
      eq(memberDocumentsTable.id, docId),
      eq(memberDocumentsTable.clubMemberId, memberId),
      eq(memberDocumentsTable.organizationId, orgId),
    ));
  if (!existing) { { res.status(404).json({ error: "Document not found" }); return; } }
  if (existing.isVerified) { { res.status(409).json({ error: "Cannot reject a document that has already been verified." }); return; } }
  if (existing.isRejected) { { res.status(409).json({ error: "Document is already rejected." }); return; } }

  const [doc] = await db.update(memberDocumentsTable)
    .set({
      isRejected: true,
      rejectedAt: new Date(),
      rejectedByUserId: staffId,
      rejectionReason: reasonRaw,
    })
    .where(and(eq(memberDocumentsTable.id, docId), eq(memberDocumentsTable.clubMemberId, memberId)))
    .returning();
  if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }

  await recordMemberAudit({
    req,
    organizationId: orgId,
    clubMemberId: memberId,
    entity: "document",
    entityId: docId,
    action: "update",
    reason: `rejected: ${reasonRaw}`,
  });

  // Notify the member. Failures here must not block the rejection itself —
  // staff have already made the decision and the audit row is written. We
  // surface delivery info in the response so the UI can warn if needed.
  const notify = await notifyDocumentRejected({
    organizationId: orgId,
    clubMemberId: memberId,
    document: doc,
    reason: reasonRaw,
    senderUserId: staffId,
  }).catch((err: unknown) => {
    baseLogger.error({ err: err instanceof Error ? err.message : String(err), docId }, "[member-360] document-rejected notification failed");
    return { inAppMessageId: null as number | null, emailStatus: "failed" as const, pushStatus: "skipped" as const, smsStatus: "skipped" as const, whatsappStatus: "skipped" as const };
  });

  res.json({ ...doc, notification: notify });
});

/**
 * Withdraw a previous rejection on a member document (Task 257).
 *
 * Rejection was previously terminal — once a doc was rejected the only path
 * forward was for the member to re-upload. Staff who reject by mistake had no
 * way to clear the rejection, leaving an audit-only record visible to the
 * member. This endpoint clears the rejection state so the document goes back
 * into the pending-verification queue, audit-logs the un-reject (with the
 * original reason preserved in the audit row), and notifies the member that
 * the prior rejection was withdrawn. Reason is optional.
 */
router.patch("/:memberId/documents/:docId/unreject", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  const reasonRaw = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reasonRaw.length > 1000) { { res.status(400).json({ error: "Reason must be 1000 characters or fewer." }); return; } }

  const staffId = (req.user as { id: number }).id;

  const [existing] = await db.select().from(memberDocumentsTable)
    .where(and(
      eq(memberDocumentsTable.id, docId),
      eq(memberDocumentsTable.clubMemberId, memberId),
      eq(memberDocumentsTable.organizationId, orgId),
    ));
  if (!existing) { { res.status(404).json({ error: "Document not found" }); return; } }
  if (!existing.isRejected) { { res.status(409).json({ error: "Document is not currently rejected." }); return; } }

  const previousReason = existing.rejectionReason;
  const previousRejecter = existing.rejectedByUserId;
  const previousRejectedAt = existing.rejectedAt;

  const [doc] = await db.update(memberDocumentsTable)
    .set({
      isRejected: false,
      rejectedAt: null,
      rejectedByUserId: null,
      rejectionReason: null,
    })
    .where(and(eq(memberDocumentsTable.id, docId), eq(memberDocumentsTable.clubMemberId, memberId)))
    .returning();
  if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }

  const auditReason = [
    "rejection withdrawn",
    previousReason ? `previous reason: ${previousReason}` : null,
    previousRejecter ? `previously rejected by user #${previousRejecter}` : null,
    previousRejectedAt ? `previously rejected at ${new Date(previousRejectedAt).toISOString()}` : null,
    reasonRaw ? `note: ${reasonRaw}` : null,
  ].filter(Boolean).join(" — ");

  await recordMemberAudit({
    req,
    organizationId: orgId,
    clubMemberId: memberId,
    entity: "document",
    entityId: docId,
    action: "update",
    reason: auditReason,
    // Task 329: also stash the structured details so the documents listing
    // can surface a "previously rejected — withdrawn" inline note without
    // round-tripping the reason string. Older rows without metadata fall
    // back to parsing `reason`.
    metadata: {
      kind: "rejection_withdrawn",
      previousReason: previousReason ?? null,
      previousRejectedByUserId: previousRejecter ?? null,
      previousRejectedAt: previousRejectedAt ? new Date(previousRejectedAt).toISOString() : null,
      note: reasonRaw || null,
    },
  });

  const notify = await notifyDocumentUnrejected({
    organizationId: orgId,
    clubMemberId: memberId,
    document: doc,
    reason: reasonRaw || null,
    senderUserId: staffId,
  }).catch((err: unknown) => {
    baseLogger.error({ err: err instanceof Error ? err.message : String(err), docId }, "[member-360] document-unrejected notification failed");
    return { inAppMessageId: null as number | null, emailStatus: "failed" as const, pushStatus: "skipped" as const, smsStatus: "skipped" as const, whatsappStatus: "skipped" as const };
  });

  res.json({ ...doc, notification: notify });
});

// Previous versions of a member document — written every time the member-portal
// Replace flow swaps the file behind this row.
router.get("/:memberId/documents/:docId/versions", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  // Left-join app_users so the UI can show who replaced/restored each version
  // (and distinguish restore-snapshot rows from member-replace rows).
  const versions = await db.select({
    id: memberDocumentVersionsTable.id,
    memberDocumentId: memberDocumentVersionsTable.memberDocumentId,
    title: memberDocumentVersionsTable.title,
    fileUrl: memberDocumentVersionsTable.fileUrl,
    mimeType: memberDocumentVersionsTable.mimeType,
    fileSize: memberDocumentVersionsTable.fileSize,
    replacedByUserId: memberDocumentVersionsTable.replacedByUserId,
    replacedAt: memberDocumentVersionsTable.replacedAt,
    source: memberDocumentVersionsTable.source,
    restoredFromVersionId: memberDocumentVersionsTable.restoredFromVersionId,
    replacedByDisplayName: appUsersTable.displayName,
    replacedByUsername: appUsersTable.username,
    replacedByEmail: appUsersTable.email,
  }).from(memberDocumentVersionsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, memberDocumentVersionsTable.replacedByUserId))
    .where(and(
      eq(memberDocumentVersionsTable.memberDocumentId, docId),
      eq(memberDocumentVersionsTable.clubMemberId, memberId),
      eq(memberDocumentVersionsTable.organizationId, orgId),
    ))
    .orderBy(desc(memberDocumentVersionsTable.replacedAt));
  res.json(versions);
});

// Restore a previous version of a member document. Swaps the live row's file
// fields back to the archived copy and snapshots the currently-live file into
// the version history so nothing is lost.
router.post("/:memberId/documents/:docId/versions/:versionId/restore", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  const versionId = parseInt(String((req.params as Record<string, string>).versionId));
  if (!Number.isFinite(docId) || !Number.isFinite(versionId)) {
    res.status(400).json({ error: "Invalid docId or versionId" }); return;
  }

  const staffId = (req.user as { id: number }).id;
  const result = await db.transaction(async (tx) => {
    const [doc] = await tx.select().from(memberDocumentsTable)
      .where(and(
        eq(memberDocumentsTable.id, docId),
        eq(memberDocumentsTable.clubMemberId, memberId),
        eq(memberDocumentsTable.organizationId, orgId),
      ));
    if (!doc) return { error: "not_found" as const };
    const [version] = await tx.select().from(memberDocumentVersionsTable)
      .where(and(
        eq(memberDocumentVersionsTable.id, versionId),
        eq(memberDocumentVersionsTable.memberDocumentId, docId),
        eq(memberDocumentVersionsTable.clubMemberId, memberId),
        eq(memberDocumentVersionsTable.organizationId, orgId),
      ));
    if (!version) return { error: "version_not_found" as const };

    // Snapshot the currently-live file into the version history. Tag the row
    // as a restore so the admin UI can distinguish it from a normal member-
    // replace and surface which staff member performed the action.
    await tx.insert(memberDocumentVersionsTable).values({
      memberDocumentId: doc.id,
      clubMemberId: doc.clubMemberId,
      organizationId: doc.organizationId,
      title: doc.title,
      fileUrl: doc.fileUrl,
      mimeType: doc.mimeType,
      fileSize: doc.fileSize,
      replacedByUserId: staffId,
      source: "restore",
      restoredFromVersionId: version.id,
    });

    // Swap the live row back to the archived copy.
    const [updated] = await tx.update(memberDocumentsTable).set({
      title: version.title,
      fileUrl: version.fileUrl,
      mimeType: version.mimeType,
      fileSize: version.fileSize,
    })
      .where(eq(memberDocumentsTable.id, doc.id))
      .returning();
    return { doc: updated };
  });

  if ("error" in result) {
    if (result.error === "not_found") { { res.status(404).json({ error: "Document not found" }); return; } }
    res.status(404).json({ error: "Version not found for this document" }); return;
  }

  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: memberId,
    entity: "document", entityId: docId, action: "update", reason: "restore_version",
  });
  res.json(result.doc);
});

router.delete("/:memberId/documents/:docId", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const docId = parseInt(String((req.params as Record<string, string>).docId));
  await db.delete(memberDocumentsTable)
    .where(and(eq(memberDocumentsTable.id, docId), eq(memberDocumentsTable.clubMemberId, memberId)));
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "document", entityId: docId, action: "delete" });
  res.status(204).end();
});

// ─── CONSENTS ────────────────────────────────────────────────────────────────

router.get("/:memberId/consents", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const rows = await db.select().from(memberConsentsTable)
    .where(eq(memberConsentsTable.clubMemberId, memberId))
    .orderBy(desc(memberConsentsTable.grantedAt));
  res.json(rows);
});

router.post("/:memberId/consents", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const { consentType, granted, version, source } = req.body;
  if (!consentType || typeof granted !== "boolean") { { res.status(400).json({ error: "consentType and granted required" }); return; } }
  const [c] = await db.insert(memberConsentsTable).values({
    organizationId: orgId, clubMemberId: memberId, consentType, granted, version,
    source: source ?? "web_admin",
    ipAddress: req.ip ?? null,
    recordedByUserId: (req.user as { id: number }).id,
  }).returning();
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "consent", entityId: c.id, action: "create", reason: `${consentType}=${granted}` });
  res.status(201).json(c);
});

// ─── COMMUNICATION PREFS ─────────────────────────────────────────────────────

router.get("/:memberId/comm-prefs", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const rows = await db.select().from(memberCommPrefsTable)
    .where(eq(memberCommPrefsTable.clubMemberId, memberId));
  res.json(rows);
});

router.put("/:memberId/comm-prefs/:category", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const category = String((req.params as Record<string, string>).category);
  if (!COMM_PREF_CATEGORIES.has(category)) { { res.status(400).json({ error: `Invalid category. Allowed: ${[...COMM_PREF_CATEGORIES].join(", ")}` }); return; } }
  const { emailEnabled, smsEnabled, pushEnabled, whatsappEnabled, inAppEnabled, quietHoursStart, quietHoursEnd } = req.body;
  const [existing] = await db.select().from(memberCommPrefsTable)
    .where(and(eq(memberCommPrefsTable.clubMemberId, memberId), eq(memberCommPrefsTable.category, category)));
  let row;
  if (existing) {
    [row] = await db.update(memberCommPrefsTable).set({
      emailEnabled, smsEnabled, pushEnabled, whatsappEnabled, inAppEnabled, quietHoursStart, quietHoursEnd,
      updatedAt: new Date(),
    }).where(eq(memberCommPrefsTable.id, existing.id)).returning();
  } else {
    [row] = await db.insert(memberCommPrefsTable).values({
      organizationId: orgId, clubMemberId: memberId, category,
      emailEnabled, smsEnabled, pushEnabled, whatsappEnabled, inAppEnabled, quietHoursStart, quietHoursEnd,
    }).returning();
  }
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "comm_prefs", entityId: row.id, action: existing ? "update" : "create" });
  res.json(row);
});

// ─── FAMILY LINKS ────────────────────────────────────────────────────────────

router.get("/:memberId/family", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const links = await db.select({
    link: memberFamilyLinksTable,
    member: clubMembersTable,
  }).from(memberFamilyLinksTable)
    .innerJoin(clubMembersTable, eq(memberFamilyLinksTable.linkedMemberId, clubMembersTable.id))
    .where(eq(memberFamilyLinksTable.primaryMemberId, memberId));
  res.json(links);
});

router.post("/:memberId/family", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const { linkedMemberId, relationship, isPrimaryPayer, canBookOnBehalf, notes } = req.body;
  if (!linkedMemberId || !relationship) { { res.status(400).json({ error: "linkedMemberId and relationship required" }); return; } }
  const linked = await loadMember(orgId, Number(linkedMemberId));
  if (!linked) { { res.status(404).json({ error: "Linked member not found in this org" }); return; } }
  const [row] = await db.insert(memberFamilyLinksTable).values({
    organizationId: orgId, primaryMemberId: memberId, linkedMemberId: Number(linkedMemberId),
    relationship, isPrimaryPayer: Boolean(isPrimaryPayer), canBookOnBehalf: Boolean(canBookOnBehalf), notes,
    createdByUserId: (req.user as { id: number }).id,
  }).returning();
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "family_link", entityId: row.id, action: "create" });
  res.status(201).json(row);
});

router.delete("/:memberId/family/:linkId", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const linkId = parseInt(String((req.params as Record<string, string>).linkId));
  await db.delete(memberFamilyLinksTable)
    .where(and(eq(memberFamilyLinksTable.id, linkId), eq(memberFamilyLinksTable.primaryMemberId, memberId)));
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "family_link", entityId: linkId, action: "delete" });
  res.status(204).end();
});

// ─── LIFECYCLE EVENTS (freeze/suspend/transfer/tier-change/resign) ──────────

router.get("/:memberId/lifecycle", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const rows = await db.select().from(memberLifecycleEventsTable)
    .where(eq(memberLifecycleEventsTable.clubMemberId, memberId))
    .orderBy(desc(memberLifecycleEventsTable.effectiveFrom));
  res.json(rows);
});

router.post("/:memberId/lifecycle", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const member = await loadMember(orgId, memberId);
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }

  const { eventType, effectiveFrom, effectiveUntil, fromValue, toValue, reason, internalNotes, feeImpact } = req.body;
  if (!eventType) { { res.status(400).json({ error: "eventType required" }); return; } }
  if (!LIFECYCLE_EVENT_TYPES.has(String(eventType))) {
    res.status(400).json({ error: `Invalid eventType. Allowed: ${[...LIFECYCLE_EVENT_TYPES].join(", ")}` }); return;
  }
  // Validate-before-write: for tier_change, ensure target tier belongs to this org
  // BEFORE inserting any lifecycle event so a failed request leaves zero rows.
  let validatedTierId: number | null = null;
  if (eventType === "tier_change") {
    if (!toValue) { { res.status(400).json({ error: "toValue (target tier id) is required for tier_change" }); return; } }
    const newTierId = parseInt(String(toValue));
    if (!Number.isFinite(newTierId)) { { res.status(400).json({ error: "toValue must be a numeric tier id" }); return; } }
    const [tierOk] = await db.select({ id: membershipTiersTable.id }).from(membershipTiersTable)
      .where(and(eq(membershipTiersTable.id, newTierId), eq(membershipTiersTable.organizationId, orgId)));
    if (!tierOk) { { res.status(400).json({ error: "Tier does not belong to this organization" }); return; } }
    validatedTierId = newTierId;
  }

  // All writes inside a transaction so partial failures roll back fully.
  const evt = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(memberLifecycleEventsTable).values({
      organizationId: orgId, clubMemberId: memberId, eventType,
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
      effectiveUntil: effectiveUntil ? new Date(effectiveUntil) : null,
      fromValue, toValue, reason, internalNotes,
      feeImpact: feeImpact != null ? String(feeImpact) : null,
      performedByUserId: (req.user as { id: number }).id,
    }).returning();

    // Update cache on profile-ext
    const [extExisting] = await tx.select().from(memberProfileExtTable)
      .where(eq(memberProfileExtTable.clubMemberId, memberId));
    const ext = extExisting ?? (await tx.insert(memberProfileExtTable)
      .values({ clubMemberId: memberId, organizationId: orgId }).returning())[0];

    const statusMap: Record<string, string> = {
      freeze: "frozen", unfreeze: "active", suspend: "suspended", reinstate: "active",
      resign: "resigned", deceased: "deceased", transfer: "transferred",
    };
    const newStatus = statusMap[eventType];
    if (newStatus) {
      await tx.update(memberProfileExtTable).set({
        lifecycleStatus: newStatus,
        lifecycleStatusUntil: inserted.effectiveUntil,
        lifecycleReason: reason ?? null,
        updatedAt: new Date(),
      }).where(eq(memberProfileExtTable.id, ext.id));
    }
    if (validatedTierId !== null) {
      await tx.update(clubMembersTable).set({ tierId: validatedTierId, updatedAt: new Date() })
        .where(eq(clubMembersTable.id, memberId));
    }
    return inserted;
  });

  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "lifecycle", entityId: evt.id, action: "create", reason: `${eventType}: ${reason ?? ""}` });
  res.status(201).json(evt);
});

// ─── DISCIPLINARY ────────────────────────────────────────────────────────────

router.get("/:memberId/disciplinary", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const rows = await db.select().from(memberDisciplinaryTable)
    .where(eq(memberDisciplinaryTable.clubMemberId, memberId))
    .orderBy(desc(memberDisciplinaryTable.incidentDate));
  res.json(rows);
});

router.post("/:memberId/disciplinary", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const { incidentDate, category, severity, description, fineAmount } = req.body;
  if (!incidentDate || !category || !description) { { res.status(400).json({ error: "incidentDate, category, description required" }); return; } }
  if (!DISCIPLINARY_CATEGORIES.has(String(category))) {
    res.status(400).json({ error: `Invalid category. Allowed: ${[...DISCIPLINARY_CATEGORIES].join(", ")}` }); return;
  }
  if (severity != null && !DISCIPLINARY_SEVERITIES.has(String(severity))) {
    res.status(400).json({ error: `Invalid severity. Allowed: ${[...DISCIPLINARY_SEVERITIES].join(", ")}` }); return;
  }
  const [row] = await db.insert(memberDisciplinaryTable).values({
    organizationId: orgId, clubMemberId: memberId,
    incidentDate: new Date(incidentDate), category,
    severity: severity ?? "warning", description,
    fineAmount: fineAmount != null ? String(fineAmount) : null,
    recordedByUserId: (req.user as { id: number }).id,
  }).returning();
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "disciplinary", entityId: row.id, action: "create" });
  res.status(201).json(row);
});

router.patch("/:memberId/disciplinary/:id", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const { status, resolutionNotes } = req.body;
  const update: Record<string, unknown> = {};
  if (status) {
    update.status = status;
    if (["resolved", "dismissed"].includes(status)) update.resolvedAt = new Date();
  }
  if (resolutionNotes) update.resolutionNotes = resolutionNotes;
  const [row] = await db.update(memberDisciplinaryTable).set(update)
    .where(and(eq(memberDisciplinaryTable.id, id), eq(memberDisciplinaryTable.clubMemberId, memberId))).returning();
  if (!row) { { res.status(404).json({ error: "Not found" }); return; } }
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "disciplinary", entityId: id, action: "update", reason: status });
  res.json(row);
});

// ─── INTERNAL NOTES ──────────────────────────────────────────────────────────

router.get("/:memberId/notes", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const rows = await db.select({
    note: memberInternalNotesTable, authorName: appUsersTable.displayName, authorEmail: appUsersTable.email,
  }).from(memberInternalNotesTable)
    .leftJoin(appUsersTable, eq(memberInternalNotesTable.authorId, appUsersTable.id))
    .where(eq(memberInternalNotesTable.clubMemberId, memberId))
    .orderBy(desc(memberInternalNotesTable.isPinned), desc(memberInternalNotesTable.createdAt));
  res.json(rows);
});

router.post("/:memberId/notes", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const { body, category, isPinned, visibility } = req.body;
  if (!body) { { res.status(400).json({ error: "body required" }); return; } }
  const [row] = await db.insert(memberInternalNotesTable).values({
    organizationId: orgId, clubMemberId: memberId, body, category,
    isPinned: Boolean(isPinned), visibility: visibility ?? "staff",
    authorId: (req.user as { id: number }).id,
  }).returning();
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "note", entityId: row.id, action: "create" });
  res.status(201).json(row);
});

router.delete("/:memberId/notes/:id", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  await db.delete(memberInternalNotesTable)
    .where(and(eq(memberInternalNotesTable.id, id), eq(memberInternalNotesTable.clubMemberId, memberId)));
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "note", entityId: id, action: "delete" });
  res.status(204).end();
});

// ─── AUDIT LOG ───────────────────────────────────────────────────────────────

router.get("/:memberId/audit-log", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const limit = Math.min(parseInt(String(req.query.limit ?? "100")) || 100, 500);
  // Optional entity filter so the Member 360 audit-tab dropdown can narrow
  // the timeline (Task #970). Accepts a single entity slug like
  // "data_export" / "levy_charge"; absent or "all" returns every row.
  const entityFilter = (req.query.entity ?? "").toString().trim();
  // Left-join the related levy charge so audit rows for entity='levy_charge'
  // can render the latest receipt-delivery outcome inline (Task #253).
  // Non-levy rows still return with all receipt_* fields null.
  const rows = await db.select({
    id: memberAuditLogTable.id,
    clubMemberId: memberAuditLogTable.clubMemberId,
    organizationId: memberAuditLogTable.organizationId,
    actorUserId: memberAuditLogTable.actorUserId,
    actorName: memberAuditLogTable.actorName,
    actorRole: memberAuditLogTable.actorRole,
    entity: memberAuditLogTable.entity,
    entityId: memberAuditLogTable.entityId,
    action: memberAuditLogTable.action,
    fieldChanges: memberAuditLogTable.fieldChanges,
    reason: memberAuditLogTable.reason,
    metadata: memberAuditLogTable.metadata,
    ipAddress: memberAuditLogTable.ipAddress,
    userAgent: memberAuditLogTable.userAgent,
    createdAt: memberAuditLogTable.createdAt,
    receiptLevyId: memberLevyChargesTable.levyId,
    receiptStatus: memberLevyChargesTable.lastReceiptStatus,
    receiptReason: memberLevyChargesTable.lastReceiptReason,
    receiptKind: memberLevyChargesTable.lastReceiptKind,
    receiptAmount: memberLevyChargesTable.lastReceiptAmount,
    receiptAt: memberLevyChargesTable.lastReceiptAt,
  }).from(memberAuditLogTable)
    .leftJoin(
      memberLevyChargesTable,
      and(
        eq(memberAuditLogTable.entity, "levy_charge"),
        eq(memberAuditLogTable.entityId, memberLevyChargesTable.id),
      ),
    )
    .where(and(
      eq(memberAuditLogTable.clubMemberId, memberId),
      eq(memberAuditLogTable.organizationId, orgId),
      ...(entityFilter && entityFilter !== "all"
        ? [eq(memberAuditLogTable.entity, entityFilter)]
        : []),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt))
    .limit(limit);

  // Task #236: enrich `levy_charge` rows with the parent levy id and the
  // per-member charge id so the Member 360 audit-log UI can deep-link straight
  // to the charge's Activity timeline (which has the Reverse button). Audit
  // rows are written with two different entityId conventions:
  //   - "create" rows use entityId = parent levy id (set when the levy was applied)
  //   - "update" rows use entityId = member_levy_charges.id
  // Resolve both cases with two narrow lookups so callers don't have to.
  const levyEntityIds = new Set<number>();
  const chargeEntityIds = new Set<number>();
  for (const r of rows) {
    if (r.entity !== "levy_charge" || r.entityId == null) continue;
    if (r.action === "create") levyEntityIds.add(r.entityId);
    else chargeEntityIds.add(r.entityId);
  }
  const chargeLookup = new Map<number, { levyId: number; chargeId: number }>();
  if (chargeEntityIds.size > 0) {
    const chargeRows = await db.select({
      id: memberLevyChargesTable.id,
      levyId: memberLevyChargesTable.levyId,
    })
      .from(memberLevyChargesTable)
      .innerJoin(memberLeviesTable, eq(memberLeviesTable.id, memberLevyChargesTable.levyId))
      .where(and(
        eq(memberLeviesTable.organizationId, orgId),
        eq(memberLevyChargesTable.clubMemberId, memberId),
        inArray(memberLevyChargesTable.id, Array.from(chargeEntityIds)),
      ));
    for (const c of chargeRows) chargeLookup.set(c.id, { levyId: c.levyId, chargeId: c.id });
  }
  const levyMemberCharge = new Map<number, number>(); // levyId -> chargeId for this member
  if (levyEntityIds.size > 0) {
    const chargeRows = await db.select({
      id: memberLevyChargesTable.id,
      levyId: memberLevyChargesTable.levyId,
    })
      .from(memberLevyChargesTable)
      .innerJoin(memberLeviesTable, eq(memberLeviesTable.id, memberLevyChargesTable.levyId))
      .where(and(
        eq(memberLeviesTable.organizationId, orgId),
        eq(memberLevyChargesTable.clubMemberId, memberId),
        inArray(memberLevyChargesTable.levyId, Array.from(levyEntityIds)),
      ));
    for (const c of chargeRows) levyMemberCharge.set(c.levyId, c.id);
  }
  // Task #1928 — surface the "Re-bounced after re-enable" signal already
  // shown in Marketing → Suppressions on this member's audit timeline too.
  // For each `email_suppression` re-enable audit row, look up the org's
  // `email_suppressions` table for the addresses involved (oldEmail and
  // — for replacement re-enables — replacementEmail). When a bounce-class
  // suppression for one of those addresses was recorded *after* the audit
  // row, the recovery attempt failed; flag the row so the UI can render a
  // "Bounced again on <date>" sub-line with hover detail (reason +
  // bounceType). Mirrors the cross-check admins used to have to do
  // manually against the Suppressions list.
  type SubsequentBounce = {
    email: string;
    at: string;
    reason: string;
    bounceType: string | null;
    description: string | null;
  };
  const subsequentBounceByAuditId = new Map<number, SubsequentBounce>();
  const reenableRows = rows.filter(r =>
    r.entity === "email_suppression" &&
    (r.action === "reenable" || r.action === "reenable_with_replacement"),
  );
  if (reenableRows.length > 0) {
    const candidateEmails = new Set<string>();
    for (const r of reenableRows) {
      const md = (r.metadata ?? {}) as { oldEmail?: unknown; replacementEmail?: unknown };
      if (typeof md.oldEmail === "string" && md.oldEmail) candidateEmails.add(md.oldEmail.toLowerCase());
      if (typeof md.replacementEmail === "string" && md.replacementEmail) candidateEmails.add(md.replacementEmail.toLowerCase());
    }
    if (candidateEmails.size > 0) {
      const supRows = await db.select({
        email: emailSuppressionsTable.email,
        reason: emailSuppressionsTable.reason,
        bounceType: emailSuppressionsTable.bounceType,
        description: emailSuppressionsTable.description,
        createdAt: emailSuppressionsTable.createdAt,
      })
        .from(emailSuppressionsTable)
        .where(and(
          eq(emailSuppressionsTable.organizationId, orgId),
          inArray(emailSuppressionsTable.email, Array.from(candidateEmails)),
        ));
      // Bucket by email — keep only bounce-class rows since unsubscribe /
      // spam-complaint suppressions are a distinct admin signal that
      // shouldn't surface as "the recovery didn't stick".
      const bouncesByEmail = new Map<string, { email: string; reason: string; bounceType: string | null; description: string | null; createdAt: Date }>();
      for (const s of supRows) {
        if (s.reason !== "bounced") continue;
        const k = s.email.toLowerCase();
        const sCreated = s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt as unknown as string);
        const existing = bouncesByEmail.get(k);
        if (!existing || sCreated.getTime() > existing.createdAt.getTime()) {
          bouncesByEmail.set(k, {
            email: s.email,
            reason: s.reason,
            bounceType: s.bounceType ?? null,
            description: s.description ?? null,
            createdAt: sCreated,
          });
        }
      }
      for (const r of reenableRows) {
        const md = (r.metadata ?? {}) as { oldEmail?: unknown; replacementEmail?: unknown };
        const auditAt = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string);
        const candidates: string[] = [];
        if (typeof md.oldEmail === "string" && md.oldEmail) candidates.push(md.oldEmail.toLowerCase());
        if (typeof md.replacementEmail === "string" && md.replacementEmail) candidates.push(md.replacementEmail.toLowerCase());
        let best: SubsequentBounce | null = null;
        for (const email of candidates) {
          const s = bouncesByEmail.get(email);
          if (!s) continue;
          // The new bounce must post-date the re-enable audit; otherwise
          // it's the same row that was originally re-enabled (i.e. no
          // genuine "bounced again" event).
          if (s.createdAt.getTime() <= auditAt.getTime()) continue;
          const candidate: SubsequentBounce = {
            email: s.email,
            at: s.createdAt.toISOString(),
            reason: s.reason,
            bounceType: s.bounceType,
            description: s.description,
          };
          if (!best || new Date(best.at).getTime() < s.createdAt.getTime()) {
            best = candidate;
          }
        }
        if (best) subsequentBounceByAuditId.set(r.id, best);
      }
    }
  }

  // Task #1121: enrich `data_export` rows with the parent member_data_requests
  // info so the Member 360 audit-log UI can deep-link straight to the export's
  // row in the Data / GDPR tab. Audit rows for entity='data_export' are written
  // with entityId = member_data_requests.id (see cron.purgeExpiredDataExportArchives
  // and the account-erasure pass), so a single lookup per audit page is enough
  // to surface the request type alongside the link.
  const dataExportRequestIds = new Set<number>();
  for (const r of rows) {
    if (r.entity === "data_export" && r.entityId != null) dataExportRequestIds.add(r.entityId);
  }
  const dataRequestLookup = new Map<number, { id: number; requestType: string }>();
  if (dataExportRequestIds.size > 0) {
    const drRows = await db.select({
      id: memberDataRequestsTable.id,
      requestType: memberDataRequestsTable.requestType,
    })
      .from(memberDataRequestsTable)
      .where(and(
        eq(memberDataRequestsTable.organizationId, orgId),
        eq(memberDataRequestsTable.clubMemberId, memberId),
        inArray(memberDataRequestsTable.id, Array.from(dataExportRequestIds)),
      ));
    for (const d of drRows) dataRequestLookup.set(d.id, d);
  }

  const enriched = rows.map(r => {
    const base = {
      ...r,
      linkedLevyId: null as number | null,
      linkedChargeId: null as number | null,
      linkedDataRequestId: null as number | null,
      linkedDataRequestType: null as string | null,
      // Task #1928 — populated only on `email_suppression` re-enable rows
      // whose follow-up bounce we found in the suppressions table; null
      // everywhere else so the UI can render the badge unconditionally.
      subsequentBounce: subsequentBounceByAuditId.get(r.id) ?? null,
    };
    if (r.entity === "data_export" && r.entityId != null) {
      const hit = dataRequestLookup.get(r.entityId) ?? null;
      base.linkedDataRequestId = hit ? hit.id : r.entityId;
      base.linkedDataRequestType = hit?.requestType ?? null;
      return base;
    }
    if (r.entity !== "levy_charge" || r.entityId == null) {
      return base;
    }
    if (r.action === "create") {
      const chargeId = levyMemberCharge.get(r.entityId) ?? null;
      return { ...base, linkedLevyId: r.entityId, linkedChargeId: chargeId };
    }
    const hit = chargeLookup.get(r.entityId);
    return {
      ...base,
      linkedLevyId: hit?.levyId ?? null,
      linkedChargeId: hit?.chargeId ?? null,
    };
  });
  res.json(enriched);
});

// ─── ERASURE HISTORY (Task #776) ─────────────────────────────────────────────
// Surface the structured "right to erasure" outcome controllers need to verify
// after the cron runs. The numbers come straight from the audit-log row written
// by `processOverdueAccountErasures` (entity=club_member, action=delete) so this
// endpoint is purely a read-side projection of `member_audit_log.metadata`.
//
// Returned shape per erasure run:
//   - completedAt:               ISO timestamp (the audit row's createdAt)
//   - dataRequestId:             linked privacy data-request row
//   - mediaTablesPurged:         { tableName -> rowCount } per-table breakdown
//   - totalMediaRowsPurged:      sum of mediaTablesPurged values
//   - playerRowsScrubbed:        free-floating player rows (no FK back to user)
//   - objectStorageFilesDeleted: storage objects successfully removed
//   - objectStorageFilesMissing: already-gone objects (idempotent re-runs)
//   - objectStorageFilesFailed:  controllers should re-run cleanup if > 0
//   - objectStorageDisabled:     true in environments without object-storage
//
// We expose all erasure rows for this member (typically there is only one, but
// re-runs after a failed cleanup will create additional rows) so the controller
// can see whether a previous re-attempt has resolved the warning.
interface ErasureHistoryEntry {
  auditId: number;
  completedAt: string;
  dataRequestId: number | null;
  source: string | null;
  mediaTablesPurged: Record<string, number>;
  totalMediaRowsPurged: number;
  playerRowsScrubbed: number | null;
  mediaRowsScrubbed: number | null;
  objectStorageFilesDeleted: number | null;
  objectStorageFilesMissing: number | null;
  objectStorageFilesFailed: number | null;
  objectStorageDisabled: boolean | null;
  // Task #1460 — surfaced only for `controller_acknowledgement` rows so the
  // regulator-facing history can show *why* the cap alert was silenced.
  // Null on every other row so the UI can render the badge unconditionally.
  acknowledgedAuditId: number | null;
  acknowledgementNote: string | null;
  actorName: string | null;
}

function projectErasureMetadata(row: {
  id: number;
  createdAt: Date | null;
  metadata: unknown;
  actorName: string | null;
}): ErasureHistoryEntry {
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  const tables = (m.mediaTablesPurged ?? {}) as Record<string, number>;
  const total = Object.values(tables).reduce((a, b) => a + (Number(b) || 0), 0);
  const numOrNull = (v: unknown) => (typeof v === "number" ? v : v == null ? null : Number(v));
  return {
    auditId: row.id,
    completedAt: (row.createdAt ?? new Date()).toISOString(),
    dataRequestId: numOrNull(m.dataRequestId),
    source: typeof m.source === "string" ? m.source : null,
    mediaTablesPurged: tables,
    totalMediaRowsPurged: total,
    playerRowsScrubbed: numOrNull(m.playerRowsScrubbed),
    mediaRowsScrubbed: numOrNull(m.mediaRowsScrubbed),
    objectStorageFilesDeleted: numOrNull(m.objectStorageFilesDeleted),
    objectStorageFilesMissing: numOrNull(m.objectStorageFilesMissing),
    objectStorageFilesFailed: numOrNull(m.objectStorageFilesFailed),
    objectStorageDisabled: typeof m.objectStorageDisabled === "boolean" ? m.objectStorageDisabled : null,
    acknowledgedAuditId: numOrNull(m.acknowledgedAuditId),
    acknowledgementNote: typeof m.acknowledgementNote === "string" ? m.acknowledgementNote : null,
    actorName: row.actorName,
  };
}

async function fetchErasureHistory(orgId: number, memberId: number): Promise<ErasureHistoryEntry[]> {
  const rows = await db.select({
    id: memberAuditLogTable.id,
    createdAt: memberAuditLogTable.createdAt,
    metadata: memberAuditLogTable.metadata,
    actorName: memberAuditLogTable.actorName,
  }).from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.clubMemberId, memberId),
      eq(memberAuditLogTable.entity, "club_member"),
      eq(memberAuditLogTable.action, "delete"),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id));
  // Only erasure rows carry the mediaTablesPurged metadata; other future
  // "club_member.delete" audit causes (manual hard-delete, etc.) would lack it
  // and should not appear in the controller's erasure summary.
  return rows
    .filter(r => {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      return m.autoErasure === true || m.mediaTablesPurged != null;
    })
    .map(projectErasureMetadata);
}

router.get("/:memberId/erasure-history", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const memberId = memberIdOf(req);
  const entries = await fetchErasureHistory(orgId, memberId);
  res.json({ entries });
});

router.get("/:memberId/erasure-history.csv", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const memberId = memberIdOf(req);
  const entries = await fetchErasureHistory(orgId, memberId);

  // Stable column ordering: identifiers first, then a per-table column for
  // every table observed across all entries (regulators want one row per
  // erasure run with every counter visible side-by-side), then the storage
  // outcomes. Unknown tables show as empty cells rather than zeros so reviewers
  // can distinguish "no rows in that table" from "table not present".
  const tableNames = new Set<string>();
  for (const e of entries) {
    for (const t of Object.keys(e.mediaTablesPurged)) tableNames.add(t);
  }
  const tableCols = Array.from(tableNames).sort();
  const header = [
    "completed_at",
    "audit_id",
    "data_request_id",
    "source",
    "player_rows_scrubbed",
    "media_rows_scrubbed",
    "total_media_rows_purged",
    ...tableCols.map(t => `purged_${t}`),
    "object_storage_files_deleted",
    "object_storage_files_missing",
    "object_storage_files_failed",
    "object_storage_disabled",
    // Task #1794 — acknowledgement context for controller_acknowledgement rows.
    // Empty on every other row so reviewers can scan a single column for
    // "why was this stuck-cleanup alert silenced, and by whom".
    "acknowledgement_note",
    "acknowledged_by",
  ];
  const csvRows: string[][] = [header];
  for (const e of entries) {
    const isAcknowledgement = e.source === "controller_acknowledgement";
    csvRows.push([
      e.completedAt,
      String(e.auditId),
      e.dataRequestId == null ? "" : String(e.dataRequestId),
      e.source ?? "",
      e.playerRowsScrubbed == null ? "" : String(e.playerRowsScrubbed),
      e.mediaRowsScrubbed == null ? "" : String(e.mediaRowsScrubbed),
      String(e.totalMediaRowsPurged),
      ...tableCols.map(t => {
        const v = e.mediaTablesPurged[t];
        return v == null ? "" : String(v);
      }),
      e.objectStorageFilesDeleted == null ? "" : String(e.objectStorageFilesDeleted),
      e.objectStorageFilesMissing == null ? "" : String(e.objectStorageFilesMissing),
      e.objectStorageFilesFailed == null ? "" : String(e.objectStorageFilesFailed),
      e.objectStorageDisabled == null ? "" : String(e.objectStorageDisabled),
      isAcknowledgement ? (e.acknowledgementNote ?? "") : "",
      isAcknowledgement ? (e.actorName ?? "") : "",
    ]);
  }
  const csv = csvRows
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n") + "\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="erasure-history-member-${memberId}.csv"`);
  res.send(csv);
});

// ─── ORG-WIDE ERASURE STORAGE WARNINGS (Task #921) ───────────────────────────
// Aggregate counter + drill-down list of members whose most-recent erasure run
// left object-storage files behind. Task #776 added a per-member "Erasure
// history" card that surfaces `objectStorageFilesFailed > 0`, but controllers
// don't routinely open every deleted member's profile. This endpoint powers the
// dashboard widget that proactively flags stuck cleanups so a controller can
// jump straight to the affected member.
//
// Definition of "stuck": for each (orgId, clubMemberId) we consider the LATEST
// erasure audit row only. If a controller has already re-run cleanup
// successfully (Task #921's POST /erasure-history/retry-storage records a new
// audit row with `objectStorageFilesFailed: 0`), the member naturally drops
// off this list because we look at the freshest row per member.
export interface ErasureStorageFailureItem {
  clubMemberId: number;
  auditId: number;
  completedAt: string;
  objectStorageFilesFailed: number;
  dataRequestId: number | null;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberDeleted: boolean;
  // Task #1459 — number of consecutive `cron_retry` audit rows the bounded
  // auto-retry chain has accumulated for this member's latest failure
  // (mirrors the walk-back loop in `runStuckErasureAutoRetryPass`). A
  // controller manual retry breaks the chain, so this resets to 0 the
  // moment the controller acts.
  autoRetryAttempts: number;
  // True iff `autoRetryAttempts >= ERASURE_AUTO_RETRY_MAX_ATTEMPTS` —
  // i.e. the cron has given up and a controller is required to make
  // forward progress. The dashboard renders a "needs your action" badge
  // when this is true.
  autoRetryExhausted: boolean;
  // Task #1795 — true when the latest erasure audit row for this member
  // is a `controller_acknowledgement` (Task #1460). The carried-forward
  // `objectStorageFilesFailed` count keeps the row on the dashboard, but
  // controllers need a visual cue that a teammate has already triaged
  // it (and the freedom to filter acknowledged rows out of the default
  // view). The `acknowledgedAt`/`acknowledgedBy`/`acknowledgementNote`
  // fields are populated only when this is true so the dashboard can
  // render the reviewer + note tooltip and a per-row "Acknowledged"
  // badge without an extra round-trip to the per-member history endpoint.
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgementNote: string | null;
}
export interface ErasureStorageFailuresAggregate {
  count: number;
  totalFailedFiles: number;
  items: ErasureStorageFailureItem[];
  pendingStorageDeletions: { total: number; exhausted: number };
  // Task #1459 — convenience tally of items where `autoRetryExhausted`
  // is true. The UI uses this for the panel-level "X members need your
  // action" banner without re-iterating the items array client-side and
  // without ever drifting from the per-row badges.
  autoRetryExhaustedCount: number;
  // Task #1459 — surface the same cap value the cron + this aggregator
  // use, so the UI can render labels like "auto-retry in progress (3/5)"
  // without hard-coding the denominator. If the cap is ever raised the
  // UI updates automatically.
  autoRetryMaxAttempts: number;
  // Task #1795 — convenience tally of items whose latest erasure row is
  // a controller_acknowledgement. The dashboard uses this to render
  // "N acknowledged hidden" hints alongside its hide/show toggle without
  // re-iterating the items array client-side, and to drive the default
  // toggle state (hide-on-load when there's anything to hide).
  acknowledgedCount: number;
}

/**
 * Reusable aggregator for the org-wide "stuck erasure cleanup" surface.
 * Powers both the GET /erasures/storage-failures endpoint and the daily
 * digest email cron (Task #1078). Returns the same shape both surfaces
 * already share so we never drift.
 */
export async function getStuckErasureStorageFailuresForOrg(orgId: number): Promise<ErasureStorageFailuresAggregate> {
  const rows = await db.select({
    id: memberAuditLogTable.id,
    clubMemberId: memberAuditLogTable.clubMemberId,
    createdAt: memberAuditLogTable.createdAt,
    metadata: memberAuditLogTable.metadata,
    // Task #1795 — surface the actor on the latest row so the dashboard
    // can show *who* acknowledged a stuck cleanup. Cron rows store
    // "system (cron auto-retry)" / null here; the controller
    // acknowledgement helper stamps the controller's display name.
    actorName: memberAuditLogTable.actorName,
  }).from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.entity, "club_member"),
      eq(memberAuditLogTable.action, "delete"),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id));

  // Group every audit row per member (newest-first within each group) so we
  // can both pick the latest erasure-attempt row AND walk the chain to count
  // consecutive `cron_retry` rows for the auto-retry-exhausted badge.
  // Task #1459 — the walk-back logic mirrors `runStuckErasureAutoRetryPass`
  // exactly: skip the synthetic `cron_capped_notification` markers, count
  // `cron_retry` rows, stop on anything else (controller_retry breaks the
  // chain and resets the count). The two surfaces must agree, otherwise
  // the badge would show "exhausted" while the cron still thought it had
  // attempts left, or vice-versa.
  const groupedByMember = new Map<number, typeof rows>();
  for (const r of rows) {
    if (r.clubMemberId == null) continue;
    const arr = groupedByMember.get(r.clubMemberId);
    if (arr) arr.push(r);
    else groupedByMember.set(r.clubMemberId, [r]);
  }

  type Stuck = {
    clubMemberId: number;
    auditId: number;
    completedAt: string;
    objectStorageFilesFailed: number;
    dataRequestId: number | null;
    autoRetryAttempts: number;
    autoRetryExhausted: boolean;
    acknowledged: boolean;
    acknowledgedAt: string | null;
    acknowledgedBy: string | null;
    acknowledgementNote: string | null;
  };
  const stuck: Stuck[] = [];
  for (const [clubMemberId, groupRows] of groupedByMember) {
    // Pick the latest audit row that actually represents an erasure attempt
    // (skip the transparent `cron_capped_notification` markers — they carry
    // forward the failed-paths metadata so they pass the failed>0 gate, but
    // they don't represent a fresh attempt and using them as the surface row
    // would also bias the auto-retry chain count).
    const latest = groupRows.find(r => {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      return m.source !== CRON_CAPPED_NOTIFICATION_SOURCE;
    });
    if (!latest) continue;
    const m = (latest.metadata ?? {}) as Record<string, unknown>;
    if (m.autoErasure !== true && m.mediaTablesPurged == null) continue;
    const failed = typeof m.objectStorageFilesFailed === "number"
      ? m.objectStorageFilesFailed
      : Number(m.objectStorageFilesFailed ?? 0);
    if (!(failed > 0)) continue;

    // Walk back from the newest row counting consecutive cron-retry attempts.
    // `cron_capped_notification` rows are transparent (skip without counting,
    // without breaking the chain). Anything else (the original cron erasure
    // OR a controller-initiated retry OR a controller_acknowledgement)
    // breaks the chain — manual intervention resets the budget, which is
    // exactly the behaviour the cron uses.
    let attempts = 0;
    for (const r of groupRows) {
      const md = (r.metadata ?? {}) as Record<string, unknown>;
      if (md.source === "cron_retry") { attempts++; continue; }
      if (md.source === CRON_CAPPED_NOTIFICATION_SOURCE) continue;
      break;
    }

    // Task #1795 — when the latest erasure row is a controller_acknowledgement
    // (Task #1460) we surface the reviewer + note so the dashboard can render
    // an "Acknowledged" badge without an extra round-trip. The carried-forward
    // failed-files counter still holds the orphan footprint, so the row stays
    // on the panel — the badge is the visual cue that someone already triaged it.
    const acknowledged = m.source === CONTROLLER_ACKNOWLEDGEMENT_SOURCE;
    const acknowledgementNote = acknowledged && typeof m.acknowledgementNote === "string"
      ? m.acknowledgementNote
      : null;

    stuck.push({
      clubMemberId,
      auditId: latest.id,
      completedAt: (latest.createdAt ?? new Date()).toISOString(),
      objectStorageFilesFailed: failed,
      dataRequestId: typeof m.dataRequestId === "number" ? m.dataRequestId : null,
      autoRetryAttempts: attempts,
      autoRetryExhausted: attempts >= ERASURE_AUTO_RETRY_MAX_ATTEMPTS,
      acknowledged,
      acknowledgedAt: acknowledged ? (latest.createdAt ?? new Date()).toISOString() : null,
      acknowledgedBy: acknowledged ? (latest.actorName ?? null) : null,
      acknowledgementNote,
    });
  }

  const ids = stuck.map(s => s.clubMemberId);
  const members = ids.length > 0
    ? await db.select({
        id: clubMembersTable.id,
        firstName: clubMembersTable.firstName,
        lastName: clubMembersTable.lastName,
        memberNumber: clubMembersTable.memberNumber,
      }).from(clubMembersTable).where(inArray(clubMembersTable.id, ids))
    : [];
  const memberById = new Map(members.map(m => [m.id, m]));

  const items: ErasureStorageFailureItem[] = stuck
    .map(s => {
      const m = memberById.get(s.clubMemberId) ?? null;
      return {
        ...s,
        memberFirstName: m?.firstName ?? null,
        memberLastName: m?.lastName ?? null,
        memberNumber: m?.memberNumber ?? null,
        memberDeleted: m == null,
      };
    })
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

  const totalFailedFiles = items.reduce((s, i) => s + i.objectStorageFilesFailed, 0);
  // Task #1459 — panel-level "needs your action" tally derived from the
  // same per-item flag, so the banner can never disagree with the badges.
  const autoRetryExhaustedCount = items.reduce((s, i) => s + (i.autoRetryExhausted ? 1 : 0), 0);
  // Task #1795 — panel-level acknowledged tally so the dashboard can
  // render "N acknowledged hidden" alongside the toggle without
  // re-iterating items client-side. Always derived from the same
  // per-item flag for consistency with the badges.
  const acknowledgedCount = items.reduce((s, i) => s + (i.acknowledged ? 1 : 0), 0);

  const [pendingTotalsRow] = await db.select({
    pending: sql<number>`COUNT(*)::int`,
    exhausted: sql<number>`SUM(CASE WHEN ${pendingStorageDeletionsTable.attempts} >= ${PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS} THEN 1 ELSE 0 END)::int`,
  }).from(pendingStorageDeletionsTable)
    .where(eq(pendingStorageDeletionsTable.organizationId, orgId));

  return {
    count: items.length,
    totalFailedFiles,
    items,
    pendingStorageDeletions: {
      total: Number(pendingTotalsRow?.pending ?? 0),
      exhausted: Number(pendingTotalsRow?.exhausted ?? 0),
    },
    autoRetryExhaustedCount,
    autoRetryMaxAttempts: ERASURE_AUTO_RETRY_MAX_ATTEMPTS,
    acknowledgedCount,
  };
}

router.get("/erasures/storage-failures", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  res.json(await getStuckErasureStorageFailuresForOrg(orgId));
});

// Task #1450 — lightweight summary used by the controller dashboard badge.
// The full /erasures/storage-failures endpoint joins club_members to attach
// names, paths and member-deleted flags so the governance panel can render
// the drill-down table. The home-screen badge only needs the count + queue
// totals, so we expose a summary that skips the member lookup. The numbers
// must agree exactly with the full endpoint — both go through the same
// audit-log scan (latest erasure row per member, autoErasure / mediaTablesPurged
// gating, objectStorageFilesFailed > 0) and the same pending_storage_deletions
// aggregation. Anything else and the badge would silently drift from the panel.
//
// Task #1779 — also surface `autoRetryExhaustedCount` so the dashboard
// badge can render a "needs your action" sub-count without paying for the
// full per-member items array. The chain-walk mirrors the full aggregator
// row-for-row: latest non-`cron_capped_notification` row is the surface
// row, then walk newest→oldest counting consecutive `cron_retry` rows
// (transparent through capped-notification markers, broken by anything
// else) and compare against ERASURE_AUTO_RETRY_MAX_ATTEMPTS. Keeping the
// two surfaces on identical logic is the only way the badge can never
// disagree with the panel banner it deep-links into.
export async function getStuckErasureStorageFailuresSummaryForOrg(orgId: number): Promise<{
  count: number;
  totalFailedFiles: number;
  autoRetryExhaustedCount: number;
  pendingStorageDeletions: { total: number; exhausted: number };
}> {
  const rows = await db.select({
    id: memberAuditLogTable.id,
    clubMemberId: memberAuditLogTable.clubMemberId,
    metadata: memberAuditLogTable.metadata,
  }).from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.entity, "club_member"),
      eq(memberAuditLogTable.action, "delete"),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id));

  // Group by member so we can both pick the right surface row and walk
  // the auto-retry chain — same shape the full aggregator uses above.
  const groupedByMember = new Map<number, typeof rows>();
  for (const r of rows) {
    if (r.clubMemberId == null) continue;
    const arr = groupedByMember.get(r.clubMemberId);
    if (arr) arr.push(r);
    else groupedByMember.set(r.clubMemberId, [r]);
  }

  let count = 0;
  let totalFailedFiles = 0;
  let autoRetryExhaustedCount = 0;
  for (const groupRows of groupedByMember.values()) {
    const latest = groupRows.find(r => {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      return m.source !== CRON_CAPPED_NOTIFICATION_SOURCE;
    });
    if (!latest) continue;
    const m = (latest.metadata ?? {}) as Record<string, unknown>;
    if (m.autoErasure !== true && m.mediaTablesPurged == null) continue;
    const failed = typeof m.objectStorageFilesFailed === "number"
      ? m.objectStorageFilesFailed
      : Number(m.objectStorageFilesFailed ?? 0);
    if (!(failed > 0)) continue;
    count++;
    totalFailedFiles += failed;

    let attempts = 0;
    for (const r of groupRows) {
      const md = (r.metadata ?? {}) as Record<string, unknown>;
      if (md.source === "cron_retry") { attempts++; continue; }
      if (md.source === CRON_CAPPED_NOTIFICATION_SOURCE) continue;
      break;
    }
    if (attempts >= ERASURE_AUTO_RETRY_MAX_ATTEMPTS) autoRetryExhaustedCount++;
  }

  const [pendingTotalsRow] = await db.select({
    pending: sql<number>`COUNT(*)::int`,
    exhausted: sql<number>`SUM(CASE WHEN ${pendingStorageDeletionsTable.attempts} >= ${PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS} THEN 1 ELSE 0 END)::int`,
  }).from(pendingStorageDeletionsTable)
    .where(eq(pendingStorageDeletionsTable.organizationId, orgId));

  return {
    count,
    totalFailedFiles,
    autoRetryExhaustedCount,
    pendingStorageDeletions: {
      total: Number(pendingTotalsRow?.pending ?? 0),
      exhausted: Number(pendingTotalsRow?.exhausted ?? 0),
    },
  };
}

router.get("/erasures/storage-failures/summary", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  res.json(await getStuckErasureStorageFailuresSummaryForOrg(orgId));
});

router.post("/:memberId/erasure-history/retry-storage", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  // RBAC + org/member binding handled by the param middleware.
  const actor = req.user as { id: number; displayName?: string | null; username?: string | null } | undefined;
  const result = await retryFailedObjectStoragePurgeForMember({
    organizationId: orgId,
    clubMemberId: memberId,
    actorUserId: actor?.id ?? null,
    actorName: actor?.displayName ?? actor?.username ?? "controller",
  });
  if (result.sourceAuditId == null) {
    res.status(404).json({ error: "No prior erasure on file for this member." });
    return;
  }
  res.json(result);
});

// Task #1460 — controller acknowledgement of a stuck-cleanup alert.
//
// Same effect on the cron walk-back as the retry-storage endpoint above
// (chain reset → re-arms the cap alert) without the storage-purge attempt.
// Useful when the controller has investigated and decided to leave the
// orphan files in place (e.g. legal hold), so they can silence the alert
// without running pointless retries. The optional `note` is captured in
// the audit row's metadata so the regulator-facing erasure history can
// show why the controller acknowledged it.
router.post("/:memberId/erasure-history/acknowledge", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  // RBAC + org/member binding handled by the param middleware.
  const actor = req.user as { id: number; displayName?: string | null; username?: string | null } | undefined;
  const noteRaw = (req.body as { note?: unknown } | null | undefined)?.note;
  const note = typeof noteRaw === "string" ? noteRaw : null;
  // Cap the note length so a runaway client can't bloat the audit table.
  // 1k is generous for a free-text reason; longer narratives belong in
  // member_internal_notes.
  if (note != null && note.length > 1000) {
    res.status(400).json({ error: "Note must be 1000 characters or fewer." });
    return;
  }
  const result = await acknowledgeStuckErasureForMember({
    organizationId: orgId,
    clubMemberId: memberId,
    actorUserId: actor?.id ?? null,
    actorName: actor?.displayName ?? actor?.username ?? "controller",
    note,
  });
  if (result.sourceAuditId == null) {
    res.status(404).json({ error: "No prior erasure on file for this member." });
    return;
  }
  res.json(result);
});

// ─── Task #1128 — admin actions on individual stuck pending_storage_deletions
//
// Task #973 added the retry queue + an org-wide counter, but admins had no
// way to act on individual stuck rows. When a path is genuinely gone from
// the bucket (deleted out-of-band, or migrated) the row would never drain
// and would sit in the "exhausted" counter forever. These endpoints let
// admins (a) list each stuck row with path / member / attempts / last
// error, (b) force an immediate retry by resetting nextAttemptAt to now,
// and (c) mark the row resolved by deleting it and writing an audit row
// of who cleared it and why.
//
// "Stuck" here means `attempts >= PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS`
// — that's the same threshold the org-wide counter uses, so the list and
// the counter never disagree.

interface PendingStorageDeletionItem {
  id: number;
  clubMemberId: number | null;
  sourceAuditId: number | null;
  path: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  exhausted: boolean;
  // Task #1303 — when this row first crossed the exhaustion threshold the
  // alerting cron (Task #1127) sets `exhaustion_notified_at` and pages
  // admins exactly once. Surfacing the timestamp here lets the dashboard
  // show an "Alerted at <date>" pill so a triaging admin can tell at a
  // glance whether the on-call has already been paged for this row and
  // avoid duplicate manual escalations.
  exhaustionNotifiedAt: string | null;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberDeleted: boolean;
}

router.get("/erasures/storage-failures/pending", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  // Optional ?onlyExhausted=true filter — defaults to true so the surface
  // matches the "stuck" counter the admin already sees, but we expose the
  // toggle so an admin investigating a flaky run can see the full queue.
  const onlyExhaustedQ = String(req.query.onlyExhausted ?? "true").toLowerCase();
  const onlyExhausted = onlyExhaustedQ !== "false" && onlyExhaustedQ !== "0";

  // Task #1537 — optional ?pathPrefix= and ?errorContains= filters so an
  // admin running a bucket-migration sweep can target a known-good cohort
  // (e.g. `/objects/migrated-2026-04/`) before pressing the bulk action,
  // instead of operating on the full first-500 page. Inputs are trimmed,
  // capped at 500 chars (defensive — paths/messages above that are
  // essentially unsearchable anyway), and have LIKE wildcards (`%`, `_`,
  // `\`) escaped so a literal `%` in a path or error doesn't accidentally
  // widen the match. Path prefix matches case-sensitively (object paths
  // are case-sensitive); error substring matches case-insensitively
  // because error messages from different backends vary in capitalisation.
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pathPrefixRaw = typeof req.query.pathPrefix === "string" ? req.query.pathPrefix : "";
  const pathPrefix = pathPrefixRaw.trim().slice(0, 500);
  const errorContainsRaw = typeof req.query.errorContains === "string" ? req.query.errorContains : "";
  const errorContains = errorContainsRaw.trim().slice(0, 500);

  const conds = [eq(pendingStorageDeletionsTable.organizationId, orgId)];
  if (onlyExhausted) {
    conds.push(gte(pendingStorageDeletionsTable.attempts, PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS));
  }
  if (pathPrefix.length > 0) {
    conds.push(like(pendingStorageDeletionsTable.path, `${escapeLike(pathPrefix)}%`));
  }
  if (errorContains.length > 0) {
    conds.push(ilike(pendingStorageDeletionsTable.lastError, `%${escapeLike(errorContains)}%`));
  }
  const rows = await db.select({
    id: pendingStorageDeletionsTable.id,
    clubMemberId: pendingStorageDeletionsTable.clubMemberId,
    sourceAuditId: pendingStorageDeletionsTable.sourceAuditId,
    path: pendingStorageDeletionsTable.path,
    attempts: pendingStorageDeletionsTable.attempts,
    lastAttemptAt: pendingStorageDeletionsTable.lastAttemptAt,
    lastError: pendingStorageDeletionsTable.lastError,
    nextAttemptAt: pendingStorageDeletionsTable.nextAttemptAt,
    createdAt: pendingStorageDeletionsTable.createdAt,
    exhaustionNotifiedAt: pendingStorageDeletionsTable.exhaustionNotifiedAt,
  }).from(pendingStorageDeletionsTable)
    .where(and(...conds))
    // Newest-failing-first inside the exhausted bucket so the worst rows
    // are surfaced; ties broken by id for a stable order.
    .orderBy(desc(pendingStorageDeletionsTable.attempts), desc(pendingStorageDeletionsTable.id))
    .limit(500);

  const memberIds = Array.from(new Set(rows.map(r => r.clubMemberId).filter((id): id is number => id != null)));
  const members = memberIds.length > 0
    ? await db.select({
        id: clubMembersTable.id,
        firstName: clubMembersTable.firstName,
        lastName: clubMembersTable.lastName,
        memberNumber: clubMembersTable.memberNumber,
      }).from(clubMembersTable).where(inArray(clubMembersTable.id, memberIds))
    : [];
  const memberById = new Map(members.map(m => [m.id, m]));

  const items: PendingStorageDeletionItem[] = rows.map(r => {
    const m = r.clubMemberId != null ? memberById.get(r.clubMemberId) ?? null : null;
    return {
      id: r.id,
      clubMemberId: r.clubMemberId,
      sourceAuditId: r.sourceAuditId,
      path: r.path,
      attempts: r.attempts,
      lastAttemptAt: r.lastAttemptAt ? r.lastAttemptAt.toISOString() : null,
      lastError: r.lastError,
      nextAttemptAt: (r.nextAttemptAt ?? new Date()).toISOString(),
      createdAt: (r.createdAt ?? new Date()).toISOString(),
      exhausted: r.attempts >= PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS,
      // Null when the row has not yet been alerted on (either it has not
      // crossed the threshold or it crossed before Task #1127 added the
      // column). The dashboard renders a pill only when this is non-null.
      exhaustionNotifiedAt: r.exhaustionNotifiedAt ? r.exhaustionNotifiedAt.toISOString() : null,
      memberFirstName: m?.firstName ?? null,
      memberLastName: m?.lastName ?? null,
      memberNumber: m?.memberNumber ?? null,
      // Null clubMemberId means the underlying row was already cascade-deleted;
      // a non-null id with no matching row means the same. Either way the
      // admin can no longer click through to a member-360 page.
      memberDeleted: r.clubMemberId == null || m == null,
    };
  });

  res.json({ count: items.length, onlyExhausted, pathPrefix, errorContains, items });
});

// ─── Task #1302 — bulk admin actions on stuck pending_storage_deletions
//
// A bucket migration or backend outage can leave dozens or hundreds of
// rows in the exhausted bucket simultaneously. Calling the per-row
// endpoints in a loop from the UI is impractical, and the resolve flow's
// reason prompt would otherwise force the admin to type the same
// sentence per row. These endpoints accept an array of pending row ids
// and apply force-retry / resolve to each, recording one audit row per
// id so the per-row trail is preserved exactly as the single-row
// endpoints leave it.
//
// Cross-org or unknown ids are rejected up front with 404 (same
// existence-leak rule as the single-row endpoints) so we never partially
// apply the bulk action — the admin gets either everything they asked
// for, or a clean 404 with no rows touched.

const BULK_PENDING_STORAGE_MAX_IDS = 500;

function parseBulkPendingIds(rawIds: unknown): { ids: number[] } | { error: string } {
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return { error: "ids must be a non-empty array" };
  }
  if (rawIds.length > BULK_PENDING_STORAGE_MAX_IDS) {
    return { error: `Too many ids (max ${BULK_PENDING_STORAGE_MAX_IDS})` };
  }
  const ids: number[] = [];
  for (const x of rawIds) {
    const n = typeof x === "number" ? x : parseInt(String(x));
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { error: "All ids must be positive integers" };
    }
    ids.push(n);
  }
  // De-dup so callers passing the same id twice can't double-audit.
  return { ids: Array.from(new Set(ids)) };
}

router.post("/erasures/storage-failures/pending/bulk-retry-now", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const parsed = parseBulkPendingIds(req.body?.ids);
  if ("error" in parsed) { { res.status(400).json({ error: parsed.error }); return; } }
  const { ids } = parsed;

  const reason = typeof req.body?.reason === "string" && req.body.reason.trim().length > 0
    ? String(req.body.reason).trim().slice(0, 500)
    : "admin force-retry (bulk)";

  // Existence check first so we can 404 cleanly without partially
  // applying the bulk update. Any id not in this org (whether genuinely
  // missing or owned by another org) leaves the whole request as a
  // no-op — same existence-leak rule the single-row endpoint uses.
  const existing = await db.select({ id: pendingStorageDeletionsTable.id })
    .from(pendingStorageDeletionsTable)
    .where(and(
      eq(pendingStorageDeletionsTable.organizationId, orgId),
      inArray(pendingStorageDeletionsTable.id, ids),
    ));
  if (existing.length !== ids.length) {
    res.status(404).json({ error: "One or more pending storage rows were not found in this org." });
    return;
  }

  // Bulk update — same semantics as single-row: reset nextAttemptAt to
  // now, leave attempts intact so genuinely stuck rows stay in the
  // "exhausted" bucket if force-retry fails again.
  const updated = await db.update(pendingStorageDeletionsTable)
    .set({ nextAttemptAt: new Date() })
    .where(and(
      eq(pendingStorageDeletionsTable.organizationId, orgId),
      inArray(pendingStorageDeletionsTable.id, ids),
    ))
    .returning({
      id: pendingStorageDeletionsTable.id,
      clubMemberId: pendingStorageDeletionsTable.clubMemberId,
      path: pendingStorageDeletionsTable.path,
      attempts: pendingStorageDeletionsTable.attempts,
    });

  // One audit row per affected pending_storage_deletions id so the
  // per-row trail stays intact even when the action was bulk. The
  // shared reason is the same on each row; metadata.bulk=true makes it
  // easy to distinguish bulk from single-row force-retries later.
  for (const row of updated) {
    await recordMemberAudit({
      req,
      organizationId: orgId,
      clubMemberId: row.clubMemberId,
      entity: "pending_storage_deletion",
      entityId: row.id,
      action: "force_retry",
      reason,
      metadata: { path: row.path, attempts: row.attempts, bulk: true },
    });
  }

  res.json({ count: updated.length, ids: updated.map(r => r.id) });
});

router.post("/erasures/storage-failures/pending/bulk-resolve", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const parsed = parseBulkPendingIds(req.body?.ids);
  if ("error" in parsed) { { res.status(400).json({ error: parsed.error }); return; } }
  const { ids } = parsed;

  // One shared reason for the whole batch — same content rule as the
  // single-row resolve: orphan files are PII, so the audit row must
  // record *why* the admin believes the file is genuinely gone.
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length === 0) {
    res.status(400).json({ error: "A reason is required to mark stuck rows resolved." });
    return;
  }

  const existing = await db.select({ id: pendingStorageDeletionsTable.id })
    .from(pendingStorageDeletionsTable)
    .where(and(
      eq(pendingStorageDeletionsTable.organizationId, orgId),
      inArray(pendingStorageDeletionsTable.id, ids),
    ));
  if (existing.length !== ids.length) {
    res.status(404).json({ error: "One or more pending storage rows were not found in this org." });
    return;
  }

  // DELETE … RETURNING so two admins clicking simultaneously can't both
  // pass the existence check and double-audit — a row that's already
  // been deleted will simply not appear in `deleted` and will not get
  // an audit row from this caller.
  const deleted = await db.delete(pendingStorageDeletionsTable)
    .where(and(
      eq(pendingStorageDeletionsTable.organizationId, orgId),
      inArray(pendingStorageDeletionsTable.id, ids),
    ))
    .returning({
      id: pendingStorageDeletionsTable.id,
      clubMemberId: pendingStorageDeletionsTable.clubMemberId,
      path: pendingStorageDeletionsTable.path,
      attempts: pendingStorageDeletionsTable.attempts,
      lastError: pendingStorageDeletionsTable.lastError,
      sourceAuditId: pendingStorageDeletionsTable.sourceAuditId,
    });

  for (const row of deleted) {
    await recordMemberAudit({
      req,
      organizationId: orgId,
      clubMemberId: row.clubMemberId,
      entity: "pending_storage_deletion",
      entityId: row.id,
      action: "resolve",
      reason: reason.slice(0, 500),
      metadata: {
        path: row.path,
        attempts: row.attempts,
        lastError: row.lastError,
        sourceAuditId: row.sourceAuditId,
        bulk: true,
      },
    });
  }

  res.json({ count: deleted.length, ids: deleted.map(r => r.id), resolved: true });
});

router.post("/erasures/storage-failures/pending/:pendingId/retry-now", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const pendingId = parseInt(String((req.params as Record<string, string>).pendingId));
  if (!Number.isFinite(pendingId)) { { res.status(400).json({ error: "Invalid pendingId" }); return; } }

  // Reset nextAttemptAt so the next worker tick picks the row up.
  // We deliberately do NOT reset `attempts` — keeping the counter intact
  // preserves the audit history and means a row genuinely stuck on a real
  // backend issue stays in the "exhausted" bucket if force-retry fails again.
  const [updated] = await db.update(pendingStorageDeletionsTable)
    .set({ nextAttemptAt: new Date() })
    .where(and(
      eq(pendingStorageDeletionsTable.id, pendingId),
      eq(pendingStorageDeletionsTable.organizationId, orgId),
    ))
    .returning({
      id: pendingStorageDeletionsTable.id,
      clubMemberId: pendingStorageDeletionsTable.clubMemberId,
      path: pendingStorageDeletionsTable.path,
      attempts: pendingStorageDeletionsTable.attempts,
      nextAttemptAt: pendingStorageDeletionsTable.nextAttemptAt,
    });
  if (!updated) { { res.status(404).json({ error: "Pending storage row not found in this org." }); return; } }

  await recordMemberAudit({
    req,
    organizationId: orgId,
    clubMemberId: updated.clubMemberId,
    entity: "pending_storage_deletion",
    entityId: updated.id,
    action: "force_retry",
    reason: typeof req.body?.reason === "string" && req.body.reason.trim().length > 0
      ? String(req.body.reason).slice(0, 500) : "admin force-retry",
    metadata: { path: updated.path, attempts: updated.attempts },
  });

  res.json({
    id: updated.id,
    nextAttemptAt: (updated.nextAttemptAt ?? new Date()).toISOString(),
    attempts: updated.attempts,
  });
});

router.post("/erasures/storage-failures/pending/:pendingId/resolve", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const pendingId = parseInt(String((req.params as Record<string, string>).pendingId));
  if (!Number.isFinite(pendingId)) { { res.status(400).json({ error: "Invalid pendingId" }); return; } }

  // Require an explicit reason — orphan files are PII, so an admin clearing
  // a row must record *why* they believe the file is genuinely gone (e.g.
  // bucket migration, manual cleanup) so the audit trail is meaningful.
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length === 0) { { res.status(400).json({ error: "A reason is required to mark a stuck row resolved." }); return; } }

  // Single DELETE … RETURNING avoids a select/delete race where two admins
  // hitting the same row simultaneously would both pass the existence check
  // and both write a "resolve" audit row. The DB-level row lock makes the
  // second caller see no row and 404 cleanly.
  const [row] = await db.delete(pendingStorageDeletionsTable)
    .where(and(
      eq(pendingStorageDeletionsTable.id, pendingId),
      eq(pendingStorageDeletionsTable.organizationId, orgId),
    ))
    .returning({
      id: pendingStorageDeletionsTable.id,
      clubMemberId: pendingStorageDeletionsTable.clubMemberId,
      path: pendingStorageDeletionsTable.path,
      attempts: pendingStorageDeletionsTable.attempts,
      lastError: pendingStorageDeletionsTable.lastError,
      sourceAuditId: pendingStorageDeletionsTable.sourceAuditId,
    });
  if (!row) { { res.status(404).json({ error: "Pending storage row not found in this org." }); return; } }

  // Write the audit BEFORE we lose the per-row context. We capture the path,
  // attempt count, last error, and the original audit id so an investigator
  // can reconstruct the chain even after the queue row is gone.
  await recordMemberAudit({
    req,
    organizationId: orgId,
    clubMemberId: row.clubMemberId,
    entity: "pending_storage_deletion",
    entityId: row.id,
    action: "resolve",
    reason: reason.slice(0, 500),
    metadata: {
      path: row.path,
      attempts: row.attempts,
      lastError: row.lastError,
      sourceAuditId: row.sourceAuditId,
    },
  });

  res.json({ id: row.id, resolved: true });
});

// ─── Task #1301 — org-wide audit history of admin actions on stuck rows ─────
//
// Task #1128's force-retry / resolve endpoints already write member_audit_log
// rows with entity='pending_storage_deletion'. But once a row is cleared the
// only way to read that history was the per-member 360 audit tab — and rows
// for cascade-deleted members (clubMemberId NULL) never surface anywhere.
//
// This endpoint exposes the same audit rows org-wide so the Privacy tab can
// render a "Recent storage-cleanup admin actions" list next to the stuck-rows
// panel. We deliberately filter on organizationId (not clubMemberId) so the
// trail survives member cascade-delete.
interface PendingStorageAuditItem {
  id: number;
  action: "force_retry" | "resolve";
  createdAt: string;
  reason: string | null;
  path: string | null;
  attempts: number | null;
  lastError: string | null;
  pendingId: number | null;
  clubMemberId: number | null;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberDeleted: boolean;
  actorUserId: number | null;
  actorName: string | null;
  actorDisplayName: string | null;
  actorUsername: string | null;
  actorEmail: string | null;
  // Task #1893 — true when the audit row was written by one of the
  // bulk admin endpoints (bulk-retry-now / bulk-resolve), which set
  // metadata.bulk=true on every row they emit. Lets the Privacy tab
  // distinguish "30 separate clicks" from "one bulk click affecting 30
  // rows" without changing the per-row reason text.
  bulk: boolean;
}

// Task #1530 — Distinct admin actors that have ever performed a force_retry /
// resolve action on a stuck orphan-file row in this org. Surfaced alongside
// the items so the Privacy tab's actor dropdown stays stable across filter
// changes (we don't recompute the dropdown options as the user narrows the
// list). Only actors with a known user id are included; rows where the user
// was already gone (actorUserId NULL) are excluded — there's nothing
// meaningful to filter by in that case.
interface PendingStorageAuditActor {
  userId: number;
  label: string;
}

router.get("/erasures/storage-failures/audit-log", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  // Cap at 200 with a default of 50 — the UI shows ~50 in a collapsible list,
  // but we let an investigator widen the window without paginating.
  const rawLimit = parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;

  // Task #1530 — server-side filters so the limit cap stays meaningful as the
  // log accumulates. Each is optional; default view is unfiltered.
  // - actorUserId: pin to one admin (Number.isFinite catches NaN / negative).
  // - action: restrict to one of the two in-scope action types.
  // - pathPrefix: case-insensitive substring match on the leading segment of
  //   metadata->>'path' so admins can filter to a particular migration / dir.
  const rawActor = req.query.actorUserId;
  const actorUserId = rawActor != null && rawActor !== ""
    ? (() => { const n = parseInt(String(rawActor), 10); return Number.isFinite(n) && n > 0 ? n : null; })()
    : null;
  const rawAction = req.query.action != null ? String(req.query.action) : "";
  const action = rawAction === "force_retry" || rawAction === "resolve" ? rawAction : null;
  const rawPathPrefix = req.query.pathPrefix != null ? String(req.query.pathPrefix).trim() : "";
  const pathPrefix = rawPathPrefix.length > 0 ? rawPathPrefix.slice(0, 200) : null;

  // Task #1895 — optional from/to date range, applied server-side against
  // member_audit_log.created_at. Accepts either a bare YYYY-MM-DD (treated
  // as start-of-day for `from` / end-of-day for `to`, both UTC, mirroring
  // the documents queue's date filters) or any other ISO datetime string.
  // Invalid / unparseable values are silently dropped — same forgiving
  // posture as the existing actor / action filters.
  const rawFrom = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const rawTo = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const fromDate = rawFrom ? new Date(rawFrom) : null;
  const toDate = rawTo ? new Date(rawTo) : null;
  if (toDate && !Number.isNaN(toDate.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(rawTo)) {
    toDate.setUTCHours(23, 59, 59, 999);
  }
  const fromValid = fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : null;
  const toValid = toDate && !Number.isNaN(toDate.getTime()) ? toDate : null;

  // Task #1894 — opaque cursor for "Load older" pagination. The list is
  // ordered (createdAt DESC, id DESC), so the cursor encodes both keys to
  // stay deterministic across rows that share a createdAt timestamp. The
  // `t` field is a microsecond-precision ISO string sourced from
  // to_char(...) below — JS Date is only millisecond-precise, so encoding
  // .toISOString() of a Date round-trip would silently truncate the
  // microsecond tail and skip rows in the same millisecond window when
  // created_at is written by the DB default (now() returns microseconds).
  // An unparseable cursor falls back to "first page" rather than 400-ing —
  // the UI can always recover by asking for the first page again, and a
  // hard error here is more confusing than the silently-fresh page.
  let cursor: { t: string; id: number } | null = null;
  if (typeof req.query.cursor === "string" && req.query.cursor.length > 0) {
    try {
      const decoded = Buffer.from(req.query.cursor, "base64url").toString("utf8");
      const parsed = JSON.parse(decoded) as unknown;
      if (
        parsed && typeof parsed === "object"
        && typeof (parsed as { t?: unknown }).t === "string"
        && typeof (parsed as { id?: unknown }).id === "number"
        // Defence-in-depth: the `t` value flows straight into a
        // ::timestamptz cast in raw SQL below. Reject anything that
        // doesn't look like an ISO timestamp before letting it through
        // — keeps the parameterised cast from being asked to evaluate
        // attacker-controlled garbage even though pg-driver would
        // otherwise refuse it.
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test((parsed as { t: string }).t)
        && Number.isFinite((parsed as { id: number }).id)
      ) {
        cursor = { t: (parsed as { t: string }).t, id: (parsed as { id: number }).id };
      }
    } catch {
      // ignore — treat as no cursor
    }
  }

  const auditActorUsers = aliasedTable(appUsersTable, "auditActorUsers");
  const auditMemberRows = aliasedTable(clubMembersTable, "auditMemberRows");
  const baseConds = [
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, "pending_storage_deletion"),
    inArray(memberAuditLogTable.action, ["force_retry", "resolve"]),
  ];
  const filterConds = [
    actorUserId != null ? eq(memberAuditLogTable.actorUserId, actorUserId) : null,
    action != null ? eq(memberAuditLogTable.action, action) : null,
    // Escape the user-supplied prefix so % and _ are taken literally before
    // we tack on the trailing % wildcard. Match is case-insensitive (ILIKE)
    // because object-storage keys are usually all-lowercase but admins
    // shouldn't have to remember that to filter.
    pathPrefix != null
      ? sql`(${memberAuditLogTable.metadata}->>'path') ILIKE ${pathPrefix.replace(/[\\%_]/g, m => "\\" + m) + "%"}`
      : null,
    fromValid != null ? gte(memberAuditLogTable.createdAt, fromValid) : null,
    toValid != null ? lte(memberAuditLogTable.createdAt, toValid) : null,
  ].filter((c): c is NonNullable<typeof c> => c != null);

  // Task #1894 — strict (createdAt, id) < (cursor.t, cursor.id) predicate
  // matching the ORDER BY tuple. The cursor's `t` is a microsecond-
  // precision ISO string (see select below); casting it back to
  // timestamptz preserves microseconds end-to-end so rows that share a
  // millisecond but differ at the µs level are not silently skipped.
  const cursorConds: ReturnType<typeof sql>[] = [];
  if (cursor) {
    cursorConds.push(sql`(${memberAuditLogTable.createdAt} < ${cursor.t}::timestamptz
      OR (${memberAuditLogTable.createdAt} = ${cursor.t}::timestamptz AND ${memberAuditLogTable.id} < ${cursor.id}))`);
  }

  // Task #1894 — fetch limit+1 rows so we know whether another page
  // exists *without* relying on "exactly limit rows came back" (which
  // produces a spurious nextCursor when the page lands exactly on the
  // last row). The +1 row is dropped before serialising.
  const rows = await db.select({
    id: memberAuditLogTable.id,
    action: memberAuditLogTable.action,
    createdAt: memberAuditLogTable.createdAt,
    // Microsecond-precision text snapshot of created_at, used only as the
    // cursor key. Drizzle hands `createdAt` back as a JS Date, which is
    // millisecond-precision and would silently lose the µs tail if used
    // as the cursor.
    createdAtText: sql<string>`to_char(${memberAuditLogTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("created_at_text"),
    reason: memberAuditLogTable.reason,
    metadata: memberAuditLogTable.metadata,
    entityId: memberAuditLogTable.entityId,
    clubMemberId: memberAuditLogTable.clubMemberId,
    actorUserId: memberAuditLogTable.actorUserId,
    actorName: memberAuditLogTable.actorName,
    actorDisplayName: auditActorUsers.displayName,
    actorUsername: auditActorUsers.username,
    actorEmail: auditActorUsers.email,
    memberRowId: auditMemberRows.id,
    memberFirstName: auditMemberRows.firstName,
    memberLastName: auditMemberRows.lastName,
    memberNumber: auditMemberRows.memberNumber,
  }).from(memberAuditLogTable)
    .leftJoin(auditActorUsers, eq(auditActorUsers.id, memberAuditLogTable.actorUserId))
    // Left-join the member row so we can show name + number when the member
    // still exists. clubMemberId IS NULL (cascade-deleted) still returns
    // because of the LEFT join — those rows render as "member row removed".
    .leftJoin(auditMemberRows, eq(auditMemberRows.id, memberAuditLogTable.clubMemberId))
    .where(and(...baseConds, ...filterConds, ...cursorConds))
    .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: PendingStorageAuditItem[] = pageRows.map(r => {
    const md = (r.metadata ?? null) as Record<string, unknown> | null;
    const path = md && typeof md.path === "string" ? (md.path as string) : null;
    const attempts = md && typeof md.attempts === "number" ? (md.attempts as number) : null;
    const lastError = md && typeof md.lastError === "string" ? (md.lastError as string) : null;
    // Task #1893 — only the literal boolean `true` counts as bulk so a
    // legacy row that stored `bulk: "true"` or omitted the key entirely
    // still renders without the badge (per-row clicks don't write the key).
    const bulk = md != null && md.bulk === true;
    return {
      id: r.id,
      action: r.action as "force_retry" | "resolve",
      createdAt: (r.createdAt ?? new Date()).toISOString(),
      reason: r.reason,
      path,
      attempts,
      lastError,
      pendingId: r.entityId,
      clubMemberId: r.clubMemberId,
      memberFirstName: r.memberFirstName,
      memberLastName: r.memberLastName,
      memberNumber: r.memberNumber,
      // Either the audit row was written without a member (cascade-deleted
      // before the row was touched) or the LEFT join found no surviving
      // member row (id is the unambiguous "did the join match?" signal —
      // any club_members row has a non-null id).
      memberDeleted: r.clubMemberId == null || r.memberRowId == null,
      actorUserId: r.actorUserId,
      actorName: r.actorName,
      actorDisplayName: r.actorDisplayName,
      actorUsername: r.actorUsername,
      actorEmail: r.actorEmail,
      bulk,
    };
  });

  // Task #1530 — distinct actors over the org's full storage-cleanup audit
  // history (not just the current page or current filter window) so the
  // Privacy tab's actor dropdown shows every admin who has ever done one of
  // these actions, regardless of which filter is active. Capped to 200 to
  // keep the dropdown sane in catastrophically chatty environments.
  const actorsAlias = aliasedTable(appUsersTable, "auditActorListUsers");
  const actorRows = await db.selectDistinct({
    userId: memberAuditLogTable.actorUserId,
    displayName: actorsAlias.displayName,
    username: actorsAlias.username,
    email: actorsAlias.email,
    actorName: memberAuditLogTable.actorName,
  }).from(memberAuditLogTable)
    .leftJoin(actorsAlias, eq(actorsAlias.id, memberAuditLogTable.actorUserId))
    .where(and(...baseConds, isNotNull(memberAuditLogTable.actorUserId)))
    .limit(200);
  const actorMap = new Map<number, PendingStorageAuditActor>();
  for (const a of actorRows) {
    if (a.userId == null) continue;
    const label = (a.displayName ?? a.username ?? a.email ?? a.actorName ?? `user #${a.userId}`).trim() || `user #${a.userId}`;
    // Prefer the first label we see for a given userId, but only set once;
    // selectDistinct can return multiple rows per userId if actorName drifted.
    if (!actorMap.has(a.userId)) actorMap.set(a.userId, { userId: a.userId, label });
  }
  const actors = Array.from(actorMap.values()).sort((a, b) => a.label.localeCompare(b.label));

  // Task #1894 — emit a `nextCursor` only when there is genuinely more
  // history to fetch. We over-read by one row above (`limit + 1`) and use
  // the presence of that extra row as the signal — relying on
  // "items.length === limit" instead would emit a spurious cursor when
  // the page lands exactly on the final row, sending the UI on a fruitless
  // round-trip. The cursor key uses the µs-precision text snapshot of
  // created_at (NOT the JS Date) so that rows sharing a millisecond
  // window can never be skipped.
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = Buffer.from(
      JSON.stringify({ t: last.createdAtText, id: last.id }),
      "utf8",
    ).toString("base64url");
  }

  res.json({
    count: items.length,
    limit,
    items,
    actors,
    filters: {
      actorUserId,
      action,
      pathPrefix,
      from: fromValid ? fromValid.toISOString() : null,
      to: toValid ? toValid.toISOString() : null,
    },
    nextCursor,
  });
});

// Task #1896 — CSV variant of the storage-cleanup audit list. The JSON
// endpoint above caps at 200 rows because it powers an in-page list; this
// variant honours the same filter triple (actorUserId / action / pathPrefix)
// but uses a higher cap (5000) so an investigator can attach a meaningful
// slice to an incident ticket without paginating.
//
// Columns mirror what the in-page card already shows so the CSV is a
// faithful export of the filtered subset, plus a couple of forensic
// fields (audit id, member id, actor user id) so a reviewer can correlate
// CSV rows back to log lines.
router.get("/erasures/storage-failures/audit-log.csv", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;

  // Hard cap of 5000 rows. We default to the same 5000 because the export
  // is on-demand: an admin clicked "Download CSV" expecting the full
  // filtered set. Allow `?limit=` to narrow if the admin only wants the
  // top N. Floor of 1 mirrors the JSON endpoint.
  const HARD_CAP = 5000;
  const rawLimit = parseInt(String(req.query.limit ?? String(HARD_CAP)), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), HARD_CAP)
    : HARD_CAP;

  // Same filter parsing as the JSON endpoint above. Kept inline rather than
  // refactored so a behaviour change to one route can't silently drift the
  // other; the surface is small enough to justify the duplication.
  const rawActor = req.query.actorUserId;
  const actorUserId = rawActor != null && rawActor !== ""
    ? (() => { const n = parseInt(String(rawActor), 10); return Number.isFinite(n) && n > 0 ? n : null; })()
    : null;
  const rawAction = req.query.action != null ? String(req.query.action) : "";
  const action = rawAction === "force_retry" || rawAction === "resolve" ? rawAction : null;
  const rawPathPrefix = req.query.pathPrefix != null ? String(req.query.pathPrefix).trim() : "";
  const pathPrefix = rawPathPrefix.length > 0 ? rawPathPrefix.slice(0, 200) : null;

  const auditActorUsers = aliasedTable(appUsersTable, "auditActorUsersCsv");
  const auditMemberRows = aliasedTable(clubMembersTable, "auditMemberRowsCsv");
  const baseConds = [
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, "pending_storage_deletion"),
    inArray(memberAuditLogTable.action, ["force_retry", "resolve"]),
  ];
  const filterConds = [
    actorUserId != null ? eq(memberAuditLogTable.actorUserId, actorUserId) : null,
    action != null ? eq(memberAuditLogTable.action, action) : null,
    pathPrefix != null
      ? sql`(${memberAuditLogTable.metadata}->>'path') ILIKE ${pathPrefix.replace(/[\\%_]/g, m => "\\" + m) + "%"}`
      : null,
  ].filter((c): c is NonNullable<typeof c> => c != null);

  const rows = await db.select({
    id: memberAuditLogTable.id,
    action: memberAuditLogTable.action,
    createdAt: memberAuditLogTable.createdAt,
    reason: memberAuditLogTable.reason,
    metadata: memberAuditLogTable.metadata,
    clubMemberId: memberAuditLogTable.clubMemberId,
    actorUserId: memberAuditLogTable.actorUserId,
    actorName: memberAuditLogTable.actorName,
    actorDisplayName: auditActorUsers.displayName,
    actorUsername: auditActorUsers.username,
    actorEmail: auditActorUsers.email,
    memberRowId: auditMemberRows.id,
    memberFirstName: auditMemberRows.firstName,
    memberLastName: auditMemberRows.lastName,
    memberNumber: auditMemberRows.memberNumber,
  }).from(memberAuditLogTable)
    .leftJoin(auditActorUsers, eq(auditActorUsers.id, memberAuditLogTable.actorUserId))
    .leftJoin(auditMemberRows, eq(auditMemberRows.id, memberAuditLogTable.clubMemberId))
    .where(and(...baseConds, ...filterConds))
    .orderBy(desc(memberAuditLogTable.createdAt), desc(memberAuditLogTable.id))
    .limit(limit);

  const header = [
    "audit_id",
    "timestamp",
    "action",
    "admin",
    "admin_email",
    "admin_user_id",
    "member",
    "member_number",
    "club_member_id",
    "path",
    "attempts",
    "reason",
    "last_error",
  ];
  const csvRows: string[][] = [header];
  for (const r of rows) {
    const md = (r.metadata ?? null) as Record<string, unknown> | null;
    const path = md && typeof md.path === "string" ? (md.path as string) : "";
    const attempts = md && typeof md.attempts === "number" ? String(md.attempts as number) : "";
    const lastError = md && typeof md.lastError === "string" ? (md.lastError as string) : "";

    const adminLabel = (r.actorDisplayName
      ?? r.actorUsername
      ?? r.actorEmail
      ?? r.actorName
      ?? (r.actorUserId != null ? `user #${r.actorUserId}` : "system")).trim();
    const adminEmail = r.actorEmail ?? "";

    // "(removed)" matches the cascade-delete language used in the task brief.
    // The audit row's clubMemberId is NULL when the row was written after
    // the member was already gone; the LEFT join's missing memberRowId
    // catches the case where the audit row points at a member that has
    // since been deleted.
    const memberDeleted = r.clubMemberId == null || r.memberRowId == null;
    let memberLabel: string;
    if (memberDeleted) {
      memberLabel = "(removed)";
    } else {
      const name = [r.memberFirstName, r.memberLastName].filter(Boolean).join(" ").trim();
      memberLabel = name || (r.clubMemberId != null ? `Member #${r.clubMemberId}` : "(removed)");
    }
    const memberNumber = memberDeleted ? "" : (r.memberNumber ?? "");

    csvRows.push([
      String(r.id),
      (r.createdAt ?? new Date()).toISOString(),
      r.action,
      adminLabel,
      adminEmail,
      r.actorUserId != null ? String(r.actorUserId) : "",
      memberLabel,
      memberNumber,
      r.clubMemberId != null ? String(r.clubMemberId) : "",
      path,
      attempts,
      r.reason ?? "",
      lastError,
    ]);
  }

  const csv = csvRows
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n") + "\n";

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="storage-cleanup-audit-org-${orgId}.csv"`,
  );
  res.send(csv);
});

// ─── COMMITTEE ROLES ─────────────────────────────────────────────────────────

router.get("/:memberId/committee", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const rows = await db.select().from(memberCommitteeRolesTable)
    .where(eq(memberCommitteeRolesTable.clubMemberId, memberId))
    .orderBy(desc(memberCommitteeRolesTable.termStart));
  res.json(rows);
});

router.post("/:memberId/committee", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const { committee, position, termStart, termEnd, notes } = req.body;
  if (!committee || !position || !termStart) { { res.status(400).json({ error: "committee, position, termStart required" }); return; } }
  const [row] = await db.insert(memberCommitteeRolesTable).values({
    organizationId: orgId, clubMemberId: memberId,
    committee, position, termStart: new Date(termStart),
    termEnd: termEnd ? new Date(termEnd) : null, notes,
  }).returning();
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "committee_role", entityId: row.id, action: "create" });
  res.status(201).json(row);
});

router.delete("/:memberId/committee/:id", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  await db.delete(memberCommitteeRolesTable)
    .where(and(eq(memberCommitteeRolesTable.id, id), eq(memberCommitteeRolesTable.clubMemberId, memberId)));
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "committee_role", entityId: id, action: "delete" });
  res.status(204).end();
});

// ─── ACCESS CARDS (RFID/NFC) ─────────────────────────────────────────────────

router.get("/:memberId/access-cards", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const rows = await db.select().from(memberAccessCardsTable)
    .where(eq(memberAccessCardsTable.clubMemberId, memberId))
    .orderBy(desc(memberAccessCardsTable.issuedAt));
  res.json(rows);
});

router.post("/:memberId/access-cards", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const { cardType, cardNumber, cardLabel } = req.body;
  if (!cardNumber) { { res.status(400).json({ error: "cardNumber required" }); return; } }
  try {
    const [row] = await db.insert(memberAccessCardsTable).values({
      organizationId: orgId, clubMemberId: memberId,
      cardType: cardType ?? "rfid", cardNumber, cardLabel,
      issuedByUserId: (req.user as { id: number }).id,
    }).returning();
    await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "access_card", entityId: row.id, action: "create" });
    res.status(201).json(row);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("unique")) {
      res.status(409).json({ error: "Card number already exists in this org" });
    } else {
      throw err;
    }
  }
});

router.patch("/:memberId/access-cards/:id/deactivate", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const { reason } = req.body;
  const [row] = await db.update(memberAccessCardsTable).set({
    isActive: false, deactivatedAt: new Date(), deactivatedReason: reason ?? "manually deactivated",
  }).where(and(eq(memberAccessCardsTable.id, id), eq(memberAccessCardsTable.clubMemberId, memberId))).returning();
  if (!row) { { res.status(404).json({ error: "Not found" }); return; } }
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "access_card", entityId: id, action: "update", reason: "deactivated" });
  res.json(row);
});

router.get("/:memberId/access-log", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const limit = Math.min(parseInt(String(req.query.limit ?? "50")) || 50, 200);
  const rows = await db.select().from(memberAccessLogTable)
    .where(eq(memberAccessLogTable.clubMemberId, memberId))
    .orderBy(desc(memberAccessLogTable.occurredAt))
    .limit(limit);
  res.json(rows);
});

// ─── MILESTONES ──────────────────────────────────────────────────────────────

router.get("/:memberId/milestones", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const rows = await db.select().from(memberMilestonesTable)
    .where(eq(memberMilestonesTable.clubMemberId, memberId))
    .orderBy(desc(memberMilestonesTable.occurredAt));
  res.json(rows);
});

router.post("/:memberId/milestones", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const { milestoneType, occurredAt, courseName, holeNumber, yardage, club, witnesses, details, verified } = req.body;
  if (!milestoneType || !occurredAt) { { res.status(400).json({ error: "milestoneType and occurredAt required" }); return; } }
  const [row] = await db.insert(memberMilestonesTable).values({
    organizationId: orgId, clubMemberId: memberId,
    milestoneType, occurredAt: new Date(occurredAt),
    courseName, holeNumber, yardage, club, witnesses, details,
    verified: Boolean(verified),
    verifiedByUserId: verified ? (req.user as { id: number }).id : null,
  }).returning();
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "milestone", entityId: row.id, action: "create" });
  res.status(201).json(row);
});

// ─── DIRECT MESSAGES ─────────────────────────────────────────────────────────

router.get("/:memberId/messages", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const rows = await db.select().from(memberMessagesTable)
    .where(eq(memberMessagesTable.clubMemberId, memberId))
    .orderBy(desc(memberMessagesTable.sentAt))
    .limit(100);

  // Task #311: enrich rows tagged with a levy-receipt push/SMS exhaustion
  // alert (`relatedEntity` of `levy_receipt_push_exhausted` /
  // `levy_receipt_sms_exhausted`) with the underlying `chargeId`. The
  // `relatedEntityId` on these rows is the receipt-attempts row id (not the
  // chargeId), so the Member 360 timeline needs the lookup to deep-link
  // straight to the affected levy charge on the Financial tab.
  const exhaustionAttemptIds = rows
    .filter(r =>
      r.relatedEntity === "levy_receipt_push_exhausted" ||
      r.relatedEntity === "levy_receipt_sms_exhausted",
    )
    .map(r => r.relatedEntityId)
    .filter((id): id is number => id != null);
  const chargeByAttemptId = new Map<number, number>();
  if (exhaustionAttemptIds.length > 0) {
    const attempts = await db.select({
      id: memberLevyReceiptAttemptsTable.id,
      chargeId: memberLevyReceiptAttemptsTable.chargeId,
    })
      .from(memberLevyReceiptAttemptsTable)
      .where(and(
        eq(memberLevyReceiptAttemptsTable.organizationId, orgId),
        inArray(memberLevyReceiptAttemptsTable.id, exhaustionAttemptIds),
      ));
    for (const a of attempts) chargeByAttemptId.set(a.id, a.chargeId);
  }
  // Task #899: enrich rows tagged with `relatedEntity = 'round_robin_tie_break'`
  // (written by `roundRobinTieBreakNotify`) with the parent `tournamentId` so
  // the Member 360 MessagesTab can render a "View tie-break match" button that
  // deep-links straight to `/tournaments/<tid>/bracket?match=<matchId>`.
  // The `relatedEntityId` on these rows is the bracket_matches.id.
  const tieBreakMatchIds = rows
    .filter(r => r.relatedEntity === "round_robin_tie_break")
    .map(r => r.relatedEntityId)
    .filter((id): id is number => id != null);
  const tournamentByMatchId = new Map<number, number>();
  if (tieBreakMatchIds.length > 0) {
    const matches = await db.select({
      matchId: bracketMatchesTable.id,
      tournamentId: matchPlayBracketTable.tournamentId,
    })
      .from(bracketMatchesTable)
      .innerJoin(matchPlayBracketTable, eq(matchPlayBracketTable.id, bracketMatchesTable.bracketId))
      .innerJoin(tournamentsTable, eq(tournamentsTable.id, matchPlayBracketTable.tournamentId))
      .where(and(
        inArray(bracketMatchesTable.id, tieBreakMatchIds),
        eq(tournamentsTable.organizationId, orgId),
      ));
    for (const m of matches) tournamentByMatchId.set(m.matchId, m.tournamentId);
  }
  const enriched = rows.map(r => {
    const isExhaustion =
      r.relatedEntity === "levy_receipt_push_exhausted" ||
      r.relatedEntity === "levy_receipt_sms_exhausted";
    const linkedChargeId = isExhaustion && r.relatedEntityId != null
      ? chargeByAttemptId.get(r.relatedEntityId) ?? null
      : null;
    const linkedTournamentId =
      r.relatedEntity === "round_robin_tie_break" && r.relatedEntityId != null
        ? tournamentByMatchId.get(r.relatedEntityId) ?? null
        : null;
    return { ...r, linkedChargeId, linkedTournamentId };
  });
  res.json(enriched);
});

router.post("/:memberId/messages", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const { channel, subject, body } = req.body;
  if (!body) { { res.status(400).json({ error: "body required" }); return; } }
  const [row] = await db.insert(memberMessagesTable).values({
    organizationId: orgId, clubMemberId: memberId,
    channel: channel ?? "in_app", subject, body,
    senderUserId: (req.user as { id: number }).id,
  }).returning();
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "message", entityId: row.id, action: "create" });
  res.status(201).json(row);
});

// ─── DATA REQUESTS (GDPR/DPDP) ───────────────────────────────────────────────

// Task #217: list of admin staff who can be assigned a privacy request. Returns
// every user with an org_memberships row whose role qualifies for member-admin
// access (mirrors requireMemberAdmin above). The Member 360 Data tab uses this
// to populate the "Assigned to" picker.
router.get("/staff", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const rows = await db.select({
    id: appUsersTable.id,
    displayName: appUsersTable.displayName,
    username: appUsersTable.username,
    email: appUsersTable.email,
    role: orgMembershipsTable.role,
  })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      inArray(orgMembershipsTable.role, ["org_admin", "membership_secretary", "treasurer"]),
    ))
    .orderBy(asc(appUsersTable.displayName), asc(appUsersTable.username));
  res.json(rows);
});

router.get("/:memberId/data-requests", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  // Task #217: include the assigned handler so the Data tab can render
  // "Assigned to ..." badges and the picker can show the current value.
  const rows = await db.select({
    request: memberDataRequestsTable,
    handlerDisplayName: appUsersTable.displayName,
    handlerUsername: appUsersTable.username,
    handlerEmail: appUsersTable.email,
  })
    .from(memberDataRequestsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, memberDataRequestsTable.handlerUserId))
    .where(eq(memberDataRequestsTable.clubMemberId, memberId))
    .orderBy(desc(memberDataRequestsTable.requestedAt));

  // Aggregate resend history from the audit log so the row can show
  // "resent N times" without requiring an extra round-trip per request.
  // Resends are recorded as entity=data_request_notification, action=resend,
  // entityId=requestId by the POST .../resend handler above.
  const ids = rows.map(r => r.request.id);
  const resendStats = new Map<number, { resendCount: number; lastResendAt: string | null }>();
  if (ids.length > 0) {
    const stats = await db.select({
      entityId: memberAuditLogTable.entityId,
      resendCount: count(),
      lastResendAt: sql<string | null>`max(${memberAuditLogTable.createdAt})`,
    }).from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.clubMemberId, memberId),
        eq(memberAuditLogTable.entity, "data_request_notification"),
        eq(memberAuditLogTable.action, "resend"),
        inArray(memberAuditLogTable.entityId, ids),
      ))
      .groupBy(memberAuditLogTable.entityId);
    for (const s of stats) {
      if (s.entityId != null) {
        resendStats.set(s.entityId, {
          resendCount: Number(s.resendCount ?? 0),
          lastResendAt: s.lastResendAt ? new Date(s.lastResendAt).toISOString() : null,
        });
      }
    }
  }

  const enriched = rows.map(r => ({
    ...r.request,
    handlerDisplayName: r.handlerDisplayName,
    handlerUsername: r.handlerUsername,
    handlerEmail: r.handlerEmail,
    resendCount: resendStats.get(r.request.id)?.resendCount ?? 0,
    lastResendAt: resendStats.get(r.request.id)?.lastResendAt ?? null,
  }));

  // Task #284: opening the Member 360 Data tab acknowledges any pending
  // handler-assigned notices for requests this viewer is the handler of, so
  // the dashboard "Assigned to me" unread badge clears once they've actually
  // looked at the work.
  const currentUserId = (req.user as { id: number }).id;
  const myHandledRequestIds = enriched
    .filter(r => r.handlerUserId === currentUserId)
    .map(r => r.id);
  if (myHandledRequestIds.length > 0) {
    await db.update(memberMessagesTable)
      .set({ readAt: new Date() })
      .where(and(
        eq(memberMessagesTable.relatedEntity, "data_request_handler_assigned"),
        inArray(memberMessagesTable.relatedEntityId, myHandledRequestIds),
        isNull(memberMessagesTable.readAt),
      ));
  }

  res.json({
    requests: enriched,
    maxPushAttempts: DATA_REQUEST_MAX_PUSH_ATTEMPTS,
    maxSmsAttempts: DATA_REQUEST_MAX_SMS_ATTEMPTS,
    maxWhatsappAttempts: DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS,
    // Task #1076: surface the server-side data-export validity window so the
    // admin Data tab's countdown / amber banner can derive expiry from
    // resolvedAt without hardcoding the 7-day constant on the client.
    exportValidForDays: DATA_EXPORT_VALID_DAYS,
  });
});

// Resend history for one privacy data-request — returns the audit-log entries
// recorded by the POST .../resend handler so admins can see exactly when each
// retry happened, who triggered it, and the per-channel delivery outcome
// (encoded into the audit "reason" string by the resend handler).
router.get("/:memberId/data-requests/:id/resend-history", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  const [request] = await db.select().from(memberDataRequestsTable)
    .where(and(eq(memberDataRequestsTable.id, id), eq(memberDataRequestsTable.clubMemberId, memberId)));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }

  const rows = await db.select({
    id: memberAuditLogTable.id,
    actorName: memberAuditLogTable.actorName,
    actorRole: memberAuditLogTable.actorRole,
    reason: memberAuditLogTable.reason,
    metadata: memberAuditLogTable.metadata,
    createdAt: memberAuditLogTable.createdAt,
  }).from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.clubMemberId, memberId),
      eq(memberAuditLogTable.entity, "data_request_notification"),
      eq(memberAuditLogTable.action, "resend"),
      eq(memberAuditLogTable.entityId, id),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt));

  // Per-channel detail returned to the UI. `at` and `error` are only
  // available for newer rows where the resend handler persisted structured
  // metadata; for legacy rows the shared `extractResendChannels` helper
  // falls back to parsing the free-form `reason` string and surfaces null
  // for the timestamp / provider error so the UI can degrade gracefully
  // (status badge only, no tooltip body). The same helper now powers the
  // dashboard stalled-export widget (Task #1891) so both surfaces stay in
  // lockstep when the audit-row shape evolves.
  // Distinguish member-initiated resends (Task #212, recorded by the portal
  // /my-data-requests/:id/resend handler) from admin-initiated ones. The
  // portal handler prefixes the audit reason with "member resent " — that's
  // the only reliable signal because actorRole reflects the member's primary
  // user role (e.g. "member"/"player"), not the surface that triggered it.
  const history = rows.map(r => {
    // Older audit rows that have neither `metadata.channels` nor the legacy
    // "email:<s>, ..." reason format yield `null` here; preserve the empty
    // shape so the popover's `hasChannels` check still trips and falls back
    // to rendering the raw reason instead of an empty badge row.
    const channels = extractResendChannels(r.metadata, r.reason)
      ?? { email: null, inApp: null, push: null, sms: null };
    // Task #251: cron-driven retries are tagged with metadata.source === "cron"
    // and have a reason prefix of "automatic ". Either signal flags the entry
    // as system-initiated so the popover can label it distinctly from a
    // member- or admin-triggered resend.
    const meta = r.metadata as { source?: unknown } | null;
    const reasonText = (r.reason ?? "").toLowerCase();
    const initiatedBy = meta?.source === "cron" || reasonText.startsWith("automatic ")
      ? ("system" as const)
      : reasonText.startsWith("member resent ")
        ? ("member" as const)
        : ("admin" as const);
    return {
      id: r.id,
      actorName: r.actorName,
      actorRole: r.actorRole,
      reason: r.reason,
      createdAt: r.createdAt,
      channels,
      initiatedBy,
    };
  });
  res.json({ count: history.length, history });
});

router.post("/:memberId/data-requests", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const { requestType, notes } = req.body;
  if (!requestType) { { res.status(400).json({ error: "requestType required" }); return; } }
  const dueBy = new Date(); dueBy.setDate(dueBy.getDate() + 30);
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: orgId, clubMemberId: memberId, requestType, notes,
    dueBy, handlerUserId: (req.user as { id: number }).id,
  }).returning();
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "data_request", entityId: row.id, action: "create", reason: requestType });
  res.status(201).json(row);
});

router.patch("/:memberId/data-requests/:id", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const { status, notes, artifactUrl, handlerUserId } = req.body;

  const [previous] = await db.select().from(memberDataRequestsTable)
    .where(and(eq(memberDataRequestsTable.id, id), eq(memberDataRequestsTable.clubMemberId, memberId)));
  if (!previous) { { res.status(404).json({ error: "Not found" }); return; } }

  const update: Record<string, unknown> = {};
  if (status) { update.status = status; if (status === "completed") update.resolvedAt = new Date(); }
  if (notes !== undefined) update.notes = notes;
  if (artifactUrl !== undefined) update.artifactUrl = artifactUrl;
  // Task #217: allow admins to assign / reassign / unassign the handler. Accept
  // null (or 0) to clear the assignment; otherwise validate that the target
  // user actually has member-admin access to this org so we can never assign a
  // request to someone who couldn't act on it.
  let handlerChange: { from: number | null; to: number | null } | null = null;
  if (handlerUserId !== undefined) {
    const next = handlerUserId === null || handlerUserId === 0 ? null : Number(handlerUserId);
    if (next !== null && !Number.isFinite(next)) {
      res.status(400).json({ error: "Invalid handlerUserId" }); return;
    }
    if (next !== null) {
      const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
        .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, next)));
      if (!m || !["org_admin", "membership_secretary", "treasurer"].includes(m.role)) {
        res.status(400).json({ error: "Selected user is not an admin in this organization" }); return;
      }
    }
    update.handlerUserId = next;
    handlerChange = { from: previous.handlerUserId ?? null, to: next };
  }
  if (Object.keys(update).length === 0) { { res.json(previous); return; } }
  const [row] = await db.update(memberDataRequestsTable).set(update)
    .where(and(eq(memberDataRequestsTable.id, id), eq(memberDataRequestsTable.clubMemberId, memberId))).returning();
  if (!row) { { res.status(404).json({ error: "Not found" }); return; } }
  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: memberId,
    entity: "data_request", entityId: id, action: "update",
    reason: handlerChange && !status
      ? `assigned handler: ${handlerChange.from ?? "unassigned"} → ${handlerChange.to ?? "unassigned"}`
      : status,
  });

  // Task #249: when the assignment changes to a non-null handler that isn't
  // the actor themselves, push an in-app + device notification so the new
  // handler learns about the assignment without waiting for a dashboard
  // refresh. Self-assignments and unassignments are intentionally silent.
  if (handlerChange && handlerChange.to !== null && handlerChange.to !== handlerChange.from) {
    const actorId = (req.user as { id: number }).id;
    if (handlerChange.to !== actorId) {
      const newHandlerUserId = handlerChange.to;
      void (async () => {
        try {
          const result = await notifyHandlerAssigned({
            request: row,
            newHandlerUserId,
            senderUserId: actorId,
            logContext: { route: "member-360.data-requests.patch.assign", memberId },
          });
          await recordMemberAudit({
            req, organizationId: orgId, clubMemberId: memberId,
            entity: "data_request_handler_notification", entityId: id, action: "create",
            reason: `handler-assigned notice — handler:${newHandlerUserId}, in_app:${result.inAppMessageId ? "sent" : "skipped"}, push:${result.pushStatus}, email:${result.emailStatus}`,
            metadata: {
              handlerUserId: newHandlerUserId,
              previousHandlerUserId: handlerChange.from,
              inAppMessageId: result.inAppMessageId,
              pushStatus: result.pushStatus,
              pushError: result.pushError ?? null,
              emailStatus: result.emailStatus,
              emailError: result.emailError ?? null,
              emailRecipient: result.emailRecipient ?? null,
              deepLink: result.deepLink,
            },
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          baseLogger.error({ requestId: id, errMsg }, "[member-360] Failed to notify newly-assigned privacy handler");
        }
      })();
    }
  }

  // If status changed to a notifiable state, deliver the privacy-request notice.
  // Always creates an in-app message; email is best-effort and tracked on the row.
  const NOTIFIABLE: ReadonlySet<DataRequestEmailKind> = new Set(["in_progress", "completed", "rejected"]);
  if (status && status !== previous.status && NOTIFIABLE.has(status as DataRequestEmailKind)) {
    void (async () => {
      try {
        const result = await notifyDataRequest({
          organizationId: orgId,
          request: row,
          kind: status as DataRequestEmailKind,
          senderUserId: (req.user as { id: number }).id,
          logContext: { route: "member-360.data-requests.patch", memberId },
        });
        await recordMemberAudit({
          req, organizationId: orgId, clubMemberId: memberId,
          entity: "data_request_notification", entityId: id, action: "create",
          reason: `${status} notice — email:${result.emailStatus}, in_app:${result.inAppMessageId ? "sent" : "skipped"}, push:${result.pushStatus}, sms:${result.smsStatus}`,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        baseLogger.error({ requestId: id, errMsg }, "[member-360] Failed to deliver data-request status notice");
      }
    })();
  }

  res.json(row);
});

// Resend the last privacy-request notification (Task #186).
// Re-invokes notifyDataRequest for the last-sent kind without changing status.
// Falls back to "filed" if no prior notification was recorded (e.g. the row was
// just created and the initial acknowledgement bounced before being sent).
router.post("/:memberId/data-requests/:id/resend", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));

  const [request] = await db.select().from(memberDataRequestsTable)
    .where(and(eq(memberDataRequestsTable.id, id), eq(memberDataRequestsTable.clubMemberId, memberId)));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }

  // Always resend the most recently sent notice — never let the caller pick a
  // different kind. This keeps the audit trail honest: a manual resend reflects
  // the same notification that previously failed/needed retry. Falls back to
  // "filed" when no prior notification exists (e.g. the initial acknowledgement
  // bounced before lastNotificationKind was recorded).
  const NOTIFIABLE: ReadonlySet<DataRequestEmailKind> = new Set(["filed", "in_progress", "completed", "rejected", "completed_export", "export_expiring"]);
  const stored = (request.lastNotificationKind as DataRequestEmailKind | null) ?? "filed";
  if (!NOTIFIABLE.has(stored)) {
    res.status(400).json({ error: `Stored notification kind "${stored}" is not resendable.` }); return;
  }
  const kind: DataRequestEmailKind = stored;

  try {
    const result = await notifyDataRequest({
      organizationId: orgId,
      request,
      kind,
      senderUserId: (req.user as { id: number }).id,
      logContext: { route: "member-360.data-requests.resend", memberId },
    });
    // Re-read the row so the per-channel timestamps just persisted by
    // notifyDataRequest can be embedded in the audit metadata. This gives
    // the resend-history popover an authoritative per-channel timestamp +
    // provider error string for the hover tooltip without needing a
    // dedicated resend_attempts table.
    const [afterNotify] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, id));
    const nowIso = new Date().toISOString();
    const channels = {
      email: {
        status: result.emailStatus,
        at: afterNotify?.lastEmailAt ? new Date(afterNotify.lastEmailAt).toISOString() : null,
        error: result.emailError ?? null,
      },
      inApp: {
        status: result.inAppMessageId ? "sent" : "skipped",
        at: afterNotify?.lastInAppAt ? new Date(afterNotify.lastInAppAt).toISOString() : nowIso,
        error: null,
      },
      push: {
        status: result.pushStatus,
        at: afterNotify?.lastPushAt ? new Date(afterNotify.lastPushAt).toISOString() : null,
        error: result.pushError ?? null,
      },
      sms: {
        status: result.smsStatus,
        at: afterNotify?.lastSmsAt ? new Date(afterNotify.lastSmsAt).toISOString() : null,
        error: result.smsError ?? null,
      },
    };
    await recordMemberAudit({
      req, organizationId: orgId, clubMemberId: memberId,
      entity: "data_request_notification", entityId: id, action: "resend",
      reason: `${kind} notice resent — email:${result.emailStatus}, in_app:${result.inAppMessageId ? "sent" : "skipped"}, push:${result.pushStatus}, sms:${result.smsStatus}`,
      metadata: { kind, channels },
    });
    const [updated] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, id));
    res.json({ request: updated, result });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    baseLogger.error({ requestId: id, errMsg }, "[member-360] Failed to resend data-request notice");
    res.status(500).json({ error: "Failed to resend notification", detail: errMsg });
  }
});

// Force a single-channel retry for a privacy-request notice (Task #211).
// Lets admins re-attempt the last failed push or SMS delivery from Member 360
// without waiting for the cron. The underlying helpers gate on the row still
// being in `failed` state and the per-channel attempt cap not yet being hit.
router.post("/:memberId/data-requests/:id/retry-channel", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const channel = String(req.body?.channel ?? "").toLowerCase();
  if (channel !== "push" && channel !== "sms" && channel !== "whatsapp") {
    res.status(400).json({ error: "channel must be 'push', 'sms' or 'whatsapp'" }); return;
  }

  const [request] = await db.select().from(memberDataRequestsTable)
    .where(and(eq(memberDataRequestsTable.id, id), eq(memberDataRequestsTable.clubMemberId, memberId)));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }

  try {
    const result = channel === "push"
      ? await retryDataRequestPush({ request, logContext: { route: "member-360.data-requests.retry-channel", memberId, channel } })
      : channel === "sms"
        ? await retryDataRequestSms({ request, logContext: { route: "member-360.data-requests.retry-channel", memberId, channel } })
        : await retryDataRequestWhatsapp({ request, logContext: { route: "member-360.data-requests.retry-channel", memberId, channel } });

    if (!result) {
      res.status(409).json({ error: `${channel} channel is not eligible for retry (status not 'failed' or attempt cap reached).` });
      return;
    }

    // Task #316 — persist the same structured per-channel metadata that the
    // cron retry helper (recordCronRetryAudit) and full-resend handler write,
    // so the resend-history popover can surface the per-channel timestamp +
    // provider error tooltip for manual single-channel retries too.
    const at = new Date().toISOString();
    const channelDetail = { status: result.status, at, error: result.error ?? null };
    const channels: Record<string, { status: string; at: string; error: string | null }> = {};
    channels[channel] = channelDetail;
    const kind = (request.lastNotificationKind as string | null) ?? "filed";
    await recordMemberAudit({
      req, organizationId: orgId, clubMemberId: memberId,
      entity: "data_request_notification", entityId: id, action: "resend",
      reason: `manual ${channel} retry — ${channel}:${result.status}${result.exhausted ? " (exhausted)" : ""} attempt:${result.attempts}`,
      metadata: { kind, source: "manual-channel", channels },
    });

    const [updated] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, id));
    res.json({ request: updated, result });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    baseLogger.error({ requestId: id, channel, errMsg }, "[member-360] Failed to retry data-request channel");
    res.status(500).json({ error: "Failed to retry channel", detail: errMsg });
  }
});

// Generate full member-data export (for GDPR/DPDP article 20 / DPDP §11 export)
router.get("/:memberId/export", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const member = await loadMember(orgId, memberId);
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  const [ext, docs, consents, prefs, family, lifecycle, disc, notes, milestones, cards, msgs] = await Promise.all([
    db.select().from(memberProfileExtTable).where(eq(memberProfileExtTable.clubMemberId, memberId)),
    db.select().from(memberDocumentsTable).where(eq(memberDocumentsTable.clubMemberId, memberId)),
    db.select().from(memberConsentsTable).where(eq(memberConsentsTable.clubMemberId, memberId)),
    db.select().from(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, memberId)),
    db.select().from(memberFamilyLinksTable).where(eq(memberFamilyLinksTable.primaryMemberId, memberId)),
    db.select().from(memberLifecycleEventsTable).where(eq(memberLifecycleEventsTable.clubMemberId, memberId)),
    db.select().from(memberDisciplinaryTable).where(eq(memberDisciplinaryTable.clubMemberId, memberId)),
    db.select().from(memberInternalNotesTable).where(eq(memberInternalNotesTable.clubMemberId, memberId)),
    db.select().from(memberMilestonesTable).where(eq(memberMilestonesTable.clubMemberId, memberId)),
    db.select().from(memberAccessCardsTable).where(eq(memberAccessCardsTable.clubMemberId, memberId)),
    db.select().from(memberMessagesTable).where(eq(memberMessagesTable.clubMemberId, memberId)),
  ]);
  await recordMemberAudit({ req, organizationId: orgId, clubMemberId: memberId, entity: "profile", action: "view_pii", reason: "export" });
  res.setHeader("Content-Disposition", `attachment; filename="member-${memberId}-export.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    member, ext: ext[0] ?? null,
    documents: docs, consents, communicationPreferences: prefs,
    familyLinks: family, lifecycleEvents: lifecycle,
    disciplinary: disc, internalNotes: notes,
    milestones, accessCards: cards, messages: msgs,
  });
});

// ─── FINANCIAL LEDGER ────────────────────────────────────────────────────────

router.get("/:memberId/ledger", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const memberId = memberIdOf(req);
  const member = await loadMember(orgId, memberId);
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }

  const [charges, levyCharges, credit] = await Promise.all([
    db.select().from(memberAccountChargesTable)
      .where(eq(memberAccountChargesTable.clubMemberId, memberId))
      .orderBy(desc(memberAccountChargesTable.createdAt)),
    db.select({ charge: memberLevyChargesTable, levy: memberLeviesTable })
      .from(memberLevyChargesTable)
      .innerJoin(memberLeviesTable, eq(memberLevyChargesTable.levyId, memberLeviesTable.id))
      .where(eq(memberLevyChargesTable.clubMemberId, memberId)),
    (async () => {
      const [acct] = await db.select().from(storeCreditAccountsTable)
        .where(and(eq(storeCreditAccountsTable.memberId, memberId), eq(storeCreditAccountsTable.organizationId, orgId)));
      if (!acct) return [];
      return db.select().from(storeCreditTransactionsTable)
        .where(eq(storeCreditTransactionsTable.accountId, acct.id))
        .orderBy(desc(storeCreditTransactionsTable.createdAt))
        .limit(50);
    })(),
  ]);

  const outstanding = charges.reduce((s, c) =>
    c.isSettled ? s : s + parseFloat(String(c.amount ?? "0")), 0);
  const levyOutstanding = levyCharges.reduce((s, r) => {
    if (r.charge.status === "waived" || r.charge.status === "refunded") return s;
    const amt = parseFloat(String(r.charge.amount ?? "0"));
    const paid = parseFloat(String(r.charge.paidAmount ?? "0"));
    const refunded = parseFloat(String(r.charge.refundedAmount ?? "0"));
    const remaining = amt - paid - refunded;
    return s + (remaining > 0 ? remaining : 0);
  }, 0);

  res.json({
    accountCharges: charges,
    levyCharges,
    storeCreditHistory: credit,
    outstandingBalance: (outstanding + levyOutstanding).toFixed(2),
  });
});

// ─── LEVIES ──────────────────────────────────────────────────────────────────

router.get("/levies", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const rows = await db.select().from(memberLeviesTable)
    .where(eq(memberLeviesTable.organizationId, orgId))
    .orderBy(desc(memberLeviesTable.createdAt));
  res.json(rows);
});

/**
 * Club-wide levy financial summary (Task 230).
 *
 * Returns every levy in the org with aggregated totals (collected,
 * outstanding, refunded, waived) plus per-status counts. Powers the
 * "Finance / ledger" page, where treasurers reconcile the entire club
 * in one view rather than opening each per-levy dialog.
 *
 * Aggregation runs in a single grouped SQL query so the page stays fast
 * even with hundreds of levies. Levies with zero charges are still
 * included (LEFT JOIN) so newly-created levies show up.
 */
router.get("/levies-summary", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const rows = await db
    .select({
      id: memberLeviesTable.id,
      name: memberLeviesTable.name,
      description: memberLeviesTable.description,
      amount: memberLeviesTable.amount,
      currency: memberLeviesTable.currency,
      scope: memberLeviesTable.scope,
      dueDate: memberLeviesTable.dueDate,
      createdAt: memberLeviesTable.createdAt,
      chargesCount: sql<number>`coalesce(count(${memberLevyChargesTable.id}), 0)`,
      paidCount: sql<number>`coalesce(sum(case when ${memberLevyChargesTable.status} = 'paid' then 1 else 0 end), 0)`,
      partialCount: sql<number>`coalesce(sum(case when ${memberLevyChargesTable.status} = 'partial' then 1 else 0 end), 0)`,
      unpaidCount: sql<number>`coalesce(sum(case when ${memberLevyChargesTable.status} = 'unpaid' then 1 else 0 end), 0)`,
      waivedCount: sql<number>`coalesce(sum(case when ${memberLevyChargesTable.status} = 'waived' then 1 else 0 end), 0)`,
      refundedCount: sql<number>`coalesce(sum(case when ${memberLevyChargesTable.status} = 'refunded' then 1 else 0 end), 0)`,
      collected: sql<string>`coalesce(sum(coalesce(${memberLevyChargesTable.paidAmount}, 0)::numeric), 0)::text`,
      refunded: sql<string>`coalesce(sum(coalesce(${memberLevyChargesTable.refundedAmount}, 0)::numeric), 0)::text`,
      outstanding: sql<string>`coalesce(sum(case when ${memberLevyChargesTable.status} in ('unpaid','partial') then greatest(${memberLevyChargesTable.amount}::numeric - coalesce(${memberLevyChargesTable.paidAmount}, 0)::numeric - coalesce(${memberLevyChargesTable.refundedAmount}, 0)::numeric, 0) else 0 end), 0)::text`,
      waivedAmount: sql<string>`coalesce(sum(case when ${memberLevyChargesTable.status} = 'waived' then ${memberLevyChargesTable.amount}::numeric else 0 end), 0)::text`,
    })
    .from(memberLeviesTable)
    .leftJoin(memberLevyChargesTable, eq(memberLevyChargesTable.levyId, memberLeviesTable.id))
    .where(eq(memberLeviesTable.organizationId, orgId))
    .groupBy(memberLeviesTable.id)
    .orderBy(desc(memberLeviesTable.createdAt));

  // Club-wide totals across all currencies, bucketed by currency so a
  // multi-currency club gets one row per currency rather than a meaningless
  // sum across mixed units.
  const totalsByCurrency: Record<string, {
    collected: number; outstanding: number; refunded: number; waived: number;
    chargesCount: number; leviesCount: number;
  }> = {};
  for (const r of rows) {
    const cur = r.currency || "INR";
    const t = (totalsByCurrency[cur] ??= {
      collected: 0, outstanding: 0, refunded: 0, waived: 0,
      chargesCount: 0, leviesCount: 0,
    });
    t.collected += parseFloat(String(r.collected ?? "0"));
    t.outstanding += parseFloat(String(r.outstanding ?? "0"));
    t.refunded += parseFloat(String(r.refunded ?? "0"));
    t.waived += parseFloat(String(r.waivedAmount ?? "0"));
    t.chargesCount += Number(r.chargesCount ?? 0);
    t.leviesCount += 1;
  }

  res.json({
    levies: rows.map(r => ({
      ...r,
      chargesCount: Number(r.chargesCount ?? 0),
      paidCount: Number(r.paidCount ?? 0),
      partialCount: Number(r.partialCount ?? 0),
      unpaidCount: Number(r.unpaidCount ?? 0),
      waivedCount: Number(r.waivedCount ?? 0),
      refundedCount: Number(r.refundedCount ?? 0),
    })),
    totalsByCurrency,
  });
});

/**
 * Per-currency revenue + tax pivot (Task #449).
 *
 * Aggregates the unified `financial_ledger` by currency so the finance page
 * can show treasurers a side-by-side breakdown of how much was billed and
 * how much tax was collected in each currency the club operates in.
 *
 * Optional date filters (`from`, `to`, ISO date strings) narrow the pivot
 * to a custom window — defaults to "all time" so newly-onboarded clubs see
 * their existing history immediately.
 */
router.get("/revenue-by-currency", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const fromRaw = typeof req.query.from === "string" ? req.query.from : "";
  const toRaw = typeof req.query.to === "string" ? req.query.to : "";

  const where = [eq(financialLedgerTable.organizationId, orgId)];
  if (fromRaw) where.push(sql`${financialLedgerTable.transactionDate} >= ${fromRaw}`);
  if (toRaw) where.push(sql`${financialLedgerTable.transactionDate} <= ${toRaw}`);

  const byCurrencyRows = await db
    .select({
      currency: financialLedgerTable.currency,
      revenue: sql<string>`COALESCE(SUM(${financialLedgerTable.amount}::numeric), 0)::text`,
      tax: sql<string>`COALESCE(SUM(${financialLedgerTable.taxAmount}::numeric), 0)::text`,
      eventCount: sql<number>`COUNT(*)::int`,
    })
    .from(financialLedgerTable)
    .where(and(...where))
    .groupBy(financialLedgerTable.currency)
    .orderBy(financialLedgerTable.currency);

  const byCurrencyEventRows = await db
    .select({
      currency: financialLedgerTable.currency,
      eventType: financialLedgerTable.eventType,
      revenue: sql<string>`COALESCE(SUM(${financialLedgerTable.amount}::numeric), 0)::text`,
      tax: sql<string>`COALESCE(SUM(${financialLedgerTable.taxAmount}::numeric), 0)::text`,
      eventCount: sql<number>`COUNT(*)::int`,
    })
    .from(financialLedgerTable)
    .where(and(...where))
    .groupBy(financialLedgerTable.currency, financialLedgerTable.eventType)
    .orderBy(financialLedgerTable.currency, financialLedgerTable.eventType);

  res.json({
    byCurrency: byCurrencyRows.map(r => ({
      currency: r.currency,
      revenue: r.revenue ?? "0",
      tax: r.tax ?? "0",
      eventCount: Number(r.eventCount ?? 0),
    })),
    byCurrencyAndEventType: byCurrencyEventRows.map(r => ({
      currency: r.currency,
      eventType: r.eventType,
      revenue: r.revenue ?? "0",
      tax: r.tax ?? "0",
      eventCount: Number(r.eventCount ?? 0),
    })),
    range: { from: fromRaw || null, to: toRaw || null },
  });
});

/**
 * CSV export of the per-currency revenue & tax pivot (Task #494).
 *
 * Mirrors the filter contract of GET /revenue-by-currency (from/to date
 * strings are passed straight through to the same SQL predicate). One row per
 * (currency, eventType) so treasurers can drop the file into Excel or hand it
 * to auditors without further reshaping.
 */
/**
 * Shared builder for the per-currency revenue & tax pivot CSV (Task #494,
 * extracted in Task #669 so the on-demand download endpoint and the
 * scheduled-email cron emit byte-identical files).
 *
 * Filters mirror the on-demand contract: `from`/`to` may be either YYYY-MM-DD
 * strings (passed straight through to the date-typed `transaction_date`
 * column the way the original endpoint did) or `Date` objects (used by the
 * cron when it needs the elapsed period since `lastSentAt`).
 */
export async function buildRevenueByCurrencyCsv(opts: {
  orgId: number;
  from?: string | Date | null;
  to?: string | Date | null;
}): Promise<{ csv: string; rowCount: number; currencyCount: number }> {
  const { orgId, from, to } = opts;
  const where = [eq(financialLedgerTable.organizationId, orgId)];
  const fromVal = from instanceof Date ? from.toISOString() : (from || "");
  const toVal = to instanceof Date ? to.toISOString() : (to || "");
  if (fromVal) where.push(sql`${financialLedgerTable.transactionDate} >= ${fromVal}`);
  if (toVal) where.push(sql`${financialLedgerTable.transactionDate} <= ${toVal}`);

  const rows = await db
    .select({
      currency: financialLedgerTable.currency,
      eventType: financialLedgerTable.eventType,
      revenue: sql<string>`COALESCE(SUM(${financialLedgerTable.amount}::numeric), 0)::text`,
      tax: sql<string>`COALESCE(SUM(${financialLedgerTable.taxAmount}::numeric), 0)::text`,
      eventCount: sql<number>`COUNT(*)::int`,
    })
    .from(financialLedgerTable)
    .where(and(...where))
    .groupBy(financialLedgerTable.currency, financialLedgerTable.eventType)
    .orderBy(financialLedgerTable.currency, financialLedgerTable.eventType);

  const escape = (v: string | number | null | undefined): string => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["currency", "event_type", "revenue", "tax", "event_count"];
  const lines = [header.join(",")];
  const currencies = new Set<string>();
  for (const r of rows) {
    if (r.currency) currencies.add(r.currency);
    lines.push([
      escape(r.currency),
      escape(r.eventType),
      escape(r.revenue ?? "0"),
      escape(r.tax ?? "0"),
      escape(Number(r.eventCount ?? 0)),
    ].join(","));
  }
  return { csv: lines.join("\n") + "\n", rowCount: rows.length, currencyCount: currencies.size };
}

router.get("/revenue-by-currency.csv", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const fromRaw = typeof req.query.from === "string" ? req.query.from : "";
  const toRaw = typeof req.query.to === "string" ? req.query.to : "";

  const { csv } = await buildRevenueByCurrencyCsv({ orgId, from: fromRaw, to: toRaw });

  const suffix = [fromRaw, toRaw].filter(Boolean).join("_to_");
  const filename = `revenue-by-currency${suffix ? `-${suffix}` : ""}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

/**
 * Org-wide bounced-reminder summary (Task #213).
 *
 * Returns one entry per levy that currently has unresolved failed reminders
 * (i.e. the most-recent message per (member, channel) is still in `failed`
 * state and has not been superseded by a later successful send). Used by the
 * admin dashboard banner to surface delivery problems passively, without
 * requiring admins to open each levy detail dialog.
 *
 * Mirrors the unresolved-failure logic in GET /levies/:id/charges so the
 * counts the banner shows match what the retry endpoint will actually attempt.
 */
router.get("/levies/bounced-reminders", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  // Optional per-member filter (Task #243) so Member 360 can surface only the
  // bounced reminders for the member being viewed. The dashboard banner omits
  // the param to keep the org-wide aggregate behaviour unchanged.
  const memberIdRaw = typeof req.query.memberId === "string" ? req.query.memberId : "";
  const memberIdFilter = memberIdRaw ? parseInt(memberIdRaw, 10) : NaN;
  const result = await getBouncedLeviesForOrg(
    orgId,
    Number.isFinite(memberIdFilter) ? { memberId: memberIdFilter } : undefined,
  );
  res.json(result);
});

router.post("/levies", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const { name, description, amount, currency, scope, scopeFilter, dueDate } = req.body;
  if (!name || amount == null) { { res.status(400).json({ error: "name and amount required" }); return; } }
  const [row] = await db.insert(memberLeviesTable).values({
    organizationId: orgId, name, description,
    amount: String(amount), currency: currency ?? "INR",
    scope: scope ?? "all", scopeFilter,
    dueDate: dueDate ? new Date(dueDate) : null,
  }).returning();
  // Org-level audit (no specific member yet — that happens on /apply)
  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: null,
    entity: "levy_definition", entityId: row.id, action: "create",
    after: { name: row.name, amount: row.amount, currency: row.currency, scope: row.scope },
    reason: `Levy created: ${name}`,
  });
  res.status(201).json(row);
});

router.post("/levies/:id/apply", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }
  if (levy.status === "applied") { { res.status(400).json({ error: "Already applied" }); return; } }

  // Resolve target members
  let targets: number[] = [];
  if (levy.scope === "all") {
    const all = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
      .where(eq(clubMembersTable.organizationId, orgId));
    targets = all.map(x => x.id);
  } else if (levy.scope === "tier" && levy.scopeFilter?.tierIds?.length) {
    const all = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
      .where(and(eq(clubMembersTable.organizationId, orgId), inArray(clubMembersTable.tierId, levy.scopeFilter.tierIds)));
    targets = all.map(x => x.id);
  } else if (levy.scope === "manual" && levy.scopeFilter?.memberIds?.length) {
    // Tenant-isolation: only accept member ids that belong to this org
    const requested: number[] = levy.scopeFilter.memberIds.map((x: unknown) => Number(x)).filter((n: number) => Number.isFinite(n));
    if (requested.length === 0) { { res.status(400).json({ error: "scopeFilter.memberIds is empty" }); return; } }
    const valid = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
      .where(and(eq(clubMembersTable.organizationId, orgId), inArray(clubMembersTable.id, requested)));
    targets = valid.map((x) => x.id);
    // Cross-org member ids are silently dropped from `targets`. We do NOT
    // write rejected ids into member_audit_log because that table's rows
    // are read by org-scoped audit queries — writing a foreign clubMemberId
    // under our orgId would either contaminate another org's audit view
    // or fail FK consistency. The actual cross-org write is already
    // prevented by the `targets` filter above, which is the security boundary.
  }

  if (targets.length === 0) { { res.status(400).json({ error: "No target members for this scope" }); return; } }

  await db.insert(memberLevyChargesTable).values(
    targets.map((mid) => ({ levyId: id, clubMemberId: mid, amount: levy.amount })),
  ).onConflictDoNothing();

  const [updated] = await db.update(memberLeviesTable).set({
    status: "applied", appliedAt: new Date(),
    appliedByUserId: (req.user as { id: number }).id,
  }).where(eq(memberLeviesTable.id, id)).returning();

  // Per-member audit so each affected member's audit log shows the levy
  for (const mid of targets) {
    await recordMemberAudit({
      req, organizationId: orgId, clubMemberId: mid,
      entity: "levy_charge", entityId: id, action: "create",
      reason: `Levy applied: ${levy.name} (${levy.amount} ${levy.currency})`,
    });
  }

  res.json({ ...updated, appliedToCount: targets.length });
});

// ─── LEVY CHARGES (per-member payment tracking) ──────────────────────────────

router.get("/levies/:id/charges", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }
  const rows = await db
    .select({
      id: memberLevyChargesTable.id,
      clubMemberId: memberLevyChargesTable.clubMemberId,
      amount: memberLevyChargesTable.amount,
      paid: memberLevyChargesTable.paid,
      paidAt: memberLevyChargesTable.paidAt,
      status: memberLevyChargesTable.status,
      paidAmount: memberLevyChargesTable.paidAmount,
      refundedAmount: memberLevyChargesTable.refundedAmount,
      waivedReason: memberLevyChargesTable.waivedReason,
      createdAt: memberLevyChargesTable.createdAt,
      // Latest receipt-email delivery outcome (Task 222) so admins can see
      // whether the most recent payment/refund/waiver receipt actually went
      // out and decide whether to resend.
      lastReceiptStatus: memberLevyChargesTable.lastReceiptStatus,
      lastReceiptReason: memberLevyChargesTable.lastReceiptReason,
      lastReceiptKind: memberLevyChargesTable.lastReceiptKind,
      lastReceiptAmount: memberLevyChargesTable.lastReceiptAmount,
      lastReceiptAt: memberLevyChargesTable.lastReceiptAt,
      memberNumber: clubMembersTable.memberNumber,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
    })
    .from(memberLevyChargesTable)
    .innerJoin(clubMembersTable, eq(memberLevyChargesTable.clubMemberId, clubMembersTable.id))
    .where(and(
      eq(memberLevyChargesTable.levyId, id),
      eq(clubMembersTable.organizationId, orgId),
    ))
    .orderBy(asc(clubMembersTable.lastName), asc(clubMembersTable.firstName));
  let collected = 0, outstanding = 0, refunded = 0, waived = 0;
  let paidCount = 0, partialCount = 0, unpaidCount = 0, waivedCount = 0, refundedCount = 0;
  // Task #254: surface how many of this levy's charges have a failed/skipped
  // receipt as the most recent delivery so admins can bulk-retry. Only count
  // charges that actually have a recorded receipt (lastReceiptKind set), so
  // un-receipted unpaid charges aren't lumped in.
  let failedReceiptCount = 0;
  let skippedReceiptCount = 0;
  for (const r of rows) {
    const amt = parseFloat(r.amount);
    const p = parseFloat(String(r.paidAmount ?? "0"));
    const ref = parseFloat(String(r.refundedAmount ?? "0"));
    collected += p;
    refunded += ref;
    if (r.lastReceiptKind && r.lastReceiptStatus === "failed") failedReceiptCount++;
    else if (r.lastReceiptKind && r.lastReceiptStatus === "skipped") skippedReceiptCount++;
    if (r.status === "waived") { waived += amt; waivedCount++; continue; }
    if (r.status === "refunded") { refundedCount++; continue; }
    if (r.status === "paid") { paidCount++; continue; }
    if (r.status === "partial") { partialCount++; outstanding += Math.max(0, amt - p - ref); continue; }
    unpaidCount++;
    outstanding += Math.max(0, amt - p - ref);
  }
  // Per-channel reminder delivery summary so admins see at a glance how many
  // reminders bounced (and on which channel) without scrolling Member 360.
  // We compute two views:
  //   * historical totals (every send/failure ever recorded for this levy), and
  //   * unresolved failures — the latest failure per (member,channel) that has
  //     not been superseded by a later successful send. The retry CTA uses the
  //     unresolved view so the count it shows matches what the retry endpoint
  //     will actually attempt.
  const reminderMsgs = await db
    .select({
      clubMemberId: memberMessagesTable.clubMemberId,
      channel: memberMessagesTable.channel,
      status: memberMessagesTable.status,
      sentAt: memberMessagesTable.sentAt,
    })
    .from(memberMessagesTable)
    .where(and(
      eq(memberMessagesTable.organizationId, orgId),
      eq(memberMessagesTable.relatedEntity, "levy"),
      eq(memberMessagesTable.relatedEntityId, id),
    ))
    .orderBy(desc(memberMessagesTable.sentAt));
  let reminderSent = 0, reminderFailed = 0, reminderSkipped = 0;
  const reminderByChannel: Record<string, { sent: number; failed: number; skipped: number; unresolvedFailed: number }> = {};
  // Track the most recent message per (member,channel) to determine whether
  // the latest state is failed (=> still actionable) or sent (=> resolved).
  const latestByPair = new Map<string, { status: string; channel: string }>();
  for (const r of reminderMsgs) {
    const ch = (reminderByChannel[r.channel] ??= { sent: 0, failed: 0, skipped: 0, unresolvedFailed: 0 });
    if (r.status === "failed") { reminderFailed++; ch.failed++; }
    else if (r.status === "skipped") { reminderSkipped++; ch.skipped++; }
    else { reminderSent++; ch.sent++; }
    const key = `${r.clubMemberId}::${r.channel}`;
    if (!latestByPair.has(key)) latestByPair.set(key, { status: r.status ?? "sent", channel: r.channel });
  }
  let reminderUnresolvedFailed = 0;
  for (const v of latestByPair.values()) {
    if (v.status === "failed") {
      reminderUnresolvedFailed++;
      const ch = (reminderByChannel[v.channel] ??= { sent: 0, failed: 0, skipped: 0, unresolvedFailed: 0 });
      ch.unresolvedFailed++;
    }
  }

  res.json({
    levy,
    charges: rows,
    summary: {
      total: rows.length,
      paidCount,
      partialCount,
      unpaidCount,
      waivedCount,
      refundedCount,
      collected: collected.toFixed(2),
      outstanding: outstanding.toFixed(2),
      refunded: refunded.toFixed(2),
      waived: waived.toFixed(2),
      currency: levy.currency,
      reminderSentCount: reminderSent,
      reminderFailedCount: reminderFailed,
      reminderSkippedCount: reminderSkipped,
      reminderUnresolvedFailedCount: reminderUnresolvedFailed,
      reminderByChannel,
      // Task #254 — failed/skipped receipt counts so the bulk-resend CTA can
      // show "Resend N failed receipts" without the client recomputing.
      failedReceiptCount,
      skippedReceiptCount,
    },
  });
});

/**
 * Resolve a charge after authorising the request. Returns null + a sent
 * response when the charge cannot be located in this org.
 */
async function resolveCharge(
  req: Request, res: Response, orgId: number, levyId: number, memberId: number,
) {
  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, levyId), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { res.status(404).json({ error: "Levy not found" }); return null; }
  const [member] = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));
  if (!member) { res.status(404).json({ error: "Member not found in this organization" }); return null; }
  const [charge] = await db.select().from(memberLevyChargesTable)
    .where(and(eq(memberLevyChargesTable.levyId, levyId), eq(memberLevyChargesTable.clubMemberId, memberId)));
  if (!charge) { res.status(404).json({ error: "Charge not found" }); return null; }
  return { levy, charge };
}

const ROUND2 = (n: number) => Math.round(n * 100) / 100;

const LEVY_PAYMENT_METHODS = new Set([
  "cash", "card", "bank_transfer", "online", "cheque", "credit_note", "other",
]);

/**
 * Persist the latest receipt-email delivery outcome on a levy charge (Task 222).
 * Best-effort: a write failure here must never break the calling financial
 * operation, since the underlying payment / refund / waiver has already
 * succeeded and is recorded in the audit log + ledger.
 */
async function persistReceiptStatus(chargeId: number, opts: {
  kind: "payment" | "partial_payment" | "refund" | "waiver";
  amount: number;
  note: string | null;
  result: { status: "sent" | "skipped" | "failed"; reason?: string };
}): Promise<void> {
  try {
    await db.update(memberLevyChargesTable).set({
      lastReceiptStatus: opts.result.status,
      lastReceiptReason: opts.result.reason ?? null,
      lastReceiptKind: opts.kind,
      lastReceiptAmount: ROUND2(Math.max(0, opts.amount)).toFixed(2),
      lastReceiptNote: opts.note,
      lastReceiptAt: new Date(),
    }).where(eq(memberLevyChargesTable.id, chargeId));
  } catch (err) {
    baseLogger.error({ chargeId, errMsg: err instanceof Error ? err.message : String(err) },
      "[levy-receipt] failed to persist receipt status");
  }
}

/**
 * Append one entry to the itemised levy charge ledger (Task 199).
 * Mirrors the actor extraction used by `recordMemberAudit` so the
 * ledger is human-readable without joining back to app_users.
 */
async function recordLevyChargeEvent(opts: {
  req: Request;
  organizationId: number;
  clubMemberId: number;
  chargeId: number;
  eventType: "payment" | "refund" | "waive";
  amount: number;
  method?: string | null;
  processorReference?: string | null;
  note?: string | null;
  reason?: string | null;
}): Promise<void> {
  const user = opts.req.user as { id?: number; displayName?: string; email?: string } | undefined;
  let actorName: string | null = user?.displayName ?? user?.email ?? null;
  if (!actorName && user?.id) {
    const [u] = await db.select({ displayName: appUsersTable.displayName, email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, user.id));
    actorName = u?.displayName ?? u?.email ?? null;
  }
  try {
    await db.insert(memberLevyChargeEventsTable).values({
      organizationId: opts.organizationId,
      clubMemberId: opts.clubMemberId,
      chargeId: opts.chargeId,
      eventType: opts.eventType,
      amount: ROUND2(Math.max(0, opts.amount)).toFixed(2),
      method: opts.method ?? null,
      processorReference: opts.processorReference ?? null,
      note: opts.note ?? null,
      reason: opts.reason ?? null,
      actorUserId: user?.id ?? null,
      actorName,
    });
  } catch (err) {
    // Ledger failures must never break the primary financial operation;
    // the running totals on the charge row remain authoritative.
    console.error("[levy-ledger] failed to record event", err);
  }
}

/**
 * Apply a payment (full or partial) to a levy charge, atomically updating
 * paidAmount/status and recording an audit entry. Used by:
 *   - the staff console (admin-recorded payment)
 *   - the member portal (online payment, after Razorpay signature verification)
 *   - the Razorpay webhook (canonical/idempotent confirmation)
 *
 * Idempotency: when `providerPaymentId` is supplied, a row is inserted into
 * `member_levy_charge_payments` inside the same transaction as the charge
 * update. The (provider, providerPaymentId) unique index causes duplicate
 * webhooks / double-clicks to fail the insert; we catch it and return
 * `code: 'already_applied'` without re-applying funds.
 */
export interface ApplyLevyPaymentSuccess {
  ok: true;
  charge: typeof memberLevyChargesTable.$inferSelect;
  remainingBalance: string;
  appliedAmount: number;
  fullySettled: boolean;
}
export interface ApplyLevyPaymentFailure {
  ok: false;
  status: number;
  error: string;
  code?: "already_applied" | "not_found" | "invalid" | "settled" | "waived";
}
export type ApplyLevyPaymentResult = ApplyLevyPaymentSuccess | ApplyLevyPaymentFailure;

export async function applyLevyChargePayment(opts: {
  /** Authenticated request (admin/portal); pass null for system contexts (webhook). */
  req: Request | null;
  organizationId: number;
  levyId: number;
  clubMemberId: number;
  amount: number;
  source: "admin" | "member_online" | "webhook";
  providerPaymentId?: string;
  providerOrderId?: string;
  note?: string | null;
}): Promise<ApplyLevyPaymentResult> {
  const { organizationId, levyId, clubMemberId } = opts;
  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, levyId), eq(memberLeviesTable.organizationId, organizationId)));
  if (!levy) return { ok: false, status: 404, error: "Levy not found", code: "not_found" };

  if (!Number.isFinite(opts.amount) || opts.amount <= 0) {
    return { ok: false, status: 400, error: "amount must be a positive number", code: "invalid" };
  }
  const payAmount = ROUND2(opts.amount);
  const provider = opts.providerPaymentId ? "razorpay" : "manual";
  const noteTrim = typeof opts.note === "string" && opts.note.trim() ? opts.note.trim() : null;

  // Run charge update + ledger insert + audit insert atomically.
  // The ledger row's unique (provider, providerPaymentId) index is the
  // authoritative idempotency marker — duplicate webhooks/double-clicks
  // raise a unique-violation that we catch and translate to `already_applied`.
  type TxResult =
    | { kind: "ok"; updated: typeof memberLevyChargesTable.$inferSelect; payAmount: number; remaining: number; fullySettled: boolean }
    | { kind: "err"; status: number; error: string; code: ApplyLevyPaymentFailure["code"] };

  let txResult: TxResult;
  try {
    txResult = await db.transaction(async (tx): Promise<TxResult> => {
      // Lock the charge row for the duration of the transaction so concurrent
      // webhook + portal verifications can't both read the same `paidAmount`.
      const lockedRows = await tx.execute<{ id: number; amount: string; paid_amount: string; refunded_amount: string; status: string; paid_at: Date | null }>(sql`
        SELECT id, amount, paid_amount, refunded_amount, status, paid_at
        FROM member_levy_charges
        WHERE levy_id = ${levyId} AND club_member_id = ${clubMemberId}
        FOR UPDATE
      `);
      const lockedRow = (lockedRows as unknown as { rows: Array<{ id: number; amount: string; paid_amount: string; refunded_amount: string; status: string; paid_at: Date | null }> }).rows?.[0]
        ?? (Array.isArray(lockedRows) ? (lockedRows as unknown as Array<{ id: number; amount: string; paid_amount: string; refunded_amount: string; status: string; paid_at: Date | null }>)[0] : undefined);
      if (!lockedRow) return { kind: "err", status: 404, error: "Charge not found", code: "not_found" };
      if (lockedRow.status === "waived") return { kind: "err", status: 400, error: "Charge is waived", code: "waived" };
      if (lockedRow.status === "refunded") return { kind: "err", status: 400, error: "Charge is refunded", code: "settled" };

      const amt = parseFloat(String(lockedRow.amount));
      const alreadyPaid = parseFloat(String(lockedRow.paid_amount ?? "0"));
      const refunded = parseFloat(String(lockedRow.refunded_amount ?? "0"));
      const remainingBefore = ROUND2(amt - alreadyPaid - refunded);
      if (remainingBefore <= 0) return { kind: "err", status: 400, error: "Charge already settled", code: "settled" };
      if (payAmount > remainingBefore + 0.0001) {
        return { kind: "err", status: 400, error: `Payment of ${payAmount} exceeds remaining balance ${remainingBefore}`, code: "invalid" };
      }
      const newPaid = ROUND2(alreadyPaid + payAmount);
      const remainingAfter = ROUND2(amt - refunded - newPaid);
      const fullySettled = remainingAfter <= 0.0001;
      const newStatus = fullySettled ? "paid" : "partial";

      // Insert ledger row first — uniqueness violation aborts the txn.
      await tx.insert(memberLevyChargePaymentsTable).values({
        levyChargeId: lockedRow.id,
        organizationId,
        clubMemberId,
        amount: payAmount.toFixed(2),
        currency: levy.currency,
        provider,
        providerPaymentId: opts.providerPaymentId ?? null,
        providerOrderId: opts.providerOrderId ?? null,
        source: opts.source === "member_online" ? "portal" : opts.source === "webhook" ? "webhook" : "admin",
        notes: noteTrim,
      });

      const [updated] = await tx.update(memberLevyChargesTable)
        .set({
          paidAmount: newPaid.toFixed(2),
          paid: fullySettled,
          paidAt: fullySettled ? new Date() : lockedRow.paid_at,
          status: newStatus,
        })
        .where(eq(memberLevyChargesTable.id, lockedRow.id))
        .returning();

      // Audit row inside the transaction so it commits atomically with the
      // payment. We bypass the best-effort wrapper and insert directly.
      const sourceLabel =
        opts.source === "member_online" ? "online (member)" :
        opts.source === "webhook" ? "online (webhook)" : "manual";
      const idMarker = opts.providerPaymentId ? ` [rzp:${opts.providerPaymentId}]` : "";
      const orderMarker = opts.providerOrderId ? ` [order:${opts.providerOrderId}]` : "";
      const reason = fullySettled
        ? `Levy "${levy.name}" paid in full ${payAmount} ${levy.currency} via ${sourceLabel}${noteTrim ? ` — ${noteTrim}` : ""}${idMarker}${orderMarker}`
        : `Levy "${levy.name}" partial payment ${payAmount} ${levy.currency} via ${sourceLabel} — balance ${remainingAfter} ${levy.currency}${noteTrim ? ` — ${noteTrim}` : ""}${idMarker}${orderMarker}`;
      const reqUser = (opts.req?.user ?? undefined) as { id?: number; role?: string; displayName?: string; email?: string } | undefined;
      await tx.insert(memberAuditLogTable).values({
        organizationId,
        clubMemberId,
        actorUserId: reqUser?.id ?? null,
        actorName: reqUser?.displayName ?? reqUser?.email ?? (opts.req ? null : "system"),
        actorRole: reqUser?.role ?? null,
        entity: "levy_charge",
        entityId: lockedRow.id,
        action: "update",
        fieldChanges: {
          paidAmount: { from: lockedRow.paid_amount, to: updated.paidAmount },
          status: { from: lockedRow.status, to: updated.status },
        },
        reason,
        ipAddress: (opts.req?.ip ?? (opts.req?.headers?.["x-forwarded-for"] as string | undefined) ?? null) as string | null,
        userAgent: (opts.req?.headers?.["user-agent"] as string | undefined) ?? null,
      });

      return { kind: "ok", updated, payAmount, remaining: remainingAfter, fullySettled };
    });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    // Postgres unique violation = 23505. drizzle/pg surfaces it via err.code or message.
    const code = (err as { code?: string } | undefined)?.code;
    if (
      code === "23505" ||
      msg.includes("member_levy_charge_payments_provider_unique") ||
      msg.includes("duplicate key")
    ) {
      return { ok: false, status: 200, error: "Already applied", code: "already_applied" };
    }
    throw err;
  }

  if (txResult.kind === "err") {
    return { ok: false, status: txResult.status, error: txResult.error, code: txResult.code };
  }

  // Itemised payment ledger (Task #199). Best-effort and outside the
  // transaction — the payments table above is the authoritative idempotency
  // record; this ledger is for human-readable history.
  if (opts.req) {
    const ledgerMethod =
      opts.source === "member_online" ? "razorpay_online" :
      opts.source === "webhook" ? "razorpay_webhook" : null;
    const processorReference = opts.providerPaymentId ?? opts.providerOrderId ?? null;
    await recordLevyChargeEvent({
      req: opts.req,
      organizationId,
      clubMemberId,
      chargeId: txResult.updated.id,
      eventType: "payment",
      amount: txResult.payAmount,
      method: ledgerMethod,
      processorReference,
      note: noteTrim,
    });
  }

  // Send receipt email (best-effort, honours billing channel pref).
  // Outside the DB transaction since it does network I/O. Runs for every
  // caller (admin console, member portal, webhook) so online payments
  // also generate a receipt. Persist the delivery outcome so admins can
  // see status + resend (Task #222).
  const receiptKind = txResult.fullySettled ? "payment" : "partial_payment";
  const receiptResult = await sendLevyReceipt({
    organizationId,
    clubMemberId,
    levyName: levy.name,
    currency: levy.currency,
    kind: receiptKind,
    transactionAmount: txResult.payAmount,
    newBalance: ROUND2(txResult.remaining),
    note: noteTrim,
    chargeId: txResult.updated.id,
  });
  await persistReceiptStatus(txResult.updated.id, {
    kind: receiptKind, amount: txResult.payAmount, note: noteTrim, result: receiptResult,
  });

  return {
    ok: true,
    charge: txResult.updated,
    remainingBalance: ROUND2(txResult.remaining).toFixed(2),
    appliedAmount: txResult.payAmount,
    fullySettled: txResult.fullySettled,
  };
}

/**
 * Record a payment (full or partial) against a levy charge.
 * Body: { amount: number, note?: string }
 *   - amount may be a partial value; cumulative paidAmount cannot exceed
 *     (amount - refundedAmount).
 */
router.post("/levies/:id/charges/:memberId/payment", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const memberId = memberIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim() : null;
  const result = await applyLevyChargePayment({
    req,
    organizationId: orgId,
    levyId: id,
    clubMemberId: memberId,
    amount: Number(req.body?.amount),
    source: "admin",
    note,
  });
  if (!result.ok) { { res.status(result.status).json({ error: result.error }); return; } }
  res.json({ ...result.charge, remainingBalance: result.remainingBalance });
});

/**
 * Back-compat: /pay records a full-balance payment.
 * Front-end and integrations that still call this endpoint keep working.
 */
router.post("/levies/:id/charges/:memberId/pay", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const memberId = memberIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const resolved = await resolveCharge(req, res, orgId, id, memberId);
  if (!resolved) return;
  const { levy, charge } = resolved;
  if (charge.status === "paid") { { res.json(charge); return; } }
  if (charge.status === "waived" || charge.status === "refunded") {
    res.status(400).json({ error: `Charge is ${charge.status}` }); return;
  }
  const amt = parseFloat(String(charge.amount));
  const refunded = parseFloat(String(charge.refundedAmount ?? "0"));
  const newPaid = ROUND2(amt - refunded);
  const now = new Date();
  const [updated] = await db.update(memberLevyChargesTable)
    .set({ paid: true, paidAt: now, status: "paid", paidAmount: newPaid.toFixed(2) })
    .where(eq(memberLevyChargesTable.id, charge.id))
    .returning();
  // Record only the delta paid by this call so the ledger sums match paidAmount.
  const alreadyPaidBefore = parseFloat(String(charge.paidAmount ?? "0"));
  const deltaPaid = ROUND2(newPaid - alreadyPaidBefore);
  if (deltaPaid > 0) {
    await recordLevyChargeEvent({
      req, organizationId: orgId, clubMemberId: memberId, chargeId: charge.id,
      eventType: "payment", amount: deltaPaid,
      note: "Marked paid (full balance)",
    });
  }
  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: memberId,
    entity: "levy_charge", entityId: charge.id, action: "update",
    reason: `Levy "${levy.name}" marked paid (${updated.amount} ${levy.currency})`,
  });
  // Best-effort receipt email (honours billing channel pref) + persist outcome.
  const payReceiptAmt = ROUND2(amt - refunded - parseFloat(String(charge.paidAmount ?? "0")));
  const payReceipt = await sendLevyReceipt({
    organizationId: orgId,
    clubMemberId: memberId,
    levyName: levy.name,
    currency: levy.currency,
    kind: "payment",
    transactionAmount: payReceiptAmt,
    newBalance: 0,
    note: null,
    chargeId: charge.id,
  });
  await persistReceiptStatus(charge.id, {
    kind: "payment", amount: payReceiptAmt, note: null, result: payReceipt,
  });
  res.json(updated);
});

/**
 * Record a refund against a levy charge.
 * Body: { amount: number, reason: string }
 *   - cumulative refundedAmount cannot exceed paidAmount.
 *   - reason is required and captured in the audit log.
 *   - When the entire paid amount has been refunded the status becomes
 *     'refunded'; otherwise it falls back to 'partial' or 'unpaid'.
 */
router.post("/levies/:id/charges/:memberId/refund", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const memberId = memberIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const resolved = await resolveCharge(req, res, orgId, id, memberId);
  if (!resolved) return;
  const { levy, charge } = resolved;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) { { res.status(400).json({ error: "reason is required for refunds" }); return; } }
  const rawAmount = Number(req.body?.amount);
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    res.status(400).json({ error: "amount must be a positive number" }); return;
  }
  const amt = parseFloat(String(charge.amount));
  const alreadyPaid = parseFloat(String(charge.paidAmount ?? "0"));
  const alreadyRefunded = parseFloat(String(charge.refundedAmount ?? "0"));
  const refundable = ROUND2(alreadyPaid - alreadyRefunded);
  if (refundable <= 0) { { res.status(400).json({ error: "Nothing available to refund" }); return; } }
  const refundAmount = ROUND2(rawAmount);
  if (refundAmount > refundable + 0.0001) {
    res.status(400).json({ error: `Refund ${refundAmount} exceeds refundable amount ${refundable}` }); return;
  }
  const newRefunded = ROUND2(alreadyRefunded + refundAmount);
  // Determine new status. If everything paid has been refunded:
  //   - and nothing is still outstanding (i.e. paidAmount==amount), status='refunded'
  //   - otherwise revert to 'unpaid'/'partial' based on what was actually paid.
  let status: string;
  const remainingBalance = ROUND2(amt - alreadyPaid - newRefunded);
  if (newRefunded >= alreadyPaid - 0.0001 && remainingBalance <= 0.0001) {
    status = "refunded";
  } else if (alreadyPaid - newRefunded <= 0.0001) {
    status = "unpaid";
  } else if (remainingBalance <= 0.0001) {
    status = "paid";
  } else {
    status = "partial";
  }
  const [updated] = await db.update(memberLevyChargesTable)
    .set({
      refundedAmount: newRefunded.toFixed(2),
      status,
      paid: status === "paid",
      paidAt: status === "paid" ? charge.paidAt : (status === "refunded" ? charge.paidAt : null),
    })
    .where(eq(memberLevyChargesTable.id, charge.id))
    .returning();
  const rawRefundMethod = typeof req.body?.method === "string" ? req.body.method.trim().toLowerCase() : "";
  const refundMethod = rawRefundMethod && LEVY_PAYMENT_METHODS.has(rawRefundMethod) ? rawRefundMethod : null;
  const refundProcessorReference = typeof req.body?.processorReference === "string" && req.body.processorReference.trim()
    ? req.body.processorReference.trim() : null;
  await recordLevyChargeEvent({
    req, organizationId: orgId, clubMemberId: memberId, chargeId: charge.id,
    eventType: "refund", amount: refundAmount,
    method: refundMethod, processorReference: refundProcessorReference, reason,
  });
  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: memberId,
    entity: "levy_charge", entityId: charge.id, action: "update",
    changes: {
      refundedAmount: { from: charge.refundedAmount, to: updated.refundedAmount },
      status: { from: charge.status, to: updated.status },
    },
    reason: `Levy "${levy.name}" refund ${refundAmount} ${levy.currency} — ${reason}`,
  });
  // Best-effort refund receipt email (honours billing channel pref) + persist outcome.
  const refundReceipt = await sendLevyReceipt({
    organizationId: orgId,
    clubMemberId: memberId,
    levyName: levy.name,
    currency: levy.currency,
    kind: "refund",
    transactionAmount: refundAmount,
    newBalance: Math.max(0, remainingBalance),
    note: reason,
    chargeId: charge.id,
  });
  await persistReceiptStatus(charge.id, {
    kind: "refund", amount: refundAmount, note: reason, result: refundReceipt,
  });
  res.json(updated);
});

/**
 * Waive (write off) the remaining balance of a levy charge.
 * Body: { reason: string }
 *   - Sets status='waived'. paidAmount/refundedAmount are preserved so the
 *     audit trail still shows what was paid before the write-off.
 */
router.post("/levies/:id/charges/:memberId/waive", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const memberId = memberIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const resolved = await resolveCharge(req, res, orgId, id, memberId);
  if (!resolved) return;
  const { levy, charge } = resolved;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) { { res.status(400).json({ error: "reason is required to waive a charge" }); return; } }
  if (charge.status === "waived") { { res.json(charge); return; } }
  if (charge.status === "paid" || charge.status === "refunded") {
    res.status(400).json({ error: `Cannot waive a ${charge.status} charge` }); return;
  }
  const [updated] = await db.update(memberLevyChargesTable)
    .set({ status: "waived", waivedReason: reason })
    .where(eq(memberLevyChargesTable.id, charge.id))
    .returning();
  const amtTotal = parseFloat(String(charge.amount));
  const paidBefore = parseFloat(String(charge.paidAmount ?? "0"));
  const refundedBefore = parseFloat(String(charge.refundedAmount ?? "0"));
  const writtenOff = ROUND2(Math.max(0, amtTotal - paidBefore - refundedBefore));
  await recordLevyChargeEvent({
    req, organizationId: orgId, clubMemberId: memberId, chargeId: charge.id,
    eventType: "waive", amount: writtenOff, reason,
  });
  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: memberId,
    entity: "levy_charge", entityId: charge.id, action: "update",
    changes: { status: { from: charge.status, to: "waived" } },
    reason: `Levy "${levy.name}" waived (${charge.amount} ${levy.currency}) — ${reason}`,
  });
  // Best-effort waiver receipt email (honours billing channel pref) + persist outcome.
  const waivedAmt = parseFloat(String(charge.amount))
    - parseFloat(String(charge.paidAmount ?? "0"))
    - parseFloat(String(charge.refundedAmount ?? "0"));
  const waiverAmt = ROUND2(Math.max(0, waivedAmt));
  const waiverReceipt = await sendLevyReceipt({
    organizationId: orgId,
    clubMemberId: memberId,
    levyName: levy.name,
    currency: levy.currency,
    kind: "waiver",
    transactionAmount: waiverAmt,
    newBalance: 0,
    note: reason,
    chargeId: charge.id,
  });
  await persistReceiptStatus(charge.id, {
    kind: "waiver", amount: waiverAmt, note: reason, result: waiverReceipt,
  });
  res.json(updated);
});

/**
 * Itemised payment ledger for a single levy charge (Task 199).
 * Returns each payment / refund / waive event with actor, amount,
 * method, and processor reference. Charge totals are still served by
 * GET /levies/:id/charges; this endpoint feeds the per-charge timeline.
 */
router.get("/levies/:id/charges/:memberId/events", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const memberId = memberIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const resolved = await resolveCharge(req, res, orgId, id, memberId);
  if (!resolved) return;
  const events = await db
    .select({
      id: memberLevyChargeEventsTable.id,
      eventType: memberLevyChargeEventsTable.eventType,
      amount: memberLevyChargeEventsTable.amount,
      method: memberLevyChargeEventsTable.method,
      processorReference: memberLevyChargeEventsTable.processorReference,
      note: memberLevyChargeEventsTable.note,
      reason: memberLevyChargeEventsTable.reason,
      actorUserId: memberLevyChargeEventsTable.actorUserId,
      actorName: memberLevyChargeEventsTable.actorName,
      occurredAt: memberLevyChargeEventsTable.occurredAt,
      reversesEventId: memberLevyChargeEventsTable.reversesEventId,
    })
    .from(memberLevyChargeEventsTable)
    .where(and(
      eq(memberLevyChargeEventsTable.chargeId, resolved.charge.id),
      eq(memberLevyChargeEventsTable.organizationId, orgId),
    ))
    .orderBy(asc(memberLevyChargeEventsTable.occurredAt), asc(memberLevyChargeEventsTable.id));
  // Mark which events have been reversed and surface who/when did it (Task #235)
  // so the UI can explain inline why "Reverse" is unavailable instead of only
  // hiding the button.
  const reversalByOriginal = new Map<
    number,
    { reversedByEventId: number; reversedAt: string | null; reversedByActorName: string | null }
  >();
  for (const ev of events) {
    if (ev.eventType === "reversal" && ev.reversesEventId != null) {
      reversalByOriginal.set(ev.reversesEventId, {
        reversedByEventId: ev.id,
        reversedAt: ev.occurredAt ? new Date(ev.occurredAt).toISOString() : null,
        reversedByActorName: ev.actorName,
      });
    }
  }
  // Walk the events chronologically and keep a running tally of paid /
  // refunded / active-waive so each row carries the outstanding balance
  // after it was applied (Task #303). Reversals back out the original
  // entry so the timeline matches what the per-charge totals converge to.
  // Conventions match the reverse endpoint:
  //   - normal:  runningBalance = max(0, chargeAmount - paid - refunded)
  //   - waived:  runningBalance = 0 while at least one waive is active
  // so treasurers reconciling against bank statements see the same number
  // the charge itself ends up at.
  const chargeAmount = parseFloat(String(resolved.charge.amount));
  const eventsById = new Map(events.map(e => [e.id, e] as const));
  let runningPaid = 0;
  let runningRefunded = 0;
  // Track ids of currently-active waive entries (waive applied and not later
  // reversed). While at least one is active the charge is written off, so
  // the running balance is 0 — matching the "waived" status the reverse
  // endpoint produces. Reversing a waive removes it from this set and the
  // balance reverts to chargeAmount - paid - refunded.
  const activeWaiveIds = new Set<number>();
  const enriched = events.map(ev => {
    const amt = parseFloat(String(ev.amount));
    if (ev.eventType === "payment") {
      runningPaid = ROUND2(runningPaid + amt);
    } else if (ev.eventType === "refund") {
      runningRefunded = ROUND2(runningRefunded + amt);
    } else if (ev.eventType === "waive") {
      activeWaiveIds.add(ev.id);
    } else if (ev.eventType === "reversal" && ev.reversesEventId != null) {
      const orig = eventsById.get(ev.reversesEventId);
      if (orig) {
        const oAmt = parseFloat(String(orig.amount));
        if (orig.eventType === "payment") {
          runningPaid = ROUND2(runningPaid - oAmt);
        } else if (orig.eventType === "refund") {
          runningRefunded = ROUND2(runningRefunded - oAmt);
        } else if (orig.eventType === "waive") {
          activeWaiveIds.delete(orig.id);
        }
      }
    }
    const runningBalance = activeWaiveIds.size > 0
      ? 0
      : ROUND2(Math.max(0, chargeAmount - runningPaid - runningRefunded));
    const info = reversalByOriginal.get(ev.id);
    return {
      ...ev,
      reversed: !!info,
      reversedByEventId: info?.reversedByEventId ?? null,
      reversedAt: info?.reversedAt ?? null,
      reversedByActorName: info?.reversedByActorName ?? null,
      runningPaid: runningPaid.toFixed(2),
      runningRefunded: runningRefunded.toFixed(2),
      runningBalance: runningBalance.toFixed(2),
    };
  });
  res.json({
    chargeId: resolved.charge.id,
    currency: resolved.levy.currency,
    chargeAmount: chargeAmount.toFixed(2),
    events: enriched,
  });
});

/**
 * Resend the most recent receipt email for a single levy charge (Task 222).
 *
 * Replays the last persisted receipt (kind, amount, note) using the charge's
 * current outstanding balance. Useful when the original send was skipped (no
 * email on file, billing pref off) or failed at the SMTP layer — once the
 * underlying issue is fixed, the admin can issue a fresh send without having
 * to record a new payment / refund / waiver.
 */
type LevyReceiptKindPersisted = "payment" | "partial_payment" | "refund" | "waiver";
const RECEIPT_KINDS = new Set<LevyReceiptKindPersisted>([
  "payment", "partial_payment", "refund", "waiver",
]);
router.post("/levies/:id/charges/:memberId/resend-receipt", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const memberId = memberIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const resolved = await resolveCharge(req, res, orgId, id, memberId);
  if (!resolved) return;
  const { levy, charge } = resolved;

  const persistedKind = (charge.lastReceiptKind ?? "") as LevyReceiptKindPersisted | "";
  if (!persistedKind || !RECEIPT_KINDS.has(persistedKind)) {
    res.status(400).json({
      error: "No receipt has been issued for this charge yet — record a payment, refund, or waiver first.",
    });
    return;
  }
  const amount = parseFloat(String(charge.lastReceiptAmount ?? "0"));
  if (!Number.isFinite(amount) || amount < 0) {
    res.status(400).json({ error: "Stored receipt amount is invalid; cannot resend." });
    return;
  }
  const amt = parseFloat(String(charge.amount));
  const paid = parseFloat(String(charge.paidAmount ?? "0"));
  const refunded = parseFloat(String(charge.refundedAmount ?? "0"));
  const remainingBalance = charge.status === "waived" || charge.status === "refunded"
    ? 0 : Math.max(0, ROUND2(amt - paid - refunded));

  const result = await sendLevyReceipt({
    organizationId: orgId,
    clubMemberId: memberId,
    levyName: levy.name,
    currency: levy.currency,
    kind: persistedKind,
    transactionAmount: amount,
    newBalance: remainingBalance,
    note: charge.lastReceiptNote ?? null,
    chargeId: charge.id,
  });
  await persistReceiptStatus(charge.id, {
    kind: persistedKind, amount, note: charge.lastReceiptNote ?? null, result,
  });
  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: memberId,
    entity: "levy_charge", entityId: charge.id, action: "update",
    reason: `Levy "${levy.name}" receipt resent (${persistedKind}) — status: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
  });
  res.json({
    chargeId: charge.id,
    receipt: {
      status: result.status,
      reason: result.reason ?? null,
      kind: persistedKind,
      amount: amount.toFixed(2),
      at: new Date().toISOString(),
    },
  });
});

/**
 * Predicted outcome of replaying a single levy receipt without actually
 * sending it (Task #293). Mirrors the same email-channel decision tree used
 * by `sendLevyReceipt`:
 *   - `will_skip_no_email`   — billing-email pref is on but no address on file
 *   - `will_skip_opted_out`  — member has disabled billing emails
 *   - `invalid`              — charge has no persisted receipt kind/amount
 *   - `sendable`             — at least the email channel will be attempted
 *
 * The other two channels (push, SMS) are best-effort and never block a send;
 * the UI's pre-flight focuses on the email signal only because that's the
 * channel admins are expected to fix when "skipped" appears.
 */
type LevyReceiptPredictedOutcome =
  | "sendable"
  | "will_skip_no_email"
  | "will_skip_opted_out"
  | "invalid";

interface LevyResendPreviewRow {
  chargeId: number;
  clubMemberId: number;
  memberName: string;
  memberNumber: string | null;
  email: string | null;
  kind: LevyReceiptKindPersisted | null;
  amount: string;
  lastReceiptStatus: "failed" | "skipped";
  lastReceiptReason: string | null;
  predictedOutcome: LevyReceiptPredictedOutcome;
}

/**
 * Load every failed/skipped receipt for `levyId` together with the
 * info needed to predict (and execute) a resend. Used by the preview
 * GET and the actual POST so both views stay in lock-step.
 */
async function loadFailedReceiptCharges(orgId: number, levyId: number) {
  return db
    .select({
      id: memberLevyChargesTable.id,
      clubMemberId: memberLevyChargesTable.clubMemberId,
      amount: memberLevyChargesTable.amount,
      paidAmount: memberLevyChargesTable.paidAmount,
      refundedAmount: memberLevyChargesTable.refundedAmount,
      status: memberLevyChargesTable.status,
      lastReceiptStatus: memberLevyChargesTable.lastReceiptStatus,
      lastReceiptReason: memberLevyChargesTable.lastReceiptReason,
      lastReceiptKind: memberLevyChargesTable.lastReceiptKind,
      lastReceiptAmount: memberLevyChargesTable.lastReceiptAmount,
      lastReceiptNote: memberLevyChargesTable.lastReceiptNote,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      memberNumber: clubMembersTable.memberNumber,
      email: clubMembersTable.email,
    })
    .from(memberLevyChargesTable)
    .innerJoin(clubMembersTable, eq(memberLevyChargesTable.clubMemberId, clubMembersTable.id))
    .where(and(
      eq(memberLevyChargesTable.levyId, levyId),
      eq(clubMembersTable.organizationId, orgId),
      inArray(memberLevyChargesTable.lastReceiptStatus, ["failed", "skipped"]),
    ));
}

/**
 * Pre-flight preview for the bulk "Resend all failed" action (Task #293).
 *
 * Classifies every failed/skipped receipt without sending so the admin can
 * see in advance which members will skip again (no email on file or opted
 * out of billing emails). The admin can then deselect rows or fix the
 * underlying contact info before triggering the actual resend.
 */
router.get("/levies/:id/resend-failed-receipts/preview", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid levy id" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }

  const charges = await loadFailedReceiptCharges(orgId, id);

  // Bulk-load billing-email prefs for the affected members so the preview
  // is one O(1) query instead of one-per-charge.
  const memberIds = Array.from(new Set(charges.map(c => c.clubMemberId)));
  const prefRows = memberIds.length
    ? await db.select({
        clubMemberId: memberCommPrefsTable.clubMemberId,
        emailEnabled: memberCommPrefsTable.emailEnabled,
      })
      .from(memberCommPrefsTable)
      .where(and(
        inArray(memberCommPrefsTable.clubMemberId, memberIds),
        eq(memberCommPrefsTable.category, "billing"),
      ))
    : [];
  // Schema default for billing-email is on; only an explicit opt-out flips it.
  const emailEnabledByMember = new Map<number, boolean>();
  for (const r of prefRows) emailEnabledByMember.set(r.clubMemberId, Boolean(r.emailEnabled));

  const rows: LevyResendPreviewRow[] = charges.map(c => {
    const persistedKind = (c.lastReceiptKind ?? "") as LevyReceiptKindPersisted | "";
    const amountNum = parseFloat(String(c.lastReceiptAmount ?? "0"));
    const validKind = !!persistedKind && RECEIPT_KINDS.has(persistedKind);
    const validAmount = Number.isFinite(amountNum) && amountNum >= 0;
    let predictedOutcome: LevyReceiptPredictedOutcome;
    if (!validKind || !validAmount) {
      predictedOutcome = "invalid";
    } else {
      const emailOn = emailEnabledByMember.get(c.clubMemberId) ?? true;
      if (!emailOn) predictedOutcome = "will_skip_opted_out";
      else if (!c.email) predictedOutcome = "will_skip_no_email";
      else predictedOutcome = "sendable";
    }
    return {
      chargeId: c.id,
      clubMemberId: c.clubMemberId,
      memberName: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
      memberNumber: c.memberNumber ?? null,
      email: c.email ?? null,
      kind: validKind ? persistedKind : null,
      amount: validAmount ? amountNum.toFixed(2) : String(c.lastReceiptAmount ?? "0"),
      lastReceiptStatus: c.lastReceiptStatus as "failed" | "skipped",
      lastReceiptReason: c.lastReceiptReason ?? null,
      predictedOutcome,
    };
  });

  let sendable = 0, willSkipNoEmail = 0, willSkipOptedOut = 0, invalid = 0;
  for (const r of rows) {
    if (r.predictedOutcome === "sendable") sendable++;
    else if (r.predictedOutcome === "will_skip_no_email") willSkipNoEmail++;
    else if (r.predictedOutcome === "will_skip_opted_out") willSkipOptedOut++;
    else invalid++;
  }

  res.json({
    levyId: id,
    levyName: levy.name,
    currency: levy.currency,
    total: rows.length,
    sendable,
    willSkipNoEmail,
    willSkipOptedOut,
    invalid,
    rows,
  });
});

/**
 * Bulk-resend every failed/skipped receipt for one levy (Task #254).
 *
 * Replays sendLevyReceipt for every charge whose lastReceiptStatus is
 * "failed" or "skipped" using the persisted (kind, amount, note) from the
 * original send. Persists the new outcome on each charge and writes one
 * audit row per charge so the trail stays granular. Returns aggregate
 * counters plus a per-charge result array so the UI can report exactly
 * what happened to which member.
 *
 * Body (optional): `{ chargeIds: number[] }` — when provided, only those
 * charges are replayed (intersected with the failed/skipped set). The
 * pre-flight preview UI (Task #293) uses this so admins can deselect
 * rows that would skip again before triggering the resend.
 */
router.post("/levies/:id/resend-failed-receipts", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid levy id" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }

  // Optional caller-supplied subset. Validate that everything is a finite int
  // before passing it through to the filter so a malformed body returns 400
  // rather than silently sending the entire failed set.
  let selectedChargeIds: Set<number> | null = null;
  const rawIds = (req.body as { chargeIds?: unknown })?.chargeIds;
  if (rawIds !== undefined) {
    if (!Array.isArray(rawIds)) {
      res.status(400).json({ error: "chargeIds must be an array of charge ids" }); return;
    }
    const cleaned: number[] = [];
    for (const v of rawIds) {
      // Strict integer validation: a numeric value must already be an integer,
      // and a string must match /^-?\d+$/ exactly. This rejects junk like
      // "12abc" (which parseInt would happily turn into 12) and floats.
      let n: number;
      if (typeof v === "number") {
        if (!Number.isInteger(v)) {
          res.status(400).json({ error: "chargeIds must contain integer ids" }); return;
        }
        n = v;
      } else if (typeof v === "string" && /^-?\d+$/.test(v)) {
        n = Number(v);
      } else {
        res.status(400).json({ error: "chargeIds must contain integer ids" }); return;
      }
      if (!Number.isSafeInteger(n)) {
        res.status(400).json({ error: "chargeIds must contain safe-integer ids" }); return;
      }
      cleaned.push(n);
    }
    selectedChargeIds = new Set(cleaned);
  }

  const allCharges = await loadFailedReceiptCharges(orgId, id);
  const charges = selectedChargeIds
    ? allCharges.filter(c => selectedChargeIds!.has(c.id))
    : allCharges;

  let sent = 0, skipped = 0, failed = 0;
  type ChannelKey = "email" | "push" | "sms" | "whatsapp";
  type ChannelStatus = "sent" | "failed" | "no_address" | "no_user" | "opted_out" | "skipped";
  type ChannelResult = { status: ChannelStatus; error?: string };
  const CHANNELS: ChannelKey[] = ["email", "push", "sms", "whatsapp"];
  // Per-channel aggregate counters. We always emit every (channel × status)
  // combination so the UI can render a stable summary table without having
  // to test for the presence of each key.
  const channelTotals: Record<ChannelKey, Record<ChannelStatus, number>> = {
    email:    { sent: 0, failed: 0, no_address: 0, no_user: 0, opted_out: 0, skipped: 0 },
    push:     { sent: 0, failed: 0, no_address: 0, no_user: 0, opted_out: 0, skipped: 0 },
    sms:      { sent: 0, failed: 0, no_address: 0, no_user: 0, opted_out: 0, skipped: 0 },
    whatsapp: { sent: 0, failed: 0, no_address: 0, no_user: 0, opted_out: 0, skipped: 0 },
  };
  const results: Array<{
    chargeId: number; clubMemberId: number; memberName: string;
    status: "sent" | "skipped" | "failed"; reason: string | null;
    kind: LevyReceiptKindPersisted; amount: string;
    channels: Record<ChannelKey, ChannelResult>;
  }> = [];

  // Default per-channel block for short-circuited entries (malformed kind /
  // invalid amount). We surface "skipped" on every channel so the response
  // shape stays uniform and the channel totals stay accurate.
  const skippedChannels = (): Record<ChannelKey, ChannelResult> => ({
    email:    { status: "skipped" },
    push:     { status: "skipped" },
    sms:      { status: "skipped" },
    whatsapp: { status: "skipped" },
  });

  for (const c of charges) {
    const persistedKind = (c.lastReceiptKind ?? "") as LevyReceiptKindPersisted | "";
    if (!persistedKind || !RECEIPT_KINDS.has(persistedKind)) {
      // Defensive: a charge marked failed without a kind is malformed; record
      // it as failed so the admin can see something is off rather than silently
      // dropping it from the totals.
      failed++;
      const ch = skippedChannels();
      for (const k of CHANNELS) channelTotals[k][ch[k].status] += 1;
      results.push({
        chargeId: c.id, clubMemberId: c.clubMemberId,
        memberName: `${c.firstName} ${c.lastName}`.trim(),
        status: "failed", reason: "missing_receipt_kind",
        kind: "payment", amount: "0.00",
        channels: ch,
      });
      continue;
    }
    const amount = parseFloat(String(c.lastReceiptAmount ?? "0"));
    if (!Number.isFinite(amount) || amount < 0) {
      failed++;
      const ch = skippedChannels();
      for (const k of CHANNELS) channelTotals[k][ch[k].status] += 1;
      results.push({
        chargeId: c.id, clubMemberId: c.clubMemberId,
        memberName: `${c.firstName} ${c.lastName}`.trim(),
        status: "failed", reason: "invalid_receipt_amount",
        kind: persistedKind, amount: "0.00",
        channels: ch,
      });
      continue;
    }
    const amt = parseFloat(String(c.amount));
    const paid = parseFloat(String(c.paidAmount ?? "0"));
    const refunded = parseFloat(String(c.refundedAmount ?? "0"));
    const remainingBalance = c.status === "waived" || c.status === "refunded"
      ? 0 : Math.max(0, ROUND2(amt - paid - refunded));

    const result = await sendLevyReceipt({
      organizationId: orgId,
      clubMemberId: c.clubMemberId,
      levyName: levy.name,
      currency: levy.currency,
      kind: persistedKind,
      transactionAmount: amount,
      newBalance: remainingBalance,
      note: c.lastReceiptNote ?? null,
      chargeId: c.id,
    });
    await persistReceiptStatus(c.id, {
      kind: persistedKind, amount, note: c.lastReceiptNote ?? null, result,
    });
    await recordMemberAudit({
      req, organizationId: orgId, clubMemberId: c.clubMemberId,
      entity: "levy_charge", entityId: c.id, action: "update",
      reason: `Bulk resend of levy "${levy.name}" receipt (${persistedKind}) — status: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
    });

    if (result.status === "sent") sent++;
    else if (result.status === "skipped") skipped++;
    else failed++;

    // Surface the per-channel breakdown returned by sendLevyReceipt so admins
    // can see which channel (email/push/SMS/WhatsApp) succeeded or failed for
    // each member without drilling into the per-charge receipts history.
    const channels: Record<ChannelKey, ChannelResult> = {
      email:    { status: result.email.status, ...(result.email.error ? { error: result.email.error } : {}) },
      push:     { status: result.push.status, ...(result.push.error ? { error: result.push.error } : {}) },
      sms:      { status: result.sms.status, ...(result.sms.error ? { error: result.sms.error } : {}) },
      whatsapp: { status: result.whatsapp.status, ...(result.whatsapp.error ? { error: result.whatsapp.error } : {}) },
    };
    for (const k of CHANNELS) channelTotals[k][channels[k].status] += 1;

    results.push({
      chargeId: c.id, clubMemberId: c.clubMemberId,
      memberName: `${c.firstName} ${c.lastName}`.trim(),
      status: result.status, reason: result.reason ?? null,
      kind: persistedKind, amount: amount.toFixed(2),
      channels,
    });
  }

  res.json({
    levyId: id,
    attempted: charges.length,
    sent, skipped, failed,
    channelTotals,
    results,
  });
});

/**
 * Per-charge receipt-notification retry history (Task #247).
 * Returns each receipt notification fired against this charge, with the
 * current per-channel status, attempt count, last attempt/retry timestamps,
 * last error, and whether the channel's bounded retry budget has been
 * exhausted. Mirrors what the privacy-request widget already shows for
 * data-request notices.
 */
router.get("/levies/:id/charges/:memberId/receipts", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const memberId = memberIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const resolved = await resolveCharge(req, res, orgId, id, memberId);
  if (!resolved) return;
  const rows = await db
    .select({
      id: memberLevyReceiptAttemptsTable.id,
      kind: memberLevyReceiptAttemptsTable.kind,
      transactionAmount: memberLevyReceiptAttemptsTable.transactionAmount,
      newBalance: memberLevyReceiptAttemptsTable.newBalance,
      note: memberLevyReceiptAttemptsTable.note,
      createdAt: memberLevyReceiptAttemptsTable.createdAt,
      pushStatus: memberLevyReceiptAttemptsTable.pushStatus,
      pushAttempts: memberLevyReceiptAttemptsTable.pushAttempts,
      lastPushAt: memberLevyReceiptAttemptsTable.lastPushAt,
      lastPushError: memberLevyReceiptAttemptsTable.lastPushError,
      lastPushRetryAt: memberLevyReceiptAttemptsTable.lastPushRetryAt,
      pushRetryExhaustedAt: memberLevyReceiptAttemptsTable.pushRetryExhaustedAt,
      smsStatus: memberLevyReceiptAttemptsTable.smsStatus,
      smsAttempts: memberLevyReceiptAttemptsTable.smsAttempts,
      lastSmsAt: memberLevyReceiptAttemptsTable.lastSmsAt,
      lastSmsError: memberLevyReceiptAttemptsTable.lastSmsError,
      lastSmsRetryAt: memberLevyReceiptAttemptsTable.lastSmsRetryAt,
      smsRetryExhaustedAt: memberLevyReceiptAttemptsTable.smsRetryExhaustedAt,
      // Task #298: WhatsApp telemetry — mirrors the SMS shape so the receipts
      // history widget can render attempts/last-error/exhaustion uniformly.
      whatsappStatus: memberLevyReceiptAttemptsTable.whatsappStatus,
      whatsappAttempts: memberLevyReceiptAttemptsTable.whatsappAttempts,
      lastWhatsappAt: memberLevyReceiptAttemptsTable.lastWhatsappAt,
      lastWhatsappError: memberLevyReceiptAttemptsTable.lastWhatsappError,
      lastWhatsappRetryAt: memberLevyReceiptAttemptsTable.lastWhatsappRetryAt,
      whatsappRetryExhaustedAt: memberLevyReceiptAttemptsTable.whatsappRetryExhaustedAt,
    })
    .from(memberLevyReceiptAttemptsTable)
    .where(and(
      eq(memberLevyReceiptAttemptsTable.chargeId, resolved.charge.id),
      eq(memberLevyReceiptAttemptsTable.organizationId, orgId),
    ))
    .orderBy(desc(memberLevyReceiptAttemptsTable.createdAt));
  res.json({
    chargeId: resolved.charge.id,
    currency: resolved.levy.currency,
    maxPushAttempts: LEVY_RECEIPT_MAX_PUSH_ATTEMPTS,
    maxSmsAttempts: LEVY_RECEIPT_MAX_SMS_ATTEMPTS,
    maxWhatsappAttempts: LEVY_RECEIPT_MAX_WHATSAPP_ATTEMPTS,
    attempts: rows,
  });
});

/**
 * Force a single-channel retry for a levy-receipt notification (Task #307).
 * Mirrors the privacy-request `/data-requests/:id/retry-channel` endpoint:
 * lets staff push a stuck push, SMS, or WhatsApp delivery without waiting
 * for the cron. The underlying retry helpers gate on the row still being in
 * `failed` state and the per-channel attempt cap
 * (LEVY_RECEIPT_MAX_PUSH_ATTEMPTS / LEVY_RECEIPT_MAX_SMS_ATTEMPTS /
 * LEVY_RECEIPT_MAX_WHATSAPP_ATTEMPTS) not yet being hit.
 */
router.post("/levies/:id/charges/:memberId/receipts/:attemptId/retry-channel", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const memberId = memberIdOf(req);
  const attemptId = parseInt(String((req.params as Record<string, string>).attemptId));
  if (!Number.isFinite(attemptId)) { { res.status(400).json({ error: "Invalid attemptId" }); return; } }
  const channel = String(req.body?.channel ?? "").toLowerCase();
  if (channel !== "push" && channel !== "sms" && channel !== "whatsapp") {
    res.status(400).json({ error: "channel must be 'push', 'sms', or 'whatsapp'" }); return;
  }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const resolved = await resolveCharge(req, res, orgId, id, memberId);
  if (!resolved) return;

  const [attempt] = await db.select().from(memberLevyReceiptAttemptsTable)
    .where(and(
      eq(memberLevyReceiptAttemptsTable.id, attemptId),
      eq(memberLevyReceiptAttemptsTable.chargeId, resolved.charge.id),
      eq(memberLevyReceiptAttemptsTable.organizationId, orgId),
    ));
  if (!attempt) { { res.status(404).json({ error: "Receipt attempt not found on this charge" }); return; } }

  try {
    const result = channel === "push"
      ? await retryLevyReceiptPush({ attempt, logContext: { route: "member-360.levy-receipts.retry-channel", memberId, attemptId, channel } })
      : channel === "sms"
        ? await retryLevyReceiptSms({ attempt, logContext: { route: "member-360.levy-receipts.retry-channel", memberId, attemptId, channel } })
        : await retryLevyReceiptWhatsapp({ attempt, logContext: { route: "member-360.levy-receipts.retry-channel", memberId, attemptId, channel } });

    if (!result) {
      res.status(409).json({ error: `${channel} channel is not eligible for retry (status not 'failed' or attempt cap reached).` });
      return;
    }

    await recordMemberAudit({
      req, organizationId: orgId, clubMemberId: memberId,
      entity: "levy_charge", entityId: resolved.charge.id, action: "resend",
      reason: `Levy "${resolved.levy.name}" receipt #${attemptId} manual ${channel} retry — ${channel}:${result.status}${result.exhausted ? " (exhausted)" : ""} attempt:${result.attempts}`,
      metadata: { attemptId, channel, status: result.status, attempts: result.attempts, exhausted: result.exhausted, error: result.error ?? null },
    });

    const [updated] = await db.select().from(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, attemptId));
    res.json({ attempt: updated, result });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    baseLogger.error({ chargeId: resolved.charge.id, attemptId, channel, errMsg }, "[member-360] Failed to retry levy-receipt channel");
    res.status(500).json({ error: "Failed to retry channel", detail: errMsg });
  }
});

/**
 * Force a single-channel retry for the most recent levy-receipt notification
 * on a charge (Task #338). Convenience wrapper around the per-attempt
 * `/receipts/:attemptId/retry-channel` endpoint that resolves the latest
 * attempt itself, so the AuditTab "Retry push" / "Retry SMS" buttons can fire
 * without the audit row needing to know which attempt id is current. Body:
 * `{ channel: 'push' | 'sms' | 'whatsapp' }` — Task #505 adds WhatsApp
 * alongside push/SMS so the audit panel can retry any single channel.
 */
router.post("/levies/:id/charges/:memberId/retry-receipt-channel", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const memberId = memberIdOf(req);
  const channel = String(req.body?.channel ?? "").toLowerCase();
  if (channel !== "push" && channel !== "sms" && channel !== "whatsapp") {
    res.status(400).json({ error: "channel must be 'push', 'sms', or 'whatsapp'" }); return;
  }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const resolved = await resolveCharge(req, res, orgId, id, memberId);
  if (!resolved) return;

  const [attempt] = await db.select().from(memberLevyReceiptAttemptsTable)
    .where(and(
      eq(memberLevyReceiptAttemptsTable.chargeId, resolved.charge.id),
      eq(memberLevyReceiptAttemptsTable.organizationId, orgId),
    ))
    .orderBy(desc(memberLevyReceiptAttemptsTable.createdAt))
    .limit(1);
  if (!attempt) { { res.status(404).json({ error: "No receipt attempt has been recorded for this charge yet" }); return; } }

  try {
    const result = channel === "push"
      ? await retryLevyReceiptPush({ attempt, logContext: { route: "member-360.levy-receipts.retry-receipt-channel", memberId, attemptId: attempt.id, channel } })
      : channel === "sms"
        ? await retryLevyReceiptSms({ attempt, logContext: { route: "member-360.levy-receipts.retry-receipt-channel", memberId, attemptId: attempt.id, channel } })
        : await retryLevyReceiptWhatsapp({ attempt, logContext: { route: "member-360.levy-receipts.retry-receipt-channel", memberId, attemptId: attempt.id, channel } });

    if (!result) {
      res.status(409).json({ error: `${channel} channel is not eligible for retry (status not 'failed' or attempt cap reached).` });
      return;
    }

    await recordMemberAudit({
      req, organizationId: orgId, clubMemberId: memberId,
      entity: "levy_charge", entityId: resolved.charge.id, action: "resend",
      reason: `Levy "${resolved.levy.name}" receipt #${attempt.id} manual ${channel} retry — ${channel}:${result.status}${result.exhausted ? " (exhausted)" : ""} attempt:${result.attempts}`,
      metadata: { attemptId: attempt.id, channel, status: result.status, attempts: result.attempts, exhausted: result.exhausted, error: result.error ?? null },
    });

    const [updated] = await db.select().from(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));
    res.json({ attempt: updated, result });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    baseLogger.error({ chargeId: resolved.charge.id, attemptId: attempt.id, channel, errMsg }, "[member-360] Failed to retry latest levy-receipt channel");
    res.status(500).json({ error: "Failed to retry channel", detail: errMsg });
  }
});

/**
 * Reverse a previously-recorded levy charge event (Task 219).
 * Writes a compensating 'reversal' ledger row linked to the original event id
 * and recomputes paidAmount/refundedAmount/status from the surviving ledger so
 * the running totals stay consistent without polluting the refund history.
 *
 * Body: { reason: string }
 */
router.post("/levies/:id/charges/:memberId/events/:eventId/reverse", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  const memberId = memberIdOf(req);
  const eventId = parseInt(String((req.params as Record<string, string>).eventId));
  if (!Number.isFinite(eventId)) { { res.status(400).json({ error: "Invalid eventId" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const resolved = await resolveCharge(req, res, orgId, id, memberId);
  if (!resolved) return;
  const { levy, charge } = resolved;

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) { { res.status(400).json({ error: "reason is required to reverse an entry" }); return; } }

  const [original] = await db.select().from(memberLevyChargeEventsTable)
    .where(and(
      eq(memberLevyChargeEventsTable.id, eventId),
      eq(memberLevyChargeEventsTable.chargeId, charge.id),
      eq(memberLevyChargeEventsTable.organizationId, orgId),
    ));
  if (!original) { { res.status(404).json({ error: "Event not found on this charge" }); return; } }
  if (original.eventType === "reversal") {
    res.status(400).json({ error: "Reversal entries cannot themselves be reversed" }); return;
  }
  if (!["payment", "refund", "waive"].includes(original.eventType)) {
    res.status(400).json({ error: `Cannot reverse event of type '${original.eventType}'` }); return;
  }
  const [existingReversal] = await db.select({ id: memberLevyChargeEventsTable.id })
    .from(memberLevyChargeEventsTable)
    .where(and(
      eq(memberLevyChargeEventsTable.reversesEventId, eventId),
      eq(memberLevyChargeEventsTable.organizationId, orgId),
    ));
  if (existingReversal) { { res.status(400).json({ error: "This entry has already been reversed" }); return; } }

  // Insert the compensating row first so the recompute below sees it.
  const user = req.user as { id?: number; displayName?: string; email?: string } | undefined;
  let actorName: string | null = user?.displayName ?? user?.email ?? null;
  if (!actorName && user?.id) {
    const [u] = await db.select({ displayName: appUsersTable.displayName, email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, user.id));
    actorName = u?.displayName ?? u?.email ?? null;
  }
  const [reversalRow] = await db.insert(memberLevyChargeEventsTable).values({
    organizationId: orgId,
    clubMemberId: memberId,
    chargeId: charge.id,
    eventType: "reversal",
    amount: original.amount,
    method: original.method,
    processorReference: original.processorReference,
    reason,
    reversesEventId: eventId,
    actorUserId: user?.id ?? null,
    actorName,
  }).returning();

  // Recompute totals from the surviving ledger:
  // - sum payments not reversed and not themselves reversal rows
  // - sum refunds  not reversed and not themselves reversal rows
  // - waive is active iff a non-reversed waive row exists
  const allEvents = await db.select({
    id: memberLevyChargeEventsTable.id,
    eventType: memberLevyChargeEventsTable.eventType,
    amount: memberLevyChargeEventsTable.amount,
    reversesEventId: memberLevyChargeEventsTable.reversesEventId,
  })
    .from(memberLevyChargeEventsTable)
    .where(and(
      eq(memberLevyChargeEventsTable.chargeId, charge.id),
      eq(memberLevyChargeEventsTable.organizationId, orgId),
    ));
  const reversedSet = new Set<number>();
  for (const e of allEvents) {
    if (e.eventType === "reversal" && e.reversesEventId != null) reversedSet.add(e.reversesEventId);
  }
  let paidTotal = 0, refundedTotal = 0, hasActiveWaive = false;
  for (const e of allEvents) {
    if (e.eventType === "reversal") continue;
    if (reversedSet.has(e.id)) continue;
    const amt = parseFloat(String(e.amount));
    if (e.eventType === "payment") paidTotal += amt;
    else if (e.eventType === "refund") refundedTotal += amt;
    else if (e.eventType === "waive") hasActiveWaive = true;
  }
  paidTotal = ROUND2(paidTotal);
  refundedTotal = ROUND2(refundedTotal);
  const amt = parseFloat(String(charge.amount));
  const remainingBalance = ROUND2(amt - paidTotal - refundedTotal);
  let status: string;
  if (hasActiveWaive) {
    status = "waived";
  } else if (paidTotal > 0 && refundedTotal >= paidTotal - 0.0001 && remainingBalance <= 0.0001) {
    status = "refunded";
  } else if (paidTotal - refundedTotal <= 0.0001 && remainingBalance > 0.0001) {
    status = "unpaid";
  } else if (remainingBalance <= 0.0001 && paidTotal - refundedTotal > 0) {
    status = "paid";
  } else if (paidTotal - refundedTotal > 0) {
    status = "partial";
  } else {
    status = "unpaid";
  }
  const now = new Date();
  const [updated] = await db.update(memberLevyChargesTable)
    .set({
      paidAmount: paidTotal.toFixed(2),
      refundedAmount: refundedTotal.toFixed(2),
      paid: status === "paid",
      paidAt: status === "paid" ? (charge.paidAt ?? now) : (status === "refunded" ? charge.paidAt : null),
      status,
      // If the active waive went away, clear the stale reason.
      waivedReason: hasActiveWaive ? charge.waivedReason : null,
    })
    .where(eq(memberLevyChargesTable.id, charge.id))
    .returning();

  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: memberId,
    entity: "levy_charge", entityId: charge.id, action: "update",
    changes: {
      paidAmount: { from: charge.paidAmount, to: updated.paidAmount },
      refundedAmount: { from: charge.refundedAmount, to: updated.refundedAmount },
      status: { from: charge.status, to: updated.status },
    },
    reason: `Levy "${levy.name}" entry #${eventId} (${original.eventType} ${parseFloat(String(original.amount)).toFixed(2)} ${levy.currency}) reversed — ${reason}`,
  });

  res.json({ reversal: reversalRow, charge: updated });
});

/**
 * Export the levy payment ledger as CSV for accounting reconciliation (Task 218).
 * Optional query filters:
 *   - levyId   : restrict to one levy
 *   - memberId : restrict to one member
 *   - type     : payment | refund | waive
 *   - from/to  : ISO date strings; matched on `occurred_at`
 * Always returns 200 with CSV. An empty result set still produces a valid CSV
 * containing only the header row so downstream importers don't choke.
 */
const LEVY_LEDGER_EVENT_TYPES = new Set(["payment", "refund", "waive"]);

/**
 * Shared loader for the levy-ledger CSV/PDF exports. Pulls events that match
 * the org/levy/member scope (without the type/date filters), walks each
 * charge's events chronologically — mirroring the per-charge timeline
 * computation in the API (Task #303) — and emits enriched rows that include
 * the running paid / refunded / outstanding balance after every event.
 *
 * Type and date filters are applied AFTER the running totals are computed so
 * the displayed balance always reflects the true cumulative state of the
 * charge at that point in time, even when filtered views hide intervening
 * events. Reversals back out the original entry the same way the
 * /charges/:id/events endpoint does so the printable ledger reconciles
 * cleanly against the per-charge totals.
 */
type LevyLedgerExportRow = {
  eventId: number;
  occurredAt: Date | null;
  eventType: string;
  amount: string;
  method: string | null;
  processorReference: string | null;
  note: string | null;
  reason: string | null;
  actorUserId: number | null;
  actorName: string | null;
  memberNumber: string | null;
  firstName: string | null;
  lastName: string | null;
  memberEmail: string | null;
  levyName: string | null;
  currency: string | null;
  runningPaid: string;
  runningRefunded: string;
  runningBalance: string;
};

async function fetchLevyLedgerExportRows(opts: {
  orgId: number;
  levyId?: number | null;
  memberId?: number | null;
  type?: string | null;
  from?: Date | null;
  to?: Date | null;
}): Promise<LevyLedgerExportRow[]> {
  // Scope conds restrict which charges we walk. Type/date filters are
  // intentionally NOT in here: they only narrow which rows we EMIT, while the
  // running balance must reflect every event on the charge.
  const scopeConds = [eq(memberLevyChargeEventsTable.organizationId, opts.orgId)];
  if (opts.levyId != null) scopeConds.push(eq(memberLevyChargesTable.levyId, opts.levyId));
  if (opts.memberId != null) scopeConds.push(eq(memberLevyChargeEventsTable.clubMemberId, opts.memberId));

  const rows = await db
    .select({
      eventId: memberLevyChargeEventsTable.id,
      chargeId: memberLevyChargeEventsTable.chargeId,
      reversesEventId: memberLevyChargeEventsTable.reversesEventId,
      chargeAmount: memberLevyChargesTable.amount,
      occurredAt: memberLevyChargeEventsTable.occurredAt,
      eventType: memberLevyChargeEventsTable.eventType,
      amount: memberLevyChargeEventsTable.amount,
      method: memberLevyChargeEventsTable.method,
      processorReference: memberLevyChargeEventsTable.processorReference,
      note: memberLevyChargeEventsTable.note,
      reason: memberLevyChargeEventsTable.reason,
      actorUserId: memberLevyChargeEventsTable.actorUserId,
      actorName: memberLevyChargeEventsTable.actorName,
      memberNumber: clubMembersTable.memberNumber,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      memberEmail: clubMembersTable.email,
      levyName: memberLeviesTable.name,
      currency: memberLeviesTable.currency,
    })
    .from(memberLevyChargeEventsTable)
    .innerJoin(memberLevyChargesTable, eq(memberLevyChargeEventsTable.chargeId, memberLevyChargesTable.id))
    .innerJoin(memberLeviesTable, eq(memberLevyChargesTable.levyId, memberLeviesTable.id))
    .innerJoin(clubMembersTable, eq(memberLevyChargeEventsTable.clubMemberId, clubMembersTable.id))
    .where(and(...scopeConds))
    .orderBy(
      asc(memberLevyChargeEventsTable.chargeId),
      asc(memberLevyChargeEventsTable.occurredAt),
      asc(memberLevyChargeEventsTable.id),
    );

  // Walk per-charge with the same convention as the per-charge events API:
  //   - normal:  runningBalance = max(0, chargeAmount - paid - refunded)
  //   - waived:  runningBalance = 0 while at least one waive is active
  //   - reversal: undoes the original entry's effect on paid/refunded/waive
  const typeFilter = opts.type && opts.type !== "all" ? opts.type : null;
  const fromMs = opts.from ? opts.from.getTime() : null;
  const toMs = opts.to ? opts.to.getTime() : null;

  const out: LevyLedgerExportRow[] = [];
  let currentChargeId: number | null = null;
  let chargeAmount = 0;
  let runningPaid = 0;
  let runningRefunded = 0;
  let activeWaiveIds = new Set<number>();
  // eventsById is per-charge: each new chargeId resets it.
  let eventsById = new Map<number, { id: number; eventType: string; amount: string }>();

  for (const r of rows) {
    if (r.chargeId !== currentChargeId) {
      currentChargeId = r.chargeId;
      chargeAmount = parseFloat(String(r.chargeAmount ?? "0")) || 0;
      runningPaid = 0;
      runningRefunded = 0;
      activeWaiveIds = new Set<number>();
      eventsById = new Map();
    }
    eventsById.set(r.eventId, { id: r.eventId, eventType: r.eventType, amount: r.amount });
    const amt = parseFloat(String(r.amount ?? "0")) || 0;
    if (r.eventType === "payment") {
      runningPaid = ROUND2(runningPaid + amt);
    } else if (r.eventType === "refund") {
      runningRefunded = ROUND2(runningRefunded + amt);
    } else if (r.eventType === "waive") {
      activeWaiveIds.add(r.eventId);
    } else if (r.eventType === "reversal" && r.reversesEventId != null) {
      const orig = eventsById.get(r.reversesEventId);
      if (orig) {
        const oAmt = parseFloat(String(orig.amount ?? "0")) || 0;
        if (orig.eventType === "payment") {
          runningPaid = ROUND2(runningPaid - oAmt);
        } else if (orig.eventType === "refund") {
          runningRefunded = ROUND2(runningRefunded - oAmt);
        } else if (orig.eventType === "waive") {
          activeWaiveIds.delete(orig.id);
        }
      }
    }
    const runningBalance = activeWaiveIds.size > 0
      ? 0
      : ROUND2(Math.max(0, chargeAmount - runningPaid - runningRefunded));

    if (typeFilter && r.eventType !== typeFilter) continue;
    const occurredMs = r.occurredAt ? new Date(r.occurredAt).getTime() : null;
    if (fromMs != null && (occurredMs == null || occurredMs < fromMs)) continue;
    if (toMs != null && (occurredMs == null || occurredMs > toMs)) continue;

    out.push({
      eventId: r.eventId,
      occurredAt: r.occurredAt,
      eventType: r.eventType,
      amount: r.amount,
      method: r.method,
      processorReference: r.processorReference,
      note: r.note,
      reason: r.reason,
      actorUserId: r.actorUserId,
      actorName: r.actorName,
      memberNumber: r.memberNumber,
      firstName: r.firstName,
      lastName: r.lastName,
      memberEmail: r.memberEmail,
      levyName: r.levyName,
      currency: r.currency,
      runningPaid: runningPaid.toFixed(2),
      runningRefunded: runningRefunded.toFixed(2),
      runningBalance: runningBalance.toFixed(2),
    });
  }

  // Restore chronological output across charges (the SQL ordered by chargeId
  // first so we could walk per-charge in one pass). Tie-break by eventId so
  // ordering is fully deterministic across charges with identical occurredAt
  // timestamps — important for audit reproducibility.
  out.sort((a, b) => {
    const aMs = a.occurredAt ? new Date(a.occurredAt).getTime() : 0;
    const bMs = b.occurredAt ? new Date(b.occurredAt).getTime() : 0;
    if (aMs !== bMs) return aMs - bMs;
    return a.eventId - b.eventId;
  });
  return out;
}

/**
 * Reusable builder for the levy-ledger CSV. Used by the on-demand download
 * endpoint and by the scheduled-email cron (Task 229) so both surfaces
 * always produce the same file format.
 *
 * Includes per-row running totals (running_paid, running_refunded,
 * running_balance) computed per (charge, chronological) so treasurers can
 * reconcile the CSV row-by-row against bank statements (Task #341).
 */
export async function buildLevyLedgerCsv(opts: {
  orgId: number;
  levyId?: number | null;
  memberId?: number | null;
  type?: string | null;
  from?: Date | null;
  to?: Date | null;
}): Promise<{ csv: string; rowCount: number }> {
  const rows = await fetchLevyLedgerExportRows(opts);

  const header = [
    "date", "member_number", "member", "email",
    "levy", "currency", "type", "amount",
    "method", "processor_reference", "note_or_reason", "actor",
    "running_paid", "running_refunded", "running_balance",
  ];
  const csvRows: string[][] = [header];
  for (const r of rows) {
    const member = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
    const actor = r.actorName ?? (r.actorUserId != null ? `user#${r.actorUserId}` : "");
    csvRows.push([
      r.occurredAt ? new Date(r.occurredAt).toISOString() : "",
      r.memberNumber ?? "",
      member,
      r.memberEmail ?? "",
      r.levyName ?? "",
      r.currency ?? "",
      r.eventType,
      String(r.amount ?? ""),
      r.method ?? "",
      r.processorReference ?? "",
      r.note ?? r.reason ?? "",
      actor,
      r.runningPaid,
      r.runningRefunded,
      r.runningBalance,
    ]);
  }
  const csv = csvRows
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
  return { csv, rowCount: rows.length };
}

router.get("/levy-ledger.csv", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  let levyId: number | null = null;
  let memberId: number | null = null;
  let type: string | null = null;
  let from: Date | null = null;
  let to: Date | null = null;

  const rawLevyId = req.query.levyId;
  if (rawLevyId !== undefined && rawLevyId !== "") {
    const lid = parseInt(String(rawLevyId));
    if (!Number.isFinite(lid)) { { res.status(400).json({ error: "invalid levyId" }); return; } }
    levyId = lid;
  }
  const rawMemberId = req.query.memberId;
  if (rawMemberId !== undefined && rawMemberId !== "") {
    const mid = parseInt(String(rawMemberId));
    if (!Number.isFinite(mid)) { { res.status(400).json({ error: "invalid memberId" }); return; } }
    memberId = mid;
  }
  const rawType = req.query.type;
  if (rawType !== undefined && rawType !== "" && rawType !== "all") {
    const t = String(rawType).toLowerCase();
    if (!LEVY_LEDGER_EVENT_TYPES.has(t)) { { res.status(400).json({ error: "invalid type" }); return; } }
    type = t;
  }
  const rawFrom = req.query.from;
  if (rawFrom !== undefined && rawFrom !== "") {
    const d = new Date(String(rawFrom));
    if (Number.isNaN(d.getTime())) { { res.status(400).json({ error: "invalid from date" }); return; } }
    from = d;
  }
  const rawTo = req.query.to;
  if (rawTo !== undefined && rawTo !== "") {
    const d = new Date(String(rawTo));
    if (Number.isNaN(d.getTime())) { { res.status(400).json({ error: "invalid to date" }); return; } }
    to = d;
  }

  const { csv } = await buildLevyLedgerCsv({ orgId, levyId, memberId, type, from, to });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  const filename = `levy-ledger${levyId != null ? `-${levyId}` : ""}.csv`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// ─── Recurring email of the levy ledger CSV (Task #229) ──────────────────────
//
// Treasurers want the previous period's ledger to land in their inbox
// automatically so reconciliation doesn't require anyone to log in. One
// schedule per (org, levy); the in-process cron (`runLevyLedgerEmailSchedules`
// in lib/cron.ts) picks up enabled rows whose `next_run_at` has elapsed,
// builds the CSV for the elapsed period using `buildLevyLedgerCsv`, and emails
// it to the configured recipients.

const LEVY_LEDGER_SCHEDULE_FREQUENCIES = new Set(["weekly", "monthly"]);
// Task #322: org-level club-wide digest can ship the combined CSV, a ZIP with
// one CSV per levy, or both. Defaults to "combined" for backwards compat.
const LEVY_LEDGER_ORG_DELIVERY_FORMATS = new Set(["combined", "per_levy_zip", "both"]);
type LevyLedgerOrgDeliveryFormat = "combined" | "per_levy_zip" | "both";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Compute the next run datetime for a given frequency starting from `from`. */
export function computeLevyLedgerNextRunAt(frequency: string, from: Date = new Date()): Date {
  const d = new Date(from);
  if (frequency === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
  } else {
    // monthly
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  // Anchor delivery to 07:00 UTC on the run day so it lands at the
  // start of the work-day for most reconciliation timezones.
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

/**
 * Surface which configured recipients on a levy-ledger digest schedule are
 * currently paused by the bounce-aware filter (Task #1444 + Task #1763).
 *
 * The cron's `runOneLevyLedgerEmailSchedule` filters every saved recipient
 * against `email_suppressions` before sending; paused addresses are silently
 * dropped from that run AND removed from the schedule's stored recipients
 * list. Until Task #1763, the only way for an admin to learn that a
 * recipient had been paused was to read the run-history's free-text
 * `errorMessage`. This helper repeats the same join the cron does, but
 * against an arbitrary recipient list (the saved one for the dashboard's
 * "X paused" chip, or the just-saved-edited one for the editor's warning),
 * and returns each match's suppression metadata so the dashboard can show
 * the bounce / unsubscribe / spam_complaint reason inline and offer a
 * one-click "remove from suppression list" action.
 *
 * Mirrors `loadPausedRecipientsForOrg` on the wallet auto-refund digest
 * (Task #1443) — same shape so the React panels can share the
 * `PausedRecipientRow` type.
 *
 * Returns an empty array when `recipients` is empty so callers don't need
 * a guard. The mapping is case-insensitive — both the schedule's stored
 * list and `email_suppressions.email` are lower-cased before joining,
 * mirroring the cron filter — but the returned `email` preserves the
 * casing the user typed into the recipient list so the warning row matches
 * what they see.
 */
interface LevyLedgerPausedRecipientRow {
  /**
   * Suppression row primary key when the address is *currently* on the
   * org's `email_suppressions` list, or `null` when it only appears on a
   * past run's snapshot because the suppression was lifted in the
   * meantime. The frontend's "remove from suppression list" button is
   * hidden for null-id rows since there is nothing to remove.
   */
  suppressionId: number | null;
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
  createdAt: string;
  /**
   * `true` when the row was sourced from the most recent run's
   * `paused_recipients` snapshot rather than the live suppression list.
   * Lets the dashboard render a slightly different copy ("auto-removed
   * on last run") for addresses Task #1444 has already pruned out of
   * `schedule.recipients`.
   */
  fromRunSnapshot: boolean;
}

/**
 * Build the dashboard's paused-recipient list for a single levy-ledger
 * digest schedule. Sources from two places, deduped by lower(email):
 *
 *   1. The most recent run's `paused_recipients` jsonb snapshot — the
 *      durable record of who the cron actually filtered out, captured
 *      *before* Task #1444 pruned them from `schedule.recipients`.
 *      Without this, addresses dropped during the very first cron run
 *      after a bounce would never appear on the dashboard at all.
 *   2. Any currently-saved recipient that is still on the org's live
 *      `email_suppressions` list — covers freshly added recipients the
 *      admin just typed in that are already known-bad, before any run
 *      has happened to record them in the snapshot above.
 *
 * Live suppression metadata wins on conflict (newer reason / bounceType
 * than the run snapshot). The frontend uses `fromRunSnapshot` to render
 * "auto-removed on last run" copy for snapshot-only rows.
 */
async function loadPausedLevyLedgerRecipients(opts: {
  orgId: number;
  scheduleId: number | null;
  configuredRecipients: string[];
  runTable: typeof levyLedgerEmailRunsTable | typeof levyLedgerEmailOrgRunsTable;
}): Promise<LevyLedgerPausedRecipientRow[]> {
  const { orgId, scheduleId, configuredRecipients, runTable } = opts;

  // Pull the most recent run's snapshot. Each run row carries the full
  // paused-recipients metadata captured by the cron when the address was
  // dropped, so the dashboard remains accurate after Task #1444 prunes
  // the address from `schedule.recipients`.
  let snapshotPaused: DigestPausedRecipientSnapshot[] = [];
  if (scheduleId !== null) {
    try {
      const [latestRun] = await db.select({ pausedRecipients: runTable.pausedRecipients })
        .from(runTable)
        .where(eq(runTable.scheduleId, scheduleId))
        .orderBy(desc(runTable.sentAt))
        .limit(1);
      if (latestRun) {
        const raw = latestRun.pausedRecipients;
        snapshotPaused = Array.isArray(raw) ? (raw as DigestPausedRecipientSnapshot[]) : [];
      }
    } catch (err) {
      baseLogger.warn({ err, orgId, scheduleId }, "[levy-ledger-email] latest-run snapshot lookup failed; falling back to live suppression list only");
    }
  }

  // Map of lower(email) → preferred display casing. Snapshot addresses
  // win first (they preserve the casing the admin originally entered),
  // overridden by the configured-recipients list when a row is still
  // present there.
  const lowerToOriginal = new Map<string, string>();
  for (const snap of snapshotPaused) {
    const lower = String(snap.email ?? "").trim().toLowerCase();
    if (lower && !lowerToOriginal.has(lower)) lowerToOriginal.set(lower, snap.email);
  }
  for (const r of configuredRecipients) {
    const lower = r.trim().toLowerCase();
    if (lower) lowerToOriginal.set(lower, r);
  }
  const lowerList = [...lowerToOriginal.keys()];

  // Live suppression rows for any address either currently configured
  // OR present on the latest run's snapshot — the dashboard merges both
  // sources so a recipient pruned by Task #1444 is still visible AND
  // gets the unsuppress affordance if the suppression itself is still
  // active.
  const liveByLower = new Map<string, { id: number; reason: string; bounceType: string | null; description: string | null; createdAt: Date | string }>();
  if (lowerList.length > 0) {
    try {
      const rows = await db.select({
        id: emailSuppressionsTable.id,
        email: emailSuppressionsTable.email,
        reason: emailSuppressionsTable.reason,
        bounceType: emailSuppressionsTable.bounceType,
        description: emailSuppressionsTable.description,
        createdAt: emailSuppressionsTable.createdAt,
      }).from(emailSuppressionsTable).where(and(
        eq(emailSuppressionsTable.organizationId, orgId),
        inArray(emailSuppressionsTable.email, lowerList),
      ));
      for (const r of rows) {
        liveByLower.set(String(r.email ?? "").toLowerCase(), {
          id: r.id,
          reason: r.reason,
          bounceType: r.bounceType,
          description: r.description,
          createdAt: r.createdAt,
        });
      }
    } catch (err) {
      baseLogger.warn({ err, orgId }, "[levy-ledger-email] live suppression lookup failed; reporting snapshot only");
    }
  }

  const configuredLower = new Set<string>();
  for (const r of configuredRecipients) {
    const lower = r.trim().toLowerCase();
    if (lower) configuredLower.add(lower);
  }

  // Walk every email we should consider paused. An address is paused if
  // it is on the live suppression list (regardless of whether it is
  // still in `schedule.recipients`) OR if it was filtered out on the
  // most recent run snapshot. Snapshot rows fall back to their snapshot
  // metadata when the suppression has since been lifted, so finance can
  // still see "this is who got dropped on the last run".
  const snapshotByLower = new Map<string, DigestPausedRecipientSnapshot>();
  for (const snap of snapshotPaused) {
    const lower = String(snap.email ?? "").trim().toLowerCase();
    if (lower) snapshotByLower.set(lower, snap);
  }

  const out: LevyLedgerPausedRecipientRow[] = [];
  const emitted = new Set<string>();
  for (const lower of lowerList) {
    if (emitted.has(lower)) continue;
    const live = liveByLower.get(lower);
    const snap = snapshotByLower.get(lower);
    const onConfigured = configuredLower.has(lower);
    // Skip live-suppressed addresses that were never on this schedule
    // at all — those are unrelated bounces (e.g. another digest's
    // recipient that happens to share the org's suppression list).
    if (!live && !snap) continue;
    if (live && !snap && !onConfigured) continue;
    const display = lowerToOriginal.get(lower) ?? lower;
    if (live) {
      out.push({
        suppressionId: live.id,
        email: display,
        reason: live.reason,
        bounceType: live.bounceType,
        description: live.description,
        createdAt: live.createdAt instanceof Date ? live.createdAt.toISOString() : String(live.createdAt),
        // Snapshot-aware copy applies whenever the address is no longer
        // in `schedule.recipients` — Task #1444 has already pruned it.
        fromRunSnapshot: !onConfigured,
      });
    } else if (snap) {
      out.push({
        suppressionId: null,
        email: display,
        reason: snap.reason,
        bounceType: snap.bounceType,
        description: snap.description,
        // No live suppression row to source `createdAt` from — fall
        // back to "now" so the table sorts the snapshot-only entry
        // alongside live ones without needing a nullable column.
        createdAt: new Date().toISOString(),
        fromRunSnapshot: true,
      });
    }
    emitted.add(lower);
  }
  return out;
}

router.get("/levies/:id/email-schedule", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "invalid levy id" }); return; } }

  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }

  const [schedule] = await db.select().from(levyLedgerEmailSchedulesTable)
    .where(and(
      eq(levyLedgerEmailSchedulesTable.organizationId, orgId),
      eq(levyLedgerEmailSchedulesTable.levyId, id),
    ));

  const history = schedule
    ? await db.select().from(levyLedgerEmailRunsTable)
        .where(eq(levyLedgerEmailRunsTable.scheduleId, schedule.id))
        .orderBy(desc(levyLedgerEmailRunsTable.sentAt))
        .limit(50)
    : [];

  // Task #1763 — surface which of the schedule's configured recipients are
  // currently on the bounce / unsubscribe / spam-complaint suppression list
  // so admins can see "X paused" on the schedule edit drawer without
  // parsing the run-history's free-text errorMessage.
  const pausedRecipients = schedule
    ? await loadPausedLevyLedgerRecipients({
        orgId,
        scheduleId: schedule.id,
        configuredRecipients: Array.isArray(schedule.recipients) ? schedule.recipients as string[] : [],
        runTable: levyLedgerEmailRunsTable,
      })
    : [];

  res.json({ schedule: schedule ?? null, history, pausedRecipients });
});

router.put("/levies/:id/email-schedule", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "invalid levy id" }); return; } }

  const body = req.body as { frequency?: string; recipients?: unknown; enabled?: boolean };
  const frequency = String(body.frequency ?? "").toLowerCase();
  if (!LEVY_LEDGER_SCHEDULE_FREQUENCIES.has(frequency)) {
    res.status(400).json({ error: "frequency must be 'weekly' or 'monthly'" }); return;
  }
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : [];
  const recipients: string[] = [];
  for (const r of recipientsRaw) {
    const s = String(r ?? "").trim();
    if (!s) continue;
    if (!EMAIL_RE.test(s)) { { res.status(400).json({ error: `invalid recipient email: ${s}` }); return; } }
    if (!recipients.includes(s)) recipients.push(s);
  }
  if (recipients.length === 0) {
    res.status(400).json({ error: "at least one recipient email is required" }); return;
  }
  if (recipients.length > 20) {
    res.status(400).json({ error: "no more than 20 recipients per schedule" }); return;
  }
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);

  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }

  const now = new Date();
  const user = req.user as { id: number };

  const [existing] = await db.select().from(levyLedgerEmailSchedulesTable)
    .where(and(
      eq(levyLedgerEmailSchedulesTable.organizationId, orgId),
      eq(levyLedgerEmailSchedulesTable.levyId, id),
    ));

  let saved;
  if (existing) {
    // Recompute next_run_at when frequency changes, otherwise preserve the
    // pending cadence. Re-enabling a paused schedule reschedules from now.
    const freqChanged = existing.frequency !== frequency;
    const reEnabled = !existing.enabled && enabled;
    const nextRunAt = (freqChanged || reEnabled || !existing.nextRunAt)
      ? computeLevyLedgerNextRunAt(frequency, now)
      : existing.nextRunAt;
    const [row] = await db.update(levyLedgerEmailSchedulesTable).set({
      frequency, recipients, enabled, nextRunAt, updatedAt: now,
    }).where(eq(levyLedgerEmailSchedulesTable.id, existing.id)).returning();
    saved = row;
  } else {
    const [row] = await db.insert(levyLedgerEmailSchedulesTable).values({
      organizationId: orgId,
      levyId: id,
      frequency,
      recipients,
      enabled,
      nextRunAt: computeLevyLedgerNextRunAt(frequency, now),
      createdByUserId: user?.id ?? null,
    }).returning();
    saved = row;
  }

  // Task #1763 — surface any just-saved recipients that are already on the
  // org's suppression list so the editor can immediately warn admins and
  // offer the "remove from suppression list" affordance, rather than
  // waiting for the next cron tick to silently drop them. Mirrors the
  // wallet auto-refund digest pattern (Task #1443).
  const pausedRecipients = await loadPausedLevyLedgerRecipients({
    orgId,
    scheduleId: saved.id,
    configuredRecipients: Array.isArray(saved.recipients) ? saved.recipients as string[] : [],
    runTable: levyLedgerEmailRunsTable,
  });
  res.json({ schedule: saved, pausedRecipients });
});

/**
 * Lift the email suppression that paused this address (Task #1763).
 *
 * Used by the schedule edit drawer's "remove from suppression list" button
 * next to a paused recipient row — the admin has triaged the
 * bounce/unsubscribe and confirmed the address is fine to mail again. We
 * look up the suppression by `(orgId, lower(email))` so the caller doesn't
 * need to know the suppression's primary key, and we delete every matching
 * row even though `email_suppressions_unique` should only allow one
 * (defensive). When the recipient was already auto-pruned from the
 * schedule by Task #1444's bounce-aware pause, restore it so admins don't
 * have to re-type the address. Mirrors the wallet auto-refund unsuppress
 * route (Task #1443).
 */
router.post("/levies/:id/email-schedule/unsuppress", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "invalid levy id" }); return; } }

  const rawEmail = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!rawEmail || !EMAIL_RE.test(rawEmail)) {
    res.status(400).json({ error: "valid email is required" }); return;
  }
  const lower = rawEmail.toLowerCase();

  const deleted = await db.delete(emailSuppressionsTable).where(and(
    eq(emailSuppressionsTable.organizationId, orgId),
    eq(emailSuppressionsTable.email, lower),
  )).returning({ id: emailSuppressionsTable.id });

  let restoredToSchedule = false;
  const [schedule] = await db.select().from(levyLedgerEmailSchedulesTable)
    .where(and(
      eq(levyLedgerEmailSchedulesTable.organizationId, orgId),
      eq(levyLedgerEmailSchedulesTable.levyId, id),
    ));
  if (schedule) {
    const recipients = Array.isArray(schedule.recipients) ? schedule.recipients as string[] : [];
    const alreadyOnList = recipients.some(r => r.trim().toLowerCase() === lower);
    if (!alreadyOnList && recipients.length < 20) {
      await db.update(levyLedgerEmailSchedulesTable).set({
        recipients: [...recipients, rawEmail],
        updatedAt: new Date(),
      }).where(eq(levyLedgerEmailSchedulesTable.id, schedule.id));
      restoredToSchedule = true;
    }
  }

  res.json({ ok: true, removed: deleted.length, restoredToSchedule });
});

router.delete("/levies/:id/email-schedule", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "invalid levy id" }); return; } }

  await db.delete(levyLedgerEmailSchedulesTable)
    .where(and(
      eq(levyLedgerEmailSchedulesTable.organizationId, orgId),
      eq(levyLedgerEmailSchedulesTable.levyId, id),
    ));
  res.json({ ok: true });
});

/**
 * Trigger the scheduled email immediately. Useful for admins to verify the
 * configuration without waiting for the next cron tick. Records a row in the
 * history just like a normal scheduled run.
 */
router.post("/levies/:id/email-schedule/send-now", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "invalid levy id" }); return; } }

  const [schedule] = await db.select().from(levyLedgerEmailSchedulesTable)
    .where(and(
      eq(levyLedgerEmailSchedulesTable.organizationId, orgId),
      eq(levyLedgerEmailSchedulesTable.levyId, id),
    ));
  if (!schedule) { { res.status(404).json({ error: "No schedule configured for this levy" }); return; } }

  const result = await runOneLevyLedgerEmailSchedule(schedule.id);
  res.json(result);
});

/**
 * Preview the next scheduled ledger email without inserting a history row or
 * sending email. Returns the row count, the period that would be covered, the
 * configured recipients, and the CSV payload itself (Task #277). Treasurers
 * use this to validate filters before triggering a real send. Supports a
 * `?download=1` query param so the same endpoint serves the JSON summary and
 * the raw CSV attachment used by the "Download preview" UI link.
 */
router.get("/levies/:id/email-schedule/preview", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "invalid levy id" }); return; } }

  const [schedule] = await db.select().from(levyLedgerEmailSchedulesTable)
    .where(and(
      eq(levyLedgerEmailSchedulesTable.organizationId, orgId),
      eq(levyLedgerEmailSchedulesTable.levyId, id),
    ));
  if (!schedule) { { res.status(404).json({ error: "No schedule configured for this levy" }); return; } }

  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000);

  const { csv, rowCount } = await buildLevyLedgerCsv({
    orgId,
    levyId: id,
    from: periodStart,
    to: now,
  });

  if (String(req.query.download ?? "") === "1") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="levy-ledger-${id}-preview.csv"`);
    res.send(csv);
    return;
  }

  const recipients = Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [];
  res.json({
    rowCount,
    periodStart: periodStart.toISOString(),
    periodEnd: now.toISOString(),
    recipients,
    frequency: schedule.frequency,
    csv,
  });
});

/**
 * Execute one schedule end-to-end: build the period CSV, email it to the
 * configured recipients, record the run in history, and advance the cadence.
 * Exported so the cron poller and the manual send-now endpoint share the
 * exact same code path.
 */
export async function runOneLevyLedgerEmailSchedule(scheduleId: number): Promise<{
  status: "sent" | "failed" | "skipped";
  rowCount: number;
  recipients: string[];
  errorMessage?: string;
  pausedRecipients?: string[];
}> {
  const [schedule] = await db.select().from(levyLedgerEmailSchedulesTable)
    .where(eq(levyLedgerEmailSchedulesTable.id, scheduleId));
  if (!schedule) {
    return { status: "skipped", rowCount: 0, recipients: [], errorMessage: "schedule not found" };
  }

  const configuredRecipients = Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [];
  const now = new Date();

  // Period covers from the previous send (or one full cadence ago for the
  // first run) through the moment the cron picks the schedule up. This makes
  // the file the treasurer receives self-contained — every event on the
  // ledger between consecutive emails appears on exactly one file.
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000);

  const [levy] = await db.select().from(memberLeviesTable)
    .where(eq(memberLeviesTable.id, schedule.levyId));
  if (!levy) {
    await db.insert(levyLedgerEmailRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients: configuredRecipients,
      rowCount: 0,
      status: "skipped",
      errorMessage: "underlying levy was deleted",
    });
    // Disable so we don't keep trying.
    await db.update(levyLedgerEmailSchedulesTable)
      .set({ enabled: false, updatedAt: now })
      .where(eq(levyLedgerEmailSchedulesTable.id, schedule.id));
    return { status: "skipped", rowCount: 0, recipients: configuredRecipients, errorMessage: "underlying levy was deleted" };
  }

  if (configuredRecipients.length === 0) {
    const errorMessage = "no recipients configured";
    await db.insert(levyLedgerEmailRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients: [],
      rowCount: 0,
      status: "skipped",
      errorMessage,
    });
    // Task #1444 — advance the cadence even on this skipped path. The
    // bounce-aware pause logic below can auto-empty a schedule's
    // recipient list, so without this every subsequent poll would
    // re-fire a fresh skipped run on each cron tick. Mirrors the
    // wallet-refund digest behaviour (Task #1233).
    await db.update(levyLedgerEmailSchedulesTable).set({
      lastSentAt: now,
      nextRunAt: computeLevyLedgerNextRunAt(schedule.frequency, now),
      updatedAt: now,
    }).where(eq(levyLedgerEmailSchedulesTable.id, schedule.id));
    const [orgForAlert] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, schedule.organizationId));
    await notifyAdminsOfLevyLedgerDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      levyName: levy.name,
      status: "skipped",
      errorMessage,
      pausedRecipients: [],
      org: orgForAlert ?? null,
    });
    return { status: "skipped", rowCount: 0, recipients: [], errorMessage };
  }

  // ── Bounce-aware recipient filter (Task #1444) ────────────────────────
  // Mirrors the wallet auto-refund digest pattern (Task #1233): every
  // suppressed address is removed from the current send AND persisted
  // back to the schedule row so the next run does not re-hammer a known-
  // bad inbox.
  const { recipients, pausedRecipients, pausedRecipientsSnapshot } = await pauseSuppressedRecipients({
    organizationId: schedule.organizationId,
    configuredRecipients,
    logScope: "levy-ledger-email",
  });
  if (pausedRecipients.length > 0) {
    try {
      await db.update(levyLedgerEmailSchedulesTable).set({
        recipients,
        updatedAt: now,
      }).where(eq(levyLedgerEmailSchedulesTable.id, schedule.id));
    } catch (err) {
      baseLogger.warn({ err, scheduleId: schedule.id }, "[levy-ledger-email] failed to persist paused recipients");
    }
  }

  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
  }).from(organizationsTable).where(eq(organizationsTable.id, schedule.organizationId));

  // Every configured recipient is now paused — nothing to send, but we
  // do need to alert admins so finance can fix the recipient list before
  // another cadence elapses silently.
  if (recipients.length === 0) {
    const errorMessage = `paused all configured recipients (${pausedRecipients.join(", ")}) — every address is on the bounce / unsubscribe suppression list`;
    await db.insert(levyLedgerEmailRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients: [],
      rowCount: 0,
      status: "skipped",
      errorMessage,
      // Task #1763 — every configured recipient was paused; snapshot the
      // full list (with reason metadata) so the schedule editor can show
      // the chip even after the suppression is later lifted.
      pausedRecipients: pausedRecipientsSnapshot,
    });
    await db.update(levyLedgerEmailSchedulesTable).set({
      lastSentAt: now,
      nextRunAt: computeLevyLedgerNextRunAt(schedule.frequency, now),
      updatedAt: now,
    }).where(eq(levyLedgerEmailSchedulesTable.id, schedule.id));
    await notifyAdminsOfLevyLedgerDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      levyName: levy.name,
      status: "skipped",
      errorMessage,
      pausedRecipients,
      org: org ?? null,
    });
    return { status: "skipped", rowCount: 0, recipients: [], errorMessage, pausedRecipients };
  }

  const { csv, rowCount } = await buildLevyLedgerCsv({
    orgId: schedule.organizationId,
    levyId: schedule.levyId,
    from: periodStart,
    to: now,
  });

  let status: "sent" | "failed" = "sent";
  let errorMessage: string | undefined;

  try {
    await sendLevyLedgerScheduleEmail({
      to: recipients,
      orgName: org?.name ?? "KHARAGOLF",
      levyName: levy.name,
      frequency: schedule.frequency as "weekly" | "monthly",
      periodStart,
      periodEnd: now,
      rowCount,
      csv,
    });
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    baseLogger.warn({ err, scheduleId: schedule.id }, "[levy-ledger-email] send failed");
  }

  // When some (but not all) recipients were paused, surface that on the
  // run row's errorMessage even on a `sent` status so the dashboard
  // history table makes the pause visible.
  let runErrorMessage: string | undefined = errorMessage;
  if (pausedRecipients.length > 0) {
    const pauseNote = `paused ${pausedRecipients.length} bounced/unsubscribed recipient(s): ${pausedRecipients.join(", ")}`;
    runErrorMessage = runErrorMessage ? `${runErrorMessage}; ${pauseNote}` : pauseNote;
  }

  await db.insert(levyLedgerEmailRunsTable).values({
    scheduleId: schedule.id,
    organizationId: schedule.organizationId,
    periodStart,
    periodEnd: now,
    recipients,
    rowCount,
    status,
    errorMessage: runErrorMessage,
    // Task #1763 — snapshot the per-recipient pause metadata onto the
    // run row so the schedule editor can render the same chip (with
    // reason + bounceType) the dashboard uses, even after Task #1444
    // pruned these addresses from `schedule.recipients`.
    pausedRecipients: pausedRecipientsSnapshot,
  });

  // Advance the cadence even on failure so we don't spam a broken inbox every
  // poll cycle. Failures show up in history with the error message; the next
  // run will retry on the normal schedule.
  await db.update(levyLedgerEmailSchedulesTable).set({
    lastSentAt: now,
    nextRunAt: computeLevyLedgerNextRunAt(schedule.frequency, now),
    updatedAt: now,
  }).where(eq(levyLedgerEmailSchedulesTable.id, schedule.id));

  if (status === "failed") {
    await notifyAdminsOfLevyLedgerDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      levyName: levy.name,
      status: "failed",
      errorMessage: errorMessage ?? "unknown error",
      pausedRecipients,
      org: org ?? null,
    });
  }

  return {
    status,
    rowCount,
    recipients,
    errorMessage,
    pausedRecipients: pausedRecipients.length > 0 ? pausedRecipients : undefined,
  };
}

/**
 * Task #1444 — alert org admins / treasurers / membership_secretaries
 * that a per-levy ledger digest failed (or was paused entirely because
 * every recipient bounced). Mirrors the wallet auto-refund pattern from
 * Task #1233 down to the consecutive-failure escalation count so the
 * Nth still-broken email in a row reads as such without us spamming
 * admins on every poll.
 */
async function notifyAdminsOfLevyLedgerDigestFailure(opts: {
  orgId: number;
  scheduleId: number;
  levyName: string;
  status: "failed" | "skipped";
  errorMessage: string;
  pausedRecipients: string[];
  org: { name: string; logoUrl: string | null; primaryColor: string | null } | null;
}): Promise<void> {
  try {
    const directAdmins = await db
      .select({ userId: appUsersTable.id })
      .from(appUsersTable)
      .where(and(
        eq(appUsersTable.organizationId, opts.orgId),
        eq(appUsersTable.role, "org_admin"),
      ));
    const memberAdmins = await db
      .select({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, opts.orgId),
        inArray(orgMembershipsTable.role, ["org_admin", "treasurer", "membership_secretary"]),
      ));
    const userIds = Array.from(new Set(
      [...directAdmins, ...memberAdmins].map(r => r.userId).filter((n): n is number => typeof n === "number"),
    ));
    if (userIds.length === 0) {
      baseLogger.info({ orgId: opts.orgId, scheduleId: opts.scheduleId }, "[levy-ledger-email] no admin recipients for failure alert");
      return;
    }

    let consecutiveFailures = 1;
    try {
      const recentRuns = await db
        .select({ status: levyLedgerEmailRunsTable.status })
        .from(levyLedgerEmailRunsTable)
        .where(eq(levyLedgerEmailRunsTable.scheduleId, opts.scheduleId))
        .orderBy(desc(levyLedgerEmailRunsTable.sentAt))
        .limit(20);
      consecutiveFailures = 0;
      for (const r of recentRuns) {
        if (r.status === "sent") break;
        consecutiveFailures += 1;
      }
      if (consecutiveFailures < 1) consecutiveFailures = 1;
    } catch (err) {
      baseLogger.warn({ err, scheduleId: opts.scheduleId }, "[levy-ledger-email] consecutive-failure count lookup failed");
    }

    const orgName = opts.org?.name ?? "your club";
    const safeLevy = escapeHtmlForLevyDigestAlert(opts.levyName);
    const title = opts.status === "skipped"
      ? `Levy ledger digest paused — every recipient is bouncing (${orgName} · ${opts.levyName})`
      : `Levy ledger digest failed to send (${orgName} · ${opts.levyName})`;
    const reasonLine = opts.status === "skipped"
      ? `Every configured recipient for the "${opts.levyName}" ledger digest is on the bounce / unsubscribe list, so this period's CSV was not sent. Paused recipients: ${opts.pausedRecipients.join(", ") || "(none)"}.`
      : `The mailer rejected the "${opts.levyName}" ledger digest send: ${opts.errorMessage}`;
    const pausedLine = opts.pausedRecipients.length > 0 && opts.status !== "skipped"
      ? ` We also paused ${opts.pausedRecipients.length} previously-bouncing recipient(s) from future runs: ${opts.pausedRecipients.join(", ")}.`
      : "";
    const consecutiveLine = consecutiveFailures > 1
      ? ` This is the ${consecutiveFailures}th consecutive run that did not deliver — please update the recipient list in Member 360 → Levies → "${opts.levyName}" → Email schedule.`
      : ` Open Member 360 → Levies → "${opts.levyName}" → Email schedule to update the recipient list.`;
    const body = `${reasonLine}${pausedLine}${consecutiveLine}`;
    const safeBody = escapeHtmlForLevyDigestAlert(body);
    const safeTitle = escapeHtmlForLevyDigestAlert(title);
    const emailHtml = `<div style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#fff;padding:24px;max-width:560px;margin:0 auto;border-radius:12px;">
        <h2 style="margin:0 0 12px;font-size:18px;color:#f87171;">${safeTitle}</h2>
        <p style="margin:0 0 16px;color:#d1d5db;line-height:1.5;">${safeBody}</p>
        <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Levy: ${safeLevy} · Schedule id: ${opts.scheduleId} · Status: ${opts.status} · Consecutive failures: ${consecutiveFailures}</p>
      </div>`;

    const { dispatchNotification } = await import("../lib/notifyDispatch");
    await dispatchNotification("levy.ledger.digest.failed", userIds, {
      title,
      body,
      emailSubject: title,
      emailHtml,
      data: {
        scheduleId: opts.scheduleId,
        organizationId: opts.orgId,
        levyName: opts.levyName,
        status: opts.status,
        errorMessage: opts.errorMessage,
        pausedRecipients: opts.pausedRecipients,
        consecutiveFailures,
      },
      branding: {
        orgName: opts.org?.name ?? "KHARAGOLF",
        logoUrl: opts.org?.logoUrl ?? undefined,
        primaryColor: opts.org?.primaryColor ?? undefined,
        orgId: opts.orgId,
      },
    });
  } catch (err) {
    baseLogger.warn({ err, scheduleId: opts.scheduleId }, "[levy-ledger-email] admin failure dispatch failed");
  }
}

function escapeHtmlForLevyDigestAlert(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Org-wide combined ledger digest (Task #278) ─────────────────────────────
//
// One schedule per organization that bundles every levy's ledger entries for
// the period into a single CSV email. Treasurers running a dozen levies
// receive one rolled-up file per cadence instead of one email per levy.

router.get("/levy-ledger/email-schedule", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const [schedule] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
    .where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, orgId));

  const history = schedule
    ? await db.select().from(levyLedgerEmailOrgRunsTable)
        .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, schedule.id))
        .orderBy(desc(levyLedgerEmailOrgRunsTable.sentAt))
        .limit(50)
    : [];

  // Task #1763 — surface which of the schedule's configured recipients are
  // currently on the bounce / unsubscribe / spam-complaint suppression list
  // so admins can see "X paused" on the club-wide ledger digest editor
  // without parsing the run-history's free-text errorMessage.
  const pausedRecipients = schedule
    ? await loadPausedLevyLedgerRecipients({
        orgId,
        scheduleId: schedule.id,
        configuredRecipients: Array.isArray(schedule.recipients) ? schedule.recipients as string[] : [],
        runTable: levyLedgerEmailOrgRunsTable,
      })
    : [];

  res.json({ schedule: schedule ?? null, history, pausedRecipients });
});

router.put("/levy-ledger/email-schedule", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const body = req.body as { frequency?: string; recipients?: unknown; enabled?: boolean; deliveryFormat?: string };
  const frequency = String(body.frequency ?? "").toLowerCase();
  if (!LEVY_LEDGER_SCHEDULE_FREQUENCIES.has(frequency)) {
    res.status(400).json({ error: "frequency must be 'weekly' or 'monthly'" }); return;
  }
  const deliveryFormat = String(body.deliveryFormat ?? "combined").toLowerCase();
  if (!LEVY_LEDGER_ORG_DELIVERY_FORMATS.has(deliveryFormat)) {
    res.status(400).json({ error: "deliveryFormat must be 'combined', 'per_levy_zip', or 'both'" }); return;
  }
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : [];
  const recipients: string[] = [];
  for (const r of recipientsRaw) {
    const s = String(r ?? "").trim();
    if (!s) continue;
    if (!EMAIL_RE.test(s)) { { res.status(400).json({ error: `invalid recipient email: ${s}` }); return; } }
    if (!recipients.includes(s)) recipients.push(s);
  }
  if (recipients.length === 0) {
    res.status(400).json({ error: "at least one recipient email is required" }); return;
  }
  if (recipients.length > 20) {
    res.status(400).json({ error: "no more than 20 recipients per schedule" }); return;
  }
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);

  const now = new Date();
  const user = req.user as { id: number };

  const [existing] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
    .where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, orgId));

  let saved;
  if (existing) {
    const freqChanged = existing.frequency !== frequency;
    const reEnabled = !existing.enabled && enabled;
    const nextRunAt = (freqChanged || reEnabled || !existing.nextRunAt)
      ? computeLevyLedgerNextRunAt(frequency, now)
      : existing.nextRunAt;
    const [row] = await db.update(levyLedgerEmailOrgSchedulesTable).set({
      frequency, recipients, enabled, deliveryFormat, nextRunAt, updatedAt: now,
    }).where(eq(levyLedgerEmailOrgSchedulesTable.id, existing.id)).returning();
    saved = row;
  } else {
    const [row] = await db.insert(levyLedgerEmailOrgSchedulesTable).values({
      organizationId: orgId,
      frequency,
      recipients,
      enabled,
      deliveryFormat,
      nextRunAt: computeLevyLedgerNextRunAt(frequency, now),
      createdByUserId: user?.id ?? null,
    }).returning();
    saved = row;
  }

  // Task #1763 — surface any just-saved recipients that are already on the
  // org's suppression list so the editor can immediately warn admins and
  // offer the "remove from suppression list" affordance.
  const pausedRecipients = await loadPausedLevyLedgerRecipients({
    orgId,
    scheduleId: saved.id,
    configuredRecipients: Array.isArray(saved.recipients) ? saved.recipients as string[] : [],
    runTable: levyLedgerEmailOrgRunsTable,
  });
  res.json({ schedule: saved, pausedRecipients });
});

/**
 * Lift the email suppression that paused this address on the club-wide
 * combined levy ledger digest (Task #1763). Same shape as the per-levy
 * `/levies/:id/email-schedule/unsuppress` route — see that handler for
 * the rationale.
 */
router.post("/levy-ledger/email-schedule/unsuppress", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const rawEmail = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!rawEmail || !EMAIL_RE.test(rawEmail)) {
    res.status(400).json({ error: "valid email is required" }); return;
  }
  const lower = rawEmail.toLowerCase();

  const deleted = await db.delete(emailSuppressionsTable).where(and(
    eq(emailSuppressionsTable.organizationId, orgId),
    eq(emailSuppressionsTable.email, lower),
  )).returning({ id: emailSuppressionsTable.id });

  let restoredToSchedule = false;
  const [schedule] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
    .where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, orgId));
  if (schedule) {
    const recipients = Array.isArray(schedule.recipients) ? schedule.recipients as string[] : [];
    const alreadyOnList = recipients.some(r => r.trim().toLowerCase() === lower);
    if (!alreadyOnList && recipients.length < 20) {
      await db.update(levyLedgerEmailOrgSchedulesTable).set({
        recipients: [...recipients, rawEmail],
        updatedAt: new Date(),
      }).where(eq(levyLedgerEmailOrgSchedulesTable.id, schedule.id));
      restoredToSchedule = true;
    }
  }

  res.json({ ok: true, removed: deleted.length, restoredToSchedule });
});

router.delete("/levy-ledger/email-schedule", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  await db.delete(levyLedgerEmailOrgSchedulesTable)
    .where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, orgId));
  res.json({ ok: true });
});

router.post("/levy-ledger/email-schedule/send-now", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const [schedule] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
    .where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, orgId));
  if (!schedule) { { res.status(404).json({ error: "No club-wide ledger schedule configured" }); return; } }

  const result = await runOneOrgLevyLedgerEmailSchedule(schedule.id);
  res.json(result);
});

/**
 * Task #957 — preview the *next* org-wide combined levy ledger digest exactly
 * as it would be sent right now, without dispatching mail or recording a run.
 * Mirrors the per-currency revenue pivot preview (Task #823) so treasurers
 * sanity-check the rendered subject, body and CSV row / levy counts before
 * committing recipients to the cadence.
 */
router.get("/levy-ledger/email-schedule/preview", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const [schedule] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
    .where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, orgId));
  if (!schedule) { { res.status(404).json({ error: "No club-wide ledger schedule configured" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const deliveryFormat = (LEVY_LEDGER_ORG_DELIVERY_FORMATS.has(schedule.deliveryFormat ?? "")
    ? schedule.deliveryFormat
    : "combined") as LevyLedgerOrgDeliveryFormat;
  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000);

  // Reuse the same row-counting helpers as the real send path so the preview
  // counts are byte-identical to what would actually be attached. Skip the
  // combined CSV build when only the ZIP is sent — we only need the row
  // total in that case, which the per-levy build returns.
  const needsCombined = deliveryFormat === "combined" || deliveryFormat === "both";
  const combinedBuild = needsCombined
    ? await buildLevyLedgerCsv({ orgId, from: periodStart, to: now })
    : { csv: null as string | null, rowCount: 0 };
  let rowCount = combinedBuild.rowCount;

  const levyRows = await db
    .selectDistinct({
      levyId: memberLevyChargesTable.levyId,
      levyName: memberLeviesTable.name,
    })
    .from(memberLevyChargeEventsTable)
    .innerJoin(memberLevyChargesTable, eq(memberLevyChargeEventsTable.chargeId, memberLevyChargesTable.id))
    .innerJoin(memberLeviesTable, eq(memberLeviesTable.id, memberLevyChargesTable.levyId))
    .where(and(
      eq(memberLevyChargeEventsTable.organizationId, orgId),
      gte(memberLevyChargeEventsTable.occurredAt, periodStart),
      lte(memberLevyChargeEventsTable.occurredAt, now),
    ));
  const levyCount = levyRows.length;

  // Per-levy file listing (filenames + row counts) is needed for the ZIP and
  // "both" preview so treasurers can verify each levy file before sending.
  // We compute it once and reuse the row totals to backfill the header count
  // when the combined CSV isn't built.
  const needsZip = deliveryFormat === "per_levy_zip" || deliveryFormat === "both";
  let perLevyFiles: Array<{ filename: string; rowCount: number }> | null = null;
  if (needsZip) {
    const listed = await listPerLevyLedgerFiles({
      orgId,
      levies: levyRows,
      from: periodStart,
      to: now,
    });
    perLevyFiles = listed.files;
    if (!needsCombined) rowCount = listed.rowCount;
  }

  const { subject, html, combinedFilename, zipFilename } = buildOrgLevyLedgerScheduleEmailContent({
    orgName: org?.name ?? "KHARAGOLF",
    frequency: schedule.frequency as "weekly" | "monthly",
    periodStart,
    periodEnd: now,
    rowCount,
    levyCount,
    deliveryFormat,
  });

  // Inline a small CSV sample (header + first ~10 data rows) so treasurers
  // can spot malformed rows, missing currency or off-by-one period bugs from
  // the preview dialog without needing to download the full attachment.
  const csvSample = needsCombined && combinedBuild.csv
    ? sampleCsvHead(combinedBuild.csv, 10)
    : null;

  res.json({
    subject,
    html,
    combinedFilename,
    zipFilename,
    rowCount,
    levyCount,
    deliveryFormat,
    recipients: Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [],
    frequency: schedule.frequency,
    periodStart: periodStart.toISOString(),
    periodEnd: now.toISOString(),
    csvSample: csvSample
      ? { header: csvSample.header, rows: csvSample.rows, totalRows: rowCount, sampleSize: csvSample.rows.length }
      : null,
    perLevyFiles,
  });
});

/**
 * Execute one org-wide schedule end-to-end: build the combined period CSV
 * across every levy, email it to the configured recipients, record the run
 * in history, and advance the cadence. Shared by the cron poller and the
 * manual send-now endpoint.
 */
export async function runOneOrgLevyLedgerEmailSchedule(scheduleId: number): Promise<{
  status: "sent" | "failed" | "skipped";
  rowCount: number;
  levyCount: number;
  recipients: string[];
  deliveryFormat: LevyLedgerOrgDeliveryFormat;
  errorMessage?: string;
  pausedRecipients?: string[];
}> {
  const [schedule] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
    .where(eq(levyLedgerEmailOrgSchedulesTable.id, scheduleId));
  if (!schedule) {
    return { status: "skipped", rowCount: 0, levyCount: 0, recipients: [], deliveryFormat: "combined", errorMessage: "schedule not found" };
  }

  const configuredRecipients = Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [];
  const deliveryFormat = (LEVY_LEDGER_ORG_DELIVERY_FORMATS.has(schedule.deliveryFormat ?? "")
    ? schedule.deliveryFormat
    : "combined") as LevyLedgerOrgDeliveryFormat;
  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000);

  if (configuredRecipients.length === 0) {
    const errorMessage = "no recipients configured";
    await db.insert(levyLedgerEmailOrgRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients: [],
      rowCount: 0,
      levyCount: 0,
      status: "skipped",
      errorMessage,
    });
    // Task #1444 — advance the cadence on the no-recipients skipped path
    // so the bounce-aware auto-empty case below cannot re-fire on every
    // cron tick. Mirrors `runOneLevyLedgerEmailSchedule` and the wallet
    // refund pattern (Task #1233).
    await db.update(levyLedgerEmailOrgSchedulesTable).set({
      lastSentAt: now,
      nextRunAt: computeLevyLedgerNextRunAt(schedule.frequency, now),
      updatedAt: now,
    }).where(eq(levyLedgerEmailOrgSchedulesTable.id, schedule.id));
    const [orgForAlert] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, schedule.organizationId));
    await notifyAdminsOfOrgLevyLedgerDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      status: "skipped",
      errorMessage,
      pausedRecipients: [],
      org: orgForAlert ?? null,
    });
    return { status: "skipped", rowCount: 0, levyCount: 0, recipients: [], deliveryFormat, errorMessage };
  }

  // ── Bounce-aware recipient filter (Task #1444) ────────────────────────
  // Trim suppressed addresses out of both this run and the schedule's
  // stored recipient list — same pattern as the wallet refund digest
  // (Task #1233) and the per-levy digest above.
  const { recipients, pausedRecipients, pausedRecipientsSnapshot } = await pauseSuppressedRecipients({
    organizationId: schedule.organizationId,
    configuredRecipients,
    logScope: "org-levy-ledger-email",
  });
  if (pausedRecipients.length > 0) {
    try {
      await db.update(levyLedgerEmailOrgSchedulesTable).set({
        recipients,
        updatedAt: now,
      }).where(eq(levyLedgerEmailOrgSchedulesTable.id, schedule.id));
    } catch (err) {
      baseLogger.warn({ err, scheduleId: schedule.id }, "[org-levy-ledger-email] failed to persist paused recipients");
    }
  }

  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
  }).from(organizationsTable).where(eq(organizationsTable.id, schedule.organizationId));

  if (recipients.length === 0) {
    const errorMessage = `paused all configured recipients (${pausedRecipients.join(", ")}) — every address is on the bounce / unsubscribe suppression list`;
    await db.insert(levyLedgerEmailOrgRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients: [],
      rowCount: 0,
      levyCount: 0,
      status: "skipped",
      errorMessage,
      // Task #1763 — see per-levy cron above for the rationale.
      pausedRecipients: pausedRecipientsSnapshot,
    });
    await db.update(levyLedgerEmailOrgSchedulesTable).set({
      lastSentAt: now,
      nextRunAt: computeLevyLedgerNextRunAt(schedule.frequency, now),
      updatedAt: now,
    }).where(eq(levyLedgerEmailOrgSchedulesTable.id, schedule.id));
    await notifyAdminsOfOrgLevyLedgerDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      status: "skipped",
      errorMessage,
      pausedRecipients,
      org: org ?? null,
    });
    return { status: "skipped", rowCount: 0, levyCount: 0, recipients: [], deliveryFormat, errorMessage, pausedRecipients };
  }

  // Combined CSV across every levy in the org for the elapsed period.
  // When the format is `per_levy_zip` we skip the combined build (only the
  // ZIP is attached) but still need a row total for the email header / run
  // history — sourced cheaply from the per-levy CSVs below.
  const needsCombined = deliveryFormat === "combined" || deliveryFormat === "both";
  const combinedBuild = needsCombined
    ? await buildLevyLedgerCsv({ orgId: schedule.organizationId, from: periodStart, to: now })
    : { csv: null as string | null, rowCount: 0 };
  let { csv, rowCount } = combinedBuild;

  // Distinct levies (with names) that had any event in the period — needed for
  // the per-levy CSV pack (Task #322) and surfaced in the header/history.
  const levyRows = await db
    .selectDistinct({
      levyId: memberLevyChargesTable.levyId,
      levyName: memberLeviesTable.name,
    })
    .from(memberLevyChargeEventsTable)
    .innerJoin(memberLevyChargesTable, eq(memberLevyChargeEventsTable.chargeId, memberLevyChargesTable.id))
    .innerJoin(memberLeviesTable, eq(memberLeviesTable.id, memberLevyChargesTable.levyId))
    .where(and(
      eq(memberLevyChargeEventsTable.organizationId, schedule.organizationId),
      gte(memberLevyChargeEventsTable.occurredAt, periodStart),
      lte(memberLevyChargeEventsTable.occurredAt, now),
    ));
  const levyCount = levyRows.length;

  // Build the per-levy ZIP up front when needed. Each CSV is generated via
  // the same `buildLevyLedgerCsv` helper used elsewhere so format stays in
  // sync. Filenames are slug-safe and disambiguated by levy id.
  let perLevyZip: Buffer | null = null;
  if (deliveryFormat === "per_levy_zip" || deliveryFormat === "both") {
    const built = await buildPerLevyLedgerZip({
      orgId: schedule.organizationId,
      levies: levyRows,
      from: periodStart,
      to: now,
    });
    perLevyZip = built.zip;
    // Backfill rowCount when we skipped the combined build above so the
    // email header and history reflect actual events delivered.
    if (!needsCombined) rowCount = built.rowCount;
  }

  let status: "sent" | "failed" = "sent";
  let errorMessage: string | undefined;

  try {
    await sendOrgLevyLedgerScheduleEmail({
      to: recipients,
      orgName: org?.name ?? "KHARAGOLF",
      frequency: schedule.frequency as "weekly" | "monthly",
      periodStart,
      periodEnd: now,
      rowCount,
      levyCount,
      csv,
      zip: perLevyZip,
      deliveryFormat,
    });
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    baseLogger.warn({ err, scheduleId: schedule.id }, "[org-levy-ledger-email] send failed");
  }

  // Task #1444 — surface partial-pause information in the run row's
  // errorMessage even on `sent` so the dashboard history table makes the
  // pause visible to admins.
  let runErrorMessage: string | undefined = errorMessage;
  if (pausedRecipients.length > 0) {
    const pauseNote = `paused ${pausedRecipients.length} bounced/unsubscribed recipient(s): ${pausedRecipients.join(", ")}`;
    runErrorMessage = runErrorMessage ? `${runErrorMessage}; ${pauseNote}` : pauseNote;
  }

  await db.insert(levyLedgerEmailOrgRunsTable).values({
    scheduleId: schedule.id,
    organizationId: schedule.organizationId,
    periodStart,
    periodEnd: now,
    recipients,
    rowCount,
    levyCount,
    status,
    errorMessage: runErrorMessage,
    // Task #1763 — see per-levy cron above for the rationale.
    pausedRecipients: pausedRecipientsSnapshot,
  });

  await db.update(levyLedgerEmailOrgSchedulesTable).set({
    lastSentAt: now,
    nextRunAt: computeLevyLedgerNextRunAt(schedule.frequency, now),
    updatedAt: now,
  }).where(eq(levyLedgerEmailOrgSchedulesTable.id, schedule.id));

  if (status === "failed") {
    await notifyAdminsOfOrgLevyLedgerDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      status: "failed",
      errorMessage: errorMessage ?? "unknown error",
      pausedRecipients,
      org: org ?? null,
    });
  }

  return {
    status,
    rowCount,
    levyCount,
    recipients,
    deliveryFormat,
    errorMessage,
    pausedRecipients: pausedRecipients.length > 0 ? pausedRecipients : undefined,
  };
}

/**
 * Task #1444 — alert org admins / treasurers / membership_secretaries
 * that the club-wide combined levy ledger digest failed (or was paused
 * because every recipient bounced). Same shape as the per-levy variant
 * but dispatches under `levy.ledger.org.digest.failed` so the audit
 * trail tells reviewers which schedule is broken without correlating
 * schedule ids.
 */
async function notifyAdminsOfOrgLevyLedgerDigestFailure(opts: {
  orgId: number;
  scheduleId: number;
  status: "failed" | "skipped";
  errorMessage: string;
  pausedRecipients: string[];
  org: { name: string; logoUrl: string | null; primaryColor: string | null } | null;
}): Promise<void> {
  try {
    const directAdmins = await db
      .select({ userId: appUsersTable.id })
      .from(appUsersTable)
      .where(and(
        eq(appUsersTable.organizationId, opts.orgId),
        eq(appUsersTable.role, "org_admin"),
      ));
    const memberAdmins = await db
      .select({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, opts.orgId),
        inArray(orgMembershipsTable.role, ["org_admin", "treasurer", "membership_secretary"]),
      ));
    const userIds = Array.from(new Set(
      [...directAdmins, ...memberAdmins].map(r => r.userId).filter((n): n is number => typeof n === "number"),
    ));
    if (userIds.length === 0) {
      baseLogger.info({ orgId: opts.orgId, scheduleId: opts.scheduleId }, "[org-levy-ledger-email] no admin recipients for failure alert");
      return;
    }

    let consecutiveFailures = 1;
    try {
      const recentRuns = await db
        .select({ status: levyLedgerEmailOrgRunsTable.status })
        .from(levyLedgerEmailOrgRunsTable)
        .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, opts.scheduleId))
        .orderBy(desc(levyLedgerEmailOrgRunsTable.sentAt))
        .limit(20);
      consecutiveFailures = 0;
      for (const r of recentRuns) {
        if (r.status === "sent") break;
        consecutiveFailures += 1;
      }
      if (consecutiveFailures < 1) consecutiveFailures = 1;
    } catch (err) {
      baseLogger.warn({ err, scheduleId: opts.scheduleId }, "[org-levy-ledger-email] consecutive-failure count lookup failed");
    }

    const orgName = opts.org?.name ?? "your club";
    const title = opts.status === "skipped"
      ? `Club-wide levy ledger digest paused — every recipient is bouncing (${orgName})`
      : `Club-wide levy ledger digest failed to send (${orgName})`;
    const reasonLine = opts.status === "skipped"
      ? `Every configured recipient for the club-wide levy ledger digest is on the bounce / unsubscribe list, so this period's CSV was not sent. Paused recipients: ${opts.pausedRecipients.join(", ") || "(none)"}.`
      : `The mailer rejected the club-wide levy ledger digest send: ${opts.errorMessage}`;
    const pausedLine = opts.pausedRecipients.length > 0 && opts.status !== "skipped"
      ? ` We also paused ${opts.pausedRecipients.length} previously-bouncing recipient(s) from future runs: ${opts.pausedRecipients.join(", ")}.`
      : "";
    const consecutiveLine = consecutiveFailures > 1
      ? ` This is the ${consecutiveFailures}th consecutive run that did not deliver — please update the recipient list in Member 360 → Levies → Club-wide ledger email schedule.`
      : " Open Member 360 → Levies → Club-wide ledger email schedule to update the recipient list.";
    const body = `${reasonLine}${pausedLine}${consecutiveLine}`;
    const safeBody = escapeHtmlForLevyDigestAlert(body);
    const safeTitle = escapeHtmlForLevyDigestAlert(title);
    const emailHtml = `<div style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#fff;padding:24px;max-width:560px;margin:0 auto;border-radius:12px;">
        <h2 style="margin:0 0 12px;font-size:18px;color:#f87171;">${safeTitle}</h2>
        <p style="margin:0 0 16px;color:#d1d5db;line-height:1.5;">${safeBody}</p>
        <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Schedule id: ${opts.scheduleId} · Status: ${opts.status} · Consecutive failures: ${consecutiveFailures}</p>
      </div>`;

    const { dispatchNotification } = await import("../lib/notifyDispatch");
    await dispatchNotification("levy.ledger.org.digest.failed", userIds, {
      title,
      body,
      emailSubject: title,
      emailHtml,
      data: {
        scheduleId: opts.scheduleId,
        organizationId: opts.orgId,
        status: opts.status,
        errorMessage: opts.errorMessage,
        pausedRecipients: opts.pausedRecipients,
        consecutiveFailures,
      },
      branding: {
        orgName: opts.org?.name ?? "KHARAGOLF",
        logoUrl: opts.org?.logoUrl ?? undefined,
        primaryColor: opts.org?.primaryColor ?? undefined,
        orgId: opts.orgId,
      },
    });
  } catch (err) {
    baseLogger.warn({ err, scheduleId: opts.scheduleId }, "[org-levy-ledger-email] admin failure dispatch failed");
  }
}

/**
 * Build a ZIP buffer containing one CSV per levy for the elapsed period
 * (Task #322). Levies that produced no events in the window are skipped so
 * the archive stays compact. Uses the shared `buildLevyLedgerCsv` helper to
 * keep formatting identical to the combined CSV and the on-screen exports.
 */
async function buildPerLevyLedgerZip(opts: {
  orgId: number;
  levies: Array<{ levyId: number; levyName: string | null }>;
  from: Date;
  to: Date;
}): Promise<{ zip: Buffer; rowCount: number }> {
  const { orgId, levies, from, to } = opts;
  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", reject);
  });

  let rowCount = 0;
  if (levies.length === 0) {
    archive.append(
      "No levy activity recorded for this period.\n",
      { name: "README.txt" },
    );
  } else {
    for (const lev of levies) {
      const { csv, rowCount: n } = await buildLevyLedgerCsv({ orgId, levyId: lev.levyId, from, to });
      archive.append(csv, { name: `${safeLevyFilenamePart(lev.levyName)}-${lev.levyId}.csv` });
      rowCount += n;
    }
  }
  await archive.finalize();
  await finished;
  return { zip: Buffer.concat(chunks), rowCount };
}

// Collision-safe filename helper: strip non-portable chars, append id. Shared
// between the live ZIP build and the preview file-listing helper so previews
// match what gets attached.
function safeLevyFilenamePart(s: string | null | undefined): string {
  return String(s ?? "").trim().replace(/[^a-zA-Z0-9\-_.]+/g, "_").slice(0, 60) || "levy";
}

/**
 * Preview-only sibling of `buildPerLevyLedgerZip` that returns just the
 * filenames + row counts that would land in the ZIP, without paying the
 * archiver cost. Used by the schedule preview dialog to surface a per-levy
 * file listing so treasurers can spot empty / duplicate levies before send.
 */
async function listPerLevyLedgerFiles(opts: {
  orgId: number;
  levies: Array<{ levyId: number; levyName: string | null }>;
  from: Date;
  to: Date;
}): Promise<{ files: Array<{ filename: string; rowCount: number }>; rowCount: number }> {
  const { orgId, levies, from, to } = opts;
  if (levies.length === 0) {
    return { files: [{ filename: "README.txt", rowCount: 0 }], rowCount: 0 };
  }
  const files: Array<{ filename: string; rowCount: number }> = [];
  let rowCount = 0;
  for (const lev of levies) {
    const { rowCount: n } = await buildLevyLedgerCsv({ orgId, levyId: lev.levyId, from, to });
    files.push({ filename: `${safeLevyFilenamePart(lev.levyName)}-${lev.levyId}.csv`, rowCount: n });
    rowCount += n;
  }
  return { files, rowCount };
}

/**
 * Pull the header + first N data rows out of a CSV string, respecting
 * RFC-style double-quoted fields so an embedded newline inside a quoted
 * value (e.g. a multi-line note) doesn't split a single record across two
 * sample rows. Returns the rows verbatim (still CSV-encoded) so the client
 * can render them in a table or a <pre> block as preferred.
 */
function sampleCsvHead(csv: string, maxDataRows: number): { header: string; rows: string[] } {
  let cur = "";
  let inQuotes = false;
  const records: string[] = [];
  for (let i = 0; i < csv.length && records.length <= maxDataRows; i++) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') { cur += '""'; i++; }
        else { cur += '"'; inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') { cur += '"'; inQuotes = true; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && csv[i + 1] === '\n') i++;
        records.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  if (cur.length > 0 && records.length <= maxDataRows) records.push(cur);
  if (records.length === 0) return { header: "", rows: [] };
  return { header: records[0], rows: records.slice(1, maxDataRows + 1) };
}

// ─── Per-currency revenue & tax pivot scheduled email (Task #669) ───────────
//
// One schedule per organization that emails the per-currency revenue & tax
// pivot CSV (the same payload as `/revenue-by-currency.csv`) on a weekly or
// monthly cadence. Mirrors the org-wide levy ledger digest pattern above so
// treasurers manage both digests with the same mental model.

router.get("/revenue-by-currency/email-schedule", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const [schedule] = await db.select().from(revenueByCurrencyEmailSchedulesTable)
    .where(eq(revenueByCurrencyEmailSchedulesTable.organizationId, orgId));

  const history = schedule
    ? await db.select().from(revenueByCurrencyEmailRunsTable)
        .where(eq(revenueByCurrencyEmailRunsTable.scheduleId, schedule.id))
        .orderBy(desc(revenueByCurrencyEmailRunsTable.sentAt))
        .limit(50)
    : [];

  res.json({ schedule: schedule ?? null, history });
});

router.put("/revenue-by-currency/email-schedule", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const body = req.body as { frequency?: string; recipients?: unknown; enabled?: boolean };
  const frequency = String(body.frequency ?? "").toLowerCase();
  if (!LEVY_LEDGER_SCHEDULE_FREQUENCIES.has(frequency)) {
    res.status(400).json({ error: "frequency must be 'weekly' or 'monthly'" }); return;
  }
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : [];
  const recipients: string[] = [];
  for (const r of recipientsRaw) {
    const s = String(r ?? "").trim();
    if (!s) continue;
    if (!EMAIL_RE.test(s)) { { res.status(400).json({ error: `invalid recipient email: ${s}` }); return; } }
    if (!recipients.includes(s)) recipients.push(s);
  }
  if (recipients.length === 0) {
    res.status(400).json({ error: "at least one recipient email is required" }); return;
  }
  if (recipients.length > 20) {
    res.status(400).json({ error: "no more than 20 recipients per schedule" }); return;
  }
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);

  const now = new Date();
  const user = req.user as { id: number };

  const [existing] = await db.select().from(revenueByCurrencyEmailSchedulesTable)
    .where(eq(revenueByCurrencyEmailSchedulesTable.organizationId, orgId));

  let saved;
  if (existing) {
    const freqChanged = existing.frequency !== frequency;
    const reEnabled = !existing.enabled && enabled;
    const nextRunAt = (freqChanged || reEnabled || !existing.nextRunAt)
      ? computeLevyLedgerNextRunAt(frequency, now)
      : existing.nextRunAt;
    const [row] = await db.update(revenueByCurrencyEmailSchedulesTable).set({
      frequency, recipients, enabled, nextRunAt, updatedAt: now,
    }).where(eq(revenueByCurrencyEmailSchedulesTable.id, existing.id)).returning();
    saved = row;
  } else {
    const [row] = await db.insert(revenueByCurrencyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency,
      recipients,
      enabled,
      nextRunAt: computeLevyLedgerNextRunAt(frequency, now),
      createdByUserId: user?.id ?? null,
    }).returning();
    saved = row;
  }

  res.json({ schedule: saved });
});

router.delete("/revenue-by-currency/email-schedule", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  await db.delete(revenueByCurrencyEmailSchedulesTable)
    .where(eq(revenueByCurrencyEmailSchedulesTable.organizationId, orgId));
  res.json({ ok: true });
});

/**
 * Task #823 — preview the *next* per-currency revenue pivot email exactly as
 * it would be sent right now, without dispatching mail or recording a run.
 * Lets treasurers sanity-check the rendered subject, body and CSV row /
 * currency counts before committing recipients to the cadence.
 */
router.get("/revenue-by-currency/email-schedule/preview", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const [schedule] = await db.select().from(revenueByCurrencyEmailSchedulesTable)
    .where(eq(revenueByCurrencyEmailSchedulesTable.organizationId, orgId));
  if (!schedule) { { res.status(404).json({ error: "No revenue-by-currency schedule configured" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000);

  const { csv, rowCount, currencyCount } = await buildRevenueByCurrencyCsv({
    orgId, from: periodStart, to: now,
  });

  const { subject, html, filename } = buildRevenueByCurrencyScheduleEmailContent({
    orgName: org?.name ?? "KHARAGOLF",
    frequency: schedule.frequency as "weekly" | "monthly",
    periodStart,
    periodEnd: now,
    rowCount,
    currencyCount,
  });

  // Sample of the CSV that would be attached so treasurers can spot a
  // missing currency, malformed row or off-by-one period right in the
  // preview dialog without downloading the file (Task #1111).
  const sample = sampleCsvHead(csv, 10);

  res.json({
    subject,
    html,
    filename,
    rowCount,
    currencyCount,
    recipients: Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [],
    frequency: schedule.frequency,
    periodStart: periodStart.toISOString(),
    periodEnd: now.toISOString(),
    csvSample: { header: sample.header, rows: sample.rows, totalRows: rowCount, sampleSize: sample.rows.length },
  });
});

router.post("/revenue-by-currency/email-schedule/send-now", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const [schedule] = await db.select().from(revenueByCurrencyEmailSchedulesTable)
    .where(eq(revenueByCurrencyEmailSchedulesTable.organizationId, orgId));
  if (!schedule) { { res.status(404).json({ error: "No revenue-by-currency schedule configured" }); return; } }

  const result = await runOneRevenueByCurrencyEmailSchedule(schedule.id);
  res.json(result);
});

/**
 * Execute one revenue-by-currency schedule end-to-end: build the per-currency
 * pivot CSV for the elapsed period, email it to the configured recipients,
 * record the run in history, and advance the cadence. Shared by the cron
 * poller and the manual send-now endpoint.
 */
export async function runOneRevenueByCurrencyEmailSchedule(scheduleId: number): Promise<{
  status: "sent" | "failed" | "skipped";
  rowCount: number;
  currencyCount: number;
  recipients: string[];
  errorMessage?: string;
}> {
  const [schedule] = await db.select().from(revenueByCurrencyEmailSchedulesTable)
    .where(eq(revenueByCurrencyEmailSchedulesTable.id, scheduleId));
  if (!schedule) {
    return { status: "skipped", rowCount: 0, currencyCount: 0, recipients: [], errorMessage: "schedule not found" };
  }

  const recipients = Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [];
  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000);

  if (recipients.length === 0) {
    await db.insert(revenueByCurrencyEmailRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients,
      rowCount: 0,
      currencyCount: 0,
      status: "skipped",
      errorMessage: "no recipients configured",
    });
    return { status: "skipped", rowCount: 0, currencyCount: 0, recipients, errorMessage: "no recipients configured" };
  }

  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, schedule.organizationId));

  const { csv, rowCount, currencyCount } = await buildRevenueByCurrencyCsv({
    orgId: schedule.organizationId,
    from: periodStart,
    to: now,
  });

  let status: "sent" | "failed" = "sent";
  let errorMessage: string | undefined;

  try {
    await sendRevenueByCurrencyScheduleEmail({
      to: recipients,
      orgName: org?.name ?? "KHARAGOLF",
      frequency: schedule.frequency as "weekly" | "monthly",
      periodStart,
      periodEnd: now,
      rowCount,
      currencyCount,
      csv,
    });
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    baseLogger.warn({ err, scheduleId: schedule.id }, "[revenue-by-currency-email] send failed");
  }

  await db.insert(revenueByCurrencyEmailRunsTable).values({
    scheduleId: schedule.id,
    organizationId: schedule.organizationId,
    periodStart,
    periodEnd: now,
    recipients,
    rowCount,
    currencyCount,
    status,
    errorMessage,
  });

  // Advance cadence even on failure so we don't hammer a broken inbox every
  // poll cycle. Failures show up in history with the error message; the next
  // run will retry on the normal schedule.
  await db.update(revenueByCurrencyEmailSchedulesTable).set({
    lastSentAt: now,
    nextRunAt: computeLevyLedgerNextRunAt(schedule.frequency, now),
    updatedAt: now,
  }).where(eq(revenueByCurrencyEmailSchedulesTable.id, schedule.id));

  return { status, rowCount, currencyCount, recipients, errorMessage };
}

/** Cron entry-point for per-currency revenue pivot digests (Task #669). */
export async function runDueRevenueByCurrencyEmailSchedules(): Promise<void> {
  const now = new Date();
  const due = await db.select({ id: revenueByCurrencyEmailSchedulesTable.id })
    .from(revenueByCurrencyEmailSchedulesTable)
    .where(and(
      eq(revenueByCurrencyEmailSchedulesTable.enabled, true),
      lte(revenueByCurrencyEmailSchedulesTable.nextRunAt, now),
    ));
  for (const row of due) {
    try {
      await runOneRevenueByCurrencyEmailSchedule(row.id);
    } catch (err) {
      baseLogger.warn({ err, scheduleId: row.id }, "[revenue-by-currency-email] schedule poll error");
    }
  }
}

/** Cron entry-point for org-wide combined ledger digests (Task #278). */
export async function runDueOrgLevyLedgerEmailSchedules(): Promise<void> {
  const now = new Date();
  const due = await db.select({ id: levyLedgerEmailOrgSchedulesTable.id })
    .from(levyLedgerEmailOrgSchedulesTable)
    .where(and(
      eq(levyLedgerEmailOrgSchedulesTable.enabled, true),
      lte(levyLedgerEmailOrgSchedulesTable.nextRunAt, now),
    ));
  for (const row of due) {
    try {
      await runOneOrgLevyLedgerEmailSchedule(row.id);
    } catch (err) {
      baseLogger.warn({ err, scheduleId: row.id }, "[org-levy-ledger-email] schedule poll error");
    }
  }
}

/**
 * Cron entry-point — process every enabled schedule whose next_run_at has
 * elapsed. Called from `startCronJobs` in lib/cron.ts every hour.
 */
export async function runDueLevyLedgerEmailSchedules(): Promise<void> {
  const now = new Date();
  const due = await db.select({ id: levyLedgerEmailSchedulesTable.id })
    .from(levyLedgerEmailSchedulesTable)
    .where(and(
      eq(levyLedgerEmailSchedulesTable.enabled, true),
      lte(levyLedgerEmailSchedulesTable.nextRunAt, now),
    ));
  for (const row of due) {
    try {
      await runOneLevyLedgerEmailSchedule(row.id);
    } catch (err) {
      baseLogger.warn({ err, scheduleId: row.id }, "[levy-ledger-email] schedule poll error");
    }
  }
}

/**
 * Export the levy payment ledger as a paginated PDF for external auditors
 * (Task 231). Mirrors the filters and columns of the CSV endpoint above and
 * adds a club-branded header (org name, period, totals) plus per-page totals
 * in the footer. An empty result still produces a valid PDF with the header
 * and a "No events recorded" line so downstream auditors get a non-corrupt
 * file regardless of the filter combination.
 */
interface LevyLedgerPdfFilters {
  orgId: number;
  levyId?: number | null;
  memberId?: number | null;
  type?: string | null;
  from?: Date | null;
  to?: Date | null;
  notes?: string | null;
}
interface LevyLedgerPdfResult {
  pdf: Buffer;
  rowCount: number;
  totals: { payment: number; refund: number; waive: number };
  currency: string | null;
  levyName: string | null;
  filename: string;
  periodStart: Date | null;
  periodEnd: Date | null;
}

/**
 * Build the paginated, club-branded levy-ledger PDF used by the manual
 * download endpoint and the on-demand "email to auditor" endpoint (Task #270).
 * Returns the rendered buffer alongside the totals/metadata callers need to
 * compose an email body or audit-log entry.
 */
export async function buildLevyLedgerPdf(filters: LevyLedgerPdfFilters): Promise<LevyLedgerPdfResult> {
  const { orgId } = filters;
  const levyIdForFilename: string | null = filters.levyId != null ? String(filters.levyId) : null;

  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const fromDate = filters.from ?? null;
  const toDate = filters.to ?? null;
  const rawLevyId = filters.levyId != null ? String(filters.levyId) : null;
  const rawMemberId = filters.memberId != null ? String(filters.memberId) : null;
  const rawType = filters.type && filters.type !== "all" ? filters.type : null;

  const rows = await fetchLevyLedgerExportRows({
    orgId,
    levyId: filters.levyId ?? null,
    memberId: filters.memberId ?? null,
    type: filters.type ?? null,
    from: filters.from ?? null,
    to: filters.to ?? null,
  });

  // Aggregate totals across the full result set, broken out by event type so
  // auditors can see net cash impact at a glance in the header.
  const totals: Record<string, number> = { payment: 0, refund: 0, waive: 0 };
  for (const r of rows) {
    const amt = parseFloat(String(r.amount ?? "0")) || 0;
    if (r.eventType in totals) totals[r.eventType] += amt;
  }
  const currency = rows[0]?.currency ?? "";
  const fmtAmt = (n: number) => n.toFixed(2);
  const fmtDate = (d: Date | null) => d ? d.toISOString().slice(0, 10) : "";
  const periodLabel = fromDate || toDate
    ? `${fromDate ? fmtDate(fromDate) : "—"}  to  ${toDate ? fmtDate(toDate) : "—"}`
    : "All dates";

  const orgName = (org?.name ?? "KHARAGOLF").toUpperCase();
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  // Optional auditor notes typed in the export dialog (Task #271). Capped to a
  // reasonable length so we don't blow the signature panel off the page.
  const rawNotes = filters.notes;
  const notesText = typeof rawNotes === "string" ? rawNotes.slice(0, 1000).trim() : "";

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const leftX = 36;
    const rightX = pageWidth - 36;
    const usableWidth = rightX - leftX;

    // Column layout (12 columns, total = usableWidth)
    const cols: { key: string; label: string; w: number; align?: "left" | "right" }[] = [
      { key: "date", label: "Date", w: 78 },
      { key: "memberNumber", label: "Member #", w: 56 },
      { key: "member", label: "Member", w: 80 },
      { key: "email", label: "Email", w: 96 },
      { key: "levy", label: "Levy", w: 70 },
      { key: "currency", label: "Cur", w: 28 },
      { key: "type", label: "Type", w: 42 },
      { key: "amount", label: "Amount", w: 54, align: "right" },
      { key: "method", label: "Method", w: 46 },
      { key: "ref", label: "Ref", w: 60 },
      { key: "note", label: "Note / Reason", w: 78 },
      { key: "actor", label: "Actor", w: 64 },
      // Running outstanding balance after this event (Task #341). Mirrors
      // the per-charge events API so treasurers reconciling against bank
      // statements see the same number on the printable ledger.
      { key: "balance", label: "Balance", w: 58, align: "right" },
    ];
    // Scale to fit if margin geometry differs
    const totalW = cols.reduce((s, c) => s + c.w, 0);
    if (Math.abs(totalW - usableWidth) > 1) {
      const scale = usableWidth / totalW;
      for (const c of cols) c.w = c.w * scale;
    }

    function drawHeader() {
      // Top branding bar
      doc.rect(0, 0, pageWidth, 56).fill("#1e4d2b");
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(18)
        .text(orgName, leftX, 14, { lineBreak: false });
      doc.fillColor("#4ade80").font("Helvetica").fontSize(9)
        .text("LEVY LEDGER", leftX, 36, { lineBreak: false });
      doc.fillColor("#d1d5db").font("Helvetica").fontSize(9)
        .text(`Generated ${generatedAt}`, leftX, 14, { width: usableWidth, align: "right" });

      // Period + filters + totals
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(11)
        .text(`Period: ${periodLabel}`, leftX, 70);
      const filterBits: string[] = [];
      if (rawLevyId) filterBits.push(`Levy #${rawLevyId}`);
      if (rawMemberId) filterBits.push(`Member #${rawMemberId}`);
      if (rawType && rawType !== "all" && rawType !== "") filterBits.push(`Type: ${String(rawType)}`);
      doc.font("Helvetica").fontSize(9).fillColor("#6b7280")
        .text(filterBits.length ? `Filters: ${filterBits.join(" · ")}` : "Filters: none", leftX, 86);

      const totalsLabel = currency
        ? `Totals (${currency}) — Payments: ${fmtAmt(totals.payment)}   Refunds: ${fmtAmt(totals.refund)}   Waives: ${fmtAmt(totals.waive)}   Net cash: ${fmtAmt(totals.payment - totals.refund)}`
        : `Totals — Payments: ${fmtAmt(totals.payment)}   Refunds: ${fmtAmt(totals.refund)}   Waives: ${fmtAmt(totals.waive)}   Net cash: ${fmtAmt(totals.payment - totals.refund)}`;
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10)
        .text(totalsLabel, leftX, 100, { width: usableWidth });

      // Column header
      const headY = 124;
      doc.rect(leftX, headY, usableWidth, 18).fill("#f3f4f6");
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(8);
      let x = leftX;
      for (const c of cols) {
        doc.text(c.label, x + 4, headY + 5, { width: c.w - 8, align: c.align ?? "left", lineBreak: false });
        x += c.w;
      }
      return headY + 18;
    }

    function drawFooter(pageNum: number, pageTotals: { payment: number; refund: number; waive: number }) {
      // pdfkit 0.18 auto-paginates when explicit-position text would extend
      // below the page's bottom margin (36pt) — even with lineBreak: false.
      // Keep the footer baseline at >= 46pt above the page bottom so the
      // 8pt-font line fits entirely within the printable area and doesn't
      // spawn extra blank pages (broke the signature-panel test's page-count
      // assertion after the schema sync forced a pdfkit bump).
      const y = doc.page.height - 46;
      const cur = currency ? `${currency} ` : "";
      doc.fillColor("#6b7280").font("Helvetica").fontSize(8)
        .text(
          `Page totals — Payments: ${cur}${fmtAmt(pageTotals.payment)} · Refunds: ${cur}${fmtAmt(pageTotals.refund)} · Waives: ${cur}${fmtAmt(pageTotals.waive)}`,
          leftX, y, { width: usableWidth - 60, align: "left", lineBreak: false },
        );
      doc.text(`Page ${pageNum}`, leftX, y, { width: usableWidth, align: "right", lineBreak: false });
    }

    let pageNum = 1;
    let y = drawHeader();
    let pageTotals = { payment: 0, refund: 0, waive: 0 };
    const bottomLimit = doc.page.height - 40;

    function clip(s: string, max: number): string {
      if (!s) return "";
      // Rough char budget; PDFKit will clip via width too, but truncating
      // keeps row heights uniform.
      if (s.length <= max) return s;
      return s.slice(0, Math.max(0, max - 1)) + "…";
    }

    function drawSignaturePanel(startY: number) {
      // Auditor-ready signature + notes panel (Task #271). Pinned to the
      // bottom of whichever page is current when called.
      const panelTop = startY;
      const notesH = 80;
      const sigY = panelTop + notesH + 16;

      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10)
        .text("Notes", leftX, panelTop, { lineBreak: false });
      doc.rect(leftX, panelTop + 14, usableWidth, notesH).lineWidth(0.6).strokeColor("#9ca3af").stroke();
      if (notesText) {
        doc.fillColor("#111827").font("Helvetica").fontSize(9)
          .text(notesText, leftX + 6, panelTop + 20, {
            width: usableWidth - 12, height: notesH - 12, ellipsis: true,
          });
      }

      const colW = (usableWidth - 24) / 2;
      const lineY = sigY + 22;
      // Treasurer signature line
      doc.moveTo(leftX, lineY).lineTo(leftX + colW, lineY)
        .lineWidth(0.8).strokeColor("#111827").stroke();
      doc.fillColor("#374151").font("Helvetica").fontSize(8)
        .text("Signed by treasurer", leftX, lineY + 4, { width: colW, lineBreak: false });
      // Date line
      const dateX = leftX + colW + 24;
      doc.moveTo(dateX, lineY).lineTo(dateX + colW, lineY)
        .lineWidth(0.8).strokeColor("#111827").stroke();
      doc.fillColor("#374151").font("Helvetica").fontSize(8)
        .text("Date", dateX, lineY + 4, { width: colW, lineBreak: false });
    }

    /**
     * Place the signature panel. If the current page can't fit it, close
     * out the page (footer + new page) and draw the panel on a fresh
     * "signature-only" page. Returns true when the caller still needs to
     * draw a footer for the current page; false when the previous page's
     * footer was already drawn (so the signature page stays footer-free
     * — matches auditor expectation that a signature-only page only
     * carries the panel itself).
     */
    function ensureRoomForSignature(): boolean {
      // Signature panel needs ~ notes(94) + spacing + sig(36) ≈ 140pt above
      // the footer. If the current page can't fit it, start a new one.
      const PANEL_H = 140;
      if (y + PANEL_H > bottomLimit) {
        drawFooter(pageNum, pageTotals);
        doc.addPage();
        pageNum += 1;
        pageTotals = { payment: 0, refund: 0, waive: 0 };
        y = drawHeader();
        drawSignaturePanel(y + 12);
        return false;
      }
      drawSignaturePanel(y + 12);
      return true;
    }

    if (rows.length === 0) {
      doc.fillColor("#6b7280").font("Helvetica-Oblique").fontSize(10)
        .text("No events recorded for the selected filters.", leftX, y + 12, { width: usableWidth });
      y += 30;
      if (ensureRoomForSignature()) drawFooter(pageNum, pageTotals);
    } else {
      doc.font("Helvetica").fontSize(8).fillColor("#111827");
      for (const r of rows) {
        const rowH = 16;
        if (y + rowH > bottomLimit) {
          drawFooter(pageNum, pageTotals);
          doc.addPage();
          pageNum += 1;
          pageTotals = { payment: 0, refund: 0, waive: 0 };
          y = drawHeader();
          doc.font("Helvetica").fontSize(8).fillColor("#111827");
        }

        const memberName = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
        const actor = r.actorName ?? (r.actorUserId != null ? `user#${r.actorUserId}` : "");
        const dateStr = r.occurredAt ? new Date(r.occurredAt).toISOString().replace("T", " ").slice(0, 16) : "";
        const amt = parseFloat(String(r.amount ?? "0")) || 0;
        if (r.eventType in pageTotals) pageTotals[r.eventType as keyof typeof pageTotals] += amt;

        const values: Record<string, string> = {
          date: dateStr,
          memberNumber: r.memberNumber ?? "",
          member: clip(memberName, 22),
          email: clip(r.memberEmail ?? "", 28),
          levy: clip(r.levyName ?? "", 20),
          currency: r.currency ?? "",
          type: r.eventType,
          amount: amt.toFixed(2),
          method: clip(r.method ?? "", 12),
          ref: clip(r.processorReference ?? "", 16),
          note: clip(r.note ?? r.reason ?? "", 22),
          actor: clip(actor, 18),
          balance: r.runningBalance,
        };

        let x = leftX;
        for (const c of cols) {
          doc.text(values[c.key] ?? "", x + 4, y + 4, {
            width: c.w - 8, align: c.align ?? "left", lineBreak: false,
          });
          x += c.w;
        }
        // Row separator
        doc.moveTo(leftX, y + rowH).lineTo(leftX + usableWidth, y + rowH)
          .lineWidth(0.3).strokeColor("#e5e7eb").stroke();
        y += rowH;
      }
      if (ensureRoomForSignature()) drawFooter(pageNum, pageTotals);
    }

    doc.end();
  });

  const filename = `levy-ledger${levyIdForFilename ? `-${levyIdForFilename}` : ""}.pdf`;
  return {
    pdf: buffer,
    rowCount: rows.length,
    totals: { payment: totals.payment, refund: totals.refund, waive: totals.waive },
    currency: rows[0]?.currency ?? null,
    levyName: rows[0]?.levyName ?? null,
    filename,
    periodStart: fromDate,
    periodEnd: toDate,
  };
}

/** Parse the shared filter set from query params. Returns an error string when invalid. */
function parseLedgerFiltersFromQuery(req: Request): { filters: Omit<LevyLedgerPdfFilters, "orgId">; error?: string } {
  const out: Omit<LevyLedgerPdfFilters, "orgId"> = {};
  const rawLevyId = req.query.levyId;
  if (rawLevyId !== undefined && rawLevyId !== "") {
    const lid = parseInt(String(rawLevyId));
    if (!Number.isFinite(lid)) return { filters: out, error: "invalid levyId" };
    out.levyId = lid;
  }
  const rawMemberId = req.query.memberId;
  if (rawMemberId !== undefined && rawMemberId !== "") {
    const mid = parseInt(String(rawMemberId));
    if (!Number.isFinite(mid)) return { filters: out, error: "invalid memberId" };
    out.memberId = mid;
  }
  const rawType = req.query.type;
  if (rawType !== undefined && rawType !== "" && rawType !== "all") {
    const t = String(rawType).toLowerCase();
    if (!LEVY_LEDGER_EVENT_TYPES.has(t)) return { filters: out, error: "invalid type" };
    out.type = t;
  }
  const rawFrom = req.query.from;
  if (rawFrom !== undefined && rawFrom !== "") {
    const d = new Date(String(rawFrom));
    if (Number.isNaN(d.getTime())) return { filters: out, error: "invalid from date" };
    out.from = d;
  }
  const rawTo = req.query.to;
  if (rawTo !== undefined && rawTo !== "") {
    const d = new Date(String(rawTo));
    if (Number.isNaN(d.getTime())) return { filters: out, error: "invalid to date" };
    out.to = d;
  }
  const rawNotes = req.query.notes;
  if (typeof rawNotes === "string" && rawNotes !== "") {
    out.notes = rawNotes;
  }
  return { filters: out };
}

router.get("/levy-ledger.pdf", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const { filters, error } = parseLedgerFiltersFromQuery(req);
  if (error) { { res.status(400).json({ error }); return; } }
  const result = await buildLevyLedgerPdf({ orgId, ...filters });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
  res.send(result.pdf);
});

/**
 * Email the same paginated ledger PDF to one or more auditors on demand
 * (Task #270). Mirrors the filters of the manual download endpoint so the
 * file the recipient receives is byte-for-byte the one staff would have
 * downloaded themselves. Records a member_audit_log entry tagged
 * entity='levy_ledger', action='email_pdf' so admins can confirm the send
 * (and to whom) from the audit trail.
 */
router.post("/levy-ledger.pdf/email", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  // Filters can come from either the query string (so the UI can reuse the
  // same URL it would download) or the JSON body for ad-hoc API callers.
  const { filters, error } = parseLedgerFiltersFromQuery(req);
  if (error) { { res.status(400).json({ error }); return; } }

  const body = (req.body ?? {}) as { recipients?: unknown; message?: unknown };
  const rawRecipients = Array.isArray(body.recipients)
    ? body.recipients
    : typeof body.recipients === "string"
      ? body.recipients.split(/[\s,;]+/)
      : [];
  const recipients: string[] = [];
  for (const r of rawRecipients) {
    if (typeof r !== "string") continue;
    const trimmed = r.trim();
    if (!trimmed) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      res.status(400).json({ error: `invalid recipient email: ${trimmed}` });
      return;
    }
    if (!recipients.includes(trimmed)) recipients.push(trimmed);
  }
  if (recipients.length === 0) {
    res.status(400).json({ error: "at least one recipient email is required" });
    return;
  }
  if (recipients.length > 20) {
    res.status(400).json({ error: "at most 20 recipients per send" });
    return;
  }
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 2000) : null;

  const result = await buildLevyLedgerPdf({ orgId, ...filters });
  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const orgName = org?.name ?? "KHARAGOLF";

  let status: "sent" | "failed" = "sent";
  let errorMessage: string | null = null;
  try {
    await sendLevyLedgerPdfEmail({
      to: recipients,
      orgName,
      levyName: result.levyName,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      rowCount: result.rowCount,
      totals: result.totals,
      currency: result.currency,
      pdf: result.pdf,
      filename: result.filename,
      message,
    });
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    baseLogger.warn({ err, orgId, recipients }, "[levy-ledger-email-pdf] send failed");
  }

  await recordMemberAudit({
    req,
    organizationId: orgId,
    clubMemberId: filters.memberId ?? null,
    entity: "levy_ledger",
    entityId: filters.levyId ?? null,
    action: "email_pdf",
    reason: status === "sent" ? "ledger PDF emailed to auditor" : "ledger PDF email failed",
    metadata: {
      recipients,
      status,
      errorMessage,
      rowCount: result.rowCount,
      totals: result.totals,
      currency: result.currency,
      filename: result.filename,
      filters: {
        levyId: filters.levyId ?? null,
        memberId: filters.memberId ?? null,
        type: filters.type ?? null,
        from: filters.from?.toISOString() ?? null,
        to: filters.to?.toISOString() ?? null,
      },
      message,
    },
  });

  if (status === "failed") {
    res.status(502).json({ status, recipients, rowCount: result.rowCount, errorMessage });
    return;
  }
  res.json({
    status,
    recipients,
    rowCount: result.rowCount,
    totals: result.totals,
    currency: result.currency,
    filename: result.filename,
  });
});

/**
 * Recent on-demand auditor PDF sends for a single levy (Task #312).
 *
 * Reads the member_audit_log rows that the email-PDF endpoint above writes
 * (entity='levy_ledger', action='email_pdf', entityId=levyId) so the Export
 * ledger dialog can show staff who already received the ledger and when —
 * without making them dig through the raw audit trail. Failed sends keep the
 * captured error message in metadata so the UI can surface it inline.
 *
 * Newest-first; capped at 50 rows (this is a confirmation panel, not a full
 * audit explorer). Admin-only — matches the rest of the levy endpoints.
 */
router.get("/levies/:id/email-pdf-history", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const [levy] = await db.select({ id: memberLeviesTable.id })
    .from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }

  const ROW_LIMIT = 50;
  const rows = await db.select({
    id: memberAuditLogTable.id,
    actorName: memberAuditLogTable.actorName,
    actorRole: memberAuditLogTable.actorRole,
    reason: memberAuditLogTable.reason,
    metadata: memberAuditLogTable.metadata,
    createdAt: memberAuditLogTable.createdAt,
  }).from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.entity, "levy_ledger"),
      eq(memberAuditLogTable.action, "email_pdf"),
      eq(memberAuditLogTable.entityId, id),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt))
    .limit(ROW_LIMIT);

  const sends = rows.map(r => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const recipients = Array.isArray(m.recipients)
      ? (m.recipients as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const status = m.status === "failed" ? "failed" : "sent";
    return {
      id: r.id,
      createdAt: r.createdAt,
      actorName: r.actorName,
      actorRole: r.actorRole,
      recipients,
      status,
      errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : null,
      rowCount: typeof m.rowCount === "number" ? m.rowCount : null,
      totals: (m.totals && typeof m.totals === "object") ? m.totals : null,
      currency: typeof m.currency === "string" ? m.currency : null,
      filename: typeof m.filename === "string" ? m.filename : null,
      message: typeof m.message === "string" ? m.message : null,
    };
  });

  res.json({ sends, limit: ROW_LIMIT });
});

/**
 * Reminder history for a single levy (Task #214).
 *
 * Returns every member_messages row that was tagged with related_entity='levy'
 * and the given relatedEntityId, joined to the member so the dialog can show
 * who received each attempt. Supports two optional filters:
 *   ?status=failed        — restrict to failed attempts only
 *   ?channel=email|sms|…  — restrict to a single delivery channel
 * Newest-first; capped at 500 rows so a runaway reminder loop cannot OOM the
 * dialog. Admin-only — matches the rest of the levy endpoints in this file.
 */
router.get("/levies/:id/reminders", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }

  const statusFilter = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const channelFilter = typeof req.query.channel === "string" ? req.query.channel.trim() : "";

  const conditions = [
    eq(memberMessagesTable.organizationId, orgId),
    eq(memberMessagesTable.relatedEntity, "levy"),
    eq(memberMessagesTable.relatedEntityId, id),
  ];
  if (statusFilter) conditions.push(eq(memberMessagesTable.status, statusFilter));
  if (channelFilter) conditions.push(eq(memberMessagesTable.channel, channelFilter));

  const ROW_LIMIT = 500;
  const rows = await db
    .select({
      id: memberMessagesTable.id,
      clubMemberId: memberMessagesTable.clubMemberId,
      channel: memberMessagesTable.channel,
      status: memberMessagesTable.status,
      sentAt: memberMessagesTable.sentAt,
      errorMessage: memberMessagesTable.errorMessage,
      subject: memberMessagesTable.subject,
      memberNumber: clubMembersTable.memberNumber,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
    })
    .from(memberMessagesTable)
    .innerJoin(clubMembersTable, and(
      eq(memberMessagesTable.clubMemberId, clubMembersTable.id),
      // Defence-in-depth: ensure the joined member belongs to the same org so a
      // future bug in relatedEntityId tagging can't leak cross-org rows.
      eq(clubMembersTable.organizationId, orgId),
    ))
    .where(and(...conditions))
    .orderBy(desc(memberMessagesTable.sentAt))
    .limit(ROW_LIMIT);

  // Compute the unfiltered-by-limit total separately so the UI can correctly
  // report "showing latest N of M" when the row cap kicks in.
  const [{ c: totalMatching }] = await db
    .select({ c: count() })
    .from(memberMessagesTable)
    .innerJoin(clubMembersTable, and(
      eq(memberMessagesTable.clubMemberId, clubMembersTable.id),
      eq(clubMembersTable.organizationId, orgId),
    ))
    .where(and(...conditions));

  // Distinct channels actually used for this levy so the UI can render the
  // channel filter without hard-coding the list (some clubs use only email,
  // others fan-out to in_app+email+sms).
  const channelRows = await db
    .selectDistinct({ channel: memberMessagesTable.channel })
    .from(memberMessagesTable)
    .where(and(
      eq(memberMessagesTable.organizationId, orgId),
      eq(memberMessagesTable.relatedEntity, "levy"),
      eq(memberMessagesTable.relatedEntityId, id),
    ));

  res.json({
    levyId: id,
    total: totalMatching,
    returnedCount: rows.length,
    truncated: totalMatching > rows.length,
    channels: channelRows.map(r => r.channel).sort(),
    history: rows,
  });
});

/**
 * CSV export of the same reminder history (Task #239).
 *
 * Mirrors the `?status=` and `?channel=` filters of GET /levies/:id/reminders
 * so admins/auditors can download exactly what the dialog is currently showing.
 * Streamed row-by-row (no 500-row cap) so a long-running levy with thousands of
 * reminder attempts can still be exported in one file.
 */
router.get("/levies/:id/reminders.csv", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }

  const statusFilter = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const channelFilter = typeof req.query.channel === "string" ? req.query.channel.trim() : "";

  const conditions = [
    eq(memberMessagesTable.organizationId, orgId),
    eq(memberMessagesTable.relatedEntity, "levy"),
    eq(memberMessagesTable.relatedEntityId, id),
  ];
  if (statusFilter) conditions.push(eq(memberMessagesTable.status, statusFilter));
  if (channelFilter) conditions.push(eq(memberMessagesTable.channel, channelFilter));

  const rows = await db
    .select({
      channel: memberMessagesTable.channel,
      status: memberMessagesTable.status,
      sentAt: memberMessagesTable.sentAt,
      errorMessage: memberMessagesTable.errorMessage,
      memberNumber: clubMembersTable.memberNumber,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
    })
    .from(memberMessagesTable)
    .innerJoin(clubMembersTable, and(
      eq(memberMessagesTable.clubMemberId, clubMembersTable.id),
      eq(clubMembersTable.organizationId, orgId),
    ))
    .where(and(...conditions))
    .orderBy(desc(memberMessagesTable.sentAt));

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    // CSV formula-injection mitigation: prefix risky leading chars with '.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  const filename = `levy-${id}-reminders-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.write(["member", "member_number", "email", "channel", "status", "sent_at", "error"].join(",") + "\n");
  for (const r of rows) {
    const member = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
    const ts = r.sentAt instanceof Date
      ? r.sentAt.toISOString()
      : (r.sentAt ? new Date(r.sentAt as unknown as string).toISOString() : "");
    res.write([
      escape(member),
      escape(r.memberNumber),
      escape(r.email),
      escape(r.channel),
      escape(r.status),
      escape(ts),
      escape(r.errorMessage),
    ].join(",") + "\n");
  }
  res.end();
});

router.post("/levies/:id/remind", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }
  const { channel: rawChannel, subject, body } = req.body as { channel?: string; subject?: string; body?: string };
  const allowedChannels = ["in_app", "email", "sms", "whatsapp"] as const;
  type ReminderChannel = typeof allowedChannels[number];
  const channelInput = rawChannel ?? "in_app";
  if (!allowedChannels.includes(channelInput as ReminderChannel)) {
    res.status(400).json({ error: `Invalid channel '${channelInput}'. Allowed: ${allowedChannels.join(", ")}` });
    return;
  }
  const channel = channelInput as ReminderChannel;
  const unpaid = await db
    .select({
      memberId: memberLevyChargesTable.clubMemberId,
      amount: memberLevyChargesTable.amount,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
      phone: clubMembersTable.phone,
      userId: clubMembersTable.userId,
    })
    .from(memberLevyChargesTable)
    .innerJoin(clubMembersTable, eq(memberLevyChargesTable.clubMemberId, clubMembersTable.id))
    .where(and(
      eq(memberLevyChargesTable.levyId, id),
      inArray(memberLevyChargesTable.status, ["unpaid", "partial"]),
      eq(clubMembersTable.organizationId, orgId),
    ));
  if (unpaid.length === 0) { { res.json({ sentCount: 0, failedCount: 0, skippedCount: 0 }); return; } }
  // Bulk-load each member's `billing` comm prefs so we can honour per-channel
  // opt-outs the same way levy receipts do (Task #343). Members without a row
  // fall back to schema defaults (email/in_app/push on, sms/whatsapp off).
  const memberIdsForPrefs = Array.from(new Set(unpaid.map(u => u.memberId)));
  const prefRowsForRemind = memberIdsForPrefs.length
    ? await db.select({
        clubMemberId: memberCommPrefsTable.clubMemberId,
        emailEnabled: memberCommPrefsTable.emailEnabled,
        smsEnabled: memberCommPrefsTable.smsEnabled,
        whatsappEnabled: memberCommPrefsTable.whatsappEnabled,
        inAppEnabled: memberCommPrefsTable.inAppEnabled,
      })
      .from(memberCommPrefsTable)
      .where(and(
        inArray(memberCommPrefsTable.clubMemberId, memberIdsForPrefs),
        eq(memberCommPrefsTable.category, "billing"),
      ))
    : [];
  const prefsByMember = new Map<number, { email: boolean; sms: boolean; whatsapp: boolean; in_app: boolean }>();
  for (const r of prefRowsForRemind) {
    prefsByMember.set(r.clubMemberId, {
      email: Boolean(r.emailEnabled),
      sms: Boolean(r.smsEnabled),
      whatsapp: Boolean(r.whatsappEnabled),
      in_app: Boolean(r.inAppEnabled),
    });
  }
  const isChannelEnabledForMember = (memberId: number): boolean => {
    const p = prefsByMember.get(memberId);
    if (!p) {
      // Schema defaults
      if (channel === "email" || channel === "in_app") return true;
      return false; // sms / whatsapp default off
    }
    return p[channel];
  };
  const sym = ({ INR: "₹", USD: "$", GBP: "£", EUR: "€" } as Record<string, string>)[levy.currency] ?? levy.currency + " ";
  const dueLine = levy.dueDate ? ` (due ${new Date(levy.dueDate).toLocaleDateString()})` : "";
  const defaultSubject = subject?.trim() || `Reminder: ${levy.name} outstanding`;
  const senderUserId = (req.user as { id: number }).id;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let lastFailureReason: string | undefined;
  for (const u of unpaid) {
    const defaultBody = (body?.trim()) ||
      `This is a reminder that your levy "${levy.name}" of ${sym}${parseFloat(u.amount).toLocaleString()}${dueLine} is still outstanding. Please settle it at your earliest convenience.`;

    let status: "sent" | "failed" | "skipped" = "sent";
    let errorMessage: string | null = null;

    if (!isChannelEnabledForMember(u.memberId)) {
      status = "skipped";
      errorMessage = `Member has opted out of ${channel} for billing notices`;
    } else if (channel === "email" || channel === "sms" || channel === "whatsapp") {
      if (channel === "email" && !u.email) {
        status = "failed";
        errorMessage = "Member has no email address on file";
      } else if ((channel === "sms" || channel === "whatsapp") && !u.phone) {
        status = "failed";
        errorMessage = `Member has no phone number on file`;
      } else {
        let stats: DeliveryStats = {};
        try {
          stats = await sendBroadcast(
            [{
              email: u.email,
              phone: u.phone,
              firstName: u.firstName,
              lastName: u.lastName,
              userId: u.userId,
            }],
            {
              subject: defaultSubject,
              body: defaultBody,
              channels: [channel],
              eventName: levy.name,
              // Task #1566 — tag levy reminder emails with the
              // originating club so the Postmark bounce webhook
              // (Task #981) can attribute hard bounces back to this
              // org instantly.
              organizationId: orgId,
            },
          );
        } catch (err) {
          status = "failed";
          errorMessage = err instanceof Error ? err.message : "delivery_error";
        }
        const chStats = stats[channel];
        if (status === "sent") {
          if (!chStats || chStats.sent === 0) {
            status = "failed";
            errorMessage = chStats?.reason ?? `${channel} delivery failed`;
          }
        }
      }
    }

    const [msg] = await db.insert(memberMessagesTable).values({
      organizationId: orgId, clubMemberId: u.memberId,
      channel, subject: defaultSubject, body: defaultBody,
      senderUserId, status, errorMessage,
      relatedEntity: "levy", relatedEntityId: id,
    }).returning();
    await recordMemberAudit({
      req, organizationId: orgId, clubMemberId: u.memberId,
      entity: "message", entityId: msg.id, action: "create",
      reason: status === "sent"
        ? `Levy reminder sent (${channel}): ${levy.name}`
        : status === "skipped"
          ? `Levy reminder skipped (${channel}): ${levy.name} — ${errorMessage ?? "opted out"}`
          : `Levy reminder failed (${channel}): ${levy.name} — ${errorMessage ?? "unknown error"}`,
    });
    if (status === "sent") {
      sent++;
    } else if (status === "skipped") {
      skipped++;
    } else {
      failed++;
      if (errorMessage && !lastFailureReason) lastFailureReason = errorMessage;
    }
  }
  res.json({
    sentCount: sent,
    failedCount: failed,
    skippedCount: skipped,
    ...(lastFailureReason ? { lastFailureReason } : {}),
  });
});

/**
 * Retry only the levy reminders that previously bounced (Task 192).
 * Looks up failed `member_messages` rows tagged with this levy, re-attempts
 * delivery on the same channel for each, and inserts a fresh message row per
 * attempt. Original failed rows stay untouched so the audit trail is intact.
 */
router.post("/levies/:id/retry-failed", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const [levy] = await db.select().from(memberLeviesTable)
    .where(and(eq(memberLeviesTable.id, id), eq(memberLeviesTable.organizationId, orgId)));
  if (!levy) { { res.status(404).json({ error: "Levy not found" }); return; } }

  // Find the most recent failed reminder per (member, channel) so we don't
  // retry every historic failure when the admin has already retried once.
  const failedRows = await db
    .select({
      id: memberMessagesTable.id,
      clubMemberId: memberMessagesTable.clubMemberId,
      channel: memberMessagesTable.channel,
      subject: memberMessagesTable.subject,
      body: memberMessagesTable.body,
      sentAt: memberMessagesTable.sentAt,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
      phone: clubMembersTable.phone,
      userId: clubMembersTable.userId,
    })
    .from(memberMessagesTable)
    .innerJoin(clubMembersTable, eq(clubMembersTable.id, memberMessagesTable.clubMemberId))
    .where(and(
      eq(memberMessagesTable.organizationId, orgId),
      eq(memberMessagesTable.relatedEntity, "levy"),
      eq(memberMessagesTable.relatedEntityId, id),
      eq(memberMessagesTable.status, "failed"),
      eq(clubMembersTable.organizationId, orgId),
    ))
    .orderBy(desc(memberMessagesTable.sentAt));

  // Dedupe to the latest failure per (member, channel). Skip channels that
  // have a more recent successful send.
  const latestFailed = new Map<string, typeof failedRows[number]>();
  for (const r of failedRows) {
    const key = `${r.clubMemberId}::${r.channel}`;
    if (!latestFailed.has(key)) latestFailed.set(key, r);
  }
  if (latestFailed.size === 0) {
    res.json({ retriedCount: 0, sentCount: 0, failedCount: 0, skippedCount: 0 }); return;
  }

  // Drop entries where a later sent message exists on the same channel —
  // those are already resolved.
  const sentRows = await db
    .select({
      clubMemberId: memberMessagesTable.clubMemberId,
      channel: memberMessagesTable.channel,
      sentAt: memberMessagesTable.sentAt,
    })
    .from(memberMessagesTable)
    .where(and(
      eq(memberMessagesTable.organizationId, orgId),
      eq(memberMessagesTable.relatedEntity, "levy"),
      eq(memberMessagesTable.relatedEntityId, id),
      eq(memberMessagesTable.status, "sent"),
    ));
  for (const s of sentRows) {
    const key = `${s.clubMemberId}::${s.channel}`;
    const f = latestFailed.get(key);
    if (f && new Date(s.sentAt).getTime() > new Date(f.sentAt).getTime()) {
      latestFailed.delete(key);
    }
  }
  if (latestFailed.size === 0) {
    res.json({ retriedCount: 0, sentCount: 0, failedCount: 0, skippedCount: 0 }); return;
  }

  // Bulk-load `billing` comm prefs for the affected members so we can honour
  // per-channel opt-outs on retry — same as receipts and the initial reminder
  // (Task #343). Members without an explicit row keep schema defaults.
  const retryMemberIds = Array.from(new Set(Array.from(latestFailed.values()).map(f => f.clubMemberId)));
  const retryPrefRows = retryMemberIds.length
    ? await db.select({
        clubMemberId: memberCommPrefsTable.clubMemberId,
        emailEnabled: memberCommPrefsTable.emailEnabled,
        smsEnabled: memberCommPrefsTable.smsEnabled,
        whatsappEnabled: memberCommPrefsTable.whatsappEnabled,
        inAppEnabled: memberCommPrefsTable.inAppEnabled,
      })
      .from(memberCommPrefsTable)
      .where(and(
        inArray(memberCommPrefsTable.clubMemberId, retryMemberIds),
        eq(memberCommPrefsTable.category, "billing"),
      ))
    : [];
  const retryPrefsByMember = new Map<number, { email: boolean; sms: boolean; whatsapp: boolean; in_app: boolean }>();
  for (const r of retryPrefRows) {
    retryPrefsByMember.set(r.clubMemberId, {
      email: Boolean(r.emailEnabled),
      sms: Boolean(r.smsEnabled),
      whatsapp: Boolean(r.whatsappEnabled),
      in_app: Boolean(r.inAppEnabled),
    });
  }
  const isRetryChannelEnabled = (memberId: number, ch: string): boolean => {
    const p = retryPrefsByMember.get(memberId);
    if (!p) {
      if (ch === "email" || ch === "in_app") return true;
      return false;
    }
    if (ch === "email" || ch === "sms" || ch === "whatsapp" || ch === "in_app") {
      return p[ch as "email" | "sms" | "whatsapp" | "in_app"];
    }
    return true;
  };

  const senderUserId = (req.user as { id: number }).id;
  let sent = 0, failed = 0, skipped = 0;
  let lastFailureReason: string | undefined;

  for (const f of latestFailed.values()) {
    const channel = f.channel;
    const subject = f.subject ?? `Reminder: ${levy.name} outstanding`;
    const body = f.body;
    let status: "sent" | "failed" | "skipped" = "sent";
    let errorMessage: string | null = null;

    if (!isRetryChannelEnabled(f.clubMemberId, channel)) {
      status = "skipped";
      errorMessage = `Member has opted out of ${channel} for billing notices`;
    } else if (channel === "email" || channel === "sms" || channel === "whatsapp") {
      if (channel === "email" && !f.email) {
        status = "failed"; errorMessage = "Member has no email address on file";
      } else if ((channel === "sms" || channel === "whatsapp") && !f.phone) {
        status = "failed"; errorMessage = "Member has no phone number on file";
      } else {
        let stats: DeliveryStats = {};
        try {
          stats = await sendBroadcast(
            [{ email: f.email, phone: f.phone, firstName: f.firstName, lastName: f.lastName, userId: f.userId }],
            {
              subject, body, channels: [channel as "email" | "sms" | "whatsapp"], eventName: levy.name,
              // Task #1566 — tag levy retry-reminder emails with the
              // originating club so the Postmark bounce webhook
              // (Task #981) can attribute hard bounces back to this
              // org instantly.
              organizationId: orgId,
            },
          );
        } catch (err) {
          status = "failed";
          errorMessage = err instanceof Error ? err.message : "delivery_error";
        }
        const chStats = stats[channel as "email" | "sms" | "whatsapp"];
        if (status === "sent" && (!chStats || chStats.sent === 0)) {
          status = "failed";
          errorMessage = chStats?.reason ?? `${channel} delivery failed`;
        }
      }
    }

    const [msg] = await db.insert(memberMessagesTable).values({
      organizationId: orgId, clubMemberId: f.clubMemberId,
      channel, subject, body, senderUserId, status, errorMessage,
      relatedEntity: "levy", relatedEntityId: id,
    }).returning();
    await recordMemberAudit({
      req, organizationId: orgId, clubMemberId: f.clubMemberId,
      entity: "message", entityId: msg.id, action: "create",
      reason: status === "sent"
        ? `Levy reminder retry sent (${channel}): ${levy.name}`
        : status === "skipped"
          ? `Levy reminder retry skipped (${channel}): ${levy.name} — ${errorMessage ?? "opted out"}`
          : `Levy reminder retry failed (${channel}): ${levy.name} — ${errorMessage ?? "unknown error"}`,
    });
    if (status === "sent") sent++;
    else if (status === "skipped") skipped++;
    else { failed++; if (errorMessage && !lastFailureReason) lastFailureReason = errorMessage; }
  }

  res.json({
    retriedCount: latestFailed.size,
    sentCount: sent,
    failedCount: failed,
    skippedCount: skipped,
    ...(lastFailureReason ? { lastFailureReason } : {}),
  });
});

// ─── BULK ACTIONS ────────────────────────────────────────────────────────────

/**
 * Bulk-action audit history (Task #169).
 * Groups member_audit_log rows where reason starts with "bulk " into per-request
 * batches by (actor, reason, entity, minute-bucket) so admins can see at a
 * glance what bulk operations were applied and to how many members.
 *
 * Query params (all optional):
 *   from   ISO date — entries on/after
 *   to     ISO date — entries on/before
 *   action one of: freeze, suspend, reinstate, tag, message, tier_change
 *   limit  max groups to return (default 100, max 500)
 */
router.get("/bulk-audit", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const { from, to, action } = req.query as { from?: string; to?: string; action?: string };
  const isCsv = String(req.query.format ?? "").toLowerCase() === "csv";
  // CSV exports are for compliance/archival, so allow a much larger cap.
  const defaultLimit = isCsv ? 10000 : 100;
  const maxLimit = isCsv ? 50000 : 500;
  const limit = Math.min(parseInt(String(req.query.limit ?? defaultLimit)) || defaultLimit, maxLimit);

  const conds = [
    eq(memberAuditLogTable.organizationId, orgId),
    sql`${memberAuditLogTable.reason} LIKE 'bulk %'`,
  ];
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) conds.push(sql`${memberAuditLogTable.createdAt} >= ${d}`);
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) conds.push(sql`${memberAuditLogTable.createdAt} <= ${d}`);
  }
  if (action) {
    // Map action filter → entity / reason constraint
    if (["freeze", "suspend", "reinstate"].includes(action)) {
      conds.push(eq(memberAuditLogTable.entity, "lifecycle"));
      conds.push(sql`${memberAuditLogTable.reason} LIKE ${`bulk ${action}%`}`);
    } else if (action === "tag") {
      conds.push(eq(memberAuditLogTable.entity, "tag"));
    } else if (action === "message") {
      conds.push(eq(memberAuditLogTable.entity, "message"));
    } else if (action === "tier_change") {
      conds.push(eq(memberAuditLogTable.entity, "tier"));
    } else {
      res.status(400).json({ error: `Unknown action: ${action}` }); return;
    }
  }

  const bucket = sql<Date>`date_trunc('minute', ${memberAuditLogTable.createdAt})`;
  const rows = await db
    .select({
      bucket,
      actorUserId: memberAuditLogTable.actorUserId,
      actorName: memberAuditLogTable.actorName,
      actorRole: memberAuditLogTable.actorRole,
      reason: memberAuditLogTable.reason,
      entity: memberAuditLogTable.entity,
      memberCount: count(),
      firstAt: sql<Date>`min(${memberAuditLogTable.createdAt})`,
      lastAt: sql<Date>`max(${memberAuditLogTable.createdAt})`,
    })
    .from(memberAuditLogTable)
    .where(and(...conds))
    .groupBy(
      bucket,
      memberAuditLogTable.actorUserId,
      memberAuditLogTable.actorName,
      memberAuditLogTable.actorRole,
      memberAuditLogTable.reason,
      memberAuditLogTable.entity,
    )
    .orderBy(sql`max(${memberAuditLogTable.createdAt}) desc`)
    .limit(limit);

  const deriveAction = (entity: string, reason: string | null): string => {
    if (entity === "tag") return "tag";
    if (entity === "message") return "message";
    if (entity === "tier") return "tier_change";
    if (entity === "lifecycle" && reason) {
      const m = reason.match(/^bulk\s+(\w+)/);
      if (m) return m[1];
    }
    return entity;
  };

  // Parse the source bucket out of "bulk redo-of #<iso>" / "bulk redo-of #<iso> (filtered: …)"
  // reasons so the UI can nest clones under their originating bucket (Task #267).
  const parseSourceBucket = (reason: string | null): string | null => {
    if (!reason) return null;
    const m = reason.match(/^bulk\s+redo-of\s+#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
    return m ? m[1] : null;
  };

  const enriched = rows.map(r => ({
    ...r,
    memberCount: Number(r.memberCount),
    actionType: deriveAction(r.entity, r.reason),
    sourceBucket: parseSourceBucket(r.reason),
  }));

  if (String(req.query.format ?? "").toLowerCase() === "csv") {
    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      let s = String(v);
      // CSV formula-injection mitigation: prefix risky leading chars with '.
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["timestamp", "admin_name", "role", "action_type", "member_count", "reason"];
    const filename = `bulk-action-history-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write(header.join(",") + "\n");
    for (const r of enriched) {
      const ts = r.lastAt instanceof Date ? r.lastAt.toISOString() : new Date(r.lastAt as unknown as string).toISOString();
      res.write([
        escape(ts),
        escape(r.actorName),
        escape(r.actorRole),
        escape(r.actionType),
        escape(r.memberCount),
        escape(r.reason),
      ].join(",") + "\n");
    }
    res.end();
    return;
  }

  res.json(enriched);
});

/**
 * Bulk-action drill-down (Task #180).
 * Returns the underlying member_audit_log rows for one bulk-action group
 * identified by (bucket, actorUserId, entity, reason). Each row includes
 * member id + name so admins can click through to /member-360/:id.
 *
 * Query params (all required except actorUserId, which may be empty):
 *   bucket   ISO timestamp — start of the minute bucket
 *   entity   audit-log entity (lifecycle | tag | message | tier)
 *   reason   exact reason string used by the bulk action
 *   actorUserId  numeric id of the admin who performed the action (optional;
 *                omit for actions where actor was null)
 */
router.get("/bulk-audit/details", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;

  const { bucket, entity, reason, actorUserId } = req.query as {
    bucket?: string; entity?: string; reason?: string; actorUserId?: string;
  };
  if (!bucket || !entity || !reason) {
    res.status(400).json({ error: "bucket, entity, and reason are required" }); return;
  }
  const bucketStart = new Date(bucket);
  if (Number.isNaN(bucketStart.getTime())) {
    res.status(400).json({ error: "bucket must be a valid ISO timestamp" }); return;
  }
  const bucketEnd = new Date(bucketStart.getTime() + 60_000);

  const conds = [
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, entity),
    eq(memberAuditLogTable.reason, reason),
    sql`${memberAuditLogTable.createdAt} >= ${bucketStart}`,
    sql`${memberAuditLogTable.createdAt} < ${bucketEnd}`,
  ];
  if (actorUserId != null && actorUserId !== "") {
    const raw = String(actorUserId);
    if (!/^\d+$/.test(raw)) {
      res.status(400).json({ error: "actorUserId must be a non-negative integer" }); return;
    }
    conds.push(eq(memberAuditLogTable.actorUserId, parseInt(raw, 10)));
  } else {
    conds.push(sql`${memberAuditLogTable.actorUserId} IS NULL`);
  }

  // Cap result size to protect the response; surface truncation to the client
  // so the UI can warn admins that not every affected member is listed.
  const HARD_LIMIT = 1000;
  const rows = await db
    .select({
      auditId: memberAuditLogTable.id,
      clubMemberId: memberAuditLogTable.clubMemberId,
      action: memberAuditLogTable.action,
      entityId: memberAuditLogTable.entityId,
      fieldChanges: memberAuditLogTable.fieldChanges,
      createdAt: memberAuditLogTable.createdAt,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
    })
    .from(memberAuditLogTable)
    .leftJoin(clubMembersTable, eq(memberAuditLogTable.clubMemberId, clubMembersTable.id))
    .where(and(...conds))
    .orderBy(asc(clubMembersTable.lastName), asc(clubMembersTable.firstName))
    .limit(HARD_LIMIT + 1);

  const truncated = rows.length > HARD_LIMIT;
  res.json({ rows: truncated ? rows.slice(0, HARD_LIMIT) : rows, truncated, limit: HARD_LIMIT });
});

router.post("/bulk-action", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const { memberIds, action, payload } = req.body as {
    memberIds: number[]; action: string; payload?: Record<string, unknown>;
  };
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    res.status(400).json({ error: "memberIds required" }); return;
  }

  // Verify all members belong to org
  const valid = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.organizationId, orgId), inArray(clubMembersTable.id, memberIds)));
  const validIds = valid.map((m) => m.id);
  if (validIds.length === 0) { { res.status(400).json({ error: "No valid members" }); return; } }

  let processed = 0;
  if (action === "freeze" || action === "suspend" || action === "reinstate") {
    const evtType = action;
    const newStatus = action === "freeze" ? "frozen" : action === "suspend" ? "suspended" : "active";
    for (const mid of validIds) {
      await db.insert(memberLifecycleEventsTable).values({
        organizationId: orgId, clubMemberId: mid, eventType: evtType,
        reason: payload?.reason as string | undefined,
        performedByUserId: (req.user as { id: number }).id,
      });
      const ext = await ensureExt(mid, orgId);
      const prevStatus = ext.lifecycleStatus ?? null;
      await db.update(memberProfileExtTable).set({
        lifecycleStatus: newStatus, lifecycleReason: (payload?.reason as string | undefined) ?? null, updatedAt: new Date(),
      }).where(eq(memberProfileExtTable.id, ext.id));
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid, entity: "lifecycle", action: "create",
        changes: { lifecycleStatus: { from: prevStatus, to: newStatus } },
        reason: `bulk ${action}`,
      });
      processed++;
    }
  } else if (action === "tag") {
    const tag = payload?.tag as string | undefined;
    if (!tag) { { res.status(400).json({ error: "payload.tag required" }); return; } }
    for (const mid of validIds) {
      const ext = await ensureExt(mid, orgId);
      const tags = new Set<string>(ext.internalTags ?? []);
      tags.add(tag);
      await db.update(memberProfileExtTable).set({ internalTags: Array.from(tags), updatedAt: new Date() })
        .where(eq(memberProfileExtTable.id, ext.id));
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid, entity: "tag", action: "create",
        changes: { tag: { from: null, to: tag } },
        reason: `bulk tag: ${tag}`,
      });
      processed++;
    }
  } else if (action === "message") {
    const body = payload?.body as string | undefined;
    const channel = (payload?.channel as string | undefined) ?? "in_app";
    const subject = payload?.subject as string | undefined;
    if (!body) { { res.status(400).json({ error: "payload.body required" }); return; } }
    for (const mid of validIds) {
      const [msg] = await db.insert(memberMessagesTable).values({
        organizationId: orgId, clubMemberId: mid, channel, subject, body,
        senderUserId: (req.user as { id: number }).id,
      }).returning();
      await recordMemberAudit({ req, organizationId: orgId, clubMemberId: mid, entity: "message", entityId: msg.id, action: "create", reason: `bulk message (${channel})` });
      processed++;
    }
  } else if (action === "tier_change") {
    const newTierId = payload?.tierId ? Number(payload.tierId) : null;
    if (!newTierId) { { res.status(400).json({ error: "payload.tierId required" }); return; } }
    // Tenant integrity: tier must belong to this org
    const [newTier] = await db.select({ id: membershipTiersTable.id, name: membershipTiersTable.name })
      .from(membershipTiersTable)
      .where(and(eq(membershipTiersTable.id, newTierId), eq(membershipTiersTable.organizationId, orgId)));
    if (!newTier) { { res.status(400).json({ error: "Tier does not belong to this organization" }); return; } }
    for (const mid of validIds) {
      const before = await loadMember(orgId, mid);
      const prevTierId = before?.tierId ?? null;
      let prevTierName: string | null = null;
      if (prevTierId != null) {
        const [pt] = await db.select({ name: membershipTiersTable.name }).from(membershipTiersTable)
          .where(and(eq(membershipTiersTable.id, prevTierId), eq(membershipTiersTable.organizationId, orgId)));
        prevTierName = pt?.name ?? null;
      }
      await db.update(clubMembersTable).set({ tierId: newTierId, updatedAt: new Date() })
        .where(eq(clubMembersTable.id, mid));
      await db.insert(memberLifecycleEventsTable).values({
        organizationId: orgId, clubMemberId: mid, eventType: "tier_change",
        fromValue: prevTierId != null ? String(prevTierId) : null, toValue: String(newTierId),
        performedByUserId: (req.user as { id: number }).id,
      });
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid, entity: "tier", action: "update",
        changes: { tier: { from: prevTierName, to: newTier.name } },
        reason: `bulk tier_change → ${newTierId}`,
      });
      processed++;
    }
  } else {
    res.status(400).json({ error: `Unknown action: ${action}` }); return;
  }
  res.json({ processed, skipped: memberIds.length - processed });
});

/**
 * Reverse / undo a bulk action (Task #194).
 * Identifies the bulk-action group by (bucket, entity, reason, actorUserId)
 * — the same coordinates the drill-down uses — and applies the inverse:
 *   freeze       → unfreeze
 *   suspend      → reinstate
 *   tag (add)    → remove that same tag
 *   tier_change  → restore each member's prior tier from the lifecycle event
 * `reinstate` and `message` are not reversible (no inverse semantics) and
 * return 400 so the UI can hide / disable the action up-front.
 *
 * Stricter RBAC than other bulk endpoints: only org_admin / super_admin can
 * reverse a bulk action. Each affected member receives a fresh audit row with
 * reason `bulk reverse-of #<bucket-iso>` so the reversal itself shows up as
 * its own bucket in the bulk-audit history.
 */
router.post("/bulk-action/reverse", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required." }); return; } }
  const user = req.user as { id: number; role?: string; organizationId?: number | null };
  let allowed = user.role === "super_admin"
    || (user.role === "org_admin" && user.organizationId === orgId);
  if (!allowed) {
    const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
    if (m && m.role === "org_admin") allowed = true;
  }
  if (!allowed) { { res.status(403).json({ error: "Only org_admin or super_admin can reverse bulk actions." }); return; } }

  const { bucket, entity, reason, actorUserId } = req.body as {
    bucket?: string; entity?: string; reason?: string | null; actorUserId?: number | string | null;
  };
  if (!bucket || !entity) {
    res.status(400).json({ error: "bucket and entity are required" }); return;
  }
  const bucketStart = new Date(bucket);
  if (Number.isNaN(bucketStart.getTime())) {
    res.status(400).json({ error: "bucket must be a valid ISO timestamp" }); return;
  }
  const bucketEnd = new Date(bucketStart.getTime() + 60_000);

  // Don't allow reversing a reverse — that's a redo, which has its own semantics.
  if (reason && /^bulk reverse-of\b/.test(reason)) {
    res.status(400).json({ error: "This entry is itself a reversal — use the original bulk action to redo." }); return;
  }

  // Normalise actorUserId — accept number, numeric string, null, or undefined.
  let actorUserIdNum: number | null = null;
  if (actorUserId != null && actorUserId !== "") {
    const raw = String(actorUserId);
    if (!/^\d+$/.test(raw)) { { res.status(400).json({ error: "actorUserId must be a non-negative integer" }); return; } }
    actorUserIdNum = parseInt(raw, 10);
  }

  // Derive the original action so we know the inverse.
  const deriveAction = (): string | null => {
    if (entity === "tag") return "tag";
    if (entity === "message") return "message";
    if (entity === "tier") return "tier_change";
    if (entity === "lifecycle" && reason) {
      const m = reason.match(/^bulk\s+(\w+)/);
      if (m) return m[1];
    }
    return null;
  };
  const originalAction = deriveAction();
  if (!originalAction) { { res.status(400).json({ error: "Cannot infer original action from entity/reason" }); return; } }

  if (originalAction === "message") {
    res.status(400).json({ error: "Bulk messages cannot be reversed — they have already been delivered." }); return;
  }
  if (originalAction === "reinstate") {
    res.status(400).json({ error: "Bulk reinstate cannot be auto-reversed; freeze or suspend the members manually if needed." }); return;
  }

  // Find original audit rows in this bucket so we know which members were affected.
  const conds = [
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, entity),
    sql`${memberAuditLogTable.createdAt} >= ${bucketStart}`,
    sql`${memberAuditLogTable.createdAt} < ${bucketEnd}`,
  ];
  if (reason != null) conds.push(eq(memberAuditLogTable.reason, reason));
  if (actorUserIdNum != null) {
    conds.push(eq(memberAuditLogTable.actorUserId, actorUserIdNum));
  } else {
    conds.push(sql`${memberAuditLogTable.actorUserId} IS NULL`);
  }
  const auditRows = await db.select({
    clubMemberId: memberAuditLogTable.clubMemberId,
    entityId: memberAuditLogTable.entityId,
  }).from(memberAuditLogTable).where(and(...conds));

  const memberIds = Array.from(new Set(
    auditRows.map(r => r.clubMemberId).filter((x): x is number => x != null),
  ));
  if (memberIds.length === 0) {
    res.status(404).json({ error: "No affected members found for this bulk action." }); return;
  }

  // Tenant safety: re-confirm members still belong to this org.
  const valid = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.organizationId, orgId), inArray(clubMembersTable.id, memberIds)));
  const validIds = valid.map(m => m.id);
  if (validIds.length === 0) { { res.status(404).json({ error: "Affected members no longer exist in this org." }); return; } }

  const reverseReason = `bulk reverse-of #${bucketStart.toISOString()}`;
  let reversed = 0;
  let skipped = 0;
  let reverseAction: string;

  if (originalAction === "freeze" || originalAction === "suspend") {
    reverseAction = originalAction === "freeze" ? "unfreeze" : "reinstate";
    // Skip members who are no longer in the bulk-applied lifecycle status —
    // their state has already moved on (e.g. someone unfroze them manually
    // or an admin reinstated them), so a reversal would be a misleading
    // no-op audit row. This keeps the preview's `alreadyReversed` count
    // honest with what actually happens here.
    const bulkAppliedStatus = originalAction === "freeze" ? "frozen" : "suspended";
    const exts = await db.select({
      clubMemberId: memberProfileExtTable.clubMemberId,
      lifecycleStatus: memberProfileExtTable.lifecycleStatus,
    }).from(memberProfileExtTable).where(inArray(memberProfileExtTable.clubMemberId, validIds));
    const statusByMember = new Map<number, string | null>();
    for (const e of exts) if (e.clubMemberId != null) statusByMember.set(e.clubMemberId, e.lifecycleStatus ?? null);
    for (const mid of validIds) {
      const cur = statusByMember.get(mid) ?? null;
      if (cur !== bulkAppliedStatus) { skipped++; continue; }
      await db.insert(memberLifecycleEventsTable).values({
        organizationId: orgId, clubMemberId: mid, eventType: reverseAction,
        reason: reverseReason,
        performedByUserId: user.id,
      });
      const ext = await ensureExt(mid, orgId);
      await db.update(memberProfileExtTable).set({
        lifecycleStatus: "active", lifecycleReason: reverseReason, updatedAt: new Date(),
      }).where(eq(memberProfileExtTable.id, ext.id));
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid,
        entity: "lifecycle", action: "create", reason: reverseReason,
      });
      reversed++;
    }
  } else if (originalAction === "tag") {
    reverseAction = "tag_remove";
    // Reason format from the original bulk-tag: "bulk tag: <name>"
    const tagMatch = reason ? reason.match(/^bulk\s+tag:\s*(.+)$/) : null;
    const tag = tagMatch ? tagMatch[1].trim() : "";
    if (!tag) { { res.status(400).json({ error: "Cannot determine tag name from original reason." }); return; } }
    for (const mid of validIds) {
      const ext = await ensureExt(mid, orgId);
      const before: string[] = ext.internalTags ?? [];
      if (!before.includes(tag)) { skipped++; continue; }
      const after = before.filter((t: string) => t !== tag);
      await db.update(memberProfileExtTable).set({ internalTags: after, updatedAt: new Date() })
        .where(eq(memberProfileExtTable.id, ext.id));
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid,
        entity: "tag", action: "delete", reason: reverseReason,
      });
      reversed++;
    }
  } else if (originalAction === "tier_change") {
    reverseAction = "tier_change";
    // Look up the original lifecycle events in the same bucket window to get fromValue.
    const lcRows = await db.select({
      clubMemberId: memberLifecycleEventsTable.clubMemberId,
      fromValue: memberLifecycleEventsTable.fromValue,
      toValue: memberLifecycleEventsTable.toValue,
    }).from(memberLifecycleEventsTable).where(and(
      eq(memberLifecycleEventsTable.organizationId, orgId),
      eq(memberLifecycleEventsTable.eventType, "tier_change"),
      inArray(memberLifecycleEventsTable.clubMemberId, validIds),
      sql`${memberLifecycleEventsTable.createdAt} >= ${bucketStart}`,
      sql`${memberLifecycleEventsTable.createdAt} < ${bucketEnd}`,
    ));
    const priorByMember = new Map<number, { fromValue: string | null; toValue: string | null }>();
    for (const r of lcRows) {
      if (r.clubMemberId != null) priorByMember.set(r.clubMemberId, { fromValue: r.fromValue, toValue: r.toValue });
    }
    for (const mid of validIds) {
      const prior = priorByMember.get(mid);
      if (!prior || prior.fromValue == null) { skipped++; continue; }
      const restoreTierId = parseInt(prior.fromValue, 10);
      if (!Number.isFinite(restoreTierId)) { skipped++; continue; }
      // Tier must still belong to this org.
      const [tierOk] = await db.select({ id: membershipTiersTable.id }).from(membershipTiersTable)
        .where(and(eq(membershipTiersTable.id, restoreTierId), eq(membershipTiersTable.organizationId, orgId)));
      if (!tierOk) { skipped++; continue; }
      const before = await loadMember(orgId, mid);
      // Skip when the member is already on the restore tier — preview counts
      // these as `alreadyReversed`, so executing here would create a misleading
      // no-op tier_change audit row.
      if (before?.tierId === restoreTierId) { skipped++; continue; }
      await db.update(clubMembersTable).set({ tierId: restoreTierId, updatedAt: new Date() })
        .where(eq(clubMembersTable.id, mid));
      await db.insert(memberLifecycleEventsTable).values({
        organizationId: orgId, clubMemberId: mid, eventType: "tier_change",
        fromValue: before?.tierId != null ? String(before.tierId) : null,
        toValue: String(restoreTierId),
        reason: reverseReason,
        performedByUserId: user.id,
      });
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid,
        entity: "tier", action: "update", reason: reverseReason,
      });
      reversed++;
    }
  } else {
    res.status(400).json({ error: `Unsupported reverse for action: ${originalAction}` }); return;
  }

  res.json({
    reversed,
    skipped,
    originalAction,
    reverseAction,
    reverseReason,
    affectedMembers: validIds.length,
  });
});

/**
 * Pre-flight count for the reverse dialog (Task #259).
 *
 * Mirrors the eligibility logic of POST /bulk-action/reverse without writing
 * anything: identifies the original cohort by (bucket, entity, reason,
 * actorUserId) and returns how many members would actually change vs are
 * already back in the original (pre-bulk-action) state and would be no-ops.
 *
 * Response shape:
 *   {
 *     willChange: number,        // members whose state would actually flip
 *     alreadyReversed: number,   // members already back in the original state
 *     affectedMembers: number,   // valid cohort size still in this org
 *     originalAction: string,
 *   }
 */
router.post("/bulk-action/reverse/preview", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required." }); return; } }
  const user = req.user as { id: number; role?: string; organizationId?: number | null };
  let allowed = user.role === "super_admin"
    || (user.role === "org_admin" && user.organizationId === orgId);
  if (!allowed) {
    const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
    if (m && m.role === "org_admin") allowed = true;
  }
  if (!allowed) { { res.status(403).json({ error: "Only org_admin or super_admin can preview reversing bulk actions." }); return; } }

  const { bucket, entity, reason, actorUserId } = req.body as {
    bucket?: string; entity?: string; reason?: string | null; actorUserId?: number | string | null;
  };
  if (!bucket || !entity) { { res.status(400).json({ error: "bucket and entity are required" }); return; } }
  const bucketStart = new Date(bucket);
  if (Number.isNaN(bucketStart.getTime())) {
    res.status(400).json({ error: "bucket must be a valid ISO timestamp" }); return;
  }
  const bucketEnd = new Date(bucketStart.getTime() + 60_000);

  if (reason && /^bulk reverse-of\b/.test(reason)) {
    res.status(400).json({ error: "This entry is itself a reversal — use the original bulk action to redo." }); return;
  }

  let actorUserIdNum: number | null = null;
  if (actorUserId != null && actorUserId !== "") {
    const raw = String(actorUserId);
    if (!/^\d+$/.test(raw)) { { res.status(400).json({ error: "actorUserId must be a non-negative integer" }); return; } }
    actorUserIdNum = parseInt(raw, 10);
  }

  const deriveAction = (): string | null => {
    if (entity === "tag") return "tag";
    if (entity === "message") return "message";
    if (entity === "tier") return "tier_change";
    if (entity === "lifecycle" && reason) {
      const m = reason.match(/^bulk\s+(\w+)/);
      if (m) return m[1];
    }
    return null;
  };
  const originalAction = deriveAction();
  if (!originalAction) { { res.status(400).json({ error: "Cannot infer original action from entity/reason" }); return; } }
  if (originalAction === "message") {
    res.status(400).json({ error: "Bulk messages cannot be reversed — they have already been delivered." }); return;
  }
  if (originalAction === "reinstate") {
    res.status(400).json({ error: "Bulk reinstate cannot be auto-reversed; freeze or suspend the members manually if needed." }); return;
  }

  const conds = [
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, entity),
    sql`${memberAuditLogTable.createdAt} >= ${bucketStart}`,
    sql`${memberAuditLogTable.createdAt} < ${bucketEnd}`,
  ];
  if (reason != null) conds.push(eq(memberAuditLogTable.reason, reason));
  if (actorUserIdNum != null) {
    conds.push(eq(memberAuditLogTable.actorUserId, actorUserIdNum));
  } else {
    conds.push(sql`${memberAuditLogTable.actorUserId} IS NULL`);
  }
  const auditRows = await db.select({
    clubMemberId: memberAuditLogTable.clubMemberId,
  }).from(memberAuditLogTable).where(and(...conds));
  const memberIds = Array.from(new Set(
    auditRows.map(r => r.clubMemberId).filter((x): x is number => x != null),
  ));
  if (memberIds.length === 0) {
    res.json({ willChange: 0, alreadyReversed: 0, affectedMembers: 0, originalAction });
    return;
  }
  const valid = await db.select({ id: clubMembersTable.id, tierId: clubMembersTable.tierId }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.organizationId, orgId), inArray(clubMembersTable.id, memberIds)));
  const validIds = valid.map(m => m.id);
  if (validIds.length === 0) {
    res.json({ willChange: 0, alreadyReversed: 0, affectedMembers: 0, originalAction });
    return;
  }

  let willChange = 0;
  let alreadyReversed = 0;

  if (originalAction === "freeze" || originalAction === "suspend") {
    // Reverse flips lifecycleStatus back to "active". Members already active
    // would be no-ops from the user's perspective.
    const bulkAppliedStatus = originalAction === "freeze" ? "frozen" : "suspended";
    const exts = await db.select({
      clubMemberId: memberProfileExtTable.clubMemberId,
      lifecycleStatus: memberProfileExtTable.lifecycleStatus,
    }).from(memberProfileExtTable).where(inArray(memberProfileExtTable.clubMemberId, validIds));
    const statusByMember = new Map<number, string | null>();
    for (const e of exts) if (e.clubMemberId != null) statusByMember.set(e.clubMemberId, e.lifecycleStatus ?? null);
    for (const mid of validIds) {
      const cur = statusByMember.get(mid) ?? null;
      if (cur === bulkAppliedStatus) willChange++;
      else alreadyReversed++;
    }
  } else if (originalAction === "tag") {
    const tagMatch = reason ? reason.match(/^bulk\s+tag:\s*(.+)$/) : null;
    const tag = tagMatch ? tagMatch[1].trim() : "";
    if (!tag) { { res.status(400).json({ error: "Cannot determine tag name from original reason." }); return; } }
    const exts = await db.select({
      clubMemberId: memberProfileExtTable.clubMemberId,
      internalTags: memberProfileExtTable.internalTags,
    }).from(memberProfileExtTable).where(inArray(memberProfileExtTable.clubMemberId, validIds));
    const tagsByMember = new Map<number, string[]>();
    for (const e of exts) if (e.clubMemberId != null) tagsByMember.set(e.clubMemberId, e.internalTags ?? []);
    for (const mid of validIds) {
      const tags = tagsByMember.get(mid) ?? [];
      if (tags.includes(tag)) willChange++; else alreadyReversed++;
    }
  } else if (originalAction === "tier_change") {
    const lcRows = await db.select({
      clubMemberId: memberLifecycleEventsTable.clubMemberId,
      fromValue: memberLifecycleEventsTable.fromValue,
    }).from(memberLifecycleEventsTable).where(and(
      eq(memberLifecycleEventsTable.organizationId, orgId),
      eq(memberLifecycleEventsTable.eventType, "tier_change"),
      inArray(memberLifecycleEventsTable.clubMemberId, validIds),
      sql`${memberLifecycleEventsTable.createdAt} >= ${bucketStart}`,
      sql`${memberLifecycleEventsTable.createdAt} < ${bucketEnd}`,
    ));
    const priorByMember = new Map<number, string | null>();
    for (const r of lcRows) {
      if (r.clubMemberId != null) priorByMember.set(r.clubMemberId, r.fromValue);
    }
    const restoreTierIds = Array.from(new Set(
      Array.from(priorByMember.values())
        .map(v => v ? parseInt(v, 10) : NaN)
        .filter((n): n is number => Number.isFinite(n)),
    ));
    const validTierIds = new Set<number>();
    if (restoreTierIds.length > 0) {
      const trows = await db.select({ id: membershipTiersTable.id }).from(membershipTiersTable)
        .where(and(eq(membershipTiersTable.organizationId, orgId), inArray(membershipTiersTable.id, restoreTierIds)));
      for (const t of trows) validTierIds.add(t.id);
    }
    const tierByMember = new Map<number, number | null>();
    for (const m of valid) tierByMember.set(m.id, m.tierId ?? null);
    for (const mid of validIds) {
      const prior = priorByMember.get(mid);
      if (!prior) { alreadyReversed++; continue; }
      const restoreTierId = parseInt(prior, 10);
      if (!Number.isFinite(restoreTierId) || !validTierIds.has(restoreTierId)) {
        alreadyReversed++; continue;
      }
      if (tierByMember.get(mid) === restoreTierId) alreadyReversed++;
      else willChange++;
    }
  } else {
    res.status(400).json({ error: `Unsupported reverse for action: ${originalAction}` }); return;
  }

  res.json({
    willChange,
    alreadyReversed,
    affectedMembers: validIds.length,
    originalAction,
  });
});

/**
 * Re-apply / redo a bulk action (Task #206).
 * Identifies the bulk-action group by (bucket, entity, reason, actorUserId)
 * — the same coordinates the drill-down uses — and re-runs the same action
 * against the same set of members. Useful when a reverse was applied in error
 * or when an admin wants to repeat a tagging operation against the same cohort.
 *
 * Supported originals: freeze, suspend, tag, tier_change. Members already in
 * the target state are skipped (no duplicate work). Messages and reinstate are
 * not redoable (no idempotent semantics: messages would re-send, reinstate is
 * already-the-default lifecycle state).
 *
 * Stricter RBAC than other bulk endpoints: only org_admin / super_admin can
 * redo a bulk action. Each affected member receives a fresh audit row with
 * reason `bulk redo-of #<bucket-iso>` so the redo itself shows up as its own
 * bucket in the bulk-audit history.
 */
/**
 * Pre-flight count for the redo dialog (Task #234).
 *
 * Mirrors the eligibility logic of POST /bulk-action/redo without writing
 * anything: identifies the original cohort by (bucket, entity, reason,
 * actorUserId) and returns how many members would actually change vs are
 * already in the target state and would be skipped.
 *
 * Lightweight: only reads the columns needed to decide eligibility, never
 * inserts audit / lifecycle rows.
 *
 * Response shape:
 *   {
 *     willChange: number,        // members that would actually be updated
 *     alreadyInTargetState: number, // members the redo would skip
 *     affectedMembers: number,   // valid cohort size still in this org
 *     originalAction: string,
 *   }
 */
router.post("/bulk-action/redo/preview", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required." }); return; } }
  const user = req.user as { id: number; role?: string; organizationId?: number | null };
  let allowed = user.role === "super_admin"
    || (user.role === "org_admin" && user.organizationId === orgId);
  if (!allowed) {
    const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
    if (m && m.role === "org_admin") allowed = true;
  }
  if (!allowed) { { res.status(403).json({ error: "Only org_admin or super_admin can preview re-applying bulk actions." }); return; } }

  const { bucket, entity, reason, actorUserId, includeMembers } = req.body as {
    bucket?: string; entity?: string; reason?: string | null; actorUserId?: number | string | null;
    includeMembers?: boolean;
  };
  if (!bucket || !entity) { { res.status(400).json({ error: "bucket and entity are required" }); return; } }
  const bucketStart = new Date(bucket);
  if (Number.isNaN(bucketStart.getTime())) {
    res.status(400).json({ error: "bucket must be a valid ISO timestamp" }); return;
  }
  const bucketEnd = new Date(bucketStart.getTime() + 60_000);

  if (reason && /^bulk\s+(reverse-of|redo-of)\b/.test(reason)) {
    res.status(400).json({ error: "This entry is itself a reversal or redo — re-apply the original bulk action instead." }); return;
  }

  let actorUserIdNum: number | null = null;
  if (actorUserId != null && actorUserId !== "") {
    const raw = String(actorUserId);
    if (!/^\d+$/.test(raw)) { { res.status(400).json({ error: "actorUserId must be a non-negative integer" }); return; } }
    actorUserIdNum = parseInt(raw, 10);
  }
  const wantBreakdown = includeMembers === true;

  const deriveAction = (): string | null => {
    if (entity === "tag") return "tag";
    if (entity === "message") return "message";
    if (entity === "tier") return "tier_change";
    if (entity === "lifecycle" && reason) {
      const m = reason.match(/^bulk\s+(\w+)/);
      if (m) return m[1];
    }
    return null;
  };
  const originalAction = deriveAction();
  if (!originalAction) { { res.status(400).json({ error: "Cannot infer original action from entity/reason" }); return; } }
  if (originalAction === "message") {
    res.status(400).json({ error: "Bulk messages cannot be re-applied — re-send a fresh broadcast instead." }); return;
  }
  if (originalAction === "reinstate") {
    res.status(400).json({ error: "Bulk reinstate cannot be re-applied — members are already active." }); return;
  }

  const conds = [
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, entity),
    sql`${memberAuditLogTable.createdAt} >= ${bucketStart}`,
    sql`${memberAuditLogTable.createdAt} < ${bucketEnd}`,
  ];
  if (reason != null) conds.push(eq(memberAuditLogTable.reason, reason));
  if (actorUserIdNum != null) {
    conds.push(eq(memberAuditLogTable.actorUserId, actorUserIdNum));
  } else {
    conds.push(sql`${memberAuditLogTable.actorUserId} IS NULL`);
  }
  const auditRows = await db.select({
    clubMemberId: memberAuditLogTable.clubMemberId,
  }).from(memberAuditLogTable).where(and(...conds));
  const memberIds = Array.from(new Set(
    auditRows.map(r => r.clubMemberId).filter((x): x is number => x != null),
  ));
  if (memberIds.length === 0) {
    res.json({
      willChange: 0, alreadyInTargetState: 0, affectedMembers: 0, originalAction,
      ...(wantBreakdown ? { skippedMembers: [], willChangeMembers: [] } : {}),
    });
    return;
  }
  const valid = await db.select({ id: clubMembersTable.id, tierId: clubMembersTable.tierId }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.organizationId, orgId), inArray(clubMembersTable.id, memberIds)));
  const validIds = valid.map(m => m.id);
  if (validIds.length === 0) {
    res.json({
      willChange: 0, alreadyInTargetState: 0, affectedMembers: 0, originalAction,
      ...(wantBreakdown ? { skippedMembers: [], willChangeMembers: [] } : {}),
    });
    return;
  }

  let willChange = 0;
  let alreadyInTargetState = 0;
  const skippedIds: number[] = [];
  const willChangeIds: number[] = [];

  if (originalAction === "freeze" || originalAction === "suspend") {
    const newStatus = originalAction === "freeze" ? "frozen" : "suspended";
    const exts = await db.select({
      clubMemberId: memberProfileExtTable.clubMemberId,
      lifecycleStatus: memberProfileExtTable.lifecycleStatus,
    }).from(memberProfileExtTable).where(inArray(memberProfileExtTable.clubMemberId, validIds));
    const statusByMember = new Map<number, string | null>();
    for (const e of exts) if (e.clubMemberId != null) statusByMember.set(e.clubMemberId, e.lifecycleStatus ?? null);
    for (const mid of validIds) {
      const cur = statusByMember.get(mid) ?? null;
      if (cur === newStatus) { alreadyInTargetState++; skippedIds.push(mid); }
      else { willChange++; willChangeIds.push(mid); }
    }
  } else if (originalAction === "tag") {
    const tagMatch = reason ? reason.match(/^bulk\s+tag:\s*(.+)$/) : null;
    const tag = tagMatch ? tagMatch[1].trim() : "";
    if (!tag) { { res.status(400).json({ error: "Cannot determine tag name from original reason." }); return; } }
    const exts = await db.select({
      clubMemberId: memberProfileExtTable.clubMemberId,
      internalTags: memberProfileExtTable.internalTags,
    }).from(memberProfileExtTable).where(inArray(memberProfileExtTable.clubMemberId, validIds));
    const tagsByMember = new Map<number, string[]>();
    for (const e of exts) if (e.clubMemberId != null) tagsByMember.set(e.clubMemberId, e.internalTags ?? []);
    for (const mid of validIds) {
      const tags = tagsByMember.get(mid) ?? [];
      if (tags.includes(tag)) { alreadyInTargetState++; skippedIds.push(mid); }
      else { willChange++; willChangeIds.push(mid); }
    }
  } else if (originalAction === "tier_change") {
    const lcRows = await db.select({
      clubMemberId: memberLifecycleEventsTable.clubMemberId,
      toValue: memberLifecycleEventsTable.toValue,
    }).from(memberLifecycleEventsTable).where(and(
      eq(memberLifecycleEventsTable.organizationId, orgId),
      eq(memberLifecycleEventsTable.eventType, "tier_change"),
      inArray(memberLifecycleEventsTable.clubMemberId, validIds),
      sql`${memberLifecycleEventsTable.createdAt} >= ${bucketStart}`,
      sql`${memberLifecycleEventsTable.createdAt} < ${bucketEnd}`,
    ));
    const targetByMember = new Map<number, string | null>();
    for (const r of lcRows) {
      if (r.clubMemberId != null) targetByMember.set(r.clubMemberId, r.toValue);
    }
    const tierByMember = new Map<number, number | null>();
    for (const m of valid) tierByMember.set(m.id, m.tierId ?? null);
    // Validate target tiers still exist in this org.
    const targetTierIds = Array.from(new Set(
      Array.from(targetByMember.values())
        .map(v => v ? parseInt(v, 10) : NaN)
        .filter((n): n is number => Number.isFinite(n)),
    ));
    const validTierIds = new Set<number>();
    if (targetTierIds.length > 0) {
      const trows = await db.select({ id: membershipTiersTable.id }).from(membershipTiersTable)
        .where(and(eq(membershipTiersTable.organizationId, orgId), inArray(membershipTiersTable.id, targetTierIds)));
      for (const t of trows) validTierIds.add(t.id);
    }
    for (const mid of validIds) {
      const target = targetByMember.get(mid);
      if (!target) { alreadyInTargetState++; skippedIds.push(mid); continue; }
      const targetTierId = parseInt(target, 10);
      if (!Number.isFinite(targetTierId) || !validTierIds.has(targetTierId)) {
        alreadyInTargetState++; skippedIds.push(mid); continue;
      }
      if (tierByMember.get(mid) === targetTierId) { alreadyInTargetState++; skippedIds.push(mid); }
      else { willChange++; willChangeIds.push(mid); }
    }
  } else {
    res.status(400).json({ error: `Unsupported redo for action: ${originalAction}` }); return;
  }

  let skippedMembers: Array<{
    id: number; firstName: string; lastName: string; memberNumber: string | null; email: string | null;
  }> | undefined;
  let willChangeMembers: Array<{
    id: number; firstName: string; lastName: string; memberNumber: string | null;
  }> | undefined;
  if (wantBreakdown) {
    const breakdownIds = Array.from(new Set([...skippedIds, ...willChangeIds]));
    const rowsById = new Map<number, {
      id: number; firstName: string; lastName: string; memberNumber: string | null; email: string | null;
    }>();
    if (breakdownIds.length > 0) {
      const rows = await db.select({
        id: clubMembersTable.id,
        firstName: clubMembersTable.firstName,
        lastName: clubMembersTable.lastName,
        memberNumber: clubMembersTable.memberNumber,
        email: clubMembersTable.email,
      }).from(clubMembersTable)
        .where(and(eq(clubMembersTable.organizationId, orgId), inArray(clubMembersTable.id, breakdownIds)))
        .orderBy(asc(clubMembersTable.lastName), asc(clubMembersTable.firstName));
      for (const r of rows) rowsById.set(r.id, r);
    }
    const skippedSet = new Set(skippedIds);
    const willChangeSet = new Set(willChangeIds);
    skippedMembers = [];
    willChangeMembers = [];
    // Iterate in the sorted order returned from DB to preserve last/first ordering.
    for (const r of rowsById.values()) {
      if (skippedSet.has(r.id)) skippedMembers.push(r);
      if (willChangeSet.has(r.id)) {
        const { email: _e, ...rest } = r;
        willChangeMembers.push(rest);
      }
    }
  }

  res.json({
    willChange,
    alreadyInTargetState,
    affectedMembers: validIds.length,
    originalAction,
    ...(skippedMembers !== undefined ? { skippedMembers } : {}),
    ...(willChangeMembers !== undefined ? { willChangeMembers } : {}),
  });
});

router.post("/bulk-action/redo", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required." }); return; } }
  const user = req.user as { id: number; role?: string; organizationId?: number | null };
  let allowed = user.role === "super_admin"
    || (user.role === "org_admin" && user.organizationId === orgId);
  if (!allowed) {
    const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
    if (m && m.role === "org_admin") allowed = true;
  }
  if (!allowed) { { res.status(403).json({ error: "Only org_admin or super_admin can re-apply bulk actions." }); return; } }

  const { bucket, entity, reason, actorUserId } = req.body as {
    bucket?: string; entity?: string; reason?: string | null; actorUserId?: number | string | null;
  };
  if (!bucket || !entity) {
    res.status(400).json({ error: "bucket and entity are required" }); return;
  }
  const bucketStart = new Date(bucket);
  if (Number.isNaN(bucketStart.getTime())) {
    res.status(400).json({ error: "bucket must be a valid ISO timestamp" }); return;
  }
  const bucketEnd = new Date(bucketStart.getTime() + 60_000);

  // Reject derivative entries — redo only makes sense from the original action.
  if (reason && /^bulk\s+(reverse-of|redo-of)\b/.test(reason)) {
    res.status(400).json({ error: "This entry is itself a reversal or redo — re-apply the original bulk action instead." }); return;
  }

  let actorUserIdNum: number | null = null;
  if (actorUserId != null && actorUserId !== "") {
    const raw = String(actorUserId);
    if (!/^\d+$/.test(raw)) { { res.status(400).json({ error: "actorUserId must be a non-negative integer" }); return; } }
    actorUserIdNum = parseInt(raw, 10);
  }

  const deriveAction = (): string | null => {
    if (entity === "tag") return "tag";
    if (entity === "message") return "message";
    if (entity === "tier") return "tier_change";
    if (entity === "lifecycle" && reason) {
      const m = reason.match(/^bulk\s+(\w+)/);
      if (m) return m[1];
    }
    return null;
  };
  const originalAction = deriveAction();
  if (!originalAction) { { res.status(400).json({ error: "Cannot infer original action from entity/reason" }); return; } }

  if (originalAction === "message") {
    res.status(400).json({ error: "Bulk messages cannot be re-applied — re-send a fresh broadcast instead." }); return;
  }
  if (originalAction === "reinstate") {
    res.status(400).json({ error: "Bulk reinstate cannot be re-applied — members are already active." }); return;
  }

  // Find original audit rows in this bucket so we know which members were affected.
  const conds = [
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, entity),
    sql`${memberAuditLogTable.createdAt} >= ${bucketStart}`,
    sql`${memberAuditLogTable.createdAt} < ${bucketEnd}`,
  ];
  if (reason != null) conds.push(eq(memberAuditLogTable.reason, reason));
  if (actorUserIdNum != null) {
    conds.push(eq(memberAuditLogTable.actorUserId, actorUserIdNum));
  } else {
    conds.push(sql`${memberAuditLogTable.actorUserId} IS NULL`);
  }
  const auditRows = await db.select({
    clubMemberId: memberAuditLogTable.clubMemberId,
  }).from(memberAuditLogTable).where(and(...conds));

  const memberIds = Array.from(new Set(
    auditRows.map(r => r.clubMemberId).filter((x): x is number => x != null),
  ));
  if (memberIds.length === 0) {
    res.status(404).json({ error: "No affected members found for this bulk action." }); return;
  }

  // Tenant safety: re-confirm members still belong to this org.
  const valid = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.organizationId, orgId), inArray(clubMembersTable.id, memberIds)));
  const validIds = valid.map(m => m.id);
  if (validIds.length === 0) { { res.status(404).json({ error: "Affected members no longer exist in this org." }); return; } }

  const redoReason = `bulk redo-of #${bucketStart.toISOString()}`;
  let redone = 0;
  let skipped = 0;

  if (originalAction === "freeze" || originalAction === "suspend") {
    const newStatus = originalAction === "freeze" ? "frozen" : "suspended";
    for (const mid of validIds) {
      const ext = await ensureExt(mid, orgId);
      if (ext.lifecycleStatus === newStatus) { skipped++; continue; }
      await db.insert(memberLifecycleEventsTable).values({
        organizationId: orgId, clubMemberId: mid, eventType: originalAction,
        reason: redoReason,
        performedByUserId: user.id,
      });
      await db.update(memberProfileExtTable).set({
        lifecycleStatus: newStatus, lifecycleReason: redoReason, updatedAt: new Date(),
      }).where(eq(memberProfileExtTable.id, ext.id));
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid,
        entity: "lifecycle", action: "create",
        changes: { lifecycleStatus: { from: ext.lifecycleStatus ?? null, to: newStatus } },
        reason: redoReason,
      });
      redone++;
    }
  } else if (originalAction === "tag") {
    const tagMatch = reason ? reason.match(/^bulk\s+tag:\s*(.+)$/) : null;
    const tag = tagMatch ? tagMatch[1].trim() : "";
    if (!tag) { { res.status(400).json({ error: "Cannot determine tag name from original reason." }); return; } }
    for (const mid of validIds) {
      const ext = await ensureExt(mid, orgId);
      const before: string[] = ext.internalTags ?? [];
      if (before.includes(tag)) { skipped++; continue; }
      const after = [...before, tag];
      await db.update(memberProfileExtTable).set({ internalTags: after, updatedAt: new Date() })
        .where(eq(memberProfileExtTable.id, ext.id));
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid,
        entity: "tag", action: "create",
        changes: { tag: { from: null, to: tag } },
        reason: redoReason,
      });
      redone++;
    }
  } else if (originalAction === "tier_change") {
    // Look up the original lifecycle events in the same bucket window to get the target tier.
    const lcRows = await db.select({
      clubMemberId: memberLifecycleEventsTable.clubMemberId,
      toValue: memberLifecycleEventsTable.toValue,
    }).from(memberLifecycleEventsTable).where(and(
      eq(memberLifecycleEventsTable.organizationId, orgId),
      eq(memberLifecycleEventsTable.eventType, "tier_change"),
      inArray(memberLifecycleEventsTable.clubMemberId, validIds),
      sql`${memberLifecycleEventsTable.createdAt} >= ${bucketStart}`,
      sql`${memberLifecycleEventsTable.createdAt} < ${bucketEnd}`,
    ));
    const targetByMember = new Map<number, string | null>();
    for (const r of lcRows) {
      if (r.clubMemberId != null) targetByMember.set(r.clubMemberId, r.toValue);
    }
    for (const mid of validIds) {
      const target = targetByMember.get(mid);
      if (!target) { skipped++; continue; }
      const targetTierId = parseInt(target, 10);
      if (!Number.isFinite(targetTierId)) { skipped++; continue; }
      const [tierOk] = await db.select({ id: membershipTiersTable.id, name: membershipTiersTable.name })
        .from(membershipTiersTable)
        .where(and(eq(membershipTiersTable.id, targetTierId), eq(membershipTiersTable.organizationId, orgId)));
      if (!tierOk) { skipped++; continue; }
      const before = await loadMember(orgId, mid);
      if (before?.tierId === targetTierId) { skipped++; continue; }
      let prevTierName: string | null = null;
      if (before?.tierId != null) {
        const [pt] = await db.select({ name: membershipTiersTable.name }).from(membershipTiersTable)
          .where(and(eq(membershipTiersTable.id, before.tierId), eq(membershipTiersTable.organizationId, orgId)));
        prevTierName = pt?.name ?? null;
      }
      await db.update(clubMembersTable).set({ tierId: targetTierId, updatedAt: new Date() })
        .where(eq(clubMembersTable.id, mid));
      await db.insert(memberLifecycleEventsTable).values({
        organizationId: orgId, clubMemberId: mid, eventType: "tier_change",
        fromValue: before?.tierId != null ? String(before.tierId) : null,
        toValue: String(targetTierId),
        reason: redoReason,
        performedByUserId: user.id,
      });
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid,
        entity: "tier", action: "update",
        changes: { tier: { from: prevTierName, to: tierOk.name } },
        reason: redoReason,
      });
      redone++;
    }
  } else {
    res.status(400).json({ error: `Unsupported redo for action: ${originalAction}` }); return;
  }

  res.json({
    redone,
    skipped,
    originalAction,
    redoReason,
    affectedMembers: validIds.length,
  });
});

/**
 * Clone a bulk action against a *fresh* cohort (Task #233).
 *
 * Same coordinates as /bulk-action/redo to identify the source bucket
 * (bucket, entity, reason, actorUserId), but the caller supplies an explicit
 * `memberIds` list that came from the current filter or a saved segment.
 * The action is replayed against those members (skipping any already in the
 * target state). A new bulk-audit row is created with reason
 * `bulk redo-of #<bucket-iso> (filtered: <label>)` so the clone shows up as
 * its own bucket while linking back to the source bucket via the prefix.
 *
 * Supported originals: freeze, suspend, tag, tier_change. Same RBAC as redo
 * (org_admin / super_admin only).
 */
router.post("/bulk-action/clone", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required." }); return; } }
  const user = req.user as { id: number; role?: string; organizationId?: number | null };
  let allowed = user.role === "super_admin"
    || (user.role === "org_admin" && user.organizationId === orgId);
  if (!allowed) {
    const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
    if (m && m.role === "org_admin") allowed = true;
  }
  if (!allowed) { { res.status(403).json({ error: "Only org_admin or super_admin can re-apply bulk actions." }); return; } }

  const { bucket, entity, reason, actorUserId, memberIds, cohortLabel } = req.body as {
    bucket?: string; entity?: string; reason?: string | null; actorUserId?: number | string | null;
    memberIds?: unknown; cohortLabel?: string | null;
  };
  if (!bucket || !entity) { { res.status(400).json({ error: "bucket and entity are required" }); return; } }
  const bucketStart = new Date(bucket);
  if (Number.isNaN(bucketStart.getTime())) {
    res.status(400).json({ error: "bucket must be a valid ISO timestamp" }); return;
  }
  const bucketEnd = new Date(bucketStart.getTime() + 60_000);

  if (reason && /^bulk\s+(reverse-of|redo-of)\b/.test(reason)) {
    res.status(400).json({ error: "This entry is itself a reversal or redo — re-apply the original bulk action instead." }); return;
  }

  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    res.status(400).json({ error: "memberIds must be a non-empty array" }); return;
  }
  const requestedIds: number[] = [];
  for (const v of memberIds) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!Number.isFinite(n) || n <= 0) {
      res.status(400).json({ error: "memberIds must be positive integers" }); return;
    }
    requestedIds.push(n);
  }
  const uniqueIds = Array.from(new Set(requestedIds));
  const MAX_COHORT = 5000;
  if (uniqueIds.length > MAX_COHORT) {
    res.status(400).json({ error: `Cohort exceeds ${MAX_COHORT} members — narrow the filter and retry.` }); return;
  }

  const trimmedLabel = typeof cohortLabel === "string" ? cohortLabel.trim().slice(0, 80) : "";

  const deriveAction = (): string | null => {
    if (entity === "tag") return "tag";
    if (entity === "message") return "message";
    if (entity === "tier") return "tier_change";
    if (entity === "lifecycle" && reason) {
      const m = reason.match(/^bulk\s+(\w+)/);
      if (m) return m[1];
    }
    return null;
  };
  const originalAction = deriveAction();
  if (!originalAction) { { res.status(400).json({ error: "Cannot infer original action from entity/reason" }); return; } }
  if (originalAction === "message") {
    res.status(400).json({ error: "Bulk messages cannot be re-applied — re-send a fresh broadcast instead." }); return;
  }
  if (originalAction === "reinstate") {
    res.status(400).json({ error: "Bulk reinstate cannot be re-applied — members are already active." }); return;
  }

  let actorUserIdNum: number | null = null;
  if (actorUserId != null && actorUserId !== "") {
    const raw = String(actorUserId);
    if (!/^\d+$/.test(raw)) { { res.status(400).json({ error: "actorUserId must be a non-negative integer" }); return; } }
    actorUserIdNum = parseInt(raw, 10);
  }

  // Confirm the source bucket actually exists for this org/entity/reason.
  const sourceConds = [
    eq(memberAuditLogTable.organizationId, orgId),
    eq(memberAuditLogTable.entity, entity),
    sql`${memberAuditLogTable.createdAt} >= ${bucketStart}`,
    sql`${memberAuditLogTable.createdAt} < ${bucketEnd}`,
  ];
  if (reason != null) sourceConds.push(eq(memberAuditLogTable.reason, reason));
  if (actorUserIdNum != null) {
    sourceConds.push(eq(memberAuditLogTable.actorUserId, actorUserIdNum));
  } else {
    sourceConds.push(sql`${memberAuditLogTable.actorUserId} IS NULL`);
  }
  const [{ n: sourceCount } = { n: 0 }] = await db.select({ n: count() })
    .from(memberAuditLogTable).where(and(...sourceConds));
  if (!sourceCount || sourceCount === 0) {
    res.status(404).json({ error: "Source bulk action not found." }); return;
  }

  // Tenant safety: only members that still belong to this org are eligible.
  const valid = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.organizationId, orgId), inArray(clubMembersTable.id, uniqueIds)));
  const validIds = valid.map(m => m.id);
  if (validIds.length === 0) {
    res.status(400).json({ error: "None of the supplied members belong to this organization." }); return;
  }

  const baseReason = `bulk redo-of #${bucketStart.toISOString()}`;
  const cloneReason = trimmedLabel
    ? `${baseReason} (filtered: ${trimmedLabel})`
    : `${baseReason} (filtered)`;

  let redone = 0;
  let skipped = 0;

  if (originalAction === "freeze" || originalAction === "suspend") {
    const newStatus = originalAction === "freeze" ? "frozen" : "suspended";
    for (const mid of validIds) {
      const ext = await ensureExt(mid, orgId);
      if (ext.lifecycleStatus === newStatus) { skipped++; continue; }
      await db.insert(memberLifecycleEventsTable).values({
        organizationId: orgId, clubMemberId: mid, eventType: originalAction,
        reason: cloneReason,
        performedByUserId: user.id,
      });
      await db.update(memberProfileExtTable).set({
        lifecycleStatus: newStatus, lifecycleReason: cloneReason, updatedAt: new Date(),
      }).where(eq(memberProfileExtTable.id, ext.id));
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid,
        entity: "lifecycle", action: "create",
        changes: { lifecycleStatus: { from: ext.lifecycleStatus ?? null, to: newStatus } },
        reason: cloneReason,
      });
      redone++;
    }
  } else if (originalAction === "tag") {
    const tagMatch = reason ? reason.match(/^bulk\s+tag:\s*(.+)$/) : null;
    const tag = tagMatch ? tagMatch[1].trim() : "";
    if (!tag) { { res.status(400).json({ error: "Cannot determine tag name from original reason." }); return; } }
    for (const mid of validIds) {
      const ext = await ensureExt(mid, orgId);
      const before: string[] = ext.internalTags ?? [];
      if (before.includes(tag)) { skipped++; continue; }
      const after = [...before, tag];
      await db.update(memberProfileExtTable).set({ internalTags: after, updatedAt: new Date() })
        .where(eq(memberProfileExtTable.id, ext.id));
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid,
        entity: "tag", action: "create",
        changes: { tag: { from: null, to: tag } },
        reason: cloneReason,
      });
      redone++;
    }
  } else if (originalAction === "tier_change") {
    // The original bulk-action sent every member to the same tier — pull the
    // target tier from any one of the source bucket's lifecycle events.
    const [lcSample] = await db.select({ toValue: memberLifecycleEventsTable.toValue })
      .from(memberLifecycleEventsTable).where(and(
        eq(memberLifecycleEventsTable.organizationId, orgId),
        eq(memberLifecycleEventsTable.eventType, "tier_change"),
        sql`${memberLifecycleEventsTable.createdAt} >= ${bucketStart}`,
        sql`${memberLifecycleEventsTable.createdAt} < ${bucketEnd}`,
      )).limit(1);
    const targetRaw = lcSample?.toValue ?? null;
    const targetTierId = targetRaw != null ? parseInt(targetRaw, 10) : NaN;
    if (!Number.isFinite(targetTierId)) {
      res.status(400).json({ error: "Cannot determine target tier from the source bulk action." }); return;
    }
    const [tierOk] = await db.select({ id: membershipTiersTable.id, name: membershipTiersTable.name })
      .from(membershipTiersTable)
      .where(and(eq(membershipTiersTable.id, targetTierId), eq(membershipTiersTable.organizationId, orgId)));
    if (!tierOk) {
      res.status(400).json({ error: "Target tier no longer exists in this organization." }); return;
    }
    for (const mid of validIds) {
      const before = await loadMember(orgId, mid);
      if (before?.tierId === targetTierId) { skipped++; continue; }
      let prevTierName: string | null = null;
      if (before?.tierId != null) {
        const [pt] = await db.select({ name: membershipTiersTable.name }).from(membershipTiersTable)
          .where(and(eq(membershipTiersTable.id, before.tierId), eq(membershipTiersTable.organizationId, orgId)));
        prevTierName = pt?.name ?? null;
      }
      await db.update(clubMembersTable).set({ tierId: targetTierId, updatedAt: new Date() })
        .where(eq(clubMembersTable.id, mid));
      await db.insert(memberLifecycleEventsTable).values({
        organizationId: orgId, clubMemberId: mid, eventType: "tier_change",
        fromValue: before?.tierId != null ? String(before.tierId) : null,
        toValue: String(targetTierId),
        reason: cloneReason,
        performedByUserId: user.id,
      });
      await recordMemberAudit({
        req, organizationId: orgId, clubMemberId: mid,
        entity: "tier", action: "update",
        changes: { tier: { from: prevTierName, to: tierOk.name } },
        reason: cloneReason,
      });
      redone++;
    }
  } else {
    res.status(400).json({ error: `Unsupported clone for action: ${originalAction}` }); return;
  }

  res.json({
    redone,
    skipped,
    originalAction,
    cloneReason,
    cohortSize: validIds.length,
    requested: uniqueIds.length,
  });
});

// ─── SAVED SEGMENTS ──────────────────────────────────────────────────────────

router.get("/saved-segments", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const userId = (req.user as { id: number }).id;
  const rows = await db.select().from(memberSavedSegmentsTable)
    .where(and(
      eq(memberSavedSegmentsTable.organizationId, orgId),
      sql`(${memberSavedSegmentsTable.ownerUserId} = ${userId} OR ${memberSavedSegmentsTable.isShared} = true)`,
    ))
    .orderBy(asc(memberSavedSegmentsTable.name));
  res.json(rows);
});

router.post("/saved-segments", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const { name, description, filters, isShared } = req.body;
  if (!name || !filters) { { res.status(400).json({ error: "name and filters required" }); return; } }
  const trimmedName = String(name).trim();
  if (!trimmedName) { { res.status(400).json({ error: "name and filters required" }); return; } }
  // Names must be unique within an org so the segment dropdown stays
  // unambiguous. Match case-insensitively to prevent near-duplicates like
  // "VIP" and "vip" both showing up.
  const [conflict] = await db.select({ id: memberSavedSegmentsTable.id })
    .from(memberSavedSegmentsTable)
    .where(and(
      eq(memberSavedSegmentsTable.organizationId, orgId),
      sql`lower(${memberSavedSegmentsTable.name}) = lower(${trimmedName})`,
    ))
    .limit(1);
  if (conflict) {
    res.status(409).json({ error: `A segment named "${trimmedName}" already exists. Please choose a different name.` });
    return;
  }
  const [row] = await db.insert(memberSavedSegmentsTable).values({
    organizationId: orgId, ownerUserId: (req.user as { id: number }).id,
    name: trimmedName, description, filters, isShared: Boolean(isShared),
  }).returning();
  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: null,
    entity: "saved_segment", entityId: row.id, action: "create",
    after: { name: row.name, isShared: row.isShared }, reason: `Segment saved: ${trimmedName}`,
  });
  res.status(201).json(row);
});

router.patch("/saved-segments/:id", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id) || id <= 0) { { res.status(400).json({ error: "invalid id" }); return; } }
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const userId = (req.user as { id: number }).id;
  const { name, description, isShared } = req.body ?? {};

  const [existing] = await db.select().from(memberSavedSegmentsTable).where(and(
    eq(memberSavedSegmentsTable.id, id),
    eq(memberSavedSegmentsTable.organizationId, orgId),
    eq(memberSavedSegmentsTable.ownerUserId, userId),
  )).limit(1);
  if (!existing) { { res.status(404).json({ error: "Segment not found" }); return; } }

  const updates: Record<string, unknown> = {};
  let trimmedName: string | null = null;
  if (name !== undefined) {
    trimmedName = String(name).trim();
    if (!trimmedName) { { res.status(400).json({ error: "name cannot be empty" }); return; } }
    // Same case-insensitive uniqueness rule as POST, scoped to the org and
    // excluding the row we're editing.
    const [conflict] = await db.select({ id: memberSavedSegmentsTable.id })
      .from(memberSavedSegmentsTable)
      .where(and(
        eq(memberSavedSegmentsTable.organizationId, orgId),
        sql`lower(${memberSavedSegmentsTable.name}) = lower(${trimmedName})`,
        sql`${memberSavedSegmentsTable.id} <> ${id}`,
      ))
      .limit(1);
    if (conflict) {
      res.status(409).json({ error: `A segment named "${trimmedName}" already exists. Please choose a different name.` });
      return;
    }
    updates.name = trimmedName;
  }
  if (description !== undefined) {
    updates.description = description == null ? null : String(description);
  }
  if (isShared !== undefined) {
    updates.isShared = Boolean(isShared);
  }
  if (Object.keys(updates).length === 0) {
    res.json(existing); return;
  }
  updates.updatedAt = new Date();
  const [row] = await db.update(memberSavedSegmentsTable)
    .set(updates)
    .where(and(
      eq(memberSavedSegmentsTable.id, id),
      eq(memberSavedSegmentsTable.organizationId, orgId),
      eq(memberSavedSegmentsTable.ownerUserId, userId),
    )).returning();
  await recordMemberAudit({
    req, organizationId: orgId, clubMemberId: null,
    entity: "saved_segment", entityId: id, action: "update",
    before: { name: existing.name, isShared: existing.isShared, description: existing.description },
    after: { name: row.name, isShared: row.isShared, description: row.description },
    reason: trimmedName && trimmedName !== existing.name
      ? `Segment renamed: ${existing.name} → ${row.name}`
      : `Segment updated: ${row.name}`,
  });
  res.json(row);
});

router.delete("/saved-segments/:id", async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireMemberAdmin(req, res, orgId)) return;
  const userId = (req.user as { id: number }).id;
  const deleted = await db.delete(memberSavedSegmentsTable).where(and(
    eq(memberSavedSegmentsTable.id, id),
    eq(memberSavedSegmentsTable.organizationId, orgId),
    eq(memberSavedSegmentsTable.ownerUserId, userId),
  )).returning();
  if (deleted.length > 0) {
    await recordMemberAudit({
      req, organizationId: orgId, clubMemberId: null,
      entity: "saved_segment", entityId: id, action: "delete",
      reason: `Segment deleted: ${deleted[0].name}`,
    });
  }
  res.status(204).end();
});

export default router;
