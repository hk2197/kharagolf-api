/**
 * Component test: web portal Notifications tab "Manual-entry data quality
 * alerts" toggle (Task #1737).
 *
 * The other three sibling per-event email opt-outs on this card already have
 * dedicated UI-level coverage:
 *   - WhatsApp toggle (`portal-comm-prefs-whatsapp.test.tsx`)
 *   - Coach payout account change alerts
 *     (`portal-comm-prefs-coach-payout-toggle.test.tsx`)
 *   - Data export expiring reminder
 *     (`portal-comm-prefs-data-export-expiring.test.tsx`)
 *
 * The fourth sibling — manual-entry alerts — was only covered indirectly. A
 * regression in the GET hydration or PATCH body for `notifyManualEntryAlerts`
 * would not be caught at the React level today. This test exercises the
 * GET/PATCH wiring on `/api/portal/notification-preferences` end-to-end at
 * the React level, mirroring the established sibling pattern.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// Stub `useGetMe` so the controller-only "Stuck erasure cleanup digest"
// row added in Task #1453 can read a role without dragging a real
// QueryClient into this test. Default to a player so the new row stays
// hidden and this fixture remains focused on the manual-entry row.
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 1, role: "player" } }),
}));

import { PortalCommPrefs } from "../pages/portal/PortalCommPrefs";

interface NotifPrefsRow {
  notifySideGameReceipts: boolean;
  notifyManualEntryAlerts: boolean;
  notifyCoachPayoutAccountChanges: boolean;
  notifyDataExportExpiring: boolean;
}

let serverNotifPrefs: NotifPrefsRow = {
  notifySideGameReceipts: true,
  notifyManualEntryAlerts: true,
  notifyCoachPayoutAccountChanges: true,
  notifyDataExportExpiring: true,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("/api/portal/my-comm-prefs")) {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/notification-key-prefs")) {
    return new Response(JSON.stringify({ digestMode: false, keys: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/notification-preferences")) {
    if (method === "GET") {
      return new Response(JSON.stringify(serverNotifPrefs), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Partial<NotifPrefsRow>;
      serverNotifPrefs = { ...serverNotifPrefs, ...body };
      return new Response(JSON.stringify(serverNotifPrefs), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeEach(() => {
  serverNotifPrefs = {
    notifySideGameReceipts: true,
    notifyManualEntryAlerts: true,
    notifyCoachPayoutAccountChanges: true,
    notifyDataExportExpiring: true,
  };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PortalCommPrefs — Manual-entry data quality alerts toggle (Task #1737)", () => {
  it("hydrates the toggle from the GET response (notifyManualEntryAlerts=true → switch ON)", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyManualEntryAlerts: true,
    };

    render(<PortalCommPrefs />);

    const toggle = await screen.findByTestId(
      "switch-notify-manual-entry-alerts",
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("hydrates the toggle from the GET response (notifyManualEntryAlerts=false → switch OFF)", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyManualEntryAlerts: false,
    };

    render(<PortalCommPrefs />);

    const toggle = await screen.findByTestId(
      "switch-notify-manual-entry-alerts",
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
  });

  it("flipping the toggle off PATCHes notifyManualEntryAlerts=false and persists across reload", async () => {
    const { unmount } = render(<PortalCommPrefs />);

    // Initial GET hydrates the toggle to ON (server default).
    const toggle = await screen.findByTestId(
      "switch-notify-manual-entry-alerts",
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );

    await act(async () => {
      fireEvent.click(toggle);
    });

    // PATCH fires with the new field name + value — guards the GET/PATCH
    // wiring against typos that wouldn't be caught by a backend unit test.
    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        c =>
          ((c[1] as RequestInit | undefined)?.method ?? "GET") === "PATCH" &&
          String(c[0]).includes("/api/portal/notification-preferences"),
      );
      expect(patchCalls.length).toBe(1);
    });

    const patchCall = fetchMock.mock.calls.find(
      c =>
        ((c[1] as RequestInit | undefined)?.method ?? "GET") === "PATCH" &&
        String(c[0]).includes("/api/portal/notification-preferences"),
    )!;
    const patchBody = JSON.parse(
      String((patchCall[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(patchBody).toEqual({ notifyManualEntryAlerts: false });

    // Optimistic update reflects the new state immediately.
    await waitFor(() =>
      expect(
        screen
          .getByTestId("switch-notify-manual-entry-alerts")
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );

    // Simulate a page reload: unmount and re-render. The fresh GET should
    // return the persisted server value and the toggle should stay OFF.
    unmount();
    render(<PortalCommPrefs />);

    const reloadedToggle = await screen.findByTestId(
      "switch-notify-manual-entry-alerts",
    );
    await waitFor(() =>
      expect(reloadedToggle.getAttribute("aria-checked")).toBe("false"),
    );

    // Sanity: the unrelated sibling toggles are untouched by the PATCH.
    expect(
      screen
        .getByTestId("switch-notify-side-game-receipts")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("switch-notify-coach-payout-account-changes")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("switch-notify-data-export-expiring")
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
