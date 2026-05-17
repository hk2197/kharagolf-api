/**
 * UI test for the admin "Re-verification history" section that
 * SideGamesAdmin's WalletPanel renders under the saved wallet payout
 * account — Task #1886.
 *
 * Mirrors the per-coach payout-account history dialog on /coach-admin
 * (covered by coach-admin-payouts.test.tsx) which surfaces the same
 * audit trail for coach payout accounts.
 *
 * The section must:
 *   1. Be hidden entirely for non-admin viewers (members never see
 *      the audit trail on their own wallet — the underlying endpoint
 *      requires org-admin anyway, but we should not even render the
 *      empty/loading skeleton to avoid exposing the surface).
 *   2. Be hidden when there is no saved payout account at all
 *      (nothing to verify yet).
 *   3. Fetch /api/admin/wallet/payout-accounts/:id/history on mount
 *      and render rows newest-first with the masked snapshot,
 *      outcome chip, reason, admin name, and timestamp.
 *   4. Render an empty-state line when the account exists but the
 *      audit table has no rows yet.
 *   5. Refetch after a successful inline "Re-verify now" click so
 *      the new event appears without a page reload.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}));

import SideGamesAdmin from "../SideGamesAdmin";

const ORG_ID = 42;
const ACCOUNT_ID = 777;

interface HistoryRow {
  id: number;
  walletPayoutAccountId: number;
  changeKind: string;
  method: string;
  accountHolderName: string | null;
  upiVpaMasked: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  changedByUserId: number | null;
  changedByRole: string | null;
  changedByName: string | null;
  verificationOutcome: string | null;
  verificationReason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

interface BackendOptions {
  hasPayoutAccount: boolean;
  history: HistoryRow[];
  // Lets a single test stage two responses (initial + post-reverify).
  historyResponses?: HistoryRow[][];
}

function buildFetchHandler(opts: BackendOptions) {
  const ok = (body: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response);

  let historyCallCount = 0;

  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url.startsWith("/api/side-game-templates")) {
      return ok([]);
    }
    if (method === "GET" && url.startsWith("/api/wallet?")) {
      return ok({
        wallet: { id: 1, balance: 0, currency: "INR" },
        transactions: [],
      });
    }
    if (method === "GET" && url.startsWith("/api/wallet/withdrawals")) {
      return ok({ withdrawals: [] });
    }
    if (method === "GET" && url.startsWith("/api/wallet/payout-account")) {
      return ok({
        account: opts.hasPayoutAccount
          ? {
              id: ACCOUNT_ID,
              method: "upi",
              accountHolderName: "Test User",
              upiVpa: "test@upi",
              bankAccountNumberLast4: null,
              bankIfsc: null,
              verified: true,
              verifiedAt: null,
              verifiedHolderName: null,
              verificationStatus: null,
              verificationFailureReason: null,
              hasRazorpayFundAccount: true,
            }
          : null,
        limits: { minPerTxn: 1, maxPerTxn: 50000, maxPerDay: 200000, currency: "INR" },
      });
    }
    if (
      method === "GET" &&
      url.startsWith(`/api/admin/wallet/payout-accounts/${ACCOUNT_ID}/history`)
    ) {
      const idx = historyCallCount++;
      const rows = opts.historyResponses
        ? opts.historyResponses[Math.min(idx, opts.historyResponses.length - 1)]
        : opts.history;
      return ok({
        account: {
          id: ACCOUNT_ID,
          organizationId: ORG_ID,
          userId: 1,
          method: "upi",
          accountHolderName: "Test User",
          bankAccountNumberLast4: null,
          bankIfsc: null,
          upiVpa: "test@upi",
          verifiedAt: null,
          verificationStatus: null,
          verificationFailureReason: null,
        },
        history: rows,
      });
    }
    if (
      method === "POST" &&
      url === `/api/admin/wallet/payout-accounts/${ACCOUNT_ID}/reverify`
    ) {
      return ok({ outcome: "verified" });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: `unhandled ${method} ${url}` }),
      text: () => Promise.resolve(`unhandled ${method} ${url}`),
    } as Response);
  };
}

function makeRow(overrides: Partial<HistoryRow>): HistoryRow {
  return {
    id: 1,
    walletPayoutAccountId: ACCOUNT_ID,
    changeKind: "admin_reverify",
    method: "upi",
    accountHolderName: "Test User",
    upiVpaMasked: "te****@upi",
    bankAccountLast4: null,
    bankIfsc: null,
    changedByUserId: 9,
    changedByRole: "org_admin",
    changedByName: "Alice Admin",
    verificationOutcome: "verified",
    verificationReason: null,
    ipAddress: null,
    userAgent: null,
    createdAt: "2026-04-29T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  toastSpy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SideGamesAdmin WalletPanel — admin Re-verification history (Task #1886)", () => {
  it("hides the section entirely when isAdmin is false", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchHandler({ hasPayoutAccount: true, history: [makeRow({})] }),
    );

    render(<SideGamesAdmin orgId={ORG_ID} isAdmin={false} />);

    await waitFor(() => expect(screen.getByText(/UPI · test@upi/)).toBeInTheDocument());

    expect(screen.queryByTestId("wallet-payout-reverify-history")).toBeNull();
  });

  it("hides the section when there is no saved payout account yet", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchHandler({ hasPayoutAccount: false, history: [] }),
    );

    render(<SideGamesAdmin orgId={ORG_ID} isAdmin={true} />);

    await waitFor(() =>
      expect(
        screen.getByText(/Add UPI or bank account to enable withdrawals/i),
      ).toBeInTheDocument(),
    );

    expect(screen.queryByTestId("wallet-payout-reverify-history")).toBeNull();
  });

  it("renders an empty-state line when there is a saved account but no history rows yet", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchHandler({ hasPayoutAccount: true, history: [] }),
    );

    render(<SideGamesAdmin orgId={ORG_ID} isAdmin={true} />);

    const section = await screen.findByTestId("wallet-payout-reverify-history");
    const empty = await within(section).findByTestId("text-wallet-payout-history-empty");
    expect(empty.textContent).toMatch(/No re-verification events recorded/i);
  });

  it("renders one row per audit entry (admin name, outcome chip, masked snapshot, reason, timestamp)", async () => {
    const rows: HistoryRow[] = [
      makeRow({
        id: 11,
        verificationOutcome: "verified",
        changedByName: "Alice Admin",
        upiVpaMasked: "al****@upi",
        method: "upi",
        verificationReason: null,
        createdAt: "2026-04-29T10:00:00.000Z",
      }),
      makeRow({
        id: 12,
        verificationOutcome: "needs_attention",
        changedByName: "Bob Admin",
        method: "bank_account",
        upiVpaMasked: null,
        bankAccountLast4: "9876",
        bankIfsc: "HDFC0001234",
        verificationReason: "VPA inactive at PSP",
        createdAt: "2026-04-30T11:30:00.000Z",
      }),
    ];

    vi.stubGlobal("fetch", buildFetchHandler({ hasPayoutAccount: true, history: rows }));

    render(<SideGamesAdmin orgId={ORG_ID} isAdmin={true} />);

    const verifiedRow = await screen.findByTestId("wallet-payout-history-row-11");
    const verifiedChip = within(verifiedRow).getByTestId("wallet-payout-history-outcome-11");
    expect(verifiedChip.getAttribute("data-outcome")).toBe("verified");
    expect(verifiedChip.textContent).toMatch(/Verified/);
    expect(verifiedChip.className).toContain("text-emerald-200");
    expect(within(verifiedRow).getByText(/UPI al\*\*\*\*@upi/)).toBeInTheDocument();
    expect(within(verifiedRow).getByText(/By Alice Admin/)).toBeInTheDocument();
    // Reason line is omitted for clean verifications.
    expect(within(verifiedRow).queryByTestId("wallet-payout-history-reason-11")).toBeNull();

    const needsRow = await screen.findByTestId("wallet-payout-history-row-12");
    const needsChip = within(needsRow).getByTestId("wallet-payout-history-outcome-12");
    expect(needsChip.getAttribute("data-outcome")).toBe("needs_attention");
    expect(needsChip.textContent).toMatch(/Needs attention/);
    expect(needsChip.className).toContain("text-amber-200");
    expect(within(needsRow).getByText(/Bank •••• 9876/)).toBeInTheDocument();
    expect(within(needsRow).getByText(/IFSC HDFC0001234/)).toBeInTheDocument();
    const reasonLine = within(needsRow).getByTestId("wallet-payout-history-reason-12");
    expect(reasonLine.textContent).toMatch(/Reason: VPA inactive at PSP/);
    expect(within(needsRow).getByText(/By Bob Admin/)).toBeInTheDocument();
  });

  it("refetches after a successful inline Re-verify so the new event appears without a page reload", async () => {
    const initial: HistoryRow[] = [];
    const afterReverify: HistoryRow[] = [
      makeRow({
        id: 99,
        verificationOutcome: "verified",
        changedByName: "Alice Admin",
        createdAt: "2026-04-30T12:00:00.000Z",
      }),
    ];

    vi.stubGlobal(
      "fetch",
      buildFetchHandler({
        hasPayoutAccount: true,
        history: [],
        historyResponses: [initial, afterReverify],
      }),
    );

    const user = userEvent.setup();
    render(<SideGamesAdmin orgId={ORG_ID} isAdmin={true} />);

    // Initial render: empty-state.
    await screen.findByTestId("text-wallet-payout-history-empty");

    // Click the inline "Re-verify now" button — should trigger the
    // history endpoint to refetch and return the new row.
    const btn = await screen.findByTestId("button-reverify-wallet-payout");
    await user.click(btn);

    await waitFor(() =>
      expect(screen.queryByTestId("wallet-payout-history-row-99")).not.toBeNull(),
    );
  });
});
