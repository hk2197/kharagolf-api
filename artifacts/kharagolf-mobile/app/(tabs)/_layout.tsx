import { BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useBadgePolling, useMoreBadges } from "@/context/moreBadges";
import { useUnread } from "@/context/unread";
import { useTheme } from "@/theme";
import { useTranslation } from "react-i18next";

/**
 * Default KHARAGOLF gold accent — kept exported for the many screens that
 * still reference the brand colour directly. The tab bar itself prefers
 * the active org's accent token (Task #1438) so a club's saved theme is
 * reflected on the player tabs.
 */
export const GOLD = "#C9A84C";
export const ICON_SIZE = 26;
export const TAB_BAR_HEIGHT = 72;

const hidden = { href: null } as const;

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

function TabIcon({
  name,
  nameActive,
  color,
  focused,
}: {
  name: IoniconName;
  nameActive: IoniconName;
  color: string;
  focused: boolean;
}) {
  return (
    <Ionicons
      name={focused ? nameActive : name}
      size={ICON_SIZE}
      color={color}
    />
  );
}

export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
    <View pointerEvents="none" style={tabBarLayoutStyles.badgeWrap}>
      <View style={tabBarLayoutStyles.badge}>
        <Text style={tabBarLayoutStyles.badgeText} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </View>
  );
}

export default function TabLayout() {
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const insets = useSafeAreaInsets();
  const { total: moreTotal } = useMoreBadges();
  // The bottom tab bar surfaces the aggregated More-tab badge on every
  // primary screen, so we keep badge polling alive for the entire time
  // the user is inside the tab navigator. Outside of (tabs) — auth
  // screens, modals, deep links to standalone routes — the bar isn't
  // mounted and polling pauses automatically.
  useBadgePolling();
  const { notifUnreadCount } = useUnread();
  const { t } = useTranslation("navigation");
  // Task #1438 — apply the active club's accent to the tab bar so the
  // player nav reflects the saved theme. Falls back to the default
  // KHARAGOLF gold when the org hasn't customised.
  const { tokens, customized } = useTheme();
  const tabAccent = customized ? tokens.colors.accent : GOLD;
  // The More tab aggregates every row that carries an unread/attention
  // signal (Notifications + Wallet + Feed + Updates) so the user can
  // tell at a glance there's something behind the dropdown without
  // opening it. We deliberately do not add the legacy useUnread()
  // counter here — it tracks tournament announcements using the same
  // last-seen marker that `MoreBadgesProvider.updates` already counts,
  // so adding it would double-count announcement unread items.

  const bottomInset = isWeb ? 12 : Math.max(insets.bottom, 8);
  const tabBarHeight = TAB_BAR_HEIGHT + (isWeb ? 0 : bottomInset);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: tabAccent,
        tabBarInactiveTintColor: Colors.tabIconDefault,
        tabBarStyle: {
          position: "absolute",
          height: tabBarHeight,
          paddingBottom: bottomInset,
          paddingTop: 8,
          backgroundColor: isIOS ? "transparent" : Colors.surface,
          borderTopWidth: 1,
          borderTopColor: tabAccent + "30",
          elevation: 0,
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView intensity={85} tint="dark" style={StyleSheet.absoluteFill} />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: Colors.surface }]} />
          ),
        tabBarLabelStyle: {
          fontSize: 11,
          fontFamily: "Inter_500Medium",
          letterSpacing: 0.3,
          marginTop: 4,
          marginBottom: 0,
        },
        tabBarItemStyle: {
          paddingTop: 0,
          paddingBottom: 0,
          justifyContent: "center",
        },
        tabBarIconStyle: {
          marginTop: 0,
          marginBottom: 0,
        },
      }}
    >
      {/* ── 4 primary tabs ────────────────────────────────────────── */}

      <Tabs.Screen
        name="index"
        options={{
          title: t("home"),
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="home-outline" nameActive="home" color={color} focused={focused} />
          ),
        }}
      />

      <Tabs.Screen
        name="score"
        options={{
          title: t("play"),
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="golf-outline" nameActive="golf" color={color} focused={focused} />
          ),
        }}
      />

      <Tabs.Screen
        name="leaderboard"
        options={{
          title: t("compete"),
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="trophy-outline" nameActive="trophy" color={color} focused={focused} />
          ),
        }}
      />

      <Tabs.Screen
        name="notifications"
        options={{
          title: t("notifications", { defaultValue: "Notifications" }),
          tabBarAccessibilityLabel:
            notifUnreadCount > 0
              ? `${t("notifications", { defaultValue: "Notifications" })}, ${notifUnreadCount} unread`
              : t("notifications", { defaultValue: "Notifications" }),
          tabBarIcon: ({ color, focused }) => (
            <View style={tabBarLayoutStyles.iconContainer}>
              <TabIcon
                name="notifications-outline"
                nameActive="notifications"
                color={color}
                focused={focused}
              />
              <UnreadBadge count={notifUnreadCount} />
            </View>
          ),
        }}
      />

      <Tabs.Screen
        name="more"
        options={{
          title: t("more", { defaultValue: "More" }),
          tabBarIcon: ({ color, focused }) => (
            <View style={tabBarLayoutStyles.iconContainer}>
              <TabIcon
                name="ellipsis-horizontal-circle-outline"
                nameActive="ellipsis-horizontal-circle"
                color={color}
                focused={focused}
              />
              <UnreadBadge count={moreTotal} />
            </View>
          ),
        }}
      />

      {/* ── Hidden screens — accessible via router.push or the More sheet ── */}
      <Tabs.Screen name="profile" options={hidden} />
      <Tabs.Screen name="club" options={hidden} />
      <Tabs.Screen name="marker" options={hidden} />
      <Tabs.Screen name="feed" options={hidden} />
      <Tabs.Screen name="updates" options={hidden} />
      <Tabs.Screen name="leagues" options={hidden} />
      <Tabs.Screen name="match-play" options={hidden} />
      <Tabs.Screen name="rules" options={hidden} />
      <Tabs.Screen name="range" options={hidden} />
      <Tabs.Screen name="order" options={hidden} />
      <Tabs.Screen name="fantasy" options={hidden} />
      <Tabs.Screen name="shop" options={hidden} />
      <Tabs.Screen name="junior" options={hidden} />
      <Tabs.Screen name="stats" options={hidden} />
      <Tabs.Screen name="lessons" options={hidden} />
      <Tabs.Screen name="coach" options={hidden} />
      <Tabs.Screen name="governance" options={hidden} />
      <Tabs.Screen name="documents" options={hidden} />
      <Tabs.Screen name="trips" options={hidden} />
      <Tabs.Screen name="rentals" options={hidden} />
      <Tabs.Screen name="course-conditions" options={hidden} />
      <Tabs.Screen name="surveys" options={hidden} />
    </Tabs>
  );
}

export const tabBarLayoutStyles = StyleSheet.create({
  iconContainer: {
    width: ICON_SIZE + 12,
    height: ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeWrap: {
    position: "absolute",
    top: -8,
    right: -10,
  },
  badge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: Colors.error,
    borderWidth: 1.5,
    borderColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#ffffff",
    fontSize: 10,
    lineHeight: 12,
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
    includeFontPadding: false,
    textAlign: "center",
  },
});
