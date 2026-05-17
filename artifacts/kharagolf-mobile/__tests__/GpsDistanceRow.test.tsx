/**
 * UI tests for the F / C / B GPS plays-like breakdown popups (Task #875).
 *
 * Covers the "plays N ⓘ" tappable shown beneath each Front / Centre / Back
 * GPS distance number in the scorecard:
 *   1. Each press fires Alert.alert with the matching breakdown for that
 *      target (Front / Pin-or-Centre / Back).
 *   2. The Centre cell label and Alert title switch between
 *      "CENTRE" / "Centre" and "PIN" / "Pin" based on `hasPinOffset`.
 *   3. The "neutral conditions" branch and the multi-factor branch (wind +
 *      elevation + temperature + altitude) of the message body both render
 *      correctly.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Alert } from "react-native";

import GpsDistanceRow, {
  buildGpsPLBreakdown,
} from "../components/GpsDistanceRow";
import type { PlaysLikeBreakdown } from "../components/HoleMapSheet";

// Front / Centre / Back distances in metres. With `metersToYards` (×1.09361
// then rounded) these become 110 / 137 / 155 yds — different enough from the
// `playsLikeYards` we set below that the "plays N ⓘ" pressable always renders.
const DIST_FRONT_M = 100;
const DIST_CENTRE_M = 125;
const DIST_BACK_M = 142;

const PL_FRONT: PlaysLikeBreakdown = {
  rawYards: 110,
  playsLikeYards: 117,
  windAdj: 5,
  elevAdj: 2,
  tempAdj: 0,
  altitudeAdj: 0,
};
const PL_CENTRE: PlaysLikeBreakdown = {
  rawYards: 137,
  playsLikeYards: 148,
  windAdj: 6,
  elevAdj: 3,
  tempAdj: 1,
  altitudeAdj: 1,
};
const PL_BACK: PlaysLikeBreakdown = {
  rawYards: 155,
  playsLikeYards: 149,
  windAdj: -4,
  elevAdj: -2,
  tempAdj: 0,
  altitudeAdj: 0,
};

let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterEach(() => {
  alertSpy.mockRestore();
  vi.clearAllMocks();
});

describe("buildGpsPLBreakdown helper", () => {
  it("renders the multi-factor branch with each non-zero contribution", () => {
    const { title, message } = buildGpsPLBreakdown("Pin", PL_CENTRE);
    expect(title).toBe("Pin · Plays-like breakdown");
    // Headline raw + plays-like.
    expect(message).toContain("Raw: 137 yds");
    expect(message).toContain("Plays like: 148 yds");
    // Each factor on its own line, with a leading sign.
    expect(message).toContain("Wind: +6 yds");
    expect(message).toContain("Elevation: +3 yds");
    expect(message).toContain("Temperature: +1 yds");
    expect(message).toContain("Altitude: +1 yds");
    // No "neutral" line when at least one factor is non-zero.
    expect(message).not.toContain("Conditions are neutral.");
  });

  it("formats negative adjustments with a leading minus and skips zeros", () => {
    const { message } = buildGpsPLBreakdown("Back", PL_BACK);
    expect(message).toContain("Wind: -4 yds");
    expect(message).toContain("Elevation: -2 yds");
    // Zero-valued factors are intentionally omitted.
    expect(message).not.toContain("Temperature");
    expect(message).not.toContain("Altitude");
  });

  it("renders the neutral-conditions branch when every factor is zero", () => {
    const neutral: PlaysLikeBreakdown = {
      rawYards: 150,
      playsLikeYards: 150,
      windAdj: 0,
      elevAdj: 0,
      tempAdj: 0,
      altitudeAdj: 0,
    };
    const { title, message } = buildGpsPLBreakdown("Front", neutral);
    expect(title).toBe("Front · Plays-like breakdown");
    expect(message).toContain("Raw: 150 yds");
    expect(message).toContain("Plays like: 150 yds");
    expect(message).toContain("Conditions are neutral.");
    // None of the per-factor lines should appear.
    expect(message).not.toMatch(/Wind:/);
    expect(message).not.toMatch(/Elevation:/);
    expect(message).not.toMatch(/Temperature:/);
    expect(message).not.toMatch(/Altitude:/);
  });
});

describe("<GpsDistanceRow /> — F / C / B popups", () => {
  it("opens the matching breakdown Alert for each of Front / Centre / Back", () => {
    render(
      <GpsDistanceRow
        distFrontM={DIST_FRONT_M}
        distCentreM={DIST_CENTRE_M}
        distBackM={DIST_BACK_M}
        plFront={PL_FRONT}
        plCentre={PL_CENTRE}
        plBack={PL_BACK}
        hasPinOffset={false}
      />,
    );

    // FRONT
    fireEvent.click(
      screen.getByLabelText(/^Front plays like 117 yards/i),
    );
    expect(alertSpy).toHaveBeenLastCalledWith(
      "Front · Plays-like breakdown",
      expect.stringContaining("Plays like: 117 yds"),
    );
    // The Front breakdown should mention Wind +5 / Elevation +2 only.
    expect(alertSpy.mock.calls.at(-1)?.[1]).toContain("Wind: +5 yds");
    expect(alertSpy.mock.calls.at(-1)?.[1]).toContain("Elevation: +2 yds");
    expect(alertSpy.mock.calls.at(-1)?.[1]).not.toContain("Temperature");

    // CENTRE — hasPinOffset=false → label "Centre"
    fireEvent.click(
      screen.getByLabelText(/^Centre plays like 148 yards/i),
    );
    expect(alertSpy).toHaveBeenLastCalledWith(
      "Centre · Plays-like breakdown",
      expect.stringContaining("Plays like: 148 yds"),
    );
    expect(alertSpy.mock.calls.at(-1)?.[1]).toContain("Wind: +6 yds");
    expect(alertSpy.mock.calls.at(-1)?.[1]).toContain("Temperature: +1 yds");
    expect(alertSpy.mock.calls.at(-1)?.[1]).toContain("Altitude: +1 yds");

    // BACK — negative wind/elev
    fireEvent.click(
      screen.getByLabelText(/^Back plays like 149 yards/i),
    );
    expect(alertSpy).toHaveBeenLastCalledWith(
      "Back · Plays-like breakdown",
      expect.stringContaining("Plays like: 149 yds"),
    );
    expect(alertSpy.mock.calls.at(-1)?.[1]).toContain("Wind: -4 yds");
    expect(alertSpy.mock.calls.at(-1)?.[1]).toContain("Elevation: -2 yds");

    // Three taps → exactly three Alerts.
    expect(alertSpy).toHaveBeenCalledTimes(3);
  });

  it("switches the centre cell label to PIN/Pin when hasPinOffset=true", () => {
    render(
      <GpsDistanceRow
        distFrontM={DIST_FRONT_M}
        distCentreM={DIST_CENTRE_M}
        distBackM={DIST_BACK_M}
        plFront={PL_FRONT}
        plCentre={PL_CENTRE}
        plBack={PL_BACK}
        hasPinOffset
      />,
    );

    // The visible column heading flips from CENTRE → PIN.
    expect(screen.getByText("PIN")).toBeInTheDocument();
    expect(screen.queryByText("CENTRE")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/^Pin plays like 148 yards/i));
    expect(alertSpy).toHaveBeenLastCalledWith(
      "Pin · Plays-like breakdown",
      expect.any(String),
    );
  });

  it("renders the neutral-conditions Alert body when every factor is zero", () => {
    const neutralCentre: PlaysLikeBreakdown = {
      rawYards: 137,
      playsLikeYards: 140, // != 137 yds (rounded centre distance) so the pressable still renders
      windAdj: 0,
      elevAdj: 0,
      tempAdj: 0,
      altitudeAdj: 0,
    };
    render(
      <GpsDistanceRow
        distFrontM={DIST_FRONT_M}
        distCentreM={DIST_CENTRE_M}
        distBackM={DIST_BACK_M}
        plFront={null}
        plCentre={neutralCentre}
        plBack={null}
        hasPinOffset={false}
      />,
    );

    fireEvent.click(screen.getByLabelText(/^Centre plays like 140 yards/i));
    const [, message] = alertSpy.mock.calls.at(-1) ?? [];
    expect(message).toContain("Conditions are neutral.");
    expect(message).not.toMatch(/Wind:/);
  });

  it("renders the 'saved course data' pill only when usingCachedCourse=true (Task #1332)", () => {
    // Default — no pill.
    const { rerender } = render(
      <GpsDistanceRow
        distFrontM={DIST_FRONT_M}
        distCentreM={DIST_CENTRE_M}
        distBackM={DIST_BACK_M}
        plFront={null}
        plCentre={null}
        plBack={null}
        hasPinOffset={false}
      />,
    );
    expect(screen.queryByText(/saved course data/i)).toBeNull();

    // Round-level offline signal flips on → pill appears beneath the row.
    rerender(
      <GpsDistanceRow
        distFrontM={DIST_FRONT_M}
        distCentreM={DIST_CENTRE_M}
        distBackM={DIST_BACK_M}
        plFront={null}
        plCentre={null}
        plBack={null}
        hasPinOffset={false}
        usingCachedCourse
      />,
    );
    expect(screen.getByText(/saved course data/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/distances using saved offline course data/i),
    ).toBeInTheDocument();
  });

  it("hides the plays-like pressable when the breakdown matches the raw GPS yardage", () => {
    // 125m → 137 yds. A breakdown of 137 yds should suppress the popup entry.
    const samePL: PlaysLikeBreakdown = {
      rawYards: 137,
      playsLikeYards: 137,
      windAdj: 0,
      elevAdj: 0,
      tempAdj: 0,
      altitudeAdj: 0,
    };
    render(
      <GpsDistanceRow
        distFrontM={null}
        distCentreM={DIST_CENTRE_M}
        distBackM={null}
        plFront={null}
        plCentre={samePL}
        plBack={null}
        hasPinOffset={false}
      />,
    );
    expect(screen.queryByLabelText(/plays like .* yards/i)).toBeNull();
  });
});
