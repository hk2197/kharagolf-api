/**
 * Component test: mobile portal-privacy "Share my profile" buttons (Task #934).
 *
 * Mirrors the web e2e added in Task #787
 * (artifacts/kharagolf-web/src/pages/__tests__/portal-share-copy.test.tsx)
 * but for the KHARAGOLF Mobile portal-privacy screen. Mounts the screen
 * with a stubbed fetch + native Share API and verifies that:
 *
 *   - Tapping "Share my profile" opens the OS share sheet AND emits a
 *     POST /api/portal/me/profile-share-events with
 *     { method: "native_share", source: "mobile" }, then refreshes the
 *     share-stats endpoint so the visible counter updates.
 *   - Tapping the "QR code" button emits a POST with
 *     { method: "qr_open", source: "mobile" } and refreshes stats.
 *
 * The server-side contract for that endpoint (auth, method validation,
 * no-handle case, source whitelist, aggregation) is covered against the
 * live PostgreSQL test DB by
 * artifacts/api-server/src/tests/profile-share-events.test.ts. This test
 * exists to catch regressions in the mobile UI handler / auth header /
 * URL that would silently stop emitting source="mobile" events and skew
 * the growth dashboard toward web-only data.
 *
 * Note on coverage scope: the mobile portal-privacy screen does not
 * surface a standalone "copy link" button — sharing on mobile flows
 * through the native OS share sheet (which itself exposes Copy as one of
 * its options). The two share *paths* present in the mobile UI are the
 * native share button and the QR button, and both are covered here.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token", user: { id: 1 }, isAuthenticated: true, isLoading: false }),
}));

vi.mock("react-native-safe-area-context", () => {
  const React = require("react");
  return {
    SafeAreaView: ({ children, ...rest }: { children: React.ReactNode }) =>
      React.createElement("div", rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

vi.mock("react-native-qrcode-svg", () => {
  const React = require("react");
  const QRCode = (props: { value?: string }) =>
    React.createElement("div", { "data-testid": "qr-svg", "data-value": props?.value });
  return { default: QRCode };
});

// `app/portal-privacy.tsx` imports expo-apple-authentication and
// expo-auth-session/providers/google at module scope. Both pull in
// expo-modules-core, which crashes under jsdom because `globalThis.expo`
// is undefined. Stubbing them here matches what other mobile specs (e.g.
// `a11y-mobile-screens.test.tsx`) do so the screen module loads.
vi.mock("expo-apple-authentication", () => ({
  AppleAuthenticationButton: () => null,
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  AppleAuthenticationButtonStyle: { BLACK: 0 },
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  isAvailableAsync: async () => false,
  signInAsync: async () => ({ identityToken: null, fullName: null }),
}));
vi.mock("expo-auth-session/providers/google", () => ({
  useIdTokenAuthRequest: () => [null, null, async () => null],
  useAuthRequest: () => [null, null, async () => null],
}));
vi.mock("expo-web-browser", () => ({
  maybeCompleteAuthSession: () => {},
  openAuthSessionAsync: async () => ({ type: "cancel" }),
}));

import { Share } from "react-native";
import PortalPrivacyScreen from "../app/portal-privacy";

interface ShareEventBody { method: string; source: string }

interface FetchState {
  shareEventCalls: ShareEventBody[];
  shareStatsCalls: number;
  total: number;
  byNative: number;
  byQr: number;
  // Task #1782 — drive the optional web-vs-mobile reach split. When
  // `bySource` is null, the share-stats response omits the field entirely
  // (mirroring the API for owners with only legacy/null-source history).
  bySource: { web: number; mobile: number } | null;
}

let state: FetchState;

function installFetch() {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/api/portal/me/public-profile") && method === "GET") {
      return new Response(JSON.stringify({
        publicHandle: "share-tester",
        publicProfileEnabled: true,
        publicShowHandicap: true,
        publicShowRecentRounds: true,
        publicShowAchievements: true,
        publicShowFavoriteCourses: true,
        publicBio: null,
        publicLocation: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.endsWith("/api/portal/me/public-scorecards") && method === "GET") {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.endsWith("/api/portal/me/public-profile/share-stats") && method === "GET") {
      state.shareStatsCalls += 1;
      const payload: {
        total: number;
        byMethod: Record<string, number>;
        bySource?: { web: number; mobile: number };
      } = {
        total: state.total,
        byMethod: {
          copy: 0,
          web_share: 0,
          native_share: state.byNative,
          qr_open: state.byQr,
        },
      };
      if (state.bySource) payload.bySource = state.bySource;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/api/portal/me/profile-share-events") && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}") as ShareEventBody;
      state.shareEventCalls.push(body);
      if (body.method === "native_share") { state.byNative += 1; state.total += 1; }
      if (body.method === "qr_open") { state.byQr += 1; state.total += 1; }
      // The server tags each event by source; for source="mobile" it
      // bumps the mobile bucket of bySource. We mirror that so the chip
      // row updates after a fresh share.
      if (body.source === "mobile" && (body.method === "native_share" || body.method === "qr_open")) {
        state.bySource = state.bySource
          ? { ...state.bySource, mobile: state.bySource.mobile + 1 }
          : { web: 0, mobile: 1 };
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

beforeEach(() => {
  state = { shareEventCalls: [], shareStatsCalls: 0, total: 0, byNative: 0, byQr: 0, bySource: null };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<PortalPrivacyScreen /> — mobile share analytics (Task #934)", () => {
  it("renders the Share section once the public profile is loaded", async () => {
    render(<PortalPrivacyScreen />);
    expect(await screen.findByTestId("share-row")).toBeInTheDocument();
    expect(screen.getByTestId("share-button")).toBeInTheDocument();
    expect(screen.getByTestId("qr-button")).toBeInTheDocument();
    // Initial stats fetch happened as part of the page-load Promise.all.
    await waitFor(() => expect(state.shareStatsCalls).toBeGreaterThanOrEqual(1));
  });

  it("tapping Share my profile opens the native share sheet, POSTs method=native_share / source=mobile, and refreshes stats", async () => {
    const shareSpy = vi.spyOn(Share, "share").mockResolvedValue({
      action: Share.sharedAction,
    } as Awaited<ReturnType<typeof Share.share>>);

    render(<PortalPrivacyScreen />);
    const shareBtn = await screen.findByTestId("share-button");
    const statsBefore = state.shareStatsCalls;

    await act(async () => {
      fireEvent.click(shareBtn);
    });

    // Native share sheet was opened with the profile URL.
    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const shareArg = shareSpy.mock.calls[0][0] as { url?: string; message?: string };
    expect(shareArg.url).toBe("https://kharagolf.com/p/share-tester");
    expect(shareArg.message).toMatch(/share-tester/);

    // Analytics POST — exactly one event with the expected mobile shape.
    await waitFor(() => expect(state.shareEventCalls.length).toBe(1));
    expect(state.shareEventCalls[0]).toEqual({ method: "native_share", source: "mobile" });

    // Stats refresh fires after the event POST settles.
    await waitFor(() => expect(state.shareStatsCalls).toBeGreaterThan(statsBefore));
    const stats = await screen.findByTestId("share-stats");
    expect(stats).toHaveTextContent(/1 share so far/i);
    expect(stats).toHaveTextContent(/Native: 1/);
  });

  it("does NOT log an event when the user dismisses the native share sheet", async () => {
    const shareSpy = vi.spyOn(Share, "share").mockResolvedValue({
      action: Share.dismissedAction,
    } as Awaited<ReturnType<typeof Share.share>>);

    render(<PortalPrivacyScreen />);
    const shareBtn = await screen.findByTestId("share-button");

    await act(async () => {
      fireEvent.click(shareBtn);
    });

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    // Give any (incorrect) POST a chance to fire.
    await new Promise(r => setTimeout(r, 30));
    expect(state.shareEventCalls.length).toBe(0);
  });

  it("tapping QR code opens the QR modal, POSTs method=qr_open / source=mobile, and refreshes stats", async () => {
    render(<PortalPrivacyScreen />);
    const qrBtn = await screen.findByTestId("qr-button");
    const statsBefore = state.shareStatsCalls;

    await act(async () => {
      fireEvent.click(qrBtn);
    });

    // The QR modal appears with the profile URL encoded in the QR.
    const qr = await screen.findByTestId("qr-svg");
    expect(qr.getAttribute("data-value")).toBe("https://kharagolf.com/p/share-tester");

    // Analytics POST — exactly one qr_open event with source=mobile.
    await waitFor(() => expect(state.shareEventCalls.length).toBe(1));
    expect(state.shareEventCalls[0]).toEqual({ method: "qr_open", source: "mobile" });

    // Stats refresh fires after the event POST settles.
    await waitFor(() => expect(state.shareStatsCalls).toBeGreaterThan(statsBefore));
    const stats = await screen.findByTestId("share-stats");
    expect(stats).toHaveTextContent(/1 share so far/i);
    expect(stats).toHaveTextContent(/QR: 1/);
  });

  it("attaches the portal Bearer token to the share-event POST", async () => {
    vi.spyOn(Share, "share").mockResolvedValue({
      action: Share.sharedAction,
    } as Awaited<ReturnType<typeof Share.share>>);

    render(<PortalPrivacyScreen />);
    const shareBtn = await screen.findByTestId("share-button");
    await act(async () => { fireEvent.click(shareBtn); });

    await waitFor(() => expect(state.shareEventCalls.length).toBe(1));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const postCall = fetchMock.mock.calls.find(c => {
      const url = String(c[0]);
      const method = ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      return url.endsWith("/api/portal/me/profile-share-events") && method === "POST";
    });
    expect(postCall).toBeDefined();
    const headers = (postCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

/**
 * UI coverage for Task #1458's web-vs-mobile reach split (Task #1782).
 *
 * The API change has unit-test coverage but the chip row that renders
 * "Where shares come from: Web N · Mobile N" did not. Without this
 * coverage a refactor to the mobile portal-privacy screen could silently
 * drop the breakdown from the visible UI even though the JSON payload
 * still carries it.
 */
