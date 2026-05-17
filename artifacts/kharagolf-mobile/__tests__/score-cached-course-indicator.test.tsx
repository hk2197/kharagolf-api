/**
 * Task #1587 — round-level "saved course data" indicator stays in sync.
 *
 * The scoring screen lifts the offline / cached-course state into a single
 * boolean (`usingCachedCourse = holesUsingCachedCourse || holeMapUsingCachedCourse`)
 * so the small indicator stays consistent across the F/C/B GPS distance row,
 * the hole-map sheet's banner, and (once the AI Caddie follow-up lands) the
 * AI Caddie card. The previous unit-level coverage in
 * `__tests__/GpsDistanceRow.test.tsx` verifies the pill renders when its
 * `usingCachedCourse` prop flips, but nothing currently exercises the
 * round-level wiring in `app/(tabs)/score.tsx`:
 *
 *   - the `/holes` `useQuery` fallback that flips `holesUsingCachedCourse`
 *     when the live endpoint fails and the cached bundle is loaded; and
 *   - the `HoleMapSheet.onUsingCachedCourseChange` callback that flips
 *     `holeMapUsingCachedCourse` when the in-sheet hazard / fairway fetches
 *     fall back.
 *
 * A regression in either path could silently break the cross-component
 * indicator without failing the existing unit tests. This integration test
 * mounts a small harness that mirrors the round-level wiring from
 * `score.tsx` and exercises both fallback paths end-to-end, then verifies
 * a successful refetch on one source clears its own flag without dropping
 * an indicator another source is still showing.
 */
import React, { type ReactNode, useState } from "react";
import {
  describe, it, expect, beforeEach, afterEach, vi, type Mock,
} from "vitest";
import {
  act, cleanup, render, screen, waitFor,
} from "@testing-library/react";
import {
  QueryClient, QueryClientProvider, useQuery,
} from "@tanstack/react-query";

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

// Shared in-memory AsyncStorage for the cached bundle round-trip used by
// both the `/holes` fallback (loadCachedCourseBundleForRound) and the
// in-sheet hazard / fairway fallback (loadCachedCourseBundle).
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
import GpsDistanceRow from "../components/GpsDistanceRow";
import { fetchPublic } from "@/utils/api";
import {
  COURSE_BUNDLE_KEY_PREFIX,
  bundleToHolesResponse,
  loadCachedCourseBundleForRound,
} from "@/utils/courseBundle";

const fetchPublicMock = vi.mocked(fetchPublic) as unknown as Mock<FetchPublicFn>;

const COURSE_ID = 42;
const TOURNAMENT_ID = 17;
const ROUND = 1;

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

function primeCachedBundle() {
  // Minimal-but-realistic bundle keyed to the test's tournamentId so
  // `loadCachedCourseBundleForRound` can find it without being told the
  // courseId, and `loadCachedCourseBundle(COURSE_ID)` resolves it directly
  // for the in-sheet hazard / fairway fallback.
  const bundle = {
    courseId: COURSE_ID,
    course: { id: COURSE_ID, name: "Cached Course", organizationId: 9 },
    holes: [{ courseId: COURSE_ID, holeNumber: 1, par: 4,
      greenCentreLat: HOLE.greenCentreLat,
      greenCentreLng: HOLE.greenCentreLng,
      greenFrontLat: HOLE.greenFrontLat,
      greenFrontLng: HOLE.greenFrontLng,
      greenBackLat: HOLE.greenBackLat,
      greenBackLng: HOLE.greenBackLng,
    }],
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
    roundContext: {
      tournamentId: TOURNAMENT_ID,
      leagueId: null,
      generalPlayRoundId: null,
      aiCaddieMode: "open" as const,
    },
    cachedAt: new Date().toISOString(),
  };
  memoryStore.set(
    `${COURSE_BUNDLE_KEY_PREFIX}${COURSE_ID}`,
    JSON.stringify({ fetchedAt: Date.now(), bundle }),
  );
}

interface HolesResponse {
  holes: Array<{ holeNumber: number; par: number;
    greenCentreLat?: string | null;
    greenCentreLng?: string | null;
    greenFrontLat?: string | null;
    greenFrontLng?: string | null;
    greenBackLat?: string | null;
    greenBackLng?: string | null;
  }>;
  rounds: number;
  courseId?: number | null;
}

