/**
 * Task #2151 — Lock down the actionable copy that the mobile portal
 * Privacy screen surfaces via `Alert.alert` for each social-link error
 * code returned by POST /api/portal/me/social-links/:provider.
 *
 * Background: Task #1735 added stable error codes from the route
 * (documented in `artifacts/api-server/src/routes/wave3.ts`) and mapped
 * each to a `{ title, body }` pair via `linkErrorTitleAndBody` in
 * `app/portal-privacy.tsx`. The API contract itself is pinned by
 *   `artifacts/api-server/src/tests/portal-social-links.test.ts`
 * and the matching web mapping is now covered by
 *   `artifacts/kharagolf-web/src/pages/portal/__tests__/portal-privacy-link-errors.test.tsx`.
 * Without this file, a stray switch case in the mobile screen would
 * silently fall through to the generic "Could not link" alert and
 * players on iOS/Android would lose the actionable hint (e.g. the
 * "Verify your email first" / "{Apple|Google} sign-in unavailable"
 * branches).
 *
 * The screen drives Alert.alert from two distinct entry-points:
 *   - `handleLinkApple` calls `AppleAuthentication.signInAsync()`, then
 *     `postLink('apple', …)` which fires the mapped Alert on a non-OK
 *     response (or the offline-style Alert on a fetch rejection).
 *   - `<GoogleLinkButton>` calls `Google.useIdTokenAuthRequest`'s
 *     `promptAsync()`, watches the resulting `googleResponse` with a
 *     useEffect, and either fires its own Alert (for cancel/dismiss/
 *     error/no-token branches) or invokes `postLink('google', …)`
 *     which feeds back into the same mapped Alert path.
 *
 * Both paths share `linkErrorTitleAndBody`, so every error code is
 * exercised through both providers to lock down the per-provider label
 * and per-provider title variants.
 */
import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// `googleConfigured` in `app/portal-privacy.tsx` is computed at module
// load from `process.env.EXPO_PUBLIC_GOOGLE_*_CLIENT_ID`, so the env
// vars must be in place BEFORE the module import runs. `vi.hoisted`
// lifts the assignment above the otherwise-hoisted import declarations.
vi.hoisted(() => {
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = "test-ios-client-id";
  process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID = "test-android-client-id";
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = "test-web-client-id";
});

// ── Hoisted spies & control surfaces ───────────────────────────────────────

const { alertMock, signInAsyncMock, promptGoogleMock, googleResponseRef } = vi.hoisted(() => ({
  alertMock: vi.fn<(title: string, message?: string) => void>(),
  signInAsyncMock: vi.fn(),
  promptGoogleMock: vi.fn(async () => ({ type: "success" as const })),
  // A mutable holder the mocked `useIdTokenAuthRequest` reads on every
  // render — drive Google "responses" by reassigning `.current` and then
  // calling `forceGoogleRerender` (set up below) inside `act`.
  googleResponseRef: { current: null as unknown },
}));

let forceGoogleRerender: (() => void) | null = null;

// ── Module mocks (must precede the screen import) ──────────────────────────

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1, email: "linker@example.com" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("react-native-safe-area-context", () => {
  const ReactInner = require("react") as typeof React;
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      ReactInner.createElement(ReactInner.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

vi.mock("react-native-qrcode-svg", () => {
  const ReactInner = require("react") as typeof React;
  const QRCode = (props: { value?: string }) =>
    ReactInner.createElement("div", { "data-testid": "qr-svg", "data-value": props?.value });
  return { default: QRCode };
});

vi.mock("expo-web-browser", () => ({
  maybeCompleteAuthSession: () => {},
  openAuthSessionAsync: async () => ({ type: "cancel" }),
}));

// `expo-apple-authentication.AppleAuthenticationButton` renders nothing
// on web, so substitute a tappable element that wires `onPress` through
// to a click handler. `signInAsync` is the seam tests drive to deliver
// fake credentials (or to throw cancellation errors) into
// `handleLinkApple`.
vi.mock("expo-apple-authentication", () => {
  const ReactInner = require("react") as typeof React;
  return {
    AppleAuthenticationButton: ({ onPress }: { onPress?: () => void }) =>
      ReactInner.createElement(
        "button",
        { "data-testid": "link-apple-button", onClick: onPress },
        "Link Apple",
      ),
    AppleAuthenticationButtonType: { CONTINUE: 0, SIGN_IN: 1, SIGN_UP: 2 },
    AppleAuthenticationButtonStyle: { WHITE: 0, BLACK: 1, WHITE_OUTLINE: 2 },
    AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
    isAvailableAsync: vi.fn().mockResolvedValue(true),
    signInAsync: signInAsyncMock,
  };
});

// Stand-in for `expo-auth-session/providers/google.useIdTokenAuthRequest`.
// Returns `[request, response, prompt]`. The response is sourced from the
// shared `googleResponseRef.current`; tests advance it by mutating the
// ref and then forcing a re-render of the GoogleLinkButton (which is the
// component that owns the hook). `forceGoogleRerender` is captured here
// so tests can flip the response inside an `act` block.
vi.mock("expo-auth-session/providers/google", () => {
  const ReactInner = require("react") as typeof React;
  return {
    useIdTokenAuthRequest: () => {
      const [, setTick] = ReactInner.useState(0);
      ReactInner.useEffect(() => {
        forceGoogleRerender = () => setTick((t) => t + 1);
        return () => {
          forceGoogleRerender = null;
        };
      }, []);
      return [{}, googleResponseRef.current, promptGoogleMock];
    },
  };
});

// Force `Platform.OS = 'ios'` (so the Apple-availability + Google client
// guards both light up) and route `Alert.alert` to the spy. Importing
// the actual react-native-web module first preserves every other API the
// screen pulls in (StyleSheet, Switch, ScrollView, …).
vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...RN,
    Platform: {
      ...RN.Platform,
      OS: "ios",
      select: <T,>(obj: { ios?: T; android?: T; default?: T; web?: T }) =>
        obj.ios ?? obj.default,
    },
    Alert: { alert: alertMock },
  };
});

