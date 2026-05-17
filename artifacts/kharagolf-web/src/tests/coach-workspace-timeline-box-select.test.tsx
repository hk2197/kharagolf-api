/**
 * End-to-end coverage for Task #1708 — the coach Deliver-dialog
 * timeline box-select gesture (originally added in Task #1415).
 *
 * Task #1415 shipped with a vitest unit test (in
 * `coach-workspace.test.tsx`) that asserts the basics — sweep the
 * whole strip → all markers selected, sweep an empty range → no
 * markers selected — but it draws every shape at videoTime=0,
 * so it can only ever exercise "all-or-none" hit testing. The
 * gesture's real value is selecting a subset, asserting the
 * canvas-overlay highlights track the swept range, and the
 * shift-extend variant adding to (not replacing) the prior
 * selection.
 *
 * This test renders the full <CoachWorkspacePage> with stubbed
 * auth/queue endpoints, opens the Deliver dialog for a queued
 * review, spreads three drawings across the timeline (by scrubbing
 * the video to distinct timestamps before each draw via the visible
 * "Video scrubber" input), and then exercises the box-select
 * gesture against a partial range:
 *
 *   1. A plain box-drag from x=0 to x=120 on the strip (where the
 *      strip's stubbed width is 200 and dur=10) sweeps the time
 *      range [0..6]s — this hits the t=1s and t=4s markers but
 *      not the t=8s marker. Assertions:
 *        - `drawing-timeline-box-select` rectangle is mounted
 *          mid-drag with the swept pixel width (canvas-overlay
 *          highlight #1).
 *        - `drawing-selection-summary` reads "3 shapes · 2 selected".
 *        - `drawing-marker-0` and `-1` have data-selected="true",
 *          `-2` has data-selected="false" (canvas-overlay highlight
 *          #2 — the cyan border + glow on each marker is driven by
 *          the same `selectedIdxs` state).
 *        - The selection rectangle unmounts on pointerup.
 *
 *   2. A shift+box-drag from x=140 to x=200 sweeps t in [7..10]s,
 *      which adds the t=8s marker. Assertions:
 *        - Summary reads "3 shapes · 3 selected" (shift EXTENDED
 *          the prior [0,1] selection rather than replacing it).
 *        - All three markers report data-selected="true".
 *
 *   3. A plain (unshifted) box-drag in an empty stretch
 *      (x=180..200, t in [9..10]s) REPLACES the selection.
 *      Assertions:
 *        - Summary reads "3 shapes" (no "K selected" suffix).
 *        - All three markers report data-selected="false".
 *
 * The end-to-end shape goes beyond what the existing test covers
 * by exercising the partial-range hit test, the shift-extend "adds
 * new" half (not just "preserves prior over an empty sweep"), and
 * the live box-select rectangle's pixel-width while the gesture
 * is in flight — all of which are the regressions a hit-testing
 * change, layout drift, or pointer-event upstream upgrade would
 * silently break.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CoachWorkspacePage from "@/pages/coach-workspace";

// jsdom does not implement HTMLCanvasElement.getContext; the workspace
// canvas is purely decorative for these assertions, so install a no-op
// 2D context per-test.
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
  displayName: "BoxSelect Coach",
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
    memberPrompt: "BoxSelect E2E — please review my driver swing.",
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

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
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
}

async function openDialog() {
  render(<CoachWorkspacePage />);
  await screen.findByText("Review #7");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /open/i }));
  const dialog = await screen.findByTestId("deliver-dialog");
  return { user, dialog };
}

/**
 * Make the dialog's <video> report the duration we want and back its
 * `currentTime` with a settable backing store (jsdom's default getter
 * always returns 0 and the setter is a no-op without a real source).
 *
 * Returns a `setTime(n)` helper the test calls between drawings to
 * advance the playhead — the canvas mouseUp handler stamps each new
 * shape's `t` from `videoRef.current?.currentTime`, so this is what
 * spreads the markers across the timeline strip.
 */
function installVideoStub(dialog: HTMLElement, durationSeconds: number) {
  const video = dialog.querySelector("video") as HTMLVideoElement;
  expect(video).not.toBeNull();
  let currentTimeBacking = 0;
  Object.defineProperty(video, "duration", {
    configurable: true,
    get: () => durationSeconds,
  });
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => currentTimeBacking,
    set: (v: number) => { currentTimeBacking = v; },
  });
  fireEvent(video, new Event("loadedmetadata"));
  return {
    video,
    setTime: (t: number) => { currentTimeBacking = t; },
  };
}

/**
 * fireEvent's `{ shiftKey: true }` init is not honoured by jsdom's
 * PointerEvent, so build the event by hand. We use a MouseEvent
 * (which jsdom does honour for shiftKey + clientX) and rename its
 * type to 'pointerdown' / 'pointermove' / 'pointerup' — React 18's
 * onPointerDown listener fires for any event whose .type matches.
 */
function pointerEvent(
  type: "pointerdown" | "pointermove" | "pointerup",
  opts: { shiftKey?: boolean; clientX?: number } = {},
) {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    shiftKey: opts.shiftKey ?? false,
    clientX: opts.clientX ?? 0,
    clientY: 0,
  });
}

