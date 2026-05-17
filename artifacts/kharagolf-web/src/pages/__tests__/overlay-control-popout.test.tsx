/**
 * UI test: "Pop out" button on the producer overlay control panel (Task #656).
 *
 * Verifies that <OverlayControlPage /> renders a "Pop out" button next to the
 * embedded live preview when a tournament is selected, that clicking it calls
 * window.open with the preview URL (`/overlay/:id?safe=1080&preview=1`) and
 * 16:9 sizing, and that a blocked popup surfaces a destructive toast.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

let state: OverlayState;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/organizations/42/tournaments")) {
      return new Response(JSON.stringify([
        { id: 7, name: "Spring Open", status: "active" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    if (url.endsWith("/api/organizations/42/tournaments/7/overlay-state") && (!init || init.method === undefined || init.method === "GET")) {
      return new Response(JSON.stringify(state), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/tee-times") || url.includes("/players")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  toastMock.mockReset();
  FakeEventSource.reset();
  state = makeState();
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

describe("<OverlayControlPage /> — pop-out preview button", () => {
  it("renders the 'Pop out' button next to the live preview when a tournament is selected", async () => {
    render(<OverlayControlPage />);

    // Wait for the preview iframe (only renders once tournament + state load)
    await screen.findByTestId("iframe-overlay-preview");

    const button = screen.getByTestId("button-popout-preview");
    expect(button).toBeInTheDocument();
    expect(button.tagName).toBe("BUTTON");
    expect(button.textContent).toContain("Pop out");
  });

  it("clicking 'Pop out' calls window.open with the preview URL and 16:9 sizing", async () => {
    const user = userEvent.setup();
    const openSpy = vi.fn(() => ({ focus: vi.fn() } as unknown as Window));
    vi.spyOn(window, "open").mockImplementation(openSpy as unknown as typeof window.open);

    render(<OverlayControlPage />);
    await screen.findByTestId("iframe-overlay-preview");

    await user.click(screen.getByTestId("button-popout-preview"));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target, features] = openSpy.mock.calls[0] as [string, string, string];

    // Preview URL points at the composite overlay route for the tournament,
    // with safe-area + preview flags
    expect(url).toMatch(/\/overlay\/7\?/);
    expect(url).toContain("safe=1080");
    expect(url).toContain("preview=1");

    // Window has a stable per-tournament name so reusing it focuses the same window
    expect(target).toBe("overlay-preview-7");

    // 16:9 sizing (1280x720)
    expect(features).toContain("width=1280");
    expect(features).toContain("height=720");
    const widthMatch = features.match(/width=(\d+)/);
    const heightMatch = features.match(/height=(\d+)/);
    expect(widthMatch).not.toBeNull();
    expect(heightMatch).not.toBeNull();
    const width = Number(widthMatch![1]);
    const height = Number(heightMatch![1]);
    // 16:9 ratio
    expect(width / height).toBeCloseTo(16 / 9, 2);

    // Borderless / chromeless window features
    expect(features).toContain("menubar=no");
    expect(features).toContain("toolbar=no");
    expect(features).toContain("location=no");
    expect(features).toContain("status=no");
  });

  it("shows a destructive toast when the popup is blocked", async () => {
    const user = userEvent.setup();
    // Simulate the browser blocking the popup → window.open returns null
    vi.spyOn(window, "open").mockImplementation(() => null);

    render(<OverlayControlPage />);
    await screen.findByTestId("iframe-overlay-preview");

    await user.click(screen.getByTestId("button-popout-preview"));

    expect(toastMock).toHaveBeenCalledTimes(1);
    const arg = toastMock.mock.calls[0][0] as { title: string; description?: string; variant?: string };
    expect(arg.variant).toBe("destructive");
    expect(arg.title).toMatch(/popup/i);
  });
});
