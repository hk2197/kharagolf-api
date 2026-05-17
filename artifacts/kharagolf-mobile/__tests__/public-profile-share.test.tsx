/**
 * Component test: mobile public-profile viewer share buttons (Task #1243).
 *
 * The KHARAGOLF mobile app exposes a public-profile viewer at
 * `app/profile/[handle].tsx`. When a visitor uses Copy / native Share /
 * QR from that screen, the app must POST
 *   /api/public/p/:handle/share-events
 * with `{ method, source: "mobile" }` so the social-proof "Shared N
 * times" badge counts native mobile share traffic alongside the website
 * traffic added in Task #1083.
 *
 * The server-side contract for the endpoint (method validation, source
 * whitelist, rate-limiting) is covered against the live PostgreSQL test
 * DB by artifacts/api-server/src/tests/profile-share-events.test.ts.
 * This test guards the mobile UI against silently dropping the
 * `source: "mobile"` tag, which would skew the dashboard back toward
 * web-only data.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  router: { back: vi.fn(), replace: vi.fn(), push: vi.fn() },
  useLocalSearchParams: () => ({ handle: "share-tester" }),
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

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => true),
}));

import { Share } from "react-native";
import * as Clipboard from "expo-clipboard";
import PublicProfileScreen from "../app/profile/[handle]";

interface ShareEventBody { method: string; source: string }

interface FetchState {
  shareEventCalls: ShareEventBody[];
  shareStatsCalls: number;
  total: number;
}

let state: FetchState;

const PROFILE_BODY = {
  handle: "share-tester",
  displayName: "Share Tester",
  profileImage: null,
  bio: "Plays Sunday singles.",
  location: "Bay Area, CA",
  homeClub: { name: "Pebble Beach", slug: "pebble-beach" },
  memberSince: "2023-04-01T00:00:00.000Z",
  privacy: {
    showHandicap: true,
    showRecentRounds: true,
    showAchievements: true,
    showFavoriteCourses: true,
  },
  currentHandicap: 8.4,
  recentRounds: [],
  achievements: [],
  favoriteCourses: [],
};

function installFetch() {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/api/public/p/share-tester") && method === "GET") {
      return new Response(JSON.stringify(PROFILE_BODY), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/api/public/p/share-tester/share-stats") && method === "GET") {
      state.shareStatsCalls += 1;
      return new Response(JSON.stringify({ handle: "share-tester", total: state.total }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/api/public/p/share-tester/share-events") && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}") as ShareEventBody;
      state.shareEventCalls.push(body);
      state.total += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 201, headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

beforeEach(() => {
  state = { shareEventCalls: [], shareStatsCalls: 0, total: 0 };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<PublicProfileScreen /> — mobile public-profile share analytics (Task #1243)", () => {
  it("renders the loaded profile with share buttons", async () => {
    render(<PublicProfileScreen />);
    expect(await screen.findByTestId("profile-name")).toHaveTextContent("Share Tester");
    expect(screen.getByTestId("share-card")).toBeInTheDocument();
    expect(screen.getByTestId("share-copy")).toBeInTheDocument();
    expect(screen.getByTestId("share-native")).toBeInTheDocument();
    expect(screen.getByTestId("share-qr")).toBeInTheDocument();
    // Initial share-stats fetch happened on mount.
    await waitFor(() => expect(state.shareStatsCalls).toBeGreaterThanOrEqual(1));
  });

  it("tapping Copy link copies the kharagolf.com URL and POSTs method=copy / source=mobile", async () => {
    render(<PublicProfileScreen />);
    const copyBtn = await screen.findByTestId("share-copy");
    const statsBefore = state.shareStatsCalls;

    await act(async () => { fireEvent.click(copyBtn); });

    await waitFor(() =>
      expect(Clipboard.setStringAsync).toHaveBeenCalledWith("https://kharagolf.com/p/share-tester"),
    );
    await waitFor(() => expect(state.shareEventCalls.length).toBe(1));
    expect(state.shareEventCalls[0]).toEqual({ method: "copy", source: "mobile" });
    await waitFor(() => expect(state.shareStatsCalls).toBeGreaterThan(statsBefore));
  });

  it("tapping Share opens the native share sheet and POSTs method=native_share / source=mobile", async () => {
    const shareSpy = vi.spyOn(Share, "share").mockResolvedValue({
      action: Share.sharedAction,
    } as Awaited<ReturnType<typeof Share.share>>);

    render(<PublicProfileScreen />);
    const shareBtn = await screen.findByTestId("share-native");
    const statsBefore = state.shareStatsCalls;

    await act(async () => { fireEvent.click(shareBtn); });

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const arg = shareSpy.mock.calls[0][0] as { url?: string; message?: string };
    expect(arg.url).toBe("https://kharagolf.com/p/share-tester");
    expect(arg.message).toMatch(/share-tester/);

    await waitFor(() => expect(state.shareEventCalls.length).toBe(1));
    expect(state.shareEventCalls[0]).toEqual({ method: "native_share", source: "mobile" });
    await waitFor(() => expect(state.shareStatsCalls).toBeGreaterThan(statsBefore));
  });

  it("does NOT log a share when the user dismisses the native share sheet", async () => {
    const shareSpy = vi.spyOn(Share, "share").mockResolvedValue({
      action: Share.dismissedAction,
    } as Awaited<ReturnType<typeof Share.share>>);

    render(<PublicProfileScreen />);
    const shareBtn = await screen.findByTestId("share-native");
    await act(async () => { fireEvent.click(shareBtn); });

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 30));
    expect(state.shareEventCalls.length).toBe(0);
  });

  it("tapping QR opens the QR modal and POSTs method=qr_open / source=mobile", async () => {
    render(<PublicProfileScreen />);
    const qrBtn = await screen.findByTestId("share-qr");
    const statsBefore = state.shareStatsCalls;

    await act(async () => { fireEvent.click(qrBtn); });

    const qr = await screen.findByTestId("qr-svg");
    expect(qr.getAttribute("data-value")).toBe("https://kharagolf.com/p/share-tester");

    await waitFor(() => expect(state.shareEventCalls.length).toBe(1));
    expect(state.shareEventCalls[0]).toEqual({ method: "qr_open", source: "mobile" });
    await waitFor(() => expect(state.shareStatsCalls).toBeGreaterThan(statsBefore));
  });

  it("share POST is unauthenticated (no Authorization header) — visitor flow, not portal", async () => {
    render(<PublicProfileScreen />);
    const copyBtn = await screen.findByTestId("share-copy");
    await act(async () => { fireEvent.click(copyBtn); });
    await waitFor(() => expect(state.shareEventCalls.length).toBe(1));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const postCall = fetchMock.mock.calls.find(c => {
      const url = String(c[0]);
      const method = ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      return url.endsWith("/api/public/p/share-tester/share-events") && method === "POST";
    });
    expect(postCall).toBeDefined();
    const headers = (postCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBeUndefined();
  });

  it("renders 'Profile not found' when the API returns 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch);
    render(<PublicProfileScreen />);
    expect(await screen.findByText(/profile not found/i)).toBeInTheDocument();
  });
});
