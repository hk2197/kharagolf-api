/**
 * Handicap Committee Review Cases — state machine + lifecycle helpers.
 *
 * Case lifecycle:
 *   open → assigned → awaiting_peer → decided → closed
 *   (any state may be reopened back to assigned)
 *
 * Kinds: anomalous | not_posted | exceptional | annual
 * Decisions: no_action | soft_cap | hard_cap | index_adjustment
 *
 * Every state transition is recorded in handicap_case_audit_log so the player
 * handicap profile can render a complete chronology of committee actions.
 */
import {
  db,
  handicapReviewCasesTable,
  handicapCasePeerReviewsTable,
  handicapCaseAuditLogTable,
  handicapCaseNotificationsTable,
  exceptionalScoreFlagsTable,
  whsScoreRecordsTable,
  whsPlayerStateTable,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  playersTable,
  tournamentsTable,
  userNotificationPrefsTable,
  type HandicapReviewCase,
} from "@workspace/db";
import { and, eq, sql, desc, gte, lte, inArray, isNull, isNotNull } from "drizzle-orm";
import crypto from "crypto";
import { sendTransactionalPush } from "./comms";

/** Roles considered to be on the handicap committee for an organization. */
const COMMITTEE_ROLES = ["org_admin", "tournament_director", "committee_member", "competition_secretary"] as const;

/**
 * Resolve the set of user ids that should receive committee-facing
 * notifications for an org. Combines org_memberships rows in committee roles
 * with the legacy appUsers.role + appUsers.organizationId admin set, since
 * either may grant committee access (see requireCommitteeMember).
 */
export async function getCommitteeMemberUserIds(orgId: number): Promise<number[]> {
  const ids = new Set<number>();
  const memberRows = await db.select({ userId: orgMembershipsTable.userId })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      inArray(orgMembershipsTable.role, COMMITTEE_ROLES as unknown as never[]),
    ));
  for (const r of memberRows) ids.add(r.userId);

  const userRows = await db.select({ id: appUsersTable.id })
    .from(appUsersTable)
    .where(and(
      eq(appUsersTable.organizationId, orgId),
      inArray(appUsersTable.role, COMMITTEE_ROLES as unknown as never[]),
    ));
  for (const r of userRows) ids.add(r.id);

  return [...ids];
}

export type CaseKind = "anomalous" | "not_posted" | "exceptional" | "annual";
export type CaseStatus = "open" | "assigned" | "awaiting_peer" | "decided" | "closed";
export type CaseDecision = "no_action" | "soft_cap" | "hard_cap" | "index_adjustment";

export const CASE_KINDS: CaseKind[] = ["anomalous", "not_posted", "exceptional", "annual"];
export const CASE_STATUSES: CaseStatus[] = ["open", "assigned", "awaiting_peer", "decided", "closed"];
export const CASE_DECISIONS: CaseDecision[] = ["no_action", "soft_cap", "hard_cap", "index_adjustment"];

/** Allowed forward transitions in the case state machine. */
const VALID_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  open: ["assigned", "closed"],
  assigned: ["awaiting_peer", "decided", "closed"],
  awaiting_peer: ["decided", "assigned", "closed"],
  decided: ["closed", "assigned"],
  closed: ["assigned"],
};

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface AuditEntryInput {
  caseId: number;
  action: string;
  actorUserId: number | null;
  payload?: Record<string, unknown>;
  fromStatus?: CaseStatus | null;
  toStatus?: CaseStatus | null;
}

/**
 * Notify the case subject (the player whose handicap is under review) of a
 * lifecycle event via in-app push. Best-effort — failures are logged.
 */
