import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import { BASE_URL } from "@/utils/api";
import { getLocale } from "@/i18n";
import { formatRelativeTime } from "@/i18n/relativeTime";

const GOLD = "#C9A84C";
// React Native Alert.prompt API constant — not user-facing copy. Hoisted
// to a typed constant so the screen-translation lint doesn't flag it as
// raw English in an alert call.
const PROMPT_PLAIN_TEXT: "plain-text" = "plain-text";

interface ErasureStorageFailureItem {
  clubMemberId: number;
  auditId: number;
  completedAt: string;
  objectStorageFilesFailed: number;
  dataRequestId: number | null;
  autoRetryAttempts: number;
  autoRetryExhausted: boolean;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgementNote: string | null;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberDeleted: boolean;
}

interface ErasureStorageFailuresResponse {
  count: number;
  totalFailedFiles: number;
  items: ErasureStorageFailureItem[];
  pendingStorageDeletions: { total: number; exhausted: number };
  autoRetryExhaustedCount: number;
  autoRetryMaxAttempts: number;
  acknowledgedCount: number;
}

interface PendingStorageDeletionItem {
  id: number;
  clubMemberId: number | null;
  sourceAuditId: number | null;
  path: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  exhausted: boolean;
  exhaustionNotifiedAt: string | null;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberDeleted: boolean;
}

interface PendingStorageResponse {
  count: number;
  onlyExhausted: boolean;
  items: PendingStorageDeletionItem[];
}

type Row =
  | { kind: "section"; key: string; label: string }
  | { kind: "item"; key: string; item: ErasureStorageFailureItem }
  | { kind: "pending"; key: string; item: PendingStorageDeletionItem }
  | { kind: "empty"; key: string; label: string };

