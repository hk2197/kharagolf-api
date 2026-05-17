import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, Modal, FlatList, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { BASE_URL } from "@/utils/api";

const SUPPORTED_CURRENCIES = ["INR", "USD", "GBP", "EUR", "AED", "SGD", "AUD", "CAD", "JPY"];
const CLUB_DEFAULT = "__default__";

/**
 * Player preferred-currency picker — backed by GET/PUT
 * /api/currency-tax/me/preferred-currency (task #448).
 */
export function CurrencyPicker() {
  const { token } = useAuth();
  const [value, setValue] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) { setLoading(false); return; }
    fetch(`${BASE_URL}/api/currency-tax/me/preferred-currency`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() as Promise<{ preferredCurrency: string | null }> : null)
      .then(d => { if (!cancelled) { setValue(d?.preferredCurrency ?? null); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const save = async (next: string) => {
    if (!token) return;
    setOpen(false);
    const previous = value;
    const nextValue = next === CLUB_DEFAULT ? null : next;
    setSaving(true);
    try {
      const res = await fetch(`${BASE_URL}/api/currency-tax/me/preferred-currency`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ preferredCurrency: nextValue }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        Alert.alert("Could not update currency", err.error ?? "Please try again.");
        setValue(previous);
        return;
      }
      setValue(nextValue);
    } catch {
      Alert.alert("Could not update currency", "Please try again.");
      setValue(previous);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <TouchableOpacity style={styles.row} onPress={() => setOpen(true)} disabled={loading || saving}>
        <Feather name="dollar-sign" size={18} color={Colors.tabIconDefault} />
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Preferred display currency</Text>
          <Text style={styles.sub}>{loading ? "Loading…" : (value ?? "Use club default")}</Text>
        </View>
        {saving ? <ActivityIndicator size="small" color={Colors.muted} /> : <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />}
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Display currency</Text>
              <TouchableOpacity onPress={() => setOpen(false)}>
                <Feather name="x" size={22} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalNote}>
              Prices appear in the booked currency with an approximate conversion. Charges are still settled in the club's currency.
            </Text>
            <FlatList
              data={[CLUB_DEFAULT, ...SUPPORTED_CURRENCIES]}
              keyExtractor={c => c}
              renderItem={({ item }) => {
                const isDefault = item === CLUB_DEFAULT;
                const selected = isDefault ? value === null : value === item;
                return (
                  <TouchableOpacity style={styles.option} onPress={() => save(item)}>
                    <Text style={styles.optionText}>{isDefault ? "Use club default" : item}</Text>
                    {selected && <Feather name="check" size={18} color={Colors.primary} />}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  label: { color: Colors.text, fontSize: 14, fontWeight: "500" },
  sub: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: "#0a1a0f", padding: 20, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: "70%" },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  modalTitle: { color: Colors.text, fontSize: 18, fontWeight: "700" },
  modalNote: { color: Colors.muted, fontSize: 12, marginBottom: 14 },
  option: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  optionText: { color: Colors.text, fontSize: 15 },
});

export default CurrencyPicker;
