import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { PriceWithFx } from "@/components/PriceWithFx";
import { NotifyBadgesRow, type NotifyBadgeInfo } from "@/components/NotifyBadgesRow";
import { RefundDeliveryStatusRow, type RefundDeliveryInfo } from "@/components/RefundDeliveryStatusRow";

export interface WalletTxnRowData {
  id: number;
  kind: "credit" | "debit" | string;
  amount: number;
  currency: string;
  sourceType: string | null;
  paymentRef: string | null;
  note: string | null;
  balanceAfter: number;
  createdAt: string;
  // Task #1841 — for `wallet_topup_refund` txns the API folds in the
  // matching `wallet_topup_refund_notify_attempts` row so this row can
  // render the same email/push retry-countdown badges that the wallet
  // withdrawal pipeline already shows on a sibling surface.
  notify?: NotifyBadgeInfo | null;
  // Task #1862 — four-channel (email/push/sms/whatsapp) delivery
  // status row, also folded in by the API for `wallet_topup_refund`
  // txns. Distinct from `notify` because the badges above hide
  // skipped/no-address channels and only cover email + push, while
  // refund alerts also fan out to SMS / WhatsApp and members ask
  // support whether the text ever went out.
  delivery?: RefundDeliveryInfo | null;
}

/**
 * A single row in the wallet's recent-transactions list. Extracted from
 * `app/wallet.tsx` (Task #1110) so the FX-aware amount can be regression-tested
 * in isolation — previously the row rendered booked-currency-only text via a
 * hardcoded `INR` prefix, with no "Approx." converted line for members on a
 * different preferred display currency.
 */
export function WalletTxnRow({
  txn,
  orgId,
  token,
  highlighted = false,
  retryNowMs,
}: {
  txn: WalletTxnRowData;
  orgId?: number | null;
  token?: string | null;
  highlighted?: boolean;
  // Task #1841 — current wall-clock (refreshed by `WalletScreen` every 5s
  // while at least one row has a live notify timer) so the "next try in
  // 2m 14s" / "gave up X ago" suffix on refund-email/push badges stays
  // accurate without each row spinning up its own timer.
  retryNowMs?: number;
}) {
  const isCredit = txn.kind === "credit";
  const sign = isCredit ? "+" : "−";
  const color = isCredit ? "#0a7d33" : "#c0392b";
  const date = new Date(txn.createdAt);
  const dateStr = date.toLocaleDateString();
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const label = txn.note
    ?? (txn.sourceType === "wallet_topup_razorpay"
      ? "Wallet top-up"
      : txn.sourceType ?? (isCredit ? "Credit" : "Debit"));
  const balanceFormatted = Number(txn.balanceAfter).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const amountFormatted = Number(txn.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const a11yLabel = `${isCredit ? "Credit" : "Debit"}, ${label}, ${isCredit ? "plus" : "minus"} ${amountFormatted} ${txn.currency}, on ${dateStr} at ${timeStr}, balance ${balanceFormatted} ${txn.currency}`;
  return (
    <View
      testID={`wallet-txn-row-${txn.id}`}
      accessible
      accessibilityLabel={a11yLabel}
      style={[styles.txnRow, highlighted && { backgroundColor: "#FFF3CD", borderRadius: 8 }]}
    >
      <View style={[styles.txnIcon, { backgroundColor: isCredit ? "#e6f4ec" : "#fbeaea" }]}>
        <Feather name={isCredit ? "arrow-down-left" : "arrow-up-right"} size={16} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.txnLabel} numberOfLines={1}>
          <Text style={styles.txnMeta}>#{txn.id} </Text>{label}
        </Text>
        <Text style={styles.txnMeta}>
          {dateStr} · {timeStr}
          {txn.paymentRef ? ` · ${txn.paymentRef.slice(0, 14)}…` : ""}
        </Text>
        {/* Task #1841 — for top-up refund txns the API folds in the
            notify-attempt row; render the same email/push retry-countdown
            badges that wallet withdrawals already show. retryNowMs may
            be omitted on surfaces that don't yet plumb the parent ticker
            (e.g. unit tests / non-wallet callers) — formatRetryRelative
            tolerates an undefined `now` by falling back to Date.now(). */}
        {txn.sourceType === "wallet_topup_refund" && txn.notify ? (
          <NotifyBadgesRow
            notify={txn.notify}
            retryNowMs={retryNowMs ?? Date.now()}
            rowTestID={`row-topup-refund-notify-${txn.id}`}
            badgeTestIDPrefix={`badge-topup-refund-${txn.id}`}
          />
        ) : null}
        {/* Task #1862 — full four-channel delivery row so members can
            see whether the SMS/WhatsApp text ever went out (the
            email/push badges above intentionally hide skipped /
            no-address channels). */}
        {txn.sourceType === "wallet_topup_refund" && txn.delivery ? (
          <RefundDeliveryStatusRow
            delivery={txn.delivery}
            rowTestID={`row-topup-refund-delivery-${txn.id}`}
            channelTestIDPrefix={`delivery-topup-refund-${txn.id}`}
          />
        ) : null}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={[styles.txnAmount, { color, marginRight: 4 }]}>{sign}</Text>
          <PriceWithFx
            orgId={orgId ?? null}
            token={token ?? null}
            amount={txn.amount}
            currency={txn.currency}
            productClass="wallet"
            showDisclosure={false}
            disclosureOnHover
            bookedStyle={[styles.txnAmount, { color }]}
          />
        </View>
        <Text style={styles.txnMeta}>
          Bal {Number(txn.balanceAfter).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  txnRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 12, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  txnIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  txnLabel: { fontSize: 14, color: Colors.text, fontFamily: "Inter_600SemiBold" },
  txnMeta: { fontSize: 11, color: Colors.muted, fontFamily: "Inter_400Regular", marginTop: 2 },
  txnAmount: { fontSize: 14, fontFamily: "Inter_700Bold" },
});

export default WalletTxnRow;
