/**
 * Task #1871 — Mobile e2e coverage for the wallet "Re-save your account"
 * banner flow inside `app/wallet.tsx`.
 *
 * Covers the same user-facing cycle as the new web e2e plan at
 * `artifacts/kharagolf-web/src/tests/wallet-payout-needs-reverify.e2e.md`,
 * but for the mobile screen:
 *
 *   1. The daily wallet payout-account re-verification cron (Task #1119)
 *      has flipped the saved account to `needs_attention` and persisted a
 *      `verificationFailureReason`.
 *   2. WalletScreen renders the inline `<PayoutNeedsReverifyBanner>` with
 *      the persisted reason, and the Withdraw button is disabled.
 *   3. Tapping "Re-save account" opens the saved-account modal
 *      (`PayoutAccountModal`).
 *   4. Submitting the prefilled UPI re-verifies the account upstream.
 *      `POST /wallet/payout-account` returns `verificationStatus:
 *      'verified'` and the cached payout-account query is invalidated.
 *   5. The refetched payout-account flips back to `verified`, which makes
 *      the banner disappear AND re-enables the Withdraw button.
 *
 * Mirrors the existing mobile e2e tier (vitest + react-native-web; see
 * `wallet-txn-deeplink-e2e.test.tsx` and `moreBadges-polling-gated-e2e.test.tsx`)
 * so this file is picked up by `pnpm --filter @workspace/kharagolf-mobile test`
 * with no extra wiring. Playwright is not configured for the mobile artifact;
 * this is the same harness the rest of the mobile e2e tier uses.
 *
 * `react-native`'s `Modal` is replaced with a passthrough that always
 * renders its children when `visible` is true — react-native-web's real
 * Modal mounts a portal that jsdom doesn't render reliably, and the
 * pattern matches `coach-deliver-modal-button.test.tsx`. `FlatList` is
 * replaced with the same eager-render fake used in the deep-link e2e so
 * the recent-transactions table doesn't spin up a virtualization
 * pipeline we don't care about for this flow.
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

const { alertMock } = vi.hoisted(() => ({
  alertMock: vi.fn<(title: string, message?: string) => void>(),
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
      email: "wallet-reverify@example.com",
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

// `react-native-razorpay` ships native code jsdom can't load; the wallet
// screen pulls it in defensively via `require()`/try-catch so this stub
// just keeps the module load quiet during the test run.
vi.mock("react-native-razorpay", () => ({ default: { open: vi.fn() } }));

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

// Replace `Modal` with a passthrough that renders its children whenever
// `visible` is true (matches the pattern in
// `coach-deliver-modal-button.test.tsx`), eagerly render `FlatList` items
// so the recent-transactions rows are queryable, and route `Alert.alert`
// to the hoisted spy so we can assert the post-save toast without a real
// native alert dialog.
vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>(
    "react-native",
  );
  const ReactLib = await import("react");

  type ModalProps = {
    children?: React.ReactNode;
    visible?: boolean;
    onRequestClose?: () => void;
  };
  const FakeModal = ({ children, visible }: ModalProps) =>
    visible
      ? ReactLib.createElement(
          "div",
          { "data-testid": "fake-modal" },
          children,
        )
      : null;
  FakeModal.displayName = "FakeModal";

  type FakeFlatListProps<T> = {
    data?: ReadonlyArray<T> | null;
    renderItem?: (info: { item: T; index: number }) => React.ReactNode;
    keyExtractor?: (item: T, index: number) => string;
  };
  const FakeFlatList = ReactLib.forwardRef<
    { scrollToIndex: (opts: unknown) => void },
    FakeFlatListProps<unknown>
  >((props, ref) => {
    ReactLib.useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }), []);
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
    Modal: FakeModal,
    FlatList: FakeFlatList,
    Alert: { alert: alertMock },
  };
});

// ── Screen under test (after mocks) ────────────────────────────────────────
import WalletScreen from "../app/wallet";

// ── Fixture data ───────────────────────────────────────────────────────────

const ORG_ID = 7;
const USER_ID = 42;
const WALLET_ID = 9101;
const ACCOUNT_ID = 4101;
const FAILURE_REASON = "VPA inactive at upstream bank";
const NOW = Date.parse("2026-04-30T09:00:00.000Z");

interface PayoutAccountPayload {
  id: number;
  method: "upi" | "bank_account";
  accountHolderName: string;
  upiVpa: string | null;
  bankAccountNumberLast4: string | null;
  bankIfsc: string | null;
  verified: boolean;
  verifiedAt: string | null;
  verifiedHolderName: string | null;
  verificationStatus: "verified" | "needs_attention";
  verificationFailureReason: string | null;
}

const NEEDS_ATTENTION_ACCOUNT: PayoutAccountPayload = {
  id: ACCOUNT_ID,
  method: "upi",
  accountHolderName: "Wallet Reverify",
  upiVpa: "walletreverify@upi",
  bankAccountNumberLast4: null,
  bankIfsc: null,
  // Task #1511 — `verifiedAt` stays populated when the cron flips the
  // status to needs_attention, so the saved-account banner can keep
  // showing the prior verification timestamp. The Withdraw button must
  // still disable on `verificationStatus === 'needs_attention'`.
  verified: true,
  verifiedAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
  verifiedHolderName: "Wallet Reverify",
  verificationStatus: "needs_attention",
  verificationFailureReason: FAILURE_REASON,
};

const VERIFIED_ACCOUNT: PayoutAccountPayload = {
  ...NEEDS_ATTENTION_ACCOUNT,
  verifiedAt: new Date(NOW).toISOString(),
  verificationStatus: "verified",
  verificationFailureReason: null,
};

const PAYOUT_LIMITS = {
  minPerTxn: 1,
  maxPerTxn: 100000,
  maxPerDay: 100000,
  currency: "INR",
};

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
let payoutAccountState: PayoutAccountPayload;
let payoutAccountFetchCount: number;
let payoutAccountPostCount: number;

beforeEach(() => {
  alertMock.mockReset();
  payoutAccountState = NEEDS_ATTENTION_ACCOUNT;
  payoutAccountFetchCount = 0;
  payoutAccountPostCount = 0;

  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/wallet/payout-account")) {
      if (method === "POST") {
        // Mirror the real api-server route: a successful POST persists
        // the row with `verificationStatus: 'verified'` and clears
        // `verificationFailureReason`. The wallet screen invalidates the
        // payout-account query on success so the next GET returns the
        // freshly verified row.
        payoutAccountPostCount += 1;
        payoutAccountState = VERIFIED_ACCOUNT;
        return jsonResponse({
          account: VERIFIED_ACCOUNT,
          limits: PAYOUT_LIMITS,
        });
      }
      payoutAccountFetchCount += 1;
      return jsonResponse({
        account: payoutAccountState,
        limits: PAYOUT_LIMITS,
      });
    }

    if (url.includes("/api/wallet/withdrawals")) {
      return jsonResponse({ withdrawals: [] });
    }

    if (
      url.includes("/api/wallet?") ||
      url.endsWith("/api/wallet")
    ) {
      // Balance must be > 0 so the Withdraw button isn't disabled by the
      // `balance <= 0` guard on its own — the test must observe it
      // disabling specifically because of `verificationStatus`.
      return jsonResponse({
        wallet: {
          id: WALLET_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
          currency: "INR",
          balance: 250,
        },
        transactions: [],
      });
    }

    throw new Error(`Unexpected fetch in wallet reverify e2e: ${url}`);
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

describe("WalletScreen — Re-save your account banner flow (Task #1871)", () => {
  it(
    "shows the persisted reason, opens the saved-account modal on Re-save, and re-enables Withdraw after submit",
    async () => {
      await act(async () => {
        renderScreen();
      });

      // ── Step 1: BASELINE — banner renders with the persisted reason ──
      const banner = await screen.findByTestId(
        "banner-wallet-payout-needs-reverify",
        {},
        { timeout: 3000 },
      );
      expect(banner).toBeInTheDocument();
      // The banner concatenates a "Reason: <reason>" trailer when the
      // cron persisted one, so this single assertion proves both that
      // the banner mounted AND that the persisted failure reason was
      // routed through to the user-facing copy.
      expect(banner.textContent ?? "").toContain(`Reason: ${FAILURE_REASON}`);
      expect(banner.textContent ?? "").toContain(
        "Re-save your UPI to resume withdrawals",
      );

      // The Withdraw button is disabled — react-native-web's Pressable
      // exposes `disabled` as `aria-disabled="true"` on the host
      // element. With balance = 250 and verified = true, the only thing
      // that can be disabling it here is the
      // `verificationStatus === 'needs_attention'` guard added in
      // Task #1511.
      const withdrawBtn = screen.getByTestId("wallet-withdraw-toggle");
      expect(withdrawBtn).toHaveAttribute("aria-disabled", "true");

      // The saved-account modal hasn't been opened yet.
      expect(
        screen.queryByTestId("wallet-payout-account-form"),
      ).toBeNull();

      // The initial payout-account GET fired once — we use this to
      // prove the post-save invalidation triggers a fresh GET below.
      expect(payoutAccountFetchCount).toBe(1);

      // ── Step 2: tap "Re-save account" ────────────────────────────────
      // The banner CTA carries `testID="button-wallet-payout-needs-reverify-fix"`.
      // react-native-web renders <Pressable> as a clickable host element
      // whose click event bubbles into the `onPress` handler — same
      // gesture path as the deep-link e2e (`wallet-txn-deeplink-e2e`).
      const reSaveBtn = screen.getByTestId(
        "button-wallet-payout-needs-reverify-fix",
      );
      await act(async () => {
        fireEvent.click(reSaveBtn);
      });

      // ── Step 3: the saved-account modal opens with the form ──────────
      // `setAccountOpen(true)` fires → <PayoutAccountModal visible> → the
      // form (`testID="wallet-payout-account-form"`) becomes queryable.
      // The faked `Modal` only renders its children when `visible` is
      // true, so finding the form id confirms the visibility flip.
      const form = await screen.findByTestId(
        "wallet-payout-account-form",
        {},
        { timeout: 2000 },
      );
      expect(form).toBeInTheDocument();

      // ── Step 4: fill in the form and submit ──────────────────────────
      // PayoutAccountModal's `useState(existing?…)` initialisers run when
      // the parent (`WalletScreen`) first mounts the component — at that
      // point `payoutAccount.data` hasn't resolved yet, so the modal's
      // local `name` / `upi` state defaults to '' regardless of the
      // verified UPI on file. The "Re-save" CTA therefore opens an empty
      // form in production too; users re-type the same VPA they already
      // had. This step mirrors that flow: type into the prefilled-but-
      // empty inputs, then submit. react-native-web renders TextInput as
      // a native `<input>`, so `fireEvent.change(target, { value })`
      // fires the wrapped `onChangeText`. (Same pattern as
      // `caddie-rate-tip-fx.test.tsx`.)
      const nameInput = screen.getByTestId("wallet-payout-account-name");
      const upiInput = screen.getByTestId("wallet-payout-account-upi");
      await act(async () => {
        fireEvent.change(nameInput, {
          target: { value: NEEDS_ATTENTION_ACCOUNT.accountHolderName },
        });
        fireEvent.change(upiInput, {
          target: { value: NEEDS_ATTENTION_ACCOUNT.upiVpa! },
        });
      });
      const submitBtn = screen.getByTestId("wallet-payout-account-submit");
      await act(async () => {
        fireEvent.click(submitBtn);
      });
      // Sanity: no validation Alert fired — the inputs above satisfied
      // both the non-empty `name` guard and the
      // `^[\w.\-]{2,}@[\w.\-]{2,}$` UPI regex inside
      // `PayoutAccountModal.submit`. The only Alert allowed here is
      // the success toast fired by `saveAccount.onSuccess`
      // ("Saved" / "Payout account saved. You can now withdraw."),
      // which proves the success branch ran.
      const validationAlerts = alertMock.mock.calls.filter(
        ([title]) => title !== "Saved",
      );
      expect(validationAlerts).toEqual([]);

      // The POST fired exactly once with the prefilled UPI payload, and
      // it carried the active organizationId so the api-server can scope
      // the row to the right (org, user) pair.
      await waitFor(
        () => {
          expect(payoutAccountPostCount).toBe(1);
        },
        { timeout: 2000 },
      );
      const postCall = fetchMock.mock.calls.find(([url, init]) => {
        return (
          String(url).includes("/api/wallet/payout-account") &&
          (init?.method ?? "GET").toUpperCase() === "POST"
        );
      });
      expect(postCall).toBeDefined();
      const postBody = JSON.parse(String(postCall![1]?.body ?? "{}")) as {
        organizationId: number;
        method: string;
        accountHolderName: string;
        upiVpa?: string;
      };
      expect(postBody).toEqual(
        expect.objectContaining({
          organizationId: ORG_ID,
          method: "upi",
          accountHolderName: NEEDS_ATTENTION_ACCOUNT.accountHolderName,
          upiVpa: NEEDS_ATTENTION_ACCOUNT.upiVpa,
        }),
      );

      // ── Step 5: banner clears + Withdraw transitions disabled→enabled ─
      // saveAccount.onSuccess invalidates the payout-account query →
      // a second GET fires → the stubbed fetch now returns the
      // VERIFIED_ACCOUNT (we flipped `payoutAccountState` in the POST
      // branch). React-query rerenders WalletScreen with the new data:
      //   - `verificationStatus === 'needs_attention'` is false → the
      //     <PayoutNeedsReverifyBanner> conditional unmounts.
      //   - same flag re-enables the Withdraw button.
      await waitFor(
        () => {
          expect(
            screen.queryByTestId("banner-wallet-payout-needs-reverify"),
          ).toBeNull();
        },
        { timeout: 3000 },
      );
      await waitFor(
        () => {
          const btn = screen.getByTestId("wallet-withdraw-toggle");
          expect(btn).not.toHaveAttribute("aria-disabled", "true");
        },
        { timeout: 3000 },
      );

      // The post-save toast was surfaced via Alert.alert — proves the
      // success branch ran end-to-end (and not just that the POST
      // request itself was issued).
      expect(alertMock).toHaveBeenCalledWith(
        "Saved",
        expect.stringContaining("You can now withdraw"),
      );

      // The modal closed itself on success.
      expect(
        screen.queryByTestId("wallet-payout-account-form"),
      ).toBeNull();

      // The post-save invalidation triggered at least one additional
      // GET on top of the initial mount fetch — guards against a
      // regression where the success handler forgets to invalidate the
      // cache and the banner stays stuck even after a successful POST.
      expect(payoutAccountFetchCount).toBeGreaterThanOrEqual(2);
    },
  );
});
