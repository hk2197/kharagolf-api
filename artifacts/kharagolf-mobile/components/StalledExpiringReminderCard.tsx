import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, ActivityIndicator, TouchableOpacity, Alert, StyleSheet,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { getApiUrl } from "@/utils/api";
import { getLocale } from "@/i18n";
import { formatRelativeTime } from "@/i18n/relativeTime";

const GOLD = "#C9A84C";

interface StalledReminderItem {
  id: number;
  clubMemberId: number;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberEmail: string | null;
  resolvedAt: string | null;
  expiringNoticeSentAt: string | null;
  expiringReminderEmailOpenedAt: string | null;
  expiringReminderEmailClickedAt: string | null;
  lastNotificationKind: string | null;
  lastNotifiedAt: string | null;
  purgesAt: string | null;
  lastNudgedAt: string | null;
  lastNudgedByDisplayName: string | null;
}

interface StalledRemindersResponse {
  filter: "all" | "opened-only" | "clicked";
  validDays: number;
  counts: { total: number; openedOnly: number; clicked: number };
  items: StalledReminderItem[];
}

type StalledFilter = "all" | "opened-only" | "clicked";

const FILTERS: { value: StalledFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "opened-only", label: "Opened only" },
  { value: "clicked", label: "Clicked" },
];

const STALLED_NUDGE_RECENT_WINDOW_MS = 60 * 60 * 1000;