describe("<PortalPrivacyScreen /> — web vs mobile share-source chips (Task #1782)", () => {
  it("renders the source split chips with the bucket counts when bySource is present", async () => {
    state.total = 9;
    state.byNative = 6;
    state.byQr = 3;
    state.bySource = { web: 4, mobile: 5 };

    render(<PortalPrivacyScreen />);

    const split = await screen.findByTestId("share-source-split");
    expect(split).toBeInTheDocument();
    const web = screen.getByTestId("share-source-web");
    const mobile = screen.getByTestId("share-source-mobile");
    expect(web).toHaveTextContent(/Web\s*4/);
    expect(mobile).toHaveTextContent(/Mobile\s*5/);
  });

  it("hides the source split row when the share-stats payload omits bySource", async () => {
    // bySource left at null — server returns no `bySource` field at all,
    // mirroring legacy owners with only null-source share history.
    state.total = 2;
    state.byNative = 2;
    state.bySource = null;

    render(<PortalPrivacyScreen />);

    // Wait for the stats block to render so we know the chip-row code
    // path executed and decided to skip rendering.
    expect(await screen.findByTestId("share-stats")).toBeInTheDocument();
    expect(screen.queryByTestId("share-source-split")).toBeNull();
    expect(screen.queryByTestId("share-source-web")).toBeNull();
    expect(screen.queryByTestId("share-source-mobile")).toBeNull();
  });

  it("hides the source split row when bySource is present but both buckets are 0", async () => {
    state.total = 5;
    state.byNative = 5;
    state.bySource = { web: 0, mobile: 0 };

    render(<PortalPrivacyScreen />);

    expect(await screen.findByTestId("share-stats")).toBeInTheDocument();
    expect(screen.queryByTestId("share-source-split")).toBeNull();
  });

  it("updates the chip counts after a fresh share is logged", async () => {
    // Start with one web-tagged share already on file and no mobile-tagged
    // shares — the chip row should render with Web 1 / Mobile 0 first.
    state.total = 1;
    state.byNative = 0;
    state.byQr = 0;
    state.bySource = { web: 1, mobile: 0 };

    vi.spyOn(Share, "share").mockResolvedValue({
      action: Share.sharedAction,
    } as Awaited<ReturnType<typeof Share.share>>);

    render(<PortalPrivacyScreen />);

    let web = await screen.findByTestId("share-source-web");
    let mobile = screen.getByTestId("share-source-mobile");
    expect(web).toHaveTextContent(/Web\s*1/);
    expect(mobile).toHaveTextContent(/Mobile\s*0/);

    // Trigger a fresh source="mobile" native_share. The mocked POST
    // handler bumps state.bySource.mobile, and the post-share stats
    // refresh re-reads the payload — the chip should reflect the new
    // count.
    const shareBtn = await screen.findByTestId("share-button");
    await act(async () => {
      fireEvent.click(shareBtn);
    });

    await waitFor(() => {
      mobile = screen.getByTestId("share-source-mobile");
      expect(mobile).toHaveTextContent(/Mobile\s*1/);
    });
    web = screen.getByTestId("share-source-web");
    expect(web).toHaveTextContent(/Web\s*1/);
  });
});
