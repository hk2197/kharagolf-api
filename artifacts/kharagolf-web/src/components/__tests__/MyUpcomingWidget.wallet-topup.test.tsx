/**
 * Task #1718 — UI coverage for the new wallet_topup category surfaced by
 * Task #1423 in the home `MyUpcomingWidget`.
 *
 * The integration test
 * (`artifacts/api-server/src/tests/portal-my-upcoming-wallet-topup.test.ts`)
 * already covers the server response shape — wallet top-up requests in
 * `pending_verification`, `refund_pending`, or `refunded` flow through as
 * `kind: "wallet_topup"`. This spec is the missing piece on the web client:
 * it stubs `/api/portal/my-upcoming` and asserts that the widget actually
 * renders the row with the wallet icon + "Wallet top-up refund" label and
 * routes the click to `/wallet-topup-refunds` (the standalone page Task
 * #1423 deep-links to — it lists the member's recent top-up activity, no
 * per-row id required).
 *
 * Companion to the mobile coverage in
 * `artifacts/kharagolf-mobile/__tests__/my-upcoming-widget-wallet-topup.test.tsx`.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

import { MyUpcomingWidget } from "../MyUpcomingWidget";

interface UpcomingItem {
  kind: string;
  id: number;
  organizationId: number | null;
  startsAt: string;
}

let upcomingResponse: { items: UpcomingItem[] } = { items: [] };

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/portal/my-upcoming")) {
    return new Response(JSON.stringify(upcomingResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch in MyUpcomingWidget wallet-topup test: ${url}`);
});

beforeEach(() => {
  upcomingResponse = { items: [] };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MyUpcomingWidget — wallet_topup category (Task #1718)", () => {
  it("renders the wallet_topup row with the wallet icon, the 'Wallet top-up refund' label, and a link to /wallet-topup-refunds", async () => {
    upcomingResponse = {
      items: [
        {
          kind: "wallet_topup",
          id: 4242,
          organizationId: 7,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    };

    render(<MyUpcomingWidget />);

    // The widget mounts in a loading state and only renders the row once
    // the fetch resolves, so wait for the testid the component assigns to
    // each upcoming item: `upcoming-<kind>-<id>`.
    const row = await screen.findByTestId("upcoming-wallet_topup-4242");

    // The wallet_topup row must be a real anchor pointing at the
    // standalone /wallet-topup-refunds page — the deep-link target Task
    // #1423 wired up. Anything else (e.g. the no-href fallback `<div>`)
    // would mean members can't actually click through.
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("/wallet-topup-refunds");

    // Label rendered from the CATEGORY map — guards against future edits
    // that drop the wallet_topup entry or rename the human-facing copy.
    expect(within(row).getByText("Wallet top-up refund")).toBeInTheDocument();

    // Lucide renders each icon as an <svg> with a `lucide-<icon-name>`
    // class. Asserting on `lucide-wallet` makes sure the row uses the
    // wallet glyph and not, say, the calendar fallback that
    // `describe()` returns for unknown kinds.
    const walletSvg = row.querySelector("svg.lucide-wallet");
    expect(walletSvg).not.toBeNull();
  });

  it("renders the wallet_topup row alongside other upcoming items without leaking categories", async () => {
    // Mirrors the server's "wallet items pinned ahead of scheduled
    // bookings" guarantee from the integration test — both rows must
    // surface, each with its own category metadata, and the wallet row
    // keeps its dedicated `/wallet-topup-refunds` href even when other
    // categories are present.
    upcomingResponse = {
      items: [
        {
          kind: "wallet_topup",
          id: 7,
          organizationId: 1,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          kind: "tee",
          id: 99,
          organizationId: 1,
          startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
      ],
    };

    render(<MyUpcomingWidget />);

    const walletRow = await screen.findByTestId("upcoming-wallet_topup-7");
    expect(walletRow.getAttribute("href")).toBe("/wallet-topup-refunds");
    expect(within(walletRow).getByText("Wallet top-up refund")).toBeInTheDocument();

    const teeRow = await screen.findByTestId("upcoming-tee-99");
    // Sanity check: the tee row uses its own deep-link, not the wallet
    // page — i.e. the wallet_topup branch isn't accidentally catching
    // every kind.
    expect(teeRow.getAttribute("href")).toBe("/portal?tab=tee-bookings&id=99");
    expect(within(teeRow).getByText("Tee booking")).toBeInTheDocument();
  });

  it("waits on the network call before rendering the row (no premature wallet entry)", async () => {
    // While the fetch is in-flight the widget shows the "Loading…" row;
    // a stale wallet entry must not appear until the response lands.
    let resolveFetch: ((value: Response) => void) | null = null;
    const pendingFetch = new Promise<Response>(resolve => {
      resolveFetch = resolve;
    });
    fetchMock.mockImplementationOnce(() => pendingFetch);

    render(<MyUpcomingWidget />);

    // No upcoming row yet — only the loading state is visible.
    expect(screen.queryByTestId("upcoming-wallet_topup-1")).toBeNull();
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();

    // Land the response with a wallet_topup item.
    resolveFetch!(
      new Response(
        JSON.stringify({
          items: [
            {
              kind: "wallet_topup",
              id: 1,
              organizationId: 2,
              startsAt: new Date().toISOString(),
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId("upcoming-wallet_topup-1")).toBeInTheDocument();
    });
  });
});
