import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  RefreshControl,
  Modal,
  TextInput,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { router } from "expo-router";
import { Feather, Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";
import { getLocale } from "@/i18n";
import { formatCourseMapCentre } from "@/utils/courseMapCentre";

const GOLD = "#C9A84C";

interface Round {
  round: {
    id: number;
    holesPlayed: number;
    status: string;
    grossScore: number | null;
    scoreDifferential: string | null;
    playedAt: string;
  };
  courseName: string | null;
}

interface Course {
  id: number;
  name: string;
  // Task #1940 — feed the picker's "Located near …" subline (or
  // textual fallback) under the course name.
  location?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  mapDefaultLat?: string | null;
  mapDefaultLng?: string | null;
}

interface MarkerPending {
  roundId: number;
  courseName: string | null;
  round: { playedAt: string };
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  draft:          { label: "Draft", color: Colors.textSecondary },
  in_progress:    { label: "In Progress", color: Colors.primary },
  pending_marker: { label: "Awaiting Marker", color: "#f59e0b" },
  confirmed:      { label: "Confirmed ✓", color: "#22c55e" },
  disputed:       { label: "Disputed", color: Colors.error },
  unverified:     { label: "Unverified", color: Colors.error },
};

type ModalStep = "course" | "marker";

export default function GeneralPlayListScreen() {
  const { token, user } = useAuth();
  const { activeClub } = useActiveClub();
  const orgId = activeClub?.id;

  const [rounds, setRounds] = useState<Round[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [pendingMarker, setPendingMarker] = useState<MarkerPending[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [modalStep, setModalStep] = useState<ModalStep>("course");
  const [selectedCourse, setSelectedCourse] = useState("");
  const [holesPlayed, setHolesPlayed] = useState("18");
  const [markerName, setMarkerName] = useState("");
  const [markerEmail, setMarkerEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedCourseMissingPar, setSelectedCourseMissingPar] = useState(false);

  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : "";

  async function load() {
    if (!orgId || !token) return;
    try {
      const [roundsRes, coursesRes, markerRes] = await Promise.all([
        fetch(`${baseUrl}/api/portal/general-play?organizationId=${orgId}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${baseUrl}/api/organizations/${orgId}/courses`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${baseUrl}/api/portal/general-play/pending-marker`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (roundsRes.ok) setRounds(await roundsRes.json());
      if (coursesRes.ok) setCourses(await coursesRes.json());
      if (markerRes.ok) setPendingMarker(await markerRes.json());
    } catch { /* ignore */ } finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => { load(); }, [orgId, token]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [orgId, token]);

  // Check if selected course has holes with missing par
  useEffect(() => {
    if (!selectedCourse || !orgId || !token) { setSelectedCourseMissingPar(false); return; }
    fetch(`${baseUrl}/api/organizations/${orgId}/courses/${selectedCourse}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: { holeDetails?: { par: number }[] } | null) => {
        if (data?.holeDetails?.length) {
          const hasMissing = data.holeDetails.some(h => !h.par || h.par === 0);
          setSelectedCourseMissingPar(hasMissing);
        } else {
          setSelectedCourseMissingPar(false);
        }
      })
      .catch(() => setSelectedCourseMissingPar(false));
  }, [selectedCourse, orgId, token]);

  function openNewRoundModal() {
    setModalStep("course");
    setSelectedCourse("");
    setHolesPlayed("18");
    setMarkerName("");
    setMarkerEmail("");
    setShowNew(true);
  }

  function proceedToMarkerStep() {
    if (!selectedCourse) { Alert.alert("Select a course first"); return; }
    setModalStep("marker");
  }

  async function createRound() {
    if (!markerName.trim()) { Alert.alert("Enter your marker's name"); return; }
    setCreating(true);
    try {
      const res = await fetch(`${baseUrl}/api/portal/general-play`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId: parseInt(selectedCourse),
          organizationId: orgId,
          holesPlayed: parseInt(holesPlayed),
          playedAt: new Date().toISOString(),
          markerName: markerName.trim(),
          markerEmail: markerEmail.trim() || null,
        }),
      });
      if (!res.ok) { Alert.alert("Failed to create round"); return; }
      const round = await res.json();
      setShowNew(false);
      router.push(`/general-play/${round.id}`);
    } finally { setCreating(false); }
  }

  async function confirmMarker(roundId: number) {
    const res = await fetch(`${baseUrl}/api/portal/general-play/${roundId}/confirm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      Alert.alert("Confirmed!", `Differential: ${data.finalDifferential}. New H.I.: ${data.newHandicapIndex ?? "calculating..."}`);
      load();
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="chevron-left" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>General Play</Text>
        <TouchableOpacity style={styles.newBtn} onPress={openNewRoundModal}>
          <Feather name="plus" size={18} color="#000" />
        </TouchableOpacity>
      </View>

      {/* WHS State Banner */}
      <View style={styles.whsBanner}>
        <Feather name="award" size={14} color={GOLD} />
        <Text style={styles.whsBannerText}>Post casual rounds to build your WHS Handicap Index</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}
      >
        {/* Pending marker actions */}
        {pendingMarker.length > 0 && (
          <View style={styles.markerSection}>
            <Text style={styles.sectionTitle}>Awaiting Your Countersign</Text>
            {pendingMarker.map(m => (
              <View key={m.roundId} style={styles.markerCard}>
                <View style={styles.markerInfo}>
                  <Text style={styles.markerCourse}>{m.courseName ?? "Course"}</Text>
                  <Text style={styles.markerDate}>{new Date(m.round.playedAt).toLocaleDateString(getLocale())}</Text>
                </View>
                <View style={styles.markerActions}>
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.disputeBtn]}
                    onPress={() => {
                      Alert.prompt("Dispute", "Enter reason:", note => {
                        if (!note) return;
                        fetch(`${baseUrl}/api/portal/general-play/${m.roundId}/dispute`, {
                          method: "POST",
                          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                          body: JSON.stringify({ note }),
                        }).then(() => load());
                      });
                    }}
                  >
                    <Text style={styles.disputeBtnText}>Dispute</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.confirmBtn]}
                    onPress={() => confirmMarker(m.roundId)}
                  >
                    <Text style={styles.confirmBtnText}>Confirm</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Rounds */}
        <Text style={styles.sectionTitle}>My Rounds</Text>
        {loading ? (
          <LoadingSpinner color={GOLD} style={{ marginTop: 40 }} />
        ) : rounds.length === 0 ? (
          <View style={styles.empty}>
            <Feather name="activity" size={32} color={Colors.muted} />
            <Text style={styles.emptyText}>No rounds yet. Post your first score!</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={openNewRoundModal}>
              <Text style={styles.emptyBtnText}>Post a Score</Text>
            </TouchableOpacity>
          </View>
        ) : (
          rounds.map(({ round, courseName }) => {
            const s = STATUS_LABEL[round.status] ?? { label: round.status, color: Colors.muted };
            return (
              <TouchableOpacity
                key={round.id}
                style={styles.roundCard}
                onPress={() => router.push(`/general-play/${round.id}`)}
              >
                <View style={styles.roundLeft}>
                  <Text style={styles.roundCourse}>{courseName ?? "Unknown Course"}</Text>
                  <Text style={styles.roundMeta}>
                    {new Date(round.playedAt).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" })}
                    {" · "}{round.holesPlayed} holes
                  </Text>
                  <Text style={[styles.roundStatus, { color: s.color }]}>{s.label}</Text>
                </View>
                {round.scoreDifferential ? (
                  <View style={styles.roundRight}>
                    <Text style={styles.diffLabel}>Diff</Text>
                    <Text style={styles.diffValue}>{Number(round.scoreDifferential).toFixed(1)}</Text>
                  </View>
                ) : round.grossScore ? (
                  <View style={styles.roundRight}>
                    <Text style={styles.diffLabel}>Gross</Text>
                    <Text style={styles.diffValue}>{round.grossScore}</Text>
                  </View>
                ) : (
                  <Feather name="chevron-right" size={20} color={Colors.muted} />
                )}
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* New Round Modal */}
      <Modal visible={showNew} transparent animationType="slide" onRequestClose={() => setShowNew(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modal}>
            {modalStep === "course" ? (
              <>
                <Text style={styles.modalTitle}>Post a Score</Text>

                {/* Step indicator */}
                <View style={styles.stepRow}>
                  <View style={[styles.stepDot, styles.stepDotActive]} />
                  <View style={styles.stepLine} />
                  <View style={styles.stepDot} />
                </View>
                <Text style={styles.stepLabel}>Step 1 of 2 — Select Course & Holes</Text>

                <Text style={styles.fieldLabel}>Select Course</Text>
                <ScrollView style={styles.courseList} showsVerticalScrollIndicator={false}>
                  {courses.map(c => {
                    // Task #1940 — prefer the remembered mapper centre,
                    // fall back to the textual `location`, hide when neither.
                    const mapCentre = formatCourseMapCentre(c);
                    const subline = mapCentre
                      ? `Located near ${mapCentre}`
                      : (c.location?.trim() || null);
                    const isSelected = selectedCourse === String(c.id);
                    return (
                      <TouchableOpacity
                        key={c.id}
                        style={[styles.courseItem, isSelected && styles.courseItemSelected]}
                        onPress={() => setSelectedCourse(String(c.id))}
                        testID={`course-picker-item-${c.id}`}
                      >
                        <View style={styles.courseItemBody}>
                          <Text style={[styles.courseItemText, isSelected && { color: GOLD }]}>
                            {c.name}
                          </Text>
                          {subline && (
                            <View style={styles.courseItemMetaRow}>
                              {mapCentre && <Feather name="map-pin" size={10} color={Colors.muted} />}
                              <Text
                                style={styles.courseItemMeta}
                                numberOfLines={1}
                                testID={`course-picker-location-${c.id}`}
                              >
                                {subline}
                              </Text>
                            </View>
                          )}
                        </View>
                        {isSelected && <Feather name="check" size={16} color={GOLD} />}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                <Text style={styles.fieldLabel}>Holes Played</Text>
                <View style={styles.holesToggle}>
                  {["18", "9"].map(h => (
                    <TouchableOpacity
                      key={h}
                      style={[styles.holesBtn, holesPlayed === h && styles.holesBtnActive]}
                      onPress={() => setHolesPlayed(h)}
                    >
                      <Text style={[styles.holesBtnText, holesPlayed === h && { color: "#000" }]}>{h} holes</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={styles.modalActions}>
                  <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowNew(false)}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.createBtn} onPress={proceedToMarkerStep}>
                    <Text style={styles.createBtnText}>Next: Marker →</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.modalTitle}>Who is your marker?</Text>

                {/* Step indicator */}
                <View style={styles.stepRow}>
                  <View style={[styles.stepDot, styles.stepDotActive]} />
                  <View style={[styles.stepLine, styles.stepLineActive]} />
                  <View style={[styles.stepDot, styles.stepDotActive]} />
                </View>
                <Text style={styles.stepLabel}>Step 2 of 2 — Assign Marker (WHS Required)</Text>

                <View style={styles.markerInfoBox}>
                  <Ionicons name="information-circle-outline" size={16} color={GOLD} />
                  <Text style={styles.markerInfoText}>
                    WHS Rule 7.1 requires a marker to be designated before the round begins.
                  </Text>
                </View>

                {selectedCourseMissingPar && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#fef3c7", padding: 10, borderRadius: 8, marginBottom: 12, borderWidth: 1, borderColor: "#f59e0b" }}>
                    <Feather name="alert-triangle" size={13} color="#92400e" />
                    <Text style={{ flex: 1, fontSize: 12, color: "#92400e", fontFamily: "Inter_600SemiBold" }}>
                      This course has holes with missing par data. Contact your club admin to set it up.
                    </Text>
                  </View>
                )}

                <Text style={styles.fieldLabel}>Marker Name *</Text>
                <TextInput
                  style={styles.input}
                  value={markerName}
                  onChangeText={setMarkerName}
                  placeholder="Full name of your marker"
                  placeholderTextColor={Colors.muted}
                  autoCapitalize="words"
                />

                <Text style={styles.fieldLabel}>Marker Email (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={markerEmail}
                  onChangeText={setMarkerEmail}
                  placeholder="email@example.com"
                  placeholderTextColor={Colors.muted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />

                <View style={styles.modalActions}>
                  <TouchableOpacity style={styles.cancelBtn} onPress={() => setModalStep("course")}>
                    <Text style={styles.cancelBtnText}>← Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.createBtn} onPress={createRound} disabled={creating}>
                    <Text style={styles.createBtnText}>{creating ? "Creating..." : "Start Round"}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 },
  backBtn: { padding: 4 },
  title: { flex: 1, fontSize: 20, fontWeight: "700", color: Colors.text, marginLeft: 8 },
  newBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: GOLD, alignItems: "center", justifyContent: "center" },
  whsBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: `${GOLD}15`, marginHorizontal: 16, borderRadius: 8, padding: 10, marginBottom: 8 },
  whsBannerText: { flex: 1, fontSize: 12, color: GOLD },
  scroll: { flex: 1 },
  sectionTitle: { fontSize: 13, fontWeight: "600", color: Colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginHorizontal: 16, marginTop: 12, marginBottom: 6 },
  markerSection: { marginBottom: 8 },
  markerCard: { flexDirection: "row", alignItems: "center", backgroundColor: `${Colors.surface}80`, marginHorizontal: 16, borderRadius: 10, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: `${GOLD}40` },
  markerInfo: { flex: 1 },
  markerCourse: { color: Colors.text, fontWeight: "600", fontSize: 14 },
  markerDate: { color: Colors.muted, fontSize: 12 },
  markerActions: { flexDirection: "row", gap: 8 },
  actionBtn: { borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  disputeBtn: { borderWidth: 1, borderColor: `${Colors.error}60` },
  disputeBtnText: { color: Colors.error, fontSize: 13, fontWeight: "600" },
  confirmBtn: { backgroundColor: "#22c55e30", borderWidth: 1, borderColor: "#22c55e60" },
  confirmBtnText: { color: "#22c55e", fontSize: 13, fontWeight: "600" },
  roundCard: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.surface, marginHorizontal: 16, borderRadius: 12, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: Colors.border },
  roundLeft: { flex: 1 },
  roundCourse: { color: Colors.text, fontWeight: "600", fontSize: 15 },
  roundMeta: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  roundStatus: { fontSize: 12, fontWeight: "500", marginTop: 4 },
  roundRight: { alignItems: "flex-end" },
  diffLabel: { color: Colors.muted, fontSize: 11 },
  diffValue: { color: GOLD, fontSize: 22, fontWeight: "700" },
  empty: { alignItems: "center", paddingVertical: 40, paddingHorizontal: 32 },
  emptyText: { color: Colors.muted, fontSize: 15, textAlign: "center", marginTop: 12 },
  emptyBtn: { marginTop: 16, backgroundColor: GOLD, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  emptyBtnText: { color: "#000", fontWeight: "700", fontSize: 14 },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modal: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: "85%" },
  modalTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, marginBottom: 8 },
  stepRow: { flexDirection: "row", alignItems: "center", marginBottom: 4 },
  stepDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.border },
  stepDotActive: { backgroundColor: GOLD },
  stepLine: { flex: 1, height: 2, backgroundColor: Colors.border, marginHorizontal: 4 },
  stepLineActive: { backgroundColor: GOLD },
  stepLabel: { fontSize: 11, color: Colors.muted, marginBottom: 12 },
  markerInfoBox: { flexDirection: "row", gap: 8, backgroundColor: `${GOLD}10`, borderRadius: 8, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: `${GOLD}30` },
  markerInfoText: { flex: 1, fontSize: 12, color: GOLD },
  fieldLabel: { fontSize: 13, color: Colors.muted, fontWeight: "600", marginBottom: 6, marginTop: 12 },
  courseList: { maxHeight: 220 },
  courseItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, marginBottom: 4 },
  courseItemSelected: { borderColor: GOLD, backgroundColor: `${GOLD}10` },
  courseItemBody: { flex: 1, marginRight: 8 },
  courseItemText: { color: Colors.text, fontSize: 14 },
  courseItemMetaRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  courseItemMeta: { flex: 1, color: Colors.muted, fontSize: 11 },
  holesToggle: { flexDirection: "row", gap: 8, marginTop: 4 },
  holesBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, alignItems: "center" },
  holesBtnActive: { backgroundColor: GOLD, borderColor: GOLD },
  holesBtnText: { color: Colors.text, fontWeight: "600" },
  input: { backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, padding: 12, color: Colors.text, fontSize: 14 },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 20 },
  cancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, alignItems: "center" },
  cancelBtnText: { color: Colors.text, fontWeight: "600" },
  createBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: GOLD, alignItems: "center" },
  createBtnText: { color: "#000", fontWeight: "700" },
});
