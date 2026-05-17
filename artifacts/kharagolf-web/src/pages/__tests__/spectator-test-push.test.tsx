/**
 * Task #1084 — UI test for the spectator page "Send test notification"
 * button (added in Task #941). Mounts the live SpectatorPage with stubbed
 * fetch + EventSource and verifies that each server response branch
 * (delivered, no_device_token, 429 rate-limited, 401 login-required)
 * surfaces the right localised status string and that the request
 * envelope sent to /api/portal/spectator-test-push includes the spectator's
 * currently active i18n language as a `lang` override.
 *
 * The endpoint contract itself (auth, lang fallback, rate limit, device-
 * token branches) is covered against the live PostgreSQL test DB by
 * artifacts/api-server/src/tests/spectator-test-push.test.ts.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import i18n from "@/i18n";

vi.mock("wouter", () => ({
  useParams: () => ({ tournamentId: "1" }),
}));

vi.mock("@/components/AdSlot", () => ({
  default: () => <div data-testid="adslot-stub" />,
}));

vi.mock("@/components/LiveOddsWidget", () => ({
  default: () => <div data-testid="odds-stub" />,
}));

class FakeEventSource {
  url: string;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  readyState = 1;
  withCredentials = false;
  CONNECTING = 0; OPEN = 1; CLOSED = 2;
  constructor(url: string) {
    this.url = url;
  }
  close() { this.readyState = 2; }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
}

const FAKE_LEADERBOARD = {
  tournamentId: 1, tournamentName: "Test Open", format: "stroke",
  coursePar: 72, rounds: 1, lastUpdated: new Date().toISOString(),
  entries: [], netEntries: [], byFlight: {}, flights: [],
  organizationName: "Test Club", organizationLogoUrl: null,
  organizationPrimaryColor: "#22c55e", leaderboardType: "gross",
};

type TestPushResponse = {
  status: number;
  body: Record<string, unknown>;
};

interface InstallOpts {
  testPushResponse: TestPushResponse;
}

const testPushCalls: Array<{ body: Record<string, unknown> }> = [];

function installFetch({ testPushResponse }: InstallOpts) {
  testPushCalls.length = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/portal/spectator-test-push")) {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      testPushCalls.push({ body });
      return new Response(JSON.stringify(testPushResponse.body), {
        status: testPushResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/leaderboard") && !url.includes("/stream")) {
      return new Response(JSON.stringify(FAKE_LEADERBOARD), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/notable-events")) {
      return new Response(JSON.stringify({ events: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/pace-board")) {
      return new Response(JSON.stringify({ groups: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/tee-sheet")) {
      return new Response(JSON.stringify([]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    // Catch-all empty success so background polls don't error.
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
}

beforeEach(async () => {
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  // Default to English so each test can opt into a different language.
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountAndWaitForButton() {
  const SpectatorPage = (await import("../spectator")).default;
  render(<SpectatorPage />);
  return await screen.findByTestId("button-spectator-test-push");
}

describe("SpectatorPage — Send test notification button (Task #941)", () => {
  it("renders the localised button label and posts the active language as `lang`", async () => {
    installFetch({
      testPushResponse: {
        status: 200,
        body: {
          delivered: true, sent: 1, failed: 0, invalid: 0,
          language: "fr",
          preview: { title: "🐦 Birdie", body: "Jin a fait birdie au trou 7." },
        },
      },
    });
    await act(async () => { await i18n.changeLanguage("fr"); });

    const button = await mountAndWaitForButton();
    expect(button.textContent).toContain("Envoyer une notification test");

    await userEvent.click(button);

    await waitFor(() => expect(testPushCalls.length).toBe(1));
    expect(testPushCalls[0]!.body).toMatchObject({ eventType: "birdie", lang: "fr" });

    const status = await screen.findByTestId("status-spectator-test-push");
    expect(status.textContent).toContain("Notification test envoyée");
    // The previewed copy is also rendered inside the status card.
    expect(status.textContent).toContain("Jin a fait birdie au trou 7.");
  });

  it("shows the localised 'no device registered' status for the no_device_token branch", async () => {
    installFetch({
      testPushResponse: {
        status: 200,
        body: {
          delivered: false, reason: "no_device_token",
          language: "en",
          preview: { title: "🐦 Birdie", body: "Alex made birdie on hole 7." },
        },
      },
    });

    const button = await mountAndWaitForButton();
    await userEvent.click(button);

    const status = await screen.findByTestId("status-spectator-test-push");
    await waitFor(() => expect(status.textContent).toContain("No device registered"));
    expect(status.textContent).toContain("Alex made birdie on hole 7.");
  });

  it("shows the localised rate-limit status (with remaining seconds) on a 429", async () => {
    installFetch({
      testPushResponse: {
        status: 429,
        body: { error: "Too many test notifications.", retryAfterSeconds: 17 },
      },
    });

    const button = await mountAndWaitForButton();
    await userEvent.click(button);

    const status = await screen.findByTestId("status-spectator-test-push");
    await waitFor(() => expect(status.textContent).toContain("Please wait 17s"));
  });

  it("shows the localised login-required status on a 401", async () => {
    installFetch({
      testPushResponse: {
        status: 401,
        body: { error: "Unauthorized" },
      },
    });

    const button = await mountAndWaitForButton();
    await userEvent.click(button);

    const status = await screen.findByTestId("status-spectator-test-push");
    await waitFor(() =>
      expect(status.textContent).toContain("Sign in as a member to send a test notification"),
    );
  });
});