export async function notifySubjectOfCaseEvent(
  caseId: number,
  event: "opened" | "decided" | "closed" | "reopened",
  extras?: { decision?: CaseDecision | null; rationale?: string | null },
): Promise<void> {
  try {
    const [row] = await db.select({
      subjectUserId: handicapReviewCasesTable.subjectUserId,
      organizationId: handicapReviewCasesTable.organizationId,
      kind: handicapReviewCasesTable.kind,
      orgName: organizationsTable.name,
    })
      .from(handicapReviewCasesTable)
      .leftJoin(organizationsTable, eq(handicapReviewCasesTable.organizationId, organizationsTable.id))
      .where(eq(handicapReviewCasesTable.id, caseId));
    if (!row) return;
    const titleByEvent: Record<typeof event, string> = {
      opened: "Handicap committee — case opened",
      decided: "Handicap committee — decision recorded",
      closed: "Handicap committee — case closed",
      reopened: "Handicap committee — case reopened",
    };
    const orgLabel = row.orgName || "Your club";
    let body = `${orgLabel} has ${event === "opened" ? "opened a" : event} a ${row.kind} review case on your handicap.`;
    if (event === "decided" && extras?.decision) {
      body = `${orgLabel} recorded a decision (${extras.decision.replace(/_/g, " ")}) on your handicap review case.`;
    }

    // Persist a durable in-app notification record so the player sees it on
    // their notifications page even when push delivery is unavailable or
    // missed. Best-effort — failures are logged but never block the case
    // lifecycle.
    try {
      await db.insert(handicapCaseNotificationsTable).values({
        subjectUserId: row.subjectUserId,
        caseId,
        organizationId: row.organizationId,
        event,
        title: titleByEvent[event],
        body,
        payload: {
          kind: row.kind,
          decision: extras?.decision ?? null,
          rationale: extras?.rationale ?? null,
        },
      });
    } catch (err) {
      console.warn("[handicap-cases] persist in-app notification failed:", err);
    }

    await sendTransactionalPush(
      [row.subjectUserId],
      titleByEvent[event],
      body,
      { type: "handicap_case_update", caseId, event, url: "/handicap-profile" },
    );
  } catch (err) {
    console.warn("[handicap-cases] notify subject failed:", err);
  }
}

/** A db executor — either the global `db` or a transaction handle. */
type TxArg = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbExecutor = typeof db | TxArg;

export async function appendAudit(entry: AuditEntryInput, executor: DbExecutor = db): Promise<void> {
  await executor.insert(handicapCaseAuditLogTable).values({
    caseId: entry.caseId,
    action: entry.action,
    actorUserId: entry.actorUserId,
    payload: entry.payload ?? null,
    fromStatus: entry.fromStatus ?? null,
    toStatus: entry.toStatus ?? null,
  });
}

export interface CreateCaseInput {
  organizationId: number;
  subjectUserId: number;
  kind: CaseKind;
  playerId?: number | null;
  flagId?: number | null;
  periodLabel?: string | null;
  details?: string | null;
  createdByUserId?: number | null;
}

/**
 * Create a new committee review case. If a case already exists for the same
 * (org, subject, kind, period_label) tuple in a non-closed state we return it
 * instead of creating a duplicate — important for cron-driven generation
 * (annual review, anomaly scan, score-not-posted) which is naturally
 * idempotent.
 */
export async function createCase(input: CreateCaseInput): Promise<HandicapReviewCase> {
  // Idempotency check (skip if flagId already linked).
  if (input.flagId != null) {
    const [existingByFlag] = await db.select().from(handicapReviewCasesTable)
      .where(eq(handicapReviewCasesTable.flagId, input.flagId));
    if (existingByFlag) return existingByFlag;
  }
  if (input.periodLabel) {
    const conds = [
      eq(handicapReviewCasesTable.organizationId, input.organizationId),
      eq(handicapReviewCasesTable.subjectUserId, input.subjectUserId),
      eq(handicapReviewCasesTable.kind, input.kind),
      eq(handicapReviewCasesTable.periodLabel, input.periodLabel),
    ];
    const [existing] = await db.select().from(handicapReviewCasesTable)
      .where(and(...conds))
      .orderBy(desc(handicapReviewCasesTable.createdAt))
      .limit(1);
    if (existing && existing.status !== "closed") return existing;
  }

  const [row] = await db.insert(handicapReviewCasesTable).values({
    organizationId: input.organizationId,
    playerId: input.playerId ?? null,
    subjectUserId: input.subjectUserId,
    kind: input.kind,
    status: "open",
    flagId: input.flagId ?? null,
    periodLabel: input.periodLabel ?? null,
    details: input.details ?? null,
    createdByUserId: input.createdByUserId ?? null,
  }).returning();

  await appendAudit({
    caseId: row.id,
    action: "created",
    actorUserId: input.createdByUserId ?? null,
    payload: { kind: input.kind, periodLabel: input.periodLabel ?? null },
    toStatus: "open",
  });

  // Notify subject (best-effort; never blocks case creation).
  notifySubjectOfCaseEvent(row.id, "opened").catch(() => {});

  return row;
}

