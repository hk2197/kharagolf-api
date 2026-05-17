/**
 * Task #945 — coverage for the per-hole Strokes Gained refresh wiring on
 * the Round Summary screen.
 *
 * `RoundSummaryScreen` (in `app/(tabs)/score.tsx`) owns its own
 * `useQuery(["portal-sg-round", tournamentId, round])` and renders
 * per-hole SG dots + round-level totals from it. Now that the summary
 * screen reuses `<HoleShotReviewModal>` for post-round Add / Edit /
 * Delete shot edits, the wrapper's refetch must invalidate the SAME
 * query cache key the summary screen reads from — otherwise the per-hole
 * SG number a player just edited would stay stale on the summary view
 * until they navigated away and back.
 *
 * The companion test `HoleShotReviewModal.test.tsx` (Task #808) already
 * proves the wrapper itself fires a /sg/round refetch after Add Shot.
 * What it doesn't prove is that a SIBLING owner of the same cache key
 * — exactly the relationship the summary screen has with the wrapper —
 * actually re-renders with the new value. If a future change moves
 * either side onto a different cache key, the wrapper test would still
 * pass but the summary screen would silently stop refreshing.
 *
 * We render a tiny subset that mirrors RoundSummaryScreen's structure:
 * a parent component that owns its own `useQuery(["portal-sg-round", …])`
 * and displays the per-hole SG total, plus `<HoleShotReviewModal>` as a
 * sibling on the same key. We then walk the real Add Shot flow and
 * assert the parent's displayed SG number updates from the pre-save
 * value to the post-save value.
 */
import React, { type ReactNode } from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

// ── Module mocks (must come BEFORE the component import) ───────────────────

vi.mock("react-native-safe-area-context", () => {
  const ReactInner = require("react") as typeof React;
  return {
    SafeAreaView: ({ children }: { children?: ReactNode }) =>
      ReactInner.createElement("div", null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>("react-native");
  return { ...RN, Alert: { alert: vi.fn() } };
});

// ── Imports under test (after mocks) ───────────────────────────────────────
import HoleShotReviewModal from "../components/HoleShotReviewModal";
import type { ServerShot } from "../components/ShotReviewModal";
import { fetchPortal } from "../utils/api";

// ── Test fixtures ──────────────────────────────────────────────────────────

const TOURNAMENT_ID = 777;
const ROUND = 1;
const HOLE = 4;
const TOKEN = "test-token";

const PRE_SAVE_SG = 0.18;
const POST_SAVE_SG = -0.42;

interface SGRoundResponse {
  baseline: string;
  round: number;
  shotsTracked: number;
  holes: { holeNumber: number; sgPutting: number; sgApproach: number; sgATG: number; sgOTT: number; sgTotal: number }[];
  totals: null;
}

function makeShot(overrides: Partial<ServerShot> & Pick<ServerShot, "id" | "shotNumber">): ServerShot {
  return {
    round: ROUND,
    holeNumber: HOLE,
    shotType: "tee",
    club: "driver",
    lieType: "Tee",
    missDirection: null,
    shotShape: null,
    penaltyReason: null,
    distanceToPin: null,
    ...overrides,
  };
}

let serverShots: ServerShot[];
let sgRoundFetchCount: number;

type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  serverShots = [makeShot({ id: 1001, shotNumber: 1 })];
  sgRoundFetchCount = 0;

  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "GET" && url.includes("/api/portal/sg/round")) {
      sgRoundFetchCount += 1;
      // First fetch returns the pre-save SG value, every later fetch
      // (i.e. the post-Add-Shot refetch) returns the new value — that's
      // how we prove the parent's display updates from the refresh,
      // not from a coincidence.
      const sgTotal = sgRoundFetchCount > 1 ? POST_SAVE_SG : PRE_SAVE_SG;
      return jsonResponse({
        baseline: "scratch",
        round: ROUND,
        shotsTracked: serverShots.length,
        holes: [
          {
            holeNumber: HOLE,
            sgPutting: 0,
            sgApproach: sgTotal,
            sgATG: 0,
            sgOTT: 0,
            sgTotal,
          },
        ],
        totals: null,
      } satisfies SGRoundResponse);
    }
    if (method === "GET" && url.includes(`/api/portal/rounds/${ROUND}/shots`)) {
      return jsonResponse([{ hole: HOLE, shots: serverShots }]);
    }
    if (method === "POST" && url.endsWith("/api/portal/shots/manual")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        shotNumber: number;
        shotType: string;
        club?: string;
        lieType?: string;
        missDirection?: string;
      };
      const inserted = makeShot({
        id: 2000 + serverShots.length,
        shotNumber: body.shotNumber,
        shotType: body.shotType,
        club: body.club ?? null,
        lieType: body.lieType ?? null,
        missDirection: body.missDirection ?? null,
      });
      serverShots = [...serverShots, inserted];
      return jsonResponse({ ok: true, shot: inserted });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as unknown as FetchMock;

  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Mirrors the structure of `RoundSummaryScreen` for the purposes of this
 * test: it owns its own `useQuery` on the shared cache key (just like
 * the real summary screen does on line ~3200 of `app/(tabs)/score.tsx`)
 * and renders the per-hole SG number from it. It does NOT receive any
 * refresh callback — the only way the displayed number can update after
 * the Add Shot save is via the wrapper's `refetchSg()` invalidating the
 * shared `["portal-sg-round", …]` cache.
 */
function RoundSummaryParent() {
  const { data } = useQuery<SGRoundResponse>({
    queryKey: ["portal-sg-round", TOURNAMENT_ID, ROUND],
    queryFn: () => fetchPortal<SGRoundResponse>(
      `/sg/round?round=${ROUND}&tournamentId=${TOURNAMENT_ID}`,
      TOKEN,
    ),
    staleTime: 30 * 1000,
  });
  const sgHole = data?.holes.find(h => h.holeNumber === HOLE);
  return (
    <div data-testid="summary-sg">
      hole-{HOLE}-sg:{sgHole ? sgHole.sgTotal.toFixed(2) : "loading"}
    </div>
  );
}

function renderSummarySubset() {
  // Disable retries so a failed assertion doesn't cascade into noisy
  // background fetches that pollute the call counts we measure.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RoundSummaryParent />
      <HoleShotReviewModal
        visible={true}
        onClose={() => {}}
        token={TOKEN}
        tournamentId={TOURNAMENT_ID}
        round={ROUND}
        holeNumber={HOLE}
      />
    </QueryClientProvider>,
  );
}

