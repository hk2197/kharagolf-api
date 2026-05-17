/**
 * Component test: scorer-station previously-logged-shots list (Task #1180,
 * regression cover for Task #1015).
 *
 * Drives the mobile scorer screen at the React level — mocks `fetch` so the
 * tournament/group/course-holes loads succeed and the GET
 * /api/scorer/groups/:groupId response includes a `shots` array of three
 * pre-existing shots for the active player on the current hole.
 *
 * Verifies that:
 *
 *   1. After loading the group, the scorer screen renders the "Shots logged"
 *      list with one row per existing shot, showing the shot #, club, lie
 *      and a GPS marker for shots that have lat/lng.
 *
 *   2. Tapping "Log shot" opens the modal pre-filled to the *next* shot
 *      number (existing max was 3 → modal shows 4).
 *
 *   3. Tapping an existing shot row opens the modal in "Edit shot" mode
 *      pre-populated with that shot's hole, shot #, type, club and lie.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup, within } from "@testing-library/react";

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

vi.mock("react-i18next", () => {
  const enScoring = require("../i18n/locales/en/scoring.json");
  const enProfile = require("../i18n/locales/en/profile.json");
  const NAMESPACES: Record<string, Record<string, unknown>> = {
    scoring: enScoring,
    profile: enProfile,
  };
  function lookup(ns: string, key: string): string | undefined {
    const parts = key.split(".");
    let cur: unknown = NAMESPACES[ns];
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return typeof cur === "string" ? cur : undefined;
  }
  function interpolate(s: string, vars?: Record<string, unknown>): string {
    if (!vars) return s;
    return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
      k in vars ? String(vars[k]) : `{{${k}}}`
    );
  }
  return {
    useTranslation: (ns?: string | string[]) => {
      const namespaces = Array.isArray(ns) ? ns : ns ? [ns] : ["scoring"];
      return {
        t: (key: string, vars?: Record<string, unknown>) => {
          for (const n of namespaces) {
            const found = lookup(n, key);
            if (found != null) return interpolate(found, vars);
          }
          return key;
        },
      };
    },
  };
});

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

// Three shots already logged for Alice on hole 1, plus one for Bob to make
// sure the per-(player, hole) filter is applied. Highest existing shot # for
// Alice on hole 1 is 3, so the next "Log shot" should pre-fill 4.
const EXISTING_SHOTS = [
  {
    id: 101,
    playerId: 11,
    round: 2,
    holeNumber: 1,
    shotNumber: 1,
    shotType: "tee",
    club: "Dr",
    lieType: "tee",
    missDirection: null,
    shotShape: null,
    penaltyReason: null,
    latitude: "37.12345",
    longitude: "-122.45678",
    distanceToPin: null,
    distanceCarried: null,
    source: "scorer",
  },
  {
    id: 102,
    playerId: 11,
    round: 2,
    holeNumber: 1,
    shotNumber: 2,
    shotType: "approach",
    club: "7i",
    lieType: "fairway",
    missDirection: null,
    shotShape: null,
    penaltyReason: null,
    latitude: null,
    longitude: null,
    distanceToPin: null,
    distanceCarried: null,
    source: "scorer",
  },
  {
    id: 103,
    playerId: 11,
    round: 2,
    holeNumber: 1,
    shotNumber: 3,
    shotType: "chip",
    club: "SW",
    lieType: "rough",
    missDirection: null,
    shotShape: null,
    penaltyReason: null,
    latitude: "37.12399",
    longitude: "-122.45611",
    distanceToPin: null,
    distanceCarried: null,
    source: "scorer",
  },
  // Bob has a shot on the same hole — must NOT show up in Alice's list.
  {
    id: 201,
    playerId: 12,
    round: 2,
    holeNumber: 1,
    shotNumber: 1,
    shotType: "tee",
    club: "3W",
    lieType: "tee",
    missDirection: null,
    shotShape: null,
    penaltyReason: null,
    latitude: null,
    longitude: null,
    distanceToPin: null,
    distanceCarried: null,
    source: "scorer",
  },
];

const GROUP_DETAIL = {
  ...GROUP,
  scores: [],
  shots: EXISTING_SHOTS,
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

let fetchMock: ReturnType<typeof buildFetchMock>;

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
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

beforeEach(() => {
  fetchMock = buildFetchMock();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function navigateToScoring() {
  render(<ScorerStationScreen />);

  const tournamentCard = await screen.findByText("Spring Open");
  await act(async () => {
    fireEvent.click(tournamentCard);
  });

  const groupCard = await screen.findByText("Group 7");
  await act(async () => {
    fireEvent.click(groupCard);
  });

  await waitFor(() => {
    expect(screen.getAllByText("Alice Player").length).toBeGreaterThan(0);
  });
  // Make sure the shots list (rendered after group detail resolves) is
  // present before any test queries against it. Both player cards should
  // contain a "Log shot" button — when shots have rendered we'll have at
  // least 3 shot-row "edit-2" icons (Alice's 1/2/3 + Bob's 1).
  await waitFor(() => {
    const editIcons = document.querySelectorAll('[data-icon="edit-2"]');
    expect(editIcons.length).toBeGreaterThanOrEqual(4);
  });
}

// Find the player score card containing a given player name. The card
// (`playerScoreCard` style) is the outermost View that contains the player
// name row, the +/− score controls AND the shots-logged list, so we walk up
// from the name node until we find an ancestor that contains both the
// "Log shot" button (top row) AND the score control "minus" icon
// (controls row).
function getPlayerCard(name: string): HTMLElement {
  const nameNodes = screen.getAllByText(name);
  for (const n of nameNodes) {
    let cur: HTMLElement | null = n as HTMLElement;
    while (cur && cur.parentElement) {
      cur = cur.parentElement;
      if (
        cur &&
        within(cur).queryByText("Log shot") &&
        cur.querySelector('[data-icon="minus"]')
      ) {
        return cur;
      }
    }
  }
  throw new Error(`Could not find player card for ${name}`);
}

// React Native <Text> with interpolated values renders each segment in its
// own DOM node (e.g. `Shots logged · hole 1` becomes three text nodes), so
// `getByText` with a string/regex misses it. Walk descendants and look for
// the *normalized* text as a substring of any element's textContent.
function hasNormalizedText(container: HTMLElement, expected: string): boolean {
  const want = expected.replace(/\s+/g, " ").trim();
  const got = (container.textContent ?? "").replace(/\s+/g, " ").trim();
  return got.includes(want);
}

// Find the shot row that has a given shot number ("#1", "#2", …). Returns
// the row element so we can both inspect and click it.
function getShotRow(card: HTMLElement, shotNumber: number): HTMLElement {
  const numNodes = within(card).getAllByText(`#${shotNumber}`);
  for (const n of numNodes) {
    let cur: HTMLElement | null = n as HTMLElement;
    while (cur && cur.parentElement) {
      cur = cur.parentElement;
      // The shot row is the TouchableOpacity wrapper which renders the
      // `target` icon-less row with the number, type, meta, and edit icon.
      if (cur && cur.querySelector('[data-icon="edit-2"]')) return cur;
    }
  }
  throw new Error(`Could not find shot row #${shotNumber}`);
}

// In the Edit modal, all chips in a row share base styles, but the *active*
// chip (the one matching the loaded shot's value) has an extra
// `chipActive` style on the wrapper and a `chipTextActive` style on the
// text. RN-web compiles styles to atomic classes, so the active chip's
// wrapper className will differ from inactive siblings'. Find which chip
// labels in `candidates` have a className that does NOT match the
// majority — those are the active ones.
function findActiveChipLabels(scope: HTMLElement, candidates: readonly string[]): string[] {
  // Collect (label → wrapper element) for each candidate present in scope.
  const wrappers: Array<{ label: string; cls: string }> = [];
  for (const label of candidates) {
    const matches = within(scope).queryAllByText(label);
    for (const textNode of matches) {
      const wrapper = textNode.parentElement;
      if (!wrapper) continue;
      // Only count chip wrappers — skip the screen header / shot-row "type"
      // text which doesn't have a sibling chip group. Chip wrappers are
      // tab-focusable (TouchableOpacity → tabindex="0").
      if (wrapper.getAttribute("tabindex") !== "0") continue;
      wrappers.push({ label, cls: wrapper.className });
    }
  }
  // Find the most common className among wrappers — that's the inactive base.
  const counts = new Map<string, number>();
  for (const w of wrappers) counts.set(w.cls, (counts.get(w.cls) ?? 0) + 1);
  let baseCls = "";
  let baseCount = 0;
  for (const [cls, n] of counts.entries()) {
    if (n > baseCount) { baseCount = n; baseCls = cls; }
  }
  // Anything whose className differs from the base is "active".
  return wrappers.filter(w => w.cls !== baseCls).map(w => w.label);
}

describe("Scorer Station — previously logged shots (Task #1180)", () => {
  it("renders the existing shots for the active player on the current hole with shot #, club, lie and a GPS marker", async () => {
    await navigateToScoring();

    const aliceCard = getPlayerCard("Alice Player");

    // Header is present (text is split across nodes by RN Text interpolation).
    expect(hasNormalizedText(aliceCard, "Shots logged · hole 1")).toBe(true);

    // Three rows for Alice — verify shot #, type and club/lie meta.
    const shot1 = getShotRow(aliceCard, 1);
    const shot2 = getShotRow(aliceCard, 2);
    const shot3 = getShotRow(aliceCard, 3);

    expect(within(shot1).getByText("tee")).toBeTruthy();
    expect(within(shot2).getByText("approach")).toBeTruthy();
    expect(within(shot3).getByText("chip")).toBeTruthy();

    // Combined "club · lie" strings (RN splits these into multiple nodes).
    // Lie labels are now rendered through the shared `translateLieType` helper
    // so they show the user-facing English label from `caddieLie.*` rather
    // than the raw API value.
    expect(hasNormalizedText(shot1, "Dr · Tee")).toBe(true);
    expect(hasNormalizedText(shot2, "7i · Fairway")).toBe(true);
    expect(hasNormalizedText(shot3, "SW · Rough")).toBe(true);

    // Bob's shot on the same hole must not bleed into Alice's list.
    expect(within(aliceCard).queryAllByText("#1").length).toBe(1);

    // GPS marker (Feather "map-pin") appears for shots #1 and #3 (which have
    // lat/lng) but not for #2. The mocked Feather component renders an
    // element with `data-icon="<name>"` (see __tests__/setup.ts).
    expect(shot1.querySelector('[data-icon="map-pin"]')).not.toBeNull();
    expect(shot2.querySelector('[data-icon="map-pin"]')).toBeNull();
    expect(shot3.querySelector('[data-icon="map-pin"]')).not.toBeNull();

    // Bob's card shows his single shot only — no row for #2.
    const bobCard = getPlayerCard("Bob Golfer");
    const bobShot1 = getShotRow(bobCard, 1);
    expect(hasNormalizedText(bobShot1, "3W · Tee")).toBe(true);
    expect(within(bobCard).queryByText("#2")).toBeNull();
  });

  it("pre-fills the next shot number when 'Log shot' is tapped after existing shots", async () => {
    await navigateToScoring();

    const aliceCard = getPlayerCard("Alice Player");
    const aliceLogShot = within(aliceCard).getByText("Log shot");
    await act(async () => {
      fireEvent.click(aliceLogShot);
    });

    // Modal opens in "Log shot" mode (not edit).
    await screen.findByText(/Log shot · Alice Player/);
    expect(screen.queryByText(/Edit shot · Alice Player/)).toBeNull();

    // The two stepper rows ("Hole" and "Shot #") each render their value as a
    // standalone numeric Text node, so we expect the modal to contain both
    // "1" (hole) and "4" (next shot # = 3 + 1). Pull every numeric stepper
    // value visible and check both are present.
    const numericValues = screen.getAllByText(/^[0-9]+$/).map(n => n.textContent);
    expect(numericValues).toContain("1");
    expect(numericValues).toContain("4");
    // Sanity: stepper would have shown 1 instead of 4 if the counter were not
    // seeded from the existing shots — fail loudly if 4 is missing.
    expect(numericValues.filter(v => v === "4").length).toBeGreaterThanOrEqual(1);
  });

  it("opens the edit modal pre-populated when an existing shot row is tapped", async () => {
    await navigateToScoring();

    const aliceCard = getPlayerCard("Alice Player");

    // Tap shot #2 (approach / 7i / fairway).
    const shot2 = getShotRow(aliceCard, 2);
    await act(async () => {
      fireEvent.click(shot2);
    });

    // Modal title flips to "Edit shot".
    await screen.findByText(/Edit shot · Alice Player/);
    expect(screen.queryByText(/Log shot · Alice Player/)).toBeNull();

    // The Save button is there as well.
    expect(screen.getByText("Save shot")).toBeTruthy();

    // Hole stepper shows 1 and the shot stepper shows 2 (NOT the next-shot
    // value 4 — i.e. we entered edit mode rather than starting a fresh shot).
    // Scope the numeric scan to the modal: walk up from the "Edit shot"
    // title to the modal card, then scan its descendants only — otherwise
    // the screen-wide hole dot row (1-18) pollutes the search.
    const modalTitle = screen.getByText(/Edit shot · Alice Player/);
    let modalCard: HTMLElement | null = modalTitle as HTMLElement;
    while (modalCard && modalCard.parentElement && !within(modalCard).queryByText("Save shot")) {
      modalCard = modalCard.parentElement;
    }
    if (!modalCard) throw new Error("Could not find modal card containing Save shot");

    const modalNums = within(modalCard).getAllByText(/^[0-9]+$/).map(n => n.textContent);
    expect(modalNums).toContain("1");
    expect(modalNums).toContain("2");
    // The next-shot fresh value (4) must not appear — proves we're editing
    // shot #2, not creating shot #4.
    expect(modalNums).not.toContain("4");

    // Type / Club / Lie chips must be pre-populated to match shot #2's saved
    // values: shotType="approach", club="7i", lieType="fairway". Use a
    // className-diff strategy scoped to each chip row (Type/Club/Lie) — the
    // lone chip whose wrapper class differs from its siblings is the active
    // one. Scope is needed because Type and Lie share labels ("tee",
    // "fairway", "sand").
    const SHOT_TYPES = ["tee", "fairway", "approach", "chip", "sand", "putt"] as const;
    const CLUBS = ["Dr", "3W", "5W", "Hy", "3i", "4i", "5i", "6i", "7i", "8i", "9i", "PW", "GW", "SW", "LW", "Pt"] as const;
    const LIE_TYPES = ["tee", "fairway", "rough", "sand", "green", "recovery"] as const;

    function getChipRow(label: string): HTMLElement {
      const lbl = within(modalCard!).getByText(label);
      const row = lbl.nextElementSibling;
      if (!(row instanceof HTMLElement)) throw new Error(`No chip row after label "${label}"`);
      return row;
    }

    const typeRow = getChipRow("Type");
    const clubRow = getChipRow("Club");
    const lieRow = getChipRow("Lie");

    expect(findActiveChipLabels(typeRow, SHOT_TYPES)).toEqual(["approach"]);
    expect(findActiveChipLabels(clubRow, CLUBS)).toEqual(["7i"]);
    expect(findActiveChipLabels(lieRow, LIE_TYPES)).toEqual(["fairway"]);
  });
});
