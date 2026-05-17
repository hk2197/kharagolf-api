import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack, router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { formatRelativeTime } from "@/i18n/relativeTime";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

const API = (path: string) => `${BASE_URL}/api${path}`;

interface CaptionTemplate {
  id: number;
  pattern: string;
  tokenKeys: string[];
  sampleCaption: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Defer to the shared `formatRelativeTime` helper (Task #1659) so the
// "Last used X ago" label on this admin screen renders translated copy
// in every supported locale instead of the previous English-only
// "Xm ago"/"Xh ago"/"Xd ago" fragments. Null timestamps still show
// "never" for templates that have never been used.
const formatRelative = (iso: string | null): string =>
  iso ? formatRelativeTime(iso) : "never";

export default function HighlightCaptionStylesScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const auth: Record<string, string> = useMemo(
    () => {
      const h: Record<string, string> = {};
      if (token) h.Authorization = `Bearer ${token}`;
      return h;
    },
    [token],
  );

  const [templates, setTemplates] = useState<CaptionTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [editing, setEditing] = useState<CaptionTemplate | null>(null);
  const [draftPattern, setDraftPattern] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const r = await fetch(API("/portal/highlights/caption-templates"), { headers: auth });
      if (r.ok) {
        const d = await r.json();
        setTemplates(Array.isArray(d.templates) ? d.templates : []);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [auth]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const onRefresh = () => { setRefreshing(true); fetchAll(); };

  const openEditor = (tpl: CaptionTemplate) => {
    setEditing(tpl);
    setDraftPattern(tpl.pattern);
  };

  const closeEditor = () => {
    setEditing(null);
    setDraftPattern("");
  };

  const saveEdit = async () => {
    if (!editing) return;
    const next = draftPattern.trim();
    if (!next) {
      Alert.alert("Pattern can't be empty", "Add some wording before saving.");
      return;
    }
    if (next === editing.pattern) {
      closeEditor();
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(API(`/portal/highlights/caption-templates/${editing.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ pattern: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        Alert.alert("Couldn't save", d.error || "Please try again.");
        return;
      }
      const updated = d.template as CaptionTemplate;
      setTemplates(prev => prev.map(t => (t.id === updated.id ? updated : t)));
      closeEditor();
    } finally {
      setSaving(false);
    }
  };

  const deleteOne = (tpl: CaptionTemplate) => {
    Alert.alert(
      "Delete caption style?",
      `"${tpl.pattern}" will no longer appear in your suggestions.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            const prev = templates;
            setTemplates(p => p.filter(t => t.id !== tpl.id));
            const r = await fetch(API(`/portal/highlights/caption-templates/${tpl.id}`), {
              method: "DELETE",
              headers: auth,
            });
            if (!r.ok) {
              setTemplates(prev);
              Alert.alert("Couldn't delete", "Please try again.");
            }
          },
        },
      ],
    );
  };

  const deleteAll = () => {
    if (templates.length === 0) return;
    Alert.alert(
      "Remove all caption styles?",
      `This will delete all ${templates.length} saved styles. You can re-favorite chips later from the editor.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete all",
          style: "destructive",
          onPress: async () => {
            const prev = templates;
            setTemplates([]);
            const results = await Promise.allSettled(prev.map(t =>
              fetch(API(`/portal/highlights/caption-templates/${t.id}`), {
                method: "DELETE",
                headers: auth,
              }),
            ));
            // If any failed, refetch to reconcile state with the server.
            if (results.some(r => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok))) {
              fetchAll();
              Alert.alert("Some styles couldn't be removed", "We refreshed the list so it matches the server.");
            }
          },
        },
      ],
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Feather name="arrow-left" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Caption Styles</Text>
        <TouchableOpacity
          onPress={deleteAll}
          style={styles.iconBtn}
          disabled={templates.length === 0}
          accessibilityLabel="Delete all caption styles"
        >
          <Feather
            name="trash-2"
            size={20}
            color={templates.length === 0 ? Colors.tabIconDefault : "#f87171"}
          />
        </TouchableOpacity>
      </View>

      {loading ? (
        <LoadingSpinner color={Colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={templates}
          keyExtractor={t => String(t.id)}
          contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />}
          ListHeaderComponent={
            <Text style={styles.intro}>
              Favorite caption styles you saved from the highlight editor live here.
              Tap a style to rename it, or remove ones you no longer use. Use{" "}
              <Text style={styles.token}>{"{hole}"}</Text>,{" "}
              <Text style={styles.token}>{"{club}"}</Text>,{" "}
              <Text style={styles.token}>{"{carry}"}</Text>,{" "}
              <Text style={styles.token}>{"{par}"}</Text> or{" "}
              <Text style={styles.token}>{"{scoreLabel}"}</Text> as placeholders.
            </Text>
          }
          ListEmptyComponent={
            <View style={{ alignItems: "center", marginTop: 60 }}>
              <Feather name="bookmark" size={48} color={Colors.tabIconDefault} />
              <Text style={styles.emptyTitle}>No saved styles yet</Text>
              <Text style={styles.emptyMeta}>
                Tap the star on a suggested caption chip while editing a reel to save it here.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => openEditor(item)} style={styles.card}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
                <Feather name="bookmark" size={18} color="#facc15" style={{ marginTop: 2 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.pattern} numberOfLines={2}>{item.pattern}</Text>
                  <Text style={styles.sample} numberOfLines={2}>
                    e.g. {item.sampleCaption}
                  </Text>
                  <Text style={styles.meta}>
                    Used {item.useCount} {item.useCount === 1 ? "time" : "times"} · Last used {formatRelative(item.lastUsedAt)}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", gap: 4 }}>
                  <TouchableOpacity
                    onPress={() => openEditor(item)}
                    style={styles.rowBtn}
                    accessibilityLabel="Rename caption style"
                  >
                    <Feather name="edit-2" size={16} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => deleteOne(item)}
                    style={[styles.rowBtn, { backgroundColor: "#3a1a1a" }]}
                    accessibilityLabel="Delete caption style"
                  >
                    <Feather name="trash-2" size={16} color="#f87171" />
                  </TouchableOpacity>
                </View>
              </View>
            </Pressable>
          )}
        />
      )}

      <Modal
        visible={editing != null}
        animationType="slide"
        transparent
        onRequestClose={closeEditor}
      >
        <View style={styles.modalRoot}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Rename caption style</Text>
            <Text style={styles.helpText}>
              Use placeholders like {"{hole}"}, {"{club}"}, {"{carry}"}, {"{par}"}, {"{scoreLabel}"}
              {" "}— they'll be filled in for each shot.
            </Text>
            <TextInput
              value={draftPattern}
              onChangeText={setDraftPattern}
              style={styles.input}
              autoFocus
              maxLength={280}
              multiline
            />
            {editing && (
              <Text style={styles.preview}>
                Original sample: {editing.sampleCaption}
              </Text>
            )}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                style={[styles.primaryBtn, { flex: 1, backgroundColor: "#333" }]}
                onPress={closeEditor}
              >
                <Text style={styles.primaryBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={saving}
                style={[styles.primaryBtn, { flex: 1, opacity: saving ? 0.5 : 1 }]}
                onPress={saveEdit}
              >
                {saving
                  ? <LoadingSpinner color="#000" />
                  : <Text style={styles.primaryBtnText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: "#222",
  },
  iconBtn: { padding: 6 },
  headerTitle: { color: "#fff", fontSize: 17, fontWeight: "600", flex: 1, textAlign: "center" },
  intro: { color: Colors.tabIconDefault, fontSize: 12, lineHeight: 17, marginBottom: 14 },
  token: { color: Colors.primary, fontFamily: "monospace" },
  card: {
    backgroundColor: "#1a1a1a", borderRadius: 12, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: "#252525",
  },
  pattern: { color: "#fff", fontSize: 14, fontWeight: "600" },
  sample: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 4, fontStyle: "italic" },
  meta: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 6 },
  rowBtn: {
    width: 32, height: 32, borderRadius: 8, backgroundColor: "#252525",
    alignItems: "center", justifyContent: "center",
  },
  emptyTitle: { color: "#fff", fontSize: 16, fontWeight: "600", marginTop: 12 },
  emptyMeta: {
    color: Colors.tabIconDefault, fontSize: 13, marginTop: 6,
    textAlign: "center", paddingHorizontal: 30,
  },
  modalRoot: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#0f0f0f", borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 28,
  },
  sheetTitle: { color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 8 },
  helpText: { color: Colors.tabIconDefault, fontSize: 12, lineHeight: 16, marginBottom: 10 },
  input: {
    backgroundColor: "#1a1a1a", borderRadius: 8, color: "#fff", padding: 12, fontSize: 14,
    borderWidth: 1, borderColor: "#252525", minHeight: 70, textAlignVertical: "top",
  },
  preview: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 8, fontStyle: "italic" },
  primaryBtn: {
    backgroundColor: Colors.primary, padding: 13, borderRadius: 10, alignItems: "center",
  },
  primaryBtnText: { color: "#000", fontWeight: "600", fontSize: 14 },
});
