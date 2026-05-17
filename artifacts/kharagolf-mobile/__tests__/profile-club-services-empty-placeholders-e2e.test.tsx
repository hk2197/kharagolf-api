/**
 * Task #1873 — Mobile e2e coverage for the always-mounted club-services
 * empty placeholders on `app/(tabs)/profile.tsx`.
 *
 * Task #1520 made the mobile profile *always* render the
 *   <InvoicesSection />, <RepairJobsSection />, <FittingSessionsSection />
 * trio so members see the "No invoices yet / No repair jobs yet / No
 * fitting sessions yet" placeholders instead of having those sections
 * silently disappear when there's no data. The empty-state copy itself
 * is unit-tested in InvoicesSection.test.tsx / RepairJobsSection.test.tsx
 * / FittingSessionsSection.test.tsx (Task #1285), but until now there
 * was no end-to-end test asserting that mounting the *real* profile
 * screen with a member who has zero invoices, repairs and fittings
 * actually surfaces those three placeholder cards.
 *
 * Without this guard, a future cleanup of the parent could re-introduce
 * the `length > 0` conditional on any one of the three sections and
 * silently regress the always-mounted contract.
 *
 * Transport mirrors the established mobile e2e tier (vitest +
 * react-native-web; see `wallet-txn-deeplink-e2e.test.tsx` and
 * `committee-case-opened-summary-e2e.test.tsx`), so this file is picked
 * up by `pnpm --filter @workspace/kharagolf-mobile test` in CI without
 * any extra wiring. Heavy sibling components (locker, loyalty, wellness,
 * caddie insights, etc.) are stubbed out so the test focuses on the
 * three sections under contract; the three sections-under-test are
 * deliberately NOT mocked so their real testIDs (`invoices-empty`,
 * `repairs-empty`, `fittings-empty`) drive the assertions.
 */
import React, { type ReactNode } from "react";
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
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── expo-router / safe-area / context stubs ───────────────────────────────

vi.mock("expo-router", () => {
  const ReactInner = require("react") as typeof React;
  function Stack(props: { children?: React.ReactNode }) {
    return ReactInner.createElement(ReactInner.Fragment, null, props.children);
  }
  (Stack as unknown as { Screen: React.FC }).Screen = function Screen() {
    return null;
  };
  return {
    Stack,
    router: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
    useLocalSearchParams: () => ({}),
    useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
    useSegments: () => [],
    useFocusEffect: () => {},
    Link: ({ children }: { children?: ReactNode }) => children,
  };
});

vi.mock("react-native-safe-area-context", () => {
  const ReactInner = require("react") as typeof React;
  return {
    SafeAreaView: ({ children }: { children?: ReactNode }) =>
      ReactInner.createElement(ReactInner.Fragment, null, children),
    SafeAreaProvider: ({ children }: { children?: ReactNode }) =>
      ReactInner.createElement(ReactInner.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// Member with no club-services activity. The seed deliberately matches
// the "fresh member" fixture the task description calls out: zero
// invoices, repair jobs and fitting sessions.
const ORG_ID = 7;
const USER_ID = 42;

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: {
      id: USER_ID,
      email: "fresh-member@example.com",
      displayName: "Fresh Member",
      username: "fresh.member",
      organizationId: ORG_ID,
    },
    isAuthenticated: true,
    isLoading: false,
    refreshUser: vi.fn(async () => {}),
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
  }),
  AuthProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({
    isSuperAdmin: false,
    canSwitchClub: false,
    activeOrgId: ORG_ID,
    activeClub: { id: ORG_ID, organizationId: ORG_ID, name: "Test GC" },
    clubs: [{ id: ORG_ID, organizationId: ORG_ID, name: "Test GC" }],
    switchClub: vi.fn(async () => {}),
    setActiveClub: vi.fn(),
  }),
}));

// ── Native module / Expo stubs (mirrors the a11y harness) ─────────────────

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiGet: async () => [],
    multiSet: async () => {},
    multiRemove: async () => {},
    clear: async () => {},
    getAllKeys: async () => [],
  },
}));

vi.mock("expo-localization", () => ({
  getLocales: () => [
    { languageCode: "en", regionCode: "US", languageTag: "en-US" },
  ],
}));

