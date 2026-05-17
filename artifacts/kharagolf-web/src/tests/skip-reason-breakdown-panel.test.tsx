/**
 * Component test: super-admin manual-entry alert dashboard "Why rounds
 * got skipped" breakdown panel (Task #1657).
 *
 * Renders the extracted `SkipReasonBreakdownPanel` (split out of
 * `pages/manual-entry-alerts.tsx` so it is testable in isolation) with
 * representative breakdown payloads and asserts the contract the
 * dashboard chart depends on:
 *   - Empty state shows the "no skipped or failed alerts" copy with
 *     no zero-count bars cluttering the panel.
 *   - Buckets returned by the backend (including zero-count ones)
 *     render in count-desc order, with the "Other" bucket pinned last.
 *   - A `logSearchUrl` on a bucket promotes its label into a
 *     drill-through anchor that opens in a new tab; null `logSearchUrl`
 *     buckets render as plain labels.
 *   - Counts split by `failedCount` show a "(N failed)" suffix.
 *   - The defensive "Other" bucket renders the `fallback` badge.
 *
 * Uses `@testing-library/react` (matches the rest of the kharagolf-web
 * suite — see `flagged-rounds-banner.test.tsx`).
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import {
  SkipReasonBreakdownPanel,
  type SkipReasonBreakdown,
} from "../components/SkipReasonBreakdownPanel";

afterEach(() => cleanup());

function emptyBreakdown(): SkipReasonBreakdown {
  return {
    "7d": { totalCount: 0, buckets: [] },
    "30d": { totalCount: 0, buckets: [] },
  };
}

describe("SkipReasonBreakdownPanel", () => {
  it("shows the empty-state copy when no buckets have any rows", () => {
    render(<SkipReasonBreakdownPanel breakdown={emptyBreakdown()} />);

    expect(screen.getByTestId("panel-skip-reason-breakdown")).toBeTruthy();
    // Both windows render an empty-state message — the chart is not
    // hidden when totals are zero (otherwise ops can't tell whether
    // the dashboard is healthy or just broken).
    expect(screen.getByTestId("skip-reason-empty-7d")).toBeTruthy();
    expect(screen.getByTestId("skip-reason-empty-30d")).toBeTruthy();

    // Totals headers render with the correct count + pluralisation.
    const total7 = screen.getByTestId("skip-reason-total-7d");
    expect(total7.textContent).toContain("0 non-deliveries");
    const total30 = screen.getByTestId("skip-reason-total-30d");
    expect(total30.textContent).toContain("0 non-deliveries");
  });

  it("renders buckets in count-desc order, pins 'Other' last, and surfaces drill-through links", () => {
    const breakdown: SkipReasonBreakdown = {
      "7d": {
        totalCount: 6,
        buckets: [
          // Highest count — must render first.
          {
            reason: "org_muted",
            isOther: false,
            count: 4,
            skippedCount: 4,
            failedCount: 0,
            logSearchUrl: "https://logs.example.com/?q=reason%3Dorg_muted&from=now-7d",
          },
          // Failure-heavy bucket with a drill-through link and a
          // "(1 failed)" suffix.
          {
            reason: "org_lookup_failed",
            isOther: false,
            count: 1,
            skippedCount: 0,
            failedCount: 1,
            logSearchUrl: "https://logs.example.com/?q=reason%3Dorg_lookup_failed&from=now-7d",
          },
          // Zero-count canonical bucket — must still render so ops can
          // see the reason exists. No drill-link in this fixture so we
          // can assert it falls back to a plain label.
          {
            reason: "below_threshold",
            isOther: false,
            count: 0,
            skippedCount: 0,
            failedCount: 0,
            logSearchUrl: null,
          },
          // Defensive "Other" bucket — should be pinned last regardless
          // of the input order, and carry the `fallback` badge.
          {
            reason: "other",
            isOther: true,
            count: 1,
            skippedCount: 0,
            failedCount: 1,
            logSearchUrl: null,
          },
        ],
      },
      "30d": { totalCount: 0, buckets: [] },
    };

    render(<SkipReasonBreakdownPanel breakdown={breakdown} />);

    const window7 = screen.getByTestId("skip-reason-window-7d");

    // Pluralisation flips at count 1 (singular) — count 6 is plural.
    expect(within(window7).getByTestId("skip-reason-total-7d").textContent)
      .toContain("6 non-deliveries");

    // Order assertion: org_muted (4) → org_lookup_failed (1) →
    // other (1, pinned last by tie-break) → below_threshold (0).
    const bars = within(window7).getAllByTestId(/^skip-reason-bar-7d-/);
    const reasons = bars.map((el) => (el.getAttribute("data-testid") ?? "").replace("skip-reason-bar-7d-", ""));
    expect(reasons).toEqual([
      "org_muted",
      "org_lookup_failed",
      "other",
      "below_threshold",
    ]);

    // org_muted renders a drill-through anchor with the right URL.
    const mutedLink = within(window7).getByTestId("skip-reason-link-7d-org_muted") as HTMLAnchorElement;
    expect(mutedLink.tagName).toBe("A");
    expect(mutedLink.getAttribute("href"))
      .toBe("https://logs.example.com/?q=reason%3Dorg_muted&from=now-7d");
    // Opens in a new tab with safe rel — important so super-admin
    // doesn't lose dashboard state when drilling out to logs.
    expect(mutedLink.getAttribute("target")).toBe("_blank");
    expect(mutedLink.getAttribute("rel")).toContain("noopener");

    // Failure-heavy bucket: count cell shows the "(1 failed)" suffix.
    const lookupCount = within(window7).getByTestId("skip-reason-count-7d-org_lookup_failed");
    expect(lookupCount.textContent).toContain("1");
    expect(lookupCount.textContent).toContain("(1 failed)");

    // Zero-count canonical bucket: no drill-link wrapper, plain label.
    expect(within(window7).queryByTestId("skip-reason-link-7d-below_threshold")).toBeNull();
    const belowCount = within(window7).getByTestId("skip-reason-count-7d-below_threshold");
    expect(belowCount.textContent?.trim()).toBe("0");

    // "Other" bucket: defensive fallback badge is visible and the bar
    // has no drill-through (the log query can't filter on
    // "anything not in the canonical set").
    const otherBar = within(window7).getByTestId("skip-reason-bar-7d-other");
    expect(within(otherBar).getByText("fallback")).toBeTruthy();
    expect(within(window7).queryByTestId("skip-reason-link-7d-other")).toBeNull();

    // The 30d window is empty — its empty-state copy is still rendered.
    expect(screen.getByTestId("skip-reason-empty-30d")).toBeTruthy();
  });

  it("applies the singular 'non-delivery' suffix when totalCount is exactly 1", () => {
    const breakdown: SkipReasonBreakdown = {
      "7d": {
        totalCount: 1,
        buckets: [
          {
            reason: "org_muted",
            isOther: false,
            count: 1,
            skippedCount: 1,
            failedCount: 0,
            logSearchUrl: null,
          },
        ],
      },
      "30d": { totalCount: 0, buckets: [] },
    };
    render(<SkipReasonBreakdownPanel breakdown={breakdown} />);
    expect(screen.getByTestId("skip-reason-total-7d").textContent)
      .toContain("1 non-delivery");
    // No empty-state copy when there's a populated bucket.
    expect(screen.queryByTestId("skip-reason-empty-7d")).toBeNull();
  });
});
