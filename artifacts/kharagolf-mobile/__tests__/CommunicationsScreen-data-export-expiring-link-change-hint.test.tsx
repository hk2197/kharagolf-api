/**
 * Component test: mobile `my-360/communications` screen "Last changed
 * via email link" hint chip below the data-export-expiring 24-hour
 * heads-up reminder toggle (Task #2212).
 *
 * Mirrors the established mobile fetch-mocking pattern in
 * `CommunicationsScreen.test.tsx`: stubs the three GET endpoints the
 * screen pulls at mount, then asserts that the hint chip is visible
 * (with the right wording) when the API returns the audit-trail
 * timestamp + direction, and that it is hidden when the timestamp is
 * null. Also verifies the chip survives a "toggle back from the app"
 * scenario — the audit row is permanent so the hint must keep
 * rendering even when `notifyDataExportExpiring` is true again.
 *
 * The data-export-expiring chip is the first hint chip on the mobile
 * screen (the erasure-storage chip never made it onto mobile), so this
 * file establishes the mobile test pattern for the family.
 */
import React from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/constants/colors", () => ({
  default: {
    primary: "#0a0",
    background: "#000",
    surface: "#111",
    border: "#222",
    tabIconDefault: "#888",
  },
}));

vi.mock("../app/my-360/_shared", async () => {
  const actual = await vi.importActual<typeof import("../app/my-360/_shared")>(
    "../app/my-360/_shared",
  );
  return {
    ...actual,
    useActingMemberId: () => [null, () => {}],
    actingQs: () => "",
  };
});

import CommunicationsScreen from "../app/my-360/communications";

interface NotifPrefsRow {
  notifySideGameReceipts: boolean;
  notifyManualEntryAlerts: boolean;
  notifyCoachPayoutAccountChanges: boolean;
  notifyAdminPayoutReverify: boolean;
  notifyDataExportExpiring: boolean;
  notifyErasureStorageDigest: boolean;
  notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: string | null;
  notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
    | "unsubscribe"
    | "resubscribe"
    | null;
}

let serverNotifPrefs: NotifPrefsRow = {
  notifySideGameReceipts: true,
  notifyManualEntryAlerts: true,
  notifyCoachPayoutAccountChanges: true,
  notifyAdminPayoutReverify: true,
  notifyDataExportExpiring: true,
  notifyErasureStorageDigest: true,
  notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: null,
  notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection: null,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("/api/portal/notification-key-prefs") && method === "GET") {
    return new Response(JSON.stringify({ digestMode: false, keys: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/notification-preferences") && method === "GET") {
    return new Response(JSON.stringify(serverNotifPrefs), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/my-comm-prefs") && method === "GET") {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeEach(() => {
  serverNotifPrefs = {
    notifySideGameReceipts: true,
    notifyManualEntryAlerts: true,
    notifyCoachPayoutAccountChanges: true,
    notifyAdminPayoutReverify: true,
    notifyDataExportExpiring: true,
    notifyErasureStorageDigest: true,
    notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: null,
    notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection: null,
  };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommunicationsScreen — Data-export-expiring link-change hint chip (Task #2212)", () => {
  it("renders the hint with the formatted date and '(unsubscribed)' when direction=unsubscribe", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt:
        "2026-04-24T08:30:00.000Z",
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    render(<CommunicationsScreen />);

    const hint = await screen.findByTestId(
      "hint-notify-data-export-expiring-link-change",
    );
    expect(hint.textContent).toMatch(/Last changed via email link/i);
    expect(hint.textContent).toMatch(/2026/);
    expect(hint.textContent).toMatch(/Apr/);
    expect(hint.textContent).toMatch(/\(unsubscribed\)/);
  });

  it("renders '(re-subscribed)' when direction=resubscribe", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt:
        "2026-04-24T08:30:00.000Z",
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        "resubscribe",
    };

    render(<CommunicationsScreen />);

    const hint = await screen.findByTestId(
      "hint-notify-data-export-expiring-link-change",
    );
    expect(hint.textContent).toMatch(/\(re-subscribed\)/);
  });

  it("hides the hint when both audit fields are null (member has never used the link)", async () => {
    render(<CommunicationsScreen />);

    // Wait for the surrounding row to render so the hint has had its
    // chance to mount.
    await screen.findByTestId("row-notify-data-export-expiring");

    expect(
      screen.queryByTestId("hint-notify-data-export-expiring-link-change"),
    ).toBeNull();
  });

  it("hides the hint when the timestamp is null even if a stale direction is present", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: null,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    render(<CommunicationsScreen />);

    await screen.findByTestId("row-notify-data-export-expiring");

    expect(
      screen.queryByTestId("hint-notify-data-export-expiring-link-change"),
    ).toBeNull();
  });

  it("hides the hint when the timestamp is unparseable (defensive guard)", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: "not-a-date",
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    render(<CommunicationsScreen />);

    await screen.findByTestId("row-notify-data-export-expiring");

    expect(
      screen.queryByTestId("hint-notify-data-export-expiring-link-change"),
    ).toBeNull();
  });

  it("keeps the hint visible after the toggle is flipped back from the app (audit row is permanent)", async () => {
    // Done-looks-like clause: the chip stays visible even when
    // `notifyDataExportExpiring` is already true again, because the
    // server keeps returning the `LastChangedViaUnsubscribeLinkAt`
    // timestamp from the permanent member_audit_log row.
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyDataExportExpiring: true,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt:
        "2026-04-24T08:30:00.000Z",
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    render(<CommunicationsScreen />);

    const hint = await screen.findByTestId(
      "hint-notify-data-export-expiring-link-change",
    );
    expect(hint).toBeTruthy();
    expect(hint.textContent).toMatch(/Last changed via email link/i);
  });

  it("renders the hint inside the data-export-expiring row (sibling-of-toggle layout)", async () => {
    // Guards against a future contributor accidentally moving the hint
    // outside the row container, which would break the visual
    // association between the toggle and its audit-trail breadcrumb.
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt:
        "2026-04-24T08:30:00.000Z",
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    render(<CommunicationsScreen />);

    const row = await screen.findByTestId("row-notify-data-export-expiring");
    const hint = within(row).getByTestId(
      "hint-notify-data-export-expiring-link-change",
    );
    expect(hint).toBeTruthy();
  });
});
