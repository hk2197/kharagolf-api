// Server-side round-robin standings — mirrors the algorithm used in the web /
// mobile clients (see artifacts/kharagolf-web/src/lib/round-robin-standings.ts).
// Kept deliberately small so the bracket completion / champion-detection logic
// in match-play.ts can run without hitting the API client.

export type RrStandingsMatch = {
  bracketType: string;
  player1Id?: number | null;
  player2Id?: number | null;
  player1IsBye: boolean;
  player2IsBye: boolean;
  result: string;
  winnerId?: number | null;
  holeResults?: Record<string | number, string> | null;
};

export type RrStandingsRow = {
  playerId: number;
  played: number;
  wins: number;
  losses: number;
  halved: number;
  holesWon: number;
  points: number;
  rank: number;
  // Tied with at least one neighbour after applying every programmatic
  // tie-break (points → head-to-head → holes won). The displayed rank is still
  // unique, but `tied` flags rows that need a manual playoff to separate.
  tied: boolean;
};

const POINTS_WIN = 1;
const POINTS_HALVED = 0.5;

function isReal(m: RrStandingsMatch): boolean {
  return !m.player1IsBye && !m.player2IsBye && !!m.player1Id && !!m.player2Id;
}

function isCompleted(m: RrStandingsMatch): boolean {
  return m.result !== "pending";
}

function holesWonBy(m: RrStandingsMatch, slot: "player1" | "player2"): number {
  const hr = m.holeResults ?? {};
  let n = 0;
  for (const v of Object.values(hr)) if (v === slot) n += 1;
  return n;
}

export function computeRrStandings(matches: RrStandingsMatch[]): RrStandingsRow[] {
  const rrMatches = matches.filter(m => m.bracketType === "main" && isReal(m));
  const playerIds = new Set<number>();
  for (const m of rrMatches) {
    if (m.player1Id) playerIds.add(m.player1Id);
    if (m.player2Id) playerIds.add(m.player2Id);
  }

  const rows = new Map<number, Omit<RrStandingsRow, "rank" | "tied">>();
  for (const id of playerIds) {
    rows.set(id, { playerId: id, played: 0, wins: 0, losses: 0, halved: 0, holesWon: 0, points: 0 });
  }

  for (const m of rrMatches) {
    if (!isCompleted(m)) continue;
    const p1 = m.player1Id!;
    const p2 = m.player2Id!;
    const r1 = rows.get(p1);
    const r2 = rows.get(p2);
    if (!r1 || !r2) continue;
    r1.played += 1; r2.played += 1;
    r1.holesWon += holesWonBy(m, "player1");
    r2.holesWon += holesWonBy(m, "player2");
    if (m.result === "halved") {
      r1.halved += 1; r2.halved += 1;
      r1.points += POINTS_HALVED; r2.points += POINTS_HALVED;
    } else if (m.winnerId === p1) {
      r1.wins += 1; r2.losses += 1;
      r1.points += POINTS_WIN;
    } else if (m.winnerId === p2) {
      r2.wins += 1; r1.losses += 1;
      r2.points += POINTS_WIN;
    }
  }

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

  const all = Array.from(rows.values()).sort((a, b) => b.points - a.points);

  const sorted: RrStandingsRow[] = [];
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].points === all[i].points) j += 1;
    const tiedGroup = all.slice(i, j + 1);
    if (tiedGroup.length === 1) {
      sorted.push({ ...tiedGroup[0], rank: 0, tied: false });
    } else {
      const h2h = h2hPoints(tiedGroup.map(t => t.playerId));
      tiedGroup.sort((a, b) => {
        const ah = h2h.get(a.playerId) ?? 0;
        const bh = h2h.get(b.playerId) ?? 0;
        if (bh !== ah) return bh - ah;
        if (b.holesWon !== a.holesWon) return b.holesWon - a.holesWon;
        return a.playerId - b.playerId;
      });
      const decorated = tiedGroup.map(t => ({ row: t, h2h: h2h.get(t.playerId) ?? 0 }));
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
        sorted.push({ ...cur.row, rank: 0, tied: sameAsPrev || sameAsNext });
      }
    }
    i = j + 1;
  }

  return sorted.map((r, idx) => ({ ...r, rank: idx + 1 }));
}

export const ROUND_ROBIN_TIE_BREAK_ROUND_NAME = "Tie-Break";
