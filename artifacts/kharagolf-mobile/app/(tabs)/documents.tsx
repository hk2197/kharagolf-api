import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Linking,
  Platform,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { useTheme } from "@/theme";
import { useAuth } from "@/context/auth";

const BASE_URL =
  Platform.OS === "web"
    ? window.location.origin
    : process.env.EXPO_PUBLIC_API_URL ?? "https://kharagolf.replit.app";

function apiFetch(path: string, opts?: RequestInit) {
  return fetch(`${BASE_URL}/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  }).then(async (r) => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    return r.json();
  });
}

const CATEGORY_LABELS: Record<string, string> = {
  local_rules: "Local Rules",
  pace_of_play: "Pace of Play",
  policy: "Policy",
  general: "General",
  results: "Results",
  notice: "Notice",
};

interface Doc {
  id: number;
  title: string;
  category: string;
  visibility: string;
  filename: string | null;
  fileSize: number | null;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentsScreen() {
  const { user } = useAuth();
  const { tokens } = useTheme();
  const orgId = user?.organizationId;

  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wave 0 / Task #935 W0-4 — category palette is now sourced from theme
  // tokens (no hard-coded hex). Per-club override of the accent color is
  // automatic via `applyOrgOverrides`.
  const CATEGORY_COLORS: Record<string, string> = useMemo(() => ({
    local_rules: tokens.colors.categoryRules,
    pace_of_play: tokens.colors.categoryPace,
    policy: tokens.colors.categoryPolicy,
    general: tokens.colors.categoryGeneral,
    results: tokens.colors.categoryResults,
    notice: tokens.colors.categoryNotice,
  }), [tokens]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: tokens.colors.background },
    center: { flex: 1, justifyContent: "center", alignItems: "center", padding: tokens.spacing.xl },
    header: {
      paddingHorizontal: 20,
      paddingTop: 60,
      paddingBottom: tokens.spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: tokens.colors.border,
      backgroundColor: tokens.colors.surface,
    },
    headerTitle: { fontSize: 22, fontWeight: "700", color: tokens.colors.text, fontFamily: "PlayfairDisplay_700Bold" },
    headerSub: { fontSize: 13, color: tokens.colors.textSecondary, marginTop: 2 },
    scrollContent: { padding: tokens.spacing.lg, gap: 20 },
    section: { gap: tokens.spacing.sm },
    sectionHeader: {
      flexDirection: "row", alignItems: "center", gap: tokens.spacing.sm, paddingHorizontal: 4, marginBottom: 4,
    },
    categoryDot: { width: 8, height: 8, borderRadius: 4 },
    sectionTitle: { flex: 1, fontSize: 12, fontWeight: "600", color: tokens.colors.textSecondary, textTransform: "uppercase", letterSpacing: 1 },
    sectionCount: { fontSize: 12, color: tokens.colors.textSecondary },
    docCard: {
      flexDirection: "row", alignItems: "center", gap: tokens.spacing.md,
      backgroundColor: tokens.colors.surface, borderRadius: tokens.radius.lg,
      padding: 14, borderWidth: 1, borderColor: tokens.colors.border,
    },
    docIconWrap: {
      width: 40, height: 40, borderRadius: tokens.radius.md, backgroundColor: tokens.colors.cardHighlight,
      justifyContent: "center", alignItems: "center",
    },
    docInfo: { flex: 1 },
    docTitle: { fontSize: 14, fontWeight: "600", color: tokens.colors.text },
    docMeta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginTop: 2 },
    docFilename: { fontSize: 11, color: tokens.colors.textSecondary },
    docSize: { fontSize: 11, color: tokens.colors.textSecondary },
    membersBadge: {
      flexDirection: "row", alignItems: "center", gap: 3,
      backgroundColor: `${tokens.colors.warning}26`, borderRadius: tokens.radius.sm,
      paddingHorizontal: 6, paddingVertical: 2, marginLeft: 6,
    },
    membersBadgeText: { fontSize: 10, color: tokens.colors.warning, fontWeight: "600" },
    emptyTitle: { fontSize: 16, fontWeight: "600", color: tokens.colors.textSecondary, marginTop: 12, textAlign: "center" },
    emptySub: { fontSize: 13, color: tokens.colors.textSecondary, marginTop: 4, textAlign: "center" },
    retryBtn: { marginTop: tokens.spacing.lg, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: tokens.colors.primary, borderRadius: tokens.radius.md },
    retryText: { color: tokens.colors.background, fontWeight: "600" },
  }), [tokens]);

  const load = useCallback(async () => {
    if (!orgId) { setLoading(false); return; }
    try {
      const data = await apiFetch(`/organizations/${orgId}/documents`);
      setDocs(data);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Failed to load documents");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(); };

  const handleDownload = (doc: Doc) => {
    if (!orgId) return;
    const url = `${BASE_URL}/api/organizations/${orgId}/documents/${doc.id}/download`;
    Linking.openURL(url).catch(() => {});
  };

  const grouped: Record<string, Doc[]> = {};
  for (const doc of docs) {
    const cat = doc.category ?? "general";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(doc);
  }

  if (!orgId) {
    return (
      <View style={styles.center}>
        <Feather name="file-text" size={48} color={tokens.colors.textSecondary} />
        <Text style={styles.emptyTitle}>Sign in to view documents</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Document Library</Text>
        <Text style={styles.headerSub}>Club documents, rules & notices</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <LoadingSpinner color={tokens.colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Feather name="alert-circle" size={40} color={tokens.colors.error} />
          <Text style={[styles.emptyTitle, { color: tokens.colors.error }]}>{error}</Text>
          <TouchableOpacity onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : docs.length === 0 ? (
        <View style={styles.center}>
          <Feather name="file-text" size={48} color={tokens.colors.textSecondary} style={{ opacity: 0.4 }} />
          <Text style={styles.emptyTitle}>No documents yet</Text>
          <Text style={styles.emptySub}>Club documents will appear here once uploaded.</Text>
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={tokens.colors.primary} />}
          contentContainerStyle={styles.scrollContent}
        >
          {Object.entries(grouped).map(([cat, catDocs]) => (
            <View key={cat} style={styles.section}>
              <View style={styles.sectionHeader}>
                <View style={[styles.categoryDot, { backgroundColor: CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.general }]} />
                <Text style={styles.sectionTitle}>{CATEGORY_LABELS[cat] ?? cat}</Text>
                <Text style={styles.sectionCount}>{catDocs.length}</Text>
              </View>
              {catDocs.map(doc => (
                <TouchableOpacity key={doc.id} style={styles.docCard} onPress={() => handleDownload(doc)} activeOpacity={0.7}>
                  <View style={styles.docIconWrap}>
                    <Feather name="file-text" size={20} color={CATEGORY_COLORS[doc.category] ?? CATEGORY_COLORS.general} />
                  </View>
                  <View style={styles.docInfo}>
                    <Text style={styles.docTitle}>{doc.title}</Text>
                    <View style={styles.docMeta}>
                      {doc.filename && <Text style={styles.docFilename}>{doc.filename}</Text>}
                      {doc.fileSize && <Text style={styles.docSize}> · {formatBytes(doc.fileSize)}</Text>}
                      {doc.visibility === "members_only" && (
                        <View style={styles.membersBadge}>
                          <Feather name="lock" size={10} color={tokens.colors.warning} />
                          <Text style={styles.membersBadgeText}>Members</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <Feather name="download" size={16} color={tokens.colors.textSecondary} />
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
