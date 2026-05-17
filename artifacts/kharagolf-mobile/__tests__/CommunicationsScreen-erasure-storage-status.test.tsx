/**
 * Component test: mobile per-controller live "which channels are
 * silenced" status preview for the stuck-erasure cleanup digest
 * (Task #2220).
 *
 * Mirrors the web portal fixture
 * `artifacts/kharagolf-web/src/tests/portal-comm-prefs-erasure-storage-status.test.tsx`
 * (Task #1774). Task #1769 shipped the email half of the digest
 * toggle on the mobile screen and Task #2205 added the in-app/push
 * sibling, but neither task ported over the four-state status preview
 * (Email only / Push only / Both channels / Both muted) or the
 * both-muted warning hint. Without a status line a controller flipping
 * toggles on mobile has to mentally combine the two switch states; the
 * preview restores web/mobile parity.
 *
 * Each test boots `CommunicationsScreen`, hydrates a different
 * `(notifyErasureStorageDigest, notifyErasureStorageDigestPush)`
 * combination from the fake notification-preferences endpoint, and
 * asserts that:
 *   - the matching status testID is rendered with the English copy
 *     from `i18n/locales/en/profile.json`
 *   - the both-muted warning hint only appears in the both-off state
 *
 * It also flips a toggle live via `fireEvent.click` and confirms the
 * status updates without a re-fetch (matching the optimistic-UI pattern
 * the surrounding suite already exercises for the toggles themselves).
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
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import enProfile from "@/i18n/locales/en/profile.json";

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

let serverNotifPrefs: Record<string, unknown> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("/api/portal/notification-key-prefs") && method === "GET") {
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
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      serverNotifPrefs = { ...serverNotifPrefs, ...body };
      return new Response(JSON.stringify(serverNotifPrefs), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
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
    notifyDataExportExpiring: true,
    notifyManualEntryAlerts: true,
    notifyCoachPayoutAccountChanges: true,
    notifyAdminPayoutReverify: true,
    notifyErasureStorageDigest: true,
    notifyErasureStorageDigestPush: true,
  };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommunicationsScreen — stuck-erasure digest channel status preview (Task #2220)", () => {
  it("renders 'Both channels' when both toggles hydrate ON", async () => {
    render(<CommunicationsScreen />);

    const emailToggle = await screen.findByTestId("switch-notify-erasure-storage-digest");
    await waitFor(() => {
      const cb = emailToggle.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(true);
    });

    expect(screen.getByTestId("erasure-storage-status-both")).toHaveTextContent(
      enProfile.commPrefs.emailOptOuts.erasureStorageStatusBoth,
    );
    // The both-muted warning must NOT render in this state.
    expect(screen.queryByTestId("erasure-storage-both-muted-hint")).toBeNull();
  });

  it("renders 'Push only' when only the email toggle is muted", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: true,
    };
    render(<CommunicationsScreen />);

    const emailToggle = await screen.findByTestId("switch-notify-erasure-storage-digest");
    await waitFor(() => {
      const cb = emailToggle.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });

    expect(screen.getByTestId("erasure-storage-status-push-only")).toHaveTextContent(
      enProfile.commPrefs.emailOptOuts.erasureStorageStatusPushOnly,
    );
    expect(screen.queryByTestId("erasure-storage-status-both")).toBeNull();
    expect(screen.queryByTestId("erasure-storage-both-muted-hint")).toBeNull();
  });

  it("renders 'Email only' when only the push toggle is muted", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: true,
      notifyErasureStorageDigestPush: false,
    };
    render(<CommunicationsScreen />);

    const pushToggle = await screen.findByTestId("switch-notify-erasure-storage-digest-push");
    await waitFor(() => {
      const cb = pushToggle.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });

    expect(screen.getByTestId("erasure-storage-status-email-only")).toHaveTextContent(
      enProfile.commPrefs.emailOptOuts.erasureStorageStatusEmailOnly,
    );
    expect(screen.queryByTestId("erasure-storage-both-muted-hint")).toBeNull();
  });

  it("renders 'Both muted' AND the warning hint when both toggles hydrate OFF", async () => {
    serverNotifPrefs = {
      ...serverNotifPrefs,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: false,
    };
    render(<CommunicationsScreen />);

    const emailToggle = await screen.findByTestId("switch-notify-erasure-storage-digest");
    await waitFor(() => {
      const cb = emailToggle.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });
    await waitFor(() => {
      const cb = (
        screen.getByTestId("switch-notify-erasure-storage-digest-push")
          .querySelector("input[type='checkbox']") as HTMLInputElement
      );
      expect(cb.checked).toBe(false);
    });

    expect(screen.getByTestId("erasure-storage-status-both-muted")).toHaveTextContent(
      enProfile.commPrefs.emailOptOuts.erasureStorageStatusBothMuted,
    );

    // The amber warning hint reminds the controller that the org-level
    // escalation still relies on at least one channel reaching them.
    expect(screen.getByTestId("erasure-storage-both-muted-hint")).toHaveTextContent(
      enProfile.commPrefs.emailOptOuts.erasureStorageBothMutedHint,
    );
  });

  it("transitions through all four states as the toggles are flipped", async () => {
    render(<CommunicationsScreen />);

    // The Switch is briefly replaced by a LoadingSpinner while the
    // PATCH is in flight, which blows away cached DOM-node references.
    // Re-query both checkboxes each time so we always click the current
    // live element.
    const emailCb = () =>
      screen
        .getByTestId("switch-notify-erasure-storage-digest")
        .querySelector("input[type='checkbox']") as HTMLInputElement;
    const pushCb = () =>
      screen
        .getByTestId("switch-notify-erasure-storage-digest-push")
        .querySelector("input[type='checkbox']") as HTMLInputElement;

    await screen.findByTestId("switch-notify-erasure-storage-digest");

    // Start: both on → "Both channels"
    await waitFor(() => expect(emailCb().checked).toBe(true));
    expect(screen.getByTestId("erasure-storage-status-both")).toBeInTheDocument();
    expect(screen.queryByTestId("erasure-storage-both-muted-hint")).toBeNull();

    // Mute email → "Push only"
    await act(async () => {
      fireEvent.click(emailCb());
    });
    await waitFor(() =>
      expect(screen.getByTestId("erasure-storage-status-push-only")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("erasure-storage-both-muted-hint")).toBeNull();

    // Mute push → "Both muted" + amber warning hint
    await waitFor(() => expect(pushCb().checked).toBe(true));
    await act(async () => {
      fireEvent.click(pushCb());
    });
    await waitFor(() =>
      expect(screen.getByTestId("erasure-storage-status-both-muted")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("erasure-storage-both-muted-hint")).toBeInTheDocument();

    // Re-enable email → "Email only", warning hint clears
    await waitFor(() => expect(emailCb().checked).toBe(false));
    await act(async () => {
      fireEvent.click(emailCb());
    });
    await waitFor(() =>
      expect(screen.getByTestId("erasure-storage-status-email-only")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("erasure-storage-both-muted-hint")).toBeNull();

    // Re-enable push → back to "Both channels"
    await waitFor(() => expect(pushCb().checked).toBe(false));
    await act(async () => {
      fireEvent.click(pushCb());
    });
    await waitFor(() =>
      expect(screen.getByTestId("erasure-storage-status-both")).toBeInTheDocument(),
    );
  });
});
