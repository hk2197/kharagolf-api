import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, TextInput, Alert, Switch, StyleSheet, Linking, Share, Modal, Pressable, Platform, Image } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import QRCode from "react-native-qrcode-svg";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Google from "expo-auth-session/providers/google";
import * as WebBrowser from "expo-web-browser";
import { useAuth } from "@/context/auth";

WebBrowser.maybeCompleteAuthSession();

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : "";

// Same per-platform Google client IDs the login screen uses (each
// platform — web/iOS/Android — is its own OAuth client). The backend
// accepts any of them via GOOGLE_CLIENT_IDS.
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const GOOGLE_ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

// Whether a Google client ID is configured for the CURRENT platform.
// Mirrors the guard in app/(auth)/login.tsx — `Google.useIdTokenAuthRequest`
// throws "Client Id property `webClientId` must be defined to use Google
// auth on this platform" on web when called without a webClientId, so we
// must avoid calling the hook AT ALL on platforms that don't have a
// client ID configured. A loose `iosId || androidId || webId` check is
// not enough: it would still render true on web with only a native ID
// set, and the hook would still crash the web preview.
const googleConfigured =
  Platform.OS === "ios" ? !!GOOGLE_IOS_CLIENT_ID
  : Platform.OS === "android" ? !!GOOGLE_ANDROID_CLIENT_ID
  : !!GOOGLE_WEB_CLIENT_ID;

interface Settings {
  publicHandle: string | null;
  publicProfileEnabled: boolean;
  publicShowHandicap: boolean;
  publicShowRecentRounds: boolean;
  publicShowAchievements: boolean;
  publicShowFavoriteCourses: boolean;
  publicBio: string | null;
  publicLocation: string | null;
}

interface ShareStats {
  total: number;
  byMethod: Record<string, number>;
  // Task #1458 — web vs mobile reach split. Counts only events tagged
  // with a known source after source-tracking shipped, so the totals
  // here may sum to less than `total` for owners with legacy history.
  bySource?: { web: number; mobile: number };
}

interface ScorecardRow {
  playerId: number;
  shareToken: string;
  publicHidden: boolean;
  tournamentName: string;
  startDate: string | null;
}

interface SocialLink {
  provider: "apple" | "google";
  linkedAt: string;
  lastUsedAt: string;
  legacy?: boolean;
}

interface SocialLinksResponse {
  hasPassword: boolean;
  hasReplitOauth: boolean;
  links: SocialLink[];
}

