/**
 * WalletScreen — shows the member's club wallet balance + recent ledger
 * transactions, lets them top up via Razorpay (Task #613), and lets them
 * withdraw their balance back to UPI / bank via RazorpayX payouts
 * (Task #770).
 *
 * Endpoints used (mounted at /api on the API server):
 *   GET  /wallet?organizationId=&currency=
 *   POST /wallet/topup-order      { organizationId, amount, currency }
 *   POST /wallet/topup-verify     { razorpayOrderId, razorpayPaymentId, razorpaySignature }
 *   GET  /wallet/payout-account?organizationId=
 *   POST /wallet/payout-account   { organizationId, method, ...account fields }
 *   POST /wallet/withdraw         { organizationId, amount, currency }
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack, router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { holderNamesDifferSignificantly } from "@workspace/verified-holder-name";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import { BASE_URL } from "@/utils/api";
import { PriceWithFx } from "@/components/PriceWithFx";
import { WalletTxnRow, type WalletTxnRowData } from "@/components/WalletTxnRow";
import { PayoutNeedsReverifyBanner } from "@/components/PayoutNeedsReverifyBanner";
import { formatRetryRelative } from "../lib/formatRetryRelative";

const GOLD = "#C9A84C";

// Razorpay native module isn't available in Expo Go. Load defensively so the
// rest of the screen still renders; the top-up button surfaces a clear error.
type RzpOpts = Record<string, unknown>;
type RzpResult = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
let RazorpayCheckout: { open: (opts: RzpOpts) => Promise<RzpResult> } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RazorpayCheckout = require("react-native-razorpay").default;
} catch {
  RazorpayCheckout = null;
}

interface WalletTxn {
  id: number;
  kind: "credit" | "debit" | string;
  amount: number;
  currency: string;
  sourceType: string | null;
  sourceId: string | null;
  paymentRef: string | null;
  note: string | null;
  balanceAfter: number;
  createdAt: string;
  // Task #1841 — only populated by the API for `wallet_topup_refund` txns.
  // Mirrors the email + push half of the withdrawal notify shape so the
  // shared `NotifyBadgesRow` component can render the retry-countdown
  // badges that wallet withdrawals already get. Refund attempts have no
  // `outcome` discriminator (the API serializer intentionally omits it),
  // so this row uses a tighter type than `WithdrawalNotifyInfo`.
  notify?: {
    email: WithdrawalNotifyChannel;
    push: WithdrawalNotifyChannel;
  } | null;
  // Task #1862 — full four-channel (email/push/sms/whatsapp) delivery
  // status row for `wallet_topup_refund` txns so members can see
  // whether the SMS/WhatsApp text ever went out without contacting
  // support. Member-facing endpoint omits `lastError` (admin-only).
  delivery?: {
    email: RefundDeliveryChannelLite;
    push: RefundDeliveryChannelLite;
    sms: RefundDeliveryChannelLite;
    whatsapp: RefundDeliveryChannelLite;
  } | null;
}

interface RefundDeliveryChannelLite {
  status: 'sent' | 'failed' | 'retrying' | 'exhausted' | 'skipped' | null;
  attempts: number;
  lastAt: string | null;
  nextRetryAt: string | null;
  exhaustedAt: string | null;
}

interface WalletResponse {
  wallet: { id: number; organizationId: number; userId: number; currency: string; balance: number };
  transactions: WalletTxn[];
}

type NotifyDeliveryStatus = 'sent' | 'retrying' | 'failed_permanent';

interface WithdrawalNotifyChannel {
  status: NotifyDeliveryStatus | null;
  attempts: number;
  lastAt: string | null;
  // Task #1499 — when the cron will next try this channel (NULL once
  // retries are exhausted). Powers the "next try in 2m 14s" suffix on
  // the retrying badge.
  nextRetryAt: string | null;
  exhaustedAt: string | null;
}

interface WithdrawalNotifyInfo {
  outcome: 'processed' | 'failed' | 'reversed';
  email: WithdrawalNotifyChannel;
  push: WithdrawalNotifyChannel;
}

interface WithdrawalRow {
  id: number;
  amount: number;
  currency: string;
  method: string;
  status: string;
  payoutMode: string | null;
  razorpayPayoutId: string | null;
  failureReason: string | null;
  utr: string | null;
  debitTxnId: number | null;
  refundTxnId: number | null;
  requestedAt: string;
  // Task #1278 — per-channel delivery status from
  // wallet_withdrawal_notify_attempts. `null` until a terminal
  // outcome has been notified.
  notify?: WithdrawalNotifyInfo | null;
}

// Task #1499 / #1841 — the "in 2m 14s" / "5m ago" formatter that powers
// every notify-retry badge suffix on mobile (wallet withdrawal,
// side-game settlement receipt, wallet top-up refund) lives in a shared
// module (`../lib/formatRetryRelative`) so the surfaces can never
// silently diverge. Re-exported for any caller that already imports it
// from this file.
export { formatRetryRelative } from "../lib/formatRetryRelative";

/**
 * Tiny presentational sub-component for the "Verified as: <name>" line under
 * the wallet payout summary on mobile (Task #1120). Extracted from
 * WalletScreen so the matching/mismatch logic — and the amber warning copy —
 * can be locked in by unit tests independently of the larger wallet screen
 * (Task #1293). Mirrors the web `VerifiedHolderLine` component in
 * artifacts/kharagolf-web/src/components/SideGamesAdmin.tsx.
 *
 * The token + comparison helpers it relies on (`holderNamesDifferSignificantly`)
 * live in the shared `@workspace/verified-holder-name` package so the web and
 * mobile copies can never silently disagree (Task #1521).
 *
 * Renders nothing when `verifiedHolderName` is null/empty, mirroring the
 * inline `payoutAccount.data?.account?.verifiedHolderName ? (…) : null`
 * guard in WalletScreen.
 */
