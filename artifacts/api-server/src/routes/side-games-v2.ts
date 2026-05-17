/**
 * Side Games v2 — instances, templates, standings, settlements.
 *
 * Mounted at /api  — endpoints:
 *
 *   GET    /side-game-templates?organizationId=&leagueId=
 *   POST   /side-game-templates
 *   PUT    /side-game-templates/:id
 *   DELETE /side-game-templates/:id
 *
 *   GET    /side-game-instances?tournamentId=&round=
 *          &leagueRoundId=&generalPlayRoundId=
 *   POST   /side-game-instances
 *   GET    /side-game-instances/:id
 *   PUT    /side-game-instances/:id            (rules / events / status)
 *   DELETE /side-game-instances/:id
 *
 *   GET    /side-game-instances/:id/standings  (live computation)
 *   POST   /side-game-instances/:id/settle     (compute & persist settlements)
 *   POST   /side-game-settlements/:id/pay      (mark a settlement paid)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  sideGameInstancesTable,
  sideGameTemplatesTable,
  sideGameSettlementsTable,
  scoresTable,
  generalPlayHoleScoresTable,
  generalPlayRoundsTable,
  playersTable,
  tournamentsTable,
  leagueRoundsTable,
  leaguesTable,
  holeDetailsTable,
  coursesTable,
  clubWalletsTable,
  clubWalletTxnsTable,
  walletPayoutAccountsTable,
  walletPayoutAccountHistoryTable,
  clubWalletWithdrawalsTable,
  appUsersTable,
  organizationsTable,
  walletTopupRefundEmailSchedulesTable,
  walletTopupRefundEmailRunsTable,
  type WalletTopupRefundEmailRunPausedRecipient,
  type WalletTopupRefundEmailRunRecipientLanguage,
  walletTopupRequestsTable,
  walletWithdrawalNotifyAttemptsTable,
  walletTopupRefundNotifyAttemptsTable,
  sideGameSettlementReceiptAttemptsTable,
  sideGameReceiptDigestSchedulesTable,
  sideGameReceiptDigestRunsTable,
  type SideGameReceiptDigestRunPausedRecipient,
  emailSuppressionsTable,
  orgMembershipsTable,
  clubMembersTable,
} from "@workspace/db";
import { aliasedTable, and, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import {
  computeStandings,
  isGameType,
  type Participant,
  type ScoreEntry,
  type GameType,
} from "../lib/sideGames";
import { computePlayingHandicap, strokesOnHole, effectiveHandicapIndex } from "../lib/handicap";
import { getRazorpayClient, getRazorpayKeyId, verifyPaymentSignature, createRazorpayContact, createRazorpayFundAccount } from "../lib/razorpay";
import { verifyRazorpayPayoutAccount } from "../lib/razorpayPayoutVerify";
import { reverifyOneWalletAccount } from "../lib/walletReverifyPayouts";
import { recordWalletAdminReverifyHistory } from "../lib/walletPayoutAccountReverifyAudit";
import { logger } from "../lib/logger";
import { notifySettlementPaid } from "../lib/sideGameSettlementPaidNotify";
import { notifyWalletTopupAutoRefunded } from "../lib/walletTopupRefundNotify";
import { translateWalletTopupRefundCsvHeaders } from "../lib/walletTopupRefundDigestI18n";
import {
  isSupportedWalletTopupRefundDigestLang,
  resolveWalletTopupRefundDigestLang,
  WALLET_TOPUP_REFUND_DIGEST_LANGS,
} from "../lib/walletTopupRefundDigestI18n";
import { resolveSideGameReceiptDigestLang } from "../lib/sideGameReceiptDigestI18n";
import {
  checkWithdrawalLimits,
  debitWalletForWithdrawal,
  dispatchWalletWithdrawal,
  refundWithdrawal,
  MIN_WITHDRAWAL_INR,
  MAX_WITHDRAWAL_PER_TXN_INR,
  MAX_WITHDRAWAL_DAILY_INR,
} from "../lib/walletPayouts";
import { retryExhaustedWalletWithdrawalAttempt } from "../lib/walletWithdrawalNotify";
import {
  checkAndConsume,
  walletTopupRefundSendPreviewScopes,
  WALLET_TOPUP_REFUND_SEND_PREVIEW_COOLDOWN_SECONDS,
  walletTopupRefundSendNowScopes,
  WALLET_TOPUP_REFUND_SEND_NOW_COOLDOWN_SECONDS,
} from "../lib/publicRateLimit";

const router: IRouter = Router();

function getUserId(req: Request): number | null {
  const u = (req as unknown as { user?: { id?: number; userId?: number }; portalUser?: { userId?: number } });
  return u.user?.id ?? u.user?.userId ?? u.portalUser?.userId ?? null;
}

function isOrgAdmin(req: Request): boolean {
  const role = (req as unknown as { user?: { role?: string } }).user?.role;
  return ["super_admin", "org_admin", "tournament_director"].includes(role ?? "");
}

// ─── Templates ──────────────────────────────────────────────────────────

router.get("/side-game-templates", async (req: Request, res: Response) => {
  const orgId = req.query.organizationId ? Number(req.query.organizationId) : null;
  const leagueId = req.query.leagueId ? Number(req.query.leagueId) : null;
  if (!orgId) { { res.status(400).json({ error: "organizationId is required" }); return; } }

  const conds = [eq(sideGameTemplatesTable.organizationId, orgId)];
  if (leagueId) conds.push(eq(sideGameTemplatesTable.leagueId, leagueId));
  const rows = await db.select().from(sideGameTemplatesTable)
    .where(and(...conds))
    .orderBy(sideGameTemplatesTable.name);
  res.json(rows);
});

router.post("/side-game-templates", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const { organizationId, leagueId, name, gameType, rules, stake, currency } = req.body ?? {};
  if (!organizationId || !name || !isGameType(gameType)) {
    res.status(400).json({ error: "organizationId, name, and a valid gameType are required" });
    return;
  }
  const [row] = await db.insert(sideGameTemplatesTable).values({
    organizationId: Number(organizationId),
    leagueId: leagueId ? Number(leagueId) : null,
    name,
    gameType,
    rules: rules ?? {},
    stake: stake != null ? String(stake) : null,
    currency: currency ?? "INR",
    createdByUserId: userId,
  }).returning();
  res.status(201).json(row);
});

router.put("/side-game-templates/:id", async (req: Request, res: Response) => {
  const id = Number((req.params as Record<string, string>).id);
  const { name, rules, stake, currency } = req.body ?? {};
  const [row] = await db.update(sideGameTemplatesTable).set({
    ...(name ? { name } : {}),
    ...(rules ? { rules } : {}),
    ...(stake !== undefined ? { stake: stake != null ? String(stake) : null } : {}),
    ...(currency !== undefined ? { currency } : {}),
    updatedAt: new Date(),
  }).where(eq(sideGameTemplatesTable.id, id)).returning();
  if (!row) { { res.status(404).json({ error: "Template not found" }); return; } }
  res.json(row);
});

router.delete("/side-game-templates/:id", async (req: Request, res: Response) => {
  const id = Number((req.params as Record<string, string>).id);
  const deleted = await db.delete(sideGameTemplatesTable)
    .where(eq(sideGameTemplatesTable.id, id))
    .returning({ id: sideGameTemplatesTable.id });
  if (deleted.length === 0) { { res.status(404).json({ error: "Template not found" }); return; } }
  res.json({ deleted: true });
});

// ─── Instances ──────────────────────────────────────────────────────────

router.get("/side-game-instances", async (req: Request, res: Response) => {
  const tournamentId = req.query.tournamentId ? Number(req.query.tournamentId) : null;
  const round = req.query.round ? Number(req.query.round) : null;
  const leagueRoundId = req.query.leagueRoundId ? Number(req.query.leagueRoundId) : null;
  const generalPlayRoundId = req.query.generalPlayRoundId ? Number(req.query.generalPlayRoundId) : null;

  const conds = [];
  if (tournamentId) conds.push(eq(sideGameInstancesTable.tournamentId, tournamentId));
  if (round) conds.push(eq(sideGameInstancesTable.round, round));
  if (leagueRoundId) conds.push(eq(sideGameInstancesTable.leagueRoundId, leagueRoundId));
  if (generalPlayRoundId) conds.push(eq(sideGameInstancesTable.generalPlayRoundId, generalPlayRoundId));
  if (conds.length === 0) {
    res.status(400).json({ error: "Provide at least one of tournamentId, leagueRoundId, generalPlayRoundId" });
    return;
  }

  const rows = await db.select().from(sideGameInstancesTable)
    .where(and(...conds))
    .orderBy(sideGameInstancesTable.createdAt);
  res.json(rows);
});

router.post("/side-game-instances", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const {
    organizationId, tournamentId, leagueRoundId, generalPlayRoundId,
    round, gameType, name, rules, events, stake, currency,
    participantPlayerIds, participantUserIds, participantNames, templateId,
  } = req.body ?? {};

  if (!organizationId || !isGameType(gameType)) {
    res.status(400).json({ error: "organizationId and a valid gameType are required" });
    return;
  }
  const scopes = [tournamentId, leagueRoundId, generalPlayRoundId].filter(v => v != null);
  if (scopes.length !== 1) {
    res.status(400).json({ error: "Provide exactly one of tournamentId, leagueRoundId, generalPlayRoundId" });
    return;
  }

  // If templateId is provided, copy its rules/stake/currency as defaults.
  let resolvedRules = rules ?? {};
  let resolvedStake = stake;
  let resolvedCurrency = currency;
  if (templateId) {
    const [tpl] = await db.select().from(sideGameTemplatesTable).where(eq(sideGameTemplatesTable.id, Number(templateId)));
    if (tpl && tpl.gameType === gameType) {
      resolvedRules = { ...(tpl.rules ?? {}), ...(rules ?? {}) };
      resolvedStake = stake ?? (tpl.stake ?? null);
      resolvedCurrency = currency ?? (tpl.currency ?? "INR");
    }
  }

  const [row] = await db.insert(sideGameInstancesTable).values({
    organizationId: Number(organizationId),
    tournamentId: tournamentId ? Number(tournamentId) : null,
    leagueRoundId: leagueRoundId ? Number(leagueRoundId) : null,
    generalPlayRoundId: generalPlayRoundId ? Number(generalPlayRoundId) : null,
    round: round ? Number(round) : 1,
    gameType,
    name: name ?? null,
    rules: resolvedRules,
    events: events ?? {},
    stake: resolvedStake != null ? String(resolvedStake) : null,
    currency: resolvedCurrency ?? "INR",
    participantPlayerIds: Array.isArray(participantPlayerIds) ? participantPlayerIds.map(Number) : [],
    participantUserIds: Array.isArray(participantUserIds) ? participantUserIds.map(Number) : [],
    participantNames: participantNames ?? {},
    createdByUserId: userId,
  }).returning();
  res.status(201).json(row);
});

router.get("/side-game-instances/:id", async (req: Request, res: Response) => {
  const id = Number((req.params as Record<string, string>).id);
  const [row] = await db.select().from(sideGameInstancesTable).where(eq(sideGameInstancesTable.id, id));
  if (!row) { { res.status(404).json({ error: "Instance not found" }); return; } }
  const settlements = await db.select().from(sideGameSettlementsTable)
    .where(eq(sideGameSettlementsTable.instanceId, id))
    .orderBy(sideGameSettlementsTable.createdAt);
  // Enrich with fromUserId/toUserId so clients can show "Pay now" only to
  // the player who actually owes the debt (matched against /portal/me.id).
  const playerIds = Array.from(new Set(
    settlements.flatMap(s => [s.fromPlayerId, s.toPlayerId]).filter((p): p is number => p != null),
  ));
  const userIdByPlayer = new Map<number, number | null>();
  if (playerIds.length > 0) {
    const players = await db.select({ id: playersTable.id, userId: playersTable.userId })
      .from(playersTable)
      .where(inArray(playersTable.id, playerIds));
    for (const p of players) userIdByPlayer.set(p.id, p.userId ?? null);
  }
  // Task #1841 — fold in per-settlement notify state from the receipt
  // attempts table so the "Email retrying — next try in 2m 14s" /
  // "gave up X ago" badges added in Task #1499 to wallet-withdrawal rows
  // can render the same countdown on side-game settlement receipts.
  // Keyed by settlementId — the recipient is fixed per settlement so
  // there is at most one attempts row.
  const settlementIds = settlements.map(s => s.id);
  const receiptAttemptRows = settlementIds.length > 0
    ? await db.select().from(sideGameSettlementReceiptAttemptsTable)
        .where(inArray(sideGameSettlementReceiptAttemptsTable.settlementId, settlementIds))
    : [];
  const receiptBySettlement = new Map<number, typeof sideGameSettlementReceiptAttemptsTable.$inferSelect>();
  for (const r of receiptAttemptRows) receiptBySettlement.set(r.settlementId, r);
  const enriched = settlements.map(s => {
    const att = receiptBySettlement.get(s.id) ?? null;
    return {
      ...s,
      fromUserId: s.fromPlayerId != null ? (userIdByPlayer.get(s.fromPlayerId) ?? null) : null,
      toUserId: s.toPlayerId != null ? (userIdByPlayer.get(s.toPlayerId) ?? null) : null,
      notify: serializeReceiptNotify(att),
    };
  });
  res.json({ instance: row, settlements: enriched });
});

router.put("/side-game-instances/:id", async (req: Request, res: Response) => {
  const id = Number((req.params as Record<string, string>).id);
  const { name, rules, events, stake, currency, participantPlayerIds, participantUserIds, participantNames, status } = req.body ?? {};

  // ── Wolf-pick / Nassau-press authorization ─────────────────────────
  // Live capture controls in the mobile group share the same panel, so we
  // server-validate that the caller is actually the wolf for the affected
  // hole (wolf picks) or a member of the team that called the press
  // (Nassau presses). Org admins / tournament directors bypass these
  // checks so they can correct mistakes after the fact.
  if (events !== undefined && !isOrgAdmin(req)) {
    const userId = getUserId(req);
    if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
    const [existing] = await db.select().from(sideGameInstancesTable).where(eq(sideGameInstancesTable.id, id));
    if (!existing) { { res.status(404).json({ error: "Instance not found" }); return; } }

    const denial = await validateLiveEventAuthorization(existing, events, userId);
    if (denial) { { res.status(403).json({ error: denial }); return; } }
  }

  const [row] = await db.update(sideGameInstancesTable).set({
    ...(name !== undefined ? { name } : {}),
    ...(rules !== undefined ? { rules } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(stake !== undefined ? { stake: stake != null ? String(stake) : null } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(participantPlayerIds !== undefined ? { participantPlayerIds: Array.isArray(participantPlayerIds) ? participantPlayerIds.map(Number) : [] } : {}),
    ...(participantUserIds !== undefined ? { participantUserIds: Array.isArray(participantUserIds) ? participantUserIds.map(Number) : [] } : {}),
    ...(participantNames !== undefined ? { participantNames } : {}),
    ...(status !== undefined ? { status } : {}),
    updatedAt: new Date(),
  }).where(eq(sideGameInstancesTable.id, id)).returning();
  if (!row) { { res.status(404).json({ error: "Instance not found" }); return; } }
  res.json(row);
});

router.delete("/side-game-instances/:id", async (req: Request, res: Response) => {
  const id = Number((req.params as Record<string, string>).id);
  const deleted = await db.delete(sideGameInstancesTable)
    .where(eq(sideGameInstancesTable.id, id))
    .returning({ id: sideGameInstancesTable.id });
  if (deleted.length === 0) { { res.status(404).json({ error: "Instance not found" }); return; } }
  res.json({ deleted: true });
});

// ─── Live event authorization (wolf picks / Nassau presses) ────────────

interface WolfPickEvent { hole: number; mode: "partner" | "lone" | "blind"; partnerPlayerId?: number | null }
interface NassauPressEvent { hole: number; calledByTeam: "A" | "B"; segment: "front" | "back" | "total" }

function pickKey(p: WolfPickEvent): string { return `${p.hole}|${p.mode}|${p.partnerPlayerId ?? ""}`; }
function pressKey(p: NassauPressEvent): string { return `${p.hole}|${p.calledByTeam}|${p.segment}`; }

/**
 * Resolve the (playerId → userId) map for the players this instance cares
 * about. For tournament/league scopes that's a lookup against playersTable.
 * For general-play scopes the engine aliases userId into the playerId
 * namespace, so the map is the identity.
 */
async function resolveUserIdByPlayer(instance: typeof sideGameInstancesTable.$inferSelect, playerIds: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  if (playerIds.length === 0) return out;
  if (instance.generalPlayRoundId) {
    for (const pid of playerIds) out.set(pid, pid);
    return out;
  }
  const rows = await db.select({ id: playersTable.id, userId: playersTable.userId })
    .from(playersTable).where(inArray(playersTable.id, playerIds));
  for (const r of rows) out.set(r.id, r.userId ?? null);
  return out;
}

/** Player order used to assign the wolf to a hole. Mirrors the mobile fallback. */
function wolfOrderFor(instance: typeof sideGameInstancesTable.$inferSelect): number[] {
  const rules = (instance.rules ?? {}) as { wolfOrder?: number[] };
  if (Array.isArray(rules.wolfOrder) && rules.wolfOrder.length > 0) return rules.wolfOrder.map(Number);
  if (instance.generalPlayRoundId) return (instance.participantUserIds ?? []).map(Number);
  return (instance.participantPlayerIds ?? []).map(Number);
}

/**
 * Returns null when the events delta is allowed for `userId`, otherwise an
 * error message describing why the request is rejected.
 */
async function validateLiveEventAuthorization(
  instance: typeof sideGameInstancesTable.$inferSelect,
  incoming: { picks?: WolfPickEvent[]; presses?: NassauPressEvent[] },
  userId: number,
): Promise<string | null> {
  const prev = (instance.events ?? {}) as { picks?: WolfPickEvent[]; presses?: NassauPressEvent[] };

  // ── Wolf picks ────────────────────────────────────────────────────
  // We always run this check for wolf instances (even when `incoming.picks`
  // is missing) because writing the events object replaces it wholesale —
  // a payload like `events: {}` would otherwise silently wipe existing
  // picks without authorization.
  if (instance.gameType === "wolf") {
    const prevPicks = prev.picks ?? [];
    const newPicks = incoming.picks ?? [];
    const prevByHole = new Map(prevPicks.map(p => [p.hole, p]));
    const newByHole = new Map(newPicks.map(p => [p.hole, p]));
    const affectedHoles = new Set<number>();
    for (const np of newPicks) {
      const old = prevByHole.get(np.hole);
      if (!old || pickKey(old) !== pickKey(np)) affectedHoles.add(np.hole);
    }
    for (const op of prevPicks) {
      if (!newByHole.has(op.hole)) affectedHoles.add(op.hole);
    }
    if (affectedHoles.size > 0) {
      const order = wolfOrderFor(instance);
      if (order.length === 0) return "Wolf order is not configured; cannot validate pick.";
      const wolfPlayerIds = [...affectedHoles].map(h => order[(h - 1) % order.length]);
      const userIdByPlayer = await resolveUserIdByPlayer(instance, wolfPlayerIds);
      for (const hole of affectedHoles) {
        const wolfPlayerId = order[(hole - 1) % order.length];
        const wolfUserId = userIdByPlayer.get(wolfPlayerId) ?? null;
        if (wolfUserId !== userId) {
          return `Only the wolf for hole ${hole} can record or change this pick.`;
        }
      }
    }
  }

  // ── Nassau presses ────────────────────────────────────────────────
  // Always run for nassau instances so that an `events: {}` (or a payload
  // missing the `presses` array) cannot silently wipe presses past the
  // team-membership check.
  if (instance.gameType === "nassau") {
    const prevPresses = prev.presses ?? [];
    const newPresses = incoming.presses ?? [];
    const prevSet = new Set(prevPresses.map(pressKey));
    const newSet = new Set(newPresses.map(pressKey));
    const added = newPresses.filter(p => !prevSet.has(pressKey(p)));
    const removed = prevPresses.filter(p => !newSet.has(pressKey(p)));
    const changed = [...added, ...removed];
    if (changed.length > 0) {
      const rules = (instance.rules ?? {}) as { teamA?: number[]; teamB?: number[] };
      const teamA = (rules.teamA ?? []).map(Number);
      const teamB = (rules.teamB ?? []).map(Number);
      if (teamA.length === 0 && teamB.length === 0) return "Nassau teams are not configured; cannot validate press.";
      const allTeamPlayerIds = [...teamA, ...teamB];
      const userIdByPlayer = await resolveUserIdByPlayer(instance, allTeamPlayerIds);
      const myPlayerIds = allTeamPlayerIds.filter(pid => (userIdByPlayer.get(pid) ?? null) === userId);
      const myTeams = new Set<"A" | "B">();
      for (const pid of myPlayerIds) {
        if (teamA.includes(pid)) myTeams.add("A");
        if (teamB.includes(pid)) myTeams.add("B");
      }
      for (const press of changed) {
        if (!myTeams.has(press.calledByTeam)) {
          return `Only Team ${press.calledByTeam} members can call or remove a Team ${press.calledByTeam} press.`;
        }
      }
    }
  }

  return null;
}

// ─── Score loaders (per scope) ──────────────────────────────────────────

interface LoadedRound {
  participants: Participant[];
  scores: ScoreEntry[];
}

async function loadTournamentRound(tournamentId: number, round: number, instance: typeof sideGameInstancesTable.$inferSelect): Promise<LoadedRound> {
  const wantedIds = (instance.participantPlayerIds ?? []).map(Number);
  const players = wantedIds.length > 0
    ? await db.select().from(playersTable).where(and(eq(playersTable.tournamentId, tournamentId), inArray(playersTable.id, wantedIds)))
    : await db.select().from(playersTable).where(eq(playersTable.tournamentId, tournamentId));

  const [tournament] = await db.select({
    courseId: tournamentsTable.courseId,
    handicapAllowance: tournamentsTable.handicapAllowance,
  }).from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));

  let coursePar = 72, courseSlope: number | undefined, courseRating: number | undefined;
  let holes: { holeNumber: number; par: number; handicap: number | null }[] = [];
  if (tournament?.courseId) {
    const [course] = await db.select({ par: coursesTable.par, slope: coursesTable.slope, rating: coursesTable.rating })
      .from(coursesTable).where(eq(coursesTable.id, tournament.courseId));
    coursePar = course?.par ?? 72;
    courseSlope = course?.slope ?? undefined;
    courseRating = course?.rating ? Number(course.rating) : undefined;
    holes = await db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par, handicap: holeDetailsTable.handicap })
      .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)).orderBy(holeDetailsTable.holeNumber);
  }
  const allowance = tournament?.handicapAllowance ?? 100;

  const playerIds = players.map(p => p.id);
  const scoreRows = playerIds.length > 0
    ? await db.select().from(scoresTable).where(and(
        eq(scoresTable.tournamentId, tournamentId),
        eq(scoresTable.round, round),
        inArray(scoresTable.playerId, playerIds),
      ))
    : [];

  const participants: Participant[] = players.map(p => {
    const hi = effectiveHandicapIndex(p.handicapIndex, p.handicapOverride);
    const ph = computePlayingHandicap(hi, courseSlope, courseRating, coursePar, allowance);
    return {
      playerId: p.id,
      name: `${p.firstName} ${p.lastName}`,
      userId: p.userId,
      courseHandicap: ph,
    };
  });

  const scores: ScoreEntry[] = scoreRows.map(s => {
    const hole = holes.find(h => h.holeNumber === s.holeNumber);
    const p = participants.find(pp => pp.playerId === s.playerId);
    const handicapStrokes = (hole && p?.courseHandicap != null)
      ? strokesOnHole(hole.handicap, p.courseHandicap)
      : 0;
    return {
      playerId: s.playerId,
      holeNumber: s.holeNumber,
      strokes: s.strokes,
      putts: s.putts,
      par: hole?.par ?? null,
      strokeIndex: hole?.handicap ?? null,
      handicapStrokes,
    };
  });

  return { participants, scores };
}

async function loadGeneralPlayRound(generalPlayRoundId: number, instance: typeof sideGameInstancesTable.$inferSelect): Promise<LoadedRound> {
  const [round] = await db.select().from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, generalPlayRoundId));
  if (!round) return { participants: [], scores: [] };

  // For general play, participants are individual users (no playersTable rows).
  // We use the instance's participantUserIds + participantNames to drive the engine.
  const participantUserIds = (instance.participantUserIds ?? []).map(Number);
  const names = instance.participantNames ?? {};
  // The general-play round itself only has scores for round.userId.  Other
  // group members must have their own GP rounds; we surface only the host's
  // scores for now (the engine still works with one-player edge cases).
  const participants: Participant[] = participantUserIds.length > 0
    ? participantUserIds.map(uid => ({
        playerId: uid,  // userId aliased into playerId namespace for the engine
        name: names[String(uid)] ?? `User ${uid}`,
        userId: uid,
        courseHandicap: null,
      }))
    : [{ playerId: round.userId, name: names[String(round.userId)] ?? `User ${round.userId}`, userId: round.userId, courseHandicap: null }];

  const holes = await db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par, handicap: holeDetailsTable.handicap })
    .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, round.courseId)).orderBy(holeDetailsTable.holeNumber);

  const hostScores = await db.select().from(generalPlayHoleScoresTable).where(eq(generalPlayHoleScoresTable.roundId, generalPlayRoundId));
  const scores: ScoreEntry[] = hostScores.map(s => ({
    playerId: round.userId,
    holeNumber: s.holeNumber,
    strokes: s.strokes,
    putts: s.putts,
    par: s.par ?? holes.find(h => h.holeNumber === s.holeNumber)?.par ?? null,
    strokeIndex: s.strokeIndex ?? holes.find(h => h.holeNumber === s.holeNumber)?.handicap ?? null,
    handicapStrokes: 0,
  }));

  return { participants, scores };
}

async function loadLeagueRound(leagueRoundId: number, instance: typeof sideGameInstancesTable.$inferSelect): Promise<LoadedRound> {
  const [lr] = await db.select().from(leagueRoundsTable).where(eq(leagueRoundsTable.id, leagueRoundId));
  if (!lr || !lr.tournamentId) return { participants: [], scores: [] };
  // Reuse the tournament loader against the linked tournament (round 1 of it).
  return loadTournamentRound(lr.tournamentId, 1, instance);
}

async function loadInstanceData(instance: typeof sideGameInstancesTable.$inferSelect): Promise<LoadedRound> {
  if (instance.tournamentId) return loadTournamentRound(instance.tournamentId, instance.round, instance);
  if (instance.generalPlayRoundId) return loadGeneralPlayRound(instance.generalPlayRoundId, instance);
  if (instance.leagueRoundId) return loadLeagueRound(instance.leagueRoundId, instance);
  return { participants: [], scores: [] };
}

// ─── Standings (live computation) ───────────────────────────────────────

router.get("/side-game-instances/:id/standings", async (req: Request, res: Response) => {
  const id = Number((req.params as Record<string, string>).id);
  const [instance] = await db.select().from(sideGameInstancesTable).where(eq(sideGameInstancesTable.id, id));
  if (!instance) { { res.status(404).json({ error: "Instance not found" }); return; } }

  const { participants, scores } = await loadInstanceData(instance);
  const standings = computeStandings(
    instance.gameType as GameType,
    participants,
    scores,
    instance.rules ?? {},
    instance.events ?? {},
  );

  // Multiply net by stake (if a numeric stake is configured) so settlements are in money units.
  const stake = instance.stake != null ? Number(instance.stake) : 1;
  if (stake !== 1) {
    for (const p of standings.perPlayer) p.net = Math.round(p.net * stake * 100) / 100;
    for (const s of standings.settlements) s.amount = Math.round(s.amount * stake * 100) / 100;
  }

  res.json({
    instance,
    standings,
    currency: instance.currency ?? "INR",
    stake,
    holesScored: [...new Set(scores.map(s => s.holeNumber))].length,
  });
});

// ─── Settle (compute and persist owed rows) ─────────────────────────────

router.post("/side-game-instances/:id/settle", async (req: Request, res: Response) => {
  const id = Number((req.params as Record<string, string>).id);
  const [instance] = await db.select().from(sideGameInstancesTable).where(eq(sideGameInstancesTable.id, id));
  if (!instance) { { res.status(404).json({ error: "Instance not found" }); return; } }

  const { participants, scores } = await loadInstanceData(instance);
  const standings = computeStandings(
    instance.gameType as GameType,
    participants,
    scores,
    instance.rules ?? {},
    instance.events ?? {},
  );
  const stake = instance.stake != null ? Number(instance.stake) : 1;

  // Wipe any prior PENDING settlements (keep paid ones) and re-insert.
  await db.delete(sideGameSettlementsTable).where(and(
    eq(sideGameSettlementsTable.instanceId, id),
    eq(sideGameSettlementsTable.status, "pending"),
  ));

  const inserts = standings.settlements.map(s => ({
    instanceId: id,
    fromPlayerId: s.fromPlayerId,
    fromName: s.fromName,
    toPlayerId: s.toPlayerId,
    toName: s.toName,
    amount: String(Math.round(s.amount * stake * 100) / 100),
    currency: instance.currency ?? "INR",
    status: "pending" as const,
  }));
  const inserted = inserts.length > 0
    ? await db.insert(sideGameSettlementsTable).values(inserts).returning()
    : [];

  await db.update(sideGameInstancesTable).set({ status: "completed", updatedAt: new Date() })
    .where(eq(sideGameInstancesTable.id, id));

  res.json({ standings, settlements: inserted });
});

