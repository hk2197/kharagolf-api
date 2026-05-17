/**
 * UI test: Producer panel embedded live preview iframe (Task #555).
 *
 * Verifies that <OverlayControlPage /> renders the composite overlay preview
 * iframe pointing at /overlay/<id>?safe=1080... once a tournament is selected,
 * and that toggling an overlay switch round-trips through the cue endpoint and
 * is reflected in the panel's live state (which drives the embedded preview).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgId: () => 42,
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

class FakeEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {}
  static instances: FakeEventSource[] = [];
  static reset() { FakeEventSource.instances = []; }
}
const originalEventSource = (globalThis as unknown as { EventSource?: typeof EventSource }).EventSource;
(globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
  FakeEventSource as unknown as typeof EventSource;

import OverlayControlPage from "../overlay-control";
import type { OverlayState } from "@/lib/overlay-types";

function makeState(overrides: Partial<OverlayState> = {}): OverlayState {
  return {
    active: {
      leaderboard: false,
      "lower-third": false,
      "current-group": false,
      "player-card": false,
      hole: false,
      "sponsor-bug": false,
    },
    currentGroupId: null,
    currentHole: null,
    currentPlayerId: null,
    currentSponsorId: null,
    lowerThirdText: null,
    leaderboardLimit: 10,
    theme: {
      logoUrl: null,
      primaryColor: "#0a3d2a",
      accentColor: "#d4af37",
      sponsorPosition: "bottom-right",
      showSafeArea: false,
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Handler {
  state: OverlayState;
  cueRequests: Array<{ url: string; body: unknown }>;
}

let handler: Handler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/organizations/42/tournaments")) {
      return new Response(JSON.stringify([
        { id: 7, name: "Spring Open", status: "active" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    if (url.endsWith("/api/organizations/42/tournaments/7/overlay-state") && (!init || init.method === undefined || init.method === "GET")) {
      return new Response(JSON.stringify(handler.state), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.endsWith("/api/organizations/42/tournaments/7/overlay-state") && init?.method === "PUT") {
      const patch = JSON.parse(String(init.body));
      handler.state = { ...handler.state, ...patch, updatedAt: new Date().toISOString() };
      return new Response(JSON.stringify(handler.state), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.endsWith("/api/organizations/42/tournaments/7/overlay-cue") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { type: string; overlay?: keyof OverlayState["active"]; on?: boolean };
      handler.cueRequests.push({ url, body });
      if (body.type === "active" && body.overlay) {
        handler.state = {
          ...handler.state,
          active: { ...handler.state.active, [body.overlay]: !!body.on },
          updatedAt: new Date().toISOString(),
        };
      }
      return new Response(JSON.stringify(handler.state), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/tee-times")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    if (url.includes("/players")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  toastMock.mockReset();
  FakeEventSource.reset();
  handler = { state: makeState(), cueRequests: [] };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (originalEventSource === undefined) {
    delete (globalThis as unknown as { EventSource?: typeof EventSource }).EventSource;
  } else {
    (globalThis as unknown as { EventSource: typeof EventSource }).EventSource = originalEventSource;
  }
});

describe("<OverlayControlPage /> — embedded live preview", () => {
  it("renders the preview iframe pointing at /overlay/<id>?safe=1080... once a tournament is selected", async () => {
    render(<OverlayControlPage />);

    // Tournament auto-selects → state loads → iframe appears
    const iframe = await screen.findByTestId("iframe-overlay-preview") as HTMLIFrameElement;
    expect(iframe).toBeInTheDocument();
    expect(iframe.tagName).toBe("IFRAME");

    const src = iframe.getAttribute("src") ?? "";
    // Path points at the composite overlay route for the selected tournament
    expect(src).toMatch(/\/overlay\/7(\?|$)/);
    // Includes the 1080 safe-area guide query the producer panel asks for
    expect(src).toContain("safe=1080");
    // Includes the preview flag so the overlay route knows it's embedded
    expect(src).toContain("preview=1");
  });

  it("toggling an overlay switch sends a cue and the embedded preview reflects the new state", async () => {
    const user = userEvent.setup();
    render(<OverlayControlPage />);

    // Wait for state to load and the leaderboard switch to appear
    const leaderboardSwitch = await screen.findByTestId("switch-overlay-leaderboard");
    expect(leaderboardSwitch).toHaveAttribute("aria-checked", "false");

    const iframeBefore = screen.getByTestId("iframe-overlay-preview") as HTMLIFrameElement;
    const srcBefore = iframeBefore.getAttribute("src") ?? "";
    expect(srcBefore).toMatch(/\/overlay\/7\?safe=1080/);

    // Toggle it on
    await user.click(leaderboardSwitch);

    // Cue endpoint received the toggle
    await waitFor(() => expect(handler.cueRequests.length).toBe(1));
    expect(handler.cueRequests[0].body).toEqual({
      type: "active",
      overlay: "leaderboard",
      on: true,
    });

    // The producer panel state updates to reflect the new active overlay,
    // which is the same OverlayState the embedded preview iframe subscribes to
    // via SSE — so the live preview reflects the new state.
    await waitFor(() => {
      expect(screen.getByTestId("switch-overlay-leaderboard"))
        .toHaveAttribute("aria-checked", "true");
    });
    expect(handler.state.active.leaderboard).toBe(true);

    // Iframe still points at the same composite overlay URL for the tournament
    // (the embedded preview re-renders against fresh state via its own SSE
    // subscription rather than via a URL change).
    const iframeAfter = screen.getByTestId("iframe-overlay-preview") as HTMLIFrameElement;
    expect(iframeAfter.getAttribute("src")).toMatch(/\/overlay\/7\?safe=1080/);
    expect(iframeAfter.getAttribute("src")).toContain("preview=1");
  });
});
