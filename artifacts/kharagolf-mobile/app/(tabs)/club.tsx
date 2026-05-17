import React from "react";
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather, Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import Colors from "@/constants/colors";
import { useActiveClub } from "@/context/activeClub";
import { useTheme } from "@/theme";

const GOLD = "#C9A84C";

interface ServiceTile {
  icon: React.ReactNode;
  label: string;
  description: string;
  route: string;
}

const SERVICES: ServiceTile[] = [
  {
    icon: <Feather name="clock" size={22} color={GOLD} />,
    label: "Tee Bookings",
    description: "Book & manage tee times",
    route: "/tee-bookings",
  },
  {
    icon: <Ionicons name="golf" size={22} color={GOLD} />,
    label: "Driving Range",
    description: "Reserve practice bays",
    route: "/(tabs)/range",
  },
  {
    icon: <Feather name="book-open" size={22} color={GOLD} />,
    label: "Lessons",
    description: "Book coaching sessions",
    route: "/(tabs)/lessons",
  },
  {
    icon: <Feather name="coffee" size={22} color={GOLD} />,
    label: "F&B Order",
    description: "On-course food & drinks",
    route: "/(tabs)/order",
  },
  {
    icon: <Feather name="shopping-bag" size={22} color={GOLD} />,
    label: "Pro Shop",
    description: "Equipment & apparel",
    route: "/(tabs)/shop",
  },
  {
    icon: <Feather name="package" size={22} color={GOLD} />,
    label: "Rentals",
    description: "Clubs, carts & gear",
    route: "/(tabs)/rentals",
  },
  {
    icon: <Feather name="users" size={22} color={GOLD} />,
    label: "Caddies",
    description: "Book a caddie",
    route: "/caddies",
  },
  {
    icon: <Feather name="user-plus" size={22} color={GOLD} />,
    label: "Guest Passes",
    description: "Invite non-members",
    route: "/guest-passes",
  },
  {
    icon: <Ionicons name="star" size={22} color={GOLD} />,
    label: "Fantasy Golf",
    description: "Pick your dream team",
    route: "/(tabs)/fantasy",
  },
  {
    icon: <Feather name="map-pin" size={22} color={GOLD} />,
    label: "Golf Trips",
    description: "Away day planner",
    route: "/(tabs)/trips",
  },
  {
    icon: <Feather name="sun" size={22} color={GOLD} />,
    label: "Course",
    description: "Conditions & closures",
    route: "/(tabs)/course-conditions",
  },
  {
    icon: <Ionicons name="school" size={22} color={GOLD} />,
    label: "Junior",
    description: "Junior programmes",
    route: "/(tabs)/junior",
  },
  {
    icon: <Feather name="book-open" size={22} color={GOLD} />,
    label: "Rules",
    description: "Golf rules assistant",
    route: "/(tabs)/rules",
  },
  {
    icon: <Feather name="clipboard" size={22} color={GOLD} />,
    label: "Surveys",
    description: "Member feedback",
    route: "/(tabs)/surveys",
  },
  {
    icon: <Feather name="shield" size={22} color={GOLD} />,
    label: "Club Docs",
    description: "Governance & policies",
    route: "/(tabs)/governance",
  },
  {
    icon: <Feather name="file-text" size={22} color={GOLD} />,
    label: "Documents",
    description: "Rules, notices & policies",
    route: "/(tabs)/documents",
  },
  {
    icon: <Feather name="bell" size={22} color={GOLD} />,
    label: "Updates",
    description: "Notices & alerts",
    route: "/(tabs)/updates",
  },
  {
    icon: <Ionicons name="stats-chart" size={22} color={GOLD} />,
    label: "My Stats",
    description: "Detailed analytics",
    route: "/(tabs)/stats",
  },
  {
    icon: <Feather name="message-square" size={22} color={GOLD} />,
    label: "Club Feed",
    description: "Member social feed",
    route: "/(tabs)/feed",
  },
  {
    icon: <Feather name="credit-card" size={22} color={GOLD} />,
    label: "Wallet",
    description: "Top up & view ledger",
    route: "/wallet",
  },
];

export default function ClubScreen() {
  const { activeClub } = useActiveClub();
  const { logoUrl, customized } = useTheme();
  // Only render the saved logo when the club has a customised theme row
  // with a logo URL. We deliberately mirror the player tab bar's
  // `customized`-gated logic from Task #1438 so the legacy `activeClub`
  // fallback during initial load doesn't flash a stale logo.
  const showLogo = customized && !!logoUrl;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {/* Club header */}
      <View style={styles.header}>
        <View style={styles.clubIcon}>
          {showLogo ? (
            <Image
              source={{ uri: logoUrl! }}
              style={styles.clubLogo}
              resizeMode="contain"
              accessibilityLabel={activeClub?.name ?? "Club logo"}
            />
          ) : (
            <Feather name="flag" size={20} color={GOLD} />
          )}
        </View>
        <View style={styles.headerText}>
          <Text style={styles.headerLabel}>YOUR CLUB</Text>
          <Text style={styles.headerName} numberOfLines={1}>
            {activeClub?.name ?? "KHARAGOLF"}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.sectionTitle}>CLUB SERVICES</Text>
        <View style={styles.grid}>
          {SERVICES.map((s) => (
            <TouchableOpacity
              key={s.label}
              style={styles.tile}
              onPress={() => router.push(s.route as Parameters<typeof router.push>[0])}
              activeOpacity={0.72}
            >
              <View style={styles.tileIconWrap}>{s.icon}</View>
              <Text style={styles.tileLabel}>{s.label}</Text>
              <Text style={styles.tileDesc} numberOfLines={1}>{s.description}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  clubIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: GOLD + "50",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  clubLogo: {
    width: 36,
    height: 36,
  },
  headerText: {
    flex: 1,
  },
  headerLabel: {
    fontSize: 10,
    color: Colors.muted,
    letterSpacing: 1.8,
    fontFamily: "Inter_500Medium",
  },
  headerName: {
    fontSize: 18,
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    marginTop: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 110,
  },
  sectionTitle: {
    fontSize: 11,
    color: Colors.textSecondary,
    letterSpacing: 1.8,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 14,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  tile: {
    width: "47.5%",
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  tileIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  tileLabel: {
    fontSize: 14,
    color: Colors.text,
    fontFamily: "Inter_600SemiBold",
  },
  tileDesc: {
    fontSize: 12,
    color: Colors.muted,
    fontFamily: "Inter_400Regular",
  },
});
