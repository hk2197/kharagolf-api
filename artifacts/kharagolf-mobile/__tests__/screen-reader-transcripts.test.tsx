// Task #2173 — pin the remaining mobile screen-reader transcripts from
// docs/audits/accessibility-pass.md "Per-screen announcement transcripts"
// (the ones not already covered by Task #1750's screen-reader-labels.test).
// Each `it` below pins one focused element's accessibilityLabel +
// accessibilityRole + accessibilityState + accessibilityHint +
// accessibilityViewIsModal + `accessible={false}` props so future edits
// can't silently change what blind users hear.

import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { cleanup, render, screen, waitFor, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import enHome from "@/i18n/locales/en/home.json";
import enLeaderboard from "@/i18n/locales/en/leaderboard.json";

const { routerMock, focusCallbacks } = vi.hoisted(() => ({
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: () => true,
  },
  focusCallbacks: [] as Array<() => void | (() => void)>,
}));

// expo-router is also stubbed in __tests__/setup.ts; override here so the
// leaderboard test can pre-set params.tournamentId (its view-switcher tabs
// only render once selectedTournamentId is truthy).
const localSearchParams: { tournamentId?: string } = {};

vi.mock("expo-router", () => ({
  router: routerMock,
  useRouter: () => routerMock,
  useLocalSearchParams: () => localSearchParams,
  useSegments: () => [],
  useFocusEffect: (cb: () => void | (() => void)) => {
    focusCallbacks.push(cb);
  },
  Link: ({ children }: { children?: ReactNode }) => children,
  Stack: Object.assign(
    (({ children }: { children?: ReactNode }) => children) as React.FC<{ children?: ReactNode }>,
    { Screen: () => null },
  ),
}));

vi.mock("react-native-safe-area-context", () => {
  const Frag = ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return {
    SafeAreaView: Frag,
    SafeAreaProvider: Frag,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

vi.mock("@/i18n", () => ({
  default: { language: "en" },
  getLocale: () => "en-US",
  applyLanguage: async () => ({ needsReload: false }),
  loadSavedLanguage: async () => "en",
  getDeviceLanguage: () => "en",
  SUPPORTED_LANGUAGES: [{ code: "en", label: "English" }],
  LANGUAGE_STORAGE_KEY: "@kharagolf_language",
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1, email: "test@example.com", displayName: "Test", username: "test" },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    loginWithGoogle: vi.fn(async () => {}),
    loginWithApple: vi.fn(async () => {}),
  }),
  AuthProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({
    activeClub: { id: 1, organizationId: 1, name: "Test Club" },
    activeOrgId: 1,
    clubs: [{ id: 1, organizationId: 1, name: "Test Club" }],
    setActiveClub: vi.fn(),
  }),
}));

