import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  RefreshControl,
  Image,
  LayoutAnimation,
  UIManager,
  Platform,
  ActionSheetIOS,
  Modal,
  FlatList,
  Dimensions,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { router } from "expo-router";
import { Feather, Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { SvgXml } from "react-native-svg";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import { useTheme } from "@/theme";
import Colors from "@/constants/colors";
import { AVATAR_PRESETS, isPresetAvatar, getPresetId, PRESET_MAP } from "@/constants/avatarPresets";
import { CurrencyPicker } from "@/components/CurrencyPicker";
import { PriceWithFx } from "@/components/PriceWithFx";
import { LockerRenewalCard } from "@/components/LockerRenewalCard";
import { CaddieInsightsSection } from "@/components/CaddieInsightsSection";
import { LoyaltySection } from "@/components/LoyaltySection";
import { InvoicesSection } from "@/components/InvoicesSection";
import { RepairJobsSection } from "@/components/RepairJobsSection";
import { FittingSessionsSection } from "@/components/FittingSessionsSection";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES, applyLanguage, getLocale, type SupportedLanguage } from "@/i18n";
import {
  isAppleHealthSupported,
  syncAppleHealthLast7Days,
} from "@/utils/appleHealth";
import {
  isHealthConnectSupported,
  syncHealthConnectLast7Days,
} from "@/utils/healthConnect";

if (Platform.OS === "android") {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

interface Stats {
  tournamentsPlayed: number;
  totalScores: number;
  averageStrokes: number | null;
  bestRound: number | null;
  hcpTrend?: { handicapIndex: number; recordedAt: string | null }[];
}

interface TournamentRow {
  playerId: number;
  tournamentId: number;
  tournamentName: string;
  tournamentStatus: string;
  startDate: string | null;
  paymentStatus: string;
  checkedIn: boolean;
}

interface ScoreEntry {
  id: number;
  holeNumber: number;
  round: number;
  strokes: number;
  putts?: number | null;
  fairwayHit?: boolean | null;
  girHit?: boolean | null;
}

interface ScoreHistoryData {
  player: {
    id: number;
    firstName: string;
    lastName: string;
    handicapIndex: string | null;
    teeBox: string | null;
    currentRound: number;
  };
  tournament: {
    name: string;
    format: string;
    rounds: number;
  };
  scores: ScoreEntry[];
}

function groupScoresByRound(scores: ScoreEntry[]): Map<number, ScoreEntry[]> {
  const map = new Map<number, ScoreEntry[]>();
  for (const s of scores) {
    if (!map.has(s.round)) map.set(s.round, []);
    map.get(s.round)!.push(s);
  }
  // Sort holes within each round
  for (const [, holes] of map) {
    holes.sort((a, b) => a.holeNumber - b.holeNumber);
  }
  return map;
}

function RoundCard({ round, holes }: { round: number; holes: ScoreEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation("profile");
  const total = holes.reduce((sum, h) => sum + h.strokes, 0);

  function toggle() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(v => !v);
  }

  return (
    <View style={roundStyles.container}>
      <TouchableOpacity onPress={toggle} style={roundStyles.header} activeOpacity={0.7}>
        <View style={roundStyles.headerLeft}>
          <Text style={roundStyles.roundLabel}>{t("roundCard.round", { n: round })}</Text>
          <Text style={roundStyles.holesCount}>{t("roundCard.holes", { count: holes.length })}</Text>
        </View>
        <View style={roundStyles.headerRight}>
          <Text style={roundStyles.totalScore}>{total}</Text>
          <Text style={roundStyles.totalLabel}>{t("roundCard.strokes")}</Text>
          <Feather name={expanded ? "chevron-up" : "chevron-down"} size={16} color={Colors.tabIconDefault} />
        </View>
      </TouchableOpacity>
      {expanded && (
        <View style={roundStyles.holesGrid}>
          <View style={roundStyles.gridHeader}>
            <Text style={[roundStyles.gridCell, roundStyles.gridHeaderText, { flex: 1 }]}>{t("roundTable.hole")}</Text>
            <Text style={[roundStyles.gridCell, roundStyles.gridHeaderText, { flex: 1, textAlign: "center" }]}>{t("roundTable.strokes")}</Text>
            <Text style={[roundStyles.gridCell, roundStyles.gridHeaderText, { flex: 1, textAlign: "center" }]}>{t("roundTable.putts")}</Text>
            <Text style={[roundStyles.gridCell, roundStyles.gridHeaderText, { flex: 1, textAlign: "center" }]}>{t("roundTable.fir")}</Text>
            <Text style={[roundStyles.gridCell, roundStyles.gridHeaderText, { flex: 1, textAlign: "center" }]}>{t("roundTable.gir")}</Text>
          </View>
          {holes.map((h) => (
            <View key={h.id} style={roundStyles.gridRow}>
              <Text style={[roundStyles.gridCell, { flex: 1 }]}>#{h.holeNumber}</Text>
              <Text style={[roundStyles.gridCell, roundStyles.strokeCell, { flex: 1, textAlign: "center" }]}>{h.strokes}</Text>
              <Text style={[roundStyles.gridCell, { flex: 1, textAlign: "center" }]}>{h.putts ?? "—"}</Text>
              <Text style={[roundStyles.gridCell, { flex: 1, textAlign: "center" }]}>
                {h.fairwayHit == null ? "—" : h.fairwayHit ? "✓" : "✗"}
              </Text>
              <Text style={[roundStyles.gridCell, { flex: 1, textAlign: "center" }]}>
                {h.girHit == null ? "—" : h.girHit ? "✓" : "✗"}
              </Text>
            </View>
          ))}
          <View style={roundStyles.totalRow}>
            <Text style={[roundStyles.gridCell, { flex: 1, color: Colors.textSecondary, fontWeight: "700" }]}>{t("roundTable.total")}</Text>
            <Text style={[roundStyles.gridCell, { flex: 1, textAlign: "center", color: Colors.primary, fontWeight: "800" }]}>{total}</Text>
            <Text style={[roundStyles.gridCell, { flex: 3, textAlign: "center" }]} />
          </View>
        </View>
      )}
    </View>
  );
}

const roundStyles = StyleSheet.create({
  container: { backgroundColor: `${Colors.primary}10`, borderRadius: 10, marginBottom: 8, overflow: "hidden", borderWidth: 1, borderColor: `${Colors.primary}30` },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12 },
  headerLeft: { flex: 1 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  roundLabel: { fontSize: 13, fontWeight: "700", color: "#fff" },
  holesCount: { fontSize: 11, color: Colors.tabIconDefault, marginTop: 1 },
  totalScore: { fontSize: 22, fontWeight: "900", color: Colors.primary },
  totalLabel: { fontSize: 11, color: Colors.tabIconDefault },
  holesGrid: { paddingHorizontal: 12, paddingBottom: 12 },
  gridHeader: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: Colors.border, paddingBottom: 6, marginBottom: 4 },
  gridHeaderText: { fontSize: 10, fontWeight: "700", color: Colors.tabIconDefault, textTransform: "uppercase", letterSpacing: 0.5 },
  gridRow: { flexDirection: "row", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: `${Colors.border}60` },
  totalRow: { flexDirection: "row", paddingVertical: 7, marginTop: 4 },
  gridCell: { fontSize: 13, color: "#fff" },
  strokeCell: { fontWeight: "700" },
});

interface RankingHistoryEntry {
  id: number;
  seriesId: number;
  seriesName: string | null;
  seriesLevel: string | null;
  seriesStatus: string | null;
  seasonStart: string | null;
  seasonEnd: string | null;
  category: string;
  totalPoints: number;
  eventsPlayed: number;
  wins: number;
  runnerUps: number;
  top3: number;
  position: number | null;
  history: {
    id: number;
    tournamentId: number;
    tournamentName: string | null;
    tournamentDate: string | null;
    position: number;
    pointsAwarded: number;
    awardedAt: string;
  }[];
}

