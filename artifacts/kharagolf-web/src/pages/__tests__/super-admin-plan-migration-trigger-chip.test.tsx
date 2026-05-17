/**
 * Task #1906 — Component test for the per-row Trigger Reason chip in the
 * Super Admin Plan Migration Audit panel.
 *
 * The Plan Migration audit panel previously rendered every row with the
 * same neutral styling, forcing super admins to read the free-text
 * `reason` column to tell a paying customer's cancellation apart from a
 * Stripe slug-mapping bug (unknown tier auto-reset) or an admin-triggered
 * re-migration. Task #1906 introduces a categorical `triggerReason` chip
 * — Cancellation / Unknown tier / Manual — sourced from the audit row's
 * metadata, with a `null` value (legacy rows pre-dating the column) simply
 * omitting the chip rather than guessing a category.
 *
 * This file pins down all four cases in a single render, plus the side
 * effect that the chip renders alongside (not in place of) the existing
 * tier transition + reason text.
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

type TriggerReason = "cancelled" | "unknown_tier" | "manual";

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
  acknowledgedVia: "email" | "dashboard" | null;
  firstDigestedAt: string | null;
  triggerReason: TriggerReason | null;
}

function makeEntry(over: Partial<MigrationEntry> & { id: number }): MigrationEntry {
  return {
    organizationId: 100 + over.id,
    orgName: `Club ${over.id}`,
    orgSlug: `club-${over.id}`,
    currentTier: "free",
    fromTier: "pro",
    toTier: "free",
    reason: "auto-downgrade",
    createdAt: "2026-04-15T00:00:00.000Z",
    acknowledged: false,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    acknowledgedByName: null,
    acknowledgedVia: null,
    firstDigestedAt: null,
    triggerReason: null,
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

describe("Plan Migration audit panel — Task #1906 trigger-reason chip", () => {
  // Mix all four cases in a single render so the assertions are
  // self-contained and we don't need a fixture-loop test.
  const entries: MigrationEntry[] = [
    makeEntry({
      id: 41,
      fromTier: "pro",
      reason: "Stripe subscription cancelled (event evt_cxl)",
      triggerReason: "cancelled",
    }),
    makeEntry({
      id: 42,
      fromTier: "legacy_premium",
      reason: "Stripe webhook saw unknown tier 'legacy_premium'",
      triggerReason: "unknown_tier",
    }),
    makeEntry({
      id: 43,
      fromTier: "pro",
      reason: "Re-migrated by super admin (slug remap)",
      triggerReason: "manual",
    }),
    // Legacy row pre-dating Task #1906 — chip must be omitted entirely
    // rather than guessing a category from the free-text reason.
    makeEntry({
      id: 44,
      fromTier: "starter",
      reason: "Pre-#1906 row, no triggerReason metadata yet",
      triggerReason: null,
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

  it("renders Cancellation / Unknown tier / Manual chips per row, and omits the chip for null-trigger legacy rows", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /plan migrations/i }));
    await screen.findByText("Club 41");

    // Row 41 — Cancellation chip rendered scoped to its row's testid so we
    // don't accidentally match a chip on a different row when label text
    // collides (e.g. a future row that also says "Cancellation").
    const cancelRow = screen.getByText("Club 41").closest("tr") as HTMLElement;
    expect(cancelRow).toBeTruthy();
    const cancelChip = within(cancelRow).getByTestId("trigger-reason-41");
    expect(cancelChip).toHaveTextContent("Cancellation");
    // The chip must coexist with the existing reason text, not replace it.
    expect(within(cancelRow).getByText(/Stripe subscription cancelled/i)).toBeInTheDocument();

    // Row 42 — Unknown tier chip.
    const unknownRow = screen.getByText("Club 42").closest("tr") as HTMLElement;
    expect(unknownRow).toBeTruthy();
    const unknownChip = within(unknownRow).getByTestId("trigger-reason-42");
    expect(unknownChip).toHaveTextContent("Unknown tier");
    // Match the reason text specifically (the fromTier `code` element also
    // contains "legacy_premium", so we anchor on the prose around it).
    expect(within(unknownRow).getByText(/Stripe webhook saw unknown tier/i)).toBeInTheDocument();

    // Row 43 — Manual chip.
    const manualRow = screen.getByText("Club 43").closest("tr") as HTMLElement;
    expect(manualRow).toBeTruthy();
    const manualChip = within(manualRow).getByTestId("trigger-reason-43");
    expect(manualChip).toHaveTextContent("Manual");
    expect(within(manualRow).getByText(/super admin/i)).toBeInTheDocument();

    // Row 44 — null triggerReason (legacy row). The chip MUST NOT render —
    // we deliberately don't guess a category from the free-text reason.
    // The reason text itself must still render, so the row remains useful.
    const legacyRow = screen.getByText("Club 44").closest("tr") as HTMLElement;
    expect(legacyRow).toBeTruthy();
    expect(within(legacyRow).queryByTestId("trigger-reason-44")).toBeNull();
    expect(within(legacyRow).queryByText("Cancellation")).toBeNull();
    expect(within(legacyRow).queryByText("Unknown tier")).toBeNull();
    expect(within(legacyRow).queryByText("Manual")).toBeNull();
    expect(within(legacyRow).getByText(/Pre-#1906 row/i)).toBeInTheDocument();
  });
});
