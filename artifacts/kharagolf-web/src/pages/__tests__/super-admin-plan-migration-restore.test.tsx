/**
 * Task #1132 — Plan Migration "Restore to <tier>" flow tests.
 *
 * Covers two halves:
 *   1. Unit tests for `mapToRecognisedTier` — exact, guess, unknown, invalid.
 *   2. A component-level test of the audit panel's restore button:
 *      - Exact-match rows render "Restore to <tier>" and skip the prompt.
 *      - Legacy-slug rows render "Restore to <tier> (best guess)", show the
 *        confirmation prompt, and only fire the restore mutation on confirm.
 *      - Unrecognised-slug rows render no restore button at all.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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

import SuperAdminPage, { mapToRecognisedTier } from "../super-admin";

// Sample legacy-slug → tier mapping table, mirroring what the new
// /api/super-admin/legacy-slug-mappings endpoint (Task #1131) returns.
const SAMPLE_MAPPINGS = {
  basic: "starter",
  trial: "starter",
  starter_v2: "starter",
  premium: "pro",
  pro_v2: "pro",
  pro_plus: "pro",
  business: "pro",
  team: "pro",
  ent: "enterprise",
  enterprise_v2: "enterprise",
  unlimited: "enterprise",
} as const;

// ─── mapToRecognisedTier unit tests ─────────────────────────────────────────

describe("mapToRecognisedTier", () => {
  const mappings = SAMPLE_MAPPINGS as unknown as Record<string, "free" | "starter" | "pro" | "enterprise">;

  it("returns exact matches for the four standard tiers (mappings unused)", () => {
    expect(mapToRecognisedTier("free", mappings)).toEqual({ tier: "free", isGuess: false });
    expect(mapToRecognisedTier("starter", mappings)).toEqual({ tier: "starter", isGuess: false });
    expect(mapToRecognisedTier("pro", mappings)).toEqual({ tier: "pro", isGuess: false });
    expect(mapToRecognisedTier("enterprise", mappings)).toEqual({ tier: "enterprise", isGuess: false });
  });

  it("standard-tier matches still resolve when the mapping table is empty", () => {
    expect(mapToRecognisedTier("pro", {})).toEqual({ tier: "pro", isGuess: false });
    expect(mapToRecognisedTier("enterprise", {})).toEqual({ tier: "enterprise", isGuess: false });
  });

  it("normalises whitespace and case before matching", () => {
    expect(mapToRecognisedTier("  PRO  ", mappings)).toEqual({ tier: "pro", isGuess: false });
    expect(mapToRecognisedTier("Enterprise", mappings)).toEqual({ tier: "enterprise", isGuess: false });
  });

  it("guesses known legacy slugs from the mapping table and flags them as a guess", () => {
    expect(mapToRecognisedTier("basic", mappings)).toEqual({ tier: "starter", isGuess: true });
    expect(mapToRecognisedTier("trial", mappings)).toEqual({ tier: "starter", isGuess: true });
    expect(mapToRecognisedTier("starter_v2", mappings)).toEqual({ tier: "starter", isGuess: true });
    expect(mapToRecognisedTier("premium", mappings)).toEqual({ tier: "pro", isGuess: true });
    expect(mapToRecognisedTier("pro_v2", mappings)).toEqual({ tier: "pro", isGuess: true });
    expect(mapToRecognisedTier("pro_plus", mappings)).toEqual({ tier: "pro", isGuess: true });
    expect(mapToRecognisedTier("business", mappings)).toEqual({ tier: "pro", isGuess: true });
    expect(mapToRecognisedTier("team", mappings)).toEqual({ tier: "pro", isGuess: true });
    expect(mapToRecognisedTier("ent", mappings)).toEqual({ tier: "enterprise", isGuess: true });
    expect(mapToRecognisedTier("enterprise_v2", mappings)).toEqual({ tier: "enterprise", isGuess: true });
    expect(mapToRecognisedTier("unlimited", mappings)).toEqual({ tier: "enterprise", isGuess: true });
  });

  it("guesses are case- and whitespace-insensitive", () => {
    expect(mapToRecognisedTier("  Premium ", mappings)).toEqual({ tier: "pro", isGuess: true });
    expect(mapToRecognisedTier("PRO_V2", mappings)).toEqual({ tier: "pro", isGuess: true });
  });

  it("returns null for slugs not present in the mapping table", () => {
    expect(mapToRecognisedTier("legendary", mappings)).toBeNull();
    expect(mapToRecognisedTier("gold", mappings)).toBeNull();
    expect(mapToRecognisedTier("not-a-tier", mappings)).toBeNull();
    // Even known legacy slugs return null when the mapping table is empty.
    expect(mapToRecognisedTier("premium", {})).toBeNull();
  });

  it("returns null for empty, whitespace-only, or non-string input", () => {
    expect(mapToRecognisedTier("", mappings)).toBeNull();
    expect(mapToRecognisedTier("   ", mappings)).toBeNull();
    expect(mapToRecognisedTier(null, mappings)).toBeNull();
    expect(mapToRecognisedTier(undefined, mappings)).toBeNull();
    expect(mapToRecognisedTier(42, mappings)).toBeNull();
    expect(mapToRecognisedTier({ tier: "pro" }, mappings)).toBeNull();
  });
});

// ─── Restore-button component test ──────────────────────────────────────────

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
}

function makeEntry(over: Partial<MigrationEntry> & { id: number }): MigrationEntry {
  return {
    organizationId: 100 + over.id,
    orgName: `Club ${over.id}`,
    orgSlug: `club-${over.id}`,
    currentTier: "free",
    fromTier: null,
    toTier: "free",
    reason: "downgraded automatically",
    createdAt: "2026-04-01T00:00:00.000Z",
    acknowledged: false,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    acknowledgedByName: null,
    acknowledgedVia: null,
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

describe("Plan Migration audit — Restore button flow", () => {
  const entries: MigrationEntry[] = [
    // exact-match: fromTier "pro" → no confirmation
    makeEntry({ id: 1, fromTier: "pro", currentTier: "free" }),
    // legacy guess: "premium" → maps to pro (best guess) + prompts
    makeEntry({ id: 2, fromTier: "premium", currentTier: "free" }),
    // unrecognised slug: no restore button
    makeEntry({ id: 3, fromTier: "legendary", currentTier: "free" }),
  ];

  let confirmSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
        return jsonResponse({
          totalClubs: 0,
          activeClubs: 0,
          totalUsers: 0,
          totalTournaments: 0,
          activeTournaments: 0,
          tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
          estimatedMrr: 0,
          bookingsThisMonth: 0,
          bookingRevenueThisMonth: 0,
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
        // Task #1131 — restore button now reads its guess table from this
        // endpoint instead of a hardcoded constant. Mirror the SAMPLE_MAPPINGS
        // table so the legacy-slug row in `entries` resolves to "pro".
        return jsonResponse({
          mappings: Object.entries(SAMPLE_MAPPINGS).map(([slug, tier]) => ({
            slug,
            tier,
            notes: null,
            createdByUserId: null,
            updatedByUserId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })),
        });
      }
      if (url.startsWith("/api/super-admin/plan-migration-audit") && method === "GET") {
        return jsonResponse({
          entries,
          total: entries.length,
          page: 1,
          limit: 500,
        });
      }
      if (url.match(/\/api\/super-admin\/clubs\/\d+\/tier$/) && method === "PATCH") {
        return jsonResponse({ ok: true });
      }
      if (url.match(/\/api\/super-admin\/plan-migration-audit\/\d+\/acknowledge$/) && method === "POST") {
        return jsonResponse({ ok: true });
      }
      // Other queries (dashboard, etc.) aren't enabled in plan-migrations view,
      // but return an empty 200 just in case.
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    confirmSpy = vi.spyOn(window, "confirm");
  });

  afterEach(() => {
    confirmSpy.mockRestore();
    vi.unstubAllGlobals();
    cleanup();
  });

  async function openMigrationsView() {
    const user = userEvent.setup();
    renderPage();
    // Switch to the plan-migrations view.
    await user.click(await screen.findByRole("button", { name: /plan migrations/i }));
    // Wait for entries to render.
    await screen.findByText("Club 1");
    return user;
  }

  it("renders an exact-match restore button with no '(best guess)' suffix and skips the confirm prompt", async () => {
    const user = await openMigrationsView();

    // Exact-match row — button label has no "(best guess)".
    const exactBtn = screen.getByRole("button", { name: /^Restore to pro$/ });
    expect(exactBtn).toBeInTheDocument();

    confirmSpy.mockImplementation(() => {
      throw new Error("confirm() should not be called for exact matches");
    });

    await user.click(exactBtn);

    // Tier PATCH and acknowledge POST should both fire.
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(c => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${c[0]}`);
      expect(calls).toEqual(
        expect.arrayContaining([
          "PATCH /api/super-admin/clubs/101/tier",
          "POST /api/super-admin/plan-migration-audit/1/acknowledge",
        ]),
      );
    });
    expect(confirmSpy).not.toHaveBeenCalled();

    // Verify the PATCH body asked for the matched tier.
    const patchCall = fetchMock.mock.calls.find(
      c => typeof c[0] === "string" && c[0] === "/api/super-admin/clubs/101/tier",
    );
    expect(patchCall).toBeTruthy();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
      subscriptionTier: "pro",
    });
  });

  it("renders '(best guess)' for legacy slugs and only restores when the confirm prompt is accepted", async () => {
    const user = await openMigrationsView();

    const guessBtn = screen.getByRole("button", { name: /Restore to pro \(best guess\)/ });
    expect(guessBtn).toBeInTheDocument();

    // Reject the prompt first → no PATCH fires.
    confirmSpy.mockReturnValueOnce(false);
    await user.click(guessBtn);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/premium/);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/pro/);

    // Give React Query a tick — no tier PATCH should happen.
    await new Promise(r => setTimeout(r, 20));
    const patchAfterReject = fetchMock.mock.calls.find(
      c => (c[1] as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchAfterReject).toBeUndefined();

    // Accept the prompt → PATCH for org 102 with tier "pro" fires.
    confirmSpy.mockReturnValueOnce(true);
    await user.click(guessBtn);

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        c => typeof c[0] === "string" && c[0] === "/api/super-admin/clubs/102/tier",
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
        subscriptionTier: "pro",
      });
    });
    await waitFor(() => {
      const ackCall = fetchMock.mock.calls.find(
        c => typeof c[0] === "string"
          && c[0] === "/api/super-admin/plan-migration-audit/2/acknowledge",
      );
      expect(ackCall).toBeTruthy();
    });
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });

  it("renders no restore button at all for unrecognised slugs (only Acknowledge)", async () => {
    await openMigrationsView();

    const legendaryRow = screen.getByText("Club 3").closest("tr");
    expect(legendaryRow).toBeTruthy();
    const rowScope = within(legendaryRow as HTMLElement);

    expect(rowScope.queryByRole("button", { name: /Restore to/i })).toBeNull();
    expect(rowScope.getByRole("button", { name: /Acknowledge/i })).toBeInTheDocument();
  });
});

// ─── Acknowledged-row "via" badge + acknowledger label test (Task #1144) ────

describe("Plan Migration audit — acknowledged-row badge + name", () => {
  const ackedAt = "2026-04-20T12:34:56.000Z";
  const entries: MigrationEntry[] = [
    makeEntry({
      id: 11,
      fromTier: "pro",
      currentTier: "free",
      acknowledged: true,
      acknowledgedAt: ackedAt,
      acknowledgedByUserId: 42,
      acknowledgedByName: "Asha Reviewer",
      acknowledgedVia: "email",
    }),
    makeEntry({
      id: 12,
      fromTier: "starter",
      currentTier: "free",
      acknowledged: true,
      acknowledgedAt: ackedAt,
      acknowledgedByUserId: 7,
      acknowledgedByName: "Mo Manager",
      acknowledgedVia: "dashboard",
    }),
    // Unack row so the panel still renders the action column controls.
    makeEntry({ id: 13, fromTier: "pro", currentTier: "free" }),
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
        return jsonResponse({ mappings: [] });
      }
      if (url.startsWith("/api/super-admin/plan-migration-audit") && method === "GET") {
        return jsonResponse({ entries, total: entries.length, page: 1, limit: 500 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("shows an Email badge + acknowledger name for email-link acknowledgements", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /plan migrations/i }));

    const emailRow = (await screen.findByText("Club 11")).closest("tr") as HTMLElement;
    const rowScope = within(emailRow);

    expect(rowScope.getByText(/Reviewed/i)).toBeInTheDocument();
    expect(rowScope.getByText(/^Email$/)).toBeInTheDocument();
    expect(rowScope.queryByText(/^Dashboard$/)).toBeNull();
    expect(rowScope.getByText(/by Asha Reviewer/)).toBeInTheDocument();
  });

  it("shows a Dashboard badge + acknowledger name for in-panel acknowledgements", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /plan migrations/i }));

    const dashRow = (await screen.findByText("Club 12")).closest("tr") as HTMLElement;
    const rowScope = within(dashRow);

    expect(rowScope.getByText(/Reviewed/i)).toBeInTheDocument();
    expect(rowScope.getByText(/^Dashboard$/)).toBeInTheDocument();
    expect(rowScope.queryByText(/^Email$/)).toBeNull();
    expect(rowScope.getByText(/by Mo Manager/)).toBeInTheDocument();
  });
});
