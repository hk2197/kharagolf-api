import React, { useMemo, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { useBadgePolling, useMoreBadges } from "@/context/moreBadges";
import {
  buildSettingsIndex,
  filterSettingsIndex,
  type SettingsIndexEntry,
} from "@/lib/settingsIndex";

// Roles that should see the admin-only "Club settings" entry. Mirrors the
// gate the web `club-settings.tsx` page applies (super_admin / org_admin /
// tournament_director). The destination panels also self-hide on 401/403,
// so this is a UX nicety, not the security boundary.
const ADMIN_ROLES = new Set(["super_admin", "org_admin", "tournament_director"]);

const GOLD = "#C9A84C";

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

type Item = {
  key: string;
  label: string;
  icon: IoniconName;
  href: string;
  badge?: number;
};

type Section = {
  key: string;
  title: string;
  items: Item[];
};

export default function MoreScreen() {
  const insets = useSafeAreaInsets();
  const { counts } = useMoreBadges();
  // Keep the per-row badge counts on this screen fresh while the user
  // is browsing the More menu; polling pauses again the moment they
  // navigate away.
  useBadgePolling();
  const { t } = useTranslation("navigation");
  // The settings-search index reads localised labels from both the
  // navigation bundle (More-tab destinations) and the profile bundle
  // (per-event email opt-out rows on /my-360/communications), so we
  // need a translator that can resolve keys in either namespace.
  const { t: profileT } = useTranslation("profile");
  const { user } = useAuth();
  const isAdmin = !!user && ADMIN_ROLES.has(user.role);

  // Task #1836 — surface every notification toggle (and every More-tab
  // destination) in a single searchable index so members hunting for
  // "side game receipts" or "wallet" can land on the right row in one
  // hop, instead of scrolling the whole comms screen. The same pattern
  // generalises to any future toggle added to the index.
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();

  const settingsIndex = useMemo(
    () => {
      // Compose a translator that probes the navigation bundle first
      // (most entries live there) and falls back to profile so the
      // per-event opt-out labels resolve too. The sentinel default
      // value avoids relying on `i18n.exists`, which isn't always
      // present on stub i18n instances used by tests.
      const NO_VALUE = "__no_translation__";
      const navAny = t as unknown as (key: string, opts?: object) => string;
      const profileAny = profileT as unknown as (key: string, opts?: object) => string;
      const composed = ((key: string, opts?: object) => {
        const merged = { defaultValue: NO_VALUE, ...(opts ?? {}) };
        const navHit = navAny(key, merged);
        if (navHit !== NO_VALUE && navHit !== key) return navHit;
        return profileAny(key, opts);
      }) as Parameters<typeof buildSettingsIndex>[0];
      return buildSettingsIndex(composed, { isAdmin });
    },
    [t, profileT, isAdmin],
  );

  const searchResults = useMemo(
    () => (trimmedQuery ? filterSettingsIndex(settingsIndex, trimmedQuery) : []),
    [settingsIndex, trimmedQuery],
  );

  const sections: Section[] = [
    {
      key: "account",
      title: t("moreSections.account"),
      items: [
        {
          key: "profile",
          label: t("moreItems.profile"),
          icon: "person-circle-outline",
          href: "/(tabs)/profile",
        },
        {
          key: "club",
          label: t("moreItems.club"),
          icon: "flag-outline",
          href: "/(tabs)/club",
        },
        // Task #1687 — admin-only entry into the new club-settings screen
        // that hosts the tie-break email opt-outs panel (and any future
        // org/admin email controls). Non-admin users never see this row.
        ...(isAdmin
          ? [
              {
                key: "club-settings",
                label: t("moreItems.clubSettings"),
                icon: "shield-checkmark-outline" as IoniconName,
                href: "/club-admin/club-settings",
              },
            ]
          : []),
        {
          key: "notifications",
          label: t("moreItems.notifications"),
          icon: "notifications-outline",
          href: "/notifications",
          badge: counts.notifications,
        },
        {
          key: "wallet",
          label: t("moreItems.wallet"),
          icon: "wallet-outline",
          href: "/wallet",
          badge: counts.wallet,
        },
      ],
    },
    {
      key: "compete",
      title: t("moreSections.compete"),
      items: [
        {
          key: "leagues",
          label: t("moreItems.leagues"),
          icon: "ribbon-outline",
          href: "/(tabs)/leagues",
        },
        {
          key: "match-play",
          label: t("moreItems.matchPlay"),
          icon: "git-network-outline",
          href: "/(tabs)/match-play",
        },
        {
          key: "fantasy",
          label: t("moreItems.fantasy"),
          icon: "sparkles-outline",
          href: "/(tabs)/fantasy",
        },
        {
          key: "feed",
          label: t("moreItems.feed"),
          icon: "newspaper-outline",
          href: "/(tabs)/feed",
          badge: counts.feed,
        },
        {
          key: "updates",
          label: t("moreItems.updates"),
          icon: "megaphone-outline",
          href: "/(tabs)/updates",
          badge: counts.updates,
        },
      ],
    },
    {
      key: "practiceImprove",
      title: t("moreSections.practiceImprove"),
      items: [
        {
          key: "range",
          label: t("moreItems.range"),
          icon: "locate-outline",
          href: "/(tabs)/range",
        },
        {
          key: "lessons",
          label: t("moreItems.lessons"),
          icon: "school-outline",
          href: "/(tabs)/lessons",
        },
        {
          key: "coach",
          label: t("moreItems.coach"),
          icon: "person-outline",
          href: "/(tabs)/coach",
        },
        {
          key: "stats",
          label: t("moreItems.stats"),
          icon: "stats-chart-outline",
          href: "/(tabs)/stats",
        },
        {
          key: "junior",
          label: t("moreItems.junior"),
          icon: "happy-outline",
          href: "/(tabs)/junior",
        },
      ],
    },
    {
      key: "courseBookings",
      title: t("moreSections.courseBookings"),
      items: [
        {
          key: "marker",
          label: t("moreItems.marker"),
          icon: "create-outline",
          href: "/(tabs)/marker",
        },
        {
          key: "course-conditions",
          label: t("moreItems.courseConditions"),
          icon: "leaf-outline",
          href: "/(tabs)/course-conditions",
        },
        {
          key: "rentals",
          label: t("moreItems.rentals"),
          icon: "bag-handle-outline",
          href: "/(tabs)/rentals",
        },
        {
          key: "trips",
          label: t("moreItems.trips"),
          icon: "airplane-outline",
          href: "/(tabs)/trips",
        },
      ],
    },
    {
      key: "shopOrders",
      title: t("moreSections.shopOrders"),
      items: [
        {
          key: "shop",
          label: t("moreItems.shop"),
          icon: "cart-outline",
          href: "/(tabs)/shop",
        },
        {
          key: "order",
          label: t("moreItems.orders"),
          icon: "receipt-outline",
          href: "/(tabs)/order",
        },
      ],
    },
    {
      key: "information",
      title: t("moreSections.information"),
      items: [
        {
          key: "rules",
          label: t("moreItems.rules"),
          icon: "book-outline",
          href: "/(tabs)/rules",
        },
        {
          key: "governance",
          label: t("moreItems.governance"),
          icon: "shield-checkmark-outline",
          href: "/(tabs)/governance",
        },
        {
          key: "documents",
          label: t("moreItems.documents"),
          icon: "document-text-outline",
          href: "/(tabs)/documents",
        },
        {
          key: "surveys",
          label: t("moreItems.surveys"),
          icon: "clipboard-outline",
          href: "/(tabs)/surveys",
        },
      ],
    },
  ];

  const isSearching = trimmedQuery.length > 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t("more")}</Text>
      </View>
      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Ionicons
            name="search"
            size={18}
            color={Colors.textSecondary}
            style={styles.searchIcon}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("settingsSearch.placeholder")}
            placeholderTextColor={Colors.textSecondary}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel={t("settingsSearch.placeholder")}
            testID="input-settings-search"
          />
          {isSearching && (
            <TouchableOpacity
              onPress={() => setQuery("")}
              accessibilityRole="button"
              accessibilityLabel={t("settingsSearch.clear")}
              testID="btn-settings-search-clear"
              hitSlop={8}
            >
              <Ionicons
                name="close-circle"
                size={18}
                color={Colors.textSecondary}
              />
            </TouchableOpacity>
          )}
        </View>
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: insets.bottom + 96 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {isSearching ? (
          <View style={styles.section} testID="section-settings-search-results">
            <Text style={styles.sectionTitle}>
              {t("settingsSearch.resultsTitle")}
            </Text>
            {searchResults.length === 0 ? (
              <View style={styles.card}>
                <Text style={styles.emptyText} testID="text-settings-search-empty">
                  {t("settingsSearch.noResults", { query: trimmedQuery })}
                </Text>
              </View>
            ) : (
              <View style={styles.card}>
                {searchResults.map((entry, idx) => (
                  <SearchResultRow
                    key={entry.id}
                    entry={entry}
                    isLast={idx === searchResults.length - 1}
                  />
                ))}
              </View>
            )}
          </View>
        ) : (
          sections.map((section) => (
            <View key={section.key} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <View style={styles.card}>
                {section.items.map((item, idx) => (
                  <Row
                    key={item.key}
                    item={item}
                    isLast={idx === section.items.length - 1}
                  />
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function Row({ item, isLast }: { item: Item; isLast: boolean }) {
  const onPress = () => router.push(item.href as never);
  const showBadge = (item.badge ?? 0) > 0;
  const badgeLabel =
    (item.badge ?? 0) > 99 ? "99+" : String(item.badge ?? 0);
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[
        styles.row,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
      accessibilityRole="button"
      accessibilityLabel={item.label}
    >
      <View style={styles.iconWrap}>
        <Ionicons name={item.icon} size={22} color={GOLD} />
      </View>
      <Text style={styles.rowLabel}>{item.label}</Text>
      {showBadge && (
        <View style={styles.rowBadge}>
          <Text style={styles.rowBadgeText}>{badgeLabel}</Text>
        </View>
      )}
      <Ionicons
        name="chevron-forward"
        size={18}
        color={Colors.textSecondary}
      />
    </TouchableOpacity>
  );
}

function SearchResultRow({
  entry,
  isLast,
}: {
  entry: SettingsIndexEntry;
  isLast: boolean;
}) {
  const onPress = () => {
    if (entry.params) {
      router.push({ pathname: entry.href as never, params: entry.params } as never);
    } else {
      router.push(entry.href as never);
    }
  };
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[
        styles.searchRow,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      testID={`row-settings-search-${entry.id}`}
    >
      <View style={styles.searchRowBody}>
        <Text style={styles.rowLabel} numberOfLines={2}>
          {entry.label}
        </Text>
        {entry.breadcrumb ? (
          <Text style={styles.searchBreadcrumb}>{entry.breadcrumb}</Text>
        ) : null}
        {entry.description ? (
          <Text style={styles.searchDescription} numberOfLines={2}>
            {entry.description}
          </Text>
        ) : null}
      </View>
      <Ionicons
        name="chevron-forward"
        size={18}
        color={Colors.textSecondary}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    fontWeight: "700",
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: GOLD + "26",
    paddingHorizontal: 12,
    minHeight: 44,
  },
  searchIcon: { marginRight: 8 },
  searchInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 15,
    paddingVertical: 8,
    fontFamily: "Inter_400Regular",
  },
  scroll: {
    paddingHorizontal: 16,
  },
  section: { marginBottom: 18 },
  sectionTitle: {
    color: Colors.textSecondary,
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginLeft: 4,
    marginBottom: 8,
    fontFamily: "Inter_600SemiBold",
    fontWeight: "600",
  },
  card: {
    backgroundColor: Colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GOLD + "26",
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomColor: Colors.border,
    minHeight: 56,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: GOLD + "1A",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  rowLabel: {
    flex: 1,
    color: Colors.text,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
  },
  rowBadge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: 11,
    backgroundColor: Colors.error,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  rowBadgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
    includeFontPadding: false,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomColor: Colors.border,
    minHeight: 56,
  },
  searchRowBody: {
    flex: 1,
    paddingRight: 8,
  },
  searchBreadcrumb: {
    color: Colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
  },
  searchDescription: {
    color: Colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
    fontFamily: "Inter_400Regular",
  },
  emptyText: {
    color: Colors.textSecondary,
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 18,
    textAlign: "center",
    fontFamily: "Inter_400Regular",
  },
});
