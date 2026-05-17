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
  FlatList,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather, Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { BASE_URL } from "@/utils/api";
import { formatRelativeTime } from "@/i18n/relativeTime";

const GOLD = "#C9A84C";

interface GeneralPlayPending {
  type: "general_play";
  markerId: number;
  roundId: number;
  markerName: string;
  courseName: string | null;
  round: {
    playedAt: string;
    holesPlayed: number;
    status: string;
    userId: number;
  };
}

interface TournamentPending {
  type: "tournament";
  submissionId: number;
  playerName: string;
  tournamentName: string;
  tournamentId: number;
  round: number;
  totalStrokes: number | null;
  submittedAt: string;
  awaitingMarkerCount?: number;
  scores: Array<{ hole: number; strokes: number; awaitingMarker?: boolean; isVerified?: boolean }>;
}

type PendingItem = GeneralPlayPending | TournamentPending;

interface GeneralPlayHole {
  holeNumber: number;
  par: number;
  handicap: number | null;
}

interface GeneralPlayDetail {
  holes: Array<{ holeNumber: number; strokes: number; par: number | null; strokeIndex: number | null }>;
  courseHoles: GeneralPlayHole[];
}

interface TournamentHole {
  holeNumber: number;
  par: number;
  handicap?: number;
}

