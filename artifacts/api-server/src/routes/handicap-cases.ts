/**
 * Handicap Committee Review Cases API
 * Mounted at: /organizations/:orgId/handicap
 *
 *   GET    /cases                          List cases (filter by ?status= ?kind= ?subjectUserId=)
 *   POST   /cases                          Create a new case manually
 *   GET    /cases/:caseId                  Case detail (with peer reviews + audit log)
 *   POST   /cases/:caseId/assign           Assign / reassign owner
 *   POST   /cases/:caseId/peer-invite      Invite a peer reviewer (sends email + push)
 *   POST   /cases/:caseId/decide           Record decision (no_action | soft_cap | hard_cap | index_adjustment)
 *   POST   /cases/:caseId/close            Close the case
 *   POST   /cases/:caseId/reopen           Reopen a closed/decided case
 *   POST   /cases/generate-annual          Generate annual review cases for the given year
 *   POST   /cases/scan                     Run anomaly + score-not-posted + esr backfill scan
 *   GET    /cases/stats                    Counts by kind/status
 *
 * Player-facing (subject of the case) — read-only:
 *   GET    /portal/handicap/my-cases       The signed-in user's cases (committee actions on them)
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  appUsersTable,
  organizationsTable,
  playersTable,
  tournamentsTable,
  handicapReviewCasesTable,
  handicapCasePeerReviewsTable,
  handicapCaseAuditLogTable,
  handicapCaseNotificationsTable,
  handicapAdjustmentsTable,
  whsPlayerStateTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, and, desc, inArray, sql, count, isNull, or, gt, lt } from "drizzle-orm";
import { requireCommitteeMember } from "../lib/permissions";
import { track } from "../lib/analytics";
import {
  createCase,
  transitionStatus,
  invitePeerReviewer,
  generateAnnualReviewCases,
  generateAnomalousScoreCases,
  generateScoreNotPostedCases,
  generateCasesForExistingFlags,
  appendAudit,
  canTransition,
  CASE_KINDS,
  CASE_STATUSES,
  CASE_DECISIONS,
  type CaseKind,
  type CaseStatus,
  type CaseDecision,
} from "../lib/handicap-cases";
import { sendPeerReviewRequestEmail } from "../lib/mailer";
import { sendTransactionalPush } from "../lib/comms";

const router: IRouter = Router({ mergeParams: true });

function isKind(x: unknown): x is CaseKind { return typeof x === "string" && (CASE_KINDS as string[]).includes(x); }
function isStatus(x: unknown): x is CaseStatus { return typeof x === "string" && (CASE_STATUSES as string[]).includes(x); }
function isDecision(x: unknown): x is CaseDecision { return typeof x === "string" && (CASE_DECISIONS as string[]).includes(x); }

function serializeCase(c: typeof handicapReviewCasesTable.$inferSelect) {
  return {
    ...c,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    closedAt: c.closedAt?.toISOString() ?? null,
    decisionAt: c.decisionAt?.toISOString() ?? null,
  };
}

/* ─── GET /cases ────────────────────────────────────────────────── */
router.get("/cases", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const filters = [eq(handicapReviewCasesTable.organizationId, orgId)];
  if (typeof req.query.status === "string" && req.query.status !== "all") {
    filters.push(eq(handicapReviewCasesTable.status, req.query.status));
  }
  if (typeof req.query.kind === "string" && req.query.kind !== "all") {
    filters.push(eq(handicapReviewCasesTable.kind, req.query.kind));
  }
  if (typeof req.query.subjectUserId === "string") {
    const id = parseInt(req.query.subjectUserId);
    if (Number.isFinite(id)) filters.push(eq(handicapReviewCasesTable.subjectUserId, id));
  }

  const rows = await db.select({
    c: handicapReviewCasesTable,
    subjectName: appUsersTable.displayName,
    subjectEmail: appUsersTable.email,
  })
    .from(handicapReviewCasesTable)
    .leftJoin(appUsersTable, eq(handicapReviewCasesTable.subjectUserId, appUsersTable.id))
    .where(and(...filters))
    .orderBy(desc(handicapReviewCasesTable.updatedAt));

  res.json(rows.map(r => ({ ...serializeCase(r.c), subjectName: r.subjectName, subjectEmail: r.subjectEmail })));
});

/* ─── GET /cases/stats ──────────────────────────────────────────── */
router.get("/cases/stats", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const rows = await db.select({
    kind: handicapReviewCasesTable.kind,
    status: handicapReviewCasesTable.status,
    n: count(),
  })
    .from(handicapReviewCasesTable)
    .where(eq(handicapReviewCasesTable.organizationId, orgId))
    .groupBy(handicapReviewCasesTable.kind, handicapReviewCasesTable.status);

  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + Number(r.n);
    byStatus[r.status] = (byStatus[r.status] ?? 0) + Number(r.n);
    total += Number(r.n);
  }
  res.json({ total, byKind, byStatus });
});

