import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack, router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { fetchPortal, postPortal, deletePortal } from "@/utils/api";

interface SessionRow {
  id: number;
  deviceLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  lastSeenAt: string | null;
  createdAt: string | null;
  revokedAt: string | null;
}

interface SetupResponse { secret: string; otpauthUrl: string; }

export default function SecurityScreen() {
  const { token } = useAuth();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [code, setCode] = useState("");
  const [currentCode, setCurrentCode] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [revokingId, setRevokingId] = useState<number | null>(null);

  const loadSessions = useCallback(async () => {
    if (!token) return;
    try {
      const d = await fetchPortal<{ sessions: SessionRow[] }>(`/sessions`, token);
      setSessions(d.sessions ?? []);
    } catch (e) {
      Alert.alert("Could not load sessions", e instanceof Error ? e.message : "Unknown");
    }
  }, [token]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  const startSetup = async () => {
    if (!token) return;
    setSetupLoading(true);
    try {
      const body = await postPortal<SetupResponse>(
        `/2fa/totp/setup`, token, currentCode ? { currentCode } : {}
      );
      setSetup(body);
      setConfirmed(false);
    } catch (e) {
      Alert.alert("Could not start 2FA setup", e instanceof Error ? e.message : "Unknown");
    } finally {
      setSetupLoading(false);
    }
  };

  const verify = async () => {
    if (!token) return;
    setVerifyLoading(true);
    try {
      await postPortal(`/2fa/totp/verify`, token, { code: code.trim() });
      setConfirmed(true);
      setSetup(null);
      setCode("");
      Alert.alert("2FA confirmed", "Your authenticator is now linked.");
    } catch (e) {
      Alert.alert("Verification failed", e instanceof Error ? e.message : "Unknown");
    } finally {
      setVerifyLoading(false);
    }
  };

  const revoke = async (id: number) => {
    if (!token) return;
    setRevokingId(id);
    try {
      await deletePortal(`/sessions/${id}`, token);
      await loadSessions();
    } catch (e) {
      Alert.alert("Could not revoke", e instanceof Error ? e.message : "Unknown");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.background }}>
      <Stack.Screen options={{ title: "Security" }} />
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} testID="button-back">
          <Feather name="chevron-left" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Security</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        <View style={styles.card} testID="card-2fa">
          <View style={styles.header}>
            <Feather name="shield" size={18} color={Colors.primary} />
            <Text style={styles.cardTitle}>Two-Factor Authentication</Text>
          </View>
          {confirmed && <Text style={styles.success}>2FA is enabled.</Text>}

          {!setup ? (
            <View style={{ gap: 8 }}>
              <Text style={styles.muted}>
                Use an authenticator app (Google Authenticator, 1Password, Authy) for sign-in 2FA.
              </Text>
              <Text style={styles.label}>If 2FA is already on, enter a current code:</Text>
              <TextInput
                value={currentCode}
                onChangeText={setCurrentCode}
                placeholder="123456"
                placeholderTextColor={Colors.muted}
                keyboardType="number-pad"
                style={styles.input}
                testID="input-current-code"
              />
              <TouchableOpacity onPress={startSetup} disabled={setupLoading} style={styles.primaryBtn} testID="button-start-2fa">
                {setupLoading
                  ? <LoadingSpinner color="#fff" />
                  : <Text style={styles.primaryBtnText}>Start setup</Text>}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ gap: 8 }} testID="block-totp-setup">
              <Text style={styles.muted}>Add this secret to your authenticator app, then enter the 6-digit code.</Text>
              <Text selectable style={styles.codeBlock} testID="text-totp-secret">{setup.secret}</Text>
              <Text style={styles.muted} numberOfLines={2}>{setup.otpauthUrl}</Text>
              <TextInput
                value={code}
                onChangeText={setCode}
                placeholder="6-digit code"
                placeholderTextColor={Colors.muted}
                keyboardType="number-pad"
                style={styles.input}
                testID="input-verify-code"
              />
              <TouchableOpacity onPress={verify} disabled={verifyLoading || code.length < 6} style={styles.primaryBtn} testID="button-verify-2fa">
                {verifyLoading ? <LoadingSpinner color="#fff" /> : <Text style={styles.primaryBtnText}>Verify</Text>}
              </TouchableOpacity>
            </View>
          )}
        </View>

        <View style={styles.card} testID="card-sessions">
          <View style={styles.header}>
            <Feather name="smartphone" size={18} color={Colors.primary} />
            <Text style={styles.cardTitle}>Active sessions</Text>
          </View>
          {sessions === null ? (
            <LoadingSpinner color={Colors.primary} />
          ) : sessions.length === 0 ? (
            <Text style={styles.muted}>No active sessions recorded.</Text>
          ) : (
            sessions.map(s => (
              <View key={s.id} style={styles.row} testID={`session-row-${s.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{s.deviceLabel ?? s.userAgent ?? "Unknown device"}</Text>
                  <Text style={styles.muted} numberOfLines={1}>
                    {(s.ip ?? "—") + " · " + (s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : "—")}
                    {s.revokedAt ? " · revoked" : ""}
                  </Text>
                </View>
                {!s.revokedAt && (
                  <TouchableOpacity onPress={() => revoke(s.id)} disabled={revokingId === s.id} testID={`button-revoke-${s.id}`}>
                    {revokingId === s.id
                      ? <LoadingSpinner color={Colors.primary} />
                      : <Feather name="trash-2" size={18} color={Colors.error} />}
                  </TouchableOpacity>
                )}
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10, borderBottomColor: Colors.border, borderBottomWidth: 1 },
  topBarTitle: { color: "#fff", fontSize: 17, fontWeight: "700" },
  card: { backgroundColor: Colors.card, borderRadius: 14, padding: 14, borderColor: Colors.border, borderWidth: 1, marginBottom: 16, gap: 8 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { color: "#fff", fontWeight: "700", fontSize: 16 },
  muted: { color: Colors.textSecondary, fontSize: 12 },
  label: { color: Colors.textSecondary, fontSize: 12 },
  success: { color: "#22c55e", fontSize: 13 },
  input: { backgroundColor: Colors.surface, color: "#fff", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderColor: Colors.border, borderWidth: 1 },
  primaryBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 11, alignItems: "center", marginTop: 4 },
  primaryBtnText: { color: "#fff", fontWeight: "700" },
  codeBlock: { backgroundColor: Colors.surface, borderColor: Colors.border, borderWidth: 1, borderRadius: 10, padding: 10, color: "#fff", fontFamily: "Menlo" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderTopColor: Colors.border, borderTopWidth: 1, gap: 8 },
  rowTitle: { color: "#fff", fontSize: 14 },
});
