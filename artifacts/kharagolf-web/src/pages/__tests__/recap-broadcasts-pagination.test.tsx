/**
 * Task #1839 — Pagination regression coverage for the recap broadcast
 * recipient drill-down panel.
 *
 * The drill-down endpoint caps results at 1000 rows per request. For
 * platform-wide annual recaps that fan out to tens of thousands of
 * members, super admins viewing "All clubs" used to silently see only
 * the first 1000 rows with an unhelpful "(capped at 1000)" hint and no
 * way to reach the rest.
 *
 * This test pins down the new pagination wiring end-to-end:
 *   1. Expanding a broadcast row fires the recipients endpoint with
 *      `?page=1&limit=1000` (the per-page cap mirrored on the client).
 *   2. The summary line reads "Showing 1–1,000 of 23,500 dispatches" —
 *      the old "(capped at N)" wording is gone now that the real total
 *      is rendered.
 *   3. Clicking "Next" refetches with `?page=2`, the page label updates
 *      to "Page 2 of 24", and on the last page "Next" disables.
 *   4. Clicking "Previous" walks back to page 1 with the original page
 *      label restored.
 *
 * Backend behaviour for `?page=` and `total` is covered separately by
 * `artifacts/api-server/src/tests/admin-recap-broadcasts.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import RecapBroadcastsPage from "@/pages/recap-broadcasts";

// Tiny in-memory backend. The page fires four endpoints on mount:
//   • /api/auth/me                                — auth gate
//   • /api/admin/recap-broadcasts                 — list of broadcasts
//   • /api/organizations                          — org filter (super admin)
//   • /api/admin/recap-broadcasts/recipients?…    — drill-down (after expand)
// We record every recipients URL the page asks for so the assertions
// below can check that the right `page=` survived the click.
const PAGE_SIZE = 1000;

const recipientsCalls: { url: string; page: number }[] = [];

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function makeRecipientsPayload(page: number, total: number) {
  // Each "page" returns up to PAGE_SIZE rows, drawn from a deterministic
  // pool so the assertions can pick out a known display name on each
  // page.
  const offset = (page - 1) * PAGE_SIZE;
  const remaining = Math.max(0, total - offset);
  const count = Math.min(PAGE_SIZE, remaining);
  const rows = Array.from({ length: count }, (_, i) => {
    const idx = offset + i;
    return {
      id: idx + 1,
      userId: 1000 + idx,
      username: `user${idx}`,
      displayName: `Member ${idx}`,
      email: `m${idx}@example.test`,
      organizationId: 1,
      organizationName: "Pebble Beach GC",
      channel: "push",
      status: "sent",
      reason: null,
      createdAt: "2026-01-01T12:00:00.000Z",
    };
  });
  return {
    year: 2025,
    period: "year",
    day: 1,
    organizationId: null,
    recipients: rows,
    limit: PAGE_SIZE,
    page,
    total,
  };
}

function installFetchMock(total: number) {
  vi.spyOn(global, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith("/api/auth/me")) {
      return jsonResponse({ id: 1, role: "super_admin" });
    }
    if (url === "/api/admin/recap-broadcasts" || url.startsWith("/api/admin/recap-broadcasts?")) {
      return jsonResponse({
        broadcasts: [
          {
            year: 2025,
            period: "year",
            day: 1,
            recipients: total,
            sentAt: "2026-01-01T12:00:00.000Z",
          },
        ],
        limit: 50,
      });
    }
    if (url.startsWith("/api/organizations")) {
      return jsonResponse([{ id: 1, name: "Pebble Beach GC" }]);
    }
    if (url.startsWith("/api/admin/recap-broadcasts/recipients")) {
      const params = new URL(url, "http://localhost").searchParams;
      const page = Number(params.get("page") ?? "1");
      recipientsCalls.push({ url, page });
      return jsonResponse(makeRecipientsPayload(page, total));
    }
    return jsonResponse({}, 404);
  });
}

beforeEach(() => {
  recipientsCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  // A fresh QueryClient per test so cached responses don't leak across
  // "expand row → page → collapse" flows.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RecapBroadcastsPage />
    </QueryClientProvider>,
  );
}

describe("RecipientPanel pagination (Task #1839)", () => {
  it("paginates the recipient list and shows the real total instead of a 'capped' hint", async () => {
    // 23,500 recipients = 24 pages of 1000. Realistic platform-wide
    // annual recap fan-out.
    const TOTAL_RECIPIENTS = 23_500;
    const TOTAL_PAGES = Math.ceil(TOTAL_RECIPIENTS / PAGE_SIZE); // 24
    installFetchMock(TOTAL_RECIPIENTS);
    const user = userEvent.setup();
    renderPage();

    // The single broadcast row renders once auth + list fetches resolve.
    const expandButton = await screen.findByTestId("recap-broadcast-toggle-2025-year-1");
    await user.click(expandButton);

    // First page summary is rendered. The summary reads "Showing 1–1,000
    // of 23,500" — the old "(capped at 1000)" wording is gone now that
    // we know the real upper bound.
    const panel = await screen.findByTestId("recap-broadcast-recipients-2025-year-1");
    const summary = await screen.findByTestId("recap-broadcast-recipients-summary-2025-year-1");
    await waitFor(() => {
      expect(summary.textContent).toMatch(/Showing\s+1[–-]1,000\s+of\s+23,500\s+dispatches/);
    });
    // Belt-and-braces: the recipient panel itself never calls out the
    // per-page cap (the parent broadcast-list footer does have its own
    // unrelated "capped at 50" footer for the broadcasts table — that's
    // outside this panel and not what Task #1839 was about).
    expect(within(panel).queryByText(/capped at/i)).toBeNull();

    // The recipients endpoint was hit with page=1, page-size=1000.
    expect(recipientsCalls.length).toBeGreaterThanOrEqual(1);
    const firstCall = recipientsCalls[0];
    expect(firstCall.page).toBe(1);
    expect(firstCall.url).toMatch(/[?&]limit=1000(&|$)/);

    // Pagination controls render and reflect the real upper bound.
    const pageLabel = screen.getByTestId("recap-broadcast-recipients-page-2025-year-1");
    expect(pageLabel.textContent).toBe("1");
    const pagination = screen.getByTestId("recap-broadcast-recipients-pagination-2025-year-1");
    expect(pagination.textContent).toContain(`of ${TOTAL_PAGES.toLocaleString()}`);

    const prev = screen.getByTestId("recap-broadcast-recipients-prev-2025-year-1");
    const next = screen.getByTestId("recap-broadcast-recipients-next-2025-year-1");
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();

    // First member of the first page is visible.
    expect(screen.getByText("Member 0")).toBeInTheDocument();

    // --- Click "Next" → page 2 -------------------------------------
    await user.click(next);

    await waitFor(() => {
      expect(recipientsCalls.some(c => c.page === 2)).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId("recap-broadcast-recipients-page-2025-year-1").textContent).toBe("2");
    });
    // Summary now reads "Showing 1,001–2,000 of 23,500".
    const summaryP2 = screen.getByTestId("recap-broadcast-recipients-summary-2025-year-1");
    expect(summaryP2.textContent).toMatch(/Showing\s+1,001[–-]2,000\s+of\s+23,500/);
    // First member of page 2 (index 1000) is visible; first member of
    // page 1 is gone.
    expect(screen.getByText("Member 1000")).toBeInTheDocument();
    expect(screen.queryByText("Member 0")).toBeNull();
    // "Previous" is now enabled, "Next" still enabled (we're far from
    // the last page).
    expect(screen.getByTestId("recap-broadcast-recipients-prev-2025-year-1")).toBeEnabled();
    expect(screen.getByTestId("recap-broadcast-recipients-next-2025-year-1")).toBeEnabled();

    // --- Click "Previous" → page 1 ---------------------------------
    await user.click(screen.getByTestId("recap-broadcast-recipients-prev-2025-year-1"));
    await waitFor(() => {
      expect(screen.getByTestId("recap-broadcast-recipients-page-2025-year-1").textContent).toBe("1");
    });
    expect(screen.getByTestId("recap-broadcast-recipients-prev-2025-year-1")).toBeDisabled();
    expect(screen.getByText("Member 0")).toBeInTheDocument();
  });

  it("disables 'Next' on the last page and surfaces the trailing-page row count", async () => {
    // Smaller dataset (3,500 recipients = 4 pages of 1000) so we can
    // walk to the last page in a few clicks instead of 23. The page-1
    // test above already proves the page-size + URL wiring; this one
    // focuses on the "next disables on last page + trailing page math"
    // edge case.
    const SMALL_TOTAL = 3_500;
    const SMALL_TOTAL_PAGES = Math.ceil(SMALL_TOTAL / PAGE_SIZE); // 4
    installFetchMock(SMALL_TOTAL);

    const user = userEvent.setup();
    renderPage();

    const expandButton = await screen.findByTestId("recap-broadcast-toggle-2025-year-1");
    await user.click(expandButton);

    // Wait for the panel to mount.
    await screen.findByTestId("recap-broadcast-recipients-pagination-2025-year-1");

    // Click "Next" until we land on the last page. Each click triggers
    // a fetch that returns the corresponding page from the in-memory
    // backend.
    for (let i = 1; i < SMALL_TOTAL_PAGES; i++) {
      const next = screen.getByTestId("recap-broadcast-recipients-next-2025-year-1");
      // eslint-disable-next-line no-await-in-loop
      await user.click(next);
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => {
        expect(screen.getByTestId("recap-broadcast-recipients-page-2025-year-1").textContent)
          .toBe(String(i + 1));
      });
    }

    // On the last page (4), the summary should read 3,001–3,500 of 3,500.
    const summary = screen.getByTestId("recap-broadcast-recipients-summary-2025-year-1");
    expect(summary.textContent).toMatch(/Showing\s+3,001[–-]3,500\s+of\s+3,500/);

    // "Next" is disabled, "Previous" is still enabled.
    expect(screen.getByTestId("recap-broadcast-recipients-next-2025-year-1")).toBeDisabled();
    expect(screen.getByTestId("recap-broadcast-recipients-prev-2025-year-1")).toBeEnabled();
  });
});
