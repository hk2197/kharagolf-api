/**
 * Component test: web portal Notifications tab "Coach payout account change
 * alerts" toggle (Task #1430).
 *
 * The new opt-out toggle is currently only covered by a backend unit test
 * (`coachPayoutAccountChangeNotify.test.ts`). This test exercises the GET/PATCH
 * wiring on `/api/portal/notification-preferences` end-to-end at the React
 * level — the same class of UI regression we've hit on this page before
 * (e.g. when a new field is added to the `NotifPrefs` interface but not
 * round-tripped through fetch).
 *
 * Mirrors the established pattern in
 * `portal-comm-prefs-whatsapp.test.tsx` and
 * `portal-comm-prefs-reset-key-prefs.test.tsx`: mocks `fetch` so the GET
 * hydrates the prefs and the PATCH captures the body the card sends, then
 * unmounts and re-renders the component to simulate a page reload and
 * asserts the toggle is still off.
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
// hidden and this fixture remains focused on the coach-payout row.
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

describe("PortalCommPrefs — Coach payout account change alerts toggle (Task #1430)", () => {
  it("flipping the toggle off PATCHes notifyCoachPayoutAccountChanges=false and persists across reload", async () => {
    const { unmount } = render(<PortalCommPrefs />);

    // Initial GET hydrates the toggle to ON (server default).
    const toggle = await screen.findByTestId(
      "switch-notify-coach-payout-account-changes",
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );

    await act(async () => {
      fireEvent.click(toggle);
    });

    // PATCH fires with the new field name + value — guards the GET/PATCH
    // wiring against typos that wouldn't be caught by the backend unit test.
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
    expect(patchBody).toHaveProperty("notifyCoachPayoutAccountChanges", false);

    // Optimistic update reflects the new state immediately.
    await waitFor(() =>
      expect(
        screen
          .getByTestId("switch-notify-coach-payout-account-changes")
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );

    // Simulate a page reload: unmount and re-render. The fresh GET should
    // return the persisted server value and the toggle should stay OFF.
    unmount();
    render(<PortalCommPrefs />);

    const reloadedToggle = await screen.findByTestId(
      "switch-notify-coach-payout-account-changes",
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
        .getByTestId("switch-notify-manual-entry-alerts")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("switch-notify-data-export-expiring")
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
