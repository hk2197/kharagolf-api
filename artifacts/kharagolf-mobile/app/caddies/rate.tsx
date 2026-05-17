/**
 * Post-round caddie rating + tip screen
 * Route: /caddies/rate?assignmentId=X&orgId=Y
 */
import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";
import { PriceWithFx } from "@/components/PriceWithFx";

const GOLD = "#C9A84C";

export default function CaddieRateScreen() {
  const { token } = useAuth();
  const { activeClub } = useActiveClub();
  const orgId = useActiveClub().activeClub?.id;
  const { assignmentId, caddieName } = useLocalSearchParams<{ assignmentId: string; caddieName?: string }>();
  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : "";

  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [tip, setTip] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function submit() {
    if (!orgId || !token || !assignmentId) return;
    if (rating === 0) { Alert.alert("Rating required", "Please select a star rating before submitting."); return; }

    setSubmitting(true);
    try {
      // Submit rating
      const rateRes = await fetch(`${baseUrl}/api/organizations/${orgId}/caddie-assignments/${assignmentId}/rate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment: comment.trim() || undefined }),
      });
      if (!rateRes.ok) {
        const err = await rateRes.json().catch(() => ({}));
        Alert.alert("Error", err.error ?? "Could not submit rating.");
        return;
      }

      // Submit tip if provided
      if (tip && parseFloat(tip) > 0) {
        await fetch(`${baseUrl}/api/organizations/${orgId}/caddie-assignments/${assignmentId}/tip`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ tipAmount: parseFloat(tip) }),
        });
      }

      setSubmitted(true);
    } catch {
      Alert.alert("Error", "Failed to submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Feather name="check-circle" size={56} color="#22c55e" />
          <Text style={styles.successTitle}>Thank you!</Text>
          <Text style={styles.successSub}>Your rating has been submitted.</Text>
          <TouchableOpacity style={styles.doneBtn} onPress={() => router.back()}>
            <Text style={styles.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Rate Your Caddie</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.caddieLabel}>
          {caddieName ? `Rating for ${decodeURIComponent(caddieName)}` : "Rate your caddie experience"}
        </Text>

        {/* Star Rating */}
        <View style={styles.starsContainer}>
          {[1, 2, 3, 4, 5].map(i => (
            <TouchableOpacity key={i} onPress={() => setRating(i)} style={styles.starBtn}>
              <Feather
                name="star"
                size={40}
                color={i <= rating ? GOLD : "rgba(255,255,255,0.2)"}
                style={i <= rating ? styles.starFilled : undefined}
              />
            </TouchableOpacity>
          ))}
        </View>
        {rating > 0 && (
          <Text style={styles.ratingLabel}>
            {["", "Poor", "Fair", "Good", "Very Good", "Excellent"][rating]}
          </Text>
        )}

        {/* Comment */}
        <View style={styles.field}>
          <Text style={styles.label}>Comment (optional)</Text>
          <TextInput
            style={styles.textarea}
            value={comment}
            onChangeText={setComment}
            multiline
            numberOfLines={3}
            placeholder="Share your experience..."
            placeholderTextColor="rgba(255,255,255,0.3)"
          />
        </View>

        {/* Tip */}
        <View style={styles.field}>
          <Text style={styles.label}>Tip Amount (optional)</Text>
          <View style={styles.tipRow}>
            <Text style={styles.currency}>₹</Text>
            <TextInput
              style={styles.tipInput}
              value={tip}
              onChangeText={setTip}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor="rgba(255,255,255,0.3)"
            />
          </View>
          {tip && parseFloat(tip) > 0 && orgId ? (
            <View style={styles.tipFx}>
              <PriceWithFx
                orgId={orgId}
                token={token}
                amount={parseFloat(tip)}
                currency="INR"
                productClass="caddie_fee"
                bookedStyle={styles.tipFxBooked}
                disclosureStyle={styles.tipFxDisclosure}
              />
            </View>
          ) : null}
          <Text style={styles.tipHint}>Tips go directly to your caddie.</Text>
        </View>

        <TouchableOpacity style={[styles.submitBtn, submitting && styles.submitDisabled]} onPress={submit} disabled={submitting}>
          {submitting
            ? <LoadingSpinner color="#000" size="small" />
            : <Text style={styles.submitText}>Submit Rating</Text>
          }
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background ?? "#0f1117" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  successTitle: { fontSize: 24, fontWeight: "700", color: "#fff", marginTop: 8 },
  successSub: { fontSize: 14, color: "rgba(255,255,255,0.5)" },
  doneBtn: { backgroundColor: GOLD, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 40, marginTop: 16 },
  doneBtnText: { color: "#000", fontWeight: "700", fontSize: 16 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  backBtn: { padding: 4, marginRight: 12 },
  headerTitle: { fontSize: 18, fontWeight: "700", color: "#fff" },
  scroll: { padding: 24, paddingBottom: 40 },
  caddieLabel: { color: "rgba(255,255,255,0.6)", fontSize: 14, marginBottom: 24, textAlign: "center" },
  starsContainer: { flexDirection: "row", justifyContent: "center", gap: 12, marginBottom: 8 },
  starBtn: { padding: 4 },
  starFilled: { transform: [{ scale: 1.1 }] },
  ratingLabel: { color: GOLD, fontSize: 14, fontWeight: "600", textAlign: "center", marginBottom: 24 },
  field: { marginBottom: 20 },
  label: { color: "rgba(255,255,255,0.6)", fontSize: 13, marginBottom: 8 },
  textarea: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 10, padding: 12, color: "#fff", fontSize: 14,
    minHeight: 80, textAlignVertical: "top",
  },
  tipRow: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", borderRadius: 10, paddingHorizontal: 12 },
  currency: { color: "rgba(255,255,255,0.4)", fontSize: 16, marginRight: 4 },
  tipInput: { flex: 1, color: "#fff", fontSize: 16, paddingVertical: 12 },
  tipHint: { color: "rgba(255,255,255,0.3)", fontSize: 11, marginTop: 4 },
  tipFx: { marginTop: 6 },
  tipFxBooked: { color: "#fff", fontSize: 13, fontWeight: "600" },
  tipFxDisclosure: { color: "rgba(255,255,255,0.5)", fontSize: 11 },
  submitBtn: { backgroundColor: GOLD, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 8 },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: "#000", fontWeight: "700", fontSize: 16 },
});
