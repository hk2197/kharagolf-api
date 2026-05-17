import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { authedFetch, useActingMemberId } from "./_shared";

interface FamilyMember {
  linkId: number; relationship: string; isPrimaryPayer: boolean; canBookOnBehalf: boolean;
  memberId: number; firstName: string | null; lastName: string | null; memberNumber: string | null;
}

interface FamilyResp {
  self: { id: number; organizationId: number };
  outgoing: FamilyMember[];
  incoming: FamilyMember[];
}

export default function FamilyScreen() {
  const { token } = useAuth();
  const [acting, setActing] = useActingMemberId();
  const [data, setData] = useState<FamilyResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    authedFetch<FamilyResp>(`/api/portal/my-family`, token)
      .then(setData).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [token]);

  if (loading) return <View style={styles.center}><LoadingSpinner color={Colors.primary} /></View>;
  if (error || !data) return <View style={styles.center}><Text style={styles.errorText}>{error ?? "Could not load family."}</Text></View>;

  const switchTo = (memberId: number | null) => {
    setActing(memberId);
    if (memberId == null) {
      Alert.alert("Switched", "You are now viewing your own 360°.");
    } else {
      Alert.alert("Switched", "You are now acting on behalf of the selected member.");
    }
    router.push("/my-360");
  };

  const fullName = (m: FamilyMember) => [m.firstName, m.lastName].filter(Boolean).join(" ") || `Member #${m.memberNumber ?? m.memberId}`;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: Colors.background }} contentContainerStyle={{ padding: 16 }}>
      <View style={styles.selfRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Currently viewing</Text>
          <Text style={styles.selfText}>{acting == null ? "My own 360°" : `Member #${acting}`}</Text>
        </View>
        {acting != null && (
          <TouchableOpacity style={styles.resetBtn} onPress={() => switchTo(null)}>
            <Text style={styles.resetText}>Reset to me</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.sectionTitle}>I can act on behalf of</Text>
      {data.outgoing.length === 0 ? (
        <Text style={styles.emptyText}>No family members are linked to your account yet.</Text>
      ) : data.outgoing.map(m => (
        <View key={m.linkId} style={styles.card}>
          <View style={styles.cardIcon}><Feather name="user" size={18} color={Colors.primary} /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardName}>{fullName(m)}</Text>
            <Text style={styles.cardMeta}>{m.relationship.replace(/_/g, " ")}</Text>
            {m.isPrimaryPayer && <Text style={styles.tag}>Primary payer</Text>}
          </View>
          {m.canBookOnBehalf ? (
            <TouchableOpacity style={styles.switchBtn} onPress={() => switchTo(m.memberId)}>
              <Text style={styles.switchBtnText}>Act for</Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.disabledText}>Read only</Text>
          )}
        </View>
      ))}

      {data.incoming.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Who can act on my behalf</Text>
          {data.incoming.map(m => (
            <View key={m.linkId} style={styles.card}>
              <View style={styles.cardIcon}><Feather name="user-check" size={18} color="#fbbf24" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{fullName(m)}</Text>
                <Text style={styles.cardMeta}>{m.relationship.replace(/_/g, " ")} · {m.canBookOnBehalf ? "can book on behalf" : "view only"}</Text>
              </View>
            </View>
          ))}
        </>
      )}

      <Text style={styles.footnote}>
        To add or remove a family link, contact your club's membership office.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  errorText: { color: "#f87171", padding: 16, textAlign: "center" },
  emptyText: { color: Colors.tabIconDefault, fontSize: 13, fontStyle: "italic", marginVertical: 8 },
  label: { color: Colors.tabIconDefault, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  selfRow: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.surface, borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: Colors.border },
  selfText: { color: "#fff", fontSize: 15, fontWeight: "700", marginTop: 2 },
  resetBtn: { backgroundColor: Colors.primary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  resetText: { color: "#fff", fontWeight: "700", fontSize: 12 },
  sectionTitle: { color: "#fff", fontSize: 13, fontWeight: "700", marginTop: 8, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.surface, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: Colors.border },
  cardIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: `${Colors.primary}20`, alignItems: "center", justifyContent: "center" },
  cardName: { color: "#fff", fontSize: 14, fontWeight: "700" },
  cardMeta: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 },
  tag: { color: "#fbbf24", fontSize: 10, fontWeight: "700", marginTop: 2 },
  switchBtn: { backgroundColor: Colors.primary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  switchBtnText: { color: "#fff", fontWeight: "700", fontSize: 12 },
  disabledText: { color: Colors.tabIconDefault, fontSize: 11, fontStyle: "italic" },
  footnote: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 24, textAlign: "center" },
});
