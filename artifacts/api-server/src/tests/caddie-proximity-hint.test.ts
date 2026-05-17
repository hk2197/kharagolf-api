import { describe, it, expect } from "vitest";
import { recommend } from "../lib/caddie";

const stats = [
  { club: "7 Iron", avgCarry: 150, stddevCarry: 8, shotCount: 10, source: "shots" as const },
  { club: "8 Iron", avgCarry: 140, stddevCarry: 8, shotCount: 10, source: "shots" as const },
];

describe("recommend — proximity coaching hint integration (Task #1348)", () => {
  it("appends the caddieHint to the rationale when the recommended club has a gap >= 3 ft", () => {
    const r = recommend({
      distanceYards: 150,
      clubStats: stats,
      proximityGapsByClub: {
        "7 Iron": {
          gapVsTourFt: 8,
          aimLongFt: 5,
          caddieHint: "you're 8 ft worse with the 7 Iron — aim 5 ft long of pin",
        },
      },
    });
    expect(r.recommended?.club).toBe("7 Iron");
    expect(r.rationale).toContain("you're 8 ft worse with the 7 Iron — aim 5 ft long of pin");
  });

  it("does NOT append the hint when the gap is below the 3 ft threshold", () => {
    const hint = "you're 2 ft worse with the 7 Iron — aim 1 ft long of pin";
    const r = recommend({
      distanceYards: 150,
      clubStats: stats,
      proximityGapsByClub: {
        "7 Iron": {
          gapVsTourFt: 2,
          aimLongFt: 1,
          caddieHint: hint,
        },
      },
    });
    expect(r.recommended?.club).toBe("7 Iron");
    expect(r.rationale).not.toContain(hint);
  });

  it("does NOT append the hint when the gap is keyed under a different club label", () => {
    const hint = "you're 8 ft worse with the 9 Iron — aim 5 ft long of pin";
    const r = recommend({
      distanceYards: 150,
      clubStats: stats,
      proximityGapsByClub: {
        "9 Iron": {
          gapVsTourFt: 8,
          aimLongFt: 5,
          caddieHint: hint,
        },
      },
    });
    expect(r.recommended?.club).toBe("7 Iron");
    expect(r.rationale).not.toContain(hint);
  });

  it("appends the hint exactly at the 3 ft boundary", () => {
    const hint = "you're 3 ft worse with the 7 Iron — aim 2 ft long of pin";
    const r = recommend({
      distanceYards: 150,
      clubStats: stats,
      proximityGapsByClub: {
        "7 Iron": {
          gapVsTourFt: 3,
          aimLongFt: 2,
          caddieHint: hint,
        },
      },
    });
    expect(r.recommended?.club).toBe("7 Iron");
    expect(r.rationale).toContain(hint);
  });
});