/* ─── POST /cases ───────────────────────────────────────────────── */
router.post("/cases", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const { subjectUserId, kind, playerId, periodLabel, details, flagId } = req.body as {
    subjectUserId: number;
    kind: string;
    playerId?: number;
    periodLabel?: string;
    details?: string;
    flagId?: number;
  };
  if (typeof subjectUserId !== "number") {
    res.status(400).json({ error: "subjectUserId required" }); return;
  }
  if (!isKind(kind)) {
    res.status(400).json({ error: `kind must be one of: ${CASE_KINDS.join(", ")}` }); return;
  }

  // Verify subject is in this org.
  const [member] = await db.select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.userId, subjectUserId), eq(orgMembershipsTable.organizationId, orgId)));
  if (!member) {
    res.status(403).json({ error: "Subject is not a member of this organization" }); return;
  }

  const c = await createCase({
    organizationId: orgId,
    subjectUserId,
    kind,
    playerId: playerId ?? null,
    flagId: flagId ?? null,
    periodLabel: periodLabel ?? null,
    details: details ?? null,
    createdByUserId: req.user?.id ?? null,
  });
  res.status(201).json(serializeCase(c));
});

/* ─── GET /cases/:caseId ────────────────────────────────────────── */
router.get("/cases/:caseId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caseId = parseInt(String((req.params as Record<string, string>).caseId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const [c] = await db.select({
    c: handicapReviewCasesTable,
    subjectName: appUsersTable.displayName,
    subjectEmail: appUsersTable.email,
  })
    .from(handicapReviewCasesTable)
    .leftJoin(appUsersTable, eq(handicapReviewCasesTable.subjectUserId, appUsersTable.id))
    .where(and(eq(handicapReviewCasesTable.id, caseId), eq(handicapReviewCasesTable.organizationId, orgId)));
  if (!c) { { res.status(404).json({ error: "Case not found" }); return; } }

  const peers = await db.select({
    p: handicapCasePeerReviewsTable,
    reviewerName: appUsersTable.displayName,
    reviewerEmail: appUsersTable.email,
  })
    .from(handicapCasePeerReviewsTable)
    .leftJoin(appUsersTable, eq(handicapCasePeerReviewsTable.reviewerUserId, appUsersTable.id))
    .where(eq(handicapCasePeerReviewsTable.caseId, caseId))
    .orderBy(desc(handicapCasePeerReviewsTable.invitedAt));

  const audit = await db.select({
    a: handicapCaseAuditLogTable,
    actorName: appUsersTable.displayName,
  })
    .from(handicapCaseAuditLogTable)
    .leftJoin(appUsersTable, eq(handicapCaseAuditLogTable.actorUserId, appUsersTable.id))
    .where(eq(handicapCaseAuditLogTable.caseId, caseId))
    .orderBy(desc(handicapCaseAuditLogTable.createdAt));

  res.json({
    ...serializeCase(c.c),
    subjectName: c.subjectName,
    subjectEmail: c.subjectEmail,
    peerReviews: peers.map(r => ({
      ...r.p,
      // Token is sensitive — never include in read responses
      token: undefined,
      invitedAt: r.p.invitedAt.toISOString(),
      seenAt: r.p.seenAt?.toISOString() ?? null,
      respondedAt: r.p.respondedAt?.toISOString() ?? null,
      expiresAt: r.p.expiresAt?.toISOString() ?? null,
      reviewerName: r.reviewerName,
      reviewerEmail: r.reviewerEmail,
    })),
    auditLog: audit.map(r => ({
      ...r.a,
      createdAt: r.a.createdAt.toISOString(),
      actorName: r.actorName,
    })),
  });
});