// ─── Mark a settlement paid ─────────────────────────────────────────────

router.post("/side-game-settlements/:id/pay", async (req: Request, res: Response) => {
  const id = Number((req.params as Record<string, string>).id);
  const { paymentMethod, paymentRef } = req.body ?? {};
  if (!paymentMethod) { { res.status(400).json({ error: "paymentMethod is required" }); return; } }
  // Gate the update on status='pending' so retries / double-clicks do not
  // re-stamp paidAt or re-fire the recipient notification (Task #614).
  const [row] = await db.update(sideGameSettlementsTable).set({
    status: "paid",
    paymentMethod,
    paymentRef: paymentRef ?? null,
    paidAt: new Date(),
    updatedAt: new Date(),
  })
    .where(and(
      eq(sideGameSettlementsTable.id, id),
      eq(sideGameSettlementsTable.status, "pending"),
    ))
    .returning();
  if (!row) {
    // Either the settlement doesn't exist or it's already paid/cancelled —
    // re-read so the caller sees the current row without us firing a
    // duplicate notification.
    const [existing] = await db.select().from(sideGameSettlementsTable)
      .where(eq(sideGameSettlementsTable.id, id));
    if (!existing) { { res.status(404).json({ error: "Settlement not found" }); return; } }
    res.json(existing);
    return;
  }
  // Fire-and-forget recipient notification on the actual pending->paid
  // transition we just performed (Task #614).
  notifySettlementPaid(id).catch((err) => {
    logger.warn({ err, settlementId: id }, "[side-games-v2] settlement-paid notify failed");
  });
  res.json(row);
});

// ─── SETTLE-UP PAYMENT FLOW (Task #455) ────────────────────────────────
//
// Each pending settlement row gets a "Pay now" action. Two channels:
//
//   1. Razorpay UPI / cards: client calls /pay-order to mint an order,
//      runs Checkout, then calls /pay-verify (or the
//      /api/webhooks/razorpay-side-game-settlement webhook fires) to
//      mark the settlement paid and credit the recipient's club wallet.
//
//   2. Club wallet: /pay-wallet debits the payer's wallet and credits
//      the recipient's wallet atomically, no external network hop.
//
// The current user is matched to settlement.fromPlayerId via
// players.user_id — so a settlement is only payable by the player who
// actually owes the debt (or by an org admin).

interface SettlementContext {
  settlement: typeof sideGameSettlementsTable.$inferSelect;
  instance: typeof sideGameInstancesTable.$inferSelect;
  fromUserId: number | null;
  toUserId: number | null;
}

async function loadSettlementContext(settlementId: number): Promise<SettlementContext | null> {
  const [row] = await db.select({
    settlement: sideGameSettlementsTable,
    instance: sideGameInstancesTable,
  })
    .from(sideGameSettlementsTable)
    .innerJoin(sideGameInstancesTable, eq(sideGameInstancesTable.id, sideGameSettlementsTable.instanceId))
    .where(eq(sideGameSettlementsTable.id, settlementId));
  if (!row) return null;
  const playerIds = [row.settlement.fromPlayerId, row.settlement.toPlayerId].filter((p): p is number => p != null);
  let fromUserId: number | null = null;
  let toUserId: number | null = null;
  if (playerIds.length > 0) {
    const players = await db.select({ id: playersTable.id, userId: playersTable.userId })
      .from(playersTable)
      .where(inArray(playersTable.id, playerIds));
    for (const p of players) {
      if (p.id === row.settlement.fromPlayerId) fromUserId = p.userId ?? null;
      if (p.id === row.settlement.toPlayerId) toUserId = p.userId ?? null;
    }
  }
  return { settlement: row.settlement, instance: row.instance, fromUserId, toUserId };
}

/** Insert-or-fetch the (org, user, currency) wallet row. */
async function getOrCreateWallet(organizationId: number, userId: number, currency: string) {
  const [existing] = await db.select().from(clubWalletsTable).where(and(
    eq(clubWalletsTable.organizationId, organizationId),
    eq(clubWalletsTable.userId, userId),
    eq(clubWalletsTable.currency, currency),
  ));
  if (existing) return existing;
  const [created] = await db.insert(clubWalletsTable).values({
    organizationId, userId, currency, balance: "0",
  }).returning();
  return created;
}

interface WalletTxnInput {
  walletId: number;
  kind: "credit" | "debit";
  amount: number;
  currency: string;
  sourceType: string;
  sourceId?: string | null;
  paymentRef?: string | null;
  note?: string | null;
}

/**
 * Apply a credit or debit to a wallet atomically. Updates the balance and
 * appends an immutable ledger entry with the post-txn balance. Throws if a
 * debit would drive the balance negative.
 */
async function applyWalletTxn(input: WalletTxnInput): Promise<{ balanceAfter: number }> {
  return db.transaction(async (tx) => {
    const [wallet] = await tx.select().from(clubWalletsTable)
      .where(eq(clubWalletsTable.id, input.walletId))
      .for("update");
    if (!wallet) throw new Error(`wallet ${input.walletId} not found`);
    const current = Number(wallet.balance);
    const delta = input.kind === "credit" ? input.amount : -input.amount;
    const next = Math.round((current + delta) * 100) / 100;
    if (next < 0) throw new Error("INSUFFICIENT_FUNDS");
    await tx.update(clubWalletsTable).set({
      balance: String(next),
      updatedAt: new Date(),
    }).where(eq(clubWalletsTable.id, input.walletId));
    await tx.insert(clubWalletTxnsTable).values({
      walletId: input.walletId,
      kind: input.kind,
      amount: String(input.amount),
      currency: input.currency,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      paymentRef: input.paymentRef ?? null,
      note: input.note ?? null,
      balanceAfter: String(next),
    });
    return { balanceAfter: next };
  });
}

/**
 * Mark a settlement paid and credit the recipient's wallet. Idempotent:
 * if the settlement is already paid this is a no-op. The recipient credit
 * is only written when toUserId is known (i.e. the payee is a registered
 * club member). Returns the updated settlement.
 */
export async function markSettlementPaid(args: {
  settlementId: number;
  paymentMethod: "razorpay" | "wallet";
  paymentRef: string;
  source: "verify" | "webhook" | "wallet";
}): Promise<typeof sideGameSettlementsTable.$inferSelect | null> {
  const ctx = await loadSettlementContext(args.settlementId);
  if (!ctx) return null;
  if (ctx.settlement.status === "paid") return ctx.settlement;
  if (ctx.settlement.status === "cancelled") {
    throw new Error("settlement is cancelled");
  }
  const [updated] = await db.update(sideGameSettlementsTable).set({
    status: "paid",
    paymentMethod: args.paymentMethod,
    paymentRef: args.paymentRef,
    paidAt: new Date(),
    updatedAt: new Date(),
  })
    .where(and(
      eq(sideGameSettlementsTable.id, args.settlementId),
      eq(sideGameSettlementsTable.status, "pending"),
    ))
    .returning();
  if (!updated) {
    // Lost the race — re-read.
    const [fresh] = await db.select().from(sideGameSettlementsTable)
      .where(eq(sideGameSettlementsTable.id, args.settlementId));
    return fresh ?? null;
  }
  // Razorpay-funded settlements credit the recipient's wallet so the
  // recipient can spend the balance later in-app.
  if (args.paymentMethod === "razorpay" && ctx.toUserId) {
    try {
      const wallet = await getOrCreateWallet(
        ctx.instance.organizationId,
        ctx.toUserId,
        ctx.settlement.currency ?? "INR",
      );
      await applyWalletTxn({
        walletId: wallet.id,
        kind: "credit",
        amount: Number(ctx.settlement.amount),
        currency: ctx.settlement.currency ?? "INR",
        sourceType: "side_game_settlement_paid",
        sourceId: String(args.settlementId),
        paymentRef: args.paymentRef,
        note: `Paid by ${ctx.settlement.fromName ?? "player"} via Razorpay`,
      });
    } catch (err) {
      logger.error({ err, settlementId: args.settlementId }, "[side-games-v2] failed to credit recipient wallet");
    }
  }
  // Notify recipient on the pending->paid transition (Task #614).
  // Fire-and-forget; never blocks the API/webhook response.
  notifySettlementPaid(args.settlementId).catch((err) => {
    logger.warn({ err, settlementId: args.settlementId }, "[side-games-v2] settlement-paid notify failed");
  });
  return updated;
}

// POST /side-game-settlements/:id/pay-order — create a Razorpay order
router.post("/side-game-settlements/:id/pay-order", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const id = Number((req.params as Record<string, string>).id);
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const ctx = await loadSettlementContext(id);
  if (!ctx) { { res.status(404).json({ error: "Settlement not found" }); return; } }
  if (ctx.settlement.status !== "pending") {
    res.status(400).json({ error: `Settlement is ${ctx.settlement.status}` }); return;
  }
  if (ctx.fromUserId !== userId && !isOrgAdmin(req)) {
    res.status(403).json({ error: "Only the player who owes can pay this settlement" }); return;
  }
  const amount = Number(ctx.settlement.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "Invalid settlement amount" }); return;
  }
  const currency = (ctx.settlement.currency ?? "INR").toUpperCase();
  let order;
  try {
    const razorpay = getRazorpayClient();
    order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency,
      notes: {
        kind: "side_game_settlement",
        settlementId: String(id),
        instanceId: String(ctx.instance.id),
        organizationId: String(ctx.instance.organizationId),
        fromUserId: ctx.fromUserId != null ? String(ctx.fromUserId) : "",
        toUserId: ctx.toUserId != null ? String(ctx.toUserId) : "",
      },
    });
  } catch (err) {
    logger.error({ err, settlementId: id }, "[side-games-v2] failed to create Razorpay order");
    res.status(502).json({ error: "Failed to create payment order" }); return;
  }
  await db.update(sideGameSettlementsTable).set({
    razorpayOrderId: order.id,
    updatedAt: new Date(),
  }).where(eq(sideGameSettlementsTable.id, id));
  res.json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: getRazorpayKeyId(),
    settlementId: id,
    fromName: ctx.settlement.fromName,
    toName: ctx.settlement.toName,
  });
});

// POST /side-game-settlements/:id/pay-verify — verify Razorpay signature + mark paid
router.post("/side-game-settlements/:id/pay-verify", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const id = Number((req.params as Record<string, string>).id);
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body ?? {};
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    res.status(400).json({ error: "razorpayOrderId, razorpayPaymentId, razorpaySignature are required" }); return;
  }
  if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
    res.status(400).json({ error: "Invalid signature" }); return;
  }
  // Re-fetch order from Razorpay to read trusted notes (don't trust client).
  let order;
  try {
    order = await getRazorpayClient().orders.fetch(razorpayOrderId);
  } catch (err) {
    res.status(502).json({ error: "Failed to verify order with Razorpay" }); return;
  }
  const notes = (order.notes ?? {}) as Record<string, string>;
  if (notes.kind !== "side_game_settlement" || Number(notes.settlementId) !== id) {
    res.status(400).json({ error: "Order does not match this settlement" }); return;
  }
  const updated = await markSettlementPaid({
    settlementId: id,
    paymentMethod: "razorpay",
    paymentRef: String(razorpayPaymentId),
    source: "verify",
  });
  if (!updated) { { res.status(404).json({ error: "Settlement not found" }); return; } }
  res.json({ ok: true, settlement: updated });
});

// POST /side-game-settlements/:id/pay-wallet — settle from the payer's club wallet
router.post("/side-game-settlements/:id/pay-wallet", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const id = Number((req.params as Record<string, string>).id);
  const ctx = await loadSettlementContext(id);
  if (!ctx) { { res.status(404).json({ error: "Settlement not found" }); return; } }
  if (ctx.settlement.status !== "pending") {
    res.status(400).json({ error: `Settlement is ${ctx.settlement.status}` }); return;
  }
  if (ctx.fromUserId !== userId && !isOrgAdmin(req)) {
    res.status(403).json({ error: "Only the player who owes can pay this settlement" }); return;
  }
  if (!ctx.fromUserId) {
    res.status(400).json({ error: "Payer has no linked user account — use Razorpay or cash" }); return;
  }
  const amount = Number(ctx.settlement.amount);
  const currency = ctx.settlement.currency ?? "INR";
  const fromWallet = await getOrCreateWallet(ctx.instance.organizationId, ctx.fromUserId, currency);
  if (Number(fromWallet.balance) < amount) {
    res.status(400).json({
      error: "INSUFFICIENT_FUNDS",
      balance: Number(fromWallet.balance),
      required: amount,
      currency,
    });
    return;
  }
  // Debit payer first; if that succeeds, credit recipient (when known) and
  // mark settlement paid. The credit failure is logged but does not roll
  // back the debit — payer is held harmless once we've taken their funds.
  try {
    await applyWalletTxn({
      walletId: fromWallet.id,
      kind: "debit",
      amount,
      currency,
      sourceType: "side_game_settlement_pay",
      sourceId: String(id),
      note: `Paid ${ctx.settlement.toName ?? "player"} via wallet`,
    });
  } catch (err) {
    if ((err as Error).message === "INSUFFICIENT_FUNDS") {
      res.status(400).json({ error: "INSUFFICIENT_FUNDS" }); return;
    }
    throw err;
  }
  if (ctx.toUserId) {
    const toWallet = await getOrCreateWallet(ctx.instance.organizationId, ctx.toUserId, currency);
    await applyWalletTxn({
      walletId: toWallet.id,
      kind: "credit",
      amount,
      currency,
      sourceType: "side_game_settlement_paid",
      sourceId: String(id),
      note: `Paid by ${ctx.settlement.fromName ?? "player"} via wallet`,
    });
  }
  // Race-safe transition: update only when still pending so a parallel
  // pay attempt cannot double-fire the recipient notification (Task #614).
  const [updated] = await db.update(sideGameSettlementsTable).set({
    status: "paid",
    paymentMethod: "wallet",
    paymentRef: `wallet:${ctx.fromUserId}`,
    paidAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(sideGameSettlementsTable.id, id),
    eq(sideGameSettlementsTable.status, "pending"),
  )).returning();
  if (updated) {
    notifySettlementPaid(id).catch((err) => {
      logger.warn({ err, settlementId: id }, "[side-games-v2] settlement-paid notify failed");
    });
  }
  res.json({ ok: true, settlement: updated ?? ctx.settlement });
});

// ─── CLUB WALLET PORTAL ENDPOINTS ──────────────────────────────────────

// GET /wallet?organizationId=&currency=
router.get("/wallet", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const orgId = req.query.organizationId ? Number(req.query.organizationId) : null;
  const currency = (req.query.currency ? String(req.query.currency) : "INR").toUpperCase();
  if (!orgId) { { res.status(400).json({ error: "organizationId is required" }); return; } }
  const wallet = await getOrCreateWallet(orgId, userId, currency);
  // Optional: ?includeTxnIds=1,2,3 — guarantees those wallet-owned txns are
  // present in the response even if older than the most-recent 50, so the UI
  // can scroll/jump to a withdrawal's matching ledger entry (Task #1104).
  const includeIdsRaw = req.query.includeTxnIds ? String(req.query.includeTxnIds) : "";
  const includeIds = includeIdsRaw
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0)
    .slice(0, 25);
  const recent = await db.select().from(clubWalletTxnsTable)
    .where(eq(clubWalletTxnsTable.walletId, wallet.id))
    .orderBy(desc(clubWalletTxnsTable.createdAt))
    .limit(50);
  let txns = recent;
  if (includeIds.length > 0) {
    const have = new Set(recent.map(t => t.id));
    const missing = includeIds.filter(id => !have.has(id));
    if (missing.length > 0) {
      const extras = await db.select().from(clubWalletTxnsTable).where(and(
        eq(clubWalletTxnsTable.walletId, wallet.id),
        inArray(clubWalletTxnsTable.id, missing),
      ));
      txns = [...recent, ...extras].sort((a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime(),
      );
    }
  }
  // Task #1841 — fold per-txn notify state for `wallet_topup_refund`
  // rows so the badges added to the wallet UI can render the same
  // "next try in 2m 14s" / "gave up X ago" countdown that wallet
  // withdrawals already get from `serializeWithdrawalNotify`. The
  // attempts table is keyed by `paymentId`, which matches the txn's
  // `paymentRef` (the original Razorpay payment that was refunded).
  const refundPaymentRefs = txns
    .filter(t => t.sourceType === "wallet_topup_refund" && t.paymentRef)
    .map(t => t.paymentRef as string);
  const refundAttemptsByPayment = new Map<
    string,
    typeof walletTopupRefundNotifyAttemptsTable.$inferSelect
  >();
  if (refundPaymentRefs.length > 0) {
    const refundAttempts = await db.select()
      .from(walletTopupRefundNotifyAttemptsTable)
      .where(inArray(walletTopupRefundNotifyAttemptsTable.paymentId, refundPaymentRefs));
    for (const r of refundAttempts) refundAttemptsByPayment.set(r.paymentId, r);
  }
  res.json({
    wallet: {
      id: wallet.id,
      organizationId: wallet.organizationId,
      userId: wallet.userId,
      currency: wallet.currency,
      balance: Number(wallet.balance),
    },
    transactions: txns.map(t => ({
      id: t.id,
      kind: t.kind,
      amount: Number(t.amount),
      currency: t.currency,
      sourceType: t.sourceType,
      sourceId: t.sourceId,
      paymentRef: t.paymentRef,
      note: t.note,
      balanceAfter: Number(t.balanceAfter),
      createdAt: t.createdAt.toISOString(),
      notify: t.sourceType === "wallet_topup_refund" && t.paymentRef
        ? serializeTopupRefundNotify(refundAttemptsByPayment.get(t.paymentRef) ?? null)
        : null,
      // Task #1862 — four-channel (email/push/sms/whatsapp) delivery
      // row consumed by the wallet refund detail status row. Member-
      // facing wallet view: `lastError` strings are intentionally
      // omitted; the equivalent admin endpoint
      // (/admin/wallet-topup-refunds) sets `includeLastError: true`.
      delivery: t.sourceType === "wallet_topup_refund" && t.paymentRef
        ? serializeTopupRefundDelivery(
          refundAttemptsByPayment.get(t.paymentRef) ?? null,
          { includeLastError: false },
        )
        : null,
    })),
  });
});

// POST /wallet/topup-order — create a Razorpay order to top up the wallet
router.post("/wallet/topup-order", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const { organizationId, amount, currency } = req.body ?? {};
  const orgId = Number(organizationId);
  const amt = Number(amount);
  const ccy = (currency ? String(currency) : "INR").toUpperCase();
  if (!orgId || !Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "organizationId and positive amount are required" }); return;
  }
  let order;
  try {
    order = await getRazorpayClient().orders.create({
      amount: Math.round(amt * 100),
      currency: ccy,
      notes: {
        kind: "wallet_topup",
        organizationId: String(orgId),
        userId: String(userId),
      },
    });
  } catch (err) {
    logger.error({ err }, "[side-games-v2] failed to create wallet top-up order");
    res.status(502).json({ error: "Failed to create payment order" }); return;
  }
  res.json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: getRazorpayKeyId(),
  });
});

// POST /wallet/topup-verify — verify Razorpay signature + credit the wallet
router.post("/wallet/topup-verify", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body ?? {};
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    res.status(400).json({ error: "razorpayOrderId, razorpayPaymentId, razorpaySignature are required" }); return;
  }
  if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
    res.status(400).json({ error: "Invalid signature" }); return;
  }
  let order;
  try {
    order = await getRazorpayClient().orders.fetch(razorpayOrderId);
  } catch {
    res.status(502).json({ error: "Failed to verify order with Razorpay" }); return;
  }
  const notes = (order.notes ?? {}) as Record<string, string>;
  if (notes.kind !== "wallet_topup" || Number(notes.userId) !== userId) {
    res.status(400).json({ error: "Order does not match this user" }); return;
  }
  const result = await creditWalletTopupFromPayment({
    paymentId: String(razorpayPaymentId),
    orderId: String(razorpayOrderId),
    amountMinor: Number(order.amount),
    currency: String(order.currency ?? "INR"),
    notes,
    note: "Wallet top-up",
  });
  if (!result.credited && !result.alreadyCredited) {
    res.status(400).json({ error: result.reason ?? "Could not credit wallet" }); return;
  }
  res.json({ ok: true, alreadyCredited: result.alreadyCredited ?? false, balance: result.balance });
});

// ─── Wallet top-up reconciliation (Task #769) ───────────────────────────────
// The wallet top-up flow normally credits the wallet via /wallet/topup-verify
// after Razorpay returns a successful payment. If the client crashes (network
// drop, app close, signature mismatch) after the bank charged the member, the
// money is captured in Razorpay but the ledger never reflects it.  Two paths
// reconcile this:
//   1. The Razorpay webhook handler in routes/payments.ts calls
//      `creditWalletTopupFromPayment` on every `payment.captured` event tagged
//      `kind: wallet_topup` (best-effort, idempotent).
//   2. A daily cron sweep (`refundOrphanedWalletTopups`) refunds any captured
//      wallet-topup payment that's still uncredited 24h+ after capture.

interface CreditWalletTopupInput {
  paymentId: string;
  orderId: string | null;
  amountMinor: number;     // Razorpay subunit (e.g. paise for INR)
  currency: string;
  notes: Record<string, unknown>;
  note?: string;
}

interface CreditWalletTopupResult {
  credited: boolean;
  alreadyCredited?: boolean;
  balance?: number;
  reason?: string;
}

/**
 * Idempotently credit a wallet top-up payment to the member's club wallet.
 * Used by both the /wallet/topup-verify route and the Razorpay webhook so
 * the credit happens even if the user closed the app before /verify ran.
 */
export async function creditWalletTopupFromPayment(
  input: CreditWalletTopupInput,
): Promise<CreditWalletTopupResult> {
  const notes = input.notes ?? {};
  if (notes.kind !== "wallet_topup") {
    return { credited: false, reason: "not_wallet_topup" };
  }
  const userId = Number(notes.userId);
  const orgId = Number(notes.organizationId);
  if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(orgId) || orgId <= 0) {
    return { credited: false, reason: "missing_notes" };
  }
  const currency = String(input.currency ?? "INR").toUpperCase();
  const amount = Number(input.amountMinor) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { credited: false, reason: "invalid_amount" };
  }
  const wallet = await getOrCreateWallet(orgId, userId, currency);
  const [dup] = await db.select({ id: clubWalletTxnsTable.id })
    .from(clubWalletTxnsTable)
    .where(and(
      eq(clubWalletTxnsTable.walletId, wallet.id),
      eq(clubWalletTxnsTable.paymentRef, input.paymentId),
    ));
  if (dup) {
    const [fresh] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, wallet.id));
    return { credited: false, alreadyCredited: true, balance: fresh ? Number(fresh.balance) : 0 };
  }
  const result = await applyWalletTxn({
    walletId: wallet.id,
    kind: "credit",
    amount,
    currency,
    sourceType: "wallet_topup_razorpay",
    sourceId: input.orderId,
    paymentRef: input.paymentId,
    note: input.note ?? "Wallet top-up",
  });
  return { credited: true, balance: result.balanceAfter };
}

/**
 * Daily reconciliation: scan recent Razorpay payments tagged as wallet
 * top-ups and, for any that were captured >24h ago but never made it into
 * the wallet ledger (and weren't refunded), issue a Razorpay refund and
 * record an audit row in the wallet ledger so the member sees the
 * adjustment in their history.
 *
 * Window: payments captured between 7 days ago and 24h ago. The 24h floor
 * gives /wallet/topup-verify and the webhook a generous window to land
 * before we refund. The 7-day ceiling keeps the daily scan bounded.
 */
export async function refundOrphanedWalletTopups(opts?: {
  /** Override the Razorpay client (used in tests). */
  razorpayClient?: ReturnType<typeof getRazorpayClient>;
  /** Now in ms (overridable for tests). */
  nowMs?: number;
  /** How long after capture a payment is considered orphaned (ms). */
  orphanAgeMs?: number;
  /** Lookback window from now (ms). */
  lookbackMs?: number;
}): Promise<{ scanned: number; refunded: number; alreadyRefunded: number; errors: number }> {
  let razorpay: ReturnType<typeof getRazorpayClient>;
  try {
    razorpay = opts?.razorpayClient ?? getRazorpayClient();
  } catch {
    return { scanned: 0, refunded: 0, alreadyRefunded: 0, errors: 0 };
  }
  const nowMs = opts?.nowMs ?? Date.now();
  const orphanAgeMs = opts?.orphanAgeMs ?? 24 * 60 * 60 * 1000;
  const lookbackMs = opts?.lookbackMs ?? 7 * 24 * 60 * 60 * 1000;
  const toSec = Math.floor((nowMs - orphanAgeMs) / 1000);
  const fromSec = Math.floor((nowMs - lookbackMs) / 1000);

  let scanned = 0, refunded = 0, alreadyRefunded = 0, errors = 0;
  const PAGE = 100;
  let skip = 0;

  while (true) {
    let page: { items?: Array<Record<string, unknown>> };
    try {
      page = await razorpay.payments.all({ from: fromSec, to: toSec, count: PAGE, skip }) as unknown as { items?: Array<Record<string, unknown>> };
    } catch (err) {
      logger.warn({ err }, "[wallet-topup-refund] failed to list Razorpay payments");
      errors++;
      break;
    }
    const items = page.items ?? [];
    if (items.length === 0) break;

    for (const p of items) {
      const notes = (p.notes ?? {}) as Record<string, unknown>;
      if (notes.kind !== "wallet_topup") continue;
      if (p.status !== "captured") continue;
      scanned++;

      const userId = Number(notes.userId);
      const orgId = Number(notes.organizationId);
      if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(orgId) || orgId <= 0) continue;
      const currency = String(p.currency ?? "INR").toUpperCase();
      const paymentId = String(p.id);

      // Already credited to the wallet ledger? Skip.
      const wallet = await getOrCreateWallet(orgId, userId, currency);
      const [credited] = await db.select({ id: clubWalletTxnsTable.id })
        .from(clubWalletTxnsTable)
        .where(and(
          eq(clubWalletTxnsTable.walletId, wallet.id),
          eq(clubWalletTxnsTable.paymentRef, paymentId),
        ));
      if (credited) continue;

      // Already refunded (full or partial)? Record an audit row if missing.
      const amountMinor = Number(p.amount) || 0;
      const amountRefundedMinor = Number(p.amount_refunded) || 0;

      try {
        if (amountRefundedMinor >= amountMinor && amountMinor > 0) {
          alreadyRefunded++;
          const adj = await recordWalletTopupRefundAdjustment({
            wallet,
            paymentId,
            orderId: p.order_id ? String(p.order_id) : null,
            amount: amountMinor / 100,
            currency,
            note: `Auto-refund of failed top-up (already refunded at Razorpay) — ${currency} ${(amountMinor / 100).toFixed(2)}`,
          });
          // Per-user de-dup (Task #919): only notify the first time we
          // record the audit row for this paymentId. Subsequent cron
          // passes will find the existing row and skip the notify.
          if (adj.inserted) {
            await notifyWalletTopupAutoRefunded({
              organizationId: orgId,
              userId,
              paymentId,
              refundId: null,
              amount: amountMinor / 100,
              currency,
            }).catch((err) => {
              logger.warn({ err, paymentId }, "[wallet-topup-refund] notify failed (already-refunded branch)");
            });
          }
          continue;
        }
        // Issue full refund.
        const refundResp = await razorpay.payments.refund(paymentId, {
          amount: amountMinor,
          notes: {
            reason: "auto_refund_orphaned_wallet_topup",
            organizationId: String(orgId),
            userId: String(userId),
          },
        }) as unknown as { id?: string };
        refunded++;
        const adj = await recordWalletTopupRefundAdjustment({
          wallet,
          paymentId,
          orderId: p.order_id ? String(p.order_id) : null,
          amount: amountMinor / 100,
          currency,
          note: `Auto-refund of failed top-up — bank charged ${currency} ${(amountMinor / 100).toFixed(2)} but wallet credit was not applied`,
        });
        logger.info({ paymentId, userId, orgId, amount: amountMinor / 100, currency }, "[wallet-topup-refund] auto-refunded orphaned top-up");
        if (adj.inserted) {
          await notifyWalletTopupAutoRefunded({
            organizationId: orgId,
            userId,
            paymentId,
            refundId: refundResp?.id ?? null,
            amount: amountMinor / 100,
            currency,
          }).catch((err) => {
            logger.warn({ err, paymentId }, "[wallet-topup-refund] notify failed");
          });
        }
      } catch (err) {
        errors++;
        logger.warn({ err, paymentId }, "[wallet-topup-refund] refund attempt failed");
      }
    }

    if (items.length < PAGE) break;
    skip += PAGE;
  }

  if (scanned > 0 || refunded > 0 || alreadyRefunded > 0) {
    logger.info({ scanned, refunded, alreadyRefunded, errors }, "[wallet-topup-refund] reconciliation pass complete");
  }
  return { scanned, refunded, alreadyRefunded, errors };
}

/**
 * Insert a non-balance-changing audit row into the wallet ledger so the
 * refund is visible to the member when they look at their wallet history.
 * Uses a 0-amount credit row labelled `wallet_topup_refund` so existing
 * balance arithmetic is unaffected.
 */
