import React, { useEffect, useState } from "react";
import {
  View, Text, ActivityIndicator, TouchableOpacity, Alert, StyleSheet,
  Modal, FlatList, TextInput, ScrollView,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { getApiUrl } from "@/utils/api";

const GOLD = "#C9A84C";

type Frequency = "daily" | "weekday" | "weekly";

interface BouncedDigestPrefs {
  frequency: Frequency;
  hourLocal: number | null;
  timezone: string | null;
  lastSentOn: string | null;
}

const FREQUENCY_OPTIONS: { value: Frequency; label: string; help: string }[] = [
  { value: "daily", label: "Daily", help: "Every day at the chosen hour." },
  { value: "weekday", label: "Weekdays only", help: "Mon–Fri at the chosen hour." },
  { value: "weekly", label: "Weekly (Mondays)", help: "Mondays at the chosen hour." },
];

const COMMON_TIMEZONES: string[] = [
  "UTC",
  "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Asia/Bangkok",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
  "Africa/Johannesburg", "Africa/Lagos",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo", "Australia/Sydney",
];

const HOUR_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Any time (first cron tick of the day)" },
  ...Array.from({ length: 24 }).map((_, h) => ({
    value: h,
    label: `${String(h).padStart(2, "0")}:00`,
  })),
];

/**
 * Mobile mirror of the web `BouncedDigestPrefsCard` (Task #274). Lets an
 * org admin pick the cadence (daily / weekday / weekly), preferred local
 * hour, and IANA timezone for the bounced-levy reminders email digest,
 * and send themselves a one-off preview. Self-hides on 401/403 so the
 * card disappears for non-admin users (matching the web behaviour
 * exactly). Hits the same endpoints:
 *   GET    /api/organizations/:orgId/bounced-digest-prefs
 *   PATCH  /api/organizations/:orgId/bounced-digest-prefs
 *   POST   /api/organizations/:orgId/bounced-digest-prefs/preview
 */
