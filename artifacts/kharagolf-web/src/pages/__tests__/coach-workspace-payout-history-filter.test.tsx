/**
 * UI test (Task #1720) — the coach-facing payout-account history list
 * on the Coach Workspace page now exposes the same change-type filter
 * the org-admin dialog has (All / Account added / Account updated /
 * Admin re-verified payout). Selecting a value forwards `?changeKind=`
 * to `GET /api/coach-marketplace/me/payout-account/history` so the
 * coach can drill into just the admin re-verification rows that
 * explain a "needs attention" flip.
 *
 * This test mounts the workspace, switches to the Profile tab, asserts
 * the unfiltered fetch returns three rows, then picks
 * "Admin re-verified payout" and confirms:
 *   1. the page re-fetches with `changeKind=admin_reverify`,
 *   2. only the admin_reverify row remains in the rendered list,
 *   3. the verification reason shows up on that row.
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
  // Keep an account on file so the workspace renders the recent-changes
  // panel (and therefore the new filter) under the Profile tab.
  payoutMethod: "bank_account",
  payoutAccountId: "fa_existing",
  payoutAccountHolderName: "Test Coach",
  payoutVpa: null,
  payoutBankAccountNumber: "1234567890",
  payoutBankIfsc: "HDFC0009999",
  payoutVerificationStatus: "needs_attention",
  payoutVerificationFailureReason: "Bank account is no longer accepting transfers",
};

interface HistoryEntry {
  id: number;
  changeKind: "created" | "updated" | "admin_reverify";
  method: "upi" | "bank_account";
  accountHolderName: string | null;
  upiVpaMasked: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  payoutAccountId: string | null;
  changedByUserId: number | null;
  changedByRole: string | null;
  changedByName: string | null;
  verificationOutcome: string | null;
  verificationReason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

const created: HistoryEntry = {
  id: 1, changeKind: "created", method: "upi",
  accountHolderName: "Test Coach",
  upiVpaMasked: "te••@upi", bankAccountLast4: null, bankIfsc: null,
  payoutAccountId: "fa_existing_upi",
  changedByUserId: 11, changedByRole: "coach", changedByName: "Test Coach",
  verificationOutcome: null, verificationReason: null,
  ipAddress: "10.0.0.1", userAgent: "vitest",
  createdAt: "2025-01-10T12:00:00.000Z",
};
const updated: HistoryEntry = {
  id: 2, changeKind: "updated", method: "bank_account",
  accountHolderName: "Test Coach",
  upiVpaMasked: null, bankAccountLast4: "7890", bankIfsc: "HDFC0009999",
  payoutAccountId: "fa_existing",
  changedByUserId: 11, changedByRole: "coach", changedByName: "Test Coach",
  verificationOutcome: null, verificationReason: null,
  ipAddress: "10.0.0.2", userAgent: "vitest",
  createdAt: "2025-01-11T12:00:00.000Z",
};
const reverify: HistoryEntry = {
  id: 3, changeKind: "admin_reverify", method: "bank_account",
  accountHolderName: "Test Coach",
  upiVpaMasked: null, bankAccountLast4: "7890", bankIfsc: "HDFC0009999",
  payoutAccountId: "fa_existing",
  changedByUserId: 99, changedByRole: "admin", changedByName: "Hist Admin",
  verificationOutcome: "needs_attention",
  verificationReason: "Bank account is no longer accepting transfers",
  ipAddress: "10.0.0.3", userAgent: "vitest",
  createdAt: "2025-01-12T12:00:00.000Z",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }) as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Mirror the server: default returns all three rows, but a
  // `changeKind=...` query string narrows server-side.
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/coach-marketplace/me/coach-profile")) {
      return jsonResponse({ pro: PRO, profile: PROFILE });
    }
    if (url.startsWith("/api/coach-marketplace/me/payout-account/history")) {
      const all = [reverify, updated, created]; // newest-first
      const match = /[?&]changeKind=([^&]+)/.exec(url);
      const filtered = match
        ? all.filter(h => h.changeKind === decodeURIComponent(match[1]))
        : all;
      return jsonResponse({ history: filtered });
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

describe("CoachWorkspacePage payout-history change-kind filter (Task #1720)", () => {
  it("forwards changeKind to the API and narrows the rendered list to admin re-verifications", async () => {
    render(<CoachWorkspacePage />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Profile/i }));

    // Default unfiltered list shows all three rows.
    await waitFor(() => {
      expect(screen.getByTestId("payout-history-row-1")).toBeInTheDocument();
      expect(screen.getByTestId("payout-history-row-2")).toBeInTheDocument();
      expect(screen.getByTestId("payout-history-row-3")).toBeInTheDocument();
    });

    // Sanity: the initial fetch did not pass a `changeKind` query.
    const initialHistoryCalls = fetchMock.mock.calls
      .map(([input]) => (typeof input === "string" ? input : String(input)))
      .filter(u => u.startsWith("/api/coach-marketplace/me/payout-account/history"));
    expect(initialHistoryCalls.length).toBeGreaterThan(0);
    expect(initialHistoryCalls.every(u => !u.includes("changeKind="))).toBe(true);

    // Pick "Admin re-verified payout" from the new filter.
    const select = screen.getByTestId("select-payout-history-filter-kind") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "admin_reverify" } });
    expect(select.value).toBe("admin_reverify");

    // The page should re-fetch with the new filter and show only the
    // admin_reverify row (id 3) along with its reason.
    await waitFor(() => {
      const filteredCall = fetchMock.mock.calls
        .map(([input]) => (typeof input === "string" ? input : String(input)))
        .find(u => u.includes("/api/coach-marketplace/me/payout-account/history")
          && u.includes("changeKind=admin_reverify"));
      expect(filteredCall).toBeDefined();
    });

    await waitFor(() => {
      expect(screen.getByTestId("payout-history-row-3")).toBeInTheDocument();
      expect(screen.queryByTestId("payout-history-row-1")).toBeNull();
      expect(screen.queryByTestId("payout-history-row-2")).toBeNull();
    });

    // Reason text from the admin_reverify row is surfaced.
    expect(screen.getByTestId("payout-history-reason-3"))
      .toHaveTextContent(/Bank account is no longer accepting transfers/);
  });
});