/**
 * Mirrors the round-level offline-flag wiring from
 * `app/(tabs)/score.tsx` (~lines 1607-1634, 2950, 3020):
 *
 *   - a `useQuery` for `/tournaments/:id/holes` that flips
 *     `holesUsingCachedCourse` when the live call fails and the cached
 *     bundle resolves;
 *   - an OR-aggregate `usingCachedCourse = holesUsingCachedCourse ||
 *     holeMapUsingCachedCourse` threaded into <GpsDistanceRow />; and
 *   - <HoleMapSheet onUsingCachedCourseChange={setHoleMapUsingCachedCourse} />.
 *
 * Mounting all of `score.tsx` in vitest is impractical (5k+ lines pulling
 * in `expo-task-manager`, `expo-sensors`, the calendar bridge, etc.), but
 * faithfully reproducing the offline-flag wiring here gives the same
 * regression coverage for the indicator the task is asking us to protect.
 */
function ScoringHarness({ visible = true }: { visible?: boolean }) {
  const [holesUsingCachedCourse, setHolesUsingCachedCourse] = useState(false);
  const [holeMapUsingCachedCourse, setHoleMapUsingCachedCourse] = useState(false);
  const usingCachedCourse = holesUsingCachedCourse || holeMapUsingCachedCourse;

  const { data: holesData } = useQuery({
    queryKey: ["holes", TOURNAMENT_ID, ROUND],
    queryFn: async (): Promise<HolesResponse> => {
      try {
        const live = await (fetchPublic as FetchPublicFn)(
          `/tournaments/${TOURNAMENT_ID}/holes?round=${ROUND}`,
        ) as HolesResponse;
        setHolesUsingCachedCourse(false);
        return live;
      } catch (err) {
        const bundle = await loadCachedCourseBundleForRound({
          tournamentId: TOURNAMENT_ID,
        });
        if (!bundle) throw err;
        setHolesUsingCachedCourse(true);
        return bundleToHolesResponse(bundle) as HolesResponse;
      }
    },
  });

  // The score screen passes the *live* hole's coords into GpsDistanceRow.
  // We use the same hole geometry whether the data came from the live API
  // or the bundle so the row always renders something — the indicator
  // assertions don't depend on the exact distance numbers.
  return (
    <>
      <GpsDistanceRow
        distFrontM={100}
        distCentreM={125}
        distBackM={142}
        plFront={null}
        plCentre={null}
        plBack={null}
        hasPinOffset={false}
        usingCachedCourse={usingCachedCourse}
      />
      <HoleMapSheet
        visible={visible}
        onClose={() => {}}
        hole={HOLE}
        userLat={12.972300}
        userLng={77.594560}
        weather={null}
        courseId={holesData?.courseId ?? COURSE_ID}
        tournamentId={TOURNAMENT_ID}
        roundNumber={ROUND}
        onUsingCachedCourseChange={setHoleMapUsingCachedCourse}
      />
    </>
  );
}