/** Move a case to a new status. Throws if the transition is invalid. */
export async function transitionStatus(
  caseId: number,
  to: CaseStatus,
  actorUserId: number | null,
  extra?: { decision?: CaseDecision; rationale?: string; assigneeUserId?: number; adjustmentId?: number },
  executor: DbExecutor = db,
): Promise<HandicapReviewCase> {
  const [current] = await executor.select().from(handicapReviewCasesTable)
    .where(eq(handicapReviewCasesTable.id, caseId));
  if (!current) throw new Error("Case not found");
  const from = current.status as CaseStatus;
  if (!canTransition(from, to)) {
    throw new Error(`Invalid transition: ${from} → ${to}`);
  }

  const patch: Partial<typeof handicapReviewCasesTable.$inferInsert> = {
    status: to,
    updatedAt: new Date(),
  };

  if (to === "decided") {
    patch.decision = extra?.decision ?? null;
    patch.decisionRationale = extra?.rationale ?? null;
    patch.decisionAt = new Date();
    patch.decidedByUserId = actorUserId;
    if (extra?.adjustmentId != null) patch.adjustmentId = extra.adjustmentId;
  }
  if (to === "closed") {
    patch.closedAt = new Date();
  }
  if (to === "assigned" && extra?.assigneeUserId != null) {
    patch.assigneeUserId = extra.assigneeUserId;
  }

  const [updated] = await executor.update(handicapReviewCasesTable)
    .set(patch)
    .where(eq(handicapReviewCasesTable.id, caseId))
    .returning();

  await appendAudit({
    caseId,
    action: to === "decided" ? "decided" : to === "closed" ? "closed" : to === "assigned" ? (from === "closed" ? "reopened" : "assigned") : `transition_${to}`,
    actorUserId,
    fromStatus: from,
    toStatus: to,
    payload: {
      decision: extra?.decision ?? null,
      rationale: extra?.rationale ?? null,
      assigneeUserId: extra?.assigneeUserId ?? null,
      adjustmentId: extra?.adjustmentId ?? null,
    },
  }, executor);

  // Notify subject of significant lifecycle events (best-effort).
  if (to === "decided") {
    notifySubjectOfCaseEvent(caseId, "decided", { decision: extra?.decision ?? null, rationale: extra?.rationale ?? null }).catch(() => {});
  } else if (to === "closed") {
    notifySubjectOfCaseEvent(caseId, "closed").catch(() => {});
  } else if (to === "assigned" && from === "closed") {
    notifySubjectOfCaseEvent(caseId, "reopened").catch(() => {});
  }

  return updated;
}

export interface PeerInviteInput {
  caseId: number;
  reviewerUserId: number;
  invitedByUserId: number | null;
  expiresInDays?: number;
}

/**
 * Invite a peer reviewer with a focused-link token. Idempotent per
 * (caseId, reviewerUserId): if an unresponded invite exists it is returned.
 */
export async function invitePeerReviewer(input: PeerInviteInput): Promise<{ id: number; token: string }> {
  // Reuse open invite if present.
  const [existing] = await db.select().from(handicapCasePeerReviewsTable)
    .where(and(
      eq(handicapCasePeerReviewsTable.caseId, input.caseId),
      eq(handicapCasePeerReviewsTable.reviewerUserId, input.reviewerUserId),
      isNull(handicapCasePeerReviewsTable.respondedAt),
    ))
    .limit(1);
  if (existing) return { id: existing.id, token: existing.token };

  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + (input.expiresInDays ?? 14) * 86_400_000);

  const [row] = await db.insert(handicapCasePeerReviewsTable).values({
    caseId: input.caseId,
    reviewerUserId: input.reviewerUserId,
    token,
    expiresAt,
  }).returning({ id: handicapCasePeerReviewsTable.id, token: handicapCasePeerReviewsTable.token });

  // Move case to awaiting_peer if not already there.
  const [c] = await db.select({ status: handicapReviewCasesTable.status })
    .from(handicapReviewCasesTable)
    .where(eq(handicapReviewCasesTable.id, input.caseId));
  if (c && c.status !== "awaiting_peer" && canTransition(c.status as CaseStatus, "awaiting_peer")) {
    await db.update(handicapReviewCasesTable).set({
      status: "awaiting_peer",
      updatedAt: new Date(),
    }).where(eq(handicapReviewCasesTable.id, input.caseId));
  }

  await appendAudit({
    caseId: input.caseId,
    action: "peer_invited",
    actorUserId: input.invitedByUserId,
    payload: { reviewerUserId: input.reviewerUserId, expiresAt: expiresAt.toISOString() },
    fromStatus: c?.status as CaseStatus | undefined,
    toStatus: "awaiting_peer",
  });

  return { id: row.id, token: row.token };
}

