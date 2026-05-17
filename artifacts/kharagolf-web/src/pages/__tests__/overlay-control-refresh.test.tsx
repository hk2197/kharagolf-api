/**
 * Task #1027 — Cover the cue sheet refresh action with automated tests.
 *
 * UI test for the producer panel's "Update from current" button on a saved
 * cue sheet row. Verifies that:
 *
 *   1. Clicking the button issues a PUT to the overlay-templates endpoint
 *      with the live overlay state in the request body.
 *   2. The row's "Updated …" label moves forward after a successful refresh
 *      (the FE re-fetches the templates list and re-renders the row).
 *   3. A non-200 response surfaces a destructive toast and the timestamp
 *      stays put.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
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
      leaderboard: true,
      "lower-third": false,
      "current-group": false,
      "player-card": false,
      hole: false,
      "sponsor-bug": false,
    },
    currentGroupId: null,
    currentHole: 5,
    currentPlayerId: null,
    currentSponsorId: null,
    lowerThirdText: "Front nine",
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

interface SavedTemplate {
  id: number;
  name: string;
  state: OverlayState;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Handler {
  state: OverlayState;
  templates: SavedTemplate[];
  refreshRequests: Array<{ url: string; body: unknown }>;
  refreshShouldFail: boolean;
}

let handler: Handler;

const TEMPLATE_ID = 91;
const INITIAL_UPDATED_AT = "2026-04-22T10:00:00.000Z";

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url.endsWith("/api/organizations/42/tournaments")) {
      return new Response(JSON.stringify([
        { id: 7, name: "Spring Open", status: "active" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    if (url.endsWith("/api/organizations/42/tournaments/7/overlay-state") && method === "GET") {
      return new Response(JSON.stringify(handler.state), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.endsWith("/api/organizations/42/tournaments/7/overlay-templates") && method === "GET") {
      return new Response(JSON.stringify({ templates: handler.templates }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.endsWith(`/api/organizations/42/tournaments/7/overlay-templates/${TEMPLATE_ID}`) && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      handler.refreshRequests.push({ url, body });
      if (handler.refreshShouldFail) {
        return new Response(JSON.stringify({ error: "Backend exploded" }), {
          status: 500, headers: { "Content-Type": "application/json" },
        }) as unknown as Response;
      }
      const tpl = handler.templates.find((t) => t.id === TEMPLATE_ID)!;
      tpl.state = (body.state as OverlayState) ?? tpl.state;
      // Bump updatedAt forward by a clearly visible amount so the
      // "Updated …" label demonstrably changes after the refresh.
      tpl.updatedAt = new Date(Date.parse(tpl.updatedAt) + 60 * 60 * 1000).toISOString();
      return new Response(JSON.stringify(tpl), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.includes("/tee-times") || url.includes("/players")) {
      return new Response(JSON.stringify([]), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  toastMock.mockReset();
  FakeEventSource.reset();
  handler = {
    state: makeState(),
    templates: [
      {
        id: TEMPLATE_ID,
        name: "Hole 17 amen corner",
        state: makeState({ currentHole: 17, lowerThirdText: "Amen Corner" }),
        createdByUserId: null,
        createdAt: INITIAL_UPDATED_AT,
        updatedAt: INITIAL_UPDATED_AT,
      },
    ],
    refreshRequests: [],
    refreshShouldFail: false,
  };
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

describe("<OverlayControlPage /> — 'Update from current' on a saved cue sheet", () => {
  it("PUTs the live state, then bumps the row's 'Updated …' label forward", async () => {
    const user = userEvent.setup();
    render(<OverlayControlPage />);

    const refreshBtn = await screen.findByTestId(`button-refresh-${TEMPLATE_ID}`);
    expect(refreshBtn).toBeInTheDocument();

    const row = screen.getByTestId(`row-template-${TEMPLATE_ID}`);
    const initialLabel = within(row).getByText(/Updated /).textContent ?? "";
    // Sanity: the initial label matches the seeded server timestamp.
    expect(initialLabel).toContain(new Date(INITIAL_UPDATED_AT).toLocaleString());

    await user.click(refreshBtn);

    // Exactly one PUT, with `{ state }` as the body — i.e. the live cue
    // state captured from the panel, not just an empty payload.
    await waitFor(() => expect(handler.refreshRequests).toHaveLength(1));
    const req = handler.refreshRequests[0];
    expect(req.url).toContain(`/overlay-templates/${TEMPLATE_ID}`);
    const body = req.body as { state?: OverlayState };
    expect(body.state).toBeTruthy();
    expect(body.state!.currentHole).toBe(handler.state.currentHole);
    expect(body.state!.lowerThirdText).toBe(handler.state.lowerThirdText);
    expect(body.state!.active.leaderboard).toBe(handler.state.active.leaderboard);

    // Success toast.
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    const toastArg = toastMock.mock.calls[0][0] as { title: string; variant?: string };
    expect(toastArg.variant).not.toBe("destructive");
    expect(toastArg.title).toMatch(/updated/i);

    // Row's "Updated …" label moves forward.
    await waitFor(() => {
      const refreshedRow = screen.getByTestId(`row-template-${TEMPLATE_ID}`);
      const refreshedLabel = within(refreshedRow).getByText(/Updated /).textContent ?? "";
      expect(refreshedLabel).not.toBe(initialLabel);
      expect(refreshedLabel).toContain(
        new Date(handler.templates[0].updatedAt).toLocaleString(),
      );
    });
  });

  it("surfaces a destructive toast when the refresh PUT fails, and the timestamp does not move", async () => {
    handler.refreshShouldFail = true;
    const user = userEvent.setup();
    render(<OverlayControlPage />);

    const row = await screen.findByTestId(`row-template-${TEMPLATE_ID}`);
    const initialLabel = within(row).getByText(/Updated /).textContent ?? "";

    await user.click(screen.getByTestId(`button-refresh-${TEMPLATE_ID}`));

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const toastArg = toastMock.mock.calls[0][0] as { title: string; description?: string; variant?: string };
    expect(toastArg.variant).toBe("destructive");
    expect(toastArg.title).toMatch(/could not update/i);
    // The error message from the backend is surfaced in the toast description.
    expect(toastArg.description ?? "").toContain("Backend exploded");

    // Server-side row was not touched, so the FE label must still match it.
    expect(handler.templates[0].updatedAt).toBe(INITIAL_UPDATED_AT);
    const stillRow = screen.getByTestId(`row-template-${TEMPLATE_ID}`);
    expect(within(stillRow).getByText(/Updated /).textContent).toBe(initialLabel);
  });
});
