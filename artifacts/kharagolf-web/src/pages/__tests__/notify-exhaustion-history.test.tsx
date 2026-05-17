/**
 * Task #1304 — Smoke tests for the in-app ops alert history page.
 *
 * Pins the contract that mattered when this page was built:
 *   - Non-admin sees the "no access" panel and the API isn't called.
 *   - Admin sees the per-day buckets, including counts and the "alerted"
 *     flag for days that crossed the threshold.
 *   - Clicking a non-zero channel cell expands a drill-down and
 *     fetches /api/admin/notify-exhaustion-rows for that bucket.
 *   - Drilled-in rows render a triage link to the right place
 *     (coach-admin for coach payouts, member-360 for levy receipts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

import NotifyExhaustionHistoryPage from "../notify-exhaustion-history";

interface FetchCall { url: string }
let fetchCalls: FetchCall[];
let meRole: string | null;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const HISTORY_BODY = {
  days: 7,
  buckets: [
    // oldest → newest; the page reverses for display.
    {
      date: "2026-04-14",
      coachPayout: { push: 0, sms: 0, rows: 0 },
      levyReceipt: { push: 0, sms: 0, rows: 0 },
      totalRows: 0,
      alerted: false,
    },
    {
      date: "2026-04-19",
      coachPayout: { push: 3, sms: 1, rows: 3 },
      levyReceipt: { push: 1, sms: 0, rows: 1 },
      totalRows: 4,
      alerted: false,
    },
    {
      date: "2026-04-20",
      coachPayout: { push: 6, sms: 2, rows: 6 },
      levyReceipt: { push: 0, sms: 0, rows: 0 },
      totalRows: 6,
      alerted: true,
    },
  ],
  recipients: {
    emails: ["ops@kharagolf.com", "oncall@kharagolf.com"],
    source: "env" as const,
    envVar: "OPS_ALERT_EMAILS",
  },
};

const COACH_ROWS_BODY = {
  pipeline: "coach_payout",
  channel: "push",
  date: "2026-04-20",
  rows: [
    {
      id: 901,
      organizationId: 1,
      exhaustedAt: "2026-04-20T11:30:00.000Z",
      date: "2026-04-20",
      payoutId: 555,
      proId: 77,
      reference: "PAY-X",
    },
  ],
};

beforeEach(() => {
  fetchCalls = [];
  meRole = "org_admin";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url });
      if (url.endsWith("/api/auth/me")) {
        if (meRole == null) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse({ role: meRole });
      }
      if (url.startsWith("/api/admin/notify-exhaustion-history")) {
        return jsonResponse(HISTORY_BODY);
      }
      if (url.startsWith("/api/admin/notify-exhaustion-rows")) {
        return jsonResponse(COACH_ROWS_BODY);
      }
      return jsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router>
        <NotifyExhaustionHistoryPage />
      </Router>
    </QueryClientProvider>,
  );
}

describe("NotifyExhaustionHistoryPage", () => {
  it("shows the no-access panel for non-admins and never calls the history endpoint", async () => {
    meRole = "player";
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("notify-exhaustion-no-access")).toBeTruthy();
    });
    // Should not have hit the admin endpoint.
    const hits = fetchCalls.filter(c => c.url.startsWith("/api/admin/notify-exhaustion-history"));
    expect(hits.length).toBe(0);
  });

  it("renders day rows with counts and flags alerted days", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("row-day-2026-04-20")).toBeTruthy();
    });
    // Newest day on top → 2026-04-20 row exists, has alerted flag and total 6.
    const todayRow = screen.getByTestId("row-day-2026-04-20");
    expect(todayRow.textContent).toContain("2026-04-20");
    expect(screen.getByTestId("cell-alerted-2026-04-20")).toBeTruthy();
    expect(screen.getByTestId("cell-total-2026-04-20").textContent).toContain("6");
    // Yesterday is below threshold → no alerted badge.
    expect(screen.queryByTestId("cell-alerted-2026-04-19")).toBeNull();
  });

  it("expands a non-zero cell and fetches drill-down rows with a triage link", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("btn-drill-coach_payout-push-2026-04-20")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("btn-drill-coach_payout-push-2026-04-20"));
    await waitFor(() => {
      expect(screen.getByTestId("drilldown-row-coach_payout-901")).toBeTruthy();
    });
    const link = screen.getByTestId("triage-link-coach_payout-901") as HTMLAnchorElement;
    // The triage URL must deep-link into coach-admin with coach=proId so
    // the existing payout-history scroll target picks it up.
    expect(link.getAttribute("href")).toBe("/coach-admin?coach=77#payout-history");

    // Fetched the rows endpoint with the right query params.
    const drillCall = fetchCalls.find(c =>
      c.url.startsWith("/api/admin/notify-exhaustion-rows")
      && c.url.includes("pipeline=coach_payout")
      && c.url.includes("channel=push")
      && c.url.includes("date=2026-04-20"),
    );
    expect(drillCall).toBeTruthy();
  });

  // Task #1541 — the history page must surface the configured ops-alert
  // recipients inline so admins can see, alongside the per-day breach
  // flags, exactly which addresses would have received the breach
  // email. The provenance line lets them tell at a glance whether the
  // list comes from env or a per-org override.
  it("renders the configured ops-alert recipients with their provenance", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("ops-alert-recipients")).toBeTruthy();
    });
    const list = screen.getByTestId("ops-alert-recipients-list");
    expect(list.textContent).toContain("ops@kharagolf.com");
    expect(list.textContent).toContain("oncall@kharagolf.com");
    const source = screen.getByTestId("ops-alert-recipients-source");
    expect(source.textContent).toContain("OPS_ALERT_EMAILS");
  });

  it("flags an empty recipient list so admins notice silent breaches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        fetchCalls.push({ url });
        if (url.endsWith("/api/auth/me")) return jsonResponse({ role: "org_admin" });
        if (url.startsWith("/api/admin/notify-exhaustion-history")) {
          return jsonResponse({
            ...HISTORY_BODY,
            recipients: { emails: [], source: "env", envVar: "OPS_ALERT_EMAILS" },
          });
        }
        return jsonResponse({}, 404);
      }),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("ops-alert-recipients-empty")).toBeTruthy();
    });
    expect(screen.queryByTestId("ops-alert-recipients-list")).toBeNull();
  });

  it("does not let admins drill into a zero-count cell", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("btn-drill-levy_receipt-push-2026-04-20")).toBeTruthy();
    });
    const zeroBtn = screen.getByTestId("btn-drill-levy_receipt-push-2026-04-20") as HTMLButtonElement;
    expect(zeroBtn.disabled).toBe(true);
  });
});