async function recordWalletTopupRefundAdjustment(args: {
  wallet: { id: number };
  paymentId: string;
  orderId: string | null;
  amount: number;
  currency: string;
  note: string;
}): Promise<{ inserted: boolean }> {
  const [existing] = await db.select({ id: clubWalletTxnsTable.id })
    .from(clubWalletTxnsTable)
    .where(and(
      eq(clubWalletTxnsTable.walletId, args.wallet.id),
      eq(clubWalletTxnsTable.sourceType, "wallet_topup_refund"),
      eq(clubWalletTxnsTable.paymentRef, args.paymentId),
    ));
  if (existing) return { inserted: false };
  const [fresh] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, args.wallet.id));
  const balance = fresh ? String(fresh.balance) : "0";
  await db.insert(clubWalletTxnsTable).values({
    walletId: args.wallet.id,
    kind: "credit",
    amount: "0",
    currency: args.currency,
    sourceType: "wallet_topup_refund",
    sourceId: args.orderId,
    paymentRef: args.paymentId,
    note: args.note,
    balanceAfter: balance,
    // Task #1072 — persist the refunded amount in a structured column
    // so the auto-refund admin dashboard can read it directly instead
    // of regex-parsing the human-readable note text.
    auditAmount: args.amount.toFixed(2),
  });
  return { inserted: true };
}

// ─── ADMIN: AUTO-REFUND DASHBOARD (Task #920) ─────────────────────────
//
// Surface every `wallet_topup_refund` ledger row across an organisation
// so org admins can reconcile the auto-refunds applied by the
// `refundOrphanedWalletTopups` cron (Task #769). The audit row stores
// `amount: "0"` to keep wallet balance arithmetic untouched; the real
// refunded amount lives in the structured `audit_amount` column
// (Task #1072). Legacy rows written before that column existed were
// backfilled by migration 0103 (Task #1239), so the read path now
// trusts `audit_amount` for every row.

interface AutoRefundRow {
  id: number;
  userId: number | null;
  memberName: string | null;
  memberEmail: string | null;
  amount: number | null;
  currency: string;
  paymentRef: string | null;
  orderId: string | null;
  note: string | null;
  refundedAt: string;
}

async function loadAutoRefundRows(args: {
  orgId: number;
  memberId: number | null;
  q: string | null;
  from: Date | null;
  to: Date | null;
}): Promise<AutoRefundRow[]> {
  const conds = [
    eq(clubWalletsTable.organizationId, args.orgId),
    eq(clubWalletTxnsTable.sourceType, "wallet_topup_refund"),
  ];
  if (args.memberId) conds.push(eq(clubWalletsTable.userId, args.memberId));
  if (args.q) {
    const pattern = `%${args.q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    const search = or(
      ilike(appUsersTable.displayName, pattern),
      ilike(appUsersTable.email, pattern),
    );
    if (search) conds.push(search);
  }
  if (args.from) conds.push(gte(clubWalletTxnsTable.createdAt, args.from));
  if (args.to) conds.push(lte(clubWalletTxnsTable.createdAt, args.to));

  const rows = await db.select({
    id: clubWalletTxnsTable.id,
    userId: clubWalletsTable.userId,
    displayName: appUsersTable.displayName,
    email: appUsersTable.email,
    currency: clubWalletTxnsTable.currency,
    paymentRef: clubWalletTxnsTable.paymentRef,
    sourceId: clubWalletTxnsTable.sourceId,
    note: clubWalletTxnsTable.note,
    auditAmount: clubWalletTxnsTable.auditAmount,
    createdAt: clubWalletTxnsTable.createdAt,
  })
    .from(clubWalletTxnsTable)
    .innerJoin(clubWalletsTable, eq(clubWalletsTable.id, clubWalletTxnsTable.walletId))
    .leftJoin(appUsersTable, eq(appUsersTable.id, clubWalletsTable.userId))
    .where(and(...conds))
    .orderBy(desc(clubWalletTxnsTable.createdAt));

  return rows.map(r => {
    // The structured audit_amount column is populated for every row:
    // Task #1072 writes it on every new auto-refund, and migration 0103
    // (Task #1239) backfilled it for all pre-existing rows. A NULL here
    // means the legacy note never matched the parser either, so we
    // surface NULL rather than guessing.
    let amount: number | null = null;
    if (r.auditAmount != null) {
      const n = parseFloat(String(r.auditAmount));
      amount = Number.isFinite(n) ? n : null;
    }
    return {
    id: r.id,
    userId: r.userId ?? null,
    memberName: r.displayName ?? null,
    memberEmail: r.email ?? null,
    amount,
    currency: r.currency,
    paymentRef: r.paymentRef ?? null,
    orderId: r.sourceId ?? null,
    note: r.note ?? null,
    refundedAt: r.createdAt.toISOString(),
    };
  });
}

function parseDateParam(raw: unknown): { ok: true; value: Date | null } | { ok: false } {
  if (raw === undefined || raw === "" || raw === null) return { ok: true, value: null };
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d };
}

interface ParsedRefundFilters {
  orgId: number;
  memberId: number | null;
  q: string | null;
  from: Date | null;
  to: Date | null;
}

async function parseRefundFilters(req: Request, res: Response): Promise<ParsedRefundFilters | null> {
  const orgId = req.query.organizationId ? Number(req.query.organizationId) : NaN;
  if (!Number.isFinite(orgId) || orgId <= 0) {
    res.status(400).json({ error: "organizationId is required" });
    return null;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return null;

  const memberIdRaw = req.query.memberId;
  let memberId: number | null = null;
  if (memberIdRaw !== undefined && memberIdRaw !== "") {
    const n = Number(memberIdRaw);
    if (!Number.isFinite(n) || n <= 0) {
      res.status(400).json({ error: "invalid memberId" });
      return null;
    }
    memberId = n;
  }
  const qRaw = req.query.q;
  let q: string | null = null;
  if (typeof qRaw === "string") {
    const trimmed = qRaw.trim();
    if (trimmed.length > 0) q = trimmed;
  }
  const fromR = parseDateParam(req.query.from);
  if (!fromR.ok) { res.status(400).json({ error: "invalid from date" }); return null; }
  const toR = parseDateParam(req.query.to);
  if (!toR.ok) { res.status(400).json({ error: "invalid to date" }); return null; }
  if (fromR.value && toR.value && fromR.value.getTime() > toR.value.getTime()) {
    res.status(400).json({ error: "'from' must be on or before 'to'" });
    return null;
  }
  return { orgId, memberId, q, from: fromR.value, to: toR.value };
}

router.get("/admin/wallet-topup-refunds", async (req: Request, res: Response) => {
  const filters = await parseRefundFilters(req, res);
  if (!filters) return;
  const items = await loadAutoRefundRows(filters);

  const totalsByCurrency: Record<string, { count: number; amount: number }> = {};
  for (const it of items) {
    const t = totalsByCurrency[it.currency] ??= { count: 0, amount: 0 };
    t.count += 1;
    if (it.amount != null) t.amount += it.amount;
  }

  // Task #1862 — fold per-channel (email/push/sms/whatsapp) delivery
  // state onto each refund so admins can see, in the dashboard list,
  // whether the refund SMS/WhatsApp ever went out, retried, or got
  // permanently dropped — and what the most recent provider error was
  // — without database access. The notify-attempts row is keyed by
  // `paymentId`, which is the same as the refund txn's `paymentRef`
  // (the original Razorpay payment that was refunded).
  const refundPaymentRefs = items
    .map(i => i.paymentRef)
    .filter((p): p is string => Boolean(p));
  const refundDeliveryByPayment = new Map<
    string,
    ReturnType<typeof serializeTopupRefundDelivery>
  >();
  if (refundPaymentRefs.length > 0) {
    const attempts = await db.select()
      .from(walletTopupRefundNotifyAttemptsTable)
      .where(inArray(walletTopupRefundNotifyAttemptsTable.paymentId, refundPaymentRefs));
    for (const a of attempts) {
      refundDeliveryByPayment.set(
        a.paymentId,
        serializeTopupRefundDelivery(a, { includeLastError: true }),
      );
    }
  }
  const itemsWithDelivery = items.map(it => ({
    ...it,
    delivery: it.paymentRef ? refundDeliveryByPayment.get(it.paymentRef) ?? null : null,
  }));
  res.json({ items: itemsWithDelivery, totalsByCurrency });
});

/**
 * Build the auto-refund CSV for a given org + window. Shared between the
 * dashboard download (`/admin/wallet-topup-refunds.csv`) and the scheduled
 * digest email (Task #1073) so both stay byte-identical.
 */
async function buildWalletTopupRefundCsv(args: {
  orgId: number;
  from: Date | null;
  to: Date | null;
  /**
   * Task #1435 — recipient/org language used to localise the CSV column
   * headers (column *order* is fixed, only labels translate). EN fallback
   * when omitted or the code is unsupported, mirroring the email digest.
   */
  lang?: string | null;
}): Promise<{ csv: string; rowCount: number; currencyCount: number }> {
  const items = await loadAutoRefundRows({
    orgId: args.orgId,
    memberId: null,
    q: null,
    from: args.from,
    to: args.to,
  });
  const header = translateWalletTopupRefundCsvHeaders(args.lang);
  const rows: string[][] = [header.slice()];
  const currencies = new Set<string>();
  for (const it of items) {
    currencies.add(it.currency);
    rows.push([
      it.refundedAt,
      it.userId != null ? String(it.userId) : "",
      it.memberName ?? "",
      it.memberEmail ?? "",
      it.amount != null ? it.amount.toFixed(2) : "",
      it.currency,
      it.paymentRef ?? "",
      it.orderId ?? "",
      it.note ?? "",
    ]);
  }
  const csv = rows
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
  return { csv, rowCount: items.length, currencyCount: currencies.size };
}

router.get("/admin/wallet-topup-refunds.csv", async (req: Request, res: Response) => {
  const filters = await parseRefundFilters(req, res);
  if (!filters) return;
  // The dashboard download still respects the optional memberId filter,
  // which the digest never uses. Use the rows path directly when filtered.
  const items = await loadAutoRefundRows(filters);
  // Task #1744 — localise the dashboard CSV column headers using the org's
  // `defaultLanguage`, mirroring the digest email attachment built by
  // `buildWalletTopupRefundCsv`. Column *order* stays fixed so any
  // downstream parser that keys off position keeps working; only the
  // header *labels* translate. Unsupported codes fall back to English via
  // `translateWalletTopupRefundCsvHeaders`.
  const [org] = await db.select({
    defaultLanguage: organizationsTable.defaultLanguage,
  }).from(organizationsTable).where(eq(organizationsTable.id, filters.orgId));
  const header = translateWalletTopupRefundCsvHeaders(org?.defaultLanguage ?? null);
  const rows: string[][] = [header.slice()];
  for (const it of items) {
    rows.push([
      it.refundedAt,
      it.userId != null ? String(it.userId) : "",
      it.memberName ?? "",
      it.memberEmail ?? "",
      it.amount != null ? it.amount.toFixed(2) : "",
      it.currency,
      it.paymentRef ?? "",
      it.orderId ?? "",
      it.note ?? "",
    ]);
  }
  const csv = rows
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
  // Task #2156 — date-stamp the dashboard download filename so it
  // matches the digest email attachment built by
  // `buildWalletTopupRefundScheduleEmailContent` (also `wallet-topup-refunds-YYYY-MM-DD.csv`).
  // The previous `wallet-topup-refunds-<orgId>.csv` suffix used the
  // numeric org ID — meaningless to humans and identical across
  // every download, so successive period downloads overwrote each
  // other in treasurers' folders. When the request scopes a date
  // range we encode both bounds (`from_to`) so the file name still
  // self-describes the period; otherwise we fall back to the request
  // date, mirroring the digest's single-date convention.
  const stamp = (d: Date) => d.toISOString().slice(0, 10);
  const dateLabel = filters.from && filters.to
    ? `${stamp(filters.from)}_${stamp(filters.to)}`
    : filters.from
      ? `${stamp(filters.from)}_${stamp(new Date())}`
      : filters.to
        ? stamp(filters.to)
        : stamp(new Date());
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="wallet-topup-refunds-${dateLabel}.csv"`);
  res.send(csv);
});

// ─── ADMIN: AUTO-REFUND EMAIL DIGEST SCHEDULE (Task #1073) ─────────────
//
// Org admins configure a weekly/monthly cadence + recipient list and the
// in-process cron (lib/cron.ts) emails the elapsed-period CSV to finance
// teams so reconciliation no longer requires anyone to remember to log
// in to the dashboard. Mirrors the per-org levy-ledger digest pattern in
// member-360.ts.

const WALLET_REFUND_SCHEDULE_FREQUENCIES = new Set(["weekly", "monthly"]);
const WALLET_REFUND_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Compute the next run datetime for a given frequency. Anchored to 07:00
 * UTC on the run day so the digest lands at the start of the work-day for
 * most reconciliation timezones — matches the levy-ledger digest cadence
 * (computeLevyLedgerNextRunAt) so org admins build one mental model.
 */
export function computeWalletTopupRefundNextRunAt(frequency: string, from: Date = new Date()): Date {
  const d = new Date(from);
  if (frequency === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
  } else {
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

async function parseAutoRefundScheduleOrgId(req: Request, res: Response): Promise<number | null> {
  const orgIdNum = req.query.organizationId ? Number(req.query.organizationId) : NaN;
  if (!Number.isFinite(orgIdNum) || orgIdNum <= 0) {
    res.status(400).json({ error: "organizationId is required" });
    return null;
  }
  if (!await requireOrgAdmin(req, res, orgIdNum)) return null;
  return orgIdNum;
}

/**
 * Surface which configured recipients on the wallet auto-refund digest are
 * currently paused by the bounce-aware filter (Task #1233 + #1443).
 *
 * The cron's `runOneWalletTopupRefundEmailSchedule` filters every saved
 * recipient against `email_suppressions` before sending; paused addresses
 * are silently dropped from that run AND removed from the schedule's stored
 * recipients list. Until Task #1443, the only way for finance to learn that
 * a recipient had been paused was to read the run history's free-text
 * `errorMessage`. This helper repeats the same join the cron does, but
 * against an arbitrary recipient list (the saved one for the dashboard's
 * "X paused" chip, or the just-saved-edited one for the editor's warning),
 * and returns each match's suppression metadata so the dashboard can show
 * the bounce / unsubscribe / spam_complaint reason inline and offer a
 * one-click "remove from suppression list" action.
 *
 * Returns an empty array when `recipients` is empty so callers don't need a
 * guard. The mapping is case-insensitive — both the schedule's stored list
 * and `email_suppressions.email` are lower-cased before joining, mirroring
 * the cron filter — but the returned `email` preserves the casing the user
 * typed into the recipient list so the warning row matches what they see.
 */
interface PausedRecipientRow {
  suppressionId: number;
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
  createdAt: string;
}

/**
 * Surface the resolved digest language *per recipient* on the auto-refund
 * schedule editor — Task #1747, then upgraded by Task #2170 from a
 * display-only enrichment into the source of truth the cron itself uses.
 *
 * The org-wide language banner (Task #1436) shows the org's
 * `defaultLanguage` fallback. In practice the digest can be received by
 * users outside the org (an external accountant CC'd on `recipients`),
 * and internal users may have their own `preferredLanguage` set to
 * something different from the org's `defaultLanguage`. As of Task
 * #2170 the cron groups recipients by per-recipient resolved language
 * and dispatches one rendered digest per group, so each recipient now
 * actually receives the digest in the language reported here.
 *
 * Resolution rules (mirrored exactly inside
 * `runOneWalletTopupRefundEmailSchedule` so this editor preview never
 * lies about what the cron will do):
 *   - Known app user with a *supported* `preferredLanguage` → use it.
 *   - Known app user with a null OR unsupported `preferredLanguage`
 *     → fall back to the org's resolved digest language.
 *   - External recipient (no `app_users` row) → fall back to the org's
 *     resolved digest language.
 *
 * `mismatch` is true only when the recipient is a known app user AND
 * the language they will actually receive (`resolvedDigestLanguage`)
 * differs from their stored `preferredLanguage`. Because the cron now
 * honours the user's preference whenever it is supported, this only
 * happens for users whose stored preference is itself unsupported by
 * the digest's translation pack — i.e. it surfaces the case the
 * dashboard fallback banner already warns about. External recipients
 * (no user row) leave `userPreferredLanguage` as `null` and `mismatch`
 * as `false`, since we cannot know what they would prefer.
 *
 * Email matching is case-insensitive (mirroring the bounce-aware
 * suppression join) so a recipient entered in mixed case still resolves
 * to the matching app_user. The returned `email` preserves the casing the
 * treasurer typed so the UI rows match the textarea.
 */
interface RecipientLanguageRow {
  email: string;
  userPreferredLanguage: string | null;
  resolvedDigestLanguage: string;
  mismatch: boolean;
}

/**
 * Look up each recipient's `app_users.preferredLanguage` (lower-cased
 * email match, first hit wins). Returns a Map keyed by *lower-cased*
 * email so callers can do their own case-preserving join afterwards.
 * On lookup failure we fall back to an empty map so the cron still
 * sends — every recipient just gets the org-default fallback in that
 * case rather than blocking the whole digest on a transient DB blip.
 */
async function loadAppUserPreferredLanguagesByLowerEmail(
  recipients: string[],
): Promise<Map<string, string | null>> {
  const langByLower = new Map<string, string | null>();
  if (recipients.length === 0) return langByLower;
  const lowerSet = new Set<string>();
  for (const r of recipients) {
    const lower = r.trim().toLowerCase();
    if (lower) lowerSet.add(lower);
  }
  const lowerList = [...lowerSet];
  if (lowerList.length === 0) return langByLower;
  try {
    const rows = await db.select({
      email: appUsersTable.email,
      preferredLanguage: appUsersTable.preferredLanguage,
    }).from(appUsersTable).where(
      inArray(sql`lower(${appUsersTable.email})`, lowerList),
    );
    for (const row of rows) {
      if (!row.email) continue;
      const lower = row.email.trim().toLowerCase();
      // First match wins — duplicate accounts on the same email are rare
      // and the cron sends to the email regardless of which user owns it.
      if (!langByLower.has(lower)) langByLower.set(lower, row.preferredLanguage);
    }
  } catch (err) {
    logger.warn({ err }, "[wallet-topup-refund-email] recipient language lookup failed; falling back to org default for every recipient");
  }
  return langByLower;
}

/**
 * Resolve the language a single recipient will actually receive the
 * digest in. The user's `preferredLanguage` wins when it is in the
 * digest's 21-language pack; otherwise we fall back to the org's
 * resolved digest language. External recipients (no user row /
 * `userPreferredLanguage === null`) always get the org default.
 *
 * Kept as a tiny shared helper so the cron and the editor route stay
 * byte-identical — Task #2170.
 */
function resolveRecipientDigestLanguage(
  userPreferredLanguage: string | null,
  orgResolvedDigestLanguage: string,
): string {
  if (userPreferredLanguage != null && isSupportedWalletTopupRefundDigestLang(userPreferredLanguage)) {
    return userPreferredLanguage;
  }
  return orgResolvedDigestLanguage;
}

async function loadRecipientLanguagesForOrg(
  recipients: string[],
  orgResolvedDigestLanguage: string,
): Promise<RecipientLanguageRow[]> {
  if (recipients.length === 0) return [];
  const langByLower = await loadAppUserPreferredLanguagesByLowerEmail(recipients);
  const out: RecipientLanguageRow[] = [];
  const seen = new Set<string>();
  for (const r of recipients) {
    const lower = r.trim().toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    const userLang = langByLower.get(lower) ?? null;
    const resolved = resolveRecipientDigestLanguage(userLang, orgResolvedDigestLanguage);
    out.push({
      email: r,
      userPreferredLanguage: userLang,
      resolvedDigestLanguage: resolved,
      mismatch: userLang != null && userLang !== resolved,
    });
  }
  return out;
}

async function loadPausedRecipientsForOrg(orgId: number, recipients: string[]): Promise<PausedRecipientRow[]> {
  if (recipients.length === 0) return [];
  const lowerToOriginal = new Map<string, string>();
  for (const r of recipients) {
    const lower = r.trim().toLowerCase();
    if (lower && !lowerToOriginal.has(lower)) lowerToOriginal.set(lower, r);
  }
  const lowerList = [...lowerToOriginal.keys()];
  if (lowerList.length === 0) return [];
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
    return rows.map(r => ({
      suppressionId: r.id,
      email: lowerToOriginal.get(r.email.toLowerCase()) ?? r.email,
      reason: r.reason,
      bounceType: r.bounceType,
      description: r.description,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }));
  } catch (err) {
    logger.warn({ err, orgId }, "[wallet-topup-refund-email] paused recipient lookup failed; reporting none");
    return [];
  }
}

router.get("/admin/wallet-topup-refunds/email-schedule", async (req: Request, res: Response) => {
  const orgId = await parseAutoRefundScheduleOrgId(req, res);
  if (orgId == null) return;

  const [schedule] = await db.select().from(walletTopupRefundEmailSchedulesTable)
    .where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));

  const history = schedule
    ? await db.select().from(walletTopupRefundEmailRunsTable)
        .where(eq(walletTopupRefundEmailRunsTable.scheduleId, schedule.id))
        .orderBy(desc(walletTopupRefundEmailRunsTable.sentAt))
        .limit(50)
    : [];

  // Task #1436 — surface the language the digest will actually be sent in
  // so a treasurer who configured the schedule before the org's
  // `defaultLanguage` was changed can immediately see whether recipients
  // will now receive a different translation. We resolve the same way
  // `runOneWalletTopupRefundEmailSchedule` does (org defaultLanguage with
  // EN fallback for unsupported codes), and also report whether a fallback
  // happened so the UI can flag mismatches between the configured and
  // resolved code.
  const [orgRow] = await db.select({
    defaultLanguage: organizationsTable.defaultLanguage,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const configuredLanguage = orgRow?.defaultLanguage ?? null;
  const resolvedLanguage = resolveWalletTopupRefundDigestLang(configuredLanguage);
  const isFallback = !isSupportedWalletTopupRefundDigestLang(configuredLanguage);

  // Task #1443 — surface which of the schedule's configured recipients are
  // currently on the bounce / unsubscribe / spam-complaint suppression list
  // so finance can see "2 paused" on the dashboard without parsing the
  // run-history errorMessage.
  const pausedRecipients = schedule
    ? await loadPausedRecipientsForOrg(orgId, Array.isArray(schedule.recipients) ? schedule.recipients as string[] : [])
    : [];

  // Task #1747 — surface the resolved digest language *per recipient* so
  // the editor can show "<email> → English" rows and a subtle hint when a
  // recipient's own user-language preference differs from the digest
  // language. Display-only enrichment; the cron still renders one
  // language for everyone.
  const recipientLanguages = schedule
    ? await loadRecipientLanguagesForOrg(
        Array.isArray(schedule.recipients) ? schedule.recipients as string[] : [],
        resolvedLanguage,
      )
    : [];

  res.json({
    schedule: schedule ?? null,
    history,
    language: {
      configured: configuredLanguage,
      resolved: resolvedLanguage,
      isFallback,
    },
    pausedRecipients,
    recipientLanguages,
  });
});

router.put("/admin/wallet-topup-refunds/email-schedule", async (req: Request, res: Response) => {
  const orgId = await parseAutoRefundScheduleOrgId(req, res);
  if (orgId == null) return;

  const body = req.body as { frequency?: string; recipients?: unknown; enabled?: boolean };
  const frequency = String(body.frequency ?? "").toLowerCase();
  if (!WALLET_REFUND_SCHEDULE_FREQUENCIES.has(frequency)) {
    res.status(400).json({ error: "frequency must be 'weekly' or 'monthly'" });
    return;
  }
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : [];
  const recipients: string[] = [];
  for (const r of recipientsRaw) {
    const s = String(r ?? "").trim();
    if (!s) continue;
    if (!WALLET_REFUND_EMAIL_RE.test(s)) {
      res.status(400).json({ error: `invalid recipient email: ${s}` });
      return;
    }
    if (!recipients.includes(s)) recipients.push(s);
  }
  if (recipients.length === 0) {
    res.status(400).json({ error: "at least one recipient email is required" });
    return;
  }
  if (recipients.length > 20) {
    res.status(400).json({ error: "no more than 20 recipients per schedule" });
    return;
  }
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);

  const now = new Date();
  const userId = getUserId(req);

  const [existing] = await db.select().from(walletTopupRefundEmailSchedulesTable)
    .where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));

  let saved;
  if (existing) {
    const freqChanged = existing.frequency !== frequency;
    const reEnabled = !existing.enabled && enabled;
    const nextRunAt = (freqChanged || reEnabled || !existing.nextRunAt)
      ? computeWalletTopupRefundNextRunAt(frequency, now)
      : existing.nextRunAt;
    const [row] = await db.update(walletTopupRefundEmailSchedulesTable).set({
      frequency, recipients, enabled, nextRunAt, updatedAt: now,
    }).where(eq(walletTopupRefundEmailSchedulesTable.id, existing.id)).returning();
    saved = row;
  } else {
    const [row] = await db.insert(walletTopupRefundEmailSchedulesTable).values({
      organizationId: orgId,
      frequency,
      recipients,
      enabled,
      nextRunAt: computeWalletTopupRefundNextRunAt(frequency, now),
      createdByUserId: userId ?? null,
    }).returning();
    saved = row;
  }

  // Task #1443 — surface any just-saved recipients that are already on the
  // org's suppression list so the editor can immediately warn finance and
  // offer the "remove from suppression list" affordance, rather than waiting
  // for the next cron tick to silently drop them.
  const pausedRecipients = await loadPausedRecipientsForOrg(
    orgId,
    Array.isArray(saved.recipients) ? saved.recipients as string[] : [],
  );
  res.json({ schedule: saved, pausedRecipients });
});

/**
 * Lift the email suppression that paused this address (Task #1443).
 *
 * Used by the dashboard's "remove from suppression list" button next to a
 * paused recipient chip — finance has triaged the bounce/unsubscribe and
 * confirmed the address is fine to mail again. We look up the suppression
 * by `(orgId, lowerCase(email))` so the caller doesn't need to know the
 * suppression's primary key, and we delete every matching row even though
 * `email_suppressions_unique` should only allow one (defensive).
 *
 * Note: scheduled `recipients` were *not* automatically pruned at the
 * moment of suppression unless the cron actually attempted a send — so
 * lifting the suppression is enough; the address is already on the
 * configured recipients list and will be picked up on the next run.
 */
router.post("/admin/wallet-topup-refunds/email-schedule/unsuppress", async (req: Request, res: Response) => {
  const orgId = await parseAutoRefundScheduleOrgId(req, res);
  if (orgId == null) return;

  const rawEmail = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!rawEmail || !WALLET_REFUND_EMAIL_RE.test(rawEmail)) {
    res.status(400).json({ error: "valid email is required" });
    return;
  }
  const lower = rawEmail.toLowerCase();

  const deleted = await db.delete(emailSuppressionsTable).where(and(
    eq(emailSuppressionsTable.organizationId, orgId),
    eq(emailSuppressionsTable.email, lower),
  )).returning({ id: emailSuppressionsTable.id });

  // If the recipient was already pruned from the schedule by an earlier
  // cron run (Task #1233's auto-pause), restore it so finance doesn't have
  // to re-type the address after lifting the suppression.
  let restoredToSchedule = false;
  const [schedule] = await db.select().from(walletTopupRefundEmailSchedulesTable)
    .where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  if (schedule) {
    const recipients = Array.isArray(schedule.recipients) ? schedule.recipients as string[] : [];
    const alreadyOnList = recipients.some(r => r.trim().toLowerCase() === lower);
    if (!alreadyOnList && recipients.length < 20) {
      await db.update(walletTopupRefundEmailSchedulesTable).set({
        recipients: [...recipients, rawEmail],
        updatedAt: new Date(),
      }).where(eq(walletTopupRefundEmailSchedulesTable.id, schedule.id));
      restoredToSchedule = true;
    }
  }

  res.json({ ok: true, removed: deleted.length, restoredToSchedule });
});

router.delete("/admin/wallet-topup-refunds/email-schedule", async (req: Request, res: Response) => {
  const orgId = await parseAutoRefundScheduleOrgId(req, res);
  if (orgId == null) return;
  await db.delete(walletTopupRefundEmailSchedulesTable)
    .where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  res.json({ ok: true });
});

router.get("/admin/wallet-topup-refunds/email-schedule/preview", async (req: Request, res: Response) => {
  const orgId = await parseAutoRefundScheduleOrgId(req, res);
  if (orgId == null) return;

  // Task #2161 — optional `lang` query param so a treasurer can render
  // the in-page preview modal in any of the 21 supported translations
  // without first sending themselves an email or mutating the org's
  // `defaultLanguage`. Mirrors the validation on the sibling
  // `send-preview` POST: omitted/empty falls through to the existing
  // org-default behaviour (one-click "Preview" is unchanged); an
  // explicitly provided value that isn't in the digest's pack is a 400
  // rather than a silent English fallback (defeats the point of the
  // picker).
  const rawLang = req.query.lang;
  let overrideLang: string | null = null;
  if (rawLang !== undefined && rawLang !== "") {
    if (typeof rawLang !== "string" || !isSupportedWalletTopupRefundDigestLang(rawLang)) {
      res.status(400).json({
        error: `Unsupported preview language. Pick one of: ${WALLET_TOPUP_REFUND_DIGEST_LANGS.join(", ")}`,
      });
      return;
    }
    overrideLang = rawLang;
  }

  const [schedule] = await db.select().from(walletTopupRefundEmailSchedulesTable)
    .where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  if (!schedule) {
    res.status(404).json({ error: "No wallet auto-refund schedule configured" });
    return;
  }

  // Task #1232 — load org `defaultLanguage` alongside the name so the
  // preview renders in the same locale the cron will email out.
  const [org] = await db.select({
    name: organizationsTable.name,
    defaultLanguage: organizationsTable.defaultLanguage,
  })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000);

  // Task #2161 — the explicit picker selection takes precedence over the
  // org default for THIS preview only. Both the schedule row and the
  // org's `defaultLanguage` are untouched, so the next real cron run
  // still uses the org default.
  const langForPreview = overrideLang ?? (org?.defaultLanguage ?? null);

  const { rowCount, currencyCount } = await buildWalletTopupRefundCsv({
    orgId, from: periodStart, to: now,
    // Task #1435 — preview the CSV header column labels in the same locale
    // the cron will email out (matches the email body's `lang` resolution).
    lang: langForPreview,
  });

  const { buildWalletTopupRefundScheduleEmailContent } = await import("../lib/mailer");
  const { subject, html, filename } = buildWalletTopupRefundScheduleEmailContent({
    orgName: org?.name ?? "KHARAGOLF",
    frequency: schedule.frequency as "weekly" | "monthly",
    periodStart,
    periodEnd: now,
    rowCount,
    currencyCount,
    lang: langForPreview,
  });

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
  });
});

