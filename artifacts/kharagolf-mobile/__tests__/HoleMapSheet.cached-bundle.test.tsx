/**
 * Task #1333 — regression coverage for the offline course-bundle fallback in
 * <HoleMapSheet />.
 *
 * When the live `/courses/:courseId/holes-hazards` (or `holes-fairways`) call
 * fails mid-round, the sheet must:
 *   1. Project the cached AsyncStorage course bundle into the same
 *      hazard/fairway shape via `bundleToHazards` / `bundleToFairways`.
 *   2. Surface the "Offline · saved course data" banner so the player knows
 *      they're looking at pre-cached geometry rather than nothing at all.
 *
 * Conversely, when the live call succeeds the banner must NOT be shown.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

type SvgPrimitiveProps = React.SVGAttributes<Element> & { children?: ReactNode };

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

// AsyncStorage is shared between the test setup (priming a cached bundle)
// and the component-under-test (loading it back through `loadCachedCourseBundle`).
const memoryStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => Promise.resolve(memoryStore.get(k) ?? null),
    setItem: (k: string, v: string) => { memoryStore.set(k, v); return Promise.resolve(); },
    removeItem: (k: string) => { memoryStore.delete(k); return Promise.resolve(); },
    getAllKeys: () => Promise.resolve(Array.from(memoryStore.keys())),
  },
}));

type FetchPublicResponse = unknown;
type FetchPublicFn = (path: string) => Promise<FetchPublicResponse>;

vi.mock("@/utils/api", () => ({
  BASE_URL: "",
  fetchPublic: vi.fn<FetchPublicFn>(),
}));

import HoleMapSheet from "../components/HoleMapSheet";
import { fetchPublic } from "@/utils/api";
import { COURSE_BUNDLE_KEY_PREFIX } from "@/utils/courseBundle";

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

const COURSE_ID = 42;

function primeCachedBundle() {
  // A minimal-but-realistic bundle with one hazard polygon so the cached
  // fallback path actually has data to project.
  const bundle = {
    courseId: COURSE_ID,
    course: { id: COURSE_ID, name: "Cached Course", organizationId: 9 },
    holes: [{ courseId: COURSE_ID, holeNumber: 1, par: 4 }],
    geometry: [
      {
        courseId: COURSE_ID,
        holeNumber: 1,
        featureType: "hazard_water",
        geometry: {
          type: "Polygon",
          coordinates: [[
            [77.5945, 12.9717],
            [77.5946, 12.9717],
            [77.5946, 12.9718],
            [77.5945, 12.9718],
            [77.5945, 12.9717],
          ]],
        },
        label: "Pond",
      },
    ],
    roundContext: { tournamentId: null, leagueId: null, generalPlayRoundId: null, aiCaddieMode: "open" as const },
    cachedAt: new Date().toISOString(),
  };
  memoryStore.set(
    `${COURSE_BUNDLE_KEY_PREFIX}${COURSE_ID}`,
    JSON.stringify({ fetchedAt: Date.now(), bundle }),
  );
}

beforeEach(() => {
  memoryStore.clear();
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });

  // Open-meteo elevation + watch shot list etc. — return empty bodies so the
  // component never hangs on a real fetch.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ elevation: [800, 800, 800, 800] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("<HoleMapSheet /> — cached course bundle fallback (Task #1333)", () => {
  it("shows the 'saved course data' banner when /holes-hazards rejects and a bundle is cached", async () => {
    primeCachedBundle();
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path === "/map-config") return { token: null };
      if (path.endsWith("/holes-hazards")) throw new Error("offline");
      if (path.endsWith("/holes-fairways")) return [];
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
        courseId={COURSE_ID}
      />,
    );

    // Banner only appears once the fallback has resolved through the
    // AsyncStorage round-trip, so we wait rather than asserting synchronously.
    await waitFor(() => {
      expect(screen.getByText(/Offline · saved course data/i)).toBeInTheDocument();
    });
  });

  it("falls back via the bundle when /holes-fairways rejects too", async () => {
    primeCachedBundle();
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path === "/map-config") return { token: null };
      if (path.endsWith("/holes-hazards")) return [];
      if (path.endsWith("/holes-fairways")) throw new Error("offline");
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
        courseId={COURSE_ID}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Offline · saved course data/i)).toBeInTheDocument();
    });
  });

  it("does NOT show the cached banner when the live calls succeed", async () => {
    primeCachedBundle();
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path === "/map-config") return { token: null };
      if (path.endsWith("/holes-hazards")) return [];
      if (path.endsWith("/holes-fairways")) return [];
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
        courseId={COURSE_ID}
      />,
    );

    // Wait for the hazard / fairway fetches to flush before asserting the
    // banner is absent — otherwise we could pass simply by checking before
    // any fallback effect could fire.
    await waitFor(() => {
      expect(fetchPublicMock).toHaveBeenCalledWith(`/courses/${COURSE_ID}/holes-hazards`);
      expect(fetchPublicMock).toHaveBeenCalledWith(`/courses/${COURSE_ID}/holes-fairways`);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Offline · saved course data/i)).not.toBeInTheDocument();
  });

  it("stays silent when the live call fails AND no cached bundle is available", async () => {
    // Note: memoryStore is cleared in beforeEach, so no bundle is primed.
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path === "/map-config") return { token: null };
      if (path.endsWith("/holes-hazards")) throw new Error("offline");
      if (path.endsWith("/holes-fairways")) throw new Error("offline");
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
        courseId={COURSE_ID}
      />,
    );

    await waitFor(() => {
      expect(fetchPublicMock).toHaveBeenCalledWith(`/courses/${COURSE_ID}/holes-hazards`);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Offline · saved course data/i)).not.toBeInTheDocument();
  });
});
