/**
 * Component test: web portal "Use default" link for an individual
 * per-notification key preference (Task #1618).
 *
 * Each row in the per-notification section should:
 *  - Show a small "Use default" link only when that row currently has an
 *    explicit override (override !== null).
 *  - Hide the link entirely on rows that already inherit the global
 *    digest setting (override === null).
 *  - On click, PATCH /api/portal/notification-key-prefs with
 *    { key, deliveryMode: null } and visually fall back to the global
 *    digest_mode (so the toggle's active side flips to whichever side
 *    digestMode points at).
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
let patchCalls: Array<{ key: string; deliveryMode: unknown }> = [];

function makeFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/portal/my-comm-prefs")) {
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/portal/notification-preferences")) {
      return new Response("{}", {
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
      if (method === "PATCH") {
        const body = init?.body
          ? (JSON.parse(String(init.body)) as { key: string; deliveryMode: unknown })
          : { key: "", deliveryMode: null };
        patchCalls.push(body);
        return new Response(
          JSON.stringify({ key: body.key, override: body.deliveryMode }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

let fetchMock = makeFetch();

beforeEach(() => {
  serverDigestMode = false;
  serverKeys = [];
  patchCalls = [];
  fetchMock = makeFetch();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PortalCommPrefs — Clear single per-key override (Task #1618)", () => {
  it("only renders the 'Use default' link on rows that currently have an override", async () => {
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

    // Row with an explicit override exposes the clear link.
    expect(
      await screen.findByTestId("btn-key-pref-tournament.cut_made-clear"),
    ).toBeInTheDocument();

    // Row that already inherits the global digest setting should NOT have
    // a clear link — there is no override to drop.
    expect(
      screen.queryByTestId("btn-key-pref-tournament.round_closed-clear"),
    ).toBeNull();
  });

  it("clicking 'Use default' PATCHes deliveryMode: null, removes the link, and falls back to the global digest setting", async () => {
    // Global digest_mode is ON, so clearing an explicit "realtime" override
    // should flip the row's active button to Daily summary.
    serverDigestMode = true;
    serverKeys = [
      {
        key: "tournament.cut_made",
        category: "tournaments",
        description: "Cut made",
        override: "realtime",
        effectiveMode: "realtime",
      },
    ];

    render(<PortalCommPrefs />);

    const realtimeBtn = await screen.findByTestId(
      "btn-key-pref-tournament.cut_made-realtime",
    );
    await waitFor(() =>
      expect(realtimeBtn.getAttribute("aria-pressed")).toBe("true"),
    );

    const clearBtn = screen.getByTestId(
      "btn-key-pref-tournament.cut_made-clear",
    );

    await act(async () => {
      fireEvent.click(clearBtn);
    });

    // The PATCH body was the right one: clear just this key.
    await waitFor(() => expect(patchCalls.length).toBe(1));
    expect(patchCalls[0]).toEqual({
      key: "tournament.cut_made",
      deliveryMode: null,
    });

    // The clear link disappears now that the row no longer has an override.
    await waitFor(() => {
      expect(
        screen.queryByTestId("btn-key-pref-tournament.cut_made-clear"),
      ).toBeNull();
    });

    // And the row falls back to the global digest_mode (true ⇒ digest).
    const digestBtn = screen.getByTestId(
      "btn-key-pref-tournament.cut_made-digest",
    );
    await waitFor(() =>
      expect(digestBtn.getAttribute("aria-pressed")).toBe("true"),
    );
  });

  it("falls back to real-time when the global digest setting is off", async () => {
    serverDigestMode = false;
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

    const clearBtn = await screen.findByTestId(
      "btn-key-pref-tournament.cut_made-clear",
    );

    await act(async () => {
      fireEvent.click(clearBtn);
    });

    await waitFor(() => expect(patchCalls.length).toBe(1));
    expect(patchCalls[0].deliveryMode).toBeNull();

    const realtimeBtn = screen.getByTestId(
      "btn-key-pref-tournament.cut_made-realtime",
    );
    await waitFor(() =>
      expect(realtimeBtn.getAttribute("aria-pressed")).toBe("true"),
    );
  });
});
