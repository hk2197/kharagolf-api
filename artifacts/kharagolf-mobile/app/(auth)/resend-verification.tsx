import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Link } from "expo-router";
import { useTranslation } from "react-i18next";
import Colors from "@/constants/colors";
import { getApiUrl } from "@/utils/api";

export default function ResendVerificationScreen() {
  const { t } = useTranslation("auth");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResend() {
    setError(null);
    if (!email.trim()) { setError(t("common.enterEmailError")); return; }
    setLoading(true);
    try {
      const res = await fetch(getApiUrl("/auth/resend-verification"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-client-type": "mobile" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("resendVerification.failedToResend"));
      setSent(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("resendVerification.failedToResendVerification"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Image source={require('../../assets/logo.png')} style={styles.logoImage} resizeMode="contain" />
          <Text style={styles.logo}>KHARA<Text style={{ color: '#C9A84C' }}>GOLF</Text></Text>
          <Text style={styles.tagline}>ENTERPRISE</Text>
          <Text style={styles.title}>{t("resendVerification.title")}</Text>
          <Text style={styles.subtitle}>
            {t("resendVerification.subtitle")}
          </Text>
        </View>

        {sent ? (
          <View style={styles.successBox}>
            <Text style={styles.successTitle}>{t("resendVerification.sentTitle")}</Text>
            <Text style={styles.successText}>
              {t("resendVerification.sentBody", { email })}
            </Text>
            <Link href="/(auth)/login" asChild>
              <TouchableOpacity style={styles.backBtn}>
                <Text style={styles.backBtnText}>{t("common.backToSignIn")}</Text>
              </TouchableOpacity>
            </Link>
          </View>
        ) : (
          <View style={styles.form}>
            {error ? (
              <View style={styles.errorBox}>
                <Text
                  style={styles.errorText}
                  accessibilityRole="alert"
                  accessibilityLiveRegion="assertive"
                >
                  {error}
                </Text>
              </View>
            ) : null}

            <Text style={styles.label}>{t("common.emailLabel")}</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="your@email.com"
              placeholderTextColor={Colors.tabIconDefault}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              returnKeyType="done"
              onSubmitEditing={handleResend}
            />

            <TouchableOpacity style={styles.submitBtn} onPress={handleResend} disabled={loading}>
              {loading ? (
                <LoadingSpinner color="#fff" />
              ) : (
                <Text style={styles.submitBtnText}>{t("resendVerification.submit")}</Text>
              )}
            </TouchableOpacity>

            <Link href="/(auth)/login" asChild>
              <TouchableOpacity style={styles.cancelBtn}>
                <Text style={styles.cancelText}>{t("common.backToSignIn")}</Text>
              </TouchableOpacity>
            </Link>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: Colors.background, padding: 24, paddingTop: 60 },
  header: { marginBottom: 40, alignItems: "center" },
  logoImage: { width: 56, height: 56, marginBottom: 8 },
  logo: { fontSize: 28, fontWeight: "900", color: "#fff", letterSpacing: 6 },
  tagline: { fontSize: 10, color: Colors.primary, letterSpacing: 4, fontWeight: "700", marginTop: 2, marginBottom: 32 },
  title: { fontSize: 22, fontWeight: "700", color: "#fff", marginBottom: 8 },
  subtitle: { fontSize: 13, color: Colors.tabIconDefault, textAlign: "center", lineHeight: 20, paddingHorizontal: 8 },
  form: { width: "100%" },
  errorBox: { backgroundColor: "#3b0a0a", borderRadius: 8, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: "#7f1d1d" },
  errorText: { color: "#fecaca", fontSize: 13 },
  label: { fontSize: 13, fontWeight: "600", color: Colors.tabIconDefault, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 },
  input: { backgroundColor: Colors.surface, color: "#fff", borderRadius: 10, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, marginBottom: 20 },
  submitBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 16, alignItems: "center", marginBottom: 16 },
  submitBtnText: { color: "#fff", fontSize: 16, fontWeight: "700", letterSpacing: 0.5 },
  cancelBtn: { borderRadius: 10, paddingVertical: 16, alignItems: "center" },
  cancelText: { color: Colors.tabIconDefault, fontSize: 14 },
  successBox: { backgroundColor: "#052e16", borderRadius: 12, padding: 24, borderWidth: 1, borderColor: "#166534", alignItems: "center", gap: 12 },
  successTitle: { fontSize: 20, fontWeight: "700", color: Colors.primary },
  successText: { fontSize: 14, color: "#86efac", textAlign: "center", lineHeight: 22 },
  backBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 32, marginTop: 8 },
  backBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
