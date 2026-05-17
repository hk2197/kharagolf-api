/**
 * Regression test for Task #1440 — three accessibility-label tweaks landed
 * to make VoiceOver / TalkBack read naturally on the wallet, mobile
 * leaderboard, and mobile sign-in error box. The visible UI is unchanged,
 * so a sighted reviewer would never catch a future revert. This file mounts
 * each affected component and asserts the exact `accessibilityLabel`
 * (and `accessibilityRole="alert"` + `accessibilityLiveRegion="assertive"`
 * on the sign-in error) recorded under "Per-screen announcement transcripts"
 * in `docs/audits/accessibility-pass.md`.
 *
 *   1. `WalletTxnRow` — literal "plus"/"minus" words, formatted amount,
 *      currency-on-balance.
 *   2. `LeaderboardRow` — "through hole N" instead of "thru N", with all
 *      five score variants (stroke gross, stroke net + missed cut,
 *      stableford, par/bogey, no-score).
 *   3. Mobile sign-in error `<Text>` — `accessibilityRole="alert"` +
 *      `accessibilityLiveRegion="assertive"` on the leaf so the error is
 *      announced when it mounts, while the resend link stays focusable.
 */

// react-native-web wires Pressable/TouchableOpacity to DOM clicks, so we
// fire the sign-in submit through fireEvent — which needs a stable mock for
// every Expo / native module the LoginScreen imports at module scope.

import React, { type ReactNode } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Module-level mocks (must run before importing the screens) ──────────

vi.mock("@/utils/api", () => ({
  BASE_URL: "",
  fetchPublic: vi.fn(),
  fetchPortal: vi.fn(),
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: null,
    isAuthenticated: false,
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
    activeClub: null,
    activeOrgId: null,
    clubs: [],
    setActiveClub: vi.fn(),
  }),
}));

vi.mock("@/i18n", () => ({
  default: { language: "en" },
  getLocale: () => "en-US",
}));

vi.mock("@/hooks/useFolloweeIds", () => ({
  useFolloweeIds: () => new Set<number>(),
}));

vi.mock("@/components/MemberAvatar", () => ({ default: () => null }));
vi.mock("@/components/LiveOddsWidget", () => ({ default: () => null }));
vi.mock("@/components/InlineAdBanner", () => ({ default: () => null }));
vi.mock("@/components/ConsentPrompt", () => ({ default: () => null }));
vi.mock("@/components/FollowButton", () => ({ FollowButton: () => null }));
vi.mock("@/components/PriceWithFx", () => ({ PriceWithFx: () => null }));

vi.mock("react-native-safe-area-context", () => {
  const Frag = ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return {
    SafeAreaView: Frag,
    SafeAreaProvider: Frag,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: async () => ({ canceled: true }),
  launchCameraAsync: async () => ({ canceled: true }),
  requestMediaLibraryPermissionsAsync: async () => ({ status: "granted", granted: true }),
  requestCameraPermissionsAsync: async () => ({ status: "granted", granted: true }),
  MediaTypeOptions: { Images: "Images" },
}));

vi.mock("expo-av", () => ({
  Video: () => null,
  ResizeMode: { COVER: "cover", CONTAIN: "contain" },
}));

vi.mock("expo-apple-authentication", () => ({
  AppleAuthenticationButton: () => null,
  AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1 },
  AppleAuthenticationButtonStyle: { BLACK: 0, WHITE: 1 },
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  isAvailableAsync: async () => false,
  signInAsync: async () => ({ identityToken: null }),
}));

vi.mock("expo-auth-session/providers/google", () => ({
  useIdTokenAuthRequest: () => [null, null, async () => null],
}));

vi.mock("expo-web-browser", () => ({
  maybeCompleteAuthSession: () => {},
}));

// ── Imports of the actual components under test ─────────────────────────

import { WalletTxnRow, type WalletTxnRowData } from "../components/WalletTxnRow";
import {
  LeaderboardRow,
  type LeaderboardEntry,
  type ScoreMode,
} from "../app/(tabs)/leaderboard";
import LoginScreen from "../app/(auth)/login";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── 1. WalletTxnRow — literal plus/minus + formatted amount + currency-on-balance

