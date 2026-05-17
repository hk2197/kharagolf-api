/**
 * Task #1921 — the Plan Migration Audit panel's "Show acknowledged" toggle
 * must remember its state between visits, the same way the reviewer / via
 * filters were persisted in Task #1552. Before the fix, the checkbox was a
 * plain `useState(false)` and reset on every reload, so an admin who
 * routinely reviewed acknowledged history had to re-check it every session
 * and could not share a deep-link to the "include acknowledged" view.
 *
 * This test pins down the new behaviour:
 *
 *   1. A direct link with `?showAcknowledged=1` opens the panel with the
 *      checkbox already ticked, no clicks needed, AND fetches the audit
 *      list with `includeAcknowledged=1` on the very first request.
 *   2. Toggling the checkbox mirrors the new state into the URL
 *      (`?showAcknowledged=1`) and into the
 *      `super-admin:planMigrationsShowAcknowledged` localStorage key.
 *   3. A fresh mount (clean URL but localStorage retained) restores the
 *      last selection.
 *   4. Switching back to the default (off) cleans the query string up
 *      entirely instead of pinning `?showAcknowledged=0` on the URL
 *      forever, and clears the localStorage entry.
 *   5. The URL takes precedence over localStorage when both are set,
 *      so deep-linked views are deterministic.
 *   6. Garbage URL values (e.g. `?showAcknowledged=foo`) are ignored and
 *      we fall back to the next source rather than crashing.
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

const SHOW_ACK_KEY = "super-admin:planMigrationsShowAcknowledged";
const ORIGINAL_URL = "/super-admin";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.history.replaceState({}, "", ORIGINAL_URL);
  window.localStorage.removeItem(SHOW_ACK_KEY);

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
  window.localStorage.removeItem(SHOW_ACK_KEY);
});

async function openMigrationsView() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /plan migrations/i }));
  await waitFor(() => {
    expect(screen.getByRole("checkbox", { name: /show acknowledged/i })).toBeInTheDocument();
  });
  return user;
}

function getCheckbox() {
  return screen.getByRole("checkbox", { name: /show acknowledged/i }) as HTMLInputElement;
}

function getMigrationAuditCalls() {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith("/api/super-admin/plan-migration-audit"));
}

describe('Super-admin plan migrations — "Show acknowledged" toggle persists between visits', () => {
  it("seeds initial state from a deep-link query string (?showAcknowledged=1)", async () => {
    window.history.replaceState({}, "", "/super-admin?showAcknowledged=1");

    renderPage();
    await openMigrationsView();

    expect(getCheckbox().checked).toBe(true);

    // The very first audit request must already include the flag — admins
    // sharing a deep-link should not see an "off" round-trip first.
    await waitFor(() => {
      const calls = getMigrationAuditCalls();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((u) => u.includes("includeAcknowledged=1"))).toBe(true);
    });
  });

  it("falls back to localStorage when the URL has no value, and to the off default when neither is set", async () => {
    window.localStorage.setItem(SHOW_ACK_KEY, "1");

    renderPage();
    await openMigrationsView();

    expect(getCheckbox().checked).toBe(true);

    // The URL should be re-stamped from the restored state so a refresh
    // keeps producing a shareable link.
    await waitFor(() => {
      expect(window.location.search).toContain("showAcknowledged=1");
    });

    // Now wipe storage + URL and remount to confirm the off default.
    cleanup();
    window.localStorage.removeItem(SHOW_ACK_KEY);
    window.history.replaceState({}, "", ORIGINAL_URL);

    renderPage();
    await openMigrationsView();

    expect(getCheckbox().checked).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("URL takes precedence over a stored localStorage value", async () => {
    // Stored = on, URL explicitly = off → URL wins, checkbox stays off.
    window.localStorage.setItem(SHOW_ACK_KEY, "1");
    window.history.replaceState({}, "", "/super-admin?showAcknowledged=0");

    renderPage();
    await openMigrationsView();

    expect(getCheckbox().checked).toBe(false);

    // The mirror effect should clean the explicit `=0` out of the URL —
    // the off default is represented by the absence of the param.
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(window.localStorage.getItem(SHOW_ACK_KEY)).toBeNull();
  });

  it("garbage URL values (e.g. ?showAcknowledged=foo) fall back to localStorage rather than crashing", async () => {
    window.localStorage.setItem(SHOW_ACK_KEY, "1");
    window.history.replaceState({}, "", "/super-admin?showAcknowledged=foo");

    renderPage();
    await openMigrationsView();

    // Garbage URL ignored → stored "1" wins → checkbox is on.
    expect(getCheckbox().checked).toBe(true);
    // The stamped URL replaces the garbage with the canonical "1".
    await waitFor(() => {
      expect(window.location.search).toContain("showAcknowledged=1");
    });
    expect(window.location.search).not.toContain("foo");
  });

  it("toggling the checkbox mirrors into URL + localStorage and toggling back cleans both", async () => {
    renderPage();
    const user = await openMigrationsView();

    expect(getCheckbox().checked).toBe(false);
    expect(window.location.search).toBe("");
    expect(window.localStorage.getItem(SHOW_ACK_KEY)).toBeNull();

    // Tick the checkbox → on.
    await user.click(getCheckbox());

    await waitFor(() => {
      expect(window.location.search).toContain("showAcknowledged=1");
    });
    expect(window.localStorage.getItem(SHOW_ACK_KEY)).toBe("1");

    // The audit request should fire again with the flag on.
    await waitFor(() => {
      const calls = getMigrationAuditCalls();
      expect(calls.some((u) => u.includes("includeAcknowledged=1"))).toBe(true);
    });

    // Untick → back to default. URL must be empty (no `?showAcknowledged=0`)
    // and the localStorage entry must be cleared.
    await user.click(getCheckbox());
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(window.localStorage.getItem(SHOW_ACK_KEY)).toBeNull();
  });

  it("a fresh mount with a clean URL restores the last toggle from localStorage", async () => {
    renderPage();
    let user = await openMigrationsView();

    // Tick + remount to simulate a "new tab / refresh" with the URL wiped
    // (e.g. user typed the bare /super-admin path back into the address bar).
    await user.click(getCheckbox());
    await waitFor(() => {
      expect(window.localStorage.getItem(SHOW_ACK_KEY)).toBe("1");
    });

    cleanup();
    window.history.replaceState({}, "", ORIGINAL_URL);

    renderPage();
    user = await openMigrationsView();

    expect(getCheckbox().checked).toBe(true);
  });
});
