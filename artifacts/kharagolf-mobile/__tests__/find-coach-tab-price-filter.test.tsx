/**
 * Task #2022 — mobile coach tab now exposes the same hourly-rate price
 * filter that the web sidebar (`artifacts/kharagolf-web/src/pages/coach-marketplace.tsx`)
 * has, mapped onto the mode-aware `priceMin`/`priceMax` query params at
 * `artifacts/api-server/src/routes/coach-marketplace.ts`. This test
 * renders the `FindCoachTab` directly, switches into the In-person mode,
 * types an hourly bracket, and asserts both that
 *   1. the labels flip to ₹/hour copy ("Filters by hourly rate"), and
 *   2. the outgoing `/api/coach-marketplace/coaches` request carries
 *      `mode=in_person`, `priceMin`, and `priceMax` in paise.
 *
 * jsdom can't render React Native components, so we mock the relevant
 * bits of `react-native` to plain DOM elements (mirroring the approach
 * used in `coach-deliver-modal-button.test.tsx`).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen, waitFor } from "@testing-library/react";

vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  const ReactInner = await import("react");

  type HostProps = {
    onLayout?: (e: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void;
    children?: React.ReactNode;
    testID?: string;
    style?: unknown;
    accessibilityState?: { selected?: boolean; disabled?: boolean };
    onPress?: () => void;
    disabled?: boolean;
  };

  function makeHost(displayName: string) {
    const Comp = ReactInner.forwardRef<HTMLDivElement, HostProps>((props, ref) => {
      const { onLayout, children, testID, accessibilityState, onPress, disabled } = props;
      const firedRef = ReactInner.useRef(false);
      ReactInner.useEffect(() => {
        if (typeof onLayout === "function" && !firedRef.current) {
          firedRef.current = true;
          onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 200 } } });
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

  const View = makeHost("View");
  const Pressable = makeHost("Pressable");
  const ScrollView = makeHost("ScrollView");
  const Modal = ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible === false ? null : ReactInner.createElement("div", null, children);
  const Text = ({ children, testID }: HostProps) =>
    ReactInner.createElement("span", { "data-testid": testID }, children);
  const TextInput = ReactInner.forwardRef<HTMLInputElement, {
    value?: string;
    onChangeText?: (v: string) => void;
    placeholder?: string;
    testID?: string;
  }>(({ value, onChangeText, placeholder, testID }, ref) =>
    ReactInner.createElement("input", {
      ref,
      "data-testid": testID,
      value: value ?? "",
      placeholder,
      onChange: (e: { target: { value: string } }) => onChangeText?.(e.target.value),
    }),
  );
  TextInput.displayName = "TextInput";
  const Image = (_props: unknown) => ReactInner.createElement("div", {});
  const FlatList = <T,>({ data, renderItem, keyExtractor }: {
    data: T[]; renderItem: (info: { item: T }) => React.ReactNode; keyExtractor?: (item: T, idx: number) => string;
  }) => ReactInner.createElement(
    "div",
    { "data-testid": "find-coach-list" },
    data.map((item, idx) =>
      ReactInner.createElement(
        "div",
        { key: keyExtractor ? keyExtractor(item, idx) : String(idx) },
        renderItem({ item }),
      ),
    ),
  );
  const ActivityIndicator = (_props: unknown) =>
    ReactInner.createElement("div", { "data-testid": "loading" });
  const FakeAnimated = {
    Value: class { setValue() {}; },
    timing: () => ({ start: () => {} }),
    sequence: () => ({ start: () => {} }),
    parallel: () => ({ start: () => {} }),
    View,
  };

  return {
    ...actual,
    View,
    Pressable,
    ScrollView,
    Modal,
    Text,
    TextInput,
    Image,
    FlatList,
    ActivityIndicator,
    Animated: FakeAnimated,
    Easing: { inOut: () => () => 0, ease: () => 0, linear: () => 0 },
    Alert: { alert: vi.fn() },
    Linking: { openURL: async () => {} },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    StyleSheet: { create: <T,>(s: T) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
  };
});

vi.mock("expo-av", () => ({
  Video: () => null,
  ResizeMode: { COVER: "cover", CONTAIN: "contain" },
  Audio: { Sound: class {}, Recording: class {} },
  AVPlaybackStatus: {},
}));

vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: async () => ({ canceled: true }),
  MediaTypeOptions: { Videos: "Videos" },
}));

vi.mock("expo-file-system/legacy", () => ({
  getInfoAsync: async () => ({ exists: false }),
  documentDirectory: "file:///documents/",
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
    user: { id: 42, displayName: "Tester", email: "t@example.com", organizationId: 9 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/utils/api", () => ({
  BASE_URL: "https://example.test",
}));

import { FindCoachTab } from "../app/(tabs)/coach";

interface FetchCall {
  url: string;
}

describe("FindCoachTab — hourly-rate price filter (Task #2022)", () => {
  const fetchCalls: FetchCall[] = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    (globalThis as { fetch?: unknown }).fetch = vi.fn(async (input: string) => {
      fetchCalls.push({ url: input });
      return {
        ok: true,
        json: async () => ({ coaches: [] }),
      } as unknown as Response;
    });
  });

  it("sends mode + priceMin/priceMax in paise and shows hourly-rate copy when In-person is active", async () => {
    render(<FindCoachTab token="test-token" />);

    // Initial mount fetches with no filters.
    await waitFor(() => {
      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    });
    expect(fetchCalls[0].url).toBe("https://example.test/api/coach-marketplace/coaches");

    // Default helper text reflects the "all" mode.
    expect(screen.getByTestId("filter-price-helper").textContent).toMatch(
      /hourly or async/i,
    );

    // Switch to In-person — labels and helper should flip to hourly-rate copy.
    act(() => {
      fireEvent.click(screen.getByTestId("filter-mode-in_person"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("filter-price-helper").textContent).toMatch(
        /hourly rate/i,
      );
    });
    // The mode toggle reflects the active selection.
    expect(screen.getByTestId("filter-mode-in_person").getAttribute("data-selected"))
      .toBe("true");

    // Enter ₹500–₹2000 / hour bracket. Inputs are rupees; API expects paise.
    const minInput = screen.getByTestId("filter-price-min") as HTMLInputElement;
    const maxInput = screen.getByTestId("filter-price-max") as HTMLInputElement;
    act(() => {
      fireEvent.change(minInput, { target: { value: "500" } });
    });
    act(() => {
      fireEvent.change(maxInput, { target: { value: "2000" } });
    });

    // The latest fetch should carry mode=in_person and rupees-converted-to-paise.
    await waitFor(() => {
      const last = fetchCalls[fetchCalls.length - 1].url;
      expect(last).toMatch(/mode=in_person/);
      expect(last).toMatch(/priceMin=50000/);
      expect(last).toMatch(/priceMax=200000/);
    });

    // The min/max field labels should also include the ₹/hour suffix.
    expect(screen.getByText("Min ₹/hour")).toBeTruthy();
    expect(screen.getByText("Max ₹/hour")).toBeTruthy();
  });

  it("uses async-review labels and routes the bracket to the async price column when Async review is active", async () => {
    render(<FindCoachTab token="test-token" />);
    await waitFor(() => {
      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    });

    act(() => {
      fireEvent.click(screen.getByTestId("filter-mode-async"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("filter-price-helper").textContent).toMatch(
        /async review price/i,
      );
    });

    const maxInput = screen.getByTestId("filter-price-max") as HTMLInputElement;
    act(() => {
      fireEvent.change(maxInput, { target: { value: "1500" } });
    });

    await waitFor(() => {
      const last = fetchCalls[fetchCalls.length - 1].url;
      expect(last).toMatch(/mode=async/);
      expect(last).toMatch(/priceMax=150000/);
      expect(last).not.toMatch(/priceMin=/);
    });

    expect(screen.getByText("Min ₹/review")).toBeTruthy();
    expect(screen.getByText("Max ₹/review")).toBeTruthy();
  });
});