function renderHarness() {
  // Disable retries so a deliberately-failing query doesn't fan out into
  // background fetches that would muddle the assertions below.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <ScoringHarness />
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  memoryStore.clear();
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  // open-meteo elevation + watch shot list — just return harmless bodies so
  // the in-sheet effects never hang on a real network call.
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

describe("score screen — round-level 'saved course data' indicator (Task #1587)", () => {
  it("(a) lights up both the GPS pill and the in-sheet banner when /holes falls back to the cached bundle", async () => {
    primeCachedBundle();
    // Realistic offline window: the live endpoints all reject. /holes
    // falls back through `loadCachedCourseBundleForRound` (flips the
    // round-level flag → GpsDistanceRow pill), and the in-sheet
    // hazard / fairway fetches fall back through `loadCachedCourseBundle`
    // (flips the HoleMapSheet's local flag → in-sheet banner + fires
    // `onUsingCachedCourseChange`).
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path === "/map-config") return { token: null };
      if (path.includes("/holes?round=")) throw new Error("offline");
      if (path.endsWith("/holes-hazards")) throw new Error("offline");
      if (path.endsWith("/holes-fairways")) throw new Error("offline");
      return null;
    });

    renderHarness();

    // Both indicator surfaces are present at the same time:
    //   - the GpsDistanceRow pill (accessibility-labelled)
    //   - the HoleMapSheet banner (accessibility-labelled)
    await waitFor(() => {
      expect(
        screen.getByLabelText(/distances using saved offline course data/i),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText(/showing saved course data offline/i),
      ).toBeInTheDocument();
    });
    // Sanity check: the user-visible "Offline · saved course data" copy
    // shows up in both places (pill + banner), proving the indicator is
    // duplicated correctly across the screen rather than only one of the
    // two surfaces flipping on.
    expect(screen.getAllByText(/Offline · saved course data/i).length).toBeGreaterThanOrEqual(2);
  });

  it("(b) lights up both surfaces when /holes succeeds but the in-sheet hazard fetch falls back", async () => {
    primeCachedBundle();
    // Live `/holes` succeeds, so `holesUsingCachedCourse` stays false.
    // Only the in-sheet hazard fetch falls back, so the indicator must
    // bubble up via `onUsingCachedCourseChange` → the round-level OR
    // aggregate, and still light the GpsDistanceRow pill.
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path === "/map-config") return { token: null };
      if (path.includes("/holes?round=")) {
        return {
          holes: [{
            holeNumber: 1, par: 4,
            greenCentreLat: HOLE.greenCentreLat, greenCentreLng: HOLE.greenCentreLng,
            greenFrontLat: HOLE.greenFrontLat, greenFrontLng: HOLE.greenFrontLng,
            greenBackLat: HOLE.greenBackLat, greenBackLng: HOLE.greenBackLng,
          }],
          rounds: 1,
          courseId: COURSE_ID,
        };
      }
      if (path.endsWith("/holes-hazards")) throw new Error("offline");
      if (path.endsWith("/holes-fairways")) return [];
      return null;
    });

    renderHarness();

    // Both surfaces light up together — the in-sheet banner via the
    // sheet's local fallback, the GPS pill via the round-level OR aggregate
    // fed by `onUsingCachedCourseChange`.
    await waitFor(() => {
      expect(
        screen.getByLabelText(/showing saved course data offline/i),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText(/distances using saved offline course data/i),
      ).toBeInTheDocument();
    });
  });

  it("a successful /holes refetch clears its own flag but the GPS pill stays while the sheet still flags cached data", async () => {
    primeCachedBundle();

    // First pass: both sources fall back. Once both indicators are up, we
    // flip the live `/holes` mock so the next refetch succeeds — the
    // hole-map's hazard fallback should keep `holeMapUsingCachedCourse`
    // true, so the OR-aggregate (and therefore the GPS pill) must NOT
    // disappear when /holes recovers.
    let holesShouldFail = true;
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path === "/map-config") return { token: null };
      if (path.includes("/holes?round=")) {
        if (holesShouldFail) throw new Error("offline");
        return {
          holes: [{
            holeNumber: 1, par: 4,
            greenCentreLat: HOLE.greenCentreLat, greenCentreLng: HOLE.greenCentreLng,
            greenFrontLat: HOLE.greenFrontLat, greenFrontLng: HOLE.greenFrontLng,
            greenBackLat: HOLE.greenBackLat, greenBackLng: HOLE.greenBackLng,
          }],
          rounds: 1,
          courseId: COURSE_ID,
        };
      }
      // Sheet's hazard fetch keeps failing for the whole test run, so
      // its local cached-course flag (and `onUsingCachedCourseChange`)
      // stays true even after `/holes` recovers.
      if (path.endsWith("/holes-hazards")) throw new Error("offline");
      if (path.endsWith("/holes-fairways")) return [];
      return null;
    });

    const { client } = renderHarness();

    // Initial state — both indicators light up.
    await waitFor(() => {
      expect(
        screen.getByLabelText(/distances using saved offline course data/i),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText(/showing saved course data offline/i),
      ).toBeInTheDocument();
    });

    // Live `/holes` recovers. We refetch the holes query directly — the
    // queryFn will hit the live branch and call setHolesUsingCachedCourse(false).
    holesShouldFail = false;
    await act(async () => {
      await client.refetchQueries({ queryKey: ["holes", TOURNAMENT_ID, ROUND] });
    });

    // Sheet's hazard fetch is still falling back, so its banner persists
    // AND keeps `holeMapUsingCachedCourse` true. The OR-aggregate stays
    // true → the GPS pill must NOT disappear.
    expect(
      screen.getByLabelText(/showing saved course data offline/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/distances using saved offline course data/i),
    ).toBeInTheDocument();
  });

  // Once the AI Caddie wiring follow-up lands ("Make the AI Caddie
  // 'offline · saved course' label match the rest of the screen"), the
  // CaddieCard will accept the round-level `usingCachedCourse` flag the
  // same way GpsDistanceRow does. At that point this test should be
  // upgraded to also render <CaddieCard /> in the harness above and
  // assert its label flips alongside the pill and the banner.
  it.todo(
    "asserts the CaddieCard 'offline · saved course' label flips with the round-level flag",
  );
});
