/**
 * Component test: web portal "Reset to defaults" button for the
 * per-notification key preferences section (Task #1353).
 *
 * The button should:
 *  - Be present and enabled when the user has at least one per-key override.
 *  - Issue a DELETE to /api/portal/notification-key-prefs and refetch state
 *    so each key falls back to the global digest mode.
 *  - Be disabled while the request is in flight.
 *  - Be disabled when the user has no overrides to clear.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// Stub `useGetMe` so the controller-only "Stuck erasure cleanup digest"
// row added in Task #1453 can read a role without dragging a real
// QueryClient into this test. Default to a player so the new row stays
// hidden and this fixture remains focused on the per-key reset flow.
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 1, role: "player" } }),
}));

import { PortalCommPrefs } from "../pages/portal/PortalCommPrefs";

interface KeyPrefRow {
  key: string;
  category: string;
  description: string;
  override: "realtime" | "digest" | null;
  effectiveMode: "realtime" | "digest";
}

let serverDigestMode = false;
let serverKeys: KeyPrefRow[] = [];
let deleteCalls = 0;

function makeFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/portal/my-comm-prefs")) {
      // Always return an empty list so the comm-prefs section hydrates.
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/portal/notification-preferences")) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/portal/notification-key-prefs")) {
      if (method === "GET") {
        return new Response(
          JSON.stringify({ digestMode: serverDigestMode, keys: serverKeys }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "DELETE") {
        deleteCalls += 1;
        // Server-side reset: every key loses its override and falls back to
        // the global digest setting.
        const cleared = serverKeys.length;
        serverKeys = serverKeys.map(k => ({
          ...k,
          override: null,
          effectiveMode: serverDigestMode ? "digest" : "realtime",
        }));
        return new Response(JSON.stringify({ cleared }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

let fetchMock = makeFetch();

beforeEach(() => {
  serverDigestMode = false;
  serverKeys = [];
  deleteCalls = 0;
  fetchMock = makeFetch();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PortalCommPrefs — Reset per-notification overrides (Task #1353)", () => {
  it("renders the reset button enabled when the user has overrides, disabled otherwise", async () => {
    serverKeys = [
      {
        key: "tournament.cut_made",
        category: "tournaments",
        description: "Cut made",
        override: "digest",
        effectiveMode: "digest",
      },
      {
        key: "tournament.round_closed",
        category: "tournaments",
        description: "Round closed",
        override: null,
        effectiveMode: "realtime",
      },
    ];

    render(<PortalCommPrefs />);

    const btn = await screen.findByTestId("btn-reset-notification-key-prefs");
    expect(btn).toBeInTheDocument();
    await waitFor(() => expect(btn.hasAttribute("disabled")).toBe(false));
    expect(btn.textContent).toMatch(/Reset to defaults/);
  });

  it("hides/disables the reset button when no overrides exist", async () => {
    serverKeys = [
      {
        key: "tournament.cut_made",
        category: "tournaments",
        description: "Cut made",
        override: null,
        effectiveMode: "realtime",
      },
    ];

    render(<PortalCommPrefs />);

    const btn = await screen.findByTestId("btn-reset-notification-key-prefs");
    await waitFor(() => expect(btn.hasAttribute("disabled")).toBe(true));
  });

  it("clicking reset DELETEs the overrides, refetches, and updates the UI to inherit the global setting", async () => {
    serverKeys = [
      {
        key: "tournament.cut_made",
        category: "tournaments",
        description: "Cut made",
        override: "digest",
        effectiveMode: "digest",
      },
    ];

    render(<PortalCommPrefs />);

    const btn = await screen.findByTestId("btn-reset-notification-key-prefs");
    await waitFor(() => expect(btn.hasAttribute("disabled")).toBe(false));

    // The "Daily summary" button should be the active one before reset.
    const digestBtn = await screen.findByTestId(
      "btn-key-pref-tournament.cut_made-digest",
    );
    await waitFor(() =>
      expect(digestBtn.getAttribute("aria-pressed")).toBe("true"),
    );

    // Task #1619 — clicking "Reset to defaults" now opens a confirm
    // dialog. The DELETE only fires after the user confirms.
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(deleteCalls).toBe(0);

    const confirm = await screen.findByTestId(
      "btn-confirm-reset-notification-key-prefs",
    );
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => expect(deleteCalls).toBe(1));

    // After the refetch, the override is gone and the row falls back to
    // the global digest_mode (false ⇒ realtime).
    await waitFor(() => {
      const realtimeBtn = screen.getByTestId(
        "btn-key-pref-tournament.cut_made-realtime",
      );
      expect(realtimeBtn.getAttribute("aria-pressed")).toBe("true");
    });

    // And the reset button has nothing left to clear, so it's disabled now.
    await waitFor(() => {
      const refreshed = screen.getByTestId("btn-reset-notification-key-prefs");
      expect(refreshed.hasAttribute("disabled")).toBe(true);
    });
  });

  it("disables the reset button while the DELETE request is in flight", async () => {
    serverKeys = [
      {
        key: "tournament.cut_made",
        category: "tournaments",
        description: "Cut made",
        override: "digest",
        effectiveMode: "digest",
      },
    ];

    // Arrange a deferred response: we'll capture the resolver so we can
    // release the DELETE manually after asserting the busy state.
    let release: (() => void) | null = null;
    const releasedPromise = new Promise<Response>((resolve) => {
      release = () => resolve(new Response(JSON.stringify({ cleared: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });

    // Replace the fetch mock with one that hangs the DELETE until released.
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/portal/my-comm-prefs")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/portal/notification-preferences")) {
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/portal/notification-key-prefs")) {
        if (method === "GET") {
          return new Response(
            JSON.stringify({ digestMode: serverDigestMode, keys: serverKeys }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (method === "DELETE") {
          deleteCalls += 1;
          serverKeys = serverKeys.map(k => ({ ...k, override: null, effectiveMode: "realtime" }));
          return releasedPromise;
        }
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<PortalCommPrefs />);

    const btn = await screen.findByTestId("btn-reset-notification-key-prefs");
    await waitFor(() => expect(btn.hasAttribute("disabled")).toBe(false));

    // Task #1619 — open the confirm dialog, then click confirm to fire DELETE.
    await act(async () => {
      fireEvent.click(btn);
    });
    const confirm = await screen.findByTestId(
      "btn-confirm-reset-notification-key-prefs",
    );
    await act(async () => {
      fireEvent.click(confirm);
    });

    // While in flight, the button is disabled and shows the "Resetting…" label.
    await waitFor(() => {
      const inFlight = screen.getByTestId("btn-reset-notification-key-prefs");
      expect(inFlight.hasAttribute("disabled")).toBe(true);
      expect(inFlight.textContent).toMatch(/Resetting/);
    });

    // Release the deferred DELETE response so the request settles.
    await act(async () => {
      release?.();
    });

    await waitFor(() => {
      const finished = screen.getByTestId("btn-reset-notification-key-prefs");
      expect(finished.textContent).toMatch(/Reset to defaults/);
    });
  });

  // Task #1619 — explicit coverage for the confirm prompt.
  it("opens a confirmation dialog and does NOT DELETE if the user cancels", async () => {
    serverKeys = [
      {
        key: "tournament.cut_made",
        category: "tournaments",
        description: "Cut made",
        override: "digest",
        effectiveMode: "digest",
      },
    ];

    render(<PortalCommPrefs />);

    const btn = await screen.findByTestId("btn-reset-notification-key-prefs");
    await waitFor(() => expect(btn.hasAttribute("disabled")).toBe(false));

    // Dialog is hidden until the user clicks "Reset to defaults".
    expect(
      screen.queryByTestId("dialog-confirm-reset-notification-key-prefs"),
    ).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(btn);
    });

    // The confirm dialog is now open with cancel + confirm actions.
    const dialog = await screen.findByTestId(
      "dialog-confirm-reset-notification-key-prefs",
    );
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByTestId("btn-confirm-reset-notification-key-prefs"),
    ).toBeInTheDocument();
    const cancel = screen.getByTestId(
      "btn-cancel-reset-notification-key-prefs",
    );
    expect(cancel).toBeInTheDocument();

    // Cancel does NOT fire the DELETE.
    await act(async () => {
      fireEvent.click(cancel);
    });
    await waitFor(() =>
      expect(
        screen.queryByTestId("dialog-confirm-reset-notification-key-prefs"),
      ).not.toBeInTheDocument(),
    );
    expect(deleteCalls).toBe(0);

    // The override is still in place: the "Daily summary" button is active.
    const digestBtn = screen.getByTestId(
      "btn-key-pref-tournament.cut_made-digest",
    );
    expect(digestBtn.getAttribute("aria-pressed")).toBe("true");
  });
});
