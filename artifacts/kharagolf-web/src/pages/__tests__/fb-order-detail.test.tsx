/**
 * UI test: F&B order detail page (Task #1728, extended in Task #2145).
 *
 * The page (`/fb-orders/:orderId`) is a member-facing surface that
 * fetches the caller's own order from
 * `GET /api/organizations/:orgId/fb/orders/:orderId/mine` and renders
 * status, items, and totals.
 *
 * These tests pin the render states the page must handle:
 *   1. Happy path — the order is fetched and rendered with item lines.
 *   2. Not-found (API 404) — the privacy filter on the server returns
 *      404 for any order the caller doesn't own; the page must show the
 *      friendly "Order not found" card, NOT a perpetual spinner.
 *   3. Invalid route param (e.g. `/fb-orders/abc`) — the page must not
 *      hang on the loading spinner; it must surface the same not-found
 *      card so users see something actionable. This was added during
 *      Task #1728 code review to prevent users getting stuck on a
 *      spinner if a malformed link is clicked.
 *   4. Network error — the page must show the "Couldn't load order"
 *      card instead of staying on the spinner.
 *   5. Live status (Task #2145) — when the SSE stream pushes a status
 *      change, the badge updates in place and a transient pulse cue
 *      is shown so the member notices.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const useRouteMock = vi.fn();
vi.mock("wouter", () => ({
  useRoute: (...args: unknown[]) => useRouteMock(...args),
  useLocation: () => ["/fb-orders/1", () => {}],
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 42, role: "member" } }),
}));

import FbOrderDetailPage from "../fb-order-detail";

const fetchMock = vi.fn();

// jsdom does not implement EventSource. We install a tiny fake that records
// each instance and exposes a helper to push a `message` event so the live
// SSE update path can be exercised in tests.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  closed = false;
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  useRouteMock.mockReset();
  FakeEventSource.instances = [];
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function happyOrder() {
  return {
    id: 555,
    organizationId: 42,
    userId: 1,
    stationId: null,
    tabId: null,
    serverUserId: null,
    orderType: "on_course",
    tableLabel: null,
    holeNumber: 7,
    status: "ready",
    paymentMethod: "card_on_delivery",
    paymentStatus: "pending",
    paymentReference: null,
    totalAmount: "23.50",
    currency: "INR",
    notes: null,
    bumpedAt: null,
    recalledAt: null,
    readyAt: null,
    deliveredAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items: [
      {
        id: 1, orderId: 555, menuItemId: null,
        name: "Club Sandwich", price: "12.00", quantity: 1,
        modifiers: [], modifierTotal: "1.50", itemNotes: null,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

describe("FbOrderDetailPage — render states (Task #1728)", () => {
  it("renders the order header, items, and total when the fetch resolves", async () => {
    useRouteMock.mockReturnValue([true, { orderId: "555" }]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(happyOrder()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    render(<FbOrderDetailPage />);

    expect(await screen.findByTestId("fb-order-detail-body")).toBeInTheDocument();
    expect(screen.getByTestId("fb-order-id")).toHaveTextContent("#555");
    expect(screen.getByTestId("fb-order-status")).toHaveTextContent("Ready");
    expect(screen.getByText("Club Sandwich")).toBeInTheDocument();
    // Total card pulls from `totalAmount`, not the line items, so this
    // assertion catches accidental swap of the two displays.
    expect(screen.getByTestId("fb-order-total").textContent).toMatch(/23\.50/);
  });

  it("shows the not-found card (NOT the spinner) when the API returns 404", async () => {
    useRouteMock.mockReturnValue([true, { orderId: "999" }]);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));

    render(<FbOrderDetailPage />);

    expect(await screen.findByTestId("fb-order-not-found")).toBeInTheDocument();
    expect(screen.queryByText(/Loading order…/)).toBeNull();
  });

  it("shows the not-found card (NOT a perpetual spinner) when the route param is non-numeric", async () => {
    // Without the explicit invalid-id guard added during code review,
    // the effect's early-return left `loading` stuck at true forever
    // and the user saw nothing but the spinner.
    useRouteMock.mockReturnValue([true, { orderId: "abc" }]);

    render(<FbOrderDetailPage />);

    expect(await screen.findByTestId("fb-order-not-found")).toBeInTheDocument();
    expect(screen.queryByText(/Loading order…/)).toBeNull();
    // No fetch should have been issued for an invalid id.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the load-failed card on a network error", async () => {
    useRouteMock.mockReturnValue([true, { orderId: "555" }]);
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    render(<FbOrderDetailPage />);

    expect(await screen.findByTestId("fb-order-error")).toBeInTheDocument();
    expect(screen.queryByText(/Loading order…/)).toBeNull();
  });

  it("subscribes to the per-order SSE stream and updates the badge in place when a new status arrives (Task #2145)", async () => {
    useRouteMock.mockReturnValue([true, { orderId: "555" }]);
    // Initial server snapshot puts the order in "preparing".
    const initial = { ...happyOrder(), status: "preparing", readyAt: null };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(initial), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    render(<FbOrderDetailPage />);

    expect(await screen.findByTestId("fb-order-detail-body")).toBeInTheDocument();
    expect(screen.getByTestId("fb-order-status")).toHaveTextContent("Preparing");

    // The page must have opened exactly one SSE connection at the per-order
    // endpoint scoped to the caller's organization.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const sse = FakeEventSource.instances[0];
    expect(sse.url).toBe("/api/organizations/42/fb/orders/555/sse");
    expect(sse.withCredentials).toBe(true);

    // Server pushes the next status. Badge text must update without a refetch
    // and a transient pulse cue must appear so members notice the change.
    act(() => sse.emit({ type: "order_status", data: { orderId: 555, status: "ready" } }));
    await waitFor(() => expect(screen.getByTestId("fb-order-status")).toHaveTextContent("Ready"));
    expect(screen.getByTestId("fb-order-status-pulse")).toBeInTheDocument();

    // Only the initial REST fetch should have been issued — live updates do
    // not cause additional API calls.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT pulse for the initial snapshot frame that matches current status (Task #2145)", async () => {
    // The api-server pushes the current status as the very first SSE frame on
    // connect, so the page must not flag that as a "status changed" event —
    // otherwise members would see a misleading cue on every page load.
    useRouteMock.mockReturnValue([true, { orderId: "555" }]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(happyOrder()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    render(<FbOrderDetailPage />);
    expect(await screen.findByTestId("fb-order-detail-body")).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const sse = FakeEventSource.instances[0];

    // Replay the server's initial snapshot — same status as the REST fetch.
    act(() => sse.emit({ type: "order_status", data: { orderId: 555, status: "ready" } }));

    // Status remains "Ready" but no pulse cue should appear.
    expect(screen.getByTestId("fb-order-status")).toHaveTextContent("Ready");
    expect(screen.queryByTestId("fb-order-status-pulse")).toBeNull();
  });

  it("closes the SSE connection when the page unmounts (Task #2145)", async () => {
    useRouteMock.mockReturnValue([true, { orderId: "555" }]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(happyOrder()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const { unmount } = render(<FbOrderDetailPage />);
    expect(await screen.findByTestId("fb-order-detail-body")).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const sse = FakeEventSource.instances[0];

    unmount();
    expect(sse.closed).toBe(true);
  });
});
