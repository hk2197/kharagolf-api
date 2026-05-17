/**
 * Task #1877 — Alert admins when no stuck-receipts digest has run for a
 * full period.
 *
 * Pins down the inline "missed run" warning banner that appears above
 * the run-history table on `SideGameReceiptDigestSchedulePanel` when
 * the API surfaces a server-computed `overdueBy` payload (i.e. the
 * cron's `nextRunAt` is more than one full period in the past with no
 * later history row). The banner should:
 *   - render with how long overdue the planned run is,
 *   - link to the existing cron / webhook diagnostics page (`/webhooks`),
 *   - and stay hidden when the cron is on schedule (no `overdueBy`).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

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
  // Planned for two weeks ago — past one full period (7 days) with
  // a sizeable safety margin.
  lastSentAt: "2026-04-01T07:00:00.000Z",
  nextRunAt: "2026-04-08T07:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-04-01T07:00:00.000Z",
};

const HISTORY_BEFORE_NEXTRUNAT = [
  {
    id: 901,
    scheduleId: 7,
    sentAt: "2026-04-01T07:00:00.000Z",
    periodStart: "2026-03-25T07:00:00.000Z",
    periodEnd: "2026-04-01T07:00:00.000Z",
    recipients: ["support@club.com"],
    rowCount: 0,
    exhaustedCount: 0,
    skippedCount: 0,
    status: "sent" as const,
    errorMessage: null,
  },
];

function installFetch(opts: {
  schedule?: typeof SCHEDULE | null;
  history?: typeof HISTORY_BEFORE_NEXTRUNAT;
  overdueBy?: { overdueByMs: number; periodMs: number; expectedAt: string } | null;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/admin/side-game-receipt-failures/email-schedule")) {
        return jsonResponse({
          schedule: opts.schedule === undefined ? SCHEDULE : opts.schedule,
          history: opts.history ?? HISTORY_BEFORE_NEXTRUNAT,
          overdueBy: opts.overdueBy ?? null,
        });
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
  const { hook } = memoryLocation({ path: "/dashboard" });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <SideGameReceiptDigestSchedulePanel orgId={42} />
      </Router>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SideGameReceiptDigestSchedulePanel — missed-run warning (Task #1877)", () => {
  it("shows a 'missed scheduled run' banner above the run-history table when the API reports overdueBy", async () => {
    // Faked overdue: the weekly digest was due 14 days ago.
    const overdueByMs = 14 * 24 * 60 * 60 * 1000;
    installFetch({
      overdueBy: {
        overdueByMs,
        periodMs: 7 * 24 * 60 * 60 * 1000,
        expectedAt: SCHEDULE.nextRunAt,
      },
    });

    renderPanel();

    const banner = await screen.findByTestId("receipt-digest-missed-run-warning");
    expect(banner).toBeInTheDocument();

    // Surfaces how long overdue the run is, in human-readable units.
    const overdue = await screen.findByTestId("receipt-digest-missed-run-overdue");
    expect(overdue.textContent).toMatch(/14 days/);

    // Sits above the run-history table (sparkline / table render below).
    const table = await screen.findByTestId("receipt-digest-history-row-901");
    expect(banner.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Links to the existing cron / webhook diagnostics page.
    const link = screen.getByTestId("link-receipt-digest-cron-diagnostics");
    expect(link.getAttribute("href")).toBe("/webhooks");
  });

  it("does not render the banner when the API reports no overdueBy (cron is on schedule)", async () => {
    installFetch({ overdueBy: null });
    renderPanel();

    // Wait for the panel to finish loading by anchoring on a stable
    // element that always renders once the schedule is in.
    await screen.findByTestId("receipt-digest-history-row-901");
    expect(screen.queryByTestId("receipt-digest-missed-run-warning")).not.toBeInTheDocument();
  });
});
