/**
 * UI test for the mobile WalletScreen's VerifiedHolderLine sub-component
 * (Task #1293).
 *
 * Task #1120 added a "Verified as: <name>" line under the wallet payout
 * summary on mobile (`app/wallet.tsx`), plus an amber mismatch warning when
 * the bank-returned name disagrees materially with what the member typed.
 * The behaviour was previously only manually verified — this file locks in:
 *   1. The matching path: API returns `verifiedHolderName` that matches the
 *      typed name (case / punctuation / honorific differences are
 *      normalised away). The line shows "Verified as: …" with NO mismatch
 *      warning copy and uses the muted (non-warning) icon + text colour.
 *   2. The mismatch path: typed "Jon Smyth" vs verified "John Smith" — the
 *      amber warning copy is shown, the alert-triangle icon replaces the
 *      check-circle, and the text picks up the amber warning style.
 *   3. The hidden path: when `verifiedHolderName` is null OR an empty
 *      string the line is not rendered at all (mirrors the
 *      `payoutAccount.data?.account?.verifiedHolderName ? (…) : null`
 *      guard in WalletScreen).
 *
 * VerifiedHolderLine was extracted from the inline IIFE inside WalletScreen
 * specifically so this matching/normalisation logic can be exercised
 * without mocking the wallet, payout-account, and withdrawals API
 * endpoints WalletScreen fans out to on mount.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Heavy native modules that `app/wallet.tsx` pulls in at the top of file.
// VerifiedHolderLine itself doesn't touch them, but the import has to
// resolve cleanly under jsdom + react-native-web. Mirrors the strategy used
// by __tests__/payout-needs-attention-banner.test.tsx.
vi.mock("react-native-safe-area-context", () => {
  const ReactInner = require("react") as typeof React;
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      ReactInner.createElement("div", null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1, organizationId: 9 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({ activeOrgId: 9, activeClub: null }),
}));

vi.mock("@/utils/api", () => ({ BASE_URL: "" }));

vi.mock("@/components/PriceWithFx", () => ({
  PriceWithFx: () => null,
}));

vi.mock("@/components/WalletTxnRow", () => ({
  WalletTxnRow: () => null,
}));

import { VerifiedHolderLine } from "../app/wallet";

afterEach(() => {
  cleanup();
});

describe("VerifiedHolderLine (Task #1293)", () => {
  it("shows 'Verified as: <name>' with the check-circle icon and no mismatch copy when the verified name matches the typed name (case / punctuation / honorific tolerant)", () => {
    // Typed "Mr. JOHN SMITH" vs verified "John Smith" — the helper lowercases,
    // strips non-alphanumerics, and drops the "mr" honorific, so the two
    // tokenised name sets match exactly and no warning is raised.
    render(
      <VerifiedHolderLine
        accountHolderName="Mr. JOHN SMITH"
        verifiedHolderName="John Smith"
      />,
    );

    expect(
      screen.getByText("Verified as: John Smith"),
    ).toBeInTheDocument();

    // Matching path uses the check-circle icon (the @expo/vector-icons mock
    // in __tests__/setup.ts emits a <span data-icon="…"> per icon).
    const icons = document.querySelectorAll("[data-icon]");
    expect(icons.length).toBe(1);
    expect(icons[0].getAttribute("data-icon")).toBe("check-circle");

    // The mismatch sentence must NOT be present in either form.
    expect(screen.queryByText(/doesn't match/i)).toBeNull();
    expect(screen.queryByText(/Re-save if this isn't your account/i)).toBeNull();
  });

  it("shows the amber mismatch warning + alert-triangle icon when the typed name disagrees materially with the verified name", () => {
    // "Jon Smyth" vs "John Smith" — neither token set is a subset of the
    // other and Jaccard overlap is 0/4 = 0 < 0.5, so the helper flags this
    // as a mismatch and the warning copy is rendered.
    render(
      <VerifiedHolderLine
        accountHolderName="Jon Smyth"
        verifiedHolderName="John Smith"
      />,
    );

    // Single combined warning string includes the verified name, the typed
    // name (in curly quotes), and the "Re-save" call to action.
    const warning = screen.getByText(
      /Verified as: John Smith — doesn't match .Jon Smyth.\. Re-save if this isn't your account\./,
    );
    expect(warning).toBeInTheDocument();

    // Mismatch path swaps the icon to alert-triangle.
    const icons = document.querySelectorAll("[data-icon]");
    expect(icons.length).toBe(1);
    expect(icons[0].getAttribute("data-icon")).toBe("alert-triangle");

    // The non-warning copy form must NOT be present (would mean the
    // mismatch branch failed to fire).
    expect(screen.queryByText(/^Verified as: John Smith$/)).toBeNull();
  });

  it("renders nothing when verifiedHolderName is null or an empty string", () => {
    // null branch — the line is fully hidden, mirroring the
    // `payoutAccount.data?.account?.verifiedHolderName ? (…) : null`
    // guard in WalletScreen.
    const { container: nullContainer } = render(
      <VerifiedHolderLine
        accountHolderName="John Smith"
        verifiedHolderName={null}
      />,
    );
    expect(nullContainer.firstChild).toBeNull();
    expect(screen.queryByText(/Verified as:/)).toBeNull();
    expect(document.querySelectorAll("[data-icon]").length).toBe(0);

    // Empty-string branch — same outcome (falsy guard).
    const { container: emptyContainer } = render(
      <VerifiedHolderLine
        accountHolderName="John Smith"
        verifiedHolderName=""
      />,
    );
    expect(emptyContainer.firstChild).toBeNull();
    expect(screen.queryByText(/Verified as:/)).toBeNull();
    expect(document.querySelectorAll("[data-icon]").length).toBe(0);
  });
});