export interface RecordPeerResponseInput {
  token: string;
  recommendation: "confirm" | "dispute" | "insufficient_info";
  comment?: string | null;
}

/** Record a peer reviewer's response (token-authenticated, no session needed). */
export async function recordPeerResponse(input: RecordPeerResponseInput): Promise<{ caseId: number } | null> {
  const [invite] = await db.select().from(handicapCasePeerReviewsTable)
    .where(eq(handicapCasePeerReviewsTable.token, input.token));
  if (!invite) return null;
  if (invite.respondedAt) return { caseId: invite.caseId };
  if (invite.expiresAt && invite.expiresAt < new Date()) return null;

  await db.update(handicapCasePeerReviewsTable).set({
    recommendation: input.recommendation,
    comment: input.comment ?? null,
    respondedAt: new Date(),
  }).where(eq(handicapCasePeerReviewsTable.id, invite.id));

  await appendAudit({
    caseId: invite.caseId,
    action: "peer_responded",
    actorUserId: invite.reviewerUserId,
    payload: { recommendation: input.recommendation, comment: input.comment ?? null },
  });

  // Notify the committee in real time (best-effort).
  notifyCommitteeOfPeerResponse({
    caseId: invite.caseId,
    reviewerUserId: invite.reviewerUserId,
    recommendation: input.recommendation,
    comment: input.comment ?? null,
  }).catch((err) => console.warn("[handicap-cases] notify committee of peer response failed:", err));

  return { caseId: invite.caseId };
}

/**
 * Notify all committee members of a case that a peer reviewer has responded.
 * Persists a durable in-app inbox entry per recipient and sends a push so the
 * committee no longer has to refresh the case detail to see new comments.
 * Best-effort — failures are logged but never propagate.
 */
export async function notifyCommitteeOfPeerResponse(input: {
  caseId: number;
  reviewerUserId: number;
  recommendation: "confirm" | "dispute" | "insufficient_info";
  comment: string | null;
}): Promise<void> {
  const [row] = await db.select({
    organizationId: handicapReviewCasesTable.organizationId,
    kind: handicapReviewCasesTable.kind,
    assigneeUserId: handicapReviewCasesTable.assigneeUserId,
    createdByUserId: handicapReviewCasesTable.createdByUserId,
    subjectUserId: handicapReviewCasesTable.subjectUserId,
    subjectName: appUsersTable.displayName,
    orgName: organizationsTable.name,
  })
    .from(handicapReviewCasesTable)
    .leftJoin(appUsersTable, eq(handicapReviewCasesTable.subjectUserId, appUsersTable.id))
    .leftJoin(organizationsTable, eq(handicapReviewCasesTable.organizationId, organizationsTable.id))
    .where(eq(handicapReviewCasesTable.id, input.caseId));
  if (!row) return;

  const [reviewer] = await db.select({ displayName: appUsersTable.displayName })
    .from(appUsersTable).where(eq(appUsersTable.id, input.reviewerUserId));

  const recipients = new Set<number>(await getCommitteeMemberUserIds(row.organizationId));
  if (row.assigneeUserId) recipients.add(row.assigneeUserId);
  if (row.createdByUserId) recipients.add(row.createdByUserId);
  // Never notify the subject (they aren't a committee member in this context),
  // nor the reviewer about their own response.
  recipients.delete(row.subjectUserId);
  recipients.delete(input.reviewerUserId);
  const recipientIds = [...recipients];
  if (recipientIds.length === 0) return;

  const orgLabel = row.orgName || "Your club";
  const reviewerLabel = reviewer?.displayName || "A peer reviewer";
  const subjectLabel = row.subjectName || "a player";
  const verb = input.recommendation.replace(/_/g, " ");
  const title = `${orgLabel} — peer review response`;
  const body = `${reviewerLabel} responded (${verb}) on the ${row.kind} case for ${subjectLabel}.`;
  const deepLink = `/handicap-committee?caseId=${input.caseId}`;

  const payload = {
    kind: row.kind,
    reviewerUserId: input.reviewerUserId,
    reviewerName: reviewer?.displayName ?? null,
    recommendation: input.recommendation,
    comment: input.comment,
    deepLink,
  };

  // Persist a durable inbox entry per recipient. Failures per row are logged
  // but never block push delivery to other recipients.
  for (const userId of recipientIds) {
    try {
      await db.insert(handicapCaseNotificationsTable).values({
        subjectUserId: userId,
        caseId: input.caseId,
        organizationId: row.organizationId,
        event: "peer_responded",
        title,
        body,
        payload,
      });
    } catch (err) {
      console.warn("[handicap-cases] persist committee inbox entry failed:", err);
    }
  }

  try {
    await sendTransactionalPush(
      recipientIds,
      title,
      body,
      { type: "handicap_peer_response", caseId: input.caseId, url: deepLink },
    );
  } catch (err) {
    console.warn("[handicap-cases] committee push failed:", err);
  }
}