router.post("/admin/wallet-topup-refunds/email-schedule/send-now", async (req: Request, res: Response) => {
  const orgId = await parseAutoRefundScheduleOrgId(req, res);
  if (orgId == null) return;

  const userId = getUserId(req);
  if (userId == null) {
    res.status(401).json({ error: "Authentication required to send the digest" });
    return;
  }

  // Task #2174 — Per-(user, org) cooldown so a stuck UI loop or a quick
  // double-click can't blast the digest to every configured recipient.
  // Mirrors the send-preview cooldown shape (Task #1748): checked BEFORE
  // we look up the schedule and BEFORE `runOneWalletTopupRefundEmailSchedule`
  // so a rate-limited caller burns neither DB work nor real recipient
  // emails.
  const rateLimit = await checkAndConsume(
    walletTopupRefundSendNowScopes(userId, orgId),
  );
  if (!rateLimit.ok) {
    res.setHeader("Retry-After", String(rateLimit.retryAfter));
    res.status(429).json({
      error: `You can only send the digest once per ${WALLET_TOPUP_REFUND_SEND_NOW_COOLDOWN_SECONDS} seconds. Try again in ${rateLimit.retryAfter} second${rateLimit.retryAfter === 1 ? "" : "s"}.`,
      retryAfter: rateLimit.retryAfter,
      cooldownSeconds: WALLET_TOPUP_REFUND_SEND_NOW_COOLDOWN_SECONDS,
    });
    return;
  }

  const [schedule] = await db.select().from(walletTopupRefundEmailSchedulesTable)
    .where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  if (!schedule) {
    res.status(404).json({ error: "No wallet auto-refund schedule configured" });
    return;
  }

  const result = await runOneWalletTopupRefundEmailSchedule(schedule.id);
  res.json(result);
});

/**
 * Task #1436 — "Send preview" / "send a test in this language".
 *
 * Posts the same digest payload `runOneWalletTopupRefundEmailSchedule`
 * would send to finance, but addressed exclusively to the requesting
 * treasurer's own inbox and rendered in the org's resolved
 * `defaultLanguage`. Lets a treasurer who set the schedule up before the
 * org's default language was changed see exactly which translation
 * recipients will start receiving — without waiting for the next cron
 * tick or wiring themselves into the recipient list.
 *
 * This endpoint deliberately does NOT:
 *   - record a row in `wallet_topup_refund_email_runs` (it is not a real
 *     run; counting it as one would skew the "last sent" / consecutive-
 *     failure heuristics used by the bounce-aware failure alerting in
 *     Task #1233)
 *   - advance `lastSentAt` / `nextRunAt` on the schedule (cron cadence is
 *     unaffected by treasurers checking the language)
 *   - apply the suppression-list pause logic (the requester is sending to
 *     themselves; if their own inbox is on the org's suppression list
 *     they'll see the failure surfaced as an HTTP error and can fix it)
 *
 * The CSV is the same one finance would receive — built from the same
 * elapsed-period window the next scheduled run will use — so the preview
 * row count and currency count match what the recipients will actually
 * see.
 */
router.post("/admin/wallet-topup-refunds/email-schedule/send-preview", async (req: Request, res: Response) => {
  const orgId = await parseAutoRefundScheduleOrgId(req, res);
  if (orgId == null) return;

  const userId = getUserId(req);
  if (userId == null) {
    res.status(401).json({ error: "Authentication required to send a preview" });
    return;
  }

  // Task #1746 — optional `lang` body param so a treasurer can spot-check
  // the digest in any of the 21 supported translations without first
  // mutating the org's `defaultLanguage`. Omitted/empty falls through to
  // the existing org-default behaviour (one-click preview is unchanged).
  // An explicitly provided value that isn't in the digest's pack is a
  // 400 — silently falling back to English would defeat the point of
  // letting the treasurer pick a specific translation to verify.
  // Validated BEFORE the rate-limit consume so a malformed request
  // doesn't burn the user's per-(user, org) preview token.
  const body = (req.body ?? {}) as { lang?: unknown };
  let overrideLang: string | null = null;
  if (body.lang !== undefined && body.lang !== null && body.lang !== "") {
    if (typeof body.lang !== "string" || !isSupportedWalletTopupRefundDigestLang(body.lang)) {
      res.status(400).json({
        error: `Unsupported preview language. Pick one of: ${WALLET_TOPUP_REFUND_DIGEST_LANGS.join(", ")}`,
      });
      return;
    }
    overrideLang = body.lang;
  }

  // Task #1748 — Per-(user, org) cooldown so a stuck UI loop or a quick
  // double-click can't spam the configured inbox. Checked BEFORE we look
  // up the recipient or the schedule so a rate-limited caller doesn't
  // burn DB work either, and BEFORE the mailer call so no email is sent.
  const rateLimit = await checkAndConsume(
    walletTopupRefundSendPreviewScopes(userId, orgId),
  );
  if (!rateLimit.ok) {
    res.setHeader("Retry-After", String(rateLimit.retryAfter));
    res.status(429).json({
      error: `You can only send one preview per ${WALLET_TOPUP_REFUND_SEND_PREVIEW_COOLDOWN_SECONDS} seconds. Try again in ${rateLimit.retryAfter} second${rateLimit.retryAfter === 1 ? "" : "s"}.`,
      retryAfter: rateLimit.retryAfter,
      cooldownSeconds: WALLET_TOPUP_REFUND_SEND_PREVIEW_COOLDOWN_SECONDS,
    });
    return;
  }

  const [user] = await db.select({
    email: appUsersTable.email,
  }).from(appUsersTable).where(eq(appUsersTable.id, userId));
  const recipient = user?.email?.trim();
  if (!recipient) {
    res.status(400).json({
      error: "Your account does not have an email address on file — add one before requesting a preview.",
    });
    return;
  }

  const [schedule] = await db.select().from(walletTopupRefundEmailSchedulesTable)
    .where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  if (!schedule) {
    res.status(404).json({ error: "No wallet auto-refund schedule configured" });
    return;
  }

  const [org] = await db.select({
    name: organizationsTable.name,
    defaultLanguage: organizationsTable.defaultLanguage,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000);

  const { csv, rowCount, currencyCount } = await buildWalletTopupRefundCsv({
    orgId, from: periodStart, to: now,
  });

  // The override (if any) takes precedence over the org default for THIS
  // preview only. The schedule row and the org's `defaultLanguage` are
  // both untouched, so the next real cron run still uses the org default.
  const langForEmail = overrideLang ?? (org?.defaultLanguage ?? null);
  const resolvedLanguage = resolveWalletTopupRefundDigestLang(langForEmail);

  try {
    const { sendWalletTopupRefundScheduleEmail } = await import("../lib/mailer");
    await sendWalletTopupRefundScheduleEmail({
      to: recipient,
      orgName: org?.name ?? "KHARAGOLF",
      frequency: schedule.frequency as "weekly" | "monthly",
      periodStart,
      periodEnd: now,
      rowCount,
      currencyCount,
      csv,
      lang: langForEmail,
      branding: {
        orgName: org?.name ?? "KHARAGOLF",
        logoUrl: org?.logoUrl ?? undefined,
        primaryColor: org?.primaryColor ?? undefined,
        orgId,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, scheduleId: schedule.id, orgId }, "[wallet-topup-refund-email] preview send failed");
    res.status(502).json({ error: `Preview send failed: ${message}` });
    return;
  }

  res.json({
    sentTo: recipient,
    language: resolvedLanguage,
    rowCount,
    currencyCount,
    frequency: schedule.frequency,
    periodStart: periodStart.toISOString(),
    periodEnd: now.toISOString(),
  });
});

/**
 * Execute one wallet auto-refund schedule end-to-end: build the elapsed-
 * period CSV, email it to recipients, record the run, and advance the
 * cadence even on failure (so a broken inbox does not get hammered every
 * poll). Shared by the cron poller and the manual send-now endpoint.
 *
 * Task #1233 — bounce-aware. Before sending, we filter recipients against
 * `email_suppressions` (populated by the Postmark bounce webhook); any
 * suppressed recipient is removed from the schedule's stored recipients
 * list ("paused") so the next run does not retry a known-bad inbox. When
 * the run ends in `failed` (mailer error) OR `skipped` because every
 * recipient is now paused, we dispatch `wallet.refund.digest.failed` to
 * the org's admins/treasurers so finance can fix the recipient list
 * before another period of digests is silently dropped.
 */
export async function runOneWalletTopupRefundEmailSchedule(scheduleId: number): Promise<{
  status: "sent" | "failed" | "skipped";
  rowCount: number;
  currencyCount: number;
  recipients: string[];
  errorMessage?: string;
  pausedRecipients?: string[];
}> {
  const [schedule] = await db.select().from(walletTopupRefundEmailSchedulesTable)
    .where(eq(walletTopupRefundEmailSchedulesTable.id, scheduleId));
  if (!schedule) {
    return { status: "skipped", rowCount: 0, currencyCount: 0, recipients: [], errorMessage: "schedule not found" };
  }

  const configuredRecipients = Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [];
  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000);

  if (configuredRecipients.length === 0) {
    const errorMessage = "no recipients configured";
    await db.insert(walletTopupRefundEmailRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients: [],
      rowCount: 0,
      currencyCount: 0,
      status: "skipped",
      errorMessage,
      // Task #1759 — no suppression filter ran on this branch (the
      // schedule's configured list was already empty), so there's
      // nothing to snapshot.
      pausedRecipients: [],
      // Task #2170 — no recipients were attributed to any language on
      // this branch since the digest never went out.
      recipientLanguages: [],
    });
    // Task #1233 — advance the cadence even on this skipped path. Since
    // the bounce-aware pause logic below can auto-empty a schedule's
    // recipient list, every subsequent poll would otherwise re-enter
    // this branch and fire a fresh skipped run on every cron tick.
    // Advancing `nextRunAt` keeps the cadence honest (one undelivered
    // period per scheduled interval) and matches the failure path.
    await db.update(walletTopupRefundEmailSchedulesTable).set({
      lastSentAt: now,
      nextRunAt: computeWalletTopupRefundNextRunAt(schedule.frequency, now),
      updatedAt: now,
    }).where(eq(walletTopupRefundEmailSchedulesTable.id, schedule.id));
    // Task #1233 — also dispatch the failure notification here. After
    // the bounce-aware pause logic auto-empties a schedule, every
    // subsequent cadence still has nothing to send; admins need to keep
    // being reminded each cadence (escalating consecutive count) until
    // they fix the recipient list, otherwise the first alert is
    // delivered then forgotten. The cadence advancement above ensures
    // we only alert once per scheduled interval, not once per cron tick.
    const [orgForAlert] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, schedule.organizationId));
    await notifyAdminsOfRefundDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      status: "skipped",
      errorMessage,
      pausedRecipients: [],
      org: orgForAlert ?? null,
    });
    return { status: "skipped", rowCount: 0, currencyCount: 0, recipients: [], errorMessage };
  }

  // ── Bounce-aware recipient filter (Task #1233) ────────────────────────
  // Pull every suppression row for this org whose email matches one of the
  // configured recipients, lower-cased. Anything that hits a suppression
  // is "paused" — removed from both this run's send list and persisted
  // back to the schedule so future runs do not keep hammering a dead
  // inbox. We treat any suppression reason (bounced / spam_complaint /
  // unsubscribed) as cause to pause: each one means a human or a mail
  // server has explicitly rejected this address, and silently retrying
  // is exactly the failure mode finance was missing.
  const lowerToOriginal = new Map<string, string>();
  for (const r of configuredRecipients) {
    const lower = r.trim().toLowerCase();
    if (lower) lowerToOriginal.set(lower, r);
  }
  const lowerList = [...lowerToOriginal.keys()];
  // Task #1759 — capture the suppression metadata (reason / bounceType /
  // description) at lookup time so we can persist a per-recipient snapshot
  // onto the run row. The schedule-level chip already shows this metadata
  // live; the run history needs the *historical* version because finance
  // may later lift the suppression and the chip would otherwise vanish
  // from past runs.
  const suppressionByLower = new Map<string, { reason: string; bounceType: string | null; description: string | null }>();
  if (lowerList.length > 0) {
    try {
      const supRows = await db
        .select({
          email: emailSuppressionsTable.email,
          reason: emailSuppressionsTable.reason,
          bounceType: emailSuppressionsTable.bounceType,
          description: emailSuppressionsTable.description,
        })
        .from(emailSuppressionsTable)
        .where(and(
          eq(emailSuppressionsTable.organizationId, schedule.organizationId),
          inArray(emailSuppressionsTable.email, lowerList),
        ));
      for (const r of supRows) {
        suppressionByLower.set(r.email.toLowerCase(), {
          reason: r.reason,
          bounceType: r.bounceType,
          description: r.description,
        });
      }
    } catch (err) {
      logger.warn({ err, scheduleId: schedule.id }, "[wallet-topup-refund-email] suppression lookup failed; sending to all configured recipients");
      suppressionByLower.clear();
    }
  }
  const recipients: string[] = [];
  const pausedRecipients: string[] = [];
  // Task #1759 — per-run snapshot persisted onto
  // `wallet_topup_refund_email_runs.paused_recipients` so the dashboard's
  // history table can show "who was paused at the moment of this run"
  // even if the suppression is later lifted.
  const pausedRecipientsSnapshot: WalletTopupRefundEmailRunPausedRecipient[] = [];
  for (const [lower, original] of lowerToOriginal) {
    const hit = suppressionByLower.get(lower);
    if (hit) {
      pausedRecipients.push(original);
      pausedRecipientsSnapshot.push({
        email: original,
        reason: hit.reason,
        bounceType: hit.bounceType,
        description: hit.description,
      });
    } else {
      recipients.push(original);
    }
  }
  // Persist the trimmed recipient list back to the schedule so newly
  // bounced addresses are removed for the *next* run too. We only write
  // when the list actually changed to avoid touching `updatedAt` on a
  // no-op poll.
  if (pausedRecipients.length > 0) {
    try {
      await db.update(walletTopupRefundEmailSchedulesTable).set({
        recipients,
        updatedAt: now,
      }).where(eq(walletTopupRefundEmailSchedulesTable.id, schedule.id));
    } catch (err) {
      logger.warn({ err, scheduleId: schedule.id }, "[wallet-topup-refund-email] failed to persist paused recipients");
    }
  }

  // Task #1232 + #1233 — single org lookup feeding both the email's
  // localized rendering (`defaultLanguage`) and the bounce-attribution
  // branding bundle (`logoUrl` / `primaryColor` / `orgId`). Mirrors the
  // resolution pattern Task #1099 uses for admin emails.
  const [org] = await db.select({
    name: organizationsTable.name,
    defaultLanguage: organizationsTable.defaultLanguage,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
  }).from(organizationsTable).where(eq(organizationsTable.id, schedule.organizationId));

  // Every recipient on the configured list ended up suppressed — we have
  // nothing to send, but we DO need to alert admins so they can replace
  // the dead inboxes before another digest period quietly elapses.
  if (recipients.length === 0) {
    const errorMessage = `paused all configured recipients (${pausedRecipients.join(", ")}) — every address is on the bounce / unsubscribe suppression list`;
    await db.insert(walletTopupRefundEmailRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients: [],
      rowCount: 0,
      currencyCount: 0,
      status: "skipped",
      errorMessage,
      // Task #1759 — every configured recipient was paused; snapshot the
      // full list (with reason metadata) so the dashboard's history table
      // can show the chip even if the suppression is later lifted.
      pausedRecipients: pausedRecipientsSnapshot,
      // Task #2170 — nothing was sent, so no recipient was attributed
      // to any language on this branch.
      recipientLanguages: [],
    });
    await db.update(walletTopupRefundEmailSchedulesTable).set({
      lastSentAt: now,
      nextRunAt: computeWalletTopupRefundNextRunAt(schedule.frequency, now),
      updatedAt: now,
    }).where(eq(walletTopupRefundEmailSchedulesTable.id, schedule.id));
    await notifyAdminsOfRefundDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      status: "skipped",
      errorMessage,
      pausedRecipients,
      org: org ?? null,
    });
    return { status: "skipped", rowCount: 0, currencyCount: 0, recipients: [], errorMessage, pausedRecipients };
  }

  // Task #2170 — group the surviving recipients by their resolved
  // digest language so each recipient receives the digest in their own
  // preferred language (with the org's resolved `defaultLanguage` as
  // fallback for external recipients and for users whose stored
  // preference is null or unsupported). Without this grouping the cron
  // would render a single org-wide blast and finance teams whose
  // members had set a per-user `preferredLanguage` would silently
  // receive the wrong translation.
  const orgResolvedDigestLanguage = resolveWalletTopupRefundDigestLang(org?.defaultLanguage ?? null);
  const langByLowerEmail = await loadAppUserPreferredLanguagesByLowerEmail(recipients);
  // Map: resolved language code → ordered list of recipient emails (in
  // the casing the treasurer typed) that should receive that language.
  const recipientsByLang = new Map<string, string[]>();
  // Per-recipient language attribution snapshot persisted onto the run
  // row so the history dashboard stays accurate even after a user
  // later changes their `preferredLanguage`.
  const recipientLanguagesSnapshot: WalletTopupRefundEmailRunRecipientLanguage[] = [];
  for (const r of recipients) {
    const userPref = langByLowerEmail.get(r.trim().toLowerCase()) ?? null;
    const resolved = resolveRecipientDigestLanguage(userPref, orgResolvedDigestLanguage);
    const bucket = recipientsByLang.get(resolved);
    if (bucket) bucket.push(r);
    else recipientsByLang.set(resolved, [r]);
    recipientLanguagesSnapshot.push({ email: r, language: resolved });
  }

  // The CSV is byte-identical apart from the localized column headers
  // (column order is fixed). Cache one CSV per language we actually
  // need so we don't re-run the rows query for every group when the
  // entire org speaks one language (the common case).
  const csvByLang = new Map<string, { csv: string; rowCount: number; currencyCount: number }>();
  let aggregateRowCount = 0;
  let aggregateCurrencyCount = 0;
  for (const lang of recipientsByLang.keys()) {
    const built = await buildWalletTopupRefundCsv({
      orgId: schedule.organizationId,
      from: periodStart,
      to: now,
      // Task #1435 — render the CSV column headers in the same locale
      // as the email body (resolved per-language group as of Task
      // #2170).
      lang,
    });
    csvByLang.set(lang, built);
    // The row/currency counts are identical across languages because
    // the underlying data set is the same; remember the last build
    // for the run row's aggregate counters.
    aggregateRowCount = built.rowCount;
    aggregateCurrencyCount = built.currencyCount;
  }

  let status: "sent" | "failed" = "sent";
  // We attempt every language group sequentially so a single bad group
  // (e.g. one inbox the mailer rejects) does not silently swallow the
  // digest for the *other* groups. Errors are aggregated into one
  // semicolon-joined message so the existing failure-notify pathway
  // and run-history `errorMessage` column keep their established shape.
  const errorMessages: string[] = [];
  const sentRecipients: string[] = [];

  const { sendWalletTopupRefundScheduleEmail } = await import("../lib/mailer");
  // Iterate languages in a stable order so logs and run rows are
  // deterministic across polls (a Map preserves insertion order, but
  // sorting alphabetically guards against any future re-ordering of
  // the recipient list mutating the dispatch sequence).
  const langKeys = [...recipientsByLang.keys()].sort();
  for (const lang of langKeys) {
    const groupRecipients = recipientsByLang.get(lang) ?? [];
    if (groupRecipients.length === 0) continue;
    const built = csvByLang.get(lang);
    if (!built) continue;
    try {
      await sendWalletTopupRefundScheduleEmail({
        to: groupRecipients,
        orgName: org?.name ?? "KHARAGOLF",
        frequency: schedule.frequency as "weekly" | "monthly",
        periodStart,
        periodEnd: now,
        rowCount: built.rowCount,
        currencyCount: built.currencyCount,
        csv: built.csv,
        // Task #2170 — render the digest in the resolved per-recipient
        // language for this group rather than a single org-wide value.
        lang,
        // Task #1233 — thread orgId through so bounces from this digest are
        // attributed back to the right club via Postmark `Metadata.orgId`,
        // which lets the bounce webhook write the suppression row that
        // *future* runs will then pause on.
        branding: {
          orgName: org?.name ?? "KHARAGOLF",
          logoUrl: org?.logoUrl ?? undefined,
          primaryColor: org?.primaryColor ?? undefined,
          orgId: schedule.organizationId,
        },
      });
      sentRecipients.push(...groupRecipients);
    } catch (err) {
      status = "failed";
      const message = err instanceof Error ? err.message : String(err);
      errorMessages.push(`[${lang}] ${message}`);
      logger.warn(
        { err, scheduleId: schedule.id, lang, groupRecipientCount: groupRecipients.length },
        "[wallet-topup-refund-email] send failed for language group",
      );
    }
  }

  const errorMessage = errorMessages.length > 0 ? errorMessages.join("; ") : undefined;
  // Use the aggregate counts from any successfully built CSV so the run
  // row reflects the actual period totals. When every group failed
  // before we built a CSV (impossible in practice — buildWalletTopupRefundCsv
  // does not throw — but defensive nonetheless) fall back to zero.
  const rowCount = aggregateRowCount;
  const currencyCount = aggregateCurrencyCount;

  // When we paused some (but not all) recipients, surface that in the run
  // row's errorMessage even on a `sent` status so the dashboard history
  // table makes the pause visible.
  let runErrorMessage: string | undefined = errorMessage;
  if (pausedRecipients.length > 0) {
    const pauseNote = `paused ${pausedRecipients.length} bounced/unsubscribed recipient(s): ${pausedRecipients.join(", ")}`;
    runErrorMessage = runErrorMessage ? `${runErrorMessage}; ${pauseNote}` : pauseNote;
  }

  await db.insert(walletTopupRefundEmailRunsTable).values({
    scheduleId: schedule.id,
    organizationId: schedule.organizationId,
    periodStart,
    periodEnd: now,
    // Task #2170 — record the recipients we *actually* sent to (a
    // language group whose mailer call threw is excluded so the run
    // row's `recipients` column stays a faithful "delivered to" list,
    // matching the pre-2170 contract where a thrown send produced an
    // empty `recipients` array on a failed run).
    recipients: sentRecipients,
    rowCount,
    currencyCount,
    status,
    errorMessage: runErrorMessage,
    // Task #1759 — snapshot the per-recipient pause metadata onto the
    // run row so the dashboard's history table can render the same chip
    // (with reason + bounceType) the schedule editor uses, and the row
    // stays accurate even after the suppression is later lifted.
    pausedRecipients: pausedRecipientsSnapshot,
    // Task #2170 — snapshot the per-recipient language attribution so
    // the history dashboard can show "who got which translation" even
    // after the user later changes their preference. We persist the
    // *attempted* attribution (the full survivor list) so a partial
    // language-group failure still records why each address was bucketed
    // the way it was; the run row's `recipients` column, which only
    // includes successful sends, distinguishes attempted from delivered.
    recipientLanguages: recipientLanguagesSnapshot,
  });

  await db.update(walletTopupRefundEmailSchedulesTable).set({
    lastSentAt: now,
    nextRunAt: computeWalletTopupRefundNextRunAt(schedule.frequency, now),
    updatedAt: now,
  }).where(eq(walletTopupRefundEmailSchedulesTable.id, schedule.id));

  if (status === "failed") {
    await notifyAdminsOfRefundDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      status: "failed",
      errorMessage: errorMessage ?? "unknown error",
      pausedRecipients,
      org: org ?? null,
    });
  }

  // Task #2170 — keep the function return contract aligned with the run row:
  // `recipients` reflects only the addresses that actually received the
  // digest, not the broader attempted set, so callers reading the API
  // response see the same delivered-only list as the run-history dashboard.
  return { status, rowCount, currencyCount, recipients: sentRecipients, errorMessage, pausedRecipients: pausedRecipients.length > 0 ? pausedRecipients : undefined };
}

/**
 * Task #1233 — alert org admins / treasurers that the wallet auto-refund
 * digest failed (or was paused entirely because every recipient bounced).
 *
 * Recipients are the union of direct `org_admin` app_users and
 * `org_memberships` rows whose role is `org_admin` or `treasurer` —
 * mirroring the recipient set used by the bounced-levy digest cron so a
 * club's finance contacts get told about *every* dropped digest by the
 * same people they already receive bounce alerts from.
 *
 * Includes the consecutive-failure count (number of non-`sent` runs at
 * the head of the run history for this schedule) so the alert escalates
 * naturally — the third "still broken" email in a row makes that point
 * itself without us spamming admins on every poll.
 */
async function notifyAdminsOfRefundDigestFailure(opts: {
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
        inArray(orgMembershipsTable.role, ["org_admin", "treasurer"]),
      ));
    const userIds = Array.from(new Set(
      [...directAdmins, ...memberAdmins].map(r => r.userId).filter((n): n is number => typeof n === "number"),
    ));
    if (userIds.length === 0) {
      logger.info({ orgId: opts.orgId, scheduleId: opts.scheduleId }, "[wallet-topup-refund-email] no admin recipients for failure alert");
      return;
    }

    // Count consecutive non-`sent` runs at the head of the run history.
    // We include this run itself (just inserted) so the first failure
    // reports "1 consecutive failure" and a recovery resets the counter
    // on the next successful run.
    let consecutiveFailures = 1;
    try {
      const recentRuns = await db
        .select({ status: walletTopupRefundEmailRunsTable.status })
        .from(walletTopupRefundEmailRunsTable)
        .where(eq(walletTopupRefundEmailRunsTable.scheduleId, opts.scheduleId))
        .orderBy(desc(walletTopupRefundEmailRunsTable.sentAt))
        .limit(20);
      consecutiveFailures = 0;
      for (const r of recentRuns) {
        if (r.status === "sent") break;
        consecutiveFailures += 1;
      }
      if (consecutiveFailures < 1) consecutiveFailures = 1;
    } catch (err) {
      logger.warn({ err, scheduleId: opts.scheduleId }, "[wallet-topup-refund-email] consecutive-failure count lookup failed");
    }

    const orgName = opts.org?.name ?? "your club";
    const title = opts.status === "skipped"
      ? `Wallet auto-refund digest paused — every recipient is bouncing (${orgName})`
      : `Wallet auto-refund digest failed to send (${orgName})`;
    const reasonLine = opts.status === "skipped"
      ? `Every configured recipient is on the bounce / unsubscribe list, so this period's digest was not sent. Paused recipients: ${opts.pausedRecipients.join(", ") || "(none)"}.`
      : `The mailer rejected the send: ${opts.errorMessage}`;
    const pausedLine = opts.pausedRecipients.length > 0 && opts.status !== "skipped"
      ? ` We also paused ${opts.pausedRecipients.length} previously-bouncing recipient(s) from future runs: ${opts.pausedRecipients.join(", ")}.`
      : "";
    const consecutiveLine = consecutiveFailures > 1
      ? ` This is the ${consecutiveFailures}th consecutive run that did not deliver — please update the recipient list in Finance → Auto-refunded wallet top-ups.`
      : " Open Finance → Auto-refunded wallet top-ups to update the recipient list.";
    const body = `${reasonLine}${pausedLine}${consecutiveLine}`;
    const safeBody = escapeHtmlForRefundDigestAlert(body);
    const safeTitle = escapeHtmlForRefundDigestAlert(title);
    const emailHtml = `<div style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#fff;padding:24px;max-width:560px;margin:0 auto;border-radius:12px;">
        <h2 style="margin:0 0 12px;font-size:18px;color:#f87171;">${safeTitle}</h2>
        <p style="margin:0 0 16px;color:#d1d5db;line-height:1.5;">${safeBody}</p>
        <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Schedule id: ${opts.scheduleId} · Status: ${opts.status} · Consecutive failures: ${consecutiveFailures}</p>
      </div>`;

    const { dispatchNotification } = await import("../lib/notifyDispatch");
    await dispatchNotification("wallet.refund.digest.failed", userIds, {
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
      // Task #1734 — opt this dispatch into the per-recipient
      // "Mute this alert" footer link + List-Unsubscribe headers.
      // Carries the org id only so the confirmation page can name
      // the club; the underlying flag flip is user-scoped.
      eventMuteOrgId: opts.orgId,
    });
  } catch (err) {
    logger.warn({ err, scheduleId: opts.scheduleId }, "[wallet-topup-refund-email] admin failure dispatch failed");
  }
}

