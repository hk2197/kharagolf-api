/**
 * Task #1523 — UI smoke test for distinguishing "clean week — 0 stuck"
 * digest runs from runs that actually surfaced stuck receipts.
 *
 * Pins down two things on `SideGameReceiptDigestSchedulePanel`:
 *  1. Each history row carries `data-clean-week` and `data-has-stuck` flags
 *     so the row tone, badge tone, and badge label diverge between
 *     status=sent rowCount=0 (clean week) and status=sent rowCount>0
 *     (admin-attention-needed). Previously both rendered the same way.
 *  2. The sparkline header above the table summarises the recent run mix
 *     (clean / with stuck / failed-or-skipped) so admins can see at a
 *     glance whether the cron is running on quiet weeks.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
  id: 7,
  organizationId: 42,
  frequency: "weekly" as const,
  recipients: ["support@club.com"],
  enabled: true,
  lastSentAt: "2026-04-22T10:00:00.000Z",
  nextRunAt: "2026-04-29T10:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-04-22T10:00:00.000Z",
};

const HISTORY = [
  // Newest first — matches the API ordering (desc(sentAt)).
  {
    id: 301,
    scheduleId: 7,
    sentAt: "2026-04-22T10:00:00.000Z",
    periodStart: "2026-04-15T10:00:00.000Z",
    periodEnd: "2026-04-22T10:00:00.000Z",
    recipients: ["support@club.com"],
    rowCount: 0,
    exhaustedCount: 0,
    skippedCount: 0,
    status: "sent" as const,
    errorMessage: null,
  },
  {
    id: 302,
    scheduleId: 7,
    sentAt: "2026-04-15T10:00:00.000Z",
    periodStart: "2026-04-08T10:00:00.000Z",
    periodEnd: "2026-04-15T10:00:00.000Z",
    recipients: ["support@club.com"],
    rowCount: 47,
    exhaustedCount: 12,
    skippedCount: 3,
    status: "sent" as const,
    errorMessage: null,
  },
  {
    id: 303,
    scheduleId: 7,
    sentAt: "2026-04-08T10:00:00.000Z",
    periodStart: "2026-04-01T10:00:00.000Z",
    periodEnd: "2026-04-08T10:00:00.000Z",
    recipients: ["support@club.com"],
    rowCount: 0,
    exhaustedCount: 0,
    skippedCount: 0,
    status: "failed" as const,
    errorMessage: "SMTP connection refused",
  },
];

function installFetch(history = HISTORY) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/admin/side-game-receipt-failures/email-schedule")) {
        return jsonResponse({ schedule: SCHEDULE, history });
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
      <SideGameReceiptDigestSchedulePanel orgId={42} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SideGameReceiptDigestSchedulePanel — clean vs. stuck visual distinction (Task #1523)", () => {
  it("flags status=sent rowCount=0 rows as clean weeks and rowCount>0 rows as needing attention", async () => {
    installFetch();
    renderPanel();

    const cleanRow = await screen.findByTestId("receipt-digest-history-row-301");
    const stuckRow = await screen.findByTestId("receipt-digest-history-row-302");
    const failedRow = await screen.findByTestId("receipt-digest-history-row-303");

    // Clean week: rowCount === 0 and status === 'sent'.
    expect(cleanRow.getAttribute("data-clean-week")).toBe("true");
    expect(cleanRow.getAttribute("data-has-stuck")).toBe("false");
    const cleanBadge = await screen.findByTestId("receipt-digest-history-status-301");
    expect(cleanBadge.textContent).toMatch(/clean/i);
    expect(cleanBadge.textContent).toMatch(/0/);

    // Stuck row: rowCount > 0 and status === 'sent'.
    expect(stuckRow.getAttribute("data-clean-week")).toBe("false");
    expect(stuckRow.getAttribute("data-has-stuck")).toBe("true");
    const stuckBadge = await screen.findByTestId("receipt-digest-history-status-302");
    expect(stuckBadge.textContent).toMatch(/sent/i);
    expect(stuckBadge.textContent).toMatch(/47/);

    // Failed row: neither clean nor stuck.
    expect(failedRow.getAttribute("data-clean-week")).toBe("false");
    expect(failedRow.getAttribute("data-has-stuck")).toBe("false");
    const failedBadge = await screen.findByTestId("receipt-digest-history-status-303");
    expect(failedBadge.textContent).toMatch(/failed/i);
  });

  it("renders the sparkline header summarising clean / with-stuck / failed runs", async () => {
    installFetch();
    renderPanel();

    const sparkline = await screen.findByTestId("receipt-digest-history-sparkline");
    expect(sparkline).toBeInTheDocument();

    // Counts must match the HISTORY fixture (1 clean, 1 stuck, 1 failed).
    expect((await screen.findByTestId("receipt-digest-clean-count")).textContent).toBe("1");
    expect((await screen.findByTestId("receipt-digest-stuck-count")).textContent).toBe("1");
    expect((await screen.findByTestId("receipt-digest-other-count")).textContent).toBe("1");

    // Each history row gets its own bar in the sparkline so admins can hover.
    await waitFor(() => {
      expect(screen.getByTestId("receipt-digest-spark-bar-301")).toBeInTheDocument();
      expect(screen.getByTestId("receipt-digest-spark-bar-302")).toBeInTheDocument();
      expect(screen.getByTestId("receipt-digest-spark-bar-303")).toBeInTheDocument();
    });
  });

  it("hides the sparkline when there is no run history yet", async () => {
    installFetch([]);
    renderPanel();

    // Wait until the schedule has loaded so the empty-state row is in the DOM.
    await screen.findByTestId("receipt-digest-history-empty");
    expect(screen.queryByTestId("receipt-digest-history-sparkline")).not.toBeInTheDocument();
  });
});
