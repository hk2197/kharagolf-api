import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { router, type Href } from "expo-router";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { fetchPortal } from "@/utils/api";

type UpcomingKind = "tee" | "lesson" | "range" | "fb" | "rental" | "wallet_topup";

interface UpcomingItem {
  kind: UpcomingKind | string;
  id: number;
  organizationId: number | null;
  startsAt: string;
}

interface CategoryMeta {
  label: string;
  basePath: string;
  icon: keyof typeof Feather.glyphMap;
  /**
   * Query parameter the destination screen reads to deep-link to a specific
   * record (e.g. `bookingId` for lessons / range / tee, `orderId` for F&B).
   * Wallet top-up rows don't need a per-record deep-link — the /wallet
   * screen lists the member's recent activity — so we pass a harmless
   * `requestId` the screen ignores to keep the hrefFor signature simple.
   */
  param: string;
}

const CATEGORY: Record<UpcomingKind, CategoryMeta> = {
  tee: { label: "Tee booking", basePath: "/tee-bookings", icon: "calendar", param: "bookingId" },
  lesson: { label: "Coaching lesson", basePath: "/(tabs)/lessons", icon: "user", param: "bookingId" },
  range: { label: "Range bay", basePath: "/(tabs)/range", icon: "target", param: "bookingId" },
  fb: { label: "F&B order", basePath: "/(tabs)/order", icon: "coffee", param: "orderId" },
  rental: { label: "Equipment rental", basePath: "/(tabs)/rentals", icon: "briefcase", param: "bookingId" },
  // Wallet top-up requests (Task #1423) — pending verification, awaiting
  // refund, or recently refunded. Routes to the standalone /wallet screen
  // which lists the member's recent wallet activity.
  wallet_topup: { label: "Wallet top-up refund", basePath: "/wallet", icon: "credit-card", param: "requestId" },
};

function describe(item: UpcomingItem) {
  const meta = CATEGORY[item.kind as UpcomingKind];
  if (meta) return meta;
  return { label: `${item.kind} booking`, basePath: "/", icon: "calendar" as const, param: "id" };
}

function hrefFor(meta: CategoryMeta | { basePath: string; param: string }, id: number): Href {
  return { pathname: meta.basePath, params: { [meta.param]: String(id) } } as unknown as Href;
}

export function MyUpcomingWidget() {
  const { token } = useAuth();
  const [items, setItems] = useState<UpcomingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { setItems([]); return; }
    let cancelled = false;
    fetchPortal<{ items: UpcomingItem[] }>(`/my-upcoming`, token)
      .then(d => { if (!cancelled) setItems(d.items ?? []); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed"); });
    return () => { cancelled = true; };
  }, [token]);

  if (error) return null;

  return (
    <View style={styles.card} testID="widget-my-upcoming">
      <View style={styles.header}>
        <Feather name="calendar" size={16} color={Colors.primary} />
        <Text style={styles.title}>Upcoming</Text>
      </View>
      {items === null ? (
        <ActivityIndicator size="small" color={Colors.primary} />
      ) : items.length === 0 ? (
        <Text style={styles.muted}>No upcoming bookings.</Text>
      ) : (
        items.slice(0, 5).map(item => {
          const meta = describe(item);
          return (
            <TouchableOpacity
              key={`${item.kind}-${item.id}`}
              style={styles.row}
              testID={`upcoming-${item.kind}-${item.id}`}
              onPress={() => router.push(hrefFor(meta, item.id))}
            >
              <Feather name={meta.icon} size={16} color={Colors.primary} style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{meta.label}</Text>
                <Text style={styles.muted}>{new Date(item.startsAt).toLocaleString()}</Text>
              </View>
              <Feather name="chevron-right" size={16} color={Colors.muted} />
            </TouchableOpacity>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.card,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    marginVertical: 8,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  title: { color: "#fff", fontWeight: "700", fontSize: 15 },
  row: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 8, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  rowTitle: { color: "#fff", fontSize: 14 },
  muted: { color: Colors.textSecondary, fontSize: 12 },
});