const moreBadgesValue = {
  counts: {
    notifications: 0,
    updates: 0,
    announcements: 0,
    feed: 0,
    peerInvites: 0,
    notices: 0,
    tieBreakMessages: 0,
  },
  refresh: async () => {},
};
const unreadValue = {
  unreadCount: 0,
  lastSeenAt: 0,
  setUnreadCount: () => {},
  markAllRead: async () => {},
  notifUnreadCount: 0,
  setNotifUnreadCount: () => {},
};
vi.mock("@/context/moreBadges", () => ({
  useMoreBadges: () => moreBadgesValue,
  useBadgePolling: () => {},
  MoreBadgesProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/context/unread", () => ({
  useUnread: () => unreadValue,
  UnreadProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/utils/backgroundHealthSync", () => ({
  registerBackgroundHealthSync: async () => {},
  unregisterBackgroundHealthSync: async () => {},
}));
vi.mock("@/utils/appleHealth", () => ({
  isAppleHealthSupported: () => false,
  syncAppleHealthLast7Days: async () => {},
}));
vi.mock("@/utils/healthConnect", () => ({
  isHealthConnectSupported: () => false,
  syncHealthConnectLast7Days: async () => {},
}));
vi.mock("@/utils/caddieOffline", () => ({
  prefetchSnapshot: async () => {},
  flushFeedbackQueue: async () => 0,
  loadSnapshot: async () => null,
  computeLocalRecommendation: () => null,
  sendOrQueueFeedback: async () => true,
}));
vi.mock("@/utils/caddieHistory", () => ({
  CADDIE_HISTORY_MAX_MESSAGES: 8,
  loadCaddieHistory: async () => [],
  saveCaddieHistory: async () => {},
  clearCaddieHistory: async () => {},
}));
vi.mock("@/utils/courseBundle", () => ({
  loadCachedCourseBundle: async () => null,
  loadCachedCourseBundleForRound: async () => null,
}));
vi.mock("@/utils/pinElevation", () => ({ interpolatePinElevation: () => 0 }));
vi.mock("@/utils/autoShotPayload", () => ({ buildAcceptedShotsPayload: () => [] }));

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
  getLocales: () => [{ languageCode: "en", regionCode: "US", languageTag: "en-US" }],
}));
vi.mock("expo-apple-authentication", () => ({
  AppleAuthenticationButton: () => null,
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  AppleAuthenticationButtonStyle: { BLACK: 0 },
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  isAvailableAsync: async () => false,
  signInAsync: async () => ({ identityToken: null, fullName: null }),
}));
vi.mock("expo-auth-session/providers/google", () => ({
  useIdTokenAuthRequest: () => [null, null, async () => null],
  useAuthRequest: () => [null, null, async () => null],
}));
vi.mock("expo-web-browser", () => ({
  maybeCompleteAuthSession: () => {},
  openAuthSessionAsync: async () => ({ type: "cancel" }),
}));
vi.mock("expo-clipboard", () => ({
  setStringAsync: async () => true,
  getStringAsync: async () => "",
}));
vi.mock("expo-camera", () => {
  const Stub = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return {
    CameraView: Stub,
    Camera: Stub,
    useCameraPermissions: () => [
      { status: "granted", granted: true },
      async () => ({ status: "granted", granted: true }),
    ],
    PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  };
});
vi.mock("expo-print", () => ({
  printAsync: async () => {},
  printToFileAsync: async () => ({ uri: "" }),
}));
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "/",
  cacheDirectory: "/",
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => "",
  deleteAsync: async () => {},
  getInfoAsync: async () => ({ exists: false }),
  EncodingType: { UTF8: "utf8", Base64: "base64" },
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
vi.mock("expo-av", () => ({
  Video: () => null,
  ResizeMode: { COVER: "cover", CONTAIN: "contain", STRETCH: "stretch" },
  Audio: { Sound: { createAsync: async () => ({ sound: null }) } },
}));
vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: async () => ({ status: "denied", granted: false }),
  requestBackgroundPermissionsAsync: async () => ({ status: "denied", granted: false }),
  getForegroundPermissionsAsync: async () => ({ status: "denied", granted: false }),
  watchPositionAsync: async () => ({ remove: () => {} }),
  getCurrentPositionAsync: async () => ({ coords: { latitude: 0, longitude: 0, accuracy: 5 } }),
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  ActivityType: { Other: 1, AutomotiveNavigation: 2, Fitness: 3, OtherNavigation: 4 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  startLocationUpdatesAsync: async () => {},
  stopLocationUpdatesAsync: async () => {},
  hasStartedLocationUpdatesAsync: async () => false,
}));
vi.mock("expo-task-manager", () => ({
  defineTask: () => {},
  isTaskDefined: () => false,
  isTaskRegisteredAsync: async () => false,
  unregisterTaskAsync: async () => {},
  getRegisteredTasksAsync: async () => [],
}));
vi.mock("expo-sensors", () => ({
  Accelerometer: {
    addListener: () => ({ remove: () => {} }),
    setUpdateInterval: () => {},
    isAvailableAsync: async () => false,
    requestPermissionsAsync: async () => ({ status: "denied", granted: false }),
  },
  Gyroscope: { addListener: () => ({ remove: () => {} }), setUpdateInterval: () => {} },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  selectionAsync: async () => {},
  notificationAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => {},
}));
vi.mock("expo-calendar", () => ({
  requestCalendarPermissionsAsync: async () => ({ status: "denied", granted: false }),
  getCalendarsAsync: async () => [],
  createEventAsync: async () => "",
  EntityTypes: { EVENT: "event" },
  CalendarType: { LOCAL: "local" },
  CalendarAccessLevel: { OWNER: "owner" },
  EventStatus: { CONFIRMED: "confirmed" },
  Availability: { BUSY: "busy" },
}));
vi.mock("expo-file-system", () => ({
  documentDirectory: "/",
  cacheDirectory: "/",
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => "",
  deleteAsync: async () => {},
  getInfoAsync: async () => ({ exists: false }),
  EncodingType: { UTF8: "utf8", Base64: "base64" },
}));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: () => {},
  getPermissionsAsync: async () => ({ status: "granted", granted: true }),
  requestPermissionsAsync: async () => ({ status: "granted", granted: true }),
  addNotificationReceivedListener: () => ({ remove: () => {} }),
  addNotificationResponseReceivedListener: () => ({ remove: () => {} }),
  removeNotificationSubscription: () => {},
  scheduleNotificationAsync: async () => "",
  cancelAllScheduledNotificationsAsync: async () => {},
}));

