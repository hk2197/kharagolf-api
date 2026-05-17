/**
 * UI test: rental booking detail page (Task #1728).
 *
 * The page (`/rentals/bookings/:bookingId`) is a member-facing surface
 * that fetches the caller's own booking from
 * `GET /api/organizations/:orgId/rentals/bookings/:bookingId/mine` and
 * renders status, asset, dates, and rate.
 *
 * These tests pin the four render states the page must handle:
 *   1. Happy path — the booking is rendered with item, dates, status.
 *   2. Not-found (API 404) — the privacy filter on the server returns
 *      404 for bookings the caller doesn't own; the page must show the
 *      friendly "Rental not found" card.
 *   3. Invalid route param (e.g. `/rentals/bookings/abc`) — the page
 *      must NOT hang on the spinner; it must show the same not-found
 *      card. This was hardened during Task #1728 code review.
 *   4. Network error — the page must show the "Couldn't load rental"
 *      card instead of staying on the spinner.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const useRouteMock = vi.fn();
vi.mock("wouter", () => ({
  useRoute: (...args: unknown[]) => useRouteMock(...args),
  useLocation: () => ["/rentals/bookings/1", () => {}],
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 42, role: "member" } }),
}));

// Capture toast calls so the cancel-flow tests can assert success/error
// messaging without rendering the full Toaster tree.
const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}));

import RentalDetailPage from "../rental-detail";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  useRouteMock.mockReset();
  toastMock.mockReset();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function happyBooking() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    id: 777,
    organizationId: 42,
    assetId: 11,
    teeBookingId: null,
    memberId: null,
    bookedByUserId: 1,
    memberName: null,
    status: "reserved",
    rentalDate: tomorrow,
    expectedReturnAt: null,
    checkedOutAt: null,
    returnedAt: null,
    rateCharged: "15.00",
    currency: "INR",
    damageReported: false,
    damageNotes: null,
    damagePhotoUrls: [],
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assetCode: "TROLLEY_A1",
    assetDescription: "Carbon trolley #1",
    categoryId: 5,
    categoryName: "Pull Trolleys",
    categoryIcon: "package",
  };
}

describe("RentalDetailPage — render states (Task #1728)", () => {
  it("renders the booking header, asset, and rate when the fetch resolves", async () => {
    useRouteMock.mockReturnValue([true, { bookingId: "777" }]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(happyBooking()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    render(<RentalDetailPage />);

    expect(await screen.findByTestId("rental-detail-body")).toBeInTheDocument();
    expect(screen.getByTestId("rental-id")).toHaveTextContent("#777");
    expect(screen.getByTestId("rental-status")).toHaveTextContent("Reserved");
    // Item row composes "{categoryName} · {assetCode}" — pin both pieces
    // since they come from the joined columns added in the new endpoint.
    expect(screen.getByTestId("rental-asset")).toHaveTextContent("Pull Trolleys");
    expect(screen.getByTestId("rental-asset")).toHaveTextContent("TROLLEY_A1");
    expect(screen.getByTestId("rental-rate").textContent).toMatch(/15\.00/);
  });

  it("shows the not-found card (NOT the spinner) when the API returns 404", async () => {
    useRouteMock.mockReturnValue([true, { bookingId: "999" }]);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));

    render(<RentalDetailPage />);

    expect(await screen.findByTestId("rental-not-found")).toBeInTheDocument();
    expect(screen.queryByText(/Loading rental…/)).toBeNull();
  });

  it("shows the not-found card (NOT a perpetual spinner) when the route param is non-numeric", async () => {
    // Without the explicit invalid-id guard added during code review,
    // the effect's early-return left `loading` stuck at true forever.
    useRouteMock.mockReturnValue([true, { bookingId: "abc" }]);

    render(<RentalDetailPage />);

    expect(await screen.findByTestId("rental-not-found")).toBeInTheDocument();
    expect(screen.queryByText(/Loading rental…/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the load-failed card on a network error", async () => {
    useRouteMock.mockReturnValue([true, { bookingId: "777" }]);
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    render(<RentalDetailPage />);

    expect(await screen.findByTestId("rental-error")).toBeInTheDocument();
    expect(screen.queryByText(/Loading rental…/)).toBeNull();
  });
});

// ─── Task #2146 — self-service cancel ─────────────────────────────────
//
// The detail page exposes a "Cancel booking" action only while the
// booking is `reserved`, posts to the new
// `/rentals/bookings/:id/cancel/mine` endpoint, and replaces local state
// with the returned row so the status badge flips and the action card
// hides without a manual refresh. These tests pin those four contracts.
describe("RentalDetailPage — self-service cancel (Task #2146)", () => {
  it("hides the cancel card for non-reserved statuses", async () => {
    useRouteMock.mockReturnValue([true, { bookingId: "777" }]);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...happyBooking(), status: "checked_out", checkedOutAt: new Date().toISOString() }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<RentalDetailPage />);

    expect(await screen.findByTestId("rental-detail-body")).toBeInTheDocument();
    expect(screen.queryByTestId("rental-cancel-card")).toBeNull();
    expect(screen.queryByTestId("button-cancel-rental")).toBeNull();
  });

  it("posts to the cancel endpoint, flips the badge, and hides the action on success", async () => {
    useRouteMock.mockReturnValue([true, { bookingId: "777" }]);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(happyBooking()), { status: 200, headers: { "Content-Type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...happyBooking(), status: "cancelled" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<RentalDetailPage />);

    // Sanity: cancel card visible while reserved.
    const trigger = await screen.findByTestId("button-cancel-rental");
    fireEvent.click(trigger);

    // Confirm dialog renders and confirming fires the new endpoint.
    const confirm = await screen.findByTestId("button-cancel-rental-confirm");
    await act(async () => {
      fireEvent.click(confirm);
    });

    // Second fetch went to the cancel/mine route via POST.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/organizations/42/rentals/bookings/777/cancel/mine");
    expect(init.method).toBe("POST");

    // Badge flips to Cancelled and the cancel card is gone.
    expect(await screen.findByText(/Cancelled/i)).toBeInTheDocument();
    expect(screen.queryByTestId("rental-cancel-card")).toBeNull();
    expect(screen.queryByTestId("button-cancel-rental")).toBeNull();
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Booking cancelled" }));
  });

  it("keeps the action and surfaces an error toast when the cancel call fails", async () => {
    useRouteMock.mockReturnValue([true, { bookingId: "777" }]);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(happyBooking()), { status: 200, headers: { "Content-Type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "Cannot cancel a booking with status 'checked_out'" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<RentalDetailPage />);

    const trigger = await screen.findByTestId("button-cancel-rental");
    fireEvent.click(trigger);
    const confirm = await screen.findByTestId("button-cancel-rental-confirm");
    await act(async () => {
      fireEvent.click(confirm);
    });

    // Status stays `reserved` (no replacement was applied) and an error
    // toast surfaces the server's reason so the user understands why.
    expect(screen.getByTestId("rental-status")).toHaveTextContent("Reserved");
    expect(screen.getByTestId("rental-cancel-card")).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't cancel booking",
        variant: "destructive",
      }),
    );
  });
});
