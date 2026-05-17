/**
 * Task #1811 — regression test for the wallet FX rate hover disclosure.
 *
 * The web admin withdrawals table (rendered by `WalletPanel` inside
 * `SideGamesAdmin.tsx`) renders each row's converted amount with:
 *
 *   <PriceWithFx
 *     orgId={...}
 *     amount={w.amount}
 *     currency={w.currency}
 *     productClass="wallet"
 *     showDisclosure={false}
 *     disclosureOnHover
 *   />
 *
 * Task #1473 added the on-hover/on-tap FX disclosure popover for that
 * "Approx." amount. The behaviour is conditional on the combination of
 * `showDisclosure={false}` + `disclosureOnHover` *and* a non-null
 * `display` block on the quote response, so it's easy for a future
 * refactor (e.g. renaming the props or short-circuiting the popover
 * branch) to silently break it.
 *
 * This test mounts `<PriceWithFx />` in the same configuration the
 * withdrawals table uses, against a mocked `/currency-tax/quote`
 * endpoint, and asserts that hover / focus / click on the "Approx."
 * trigger reveals a popover containing the FX rate, source, fallback
 * flag and markup.
 *
 * The mobile parallel lives at
 * `artifacts/kharagolf-mobile/__tests__/PriceWithFx.disclosureOnHover.test.tsx`.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PriceWithFx, type QuoteDisplay } from "../PriceWithFx";

const ORG_ID = 9;
const BOOKED_AMOUNT = 5000;
const BOOKED_CURRENCY = "INR";

interface QuoteFixture {
  display: QuoteDisplay | null;
}

function buildFetchMock(opts: QuoteFixture) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/currency-tax/quote") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        amount: number;
        currency: string;
        productClass?: string;
        displayCurrency?: string;
      };
      return new Response(
        JSON.stringify({
          booking: {
            currency: body.currency,
            totalAmount: body.amount,
            taxableAmount: body.amount,
            totalTax: 0,
          },
          display: opts.display,
          baseCurrency: BOOKED_CURRENCY,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PriceWithFx — wallet hover/focus/click FX disclosure (Task #1811)", () => {
  it("renders the converted Approx. trigger but no inline disclosure when showDisclosure=false + disclosureOnHover, and reveals the FX rate / source / markup popover on hover", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "USD",
        totalAmount: 60,
        fxRate: 0.012,
        fxSource: "openExchangeRates",
        isFallback: false,
        fxMarkupPct: 1.5,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <PriceWithFx
        orgId={ORG_ID}
        amount={BOOKED_AMOUNT}
        currency={BOOKED_CURRENCY}
        productClass="wallet"
        showDisclosure={false}
        disclosureOnHover
      />,
    );

    const trigger = await screen.findByTestId("fx-disclosure-trigger");
    expect(trigger).toHaveTextContent(/Approx\./);
    expect(trigger).toHaveTextContent(/\$60/);
    // The inline "— converted at …" string must NOT be rendered when
    // showDisclosure=false; the disclosure should only appear in the
    // hover popover.
    expect(screen.queryByText(/— converted at/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("fx-disclosure-tooltip")).not.toBeInTheDocument();

    // Hovering the trigger reveals the popover with the FX rate,
    // source, and markup. The fallback marker is omitted because
    // isFallback=false.
    fireEvent.mouseEnter(trigger);
    const tooltip = await screen.findByTestId("fx-disclosure-tooltip");
    expect(tooltip).toHaveAttribute("role", "tooltip");
    expect(tooltip).toHaveTextContent(/1 INR = 0\.012 USD/);
    expect(tooltip).toHaveTextContent(/source: openExchangeRates/);
    expect(tooltip).toHaveTextContent(/includes 1\.5% FX markup/);
    expect(tooltip.textContent ?? "").not.toMatch(/fallback/);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);

    // Mouse-leave hides the popover again.
    fireEvent.mouseLeave(trigger);
    await waitFor(() => {
      expect(screen.queryByTestId("fx-disclosure-tooltip")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    // The component called the quote endpoint with the wallet
    // product-class so the FX markup pulled from the wallet bucket
    // (not e.g. the bookings bucket) is what gets disclosed.
    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    expect(quoteCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(String((quoteCalls[0][1] as RequestInit).body));
    expect(body.amount).toBe(BOOKED_AMOUNT);
    expect(body.currency).toBe(BOOKED_CURRENCY);
    expect(body.productClass).toBe("wallet");
  });

  it("focusing the trigger via keyboard also opens the popover, and clicking pins it open after blur", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "USD",
        totalAmount: 60,
        fxRate: 0.012,
        fxSource: "openExchangeRates",
        isFallback: false,
        fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <PriceWithFx
        orgId={ORG_ID}
        amount={BOOKED_AMOUNT}
        currency={BOOKED_CURRENCY}
        productClass="wallet"
        showDisclosure={false}
        disclosureOnHover
      />,
    );

    const trigger = await screen.findByTestId("fx-disclosure-trigger");

    // Keyboard focus opens the popover so the disclosure is reachable
    // without a mouse — important because this row lives in a dense
    // admin table.
    fireEvent.focus(trigger);
    expect(await screen.findByTestId("fx-disclosure-tooltip")).toHaveTextContent(
      /1 INR = 0\.012 USD/,
    );

    // Tap/click pins it. After blur (which clears both hover + pin)
    // the popover closes; clicking again re-pins it open even with
    // no hover/focus.
    fireEvent.blur(trigger);
    await waitFor(() => {
      expect(screen.queryByTestId("fx-disclosure-tooltip")).not.toBeInTheDocument();
    });

    fireEvent.click(trigger);
    expect(await screen.findByTestId("fx-disclosure-tooltip")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    // Click again toggles it back closed.
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.queryByTestId("fx-disclosure-tooltip")).not.toBeInTheDocument();
    });
  });

  it("includes the (fallback) marker in the popover when the quote response says the FX rate came from the fallback table", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "USD",
        totalAmount: 60,
        fxRate: 0.012,
        fxSource: "stale-cache",
        isFallback: true,
        fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <PriceWithFx
        orgId={ORG_ID}
        amount={BOOKED_AMOUNT}
        currency={BOOKED_CURRENCY}
        productClass="wallet"
        showDisclosure={false}
        disclosureOnHover
      />,
    );

    const trigger = await screen.findByTestId("fx-disclosure-trigger");
    fireEvent.mouseEnter(trigger);
    const tooltip = await screen.findByTestId("fx-disclosure-tooltip");
    expect(tooltip).toHaveTextContent(/source: stale-cache \(fallback\)/);
  });

  it("does NOT render the Approx. trigger or popover when the quote response has no display block (no preferred currency conversion needed)", async () => {
    const fetchMock = buildFetchMock({ display: null });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <PriceWithFx
        orgId={ORG_ID}
        amount={BOOKED_AMOUNT}
        currency={BOOKED_CURRENCY}
        productClass="wallet"
        showDisclosure={false}
        disclosureOnHover
      />,
    );

    // Wait for the quote to resolve before asserting the negative.
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/currency-tax/quote"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });

    expect(screen.queryByTestId("fx-disclosure-trigger")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fx-disclosure-tooltip")).not.toBeInTheDocument();
    expect(screen.queryByText(/Approx\./)).not.toBeInTheDocument();
  });
});
