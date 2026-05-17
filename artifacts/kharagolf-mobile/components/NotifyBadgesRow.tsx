import React from "react";
import { View, Text } from "react-native";
import { formatRetryRelative } from "../lib/formatRetryRelative";

/**
 * Task #1841 — shared "email/push delivery" badge row used by the three
 * mobile surfaces that display notify-pipeline state with the live retry
 * countdown extracted in Task #1499:
 *   • wallet withdrawal rows (still rendered inline in `app/wallet.tsx`
 *     because the original Task #1278 implementation predates this
 *     component — keeping that copy in step is the responsibility of
 *     this file's prop shape),
 *   • side-game settlement receipts (`components/SideGamesPanel.tsx`),
 *   • wallet top-up refund txn rows (`components/WalletTxnRow.tsx`).
 *
 * The countdown formatting itself lives in `../lib/formatRetryRelative`
 * so all surfaces (web + mobile) share one source of truth for the
 * "next try in 2m 14s" / "gave up 5m ago" wall-clock copy.
 */
export type NotifyDeliveryStatus = "sent" | "retrying" | "failed_permanent";

export interface NotifyBadgeChannel {
  status: NotifyDeliveryStatus | null;
  attempts: number;
  lastAt: string | null;
  nextRetryAt: string | null;
  exhaustedAt: string | null;
}

export interface NotifyBadgeInfo {
  email: NotifyBadgeChannel;
  push: NotifyBadgeChannel;
}

export function NotifyBadgesRow({
  notify,
  retryNowMs,
  rowTestID,
  badgeTestIDPrefix,
}: {
  notify: NotifyBadgeInfo;
  retryNowMs: number;
  rowTestID: string;
  badgeTestIDPrefix: string;
}) {
  const badges: React.ReactNode[] = [];
  const renderBadge = (channel: "email" | "push", ch: NotifyBadgeChannel) => {
    const s = ch.status;
    if (!s) return null;
    const channelLabel = channel === "email" ? "Email" : "Push";
    const baseText =
      s === "sent"
        ? `${channelLabel} sent`
        : s === "retrying"
          ? `${channelLabel} retrying`
          : `${channelLabel} undelivered`;
    const nextTry = s === "retrying" ? formatRetryRelative(ch.nextRetryAt, retryNowMs) : null;
    const exhausted = s === "failed_permanent" ? formatRetryRelative(ch.exhaustedAt, retryNowMs) : null;
    const suffix =
      s === "retrying" && nextTry
        ? ` — next try ${nextTry}`
        : s === "failed_permanent" && exhausted
          ? ` — gave up ${exhausted}`
          : s !== "sent" && ch.attempts > 0
            ? ` (${ch.attempts})`
            : "";
    const palette =
      s === "sent"
        ? { bg: "#e7f7ee", fg: "#0a7d33", bd: "#bde7c8" }
        : s === "retrying"
          ? { bg: "#fff5e1", fg: "#a06a00", bd: "#f3d99a" }
          : { bg: "#fdecea", fg: "#a02923", bd: "#f5c2bf" };
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
        testID={`${badgeTestIDPrefix}-${channel}`}
      >
        <Text style={{ fontSize: 10, color: palette.fg, fontFamily: "Inter_600SemiBold" }}>
          {baseText}
          {suffix}
        </Text>
      </View>
    );
  };
  const emailBadge = renderBadge("email", notify.email);
  if (emailBadge) badges.push(emailBadge);
  const pushBadge = renderBadge("push", notify.push);
  if (pushBadge) badges.push(pushBadge);
  if (badges.length === 0) return null;
  return (
    <View
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}
      testID={rowTestID}
    >
      {badges}
    </View>
  );
}

export default NotifyBadgesRow;
