export type StandingsPlayer = {
  id: number;
  firstName: string;
  lastName: string;
};

export type StandingsMatch = {
  id: number;
  bracketType: string;
  player1Id?: number | null;
  player2Id?: number | null;
  player1IsBye: boolean;
  player2IsBye: boolean;
  result: string;
  winnerId?: number | null;
  holeResults?: Record<string, string> | null;
  player1?: StandingsPlayer | null;
  player2?: StandingsPlayer | null;
};

export type StandingsRow = {
  playerId: number;
  player: StandingsPlayer;
  played: number;
  wins: number;
  losses: number;
  halved: number;
  holesWon: number;
  points: number;
  rank: number;
  // True if this player remained tied with at least one other player after
  // applying every programmatic tie-break (points → head-to-head → holes won).
  // The displayed rank is still unique (resolved by lastName) but `tied` flags
  // those rows for UI treatment and for triggering the bracket's tie-break rule.
  tied: boolean;
};

const POINTS_WIN = 1;
const POINTS_HALVED = 0.5;

function isCompleted(m: StandingsMatch): boolean {
  return m.result !== "pending";
}

function isReal(m: StandingsMatch): boolean {
  return !m.player1IsBye && !m.player2IsBye && !!m.player1Id && !!m.player2Id;
}

function holesWonBy(m: StandingsMatch, playerSlot: "player1" | "player2"): number {
  const hr = m.holeResults ?? {};
  let n = 0;
  for (const v of Object.values(hr)) {
    if (v === playerSlot) n += 1;
  }
  return n;
}

/**
 * Compute round-robin standings.
 *
 * Tie-break order:
 *   1. Total points (Win = 1, Halved = 0.5, Loss = 0)
 *   2. Head-to-head (mini-league points among the players currently tied)
 *   3. Holes won (sum across all completed matches)
 */
export function computeRoundRobinStandings(matches: StandingsMatch[]): StandingsRow[] {
  const rrMatches = matches.filter(m => m.bracketType === "main" && isReal(m));

  const players = new Map<number, StandingsPlayer>();
  for (const m of rrMatches) {
    if (m.player1Id && m.player1) players.set(m.player1Id, m.player1);
    if (m.player2Id && m.player2) players.set(m.player2Id, m.player2);
  }

  const init = (): Omit<StandingsRow, "rank"> & { player: StandingsPlayer } => ({
    playerId: 0,
    player: { id: 0, firstName: "", lastName: "" },
    played: 0, wins: 0, losses: 0, halved: 0, holesWon: 0, points: 0,
    tied: false,
  });

  const rows = new Map<number, ReturnType<typeof init>>();
  for (const [id, p] of players) {
    rows.set(id, { ...init(), playerId: id, player: p });
  }

  for (const m of rrMatches) {
    if (!isCompleted(m)) continue;
    const p1 = m.player1Id!;
    const p2 = m.player2Id!;
    const r1 = rows.get(p1);
    const r2 = rows.get(p2);
    if (!r1 || !r2) continue;
    r1.played += 1;
    r2.played += 1;
    r1.holesWon += holesWonBy(m, "player1");
    r2.holesWon += holesWonBy(m, "player2");
    if (m.result === "halved") {
      r1.halved += 1;
      r2.halved += 1;
      r1.points += POINTS_HALVED;
      r2.points += POINTS_HALVED;
    } else if (m.winnerId === p1) {
      r1.wins += 1; r2.losses += 1;
      r1.points += POINTS_WIN;
    } else if (m.winnerId === p2) {
      r2.wins += 1; r1.losses += 1;
      r2.points += POINTS_WIN;
    }
  }

  // Head-to-head mini-league points within an arbitrary subset.
  function h2hPoints(subset: number[]): Map<number, number> {
    const set = new Set(subset);
    const pts = new Map<number, number>(subset.map(id => [id, 0]));
    for (const m of rrMatches) {
      if (!isCompleted(m)) continue;
      const p1 = m.player1Id!;
      const p2 = m.player2Id!;
      if (!set.has(p1) || !set.has(p2)) continue;
      if (m.result === "halved") {
        pts.set(p1, (pts.get(p1) ?? 0) + POINTS_HALVED);
        pts.set(p2, (pts.get(p2) ?? 0) + POINTS_HALVED);
      } else if (m.winnerId === p1) {
        pts.set(p1, (pts.get(p1) ?? 0) + POINTS_WIN);
      } else if (m.winnerId === p2) {
        pts.set(p2, (pts.get(p2) ?? 0) + POINTS_WIN);
      }
    }
    return pts;
  }

  const all = Array.from(rows.values());

  all.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return 0;
  });

  // Resolve ties using head-to-head, then holes won. After ordering, mark
  // each row as `tied` if any neighbour shares the same points + h2h + holes won.
  const sorted: Array<typeof all[number] & { tied: boolean }> = [];
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].points === all[i].points) j += 1;
    const tied = all.slice(i, j + 1);
    if (tied.length === 1) {
      sorted.push({ ...tied[0], tied: false });
    } else {
      const h2h = h2hPoints(tied.map(t => t.playerId));
      tied.sort((a, b) => {
        const ah = h2h.get(a.playerId) ?? 0;
        const bh = h2h.get(b.playerId) ?? 0;
        if (bh !== ah) return bh - ah;
        if (b.holesWon !== a.holesWon) return b.holesWon - a.holesWon;
        return a.player.lastName.localeCompare(b.player.lastName);
      });
      // Two rows are "truly tied" when points, h2h points and holes won all match.
      const decorated = tied.map(t => ({
        row: t,
        h2h: h2h.get(t.playerId) ?? 0,
      }));
      for (let k = 0; k < decorated.length; k++) {
        const cur = decorated[k];
        const sameAsPrev = k > 0
          && decorated[k - 1].row.points === cur.row.points
          && decorated[k - 1].h2h === cur.h2h
          && decorated[k - 1].row.holesWon === cur.row.holesWon;
        const sameAsNext = k + 1 < decorated.length
          && decorated[k + 1].row.points === cur.row.points
          && decorated[k + 1].h2h === cur.h2h
          && decorated[k + 1].row.holesWon === cur.row.holesWon;
        sorted.push({ ...cur.row, tied: sameAsPrev || sameAsNext });
      }
    }
    i = j + 1;
  }

  return sorted.map((r, idx) => ({ ...r, rank: idx + 1 }));
}

export const TIE_BREAK_DESCRIPTION =
  "Ties broken by: 1) points, 2) head-to-head, 3) holes won.";
