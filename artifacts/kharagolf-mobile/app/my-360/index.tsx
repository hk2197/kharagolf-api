import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";
import { PriceWithFx } from "@/components/PriceWithFx";
import { authedFetch, useActingMemberId, actingQs } from "./_shared";

const DEFAULT_CURRENCY = "INR";

interface My360Resp {
  member: {
    id: number; firstName: string | null; lastName: string | null;
    memberNumber: string | null; subscriptionStatus: string | null;
    renewalDate: string | null;
  };
  ext: {
    lifecycleStatus: string | null; kycStatus: string | null;
    preferredName: string | null; preferredTee: string | null;
    addressLine1: string | null; city: string | null; country: string | null;
  } | null;
  tier: { name: string } | null;
  counts: { documents: number; familyLinks: number; milestones: number };
  financial: { outstandingBalance: string; storeCreditBalance: string };
  actingAsLinked: boolean;
}

export default function My360Index() {
  const { token } = useAuth();
  const { activeOrgId } = useActiveClub();
  const [acting] = useActingMemberId();
  const [data, setData] = useState<My360Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const d = await authedFetch<My360Resp>(`/api/portal/my-360${actingQs({ actingMemberId: acting })}`, token);
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token, acting]);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  if (loading) {
    return <View style={styles.center}><LoadingSpinner color={Colors.primary} size="large" /></View>;
  }
  if (error || !data) {
    return (
      <View style={styles.center}>
        <Text style={{ color: "#f87171", textAlign: "center", marginHorizontal: 24 }}>
          {error ?? "Could not load your 360° view."}
        </Text>
      </View>
    );
  }

  const fullName = [data.member.firstName, data.member.lastName].filter(Boolean).join(" ") || "Member";
  const orgId = activeOrgId ?? null;

  const tiles: { icon: keyof typeof Feather.glyphMap; label: string; sub: string; path: string }[] = [
    { icon: "file-text", label: "Documents", sub: `${data.counts.documents} on file`, path: "/my-360/documents" },
    { icon: "shield", label: "Consents", sub: "Privacy & marketing", path: "/my-360/consents" },
    { icon: "bell", label: "Communications", sub: "Email, SMS, push & WhatsApp", path: "/my-360/communications" },
    { icon: "dollar-sign", label: "Statement", sub: "Charges, levies & store credit", path: "/my-360/statement" },
    { icon: "award", label: "Milestones", sub: `${data.counts.milestones} achievements`, path: "/my-360/milestones" },
    { icon: "star", label: "Badges", sub: "Unlock all badges", path: "/badges" },
    { icon: "users", label: "Family", sub: `${data.counts.familyLinks} linked`, path: "/my-360/family" },
    { icon: "lock", label: "Privacy", sub: "Data export & erasure", path: "/my-360/privacy" },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: Colors.background }}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={Colors.primary} />}
    >
      {data.actingAsLinked && (
        <View style={styles.actingBanner}>
          <Feather name="user-check" size={14} color="#fbbf24" />
          <Text style={styles.actingText}>Acting on behalf of {fullName}</Text>
          <TouchableOpacity onPress={() => router.push("/my-360/family")}><Text style={styles.actingSwitch}>Switch</Text></TouchableOpacity>
        </View>
      )}
      <View style={styles.header}>
        <Text style={styles.name}>{fullName}</Text>
        {data.member.memberNumber && <Text style={styles.memberNo}>#{data.member.memberNumber}</Text>}
        {data.tier?.name && <View style={styles.tierBadge}><Text style={styles.tierText}>{data.tier.name}</Text></View>}
        {data.ext?.lifecycleStatus && data.ext.lifecycleStatus !== "active" && (
          <View style={styles.statusBadge}>
            <Text style={styles.statusText}>{data.ext.lifecycleStatus.toUpperCase()}</Text>
          </View>
        )}
      </View>

      <View style={styles.statRow}>
        <View style={styles.statCard} testID="my360-outstanding">
          <PriceWithFx
            orgId={orgId}
            token={token}
            amount={data.financial.outstandingBalance}
            currency={DEFAULT_CURRENCY}
            productClass="member_charge"
            bookedStyle={styles.statValue}
          />
          <Text style={styles.statLabel}>Outstanding</Text>
        </View>
        <View style={styles.statCard} testID="my360-store-credit">
          <PriceWithFx
            orgId={orgId}
            token={token}
            amount={data.financial.storeCreditBalance}
            currency={DEFAULT_CURRENCY}
            productClass="store_credit"
            bookedStyle={styles.statValue}
          />
          <Text style={styles.statLabel}>Store credit</Text>
        </View>
      </View>

      <View style={styles.grid}>
        {tiles.map(t => (
          <TouchableOpacity key={t.path} style={styles.tile} onPress={() => router.push(t.path as never)} activeOpacity={0.75}>
            <View style={styles.tileIconWrap}><Feather name={t.icon} size={20} color={Colors.primary} /></View>
            <Text style={styles.tileLabel}>{t.label}</Text>
            <Text style={styles.tileSub}>{t.sub}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  header: { padding: 20, alignItems: "center" },
  name: { color: "#fff", fontSize: 22, fontWeight: "800" },
  memberNo: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 4, fontFamily: "monospace" },
  tierBadge: { marginTop: 8, backgroundColor: `${Colors.primary}20`, borderColor: `${Colors.primary}50`, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  tierText: { color: Colors.primary, fontSize: 12, fontWeight: "700" },
  statusBadge: { marginTop: 6, backgroundColor: "#7f1d1d40", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { color: "#fca5a5", fontSize: 10, fontWeight: "700" },
  statRow: { flexDirection: "row", paddingHorizontal: 16, gap: 10, marginBottom: 12 },
  statCard: { flex: 1, backgroundColor: Colors.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: Colors.border },
  statValue: { color: "#fff", fontSize: 20, fontWeight: "800" },
  statLabel: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 },
  grid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 12 },
  tile: { width: "50%", padding: 6 },
  tileIconWrap: { width: 36, height: 36, borderRadius: 10, backgroundColor: `${Colors.primary}20`, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  tileLabel: { color: "#fff", fontSize: 14, fontWeight: "700" },
  tileSub: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 },
  actingBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#78350f40", padding: 10, marginHorizontal: 16, marginTop: 12, borderRadius: 10, borderWidth: 1, borderColor: "#fbbf2440" },
  actingText: { color: "#fbbf24", flex: 1, fontSize: 12, fontWeight: "600" },
  actingSwitch: { color: "#fbbf24", fontSize: 12, fontWeight: "700", textDecorationLine: "underline" },
});
