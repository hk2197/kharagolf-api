/**
 * Task #1511 — UI test for the wallet `WalletPayoutNeedsReverifyBanner`
 * sub-component. The banner is rendered inside `WalletPanel`
 * (SideGamesAdmin.tsx) whenever the daily wallet payout-account
 * re-verification cron (Task #1119) flips the saved account to
 * `verificationStatus === "needs_attention"`. It surfaces the persisted
 * `verificationFailureReason` and a "Re-save account" CTA so members
 * see the same friendly affordance the coach payout card already shows
 * (Task #1061).
 *
 * Mirrors the `VerifiedHolderLine` extraction pattern from Task #1293
 * so this lives outside `WalletPanel` and can be exercised without
 * mocking the wallet, payout-account, and withdrawals fetches.
 *
 * Companion to the mobile coverage in
 * `artifacts/kharagolf-mobile/__tests__/wallet-payout-needs-reverify-banner.test.tsx`.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WalletPayoutNeedsReverifyBanner } from "../SideGamesAdmin";

afterEach(() => { cleanup(); });

describe("WalletPayoutNeedsReverifyBanner (Task #1511)", () => {
  it("renders the persisted failure reason and fires the Re-save CTA", () => {
    const onReSave = vi.fn();
    render(
      <WalletPayoutNeedsReverifyBanner
        method="upi"
        verificationStatus="needs_attention"
        verificationFailureReason="VPA inactive at upstream bank"
        accountFormOpen={false}
        onReSave={onReSave}
      />,
    );

    const banner = screen.getByTestId("banner-wallet-payout-needs-reverify");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent ?? "").toMatch(
      /Re-save your UPI to resume withdrawals/i,
    );
    expect(banner.textContent ?? "").toMatch(/Reason: VPA inactive at upstream bank/);

    fireEvent.click(screen.getByTestId("button-wallet-payout-needs-reverify-fix"));
    expect(onReSave).toHaveBeenCalledTimes(1);
  });

  it("uses 'bank account' wording when the saved method is bank_account and omits Reason: when no failure reason was persisted", () => {
    render(
      <WalletPayoutNeedsReverifyBanner
        method="bank_account"
        verificationStatus="needs_attention"
        verificationFailureReason={null}
        accountFormOpen={false}
        onReSave={() => {}}
      />,
    );

    const banner = screen.getByTestId("banner-wallet-payout-needs-reverify");
    expect(banner.textContent ?? "").toMatch(
      /Re-save your bank account to resume withdrawals/i,
    );
    expect(banner.textContent ?? "").not.toMatch(/Reason:/);
  });

  it("hides the Re-save CTA once the saved-account form is already open (avoids duplicate affordance)", () => {
    render(
      <WalletPayoutNeedsReverifyBanner
        method="upi"
        verificationStatus="needs_attention"
        verificationFailureReason="VPA inactive at upstream bank"
        accountFormOpen={true}
        onReSave={() => {}}
      />,
    );

    expect(screen.getByTestId("banner-wallet-payout-needs-reverify")).toBeInTheDocument();
    expect(screen.queryByTestId("button-wallet-payout-needs-reverify-fix")).toBeNull();
  });

  it("renders nothing when verificationStatus is not 'needs_attention' (verified / null / pending)", () => {
    const verifiedRender = render(
      <WalletPayoutNeedsReverifyBanner
        method="upi"
        verificationStatus="verified"
        verificationFailureReason={null}
        accountFormOpen={false}
        onReSave={() => {}}
      />,
    );
    expect(screen.queryByTestId("banner-wallet-payout-needs-reverify")).toBeNull();
    verifiedRender.unmount();

    render(
      <WalletPayoutNeedsReverifyBanner
        method="bank_account"
        verificationStatus={null}
        verificationFailureReason={null}
        accountFormOpen={false}
        onReSave={() => {}}
      />,
    );
    expect(screen.queryByTestId("banner-wallet-payout-needs-reverify")).toBeNull();
  });
});
