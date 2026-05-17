/**
 * Component test: web portal Notifications tab "you recently muted this"
 * tip below the Stuck-erasure cleanup digest toggles (Task #2218).
 *
 * Task #1776 sends an email confirmation when a controller mutes the
 * stuck-erasure digest from the in-portal toggle and stamps a watermark
 * column (`notifyErasureStorageDigestMuteConfirmationLastSentAt`). The
 * settings UI now reads the watermark and surfaces a small banner with
 * a one-click revert when the timestamp is < 30 days old and at least
 * one channel is currently muted, mirroring the email's revert link
 * without making the controller hunt down the original email.
 *
 * This fixture mocks `fetch` so the GET hydrates the prefs (with the
 * watermark and the channel toggles in each visual state) and asserts:
 *   - the tip surfaces only when the watermark is recent AND a channel
 *     is currently muted
 *   - the body copy reflects which channel(s) are muted (email-only,
 *     push-only, both)
 *   - clicking "Re-enable both" PATCHes both fields back to true and
 *     hides the tip
 *   - clicking the dismiss X hides the tip and persists per-watermark
 *     so a fresh mute (different timestamp) re-surfaces it
 *   - the tip stays hidden once the watermark is older than 30 days
 *   - the tip stays hidden for non-controller roles
 */
import React from "react";
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
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
  notifyErasureStorageDigestMuteConfirmationLastSentAt: string | null;
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
  notifyErasureStorageDigestMuteConfirmationLastSentAt: null,
};