// ── Screen under test (after mocks) ────────────────────────────────────────
import PortalPrivacyScreen from "../app/portal-privacy";

// ── Fetch fixture ──────────────────────────────────────────────────────────

type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> | Response;

let postLinkHandler: FetchHandler | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(): Mock {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/api/portal/me/public-profile") && method === "GET") {
      return jsonResponse({
        publicHandle: "linker",
        publicProfileEnabled: false,
        publicShowHandicap: true,
        publicShowRecentRounds: true,
        publicShowAchievements: true,
        publicShowFavoriteCourses: true,
        publicBio: null,
        publicLocation: null,
      });
    }

    if (url.endsWith("/api/portal/me/public-scorecards") && method === "GET") {
      return jsonResponse([]);
    }

    if (url.endsWith("/api/portal/me/public-profile/share-stats") && method === "GET") {
      return jsonResponse({ total: 0, byMethod: {} });
    }

    if (url.endsWith("/api/portal/me/social-links") && method === "GET") {
      return jsonResponse({ hasPassword: true, hasReplitOauth: false, links: [] });
    }

    if (/\/api\/portal\/me\/social-links\/(apple|google)$/.test(url) && method === "POST") {
      if (!postLinkHandler) return jsonResponse({ error: "no_handler_configured" }, 500);
      return postLinkHandler(input, init);
    }

    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

