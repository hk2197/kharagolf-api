/**
 * Component test: web portal Notifications tab — live "which channels
 * are silenced" status preview for the stuck-erasure cleanup digest
 * (Task #1774).
 *
 * Task #1449 split the digest delivery into two independent toggles
 * (email + in-app/push). Controllers can land in any of four states
 * (both, email-only, push-only, none) but the original UI only showed
 * the two raw switches in isolation. Task #1774 layers a one-line live
 * status under those toggles plus a warning hint when both channels are
 * muted (since the org-level escalation still relies on at least one
 * channel reaching the controller).
 *
 * This fixture flips each switch and asserts:
 *   - the status text matches the (email, push) cross-product
 *   - the "both muted" warning hint only renders in the both-off state
 *   - the row stays hidden for non-controller roles
 *
 * The status copy comes from `src/i18n/locales/en/portal.json`
 * (`emailOptOuts.erasureStorageStatus*` and
 * `emailOptOuts.erasureStorageBothMutedHint`). Asserting against
 * `data-testid` for the status branch and `getByText` for the visible
 * copy keeps the test sensitive to both wiring regressions and label
 * regressions.
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

// `PortalCommPrefs.tsx` does not import `../i18n` itself — only `main.tsx`
// does — so test bundles otherwise see an uninitialised i18n instance and
// every `t('emailOptOuts.*')` call falls back to the bare key. Booting the
// bundle here lets us assert against the actual rendered status copy.
import i18n from "../i18n";
import enPortal from "../i18n/locales/en/portal.json";

beforeAll(async () => {
  await i18n.changeLanguage("en");
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
  if (url.includes("/api/portal/digest-preferences")) {
    // Task #1832 — the consolidated "Email digests" section fetches this
    // endpoint on mount. Returning an empty list keeps the section hidden
    // (it gates on `digests.length > 0`) so this fixture stays focused on
    // the stuck-erasure status preview.
    if (method === "GET") {
      return new Response(JSON.stringify({ digests: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
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

async function loadCard() {
  const mod = await import("../pages/portal/PortalCommPrefs");
  return mod.PortalCommPrefs;
}

describe("PortalCommPrefs — stuck-erasure digest channel status preview (Task #1774)", () => {
  it("starts in the 'both channels' state when both toggles are on", async () => {
    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    await screen.findByTestId("switch-notify-erasure-storage-digest-email");
    await waitFor(() =>
      expect(
        screen
          .getByTestId("switch-notify-erasure-storage-digest-email")
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );

    expect(
      screen.getByTestId("erasure-storage-status-both"),
    ).toHaveTextContent(enPortal.emailOptOuts.erasureStorageStatusBoth);
    // The "both muted" hint must NOT render here — it should only ever
    // appear when both channels are off.
    expect(
      screen.queryByTestId("erasure-storage-both-muted-hint"),
    ).toBeNull();
  });

  it("flips to 'push only' when the email toggle is muted", async () => {
    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const emailToggle = await screen.findByTestId(
      "switch-notify-erasure-storage-digest-email",
    );
    await waitFor(() =>
      expect(emailToggle.getAttribute("aria-checked")).toBe("true"),
    );

    await act(async () => {
      fireEvent.click(emailToggle);
    });

    await waitFor(() =>
      expect(
        screen
          .getByTestId("switch-notify-erasure-storage-digest-email")
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );

    expect(
      screen.getByTestId("erasure-storage-status-push-only"),
    ).toHaveTextContent(enPortal.emailOptOuts.erasureStorageStatusPushOnly);
    expect(screen.queryByTestId("erasure-storage-status-both")).toBeNull();
    expect(
      screen.queryByTestId("erasure-storage-both-muted-hint"),
    ).toBeNull();
  });

  it("flips to 'email only' when the push toggle is muted", async () => {
    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const pushToggle = await screen.findByTestId(
      "switch-notify-erasure-storage-digest-push",
    );
    await waitFor(() =>
      expect(pushToggle.getAttribute("aria-checked")).toBe("true"),
    );

    await act(async () => {
      fireEvent.click(pushToggle);
    });

    await waitFor(() =>
      expect(
        screen
          .getByTestId("switch-notify-erasure-storage-digest-push")
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );

    expect(
      screen.getByTestId("erasure-storage-status-email-only"),
    ).toHaveTextContent(enPortal.emailOptOuts.erasureStorageStatusEmailOnly);
    expect(
      screen.queryByTestId("erasure-storage-both-muted-hint"),
    ).toBeNull();
  });

  it("shows the 'both muted' status and the warning hint when both toggles are off", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: false,
    };

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const emailToggle = await screen.findByTestId(
      "switch-notify-erasure-storage-digest-email",
    );
    await waitFor(() =>
      expect(emailToggle.getAttribute("aria-checked")).toBe("false"),
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId("switch-notify-erasure-storage-digest-push")
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );

    expect(
      screen.getByTestId("erasure-storage-status-both-muted"),
    ).toHaveTextContent(
      enPortal.emailOptOuts.erasureStorageStatusBothMuted,
    );

    // The warning hint reminds the controller that the org-level
    // escalation still relies on at least one channel reaching them.
    const hint = screen.getByTestId("erasure-storage-both-muted-hint");
    expect(hint).toHaveTextContent(
      enPortal.emailOptOuts.erasureStorageBothMutedHint,
    );
  });

  it("transitions through all four states as the toggles are flipped", async () => {
    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    const emailToggle = await screen.findByTestId(
      "switch-notify-erasure-storage-digest-email",
    );
    const pushToggle = screen.getByTestId(
      "switch-notify-erasure-storage-digest-push",
    );

    // Start: both on → "Both channels"
    await waitFor(() =>
      expect(emailToggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.getByTestId("erasure-storage-status-both")).toBeTruthy();

    // Mute email → "Push only"
    await act(async () => {
      fireEvent.click(emailToggle);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("erasure-storage-status-push-only"),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByTestId("erasure-storage-both-muted-hint"),
    ).toBeNull();

    // Mute push → "Both muted" + hint
    await act(async () => {
      fireEvent.click(pushToggle);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("erasure-storage-status-both-muted"),
      ).toBeTruthy(),
    );
    expect(
      screen.getByTestId("erasure-storage-both-muted-hint"),
    ).toBeTruthy();

    // Re-enable email → "Email only", hint clears
    await act(async () => {
      fireEvent.click(emailToggle);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("erasure-storage-status-email-only"),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByTestId("erasure-storage-both-muted-hint"),
    ).toBeNull();

    // Re-enable push → "Both channels"
    await act(async () => {
      fireEvent.click(pushToggle);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("erasure-storage-status-both"),
      ).toBeTruthy(),
    );
  });

  it("hides the entire row (and therefore the status preview) for non-controller roles", async () => {
    mockMeRole = "player";

    const PortalCommPrefs = await loadCard();
    render(<PortalCommPrefs />);

    // Wait for the card to settle by latching onto an unrelated row.
    await screen.findByTestId("switch-notify-data-export-expiring");

    expect(
      screen.queryByTestId("row-notify-erasure-storage-digest"),
    ).toBeNull();
    expect(screen.queryByTestId("erasure-storage-status")).toBeNull();
    expect(
      screen.queryByTestId("erasure-storage-both-muted-hint"),
    ).toBeNull();
  });
});
