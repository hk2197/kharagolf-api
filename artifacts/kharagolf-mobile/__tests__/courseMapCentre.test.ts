// Task #1940 — Unit coverage for the mobile course-centre helpers used
// by the general-play picker subline. Mirrors the web `formatMapCentre`
// behaviour and the public-course-page pair-based lat/lng -> mapDefault*
// fallback so the "Located near …" label never drifts between surfaces.

import { describe, it, expect } from "vitest";
import {
  formatMapCentre,
  getCourseCentre,
  formatCourseMapCentre,
} from "@/utils/courseMapCentre";

describe("formatMapCentre", () => {
  it("formats a northern + western pair with N / W and 2-dp precision", () => {
    expect(formatMapCentre("37.7800000", "-122.4200000")).toBe("37.78°N, 122.42°W");
  });

  it("formats a southern + eastern pair with S / E", () => {
    expect(formatMapCentre("-33.8688", "151.2093")).toBe("33.87°S, 151.21°E");
  });

  it("treats lat/lng of exactly 0 as N / E", () => {
    expect(formatMapCentre("0", "0")).toBe("0.00°N, 0.00°E");
  });

  it("accepts plain numbers as well as numeric strings", () => {
    expect(formatMapCentre(37.78, -122.42)).toBe("37.78°N, 122.42°W");
  });

  it("returns null when latitude is null", () => {
    expect(formatMapCentre(null, "-122.4200000")).toBeNull();
  });

  it("returns null when longitude is null", () => {
    expect(formatMapCentre("37.7800000", null)).toBeNull();
  });

  it("returns null when both coords are undefined", () => {
    expect(formatMapCentre(undefined, undefined)).toBeNull();
  });

  it("returns null when latitude is non-numeric", () => {
    expect(formatMapCentre("not-a-number", "-122.4200000")).toBeNull();
  });

  it("returns null on a blank-string longitude (avoids 0°N, 0°E from Number(''))", () => {
    expect(formatMapCentre("37.7800000", "")).toBeNull();
  });

  it("returns null on a whitespace-only latitude", () => {
    expect(formatMapCentre("   ", "-122.42")).toBeNull();
  });
});

describe("getCourseCentre — pair-based latitude/longitude -> mapDefault* fallback", () => {
  it("returns the explicit pair when both latitude and longitude are set", () => {
    expect(getCourseCentre({
      latitude: "40.0000000",
      longitude: "-75.0000000",
      mapDefaultLat: "10.0000000",
      mapDefaultLng: "-20.0000000",
    })).toEqual({ lat: 40, lng: -75 });
  });

  it("falls back to the mapper centre pair when both explicit coords are unset", () => {
    expect(getCourseCentre({
      latitude: null,
      longitude: null,
      mapDefaultLat: "37.7800000",
      mapDefaultLng: "-122.4200000",
    })).toEqual({ lat: 37.78, lng: -122.42 });
  });

  it("returns null when neither pair is set", () => {
    expect(getCourseCentre({})).toBeNull();
  });

  it("returns null when only latitude is set (half-pair, no fallback either)", () => {
    expect(getCourseCentre({ latitude: "40.0000000" })).toBeNull();
  });

  it("returns null when only mapDefaultLat is set (half-pair on the fallback side)", () => {
    expect(getCourseCentre({ mapDefaultLat: "37.7800000" })).toBeNull();
  });

  it("never mixes an explicit lat with a fallback lng (uses the fallback pair instead)", () => {
    // Explicit pair is incomplete (missing lng) so it is rejected wholesale;
    // we then fall back to the mapDefault pair, which is complete.
    expect(getCourseCentre({
      latitude: "40.0000000",
      longitude: null,
      mapDefaultLat: "10.0000000",
      mapDefaultLng: "-20.0000000",
    })).toEqual({ lat: 10, lng: -20 });
  });

  it("never mixes a fallback lat with an explicit lng either", () => {
    expect(getCourseCentre({
      latitude: null,
      longitude: "-75.0000000",
      mapDefaultLat: "10.0000000",
      mapDefaultLng: "-20.0000000",
    })).toEqual({ lat: 10, lng: -20 });
  });

  it("treats a blank-string explicit longitude as missing (rejects the explicit pair)", () => {
    expect(getCourseCentre({
      latitude: "40",
      longitude: "",
      mapDefaultLat: "10",
      mapDefaultLng: "-20",
    })).toEqual({ lat: 10, lng: -20 });
  });

  it("rejects the fallback pair when the mapDefault coords are blank/non-numeric", () => {
    expect(getCourseCentre({
      mapDefaultLat: "abc",
      mapDefaultLng: "",
    })).toBeNull();
  });
});

describe("formatCourseMapCentre", () => {
  it("formats the mapper centre when no explicit coords are set", () => {
    expect(formatCourseMapCentre({
      mapDefaultLat: "37.7800000",
      mapDefaultLng: "-122.4200000",
    })).toBe("37.78°N, 122.42°W");
  });

  it("prefers the explicit pair over the mapper centre", () => {
    expect(formatCourseMapCentre({
      latitude: "40.0000000",
      longitude: "-75.0000000",
      mapDefaultLat: "10.0000000",
      mapDefaultLng: "-20.0000000",
    })).toBe("40.00°N, 75.00°W");
  });

  it("returns null when no usable pair exists", () => {
    expect(formatCourseMapCentre({ latitude: null, longitude: null })).toBeNull();
  });

  it("returns null when only one explicit coord is present and there is no fallback pair", () => {
    expect(formatCourseMapCentre({ latitude: "40", longitude: null })).toBeNull();
  });

  it("returns null when explicit coords are blank strings and no fallback pair exists", () => {
    expect(formatCourseMapCentre({ latitude: "", longitude: "" })).toBeNull();
  });
});