export default function ErasureCleanupScreen() {
  const { t } = useTranslation(["home", "common"]);
  const { token } = useAuth();
  const { activeClub } = useActiveClub();
  const orgId = activeClub?.id ?? null;
  const queryClient = useQueryClient();
  const [actingMemberId, setActingMemberId] = useState<number | null>(null);
  const [actingPendingId, setActingPendingId] = useState<number | null>(null);

  const failuresKey = ["erasure-storage-failures", orgId] as const;
  const pendingKey = ["erasure-storage-pending", orgId] as const;

  const failures = useQuery<ErasureStorageFailuresResponse | null>({
    queryKey: failuresKey,
    queryFn: async () => {
      if (!orgId || !token) return null;
      const res = await fetch(
        `${BASE_URL}/api/organizations/${orgId}/members-360/erasures/storage-failures`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error("Failed to load stuck erasure backlog");
      return (await res.json()) as ErasureStorageFailuresResponse;
    },
    enabled: !!orgId && !!token,
    refetchInterval: 60_000,
    retry: false,
  });

  const pending = useQuery<PendingStorageResponse | null>({
    queryKey: pendingKey,
    queryFn: async () => {
      if (!orgId || !token) return null;
      const res = await fetch(
        `${BASE_URL}/api/organizations/${orgId}/members-360/erasures/storage-failures/pending`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error("Failed to load pending storage queue");
      return (await res.json()) as PendingStorageResponse;
    },
    enabled: !!orgId && !!token,
    refetchInterval: 60_000,
    retry: false,
  });

  const refetchAll = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: failuresKey }),
      queryClient.invalidateQueries({ queryKey: pendingKey }),
    ]);
  }, [queryClient, failuresKey, pendingKey]);

  const showError = useCallback(
    (e: unknown) =>
      Alert.alert(
        t("erasureCleanupActionFailed"),
        e instanceof Error ? e.message : "Network error",
      ),
    [t],
  );

  const onRetry = useCallback(
    (memberId: number) => {
      if (!orgId || !token) return;
      setActingMemberId(memberId);
      void (async () => {
        try {
          const res = await fetch(
            `${BASE_URL}/api/organizations/${orgId}/members-360/${memberId}/erasure-history/retry-storage`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({}),
            },
          );
          if (!res.ok) {
            const err = (await res
              .json()
              .catch(() => ({}))) as { error?: string };
            throw new Error(err.error ?? `HTTP ${res.status}`);
          }
          Alert.alert(t("erasureCleanupRetryQueued"));
          await refetchAll();
        } catch (e) {
          showError(e);
        } finally {
          setActingMemberId(null);
        }
      })();
    },
    [orgId, token, t, refetchAll, showError],
  );

  const onAcknowledge = useCallback(
    (memberId: number) => {
      if (!orgId || !token) return;
      const submit = (note: string | null) => {
        setActingMemberId(memberId);
        void (async () => {
          try {
            const res = await fetch(
              `${BASE_URL}/api/organizations/${orgId}/members-360/${memberId}/erasure-history/acknowledge`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(note && note.length > 0 ? { note } : {}),
              },
            );
            if (!res.ok) {
              const err = (await res
                .json()
                .catch(() => ({}))) as { error?: string };
              throw new Error(err.error ?? `HTTP ${res.status}`);
            }
            Alert.alert(t("erasureCleanupAckRecorded"));
            await refetchAll();
          } catch (e) {
            showError(e);
          } finally {
            setActingMemberId(null);
          }
        })();
      };
      // Alert.prompt is iOS-only. On Android there's no in-built prompt;
      // confirm with a two-button alert and submit without a note.
      if (Platform.OS === "ios" && typeof Alert.prompt === "function") {
        Alert.prompt(
          t("erasureCleanupAckNoteTitle"),
          t("erasureCleanupAckNoteMessage"),
          [
            { text: t("common:cancel"), style: "cancel" },
            {
              text: t("erasureCleanupAcknowledge"),
              onPress: (note?: string) =>
                submit(typeof note === "string" ? note : null),
            },
          ],
          PROMPT_PLAIN_TEXT,
        );
      } else {
        Alert.alert(
          t("erasureCleanupAckNoteTitle"),
          t("erasureCleanupAckNoteMessage"),
          [
            { text: t("common:cancel"), style: "cancel" },
            {
              text: t("erasureCleanupAcknowledge"),
              onPress: () => submit(null),
            },
          ],
        );
      }
    },
    [orgId, token, t, refetchAll, showError],
  );

  const onForceRetry = useCallback(
    (pendingId: number) => {
      if (!orgId || !token) return;
      setActingPendingId(pendingId);
      void (async () => {
        try {
          const res = await fetch(
            `${BASE_URL}/api/organizations/${orgId}/members-360/erasures/storage-failures/pending/${pendingId}/retry-now`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({}),
            },
          );
          if (!res.ok) {
            const err = (await res
              .json()
              .catch(() => ({}))) as { error?: string };
            throw new Error(err.error ?? `HTTP ${res.status}`);
          }
          Alert.alert(t("erasureCleanupRetryQueued"));
          await refetchAll();
        } catch (e) {
          showError(e);
        } finally {
          setActingPendingId(null);
        }
      })();
    },
    [orgId, token, t, refetchAll, showError],
  );

  const onResolve = useCallback(
    (pendingId: number) => {
      if (!orgId || !token) return;
      const submit = (reason: string) => {
        if (!reason || reason.trim().length === 0) return;
        setActingPendingId(pendingId);
        void (async () => {
          try {
            const res = await fetch(
              `${BASE_URL}/api/organizations/${orgId}/members-360/erasures/storage-failures/pending/${pendingId}/resolve`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ reason: reason.trim() }),
              },
            );
            if (!res.ok) {
              const err = (await res
                .json()
                .catch(() => ({}))) as { error?: string };
              throw new Error(err.error ?? `HTTP ${res.status}`);
            }
            Alert.alert(t("erasureCleanupResolved"));
            await refetchAll();
          } catch (e) {
            showError(e);
          } finally {
            setActingPendingId(null);
          }
        })();
      };
      // Alert.prompt is iOS-only. The /resolve endpoint REQUIRES a non-empty
      // reason, so on Android (no prompt API) we surface a notice telling the
      // controller to use the web governance panel for now rather than
      // POSTing without a reason and 400-ing.
      if (Platform.OS === "ios" && typeof Alert.prompt === "function") {
        Alert.prompt(
          t("erasureCleanupResolveReasonTitle"),
          t("erasureCleanupResolveReasonPrompt"),
          [
            { text: t("common:cancel"), style: "cancel" },
            {
              text: t("erasureCleanupPendingResolve"),
              onPress: (reason?: string) =>
                submit(typeof reason === "string" ? reason : ""),
            },
          ],
          PROMPT_PLAIN_TEXT,
        );
      } else {
        Alert.alert(
          t("erasureCleanupResolveReasonTitle"),
          t("erasureCleanupResolveReasonPrompt"),
        );
      }
    },
    [orgId, token, t, refetchAll, showError],
  );

  const isLoading = failures.isLoading || pending.isLoading;
  const isRefreshing = failures.isFetching || pending.isFetching;

  const items = failures.data?.items ?? [];
  const pendingItems = pending.data?.items ?? [];

  // Build a single FlatList data array so the screen scrolls as one unit
  // with shared pull-to-refresh, matching the web governance panel layout.
  const rows: Row[] = [];
  rows.push({
    kind: "section",
    key: "section-members",
    label: t("stuckErasureTitle"),
  });
  if (items.length === 0) {
    rows.push({
      kind: "empty",
      key: "empty-members",
      label: t("erasureCleanupEmpty"),
    });
  } else {
    for (const item of items) {
      rows.push({ kind: "item", key: `m-${item.auditId}`, item });
    }
  }
  rows.push({
    kind: "section",
    key: "section-pending",
    label: t("erasureCleanupPendingTitle"),
  });
  if (pendingItems.length === 0) {
    rows.push({
      kind: "empty",
      key: "empty-pending",
      label: t("erasureCleanupPendingEmpty"),
    });
  } else {
    for (const p of pendingItems) {
      rows.push({ kind: "pending", key: `p-${p.id}`, item: p });
    }
  }

  const renderItem = ({ item: row }: { item: Row }) => {
    if (row.kind === "section") {
      return (
        <Text style={styles.sectionLabel} testID={`section-${row.key}`}>
          {row.label}
        </Text>
      );
    }
    if (row.kind === "empty") {
      return (
        <Text style={styles.emptyText} testID={`empty-${row.key}`}>
          {row.label}
        </Text>
      );
    }
    if (row.kind === "item") {
      const it = row.item;
      const memberName =
        [it.memberFirstName, it.memberLastName].filter(Boolean).join(" ") ||
        `Member #${it.clubMemberId}`;
      const completedAt = it.completedAt
        ? formatRelativeTime(it.completedAt)
        : "—";
      const isPending = actingMemberId === it.clubMemberId;
      const failedFilesText = t("erasureCleanupFailedFiles", {
        count: it.objectStorageFilesFailed,
      });
      return (
        <View style={styles.row} testID={`erasure-item-${it.auditId}`}>
          <View style={styles.rowHeader}>
            <Text style={styles.rowName} numberOfLines={1}>
              {memberName}
            </Text>
            <View style={styles.badgeRow}>
              {it.autoRetryExhausted ? (
                <View
                  style={[styles.badge, styles.badgeExhausted]}
                  testID={`badge-exhausted-${it.auditId}`}
                >
                  <Text style={styles.badgeTextExhausted}>
                    {t("erasureCleanupExhaustedBadge")}
                  </Text>
                </View>
              ) : null}
              {it.acknowledged ? (
                <View
                  style={[styles.badge, styles.badgeAcknowledged]}
                  testID={`badge-acknowledged-${it.auditId}`}
                >
                  <Text style={styles.badgeTextAcknowledged}>
                    {t("erasureCleanupAcknowledgedBadge")}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
          {it.memberDeleted ? (
            <Text style={styles.rowMetaMuted}>
              {t("erasureCleanupMemberDeleted")}
            </Text>
          ) : null}
          <Text style={styles.rowMeta}>{failedFilesText}</Text>
          <Text style={styles.rowMeta}>
            {t("erasureCleanupAttempts", {
              attempts: it.autoRetryAttempts,
              max: failures.data?.autoRetryMaxAttempts ?? 0,
            })}
          </Text>
          <Text style={styles.rowMeta}>
            {t("erasureCleanupCompletedAt", { when: completedAt })}
          </Text>
          {it.acknowledged && it.acknowledgedBy ? (
            <Text style={styles.rowMetaMuted}>
              {t("erasureCleanupAcknowledgedBy", {
                actor: it.acknowledgedBy,
              })}
            </Text>
          ) : null}
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[
                styles.actionBtn,
                styles.actionRetry,
                isPending && styles.actionDisabled,
              ]}
              disabled={isPending}
              onPress={() => onRetry(it.clubMemberId)}
              testID={`btn-retry-${it.auditId}`}
              accessibilityRole="button"
              accessibilityLabel={t("erasureCleanupRetry")}
            >
              {isPending ? (
                <ActivityIndicator size="small" color={GOLD} />
              ) : (
                <Text style={styles.actionRetryText}>
                  {t("erasureCleanupRetry")}
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.actionBtn,
                styles.actionAck,
                isPending && styles.actionDisabled,
              ]}
              disabled={isPending}
              onPress={() => onAcknowledge(it.clubMemberId)}
              testID={`btn-ack-${it.auditId}`}
              accessibilityRole="button"
              accessibilityLabel={t("erasureCleanupAcknowledge")}
            >
              <Text style={styles.actionAckText}>
                {t("erasureCleanupAcknowledge")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    // pending row
    const it = row.item;
    const isPending = actingPendingId === it.id;
    const lastAttemptLabel = it.lastAttemptAt
      ? new Date(it.lastAttemptAt).toLocaleString(getLocale())
      : t("erasureCleanupPendingNever");
    return (
      <View style={styles.row} testID={`pending-item-${it.id}`}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowName} numberOfLines={1}>
            {[it.memberFirstName, it.memberLastName]
              .filter(Boolean)
              .join(" ") ||
              (it.clubMemberId ? `Member #${it.clubMemberId}` : "—")}
          </Text>
          {it.exhausted ? (
            <View
              style={[styles.badge, styles.badgeExhausted]}
              testID={`pending-badge-exhausted-${it.id}`}
            >
              <Text style={styles.badgeTextExhausted}>
                {t("erasureCleanupPendingExhaustedBadge")}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.rowMetaMono} numberOfLines={2}>
          {it.path}
        </Text>
        <Text style={styles.rowMeta}>
          {t("erasureCleanupPendingAttempts", { attempts: it.attempts })}
        </Text>
        {it.lastError ? (
          <Text style={styles.rowMetaMuted} numberOfLines={3}>
            {t("erasureCleanupPendingLastError", { error: it.lastError })}
          </Text>
        ) : null}
        <Text style={styles.rowMetaMuted}>
          {t("erasureCleanupPendingLastAttempt", { when: lastAttemptLabel })}
        </Text>
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[
              styles.actionBtn,
              styles.actionRetry,
              isPending && styles.actionDisabled,
            ]}
            disabled={isPending}
            onPress={() => onForceRetry(it.id)}
            testID={`btn-pending-retry-${it.id}`}
            accessibilityRole="button"
            accessibilityLabel={t("erasureCleanupPendingForceRetry")}
          >
            {isPending ? (
              <ActivityIndicator size="small" color={GOLD} />
            ) : (
              <Text style={styles.actionRetryText}>
                {t("erasureCleanupPendingForceRetry")}
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.actionBtn,
              styles.actionResolve,
              isPending && styles.actionDisabled,
            ]}
            disabled={isPending}
            onPress={() => onResolve(it.id)}
            testID={`btn-pending-resolve-${it.id}`}
            accessibilityRole="button"
            accessibilityLabel={t("erasureCleanupPendingResolve")}
          >
            <Text style={styles.actionResolveText}>
              {t("erasureCleanupPendingResolve")}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const summaryHeader = (
    <View style={styles.summaryCard} testID="erasure-summary">
      <Text style={styles.summarySubtitle}>
        {t("erasureCleanupSubtitle")}
      </Text>
      {failures.data ? (
        <View style={styles.summaryGrid}>
          <Text style={styles.summaryStat}>
            {t("stuckErasureSummary", { count: failures.data.count })}
          </Text>
          <Text style={styles.summaryStat}>
            {t("erasureCleanupSummaryFiles", {
              count: failures.data.totalFailedFiles,
            })}
          </Text>
          {failures.data.autoRetryExhaustedCount > 0 ? (
            <Text style={[styles.summaryStat, styles.summaryStatWarn]}>
              {t("erasureCleanupSummaryExhausted", {
                count: failures.data.autoRetryExhaustedCount,
              })}
            </Text>
          ) : null}
          {failures.data.acknowledgedCount > 0 ? (
            <Text style={styles.summaryStatMuted}>
              {t("erasureCleanupSummaryAcknowledged", {
                count: failures.data.acknowledgedCount,
              })}
            </Text>
          ) : null}
          {failures.data.pendingStorageDeletions.total > 0 ? (
            <Text style={styles.summaryStat}>
              {t("erasureCleanupSummaryPending", {
                count: failures.data.pendingStorageDeletions.total,
              })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.background }}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t("stuckErasureTitle"),
          headerStyle: { backgroundColor: "#0a0a0a" },
          headerTintColor: "#fff",
          headerTitleStyle: { fontWeight: "700" },
        }}
      />
      <FlatList
        testID="erasure-cleanup-list"
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderItem}
        ListHeaderComponent={summaryHeader}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={refetchAll}
            tintColor={GOLD}
            testID="erasure-cleanup-refresh"
          />
        }
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.loadingWrap} testID="erasure-cleanup-loading">
              <ActivityIndicator size="small" color={GOLD} />
            </View>
          ) : null
        }
      />
      {!orgId || !token ? (
        <View style={styles.unauthorizedOverlay}>
          <Feather name="lock" size={20} color={Colors.muted} />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  listContent: { padding: 16, paddingBottom: 48 },
  summaryCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  summarySubtitle: {
    color: Colors.muted,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
  },
  summaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  summaryStat: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  summaryStatWarn: {
    color: "#fcd34d",
    borderColor: "rgba(251,191,36,0.45)",
    backgroundColor: "rgba(251,191,36,0.12)",
  },
  summaryStatMuted: {
    color: Colors.muted,
    fontSize: 12,
    fontWeight: "500",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sectionLabel: {
    color: Colors.muted,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "700",
    textTransform: "uppercase",
    marginTop: 12,
    marginBottom: 8,
  },
  emptyText: {
    color: Colors.muted,
    fontSize: 13,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  row: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    gap: 4,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rowName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: "700",
    flex: 1,
  },
  badgeRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeExhausted: {
    borderColor: "rgba(252,165,165,0.5)",
    backgroundColor: "rgba(252,165,165,0.12)",
  },
  badgeAcknowledged: {
    borderColor: "rgba(167,243,208,0.5)",
    backgroundColor: "rgba(167,243,208,0.12)",
  },
  badgeTextExhausted: { color: "#fca5a5", fontSize: 10, fontWeight: "700" },
  badgeTextAcknowledged: {
    color: "#a7f3d0",
    fontSize: 10,
    fontWeight: "700",
  },
  rowMeta: { color: Colors.text, fontSize: 12, marginTop: 2 },
  rowMetaMuted: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  rowMetaMono: {
    color: Colors.text,
    fontSize: 12,
    marginTop: 2,
    fontFamily: "Inter_500Medium",
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    flexWrap: "wrap",
  },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 120,
    alignItems: "center",
  },
  actionRetry: {
    borderColor: "rgba(251,191,36,0.45)",
    backgroundColor: "rgba(251,191,36,0.06)",
  },
  actionAck: {
    borderColor: Colors.border,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  actionResolve: {
    borderColor: "rgba(252,165,165,0.45)",
    backgroundColor: "rgba(252,165,165,0.08)",
  },
  actionDisabled: { opacity: 0.5 },
  actionRetryText: { color: "#fcd34d", fontSize: 12, fontWeight: "700" },
  actionAckText: { color: Colors.text, fontSize: 12, fontWeight: "700" },
  actionResolveText: { color: "#fca5a5", fontSize: 12, fontWeight: "700" },
  loadingWrap: { paddingVertical: 24, alignItems: "center" },
  unauthorizedOverlay: {
    position: "absolute",
    inset: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
});
