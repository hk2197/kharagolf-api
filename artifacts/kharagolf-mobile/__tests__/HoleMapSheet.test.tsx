/**
 * UI test: HoleMapSheet "3D Green" entry-point + ball-position selection
 *
 * Covers Task #358's mobile flow:
 *   1. Open the HoleMapSheet for a hole with green-centre GPS coords + contour data
 *   2. Tap the "3D Green" button → Green3DView modal opens
 *   3. Tap inside the contour SVG → the ball marker (white circle, black stroke)
 *      moves to a different cell — proven by reading the rendered cx/cy attributes
 *      on the ball <circle> before and after the tap.
 *
 * react-native-svg + the watch native module are mocked because jsdom can't load
 * them; the satellite Image is allowed to fail silently (we don't assert on it).
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

type SvgPrimitiveProps = React.SVGAttributes<Element> & { children?: ReactNode };

// ── Mocks: native bits jsdom can't render ──────────────────────────────────
vi.mock("react-native-svg", () => {
  const ReactInner = require("react") as typeof React;
  // Render every SVG primitive as a same-named lower-case DOM element so we can
  // locate it later via querySelector and inspect attributes (cx, cy, fill…).
  const passthrough = (tag: string) =>
    ReactInner.forwardRef<Element, SvgPrimitiveProps>(({ children, ...rest }, ref) =>
      ReactInner.createElement(tag, { ...rest, ref }, children),
    );
  const Svg = passthrough("svg");
  return {
    __esModule: true,
    default: Svg,
    Svg,
    G: passthrough("g"),
    Circle: passthrough("circle"),
    Ellipse: passthrough("ellipse"),
    Line: passthrough("line"),
    Path: passthrough("path"),
    Polygon: passthrough("polygon"),
    Rect: passthrough("rect"),
    Text: passthrough("svgtext"),
    Defs: passthrough("defs"),
    LinearGradient: passthrough("linearGradient"),
    Stop: passthrough("stop"),
  };
});

vi.mock("@/modules/KharagolfWatchBridge", () => ({
  WatchBridge: {
    isAvailable: vi.fn(() => false),
    pushPlaysLike: vi.fn().mockResolvedValue(undefined),
  },
}));

type FetchPublicResponse =
  | { token: string | null }
  | unknown[]
  | { rows: number; cols: number; cellMeters: number; elevations: number[] }
  | null;
type FetchPublicFn = (path: string) => Promise<FetchPublicResponse>;

const defaultFetchPublic: FetchPublicFn = async (path) => {
  if (path === "/map-config") return { token: null }; // no satellite image
  if (path.endsWith("/holes-hazards")) return [];
  if (path.endsWith("/holes-fairways")) return [];
  if (path.includes("/contour")) {
    // 5×5 grid sloping monotonically (top-left high → bottom-right low).
    // Default ball position = bottom-center cell (col 2, row 4).
    // A click anywhere else MUST land on a different cell, so the ball's
    // rendered cx/cy will change.
    const rows = 5, cols = 5;
    const elevations: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        elevations.push(2.0 - 0.15 * (r + c));
      }
    }
    return { rows, cols, cellMeters: 1.5, elevations };
  }
  return null;
};

vi.mock("@/utils/api", () => ({
  BASE_URL: "",
  fetchPublic: vi.fn<FetchPublicFn>(),
}));

import HoleMapSheet, { playsLikeYards } from "../components/HoleMapSheet";
import { fetchPublic } from "@/utils/api";
import { WatchBridge } from "@/modules/KharagolfWatchBridge";
const fetchPublicMock = vi.mocked(fetchPublic) as unknown as Mock<FetchPublicFn>;
const isAvailableMock = vi.mocked(WatchBridge.isAvailable);
const pushPlaysLikeMock = vi.mocked(WatchBridge.pushPlaysLike);

// Mirrors of helpers inside HoleMapSheet (kept private there) so we can
// compute the exact expected values the watch should receive.
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const la1 = lat1 * Math.PI / 180;
  const la2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

const HOLE = {
  holeNumber: 1,
  par: 4,
  yardageWhite: 380,
  greenCentreLat: "12.971800",
  greenCentreLng: "77.594560",
  greenFrontLat: "12.971700",
  greenFrontLng: "77.594560",
  greenBackLat: "12.971900",
  greenBackLng: "77.594560",
};

beforeEach(() => {
  // jsdom doesn't compute layout — Dimensions.get('window') would otherwise
  // return 0×0 and Green3DView would project every cell to the same screen
  // pixel, hiding any state change. Pin a deterministic viewport.
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1024, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 768, configurable: true });

  fetchPublicMock.mockImplementation(defaultFetchPublic);
  isAvailableMock.mockReturnValue(false);
  pushPlaysLikeMock.mockClear();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ elevation: [800, 802, 803, 804] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// Locate the Green3DView modal subtree by walking up from its title text and
// finding the highest ancestor that still contains the "Break:" info block.
function get3DModalRoot(): HTMLElement {
  const title = screen.getByText(/Hole 1 — 3D Green/i);
  let node: HTMLElement | null = title;
  while (node && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    if (parent.querySelector("svg") && parent.textContent?.includes("Break:")) {
      return parent;
    }
    node = parent;
  }
  throw new Error("Could not locate 3D modal root containing both <svg> and the Break: label");
}

// The ball is the only circle in Green3DView with fill="#fff" + stroke="#000".
function getBallCircle(modalRoot: HTMLElement): Element {
  const balls = modalRoot.querySelectorAll('circle[fill="#fff"][stroke="#000"]');
  if (balls.length === 0) throw new Error("Ball circle not found inside 3D modal");
  // If ever multiple, take the last one (topmost in render order).
  return balls[balls.length - 1];
}

describe("<HoleMapSheet /> — 3D Green flow", () => {
  it("opens 3D Green view on tap and moves the ball when the user taps the contour", async () => {
    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={12.972300}
        userLng={77.594560}
        weather={{ windSpeed: 10, windDirection: 0, temperature: 22, weatherCode: 0 }}
        courseId={42}
      />,
    );

    // 3D Green button exists in the map header overlay
    const threeDBtn = await screen.findByText("3D Green");
    expect(threeDBtn).toBeInTheDocument();

    // Tap it → Green3DView modal mounts and shows the hole-specific title
    fireEvent.click(threeDBtn);
    await screen.findByText(/Hole 1 — 3D Green/i);

    // Wait for the contour fetch to resolve and grid polys to render.
    // The "Break:" info block exists only when contour data is present.
    await screen.findByText(/^Break:/);

    const modal = get3DModalRoot();
    const svg = modal.querySelector("svg");
    expect(svg).not.toBeNull();

    // Capture the initial ball position (default = bottom-centre cell).
    const ballBefore = getBallCircle(modal);
    const cxBefore = ballBefore.getAttribute("cx");
    const cyBefore = ballBefore.getAttribute("cy");
    expect(cxBefore).toBeTruthy();
    expect(cyBefore).toBeTruthy();
    // Sanity: with a real viewport the default ball cell projects to non-zero px.
    expect(parseFloat(cxBefore as string)).not.toBe(0);

    // Tap the SVG. The Pressable wrapping it forwards the click to onTap,
    // which picks the nearest grid cell and updates ball state. Even if
    // jsdom's synthesised MouseEvent supplies offsetX/offsetY = 0, that
    // still selects a corner cell — guaranteed to differ from the default
    // bottom-centre cell on a 5×5 grid.
    fireEvent.click(svg as Element, { clientX: 5, clientY: 5 });

    const ballAfter = getBallCircle(modal);
    const cxAfter = ballAfter.getAttribute("cx");
    const cyAfter = ballAfter.getAttribute("cy");

    // PROOF that the tap-to-pick handler actually ran and updated state.
    expect(`${cxAfter},${cyAfter}`).not.toBe(`${cxBefore},${cyBefore}`);
  });

  it("falls back gracefully when contour data is unavailable", async () => {
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path === "/map-config") return { token: null };
      if (path.endsWith("/holes-hazards")) return [];
  if (path.endsWith("/holes-fairways")) return [];
      if (path.includes("/contour")) throw new Error("no_contour");
      return null;
    });

    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={12.972300}
        userLng={77.594560}
        weather={null}
        courseId={42}
      />,
    );

    fireEvent.click(await screen.findByText("3D Green"));

    // Title still appears, but the "3D contour not available" fallback shows
    expect(await screen.findByText(/3D contour not available/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Break:/)).not.toBeInTheDocument();
  });
});

describe("<HoleMapSheet /> — watch hand-off", () => {
  const userLat = 12.972300;
  const userLng = 77.594560;
  const weather = { windSpeed: 10, windDirection: 0, temperature: 22, weatherCode: 0 };

  it("pushes the latest plays-like yardage to the watch when available", async () => {
    isAvailableMock.mockReturnValue(true);

    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={userLat}
        userLng={userLng}
        weather={weather}
        courseId={42}
      />,
    );

    // Wait until the watch has received a push that reflects the resolved
    // elevation data (elevAdj != 0). The effect fires a first time before
    // the open-meteo elevation fetch resolves, so just waiting for any call
    // would race with the fetch.
    await waitFor(() => {
      const lastElev = pushPlaysLikeMock.mock.calls.at(-1)?.[4];
      expect(lastElev).not.toBe(0);
    });

    // Compute the exact values the component should derive (mirrors the
    // useEffect in HoleMapSheet) so the test catches regressions in any of
    // the inputs — distance, plays-like maths, wind adjustment or elevation
    // adjustment.
    const centreLat = parseFloat(HOLE.greenCentreLat);
    const centreLng = parseFloat(HOLE.greenCentreLng);
    const distM = haversineMeters(userLat, userLng, centreLat, centreLng);
    const distYds = Math.round(distM * 1.09361);
    const bearing = bearingDeg(userLat, userLng, centreLat, centreLng);
    // fetch returns elevations [user, front, centre, back] = [800, 802, 803, 804].
    // Pin offset = 0,0 → pin sits at centre, so pinElev ≈ 803, elevDiff = 3 m.
    const elevDiffMeters = 3;
    const altitude = 800;
    const expectedPlaysLike = playsLikeYards(
      distYds,
      weather.windSpeed,
      weather.windDirection,
      bearing,
      elevDiffMeters,
      weather.temperature,
      altitude,
    );
    const windToward = (weather.windDirection + 180) % 360;
    const expectedWindAdj = Math.round(
      (-weather.windSpeed * Math.cos(((windToward - bearing) * Math.PI) / 180)) / 10 * (distYds / 100),
    );
    const expectedElevAdj = Math.round(elevDiffMeters * 1.09361);

    // Use the most recent call — earlier calls may have fired before the
    // elevation fetch resolved, when pinElevDiff was still undefined.
    const lastCall = pushPlaysLikeMock.mock.calls[pushPlaysLikeMock.mock.calls.length - 1];
    expect(lastCall).toEqual([
      HOLE.holeNumber,
      distYds,
      expectedPlaysLike,
      expectedWindAdj,
      expectedElevAdj,
    ]);
  });

  it("does not push to the watch when weather is null", async () => {
    isAvailableMock.mockReturnValue(true);

    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={userLat}
        userLng={userLng}
        weather={null}
        courseId={42}
      />,
    );

    // Wait for the contour fetch (and the elevation fetch) to flush so any
    // pending effects have run before we assert no-call.
    await screen.findByText("3D Green");
    await new Promise((r) => setTimeout(r, 50));

    expect(pushPlaysLikeMock).not.toHaveBeenCalled();
  });

  it("does not push to the watch when the player's distance is unknown", async () => {
    isAvailableMock.mockReturnValue(true);

    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={null}
        userLng={null}
        weather={weather}
        courseId={42}
      />,
    );

    await screen.findByText("3D Green");
    await new Promise((r) => setTimeout(r, 50));

    expect(pushPlaysLikeMock).not.toHaveBeenCalled();
  });
});
