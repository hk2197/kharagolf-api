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
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";

export default function ForgotPasswordScreen() {
  const { t } = useTranslation("auth");
  const { forgotPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit() {
    setError(null);
    if (!email) { setError(t("common.enterEmailError")); return; }
    setLoading(true);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("forgotPassword.requestFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <View style={styles.center}>
        <Text style={styles.sentIcon}>📬</Text>
        <Text style={styles.sentTitle}>{t("forgotPassword.sentTitle")}</Text>
        <Text style={styles.sentText}>
          {t("forgotPassword.sentBodyPrefix")} <Text style={{ color: Colors.primary }}>{email}</Text>{t("forgotPassword.sentBodySuffix")}
        </Text>
        <Link href="/(auth)/login" asChild>
          <TouchableOpacity style={styles.backBtn}>
            <Text style={styles.backBtnText}>{t("common.backToSignIn")}</Text>
          </TouchableOpacity>
        </Link>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Image source={require('../../assets/logo.png')} style={styles.logoImage} resizeMode="contain" />
          <Text style={styles.logo}>KHARA<Text style={{ color: '#C9A84C' }}>GOLF</Text></Text>
          <Text style={styles.tagline}>ENTERPRISE</Text>
          <Text style={styles.title}>{t("forgotPassword.title")}</Text>
          <Text style={styles.subtitle}>{t("forgotPassword.subtitle")}</Text>
        </View>

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
            returnKeyType="done"
            onSubmitEditing={handleSubmit}
          />

          <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit} disabled={loading}>
            {loading ? <LoadingSpinner color="#fff" /> : <Text style={styles.submitBtnText}>{t("forgotPassword.submit")}</Text>}
          </TouchableOpacity>

          <Link href="/(auth)/login" asChild>
            <TouchableOpacity style={styles.backLink}>
              <Text style={styles.backLinkText}>{t("common.backToSignInArrow")}</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: Colors.background, padding: 24, paddingTop: 60 },
  center: { flex: 1, backgroundColor: Colors.background, justifyContent: "center", alignItems: "center", padding: 32 },
  sentIcon: { fontSize: 52, marginBottom: 20 },
  sentTitle: { fontSize: 22, fontWeight: "800", color: "#fff", marginBottom: 12 },
  sentText: { fontSize: 14, color: Colors.tabIconDefault, textAlign: "center", lineHeight: 22, marginBottom: 32 },
  backBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 32 },
  backBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  header: { marginBottom: 36, alignItems: "center" },
  logoImage: { width: 56, height: 56, marginBottom: 8 },
  logo: { fontSize: 28, fontWeight: "900", color: "#fff", letterSpacing: 6 },
  tagline: { fontSize: 10, color: Colors.primary, letterSpacing: 4, fontWeight: "700", marginTop: 2, marginBottom: 28 },
  title: { fontSize: 22, fontWeight: "700", color: "#fff", marginBottom: 8 },
  subtitle: { fontSize: 13, color: Colors.tabIconDefault, textAlign: "center" },
  form: { width: "100%" },
  errorBox: { backgroundColor: "#3b0a0a", borderRadius: 8, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: "#7f1d1d" },
  errorText: { color: "#fecaca", fontSize: 13 },
  label: { fontSize: 12, fontWeight: "600", color: Colors.tabIconDefault, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 },
  input: { backgroundColor: Colors.surface, color: "#fff", borderRadius: 10, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, marginBottom: 20 },
  submitBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 16, alignItems: "center", marginBottom: 16 },
  submitBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  backLink: { alignItems: "center", paddingVertical: 12 },
  backLinkText: { color: Colors.primary, fontSize: 14, fontWeight: "600" },
});