describe("RoundSummaryScreen — per-hole SG refresh after Add Shot (Task #945)", () => {
  it("re-renders the parent's per-hole SG number after the modal saves a forgotten shot", async () => {
    renderSummarySubset();

    // Pre-save: parent's useQuery has resolved with the initial SG value.
    await waitFor(() => {
      expect(screen.getByTestId("summary-sg").textContent).toContain(
        `hole-${HOLE}-sg:${PRE_SAVE_SG.toFixed(2)}`,
      );
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("TEE");
    });

    const sgFetchesBeforeSave = sgRoundFetchCount;
    expect(sgFetchesBeforeSave).toBe(1);

    // Walk the real Add Shot flow exposed by ShotReviewModal — the same
    // sequence the in-round ScoringScreen test exercises.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add Shot"));
    });
    const typeInput = screen.getByLabelText("New shot type") as HTMLInputElement;
    const clubInput = screen.getByLabelText("New shot club") as HTMLInputElement;
    const lieInput  = screen.getByLabelText("New shot lie") as HTMLInputElement;
    const missInput = screen.getByLabelText("New shot miss") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(typeInput, { target: { value: "approach" } });
      fireEvent.change(clubInput, { target: { value: "7I" } });
      fireEvent.change(lieInput,  { target: { value: "Fairway" } });
      fireEvent.change(missInput, { target: { value: "Left" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Save new shot"));
    });

    // Sanity: the manual-shot POST must have landed.
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url).endsWith("/api/portal/shots/manual") && init?.method === "POST",
      );
      expect(postCall).toBeDefined();
    });

    // The SG endpoint must have been re-hit (wrapper's `refetchSg()`).
    await waitFor(() => {
      expect(sgRoundFetchCount).toBeGreaterThan(sgFetchesBeforeSave);
    });

    // *** The Task #945 assertion. ***
    //
    // The summary parent — which owns its own useQuery on the SAME
    // ["portal-sg-round", …] cache key — must re-render with the
    // post-save SG value. Without the shared cache key, the wrapper's
    // refetch would update only its own copy and the summary screen
    // would stay stuck on the pre-save number.
    await waitFor(() => {
      expect(screen.getByTestId("summary-sg").textContent).toContain(
        `hole-${HOLE}-sg:${POST_SAVE_SG.toFixed(2)}`,
      );
    });
  });
});
