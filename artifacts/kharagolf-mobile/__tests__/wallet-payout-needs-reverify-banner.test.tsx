/**
 * Task #1511 — UI coverage for the wallet `PayoutNeedsReverifyBanner`
 * extracted from `app/wallet.tsx`. The banner is shown whenever the
 * daily wallet payout-account re-verification cron (Task #1119) flips a
 * member's saved UPI / bank to `verificationStatus === "needs_attention"`.
 * It mirrors the coach payout banner exercised by
 * `payout-needs-attention-banner.test.tsx` (Task #1220) so a future
 * refactor of the wallet screen cannot silently drop the persisted
 * failure reason / Re-save CTA on the floor.
 *
 * Companion to the web coverage in
 * `artifacts/kharagolf-web/src/tests/wallet-payout-needs-reverify-banner.test.tsx`.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Task #1872 — banner copy moved into the `profile` i18n namespace.
// Mock react-i18next so the unit test stays isolated from the i18n
// runtime while still asserting on the human-readable English source
// strings shipped in `i18n/locales/en/profile.json`.
vi.mock("react-i18next", () => {
  const STRINGS: Record<string, string> = {
    "walletPayoutNeedsReverify.titleUpi": "Re-save your UPI to resume withdrawals",
    "walletPayoutNeedsReverify.titleBank": "Re-save your bank account to resume withdrawals",
    "walletPayoutNeedsReverify.body":
      "Our latest scheduled re-check of your saved payout details didn't go through, so withdrawals are paused until you re-save them.",
    "walletPayoutNeedsReverify.reason": "Reason: {{reason}}",
    "walletPayoutNeedsReverify.cta": "Re-save account",
  };
  return {
    useTranslation: () => ({
      t: (key: string, vars?: Record<string, unknown>) => {
        const tpl = STRINGS[key] ?? key;
        if (!vars) return tpl;
        return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) =>
          k in vars ? String(vars[k]) : `{{${k}}}`,
        );
      },
    }),
  };
});

import { PayoutNeedsReverifyBanner } from "../components/PayoutNeedsReverifyBanner";

afterEach(() => { cleanup(); });

describe("PayoutNeedsReverifyBanner (Task #1511)", () => {
  it("renders the persisted failure reason and fires the Re-save CTA", () => {
    const onPress = vi.fn();
    render(
      <PayoutNeedsReverifyBanner
        method="upi"
        reason="VPA inactive at upstream bank"
        onPress={onPress}
      />,
    );

    const banner = screen.getByTestId("banner-wallet-payout-needs-reverify");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent ?? "").toMatch(/Re-save your UPI to resume withdrawals/i);
    expect(banner.textContent ?? "").toMatch(/Reason: VPA inactive at upstream bank/);

    fireEvent.click(screen.getByTestId("button-wallet-payout-needs-reverify-fix"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("uses 'bank account' wording when the saved method is bank_account", () => {
    render(
      <PayoutNeedsReverifyBanner
        method="bank_account"
        reason={null}
        onPress={() => {}}
      />,
    );

    const banner = screen.getByTestId("banner-wallet-payout-needs-reverify");
    expect(banner.textContent ?? "").toMatch(/Re-save your bank account to resume withdrawals/i);
    // Falls back to the generic body copy with no "Reason:" suffix.
    expect(banner.textContent ?? "").not.toMatch(/Reason:/);
  });
});
