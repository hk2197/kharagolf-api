/**
 * Regression test for Task #793 — Coach Workspace page rendering and
 * core tool behaviour after the merge cleanup.
 *
 * Earlier work on the moderation tests had to delete a duplicated copy
 * of the DeliverDialog state setup (PLAYBACK_RATES, playbackRate /
 * videoTime / videoDuration / isPlaying) from
 * `src/pages/coach-workspace.tsx`. These tests open the Deliver dialog
 * for a queued review and exercise:
 *
 *   1. The annotation tool palette + canvas drawing — picking the line
 *      tool, dragging on the canvas, and confirming the shape counter
 *      flips from "0 shapes" to "1 shape".
 *   2. The playback-rate buttons actually mutate
 *      `videoRef.current.playbackRate` (the useEffect that wires
 *      `playbackRate` state into the <video> element).
 *   3. The voice-over recorder — clicking Record / Stop with mocked
 *      `getUserMedia` + `MediaRecorder` triggers a POST to
 *      `/api/swing-videos/upload-url` and a PUT to the returned URL,
 *      and surfaces the "Voice-over ready" confirmation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CoachWorkspacePage from "@/pages/coach-workspace";

// jsdom does not implement HTMLCanvasElement.getContext; the workspace
// canvas is purely decorative for these assertions, so we install a
// no-op 2D context per-test (and restore it afterwards so other suites
// keep jsdom's real behaviour).
const NOOP_CTX = {
  clearRect: () => {},
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  arc: () => {},
  stroke: () => {},
  fill: () => {},
  closePath: () => {},
  save: () => {},
  restore: () => {},
  setLineDash: () => {},
  strokeRect: () => {},
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 0,
};

const PRO = {
  id: 42,
  displayName: "Test Coach",
  bio: null,
  organizationId: 1,
  specialisms: [],
};

const PROFILE = {
  isListed: true,
  certifications: [],
  yearsExperience: 5,
  languages: ["en"],
  hourlyRatePaise: 500000,
  asyncReviewPricePaise: 200000,
  acceptsInPerson: true,
  acceptsAsync: true,
  asyncTurnaroundHours: 48,
  revenueSharePct: "70",
  ratingsAvg: "0",
  ratingsCount: 0,
  payoutMethod: null,
  payoutAccountId: null,
  payoutAccountHolderName: null,
  payoutVpa: null,
  payoutBankAccountNumber: null,
  payoutBankIfsc: null,
  payoutVerificationStatus: null,
  payoutVerificationFailureReason: null,
};

const QUEUE_ITEM = {
  request: {
    id: 7,
    status: "paid",
    dueAt: null,
    memberPrompt: "Help me with my driver swing.",
  },
  videoUrl: "https://example.test/swing.mp4",
  videoFps: 30,
};

const EARNINGS = {
  summary: {
    lifetimeEarningsPaise: 0,
    deliveredCount: 0,
    pendingPayoutPaise: 0,
    unpaidCount: 0,
  },
  sharePct: 70,
  payouts: [],
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetch(extra: Record<string, (init?: RequestInit) => Promise<Response>> = {}) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      const handler = Object.entries(extra).find(([key]) => url.endsWith(key) || url === key);
      if (handler) return handler[1](init);
      if (url.endsWith("/api/coach-marketplace/me/coach-profile")) {
        return jsonResponse({ pro: PRO, profile: PROFILE });
      }
      if (url.endsWith("/api/swing-reviews/coach/queue")) {
        return jsonResponse({ queue: [QUEUE_ITEM] });
      }
      if (url.endsWith("/api/swing-reviews/coach/earnings")) {
        return jsonResponse(EARNINGS);
      }
      if (url.endsWith("/api/swing-reviews/coach/notifications")) {
        return jsonResponse({ notifications: [] });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch,
  );
  return calls;
}

async function openDialog() {
  render(<CoachWorkspacePage />);
  await screen.findByText("Review #7");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /open/i }));
  const dialog = await screen.findByTestId("deliver-dialog");
  return { user, dialog };
}

describe("CoachWorkspacePage (Task #793 regression)", () => {
  let getContextSpy: ReturnType<typeof vi.spyOn> | null = null;
  beforeEach(() => {
    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => NOOP_CTX as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    getContextSpy?.mockRestore();
    getContextSpy = null;
    vi.restoreAllMocks();
  });

  it("renders every previously-duplicated control inside the Deliver dialog", async () => {
    installFetch();
    const { dialog } = await openDialog();
    const inDialog = within(dialog);

    expect(inDialog.getByRole("button", { name: "0.25x" })).toBeInTheDocument();
    expect(inDialog.getByRole("button", { name: "0.5x" })).toBeInTheDocument();
    expect(inDialog.getByRole("button", { name: "1x" })).toBeInTheDocument();
    // ^…$ anchors disambiguate the playback "−1f" / "+1f" controls from
    // the per-shape "shape −1f" / "shape +1f" retime buttons added by
    // task #1055.
    expect(inDialog.getByRole("button", { name: /^⏮ −1f$/ })).toBeInTheDocument();
    expect(inDialog.getByRole("button", { name: /^\+1f ⏭$/ })).toBeInTheDocument();
    expect(inDialog.getByRole("button", { name: /Play/ })).toBeInTheDocument();
    expect(inDialog.getByRole("slider", { name: /Video scrubber/i })).toBeInTheDocument();
    for (const tool of ["select", "line", "arrow", "circle", "angle"] as const) {
      expect(inDialog.getByRole("button", { name: tool })).toBeInTheDocument();
    }
    expect(inDialog.getByRole("button", { name: /Record/ })).toBeInTheDocument();
    expect(inDialog.getByPlaceholderText(/Detailed swing feedback/i)).toBeInTheDocument();
    expect(inDialog.getByRole("button", { name: /Deliver Review/i })).toBeInTheDocument();
    expect(inDialog.getByText(/^0 shapes$/)).toBeInTheDocument();
  });

  it("clicking a playback-rate button writes the new rate to the underlying <video> element", async () => {
    installFetch();
    const { user, dialog } = await openDialog();
    const inDialog = within(dialog);

    const video = dialog.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    // Initial useEffect on mount should have set playbackRate to 1.
    await waitFor(() => expect(video.playbackRate).toBe(1));

    await user.click(inDialog.getByRole("button", { name: "0.25x" }));
    await waitFor(() => expect(video.playbackRate).toBe(0.25));

    await user.click(inDialog.getByRole("button", { name: "0.5x" }));
    await waitFor(() => expect(video.playbackRate).toBe(0.5));
  });

  it("drawing with the line tool adds a shape and the counter updates", async () => {
    installFetch();
    const { user, dialog } = await openDialog();
    const inDialog = within(dialog);

    // Pick the line tool (it is the default, but click it to be explicit).
    await user.click(inDialog.getByRole("button", { name: "line" }));

    const canvas = dialog.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    // jsdom returns 0,0 from getBoundingClientRect — fine for our needs,
    // we just need a non-degenerate (start ≠ end) drag.
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 80, clientY: 60 });

    await waitFor(() => {
      expect(inDialog.getByText(/^1 shape$/)).toBeInTheDocument();
    });

    // Undo should remove it again.
    await user.click(inDialog.getByRole("button", { name: /^undo$/i }));
    await waitFor(() => {
      expect(inDialog.getByText(/^0 shapes$/)).toBeInTheDocument();
    });
  });

  it("angle tool plots three vertices and adds a single shape", async () => {
    installFetch();
    const { user, dialog } = await openDialog();
    const inDialog = within(dialog);

    await user.click(inDialog.getByRole("button", { name: "angle" }));
    const canvas = dialog.querySelector("canvas") as HTMLCanvasElement;
    // Three clicks should produce one angle shape.
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseDown(canvas, { clientX: 50, clientY: 50 });
    fireEvent.mouseDown(canvas, { clientX: 90, clientY: 30 });

    await waitFor(() => {
      expect(inDialog.getByText(/^1 shape$/)).toBeInTheDocument();
    });
  });

  it("shift-click on timeline markers multi-selects and dragging moves the whole group by one delta (Task #1216)", async () => {
    installFetch();
    const { user, dialog } = await openDialog();
    const inDialog = within(dialog);

    // Seed videoDuration to a non-zero value so the timeline strip renders
    // markers (the JSX guards `videoDuration > 0`). The dialog updates the
    // state from the <video>'s onLoadedMetadata; jsdom doesn't fire that
    // for our stub URL, so we dispatch a manual event to mimic it.
    const video = dialog.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 4 });
    fireEvent(video, new Event("loadedmetadata"));

    const canvas = dialog.querySelector("canvas") as HTMLCanvasElement;

    // Draw three line shapes. They're all created at videoTime=0 (jsdom's
    // <video> never advances) — that's fine, we're testing that selecting
    // and dragging acts on every selected marker, not the time positions.
    await user.click(inDialog.getByRole("button", { name: "line" }));
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 30, clientY: 30 });
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 60, clientY: 30 });
    fireEvent.mouseDown(canvas, { clientX: 70, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 90, clientY: 30 });

    await waitFor(() => {
      expect(inDialog.getByText(/^3 shapes$/)).toBeInTheDocument();
    });

    const m0 = inDialog.getByTestId("drawing-marker-0");
    const m1 = inDialog.getByTestId("drawing-marker-1");
    const m2 = inDialog.getByTestId("drawing-marker-2");

    // Helper: fireEvent's `{ shiftKey: true }` init isn't honoured by jsdom's
    // PointerEvent, so build the event by hand. We use a MouseEvent (which
    // jsdom does honour for shiftKey) and rename its type to 'pointerdown' —
    // React 18's onPointerDown listener fires for any event whose .type
    // matches 'pointerdown'.
    const dispatchPointerDown = (el: Element, opts: { shiftKey?: boolean; clientX?: number } = {}) => {
      const ev = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        shiftKey: opts.shiftKey ?? false,
        clientX: opts.clientX ?? 0,
        clientY: 0,
      });
      el.dispatchEvent(ev);
    };

    // Plain click on marker 0 → single-select.
    dispatchPointerDown(m0, { shiftKey: false });
    fireEvent.pointerUp(window);
    await waitFor(() => {
      expect(m0).toHaveAttribute("data-selected", "true");
      expect(m1).toHaveAttribute("data-selected", "false");
    });
    expect(inDialog.getByTestId("drawing-selection-summary").textContent).toMatch(/3 shapes · 1 selected/);

    // Shift-click marker 1 → adds to selection.
    dispatchPointerDown(m1, { shiftKey: true });
    await waitFor(() => {
      expect(m0).toHaveAttribute("data-selected", "true");
      expect(m1).toHaveAttribute("data-selected", "true");
      expect(m2).toHaveAttribute("data-selected", "false");
    });
    expect(inDialog.getByTestId("drawing-selection-summary").textContent).toMatch(/3 shapes · 2 selected/);

    // Shift-click marker 1 again → removes from selection (toggle).
    dispatchPointerDown(m1, { shiftKey: true });
    await waitFor(() => {
      expect(m1).toHaveAttribute("data-selected", "false");
    });

    // Shift-click marker 1 then marker 2 to build a 3-marker selection.
    dispatchPointerDown(m1, { shiftKey: true });
    dispatchPointerDown(m2, { shiftKey: true });
    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent).toMatch(/3 shapes · 3 selected/);
    });

    // Group drag: stub the strip's getBoundingClientRect so x→time math
    // produces a deterministic delta, then drag marker 0 by half the strip
    // (= dur/2 = 2s). All three markers were at t=0, so they should all
    // end up at t=2s — verified by the marker's left% (2/4 = 50%).
    const strip = inDialog.getByTestId("drawing-timeline-strip");
    Object.defineProperty(strip, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 200, bottom: 24, width: 200, height: 24, x: 0, y: 0, toJSON: () => ({}) }),
    });
    // Plain pointerdown on marker 0 (no shift) keeps the multi-selection
    // because marker 0 is part of it, then we drag to the strip midpoint.
    dispatchPointerDown(m0, { shiftKey: false, clientX: 0 });
    const moveEv = new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 0 });
    window.dispatchEvent(moveEv);
    const upEv = new MouseEvent("pointerup", { bubbles: true });
    window.dispatchEvent(upEv);
    await waitFor(() => {
      // All three markers should now be at the 50% position.
      for (const m of [m0, m1, m2]) {
        expect((m as HTMLElement).style.left).toBe("50%");
      }
    });
  });

  it("box-select on the timeline strip selects every marker in the swept time range (Task #1415)", async () => {
    installFetch();
    const { user, dialog } = await openDialog();
    const inDialog = within(dialog);

    // Seed videoDuration so the timeline strip renders markers.
    const video = dialog.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 4 });
    fireEvent(video, new Event("loadedmetadata"));

    const canvas = dialog.querySelector("canvas") as HTMLCanvasElement;

    // Draw three line shapes (each is auto-stamped at videoTime=0 in jsdom).
    // We can't move videoTime in jsdom, but we can backdate the marker
    // positions by reaching in via the rendered marker `left%` — the
    // shapes' `t` is what's rendered. Instead, we'll spread shape times
    // by rapidly drawing then nudging shape +1f between each, which
    // doesn't work in jsdom either. So we just verify that with all
    // three at t=0, a box-drag spanning the whole strip selects all 3
    // (range [0..dur] always includes t=0), and a box-drag spanning the
    // last 25% (t in [3..4]) selects none.
    await user.click(inDialog.getByRole("button", { name: "line" }));
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 30, clientY: 30 });
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 60, clientY: 30 });
    fireEvent.mouseDown(canvas, { clientX: 70, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 90, clientY: 30 });

    await waitFor(() => {
      expect(inDialog.getByText(/^3 shapes$/)).toBeInTheDocument();
    });

    const strip = inDialog.getByTestId("drawing-timeline-strip");
    Object.defineProperty(strip, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 200, bottom: 24, width: 200, height: 24, x: 0, y: 0, toJSON: () => ({}) }),
    });

    // Helper for jsdom-honoured pointerdown on the strip background.
    const stripPointerDown = (opts: { shiftKey?: boolean; clientX?: number } = {}) => {
      const ev = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        shiftKey: opts.shiftKey ?? false,
        clientX: opts.clientX ?? 0,
        clientY: 0,
      });
      strip.dispatchEvent(ev);
    };

    // Box-drag from x=0 to x=200 (full strip = full time range): selects all 3.
    stripPointerDown({ shiftKey: false, clientX: 0 });
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 200, clientY: 0 }));
    // Selection rectangle is visible mid-drag.
    await inDialog.findByTestId("drawing-timeline-box-select");
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent).toMatch(/3 shapes · 3 selected/);
    });
    // Rectangle hides on release.
    expect(inDialog.queryByTestId("drawing-timeline-box-select")).toBeNull();

    // Box-drag from x=150 to x=200 (last 25% = t in [3..4]): none of the
    // t=0 markers fall in that range, so the swept selection becomes empty.
    // (No shift = base selection is empty.)
    stripPointerDown({ shiftKey: false, clientX: 150 });
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 200, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent).toMatch(/^3 shapes$/);
    });

    // Shift + box-drag extends an existing selection: first single-select
    // marker 0 via plain pointer-down, then shift-box-drag the empty range
    // x=150..200 — the prior selection is preserved (no markers in range
    // are added, but marker 0 stays selected).
    const m0 = inDialog.getByTestId("drawing-marker-0");
    const dispatchPointerDown = (el: Element, opts: { shiftKey?: boolean; clientX?: number } = {}) => {
      const ev = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        shiftKey: opts.shiftKey ?? false,
        clientX: opts.clientX ?? 0,
        clientY: 0,
      });
      el.dispatchEvent(ev);
    };
    dispatchPointerDown(m0, { shiftKey: false });
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent).toMatch(/3 shapes · 1 selected/);
    });

    stripPointerDown({ shiftKey: true, clientX: 150 });
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 200, clientY: 0 }));
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    // Marker 0 is still selected because the shift-drag extended (and the
    // sweep range [3..4] adds no new markers).
    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent).toMatch(/3 shapes · 1 selected/);
    });
  });

  it("duplicate group copies every selected drawing to the playhead, preserving relative offsets (Task #1416)", async () => {
    installFetch();
    const { user, dialog } = await openDialog();
    const inDialog = within(dialog);

    // Same setup as the Task #1216 multi-select test: jsdom doesn't fire
    // loadedmetadata for our stub URL, so seed duration manually so the
    // timeline strip renders markers we can shift-click on.
    const video = dialog.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    fireEvent(video, new Event("loadedmetadata"));

    // Make `currentTime` writable so we can step the playhead between
    // draws to give each shape a distinct `t` value (the source `t`s are
    // what lets us verify relative-offset preservation).
    let currentTime = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (v: number) => { currentTime = v; },
    });

    const canvas = dialog.querySelector("canvas") as HTMLCanvasElement;
    await user.click(inDialog.getByRole("button", { name: "line" }));

    // Draw shape 0 at t=1 and shape 1 at t=3 (relative offset = 2s).
    currentTime = 1;
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 30, clientY: 30 });
    currentTime = 3;
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 60, clientY: 30 });

    await waitFor(() => {
      expect(inDialog.getByText(/^2 shapes$/)).toBeInTheDocument();
    });

    // Multi-select both markers via shift-click (mirrors the pattern used
    // by the Task #1216 test — fireEvent doesn't honour shiftKey on
    // PointerEvent in jsdom, so we hand-build a MouseEvent with the right
    // type so React's onPointerDown listener fires).
    const dispatchPointerDown = (el: Element, opts: { shiftKey?: boolean } = {}) => {
      const ev = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        shiftKey: opts.shiftKey ?? false,
        clientX: 0,
        clientY: 0,
      });
      el.dispatchEvent(ev);
    };
    const m0 = inDialog.getByTestId("drawing-marker-0");
    const m1 = inDialog.getByTestId("drawing-marker-1");
    dispatchPointerDown(m0, { shiftKey: false });
    fireEvent.pointerUp(window);
    dispatchPointerDown(m1, { shiftKey: true });
    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent)
        .toMatch(/2 shapes · 2 selected/);
    });

    // Scrub the playhead to t=5 and click "Duplicate group". The
    // earliest selected marker (t=1) should anchor at the new playhead,
    // and the second copy should land at 5 + (3-1) = 7. The freshly
    // pasted copies become the active selection (per the task spec —
    // coaches can immediately re-time or delete them).
    currentTime = 5;
    await user.click(inDialog.getByRole("button", { name: /^Duplicate group$/i }));

    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent)
        .toMatch(/4 shapes · 2 selected/);
    });

    // Verify positions on the timeline strip. Marker left% is t/dur*100,
    // so with duration=10 we expect:
    //   marker 2 (first paste)  → 5/10 = 50%
    //   marker 3 (second paste) → 7/10 = 70%
    const m2 = inDialog.getByTestId("drawing-marker-2");
    const m3 = inDialog.getByTestId("drawing-marker-3");
    expect((m2 as HTMLElement).style.left).toBe("50%");
    expect((m3 as HTMLElement).style.left).toBe("70%");
    // And the originals stayed put.
    expect((m0 as HTMLElement).style.left).toBe("10%");
    expect((m1 as HTMLElement).style.left).toBe("30%");
    // Only the new copies are selected.
    expect(m0).toHaveAttribute("data-selected", "false");
    expect(m1).toHaveAttribute("data-selected", "false");
    expect(m2).toHaveAttribute("data-selected", "true");
    expect(m3).toHaveAttribute("data-selected", "true");
  });

  it("Cmd/Ctrl+D triggers duplicate group when shapes are selected (Task #1416)", async () => {
    installFetch();
    const { user, dialog } = await openDialog();
    const inDialog = within(dialog);

    const video = dialog.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    fireEvent(video, new Event("loadedmetadata"));
    let currentTime = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (v: number) => { currentTime = v; },
    });

    const canvas = dialog.querySelector("canvas") as HTMLCanvasElement;
    await user.click(inDialog.getByRole("button", { name: "line" }));
    currentTime = 2;
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 30, clientY: 30 });

    // Single-select the marker.
    const dispatchPointerDown = (el: Element, opts: { shiftKey?: boolean } = {}) => {
      const ev = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        shiftKey: opts.shiftKey ?? false,
        clientX: 0, clientY: 0,
      });
      el.dispatchEvent(ev);
    };
    dispatchPointerDown(inDialog.getByTestId("drawing-marker-0"));
    fireEvent.pointerUp(window);
    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent)
        .toMatch(/1 shape · 1 selected/);
    });

    // Scrub and press Ctrl+D — keyboard shortcut should duplicate.
    currentTime = 6;
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent)
        .toMatch(/2 shapes · 1 selected/);
    });
    const m1 = inDialog.getByTestId("drawing-marker-1");
    // The single copy lands directly at the playhead.
    expect((m1 as HTMLElement).style.left).toBe("60%");
  });

  // ------------------------------------------------------------------
  // Task #1712 / #2132 — Copy / Paste drawings clipboard.
  //
  // The clipboard is owned by the parent QueueTab, not the DeliverDialog,
  // so a Copy stash survives closing the dialog and opening a different
  // review later in the same session. Paste re-uses the offset-preserving
  // math from `duplicateGroupToCurrent` (Task #1416), promotes the freshly
  // pasted shapes to the active selection, and clamps every paste into
  // the new clip's [0, duration] window.
  //
  // The two cases below cover the full happy path described in the task
  // brief end-to-end at the React level (real <CoachWorkspacePage /> with
  // the real <DeliverDialog /> mounted/unmounted between reviews):
  //   1. "copy selection" — multi-select a subset, copy, close, open a
  //      different review, paste. Asserts relative offsets are preserved
  //      at the new playhead, the pastes become the active selection,
  //      and that selection-driven controls (Move-to-current-time +
  //      Delete shape) act on the pastes.
  //   2. "copy whole list (no selection)" — copy with nothing selected,
  //      close, open a review with a SHORTER clip, paste. Asserts every
  //      shape is copied and the second + third copies clamp to the new
  //      duration.
  //
  // Helpers shared by both cases ----------------------------------------
  function multiQueueItems() {
    return [
      { ...QUEUE_ITEM, request: { ...QUEUE_ITEM.request, id: 7 } },
      { ...QUEUE_ITEM, request: { ...QUEUE_ITEM.request, id: 8 } },
    ];
  }

  function installFetchWithMultiQueue() {
    return installFetch({
      "/api/swing-reviews/coach/queue": () =>
        jsonResponse({ queue: multiQueueItems() }),
    });
  }

  // Open a review whose card matches /Review #${id}/ — there are
  // multiple "Open" buttons on screen (one per queue card) so we have
  // to scope the search to the right card.
  async function openReview(id: number) {
    const card = (await screen.findByText(`Review #${id}`))
      .closest("div.bg-zinc-900") as HTMLElement | null;
    expect(card).not.toBeNull();
    const open = within(card!).getByRole("button", { name: /open/i });
    const user = userEvent.setup();
    await user.click(open);
    const dialog = await screen.findByTestId("deliver-dialog");
    // The dialog's heading carries the request id — confirm we opened
    // the correct one (regression guard for the within(card) lookup).
    expect(within(dialog).getByRole("heading", { name: `Review #${id}` })).toBeInTheDocument();
    return { user, dialog };
  }

  // Seed the dialog's <video> with a known duration + writable
  // currentTime so we can drive the playhead deterministically (jsdom
  // never fires loadedmetadata for our stub URL).
  function patchVideo(dialog: HTMLElement, duration: number) {
    const video = dialog.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: duration });
    fireEvent(video, new Event("loadedmetadata"));
    let currentTime = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (v: number) => { currentTime = v; },
    });
    return {
      video,
      setTime: (t: number) => { currentTime = t; },
    };
  }

  // Same hand-built MouseEvent pattern as the duplicate-group test —
  // jsdom drops `shiftKey` off React-synthesised PointerEvents, so we
  // dispatch a MouseEvent re-typed as 'pointerdown' that React 18 will
  // route through onPointerDown.
  function dispatchPointerDown(el: Element, opts: { shiftKey?: boolean } = {}) {
    el.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      shiftKey: opts.shiftKey ?? false,
      clientX: 0,
      clientY: 0,
    }));
  }

  // Draw N line shapes against the dialog's <canvas>, stamping each at
  // a distinct video time so we can verify offset preservation later.
  function drawLinesAt(
    dialog: HTMLElement,
    setTime: (t: number) => void,
    times: number[],
  ) {
    const canvas = dialog.querySelector("canvas") as HTMLCanvasElement;
    times.forEach((t, i) => {
      setTime(t);
      // Spread x coordinates so the shapes have visually-distinct
      // payloads (matters when we assert Delete actually removes
      // them — the shape array's content has to look different from
      // its post-delete state).
      const x = 10 + i * 30;
      fireEvent.mouseDown(canvas, { clientX: x, clientY: 10 });
      fireEvent.mouseUp(canvas, { clientX: x + 20, clientY: 30 });
    });
  }

  it("Copy/Paste drawings (selection branch): clipboard survives close + reopen, pastes at new playhead with offsets preserved, and the pastes become the active selection", async () => {
    installFetchWithMultiQueue();
    render(<CoachWorkspacePage />);

    // ---- Open Review #7, draw three shapes at t=1/3/5 -------------
    const first = await openReview(7);
    const seven = patchVideo(first.dialog, 10);
    const inFirst = within(first.dialog);
    await first.user.click(inFirst.getByRole("button", { name: "line" }));
    drawLinesAt(first.dialog, seven.setTime, [1, 3, 5]);
    await waitFor(() => {
      expect(inFirst.getByText(/^3 shapes$/)).toBeInTheDocument();
    });

    // ---- Multi-select markers 0 and 1 (the t=1 and t=3 shapes) ----
    const m0 = inFirst.getByTestId("drawing-marker-0");
    const m1 = inFirst.getByTestId("drawing-marker-1");
    dispatchPointerDown(m0, { shiftKey: false });
    fireEvent.pointerUp(window);
    dispatchPointerDown(m1, { shiftKey: true });
    await waitFor(() => {
      expect(inFirst.getByTestId("drawing-selection-summary").textContent)
        .toMatch(/3 shapes · 2 selected/);
    });

    // ---- Copy → close → confirm dialog unmounted ------------------
    // The Paste button on this dialog should also flip from disabled to
    // enabled now that the parent's clipboard has 2 entries.
    const copyBtn = inFirst.getByTestId("drawing-copy");
    const pasteOnFirst = inFirst.getByTestId("drawing-paste");
    expect(pasteOnFirst).toBeDisabled();
    await first.user.click(copyBtn);
    await waitFor(() => {
      expect((inFirst.getByTestId("drawing-paste") as HTMLButtonElement).disabled)
        .toBe(false);
      expect(inFirst.getByTestId("drawing-paste").textContent)
        .toMatch(/Paste drawings \(2\)/);
    });
    await first.user.click(inFirst.getByRole("button", { name: /^Close$/ }));
    await waitFor(() => {
      expect(screen.queryByTestId("deliver-dialog")).toBeNull();
    });

    // ---- Open Review #8, scrub to t=4, paste ---------------------
    // Different DeliverDialog instance → its own shapes/selectedIdxs
    // start empty. The clipboard is owned by the parent and survives.
    const second = await openReview(8);
    const eight = patchVideo(second.dialog, 10);
    const inSecond = within(second.dialog);
    // Sanity: the new dialog starts with no shapes.
    expect(inSecond.getByText(/^0 shapes$/)).toBeInTheDocument();
    // Paste button should already show "(2)" because the clipboard
    // survived the close.
    const pasteOnSecond = inSecond.getByTestId("drawing-paste");
    expect((pasteOnSecond as HTMLButtonElement).disabled).toBe(false);
    expect(pasteOnSecond.textContent).toMatch(/Paste drawings \(2\)/);

    eight.setTime(4);
    await second.user.click(pasteOnSecond);

    // Two shapes pasted; both freshly selected. Marker positions:
    //   minT in clipboard = 1 (t=1 from review #7's m0).
    //   target = 4.
    //   copy 0: t = 4 + (1 - 1) = 4 → 40%
    //   copy 1: t = 4 + (3 - 1) = 6 → 60%
    await waitFor(() => {
      expect(inSecond.getByTestId("drawing-selection-summary").textContent)
        .toMatch(/2 shapes · 2 selected/);
    });
    const p0 = inSecond.getByTestId("drawing-marker-0");
    const p1 = inSecond.getByTestId("drawing-marker-1");
    expect(p0.style.left).toBe("40%");
    expect(p1.style.left).toBe("60%");
    expect(p0).toHaveAttribute("data-selected", "true");
    expect(p1).toHaveAttribute("data-selected", "true");

    // ---- Verify selection-driven controls operate on the pastes ---
    // Move-to-current-time should re-time both pasted shapes to the
    // new playhead, collapsing them onto the same marker position.
    eight.setTime(8);
    await second.user.click(inSecond.getByRole("button", { name: /^Move to current time$/ }));
    await waitFor(() => {
      expect(inSecond.getByTestId("drawing-marker-0").style.left).toBe("80%");
      expect(inSecond.getByTestId("drawing-marker-1").style.left).toBe("80%");
    });
    // Delete shape removes every selected shape — both pastes go away
    // and the dialog returns to "0 shapes" with no selection summary.
    await second.user.click(inSecond.getByRole("button", { name: /^Delete shape$/ }));
    await waitFor(() => {
      expect(inSecond.getByText(/^0 shapes$/)).toBeInTheDocument();
    });
    // No more markers on the strip either (sanity guard).
    expect(inSecond.queryByTestId("drawing-marker-0")).toBeNull();
    expect(inSecond.queryByTestId("drawing-marker-1")).toBeNull();
  });

  it("Copy/Paste drawings (no-selection branch): copy stashes the whole list and paste clamps shapes into the new clip's duration", async () => {
    installFetchWithMultiQueue();
    render(<CoachWorkspacePage />);

    // ---- Open Review #7, draw three shapes at t=1/3/5 (10s clip) --
    const first = await openReview(7);
    const seven = patchVideo(first.dialog, 10);
    const inFirst = within(first.dialog);
    await first.user.click(inFirst.getByRole("button", { name: "line" }));
    drawLinesAt(first.dialog, seven.setTime, [1, 3, 5]);
    await waitFor(() => {
      expect(inFirst.getByText(/^3 shapes$/)).toBeInTheDocument();
    });
    // Defensive: drawing doesn't auto-select, so the selection summary
    // has no "selected" suffix here. This is what triggers the
    // "no selection → copy whole list" branch in copyDrawings.
    expect(inFirst.getByTestId("drawing-selection-summary").textContent)
      .toMatch(/^3 shapes$/);

    // ---- Copy → close ---------------------------------------------
    await first.user.click(inFirst.getByTestId("drawing-copy"));
    await waitFor(() => {
      expect(inFirst.getByTestId("drawing-paste").textContent)
        .toMatch(/Paste drawings \(3\)/);
    });
    await first.user.click(inFirst.getByRole("button", { name: /^Close$/ }));
    await waitFor(() => {
      expect(screen.queryByTestId("deliver-dialog")).toBeNull();
    });

    // ---- Open Review #8 with a SHORTER clip (5s) and paste at t=2 -
    const second = await openReview(8);
    const eight = patchVideo(second.dialog, 5);
    const inSecond = within(second.dialog);
    eight.setTime(2);
    await second.user.click(inSecond.getByTestId("drawing-paste"));

    // Three pastes; minT in clipboard = 1, target = 2.
    //   copy 0: t = 2 + (1 - 1) = 2  → unclamped → 2/5 = 40%
    //   copy 1: t = 2 + (3 - 1) = 4  → unclamped → 4/5 = 80%
    //   copy 2: t = 2 + (5 - 1) = 6  → CLAMPED to 5 → 5/5 = 100%
    // All three become the active selection.
    await waitFor(() => {
      expect(inSecond.getByTestId("drawing-selection-summary").textContent)
        .toMatch(/3 shapes · 3 selected/);
    });
    const m0 = inSecond.getByTestId("drawing-marker-0");
    const m1 = inSecond.getByTestId("drawing-marker-1");
    const m2 = inSecond.getByTestId("drawing-marker-2");
    expect(m0.style.left).toBe("40%");
    expect(m1.style.left).toBe("80%");
    expect(m2.style.left).toBe("100%");
    for (const m of [m0, m1, m2]) {
      expect(m).toHaveAttribute("data-selected", "true");
    }
  });

  it("voice-over Record → Stop uploads the audio blob and shows the ready confirmation", async () => {
    // Mock getUserMedia to return a stub stream.
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream) },
    });

    // Mock MediaRecorder with start/stop hooks that fire ondataavailable
    // + onstop synchronously on stop().
    let onstop: (() => void) | null = null;
    let ondataavailable: ((ev: { data: Blob }) => void) | null = null;
    class MockMediaRecorder {
      set ondataavailable(fn: (ev: { data: Blob }) => void) { ondataavailable = fn; }
      set onstop(fn: () => void) { onstop = fn; }
      start() {}
      stop() {
        ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }) });
        onstop?.();
      }
    }
    (globalThis as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder =
      MockMediaRecorder as unknown as typeof MediaRecorder;

    const putCalls: FetchCall[] = [];
    installFetch({
      "/api/swing-videos/upload-url": () =>
        jsonResponse({
          uploadUrl: "https://example.test/upload-target",
          objectPath: "uploads/voice-1.webm",
          uploadToken: "tok-abc",
          uploadTokenExp: 1234567890,
        }),
      "https://example.test/upload-target": (init) => {
        putCalls.push({ url: "https://example.test/upload-target", init });
        return jsonResponse({}, true);
      },
    });

    const { user, dialog } = await openDialog();
    const inDialog = within(dialog);

    await user.click(inDialog.getByRole("button", { name: /Record/ }));
    // Once recording starts the button label changes to Stop.
    const stopBtn = await inDialog.findByRole("button", { name: /Stop/ });
    await user.click(stopBtn);

    await waitFor(() => {
      expect(inDialog.getByText(/Voice-over ready/i)).toBeInTheDocument();
    });

    // The PUT to the signed upload URL must have happened with the audio blob.
    expect(putCalls.length).toBe(1);
    expect(putCalls[0].init?.method).toBe("PUT");
    expect((putCalls[0].init?.headers as Record<string, string>)["Content-Type"]).toBe("audio/webm");
    expect(putCalls[0].init?.body).toBeInstanceOf(Blob);
  });
});

/**
 * Task #1220 — UI coverage for the payout re-verification banner that
 * lives in `PayoutAccountSection` (rendered inside the Profile tab of
 * the Coach Workspace). Task #1061 introduced the banner but shipped
 * without any tests, so a regression could silently leave coaches
 * unaware that their payout account needs attention.
 *
 * The banner reads `profile.payoutVerificationStatus === 'needs_attention'`
 * and surfaces:
 *   - the failure reason (`profile.payoutVerificationFailureReason`)
 *   - a `button-payout-needs-attention-fix` CTA that opens the inline
 *     payout-account editor (so the coach can re-verify on the spot).
 */
