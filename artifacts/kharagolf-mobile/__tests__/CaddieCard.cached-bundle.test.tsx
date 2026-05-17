/**
 * Task #1333 — regression coverage for the offline course-bundle indicator
 * inside <CaddieCard />.
 *
 * When `/caddie/recommend` fails the card falls back to its per-bucket
 * AsyncStorage cache. Independently, it probes for a cached course bundle so
 * the small "offline" pill upgrades to "offline · saved course" — that
 * promises the player the distances/aim still come from authoritative
 * pre-cached geometry, not just a stale guess.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// Shared in-memory AsyncStorage used both for priming the cached recommendation
// + course bundle and for the component's read paths.
const memoryStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => Promise.resolve(memoryStore.get(k) ?? null),
    setItem: (k: string, v: string) => { memoryStore.set(k, v); return Promise.resolve(); },
    removeItem: (k: string) => { memoryStore.delete(k); return Promise.resolve(); },
    getAllKeys: () => Promise.resolve(Array.from(memoryStore.keys())),
  },
}));

// Make `fetchPortal` controllable per-test. ConsentRequiredError stays a
// real class so the catch branch differentiates it correctly.
vi.mock("@/utils/api", async () => {
  class ConsentRequiredError extends Error {
    category: string;
    constructor(category: string, message: string) {
      super(message);
      this.name = "ConsentRequiredError";
      this.category = category;
    }
  }
  return {
    BASE_URL: "",
    fetchPortal: vi.fn(),
    ConsentRequiredError,
  };
});

// Caddie offline helper — the cache hit-path exercised here doesn't reach
// the local recommender or the feedback queue, but the imports must resolve.
vi.mock("@/utils/caddieOffline", () => ({
  computeLocalRecommendation: vi.fn(() => null),
  loadSnapshot: vi.fn(async () => null),
  sendOrQueueFeedback: vi.fn(async () => {}),
}));

vi.mock("@/components/ConsentPrompt", () => ({
  __esModule: true,
  default: () => null,
}));

import CaddieCard, { type CaddieRecommendationData } from "../components/CaddieCard";
import { fetchPortal } from "@/utils/api";
import { COURSE_BUNDLE_KEY_PREFIX } from "@/utils/courseBundle";

const fetchPortalMock = vi.mocked(fetchPortal);

const COURSE_ID = 7;
const HOLE_NUMBER = 1;
const ROUND = 1;
const TOURNAMENT_ID = 11;
const DIST_BUCKET = 100; // distanceYards = 100 → bucket = 100
const ELEV_BUCKET = 0;
const LIE_KEY = "";

const REC_CACHE_KEY = `kharagolf_caddie_rec_v1:t${TOURNAMENT_ID}/r${ROUND}/h${HOLE_NUMBER}/d${DIST_BUCKET}/e${ELEV_BUCKET}/l${LIE_KEY}`;

const cachedRec: CaddieRecommendationData = {
  recommendationId: 99,
  distanceYards: 100,
  effectiveDistance: 100,
  windAdjustmentYards: 0,
  headwindComponent: 0,
  crosswindComponent: 0,
  lateralStddevYards: 5,
  aimOffsetYards: { forward: 0, lateral: 0 },
  aimLatLngOffset: null,
  rankedClubs: [
    { club: "PW", carry: 100, stddev: 5, shotCount: 30, source: "shots", onGreenProb: 0.7, surplusYards: 0 },
  ],
  recommended: { club: "PW", carryYards: 100, stddev: 5, onGreenProb: 0.7, shotCount: 30 },
  alternate: null,
  rationale: ["Cached recommendation"],
  usingFallback: false,
  missBiasLateralYards: 0,
};

function primeRecCache() {
  memoryStore.set(REC_CACHE_KEY, JSON.stringify({ ...cachedRec, _cachedAt: Date.now() }));
}

function primeCourseBundle() {
  const bundle = {
    courseId: COURSE_ID,
    course: { id: COURSE_ID, name: "Cached Course", organizationId: 9 },
    holes: [{ courseId: COURSE_ID, holeNumber: 1, par: 4 }],
    geometry: [],
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

beforeEach(() => {
  memoryStore.clear();
  fetchPortalMock.mockReset();
});

afterEach(() => {
  cleanup();
});

const baseProps = {
  token: "tkn",
  distanceYards: 100,
  windSpeedKmh: 0,
  windDirectionDeg: 0,
  bearingToPinDeg: 0,
  pinLat: 12.97,
  elevationDeltaYards: 0,
  lieType: null,
  holeNumber: HOLE_NUMBER,
  round: ROUND,
  tournamentId: TOURNAMENT_ID,
  generalPlayRoundId: null,
};

describe("<CaddieCard /> — offline course-bundle pill (Task #1333)", () => {
  it("shows 'offline · saved course' when the live call fails and a course bundle is cached", async () => {
    primeRecCache();
    primeCourseBundle();
    fetchPortalMock.mockRejectedValue(new Error("offline"));

    render(<CaddieCard {...baseProps} courseId={COURSE_ID} />);

    // Wait for the catch branch to read from the rec cache + bundle and
    // re-render the header pill.
    await waitFor(() => {
      expect(screen.getByText(/offline · saved course/i)).toBeInTheDocument();
    });
    // The plain "offline" tag must not double-render.
    const tags = screen.queryAllByText(/^offline$/i);
    expect(tags).toHaveLength(0);
  });

  it("shows the plain 'offline' pill when no cached course bundle is available", async () => {
    primeRecCache();
    // No primeCourseBundle() — the bundle probe must come back empty.
    fetchPortalMock.mockRejectedValue(new Error("offline"));

    render(<CaddieCard {...baseProps} courseId={COURSE_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/^offline$/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/offline · saved course/i)).not.toBeInTheDocument();
  });

  it("upgrades to 'offline · saved course' via roundContext when no courseId is supplied", async () => {
    primeRecCache();
    primeCourseBundle(); // its roundContext.tournamentId matches baseProps.tournamentId
    fetchPortalMock.mockRejectedValue(new Error("offline"));

    // courseId omitted → loadCachedCourseBundleForRound takes the slow path
    // and matches by tournamentId.
    render(<CaddieCard {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText(/offline · saved course/i)).toBeInTheDocument();
    });
  });

  it("does not show any offline pill when the live call succeeds", async () => {
    primeCourseBundle(); // even with a bundle present, no offline indicator should render
    fetchPortalMock.mockResolvedValue({
      ...cachedRec,
      recommendationId: 1,
      rationale: ["Live recommendation"],
    });

    render(<CaddieCard {...baseProps} courseId={COURSE_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/Recommended/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  });

  // Task #1586 — when the parent screen passes the round-level
  // `usingCachedCourse` signal it must take priority over the local probe so
  // the AI Caddie pill matches the distance row + hole-map indicators.
  it("uses the round-level prop over the local probe (true → 'offline · saved course')", async () => {
    primeRecCache();
    // No primeCourseBundle() → the local probe would otherwise come back
    // empty, but the parent prop flips the pill anyway.
    fetchPortalMock.mockRejectedValue(new Error("offline"));

    render(<CaddieCard {...baseProps} courseId={COURSE_ID} usingCachedCourse={true} />);

    await waitFor(() => {
      expect(screen.getByText(/offline · saved course/i)).toBeInTheDocument();
    });
  });

  it("uses the round-level prop over the local probe (false → plain 'offline')", async () => {
    primeRecCache();
    primeCourseBundle(); // local probe would say true, but the parent prop overrides
    fetchPortalMock.mockRejectedValue(new Error("offline"));

    render(<CaddieCard {...baseProps} courseId={COURSE_ID} usingCachedCourse={false} />);

    await waitFor(() => {
      expect(screen.getByText(/^offline$/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/offline · saved course/i)).not.toBeInTheDocument();
  });
});