describe("WalletTxnRow accessibilityLabel (Task #1440)", () => {
  function expectedWalletLabel(
    txn: WalletTxnRowData,
    sign: "plus" | "minus",
    label: string,
    amountFormatted: string,
    balanceFormatted: string,
  ): string {
    const date = new Date(txn.createdAt);
    const dateStr = date.toLocaleDateString();
    const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `${txn.kind === "credit" ? "Credit" : "Debit"}, ${label}, ${sign} ${amountFormatted} ${txn.currency}, on ${dateStr} at ${timeStr}, balance ${balanceFormatted} ${txn.currency}`;
  }

  it("credit row reads 'Credit, …, plus 500.00 INR, …, balance 1,500.00 INR'", () => {
    const txn: WalletTxnRowData = {
      id: 1,
      kind: "credit",
      amount: 500,
      currency: "INR",
      sourceType: "wallet_topup_razorpay",
      paymentRef: null,
      note: null,
      balanceAfter: 1500,
      createdAt: new Date("2026-04-24T10:30:00Z").toISOString(),
    };
    render(<WalletTxnRow txn={txn} orgId={null} token={null} />);
    const row = screen.getByTestId(`wallet-txn-row-${txn.id}`);
    const expected = expectedWalletLabel(txn, "plus", "Wallet top-up", "500.00", "1,500.00");
    expect(row.getAttribute("aria-label")).toBe(expected);
    // Guard the natural-reading parts independently so a date-format change
    // alone (which would shift the whole string) cannot mask a "plus"
    // → "+" or "1,500.00 INR" → "1500" silent regression.
    expect(row.getAttribute("aria-label")).toMatch(/\bplus 500\.00 INR\b/);
    expect(row.getAttribute("aria-label")).toMatch(/\bbalance 1,500\.00 INR\b/);
  });

  it("debit row reads 'Debit, Tee-time booking, minus 1,200.00 INR, …, balance 300.00 INR'", () => {
    const txn: WalletTxnRowData = {
      id: 2,
      kind: "debit",
      amount: 1200,
      currency: "INR",
      sourceType: "tee_time_charge",
      paymentRef: null,
      note: "Tee-time booking",
      balanceAfter: 300,
      createdAt: new Date("2026-04-22T07:15:00Z").toISOString(),
    };
    render(<WalletTxnRow txn={txn} orgId={null} token={null} />);
    const row = screen.getByTestId(`wallet-txn-row-${txn.id}`);
    const expected = expectedWalletLabel(txn, "minus", "Tee-time booking", "1,200.00", "300.00");
    expect(row.getAttribute("aria-label")).toBe(expected);
    expect(row.getAttribute("aria-label")).toMatch(/\bminus 1,200\.00 INR\b/);
    expect(row.getAttribute("aria-label")).toMatch(/\bbalance 300\.00 INR\b/);
  });
});

// ── 2. LeaderboardRow — "through hole N" + 5 variants ───────────────────

function makeEntry(overrides: Partial<LeaderboardEntry>): LeaderboardEntry {
  return {
    playerId: 1,
    userId: null,
    playerName: "Player",
    position: 1,
    positionDisplay: "1",
    grossScore: null,
    netScore: null,
    scoreToPar: null,
    netToPar: null,
    stablefordPoints: null,
    parBogeyScore: null,
    thru: "18",
    flight: null,
    flights: [],
    handicapIndex: 0,
    holeScores: [],
    roundScores: [],
    currentRound: 1,
    stats: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
    isVerified: false,
    madeCut: true,
    ...overrides,
  };
}

function findLeaderboardRow(): HTMLElement {
  // The row Pressable renders as a button via react-native-web — find it by
  // role rather than testID so we don't rely on internal structure.
  return screen.getByRole("button");
}

