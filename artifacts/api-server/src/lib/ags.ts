/**
 * Adjusted Gross Score (AGS) calculation engine — WHS Rules of Handicapping §3.1
 *
 * §3.1 Established players (≥54 holes posted):
 *   Maximum hole score = Net Double Bogey = par + 2 + strokesReceived
 *
 * §3.1 Pre-establishment players (<54 holes posted):
 *   Maximum hole score = par + 5 (no strokes received considered)
 *
 * "Strokes received" is based on the hole's Stroke Index (SI) and the
 * player's Playing Handicap:
 *   - A player with PH = 18 gets 1 stroke on every hole (SI 1-18)
 *   - A player with PH = 19 gets 1 stroke on every hole + 1 extra on SI 1
 *   - A plus handicapper (PH < 0) gives up strokes starting from SI 1
 */

import { strokesOnHole } from "./handicap";

export interface HoleScore {
  holeNumber: number;
  par: number;
  strokeIndex: number | null;
  strokes: number | null;
}

/**
 * Calculate Adjusted Gross Score for a player's round.
 *
 * @param holeScores      Array of per-hole data (par, SI, actual strokes).
 * @param playingHandicap The player's Playing Handicap for the round.
 * @param isEstablished   Whether the player has ≥54 holes posted (affects cap rule).
 *                        - true  (default): Net Double Bogey cap (§3.1 established)
 *                        - false:           Par+5 cap (§3.1 pre-establishment)
 * @returns AGS — the sum of capped hole scores across all played holes.
 *          Unplayed holes are skipped (null strokes).
 */
export function calculateAGS(
  holeScores: HoleScore[],
  playingHandicap: number,
  isEstablished: boolean = true,
): number {
  let ags = 0;

  for (const hole of holeScores) {
    if (hole.strokes === null) continue;

    let maxScore: number;
    if (isEstablished) {
      // §3.1 established: Net Double Bogey
      const received = strokesOnHole(hole.strokeIndex, playingHandicap);
      maxScore = hole.par + 2 + received;
    } else {
      // §3.1 pre-establishment: Par + 5 (no strokes received)
      maxScore = hole.par + 5;
    }

    const cappedScore = Math.min(hole.strokes, maxScore);
    ags += cappedScore;
  }

  return ags;
}

/**
 * Calculate per-hole capped scores (returns an array matching holeScores).
 * Useful for displaying the cap indicator in the scorecard UI.
 */
export function calculateAGSPerHole(
  holeScores: HoleScore[],
  playingHandicap: number,
  isEstablished: boolean = true,
): Array<{ holeNumber: number; strokes: number | null; cappedStrokes: number | null; wasCapped: boolean }> {
  return holeScores.map(hole => {
    if (hole.strokes === null) {
      return { holeNumber: hole.holeNumber, strokes: null, cappedStrokes: null, wasCapped: false };
    }

    let maxScore: number;
    if (isEstablished) {
      const received = strokesOnHole(hole.strokeIndex, playingHandicap);
      maxScore = hole.par + 2 + received;
    } else {
      maxScore = hole.par + 5;
    }

    const cappedStrokes = Math.min(hole.strokes, maxScore);
    return {
      holeNumber: hole.holeNumber,
      strokes: hole.strokes,
      cappedStrokes,
      wasCapped: hole.strokes > maxScore,
    };
  });
}

/**
 * Calculate gross score (raw sum, no cap).
 */
export function calculateGrossScore(holeScores: HoleScore[]): number {
  return holeScores.reduce((acc, h) => acc + (h.strokes ?? 0), 0);
}

/**
 * Determine if a player is established (≥54 holes posted) from their state.
 * Convenience wrapper for use in posting routes.
 */
export function isPlayerEstablished(totalHolesPosted: number): boolean {
  return totalHolesPosted >= 54;
}
