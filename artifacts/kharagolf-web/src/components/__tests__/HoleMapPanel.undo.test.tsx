/**
 * UI test: HoleMapPanel drag-to-undo flow (Task #859 / Task #1010 / Task #1177).
 *
 * Covers two behaviours of the "Undo" banner:
 *   1. Dragging a shot marker fires a PATCH that moves the shot, then a
 *      "Shot moved" toast appears with an Undo action that — when clicked —
 *      issues a second PATCH back to the original lat/lng.
 *   2. Successive edits STACK into a small undo history (Task #1177; cap
 *      raised from 3 → 10 in Task #1639). A follow-up edit (e.g. Mark Sand)
 *      shows the latest action in the banner with a "+1 more recent edit"
 *      hint, and pressing Undo twice reverts both edits in LIFO order —
 *      the most recent edit first, then the original move.
 *
 * The component fetches map-config, hole GPS, hazards, fairways, pin
 * positions, and shot data — all stubbed via a global fetch mock. The
 * Mapbox satellite <img> never actually loads in jsdom, so we fire a
 * synthetic load event to flip imageLoaded=true and reveal the marker
 * overlay buttons.
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
// When set, every PATCH waits on the returned Promise before resolving.
// Used by the "rapid undo" serialisation test to verify revert PATCHes
// are issued strictly one at a time.
let patchGate: ((call: PatchCall) => Promise<void>) | null;

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
      const call: PatchCall = { id, body };
      patchCalls.push(call);
      const target = shotState.find(s => s.id === id);
      if (target) {
        if (body.latitude !== undefined) target.latitude = String(body.latitude);
        if (body.longitude !== undefined) target.longitude = String(body.longitude);
        if (body.club !== undefined) target.club = body.club;
        if (body.lieType !== undefined) target.lieType = body.lieType;
        if (body.shotType !== undefined) target.shotType = body.shotType;
      }
      if (patchGate) await patchGate(call);
      return new Response("{}", { status: 200 }) as unknown as Response;
    }
    // Open-meteo + anything else
    return new Response("null", { status: 200 }) as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  patchCalls = [];
  shotState = [makeShot()];
  patchGate = null;
  installFetch();
  // Disable geolocation so the elevation lookup never fires.
  Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function openAndLoadMap() {
  render(
    <>
      <HoleMapPanel courseId={1} roundId={42} currentHole={1} mode="general-play" />
      <Toaster />
    </>,
  );
  // Open the collapsible header
  fireEvent.click(screen.getByText(/Hole Map/i));
  // Wait for the satellite image to appear and force a load event so
  // imageLoaded flips true and the hit-target overlay renders.
  // Task #1645: HoleMapPanel now derives `imageLoaded` from the URL
  // currently in the DOM (`loadedMapUrl === mapUrl`) instead of using
  // a boolean reset effect, so a single synthetic load event is
  // sufficient — there is no longer a passive reset that can race with
  // the load handler.
  const img = await screen.findByAltText(/Hole 1 satellite view/i);
  fireEvent.load(img);
  return await screen.findByTitle(/Shot 1.*drag to reposition/i);
}

function dispatchWindowMouse(type: "mousemove" | "mouseup", x: number, y: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: y, bubbles: true, button: 0,
    }));
  });
}

describe("<HoleMapPanel /> — drag-to-undo flow", () => {
  it("drags a shot marker and reverts the move when Undo is clicked within the 5s window", async () => {
    const marker = await openAndLoadMap();

    fireEvent.mouseDown(marker, { clientX: 100, clientY: 100 });
    dispatchWindowMouse("mousemove", 140, 130);
    dispatchWindowMouse("mouseup", 140, 130);

    // Toast appears with the action.
    await screen.findByText("Shot moved");
    const undoBtn = await screen.findByRole("button", { name: /^Undo$/i });

    // The first PATCH carried the new (drag-shifted) coordinates.
    const movePatch = patchCalls.find(c => c.body.latitude !== undefined);
    expect(movePatch).toBeTruthy();
    expect(movePatch!.body.latitude).not.toBe(ORIG_LAT);

    fireEvent.click(undoBtn);

    // A second PATCH should now restore the original lat/lng exactly.
    await waitFor(() => {
      const undo = patchCalls.slice(1).find(c =>
        c.body.latitude === ORIG_LAT && c.body.longitude === ORIG_LNG
      );
      expect(undo).toBeTruthy();
    });
  });

  it("stacks an unrelated edit on top of a pending move (Task #1177) and undoes both in LIFO order", async () => {
    const marker = await openAndLoadMap();

    // 1. Drag the shot — pushes a "Shot moved" undo entry.
    fireEvent.mouseDown(marker, { clientX: 100, clientY: 100 });
    dispatchWindowMouse("mousemove", 140, 130);
    dispatchWindowMouse("mouseup", 140, 130);

    await screen.findByText("Shot moved");

    // 2. Trigger an unrelated edit — Mark Sand. With Task #1177 this no
    //    longer dismisses the previous toast; instead it stacks on top.
    const chip = await screen.findByRole("button", { name: /#1.*7I.*Watch/i });
    fireEvent.click(chip);
    const sandBtn = await screen.findByRole("button", { name: /Mark Sand/i });
    fireEvent.click(sandBtn);

    // Banner now shows the most recent action and a "+1 more" hint.
    await screen.findByText("Shot updated");
    await screen.findByText(/\+1 more recent edit/i);
    expect(screen.queryByText("Shot moved")).toBeNull();

    // 3. First Undo reverts the lieType edit. Watch the PATCH calls — the
    //    next PATCH after the move/sand pair should restore lieType.
    const beforeFirstUndo = patchCalls.length;
    fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
    await waitFor(() => {
      const undo = patchCalls.slice(beforeFirstUndo).find(c => c.body.lieType === "Fairway");
      expect(undo).toBeTruthy();
    });

    // After popping, the banner should fall back to the older "Shot moved"
    // entry (no more "+ N more" badge since only one entry is left).
    await screen.findByText("Shot moved");
    expect(screen.queryByText(/\+\d+ more recent edit/i)).toBeNull();

    // 4. Second Undo reverts the move itself, restoring the original lat/lng.
    const beforeSecondUndo = patchCalls.length;
    fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
    await waitFor(() => {
      const undo = patchCalls.slice(beforeSecondUndo).find(c =>
        c.body.latitude === ORIG_LAT && c.body.longitude === ORIG_LNG
      );
      expect(undo).toBeTruthy();
    });

    // Banner is gone once the stack is empty.
    await waitFor(() => {
      expect(screen.queryByText("Shot moved")).toBeNull();
      expect(screen.queryByText("Shot updated")).toBeNull();
    });
  });

  it("caps the undo history at 10 entries — an 11th edit drops the oldest (Task #1177 / Task #1639)", async () => {
    await openAndLoadMap();

    // Open the inline editor by clicking the shot chip.
    const chip = await screen.findByRole("button", { name: /#1.*7I.*Watch/i });
    fireEvent.click(chip);

    const sandBtn = await screen.findByRole("button", { name: /Mark Sand/i });
    const fairwayBtn = await screen.findByRole("button", { name: /Mark Fairway/i });

    // Push 11 alternating lieType edits. With the cap of 10 (raised from 3
    // by Task #1639), the very first edit (Fairway → Bunker) should fall
    // out of the stack while the remaining 10 stay in LIFO order.
    //   odd  i (1, 3, 5, 7, 9, 11) → Mark Sand   (… → Bunker)
    //   even i (2, 4, 6, 8, 10)    → Mark Fairway (… → Fairway)
    let bunkerCount = 0;
    let fairwayCount = 0;
    for (let i = 1; i <= 11; i++) {
      if (i % 2 === 1) {
        bunkerCount += 1;
        fireEvent.click(sandBtn);
        const expected = bunkerCount;
        await waitFor(() =>
          expect(patchCalls.filter(c => c.body.lieType === "Bunker").length).toBe(expected),
        );
      } else {
        fairwayCount += 1;
        fireEvent.click(fairwayBtn);
        const expected = fairwayCount;
        await waitFor(() =>
          expect(patchCalls.filter(c => c.body.lieType === "Fairway").length).toBe(expected),
        );
      }
    }
    expect(bunkerCount).toBe(6);
    expect(fairwayCount).toBe(5);

    // Banner shows the latest action with "+9 more recent edits" — only
    // 10 of the 11 edits remain in the stack (cap = 10).
    await screen.findByText(/\+9 more recent edits/i);

    // Press Undo ten times. Each undo PATCH reverts ONE edit. After 10
    // presses the stack is empty and the banner is gone. The 1st edit
    // (the original Fairway → Bunker) was dropped, so the suite should
    // record exactly 10 follow-up PATCHes — not 11 — proving the cap
    // discarded the oldest entry.
    const beforeUndos = patchCalls.length;
    for (let i = 0; i < 10; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
      // Wait for the next PATCH to be observed before pressing again so
      // the assertions below count exactly 10 follow-up PATCHes.
      const expected = beforeUndos + i + 1;
      await waitFor(() => expect(patchCalls.length).toBe(expected));
    }
    await waitFor(() => {
      expect(screen.queryByText("Shot updated")).toBeNull();
    });

    const undoPatches = patchCalls.slice(beforeUndos);
    expect(undoPatches.length).toBe(10);
    // LIFO order — pop edits 11 → 2, restoring the prior lieType each time:
    //   pop edit 11 (Fairway→Bunker) ⇒ restore "Fairway"
    //   pop edit 10 (Bunker→Fairway) ⇒ restore "Bunker"
    //   … alternating …
    //   pop edit  2 (Bunker→Fairway) ⇒ restore "Bunker"
    expect(undoPatches.map(c => c.body.lieType)).toEqual([
      "Fairway", "Bunker", "Fairway", "Bunker", "Fairway",
      "Bunker", "Fairway", "Bunker", "Fairway", "Bunker",
    ]);

    // Pressing Undo again has nothing to do — no extra PATCH fires.
    expect(screen.queryByRole("button", { name: /^Undo$/i })).toBeNull();
  });

  it("serialises rapid Undo presses so revert PATCHes execute strictly LIFO even with slow network (Task #1177)", async () => {
    await openAndLoadMap();

    // Stack three lieType edits.
    const chip = await screen.findByRole("button", { name: /#1.*7I.*Watch/i });
    fireEvent.click(chip);
    const sandBtn = await screen.findByRole("button", { name: /Mark Sand/i });
    const fairwayBtn = await screen.findByRole("button", { name: /Mark Fairway/i });

    fireEvent.click(sandBtn);    // edit 1: Fairway → Bunker
    await waitFor(() => expect(patchCalls.some(c => c.body.lieType === "Bunker")).toBe(true));
    fireEvent.click(fairwayBtn); // edit 2: Bunker → Fairway
    await waitFor(() => expect(patchCalls.filter(c => c.body.lieType === "Fairway").length).toBe(1));
    fireEvent.click(sandBtn);    // edit 3: Fairway → Bunker
    await waitFor(() => expect(patchCalls.filter(c => c.body.lieType === "Bunker").length).toBe(2));

    // Now gate every subsequent PATCH so revert calls hang until the
    // test releases them. This simulates slow network — without proper
    // serialisation, three rapid UNDO clicks would dispatch three PATCH
    // requests concurrently and the server would receive them in an
    // arbitrary order.
    const beforeUndos = patchCalls.length;
    const gated: Array<{ call: PatchCall; release: () => void }> = [];
    patchGate = (call) => new Promise<void>((resolve) => {
      gated.push({ call, release: resolve });
    });

    // Mash UNDO three times without awaiting between presses.
    const undoBtn = () => screen.getByRole("button", { name: /^Undo$/i });
    fireEvent.click(undoBtn());
    fireEvent.click(undoBtn());
    fireEvent.click(undoBtn());

    // Even though all three UNDO clicks were dispatched synchronously,
    // only ONE revert PATCH should be in flight: the chain awaits the
    // previous PATCH before issuing the next.
    await waitFor(() => expect(gated.length).toBe(1));
    expect(patchCalls.length).toBe(beforeUndos + 1);
    // Top-of-stack was edit 3 (Fairway → Bunker); its revert restores
    // "Fairway".
    expect(gated[0].call.body.lieType).toBe("Fairway");

    // Release the first revert; the second one should follow.
    gated[0].release();
    await waitFor(() => expect(gated.length).toBe(2));
    expect(patchCalls.length).toBe(beforeUndos + 2);
    // Edit 2 (Bunker → Fairway) ⇒ restore "Bunker".
    expect(gated[1].call.body.lieType).toBe("Bunker");

    gated[1].release();
    await waitFor(() => expect(gated.length).toBe(3));
    expect(patchCalls.length).toBe(beforeUndos + 3);
    // Edit 1 (Fairway → Bunker) ⇒ restore "Fairway".
    expect(gated[2].call.body.lieType).toBe("Fairway");

    gated[2].release();
    // Final order recorded server-side is strict LIFO.
    await waitFor(() => expect(patchCalls.length).toBe(beforeUndos + 3));
    const undoPatches = patchCalls.slice(beforeUndos).map(c => c.body.lieType);
    expect(undoPatches).toEqual(["Fairway", "Bunker", "Fairway"]);
  });

  it("clears the undo history when the player navigates to a different hole (Task #1177)", async () => {
    const { rerender } = render(
      <>
        <HoleMapPanel courseId={1} roundId={42} currentHole={1} mode="general-play" />
        <Toaster />
      </>,
    );
    fireEvent.click(screen.getByText(/Hole Map/i));
    const img = await screen.findByAltText(/Hole 1 satellite view/i);
    fireEvent.load(img);
    const marker = await screen.findByTitle(/Shot 1.*drag to reposition/i);

    // Drag to push an undo entry.
    fireEvent.mouseDown(marker, { clientX: 100, clientY: 100 });
    dispatchWindowMouse("mousemove", 140, 130);
    dispatchWindowMouse("mouseup", 140, 130);

    await screen.findByText("Shot moved");

    // Navigate to a different hole. The banner should disappear and the
    // undo history is wiped — pressing Undo (if it ever reappeared) is a
    // no-op because there's nothing left to revert.
    rerender(
      <>
        <HoleMapPanel courseId={1} roundId={42} currentHole={2} mode="general-play" />
        <Toaster />
      </>,
    );

    await waitFor(() => {
      expect(screen.queryByText("Shot moved")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: /^Undo$/i })).toBeNull();
  });
});
