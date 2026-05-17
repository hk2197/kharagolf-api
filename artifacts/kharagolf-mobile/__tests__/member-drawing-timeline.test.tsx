/**
 * Coverage for the read-only drawing timeline strip beneath the member's
 * swing-review playback (`MemberDrawingTimeline` in
 * artifacts/kharagolf-mobile/app/(tabs)/coach.tsx). Asserts marker count,
 * positioning, and the seek wiring used by `RequestDetailModalInner`.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const TIMELINE_WIDTH = 200;

// Stub View / Pressable so we can read inline styles directly and so
// onLayout fires once with a known width (jsdom has no layout pipeline).
vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>("react-native");
  const ReactLib = await import("react");

  type LayoutEvent = {
    nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
  };

  function flattenStyle(s: unknown): Record<string, unknown> | undefined {
    if (!s) return undefined;
    const flat: Record<string, unknown> = {};
    function walk(v: unknown) {
      if (!v) return;
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (typeof v === "object") Object.assign(flat, v as Record<string, unknown>);
    }
    walk(s);
    return flat;
  }

  type ViewProps = {
    onLayout?: (e: LayoutEvent) => void;
    accessibilityLabel?: string;
    style?: unknown;
    children?: React.ReactNode;
  };
  const FakeView = ReactLib.forwardRef<HTMLDivElement, ViewProps>((props, ref) => {
    const fired = ReactLib.useRef(false);
    ReactLib.useEffect(() => {
      if (typeof props.onLayout === "function" && !fired.current) {
        fired.current = true;
        props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, width: TIMELINE_WIDTH, height: 24 } },
        });
      }
    }, [props.onLayout]);
    return ReactLib.createElement(
      "div",
      { ref, "aria-label": props.accessibilityLabel, style: flattenStyle(props.style) },
      props.children,
    );
  });
  FakeView.displayName = "FakeView";

  type PressableProps = {
    onPress?: () => void;
    accessibilityLabel?: string;
    style?: unknown;
    children?: React.ReactNode;
  };
  const FakePressable = ReactLib.forwardRef<HTMLButtonElement, PressableProps>((props, ref) =>
    ReactLib.createElement(
      "button",
      {
        ref,
        "aria-label": props.accessibilityLabel,
        style: flattenStyle(props.style),
        onClick: () => props.onPress?.(),
      },
      props.children,
    ),
  );
  FakePressable.displayName = "FakePressable";

  return { ...RN, View: FakeView, Pressable: FakePressable };
});

// Heavy native modules pulled in by coach.tsx at module scope.
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
}));
vi.mock("react-native-svg", () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => children ?? null;
  return {
    __esModule: true,
    default: Stub,
    Svg: Stub, Line: Stub, Circle: Stub, Polyline: Stub, Path: Stub, Rect: Stub,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token", user: { id: 42 }, isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/utils/api", () => ({ BASE_URL: "" }));

import { MemberDrawingTimeline } from "../app/(tabs)/coach";

afterEach(() => cleanup());

// DrawShape is module-private in coach.tsx; the component only reads `t`
// and `color` from each entry, so cast through unknown.
type FakeDrawing = { kind: string; t: number; color: string; [k: string]: unknown };
function asDrawings(arr: FakeDrawing[]) {
  return arr as unknown as Parameters<typeof MemberDrawingTimeline>[0]["drawings"];
}

function leftPx(label: string): number {
  const el = screen.getByLabelText(label) as HTMLButtonElement;
  return parseFloat(el.style.left.replace("px", ""));
}

describe("MemberDrawingTimeline", () => {
  it("renders one marker per drawing, positioned by drawing.t / durationSeconds", () => {
    // left = clamp((t / durSec) * width − 5, 0, width − 10)
    // width=200, durSec=10 → t=1.5 → 25, t=5.0 → 95, t=9.99 → 194.8 clamped to 190.
    render(
      <MemberDrawingTimeline
        drawings={asDrawings([
          { kind: "line",   t: 1.5,  color: "#ff0000", x1: 0, y1: 0, x2: 0, y2: 0 },
          { kind: "circle", t: 5.0,  color: "#00ff00", x: 0, y: 0, r: 0 },
          { kind: "arrow",  t: 9.99, color: "#0000ff", x1: 0, y1: 0, x2: 0, y2: 0 },
        ])}
        videoDurationMs={10_000}
        videoTime={0}
        onSeekMs={() => {}}
      />,
    );

    const markers = screen.getAllByLabelText(/^Drawing \d+ at .* seconds\. Tap to jump\.$/);
    expect(markers).toHaveLength(3);

    expect(leftPx("Drawing 1 at 1.50 seconds. Tap to jump.")).toBeCloseTo(25, 5);
    expect(leftPx("Drawing 2 at 5.00 seconds. Tap to jump.")).toBeCloseTo(95, 5);
    expect(leftPx("Drawing 3 at 9.99 seconds. Tap to jump.")).toBeCloseTo(190, 5);
  });

  it("invokes Video.setPositionAsync with drawing.t * 1000ms when a marker is pressed", () => {
    // Mirror the wiring inside RequestDetailModalInner:
    //   onSeekMs={(ms) => memberVideoRef.current?.setPositionAsync(ms).catch(...)}
    const fakeVideoRef = { setPositionAsync: vi.fn(async (_ms: number) => ({} as unknown)) };

    render(
      <MemberDrawingTimeline
        drawings={asDrawings([
          { kind: "line", t: 1.5,  color: "#ff0000", x1: 0, y1: 0, x2: 0, y2: 0 },
          { kind: "line", t: 5.25, color: "#00ff00", x1: 0, y1: 0, x2: 0, y2: 0 },
          { kind: "line", t: 8.0,  color: "#0000ff", x1: 0, y1: 0, x2: 0, y2: 0 },
        ])}
        videoDurationMs={10_000}
        videoTime={0}
        onSeekMs={(ms) => { fakeVideoRef.setPositionAsync(ms).catch(() => {}); }}
      />,
    );

    fireEvent.click(screen.getByLabelText("Drawing 1 at 1.50 seconds. Tap to jump."));
    fireEvent.click(screen.getByLabelText("Drawing 2 at 5.25 seconds. Tap to jump."));
    fireEvent.click(screen.getByLabelText("Drawing 3 at 8.00 seconds. Tap to jump."));

    expect(fakeVideoRef.setPositionAsync).toHaveBeenCalledTimes(3);
    expect(fakeVideoRef.setPositionAsync).toHaveBeenNthCalledWith(1, 1500);
    expect(fakeVideoRef.setPositionAsync).toHaveBeenNthCalledWith(2, 5250);
    expect(fakeVideoRef.setPositionAsync).toHaveBeenNthCalledWith(3, 8000);
  });

  it("clamps the seek target to the video duration", () => {
    const onSeekMs = vi.fn();
    render(
      <MemberDrawingTimeline
        drawings={asDrawings([
          { kind: "line", t: 12.0, color: "#ff0000", x1: 0, y1: 0, x2: 0, y2: 0 },
        ])}
        videoDurationMs={10_000}
        videoTime={0}
        onSeekMs={onSeekMs}
      />,
    );
    fireEvent.click(screen.getByLabelText("Drawing 1 at 12.00 seconds. Tap to jump."));
    expect(onSeekMs).toHaveBeenCalledWith(10_000);
  });

  it("renders nothing when there are no drawings", () => {
    render(
      <MemberDrawingTimeline
        drawings={asDrawings([])}
        videoDurationMs={10_000}
        videoTime={0}
        onSeekMs={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Drawing timeline")).toBeNull();
  });

  it("withholds markers until the video duration is known", () => {
    render(
      <MemberDrawingTimeline
        drawings={asDrawings([
          { kind: "line", t: 1.5, color: "#ff0000", x1: 0, y1: 0, x2: 0, y2: 0 },
        ])}
        videoDurationMs={null}
        videoTime={0}
        onSeekMs={() => {}}
      />,
    );
    expect(screen.getByLabelText("Drawing timeline")).toBeTruthy();
    expect(screen.queryByLabelText(/^Drawing \d+ at .* seconds/)).toBeNull();
  });
});
