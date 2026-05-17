/**
 * ShotReviewModal — per-hole shot review sheet shown from the score screen.
 *
 * Extracted from `app/(tabs)/score.tsx` so the "Add Shot" flow added in
 * Task #519 can be exercised in isolation by automated tests (Task #649)
 * without dragging in the full scoring screen's expo-camera / expo-location /
 * background-task imports.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { fetchPortal, postPortal, patchPortal, deletePortal } from "@/utils/api";

export interface ServerShot {
  id: number;
  round: number;
  holeNumber: number;
  shotNumber: number;
  shotType: string;
  club: string | null;
  lieType: string | null;
  missDirection: string | null;
  shotShape: string | null;
  penaltyReason: string | null;
  distanceToPin: string | null;
}

export interface ShotReviewModalProps {
  visible: boolean;
  onClose: () => void;
  token: string | null;
  tournamentId: number;
  round: number;
  holeNumber: number;
  onMutated: () => void;
}

export default function ShotReviewModal({ visible, onClose, token, tournamentId, round, holeNumber, onMutated }: ShotReviewModalProps) {
  const [shots, setShots] = useState<ServerShot[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editClub, setEditClub] = useState<string>("");
  const [editShotType, setEditShotType] = useState<string>("");
  const [editLie, setEditLie] = useState<string>("");
  const [editMiss, setEditMiss] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newShotNumber, setNewShotNumber] = useState<string>("");
  const [newShotType, setNewShotType] = useState<string>("fairway");
  const [newClub, setNewClub] = useState<string>("");
  const [newLie, setNewLie] = useState<string>("");
  const [newMiss, setNewMiss] = useState<string>("");

  const fetchShots = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetchPortal<Array<{ hole: number; shots: ServerShot[] }>>(
        `/rounds/${round}/shots?tournamentId=${tournamentId}`,
        token,
      );
      const found = res.find(g => g.hole === holeNumber);
      setShots(found?.shots ?? []);
    } catch {
      setShots([]);
    } finally {
      setLoading(false);
    }
  }, [token, tournamentId, round, holeNumber]);

  useEffect(() => {
    if (visible) fetchShots();
  }, [visible, fetchShots]);

  const startEdit = (s: ServerShot) => {
    setEditingId(s.id);
    setEditClub(s.club ?? "");
    setEditShotType(s.shotType ?? "");
    setEditLie(s.lieType ?? "");
    setEditMiss(s.missDirection ?? "");
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = async (id: number) => {
    if (!token) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      body.club = editClub.trim() === "" ? null : editClub.trim();
      body.lieType = editLie.trim() === "" ? null : editLie.trim();
      body.missDirection = editMiss.trim() === "" ? null : editMiss.trim();
      if (editShotType) body.shotType = editShotType;
      await patchPortal(`/shots/${id}`, token, body);
      setEditingId(null);
      await fetchShots();
      onMutated();
    } catch (e: unknown) {
      Alert.alert("Edit failed", e instanceof Error ? e.message : "Could not update shot.");
    } finally {
      setBusy(false);
    }
  };

  const startAdd = () => {
    const nextNum = shots.reduce((m, s) => Math.max(m, s.shotNumber), 0) + 1;
    setNewShotNumber(String(nextNum));
    setNewShotType("fairway");
    setNewClub("");
    setNewLie("");
    setNewMiss("");
    setEditingId(null);
    setAdding(true);
  };

  const cancelAdd = () => setAdding(false);

  const saveAdd = async () => {
    if (!token) return;
    const shotNumber = parseInt(newShotNumber, 10);
    if (!Number.isFinite(shotNumber) || shotNumber < 1) {
      Alert.alert("Invalid shot #", "Shot number must be 1 or higher.");
      return;
    }
    if (!newShotType.trim()) {
      Alert.alert("Missing shot type", "Pick a shot type (tee, fairway, approach, chip, sand, putt).");
      return;
    }
    setBusy(true);
    try {
      await postPortal("/shots/manual", token, {
        tournamentId,
        round,
        holeNumber,
        shotNumber,
        shotType: newShotType.trim(),
        club: newClub.trim() || undefined,
        lieType: newLie.trim() || undefined,
        missDirection: newMiss.trim() || undefined,
      });
      setAdding(false);
      await fetchShots();
      onMutated();
    } catch (e: unknown) {
      Alert.alert("Add failed", e instanceof Error ? e.message : "Could not add shot.");
    } finally {
      setBusy(false);
    }
  };

  const deleteShot = (id: number) => {
    Alert.alert("Delete shot?", "Remaining shots on this hole will be renumbered.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          if (!token) return;
          setBusy(true);
          try {
            await deletePortal(`/shots/${id}`, token);
            await fetchShots();
            onMutated();
          } catch (e: unknown) {
            Alert.alert("Delete failed", e instanceof Error ? e.message : "Could not delete shot.");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.reviewModalBg}>
        <View style={styles.reviewModalCard}>
          <View style={styles.reviewModalHeader}>
            <Text style={styles.reviewModalTitle}>Hole {holeNumber} · Shots</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Feather name="x" size={20} color={Colors.text} />
            </Pressable>
          </View>
          {!adding && (
            <Pressable onPress={startAdd} style={styles.reviewAddBtn} disabled={busy || loading} accessibilityLabel="Add Shot">
              <Feather name="plus" size={14} color={Colors.primary} />
              <Text style={styles.reviewAddBtnText}>Add Shot</Text>
            </Pressable>
          )}
          {adding && (
            <View style={styles.reviewAddCard}>
              <Text style={styles.reviewAddTitle}>New shot</Text>
              <View style={styles.reviewEditRow}>
                <Text style={styles.reviewEditLabel}>Shot #</Text>
                <TextInput
                  value={newShotNumber}
                  onChangeText={setNewShotNumber}
                  style={styles.reviewInput}
                  keyboardType="number-pad"
                  placeholder="e.g. 2"
                  placeholderTextColor={Colors.muted}
                  accessibilityLabel="New shot number"
                />
              </View>
              <View style={styles.reviewEditRow}>
                <Text style={styles.reviewEditLabel}>Type</Text>
                <TextInput
                  value={newShotType}
                  onChangeText={setNewShotType}
                  style={styles.reviewInput}
                  placeholder="tee/fairway/approach/chip/sand/putt"
                  placeholderTextColor={Colors.muted}
                  autoCapitalize="none"
                  accessibilityLabel="New shot type"
                />
              </View>
              <View style={styles.reviewEditRow}>
                <Text style={styles.reviewEditLabel}>Club</Text>
                <TextInput value={newClub} onChangeText={setNewClub} style={styles.reviewInput} placeholder="e.g. 7I" placeholderTextColor={Colors.muted} accessibilityLabel="New shot club" />
              </View>
              <View style={styles.reviewEditRow}>
                <Text style={styles.reviewEditLabel}>Lie</Text>
                <TextInput value={newLie} onChangeText={setNewLie} style={styles.reviewInput} placeholder="Tee/Fairway/Rough/Bunker/Hazard/Green" placeholderTextColor={Colors.muted} accessibilityLabel="New shot lie" />
              </View>
              <View style={styles.reviewEditRow}>
                <Text style={styles.reviewEditLabel}>Miss</Text>
                <TextInput value={newMiss} onChangeText={setNewMiss} style={styles.reviewInput} placeholder="Left/Right/Short/Long/On Target" placeholderTextColor={Colors.muted} accessibilityLabel="New shot miss" />
              </View>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                <Pressable onPress={saveAdd} disabled={busy} style={[styles.reviewSaveBtn, busy && { opacity: 0.5 }]} accessibilityLabel="Save new shot">
                  <Text style={styles.reviewSaveBtnText}>Save</Text>
                </Pressable>
                <Pressable onPress={cancelAdd} style={styles.reviewCancelBtn} accessibilityLabel="Cancel new shot">
                  <Text style={styles.reviewCancelBtnText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          )}
          {loading ? (
            <View style={{ paddingVertical: 24, alignItems: "center" }}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : shots.length === 0 ? (
            <Text style={styles.reviewEmpty}>No shots tracked on this hole yet.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 420 }}>
              {shots.map(s => {
                const isEditing = editingId === s.id;
                return (
                  <View key={s.id} style={styles.reviewShotRow}>
                    <View style={styles.reviewShotNum}>
                      <Text style={styles.reviewShotNumText}>{s.shotNumber}</Text>
                    </View>
                    {isEditing ? (
                      <View style={{ flex: 1, gap: 6 }}>
                        <View style={styles.reviewEditRow}>
                          <Text style={styles.reviewEditLabel}>Type</Text>
                          <TextInput
                            value={editShotType}
                            onChangeText={setEditShotType}
                            placeholder="tee/fairway/approach/chip/sand/putt"
                            placeholderTextColor={Colors.muted}
                            style={styles.reviewInput}
                            autoCapitalize="none"
                          />
                        </View>
                        <View style={styles.reviewEditRow}>
                          <Text style={styles.reviewEditLabel}>Club</Text>
                          <TextInput value={editClub} onChangeText={setEditClub} style={styles.reviewInput} placeholder="e.g. 7I" placeholderTextColor={Colors.muted} />
                        </View>
                        <View style={styles.reviewEditRow}>
                          <Text style={styles.reviewEditLabel}>Lie</Text>
                          <TextInput value={editLie} onChangeText={setEditLie} style={styles.reviewInput} placeholder="Tee/Fairway/Rough/Bunker/Hazard/Green" placeholderTextColor={Colors.muted} />
                        </View>
                        <View style={styles.reviewEditRow}>
                          <Text style={styles.reviewEditLabel}>Miss</Text>
                          <TextInput value={editMiss} onChangeText={setEditMiss} style={styles.reviewInput} placeholder="Left/Right/Short/Long/On Target" placeholderTextColor={Colors.muted} />
                        </View>
                        <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                          <Pressable onPress={() => saveEdit(s.id)} disabled={busy} style={[styles.reviewSaveBtn, busy && { opacity: 0.5 }]}>
                            <Text style={styles.reviewSaveBtnText}>Save</Text>
                          </Pressable>
                          <Pressable onPress={cancelEdit} style={styles.reviewCancelBtn}>
                            <Text style={styles.reviewCancelBtnText}>Cancel</Text>
                          </Pressable>
                        </View>
                      </View>
                    ) : (
                      <View style={{ flex: 1 }}>
                        <Text style={styles.reviewShotMain}>
                          {s.shotType.toUpperCase()}{s.club ? ` · ${s.club}` : ""}
                        </Text>
                        <Text style={styles.reviewShotMeta}>
                          {[s.lieType, s.missDirection, s.distanceToPin ? `${Math.round(parseFloat(s.distanceToPin))}m to pin` : null].filter(Boolean).join(" · ") || "—"}
                        </Text>
                      </View>
                    )}
                    {!isEditing && (
                      <View style={{ flexDirection: "row", gap: 4 }}>
                        <Pressable onPress={() => startEdit(s)} style={styles.reviewIconBtn} hitSlop={6}>
                          <Feather name="edit-2" size={14} color={Colors.primary} />
                        </Pressable>
                        <Pressable onPress={() => deleteShot(s.id)} style={styles.reviewIconBtn} hitSlop={6} disabled={busy}>
                          <Feather name="trash-2" size={14} color={Colors.bogey} />
                        </Pressable>
                      </View>
                    )}
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  reviewModalBg: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  reviewModalCard: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 28,
    gap: 10,
    maxHeight: "85%",
  },
  reviewModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  reviewModalTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    color: Colors.text,
  },
  reviewEmpty: {
    paddingVertical: 24,
    textAlign: "center",
    color: Colors.muted,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  reviewShotRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  reviewShotNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.primary + "20",
    alignItems: "center",
    justifyContent: "center",
  },
  reviewShotNumText: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
    color: Colors.primary,
  },
  reviewShotMain: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: Colors.text,
  },
  reviewShotMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: Colors.muted,
    marginTop: 2,
  },
  reviewIconBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  reviewEditRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  reviewEditLabel: {
    width: 44,
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: Colors.muted,
  },
  reviewInput: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: Colors.text,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  reviewSaveBtn: {
    flex: 1,
    backgroundColor: Colors.primary,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: "center",
  },
  reviewSaveBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
    color: "#000",
  },
  reviewCancelBtn: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: "center",
  },
  reviewCancelBtnText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    color: Colors.textSecondary,
  },
  reviewAddBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: Colors.primary + "15",
  },
  reviewAddBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
    color: Colors.primary,
  },
  reviewAddCard: {
    gap: 6,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  reviewAddTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: Colors.text,
    marginBottom: 2,
  },
});
