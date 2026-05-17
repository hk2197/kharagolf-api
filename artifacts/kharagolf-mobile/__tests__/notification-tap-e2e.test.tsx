/**
 * Task #1565 — end-to-end test that taps a push notification on the mobile app.
 *
 * Task #1317 already covers `reportPushOpened` in isolation
 * (__tests__/reportPushOpened.test.ts) and the server endpoint via an
 * integration test. Neither suite exercises the wiring that lives inside
 * `app/_layout.tsx` — the two `useEffect` listeners that observe Expo's
 * notification module and call the reporter on cold-start and warm-start.
 *
 * This spec mounts the actual `RootLayoutNav` component from `_layout.tsx`,
 * stubs `expo-notifications` with controllable handlers, and asserts that
 * tapping a push (cold-start AND warm-start) reaches all the way through
 * to a `fetch` against `/api/portal/notifications/push-opened` with the
 * payload the server expects. A regression that drops the reporter call
 * from either entry point now fails this test instead of slipping through.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

// `__DEV__` is defined globally in `__tests__/setup.ts` so transitive
// `expo-modules-core` imports (via expo-splash-screen / expo-notifications)
// don't crash the module graph under jsdom.

const { notificationsMock, authMock, handleNotificationDataMock, routerMock } = vi.hoisted(() => ({
  notificationsMock: {
    getLastNotificationResponseAsync: vi.fn<[], Promise<unknown>>(),
    addNotificationResponseReceivedListener: vi.fn<
      [(response: unknown) => void],
      { remove: () => void }
    >(),
  },
  authMock: { token: "tok-e2e" as string | null },
  handleNotificationDataMock: vi.fn(),
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  },
}));

// `_layout.tsx` reaches `expo-notifications` through this small helper, so
// the test substitutes a controllable fake here instead of the real native
// module (which can't be loaded in jsdom).
vi.mock("@/utils/notificationsModule", () => ({
  getNotificationsModule: () => notificationsMock,
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => authMock,
}));

vi.mock("@/utils/handleNotificationData", () => ({
  handleNotificationData: handleNotificationDataMock,
}));

vi.mock("@/utils/api", () => ({
  getApiUrl: (path: string) => `https://kharagolf.example.test/api${path}`,
}));

// `_layout.tsx` is the entry point: importing it evaluates a long list of
// top-level imports (fonts, splash screen, every context provider, etc.)
// that need real native modules. Stub them so the module graph loads in
// jsdom; we only mount `RootLayoutNav`, which doesn't actually use them.
vi.mock("@expo-google-fonts/inter", () => ({
  Inter_400Regular: "Inter_400Regular",
  Inter_500Medium: "Inter_500Medium",
  Inter_600SemiBold: "Inter_600SemiBold",
  Inter_700Bold: "Inter_700Bold",
  useFonts: () => [true, null],
}));
vi.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: () => Promise.resolve(),
  hideAsync: () => Promise.resolve(),
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  SafeAreaView: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock("@/components/NotificationsPoller", () => ({
  default: () => null,
}));
vi.mock("@/components/SponsorSplash", () => ({
  default: () => null,
}));
vi.mock("@/context/unread", () => ({
  UnreadProvider: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useUnread: () => ({}),
}));
vi.mock("@/context/moreBadges", () => ({
  MoreBadgesProvider: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock("@/context/activeClub", () => ({
  ActiveClubProvider: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useActiveClub: () => ({}),
}));
vi.mock("@/theme", () => ({
  ActiveClubThemeProvider: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
vi.mock("@/i18n", () => ({
  default: { isInitialized: true },
  applyLanguage: () => Promise.resolve(),
  loadSavedLanguage: () => Promise.resolve("en"),
}));
vi.mock("@/utils/backgroundHealthSync", () => ({
  registerBackgroundHealthSync: () => Promise.resolve(),
}));

// Override the global expo-router stub from setup.ts: the layout uses <Stack>
// as a component, but the global mock only exposes Stack.Screen. Provide a
// callable Stack that just renders its children.
vi.mock("expo-router", () => {
  const Stack = Object.assign(
    (({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children)) as React.FC<{ children?: ReactNode }>,
    { Screen: () => null },
  );
  return {
    Stack,
    useLocalSearchParams: () => ({}),
    useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
    useSegments: () => [],
    Link: ({ children }: { children?: ReactNode }) => children,
    router: routerMock,
  };
});

// react-i18next default mock — the layout doesn't translate anything in
// RootLayoutNav, but `expo-router` import order can still drag i18n in.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const fetchMock = vi.fn();

beforeEach(async () => {
  // Unmount any RootLayoutNav left over from the previous test so its
  // notification listeners stop firing handleNotificationData / router.push
  // when the next test arms a new mock response. Wrap in act() so the
  // useEffect cleanup callbacks (sub.remove()) run synchronously before the
  // next mount.
  await act(async () => {
    cleanup();
  });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
  // @ts-expect-error — install on global for the duration of each test
  globalThis.fetch = fetchMock;

  notificationsMock.getLastNotificationResponseAsync.mockReset();
  notificationsMock.addNotificationResponseReceivedListener.mockReset();
  handleNotificationDataMock.mockReset();
  routerMock.push.mockReset();
  routerMock.replace.mockReset();
  routerMock.back.mockReset();
  authMock.token = "tok-e2e";
});

const PUSH_OPENED_URL = "https://kharagolf.example.test/api/portal/notifications/push-opened";

function lastFetchBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function lastFetchHeaders(): Record<string, string> {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return (call[1] as RequestInit).headers as Record<string, string>;
}

/** Minimal fixture mirroring an Expo NotificationResponse for `data`. */
function makeResponse(opts: {
  identifier: string;
  data: Record<string, unknown> | undefined;
}) {
  return {
    notification: {
      request: {
        identifier: opts.identifier,
        content: { data: opts.data },
      },
    },
    actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
  };
}

