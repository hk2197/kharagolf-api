/**
 * Task #1306 — Coach Workspace tab on mobile renders the per-channel
 * push/SMS notification delivery state inside each payout row, mirroring
 * the admin badges from Task #1129. Coaches do NOT get a Resend control,
 * but get an inline "We couldn't reach you" note when both channels are
 * non-sent.
 *
 * Test scaffolding mirrors `coach-workspace-payout-focus.test.tsx`:
 * mocks expo-router / react-native-safe-area-context / native modules,
 * and stubs <View> + <ScrollView> so jsdom can render coach.tsx.
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
import { act, cleanup, render, screen } from "@testing-library/react";

const { paramsRef } = vi.hoisted(() => ({
  paramsRef: {
    current: { tab: "coach" } as { tab?: string; focusPayoutId?: string },
  },
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
    { scrollTo: (opts: unknown) => void },
    LayoutHostProps
  >((props, ref) => {
    ReactLib.useImperativeHandle(ref, () => ({ scrollTo: () => {} }), []);
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

import CoachScreen from "../app/(tabs)/coach";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const COACH_PROFILE_PAYLOAD = {
  pro: {
    id: 1, organizationId: 1, organizationName: "Kharagpur GC",
    displayName: "Coach Carter",
  },
  profile: {
    payoutMethod: "upi",
    payoutAccountId: "fa_123",
    payoutAccountHolderName: "Coach Carter",
    payoutVerificationStatus: "verified",
  },
};

function buildEarnings(payouts: any[]) {
  return {
    summary: { lifetimeEarningsPaise: 50_000, pendingPayoutPaise: 0, unpaidCount: 0 },
    sharePct: 70,
    payouts,
  };
}

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

function installFetch(payouts: any[]) {
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/coach-marketplace/me/coach-profile")) {
      return jsonResponse(COACH_PROFILE_PAYLOAD);
    }
    if (url.includes("/api/swing-reviews/coach/queue")) {
      return jsonResponse({ queue: [] });
    }
    if (url.includes("/api/swing-reviews/coach/earnings")) {
      return jsonResponse(buildEarnings(payouts));
    }
    if (url.includes("/api/coach-marketplace/me/payout-account/history")) {
      return jsonResponse({ history: [] });
    }
    return jsonResponse({}, 200);
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  paramsRef.current = { tab: "coach" };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<CoachScreen /> — payout notification badges (Task #1306)", () => {
  it("renders Push: Sent and SMS: Sent for a fully-delivered payout", async () => {
    installFetch([{
      id: 100, status: "paid", netPayoutPaise: 25_000,
      periodStart: "2026-02-01", periodEnd: "2026-02-28",
      payoutReference: "PAY-OK", paidAt: "2026-03-02T10:00:00.000Z",
      notification: {
        id: 1,
        pushStatus: "sent", pushAttempts: 1, lastPushAt: null,
        lastPushError: null, pushRetryExhaustedAt: null,
        smsStatus: "sent", smsAttempts: 1, lastSmsAt: null,
        lastSmsError: null, smsRetryExhaustedAt: null,
      },
    }]);
    await act(async () => { render(<CoachScreen />); });

    const pushBadge = await screen.findByTestId("payout-notif-push-100");
    const smsBadge = await screen.findByTestId("payout-notif-sms-100");
    expect(pushBadge).toHaveTextContent(/Push: Sent/);
    expect(smsBadge).toHaveTextContent(/SMS: Sent/);
    expect(screen.queryByTestId("payout-notif-both-missed-100")).toBeNull();
  });

  it("shows the inline 'couldn't reach you' note when both channels missed", async () => {
    installFetch([{
      id: 200, status: "paid", netPayoutPaise: 25_000,
      periodStart: "2026-03-01", periodEnd: "2026-03-31",
      payoutReference: "PAY-MISSED", paidAt: "2026-04-02T10:00:00.000Z",
      notification: {
        id: 2,
        pushStatus: "failed", pushAttempts: 5, lastPushAt: null,
        lastPushError: "boom", pushRetryExhaustedAt: "2026-04-03T10:00:00.000Z",
        smsStatus: "no_address", smsAttempts: 0, lastSmsAt: null,
        lastSmsError: null, smsRetryExhaustedAt: null,
      },
    }]);
    await act(async () => { render(<CoachScreen />); });

    expect(await screen.findByTestId("payout-notif-push-200"))
      .toHaveTextContent(/gave up/i);
    expect(await screen.findByTestId("payout-notif-sms-200"))
      .toHaveTextContent(/No phone/i);
    const note = await screen.findByTestId("payout-notif-both-missed-200");
    expect(note).toHaveTextContent(/couldn't reach you/i);
    expect(note).toHaveTextContent(/payout is still complete/i);
  });

  it("shows 'will retry' before the push retry cap is hit", async () => {
    installFetch([{
      id: 300, status: "paid", netPayoutPaise: 25_000,
      periodStart: "2026-04-01", periodEnd: "2026-04-30",
      payoutReference: "PAY-RETRY", paidAt: "2026-05-02T10:00:00.000Z",
      notification: {
        id: 3,
        pushStatus: "failed", pushAttempts: 2, lastPushAt: null,
        lastPushError: "boom", pushRetryExhaustedAt: null,
        smsStatus: "sent", smsAttempts: 1, lastSmsAt: null,
        lastSmsError: null, smsRetryExhaustedAt: null,
      },
    }]);
    await act(async () => { render(<CoachScreen />); });

    expect(await screen.findByTestId("payout-notif-push-300"))
      .toHaveTextContent(/will retry/i);
    expect(await screen.findByTestId("payout-notif-sms-300"))
      .toHaveTextContent(/SMS: Sent/);
    // SMS sent → no inline note.
    expect(screen.queryByTestId("payout-notif-both-missed-300")).toBeNull();
  });

  it("renders 'Notification: pending' when a paid payout has no attempt row yet", async () => {
    installFetch([{
      id: 400, status: "paid", netPayoutPaise: 25_000,
      periodStart: "2026-05-01", periodEnd: "2026-05-31",
      payoutReference: "PAY-PENDING", paidAt: "2026-06-02T10:00:00.000Z",
      notification: null,
    }]);
    await act(async () => { render(<CoachScreen />); });

    expect(await screen.findByTestId("payout-notif-pending-400"))
      .toHaveTextContent(/pending/i);
  });

  it("does not render notification badges for non-paid payouts", async () => {
    installFetch([{
      id: 500, status: "pending", netPayoutPaise: 25_000,
      periodStart: "2026-06-01", periodEnd: "2026-06-30",
      payoutReference: null, paidAt: null,
      notification: null,
    }]);
    await act(async () => { render(<CoachScreen />); });

    // Wait until the payout row itself is rendered.
    await screen.findByTestId("payout-row-500");
    expect(screen.queryByTestId("payout-notif-push-500")).toBeNull();
    expect(screen.queryByTestId("payout-notif-sms-500")).toBeNull();
    expect(screen.queryByTestId("payout-notif-pending-500")).toBeNull();
  });
});
