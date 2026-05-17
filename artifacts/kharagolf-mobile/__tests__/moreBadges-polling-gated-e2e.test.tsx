/**
 * Task #1408 — End-to-end coverage for `MoreBadgesProvider`'s
 * subscriber-gated polling, complementing the provider-only unit suite
 * in `__tests__/moreBadges-polling-gated.test.tsx`.
 *
 * The unit suite mocks the provider in isolation: it confirms the
 * subscribe()/fetchAll() machinery behaves correctly *given* a
 * subscriber, but it cannot catch the regression class this e2e suite
 * targets — someone wires `useBadgePolling()` into a screen or root
 * provider that lives *outside* the (tabs) navigator. That would
 * silently restart the safety-net poll on auth screens, modals, or
 * deep-linked standalone routes — exactly what Task #1213 set out to
 * prevent.
 *
 * The transport mirrors the established mobile e2e tier
 * (vitest + react-native-web, see `committee-case-opened-summary-e2e`),
 * so this file is picked up by `pnpm --filter @workspace/kharagolf-mobile
 * test` in CI without any extra wiring. Playwright is not configured
 * for the mobile artifact; this is the same harness the rest of the
 * mobile e2e tier uses.
 *
 * Cases:
 *   1. Sign-in flow — provider stays mounted across the auth → tabs
 *      route swap. While the auth child is active there are zero
 *      `/api/portal/badge-counts` calls, even after a full
 *      safety-net poll interval. The instant the (tabs) child mounts
 *      a single fresh request fires.
 *   2. Real (tabs)/more.tsx mounts on its own and fires an immediate
 *      fresh request — opening the More menu must not stall on stale
 *      counts.
 *
 * Together these pin both the negative case (non-(tabs) UI →
 * no traffic) and the positive case (entering the (tabs) tree → fresh
 * traffic) at the integration boundary, against the *real* route
 * files that ship to users.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Hoisted mocks — must run before importing the route files under test.
// We deliberately do NOT mock `@/context/moreBadges` so the real provider,
// the real subscriber-gated effect, and the real `useBadgePolling()` hook
// are exercised end-to-end.
// ---------------------------------------------------------------------------

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

// Real `react-native-web` ships an AppState. Stub it so registering the
// listener doesn't keep the test event loop alive.
vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>(
    "react-native",
  );
  return {
    ...actual,
    AppState: {
      addEventListener: () => ({ remove: () => undefined }),
      currentState: "active",
    },
  };
});

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    token: "test-token",
    user: { id: 1, organizationId: 7 },
  }),
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({ activeOrgId: 7 }),
}));

vi.mock("@/context/unread", () => ({
  useUnread: () => ({
    notifUnreadCount: 0,
    unreadCount: 0,
    refresh: () => undefined,
    markAllSeen: async () => undefined,
  }),
}));

// Task #1407 added a real-time push refresh path to the provider. We
// short-circuit `getExpoNotifications()` so no listener is registered;
// the subject under test here is the polling cadence, not the push
// path (which has its own coverage in the unit suite).
vi.mock("@/utils/expoNotifications", () => ({
  getExpoNotifications: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
    i18n: { language: "en", changeLanguage: async () => undefined },
  }),
}));

vi.mock("@/constants/colors", () => ({
  default: {
    primary: "#0a0",
    background: "#000",
    surface: "#111",
    border: "#222",
    card: "#1a1a1a",
    error: "#ef4444",
    text: "#fff",
    textSecondary: "#999",
    tabIconDefault: "#888",
  },
}));

vi.mock("expo-blur", () => {
  const React = require("react");
  return {
    BlurView: (props: Record<string, unknown>) =>
      React.createElement("div", { ...props, "data-testid": "blur-view" }),
  };
});

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// `expo-router`'s real `Tabs` and `Stack` walk the file-system route tree
// at runtime. Stub both with no-op fragments so we can mount the layouts
// directly. The point of the test is the `useBadgePolling()` side-effects,
// not the navigator's render output.
vi.mock("expo-router", () => {
  const React = require("react");
  function Tabs(props: { children?: React.ReactNode }) {
    return React.createElement(React.Fragment, null, props.children);
  }
  (Tabs as unknown as { Screen: React.FC }).Screen = function Screen() {
    return null;
  };
  function Stack(props: { children?: React.ReactNode }) {
    return React.createElement(React.Fragment, null, props.children);
  }
  (Stack as unknown as { Screen: React.FC }).Screen = function Screen() {
    return null;
  };
  return {
    Tabs,
    Stack,
    router: {
      push: () => undefined,
      back: () => undefined,
      replace: () => undefined,
    },
    useFocusEffect: () => undefined,
    useLocalSearchParams: () => ({}),
    useRouter: () => ({
      push: () => undefined,
      back: () => undefined,
      replace: () => undefined,
    }),
    Link: ({ children }: { children?: React.ReactNode }) => children,
  };
});

// ---------------------------------------------------------------------------
// Real provider + real (tabs) route files.
//
// We deliberately do NOT import `app/(auth)/_layout.tsx` directly. That file
// (and most leaf auth screens like `login.tsx`) pull in heavy native modules
// — expo-auth-session, expo-apple-authentication, expo-web-browser, native
// Stripe — that the jsdom test transport cannot stub cheaply. The "auth
// tree mounted" leg of the sign-in flow uses a small stub component below;
// the contract being pinned (subscriber-gated polling) is a property of
// `MoreBadgesProvider` and is independent of which specific non-(tabs)
// screen is on top.
// ---------------------------------------------------------------------------
import { MoreBadgesProvider } from "@/context/moreBadges";
import TabLayout from "../app/(tabs)/_layout";
import MoreScreen from "../app/(tabs)/more";

// Mirror the value from `context/moreBadges.tsx` so a future cadence change
// (e.g. tightening or loosening the safety-net interval) can't silently
// invalidate this test — bumping the source constant without bumping this
// one will make the second-tick assertion in the sign-in flow case fail
// loudly, prompting an explicit update here.
const POLL_INTERVAL_MS = 5 * 60_000;

const BADGE_COUNTS_PATH = "/api/portal/badge-counts";

function AuthTreeStub() {
  // Stand-in for any screen that lives *outside* `(tabs)` and does
  // not call `useBadgePolling()` — auth screens, modals, deep-linked
  // standalone routes (e.g. `/wallet`, `/peer-review/[token]`). The
  // point is to assert that the bare act of mounting a non-(tabs) UI
  // under the real provider does not start polling.
  return <div data-testid="auth-tree-stub">login form</div>;
}

const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>(
  async () =>
    new Response(JSON.stringify({ notifications: 0 }), { status: 200 }),
);

function badgeCountsCalls(): string[] {
  return fetchMock.mock.calls
    .map((c) => String((c as unknown[])[0] ?? ""))
    .filter((url) => url.includes(BADGE_COUNTS_PATH));
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  (globalThis as { fetch?: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});

async function flush() {
  // Two microtask flushes to settle: AsyncStorage promise → fetch promise →
  // setCounts/setSubscriberCount renders. Same shape as the unit suite.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("MoreBadgesProvider — subscriber-gated polling, e2e (Task #1408)", () => {
  it(
    "sign-in flow: while the (auth) tree is the active child of the still-mounted provider there are zero /api/portal/badge-counts calls — even past one full safety-net interval — and the auth → tabs swap fires exactly one fresh request immediately",
    async () => {
      // Mirrors the real app's root composition: `MoreBadgesProvider`
      // is mounted at `app/_layout.tsx` and stays mounted across
      // route-group swaps; only the active child changes when the
      // user signs in.
      function App({ signedIn }: { signedIn: boolean }) {
        return (
          <MoreBadgesProvider>
            {signedIn ? <TabLayout /> : <AuthTreeStub />}
          </MoreBadgesProvider>
        );
      }

      const { rerender } = render(<App signedIn={false} />);
      await flush();

      // Sit on the auth screen comfortably past one full safety-net
      // poll interval. If anything in the auth tree (or a future
      // top-level provider hoisted into MoreBadgesProvider)
      // accidentally subscribed, this assertion would be > 0.
      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS + 30_000);
      });
      await flush();
      expect(badgeCountsCalls()).toEqual([]);

      // The user signs in: the active child swaps from the auth tree
      // to the (tabs) layout, which calls `useBadgePolling()` and
      // therefore *must* fire one immediate fresh request so the
      // bottom-tab More badge isn't stale on landing.
      rerender(<App signedIn />);
      await flush();
      expect(badgeCountsCalls().length).toBe(1);
      expect(badgeCountsCalls()[0]).toContain(BADGE_COUNTS_PATH);
      expect(badgeCountsCalls()[0]).toContain("orgId=7");

      // ...and the new safety-net interval ticks at the configured
      // cadence. Advancing exactly one interval should yield exactly
      // one additional request — pinning that the source constant
      // and this test agree on the same value.
      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
      });
      await flush();
      expect(badgeCountsCalls().length).toBe(2);
    },
  );

  it("opening the real More screen fires a fresh /api/portal/badge-counts request immediately so the per-row counts aren't stale on landing", async () => {
    render(
      <MoreBadgesProvider>
        <MoreScreen />
      </MoreBadgesProvider>,
    );
    await flush();

    // The More screen calls `useBadgePolling()` so opening it always
    // triggers a fresh fetch — no waiting for the next safety-net
    // tick.
    expect(badgeCountsCalls().length).toBe(1);
    expect(badgeCountsCalls()[0]).toContain(BADGE_COUNTS_PATH);
  });
});
