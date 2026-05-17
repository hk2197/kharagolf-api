import React, { useState, useCallback } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { BASE_URL } from "@/utils/api";

function API(path: string) {
  return `${BASE_URL}/api${path}`;
}

const AGE_CATEGORIES = [
  { value: "under_8", label: "U8" },
  { value: "under_10", label: "U10" },
  { value: "under_12", label: "U12" },
  { value: "under_14", label: "U14" },
  { value: "under_16", label: "U16" },
  { value: "under_18", label: "U18" },
];

const PATHWAY_LEVELS = [
  { value: "beginner", label: "Beginner", color: "#3b82f6" },
  { value: "intermediate", label: "Intermediate", color: "#f59e0b" },
  { value: "advanced", label: "Advanced", color: "#f97316" },
  { value: "elite", label: "Elite", color: "#a855f7" },
];

function ageCategoryLabel(val: string) {
  return AGE_CATEGORIES.find(a => a.value === val)?.label ?? val;
}
function pathwayLevelLabel(val: string) {
  return PATHWAY_LEVELS.find(l => l.value === val)?.label ?? val;
}
function pathwayLevelColor(val: string) {
  return PATHWAY_LEVELS.find(l => l.value === val)?.color ?? Colors.primary;
}

interface JuniorProfile {
  id: number;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  ageCategory: string;
  pathwayLevel: string;
  handicapIndex: string | null;
  progress: {
    pathwayName: string;
    currentLevelName: string | null;
    lastProgressedAt: string | null;
  }[];
  upcomingSessions: {
    sessionTitle: string;
    scheduledAt: string;
    durationMinutes: number;
    location: string | null;
    coachName: string | null;
    programName: string;
  }[];
  awards: {
    id: number;
    awardLabel: string;
    awardType: string;
    awardedAt: string;
  }[];
}

interface LeaderboardEntry {
  juniorProfileId: number;
  firstName: string;
  lastName: string;
  ageCategory: string;
  pathwayLevel: string;
  handicapIndex: string | null;
  roundsPlayed: number;
  avgGross: number | null;
}

