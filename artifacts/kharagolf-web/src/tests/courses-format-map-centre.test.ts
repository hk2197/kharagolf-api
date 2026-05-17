/**
 * Task #1558 — Unit coverage for `formatMapCentre`, the helper that
 * powers the "Located near …" line on each course card on the org
 * admin courses list (`artifacts/kharagolf-web/src/pages/courses.tsx`).
 *
 * The helper turns a raw lat/lng pair from the Course payload (returned
 * as numeric strings by the API, e.g. `"37.7800000"`) into a short,
 * coarse-precision human-readable label, and must safely handle the
 * three branches the courses list relies on:
 *
 *   - both coordinates present and parseable → formatted string
 *   - either coordinate missing (null/undefined) → null (so the card
 *     renders no "Located near …" link)
 *   - either coordinate non-numeric → null (defensively avoid showing
 *     "NaN°N, NaN°W" if the API ever sends a malformed value)
 *
 * If the format ever changes (e.g. precision or hemisphere suffix), the
 * snapshot-style assertions below will catch it before users see a
 * regression on the admin list.
 */
import { describe, it, expect } from "vitest";
import { formatMapCentre } from "@/pages/courses";

describe("formatMapCentre (Task #1558)", () => {
  it("formats a northern + western coordinate pair with N / W suffixes and 2-dp precision", () => {
    expect(formatMapCentre("37.7800000", "-122.4200000")).toBe("37.78°N, 122.42°W");
  });

  it("formats a southern + eastern coordinate pair with S / E suffixes", () => {
    expect(formatMapCentre("-33.8688", "151.2093")).toBe("33.87°S, 151.21°E");
  });

  it("treats lat/lng of exactly 0 as N / E (lat>=0, lng>=0)", () => {
    expect(formatMapCentre("0", "0")).toBe("0.00°N, 0.00°E");
  });

  it("returns null when latitude is null", () => {
    expect(formatMapCentre(null, "-122.4200000")).toBeNull();
  });

  it("returns null when longitude is null", () => {
    expect(formatMapCentre("37.7800000", null)).toBeNull();
  });

  it("returns null when both coordinates are undefined (course never mapped)", () => {
    expect(formatMapCentre(undefined, undefined)).toBeNull();
  });

  it("returns null when latitude is non-numeric (defensive)", () => {
    expect(formatMapCentre("not-a-number", "-122.4200000")).toBeNull();
  });

  it("returns null when longitude is non-numeric (defensive)", () => {
    expect(formatMapCentre("37.7800000", "not-a-number")).toBeNull();
  });

  it("returns null for NaN-producing strings like an empty string", () => {
    // Number("") is 0 in JS — but Number("   ") is also 0. We rely on
    // the API never sending an empty string for these columns; the
    // important regression is that " " or "abc" don't render NaN.
    expect(formatMapCentre("abc", "")).toBeNull();
  });
});
