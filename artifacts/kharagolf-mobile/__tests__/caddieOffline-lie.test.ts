/**
 * Regression test (Task #943): the offline AI Caddie's on-device recommender
 * must apply per-(lie, club) acceptance bias on top of the per-club bias, and
 * the lie-specific bucket must dominate when the player is hitting from that
 * lie. This pins the behaviour the snapshot endpoint is designed to feed.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
  },
}));

vi.mock("@/utils/api", () => ({
  fetchPortal: vi.fn(),
  postPortal: vi.fn(),
}));

import {
  computeLocalRecommendation,
  type CaddieSnapshot,
} from "../utils/caddieOffline";

// Two clubs with identical carries so the only thing distinguishing them is
// the personalisation bias. That isolates the (lie, club) → acceptance signal
// the test is here to pin.
const baseSnapshot: CaddieSnapshot = {
  generatedAt: new Date().toISOString(),
  handicap: 12,
  missBiasLateralYards: 0,
  clubStats: [
    { club: "7 Iron", avgCarry: 150, stddevCarry: 8, shotCount: 20, source: "shots" },
    { club: "6 Iron", avgCarry: 150, stddevCarry: 8, shotCount: 20, source: "shots" },
  ],
  // Per-club bias *favours* 7 Iron strongly.
  acceptanceByClub: { "7 Iron": 1.0, "6 Iron": 0.0 },
  // Per-lie bias from the bunker *contradicts* per-club and favours 6 Iron.
  acceptanceByLie: {
    bunker: { "7 Iron": 0.0, "6 Iron": 1.0 },
  },
};

const baseArgs = {
  distanceYards: 150,
  windSpeedMph: 0,
  windDirectionDeg: 0,
  windBearingDeg: 0,
  pinLat: null,
  bearingToPinDeg: null,
  elevationDeltaYards: 0,
} as const;

describe("computeLocalRecommendation — per-lie acceptance bias", () => {
  it("recommends the per-club favourite when the lie has no per-lie bucket", () => {
    // Fairway → no acceptanceByLie.fairway entry → falls back to per-club.
    const r = computeLocalRecommendation({
      ...baseArgs,
      snapshot: baseSnapshot,
      lieType: "fairway",
    });
    expect(r).not.toBeNull();
    expect(r!.recommended?.club).toBe("7 Iron");
  });

  it("recommends the per-lie favourite when the shot is from the matching lie", () => {
    // Same snapshot, but the lie now matches the bunker bucket. Per-lie bias
    // is weighted 0.6 vs 0.4 for per-club, so the lie bucket must flip the
    // recommendation to 6 Iron.
    const r = computeLocalRecommendation({
      ...baseArgs,
      snapshot: baseSnapshot,
      lieType: "bunker",
    });
    expect(r).not.toBeNull();
    expect(r!.recommended?.club).toBe("6 Iron");
  });

  it("treats raw 'sand' the same as 'bunker' when looking up the per-lie bucket", () => {
    // The mobile recommender normalises "sand" → "bunker" via the same lie
    // adjustment table the backend snapshot uses, so the bias must still flip.
    const r = computeLocalRecommendation({
      ...baseArgs,
      snapshot: baseSnapshot,
      lieType: "sand",
    });
    expect(r).not.toBeNull();
    expect(r!.recommended?.club).toBe("6 Iron");
  });

  it("falls back to per-club bias for snapshots that predate per-lie data", () => {
    // Older snapshots may omit acceptanceByLie entirely; the recommender must
    // still work and must not crash trying to look up a missing bucket.
    const legacy: CaddieSnapshot = {
      ...baseSnapshot,
      acceptanceByLie: undefined,
    };
    const r = computeLocalRecommendation({
      ...baseArgs,
      snapshot: legacy,
      lieType: "bunker",
    });
    expect(r).not.toBeNull();
    expect(r!.recommended?.club).toBe("7 Iron");
  });
});