export function VerifiedHolderLine({
  accountHolderName,
  verifiedHolderName,
}: {
  accountHolderName: string;
  verifiedHolderName: string | null | undefined;
}) {
  if (!verifiedHolderName) return null;
  const mismatch = holderNamesDifferSignificantly(accountHolderName, verifiedHolderName);
  return (
    <View style={styles.verifiedHolderRow}>
      <Feather
        name={mismatch ? 'alert-triangle' : 'check-circle'}
        size={12}
        color={mismatch ? '#f6b73c' : Colors.textSecondary}
      />
      <Text style={[styles.verifiedHolderText, mismatch && styles.verifiedHolderWarn]}>
        {mismatch
          ? `Verified as: ${verifiedHolderName} — doesn't match “${accountHolderName}”. Re-save if this isn't your account.`
          : `Verified as: ${verifiedHolderName}`}
      </Text>
    </View>
  );
}

function withdrawalStatusBadge(s: string): { label: string; color: string } {
  switch (s) {
    case 'pending': return { label: 'Pending', color: '#9CA3AF' };
    case 'processing': return { label: 'Processing', color: '#F59E0B' };
    case 'processed': return { label: 'Paid', color: '#10B981' };
    case 'failed': return { label: 'Failed (refunded)', color: '#F87171' };
    case 'reversed': return { label: 'Reversed (refunded)', color: '#F87171' };
    case 'cancelled': return { label: 'Cancelled', color: '#9CA3AF' };
    case 'dispatch_unknown': return { label: 'Reconciling', color: '#F59E0B' };
    case 'paid_after_refund': return { label: 'Paid (review)', color: '#FB7185' };
    default: return { label: s, color: '#9CA3AF' };
  }
}

/**
 * Task #1511 — wallet API errors carry a structured `code` (and, for the
 * payout re-verification case, the persisted `verificationFailureReason`).
 * Surface them on the thrown error so the withdraw mutation can route the
 * `PAYOUT_ACCOUNT_NEEDS_REVERIFY` response into the friendly inline banner
 * instead of the generic "Withdrawal failed" alert.
 */
export class WalletApiError extends Error {
  readonly code: string | null;
  readonly verificationFailureReason: string | null;
  constructor(message: string, code: string | null, verificationFailureReason: string | null) {
    super(message);
    this.name = 'WalletApiError';
    this.code = code;
    this.verificationFailureReason = verificationFailureReason;
  }
}

async function apiFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as {
      error?: string;
      code?: string;
      verificationFailureReason?: string | null;
    };
    throw new WalletApiError(
      body.error ?? `API error ${res.status}`,
      body.code ?? null,
      body.verificationFailureReason ?? null,
    );
  }
  return res.json() as Promise<T>;
}

const QUICK_AMOUNTS = [500, 1000, 2000, 5000];