/* ─── POST /cases/:caseId/assign ────────────────────────────────── */
router.post("/cases/:caseId/assign", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caseId = parseInt(String((req.params as Record<string, string>).caseId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const { assigneeUserId } = req.body as { assigneeUserId: number };
  if (typeof assigneeUserId !== "number") {
    res.status(400).json({ error: "assigneeUserId required" }); return;
  }
  // Verify assignee is a committee member of the org.
  const [member] = await db.select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.userId, assigneeUserId), eq(orgMembershipsTable.organizationId, orgId)));
  if (!member) { { res.status(400).json({ error: "Assignee not in org" }); return; } }

  const [target] = await db.select().from(handicapReviewCasesTable)
    .where(and(eq(handicapReviewCasesTable.id, caseId), eq(handicapReviewCasesTable.organizationId, orgId)));
  if (!target) { { res.status(404).json({ error: "Case not found" }); return; } }

  try {
    const updated = await transitionStatus(caseId, "assigned", req.user?.id ?? null, { assigneeUserId });
    res.json(serializeCase(updated));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* ─── POST /cases/:caseId/peer-invite ───────────────────────────── */
router.post("/cases/:caseId/peer-invite", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caseId = parseInt(String((req.params as Record<string, string>).caseId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const { reviewerUserId } = req.body as { reviewerUserId: number };
  if (typeof reviewerUserId !== "number") { { res.status(400).json({ error: "reviewerUserId required" }); return; } }

  const [target] = await db.select().from(handicapReviewCasesTable)
    .where(and(eq(handicapReviewCasesTable.id, caseId), eq(handicapReviewCasesTable.organizationId, orgId)));
  if (!target) { { res.status(404).json({ error: "Case not found" }); return; } }

  // Verify reviewer is in the org and not the subject.
  if (reviewerUserId === target.subjectUserId) {
    res.status(400).json({ error: "Reviewer cannot be the case subject" }); return;
  }
  const [reviewer] = await db.select({ id: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName })
    .from(appUsersTable)
    .innerJoin(orgMembershipsTable, and(
      eq(orgMembershipsTable.userId, appUsersTable.id),
      eq(orgMembershipsTable.organizationId, orgId),
    ))
    .where(eq(appUsersTable.id, reviewerUserId));
  if (!reviewer) { { res.status(400).json({ error: "Reviewer not found in this organization" }); return; } }

  const invite = await invitePeerReviewer({
    caseId,
    reviewerUserId,
    invitedByUserId: req.user?.id ?? null,
  });

  // Send notifications (best-effort).
  const [subject] = await db.select({ displayName: appUsersTable.displayName })
    .from(appUsersTable).where(eq(appUsersTable.id, target.subjectUserId));
  const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const baseUrl = process.env.PUBLIC_APP_URL || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "");
  const responseUrl = `${baseUrl}/peer-review/${invite.token}`;

  if (reviewer.email) {
    sendPeerReviewRequestEmail({
      to: reviewer.email,
      reviewerName: reviewer.displayName || "Reviewer",
      subjectName: subject?.displayName || "the player",
      caseKind: target.kind,
      caseDetails: target.details || "",
      responseUrl,
      orgName: org?.name || "Your Club",
    }).catch(err => console.warn("[handicap-cases] peer email failed:", err));
  }
  // Task #1240 — fire-and-forget; PushDeliveryResult is discarded (only
  // throws are logged). The peer-review email above is the durable
  // channel; no `classifyPushDelivery` mapping is needed.
  sendTransactionalPush(
    [reviewerUserId],
    "Handicap committee — peer review",
    `${org?.name || "Your club"}: please share your peer comment on a recent case.`,
    { type: "handicap_peer_review", caseId, token: invite.token, url: responseUrl },
  ).catch(err => console.warn("[handicap-cases] peer push failed:", err));

  res.status(201).json({
    success: true,
    peerReviewId: invite.id,
    responseUrl,
  });
});

/* ─── POST /cases/:caseId/decide ────────────────────────────────── */
router.post("/cases/:caseId/decide", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caseId = parseInt(String((req.params as Record<string, string>).caseId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const { decision, rationale, adjustmentId, createAdjustment, applyToPlayer } = req.body as {
    decision: string;
    rationale: string;
    adjustmentId?: number;
    createAdjustment?: {
      adjustmentStrokes?: number;
      capValue?: number;
      notes?: string;
    };
    /**
     * Task #596 — when true, the resulting HI is also written to
     * `players.handicapOverride` (and synced into `whs_player_state`) so the
     * committee decision flows all the way through to the player's effective
     * Handicap Index without a second manual step. Soft-cap decisions only
     * take effect when the proposed HI would actually be lower than the
     * player's current effective HI (matches WHS rule that the soft cap
     * only kicks in when the calculated HI exceeds the cap threshold).
     */
    applyToPlayer?: boolean;
  };
  if (!isDecision(decision)) {
    res.status(400).json({ error: `decision must be one of: ${CASE_DECISIONS.join(", ")}` }); return;
  }
  if (!rationale || typeof rationale !== "string" || rationale.trim().length === 0) {
    res.status(400).json({ error: "rationale is required for every committee decision" }); return;
  }

  // Verify case exists in org.
  const [target] = await db.select().from(handicapReviewCasesTable)
    .where(and(eq(handicapReviewCasesTable.id, caseId), eq(handicapReviewCasesTable.organizationId, orgId)));
  if (!target) { { res.status(404).json({ error: "Case not found" }); return; } }

  // Verify adjustment (if given) belongs to org + same player/subject.
  if (adjustmentId != null) {
    const [adj] = await db.select().from(handicapAdjustmentsTable)
      .where(and(eq(handicapAdjustmentsTable.id, adjustmentId), eq(handicapAdjustmentsTable.organizationId, orgId)));
    if (!adj) { { res.status(400).json({ error: "Linked adjustment not found in this org" }); return; } }
  }

  // Reject non-boolean truthy payloads up-front so a stray "false"/0/"" can't
  // be misread as opting in.
  if (applyToPlayer !== undefined && typeof applyToPlayer !== "boolean") {
    res.status(400).json({ error: "applyToPlayer must be a boolean" }); return;
  }
  // applyToPlayer requires an adjustment to derive the resulting HI from.
  // Without one we have no number to write to handicapOverride.
  if (applyToPlayer && createAdjustment == null && adjustmentId == null) {
    res.status(400).json({ error: "applyToPlayer requires either createAdjustment or adjustmentId" }); return;
  }
  if (applyToPlayer && decision === "no_action") {
    res.status(400).json({ error: "applyToPlayer is not allowed for a no_action decision" }); return;
  }

  // Validate inputs for createAdjustment up-front — before any DB writes —
  // so we can reject malformed requests without side effects.
  if (createAdjustment != null) {
    if (adjustmentId != null) {
      res.status(400).json({ error: "Provide either adjustmentId or createAdjustment, not both" }); return;
    }
    if (decision === "no_action") {
      res.status(400).json({ error: "createAdjustment is not allowed for a no_action decision" }); return;
    }
    if (decision === "index_adjustment") {
      const s = Number(createAdjustment.adjustmentStrokes);
      if (!Number.isFinite(s) || s <= 0) {
        res.status(400).json({ error: "adjustmentStrokes must be a positive number for an index_adjustment decision" }); return;
      }
    } else {
      // soft_cap | hard_cap
      const cap = Number(createAdjustment.capValue);
      if (!Number.isFinite(cap) || cap < 0 || cap > 54) {
        res.status(400).json({ error: "capValue must be a number between 0 and 54 for a soft_cap/hard_cap decision" }); return;
      }
    }
  }

  // Pre-validate the state-machine transition so we don't create an
  // orphaned adjustment row on an invalid case status.
  if (!canTransition(target.status as CaseStatus, "decided")) {
    res.status(400).json({ error: `Invalid transition: ${target.status} → decided` }); return;
  }

  try {
    // Run the adjustment insert + status transition atomically: if anything
    // throws inside the callback, the transaction is rolled back and no
    // adjustment row is left dangling without being linked to the case.
    const result = await db.transaction(async (tx) => {
      let resolvedAdjustmentId: number | undefined = adjustmentId ?? undefined;
      // Captured for the optional handicapOverride write below.
      let appliedPlayerId: number | null = null;
      let appliedPreviousHi: number | null = null;
      let appliedResultingHi: number | null = null;

      if (createAdjustment != null) {
        // Resolve the player record to attach the adjustment to. Prefer the
        // case's playerId; otherwise use the most recent player row for the
        // subject user within this organization.
        let playerRow: { id: number; handicapIndex: string | null; handicapOverride: string | null } | undefined;
        if (target.playerId != null) {
          // Enforce tenant isolation: the case's playerId must belong to a
          // tournament in this org AND be tied to the case subject. Without
          // this guard a malformed case with a foreign playerId could leak
          // cross-org player data through the adjustment record.
          const [p] = await tx.select({
            id: playersTable.id,
            handicapIndex: playersTable.handicapIndex,
            handicapOverride: playersTable.handicapOverride,
          })
            .from(playersTable)
            .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
            .where(and(
              eq(playersTable.id, target.playerId),
              eq(tournamentsTable.organizationId, orgId),
              eq(playersTable.userId, target.subjectUserId),
            ));
          playerRow = p;
        } else {
          const [p] = await tx.select({
            id: playersTable.id,
            handicapIndex: playersTable.handicapIndex,
            handicapOverride: playersTable.handicapOverride,
          })
            .from(playersTable)
            .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
            .where(and(
              eq(playersTable.userId, target.subjectUserId),
              eq(tournamentsTable.organizationId, orgId),
            ))
            .orderBy(desc(playersTable.id))
            .limit(1);
          playerRow = p;
        }
        if (!playerRow) {
          throw new Error("Cannot create adjustment: no player record found for the case subject in this organization");
        }

        const currentHi = playerRow.handicapOverride != null
          ? Number(playerRow.handicapOverride)
          : (playerRow.handicapIndex != null ? Number(playerRow.handicapIndex) : null);

        let resultingHi: number;
        let strokes: number;
        if (decision === "index_adjustment") {
          const s = Number(createAdjustment.adjustmentStrokes);
          strokes = s;
          resultingHi = Math.min(54.0, (currentHi ?? 0) + s);
        } else {
          const cap = Number(createAdjustment.capValue);
          resultingHi = cap;
          strokes = Math.max(0, cap - (currentHi ?? 0));
        }

        const [adj] = await tx.insert(handicapAdjustmentsTable).values({
          organizationId: orgId,
          playerId: playerRow.id,
          adjustedByUserId: req.user?.id ?? null,
          previousHandicapIndex: currentHi != null ? String(currentHi) : null,
          newHandicapIndex: String(resultingHi),
          adjustmentStrokes: String(strokes),
          adjustmentReason: `Committee decision (${decision}): ${rationale.trim()}`,
          committeeNotes: createAdjustment.notes ?? null,
          flagId: target.flagId ?? null,
        }).returning({ id: handicapAdjustmentsTable.id });
        resolvedAdjustmentId = adj.id;
        appliedPlayerId = playerRow.id;
        appliedPreviousHi = currentHi;
        appliedResultingHi = resultingHi;
      } else if (applyToPlayer && resolvedAdjustmentId != null) {
        // Re-load the existing adjustment under the tx so we can derive the
        // resulting HI to write to handicapOverride. Re-verifies tenant
        // isolation and that it belongs to the case subject.
        const [adj] = await tx.select({
          id: handicapAdjustmentsTable.id,
          playerId: handicapAdjustmentsTable.playerId,
          previousHandicapIndex: handicapAdjustmentsTable.previousHandicapIndex,
          newHandicapIndex: handicapAdjustmentsTable.newHandicapIndex,
        })
          .from(handicapAdjustmentsTable)
          .innerJoin(playersTable, eq(playersTable.id, handicapAdjustmentsTable.playerId))
          .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
          .where(and(
            eq(handicapAdjustmentsTable.id, resolvedAdjustmentId),
            eq(handicapAdjustmentsTable.organizationId, orgId),
            eq(tournamentsTable.organizationId, orgId),
            eq(playersTable.userId, target.subjectUserId),
          ));
        if (!adj) {
          throw new Error("applyToPlayer: linked adjustment is not for this case's subject in this organization");
        }
        appliedPlayerId = adj.playerId;
        appliedPreviousHi = adj.previousHandicapIndex != null ? Number(adj.previousHandicapIndex) : null;
        appliedResultingHi = Number(adj.newHandicapIndex);
      }

      // Optionally flow the resulting HI through to the player's effective
      // Handicap Index. For a soft_cap decision the override is only written
      // when the cap is actually binding (resulting HI strictly below the
      // current HI) — matching the WHS rule that the soft cap only takes
      // effect when the HI would otherwise exceed the cap. Hard caps and
      // index adjustments always apply.
      let appliedToPlayer = false;
      let skippedSoftCap = false;
      if (applyToPlayer && appliedPlayerId != null && appliedResultingHi != null) {
        const wouldExceedCap = appliedPreviousHi == null || appliedResultingHi < appliedPreviousHi;
        if (decision === "soft_cap" && !wouldExceedCap) {
          skippedSoftCap = true;
        } else {
          await tx.update(playersTable)
            .set({ handicapOverride: String(appliedResultingHi) })
            .where(eq(playersTable.id, appliedPlayerId));

          // Keep WHS state in sync so downstream surfaces (recap,
          // notifications, leaderboards) read the updated HI. Upsert so a
          // missing player-state row (e.g. player has never had a posted
          // round) still gets the committee-set HI recorded.
          await tx.insert(whsPlayerStateTable)
            .values({
              userId: target.subjectUserId,
              organizationId: orgId,
              currentHandicapIndex: String(appliedResultingHi),
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [whsPlayerStateTable.userId, whsPlayerStateTable.organizationId],
              set: {
                currentHandicapIndex: String(appliedResultingHi),
                updatedAt: new Date(),
              },
            });
          appliedToPlayer = true;
        }
      }

      // transitionStatus re-checks the case status under the same tx, so a
      // racing update that moves the case out of an eligible state will
      // throw and roll back the inserted adjustment.
      const updated = await transitionStatus(caseId, "decided", req.user?.id ?? null, {
        decision,
        rationale: rationale.trim(),
        adjustmentId: resolvedAdjustmentId,
      }, tx);

      if (appliedToPlayer || skippedSoftCap) {
        await appendAudit({
          caseId,
          action: appliedToPlayer ? "hi_applied" : "hi_apply_skipped",
          actorUserId: req.user?.id ?? null,
          payload: {
            decision,
            previousHandicapIndex: appliedPreviousHi,
            resultingHandicapIndex: appliedResultingHi,
            playerId: appliedPlayerId,
            skippedReason: skippedSoftCap ? "soft_cap_not_binding" : null,
          },
        }, tx);
      }

      return { updated, appliedToPlayer, skippedSoftCap, appliedResultingHi, appliedPreviousHi };
    });

    res.json({
      ...serializeCase(result.updated),
      hiApplied: result.appliedToPlayer,
      hiApplySkipped: result.skippedSoftCap,
      appliedHandicapIndex: result.appliedToPlayer ? result.appliedResultingHi : null,
      previousHandicapIndex: result.appliedPreviousHi,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* ─── POST /cases/:caseId/close ─────────────────────────────────── */
router.post("/cases/:caseId/close", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caseId = parseInt(String((req.params as Record<string, string>).caseId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const [target] = await db.select().from(handicapReviewCasesTable)
    .where(and(eq(handicapReviewCasesTable.id, caseId), eq(handicapReviewCasesTable.organizationId, orgId)));
  if (!target) { { res.status(404).json({ error: "Case not found" }); return; } }

  try {
    const updated = await transitionStatus(caseId, "closed", req.user?.id ?? null);
    res.json(serializeCase(updated));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* ─── POST /cases/:caseId/reopen ────────────────────────────────── */
router.post("/cases/:caseId/reopen", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caseId = parseInt(String((req.params as Record<string, string>).caseId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const [target] = await db.select().from(handicapReviewCasesTable)
    .where(and(eq(handicapReviewCasesTable.id, caseId), eq(handicapReviewCasesTable.organizationId, orgId)));
  if (!target) { { res.status(404).json({ error: "Case not found" }); return; } }

  try {
    const updated = await transitionStatus(caseId, "assigned", req.user?.id ?? null, {
      assigneeUserId: target.assigneeUserId ?? undefined,
    });
    res.json(serializeCase(updated));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* ─── POST /cases/generate-annual ───────────────────────────────── */
router.post("/cases/generate-annual", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const year = Number(req.body?.year ?? new Date().getUTCFullYear());
  if (!Number.isFinite(year)) { { res.status(400).json({ error: "year must be a number" }); return; } }

  const created = await generateAnnualReviewCases(orgId, year);
  res.json({ success: true, year, casesCreated: created });
});

/* ─── POST /cases/scan ──────────────────────────────────────────── */
router.post("/cases/scan", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireCommitteeMember(req, res, orgId)) return;

  const a = await generateCasesForExistingFlags(orgId).catch(() => 0);
  const b = await generateAnomalousScoreCases(orgId).catch(() => 0);
  const c = await generateScoreNotPostedCases(orgId).catch(() => 0);
  res.json({ success: true, fromFlags: a, anomalous: b, notPosted: c, total: a + b + c });
});

export default router;

/* ─── Player-facing portal sub-router ───────────────────────────── */
export const handicapCasesPortalRouter: IRouter = Router({ mergeParams: true });

/** GET /portal/handicap/my-cases — cases where the signed-in user is the subject. */
handicapCasesPortalRouter.get("/handicap/my-cases", async (req: Request, res: Response) => {
  if (!req.user?.id) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const rows = await db.select({
    c: handicapReviewCasesTable,
    orgName: organizationsTable.name,
  })
    .from(handicapReviewCasesTable)
    .leftJoin(organizationsTable, eq(handicapReviewCasesTable.organizationId, organizationsTable.id))
    .where(eq(handicapReviewCasesTable.subjectUserId, req.user.id))
    .orderBy(desc(handicapReviewCasesTable.updatedAt));

  // Attach audit log so the player handicap profile can render the full
  // chronology of committee actions affecting them.
  const caseIds = rows.map(r => r.c.id);
  const auditByCase: Record<number, Array<Record<string, unknown>>> = {};
  if (caseIds.length > 0) {
    const audit = await db.select({
      a: handicapCaseAuditLogTable,
      actorName: appUsersTable.displayName,
    })
      .from(handicapCaseAuditLogTable)
      .leftJoin(appUsersTable, eq(handicapCaseAuditLogTable.actorUserId, appUsersTable.id))
      .where(inArray(handicapCaseAuditLogTable.caseId, caseIds))
      .orderBy(desc(handicapCaseAuditLogTable.createdAt));
    for (const r of audit) {
      const arr = auditByCase[r.a.caseId] ?? (auditByCase[r.a.caseId] = []);
      arr.push({
        id: r.a.id,
        action: r.a.action,
        fromStatus: r.a.fromStatus,
        toStatus: r.a.toStatus,
        actorName: r.actorName,
        createdAt: r.a.createdAt.toISOString(),
      });
    }
  }

  res.json(rows.map(r => ({
    ...serializeCase(r.c),
    orgName: r.orgName,
    auditLog: auditByCase[r.c.id] ?? [],
  })));
});

/**
 * GET /portal/handicap/notifications — durable in-app notifications for the
 * signed-in player (subject of one or more committee review cases). Used to
 * populate the player's notifications inbox page. Each notification deep-links
 * back to /handicap-profile so the player can see the affected case in
 * context.
 *
 * Cursor pagination (Task #1685): the inbox screen pages older items in as
 * the user scrolls instead of downloading the entire backlog every time.
 *  - `limit`: page size (default 25, cap 100). Older callers that don't pass
 *    a `limit` get the small default page so heavily-used committee inboxes
 *    stay snappy on first render.
 *  - `before`: notification id cursor — return only notifications with
 *    `id < before`. We page on the auto-increment id (which is monotonic
 *    with createdAt for inserts via `defaultNow()`) so the cursor is small
 *    and unambiguous.
 *  - response.`nextCursor`: id of the last item in this page when the page
 *    is full (more may exist), otherwise `null`.
 *
 * `unreadCount` is always the user's total unread count and is independent
 * of the cursor — the inbox header uses it to render the "N new" badge
 * regardless of which page is currently loaded.
 */
handicapCasesPortalRouter.get("/handicap/notifications", async (req: Request, res: Response) => {
  if (!req.user?.id) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const requestedLimit = parseInt(String(req.query.limit ?? "25")) || 25;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const onlyUnread = req.query.unread === "1" || req.query.unread === "true";
  const beforeRaw = req.query.before;
  const beforeId = typeof beforeRaw === "string" && /^\d+$/.test(beforeRaw)
    ? parseInt(beforeRaw, 10)
    : null;

  const filters = [eq(handicapCaseNotificationsTable.subjectUserId, req.user.id)];
  if (onlyUnread) {
    filters.push(sql`${handicapCaseNotificationsTable.readAt} IS NULL`);
  }
  if (beforeId !== null) {
    filters.push(lt(handicapCaseNotificationsTable.id, beforeId));
  }

  const rows = await db.select({
    n: handicapCaseNotificationsTable,
    orgName: organizationsTable.name,
    caseStatus: handicapReviewCasesTable.status,
    caseKind: handicapReviewCasesTable.kind,
  })
    .from(handicapCaseNotificationsTable)
    .leftJoin(organizationsTable, eq(handicapCaseNotificationsTable.organizationId, organizationsTable.id))
    .leftJoin(handicapReviewCasesTable, eq(handicapCaseNotificationsTable.caseId, handicapReviewCasesTable.id))
    .where(and(...filters))
    .orderBy(desc(handicapCaseNotificationsTable.createdAt), desc(handicapCaseNotificationsTable.id))
    .limit(limit);

  const [unreadRow] = await db.select({ n: count() })
    .from(handicapCaseNotificationsTable)
    .where(and(
      eq(handicapCaseNotificationsTable.subjectUserId, req.user.id),
      sql`${handicapCaseNotificationsTable.readAt} IS NULL`,
    ));

  const items = rows.map(r => ({
    id: r.n.id,
    caseId: r.n.caseId,
    organizationId: r.n.organizationId,
    orgName: r.orgName,
    event: r.n.event,
    title: r.n.title,
    body: r.n.body,
    payload: r.n.payload,
    createdAt: r.n.createdAt.toISOString(),
    readAt: r.n.readAt?.toISOString() ?? null,
    caseStatus: r.caseStatus,
    caseKind: r.caseKind,
    // Committee-facing notifications (e.g. peer_responded) embed an
    // explicit deep link in the payload; subject-facing events fall back
    // to the player handicap profile page.
    deepLink: (r.n.payload && typeof (r.n.payload as { deepLink?: unknown }).deepLink === "string"
      ? (r.n.payload as { deepLink: string }).deepLink
      : "/handicap-profile"),
  }));

  // When the page is full, report the smallest id we returned as the
  // continuation cursor. The next request passes it back as `before`.
  // When the page is short, there are no more older items.
  const nextCursor = items.length === limit && items.length > 0
    ? items[items.length - 1].id
    : null;

  res.json({
    unreadCount: Number(unreadRow?.n ?? 0),
    items,
    nextCursor,
  });
});

/**
 * GET /portal/handicap/notifications/unread-count — lightweight count
 * endpoint used by the mobile home screen to render the committee inbox
 * badge without downloading the full notifications list. Returns just the
 * unread count and a `hasAny` flag (whether the user has any matching
 * notifications, read or unread) so the home screen can decide whether to
 * show the inbox entry at all.
 *
 * Optional `event` query param scopes both counts to a specific lifecycle
 * event (e.g. `event=peer_responded` for the committee inbox badge). When
 * omitted, all events are included.
 */
handicapCasesPortalRouter.get("/handicap/notifications/unread-count", async (req: Request, res: Response) => {
  if (!req.user?.id) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const eventParam = typeof req.query.event === "string" && req.query.event.trim() !== ""
    ? req.query.event.trim()
    : null;

  const baseFilters = [eq(handicapCaseNotificationsTable.subjectUserId, req.user.id)];
  if (eventParam) {
    baseFilters.push(eq(handicapCaseNotificationsTable.event, eventParam));
  }

  const [unreadRow] = await db.select({ n: count() })
    .from(handicapCaseNotificationsTable)
    .where(and(...baseFilters, sql`${handicapCaseNotificationsTable.readAt} IS NULL`));

  const [anyRow] = await db.select({ n: count() })
    .from(handicapCaseNotificationsTable)
    .where(and(...baseFilters))
    .limit(1);

  res.json({
    unreadCount: Number(unreadRow?.n ?? 0),
    hasAny: Number(anyRow?.n ?? 0) > 0,
  });
});

/** POST /portal/handicap/notifications/:id/read — mark a single notification read. */
handicapCasesPortalRouter.post("/handicap/notifications/:id/read", async (req: Request, res: Response) => {
  if (!req.user?.id) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "id required" }); return; } }
  const result = await db.update(handicapCaseNotificationsTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(handicapCaseNotificationsTable.id, id),
      eq(handicapCaseNotificationsTable.subjectUserId, req.user.id),
      sql`${handicapCaseNotificationsTable.readAt} IS NULL`,
    ))
    .returning({ id: handicapCaseNotificationsTable.id, organizationId: handicapCaseNotificationsTable.organizationId });
  if (result.length > 0) {
    void track("notification_opened", {
      notificationId: id,
      kind: "handicap_case",
      mode: "single",
    }, { organizationId: result[0].organizationId ?? null, userId: req.user.id });
  }
  res.json({ success: true, updated: result.length });
});

/** POST /portal/handicap/notifications/read-all — mark all of the signed-in user's notifications read. */
handicapCasesPortalRouter.post("/handicap/notifications/read-all", async (req: Request, res: Response) => {
  if (!req.user?.id) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const result = await db.update(handicapCaseNotificationsTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(handicapCaseNotificationsTable.subjectUserId, req.user.id),
      sql`${handicapCaseNotificationsTable.readAt} IS NULL`,
    ))
    .returning({ id: handicapCaseNotificationsTable.id });
  if (result.length > 0) {
    void track("notification_opened", {
      kind: "handicap_case",
      mode: "read_all",
      count: result.length,
    }, { userId: req.user.id });
  }
  res.json({ success: true, updated: result.length });
});

/**
 * GET /portal/handicap/my-peer-invites — outstanding peer-review invitations
 * for the signed-in reviewer. Excludes invitations that have already been
 * responded to or whose expiry has passed. Used by the mobile inbox so
 * reviewers can find pending requests after dismissing the push notification.
 */
handicapCasesPortalRouter.get("/handicap/my-peer-invites", async (req: Request, res: Response) => {
  if (!req.user?.id) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const now = new Date();
  const rows = await db.select({
    id: handicapCasePeerReviewsTable.id,
    token: handicapCasePeerReviewsTable.token,
    invitedAt: handicapCasePeerReviewsTable.invitedAt,
    seenAt: handicapCasePeerReviewsTable.seenAt,
    expiresAt: handicapCasePeerReviewsTable.expiresAt,
    caseId: handicapReviewCasesTable.id,
    caseKind: handicapReviewCasesTable.kind,
    caseStatus: handicapReviewCasesTable.status,
    periodLabel: handicapReviewCasesTable.periodLabel,
    subjectName: appUsersTable.displayName,
    orgName: organizationsTable.name,
  })
    .from(handicapCasePeerReviewsTable)
    .innerJoin(handicapReviewCasesTable, eq(handicapCasePeerReviewsTable.caseId, handicapReviewCasesTable.id))
    .leftJoin(appUsersTable, eq(handicapReviewCasesTable.subjectUserId, appUsersTable.id))
    .leftJoin(organizationsTable, eq(handicapReviewCasesTable.organizationId, organizationsTable.id))
    .where(and(
      eq(handicapCasePeerReviewsTable.reviewerUserId, req.user.id),
      isNull(handicapCasePeerReviewsTable.respondedAt),
      or(isNull(handicapCasePeerReviewsTable.expiresAt), gt(handicapCasePeerReviewsTable.expiresAt, now)),
    ))
    .orderBy(desc(handicapCasePeerReviewsTable.invitedAt));

  res.json(rows.map(r => ({
    id: r.id,
    token: r.token,
    invitedAt: r.invitedAt.toISOString(),
    seenAt: r.seenAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    caseId: r.caseId,
    caseKind: r.caseKind,
    caseStatus: r.caseStatus,
    periodLabel: r.periodLabel,
    subjectName: r.subjectName,
    orgName: r.orgName,
  })));
});

/**
 * POST /portal/handicap/peer-invites/:id/seen — mark a peer-review invitation
 * as seen by the invited reviewer (Task #745). Idempotent: only stamps
 * `seen_at` the first time it's called and only if the signed-in user is the
 * actual reviewer for that invitation. Does NOT touch `responded_at`, which
 * still flips only when the reviewer submits a recommendation.
 */
handicapCasesPortalRouter.post("/handicap/peer-invites/:id/seen", async (req: Request, res: Response) => {
  if (!req.user?.id) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "id required" }); return; } }
  const result = await db.update(handicapCasePeerReviewsTable)
    .set({ seenAt: new Date() })
    .where(and(
      eq(handicapCasePeerReviewsTable.id, id),
      eq(handicapCasePeerReviewsTable.reviewerUserId, req.user.id),
      isNull(handicapCasePeerReviewsTable.seenAt),
    ))
    .returning({ id: handicapCasePeerReviewsTable.id });
  res.json({ success: true, updated: result.length });
});
