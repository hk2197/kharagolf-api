/**
 * Task #2151 — Lock down the actionable copy that the portal Privacy
 * page renders for each social-link error code returned by
 *   POST /api/portal/me/social-links/:provider
 *
 * Background: Task #1735 added stable error codes from the route
 * (documented in `artifacts/api-server/src/routes/wave3.ts`) and mapped
 * each to actionable copy via `linkErrorMessageFor`. The API contract
 * itself is pinned by the integration test
 *   `artifacts/api-server/src/tests/portal-social-links.test.ts`
 * but the UI mapping had no automated coverage. A single misplaced
 * switch case would silently fall through to the generic
 * "Could not link" copy and players would lose the actionable hint
 * (e.g. "Verify your Google email first" → "Could not link Google").
 *
 * This file mounts <PortalPrivacyPage>, drives the Google + Apple link
 * flows by stubbing the GIS/AppleID JS SDKs, and asserts the rendered
 * banner copy for every documented error code as well as the network
 * failure (fetch-rejection) path.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// `import.meta.env.VITE_*` constants in `privacy.tsx` are evaluated when
// the module is imported, so the env stubs must be in place BEFORE the
// import statement runs. `vi.hoisted` lifts these `vi.stubEnv` calls
// above the (otherwise hoisted) import declarations, and Vitest's
// `stubEnv` mirrors values into both `process.env` and `import.meta.env`
// without needing a type-system escape hatch.
vi.hoisted(() => {
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-google-client-id");
  vi.stubEnv("VITE_APPLE_SERVICES_ID", "test-apple-services-id");
  vi.stubEnv("VITE_APPLE_REDIRECT_URI", "https://example.test/portal/privacy");
});

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
  useLocation: () => ["/portal/privacy", () => {}],
}));

import PortalPrivacyPage from "../privacy";

type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> | Response;

let googleLinkCallback: ((response: { credential?: string }) => void) | null = null;
let appleSignIn: () => Promise<unknown> = async () => ({});
let postLinkHandler: FetchHandler | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch() {
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
      if (!postLinkHandler) {
        return jsonResponse({ error: "no_handler_configured" }, 500);
      }
      return postLinkHandler(input, init);
    }

    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

beforeEach(() => {
  localStorage.setItem("portal_jwt", "test-jwt");
  postLinkHandler = null;
  googleLinkCallback = null;
  appleSignIn = vi.fn();

  // `loadScriptOnce` short-circuits when an element with the given id
  // already exists in the DOM, so pre-creating the script tags lets the
  // promise resolve synchronously without making a real network call to
  // accounts.google.com / appleid.cdn-apple.com.
  for (const id of ["google-gsi-script", "apple-auth-script"]) {
    if (!document.getElementById(id)) {
      const s = document.createElement("script");
      s.id = id;
      document.head.appendChild(s);
    }
  }

  (window as unknown as { google: unknown }).google = {
    accounts: {
      id: {
        initialize: (config: { callback: (response: { credential?: string }) => void }) => {
          googleLinkCallback = config.callback;
        },
        renderButton: () => {
          /* The real GIS SDK injects an iframe button here; tests trigger
             the configured callback directly (see `triggerGoogleLink`),
             which is the same code path the iframe exercises. */
        },
      },
    },
  };

  (window as unknown as { AppleID: unknown }).AppleID = {
    auth: {
      init: () => {},
      signIn: () => appleSignIn(),
    },
  };

  installFetch();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const id of ["google-gsi-script", "apple-auth-script"]) {
    document.getElementById(id)?.remove();
  }
  delete (window as unknown as { google?: unknown }).google;
  delete (window as unknown as { AppleID?: unknown }).AppleID;
});

async function mountAndWaitForLinkSection() {
  render(<PortalPrivacyPage />);
  await screen.findByTestId("link-account-section");
  // The GIS init effect runs in a microtask after `socialLinks` lands;
  // wait for the captured callback before triggering it.
  await waitFor(() => expect(googleLinkCallback).not.toBeNull());
}

async function triggerGoogleLink() {
  await act(async () => {
    googleLinkCallback?.({ credential: "fake-google-id-token" });
  });
}

