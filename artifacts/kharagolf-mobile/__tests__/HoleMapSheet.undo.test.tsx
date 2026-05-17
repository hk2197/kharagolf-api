/**
 * UI test: HoleMapSheet drag-to-undo snackbar (Task #859 / Task #1010 / Task #1177).
 *
 * Verifies the same flow the web HoleMapPanel covers, but for mobile:
 *   1. After a successful shot drag the "Shot moved · UNDO" snackbar appears.
 *   2. Tapping UNDO PATCHes the shot back to its pre-drag coordinates.
 *   3. Successive drags STACK into the snackbar (cap 3, Task #1177) — the
 *      banner shows the latest action plus a "+N more" hint and pressing
 *      UNDO reverts entries in LIFO order.
 *
 * react-native's PanResponder is mocked so the test can drive a synthetic
 * grant/move/release sequence directly (jsdom doesn't translate gesture
 * responder events from DOM mouse/touch events). react-native-svg and the
 * watch native module are mocked the same way the existing
 * HoleMapSheet.test.tsx does.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";

type SvgPrimitiveProps = React.SVGAttributes<Element> & { children?: ReactNode };

interface PanResponderConfig {
  onStartShouldSetPanResponder?: () => boolean;
  onMoveShouldSetPanResponder?: (e: unknown, gs: { dx: number; dy: number }) => boolean;
  onPanResponderGrant?: (e: unknown, gs: { dx: number; dy: number }) => void;
  onPanResponderMove?: (e: unknown, gs: { dx: number; dy: number }) => void;
  onPanResponderRelease?: (e: unknown, gs: { dx: number; dy: number }) => void;
  onPanResponderTerminate?: () => void;
}

const panConfigs: PanResponderConfig[] = [];

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return {
    ...actual,
    PanResponder: {
      create: (config: PanResponderConfig) => {
        panConfigs.push(config);
        return { panHandlers: {} };
      },
    },
  };
});

vi.mock("react-native-svg", () => {
  const ReactInner = require("react") as typeof React;
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
    Polyline: passthrough("polyline"),
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

type FetchPublicResponse = { token: string | null } | unknown[] | null;
type FetchPublicFn = (path: string) => Promise<FetchPublicResponse>;

vi.mock("@/utils/api", () => ({
  BASE_URL: "",
  fetchPublic: vi.fn<FetchPublicFn>(),
}));

import HoleMapSheet from "../components/HoleMapSheet";
import { fetchPublic } from "@/utils/api";

const fetchPublicMock = vi.mocked(fetchPublic) as unknown as Mock<FetchPublicFn>;

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

const ORIG_LAT = 12.972500;
const ORIG_LNG = 77.594560;

interface ShotRow {
  id: number;
  holeNumber: number;
  shotNumber: number;
  shotType: string | null;
  club: string | null;
  lieType: string | null;
  latitude: string | null;
  longitude: string | null;
  distanceCarried: string | null;
  distanceToPin: string | null;
}

let shotState: ShotRow[];
let patchCalls: Array<{ id: number; body: Record<string, unknown> }>;

function makeShot(): ShotRow {
  return {
    id: 101,
    holeNumber: 1,
    shotNumber: 1,
    shotType: null,
    club: "7I",
    lieType: "Fairway",
    latitude: String(ORIG_LAT),
    longitude: String(ORIG_LNG),
    distanceCarried: "120",
    distanceToPin: "50",
  };
}

beforeEach(() => {
  panConfigs.length = 0;
  shotState = [makeShot()];
  patchCalls = [];

  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1024, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 768, configurable: true });

  fetchPublicMock.mockImplementation(async (path) => {
    if (path === "/map-config") return { token: null };
    if (path.endsWith("/holes-hazards")) return [];
    if (path.endsWith("/holes-fairways")) return [];
    if (path.includes("/contour")) return null;
    return null;
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/portal/rounds/1/shots")) {
        return new Response(JSON.stringify([{ hole: 1, shots: shotState }]), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      const m = url.match(/\/portal\/shots\/(\d+)/);
      if (m && method === "PATCH") {
        const id = parseInt(m[1], 10);
        const body = init?.body ? JSON.parse(init.body as string) : {};
        patchCalls.push({ id, body });
        const target = shotState.find(s => s.id === id);
        if (target) {
          if (body.latitude !== undefined) target.latitude = String(body.latitude);
          if (body.longitude !== undefined) target.longitude = String(body.longitude);
          if (body.lieType !== undefined) target.lieType = body.lieType;
        }
        return new Response("{}", { status: 200 });
      }
      return new Response("null", { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// The shot DraggableShotMarker's PanResponder config has a movement-gated
// onMoveShouldSetPanResponder, while the pin's always returns true. Use that
// to differentiate the two and pick the latest shot config.
function findShotPanConfig(): PanResponderConfig {
  const matches = panConfigs.filter(c =>
    c.onMoveShouldSetPanResponder?.({}, { dx: 0, dy: 0 }) === false &&
    c.onMoveShouldSetPanResponder?.({}, { dx: 10, dy: 10 }) === true,
  );
  if (matches.length === 0) throw new Error("No shot PanResponder registered");
  return matches[matches.length - 1];
}

describe("<HoleMapSheet /> — drag-to-undo snackbar", () => {
  it("shows the Undo snackbar after a drag and reverts on UNDO press", async () => {
    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={12.972300}
        userLng={77.594560}
        weather={null}
        courseId={42}
        token="tk_test"
        generalPlayRoundId={123}
      />,
    );

    // Wait until the shot fetch resolves and DraggableShotMarker mounts.
    await waitFor(() => {
      expect(panConfigs.some(c =>
        c.onMoveShouldSetPanResponder?.({}, { dx: 0, dy: 0 }) === false &&
        c.onMoveShouldSetPanResponder?.({}, { dx: 10, dy: 10 }) === true,
      )).toBe(true);
    });

    const cfg = findShotPanConfig();

    // Drive a synthetic drag: grant, move past the threshold, then release.
    await act(async () => {
      cfg.onPanResponderGrant?.({}, { dx: 0, dy: 0 });
      cfg.onPanResponderMove?.({}, { dx: 30, dy: 20 });
      cfg.onPanResponderRelease?.({}, { dx: 30, dy: 20 });
    });

    // Snackbar appears with the new-coords PATCH already fired.
    await screen.findByText("Shot moved");
    const movePatch = patchCalls.find(p => p.body.latitude !== undefined);
    expect(movePatch).toBeTruthy();
    expect(movePatch!.body.latitude).not.toBe(ORIG_LAT);

    // Tap UNDO
    fireEvent.click(screen.getByText("UNDO"));

    await waitFor(() => {
      const undo = patchCalls.slice(1).find(p =>
        Math.abs((p.body.latitude as number) - ORIG_LAT) < 1e-9 &&
        Math.abs((p.body.longitude as number) - ORIG_LNG) < 1e-9,
      );
      expect(undo).toBeTruthy();
    });

    // The snackbar disappears after UNDO is pressed.
    await waitFor(() => {
      expect(screen.queryByText("Shot moved")).toBeNull();
    });
  });

  it("stacks two consecutive drags (Task #1177) and undoes them in LIFO order", async () => {
    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={12.972300}
        userLng={77.594560}
        weather={null}
        courseId={42}
        token="tk_test"
        generalPlayRoundId={123}
      />,
    );

    await waitFor(() => {
      expect(panConfigs.some(c =>
        c.onMoveShouldSetPanResponder?.({}, { dx: 0, dy: 0 }) === false &&
        c.onMoveShouldSetPanResponder?.({}, { dx: 10, dy: 10 }) === true,
      )).toBe(true);
    });

    // First drag: small move from origin.
    await act(async () => {
      const cfg = findShotPanConfig();
      cfg.onPanResponderGrant?.({}, { dx: 0, dy: 0 });
      cfg.onPanResponderMove?.({}, { dx: 30, dy: 20 });
      cfg.onPanResponderRelease?.({}, { dx: 30, dy: 20 });
    });
    await screen.findByText("Shot moved");

    // Capture the lat/lng after the first drag — that becomes the "previous"
    // location the second drag's undo must restore.
    const firstMovePatch = patchCalls[patchCalls.length - 1];
    const afterFirstLat = firstMovePatch.body.latitude as number;
    const afterFirstLng = firstMovePatch.body.longitude as number;

    // Second drag: another small move. Should STACK — banner shows
    // "Shot moved" with a "+1 more" hint.
    await act(async () => {
      const cfg = findShotPanConfig();
      cfg.onPanResponderGrant?.({}, { dx: 0, dy: 0 });
      cfg.onPanResponderMove?.({}, { dx: -25, dy: 15 });
      cfg.onPanResponderRelease?.({}, { dx: -25, dy: 15 });
    });

    await screen.findByText(/\+1 more/i);

    // First UNDO press: should pop the most recent drag and restore the
    // post-first-drag coordinates (NOT the pristine ORIG).
    const beforeFirstUndo = patchCalls.length;
    fireEvent.click(screen.getByText("UNDO"));
    await waitFor(() => {
      const undo = patchCalls.slice(beforeFirstUndo).find(p =>
        Math.abs((p.body.latitude as number) - afterFirstLat) < 1e-9 &&
        Math.abs((p.body.longitude as number) - afterFirstLng) < 1e-9,
      );
      expect(undo).toBeTruthy();
    });

    // The "+1 more" hint is gone — only the original move entry is left.
    await waitFor(() => {
      expect(screen.queryByText(/\+\d+ more/i)).toBeNull();
    });
    await screen.findByText("Shot moved");

    // Second UNDO press: pops the original move and restores ORIG_LAT/LNG.
    const beforeSecondUndo = patchCalls.length;
    fireEvent.click(screen.getByText("UNDO"));
    await waitFor(() => {
      const undo = patchCalls.slice(beforeSecondUndo).find(p =>
        Math.abs((p.body.latitude as number) - ORIG_LAT) < 1e-9 &&
        Math.abs((p.body.longitude as number) - ORIG_LNG) < 1e-9,
      );
      expect(undo).toBeTruthy();
    });

    // Snackbar gone — stack is empty.
    await waitFor(() => {
      expect(screen.queryByText("Shot moved")).toBeNull();
    });
  });

  it("caps the undo history at 10 entries — an 11th drag drops the oldest (Task #1177, raised in Task #1639)", async () => {
    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={12.972300}
        userLng={77.594560}
        weather={null}
        courseId={42}
        token="tk_test"
        generalPlayRoundId={123}
      />,
    );

    await waitFor(() => {
      expect(panConfigs.some(c =>
        c.onMoveShouldSetPanResponder?.({}, { dx: 0, dy: 0 }) === false &&
        c.onMoveShouldSetPanResponder?.({}, { dx: 10, dy: 10 }) === true,
      )).toBe(true);
    });

    // Push 11 drags. Each time, the underlying shotState's lat/lng updates
    // so the next drag sees the previous post-drag location as its "prev".
    // Task #1639 raised the cap from 3 to 10, so 11 pushes triggers exactly
    // one drop of the oldest entry.
    const drags = [
      { dx: 30, dy: 20 },
      { dx: -25, dy: 15 },
      { dx: 18, dy: -22 },
      { dx: -10, dy: 30 },
      { dx: 22, dy: -14 },
      { dx: -18, dy: 24 },
      { dx: 14, dy: 28 },
      { dx: -22, dy: -16 },
      { dx: 26, dy: 18 },
      { dx: -14, dy: -24 },
      { dx: 20, dy: 12 },
    ];
    for (const d of drags) {
      await act(async () => {
        const cfg = findShotPanConfig();
        cfg.onPanResponderGrant?.({}, { dx: 0, dy: 0 });
        cfg.onPanResponderMove?.({}, d);
        cfg.onPanResponderRelease?.({}, d);
      });
    }

    // After 11 pushes with cap=10, the banner shows "+9 more" — 10 entries
    // remain (oldest dropped).
    await screen.findByText(/\+9 more/i);

    // Press UNDO ten times — ten undo PATCHes fire and the stack drains.
    const beforeUndos = patchCalls.length;
    for (let i = 0; i < 10; i++) {
      fireEvent.click(screen.getByText("UNDO"));
      const expected = beforeUndos + i + 1;
      await waitFor(() => expect(patchCalls.length).toBe(expected));
    }

    // Snackbar disappears once the stack is empty — an 11th press would
    // have nothing to undo, so the UNDO control isn't on screen anymore.
    await waitFor(() => {
      expect(screen.queryByText("Shot moved")).toBeNull();
    });
    expect(screen.queryByText("UNDO")).toBeNull();

    // The number of follow-up undo PATCHes is exactly 10 — the oldest
    // edit (drag #1) was dropped from the cap, so its undo never fires.
    const undoPatches = patchCalls.slice(beforeUndos);
    expect(undoPatches.length).toBe(10);
  });

  it("clears the undo history when the player navigates to a different hole (Task #1177)", async () => {
    const { rerender } = render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={12.972300}
        userLng={77.594560}
        weather={null}
        courseId={42}
        token="tk_test"
        generalPlayRoundId={123}
      />,
    );

    await waitFor(() => {
      expect(panConfigs.some(c =>
        c.onMoveShouldSetPanResponder?.({}, { dx: 0, dy: 0 }) === false &&
        c.onMoveShouldSetPanResponder?.({}, { dx: 10, dy: 10 }) === true,
      )).toBe(true);
    });

    // Drag to push an undo entry.
    await act(async () => {
      const cfg = findShotPanConfig();
      cfg.onPanResponderGrant?.({}, { dx: 0, dy: 0 });
      cfg.onPanResponderMove?.({}, { dx: 30, dy: 20 });
      cfg.onPanResponderRelease?.({}, { dx: 30, dy: 20 });
    });
    await screen.findByText("Shot moved");

    // Navigate to a different hole. The snackbar should disappear and the
    // history is wiped.
    const NEXT_HOLE = { ...HOLE, holeNumber: 2 };
    rerender(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={NEXT_HOLE}
        userLat={12.972300}
        userLng={77.594560}
        weather={null}
        courseId={42}
        token="tk_test"
        generalPlayRoundId={123}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Shot moved")).toBeNull();
    });
    expect(screen.queryByText("UNDO")).toBeNull();
  });
});
