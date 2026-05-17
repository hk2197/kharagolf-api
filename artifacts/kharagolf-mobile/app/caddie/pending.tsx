/**
 * Pending AI Caddie recommendations (Task #768).
 *
 * Lists every recommendation the player has not yet resolved (accepted or
 * overridden). Each row offers quick actions to confirm the AI's pick,
 * override with a different club, and optionally record the outcome
 * proximity-to-pin so the personalisation engine has more signal.
 *
 * Uses the new GET /api/portal/caddie/feedback/pending and posts back to
 * the existing POST /api/portal/caddie/feedback.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { translateLieType } from "@/i18n/lieType";
import { formatRelativeTime } from "@/i18n/relativeTime";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

const CLUB_OPTIONS = [
  "Driver", "3 Wood", "5 Wood", "4 Hybrid",
  "4 Iron", "5 Iron", "6 Iron", "7 Iron", "8 Iron", "9 Iron",
  "Pitching Wedge", "Gap Wedge", "Sand Wedge", "Lob Wedge", "Putter",
];

interface PendingItem {
  id: number;
  holeNumber: number;
  round: number;
  distanceYards: number | null;
  effectiveYards: number | null;
  recommendedClub: string | null;
  alternateClub: string | null;
  lieType: string | null;
  recordedAt: string;
}

export default function CaddiePendingScreen() {
  const { token } = useAuth();
  const { t } = useTranslation("profile");
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [overridePicker, setOverridePicker] = useState<PendingItem | null>(null);
  const [outcomeFor, setOutcomeFor] = useState<{ item: PendingItem; chosenClub: string; accepted: boolean } | null>(null);
  const [outcomeYds, setOutcomeYds] = useState("");

  // Task #2059 — defer to the shared `formatRelativeTime` helper so this
  // label uses Intl.RelativeTimeFormat, which has every CLDR plural
  // bucket (zero/one/two/few/many/other) baked in. The previous
  // `caddiePending.{seconds,minutes,hours,days}Ago` JSON keys only had
  // `_one`/`_other` plurals, which leaked English copy into Arabic
  // counts 2..10 — the exact regression Task #1659 fixed for the
  // committee case detail screen.
  const formatTimeAgo = useCallback((iso: string): string => {
    return formatRelativeTime(iso);
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setError(null);
      const res = await fetch(`${BASE_URL}/api/portal/caddie/feedback/pending`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 403) {
        setError(t("caddiePending.errorAiOff"));
        setItems([]);
        return;
      }
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      setError(t("caddiePending.errorLoad"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, t]);

  useEffect(() => { load(); }, [load]);

  async function submitFeedback(item: PendingItem, chosenClub: string, accepted: boolean, outcomeDistanceToPin?: number) {
    if (!token) return;
    setSavingId(item.id);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/caddie/feedback`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          recommendationId: item.id,
          chosenClub,
          accepted,
          ...(outcomeDistanceToPin != null && Number.isFinite(outcomeDistanceToPin)
            ? { outcomeDistanceToPin }
            : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        Alert.alert(t("caddiePending.saveErrorTitle"), body?.error ?? t("caddiePending.saveErrorDefault"));
        return;
      }
      // Optimistic remove from list
      setItems(prev => prev.filter(i => i.id !== item.id));
    } catch {
      Alert.alert(t("caddiePending.saveErrorTitle"), t("caddiePending.saveErrorNetwork"));
    } finally {
      setSavingId(null);
    }
  }

  function onConfirmRecommended(item: PendingItem) {
    if (!item.recommendedClub) return;
    setOutcomeFor({ item, chosenClub: item.recommendedClub, accepted: true });
    setOutcomeYds("");
  }

  function onOverride(item: PendingItem) {
    setOverridePicker(item);
  }

  function onPickOverride(club: string) {
    const item = overridePicker;
    setOverridePicker(null);
    if (!item) return;
    setOutcomeFor({ item, chosenClub: club, accepted: false });
    setOutcomeYds("");
  }

  function commitOutcome(skipDistance: boolean) {
    const ctx = outcomeFor;
    if (!ctx) return;
    let distance: number | undefined = undefined;
    if (!skipDistance) {
      const trimmed = outcomeYds.trim();
      if (trimmed.length > 0) {
        const n = parseFloat(trimmed);
        if (!Number.isFinite(n) || n < 0 || n > 400) {
          Alert.alert(
            t("caddiePending.invalidDistanceTitle"),
            t("caddiePending.invalidDistanceMsg"),
          );
          return;
        }
        distance = n;
      }
    }
    setOutcomeFor(null);
    submitFeedback(ctx.item, ctx.chosenClub, ctx.accepted, distance);
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={10}>
          <Feather name="arrow-left" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{t("caddiePending.title")}</Text>
          <Text style={styles.subtitle}>{t("caddiePending.subtitle")}</Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}><LoadingSpinner color={Colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}><Text style={styles.errorText}>{error}</Text></View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Feather name="check-circle" size={36} color={Colors.primary} />
          <Text style={styles.emptyTitle}>{t("caddiePending.emptyTitle")}</Text>
          <Text style={styles.emptyText}>{t("caddiePending.emptyText")}</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={Colors.primary}
            />
          }
        >
          {items.map(item => {
            const isSaving = savingId === item.id;
            const dist = item.distanceYards != null ? Math.round(item.distanceYards) : null;
            const eff = item.effectiveYards != null ? Math.round(item.effectiveYards) : null;
            return (
              <View key={item.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.holeBadge}>
                    <Text style={styles.holeBadgeText}>#{item.holeNumber}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle}>
                      {dist != null ? t("caddiePending.yards", { count: dist }) : "—"}
                      {eff != null && eff !== dist ? `  ·  ${t("caddiePending.playsYards", { count: eff })}` : ""}
                    </Text>
                    <Text style={styles.cardMeta}>
                      {t("caddiePending.round", { count: item.round })}
                      {item.lieType ? `  ·  ${translateLieType(t, item.lieType)}` : ""}
                      {`  ·  ${formatTimeAgo(item.recordedAt)}`}
                    </Text>
                  </View>
                </View>

                {item.recommendedClub ? (
                  <View style={styles.recRow}>
                    <Feather name="cpu" size={14} color={Colors.primary} />
                    <Text style={styles.recText}>
                      {t("caddiePending.aiSuggested", { club: item.recommendedClub })}
                      {item.alternateClub ? ` ${t("caddiePending.altClub", { club: item.alternateClub })}` : ""}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.recText}>{t("caddiePending.noRecommendation")}</Text>
                )}

                <View style={styles.actions}>
                  {item.recommendedClub && (
                    <TouchableOpacity
                      style={[styles.btn, styles.btnPrimary]}
                      onPress={() => onConfirmRecommended(item)}
                      disabled={isSaving}
                    >
                      <Feather name="check" size={14} color="#0a0a0a" />
                      <Text style={styles.btnPrimaryText}>{t("caddiePending.iHitThe", { club: item.recommendedClub })}</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={[styles.btn, styles.btnSecondary]}
                    onPress={() => onOverride(item)}
                    disabled={isSaving}
                  >
                    <Feather name="repeat" size={14} color="#fff" />
                    <Text style={styles.btnSecondaryText}>{t("caddiePending.iHitDifferent")}</Text>
                  </TouchableOpacity>
                </View>
                {isSaving && (
                  <View style={{ marginTop: 8, alignItems: "center" }}>
                    <LoadingSpinner color={Colors.primary} size="small" />
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Override club picker */}
      <Modal
        visible={overridePicker != null}
        transparent
        animationType="slide"
        onRequestClose={() => setOverridePicker(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setOverridePicker(null)}>
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{t("caddiePending.whichClubTitle")}</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {CLUB_OPTIONS.map(c => (
                <TouchableOpacity key={c} style={styles.clubRow} onPress={() => onPickOverride(c)}>
                  <Text style={styles.clubRowText}>{c}</Text>
                  {overridePicker?.recommendedClub === c && (
                    <Text style={styles.clubRowHint}>{t("caddiePending.aiPickHint")}</Text>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={[styles.btn, styles.btnGhost, { marginTop: 10 }]} onPress={() => setOverridePicker(null)}>
              <Text style={styles.btnGhostText}>{t("caddiePending.cancel")}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Outcome distance prompt */}
      <Modal
        visible={outcomeFor != null}
        transparent
        animationType="fade"
        onRequestClose={() => setOutcomeFor(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setOutcomeFor(null)}>
          <Pressable style={[styles.modalSheet, { paddingBottom: 16 }]} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{t("caddiePending.outcomeTitle")}</Text>
            <Text style={styles.modalHint}>
              {t("caddiePending.outcomeHint")}
            </Text>
            <TextInput
              value={outcomeYds}
              onChangeText={setOutcomeYds}
              placeholder={t("caddiePending.outcomePlaceholder")}
              placeholderTextColor={Colors.tabIconDefault}
              keyboardType="numeric"
              style={styles.input}
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity style={[styles.btn, styles.btnGhost, { flex: 1 }]} onPress={() => commitOutcome(true)}>
                <Text style={styles.btnGhostText}>{t("caddiePending.skip")}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.btnPrimary, { flex: 1 }]} onPress={() => commitOutcome(false)}>
                <Text style={styles.btnPrimaryText}>{t("caddiePending.save")}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: { padding: 4, marginTop: 2 },
  title: { color: "#fff", fontSize: 18, fontWeight: "800" },
  subtitle: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  errorText: { color: Colors.tabIconDefault, fontSize: 13, textAlign: "center" },
  emptyTitle: { color: "#fff", fontSize: 16, fontWeight: "700", marginTop: 12 },
  emptyText: { color: Colors.tabIconDefault, fontSize: 13, marginTop: 4, textAlign: "center" },
  list: { padding: 16, paddingBottom: 32 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 },
  holeBadge: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: `${Colors.primary}20`,
    borderWidth: 1, borderColor: `${Colors.primary}55`,
    alignItems: "center", justifyContent: "center",
  },
  holeBadgeText: { color: Colors.primary, fontSize: 13, fontWeight: "800" },
  cardTitle: { color: "#fff", fontSize: 15, fontWeight: "700" },
  cardMeta: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2, textTransform: "capitalize" },
  recRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 },
  recText: { color: Colors.tabIconDefault, fontSize: 13, flex: 1 },
  recClub: { color: "#fff", fontWeight: "700" },
  actions: { gap: 8 },
  btn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, gap: 6,
  },
  btnPrimary: { backgroundColor: Colors.primary },
  btnPrimaryText: { color: "#0a0a0a", fontWeight: "800", fontSize: 13 },
  btnSecondary: { backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border },
  btnSecondaryText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: Colors.border },
  btnGhostText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: 16,
    borderTopWidth: 1, borderColor: Colors.border,
  },
  modalTitle: { color: "#fff", fontSize: 16, fontWeight: "800", marginBottom: 6 },
  modalHint: { color: Colors.tabIconDefault, fontSize: 12, marginBottom: 10 },
  clubRow: {
    paddingVertical: 12, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: `${Colors.border}80`,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  clubRowText: { color: "#fff", fontSize: 14 },
  clubRowHint: { color: Colors.primary, fontSize: 11, fontWeight: "700" },
  input: {
    backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
    borderRadius: 10, padding: 12,
    color: "#fff", fontSize: 16,
    marginBottom: 10,
  },
});