async function triggerAppleLink() {
  appleSignIn = vi.fn().mockResolvedValue({
    authorization: { id_token: "fake-apple-id-token", code: "fake-code" },
    user: undefined,
  });
  const btn = screen.getByTestId("link-apple-button");
  await act(async () => {
    fireEvent.click(btn);
  });
}

interface ErrorCase {
  code: string;
  status: number;
  expected: RegExp;
}

const GOOGLE_CASES: ErrorCase[] = [
  { code: "token_required", status: 400, expected: /Google didn't return a sign-in token\. Please try linking again\./i },
  { code: "token_invalid", status: 401, expected: /We couldn't verify your Google sign-in\. The token may have expired — please try again\./i },
  { code: "email_not_verified", status: 401, expected: /Your Google email isn't verified yet\. Verify it with Google, then try linking again\./i },
  { code: "provider_not_configured", status: 503, expected: /Google sign-in isn't set up on this server\. Please contact KHARAGOLF support\./i },
  { code: "provider_already_linked", status: 409, expected: /This Google account is already linked to a different KHARAGOLF account\./i },
];

const APPLE_CASES: ErrorCase[] = [
  { code: "token_required", status: 400, expected: /Apple didn't return a sign-in token\. Try again and choose "Share My Email" when prompted\./i },
  { code: "token_invalid", status: 401, expected: /We couldn't verify your Apple sign-in\. The token may have expired — please try again\./i },
  { code: "email_not_verified", status: 401, expected: /Your Apple email isn't verified yet\. Verify it with Apple, then try linking again\./i },
  { code: "provider_not_configured", status: 503, expected: /Apple sign-in isn't set up on this server\. Please contact KHARAGOLF support\./i },
  { code: "provider_already_linked", status: 409, expected: /This Apple ID is already linked to a different KHARAGOLF account\./i },
];

describe("<PortalPrivacyPage /> link-error banner copy (Task #2151)", () => {
  for (const c of GOOGLE_CASES) {
    it(`Google → ${c.code} renders the matching banner copy`, async () => {
      postLinkHandler = () => jsonResponse({ error: c.code }, c.status);
      await mountAndWaitForLinkSection();
      await triggerGoogleLink();
      const banner = await screen.findByTestId("linked-accounts-error");
      expect(banner.textContent ?? "").toMatch(c.expected);
    });
  }

  for (const c of APPLE_CASES) {
    it(`Apple → ${c.code} renders the matching banner copy`, async () => {
      postLinkHandler = () => jsonResponse({ error: c.code }, c.status);
      await mountAndWaitForLinkSection();
      await triggerAppleLink();
      const banner = await screen.findByTestId("linked-accounts-error");
      expect(banner.textContent ?? "").toMatch(c.expected);
    });
  }

  it("Google network failure surfaces the offline-style banner", async () => {
    postLinkHandler = () => {
      throw new Error("offline");
    };
    await mountAndWaitForLinkSection();
    await triggerGoogleLink();
    const banner = await screen.findByTestId("linked-accounts-error");
    expect(banner.textContent ?? "").toMatch(
      /We couldn't reach KHARAGOLF to link Google\. Check your connection and try again\./i,
    );
  });

  it("Apple network failure surfaces the offline-style banner", async () => {
    postLinkHandler = () => {
      throw new Error("offline");
    };
    await mountAndWaitForLinkSection();
    await triggerAppleLink();
    const banner = await screen.findByTestId("linked-accounts-error");
    expect(banner.textContent ?? "").toMatch(
      /We couldn't reach KHARAGOLF to link Apple\. Check your connection and try again\./i,
    );
  });

  it("falls back to the generic copy for an unknown error code", async () => {
    postLinkHandler = () => jsonResponse({ error: "weird_unknown_error" }, 418);
    await mountAndWaitForLinkSection();
    await triggerGoogleLink();
    const banner = await screen.findByTestId("linked-accounts-error");
    expect(banner.textContent ?? "").toMatch(/Could not link Google\. Please try again\./i);
  });

  it("prefers the server-supplied detail over the default copy when present", async () => {
    postLinkHandler = () =>
      jsonResponse(
        { error: "provider_already_linked", detail: "Already linked to maria@example.com" },
        409,
      );
    await mountAndWaitForLinkSection();
    await triggerGoogleLink();
    const banner = await screen.findByTestId("linked-accounts-error");
    expect(banner.textContent ?? "").toMatch(/Already linked to maria@example\.com/);
  });
});