// ─── My Juniors Panel ─────────────────────────────────────────────────────────
function MyJuniorsPanel({ orgId }: { orgId: number }) {
  const { data: juniors = [], isLoading, refetch, isRefetching } = useQuery<JuniorProfile[]>({
    queryKey: ["/api/organizations", orgId, "junior", "portal", "my-juniors"],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/junior/portal/my-juniors`), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load juniors");
      return res.json();
    },
    enabled: !!orgId,
  });

  const [selectedJunior, setSelectedJunior] = useState<JuniorProfile | null>(null);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner color={Colors.primary} />
      </View>
    );
  }

  if (selectedJunior) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 100 }}>
        <Pressable onPress={() => setSelectedJunior(null)} style={styles.backButton}>
          <Ionicons name="arrow-back" size={20} color={Colors.primary} />
          <Text style={styles.backText}>All Juniors</Text>
        </Pressable>

        <View style={styles.profileHeader}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {selectedJunior.firstName[0]}{selectedJunior.lastName[0]}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName}>{selectedJunior.firstName} {selectedJunior.lastName}</Text>
            <View style={styles.badgeRow}>
              <View style={styles.ageBadge}>
                <Text style={styles.ageBadgeText}>{ageCategoryLabel(selectedJunior.ageCategory)}</Text>
              </View>
              <View style={[styles.levelBadge, { backgroundColor: pathwayLevelColor(selectedJunior.pathwayLevel) + "30" }]}>
                <Text style={[styles.levelBadgeText, { color: pathwayLevelColor(selectedJunior.pathwayLevel) }]}>
                  {pathwayLevelLabel(selectedJunior.pathwayLevel)}
                </Text>
              </View>
            </View>
            {selectedJunior.handicapIndex && (
              <Text style={styles.handicapText}>Handicap: {selectedJunior.handicapIndex}</Text>
            )}
          </View>
        </View>

        {/* Development Pathway Progress */}
        {selectedJunior.progress.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Development Pathway</Text>
            {selectedJunior.progress.map((p, i) => (
              <View key={i} style={styles.progressCard}>
                <View style={styles.progressRow}>
                  <Feather name="book-open" size={14} color={Colors.primary} />
                  <Text style={styles.progressPathway}>{p.pathwayName}</Text>
                </View>
                <Text style={styles.progressLevel}>
                  Current Level: {p.currentLevelName ?? "Not started"}
                </Text>
                {p.lastProgressedAt && (
                  <Text style={styles.progressDate}>
                    Last progressed: {new Date(p.lastProgressedAt).toLocaleDateString()}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Upcoming Sessions */}
        {selectedJunior.upcomingSessions.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Upcoming Sessions</Text>
            {selectedJunior.upcomingSessions.map((s, i) => (
              <View key={i} style={styles.sessionCard}>
                <Text style={styles.sessionTitle}>{s.sessionTitle}</Text>
                <Text style={styles.sessionProgram}>{s.programName}</Text>
                <View style={styles.sessionMeta}>
                  <Ionicons name="calendar-outline" size={12} color={Colors.textSecondary} />
                  <Text style={styles.sessionMetaText}>
                    {new Date(s.scheduledAt).toLocaleDateString()} at {new Date(s.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                </View>
                {s.location && (
                  <View style={styles.sessionMeta}>
                    <Ionicons name="location-outline" size={12} color={Colors.textSecondary} />
                    <Text style={styles.sessionMetaText}>{s.location}</Text>
                  </View>
                )}
                {s.coachName && (
                  <View style={styles.sessionMeta}>
                    <Ionicons name="person-outline" size={12} color={Colors.textSecondary} />
                    <Text style={styles.sessionMetaText}>{s.coachName}</Text>
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Awards */}
        {selectedJunior.awards.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Awards & Achievements</Text>
            {selectedJunior.awards.map((a, i) => (
              <View key={i} style={styles.awardCard}>
                <Ionicons name="star" size={16} color="#f59e0b" style={{ marginRight: 8 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.awardLabel}>{a.awardLabel}</Text>
                  <Text style={styles.awardDate}>{new Date(a.awardedAt).toLocaleDateString()}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {selectedJunior.progress.length === 0 && selectedJunior.upcomingSessions.length === 0 && selectedJunior.awards.length === 0 && (
          <View style={styles.emptyState}>
            <Ionicons name="information-circle-outline" size={32} color={Colors.textSecondary} />
            <Text style={styles.emptyText}>No activity recorded yet.</Text>
          </View>
        )}
      </ScrollView>
    );
  }

  if (juniors.length === 0) {
    return (
      <View style={styles.centered}>
        <Ionicons name="school-outline" size={48} color={Colors.textSecondary} />
        <Text style={styles.emptyTitle}>No Junior Profiles</Text>
        <Text style={styles.emptySubtitle}>
          Your club hasn't linked any junior profiles to your account yet.
          Contact the club admin to get started.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={juniors}
      keyExtractor={j => String(j.id)}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={Colors.primary} />}
      contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
      ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
      renderItem={({ item: junior }) => (
        <Pressable onPress={() => setSelectedJunior(junior)} style={styles.juniorCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{junior.firstName[0]}{junior.lastName[0]}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.juniorName}>{junior.firstName} {junior.lastName}</Text>
            <View style={styles.badgeRow}>
              <View style={styles.ageBadge}>
                <Text style={styles.ageBadgeText}>{ageCategoryLabel(junior.ageCategory)}</Text>
              </View>
              <View style={[styles.levelBadge, { backgroundColor: pathwayLevelColor(junior.pathwayLevel) + "25" }]}>
                <Text style={[styles.levelBadgeText, { color: pathwayLevelColor(junior.pathwayLevel) }]}>
                  {pathwayLevelLabel(junior.pathwayLevel)}
                </Text>
              </View>
            </View>
            <Text style={styles.juniorMeta}>
              {junior.handicapIndex ? `HCP ${junior.handicapIndex}` : "No handicap"}
              {junior.upcomingSessions.length > 0 ? ` · ${junior.upcomingSessions.length} upcoming session${junior.upcomingSessions.length > 1 ? "s" : ""}` : ""}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={Colors.textSecondary} />
        </Pressable>
      )}
    />
  );
}

// ─── Leaderboard Panel ────────────────────────────────────────────────────────
function LeaderboardPanel({ orgId }: { orgId: number }) {
  const [ageFilter, setAgeFilter] = useState<string>("all");

  const { data: lb = [], isLoading, refetch, isRefetching } = useQuery<LeaderboardEntry[]>({
    queryKey: ["/api/organizations", orgId, "junior", "portal", "leaderboard", ageFilter],
    queryFn: async () => {
      const url = new URL(API(`/organizations/${orgId}/junior/portal/leaderboard`));
      if (ageFilter !== "all") url.searchParams.set("ageCategory", ageFilter);
      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!orgId,
  });

  return (
    <View style={{ flex: 1 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow}>
        {[{ value: "all", label: "All" }, ...AGE_CATEGORIES].map(cat => (
          <Pressable
            key={cat.value}
            onPress={() => setAgeFilter(cat.value)}
            style={[styles.filterChip, ageFilter === cat.value && styles.filterChipActive]}
          >
            <Text style={[styles.filterChipText, ageFilter === cat.value && styles.filterChipTextActive]}>
              {cat.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {isLoading ? (
        <View style={styles.centered}>
          <LoadingSpinner color={Colors.primary} />
        </View>
      ) : lb.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="bar-chart-outline" size={40} color={Colors.textSecondary} />
          <Text style={styles.emptyText}>No juniors in this age group yet.</Text>
        </View>
      ) : (
        <FlatList
          data={lb}
          keyExtractor={e => String(e.juniorProfileId)}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={Colors.primary} />}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 100 }}
          renderItem={({ item, index }) => (
            <View style={styles.lbRow}>
              <Text style={styles.lbRank}>#{index + 1}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.lbName}>{item.firstName} {item.lastName}</Text>
                <View style={styles.badgeRow}>
                  <View style={styles.ageBadge}>
                    <Text style={styles.ageBadgeText}>{ageCategoryLabel(item.ageCategory)}</Text>
                  </View>
                  <View style={[styles.levelBadge, { backgroundColor: pathwayLevelColor(item.pathwayLevel) + "25" }]}>
                    <Text style={[styles.levelBadgeText, { color: pathwayLevelColor(item.pathwayLevel) }]}>
                      {pathwayLevelLabel(item.pathwayLevel)}
                    </Text>
                  </View>
                </View>
                <Text style={styles.lbMeta}>
                  {item.roundsPlayed} round{item.roundsPlayed !== 1 ? "s" : ""}
                  {item.avgGross !== null ? ` · Avg ${item.avgGross.toFixed(1)}` : ""}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.lbHcp}>{item.handicapIndex ?? "—"}</Text>
                <Text style={styles.lbHcpLabel}>HCP</Text>
              </View>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function JuniorScreen() {
  const insets = useSafeAreaInsets();
  const { user, organizationId } = useAuth();
  const [activeTab, setActiveTab] = useState<"my-juniors" | "leaderboard">("my-juniors");

  const orgId = organizationId;

  if (!user || !orgId) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top + 20 }]}>
        <Ionicons name="school-outline" size={48} color={Colors.textSecondary} />
        <Text style={styles.emptyTitle}>Junior Golf</Text>
        <Text style={styles.emptySubtitle}>Sign in and select a club to view junior programs.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: Colors.background, paddingTop: insets.top }}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="school" size={22} color={Colors.primary} />
          <Text style={styles.headerTitle}>Junior Golf</Text>
        </View>
      </View>

      <View style={styles.tabBar}>
        <Pressable
          onPress={() => setActiveTab("my-juniors")}
          style={[styles.tab, activeTab === "my-juniors" && styles.tabActive]}
        >
          <Text style={[styles.tabText, activeTab === "my-juniors" && styles.tabTextActive]}>My Juniors</Text>
        </Pressable>
        <Pressable
          onPress={() => setActiveTab("leaderboard")}
          style={[styles.tab, activeTab === "leaderboard" && styles.tabActive]}
        >
          <Text style={[styles.tabText, activeTab === "leaderboard" && styles.tabTextActive]}>Leaderboard</Text>
        </Pressable>
      </View>

      <View style={{ flex: 1 }}>
        {activeTab === "my-juniors" ? (
          <MyJuniorsPanel orgId={orgId} />
        ) : (
          <LeaderboardPanel orgId={orgId} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
  },
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: Colors.primary,
  },
  tabText: {
    fontSize: 13,
    fontWeight: "500",
    color: Colors.textSecondary,
  },
  tabTextActive: {
    color: Colors.primary,
    fontWeight: "600",
  },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    maxHeight: 52,
    backgroundColor: Colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginRight: 8,
  },
  filterChipActive: {
    backgroundColor: Colors.primary + "25",
    borderColor: Colors.primary,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: "500",
    color: Colors.textSecondary,
  },
  filterChipTextActive: {
    color: Colors.primary,
    fontWeight: "600",
  },
  juniorCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary + "25",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.primary,
  },
  juniorName: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
    marginBottom: 4,
  },
  juniorMeta: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  badgeRow: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  ageBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
    backgroundColor: Colors.primary + "20",
    borderWidth: 1,
    borderColor: Colors.primary + "40",
  },
  ageBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.primary,
  },
  levelBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "transparent",
  },
  levelBadgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
    marginTop: 12,
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginTop: 6,
    textAlign: "center",
    lineHeight: 20,
  },
  emptyText: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginTop: 8,
    textAlign: "center",
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backText: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.primary,
  },
  profileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  profileName: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
    marginBottom: 6,
  },
  handicapText: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  section: {
    marginTop: 20,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 10,
  },
  progressCard: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  progressPathway: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
  },
  progressLevel: {
    fontSize: 13,
    color: Colors.text,
  },
  progressDate: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  sessionCard: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  sessionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
    marginBottom: 2,
  },
  sessionProgram: {
    fontSize: 12,
    color: Colors.primary,
    marginBottom: 6,
    fontWeight: "500",
  },
  sessionMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  sessionMetaText: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  awardCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f59e0b10",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#f59e0b40",
  },
  awardLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
  },
  awardDate: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 40,
    paddingHorizontal: 24,
  },
  lbRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 12,
  },
  lbRank: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textSecondary,
    width: 28,
    textAlign: "right",
  },
  lbName: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
    marginBottom: 4,
  },
  lbMeta: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  lbHcp: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.text,
  },
  lbHcpLabel: {
    fontSize: 10,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
    marginLeft: 44,
  },
});
