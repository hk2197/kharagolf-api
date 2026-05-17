/**
 * UI test: HoleMapPanel drag-to-undo banner auto-dismisses after ~5s
 * (Task #1183).
 *
 * The drag-to-undo flow exposes a 5-second window in which the user can
 * undo a shot move (HoleMapPanel.tsx UNDO_STACK_TTL_MS). The other
 * HoleMapPanel.undo.test.tsx cases confirm the banner closes when Undo
 * is clicked or when an unrelated edit pops the stack — but they don't
 * assert the auto-dismiss timer itself. A regression that removed the
 * setTimeout (or shortened/lengthened it dramatically) would slip past
 * those tests silently.
 *
 * Isolated in its own file because a previous attempt to use
 * `vi.useFakeTimers({ shouldAdvanceTime: true })` in the main undo
 * test file interacted poorly with subsequent tests in the same file
 * (the synthetic Mapbox image load event stopped flipping
 * `imageLoaded`). Running with real timers in a dedicated file sidesteps
 * the issue at the cost of one ~5s wait.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

import HoleMapPanel from "../HoleMapPanel";
import { Toaster } from "@/components/ui/toaster";

const HOLE = {
  holeNumber: 1,
  par: 4,
  yardageWhite: 380,
  greenCentreLat: "12.971800",
  greenCentreLng: "77.594560",
  greenFrontLat: "12.971700",
  greenFrontLng: "77.594560",
  greenBackLat: "12.971900",
  greenBackLng: "77.594560",
};

interface ShotRow {
  id: number;
  holeNumber: number;
  shotNumber: number;
  shotType: string | null;
  club: string | null;
  lieType: string | null;
  latitude: string | null;
  longitude: string | null;
  distanceCarried: string | null;
  distanceToPin: string | null;
  source: string;
}

const ORIG_LAT = 12.972500;
const ORIG_LNG = 77.594560;

function makeShot(): ShotRow {
  return {
    id: 101,
    holeNumber: 1,
    shotNumber: 1,
    shotType: null,
    club: "7I",
    lieType: "Fairway",
    latitude: String(ORIG_LAT),
    longitude: String(ORIG_LNG),
    distanceCarried: "120",
    distanceToPin: "50",
    source: "watch",
  };
}

interface PatchCall { id: number; body: Record<string, unknown> }
let patchCalls: PatchCall[];
let shotState: ShotRow[];

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/public/map-config")) {
      return new Response(JSON.stringify({ token: "tk_test" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/holes-gps")) {
      return new Response(JSON.stringify([HOLE]), { status: 200 }) as unknown as Response;
    }
    if (url.includes("/holes-hazards") || url.includes("/holes-fairways") || url.includes("/pin-positions")) {
      return new Response("[]", { status: 200 }) as unknown as Response;
    }
    if (url.includes("/portal/rounds/1/shots")) {
      return new Response(JSON.stringify([{ hole: 1, shots: shotState }]), { status: 200 }) as unknown as Response;
    }
    const patchMatch = url.match(/\/portal\/shots\/(\d+)/);
    if (patchMatch && method === "PATCH") {
      const id = parseInt(patchMatch[1], 10);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      patchCalls.push({ id, body });
      const target = shotState.find(s => s.id === id);
      if (target) {
        if (body.latitude !== undefined) target.latitude = String(body.latitude);
        if (body.longitude !== undefined) target.longitude = String(body.longitude);
      }
      return new Response("{}", { status: 200 }) as unknown as Response;
    }
    return new Response("null", { status: 200 }) as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  patchCalls = [];
  shotState = [makeShot()];
  installFetch();
  Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function dispatchWindowMouse(type: "mousemove" | "mouseup", x: number, y: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: y, bubbles: true, button: 0,
    }));
  });
}

describe("<HoleMapPanel /> — Undo banner auto-dismiss", () => {
  it("auto-dismisses the 'Shot moved' toast ~5s after a drag if the user does nothing", async () => {
    render(
      <>
        <HoleMapPanel courseId={1} roundId={42} currentHole={1} mode="general-play" />
        <Toaster />
      </>,
    );

    fireEvent.click(screen.getByText(/Hole Map/i));
    const img = await screen.findByAltText(/Hole 1 satellite view/i);
    // Task #1645: HoleMapPanel now derives `imageLoaded` from the URL
    // currently in the DOM (`loadedMapUrl === mapUrl`) instead of
    // using a boolean reset effect, so a single synthetic load event
    // is sufficient — there is no longer a passive reset that can
    // race with the load handler.
    fireEvent.load(img);
    const marker = await screen.findByTitle(/Shot 1.*drag to reposition/i);

    // Drive a drag — pushes a "Shot moved" entry onto the undo stack.
    // The TTL setTimeout is armed synchronously inside the mouseup
    // handler, so timestamping right before the release gives us t0
    // for the auto-dismiss timer.
    fireEvent.mouseDown(marker, { clientX: 100, clientY: 100 });
    dispatchWindowMouse("mousemove", 140, 130);
    const t0 = Date.now();
    dispatchWindowMouse("mouseup", 140, 130);

    // Banner appears with the Undo action.
    await screen.findByText("Shot moved");
    expect(screen.getByRole("button", { name: /^Undo$/i })).toBeTruthy();

    // Sanity — the move PATCH did fire (so the timer was actually armed).
    const movePatch = patchCalls.find(c => c.body.latitude !== undefined);
    expect(movePatch).toBeTruthy();
    const undoPatchCountAtArm = patchCalls.length;

    // Lower bound: at ~4s after the drag, the banner must STILL be
    // visible. This catches a regression where the TTL is shortened
    // (e.g. 5s → 1s/2s) — without this checkpoint the test would
    // happily pass even if auto-dismiss fired almost immediately.
    const elapsed = () => Date.now() - t0;
    await new Promise<void>((resolve) => {
      const wait = Math.max(0, 4000 - elapsed());
      setTimeout(resolve, wait);
    });
    expect(screen.queryByText("Shot moved")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Undo$/i })).not.toBeNull();

    // Upper bound: by ~7s the timer has fired and Radix has cleared
    // the toast. waitFor budget = 7000 - elapsed gives us roughly the
    // remaining 3s window so the bracket is [4s, 7s] around the
    // documented 5s TTL.
    await waitFor(
      () => {
        expect(screen.queryByText("Shot moved")).toBeNull();
      },
      { timeout: Math.max(500, 7000 - elapsed()), interval: 100 },
    );

    // The Undo button is gone too.
    expect(screen.queryByRole("button", { name: /^Undo$/i })).toBeNull();

    // Auto-dismiss must NOT issue a revert PATCH — it just drops the
    // history and tears down the banner.
    expect(patchCalls.length).toBe(undoPatchCountAtArm);
  }, 15000);
});