function escapeHtmlForRefundDigestAlert(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Cron entry-point for wallet auto-refund digests (Task #1073). */
export async function runDueWalletTopupRefundEmailSchedules(): Promise<void> {
  const now = new Date();
  const due = await db.select({ id: walletTopupRefundEmailSchedulesTable.id })
    .from(walletTopupRefundEmailSchedulesTable)
    .where(and(
      eq(walletTopupRefundEmailSchedulesTable.enabled, true),
      lte(walletTopupRefundEmailSchedulesTable.nextRunAt, now),
    ));
  for (const row of due) {
    try {
      await runOneWalletTopupRefundEmailSchedule(row.id);
    } catch (err) {
      logger.warn({ err, scheduleId: row.id }, "[wallet-topup-refund-email] schedule poll error");
    }
  }
}

// ─── WALLET WITHDRAWALS (Task #770) ────────────────────────────────────
//
// Members can withdraw their club-wallet credit back to a saved UPI /
// bank account via RazorpayX payouts. The flow:
//
//   1. Member registers a payout account once per club:
//      POST /wallet/payout-account { method: 'upi'|'bank_account', ... }
//      → creates a Razorpay contact + fund account, stored on
//        wallet_payout_accounts.
//   2. Member requests a withdrawal:
//      POST /wallet/withdraw { organizationId, amount, currency }
//      → KYC + limit checks, debits wallet synchronously, dispatches
//        a RazorpayX payout. Returns the new withdrawal row.
//   3. Lifecycle is reconciled by the existing
//      /api/webhooks/razorpay-payout webhook (extended to recognise
//      `walletwd_<id>` reference ids). Failed/reversed payouts auto-
//      refund the wallet so the member is never out of pocket.

// GET /wallet/payout-account?organizationId=
router.get("/wallet/payout-account", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const orgId = req.query.organizationId ? Number(req.query.organizationId) : null;
  if (!orgId) { { res.status(400).json({ error: "organizationId is required" }); return; } }
  const [row] = await db.select().from(walletPayoutAccountsTable).where(and(
    eq(walletPayoutAccountsTable.organizationId, orgId),
    eq(walletPayoutAccountsTable.userId, userId),
  ));
  res.json({
    account: row ? {
      id: row.id,
      method: row.method,
      accountHolderName: row.accountHolderName,
      upiVpa: row.upiVpa,
      bankAccountNumberLast4: row.bankAccountNumber ? row.bankAccountNumber.slice(-4) : null,
      bankIfsc: row.bankIfsc,
      verified: !!row.verifiedAt,
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      verifiedHolderName: row.verifiedHolderName,
      verificationStatus: row.verificationStatus,
      verificationFailureReason: row.verificationFailureReason,
      // Task #1517 — surfaced so the admin "Re-verify now" button on the
      // wallet panel can disable itself when there is nothing to ask
      // Razorpay about (the cron's `loadStaleAccounts` skips these too).
      hasRazorpayFundAccount: !!row.razorpayFundAccountId,
      updatedAt: row.updatedAt.toISOString(),
    } : null,
    limits: {
      minPerTxn: MIN_WITHDRAWAL_INR,
      maxPerTxn: MAX_WITHDRAWAL_PER_TXN_INR,
      maxPerDay: MAX_WITHDRAWAL_DAILY_INR,
      currency: "INR",
    },
  });
});

// POST /wallet/payout-account — register or replace the saved account
router.post("/wallet/payout-account", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const orgId = body.organizationId ? Number(body.organizationId) : null;
  if (!orgId) { { res.status(400).json({ error: "organizationId is required" }); return; } }

  const method = body.method === "upi" || body.method === "bank_account" ? body.method : null;
  if (!method) { { res.status(400).json({ error: "method must be 'upi' or 'bank_account'" }); return; } }
  const accountHolderName = typeof body.accountHolderName === "string" ? body.accountHolderName.trim() : "";
  if (!accountHolderName) { { res.status(400).json({ error: "accountHolderName is required" }); return; } }

  let upiVpa: string | null = null;
  let bankAccountNumber: string | null = null;
  let bankIfsc: string | null = null;
  if (method === "upi") {
    upiVpa = typeof body.upiVpa === "string" ? body.upiVpa.trim() : "";
    if (!upiVpa || !/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upiVpa)) {
      res.status(400).json({ error: "Valid upiVpa required (e.g. name@bank)" }); return;
    }
  } else {
    bankAccountNumber = typeof body.bankAccountNumber === "string" ? body.bankAccountNumber.replace(/\s+/g, "") : "";
    bankIfsc = typeof body.bankIfsc === "string" ? body.bankIfsc.toUpperCase().trim() : "";
    if (!bankAccountNumber || !/^\d{6,20}$/.test(bankAccountNumber)) {
      res.status(400).json({ error: "Valid bankAccountNumber required" }); return;
    }
    if (!bankIfsc || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankIfsc)) {
      res.status(400).json({ error: "Valid bankIfsc required" }); return;
    }
  }

  // Pull email + display name for the Razorpay contact record.
  const [user] = await db.select({ email: appUsersTable.email, displayName: appUsersTable.displayName })
    .from(appUsersTable).where(eq(appUsersTable.id, userId));

  const [existing] = await db.select().from(walletPayoutAccountsTable).where(and(
    eq(walletPayoutAccountsTable.organizationId, orgId),
    eq(walletPayoutAccountsTable.userId, userId),
  ));

  let razorpayContactId = existing?.razorpayContactId ?? null;
  let razorpayFundAccountId: string | null = null;
  try {
    if (!razorpayContactId) {
      const created = await createRazorpayContact({
        name: accountHolderName || user?.displayName || `Member ${userId}`,
        email: user?.email ?? undefined,
        type: "customer",
        reference_id: `walletmember_${orgId}_${userId}`,
        notes: { userId: String(userId), organizationId: String(orgId) },
      });
      razorpayContactId = created.id;
    }
    const fundAccount = method === "upi"
      ? await createRazorpayFundAccount({
          contact_id: razorpayContactId,
          account_type: "vpa",
          vpa: { address: upiVpa! },
        })
      : await createRazorpayFundAccount({
          contact_id: razorpayContactId,
          account_type: "bank_account",
          bank_account: {
            name: accountHolderName,
            ifsc: bankIfsc!,
            account_number: bankAccountNumber!,
          },
        });
    razorpayFundAccountId = fundAccount.id;
  } catch (err) {
    logger.error({ err, userId, orgId }, "[wallet] Failed to register payout account with Razorpay");
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not register payout account" });
    return;
  }

  // Razorpay fund-account validation (Task #965). UPI uses an instant VPA
  // lookup; bank accounts are penny-dropped (₹1 reversed). Until this
  // succeeds the row is NOT considered withdraw-able.
  const verification = await verifyRazorpayPayoutAccount({
    method,
    upiVpa: upiVpa ?? undefined,
    fundAccountId: razorpayFundAccountId,
  });
  if (verification.status !== "verified") {
    logger.warn(
      { userId, orgId, method, status: verification.status, reason: verification.errorMessage },
      "[wallet] Payout account verification did not pass — not persisting",
    );
    res.status(422).json({
      error: verification.errorMessage,
      verification: { status: verification.status, method },
    });
    return;
  }

  const now = new Date();
  const update = {
    method,
    accountHolderName,
    upiVpa: method === "upi" ? upiVpa : null,
    bankAccountNumber: method === "bank_account" ? bankAccountNumber : null,
    bankIfsc: method === "bank_account" ? bankIfsc : null,
    razorpayContactId,
    razorpayFundAccountId,
    verifiedAt: now,
    verifiedHolderName: verification.verifiedHolderName,
    verificationStatus: "verified" as const,
    verificationFailureReason: null,
    updatedAt: now,
  } as const;

  let row;
  if (existing) {
    [row] = await db.update(walletPayoutAccountsTable).set(update)
      .where(eq(walletPayoutAccountsTable.id, existing.id)).returning();
  } else {
    [row] = await db.insert(walletPayoutAccountsTable).values({
      organizationId: orgId, userId, ...update,
    }).returning();
  }
  res.json({
    account: {
      id: row.id,
      method: row.method,
      accountHolderName: row.accountHolderName,
      upiVpa: row.upiVpa,
      bankAccountNumberLast4: row.bankAccountNumber ? row.bankAccountNumber.slice(-4) : null,
      bankIfsc: row.bankIfsc,
      verified: !!row.verifiedAt,
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      verifiedHolderName: row.verifiedHolderName,
      verificationStatus: row.verificationStatus,
      verificationFailureReason: row.verificationFailureReason,
      // Task #1517 — see GET /wallet/payout-account for rationale.
      hasRazorpayFundAccount: !!row.razorpayFundAccountId,
      updatedAt: row.updatedAt.toISOString(),
    },
  });
});

// POST /wallet/withdraw — create a withdrawal: debit wallet + dispatch payout
router.post("/wallet/withdraw", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const orgId = body.organizationId ? Number(body.organizationId) : null;
  const amount = Number(body.amount);
  const currency = (body.currency ? String(body.currency) : "INR").toUpperCase();
  if (!orgId) { { res.status(400).json({ error: "organizationId is required" }); return; } }

  const [account] = await db.select().from(walletPayoutAccountsTable).where(and(
    eq(walletPayoutAccountsTable.organizationId, orgId),
    eq(walletPayoutAccountsTable.userId, userId),
  ));
  if (!account || !account.razorpayFundAccountId) {
    res.status(400).json({ error: "Add a UPI or bank account first", code: "NO_PAYOUT_ACCOUNT" });
    return;
  }
  if (!account.verifiedAt) {
    res.status(400).json({
      error: "Your payout account is not verified yet. Please re-save it to verify with the bank.",
      code: "PAYOUT_ACCOUNT_NOT_VERIFIED",
    });
    return;
  }
  // Task #1288 — the daily wallet payout re-verification cron (Task #1119)
  // flips a previously-verified account's `verificationStatus` to
  // `needs_attention` without clearing `verifiedAt` (so the saved-account
  // banner can keep showing the prior verification timestamp). Without this
  // second guard, a member whose account was just flagged could still slip
  // a withdrawal through until they re-saved. Surface the persisted
  // failure reason so the wallet UI shows the same banner as the
  // saved-account screen.
  if (account.verificationStatus === "needs_attention") {
    res.status(400).json({
      error: account.verificationFailureReason
        ?? "Your payout account needs to be re-verified. Please re-save it to verify with the bank.",
      code: "PAYOUT_ACCOUNT_NEEDS_REVERIFY",
      verificationFailureReason: account.verificationFailureReason ?? null,
    });
    return;
  }

  const limit = await checkWithdrawalLimits({ userId, organizationId: orgId, currency, amount });
  if (!limit.ok) {
    res.status(400).json({ error: limit.reason, code: "LIMIT_EXCEEDED" });
    return;
  }

  const wallet = await getOrCreateWallet(orgId, userId, currency);
  if (Number(wallet.balance) < amount) {
    res.status(400).json({
      error: "INSUFFICIENT_FUNDS",
      balance: Number(wallet.balance),
      required: amount,
      currency,
    });
    return;
  }

  let debit;
  try {
    debit = await debitWalletForWithdrawal({
      walletId: wallet.id,
      organizationId: orgId,
      userId,
      amount,
      currency,
      method: account.method as "upi" | "bank_account",
      payoutAccountId: account.id,
      razorpayFundAccountId: account.razorpayFundAccountId,
    });
  } catch (err) {
    if ((err as Error).message === "INSUFFICIENT_FUNDS") {
      res.status(400).json({ error: "INSUFFICIENT_FUNDS" }); return;
    }
    throw err;
  }

  const dispatch = await dispatchWalletWithdrawal({
    withdrawalId: debit.withdrawalId,
    fundAccountId: account.razorpayFundAccountId,
    amountPaise: Math.round(amount * 100),
    method: account.method as "upi" | "bank_account",
    userId,
    organizationId: orgId,
  });

  // Re-read so the caller sees the latest status (processing or failed-and-refunded).
  const [withdrawal] = await db.select().from(clubWalletWithdrawalsTable)
    .where(eq(clubWalletWithdrawalsTable.id, debit.withdrawalId));
  const [freshWallet] = await db.select().from(clubWalletsTable)
    .where(eq(clubWalletsTable.id, wallet.id));

  // Note: dispatchWalletWithdrawal only returns "processing" or
  // "dispatch_unknown" — known dispatch failures are surfaced via the
  // ambiguous path so we never auto-refund on uncertain Razorpay errors.
  if (dispatch.status === "dispatch_unknown") {
    // The payout may or may not have been created. We deliberately do
    // NOT refund — the webhook (or operator) will reconcile. Surface a
    // clear pending-review message to the user. Note: the wallet WAS
    // debited; if the payout never went through we will refund it
    // automatically once the webhook (or manual reconciliation) confirms.
    res.status(202).json({
      pending: true,
      error: "Your wallet has been debited and the payout was submitted, but the final status is still unknown. We're reconciling with the bank — if the payment did not go through, the amount will be returned to your wallet automatically.",
      withdrawal: serializeWithdrawal(withdrawal!),
      balance: Number(freshWallet?.balance ?? 0),
    });
    return;
  }
  res.json({
    ok: true,
    withdrawal: serializeWithdrawal(withdrawal!),
    balance: Number(freshWallet?.balance ?? 0),
  });
});

// GET /wallet/withdrawals?organizationId= — list this user's recent withdrawals
router.get("/wallet/withdrawals", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const orgId = req.query.organizationId ? Number(req.query.organizationId) : null;
  if (!orgId) { { res.status(400).json({ error: "organizationId is required" }); return; } }
  const rows = await db.select().from(clubWalletWithdrawalsTable).where(and(
    eq(clubWalletWithdrawalsTable.userId, userId),
    eq(clubWalletWithdrawalsTable.organizationId, orgId),
  )).orderBy(desc(clubWalletWithdrawalsTable.requestedAt)).limit(50);
  // Task #1278 — fold in the per-channel notify-attempt rows so the
  // member can see whether the email/push confirmation actually went
  // out, is being retried, or has hit the cap.
  const withdrawalIds = rows.map(r => r.id);
  const notifyAttempts = withdrawalIds.length === 0
    ? []
    : await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(inArray(walletWithdrawalNotifyAttemptsTable.withdrawalId, withdrawalIds));
  const attemptsByWithdrawal = new Map<number, typeof notifyAttempts>();
  for (const a of notifyAttempts) {
    const arr = attemptsByWithdrawal.get(a.withdrawalId) ?? [];
    arr.push(a);
    attemptsByWithdrawal.set(a.withdrawalId, arr);
  }
  res.json({
    withdrawals: rows.map(w =>
      serializeWithdrawal(w, attemptsByWithdrawal.get(w.id) ?? []),
    ),
  });
});

/**
 * Task #1278 — derived per-channel delivery status surfaced on the
 * wallet withdrawal detail row. Hides channels whose first attempt was
 * skipped because the recipient has no address / opted out / the
 * provider is not configured (we have nothing useful to say in those
 * cases).
 */
export type NotifyDeliveryStatus = "sent" | "retrying" | "failed_permanent";

function deriveChannelStatus(
  status: string | null,
  exhaustedAt: Date | null,
): NotifyDeliveryStatus | null {
  if (!status) return null;
  if (status === "sent") return "sent";
  if (status === "failed") {
    return exhaustedAt ? "failed_permanent" : "retrying";
  }
  // skipped / opted_out / no_address — nothing actionable to show.
  return null;
}

function serializeWithdrawalNotify(
  attempts: Array<typeof walletWithdrawalNotifyAttemptsTable.$inferSelect>,
) {
  if (attempts.length === 0) return null;
  // For a single withdrawal there is at most one row per outcome; the
  // most relevant one for the member is the latest terminal outcome.
  // The unique index guarantees ≤1 row per outcome but in practice a
  // withdrawal only has the `processed` OR the `failed`/`reversed`
  // outcome — never both — so we just pick the most recent row.
  const latest = attempts.reduce((acc, cur) =>
    cur.createdAt.getTime() > acc.createdAt.getTime() ? cur : acc,
  );
  return {
    outcome: latest.outcome as "processed" | "failed" | "reversed",
    email: {
      status: deriveChannelStatus(latest.emailStatus, latest.emailRetryExhaustedAt),
      attempts: latest.emailAttempts,
      lastAt: latest.lastEmailAt ? latest.lastEmailAt.toISOString() : null,
      // Task #1499 — surface when the cron will next try so the badge
      // can render "Email retrying — next try in 2m 14s" instead of an
      // opaque pill. NULL once retries are exhausted (cleared by the
      // notify helper), in which case `exhaustedAt` carries the
      // wall-clock for the "gave up X ago" copy.
      nextRetryAt: latest.nextEmailRetryAt
        ? latest.nextEmailRetryAt.toISOString()
        : null,
      exhaustedAt: latest.emailRetryExhaustedAt
        ? latest.emailRetryExhaustedAt.toISOString()
        : null,
    },
    push: {
      status: deriveChannelStatus(latest.pushStatus, latest.pushRetryExhaustedAt),
      attempts: latest.pushAttempts,
      lastAt: latest.lastPushAt ? latest.lastPushAt.toISOString() : null,
      nextRetryAt: latest.nextPushRetryAt
        ? latest.nextPushRetryAt.toISOString()
        : null,
      exhaustedAt: latest.pushRetryExhaustedAt
        ? latest.pushRetryExhaustedAt.toISOString()
        : null,
    },
  };
}

/**
 * Task #1841 — surface the same per-channel notify state for a side-game
 * settlement receipt that `serializeWithdrawalNotify` exposes for wallet
 * withdrawals, so the web/mobile badges can render the matching
 * "next try in 2m 14s" / "gave up X ago" countdown via the shared
 * `formatRetryRelative` helper. Returns `null` when no attempt row
 * exists yet (settlement is still pending or notify never fired).
 */
export function serializeReceiptNotify(
  attempt: typeof sideGameSettlementReceiptAttemptsTable.$inferSelect | null,
) {
  if (!attempt) return null;
  return {
    email: {
      status: deriveChannelStatus(attempt.emailStatus, attempt.emailRetryExhaustedAt),
      attempts: attempt.emailAttempts,
      lastAt: attempt.lastEmailAt ? attempt.lastEmailAt.toISOString() : null,
      nextRetryAt: attempt.nextEmailRetryAt ? attempt.nextEmailRetryAt.toISOString() : null,
      exhaustedAt: attempt.emailRetryExhaustedAt ? attempt.emailRetryExhaustedAt.toISOString() : null,
    },
    push: {
      status: deriveChannelStatus(attempt.pushStatus, attempt.pushRetryExhaustedAt),
      attempts: attempt.pushAttempts,
      lastAt: attempt.lastPushAt ? attempt.lastPushAt.toISOString() : null,
      nextRetryAt: attempt.nextPushRetryAt ? attempt.nextPushRetryAt.toISOString() : null,
      exhaustedAt: attempt.pushRetryExhaustedAt ? attempt.pushRetryExhaustedAt.toISOString() : null,
    },
  };
}

/**
 * Task #1841 — analogous to `serializeReceiptNotify` for wallet top-up
 * refund notifications. The schema mirrors the withdrawal/receipt
 * tables for email + push, so we surface the same shape and skip the
 * sms/whatsapp columns (badges only render email + push to match the
 * existing wallet-withdrawal pills).
 */
export function serializeTopupRefundNotify(
  attempt: typeof walletTopupRefundNotifyAttemptsTable.$inferSelect | null,
) {
  if (!attempt) return null;
  return {
    email: {
      status: deriveChannelStatus(attempt.emailStatus, attempt.emailRetryExhaustedAt),
      attempts: attempt.emailAttempts,
      lastAt: attempt.lastEmailAt ? attempt.lastEmailAt.toISOString() : null,
      nextRetryAt: attempt.nextEmailRetryAt ? attempt.nextEmailRetryAt.toISOString() : null,
      exhaustedAt: attempt.emailRetryExhaustedAt ? attempt.emailRetryExhaustedAt.toISOString() : null,
    },
    push: {
      status: deriveChannelStatus(attempt.pushStatus, attempt.pushRetryExhaustedAt),
      attempts: attempt.pushAttempts,
      lastAt: attempt.lastPushAt ? attempt.lastPushAt.toISOString() : null,
      nextRetryAt: attempt.nextPushRetryAt ? attempt.nextPushRetryAt.toISOString() : null,
      exhaustedAt: attempt.pushRetryExhaustedAt ? attempt.pushRetryExhaustedAt.toISOString() : null,
    },
  };
}

/**
 * Task #1862 — five-state per-channel delivery status surfaced on the
 * wallet refund detail surfaces (member-facing wallet UI + admin
 * /admin/wallet-topup-refunds page) so support can answer
 * "did the member ever get the SMS/WhatsApp text?" without database
 * access. Distinct from `deriveChannelStatus`, which collapses
 * `skipped`/`opted_out`/`no_address` to `null` because the existing
 * email/push retry badges hide channels they have nothing actionable
 * to show. The detail row exists *because* support needs to know
 * "skipped" too.
 *
 * Mapping from the underlying `NotifyChannelStatus` (stored in
 * `wallet_topup_refund_notify_attempts.{email,push,sms,whatsapp}_status`):
 *   - "sent"                                   → "sent"
 *   - "failed" + exhaustedAt set               → "exhausted"
 *   - "failed" + nextRetryAt set               → "retrying"
 *   - "failed" otherwise                       → "failed"
 *   - "skipped" / "opted_out" / "no_address"   → "skipped"
 *   - null/undefined (channel never wired)     → null
 */
export type RefundDeliveryStatus = "sent" | "failed" | "retrying" | "exhausted" | "skipped";

export function deriveRefundDeliveryStatus(
  status: string | null,
  exhaustedAt: Date | null,
  nextRetryAt: Date | null,
): RefundDeliveryStatus | null {
  if (!status) return null;
  if (status === "sent") return "sent";
  if (status === "failed") {
    if (exhaustedAt) return "exhausted";
    if (nextRetryAt) return "retrying";
    return "failed";
  }
  if (status === "skipped" || status === "opted_out" || status === "no_address") {
    return "skipped";
  }
  return null;
}

/**
 * Task #1862 — per-channel delivery row for the wallet refund detail
 * surface. `lastError` is only included when the caller is an org
 * admin (the underlying provider error string is not safe to leak to
 * the affected member's own wallet view).
 */
export function serializeTopupRefundDelivery(
  attempt: typeof walletTopupRefundNotifyAttemptsTable.$inferSelect | null,
  options: { includeLastError: boolean },
) {
  if (!attempt) return null;
  const channel = (
    rawStatus: string | null,
    attempts: number,
    lastAt: Date | null,
    nextRetryAt: Date | null,
    exhaustedAt: Date | null,
    lastError: string | null,
  ) => {
    const base = {
      status: deriveRefundDeliveryStatus(rawStatus, exhaustedAt, nextRetryAt),
      attempts,
      lastAt: lastAt ? lastAt.toISOString() : null,
      nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
      exhaustedAt: exhaustedAt ? exhaustedAt.toISOString() : null,
    };
    return options.includeLastError ? { ...base, lastError } : base;
  };
  return {
    email: channel(
      attempt.emailStatus,
      attempt.emailAttempts,
      attempt.lastEmailAt,
      attempt.nextEmailRetryAt,
      attempt.emailRetryExhaustedAt,
      attempt.lastEmailError ?? null,
    ),
    push: channel(
      attempt.pushStatus,
      attempt.pushAttempts,
      attempt.lastPushAt,
      attempt.nextPushRetryAt,
      attempt.pushRetryExhaustedAt,
      attempt.lastPushError ?? null,
    ),
    sms: channel(
      attempt.smsStatus,
      attempt.smsAttempts,
      attempt.lastSmsAt,
      attempt.nextSmsRetryAt,
      attempt.smsRetryExhaustedAt,
      attempt.lastSmsError ?? null,
    ),
    whatsapp: channel(
      attempt.whatsappStatus,
      attempt.whatsappAttempts,
      attempt.lastWhatsappAt,
      attempt.nextWhatsappRetryAt,
      attempt.whatsappRetryExhaustedAt,
      attempt.lastWhatsappError ?? null,
    ),
  };
}

function serializeWithdrawal(
  w: typeof clubWalletWithdrawalsTable.$inferSelect,
  notifyAttempts: Array<typeof walletWithdrawalNotifyAttemptsTable.$inferSelect> = [],
) {
  return {
    id: w.id,
    amount: Number(w.amount),
    currency: w.currency,
    method: w.method,
    status: w.status,
    payoutMode: w.payoutMode,
    razorpayPayoutId: w.razorpayPayoutId,
    failureReason: w.failureReason,
    utr: w.utr,
    debitTxnId: w.debitTxnId,
    refundTxnId: w.refundTxnId,
    requestedAt: w.requestedAt.toISOString(),
    processedAt: w.processedAt ? w.processedAt.toISOString() : null,
    failedAt: w.failedAt ? w.failedAt.toISOString() : null,
    notify: serializeWithdrawalNotify(notifyAttempts),
  };
}

// Suppress unused-import lints: refundWithdrawal is part of the public
// helper surface used by the webhook handler, kept here so a future
// admin endpoint can manually refund a stuck withdrawal.
void refundWithdrawal;

// ─── ADMIN: STUCK SIDE-GAME RECEIPT DELIVERIES (Task #1117) ────────────
//
// The retry cron in lib/cron.ts re-attempts failed email/push deliveries
// up to SIDE_GAME_RECEIPT_MAX_*_ATTEMPTS times with exponential backoff.
// When a channel exhausts its budget, `*RetryExhaustedAt` is stamped on
// the attempts row and the cron stops re-selecting it. Likewise rows
// that flip to `skipped` (provider not configured, no address, opted
// out) are never re-attempted. Until now no one was notified — operators
// had to query the database to find players whose receipts never
// arrived.
//
// These endpoints surface those stuck rows on the admin dashboard so
// staff can follow up, and provide a per-row "resend" action that
// clears the exhausted state and re-queues the delivery for the next
// retry-cron tick.

interface StuckReceiptRow {
  id: number;
  settlementId: number;
  recipientUserId: number;
  // Task #1291: optional clubMembers.id so the dashboard widget can deep-
  // link the recipient name to their Member 360 profile. Null when the
  // recipient user has no club_members row in this org (e.g. a guest
  // settlement that pre-dates org enrolment).
  recipientClubMemberId: number | null;
  payerName: string;
  recipientName: string | null;
  recipientEmail: string | null;
  gameLabel: string;
  currency: string;
  amount: number;
  paymentMethod: string | null;
  paymentRef: string | null;
  paidAt: string | null;
  createdAt: string;
  emailStatus: string | null;
  emailAttempts: number;
  lastEmailAt: string | null;
  lastEmailError: string | null;
  emailRetryExhaustedAt: string | null;
  pushStatus: string | null;
  pushAttempts: number;
  lastPushAt: string | null;
  lastPushError: string | null;
  pushRetryExhaustedAt: string | null;
  // Channel-level stuck flags so the UI can render a per-channel badge
  // without re-implementing the predicate.
  emailStuck: boolean;
  pushStuck: boolean;
}

function isChannelStuck(status: string | null, exhaustedAt: Date | null): boolean {
  if (exhaustedAt) return true;
  if (status === "skipped" || status === "no_address" || status === "opted_out" || status === "no_user") {
    return true;
  }
  return false;
}

// Task #1874: pagination knobs. The page-size cap (`MAX_PAGE_LIMIT`)
// matches the digest CSV's hard cap of 1000 so a single dashboard page
// can never request more rows than the cron-emailed CSV would surface
// in one go. The default page size stays at 200 so the historical
// payload size is unchanged for clients that omit the new query params.
const STUCK_RECEIPTS_DEFAULT_LIMIT = 200;
const STUCK_RECEIPTS_MAX_LIMIT = 1000;