describe("notification tap e2e — _layout.tsx → reportPushOpened → fetch", () => {
  it("cold-start: reports the tap that launched the app from a terminated state", async () => {
    const coldResponse = makeResponse({
      identifier: "expo-msg-cold-1",
      data: {
        type: "highlight_render_complete",
        url: "/highlights",
        reelId: 4242,
        tournamentId: 99,
        organizationId: 7,
      },
    });
    notificationsMock.getLastNotificationResponseAsync.mockResolvedValue(coldResponse);
    notificationsMock.addNotificationResponseReceivedListener.mockReturnValue({
      remove: () => undefined,
    });

    const { RootLayoutNav } = await import("../app/_layout");

    await act(async () => {
      render(<RootLayoutNav />);
    });
    // Allow getLastNotificationResponseAsync().then(...) microtasks to settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(notificationsMock.getLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PUSH_OPENED_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect(lastFetchHeaders()["Authorization"]).toBe("Bearer tok-e2e");
    expect(lastFetchHeaders()["Content-Type"]).toBe("application/json");

    expect(lastFetchBody()).toEqual({
      messageId: "expo-msg-cold-1",
      type: "highlight_render_complete",
      url: "/highlights",
      reelId: 4242,
      tournamentId: 99,
      organizationId: 7,
    });
  });

  it("warm-start: reports a tap that arrives while the app is already running", async () => {
    notificationsMock.getLastNotificationResponseAsync.mockResolvedValue(null);
    let warmListener: ((response: unknown) => void) | undefined;
    notificationsMock.addNotificationResponseReceivedListener.mockImplementation((cb) => {
      warmListener = cb;
      return { remove: () => undefined };
    });

    const { RootLayoutNav } = await import("../app/_layout");
    await act(async () => {
      render(<RootLayoutNav />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Cold-start handler resolved with null → no fetch yet.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notificationsMock.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(warmListener).toBeTypeOf("function");

    const warmResponse = makeResponse({
      identifier: "expo-msg-warm-7",
      data: {
        type: "coach_payout_paid",
        url: "/coach/earnings",
        payoutId: 42,
        organizationId: 7,
      },
    });

    await act(async () => {
      warmListener!(warmResponse);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(PUSH_OPENED_URL);
    expect(lastFetchHeaders()["Authorization"]).toBe("Bearer tok-e2e");
    expect(lastFetchBody()).toEqual({
      messageId: "expo-msg-warm-7",
      type: "coach_payout_paid",
      url: "/coach/earnings",
      payoutId: 42,
      organizationId: 7,
    });

    // The deep-link router still gets called for the same tap, in addition
    // to the analytics report — the two pipelines must not steal from each
    // other (a regression that wraps one in the other would break here).
    expect(handleNotificationDataMock).toHaveBeenCalledTimes(1);
    expect(handleNotificationDataMock).toHaveBeenCalledWith(warmResponse.notification.request.content.data);
  });

  it("cold-start: stays silent when the OS reports no last-tapped notification", async () => {
    notificationsMock.getLastNotificationResponseAsync.mockResolvedValue(null);
    notificationsMock.addNotificationResponseReceivedListener.mockReturnValue({
      remove: () => undefined,
    });

    const { RootLayoutNav } = await import("../app/_layout");
    await act(async () => {
      render(<RootLayoutNav />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(handleNotificationDataMock).not.toHaveBeenCalled();
  });

  // Task #2106 — when an admin clears a director's tie-break or bounced-
  // reminders schedule-change opt-out, Task #1693 fires a push with
  // `deepLink: "/my-360/communications"`. Tapping that push should drop the
  // recipient straight onto the notification preferences screen so they can
  // re-silence the email in one tap, mirroring how `coach_payout_paid`
  // routes today. We exercise the real `handleNotificationData` here (the
  // other suites mock it because they only care about the analytics path)
  // and assert against `router.push` so the wiring is covered end-to-end.
  describe("admin re-subscribe push deep-links to /my-360/communications (Task #2106)", () => {
    it.each([
      ["tie_break_email_admin_resubscribe"],
      ["bounced_digest_schedule_admin_resubscribe"],
    ])(
      "warm-start: routes a tapped %s push to the communications preferences screen",
      async (type) => {
        const real = await vi.importActual<typeof import("@/utils/handleNotificationData")>(
          "@/utils/handleNotificationData",
        );
        handleNotificationDataMock.mockImplementation((data) =>
          real.handleNotificationData(data as Record<string, unknown> | undefined),
        );

        notificationsMock.getLastNotificationResponseAsync.mockResolvedValue(null);
        let warmListener: ((response: unknown) => void) | undefined;
        notificationsMock.addNotificationResponseReceivedListener.mockImplementation((cb) => {
          warmListener = cb;
          return { remove: () => undefined };
        });

        const { RootLayoutNav } = await import("../app/_layout");
        await act(async () => {
          render(<RootLayoutNav />);
        });
        await act(async () => {
          await Promise.resolve();
        });

        const response = makeResponse({
          identifier: `expo-msg-${type}`,
          data: {
            type,
            organizationId: 7,
            userId: 9,
            actorUserId: 3,
            deepLink: "/my-360/communications",
          },
        });

        await act(async () => {
          warmListener!(response);
          await Promise.resolve();
        });

        expect(handleNotificationDataMock).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith("/my-360/communications");
      },
    );

    it.each([
      ["tie_break_email_admin_resubscribe"],
      ["bounced_digest_schedule_admin_resubscribe"],
    ])(
      "cold-start: routes a tapped %s push that launched the app to the communications preferences screen",
      async (type) => {
        const real = await vi.importActual<typeof import("@/utils/handleNotificationData")>(
          "@/utils/handleNotificationData",
        );
        handleNotificationDataMock.mockImplementation((data) =>
          real.handleNotificationData(data as Record<string, unknown> | undefined),
        );

        const coldResponse = makeResponse({
          identifier: `expo-msg-cold-${type}`,
          data: {
            type,
            organizationId: 7,
            userId: 9,
            actorUserId: 3,
            deepLink: "/my-360/communications",
          },
        });
        notificationsMock.getLastNotificationResponseAsync.mockResolvedValue(coldResponse);
        notificationsMock.addNotificationResponseReceivedListener.mockReturnValue({
          remove: () => undefined,
        });

        const { RootLayoutNav } = await import("../app/_layout");
        await act(async () => {
          render(<RootLayoutNav />);
        });
        // The cold-start branch in `_layout.tsx` defers the deep-link by 300ms
        // (so the navigator has a chance to mount before `router.push` runs).
        // Earlier tests in this file may leave dangling 300ms setTimeouts of
        // their own (they only await microtasks before exiting), so assert on
        // the deep-link target rather than an exact call count — what matters
        // for Task #2106 is that this push lands on /my-360/communications.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 350));
        });

        expect(handleNotificationDataMock).toHaveBeenCalledWith(
          coldResponse.notification.request.content.data,
        );
        expect(routerMock.push).toHaveBeenCalledWith("/my-360/communications");
      },
    );
  });
});
