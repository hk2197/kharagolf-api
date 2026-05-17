/**
 * UI tests: mobile `StalledExpiringReminderCard` (Task #1882 — mobile mirror
 * of the web `StalledExpiringReminderWidget` introduced in Task #1297).
 *
 * Verifies:
 *   1. The card self-hides on 401/403 (non-controller).
 *   2. Rows render with member name, opened-only / clicked badge, and
 *      "Send nudge" button.
 *   3. Switching the filter tab refetches with the new `?filter=` query
 *      and re-renders the row set.
 *   4. Tapping "Send nudge" POSTs to
 *      `/members-360/:memberId/data-requests/:id/resend` and surfaces a
 *      success Alert.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/i18n", () => ({ getLocale: () => "en-US" }));

// React Native's `Alert.alert` is a noop on the JSDOM web shim — capture
// invocations so we can assert the success/error toast surfaced.
const alertSpy = vi.fn();
vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    Alert: { ...actual.Alert, alert: (...args: unknown[]) => alertSpy(...args) },
  };
});

import { StalledExpiringReminderCard } from "../components/StalledExpiringReminderCard";

interface StalledItem {
  id: number;
  clubMemberId: number;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberEmail: string | null;
  resolvedAt: string | null;
  expiringNoticeSentAt: string | null;
  expiringReminderEmailOpenedAt: string | null;
  expiringReminderEmailClickedAt: string | null;
  lastNotificationKind: string | null;
  lastNotifiedAt: string | null;
  purgesAt: string | null;
  lastNudgedAt: string | null;
  lastNudgedByDisplayName: string | null;
}

interface StalledResponse {
  filter: "all" | "opened-only" | "clicked";
  validDays: number;
  counts: { total: number; openedOnly: number; clicked: number };
  items: StalledItem[];
}

function makeItem(overrides: Partial<StalledItem> & { id: number; clubMemberId: number }): StalledItem {
  return {
    memberFirstName: null,
    memberLastName: null,
    memberNumber: null,
    memberEmail: null,
    resolvedAt: "2026-04-25T10:00:00Z",
    expiringNoticeSentAt: "2026-04-29T08:00:00Z",
    expiringReminderEmailOpenedAt: "2026-04-29T09:00:00Z",
    expiringReminderEmailClickedAt: null,
    lastNotificationKind: "expiring_notice",
    lastNotifiedAt: "2026-04-29T08:00:00Z",
    purgesAt: "2026-05-02T10:00:00Z",
    lastNudgedAt: null,
    lastNudgedByDisplayName: null,
    ...overrides,
  };
}

let getStatus = 200;
let resendStatus = 200;
let getResponseByFilter: Record<"all" | "opened-only" | "clicked", StalledResponse> = {
  all: { filter: "all", validDays: 7, counts: { total: 0, openedOnly: 0, clicked: 0 }, items: [] },
  "opened-only": { filter: "opened-only", validDays: 7, counts: { total: 0, openedOnly: 0, clicked: 0 }, items: [] },
  clicked: { filter: "clicked", validDays: 7, counts: { total: 0, openedOnly: 0, clicked: 0 }, items: [] },
};
let resendCalls: Array<{ memberId: number; requestId: number }> = [];
let getCalls: Array<{ filter: string }> = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  const resendMatch = url.match(/\/members-360\/(\d+)\/data-requests\/(\d+)\/resend/);
  if (resendMatch && method === "POST") {
    resendCalls.push({
      memberId: parseInt(resendMatch[1], 10),
      requestId: parseInt(resendMatch[2], 10),
    });
    if (resendStatus >= 400) {
      return new Response(JSON.stringify({ error: "Resend failed" }), {
        status: resendStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.includes("/data-requests/expiring-reminder-stalled") && method === "GET") {
    if (getStatus !== 200) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: getStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    const m = url.match(/[?&]filter=([^&]+)/);
    const filter = (m?.[1] ?? "all") as "all" | "opened-only" | "clicked";
    getCalls.push({ filter });
    return new Response(JSON.stringify(getResponseByFilter[filter]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeEach(() => {
  getStatus = 200;
  resendStatus = 200;
  getResponseByFilter = {
    all: { filter: "all", validDays: 7, counts: { total: 0, openedOnly: 0, clicked: 0 }, items: [] },
    "opened-only": { filter: "opened-only", validDays: 7, counts: { total: 0, openedOnly: 0, clicked: 0 }, items: [] },
    clicked: { filter: "clicked", validDays: 7, counts: { total: 0, openedOnly: 0, clicked: 0 }, items: [] },
  };
  resendCalls = [];
  getCalls = [];
  alertSpy.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StalledExpiringReminderCard (Task #1882)", () => {
  it("self-hides when the API returns 403 (non-controller)", async () => {
    getStatus = 403;
    const { container } = render(
      <StalledExpiringReminderCard orgId={7} token="t" />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="card-stalled-expiring-reminders"]'),
      ).toBeNull();
    });
  });

  it("self-hides when the API returns 401 (no session)", async () => {
    getStatus = 401;
    const { container } = render(
      <StalledExpiringReminderCard orgId={7} token="t" />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="card-stalled-expiring-reminders"]'),
      ).toBeNull();
    });
  });

  it("renders nothing when orgId or token is missing", () => {
    const { container } = render(
      <StalledExpiringReminderCard orgId={null} token={null} />,
    );
    expect(
      container.querySelector('[data-testid="card-stalled-expiring-reminders"]'),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the empty state when there are no stalled reminders", async () => {
    render(<StalledExpiringReminderCard orgId={7} token="t" />);
    expect(await screen.findByTestId("stalled-empty")).toBeInTheDocument();
  });

  it("lists rows with member name, badge, and Send nudge button", async () => {
    getResponseByFilter.all = {
      filter: "all",
      validDays: 7,
      counts: { total: 2, openedOnly: 1, clicked: 1 },
      items: [
        makeItem({ id: 100, clubMemberId: 11, memberFirstName: "Alice", memberLastName: "Doe" }),
        makeItem({
          id: 101,
          clubMemberId: 22,
          memberFirstName: "Bob",
          memberLastName: "Smith",
          expiringReminderEmailClickedAt: "2026-04-29T09:30:00Z",
        }),
      ],
    };
    render(<StalledExpiringReminderCard orgId={7} token="t" />);
    expect(await screen.findByTestId("stalled-row-100")).toBeInTheDocument();
    expect(screen.getByTestId("stalled-member-100")).toHaveTextContent("Alice Doe");
    expect(screen.getByTestId("stalled-member-101")).toHaveTextContent("Bob Smith");
    expect(screen.getByTestId("stalled-nudge-100")).toBeInTheDocument();
    expect(screen.getByTestId("stalled-nudge-101")).toBeInTheDocument();
    // Filter chip counts include the bucket totals from the API.
    expect(screen.getByTestId("stalled-filter-all")).toHaveTextContent("All (2)");
    expect(screen.getByTestId("stalled-filter-opened-only")).toHaveTextContent("Opened only (1)");
    expect(screen.getByTestId("stalled-filter-clicked")).toHaveTextContent("Clicked (1)");
  });

  it("switching filter tabs refetches with ?filter=… and re-renders rows", async () => {
    getResponseByFilter.all = {
      filter: "all",
      validDays: 7,
      counts: { total: 2, openedOnly: 1, clicked: 1 },
      items: [
        makeItem({ id: 100, clubMemberId: 11, memberFirstName: "Alice", memberLastName: "Doe" }),
        makeItem({
          id: 101,
          clubMemberId: 22,
          memberFirstName: "Bob",
          memberLastName: "Smith",
          expiringReminderEmailClickedAt: "2026-04-29T09:30:00Z",
        }),
      ],
    };
    getResponseByFilter.clicked = {
      filter: "clicked",
      validDays: 7,
      counts: { total: 2, openedOnly: 1, clicked: 1 },
      items: [
        makeItem({
          id: 101,
          clubMemberId: 22,
          memberFirstName: "Bob",
          memberLastName: "Smith",
          expiringReminderEmailClickedAt: "2026-04-29T09:30:00Z",
        }),
      ],
    };

    render(<StalledExpiringReminderCard orgId={7} token="t" />);
    await screen.findByTestId("stalled-row-100");

    // Initial load uses the default `all` filter.
    expect(getCalls.some((c) => c.filter === "all")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByTestId("stalled-filter-clicked"));
    });

    // The clicked-only refetch lands and Alice's row is gone.
    await waitFor(() => {
      expect(getCalls.some((c) => c.filter === "clicked")).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("stalled-row-100")).toBeNull();
    });
    expect(screen.getByTestId("stalled-row-101")).toBeInTheDocument();
  });

  it("tapping Send nudge POSTs to /resend and shows a success alert", async () => {
    getResponseByFilter.all = {
      filter: "all",
      validDays: 7,
      counts: { total: 1, openedOnly: 1, clicked: 0 },
      items: [
        makeItem({ id: 200, clubMemberId: 33, memberFirstName: "Carol", memberLastName: "King" }),
      ],
    };
    render(<StalledExpiringReminderCard orgId={7} token="t" />);
    const btn = await screen.findByTestId("stalled-nudge-200");

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(resendCalls).toEqual([{ memberId: 33, requestId: 200 }]);
    });
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalled();
    });
    const [title] = alertSpy.mock.calls[0] as [string, string];
    expect(title).toBe("Personal nudge sent");
  });

  it("surfaces an error alert when the resend POST fails", async () => {
    resendStatus = 500;
    getResponseByFilter.all = {
      filter: "all",
      validDays: 7,
      counts: { total: 1, openedOnly: 1, clicked: 0 },
      items: [
        makeItem({ id: 300, clubMemberId: 44, memberFirstName: "Dan", memberLastName: "Lee" }),
      ],
    };
    render(<StalledExpiringReminderCard orgId={7} token="t" />);
    const btn = await screen.findByTestId("stalled-nudge-300");

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(resendCalls).toEqual([{ memberId: 44, requestId: 300 }]);
    });
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalled();
    });
    const [title] = alertSpy.mock.calls[0] as [string, string];
    expect(title).toBe("Could not send nudge");
  });
});
