/**
 * Task #1711 — mobile equivalent of the web e2e flow that drives the
 * Deliver dialog through "Duplicate group". This test renders
 * `CoachDeliverModal` directly, simulates the production gestures via
 * the captured `PanResponder` handlers (jsdom does not fire React Native
 * touch events faithfully), then `fireEvent.click`s the on-screen
 * "Duplicate group" `<Pressable>` so the wiring between the button,
 * `duplicateGroupToCurrent`, and the rendered marker / selection-summary
 * surface is exercised end-to-end.
 *
 * Companion to `coach-deliver-modal-duplicate-group.test.tsx`, which
 * unit-tests the pure helper. This test catches wiring regressions
 * (button disabled state, marker rendering, selection-state plumbing)
 * the helper-level test cannot. Mirrors the canonical web vitest case
 * at `artifacts/kharagolf-web/src/tests/coach-workspace.test.tsx` L458.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Captured PanResponder configs. CoachDeliverModal creates three (in this
// order): scrubber → shapeTimeline → drawing. We invoke them programmatically
// because jsdom + react-native-web cannot dispatch faithful PanResponder
// gestures on a `<View>`.
// ---------------------------------------------------------------------------
type LocationEvent = { nativeEvent: { locationX: number; locationY: number } };
interface PanConfig {
  onStartShouldSetPanResponder?: (e: unknown) => boolean;
  onMoveShouldSetPanResponder?: (e: unknown) => boolean;
  onPanResponderGrant?: (e: LocationEvent) => void;
  onPanResponderMove?: (e: LocationEvent) => void;
  onPanResponderRelease?: (e: LocationEvent, gs?: unknown) => void;
  onPanResponderTerminate?: () => void;
}
const panConfigs: PanConfig[] = [];

// Captured `onPlaybackStatusUpdate` from the rendered `<Video>` so we can
// drive `videoTime` / `videoDuration` deterministically.
let lastPlaybackUpdate: ((s: unknown) => void) | null = null;

vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  const ReactInner = await import("react");

  type LayoutHostProps = {
    onLayout?: (e: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void;
    children?: React.ReactNode;
    testID?: string;
    style?: unknown;
    pointerEvents?: string;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean; disabled?: boolean };
    onPress?: () => void;
    disabled?: boolean;
  };

  // Fire onLayout once on mount so widths/heights inside CoachDeliverModal
  // become non-zero (jsdom has no real layout pipeline). We use width=300
  // for the timeline strip + canvas overlay so percent-position math is
  // trivial: marker at time t in a 10s clip lands at x = (t/10)*300.
  function makeLayoutHost(displayName: string, _tag: string) {
    const Comp = ReactInner.forwardRef<HTMLDivElement, LayoutHostProps>((props, ref) => {
      const { onLayout, children, testID, accessibilityState, onPress, disabled } = props;
      const firedRef = ReactInner.useRef(false);
      ReactInner.useEffect(() => {
        if (typeof onLayout === "function" && !firedRef.current) {
          firedRef.current = true;
          onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 320 } } });
        }
      }, [onLayout]);
      const dataAttrs: Record<string, unknown> = {};
      if (typeof accessibilityState?.selected === "boolean") {
        dataAttrs["data-selected"] = accessibilityState.selected ? "true" : "false";
      }
      return ReactInner.createElement(
        "div",
        {
          ref,
          "data-testid": testID,
          onClick: !disabled ? onPress : undefined,
          ...dataAttrs,
        },
        children,
      );
    });
    Comp.displayName = displayName;
    return Comp;
  }

  const View = makeLayoutHost("View", "div");
  const Pressable = makeLayoutHost("Pressable", "div");

  const ScrollView = ReactInner.forwardRef<HTMLDivElement, LayoutHostProps>((props, ref) =>
    ReactInner.createElement("div", { ref, "data-testid": props.testID }, props.children),
  );
  ScrollView.displayName = "ScrollView";

  const Modal = ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible === false ? null : ReactInner.createElement("div", null, children);

  const Text = ({ children, testID }: LayoutHostProps) =>
    ReactInner.createElement("span", { "data-testid": testID }, children);

  const TextInput = (_props: unknown) => ReactInner.createElement("input", {});

  return {
    ...actual,
    View,
    Pressable,
    ScrollView,
    Modal,
    Text,
    TextInput,
    Alert: { alert: vi.fn() },
    PanResponder: {
      create: (config: PanConfig) => {
        panConfigs.push(config);
        return { panHandlers: {} };
      },
    },
  };
});

vi.mock("expo-av", () => {
  const ReactInner = require("react") as typeof React;
  type VideoProps = {
    onPlaybackStatusUpdate?: (s: unknown) => void;
  };
  const Video = ReactInner.forwardRef<unknown, VideoProps>((props, _ref) => {
    lastPlaybackUpdate = props.onPlaybackStatusUpdate ?? null;
    return null;
  });
  Video.displayName = "Video";
  return {
    Video,
    ResizeMode: { COVER: "cover", CONTAIN: "contain" },
    Audio: {
      Sound: class {},
      Recording: class {},
      setAudioModeAsync: async () => {},
      requestPermissionsAsync: async () => ({ granted: true }),
    },
    AVPlaybackStatus: {},
  };
});

vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
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
  const ReactInner = require("react") as typeof React;
  const passthrough = (tag: string) =>
    ReactInner.forwardRef<Element, { children?: React.ReactNode }>(({ children, ...rest }, ref) =>
      ReactInner.createElement(tag, { ...rest, ref }, children),
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
    G: passthrough("g"),
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

import { CoachDeliverModal } from "../app/(tabs)/coach";

const QUEUE_ITEM = {
  request: {
    id: 999,
    memberId: 7,
    swingVideoId: 1,
    status: "in_review",
    memberPrompt: "",
    pricePaise: 50000,
  },
  videoUrl: "/uploads/swing/test.mp4",
  videoFps: 30,
};

describe("CoachDeliverModal — Duplicate group button (Task #1711)", () => {
  beforeEach(() => {
    panConfigs.length = 0;
    lastPlaybackUpdate = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws two shapes, multi-selects via long-press + tap, scrubs, then presses 'Duplicate group' — shape count doubles and copies are the active selection", async () => {
    vi.useFakeTimers();

    render(<CoachDeliverModal queueItem={QUEUE_ITEM} token="test-token" onClose={() => {}} drawingClipboard={[]} setDrawingClipboard={() => {}} />);

    // Wait for layout effects to fire (sets shapeTimelineWidth/overlay).
    act(() => {
      vi.advanceTimersByTime(0);
    });

    // Drive duration via the captured Video onPlaybackStatusUpdate. 10s clip.
    expect(lastPlaybackUpdate).toBeTypeOf("function");
    act(() => {
      lastPlaybackUpdate?.({ isLoaded: true, durationMillis: 10_000, positionMillis: 1000, isPlaying: false });
    });

    // Enter draw mode so the line tool, timeline strip, and the
    // "Duplicate group" Pressable are mounted (all gated on `drawMode`).
    act(() => {
      fireEvent.click(screen.getByText("Draw on frame").closest("div")!);
    });

    // CoachDeliverModal creates three PanResponders per render in this
    // order: scrubber → shape timeline → drawing canvas overlay.
    // (`useRef(PanResponder.create(...))` is non-lazy, so re-renders push
    // additional configs, but the production code only ever uses the
    // first instance — i.e. panConfigs[0..2].)
    expect(panConfigs.length).toBeGreaterThanOrEqual(3);
    const drawing = panConfigs[2];
    const timeline = panConfigs[1];

    // --- Draw shape 0 at t=1 (line tool is the default). ---
    act(() => {
      drawing.onPanResponderGrant?.({ nativeEvent: { locationX: 10, locationY: 10 } });
    });
    act(() => {
      drawing.onPanResponderMove?.({ nativeEvent: { locationX: 30, locationY: 30 } });
    });
    act(() => {
      drawing.onPanResponderRelease?.({ nativeEvent: { locationX: 30, locationY: 30 } });
    });

    // --- Scrub to t=3 then draw shape 1. ---
    act(() => {
      lastPlaybackUpdate?.({ isLoaded: true, durationMillis: 10_000, positionMillis: 3000, isPlaying: false });
    });
    act(() => {
      drawing.onPanResponderGrant?.({ nativeEvent: { locationX: 40, locationY: 10 } });
    });
    act(() => {
      drawing.onPanResponderMove?.({ nativeEvent: { locationX: 60, locationY: 30 } });
    });
    act(() => {
      drawing.onPanResponderRelease?.({ nativeEvent: { locationX: 60, locationY: 30 } });
    });

    // Two markers should exist. Position math: timeline width = 300,
    // duration = 10s ⇒ marker x = (t/10)*300. So marker 0 sits at x=30
    // and marker 1 at x=90 — the values we use to drive the timeline pan
    // responder's hit-test below.
    expect(screen.getAllByTestId(/^drawing-marker-/).length).toBe(2);

    // --- Long-press marker 0 to enter multi-select mode + select it. ---
    act(() => {
      timeline.onPanResponderGrant?.({ nativeEvent: { locationX: 30, locationY: 0 } });
    });
    // LONG_PRESS_MS = 400 in coach.tsx — advance the long-press timer.
    act(() => {
      vi.advanceTimersByTime(420);
    });
    act(() => {
      timeline.onPanResponderRelease?.({ nativeEvent: { locationX: 30, locationY: 0 } });
    });
    // Now in multi-select mode with marker 0 selected.
    expect(screen.getByTestId("drawing-marker-0").getAttribute("data-selected")).toBe("true");

    // --- Tap marker 1 (in multi-select mode this toggles it in). ---
    act(() => {
      timeline.onPanResponderGrant?.({ nativeEvent: { locationX: 90, locationY: 0 } });
    });
    act(() => {
      timeline.onPanResponderRelease?.({ nativeEvent: { locationX: 90, locationY: 0 } });
    });
    expect(screen.getByTestId("drawing-marker-1").getAttribute("data-selected")).toBe("true");

    // Selection summary now reads "2 shapes · 2 selected".
    expect(screen.getByTestId("drawing-selection-summary").textContent).toMatch(/2 shapes · 2 selected/);

    // --- Scrub the playhead to t=5 and press the Duplicate group button. ---
    act(() => {
      lastPlaybackUpdate?.({ isLoaded: true, durationMillis: 10_000, positionMillis: 5000, isPlaying: false });
    });
    const dupBtn = screen.getByTestId("duplicate-group-button");
    act(() => {
      fireEvent.click(dupBtn);
    });

    // --- Assertions: shape count doubled, copies are the active selection,
    //     originals deselected (mirrors web vitest L527-547). ---
    const markers = screen.getAllByTestId(/^drawing-marker-/);
    expect(markers.length).toBe(4);
    expect(screen.getByTestId("drawing-marker-0").getAttribute("data-selected")).toBe("false");
    expect(screen.getByTestId("drawing-marker-1").getAttribute("data-selected")).toBe("false");
    expect(screen.getByTestId("drawing-marker-2").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("drawing-marker-3").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("drawing-selection-summary").textContent).toMatch(/4 shapes · 2 selected/);
  });

  it("Duplicate group button is disabled (no-op onClick) when nothing is selected", async () => {
    vi.useFakeTimers();
    render(<CoachDeliverModal queueItem={QUEUE_ITEM} token="test-token" onClose={() => {}} drawingClipboard={[]} setDrawingClipboard={() => {}} />);
    act(() => { vi.advanceTimersByTime(0); });
    act(() => {
      lastPlaybackUpdate?.({ isLoaded: true, durationMillis: 10_000, positionMillis: 0, isPlaying: false });
    });
    act(() => {
      fireEvent.click(screen.getByText("Draw on frame").closest("div")!);
    });
    const drawing = panConfigs[2];
    // Draw one shape (so the modal is past the empty state, and shapes.length > 0).
    act(() => {
      drawing.onPanResponderGrant?.({ nativeEvent: { locationX: 10, locationY: 10 } });
    });
    act(() => {
      drawing.onPanResponderRelease?.({ nativeEvent: { locationX: 30, locationY: 30 } });
    });
    expect(screen.getAllByTestId(/^drawing-marker-/).length).toBe(1);
    // No selection — pressing the button is a no-op (the production Pressable
    // sets disabled={selectedIdxs.length===0}, and our mock skips onClick when
    // disabled is true). Marker count must NOT grow.
    const dupBtn = screen.getByTestId("duplicate-group-button");
    act(() => { fireEvent.click(dupBtn); });
    expect(screen.getAllByTestId(/^drawing-marker-/).length).toBe(1);
    expect(screen.getByTestId("drawing-selection-summary").textContent).toMatch(/^1 shape · /);
  });
});
