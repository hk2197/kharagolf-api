/**
 * Task #689 — payload builder for the round-end auto-detect review modal.
 *
 * Given the engine's proposed shots (`autoShotProposals`) and the player's
 * per-row review edits (`autoShotEdits`, mirrored 1:1 by index — selected
 * checkbox plus optional shotType / club override), build the
 * `acceptedShots` array that the score screen sends to
 * `POST /api/portal/shots/detect` with `commit: true`.
 *
 * Rules:
 *   - Rows the player unchecked are dropped — they must NOT be persisted.
 *   - Rows the player kept selected use the (possibly edited) shotType /
 *     club from the edit row, NOT the engine's original classification.
 *   - All other proposal fields (location, distance, recordedAt, source,
 *     confidence) are passed through unchanged so the server can persist
 *     them as-is.
 *
 * Extracted from `app/(tabs)/score.tsx`'s `commitAutoShots` so it can be
 * exercised by a unit test without dragging in the full screen component.
 */

export interface AutoShotProposal {
  holeNumber: number;
  shotNumber: number;
  shotType: string;
  club?: string | null;
  latitude: number;
  longitude: number;
  distanceToPinYards: number;
  recordedAt: string;
  source: string;
  confidence: number;
}

export interface AutoShotEdit {
  selected: boolean;
  shotType: string;
  club: string | null;
}

export interface AcceptedShot {
  holeNumber: number;
  shotNumber: number;
  shotType: string;
  club: string | null;
  latitude: number;
  longitude: number;
  distanceToPinYards: number;
  recordedAt: string;
  source: string;
  confidence: number;
}

export function buildAcceptedShotsPayload(
  proposals: readonly AutoShotProposal[],
  edits: readonly AutoShotEdit[],
): AcceptedShot[] {
  const out: AcceptedShot[] = [];
  for (let idx = 0; idx < proposals.length; idx++) {
    const p = proposals[idx];
    const e = edits[idx];
    if (!e || !e.selected) continue;
    out.push({
      holeNumber: p.holeNumber,
      shotNumber: p.shotNumber,
      shotType: e.shotType,
      club: e.club,
      latitude: p.latitude,
      longitude: p.longitude,
      distanceToPinYards: p.distanceToPinYards,
      recordedAt: p.recordedAt,
      source: p.source,
      confidence: p.confidence,
    });
  }
  return out;
}
