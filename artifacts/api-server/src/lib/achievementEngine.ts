import { db, achievementsTable, scoresTable, playersTable, tournamentsTable, leagueMembersTable, leaguesTable, leagueStandingsTable, holeDetailsTable, memberAuditLogTable } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { sendTransactionalPush } from "./comms";
import { notifyAchievementUnlocked, notifyNearMiss } from "./brandedNotifications.js";

export type BadgeDef = {
  type: string;
  label: string;
  icon: string;
  category: "milestone" | "scoring" | "consistency" | "social" | "seasonal";
  description: string;
};

export const ALL_BADGES: BadgeDef[] = [
  // Milestone
  { type: "first_birdie", label: "First Birdie", icon: "🐦", category: "milestone", description: "Score your first birdie" },
  { type: "first_eagle", label: "First Eagle", icon: "🦅", category: "milestone", description: "Score your first eagle" },
  { type: "first_hole_in_one", label: "Hole in One!", icon: "🎯", category: "milestone", description: "Score a hole in one" },
  { type: "first_tournament", label: "First Tournament", icon: "🏆", category: "social", description: "Play your first tournament" },
  { type: "first_par_round", label: "Even Par", icon: "⚑", category: "milestone", description: "Complete a round at even par or better" },
  // Scoring
  { type: "under_par_round", label: "Under Par Round", icon: "🔥", category: "scoring", description: "Complete any round under par" },
  { type: "3_birdies_round", label: "Birdie Spree", icon: "🐦🐦🐦", category: "scoring", description: "3+ birdies in a single round" },
  { type: "eagle_par5", label: "Eagle on Par 5", icon: "🦅⛳", category: "scoring", description: "Score eagle on a par 5" },
  { type: "bogey_free_round", label: "Bogey Free", icon: "✨", category: "scoring", description: "Complete a round with no bogeys" },
  { type: "back_nine_birdie_blitz", label: "Back 9 Birdie Blitz", icon: "🎆", category: "scoring", description: "3+ birdies on the back nine" },
  // Consistency
  { type: "10_rounds", label: "10 Rounds Played", icon: "🏅", category: "consistency", description: "Complete 10 rounds" },
  { type: "25_rounds", label: "25 Rounds Played", icon: "🥈", category: "consistency", description: "Complete 25 rounds" },
  { type: "50_rounds", label: "50 Rounds Played", icon: "🥇", category: "consistency", description: "Complete 50 rounds" },
  { type: "gir_50_pct", label: "GIR 50%+ for 5 Rounds", icon: "🟢", category: "consistency", description: "Hit 50%+ GIR in 5 consecutive rounds" },
  { type: "fairway_50_pct", label: "Fairway 50%+ for 5 Rounds", icon: "⬆️", category: "consistency", description: "50%+ fairways hit in 5 rounds" },
  { type: "10_birdies_career", label: "10 Career Birdies", icon: "🐦✅", category: "consistency", description: "Score 10 birdies across all rounds" },
  { type: "25_birdies_career", label: "25 Career Birdies", icon: "🐦🌟", category: "consistency", description: "Score 25 birdies across all rounds" },
  { type: "low_putts_round", label: "Putting Machine", icon: "🕳️", category: "consistency", description: "Average under 1.8 putts per hole in a round" },
  { type: "scratch_round", label: "Scratch Round", icon: "💎", category: "scoring", description: "Complete a round at scratch handicap or better (net score = gross)" },
  // Social
  { type: "10_courses", label: "Course Explorer", icon: "🗺️", category: "social", description: "Play on 10 different courses" },
  { type: "5_tournaments", label: "Tournament Regular", icon: "🏌️", category: "social", description: "Compete in 5 tournaments" },
  { type: "10_tournaments", label: "Tournament Veteran", icon: "🎖️", category: "social", description: "Compete in 10 tournaments" },
  // Seasonal
  { type: "tournament_champion", label: "Tournament Champion", icon: "🏆👑", category: "seasonal", description: "Win a tournament (1st place)" },
  { type: "league_winner", label: "League Winner", icon: "🥇🏌️", category: "seasonal", description: "Win a league season" },
  { type: "season_points_leader", label: "Points Leader", icon: "📊", category: "seasonal", description: "Lead a league in total points" },
  // Additional
  { type: "hat_trick_birdies", label: "Hat Trick", icon: "🎩", category: "scoring", description: "3 consecutive birdies in a round" },
  { type: "9_hole_hero", label: "9-Hole Hero", icon: "🌟", category: "scoring", description: "Score under par on either 9" },
  { type: "comeback_king", label: "Comeback King", icon: "👑", category: "scoring", description: "Turn 5+ over par into under par by hole 18" },
  { type: "perfect_attendance", label: "Perfect Attendance", icon: "📅", category: "seasonal", description: "Play every round of a tournament" },
  { type: "leaderboard_debut", label: "Leaderboard Debut", icon: "📋", category: "milestone", description: "Appear on a tournament leaderboard" },
];