vi.mock("@/i18n", () => ({
  default: { language: "en" },
  getLocale: () => "en-US",
  applyLanguage: async () => ({ needsReload: false }),
  loadSavedLanguage: async () => "en",
  getDeviceLanguage: () => "en",
  SUPPORTED_LANGUAGES: [{ code: "en", label: "English" }],
  LANGUAGE_STORAGE_KEY: "@kharagolf_language",
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: async () => ({ canceled: true, assets: null }),
  launchCameraAsync: async () => ({ canceled: true, assets: null }),
  requestMediaLibraryPermissionsAsync: async () => ({ status: "granted", granted: true }),
  requestCameraPermissionsAsync: async () => ({ status: "granted", granted: true }),
  MediaTypeOptions: { Images: "Images", Videos: "Videos", All: "All" },
  MediaType: { Image: "image", Video: "video" },
}));

vi.mock("expo-image-manipulator", () => ({
  manipulateAsync: async (uri: string) => ({ uri, width: 0, height: 0 }),
  SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
  FlipType: {},
}));

vi.mock("react-native-svg", () => {
  const ReactInner = require("react") as typeof React;
  const Stub = ({ children }: { children?: ReactNode }) =>
    ReactInner.createElement("span", null, children);
  return {
    default: Stub,
    Svg: Stub,
    SvgXml: () => null,
    SvgUri: () => null,
    Circle: () => null,
    Ellipse: () => null,
    G: Stub,
    Line: () => null,
    Path: () => null,
    Polygon: () => null,
    Polyline: () => null,
    Rect: () => null,
    Text: Stub,
  };
});

vi.mock("@/utils/appleHealth", () => ({
  isAppleHealthSupported: () => false,
  syncAppleHealthLast7Days: async () => ({ daysWritten: 0 }),
}));
vi.mock("@/utils/healthConnect", () => ({
  isHealthConnectSupported: () => false,
  syncHealthConnectLast7Days: async () => ({ daysWritten: 0 }),
}));

vi.mock("@/constants/avatarPresets", () => ({
  AVATAR_PRESETS: [],
  isPresetAvatar: () => false,
  getPresetId: () => null,
  PRESET_MAP: {},
}));

// Heavy sibling components — replace with no-op renderers so we can
// mount the parent screen without dragging their dependency trees in.
// CRITICAL: do NOT mock InvoicesSection / RepairJobsSection /
// FittingSessionsSection — those are the components under test and
// must render their real `*-empty` testIDs.
const stub = () => null;
vi.mock("@/components/CurrencyPicker", () => ({ CurrencyPicker: stub }));
vi.mock("@/components/PriceWithFx", () => {
  const ReactInner = require("react") as typeof React;
  return {
    PriceWithFx: ({ amount, currency }: { amount?: number | string; currency?: string }) =>
      ReactInner.createElement("span", null, `${currency ?? ""} ${amount ?? ""}`),
  };
});
vi.mock("@/components/LockerRenewalCard", () => ({ LockerRenewalCard: stub }));
vi.mock("@/components/CaddieInsightsSection", () => ({ CaddieInsightsSection: stub }));
vi.mock("@/components/LoyaltySection", () => ({ LoyaltySection: stub }));
vi.mock("@/components/MemberAvatar", () => ({ default: stub }));

// ── Fetch stub: zero invoices / repairs / fittings for this member ────────

