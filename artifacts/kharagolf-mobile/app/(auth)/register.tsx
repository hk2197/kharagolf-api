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
import { Link, router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";

export default function RegisterScreen() {
  const { t } = useTranslation("auth");
  const { register } = useAuth();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [emailDelivered, setEmailDelivered] = useState(true);

  async function handleRegister() {
    setError(null);
    if (!firstName || !lastName || !email || !password) {
      setError(t("register.allFieldsRequired"));
      return;
    }
    if (password.length < 8) {
      setError(t("register.passwordMin8"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("register.passwordsDoNotMatch"));
      return;
    }
    setLoading(true);
    try {
      const res = await register(firstName.trim(), lastName.trim(), email.trim(), password);
      setEmailDelivered(res.emailDelivered !== false);
      setSuccess(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("register.registrationFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <View style={styles.successContainer}>
        <View style={styles.successBox}>
          <Text style={styles.successIcon}>{emailDelivered ? "✉️" : "✅"}</Text>
          <Text style={styles.successTitle}>{emailDelivered ? t("register.successCheckInbox") : t("register.successAccountCreated")}</Text>
          {emailDelivered ? (
            <>
              <Text style={styles.successText}>
                {t("register.verificationLinkSentTo")} {"\n"}<Text style={{ color: Colors.primary }}>{email}</Text>
              </Text>
              <Text style={styles.successNote}>
                {t("register.activateAccountInstructions")}
              </Text>
            </>
          ) : (
            <Text style={styles.successNote}>
              {t("register.verificationEmailFailedFallback")}
            </Text>
          )}
          <TouchableOpacity style={styles.loginBtn} onPress={() => router.replace("/(auth)/login")}>
            <Text style={styles.loginBtnText}>{t("register.goToSignIn")}</Text>
          </TouchableOpacity>
        </View>
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
          <Text style={styles.title}>{t("register.title")}</Text>
          <Text style={styles.subtitle}>{t("register.subtitle")}</Text>
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

          <View style={styles.row}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={styles.label}>{t("register.firstName")}</Text>
              <TextInput style={styles.input} value={firstName} onChangeText={setFirstName} placeholder="John" placeholderTextColor={Colors.tabIconDefault} autoCapitalize="words" returnKeyType="next" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{t("register.lastName")}</Text>
              <TextInput style={styles.input} value={lastName} onChangeText={setLastName} placeholder="Smith" placeholderTextColor={Colors.tabIconDefault} autoCapitalize="words" returnKeyType="next" />
            </View>
          </View>

          <Text style={styles.label}>{t("common.emailLabel")}</Text>
          <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="your@email.com" placeholderTextColor={Colors.tabIconDefault} keyboardType="email-address" autoCapitalize="none" autoComplete="email" returnKeyType="next" />

          <Text style={styles.label}>{t("common.passwordLabel")}</Text>
          <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="Min. 8 characters" placeholderTextColor={Colors.tabIconDefault} secureTextEntry returnKeyType="next" />

          <Text style={styles.label}>{t("register.confirmPassword")}</Text>
          <TextInput style={styles.input} value={confirmPassword} onChangeText={setConfirmPassword} placeholder="Repeat password" placeholderTextColor={Colors.tabIconDefault} secureTextEntry returnKeyType="done" onSubmitEditing={handleRegister} />

          <TouchableOpacity style={styles.registerBtn} onPress={handleRegister} disabled={loading}>
            {loading ? <LoadingSpinner color="#fff" /> : <Text style={styles.registerBtnText}>{t("register.submit")}</Text>}
          </TouchableOpacity>

          <View style={styles.signinRow}>
            <Text style={styles.signinText}>{t("register.alreadyHaveAccount")} </Text>
            <Link href="/(auth)/login" asChild>
              <TouchableOpacity>
                <Text style={styles.signinLink}>{t("common.signIn")}</Text>
              </TouchableOpacity>
            </Link>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: Colors.background, padding: 24, paddingTop: 60 },
  successContainer: { flex: 1, backgroundColor: Colors.background, justifyContent: "center", alignItems: "center", padding: 24 },
  successBox: { backgroundColor: Colors.surface, borderRadius: 16, padding: 32, alignItems: "center", borderWidth: 1, borderColor: Colors.border },
  successIcon: { fontSize: 48, marginBottom: 16 },
  successTitle: { fontSize: 22, fontWeight: "800", color: "#fff", marginBottom: 12 },
  successText: { fontSize: 15, color: Colors.tabIconDefault, textAlign: "center", lineHeight: 22, marginBottom: 12 },
  successNote: { fontSize: 13, color: Colors.tabIconDefault, textAlign: "center", lineHeight: 20, marginBottom: 24 },
  loginBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 32, alignItems: "center" },
  loginBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  header: { marginBottom: 32, alignItems: "center" },
  logoImage: { width: 56, height: 56, marginBottom: 8 },
  logo: { fontSize: 28, fontWeight: "900", color: "#fff", letterSpacing: 6 },
  tagline: { fontSize: 10, color: Colors.primary, letterSpacing: 4, fontWeight: "700", marginTop: 2, marginBottom: 28 },
  title: { fontSize: 22, fontWeight: "700", color: "#fff", marginBottom: 8 },
  subtitle: { fontSize: 13, color: Colors.tabIconDefault, textAlign: "center" },
  form: { width: "100%" },
  row: { flexDirection: "row" },
  errorBox: { backgroundColor: "#3b0a0a", borderRadius: 8, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: "#7f1d1d" },
  errorText: { color: "#fecaca", fontSize: 13 },
  label: { fontSize: 12, fontWeight: "600", color: Colors.tabIconDefault, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 },
  input: { backgroundColor: Colors.surface, color: "#fff", borderRadius: 10, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 16, paddingVertical: 13, fontSize: 15, marginBottom: 14 },
  registerBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 16, alignItems: "center", marginTop: 8, marginBottom: 24 },
  registerBtnText: { color: "#fff", fontSize: 16, fontWeight: "700", letterSpacing: 1 },
  signinRow: { flexDirection: "row", justifyContent: "center" },
  signinText: { color: Colors.tabIconDefault, fontSize: 14 },
  signinLink: { color: Colors.primary, fontSize: 14, fontWeight: "700" },
});
