import React, { useEffect, useState } from "react";
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
import * as AppleAuthentication from "expo-apple-authentication";
import * as Google from "expo-auth-session/providers/google";
import * as WebBrowser from "expo-web-browser";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";

WebBrowser.maybeCompleteAuthSession();

// Configured per-platform via app.json `extra` or env. Each Google
// platform (web, iOS, Android) needs its own OAuth client ID; the
// backend accepts any of them in GOOGLE_CLIENT_IDS.
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const GOOGLE_ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

// Whether a Google client ID is configured for the CURRENT platform.
// On web the SDK throws "Client Id property `webClientId` must be defined"
// when the hook is called without a webClientId, so we must guard the
// hook call entirely (not just the rendered button) on platforms that
// don't have a client ID configured.
const googleConfigured =
  Platform.OS === "ios" ? !!GOOGLE_IOS_CLIENT_ID
  : Platform.OS === "android" ? !!GOOGLE_ANDROID_CLIENT_ID
  : !!GOOGLE_WEB_CLIENT_ID;

export default function LoginScreen() {
  const { t } = useTranslation("auth");
  const { login, loginWithGoogle, loginWithApple } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [socialLoading, setSocialLoading] = useState<null | "apple" | "google">(null);

  // Apple sign-in is only available on iOS 13+ devices. Hide the button
  // everywhere else so Android players never see a non-functional control.
  useEffect(() => {
    if (Platform.OS !== "ios") { setAppleAvailable(false); return; }
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  async function handleAppleSignIn() {
    setError(null);
    setSocialLoading("apple");
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) {
        setError(t("login.appleIdentityTokenError"));
        return;
      }
      await loginWithApple(credential.identityToken, credential.fullName ?? undefined);
      router.replace("/(tabs)");
    } catch (e: unknown) {
      // ERR_REQUEST_CANCELED is thrown when the user dismisses the sheet.
      const code = (e as { code?: string } | undefined)?.code;
      if (code !== "ERR_REQUEST_CANCELED") {
        setError(e instanceof Error ? e.message : t("login.appleSignInFailed"));
      }
    } finally {
      setSocialLoading(null);
    }
  }

  async function handleLogin() {
    setError(null);
    setUnverified(false);
    if (!email || !password) {
      setError(t("login.enterEmailAndPassword"));
      return;
    }
    setLoading(true);
    try {
      await login(email.trim(), password);
      router.replace("/(tabs)");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t("login.loginFailed");
      if (msg.toLowerCase().includes("verify")) {
        setUnverified(true);
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Image source={require('../../assets/logo.png')} style={styles.logoImage} resizeMode="contain" accessibilityLabel="KHARAGOLF" />
          <Text style={styles.logo}>KHARA<Text style={{ color: '#C9A84C' }}>GOLF</Text></Text>
          <Text style={styles.tagline}>ENTERPRISE</Text>
          <Text style={styles.title}>{t("login.title")}</Text>
          <Text style={styles.subtitle}>{t("login.subtitle")}</Text>
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
              {unverified && (
                <Link href="/(auth)/resend-verification" asChild>
                  <TouchableOpacity style={styles.resendBtn}>
                    <Text style={styles.resendText}>{t("login.resendVerification")}</Text>
                  </TouchableOpacity>
                </Link>
              )}
            </View>
          ) : null}

          <Text style={styles.label} nativeID="login-email-label">{t("common.emailLabel")}</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="your@email.com"
            placeholderTextColor={Colors.tabIconDefault}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            returnKeyType="next"
            accessibilityLabel="Email Address"
            accessibilityLabelledBy="login-email-label"
            testID="login-email-input"
          />

          <Text style={styles.label} nativeID="login-password-label">{t("common.passwordLabel")}</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={Colors.tabIconDefault}
            secureTextEntry
            autoComplete="password"
            returnKeyType="done"
            onSubmitEditing={handleLogin}
            accessibilityLabel="Password"
            accessibilityLabelledBy="login-password-label"
            testID="login-password-input"
          />

          <Link href="/(auth)/forgot-password" asChild>
            <TouchableOpacity style={styles.forgotBtn}>
              <Text style={styles.forgotText}>{t("login.forgotPassword")}</Text>
            </TouchableOpacity>
          </Link>

          <TouchableOpacity
            style={styles.loginBtn}
            onPress={handleLogin}
            disabled={loading}
            testID="login-submit-button"
            accessibilityRole="button"
          >
            {loading ? (
              <LoadingSpinner color="#fff" />
            ) : (
              <Text style={styles.loginBtnText}>{t("login.submit")}</Text>
            )}
          </TouchableOpacity>

          {(appleAvailable || googleConfigured) && (
            <View style={styles.socialDivider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>{t("login.orContinueWith")}</Text>
              <View style={styles.dividerLine} />
            </View>
          )}

          {appleAvailable && (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={10}
              style={styles.appleBtn}
              onPress={handleAppleSignIn}
            />
          )}

          {googleConfigured && (
            <GoogleSignInButton
              onError={setError}
              socialLoading={socialLoading}
              setSocialLoading={setSocialLoading}
            />
          )}

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>{t("login.newToKharagolfPrefix")}<Text style={{ color: '#C9A84C' }}>GOLF</Text>{t("login.newToKharagolfSuffix")}</Text>
            <View style={styles.dividerLine} />
          </View>

          <Link href="/(auth)/register" asChild>
            <TouchableOpacity style={styles.registerBtn}>
              <Text style={styles.registerBtnText}>{t("login.createPlayerAccount")}</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// Google sign-in is rendered as a separate component so that
// `Google.useIdTokenAuthRequest` is only called when a client ID is
// configured for the current platform. The hook throws on web when
// `webClientId` is undefined, so we must guard the hook call itself —
// guarding only the rendered button is not enough.
function GoogleSignInButton({
  onError,
  socialLoading,
  setSocialLoading,
}: {
  onError: (msg: string) => void;
  socialLoading: null | "apple" | "google";
  setSocialLoading: (v: null | "apple" | "google") => void;
}) {
  const { t } = useTranslation("auth");
  const { loginWithGoogle } = useAuth();

  const [, googleResponse, promptGoogle] = Google.useIdTokenAuthRequest({
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    androidClientId: GOOGLE_ANDROID_CLIENT_ID,
    webClientId: GOOGLE_WEB_CLIENT_ID,
    clientId: GOOGLE_WEB_CLIENT_ID,
  });

  useEffect(() => {
    if (googleResponse?.type !== "success") return;
    const idToken = googleResponse.params?.id_token;
    if (!idToken) return;
    setSocialLoading("google");
    loginWithGoogle(idToken)
      .then(() => router.replace("/(tabs)"))
      .catch((e: unknown) => onError(e instanceof Error ? e.message : t("login.googleSignInFailed")))
      .finally(() => setSocialLoading(null));
  }, [googleResponse, loginWithGoogle, onError, setSocialLoading, t]);

  async function handlePress() {
    try {
      await promptGoogle();
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : t("login.googleSignInFailed"));
    }
  }

  return (
    <TouchableOpacity
      style={styles.googleBtn}
      onPress={handlePress}
      disabled={socialLoading !== null}
    >
      {socialLoading === "google" ? (
        <LoadingSpinner color="#000" />
      ) : (
        <>
          <Image
            source={{ uri: "https://developers.google.com/identity/images/g-logo.png" }}
            style={styles.googleLogo}
          />
          <Text style={styles.googleBtnText}>{t("login.continueWithGoogle")}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: Colors.background, padding: 24, paddingTop: 60 },
  header: { marginBottom: 40, alignItems: "center" },
  logoImage: { width: 56, height: 56, marginBottom: 8 },
  logo: { fontSize: 28, fontWeight: "900", color: "#fff", letterSpacing: 6 },
  tagline: { fontSize: 10, color: Colors.primary, letterSpacing: 4, fontWeight: "700", marginTop: 2, marginBottom: 32 },
  title: { fontSize: 22, fontWeight: "700", color: "#fff", marginBottom: 8 },
  subtitle: { fontSize: 13, color: Colors.tabIconDefault, textAlign: "center", lineHeight: 20 },
  form: { width: "100%" },
  errorBox: { backgroundColor: "#3b0a0a", borderRadius: 8, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: "#7f1d1d" },
  errorText: { color: "#fecaca", fontSize: 13, lineHeight: 18 },
  resendBtn: { marginTop: 8 },
  resendText: { color: Colors.primary, fontSize: 13, fontWeight: "600" },
  label: { fontSize: 13, fontWeight: "600", color: Colors.tabIconDefault, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 },
  input: { backgroundColor: Colors.surface, color: "#fff", borderRadius: 10, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, marginBottom: 16 },
  forgotBtn: { alignSelf: "flex-end", marginBottom: 24 },
  forgotText: { color: Colors.primary, fontSize: 13, fontWeight: "600" },
  loginBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 16, alignItems: "center", marginBottom: 24 },
  loginBtnText: { color: "#fff", fontSize: 16, fontWeight: "700", letterSpacing: 1 },
  socialDivider: { flexDirection: "row", alignItems: "center", marginBottom: 16, gap: 12 },
  appleBtn: { width: "100%", height: 48, marginBottom: 12 },
  googleBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: "#fff", borderRadius: 10, paddingVertical: 14, marginBottom: 24 },
  googleBtnText: { color: "#1f1f1f", fontSize: 15, fontWeight: "600" },
  googleLogo: { width: 18, height: 18 },
  divider: { flexDirection: "row", alignItems: "center", marginBottom: 24, gap: 12 },
  dividerLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  dividerText: { color: Colors.tabIconDefault, fontSize: 12 },
  registerBtn: { borderRadius: 10, paddingVertical: 16, alignItems: "center", borderWidth: 1, borderColor: Colors.primary },
  registerBtnText: { color: Colors.primary, fontSize: 16, fontWeight: "700" },
});