vi.mock("react-native-view-shot", () => ({ captureRef: async () => "" }));
vi.mock("react-native-svg", () => {
  const Stub = ({ children }: { children?: ReactNode }) =>
    React.createElement("span", null, children);
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
vi.mock("react-native-qrcode-svg", () => ({ default: () => null }));
vi.mock("react-native-razorpay", () => ({ default: { open: async () => ({}) } }));

vi.mock("../../modules/KharagolfWatchBridge", () => ({
  WatchBridge: {
    isReachable: async () => false,
    sendShotEvent: async () => {},
    sendHoleStart: async () => {},
    sendHoleEnd: async () => {},
    requestBatteryAuto: async () => null,
  },
  subscribeWatchBatteryAutoPct: () => () => {},
}));

vi.mock("@/components/MyUpcomingWidget", () => ({ MyUpcomingWidget: () => null, default: () => null }));
vi.mock("@/components/TournamentRegistrationSheet", () => ({ default: () => null }));
vi.mock("@/components/CurrencyPicker", () => ({ CurrencyPicker: () => null }));
vi.mock("@/components/LockerRenewalCard", () => ({ LockerRenewalCard: () => null }));
vi.mock("@/components/CaddieInsightsSection", () => ({ CaddieInsightsSection: () => null }));
vi.mock("@/components/LoyaltySection", () => ({ LoyaltySection: () => null }));
vi.mock("@/components/InvoicesSection", () => ({ InvoicesSection: () => null }));
vi.mock("@/components/RepairJobsSection", () => ({ RepairJobsSection: () => null }));
vi.mock("@/components/FittingSessionsSection", () => ({ FittingSessionsSection: () => null }));
vi.mock("@/components/MemberAvatar", () => ({ default: () => null }));
vi.mock("@/components/LiveOddsWidget", () => ({ default: () => null }));
vi.mock("@/components/InlineAdBanner", () => ({ default: () => null }));
vi.mock("@/components/ConsentPrompt", () => ({ default: () => null }));
vi.mock("@/components/FollowButton", () => ({ FollowButton: () => null }));
// QRCheckInScanner is intentionally NOT mocked — its named export is
// rendered directly in the QR scanner test below.
vi.mock("@/components/HoleShotReviewModal", () => ({ default: () => null }));
vi.mock("@/components/ShotReviewModal", () => ({ default: () => null }));
vi.mock("@/components/RoundSummaryHoleDots", () => ({ default: () => null }));
vi.mock("@/components/RoundSummaryCard", () => ({ default: () => null }));
vi.mock("@/components/SideGamesPanel", () => ({ SideGamesPanel: () => null }));
vi.mock("@/components/HoleMapSheet", () => ({ default: () => null, playsLikeBreakdown: () => null }));
vi.mock("@/components/GpsDistanceRow", () => ({ default: () => null }));
vi.mock("@/components/CaddieCard", () => ({ default: () => null }));
vi.mock("@/components/HrStrip", () => ({ AutoHoleHrStrip: () => null, HrStrip: () => null }));
vi.mock("@/components/WalletTxnRow", () => ({ WalletTxnRow: () => null }));
vi.mock("@/components/PriceWithFx", () => ({
  PriceWithFx: ({ amountUsd }: { amountUsd?: number }) =>
    React.createElement("span", null, `$${(amountUsd ?? 0).toFixed(2)}`),
}));
vi.mock("@/components/ShopCartTotalRow", () => ({ ShopCartTotalRow: () => null }));
vi.mock("@/components/UpgradePrompt", () => ({ default: () => null }));
vi.mock("@/components/StripeCheckoutModal", () => ({
  StripeCheckoutModal: () => null,
  stripeModuleAvailable: false,
}));
vi.mock("@/hooks/useFolloweeIds", () => ({ useFolloweeIds: () => new Set<number>() }));
vi.mock("@/app/my-360/_shared", () => ({
  BASE_URL: "",
  clearActingMemberId: () => {},
  getActingMemberId: () => null,
  setActingMemberId: () => {},
  useActingMemberId: () => [null, () => {}],
  actingQs: () => "",
  authedFetch: async () => ({
    badges: [],
    unlockedCount: 0,
    totalCount: 0,
    publicHandle: null,
    canShare: false,
  }),
}));
vi.mock("@/constants/avatarPresets", () => ({
  AVATAR_PRESETS: [],
  isPresetAvatar: () => false,
  getPresetId: () => null,
  PRESET_MAP: {},
}));

const fetchPublicStub = vi.fn(async (path: string) => {
  if (path === "/tournaments") return [];
  if (path.endsWith("/leaderboard")) return emptyLeaderboard();
  return null;
});

function emptyLeaderboard() {
  return {
    tournamentId: 1,
    tournamentName: "Test Tournament",
    entries: [],
    netEntries: [],
    stablefordEntries: [],
    byFlight: {},
    flights: [],
    lastUpdated: new Date().toISOString(),
    coursePar: 72,
    rounds: 1,
    organizationId: 1,
    format: "stroke_play",
    cutLineIndex: null,
    isTeamFormat: false,
  };
}

vi.mock("@/utils/api", async () => {
  const actual = await vi.importActual<typeof import("@/utils/api")>("@/utils/api");
  return {
    ...actual,
    BASE_URL: "",
    fetchPublic: (...args: Parameters<typeof actual.fetchPublic>) => fetchPublicStub(args[0] as string),
    fetchPortal: vi.fn(async () => null),
    postPublic: vi.fn(async () => ({})),
    postPortal: vi.fn(async () => ({})),
    patchPortal: vi.fn(async () => ({})),
    deletePortal: vi.fn(async () => ({})),
  };
});

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  let body: unknown = [];
  if (/\/wallet(\?|$)/.test(url)) {
    body = {
      wallet: { id: 1, organizationId: 1, userId: 1, currency: "INR", balance: 0 },
      transactions: [],
    };
  } else if (url.includes("/my-stats")) {
    body = { tournamentsPlayed: 0, totalScores: 0, averageStrokes: null, bestRound: null };
  } else if (url.includes("/wellness/today")) {
    body = { today: null, recommendation: null };
  } else if (url.includes("/unread-count")) {
    body = { unreadCount: 0, hasAny: false };
  } else if (url.includes("/wellness/connections")) {
    body = [];
  } else if (url.includes("/payout-account")) {
    body = null;
  } else if (url.includes("/erasures/storage-failures/summary")) {
    body = null;
  } else if (url.includes("/profile") || url.includes("/me")) {
    body = {};
  } else if (url.includes("/caddie/history")) {
    body = { messages: [], version: 0 };
  } else if (url.includes("/handicap/notifications")) {
    body = { unreadCount: 0, items: [], nextCursor: null };
  } else if (url.includes("/my-tie-break-messages")) {
    body = { unreadCount: 0, items: [] };
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

import { QRCheckInScanner } from "../components/QRCheckInScanner";
import { TopupModal, WithdrawModal } from "../app/wallet";
import { QuickActionTile } from "../app/(tabs)/index";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchInterval: false },
      mutations: { retry: false },
    },
  });
}

