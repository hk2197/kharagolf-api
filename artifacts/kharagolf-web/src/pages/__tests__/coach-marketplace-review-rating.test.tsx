/**
 * UI test (Task #1694) — covers the new web review rating flow added in
 * Task #1399. The flow lives in `ReviewPlaybackModal` inside
 * `artifacts/kharagolf-web/src/pages/coach-marketplace.tsx` and mirrors the
 * mobile flow. After watching a delivered swing review, a member can:
 *
 *   - Pick 1–5 stars (the Submit button is disabled until they do)
 *   - Type an optional comment
 *   - Submit, which POSTs to `/api/swing-reviews/requests/:id/rate`
 *     with `{ rating, comment }`
 *
 * On success the modal closes, a "Thanks" toast is shown, the row gains a
 * `data-testid="my-review-rating-${id}"` "You rated: ★★★★" label, and the
 * rating prompt (`data-testid="review-rating-form"`) never reappears for
 * that review.
 *
 * The test stubs `fetch` so the same swing-review-detail endpoint returns a
 * `null` rating before submission and the persisted `4` afterwards (mirroring
 * what the API would do once the row is updated). Toast assertions mock
 * `@/hooks/use-toast`, matching the pattern in admin-custom-domain.test.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import CoachMarketplacePage from "../coach-marketplace";

const COACH = {
  proId: 1,
  organizationId: 1,
  organizationName: "Test Club",
  displayName: "Test Coach",
  bio: null,
  photoUrl: null,
  specialisms: [],
  certifications: [],
  yearsExperience: 5,
  languages: ["en"],
  hourlyRatePaise: 500000,
  asyncReviewPricePaise: 200000,
  acceptsInPerson: true,
  acceptsAsync: true,
  asyncTurnaroundHours: 48,
  ratingsAvg: 0,
  ratingsCount: 0,
};

const REQUEST_ID = 7;

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function buildMyRequest(rating: number | null) {
  return {
    request: {
      id: REQUEST_ID,
      proId: 1,
      status: "delivered",
      pricePaise: 200000,
      createdAt: "2026-04-20T10:00:00.000Z",
      deliveredAt: "2026-04-21T10:00:00.000Z",
      rating,
      annotationId: 99,
    },
    proName: "Test Coach",
    proPhoto: null,
    videoUrl: "https://example.test/swing.mp4",
    videoThumb: null,
    videoFps: 60,
  };
}

function buildDetail(rating: number | null) {
  return {
    request: {
      id: REQUEST_ID,
      status: "delivered",
      rating,
      annotationId: 99,
      deliveredAt: "2026-04-21T10:00:00.000Z",
      memberPrompt: null,
    },
    video: { id: 33, videoUrl: "https://example.test/swing.mp4", fps: 60 },
    annotation: {
      id: 99,
      drawings: [],
      voiceOverUrl: null,
      voiceOverDurationSeconds: null,
      textNotes: "Nice tempo!",
    },
    pro: { id: 1, displayName: "Test Coach", photoUrl: null },
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

interface InstallFetchOptions {
  // When set, the POST /rate endpoint returns this failure response instead
  // of persisting the rating. Mirrors what the API does on validation/server
  // errors (e.g. POST /api/swing-reviews/requests/:id/rate returning 400 with
  // `{ error: "Already rated" }`). Used by the failure-path test (Task #2105).
  rateFailure?: { status: number; body: { error: string } };
}

function installFetch(options: InstallFetchOptions = {}) {
  const calls: FetchCall[] = [];
  // The persisted rating starts null and flips to 4 once the rate POST runs,
  // mirroring what the API does after writing the row. Subsequent reads of
  // /my-requests and /requests/:id therefore see the persisted value, which
  // is what makes the "prompt disappears once a rating exists" guarantee
  // testable on a re-open.
  let persistedRating: number | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      let parsedBody: unknown = null;
      if (typeof init?.body === "string") {
        try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
      }
      calls.push({ url, method, body: parsedBody });

      if (url.includes("/api/coach-marketplace/coaches")) {
        return jsonResponse({ coaches: [COACH] });
      }
      if (url.endsWith("/api/swing-reviews/my-requests")) {
        return jsonResponse({ requests: [buildMyRequest(persistedRating)] });
      }
      if (url.endsWith(`/api/swing-reviews/requests/${REQUEST_ID}/rate`) && method === "POST") {
        if (options.rateFailure) {
          return Promise.resolve({
            ok: false,
            status: options.rateFailure.status,
            json: () => Promise.resolve(options.rateFailure!.body),
          } as unknown as Response);
        }
        const incoming = parsedBody as { rating?: number } | null;
        if (incoming && typeof incoming.rating === "number") {
          persistedRating = incoming.rating;
        }
        return jsonResponse({ success: true });
      }
      if (url.endsWith(`/api/swing-reviews/requests/${REQUEST_ID}`)) {
        return jsonResponse(buildDetail(persistedRating));
      }
      return jsonResponse({});
    }) as unknown as typeof fetch,
  );
  return calls;
}

describe("Coach Marketplace — member review rating flow (Task #1694)", () => {
  beforeEach(() => {
    toastMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits a 4-star rating + comment, shows the toast, closes the modal, and exposes the You rated label", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    // Open the playback modal for the delivered review.
    const playBtn = await screen.findByTestId(`button-play-review-${REQUEST_ID}`);
    await user.click(playBtn);

    // The rating prompt is rendered once the detail load resolves.
    const ratingForm = await screen.findByTestId("review-rating-form");
    expect(ratingForm).toBeInTheDocument();

    // Submit is disabled until a star is picked.
    const submit = screen.getByTestId("button-submit-rating") as HTMLButtonElement;
    expect(submit).toBeDisabled();

    // Pick 4 stars.
    await user.click(screen.getByTestId("button-rate-star-4"));
    expect(submit).not.toBeDisabled();

    // Type a comment.
    const commentInput = screen.getByTestId("input-rating-comment") as HTMLTextAreaElement;
    await user.type(commentInput, "Great tips, thanks!");

    // Submit the rating.
    await user.click(submit);

    // POST /api/swing-reviews/requests/:id/rate is called with the right body.
    await waitFor(() => {
      const rateCalls = calls.filter(
        c => c.url.endsWith(`/api/swing-reviews/requests/${REQUEST_ID}/rate`) && c.method === "POST",
      );
      expect(rateCalls).toHaveLength(1);
      expect(rateCalls[0].body).toEqual({ rating: 4, comment: "Great tips, thanks!" });
    });

    // Success toast renders (we mock useToast and assert on the call).
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Thanks",
      }));
    });
    // The error/destructive variant must not have fired on the success path.
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({
      variant: "destructive",
    }));

    // Modal closes (the dialog shell is unmounted).
    await waitFor(() => {
      expect(screen.queryByTestId("review-playback-modal")).not.toBeInTheDocument();
    });

    // The row now shows the "You rated: ★★★★" label.
    const label = await screen.findByTestId(`my-review-rating-${REQUEST_ID}`);
    expect(label.textContent).toBe("You rated: ★★★★");
  });

  it("does not render the rating form when the review already has a rating", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    // Submit a rating first so the persisted value flips to 4.
    await user.click(await screen.findByTestId(`button-play-review-${REQUEST_ID}`));
    await screen.findByTestId("review-rating-form");
    await user.click(screen.getByTestId("button-rate-star-4"));
    await user.click(screen.getByTestId("button-submit-rating"));

    // Wait for the modal to close + the row label to appear before reopening.
    await screen.findByTestId(`my-review-rating-${REQUEST_ID}`);

    // Reopen the modal — the persisted rating is now 4, so the form is gone.
    await user.click(screen.getByTestId(`button-play-review-${REQUEST_ID}`));
    // Wait for the second detail GET to resolve so React has rendered the
    // "rated" branch before we assert on the absence of the form.
    await waitFor(() => {
      const detailGets = calls.filter(
        c => c.url.endsWith(`/api/swing-reviews/requests/${REQUEST_ID}`) && c.method === "GET",
      );
      expect(detailGets.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("review-rating-form")).not.toBeInTheDocument();
    });
    // Sanity: the modal is open this time around.
    expect(screen.getByTestId("review-playback-modal")).toBeInTheDocument();
  });

  // Task #2105 — failure-path coverage. The happy path above asserts the modal
  // closes and the row label appears; this test mirrors the same flow but with
  // POST /api/swing-reviews/requests/:id/rate returning a non-OK response (the
  // shape the API uses, e.g. 400 with { error: "Already rated" }). It guards
  // the destructive UX so regressions can't swallow the server message, leave
  // Submit disabled, or accidentally close the modal.
  it("on a failed rate POST: shows the destructive toast with the server error, keeps the modal open, re-enables Submit, and renders no You rated label", async () => {
    const calls = installFetch({
      rateFailure: { status: 400, body: { error: "Already rated" } },
    });
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    // Open the playback modal for the delivered review.
    const playBtn = await screen.findByTestId(`button-play-review-${REQUEST_ID}`);
    await user.click(playBtn);

    // The rating prompt is rendered once the detail load resolves.
    await screen.findByTestId("review-rating-form");

    // Pick 3 stars and submit.
    await user.click(screen.getByTestId("button-rate-star-3"));
    const submit = screen.getByTestId("button-submit-rating") as HTMLButtonElement;
    expect(submit).not.toBeDisabled();
    await user.click(submit);

    // POST /rate fired exactly once with the picked rating.
    await waitFor(() => {
      const rateCalls = calls.filter(
        c => c.url.endsWith(`/api/swing-reviews/requests/${REQUEST_ID}/rate`) && c.method === "POST",
      );
      expect(rateCalls).toHaveLength(1);
      expect(rateCalls[0].body).toEqual({ rating: 3, comment: "" });
    });

    // The destructive toast fires with the server's error text as the
    // description. The success "Thanks" toast must NOT have been shown.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Could not submit rating",
        description: "Already rated",
        variant: "destructive",
      }));
    });
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({
      title: "Thanks",
    }));

    // The modal stays open so the member can try again.
    expect(screen.getByTestId("review-playback-modal")).toBeInTheDocument();

    // Submit is re-enabled (the in-flight `submittingRating` flag has cleared,
    // and a star is still picked so the rating>0 guard also passes).
    await waitFor(() => {
      expect(
        (screen.getByTestId("button-submit-rating") as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    // The row must NOT show a "You rated" label since the rating never
    // persisted server-side.
    expect(screen.queryByTestId(`my-review-rating-${REQUEST_ID}`)).not.toBeInTheDocument();
  });
});
