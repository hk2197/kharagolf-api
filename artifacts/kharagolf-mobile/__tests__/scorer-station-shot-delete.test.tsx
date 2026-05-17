/**
 * Component test: scorer-station "undo logged shot" tap (Task #1635, mobile
 * mirror of backend coverage from Task #1368).
 *
 * Drives the mobile scorer screen at the React level — mocks `fetch` so the
 * tournament/group/course-holes loads succeed and the GET
 * /api/scorer/groups/:groupId response includes three pre-existing shots for
 * Alice on hole 1. A `vi.hoisted` Alert mock captures `Alert.alert(...)`
 * calls so we can both assert the confirm prompt is shown AND drive the
 * destructive button's onPress to simulate the user tapping "Delete".
 *
 * Verifies that:
 *
 *   1. Tapping the trash icon on a shot row fires `Alert.alert` with the
 *      delete-shot title, an interpolated body that names the player / shot
 *      / hole, and a Cancel + destructive Delete button pair. Tapping
 *      Cancel does NOT fire any DELETE network call.
 *
 *   2. Tapping the destructive Delete button:
 *        - fires DELETE /api/scorer/groups/:groupId/shots/:shotId with the
 *          scorer's bearer token,
 *        - removes the deleted row from the list,
 *        - rewinds the per-(player, hole) shot counter so the next
 *          "Log shot" tap pre-fills the now-correct shot # (was 4 before,
 *          should be 3 after deleting Alice's shot #3).
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

interface AlertButton {
  text: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
}
interface AlertCall {
  title: string;
  message?: string;
  buttons?: AlertButton[];
}

const { alertMock } = vi.hoisted(() => ({
  alertMock: vi.fn<(title: string, message?: string, buttons?: AlertButton[]) => void>(),
}));

vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>("react-native");
  return { ...RN, Alert: { alert: alertMock } };
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
// sure the per-(player, hole) filter keeps Bob's shot intact even after
// deleting one of Alice's. Highest existing shot # for Alice on hole 1 is 3,
// so the next "Log shot" should pre-fill 4. After we delete shot #3 the
// counter must rewind so the next "Log shot" pre-fills 3.
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
    latitude: null,
    longitude: null,
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
    latitude: null,
    longitude: null,
    distanceToPin: null,
    distanceCarried: null,
    source: "scorer",
  },
  // Bob's lone shot on the same hole — must remain after Alice's #3 is deleted.
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

interface ShotDelete {
  url: string;
  method: string;
  authorization: string | null;
}

let shotDeletes: ShotDelete[] = [];
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
    if (/\/api\/scorer\/groups\/\d+\/shots\/\d+/.test(url) && method === "DELETE") {
      shotDeletes.push({
        url,
        method,
        authorization: getHeader(init, "Authorization"),
      });
      const shotIdMatch = url.match(/\/shots\/(\d+)/);
      const shotId = shotIdMatch ? parseInt(shotIdMatch[1], 10) : 0;
      return new Response(JSON.stringify({ ok: true, shotId }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

beforeEach(() => {
  shotDeletes = [];
  alertMock.mockClear();
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
  // Wait for the shots list to render (Alice's 3 + Bob's 1 = 4 edit icons).
  await waitFor(() => {
    const editIcons = document.querySelectorAll('[data-icon="edit-2"]');
    expect(editIcons.length).toBeGreaterThanOrEqual(4);
  });
}

// Same player-card walker as scorer-station-shots-list.test.tsx — finds the
// outer `playerScoreCard` View around a player name by looking for a wrapper
// that contains both the "Log shot" button AND the score control "minus"
// icon.
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

// Find the shot row containing a given shot number ("#1", "#2", …). Returns
// the row element so we can locate its trash icon button.
function getShotRow(card: HTMLElement, shotNumber: number): HTMLElement {
  const numNodes = within(card).getAllByText(`#${shotNumber}`);
  for (const n of numNodes) {
    let cur: HTMLElement | null = n as HTMLElement;
    while (cur && cur.parentElement) {
      cur = cur.parentElement;
      // The shot row contains both the edit-2 (row tap) icon AND the
      // trash-2 (delete) icon — walk up until we find the wrapper that has
      // both, which is the parent <div> of the row's main + trash buttons.
      if (
        cur &&
        cur.querySelector('[data-icon="edit-2"]') &&
        cur.querySelector('[data-icon="trash-2"]')
      ) {
        return cur;
      }
    }
  }
  throw new Error(`Could not find shot row #${shotNumber}`);
}

// The trash button is the TouchableOpacity wrapper around the trash-2 icon
// — walk up from the icon node until we hit a tab-focusable wrapper.
function getTrashButton(row: HTMLElement): HTMLElement {
  const trashIcon = row.querySelector('[data-icon="trash-2"]');
  if (!trashIcon) throw new Error("No trash icon in row");
  let cur: HTMLElement | null = trashIcon as HTMLElement;
  while (cur && cur.parentElement) {
    cur = cur.parentElement;
    if (cur && cur.getAttribute("tabindex") === "0") return cur;
  }
  throw new Error("Could not find trash button wrapper");
}

function lastAlertCall(): AlertCall {
  expect(alertMock).toHaveBeenCalled();
  const call = alertMock.mock.calls[alertMock.mock.calls.length - 1];
  return { title: call[0], message: call[1], buttons: call[2] };
}

describe("Scorer Station — undo logged shot (Task #1635)", () => {
  it("shows the confirm Alert with Cancel + destructive Delete buttons when the trash icon is tapped, and Cancel does not fire DELETE", async () => {
    await navigateToScoring();

    const aliceCard = getPlayerCard("Alice Player");
    const shot3Row = getShotRow(aliceCard, 3);
    const trashBtn = getTrashButton(shot3Row);

    await act(async () => {
      fireEvent.click(trashBtn);
    });

    const alertCall = lastAlertCall();
    expect(alertCall.title).toBe("Delete shot?");
    // Body is interpolated with player name, shot # and hole #.
    expect(alertCall.message).toBe(
      "Remove Alice Player's shot #3 on hole 1? This can't be undone.",
    );
    expect(Array.isArray(alertCall.buttons)).toBe(true);
    const buttons = alertCall.buttons!;
    expect(buttons.length).toBe(2);
    expect(buttons[0]).toMatchObject({ text: "Cancel", style: "cancel" });
    expect(buttons[1]).toMatchObject({ text: "Delete", style: "destructive" });
    expect(typeof buttons[1].onPress).toBe("function");

    // Tap Cancel — must NOT fire any DELETE network call.
    await act(async () => {
      buttons[0].onPress?.();
    });
    expect(shotDeletes.length).toBe(0);

    // The deleted row is still in the list.
    expect(within(aliceCard).getByText("#3")).toBeTruthy();
  });

  it("deletes the row, fires DELETE /api/scorer/groups/:groupId/shots/:shotId, and rewinds the per-(player, hole) shot counter when the destructive Delete is tapped", async () => {
    await navigateToScoring();

    // Sanity baseline: Alice has 3 shot rows, Bob has 1.
    let aliceCard = getPlayerCard("Alice Player");
    expect(within(aliceCard).queryByText("#1")).toBeTruthy();
    expect(within(aliceCard).queryByText("#2")).toBeTruthy();
    expect(within(aliceCard).queryByText("#3")).toBeTruthy();

    // Sanity: before any delete, opening "Log shot" pre-fills shot # to 4.
    // Scope numeric scan to the modal so the screen-wide hole-dot row (1-18)
    // doesn't pollute the assertion.
    const aliceLogShotBefore = within(aliceCard).getByText("Log shot");
    await act(async () => {
      fireEvent.click(aliceLogShotBefore);
    });
    const modalTitleBefore = await screen.findByText(/Log shot · Alice Player/);
    let modalCardBefore: HTMLElement | null = modalTitleBefore as HTMLElement;
    while (
      modalCardBefore &&
      modalCardBefore.parentElement &&
      !within(modalCardBefore).queryByText("Save shot")
    ) {
      modalCardBefore = modalCardBefore.parentElement;
    }
    if (!modalCardBefore) throw new Error("Could not find modal card containing Save shot");
    const modalNumsBefore = within(modalCardBefore).getAllByText(/^[0-9]+$/).map(n => n.textContent);
    expect(modalNumsBefore).toContain("4");
    // Close the modal so it doesn't intercept later interactions.
    await act(async () => {
      fireEvent.click(within(modalCardBefore).getByText("Cancel"));
    });
    await waitFor(() => {
      expect(screen.queryByText(/Log shot · Alice Player/)).toBeNull();
    });

    // Re-resolve the card after the modal close re-renders.
    aliceCard = getPlayerCard("Alice Player");
    const shot3Row = getShotRow(aliceCard, 3);
    const trashBtn = getTrashButton(shot3Row);

    await act(async () => {
      fireEvent.click(trashBtn);
    });

    const buttons = lastAlertCall().buttons!;
    const destructive = buttons.find(b => b.style === "destructive");
    expect(destructive).toBeDefined();

    // Trigger the destructive button's onPress to simulate the user tapping
    // "Delete" in the OS dialog.
    await act(async () => {
      await destructive!.onPress?.();
    });

    // DELETE call was fired with the right URL, method and bearer token.
    await waitFor(() => {
      expect(shotDeletes.length).toBe(1);
    });
    const del = shotDeletes[0];
    expect(del.method).toBe("DELETE");
    // Stronger than `toContain`: assert the exact path segment for groupId/shotId
    // so a stray query string or slug typo would still fail the test.
    expect(del.url).toMatch(/\/api\/scorer\/groups\/7\/shots\/103(?:[?#].*)?$/);
    expect(del.authorization).toBe("Bearer test-token");

    // The deleted row disappears from Alice's list, but #1 and #2 remain
    // and Bob's lone shot is still intact.
    aliceCard = getPlayerCard("Alice Player");
    await waitFor(() => {
      expect(within(aliceCard).queryByText("#3")).toBeNull();
    });
    expect(within(aliceCard).queryByText("#1")).toBeTruthy();
    expect(within(aliceCard).queryByText("#2")).toBeTruthy();

    const bobCard = getPlayerCard("Bob Golfer");
    expect(within(bobCard).queryByText("#1")).toBeTruthy();

    // The per-(player, hole) shot counter rewound by one — opening "Log
    // shot" for Alice now pre-fills shot # to 3 (was 4 before the delete).
    const aliceLogShot = within(aliceCard).getByText("Log shot");
    await act(async () => {
      fireEvent.click(aliceLogShot);
    });
    await screen.findByText(/Log shot · Alice Player/);

    const numericValuesAfter = screen.getAllByText(/^[0-9]+$/).map(n => n.textContent);
    expect(numericValuesAfter).toContain("3");
    // Strong assertion: the now-stale next-shot value 4 must not appear in
    // the modal — proves the counter actually rewound rather than just
    // being unaffected by the optimistic list update.
    const modalTitle = screen.getByText(/Log shot · Alice Player/);
    let modalCard: HTMLElement | null = modalTitle as HTMLElement;
    while (modalCard && modalCard.parentElement && !within(modalCard).queryByText("Save shot")) {
      modalCard = modalCard.parentElement;
    }
    if (!modalCard) throw new Error("Could not find modal card containing Save shot");
    const modalNums = within(modalCard).getAllByText(/^[0-9]+$/).map(n => n.textContent);
    expect(modalNums).toContain("3");
    expect(modalNums).not.toContain("4");
  });
});