const BADGE_MAP = new Map(ALL_BADGES.map(b => [b.type, b]));

/** Look up a badge definition (icon, label, category, description) by type. */
export function getBadgeDef(badgeType: string): BadgeDef | undefined {
  return BADGE_MAP.get(badgeType);
}

/**
 * Attempt to award a badge to a user.
 * Returns `true` ONLY when the badge is genuinely new (first time awarded).
 * Uses `.returning()` so `onConflictDoNothing()` correctly returns [] when the
 * badge already exists, avoiding duplicate push notifications on re-evaluation.
 */
async function awardBadge(
  userId: number,
  badgeType: string,
  extras?: { organizationId?: number; tournamentId?: number; leagueId?: number; metadata?: Record<string, unknown> },
): Promise<boolean> {
  const def = BADGE_MAP.get(badgeType);
  if (!def) return false;
  try {
    const rows = await db
      .insert(achievementsTable)
      .values({
        userId,
        organizationId: extras?.organizationId ?? null,
        badgeType,
        badgeLabel: def.label,
        badgeIcon: def.icon,
        badgeCategory: def.category,
        tournamentId: extras?.tournamentId ?? null,
        leagueId: extras?.leagueId ?? null,
        metadata: extras?.metadata ?? null,
        earnedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: achievementsTable.id });
    // rows is empty when the conflict triggered (badge already existed)
    return rows.length > 0;
  } catch { return false; }
}

export type BadgeProgress = { current: number; target: number };

/**
 * Compute progress (current vs target) for badges whose threshold is numeric
 * (rounds played, career birdies, distinct courses, distinct tournaments,
 * GIR/fairway 5-round counters). Single-round achievements (under-par round,
 * hat trick, etc.) are intentionally omitted — their description already
 * states the requirement.
 *
 * Returns a map keyed by badge type. The current value is *not* clamped to
 * the target so callers can still display "10 of 10" once a threshold is
 * met (and treat anything ≥ target as complete).
 */
