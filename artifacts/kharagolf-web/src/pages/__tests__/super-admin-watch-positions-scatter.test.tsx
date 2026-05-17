/**
 * Task #1675 — UI test for the small SVG scatter visual added to the
 * "Recent watch positions" dialog.
 *
 * Task #1392 introduced the table that lists raw GPS payloads for a single
 * watch session. Task #1675 adds a small map / scatter visual alongside it
 * so ops can eyeball stuck loops, jitter, or implausible jumps in seconds
 * without scanning rows.
 *
 * These tests cover the rendering contract from the task spec:
 *
 *   - Falls back gracefully if no positions are loaded yet (empty samples
 *     render nothing — the parent dialog already has its own empty state).
 *   - With multiple distinct points, the trajectory polyline + one marker
 *     per sample render, and markers carry a `data-testid` indexed by the
 *     same numbering the table uses (newest = #1).
 *   - When every sample has the same coordinate ("stuck"), the visual
 *     collapses to a single emphasised marker plus an "all positions
 *     identical" label, instead of an indistinguishable dot cloud.
 *   - Single-point input renders exactly one marker (no polyline) without
 *     crashing on the divide-by-range edge case.
 *
 * Task #2077 — additional coverage for the "Open in Google Maps" /
 * "View trajectory" links that let ops jump from the abstract scatter to
 * a real basemap. The scatter is great for relative motion but has no
 * real-world context, so these links are the difference between
 * "stuck on the 9th green" and "stuck in the parking lot".
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

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

describe("WatchPositionsScatter", () => {
  it("renders nothing when no samples are loaded yet", () => {
    const { container } = render(<WatchPositionsScatter samples={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one marker per sample plus a trajectory polyline for multiple points", () => {
    // Three points spread out enough (~tens of metres apart) to be well
    // above the stuck threshold. API returns newest-first, so #1 = newest.
    const samples = [
      makeSample("2026-04-29T12:02:00Z", 51.5009, -0.1247), // newest
      makeSample("2026-04-29T12:01:00Z", 51.5005, -0.1249),
      makeSample("2026-04-29T12:00:00Z", 51.5001, -0.1251), // oldest
    ];
    render(<WatchPositionsScatter samples={samples} />);

    const wrapper = screen.getByTestId("watch-positions-scatter");
    expect(within(wrapper).getByTestId("scatter-trajectory")).toBeInTheDocument();
    // One marker per sample, indexed by the same numbering as the table.
    expect(within(wrapper).getByTestId("scatter-point-0")).toBeInTheDocument();
    expect(within(wrapper).getByTestId("scatter-point-1")).toBeInTheDocument();
    expect(within(wrapper).getByTestId("scatter-point-2")).toBeInTheDocument();
    expect(within(wrapper).queryByTestId("scatter-point-3")).toBeNull();
    // No "stuck" badge for a real trajectory.
    expect(within(wrapper).queryByTestId("text-watch-positions-stuck")).toBeNull();
    // Span label reports a metres-level value, not the stuck sentinel.
    expect(within(wrapper).getByTestId("text-watch-positions-span"))
      .not.toHaveTextContent(/stuck/i);
  });

  it("collapses to a single emphasised marker with a stuck label when all points share one coordinate", () => {
    const samples = [
      makeSample("2026-04-29T12:02:00Z", 51.5, -0.12),
      makeSample("2026-04-29T12:01:30Z", 51.5, -0.12),
      makeSample("2026-04-29T12:01:00Z", 51.5, -0.12),
      makeSample("2026-04-29T12:00:30Z", 51.5, -0.12),
    ];
    render(<WatchPositionsScatter samples={samples} />);

    const wrapper = screen.getByTestId("watch-positions-scatter");
    expect(within(wrapper).getByTestId("scatter-stuck-marker")).toBeInTheDocument();
    expect(within(wrapper).getByTestId("text-watch-positions-stuck")).toHaveTextContent(
      /All 4 positions identical/i,
    );
    // No per-sample markers and no trajectory line in the stuck path.
    expect(within(wrapper).queryByTestId("scatter-point-0")).toBeNull();
    expect(within(wrapper).queryByTestId("scatter-trajectory")).toBeNull();
    expect(within(wrapper).getByTestId("text-watch-positions-span")).toHaveTextContent(
      /stuck/i,
    );
  });

  it("renders a single marker (no polyline) for a single-sample buffer", () => {
    const samples = [makeSample("2026-04-29T12:02:00Z", 51.5009, -0.1247)];
    render(<WatchPositionsScatter samples={samples} />);

    const wrapper = screen.getByTestId("watch-positions-scatter");
    // Single-sample => spanM = 0 => "stuck" path with one collapsed marker.
    expect(within(wrapper).getByTestId("scatter-stuck-marker")).toBeInTheDocument();
    expect(within(wrapper).queryByTestId("scatter-trajectory")).toBeNull();
    expect(within(wrapper).getByTestId("text-watch-positions-stuck")).toHaveTextContent(
      /All 1 positions identical/i,
    );
  });

  // Task #2077 — Google Maps deep links.
  describe("Google Maps deep links (Task #2077)", () => {
    it("links the newest sample's coordinates to Google Maps with safe target/rel", () => {
      // newest-first ordering, so samples[0] is the freshest known fix and
      // is what the "Open newest" link must target.
      const samples = [
        makeSample("2026-04-29T12:02:00Z", 51.5009, -0.1247),
        makeSample("2026-04-29T12:01:00Z", 51.5005, -0.1249),
        makeSample("2026-04-29T12:00:00Z", 51.5001, -0.1251),
      ];
      render(<WatchPositionsScatter samples={samples} />);

      const wrapper = screen.getByTestId("watch-positions-scatter");
      const link = within(wrapper).getByTestId(
        "link-watch-positions-open-newest-in-maps",
      ) as HTMLAnchorElement;

      // Targets the newest fix (samples[0]) at full coordinate precision so
      // the dropped pin matches what's in row #1 of the table.
      expect(link.getAttribute("href")).toBe(
        "https://www.google.com/maps/search/?api=1&query=51.5009,-0.1247",
      );
      // Opens in a new tab without leaking window.opener / referrer to
      // maps.google.com.
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
      expect(link.rel).toContain("noreferrer");
    });

    it("offers a multi-point trajectory link that walks oldest → newest with the in-between samples as waypoints", () => {
      const samples = [
        makeSample("2026-04-29T12:02:00Z", 51.5009, -0.1247), // newest
        makeSample("2026-04-29T12:01:00Z", 51.5005, -0.1249),
        makeSample("2026-04-29T12:00:00Z", 51.5001, -0.1251), // oldest
      ];
      render(<WatchPositionsScatter samples={samples} />);

      const wrapper = screen.getByTestId("watch-positions-scatter");
      const link = within(wrapper).getByTestId(
        "link-watch-positions-view-trajectory-in-maps",
      ) as HTMLAnchorElement;

      const href = link.getAttribute("href")!;
      expect(href.startsWith("https://www.google.com/maps/dir/?")).toBe(true);
      // Oldest sample is the origin, newest is the destination, anything
      // between becomes waypoints — so the rendered route mirrors the
      // chronological trajectory shown in the scatter.
      expect(href).toContain("origin=51.5001%2C-0.1251");
      expect(href).toContain("destination=51.5009%2C-0.1247");
      expect(href).toContain("waypoints=51.5005%2C-0.1249");
      expect(href).toContain("travelmode=walking");
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
      expect(link.rel).toContain("noreferrer");
      // No sub-sampling badge when the buffer fits inside the 10-point cap.
      expect(
        within(wrapper).queryByTestId("text-watch-positions-trajectory-trimmed"),
      ).toBeNull();
    });

    it("does not render a trajectory link when every sample sits on the same coordinate (stuck case)", () => {
      // No real route to draw if the watch hasn't moved — the
      // "Open newest in Google Maps" link is enough to give ops the
      // surrounding terrain.
      const samples = [
        makeSample("2026-04-29T12:02:00Z", 51.5, -0.12),
        makeSample("2026-04-29T12:01:00Z", 51.5, -0.12),
        makeSample("2026-04-29T12:00:00Z", 51.5, -0.12),
      ];
      render(<WatchPositionsScatter samples={samples} />);

      const wrapper = screen.getByTestId("watch-positions-scatter");
      expect(
        within(wrapper).getByTestId("link-watch-positions-open-newest-in-maps"),
      ).toBeInTheDocument();
      expect(
        within(wrapper).queryByTestId("link-watch-positions-view-trajectory-in-maps"),
      ).toBeNull();
    });

    it("sub-samples the trajectory link when the buffer holds more than the Google Maps 10-point cap", () => {
      // Build 15 distinct points along a small arc so spanM is well above
      // the stuck threshold. The trajectory link must keep the original
      // oldest + newest endpoints (full session coverage) while sub-
      // sampling the middle so the URL stays under Google's 10-point
      // directions limit.
      const samples = Array.from({ length: 15 }, (_, i) =>
        // newest-first: i=0 is the most recent
        makeSample(
          `2026-04-29T12:${String(15 - i).padStart(2, "0")}:00Z`,
          51.5 + (15 - i) * 0.0001,
          -0.12 + (15 - i) * 0.0001,
        ),
      );
      render(<WatchPositionsScatter samples={samples} />);

      const wrapper = screen.getByTestId("watch-positions-scatter");
      const link = within(wrapper).getByTestId(
        "link-watch-positions-view-trajectory-in-maps",
      ) as HTMLAnchorElement;
      const href = link.getAttribute("href")!;
      // Parse via URL so we don't bake in the order/encoding of params.
      const params = new URL(href).searchParams;

      // After reversing to oldest→newest, oldest = sample with i=14
      // (≈ 51.5001, -0.1199) and newest = sample with i=0
      // (≈ 51.5015, -0.1185). Those endpoints must be preserved so the
      // rendered route still spans the full session — compare with a
      // tolerance so JS float arithmetic (e.g. -0.12 + 0.0001) doesn't
      // make the test brittle.
      const [olat, olng] = params.get("origin")!.split(",").map(parseFloat);
      const [dlat, dlng] = params.get("destination")!.split(",").map(parseFloat);
      expect(olat).toBeCloseTo(51.5001, 4);
      expect(olng).toBeCloseTo(-0.1199, 4);
      expect(dlat).toBeCloseTo(51.5015, 4);
      expect(dlng).toBeCloseTo(-0.1185, 4);

      // 10-point cap => 8 intermediate waypoints separated by `|`.
      const waypoints = params.get("waypoints")!.split("|");
      expect(waypoints).toHaveLength(8);

      // Sub-sampling badge tells ops the link isn't lossless.
      expect(
        within(wrapper).getByTestId("text-watch-positions-trajectory-trimmed"),
      ).toHaveTextContent(/10 of 15/);
    });
  });
});
