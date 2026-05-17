/**
 * UI test for the VerifiedHolderLine sub-component (Task #1293).
 *
 * Task #1120 added a "Verified as: <name>" line under the wallet payout
 * summary in SideGamesAdmin's WalletPanel, plus an amber mismatch warning
 * when the bank-returned name disagrees materially with what the member
 * typed. The behaviour was previously only manually verified — this file
 * locks in:
 *   1. The matching path: API returns `verifiedHolderName` that matches the
 *      typed name (case / punctuation / honorific differences are
 *      normalised away). The line shows "Verified as: …" with NO amber
 *      mismatch warning copy.
 *   2. The mismatch path: typed "Jon Smyth" vs verified "John Smith" — the
 *      amber warning sentence is shown and the verified name itself flips
 *      to the amber colour class.
 *   3. The hidden path: when `verifiedHolderName` is null OR an empty
 *      string the line is not rendered at all (mirrors the
 *      `payout?.account?.verifiedHolderName && (…)` guard in WalletPanel).
 *
 * VerifiedHolderLine was extracted from the inline IIFE inside WalletPanel
 * specifically so this matching/normalisation logic can be exercised
 * without mocking the wallet, payout-account, and withdrawals API
 * endpoints that WalletPanel fans out to on mount.
 */
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { VerifiedHolderLine } from "../SideGamesAdmin";

afterEach(() => {
  cleanup();
});

describe("VerifiedHolderLine (Task #1293)", () => {
  it("shows 'Verified as: <name>' with no mismatch warning when the verified name matches the typed name (case / punctuation / honorific tolerant)", () => {
    // Typed "Mr. JOHN SMITH" vs verified "John Smith" — the helper lowercases,
    // strips non-alphanumerics, and drops the "mr" honorific, so the two
    // tokenised name sets match exactly and no amber warning copy appears.
    render(
      <VerifiedHolderLine
        accountHolderName="Mr. JOHN SMITH"
        verifiedHolderName="John Smith"
      />,
    );

    // The verified-name span is rendered.
    const verifiedNode = screen.getByText("John Smith");
    expect(verifiedNode).toBeInTheDocument();
    // Matching path uses the white text class, NOT amber-200.
    expect(verifiedNode.className).toContain("text-white");
    expect(verifiedNode.className).not.toContain("text-amber-200");

    // The outer wrapper uses the muted (non-warning) colour.
    const wrapper = verifiedNode.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("text-muted-foreground");
    expect(wrapper!.className).not.toContain("text-amber-300");

    // The mismatch sentence must NOT be present.
    expect(
      screen.queryByText(/doesn't match what you entered/i),
    ).toBeNull();
  });

  it("shows the amber mismatch warning when the typed name disagrees materially with the verified name", () => {
    // "Jon Smyth" vs "John Smith" — neither token set is a subset of the
    // other and Jaccard overlap is 0/4 = 0 < 0.5, so the helper flags this
    // as a mismatch and the amber warning copy is rendered.
    render(
      <VerifiedHolderLine
        accountHolderName="Jon Smyth"
        verifiedHolderName="John Smith"
      />,
    );

    const verifiedNode = screen.getByText("John Smith");
    expect(verifiedNode).toBeInTheDocument();
    // Mismatch flips the verified-name span to the amber-200 class.
    expect(verifiedNode.className).toContain("text-amber-200");
    expect(verifiedNode.className).not.toContain("text-white");

    // The wrapper switches to the amber-300 warning colour.
    const wrapper = verifiedNode.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("text-amber-300");
    expect(wrapper!.className).not.toContain("text-muted-foreground");

    // The mismatch sentence is shown and quotes the typed name verbatim so
    // the member can see what they originally entered.
    const warning = screen.getByText(
      /doesn't match what you entered .+Jon Smyth.+ Re-save if this isn't your account\./,
    );
    expect(warning).toBeInTheDocument();
  });

  it("renders nothing when verifiedHolderName is null or an empty string", () => {
    // null branch — the line is fully hidden, mirroring the
    // `payout?.account?.verifiedHolderName && (…)` guard in WalletPanel.
    const { container: nullContainer } = render(
      <VerifiedHolderLine
        accountHolderName="John Smith"
        verifiedHolderName={null}
      />,
    );
    expect(nullContainer.firstChild).toBeNull();
    expect(screen.queryByText(/Verified as:/)).toBeNull();

    // Empty-string branch — same outcome (falsy guard).
    const { container: emptyContainer } = render(
      <VerifiedHolderLine
        accountHolderName="John Smith"
        verifiedHolderName=""
      />,
    );
    expect(emptyContainer.firstChild).toBeNull();
    expect(screen.queryByText(/Verified as:/)).toBeNull();
  });
});
