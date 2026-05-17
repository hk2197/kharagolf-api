/**
 * Task #689 — round-end auto-detect review modal payload contract.
 *
 * The review modal in `app/(tabs)/score.tsx` (added in #526) lets the player
 * tick/untick proposed shots and edit each row's shotType / club before
 * committing them. The mapping from (proposals + per-row edits) to the
 * `acceptedShots` payload sent on `POST /api/portal/shots/detect` is
 * centralised in `buildAcceptedShotsPayload` (utils/autoShotPayload).
 *
 * These tests simulate a player walking through the modal and pin the
 * contract:
 *   1. Unchecked rows are dropped — they must NOT be persisted.
 *   2. Checked rows that the player edited carry the EDITED shotType/club,
 *      not the engine's original classification.
 *   3. Untouched rows pass through with their original shotType/club.
 *   4. Non-classification fields (lat/lng/distance/recordedAt/source/
 *      confidence) are preserved unchanged so the server can persist them.
 *   5. An entirely-deselected review yields an empty payload (the score
 *      screen treats this as a "skip" — no commit fires).
 */
import { describe, it, expect } from "vitest";
import {
  buildAcceptedShotsPayload,
  type AutoShotEdit,
  type AutoShotProposal,
} from "../utils/autoShotPayload";

const PROPOSALS: AutoShotProposal[] = [
  {
    holeNumber: 1, shotNumber: 1,
    shotType: "tee", club: "driver",
    latitude: 0, longitude: 0.0001, distanceToPinYards: 320.0,
    recordedAt: "2026-04-19T10:00:00.000Z",
    source: "wearable", confidence: 0.95,
  },
  {
    // Engine's distance heuristic guessed "chip", but the player knows it
    // was actually a putt — they will edit it in the modal.
    holeNumber: 1, shotNumber: 2,
    shotType: "chip", club: "PW",
    latitude: 0, longitude: 0.0009, distanceToPinYards: 8.0,
    recordedAt: "2026-04-19T10:01:00.000Z",
    source: "gps", confidence: 0.55,
  },
  {
    // A misfired GPS-only proposal the player will UNCHECK — must not
    // appear in the committed payload.
    holeNumber: 2, shotNumber: 1,
    shotType: "fairway", club: "7i",
    latitude: 0, longitude: 0.0019, distanceToPinYards: 145.0,
    recordedAt: "2026-04-19T10:10:00.000Z",
    source: "gps", confidence: 0.55,
  },
];

describe("buildAcceptedShotsPayload — review-modal selection contract (Task #689)", () => {
  it("drops unchecked rows and applies inline shotType/club edits to the kept rows", () => {
    const edits: AutoShotEdit[] = [
      // Row 0: kept as-is, no edits.
      { selected: true,  shotType: "tee",  club: "driver" },
      // Row 1: kept and edited — chip → putt with putter (the engine's
      // distance heuristic was wrong, this was actually a putt).
      { selected: true,  shotType: "putt", club: "putter" },
      // Row 2: unchecked — this misfired proposal must be dropped.
      { selected: false, shotType: "fairway", club: "7i" },
    ];

    const accepted = buildAcceptedShotsPayload(PROPOSALS, edits);

    // Only the two selected rows survive.
    expect(accepted).toHaveLength(2);

    // Row 0 — passed through verbatim (player did not edit shotType/club).
    expect(accepted[0]).toEqual({
      holeNumber: 1, shotNumber: 1,
      shotType: "tee", club: "driver",
      latitude: 0, longitude: 0.0001, distanceToPinYards: 320.0,
      recordedAt: "2026-04-19T10:00:00.000Z",
      source: "wearable", confidence: 0.95,
    });

    // Row 1 — shotType + club come from the EDIT row, every other field
    // from the original proposal.
    expect(accepted[1]).toEqual({
      holeNumber: 1, shotNumber: 2,
      shotType: "putt", club: "putter",
      latitude: 0, longitude: 0.0009, distanceToPinYards: 8.0,
      recordedAt: "2026-04-19T10:01:00.000Z",
      source: "gps", confidence: 0.55,
    });

    // The unchecked row must NOT appear under any hole / shot number.
    expect(accepted.find(a => a.holeNumber === 2)).toBeUndefined();
  });

  it("supports clearing the club to null on a selected row", () => {
    // Player keeps the proposal but says "I don't remember which club" —
    // the modal stores club: null which must round-trip to the payload.
    const accepted = buildAcceptedShotsPayload(
      [PROPOSALS[0]],
      [{ selected: true, shotType: "tee", club: null }],
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].club).toBeNull();
    expect(accepted[0].shotType).toBe("tee");
  });

  it("returns an empty array when the player unchecks every proposal", () => {
    // Score screen treats this as a 'skip' and never POSTs — verifying the
    // helper produces [] keeps that branch intact.
    const accepted = buildAcceptedShotsPayload(
      PROPOSALS,
      PROPOSALS.map(() => ({ selected: false, shotType: "tee", club: null })),
    );
    expect(accepted).toEqual([]);
  });

  it("treats a missing edit row as 'not selected' (defensive — UI hydrates edits 1:1 but lengths can drift mid-render)", () => {
    // Only one edit row provided for three proposals — the helper must not
    // crash and must only emit the proposal that has a corresponding edit.
    const accepted = buildAcceptedShotsPayload(
      PROPOSALS,
      [{ selected: true, shotType: "tee", club: "driver" }],
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].holeNumber).toBe(1);
    expect(accepted[0].shotNumber).toBe(1);
  });
});