/**
 * Build a digest of peer responses recorded since `since` for a given org.
 * Returns one entry per peer review row that was responded in the window.
 */
export async function listPeerResponsesSince(orgId: number, since: Date): Promise<Array<{
  peerReviewId: number;
  caseId: number;
  caseKind: string;
  subjectName: string | null;
  reviewerName: string | null;
  recommendation: string | null;
  comment: string | null;
  respondedAt: Date;
}>> {
  const rows = await db.select({
    peerReviewId: handicapCasePeerReviewsTable.id,
    caseId: handicapCasePeerReviewsTable.caseId,
    caseKind: handicapReviewCasesTable.kind,
    subjectName: appUsersTable.displayName,
    reviewerUserId: handicapCasePeerReviewsTable.reviewerUserId,
    recommendation: handicapCasePeerReviewsTable.recommendation,
    comment: handicapCasePeerReviewsTable.comment,
    respondedAt: handicapCasePeerReviewsTable.respondedAt,
  })
    .from(handicapCasePeerReviewsTable)
    .innerJoin(handicapReviewCasesTable, eq(handicapCasePeerReviewsTable.caseId, handicapReviewCasesTable.id))
    .leftJoin(appUsersTable, eq(handicapReviewCasesTable.subjectUserId, appUsersTable.id))
    .where(and(
      eq(handicapReviewCasesTable.organizationId, orgId),
      isNotNull(handicapCasePeerReviewsTable.respondedAt),
      gte(handicapCasePeerReviewsTable.respondedAt, since),
    ))
    .orderBy(desc(handicapCasePeerReviewsTable.respondedAt));

  // Filter out responses already covered by a previous digest send.
  // We persist a `committee_digest_emailed` audit row per included peer-review
  // id (see sendCommitteePeerResponsesDigests below). This implements true
  // "since last send" semantics — even if the cron is delayed, a response
  // spanning multiple windows is included exactly once, and a re-run inside
  // the window does not duplicate.
  const peerReviewIds = rows.map(r => r.peerReviewId);
  const alreadySent = new Set<number>();
  if (peerReviewIds.length > 0) {
    const sentAudits = await db.select({ payload: handicapCaseAuditLogTable.payload })
      .from(handicapCaseAuditLogTable)
      .where(eq(handicapCaseAuditLogTable.action, "committee_digest_emailed"));
    for (const a of sentAudits) {
      const pid = (a.payload as { peerReviewId?: number } | null)?.peerReviewId;
      if (typeof pid === "number") alreadySent.add(pid);
    }
  }
  const filtered = rows.filter(r => !alreadySent.has(r.peerReviewId));

  // Resolve reviewer display names in one batch.
  const reviewerIds = [...new Set(filtered.map(r => r.reviewerUserId))];
  const nameById = new Map<number, string | null>();
  if (reviewerIds.length > 0) {
    const users = await db.select({ id: appUsersTable.id, displayName: appUsersTable.displayName })
      .from(appUsersTable).where(inArray(appUsersTable.id, reviewerIds));
    for (const u of users) nameById.set(u.id, u.displayName);
  }

  return filtered.map(r => ({
    peerReviewId: r.peerReviewId,
    caseId: r.caseId,
    caseKind: r.caseKind,
    subjectName: r.subjectName,
    reviewerName: nameById.get(r.reviewerUserId) ?? null,
    recommendation: r.recommendation,
    comment: r.comment,
    respondedAt: r.respondedAt as Date,
  }));
}

