/**
 * Component test: /admin/email-cta-stats page (Task #2018).
 *
 * Mounts <AdminEmailCtaStatsPage /> with a mocked auth hook + mocked
 * fetch and asserts:
 *
 *   1. Non-super-admin roles see the "Super admin access required"
 *      gate and the CTA stats endpoint is NEVER called.
 *   2. Super admins see the table with rows from the mocked endpoint
 *      and the default 30-day window query is applied.
 *   3. Changing the window to "All time" drops the `sinceDays` query
 *      param entirely.
 *   4. Clicking the "Clicks" column header re-sorts the table by
 *      click count without re-fetching.
 *   5. Rows with `clickThroughRate: null` (zero sends) sink to the
 *      bottom regardless of sort direction.
 *
 * Regression guard: a typo in the role gate, the sinceDays param
 * name, or the null-CTR sort behaviour would fail this test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let currentRole: "org_admin" | "super_admin" = "super_admin";
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, role: currentRole, organizationId: 4242 },
    isLoading: false,
  }),
}));

import AdminEmailCtaStatsPage from "../admin-email-cta-stats";

const ROWS = [
  {
    notificationKey: "booking.confirmed",
    sendCount: 200,
    clickCount: 50, // 25% CTR
    clickThroughRate: 0.25,
    lastClickAt: "2026-04-29T10:00:00.000Z",
    lastSentAt: "2026-04-30T08:00:00.000Z",
  },
  {
    notificationKey: "highlight.ready",
    sendCount: 1000,
    clickCount: 100, // 10% CTR
    clickThroughRate: 0.1,
    lastClickAt: "2026-04-28T10:00:00.000Z",
    lastSentAt: "2026-04-29T08:00:00.000Z",
  },
  {
    notificationKey: "survey.reminder",
    sendCount: 0,
    clickCount: 0,
    clickThroughRate: null,
    lastClickAt: null,
    lastSentAt: null,
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminEmailCtaStatsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  currentRole = "super_admin";
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admin/notification-cta-stats")) {
      const u = new URL(url, "http://localhost");
      const sinceDays = u.searchParams.get("sinceDays");
      return jsonResponse({
        sinceDays: sinceDays ? Number(sinceDays) : null,
        rows: ROWS,
      });
    }
    return jsonResponse({ error: "unmocked" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AdminEmailCtaStatsPage", () => {
  it("blocks non-super-admin roles and never calls the CTA endpoint", async () => {
    currentRole = "org_admin";
    renderPage();
    expect(await screen.findByTestId("email-cta-stats-no-access")).toBeInTheDocument();
    // Give react-query a chance to (not) fire — assert nothing went out.
    await new Promise((r) => setTimeout(r, 0));
    const ctaCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.startsWith("/api/admin/notification-cta-stats");
    });
    expect(ctaCalls).toHaveLength(0);
  });

  it("renders rows for super admins and defaults to a 30-day window", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("email-cta-row-booking.confirmed")).toBeInTheDocument(),
    );
    // Default window is 30 days → first call must include `sinceDays=30`.
    const firstCtaCall = fetchMock.mock.calls.find(([input]) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.startsWith("/api/admin/notification-cta-stats");
    });
    expect(firstCtaCall).toBeTruthy();
    expect(String(firstCtaCall![0])).toContain("sinceDays=30");

    // CTR column shows formatted percentages and "—" for the null row.
    expect(
      within(screen.getByTestId("email-cta-row-booking.confirmed-ctr")).getByText("25.0%"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("email-cta-row-highlight.ready-ctr")).getByText("10.0%"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("email-cta-row-survey.reminder-ctr")).getByText("—"),
    ).toBeInTheDocument();
  });

  it("drops sinceDays when the user picks All time", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("email-cta-window-select")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("email-cta-window-select"), "all");
    await waitFor(() => {
      const allTimeCall = fetchMock.mock.calls.find(([input]) => {
        const url = typeof input === "string" ? input : input.toString();
        return (
          url.startsWith("/api/admin/notification-cta-stats") && !url.includes("sinceDays")
        );
      });
      expect(allTimeCall).toBeTruthy();
    });
  });

  it("sorts by clicks when the Clicks header is clicked, without re-fetching", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("email-cta-row-booking.confirmed")).toBeInTheDocument(),
    );
    const beforeFetchCount = fetchMock.mock.calls.length;
    await userEvent.click(screen.getByTestId("email-cta-sort-clicks"));

    // Clicks descending: highlight.ready (100) > booking.confirmed (50) > survey.reminder (0).
    await waitFor(() => {
      const rows = screen
        .getAllByTestId(/^email-cta-row-[^-]+(?:\.[^-]+)*$/)
        .map((r) => r.getAttribute("data-testid"));
      expect(rows[0]).toBe("email-cta-row-highlight.ready");
      expect(rows[1]).toBe("email-cta-row-booking.confirmed");
      expect(rows[2]).toBe("email-cta-row-survey.reminder");
    });

    // Sorting is purely client-side.
    expect(fetchMock.mock.calls.length).toBe(beforeFetchCount);
  });

  it("keeps null-CTR rows at the bottom even when sorting CTR ascending", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("email-cta-row-booking.confirmed")).toBeInTheDocument(),
    );
    // CTR is the default sort key (descending) — click once to flip to
    // ascending so the null-CTR row would naively rise to the top.
    await userEvent.click(screen.getByTestId("email-cta-sort-ctr"));
    await waitFor(() => {
      const rows = screen
        .getAllByTestId(/^email-cta-row-[^-]+(?:\.[^-]+)*$/)
        .map((r) => r.getAttribute("data-testid"));
      // Ascending: highlight.ready (10%) < booking.confirmed (25%) < null.
      expect(rows[0]).toBe("email-cta-row-highlight.ready");
      expect(rows[1]).toBe("email-cta-row-booking.confirmed");
      expect(rows[2]).toBe("email-cta-row-survey.reminder");
    });
  });
});