export default function MarkerScreen() {
  const { token, isAuthenticated } = useAuth();
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Review modal state
  const [selectedItem, setSelectedItem] = useState<PendingItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [gpDetail, setGpDetail] = useState<GeneralPlayDetail | null>(null);
  const [tournamentHoles, setTournamentHoles] = useState<TournamentHole[]>([]);
  // Per-hole dispute notes: Record<holeNumber, note>
  const [holeDisputeNotes, setHoleDisputeNotes] = useState<Record<number, string>>({});
  const [disputeGeneralNote, setDisputeGeneralNote] = useState("");
  const [showDisputeInput, setShowDisputeInput] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Code-entry path: marker enters the 6-digit code shared by the player
  const [showCodeEntry, setShowCodeEntry] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [codeSubmitting, setCodeSubmitting] = useState(false);

  // Per-hole verify (Task #483): track which hole is currently being confirmed
  // so we can show a spinner on just that row.
  const [verifyingHole, setVerifyingHole] = useState<number | null>(null);

  async function handleVerifyHole(holeNumber: number) {
    if (!selectedItem || selectedItem.type !== "tournament" || !token) return;
    if (verifyingHole !== null || actionLoading) return;
    const submissionId = (selectedItem as TournamentPending).submissionId;
    setVerifyingHole(holeNumber);
    try {
      const res = await fetch(
        `${BASE_URL}/api/portal/submissions/${submissionId}/scores/${holeNumber}/verify`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert("Could not confirm hole", err?.error ?? "Please try again.");
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { verified?: boolean; alreadyVerified?: boolean };
      // If the server says the hole was already verified (stale UI / race),
      // clear the indicator on this row but don't decrement the count — the
      // count was already correct. Otherwise this is a fresh verification:
      // clear the indicator AND decrement.
      const wasFreshVerification = data.alreadyVerified !== true;
      setSelectedItem(prev => {
        if (!prev || prev.type !== "tournament") return prev;
        const next: TournamentPending = {
          ...prev,
          scores: prev.scores.map(s =>
            s.hole === holeNumber ? { ...s, awaitingMarker: false, isVerified: true } : s,
          ),
          awaitingMarkerCount: wasFreshVerification
            ? Math.max(0, (prev.awaitingMarkerCount ?? 0) - 1)
            : prev.awaitingMarkerCount,
        };
        return next;
      });
      // Reflect the new awaitingMarkerCount on the inbox card too — only when
      // this call actually flipped the flag, to avoid drifting on a stale UI.
      if (wasFreshVerification) {
        setItems(prev => prev.map(it => {
          if (it.type !== "tournament" || it.submissionId !== submissionId) return it;
          return { ...it, awaitingMarkerCount: Math.max(0, (it.awaitingMarkerCount ?? 0) - 1) };
        }));
      }
    } catch {
      Alert.alert("Error", "Network error. Please try again.");
    } finally {
      setVerifyingHole(null);
    }
  }

  async function load() {
    if (!token) { setLoading(false); return; }
    try {
      const [gpRes, tourRes] = await Promise.all([
        fetch(`${BASE_URL}/api/portal/general-play/pending-marker`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${BASE_URL}/api/portal/pending-submissions`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      const gpItems: PendingItem[] = gpRes.ok
        ? (await gpRes.json()).map((m: GeneralPlayPending) => ({ ...m, type: "general_play" as const }))
        : [];

      const tourItems: PendingItem[] = tourRes.ok
        ? (await tourRes.json()).map((s: TournamentPending) => ({ ...s, type: "tournament" as const }))
        : [];

      setItems([...gpItems, ...tourItems]);
    } catch { /* ignore */ }
    finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => { load(); }, [token]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [token]);

  async function handleCodeLookup() {
    const code = codeInput.trim().replace(/\D/g, "");
    if (code.length !== 6) { Alert.alert("Enter the 6-digit code shown on the player's app."); return; }
    if (!token) return;
    setCodeSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/submissions/by-code/${code}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert("Not Found", err?.error ?? "No pending submission found for this code.");
        return;
      }
      const data = await res.json();
      // Build a TournamentPending from the code-lookup data and open review
      const syntheticItem: TournamentPending = {
        type: "tournament",
        submissionId: data.submissionId,
        playerName: data.playerName,
        tournamentName: data.tournamentName,
        tournamentId: data.tournamentId,
        round: data.round,
        totalStrokes: data.totalStrokes,
        submittedAt: data.submittedAt,
        awaitingMarkerCount: data.awaitingMarkerCount,
        scores: data.scores.map((s: { hole: number; strokes: number; awaitingMarker?: boolean; isVerified?: boolean }) => ({
          hole: s.hole,
          strokes: s.strokes,
          awaitingMarker: s.awaitingMarker ?? (s.isVerified === false),
          isVerified: s.isVerified,
        })),
      };
      setShowCodeEntry(false);
      setCodeInput("");
      openReview(syntheticItem);
    } catch {
      Alert.alert("Error", "Network error. Please try again.");
    } finally { setCodeSubmitting(false); }
  }

  async function openReview(item: PendingItem) {
    setSelectedItem(item);
    setGpDetail(null);
    setTournamentHoles([]);
    setHoleDisputeNotes({});
    setDisputeGeneralNote("");
    setShowDisputeInput(false);
    setDetailLoading(true);

    try {
      if (item.type === "general_play") {
        const res = await fetch(`${BASE_URL}/api/portal/general-play/${item.roundId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) setGpDetail(await res.json());
      } else {
        const res = await fetch(`${BASE_URL}/api/public/tournaments/${item.tournamentId}/holes?round=${item.round}`);
        if (res.ok) {
          const data = await res.json();
          setTournamentHoles(Array.isArray(data) ? data : (data.holes ?? []));
        }
      }
    } catch { /* ignore */ }
    finally { setDetailLoading(false); }
  }

  function closeReview() {
    setSelectedItem(null);
    setGpDetail(null);
    setTournamentHoles([]);
    setShowDisputeInput(false);
    setHoleDisputeNotes({});
    setDisputeGeneralNote("");
  }

  async function handleCountersign() {
    if (!selectedItem || !token) return;
    setActionLoading(true);
    try {
      let url = "";
      let body: Record<string, unknown> = {};

      if (selectedItem.type === "general_play") {
        url = `${BASE_URL}/api/portal/general-play/${selectedItem.roundId}/confirm`;
      } else {
        url = `${BASE_URL}/api/portal/submissions/${selectedItem.submissionId}/countersign`;
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert("Error", err?.error ?? "Could not countersign. Please try again.");
        return;
      }

      Alert.alert("Countersigned ✅", "The scorecard has been confirmed successfully.");
      closeReview();
      load();
    } catch {
      Alert.alert("Error", "Network error. Please try again.");
    } finally { setActionLoading(false); }
  }

  async function handleDispute() {
    // Build combined dispute note from per-hole notes + general note
    const holeEntries = Object.entries(holeDisputeNotes)
      .filter(([, note]) => note.trim())
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([hole, note]) => `Hole ${hole}: ${note.trim()}`);
    const combinedNote = [
      ...(holeEntries.length > 0 ? holeEntries : []),
      ...(disputeGeneralNote.trim() ? [`General: ${disputeGeneralNote.trim()}`] : []),
    ].join("\n");
    if (!combinedNote) { Alert.alert("Please add at least one note (per-hole or general) for the dispute."); return; }
    if (!selectedItem || !token) return;
    setActionLoading(true);
    try {
      let url = "";
      let body: Record<string, unknown> = {};

      if (selectedItem.type === "general_play") {
        url = `${BASE_URL}/api/portal/general-play/${selectedItem.roundId}/dispute`;
        body = { note: combinedNote };
      } else {
        url = `${BASE_URL}/api/portal/submissions/${selectedItem.submissionId}/dispute`;
        // Send both the human-readable combined note and per-hole structured flags
        const structuredHoles = Object.entries(holeDisputeNotes)
          .filter(([, note]) => note.trim())
          .map(([hole, note]) => ({ holeNumber: parseInt(hole), markerNote: note.trim() }));
        body = {
          note: combinedNote,
          ...(structuredHoles.length > 0 ? { holes: structuredHoles } : {}),
        };
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert("Error", err?.error ?? "Could not dispute. Please try again.");
        return;
      }

      Alert.alert("Disputed", "The scorecard has been marked as disputed.");
      closeReview();
      load();
    } catch {
      Alert.alert("Error", "Network error. Please try again.");
    } finally { setActionLoading(false); }
  }

  // ── Build hole rows for the review ────────────────────────────────────────

  function renderHoles() {
    if (!selectedItem) return null;

    if (selectedItem.type === "general_play" && gpDetail) {
      return gpDetail.courseHoles.map(ch => {
        const scored = gpDetail.holes.find(h => h.holeNumber === ch.holeNumber);
        const strokes = scored?.strokes ?? null;
        const toPar = strokes !== null ? strokes - ch.par : null;
        const toParLabel = toPar === null ? "" : toPar === 0 ? "Par" : toPar === -1 ? "Birdie" : toPar === -2 ? "Eagle" : toPar === 1 ? "Bogey" : toPar > 0 ? `+${toPar}` : `${toPar}`;
        const toParColor = toPar === null ? Colors.muted : toPar < 0 ? "#f87171" : toPar === 0 ? Colors.muted : "#60a5fa";
        return (
          <View key={ch.holeNumber}>
            <View style={styles.holeRow}>
              <Text style={styles.holeRowNum}>{ch.holeNumber}</Text>
              <Text style={styles.holeRowPar}>P{ch.par}</Text>
              {ch.handicap ? <Text style={styles.holeRowSI}>SI{ch.handicap}</Text> : <Text style={styles.holeRowSI} />}
              <Text style={[styles.holeRowStrokes, strokes === null && { color: Colors.muted }]}>
                {strokes ?? "—"}
              </Text>
              <Text style={[styles.holeRowToPar, { color: toParColor }]}>{toParLabel}</Text>
            </View>
            {showDisputeInput && (
              <TextInput
                style={styles.holeNoteInput}
                value={holeDisputeNotes[ch.holeNumber] ?? ""}
                onChangeText={text => setHoleDisputeNotes(prev => ({ ...prev, [ch.holeNumber]: text }))}
                placeholder={`Note for hole ${ch.holeNumber} (optional)`}
                placeholderTextColor={Colors.muted}
                multiline={false}
              />
            )}
          </View>
        );
      });
    }

    if (selectedItem.type === "tournament") {
      const scores = selectedItem.scores;
      const holeInfoMap: Record<number, TournamentHole> = {};
      tournamentHoles.forEach(h => { holeInfoMap[h.holeNumber] = h; });

      return scores.map(s => {
        const hi = holeInfoMap[s.hole];
        const par = hi?.par ?? null;
        const toPar = par !== null ? s.strokes - par : null;
        const toParLabel = toPar === null ? "" : toPar === 0 ? "Par" : toPar === -1 ? "Birdie" : toPar === -2 ? "Eagle" : toPar === 1 ? "Bogey" : toPar > 0 ? `+${toPar}` : `${toPar}`;
        const toParColor = toPar === null ? Colors.muted : toPar < 0 ? "#f87171" : toPar === 0 ? Colors.muted : "#60a5fa";
        const awaitingMarker = s.awaitingMarker ?? (s.isVerified === false);
        const isVerifyingThis = verifyingHole === s.hole;
        // While in dispute mode the awaiting tap is disabled so the marker can
        // type per-hole notes without accidentally confirming the score.
        const tapToVerify = awaitingMarker && !showDisputeInput;
        const rowInner = (
          <View style={styles.holeRow}>
            <Text style={styles.holeRowNum}>{s.hole}</Text>
            <Text style={styles.holeRowPar}>{par !== null ? `P${par}` : "—"}</Text>
            <Text style={styles.holeRowSI}>{hi?.handicap ? `SI${hi.handicap}` : ""}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", flex: 1, justifyContent: "center" }}>
              <Text style={styles.holeRowStrokes}>{s.strokes}</Text>
              {isVerifyingThis ? (
                <LoadingSpinner size="small" color="#F59E0B" style={{ marginLeft: 6 }} />
              ) : awaitingMarker ? (
                <Ionicons
                  name="time-outline"
                  size={12}
                  color="#F59E0B"
                  style={{ marginLeft: 4 }}
                  accessibilityLabel="Awaiting marker confirmation. Tap to verify just this hole."
                />
              ) : null}
            </View>
            <Text style={[styles.holeRowToPar, { color: toParColor }]}>{toParLabel}</Text>
          </View>
        );
        return (
          <View key={s.hole}>
            {tapToVerify ? (
              <TouchableOpacity
                onPress={() => {
                  Alert.alert(
                    `Confirm hole ${s.hole}`,
                    `Mark ${s.strokes} stroke${s.strokes === 1 ? "" : "s"} on hole ${s.hole} as verified?`,
                    [
                      { text: "Cancel", style: "cancel" },
                      { text: "Confirm", onPress: () => handleVerifyHole(s.hole) },
                    ],
                  );
                }}
                disabled={verifyingHole !== null || actionLoading}
                accessibilityLabel={`Confirm hole ${s.hole}`}
                accessibilityHint="Confirms just this hole without countersigning the entire round"
                activeOpacity={0.7}
              >
                {rowInner}
              </TouchableOpacity>
            ) : rowInner}
            {showDisputeInput && (
              <TextInput
                style={styles.holeNoteInput}
                value={holeDisputeNotes[s.hole] ?? ""}
                onChangeText={text => setHoleDisputeNotes(prev => ({ ...prev, [s.hole]: text }))}
                placeholder={`Note for hole ${s.hole} (optional)`}
                placeholderTextColor={Colors.muted}
                multiline={false}
              />
            )}
          </View>
        );
      });
    }

    return null;
  }

  // ── Not authenticated ──────────────────────────────────────────────────────

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Marker Inbox</Text>
        </View>
        <View style={styles.emptyState}>
          <Ionicons name="shield-checkmark-outline" size={40} color={Colors.muted} />
          <Text style={styles.emptyText}>Sign in to see scorecards waiting for your countersign.</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Main screen ────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Marker Inbox</Text>
        {items.length > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{items.length}</Text>
          </View>
        )}
      </View>

      <View style={styles.infoBanner}>
        <Ionicons name="shield-checkmark-outline" size={14} color={GOLD} />
        <Text style={styles.infoBannerText}>Scorecards assigned to you for countersign</Text>
        <TouchableOpacity
          onPress={() => { setShowCodeEntry(true); setCodeInput(""); }}
          style={{ backgroundColor: `${GOLD}25`, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 }}
        >
          <Text style={{ color: GOLD, fontSize: 12, fontWeight: "700" }}>Enter Code</Text>
        </TouchableOpacity>
      </View>

      {/* Code entry modal */}
      <Modal visible={showCodeEntry} transparent animationType="fade" onRequestClose={() => setShowCodeEntry(false)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.65)", justifyContent: "center", alignItems: "center", padding: 24 }}>
          <View style={{ backgroundColor: Colors.card, borderRadius: 20, padding: 24, width: "100%", maxWidth: 360, borderWidth: 1, borderColor: Colors.border, gap: 16 }}>
            <Text style={{ fontWeight: "700", fontSize: 18, color: Colors.text }}>Enter Marker Code</Text>
            <Text style={{ fontSize: 13, color: Colors.textSecondary }}>
              Ask the player to share their 6-digit code from the app, then enter it here to review their scorecard.
            </Text>
            <TextInput
              style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, padding: 14, color: Colors.text, fontSize: 28, fontWeight: "700", letterSpacing: 8, textAlign: "center" }}
              value={codeInput}
              onChangeText={text => setCodeInput(text.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="000000"
              placeholderTextColor={Colors.muted}
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 12 }}>
              <TouchableOpacity
                onPress={() => setShowCodeEntry(false)}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, alignItems: "center" }}
              >
                <Text style={{ color: Colors.textSecondary, fontWeight: "600" }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleCodeLookup}
                disabled={codeSubmitting || codeInput.length !== 6}
                style={{ flex: 2, paddingVertical: 14, borderRadius: 12, backgroundColor: GOLD, alignItems: "center", opacity: codeInput.length !== 6 ? 0.5 : 1 }}
              >
                {codeSubmitting
                  ? <LoadingSpinner size="small" color="#000" />
                  : <Text style={{ color: "#000", fontWeight: "700", fontSize: 15 }}>Look Up Scorecard</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {loading ? (
        <LoadingSpinner color={GOLD} style={{ marginTop: 60 }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={item =>
            item.type === "general_play"
              ? `gp-${item.roundId}`
              : `tour-${item.submissionId}`
          }
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}
          contentContainerStyle={{ padding: 16, paddingBottom: 40, flexGrow: 1 }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="checkmark-circle-outline" size={40} color={Colors.muted} />
              <Text style={styles.emptyTitle}>All clear!</Text>
              <Text style={styles.emptyText}>No scorecards waiting for your review.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const isGP = item.type === "general_play";
            const playerOrCourse = isGP
              ? (item as GeneralPlayPending).courseName ?? "General Play"
              : (item as TournamentPending).playerName;
            const subtitle = isGP
              ? new Date((item as GeneralPlayPending).round.playedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
              : `${(item as TournamentPending).tournamentName} · Round ${(item as TournamentPending).round}`;
            const strokes = isGP ? null : (item as TournamentPending).totalStrokes;
            const submitted = isGP ? (item as GeneralPlayPending).round.playedAt : (item as TournamentPending).submittedAt;
            // Route the "X minutes/hours/days ago" wait label through the
            // shared `formatRelativeTime` helper (Task #1659) so non-English
            // markers see correctly-pluralized copy via Intl.RelativeTimeFormat
            // instead of the previous English-only fragments.
            const waitLabel = formatRelativeTime(submitted);

            return (
              <TouchableOpacity style={styles.card} onPress={() => openReview(item)}>
                <View style={styles.cardLeft}>
                  <View style={[styles.typeTag, isGP ? styles.typeTagGP : styles.typeTagTour]}>
                    <Text style={styles.typeTagText}>{isGP ? "General Play" : "Tournament"}</Text>
                  </View>
                  <Text style={styles.cardTitle}>{playerOrCourse}</Text>
                  <Text style={styles.cardSubtitle}>{subtitle}</Text>
                  {strokes !== null && <Text style={styles.cardStrokes}>{strokes} strokes</Text>}
                  <Text style={styles.cardWait}>{waitLabel}</Text>
                  {!isGP && ((item as TournamentPending).awaitingMarkerCount ?? 0) > 0 && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 }}>
                      <Ionicons name="time-outline" size={12} color="#F59E0B" />
                      <Text style={{ fontSize: 11, color: "#F59E0B", fontWeight: "600" }}>
                        {(item as TournamentPending).awaitingMarkerCount} hole{(item as TournamentPending).awaitingMarkerCount === 1 ? "" : "s"} need confirmation
                      </Text>
                    </View>
                  )}
                </View>
                <View style={styles.cardRight}>
                  <Feather name="chevron-right" size={20} color={Colors.muted} />
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* Review Modal */}
      <Modal visible={!!selectedItem} animationType="slide" onRequestClose={closeReview}>
        <SafeAreaView style={styles.modalContainer}>
          {selectedItem && (
            <>
              {/* Modal header */}
              <View style={styles.modalHeader}>
                <TouchableOpacity onPress={closeReview} style={{ padding: 4 }}>
                  <Feather name="x" size={24} color={Colors.text} />
                </TouchableOpacity>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.modalTitle}>
                    {selectedItem.type === "general_play"
                      ? (selectedItem as GeneralPlayPending).courseName ?? "General Play Round"
                      : (selectedItem as TournamentPending).playerName + "'s Scorecard"}
                  </Text>
                  <Text style={styles.modalSubtitle}>
                    {selectedItem.type === "general_play"
                      ? new Date((selectedItem as GeneralPlayPending).round.playedAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
                      : `${(selectedItem as TournamentPending).tournamentName} · Round ${(selectedItem as TournamentPending).round}`}
                  </Text>
                </View>
              </View>

              {/* Total strokes */}
              {selectedItem.type === "tournament" && (
                <View style={styles.totalBanner}>
                  <Text style={styles.totalBannerLabel}>Total Strokes</Text>
                  <Text style={styles.totalBannerValue}>{(selectedItem as TournamentPending).totalStrokes ?? "—"}</Text>
                </View>
              )}

              {/* Hole-by-hole scorecard */}
              <View style={styles.holeHeader}>
                <Text style={[styles.holeHeaderCell, { flex: 0.5 }]}>H</Text>
                <Text style={styles.holeHeaderCell}>Par</Text>
                <Text style={styles.holeHeaderCell}>SI</Text>
                <Text style={styles.holeHeaderCell}>Shots</Text>
                <Text style={styles.holeHeaderCell}>+/-</Text>
              </View>

              <ScrollView style={styles.holeList} showsVerticalScrollIndicator={false}>
                {detailLoading ? (
                  <LoadingSpinner color={GOLD} style={{ marginTop: 40 }} />
                ) : (
                  renderHoles()
                )}
              </ScrollView>

              {/* Dispute controls — general note + submit (per-hole inputs are inline in renderHoles) */}
              {showDisputeInput && (
                <View style={styles.disputeBox}>
                  <Text style={styles.disputeLabel}>Dispute — Add Notes</Text>
                  <Text style={{ fontSize: 11, color: Colors.muted, marginBottom: 8 }}>
                    Enter notes next to specific holes above, and/or add an overall reason below.
                  </Text>
                  <TextInput
                    style={styles.disputeInput}
                    value={disputeGeneralNote}
                    onChangeText={setDisputeGeneralNote}
                    placeholder="Overall reason (optional if hole notes provided)"
                    placeholderTextColor={Colors.muted}
                    multiline
                    numberOfLines={2}
                    textAlignVertical="top"
                  />
                  <View style={styles.disputeActions}>
                    <TouchableOpacity style={styles.cancelSmallBtn} onPress={() => { setShowDisputeInput(false); setHoleDisputeNotes({}); setDisputeGeneralNote(""); }}>
                      <Text style={styles.cancelSmallBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.disputeConfirmBtn, actionLoading && { opacity: 0.6 }]}
                      onPress={handleDispute}
                      disabled={actionLoading}
                    >
                      {actionLoading
                        ? <LoadingSpinner size="small" color="#fff" />
                        : <Text style={styles.disputeConfirmBtnText}>Submit Dispute</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Action buttons */}
              {!showDisputeInput && (
                <View style={styles.actionBar}>
                  <TouchableOpacity
                    style={[styles.disputeActionBtn, actionLoading && { opacity: 0.6 }]}
                    onPress={() => setShowDisputeInput(true)}
                    disabled={actionLoading}
                  >
                    <Feather name="alert-triangle" size={16} color={Colors.error} />
                    <Text style={styles.disputeActionBtnText}>Dispute</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.countersignBtn, actionLoading && { opacity: 0.6 }]}
                    onPress={() => {
                      Alert.alert(
                        "Countersign Scorecard",
                        "By countersigning you confirm that the scores recorded are correct.",
                        [
                          { text: "Cancel", style: "cancel" },
                          { text: "Countersign", onPress: handleCountersign },
                        ],
                      );
                    }}
                    disabled={actionLoading}
                  >
                    {actionLoading
                      ? <LoadingSpinner size="small" color="#000" />
                      : <>
                          <Feather name="check-circle" size={16} color="#000" />
                          <Text style={styles.countersignBtnText}>Countersign</Text>
                        </>}
                  </TouchableOpacity>
                </View>
              )}
            </>
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  title: { flex: 1, fontSize: 22, fontWeight: "700", color: Colors.text },
  badge: { backgroundColor: GOLD, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2, minWidth: 24, alignItems: "center" },
  badgeText: { color: "#000", fontSize: 12, fontWeight: "700" },
  infoBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: `${GOLD}15`, marginHorizontal: 16, borderRadius: 8, padding: 10, marginBottom: 8 },
  infoBannerText: { flex: 1, fontSize: 12, color: GOLD },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: Colors.text, marginTop: 12 },
  emptyText: { fontSize: 14, color: Colors.muted, textAlign: "center", marginTop: 6 },
  card: { backgroundColor: Colors.surface, borderRadius: 12, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: Colors.border, flexDirection: "row", alignItems: "center" },
  cardLeft: { flex: 1 },
  cardRight: {},
  typeTag: { alignSelf: "flex-start", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginBottom: 6 },
  typeTagGP: { backgroundColor: `${GOLD}20` },
  typeTagTour: { backgroundColor: `${Colors.primary}20` },
  typeTagText: { fontSize: 10, fontWeight: "700", color: Colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  cardTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  cardSubtitle: { fontSize: 12, color: Colors.muted, marginTop: 2 },
  cardStrokes: { fontSize: 13, color: Colors.text, fontWeight: "600", marginTop: 4 },
  cardWait: { fontSize: 11, color: Colors.muted, marginTop: 4 },
  // Modal
  modalContainer: { flex: 1, backgroundColor: Colors.background },
  modalHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.border },
  modalTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  modalSubtitle: { fontSize: 12, color: Colors.muted, marginTop: 2 },
  totalBanner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginHorizontal: 16, marginTop: 12, backgroundColor: Colors.surface, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: `${GOLD}30` },
  totalBannerLabel: { color: Colors.muted, fontSize: 13 },
  totalBannerValue: { color: GOLD, fontSize: 22, fontWeight: "700" },
  holeHeader: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 8, backgroundColor: Colors.surface, marginHorizontal: 16, borderRadius: 8, marginTop: 12, marginBottom: 4 },
  holeHeaderCell: { flex: 1, fontSize: 11, fontWeight: "700", color: Colors.muted, textTransform: "uppercase", textAlign: "center" },
  holeList: { flex: 1, marginHorizontal: 16 },
  holeRow: { flexDirection: "row", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border },
  holeRowNum: { flex: 0.5, fontSize: 13, color: Colors.muted, textAlign: "center" },
  holeRowPar: { flex: 1, fontSize: 13, color: Colors.muted, textAlign: "center" },
  holeRowSI: { flex: 1, fontSize: 11, color: Colors.muted, textAlign: "center" },
  holeRowStrokes: { flex: 1, fontSize: 16, fontWeight: "700", color: Colors.text, textAlign: "center" },
  holeRowToPar: { flex: 1, fontSize: 13, fontWeight: "600", textAlign: "center" },
  // Dispute
  disputeBox: { backgroundColor: Colors.surface, margin: 16, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: `${Colors.error}40` },
  disputeLabel: { fontSize: 13, fontWeight: "600", color: Colors.error, marginBottom: 8 },
  disputeInput: { backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, padding: 10, color: Colors.text, fontSize: 14, minHeight: 70 },
  holeNoteInput: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: `${Colors.error}40`, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginHorizontal: 16, marginBottom: 4, color: Colors.text, fontSize: 12 },
  disputeActions: { flexDirection: "row", gap: 10, marginTop: 12 },
  cancelSmallBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, alignItems: "center" },
  cancelSmallBtnText: { color: Colors.text, fontWeight: "600", fontSize: 13 },
  disputeConfirmBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: Colors.error, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 6 },
  disputeConfirmBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  // Action bar
  actionBar: { flexDirection: "row", gap: 12, padding: 16, borderTopWidth: 1, borderTopColor: Colors.border },
  disputeActionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: `${Colors.error}60` },
  disputeActionBtnText: { color: Colors.error, fontWeight: "700", fontSize: 15 },
  countersignBtn: { flex: 2, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 12, backgroundColor: GOLD },
  countersignBtnText: { color: "#000", fontWeight: "700", fontSize: 15 },
});