/**
 * Send a digest to every committee member of every org summarizing peer
 * responses that have not yet been included in any prior digest. Implements
 * true "since last send" semantics: per-(case, peer-review) audit rows act
 * as the watermark, so cron delays/missed runs do not lose responses, and
 * accelerated cadence does not duplicate them. Per-org and per-recipient
 * failures are logged but never abort the run.
 *
 * `windowMs` is a safety upper bound used as a coarse pre-filter (default
 * 7 days) — the audit-row check is what enforces exactly-once.
 */
export async function sendCommitteePeerResponsesDigests(windowMs = 7 * 24 * 60 * 60 * 1000): Promise<{ orgs: number; emails: number }> {
  const since = new Date(Date.now() - windowMs);
  const orgRows = await db.selectDistinct({ orgId: handicapReviewCasesTable.organizationId })
    .from(handicapReviewCasesTable);
  let emails = 0;
  let orgsWithDigest = 0;
  // Lazy-import mailer to avoid a circular dependency at module load.
  const { sendCommitteePeerResponseDigestEmail } = await import("./mailer");
  for (const { orgId } of orgRows) {
    if (!orgId) continue;
    try {
      const responses = await listPeerResponsesSince(orgId, since);
      if (responses.length === 0) continue;
      const recipientIds = await getCommitteeMemberUserIds(orgId);
      if (recipientIds.length === 0) continue;
      // Honour per-user opt-out (Task #754): committee members who set
      // `notify_committee_peer_digest = false` in their notification prefs
      // are skipped here. Default is true so existing members are unaffected.
      const optOutRows = await db.select({ userId: userNotificationPrefsTable.userId })
        .from(userNotificationPrefsTable)
        .where(and(
          inArray(userNotificationPrefsTable.userId, recipientIds),
          eq(userNotificationPrefsTable.notifyCommitteePeerDigest, false),
        ));
      const optedOut = new Set(optOutRows.map(r => r.userId));
      const filteredRecipientIds = recipientIds.filter(id => !optedOut.has(id));
      if (filteredRecipientIds.length === 0) continue;
      const recipients = await db.select({
        id: appUsersTable.id,
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
      }).from(appUsersTable).where(inArray(appUsersTable.id, filteredRecipientIds));
      const [org] = await db.select({ name: organizationsTable.name })
        .from(organizationsTable).where(eq(organizationsTable.id, orgId));
      orgsWithDigest++;
      let anyDelivered = false;
      for (const r of recipients) {
        if (!r.email) continue;
        try {
          await sendCommitteePeerResponseDigestEmail({
            to: r.email,
            recipientName: r.displayName || "Committee member",
            orgName: org?.name || "Your club",
            sinceIso: since.toISOString(),
            responses,
          });
          emails++;
          anyDelivered = true;
        } catch (err) {
          console.warn("[handicap-cases] committee digest email failed:", err);
        }
      }
      // Persist the watermark only if at least one recipient received the
      // digest; otherwise leave the response queued for the next run.
      if (anyDelivered) {
        const sentAt = new Date().toISOString();
        const auditRows = responses.map(resp => ({
          caseId: resp.caseId,
          action: "committee_digest_emailed",
          actorUserId: null,
          payload: { peerReviewId: resp.peerReviewId, sentAt } as Record<string, unknown>,
        }));
        if (auditRows.length > 0) {
          try {
            await db.insert(handicapCaseAuditLogTable).values(auditRows);
          } catch (err) {
            console.warn("[handicap-cases] committee digest watermark insert failed:", err);
          }
        }
      }
    } catch (err) {
      console.warn("[handicap-cases] committee digest org failed:", { orgId, err });
    }
  }
  return { orgs: orgsWithDigest, emails };
}

/* ─── Case generators (cron-driven) ──────────────────────────────── */

/**
 * Backfill cases for ESR flags that don't have one. Returns count of new cases.
 */
