/**
 * Task #1941 — the "Acknowledged by …" reviewer dropdown in the Plan
 * Migration Audit panel must be sorted by acknowledgement count
 * descending, with name ascending as a tie-breaker. Reviewers with zero
 * rows (e.g. the currently-selected reviewer that has no remaining
 * entries) sort last, but the currently-selected reviewer must still be
 * present in the list.
 *
 * Previously the dropdown was sorted alphabetically, which forced admins
 * to scan the whole list to see who was carrying the audit load.
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

const ORIGINAL_URL = "/super-admin";

// Crafted to exercise the full sort contract:
//   • Bob (count=10) is alphabetically last but should appear first.
//   • Alice (count=5) comes next.
//   • Carol & Dave both have count=3 — Carol wins on the alphabetical
//     tie-breaker.
//   • Zach (count=0) sorts dead last even though he'd be alphabetically
//     last anyway; the assertion below also verifies he comes after the
//     count=3 pair.
const REVIEWER_STATS = [
  { userId: 11, name: "Carol Reviewer", count: 3 },
  { userId: 12, name: "Alice Reviewer", count: 5 },
  { userId: 13, name: "Bob Reviewer", count: 10 },
  { userId: 14, name: "Dave Reviewer", count: 3 },
  { userId: 15, name: "Zach Reviewer", count: 0 },
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

  // jsdom doesn't implement Pointer Capture; Radix Select needs these to
  // open on click in tests.
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
});

async function openPlanMigrationsView() {
  const user = userEvent.setup();
  const planMigrationsBtn = screen.getByRole("button", { name: /Plan Migrations/i });
  await user.click(planMigrationsBtn);
  await waitFor(() => {
    expect(screen.getByRole("group", { name: /Filter by acknowledgement source/i })).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByTestId("select-reviewer-filter")).toBeInTheDocument();
  });
  return user;
}

describe("Super-admin Plan Migration Audit — reviewer dropdown sort order (Task #1941)", () => {
  it("sorts reviewers by ack count descending, with name ascending as the tie-breaker", async () => {
    renderPage();
    const user = await openPlanMigrationsView();

    await user.click(screen.getByTestId("select-reviewer-filter"));

    const listbox = await screen.findByRole("listbox");
    const reviewerOptions = within(listbox)
      .getAllByRole("option")
      // Drop the static "All reviewers" sentinel — only count the
      // dynamic per-reviewer rows.
      .filter(opt => /Reviewer/.test(opt.textContent ?? ""));

    const orderedNames = reviewerOptions.map(opt => {
      const match = (opt.textContent ?? "").match(/[A-Z][a-z]+ Reviewer/);
      return match ? match[0] : "";
    });

    expect(orderedNames).toEqual([
      "Bob Reviewer",   // count 10
      "Alice Reviewer", // count 5
      "Carol Reviewer", // count 3, name asc beats Dave
      "Dave Reviewer",  // count 3
      "Zach Reviewer",  // count 0 — dead last
    ]);
  });
});
