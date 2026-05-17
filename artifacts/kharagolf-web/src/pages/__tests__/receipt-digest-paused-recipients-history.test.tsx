/**
 * Task #2196 — UI smoke test for the per-row paused-recipients chip on
 * the side-game receipt digest history table.
 *
 * Mirrors the wallet auto-refund counterpart (Task #1759) so the two
 * digest dashboards share their behavioural contract — on-call engineers
 * only have to learn one mental model. The history table reads from the
 * snapshot column persisted by the cron, so the chip stays accurate
 * even after support later lifts the suppression.
 *
 * Pins down three things on `SideGameReceiptDigestSchedulePanel`:
 *
 *   1. Rows whose `pausedRecipients` snapshot is non-empty render a
 *      "{N} paused" chip with one `<li>` per pruned recipient labelled
 *      with the friendly reason ("Bounced (HardBounce)", "Unsubscribed",
 *      "Spam complaint", "Manually suppressed").
 *
 *   2. Rows whose snapshot is empty render an em-dash placeholder so
 *      support can quickly scan the column for trouble.
 *
 *   3. Rows that come back without the field at all (defensive
 *      fallback for a stale serializer that drops it) treat it as
 *      empty rather than crashing the panel.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { SideGameReceiptDigestSchedulePanel } from "../dashboard";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const SCHEDULE = {
  id: 9,
  organizationId: 99,
  frequency: "weekly" as const,
  recipients: ["support@club.com"],
  enabled: true,
  lastSentAt: "2026-04-22T10:00:00.000Z",
  nextRunAt: "2026-04-29T10:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-04-22T10:00:00.000Z",
};

const HISTORY = [
  {
    // Row with two paused recipients — covers the "Bounced
    // (BounceType)" and "Spam complaint" labels.
    id: 401,
    scheduleId: 9,
    sentAt: "2026-04-22T10:00:00.000Z",
    periodStart: "2026-04-15T10:00:00.000Z",
    periodEnd: "2026-04-22T10:00:00.000Z",
    recipients: ["support@club.com"],
    rowCount: 4,
    exhaustedCount: 1,
    skippedCount: 0,
    status: "sent" as const,
    errorMessage: "paused 2 bounced/unsubscribed recipient(s): bounce@club.com, spam@club.com",
    pausedRecipients: [
      { email: "bounce@club.com", reason: "bounced", bounceType: "HardBounce", description: "550 user unknown" },
      { email: "spam@club.com", reason: "spam_complaint", bounceType: "SpamComplaint", description: null },
    ],
  },
  {
    // Row with one manually-suppressed recipient — covers the
    // null-bounceType fallback and the "Manually suppressed" label.
    id: 402,
    scheduleId: 9,
    sentAt: "2026-04-15T10:00:00.000Z",
    periodStart: "2026-04-08T10:00:00.000Z",
    periodEnd: "2026-04-15T10:00:00.000Z",
    recipients: ["support@club.com"],
    rowCount: 0,
    exhaustedCount: 0,
    skippedCount: 0,
    status: "sent" as const,
    errorMessage: null,
    pausedRecipients: [
      { email: "manual@club.com", reason: "manual", bounceType: null, description: null },
    ],
  },
  {
    // Clean run — explicit empty array.
    id: 403,
    scheduleId: 9,
    sentAt: "2026-04-08T10:00:00.000Z",
    periodStart: "2026-04-01T10:00:00.000Z",
    periodEnd: "2026-04-08T10:00:00.000Z",
    recipients: ["support@club.com"],
    rowCount: 2,
    exhaustedCount: 0,
    skippedCount: 0,
    status: "sent" as const,
    errorMessage: null,
    pausedRecipients: [],
  },
  {
    // Defensive fallback row — pre-#2196 serializer drops the field
    // entirely. The panel must treat it as empty, not crash.
    id: 404,
    scheduleId: 9,
    sentAt: "2026-04-01T10:00:00.000Z",
    periodStart: "2026-03-25T10:00:00.000Z",
    periodEnd: "2026-04-01T10:00:00.000Z",
    recipients: ["support@club.com"],
    rowCount: 0,
    exhaustedCount: 0,
    skippedCount: 0,
    status: "sent" as const,
    errorMessage: null,
    // pausedRecipients deliberately omitted.
  },
];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/admin/side-game-receipt-failures/email-schedule")) {
        return jsonResponse({ schedule: SCHEDULE, history: HISTORY });
      }
      return jsonResponse({}, 200);
    }),
  );
}

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SideGameReceiptDigestSchedulePanel orgId={99} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SideGameReceiptDigestSchedulePanel — paused-recipients history chip (Task #2196)", () => {
  it("renders a {N} paused chip plus one row per pruned recipient with the friendly reason label", async () => {
    installFetch();
    renderPanel();

    const chip = await screen.findByTestId("receipt-digest-history-paused-chip-401");
    expect(chip.textContent).toMatch(/2 paused/);

    const wrapper = await screen.findByTestId("receipt-digest-history-paused-401");
    const within401 = within(wrapper);

    const row0 = within401.getByTestId("receipt-digest-history-paused-row-401-0");
    expect(row0.textContent).toContain("bounce@club.com");
    expect(row0.textContent).toMatch(/Bounced \(HardBounce\)/);

    const row1 = within401.getByTestId("receipt-digest-history-paused-row-401-1");
    expect(row1.textContent).toContain("spam@club.com");
    expect(row1.textContent).toMatch(/Spam complaint/);
  });

  it("falls back to the bare 'Bounced' label and the 'Manually suppressed' label when bounceType is null", async () => {
    installFetch();
    renderPanel();

    const chip = await screen.findByTestId("receipt-digest-history-paused-chip-402");
    expect(chip.textContent).toMatch(/1 paused/);

    const row = await screen.findByTestId("receipt-digest-history-paused-row-402-0");
    expect(row.textContent).toContain("manual@club.com");
    expect(row.textContent).toMatch(/Manually suppressed/);
  });

  it("renders an em-dash placeholder when the snapshot is empty and when the field is omitted entirely", async () => {
    installFetch();
    renderPanel();

    const empty403 = await screen.findByTestId("receipt-digest-history-paused-empty-403");
    expect(empty403.textContent).toBe("—");

    const empty404 = await screen.findByTestId("receipt-digest-history-paused-empty-404");
    expect(empty404.textContent).toBe("—");

    // And the populated rows do NOT render the empty placeholder.
    expect(screen.queryByTestId("receipt-digest-history-paused-empty-401")).not.toBeInTheDocument();
    expect(screen.queryByTestId("receipt-digest-history-paused-empty-402")).not.toBeInTheDocument();
  });
});
