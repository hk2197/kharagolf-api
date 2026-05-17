/**
 * Shared league team standings aggregation and ranking.
 * Used by both private (routes/leagues.ts) and public (routes/public.ts) endpoints
 * to ensure consistent standings computation and prevent logic drift.
 */

export type RoundTeamResult = {
  won: number; drawn: number; lost: number;
  grossScore: number | null; netScore: number | null; stablefordPoints: number | null;
};

export type TeamAgg = {
  teamId: number; teamName: string; teamColour: string | null;
  roundsPlayed: number; won: number; drawn: number; lost: number;
  totalPoints: number; totalGross: number | null; totalNet: number | null; totalStableford: number | null;
};

export type TeamStanding = TeamAgg & { position: number };

export type LeagueConfig = {
  format?: string | null;
  pointsPerWin?: number | null;
  pointsPerDraw?: number | null;
  pointsPerLoss?: number | null;
};

/**
 * Aggregate per-round results and rank teams.
 * @param teams - list of teams with id, name, colour
 * @param teamRoundMap - outer key = teamId, inner key = roundId, value = per-round result
 * @param leagueConfig - league scoring config (format, point values)
 * @returns ranked array with position, sorted by the format's primary metric
 */
export function aggregateAndRankTeams(
  teams: { id: number; name: string; colour?: string | null }[],
  teamRoundMap: Map<number, Map<number, RoundTeamResult>>,
  leagueConfig: LeagueConfig,
): TeamStanding[] {
  const fmt = leagueConfig.format ?? "stroke_play";
  const isStableford = ["stableford", "better_ball", "alliance", "waltz"].includes(fmt);
  const isMatchPlay = fmt === "match_play";
  const isNet = ["net_stroke", "scramble", "shamble"].includes(fmt);

  const ppw = leagueConfig.pointsPerWin ?? 2;
  const ppd = leagueConfig.pointsPerDraw ?? 1;
  const ppLoss = leagueConfig.pointsPerLoss ?? 0;

  const teamAgg = new Map<number, TeamAgg>();
  for (const t of teams) {
    teamAgg.set(t.id, {
      teamId: t.id, teamName: t.name, teamColour: t.colour ?? null,
      roundsPlayed: 0, won: 0, drawn: 0, lost: 0,
      totalPoints: 0, totalGross: null, totalNet: null, totalStableford: null,
    });
  }

  for (const [tid, roundMap] of teamRoundMap.entries()) {
    const agg = teamAgg.get(tid);
    if (!agg) continue;
    for (const [, rr] of roundMap.entries()) {
      agg.roundsPlayed++;
      agg.won += rr.won; agg.drawn += rr.drawn; agg.lost += rr.lost;
      if (isMatchPlay) {
        agg.totalPoints += rr.won * ppw + rr.drawn * ppd + rr.lost * ppLoss;
      }
      if (rr.grossScore != null) agg.totalGross = (agg.totalGross ?? 0) + rr.grossScore;
      if (rr.netScore != null) agg.totalNet = (agg.totalNet ?? 0) + rr.netScore;
      if (rr.stablefordPoints != null) agg.totalStableford = (agg.totalStableford ?? 0) + rr.stablefordPoints;
    }
  }

  for (const agg of teamAgg.values()) {
    if (isStableford) agg.totalPoints = agg.totalStableford ?? 0;
  }

  return [...teamAgg.values()]
    .sort((a, b) => {
      if (isMatchPlay) {
        if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
        return (b.won ?? 0) - (a.won ?? 0);
      }
      if (isStableford) {
        const bS = b.totalStableford ?? 0, aS = a.totalStableford ?? 0;
        if (bS !== aS) return bS - aS;
        return (a.totalGross ?? 0) - (b.totalGross ?? 0);
      }
      if (isNet) {
        return (a.totalNet ?? a.totalGross ?? 0) - (b.totalNet ?? b.totalGross ?? 0);
      }
      return (a.totalGross ?? 0) - (b.totalGross ?? 0);
    })
    .map((t, i) => ({ ...t, position: i + 1 }));
}
