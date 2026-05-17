/**
 * Wave 2 W2-D — WHS / USGA tie-break methods.
 *
 * Given a tied group of leaderboard entries (already determined to be
 * tied on total score), apply the configured tie-break method and
 * return them in the resolved order. All of the methods below appear
 * in the WHS Hard Card / USGA Decisions on the Rules of Golf.
 *
 * Methods:
 *   matching_scorecards_last_9 — sum of strokes on holes 10-18; lower wins
 *   matching_scorecards_last_6 — sum of strokes on holes 13-18
 *   matching_scorecards_last_3 — sum of strokes on holes 16-18
 *   matching_scorecards_last_1 — strokes on hole 18
 *   sudden_death               — extra holes, starting at hole 1 (or
 *                                designated playoff hole)
 *   back_nine                  — alias for matching_scorecards_last_9
 *   lowest_handicap            — break by lower handicap index
 */

export type TieBreakMethod =
  | "matching_scorecards_last_9"
  | "matching_scorecards_last_6"
  | "matching_scorecards_last_3"
  | "matching_scorecards_last_1"
  | "sudden_death"
  | "back_nine"
  | "lowest_handicap";

export interface TieBreakEntry {
  playerId: number;
  totalStrokes: number;
  /** strokes per hole, indexed 1..18 */
  holes: Record<number, number | null>;
  handicapIndex?: number | null;
}

export interface TieBreakResult {
  ordered: TieBreakEntry[];
  /** True when the chosen method left some entries still tied. */
  remainingTies: boolean;
  method: TieBreakMethod;
}

function sumHoles(entry: TieBreakEntry, from: number, to: number): number {
  let s = 0;
  for (let h = from; h <= to; h++) {
    const v = entry.holes[h];
    if (v == null) return Number.POSITIVE_INFINITY; // missing → can't break
    s += v;
  }
  return s;
}

/**
 * Returns true if ANY two adjacent (sorted) entries share the same
 * score — i.e. the method left a partial tie unresolved. Architect
 * flagged that the previous "all equal" check missed mixed cases like
 * 30,30,31 (first two still tied, but not all three equal).
 */
function hasAdjacentDuplicate<T>(sortedAsc: T[], score: (e: T) => number): boolean {
  for (let i = 1; i < sortedAsc.length; i++) {
    if (score(sortedAsc[i]) === score(sortedAsc[i - 1])) return true;
  }
  return false;
}

export function applyTieBreak(
  method: TieBreakMethod,
  tied: TieBreakEntry[],
): TieBreakResult {
  if (tied.length < 2) {
    return { ordered: tied.slice(), remainingTies: false, method };
  }

  const score: (e: TieBreakEntry) => number = (() => {
    switch (method) {
      case "matching_scorecards_last_9":
      case "back_nine":
        return (e) => sumHoles(e, 10, 18);
      case "matching_scorecards_last_6":
        return (e) => sumHoles(e, 13, 18);
      case "matching_scorecards_last_3":
        return (e) => sumHoles(e, 16, 18);
      case "matching_scorecards_last_1":
        return (e) => sumHoles(e, 18, 18);
      case "lowest_handicap":
        return (e) => e.handicapIndex ?? Number.POSITIVE_INFINITY;
      case "sudden_death":
        // Sudden-death cannot be evaluated from existing scorecards;
        // the caller must schedule a playoff. We surface this as
        // "remaining ties" so the caller knows to take the playoff path.
        return () => 0;
    }
  })();

  const ordered = tied.slice().sort((a, b) => score(a) - score(b));
  const remainingTies = method === "sudden_death" || hasAdjacentDuplicate(ordered, score);
  return { ordered, remainingTies, method };
}
