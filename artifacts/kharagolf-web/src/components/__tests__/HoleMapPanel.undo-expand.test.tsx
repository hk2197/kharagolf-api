/**
 * UI test: HoleMapPanel expandable undo history (Task #1366).
 *
 * After Task #1177 the toast shows the most recent edit plus a "+N more
 * recent edits" hint when more entries are pending. Task #1366 makes
 * that hint a clickable button — tapping it expands the toast into a
 * vertical list of all pending edits in chronological order, each with
 * its own per-entry Undo button so the player can revert a specific
 * older edit without first stepping through the newer ones.
 *
 * Mirrors the setup in HoleMapPanel.undo.test.tsx (fetch mock, satellite
 * load event, drag/click helpers).
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
  vi.useRealTimers();
});

async function openAndLoadMap() {
  render(
    <>
      <HoleMapPanel courseId={1} roundId={42} currentHole={1} mode="general-play" />
      <Toaster />
    </>,
  );
  fireEvent.click(screen.getByText(/Hole Map/i));
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

describe("<HoleMapPanel /> — expandable undo history (Task #1366)", () => {
  it("expands the toast to a list and undoes a specific older edit, leaving the others intact", async () => {
    const marker = await openAndLoadMap();

    // 1. Drag the shot — pushes a "Shot moved" undo entry.
    fireEvent.mouseDown(marker, { clientX: 100, clientY: 100 });
    dispatchWindowMouse("mousemove", 140, 130);
    dispatchWindowMouse("mouseup", 140, 130);
    await screen.findByText("Shot moved");

    // 2. Stack two unrelated edits (Mark Sand → Mark Fairway) so the
    //    history fills up to 3 entries.
    const chip = await screen.findByRole("button", { name: /#1.*7I.*Watch/i });
    fireEvent.click(chip);
    const sandBtn = await screen.findByRole("button", { name: /Mark Sand/i });
    fireEvent.click(sandBtn);
    await waitFor(() => expect(patchCalls.some(c => c.body.lieType === "Bunker")).toBe(true));

    const fairwayBtn = await screen.findByRole("button", { name: /Mark Fairway/i });
    fireEvent.click(fairwayBtn);
    await waitFor(() =>
      expect(patchCalls.filter(c => c.body.lieType === "Fairway").length).toBe(1),
    );

    // Banner shows latest action + "+2 more recent edits" hint.
    const expandHint = await screen.findByText(/\+2 more recent edits/i);

    // 3. Tap the hint → toast expands. Title becomes "Recent edits" and
    //    three entries are visible in the list (chronological order:
    //    Shot moved → Shot updated → Shot updated). Each row has its
    //    own per-entry Undo button.
    fireEvent.click(expandHint);
    await screen.findByText("Recent edits");
    const movedRow = screen.getByText("Shot moved");
    expect(movedRow).toBeTruthy();
    const updatedRows = screen.getAllByText("Shot updated");
    expect(updatedRows.length).toBe(2);

    // The top-level action button is now "Hide" (collapses the list);
    // the per-entry Undo buttons are individual <button> elements
    // rendered next to each row's title. The per-entry buttons use
    // type="button"; Radix's ToastAction renders without that attribute.
    expect(screen.getByText("Hide")).toBeTruthy();
    const perEntryUndoBtns = screen
      .getAllByText("Undo")
      .map(el => el.closest("button"))
      .filter((b): b is HTMLButtonElement => !!b && b.getAttribute("type") === "button");
    expect(perEntryUndoBtns.length).toBe(3);

    // 4. Click the FIRST per-entry Undo — chronological order means
    //    that's the OLDEST entry, the original "Shot moved". The revert
    //    PATCH should restore the pristine ORIG_LAT/LNG, NOT just the
    //    most recent location.
    const beforeUndo = patchCalls.length;
    fireEvent.click(perEntryUndoBtns[0]);

    await waitFor(() => {
      const undo = patchCalls.slice(beforeUndo).find(c =>
        c.body.latitude === ORIG_LAT && c.body.longitude === ORIG_LNG,
      );
      expect(undo).toBeTruthy();
    });

    // The two surviving "Shot updated" entries are still pending — the
    // expanded list re-renders with 2 rows.
    await waitFor(() => {
      expect(screen.getAllByText("Shot updated").length).toBe(2);
    });
    expect(screen.queryByText("Shot moved")).toBeNull();

    // No more "+N more" hint appears in the expanded list — it's only
    // shown when collapsed. The per-entry Undo buttons drop to 2.
    const remainingPerEntry = screen
      .getAllByText("Undo")
      .map(el => el.closest("button"))
      .filter((b): b is HTMLButtonElement => !!b && b.getAttribute("type") === "button");
    expect(remainingPerEntry.length).toBe(2);
  });

  it("shows a relative timestamp on each row in the expanded list (Task #1638)", async () => {
    const marker = await openAndLoadMap();

    // Push two edits so the toast can be expanded ("+1 more recent edit").
    fireEvent.mouseDown(marker, { clientX: 100, clientY: 100 });
    dispatchWindowMouse("mousemove", 140, 130);
    dispatchWindowMouse("mouseup", 140, 130);
    await screen.findByText("Shot moved");

    const chip = await screen.findByRole("button", { name: /#1.*7I.*Watch/i });
    fireEvent.click(chip);
    const sandBtn = await screen.findByRole("button", { name: /Mark Sand/i });
    fireEvent.click(sandBtn);

    const expandHint = await screen.findByText(/\+1 more recent edit/i);
    fireEvent.click(expandHint);
    await screen.findByText("Recent edits");

    // Each of the two rows should render a relative timestamp like "just
    // now" or "Ns ago" right next to the entry's label. The labels live
    // beside the per-entry Undo buttons (not Radix's ToastAction button),
    // so filter by type="button" the same way the sibling tests do.
    const perEntryUndoBtns = screen
      .getAllByText("Undo")
      .map(el => el.closest("button"))
      .filter((b): b is HTMLButtonElement => !!b && b.getAttribute("type") === "button");
    expect(perEntryUndoBtns.length).toBe(2);

    // The timestamp text appears on the toast — anywhere in the document
    // is sufficient since the toast is the only place rendering these
    // labels right now.
    const timestamps = screen.getAllByText(/^(just now|\d+s ago)$/);
    expect(timestamps.length).toBe(2);
  });

  it("Hide collapses the expanded list back to the single-entry banner", async () => {
    const marker = await openAndLoadMap();

    // Two stacked edits → "+1 more recent edit" hint.
    fireEvent.mouseDown(marker, { clientX: 100, clientY: 100 });
    dispatchWindowMouse("mousemove", 140, 130);
    dispatchWindowMouse("mouseup", 140, 130);
    await screen.findByText("Shot moved");

    const chip = await screen.findByRole("button", { name: /#1.*7I.*Watch/i });
    fireEvent.click(chip);
    const sandBtn = await screen.findByRole("button", { name: /Mark Sand/i });
    fireEvent.click(sandBtn);
    await screen.findByText(/\+1 more recent edit/i);

    // Expand
    fireEvent.click(screen.getByText(/\+1 more recent edit/i));
    await screen.findByText("Recent edits");
    const hideBtn = screen.getByText("Hide");

    // Tap Hide — list collapses, "+1 more" hint is back, and the
    // top-level Undo action returns.
    fireEvent.click(hideBtn);
    await waitFor(() => {
      expect(screen.queryByText("Recent edits")).toBeNull();
    });
    await screen.findByText(/\+1 more recent edit/i);
    expect(screen.queryByText("Hide")).toBeNull();
    expect(screen.getByText("Undo")).toBeTruthy();
  });
});