describe("CoachWorkspacePage payout re-verification banner (Task #1220)", () => {
  function installFetchWithProfile(profileExtras: Record<string, unknown>) {
    const calls: FetchCall[] = [];
    const profile = { ...PROFILE, ...profileExtras };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, init });
        if (url.endsWith("/api/coach-marketplace/me/coach-profile")) {
          return jsonResponse({ pro: PRO, profile });
        }
        if (url.endsWith("/api/swing-reviews/coach/queue")) {
          return jsonResponse({ queue: [QUEUE_ITEM] });
        }
        if (url.endsWith("/api/swing-reviews/coach/earnings")) {
          return jsonResponse(EARNINGS);
        }
        if (url.endsWith("/api/swing-reviews/coach/notifications")) {
          return jsonResponse({ notifications: [] });
        }
        if (url.endsWith("/api/coach-marketplace/me/payout-account/history")) {
          return jsonResponse({ history: [] });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch,
    );
    return calls;
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the banner with the failure reason and opens the editor when the CTA is clicked", async () => {
    installFetchWithProfile({
      payoutMethod: "upi",
      payoutAccountId: "fa_existing",
      payoutAccountHolderName: "Test Coach",
      payoutVpa: "test@bank",
      payoutVerificationStatus: "needs_attention",
      payoutVerificationFailureReason: "VPA inactive at upstream bank",
    });

    render(<CoachWorkspacePage />);
    // Wait for the queue to finish loading so we know /coach-profile resolved.
    await screen.findByText("Review #7");

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Profile/i }));

    const banner = await screen.findByTestId("banner-payout-needs-attention");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/Your payout account needs re-verification/i);
    expect(banner).toHaveTextContent(/VPA inactive at upstream bank/);

    // The inline editor is hidden until the CTA is clicked — the
    // "Verify account" submit button (distinct from the banner's
    // "Re-verify account" CTA) and the "Account holder name" field
    // are gated by `editing === true`.
    expect(screen.queryByRole("button", { name: /^Verify account$/i })).toBeNull();
    expect(screen.queryByText(/Account holder name/i)).toBeNull();

    await user.click(screen.getByTestId("button-payout-needs-attention-fix"));

    // Editor opens — the verify button and the account-holder field appear,
    // and the CTA inside the banner is removed (since `editing` is now true).
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Verify account$/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Account holder name/i)).toBeInTheDocument();
    expect(screen.queryByTestId("button-payout-needs-attention-fix")).toBeNull();
  });

  it("does not render the banner when the payout verification status is verified", async () => {
    installFetchWithProfile({
      payoutMethod: "upi",
      payoutAccountId: "fa_existing",
      payoutAccountHolderName: "Test Coach",
      payoutVpa: "test@bank",
      payoutVerificationStatus: "verified",
      payoutVerificationFailureReason: null,
    });

    render(<CoachWorkspacePage />);
    await screen.findByText("Review #7");

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Profile/i }));

    // Wait for the Profile tab to actually render the payout section so we
    // know the absent-banner assertion is meaningful (not just "still loading").
    // The "Update" button only renders inside PayoutAccountSection when the
    // tab is mounted and the profile has a payout account on file.
    await screen.findByRole("button", { name: /^Update$/ });
    expect(screen.queryByTestId("banner-payout-needs-attention")).toBeNull();
    expect(screen.queryByTestId("button-payout-needs-attention-fix")).toBeNull();
  });
});