function timeUntil(target: string | null): string {
  if (!target) return "—";
  const ms = new Date(target).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "purged";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h left`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH === 0 ? `${days}d left` : `${days}d ${remH}h left`;
}

// Defer to the shared `formatRelativeTime` helper (Task #1659) so the
// "Nudged X ago" label on this admin card renders translated copy in
// every supported locale via Intl.RelativeTimeFormat instead of the
// previous English-only "Xm/Xh/Xd ago" fragments. Null timestamps still
// render an em-dash placeholder so the meta row stays aligned.
function timeSince(target: string | null): string {
  return target ? formatRelativeTime(target) : "—";
}

/**
 * Mobile mirror of the web `StalledExpiringReminderWidget` (Task #1297 →
 * Task #1882 ports it to mobile). Surfaces members who opened the
 * export-expiring reminder but haven't downloaded their archive yet, so
 * controllers on their phone can fire a personal nudge before the daily
 * purger removes the file. Same filter tabs (All / Opened only / Clicked)
 * and same backend endpoints as the web widget:
 *   GET  /api/organizations/:orgId/members-360/data-requests/expiring-reminder-stalled?filter=…
 *   POST /api/organizations/:orgId/members-360/:memberId/data-requests/:id/resend
 *
 * Self-hides on 401/403 so the section disappears for non-admin users
 * (matching the web widget exactly). Polls every 60s while mounted so
 * counts stay current as new reminders are opened.
 */
export function StalledExpiringReminderCard({
  orgId,
  token,
}: {
  orgId: number | null | undefined;
  token: string | null | undefined;
}) {
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [filter, setFilter] = useState<StalledFilter>("all");
  const [data, setData] = useState<StalledRemindersResponse | null>(null);
  const [nudgingId, setNudgingId] = useState<number | null>(null);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!orgId || !token) return;
      try {
        const res = await fetch(
          getApiUrl(
            `/organizations/${orgId}/members-360/data-requests/expiring-reminder-stalled?filter=${filter}`,
          ),
          { headers: { Authorization: `Bearer ${token}` }, signal },
        );
        if (signal?.aborted) return;
        if (res.status === 401 || res.status === 403) {
          setAllowed(false);
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as StalledRemindersResponse;
        if (signal?.aborted) return;
        setData(body);
      } catch {
        /* best-effort — leave previous data in place */
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [orgId, token, filter],
  );

  useEffect(() => {
    if (!orgId || !token) {
      setLoading(false);
      return;
    }
    // Reset state when org / token / filter changes so a stale 401/403
    // from a previous org doesn't keep the card hidden after a switch.
    setLoading(true);
    setAllowed(true);
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    // Poll while mounted to mirror the web widget's 60s refetchInterval —
    // counts/rows stay current as new reminders are opened or clicked.
    const interval = setInterval(() => {
      void reload(ctrl.signal);
    }, 60_000);
    return () => {
      ctrl.abort();
      clearInterval(interval);
    };
  }, [orgId, token, reload]);

  const sendNudge = useCallback(
    async (memberId: number, requestId: number, label: string) => {
      if (!orgId || !token) return;
      setNudgingId(requestId);
      try {
        const res = await fetch(
          getApiUrl(
            `/organizations/${orgId}/members-360/${memberId}/data-requests/${requestId}/resend`,
          ),
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({} as { error?: string }));
          Alert.alert(
            "Could not send nudge",
            err.error ?? `HTTP ${res.status}`,
          );
          return;
        }
        Alert.alert(
          "Personal nudge sent",
          `${label}: the export-expiring reminder was re-delivered.`,
        );
        // Refetch so counts and the row's `lastNudgedAt` reflect the
        // freshly-resent state immediately.
        await reload();
      } catch (e) {
        Alert.alert(
          "Could not send nudge",
          e instanceof Error ? e.message : "Network error",
        );
      } finally {
        setNudgingId(null);
      }
    },
    [orgId, token, reload],
  );

  if (!orgId || !token) return null;
  if (!allowed) return null;

  const counts = data?.counts ?? { total: 0, openedOnly: 0, clicked: 0 };
  const items = data?.items ?? [];

  return (
    <View style={styles.card} testID="card-stalled-expiring-reminders">
      <View style={styles.headerRow}>
        <Feather name="eye" size={16} color="#fbbf24" />
        <Text style={styles.title}>Stalled export reminders</Text>
      </View>
      <Text style={styles.subtitle}>
        Members who opened the export-expiring reminder but haven't
        downloaded their archive. Send a personal nudge before the daily
        purger removes the file.
      </Text>

      <View style={styles.filterRow} testID="stalled-filters">
        {FILTERS.map((tab) => {
          const active = filter === tab.value;
          const countLabel =
            tab.value === "all"
              ? counts.total
              : tab.value === "opened-only"
                ? counts.openedOnly
                : counts.clicked;
          return (
            <TouchableOpacity
              key={tab.value}
              onPress={() => setFilter(tab.value)}
              style={[styles.filterChip, active && styles.filterChipActive]}
              testID={`stalled-filter-${tab.value}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text
                style={[
                  styles.filterChipText,
                  active && styles.filterChipTextActive,
                ]}
              >
                {tab.label} ({countLabel})
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={GOLD} />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      ) : items.length === 0 ? (
        <Text style={styles.emptyText} testID="stalled-empty">
          No stalled reminders.
        </Text>
      ) : (
        <View style={styles.list} testID="list-stalled-reminders">
          {items.map((row) => {
            const memberName =
              [row.memberFirstName, row.memberLastName]
                .filter(Boolean)
                .join(" ") || `Member #${row.clubMemberId}`;
            const clicked = !!row.expiringReminderEmailClickedAt;
            const openedAt = row.expiringReminderEmailOpenedAt
              ? new Date(row.expiringReminderEmailOpenedAt).toLocaleString(
                  getLocale(),
                )
              : "—";
            const purgeLabel = timeUntil(row.purgesAt);
            const purgesSoon =
              purgeLabel.includes("h left") && !purgeLabel.includes("d");
            const nudgedRecently =
              !!row.lastNudgedAt &&
              Date.now() - new Date(row.lastNudgedAt).getTime() <
                STALLED_NUDGE_RECENT_WINDOW_MS;
            const nudgedByName = row.lastNudgedByDisplayName ?? "an admin";
            const isPending = nudgingId === row.id;
            return (
              <View
                key={row.id}
                style={styles.row}
                testID={`stalled-row-${row.id}`}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={styles.rowTitleLine}>
                    <Text
                      style={styles.rowName}
                      numberOfLines={1}
                      testID={`stalled-member-${row.id}`}
                    >
                      {memberName}
                    </Text>
                    <View
                      style={[
                        styles.badge,
                        clicked ? styles.badgeClicked : styles.badgeOpened,
                      ]}
                    >
                      <Text
                        style={[
                          styles.badgeText,
                          clicked
                            ? styles.badgeTextClicked
                            : styles.badgeTextOpened,
                        ]}
                      >
                        {clicked ? "Clicked" : "Opened only"}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    <Text testID={`stalled-opened-${row.id}`}>
                      Opened {openedAt}
                    </Text>
                    <Text style={styles.rowMetaSep}> · </Text>
                    <Text
                      testID={`stalled-purges-${row.id}`}
                      style={purgesSoon ? styles.purgesSoon : undefined}
                    >
                      Purges in {purgeLabel}
                    </Text>
                  </Text>
                  {row.lastNudgedAt ? (
                    <Text
                      style={[
                        styles.rowNudged,
                        nudgedRecently && styles.rowNudgedRecently,
                      ]}
                      testID={`stalled-last-nudge-${row.id}`}
                      numberOfLines={1}
                    >
                      Nudged {timeSince(row.lastNudgedAt)} by {nudgedByName}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity
                  style={[
                    styles.nudgeBtn,
                    (isPending || nudgedRecently) && styles.nudgeBtnDisabled,
                  ]}
                  disabled={isPending || nudgedRecently}
                  onPress={() =>
                    sendNudge(row.clubMemberId, row.id, memberName)
                  }
                  testID={`stalled-nudge-${row.id}`}
                  accessibilityLabel={
                    nudgedRecently
                      ? `Already nudged ${timeSince(row.lastNudgedAt)} by ${nudgedByName}`
                      : `Send nudge to ${memberName}`
                  }
                >
                  {isPending ? (
                    <ActivityIndicator size="small" color="#fbbf24" />
                  ) : (
                    <Text style={styles.nudgeBtnText}>
                      {nudgedRecently ? "Just nudged" : "Send nudge"}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
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
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 10,
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: "transparent",
  },
  filterChipActive: {
    backgroundColor: "rgba(251,191,36,0.18)",
    borderColor: "rgba(251,191,36,0.45)",
  },
  filterChipText: { color: Colors.muted, fontSize: 12, fontWeight: "600" },
  filterChipTextActive: { color: "#fcd34d" },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
  },
  loadingText: { color: Colors.muted, fontSize: 12 },
  emptyText: { color: Colors.muted, fontSize: 12, marginTop: 12 },
  list: { marginTop: 10, gap: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  rowName: { color: Colors.text, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeClicked: {
    borderColor: "rgba(251,191,36,0.45)",
    backgroundColor: "rgba(251,191,36,0.12)",
  },
  badgeOpened: {
    borderColor: Colors.border,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  badgeText: { fontSize: 10, fontWeight: "700" },
  badgeTextClicked: { color: "#fcd34d" },
  badgeTextOpened: { color: Colors.muted },
  rowMeta: { color: Colors.muted, fontSize: 11, marginTop: 3 },
  rowMetaSep: { color: Colors.muted },
  purgesSoon: { color: "#fca5a5" },
  rowNudged: { color: Colors.muted, fontSize: 11, marginTop: 3 },
  rowNudgedRecently: { color: "#fcd34d" },
  nudgeBtn: {
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.45)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 96,
    alignItems: "center",
    backgroundColor: "rgba(251,191,36,0.06)",
  },
  nudgeBtnDisabled: { opacity: 0.5 },
  nudgeBtnText: { color: "#fcd34d", fontSize: 12, fontWeight: "700" },
});