beforeEach(() => {
  postLinkHandler = null;
  alertMock.mockReset();
  signInAsyncMock.mockReset();
  promptGoogleMock.mockReset();
  promptGoogleMock.mockResolvedValue({ type: "success" } as never);
  googleResponseRef.current = null;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function mountAndWaitForLinkSection() {
  render(<PortalPrivacyScreen />);
  // The link-account section is gated on (a) the initial fetch settling
  // and (b) `appleAvailable` resolving from the mocked
  // `isAvailableAsync` Promise. `findByTestId` retries until both have
  // landed.
  await screen.findByTestId("link-account-section");
}

async function triggerAppleLink() {
  signInAsyncMock.mockResolvedValueOnce({
    identityToken: "fake-apple-id-token",
    fullName: null,
  });
  const btn = screen.getByTestId("link-apple-button");
  await act(async () => {
    fireEvent.click(btn);
  });
  // Allow the chained `postLink` promise to resolve so `Alert.alert`
  // is invoked before the assertions run.
  await waitFor(() => expect(alertMock).toHaveBeenCalled());
}

async function triggerGoogleSuccess() {
  // Drive the GoogleLinkButton's useEffect by handing it a "success"
  // response with an id_token, then forcing the hook-owning component
  // to re-render so the new ref value is observed.
  await act(async () => {
    googleResponseRef.current = {
      type: "success",
      params: { id_token: "fake-google-id-token" },
    };
    forceGoogleRerender?.();
  });
  await waitFor(() => expect(alertMock).toHaveBeenCalled());
}

interface ErrorCase {
  code: string;
  status: number;
  expectedTitle: string;
  expectedBody: RegExp;
}

const APPLE_CASES: ErrorCase[] = [
  {
    code: "token_required",
    status: 400,
    expectedTitle: "Couldn't link",
    expectedBody:
      /Apple didn't return a sign-in token\. Try again and choose "Share My Email" when prompted\./i,
  },
  {
    code: "token_invalid",
    status: 401,
    expectedTitle: "Couldn't link",
    expectedBody:
      /We couldn't verify your Apple sign-in\. The token may have expired — please try again\./i,
  },
  {
    code: "email_not_verified",
    status: 401,
    expectedTitle: "Verify your email first",
    expectedBody:
      /Your Apple email isn't verified yet\. Verify it with Apple, then try linking again\./i,
  },
  {
    code: "provider_not_configured",
    status: 503,
    expectedTitle: "Apple sign-in unavailable",
    expectedBody:
      /Apple sign-in isn't set up on this server\. Please contact KHARAGOLF support\./i,
  },
  {
    code: "provider_already_linked",
    status: 409,
    expectedTitle: "Already linked elsewhere",
    expectedBody:
      /This Apple ID is already linked to a different KHARAGOLF account\./i,
  },
];

const GOOGLE_CASES: ErrorCase[] = [
  {
    code: "token_required",
    status: 400,
    expectedTitle: "Couldn't link",
    expectedBody: /Google didn't return a sign-in token\. Please try linking again\./i,
  },
  {
    code: "token_invalid",
    status: 401,
    expectedTitle: "Couldn't link",
    expectedBody:
      /We couldn't verify your Google sign-in\. The token may have expired — please try again\./i,
  },
  {
    code: "email_not_verified",
    status: 401,
    expectedTitle: "Verify your email first",
    expectedBody:
      /Your Google email isn't verified yet\. Verify it with Google, then try linking again\./i,
  },
  {
    code: "provider_not_configured",
    status: 503,
    expectedTitle: "Google sign-in unavailable",
    expectedBody:
      /Google sign-in isn't set up on this server\. Please contact KHARAGOLF support\./i,
  },
  {
    code: "provider_already_linked",
    status: 409,
    expectedTitle: "Already linked elsewhere",
    expectedBody:
      /This Google account is already linked to a different KHARAGOLF account\./i,
  },
];

function lastAlert(): { title: string; body: string } {
  expect(alertMock).toHaveBeenCalled();
  const last = alertMock.mock.calls[alertMock.mock.calls.length - 1];
  return { title: String(last[0] ?? ""), body: String(last[1] ?? "") };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("<PortalPrivacyScreen /> link-error Alert mapping (Task #2151)", () => {
  for (const c of APPLE_CASES) {
    it(`Apple → ${c.code} fires Alert.alert with the matching title + body`, async () => {
      postLinkHandler = () => jsonResponse({ error: c.code }, c.status);
      await mountAndWaitForLinkSection();
      await triggerAppleLink();
      const { title, body } = lastAlert();
      expect(title).toBe(c.expectedTitle);
      expect(body).toMatch(c.expectedBody);
    });
  }

  for (const c of GOOGLE_CASES) {
    it(`Google → ${c.code} fires Alert.alert with the matching title + body`, async () => {
      postLinkHandler = () => jsonResponse({ error: c.code }, c.status);
      await mountAndWaitForLinkSection();
      await triggerGoogleSuccess();
      const { title, body } = lastAlert();
      expect(title).toBe(c.expectedTitle);
      expect(body).toMatch(c.expectedBody);
    });
  }

  it("Apple network failure surfaces the offline-style Alert", async () => {
    postLinkHandler = () => {
      throw new Error("offline");
    };
    await mountAndWaitForLinkSection();
    await triggerAppleLink();
    const { title, body } = lastAlert();
    expect(title).toBe("Couldn't link");
    expect(body).toMatch(
      /We couldn't reach KHARAGOLF to link Apple\. Check your connection and try again\./i,
    );
  });

  it("Google network failure surfaces the offline-style Alert", async () => {
    postLinkHandler = () => {
      throw new Error("offline");
    };
    await mountAndWaitForLinkSection();
    await triggerGoogleSuccess();
    const { title, body } = lastAlert();
    expect(title).toBe("Couldn't link");
    expect(body).toMatch(
      /We couldn't reach KHARAGOLF to link Google\. Check your connection and try again\./i,
    );
  });

  it("falls back to the generic copy for an unknown error code (via Apple)", async () => {
    postLinkHandler = () => jsonResponse({ error: "weird_unknown_error" }, 418);
    await mountAndWaitForLinkSection();
    await triggerAppleLink();
    const { title, body } = lastAlert();
    expect(title).toBe("Couldn't link");
    expect(body).toMatch(/Could not link Apple\. Please try again\./i);
  });

  it("prefers the server-supplied detail over the default copy when present", async () => {
    postLinkHandler = () =>
      jsonResponse(
        { error: "provider_already_linked", detail: "Already linked to maria@example.com" },
        409,
      );
    await mountAndWaitForLinkSection();
    await triggerAppleLink();
    const { title, body } = lastAlert();
    expect(title).toBe("Already linked elsewhere");
    expect(body).toMatch(/Already linked to maria@example\.com/);
  });
});
