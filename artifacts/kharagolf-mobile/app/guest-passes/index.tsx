/**
 * Mobile Guest Passes — Member invites guests & views their passes
 * Route: /guest-passes
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  TextInput,
  Modal,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import { getLocale } from "@/i18n";

const GOLD = "#C9A84C";
const BG = "#0a0f0a";
const CARD = "#111811";
const BORDER = "rgba(255,255,255,0.08)";

function statusColor(status: string): string {
  switch (status) {
    case "confirmed": return "#22c55e";
    case "checked_in": return "#3b82f6";
    case "pending": return "#f59e0b";
    case "no_show": return "#ef4444";
    case "cancelled": return "#6b7280";
    default: return "#6b7280";
  }
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(getLocale(), { day: "2-digit", month: "short", year: "numeric" });
}

function fmtMoney(v: string | number | null): string {
  if (v == null) return "₹0";
  return `₹${parseFloat(String(v)).toLocaleString(getLocale(), { minimumFractionDigits: 0 })}`;
}

interface GuestPass {
  id: number;
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  playDate: string;
  greenFee: string;
  feeSettlement: string;
  status: string;
  qrToken: string;
  createdAt: string;
}

export default function GuestPassesScreen() {
  const { token } = useAuth();
  const { activeClub } = useActiveClub();
  const orgId = activeClub?.id;
  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : "";

  const [passes, setPasses] = useState<GuestPass[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ guestName: "", guestEmail: "", guestPhone: "", playDate: "", feeSettlement: "pay_at_desk" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchPasses = useCallback(async (silent = false) => {
    if (!token || !orgId) return;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/guest-passes/my`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load passes");
      setPasses(await res.json());
    } catch {
      setError("Could not load guest passes");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, orgId, baseUrl]);

  useEffect(() => { fetchPasses(); }, [fetchPasses]);

  const onRefresh = useCallback(() => { setRefreshing(true); fetchPasses(true); }, [fetchPasses]);

  async function createPass() {
    if (!form.guestName || !form.playDate) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/guest-passes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...form }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateError(data.error ?? "Failed"); return; }
      setShowModal(false);
      setForm({ guestName: "", guestEmail: "", guestPhone: "", playDate: "", feeSettlement: "pay_at_desk" });
      fetchPasses(true);
    } catch {
      setCreateError("Network error");
    } finally {
      setCreating(false);
    }
  }

  async function cancelPass(passId: number) {
    await fetch(`${baseUrl}/api/organizations/${orgId}/guest-passes/${passId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    fetchPasses(true);
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Guest Passes</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowModal(true)}>
          <Feather name="user-plus" size={16} color="#000" />
          <Text style={styles.addBtnText}>Invite Guest</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <LoadingSpinner color={GOLD} />
          <Text style={styles.loadingText}>Loading passes…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Feather name="alert-circle" size={32} color="#ef4444" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => fetchPasses()}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={passes.length === 0 ? styles.emptyContainer : styles.listContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}
        >
          {passes.length === 0 ? (
            <View style={styles.emptyContent}>
              <Feather name="users" size={48} color="rgba(255,255,255,0.2)" />
              <Text style={styles.emptyTitle}>No guest passes yet</Text>
              <Text style={styles.emptyText}>Invite a guest to play at your club</Text>
              <TouchableOpacity style={styles.emptyBtn} onPress={() => setShowModal(true)}>
                <Text style={styles.emptyBtnText}>Invite Guest</Text>
              </TouchableOpacity>
            </View>
          ) : passes.map(pass => (
            <View key={pass.id} style={styles.card}>
              <View style={styles.cardRow}>
                <View style={styles.avatar}>
                  <Feather name="user" size={18} color="rgba(255,255,255,0.4)" />
                </View>
                <View style={styles.cardInfo}>
                  <Text style={styles.guestName}>{pass.guestName}</Text>
                  <Text style={styles.cardDetail}>
                    {fmtDate(pass.playDate)} · {fmtMoney(pass.greenFee)} · {pass.feeSettlement.replace(/_/g, " ")}
                  </Text>
                  {pass.guestEmail ? <Text style={styles.cardEmail}>{pass.guestEmail}</Text> : null}
                </View>
                <View style={[styles.statusBadge, { backgroundColor: `${statusColor(pass.status)}20` }]}>
                  <Text style={[styles.statusText, { color: statusColor(pass.status) }]}>
                    {pass.status.replace("_", " ")}
                  </Text>
                </View>
              </View>
              {pass.status !== "cancelled" && pass.status !== "checked_in" && (
                <TouchableOpacity style={styles.cancelBtn} onPress={() => cancelPass(pass.id)}>
                  <Feather name="x" size={14} color="#ef4444" />
                  <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </ScrollView>
      )}

      {/* Create Guest Pass Modal */}
      <Modal visible={showModal} animationType="slide" presentationStyle="formSheet" onRequestClose={() => setShowModal(false)}>
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Invite a Guest</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}>
              <Feather name="x" size={22} color="rgba(255,255,255,0.6)" />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <Text style={styles.label}>Guest Name *</Text>
            <TextInput style={styles.input} value={form.guestName}
              onChangeText={v => setForm(f => ({ ...f, guestName: v }))} placeholder="Full name" placeholderTextColor="#666" />

            <Text style={styles.label}>Email</Text>
            <TextInput style={styles.input} value={form.guestEmail} keyboardType="email-address"
              onChangeText={v => setForm(f => ({ ...f, guestEmail: v }))} placeholder="email@example.com" placeholderTextColor="#666" />

            <Text style={styles.label}>Phone</Text>
            <TextInput style={styles.input} value={form.guestPhone} keyboardType="phone-pad"
              onChangeText={v => setForm(f => ({ ...f, guestPhone: v }))} placeholder="+91 98765 43210" placeholderTextColor="#666" />

            <Text style={styles.label}>Play Date * (YYYY-MM-DD)</Text>
            <TextInput style={styles.input} value={form.playDate}
              onChangeText={v => setForm(f => ({ ...f, playDate: v }))} placeholder="2026-04-20" placeholderTextColor="#666" />

            <Text style={styles.label}>Fee Settlement</Text>
            {[
              { value: "member_account", label: "Charge to My Account" },
              { value: "guest_online", label: "Guest Pays Online" },
              { value: "pay_at_desk", label: "Pay at Desk" },
            ].map(opt => (
              <TouchableOpacity key={opt.value} style={[styles.radioRow, form.feeSettlement === opt.value && styles.radioRowActive]}
                onPress={() => setForm(f => ({ ...f, feeSettlement: opt.value }))}>
                <View style={[styles.radioCircle, form.feeSettlement === opt.value && styles.radioCircleActive]} />
                <Text style={styles.radioLabel}>{opt.label}</Text>
              </TouchableOpacity>
            ))}

            {createError && <Text style={styles.createError}>{createError}</Text>}

            <TouchableOpacity
              style={[styles.createBtn, (!form.guestName || !form.playDate || creating) && styles.createBtnDisabled]}
              disabled={!form.guestName || !form.playDate || creating}
              onPress={createPass}
            >
              {creating ? <LoadingSpinner color="#000" /> : <Text style={styles.createBtnText}>Create Pass</Text>}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  title: { fontSize: 22, fontWeight: "700", color: "#fff" },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: GOLD, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  addBtnText: { color: "#000", fontWeight: "700", fontSize: 13 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { color: "rgba(255,255,255,0.4)", fontSize: 14 },
  errorText: { color: "#ef4444", fontSize: 15, textAlign: "center" },
  retryBtn: { backgroundColor: "rgba(255,255,255,0.1)", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: "#fff", fontWeight: "600" },
  listContainer: { padding: 16, gap: 10 },
  emptyContainer: { flex: 1 },
  emptyContent: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: "#fff", marginTop: 16 },
  emptyText: { fontSize: 14, color: "rgba(255,255,255,0.4)", textAlign: "center", marginTop: 4 },
  emptyBtn: { marginTop: 20, backgroundColor: GOLD, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  emptyBtnText: { color: "#000", fontWeight: "700" },
  card: { backgroundColor: CARD, borderRadius: 14, borderWidth: 1, borderColor: BORDER, padding: 14 },
  cardRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.05)", alignItems: "center", justifyContent: "center" },
  cardInfo: { flex: 1 },
  guestName: { fontSize: 15, fontWeight: "700", color: "#fff" },
  cardDetail: { fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 2 },
  cardEmail: { fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  statusText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  cancelBtn: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 10, alignSelf: "flex-end" },
  cancelText: { color: "#ef4444", fontSize: 12 },
  modalContainer: { flex: 1, backgroundColor: CARD },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 20, borderBottomWidth: 1, borderColor: BORDER },
  modalTitle: { fontSize: 18, fontWeight: "700", color: "#fff" },
  modalBody: { padding: 20, gap: 4 },
  label: { fontSize: 12, color: "rgba(255,255,255,0.5)", marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: BORDER, borderRadius: 10, padding: 12, color: "#fff", fontSize: 14 },
  radioRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: BORDER, marginTop: 8 },
  radioRowActive: { borderColor: GOLD, backgroundColor: `${GOLD}10` },
  radioCircle: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: "rgba(255,255,255,0.3)" },
  radioCircleActive: { borderColor: GOLD, backgroundColor: GOLD },
  radioLabel: { color: "#fff", fontSize: 14 },
  createError: { color: "#ef4444", fontSize: 13, marginTop: 12 },
  createBtn: { marginTop: 24, backgroundColor: GOLD, borderRadius: 14, padding: 16, alignItems: "center" },
  createBtnDisabled: { opacity: 0.5 },
  createBtnText: { color: "#000", fontWeight: "700", fontSize: 16 },
});
