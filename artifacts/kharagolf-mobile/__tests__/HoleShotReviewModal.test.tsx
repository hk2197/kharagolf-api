/**
 * Task #808 — coverage for the per-hole Strokes Gained card refresh wiring.
 *
 * Task #649 already proves `<ShotReviewModal>`'s Add Shot flow fires its
 * `onMutated` callback. What it does NOT exercise is the score screen's
 * wiring of that callback to the per-hole SG card refetch — if a future
 * change unhooks `onMutated` from the SG-round refetch (or someone goes
 * back to using the bare `<ShotReviewModal>` without the wrapper), users
 * would see a stale per-hole SG number after adding a forgotten shot but
 * the modal-only test would still pass.
 *
 * To plug that gap we render the small subset that owns both the SG-round
 * `useQuery` and the modal — `<HoleShotReviewModal>` — and walk the real
 * Add Shot flow from the modal. We then assert that the SG-round endpoint
 * (`GET /api/portal/sg/round?...`) was hit at least twice: once for the
 * initial mount, and once again after the manual-shot POST resolved. The
 * second hit is the per-hole SG card refetch the user depends on.
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

// ── Test fixtures ──────────────────────────────────────────────────────────

const TOURNAMENT_ID = 555;
const ROUND = 1;
const HOLE = 7;
const TOKEN = "test-token";

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

    // The per-hole SG card pulls this — the count of GETs to it is the
    // signal we use to prove the post-Add-Shot refetch happened.
    if (method === "GET" && url.includes("/api/portal/sg/round")) {
      sgRoundFetchCount += 1;
      return jsonResponse({
        baseline: "scratch",
        round: ROUND,
        shotsTracked: serverShots.length,
        // After the second fetch (post Add-Shot) we surface a different
        // number to mirror real-world cache invalidation behaviour, but
        // the count itself is the assertion that matters.
        holes: [
          {
            holeNumber: HOLE,
            sgPutting: 0,
            sgApproach: sgRoundFetchCount > 1 ? -0.42 : 0.18,
            sgATG: 0,
            sgOTT: 0,
            sgTotal: sgRoundFetchCount > 1 ? -0.42 : 0.18,
          },
        ],
        totals: null,
      });
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

function renderWrapped() {
  // Disable retries so a failed assertion doesn't cascade into noisy
  // background fetches that pollute the call counts we're measuring.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
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

describe("HoleShotReviewModal — per-hole SG card refresh wiring (Task #808)", () => {
  it("refetches /api/portal/sg/round after the modal saves a forgotten shot", async () => {
    renderWrapped();

    // Initial render kicks off the SG-round query and the modal's shot
    // hydration in parallel. Wait until both have landed.
    await waitFor(() => {
      expect(sgRoundFetchCount).toBe(1);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("TEE");
    });

    // Snapshot how many times we've hit /sg/round so the post-save
    // assertion can measure the *delta* from the Add Shot save, not
    // the cumulative count.
    const sgFetchesBeforeSave = sgRoundFetchCount;
    expect(sgFetchesBeforeSave).toBe(1);

    // Walk the real Add Shot flow exposed by ShotReviewModal — open the
    // form, fill the fields, save. This mirrors what the player does on
    // the score screen when they realise they forgot to log a shot.
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

    // The manual-shot POST must have landed (sanity check that we did
    // exercise a successful save, not a validation failure).
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url).endsWith("/api/portal/shots/manual") && init?.method === "POST",
      );
      expect(postCall).toBeDefined();
    });

    // The new shot row must surface — proves the modal's own post-save
    // refetch ran, which is the trigger for `onMutated` and therefore
    // the SG card refetch wired by HoleShotReviewModal.
    await waitFor(() => {
      expect(document.body.textContent).toContain("APPROACH");
    });

    // *** The Task #808 assertion. ***
    //
    // After the Add Shot save the wrapper's `onMutated` handler must have
    // called `refetchSg()` on the ["portal-sg-round", …] useQuery. That
    // hits /api/portal/sg/round a second time, so the per-hole SG card
    // on the score screen — which renders from the same query cache key
    // — picks up the fresh number instead of staying stale.
    await waitFor(() => {
      expect(sgRoundFetchCount).toBeGreaterThan(sgFetchesBeforeSave);
    });
  });
});
