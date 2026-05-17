/**
 * Task #2148 — Mobile coverage for the Follow button on the public
 * tournament leaderboard. Mirrors the web-side suite at
 * artifacts/kharagolf-web/src/pages/__tests__/public-leaderboard-follow-button
 * .test.tsx so the same three Follow-button contracts are pinned down for
 * the mobile leaderboard tab too.
 *
 * The contracts under test:
 *
 *   (a) The viewer's own row NEVER renders <FollowButton />. The self-row
 *       guard lives at app/(tabs)/leaderboard.tsx (LeaderboardRow:403):
 *         `showFollow && entry.userId != null && entry.userId !== currentUserId`
 *       The parent wiring (LeaderboardScreen:1918) threads
 *       `currentUserId={user?.id ?? null}` down from useAuth(). A regression
 *       that drops the prop or hardcodes it to null would let the viewer
 *       see a "Follow yourself" button on their own row — the kind of
 *       mobile-only mistake the web test cannot catch.
 *
 *   (b) Unlinked tournament-only rows (entry.userId == null) NEVER render
 *       a Follow button — the same `entry.userId != null` guard. These
 *       are walk-in players without a portal account; there's nothing to
 *       follow.
 *
 *   (c) Rows whose userId is in the pre-fetched followee list (from
 *       useFolloweeIds → GET /api/portal/follows) hydrate as "Following"
 *       on first render via initialFollowing={isFollowing}. Without the
 *       page-level pre-fetch wiring (LeaderboardScreen:1919:
 *       `isFollowing={item.entry.userId != null && followeeIdSet.has(...)}`)
 *       every row would flash "Follow" → "Following" on reload.
 *
 * The HTTP contract for /api/portal/follows is separately covered against
 * the live PostgreSQL test DB by
 *   artifacts/api-server/src/tests/follows-status.test.ts
 *
 * Test layout — two layers, mirroring feed-follow-button.test.tsx:
 *
 *   1. LeaderboardRow component-level cases. These assert the three
 *      guards directly (cheap, no fetches).
 *   2. LeaderboardScreen mount. This is the *wiring* assertion the task
 *      brief specifically calls out: a regression where the screen forgets
 *      to thread currentUserId / followeeIdSet into the row would slip
 *      past the row-level cases above. We mock the leaderboard fetch
 *      payload (userId per entry) and /api/portal/follows, then assert
 *      the right set of follow buttons appears with the right labels.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// vi.hoisted runs before module-scope variables — the leaderboard screen
// captures BASE_URL from process.env.EXPO_PUBLIC_DOMAIN at module load
// (utils/api.ts), and several internal fetches use `new URL(...)` style
// concatenation that needs an absolute origin under jsdom.
vi.hoisted(() => {
  process.env.EXPO_PUBLIC_DOMAIN = "test.example.com";
});

// ── Mocks for heavy/irrelevant collaborators ───────────────────────────
//
// These are everything the LeaderboardScreen imports at module scope that
// would otherwise drag jsdom into native module land or fire stray
// network requests we don't care about for this test.

const VIEWER_USER_ID = 99;
const VIEWER_TOKEN = "test-token";

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: VIEWER_TOKEN, user: { id: VIEWER_USER_ID } }),
}));

vi.mock("expo-router", () => ({
  // Pre-select tournament 999 so the leaderboard query fires immediately
  // (it's gated on `!!selectedTournamentId`).
  useLocalSearchParams: () => ({ tournamentId: "999" }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  router: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
  Stack: { Screen: () => null },
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("expo-av", () => ({
  Video: () => null,
  ResizeMode: { COVER: "cover", CONTAIN: "contain" },
}));

vi.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: async () => ({ granted: false }),
  requestMediaLibraryPermissionsAsync: async () => ({ granted: false }),
  launchCameraAsync: async () => ({ canceled: true, assets: [] }),
  launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }),
  MediaTypeOptions: { All: "all", Images: "images", Videos: "videos" },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

vi.mock("@/i18n", () => ({ getLocale: () => "en-US" }));

// LiveOddsWidget / InlineAdBanner / ConsentPrompt fire their own fetches
// or pull in jsdom-incompatible UI; null them out for this test.
vi.mock("@/components/LiveOddsWidget", () => ({ default: () => null }));
vi.mock("@/components/InlineAdBanner", () => ({ default: () => null }));
vi.mock("@/components/ConsentPrompt", () => ({ default: () => null }));
vi.mock("@/components/MemberAvatar", () => ({ default: () => null }));

// expo/vector-icons is already stubbed globally in __tests__/setup.ts.

// IMPORTANT: import the screen module *after* all the vi.mock calls above
// so the mocked dependencies are wired in before the module evaluates.
import LeaderboardScreen, {
  LeaderboardRow,
  type LeaderboardEntry,
} from "../app/(tabs)/leaderboard";
import { FollowButton } from "@/components/FollowButton";

// ── Fetch handler ──────────────────────────────────────────────────────

interface Handler {
  /** userIds returned by GET /api/portal/follows. */
  followeeIds: number[];
  followeesFetchCount: number;
  leaderboardFetchCount: number;
  leaderboardEntries: LeaderboardEntry[];
}