export default function WalletScreen() {
  const { token, user } = useAuth();
  const { activeOrgId, activeClub } = useActiveClub();
  const orgId = activeOrgId ?? user?.organizationId ?? null;
  const currency = "INR";
  const qc = useQueryClient();
  const [topupOpen, setTopupOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [highlightTxnId, setHighlightTxnId] = useState<number | null>(null);
  const [extraTxnIds, setExtraTxnIds] = useState<number[]>([]);
  const txnListRef = useRef<FlatList<WalletTxn> | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
  }, []);

  const queryKey = useMemo(
    () => ["wallet", orgId, currency, extraTxnIds.join(",")],
    [orgId, currency, extraTxnIds],
  );
  const { data, isLoading, refetch, isRefetching } = useQuery<WalletResponse>({
    queryKey,
    enabled: !!token && !!orgId,
    queryFn: () => {
      const qs = new URLSearchParams({ organizationId: String(orgId), currency });
      if (extraTxnIds.length > 0) qs.set('includeTxnIds', extraTxnIds.join(','));
      return apiFetch<WalletResponse>(`/wallet?${qs.toString()}`, token!);
    },
  });

  const payoutAccount = useQuery<PayoutAccountResponse>({
    queryKey: ["wallet-payout-account", orgId],
    enabled: !!orgId && !!token,
    queryFn: () => apiFetch<PayoutAccountResponse>(
      `/wallet/payout-account?organizationId=${orgId}`,
      token!,
    ),
  });

  const withdrawalsQuery = useQuery<{ withdrawals: WithdrawalRow[] }>({
    queryKey: ["wallet-withdrawals", orgId],
    enabled: !!orgId && !!token,
    queryFn: () => apiFetch<{ withdrawals: WithdrawalRow[] }>(
      `/wallet/withdrawals?organizationId=${orgId}`,
      token!,
    ),
  });

  // Task #1499 — re-render every 5s while at least one withdrawal in
  // the visible list has a retry / exhausted timestamp, so the
  // "next try in 2m 14s" / "gave up 5m ago" suffix on the notify
  // badges stays fresh between react-query refetches.
  const visibleWithdrawals = withdrawalsQuery.data?.withdrawals?.slice(0, 6) ?? [];
  // Task #1841 — also tick for visible top-up refund txns whose notify
  // attempt has a live retry/exhausted timestamp, so the new badges on
  // those rows stay accurate without each row spinning up its own timer.
  const refundTxnsForTicker = (data?.transactions ?? []).filter(
    t => t.sourceType === 'wallet_topup_refund' && t.notify != null,
  );
  const hasLiveRetryTimer =
    visibleWithdrawals.some(w =>
      w.notify != null && (
        w.notify.email.nextRetryAt != null || w.notify.push.nextRetryAt != null ||
        w.notify.email.exhaustedAt != null || w.notify.push.exhaustedAt != null
      ),
    ) ||
    refundTxnsForTicker.some(t =>
      t.notify != null && (
        t.notify.email.nextRetryAt != null || t.notify.push.nextRetryAt != null ||
        t.notify.email.exhaustedAt != null || t.notify.push.exhaustedAt != null
      ),
    );
  const [retryNowMs, setRetryNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!hasLiveRetryTimer) return;
    setRetryNowMs(Date.now());
    const id = setInterval(() => setRetryNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, [hasLiveRetryTimer]);

  const saveAccount = useMutation({
    mutationFn: async (input: SavePayoutAccountInput) => {
      if (!orgId || !token) throw new Error('No active club.');
      return apiFetch<PayoutAccountResponse>(`/wallet/payout-account`, token, {
        method: 'POST',
        body: JSON.stringify({ organizationId: orgId, ...input }),
      });
    },
    onSuccess: () => {
      setAccountOpen(false);
      qc.invalidateQueries({ queryKey: ["wallet-payout-account", orgId] });
      Alert.alert('Saved', 'Payout account saved. You can now withdraw.');
    },
    onError: (err: Error) => Alert.alert('Could not save account', err.message ?? 'Unknown error'),
  });

  const withdraw = useMutation({
    mutationFn: async (amount: number) => {
      if (!orgId || !token) throw new Error('No active club.');
      return apiFetch<{ ok: boolean; balance: number; withdrawal: { status: string } }>(
        `/wallet/withdraw`, token, {
          method: 'POST',
          body: JSON.stringify({ organizationId: orgId, amount, currency }),
        },
      );
    },
    onSuccess: (res) => {
      setWithdrawOpen(false);
      qc.invalidateQueries({ queryKey });
      Alert.alert('Withdrawal initiated', `Status: ${res.withdrawal.status}. New balance: ${currency} ${Number(res.balance).toFixed(2)}`);
    },
    onError: (err: Error) => {
      // Task #1511 — when the daily re-verification cron has flagged
      // the saved account, the API returns 400 with code
      // PAYOUT_ACCOUNT_NEEDS_REVERIFY and the persisted failure reason.
      // Refresh the payout-account query so the inline `needs_attention`
      // banner (with the failure reason and Re-save CTA) renders, close
      // the withdraw sheet, and skip the generic "Withdrawal failed"
      // alert — the banner is the friendlier surface.
      if (err instanceof WalletApiError && err.code === 'PAYOUT_ACCOUNT_NEEDS_REVERIFY') {
        setWithdrawOpen(false);
        qc.invalidateQueries({ queryKey: ["wallet-payout-account", orgId] });
        return;
      }
      Alert.alert('Withdrawal failed', err.message ?? 'Could not initiate withdrawal');
    },
  });

  const topup = useMutation({
    mutationFn: async (amount: number) => {
      if (!RazorpayCheckout) {
        throw new Error('Install the dev build to enable Razorpay (Expo Go does not support it).');
      }
      if (!orgId || !token) throw new Error('No active club.');
      const order = await apiFetch<{ orderId: string; amount: number; currency: string; keyId: string }>(
        `/wallet/topup-order`, token, {
          method: 'POST',
          body: JSON.stringify({ organizationId: orgId, amount, currency }),
        },
      );
      const checkout = await RazorpayCheckout.open({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: 'KHARAGOLF',
        description: `Top up ${activeClub?.name ?? 'club'} wallet`,
        order_id: order.orderId,
        prefill: user?.email ? { email: user.email } : {},
        theme: { color: '#0a7d33' },
      });
      const verified = await apiFetch<{ ok: boolean; balance: number }>(
        `/wallet/topup-verify`, token, {
          method: 'POST',
          body: JSON.stringify({
            razorpayOrderId: checkout.razorpay_order_id,
            razorpayPaymentId: checkout.razorpay_payment_id,
            razorpaySignature: checkout.razorpay_signature,
          }),
        },
      );
      return verified;
    },
    onSuccess: (res) => {
      setTopupOpen(false);
      qc.invalidateQueries({ queryKey });
      Alert.alert('Wallet topped up', `New balance: ${currency} ${Number(res.balance).toFixed(2)}`);
    },
    onError: (err: Error) => {
      // Razorpay throws on user cancellation — that's not really an error.
      if (err.message?.toLowerCase().includes('cancel')) return;
      Alert.alert('Top-up failed', err.message ?? 'Could not complete payment');
    },
  });

  if (!token) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <Stack.Screen options={{ title: 'Wallet' }} />
        <View style={styles.center}><Text style={styles.muted}>Please sign in to view your wallet.</Text></View>
      </SafeAreaView>
    );
  }
  if (!orgId) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <Stack.Screen options={{ title: 'Wallet' }} />
        <View style={styles.center}><Text style={styles.muted}>Select an active club to view your wallet.</Text></View>
      </SafeAreaView>
    );
  }

  const balance = data?.wallet.balance ?? 0;
  const txns = data?.transactions ?? [];

  const focusTxn = useCallback((txnId: number) => {
    const idx = txns.findIndex(t => t.id === txnId);
    setHighlightTxnId(txnId);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightTxnId(prev => (prev === txnId ? null : prev)), 2400);
    // Always pin the deep-linked txn so subsequent refetches keep it in
    // the list — even if newer txns would otherwise push it out of the
    // recent-50 window. Mirrors the web fix for Task #1491.
    setExtraTxnIds(prev => (prev.includes(txnId) ? prev : [...prev, txnId]));
    if (idx < 0) {
      // Older than the loaded window — the includeTxnIds refetch above
      // will surface it; the second useEffect then scrolls to it once
      // it lands in `txns` (Task #1104).
      return;
    }
    requestAnimationFrame(() => {
      txnListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
    });
  }, [txns]);

  // Once an on-demand fetched txn lands in the list, scroll to it.
  useEffect(() => {
    if (highlightTxnId == null) return;
    const idx = txns.findIndex(t => t.id === highlightTxnId);
    if (idx < 0) return;
    requestAnimationFrame(() => {
      txnListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
    });
  }, [txns, highlightTxnId]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Stack.Screen options={{ title: 'Club Wallet', headerBackTitle: 'Back' }} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Feather name="chevron-left" size={22} color={Colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerLabel}>CLUB WALLET</Text>
          <Text style={styles.headerName} numberOfLines={1}>
            {activeClub?.name ?? 'KHARAGOLF'}
          </Text>
        </View>
      </View>

      <View style={styles.balanceCard} testID="wallet-balance-card">
        <Text style={styles.balanceLabel}>Available balance</Text>
        {isLoading ? (
          <LoadingSpinner color={GOLD} style={{ marginTop: 12 }} />
        ) : (
          <View testID="wallet-balance">
            <PriceWithFx
              orgId={orgId}
              token={token}
              amount={balance}
              currency={data?.wallet.currency ?? currency}
              productClass="wallet"
              bookedStyle={styles.balanceValue}
            />
          </View>
        )}
        <View style={styles.balanceActions}>
          <Pressable
            style={[styles.addBtn, topup.isPending && styles.addBtnBusy]}
            onPress={() => setTopupOpen(true)}
            disabled={topup.isPending}
            testID="wallet-topup-toggle"
          >
            <Feather name="plus" size={16} color="#fff" />
            <Text style={styles.addBtnText}>{topup.isPending ? 'Processing…' : 'Add money'}</Text>
          </Pressable>
          <Pressable
            style={[
              styles.withdrawBtn,
              (withdraw.isPending
                || !payoutAccount.data?.account?.verified
                // Task #1511 — also dim the button when the daily
                // re-verification cron has flagged the saved account.
                || payoutAccount.data?.account?.verificationStatus === 'needs_attention'
              ) && styles.addBtnBusy,
            ]}
            onPress={() => setWithdrawOpen(true)}
            disabled={
              withdraw.isPending
              || balance <= 0
              || !payoutAccount.data?.account?.verified
              // Task #1511 — `verifiedAt` (and therefore `verified`) is
              // preserved when the cron flips the account to
              // needs_attention, so guard the Withdraw button on the
              // status field too. Without this, members could still
              // press Withdraw and only see the API's error.
              || payoutAccount.data?.account?.verificationStatus === 'needs_attention'
            }
            testID="wallet-withdraw-toggle"
          >
            <Feather name="arrow-up-right" size={16} color={GOLD} />
            <Text style={styles.withdrawBtnText}>
              {withdraw.isPending ? 'Withdrawing…' : 'Withdraw'}
            </Text>
          </Pressable>
        </View>
        <Pressable onPress={() => setAccountOpen(true)} style={styles.payoutAccountLink}>
          <Feather name="credit-card" size={12} color={Colors.textSecondary} />
          <Text style={styles.payoutAccountLinkText}>
            {payoutAccount.data?.account
              ? payoutAccount.data.account.method === 'upi'
                ? `UPI · ${payoutAccount.data.account.upiVpa}`
                : `Bank · •••• ${payoutAccount.data.account.bankAccountNumberLast4}`
              : 'Add UPI / bank to withdraw'}
          </Text>
        </Pressable>
        {payoutAccount.data?.account ? (
          <VerifiedHolderLine
            accountHolderName={payoutAccount.data.account.accountHolderName}
            verifiedHolderName={payoutAccount.data.account.verifiedHolderName}
          />
        ) : null}
        {payoutAccount.data?.account?.verificationStatus === 'needs_attention' ? (
          // Task #1511 — surface the persisted re-verification failure
          // reason from the daily cron (Task #1119) so members see the
          // same friendly banner here that's already shown on coach
          // payouts. Without this banner the wallet UI would only show
          // a generic alert when Withdraw is pressed, and members had
          // no way to learn *why* payouts were paused. The Re-save CTA
          // jumps straight into the saved-account modal.
          <PayoutNeedsReverifyBanner
            method={payoutAccount.data.account.method}
            reason={payoutAccount.data.account.verificationFailureReason ?? null}
            onPress={() => setAccountOpen(true)}
          />
        ) : null}
      </View>

      {(withdrawalsQuery.data?.withdrawals?.length ?? 0) > 0 && (
        <>
          <Text style={styles.sectionTitle} testID="wallet-withdrawals-heading">WITHDRAWALS</Text>
          <View style={{ paddingHorizontal: 16 }} testID="wallet-withdrawals-table">
            {visibleWithdrawals.map(w => (
              <WithdrawalRowView key={w.id} w={w} onFocusTxn={focusTxn} orgId={orgId} token={token} retryNowMs={retryNowMs} />
            ))}
          </View>
        </>
      )}

      <Text style={styles.sectionTitle} testID="wallet-recent-transactions-heading">RECENT TRANSACTIONS</Text>
      {isLoading ? (
        <LoadingSpinner style={{ marginTop: 24 }} />
      ) : txns.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.muted}>No transactions yet. Add money or settle a side game to get started.</Text>
        </View>
      ) : (
        <FlatList
          ref={txnListRef}
          data={txns}
          keyExtractor={t => String(t.id)}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 80 }}
          refreshing={isRefetching}
          testID="wallet-recent-transactions-table"
          onRefresh={() => { refetch(); withdrawalsQuery.refetch(); }}
          onScrollToIndexFailed={(info) => {
            setTimeout(() => {
              txnListRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.3 });
            }, 200);
          }}
          renderItem={({ item }) => (
            <WalletTxnRow
              txn={item}
              orgId={orgId}
              token={token}
              highlighted={highlightTxnId === item.id}
              retryNowMs={retryNowMs}
            />
          )}
        />
      )}

      <TopupModal
        visible={topupOpen}
        currency={currency}
        busy={topup.isPending}
        onClose={() => topupOpen && !topup.isPending && setTopupOpen(false)}
        onSubmit={(amt) => topup.mutate(amt)}
      />
      <WithdrawModal
        visible={withdrawOpen}
        currency={currency}
        balance={balance}
        busy={withdraw.isPending}
        account={payoutAccount.data?.account ?? null}
        limits={payoutAccount.data?.limits ?? null}
        onClose={() => !withdraw.isPending && setWithdrawOpen(false)}
        onAddAccount={() => { setWithdrawOpen(false); setAccountOpen(true); }}
        onSubmit={(amt) => withdraw.mutate(amt)}
      />
      <PayoutAccountModal
        visible={accountOpen}
        busy={saveAccount.isPending}
        existing={payoutAccount.data?.account ?? null}
        onClose={() => !saveAccount.isPending && setAccountOpen(false)}
        onSubmit={(input) => saveAccount.mutate(input)}
      />
    </SafeAreaView>
  );
}

