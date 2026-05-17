import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Linking, Modal, TextInput, Alert } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { authedFetch, useActingMemberId, actingQs, BASE_URL } from "./_shared";

interface MemberDocument {
  id: number; documentType: string; title: string; fileUrl: string;
  expiresAt: string | null; isVerified: boolean; createdAt: string;
  isRejected?: boolean;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
}

const DOC_TYPES: { value: string; label: string }[] = [
  { value: "id_proof", label: "ID Proof" },
  { value: "address_proof", label: "Address Proof" },
  { value: "photo", label: "Photo" },
  { value: "medical", label: "Medical" },
  { value: "other", label: "Other" },
];

export default function DocumentsScreen() {
  const { token } = useAuth();
  const [acting] = useActingMemberId();
  const [docs, setDocs] = useState<MemberDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [docType, setDocType] = useState<string>("id_proof");
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<{ uri: string; mimeType: string; name: string; size?: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [replacingId, setReplacingId] = useState<number | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});

  function toggleHistory(type: string) {
    setExpandedHistory(prev => ({ ...prev, [type]: !prev[type] }));
  }

  function typeLabel(value: string): string {
    return DOC_TYPES.find(t => t.value === value)?.label ?? value.replace(/_/g, " ").toUpperCase();
  }

  const refresh = useCallback(() => {
    if (!token) return;
    setLoading(true);
    authedFetch<MemberDocument[]>(`/api/portal/my-documents${actingQs({ actingMemberId: acting })}`, token)
      .then(setDocs).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [token, acting]);

  useEffect(() => { refresh(); }, [refresh]);

  function resetForm() {
    setDocType("id_proof"); setTitle(""); setPicked(null); setReplacingId(null);
  }

  function openReplace(doc: MemberDocument) {
    setReplacingId(doc.id);
    setDocType(doc.documentType);
    setTitle(doc.title);
    setPicked(null);
    setModalOpen(true);
  }

  // Re-upload after rejection: keep the rejected row for audit and create a
  // brand-new pending document of the same type, pre-filled with the title.
  function openReuploadFromRejected(doc: MemberDocument) {
    setReplacingId(null);
    setDocType(doc.documentType);
    setTitle(doc.title);
    setPicked(null);
    setModalOpen(true);
  }

  async function handlePickPhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert("Permission needed", "Please allow photo library access."); return; }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85, allowsEditing: false,
    });
    if (!res.canceled && res.assets?.[0]) {
      const a = res.assets[0];
      setPicked({ uri: a.uri, mimeType: a.mimeType ?? "image/jpeg", name: a.fileName ?? `photo-${Date.now()}.jpg`, size: a.fileSize });
    }
  }

  async function handleTakePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert("Permission needed", "Please allow camera access."); return; }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85,
    });
    if (!res.canceled && res.assets?.[0]) {
      const a = res.assets[0];
      setPicked({ uri: a.uri, mimeType: a.mimeType ?? "image/jpeg", name: a.fileName ?? `photo-${Date.now()}.jpg`, size: a.fileSize });
    }
  }

  async function handlePickFile() {
    const res = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/png", "image/jpeg", "image/webp"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    const allowed = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
    const mime = a.mimeType && allowed.includes(a.mimeType) ? a.mimeType : null;
    if (!mime) { Alert.alert("Unsupported file", "Please choose a PDF, PNG, JPEG or WebP file."); return; }
    setPicked({ uri: a.uri, mimeType: mime, name: a.name ?? `file-${Date.now()}`, size: a.size ?? undefined });
  }

  async function handleDelete(doc: MemberDocument) {
    if (!token) return;
    if (doc.isVerified) return;
    Alert.alert(
      "Delete document?",
      `Remove "${doc.title}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const res = await fetch(`${BASE_URL}/api/portal/my-documents/${doc.id}${actingQs({ actingMemberId: acting })}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!res.ok && res.status !== 204) throw new Error(await res.text() || "Delete failed");
              refresh();
            } catch (e) {
              Alert.alert("Delete failed", (e as Error).message || "Please try again.");
            }
          },
        },
      ],
    );
  }

  async function handleUpload() {
    if (!token || !picked) return;
    if (!title.trim()) { Alert.alert("Missing title", "Please enter a document title."); return; }
    setUploading(true);
    try {
      const mime = picked.mimeType;
      const acq = actingQs({ actingMemberId: acting });
      const urlRes = await fetch(`${BASE_URL}/api/portal/my-documents/upload-url${acq}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: mime, documentType: docType, actingMemberId: acting }),
      });
      if (!urlRes.ok) throw new Error(await urlRes.text() || "Failed to get upload URL");
      const { uploadUrl, publicUrl } = await urlRes.json();

      const blob: Blob = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onload = () => resolve(xhr.response as Blob);
        xhr.onerror = () => reject(new Error("Failed to read file"));
        xhr.responseType = "blob";
        xhr.open("GET", picked.uri, true);
        xhr.send(null);
      });

      const putRes = await fetch(uploadUrl, {
        method: "PUT", headers: { "Content-Type": mime }, body: blob,
      });
      if (!putRes.ok) throw new Error("Failed to upload to storage");

      const isReplace = replacingId != null;
      const saveUrl = isReplace
        ? `${BASE_URL}/api/portal/my-documents/${replacingId}${acq}`
        : `${BASE_URL}/api/portal/my-documents${acq}`;
      const saveBody: Record<string, unknown> = {
        title: title.trim(),
        fileUrl: publicUrl,
        mimeType: mime,
        fileSize: blob.size,
        actingMemberId: acting,
      };
      if (!isReplace) saveBody.documentType = docType;
      const saveRes = await fetch(saveUrl, {
        method: isReplace ? "PUT" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(saveBody),
      });
      if (!saveRes.ok) throw new Error(await saveRes.text() || "Failed to save document");

      setModalOpen(false);
      resetForm();
      refresh();
      Alert.alert(
        isReplace ? "Replaced" : "Uploaded",
        isReplace
          ? "Your document was replaced and is awaiting club review."
          : "Your document was uploaded and is awaiting club review.",
      );
    } catch (e) {
      Alert.alert("Upload failed", (e as Error).message || "Please try again.");
    } finally {
      setUploading(false);
    }
  }

  if (loading) return <View style={styles.center}><LoadingSpinner color={Colors.primary} /></View>;
  if (error) return <View style={styles.center}><Text style={styles.errorText}>{error}</Text></View>;

  // Group rejected uploads of the same type into a collapsible "Past rejections"
  // section anchored to the active (non-rejected) document of that type. If a
  // type has no active doc, the most recent rejection remains the primary card
  // (so the member can still re-upload), and any older rejections collapse.
  type RenderItem =
    | { kind: "doc"; doc: MemberDocument }
    | { kind: "history"; documentType: string; items: MemberDocument[] };

  const byType = new Map<string, MemberDocument[]>();
  for (const d of docs) {
    const list = byType.get(d.documentType) ?? [];
    list.push(d);
    byType.set(d.documentType, list);
  }
  const primaryDocs: MemberDocument[] = [];
  const historyByType = new Map<string, MemberDocument[]>();
  for (const [type, list] of byType.entries()) {
    const sorted = [...list].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const active = sorted.filter(x => !x.isRejected);
    const rejected = sorted.filter(x => x.isRejected);
    if (active.length) {
      primaryDocs.push(...active);
      if (rejected.length) historyByType.set(type, rejected);
    } else if (rejected.length) {
      primaryDocs.push(rejected[0]);
      if (rejected.length > 1) historyByType.set(type, rejected.slice(1));
    }
  }
  primaryDocs.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const lastPrimaryIndexByType = new Map<string, number>();
  primaryDocs.forEach((d, i) => lastPrimaryIndexByType.set(d.documentType, i));
  const renderItems: RenderItem[] = [];
  primaryDocs.forEach((d, i) => {
    renderItems.push({ kind: "doc", doc: d });
    if (
      lastPrimaryIndexByType.get(d.documentType) === i &&
      historyByType.has(d.documentType)
    ) {
      renderItems.push({
        kind: "history",
        documentType: d.documentType,
        items: historyByType.get(d.documentType)!,
      });
    }
  });

  return (
    <View style={{ flex: 1, backgroundColor: Colors.background }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
        {docs.length === 0 ? (
          <View style={styles.empty}>
            <Feather name="file-text" size={32} color={Colors.tabIconDefault} />
            <Text style={styles.emptyText}>No documents on file yet.</Text>
            <Text style={styles.emptySub}>Upload your KYC documents below or your club will add them for you.</Text>
          </View>
        ) : renderItems.map(item => {
          if (item.kind === "history") {
            const expanded = !!expandedHistory[item.documentType];
            return (
              <View key={`hist-${item.documentType}`} style={styles.historyWrap}>
                <TouchableOpacity
                  style={styles.historyHeader}
                  onPress={() => toggleHistory(item.documentType)}
                  activeOpacity={0.7}
                >
                  <Feather name="archive" size={12} color={Colors.tabIconDefault} />
                  <Text style={styles.historyHeaderText}>
                    Past rejections · {typeLabel(item.documentType)} ({item.items.length})
                  </Text>
                  <Feather
                    name={expanded ? "chevron-up" : "chevron-down"}
                    size={14}
                    color={Colors.tabIconDefault}
                  />
                </TouchableOpacity>
                {expanded && item.items.map(h => (
                  <TouchableOpacity
                    key={h.id}
                    style={styles.historyItem}
                    activeOpacity={0.75}
                    onPress={() => Linking.openURL(h.fileUrl).catch(() => {})}
                  >
                    <View style={styles.historyItemHeader}>
                      <Feather name="x-circle" size={11} color="#f87171" />
                      <Text style={styles.historyItemTitle} numberOfLines={1}>{h.title}</Text>
                      <Text style={styles.historyItemDate}>
                        {h.rejectedAt
                          ? new Date(h.rejectedAt).toLocaleDateString()
                          : new Date(h.createdAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <Text style={styles.historyItemReason}>
                      {h.rejectionReason || "No reason provided."}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            );
          }
          const d = item.doc;
          const expired = d.expiresAt && new Date(d.expiresAt).getTime() < Date.now();
          const rejected = !!d.isRejected;
          return (
            <View key={d.id} style={styles.card}>
              <TouchableOpacity activeOpacity={0.75}
                onPress={() => Linking.openURL(d.fileUrl).catch(() => {})}>
                <View style={styles.cardHeader}>
                  <Feather name="file" size={18} color={Colors.primary} />
                  <Text style={styles.cardTitle}>{d.title}</Text>
                  {d.isVerified ? (
                    <View style={styles.verifiedBadge}><Feather name="check" size={10} color="#22c55e" /><Text style={styles.verifiedText}>Verified</Text></View>
                  ) : rejected ? (
                    <View style={styles.rejectedBadge}><Feather name="x-circle" size={10} color="#f87171" /><Text style={styles.rejectedText}>Rejected</Text></View>
                  ) : (
                    <View style={styles.pendingBadge}><Feather name="clock" size={10} color="#f59e0b" /><Text style={styles.pendingText}>Pending</Text></View>
                  )}
                </View>
                <Text style={styles.cardMeta}>{d.documentType.replace(/_/g, " ").toUpperCase()}</Text>
                <Text style={styles.cardMeta}>Uploaded {new Date(d.createdAt).toLocaleDateString()}</Text>
                {d.expiresAt && (
                  <Text style={[styles.cardMeta, expired ? { color: "#f87171" } : null]}>
                    {expired ? "Expired" : "Expires"} {new Date(d.expiresAt).toLocaleDateString()}
                  </Text>
                )}
                {rejected && (
                  <View style={styles.rejectionBox}>
                    <View style={styles.rejectionHeader}>
                      <Feather name="alert-circle" size={12} color="#f87171" />
                      <Text style={styles.rejectionHeaderText}>
                        Rejected by club{d.rejectedAt ? ` on ${new Date(d.rejectedAt).toLocaleDateString()}` : ""}
                      </Text>
                    </View>
                    {d.rejectionReason ? (
                      <Text style={styles.rejectionReason}>{d.rejectionReason}</Text>
                    ) : (
                      <Text style={styles.rejectionReason}>No reason provided. Please contact your club.</Text>
                    )}
                  </View>
                )}
              </TouchableOpacity>
              {rejected ? (
                <TouchableOpacity style={styles.replaceBtn} onPress={() => openReuploadFromRejected(d)} activeOpacity={0.75}>
                  <Feather name="upload" size={12} color={Colors.primary} />
                  <Text style={styles.replaceBtnText}>Re-upload</Text>
                </TouchableOpacity>
              ) : !d.isVerified ? (
                <TouchableOpacity style={styles.replaceBtn} onPress={() => openReplace(d)} activeOpacity={0.75}>
                  <Feather name="refresh-cw" size={12} color={Colors.primary} />
                  <Text style={styles.replaceBtnText}>Replace file</Text>
                </TouchableOpacity>
              ) : null}
              {!d.isVerified && !rejected && (
                <TouchableOpacity
                  style={styles.deleteBtn}
                  onPress={(e) => { e.stopPropagation?.(); handleDelete(d); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Feather name="trash-2" size={12} color="#f87171" />
                  <Text style={styles.deleteBtnText}>Delete</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}
      </ScrollView>

      <TouchableOpacity style={styles.fab} onPress={() => setModalOpen(true)} activeOpacity={0.85}>
        <Feather name="upload" size={18} color="#0b0b0b" />
        <Text style={styles.fabText}>Upload Document</Text>
      </TouchableOpacity>

      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={() => !uploading && setModalOpen(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{replacingId != null ? "Replace Document" : "Upload Document"}</Text>
              <TouchableOpacity disabled={uploading} onPress={() => { setModalOpen(false); resetForm(); }}>
                <Feather name="x" size={20} color="#fff" />
              </TouchableOpacity>
            </View>

            <Text style={styles.fieldLabel}>Document Type</Text>
            <View style={styles.typeRow}>
              {DOC_TYPES.map(t => (
                <TouchableOpacity key={t.value} onPress={() => setDocType(t.value)}
                  style={[styles.typeChip, docType === t.value && styles.typeChipActive]}>
                  <Text style={[styles.typeChipText, docType === t.value && styles.typeChipTextActive]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Aadhaar card front"
              placeholderTextColor={Colors.tabIconDefault}
              value={title}
              onChangeText={setTitle}
              maxLength={200}
              editable={!uploading}
            />

            <Text style={styles.fieldLabel}>File</Text>
            {picked ? (
              <View style={styles.pickedRow}>
                <Feather name={picked.mimeType === "application/pdf" ? "file" : "image"} size={16} color={Colors.primary} />
                <Text style={styles.pickedText} numberOfLines={1}>{picked.name}</Text>
                <TouchableOpacity onPress={() => setPicked(null)} disabled={uploading}>
                  <Feather name="x" size={16} color={Colors.tabIconDefault} />
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.pickRow}>
                <TouchableOpacity style={styles.pickBtn} onPress={handlePickPhoto} disabled={uploading}>
                  <Feather name="image" size={14} color="#fff" />
                  <Text style={styles.pickBtnText}>Photo</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.pickBtn} onPress={handleTakePhoto} disabled={uploading}>
                  <Feather name="camera" size={14} color="#fff" />
                  <Text style={styles.pickBtnText}>Camera</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.pickBtn} onPress={handlePickFile} disabled={uploading}>
                  <Feather name="file" size={14} color="#fff" />
                  <Text style={styles.pickBtnText}>File</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity
              style={[styles.submitBtn, (!picked || !title.trim() || uploading) && styles.submitBtnDisabled]}
              onPress={handleUpload}
              disabled={!picked || !title.trim() || uploading}
            >
              {uploading
                ? <LoadingSpinner color="#0b0b0b" />
                : <Text style={styles.submitBtnText}>{replacingId != null ? "Replace" : "Upload"}</Text>}
            </TouchableOpacity>
            <Text style={styles.modalNote}>Uploaded documents are marked unverified until your club reviews them.</Text>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  errorText: { color: "#f87171", padding: 16, textAlign: "center" },
  empty: { alignItems: "center", padding: 40, gap: 8 },
  emptyText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  emptySub: { color: Colors.tabIconDefault, fontSize: 12, textAlign: "center" },
  card: { backgroundColor: Colors.surface, borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: Colors.border },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  cardTitle: { color: "#fff", fontSize: 14, fontWeight: "700", flex: 1 },
  cardMeta: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 },
  verifiedBadge: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "#16653433", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  verifiedText: { color: "#22c55e", fontSize: 10, fontWeight: "700" },
  pendingBadge: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "#78350f55", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  pendingText: { color: "#f59e0b", fontSize: 10, fontWeight: "700" },
  rejectedBadge: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "#7f1d1d55", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  rejectedText: { color: "#f87171", fontSize: 10, fontWeight: "700" },
  rejectionBox: { marginTop: 10, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: "#7f1d1d", backgroundColor: "#7f1d1d22" },
  rejectionHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  rejectionHeaderText: { color: "#f87171", fontSize: 11, fontWeight: "700" },
  rejectionReason: { color: "#fecaca", fontSize: 12, lineHeight: 16 },
  deleteBtn: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", marginTop: 8, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: "#7f1d1d" },
  deleteBtnText: { color: "#f87171", fontSize: 11, fontWeight: "600" },
  replaceBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: Colors.primary, backgroundColor: "transparent" },
  replaceBtnText: { color: Colors.primary, fontSize: 12, fontWeight: "700" },
  fab: { position: "absolute", right: 16, bottom: 24, backgroundColor: Colors.primary, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 999, flexDirection: "row", alignItems: "center", gap: 8, elevation: 4 },
  fabText: { color: "#0b0b0b", fontWeight: "700", fontSize: 13 },
  modalBg: { flex: 1, backgroundColor: "#000a", justifyContent: "flex-end" },
  modalCard: { backgroundColor: Colors.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 10 },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  modalTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  fieldLabel: { color: Colors.tabIconDefault, fontSize: 11, fontWeight: "600", marginTop: 6 },
  typeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  typeChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border },
  typeChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  typeChipText: { color: "#fff", fontSize: 12 },
  typeChipTextActive: { color: "#0b0b0b", fontWeight: "700" },
  input: { backgroundColor: Colors.background, color: "#fff", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10, borderWidth: 1, borderColor: Colors.border, fontSize: 13 },
  pickRow: { flexDirection: "row", gap: 8 },
  pickBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, paddingVertical: 10 },
  pickBtnText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  pickedRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: Colors.background, borderRadius: 8, padding: 10, borderWidth: 1, borderColor: Colors.border },
  pickedText: { color: "#fff", fontSize: 12, flex: 1 },
  submitBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 6 },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { color: "#0b0b0b", fontWeight: "700", fontSize: 14 },
  modalNote: { color: Colors.tabIconDefault, fontSize: 11, textAlign: "center", marginTop: 4 },
  historyWrap: { marginBottom: 10, marginTop: -4, marginLeft: 12, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: Colors.border },
  historyHeader: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8 },
  historyHeaderText: { color: Colors.tabIconDefault, fontSize: 11, fontWeight: "600", flex: 1 },
  historyItem: { backgroundColor: Colors.surface, borderRadius: 8, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: Colors.border, opacity: 0.85 },
  historyItemHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  historyItemTitle: { color: "#fff", fontSize: 12, fontWeight: "600", flex: 1 },
  historyItemDate: { color: Colors.tabIconDefault, fontSize: 10 },
  historyItemReason: { color: "#fecaca", fontSize: 11, lineHeight: 15 },
});
