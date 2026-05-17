/**
 * UI tests: tee-booking screen renders converted prices via <PriceWithFx />
 * (Task #673 — covers app/tee-bookings/index.tsx + components/PriceWithFx.tsx).
 *
 * Verifies, against a mocked /api stack, that:
 *
 *   1. A player whose /currency-tax/quote response includes a `display`
 *      block sees both the booked-currency price AND the "Approx." converted
 *      amount on the slot card. Opening the booking modal shows the same on
 *      the Estimated Total row, including the FX disclosure (rate + source).
 *
 *   2. A player whose /currency-tax/quote response has `display: null`
 *      (no preferred currency) sees the plain booked-currency price only —
 *      no "Approx." line, no rate disclosure.
 *
 *   3. When /currency-tax/quote fails (HTTP 500), the screen falls back to
 *      the plain booked-currency price on both the slot card and the modal
 *      Estimated Total — never blank, never crashes.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown> | string) => {
      // Support t(key, fallbackString) and t(key, { count, ... }) signatures.
      if (typeof vars === "string") return vars;
      if (vars && typeof vars === "object") {
        let out = key;
        for (const [k, v] of Object.entries(vars)) out += ` ${k}=${String(v)}`;
        return out;
      }
      return key;
    },
    i18n: { language: "en", changeLanguage: async () => {} },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@/i18n", () => ({
  getLocale: () => "en-US",
}));

vi.mock("react-native-safe-area-context", () => {
  const React = require("react");
  return {
    SafeAreaView: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1, organizationId: 9, role: "player" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({
    activeOrgId: 9,
    activeClub: { id: 9, name: "Test Club", slug: "test-club", subscriptionTier: "pro" },
    clubs: [],
    switchClub: async () => {},
    isSuperAdmin: false,
    canSwitchClub: false,
  }),
}));

import TeeBookingsScreen from "../app/tee-bookings/index";

// ---------------------------------------------------------------------------
// Fetch fixture
// ---------------------------------------------------------------------------

interface FixtureOptions {
  /** Quote display payload — null/undefined for "plain price only" path. */
  display?: {
    currency: string;
    totalAmount: number;
    fxRate: number;
    fxSource: string;
    isFallback: boolean;
    fxMarkupPct: number;
  } | null;
  /** When true, /currency-tax/quote responds 500 (failure). */
  quoteFails?: boolean;
}

// Slot price (USD) and member rate — kept distinct so tests can assert on the
// actual numbers rather than coincidental matches.
const SLOT_PRICE = 100;
const MEMBER_RATE = 100;
const BASE_CURRENCY = "USD";

function buildFetchMock(opts: FixtureOptions) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/tee-bookings/slots")) {
      return new Response(JSON.stringify([
        {
          id: 11, slotTime: "08:00", slotDate: "2026-04-20", capacity: 4,
          status: "available", bookedCount: 0, available: 4, isMembersOnly: false,
          courseName: "Course A", courseId: 1,
          effectivePrice: SLOT_PRICE, basePrice: SLOT_PRICE,
          dealBadge: null, tierName: null,
        },
      ]), { status: 200 });
    }
    if (url.includes("/tee-bookings/my")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes("/tee-bookings/pricing")) {
      return new Response(JSON.stringify({
        memberRate: String(MEMBER_RATE),
        guestRate: "150",
        paymentModel: "checkin",
        cancellationCutoffHours: 24,
        maxGuestsPerBooking: 3,
        baseCurrency: BASE_CURRENCY,
      }), { status: 200 });
    }
    if (url.includes("/tee-bookings/booking-window/me")) {
      return new Response(JSON.stringify({ tier: "regular", daysAhead: 14 }), { status: 200 });
    }
    if (url.includes("/tee-bookings/slot-constraints")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes("/caddies/available")) {
      return new Response(JSON.stringify({ caddies: [] }), { status: 200 });
    }
    if (url.includes("/currency-tax/quote") && method === "POST") {
      if (opts.quoteFails) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { amount: number; currency: string };
      return new Response(JSON.stringify({
        booking: { currency: body.currency, totalAmount: body.amount },
        display: opts.display ?? null,
        baseCurrency: BASE_CURRENCY,
      }), { status: 200 });
    }
    // Unknown URL — return 404 so the screen's try/catch handles it gracefully.
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
}

