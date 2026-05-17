import { vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enProfile from "@/i18n/locales/en/profile.json";
import enHandicapCommittee from "@/i18n/locales/en/handicapCommittee.json";
import enNotifications from "@/i18n/locales/en/notifications.json";
import enScoring from "@/i18n/locales/en/scoring.json";

// Eagerly import `react-native` (aliased to `react-native-web` in
// vitest.config.ts) here in setup so the ~2s cost of evaluating its module
// graph is paid once during test-file setup instead of being charged to the
// first `it(...)` that touches a screen. Without this, the very first
// screen-mounting case in any file (e.g. the sign-in row in
// `a11y-mobile-screens.test.tsx`) burns most of the default 5s Vitest
// timeout just on the synchronous react-native-web boot, leaving little
// headroom for the actual render+axe scan and intermittently timing out
// on slower CI runners. Subsequent imports hit the module cache and are
// effectively free, so this only shifts cost — it doesn't add any.
import "react-native";

// React Native and a number of Expo modules (e.g. `expo-modules-core`,
// pulled in transitively by `expo-notifications`/`expo-splash-screen`) probe
// the `__DEV__` global at import time. Under jsdom that global is undefined,
// which crashes the module graph with `ReferenceError: __DEV__ is not
// defined` before any test mock can intercept things. Defining it once here
// keeps every notification-related (and future Expo-importing) test loadable
// without each file having to redefine the shim.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// `expo-secure-store` synchronously calls `requireNativeModule('ExpoSecureStore')`
// at module load, which pulls in `expo-modules-core`. That package's
// `EventEmitter.ts` reads `globalThis.expo.EventEmitter` at import time — a
// global only present in real Expo runtimes. Under jsdom it's undefined and
// the whole module graph crashes with
// `TypeError: Cannot read properties of undefined (reading 'EventEmitter')`
// before any per-test mock can run. Several mobile contexts
// (`@/context/auth`, `@/context/activeClub`) import `expo-secure-store` at
// module scope, so anything that imports those — e.g. the notifications inbox
// route at `app/(tabs)/notifications.tsx` — is affected. Stubbing the package
// here breaks the chain centrally so tests don't need their own per-file
// shim, and matches what individual specs (a11y-mobile-screens etc.) used to
// do inline.
//
// NOTE: this stub is in-memory and shared per test file. Tests that need to
// exercise real `expo-secure-store` behavior (e.g. cross-key persistence
// edge cases, or to assert on specific call arguments) should override it
// with their own `vi.mock("expo-secure-store", ...)` or `vi.doMock(...)` —
// see `__tests__/backgroundHealthSync.test.ts` for an example.
vi.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: async (key: string) => store.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      store.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      store.delete(key);
    },
    isAvailableAsync: async () => true,
    AFTER_FIRST_UNLOCK: 1,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 2,
    ALWAYS: 3,
    ALWAYS_THIS_DEVICE_ONLY: 4,
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 5,
    WHEN_UNLOCKED: 6,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
  };
});

vi.mock("@expo/vector-icons", () => {
  const React = require("react");
  const Stub = (props: { name?: string }) =>
    React.createElement("span", { "data-icon": props?.name ?? "icon" });
  return { Feather: Stub, Ionicons: Stub, MaterialIcons: Stub };
});

// expo-router ships untransformed JSX from its `src/` paths in newer versions,
// so importing anything that pulls it in (e.g. `useLocalSearchParams` from a
// route module like `app/(tabs)/match-play.tsx`) crashes Vitest with
// `SyntaxError: Unexpected token '<'`. Stubbing the package globally keeps
// bracket-related tests (and any future route-importing tests) loadable.
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSegments: () => [],
  useFocusEffect: () => {},
  Link: ({ children }: { children?: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: () => {}, replace: () => {}, back: () => {} },
}));

vi.mock("@/constants/colors", () => ({
  default: {
    primary: "#0a0",
    background: "#000",
    surface: "#111",
    border: "#222",
    tabIconDefault: "#888",
  },
}));

// Minimal i18n init for tests. Components that call useTranslation get real
// English strings instead of raw key paths. Translation parity for non-English
// locales is enforced by the JSON files themselves; tests run in "en".
if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    defaultNS: "profile",
    ns: ["profile", "handicapCommittee", "scoring", "notifications"],
    resources: {
      en: {
        profile: enProfile,
        handicapCommittee: enHandicapCommittee,
        scoring: enScoring,
        notifications: enNotifications,
      },
    },
    interpolation: { escapeValue: false },
  });
}
