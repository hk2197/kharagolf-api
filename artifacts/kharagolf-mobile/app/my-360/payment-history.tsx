import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { authedFetch, useActingMemberId, actingQs } from "./_shared";

type EventKind = "applied" | "payment" | "marked_paid" | "refund" | "waived" | "other";

interface PaymentEvent {
  id: number;
  kind: EventKind;
  action: string;
  reason: string | null;
  actorName: string | null;
  createdAt: string;
  levyId: number | null;
  chargeId: number | null;
  levyName: string | null;
  levyCurrency: string | null;
}

interface HistoryResp {
  events: PaymentEvent[];
  chargeCount: number;
}

const KIND_META: Record<EventKind, { icon: keyof typeof Feather.glyphMap; colour: string; label: string }> = {
  applied: { icon: "file-plus", colour: "#60a5fa", label: "Charge applied" },
  payment: { icon: "credit-card", colour: "#22c55e", label: "Payment recorded" },
  marked_paid: { icon: "check-circle", colour: "#22c55e", label: "Marked paid" },
  refund: { icon: "rotate-ccw", colour: "#fbbf24", label: "Refund issued" },
  waived: { icon: "slash", colour: "#94a3b8", label: "Charge waived" },
  other: { icon: "info", colour: "#94a3b8", label: "Update" },
};

export default function PaymentHistoryScreen() {
  const { token } = useAuth();
  const [acting] = useActingMemberId();
  const [data, setData] = useState<HistoryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    authedFetch<HistoryResp>(`/api/portal/my-payment-history${actingQs({ actingMemberId: acting })}`, token)
      .then(setData).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [token, acting]);

  if (loading) return <View style={styles.center}><LoadingSpinner color={Colors.primary} /></View>;
  if (error || !data) return <View style={styles.center}><Text style={styles.errorText}>{error ?? "Could not load payment history."}</Text></View>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: Colors.background }} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.intro}>
        Every payment, refund, and waive event recorded against your levy charges, including any note your club captured at the time.
      </Text>

      {data.events.length === 0 ? (
        <View style={styles.emptyBox}>
          <Feather name="inbox" size={28} color={Colors.tabIconDefault} />
          <Text style={styles.emptyTitle}>No payment activity yet</Text>
          <Text style={styles.emptySub}>
            When your club records a payment, refund, or waiver against one of your levy charges, it will appear here.
          </Text>
        </View>
      ) : (
        data.events.map((ev) => {
          const meta = KIND_META[ev.kind] ?? KIND_META.other;
          return (
            <View key={ev.id} style={styles.eventCard}>
              <View style={[styles.iconBubble, { backgroundColor: `${meta.colour}22`, borderColor: `${meta.colour}55` }]}>
                <Feather name={meta.icon} size={16} color={meta.colour} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.eventHeader}>
                  <Text style={styles.eventLabel}>{meta.label}</Text>
                  <Text style={styles.eventDate}>
                    {new Date(ev.createdAt).toLocaleString(undefined, {
                      year: "numeric", month: "short", day: "numeric",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </Text>
                </View>
                {ev.levyName ? (
                  <Text style={styles.levyName}>{ev.levyName}</Text>
                ) : null}
                {ev.reason ? (
                  <Text style={styles.reasonText}>{ev.reason}</Text>
                ) : null}
                {ev.actorName ? (
                  <Text style={styles.actorText}>Recorded by {ev.actorName}</Text>
                ) : null}
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  errorText: { color: "#f87171", padding: 16, textAlign: "center" },
  intro: { color: Colors.tabIconDefault, fontSize: 12, marginBottom: 14, lineHeight: 17 },
  emptyBox: { alignItems: "center", padding: 28, backgroundColor: Colors.surface, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, gap: 8, marginTop: 12 },
  emptyTitle: { color: "#fff", fontSize: 14, fontWeight: "700" },
  emptySub: { color: Colors.tabIconDefault, fontSize: 12, textAlign: "center", lineHeight: 17 },
  eventCard: { flexDirection: "row", gap: 12, backgroundColor: Colors.surface, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: Colors.border },
  iconBubble: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  eventHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  eventLabel: { color: "#fff", fontSize: 13, fontWeight: "700" },
  eventDate: { color: Colors.tabIconDefault, fontSize: 10 },
  levyName: { color: Colors.primary, fontSize: 12, fontWeight: "700", marginTop: 4 },
  reasonText: { color: "#e5e7eb", fontSize: 12, marginTop: 4, lineHeight: 17 },
  actorText: { color: Colors.tabIconDefault, fontSize: 10, marginTop: 6, fontStyle: "italic" },
});
