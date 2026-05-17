/**
 * Regression test for Task #1110 — the mobile ledger statement screen
 * (`app/my-360/statement.tsx`) must show converted "Approx." amounts on the
 * outstanding-balance and store-credit summary cards as well as on each
 * account-charge and levy row, whenever the member's preferred display
 * currency differs from the booked currency.
 *
 * Mounts the real `<StatementScreen />` against stubbed
 * `/api/portal/my-statement` and `/currency-tax/quote` endpoints. If a future
 * refactor silently reverted the ledger to booked-currency-only rendering
 * (the original bug), the assertions below would fail because `Approx.` and
 * the converted display amounts would no longer appear.
 *
 * Mirrors the wallet-txn-row (Task #1110) and locker-renewal (Task #820)
 * patterns.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/utils/api", () => ({ BASE_URL: "" }));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({
    activeOrgId: 42,
    activeClub: { id: 42, name: "Test Club", slug: "test-club", subscriptionTier: "pro" },
    clubs: [],
    switchClub: () => undefined,
    isSuperAdmin: false,
    canSwitchClub: false,
  }),
}));

vi.mock("../app/my-360/_shared", async () => {
  const actual = await vi.importActual<typeof import("../app/my-360/_shared")>(
    "../app/my-360/_shared",
  );
  return {
    ...actual,
    BASE_URL: "",
    useActingMemberId: () => [null, () => undefined],
    actingQs: () => "",
  };
});

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: () => true },
}));
vi.mock("expo-router", () => ({
  router: routerMock,
  Stack: { Screen: () => null },
  useFocusEffect: () => undefined,
}));

import StatementScreen from "../app/my-360/statement";

const ORG_ID = 42;
const BOOKED_CURRENCY = "INR";

interface DisplayBlock {
  currency: string;
  fxRate: number;
  fxSource: string;
  isFallback: boolean;
  fxMarkupPct: number;
}

const STATEMENT = {
  outstandingBalance: "1500",
  levyOutstandingBalance: "500",
  storeCredit: { account: { balancePaise: 250_000 }, history: [] },
  accountCharges: [
    {
      id: 7,
      description: "Range balls",
      amount: "300",
      isSettled: false,
      createdAt: new Date("2026-04-01T12:00:00Z").toISOString(),
    },
  ],
  levyCharges: [
    {
      charge: {
        id: 12,
        amount: "500",
        paid: false,
        paidAt: null,
        status: "unpaid",
        paidAmount: "0",
        refundedAmount: "0",
        waivedReason: null,
        remaining: "500",
        createdAt: new Date("2026-04-02T12:00:00Z").toISOString(),
      },
      levy: {
        id: 99,
        name: "Annual fee",
        description: null,
        currency: "INR",
        dueDate: null,
      },
    },
  ],
};

function buildFetchMock(opts: { display: DisplayBlock | null }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/portal/my-statement")) {
      return new Response(JSON.stringify(STATEMENT), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/currency-tax/quote") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        amount: number; currency: string; productClass?: string;
      };
      const display = opts.display
        ? { ...opts.display, totalAmount: body.amount * opts.display.fxRate }
        : null;
      return new Response(
        JSON.stringify({
          booking: { currency: body.currency, totalAmount: body.amount },
          display,
          baseCurrency: BOOKED_CURRENCY,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
}

beforeEach(() => {
  routerMock.push.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StatementScreen — converted ledger summary (Task #1110)", () => {
  it("shows 'Approx.' converted amounts on the summary cards and ledger rows when /currency-tax/quote returns a display block", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "USD",
        fxRate: 0.01,
        fxSource: "openExchangeRates",
        isFallback: false,
        fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<StatementScreen />);

    // Summary: outstanding balance (₹1,500 → Approx. $15)
    const outstanding = await screen.findByTestId("statement-outstanding");
    expect(outstanding).toHaveTextContent(/₹1,500/);
    await waitFor(() => {
      expect(outstanding).toHaveTextContent(/Approx\./);
    });
    expect(outstanding).toHaveTextContent(/\$15(?:\.00)?/);
    expect(outstanding).toHaveTextContent(/source: openExchangeRates/);

    // Summary: store credit (250 000 paise = ₹2,500 → Approx. $25)
    const storeCredit = await screen.findByTestId("statement-store-credit");
    expect(storeCredit).toHaveTextContent(/₹2,500/);
    await waitFor(() => {
      expect(storeCredit).toHaveTextContent(/Approx\./);
    });
    expect(storeCredit).toHaveTextContent(/\$25(?:\.00)?/);

    // Account-charge ledger row (₹300 → Approx. $3)
    const accountCharge = await screen.findByTestId("statement-account-charge-7");
    expect(accountCharge).toHaveTextContent(/₹300/);
    await waitFor(() => {
      expect(accountCharge).toHaveTextContent(/Approx\./);
    });
    expect(accountCharge).toHaveTextContent(/\$3(?:\.00)?/);

    // Levy ledger row "Charged" cell (₹500 → Approx. $5)
    const levyRow = await screen.findByTestId("statement-levy-12");
    expect(levyRow).toHaveTextContent(/₹500/);
    await waitFor(() => {
      expect(levyRow).toHaveTextContent(/Approx\./);
    });
    expect(within(levyRow).getAllByText(/Approx\./).length).toBeGreaterThan(0);

    // Verify the productClass routing for at least one quote of each kind.
    const quoteBodies = fetchMock.mock.calls
      .filter(c => String(c[0]).includes("/currency-tax/quote"))
      .map(c => JSON.parse(String((c[1] as RequestInit).body)) as {
        amount: number; currency: string; productClass?: string;
      });
    expect(quoteBodies.length).toBeGreaterThan(0);
    expect(quoteBodies.some(b => b.productClass === "member_charge" && b.amount === 1500)).toBe(true);
    expect(quoteBodies.some(b => b.productClass === "store_credit" && b.amount === 2500)).toBe(true);
    expect(quoteBodies.some(b => b.productClass === "member_charge" && b.amount === 300)).toBe(true);
    expect(quoteBodies.some(b => b.productClass === "levy" && b.amount === 500)).toBe(true);
  });

  it("renders only the booked-currency amounts (no 'Approx.' line) when the quote response has no display block", async () => {
    const fetchMock = buildFetchMock({ display: null });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<StatementScreen />);

    const outstanding = await screen.findByTestId("statement-outstanding");
    const storeCredit = await screen.findByTestId("statement-store-credit");
    const accountCharge = await screen.findByTestId("statement-account-charge-7");
    const levyRow = await screen.findByTestId("statement-levy-12");

    // Wait until the quote endpoint has been hit at least once for the
    // summary card so we know the (null-display) response has settled.
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/currency-tax/quote"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });

    expect(outstanding).toHaveTextContent(/₹1,500/);
    expect(storeCredit).toHaveTextContent(/₹2,500/);
    expect(accountCharge).toHaveTextContent(/₹300/);
    expect(levyRow).toHaveTextContent(/₹500/);

    expect(outstanding).not.toHaveTextContent(/Approx\./);
    expect(storeCredit).not.toHaveTextContent(/Approx\./);
    expect(accountCharge).not.toHaveTextContent(/Approx\./);
    expect(levyRow).not.toHaveTextContent(/Approx\./);
  });
});
