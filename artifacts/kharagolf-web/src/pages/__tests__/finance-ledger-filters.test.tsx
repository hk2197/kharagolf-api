/**
 * UI test: Finance ledger filter toolbar (Task #333).
 *
 * Mounts <FinanceLedgerPage /> with a mocked fetch and exercises every
 * filter on the "All levies" toolbar that was added in Task #280:
 *   - name search (case-insensitive substring)
 *   - created-at date range
 *   - currency <Select>
 *   - "Outstanding only" <Switch>
 *   - the "Clear filters" button (both in the toolbar and the empty-state)
 *
 * Each filter is exercised individually and in combination, asserting
 * the visible row count and the "Showing X of Y" caption. The empty-state
 * Clear-filters button is asserted to fully restore the table.
 *
 * The page calls /levies-summary once on mount and does ALL filtering
 * client-side, so a single mocked response is enough to drive the entire
 * test. /revenue-by-currency is also stubbed to avoid noisy fetch errors
 * in the other Card on the page.
 *
 * The runtime e2e plan that hits the live DB lives at
 * artifacts/kharagolf-web/src/tests/finance-ledger-filters.e2e.md and
 * remains the canonical end-to-end coverage; this vitest file gives the
 * toolbar regression-protection in the standard CI test path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom polyfills for Radix Select (uses pointer capture + scrollIntoView).
if (typeof Element !== "undefined") {
  if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  }
  if (!(Element.prototype as unknown as { releasePointerCapture?: unknown }).releasePointerCapture) {
    (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
}

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 42, role: "org_admin" } }),
}));

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgContext: () => ({ activeOrgId: 42, isOrgOverridden: false, setActiveOrg: () => {} }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import FinanceLedgerPage from "../finance-ledger";

interface LevySummary {
  id: number;
  name: string;
  description: string | null;
  amount: string;
  currency: string;
  scope: string | null;
  dueDate: string | null;
  createdAt: string;
  chargesCount: number;
  paidCount: number;
  partialCount: number;
  unpaidCount: number;
  waivedCount: number;
  refundedCount: number;
  collected: string;
  refunded: string;
  outstanding: string;
  waivedAmount: string;
}

function makeLevy(p: Partial<LevySummary> & Pick<LevySummary, "id" | "name" | "currency" | "createdAt" | "outstanding">): LevySummary {
  return {
    description: null,
    amount: "100.00",
    scope: "all",
    dueDate: null,
    chargesCount: 1,
    paidCount: 0,
    partialCount: 0,
    unpaidCount: 0,
    waivedCount: 0,
    refundedCount: 0,
    collected: "0",
    refunded: "0",
    waivedAmount: "0",
    ...p,
  };
}

// Mirrors the seed pattern used in the e2e plan: four levies in three
// currencies, mixed statuses, mixed created-at dates so every filter
// can be exercised individually and in combination.
const LEVIES: LevySummary[] = [
  // A — INR, OLD (Feb 2025), fully PAID (no outstanding)
  makeLevy({
    id: 1,
    name: "Annual subscription FLT",
    currency: "INR",
    createdAt: "2025-02-15T10:00:00Z",
    amount: "1000.00",
    chargesCount: 1, paidCount: 1,
    collected: "1000", outstanding: "0",
  }),
  // B — USD, RECENT (early Sep 2025), UNPAID (outstanding > 0)
  makeLevy({
    id: 2,
    name: "Tournament fee FLT",
    currency: "USD",
    createdAt: "2025-09-10T10:00:00Z",
    amount: "50.00",
    chargesCount: 1, unpaidCount: 1,
    collected: "0", outstanding: "50",
  }),
  // C — EUR, RECENT (late Sep 2025), PARTIAL (outstanding > 0)
  makeLevy({
    id: 3,
    name: "Locker rental FLT",
    currency: "EUR",
    createdAt: "2025-09-20T10:00:00Z",
    amount: "200.00",
    chargesCount: 1, partialCount: 1,
    collected: "60", outstanding: "140",
  }),
  // D — INR, OLD (Mar 2025), WAIVED (no outstanding)
  makeLevy({
    id: 4,
    name: "Range balls FLT",
    currency: "INR",
    createdAt: "2025-03-01T10:00:00Z",
    amount: "300.00",
    chargesCount: 1, waivedCount: 1,
    collected: "0", outstanding: "0",
    waivedAmount: "300",
  }),
];

function totalsByCurrency() {
  const t: Record<string, { collected: number; outstanding: number; refunded: number; waived: number; chargesCount: number; leviesCount: number }> = {};
  for (const l of LEVIES) {
    const cur = l.currency;
    const r = (t[cur] ??= { collected: 0, outstanding: 0, refunded: 0, waived: 0, chargesCount: 0, leviesCount: 0 });
    r.collected += parseFloat(l.collected);
    r.outstanding += parseFloat(l.outstanding);
    r.refunded += parseFloat(l.refunded);
    r.waived += parseFloat(l.waivedAmount);
    r.chargesCount += l.chargesCount;
    r.leviesCount += 1;
  }
  return t;
}

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/members-360/levies-summary")) {
      return new Response(
        JSON.stringify({ levies: LEVIES, totalsByCurrency: totalsByCurrency() }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as Response;
    }
    if (url.includes("/members-360/revenue-by-currency")) {
      return new Response(
        JSON.stringify({ byCurrency: [], byCurrencyAndEventType: [], range: { from: null, to: null } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <FinanceLedgerPage />
    </QueryClientProvider>,
  );
}

async function waitForBaseline() {
  // Wait until the API response is rendered (caption + all four rows).
  await screen.findByTestId("row-levy-1");
  await waitFor(() => {
    expect(screen.getByTestId("text-filter-count")).toHaveTextContent("Showing 4 of 4");
  });
}

function rowIds(): number[] {
  return LEVIES
    .map(l => l.id)
    .filter(id => screen.queryByTestId(`row-levy-${id}`) !== null);
}

beforeEach(() => {
  installFetch();
  // Reset URL between tests so the page's URL-persisted filters don't leak.
  window.history.replaceState({}, "", "/finance-ledger");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FinanceLedgerPage filter toolbar (Task #333)", () => {
  it("renders all four levies with no filters and hides 'Clear filters'", async () => {
    renderPage();
    await waitForBaseline();

    expect(rowIds()).toEqual([1, 2, 3, 4]);
    expect(screen.queryByTestId("button-clear-filters")).not.toBeInTheDocument();
    expect(screen.queryByTestId("text-no-matches")).not.toBeInTheDocument();
  });

  it("name search narrows to the matching levy and Clear filters restores the table", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForBaseline();

    await user.type(screen.getByTestId("input-filter-name"), "Tournament");

    await waitFor(() => {
      expect(screen.getByTestId("text-filter-count")).toHaveTextContent("Showing 1 of 4");
    });
    expect(rowIds()).toEqual([2]);
    expect(screen.getByTestId("button-clear-filters")).toBeInTheDocument();

    await user.click(screen.getByTestId("button-clear-filters"));

    await waitFor(() => {
      expect(screen.getByTestId("text-filter-count")).toHaveTextContent("Showing 4 of 4");
    });
    expect(rowIds()).toEqual([1, 2, 3, 4]);
    expect(screen.queryByTestId("button-clear-filters")).not.toBeInTheDocument();
    expect((screen.getByTestId("input-filter-name") as HTMLInputElement).value).toBe("");
  });

  it("created-at range keeps only levies inside the window", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForBaseline();

    // <input type="date"> — fireEvent.change is the canonical way to drive
    // value updates in jsdom (userEvent.type is unreliable for date inputs).
    const fromInput = screen.getByTestId("input-filter-from") as HTMLInputElement;
    const toInput = screen.getByTestId("input-filter-to") as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: "2025-09-01" } });
    fireEvent.change(toInput, { target: { value: "2025-09-30" } });

    await waitFor(() => {
      expect(screen.getByTestId("text-filter-count")).toHaveTextContent("Showing 2 of 4");
    });
    expect(rowIds()).toEqual([2, 3]);
  });

  it("currency filter on its own keeps only levies in the chosen currency", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForBaseline();

    // Pick INR — there are two INR levies (A paid, D waived) regardless of
    // their outstanding state, since outstanding-only is OFF here.
    await user.click(screen.getByTestId("select-filter-currency"));
    const inrOption = await screen.findByRole("option", { name: "INR" });
    await user.click(inrOption);

    await waitFor(() => {
      expect(screen.getByTestId("text-filter-count")).toHaveTextContent("Showing 2 of 4");
    });
    expect(rowIds()).toEqual([1, 4]);
    expect(screen.getByTestId("button-clear-filters")).toBeInTheDocument();

    // Switching back to "All currencies" restores the full table without
    // needing the Clear filters button (currency is the only active filter).
    await user.click(screen.getByTestId("select-filter-currency"));
    const allOption = await screen.findByRole("option", { name: "All currencies" });
    await user.click(allOption);

    await waitFor(() => {
      expect(screen.getByTestId("text-filter-count")).toHaveTextContent("Showing 4 of 4");
    });
    expect(rowIds()).toEqual([1, 2, 3, 4]);
    expect(screen.queryByTestId("button-clear-filters")).not.toBeInTheDocument();
  });

  it("'Outstanding only' switch keeps only unpaid + partial levies", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForBaseline();

    await user.click(screen.getByTestId("switch-outstanding-only"));

    await waitFor(() => {
      expect(screen.getByTestId("text-filter-count")).toHaveTextContent("Showing 2 of 4");
    });
    expect(rowIds()).toEqual([2, 3]);
  });

  it("combines outstanding-only + currency to leave a single levy, then shows the empty state", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForBaseline();

    // Outstanding-only + EUR currency → only Levy C (EUR / partial).
    await user.click(screen.getByTestId("switch-outstanding-only"));

    // Open the Radix Select and pick EUR. Radix renders options in a portal,
    // so we look them up in document.body via screen.findByRole.
    await user.click(screen.getByTestId("select-filter-currency"));
    const eurOption = await screen.findByRole("option", { name: "EUR" });
    await user.click(eurOption);

    await waitFor(() => {
      expect(screen.getByTestId("text-filter-count")).toHaveTextContent("Showing 1 of 4");
    });
    expect(rowIds()).toEqual([3]);

    // Switch the currency to INR — outstanding-only is still on, but no INR
    // levy has outstanding > 0, so the table renders the empty-state copy.
    await user.click(screen.getByTestId("select-filter-currency"));
    const inrOption = await screen.findByRole("option", { name: "INR" });
    await user.click(inrOption);

    await waitFor(() => {
      expect(screen.getByTestId("text-filter-count")).toHaveTextContent("Showing 0 of 4");
    });
    expect(rowIds()).toEqual([]);
    const emptyState = await screen.findByTestId("text-no-matches");
    expect(emptyState).toHaveTextContent(/No levies match the current filters\./);

    // Click the inline Clear filters inside the empty state and assert the
    // toolbar fully resets.
    await user.click(within(emptyState).getByTestId("button-clear-filters-empty"));

    await waitFor(() => {
      expect(screen.getByTestId("text-filter-count")).toHaveTextContent("Showing 4 of 4");
    });
    expect(rowIds()).toEqual([1, 2, 3, 4]);
    expect(screen.queryByTestId("text-no-matches")).not.toBeInTheDocument();
    expect(screen.queryByTestId("button-clear-filters")).not.toBeInTheDocument();
    expect((screen.getByTestId("input-filter-name") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("input-filter-from") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("input-filter-to") as HTMLInputElement).value).toBe("");
    // Switch returns to the unchecked state.
    expect(screen.getByTestId("switch-outstanding-only")).toHaveAttribute("aria-checked", "false");
  });
});
