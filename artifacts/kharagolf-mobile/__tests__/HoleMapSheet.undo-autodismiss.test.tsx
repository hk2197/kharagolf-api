/**
 * UI test: HoleMapSheet drag-to-undo snackbar auto-dismisses after ~5s
 * (Task #1183).
 *
 * Mirrors the web test in HoleMapPanel.undo-autodismiss.test.tsx. The
 * mobile snackbar uses the same 5s window (HoleMapSheet.tsx
 * UNDO_STACK_TTL_MS), driven by a setTimeout in armUndoTimer. The
 * other HoleMapSheet.undo.test.tsx cases confirm the snackbar closes
 * on UNDO press or when the player navigates between holes — they
 * don't catch the auto-dismiss timer being removed or its duration
 * being changed dramatically.
 *
 * Isolated in its own file (one test) so we can lean on real timers
 * without slowing the rest of the mobile suite.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

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

function findShotPanConfig(): PanResponderConfig {
  const matches = panConfigs.filter(c =>
    c.onMoveShouldSetPanResponder?.({}, { dx: 0, dy: 0 }) === false &&
    c.onMoveShouldSetPanResponder?.({}, { dx: 10, dy: 10 }) === true,
  );
  if (matches.length === 0) throw new Error("No shot PanResponder registered");
  return matches[matches.length - 1];
}

describe("<HoleMapSheet /> — Undo snackbar auto-dismiss", () => {
  it("auto-dismisses the 'Shot moved' snackbar ~5s after a drag if the user does nothing", async () => {
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

    // Drive a synthetic drag to push an entry onto the undo stack.
    // The TTL setTimeout is armed inside armUndoTimer, called as part
    // of the release handler — t0 captured right before release is a
    // good approximation of when the 5s window starts.
    let t0 = 0;
    await act(async () => {
      const cfg = findShotPanConfig();
      cfg.onPanResponderGrant?.({}, { dx: 0, dy: 0 });
      cfg.onPanResponderMove?.({}, { dx: 30, dy: 20 });
      t0 = Date.now();
      cfg.onPanResponderRelease?.({}, { dx: 30, dy: 20 });
    });

    // Snackbar appears with the UNDO action and the move PATCH has fired.
    await screen.findByText("Shot moved");
    expect(screen.getByText("UNDO")).toBeTruthy();
    const movePatch = patchCalls.find(p => p.body.latitude !== undefined);
    expect(movePatch).toBeTruthy();
    const patchCountAtArm = patchCalls.length;

    // Lower bound: at ~4s after the drag the snackbar must STILL be
    // visible. Without this checkpoint a regression that shortened the
    // TTL (e.g. 5s → 1s) would slip through, since the upper-bound
    // waitFor only proves dismissal happens before 7s.
    const elapsed = () => Date.now() - t0;
    await new Promise<void>((resolve) => {
      const wait = Math.max(0, 4000 - elapsed());
      setTimeout(resolve, wait);
    });
    expect(screen.queryByText("Shot moved")).not.toBeNull();
    expect(screen.queryByText("UNDO")).not.toBeNull();

    // Upper bound: by ~7s the timer has fired and the snackbar is
    // gone. Together with the 4s checkpoint above, this brackets the
    // TTL to roughly [4s, 7s] around the documented 5s window.
    await waitFor(
      () => {
        expect(screen.queryByText("Shot moved")).toBeNull();
      },
      { timeout: Math.max(500, 7000 - elapsed()), interval: 100 },
    );

    // UNDO button is gone too.
    expect(screen.queryByText("UNDO")).toBeNull();

    // Auto-dismiss is silent — no extra revert PATCH should fire.
    expect(patchCalls.length).toBe(patchCountAtArm);
  }, 15000);
});
