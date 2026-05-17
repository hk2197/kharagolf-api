/**
 * Task #1922 — end-to-end coverage for the Plan Migration Audit reviewer
 * + source filters surviving a hard refresh.
 *
 * Task #1552 persists the `reviewerFilter` / `viaFilter` selections to the
 * URL (?reviewer=… / ?via=…) and mirrors them into localStorage so a
 * refresh, shared link, or new tab keeps the same filtered view. Until
 * now that contract was only verified by hand, leaving it open to silent
 * regressions during refactors of `super-admin.tsx`.
 *
 * This spec locks the behaviour in:
 *
 *   1. Sign in as a super admin, open the Plan Migration Audit view,
 *      pick a non-default reviewer and the "email" source, then
 *      simulate a hard refresh by unmounting and re-mounting the page
 *      against the same URL. Both filters must come back — the URL
 *      still contains `?reviewer=<id>&via=email` and the dropdown /
 *      segmented control still show the same selection.
 *   2. Re-selecting "All reviewers" and the "any" source must strip
 *      both query params from the URL again, so the canonical "no
 *      filter" view never gets pinned with `?reviewer=all&via=any`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 1, role: "super_admin" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/super-admin", vi.fn()],
}));

import SuperAdminPage from "../super-admin";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SuperAdminPage />
    </QueryClientProvider>,
  );
}

const REVIEWER_KEY = "super-admin:planMigrationsReviewerFilter";
const VIA_KEY = "super-admin:planMigrationsViaFilter";
const ORIGINAL_URL = "/super-admin";

// Two reviewers ack'd at least one row apiece. Alice (id=42) is the
// non-default selection used throughout the test; she has no rows on
// the unfiltered list (so picking her also exercises the
// "selection survives empty result set" path).
const REVIEWER_STATS = [
  { userId: 42, name: "Alice Reviewer", count: 5 },
  { userId: 43, name: "Bob Reviewer", count: 3 },
];

let fetchMock: ReturnType<typeof vi.fn>;

function installFetchMock() {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/super-admin/dashboard")) {
      return jsonResponse({
        totalClubs: 0, activeClubs: 0, totalUsers: 0, totalTournaments: 0,
        activeTournaments: 0,
        tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
        estimatedMrr: 0, bookingsThisMonth: 0, bookingRevenueThisMonth: 0,
        bookingsByClub: [],
      });
    }
    if (url.startsWith("/api/super-admin/plan-migration-audit")) {
      return jsonResponse({
        entries: [],
        total: 0,
        page: 1,
        limit: 500,
        reviewerStats: REVIEWER_STATS,
      });
    }
    if (url.startsWith("/api/super-admin/legacy-slug-mappings")) {
      return jsonResponse({ mappings: [] });
    }
    if (url.startsWith("/api/super-admin/clubs")) {
      return jsonResponse({ clubs: [], total: 0 });
    }
    if (url.startsWith("/api/super-admin/caddie-prompt-metrics")) {
      return jsonResponse({
        total: 0, windowStart: null, windowEnd: null,
        byMode: { shots: 0, rounds: 0 },
        avgEstimatedInputTokens: 0, p50EstimatedInputTokens: 0,
        p95EstimatedInputTokens: 0, maxEstimatedInputTokens: 0,
        avgTotalTrackedShots: 0, avgRoundCount: 0, recent: [],
      });
    }
    if (url.startsWith("/api/super-admin/watch-position-metrics")) {
      return jsonResponse({
        windows: {
          "24h": {
            totalMessages: 0, bucketCount: 0, activeSessionCount: 0,
            avgMessagesPerSessionMinute: 0, p50MessagesPerSessionMinute: 0,
            p95MessagesPerSessionMinute: 0, maxMessagesPerSessionMinute: 0,
          },
          "7d": {
            totalMessages: 0, bucketCount: 0, activeSessionCount: 0,
            avgMessagesPerSessionMinute: 0, p50MessagesPerSessionMinute: 0,
            p95MessagesPerSessionMinute: 0, maxMessagesPerSessionMinute: 0,
          },
          "30d": {
            totalMessages: 0, bucketCount: 0, activeSessionCount: 0,
            avgMessagesPerSessionMinute: 0, p50MessagesPerSessionMinute: 0,
            p95MessagesPerSessionMinute: 0, maxMessagesPerSessionMinute: 0,
          },
        },
        seriesByWindow: { "24h": [], "7d": [], "30d": [] },
        seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 6 * 3600 },
        recent: [],
      });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  window.history.replaceState({}, "", ORIGINAL_URL);
  window.localStorage.removeItem(REVIEWER_KEY);
  window.localStorage.removeItem(VIA_KEY);

  // jsdom doesn't implement Pointer Capture; Radix Select calls these on
  // pointer-down to decide whether to open. Without the stubs the
  // user-event click on a SelectTrigger throws and the dropdown never
  // opens, blocking the "pick a reviewer" interaction.
  if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!(Element.prototype as unknown as { releasePointerCapture?: unknown }).releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  installFetchMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  window.history.replaceState({}, "", ORIGINAL_URL);
  window.localStorage.removeItem(REVIEWER_KEY);
  window.localStorage.removeItem(VIA_KEY);
});

async function openPlanMigrationsView() {
  const user = userEvent.setup();
  // Top-of-page nav button rendered as <Button>…Plan Migrations</Button>.
  const planMigrationsBtn = screen.getByRole("button", { name: /Plan Migrations/i });
  await user.click(planMigrationsBtn);
  await waitFor(() => {
    expect(screen.getByRole("group", { name: /Filter by acknowledgement source/i })).toBeInTheDocument();
  });
  // The reviewer dropdown only renders once reviewerStats have come back
  // from the audit fetch; wait for it so callers can interact with it.
  await waitFor(() => {
    expect(screen.getByTestId("select-reviewer-filter")).toBeInTheDocument();
  });
  return user;
}

describe("Super-admin Plan Migration Audit — reviewer + via filters survive a hard refresh", () => {
  it("keeps both filters after a simulated hard refresh and mirrors them to the URL + localStorage", async () => {
    const { unmount } = renderPage();
    const user = await openPlanMigrationsView();

    // Pick the non-default reviewer (Alice).
    await user.click(screen.getByTestId("select-reviewer-filter"));
    await user.click(await screen.findByRole("option", { name: /Alice Reviewer/ }));

    // Pick the "email" source on the segmented control.
    await user.click(screen.getByTestId("button-via-email"));

    // Both selections must be mirrored into the URL...
    await waitFor(() => {
      expect(window.location.search).toContain("reviewer=42");
    });
    expect(window.location.search).toContain("via=email");

    // ...and into localStorage, so a brand-new tab also gets the same view.
    expect(window.localStorage.getItem(REVIEWER_KEY)).toBe("42");
    expect(window.localStorage.getItem(VIA_KEY)).toBe("email");

    // The audit fetch should have been issued with the matching query
    // params, proving the UI filter and the API call stay in lock-step.
    await waitFor(() => {
      const calls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/super-admin/plan-migration-audit"));
      expect(
        calls.some(
          (u) =>
            u.includes("acknowledgedByUserId=42") &&
            u.includes("acknowledgedVia=email"),
        ),
      ).toBe(true);
    });

    // Capture the URL with the chosen filters and tear the page down —
    // this is the jsdom equivalent of a hard browser refresh: the
    // address bar is preserved, the React tree is destroyed, and we
    // remount from scratch so the lazy `useState` initializers run
    // again against the current URL + localStorage.
    const refreshedUrl = `${window.location.pathname}${window.location.search}`;
    expect(refreshedUrl).toContain("reviewer=42");
    expect(refreshedUrl).toContain("via=email");
    unmount();

    renderPage();
    await openPlanMigrationsView();

    // After the refresh both controls must show the same selection...
    expect(screen.getByTestId("select-reviewer-filter")).toHaveTextContent(/Alice Reviewer/);
    const viaGroup = screen.getByRole("group", { name: /Filter by acknowledgement source/i });
    const emailButton = within(viaGroup).getByTestId("button-via-email");
    // The active button uses bg-primary; the inactive ones are bg-transparent.
    expect(emailButton.className).toContain("bg-primary");
    expect(within(viaGroup).getByTestId("button-via-any").className).not.toContain(
      "bg-primary",
    );

    // ...and the URL must still carry both params untouched.
    expect(window.location.search).toContain("reviewer=42");
    expect(window.location.search).toContain("via=email");
  });

  it("clears the URL params again when both filters are reset to their defaults", async () => {
    // Start from a deep-linked filtered view so we have something to clear.
    window.history.replaceState({}, "", "/super-admin?reviewer=42&via=email");

    renderPage();
    const user = await openPlanMigrationsView();

    // Sanity check — initial state matches the deep link.
    expect(screen.getByTestId("select-reviewer-filter")).toHaveTextContent(/Alice Reviewer/);
    expect(screen.getByTestId("button-via-email").className).toContain("bg-primary");

    // Reset the source first: pick "any" on the segmented control.
    await user.click(screen.getByTestId("button-via-any"));
    await waitFor(() => {
      expect(window.location.search).not.toContain("via=");
    });
    // Reviewer is still pinned, so the URL should still have ?reviewer=42.
    expect(window.location.search).toContain("reviewer=42");
    expect(window.localStorage.getItem(VIA_KEY)).toBeNull();

    // Now reset the reviewer dropdown back to "All reviewers".
    await user.click(screen.getByTestId("select-reviewer-filter"));
    await user.click(await screen.findByRole("option", { name: /^All reviewers$/ }));

    // The URL must be completely clean now — no `?reviewer=all&via=any`
    // left pinned, just an empty query string.
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(window.localStorage.getItem(REVIEWER_KEY)).toBeNull();
    expect(window.localStorage.getItem(VIA_KEY)).toBeNull();

    // The default "any" source button is now the active one again.
    expect(screen.getByTestId("button-via-any").className).toContain("bg-primary");
  });
});
