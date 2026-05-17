import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";
import { PriceWithFx } from "@/components/PriceWithFx";
import { authedFetch, useActingMemberId, actingQs } from "./_shared";

interface Charge {
  id: number; description: string | null; amount: string; isSettled: boolean; createdAt: string;
}
interface LevyChargeRow {
  charge: {
    id: number;
    amount: string;
    paid: boolean;
    paidAt: string | null;
    status: "unpaid" | "partial" | "paid" | "waived" | "refunded" | string;
    paidAmount: string;
    refundedAmount: string;
    waivedReason: string | null;
    remaining: string;
    createdAt: string;
  };
  levy: {
    id: number;
    name: string;
    description: string | null;
    currency: string;
    dueDate: string | null;
  };
}
interface StatementResp {
  accountCharges: Charge[];
  levyCharges: LevyChargeRow[];
  outstandingBalance: string;
  levyOutstandingBalance: string;
  storeCredit: { account: { balancePaise: number } | null; history: unknown[] } | null;
}

const STATUS_COLORS: Record<string, string> = {
  paid: "#22c55e",
  partial: "#fbbf24",
  unpaid: "#fbbf24",
  waived: "#94a3b8",
  refunded: "#94a3b8",
};

const DEFAULT_CURRENCY = "INR";

export default function StatementScreen() {
  const { token } = useAuth();
  const { activeOrgId } = useActiveClub();
  const [acting] = useActingMemberId();
  const [data, setData] = useState<StatementResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    authedFetch<StatementResp>(`/api/portal/my-statement${actingQs({ actingMemberId: acting })}`, token)
      .then(setData).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [token, acting]);

  if (loading) return <View style={styles.center}><LoadingSpinner color={Colors.primary} /></View>;
  if (error || !data) return <View style={styles.center}><Text style={styles.errorText}>{error ?? "Could not load statement."}</Text></View>;

  const credit = data.storeCredit?.account?.balancePaise ?? 0;
  const orgId = activeOrgId ?? null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: Colors.background }} contentContainerStyle={{ padding: 16 }}>
      <View style={styles.summary}>
        <View style={styles.summaryHalf} testID="statement-outstanding">
          <Text style={styles.summaryLabel}>Outstanding</Text>
          <PriceWithFx
            orgId={orgId}
            token={token}
            amount={data.outstandingBalance}
            currency={DEFAULT_CURRENCY}
            productClass="member_charge"
            bookedStyle={styles.summaryValue}
          />
        </View>
        <View style={styles.summaryHalf} testID="statement-store-credit">
          <Text style={styles.summaryLabel}>Store credit</Text>
          <PriceWithFx
            orgId={orgId}
            token={token}
            amount={credit / 100}
            currency={DEFAULT_CURRENCY}
            productClass="store_credit"
            bookedStyle={styles.summaryValue}
          />
        </View>
      </View>

      <TouchableOpacity
        style={styles.historyLink}
        onPress={() => router.push("/my-360/payment-history" as never)}
        activeOpacity={0.7}
      >
        <Feather name="clock" size={14} color={Colors.primary} />
        <Text style={styles.historyLinkText}>View payment history</Text>
        <Feather name="chevron-right" size={14} color={Colors.primary} />
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Account charges</Text>
      {data.accountCharges.length === 0 ? (
        <Text style={styles.emptyText}>No charges on your account.</Text>
      ) : data.accountCharges.map(c => (
        <View key={c.id} style={styles.row} testID={`statement-account-charge-${c.id}`}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>{c.description || "Account charge"}</Text>
            <Text style={styles.rowMeta}>{new Date(c.createdAt).toLocaleDateString()}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <PriceWithFx
              orgId={orgId}
              token={token}
              amount={c.amount}
              currency={DEFAULT_CURRENCY}
              productClass="member_charge"
              showDisclosure={false}
              disclosureOnHover
              bookedStyle={[styles.rowAmount, c.isSettled ? { color: "#22c55e" } : { color: "#fbbf24" }]}
            />
          </View>
          <Text style={[styles.rowStatus, c.isSettled ? { color: "#22c55e" } : { color: "#fbbf24" }]}>
            {c.isSettled ? "PAID" : "DUE"}
          </Text>
        </View>
      ))}

      <Text style={styles.sectionTitle}>Levies</Text>
      {data.levyCharges.length === 0 ? (
        <Text style={styles.emptyText}>No levy charges.</Text>
      ) : data.levyCharges.map(l => {
        const status = String(l.charge.status ?? "unpaid").toLowerCase();
        const colour = STATUS_COLORS[status] ?? "#fbbf24";
        const paid = parseFloat(l.charge.paidAmount ?? "0");
        const refunded = parseFloat(l.charge.refundedAmount ?? "0");
        const remaining = parseFloat(l.charge.remaining ?? "0");
        return (
          <View key={l.charge.id} style={styles.levyCard} testID={`statement-levy-${l.charge.id}`}>
            <View style={styles.levyHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{l.levy.name}</Text>
                {l.levy.description ? <Text style={styles.rowMeta}>{l.levy.description}</Text> : null}
                <Text style={styles.rowMeta}>
                  Charged {new Date(l.charge.createdAt).toLocaleDateString()}
                  {l.levy.dueDate ? ` · Due ${new Date(l.levy.dueDate).toLocaleDateString()}` : ""}
                </Text>
              </View>
              <View style={[styles.statusPill, { borderColor: `${colour}55`, backgroundColor: `${colour}22` }]}>
                <Text style={[styles.statusPillText, { color: colour }]}>{status.toUpperCase()}</Text>
              </View>
            </View>

            <View style={styles.levyBreakdown}>
              <View style={styles.bdCol}>
                <Text style={styles.bdLabel}>Charged</Text>
                <PriceWithFx
                  orgId={orgId}
                  token={token}
                  amount={l.charge.amount}
                  currency={l.levy.currency}
                  productClass="levy"
                  showDisclosure={false}
                  disclosureOnHover
                  bookedStyle={styles.bdValue}
                />
              </View>
              <View style={styles.bdCol}>
                <Text style={styles.bdLabel}>Paid</Text>
                <PriceWithFx
                  orgId={orgId}
                  token={token}
                  amount={paid}
                  currency={l.levy.currency}
                  productClass="levy"
                  showDisclosure={false}
                  disclosureOnHover
                  bookedStyle={[styles.bdValue, { color: paid > 0 ? "#22c55e" : "#fff" }]}
                />
              </View>
              {refunded > 0 ? (
                <View style={styles.bdCol}>
                  <Text style={styles.bdLabel}>Refunded</Text>
                  <PriceWithFx
                    orgId={orgId}
                    token={token}
                    amount={refunded}
                    currency={l.levy.currency}
                    productClass="levy"
                    showDisclosure={false}
                    disclosureOnHover
                    bookedStyle={[styles.bdValue, { color: "#94a3b8" }]}
                  />
                </View>
              ) : null}
              <View style={styles.bdCol}>
                <Text style={styles.bdLabel}>Balance</Text>
                <PriceWithFx
                  orgId={orgId}
                  token={token}
                  amount={remaining}
                  currency={l.levy.currency}
                  productClass="levy"
                  showDisclosure={false}
                  disclosureOnHover
                  bookedStyle={[styles.bdValue, { color: remaining > 0 ? "#fbbf24" : "#22c55e" }]}
                />
              </View>
            </View>

            {status === "waived" && l.charge.waivedReason ? (
              <Text style={styles.waivedNote}>Waived — {l.charge.waivedReason}</Text>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  errorText: { color: "#f87171", padding: 16, textAlign: "center" },
  emptyText: { color: Colors.tabIconDefault, fontSize: 13, fontStyle: "italic" },
  summary: { flexDirection: "row", gap: 10, marginBottom: 12 },
  summaryHalf: { flex: 1, backgroundColor: Colors.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: Colors.border },
  summaryLabel: { color: Colors.tabIconDefault, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  summaryValue: { color: "#fff", fontSize: 20, fontWeight: "800", marginTop: 4 },
  historyLink: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 18, paddingVertical: 8 },
  historyLinkText: { color: Colors.primary, fontSize: 13, fontWeight: "700", flex: 1 },
  sectionTitle: { color: "#fff", fontSize: 13, fontWeight: "700", marginBottom: 8, marginTop: 8, textTransform: "uppercase", letterSpacing: 0.5 },
  row: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.surface, borderRadius: 10, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: Colors.border, gap: 8 },
  rowTitle: { color: "#fff", fontSize: 13, fontWeight: "600" },
  rowMeta: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 },
  rowAmount: { fontSize: 14, fontWeight: "700" },
  rowStatus: { fontSize: 10, fontWeight: "700", marginLeft: 6 },
  levyCard: { backgroundColor: Colors.surface, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: Colors.border },
  levyHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  statusPillText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  levyBreakdown: { flexDirection: "row", marginTop: 10, gap: 10, flexWrap: "wrap" },
  bdCol: { flex: 1, minWidth: 70 },
  bdLabel: { color: Colors.tabIconDefault, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  bdValue: { color: "#fff", fontSize: 13, fontWeight: "700", marginTop: 2 },
  waivedNote: { color: "#94a3b8", fontSize: 11, marginTop: 8, fontStyle: "italic" },
});