router.get("/admin/side-game-receipt-failures", async (req: Request, res: Response) => {
  const orgId = req.query.organizationId ? Number(req.query.organizationId) : NaN;
  if (!Number.isFinite(orgId) || orgId <= 0) {
    res.status(400).json({ error: "organizationId is required" });
    return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Task #1874 — page through the stuck list so admins can triage
  // outages with > 200 stuck rows. Previously the endpoint hard-capped
  // at 200 rows while the cron-emailed CSV pulled 1000, so a real
  // outage could silently drift the two surfaces apart.
  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : STUCK_RECEIPTS_DEFAULT_LIMIT;
  const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : 0;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(STUCK_RECEIPTS_MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : STUCK_RECEIPTS_DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;

  const STUCK_STATUSES = ["skipped", "no_address", "opted_out", "no_user"];
  const stuckPredicate = and(
    eq(sideGameSettlementReceiptAttemptsTable.organizationId, orgId),
    or(
      isNotNull(sideGameSettlementReceiptAttemptsTable.emailRetryExhaustedAt),
      isNotNull(sideGameSettlementReceiptAttemptsTable.pushRetryExhaustedAt),
      inArray(sideGameSettlementReceiptAttemptsTable.emailStatus, STUCK_STATUSES),
      inArray(sideGameSettlementReceiptAttemptsTable.pushStatus, STUCK_STATUSES),
    ),
  );

  // Org-wide aggregate counts so the widget badge / summary always
  // reflect the *full* stuck-row total — even when the visible page
  // shows only the most recent N. Previously these numbers were
  // computed in JS over the (capped) page, which silently undercounted
  // during real outages with hundreds of stuck rows.
  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      exhausted: sql<number>`count(*) filter (where ${sideGameSettlementReceiptAttemptsTable.emailRetryExhaustedAt} is not null or ${sideGameSettlementReceiptAttemptsTable.pushRetryExhaustedAt} is not null)::int`,
    })
    .from(sideGameSettlementReceiptAttemptsTable)
    .where(stuckPredicate);
  const totalCount = Number(agg?.total ?? 0);
  const exhaustedCount = Number(agg?.exhausted ?? 0);
  const skippedCount = Math.max(0, totalCount - exhaustedCount);

  // Task #1291: left-join clubMembersTable on (orgId, recipientUserId)
  // so the dashboard can deep-link the recipient name to Member 360. We
  // mirror the wallet-withdrawal-notify-failures join below — the
  // recipient may not have a club_members row in this org, in which
  // case clubMemberId stays null and the widget falls back to the
  // plain (non-link) name.
  const rows = await db.select({
    a: sideGameSettlementReceiptAttemptsTable,
    clubMemberId: clubMembersTable.id,
  })
    .from(sideGameSettlementReceiptAttemptsTable)
    .leftJoin(
      clubMembersTable,
      and(
        eq(clubMembersTable.organizationId, sideGameSettlementReceiptAttemptsTable.organizationId),
        eq(clubMembersTable.userId, sideGameSettlementReceiptAttemptsTable.recipientUserId),
      ),
    )
    .where(stuckPredicate)
    // Task #1874 — secondary `id` sort makes pagination stable when
    // multiple rows share the same `created_at` (e.g. a single
    // background job stamps a batch of stuck attempts at the same
    // millisecond). Without it, OFFSET can drop or duplicate rows
    // across pages, breaking parity with the digest CSV.
    .orderBy(
      desc(sideGameSettlementReceiptAttemptsTable.createdAt),
      desc(sideGameSettlementReceiptAttemptsTable.id),
    )
    .limit(limit)
    .offset(offset);

  const items: StuckReceiptRow[] = rows.map(({ a: r, clubMemberId }) => ({
    id: r.id,
    settlementId: r.settlementId,
    recipientUserId: r.recipientUserId,
    recipientClubMemberId: clubMemberId ?? null,
    payerName: r.payerName,
    recipientName: r.recipientName,
    recipientEmail: r.recipientEmail,
    gameLabel: r.gameLabel,
    currency: r.currency,
    amount: Number(r.amount),
    paymentMethod: r.paymentMethod,
    paymentRef: r.paymentRef,
    paidAt: r.paidAt ? r.paidAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    emailStatus: r.emailStatus,
    emailAttempts: r.emailAttempts,
    lastEmailAt: r.lastEmailAt ? r.lastEmailAt.toISOString() : null,
    lastEmailError: r.lastEmailError,
    emailRetryExhaustedAt: r.emailRetryExhaustedAt ? r.emailRetryExhaustedAt.toISOString() : null,
    pushStatus: r.pushStatus,
    pushAttempts: r.pushAttempts,
    lastPushAt: r.lastPushAt ? r.lastPushAt.toISOString() : null,
    lastPushError: r.lastPushError,
    pushRetryExhaustedAt: r.pushRetryExhaustedAt ? r.pushRetryExhaustedAt.toISOString() : null,
    emailStuck: isChannelStuck(r.emailStatus, r.emailRetryExhaustedAt),
    pushStuck: isChannelStuck(r.pushStatus, r.pushRetryExhaustedAt),
  }));

  res.json({
    items,
    counts: { total: totalCount, exhausted: exhaustedCount, skipped: skippedCount },
    pagination: {
      limit,
      offset,
      hasMore: offset + items.length < totalCount,
    },
  });
});

router.post("/admin/side-game-receipt-failures/:attemptId/resend", async (req: Request, res: Response) => {
  const attemptId = Number((req.params as Record<string, string>).attemptId);
  if (!Number.isFinite(attemptId) || attemptId <= 0) {
    res.status(400).json({ error: "invalid attemptId" });
    return;
  }
  const [attempt] = await db.select().from(sideGameSettlementReceiptAttemptsTable)
    .where(eq(sideGameSettlementReceiptAttemptsTable.id, attemptId));
  if (!attempt) { { res.status(404).json({ error: "attempt not found" }); return; } }
  if (!await requireOrgAdmin(req, res, attempt.organizationId)) return;

  const emailStuck = isChannelStuck(attempt.emailStatus, attempt.emailRetryExhaustedAt);
  const pushStuck = isChannelStuck(attempt.pushStatus, attempt.pushRetryExhaustedAt);
  if (!emailStuck && !pushStuck) {
    res.status(409).json({ error: "delivery is not in a stuck state" });
    return;
  }

  // Reset stuck channels so the retry cron picks them up on its next
  // tick. We zero the attempt counter to give a fresh budget, clear the
  // exhausted timestamp, drop any remembered backoff, and flip the
  // status back to `failed` (cron only re-selects rows where status =
  // 'failed' AND attempts < cap AND nextRetryAt is past).
  const now = new Date();
  const updates: Partial<typeof sideGameSettlementReceiptAttemptsTable.$inferInsert> = {};
  if (emailStuck) {
    updates.emailStatus = "failed";
    updates.emailAttempts = 0;
    updates.emailRetryExhaustedAt = null;
    updates.nextEmailRetryAt = null;
    updates.lastEmailError = null;
  }
  if (pushStuck) {
    updates.pushStatus = "failed";
    updates.pushAttempts = 0;
    updates.pushRetryExhaustedAt = null;
    updates.nextPushRetryAt = null;
    updates.lastPushError = null;
  }
  await db.update(sideGameSettlementReceiptAttemptsTable)
    .set(updates)
    .where(eq(sideGameSettlementReceiptAttemptsTable.id, attemptId));

  logger.info({
    attemptId,
    orgId: attempt.organizationId,
    settlementId: attempt.settlementId,
    requeued: { email: emailStuck, push: pushStuck },
    requeuedBy: getUserId(req),
  }, "[side-game-receipt-failures] admin re-queued stuck delivery");

  res.json({ ok: true, requeued: { email: emailStuck, push: pushStuck }, at: now.toISOString() });
});

// ─── ADMIN: STUCK SIDE-GAME RECEIPT DIGEST SCHEDULE (Task #1290) ───────
//
// Org admins configure a daily/weekly cadence + recipient list and the
// in-process cron (lib/cron.ts) emails the elapsed-period CSV of stuck
// side-game receipts (`/admin/side-game-receipt-failures` widget) to
// support so follow-up no longer requires anyone to remember to log in to
// the dashboard. Mirrors the wallet auto-refund digest pattern (Task
// #1073) — schema, route surface, bounce-aware recipient pruning, and the
// `side_game.receipt.digest.failed` admin notification when a digest
// drops are intentionally identical so on-call engineers build one
// mental model.

const RECEIPT_DIGEST_FREQUENCIES = new Set(["daily", "weekly"]);
const RECEIPT_DIGEST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Compute the next run datetime for a given frequency. Anchored to 07:00
 * UTC so the digest lands at the start of the work-day for most support
 * timezones — same anchor as the wallet auto-refund digest cadence.
 */
export function computeSideGameReceiptDigestNextRunAt(frequency: string, from: Date = new Date()): Date {
  const d = new Date(from);
  if (frequency === "daily") {
    d.setUTCDate(d.getUTCDate() + 1);
  } else {
    d.setUTCDate(d.getUTCDate() + 7);
  }
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

/**
 * Build the stuck-receipt CSV for a given org + window. Mirrors the
 * `/admin/side-game-receipt-failures` widget query so the inbox-driven
 * digest sees the same rows operators see in the dashboard. The window
 * is inclusive on both ends — `from..to` filters by `created_at` so the
 * weekly cadence does not double-count rows from previous periods.
 */
async function buildSideGameReceiptDigestCsv(args: {
  orgId: number;
  from: Date | null;
  to: Date | null;
}): Promise<{ csv: string; rowCount: number; exhaustedCount: number; skippedCount: number }> {
  const STUCK_STATUSES = ["skipped", "no_address", "opted_out", "no_user"];
  const rows = await db.select().from(sideGameSettlementReceiptAttemptsTable)
    .where(and(
      eq(sideGameSettlementReceiptAttemptsTable.organizationId, args.orgId),
      or(
        isNotNull(sideGameSettlementReceiptAttemptsTable.emailRetryExhaustedAt),
        isNotNull(sideGameSettlementReceiptAttemptsTable.pushRetryExhaustedAt),
        inArray(sideGameSettlementReceiptAttemptsTable.emailStatus, STUCK_STATUSES),
        inArray(sideGameSettlementReceiptAttemptsTable.pushStatus, STUCK_STATUSES),
      ),
      args.from ? gte(sideGameSettlementReceiptAttemptsTable.createdAt, args.from) : undefined,
      args.to ? lte(sideGameSettlementReceiptAttemptsTable.createdAt, args.to) : undefined,
    ))
    .orderBy(desc(sideGameSettlementReceiptAttemptsTable.createdAt))
    .limit(1000);

  const header = [
    "created_at", "settlement_id", "recipient_user_id", "recipient_name", "recipient_email",
    "payer_name", "game_label", "currency", "amount", "payment_method", "payment_ref", "paid_at",
    "email_status", "email_attempts", "email_retry_exhausted_at", "last_email_error",
    "push_status", "push_attempts", "push_retry_exhausted_at", "last_push_error",
  ];
  const csvRows: string[][] = [header];
  let exhaustedCount = 0;
  let skippedCount = 0;
  for (const r of rows) {
    if (r.emailRetryExhaustedAt || r.pushRetryExhaustedAt) exhaustedCount += 1;
    else skippedCount += 1;
    csvRows.push([
      r.createdAt.toISOString(),
      String(r.settlementId),
      String(r.recipientUserId),
      r.recipientName ?? "",
      r.recipientEmail ?? "",
      r.payerName,
      r.gameLabel,
      r.currency,
      Number(r.amount).toFixed(2),
      r.paymentMethod ?? "",
      r.paymentRef ?? "",
      r.paidAt ? r.paidAt.toISOString() : "",
      r.emailStatus ?? "",
      String(r.emailAttempts),
      r.emailRetryExhaustedAt ? r.emailRetryExhaustedAt.toISOString() : "",
      r.lastEmailError ?? "",
      r.pushStatus ?? "",
      String(r.pushAttempts),
      r.pushRetryExhaustedAt ? r.pushRetryExhaustedAt.toISOString() : "",
      r.lastPushError ?? "",
    ]);
  }
  const csv = csvRows
    .map(row => row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
  return { csv, rowCount: rows.length, exhaustedCount, skippedCount };
}

async function parseReceiptDigestScheduleOrgId(req: Request, res: Response): Promise<number | null> {
  const orgIdNum = req.query.organizationId ? Number(req.query.organizationId) : NaN;
  if (!Number.isFinite(orgIdNum) || orgIdNum <= 0) {
    res.status(400).json({ error: "organizationId is required" });
    return null;
  }
  if (!await requireOrgAdmin(req, res, orgIdNum)) return null;
  return orgIdNum;
}

router.get("/admin/side-game-receipt-failures/email-schedule", async (req: Request, res: Response) => {
  const orgId = await parseReceiptDigestScheduleOrgId(req, res);
  if (orgId == null) return;

  const [schedule] = await db.select().from(sideGameReceiptDigestSchedulesTable)
    .where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));

  const history = schedule
    ? await db.select().from(sideGameReceiptDigestRunsTable)
        .where(eq(sideGameReceiptDigestRunsTable.scheduleId, schedule.id))
        .orderBy(desc(sideGameReceiptDigestRunsTable.sentAt))
        .limit(50)
    : [];

  // Task #2171 — surface the resolved digest language *per recipient*,
  // mirroring the wallet auto-refund schedule editor (Task #1747). The
  // cron renders the digest in one org-resolved language for every
  // recipient (resolveSideGameReceiptDigestLang(org.defaultLanguage)),
  // but the editor benefits from showing "<email> → English" rows plus
  // a "prefers X" hint when an internal recipient's own
  // `preferredLanguage` differs from that resolved language.
  let recipientLanguages: RecipientLanguageRow[] = [];
  if (schedule) {
    const [orgRow] = await db.select({
      defaultLanguage: organizationsTable.defaultLanguage,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    const resolvedLanguage = resolveSideGameReceiptDigestLang(orgRow?.defaultLanguage ?? null);
    recipientLanguages = await loadRecipientLanguagesForOrg(
      Array.isArray(schedule.recipients) ? schedule.recipients as string[] : [],
      resolvedLanguage,
    );
  }

  // Task #1877 — surface a "missed run" signal so the dashboard panel can
  // show a banner when the cron has silently skipped at least one full
  // period. The cron normally advances `nextRunAt` forward each time it
  // runs (see runOneSideGameReceiptDigestSchedule), so a `nextRunAt` that
  // is more than one period in the past with no later history row is the
  // tell-tale sign of a stalled scheduler.
  res.json({
    schedule: schedule ?? null,
    history,
    overdueBy: computeReceiptDigestOverdueBy(schedule ?? null, history),
    recipientLanguages,
  });
});

/**
 * Task #1877 — Compute how far overdue a stuck-receipts digest run is.
 *
 * Returns `null` when the cron is on schedule (or the schedule is
 * paused/missing/has no `nextRunAt`). Returns an `overdueBy` payload
 * once `nextRunAt` is more than one full period in the past AND no
 * history row has caught up by running after that planned time. The
 * one-period grace window means brief cron jitter does not raise the
 * banner; only a genuinely skipped period does.
 */
export function computeReceiptDigestOverdueBy(
  schedule: { frequency: string; enabled: boolean; nextRunAt: Date | null } | null,
  history: { sentAt: Date }[],
  now: Date = new Date(),
): { overdueByMs: number; periodMs: number; expectedAt: string } | null {
  if (!schedule || !schedule.enabled || !schedule.nextRunAt) return null;
  const periodMs = schedule.frequency === "daily"
    ? 24 * 60 * 60 * 1000
    : 7 * 24 * 60 * 60 * 1000;
  const expectedAt = schedule.nextRunAt instanceof Date
    ? schedule.nextRunAt
    : new Date(schedule.nextRunAt);
  const overdueByMs = now.getTime() - expectedAt.getTime();
  if (overdueByMs <= periodMs) return null;
  // Defensive: if some run has already executed at-or-after the
  // planned time, the cron isn't stalled and `nextRunAt` is just
  // waiting to be advanced by the next poll.
  const caughtUp = history.some(h => {
    const t = h.sentAt instanceof Date ? h.sentAt.getTime() : new Date(h.sentAt).getTime();
    return t >= expectedAt.getTime();
  });
  if (caughtUp) return null;
  return {
    overdueByMs,
    periodMs,
    expectedAt: expectedAt.toISOString(),
  };
}

router.put("/admin/side-game-receipt-failures/email-schedule", async (req: Request, res: Response) => {
  const orgId = await parseReceiptDigestScheduleOrgId(req, res);
  if (orgId == null) return;

  const body = req.body as { frequency?: string; recipients?: unknown; enabled?: boolean };
  const frequency = String(body.frequency ?? "").toLowerCase();
  if (!RECEIPT_DIGEST_FREQUENCIES.has(frequency)) {
    res.status(400).json({ error: "frequency must be 'daily' or 'weekly'" });
    return;
  }
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : [];
  const recipients: string[] = [];
  for (const r of recipientsRaw) {
    const s = String(r ?? "").trim();
    if (!s) continue;
    if (!RECEIPT_DIGEST_EMAIL_RE.test(s)) {
      res.status(400).json({ error: `invalid recipient email: ${s}` });
      return;
    }
    if (!recipients.includes(s)) recipients.push(s);
  }
  if (recipients.length === 0) {
    res.status(400).json({ error: "at least one recipient email is required" });
    return;
  }
  if (recipients.length > 20) {
    res.status(400).json({ error: "no more than 20 recipients per schedule" });
    return;
  }
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);

  const now = new Date();
  const userId = getUserId(req);

  const [existing] = await db.select().from(sideGameReceiptDigestSchedulesTable)
    .where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));

  let saved;
  if (existing) {
    const freqChanged = existing.frequency !== frequency;
    const reEnabled = !existing.enabled && enabled;
    const nextRunAt = (freqChanged || reEnabled || !existing.nextRunAt)
      ? computeSideGameReceiptDigestNextRunAt(frequency, now)
      : existing.nextRunAt;
    const [row] = await db.update(sideGameReceiptDigestSchedulesTable).set({
      frequency, recipients, enabled, nextRunAt, updatedAt: now,
    }).where(eq(sideGameReceiptDigestSchedulesTable.id, existing.id)).returning();
    saved = row;
  } else {
    const [row] = await db.insert(sideGameReceiptDigestSchedulesTable).values({
      organizationId: orgId,
      frequency,
      recipients,
      enabled,
      nextRunAt: computeSideGameReceiptDigestNextRunAt(frequency, now),
      createdByUserId: userId ?? null,
    }).returning();
    saved = row;
  }

  res.json({ schedule: saved });
});

router.delete("/admin/side-game-receipt-failures/email-schedule", async (req: Request, res: Response) => {
  const orgId = await parseReceiptDigestScheduleOrgId(req, res);
  if (orgId == null) return;
  await db.delete(sideGameReceiptDigestSchedulesTable)
    .where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));
  res.json({ ok: true });
});

router.get("/admin/side-game-receipt-failures/email-schedule/preview", async (req: Request, res: Response) => {
  const orgId = await parseReceiptDigestScheduleOrgId(req, res);
  if (orgId == null) return;

  const [schedule] = await db.select().from(sideGameReceiptDigestSchedulesTable)
    .where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));
  if (!schedule) {
    res.status(404).json({ error: "No stuck-receipts digest schedule configured" });
    return;
  }

  // Task #1522 — load org `defaultLanguage` alongside the name so the
  // preview renders in the same locale the cron will email out.
  const [org] = await db.select({
    name: organizationsTable.name,
    defaultLanguage: organizationsTable.defaultLanguage,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "daily" ? 1 : 7) * 24 * 60 * 60 * 1000);

  const { rowCount, exhaustedCount, skippedCount } = await buildSideGameReceiptDigestCsv({
    orgId, from: periodStart, to: now,
  });

  const { buildSideGameReceiptDigestEmailContent } = await import("../lib/mailer");
  const { subject, html, filename } = buildSideGameReceiptDigestEmailContent({
    orgName: org?.name ?? "KHARAGOLF",
    frequency: schedule.frequency as "daily" | "weekly",
    periodStart,
    periodEnd: now,
    rowCount,
    exhaustedCount,
    skippedCount,
    lang: org?.defaultLanguage ?? null,
  });

  res.json({
    subject,
    html,
    filename,
    rowCount,
    exhaustedCount,
    skippedCount,
    recipients: Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [],
    frequency: schedule.frequency,
    periodStart: periodStart.toISOString(),
    periodEnd: now.toISOString(),
  });
});

router.post("/admin/side-game-receipt-failures/email-schedule/send-now", async (req: Request, res: Response) => {
  const orgId = await parseReceiptDigestScheduleOrgId(req, res);
  if (orgId == null) return;

  const [schedule] = await db.select().from(sideGameReceiptDigestSchedulesTable)
    .where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));
  if (!schedule) {
    res.status(404).json({ error: "No stuck-receipts digest schedule configured" });
    return;
  }

  const result = await runOneSideGameReceiptDigestSchedule(schedule.id);
  res.json(result);
});

/**
 * Execute one stuck-receipt digest end-to-end: build the elapsed-period
 * CSV, email it to recipients, record the run, and advance the cadence
 * even on failure (so a broken inbox does not get hammered every poll).
 * Shared by the cron poller and the manual send-now endpoint. Mirrors
 * `runOneWalletTopupRefundEmailSchedule` (Task #1073).
 */
export async function runOneSideGameReceiptDigestSchedule(scheduleId: number): Promise<{
  status: "sent" | "failed" | "skipped";
  rowCount: number;
  exhaustedCount: number;
  skippedCount: number;
  recipients: string[];
  errorMessage?: string;
  pausedRecipients?: string[];
}> {
  const [schedule] = await db.select().from(sideGameReceiptDigestSchedulesTable)
    .where(eq(sideGameReceiptDigestSchedulesTable.id, scheduleId));
  if (!schedule) {
    return { status: "skipped", rowCount: 0, exhaustedCount: 0, skippedCount: 0, recipients: [], errorMessage: "schedule not found" };
  }

  const configuredRecipients = Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [];
  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - (schedule.frequency === "daily" ? 1 : 7) * 24 * 60 * 60 * 1000);

  if (configuredRecipients.length === 0) {
    const errorMessage = "no recipients configured";
    await db.insert(sideGameReceiptDigestRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients: [],
      rowCount: 0,
      exhaustedCount: 0,
      skippedCount: 0,
      status: "skipped",
      errorMessage,
      // Task #2196 — no suppression filter ran on this branch (the
      // schedule's configured list was already empty), so there's
      // nothing to snapshot. Mirrors the wallet auto-refund cron's
      // empty-recipients insert (Task #1759).
      pausedRecipients: [],
    });
    await db.update(sideGameReceiptDigestSchedulesTable).set({
      lastSentAt: now,
      nextRunAt: computeSideGameReceiptDigestNextRunAt(schedule.frequency, now),
      updatedAt: now,
    }).where(eq(sideGameReceiptDigestSchedulesTable.id, schedule.id));
    const [orgForAlert] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, schedule.organizationId));
    await notifyAdminsOfReceiptDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      status: "skipped",
      errorMessage,
      pausedRecipients: [],
      org: orgForAlert ?? null,
    });
    return { status: "skipped", rowCount: 0, exhaustedCount: 0, skippedCount: 0, recipients: [], errorMessage };
  }

  // Bounce-aware recipient filter — same shape as the wallet auto-refund
  // digest pruning so a misconfigured inbox does not silently swallow
  // weeks of stuck-receipt digests.
  const lowerToOriginal = new Map<string, string>();
  for (const r of configuredRecipients) {
    const lower = r.trim().toLowerCase();
    if (lower) lowerToOriginal.set(lower, r);
  }
  const lowerList = [...lowerToOriginal.keys()];
  // Task #2196 — capture the suppression metadata (reason / bounceType /
  // description) at lookup time so we can persist a per-recipient
  // snapshot onto the run row. Mirrors Task #1759's wallet auto-refund
  // counterpart: the schedule-level chip already shows this metadata
  // live, but the run history needs the *historical* version because
  // support may later lift the suppression and the chip would otherwise
  // vanish from past runs.
  const suppressionByLower = new Map<string, { reason: string; bounceType: string | null; description: string | null }>();
  if (lowerList.length > 0) {
    try {
      const supRows = await db
        .select({
          email: emailSuppressionsTable.email,
          reason: emailSuppressionsTable.reason,
          bounceType: emailSuppressionsTable.bounceType,
          description: emailSuppressionsTable.description,
        })
        .from(emailSuppressionsTable)
        .where(and(
          eq(emailSuppressionsTable.organizationId, schedule.organizationId),
          inArray(emailSuppressionsTable.email, lowerList),
        ));
      for (const r of supRows) {
        suppressionByLower.set(r.email.toLowerCase(), {
          reason: r.reason,
          bounceType: r.bounceType,
          description: r.description,
        });
      }
    } catch (err) {
      logger.warn({ err, scheduleId: schedule.id }, "[side-game-receipt-digest] suppression lookup failed; sending to all configured recipients");
      suppressionByLower.clear();
    }
  }
  const recipients: string[] = [];
  const pausedRecipients: string[] = [];
  // Task #2196 — per-run snapshot persisted onto
  // `side_game_receipt_digest_runs.paused_recipients` so the dashboard's
  // history table can show "who was paused at the moment of this run"
  // even if the suppression is later lifted. Mirrors the wallet
  // auto-refund counterpart added in Task #1759.
  const pausedRecipientsSnapshot: SideGameReceiptDigestRunPausedRecipient[] = [];
  for (const [lower, original] of lowerToOriginal) {
    const hit = suppressionByLower.get(lower);
    if (hit) {
      pausedRecipients.push(original);
      pausedRecipientsSnapshot.push({
        email: original,
        reason: hit.reason,
        bounceType: hit.bounceType,
        description: hit.description,
      });
    } else {
      recipients.push(original);
    }
  }
  if (pausedRecipients.length > 0) {
    try {
      await db.update(sideGameReceiptDigestSchedulesTable).set({
        recipients,
        updatedAt: now,
      }).where(eq(sideGameReceiptDigestSchedulesTable.id, schedule.id));
    } catch (err) {
      logger.warn({ err, scheduleId: schedule.id }, "[side-game-receipt-digest] failed to persist paused recipients");
    }
  }

  // Task #1522 — also load `defaultLanguage` so the email body is
  // translated into the org's configured locale. Mirrors the resolution
  // pattern Task #1232 uses for the wallet auto-refund digest.
  const [org] = await db.select({
    name: organizationsTable.name,
    defaultLanguage: organizationsTable.defaultLanguage,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
  }).from(organizationsTable).where(eq(organizationsTable.id, schedule.organizationId));

  if (recipients.length === 0) {
    const errorMessage = `paused all configured recipients (${pausedRecipients.join(", ")}) — every address is on the bounce / unsubscribe suppression list`;
    await db.insert(sideGameReceiptDigestRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients: [],
      rowCount: 0,
      exhaustedCount: 0,
      skippedCount: 0,
      status: "skipped",
      errorMessage,
      // Task #2196 — every configured recipient was paused; snapshot
      // the full list (with reason metadata) so the dashboard's history
      // table can show the chip even if the suppression is later
      // lifted. Mirrors Task #1759.
      pausedRecipients: pausedRecipientsSnapshot,
    });
    await db.update(sideGameReceiptDigestSchedulesTable).set({
      lastSentAt: now,
      nextRunAt: computeSideGameReceiptDigestNextRunAt(schedule.frequency, now),
      updatedAt: now,
    }).where(eq(sideGameReceiptDigestSchedulesTable.id, schedule.id));
    await notifyAdminsOfReceiptDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      status: "skipped",
      errorMessage,
      pausedRecipients,
      org: org ?? null,
    });
    return { status: "skipped", rowCount: 0, exhaustedCount: 0, skippedCount: 0, recipients: [], errorMessage, pausedRecipients };
  }

  const { csv, rowCount, exhaustedCount, skippedCount } = await buildSideGameReceiptDigestCsv({
    orgId: schedule.organizationId,
    from: periodStart,
    to: now,
  });

  let status: "sent" | "failed" = "sent";
  let errorMessage: string | undefined;

  try {
    const { sendSideGameReceiptDigestEmail } = await import("../lib/mailer");
    await sendSideGameReceiptDigestEmail({
      to: recipients,
      orgName: org?.name ?? "KHARAGOLF",
      frequency: schedule.frequency as "daily" | "weekly",
      periodStart,
      periodEnd: now,
      rowCount,
      exhaustedCount,
      skippedCount,
      csv,
      // Task #1522 — render in the org's configured locale (EN fallback
      // when the code is unsupported, handled inside the mailer).
      lang: org?.defaultLanguage ?? null,
      branding: {
        orgName: org?.name ?? "KHARAGOLF",
        logoUrl: org?.logoUrl ?? undefined,
        primaryColor: org?.primaryColor ?? undefined,
        orgId: schedule.organizationId,
      },
    });
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn({ err, scheduleId: schedule.id }, "[side-game-receipt-digest] send failed");
  }

  let runErrorMessage: string | undefined = errorMessage;
  if (pausedRecipients.length > 0) {
    const pauseNote = `paused ${pausedRecipients.length} bounced/unsubscribed recipient(s): ${pausedRecipients.join(", ")}`;
    runErrorMessage = runErrorMessage ? `${runErrorMessage}; ${pauseNote}` : pauseNote;
  }

  await db.insert(sideGameReceiptDigestRunsTable).values({
    scheduleId: schedule.id,
    organizationId: schedule.organizationId,
    periodStart,
    periodEnd: now,
    recipients,
    rowCount,
    exhaustedCount,
    skippedCount,
    status,
    errorMessage: runErrorMessage,
    // Task #2196 — snapshot the per-recipient pause metadata onto the
    // run row so the dashboard's history table can render the same chip
    // (with reason + bounceType) the schedule editor uses, and the row
    // stays accurate even after the suppression is later lifted.
    // Mirrors the wallet auto-refund counterpart added in Task #1759.
    pausedRecipients: pausedRecipientsSnapshot,
  });

  await db.update(sideGameReceiptDigestSchedulesTable).set({
    lastSentAt: now,
    nextRunAt: computeSideGameReceiptDigestNextRunAt(schedule.frequency, now),
    updatedAt: now,
  }).where(eq(sideGameReceiptDigestSchedulesTable.id, schedule.id));

  if (status === "failed") {
    await notifyAdminsOfReceiptDigestFailure({
      orgId: schedule.organizationId,
      scheduleId: schedule.id,
      status: "failed",
      errorMessage: errorMessage ?? "unknown error",
      pausedRecipients,
      org: org ?? null,
    });
  }

  return {
    status, rowCount, exhaustedCount, skippedCount, recipients, errorMessage,
    pausedRecipients: pausedRecipients.length > 0 ? pausedRecipients : undefined,
  };
}

/**
 * Task #1290 — alert org admins / treasurers that the stuck-receipt digest
 * failed (or was paused entirely because every recipient bounced).
 * Mirrors `notifyAdminsOfRefundDigestFailure` (Task #1233): same recipient
 * resolution (direct `org_admin` app_users + `org_memberships` rows whose
 * role is `org_admin` or `treasurer`), same consecutive-failure escalation,
 * same dispatch surface so on-call engineers learn one pattern.
 */