type PayoutAccount = {
  id: number;
  method: 'upi' | 'bank_account';
  accountHolderName: string;
  upiVpa: string | null;
  bankAccountNumberLast4: string | null;
  bankIfsc: string | null;
  verified: boolean;
  verifiedAt?: string | null;
  verifiedHolderName?: string | null;
  verificationStatus?: string | null;
  verificationFailureReason?: string | null;
};
type PayoutLimits = { minPerTxn: number; maxPerTxn: number; maxPerDay: number; currency: string };
type PayoutAccountResponse = { account: PayoutAccount | null; limits: PayoutLimits };
type SavePayoutAccountInput =
  | { method: 'upi'; accountHolderName: string; upiVpa: string }
  | { method: 'bank_account'; accountHolderName: string; bankAccountNumber: string; bankIfsc: string };

function WithdrawalRowView({ w, onFocusTxn, orgId, token, retryNowMs }: {
  w: WithdrawalRow;
  onFocusTxn: (txnId: number) => void;
  orgId?: number | null;
  token?: string | null;
  // Task #1499 — current wall-clock (refreshed by parent every 5s) so
  // the "next try in 2m 14s" / "gave up 5m ago" suffix on the notify
  // badges stays accurate without each row spinning up its own timer.
  retryNowMs: number;
}) {
  const badge = withdrawalStatusBadge(w.status);
  const date = new Date(w.requestedAt);
  return (
    <View style={styles.txnRow} testID={`wallet-withdrawal-row-${w.id}`}>
      <View style={[styles.txnIcon, { backgroundColor: '#fff5e1' }]}>
        <Feather name="arrow-up-right" size={16} color={GOLD} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.txnLabel} numberOfLines={1}>
          Withdrawal · {w.method === 'upi' ? 'UPI' : 'Bank'}
          {w.utr ? ` · UTR ${w.utr}` : ''}
        </Text>
        <Text style={styles.txnMeta}>
          {date.toLocaleDateString()} · <Text style={{ color: badge.color, fontFamily: 'Inter_600SemiBold' }}>{badge.label}</Text>
        </Text>
        {(w.debitTxnId || w.refundTxnId) ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
            {w.debitTxnId ? (
              <Pressable
                onPress={() => onFocusTxn(w.debitTxnId!)}
                hitSlop={6}
                testID={`wallet-withdrawal-txn-link-${w.debitTxnId}`}
              >
                <Text style={[styles.txnMeta, { color: GOLD, textDecorationLine: 'underline' }]}>Txn #{w.debitTxnId}</Text>
              </Pressable>
            ) : null}
            {w.refundTxnId ? (
              <Pressable
                onPress={() => onFocusTxn(w.refundTxnId!)}
                hitSlop={6}
                testID={`wallet-withdrawal-refund-link-${w.refundTxnId}`}
              >
                <Text style={[styles.txnMeta, { color: '#0a7d33', textDecorationLine: 'underline' }]}>Refund #{w.refundTxnId}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {w.failureReason && (w.status === 'failed' || w.status === 'reversed' || w.status === 'paid_after_refund') ? (
          <Text style={[styles.txnMeta, { color: '#c0392b' }]} numberOfLines={2}>{w.failureReason}</Text>
        ) : null}
        {w.notify ? (() => {
          const badges: React.ReactNode[] = [];
          const renderBadge = (channel: 'email' | 'push', ch: WithdrawalNotifyChannel) => {
            const s = ch.status;
            if (!s) return null;
            const channelLabel = channel === 'email' ? 'Email' : 'Push';
            const baseText = s === 'sent'
              ? `${channelLabel} sent`
              : s === 'retrying'
                ? `${channelLabel} retrying`
                : `${channelLabel} undelivered`;
            // Task #1499 — append the live countdown ("next try in 2m 14s")
            // for retrying badges and the "gave up 5m ago" wall-clock for
            // permanently-failed badges so members can decide whether to
            // wait or check the bank app.
            const nextTry = s === 'retrying' ? formatRetryRelative(ch.nextRetryAt, retryNowMs) : null;
            const exhausted = s === 'failed_permanent' ? formatRetryRelative(ch.exhaustedAt, retryNowMs) : null;
            const suffix = s === 'retrying' && nextTry
              ? ` — next try ${nextTry}`
              : s === 'failed_permanent' && exhausted
                ? ` — gave up ${exhausted}`
                : s !== 'sent' && ch.attempts > 0
                  ? ` (${ch.attempts})`
                  : '';
            const palette = s === 'sent'
              ? { bg: '#e7f7ee', fg: '#0a7d33', bd: '#bde7c8' }
              : s === 'retrying'
                ? { bg: '#fff5e1', fg: '#a06a00', bd: '#f3d99a' }
                : { bg: '#fdecea', fg: '#a02923', bd: '#f5c2bf' };
            return (
              <View
                key={channel}
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 6,
                  backgroundColor: palette.bg,
                  borderWidth: 1,
                  borderColor: palette.bd,
                }}
                testID={`badge-withdrawal-${channel}-${w.id}`}
              >
                <Text style={{ fontSize: 10, color: palette.fg, fontFamily: 'Inter_600SemiBold' }}>
                  {baseText}{suffix}
                </Text>
              </View>
            );
          };
          const emailBadge = renderBadge('email', w.notify.email);
          if (emailBadge) badges.push(emailBadge);
          const pushBadge = renderBadge('push', w.notify.push);
          if (pushBadge) badges.push(pushBadge);
          return badges.length > 0 ? (
            <View
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}
              testID={`row-withdrawal-notify-${w.id}`}
            >{badges}</View>
          ) : null;
        })() : null}
      </View>
      <View style={{ alignItems: 'flex-end', flexDirection: 'row' }}>
        <Text style={[styles.txnAmount, { color: '#c0392b', marginRight: 4 }]}>−</Text>
        <PriceWithFx
          orgId={orgId ?? null}
          token={token ?? null}
          amount={w.amount}
          currency={w.currency}
          productClass="wallet"
          showDisclosure={false}
          disclosureOnHover
          bookedStyle={[styles.txnAmount, { color: '#c0392b' }]}
        />
      </View>
    </View>
  );
}

