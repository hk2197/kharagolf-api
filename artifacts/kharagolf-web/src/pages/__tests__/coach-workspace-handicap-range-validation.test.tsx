/**
 * UI test (Task #2013) — the coach Profile editor must guard against
 * inverted Min/Max handicap windows. Without the guard a coach who
 * fat-fingers Min=20/Max=5 would silently save that, after which the
 * marketplace `?handicap=` filter (which requires both bounds to match)
 * would never include them at any handicap.
 *
 * The Save button is disabled and an inline error appears when Min > Max.
 * One-sided ranges (blank min OR blank max) and equal bounds remain valid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import CoachWorkspacePage from "@/pages/coach-workspace";

const PRO = {
  id: 42,
  displayName: "Test Coach",
  bio: null,
  organizationId: 1,
  specialisms: [],
};

const PROFILE = {
  isListed: true,
  certifications: [],
  yearsExperience: 5,
  languages: ["en"],
  hourlyRatePaise: 500000,
  asyncReviewPricePaise: 200000,
  acceptsInPerson: true,
  acceptsAsync: true,
  asyncTurnaroundHours: 48,
  revenueSharePct: "70",
  ratingsAvg: "0",
  ratingsCount: 0,
  coachesHandicapMin: 5,
  coachesHandicapMax: 20,
  payoutMethod: null,
  payoutAccountId: null,
  payoutAccountHolderName: null,
  payoutVpa: null,
  payoutBankAccountNumber: null,
  payoutBankIfsc: null,
  payoutVerificationStatus: null,
  payoutVerificationFailureReason: null,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }) as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/coach-marketplace/me/coach-profile")) {
      return jsonResponse({ pro: PRO, profile: PROFILE });
    }
    if (url.startsWith("/api/coach-marketplace/me/payout-account/history")) {
      return jsonResponse({ history: [] });
    }
    if (url.endsWith("/api/coach-marketplace/me/payout-account/notification-history")) {
      return jsonResponse({ entries: [] });
    }
    if (url.endsWith("/api/swing-reviews/coach/queue")) {
      return jsonResponse({ queue: [] });
    }
    if (url.endsWith("/api/swing-reviews/coach/earnings")) {
      return jsonResponse({
        summary: {
          lifetimeEarningsPaise: 0, deliveredCount: 0,
          pendingPayoutPaise: 0, unpaidCount: 0,
        },
        sharePct: 70, payouts: [],
      });
    }
    if (url.endsWith("/api/swing-reviews/coach/notifications")) {
      return jsonResponse({ notifications: [] });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoachWorkspacePage ProfileTab handicap range validation (Task #2013)", () => {
  it("shows inline error and disables Save when Min > Max, then clears once fixed", async () => {
    render(<CoachWorkspacePage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Profile/i }));

    const minInput = await screen.findByTestId("input-coaches-handicap-min") as HTMLInputElement;
    const maxInput = screen.getByTestId("input-coaches-handicap-max") as HTMLInputElement;
    const saveBtn = screen.getByTestId("button-save-coach-profile") as HTMLButtonElement;

    // Initial state: range is valid (5..20) — no error, Save enabled.
    expect(screen.queryByTestId("error-coaches-handicap-range")).toBeNull();
    expect(saveBtn.disabled).toBe(false);

    // Invert the range: Min=20, Max=5.
    fireEvent.change(minInput, { target: { value: "20" } });
    fireEvent.change(maxInput, { target: { value: "5" } });

    await waitFor(() => {
      expect(screen.getByTestId("error-coaches-handicap-range"))
        .toHaveTextContent(/Min handicap must be less than or equal to Max handicap/i);
    });
    expect(saveBtn.disabled).toBe(true);

    // Save attempts must not POST to the profile endpoint while the
    // button is disabled — even if a programmatic click slips through,
    // the handler bails out before fetching.
    const profilePostsBeforeFix = fetchMock.mock.calls
      .map(([input, init]) => ({ url: typeof input === "string" ? input : String(input), init }))
      .filter(c => c.url.endsWith("/api/coach-marketplace/pros/42/profile")
        && (c.init as RequestInit | undefined)?.method === "POST");
    expect(profilePostsBeforeFix).toHaveLength(0);

    // Fix the range: Min=5, Max=20 again — error clears, Save re-enables.
    fireEvent.change(minInput, { target: { value: "5" } });
    fireEvent.change(maxInput, { target: { value: "20" } });

    await waitFor(() => {
      expect(screen.queryByTestId("error-coaches-handicap-range")).toBeNull();
    });
    expect(saveBtn.disabled).toBe(false);
  });

  it("treats equal bounds (Min == Max) and one-sided ranges as valid", async () => {
    render(<CoachWorkspacePage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Profile/i }));

    const minInput = await screen.findByTestId("input-coaches-handicap-min") as HTMLInputElement;
    const maxInput = screen.getByTestId("input-coaches-handicap-max") as HTMLInputElement;
    const saveBtn = screen.getByTestId("button-save-coach-profile") as HTMLButtonElement;

    // Equal bounds.
    fireEvent.change(minInput, { target: { value: "10" } });
    fireEvent.change(maxInput, { target: { value: "10" } });
    await waitFor(() => {
      expect(screen.queryByTestId("error-coaches-handicap-range")).toBeNull();
    });
    expect(saveBtn.disabled).toBe(false);

    // Blank min (no lower limit), max set — one-sided, still valid.
    fireEvent.change(minInput, { target: { value: "" } });
    fireEvent.change(maxInput, { target: { value: "5" } });
    await waitFor(() => {
      expect(screen.queryByTestId("error-coaches-handicap-range")).toBeNull();
    });
    expect(saveBtn.disabled).toBe(false);

    // Min set, blank max (no upper limit) — one-sided, still valid.
    fireEvent.change(minInput, { target: { value: "20" } });
    fireEvent.change(maxInput, { target: { value: "" } });
    await waitFor(() => {
      expect(screen.queryByTestId("error-coaches-handicap-range")).toBeNull();
    });
    expect(saveBtn.disabled).toBe(false);
  });
});
