import React from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";
import { TieBreakEmailOptOutsCard } from "@/components/TieBreakEmailOptOutsCard";
import { ScheduleChangeOptOutsCard } from "@/components/ScheduleChangeOptOutsCard";
import { ScheduleChangeLastSentCard } from "@/components/ScheduleChangeLastSentCard";
import { BouncedDigestPrefsCard } from "@/components/BouncedDigestPrefsCard";
import { OrgNotificationDefaultsCard } from "@/components/OrgNotificationDefaultsCard";
import { MemberCommPrefsHistoryCard } from "@/components/MemberCommPrefsHistoryCard";

const GOLD = "#C9A84C";

// Roles permitted to view this screen. Mirrors the same gate used for the
// More-menu entry in `app/(tabs)/more.tsx` and the web `club-settings.tsx`
// page. Server endpoints are still the security boundary (each panel also
// self-hides on 401/403); this is a UX-level guard for direct deep-links.
const ADMIN_ROLES = new Set(["super_admin", "org_admin", "tournament_director"]);

/**
 * Mobile mirror of the web `club-settings.tsx` page (Task #1687). Hosts the
 * admin-only club / org settings panels — currently just the tie-break
 * email opt-outs card moved out of the Notifications tab where it sat
 * inline as a stop-gap (Task #1402). Future admin email panels (schedule
 * change opt-outs, bounced digest prefs, org notification defaults, …)
 * belong on this screen too.
 *
 * Non-admin users who somehow reach this URL (e.g. a stale deep link) see a
 * "not available" message instead of an empty page shell. Each panel also
 * self-hides on 401/403 as a defense-in-depth backstop.
 */
export default function ClubSettingsScreen() {
  const { t } = useTranslation(["clubSettings", "common"]);
  const { token, user } = useAuth();
  const { activeOrgId, activeClub } = useActiveClub();
  const canGoBack = router.canGoBack();
  const isAdmin = !!user && ADMIN_ROLES.has(user.role);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        {canGoBack ? (
          <TouchableOpacity
            onPress={() => router.back()}
            style={{ padding: 4 }}
            accessibilityLabel={t("common:back")}
          >
            <Feather name="chevron-left" size={24} color={Colors.text} />
          </TouchableOpacity>
        ) : null}
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Feather name="shield" size={18} color={GOLD} />
            <Text style={styles.title}>{t("clubSettings:title")}</Text>
          </View>
          <Text style={styles.subtitle}>
            {activeClub?.name
              ? t("clubSettings:subtitleWithClub", { club: activeClub.name })
              : t("clubSettings:subtitleNoClub")}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {isAdmin ? (
          <>
            <TieBreakEmailOptOutsCard orgId={activeOrgId} token={token} />
            {/* Task #2097 — Sibling audit panel of the opt-outs card
                below: lists the most recent schedule-change heads-up
                emails (timestamp, who triggered them, recipient list)
                with a per-row Resend button so mobile-only org admins
                can answer "did Jane actually get the email?" and
                re-dispatch a previous send. Mirrors the web's
                "Schedule-change notifications — last sent" panel
                (Task #513 / #655 / #947). Rendered above the opt-outs
                card to match the web order. Same self-hide behaviour
                on 401/403. */}
            <ScheduleChangeLastSentCard orgId={activeOrgId} token={token} />
            {/* Task #1688 — Sibling of the tie-break card above: lists
                members who opted out of the bounced-digest schedule-change
                heads-up emails (web's `ScheduleChangeOptOutsCard`,
                Task #387 / #512), so mobile-only org admins can also see
                who has silenced those emails and re-subscribe them. Same
                self-hide behaviour on 401/403. */}
            <ScheduleChangeOptOutsCard orgId={activeOrgId} token={token} />
            {/* Task #2099 — Bounced-reminders email digest preferences
                (web's `BouncedDigestPrefsCard`, Task #274). Lets a
                travelling org admin pick the cadence (daily / weekday /
                weekly), preferred local hour, and IANA timezone for the
                bounced-levy reminders email digest, and send themselves
                a one-off preview. Same self-hide behaviour on 401/403. */}
            <BouncedDigestPrefsCard orgId={activeOrgId} token={token} />
            {/* Task #2099 — Club-wide notification defaults
                (web's `OrgNotificationDefaultsCard`, Tasks #1188 / #1379
                / #1673). Mobile equivalent of the per-toggle club-wide
                switch + "Apply to all (N)" affordance. Same self-hide
                behaviour on 401/403. */}
            <OrgNotificationDefaultsCard orgId={activeOrgId} token={token} />
            {/* Task #1853 — mobile mirror of the per-member notification
                preference change timeline that lives in the Players page
                expanded row on the web (Task #1505). Lets mobile-only org
                admins look up any member and see who flipped their notif
                prefs and when. Same self-hide behaviour on 401/403. */}
            <MemberCommPrefsHistoryCard orgId={activeOrgId} token={token} />
          </>
        ) : (
          <View style={styles.notAvailable} testID="text-club-settings-not-available">
            <Feather name="lock" size={28} color={Colors.muted} />
            <Text style={styles.notAvailableTitle}>{t("clubSettings:notAvailableTitle")}</Text>
            <Text style={styles.notAvailableText}>
              {t("clubSettings:notAvailableText")}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 20, fontWeight: "700", color: Colors.text },
  subtitle: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  scroll: { flex: 1 },
  notAvailable: {
    alignItems: "center",
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  notAvailableTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: "600",
    marginTop: 12,
  },
  notAvailableText: {
    color: Colors.muted,
    fontSize: 13,
    textAlign: "center",
    marginTop: 6,
    lineHeight: 18,
  },
});