export async function computeBadgeProgress(userId: number): Promise<Record<string, BadgeProgress>> {
  const playerRows = await db
    .select({ id: playersTable.id, tournamentId: playersTable.tournamentId })
    .from(playersTable)
    .where(eq(playersTable.userId, userId));

  const allPlayerIds = playerRows.map(p => p.id);
  const allScores = allPlayerIds.length
    ? await db.select().from(scoresTable).where(inArray(scoresTable.playerId, allPlayerIds))
    : [];

  const allTournamentIds = [...new Set([
    ...allScores.map(s => s.tournamentId),
    ...playerRows.map(p => p.tournamentId),
  ])];

  const tournamentCourses = allTournamentIds.length
    ? await db
        .select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId })
        .from(tournamentsTable)
        .where(inArray(tournamentsTable.id, allTournamentIds))
    : [];

  const courseIds = [...new Set(tournamentCourses.map(t => t.courseId).filter((c): c is number => c !== null))];

  const allHoleDetails = courseIds.length
    ? await db
        .select({ courseId: holeDetailsTable.courseId, holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
        .from(holeDetailsTable)
        .where(inArray(holeDetailsTable.courseId, courseIds))
    : [];

  const courseHoleParMap = new Map<number, Map<number, number>>();
  for (const h of allHoleDetails) {
    if (!courseHoleParMap.has(h.courseId)) courseHoleParMap.set(h.courseId, new Map());
    courseHoleParMap.get(h.courseId)!.set(h.holeNumber, h.par);
  }
  const tournamentCourseIdMap = new Map<number, number | null>(
    tournamentCourses.map(t => [t.id, t.courseId]),
  );
  function getHolePar(hn: number, tId: number): number {
    const cId = tournamentCourseIdMap.get(tId);
    if (cId == null) return 4;
    return courseHoleParMap.get(cId)?.get(hn) ?? 4;
  }

  const careerBirdies = allScores.filter(s => s.strokes - getHolePar(s.holeNumber, s.tournamentId) === -1).length;

  const roundGroups = new Map<string, typeof allScores>();
  for (const s of allScores) {
    const key = `${s.playerId}-${s.tournamentId}-${s.round}`;
    if (!roundGroups.has(key)) roundGroups.set(key, []);
    roundGroups.get(key)!.push(s);
  }
  const completedRounds = [...roundGroups.values()].filter(r => r.length >= 9);
  const totalRoundsPlayed = completedRounds.length;

  const distinctTournaments = new Set(playerRows.map(p => p.tournamentId)).size;

  // Distinct courses = unique courseIds across the tournaments this player registered in
  const playedTournamentIds = new Set(playerRows.map(p => p.tournamentId));
  const distinctCourses = new Set(
    tournamentCourses
      .filter(t => playedTournamentIds.has(t.id))
      .map(t => t.courseId)
      .filter((c): c is number => c !== null),
  ).size;

  const girRoundsCount = completedRounds.filter(rScores => {
    const ops = rScores.filter(s => s.girHit !== null);
    const hits = ops.filter(s => s.girHit).length;
    return ops.length >= 9 && hits / ops.length >= 0.5;
  }).length;

  const fwRoundsCount = completedRounds.filter(rScores => {
    const ops = rScores.filter(s => s.fairwayHit !== null);
    const hits = ops.filter(s => s.fairwayHit).length;
    return ops.length >= 5 && hits / ops.length >= 0.5;
  }).length;

  return {
    "10_rounds": { current: totalRoundsPlayed, target: 10 },
    "25_rounds": { current: totalRoundsPlayed, target: 25 },
    "50_rounds": { current: totalRoundsPlayed, target: 50 },
    "10_birdies_career": { current: careerBirdies, target: 10 },
    "25_birdies_career": { current: careerBirdies, target: 25 },
    "5_tournaments": { current: distinctTournaments, target: 5 },
    "10_tournaments": { current: distinctTournaments, target: 10 },
    "10_courses": { current: distinctCourses, target: 10 },
    "gir_50_pct": { current: girRoundsCount, target: 5 },
    "fairway_50_pct": { current: fwRoundsCount, target: 5 },
  };
}

export async function evaluateAchievementsForPlayer(
  userId: number,
  playerId: number,
  tournamentId: number,
): Promise<string[]> {
  const earned: string[] = [];

  const [player] = await db.select().from(playersTable).where(eq(playersTable.id, playerId));
  const [tournament] = await db.select().from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!player || !tournament) return [];

  const orgId = tournament.organizationId;

  // All player records for this user (for career stats)
  const allPlayerRows = await db.select({ id: playersTable.id, tournamentId: playersTable.tournamentId })
    .from(playersTable)
    .where(sql`${playersTable.userId} = ${userId} OR ${playersTable.email} = ${player.email ?? ""}`);
  const allPlayerIds = allPlayerRows.map(p => p.id);

  // All scores for this user
  const allScores = allPlayerIds.length > 0
    ? await db.select().from(scoresTable).where(inArray(scoresTable.playerId, allPlayerIds))
    : [];

  // Scores for this tournament/round  
  const thisRoundScores = allScores.filter(s => s.playerId === playerId);

  // Build a per-tournament hole-par map so career birdie/eagle detection uses the
  // correct course par for each score, regardless of which course it was played on.
  const allTournamentIds = [...new Set(allScores.map(s => s.tournamentId))];

  // Load course IDs for all relevant tournaments in one query
  const tournamentCourses = allTournamentIds.length > 0
    ? await db
        .select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId })
        .from(tournamentsTable)
        .where(inArray(tournamentsTable.id, allTournamentIds))
    : [];

  // Collect distinct course IDs
  const courseIds = [...new Set(tournamentCourses.map(t => t.courseId).filter((c): c is number => c !== null))];

  // Load all hole pars for all relevant courses in one query
  const allHoleDetails = courseIds.length > 0
    ? await db
        .select({ courseId: holeDetailsTable.courseId, holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
        .from(holeDetailsTable)
        .where(inArray(holeDetailsTable.courseId, courseIds))
    : [];

  // Build: courseId → Map<holeNumber, par>
  const courseHoleParMap = new Map<number, Map<number, number>>();
  for (const h of allHoleDetails) {
    if (!courseHoleParMap.has(h.courseId)) courseHoleParMap.set(h.courseId, new Map());
    courseHoleParMap.get(h.courseId)!.set(h.holeNumber, h.par);
  }

  // Build: tournamentId → courseId
  const tournamentCourseIdMap = new Map<number, number | null>(
    tournamentCourses.map(t => [t.id, t.courseId]),
  );

  function getHolePar(hn: number, tId: number): number {
    const cId = tournamentCourseIdMap.get(tId);
    if (cId == null) return 4;
    return courseHoleParMap.get(cId)?.get(hn) ?? 4;
  }
  function toPar(s: typeof allScores[0]): number { return s.strokes - getHolePar(s.holeNumber, s.tournamentId); }

  // Career-level computations
  const careerBirdies = allScores.filter(s => toPar(s) === -1).length;
  const careerEagles = allScores.filter(s => toPar(s) <= -2).length;
  const careerHoles = allScores.length;

  // Round-level: group by playerId+tournamentId+round (prevents round-number collision across tournaments)
  const roundGroups = new Map<string, typeof allScores>();
  for (const s of allScores) {
    const key = `${s.playerId}-${s.tournamentId}-${s.round}`;
    if (!roundGroups.has(key)) roundGroups.set(key, []);
    roundGroups.get(key)!.push(s);
  }
  const completedRounds = [...roundGroups.values()].filter(r => r.length >= 9);
  const totalRoundsPlayed = completedRounds.length;

  // Distinct tournaments played
  const distinctTournaments = new Set(allPlayerRows.map(p => p.tournamentId)).size;

  // --- Award badges ---

  // First tournament
  if (distinctTournaments >= 1) {
    if (await awardBadge(userId, "first_tournament", { organizationId: orgId, tournamentId })) earned.push("first_tournament");
  }

  // Leaderboard debut
  if (allScores.length > 0) {
    if (await awardBadge(userId, "leaderboard_debut", { organizationId: orgId, tournamentId })) earned.push("leaderboard_debut");
  }

  // First birdie
  if (careerBirdies >= 1) {
    if (await awardBadge(userId, "first_birdie", { organizationId: orgId, tournamentId })) earned.push("first_birdie");
  }

  // First eagle
  if (careerEagles >= 1) {
    if (await awardBadge(userId, "first_eagle", { organizationId: orgId, tournamentId })) earned.push("first_eagle");
  }

  // Hole in one
  const hasHoleInOne = allScores.some(s => s.strokes === 1 && getHolePar(s.holeNumber, s.tournamentId) >= 3);
  if (hasHoleInOne) {
    if (await awardBadge(userId, "first_hole_in_one", { organizationId: orgId, tournamentId })) earned.push("first_hole_in_one");
  }

  // Under par round
  for (const rScores of completedRounds) {
    const gross = rScores.reduce((a, s) => a + s.strokes, 0);
    const par = rScores.reduce((a, s) => a + getHolePar(s.holeNumber, s.tournamentId), 0);
    if (gross < par) {
      if (await awardBadge(userId, "under_par_round", { organizationId: orgId, tournamentId })) earned.push("under_par_round");
      break;
    }
  }

  // Even par round
  for (const rScores of completedRounds) {
    const gross = rScores.reduce((a, s) => a + s.strokes, 0);
    const par = rScores.reduce((a, s) => a + getHolePar(s.holeNumber, s.tournamentId), 0);
    if (gross <= par) {
      if (await awardBadge(userId, "first_par_round", { organizationId: orgId, tournamentId })) earned.push("first_par_round");
      break;
    }
  }

  // 3+ birdies in a round
  for (const rScores of completedRounds) {
    const birdies = rScores.filter(s => toPar(s) === -1).length;
    if (birdies >= 3) {
      if (await awardBadge(userId, "3_birdies_round", { organizationId: orgId, tournamentId })) earned.push("3_birdies_round");
      break;
    }
  }

  // Hat trick (3 consecutive birdies)
  for (const rScores of completedRounds) {
    const sorted = [...rScores].sort((a, b) => a.holeNumber - b.holeNumber);
    let consecutive = 0;
    for (const s of sorted) {
      if (toPar(s) === -1) { consecutive++; if (consecutive >= 3) break; } else { consecutive = 0; }
    }
    if (consecutive >= 3) {
      if (await awardBadge(userId, "hat_trick_birdies", { organizationId: orgId, tournamentId })) earned.push("hat_trick_birdies");
      break;
    }
  }

  // Eagle on par 5
  const eagleOnPar5 = allScores.some(s => toPar(s) <= -2 && getHolePar(s.holeNumber, s.tournamentId) === 5);
  if (eagleOnPar5) {
    if (await awardBadge(userId, "eagle_par5", { organizationId: orgId, tournamentId })) earned.push("eagle_par5");
  }

  // Bogey free round
  for (const rScores of completedRounds) {
    const hasBogey = rScores.some(s => toPar(s) >= 1);
    if (!hasBogey) {
      if (await awardBadge(userId, "bogey_free_round", { organizationId: orgId, tournamentId })) earned.push("bogey_free_round");
      break;
    }
  }

  // Back 9 birdie blitz
  for (const rScores of completedRounds) {
    const back9Birdies = rScores.filter(s => s.holeNumber >= 10 && toPar(s) === -1).length;
    if (back9Birdies >= 3) {
      if (await awardBadge(userId, "back_nine_birdie_blitz", { organizationId: orgId, tournamentId })) earned.push("back_nine_birdie_blitz");
      break;
    }
  }

  // 9-hole hero (under par on front or back nine)
  for (const rScores of completedRounds) {
    const front9 = rScores.filter(s => s.holeNumber <= 9);
    const back9 = rScores.filter(s => s.holeNumber >= 10);
    const front9GP = front9.reduce((a, s) => a + (s.strokes - getHolePar(s.holeNumber, s.tournamentId)), 0);
    const back9GP = back9.reduce((a, s) => a + (s.strokes - getHolePar(s.holeNumber, s.tournamentId)), 0);
    if (front9.length >= 9 && front9GP < 0 || back9.length >= 9 && back9GP < 0) {
      if (await awardBadge(userId, "9_hole_hero", { organizationId: orgId, tournamentId })) earned.push("9_hole_hero");
      break;
    }
  }

  // Low putts round
  for (const rScores of completedRounds) {
    const puttsScores = rScores.filter(s => s.putts !== null);
    if (puttsScores.length >= 9) {
      const avgPutts = puttsScores.reduce((a, s) => a + (s.putts ?? 0), 0) / puttsScores.length;
      if (avgPutts < 1.8) {
        if (await awardBadge(userId, "low_putts_round", { organizationId: orgId, tournamentId })) earned.push("low_putts_round");
        break;
      }
    }
  }

  // Round milestones
  if (totalRoundsPlayed >= 10) {
    if (await awardBadge(userId, "10_rounds", { organizationId: orgId })) earned.push("10_rounds");
  }
  if (totalRoundsPlayed >= 25) {
    if (await awardBadge(userId, "25_rounds", { organizationId: orgId })) earned.push("25_rounds");
  }
  if (totalRoundsPlayed >= 50) {
    if (await awardBadge(userId, "50_rounds", { organizationId: orgId })) earned.push("50_rounds");
  }

  // Career birdie milestones
  if (careerBirdies >= 10) {
    if (await awardBadge(userId, "10_birdies_career", { organizationId: orgId })) earned.push("10_birdies_career");
  }
  if (careerBirdies >= 25) {
    if (await awardBadge(userId, "25_birdies_career", { organizationId: orgId })) earned.push("25_birdies_career");
  }

  // Tournament milestones
  if (distinctTournaments >= 5) {
    if (await awardBadge(userId, "5_tournaments", { organizationId: orgId })) earned.push("5_tournaments");
  }
  if (distinctTournaments >= 10) {
    if (await awardBadge(userId, "10_tournaments", { organizationId: orgId })) earned.push("10_tournaments");
  }

  // GIR 50%+ for 5+ rounds
  const girRounds = completedRounds.filter(rScores => {
    const girOps = rScores.filter(s => s.girHit !== null);
    const girHit = girOps.filter(s => s.girHit).length;
    return girOps.length >= 9 && girHit / girOps.length >= 0.5;
  });
  if (girRounds.length >= 5) {
    if (await awardBadge(userId, "gir_50_pct", { organizationId: orgId })) earned.push("gir_50_pct");
  }

  // Fairway 50%+ for 5 rounds
  const fwRounds = completedRounds.filter(rScores => {
    const fwOps = rScores.filter(s => s.fairwayHit !== null);
    const fwHit = fwOps.filter(s => s.fairwayHit).length;
    return fwOps.length >= 5 && fwHit / fwOps.length >= 0.5;
  });
  if (fwRounds.length >= 5) {
    if (await awardBadge(userId, "fairway_50_pct", { organizationId: orgId })) earned.push("fairway_50_pct");
  }

  // ── Scratch round: any round where gross score ≤ course par (equivalent to scratch play) ──
  for (const rScores of completedRounds) {
    const gross = rScores.reduce((a, s) => a + s.strokes, 0);
    const par = rScores.reduce((a, s) => a + getHolePar(s.holeNumber, s.tournamentId), 0);
    if (par > 0 && gross <= par) {
      if (await awardBadge(userId, "scratch_round", { organizationId: orgId, tournamentId })) earned.push("scratch_round");
      break;
    }
  }

  // ── 10 distinct courses ───────────────────────────────────────────────────
  const tournamentIdsForPlayer = [...new Set(allPlayerRows.map(p => p.tournamentId))];
  if (tournamentIdsForPlayer.length >= 10) {
    // Fetch courseIds for all played tournaments
    const tRows = await db
      .select({ courseId: tournamentsTable.courseId })
      .from(tournamentsTable)
      .where(inArray(tournamentsTable.id, tournamentIdsForPlayer));
    const distinctCourses = new Set(tRows.map(t => t.courseId).filter(Boolean)).size;
    if (distinctCourses >= 10) {
      if (await awardBadge(userId, "10_courses", { organizationId: orgId })) earned.push("10_courses");
    }
  }

  // ── Tournament champion: this player has the lowest gross score in this tournament ──
  {
    // Get all player IDs in this tournament and their total gross scores
    const allTournamentPlayers = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(eq(playersTable.tournamentId, tournamentId));
    const allTournamentPlayerIds = allTournamentPlayers.map(p => p.id);

    if (allTournamentPlayerIds.length > 1) {
      const allTournamentScores = allTournamentPlayerIds.length > 0
        ? await db.select({ playerId: scoresTable.playerId, strokes: scoresTable.strokes })
            .from(scoresTable)
            .where(inArray(scoresTable.playerId, allTournamentPlayerIds))
        : [];

      const grossByPlayer = new Map<number, number>();
      for (const s of allTournamentScores) {
        grossByPlayer.set(s.playerId, (grossByPlayer.get(s.playerId) ?? 0) + s.strokes);
      }

      if (grossByPlayer.size > 1) {
        const myGross = grossByPlayer.get(playerId) ?? Infinity;
        const lowestGross = Math.min(...grossByPlayer.values());
        if (myGross === lowestGross) {
          if (await awardBadge(userId, "tournament_champion", { organizationId: orgId, tournamentId })) earned.push("tournament_champion");
        }
      }
    }
  }

  // ── Comeback king: was ≥5 over par through first 9 holes, finished under par ──
  for (const rScores of completedRounds) {
    const sorted = [...rScores].sort((a, b) => a.holeNumber - b.holeNumber);
    // Score through first 9
    const front9 = sorted.filter(s => s.holeNumber <= 9);
    const full18 = sorted.length >= 18;
    if (!full18 || front9.length < 9) continue;
    const front9ToPar = front9.reduce((a, s) => a + s.strokes - getHolePar(s.holeNumber, s.tournamentId), 0);
    const totalToPar = sorted.reduce((a, s) => a + s.strokes - getHolePar(s.holeNumber, s.tournamentId), 0);
    if (front9ToPar >= 5 && totalToPar < 0) {
      if (await awardBadge(userId, "comeback_king", { organizationId: orgId, tournamentId })) earned.push("comeback_king");
      break;
    }
  }

  // ── Perfect attendance: played in every round of this tournament ──
  if (tournament.rounds && tournament.rounds > 0) {
    const playerRoundsInTournament = [...new Set(
      thisRoundScores.map(s => s.round)
    )].length;
    // A round counts if the player has ≥9 hole scores for it
    const roundsWithFullData = [...roundGroups.values()].filter(rScores =>
      rScores[0]?.playerId === playerId && rScores[0]?.tournamentId === tournamentId && rScores.length >= 9,
    );
    if (roundsWithFullData.length >= tournament.rounds) {
      if (await awardBadge(userId, "perfect_attendance", { organizationId: orgId, tournamentId })) earned.push("perfect_attendance");
    }
  }

  // Send push notifications for newly earned badges
  if (earned.length > 0 && userId) {
    const newBadges = earned.map(t => BADGE_MAP.get(t)).filter(Boolean) as BadgeDef[];
    const first = newBadges[0]!;
    const extraCount = newBadges.length - 1;
    const title = `${first.icon} ${first.label}`;
    const body = extraCount > 0
      ? `Achievement unlocked! Plus ${extraCount} more badge${extraCount > 1 ? "s" : ""}!`
      : "Achievement unlocked! Check your profile to see your badges.";
    try {
      await sendTransactionalPush([userId], title, body, {
        type: "achievement_unlocked",
        badges: earned,
        tournamentId,
      });
    } catch { /* non-fatal */ }
    // Task #2008 — branded email + central dispatch (push/email/digest fan-out
    // honouring the user's notification preferences). Wrapped to never break
    // the surrounding evaluator if the mailer or registry has a transient
    // failure.
    await notifyAchievementUnlocked({
      userIds: [userId],
      achievementName: first.label,
      description: first.description,
    });
  }

  // Task #2008 — `near.miss`: when a cumulative numeric badge sits exactly
  // one event short of unlocking (`current === target - 1`) after this
  // round, send the player a one-off "so close" nudge for that badge.
  // Skip badges that *did* unlock in this same evaluator pass (avoid
  // double-notifying the same achievement). Dedup with `member_audit_log`
  // (entity=`achievement_near_miss`, action=`near_miss_notified`,
  // metadata.badgeType) so a given (user, badge) can only fire once until
  // the badge is actually earned (at which point a future reset of the
  // counter would re-arm it).
  if (userId) {
    try {
      const progress = await computeBadgeProgress(userId);
      const earnedSet = new Set(earned);
      for (const [badgeType, { current, target }] of Object.entries(progress)) {
        if (earnedSet.has(badgeType)) continue;
        if (current !== target - 1) continue;
        const badge = BADGE_MAP.get(badgeType);
        if (!badge) continue;
        const already = await db
          .select({ id: memberAuditLogTable.id })
          .from(memberAuditLogTable)
          .where(and(
            eq(memberAuditLogTable.entity, "achievement_near_miss"),
            eq(memberAuditLogTable.action, "near_miss_notified"),
            eq(memberAuditLogTable.entityId, userId),
            sql`${memberAuditLogTable.metadata}->>'badgeType' = ${badgeType}`,
          ))
          .limit(1);
        if (already.length > 0) continue;
        await notifyNearMiss({
          userIds: [userId],
          achievementName: badge.label,
          gap: "1",
        });
        await db.insert(memberAuditLogTable).values({
          entity: "achievement_near_miss",
          action: "near_miss_notified",
          entityId: userId,
          metadata: { badgeType, current, target },
        }).catch(() => { /* dedup row best-effort */ });
      }
    } catch { /* near-miss is best-effort */ }
  }

  return earned;
}

export async function evaluateLeagueAchievements(userId: number, leagueId: number): Promise<string[]> {
  const earned: string[] = [];
  const [league] = await db.select({ organizationId: leaguesTable.organizationId }).from(leaguesTable).where(eq(leaguesTable.id, leagueId));
  if (!league) return [];

  const [standing] = await db.select({ position: leagueStandingsTable.position, totalPoints: leagueStandingsTable.totalPoints })
    .from(leagueStandingsTable)
    .innerJoin(leagueMembersTable, eq(leagueStandingsTable.memberId, leagueMembersTable.id))
    .where(and(eq(leagueMembersTable.leagueId, leagueId), eq(leagueMembersTable.userId, userId)));

  if (standing?.position === 1) {
    if (await awardBadge(userId, "league_winner", { organizationId: league.organizationId, leagueId })) earned.push("league_winner");
  }
  return earned;
}
