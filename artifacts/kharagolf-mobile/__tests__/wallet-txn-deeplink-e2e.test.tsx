/**
 * Task #1492 — Mobile e2e coverage for the wallet "Txn #N" deep-link
 * flow inside `app/wallet.tsx`.
 *
 * Mirrors the web e2e plan at
 * `artifacts/kharagolf-web/src/tests/wallet-txn-ref-deeplink.e2e.md`
 * (Task #1266) which covers the same `focusTxn` + `extraTxnIds` +
 * scroll-to-row behaviour on the desktop `WalletPanel`. The mobile
 * screen reuses the exact same shape — `useState<number[]>` for
 * `extraTxnIds`, the `?includeTxnIds=` query param wired through
 * `useQuery`, and a FlatList ref calling `scrollToIndex()` once the
 * matching txn lands — but had no end-to-end coverage. A future refactor
 * of either the wallet API or the FlatList ref plumbing could silently
 * break the jump-to-ledger-row behaviour on phones with no test failing.
 *
 * The transport mirrors the established mobile e2e tier (vitest +
 * react-native-web, see `moreBadges-polling-gated-e2e.test.tsx` and
 * `committee-case-opened-summary-e2e.test.tsx`), so this file is picked
 * up by `pnpm --filter @workspace/kharagolf-mobile test` in CI without
 * any extra wiring. Playwright is not configured for the mobile
 * artifact; this is the same harness the rest of the mobile e2e tier
 * uses.
 *
 * Scenario seeded via stubbed fetch (matches the web plan's DB seed):
 *   - 1 wallet for the active member with INR balance.
 *   - 60 fresh credit txns (the recent-50 window covers them).
 *   - 1 OLD debit txn whose `created_at` is older than every credit, so
 *     the unfiltered `/wallet` response (DESC, LIMIT 50) does NOT include
 *     it. Only the `?includeTxnIds=<oldDebitId>` refetch surfaces it.
 *   - 1 withdrawal whose `debitTxnId` points at that OLD debit, which is
 *     what causes WithdrawalRowView to render the "Txn #<oldDebitId>"
 *     deep-link Pressable.
 *
 * Asserted user-facing behaviour:
 *   1. BASELINE — the OLD debit row is NOT rendered, but the
 *      "Txn #<oldDebitId>" deep-link button IS visible inside the
 *      withdrawal row.
 *   2. After tapping the deep-link button, the wallet endpoint is
 *      re-hit with `?includeTxnIds=<oldDebitId>`.
 *   3. Once the refetch resolves, the matching ledger row is rendered
 *      AND highlighted (the `WalletTxnRow` receives `highlighted=true`)
 *      AND `FlatList.scrollToIndex` is called with the txn's index in
 *      the loaded list (60 — the OLD debit lands at the end of the
 *      DESC-ordered ledger, after the 60 fresh credits).
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
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Hoisted spies ──────────────────────────────────────────────────────────

const { scrollToIndexMock } = vi.hoisted(() => ({
  scrollToIndexMock: vi.fn<
    (opts: { index: number; animated?: boolean; viewPosition?: number }) => void
  >(),
}));

// ── Module mocks (must come BEFORE the screen import) ──────────────────────

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
  };
});

vi.mock("react-native-safe-area-context", () => {
  const ReactInner = require("react") as typeof React;
  return {
    SafeAreaView: ({ children }: { children?: ReactNode }) =>
      ReactInner.createElement(ReactInner.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: {
      id: 42,
      email: "wallet-jumper@example.com",
      organizationId: 7,
    },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({
    activeOrgId: 7,
    activeClub: { id: 7, name: "Test GC" },
  }),
}));

// `react-native-razorpay` ships native code that the jsdom transport
// can't load, but `wallet.tsx` already pulls it in defensively via
// `require()`/try-catch. Stub it so the require resolves cleanly and the
// module load doesn't print "Cannot find module" warnings during the
// test run.
vi.mock("react-native-razorpay", () => ({ default: { open: vi.fn() } }));

// PriceWithFx renders an internal /currency-tax/quote fetch that we
// don't care about for this flow. Replace it with a tiny stub that just
// shows the booked amount + currency, so the test's fetch matcher only
// has wallet/payout/withdrawals URLs to match.
vi.mock("@/components/PriceWithFx", () => {
  const ReactInner = require("react") as typeof React;
  return {
    PriceWithFx: ({ amount, currency }: { amount: number; currency: string }) =>
      ReactInner.createElement(
        "span",
        { "data-testid": "price-with-fx" },
        `${currency} ${Number(amount).toFixed(2)}`,
      ),
    fmtMoney: (amount: number, currency: string) =>
      `${currency} ${Number(amount).toFixed(2)}`,
  };
});

// Replace FlatList with a forwardRef stub that exposes a `scrollToIndex`
// spy (we assert on it) AND eagerly renders every item via `renderItem`
// so the deep-linked row is queryable without a real virtualization
// pipeline. View / Animated.View pass through unchanged — this screen
// doesn't rely on onLayout.
vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>(
    "react-native",
  );
  const ReactLib = await import("react");

  type FakeFlatListProps<T> = {
    data?: ReadonlyArray<T> | null;
    renderItem?: (info: { item: T; index: number }) => React.ReactNode;
    keyExtractor?: (item: T, index: number) => string;
  };

  const FakeFlatList = ReactLib.forwardRef<
    { scrollToIndex: typeof scrollToIndexMock },
    FakeFlatListProps<unknown>
  >((props, ref) => {
    ReactLib.useImperativeHandle(
      ref,
      () => ({ scrollToIndex: scrollToIndexMock }),
      [],
    );
    const items = props.data ?? [];
    return ReactLib.createElement(
      "div",
      { "data-testid": "wallet-txn-flatlist" },
      items.map((item, index) => {
        const key = props.keyExtractor
          ? props.keyExtractor(item, index)
          : String(index);
        return ReactLib.createElement(
          ReactLib.Fragment,
          { key },
          props.renderItem ? props.renderItem({ item, index }) : null,
        );
      }),
    );
  });
  FakeFlatList.displayName = "FakeFlatList";

  return {
    ...RN,
    FlatList: FakeFlatList,
    Alert: { alert: vi.fn() },
  };
});

// ── Screen under test (after mocks) ────────────────────────────────────────
import WalletScreen from "../app/wallet";

// ── Fixture data (mirrors the web plan's DB seed) ──────────────────────────

const ORG_ID = 7;
const USER_ID = 42;
const WALLET_ID = 9001;
const OLD_DEBIT_TXN_ID = 555_001;
const WITHDRAWAL_ID = 333_001;
const FRESH_TXN_COUNT = 60;
const TAG = "WJM_E2E";

interface WalletTxn {
  id: number;
  kind: "credit" | "debit";
  amount: number;
  currency: string;
  sourceType: string | null;
  sourceId: string | null;
  paymentRef: string | null;
  note: string | null;
  balanceAfter: number;
  createdAt: string;
}

const NOW = Date.parse("2026-04-29T12:00:00.000Z");

function makeFreshCredits(): WalletTxn[] {
  // 60 fresh credit txns, all NEWER than the OLD debit, spaced 1s apart so
  // the order is deterministic. Mirrors the SQL `generate_series(1, 60)`
  // seed in the web e2e plan.
  return Array.from({ length: FRESH_TXN_COUNT }, (_, i) => ({
    id: 100_000 + i,
    kind: "credit" as const,
    amount: 0.01,
    currency: "INR",
    sourceType: "e2e_pad",
    sourceId: null,
    paymentRef: null,
    note: null,
    balanceAfter: 0,
    // i=0 is the most recent; i=59 the oldest fresh credit. Wallet
    // endpoint returns DESC, so credits come out in id-DESC order.
    createdAt: new Date(NOW - i * 1000).toISOString(),
  })).sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

const FRESH_CREDITS: WalletTxn[] = makeFreshCredits();

const OLD_DEBIT: WalletTxn = {
  id: OLD_DEBIT_TXN_ID,
  kind: "debit",
  amount: 100.0,
  currency: "INR",
  sourceType: "wallet_withdrawal_debit",
  sourceId: String(WITHDRAWAL_ID),
  paymentRef: null,
  note: `Withdrawal debit (e2e-${TAG})`,
  balanceAfter: 0,
  // Backdated 7 days so it falls outside the recent-50 window.
  createdAt: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
};

const WITHDRAWAL = {
  id: WITHDRAWAL_ID,
  amount: 100.0,
  currency: "INR",
  method: "upi",
  status: "processing",
  payoutMode: null,
  razorpayPayoutId: null,
  failureReason: null,
  utr: null,
  debitTxnId: OLD_DEBIT_TXN_ID,
  refundTxnId: null,
  requestedAt: new Date(NOW).toISOString(),
  notify: null,
};

const WALLET_BALANCE = 0.6;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchMock = Mock<
  (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
>;
let fetchMock: FetchMock;
let walletFetchUrls: string[];

beforeEach(() => {
  scrollToIndexMock.mockReset();
  walletFetchUrls = [];

  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    // /api/wallet?organizationId=7&currency=INR[&includeTxnIds=…]
    // Recent-50 window by default; the optional includeTxnIds adds the
    // requested wallet-owned txn ids to the response. Mirrors the
    // `?includeTxnIds=` path on the real api-server route added in
    // Task #1104.
    if (
      url.includes("/api/wallet?") ||
      url.endsWith("/api/wallet")
    ) {
      walletFetchUrls.push(url);
      const includeMatch = url.match(/includeTxnIds=([^&]*)/);
      const includes = includeMatch
        ? decodeURIComponent(includeMatch[1])
            .split(",")
            .map((s) => Number(s))
            .filter((n) => Number.isFinite(n))
        : [];
      // Mirror the real api-server route: ORDER BY created_at DESC LIMIT
      // 50, then append any wallet-owned `includeTxnIds` rows the
      // recent-50 window missed. With 60 fresh credits seeded, the OLD
      // debit only ever surfaces via the includeTxnIds path — exactly
      // the production semantics the deep-link relies on.
      const transactions = FRESH_CREDITS.slice(0, 50);
      if (includes.includes(OLD_DEBIT_TXN_ID)) {
        transactions.push(OLD_DEBIT);
      }
      return jsonResponse({
        wallet: {
          id: WALLET_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
          currency: "INR",
          balance: WALLET_BALANCE,
        },
        transactions,
      });
    }

    if (url.includes("/api/wallet/payout-account")) {
      return jsonResponse({
        account: {
          id: 1,
          method: "upi",
          accountHolderName: "Wallet Jumper",
          upiVpa: "walletjumper@upi",
          bankAccountNumberLast4: null,
          bankIfsc: null,
          verified: true,
          verifiedAt: new Date(NOW).toISOString(),
          verifiedHolderName: "Wallet Jumper",
          verificationStatus: "verified",
          verificationFailureReason: null,
        },
        limits: {
          minPerTxn: 1,
          maxPerTxn: 100000,
          maxPerDay: 100000,
          currency: "INR",
        },
      });
    }

    if (url.includes("/api/wallet/withdrawals")) {
      return jsonResponse({ withdrawals: [WITHDRAWAL] });
    }

    // Anything else is an unexpected request — fail loudly so a future
    // change that adds a new wallet-related fetch is forced to add it
    // here on purpose, instead of silently masking the new traffic.
    throw new Error(`Unexpected fetch in wallet deep-link e2e: ${url}`);
  }) as unknown as FetchMock;

  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderScreen() {
  // Disable retries so a transient test failure doesn't cascade into
  // background fetches that pollute the call counts we measure.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WalletScreen />
    </QueryClientProvider>,
  );
}

describe("WalletScreen — Txn-ref deep-link from withdrawal row (Task #1492)", () => {
  it(
    "tapping `Txn #<oldDebitId>` refetches with includeTxnIds, scrolls to the matching FlatList row, and highlights it",
    async () => {
      await act(async () => {
        renderScreen();
      });

      // ── Step 1: BASELINE ──────────────────────────────────────────────
      // Wait for the initial wallet load + withdrawals load. The
      // deep-link Pressable is rendered with the visible text
      // "Txn #<oldDebitId>" once the withdrawals query resolves.
      const deepLink = await screen.findByText(
        `Txn #${OLD_DEBIT_TXN_ID}`,
        {},
        { timeout: 3000 },
      );
      expect(deepLink).toBeInTheDocument();

      // The OLD debit row is NOT in the loaded recent-50 window yet —
      // WalletTxnRow tags each rendered txn with
      // `wallet-txn-row-<id>`. The fresh credits ARE rendered.
      expect(
        screen.queryByTestId(`wallet-txn-row-${OLD_DEBIT_TXN_ID}`),
      ).toBeNull();
      expect(
        screen.getByTestId(`wallet-txn-row-${FRESH_CREDITS[0].id}`),
      ).toBeInTheDocument();

      // Initial wallet GET fired exactly once and did NOT include
      // includeTxnIds — that's how we know the click in step 2 is what
      // triggers the expansion.
      expect(walletFetchUrls.length).toBe(1);
      expect(walletFetchUrls[0]).not.toMatch(/includeTxnIds=/);

      // ── Step 2: tap the deep-link Pressable ───────────────────────────
      // react-native-web renders <Pressable> as a clickable host element
      // that bubbles fireEvent.click into the onPress handler.
      await act(async () => {
        fireEvent.click(deepLink);
      });

      // ── Step 3: refetch with includeTxnIds is issued ──────────────────
      // setExtraTxnIds([oldDebitId]) keys the wallet query, which
      // triggers a fresh queryFn run that appends &includeTxnIds=…
      await waitFor(
        () => {
          const withInclude = walletFetchUrls.find((u) =>
            u.includes(`includeTxnIds=${OLD_DEBIT_TXN_ID}`),
          );
          expect(withInclude).toBeDefined();
        },
        { timeout: 3000 },
      );

      // ── Step 4: the matching row mounts, gets highlighted, and the
      //           FlatList is asked to scroll to it ──────────────────────
      // Once the refetched data lands, both the visibleCount expansion
      // (via the `highlightTxnId` index in the slice) and the
      // `useEffect` scroll path fire. The fake FlatList renders all
      // items, so `wallet-txn-row-<oldDebitId>` becomes queryable.
      const oldRow = await screen.findByTestId(
        `wallet-txn-row-${OLD_DEBIT_TXN_ID}`,
        {},
        { timeout: 3000 },
      );
      expect(oldRow).toBeInTheDocument();

      // The row text contains the leading "#<id>" badge AND the seeded
      // note copy — proving we're looking at the right txn, not a
      // coincidental render of one of the fresh credits.
      expect(oldRow.textContent ?? "").toContain(`#${OLD_DEBIT_TXN_ID}`);
      expect(oldRow.textContent ?? "").toContain(
        `Withdrawal debit (e2e-${TAG})`,
      );

      // The highlighted background is a yellow tint applied by
      // WalletTxnRow when `highlighted={true}`. Inline RN styles end up
      // on the host element's `style`, so the rendered hex shows up
      // when (and only when) the row is the focused one.
      await waitFor(
        () => {
          const styleAttr = (oldRow.getAttribute("style") ?? "").toLowerCase();
          // RN-web normalises "#FFF3CD" to lowercase rgb(...). Accept
          // either spelling.
          expect(
            styleAttr.includes("rgb(255, 243, 205)") ||
              styleAttr.includes("#fff3cd"),
          ).toBe(true);
        },
        { timeout: 1500 },
      );

      // FlatList.scrollToIndex must be called with the deep-linked
      // txn's index in the loaded list. The recent-50 window returns 50
      // fresh credits and the includeTxnIds expansion appends the OLD
      // debit, so it lands at index 50 — after the 50 newer credits.
      await waitFor(
        () => {
          expect(scrollToIndexMock).toHaveBeenCalled();
        },
        { timeout: 1500 },
      );
      const lastCall =
        scrollToIndexMock.mock.calls[scrollToIndexMock.mock.calls.length - 1];
      expect(lastCall[0]).toEqual(
        expect.objectContaining({
          index: 50,
          animated: true,
          viewPosition: expect.any(Number),
        }),
      );

      // None of the fresh credit rows received the highlight — only the
      // deep-linked OLD debit did. This guards against a regression
      // where `highlighted` is wired off the wrong piece of state and
      // ends up applied to every row.
      const freshRow = screen.getByTestId(
        `wallet-txn-row-${FRESH_CREDITS[0].id}`,
      );
      const freshStyle = (freshRow.getAttribute("style") ?? "").toLowerCase();
      expect(freshStyle.includes("rgb(255, 243, 205)")).toBe(false);
      expect(freshStyle.includes("#fff3cd")).toBe(false);
    },
  );
});