class A11yErrorBoundary extends React.Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return React.createElement(
        "div",
        { "data-render-error": "true" },
        `render error: ${this.state.error.message}`,
      );
    }
    return this.props.children;
  }
}

// react-native-web 0.21 silently drops React Native a11y props that lack a
// 1:1 ARIA mapping (accessibilityState, accessibilityHint,
// accessibilityViewIsModal, accessible={false}). Those props are still
// authoritative on native iOS / Android, so we read them off the React
// fiber instead of asserting DOM attributes.
function getRNPropsFor(
  node: Element,
  predicate: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  const fiberKey = Object.keys(node).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
  );
  if (!fiberKey) {
    throw new Error(`No React fiber attached to <${node.tagName.toLowerCase()}>`);
  }
  let fiber: { memoizedProps?: Record<string, unknown>; return?: unknown } | null =
    (node as unknown as Record<string, { memoizedProps?: Record<string, unknown>; return?: unknown }>)[fiberKey] ?? null;
  while (fiber) {
    if (fiber.memoizedProps && predicate(fiber.memoizedProps)) {
      return fiber.memoizedProps;
    }
    fiber = fiber.return as typeof fiber;
  }
  throw new Error("No React fiber matched the predicate");
}

function getPropsByLabel(label: string): Record<string, unknown> {
  const node = screen.getByLabelText(label);
  return getRNPropsFor(node, (p) => p.accessibilityLabel === label);
}

