import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import Colors from "@/constants/colors";
import { fetchPublic, postPublic } from "@/utils/api";

type Recommendation = "confirm" | "dispute" | "insufficient_info";

interface PeerReviewInfo {
  expired: boolean;
  alreadyResponded: boolean;
  invitedAt: string;
  respondedAt: string | null;
  recommendation: Recommendation | null;
  comment: string | null;
  case: {
    kind: string;
    status: string;
    details: string | null;
    periodLabel: string | null;
    subjectName: string | null;
    orgName: string | null;
  };
}

const KIND_LABEL: Record<string, string> = {
  anomalous: "Anomalous Score Review",
  not_posted: "Score Not Posted",
  exceptional: "Exceptional Score Review",
  annual: "Annual Handicap Review",
};

const OPTIONS: { v: Recommendation; label: string; icon: keyof typeof Feather.glyphMap; color: string }[] = [
  { v: "confirm", label: "Confirm", icon: "check-circle", color: "#22c55e" },
  { v: "dispute", label: "Dispute", icon: "x-circle", color: "#ef4444" },
  { v: "insufficient_info", label: "Need more info", icon: "alert-circle", color: "#94b4a4" },
];

export default function PeerReviewScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();

  const [info, setInfo] = useState<PeerReviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | "">("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchPublic<PeerReviewInfo>(`/peer-review/${token}`);
      setInfo(data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Invalid or expired link");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function submit() {
    if (!recommendation || !comment.trim()) return;
    setSubmitting(true);
    try {
      await postPublic(`/peer-review/${token}`, { recommendation, comment: comment.trim() });
      setSubmitted(true);
      Alert.alert("Thank you", "Your peer review has been recorded.");
    } catch (e) {
      Alert.alert("Submit failed", e instanceof Error ? e.message : "Please try again");
    } finally {
      setSubmitting(false);
    }
  }

  const alreadyResponded = !!info && (info.alreadyResponded || info.expired || submitted);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 4 }}>
          <Feather name="chevron-left" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Feather name="shield" size={20} color="#3b82f6" />
        <Text style={styles.title}>Handicap Peer Review</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {loading ? (
          <LoadingSpinner color={Colors.primary} style={{ marginTop: 60 }} />
        ) : loadError ? (
          <View style={styles.card}>
            <View style={styles.centerBlock}>
              <Feather name="alert-circle" size={36} color={Colors.error} />
              <Text style={styles.statusTitle}>Link is invalid or expired</Text>
              <Text style={styles.statusSub}>{loadError}</Text>
            </View>
          </View>
        ) : info ? (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{KIND_LABEL[info.case.kind] ?? info.case.kind}</Text>
              <Text style={styles.row}>
                <Text style={styles.muted}>Player: </Text>
                <Text style={styles.strong}>{info.case.subjectName ?? "—"}</Text>
              </Text>
              <Text style={styles.row}>
                <Text style={styles.muted}>Club: </Text>
                <Text style={styles.text}>{info.case.orgName ?? "—"}</Text>
              </Text>
              {info.case.periodLabel ? (
                <Text style={styles.row}>
                  <Text style={styles.muted}>Period: </Text>
                  <Text style={styles.text}>{info.case.periodLabel}</Text>
                </Text>
              ) : null}
              {info.case.details ? (
                <View style={styles.detailsBox}>
                  <Text style={styles.text}>{info.case.details}</Text>
                </View>
              ) : null}
              <Text style={styles.metaSmall}>
                Invited {new Date(info.invitedAt).toLocaleString()}
                {info.respondedAt ? ` · Responded ${new Date(info.respondedAt).toLocaleString()}` : ""}
              </Text>
            </View>

            {info.expired && !info.alreadyResponded ? (
              <View style={styles.card}>
                <View style={styles.centerBlock}>
                  <Feather name="alert-circle" size={36} color="#f59e0b" />
                  <Text style={styles.statusTitle}>This invitation has expired</Text>
                  <Text style={styles.statusSub}>
                    Please contact the handicap committee to request a new invitation.
                  </Text>
                </View>
              </View>
            ) : alreadyResponded ? (
              <View style={styles.card}>
                <View style={styles.centerBlock}>
                  <Feather name="check-circle" size={36} color="#22c55e" />
                  <Text style={styles.statusTitle}>Your response has been recorded</Text>
                  {info.recommendation ? (
                    <Text style={styles.statusSub}>
                      Recommendation: <Text style={styles.strong}>{info.recommendation.replace("_", " ")}</Text>
                    </Text>
                  ) : null}
                  {info.comment ? (
                    <Text style={[styles.statusSub, { fontStyle: "italic" }]}>"{info.comment}"</Text>
                  ) : null}
                  <Text style={styles.metaSmall}>
                    You can close this page. The committee has been notified.
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Your peer perspective</Text>

                <Text style={styles.label}>
                  Do you agree with the committee's concern? <Text style={{ color: Colors.error }}>*</Text>
                </Text>
                <View style={styles.optionsRow}>
                  {OPTIONS.map(opt => {
                    const selected = recommendation === opt.v;
                    return (
                      <TouchableOpacity
                        key={opt.v}
                        onPress={() => setRecommendation(opt.v)}
                        style={[
                          styles.option,
                          { borderColor: selected ? opt.color : Colors.border, backgroundColor: selected ? `${opt.color}22` : "transparent" },
                        ]}
                      >
                        <Feather name={opt.icon} size={16} color={opt.color} />
                        <Text style={[styles.optionLabel, { color: selected ? opt.color : Colors.text }]}>
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={[styles.label, { marginTop: 16 }]}>
                  Comments <Text style={{ color: Colors.error }}>*</Text>
                </Text>
                <TextInput
                  value={comment}
                  onChangeText={setComment}
                  multiline
                  numberOfLines={5}
                  placeholder="Share your perspective. The committee will read your comment as part of their review."
                  placeholderTextColor={Colors.muted}
                  style={styles.textarea}
                  textAlignVertical="top"
                />

                <TouchableOpacity
                  disabled={submitting || !recommendation || !comment.trim()}
                  onPress={submit}
                  style={[
                    styles.submit,
                    (submitting || !recommendation || !comment.trim()) && { opacity: 0.5 },
                  ]}
                >
                  {submitting ? (
                    <LoadingSpinner color="#fff" />
                  ) : (
                    <Text style={styles.submitText}>Submit Peer Review</Text>
                  )}
                </TouchableOpacity>

                <Text style={styles.metaSmall}>
                  Your response is recorded in the case audit log and visible to the committee.
                </Text>
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  title: { flex: 1, fontSize: 20, fontWeight: "700", color: Colors.text },
  scroll: { flex: 1 },
  card: { backgroundColor: Colors.surface, borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: Colors.border },
  cardTitle: { color: Colors.text, fontSize: 16, fontWeight: "700", marginBottom: 10 },
  row: { color: Colors.text, fontSize: 14, marginBottom: 4 },
  muted: { color: Colors.muted },
  text: { color: Colors.text },
  strong: { color: Colors.text, fontWeight: "700" },
  detailsBox: { backgroundColor: Colors.card, borderRadius: 8, padding: 10, marginTop: 8 },
  metaSmall: { color: Colors.muted, fontSize: 11, marginTop: 10, textAlign: "center" },
  centerBlock: { alignItems: "center", gap: 8, paddingVertical: 8 },
  statusTitle: { color: Colors.text, fontSize: 15, fontWeight: "600", textAlign: "center" },
  statusSub: { color: Colors.muted, fontSize: 13, textAlign: "center" },
  label: { color: Colors.text, fontSize: 13, fontWeight: "600", marginBottom: 8 },
  optionsRow: { flexDirection: "row", gap: 8 },
  option: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, paddingHorizontal: 8, borderWidth: 1, borderRadius: 8 },
  optionLabel: { fontSize: 12, fontWeight: "600" },
  textarea: { borderWidth: 1, borderColor: Colors.border, borderRadius: 8, padding: 10, color: Colors.text, backgroundColor: Colors.card, minHeight: 110, fontSize: 14 },
  submit: { backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 14 },
  submitText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