let mockMeRole: string | null = "org_admin";
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: mockMeRole ? { id: 42, organizationId: 1, role: mockMeRole } : undefined,
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
  if (url.includes("/api/portal/digest-preferences")) {
    return new Response(JSON.stringify({ digests: [] }), {
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
    notifyErasureStorageDigestMuteConfirmationLastSentAt: null,
  };
  mockMeRole = "org_admin";
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  // `localStorage` is stateful across tests in jsdom; clear so the
  // dismissal flag doesn't leak between cases.
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom always provides localStorage; defensive */
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function loadCard() {
  const mod = await import("../pages/portal/PortalCommPrefs");
  return mod.PortalCommPrefs;
}

function recentIsoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("PortalCommPrefs — recently-muted erasure-digest tip (Task #2218)", () => {
  it("hides the tip when the watermark is null (controller has never muted from settings)", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: false,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: null,
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-erasure-storage-digest-email");
    expect(
      screen.queryByTestId("tip-erasure-storage-digest-recently-muted"),
    ).toBeNull();
  });

  it("hides the tip when both channels are currently on (nothing to revert)", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: true,
      notifyErasureStorageDigestPush: true,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: recentIsoDaysAgo(2),
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-erasure-storage-digest-email");
    expect(
      screen.queryByTestId("tip-erasure-storage-digest-recently-muted"),
    ).toBeNull();
  });

  it("hides the tip when the watermark is older than 30 days", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: false,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: recentIsoDaysAgo(45),
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-erasure-storage-digest-email");
    expect(
      screen.queryByTestId("tip-erasure-storage-digest-recently-muted"),
    ).toBeNull();
  });

  it("renders the email-only variant when only the email channel is muted", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: true,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: recentIsoDaysAgo(3),
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const tip = await screen.findByTestId(
      "tip-erasure-storage-digest-recently-muted",
    );
    const channels = screen.getByTestId("recently-muted-tip-channels-email");
    expect(channels.textContent).toMatch(
      new RegExp(enPortal.emailOptOuts.recentlyMutedTipChannelsEmail, "i"),
    );
    expect(tip.textContent).toMatch(/You muted/);
    expect(
      screen.queryByTestId("recently-muted-tip-channels-push"),
    ).toBeNull();
    expect(
      screen.queryByTestId("recently-muted-tip-channels-both"),
    ).toBeNull();
  });

  it("renders the push-only variant when only the in-app/push channel is muted", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: true,
      notifyErasureStorageDigestPush: false,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: recentIsoDaysAgo(3),
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("tip-erasure-storage-digest-recently-muted");
    const channels = screen.getByTestId("recently-muted-tip-channels-push");
    expect(channels.textContent).toMatch(
      new RegExp(enPortal.emailOptOuts.recentlyMutedTipChannelsPush, "i"),
    );
    expect(
      screen.queryByTestId("recently-muted-tip-channels-email"),
    ).toBeNull();
  });

  it("renders the both-muted variant when both channels are silenced", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: false,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: recentIsoDaysAgo(1),
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("tip-erasure-storage-digest-recently-muted");
    const channels = screen.getByTestId("recently-muted-tip-channels-both");
    expect(channels.textContent).toMatch(
      new RegExp(enPortal.emailOptOuts.recentlyMutedTipChannelsBoth, "i"),
    );
  });

  it("re-enables both channels and hides the tip when the revert button is clicked", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: false,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: recentIsoDaysAgo(2),
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const revert = await screen.findByTestId(
      "btn-revert-recently-muted-erasure-digest",
    );

    await act(async () => {
      fireEvent.click(revert);
    });

    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(([input, init]) => {
        const url = String(input);
        const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
        return url.includes("/api/portal/notification-preferences") && method === "PATCH";
      });
      expect(patches.length).toBeGreaterThanOrEqual(1);
      const lastBody = JSON.parse(
        String((patches[patches.length - 1][1] as RequestInit).body ?? "{}"),
      );
      expect(lastBody.notifyErasureStorageDigest).toBe(true);
      expect(lastBody.notifyErasureStorageDigestPush).toBe(true);
    });

    await waitFor(() => {
      expect(
        screen
          .getByTestId("switch-notify-erasure-storage-digest-email")
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        screen
          .getByTestId("switch-notify-erasure-storage-digest-push")
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    expect(
      screen.queryByTestId("tip-erasure-storage-digest-recently-muted"),
    ).toBeNull();
  });

  it("hides the tip when the dismiss button is clicked and persists the dismissal in localStorage", async () => {
    const watermark = recentIsoDaysAgo(2);
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: true,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: watermark,
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const dismiss = await screen.findByTestId(
      "btn-dismiss-recently-muted-erasure-digest-tip",
    );

    await act(async () => {
      fireEvent.click(dismiss);
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("tip-erasure-storage-digest-recently-muted"),
      ).toBeNull();
    });

    const storageKey = `kharagolf:tip:erasureDigestRecentlyMuted:dismissed:42:${watermark}`;
    expect(window.localStorage.getItem(storageKey)).toBe("1");
  });

  it("re-surfaces the tip when a fresh mute advances the watermark to a new timestamp", async () => {
    const oldWatermark = recentIsoDaysAgo(10);
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: true,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: oldWatermark,
    };

    // Pre-dismiss the tip for the OLD watermark in localStorage.
    const oldKey = `kharagolf:tip:erasureDigestRecentlyMuted:dismissed:42:${oldWatermark}`;
    window.localStorage.setItem(oldKey, "1");

    const PortalCommPrefs = await loadCard();
    const { unmount } = render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-erasure-storage-digest-email");
    expect(
      screen.queryByTestId("tip-erasure-storage-digest-recently-muted"),
    ).toBeNull();

    unmount();

    // Now the watermark advances (a fresh mute) — render again.
    const newWatermark = recentIsoDaysAgo(1);
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: newWatermark,
    };

    render(<PortalCommPrefs />);

    await screen.findByTestId("tip-erasure-storage-digest-recently-muted");
  });

  it("hides the tip for non-controller roles (player) regardless of watermark", async () => {
    mockMeRole = "player";
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: false,
      notifyErasureStorageDigestMuteConfirmationLastSentAt: recentIsoDaysAgo(1),
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-data-export-expiring");
    expect(
      screen.queryByTestId("tip-erasure-storage-digest-recently-muted"),
    ).toBeNull();
    expect(
      screen.queryByTestId("row-notify-erasure-storage-digest"),
    ).toBeNull();
  });
});
