/**
 * Task #2093 — UI test for the web notifications inbox cursor pagination.
 *
 * The mobile inbox lazy-loads older items as the user scrolls (Task #1685);
 * this test verifies the web page does the same:
 *  - Initial render requests the small first page (?limit=25, no cursor).
 *  - When the user scrolls toward the bottom, the page requests the next
 *    page using the server-issued ?before=<id> cursor.
 *  - Older rows are appended (de-duped) and rendering stops once the API
 *    reports nextCursor=null.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";

vi.mock("wouter", () => ({
  useLocation: () => ["/notifications", () => {}],
}));

// Stable references — `useToast` is called inside the component, and the
// `toast` function we hand back goes into a useCallback dep list. If we
// returned a new function per render the page would re-fetch in a loop.
const stableToast = () => {};
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: stableToast }),
}));

import NotificationsPage from "@/pages/notifications";

interface ApiNotification {
  id: number;
  caseId: number;
  organizationId: number;
  orgName: string | null;
  event: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
  caseStatus: string | null;
  caseKind: string | null;
  deepLink: string;
}

function makeItem(id: number): ApiNotification {
  return {
    id,
    caseId: id,
    organizationId: 1,
    orgName: "Test Club",
    event: "opened",
    title: `Notification ${id}`,
    body: `Body ${id}`,
    payload: null,
    createdAt: new Date(2024, 0, id, 12).toISOString(),
    readAt: null,
    caseStatus: null,
    caseKind: null,
    deepLink: "/handicap-profile",
  };
}

describe("NotificationsPage cursor pagination (Task #2093)", () => {
  let calls: string[];

  beforeEach(() => {
    calls = [];
    // Page 1: ids 25..1 (a full page → server returns nextCursor = 1).
    // Page 2: ids 0..-1 truncated to a short page → nextCursor = null.
    const page1Items = Array.from({ length: 25 }, (_, i) => makeItem(25 - i));
    const page2Items = [makeItem(0), makeItem(-1)];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        if (url.includes("?limit=25") && !url.includes("before=")) {
          return new Response(
            JSON.stringify({ unreadCount: 27, items: page1Items, nextCursor: 1 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("before=1")) {
          return new Response(
            JSON.stringify({ unreadCount: 27, items: page2Items, nextCursor: null }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests a small first page on mount instead of limit=100", async () => {
    render(<NotificationsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("notification-item-25")).toBeInTheDocument();
    });
    // The first request must use the small page size (25), not the old
    // limit=100 single-shot fetch.
    expect(calls[0]).toContain("/api/portal/handicap/notifications?limit=25");
    expect(calls[0]).not.toContain("limit=100");
    expect(calls[0]).not.toContain("before=");
  });

  it("lazy-loads older items using the server-issued cursor when scrolled to the bottom", async () => {
    render(<NotificationsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("notification-item-1")).toBeInTheDocument();
    });
    // Newest item from page 1 is rendered.
    expect(screen.getByTestId("notification-item-25")).toBeInTheDocument();
    // Older page hasn't been fetched yet.
    expect(screen.queryByTestId("notification-item-0")).not.toBeInTheDocument();

    // Simulate the user scrolling to the bottom of the page.
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 4000,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 3300,
    });

    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("notification-item-0")).toBeInTheDocument();
    });
    // Older items appended after the existing first-page rows.
    expect(screen.getByTestId("notification-item-25")).toBeInTheDocument();
    // The lazy-load request used the server-issued cursor from page 1.
    expect(calls.some(u => u.includes("before=1") && u.includes("limit=25"))).toBe(true);
  });

  it("stops paginating once the server reports nextCursor=null", async () => {
    render(<NotificationsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("notification-item-1")).toBeInTheDocument();
    });

    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 4000 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 3300 });

    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("notification-item-0")).toBeInTheDocument();
    });

    const callsBefore = calls.length;
    // Scroll again — no more pages should be requested.
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("scroll"));
    });
    // Give any pending microtasks a chance to settle.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls.length).toBe(callsBefore);
  });
});
