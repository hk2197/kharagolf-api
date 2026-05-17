/**
 * Task #1661 — the super-admin "Clubs" list must remember the search
 * box and the tier/status filter selections between visits, the same
 * way the Watch GPS window selector now does (Task #1383). Before the
 * fix, the three controls were plain `useState('')` / `useState('all')`
 * and reset on every reload, so an ops user filtering "show me only
 * Pro clubs that are inactive" had to re-pick the filters every time
 * and could not share a deep-link to the filtered view.
 *
 * This test pins down the new behaviour:
 *
 *   1. A direct link with `?q=acme&tier=pro&status=active` opens the
 *      Clubs view with those values already populated, no clicks needed.
 *   2. Typing in the search box, picking a tier, and picking a status
 *      mirrors the choices into the URL via `history.replaceState` AND
 *      into `super-admin:clubsSearch` / `clubsTierFilter` /
 *      `clubsStatusFilter` localStorage entries.
 *   3. A fresh mount (clean URL but localStorage retained) restores
 *      the last selection.
 *   4. Switching back to the defaults (empty search, "all" filters)
 *      cleans the query string up entirely instead of pinning
 *      `?tier=all&status=all` on the URL forever.
 *   5. The URL takes precedence over localStorage when both are set,
 *      so deep-linked filter views are deterministic.
 *   6. Garbage URL values (e.g. `?tier=foo`) are ignored and we fall
 *      back to the next source rather than crashing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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

const SEARCH_KEY = "super-admin:clubsSearch";
const TIER_KEY = "super-admin:clubsTierFilter";
const STATUS_KEY = "super-admin:clubsStatusFilter";
const ORIGINAL_URL = "/super-admin";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.history.replaceState({}, "", ORIGINAL_URL);
  window.localStorage.removeItem(SEARCH_KEY);
  window.localStorage.removeItem(TIER_KEY);
  window.localStorage.removeItem(STATUS_KEY);

  // jsdom doesn't implement Pointer Capture; Radix Select calls these on
  // pointer-down to decide whether to open. Without these stubs, the
  // user-event click on a SelectTrigger throws and the dropdown never
  // opens, blocking the "pick a filter" interactions.
  if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!(Element.prototype as unknown as { releasePointerCapture?: unknown }).releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  window.history.replaceState({}, "", ORIGINAL_URL);
  window.localStorage.removeItem(SEARCH_KEY);
  window.localStorage.removeItem(TIER_KEY);
  window.localStorage.removeItem(STATUS_KEY);
});

async function openClubsView() {
  const user = userEvent.setup();
  // The Clubs nav button is rendered with "Clubs" inside it.
  const clubsBtn = screen.getByRole("button", { name: /Clubs/i });
  await user.click(clubsBtn);
  await waitFor(() => {
    expect(screen.getByTestId("input-clubs-search")).toBeInTheDocument();
  });
  return user;
}

describe("Super-admin Clubs — search + tier/status filters persist between visits", () => {
  it("seeds initial state from a deep-link query string (?q=acme&tier=pro&status=active)", async () => {
    window.history.replaceState({}, "", "/super-admin?q=acme&tier=pro&status=active");

    renderPage();
    await openClubsView();

    const searchInput = screen.getByTestId("input-clubs-search") as HTMLInputElement;
    expect(searchInput.value).toBe("acme");

    // The Select trigger renders the chosen option label inside its content.
    expect(screen.getByTestId("select-clubs-tier")).toHaveTextContent(/Pro/);
    expect(screen.getByTestId("select-clubs-status")).toHaveTextContent(/Active/);

    // The clubs API call should have been issued with those filters.
    await waitFor(() => {
      const calls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/super-admin/clubs"));
      expect(
        calls.some((u) =>
          u.includes("search=acme") && u.includes("tier=pro") && u.includes("status=active"),
        ),
      ).toBe(true);
    });
  });

  it("falls back from garbage URL values to localStorage, then to defaults", async () => {
    // localStorage has a valid tier; URL has a bogus tier; status not in URL or localStorage.
    window.localStorage.setItem(TIER_KEY, "starter");
    window.history.replaceState({}, "", "/super-admin?tier=bogus");

    renderPage();
    await openClubsView();

    expect(screen.getByTestId("select-clubs-tier")).toHaveTextContent(/Starter/);
    expect(screen.getByTestId("select-clubs-status")).toHaveTextContent(/All status/);
  });

  it("URL takes precedence over a stored localStorage value", async () => {
    window.localStorage.setItem(TIER_KEY, "starter");
    window.history.replaceState({}, "", "/super-admin?tier=enterprise");

    renderPage();
    await openClubsView();

    expect(screen.getByTestId("select-clubs-tier")).toHaveTextContent(/Enterprise/);
  });

  it("typing in search mirrors the value into the URL and localStorage", async () => {
    renderPage();
    const user = await openClubsView();

    const searchInput = screen.getByTestId("input-clubs-search");
    await user.type(searchInput, "acme");

    await waitFor(() => {
      expect(window.location.search).toContain("q=acme");
    });
    expect(window.localStorage.getItem(SEARCH_KEY)).toBe("acme");

    // Clearing the search wipes the key out of both stores.
    await user.clear(searchInput);
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(window.localStorage.getItem(SEARCH_KEY)).toBeNull();
  });

  it("picking a tier and status mirrors them, and switching back to defaults cleans the URL", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    await openClubsView();

    // Open the tier select and pick "Pro".
    await user.click(screen.getByTestId("select-clubs-tier"));
    await user.click(await screen.findByRole("option", { name: /^Pro$/ }));

    // Open the status select and pick "Suspended".
    await user.click(screen.getByTestId("select-clubs-status"));
    await user.click(await screen.findByRole("option", { name: /^Suspended$/ }));

    await waitFor(() => {
      expect(window.location.search).toContain("tier=pro");
    });
    expect(window.location.search).toContain("status=suspended");
    expect(window.localStorage.getItem(TIER_KEY)).toBe("pro");
    expect(window.localStorage.getItem(STATUS_KEY)).toBe("suspended");

    // Switching back to "All tiers" / "All status" strips the params
    // entirely (no `?tier=all` left pinned to the URL).
    await user.click(screen.getByTestId("select-clubs-tier"));
    await user.click(await screen.findByRole("option", { name: /^All tiers$/ }));
    await user.click(screen.getByTestId("select-clubs-status"));
    await user.click(await screen.findByRole("option", { name: /^All status$/ }));

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(window.localStorage.getItem(TIER_KEY)).toBeNull();
    expect(window.localStorage.getItem(STATUS_KEY)).toBeNull();

    // Now pick Pro again so we can prove a fresh mount with a clean
    // URL still restores the choice from localStorage.
    await user.click(screen.getByTestId("select-clubs-tier"));
    await user.click(await screen.findByRole("option", { name: /^Pro$/ }));
    await waitFor(() => {
      expect(window.localStorage.getItem(TIER_KEY)).toBe("pro");
    });

    unmount();
    window.history.replaceState({}, "", ORIGINAL_URL);

    renderPage();
    await openClubsView();

    expect(screen.getByTestId("select-clubs-tier")).toHaveTextContent(/Pro/);
  });
});
