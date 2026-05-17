/**
 * Task #2076 — UI tests for cross-highlighting between the "Recent watch
 * positions" table and the WatchPositionsScatter visual.
 *
 * Task #1675 added the scatter alongside the existing table. This task wires
 * a shared "hover key" so:
 *
 *   - Hovering a marker emphasises that marker and is reported via the
 *     onHoverKey callback so the parent can tint the matching row(s).
 *   - The trajectory case keys markers by displayed lat/lng, so two rows
 *     that happen to land on the same coord (rare jitter case) light up
 *     together with their shared marker.
 *   - The stuck case keys every sample with the sentinel "stuck" key, so
 *     hovering the single collapsed marker lights up every row at once
 *     (and vice versa).
 *
 * These tests exercise the scatter component in isolation: we render it
 * with a controlled hoveredKey + onHoverKey spy and assert both the visual
 * emphasis (halo + radius) and the emitted hover keys.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";

import { WatchPositionsScatter } from "../super-admin";

afterEach(() => cleanup());

function makeSample(
  iso: string,
  lat: number,
  lng: number,
  batteryMode = false,
) {
  return { timestamp: iso, lat, lng, batteryMode };
}

// Mirrors the helper used internally by both the scatter and the dialog
// when computing per-sample highlight keys for the trajectory case.
function trajectoryKey(lat: number, lng: number) {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

describe("WatchPositionsScatter cross-highlight (Task #2076)", () => {
  it("emits the matching trajectory key when a marker is hovered", () => {
    const samples = [
      makeSample("2026-04-29T12:02:00Z", 51.5009, -0.1247), // newest
      makeSample("2026-04-29T12:01:00Z", 51.5005, -0.1249),
      makeSample("2026-04-29T12:00:00Z", 51.5001, -0.1251), // oldest
    ];
    const onHoverKey = vi.fn();
    render(
      <WatchPositionsScatter samples={samples} onHoverKey={onHoverKey} />,
    );

    const wrapper = screen.getByTestId("watch-positions-scatter");
    const newestMarker = within(wrapper).getByTestId("scatter-point-0");
    fireEvent.mouseEnter(newestMarker);
    // #1 in the table = newest sample = samples[0].
    expect(onHoverKey).toHaveBeenLastCalledWith(
      trajectoryKey(samples[0].lat, samples[0].lng),
    );

    fireEvent.mouseLeave(newestMarker);
    expect(onHoverKey).toHaveBeenLastCalledWith(null);
  });

  it("draws an emphasis halo on the marker whose key matches hoveredKey", () => {
    const samples = [
      makeSample("2026-04-29T12:02:00Z", 51.5009, -0.1247),
      makeSample("2026-04-29T12:01:00Z", 51.5005, -0.1249),
      makeSample("2026-04-29T12:00:00Z", 51.5001, -0.1251),
    ];
    // Hover the *middle* sample (table index 1) via the shared key.
    const hoveredKey = trajectoryKey(samples[1].lat, samples[1].lng);
    render(
      <WatchPositionsScatter samples={samples} hoveredKey={hoveredKey} />,
    );

    const wrapper = screen.getByTestId("watch-positions-scatter");
    // Halo present on the matching marker, absent on the others.
    expect(within(wrapper).getByTestId("scatter-point-1-halo"))
      .toBeInTheDocument();
    expect(within(wrapper).queryByTestId("scatter-point-0-halo")).toBeNull();
    expect(within(wrapper).queryByTestId("scatter-point-2-halo")).toBeNull();
  });

  it("highlights every marker that shares the hovered coord (duplicate-coord rows)", () => {
    // Two rows sit on the exact same coordinate inside an otherwise normal
    // trajectory — both their markers should light up together.
    const sharedLat = 51.5005;
    const sharedLng = -0.1249;
    const samples = [
      makeSample("2026-04-29T12:02:00Z", 51.5009, -0.1247), // newest, distinct
      makeSample("2026-04-29T12:01:30Z", sharedLat, sharedLng),
      makeSample("2026-04-29T12:01:00Z", sharedLat, sharedLng),
      makeSample("2026-04-29T12:00:00Z", 51.5001, -0.1251), // oldest, distinct
    ];
    render(
      <WatchPositionsScatter
        samples={samples}
        hoveredKey={trajectoryKey(sharedLat, sharedLng)}
      />,
    );

    const wrapper = screen.getByTestId("watch-positions-scatter");
    // The two duplicate-coord rows are at table indices 1 and 2.
    expect(within(wrapper).getByTestId("scatter-point-1-halo"))
      .toBeInTheDocument();
    expect(within(wrapper).getByTestId("scatter-point-2-halo"))
      .toBeInTheDocument();
    // The two distinct-coord rows (0 and 3) stay at their normal style.
    expect(within(wrapper).queryByTestId("scatter-point-0-halo")).toBeNull();
    expect(within(wrapper).queryByTestId("scatter-point-3-halo")).toBeNull();
  });

  it("emits the 'stuck' sentinel key when the single collapsed marker is hovered", () => {
    const samples = [
      makeSample("2026-04-29T12:02:00Z", 51.5, -0.12),
      makeSample("2026-04-29T12:01:30Z", 51.5, -0.12),
      makeSample("2026-04-29T12:01:00Z", 51.5, -0.12),
    ];
    const onHoverKey = vi.fn();
    render(
      <WatchPositionsScatter samples={samples} onHoverKey={onHoverKey} />,
    );

    const wrapper = screen.getByTestId("watch-positions-scatter");
    const stuck = within(wrapper).getByTestId("scatter-stuck-marker");
    fireEvent.mouseEnter(stuck);
    expect(onHoverKey).toHaveBeenLastCalledWith("stuck");
    fireEvent.mouseLeave(stuck);
    expect(onHoverKey).toHaveBeenLastCalledWith(null);
  });

  it("draws the stuck-marker halo when hoveredKey === 'stuck'", () => {
    const samples = [
      makeSample("2026-04-29T12:02:00Z", 51.5, -0.12),
      makeSample("2026-04-29T12:01:30Z", 51.5, -0.12),
    ];
    const { rerender } = render(
      <WatchPositionsScatter samples={samples} hoveredKey={null} />,
    );
    expect(screen.queryByTestId("scatter-stuck-marker-halo")).toBeNull();

    rerender(<WatchPositionsScatter samples={samples} hoveredKey="stuck" />);
    expect(screen.getByTestId("scatter-stuck-marker-halo"))
      .toBeInTheDocument();
  });

  it("ignores hoveredKey that does not match any marker (no spurious halo)", () => {
    const samples = [
      makeSample("2026-04-29T12:02:00Z", 51.5009, -0.1247),
      makeSample("2026-04-29T12:01:00Z", 51.5005, -0.1249),
    ];
    render(
      <WatchPositionsScatter
        samples={samples}
        hoveredKey={trajectoryKey(40, 40)}
      />,
    );
    const wrapper = screen.getByTestId("watch-positions-scatter");
    expect(within(wrapper).queryByTestId("scatter-point-0-halo")).toBeNull();
    expect(within(wrapper).queryByTestId("scatter-point-1-halo")).toBeNull();
  });

  it("works without an onHoverKey callback (component is hover-tolerant)", () => {
    const samples = [
      makeSample("2026-04-29T12:02:00Z", 51.5009, -0.1247),
      makeSample("2026-04-29T12:01:00Z", 51.5005, -0.1249),
    ];
    render(<WatchPositionsScatter samples={samples} />);
    const wrapper = screen.getByTestId("watch-positions-scatter");
    // Should not throw when the callback is omitted.
    expect(() => {
      fireEvent.mouseEnter(within(wrapper).getByTestId("scatter-point-0"));
      fireEvent.mouseLeave(within(wrapper).getByTestId("scatter-point-0"));
    }).not.toThrow();
  });
});