export default function PortalPrivacyScreen() {
  const { token } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [scorecards, setScorecards] = useState<ScorecardRow[]>([]);
  const [shareStats, setShareStats] = useState<ShareStats | null>(null);
  const [socialLinks, setSocialLinks] = useState<SocialLinksResponse | null>(null);
  const [unlinking, setUnlinking] = useState<"apple" | "google" | null>(null);
  const [linking, setLinking] = useState<"apple" | "google" | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [handleDraft, setHandleDraft] = useState("");
  const [bioDraft, setBioDraft] = useState("");
  const [locDraft, setLocDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const headers = token ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` } : { "Content-Type": "application/json" };

  // Apple Sign-In is only available on iOS 13+. Hide the button everywhere
  // else so Android players never see a non-functional control.
  useEffect(() => {
    if (Platform.OS !== "ios") { setAppleAvailable(false); return; }
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  async function refreshSocialLinks() {
    try {
      const r = await fetch(`${BASE_URL}/api/portal/me/social-links`, { headers });
      if (r.ok) setSocialLinks(await r.json());
    } catch { /* swallow */ }
  }

  // Task #1735: map the API's stable `error` codes (documented in
  // routes/wave3.ts) to actionable copy so players know WHY the link
  // failed — generic "Could not link" fell through too many real causes
  // (expired token, unverified email, server misconfig, network blip).
  function linkErrorTitleAndBody(
    provider: "apple" | "google",
    code: string | undefined,
    detail: string | undefined,
  ): { title: string; body: string } {
    const label = provider === "apple" ? "Apple" : "Google";
    switch (code) {
      case "provider_already_linked":
        return {
          title: "Already linked elsewhere",
          body: detail ?? `This ${provider === "apple" ? "Apple ID" : "Google account"} is already linked to a different KHARAGOLF account.`,
        };
      case "token_required":
        return {
          title: "Couldn't link",
          body: detail ?? (provider === "apple"
            ? "Apple didn't return a sign-in token. Try again and choose \"Share My Email\" when prompted."
            : "Google didn't return a sign-in token. Please try linking again."),
        };
      case "token_invalid":
        return {
          title: "Couldn't link",
          body: detail ?? `We couldn't verify your ${label} sign-in. The token may have expired — please try again.`,
        };
      case "email_not_verified":
        return {
          title: "Verify your email first",
          body: detail ?? `Your ${label} email isn't verified yet. Verify it with ${label}, then try linking again.`,
        };
      case "provider_not_configured":
        return {
          title: `${label} sign-in unavailable`,
          body: detail ?? `${label} sign-in isn't set up on this server. Please contact KHARAGOLF support.`,
        };
      default:
        return {
          title: "Couldn't link",
          body: detail ?? `Could not link ${label}. Please try again.`,
        };
    }
  }

  async function postLink(provider: "apple" | "google", body: Record<string, unknown>) {
    setLinking(provider);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/me/social-links/${provider}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string; detail?: string }));
        const { title, body: msg } = linkErrorTitleAndBody(provider, j.error, j.detail);
        Alert.alert(title, msg);
        return;
      }
      await refreshSocialLinks();
    } catch {
      Alert.alert(
        "Couldn't link",
        `We couldn't reach KHARAGOLF to link ${provider === "apple" ? "Apple" : "Google"}. Check your connection and try again.`,
      );
    } finally {
      setLinking(null);
    }
  }

  async function handleLinkApple() {
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) {
        Alert.alert(
          "Couldn't link",
          "Apple didn't return a sign-in token. Try again and choose \"Share My Email\" when prompted.",
        );
        return;
      }
      const fullName = credential.fullName
        ? { givenName: credential.fullName.givenName ?? undefined, familyName: credential.fullName.familyName ?? undefined }
        : undefined;
      await postLink("apple", { identityToken: credential.identityToken, fullName });
    } catch (e: unknown) {
      // Task #1735: previously we silently swallowed ERR_REQUEST_CANCELED.
      // Players who tapped Cancel had no acknowledgement and would often
      // tap "Link Apple" again, confused. Now we tell them explicitly.
      const code = (e as { code?: string } | undefined)?.code;
      if (code === "ERR_REQUEST_CANCELED") {
        Alert.alert(
          "Apple sign-in cancelled",
          "Linking was cancelled. Try again when you're ready.",
        );
        return;
      }
      Alert.alert("Couldn't link", e instanceof Error ? e.message : "Apple sign-in failed");
    }
  }

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    Promise.all([
      fetch(`${BASE_URL}/api/portal/me/public-profile`, { headers }).then(r => r.ok ? r.json() : null),
      fetch(`${BASE_URL}/api/portal/me/public-scorecards`, { headers }).then(r => r.ok ? r.json() : []),
      fetch(`${BASE_URL}/api/portal/me/public-profile/share-stats`, { headers }).then(r => r.ok ? r.json() : null),
      fetch(`${BASE_URL}/api/portal/me/social-links`, { headers }).then(r => r.ok ? r.json() : null),
    ]).then(([s, sc, st, sl]) => {
      if (s) {
        setSettings(s);
        setHandleDraft(s.publicHandle ?? "");
        setBioDraft(s.publicBio ?? "");
        setLocDraft(s.publicLocation ?? "");
      }
      setScorecards(sc ?? []);
      setShareStats(st);
      setSocialLinks(sl);
    }).finally(() => setLoading(false));
  }, [token]);

  async function unlinkProvider(provider: "apple" | "google") {
    if (!socialLinks) return;
    const others = socialLinks.links.filter(l => l.provider !== provider).length;
    const safeToUnlink = socialLinks.hasPassword || socialLinks.hasReplitOauth || others > 0;
    if (!safeToUnlink) {
      Alert.alert(
        "Can't unlink",
        "This is your only way to sign in. Set a password or link another provider before removing this one.",
      );
      return;
    }
    const label = provider === "apple" ? "Apple" : "Google";
    Alert.alert(
      `Unlink ${label}?`,
      `You'll no longer be able to sign in with ${label} until you link it again.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unlink",
          style: "destructive",
          onPress: async () => {
            setUnlinking(provider);
            try {
              const res = await fetch(`${BASE_URL}/api/portal/me/social-links/${provider}`, { method: "DELETE", headers });
              if (!res.ok) {
                const j = await res.json().catch(() => ({} as { error?: string; detail?: string }));
                Alert.alert("Couldn't unlink", j.detail ?? j.error ?? "Please try again.");
                return;
              }
              const refreshed = await fetch(`${BASE_URL}/api/portal/me/social-links`, { headers }).then(r => r.ok ? r.json() : null);
              setSocialLinks(refreshed);
            } finally {
              setUnlinking(null);
            }
          },
        },
      ],
    );
  }

  async function patch(body: Partial<Settings>) {
    if (!settings) return;
    setBusy(true);
    const res = await fetch(`${BASE_URL}/api/portal/me/public-profile`, { method: "PATCH", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({} as { error?: string }));
      Alert.alert("Save failed", j.error ?? "Could not update privacy settings.");
    } else {
      const updated = await res.json();
      setSettings(updated);
    }
    setBusy(false);
  }

  async function toggleScorecard(playerId: number, hidden: boolean) {
    const res = await fetch(`${BASE_URL}/api/portal/me/public-scorecards/${playerId}`, { method: "PATCH", headers, body: JSON.stringify({ publicHidden: hidden }) });
    if (res.ok) setScorecards(prev => prev.map(s => s.playerId === playerId ? { ...s, publicHidden: hidden } : s));
  }

  if (loading) return <SafeAreaView style={styles.center}><LoadingSpinner size="large" /></SafeAreaView>;

  if (!token || !settings) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.muted}>Sign in to manage privacy settings.</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => router.replace("/(tabs)/profile")}><Text style={styles.primaryBtnText}>Go back</Text></TouchableOpacity>
      </SafeAreaView>
    );
  }

  const profileUrl = settings.publicHandle ? `https://kharagolf.com/p/${settings.publicHandle}` : null;

  function trackShare(method: "copy" | "web_share" | "native_share" | "qr_open") {
    // Best-effort analytics: never block the UI.
    fetch(`${BASE_URL}/api/portal/me/profile-share-events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ method, source: "mobile" }),
    })
      .then(() => refreshShareStats())
      .catch(() => { /* swallow */ });
  }

  async function refreshShareStats() {
    try {
      const r = await fetch(`${BASE_URL}/api/portal/me/public-profile/share-stats`, { headers });
      if (r.ok) setShareStats(await r.json());
    } catch { /* swallow */ }
  }

  async function shareProfile() {
    if (!profileUrl) return;
    try {
      const result = await Share.share({
        message: `Check out my golf profile on KHARAGOLF: ${profileUrl}`,
        url: profileUrl,
        title: settings?.publicHandle ? `@${settings.publicHandle} on KHARAGOLF` : "My KHARAGOLF profile",
      });
      if (result.action !== Share.dismissedAction) {
        trackShare("native_share");
      }
    } catch {
      Alert.alert("Share failed", "Could not open the share sheet.");
    }
  }

  function openQr() {
    setQrOpen(true);
    trackShare("qr_open");
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0a1a0f" }} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}><Feather name="chevron-left" size={26} color="#fff" /></TouchableOpacity>
        <Text style={styles.headerTitle}>Public profile & privacy</Text>
        <View style={{ width: 26 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <View style={styles.card}>
          <Text style={styles.h2}>Profile handle</Text>
          <Text style={styles.muted}>Your profile lives at kharagolf.com/p/&lt;handle&gt;. 3–30 chars: lowercase letters, numbers, dashes, underscores.</Text>
          <View style={styles.inputRow}>
            <Text style={styles.atSign}>@</Text>
            <TextInput
              value={handleDraft}
              onChangeText={(t) => setHandleDraft(t.toLowerCase())}
              placeholder="your-handle"
              placeholderTextColor="#666"
              autoCapitalize="none"
              style={styles.input}
              testID="handle-input"
            />
          </View>
          <TouchableOpacity
            disabled={busy || handleDraft === (settings.publicHandle ?? "")}
            onPress={() => patch({ publicHandle: handleDraft.trim() || null })}
            style={[styles.primaryBtn, (busy || handleDraft === (settings.publicHandle ?? "")) && styles.btnDisabled]}
            testID="handle-save"
          >
            <Text style={styles.primaryBtnText}>Save handle</Text>
          </TouchableOpacity>
          {profileUrl && (
            <TouchableOpacity onPress={() => Linking.openURL(profileUrl)} style={{ marginTop: 10 }}>
              <Text style={styles.link}>{profileUrl}</Text>
            </TouchableOpacity>
          )}
          {settings.publicProfileEnabled && profileUrl && (
            <>
              <View style={styles.shareRow} testID="share-row">
                <TouchableOpacity onPress={shareProfile} style={[styles.primaryBtn, styles.shareBtn]} testID="share-button">
                  <Feather name="share" size={14} color="#fff" />
                  <Text style={[styles.primaryBtnText, { marginLeft: 6 }]}>Share my profile</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={openQr} style={[styles.secondaryBtn, styles.shareBtn]} testID="qr-button">
                  <Feather name="grid" size={14} color="#10b981" />
                  <Text style={[styles.secondaryBtnText, { marginLeft: 6 }]}>QR code</Text>
                </TouchableOpacity>
              </View>
              {shareStats && (
                <View style={styles.statsBox} testID="share-stats">
                  <Text style={styles.statsTotal}>
                    {shareStats.total === 0
                      ? "No shares yet — be the first to spread the word!"
                      : `${shareStats.total} ${shareStats.total === 1 ? "share" : "shares"} so far`}
                  </Text>
                  {shareStats.total > 0 && (
                    <Text style={styles.statsBreakdown}>
                      Native: {shareStats.byMethod.native_share ?? 0}  ·  QR: {shareStats.byMethod.qr_open ?? 0}  ·  Copy: {shareStats.byMethod.copy ?? 0}  ·  Web: {shareStats.byMethod.web_share ?? 0}
                    </Text>
                  )}
                  {/* Task #1458 — Web vs mobile reach split. Only render
                      when at least one tagged source is present so owners
                      with only legacy/null-source history aren't shown
                      a meaningless "0 web · 0 mobile" row. */}
                  {shareStats.bySource && (shareStats.bySource.web > 0 || shareStats.bySource.mobile > 0) && (
                    <View style={styles.sourceRow} testID="share-source-split">
                      <Text style={styles.sourceLabel}>Where shares come from:</Text>
                      <View style={styles.sourceChips}>
                        <View style={[styles.sourceChip, styles.sourceChipWeb]} testID="share-source-web">
                          <Text style={styles.sourceChipTextWeb}>Web {shareStats.bySource.web}</Text>
                        </View>
                        <View style={[styles.sourceChip, styles.sourceChipMobile]} testID="share-source-mobile">
                          <Text style={styles.sourceChipTextMobile}>Mobile {shareStats.bySource.mobile}</Text>
                        </View>
                      </View>
                    </View>
                  )}
                </View>
              )}
            </>
          )}
        </View>

        <View style={styles.card}>
          <ToggleRow
            label="Public profile"
            description="Make your profile discoverable. Off by default."
            value={settings.publicProfileEnabled}
            onChange={(v) => patch({ publicProfileEnabled: v })}
            disabled={busy || !settings.publicHandle}
            testID="toggle-profile-enabled"
          />
          {!settings.publicHandle && <Text style={styles.warn}>Reserve a handle above before turning on.</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>Section visibility</Text>
          <ToggleRow label="Show handicap journey" description="Display your handicap history." value={settings.publicShowHandicap} onChange={(v) => patch({ publicShowHandicap: v })} disabled={busy} />
          <ToggleRow label="Show recent rounds" description="List your recent shareable scorecards." value={settings.publicShowRecentRounds} onChange={(v) => patch({ publicShowRecentRounds: v })} disabled={busy} />
          <ToggleRow label="Show achievements" description="Display badges & milestones." value={settings.publicShowAchievements} onChange={(v) => patch({ publicShowAchievements: v })} disabled={busy} />
          <ToggleRow label="Show favourite courses" description="Display courses you play most." value={settings.publicShowFavoriteCourses} onChange={(v) => patch({ publicShowFavoriteCourses: v })} disabled={busy} />
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>About you</Text>
          <Text style={styles.label}>Location</Text>
          <TextInput value={locDraft} onChangeText={setLocDraft} placeholder="e.g. Mumbai, India" placeholderTextColor="#666" maxLength={120} style={styles.input} />
          <Text style={[styles.label, { marginTop: 12 }]}>Short bio</Text>
          <TextInput value={bioDraft} onChangeText={setBioDraft} placeholder="Tell visitors about your golf journey…" placeholderTextColor="#666" maxLength={500} multiline style={[styles.input, { height: 90, textAlignVertical: "top" }]} />
          <Text style={styles.muted}>{bioDraft.length}/500</Text>
          <TouchableOpacity
            disabled={busy || (bioDraft === (settings.publicBio ?? "") && locDraft === (settings.publicLocation ?? ""))}
            onPress={() => patch({ publicBio: bioDraft.trim() || null, publicLocation: locDraft.trim() || null })}
            style={[styles.primaryBtn, busy && styles.btnDisabled]}
          >
            <Text style={styles.primaryBtnText}>Save</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card} testID="linked-accounts-section">
          <Text style={styles.h2}>Linked accounts</Text>
          <Text style={styles.muted}>
            Apple and Google sign-in shortcuts. Removing a link won't sign you out, but you won't be able to use that provider until you link it again.
          </Text>
          {socialLinks === null ? (
            <Text style={[styles.muted, { marginTop: 12 }]}>Couldn't load linked accounts.</Text>
          ) : (
            <>
              {socialLinks.links.length === 0 ? (
                <Text style={[styles.muted, { marginTop: 12 }]} testID="no-linked-accounts">
                  You haven't linked Apple or Google yet — link one below to skip the password next time.
                </Text>
              ) : (
                socialLinks.links.map(link => {
                  const others = socialLinks.links.filter(l => l.provider !== link.provider).length;
                  const safeToUnlink = socialLinks.hasPassword || socialLinks.hasReplitOauth || others > 0;
                  const label = link.provider === "apple" ? "Apple" : "Google";
                  return (
                    <View key={link.provider} style={styles.scRow} testID={`linked-${link.provider}`}>
                      <View style={{ flex: 1, paddingRight: 12 }}>
                        <Text style={styles.scTitle}>{label}</Text>
                        <Text style={styles.muted}>
                          {link.legacy
                            ? "Linked before tracking began"
                            : `Linked ${new Date(link.linkedAt).toLocaleDateString()} · last used ${new Date(link.lastUsedAt).toLocaleDateString()}`}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => unlinkProvider(link.provider)}
                        disabled={!safeToUnlink || unlinking === link.provider}
                        style={[styles.secondaryBtn, { marginTop: 0, paddingHorizontal: 12, paddingVertical: 8 }, (!safeToUnlink || unlinking === link.provider) && styles.btnDisabled]}
                        testID={`unlink-${link.provider}`}
                      >
                        {unlinking === link.provider
                          ? <LoadingSpinner size="small" color="#10b981" />
                          : <Text style={styles.secondaryBtnText}>Unlink</Text>}
                      </TouchableOpacity>
                    </View>
                  );
                })
              )}

              {/* Add-a-link buttons — one per provider that isn't already
                  in `socialLinks.links`. Only render rows for providers
                  that are actually available on this build (Google: any
                  client ID configured; Apple: iOS 13+). */}
              {(() => {
                const googleLinked = socialLinks.links.some(l => l.provider === "google");
                const appleLinked = socialLinks.links.some(l => l.provider === "apple");
                const showGoogle = !googleLinked && googleConfigured;
                const showApple = !appleLinked && appleAvailable;
                if (!showGoogle && !showApple) return null;
                return (
                  <View style={styles.linkSection} testID="link-account-section">
                    <Text style={[styles.muted, { marginBottom: 8 }]}>Link another provider for one-tap sign-in:</Text>
                    {showGoogle && (
                      <GoogleLinkButton
                        linking={linking}
                        onIdToken={(idToken) => { void postLink("google", { idToken }); }}
                      />
                    )}
                    {showApple && (
                      <AppleAuthentication.AppleAuthenticationButton
                        buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                        cornerRadius={8}
                        style={styles.appleLinkBtn}
                        onPress={handleLinkApple}
                      />
                    )}
                  </View>
                );
              })()}
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>Hide individual scorecards</Text>
          <Text style={styles.muted}>Hidden scorecards return 404 even with the share link.</Text>
          {scorecards.length === 0 ? (
            <Text style={[styles.muted, { marginTop: 12 }]}>No shareable scorecards yet.</Text>
          ) : scorecards.map(sc => (
            <View key={sc.playerId} style={styles.scRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.scTitle} numberOfLines={1}>{sc.tournamentName}</Text>
                <Text style={styles.muted}>{sc.startDate ? new Date(sc.startDate).toLocaleDateString() : "—"}</Text>
              </View>
              <Switch value={sc.publicHidden} onValueChange={(v) => toggleScorecard(sc.playerId, v)} />
              <Text style={[styles.muted, { marginLeft: 8, width: 56 }]}>{sc.publicHidden ? "Hidden" : "Visible"}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <Modal visible={qrOpen} transparent animationType="fade" onRequestClose={() => setQrOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setQrOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()} testID="qr-modal">
            <Text style={styles.modalTitle}>Scan to view profile</Text>
            <Text style={[styles.muted, { textAlign: "center", marginBottom: 14 }]}>
              {settings.publicHandle ? `@${settings.publicHandle}` : ""}
            </Text>
            {profileUrl && (
              <View style={styles.qrWrap}>
                <QRCode value={profileUrl} size={220} backgroundColor="#fff" color="#0a1a0f" />
              </View>
            )}
            {profileUrl && <Text style={[styles.link, { marginTop: 12, textAlign: "center" }]}>{profileUrl}</Text>}
            <TouchableOpacity onPress={() => setQrOpen(false)} style={[styles.primaryBtn, { marginTop: 16 }]} testID="qr-close">
              <Text style={styles.primaryBtnText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

// Google "Link" button is rendered as a separate child component so that
// `Google.useIdTokenAuthRequest` is only called when a client ID is
// configured for the current platform. The hook throws on web when
// `webClientId` is undefined ("Client Id property `webClientId` must be
// defined to use Google auth on this platform"), which previously
// crashed the entire portal-privacy screen into the error boundary in
// the Expo web preview when EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID was unset.
// Mirrors the GoogleSignInButton pattern in app/(auth)/login.tsx.
function GoogleLinkButton({
  linking,
  onIdToken,
}: {
  linking: "apple" | "google" | null;
  onIdToken: (idToken: string) => void;
}) {
  const [, googleResponse, promptGoogle] = Google.useIdTokenAuthRequest({
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    androidClientId: GOOGLE_ANDROID_CLIENT_ID,
    webClientId: GOOGLE_WEB_CLIENT_ID,
    clientId: GOOGLE_WEB_CLIENT_ID,
  });

  // Resolve the Google response once it arrives. The hook resolves
  // asynchronously after `promptGoogle()` completes, so we listen here.
  // Task #1735: previously we only acted on `type === "success"` and
  // silently dropped "cancel" / "dismiss" / "error" — players had no way
  // to tell whether the system sheet had failed or they had dismissed
  // it. We now surface a tailored Alert for each non-success branch.
  useEffect(() => {
    if (!googleResponse) return;
    if (googleResponse.type === "success") {
      const idToken = googleResponse.params?.id_token;
      if (!idToken) {
        Alert.alert(
          "Couldn't link",
          "Google didn't return a sign-in token. Please try linking again.",
        );
        return;
      }
      onIdToken(idToken);
      return;
    }
    if (googleResponse.type === "cancel" || googleResponse.type === "dismiss") {
      Alert.alert(
        "Google sign-in cancelled",
        "Linking was cancelled. Try again when you're ready.",
      );
      return;
    }
    if (googleResponse.type === "error") {
      const message = (googleResponse as { error?: { message?: string } | null }).error?.message;
      Alert.alert(
        "Couldn't link",
        message ?? "Google sign-in didn't complete. Please try again.",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleResponse]);

  async function handlePress() {
    try {
      await promptGoogle();
    } catch {
      Alert.alert("Couldn't link", "Could not open the Google sign-in sheet.");
    }
  }

  return (
    <TouchableOpacity
      style={[styles.googleLinkBtn, linking !== null && styles.btnDisabled]}
      onPress={handlePress}
      disabled={linking !== null}
      testID="link-google-button"
    >
      {linking === "google" ? (
        <LoadingSpinner color="#000" />
      ) : (
        <>
          <Image
            source={{ uri: "https://developers.google.com/identity/images/g-logo.png" }}
            style={styles.googleLinkLogo}
          />
          <Text style={styles.googleLinkText}>Link Google</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

function ToggleRow({ label, description, value, onChange, disabled, testID }: { label: string; description: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; testID?: string }) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.muted}>{description}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} testID={testID} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0a1a0f", padding: 24 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" },
  headerTitle: { color: "#fff", fontSize: 17, fontWeight: "600" },
  card: { backgroundColor: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)", borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 14 },
  h2: { color: "#fff", fontSize: 16, fontWeight: "600", marginBottom: 8 },
  muted: { color: "#9ca3af", fontSize: 12, lineHeight: 16 },
  warn: { color: "#fbbf24", fontSize: 12, marginTop: 8 },
  label: { color: "#d1d5db", fontSize: 12, fontWeight: "500", marginBottom: 6 },
  inputRow: { flexDirection: "row", alignItems: "center", marginTop: 10, marginBottom: 10 },
  atSign: { color: "#9ca3af", fontSize: 16, paddingRight: 8 },
  input: { flex: 1, color: "#fff", backgroundColor: "rgba(0,0,0,0.4)", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  primaryBtn: { backgroundColor: "#10b981", paddingVertical: 11, borderRadius: 8, alignItems: "center", justifyContent: "center", flexDirection: "row", marginTop: 8 },
  primaryBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  secondaryBtn: { borderWidth: 1, borderColor: "#10b981", paddingVertical: 11, borderRadius: 8, alignItems: "center", justifyContent: "center", flexDirection: "row", marginTop: 8 },
  secondaryBtnText: { color: "#10b981", fontWeight: "600", fontSize: 14 },
  btnDisabled: { opacity: 0.5 },
  shareRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  shareBtn: { flex: 1, marginTop: 0 },
  statsBox: { marginTop: 12, padding: 10, borderRadius: 8, backgroundColor: "rgba(16,185,129,0.08)", borderWidth: 1, borderColor: "rgba(16,185,129,0.2)" },
  statsTotal: { color: "#d1fae5", fontSize: 13, fontWeight: "600" },
  statsBreakdown: { color: "#9ca3af", fontSize: 11, marginTop: 4 },
  sourceRow: { marginTop: 8 },
  sourceLabel: { color: "#d1d5db", fontSize: 11, marginBottom: 4 },
  sourceChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  sourceChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  sourceChipWeb: { backgroundColor: "rgba(59,130,246,0.15)", borderColor: "rgba(59,130,246,0.4)" },
  sourceChipMobile: { backgroundColor: "rgba(16,185,129,0.18)", borderColor: "rgba(16,185,129,0.4)" },
  sourceChipTextWeb: { color: "#93c5fd", fontSize: 11, fontWeight: "600" },
  sourceChipTextMobile: { color: "#6ee7b7", fontSize: 11, fontWeight: "600" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: "#0f2418", borderColor: "rgba(255,255,255,0.12)", borderWidth: 1, borderRadius: 16, padding: 20, width: "100%", maxWidth: 340, alignItems: "stretch" },
  modalTitle: { color: "#fff", fontSize: 17, fontWeight: "600", textAlign: "center", marginBottom: 4 },
  qrWrap: { backgroundColor: "#fff", padding: 16, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  link: { color: "#34d399", fontSize: 13, textDecorationLine: "underline" },
  toggleRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(255,255,255,0.08)" },
  toggleLabel: { color: "#fff", fontSize: 14, fontWeight: "500", marginBottom: 2 },
  scRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(255,255,255,0.08)" },
  scTitle: { color: "#fff", fontSize: 14, fontWeight: "500", marginBottom: 2 },
  linkSection: { marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.08)" },
  googleLinkBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: "#fff", borderRadius: 8, paddingVertical: 12, marginBottom: 10 },
  googleLinkText: { color: "#1f1f1f", fontSize: 14, fontWeight: "600" },
  googleLinkLogo: { width: 16, height: 16 },
  appleLinkBtn: { width: "100%", height: 44 },
});
