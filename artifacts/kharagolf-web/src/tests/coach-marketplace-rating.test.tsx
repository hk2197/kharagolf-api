/**
 * E2E-style component test for the coach review rating flow inside
 * `ReviewPlaybackModal` on the /coach-marketplace page — Task #2095.
 *
 * The web ReviewPlaybackModal in
 * `artifacts/kharagolf-web/src/pages/coach-marketplace.tsx` lets members
 * submit a 1–5 star rating + optional comment after watching a delivered
 * review (mirroring the mobile flow in
 * `artifacts/kharagolf-mobile/app/(tabs)/coach.tsx` →
 * `RequestDetailModalInner`). Task #1683 already pinned down the
 * audio↔video sync for that modal, but the rating submission path
 * (`POST /api/swing-reviews/requests/:id/rate`) — including:
 *
 *   - the success toast + local `data.request.rating` update that hides
 *     the rating prompt
 *   - the destructive toast on failure that keeps the prompt visible
 *
 * — still had no automated coverage on the web side. A future refactor
 * of the submit handler (e.g. dropping the local state mutation, the
 * onClose call, the destructive variant on the toast, or the early
 * "rated already" guard the API enforces) could silently regress the
 * member-facing experience without this safety net.
 *
 * The test stubs `fetch` with a tiny in-memory backend that owns just
 * enough of the swing-reviews endpoints to:
 *
 *   - GET /api/coach-marketplace/coaches → empty list (we never need
 *     the coach grid; it would just complicate the test if it rendered)
 *   - GET /api/swing-reviews/my-requests → one delivered, UNRATED
 *     review so the prompt actually appears in the modal
 *   - GET /api/swing-reviews/requests/:id → review detail (no
 *     voice-over so the audio sync effect stays out of the way)
 *   - POST /api/swing-reviews/requests/:id/rate → either persists the
 *     rating + comment so the next /my-requests refetch reflects it, or
 *     returns a 400 with an `error` body (configurable per backend
 *     instance) to drive the destructive-toast branch
 *
 * `<Toaster />` is rendered alongside the page so the production
 * `toast({ title, description, variant: 'destructive' })` calls land in
 * the DOM and can be asserted against by text — `CoachMarketplacePage`
 * itself does not mount the toaster (App.tsx does in production).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CoachMarketplacePage from "@/pages/coach-marketplace";
import { Toaster } from "@/components/ui/toaster";

interface ReviewSeed {
  id: number;
  proId: number;
  proName: string;
  videoUrl: string;
}

interface RatePayload {
  rating?: number;
  comment?: string;
}

interface BackendOptions {
  /**
   * When true, POST /api/swing-reviews/requests/:id/rate returns a 400
   * with an `error` body — exercises the destructive-toast branch of
   * the submit handler.
   */
  rateShouldFail?: boolean;
}

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function buildBackend(review: ReviewSeed, opts: BackendOptions = {}) {
  const calls: RecordedCall[] = [];
  let storedRating: number | null = null;
  let storedComment: string | null = null;

  const respond = (body: unknown, status = 200) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);

  const handler = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    let parsedBody: unknown = undefined;
    if (init?.body != null) {
      try {
        parsedBody = JSON.parse(String(init.body));
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, method, body: parsedBody });
    const path = url.split("?")[0].replace(/^.*\/api\//, "/api/");

    if (method === "GET" && path === "/api/coach-marketplace/coaches") {
      return respond({ coaches: [] });
    }

    if (method === "GET" && path === "/api/swing-reviews/my-requests") {
      const createdAt = new Date("2026-04-29T10:00:00Z").toISOString();
      return respond({
        requests: [
          {
            request: {
              id: review.id,
              proId: review.proId,
              status: "delivered",
              pricePaise: 50000,
              createdAt,
              deliveredAt: createdAt,
              // Crucial: starts unrated so the rating prompt renders.
              // The success path mutates this on /rate POSTs and the
              // next refetch (triggered by the modal's onRated → load()
              // round-trip) reflects the new rating in the row.
              rating: storedRating,
              annotationId: 1,
            },
            proName: review.proName,
            proPhoto: null,
            videoUrl: review.videoUrl,
            videoThumb: null,
            videoFps: 30,
          },
        ],
      });
    }

    if (
      method === "GET" &&
      path === `/api/swing-reviews/requests/${review.id}`
    ) {
      return respond({
        request: {
          id: review.id,
          status: "delivered",
          rating: storedRating,
          ratingComment: storedComment,
          annotationId: 1,
          deliveredAt: new Date("2026-04-29T10:00:00Z").toISOString(),
          memberPrompt: null,
        },
        video: { id: 1, videoUrl: review.videoUrl, fps: 30 },
        annotation: {
          id: 1,
          drawings: [],
          // No voice-over → the audio sync effect short-circuits and
          // stays out of this test's way; only the rating prompt is
          // exercised here.
          voiceOverUrl: null,
          voiceOverDurationSeconds: null,
          textNotes: null,
        },
        pro: {
          id: review.proId,
          displayName: review.proName,
          photoUrl: null,
        },
      });
    }

    if (
      method === "POST" &&
      path === `/api/swing-reviews/requests/${review.id}/rate`
    ) {
      if (opts.rateShouldFail) {
        return respond(
          { error: "Rating is currently disabled" },
          400,
        );
      }
      const p = (parsedBody ?? {}) as RatePayload;
      storedRating = typeof p.rating === "number" ? p.rating : null;
      storedComment =
        typeof p.comment === "string" && p.comment.length > 0
          ? p.comment
          : null;
      return respond({ ok: true });
    }

    // Anything else returns an empty 200 so a stray fetch in the page
    // doesn't reject and pollute the console.
    return respond({});
  };

  return {
    handler,
    calls,
    get rateCalls() {
      return calls.filter(
        c =>
          c.method === "POST" &&
          c.url.includes(
            `/api/swing-reviews/requests/${review.id}/rate`,
          ),
      );
    },
  };
}

