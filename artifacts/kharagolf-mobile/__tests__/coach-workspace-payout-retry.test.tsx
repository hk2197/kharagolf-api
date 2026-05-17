/**
 * Task #1915 — UI coverage for the coach-side "Try again" button on
 * the mobile Coach Workspace (Task #1543). The earlier
 * `coach-workspace-payout-notification.test.tsx` only checks that the
 * push/SMS badges + the inline "couldn't reach you" note render; this
 * file extends that coverage to the actual retry button flow:
 *
 *   1. The button is visible for a paid payout whose push channel is
 *      cap-exhausted (i.e. `coachPayoutCanCoachRetry` returns true).
 *   2. Pressing it POSTs to
 *      `/api/swing-reviews/coach/payouts/:id/retry-notification`,
 *      surfaces the "Re-sending your payout notification" Alert on a
 *      200, and then disappears for the cooldown once the next
 *      `/coach/earnings` reload returns a fresh `coachRetryRequestedAt`.
 *   3. A 429 (cooldown) response surfaces the "Couldn't try again"
 *      Alert with the server-provided message and leaves the button
 *      reachable for the test (it'd vanish on the next reload).
 *
 * Scaffolding mirrors `coach-workspace-payout-notification.test.tsx`:
 * mocks expo-router / safe-area / native modules and stubs <View> +
 * <ScrollView> so jsdom can render coach.tsx. Alert.alert is captured
 * via a `vi.hoisted` spy because react-native-web makes `Alert.alert`
 * a noop by default.
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
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const { paramsRef, alertSpy } = vi.hoisted(() => ({
  paramsRef: {
    current: { tab: "coach" } as { tab?: string; focusPayoutId?: string },
  },
  alertSpy: vi.fn(),
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
    Alert: { ...RN.Alert, alert: (...args: unknown[]) => alertSpy(...args) },
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

// A paid payout whose push channel is cap-exhausted and SMS is `sent`
// — the canonical "missed-on-push, can retry" shape exercised by the
// API-level test in `coach-admin-payouts.test.ts`.
function retryablePayout() {
  return {
    id: 700,
    status: "paid",
    netPayoutPaise: 25_000,
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    payoutReference: "PAY-RETRY",
    paidAt: "2026-04-02T10:00:00.000Z",
    notification: {
      id: 7,
      pushStatus: "failed", pushAttempts: 5, lastPushAt: null,
      lastPushError: "boom", pushRetryExhaustedAt: "2026-04-03T10:00:00.000Z",
      pushTargetLabel: "1 expo device",
      smsStatus: "sent", smsAttempts: 1, lastSmsAt: null,
      lastSmsError: null, smsRetryExhaustedAt: null,
      smsTargetMasked: null,
      coachRetryRequestedAt: null,
    },
  };
}

// Same payout, but with `coachRetryRequestedAt` stamped to "just now"
// so the shared `coachPayoutCanCoachRetry` helper hides the button.
function cooldownActivePayout() {
  const p = retryablePayout();
  p.notification = {
    ...p.notification,
    coachRetryRequestedAt: new Date().toISOString() as unknown as
      typeof p.notification.coachRetryRequestedAt,
  };
  return p;
}

function buildEarnings(payouts: any[]) {
  return {
    summary: { lifetimeEarningsPaise: 50_000, pendingPayoutPaise: 0, unpaidCount: 0 },
    sharePct: 70,
    payouts,
  };
}

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

interface InstallOpts {
  initialPayout: ReturnType<typeof retryablePayout>;
  reloadedPayout?: ReturnType<typeof retryablePayout>;
  retryStatus?: number;
  retryBody?: Record<string, unknown>;
}

function installFetch(opts: InstallOpts): { earningsCalls: number; retryCalls: number } {
  const counters = { earningsCalls: 0, retryCalls: 0 };
  fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.includes("/api/coach-marketplace/me/coach-profile")) {
      return jsonResponse(COACH_PROFILE_PAYLOAD);
    }
    if (url.includes("/api/swing-reviews/coach/queue")) {
      return jsonResponse({ queue: [] });
    }
    if (url.includes("/api/swing-reviews/coach/earnings")) {
      counters.earningsCalls += 1;
      const payload = counters.earningsCalls === 1
        ? buildEarnings([opts.initialPayout])
        : buildEarnings([opts.reloadedPayout ?? opts.initialPayout]);
      return jsonResponse(payload);
    }
    if (url.includes("/api/coach-marketplace/me/payout-account/history")) {
      return jsonResponse({ history: [] });
    }
    if (
      method === "POST" &&
      /\/api\/swing-reviews\/coach\/payouts\/\d+\/retry-notification$/.test(url)
    ) {
      counters.retryCalls += 1;
      return jsonResponse(opts.retryBody ?? { success: true, resetPush: true, resetSms: false }, opts.retryStatus ?? 200);
    }
    return jsonResponse({}, 200);
  });
  vi.stubGlobal("fetch", fetchMock);
  return counters;
}

beforeEach(() => {
  paramsRef.current = { tab: "coach" };
  alertSpy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<CoachScreen /> — coach 'Try again' button (Task #1543 / #1915)", () => {
  it("shows the retry button for a cap-exhausted push, fires success Alert on 200, and hides the button after the cooldown reload", async () => {
    const counters = installFetch({
      initialPayout: retryablePayout(),
      reloadedPayout: cooldownActivePayout(),
    });

    await act(async () => { render(<CoachScreen />); });

    // Button is visible while canRetry === true.
    const retryBtn = await screen.findByTestId("payout-notif-retry-700");
    expect(retryBtn).toHaveTextContent(/Try again/i);

    await act(async () => { fireEvent.click(retryBtn); });

    // POST hit the right endpoint and the success Alert fired.
    await waitFor(() => {
      expect(counters.retryCalls).toBe(1);
    });
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        "Re-sending your payout notification",
        expect.stringMatching(/try push and SMS again/i),
      );
    });

    // The retry handler always calls `reload()` in `finally`, so we
    // expect a second /coach/earnings hit; once it lands with the
    // fresh `coachRetryRequestedAt`, the shared
    // `coachPayoutCanCoachRetry` helper hides the button.
    await waitFor(() => {
      expect(counters.earningsCalls).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("payout-notif-retry-700")).toBeNull();
    });

    // Sanity: the surrounding badges still render (only the button vanished).
    expect(screen.getByTestId("payout-notif-push-700")).toBeTruthy();
    expect(screen.getByTestId("payout-notif-sms-700")).toBeTruthy();
  });

  it("surfaces the server error on a 429 cooldown response", async () => {
    installFetch({
      initialPayout: retryablePayout(),
      reloadedPayout: retryablePayout(),
      retryStatus: 429,
      retryBody: { error: "Please wait a few minutes before trying again.", retryAfterSec: 270 },
    });

    await act(async () => { render(<CoachScreen />); });

    const retryBtn = await screen.findByTestId("payout-notif-retry-700");
    await act(async () => { fireEvent.click(retryBtn); });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        "Couldn't try again",
        expect.stringMatching(/wait a few minutes/i),
      );
    });
  });
});