type FetchMock = Mock<
  (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
>;
let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    // The three endpoints the always-mounted sections feed off must
    // resolve to *empty arrays* — that's how a fresh member with no
    // club-services activity looks on the wire.
    if (/\/api\/organizations\/\d+\/dues-billing\/my-invoices/.test(url)) {
      return jsonResponse([]);
    }
    if (/\/api\/organizations\/\d+\/repair-jobs\/member\/me/.test(url)) {
      return jsonResponse([]);
    }
    if (/\/api\/organizations\/\d+\/fitting-sessions\/member\/me/.test(url)) {
      return jsonResponse([]);
    }

    // Everything else profile.tsx fans out to during initial load —
    // give it a defensible default so the screen renders cleanly.
    if (url.includes("/api/portal/my-stats")) {
      return jsonResponse({
        tournamentsPlayed: 0,
        totalScores: 0,
        averageStrokes: null,
        bestRound: null,
      });
    }
    if (url.includes("/api/portal/my-tournaments")) return jsonResponse([]);
    if (url.includes("/api/portal/notification-preferences")) {
      return jsonResponse({
        preferEmail: true,
        preferPush: true,
        preferSms: false,
        preferWhatsapp: false,
        notifyMemberDocuments: true,
        notifyCommitteePeerDigest: true,
        hasPhone: false,
        hasPushToken: false,
        isCommitteeMember: false,
      });
    }
    if (url.includes("/api/portal/locker")) {
      return jsonResponse({ assignment: null, waitlistEntry: null });
    }
    if (url.includes("/api/portal/rankings/history")) return jsonResponse([]);
    if (url.includes("/api/portal/caddie/feedback/summary")) {
      // CaddieInsightsSection is stubbed out for this test, so an empty
      // 200 with the consent-allowed shape is enough — the parent only
      // setCaddieInsights(json)s and moves on.
      return jsonResponse({
        total: 0,
        accepted: 0,
        overridden: 0,
        pending: 0,
        acceptanceRate: null,
        avgProximityAccepted: null,
        avgProximityOverridden: null,
        proximityAcceptedSamples: 0,
        proximityOverriddenSamples: 0,
        mostOverriddenClubs: [],
        perClub: [],
        perLie: [],
      });
    }
    if (/\/api\/organizations\/\d+\/loyalty\/me/.test(url)) {
      return jsonResponse({ account: null });
    }
    if (/\/api\/organizations\/\d+\/loyalty\/rewards/.test(url)) {
      return jsonResponse([]);
    }

    // Wellness panel calls — return empty/null shapes so the recovery
    // section renders nothing without crashing.
    if (url.includes("/api/portal/wellness/today")) {
      return jsonResponse({ today: null, recommendation: null });
    }
    if (url.includes("/api/portal/wellness/daily")) {
      return jsonResponse({ series: [] });
    }
    if (url.includes("/api/portal/wellness/consent")) {
      return jsonResponse({ consents: [] });
    }
    if (url.includes("/api/portal/wearable-connections")) {
      return jsonResponse({ connections: [] });
    }

    // Anything else — keep loud so a future profile-screen change that
    // fans out to a new endpoint is forced to add an explicit handler
    // here on purpose, instead of silently being treated as success.
    throw new Error(
      `Unexpected fetch in profile club-services empty e2e: ${url}`,
    );
  }) as unknown as FetchMock;

  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── Screen under test (after mocks) ───────────────────────────────────────
//
// Lazy-import inside the test so all the `vi.mock(...)` calls above are
// in effect by the time the module graph is walked.

describe("ProfileTab — always-mounted club-services empty placeholders (Task #1873)", () => {
  it(
    "renders the invoices/repairs/fittings empty placeholder cards for a fresh member with no data",
    async () => {
      const ProfileTab = (await import("../app/(tabs)/profile")).default;

      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      await act(async () => {
        render(
          React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(ProfileTab, null),
          ),
        );
      });

      // The three placeholder cards from Task #1520 — each must mount
      // even though the corresponding list is empty.
      await waitFor(
        () => {
          expect(screen.getByTestId("invoices-empty")).toBeInTheDocument();
          expect(screen.getByTestId("repairs-empty")).toBeInTheDocument();
          expect(screen.getByTestId("fittings-empty")).toBeInTheDocument();
        },
        { timeout: 3000 },
      );

      // And no list rows from any of the three sections leaked in. If
      // somebody later swaps the mock fetch to return a populated list
      // by accident this assertion will catch it before the placeholder
      // assertions silently start passing for the wrong reason.
      expect(screen.queryByTestId(/^invoice-row-/)).toBeNull();
      expect(screen.queryByTestId(/^repair-row-/)).toBeNull();
      expect(screen.queryByTestId(/^fitting-row-/)).toBeNull();

      // Sanity-check that the three section wrappers themselves
      // mounted — guards against a regression where the parent removes
      // one of the components entirely (an empty wrapper would still
      // pass the `*-empty` lookup if the testID were moved).
      expect(screen.getByTestId("invoices-section")).toBeInTheDocument();
      expect(screen.getByTestId("repairs-section")).toBeInTheDocument();
      expect(screen.getByTestId("fittings-section")).toBeInTheDocument();
    },
  );
});
