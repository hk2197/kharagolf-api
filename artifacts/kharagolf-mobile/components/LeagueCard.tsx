import React from "react";
import { Pressable, View, Text, StyleSheet } from "react-native";
import { Feather, Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { getLocale } from "@/i18n";
import { PriceWithFx } from "@/components/PriceWithFx";

export interface LeagueCardItem {
  id: number;
  name: string;
  description: string | null;
  format: string;
  type: string;
  status: string;
  seasonStart: string | null;
  seasonEnd: string | null;
  maxMembers: number | null;
  entryFee: string | null;
  currency: string | null;
  handicapAllowance: number | null;
  roundsCount: number | null;
  organizationId: number;
}

const FORMAT_LABELS: Record<string, string> = {
  stroke_play: "Stroke Play",
  stableford: "Stableford",
  match_play: "Match Play",
  scramble: "Scramble",
  best_ball: "Best Ball",
  skins: "Skins",
  four_ball: "Four Ball",
  foursomes: "Foursomes",
  net_stroke: "Net Stroke",
};

const TYPE_LABELS: Record<string, string> = {
  club: "Club",
  corporate: "Corporate",
  charity: "Charity",
  social: "Social",
  professional: "Pro",
};

const STATUS_COLORS: Record<string, string> = {
  active: Colors.primary,
  upcoming: Colors.secondary,
  completed: Colors.muted,
  cancelled: Colors.error,
};

/**
 * Public league card extracted from the 2500-line `LeaguesScreen` so the
 * FX-aware entry-fee row can be regression-tested in isolation (Task #955).
 * The previous incarnation rendered a booked-currency-only `Text` via the
 * local `fmtFee` helper; this card mounts `<PriceWithFx>` so members on a
 * different preferred currency see an "Approx." converted line.
 */
export function LeagueCard({
  item,
  onPress,
  token,
}: {
  item: LeagueCardItem;
  onPress: () => void;
  token?: string | null;
}) {
  const statusColor = STATUS_COLORS[item.status] ?? Colors.muted;
  const seasonText = (() => {
    if (!item.seasonStart) return "Season TBD";
    const start = new Date(item.seasonStart).toLocaleDateString(getLocale(), { month: "short", year: "numeric" });
    if (!item.seasonEnd) return `From ${start}`;
    const end = new Date(item.seasonEnd).toLocaleDateString(getLocale(), { month: "short", year: "numeric" });
    return `${start} – ${end}`;
  })();

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}>
      <View style={[styles.cardAccent, { backgroundColor: statusColor }]} />
      <View style={styles.cardContent}>
        <View style={styles.cardHeader}>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + "20", borderColor: statusColor + "50" }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>{item.status.toUpperCase()}</Text>
          </View>
          <View style={styles.badges}>
            <Text style={styles.typeBadge}>{TYPE_LABELS[item.type] ?? item.type}</Text>
            <Text style={styles.formatBadge}>{FORMAT_LABELS[item.format] ?? item.format}</Text>
          </View>
        </View>

        <Text style={styles.cardTitle}>{item.name}</Text>

        {item.description ? (
          <Text style={styles.description} numberOfLines={2}>{item.description}</Text>
        ) : null}

        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Feather name="calendar" size={12} color={Colors.textSecondary} />
            <Text style={styles.metaText}>{seasonText}</Text>
          </View>
          {item.roundsCount ? (
            <View style={styles.metaItem}>
              <Ionicons name="golf" size={12} color={Colors.primary} />
              <Text style={styles.metaText}>{item.roundsCount} rounds</Text>
            </View>
          ) : null}
          {item.maxMembers ? (
            <View style={styles.metaItem}>
              <Feather name="users" size={12} color={Colors.textSecondary} />
              <Text style={styles.metaText}>{item.maxMembers} max</Text>
            </View>
          ) : null}
        </View>

        {item.entryFee && Number(item.entryFee) > 0 ? (
          <View style={styles.feeRow} testID="league-card-fee-row">
            <Feather name="credit-card" size={12} color={Colors.secondary} />
            <PriceWithFx
              orgId={item.organizationId}
              token={token ?? null}
              amount={item.entryFee}
              currency={item.currency ?? "INR"}
              productClass="league_entry"
              bookedStyle={styles.feeText}
              showDisclosure={false}
              disclosureOnHover
            />
            <Text style={styles.feeText}>entry fee</Text>
          </View>
        ) : null}

        {item.handicapAllowance !== null ? (
          <Text style={styles.handicapText}>{item.handicapAllowance}% handicap allowance</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    marginBottom: 12,
    overflow: "hidden",
    flexDirection: "row",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardAccent: { width: 4 },
  cardContent: { flex: 1, padding: 14 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  statusText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  badges: { flexDirection: "row", gap: 6 },
  typeBadge: { fontSize: 10, color: Colors.textSecondary, backgroundColor: Colors.background, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  formatBadge: { fontSize: 10, color: Colors.primary, backgroundColor: Colors.primary + "15", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  cardTitle: { fontSize: 15, fontWeight: "700", color: Colors.text, marginBottom: 4 },
  description: { fontSize: 12, color: Colors.textSecondary, marginBottom: 8, lineHeight: 17 },
  metaRow: { flexDirection: "row", gap: 12, flexWrap: "wrap", marginBottom: 6 },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 11, color: Colors.textSecondary },
  feeRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  feeText: { fontSize: 12, color: Colors.secondary, fontWeight: "600" },
  handicapText: { fontSize: 11, color: Colors.muted, marginTop: 4 },
});

export default LeagueCard;
