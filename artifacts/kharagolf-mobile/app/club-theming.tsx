import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  PanResponder,
  type GestureResponderEvent,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack, router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import { BASE_URL } from "@/utils/api";

interface Theme {
  primaryColor: string | null;
  accentColor: string | null;
  fontFamily: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
}

const EMPTY: Theme = { primaryColor: "", accentColor: "", fontFamily: "", logoUrl: "", faviconUrl: "" };

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const PALETTE = [
  "#0b3d2a", "#16a34a", "#22c55e", "#0ea5e9", "#3b82f6",
  "#6366f1", "#8b5cf6", "#a855f7", "#ec4899", "#ef4444",
  "#f97316", "#f59e0b", "#eab308", "#84cc16", "#14b8a6",
  "#0f172a", "#475569", "#94a3b8", "#e2e8f0", "#ffffff",
];

function expandHex(value: string): string | null {
  const v = (value || "").trim();
  if (!HEX_RE.test(v)) return null;
  if (v.length === 4) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  }
  return v.toLowerCase();
}
function safeHex(value: string, fallback: string): string {
  return expandHex(value) ?? fallback;
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = expandHex(hex) ?? "#000000";
  return {
    r: parseInt(v.slice(1, 3), 16),
    g: parseInt(v.slice(3, 5), 16),
    b: parseInt(v.slice(5, 7), 16),
  };
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export default function ClubThemingScreen() {
  const { token, user } = useAuth();
  const { activeOrgId } = useActiveClub();
  const orgId = activeOrgId ?? user?.organizationId ?? null;

  const [theme, setTheme] = useState<Theme>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<null | "logo" | "favicon">(null);
  const [pickerOpenFor, setPickerOpenFor] = useState<null | "primary" | "accent">(null);

  useEffect(() => {
    if (!orgId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`${BASE_URL}/api/organizations/${orgId}/theming`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ theme: Theme | null }>;
      })
      .then(d => {
        if (cancelled) return;
        const t = d.theme ?? EMPTY;
        setTheme({
          primaryColor: t.primaryColor ?? "",
          accentColor: t.accentColor ?? "",
          fontFamily: t.fontFamily ?? "",
          logoUrl: t.logoUrl ?? "",
          faviconUrl: t.faviconUrl ?? "",
        });
      })
      .catch(e => Alert.alert("Could not load theme", e instanceof Error ? e.message : "Unknown"))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orgId]);

  const save = async () => {
    if (!orgId || !token) return;
    setSaving(true);
    try {
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/theming`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          primaryColor: theme.primaryColor || null,
          accentColor: theme.accentColor || null,
          fontFamily: theme.fontFamily || null,
          logoUrl: theme.logoUrl || null,
          faviconUrl: theme.faviconUrl || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      Alert.alert("Theme saved", "Your club theme has been updated.");
    } catch (e) {
      Alert.alert("Could not save theme", e instanceof Error ? e.message : "Unknown");
    } finally {
      setSaving(false);
    }
  };

  async function pickAndUpload(kind: "logo" | "favicon") {
    if (!orgId || !token) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Please allow photo library access to upload.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.9,
      allowsEditing: kind === "favicon",
      aspect: kind === "favicon" ? [1, 1] : undefined,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const contentType = asset.mimeType ?? "image/jpeg";
    setUploadingKind(kind);
    try {
      const tokenRes = await fetch(`${BASE_URL}/api/organizations/${orgId}/theming/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ contentType, size: asset.fileSize ?? undefined }),
      });
      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({}));
        throw new Error(err?.error ?? "Could not start upload");
      }
      const { uploadURL, objectPath, uploadToken } = await tokenRes.json();

      const blob: Blob = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onload = () => resolve(xhr.response as Blob);
        xhr.onerror = () => reject(new Error("Failed to read file"));
        xhr.responseType = "blob";
        xhr.open("GET", asset.uri, true);
        xhr.send(null);
      });
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      if (!putRes.ok) throw new Error("Upload failed");

      const regRes = await fetch(`${BASE_URL}/api/organizations/${orgId}/theming/images`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ objectPath, uploadToken }),
      });
      if (!regRes.ok) {
        const err = await regRes.json().catch(() => ({}));
        throw new Error(err?.error ?? "Could not register image");
      }
      const { url } = await regRes.json();
      setTheme(t => kind === "logo" ? { ...t, logoUrl: url } : { ...t, faviconUrl: url });
    } catch (e) {
      Alert.alert("Upload failed", e instanceof Error ? e.message : "Unknown");
    } finally {
      setUploadingKind(null);
    }
  }

  if (!orgId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: Colors.background }}>
        <Stack.Screen options={{ title: "Club theming" }} />
        <View style={{ padding: 16 }}>
          <Text style={{ color: Colors.textSecondary }}>Select a club to manage theming.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const previewPrimary = safeHex(theme.primaryColor ?? "", "#0b3d2a");
  const previewAccent = safeHex(theme.accentColor ?? "", "#c9a84c");

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.background }}>
      <Stack.Screen options={{ title: "Club theming" }} />
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} testID="button-back">
          <Feather name="chevron-left" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Club theming</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        <View style={styles.card} testID="card-club-theming">
          {loading ? (
            <LoadingSpinner color={Colors.primary} />
          ) : (
            <>
              <ColorField
                label="Primary color"
                value={theme.primaryColor ?? ""}
                fallback="#0b3d2a"
                open={pickerOpenFor === "primary"}
                onToggle={() => setPickerOpenFor(p => p === "primary" ? null : "primary")}
                onChange={v => setTheme(t => ({ ...t, primaryColor: v }))}
                testID="input-primary-color"
              />
              <ColorField
                label="Accent color"
                value={theme.accentColor ?? ""}
                fallback="#c9a84c"
                open={pickerOpenFor === "accent"}
                onToggle={() => setPickerOpenFor(p => p === "accent" ? null : "accent")}
                onChange={v => setTheme(t => ({ ...t, accentColor: v }))}
                testID="input-accent-color"
              />

              <View style={{ gap: 6, marginBottom: 12 }}>
                <Text style={styles.label}>Font family</Text>
                <TextInput
                  value={theme.fontFamily ?? ""}
                  onChangeText={v => setTheme(t => ({ ...t, fontFamily: v }))}
                  placeholder="Inter, sans-serif"
                  placeholderTextColor={Colors.muted}
                  style={styles.input}
                  autoCapitalize="none"
                  testID="input-font-family"
                />
              </View>

              <ImageField
                label="Logo"
                value={theme.logoUrl ?? ""}
                onChange={v => setTheme(t => ({ ...t, logoUrl: v }))}
                onPick={() => pickAndUpload("logo")}
                uploading={uploadingKind === "logo"}
                testID="input-logo-url"
              />
              <ImageField
                label="Favicon"
                value={theme.faviconUrl ?? ""}
                onChange={v => setTheme(t => ({ ...t, faviconUrl: v }))}
                onPick={() => pickAndUpload("favicon")}
                uploading={uploadingKind === "favicon"}
                testID="input-favicon-url"
              />

              <ThemePreview
                primaryColor={previewPrimary}
                accentColor={previewAccent}
                logoUrl={theme.logoUrl ?? ""}
              />

              <TouchableOpacity onPress={save} disabled={saving} style={styles.primaryBtn} testID="button-save-theme">
                {saving ? <LoadingSpinner color="#fff" /> : <Text style={styles.primaryBtnText}>Save theme</Text>}
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ColorField({
  label, value, fallback, open, onToggle, onChange, testID,
}: {
  label: string; value: string; fallback: string;
  open: boolean; onToggle: () => void; onChange: (v: string) => void;
  testID?: string;
}) {
  const swatch = safeHex(value, fallback);
  const valid = !value || HEX_RE.test(value.trim());
  return (
    <View style={{ gap: 6, marginBottom: 12 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TouchableOpacity
          onPress={onToggle}
          style={[styles.swatch, { backgroundColor: swatch }]}
          accessibilityLabel={`Open ${label} picker`}
          testID={`${testID}-swatch`}
        />
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={fallback}
          placeholderTextColor={Colors.muted}
          style={[styles.input, { flex: 1, fontFamily: "Courier", textTransform: "uppercase" }]}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={7}
          testID={testID}
        />
        <TouchableOpacity onPress={onToggle} testID={`${testID}-toggle`}>
          <Feather name={open ? "chevron-up" : "chevron-down"} size={20} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>
      {!valid && <Text style={styles.warn}>Enter a hex color like #0b3d2a (preview uses default).</Text>}
      {open && (
        <ColorPickerPanel currentHex={swatch} onChange={onChange} testID={`${testID}-panel`} />
      )}
    </View>
  );
}

function ColorPickerPanel({
  currentHex, onChange, testID,
}: {
  currentHex: string;
  onChange: (hex: string) => void;
  testID?: string;
}) {
  const rgb = hexToRgb(currentHex);
  return (
    <View style={styles.pickerPanel} testID={testID}>
      <Text style={styles.pickerSection}>Palette</Text>
      <View style={styles.paletteGrid}>
        {PALETTE.map(c => (
          <TouchableOpacity
            key={c}
            onPress={() => onChange(c)}
            style={[
              styles.paletteSwatch,
              { backgroundColor: c },
              currentHex.toLowerCase() === c.toLowerCase() ? styles.paletteSwatchActive : null,
            ]}
            accessibilityLabel={`Pick color ${c}`}
            testID={`${testID}-swatch-${c.replace("#", "")}`}
          />
        ))}
      </View>
      <Text style={[styles.pickerSection, { marginTop: 12 }]}>Fine-tune</Text>
      <ChannelSlider label="R" value={rgb.r} color="#ef4444"
        onChange={v => onChange(rgbToHex(v, rgb.g, rgb.b))} testID={`${testID}-r`} />
      <ChannelSlider label="G" value={rgb.g} color="#22c55e"
        onChange={v => onChange(rgbToHex(rgb.r, v, rgb.b))} testID={`${testID}-g`} />
      <ChannelSlider label="B" value={rgb.b} color="#3b82f6"
        onChange={v => onChange(rgbToHex(rgb.r, rgb.g, v))} testID={`${testID}-b`} />
    </View>
  );
}

function ChannelSlider({
  label, value, color, onChange, testID,
}: {
  label: string;
  value: number;
  color: string;
  onChange: (v: number) => void;
  testID?: string;
}) {
  const trackWidth = useRef(0);
  const updateFromX = (x: number) => {
    if (trackWidth.current <= 0) return;
    const pct = Math.max(0, Math.min(1, x / trackWidth.current));
    onChange(Math.round(pct * 255));
  };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e: GestureResponderEvent) => updateFromX(e.nativeEvent.locationX),
        onPanResponderMove: (e: GestureResponderEvent) => updateFromX(e.nativeEvent.locationX),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const pct = Math.max(0, Math.min(1, value / 255));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }} testID={testID}>
      <Text style={[styles.label, { width: 14 }]}>{label}</Text>
      <View
        {...responder.panHandlers}
        onLayout={e => { trackWidth.current = e.nativeEvent.layout.width; }}
        style={[styles.sliderTrack, { backgroundColor: `${color}55` }]}
      >
        <View style={[styles.sliderFill, { width: `${pct * 100}%`, backgroundColor: color }]} />
        <View style={[styles.sliderThumb, { left: `${pct * 100}%` }]} />
      </View>
      <Text style={[styles.label, { width: 28, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

function ImageField({
  label, value, onChange, onPick, uploading, testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onPick: () => void;
  uploading: boolean;
  testID?: string;
}) {
  return (
    <View style={{ gap: 6, marginBottom: 12 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={styles.thumbBox}>
          {value ? (
            <Image source={{ uri: value }} style={styles.thumb} resizeMode="contain" />
          ) : (
            <Feather name="image" size={20} color={Colors.muted} />
          )}
        </View>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="https://… or upload"
          placeholderTextColor={Colors.muted}
          style={[styles.input, { flex: 1 }]}
          autoCapitalize="none"
          autoCorrect={false}
          testID={testID}
        />
        <TouchableOpacity
          onPress={onPick}
          disabled={uploading}
          style={styles.uploadBtn}
          accessibilityLabel={`Upload ${label.toLowerCase()}`}
          testID={`${testID}-upload`}
        >
          {uploading
            ? <LoadingSpinner color="#fff" size="small" />
            : <Feather name="upload" size={16} color="#fff" />}
        </TouchableOpacity>
        {value ? (
          <TouchableOpacity
            onPress={() => onChange("")}
            disabled={uploading}
            style={styles.removeBtn}
            accessibilityLabel={`Remove ${label.toLowerCase()}`}
            testID={`${testID}-remove`}
          >
            <Feather name="trash-2" size={16} color={Colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function ThemePreview({
  primaryColor, accentColor, logoUrl,
}: {
  primaryColor: string;
  accentColor: string;
  logoUrl: string;
}) {
  return (
    <View style={styles.previewWrap} testID="theme-preview">
      <Text style={styles.previewLabel}>Live preview</Text>
      <View style={[styles.previewBar, { backgroundColor: primaryColor }]}>
        {logoUrl ? (
          <Image source={{ uri: logoUrl }} style={styles.previewLogo} resizeMode="contain" />
        ) : (
          <View style={[styles.previewLogo, { backgroundColor: "rgba(255,255,255,0.15)" }]} />
        )}
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={styles.previewTitle}>Your club, in your colors</Text>
          <Text style={styles.previewSub}>Primary surface uses your primary color.</Text>
        </View>
        <View style={[styles.previewAction, { backgroundColor: accentColor }]}>
          <Text style={styles.previewActionText}>Action</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10, borderBottomColor: Colors.border, borderBottomWidth: 1 },
  topBarTitle: { color: "#fff", fontSize: 17, fontWeight: "700" },
  card: { backgroundColor: Colors.card, borderRadius: 14, padding: 14, borderColor: Colors.border, borderWidth: 1 },
  label: { color: Colors.textSecondary, fontSize: 12 },
  warn: { color: "#f59e0b", fontSize: 11 },
  input: { backgroundColor: Colors.surface, color: "#fff", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderColor: Colors.border, borderWidth: 1 },
  primaryBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 8 },
  primaryBtnText: { color: "#fff", fontWeight: "700" },
  swatch: { width: 40, height: 40, borderRadius: 8, borderColor: Colors.border, borderWidth: 1 },
  pickerPanel: { marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: Colors.surface, borderColor: Colors.border, borderWidth: 1 },
  pickerSection: { color: Colors.textSecondary, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  paletteGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  paletteSwatch: { width: 28, height: 28, borderRadius: 6, borderColor: "rgba(255,255,255,0.15)", borderWidth: 1 },
  paletteSwatchActive: { borderColor: "#fff", borderWidth: 2 },
  sliderTrack: { flex: 1, height: 18, borderRadius: 9, justifyContent: "center", overflow: "hidden", position: "relative" },
  sliderFill: { position: "absolute", left: 0, top: 0, bottom: 0 },
  sliderThumb: { position: "absolute", top: -2, width: 14, height: 22, marginLeft: -7, borderRadius: 4, backgroundColor: "#fff", shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 2 },
  thumbBox: { width: 44, height: 44, borderRadius: 8, backgroundColor: Colors.surface, borderColor: Colors.border, borderWidth: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  thumb: { width: "100%", height: "100%" },
  uploadBtn: { backgroundColor: Colors.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "center" },
  removeBtn: { backgroundColor: Colors.surface, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10, borderColor: Colors.border, borderWidth: 1 },
  previewWrap: { borderRadius: 10, backgroundColor: Colors.surface, borderColor: Colors.border, borderWidth: 1, padding: 10, marginTop: 4, marginBottom: 4 },
  previewLabel: { color: Colors.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 },
  previewBar: { flexDirection: "row", alignItems: "center", padding: 10, borderRadius: 8 },
  previewLogo: { width: 32, height: 32, borderRadius: 6 },
  previewTitle: { color: "#fff", fontSize: 13, fontWeight: "700" },
  previewSub: { color: "rgba(255,255,255,0.7)", fontSize: 11 },
  previewAction: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  previewActionText: { color: "#000", fontSize: 11, fontWeight: "700" },
});
