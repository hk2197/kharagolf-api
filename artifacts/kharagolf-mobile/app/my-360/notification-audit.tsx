// Task #2223 — Mobile mirror of the web portal's
// `/portal/notification-audit` page (PortalNotificationAudit.tsx).
//
// Surfaces the rows that `notification_audit_log` records when the
// dispatcher short-circuits delivery for the signed-in user. Without
// this screen, a controller who manages alerts on mobile and muted both
// the email and the in-app/push channel for an alert (e.g.
// `privacy.erasure.storage_failures.controller_digest`) had no way to
// discover that the cron tried to reach them — the only trace was a
// `skipped/event_opted_out` row in the database, only visible from the
// web portal at `/portal/notification-audit`.
//
// Each row is tagged either "you muted this" (`kind === 'user_muted'`)
// or "system suppressed" (everything else, e.g. `no_address`,
// `no_email_on_file`, `all_channels_opted_out`). User-muted rows
// include a "Re-enable in settings" button that deep-links back to
// the Communications screen so closing the loop is one tap.
import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { BASE_URL } from "./_shared";

interface AuditEntry {
  id: number;
  notificationKey: string;
  category: string | null;
  description: string | null;
  channel: string;
  status: string;
  reason: string | null;
  kind: "user_muted" | "system_suppressed";
  payload: Record<string, unknown>;
  createdAt: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  windowDays: number;
  limit: number;
  hasMore: boolean;
  nextBefore: string | null;
}

const WINDOW_OPTIONS = [7, 30, 90] as const;

