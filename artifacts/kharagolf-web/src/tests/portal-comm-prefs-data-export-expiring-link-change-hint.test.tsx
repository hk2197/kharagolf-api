/**
 * Component test: web portal Notifications tab "Last changed via email
 * link" hint below the data-export-expiring 24-hour heads-up reminder
 * toggle (Task #2212).
 *
 * Task #1773 made the API expose two new fields next to the data-export
 * reminder preference (`notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt`
 * and `...Direction`), but no portal screen surfaced them. This test
 * mirrors the established pattern in
 * `portal-comm-prefs-erasure-storage-digest-link-change-hint.test.tsx`:
 * mocks `fetch` so the GET hydrates the prefs, then asserts that the
 * hint row is visible (and carries the right wording) when the audit
 * fields are populated, and is hidden when both fields are null.
 *
 * Unlike the erasure-storage chip the data-export-expiring chip is
 * visible to every member (not gated to controllers): the data-export
 * reminder is a per-player notice and the public unsubscribe link is
 * accessible to everyone who receives the email.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enPortal from "../i18n/locales/en/portal.json";

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      lng: "en",
      fallbackLng: "en",
      defaultNS: "portal",
      ns: ["portal"],
      resources: { en: { portal: enPortal } },
      interpolation: { escapeValue: false },
    });
  }
});

interface NotifPrefsRow {
  notifySideGameReceipts: boolean;
  notifyManualEntryAlerts: boolean;
  notifyCoachPayoutAccountChanges: boolean;
  notifyDataExportExpiring: boolean;
  notifyWalletRefundDigestFailed: boolean;
  notifySideGameReceiptDigestFailed: boolean;
  notifyErasureStorageDigest: boolean;
  notifyErasureStorageDigestPush: boolean;
  notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt: string | null;
  notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection:
    | "unsubscribe"
    | "resubscribe"
    | null;
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
  notifyDataExportExpiring: true,
  notifyWalletRefundDigestFailed: true,
  notifySideGameReceiptDigestFailed: true,
  notifyErasureStorageDigest: true,
  notifyErasureStorageDigestPush: true,
  notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt: null,
  notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection: null,
  notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: null,
  notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection: null,
};

let mockMeRole: string | null = "player";
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
    notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt: null,
    notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection: null,
    notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: null,
    notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection: null,
  };
  mockMeRole = "player";
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function loadCard() {
  const mod = await import("../pages/portal/PortalCommPrefs");
  return mod.PortalCommPrefs;
}

describe("PortalCommPrefs — Data-export-expiring reminder link-change hint (Task #2212)", () => {
  it("renders the hint with the formatted date and '(unsubscribed)' when direction=unsubscribe", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt:
        "2026-04-24T08:30:00.000Z",
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

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

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const hint = await screen.findByTestId(
      "hint-notify-data-export-expiring-link-change",
    );
    expect(hint.textContent).toMatch(/\(re-subscribed\)/);
  });

  it("hides the hint when both audit fields are null (member has never used the link)", async () => {
    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    // Wait for the surrounding row to render so the hint has had its
    // chance to mount.
    await screen.findByTestId("switch-notify-data-export-expiring");

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

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-data-export-expiring");

    expect(
      screen.queryByTestId("hint-notify-data-export-expiring-link-change"),
    ).toBeNull();
  });

  it("renders the hint for a regular player (not gated to controllers)", async () => {
    // The data-export-expiring reminder is a per-player notice and the
    // public unsubscribe link is delivered to every member who receives
    // the email — unlike the erasure-storage digest hint, the chip
    // must NOT be role-gated. Asserting an explicit player role keeps
    // a future contributor from accidentally copying the
    // `isController && (...)` wrapper from the erasure row.
    mockMeRole = "player";
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt:
        "2026-04-24T08:30:00.000Z",
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const hint = await screen.findByTestId(
      "hint-notify-data-export-expiring-link-change",
    );
    expect(hint.textContent).toMatch(/Last changed via email link/i);
  });

  it("hides the hint when the timestamp is unparseable (defensive guard)", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: "not-a-date",
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-data-export-expiring");

    await waitFor(() => {
      expect(
        screen.queryByTestId("hint-notify-data-export-expiring-link-change"),
      ).toBeNull();
    });
  });

  it("keeps the hint visible after the toggle is flipped back from the portal (audit row is permanent)", async () => {
    // Done-looks-like clause: the chip stays visible after the member
    // flips the toggle back from the portal because the server keeps
    // returning the `LastChangedViaUnsubscribeLinkAt` timestamp from
    // the permanent member_audit_log row. Simulate that by leaving the
    // audit fields populated even though the toggle is `true` (re-
    // enabled) — the chip should still render.
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyDataExportExpiring: true,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt:
        "2026-04-24T08:30:00.000Z",
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const hint = await screen.findByTestId(
      "hint-notify-data-export-expiring-link-change",
    );
    expect(hint).toBeTruthy();
    // And the toggle still shows ON since the GET returned `true`.
    const toggle = screen.getByTestId("switch-notify-data-export-expiring");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
