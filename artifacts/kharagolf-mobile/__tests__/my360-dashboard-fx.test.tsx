/**
 * Regression test for Task #1274 — the my-360 dashboard summary tiles
 * (`app/my-360/index.tsx`) must show converted "Approx." amounts on the
 * Outstanding and Store-credit cards whenever the member's preferred display
 * currency differs from the booked (INR) currency. Both tiles are wired
 * through `<PriceWithFx />` and exposed via the `my360-outstanding` and
 * `my360-store-credit` testIDs.
 *
 * Mounts the real `<My360Index />` against stubbed `/api/portal/my-360` and
 * `/currency-tax/quote` endpoints. If a future refactor silently reverted
 * either tile back to a hardcoded "₹" string (the original bug), the
 * `Approx.` and converted-amount assertions below would fail because no
 * quote-driven display line would render.
 *
 * Mirrors the statement-fx (Task #1110) and locker-renewal (Task #820)
 * patterns.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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

import My360Index from "../app/my-360/index";

const ORG_ID = 42;
const BOOKED_CURRENCY = "INR";

interface DisplayBlock {
  currency: string;
  fxRate: number;
  fxSource: string;
  isFallback: boolean;
  fxMarkupPct: number;
}

const MY_360_RESPONSE = {
  member: {
    id: 1,
    firstName: "Asha",
    lastName: "Member",
    memberNumber: "M-001",
    subscriptionStatus: "active",
    renewalDate: null,
  },
  ext: {
    lifecycleStatus: "active",
    kycStatus: "verified",
    preferredName: null,
    preferredTee: null,
    addressLine1: null,
    city: null,
    country: null,
  },
  tier: { name: "Gold" },
  counts: { documents: 2, familyLinks: 1, milestones: 4 },
  financial: {
    outstandingBalance: "1500",
    storeCreditBalance: "2500",
  },
  actingAsLinked: false,
};

function buildFetchMock(opts: { display: DisplayBlock | null }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/portal/my-360")) {
      return new Response(JSON.stringify(MY_360_RESPONSE), {
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

describe("My360Index — converted summary tiles (Task #1274)", () => {
  it("shows 'Approx.' converted amounts on the Outstanding and Store-credit tiles when /currency-tax/quote returns a display block", async () => {
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

    render(<My360Index />);

    // Outstanding tile (₹1,500 → Approx. $15)
    const outstanding = await screen.findByTestId("my360-outstanding");
    expect(outstanding).toHaveTextContent(/₹1,500/);
    await waitFor(() => {
      expect(outstanding).toHaveTextContent(/Approx\./);
    });
    expect(outstanding).toHaveTextContent(/\$15(?:\.00)?/);
    expect(outstanding).toHaveTextContent(/source: openExchangeRates/);
    expect(outstanding).toHaveTextContent(/1 INR = 0\.01 USD/);

    // Store-credit tile (₹2,500 → Approx. $25)
    const storeCredit = await screen.findByTestId("my360-store-credit");
    expect(storeCredit).toHaveTextContent(/₹2,500/);
    await waitFor(() => {
      expect(storeCredit).toHaveTextContent(/Approx\./);
    });
    expect(storeCredit).toHaveTextContent(/\$25(?:\.00)?/);

    // Verify productClass routing for each tile.
    const quoteBodies = fetchMock.mock.calls
      .filter(c => String(c[0]).includes("/currency-tax/quote"))
      .map(c => JSON.parse(String((c[1] as RequestInit).body)) as {
        amount: number; currency: string; productClass?: string;
      });
    expect(quoteBodies.length).toBeGreaterThan(0);
    expect(quoteBodies.some(b => b.productClass === "member_charge" && b.amount === 1500 && b.currency === "INR")).toBe(true);
    expect(quoteBodies.some(b => b.productClass === "store_credit" && b.amount === 2500 && b.currency === "INR")).toBe(true);

    // Sanity check: orgId is passed through on the quote URL.
    const quoteUrls = fetchMock.mock.calls
      .map(c => String(c[0]))
      .filter(u => u.includes("/currency-tax/quote"));
    expect(quoteUrls.every(u => u.includes(`/api/organizations/${ORG_ID}/currency-tax/quote`))).toBe(true);
  });

  it("renders only the booked-currency amounts (no 'Approx.' line) when the quote response has no display block", async () => {
    const fetchMock = buildFetchMock({ display: null });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<My360Index />);

    const outstanding = await screen.findByTestId("my360-outstanding");
    const storeCredit = await screen.findByTestId("my360-store-credit");

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/currency-tax/quote"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });

    expect(outstanding).toHaveTextContent(/₹1,500/);
    expect(storeCredit).toHaveTextContent(/₹2,500/);

    expect(outstanding).not.toHaveTextContent(/Approx\./);
    expect(storeCredit).not.toHaveTextContent(/Approx\./);
  });
});
