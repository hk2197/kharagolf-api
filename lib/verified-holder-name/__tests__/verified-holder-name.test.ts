/**
 * Unit test: verified-holder-name comparison helpers (Task #1120 / #1521).
 *
 * The web `WalletPanel` (SideGamesAdmin.tsx) and mobile `WalletScreen`
 * (app/wallet.tsx) used to each carry their own copy of these helpers and
 * were covered separately by their `VerifiedHolderLine` UI tests. Task
 * #1521 hoisted the helpers into this shared package, so this canonical
 * suite locks down the matching/normalisation rules independently of either
 * surface's rendering. The two `VerifiedHolderLine` UI tests still cover
 * the wiring (icon swap, amber colour class, hidden-when-null branch).
 */
import { describe, it, expect } from "vitest";
import {
  holderNameTokens,
  holderNamesDifferSignificantly,
} from "../src/index";

describe("holderNameTokens", () => {
  it("returns an empty array for null / undefined / empty input", () => {
    expect(holderNameTokens(null)).toEqual([]);
    expect(holderNameTokens(undefined)).toEqual([]);
    expect(holderNameTokens("")).toEqual([]);
  });

  it("lowercases, strips punctuation, and drops common honorifics + single-letter initials", () => {
    expect(holderNameTokens("Mr. JOHN A. SMITH")).toEqual(["john", "smith"]);
    expect(holderNameTokens("Dr Shri Ram K. Iyer")).toEqual(["ram", "iyer"]);
  });

  it("treats slashes / commas / extra whitespace as separators", () => {
    expect(holderNameTokens("M/s John , Smith")).toEqual(["john", "smith"]);
    expect(holderNameTokens("  jane\tdoe  ")).toEqual(["jane", "doe"]);
  });
});

describe("holderNamesDifferSignificantly", () => {
  it("returns false when either side is null / empty (nothing to compare)", () => {
    expect(holderNamesDifferSignificantly(null, "John Smith")).toBe(false);
    expect(holderNamesDifferSignificantly("John Smith", null)).toBe(false);
    expect(holderNamesDifferSignificantly("", "John Smith")).toBe(false);
    expect(holderNamesDifferSignificantly("John Smith", "")).toBe(false);
  });

  it("treats case / punctuation / honorific differences as a match", () => {
    expect(
      holderNamesDifferSignificantly("Mr. JOHN SMITH", "John Smith"),
    ).toBe(false);
  });

  it("treats one side being a subset of the other as a match (middle names, initials, reorderings)", () => {
    // Verified side has an extra middle name.
    expect(
      holderNamesDifferSignificantly("John Smith", "John David Smith"),
    ).toBe(false);
    // Tokens reordered.
    expect(
      holderNamesDifferSignificantly("Smith John", "John Smith"),
    ).toBe(false);
  });

  it("flags materially different names (no shared tokens) as a mismatch", () => {
    expect(
      holderNamesDifferSignificantly("Jon Smyth", "John Smith"),
    ).toBe(true);
  });

  it("uses a 50% Jaccard floor for partially overlapping names", () => {
    // 1 shared token out of 3 unique = 0.33 Jaccard -> mismatch.
    expect(
      holderNamesDifferSignificantly("John Smith", "John Doe"),
    ).toBe(true);
    // 2 shared tokens out of 3 unique = 0.66 Jaccard -> match.
    expect(
      holderNamesDifferSignificantly(
        "John David Smith",
        "John Michael Smith",
      ),
    ).toBe(false);
  });
});