export function BouncedDigestPrefsCard({
  orgId,
  token,
}: {
  orgId: number | null | undefined;
  token: string | null | undefined;
}) {
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [prefs, setPrefs] = useState<BouncedDigestPrefs>({
    frequency: "daily", hourLocal: null, timezone: null, lastSentOn: null,
  });
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // Pickers — mobile uses bottom-sheet modals instead of <Select>.
  const [freqOpen, setFreqOpen] = useState(false);
  const [hourOpen, setHourOpen] = useState(false);
  const [tzOpen, setTzOpen] = useState(false);
  const [tzInput, setTzInput] = useState("");

  useEffect(() => {
    if (!orgId || !token) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setAllowed(true);
    fetch(getApiUrl(`/organizations/${orgId}/bounced-digest-prefs`), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setAllowed(false); return; }
        if (!r.ok) return;
        const data = (await r.json()) as Partial<BouncedDigestPrefs>;
        const next: BouncedDigestPrefs = {
          frequency: (data.frequency ?? "daily") as Frequency,
          hourLocal: data.hourLocal ?? null,
          timezone: data.timezone ?? null,
          lastSentOn: data.lastSentOn ?? null,
        };
        setPrefs(next);
        setTzInput(next.timezone ?? "");
      })
      .catch(() => { /* best-effort */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId, token]);

  const save = async () => {
    if (!orgId || !token) return;
    setSaving(true);
    try {
      const res = await fetch(getApiUrl(`/organizations/${orgId}/bounced-digest-prefs`), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          frequency: prefs.frequency,
          hourLocal: prefs.hourLocal,
          timezone: prefs.timezone,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as { error?: string }));
        Alert.alert("Could not save", err.error ?? `HTTP ${res.status}`);
        return;
      }
      const updated = (await res.json()) as Partial<BouncedDigestPrefs>;
      setPrefs({
        frequency: (updated.frequency ?? "daily") as Frequency,
        hourLocal: updated.hourLocal ?? null,
        timezone: updated.timezone ?? null,
        lastSentOn: updated.lastSentOn ?? null,
      });
      Alert.alert("Saved", "Digest schedule updated.");
    } finally {
      setSaving(false);
    }
  };

  const sendPreview = async () => {
    if (!orgId || !token) return;
    setPreviewing(true);
    try {
      const res = await fetch(
        getApiUrl(`/organizations/${orgId}/bounced-digest-prefs/preview`),
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );
      const data = await res.json().catch(() => ({} as { error?: string; sentTo?: string }));
      if (!res.ok) {
        Alert.alert("Preview failed", data.error ?? `HTTP ${res.status}`);
        return;
      }
      Alert.alert(
        "Preview sent",
        data.sentTo ? `Check ${data.sentTo} for the digest preview.` : "Check your email.",
      );
    } finally {
      setPreviewing(false);
    }
  };

  if (!orgId || !token) return null;
  if (!allowed) return null;

  const freqLabel = FREQUENCY_OPTIONS.find((o) => o.value === prefs.frequency);
  const hourLabel = prefs.hourLocal == null
    ? "Any time"
    : `${String(prefs.hourLocal).padStart(2, "0")}:00`;

  return (
    <View style={styles.card} testID="card-bounced-digest-prefs">
      <View style={styles.headerRow}>
        <Feather name="mail" size={16} color="#fbbf24" />
        <Text style={styles.title}>Bounced-reminders email digest</Text>
      </View>
      <Text style={styles.subtitle}>
        We email member-admins a summary of unresolved bounced levy
        reminders. Pick the cadence and preferred local hour for your
        club.
      </Text>

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={GOLD} />
          <Text style={styles.loadingText}>Loading preferences…</Text>
        </View>
      ) : (
        <>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Frequency</Text>
            <TouchableOpacity
              style={styles.selectBtn}
              onPress={() => setFreqOpen(true)}
              testID="select-digest-frequency"
            >
              <Text style={styles.selectBtnText}>{freqLabel?.label ?? "Daily"}</Text>
              <Feather name="chevron-down" size={16} color={Colors.muted} />
            </TouchableOpacity>
            <Text style={styles.fieldHelp}>{freqLabel?.help}</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Local hour</Text>
            <TouchableOpacity
              style={styles.selectBtn}
              onPress={() => setHourOpen(true)}
              testID="select-digest-hour"
            >
              <Text style={styles.selectBtnText}>{hourLabel}</Text>
              <Feather name="chevron-down" size={16} color={Colors.muted} />
            </TouchableOpacity>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Timezone</Text>
            <View style={styles.tzRow}>
              <TextInput
                style={styles.tzInput}
                value={tzInput}
                onChangeText={(text) => {
                  const trimmed = text.trim();
                  setTzInput(text);
                  setPrefs((p) => ({ ...p, timezone: trimmed === "" ? null : trimmed }));
                }}
                placeholder="Asia/Kolkata"
                placeholderTextColor={Colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                testID="input-digest-timezone"
              />
              <TouchableOpacity
                style={styles.tzPickBtn}
                onPress={() => setTzOpen(true)}
                testID="button-pick-digest-timezone"
              >
                <Feather name="globe" size={16} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.fieldHelp}>
              IANA timezone name. Leave blank to use server time (UTC).
            </Text>
          </View>

          <Text style={styles.lastSent}>
            {prefs.lastSentOn
              ? `Last digest sent on ${prefs.lastSentOn} (local).`
              : "No digest has been sent under the current schedule yet."}
          </Text>

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btnGhost, (previewing || saving) && styles.btnDisabled]}
              disabled={previewing || saving}
              onPress={sendPreview}
              testID="button-preview-digest-now"
            >
              {previewing ? (
                <ActivityIndicator size="small" color={GOLD} />
              ) : (
                <Text style={styles.btnGhostText}>Send me a preview</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btnPrimary, saving && styles.btnDisabled]}
              disabled={saving}
              onPress={save}
              testID="button-save-digest-prefs"
            >
              {saving ? (
                <ActivityIndicator size="small" color="#0a1628" />
              ) : (
                <Text style={styles.btnPrimaryText}>Save schedule</Text>
              )}
            </TouchableOpacity>
          </View>
        </>
      )}

      <PickerModal
        visible={freqOpen}
        onClose={() => setFreqOpen(false)}
        title="Frequency"
        options={FREQUENCY_OPTIONS.map((o) => ({ key: o.value, label: o.label, sub: o.help }))}
        selectedKey={prefs.frequency}
        onSelect={(key) => {
          setPrefs((p) => ({ ...p, frequency: key as Frequency }));
          setFreqOpen(false);
        }}
        testID="modal-digest-frequency"
      />
      <PickerModal
        visible={hourOpen}
        onClose={() => setHourOpen(false)}
        title="Local hour"
        options={HOUR_OPTIONS.map((o) => ({
          key: o.value === null ? "any" : String(o.value),
          label: o.label,
        }))}
        selectedKey={prefs.hourLocal == null ? "any" : String(prefs.hourLocal)}
        onSelect={(key) => {
          setPrefs((p) => ({
            ...p,
            hourLocal: key === "any" ? null : parseInt(key, 10),
          }));
          setHourOpen(false);
        }}
        testID="modal-digest-hour"
      />
      <PickerModal
        visible={tzOpen}
        onClose={() => setTzOpen(false)}
        title="Common timezones"
        options={COMMON_TIMEZONES.map((tz) => ({ key: tz, label: tz }))}
        selectedKey={prefs.timezone ?? ""}
        onSelect={(key) => {
          setPrefs((p) => ({ ...p, timezone: key }));
          setTzInput(key);
          setTzOpen(false);
        }}
        testID="modal-digest-timezone"
      />
    </View>
  );
}

