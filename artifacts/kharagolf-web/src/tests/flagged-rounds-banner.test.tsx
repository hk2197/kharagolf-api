/**
 * Component test: Players-tab data-quality banner manual-entry alert badge
 * (Task #1192 / Task #1375).
 *
 * Renders the extracted `FlaggedRoundsBanner` (split out of the 10k-line
 * `tournament-detail.tsx` so it is testable in isolation) with a mix of rows
 * that have an `alertedAt` timestamp + `alertDelivery` block and rows that do
 * not. Asserts:
 *   - the badge shows up only for rows with `alertedAt`, with the expected
 *     HH:MM (so a future change to `toLocaleTimeString` formatting or the
 *     data-quality response shape will trip the test);
 *   - rows without `alertedAt` render no badge;
 *   - hovering the badge surfaces the recipient + push/email sent/attempted
 *     counts in the Radix tooltip.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  FlaggedRoundsBanner,
  type DataQualityRow,
} from "../components/FlaggedRoundsBanner";
import { TooltipProvider } from "../components/ui/tooltip";

const ALERTED_ROW: DataQualityRow = {
  playerId: 42,
  playerName: "Sora Tanaka",
  round: 2,
  total: 30,
  counts: { watch: 4, phone: 5, scorer: 3, manual: 18 },
  manualPct: 60,
  flagged: true,
  // 2026-04-24 14:05 UTC — pin a fixed UTC instant; locale-format both sides
  // so the assertion stays stable regardless of CI timezone.
  alertedAt: "2026-04-24T14:05:00.000Z",
  alertDelivery: {
    recipientCount: 7,
    pushAttempted: 5,
    pushSent: 4,
    emailAttempted: 7,
    emailSent: 6,
  },
};

const UNALERTED_ROW: DataQualityRow = {
  playerId: 99,
  playerName: "Mira Okafor",
  round: 1,
  total: 28,
  counts: { watch: 3, phone: 4, scorer: 5, manual: 16 },
  manualPct: 57,
  flagged: true,
  alertedAt: null,
  alertDelivery: null,
};

// Task #1658 — skip rows have an audit row but `alertedAt` stays null
// (no fan-out happened) and `alertStatus` carries the canonical
// 'skipped' / 'failed' string with the matching reason. The banner is
// expected to render a muted-amber skip badge instead of the
// "alerted at HH:MM" timestamp badge.
const SKIPPED_ROW: DataQualityRow = {
  playerId: 173,
  playerName: "Ava Patel",
  round: 3,
  total: 24,
  counts: { watch: 2, phone: 3, scorer: 4, manual: 15 },
  manualPct: 62,
  flagged: true,
  alertedAt: null,
  alertDelivery: null,
  alertStatus: "skipped",
  alertReason: "org_muted",
};

function renderBanner(rows: DataQualityRow[]) {
  return render(
    // The page wraps the whole tournament-detail subtree in a TooltipProvider;
    // mirror that here so the Radix tooltip can mount inside the test.
    <TooltipProvider delayDuration={0}>
      <FlaggedRoundsBanner flaggedRounds={rows} />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe("FlaggedRoundsBanner — manual-entry alert badge", () => {
  it("renders no banner at all when there are no flagged rounds", () => {
    const { container } = renderBanner([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the alert badge with the expected HH:MM for rows that have alertedAt", () => {
    renderBanner([ALERTED_ROW]);

    const badge = screen.getByTestId(
      `alert-badge-${ALERTED_ROW.playerId}-${ALERTED_ROW.round}`
    );
    expect(badge).toBeInTheDocument();

    const expectedTime = new Date(ALERTED_ROW.alertedAt as string)
      .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(badge).toHaveTextContent(`alerted at ${expectedTime}`);
  });

  it("does not render an alert badge for rows where alertedAt is missing", () => {
    renderBanner([UNALERTED_ROW]);

    expect(
      screen.queryByTestId(
        `alert-badge-${UNALERTED_ROW.playerId}-${UNALERTED_ROW.round}`
      )
    ).not.toBeInTheDocument();
    // The flagged row itself should still render so the TD sees the manual %.
    expect(screen.getByText(/Mira Okafor R1 — 57% manual/)).toBeInTheDocument();
  });

  it("renders a skip-reason badge instead of the alerted-at badge for status='skipped' rows (Task #1658)", () => {
    renderBanner([SKIPPED_ROW]);

    // Sanity: no alerted-at badge for the skipped row.
    expect(
      screen.queryByTestId(`alert-badge-${SKIPPED_ROW.playerId}-${SKIPPED_ROW.round}`)
    ).not.toBeInTheDocument();

    const skipBadge = screen.getByTestId(
      `alert-badge-skip-${SKIPPED_ROW.playerId}-${SKIPPED_ROW.round}`
    );
    expect(skipBadge).toBeInTheDocument();
    // The label is the canonical reason humanised by `describeSkipReason`
    // — anchoring this in a test guards against a future reason rename
    // accidentally surfacing a raw `org_muted` string to a TD.
    expect(skipBadge).toHaveTextContent("skipped — org muted");
  });

  it("surfaces recipient + push/email sent/attempted counts in the tooltip on hover", async () => {
    renderBanner([ALERTED_ROW, UNALERTED_ROW]);

    // Sanity check: only the alerted row gets a badge.
    expect(
      screen.queryByTestId(
        `alert-badge-${UNALERTED_ROW.playerId}-${UNALERTED_ROW.round}`
      )
    ).not.toBeInTheDocument();

    const badge = screen.getByTestId(
      `alert-badge-${ALERTED_ROW.playerId}-${ALERTED_ROW.round}`
    );

    const user = userEvent.setup();
    await user.hover(badge);

    // Radix portals the content and also renders a hidden screen-reader copy
    // (role="tooltip"), so each line shows up twice — assert "at least one" via
    // getAllByText to keep the test stable if Radix changes the duplication.
    await waitFor(() => {
      expect(screen.getAllByText("Manual-entry alert delivery").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/Recipients:\s*7/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Push:\s*4\s*\/\s*5\s*sent/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Email:\s*6\s*\/\s*7\s*sent/).length).toBeGreaterThan(0);
  });
});
