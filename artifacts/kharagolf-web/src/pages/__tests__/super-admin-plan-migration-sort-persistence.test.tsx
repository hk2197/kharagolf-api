/**
 * Task #1929 — the Plan Migration Audit panel's sort toggle ("Oldest first" /
 * "Newest first") must remember its state between visits, mirroring the
 * reviewer / via / show-acknowledged persistence added by Tasks #1552 and
 * #1921. Default is "Oldest first" so the grey → amber → red age cue from
 * Task #1550 actually drives triage order on the first load.
 *
 * This test pins down:
 *
 *   1. With no URL / storage hints the panel boots in oldest-first mode and
 *      the very first audit fetch carries no `sort=` query param (server
 *      defaults to oldest, so we keep the URL clean).
 *   2. A direct link with `?sort=newest` opens the panel pre-flipped and
 *      the very first request includes `sort=newest` — admins sharing a
 *      deep-link must not see an oldest-first round-trip first.
 *   3. Clicking the toggle mirrors the new state into both the URL and the
 *      `super-admin:planMigrationsSort` localStorage key.
 *   4. Toggling back to the default (oldest) cleans the URL up entirely
 *      instead of pinning `?sort=oldest` forever, and clears the storage
 *      entry.
 *   5. URL takes precedence over localStorage when both are set.
 *   6. Garbage URL values fall back to the next source rather than crashing.
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

const SORT_KEY = "super-admin:planMigrationsSort";
const ORIGINAL_URL = "/super-admin";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.history.replaceState({}, "", ORIGINAL_URL);
  window.localStorage.removeItem(SORT_KEY);

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
      return jsonResponse({ entries: [], total: 0, page: 1, limit: 500 });
    }
    if (url.startsWith("/api/super-admin/legacy-slug-mappings")) {
      return jsonResponse({ mappings: [] });
    }
    if (url.startsWith("/api/super-admin/watch-position-metrics")) {
      const emptyWindow = {
        totalMessages: 0, bucketCount: 0, activeSessionCount: 0,
        avgMessagesPerSessionMinute: 0, p50MessagesPerSessionMinute: 0,
        p95MessagesPerSessionMinute: 0, maxMessagesPerSessionMinute: 0,
      };
      return jsonResponse({
        windows: { "24h": emptyWindow, "7d": emptyWindow, "30d": emptyWindow },
        seriesByWindow: { "24h": [], "7d": [], "30d": [] },
        seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 86400 },
        recent: [],
      });
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
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  window.history.replaceState({}, "", ORIGINAL_URL);
  window.localStorage.removeItem(SORT_KEY);
});

async function openMigrationsView() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /plan migrations/i }));
  await waitFor(() => {
    expect(screen.getByTestId("button-sort-oldest")).toBeInTheDocument();
  });
  return user;
}

function getMigrationAuditCalls() {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith("/api/super-admin/plan-migration-audit"));
}

function isActive(button: HTMLElement) {
  return button.className.includes("bg-primary");
}

describe("Super-admin plan migrations — sort toggle persists between visits", () => {
  it("defaults to oldest-first and the first audit fetch carries no sort= param", async () => {
    renderPage();
    await openMigrationsView();

    expect(isActive(screen.getByTestId("button-sort-oldest"))).toBe(true);
    expect(isActive(screen.getByTestId("button-sort-newest"))).toBe(false);

    await waitFor(() => {
      const calls = getMigrationAuditCalls();
      expect(calls.length).toBeGreaterThan(0);
      // Server default is oldest, so the URL stays clean for the common case.
      expect(calls.every((u) => !u.includes("sort="))).toBe(true);
    });
    expect(window.location.search).toBe("");
  });

  it("seeds initial state from a deep-link query string (?sort=newest)", async () => {
    window.history.replaceState({}, "", "/super-admin?sort=newest");

    renderPage();
    await openMigrationsView();

    expect(isActive(screen.getByTestId("button-sort-newest"))).toBe(true);

    // Very first audit request must already include the flag — no
    // oldest-first round-trip leaks through for deep-linked admins.
    await waitFor(() => {
      const calls = getMigrationAuditCalls();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((u) => u.includes("sort=newest"))).toBe(true);
    });
  });

  it("falls back to localStorage when the URL has no value", async () => {
    window.localStorage.setItem(SORT_KEY, "newest");

    renderPage();
    await openMigrationsView();

    expect(isActive(screen.getByTestId("button-sort-newest"))).toBe(true);

    // The mirror effect should re-stamp the URL so a refresh keeps a
    // shareable deep-link.
    await waitFor(() => {
      expect(window.location.search).toContain("sort=newest");
    });
  });

  it("URL takes precedence over a stored localStorage value", async () => {
    // Stored = newest, URL explicitly = oldest → URL wins.
    window.localStorage.setItem(SORT_KEY, "newest");
    window.history.replaceState({}, "", "/super-admin?sort=oldest");

    renderPage();
    await openMigrationsView();

    expect(isActive(screen.getByTestId("button-sort-oldest"))).toBe(true);

    // The mirror effect should clean the explicit `=oldest` out of the URL —
    // the oldest default is represented by the absence of the param.
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(window.localStorage.getItem(SORT_KEY)).toBeNull();
  });

  it("garbage URL values (e.g. ?sort=foo) fall back to localStorage rather than crashing", async () => {
    window.localStorage.setItem(SORT_KEY, "newest");
    window.history.replaceState({}, "", "/super-admin?sort=carrier-pigeon");

    renderPage();
    await openMigrationsView();

    expect(isActive(screen.getByTestId("button-sort-newest"))).toBe(true);
    await waitFor(() => {
      expect(window.location.search).toContain("sort=newest");
    });
    expect(window.location.search).not.toContain("carrier-pigeon");
  });

  it("clicking the toggle mirrors into URL + localStorage and clicking back cleans both", async () => {
    renderPage();
    const user = await openMigrationsView();

    expect(window.location.search).toBe("");
    expect(window.localStorage.getItem(SORT_KEY)).toBeNull();

    // Flip to newest.
    await user.click(screen.getByTestId("button-sort-newest"));

    await waitFor(() => {
      expect(window.location.search).toContain("sort=newest");
    });
    expect(window.localStorage.getItem(SORT_KEY)).toBe("newest");

    // Audit request must re-fire with the flag on.
    await waitFor(() => {
      const calls = getMigrationAuditCalls();
      expect(calls.some((u) => u.includes("sort=newest"))).toBe(true);
    });

    // Flip back to oldest. URL must be clean (no `?sort=oldest`) and
    // the localStorage entry must be cleared.
    await user.click(screen.getByTestId("button-sort-oldest"));
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(window.localStorage.getItem(SORT_KEY)).toBeNull();
  });

  it("a fresh mount with a clean URL restores the last toggle from localStorage", async () => {
    renderPage();
    let user = await openMigrationsView();

    await user.click(screen.getByTestId("button-sort-newest"));
    await waitFor(() => {
      expect(window.localStorage.getItem(SORT_KEY)).toBe("newest");
    });

    cleanup();
    window.history.replaceState({}, "", ORIGINAL_URL);

    renderPage();
    user = await openMigrationsView();

    expect(isActive(screen.getByTestId("button-sort-newest"))).toBe(true);
  });
});
