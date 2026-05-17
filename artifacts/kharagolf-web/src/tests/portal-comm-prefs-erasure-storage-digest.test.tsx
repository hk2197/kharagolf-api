/**
 * Component test: web portal Notifications tab "Stuck erasure cleanup digest"
 * toggle (Task #1453).
 *
 * The backend already exposes `notifyErasureStorageDigest` on
 * GET/PATCH `/portal/notification-preferences` and a one-click email
 * unsubscribe link, but until this task there was no settings-screen toggle
 * for controllers to flip the preference back on themselves. This test
 * mirrors the established pattern in
 * `portal-comm-prefs-data-export-expiring.test.tsx`: mocks `fetch` so the
 * GET hydrates the prefs and the PATCH captures the body the card sends,
 * then unmounts and re-renders to simulate a page reload and asserts the
 * toggle stays off.
 *
 * The toggle is gated on the same controller check the rest of the portal
 * uses (any non-player / non-spectator role — see `ProfileTab.tsx`,
 * `portal/index.tsx`), so this file also asserts a player can't see it
 * and a controller can.
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

interface NotifPrefsRow {
  notifySideGameReceipts: boolean;
  notifyManualEntryAlerts: boolean;
  notifyCoachPayoutAccountChanges: boolean;
  notifyDataExportExpiring: boolean;
  notifyWalletRefundDigestFailed: boolean;
  notifySideGameReceiptDigestFailed: boolean;
  notifyErasureStorageDigest: boolean;
  notifyErasureStorageDigestPush: boolean;
}

let serverNotifPrefs: NotifPrefsRow = {
  notifySideGameReceipts: true,
  notifyManualEntryAlerts: true,
  notifyCoachPayoutAccountChanges: true,
  notifyDataExportExpiring: true,
  notifyWalletRefundDigestFailed: true,
  notifySideGameReceiptDigestFailed: true,
  notifyErasureStorageDigest: true,
  notifyErasureStorageDigestPush: true,
};

// `useGetMe` drives the controller-only gate. Tests flip `mockMeRole`
// between calls instead of re-mocking the module so vitest's module
// hoisting doesn't get in the way.
let mockMeRole: string | null = "org_admin";
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: mockMeRole ? { id: 1, organizationId: 1, role: mockMeRole } : undefined,
  }),
}));

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
    notifyWalletRefundDigestFailed: true,
    notifySideGameReceiptDigestFailed: true,
    notifyErasureStorageDigest: true,
    notifyErasureStorageDigestPush: true,
  };
  mockMeRole = "org_admin";
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Lazy-import after the module mock so vitest wires `useGetMe` correctly.
async function loadCard() {
  const mod = await import("../pages/portal/PortalCommPrefs");
  return mod.PortalCommPrefs;
}

describe("PortalCommPrefs — Stuck erasure cleanup digest toggle (Task #1453)", () => {
  it("hydrates the toggle from the GET response (notifyErasureStorageDigest=true → switch ON)", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: true,
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const toggle = await screen.findByTestId(
      "switch-notify-erasure-storage-digest-email",
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("hydrates the toggle from the GET response (notifyErasureStorageDigest=false → switch OFF)", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const toggle = await screen.findByTestId(
      "switch-notify-erasure-storage-digest-email",
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
  });

  it("flipping the toggle off PATCHes notifyErasureStorageDigest=false and persists across reload", async () => {
    const PortalCommPrefs = await loadCard();
    const { unmount } = render(<PortalCommPrefs />);

    // Initial GET hydrates the toggle to ON (server default).
    const toggle = await screen.findByTestId(
      "switch-notify-erasure-storage-digest-email",
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
    expect(patchBody).toEqual({ notifyErasureStorageDigest: false });

    // Optimistic update reflects the new state immediately.
    await waitFor(() =>
      expect(
        screen
          .getByTestId("switch-notify-erasure-storage-digest-email")
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );

    // Simulate a page reload: unmount and re-render. The fresh GET should
    // return the persisted server value and the toggle should stay OFF —
    // closing the loop the email unsubscribe link opened, since the
    // controller can now flip it back on from settings without dredging up
    // the original email.
    unmount();
    render(<PortalCommPrefs />);

    const reloadedToggle = await screen.findByTestId(
      "switch-notify-erasure-storage-digest-email",
    );
    await waitFor(() =>
      expect(reloadedToggle.getAttribute("aria-checked")).toBe("false"),
    );

    // Sanity: the unrelated sibling toggles are untouched by the PATCH.
    expect(
      screen
        .getByTestId("switch-notify-data-export-expiring")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("switch-notify-wallet-refund-digest-failed")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("switch-notify-side-game-receipt-digest-failed")
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("hides the toggle from non-controller users (player role)", async () => {
    mockMeRole = "player";

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    // Wait for the card to settle (an unrelated sibling toggle is always
    // rendered, so once it shows up the row gating has had its chance to
    // run).
    await screen.findByTestId("switch-notify-data-export-expiring");

    expect(
      screen.queryByTestId("row-notify-erasure-storage-digest"),
    ).toBeNull();
    expect(
      screen.queryByTestId("switch-notify-erasure-storage-digest-email"),
    ).toBeNull();
  });

  it("hides the toggle from non-controller users (spectator role)", async () => {
    mockMeRole = "spectator";

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-data-export-expiring");

    expect(
      screen.queryByTestId("switch-notify-erasure-storage-digest-email"),
    ).toBeNull();
  });

  it("shows the toggle for controller-style roles (membership_secretary)", async () => {
    mockMeRole = "membership_secretary";

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const toggle = await screen.findByTestId(
      "switch-notify-erasure-storage-digest-email",
    );
    expect(toggle).not.toBeNull();
  });
});