async function mountScreen(Component: React.ComponentType<unknown>): Promise<HTMLElement> {
  const client = makeQueryClient();
  const result = render(
    <QueryClientProvider client={client}>
      <A11yErrorBoundary>
        <Component />
      </A11yErrorBoundary>
    </QueryClientProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await waitFor(() => {
    expect(result.container.children.length).toBeGreaterThan(0);
  });
  const errorMarker = result.container.querySelector("[data-render-error='true']");
  if (errorMarker) {
    throw new Error(`screen failed to render: ${errorMarker.textContent}`);
  }
  return result.container as HTMLElement;
}

beforeAll(async () => {
  // setup.ts only loads scoring/profile/handicapCommittee/notifications;
  // add the home + leaderboard bundles so audited English strings resolve.
  if (!i18n.hasResourceBundle("en", "home")) {
    i18n.addResourceBundle("en", "home", enHome, true, true);
  }
  if (!i18n.hasResourceBundle("en", "leaderboard")) {
    i18n.addResourceBundle("en", "leaderboard", enLeaderboard, true, true);
  }
});

beforeEach(() => {
  routerMock.push.mockClear();
  routerMock.replace.mockClear();
  routerMock.back.mockClear();
  focusCallbacks.length = 0;
  fetchStub.mockClear();
  fetchPublicStub.mockClear();
  fetchPublicStub.mockImplementation(async (path: string) => {
    if (path === "/tournaments") return [];
    if (path.endsWith("/leaderboard")) return emptyLeaderboard();
    return null;
  });
  for (const key of Object.keys(localSearchParams)) {
    delete (localSearchParams as Record<string, unknown>)[key];
  }
  vi.stubGlobal("fetch", fetchStub as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QRCheckInScanner modal", () => {
  function renderScanner() {
    return render(
      <QRCheckInScanner visible={true} token="test-token" onClose={() => {}} />,
    );
  }

  it("title 'Scan Check-In QR' is a heading", () => {
    renderScanner();
    expect(screen.getByText("Scan Check-In QR").getAttribute("role")).toBe("heading");
  });

  it("close button reads 'Close QR scanner' as a button with non-focusable icon wrap", () => {
    renderScanner();
    const close = screen.getByLabelText("Close QR scanner");
    expect(close.getAttribute("role")).toBe("button");
    const iconNode = close.querySelector("[data-icon='x']");
    expect(iconNode).not.toBeNull();
    // The wrap around the icon must carry accessible={false} so SR
    // announces the parent button label only, not the icon name twice.
    const wrapProps = getRNPropsFor(iconNode!, (p) => p.accessible === false);
    expect(wrapProps.accessible).toBe(false);
  });

  it("modal body carries accessibilityViewIsModal", () => {
    renderScanner();
    const heading = screen.getByText("Scan Check-In QR");
    const props = getRNPropsFor(heading, (p) => p.accessibilityViewIsModal === true);
    expect(props.accessibilityViewIsModal).toBe(true);
  });
});

describe("Wallet TopupModal", () => {
  function renderTopup() {
    return render(
      <TopupModal
        visible={true}
        currency="INR"
        busy={false}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
  }

  it("title 'Add money to wallet' is a heading", () => {
    renderTopup();
    expect(screen.getByText("Add money to wallet").getAttribute("role")).toBe("heading");
  });

  it("backdrop close target reads 'Close' with the close-sheet hint", () => {
    renderTopup();
    expect(getPropsByLabel("Close").accessibilityHint).toBe("Closes the add money sheet");
  });

  it("modal body carries accessibilityViewIsModal", () => {
    renderTopup();
    const heading = screen.getByText("Add money to wallet");
    const props = getRNPropsFor(heading, (p) => p.accessibilityViewIsModal === true);
    expect(props.accessibilityViewIsModal).toBe(true);
  });

  it.each([500, 1000, 2000, 5000])("quick-amount button INR %i is a button", (amount) => {
    renderTopup();
    const btn = screen.getByLabelText(`Top up INR ${amount}`);
    expect(btn.getAttribute("role")).toBe("button");
  });

  it("custom-amount input reads 'Custom top-up amount in INR'", () => {
    renderTopup();
    expect(screen.getByLabelText("Custom top-up amount in INR").tagName.toLowerCase()).toBe("input");
  });
});

describe("Wallet WithdrawModal", () => {
  function renderWithdraw() {
    return render(
      <WithdrawModal
        visible={true}
        currency="INR"
        balance={1234.5}
        busy={false}
        account={{
          id: 1,
          method: "upi",
          upiVpa: "alice@upi",
          accountHolderName: null,
          bankAccountNumberLast4: null,
          bankIfsc: null,
          verified: true,
          createdAt: new Date().toISOString(),
        } as never}
        limits={{ minPerTxn: 100, maxPerTxn: 50000, maxPerDay: 100000 } as never}
        onClose={() => {}}
        onAddAccount={() => {}}
        onSubmit={() => {}}
      />,
    );
  }

  it("title 'Withdraw to UPI / bank' is a heading", () => {
    renderWithdraw();
    expect(screen.getByText("Withdraw to UPI / bank").getAttribute("role")).toBe("heading");
  });

  it("backdrop close target reads 'Close' with the withdraw-sheet hint", () => {
    renderWithdraw();
    expect(getPropsByLabel("Close").accessibilityHint).toBe("Closes the withdraw sheet");
  });

  it("modal body carries accessibilityViewIsModal", () => {
    renderWithdraw();
    const heading = screen.getByText("Withdraw to UPI / bank");
    const props = getRNPropsFor(heading, (p) => p.accessibilityViewIsModal === true);
    expect(props.accessibilityViewIsModal).toBe(true);
  });

  it("withdrawal-amount input reads 'Withdrawal amount in INR'", () => {
    renderWithdraw();
    expect(screen.getByLabelText("Withdrawal amount in INR").tagName.toLowerCase()).toBe("input");
  });

  it("Max button reads 'Use full available balance INR <balance>'", () => {
    renderWithdraw();
    const max = screen.getByLabelText("Use full available balance INR 1234.50");
    expect(max.getAttribute("role")).toBe("button");
  });
});

describe("Mobile home QuickActionTile", () => {
  // Audited home tiles per docs/audits/accessibility-pass.md and
  // QUICK_ACTIONS in app/(tabs)/index.tsx — pin all four so a future edit
  // that drops a tile or swaps a translation key breaks the test.
  const tiles = [
    { iconName: "clock", label: "Tee Bookings", sublabel: "Reserve a slot" },
    { iconName: "edit-2", label: "Score", sublabel: "Record a round" },
    { iconName: "trophy", label: "Compete", sublabel: "Tournaments & leagues" },
    { iconName: "message-square", label: "Club Feed", sublabel: "Member posts" },
  ];

  it.each(tiles)("$label tile reads '$label. $sublabel' with non-focusable icon wrap", ({ iconName, label, sublabel }) => {
    const item = {
      icon: <span data-icon={iconName} />,
      label,
      sublabel,
      onPress: () => {},
    };
    render(<QuickActionTile item={item as never} />);
    const tile = screen.getByLabelText(`${label}. ${sublabel}`);
    expect(tile.getAttribute("role")).toBe("button");
    const iconNode = tile.querySelector(`[data-icon='${iconName}']`);
    expect(iconNode).not.toBeNull();
    const iconWrapProps = getRNPropsFor(iconNode!, (p) => p.accessible === false);
    expect(iconWrapProps.accessible).toBe(false);
  });
});

describe("Mobile home notifications bell", () => {
  it("reads 'Notifications' as a button", async () => {
    const mod = await import("../app/(tabs)/index");
    await mountScreen(mod.default);
    const bell = screen.getByLabelText("Notifications");
    expect(bell.getAttribute("role")).toBe("button");
  });
});

describe("AI Caddie composer + starter chips", () => {
  it("composer input reads 'Message AI Caddie'", async () => {
    const mod = await import("../app/ai-caddie");
    await mountScreen(mod.default);
    const composer = screen.getByLabelText("Message AI Caddie");
    expect(["textarea", "input"]).toContain(composer.tagName.toLowerCase());
  });

  it("each starter chip reads 'Ask: <prompt>' inside the chips list", async () => {
    const mod = await import("../app/ai-caddie");
    await mountScreen(mod.default);
    const prompts = [
      "What should I work on this week?",
      "What club from 150 yards into the wind?",
      "How is my approach play trending?",
    ];
    for (const p of prompts) {
      const chip = screen.getByLabelText(`Ask: ${p}`);
      expect(chip.getAttribute("role")).toBe("button");
    }
    const list = document.querySelector("[role='list']");
    expect(list).not.toBeNull();
    for (const p of prompts) {
      expect(within(list as HTMLElement).getByLabelText(`Ask: ${p}`)).toBeTruthy();
    }
  });
});

describe("Leaderboard view-switcher tabs", () => {
  it("Leaderboard / Tee Sheet / Chat tabs carry role=tab + accessibilityState.selected", async () => {
    localSearchParams.tournamentId = "1";
    fetchPublicStub.mockImplementation(async (path: string) => {
      if (path === "/tournaments") {
        return [{
          id: 1,
          name: "Test Tournament",
          organizationId: 1,
          organizationName: "Test Club",
          startDate: new Date().toISOString(),
          endDate: null,
          maxPlayers: 16,
          playerCount: 0,
          isFull: false,
          status: "live",
          format: "stroke_play",
          rounds: 1,
        }];
      }
      if (path.endsWith("/leaderboard")) return emptyLeaderboard();
      return null;
    });

    const mod = await import("../app/(tabs)/leaderboard");
    await mountScreen(mod.default);

    const tabLeaderboard = await waitFor(() => screen.getByLabelText("Leaderboard"));
    expect(tabLeaderboard.getAttribute("role")).toBe("tab");
    expect(getRNPropsFor(tabLeaderboard, (p) => p.accessibilityLabel === "Leaderboard").accessibilityState).toMatchObject({ selected: true });

    const tabTeeSheet = screen.getByLabelText("Tee Sheet");
    expect(tabTeeSheet.getAttribute("role")).toBe("tab");
    expect(getRNPropsFor(tabTeeSheet, (p) => p.accessibilityLabel === "Tee Sheet").accessibilityState).toMatchObject({ selected: false });

    const tabChat = screen.getByLabelText("Chat");
    expect(tabChat.getAttribute("role")).toBe("tab");
    expect(getRNPropsFor(tabChat, (p) => p.accessibilityLabel === "Chat").accessibilityState).toMatchObject({ selected: false });
  });
});

describe("Leaderboard missed-cut section header", () => {
  it("reads 'Missed the Cut, 12 players' as a collapsed button", async () => {
    localSearchParams.tournamentId = "1";
    fetchPublicStub.mockImplementation(async (path: string) => {
      if (path === "/tournaments") {
        return [{
          id: 1,
          name: "Test Tournament",
          organizationId: 1,
          organizationName: "Test Club",
          startDate: new Date().toISOString(),
          endDate: null,
          maxPlayers: 16,
          playerCount: 0,
          isFull: false,
          status: "live",
          format: "stroke_play",
          rounds: 1,
        }];
      }
      if (path.endsWith("/leaderboard")) {
        const survivor = (id: number) => ({
          playerId: id, userId: null, playerName: `Player ${id}`,
          position: id, positionDisplay: String(id),
          grossScore: 70 + id, netScore: null,
          scoreToPar: id - 2, netToPar: null,
          stablefordPoints: null, parBogeyScore: null,
          thru: "18", flight: null, flights: [],
          handicapIndex: 0, holeScores: [], roundScores: [],
          currentRound: 1,
          stats: { eagles: 0, birdies: 0, pars: 18, bogeys: 0, doublePlus: 0 },
          isVerified: false, madeCut: true,
        });
        const cut = (id: number) => ({ ...survivor(id), madeCut: false });
        return {
          ...emptyLeaderboard(),
          entries: [
            survivor(1), survivor(2), survivor(3),
            cut(10), cut(11), cut(12), cut(13), cut(14),
            cut(15), cut(16), cut(17), cut(18), cut(19),
            cut(20), cut(21),
          ],
          cutLineIndex: 3,
        };
      }
      return null;
    });

    const mod = await import("../app/(tabs)/leaderboard");
    await mountScreen(mod.default);

    const header = await waitFor(() =>
      screen.getByLabelText("Missed the Cut, 12 players"),
    );
    expect(header.getAttribute("role")).toBe("button");
    const props = getRNPropsFor(
      header,
      (p) => p.accessibilityLabel === "Missed the Cut, 12 players",
    );
    expect(props.accessibilityState).toMatchObject({ expanded: false });
  });
});

describe("Mobile scoring add-to-calendar", () => {
  it("reads 'Add <tournament name> to calendar' as a button", async () => {
    fetchPublicStub.mockImplementation(async (path: string) => {
      if (path === "/tournaments") {
        return [{
          id: 1,
          name: "Spring Open",
          organizationId: 1,
          organizationName: "Test Club",
          startDate: new Date("2026-03-12").toISOString(),
          endDate: null,
          maxPlayers: 16,
          playerCount: 0,
          isFull: false,
          status: "live",
          format: "stroke_play",
          rounds: 1,
        }];
      }
      return null;
    });

    const mod = await import("../app/(tabs)/score");
    await mountScreen(mod.default);

    const cal = await waitFor(() => screen.getByLabelText("Add Spring Open to calendar"));
    expect(cal.getAttribute("role")).toBe("button");
  });
});
