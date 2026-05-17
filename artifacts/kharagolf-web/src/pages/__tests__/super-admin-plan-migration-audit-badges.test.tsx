/**
 * Task #1315 — Component test that the audit panel shows the email vs
 * dashboard badge alongside the acknowledger name + timestamp.
 *
 * Task #1144 added a per-row "Email" / "Dashboard" badge plus the
 * `by <name> · <timestamp>` line on acknowledged rows in the Super Admin
 * Plan Migration Audit panel. The existing test file in this directory
 * (`super-admin-plan-migration-restore.test.tsx`) only covers the
 * restore-button flow on unacknowledged rows, so this file pins down the
 * acknowledged-row rendering with a single render that mixes all three
 * states:
 *
 *   - Row #1 — acknowledged via email, with `acknowledgedByName` set.
 *   - Row #2 — acknowledged via dashboard, with `acknowledgedByName` set.
 *   - Row #3 — unacknowledged, so the action buttons (Restore / Acknowledge)
 *     must render in place of the "Reviewed" cluster.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
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

interface MigrationEntry {
  id: number;
  organizationId: number;
  orgName: string | null;
  orgSlug: string | null;
  currentTier: string | null;
  fromTier: string | null;
  toTier: string | null;
  reason: string | null;
  createdAt: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedByUserId: number | null;
  acknowledgedByName: string | null;
  acknowledgedVia: 'email' | 'dashboard' | null;
  firstDigestedAt: string | null;
}

function makeEntry(over: Partial<MigrationEntry> & { id: number }): MigrationEntry {
  return {
    organizationId: 100 + over.id,
    orgName: `Club ${over.id}`,
    orgSlug: `club-${over.id}`,
    currentTier: "free",
    fromTier: "pro",
    toTier: "free",
    reason: "downgraded automatically",
    createdAt: "2026-04-01T00:00:00.000Z",
    acknowledged: false,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    acknowledgedByName: null,
    acknowledgedVia: null,
    firstDigestedAt: null,
    ...over,
  };
}

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

describe("Plan Migration audit panel — email vs dashboard badge + acknowledger line", () => {
  // Pinned timestamp so we can assert on the rendered "· <timestamp>" suffix
  // using the same toLocaleString() output the component uses.
  const ackedAt = "2026-04-20T12:34:56.000Z";
  const ackedAtRendered = new Date(ackedAt).toLocaleString();

  const entries: MigrationEntry[] = [
    // Row 1 — acknowledged via the digest email's one-click link.
    makeEntry({
      id: 21,
      fromTier: "pro",
      currentTier: "free",
      acknowledged: true,
      acknowledgedAt: ackedAt,
      acknowledgedByUserId: 42,
      acknowledgedByName: "Asha Reviewer",
      acknowledgedVia: "email",
    }),
    // Row 2 — acknowledged from inside the dashboard panel.
    makeEntry({
      id: 22,
      fromTier: "starter",
      currentTier: "free",
      acknowledged: true,
      acknowledgedAt: ackedAt,
      acknowledgedByUserId: 7,
      acknowledgedByName: "Mo Manager",
      acknowledgedVia: "dashboard",
    }),
    // Row 3 — still unacknowledged. The action buttons (Restore / Acknowledge)
    // must render in the right-hand cell instead of the "Reviewed" cluster.
    makeEntry({
      id: 23,
      fromTier: "pro",
      currentTier: "free",
    }),
  ];

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
        return jsonResponse({
          totalClubs: 0, activeClubs: 0, totalUsers: 0, totalTournaments: 0,
          activeTournaments: 0,
          tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
          estimatedMrr: 0, bookingsThisMonth: 0, bookingRevenueThisMonth: 0,
          bookingsByClub: [],
        });
      }
      if (url.startsWith("/api/super-admin/caddie-prompt-metrics") && method === "GET") {
        return jsonResponse({
          total: 0, windowStart: null, windowEnd: null,
          byMode: { shots: 0, rounds: 0 },
          avgEstimatedInputTokens: 0, p50EstimatedInputTokens: 0,
          p95EstimatedInputTokens: 0, maxEstimatedInputTokens: 0,
          avgTotalTrackedShots: 0, avgRoundCount: 0, recent: [],
        });
      }
      if (url.startsWith("/api/super-admin/watch-position-metrics") && method === "GET") {
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
      if (url.startsWith("/api/super-admin/legacy-slug-mappings") && method === "GET") {
        // Empty mapping table is fine — the unacknowledged row's fromTier is
        // an exact-match standard tier ("pro"), so the Restore button still
        // renders without needing a guess entry.
        return jsonResponse({ mappings: [] });
      }
      if (url.startsWith("/api/super-admin/plan-migration-audit") && method === "GET") {
        return jsonResponse({
          entries,
          total: entries.length,
          page: 1,
          limit: 500,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders Email/Dashboard badges + 'by <name> · <timestamp>' on acked rows and action buttons on the unacked row", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /plan migrations/i }));
    await screen.findByText("Club 21");

    // ─── Row 1 (Club 21) — Email badge + Asha Reviewer + timestamp ─────────
    const emailRow = screen.getByText("Club 21").closest("tr") as HTMLElement;
    expect(emailRow).toBeTruthy();
    const emailScope = within(emailRow);

    expect(emailScope.getByText(/Reviewed/i)).toBeInTheDocument();
    expect(emailScope.getByText(/^Email$/)).toBeInTheDocument();
    // The Dashboard badge must NOT appear on this row.
    expect(emailScope.queryByText(/^Dashboard$/)).toBeNull();
    // The acknowledger line: "by Asha Reviewer · <timestamp>".
    expect(
      emailScope.getByText(
        (_, node) => node?.textContent === `by Asha Reviewer · ${ackedAtRendered}`,
      ),
    ).toBeInTheDocument();
    // Acknowledged rows must not show action buttons.
    expect(emailScope.queryByRole("button", { name: /Restore to/i })).toBeNull();
    expect(emailScope.queryByRole("button", { name: /Acknowledge/i })).toBeNull();

    // ─── Row 2 (Club 22) — Dashboard badge + Mo Manager + timestamp ────────
    const dashRow = screen.getByText("Club 22").closest("tr") as HTMLElement;
    expect(dashRow).toBeTruthy();
    const dashScope = within(dashRow);

    expect(dashScope.getByText(/Reviewed/i)).toBeInTheDocument();
    expect(dashScope.getByText(/^Dashboard$/)).toBeInTheDocument();
    // The Email badge must NOT appear on this row.
    expect(dashScope.queryByText(/^Email$/)).toBeNull();
    expect(
      dashScope.getByText(
        (_, node) => node?.textContent === `by Mo Manager · ${ackedAtRendered}`,
      ),
    ).toBeInTheDocument();
    expect(dashScope.queryByRole("button", { name: /Restore to/i })).toBeNull();
    expect(dashScope.queryByRole("button", { name: /Acknowledge/i })).toBeNull();

    // ─── Row 3 (Club 23) — unacknowledged, action buttons rendered ─────────
    const unackRow = screen.getByText("Club 23").closest("tr") as HTMLElement;
    expect(unackRow).toBeTruthy();
    const unackScope = within(unackRow);

    // No Reviewed / Email / Dashboard rendering on the unacked row.
    expect(unackScope.queryByText(/Reviewed/i)).toBeNull();
    expect(unackScope.queryByText(/^Email$/)).toBeNull();
    expect(unackScope.queryByText(/^Dashboard$/)).toBeNull();
    // No "by ..." acknowledger line.
    expect(unackScope.queryByText(/^by /)).toBeNull();
    // Both action buttons should still be available on the unacked row.
    expect(unackScope.getByRole("button", { name: /Restore to pro/i })).toBeInTheDocument();
    expect(unackScope.getByRole("button", { name: /Acknowledge/i })).toBeInTheDocument();
  });

  // Task #1562 — Anonymous-reviewer fallback. Legacy rows that were
  // acknowledged before the digest started capturing reviewer names will
  // come back from the API with `acknowledgedByName: null` but a real
  // `acknowledgedByUserId`. The acknowledger line must fall back to
  // `by user #<id>` instead of silently rendering an empty "by " string.
  it("falls back to 'by user #<id>' when acknowledgedByName is null but the user id is set", async () => {
    // Override the per-test entries with a single legacy-style row.
    const legacyAckedAt = "2026-04-22T08:15:30.000Z";
    const legacyAckedAtRendered = new Date(legacyAckedAt).toLocaleString();
    const legacyEntries: MigrationEntry[] = [
      makeEntry({
        id: 31,
        fromTier: "pro",
        currentTier: "free",
        acknowledged: true,
        acknowledgedAt: legacyAckedAt,
        acknowledgedByUserId: 99,
        acknowledgedByName: null,
        acknowledgedVia: "dashboard",
      }),
    ];

    // Re-stub fetch so the audit endpoint returns the legacy row instead of
    // the default `entries` array used by the happy-path test above.
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
        return jsonResponse({
          totalClubs: 0, activeClubs: 0, totalUsers: 0, totalTournaments: 0,
          activeTournaments: 0,
          tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
          estimatedMrr: 0, bookingsThisMonth: 0, bookingRevenueThisMonth: 0,
          bookingsByClub: [],
        });
      }
      if (url.startsWith("/api/super-admin/caddie-prompt-metrics") && method === "GET") {
        return jsonResponse({
          total: 0, windowStart: null, windowEnd: null,
          byMode: { shots: 0, rounds: 0 },
          avgEstimatedInputTokens: 0, p50EstimatedInputTokens: 0,
          p95EstimatedInputTokens: 0, maxEstimatedInputTokens: 0,
          avgTotalTrackedShots: 0, avgRoundCount: 0, recent: [],
        });
      }
      if (url.startsWith("/api/super-admin/watch-position-metrics") && method === "GET") {
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
      if (url.startsWith("/api/super-admin/legacy-slug-mappings") && method === "GET") {
        return jsonResponse({ mappings: [] });
      }
      if (url.startsWith("/api/super-admin/plan-migration-audit") && method === "GET") {
        return jsonResponse({
          entries: legacyEntries,
          total: legacyEntries.length,
          page: 1,
          limit: 500,
        });
      }
      return jsonResponse({});
    });

    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /plan migrations/i }));
    await screen.findByText("Club 31");

    const legacyRow = screen.getByText("Club 31").closest("tr") as HTMLElement;
    expect(legacyRow).toBeTruthy();
    const legacyScope = within(legacyRow);

    // The row must still render as acknowledged.
    expect(legacyScope.getByText(/Reviewed/i)).toBeInTheDocument();

    // The acknowledger line must fall back to the user-id form, with the
    // timestamp suffix preserved. We assert on the full text so that an
    // empty "by " (regression) would fail this test.
    expect(
      legacyScope.getByText(
        (_, node) => node?.textContent === `by user #99 · ${legacyAckedAtRendered}`,
      ),
    ).toBeInTheDocument();

    // Sanity: the literal "by " (with nothing after) must not be the row's
    // acknowledger text — i.e. the fallback didn't silently degrade.
    expect(
      legacyScope.queryByText(
        (_, node) => node?.textContent === "by " || node?.textContent === "by  · ",
      ),
    ).toBeNull();
  });
});