// Exported for __tests__/screen-reader-transcripts.test.tsx (Task #2173) so
// the modal's accessibility props can be pinned without driving the parent
// WalletScreen through a "Add money" tap. The modal is otherwise a private
// implementation detail of WalletScreen.
export function TopupModal({ visible, currency, busy, onClose, onSubmit }: {
  visible: boolean;
  currency: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (amount: number) => void;
}) {
  const [custom, setCustom] = useState('');

  const submit = (amt: number) => {
    if (!Number.isFinite(amt) || amt <= 0) {
      Alert.alert('Enter a valid amount');
      return;
    }
    onSubmit(amt);
  };

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} accessibilityLabel="Close" accessibilityHint="Closes the add money sheet">
        <Pressable
          style={styles.modalCard}
          onPress={(e) => e.stopPropagation()}
          accessibilityViewIsModal
          importantForAccessibility="yes"
        >
          <Text style={styles.modalTitle} accessibilityRole="header">Add money to wallet</Text>
          <Text style={styles.modalSubtitle}>Pre-fund your wallet so settling side games is one tap.</Text>

          <View style={styles.quickRow} testID="wallet-topup-form">
            {QUICK_AMOUNTS.map(amt => (
              <Pressable
                key={amt}
                style={[styles.quickBtn, busy && styles.quickBtnBusy]}
                onPress={() => submit(amt)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Top up ${currency} ${amt}`}
                testID={`wallet-topup-quick-amount-${amt}`}
              >
                <Text style={styles.quickBtnText}>{currency} {amt}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.modalLabel}>Custom amount</Text>
          <View style={styles.customRow}>
            <Text style={styles.customCcy}>{currency}</Text>
            <TextInput
              style={styles.customInput}
              value={custom}
              onChangeText={setCustom}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor={Colors.muted}
              editable={!busy}
              accessibilityLabel={`Custom top-up amount in ${currency}`}
              testID="wallet-topup-amount-input"
            />
            <Pressable
              style={[styles.payBtn, busy && styles.payBtnBusy]}
              onPress={() => submit(Number(custom))}
              disabled={busy}
              testID="wallet-topup-submit"
            >
              <Text style={styles.payBtnText}>{busy ? '…' : 'Pay'}</Text>
            </Pressable>
          </View>

          <Pressable style={styles.modalCancel} onPress={onClose} disabled={busy}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Exported for __tests__/screen-reader-transcripts.test.tsx (Task #2173) so
// the modal's accessibility props can be pinned without driving the parent
// WalletScreen through a "Withdraw" tap. The modal is otherwise a private
// implementation detail of WalletScreen.
export function WithdrawModal({ visible, currency, balance, busy, account, limits, onClose, onAddAccount, onSubmit }: {
  visible: boolean;
  currency: string;
  balance: number;
  busy: boolean;
  account: PayoutAccount | null;
  limits: PayoutLimits | null;
  onClose: () => void;
  onAddAccount: () => void;
  onSubmit: (amount: number) => void;
}) {
  const [amount, setAmount] = useState('');
  const submit = () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) { Alert.alert('Enter a valid amount'); return; }
    if (n > balance) { Alert.alert('Insufficient balance'); return; }
    if (limits && n < limits.minPerTxn) { Alert.alert(`Minimum withdrawal is ${currency} ${limits.minPerTxn}`); return; }
    if (limits && n > limits.maxPerTxn) { Alert.alert(`Maximum per withdrawal is ${currency} ${limits.maxPerTxn}`); return; }
    onSubmit(n);
  };
  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} accessibilityLabel="Close" accessibilityHint="Closes the withdraw sheet">
        <Pressable
          style={styles.modalCard}
          onPress={(e) => e.stopPropagation()}
          accessibilityViewIsModal
          importantForAccessibility="yes"
        >
          <Text style={styles.modalTitle} accessibilityRole="header">Withdraw to UPI / bank</Text>
          <Text style={styles.modalSubtitle}>
            Available: {currency} {balance.toFixed(2)}
            {limits ? ` · Limit ${currency} ${limits.maxPerTxn}/txn, ${currency} ${limits.maxPerDay}/day` : ''}
          </Text>

          {account ? (
            <View style={styles.accountSummary}>
              <Feather name={account.method === 'upi' ? 'at-sign' : 'credit-card'} size={14} color={Colors.text} />
              <Text style={styles.accountSummaryText}>
                {account.method === 'upi'
                  ? `UPI · ${account.upiVpa}`
                  : `Bank · ${account.accountHolderName} · •••• ${account.bankAccountNumberLast4} · ${account.bankIfsc}`}
              </Text>
              <Pressable onPress={onAddAccount}>
                <Text style={styles.accountChange}>Change</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable style={styles.addAccountBtn} onPress={onAddAccount}>
              <Feather name="plus-circle" size={14} color={GOLD} />
              <Text style={styles.addAccountBtnText}>Add UPI or bank account</Text>
            </Pressable>
          )}

          <Text style={styles.modalLabel}>Amount</Text>
          <View style={styles.customRow} testID="wallet-withdraw-form">
            <Text style={styles.customCcy}>{currency}</Text>
            <TextInput
              style={styles.customInput}
              value={amount}
              onChangeText={setAmount}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor={Colors.muted}
              editable={!busy && !!account?.verified}
              accessibilityLabel={`Withdrawal amount in ${currency}`}
              testID="wallet-withdraw-amount-input"
            />
            <Pressable
              style={[styles.maxBtn, (busy || !account?.verified) && styles.quickBtnBusy]}
              onPress={() => setAmount(String(balance))}
              disabled={busy || !account?.verified}
              accessibilityRole="button"
              accessibilityLabel={`Use full available balance ${currency} ${balance.toFixed(2)}`}
              testID="wallet-withdraw-max"
            >
              <Text style={styles.maxBtnText}>Max</Text>
            </Pressable>
            <Pressable
              style={[styles.payBtn, (busy || !account?.verified) && styles.payBtnBusy]}
              onPress={submit}
              disabled={busy || !account?.verified}
              testID="wallet-withdraw-submit"
            >
              <Text style={styles.payBtnText}>{busy ? '…' : 'Withdraw'}</Text>
            </Pressable>
          </View>

          <Pressable style={styles.modalCancel} onPress={onClose} disabled={busy}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PayoutAccountModal({ visible, busy, existing, onClose, onSubmit }: {
  visible: boolean;
  busy: boolean;
  existing: PayoutAccount | null;
  onClose: () => void;
  onSubmit: (input: SavePayoutAccountInput) => void;
}) {
  const [method, setMethod] = useState<'upi' | 'bank_account'>(existing?.method ?? 'upi');
  const [name, setName] = useState(existing?.accountHolderName ?? '');
  const [upi, setUpi] = useState(existing?.upiVpa ?? '');
  const [acct, setAcct] = useState('');
  const [ifsc, setIfsc] = useState(existing?.bankIfsc ?? '');

  const submit = () => {
    if (!name.trim()) { Alert.alert('Account holder name is required'); return; }
    if (method === 'upi') {
      if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upi.trim())) { Alert.alert('Enter a valid UPI ID (e.g. name@bank)'); return; }
      onSubmit({ method: 'upi', accountHolderName: name.trim(), upiVpa: upi.trim() });
    } else {
      if (!/^\d{6,20}$/.test(acct.replace(/\s+/g, ''))) { Alert.alert('Enter a valid account number'); return; }
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.trim().toUpperCase())) { Alert.alert('Enter a valid IFSC'); return; }
      onSubmit({ method: 'bank_account', accountHolderName: name.trim(), bankAccountNumber: acct.replace(/\s+/g, ''), bankIfsc: ifsc.trim().toUpperCase() });
    }
  };

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()} testID="wallet-payout-account-form">
          <Text style={styles.modalTitle}>Withdrawal account</Text>
          <Text style={styles.modalSubtitle}>Used for all wallet withdrawals on this club.</Text>

          <View style={styles.methodTabs}>
            <Pressable
              style={[styles.methodTab, method === 'upi' && styles.methodTabActive]}
              onPress={() => setMethod('upi')}
              disabled={busy}
              testID="wallet-payout-account-method-tab-upi"
            >
              <Text style={[styles.methodTabText, method === 'upi' && styles.methodTabTextActive]}>UPI</Text>
            </Pressable>
            <Pressable
              style={[styles.methodTab, method === 'bank_account' && styles.methodTabActive]}
              onPress={() => setMethod('bank_account')}
              disabled={busy}
              testID="wallet-payout-account-method-tab-bank_account"
            >
              <Text style={[styles.methodTabText, method === 'bank_account' && styles.methodTabTextActive]}>Bank</Text>
            </Pressable>
          </View>

          <Text style={styles.modalLabel}>Account holder name</Text>
          <TextInput
            style={styles.fieldInput} value={name} onChangeText={setName}
            placeholder="As on bank records" placeholderTextColor={Colors.muted} editable={!busy}
            testID="wallet-payout-account-name"
          />

          {method === 'upi' ? (
            <>
              <Text style={styles.modalLabel}>UPI ID</Text>
              <TextInput
                style={styles.fieldInput} value={upi} onChangeText={setUpi}
                autoCapitalize="none" autoCorrect={false}
                placeholder="name@bank" placeholderTextColor={Colors.muted} editable={!busy}
                testID="wallet-payout-account-upi"
              />
            </>
          ) : (
            <>
              <Text style={styles.modalLabel}>Account number</Text>
              <TextInput
                style={styles.fieldInput} value={acct} onChangeText={setAcct}
                keyboardType="numeric" placeholder="••••••" placeholderTextColor={Colors.muted} editable={!busy}
                testID="wallet-payout-account-bank-number"
              />
              <Text style={styles.modalLabel}>IFSC</Text>
              <TextInput
                style={styles.fieldInput} value={ifsc} onChangeText={setIfsc}
                autoCapitalize="characters" autoCorrect={false}
                placeholder="HDFC0001234" placeholderTextColor={Colors.muted} editable={!busy}
                testID="wallet-payout-account-bank-ifsc"
              />
            </>
          )}

          <Pressable
            style={[styles.payBtn, busy && styles.payBtnBusy, { marginTop: 16 }]}
            onPress={submit}
            disabled={busy}
            testID="wallet-payout-account-submit"
          >
            <Text style={styles.payBtnText}>{busy ? 'Saving…' : existing ? 'Update account' : 'Save account'}</Text>
          </Pressable>
          <Pressable style={styles.modalCancel} onPress={onClose} disabled={busy}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  backBtn: { padding: 4 },
  headerLabel: { fontSize: 10, color: Colors.muted, letterSpacing: 1.8, fontFamily: 'Inter_500Medium' },
  headerName: { fontSize: 16, color: Colors.text, fontFamily: 'Inter_700Bold', marginTop: 1 },

  balanceCard: {
    margin: 16, padding: 20, borderRadius: 16,
    backgroundColor: Colors.card, borderWidth: 1, borderColor: GOLD + '40',
  },
  balanceLabel: { fontSize: 11, color: Colors.muted, letterSpacing: 1.6, fontFamily: 'Inter_600SemiBold' },
  balanceValue: { fontSize: 32, color: Colors.text, fontFamily: 'Inter_700Bold', marginTop: 6 },
  addBtn: {
    marginTop: 16, alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#0a7d33', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10,
  },
  addBtnBusy: { backgroundColor: '#7aa88a' },
  addBtnText: { color: '#fff', fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  balanceActions: { flexDirection: 'row', gap: 10, marginTop: 16, flexWrap: 'wrap' },
  withdrawBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: GOLD,
  },
  withdrawBtnText: { color: GOLD, fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  payoutAccountLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  payoutAccountLinkText: { fontSize: 11, color: Colors.textSecondary, fontFamily: 'Inter_500Medium' },
  verifiedHolderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 4 },
  verifiedHolderText: { flex: 1, fontSize: 11, color: Colors.textSecondary, fontFamily: 'Inter_500Medium' },
  verifiedHolderWarn: { color: '#f6b73c' },
  accountSummary: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  accountSummaryText: { flex: 1, fontSize: 12, color: Colors.text, fontFamily: 'Inter_500Medium' },
  accountChange: { fontSize: 12, color: GOLD, fontFamily: 'Inter_600SemiBold' },
  addAccountBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
    borderWidth: 1, borderColor: GOLD, borderStyle: 'dashed',
  },
  addAccountBtnText: { color: GOLD, fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  methodTabs: {
    flexDirection: 'row', marginTop: 14, borderRadius: 8,
    backgroundColor: Colors.surface, padding: 3, alignSelf: 'flex-start',
  },
  methodTab: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 6 },
  methodTabActive: { backgroundColor: Colors.card, borderWidth: 1, borderColor: GOLD },
  methodTabText: { fontSize: 12, color: Colors.muted, fontFamily: 'Inter_600SemiBold' },
  methodTabTextActive: { color: Colors.text },
  fieldInput: {
    marginTop: 6, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    color: Colors.text, fontFamily: 'Inter_500Medium', fontSize: 14,
  },

  sectionTitle: {
    fontSize: 11, color: Colors.textSecondary, letterSpacing: 1.8,
    fontFamily: 'Inter_600SemiBold', paddingHorizontal: 20, marginBottom: 8,
  },
  empty: { padding: 24 },
  muted: { color: Colors.muted, fontFamily: 'Inter_400Regular', textAlign: 'center' },

  txnRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  txnIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  txnLabel: { fontSize: 14, color: Colors.text, fontFamily: 'Inter_600SemiBold' },
  txnMeta: { fontSize: 11, color: Colors.muted, fontFamily: 'Inter_400Regular', marginTop: 2 },
  txnAmount: { fontSize: 14, fontFamily: 'Inter_700Bold' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 16 },
  modalCard: { backgroundColor: Colors.card, borderRadius: 14, padding: 18, width: '100%', maxWidth: 360 },
  modalTitle: { fontSize: 16, color: Colors.text, fontFamily: 'Inter_700Bold' },
  modalSubtitle: { fontSize: 12, color: Colors.muted, marginTop: 4, fontFamily: 'Inter_400Regular' },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  quickBtn: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  quickBtnBusy: { opacity: 0.5 },
  quickBtnText: { color: Colors.text, fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  modalLabel: { fontSize: 11, color: Colors.muted, letterSpacing: 1.4, fontFamily: 'Inter_600SemiBold', marginTop: 16 },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  customCcy: { fontSize: 14, color: Colors.muted, fontFamily: 'Inter_600SemiBold' },
  customInput: {
    flex: 1, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    color: Colors.text, fontFamily: 'Inter_600SemiBold', fontSize: 14,
  },
  payBtn: { backgroundColor: '#0a7d33', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  payBtnBusy: { backgroundColor: '#7aa88a' },
  payBtnText: { color: '#fff', fontFamily: 'Inter_600SemiBold' },
  maxBtn: {
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  maxBtnText: { color: Colors.text, fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  modalCancel: { marginTop: 14, paddingVertical: 10, alignItems: 'center' },
  modalCancelText: { color: Colors.muted, fontFamily: 'Inter_500Medium' },
});