export default function ProfileTab() {
  const { user, token, logout, isAuthenticated, isLoading: authLoading, refreshUser } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [tournaments, setTournaments] = useState<TournamentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedTournament, setExpandedTournament] = useState<number | null>(null);
  const [scoreHistories, setScoreHistories] = useState<Record<number, ScoreHistoryData | "loading" | "error">>({});
  const [withdrawingTournament, setWithdrawingTournament] = useState<number | null>(null);
  const [notifPrefs, setNotifPrefs] = useState({ preferEmail: true, preferPush: true, preferSms: false, preferWhatsapp: false, notifyMemberDocuments: true, notifyCommitteePeerDigest: true });
  const [notifCapabilities, setNotifCapabilities] = useState({ hasPhone: false, hasPushToken: false, isCommitteeMember: false });
  const [savingPref, setSavingPref] = useState(false);
  // Recovery & wellness — connected providers, daily snapshot, consents
  const [wellnessConsents, setWellnessConsents] = useState<Array<{ scope: string; granted: boolean }>>([]);
  const [wellnessConnections, setWellnessConnections] = useState<Array<{ provider: string; status: string }>>([]);
  type WellnessDay = { metricDate: string; readinessScore: number | null; sleepMinutes: number | null; sleepScore: number | null; hrvMs: number | null; restingHr: number | null; steps: number | null; sources: string[] };
  const [wellnessToday, setWellnessToday] = useState<WellnessDay | null>(null);
  const [wellnessSeries, setWellnessSeries] = useState<WellnessDay[]>([]);
  const [wellnessBusy, setWellnessBusy] = useState<string | null>(null);

  const loadWellness = useCallback(async () => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const [todayRes, dailyRes, consentRes, connRes] = await Promise.all([
        fetch(`${BASE_URL}/api/portal/wellness/today`, { headers }),
        fetch(`${BASE_URL}/api/portal/wellness/daily?days=7`, { headers }),
        fetch(`${BASE_URL}/api/portal/wellness/consent`, { headers }),
        fetch(`${BASE_URL}/api/portal/wearable-connections`, { headers }),
      ]);
      if (todayRes.ok) {
        const j = await todayRes.json();
        setWellnessToday(j.today ?? null);
      }
      if (dailyRes.ok) {
        const j = await dailyRes.json();
        setWellnessSeries((j.series ?? []) as WellnessDay[]);
      }
      if (consentRes.ok) {
        const j = await consentRes.json();
        setWellnessConsents(j.consents ?? []);
      }
      if (connRes.ok) {
        const j = await connRes.json();
        setWellnessConnections(j.connections ?? j ?? []);
      }
    } catch { /* network — leave previous state */ }
  }, [token]);

  useEffect(() => { loadWellness(); }, [loadWellness]);

  // On launch (and whenever the auth token changes) push the latest 7 days
  // from Apple Health to the wellness store, but only after the user has
  // already opted in by tapping "Connect" once — otherwise we'd trigger the
  // HealthKit consent prompt on every cold start.
  useEffect(() => {
    if (!token) return;
    if (!isAppleHealthSupported()) return;
    const alreadyConnected = wellnessConnections.some(c => c.provider === "apple_health" && c.status === "connected");
    if (!alreadyConnected) return;
    syncAppleHealthLast7Days(token).then(r => {
      if (r.daysWritten > 0) loadWellness();
    }).catch(() => {});
  }, [token, wellnessConnections, loadWellness]);

  // Mirror of the Apple Health auto-sync above, but for Android via Health
  // Connect. Same trigger contract — only fire after the user has explicitly
  // tapped "Connect" once, otherwise we'd surface the system permission
  // sheet on every cold start.
  useEffect(() => {
    if (!token) return;
    if (!isHealthConnectSupported()) return;
    const alreadyConnected = wellnessConnections.some(c => c.provider === "health_connect" && c.status === "connected");
    if (!alreadyConnected) return;
    syncHealthConnectLast7Days(token).then(r => {
      if (r.daysWritten > 0) loadWellness();
    }).catch(() => {});
  }, [token, wellnessConnections, loadWellness]);

  async function setWellnessConsent(scope: string, granted: boolean) {
    if (!token) return;
    setWellnessBusy(`consent:${scope}`);
    try {
      await fetch(`${BASE_URL}/api/portal/wellness/consent`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ scope, granted }),
      });
      setWellnessConsents(prev => {
        const next = prev.filter(p => p.scope !== scope);
        next.push({ scope, granted });
        return next;
      });
    } finally { setWellnessBusy(null); }
  }

  async function disconnectWellnessProvider(provider: string) {
    if (!token) return;
    setWellnessBusy(`disconnect:${provider}`);
    try {
      await fetch(`${BASE_URL}/api/portal/wellness/disconnect/${provider}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await loadWellness();
    } finally { setWellnessBusy(null); }
  }

  async function connectWellnessProvider(provider: "whoop" | "google_fit") {
    if (!token) return;
    setWellnessBusy(`connect:${provider}`);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/wearables/${provider}/init`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? `Failed to start ${provider} connection`);
        return;
      }
      const data = await res.json();
      // Defer to deep linking via Linking.openURL — react-native global.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Linking = require("react-native").Linking;
      Linking.openURL(data.url);
    } finally { setWellnessBusy(null); }
  }

  // Apple Health (iOS HealthKit) — request consent & push the last 7 days
  // straight to the wellness store. No OAuth round-trip required: the system
  // sheet handles authorisation in-process.
  async function connectAppleHealth() {
    if (!token) return;
    if (!isAppleHealthSupported()) {
      Alert.alert("Apple Health", "Apple Health is only available on iPhone with the KHARAGOLF native build.");
      return;
    }
    setWellnessBusy("connect:apple_health");
    try {
      const result = await syncAppleHealthLast7Days(token);
      if (result.daysWritten > 0) {
        Alert.alert("Apple Health connected", `Synced ${result.daysWritten} day${result.daysWritten === 1 ? "" : "s"} of recovery data.`);
        await loadWellness();
      } else {
        Alert.alert(
          "Apple Health",
          "No readings were available. Open the Health app to confirm KHARAGOLF has read access for sleep, HRV, resting heart rate and steps, then try again.",
        );
      }
    } finally { setWellnessBusy(null); }
  }

  // Health Connect (Android) — Google's unified health graph. Mirrors the
  // Apple Health flow above: triggers the system consent sheet, reads the
  // last 7 days, and posts each day to the wellness store with
  // `source: "google_fit"`. Tagging the connection itself as
  // `health_connect` keeps the badge distinct from the OAuth-based Google
  // Fit row.
  async function connectHealthConnect() {
    if (!token) return;
    if (!isHealthConnectSupported()) {
      Alert.alert("Health Connect", "Health Connect is only available on Android with the KHARAGOLF native build. Install or update the Health Connect app from the Play Store.");
      return;
    }
    setWellnessBusy("connect:health_connect");
    try {
      const result = await syncHealthConnectLast7Days(token);
      if (result.daysWritten > 0) {
        Alert.alert("Health Connect connected", `Synced ${result.daysWritten} day${result.daysWritten === 1 ? "" : "s"} of recovery data.`);
        await loadWellness();
      } else {
        Alert.alert(
          "Health Connect",
          "No readings were available. Open Health Connect to confirm KHARAGOLF has read access for sleep, HRV, resting heart rate and steps, then try again.",
        );
      }
    } finally { setWellnessBusy(null); }
  }

  
  const [lockerData, setLockerData] = useState<{
    assignment: { id: number; lockerNumber: string; bay: string | null; expiryDate: string; startDate: string; annualFee: string; currency: string; paymentStatus: string; paymentLinkUrl: string | null } | null;
    waitlistEntry: { id: number; requestedAt: string; status: string } | null;
  } | null>(null);
  const [joiningWaitlist, setJoiningWaitlist] = useState(false);
  const [repairJobs, setRepairJobs] = useState<Array<{
    id: number; description: string; jobType: string; status: string;
    technicianName: string | null; expectedCompletionDate: string | null;
    notificationSentAt: string | null; createdAt: string;
  }>>([]);
  const [fittingSessions, setFittingSessions] = useState<Array<{
    id: number; scheduledAt: string; status: string; technicianName: string | null;
    recommendedSpecs: Record<string, string>; notes: string | null;
  }>>([]);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [rankingHistory, setRankingHistory] = useState<RankingHistoryEntry[]>([]);
  const [loyaltyAccount, setLoyaltyAccount] = useState<{
    pointsBalance: number; lifetimePoints: number; rollingYearPoints: number; currentTier: string;
  } | null>(null);
  const [loyaltyRewards, setLoyaltyRewards] = useState<Array<{
    id: number; name: string; description: string | null; pointsCost: number; rewardType: string; minTier: string;
  }>>([]);
  const [caddieInsights, setCaddieInsights] = useState<{
    total: number;
    accepted: number;
    overridden: number;
    pending: number;
    acceptanceRate: number | null;
    avgProximityAccepted: number | null;
    avgProximityOverridden: number | null;
    proximityAcceptedSamples: number;
    proximityOverriddenSamples: number;
    mostOverriddenClubs: Array<{ club: string; overridden: number; total: number; overrideRate: number }>;
    perClub: Array<{ club: string; total: number; accepted: number; overridden: number; acceptanceRate: number; avgProximityAccepted: number | null; avgProximityOverridden: number | null }>;
    perLie?: Array<{ lie: string; total: number; accepted: number; overridden: number; acceptanceRate: number; avgProximityAccepted: number | null; avgProximityOverridden: number | null }>;
  } | null>(null);
  // Task #469 — true when the AI consent gate blocks /portal/caddie/feedback/summary.
  const [caddieConsentBlocked, setCaddieConsentBlocked] = useState(false);
  const [myInvoices, setMyInvoices] = useState<Array<{
    id: number;
    invoiceNumber: string;
    status: string;
    totalAmount: string;
    paidAmount: string;
    currency: string;
    dueDate: string | null;
    paidAt: string | null;
    razorpayPaymentLinkUrl: string | null;
    notes: string | null;
    createdAt: string;
  }>>([]);

  const { t, i18n } = useTranslation("profile");

  // Language preference
  const [langModalOpen, setLangModalOpen] = useState(false);
  const [savingLang, setSavingLang] = useState(false);

  async function saveLanguagePreference(lang: SupportedLanguage) {
    if (!token) return;
    setSavingLang(true);
    try {
      const { needsReload } = await applyLanguage(lang);
      const res = await fetch(`${BASE_URL}/api/portal/me/language`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ language: lang }),
      });
      if (res.ok) {
        if (needsReload) {
          Alert.alert(
            t("layoutReloadTitle", { ns: "common" }),
            t("layoutReloadMessage", { ns: "common" }),
          );
        } else {
          Alert.alert(t("account.languagePreference"), t("languageSaved", { ns: "common" }));
        }
      }
    } catch {
      Alert.alert(t("errors.error"), t("errors.failedLanguageSave"));
    } finally {
      setSavingLang(false);
      setLangModalOpen(false);
    }
  }

  // Club switcher — for super_admin and multi-org membership users
  const { isSuperAdmin, canSwitchClub, clubs, activeOrgId, activeClub, switchClub } = useActiveClub();
  const [clubSwitcherOpen, setClubSwitcherOpen] = useState(false);

  // Task #2190 — surface the saved club logo in the profile header so
  // the third-most-visited tab also answers "what club am I signed into?".
  // Mirrors the `customized && logoUrl` gating used on Home (Task #1757)
  // and Club (Task #1438) so the legacy `activeClub` fallback during
  // initial load doesn't flash a stale logo before /theming settles.
  const { logoUrl, customized } = useTheme();
  const showClubLogo = customized && !!logoUrl;

  async function fetchData(tkn: string) {
    const headers = { "Authorization": `Bearer ${tkn}`, "Content-Type": "application/json" };
    const [statsRes, tournRes, prefsRes, lockerRes, rankRes, caddieRes] = await Promise.all([
      fetch(`${BASE_URL}/api/portal/my-stats`, { headers }),
      fetch(`${BASE_URL}/api/portal/my-tournaments`, { headers }),
      fetch(`${BASE_URL}/api/portal/notification-preferences`, { headers }),
      fetch(`${BASE_URL}/api/portal/locker`, { headers }),
      fetch(`${BASE_URL}/api/portal/rankings/history`, { headers }),
      fetch(`${BASE_URL}/api/portal/caddie/feedback/summary`, { headers }),
    ]);
    if (caddieRes.ok) {
      try { setCaddieInsights(await caddieRes.json()); } catch { setCaddieInsights(null); }
      setCaddieConsentBlocked(false);
    } else if (caddieRes.status === 403) {
      // Task #469 — surface a "consent required" badge on the Caddie Insights
      // panel when the member has withdrawn AI consent.
      try {
        const body = await caddieRes.json();
        if (body?.code === "CONSENT_REQUIRED") setCaddieConsentBlocked(true);
      } catch { /* fall through */ }
      setCaddieInsights(null);
    } else {
      setCaddieInsights(null);
      setCaddieConsentBlocked(false);
    }
    const [s, t, p] = await Promise.all([statsRes.json(), tournRes.json(), prefsRes.ok ? prefsRes.json() : null]);
    setStats(s);
    setTournaments(Array.isArray(t) ? t : []);
    if (p) {
      setNotifPrefs({ preferEmail: p.preferEmail, preferPush: p.preferPush, preferSms: p.preferSms, preferWhatsapp: p.preferWhatsapp ?? false, notifyMemberDocuments: p.notifyMemberDocuments !== false, notifyCommitteePeerDigest: p.notifyCommitteePeerDigest !== false });
      setNotifCapabilities({ hasPhone: !!p.hasPhone, hasPushToken: !!p.hasPushToken, isCommitteeMember: !!p.isCommitteeMember });
    }
    if (lockerRes.ok) {
      const lockerJson = await lockerRes.json();
      setLockerData(lockerJson);
    }
    if (rankRes.ok) {
      const rankJson = await rankRes.json();
      setRankingHistory(Array.isArray(rankJson) ? rankJson : []);
    }
    // Fetch repair jobs and fitting sessions for this member
    if (user?.organizationId) {
      const [repairRes, fittingRes] = await Promise.all([
        fetch(`${BASE_URL}/api/organizations/${user.organizationId}/repair-jobs/member/me`, { headers }),
        fetch(`${BASE_URL}/api/organizations/${user.organizationId}/fitting-sessions/member/me`, { headers }),
      ]);
      if (repairRes.ok) setRepairJobs(await repairRes.json().catch(() => []));
      if (fittingRes.ok) setFittingSessions(await fittingRes.json().catch(() => []));
      // Loyalty
      const [loyaltyAccRes, loyaltyRewRes] = await Promise.all([
        fetch(`${BASE_URL}/api/organizations/${user.organizationId}/loyalty/me`, { headers }),
        fetch(`${BASE_URL}/api/organizations/${user.organizationId}/loyalty/rewards`, { headers }),
      ]);
      if (loyaltyAccRes.ok) {
        const loyaltyData = await loyaltyAccRes.json().catch(() => null);
        if (loyaltyData?.account) setLoyaltyAccount(loyaltyData.account);
      }
      if (loyaltyRewRes.ok) {
        const rewards = await loyaltyRewRes.json().catch(() => []);
        setLoyaltyRewards(Array.isArray(rewards) ? rewards.slice(0, 5) : []);
      }
      // Dues invoices
      const invoicesRes = await fetch(`${BASE_URL}/api/organizations/${user?.organizationId}/dues-billing/my-invoices`, { headers }).catch(() => null);
      if (invoicesRes?.ok) {
        const inv = await invoicesRes.json().catch(() => []);
        setMyInvoices(Array.isArray(inv) ? inv : []);
      }
    }
  }

  const saveNotifPref = useCallback(async (key: keyof typeof notifPrefs, value: boolean) => {
    if (!token) return;
    setNotifPrefs(prev => ({ ...prev, [key]: value }));
    setSavingPref(true);
    try {
      await fetch(`${BASE_URL}/api/portal/notification-preferences`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
    } catch { /* silent */ }
    setSavingPref(false);
  }, [token]);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace("/(auth)/login");
      return;
    }
    if (token) {
      fetchData(token).finally(() => setLoading(false));
    }
  }, [authLoading, isAuthenticated, token]);

  async function onRefresh() {
    setRefreshing(true);
    setScoreHistories({});
    setExpandedTournament(null);
    if (token) await fetchData(token).catch(() => {});
    setRefreshing(false);
  }

  const fetchScoreHistory = useCallback(async (tournamentId: number) => {
    if (!token) return;
    setScoreHistories(prev => ({ ...prev, [tournamentId]: "loading" }));
    try {
      const res = await fetch(`${BASE_URL}/api/portal/my-scores/${tournamentId}`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load scores");
      const data: ScoreHistoryData = await res.json();
      setScoreHistories(prev => ({ ...prev, [tournamentId]: data }));
    } catch {
      setScoreHistories(prev => ({ ...prev, [tournamentId]: "error" }));
    }
  }, [token]);

  const handleWithdraw = useCallback(async (tournamentId: number, tournamentName: string) => {
    if (!token) return;
    Alert.alert(
      t("withdraw.title"),
      t("withdraw.message", { name: tournamentName }),
      [
        { text: t("withdraw.cancel"), style: "cancel" },
        {
          text: t("withdraw.confirm"),
          style: "destructive",
          onPress: async () => {
            setWithdrawingTournament(tournamentId);
            try {
              const res = await fetch(`${BASE_URL}/api/portal/tournaments/${tournamentId}/withdraw`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${token}` },
              });
              if (res.ok) {
                const data = await res.json();
                Alert.alert(
                  t("withdraw.title"),
                  data.refundPending
                    ? t("withdraw.successWithRefund")
                    : t("withdraw.success"),
                );
                setTournaments(prev => prev.filter(t => t.tournamentId !== tournamentId));
                setExpandedTournament(null);
              } else {
                const err = await res.json().catch(() => ({ error: "Failed to withdraw" }));
                Alert.alert(t("errors.error"), err.error ?? t("errors.failedWithdraw"));
              }
            } catch {
              Alert.alert(t("errors.error"), t("errors.networkError"));
            } finally {
              setWithdrawingTournament(null);
            }
          },
        },
      ],
    );
  }, [token]);

  function handleTournamentPress(tournamentId: number) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (expandedTournament === tournamentId) {
      setExpandedTournament(null);
    } else {
      setExpandedTournament(tournamentId);
      if (!scoreHistories[tournamentId]) {
        fetchScoreHistory(tournamentId);
      }
    }
  }

  function handleLogout() {
    Alert.alert(t("account.signOut"), t("confirmLogout"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("account.signOut"), style: "destructive", onPress: () => { logout(); router.replace("/(auth)/login"); } },
    ]);
  }

  async function uploadAvatarFromResult(result: ImagePicker.ImagePickerResult) {
    if (result.canceled || !result.assets?.[0] || !token) return;
    const asset = result.assets[0];
    setAvatarUploading(true);
    try {
      const contentType = "image/jpeg";

      const urlRes = await fetch(`${BASE_URL}/api/portal/avatar-upload-url`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ contentType }),
      });
      if (!urlRes.ok) throw new Error("Failed to get upload URL");
      const { uploadUrl, publicUrl } = await urlRes.json();

      // Resize to 400×400 using expo-image-manipulator
      const manipulated = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize: { width: 400, height: 400 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
      );
      const resizedUri = manipulated.uri;

      const blob: Blob = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onload = () => resolve(xhr.response as Blob);
        xhr.onerror = () => reject(new Error("Failed to read file"));
        xhr.responseType = "blob";
        xhr.open("GET", resizedUri, true);
        xhr.send(null);
      });

      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      if (!putRes.ok) throw new Error("Failed to upload to storage");

      const saveRes = await fetch(`${BASE_URL}/api/portal/me/avatar`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ profileImage: publicUrl }),
      });
      if (!saveRes.ok) throw new Error("Failed to save avatar");

      await refreshUser();
      Alert.alert(t("errors.success"), t("errors.photoUpdated"));
    } catch {
      Alert.alert(t("errors.error"), t("errors.photoUploadFailed"));
    } finally {
      setAvatarUploading(false);
    }
  }

  async function handleSelectPreset(presetId: string) {
    if (!token) return;
    setPresetModalOpen(false);
    setAvatarUploading(true);
    try {
      const profileImage = `preset:${presetId}`;
      const saveRes = await fetch(`${BASE_URL}/api/portal/me/avatar`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ profileImage }),
      });
      if (!saveRes.ok) throw new Error("Failed to save preset");
      await refreshUser();
    } catch {
      Alert.alert(t("errors.error"), t("errors.avatarSelectFailed"));
    } finally {
      setAvatarUploading(false);
    }
  }

  async function handleRemoveAvatar() {
    if (!token) return;
    setAvatarUploading(true);
    try {
      await fetch(`${BASE_URL}/api/portal/me/avatar`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await refreshUser();
    } catch {
      Alert.alert(t("errors.error"), t("errors.photoRemoveFailed"));
    } finally {
      setAvatarUploading(false);
    }
  }

  function handleAvatarPress() {
    const options: Array<{ label: string; action: () => void; destructive?: boolean }> = [
      {
        label: t("photoOptions.chooseLibrary"),
        action: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) { Alert.alert(t("errors.permissionDenied"), t("errors.permissionLibrary")); return; }
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.85,
          });
          await uploadAvatarFromResult(result);
        },
      },
      {
        label: t("photoOptions.takePhoto"),
        action: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) { Alert.alert(t("errors.permissionDenied"), t("errors.permissionCamera")); return; }
          const result = await ImagePicker.launchCameraAsync({
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.85,
          });
          await uploadAvatarFromResult(result);
        },
      },
      {
        label: t("photoOptions.chooseAvatar"),
        action: () => { setPresetModalOpen(true); },
      },
      ...(user?.profileImage ? [{ label: t("photoOptions.removePhoto"), action: handleRemoveAvatar, destructive: true }] : []),
    ];

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [t("photoOptions.cancel"), ...options.map(o => o.label)],
          cancelButtonIndex: 0,
          destructiveButtonIndex: user?.profileImage ? options.length : undefined,
        },
        (idx) => { if (idx > 0) options[idx - 1].action(); },
      );
    } else {
      Alert.alert(
        t("photoOptions.changeProfilePhoto"),
        undefined,
        [
          ...options.map(o => ({ text: o.label, style: o.destructive ? "destructive" as const : "default" as const, onPress: o.action })),
          { text: t("photoOptions.cancel"), style: "cancel" },
        ],
      );
    }
  }

  if (authLoading || loading) {
    return (
      <View style={styles.center}>
        <LoadingSpinner color={Colors.primary} size="large" />
      </View>
    );
  }

  if (!isAuthenticated) return null;

  const initials = user?.displayName
    ? user.displayName.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : (user?.email?.[0] ?? "?").toUpperCase();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.background }} edges={["top"]}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        {/* Header */}
        <View style={styles.header}>
          {showClubLogo ? (
            <Image
              source={{ uri: logoUrl! }}
              style={styles.clubLogo}
              resizeMode="contain"
              accessibilityLabel={activeClub?.name ?? "Club logo"}
            />
          ) : null}
          <TouchableOpacity onPress={handleAvatarPress} disabled={avatarUploading} style={styles.avatarWrapper} activeOpacity={0.8}>
            <View style={styles.avatar}>
              {avatarUploading ? (
                <LoadingSpinner color="#fff" size="large" />
              ) : user?.profileImage && isPresetAvatar(user.profileImage) ? (
                (() => {
                  const preset = PRESET_MAP[getPresetId(user.profileImage)];
                  return preset ? <SvgXml xml={preset.svgXml} width="100%" height="100%" /> : <Text style={styles.avatarText}>{initials}</Text>;
                })()
              ) : user?.profileImage ? (
                <Image source={{ uri: user.profileImage }} style={styles.avatarImg} />
              ) : (
                <Text style={styles.avatarText}>{initials}</Text>
              )}
            </View>
            <View style={styles.avatarEditBadge}>
              <Feather name="camera" size={10} color="#fff" />
            </View>
          </TouchableOpacity>
          <Text style={styles.name}>{user?.displayName ?? user?.username ?? "Player"}</Text>
          <Text style={styles.email}>{user?.email}</Text>
          {user?.isLocalAuth && !user.emailVerified && (
            <View style={styles.unverifiedBadge}>
              <Feather name="alert-circle" size={12} color="#f59e0b" />
              <Text style={styles.unverifiedText}>{t("emailNotVerified")}</Text>
            </View>
          )}
          <View style={styles.roleBadge}>
            <Feather name="user" size={12} color={Colors.primary} />
            <Text style={styles.roleText}>{(user?.role ?? "player").replace("_", " ").toUpperCase()}</Text>
          </View>
        </View>

        {/* ── Handicap Index Banner ──────────────────────────────── */}
        {isAuthenticated && (
          <View style={{
            marginHorizontal: 16, marginBottom: 16, borderRadius: 16,
            backgroundColor: '#1a2c22', borderWidth: 1, borderColor: '#243b2e',
            overflow: 'hidden',
          }}>
            {/* Gold top accent bar */}
            <View style={{ height: 3, backgroundColor: '#C9A84C' }} />
            <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, color: '#4b7060', fontFamily: 'Inter_600SemiBold', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 }}>
                  World Handicap Index
                </Text>
                <Text style={{ fontSize: 48, color: '#C9A84C', fontFamily: 'Inter_700Bold', lineHeight: 52 }}>
                  {stats?.hcpTrend?.length
                    ? Number(stats.hcpTrend[stats.hcpTrend.length - 1].handicapIndex).toFixed(1)
                    : '—'}
                </Text>
                {stats?.hcpTrend && stats.hcpTrend.length > 1 && (() => {
                  const last = Number(stats.hcpTrend[stats.hcpTrend.length - 1].handicapIndex);
                  const prev = Number(stats.hcpTrend[stats.hcpTrend.length - 2].handicapIndex);
                  const diff = last - prev;
                  const improved = diff < 0;
                  return (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                      <Text style={{ fontSize: 13, color: improved ? '#22c55e' : '#f87171', fontFamily: 'Inter_600SemiBold' }}>
                        {improved ? '▼' : '▲'} {Math.abs(diff).toFixed(1)}
                      </Text>
                      <Text style={{ fontSize: 12, color: '#4b7060', fontFamily: 'Inter_400Regular' }}>{t("fromLastRecord")}</Text>
                    </View>
                  );
                })()}
              </View>
              <View style={{ alignItems: 'flex-end', gap: 8 }}>
                <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#C9A84C20', borderWidth: 2, borderColor: '#C9A84C40', alignItems: 'center', justifyContent: 'center' }}>
                  <Feather name="target" size={24} color="#C9A84C" />
                </View>
                <TouchableOpacity
                  onPress={() => router.push('/handicap-profile')}
                  style={{ backgroundColor: '#C9A84C20', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: '#C9A84C40' }}
                >
                  <Text style={{ fontSize: 12, color: '#C9A84C', fontFamily: 'Inter_600SemiBold' }}>{t("fullHistory")}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* Stats */}
        {stats && (
          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{stats.tournamentsPlayed}</Text>
              <Text style={styles.statLabel}>{t("statsLabels.tournaments")}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{stats.averageStrokes != null ? Number(stats.averageStrokes).toFixed(1) : "—"}</Text>
              <Text style={styles.statLabel}>{t("statsLabels.avgStrokes")}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{stats.bestRound ?? "—"}</Text>
              <Text style={styles.statLabel}>{t("statsLabels.bestRound")}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{stats.totalScores}</Text>
              <Text style={styles.statLabel}>{t("statsLabels.holesPlayed")}</Text>
            </View>
          </View>
        )}

        {/* Ask the AI Caddie — chat entry point (Task #521) */}
        {!caddieConsentBlocked && (
          <View style={styles.section}>
            <TouchableOpacity
              onPress={() => router.push("/ai-caddie" as never)}
              style={{
                backgroundColor: Colors.surface,
                borderRadius: 16,
                padding: 16,
                borderWidth: 1,
                borderColor: `${Colors.primary}40`,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
              }}
            >
              <View style={{
                width: 44, height: 44, borderRadius: 22,
                backgroundColor: `${Colors.primary}20`,
                alignItems: "center", justifyContent: "center",
                borderWidth: 1, borderColor: `${Colors.primary}40`,
              }}>
                <Feather name="message-circle" size={20} color={Colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: Colors.text, fontWeight: "700", fontSize: 15 }}>
                  Ask the AI Caddie
                </Text>
                <Text style={{ color: Colors.tabIconDefault, fontSize: 12, marginTop: 2 }}>
                  Chat about clubs, strategy & practice priorities
                </Text>
              </View>
              <Feather name="chevron-right" size={20} color={Colors.tabIconDefault} />
            </TouchableOpacity>
          </View>
        )}

        {/* AI Caddie Insights — Task #1113 extracted both the consent-blocked
            prompt (#469) and the insights card into CaddieInsightsSection. */}
        <CaddieInsightsSection
          insights={caddieInsights}
          consentBlocked={caddieConsentBlocked}
          onOpenConsents={() => router.push("/my-360/consents")}
          onOpenPending={() => router.push("/caddie/pending" as never)}
        />

        {/* Loyalty & Rewards Card — extracted to LoyaltySection (Task #1115). */}
        {loyaltyAccount && (
          <LoyaltySection account={loyaltyAccount} rewards={loyaltyRewards} />
        )}

        {/* Quick Links */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("myGolf.section")}</Text>
          {[
            { icon: "activity" as const, label: t("myGolf.generalPlay"), sublabel: t("myGolf.generalPlaySub"), path: "/general-play" },
            { icon: "clock" as const, label: t("myGolf.teeBookings"), sublabel: t("myGolf.teeBookingsSub"), path: "/tee-bookings" },
            { icon: "award" as const, label: t("myGolf.handicapProfile"), sublabel: t("myGolf.handicapProfileSub"), path: "/handicap-profile" },
            { icon: "gift" as const, label: "Year in Golf", sublabel: "Your annual & quarterly recap", path: "/year-in-golf" },
            { icon: "user" as const, label: "My 360°", sublabel: "Documents, consents, statement, family & privacy", path: "/my-360" },
            { icon: "video" as const, label: "Highlight Reels", sublabel: "Auto-generated round highlights to share", path: "/highlights" },
          ].map(item => (
            <TouchableOpacity
              key={item.path}
              style={styles.menuItem}
              onPress={() => router.push(item.path as any)}
              activeOpacity={0.7}
            >
              <Feather name={item.icon} size={18} color={Colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "500" }}>{item.label}</Text>
                <Text style={{ color: Colors.tabIconDefault, fontSize: 12, marginTop: 1 }}>{item.sublabel}</Text>
              </View>
              <Feather name="chevron-right" size={16} color={Colors.tabIconDefault} />
            </TouchableOpacity>
          ))}
        </View>

        {/* Locker */}
        {lockerData !== null && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t("locker.section")}</Text>
            {lockerData.assignment ? (
              <LockerRenewalCard
                assignment={lockerData.assignment}
                orgId={user?.organizationId ?? null}
                token={token}
              />
            ) : lockerData.waitlistEntry ? (
              <View style={{ backgroundColor: "#1e293b", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#334155" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <Feather name="clock" size={16} color="#94a3b8" />
                  <Text style={{ color: "#fff", fontWeight: "700" }}>{t("locker.onWaitlist")}</Text>
                  {lockerData.waitlistEntry.status === "notified" && (
                    <View style={{ backgroundColor: "#1d4ed8", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                      <Text style={{ color: "#93c5fd", fontSize: 10, fontWeight: "600" }}>{t("locker.notified")}</Text>
                    </View>
                  )}
                </View>
                <Text style={{ color: "#94a3b8", fontSize: 13 }}>
                  {t("locker.waitlistJoinedOn", { date: new Date(lockerData.waitlistEntry.requestedAt).toLocaleDateString(getLocale(), { year: "numeric", month: "short", day: "numeric" }) })}
                  {lockerData.waitlistEntry.status === "notified" ? " " + t("locker.lockerAvailable") : " " + t("locker.willBeNotified")}
                </Text>
              </View>
            ) : (
              <View style={{ backgroundColor: "#0f172a", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#1e293b" }}>
                <Text style={{ color: "#94a3b8", fontSize: 13, marginBottom: 12 }}>
                  {t("locker.noAssigned")}
                </Text>
                <TouchableOpacity
                  style={{ backgroundColor: Colors.primary, borderRadius: 8, paddingVertical: 10, alignItems: "center", opacity: joiningWaitlist ? 0.7 : 1 }}
                  disabled={joiningWaitlist}
                  onPress={async () => {
                    if (!token) return;
                    setJoiningWaitlist(true);
                    try {
                      const res = await fetch(`${BASE_URL}/api/portal/locker/join-waitlist`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
                      });
                      if (res.ok) {
                        const entry = await res.json();
                        setLockerData(prev => prev ? { ...prev, waitlistEntry: entry } : prev);
                      } else {
                        const err = await res.json();
                        Alert.alert(t("errors.error"), err.error ?? t("errors.waitlistFailed"));
                      }
                    } catch {
                      Alert.alert(t("errors.error"), t("errors.waitlistFailed"));
                    } finally {
                      setJoiningWaitlist(false);
                    }
                  }}
                >
                  <Text style={{ color: "#fff", fontWeight: "700" }}>{joiningWaitlist ? t("locker.joining") : t("locker.joinWaitlist")}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Dues Invoices, Repair Jobs, Fitting Sessions — extracted (Task #1115).
            Always mounted (Task #1520) so the empty placeholders surface to
            members the same way the locker section's "No locker assigned" copy
            does, instead of silently hiding the feature when there's no data. */}
        <InvoicesSection
          invoices={myInvoices}
          orgId={user?.organizationId ?? null}
          token={token}
          onPayInvoice={async inv => {
            const { Linking } = await import("react-native");
            if (inv.razorpayPaymentLinkUrl) Linking.openURL(inv.razorpayPaymentLinkUrl);
          }}
        />

        <RepairJobsSection jobs={repairJobs} />

        <FittingSessionsSection sessions={fittingSessions} />

        {/* Recovery & Wellness — Whoop, Garmin, Apple Health, Google Fit */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recovery & Wellness</Text>
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => router.push("/wellness-dashboard")}
            activeOpacity={0.7}
            testID="menu-wellness-dashboard"
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: "#fff", fontSize: 14, fontWeight: "500" }}>Wellness dashboard</Text>
              <Text style={{ color: Colors.tabIconDefault, fontSize: 12, marginTop: 2 }}>
                30 / 60 / 90-day trends for readiness, sleep, HRV and resting HR.
              </Text>
            </View>
            <Text style={{ color: Colors.tabIconDefault, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
          {wellnessToday && (wellnessToday.readinessScore != null || wellnessToday.sleepMinutes != null || wellnessToday.hrvMs != null || wellnessToday.steps != null) && (
            <View style={[styles.menuItem, { flexDirection: "column", alignItems: "stretch" }]}>
              {/* Today's snapshot — readiness, sleep, HRV, RHR, steps */}
              <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                {[
                  { label: "READINESS", value: wellnessToday.readinessScore != null ? String(wellnessToday.readinessScore) : "—" },
                  { label: "SLEEP", value: wellnessToday.sleepMinutes != null ? `${Math.floor(wellnessToday.sleepMinutes / 60)}h ${wellnessToday.sleepMinutes % 60}m` : "—" },
                  { label: "HRV", value: wellnessToday.hrvMs != null ? `${Math.round(wellnessToday.hrvMs)} ms` : "—" },
                  { label: "RHR", value: wellnessToday.restingHr != null ? `${wellnessToday.restingHr}` : "—" },
                  { label: "STEPS", value: wellnessToday.steps != null ? wellnessToday.steps.toLocaleString() : "—" },
                ].map(tile => (
                  <View key={tile.label} style={{ width: "50%", paddingVertical: 6 }}>
                    <Text style={{ color: Colors.tabIconDefault, fontSize: 10, letterSpacing: 1.2 }}>{tile.label}</Text>
                    <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700" }}>{tile.value}</Text>
                  </View>
                ))}
              </View>
              {wellnessToday.sources && wellnessToday.sources.length > 0 && (
                <Text style={{ color: Colors.tabIconDefault, fontSize: 11, marginTop: 6 }}>
                  Sources: {wellnessToday.sources.join(", ")}
                </Text>
              )}
              {/* 7-day readiness mini-chart (bars). Skipped when fewer than 2 days */}
              {wellnessSeries.length >= 2 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={{ color: Colors.tabIconDefault, fontSize: 11, letterSpacing: 1.2, marginBottom: 6 }}>LAST 7 DAYS · READINESS</Text>
                  <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4, height: 60 }}>
                    {wellnessSeries.slice(0, 7).slice().reverse().map((d, idx) => {
                      const v = d.readinessScore ?? 0;
                      const h = Math.max(2, Math.round((v / 100) * 56));
                      const c = v >= 67 ? "#22c55e" : v >= 34 ? "#f59e0b" : v > 0 ? "#ef4444" : Colors.border;
                      return (
                        <View key={idx} style={{ flex: 1, alignItems: "center" }}>
                          <View style={{ width: "100%", height: h, backgroundColor: c, borderRadius: 3 }} />
                          <Text style={{ color: Colors.tabIconDefault, fontSize: 9, marginTop: 2 }}>{d.metricDate.slice(5)}</Text>
                        </View>
                      );
                    })}
                  </View>
                </View>
              )}
            </View>
          )}

          {/* Connect / disconnect wearable providers */}
          {(["whoop", "google_fit", "health_connect", "garmin", "apple_health"] as const).map(provider => {
            const conn = wellnessConnections.find(c => c.provider === provider);
            const isConnected = conn?.status === "connected";
            const needsReauth = conn?.status === "needs_reauth";
            const label = { whoop: "Whoop", google_fit: "Google Fit", health_connect: "Health Connect", garmin: "Garmin Connect", apple_health: "Apple Health" }[provider];
            const isApple = provider === "apple_health";
            const isHC = provider === "health_connect";
            const canConnect = provider === "whoop" || provider === "google_fit"
              || (isApple && isAppleHealthSupported())
              || (isHC && isHealthConnectSupported());
            const reconnect = () => isApple
              ? connectAppleHealth()
              : isHC
                ? connectHealthConnect()
                : connectWellnessProvider(provider as "whoop" | "google_fit");
            const description = needsReauth
              ? "Sign-in expired — reconnect to resume syncing recovery data."
              : isConnected
                ? (isApple
                    ? "Apple Health connected — sleep, HRV, RHR & steps sync on launch."
                    : isHC
                      ? "Health Connect connected — sleep, HRV, RHR & steps sync on launch."
                      : "Connected — recovery, sleep & HRV will sync daily.")
                : (canConnect
                    ? (isApple
                        ? "Tap connect to grant read-only HealthKit access."
                        : isHC
                          ? "Tap connect to grant read-only Health Connect access."
                          : "Tap connect to authorise read-only access.")
                    : (isApple
                        ? "Available on iPhone in the native KHARAGOLF build."
                        : isHC
                          ? "Available on Android in the native KHARAGOLF build."
                          : "Manage from your phone settings."));
            return (
              <View key={provider} style={styles.menuItem}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "500" }}>{label}</Text>
                    {(isApple || isHC) && isConnected && (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: `${Colors.primary}30` }}>
                        <Feather name="check-circle" size={10} color={Colors.primary} />
                        <Text style={{ color: Colors.primary, fontSize: 10, fontWeight: "700" }}>CONNECTED</Text>
                      </View>
                    )}
                    {needsReauth && (
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`Reconnect ${label}`}
                        testID={`wearable-reauth-badge-${provider}`}
                        disabled={!canConnect || wellnessBusy === `connect:${provider}`}
                        onPress={canConnect ? reconnect : undefined}
                        style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: "#f59e0b30" }}
                      >
                        <Feather name="alert-triangle" size={10} color="#f59e0b" />
                        <Text style={{ color: "#f59e0b", fontSize: 10, fontWeight: "700" }}>NEEDS RECONNECT</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  <Text style={{ color: needsReauth ? "#f59e0b" : Colors.tabIconDefault, fontSize: 12, marginTop: 2 }}>{description}</Text>
                </View>
                {needsReauth && canConnect ? (
                  <TouchableOpacity
                    disabled={wellnessBusy === `connect:${provider}`}
                    onPress={reconnect}
                    testID={`wearable-reconnect-${provider}`}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: "#f59e0b" }}
                  >
                    {wellnessBusy === `connect:${provider}` ? (
                      <LoadingSpinner size="small" color="#fff" />
                    ) : (
                      <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600" }}>Reconnect</Text>
                    )}
                  </TouchableOpacity>
                ) : isConnected ? (
                  <TouchableOpacity
                    disabled={wellnessBusy === `disconnect:${provider}`}
                    onPress={() => disconnectWellnessProvider(provider)}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: Colors.border }}
                  >
                    <Text style={{ color: "#fff", fontSize: 12 }}>Disconnect</Text>
                  </TouchableOpacity>
                ) : canConnect ? (
                  <TouchableOpacity
                    disabled={wellnessBusy === `connect:${provider}`}
                    onPress={reconnect}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: Colors.primary }}
                  >
                    {wellnessBusy === `connect:${provider}` ? (
                      <LoadingSpinner size="small" color="#fff" />
                    ) : (
                      <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600" }}>Connect</Text>
                    )}
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          })}

          {/* Per-scope sharing consents — default off; nothing leaves until toggled */}
          <Text style={{ color: Colors.tabIconDefault, fontSize: 11, letterSpacing: 1, marginTop: 12, marginBottom: 6 }}>SHARING</Text>
          {[
            { scope: "share_with_coach", label: "Share with my coach" },
            { scope: "share_with_club", label: "Share with club analytics" },
            { scope: "show_on_leaderboard", label: "Show readiness badge on leaderboard" },
            { scope: "export_csv", label: "Allow CSV export" },
          ].map(item => {
            const isOn = wellnessConsents.find(c => c.scope === item.scope)?.granted ?? false;
            const isDisabled = wellnessBusy === `consent:${item.scope}`;
            return (
              <View key={item.scope} style={styles.menuItem}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "500" }}>{item.label}</Text>
                </View>
                <TouchableOpacity
                  disabled={isDisabled}
                  onPress={() => setWellnessConsent(item.scope, !isOn)}
                  activeOpacity={isDisabled ? 1 : 0.7}
                  style={{
                    width: 44, height: 26, borderRadius: 13,
                    backgroundColor: isOn ? Colors.primary : Colors.border,
                    justifyContent: "center", padding: 3,
                  }}
                >
                  <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff", alignSelf: isOn ? "flex-end" : "flex-start" }} />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        {/* Notification Preferences */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("notificationPreferences")}</Text>
          {[
            { key: "preferEmail" as const, label: t("notifLabels.email"), desc: t("notifLabels.emailDesc"), locked: true, available: true },
            { key: "preferPush" as const, label: t("notifLabels.push"), desc: notifCapabilities.hasPushToken ? t("notifLabels.pushDesc") : t("notifLabels.pushNeedApp"), locked: false, available: notifCapabilities.hasPushToken },
            { key: "preferSms" as const, label: t("notifLabels.sms"), desc: notifCapabilities.hasPhone ? t("notifLabels.smsDesc") : t("notifLabels.noPhone"), locked: false, available: notifCapabilities.hasPhone },
            { key: "preferWhatsapp" as const, label: t("notifLabels.whatsapp"), desc: notifCapabilities.hasPhone ? t("notifLabels.whatsappDesc") : t("notifLabels.noPhone"), locked: false, available: notifCapabilities.hasPhone },
            ...(user?.role && user.role !== "player" && user.role !== "spectator" ? [
              { key: "notifyMemberDocuments" as const, label: t("notifLabels.memberDocuments"), desc: t("notifLabels.memberDocumentsDesc"), locked: false, available: true },
            ] : []),
            ...(notifCapabilities.isCommitteeMember ? [
              { key: "notifyCommitteePeerDigest" as const, label: t("notifLabels.committeePeerDigest"), desc: t("notifLabels.committeePeerDigestDesc"), locked: false, available: true },
            ] : []),
          ].map(item => {
            const isOn = item.locked ? true : notifPrefs[item.key];
            const isDisabled = savingPref || !item.available || item.locked;
            return (
              <View key={item.key} style={[styles.menuItem, !item.available && { opacity: 0.5 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "500" }}>{item.label}</Text>
                  <Text style={{ color: Colors.tabIconDefault, fontSize: 12, marginTop: 2 }}>{item.desc}</Text>
                  {item.locked && <Text style={{ color: Colors.primary, fontSize: 10, marginTop: 2 }}>{t("alwaysOn")}</Text>}
                </View>
                <TouchableOpacity
                  disabled={isDisabled}
                  onPress={() => { if (!item.locked && item.available) saveNotifPref(item.key, !notifPrefs[item.key]); }}
                  activeOpacity={isDisabled ? 1 : 0.7}
                  style={{
                    width: 44, height: 26, borderRadius: 13,
                    backgroundColor: isOn && item.available ? Colors.primary : Colors.border,
                    justifyContent: "center",
                    padding: 3,
                  }}
                >
                  <View style={{
                    width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff",
                    alignSelf: isOn && item.available ? "flex-end" : "flex-start",
                  }} />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        {/* Tournament Scoring History — expandable cards */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("scoringHistory.section")}</Text>
          {tournaments.length === 0 ? (
            <View style={styles.emptyCard}>
              <Ionicons name="golf" size={28} color={Colors.tabIconDefault} />
              <Text style={styles.emptyText}>{t("scoringHistory.noHistory")}</Text>
              <Text style={styles.emptySubText}>{t("scoringHistory.noHistoryDesc")}</Text>
            </View>
          ) : (
            tournaments.map((tourney) => {
              const isExpanded = expandedTournament === tourney.tournamentId;
              const hist = scoreHistories[tourney.tournamentId];
              return (
                <View key={tourney.playerId} style={styles.tournamentCard}>
                  <TouchableOpacity onPress={() => handleTournamentPress(tourney.tournamentId)} activeOpacity={0.75} style={styles.tournamentCardHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.tournamentName}>{tourney.tournamentName}</Text>
                      {tourney.startDate && (
                        <Text style={styles.tournamentDate}>
                          {new Date(tourney.startDate).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" })}
                        </Text>
                      )}
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <View style={[styles.statusBadge, tourney.tournamentStatus === "active" && styles.statusBadgeActive]}>
                        <Text style={[styles.statusText, tourney.tournamentStatus === "active" && styles.statusTextActive]}>
                          {t(`tournaments.statuses.${tourney.tournamentStatus}`, { defaultValue: tourney.tournamentStatus.toUpperCase() })}
                        </Text>
                      </View>
                      <Feather
                        name={isExpanded ? "chevron-up" : "chevron-down"}
                        size={16}
                        color={Colors.tabIconDefault}
                      />
                    </View>
                  </TouchableOpacity>

                  {/* Expanded: round-by-round scoring breakdown */}
                  {isExpanded && (
                    <View style={styles.scoreHistoryBody}>
                      {hist === "loading" && (
                        <LoadingSpinner color={Colors.primary} size="small" style={{ marginVertical: 12 }} />
                      )}
                      {hist === "error" && (
                        <View style={styles.histError}>
                          <Feather name="alert-circle" size={14} color="#f59e0b" />
                          <Text style={styles.histErrorText}>{t("scoringHistory.loadError")}</Text>
                          <TouchableOpacity onPress={() => fetchScoreHistory(tourney.tournamentId)}>
                            <Text style={{ color: Colors.primary, fontSize: 12, fontWeight: "600" }}>{t("scoringHistory.retry")}</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                      {hist && hist !== "loading" && hist !== "error" && (
                        <>
                          {/* Player context */}
                          <View style={styles.playerCtx}>
                            <View style={styles.playerCtxRow}>
                              <Text style={styles.playerCtxLabel}>{t("scoringHistory.format")}</Text>
                              <Text style={styles.playerCtxValue}>{hist.tournament.format?.toUpperCase() ?? "—"}</Text>
                            </View>
                            <View style={styles.playerCtxRow}>
                              <Text style={styles.playerCtxLabel}>{t("scoringHistory.handicap")}</Text>
                              <Text style={styles.playerCtxValue}>{hist.player.handicapIndex ?? "N/A"}</Text>
                            </View>
                            <View style={styles.playerCtxRow}>
                              <Text style={styles.playerCtxLabel}>{t("scoringHistory.tee")}</Text>
                              <Text style={styles.playerCtxValue}>{hist.player.teeBox ?? "—"}</Text>
                            </View>
                            <View style={styles.playerCtxRow}>
                              <Text style={styles.playerCtxLabel}>{t("scoringHistory.rounds")}</Text>
                              <Text style={styles.playerCtxValue}>{hist.tournament.rounds}</Text>
                            </View>
                          </View>
                          {hist.scores.length === 0 ? (
                            <View style={styles.noScores}>
                              <Ionicons name="golf-outline" size={20} color={Colors.tabIconDefault} />
                              <Text style={styles.noScoresText}>{t("scoringHistory.noScores")}</Text>
                            </View>
                          ) : (
                            Array.from(groupScoresByRound(hist.scores).entries())
                              .sort(([a], [b]) => a - b)
                              .map(([round, holes]) => (
                                <RoundCard key={round} round={round} holes={holes} />
                              ))
                          )}
                        </>
                      )}
                    {/* Withdraw button — only for upcoming/active tournaments */}
                    {tourney.tournamentStatus !== "completed" && (
                      <TouchableOpacity
                        onPress={() => handleWithdraw(tourney.tournamentId, tourney.tournamentName)}
                        disabled={withdrawingTournament === tourney.tournamentId}
                        style={{ marginTop: 12, borderRadius: 8, paddingVertical: 10, alignItems: "center", backgroundColor: "rgba(239,68,68,0.12)", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" }}
                      >
                        {withdrawingTournament === tourney.tournamentId ? (
                          <LoadingSpinner color="#ef4444" size="small" />
                        ) : (
                          <Text style={{ color: "#ef4444", fontSize: 13, fontWeight: "600" }}>{t("scoringHistory.withdraw")}</Text>
                        )}
                      </TouchableOpacity>
                    )}
                    </View>
                  )}
                </View>
              );
            })
          )}
        </View>

        {/* Rankings — points history across all series */}
        {rankingHistory.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t("rankings.section")}</Text>
            {rankingHistory.map((entry) => (
              <View key={entry.id} style={styles.tournamentCard}>
                <View style={styles.tournamentCardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.tournamentName}>{entry.seriesName ?? t("rankings.rankingSeries")}</Text>
                    <View style={{ flexDirection: "row", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                      {entry.seriesLevel && (
                        <View style={{ backgroundColor: "rgba(34,197,94,0.15)", borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
                          <Text style={{ color: Colors.primary, fontSize: 10, fontWeight: "700", textTransform: "uppercase" }}>
                            {entry.seriesLevel}
                          </Text>
                        </View>
                      )}
                      <View style={{ backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
                        <Text style={{ color: "#9ca3af", fontSize: 10, fontWeight: "600", textTransform: "uppercase" }}>
                          {entry.category}
                        </Text>
                      </View>
                    </View>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 2 }}>
                    <Text style={{ color: Colors.primary, fontSize: 22, fontWeight: "900" }}>
                      {entry.totalPoints} {t("rankings.pts")}
                    </Text>
                    {entry.position !== null && (
                      <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>
                        {entry.position === 1 ? "🥇" : entry.position === 2 ? "🥈" : entry.position === 3 ? "🥉" : `#${entry.position}`} {t("rankings.ranked")}
                      </Text>
                    )}
                  </View>
                </View>
                {/* Stats row */}
                <View style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: Colors.border, paddingVertical: 10, paddingHorizontal: 14, gap: 0 }}>
                  {[
                    { label: t("rankings.events"), value: String(entry.eventsPlayed) },
                    { label: t("rankings.wins"), value: String(entry.wins) },
                    { label: t("rankings.top3"), value: String(entry.top3) },
                  ].map((stat, i) => (
                    <View key={stat.label} style={{ flex: 1, alignItems: "center", borderRightWidth: i < 2 ? 1 : 0, borderRightColor: Colors.border }}>
                      <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700" }}>{stat.value}</Text>
                      <Text style={{ color: Colors.tabIconDefault, fontSize: 10, marginTop: 1 }}>{stat.label}</Text>
                    </View>
                  ))}
                </View>
                {/* Points history */}
                {entry.history.length > 0 && (
                  <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 6 }}>
                    <Text style={{ color: Colors.tabIconDefault, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                      {t("rankings.eventHistory")}
                    </Text>
                    {entry.history.slice(0, 5).map((h) => (
                      <View key={h.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: "#fff", fontSize: 13 }} numberOfLines={1}>{h.tournamentName ?? "Tournament"}</Text>
                          {h.tournamentDate && (
                            <Text style={{ color: Colors.tabIconDefault, fontSize: 11 }}>
                              {new Date(h.tournamentDate).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" })}
                            </Text>
                          )}
                        </View>
                        <View style={{ alignItems: "flex-end" }}>
                          <Text style={{ color: Colors.primary, fontSize: 14, fontWeight: "700" }}>+{h.pointsAwarded} {t("rankings.pts")}</Text>
                          <Text style={{ color: Colors.tabIconDefault, fontSize: 11 }}>
                            {h.position === 1 ? "🥇" : h.position === 2 ? "🥈" : h.position === 3 ? "🥉" : `#${h.position}`}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Club Switcher — super_admin and multi-org members */}
        {canSwitchClub && clubs.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t("activeClub.section")}</Text>
            <View style={styles.menuCard}>
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => setClubSwitcherOpen(true)}
                activeOpacity={0.7}
              >
                <Ionicons name="business-outline" size={18} color={Colors.secondary} />
                <View style={{ flex: 1, marginLeft: 2 }}>
                  <Text style={styles.menuText}>{activeClub?.name ?? "Select club"}</Text>
                  {activeClub?.subscriptionTier && (
                    <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 1 }}>
                      {activeClub.subscriptionTier.charAt(0).toUpperCase() + activeClub.subscriptionTier.slice(1)} plan
                    </Text>
                  )}
                </View>
                <Feather name="chevron-right" size={18} color={Colors.muted} />
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("eventRoles.section")}</Text>
          <View style={styles.menuCard}>
            <TouchableOpacity style={[styles.menuItem, styles.menuItemLast]} onPress={() => router.push("/staffing")} activeOpacity={0.7}>
              <Feather name="users" size={18} color={Colors.primary} />
              <Text style={styles.menuText}>{t("eventRoles.volunteering")}</Text>
              <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("account.section")}</Text>
          <View style={styles.menuCard}>
            <TouchableOpacity style={styles.menuItem} onPress={() => Alert.alert(t("comingSoon"), t("editProfileSoon"))}>
              <Feather name="edit-2" size={18} color={Colors.tabIconDefault} />
              <Text style={styles.menuText}>{t("account.editProfile")}</Text>
              <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => router.push("/portal-privacy")} testID="menu-privacy">
              <Feather name="shield" size={18} color={Colors.tabIconDefault} />
              <Text style={styles.menuText}>Public profile & privacy</Text>
              <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => router.push("/my-follows" as never)} testID="menu-my-follows">
              <Feather name="user-check" size={18} color={Colors.tabIconDefault} />
              <Text style={styles.menuText}>Following & followers</Text>
              <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => setLangModalOpen(true)}>
              <Feather name="globe" size={18} color={Colors.tabIconDefault} />
              <View style={{ flex: 1 }}>
                <Text style={styles.menuText}>{t("account.languagePreference")}</Text>
                <Text style={{ fontSize: 12, color: Colors.muted, marginTop: 1 }}>
                  {SUPPORTED_LANGUAGES.find(l => l.code === i18n.language)?.name ?? "English"}
                </Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />
            </TouchableOpacity>
            <View style={styles.menuItem}>
              <View style={{ flex: 1 }}>
                <CurrencyPicker />
              </View>
            </View>
            {user?.isLocalAuth && (
              <TouchableOpacity style={styles.menuItem} onPress={() => Alert.alert(t("comingSoon"), t("changePasswordSoon"))}>
                <Feather name="lock" size={18} color={Colors.tabIconDefault} />
                <Text style={styles.menuText}>{t("account.changePassword")}</Text>
                <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => router.push("/security" as never)}
              testID="link-security"
            >
              <Feather name="shield" size={18} color={Colors.tabIconDefault} />
              <Text style={styles.menuText}>Security &amp; sign-ins</Text>
              <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />
            </TouchableOpacity>
            {user?.role && user.role !== "player" && user.role !== "spectator" && (
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => router.push("/club-theming" as never)}
                testID="link-club-theming"
              >
                <Feather name="droplet" size={18} color={Colors.tabIconDefault} />
                <Text style={styles.menuText}>Club theming</Text>
                <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.menuItem, styles.menuItemLast, styles.logoutItem]} onPress={handleLogout}>
              <Feather name="log-out" size={18} color="#ef4444" />
              <Text style={[styles.menuText, { color: "#ef4444" }]}>{t("account.signOut")}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Language Picker Modal */}
        <Modal
          visible={langModalOpen}
          animationType="slide"
          transparent
          onRequestClose={() => setLangModalOpen(false)}
        >
          <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" }}>
            <View style={{ backgroundColor: "#0a1a0f", borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 40 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 20, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" }}>
                <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700" }}>{t("languageModal.title")}</Text>
                <TouchableOpacity onPress={() => setLangModalOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Feather name="x" size={22} color="#9ca3af" />
                </TouchableOpacity>
              </View>
              <Text style={{ color: "#6b7280", fontSize: 13, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
                {t("languageModal.description")}
              </Text>
              <ScrollView
                style={{ maxHeight: Dimensions.get("window").height * 0.6 }}
                contentContainerStyle={{ paddingBottom: 8 }}
                showsVerticalScrollIndicator
              >
                {SUPPORTED_LANGUAGES.map((lang) => {
                  const isSelected = i18n.language === lang.code;
                  return (
                    <TouchableOpacity
                      key={lang.code}
                      onPress={() => saveLanguagePreference(lang.code as SupportedLanguage)}
                      disabled={savingLang}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        paddingHorizontal: 20,
                        paddingVertical: 16,
                        borderBottomWidth: 1,
                        borderBottomColor: "rgba(255,255,255,0.05)",
                        opacity: savingLang ? 0.5 : 1,
                      }}
                      activeOpacity={0.7}
                    >
                      <View style={{
                        width: 24, height: 24, borderRadius: 12,
                        borderWidth: 2,
                        borderColor: isSelected ? Colors.primary : "rgba(255,255,255,0.2)",
                        backgroundColor: isSelected ? Colors.primary : "transparent",
                        alignItems: "center", justifyContent: "center",
                        marginRight: 12,
                      }}>
                        {isSelected && <Feather name="check" size={14} color="#fff" />}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: "#fff", fontSize: 16, fontWeight: isSelected ? "600" : "400" }}>{lang.name}</Text>
                        {lang.code === "ar" && (
                          <Text style={{ color: "#6b7280", fontSize: 12, marginTop: 2 }}>{t("languageModal.rtlNote")}</Text>
                        )}
                      </View>
                      {savingLang && isSelected && (
                        <LoadingSpinner size="small" color={Colors.primary} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </Modal>
      </ScrollView>

      {/* Preset Avatar Picker Modal */}
      <Modal
        visible={presetModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setPresetModalOpen(false)}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" }}>
          <View style={{ backgroundColor: "#0a1a0f", borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 40 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 20, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" }}>
              <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700" }}>{t("photoOptions.chooseAvatar")}</Text>
              <TouchableOpacity onPress={() => setPresetModalOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Feather name="x" size={22} color="#9ca3af" />
              </TouchableOpacity>
            </View>
            <Text style={{ color: "#6b7280", fontSize: 13, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
              {t("errors.avatarPickerDesc")}
            </Text>
            <FlatList
              data={AVATAR_PRESETS}
              keyExtractor={item => item.id}
              numColumns={4}
              contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8 }}
              columnWrapperStyle={{ gap: 10 }}
              scrollEnabled={false}
              renderItem={({ item }) => {
                const isActive = user?.profileImage === `preset:${item.id}`;
                return (
                  <TouchableOpacity
                    onPress={() => handleSelectPreset(item.id)}
                    style={{
                      flex: 1,
                      aspectRatio: 1,
                      borderRadius: 12,
                      overflow: "hidden",
                      borderWidth: 2,
                      borderColor: isActive ? Colors.primary : "transparent",
                      marginBottom: 10,
                    }}
                    activeOpacity={0.8}
                  >
                    <SvgXml xml={item.svgXml} width="100%" height="100%" />
                    {isActive && (
                      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(26,122,74,0.3)", justifyContent: "center", alignItems: "center" }}>
                        <Feather name="check-circle" size={20} color={Colors.primary} />
                      </View>
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>

      {/* Club Switcher Modal — super_admin only */}
      <Modal
        visible={clubSwitcherOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setClubSwitcherOpen(false)}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" }}>
          <View style={{ backgroundColor: "#0a1a0f", borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 40, maxHeight: "70%" }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 20, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" }}>
              <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700" }}>{t("errors.switchClubTitle")}</Text>
              <TouchableOpacity onPress={() => setClubSwitcherOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Feather name="x" size={22} color="#9ca3af" />
              </TouchableOpacity>
            </View>
            <FlatList
              data={clubs}
              keyExtractor={item => String(item.id)}
              contentContainerStyle={{ paddingVertical: 8 }}
              renderItem={({ item }) => {
                const isActive = item.id === activeOrgId;
                return (
                  <TouchableOpacity
                    onPress={() => { void switchClub(item.id); setClubSwitcherOpen(false); }}
                    activeOpacity={0.7}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingHorizontal: 20,
                      paddingVertical: 14,
                      borderBottomWidth: 1,
                      borderBottomColor: "rgba(255,255,255,0.06)",
                      backgroundColor: isActive ? "rgba(26,122,74,0.12)" : "transparent",
                    }}
                  >
                    <Ionicons name="business-outline" size={18} color={isActive ? Colors.primary : Colors.muted} style={{ marginRight: 12 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: isActive ? Colors.primary : "#fff", fontSize: 15, fontWeight: isActive ? "700" : "400" }}>
                        {item.name}
                      </Text>
                      <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 2 }}>
                        {item.slug} · {item.subscriptionTier.charAt(0).toUpperCase() + item.subscriptionTier.slice(1)}
                      </Text>
                    </View>
                    {isActive && <Feather name="check" size={18} color={Colors.primary} />}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, backgroundColor: Colors.background, justifyContent: "center", alignItems: "center" },
  header: { alignItems: "center", paddingTop: 32, paddingBottom: 24, paddingHorizontal: 24 },
  clubLogo: { width: 48, height: 48, marginBottom: 12 },
  avatarWrapper: { position: "relative", marginBottom: 14 },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.primary, justifyContent: "center", alignItems: "center" },
  avatarImg: { width: 80, height: 80, borderRadius: 40 },
  avatarText: { fontSize: 28, fontWeight: "800", color: "#fff" },
  avatarEditBadge: { position: "absolute", bottom: 0, right: 0, width: 22, height: 22, borderRadius: 11, backgroundColor: Colors.primary, borderWidth: 2, borderColor: Colors.background, justifyContent: "center", alignItems: "center" },
  name: { fontSize: 22, fontWeight: "800", color: "#fff", marginBottom: 4 },
  email: { fontSize: 13, color: Colors.tabIconDefault, marginBottom: 8 },
  roleBadge: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: `${Colors.primary}22`, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  roleText: { fontSize: 10, color: Colors.primary, fontWeight: "700", letterSpacing: 1 },
  unverifiedBadge: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#451a03", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 6 },
  unverifiedText: { fontSize: 11, color: "#f59e0b", fontWeight: "600" },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: 16, gap: 10, marginBottom: 24 },
  statCard: { flex: 1, minWidth: "45%", backgroundColor: Colors.surface, borderRadius: 12, padding: 16, alignItems: "center", borderWidth: 1, borderColor: Colors.border },
  statValue: { fontSize: 26, fontWeight: "900", color: Colors.primary, marginBottom: 4 },
  statLabel: { fontSize: 11, color: Colors.tabIconDefault, textTransform: "uppercase", letterSpacing: 1 },
  section: { marginHorizontal: 16, marginBottom: 24 },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: Colors.tabIconDefault, textTransform: "uppercase", letterSpacing: 2, marginBottom: 10 },
  emptyCard: { backgroundColor: Colors.surface, borderRadius: 12, padding: 24, alignItems: "center", borderWidth: 1, borderColor: Colors.border, gap: 8 },
  emptyText: { fontSize: 14, fontWeight: "600", color: "#fff" },
  emptySubText: { fontSize: 12, color: Colors.tabIconDefault, textAlign: "center" },
  tournamentCard: { backgroundColor: Colors.surface, borderRadius: 10, marginBottom: 8, borderWidth: 1, borderColor: Colors.border, overflow: "hidden" },
  tournamentCardHeader: { flexDirection: "row", alignItems: "center", padding: 14 },
  tournamentName: { fontSize: 14, fontWeight: "600", color: "#fff", marginBottom: 2 },
  tournamentDate: { fontSize: 12, color: Colors.tabIconDefault },
  statusBadge: { backgroundColor: "#1f2937", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  statusBadgeActive: { backgroundColor: `${Colors.primary}30` },
  statusText: { fontSize: 10, fontWeight: "700", color: Colors.tabIconDefault, letterSpacing: 1 },
  statusTextActive: { color: Colors.primary },
  scoreHistoryBody: { paddingHorizontal: 12, paddingBottom: 12, borderTopWidth: 1, borderTopColor: Colors.border },
  playerCtx: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 10 },
  playerCtxRow: { backgroundColor: Colors.background, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: "44%" },
  playerCtxLabel: { fontSize: 10, color: Colors.tabIconDefault, textTransform: "uppercase", letterSpacing: 0.5 },
  playerCtxValue: { fontSize: 13, color: "#fff", fontWeight: "600", marginTop: 2 },
  noScores: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12, justifyContent: "center" },
  noScoresText: { fontSize: 13, color: Colors.tabIconDefault },
  histError: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10 },
  histErrorText: { flex: 1, fontSize: 12, color: "#f59e0b" },
  menuCard: { backgroundColor: Colors.surface, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, overflow: "hidden" },
  menuItem: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.border, gap: 12 },
  menuItemLast: { borderBottomWidth: 0 },
  logoutItem: {},
  menuText: { flex: 1, fontSize: 15, color: "#fff", fontWeight: "500" },
});