export default function NotificationAuditScreen() {
  const { t } = useTranslation("profile");
  const { token } = useAuth();
  const [windowDays, setWindowDays] = useState<number>(30);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadFirstPage = useCallback(async (days: number) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/notification-audit?days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setEntries([]);
        setHasMore(false);
        setNextBefore(null);
        setError(
          res.status === 401
            ? t("commPrefs.notificationAudit.errorSignedOut")
            : t("commPrefs.notificationAudit.errorLoadFailed"),
        );
        return;
      }
      const data = (await res.json()) as AuditResponse;
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setHasMore(Boolean(data.hasMore));
      setNextBefore(data.nextBefore ?? null);
    } catch {
      setError(t("commPrefs.notificationAudit.errorLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void loadFirstPage(windowDays);
  }, [loadFirstPage, windowDays]);

  const loadMore = useCallback(async () => {
    if (!token || !nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `${BASE_URL}/api/portal/notification-audit?days=${windowDays}&before=${encodeURIComponent(nextBefore)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return;
      const data = (await res.json()) as AuditResponse;
      const more = Array.isArray(data.entries) ? data.entries : [];
      setEntries(prev => [...prev, ...more]);
      setHasMore(Boolean(data.hasMore));
      setNextBefore(data.nextBefore ?? null);
    } finally {
      setLoadingMore(false);
    }
  }, [token, nextBefore, loadingMore, windowDays]);

  const goToCommPrefs = useCallback(() => {
    router.push("/my-360/communications");
  }, []);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      contentContainerStyle={{ padding: 16 }}
      testID="screen-notification-audit"
    >
      <View style={styles.headerRow}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={styles.heading} testID="heading-notification-audit">
            {t("commPrefs.notificationAudit.heading")}
          </Text>
          <Text style={styles.intro}>
            {t("commPrefs.notificationAudit.intro")}
          </Text>
        </View>
        <Pressable
          onPress={goToCommPrefs}
          style={styles.openCommPrefsBtn}
          accessibilityRole="button"
          accessibilityLabel={t("commPrefs.notificationAudit.openCommPrefs")}
          testID="link-comm-prefs"
        >
          <Feather name="settings" size={14} color="#cbd5e1" />
          <Text style={styles.openCommPrefsText}>
            {t("commPrefs.notificationAudit.openCommPrefs")}
          </Text>
        </Pressable>
      </View>

      <View style={styles.controlsCard}>
        <View style={styles.controlsRow}>
          <Text style={styles.windowLabel}>
            {t("commPrefs.notificationAudit.windowLabel")}
          </Text>
          <View style={styles.windowGroup} accessibilityRole="radiogroup">
            {WINDOW_OPTIONS.map(d => {
              const active = d === windowDays;
              return (
                <Pressable
                  key={d}
                  onPress={() => setWindowDays(d)}
                  style={[styles.windowBtn, active && styles.windowBtnActive]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active, checked: active }}
                  testID={`btn-window-${d}`}
                >
                  <Text style={[styles.windowBtnText, active && styles.windowBtnTextActive]}>
                    {t("commPrefs.notificationAudit.windowDays", { count: d })}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <Pressable
          onPress={() => void loadFirstPage(windowDays)}
          disabled={loading}
          style={[styles.refreshBtn, loading && styles.refreshBtnDisabled]}
          accessibilityRole="button"
          accessibilityLabel={t("commPrefs.notificationAudit.refresh")}
          testID="btn-refresh"
        >
          <Feather name="refresh-cw" size={14} color="#cbd5e1" />
          <Text style={styles.refreshBtnText}>
            {t("commPrefs.notificationAudit.refresh")}
          </Text>
        </Pressable>
      </View>

      {error ? (
        <View style={styles.errorCard} testID="audit-error">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : loading ? (
        <View style={styles.loadingCard} testID="audit-loading">
          <LoadingSpinner color={Colors.primary} />
          <Text style={styles.loadingText}>
            {t("commPrefs.notificationAudit.loading")}
          </Text>
        </View>
      ) : entries.length === 0 ? (
        <View style={styles.emptyCard} testID="audit-empty">
          <Feather name="bell-off" size={28} color="#9ca3af" />
          <Text style={styles.emptyTitle}>
            {t("commPrefs.notificationAudit.emptyTitle")}
          </Text>
          <Text style={styles.emptySubtitle}>
            {t("commPrefs.notificationAudit.emptySubtitle", { days: windowDays })}
          </Text>
        </View>
      ) : (
        <View testID="audit-list">
          {entries.map(entry => {
            const muted = entry.kind === "user_muted";
            const when = new Date(entry.createdAt);
            const whenLabel = Number.isFinite(when.getTime())
              ? when.toLocaleString()
              : entry.createdAt;
            return (
              <View
                key={entry.id}
                style={styles.entryCard}
                testID={`audit-row-${entry.id}`}
              >
                <View style={styles.entryHeader}>
                  <View
                    style={[styles.kindBadge, muted ? styles.kindBadgeMuted : styles.kindBadgeSystem]}
                    testID={`badge-kind-${entry.id}`}
                  >
                    <Feather
                      name={muted ? "bell-off" : "alert-triangle"}
                      size={11}
                      color={muted ? "#fcd34d" : "#7dd3fc"}
                    />
                    <Text style={[styles.kindBadgeText, muted ? styles.kindBadgeTextMuted : styles.kindBadgeTextSystem]}>
                      {muted
                        ? t("commPrefs.notificationAudit.kindUserMuted")
                        : t("commPrefs.notificationAudit.kindSystemSuppressed")}
                    </Text>
                  </View>
                  {entry.category ? (
                    <View style={styles.categoryBadge}>
                      <Text style={styles.categoryBadgeText}>{entry.category}</Text>
                    </View>
                  ) : null}
                  <Text style={styles.channelText}>{entry.channel}</Text>
                </View>
                <Text style={styles.descriptionText}>
                  {entry.description ?? entry.notificationKey}
                </Text>
                <Text style={styles.notificationKeyText}>{entry.notificationKey}</Text>
                {entry.reason ? (
                  <Text style={styles.reasonText}>
                    {t("commPrefs.notificationAudit.reasonLabel")}:{" "}
                    <Text style={styles.reasonValue}>{entry.reason}</Text>
                  </Text>
                ) : null}
                <View style={styles.entryFooter}>
                  <Text style={styles.whenText} testID={`audit-when-${entry.id}`}>
                    {whenLabel}
                  </Text>
                  {muted ? (
                    <Pressable
                      onPress={goToCommPrefs}
                      style={styles.reenableBtn}
                      accessibilityRole="button"
                      accessibilityLabel={t("commPrefs.notificationAudit.reenable")}
                      testID={`btn-reenable-${entry.id}`}
                    >
                      <Text style={styles.reenableBtnText}>
                        {t("commPrefs.notificationAudit.reenable")}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          })}
          {hasMore ? (
            <Pressable
              onPress={() => void loadMore()}
              disabled={loadingMore}
              style={[styles.loadMoreBtn, loadingMore && styles.refreshBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel={t("commPrefs.notificationAudit.loadMore")}
              testID="btn-load-more"
            >
              {loadingMore ? (
                <ActivityIndicator color={Colors.primary} />
              ) : (
                <Feather name="chevron-down" size={14} color="#cbd5e1" />
              )}
              <Text style={styles.loadMoreText}>
                {loadingMore
                  ? t("commPrefs.notificationAudit.loadingMore")
                  : t("commPrefs.notificationAudit.loadMore")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 12 },
  heading: { color: "#fff", fontSize: 18, fontWeight: "700" },
  intro: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 4 },
  openCommPrefsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  openCommPrefsText: { color: "#cbd5e1", fontSize: 11, fontWeight: "600" },
  controlsCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 8,
    flexWrap: "wrap",
  },
  controlsRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  windowLabel: {
    color: Colors.tabIconDefault,
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  windowGroup: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    overflow: "hidden",
  },
  windowBtn: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "transparent" },
  windowBtnActive: { backgroundColor: Colors.primary },
  windowBtnText: { color: "#9ca3af", fontSize: 11 },
  windowBtnTextActive: { color: "#fff", fontWeight: "600" },
  refreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  refreshBtnDisabled: { opacity: 0.5 },
  refreshBtnText: { color: "#cbd5e1", fontSize: 11, fontWeight: "600" },
  errorCard: {
    backgroundColor: Colors.surface,
    borderColor: "#7f1d1d",
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  errorText: { color: "#fca5a5", fontSize: 12 },
  loadingCard: {
    backgroundColor: Colors.surface,
    borderColor: Colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
    gap: 8,
  },
  loadingText: { color: Colors.tabIconDefault, fontSize: 12 },
  emptyCard: {
    backgroundColor: Colors.surface,
    borderColor: Colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
    gap: 6,
  },
  emptyTitle: { color: "#e2e8f0", fontSize: 13, fontWeight: "600", marginTop: 4 },
  emptySubtitle: { color: Colors.tabIconDefault, fontSize: 11, textAlign: "center" },
  entryCard: {
    backgroundColor: Colors.surface,
    borderColor: Colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  entryHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  kindBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  kindBadgeMuted: { backgroundColor: "rgba(245,158,11,0.15)", borderColor: "rgba(245,158,11,0.30)" },
  kindBadgeSystem: { backgroundColor: "rgba(14,165,233,0.15)", borderColor: "rgba(14,165,233,0.30)" },
  kindBadgeText: { fontSize: 10, fontWeight: "700" },
  kindBadgeTextMuted: { color: "#fcd34d" },
  kindBadgeTextSystem: { color: "#7dd3fc" },
  categoryBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  categoryBadgeText: { color: "#cbd5e1", fontSize: 10 },
  channelText: { color: Colors.tabIconDefault, fontSize: 11 },
  descriptionText: { color: "#e2e8f0", fontSize: 13, marginTop: 8 },
  notificationKeyText: {
    color: Colors.tabIconDefault,
    fontSize: 10,
    fontFamily: "monospace",
    marginTop: 2,
  },
  reasonText: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 4 },
  reasonValue: { color: "#cbd5e1", fontFamily: "monospace" },
  entryFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    gap: 8,
    flexWrap: "wrap",
  },
  whenText: { color: Colors.tabIconDefault, fontSize: 11 },
  reenableBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  reenableBtnText: { color: "#cbd5e1", fontSize: 11, fontWeight: "600" },
  loadMoreBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: 4,
  },
  loadMoreText: { color: "#cbd5e1", fontSize: 12, fontWeight: "600" },
});
