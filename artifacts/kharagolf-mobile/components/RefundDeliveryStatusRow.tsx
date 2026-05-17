import React from "react";
import { View, Text } from "react-native";

/**
 * Task #1862 — wallet refund "delivery status" row, member-facing.
 *
 * The legacy `NotifyBadgesRow` only renders the email + push retry
 * pills (Task #1841). Refund alerts also fan out to SMS and WhatsApp
 * when the recipient has opted in to those billing channels (per
 * `walletTopupRefundNotify.ts`), and Task #1508 added per-channel
 * retry state for them too. This row exists so members (and admins
 * via `RefundDeliveryStatusRowWeb` in the `kharagolf-web` artifact)
 * can answer "did the SMS/WhatsApp ever go out?" without database
 * access.
 *
 * The five rendered states mirror the API enum on
 * `serializeTopupRefundDelivery` (see side-games-v2.ts):
 *   - sent       → green
 *   - retrying   → amber
 *   - failed     → amber (transient — there's no next retry stamped
 *                  yet, but no exhaustedAt either)
 *   - exhausted  → red (gave up after the per-channel attempt cap)
 *   - skipped    → gray (provider not configured / opted out / no
 *                  address; nothing was sent and nothing will be)
 */
export type RefundDeliveryStatus = "sent" | "failed" | "retrying" | "exhausted" | "skipped";

export interface RefundDeliveryChannel {
  status: RefundDeliveryStatus | null;
  attempts: number;
  lastAt: string | null;
  nextRetryAt: string | null;
  exhaustedAt: string | null;
  /** Only present in admin responses; the member-facing wallet endpoint omits it. */
  lastError?: string | null;
}

export interface RefundDeliveryInfo {
  email: RefundDeliveryChannel;
  push: RefundDeliveryChannel;
  sms: RefundDeliveryChannel;
  whatsapp: RefundDeliveryChannel;
}

const CHANNEL_LABELS: Record<keyof RefundDeliveryInfo, string> = {
  email: "Email",
  push: "Push",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export function refundDeliveryStatusLabel(status: RefundDeliveryStatus | null): string {
  switch (status) {
    case "sent": return "Sent";
    case "retrying": return "Retrying";
    case "failed": return "Failed";
    case "exhausted": return "Gave up";
    case "skipped": return "Skipped";
    case null:
    default: return "—";
  }
}

function paletteFor(status: RefundDeliveryStatus | null) {
  switch (status) {
    case "sent": return { bg: "#e7f7ee", fg: "#0a7d33", bd: "#bde7c8" };
    case "retrying":
    case "failed": return { bg: "#fff5e1", fg: "#a06a00", bd: "#f3d99a" };
    case "exhausted": return { bg: "#fdecea", fg: "#a02923", bd: "#f5c2bf" };
    case "skipped": return { bg: "#eef0f2", fg: "#525c66", bd: "#d0d6dc" };
    case null:
    default: return { bg: "#f5f5f5", fg: "#888", bd: "#e0e0e0" };
  }
}

const CHANNEL_KEYS: Array<keyof RefundDeliveryInfo> = ["email", "push", "sms", "whatsapp"];

export function RefundDeliveryStatusRow({
  delivery,
  rowTestID,
  channelTestIDPrefix,
  showLastError = false,
}: {
  delivery: RefundDeliveryInfo;
  rowTestID: string;
  channelTestIDPrefix: string;
  /**
   * Member-facing wallet rows hide provider error strings; the admin
   * page on the web artifact passes `true` so support staff can see
   * the most recent provider error inline. Errors only render for
   * rows whose status is `failed` / `exhausted` (per the task's
   * "exhausted/failed rows" requirement); other rows do not have an
   * actionable error to show even when one is present in the DB.
   */
  showLastError?: boolean;
}) {
  return (
    <View
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}
      testID={rowTestID}
    >
      {CHANNEL_KEYS.map(channel => {
        const ch = delivery[channel];
        const palette = paletteFor(ch.status);
        const showError = showLastError && (ch.status === "failed" || ch.status === "exhausted") && Boolean(ch.lastError);
        return (
          <View
            key={channel}
            testID={`${channelTestIDPrefix}-${channel}`}
            style={{
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 6,
              backgroundColor: palette.bg,
              borderWidth: 1,
              borderColor: palette.bd,
              maxWidth: "100%",
            }}
          >
            <Text style={{ fontSize: 10, color: palette.fg, fontFamily: "Inter_600SemiBold" }}>
              {CHANNEL_LABELS[channel]}: {refundDeliveryStatusLabel(ch.status)}
            </Text>
            {showError && ch.lastError ? (
              <Text
                testID={`${channelTestIDPrefix}-${channel}-error`}
                style={{ fontSize: 10, color: palette.fg, fontFamily: "Inter_400Regular", marginTop: 1 }}
                numberOfLines={2}
              >
                {ch.lastError}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export default RefundDeliveryStatusRow;
