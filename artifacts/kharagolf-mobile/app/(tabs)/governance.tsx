import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Linking,
  Platform,
  Modal,
  TextInput,
  Alert,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather, Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { getLocale } from "@/i18n";

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
  constitution: "Constitution",
  handicap_policy: "Handicap Policy",
  course_rules: "Course Rules",
  committee_minutes: "Committee Minutes",
  agm_documents: "AGM Documents",
  financial_reports: "Financial Reports",
  bylaws: "By-Laws",
  other: "Other",
};

interface DocVersion {
  id: number;
  versionNumber: number;
  fileName: string;
  fileUrl: string;
  fileSizeBytes: number | null;
  changeNotes: string | null;
  createdAt: string;
}

interface ClubDoc {
  id: number;
  title: string;
  description: string | null;
  category: string;
  access: string;
  latestVersion: DocVersion | null;
  updatedAt: string;
}

interface GovernanceNotice {
  id: number;
  title: string;
  body: string;
  isPinned: boolean;
  access: string;
  expiresAt: string | null;
  isPublished: boolean;
  createdAt: string;
}

type Tab = "documents" | "notices";

function formatDate(d: string | null | undefined) {
  if (!d) return "";
  return new Date(d).toLocaleDateString(getLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function GovernanceScreen() {
  const { user } = useAuth();
  const orgId = user?.organizationId;
  const [activeTab, setActiveTab] = useState<Tab>("documents");
  const [docs, setDocs] = useState<ClubDoc[]>([]);
  const [notices, setNotices] = useState<GovernanceNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedDoc, setSelectedDoc] = useState<ClubDoc | null>(null);
  const [selectedNotice, setSelectedNotice] = useState<GovernanceNotice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!orgId) return;
    setError(null);
    try {
      const [d, n] = await Promise.all([
        apiFetch(`/organizations/${orgId}/governance/documents`),
        apiFetch(`/organizations/${orgId}/governance/notices`),
      ]);
      setDocs(Array.isArray(d) ? d : []);
      setNotices(Array.isArray(n) ? n : []);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchAll();
  };

  const filteredDocs = docs.filter(
    (d) =>
      !search ||
      d.title.toLowerCase().includes(search.toLowerCase()) ||
      (d.description ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const pinnedNotices = notices.filter((n) => n.isPinned);
  const otherNotices = notices.filter((n) => !n.isPinned);
  const sortedNotices = [...pinnedNotices, ...otherNotices];

  const openDownload = (url: string) => {
    Linking.openURL(url).catch(() =>
      Alert.alert("Error", "Could not open the document")
    );
  };

  if (!orgId) {
    return (
      <View style={styles.centered}>
        <Feather name="shield" size={48} color={Colors.muted} />
        <Text style={styles.emptyText}>No organisation selected</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Club Governance</Text>
        <Text style={styles.headerSub}>Documents, notices & more</Text>
      </View>

      {/* Tab Bar */}
      <View style={styles.tabBar}>
        {(["documents", "notices"] as Tab[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, activeTab === t && styles.tabActive]}
            onPress={() => setActiveTab(t)}
          >
            <Feather
              name={t === "documents" ? "file-text" : "bell"}
              size={14}
              color={activeTab === t ? Colors.primary : Colors.muted}
              style={{ marginRight: 5 }}
            />
            <Text
              style={[
                styles.tabLabel,
                activeTab === t && styles.tabLabelActive,
              ]}
            >
              {t === "documents" ? "Documents" : "Notices"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Search (docs only) */}
      {activeTab === "documents" && (
        <View style={styles.searchContainer}>
          <Feather name="search" size={16} color={Colors.muted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search documents…"
            placeholderTextColor={Colors.muted}
            value={search}
            onChangeText={setSearch}
          />
        </View>
      )}

      {loading ? (
        <View style={styles.centered}>
          <LoadingSpinner color={Colors.primary} size="large" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Feather name="alert-circle" size={40} color={Colors.error} />
          <Text style={[styles.emptyText, { color: Colors.error }]}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={fetchAll}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        >
          {activeTab === "documents" && (
            <>
              {filteredDocs.length === 0 ? (
                <View style={styles.emptyCentered}>
                  <Feather name="file-text" size={40} color={Colors.muted} />
                  <Text style={styles.emptyText}>No documents found</Text>
                </View>
              ) : (
                filteredDocs.map((doc) => (
                  <TouchableOpacity
                    key={doc.id}
                    style={styles.card}
                    onPress={() => setSelectedDoc(doc)}
                  >
                    <View style={styles.docIcon}>
                      <Feather name="file-text" size={20} color={Colors.primary} />
                    </View>
                    <View style={styles.docContent}>
                      <Text style={styles.docTitle} numberOfLines={2}>{doc.title}</Text>
                      <Text style={styles.docMeta}>
                        {CATEGORY_LABELS[doc.category] ?? doc.category}
                        {doc.latestVersion ? ` · v${doc.latestVersion.versionNumber}` : ""}
                        {" · "}{formatDate(doc.updatedAt)}
                      </Text>
                      {doc.description ? (
                        <Text style={styles.docDesc} numberOfLines={1}>{doc.description}</Text>
                      ) : null}
                    </View>
                    <View style={styles.docActions}>
                      {doc.latestVersion && (
                        <TouchableOpacity
                          onPress={() => openDownload(doc.latestVersion!.fileUrl)}
                          style={styles.downloadBtn}
                        >
                          <Feather name="download" size={18} color={Colors.primary} />
                        </TouchableOpacity>
                      )}
                      <Feather name="chevron-right" size={18} color={Colors.muted} />
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </>
          )}

          {activeTab === "notices" && (
            <>
              {sortedNotices.length === 0 ? (
                <View style={styles.emptyCentered}>
                  <Feather name="bell" size={40} color={Colors.muted} />
                  <Text style={styles.emptyText}>No notices</Text>
                </View>
              ) : (
                sortedNotices.map((notice) => {
                  const isExpired = notice.expiresAt && new Date(notice.expiresAt) < new Date();
                  return (
                    <TouchableOpacity
                      key={notice.id}
                      style={[styles.card, notice.isPinned && styles.pinnedCard]}
                      onPress={() => setSelectedNotice(notice)}
                    >
                      {notice.isPinned && (
                        <View style={styles.pinBadge}>
                          <Feather name="anchor" size={10} color={Colors.primary} />
                        </View>
                      )}
                      <View style={styles.noticeContent}>
                        <Text style={styles.docTitle} numberOfLines={2}>{notice.title}</Text>
                        <Text style={styles.docDesc} numberOfLines={2}>{notice.body}</Text>
                        <View style={styles.noticeMeta}>
                          <Text style={styles.docMeta}>{formatDate(notice.createdAt)}</Text>
                          {isExpired && (
                            <View style={styles.expiredBadge}>
                              <Text style={styles.expiredText}>Expired</Text>
                            </View>
                          )}
                          {notice.expiresAt && !isExpired && (
                            <Text style={styles.docMeta}>Expires {formatDate(notice.expiresAt)}</Text>
                          )}
                        </View>
                      </View>
                      <Feather name="chevron-right" size={18} color={Colors.muted} />
                    </TouchableOpacity>
                  );
                })
              )}
            </>
          )}
        </ScrollView>
      )}

      {/* Document Detail Modal */}
      <Modal visible={!!selectedDoc} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelectedDoc(null)}>
        {selectedDoc && (
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setSelectedDoc(null)} style={styles.modalClose}>
                <Feather name="x" size={22} color={Colors.text} />
              </TouchableOpacity>
              <Text style={styles.modalTitle} numberOfLines={2}>{selectedDoc.title}</Text>
            </View>
            <ScrollView style={styles.modalScroll}>
              <View style={styles.modalBody}>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Category</Text>
                  <Text style={styles.infoValue}>{CATEGORY_LABELS[selectedDoc.category] ?? selectedDoc.category}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Access</Text>
                  <Text style={styles.infoValue}>{selectedDoc.access.replace(/_/g, ' ')}</Text>
                </View>
                {selectedDoc.description ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Description</Text>
                    <Text style={styles.infoValue}>{selectedDoc.description}</Text>
                  </View>
                ) : null}
                {selectedDoc.latestVersion && (
                  <>
                    <View style={styles.infoRow}>
                      <Text style={styles.infoLabel}>Latest Version</Text>
                      <Text style={styles.infoValue}>v{selectedDoc.latestVersion.versionNumber} · {selectedDoc.latestVersion.fileName}</Text>
                    </View>
                    <TouchableOpacity
                      style={styles.downloadBtnLarge}
                      onPress={() => openDownload(selectedDoc.latestVersion!.fileUrl)}
                    >
                      <Feather name="download" size={18} color="#fff" style={{ marginRight: 8 }} />
                      <Text style={styles.downloadBtnText}>Download Document</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </ScrollView>
          </View>
        )}
      </Modal>

      {/* Notice Detail Modal */}
      <Modal visible={!!selectedNotice} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelectedNotice(null)}>
        {selectedNotice && (
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setSelectedNotice(null)} style={styles.modalClose}>
                <Feather name="x" size={22} color={Colors.text} />
              </TouchableOpacity>
              <Text style={styles.modalTitle} numberOfLines={2}>{selectedNotice.title}</Text>
            </View>
            <ScrollView style={styles.modalScroll}>
              <View style={styles.modalBody}>
                {selectedNotice.isPinned && (
                  <View style={styles.pinnedRow}>
                    <Feather name="anchor" size={14} color={Colors.primary} />
                    <Text style={styles.pinnedLabel}>Pinned Notice</Text>
                  </View>
                )}
                <Text style={styles.noticeBody}>{selectedNotice.body}</Text>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Posted</Text>
                  <Text style={styles.infoValue}>{formatDate(selectedNotice.createdAt)}</Text>
                </View>
                {selectedNotice.expiresAt && (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Expires</Text>
                    <Text style={styles.infoValue}>{formatDate(selectedNotice.expiresAt)}</Text>
                  </View>
                )}
              </View>
            </ScrollView>
          </View>
        )}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 12,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: Colors.text,
  },
  headerSub: {
    fontSize: 13,
    color: Colors.muted,
    marginTop: 2,
  },
  tabBar: {
    flexDirection: "row",
    backgroundColor: Colors.surface,
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tabActive: {
    backgroundColor: Colors.primary + "25",
    borderColor: Colors.primary + "60",
  },
  tabLabel: {
    fontSize: 13,
    color: Colors.muted,
    fontWeight: "500",
  },
  tabLabelActive: {
    color: Colors.primary,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginVertical: 10,
    backgroundColor: Colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    height: 40,
    color: Colors.text,
    fontSize: 14,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 32,
    gap: 10,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  emptyCentered: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    color: Colors.muted,
    fontSize: 14,
    textAlign: "center",
  },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: Colors.primary,
  },
  retryText: {
    color: "#fff",
    fontWeight: "600",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pinnedCard: {
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  pinBadge: {
    position: "absolute",
    top: 8,
    right: 8,
  },
  docIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: Colors.primary + "20",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
    flexShrink: 0,
  },
  docContent: {
    flex: 1,
    marginRight: 8,
  },
  noticeContent: {
    flex: 1,
    marginRight: 8,
  },
  docTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
    marginBottom: 3,
  },
  docMeta: {
    fontSize: 11,
    color: Colors.muted,
  },
  docDesc: {
    fontSize: 12,
    color: Colors.textSecondary ?? Colors.muted,
    marginTop: 2,
  },
  docActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  downloadBtn: {
    padding: 6,
  },
  noticeMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  expiredBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: Colors.error + "30",
  },
  expiredText: {
    fontSize: 10,
    color: Colors.error,
    fontWeight: "600",
  },
  modalContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 12,
  },
  modalClose: {
    padding: 4,
    marginTop: 2,
  },
  modalTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
  },
  modalScroll: {
    flex: 1,
  },
  modalBody: {
    padding: 20,
    gap: 16,
  },
  infoRow: {
    gap: 4,
  },
  infoLabel: {
    fontSize: 11,
    color: Colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  infoValue: {
    fontSize: 14,
    color: Colors.text,
  },
  downloadBtnLarge: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 8,
  },
  downloadBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  pinnedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  pinnedLabel: {
    fontSize: 13,
    color: Colors.primary,
    fontWeight: "600",
  },
  noticeBody: {
    fontSize: 15,
    color: Colors.text,
    lineHeight: 22,
  },
});
