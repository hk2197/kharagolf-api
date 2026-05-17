/**
 * UI tests: caddie rating screen renders an FX-converted preview for the tip
 * amount via <PriceWithFx /> (Task #952 — covers app/caddies/rate.tsx).
 *
 * Verifies, against a mocked /api stack, that:
 *
 *   1. Entering a positive tip amount triggers a POST to /currency-tax/quote
 *      and renders an "Approx." converted line plus the FX rate disclosure.
 *
 *   2. No preview is rendered while the tip field is empty or zero — the
 *      /currency-tax/quote endpoint must not be called in that case.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown> | string) => {
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

vi.mock("@/utils/api", () => ({
  BASE_URL: "",
}));

vi.mock("react-native-safe-area-context", () => {
  const React = require("react");
  return {
    SafeAreaView: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

vi.mock("expo-router", () => ({
  router: { back: () => {}, push: () => {}, replace: () => {} },
  useLocalSearchParams: () => ({ assignmentId: "77", caddieName: "Alex" }),
}));

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

import CaddieRateScreen from "../app/caddies/rate";

interface FixtureOptions {
  display?: {
    currency: string;
    totalAmount: number;
    fxRate: number;
    fxSource: string;
    isFallback: boolean;
    fxMarkupPct: number;
  } | null;
}

function buildFetchMock(opts: FixtureOptions) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/currency-tax/quote") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { amount: number; currency: string };
      return new Response(JSON.stringify({
        booking: { currency: body.currency, totalAmount: body.amount },
        display: opts.display ?? null,
        baseCurrency: "INR",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CaddieRateScreen — converted tip preview via <PriceWithFx /> (Task #952)", () => {
  it("renders the 'Approx.' converted amount and FX disclosure when a positive tip is entered", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "USD",
        totalAmount: 6,
        fxRate: 0.012,
        fxSource: "openExchangeRates",
        isFallback: false,
        fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<CaddieRateScreen />);

    // Initially nothing has been typed → no quote request, no preview line.
    expect(screen.queryByText(/Approx\./)).toBeNull();
    expect(
      fetchMock.mock.calls.filter(c => String(c[0]).includes("/currency-tax/quote")).length,
    ).toBe(0);

    // Type a tip amount of 500 INR.
    const tipInput = screen.getByPlaceholderText("0");
    await act(async () => { fireEvent.change(tipInput, { target: { value: "500" } }); });

    // Quote request fires with the tip amount + caddie_fee productClass.
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/currency-tax/quote"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    const body = JSON.parse(String((quoteCalls[0][1] as RequestInit).body));
    expect(body.amount).toBe(500);
    expect(body.currency).toBe("INR");
    expect(body.productClass).toBe("caddie_fee");

    // Approx line + converted amount + FX disclosure all render.
    await waitFor(() => {
      expect(screen.getByText(/Approx\./)).toBeInTheDocument();
    });
    expect(screen.getByText(/\$6/)).toBeInTheDocument();
    expect(screen.getByText(/source: openExchangeRates/)).toBeInTheDocument();
    expect(screen.getByText(/1 INR = 0\.012/)).toBeInTheDocument();
  });

  it("renders no preview when the tip field is empty or zero", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "USD",
        totalAmount: 6,
        fxRate: 0.012,
        fxSource: "openExchangeRates",
        isFallback: false,
        fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<CaddieRateScreen />);

    const tipInput = screen.getByPlaceholderText("0");

    // Empty → nothing.
    expect(screen.queryByText(/Approx\./)).toBeNull();

    // Zero → still nothing, and no quote call should have fired.
    await act(async () => { fireEvent.change(tipInput, { target: { value: "0" } }); });
    expect(screen.queryByText(/Approx\./)).toBeNull();
    expect(screen.queryByText(/source:/)).toBeNull();
    expect(
      fetchMock.mock.calls.filter(c => String(c[0]).includes("/currency-tax/quote")).length,
    ).toBe(0);
  });
});