describe("LeaderboardRow accessibilityLabel (Task #1440)", () => {
  function renderRow(entry: LeaderboardEntry, mode: ScoreMode, format: string | null) {
    return render(
      <LeaderboardRow
        entry={entry}
        mode={mode}
        format={format}
        index={0}
        onPress={() => {}}
      />,
    );
  }

  it("stroke-play, gross, made cut", () => {
    renderRow(
      makeEntry({
        playerName: "Aarav Patel",
        position: 1,
        positionDisplay: "1",
        grossScore: 72,
        scoreToPar: 2,
        thru: "18",
        flight: "Flight A",
        madeCut: true,
      }),
      "gross",
      "stroke_play",
    );
    const row = findLeaderboardRow();
    expect(row.getAttribute("aria-label")).toBe(
      "Position 1, Aarav Patel, Flight A, gross 72, +2 to par, through hole 18",
    );
    expect(row).toHaveTextContent(/.*/); // sanity
  });

  it("stroke-play, net, missed cut", () => {
    renderRow(
      makeEntry({
        playerName: "Riya Shah",
        position: 45,
        positionDisplay: "T-45",
        netScore: 84,
        netToPar: 14,
        thru: "18",
        flight: "Flight B",
        madeCut: false,
      }),
      "net",
      "stroke_play",
    );
    const row = findLeaderboardRow();
    expect(row.getAttribute("aria-label")).toBe(
      "Position T-45, Riya Shah, Flight B, net 84, +14 to par, through hole 18, missed cut",
    );
  });

  it("stableford row", () => {
    renderRow(
      makeEntry({
        playerName: "Vikram Iyer",
        position: 3,
        positionDisplay: "3",
        stablefordPoints: 38,
        thru: "18",
        flight: "Flight A",
      }),
      "stableford",
      "stableford",
    );
    expect(findLeaderboardRow().getAttribute("aria-label")).toBe(
      "Position 3, Vikram Iyer, Flight A, 38 stableford points, through hole 18",
    );
  });

  it("par/bogey row", () => {
    renderRow(
      makeEntry({
        playerName: "Kabir Joshi",
        position: 2,
        positionDisplay: "2",
        parBogeyScore: 4,
        thru: "18",
        flight: "Flight A",
      }),
      "gross",
      "par_bogey",
    );
    expect(findLeaderboardRow().getAttribute("aria-label")).toBe(
      "Position 2, Kabir Joshi, Flight A, par/bogey score +4, through hole 18",
    );
  });

  it("no-score row", () => {
    renderRow(
      makeEntry({
        playerName: "Maya Reddy",
        position: 0,
        positionDisplay: "–",
        grossScore: null,
        scoreToPar: null,
        thru: "0",
        flight: "Flight C",
      }),
      "gross",
      "stroke_play",
    );
    expect(findLeaderboardRow().getAttribute("aria-label")).toBe(
      "Position –, Maya Reddy, Flight C, no score, through hole 0",
    );
  });

  it("uses accessibilityRole='button' so SR engines append ', button'", () => {
    renderRow(
      makeEntry({
        playerName: "Aarav Patel",
        positionDisplay: "1",
        grossScore: 72,
        scoreToPar: 2,
        flight: "Flight A",
      }),
      "gross",
      "stroke_play",
    );
    // react-native-web maps accessibilityRole="button" → role="button"
    expect(findLeaderboardRow().getAttribute("role")).toBe("button");
  });
});

// ── 3. Sign-in error box — alert role + assertive live region ──────────

describe("Mobile sign-in error box (Task #1440)", () => {
  it("announces the error with role='alert' + aria-live='assertive' on the leaf <Text>", async () => {
    render(<LoginScreen />);
    // Submit without filling credentials → handleLogin sets the error
    // synchronously and the error <Text> mounts.
    fireEvent.click(screen.getByTestId("login-submit-button"));
    const errorNode = await waitFor(() =>
      screen.getByText("Please enter your email and password"),
    );
    // The role + live-region attributes must live on the leaf <Text>, not
    // on the parent <View>, so the resend link below stays focusable on
    // the unverified-credentials path. react-native-web maps
    // accessibilityRole="alert" → role="alert" and
    // accessibilityLiveRegion="assertive" → aria-live="assertive".
    expect(errorNode.getAttribute("role")).toBe("alert");
    expect(errorNode.getAttribute("aria-live")).toBe("assertive");
  });
});