function PickerModal({
  visible,
  onClose,
  title,
  options,
  selectedKey,
  onSelect,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: { key: string; label: string; sub?: string }[];
  selectedKey: string;
  onSelect: (key: string) => void;
  testID?: string;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={pickerStyles.backdrop}>
        <View style={pickerStyles.sheet} testID={testID}>
          <View style={pickerStyles.header}>
            <Text style={pickerStyles.title}>{title}</Text>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close">
              <Feather name="x" size={22} color={Colors.text} />
            </TouchableOpacity>
          </View>
          <FlatList
            data={options}
            keyExtractor={(item) => item.key}
            renderItem={({ item }) => {
              const selected = item.key === selectedKey;
              return (
                <TouchableOpacity
                  style={pickerStyles.option}
                  onPress={() => onSelect(item.key)}
                  testID={`${testID}-option-${item.key}`}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={pickerStyles.optionLabel}>{item.label}</Text>
                    {item.sub ? (
                      <Text style={pickerStyles.optionSub}>{item.sub}</Text>
                    ) : null}
                  </View>
                  {selected ? (
                    <Feather name="check" size={18} color={GOLD} />
                  ) : null}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: Colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
  subtitle: { color: Colors.muted, fontSize: 12, marginTop: 6, lineHeight: 17 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12 },
  loadingText: { color: Colors.muted, fontSize: 12 },
  field: { marginTop: 14 },
  fieldLabel: {
    color: Colors.muted,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  fieldHelp: { color: Colors.muted, fontSize: 11, marginTop: 4, lineHeight: 15 },
  selectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 6,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  selectBtnText: { color: Colors.text, fontSize: 13, fontWeight: "500" },
  tzRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  tzInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: Colors.text,
    fontSize: 13,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  tzPickBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  lastSent: { color: Colors.muted, fontSize: 11, marginTop: 14, lineHeight: 15 },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 12,
  },
  btnGhost: {
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.4)",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 120,
    alignItems: "center",
  },
  btnGhostText: { color: "#fbbf24", fontSize: 12, fontWeight: "600" },
  btnPrimary: {
    backgroundColor: "#d97706",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 110,
    alignItems: "center",
  },
  btnPrimaryText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  btnDisabled: { opacity: 0.5 },
});

const pickerStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "75%",
    paddingBottom: 24,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: { color: Colors.text, fontSize: 15, fontWeight: "700" },
  option: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.05)",
  },
  optionLabel: { color: Colors.text, fontSize: 14 },
  optionSub: { color: Colors.muted, fontSize: 12, marginTop: 2 },
});