describe("Coach workspace — Deliver dialog timeline box-select (Task #1708 e2e)", () => {
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

  it("partial sweep selects only the markers in range, shift extends, and the rectangle reflects the swept pixel width", async () => {
    installFetch();
    const { user, dialog } = await openDialog();
    const inDialog = within(dialog);

    // Stage 1 — make the timeline strip render markers at known
    // times. dur=10s means each second maps to 20px on the
    // (stubbed-width=200) strip; markers will land at 10%, 40%, 80%.
    const { setTime } = installVideoStub(dialog, 10);
    const canvas = dialog.querySelector("canvas") as HTMLCanvasElement;

    // Stage 2 — pick the line tool and draw three shapes spread
    // across the timeline (t = 1s, 4s, 8s).
    await user.click(inDialog.getByRole("button", { name: "line" }));

    setTime(1);
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 30, clientY: 30 });

    setTime(4);
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 60, clientY: 30 });

    setTime(8);
    fireEvent.mouseDown(canvas, { clientX: 70, clientY: 10 });
    fireEvent.mouseUp(canvas, { clientX: 90, clientY: 30 });

    await waitFor(() => {
      expect(inDialog.getByText(/^3 shapes$/)).toBeInTheDocument();
    });

    const m0 = inDialog.getByTestId("drawing-marker-0") as HTMLElement;
    const m1 = inDialog.getByTestId("drawing-marker-1") as HTMLElement;
    const m2 = inDialog.getByTestId("drawing-marker-2") as HTMLElement;

    // Markers render at `${(t / dur) * 100}%`. With t = 1/4/8 and
    // dur=10 those resolve to 10% / 40% / 80%. (These percentages are
    // what the canvas-overlay highlights on the strip use to position
    // each marker, so asserting them here confirms the spread.)
    expect(m0.style.left).toBe("10%");
    expect(m1.style.left).toBe("40%");
    expect(m2.style.left).toBe("80%");

    // All markers start unselected.
    expect(m0).toHaveAttribute("data-selected", "false");
    expect(m1).toHaveAttribute("data-selected", "false");
    expect(m2).toHaveAttribute("data-selected", "false");

    // Stage 3 — stub the strip's getBoundingClientRect so the box-
    // select hit test resolves x→t deterministically. width=200,
    // dur=10 → 20px per second; markers at t=1/4/8 sit at x=20/80/160
    // pixels (their selection bucket is purely time-based, computed
    // as `(x / width) * dur`).
    const strip = inDialog.getByTestId("drawing-timeline-strip");
    Object.defineProperty(strip, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0, top: 0, right: 200, bottom: 24,
        width: 200, height: 24, x: 0, y: 0, toJSON: () => ({}),
      }),
    });

    // Stage 4 — plain box-drag from x=0 to x=120 (covers t in [0..6]).
    // Markers 0 (t=1) and 1 (t=4) fall inside; marker 2 (t=8) does
    // not. Assert the live rectangle is mounted mid-drag with the
    // swept pixel width, then assert per-marker `data-selected`
    // after release.
    strip.dispatchEvent(pointerEvent("pointerdown", { shiftKey: false, clientX: 0 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 120 }));

    const rect = await inDialog.findByTestId("drawing-timeline-box-select");
    // The rectangle's inline style sets left = min(start, current) and
    // width = |current - start|. Drag was 0 → 120, so width=120, left=0.
    // jsdom serialises numeric inline styles as "120px".
    expect((rect as HTMLElement).style.left).toBe("0px");
    expect((rect as HTMLElement).style.width).toBe("120px");

    window.dispatchEvent(pointerEvent("pointerup"));

    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent)
        .toMatch(/^3 shapes · 2 selected$/);
    });
    expect(m0).toHaveAttribute("data-selected", "true");
    expect(m1).toHaveAttribute("data-selected", "true");
    expect(m2).toHaveAttribute("data-selected", "false");
    // Rectangle hides on release (boxSelect state cleared).
    expect(inDialog.queryByTestId("drawing-timeline-box-select")).toBeNull();

    // Stage 5 — shift+box-drag from x=140 to x=200 (covers t in [7..10]).
    // Marker 2 (t=8) is the only one in this range. With shift held the
    // prior [0,1] selection MUST be preserved AND marker 2 added (the
    // existing test only covers "shift over an empty range preserves
    // prior" — this asserts the "shift adds newly swept" half).
    strip.dispatchEvent(pointerEvent("pointerdown", { shiftKey: true, clientX: 140 }));
    window.dispatchEvent(pointerEvent("pointermove", { shiftKey: true, clientX: 200 }));
    window.dispatchEvent(pointerEvent("pointerup", { shiftKey: true }));

    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent)
        .toMatch(/^3 shapes · 3 selected$/);
    });
    expect(m0).toHaveAttribute("data-selected", "true");
    expect(m1).toHaveAttribute("data-selected", "true");
    expect(m2).toHaveAttribute("data-selected", "true");

    // Stage 6 — plain (unshifted) box-drag in an empty stretch
    // (x=180..200 → t in [9..10]). No markers are in range and shift
    // is NOT held, so the prior selection MUST be cleared entirely.
    strip.dispatchEvent(pointerEvent("pointerdown", { shiftKey: false, clientX: 180 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 200 }));
    window.dispatchEvent(pointerEvent("pointerup"));

    await waitFor(() => {
      expect(inDialog.getByTestId("drawing-selection-summary").textContent)
        .toMatch(/^3 shapes$/);
    });
    expect(m0).toHaveAttribute("data-selected", "false");
    expect(m1).toHaveAttribute("data-selected", "false");
    expect(m2).toHaveAttribute("data-selected", "false");
  });
});
