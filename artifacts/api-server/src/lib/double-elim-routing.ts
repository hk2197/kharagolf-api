/**
 * Pure routing helpers for the double-elimination bracket engine.
 *
 * Extracted from `routes/match-play.ts` so the per-level WB-loser → LB-minor
 * drop mapping can be exercised by unit tests without spinning up a database.
 *
 * In a double-elim bracket with R = log2(slotCount) WB rounds:
 *   - WB R1 losers feed LB R1 (consolidation, level 1).
 *   - For each WB-feed level L ∈ [1..R-1], the WB R(L+1) losers drop into
 *     LB R(2L) (the "minor" merge round of level L) at slot 2.
 *   - The drop order is REVERSED at each level so that the WB drop lands on
 *     the opposite side of the LB from the same-section consolidation winner,
 *     pushing any rematch with the original WB opponent as late as possible.
 *
 * Per-level mapping table:
 *
 *   Level L   WB feed round   # LB minor matches N    mapping (k → m)
 *   ────────────────────────────────────────────────────────────────
 *     1       WB R2           N = slotCount / 4       m = N - k + 1
 *     2       WB R3           N = slotCount / 8       m = N - k + 1
 *     ...
 *     R-1     WB final        N = 1                   m = 1
 */

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Number of LB minor matches at WB-feed level L (= number of WB R(L+1)
 * matches whose losers drop here).
 */
export function lbMinorMatchCount(level: number, slotCount: number): number {
  return slotCount / Math.pow(2, level + 1);
}

/**
 * For WB R(L+1) match `wbMatchNumber` (1-indexed) at WB-feed level L (≥1) in a
 * bracket with `slotCount` slots, return the LB minor match number (1-indexed)
 * the loser drops into. The loser always lands in slot 2.
 *
 * Mapping: m = (mCount - k + 1), where mCount = slotCount / 2^(L+1).
 */
export function wbLoserToLbMinorMatchNumber(
  level: number,
  wbMatchNumber: number,
  slotCount: number,
): number {
  const mCount = lbMinorMatchCount(level, slotCount);
  return mCount - wbMatchNumber + 1;
}

/**
 * Convenience: the LB round number (in the LB sub-round numbering used by the
 * engine) that the WB R(L+1) loser drops into. Pairs of LB rounds alternate
 * (cons, minor) per level, so level L's minor round is LB R(2L).
 */
export function wbLoserLbRoundNumber(level: number): number {
  return 2 * level;
}
