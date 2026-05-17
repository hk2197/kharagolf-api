/**
 * Task #1085 — Tapping a per-hole SG dot on the Round Summary screen must
 * open `<HoleShotReviewModal>` for that hole. The companion test
 * `round-summary-sg-refresh.test.tsx` proves that once the modal IS open
 * the SG cache invalidation refreshes the per-hole number on the summary
 * screen, but it forces `visible={true}` and never exercises the dot's
 * `onPress` itself. If a future change removes the `onPress` handler from
 * the hole dot Pressable (or wraps it back in a non-pressable `<View>`)
 * the refresh test would still pass and players would silently lose the
 * post-round Add Shot entry point.
 *
 * To exercise the real wiring without dragging score.tsx's expo-camera /
 * expo-location / background-task imports into vitest, the per-hole dot
 * row was extracted into `<RoundSummaryHoleDots>` (which score.tsx now
 * uses on the post-round summary screen). This test mounts that real
 * component plus the real `<HoleShotReviewModal>`, with no modal open
 * initially, fires a press on the `Review shots for hole N` dot, and
 * asserts the modal opens with the matching `holeNumber` (the modal
 * renders `Hole N · Shots` in its header).
 */
import React, { type ReactNode, useState } from "react";
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
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Module mocks (must come BEFORE the component imports) ─────────────────

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

// ── Imports under test (after mocks) ──────────────────────────────────────
import RoundSummaryHoleDots, {
  type RoundSummaryHoleResult,
} from "../components/RoundSummaryHoleDots";
import HoleShotReviewModal from "../components/HoleShotReviewModal";

// ── Test fixtures ─────────────────────────────────────────────────────────

const TOURNAMENT_ID = 777;
const ROUND = 1;
const TOKEN = "test-token";

const HOLE_RESULTS: RoundSummaryHoleResult[] = [
  { holeNumber: 1, strokes: 4, par: 4, toPar: 0 },
  { holeNumber: 4, strokes: 5, par: 4, toPar: 1 },
  { holeNumber: 7, strokes: 3, par: 4, toPar: -1 },
];

const SG_ROUND = {
  baseline: "scratch",
  round: ROUND,
  shotsTracked: 3,
  holes: HOLE_RESULTS.map((h, i) => ({
    holeNumber: h.holeNumber,
    sgPutting: 0,
    sgApproach: 0,
    sgATG: 0,
    sgOTT: 0,
    sgTotal: 0.10 * (i + 1),
  })),
  totals: null,
};

type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "GET" && url.includes("/api/portal/sg/round")) {
      return jsonResponse(SG_ROUND);
    }
    if (method === "GET" && url.includes(`/api/portal/rounds/${ROUND}/shots`)) {
      // Empty shot list is fine — the modal still renders its "Hole N · Shots"
      // header which is what we assert against.
      return jsonResponse([]);
    }
    throw new Error(`Unexpected fetch in dot-press test: ${method} ${url}`);
  }) as unknown as FetchMock;

  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Mirrors the slice of RoundSummaryScreen that owns the
 * `reviewShotsHole` state and conditionally renders
 * `<HoleShotReviewModal>` based on it. The dot row itself is the REAL
 * production component (`RoundSummaryHoleDots`), so a future change
 * that removed the dot's `onPress` (or stopped invoking the callback)
 * would break this test.
 */
function Harness() {
  const [reviewShotsHole, setReviewShotsHole] = useState<number | null>(null);
  return (
    <>
      <RoundSummaryHoleDots
        holeResults={HOLE_RESULTS}
        sgRound={SG_ROUND}
        onPressHole={setReviewShotsHole}
      />
      {reviewShotsHole !== null && (
        <HoleShotReviewModal
          visible={reviewShotsHole !== null}
          onClose={() => setReviewShotsHole(null)}
          token={TOKEN}
          tournamentId={TOURNAMENT_ID}
          round={ROUND}
          holeNumber={reviewShotsHole}
        />
      )}
    </>
  );
}

function renderHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("RoundSummaryScreen — tapping a per-hole SG dot opens shot review (Task #1085)", () => {
  it("renders no shot-review modal initially, then opens it for the tapped hole", async () => {
    renderHarness();

    // The dot row is rendered.
    const dotForHole7 = screen.getByLabelText(/^Review shots for hole 7\b/);
    expect(dotForHole7).toBeTruthy();

    // No HoleShotReviewModal is mounted yet — the modal's header text must be
    // absent from the document until a dot is pressed.
    expect(document.body.textContent).not.toContain("Hole 7 · Shots");
    expect(document.body.textContent).not.toContain("Hole 4 · Shots");
    expect(document.body.textContent).not.toContain("Hole 1 · Shots");

    // Tap the dot for hole 7.
    fireEvent.click(dotForHole7);

    // The modal opens with holeNumber=7 — its header reads "Hole 7 · Shots".
    await waitFor(() => {
      expect(document.body.textContent).toContain("Hole 7 · Shots");
    });
    // And it did NOT open for some other hole.
    expect(document.body.textContent).not.toContain("Hole 4 · Shots");
    expect(document.body.textContent).not.toContain("Hole 1 · Shots");
  });

  it("opens the modal with the matching holeNumber when a different dot is tapped", async () => {
    renderHarness();

    const dotForHole4 = screen.getByLabelText(/^Review shots for hole 4\b/);
    fireEvent.click(dotForHole4);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Hole 4 · Shots");
    });
    expect(document.body.textContent).not.toContain("Hole 7 · Shots");
  });
});