async function notifyAdminsOfReceiptDigestFailure(opts: {
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
        inArray(orgMembershipsTable.role, ["org_admin", "treasurer"]),
      ));
    const userIds = Array.from(new Set(
      [...directAdmins, ...memberAdmins].map(r => r.userId).filter((n): n is number => typeof n === "number"),
    ));
    if (userIds.length === 0) {
      logger.info({ orgId: opts.orgId, scheduleId: opts.scheduleId }, "[side-game-receipt-digest] no admin recipients for failure alert");
      return;
    }

    let consecutiveFailures = 1;
    try {
      const recentRuns = await db
        .select({ status: sideGameReceiptDigestRunsTable.status })
        .from(sideGameReceiptDigestRunsTable)
        .where(eq(sideGameReceiptDigestRunsTable.scheduleId, opts.scheduleId))
        .orderBy(desc(sideGameReceiptDigestRunsTable.sentAt))
        .limit(20);
      consecutiveFailures = 0;
      for (const r of recentRuns) {
        if (r.status === "sent") break;
        consecutiveFailures += 1;
      }
      if (consecutiveFailures < 1) consecutiveFailures = 1;
    } catch (err) {
      logger.warn({ err, scheduleId: opts.scheduleId }, "[side-game-receipt-digest] consecutive-failure count lookup failed");
    }

    const orgName = opts.org?.name ?? "your club";
    const title = opts.status === "skipped"
      ? `Stuck side-game receipts digest paused — every recipient is bouncing (${orgName})`
      : `Stuck side-game receipts digest failed to send (${orgName})`;
    const reasonLine = opts.status === "skipped"
      ? `Every configured recipient is on the bounce / unsubscribe list, so this period's digest was not sent. Paused recipients: ${opts.pausedRecipients.join(", ") || "(none)"}.`
      : `The mailer rejected the send: ${opts.errorMessage}`;
    const pausedLine = opts.pausedRecipients.length > 0 && opts.status !== "skipped"
      ? ` We also paused ${opts.pausedRecipients.length} previously-bouncing recipient(s) from future runs: ${opts.pausedRecipients.join(", ")}.`
      : "";
    const consecutiveLine = consecutiveFailures > 1
      ? ` This is the ${consecutiveFailures}th consecutive run that did not deliver — please update the recipient list on the dashboard's "Stuck side-game receipts" panel.`
      : ` Open the dashboard's "Stuck side-game receipts" panel to update the recipient list.`;
    const body = `${reasonLine}${pausedLine}${consecutiveLine}`;
    const safeBody = escapeHtmlForRefundDigestAlert(body);
    const safeTitle = escapeHtmlForRefundDigestAlert(title);
    const emailHtml = `<div style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#fff;padding:24px;max-width:560px;margin:0 auto;border-radius:12px;">
        <h2 style="margin:0 0 12px;font-size:18px;color:#f87171;">${safeTitle}</h2>
        <p style="margin:0 0 16px;color:#d1d5db;line-height:1.5;">${safeBody}</p>
        <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Schedule id: ${opts.scheduleId} · Status: ${opts.status} · Consecutive failures: ${consecutiveFailures}</p>
      </div>`;

    const { dispatchNotification } = await import("../lib/notifyDispatch");
    await dispatchNotification("side_game.receipt.digest.failed", userIds, {
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
      // Task #1734 — opt this dispatch into the per-recipient
      // "Mute this alert" footer link + List-Unsubscribe headers.
      // Carries the org id only so the confirmation page can name
      // the club; the underlying flag flip is user-scoped.
      eventMuteOrgId: opts.orgId,
    });
  } catch (err) {
    logger.warn({ err, scheduleId: opts.scheduleId }, "[side-game-receipt-digest] admin failure dispatch failed");
  }
}

/** Cron entry-point for stuck side-game receipt digests (Task #1290). */
export async function runDueSideGameReceiptDigestSchedules(): Promise<void> {
  const now = new Date();
  const due = await db.select({ id: sideGameReceiptDigestSchedulesTable.id })
    .from(sideGameReceiptDigestSchedulesTable)
    .where(and(
      eq(sideGameReceiptDigestSchedulesTable.enabled, true),
      lte(sideGameReceiptDigestSchedulesTable.nextRunAt, now),
    ));
  for (const row of due) {
    try {
      await runOneSideGameReceiptDigestSchedule(row.id);
    } catch (err) {
      logger.warn({ err, scheduleId: row.id }, "[side-game-receipt-digest] schedule poll error");
    }
  }
}

// ─── ADMIN: STUCK WALLET WITHDRAWAL NOTIFICATIONS (Task #1278) ─────────
//
// The wallet withdrawal notify retry cron (Task #1108) re-attempts
// failed email/push deliveries up to WALLET_WITHDRAWAL_NOTIFY_MAX_*
// times with exponential backoff. When a channel exhausts its budget,
// `*RetryExhaustedAt` is stamped on the attempts row and the cron
// stops re-selecting it. This endpoint surfaces those exhausted (or
// permanently skipped) rows so support can proactively reach out to
// members whose payout confirmation never arrived. Read-only — the
// member-facing badge derived from the same attempts row tells the
// member which channel went silent.

interface StuckWithdrawalNotifyRow {
  id: number;
  withdrawalId: number;
  organizationId: number;
  userId: number;
  // Task #1869: optional clubMembers.id so the dashboard widget can deep-
  // link the recipient name to their Member 360 (Financial tab) — the
  // same regression-risk surface the side-game receipts widget already
  // covers via Task #1291. Null when the recipient user has no
  // club_members row in this org (e.g. a guest withdrawal that pre-
  // dates org enrolment).
  recipientClubMemberId: number | null;
  outcome: string;
  amount: number;
  currency: string;
  destination: string;
  utr: string | null;
  reason: string | null;
  createdAt: string;
  recipientName: string | null;
  recipientEmail: string | null;
  emailStatus: string | null;
  emailAttempts: number;
  lastEmailAt: string | null;
  lastEmailError: string | null;
  emailRetryExhaustedAt: string | null;
  pushStatus: string | null;
  pushAttempts: number;
  lastPushAt: string | null;
  lastPushError: string | null;
  pushRetryExhaustedAt: string | null;
  // Task #1825 — SMS / WhatsApp result snapshot. Audit-only (neither
  // channel is retried by the wallet-withdrawal cron) so there are
  // no `*Attempts` / `*RetryExhaustedAt` siblings for them, and the
  // dashboard `*Stuck` predicate is intentionally not extended:
  // these fields are surfaced for "did the member get pinged?"
  // visibility, not for the retry-failure worklist.
  smsStatus: string | null;
  smsError: string | null;
  lastSmsAt: string | null;
  whatsappStatus: string | null;
  whatsappError: string | null;
  lastWhatsappAt: string | null;
  emailStuck: boolean;
  pushStuck: boolean;
}

function isWithdrawalChannelStuck(status: string | null, exhaustedAt: Date | null): boolean {
  if (exhaustedAt) return true;
  if (status === "skipped" || status === "no_address" || status === "opted_out") {
    return true;
  }
  return false;
}

/**
 * POST /admin/wallet/payout-accounts/:id/reverify  (Task #1289)
 *
 * Org-admin (or super-admin) trigger that re-runs the same VPA / bank-
 * fund-account validation the daily wallet-payout cron uses (Task #1119)
 * against a single member's saved payout account. Mirrors the coach
 * sibling at
 *   POST /coach-marketplace/admin/coaches/:proId/payout-account/reverify
 * (Task #1062 / #1222) so support can unstick a member who phones in to
 * say "I re-issued my UPI, please re-check it" without making them re-
 * type the details or waiting up to a day for the nightly batch.
 *
 * Returns the updated row + the reverify outcome (`verified`,
 * `needs_attention`, `skipped` for a still-pending penny-drop, or
 * `error`) so the admin UI can show inline feedback.
 *
 * Audit (Task #1518): every successful call inserts a row into
 * `wallet_payout_account_history` with the masked snapshot of the saved
 * account, the verification outcome + reason, and the calling admin's
 * id / IP / user-agent — same compliance contract as the coach
 * sibling. Persistence is *mandatory*: if the audit insert fails we
 * return 500 so the admin retries, rather than silently completing an
 * unaudited state change. We pair the structured `payoutLogger.info`
 * line below with the row insert (mirrors the coach endpoint).
 */
router.post("/admin/wallet/payout-accounts/:id/reverify", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const accountId = parseInt(String((req.params as Record<string, string>).id), 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: "Invalid account id" });
    return;
  }

  const [row] = await db.select().from(walletPayoutAccountsTable)
    .where(eq(walletPayoutAccountsTable.id, accountId));
  if (!row) { { res.status(404).json({ error: "Wallet payout account not found" }); return; } }

  if (!await requireOrgAdmin(req, res, row.organizationId)) return;

  // No fund account on file ⇒ nothing to validate. The cron skips these
  // silently (loadStaleAccounts filters on `isNotNull(razorpayFundAccountId)`),
  // so we surface a clear 400 rather than calling Razorpay with a null id.
  if (!row.razorpayFundAccountId) {
    res.status(400).json({ error: "Member has no saved payout account to re-verify" });
    return;
  }

  // Snapshot the saved account *before* re-running the validation so
  // the audit row carries the same masked details (UPI/last4/IFSC) as
  // the row the admin saw in the dashboard. `row` itself is already
  // pre-reverify (we only re-fetch *after* the validation runs below).
  const accountBefore = row;

  const result = await reverifyOneWalletAccount(row);

  // Re-fetch so the response carries the post-reverify row (verifiedAt /
  // verificationStatus / verificationFailureReason will reflect the
  // outcome). Skip / pending leaves the row untouched, but we still
  // re-fetch for a single consistent shape.
  const [updated] = await db.select().from(walletPayoutAccountsTable)
    .where(eq(walletPayoutAccountsTable.id, accountId));

  const ipAddress = req.ip
    ?? (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? null;
  const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
  const adminUserId = getUserId(req);

  // Task #1518 — Persist the audit row before responding. Compliance
  // contract: a 200 from this endpoint must imply an `admin_reverify`
  // history row has been committed. If the insert fails, log the
  // outcome (so the admin's action is recoverable from logs) and
  // return 500 so the admin retries — `reverifyOneWalletAccount` is
  // idempotent, so a retry will produce a single audit row once
  // persistence succeeds rather than leaving an unaudited state
  // change.
  if (adminUserId == null) {
    // requireOrgAdmin only returns true for authenticated admins, so
    // this is unreachable in practice — but the audit row's
    // `changedByUserId` would be null without a real id, defeating the
    // whole point of the table. Refuse loudly rather than silently
    // mis-attributing.
    res.status(500).json({ error: "Could not resolve calling admin id; please retry" });
    return;
  }
  try {
    await recordWalletAdminReverifyHistory({
      walletPayoutAccountId: accountId,
      organizationId: row.organizationId,
      userId: row.userId,
      adminUserId,
      accountBefore,
      outcome: result.outcome,
      reason: result.reason ?? null,
      ipAddress,
      userAgent,
    });
  } catch (auditErr) {
    logger.error(
      {
        err: auditErr,
        accountId,
        organizationId: row.organizationId,
        userId: row.userId,
        adminUserId,
        outcome: result.outcome,
        reason: result.reason ?? null,
      },
      "[side-games-v2] failed to record wallet admin re-verify audit row — failing the request to preserve the audit guarantee",
    );
    res.status(500).json({ error: "Failed to record audit entry; please retry" });
    return;
  }

  logger.info(
    {
      accountId,
      organizationId: row.organizationId,
      userId: row.userId,
      adminUserId,
      method: result.method,
      outcome: result.outcome,
      reason: result.reason ?? null,
      ipAddress,
      userAgent,
    },
    "[side-games-v2] Admin-triggered wallet payout-account re-verification",
  );

  res.json({
    account: updated ?? row,
    outcome: result.outcome,
    method: result.method,
    reason: result.reason ?? null,
  });
});

/**
 * GET /admin/wallet/payout-accounts/:id/history  (Task #1518)
 *
 * Org-admin (or super-admin) read endpoint that surfaces the
 * `wallet_payout_account_history` rows for a single saved member
 * payout account. Mirrors
 *   GET /coach-marketplace/admin/coaches/:proId/payout-account/history
 * (Task #764). Returns the audit rows newest-first with the calling
 * admin's display name joined in so the dashboard can render
 * "Re-verified by Alice on …" without an extra round-trip.
 *
 * Today every row is an `admin_reverify` (the only writer is the
 * sibling POST endpoint above), but the response shape mirrors the
 * coach sibling so the UI can grow into 'created' / 'updated' rows
 * without another contract change.
 */
router.get("/admin/wallet/payout-accounts/:id/history", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const accountId = parseInt(String((req.params as Record<string, string>).id), 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: "Invalid account id" });
    return;
  }

  const [account] = await db.select().from(walletPayoutAccountsTable)
    .where(eq(walletPayoutAccountsTable.id, accountId));
  if (!account) { { res.status(404).json({ error: "Wallet payout account not found" }); return; } }

  if (!await requireOrgAdmin(req, res, account.organizationId)) return;

  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : 200;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), 1000)
    : 200;

  const rows = await db.select({
    history: walletPayoutAccountHistoryTable,
    changedByName: appUsersTable.displayName,
    changedByUsername: appUsersTable.username,
  })
    .from(walletPayoutAccountHistoryTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, walletPayoutAccountHistoryTable.changedByUserId))
    .where(eq(walletPayoutAccountHistoryTable.walletPayoutAccountId, accountId))
    .orderBy(desc(walletPayoutAccountHistoryTable.createdAt))
    .limit(limit);

  res.json({
    account: {
      id: account.id,
      organizationId: account.organizationId,
      userId: account.userId,
      method: account.method,
      accountHolderName: account.accountHolderName,
      bankAccountNumberLast4: account.bankAccountNumber ? account.bankAccountNumber.slice(-4) : null,
      bankIfsc: account.bankIfsc,
      upiVpa: account.upiVpa,
      verifiedAt: account.verifiedAt ? account.verifiedAt.toISOString() : null,
      verificationStatus: account.verificationStatus,
      verificationFailureReason: account.verificationFailureReason,
    },
    history: rows.map(r => ({
      id: r.history.id,
      walletPayoutAccountId: r.history.walletPayoutAccountId,
      changeKind: r.history.changeKind,
      method: r.history.method,
      accountHolderName: r.history.accountHolderName,
      upiVpaMasked: r.history.upiVpaMasked,
      bankAccountLast4: r.history.bankAccountLast4,
      bankIfsc: r.history.bankIfsc,
      razorpayContactId: r.history.razorpayContactId,
      razorpayFundAccountId: r.history.razorpayFundAccountId,
      changedByUserId: r.history.changedByUserId,
      changedByRole: r.history.changedByRole,
      changedByName: r.changedByName ?? r.changedByUsername ?? null,
      verificationOutcome: r.history.verificationOutcome,
      verificationReason: r.history.verificationReason,
      ipAddress: r.history.ipAddress,
      userAgent: r.history.userAgent,
      createdAt: r.history.createdAt,
    })),
  });
});

// ─── Task #1278 / Task #1844 — stuck wallet-withdrawal alert filters ───
//
// Shared between the JSON list endpoint (paginated dashboard widget)
// and the `.csv` download (Task #1844 — finance/support handoff). Keep
// the SQL where-clause derivation in one place so the CSV cannot drift
// out of sync with the table the operator just reviewed.
const STUCK_WALLET_NOTIFY_STATUSES = ["skipped", "no_address", "opted_out"];

interface StuckWalletAlertFilters {
  orgId: number;
  channel: "email" | "push" | null;
  state: "exhausted" | "skipped" | null;
  recipientQuery: string;
}

function buildStuckWalletAlertWhereClause(filters: StuckWalletAlertFilters) {
  const { orgId, channel, state, recipientQuery } = filters;

  const emailExhausted = isNotNull(walletWithdrawalNotifyAttemptsTable.emailRetryExhaustedAt);
  const pushExhausted = isNotNull(walletWithdrawalNotifyAttemptsTable.pushRetryExhaustedAt);
  const emailSkipped = inArray(walletWithdrawalNotifyAttemptsTable.emailStatus, STUCK_WALLET_NOTIFY_STATUSES);
  const pushSkipped = inArray(walletWithdrawalNotifyAttemptsTable.pushStatus, STUCK_WALLET_NOTIFY_STATUSES);
  const eitherExhausted = or(emailExhausted, pushExhausted);
  const eitherSkipped = or(emailSkipped, pushSkipped);

  let stuckClause;
  if (channel === "email" && state === "exhausted") {
    stuckClause = emailExhausted;
  } else if (channel === "email" && state === "skipped") {
    stuckClause = and(emailSkipped, sql`${walletWithdrawalNotifyAttemptsTable.emailRetryExhaustedAt} is null`);
  } else if (channel === "email") {
    stuckClause = or(emailExhausted, emailSkipped);
  } else if (channel === "push" && state === "exhausted") {
    stuckClause = pushExhausted;
  } else if (channel === "push" && state === "skipped") {
    stuckClause = and(pushSkipped, sql`${walletWithdrawalNotifyAttemptsTable.pushRetryExhaustedAt} is null`);
  } else if (channel === "push") {
    stuckClause = or(pushExhausted, pushSkipped);
  } else if (state === "exhausted") {
    stuckClause = eitherExhausted;
  } else if (state === "skipped") {
    stuckClause = and(
      sql`${walletWithdrawalNotifyAttemptsTable.emailRetryExhaustedAt} is null`,
      sql`${walletWithdrawalNotifyAttemptsTable.pushRetryExhaustedAt} is null`,
      eitherSkipped,
    );
  } else {
    stuckClause = or(eitherExhausted, eitherSkipped);
  }

  const recipientClause = recipientQuery.length > 0
    ? (() => {
      const pat = `%${recipientQuery}%`;
      return or(
        ilike(clubMembersTable.firstName, pat),
        ilike(clubMembersTable.lastName, pat),
        ilike(clubMembersTable.email, pat),
        ilike(appUsersTable.displayName, pat),
        ilike(appUsersTable.username, pat),
        ilike(appUsersTable.email, pat),
      );
    })()
    : null;

  // Task #1843 — bulk acknowledge stamps `adminFollowupAcknowledgedAt`,
  // which signals "admin has manually cleared this alert". Hide those
  // rows from the worklist (and from the dashboard widget + CSV export
  // that share this helper) so the count drops as admins work through
  // the list. The original Task #1501 column is reused — both pages
  // clear via the same audit field so a row dismissed on either screen
  // disappears everywhere.
  const notAcknowledgedClause = sql`${walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt} IS NULL`;

  return and(
    eq(walletWithdrawalNotifyAttemptsTable.organizationId, orgId),
    notAcknowledgedClause,
    stuckClause,
    ...(recipientClause ? [recipientClause] : []),
  );
}

function parseStuckWalletAlertQuery(req: Request): {
  channel: "email" | "push" | null;
  state: "exhausted" | "skipped" | null;
  recipientQuery: string;
} {
  const channelParam = typeof req.query.channel === "string" ? req.query.channel : null;
  const channel: "email" | "push" | null =
    channelParam === "email" || channelParam === "push" ? channelParam : null;
  const stateParam = typeof req.query.state === "string" ? req.query.state : null;
  const state: "exhausted" | "skipped" | null =
    stateParam === "exhausted" || stateParam === "skipped" ? stateParam : null;
  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const recipientQuery = qRaw.slice(0, 200);
  return { channel, state, recipientQuery };
}

router.get("/admin/wallet-withdrawal-notify-failures", async (req: Request, res: Response) => {
  const orgId = req.query.organizationId ? Number(req.query.organizationId) : NaN;
  if (!Number.isFinite(orgId) || orgId <= 0) {
    res.status(400).json({ error: "organizationId is required" });
    return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { channel, state, recipientQuery } = parseStuckWalletAlertQuery(req);

  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : 200;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), 200)
    : 200;
  const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : 0;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  const emailExhausted = isNotNull(walletWithdrawalNotifyAttemptsTable.emailRetryExhaustedAt);
  const pushExhausted = isNotNull(walletWithdrawalNotifyAttemptsTable.pushRetryExhaustedAt);
  const emailSkipped = inArray(walletWithdrawalNotifyAttemptsTable.emailStatus, STUCK_WALLET_NOTIFY_STATUSES);
  const pushSkipped = inArray(walletWithdrawalNotifyAttemptsTable.pushStatus, STUCK_WALLET_NOTIFY_STATUSES);
  const eitherExhausted = or(emailExhausted, pushExhausted);
  const eitherSkipped = or(emailSkipped, pushSkipped);

  const recipientClause = recipientQuery.length > 0
    ? (() => {
      const pat = `%${recipientQuery}%`;
      return or(
        ilike(clubMembersTable.firstName, pat),
        ilike(clubMembersTable.lastName, pat),
        ilike(clubMembersTable.email, pat),
        ilike(appUsersTable.displayName, pat),
        ilike(appUsersTable.username, pat),
        ilike(appUsersTable.email, pat),
      );
    })()
    : null;

  const whereClause = buildStuckWalletAlertWhereClause({
    orgId, channel, state, recipientQuery,
  });

  // Task #1843 — secondary counts query below filters by channel/state
  // independently from `whereClause`, so it needs its own copy of the
  // ack filter. Keep the predicate identical to the helper so both
  // queries hide the same set of acknowledged rows.
  const notAcknowledgedClause = sql`${walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt} IS NULL`;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(walletWithdrawalNotifyAttemptsTable)
    .leftJoin(
      clubMembersTable,
      and(
        eq(clubMembersTable.organizationId, walletWithdrawalNotifyAttemptsTable.organizationId),
        eq(clubMembersTable.userId, walletWithdrawalNotifyAttemptsTable.userId),
      ),
    )
    .leftJoin(
      appUsersTable,
      eq(appUsersTable.id, walletWithdrawalNotifyAttemptsTable.userId),
    )
    .where(whereClause);

  const baseChannelClause = channel === "email"
    ? or(emailExhausted, emailSkipped)
    : channel === "push"
      ? or(pushExhausted, pushSkipped)
      : or(eitherExhausted, eitherSkipped);
  const [{ exhausted, skipped }] = await db
    .select({
      exhausted: sql<number>`count(*) filter (where ${
        channel === "email" ? emailExhausted
          : channel === "push" ? pushExhausted
            : eitherExhausted
      })::int`,
      skipped: sql<number>`count(*) filter (where ${
        channel === "email"
          ? sql`${emailSkipped} and ${walletWithdrawalNotifyAttemptsTable.emailRetryExhaustedAt} is null`
          : channel === "push"
            ? sql`${pushSkipped} and ${walletWithdrawalNotifyAttemptsTable.pushRetryExhaustedAt} is null`
            : sql`${eitherSkipped} and ${walletWithdrawalNotifyAttemptsTable.emailRetryExhaustedAt} is null and ${walletWithdrawalNotifyAttemptsTable.pushRetryExhaustedAt} is null`
      })::int`,
    })
    .from(walletWithdrawalNotifyAttemptsTable)
    .leftJoin(
      clubMembersTable,
      and(
        eq(clubMembersTable.organizationId, walletWithdrawalNotifyAttemptsTable.organizationId),
        eq(clubMembersTable.userId, walletWithdrawalNotifyAttemptsTable.userId),
      ),
    )
    .leftJoin(
      appUsersTable,
      eq(appUsersTable.id, walletWithdrawalNotifyAttemptsTable.userId),
    )
    .where(and(
      eq(walletWithdrawalNotifyAttemptsTable.organizationId, orgId),
      notAcknowledgedClause,
      baseChannelClause,
      ...(recipientClause ? [recipientClause] : []),
    ));

  const rows = await db.select({
    a: walletWithdrawalNotifyAttemptsTable,
    clubMemberId: clubMembersTable.id,
    memberFirstName: clubMembersTable.firstName,
    memberLastName: clubMembersTable.lastName,
    memberEmail: clubMembersTable.email,
    userDisplayName: appUsersTable.displayName,
    userUsername: appUsersTable.username,
    userEmail: appUsersTable.email,
  })
    .from(walletWithdrawalNotifyAttemptsTable)
    .leftJoin(
      clubMembersTable,
      and(
        eq(clubMembersTable.organizationId, walletWithdrawalNotifyAttemptsTable.organizationId),
        eq(clubMembersTable.userId, walletWithdrawalNotifyAttemptsTable.userId),
      ),
    )
    .leftJoin(
      appUsersTable,
      eq(appUsersTable.id, walletWithdrawalNotifyAttemptsTable.userId),
    )
    .where(whereClause)
    .orderBy(desc(walletWithdrawalNotifyAttemptsTable.createdAt))
    .limit(limit)
    .offset(offset);

  const items: StuckWithdrawalNotifyRow[] = rows.map(r => {
    const a = r.a;
    const recipientName = (() => {
      const fromMember = `${r.memberFirstName ?? ""} ${r.memberLastName ?? ""}`.trim();
      if (fromMember) return fromMember;
      const fromUser = (r.userDisplayName ?? r.userUsername ?? "").trim();
      return fromUser || null;
    })();
    return {
      id: a.id,
      withdrawalId: a.withdrawalId,
      organizationId: a.organizationId,
      userId: a.userId,
      // Task #1869 — surface the resolved club_members.id (or null when
      // the recipient has no membership row in this org) so the
      // dashboard widget can deep-link the recipient name to Member 360.
      recipientClubMemberId: r.clubMemberId ?? null,
      outcome: a.outcome,
      amount: Number(a.amount),
      currency: a.currency,
      destination: a.destination,
      utr: a.utr,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
      recipientName,
      recipientEmail: r.memberEmail ?? r.userEmail ?? null,
      emailStatus: a.emailStatus,
      emailAttempts: a.emailAttempts,
      lastEmailAt: a.lastEmailAt ? a.lastEmailAt.toISOString() : null,
      lastEmailError: a.lastEmailError,
      emailRetryExhaustedAt: a.emailRetryExhaustedAt ? a.emailRetryExhaustedAt.toISOString() : null,
      pushStatus: a.pushStatus,
      pushAttempts: a.pushAttempts,
      lastPushAt: a.lastPushAt ? a.lastPushAt.toISOString() : null,
      lastPushError: a.lastPushError,
      pushRetryExhaustedAt: a.pushRetryExhaustedAt ? a.pushRetryExhaustedAt.toISOString() : null,
      // Task #1825 — surface the SMS / WhatsApp delivery snapshot so
      // admins can confirm "did the member get pinged?" on those
      // channels too. These channels are not retried by the cron, so
      // there is no `*Stuck` flag — the row only ever appears in the
      // failures worklist via an email/push problem (preserved above).
      smsStatus: a.smsStatus,
      smsError: a.smsError,
      lastSmsAt: a.lastSmsAt ? a.lastSmsAt.toISOString() : null,
      whatsappStatus: a.whatsappStatus,
      whatsappError: a.whatsappError,
      lastWhatsappAt: a.lastWhatsappAt ? a.lastWhatsappAt.toISOString() : null,
      emailStuck: isWithdrawalChannelStuck(a.emailStatus, a.emailRetryExhaustedAt),
      pushStuck: isWithdrawalChannelStuck(a.pushStatus, a.pushRetryExhaustedAt),
    };
  });

  res.json({
    items,
    counts: { total, exhausted, skipped },
    page: { limit, offset },
    filters: { channel, state, q: recipientQuery || null },
  });
});

// ─── Task #1844 — CSV export of the stuck wallet alerts list ───────────
//
// Mirrors the JSON `/admin/wallet-withdrawal-notify-failures` widget so
// support and finance teams can hand the worklist off to bookkeepers
// without screen-scraping the table. The same channel/state/q filters
// apply, but pagination is dropped (CSV is meant to be a single-shot
// download of the currently-filtered set).
//
// One row per *stuck channel* — a single attempt with both email and
// push stuck emits two rows, each carrying its own attempts / last
// error / last-attempt timestamp. That keeps each line self-contained
// for triage and matches the per-channel framing of the task spec.
//
// Capped at 10k rows to keep the response bounded; orgs that exceed
// the cap can narrow with the existing channel/state/recipient filters
// and re-export.
const STUCK_WALLET_ALERT_CSV_LIMIT = 10_000;