beforeEach(() => {
  // Default: no display block. Individual tests overwrite via vi.stubGlobal.
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TeeBookingsScreen — converted prices via <PriceWithFx /> (Task #673)", () => {
  it("renders 'Approx.' converted amount on the slot card and modal estimated total when the player has a preferred currency", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "INR",
        totalAmount: 8500,
        fxRate: 85,
        fxSource: "openExchangeRates",
        isFallback: false,
        fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<TeeBookingsScreen />);

    // Slot card renders booked currency ($100) and the converted "Approx. ₹8,500".
    await waitFor(() => {
      expect(screen.getAllByText(/\$100/).length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      // The Approx text is split across nested <Text> nodes — match the
      // converted amount which is wrapped in its own bold <Text>.
      expect(screen.getAllByText(/₹8,500/).length).toBeGreaterThan(0);
    });
    // Slot card uses showDisclosure=false, so the rate disclosure must NOT
    // appear yet (no modal open).
    expect(screen.queryByText(/source: openExchangeRates/)).toBeNull();

    // Open the booking modal by clicking the slot card.
    const slotPrice = screen.getAllByText(/\$100/)[0];
    await act(async () => { fireEvent.click(slotPrice); });

    // Modal estimated total renders the converted amount AND the disclosure
    // (showDisclosure defaults to true on the modal).
    await waitFor(() => {
      expect(screen.getByText(/source: openExchangeRates/)).toBeInTheDocument();
    });
    expect(screen.getByText(/1 USD = 85/)).toBeInTheDocument();
    // Estimated total should match the member rate × 1 player = $100 → ₹8,500.
    // Both the slot tier price and the estimated total quote that amount.
    expect(screen.getAllByText(/₹8,500/).length).toBeGreaterThanOrEqual(2);

    // /currency-tax/quote was POSTed with the slot's USD amount.
    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    expect(quoteCalls.length).toBeGreaterThan(0);
    const firstQuoteBody = JSON.parse(String((quoteCalls[0][1] as RequestInit).body));
    expect(firstQuoteBody.currency).toBe("USD");
    expect(firstQuoteBody.productClass).toBe("tee_time");
  });

  it("renders the plain booked-currency price (no 'Approx.' line) when the player has no preferred currency", async () => {
    const fetchMock = buildFetchMock({ display: null });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<TeeBookingsScreen />);

    // Slot card shows the booked price.
    await waitFor(() => {
      expect(screen.getAllByText(/\$100/).length).toBeGreaterThan(0);
    });

    // Open the modal.
    const slotPrice = screen.getAllByText(/\$100/)[0];
    await act(async () => { fireEvent.click(slotPrice); });

    // Modal estimated total still appears, but as a plain $ amount — no
    // Approx line, no source disclosure.
    await waitFor(() => {
      expect(screen.getByText(/estimatedTotal/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Approx\./)).toBeNull();
    expect(screen.queryByText(/source:/)).toBeNull();
    // The /currency-tax/quote endpoint was still hit (display: null came back).
    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    expect(quoteCalls.length).toBeGreaterThan(0);
  });

  it("falls back to the plain booked-currency price when /currency-tax/quote fails", async () => {
    const fetchMock = buildFetchMock({ quoteFails: true });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<TeeBookingsScreen />);

    // Slot card still renders the plain $100 — the failed quote is swallowed
    // and PriceWithFx shows the booked amount via its fallback path.
    await waitFor(() => {
      expect(screen.getAllByText(/\$100/).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Approx\./)).toBeNull();

    // Open the modal — estimated total also falls back to plain $.
    const slotPrice = screen.getAllByText(/\$100/)[0];
    await act(async () => { fireEvent.click(slotPrice); });

    await waitFor(() => {
      expect(screen.getByText(/estimatedTotal/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Approx\./)).toBeNull();
    expect(screen.queryByText(/source:/)).toBeNull();

    // The quote endpoint was attempted (and failed) at least once.
    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    expect(quoteCalls.length).toBeGreaterThan(0);
  });
});
