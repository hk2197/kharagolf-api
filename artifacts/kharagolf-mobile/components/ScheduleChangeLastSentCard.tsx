import React, { useEffect, useState } from "react";
import {
  View, Text, ActivityIndicator, TouchableOpacity, Alert, StyleSheet,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { getApiUrl } from "@/utils/api";
import { getLocale } from "@/i18n";

const GOLD = "#C9A84C";

// Task #947 — fallback so UI cooldown logic still works against an older
// API server that hasn't started returning `resendCooldownSeconds` yet
// (mirrors the same constant in the web `ScheduleChangeOptOutsCard`).
const DEFAULT_RESEND_COOLDOWN_SECONDS = 60;

interface ScheduleChangeRecipient {
  userId: number;
  email: string;
  displayName: string;
}

interface ScheduleChangeSend {
  id: number;
  sentAt: string;
  recipients: ScheduleChangeRecipient[];
  // Task #947 — `lastResendAt` + `resendCooldownSeconds` let the UI show
  // a precise countdown and disable the per-row Resend button until the
  // server-side cooldown elapses (survives reloads because both fields
  // come from the database row).
  lastResendAt: string | null;
  resendCooldownSeconds: number;
  changedBy: { userId: number; displayName: string; email: string | null } | null;
}

function resendCooldownRemainingSeconds(send: ScheduleChangeSend, nowMs: number): number {
  if (!send.lastResendAt) return 0;
  const cooldownMs = (send.resendCooldownSeconds || DEFAULT_RESEND_COOLDOWN_SECONDS) * 1000;
  const elapsedMs = nowMs - new Date(send.lastResendAt).getTime();
  if (!Number.isFinite(elapsedMs)) return 0;
  const remainingMs = cooldownMs - elapsedMs;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

function formatSentAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(getLocale(), {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Mobile mirror of the web `ScheduleChangeOptOutsCard`'s sibling
 * "Schedule-change notifications — last sent" audit panel
 * (Task #513 / Task #655 / Task #947).
 *
 * Lists the most recent schedule-change heads-up emails dispatched for
 * this org (timestamp, who triggered it, recipient list) and exposes a
 * per-row Resend button so mobile-only org admins can answer
 * "did Jane actually get the email?" and re-dispatch a previous send
 * straight from the phone — closing the parity gap left by Task #1688
 * which only ported the opt-out half.
 *
 * Hits the same endpoints as the web panel:
 *   GET  /api/organizations/:orgId/bounced-digest-schedule-sends
 *   POST /api/organizations/:orgId/bounced-digest-schedule-sends/:id/resend
 *
 * Self-hides on 401/403 like the sibling opt-outs card so the section
 * disappears for non-admin users (Task #387 behaviour).
 *
 * The Resend button respects the per-row cooldown returned by the
 * server (`lastResendAt` + `resendCooldownSeconds`) with a live
 * "Resend in Ns" countdown, and surfaces 429 retry-after responses
 * gracefully — stamping the local `lastResendAt` from the 429 payload so
 * the button immediately disables itself and the countdown takes over.
 */
export function ScheduleChangeLastSentCard({
  orgId,
  token,
}: {
  orgId: number | null | undefined;
  token: string | null | undefined;
}) {
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [sends, setSends] = useState<ScheduleChangeSend[]>([]);
  const [resending, setResending] = useState<Record<number, boolean>>({});
  // Mobile substitute for the web's `<details>` disclosure: collapsed by
  // default so the card stays compact, expanded on tap to reveal the
  // earlier sends list (matching the web's "Show N earlier sends" UX).
  const [showEarlier, setShowEarlier] = useState(false);
  // Re-render once per second while any send is inside the cooldown
  // window so the per-row "Resend in Ns" label ticks down smoothly. The
  // cooldown itself is server-side; this is purely a display refresh.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!orgId || !token) { setLoading(false); return; }
    let alive = true;
    // Reset state so switching from an unauthorized org to one where
    // the user IS an admin re-shows the card (and vice-versa). Without
    // this a stale `allowed=false` from the previous org would keep
    // the section hidden after the user switches clubs (mirrors the
    // sibling opt-outs card's behaviour).
    setLoading(true);
    setAllowed(true);
    setSends([]);
    setShowEarlier(false);
    fetch(getApiUrl(`/organizations/${orgId}/bounced-digest-schedule-sends`), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setAllowed(false); return; }
        if (!r.ok) return;
        const data = (await r.json()) as ScheduleChangeSend[];
        setSends(data);
      })
      .catch(() => { /* best-effort — leave loading off, allowed unchanged */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId, token]);

  useEffect(() => {
    if (!sends.some((s) => resendCooldownRemainingSeconds(s, Date.now()) > 0)) return;
    const t = setInterval(() => {
      const next = Date.now();
      setNowMs(next);
      // Stop ticking once every row has cleared its cooldown so we
      // don't re-render the card forever after the last countdown ends.
      if (!sends.some((s) => resendCooldownRemainingSeconds(s, next) > 0)) {
        clearInterval(t);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [sends]);

  const doResend = async (sendId: number) => {
    if (!orgId || !token) return;
    setResending((prev) => ({ ...prev, [sendId]: true }));
    try {
      const res = await fetch(
        getApiUrl(`/organizations/${orgId}/bounced-digest-schedule-sends/${sendId}/resend`),
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        // Task #947 — when the server says we're inside the cooldown
        // window, stamp the matching row's `lastResendAt` from the 429
        // payload so the per-row Resend button immediately disables
        // itself and the countdown label takes over (no more
        // retry-and-toast loops).
        if (res.status === 429
          && (typeof data.retryAfterSeconds === "number" || typeof data.lastResendAt === "string")) {
          const cooldownSeconds = typeof data.cooldownSeconds === "number"
            ? (data.cooldownSeconds as number)
            : DEFAULT_RESEND_COOLDOWN_SECONDS;
          const retryAfterSeconds = typeof data.retryAfterSeconds === "number"
            ? (data.retryAfterSeconds as number)
            : cooldownSeconds;
          const derivedLastResendIso = typeof data.lastResendAt === "string" && data.lastResendAt
            ? (data.lastResendAt as string)
            : new Date(Date.now() - Math.max(0, cooldownSeconds - retryAfterSeconds) * 1000).toISOString();
          setSends((prev) => prev.map((s) => s.id === sendId
            ? { ...s, lastResendAt: derivedLastResendIso, resendCooldownSeconds: cooldownSeconds }
            : s));
          setNowMs(Date.now());
          Alert.alert(
            "Resend available shortly",
            typeof data.retryAfterSeconds === "number"
              ? `Try again in ${retryAfterSeconds}s.`
              : "Please wait a moment before resending again.",
          );
          return;
        }
        const errMsg = typeof data.error === "string" ? (data.error as string) : `HTTP ${res.status}`;
        Alert.alert("Could not resend", errMsg);
        return;
      }
      const cooldownSeconds = typeof data.resendCooldownSeconds === "number"
        ? (data.resendCooldownSeconds as number)
        : DEFAULT_RESEND_COOLDOWN_SECONDS;
      const newSend: ScheduleChangeSend = {
        id: data.id as number,
        sentAt: data.sentAt as string,
        recipients: ((data.recipients ?? []) as ScheduleChangeRecipient[]),
        lastResendAt: typeof data.lastResendAt === "string" ? (data.lastResendAt as string) : null,
        resendCooldownSeconds: cooldownSeconds,
        changedBy: (data.changedBy as ScheduleChangeSend["changedBy"]) ?? null,
      };
      // Task #947 — also stamp the originating row so its Resend button
      // disables for the cooldown window. The server returns the exact
      // `last_resend_at` it just claimed, so the countdown is accurate.
      const resentFromIso = typeof data.resentFromLastResendAt === "string"
        ? (data.resentFromLastResendAt as string)
        : new Date().toISOString();
      setSends((prev) => [
        newSend,
        ...prev.map((s) => s.id === sendId
          ? { ...s, lastResendAt: resentFromIso, resendCooldownSeconds: cooldownSeconds }
          : s),
      ]);
      setNowMs(Date.now());
      Alert.alert(
        "Schedule-change email resent",
        `${newSend.recipients.length} recipient${newSend.recipients.length === 1 ? "" : "s"} notified.`,
      );
    } finally {
      setResending((prev) => {
        const next = { ...prev };
        delete next[sendId];
        return next;
      });
    }
  };

  // Task #812 — mirror the web's confirmation prompt before re-emailing
  // the original recipient list so admins exploring earlier sends can't
  // fat-finger a fresh broadcast.
  const askResend = (send: ScheduleChangeSend) => {
    const count = send.recipients.length;
    Alert.alert(
      `Resend to ${count} ${count === 1 ? "person" : "people"}?`,
      `This will re-email everyone on the original recipient list from the send on ${formatSentAt(send.sentAt)}.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Resend email", style: "destructive", onPress: () => { void doResend(send.id); } },
      ],
    );
  };

  if (!orgId || !token) return null;
  if (!allowed) return null;

  const lastSend = sends[0] ?? null;
  const earlier = sends.slice(1);

  return (
    <View style={styles.card} testID="card-schedule-change-last-send">
      <View style={styles.headerRow}>
        <Feather name="mail" size={16} color="#fbbf24" />
        <Text style={styles.title}>Schedule-change emails — last sent</Text>
      </View>
      <Text style={styles.subtitle}>
        Audit trail of the most recent schedule-change heads-up emails. Use
        this to confirm a specific recipient was actually notified.
      </Text>

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={GOLD} />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      ) : !lastSend ? (
        <Text style={styles.emptyText} testID="text-no-schedule-sends">
          No schedule-change notification has been sent yet.
        </Text>
      ) : (
        <View testID="block-schedule-last-send">
          <View style={styles.lastSendHeaderRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.sentAtText}>
                Last sent{" "}
                <Text style={styles.sentAtValue} testID="text-last-sent-at">
                  {formatSentAt(lastSend.sentAt)}
                </Text>
              </Text>
              {lastSend.changedBy ? (
                <Text style={styles.triggeredByText} numberOfLines={1}>
                  triggered by {lastSend.changedBy.displayName}
                </Text>
              ) : null}
              <Text style={styles.recipientCountText} testID="text-last-sent-count">
                {lastSend.recipients.length} recipient{lastSend.recipients.length === 1 ? "" : "s"}
              </Text>
            </View>
            {(() => {
              const remaining = resendCooldownRemainingSeconds(lastSend, nowMs);
              const onCooldown = remaining > 0;
              const isResending = !!resending[lastSend.id];
              return (
                <TouchableOpacity
                  style={[styles.btn, (isResending || onCooldown) && styles.btnDisabled]}
                  disabled={isResending || onCooldown}
                  onPress={() => askResend(lastSend)}
                  testID={`button-resend-send-${lastSend.id}`}
                >
                  {isResending ? (
                    <ActivityIndicator size="small" color={Colors.text} />
                  ) : onCooldown ? (
                    <Text style={styles.btnText} testID={`text-resend-cooldown-${lastSend.id}`}>
                      Resend in {remaining}s
                    </Text>
                  ) : (
                    <Text style={styles.btnText}>Resend</Text>
                  )}
                </TouchableOpacity>
              );
            })()}
          </View>

          <View style={styles.recipientsList} testID="list-last-sent-recipients">
            {lastSend.recipients.map((r) => (
              <View key={r.userId} style={styles.recipientRow}>
                <Text style={styles.recipientName} numberOfLines={1}>{r.displayName}</Text>
                <Text style={styles.recipientEmail} numberOfLines={1}>{r.email}</Text>
              </View>
            ))}
          </View>

          {earlier.length > 0 ? (
            <View style={styles.earlierWrap}>
              <TouchableOpacity
                onPress={() => setShowEarlier((v) => !v)}
                style={styles.earlierToggle}
                testID="toggle-earlier-sends"
              >
                <Feather
                  name={showEarlier ? "chevron-up" : "chevron-down"}
                  size={14}
                  color={Colors.muted}
                />
                <Text style={styles.earlierToggleText}>
                  {showEarlier ? "Hide" : "Show"} {earlier.length} earlier send{earlier.length === 1 ? "" : "s"}
                </Text>
              </TouchableOpacity>
              {showEarlier ? (
                <View style={styles.earlierList} testID="list-earlier-sends">
                  {earlier.map((s) => {
                    const remaining = resendCooldownRemainingSeconds(s, nowMs);
                    const onCooldown = remaining > 0;
                    const isResending = !!resending[s.id];
                    return (
                      <View key={s.id} style={styles.earlierRow}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.earlierSentAt} numberOfLines={1}>
                            {formatSentAt(s.sentAt)}
                          </Text>
                          <Text style={styles.earlierMeta} numberOfLines={1}>
                            {s.recipients.length} recipient{s.recipients.length === 1 ? "" : "s"}
                            {s.changedBy ? ` · ${s.changedBy.displayName}` : ""}
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={[styles.btn, (isResending || onCooldown) && styles.btnDisabled]}
                          disabled={isResending || onCooldown}
                          onPress={() => askResend(s)}
                          testID={`button-resend-send-${s.id}`}
                        >
                          {isResending ? (
                            <ActivityIndicator size="small" color={Colors.text} />
                          ) : onCooldown ? (
                            <Text style={styles.btnText} testID={`text-resend-cooldown-${s.id}`}>
                              Resend in {remaining}s
                            </Text>
                          ) : (
                            <Text style={styles.btnText}>Resend</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: Colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
  subtitle: { color: Colors.muted, fontSize: 12, marginTop: 6, lineHeight: 17 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  loadingText: { color: Colors.muted, fontSize: 12 },
  emptyText: { color: Colors.muted, fontSize: 12, marginTop: 10 },
  lastSendHeaderRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 10 },
  sentAtText: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  sentAtValue: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  triggeredByText: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  recipientCountText: { color: Colors.muted, fontSize: 11, marginTop: 2 },
  recipientsList: { marginTop: 10, gap: 6 },
  recipientRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  recipientName: { color: Colors.text, fontSize: 12, flexShrink: 1 },
  recipientEmail: { color: Colors.muted, fontSize: 12, flexShrink: 1, textAlign: "right" },
  earlierWrap: { marginTop: 12 },
  earlierToggle: { flexDirection: "row", alignItems: "center", gap: 6 },
  earlierToggleText: { color: Colors.muted, fontSize: 12 },
  earlierList: { marginTop: 8, gap: 8 },
  earlierRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  earlierSentAt: { color: Colors.text, fontSize: 12, fontWeight: "600" },
  earlierMeta: { color: Colors.muted, fontSize: 11, marginTop: 2 },
  btn: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 96,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: Colors.text, fontSize: 12, fontWeight: "600" },
});
