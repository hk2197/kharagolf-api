/**
 * Task #1711 — mobile equivalent coverage for the Deliver-modal
 * "Duplicate group" action introduced in Task #1416.
 *
 * The mobile CoachDeliverModal lives inside `app/(tabs)/coach.tsx` and
 * its drawing UI is driven by React Native PanResponder gestures, which
 * are not faithfully reproducible inside vitest+jsdom. To keep this
 * test focused on the duplicate-group MATH (which is the actual Task
 * #1416 surface) we exercise the pure helper that the production
 * `duplicateGroupToCurrent` callback delegates to:
 *
 *   computeDuplicateGroupShapes(shapes, selectedIdxs, target, duration)
 *     → { shapes: nextShapes, selectedIdxs: newSelection }
 *
 * The helper is the single source of truth for both the mobile coach
 * Deliver modal button (≈ coach.tsx L3177) and the underlying setShapes
 * callback (≈ coach.tsx L2846), so a regression in either path lights
 * up here.
 *
 * Mirrors the canonical web vitest coverage at
 * `artifacts/kharagolf-web/src/tests/coach-workspace.test.tsx`
 * (the two Task #1416 cases starting at line 458) — same scenario,
 * same expected positions, same selected-after-paste behaviour.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// Heavy native modules that `app/(tabs)/coach.tsx` pulls in at the top
// of the file. None of them are exercised by `computeDuplicateGroupShapes`
// (it's a pure helper) but they have to resolve to *something* so the
// import does not throw under jsdom + react-native-web. Mirrors the
// mock set used by `payout-needs-attention-banner.test.tsx`.
vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
}));
vi.mock("expo-av", () => ({
  Video: () => null,
  ResizeMode: { COVER: "cover", CONTAIN: "contain" },
  Audio: { Sound: class {} },
}));
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: async () => ({ canceled: true }),
  launchCameraAsync: async () => ({ canceled: true }),
  MediaTypeOptions: { Images: "Images", Videos: "Videos", All: "All" },
  requestCameraPermissionsAsync: async () => ({ granted: true }),
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
}));
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/",
  cacheDirectory: "file:///cache/",
  getInfoAsync: async () => ({ exists: false }),
  downloadAsync: async () => ({ uri: "" }),
  deleteAsync: async () => {},
  uploadAsync: async () => ({ status: 200, body: "{}" }),
  FileSystemUploadType: { BINARY_CONTENT: 0 },
}));
vi.mock("react-native-svg", () => {
  const passthrough = (tag: string) =>
    React.forwardRef<Element, { children?: React.ReactNode }>(({ children, ...rest }, ref) =>
      React.createElement(tag, { ...rest, ref }, children),
    );
  const Svg = passthrough("svg");
  return {
    __esModule: true,
    default: Svg,
    Svg,
    Line: passthrough("line"),
    Circle: passthrough("circle"),
    Polyline: passthrough("polyline"),
    Path: passthrough("path"),
    Rect: passthrough("rect"),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 42, organizationId: 9 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));
vi.mock("@/utils/api", () => ({
  BASE_URL: "",
}));

import { computeDuplicateGroupShapes } from "../app/(tabs)/coach";

type DrawShape =
  | { kind: "line"; t: number; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: "arrow"; t: number; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: "circle"; t: number; x: number; y: number; r: number; color: string }
  | { kind: "angle"; t: number; ax: number; ay: number; bx: number; by: number; cx: number; cy: number; color: string };

const line = (t: number, x1 = 10, y1 = 10, x2 = 30, y2 = 30): DrawShape => ({
  kind: "line",
  t,
  x1,
  y1,
  x2,
  y2,
  color: "#ffcc00",
});

const arrow = (t: number): DrawShape => ({
  kind: "arrow",
  t,
  x1: 5,
  y1: 5,
  x2: 25,
  y2: 25,
  color: "#00bfff",
});

describe("computeDuplicateGroupShapes (Task #1416 — mobile coach Deliver modal)", () => {
  it("copies every selected shape to the playhead, preserving relative offsets", () => {
    // Same scenario as the web vitest case at coach-workspace.test.tsx
    // L458: two shapes at t=1 and t=3 (relative offset = 2s), playhead
    // scrubbed to t=5, both shapes selected. Expect the earliest source
    // (t=1) anchored at the playhead and the second copy at 5+(3-1)=7.
    const shapes = [line(1), line(3)];
    const result = computeDuplicateGroupShapes(shapes, [0, 1], 5, 10);
    expect(result.shapes).toHaveLength(4);
    // Originals untouched — same array contents at the same indices.
    expect(result.shapes[0]).toEqual(shapes[0]);
    expect(result.shapes[1]).toEqual(shapes[1]);
    // Copies appended in source order, anchored at 5 and 5+2.
    expect(result.shapes[2].t).toBe(5);
    expect(result.shapes[3].t).toBe(7);
    // Copies preserve every other field of their source.
    expect(result.shapes[2]).toMatchObject({ kind: "line", x1: 10, x2: 30, color: "#ffcc00" });
    expect(result.shapes[3]).toMatchObject({ kind: "line", x1: 10, x2: 30, color: "#ffcc00" });
    // Freshly pasted copies become the active selection (so the coach
    // can immediately re-time or delete them — Task #1416 spec).
    expect(result.selectedIdxs).toEqual([2, 3]);
  });

  it("clamps copy times to [0, duration] so a paste near the end can't overrun the clip", () => {
    // Two shapes at t=2 and t=8 (offset = 6s), playhead scrubbed to
    // t=7 in a 10s clip. The first paste lands at 7, the second would
    // naturally land at 13 but must be clamped to 10.
    const shapes = [line(2), line(8)];
    const result = computeDuplicateGroupShapes(shapes, [0, 1], 7, 10);
    expect(result.shapes[2].t).toBe(7);
    expect(result.shapes[3].t).toBe(10);
    expect(result.selectedIdxs).toEqual([2, 3]);
  });

  it("clamps copy times to >= 0 when the playhead sits before the earliest selected source", () => {
    // Earliest source at t=5 with playhead at t=0 means the helper
    // shifts everything by -5; without the lower clamp the copy of t=5
    // would end up at 0 (fine) but a co-selected t=4 would land at -1.
    const shapes = [line(5), line(4)];
    const result = computeDuplicateGroupShapes(shapes, [0, 1], 0, 10);
    // sel order = [shapes[0], shapes[1]] = [t=5, t=4]; minT = 4.
    // First copy: max(0, min(10, 0 + (5-4))) = 1.
    // Second copy: max(0, min(10, 0 + (4-4))) = 0.
    expect(result.shapes[2].t).toBe(1);
    expect(result.shapes[3].t).toBe(0);
  });

  it("preserves the source kind (line / arrow / circle / angle) on every copy", () => {
    // Heterogeneous group — verify the spread copies every kind-specific
    // field, not just t. (Regression guard against a future refactor
    // that maps copies through a kind-agnostic helper.)
    const shapes: DrawShape[] = [
      line(1),
      arrow(2),
      { kind: "circle", t: 3, x: 50, y: 50, r: 10, color: "#ff66ff" },
      { kind: "angle", t: 4, ax: 0, ay: 0, bx: 5, by: 0, cx: 5, cy: 5, color: "#33ff99" },
    ];
    const result = computeDuplicateGroupShapes(shapes, [0, 1, 2, 3], 6, 20);
    // minT = 1, target = 6 → offsets become +5 across the board.
    expect(result.shapes).toHaveLength(8);
    expect(result.shapes[4]).toEqual({ ...shapes[0], t: 6 });
    expect(result.shapes[5]).toEqual({ ...shapes[1], t: 7 });
    expect(result.shapes[6]).toEqual({ ...shapes[2], t: 8 });
    expect(result.shapes[7]).toEqual({ ...shapes[3], t: 9 });
    expect(result.selectedIdxs).toEqual([4, 5, 6, 7]);
  });

  it("returns the original shapes reference + empty selection when nothing is selected", () => {
    // The production callback short-circuits on === so a no-op press
    // doesn't trigger a re-render; this assertion guards that contract.
    const shapes = [line(1), line(3)];
    const result = computeDuplicateGroupShapes(shapes, [], 5, 10);
    expect(result.shapes).toBe(shapes);
    expect(result.selectedIdxs).toEqual([]);
  });

  it("returns the original shapes reference when every selected index is out of range", () => {
    // Defensive guard — if the selection ref drifts out of bounds (e.g.
    // a delete-then-press race) the helper must not append `undefined`
    // copies or throw.
    const shapes = [line(1)];
    const result = computeDuplicateGroupShapes(shapes, [5, 6], 5, 10);
    expect(result.shapes).toBe(shapes);
    expect(result.selectedIdxs).toEqual([]);
  });

  it("treats a non-finite or zero duration as 'no upper clamp'", () => {
    // expo-av occasionally reports durationMillis=0 mid-load. In that
    // window the helper should still paste at `target + offset` rather
    // than collapsing every copy to t=0 (which would silently break
    // the action). Mirrors the inline `Number.isFinite(dur) && dur > 0`
    // check in `duplicateGroupToCurrent`.
    const shapes = [line(2), line(5)];
    const zeroResult = computeDuplicateGroupShapes(shapes, [0, 1], 100, 0);
    expect(zeroResult.shapes[2].t).toBe(100);
    expect(zeroResult.shapes[3].t).toBe(103);

    const nanResult = computeDuplicateGroupShapes(shapes, [0, 1], 100, Number.NaN);
    expect(nanResult.shapes[2].t).toBe(100);
    expect(nanResult.shapes[3].t).toBe(103);
  });

  it("supports a single-selection paste at the playhead (matches the Cmd/Ctrl+D scenario on web)", () => {
    // Task #1416's keyboard shortcut on web fires the SAME action
    // against a single-selection group; the mobile modal has no
    // keyboard surface but the underlying helper must still behave
    // correctly with selectedIdxs.length === 1.
    const shapes = [line(2)];
    const result = computeDuplicateGroupShapes(shapes, [0], 6, 10);
    expect(result.shapes).toHaveLength(2);
    expect(result.shapes[1].t).toBe(6);
    expect(result.selectedIdxs).toEqual([1]);
  });
});