router.get("/admin/wallet-withdrawal-notify-failures.csv", async (req: Request, res: Response) => {
  const orgId = req.query.organizationId ? Number(req.query.organizationId) : NaN;
  if (!Number.isFinite(orgId) || orgId <= 0) {
    res.status(400).json({ error: "organizationId is required" });
    return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { channel, state, recipientQuery } = parseStuckWalletAlertQuery(req);

  const whereClause = buildStuckWalletAlertWhereClause({
    orgId, channel, state, recipientQuery,
  });

  const rows = await db.select({
    a: walletWithdrawalNotifyAttemptsTable,
    memberFirstName: clubMembersTable.firstName,
    memberLastName: clubMembersTable.lastName,
    memberEmail: clubMembersTable.email,
    userDisplayName: appUsersTable.displayName,
    userUsername: appUsersTable.username,
    userEmail: appUsersTable.email,
  })
    .from(walletWithdrawalNotifyAttemptsTable)
    .leftJoin(
      clubMembersTable,
      and(
        eq(clubMembersTable.organizationId, walletWithdrawalNotifyAttemptsTable.organizationId),
        eq(clubMembersTable.userId, walletWithdrawalNotifyAttemptsTable.userId),
      ),
    )
    .leftJoin(
      appUsersTable,
      eq(appUsersTable.id, walletWithdrawalNotifyAttemptsTable.userId),
    )
    .where(whereClause)
    .orderBy(desc(walletWithdrawalNotifyAttemptsTable.createdAt))
    .limit(STUCK_WALLET_ALERT_CSV_LIMIT);

  const header = [
    "created_at",
    "recipient_name",
    "recipient_email",
    "withdrawal_id",
    "amount",
    "currency",
    "channel",
    "state",
    "attempts",
    "last_error",
    "last_attempt_at",
  ];
  const csvRows: string[][] = [header];

  for (const r of rows) {
    const a = r.a;
    const recipientName = (() => {
      const fromMember = `${r.memberFirstName ?? ""} ${r.memberLastName ?? ""}`.trim();
      if (fromMember) return fromMember;
      const fromUser = (r.userDisplayName ?? r.userUsername ?? "").trim();
      return fromUser || "";
    })();
    const recipientEmail = r.memberEmail ?? r.userEmail ?? "";
    const amount = Number(a.amount).toFixed(2);

    const emitChannel = (
      ch: "email" | "push",
      stuck: boolean,
      exhaustedAt: Date | null,
      attempts: number,
      lastError: string | null,
      lastAt: Date | null,
    ) => {
      if (!stuck) return;
      if (channel && channel !== ch) return;
      const rowState: "exhausted" | "skipped" = exhaustedAt ? "exhausted" : "skipped";
      if (state && state !== rowState) return;
      csvRows.push([
        a.createdAt.toISOString(),
        recipientName,
        recipientEmail,
        String(a.withdrawalId),
        amount,
        a.currency,
        ch,
        rowState,
        String(attempts),
        lastError ?? "",
        lastAt ? lastAt.toISOString() : "",
      ]);
    };

    emitChannel(
      "email",
      isWithdrawalChannelStuck(a.emailStatus, a.emailRetryExhaustedAt),
      a.emailRetryExhaustedAt,
      a.emailAttempts,
      a.lastEmailError,
      a.lastEmailAt,
    );
    emitChannel(
      "push",
      isWithdrawalChannelStuck(a.pushStatus, a.pushRetryExhaustedAt),
      a.pushRetryExhaustedAt,
      a.pushAttempts,
      a.lastPushError,
      a.lastPushAt,
    );
  }

  const csv = csvRows
    .map(row => row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="wallet-stuck-alerts-${orgId}.csv"`,
  );
  res.send(csv);
});

// ─── Task #1843 — bulk acknowledge / retry stuck wallet alerts ───────
//
// The /admin/wallet-alerts page surfaces every stuck wallet-withdrawal
// notification but originally had no way to act on rows from the page
// itself — admins had to dig into each member's wallet history to
// resolve them one-by-one. These two endpoints close that loop:
//
//   POST /admin/wallet-withdrawal-notify-failures/acknowledge
//        Body: { organizationId, ids: number[] }
//        Stamps `adminFollowupAcknowledgedAt` (and `…By`) on every
//        selected row that belongs to the org. Idempotent — already
//        acknowledged rows are reported back as `skipped` and keep
//        their original audit stamps. Acknowledged rows disappear
//        from the GET handler above (and therefore from the dashboard
//        widget that shares this endpoint), shrinking the count.
//
//   POST /admin/wallet-withdrawal-notify-failures/retry
//        Body: { organizationId, ids: number[] }
//        Resets the stuck channels on each selected row so the cron
//        picks them up on the next sweep:
//          - clears `*RetryExhaustedAt`
//          - clears `adminExhaustionNotifiedAt` (so a future
//            re-exhaustion can fire the admin alert again)
//          - sets `*Status = 'failed'`, `*Attempts = 0`,
//            `nextRetryAt = now`
//        Channels that were never stuck (e.g. `sent`) are left
//        untouched. The retry semantics fall through to the existing
//        cron + retry helpers in `walletWithdrawalNotify.ts`, so a
//        member who has since opted out still ends up with the
//        correct `opted_out` terminal state on the next cron tick.
//
// A row is "stuck" on a channel when either:
//   - `*RetryExhaustedAt IS NOT NULL` (cron gave up), or
//   - `*Status IN ('skipped','no_address','opted_out')` (notify
//     helper short-circuited before delivery).
// This matches the GET handler above so the per-row "Retry" button
// resets exactly the channels surfaced as stuck on the row.

const STUCK_NON_EXHAUSTED_STATUSES = new Set(["skipped", "no_address", "opted_out"]);

function rowChannelStuck(
  status: string | null,
  exhaustedAt: Date | null,
): boolean {
  if (exhaustedAt) return true;
  return status != null && STUCK_NON_EXHAUSTED_STATUSES.has(status);
}

function parseBulkBody(req: Request): {
  orgId: number;
  ids: number[];
  error?: string;
} {
  const body = (req.body ?? {}) as { organizationId?: unknown; ids?: unknown };
  const orgId = Number(body.organizationId);
  if (!Number.isFinite(orgId) || orgId <= 0) {
    return { orgId: NaN, ids: [], error: "organizationId is required" };
  }
  if (!Array.isArray(body.ids)) {
    return { orgId, ids: [], error: "ids must be an array of numbers" };
  }
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const raw of body.ids) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    ids.push(n);
  }
  if (ids.length === 0) return { orgId, ids, error: "ids must contain at least one positive integer" };
  // Defensive cap so a runaway client can't sweep the entire table in one call.
  if (ids.length > 200) return { orgId, ids, error: "ids cannot contain more than 200 entries" };
  return { orgId, ids };
}

router.post("/admin/wallet-withdrawal-notify-failures/acknowledge", async (req: Request, res: Response) => {
  const parsed = parseBulkBody(req);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (!await requireOrgAdmin(req, res, parsed.orgId)) return;

  // Scope the SELECT/UPDATE to the requested org so an admin in org A
  // can never accidentally (or maliciously) ack a row that belongs to
  // org B by guessing its primary key.
  const candidates = await db.select({
    id: walletWithdrawalNotifyAttemptsTable.id,
    adminFollowupAcknowledgedAt: walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt,
  })
    .from(walletWithdrawalNotifyAttemptsTable)
    .where(and(
      eq(walletWithdrawalNotifyAttemptsTable.organizationId, parsed.orgId),
      inArray(walletWithdrawalNotifyAttemptsTable.id, parsed.ids),
    ));

  const eligibleIds = candidates
    .filter(r => r.adminFollowupAcknowledgedAt === null)
    .map(r => r.id);
  const alreadyAckedIds = candidates
    .filter(r => r.adminFollowupAcknowledgedAt !== null)
    .map(r => r.id);
  const foundIds = new Set(candidates.map(r => r.id));
  const notFoundIds = parsed.ids.filter(id => !foundIds.has(id));

  let acknowledged = 0;
  if (eligibleIds.length > 0) {
    const adminUserId = getUserId(req);
    const now = new Date();
    const updated = await db.update(walletWithdrawalNotifyAttemptsTable)
      .set({
        adminFollowupAcknowledgedAt: now,
        adminFollowupAcknowledgedBy: adminUserId,
      })
      .where(and(
        eq(walletWithdrawalNotifyAttemptsTable.organizationId, parsed.orgId),
        inArray(walletWithdrawalNotifyAttemptsTable.id, eligibleIds),
        // Re-check NULL so a concurrent ack on the same row does not
        // overwrite the earlier acknowledger / timestamp.
        sql`${walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt} IS NULL`,
      ))
      .returning({ id: walletWithdrawalNotifyAttemptsTable.id });
    acknowledged = updated.length;
    logger.info(
      {
        orgId: parsed.orgId,
        adminUserId,
        attemptIds: updated.map(u => u.id),
        ipAddress: req.ip ?? null,
      },
      "[side-games-v2] Admin bulk-acknowledged stuck wallet withdrawal alerts",
    );
  }

  res.json({
    acknowledged,
    alreadyAcknowledged: alreadyAckedIds.length,
    notFound: notFoundIds.length,
    ids: { acknowledged: eligibleIds, alreadyAcknowledged: alreadyAckedIds, notFound: notFoundIds },
  });
});

router.post("/admin/wallet-withdrawal-notify-failures/retry", async (req: Request, res: Response) => {
  const parsed = parseBulkBody(req);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (!await requireOrgAdmin(req, res, parsed.orgId)) return;

  const candidates = await db.select()
    .from(walletWithdrawalNotifyAttemptsTable)
    .where(and(
      eq(walletWithdrawalNotifyAttemptsTable.organizationId, parsed.orgId),
      inArray(walletWithdrawalNotifyAttemptsTable.id, parsed.ids),
    ));

  const foundIds = new Set(candidates.map(r => r.id));
  const notFoundIds = parsed.ids.filter(id => !foundIds.has(id));

  let requeuedRows = 0;
  let emailRequeued = 0;
  let pushRequeued = 0;
  let alreadyHealthy = 0;
  const now = new Date();
  const adminUserId = getUserId(req);

  for (const row of candidates) {
    const emailStuck = rowChannelStuck(row.emailStatus, row.emailRetryExhaustedAt);
    const pushStuck = rowChannelStuck(row.pushStatus, row.pushRetryExhaustedAt);
    if (!emailStuck && !pushStuck) {
      alreadyHealthy += 1;
      continue;
    }

    const patch: Record<string, unknown> = {};
    if (emailStuck) {
      patch.emailStatus = "failed";
      patch.emailAttempts = 0;
      patch.emailRetryExhaustedAt = null;
      patch.nextEmailRetryAt = now;
      patch.lastEmailError = null;
      emailRequeued += 1;
    }
    if (pushStuck) {
      patch.pushStatus = "failed";
      patch.pushAttempts = 0;
      patch.pushRetryExhaustedAt = null;
      patch.nextPushRetryAt = now;
      patch.lastPushError = null;
      pushRequeued += 1;
    }
    // Clear the admin-exhaustion-notified stamp so a future
    // re-exhaustion of the same row can fire the admin alert again.
    // The followup-ack stamp is intentionally left alone — if the row
    // was already acknowledged it stays acknowledged; the retry just
    // re-attempts delivery without un-dismissing the admin's earlier
    // sign-off.
    patch.adminExhaustionNotifiedAt = null;

    await db.update(walletWithdrawalNotifyAttemptsTable)
      .set(patch)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, row.id));
    requeuedRows += 1;
  }

  if (requeuedRows > 0) {
    logger.info(
      {
        orgId: parsed.orgId,
        adminUserId,
        requeuedRows,
        emailRequeued,
        pushRequeued,
        attemptIds: candidates
          .filter(r => rowChannelStuck(r.emailStatus, r.emailRetryExhaustedAt) || rowChannelStuck(r.pushStatus, r.pushRetryExhaustedAt))
          .map(r => r.id),
        ipAddress: req.ip ?? null,
      },
      "[side-games-v2] Admin bulk-retried stuck wallet withdrawal alerts",
    );
  }

  res.json({
    requeued: requeuedRows,
    emailRequeued,
    pushRequeued,
    alreadyHealthy,
    notFound: notFoundIds.length,
    ids: { notFound: notFoundIds },
  });
});

// ─── Task #1501 — admin worklist for retry-exhausted wallet alerts ───
//
// Once `notifyAdminsOfWalletWithdrawalRetryExhaustion` (Task #1279) has
// fired the single one-shot push to org admins, the only durable trace
// is the `adminExhaustionNotifiedAt` stamp on the attempts row. If the
// admin dismisses or misses that push, there is no way to find the
// failure later — they have no list view to reconcile from. This
// endpoint exposes that worklist: every notify-attempts row that has
// been alerted to admins but has not yet been marked as manually
// followed up.
//
// Mirrors the surface pattern used by the existing
// `wallet-withdrawal-notify-failures` widget but is scoped strictly to
// rows the admin alert has actually fired on (i.e. retries genuinely
// exhausted), and supports a dismissive "mark followed up" action so
// admins can clear rows once they've reached the member out-of-band.

interface ExhaustionAlertRow {
  id: number;
  withdrawalId: number;
  organizationId: number;
  userId: number;
  outcome: string;
  amount: number;
  currency: string;
  destination: string;
  utr: string | null;
  reason: string | null;
  createdAt: string;
  adminExhaustionNotifiedAt: string;
  recipientName: string | null;
  recipientEmail: string | null;
  emailStatus: string | null;
  emailAttempts: number;
  lastEmailAt: string | null;
  lastEmailError: string | null;
  emailRetryExhaustedAt: string | null;
  pushStatus: string | null;
  pushAttempts: number;
  lastPushAt: string | null;
  lastPushError: string | null;
  pushRetryExhaustedAt: string | null;
  lastError: string | null;
  // Task #1856 — surface the audit trail for already-cleared rows so
  // managers can see who took action and avoid double-handling. Null
  // for `status=open` rows (the existing worklist behavior).
  adminFollowupAcknowledgedAt: string | null;
  adminFollowupAcknowledgedBy: number | null;
  acknowledgedByName: string | null;
}

router.get("/admin/wallet-withdrawal-exhaustion-alerts", async (req: Request, res: Response) => {
  const orgId = req.query.organizationId ? Number(req.query.organizationId) : NaN;
  if (!Number.isFinite(orgId) || orgId <= 0) {
    res.status(400).json({ error: "organizationId is required" });
    return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Task #1856 — `status` selects which slice of the worklist the
  // caller wants. Default `open` preserves the original behavior
  // (un-acked rows only) for the dashboard widget and existing
  // page section. `acknowledged` returns recently-cleared rows so the
  // page can render an audit feed showing who marked each alert as
  // followed up. `all` returns both, for callers that want a single
  // chronological feed.
  const statusParam = typeof req.query.status === "string" ? req.query.status : "open";
  const status: "open" | "acknowledged" | "all" =
    statusParam === "acknowledged" || statusParam === "all" ? statusParam : "open";

  // Bound the acknowledged-rows window so the audit feed cannot grow
  // unbounded. 1..90 days, default 30 — matches the daily ops-alert
  // history page (Task #1304) so admins get a familiar default.
  const rawDays = Number.parseInt(String(req.query.days ?? "30"), 10);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 90) : 30;
  const ackSince = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Task #1858 — cursor pagination. The original endpoint hard-capped
  // results at 200 rows, which silently hid older alerts during
  // incident periods. We now accept a `limit` (1..200, default 50) and
  // a `cursor` that encodes the last row's ordering key + id so the UI
  // can page through arbitrarily long lists with a stable "Load more"
  // affordance. Smaller default keeps the dashboard widget snappy
  // while letting larger orgs explicitly opt into bigger pages.
  const rawLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;

  let cursor: { t: string; id: number } | null = null;
  if (typeof req.query.cursor === "string" && req.query.cursor) {
    try {
      const decoded = Buffer.from(req.query.cursor, "base64url").toString("utf8");
      const parsed = JSON.parse(decoded) as unknown;
      if (
        parsed && typeof parsed === "object"
        && typeof (parsed as { t?: unknown }).t === "string"
        && typeof (parsed as { id?: unknown }).id === "number"
      ) {
        cursor = { t: (parsed as { t: string }).t, id: (parsed as { id: number }).id };
      }
    } catch {
      // Invalid cursor is treated as "start from the beginning" rather
      // than a hard 400 — the page can recover by simply asking for the
      // first page again instead of surfacing an opaque error.
    }
  }

  // Aliased join on appUsersTable for the acknowledger so we can keep
  // the existing recipient (member-side) join intact. Without the
  // alias drizzle would reuse the same join and we'd lose the
  // recipient name for any acknowledged row.
  const acknowledgedByUsers = aliasedTable(appUsersTable, "acknowledgedByUsers");

  let statusFilter;
  if (status === "open") {
    statusFilter = sql`${walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt} IS NULL`;
  } else if (status === "acknowledged") {
    statusFilter = and(
      isNotNull(walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt),
      gte(walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt, ackSince),
    );
  } else {
    // status === "all"
    statusFilter = or(
      sql`${walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt} IS NULL`,
      gte(walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt, ackSince),
    );
  }

  // Order acknowledged rows by their ack time (newest first) so the
  // audit feed reads top-down by "who handled what most recently".
  // Open-only / mixed feeds keep ordering by the alert-fired stamp
  // since acked rows in a mixed feed have a non-null ack ts that
  // would otherwise jumble the un-acked ones.
  //
  // Task #1858 — id added as a tie-breaker so cursor pagination is
  // deterministic when multiple rows share the same timestamp.
  const cursorColumn = status === "acknowledged"
    ? walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt
    : walletWithdrawalNotifyAttemptsTable.adminExhaustionNotifiedAt;
  const orderClauses = [
    desc(cursorColumn),
    desc(walletWithdrawalNotifyAttemptsTable.id),
  ];

  // Build the cursor predicate: rows strictly older than the
  // `(timestamp, id)` we last returned. Skip silently if the supplied
  // cursor doesn't parse to a valid date.
  let cursorFilter;
  if (cursor) {
    const cursorDate = new Date(cursor.t);
    if (Number.isFinite(cursorDate.getTime())) {
      cursorFilter = or(
        sql`${cursorColumn} < ${cursorDate}`,
        and(
          sql`${cursorColumn} = ${cursorDate}`,
          sql`${walletWithdrawalNotifyAttemptsTable.id} < ${cursor.id}`,
        ),
      );
    }
  }

  // Total count for the *unpaginated* filter so the UI can show
  // "Showing N of M" without fetching the whole list. Counted in
  // parallel with the row fetch below.
  const baseWhere = and(
    eq(walletWithdrawalNotifyAttemptsTable.organizationId, orgId),
    isNotNull(walletWithdrawalNotifyAttemptsTable.adminExhaustionNotifiedAt),
    statusFilter,
  );

  const totalPromise = db.select({ n: sql<number>`count(*)::int` })
    .from(walletWithdrawalNotifyAttemptsTable)
    .where(baseWhere)
    .then(r => Number(r[0]?.n ?? 0));

  const rows = await db.select({
    a: walletWithdrawalNotifyAttemptsTable,
    memberFirstName: clubMembersTable.firstName,
    memberLastName: clubMembersTable.lastName,
    memberEmail: clubMembersTable.email,
    userDisplayName: appUsersTable.displayName,
    userUsername: appUsersTable.username,
    userEmail: appUsersTable.email,
    ackUserDisplayName: acknowledgedByUsers.displayName,
    ackUserUsername: acknowledgedByUsers.username,
  })
    .from(walletWithdrawalNotifyAttemptsTable)
    .leftJoin(
      clubMembersTable,
      and(
        eq(clubMembersTable.organizationId, walletWithdrawalNotifyAttemptsTable.organizationId),
        eq(clubMembersTable.userId, walletWithdrawalNotifyAttemptsTable.userId),
      ),
    )
    .leftJoin(
      appUsersTable,
      eq(appUsersTable.id, walletWithdrawalNotifyAttemptsTable.userId),
    )
    .leftJoin(
      acknowledgedByUsers,
      eq(acknowledgedByUsers.id, walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedBy),
    )
    .where(and(baseWhere, cursorFilter))
    .orderBy(...orderClauses)
    .limit(limit);

  const total = await totalPromise;

  const items: ExhaustionAlertRow[] = rows.map(r => {
    const a = r.a;
    const recipientName = (() => {
      const fromMember = `${r.memberFirstName ?? ""} ${r.memberLastName ?? ""}`.trim();
      if (fromMember) return fromMember;
      const fromUser = (r.userDisplayName ?? r.userUsername ?? "").trim();
      return fromUser || null;
    })();
    const acknowledgedByName = (() => {
      const fromUser = (r.ackUserDisplayName ?? r.ackUserUsername ?? "").trim();
      return fromUser || null;
    })();
    // Surface the most recent error (push or email, whichever fired
    // last) so the admin sees the actionable message at a glance.
    const lastEmailErrorAt = a.lastEmailAt ? a.lastEmailAt.getTime() : 0;
    const lastPushErrorAt = a.lastPushAt ? a.lastPushAt.getTime() : 0;
    const lastError = lastPushErrorAt >= lastEmailErrorAt
      ? (a.lastPushError ?? a.lastEmailError ?? null)
      : (a.lastEmailError ?? a.lastPushError ?? null);
    return {
      id: a.id,
      withdrawalId: a.withdrawalId,
      organizationId: a.organizationId,
      userId: a.userId,
      outcome: a.outcome,
      amount: Number(a.amount),
      currency: a.currency,
      destination: a.destination,
      utr: a.utr,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
      adminExhaustionNotifiedAt: a.adminExhaustionNotifiedAt!.toISOString(),
      recipientName,
      recipientEmail: r.memberEmail ?? r.userEmail ?? null,
      emailStatus: a.emailStatus,
      emailAttempts: a.emailAttempts,
      lastEmailAt: a.lastEmailAt ? a.lastEmailAt.toISOString() : null,
      lastEmailError: a.lastEmailError,
      emailRetryExhaustedAt: a.emailRetryExhaustedAt ? a.emailRetryExhaustedAt.toISOString() : null,
      pushStatus: a.pushStatus,
      pushAttempts: a.pushAttempts,
      lastPushAt: a.lastPushAt ? a.lastPushAt.toISOString() : null,
      lastPushError: a.lastPushError,
      pushRetryExhaustedAt: a.pushRetryExhaustedAt ? a.pushRetryExhaustedAt.toISOString() : null,
      lastError,
      adminFollowupAcknowledgedAt: a.adminFollowupAcknowledgedAt
        ? a.adminFollowupAcknowledgedAt.toISOString()
        : null,
      adminFollowupAcknowledgedBy: a.adminFollowupAcknowledgedBy,
      acknowledgedByName,
    };
  });

  // Task #1858 — emit a `nextCursor` only when the page filled all the
  // way up. The cursor encodes the last row's ordering timestamp +
  // id, matching the (timestamp DESC, id DESC) sort, so the client
  // can fetch strictly older rows on the next "Load more" request.
  let nextCursor: string | null = null;
  if (rows.length === limit && rows.length > 0) {
    const lastRow = rows[rows.length - 1].a;
    const lastTs = status === "acknowledged"
      ? lastRow.adminFollowupAcknowledgedAt
      : lastRow.adminExhaustionNotifiedAt;
    if (lastTs) {
      nextCursor = Buffer.from(
        JSON.stringify({ t: lastTs.toISOString(), id: lastRow.id }),
        "utf8",
      ).toString("base64url");
    }
  }

  res.json({
    items,
    count: items.length,
    total,
    status,
    days,
    limit,
    nextCursor,
  });
});

router.post("/admin/wallet-withdrawal-exhaustion-alerts/:attemptId/acknowledge", async (req: Request, res: Response) => {
  const attemptId = parseInt(String((req.params as Record<string, string>).attemptId), 10);
  if (!Number.isFinite(attemptId) || attemptId <= 0) {
    res.status(400).json({ error: "Invalid attempt id" });
    return;
  }

  const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
    .where(eq(walletWithdrawalNotifyAttemptsTable.id, attemptId));
  if (!row) {
    res.status(404).json({ error: "Notify attempt not found" });
    return;
  }
  if (!await requireOrgAdmin(req, res, row.organizationId)) return;

  // Refuse to acknowledge a row the admin alert never fired on — the
  // worklist surfaces only adminExhaustionNotifiedAt-stamped rows, so
  // an ack on anything else is a UI bug we want to catch loudly.
  if (!row.adminExhaustionNotifiedAt) {
    res.status(409).json({ error: "Admin exhaustion alert was never fired for this row" });
    return;
  }

  // Idempotent: if the row was already acknowledged, return the
  // existing stamps rather than overwriting them so we keep the
  // earliest acknowledger/timestamp on the audit trail.
  if (row.adminFollowupAcknowledgedAt) {
    res.json({
      acknowledgedAt: row.adminFollowupAcknowledgedAt.toISOString(),
      acknowledgedBy: row.adminFollowupAcknowledgedBy,
      alreadyAcknowledged: true,
    });
    return;
  }

  const adminUserId = getUserId(req);
  const now = new Date();
  await db.update(walletWithdrawalNotifyAttemptsTable)
    .set({
      adminFollowupAcknowledgedAt: now,
      adminFollowupAcknowledgedBy: adminUserId,
    })
    .where(and(
      eq(walletWithdrawalNotifyAttemptsTable.id, attemptId),
      sql`${walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt} IS NULL`,
    ));

  logger.info(
    {
      attemptId,
      withdrawalId: row.withdrawalId,
      organizationId: row.organizationId,
      memberUserId: row.userId,
      adminUserId,
      ipAddress: req.ip ?? null,
    },
    "[side-games-v2] Admin acknowledged wallet-withdrawal exhaustion alert",
  );

  res.json({
    acknowledgedAt: now.toISOString(),
    acknowledgedBy: adminUserId,
    alreadyAcknowledged: false,
  });
});

// Task #1857 — admin-driven "Retry delivery" action.
//
// Companion to /acknowledge: instead of just clearing the row off the
// worklist, this re-attempts delivery via the existing wallet
// withdrawal notify pipeline. Useful when the underlying delivery
// problem has been resolved out-of-band (member updated their email,
// re-installed the app and got a new push token, etc.).
//
// Behavior:
//   - 400 / 404 / 403 / 409 mirror the /acknowledge endpoint so a
//     stale UI click on a since-changed row produces a recognizable
//     error.
//   - 409 also rejects rows that have already been acknowledged
//     (acknowledged rows are out of the worklist; clicking Retry on
//     one would be a UI bug).
//   - Resets every previously-exhausted channel (email, push) on the
//     attempts row and immediately invokes the existing per-channel
//     retry helpers, which honor every per-channel guard
//     (preferEmail/preferPush, member-comm `billing` opt-out,
//     no-address, provider-not-configured).
//   - On a successful retry (any channel actually `sent`), stamps
//     `adminFollowupAcknowledgedAt` so the row drops off the worklist
//     just like /acknowledge.
//   - On a no-op retry (all eligible channels still failed / opted
//     out / no address / declined by the helper), the row stays on
//     the worklist so the admin can decide to manually acknowledge or
//     try again after fixing the upstream issue.
router.post("/admin/wallet-withdrawal-exhaustion-alerts/:attemptId/retry", async (req: Request, res: Response) => {
  const attemptId = parseInt(String((req.params as Record<string, string>).attemptId), 10);
  if (!Number.isFinite(attemptId) || attemptId <= 0) {
    res.status(400).json({ error: "Invalid attempt id" });
    return;
  }

  const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
    .where(eq(walletWithdrawalNotifyAttemptsTable.id, attemptId));
  if (!row) {
    res.status(404).json({ error: "Notify attempt not found" });
    return;
  }
  if (!await requireOrgAdmin(req, res, row.organizationId)) return;

  // Only retry rows that the admin worklist actually surfaces. The
  // worklist filters on adminExhaustionNotifiedAt-stamped &
  // not-yet-acknowledged, so refuse anything else loudly to surface
  // UI bugs (a stale click on a since-acked row, etc.) rather than
  // silently re-firing the pipeline on an arbitrary attempts row.
  if (!row.adminExhaustionNotifiedAt) {
    res.status(409).json({ error: "Admin exhaustion alert was never fired for this row" });
    return;
  }
  if (row.adminFollowupAcknowledgedAt) {
    res.status(409).json({ error: "Row has already been acknowledged" });
    return;
  }

  const adminUserId = getUserId(req);
  const result = await retryExhaustedWalletWithdrawalAttempt({
    attempt: row,
    logContext: {
      route: "side-games-v2.wallet-withdrawal-exhaustion-alerts.retry",
      attemptId: row.id,
      withdrawalId: row.withdrawalId,
      organizationId: row.organizationId,
      adminUserId,
    },
  });

  // Stamp the followup-acknowledged row when the retry actually
  // re-dispatched the alert (any channel `sent`). The condition
  // matches the worklist drop-off rule used by /acknowledge so the UI
  // behaves consistently: a successful retry both fires the new
  // attempt AND removes the row, mirroring the task's "drops off the
  // list (just like acknowledge)" requirement.
  let acknowledgedAt: string | null = null;
  if (result.anySent) {
    const now = new Date();
    await db.update(walletWithdrawalNotifyAttemptsTable)
      .set({
        adminFollowupAcknowledgedAt: now,
        adminFollowupAcknowledgedBy: adminUserId,
      })
      .where(and(
        eq(walletWithdrawalNotifyAttemptsTable.id, attemptId),
        sql`${walletWithdrawalNotifyAttemptsTable.adminFollowupAcknowledgedAt} IS NULL`,
      ));
    acknowledgedAt = now.toISOString();
  }

  logger.info(
    {
      attemptId,
      withdrawalId: row.withdrawalId,
      organizationId: row.organizationId,
      memberUserId: row.userId,
      adminUserId,
      ipAddress: req.ip ?? null,
      emailEligible: result.emailEligible,
      pushEligible: result.pushEligible,
      emailRetryStatus: result.emailRetry?.status ?? null,
      pushRetryStatus: result.pushRetry?.status ?? null,
      anySent: result.anySent,
      acknowledged: !!acknowledgedAt,
    },
    "[side-games-v2] Admin retried wallet-withdrawal exhaustion alert",
  );

  res.json({
    anySent: result.anySent,
    email: result.emailEligible
      ? {
        attempted: true,
        status: result.emailRetry?.status ?? null,
        error: result.emailRetry?.error ?? null,
        attempts: result.emailRetry?.attempts ?? null,
        exhausted: result.emailRetry?.exhausted ?? false,
      }
      : { attempted: false },
    push: result.pushEligible
      ? {
        attempted: true,
        status: result.pushRetry?.status ?? null,
        error: result.pushRetry?.error ?? null,
        attempts: result.pushRetry?.attempts ?? null,
        exhausted: result.pushRetry?.exhausted ?? false,
      }
      : { attempted: false },
    acknowledgedAt,
    acknowledgedBy: acknowledgedAt ? adminUserId : null,
  });
});

export default router;
