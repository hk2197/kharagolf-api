/**
 * Task #1728 — UI coverage for the new dedicated detail-page links the
 * `MyUpcomingWidget` produces for F&B orders and rental bookings.
 *
 * Before Task #1728 these two categories fell through to the unified
 * upcoming list with `?kind=…&id=…` so the row could only be highlighted
 * — there was no detail surface on web. Task #1728 introduced
 * `/fb-orders/:orderId` and `/rentals/bookings/:bookingId` member-facing
 * detail pages, and the widget now deep-links straight to them.
 *
 * This spec stubs `/api/portal/my-upcoming` and asserts the rendered rows
 * point at the new pages so we don't accidentally regress to the old
 * `/portal?tab=upcoming&kind=…&id=…` highlight fallback.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
  throw new Error(`Unexpected fetch in MyUpcomingWidget detail-links test: ${url}`);
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

describe("MyUpcomingWidget — F&B + rental detail page links (Task #1728)", () => {
  it("links the F&B row to /fb-orders/:orderId, not the legacy /portal highlight URL", async () => {
    upcomingResponse = {
      items: [
        {
          kind: "fb",
          id: 555,
          organizationId: 1,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    };

    render(<MyUpcomingWidget />);

    const row = await screen.findByTestId("upcoming-fb-555");
    expect(row.tagName).toBe("A");
    // New dedicated detail page — Task #1728. Catches accidental reverts
    // to the `/portal?tab=upcoming&kind=fb&id=...` highlight fallback.
    expect(row.getAttribute("href")).toBe("/fb-orders/555");
  });

  it("links the rental row to /rentals/bookings/:bookingId, not the legacy /portal highlight URL", async () => {
    upcomingResponse = {
      items: [
        {
          kind: "rental",
          id: 777,
          organizationId: 1,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    };

    render(<MyUpcomingWidget />);

    const row = await screen.findByTestId("upcoming-rental-777");
    expect(row.tagName).toBe("A");
    // New dedicated detail page — Task #1728. Mirrors the mobile app's
    // per-booking deep link so the web matches the mobile experience.
    expect(row.getAttribute("href")).toBe("/rentals/bookings/777");
  });
});
