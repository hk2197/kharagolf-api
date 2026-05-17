/**
 * UI test for the admin "Re-verify now" button on the wallet payout
 * account row inside SideGamesAdmin's WalletPanel — Task #1517.
 *
 * Mirrors the coach-side button on /coach-admin (covered by
 * coach-admin-payouts.test.tsx) which calls
 * POST /coach-marketplace/admin/coaches/:proId/payout-account/reverify.
 *
 * The button must:
 *   1. Be hidden entirely when `isAdmin` is false (members never see it
 *      on their own wallet — only org admins / TDs viewing a member's
 *      wallet should see it).
 *   2. Render but be disabled when the saved account has no Razorpay
 *      fund-account on file (`hasRazorpayFundAccount === false`),
 *      because the underlying endpoint has nothing to validate. The
 *      tooltip explains why.
 *   3. POST to /api/admin/wallet/payout-accounts/:id/reverify and
 *      surface each known outcome via toast:
 *        - `verified`        → success toast ("Payout account
 *                              re-verified")
 *        - `needs_attention` → destructive toast with the returned
 *                              reason
 *        - `skipped`         → neutral toast (validation in-flight)
 *
 * The toast is captured by mocking `useToast` so we assert on the
 * payload rather than fighting the radix Toaster's portal/animation
 * lifecycle.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Capture toast calls so we can assert on title / variant per outcome.
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}));

import SideGamesAdmin from "../SideGamesAdmin";

const ORG_ID = 42;
const ACCOUNT_ID = 777;

interface PayoutAccountFixture {
  hasRazorpayFundAccount: boolean;
  verified: boolean;
}

interface ReverifyResponse {
  status?: number;
  body: Record<string, unknown>;
}

interface BackendOptions {
  payoutAccount: PayoutAccountFixture | null;
  reverifyResponse?: ReverifyResponse;
}

function buildFetchHandler(opts: BackendOptions) {
  const ok = (body: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response);

  const err = (status: number, body: unknown) =>
    Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response);

  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    // Templates fetch (SideGamesAdmin mount).
    if (method === "GET" && url.startsWith("/api/side-game-templates")) {
      return ok([]);
    }
    // Wallet balance + transactions fetch.
    if (method === "GET" && url.startsWith("/api/wallet?")) {
      return ok({
        wallet: { id: 1, balance: 0, currency: "INR" },
        transactions: [],
      });
    }
    // Withdrawal history fetch.
    if (method === "GET" && url.startsWith("/api/wallet/withdrawals")) {
      return ok({ withdrawals: [] });
    }
    // Payout-account fetch.
    if (method === "GET" && url.startsWith("/api/wallet/payout-account")) {
      return ok({
        account: opts.payoutAccount
          ? {
              id: ACCOUNT_ID,
              method: "upi",
              accountHolderName: "Test User",
              upiVpa: "test@upi",
              bankAccountNumberLast4: null,
              bankIfsc: null,
              verified: opts.payoutAccount.verified,
              verifiedAt: null,
              verifiedHolderName: null,
              verificationStatus: null,
              verificationFailureReason: null,
              hasRazorpayFundAccount: opts.payoutAccount.hasRazorpayFundAccount,
            }
          : null,
        limits: { minPerTxn: 1, maxPerTxn: 50000, maxPerDay: 200000, currency: "INR" },
      });
    }
    // The button under test.
    if (
      method === "POST" &&
      url === `/api/admin/wallet/payout-accounts/${ACCOUNT_ID}/reverify`
    ) {
      const r = opts.reverifyResponse ?? { body: { outcome: "verified" } };
      const status = r.status ?? 200;
      return status >= 200 && status < 300 ? ok(r.body) : err(status, r.body);
    }
    return err(404, { error: `unhandled ${method} ${url}` });
  };
}

beforeEach(() => {
  toastSpy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SideGamesAdmin WalletPanel — admin Re-verify now button (Task #1517)", () => {
  it("hides the button entirely when isAdmin is false", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchHandler({
        payoutAccount: { hasRazorpayFundAccount: true, verified: true },
      }),
    );

    render(<SideGamesAdmin orgId={ORG_ID} isAdmin={false} />);

    // Wait for the payout fetch to settle so the saved-account row is rendered.
    await waitFor(() => expect(screen.getByText(/UPI · test@upi/)).toBeInTheDocument());

    // The button must not exist for non-admin viewers — even though the
    // saved account would otherwise be eligible for re-verification.
    expect(screen.queryByTestId("button-reverify-wallet-payout")).toBeNull();
  });

  it("renders the button disabled (with explanatory tooltip) when no Razorpay fund-account is on file", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchHandler({
        payoutAccount: { hasRazorpayFundAccount: false, verified: false },
      }),
    );

    render(<SideGamesAdmin orgId={ORG_ID} isAdmin={true} />);

    const btn = (await screen.findByTestId(
      "button-reverify-wallet-payout",
    )) as HTMLButtonElement;
    expect(btn).toBeInTheDocument();
    expect(btn.disabled).toBe(true);
    // Tooltip wording explains why the button is greyed out so support
    // staff don't keep clicking on a no-op.
    expect(btn.getAttribute("title")).toMatch(/no razorpay fund-account/i);
  });

  it("posts to the reverify endpoint, shows a success toast, and pins inline 'Verified' next to the button when the outcome is 'verified'", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchHandler({
        payoutAccount: { hasRazorpayFundAccount: true, verified: false },
        reverifyResponse: { body: { outcome: "verified" } },
      }),
    );

    const user = userEvent.setup();
    render(<SideGamesAdmin orgId={ORG_ID} isAdmin={true} />);

    const btn = await screen.findByTestId("button-reverify-wallet-payout");
    expect((btn as HTMLButtonElement).disabled).toBe(false);

    // No inline outcome before the click — clean state.
    expect(screen.queryByTestId("text-reverify-outcome")).toBeNull();

    await user.click(btn);

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const successCall = toastSpy.mock.calls.find(
      ([arg]) => (arg as { title?: unknown })?.title === "Payout account re-verified",
    );
    expect(successCall).toBeDefined();
    // Success path must NOT use the destructive variant.
    expect((successCall![0] as { variant?: string }).variant).toBeUndefined();

    // The inline outcome stays pinned next to the button after the toast
    // disappears so the admin can still see what happened.
    const inline = await screen.findByTestId("text-reverify-outcome");
    expect(inline.getAttribute("data-outcome")).toBe("verified");
    expect(inline.textContent).toMatch(/Verified/);
    // Verified state uses the success colour, not the amber warning.
    expect(inline.className).toContain("text-emerald-300");
  });

  it("shows a destructive toast AND pins inline 'Needs attention: <reason>' when the outcome is 'needs_attention'", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchHandler({
        payoutAccount: { hasRazorpayFundAccount: true, verified: true },
        reverifyResponse: {
          body: { outcome: "needs_attention", reason: "VPA inactive at PSP" },
        },
      }),
    );

    const user = userEvent.setup();
    render(<SideGamesAdmin orgId={ORG_ID} isAdmin={true} />);

    const btn = await screen.findByTestId("button-reverify-wallet-payout");
    await user.click(btn);

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const failCall = toastSpy.mock.calls.find(
      ([arg]) => (arg as { title?: unknown })?.title === "Re-verification failed",
    );
    expect(failCall).toBeDefined();
    const payload = failCall![0] as { description?: string; variant?: string };
    // The bank-supplied reason is surfaced verbatim so support can act on it.
    expect(payload.description).toBe("VPA inactive at PSP");
    expect(payload.variant).toBe("destructive");

    // Inline outcome carries the same reason so it survives the toast
    // auto-dismissing.
    const inline = await screen.findByTestId("text-reverify-outcome");
    expect(inline.getAttribute("data-outcome")).toBe("needs_attention");
    expect(inline.textContent).toMatch(/Needs attention: VPA inactive at PSP/);
    expect(inline.className).toContain("text-amber-200");
  });

  it("shows a neutral 'pending' toast AND pins inline 'Pending: <reason>' when the outcome is 'skipped' (validation still in flight)", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchHandler({
        payoutAccount: { hasRazorpayFundAccount: true, verified: false },
        reverifyResponse: {
          body: { outcome: "skipped", reason: "Razorpay validation in progress" },
        },
      }),
    );

    const user = userEvent.setup();
    render(<SideGamesAdmin orgId={ORG_ID} isAdmin={true} />);

    const btn = await screen.findByTestId("button-reverify-wallet-payout");
    await user.click(btn);

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const skippedCall = toastSpy.mock.calls.find(
      ([arg]) => (arg as { title?: unknown })?.title === "Re-verification pending",
    );
    expect(skippedCall).toBeDefined();
    const payload = skippedCall![0] as { description?: string; variant?: string };
    expect(payload.description).toBe("Razorpay validation in progress");
    // Skipped is informational, not destructive.
    expect(payload.variant).toBeUndefined();

    // Inline outcome reflects the pending state with its own neutral colour.
    const inline = await screen.findByTestId("text-reverify-outcome");
    expect(inline.getAttribute("data-outcome")).toBe("skipped");
    expect(inline.textContent).toMatch(/Pending: Razorpay validation in progress/);
    expect(inline.className).toContain("text-sky-300");
  });
});