export async function generateCasesForExistingFlags(orgId: number): Promise<number> {
  const flags = await db.select({
    id: exceptionalScoreFlagsTable.id,
    playerId: exceptionalScoreFlagsTable.playerId,
    organizationId: exceptionalScoreFlagsTable.organizationId,
    tournamentId: exceptionalScoreFlagsTable.tournamentId,
    round: exceptionalScoreFlagsTable.round,
    scoreDifferential: exceptionalScoreFlagsTable.scoreDifferential,
    userId: playersTable.userId,
  })
    .from(exceptionalScoreFlagsTable)
    .innerJoin(playersTable, eq(exceptionalScoreFlagsTable.playerId, playersTable.id))
    .where(and(
      eq(exceptionalScoreFlagsTable.organizationId, orgId),
      eq(exceptionalScoreFlagsTable.status, "pending"),
    ));

  let created = 0;
  for (const f of flags) {
    if (!f.userId) continue;
    // Skip if a case already exists for this flag.
    const [existing] = await db.select({ id: handicapReviewCasesTable.id })
      .from(handicapReviewCasesTable)
      .where(eq(handicapReviewCasesTable.flagId, f.id));
    if (existing) continue;

    await createCase({
      organizationId: f.organizationId,
      subjectUserId: f.userId,
      kind: "exceptional",
      playerId: f.playerId,
      flagId: f.id,
      periodLabel: f.tournamentId ? `Tournament ${f.tournamentId} R${f.round ?? "?"}` : null,
      details: `ESR flag — score differential ${Number(f.scoreDifferential).toFixed(1)}.`,
    });
    created++;
  }
  return created;
}

/**
 * Annual review: generate one open `annual` case per active player in the org
 * for the given calendar year. Idempotent via period_label de-dupe.
 */
export async function generateAnnualReviewCases(orgId: number, year: number): Promise<number> {
  const periodLabel = `Annual ${year}`;
  const states = await db.select({
    userId: whsPlayerStateTable.userId,
    currentHi: whsPlayerStateTable.currentHandicapIndex,
    lowHi: whsPlayerStateTable.lowHandicapIndex,
  })
    .from(whsPlayerStateTable)
    .where(eq(whsPlayerStateTable.organizationId, orgId));

  let created = 0;
  for (const s of states) {
    const before = await db.select({ id: handicapReviewCasesTable.id }).from(handicapReviewCasesTable)
      .where(and(
        eq(handicapReviewCasesTable.organizationId, orgId),
        eq(handicapReviewCasesTable.subjectUserId, s.userId),
        eq(handicapReviewCasesTable.kind, "annual"),
        eq(handicapReviewCasesTable.periodLabel, periodLabel),
      ))
      .limit(1);
    if (before.length > 0) continue;

    await createCase({
      organizationId: orgId,
      subjectUserId: s.userId,
      kind: "annual",
      periodLabel,
      details: `Annual handicap review for ${year}. Current HI ${s.currentHi ?? "n/a"}, Low HI ${s.lowHi ?? "n/a"}.`,
    });
    created++;
  }
  return created;
}

/**
 * Score-not-posted detection: flag players who have not posted a score in the
 * trailing N days despite holding a current handicap index. Generates one
 * `not_posted` case per such player per calendar month (idempotent).
 */
