/**
 * Component test: scorer-station Log shot flow (Task #1016).
 *
 * Drives the mobile scorer screen at the React level — mocks `fetch` so the
 * tournament/group/course-holes loads succeed and captures every POST to
 * /api/scorer/groups/:groupId/shots. Verifies that:
 *
 *   1. Tapping "Log shot" for a player, filling the modal and saving fires a
 *      POST with the right URL, method, bearer token and payload (playerId,
 *      holeNumber, shotNumber, shotType, club, lieType, round).
 *
 *   2. Re-opening the modal for the same player on the same hole auto-
 *      increments shotNumber (1 → 2) on the next POST.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

vi.mock("react-native-safe-area-context", () => {
  const React = require("react");
  return {
    SafeAreaView: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: async () => ({ status: "denied" }),
  getCurrentPositionAsync: async () => ({ coords: { latitude: 0, longitude: 0 } }),
  Accuracy: { Highest: 6 },
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1, organizationId: 9, role: "scorer" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({
    activeOrgId: 9,
    activeClub: { id: 9, name: "Test Club", slug: "test-club", subscriptionTier: "pro" },
    clubs: [],
    switchClub: async () => {},
    isSuperAdmin: false,
    canSwitchClub: false,
  }),
}));

import ScorerStationScreen from "../app/scorer-station/index";

const TOURNAMENT = {
  id: 42,
  name: "Spring Open",
  status: "active",
  currentRound: 2,
};

const GROUP = {
  groupId: 7,
  players: [
    { playerId: 11, name: "Alice Player", handicapIndex: "8.4" },
    { playerId: 12, name: "Bob Golfer", handicapIndex: null },
  ],
  startHole: 1,
  teeTime: null,
};

const GROUP_DETAIL = {
  ...GROUP,
  scores: [],
  currentHole: 1,
  tournamentId: 42,
  courseId: 5,
};

const COURSE_HOLES_RESPONSE = {
  holes: Array.from({ length: 18 }, (_, i) => ({
    holeNumber: i + 1,
    par: 4,
    handicap: i + 1,
    distance: 350,
  })),
  localRules: null,
  localRulesConfig: null,
};

interface ShotPost {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

let shotPosts: ShotPost[] = [];
let fetchMock: ReturnType<typeof buildFetchMock>;

function getHeader(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function buildFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/public/tournaments") && method === "GET") {
      return new Response(JSON.stringify([TOURNAMENT]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (/\/api\/scorer\/groups\?/.test(url) && method === "GET") {
      return new Response(JSON.stringify([GROUP]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (/\/api\/scorer\/groups\/\d+\?/.test(url) && method === "GET") {
      return new Response(JSON.stringify(GROUP_DETAIL), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/scorer/course-holes") && method === "GET") {
      return new Response(JSON.stringify(COURSE_HOLES_RESPONSE), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (/\/api\/scorer\/groups\/\d+\/shots/.test(url) && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      shotPosts.push({
        url,
        method,
        authorization: getHeader(init, "Authorization"),
        body,
      });
      return new Response(JSON.stringify({ ok: true, id: shotPosts.length }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

beforeEach(() => {
  shotPosts = [];
  fetchMock = buildFetchMock();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function navigateToScoring() {
  render(<ScorerStationScreen />);

  // 1. Tournament list — pick "Spring Open".
  const tournamentCard = await screen.findByText("Spring Open");
  await act(async () => {
    fireEvent.click(tournamentCard);
  });

  // 2. Group list — pick the only group (no teeTime → "Group 7" label).
  const groupCard = await screen.findByText("Group 7");
  await act(async () => {
    fireEvent.click(groupCard);
  });

  // 3. Wait for the scoring screen to render with player names.
  await waitFor(() => {
    expect(screen.getAllByText("Alice Player").length).toBeGreaterThan(0);
  });
}

async function fillAndSubmitShot(opts: { club: string; lie: string; type: string }) {
  // Pick the requested chips. Some chip labels (e.g. "tee") appear in both
  // the Type and Lie chip rows; we resolve by index — for this test we just
  // tap the explicit club / lie / type the caller asks for.
  const typeChip = screen.getAllByText(opts.type)[0];
  await act(async () => { fireEvent.click(typeChip); });

  const clubChip = screen.getByText(opts.club);
  await act(async () => { fireEvent.click(clubChip); });

  // The lie row is rendered after the club row; the same label may also exist
  // in Type, so pick the LAST occurrence to be sure we hit the Lie chip.
  const lieMatches = screen.getAllByText(opts.lie);
  const lieChip = lieMatches[lieMatches.length - 1];
  await act(async () => { fireEvent.click(lieChip); });

  const saveBtn = screen.getByText("Save shot");
  await act(async () => { fireEvent.click(saveBtn); });
}

describe("Scorer Station — log-shot flow (Task #1016)", () => {
  it("submits a shot with the correct URL, method, bearer token and payload", async () => {
    await navigateToScoring();

    // Open the modal for Alice via her "Log shot" button (first one).
    const logShotButtons = screen.getAllByText("Log shot");
    expect(logShotButtons.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      fireEvent.click(logShotButtons[0]);
    });

    // Modal title appears.
    await screen.findByText(/Log shot · Alice Player/);

    await fillAndSubmitShot({ type: "approach", club: "7i", lie: "rough" });

    await waitFor(() => {
      expect(shotPosts.length).toBe(1);
    });

    const post = shotPosts[0];
    expect(post.url).toContain("/api/scorer/groups/7/shots");
    expect(post.method).toBe("POST");
    expect(post.authorization).toBe("Bearer test-token");

    expect(post.body).toMatchObject({
      playerId: 11,
      holeNumber: 1,
      shotNumber: 1,
      shotType: "approach",
      club: "7i",
      lieType: "rough",
      round: 2,
    });
  });

  it("auto-increments shotNumber when the same player logs another shot on the same hole", async () => {
    await navigateToScoring();

    // First shot for Alice.
    await act(async () => {
      fireEvent.click(screen.getAllByText("Log shot")[0]);
    });
    await screen.findByText(/Log shot · Alice Player/);
    await fillAndSubmitShot({ type: "tee", club: "Dr", lie: "tee" });

    await waitFor(() => {
      expect(shotPosts.length).toBe(1);
    });
    expect(shotPosts[0].body.shotNumber).toBe(1);

    // Modal closes on success — re-open for Alice on the same hole.
    await waitFor(() => {
      expect(screen.queryByText(/Log shot · Alice Player/)).toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getAllByText("Log shot")[0]);
    });
    await screen.findByText(/Log shot · Alice Player/);

    await fillAndSubmitShot({ type: "approach", club: "8i", lie: "rough" });

    await waitFor(() => {
      expect(shotPosts.length).toBe(2);
    });
    const second = shotPosts[1];
    expect(second.body).toMatchObject({
      playerId: 11,
      holeNumber: 1,
      shotNumber: 2,
      shotType: "approach",
      club: "8i",
      lieType: "rough",
      round: 2,
    });
    expect(second.authorization).toBe("Bearer test-token");
    expect(second.url).toContain("/api/scorer/groups/7/shots");
  });
});
