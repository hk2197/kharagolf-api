/**
 * Component test: web portal Notifications tab "Last changed via email
 * link" hint below the Stuck-erasure cleanup digest toggle (Task #1772).
 *
 * Task #1454 made the API expose two new fields next to the digest
 * preference (`notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt`
 * and `...Direction`), but no portal screen surfaced them. This test
 * mirrors the established pattern in
 * `portal-comm-prefs-erasure-storage-digest.test.tsx`: mocks `fetch` so the
 * GET hydrates the prefs, then asserts that the hint row is visible (and
 * carries the right wording) when the audit fields are populated, and is
 * hidden when both fields are null.
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
  // Tests in this file assert text content emitted by `t(...)`, which
  // means i18next has to be initialised. The shared setup file
  // (`tests/setup.ts`) intentionally leaves i18next alone so most
  // tests can run without paying the locale-bundle cost; we only need
  // the `portal` namespace + English fallback for these assertions.
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
};

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
  };
  mockMeRole = "org_admin";
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

describe("PortalCommPrefs — Stuck erasure digest link-change hint (Task #1772)", () => {
  it("renders the hint with the formatted date and '(unsubscribed)' when direction=unsubscribe", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt:
        "2026-04-24T08:30:00.000Z",
      notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const hint = await screen.findByTestId(
      "hint-notify-erasure-storage-digest-link-change",
    );
    expect(hint.textContent).toMatch(/Last changed via email link/i);
    expect(hint.textContent).toMatch(/2026/);
    expect(hint.textContent).toMatch(/Apr/);
    expect(hint.textContent).toMatch(/\(unsubscribed\)/);
  });

  it("renders '(re-subscribed)' when direction=resubscribe", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt:
        "2026-04-24T08:30:00.000Z",
      notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection:
        "resubscribe",
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const hint = await screen.findByTestId(
      "hint-notify-erasure-storage-digest-link-change",
    );
    expect(hint.textContent).toMatch(/\(re-subscribed\)/);
  });

  it("hides the hint when both audit fields are null (controller has never used the link)", async () => {
    // Default `serverNotifPrefs` already has both fields null.
    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    // Wait for the surrounding row to render so the hint has had its
    // chance to mount.
    await screen.findByTestId("switch-notify-erasure-storage-digest-email");

    expect(
      screen.queryByTestId("hint-notify-erasure-storage-digest-link-change"),
    ).toBeNull();
  });

  it("hides the hint when the timestamp is null even if a stale direction is present", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt: null,
      notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-erasure-storage-digest-email");

    expect(
      screen.queryByTestId("hint-notify-erasure-storage-digest-link-change"),
    ).toBeNull();
  });

  it("hides the hint for non-controller users (player role) regardless of audit fields", async () => {
    mockMeRole = "player";
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt:
        "2026-04-24T08:30:00.000Z",
      notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    // Wait for an unrelated sibling row to render so role-gating settles.
    await screen.findByTestId("switch-notify-data-export-expiring");

    expect(
      screen.queryByTestId("hint-notify-erasure-storage-digest-link-change"),
    ).toBeNull();
  });

  it("hides the hint when the timestamp is unparseable (defensive guard)", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt: "not-a-date",
      notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection:
        "unsubscribe",
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-erasure-storage-digest-email");

    await waitFor(() => {
      expect(
        screen.queryByTestId("hint-notify-erasure-storage-digest-link-change"),
      ).toBeNull();
    });
  });
});