const REVIEW_ID = 91;
const seed: ReviewSeed = {
  id: REVIEW_ID,
  proId: 4,
  proName: "Pro Reviewer",
  videoUrl: "https://example.test/swing-rate.mp4",
};

describe("ReviewPlaybackModal rating submission (Task #2095)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits rating + comment, hides the prompt, and reflects the new rating after a successful POST", async () => {
    const backend = buildBackend(seed);
    vi.stubGlobal(
      "fetch",
      vi.fn(backend.handler) as unknown as typeof fetch,
    );

    const user = userEvent.setup();
    render(
      <>
        <CoachMarketplacePage />
        <Toaster />
      </>,
    );

    // ── Land on the delivered review and open the playback modal ─────
    const playBtn = await screen.findByTestId(
      `button-play-review-${REVIEW_ID}`,
    );
    await user.click(playBtn);

    await screen.findByTestId("review-playback-modal");
    const form = await screen.findByTestId("review-rating-form");
    expect(form).toBeInTheDocument();

    // ── Pick a 4-star rating + leave a comment ───────────────────────
    await user.click(screen.getByTestId("button-rate-star-4"));
    await user.type(
      screen.getByTestId("input-rating-comment"),
      "Great drill suggestions, thanks!",
    );

    // ── Submit ───────────────────────────────────────────────────────
    // userEvent.click awaits the submit handler's async work (the
    // /rate POST + the setData/onRated/onClose round-trip), so the
    // modal usually unmounts before control returns. Wrap the
    // disappearance assertion in waitFor anyway so a future microtask
    // change in the handler's promise chain can't make the test flaky.
    await user.click(screen.getByTestId("button-submit-rating"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("review-rating-form"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("review-playback-modal"),
      ).not.toBeInTheDocument();
    });

    // POST hit the rate endpoint exactly once with the chosen rating
    // + comment payload.
    const rateCalls = backend.rateCalls;
    expect(rateCalls).toHaveLength(1);
    expect(rateCalls[0].body).toEqual({
      rating: 4,
      comment: "Great drill suggestions, thanks!",
    });

    // Follow-up rendering: the modal's onRated callback re-fetches
    // /my-requests, whose response now includes the persisted rating,
    // so the row gains the "You rated:" badge with the right star count.
    const ratingRow = await screen.findByTestId(
      `my-review-rating-${REVIEW_ID}`,
    );
    expect(ratingRow).toHaveTextContent("You rated:");
    expect(ratingRow.textContent ?? "").toContain("★★★★");
    // Sanity check: only 4 stars, not 5 — guards against a future
    // refactor that hard-codes a full row.
    expect(ratingRow.textContent ?? "").not.toContain("★★★★★");

    // Success toast lands in the DOM via the rendered <Toaster />.
    expect(await screen.findByText("Thanks")).toBeInTheDocument();
    expect(
      screen.getByText("Your rating has been recorded."),
    ).toBeInTheDocument();
  });

  it("shows the destructive toast and keeps the prompt visible when the server rejects the rating", async () => {
    const backend = buildBackend(seed, { rateShouldFail: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(backend.handler) as unknown as typeof fetch,
    );

    const user = userEvent.setup();
    render(
      <>
        <CoachMarketplacePage />
        <Toaster />
      </>,
    );

    const playBtn = await screen.findByTestId(
      `button-play-review-${REVIEW_ID}`,
    );
    await user.click(playBtn);

    await screen.findByTestId("review-playback-modal");
    await screen.findByTestId("review-rating-form");

    await user.click(screen.getByTestId("button-rate-star-3"));
    await user.type(
      screen.getByTestId("input-rating-comment"),
      "Helpful but a bit rushed",
    );
    await user.click(screen.getByTestId("button-submit-rating"));

    // ── Destructive toast copy lands in the DOM ──────────────────────
    expect(
      await screen.findByText("Could not submit rating"),
    ).toBeInTheDocument();
    // Description echoes the server's error body so the member knows
    // why the rating didn't take.
    expect(
      screen.getByText("Rating is currently disabled"),
    ).toBeInTheDocument();

    // ── Prompt stays visible — the modal does NOT close on failure ──
    expect(
      screen.getByTestId("review-rating-form"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("button-submit-rating"),
    ).toBeInTheDocument();

    // POST was attempted exactly once; the failure shouldn't have
    // triggered an automatic retry.
    expect(backend.rateCalls).toHaveLength(1);
    expect(backend.rateCalls[0].body).toEqual({
      rating: 3,
      comment: "Helpful but a bit rushed",
    });

    // The row in MyReviewsSection should NOT have gained a rating
    // badge — the failure path leaves storedRating null in the backend
    // stub, and the component never optimistically updates on error.
    expect(
      screen.queryByTestId(`my-review-rating-${REVIEW_ID}`),
    ).not.toBeInTheDocument();
  });
});
