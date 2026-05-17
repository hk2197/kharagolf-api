import React, { useEffect, useState, useCallback } from "react";
import { View, Text, ScrollView, StyleSheet, Switch, Alert } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { authedFetch, useActingMemberId, actingQs } from "./_shared";

interface Consent {
  id: number; consentType: string; granted: boolean; grantedAt: string; version: string | null; source: string | null;
}

// Task #381 — Privacy & consent center. Every data category we collect is
// listed here with a plain-English description so players can grant or
// withdraw consent per category. "privacy" and "terms" are required to use
// the app and are surfaced read-only at the top.
type ConsentDef = { key: string; label: string; description: string; required?: boolean; group: string };
const KNOWN_TYPES: ConsentDef[] = [
  { key: "privacy", label: "Privacy Policy", description: "Required to use this app.", required: true, group: "Required" },
  { key: "terms", label: "Terms of Service", description: "Required to use this app.", required: true, group: "Required" },
  { key: "directory", label: "Profile & directory listing", description: "Show my name in the searchable member directory.", group: "Profile" },
  { key: "scores", label: "Scores & handicap", description: "Store my scorecards and compute my handicap index.", group: "Play" },
  { key: "gps", label: "On-course GPS", description: "Use my device location during rounds for distance & shot tracking.", group: "Play" },
  { key: "photo", label: "Photography", description: "Allow the club to use photos of me in marketing material.", group: "Media" },
  { key: "video", label: "Video recordings", description: "Allow swing video and event recordings to be stored on my profile.", group: "Media" },
  { key: "health_wellness", label: "Health & wellness", description: "Sync heart-rate, sleep and activity data from wearables.", group: "Wellness" },
  { key: "social", label: "Social interactions", description: "Let me message other members and appear in club social feeds.", group: "Social" },
  { key: "ai", label: "AI personalisation", description: "Use my data to power AI insights, swing analysis and recommendations.", group: "AI" },
  { key: "marketing", label: "Marketing communications", description: "Newsletters, offers and event promotions.", group: "Marketing" },
  { key: "third_party_share", label: "Third-party sharing", description: "Share data with partner services (e.g. handicap bodies).", group: "Marketing" },
];

export default function ConsentsScreen() {
  const { token } = useAuth();
  const [acting] = useActingMemberId();
  const [history, setHistory] = useState<Consent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const rows = await authedFetch<Consent[]>(`/api/portal/my-consents${actingQs({ actingMemberId: acting })}`, token).catch(() => []);
    setHistory(rows);
  }, [token, acting]);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  const latestFor = (key: string): boolean => {
    const matches = history.filter(h => h.consentType === key)
      .sort((a, b) => new Date(b.grantedAt).getTime() - new Date(a.grantedAt).getTime());
    return matches[0]?.granted ?? false;
  };

  const toggle = async (key: string, next: boolean) => {
    if (!token) return;
    const def = KNOWN_TYPES.find(c => c.key === key);
    if (def?.required && !next) {
      Alert.alert("Required consent", `${def.label} is required to use the app and cannot be withdrawn here. Please contact your club administrator to close your account.`);
      return;
    }
    setSaving(key);
    try {
      await authedFetch(`/api/portal/my-consents${actingQs({ actingMemberId: acting })}`, token, {
        method: "PUT",
        body: JSON.stringify({ consentType: key, granted: next, version: "1.0" }),
      });
      await load();
    } catch (e) {
      Alert.alert("Could not save", (e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <View style={styles.center}><LoadingSpinner color={Colors.primary} /></View>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: Colors.background }} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.intro}>
        Manage what you consent to. Every change is recorded with a timestamp for compliance.
      </Text>
      {Array.from(new Set(KNOWN_TYPES.map(c => c.group))).map(group => (
        <View key={group}>
          <Text style={styles.groupTitle}>{group}</Text>
          {KNOWN_TYPES.filter(c => c.group === group).map(c => {
            const granted = latestFor(c.key);
            return (
              <View key={c.key} style={styles.card}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>{c.label}{c.required ? "  •  required" : ""}</Text>
                  <Text style={styles.description}>{c.description}</Text>
                </View>
                {saving === c.key
                  ? <LoadingSpinner color={Colors.primary} />
                  : <Switch
                      value={granted}
                      onValueChange={v => toggle(c.key, v)}
                      disabled={Boolean(c.required && granted)}
                      trackColor={{ false: "#374151", true: `${Colors.primary}80` }}
                      thumbColor={granted ? Colors.primary : "#9ca3af"} />}
              </View>
            );
          })}
        </View>
      ))}

      {history.length > 0 && (
        <>
          <Text style={styles.historyTitle}>History</Text>
          {history.slice(0, 20).map(h => (
            <View key={h.id} style={styles.historyRow}>
              <Text style={styles.historyType}>{h.consentType}</Text>
              <Text style={[styles.historyState, { color: h.granted ? "#22c55e" : "#f87171" }]}>{h.granted ? "GRANTED" : "WITHDRAWN"}</Text>
              <Text style={styles.historyDate}>{new Date(h.grantedAt).toLocaleString()}</Text>
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  intro: { color: Colors.tabIconDefault, fontSize: 12, marginBottom: 16 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.surface, borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: Colors.border },
  label: { color: "#fff", fontSize: 14, fontWeight: "700" },
  description: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 },
  groupTitle: { color: Colors.tabIconDefault, fontSize: 11, fontWeight: "700", marginTop: 14, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.6 },
  historyTitle: { color: "#fff", fontSize: 13, fontWeight: "700", marginTop: 24, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 },
  historyRow: { backgroundColor: Colors.surface, borderRadius: 8, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: Colors.border },
  historyType: { color: "#fff", fontSize: 12, fontWeight: "600" },
  historyState: { fontSize: 11, fontWeight: "700", marginTop: 2 },
  historyDate: { color: Colors.tabIconDefault, fontSize: 10, marginTop: 2 },
});
