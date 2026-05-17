/**
 * UI test: Coach Workspace tab — payout-row focus + scroll behaviour
 * (Task #1287). Locks in the rendering side of the payout-paid deep-link
 * added by Task #1116; the param plumbing is covered separately by
 * handleNotificationData.test.ts.
 */
import React from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const { paramsRef, scrollToMock } = vi.hoisted(() => ({
  paramsRef: {
    current: { tab: "coach", focusPayoutId: "42" } as {
      tab?: string;
      focusPayoutId?: string;
    },
  },
  scrollToMock: vi.fn<(opts: { x?: number; y?: number; animated?: boolean }) => void>(),
}));

vi.mock("expo-router", () => ({
  router: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () => paramsRef.current,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: {
      id: 1,
      username: "coach",
      role: "coach",
      displayName: "Coach Carter",
      email: "c@example.com",
    },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

// Stub the native modules coach.tsx pulls in for its other tabs — vitest's
// esbuild transform can't parse their untransformed source.
vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [
    { granted: true },
    () => Promise.resolve({ granted: true }),
  ],
}));
vi.mock("expo-av", () => ({
  Video: () => null,
  ResizeMode: { CONTAIN: "contain", COVER: "cover", STRETCH: "stretch" },
  Audio: { Sound: class {} },
}));
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn(),
  requestMediaLibraryPermissionsAsync: vi.fn(),
  MediaTypeOptions: { Videos: "Videos", Images: "Images" },
}));
vi.mock("expo-file-system/legacy", () => ({
  getInfoAsync: vi.fn(),
  readAsStringAsync: vi.fn(),
  uploadAsync: vi.fn(),
  EncodingType: { Base64: "base64", UTF8: "utf8" },
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));
vi.mock("react-native-svg", () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => children ?? null;
  return {
    default: Stub,
    Svg: Stub,
    Line: Stub,
    Circle: Stub,
    Polyline: Stub,
    Path: Stub,
    Rect: Stub,
  };
});

// Replace ScrollView with a forwardRef stub exposing a `scrollTo` spy, and
// replace View / Animated.View so onLayout fires once on mount with a
// synthetic y position (jsdom has no real layout pipeline).
vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>("react-native");
  const ReactLib = await import("react");

  type LayoutEvent = { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } };
  type LayoutHostProps = {
    onLayout?: (e: LayoutEvent) => void;
    children?: React.ReactNode;
    testID?: string;
    style?: unknown;
  };

  let nextLayoutY = 100;

  const FakeScrollView = ReactLib.forwardRef<
    { scrollTo: typeof scrollToMock },
    LayoutHostProps
  >((props, ref) => {
    ReactLib.useImperativeHandle(ref, () => ({ scrollTo: scrollToMock }), []);
    return ReactLib.createElement(
      "div",
      { "data-testid": "coach-workspace-scrollview" },
      props.children,
    );
  });
  FakeScrollView.displayName = "FakeScrollView";

  function makeLayoutHost(displayName: string) {
    const Comp = ReactLib.forwardRef<HTMLDivElement, LayoutHostProps>((props, ref) => {
      const { onLayout, children, testID } = props;
      const firedRef = ReactLib.useRef(false);
      ReactLib.useEffect(() => {
        if (typeof onLayout === "function" && !firedRef.current) {
          firedRef.current = true;
          const y = nextLayoutY;
          nextLayoutY += 80;
          onLayout({
            nativeEvent: { layout: { x: 0, y, width: 200, height: 80 } },
          });
        }
      }, [onLayout]);
      return ReactLib.createElement(
        "div",
        { ref, "data-testid": testID },
        children,
      );
    });
    Comp.displayName = displayName;
    return Comp;
  }

  const FakeView = makeLayoutHost("FakeView");
  const FakeAnimatedView = makeLayoutHost("FakeAnimatedView");

  return {
    ...RN,
    ScrollView: FakeScrollView,
    View: FakeView,
    Animated: { ...RN.Animated, View: FakeAnimatedView },
  };
});

// Imports under test (after mocks)
import CoachScreen from "../app/(tabs)/coach";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const COACH_PROFILE_PAYLOAD = {
  pro: {
    id: 1,
    organizationId: 1,
    organizationName: "Kharagpur GC",
    displayName: "Coach Carter",
  },
  profile: {
    payoutMethod: "upi",
    payoutAccountId: "fa_123",
    payoutAccountHolderName: "Coach Carter",
    payoutVerificationStatus: "verified",
  },
};

const EARNINGS_PAYLOAD = {
  summary: { lifetimeEarningsPaise: 50_000, pendingPayoutPaise: 0, unpaidCount: 0 },
  sharePct: 70,
  payouts: [
    {
      id: 7,
      status: "paid",
      netPayoutPaise: 12_000,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      payoutReference: "PAY-OLDER",
      paidAt: "2026-02-02T10:00:00.000Z",
    },
    {
      id: 42,
      status: "paid",
      netPayoutPaise: 25_000,
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      payoutReference: "PAY-FOCUS",
      paidAt: "2026-03-02T10:00:00.000Z",
    },
  ],
};

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

beforeEach(() => {
  paramsRef.current = { tab: "coach", focusPayoutId: "42" };
  scrollToMock.mockReset();

  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/coach-marketplace/me/coach-profile")) {
      return jsonResponse(COACH_PROFILE_PAYLOAD);
    }
    if (url.includes("/api/swing-reviews/coach/queue")) {
      return jsonResponse({ queue: [] });
    }
    if (url.includes("/api/swing-reviews/coach/earnings")) {
      return jsonResponse(EARNINGS_PAYLOAD);
    }
    if (url.includes("/api/coach-marketplace/me/payout-account/history")) {
      return jsonResponse({ history: [] });
    }
    return jsonResponse({}, 200);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<CoachScreen /> — payout-row focus & scroll (Task #1287)", () => {
  it("tags the matching payout row with the focused testID and scrolls it into view", async () => {
    await act(async () => {
      render(<CoachScreen />);
    });

    const focusedRow = await screen.findByTestId("payout-row-42-focused");
    expect(focusedRow).toBeInTheDocument();

    expect(screen.getByTestId("payout-row-7")).toBeInTheDocument();
    expect(screen.queryByTestId("payout-row-7-focused")).toBeNull();
    expect(screen.queryByTestId("payout-row-42")).toBeNull();

    await waitFor(() => {
      expect(scrollToMock).toHaveBeenCalled();
    });
    const lastCall = scrollToMock.mock.calls[scrollToMock.mock.calls.length - 1];
    expect(lastCall[0]).toEqual(
      expect.objectContaining({ y: expect.any(Number), animated: true }),
    );
    expect(lastCall[0].y!).toBeGreaterThanOrEqual(0);
  });

  it("does not apply the focused testID to any row when focusPayoutId is absent", async () => {
    paramsRef.current = { tab: "coach", focusPayoutId: undefined };

    await act(async () => {
      render(<CoachScreen />);
    });

    expect(await screen.findByTestId("payout-row-7")).toBeInTheDocument();
    expect(screen.getByTestId("payout-row-42")).toBeInTheDocument();
    expect(screen.queryByTestId("payout-row-7-focused")).toBeNull();
    expect(screen.queryByTestId("payout-row-42-focused")).toBeNull();

    expect(scrollToMock).not.toHaveBeenCalled();
  });
});