export async function generateScoreNotPostedCases(orgId: number, dormantDays = 180): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - dormantDays * 86_400_000);
  const periodLabel = `NotPosted ${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  // Players with state but no recent score record.
  const states = await db.select({
    userId: whsPlayerStateTable.userId,
    currentHi: whsPlayerStateTable.currentHandicapIndex,
  })
    .from(whsPlayerStateTable)
    .where(and(
      eq(whsPlayerStateTable.organizationId, orgId),
      isNotNull(whsPlayerStateTable.currentHandicapIndex),
    ));

  let created = 0;
  for (const s of states) {
    const [recent] = await db.select({ id: whsScoreRecordsTable.id })
      .from(whsScoreRecordsTable)
      .where(and(
        eq(whsScoreRecordsTable.userId, s.userId),
        eq(whsScoreRecordsTable.organizationId, orgId),
        gte(whsScoreRecordsTable.playedAt, cutoff),
      ))
      .limit(1);
    if (recent) continue;

    const before = await db.select({ id: handicapReviewCasesTable.id }).from(handicapReviewCasesTable)
      .where(and(
        eq(handicapReviewCasesTable.organizationId, orgId),
        eq(handicapReviewCasesTable.subjectUserId, s.userId),
        eq(handicapReviewCasesTable.kind, "not_posted"),
        eq(handicapReviewCasesTable.periodLabel, periodLabel),
      ))
      .limit(1);
    if (before.length > 0) continue;

    await createCase({
      organizationId: orgId,
      subjectUserId: s.userId,
      kind: "not_posted",
      periodLabel,
      details: `No scores posted in the last ${dormantDays} days. Current HI ${s.currentHi ?? "n/a"}.`,
    });
    created++;
  }
  return created;
}

/**
 * Anomalous score scan: detect score records whose final differential deviates
 * by more than `thresholdStrokes` from the player's running mean differential.
 * Creates one `anomalous` case per (player, score record) — idempotent via
 * period_label encoding the score record id.
 */
export async function generateAnomalousScoreCases(orgId: number, thresholdStrokes = 7): Promise<number> {
  const sinceDate = new Date(Date.now() - 30 * 86_400_000);
  const recent = await db.select({
    id: whsScoreRecordsTable.id,
    userId: whsScoreRecordsTable.userId,
    finalDifferential: whsScoreRecordsTable.finalDifferential,
    playedAt: whsScoreRecordsTable.playedAt,
  })
    .from(whsScoreRecordsTable)
    .where(and(
      eq(whsScoreRecordsTable.organizationId, orgId),
      gte(whsScoreRecordsTable.playedAt, sinceDate),
      isNotNull(whsScoreRecordsTable.finalDifferential),
    ));

  // Group by user, compute mean diff from prior history.
  let created = 0;
  for (const r of recent) {
    if (r.finalDifferential == null) continue;
    const diff = Number(r.finalDifferential);
    const priorRows = await db.select({ d: whsScoreRecordsTable.finalDifferential })
      .from(whsScoreRecordsTable)
      .where(and(
        eq(whsScoreRecordsTable.userId, r.userId),
        eq(whsScoreRecordsTable.organizationId, orgId),
        lte(whsScoreRecordsTable.playedAt, r.playedAt),
        isNotNull(whsScoreRecordsTable.finalDifferential),
      ))
      .orderBy(desc(whsScoreRecordsTable.playedAt))
      .limit(20);
    const priors = priorRows.map(p => Number(p.d)).filter(n => !Number.isNaN(n));
    if (priors.length < 5) continue;
    const mean = priors.reduce((a, b) => a + b, 0) / priors.length;
    if (Math.abs(diff - mean) < thresholdStrokes) continue;

    const periodLabel = `Anom score#${r.id}`;
    const before = await db.select({ id: handicapReviewCasesTable.id }).from(handicapReviewCasesTable)
      .where(and(
        eq(handicapReviewCasesTable.organizationId, orgId),
        eq(handicapReviewCasesTable.subjectUserId, r.userId),
        eq(handicapReviewCasesTable.kind, "anomalous"),
        eq(handicapReviewCasesTable.periodLabel, periodLabel),
      ))
      .limit(1);
    if (before.length > 0) continue;

    await createCase({
      organizationId: orgId,
      subjectUserId: r.userId,
      kind: "anomalous",
      periodLabel,
      details: `Score differential ${diff.toFixed(1)} deviates ${(diff - mean).toFixed(1)} strokes from the player's recent mean (${mean.toFixed(1)}).`,
    });
    created++;
  }
  return created;
}

/** Run all org-wide generators in sequence and return tallies. */
export async function runCaseGenerationForAllOrgs(): Promise<{ orgs: number; created: number }> {
  // Get distinct organization ids that have any WHS state.
  const orgRows = await db.selectDistinct({ orgId: whsPlayerStateTable.organizationId })
    .from(whsPlayerStateTable);

  let total = 0;
  for (const { orgId } of orgRows) {
    if (!orgId) continue;
    const a = await generateCasesForExistingFlags(orgId).catch(() => 0);
    const b = await generateAnomalousScoreCases(orgId).catch(() => 0);
    const c = await generateScoreNotPostedCases(orgId).catch(() => 0);
    total += a + b + c;
  }
  return { orgs: orgRows.length, created: total };
}
