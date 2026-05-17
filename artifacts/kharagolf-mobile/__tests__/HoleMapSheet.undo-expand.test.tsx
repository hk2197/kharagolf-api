/**
 * UI test: HoleMapSheet expandable undo history (Task #1366).
 *
 * After Task #1177 a player could undo their last 3 edits one at a time
 * in LIFO order (the snackbar showed only the most recent action plus a
 * "+N more" hint). Task #1366 makes the "+N more" badge tappable —
 * expanding the snackbar into a list of all pending edits in
 * chronological order, each with its own UNDO button so the player can
 * skip ahead and revert a specific older edit.
 *
 * This test mirrors the existing HoleMapSheet.undo.test.tsx setup
 * (PanResponder + react-native-svg + watch bridge mocks) and drives
 * three synthetic drags before exercising the new expand/per-entry-undo
 * flow.
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

function findShotPanConfig(): PanResponderConfig {
  const matches = panConfigs.filter(c =>
    c.onMoveShouldSetPanResponder?.({}, { dx: 0, dy: 0 }) === false &&
    c.onMoveShouldSetPanResponder?.({}, { dx: 10, dy: 10 }) === true,
  );
  if (matches.length === 0) throw new Error("No shot PanResponder registered");
  return matches[matches.length - 1];
}

async function performDrag(dx: number, dy: number) {
  await act(async () => {
    const cfg = findShotPanConfig();
    cfg.onPanResponderGrant?.({}, { dx: 0, dy: 0 });
    cfg.onPanResponderMove?.({}, { dx, dy });
    cfg.onPanResponderRelease?.({}, { dx, dy });
  });
}

describe("<HoleMapSheet /> — expandable undo history (Task #1366)", () => {
  it("expands the snackbar to a list and undoes a specific older edit, leaving the others intact", async () => {
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

    // Push three drags so the stack is at the cap and shows "+2 more".
    // The pre-drag lat/lng captured here will be the target the per-entry
    // undo for the OLDEST edit must restore.
    const beforeFirstDragLat = ORIG_LAT;
    const beforeFirstDragLng = ORIG_LNG;
    await performDrag(30, 20);
    await screen.findByText("Shot moved");

    await performDrag(-25, 15);
    await performDrag(18, -22);

    // Collapsed banner shows "+2 more" — three entries are pending.
    const moreBadge = await screen.findByText(/\+2 more/i);
    expect(moreBadge).toBeTruthy();

    // Tap the "+2 more" badge → list expands. The header shows
    // "Recent edits" and the snackbar now contains 3 UNDO buttons.
    fireEvent.click(moreBadge);
    await screen.findByText("Recent edits");

    // Three "Shot moved" rows are visible (one per entry).
    const rows = await screen.findAllByText("Shot moved");
    expect(rows.length).toBe(3);

    // Three per-entry UNDO buttons + the HIDE button — make sure UNDO
    // buttons are exactly 3 (the top-level UNDO action is replaced
    // by HIDE in the expanded view).
    const undoButtons = screen.getAllByText("UNDO");
    expect(undoButtons.length).toBe(3);
    expect(screen.getByText("HIDE")).toBeTruthy();

    // Tap the FIRST UNDO button — that's the OLDEST entry (chronological
    // order: 0 = oldest). The revert PATCH should restore the pre-first-
    // drag coordinates, NOT the current location.
    const beforeUndo = patchCalls.length;
    fireEvent.click(undoButtons[0]);

    await waitFor(() => {
      const undo = patchCalls.slice(beforeUndo).find(p =>
        Math.abs((p.body.latitude as number) - beforeFirstDragLat) < 1e-9 &&
        Math.abs((p.body.longitude as number) - beforeFirstDragLng) < 1e-9,
      );
      expect(undo).toBeTruthy();
    });

    // After removing the oldest entry the stack drops from 3 to 2. With
    // 2+ entries still pending the expanded list stays open so the player
    // can keep picking entries to revert — the row count drops to 2.
    await waitFor(() => {
      const remainingRows = screen.getAllByText("Shot moved");
      expect(remainingRows.length).toBe(2);
    });
    expect(screen.getByText("Recent edits")).toBeTruthy();
    // Two per-entry UNDO buttons remain — the third was consumed.
    expect(screen.getAllByText("UNDO").length).toBe(2);

    // Tap HIDE to collapse back to the single-entry banner with the "+1
    // more" hint, then drain the remaining two via the top-level UNDO.
    fireEvent.click(screen.getByText("HIDE"));
    await screen.findByText(/\+1 more/i);

    fireEvent.click(screen.getByText("UNDO"));
    await waitFor(() => expect(patchCalls.length).toBe(beforeUndo + 2));

    fireEvent.click(screen.getByText("UNDO"));
    await waitFor(() => expect(patchCalls.length).toBe(beforeUndo + 3));

    // Stack drained — snackbar disappears.
    await waitFor(() => {
      expect(screen.queryByText("Shot moved")).toBeNull();
    });
    expect(screen.queryByText("UNDO")).toBeNull();
  });

  it("shows a relative timestamp on each row in the expanded list (Task #1638)", async () => {
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

    // Push two drags so the snackbar can be expanded.
    await performDrag(30, 20);
    await screen.findByText("Shot moved");
    await performDrag(-25, 15);

    const moreBadge = await screen.findByText(/\+1 more/i);
    fireEvent.click(moreBadge);
    await screen.findByText("Recent edits");

    // Each of the two expanded rows should show a relative timestamp like
    // "0 seconds ago" / "in 0 seconds" so two adjacent same-label rows
    // can be told apart. Task #2059 routes this label through the shared
    // `formatRelativeTime` helper (Task #1659), which renders
    // Intl.RelativeTimeFormat output instead of the previous English-only
    // "Ns ago" / "just now" fragments.
    const timestamps = screen.getAllByText(
      /^(\d+ seconds? ago|in \d+ seconds?)$/,
    );
    expect(timestamps.length).toBe(2);
  });

  it("HIDE collapses the expanded list back to the single-entry banner", async () => {
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

    await performDrag(30, 20);
    await screen.findByText("Shot moved");
    await performDrag(-25, 15);

    // "+1 more" badge — tap to expand.
    const moreBadge = await screen.findByText(/\+1 more/i);
    fireEvent.click(moreBadge);

    await screen.findByText("Recent edits");
    expect(screen.getByText("HIDE")).toBeTruthy();

    // Tap HIDE — the expanded list collapses, the original "+1 more"
    // hint is back, and the top-level UNDO is restored.
    fireEvent.click(screen.getByText("HIDE"));

    await waitFor(() => {
      expect(screen.queryByText("Recent edits")).toBeNull();
    });
    await screen.findByText(/\+1 more/i);
    expect(screen.getByText("UNDO")).toBeTruthy();
    expect(screen.queryByText("HIDE")).toBeNull();
  });
});