let handler: Handler;

function makeEntry(opts: {
  playerId: number;
  userId: number | null;
  name: string;
  position: number;
}): LeaderboardEntry {
  return {
    playerId: opts.playerId,
    userId: opts.userId,
    playerName: opts.name,
    position: opts.position,
    positionDisplay: String(opts.position),
    grossScore: 70 + opts.position,
    netScore: 70 + opts.position,
    scoreToPar: opts.position - 2,
    netToPar: opts.position - 2,
    stablefordPoints: null,
    parBogeyScore: null,
    thru: "F",
    flight: null,
    flights: [],
    handicapIndex: 12,
    holeScores: [],
    roundScores: [],
    currentRound: 1,
    stats: { eagles: 0, birdies: 0, pars: 18, bogeys: 0, doublePlus: 0 },
    isVerified: false,
    madeCut: true,
    profileImage: null,
    firstName: opts.name.split(" ")[0],
    lastName: opts.name.split(" ").slice(1).join(" ") || "",
    holesCompleted: 18,
    currentHole: null,
  };
}

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const stripped = url.split("?")[0];

    // GET /api/portal/follows — the pre-fetch that hydrates initialFollowing.
    // Anchored to avoid matching /api/portal/follows/:id (per-button toggle)
    // or /api/portal/follows/list (paginated viewer list).
    if (/\/api\/portal\/follows$/.test(stripped)) {
      handler.followeesFetchCount += 1;
      return new Response(
        JSON.stringify({ followeeIds: handler.followeeIds }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as Response;
    }

    // GET /api/public/tournaments/:id/leaderboard — the leaderboard payload
    // the screen renders rows from. The userId field on each entry is
    // exactly what the row's self-row guard and the initialFollowing
    // hydration both depend on.
    if (/\/api\/public\/tournaments\/\d+\/leaderboard$/.test(stripped)) {
      handler.leaderboardFetchCount += 1;
      return new Response(
        JSON.stringify({
          tournamentId: 999,
          tournamentName: "Follow Button Open",
          entries: handler.leaderboardEntries,
          netEntries: handler.leaderboardEntries,
          stablefordEntries: handler.leaderboardEntries,
          byFlight: { Overall: handler.leaderboardEntries },
          flights: [],
          lastUpdated: new Date("2026-04-30T10:00:00Z").toISOString(),
          coursePar: 72,
          rounds: 1,
          organizationId: 7,
          leaderboardType: "gross",
          availableViews: ["gross"],
          isTeamFormat: false,
          teamEntries: [],
          sponsors: [],
          format: "stroke",
          cutLineIndex: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as Response;
    }

    // Public tournaments list — used for the picker; an empty list keeps
    // the picker from auto-selecting a different tournament.
    if (/\/api\/public\/tournaments$/.test(stripped)) {
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    // SSE leaderboard stream — return a "stream" with no events. The
    // screen kicks this off in a useEffect and races it; an empty body
    // makes the reader exit immediately so the test doesn't hang.
    if (/\/leaderboard\/stream$/.test(stripped)) {
      return new Response("", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as unknown as Response;
    }

    // Anything else (notable-events, pace-board, spectator-follows,
    // sponsor-events, gallery, telemetry pings, …) → empty JSON.
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  handler = {
    followeeIds: [],
    followeesFetchCount: 0,
    leaderboardFetchCount: 0,
    leaderboardEntries: [],
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── 1. LeaderboardRow component-level — direct guards ──────────────────
//
// These exercise the three contracts at the level of the row component
// itself. They're cheap (no fetches) and pin down the guard so a future
// edit to LeaderboardRow (e.g. dropping the !== currentUserId check) is
// caught even if the parent wiring is unchanged.

describe("Task #2148 — LeaderboardRow Follow button guards", () => {
  const FOLLOWED_USER_ID = 503;

  function renderRow(overrides: {
    entry: LeaderboardEntry;
    currentUserId?: number | null;
    isFollowing?: boolean;
    showFollow?: boolean;
  }) {
    return render(
      <LeaderboardRow
        entry={overrides.entry}
        mode="gross"
        format="stroke"
        index={0}
        onPress={() => {}}
        currentUserId={overrides.currentUserId ?? null}
        isFollowing={overrides.isFollowing ?? false}
        showFollow={overrides.showFollow ?? true}
      />,
    );
  }

  it("(a) does NOT render a Follow button on the viewer's own row", () => {
    renderRow({
      entry: makeEntry({ playerId: 1, userId: VIEWER_USER_ID, name: "Viewer Vee", position: 2 }),
      currentUserId: VIEWER_USER_ID,
      // Even if the viewer's own id were in the followee list (a corrupt
      // API response), the self-row guard still has to hide the button.
      isFollowing: true,
    });

    expect(screen.queryByTestId(`follow-button-${VIEWER_USER_ID}`)).toBeNull();
    expect(screen.queryByTestId(/^follow-button-\d+$/)).toBeNull();
  });

  it("(b) does NOT render a Follow button on unlinked tournament-only rows (userId == null)", () => {
    renderRow({
      entry: makeEntry({ playerId: 4, userId: null, name: "Walk Onlee", position: 4 }),
      currentUserId: VIEWER_USER_ID,
    });

    // No userId at all means there's nothing to follow.
    expect(screen.queryByTestId(/^follow-button-\d+$/)).toBeNull();
  });

  it("(c) hydrates the row to 'Following' when isFollowing is true (no Follow → Following flash)", () => {
    renderRow({
      entry: makeEntry({ playerId: 5, userId: FOLLOWED_USER_ID, name: "Followed Fiona", position: 1 }),
      currentUserId: VIEWER_USER_ID,
      isFollowing: true,
    });

    const btn = screen.getByTestId(`follow-button-${FOLLOWED_USER_ID}`);
    // Locked-in label so a regression that defaults initialFollowing to
    // false (e.g. dropping the prop forwarding) would surface as "Follow"
    // here instead of "Following".
    expect(btn).toHaveTextContent(/^Following$/);
  });

  it("renders a 'Follow' button on a non-self linked row that the viewer doesn't follow yet", () => {
    renderRow({
      entry: makeEntry({ playerId: 6, userId: 502, name: "Other Olive", position: 3 }),
      currentUserId: VIEWER_USER_ID,
      isFollowing: false,
    });

    const btn = screen.getByTestId("follow-button-502");
    expect(btn).toHaveTextContent(/^Follow$/);
  });

  it("hides every Follow button when showFollow is false (signed-out spectator)", () => {
    // showFollow is wired to !!token at the call site; a signed-out
    // viewer must see the leaderboard without any Follow buttons.
    renderRow({
      entry: makeEntry({ playerId: 7, userId: 502, name: "Other Olive", position: 3 }),
      currentUserId: null,
      showFollow: false,
    });

    expect(screen.queryByTestId(/^follow-button-\d+$/)).toBeNull();
  });
});

// ── 2. LeaderboardScreen mount — parent wiring ─────────────────────────
//
// This is the wiring assertion the task brief specifically calls out: a
// regression where the leaderboard screen drops `currentUserId` or
// `isFollowing` from the LeaderboardRow call site (or stops calling
// useFolloweeIds) would slip past the row-level cases above. Mounting
// the actual screen exercises that wiring end-to-end.

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <LeaderboardScreen />
    </QueryClientProvider>,
  );
}

describe("Task #2148 — LeaderboardScreen wiring", () => {
  const FOLLOWED_USER_ID = 503;
  const OTHER_USER_ID = 502;

  beforeEach(() => {
    handler.leaderboardEntries = [
      // Position 1: a peer the viewer already follows (hydration target).
      makeEntry({ playerId: 1, userId: FOLLOWED_USER_ID, name: "Followed Fiona", position: 1 }),
      // Position 2: the viewer's own row — must NEVER show a Follow button.
      makeEntry({ playerId: 2, userId: VIEWER_USER_ID, name: "Viewer Vee", position: 2 }),
      // Position 3: another peer the viewer does not follow yet.
      makeEntry({ playerId: 3, userId: OTHER_USER_ID, name: "Other Olive", position: 3 }),
      // Position 4: an unlinked walk-in player (userId: null). Must NEVER
      // show a Follow button (no portal account to follow).
      makeEntry({ playerId: 4, userId: null, name: "Walk Onlee", position: 4 }),
    ];
  });

  it("threads currentUserId and the followee list into each row, applying all three guards", async () => {
    handler.followeeIds = [FOLLOWED_USER_ID];

    renderScreen();

    // Wait for the leaderboard fetch to resolve and rows to render.
    await waitFor(() => {
      expect(screen.queryByText("Followed Fiona")).not.toBeNull();
    });
    expect(screen.queryByText("Viewer Vee")).not.toBeNull();
    expect(screen.queryByText("Other Olive")).not.toBeNull();
    expect(screen.queryByText("Walk Onlee")).not.toBeNull();

    // (a) Self-row guard — the viewer must never get a Follow button on
    //     their own row. A regression where the screen passes
    //     `currentUserId={null}` (or drops the prop) would surface here.
    expect(screen.queryByTestId(`follow-button-${VIEWER_USER_ID}`)).toBeNull();

    // (b) Unlinked row — no userId means no follow-button-* testid even
    //     exists. The exact-set assertion below locks this in.

    // (c) Hydrated row — the followee row paints as "Following" on first
    //     render thanks to initialFollowing being threaded from
    //     useFolloweeIds → /api/portal/follows. Without the wiring this
    //     would stay on "Follow" indefinitely (no per-button GET).
    const followedBtn = await screen.findByTestId(`follow-button-${FOLLOWED_USER_ID}`);
    await waitFor(() => {
      expect(followedBtn).toHaveTextContent(/^Following$/);
    });

    // The non-followed peer stays on "Follow".
    const otherBtn = screen.getByTestId(`follow-button-${OTHER_USER_ID}`);
    expect(otherBtn).toHaveTextContent(/^Follow$/);

    // Locking down the exact set: exactly two follow buttons render for
    // this fixture (positions 1 & 3). A regression that drops the
    // self-row guard would surface as 3 here; one that drops the
    // unlinked-row guard would surface as 4.
    const allFollowButtons = screen.getAllByTestId(/^follow-button-\d+$/);
    expect(allFollowButtons.map(b => b.getAttribute("data-testid")).sort()).toEqual([
      `follow-button-${FOLLOWED_USER_ID}`,
      `follow-button-${OTHER_USER_ID}`,
    ].sort());

    // The pre-fetch endpoint actually fired — locks in the wiring the
    // task brief specifically calls out (a regression where the screen
    // stops calling useFolloweeIds would skip this fetch and every
    // button would flash "Follow" on reload).
    expect(handler.followeesFetchCount).toBeGreaterThanOrEqual(1);
    expect(handler.leaderboardFetchCount).toBeGreaterThanOrEqual(1);
  });
});

// ── Sanity: FollowButton is the same component used by the row ──────────
// Cheap guard so a refactor that swaps the row's button to a different
// component (and breaks the tests above silently) is at least visible.
describe("Task #2148 — FollowButton component identity", () => {
  it("FollowButton is exported and renders a testid we can target", () => {
    render(<FollowButton userId={123} initialFollowing={false} />);
    expect(screen.getByTestId("follow-button-123")).toBeInTheDocument();
  });
});
