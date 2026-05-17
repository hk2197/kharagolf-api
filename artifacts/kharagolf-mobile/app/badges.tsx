import React, { useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Share, Alert } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useAuth } from "@/context/auth";
import { getLocale } from "@/i18n";
import Colors from "@/constants/colors";
import { authedFetch, BASE_URL } from "./my-360/_shared";

const PUBLIC_PROFILE_BASE = "https://kharagolf.com";

// Task #926 — fire a single share-tracking event so admins can see which
// badges drive the most viral traffic. Best-effort: never blocks the share
// flow if the analytics POST fails.
function trackBadgeShareMobile(handle: string, badgeType: string, method: "copy" | "web_share" | "native_share") {
  try {
    void fetch(`${BASE_URL}/api/public/p/${encodeURIComponent(handle)}/badge/${encodeURIComponent(badgeType)}/share-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, source: "mobile" }),
    }).catch(() => { /* analytics only */ });
  } catch { /* ignore */ }
}

interface CatalogBadge {
  type: string;
  label: string;
  icon: string;
  category: string;
  description: string;
  unlocked: boolean;
  earnedAt: string | null;
  progress: { current: number; target: number } | null;
}

interface MyBadgesResponse {
  badges: CatalogBadge[];
  unlockedCount: number;
  totalCount: number;
  publicHandle: string | null;
  canShare: boolean;
}

// Task #1095 — per-badge share-count response from
// GET /api/portal/me/badge-share-stats
interface BadgeShareStatsResponse {
  total: number;
  badges: Array<{ badgeType: string; total: number }>;
}

// Task #1441 — locale-aware integer formatting for the small counts shown
// throughout the screen ("X of Y", "Shared N times", progress totals). Uses
// the player's selected i18n locale so e.g. Arabic players see Arabic-Indic
// digits when their locale supplies them.
function fmtNum(n: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(n);
  } catch {
    return String(n);
  }
}

export default function BadgesScreen() {
  const { t, i18n } = useTranslation("profile");
  const locale = getLocale(i18n.language);
  const { token } = useAuth();
  const [data, setData] = useState<MyBadgesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Task #1095 — per-badge share counts shown under each unlocked badge.
  // Best-effort: failure here does not block badge rendering.
  const [shareCounts, setShareCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    // Task #1752 — pass the player's selected i18n language so the API
    // returns badge `label`/`description` strings already translated for
    // the active locale instead of always-English copy.
    const langParam = i18n.language ? `?lang=${encodeURIComponent(i18n.language)}` : "";
    authedFetch<MyBadgesResponse>(`/api/portal/my-badges${langParam}`, token)
      .then(setData)
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [token, i18n.language]);

  useEffect(() => {
    if (!token) return;
    authedFetch<BadgeShareStatsResponse>("/api/portal/me/badge-share-stats", token)
      .then(stats => {
        const map: Record<string, number> = {};
        for (const b of stats?.badges ?? []) {
          if (b && typeof b.badgeType === "string" && typeof b.total === "number") {
            map[b.badgeType] = b.total;
          }
        }
        setShareCounts(map);
      })
      .catch(() => { /* best-effort — analytics indicator only */ });
  }, [token]);

  const grouped = useMemo(() => {
    const m = new Map<string, CatalogBadge[]>();
    if (!data) return m;
    for (const b of data.badges) {
      if (!m.has(b.category)) m.set(b.category, []);
      m.get(b.category)!.push(b);
    }
    return m;
  }, [data]);

  const screenTitle = t("badges.title");

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: screenTitle }} />
        <LoadingSpinner color={Colors.primary} />
      </View>
    );
  }
  if (error || !data) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: screenTitle }} />
        <Text style={styles.errorText}>{error ?? t("badges.signInToView")}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
    >
      <Stack.Screen options={{ title: screenTitle }} />

      <View style={styles.summaryCard}>
        <Feather name="award" size={20} color={Colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.summaryTitle}>{t("badges.progressTitle")}</Text>
          <Text style={styles.summarySub} testID="badges-progress">
            {t("badges.progressSummary", {
              unlocked: fmtNum(data.unlockedCount, locale),
              total: fmtNum(data.totalCount, locale),
            })}
          </Text>
        </View>
      </View>

      {[...grouped.entries()].map(([category, badges]) => (
        <View key={category} style={{ marginTop: 18 }}>
          <Text style={styles.sectionHeader}>
            {t(`badges.categories.${category}`, { defaultValue: category })}
          </Text>
          {badges.map(b => (
            <View
              key={b.type}
              testID={`badge-${b.type}`}
              style={[styles.badgeRow, !b.unlocked && styles.badgeRowLocked]}
            >
              <View style={[styles.iconWrap, !b.unlocked && styles.iconWrapLocked]}>
                <Text style={[styles.iconText, !b.unlocked && styles.iconTextLocked]}>{b.icon}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.badgeTitleRow}>
                  <Text style={[styles.badgeLabel, !b.unlocked && styles.badgeLabelLocked]} numberOfLines={1}>
                    {b.label}
                  </Text>
                  {b.unlocked ? (
                    <View style={styles.unlockedPill}>
                      <Feather name="check" size={10} color="#22c55e" />
                      <Text style={styles.unlockedPillText}>{t("badges.unlocked")}</Text>
                    </View>
                  ) : (
                    <View style={styles.lockedPill}>
                      <Feather name="lock" size={10} color={Colors.tabIconDefault} />
                      <Text style={styles.lockedPillText}>{t("badges.locked")}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.badgeDesc}>{b.description}</Text>
                {b.unlocked && b.earnedAt && (
                  <Text style={styles.earnedText}>
                    {t("badges.earnedOn", {
                      date: new Date(b.earnedAt).toLocaleDateString(locale, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      }),
                    })}
                  </Text>
                )}
                {b.unlocked && (() => {
                  const n = shareCounts[b.type] ?? 0;
                  // Hide the indicator entirely when this badge has never
                  // been shared — "Shared 0 times" is noisy social proof.
                  if (n <= 0) return null;
                  return (
                    <Text style={styles.shareCountText} testID={`badge-share-count-${b.type}`}>
                      {t("badges.shareCount", { count: n })}
                    </Text>
                  );
                })()}
                {data.canShare && data.publicHandle && (
                  <Pressable
                    testID={`badge-share-${b.type}`}
                    onPress={() => shareBadgeMobile(data.publicHandle!, b, t, i18n.language)}
                    style={({ pressed }) => [styles.shareBtn, pressed && { opacity: 0.7 }]}
                    accessibilityLabel={
                      b.unlocked
                        ? t("badges.shareBadgeA11y", { label: b.label })
                        : t("badges.shareProgressA11y", { label: b.label })
                    }
                  >
                    <Feather name="share-2" size={11} color={Colors.primary} />
                    <Text style={styles.shareBtnText}>
                      {b.unlocked ? t("badges.shareBadge") : t("badges.shareProgress")}
                    </Text>
                  </Pressable>
                )}
                {!b.unlocked && b.progress && b.progress.target > 0 && (() => {
                  const shown = Math.min(b.progress.current, b.progress.target);
                  const pct = Math.max(0, Math.min(100, Math.round((b.progress.current / b.progress.target) * 100)));
                  return (
                    <View style={styles.progressWrap} testID={`badge-progress-${b.type}`}>
                      <Text style={styles.progressText}>
                        {t("badges.progressOf", {
                          current: fmtNum(shown, locale),
                          target: fmtNum(b.progress.target, locale),
                        })}
                      </Text>
                      <View style={styles.progressTrack}>
                        <View style={[styles.progressFill, { width: `${pct}%` }]} />
                      </View>
                    </View>
                  );
                })()}
              </View>
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  errorText: { color: "#f87171", padding: 16, textAlign: "center" },
  summaryCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: Colors.surface, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: Colors.border,
  },
  summaryTitle: { color: "#fff", fontSize: 14, fontWeight: "700" },
  summarySub: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 2 },
  sectionHeader: {
    color: Colors.tabIconDefault, fontSize: 11, fontWeight: "700",
    letterSpacing: 1, textTransform: "uppercase", marginBottom: 8, marginLeft: 2,
  },
  badgeRow: {
    flexDirection: "row", gap: 12, backgroundColor: Colors.surface,
    borderRadius: 12, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: Colors.border,
  },
  badgeRowLocked: { opacity: 0.7 },
  iconWrap: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: `${Colors.primary}20`,
    alignItems: "center", justifyContent: "center",
  },
  iconWrapLocked: { backgroundColor: "#3a3a3a40" },
  iconText: { fontSize: 20 },
  iconTextLocked: { opacity: 0.5 },
  badgeTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  badgeLabel: { color: "#fff", fontSize: 14, fontWeight: "700", flexShrink: 1 },
  badgeLabelLocked: { color: "#cbd5e1" },
  badgeDesc: { color: "#cbd5e1", fontSize: 12, marginTop: 4 },
  earnedText: { color: "#22c55e", fontSize: 11, marginTop: 4 },
  shareCountText: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 },
  unlockedPill: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: "#16653440", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
  },
  unlockedPillText: { color: "#22c55e", fontSize: 10, fontWeight: "700" },
  lockedPill: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: "#3a3a3a40", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
  },
  lockedPillText: { color: Colors.tabIconDefault, fontSize: 10, fontWeight: "700" },
  progressWrap: { marginTop: 6 },
  progressText: { color: "#cbd5e1", fontSize: 11, marginBottom: 3 },
  progressTrack: {
    height: 4, borderRadius: 2, backgroundColor: "#3a3a3a", overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: Colors.primary },
  shareBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    alignSelf: "flex-start", marginTop: 8,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 6, borderWidth: 1, borderColor: `${Colors.primary}66`,
  },
  shareBtnText: { color: Colors.primary, fontSize: 11, fontWeight: "700" },
});

async function shareBadgeMobile(
  handle: string,
  badge: CatalogBadge,
  t: TFunction,
  // Task #1442 — sender's UI language. Appended to the public badge URL as
  // `?lang=` so the destination web page (and the OG image rendered for the
  // link preview) match the language of the share message we're about to
  // send. Falls back gracefully if the language is "en" — we only add the
  // query when it's actually informative, to keep canonical share URLs clean.
  lang?: string,
): Promise<void> {
  const langQ = lang && lang !== "en" ? `?lang=${encodeURIComponent(lang.split(/[-_]/)[0]!)}` : "";
  const url = `${PUBLIC_PROFILE_BASE}/p/${handle}/badge/${encodeURIComponent(badge.type)}${langQ}`;
  let message: string;
  if (badge.unlocked) {
    message = t("badges.shareMessageUnlocked", { label: badge.label, icon: badge.icon, url });
  } else if (badge.progress && badge.progress.target > 0) {
    const current = Math.min(badge.progress.current, badge.progress.target);
    message = t("badges.shareMessageLockedProgress", {
      label: badge.label,
      icon: badge.icon,
      current,
      target: badge.progress.target,
      url,
    });
  } else {
    message = t("badges.shareMessageLocked", { label: badge.label, icon: badge.icon, url });
  }
  try {
    const result = await Share.share({
      title: t("badges.shareTitle", { label: badge.label, handle }),
      message,
      url,
    });
    // Task #926 — only track when the user actually went through with the
    // native share sheet. React Native's Share.share resolves with
    // action="sharedAction" when shared, "dismissedAction" on cancel (iOS).
    if (result.action === Share.sharedAction) {
      trackBadgeShareMobile(handle, badge.type, "native_share");
    }
  } catch {
    Alert.alert(t("badges.shareFailedTitle"), t("badges.shareFailedMessage"));
  }
}
