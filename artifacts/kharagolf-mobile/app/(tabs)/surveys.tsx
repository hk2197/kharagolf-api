import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Alert,
  TextInput,
  Platform,
  Modal,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { useFocusEffect } from "expo-router";
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

function formatDate(d: string | null | undefined) {
  if (!d) return "";
  return new Date(d).toLocaleDateString(getLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

type QuestionType = "rating" | "multiple_choice" | "free_text" | "nps";

interface SurveyListItem {
  id: number;
  title: string;
  description: string | null;
  trigger: string;
  isAnonymous: boolean;
  publishedAt: string | null;
  hasResponded: boolean;
}

interface SurveyQuestion {
  id: number;
  type: QuestionType;
  questionText: string;
  isRequired: boolean;
  sortOrder: number;
  options: string[];
  ratingMin: number;
  ratingMax: number;
}

interface AnswerValue {
  questionId: number;
  ratingValue?: number;
  choiceValue?: string;
  textValue?: string;
  npsScore?: number;
}

interface SurveyFormProps {
  orgId: number;
  surveyId: number;
  title: string;
  description: string | null;
  isAnonymous: boolean;
  questions: SurveyQuestion[];
  onClose: () => void;
  onSubmitted: () => void;
}

function RatingInput({
  question,
  value,
  onChange,
}: {
  question: SurveyQuestion;
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  const options = [];
  for (let i = question.ratingMin; i <= question.ratingMax; i++) {
    options.push(i);
  }
  return (
    <View style={styles.ratingRow}>
      {options.map((v) => (
        <TouchableOpacity
          key={v}
          style={[styles.ratingBtn, value === v && styles.ratingBtnActive]}
          onPress={() => onChange(v)}
        >
          <Text style={[styles.ratingBtnText, value === v && styles.ratingBtnTextActive]}>{v}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function NpsInput({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  return (
    <View>
      <View style={styles.npsRow}>
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => (
          <TouchableOpacity
            key={v}
            style={[
              styles.npsBtn,
              value === v && styles.npsBtnActive,
              v >= 9 ? styles.npsBtnPromoter : v >= 7 ? styles.npsBtnPassive : styles.npsBtnDetractor,
              value === v && styles.npsBtnSelected,
            ]}
            onPress={() => onChange(v)}
          >
            <Text style={[styles.npsBtnText, value === v && styles.npsBtnTextActive]}>{v}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.npsLabels}>
        <Text style={styles.npsLabel}>Not likely</Text>
        <Text style={styles.npsLabel}>Very likely</Text>
      </View>
    </View>
  );
}

function SurveyForm({
  orgId, surveyId, title, description, isAnonymous, questions, onClose, onSubmitted,
}: SurveyFormProps) {
  const [answers, setAnswers] = useState<Record<number, AnswerValue>>({});
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState(0);

  const currentQuestion = questions[step];
  const isLastStep = step === questions.length - 1;

  const setAnswer = (qId: number, update: Partial<AnswerValue>) => {
    setAnswers(prev => ({
      ...prev,
      [qId]: { ...prev[qId], questionId: qId, ...update },
    }));
  };

  const canProceed = () => {
    if (!currentQuestion.isRequired) return true;
    const a = answers[currentQuestion.id];
    if (!a) return false;
    if (currentQuestion.type === "rating") return a.ratingValue !== undefined;
    if (currentQuestion.type === "nps") return a.npsScore !== undefined;
    if (currentQuestion.type === "multiple_choice") return !!a.choiceValue;
    if (currentQuestion.type === "free_text") return !!(a.textValue?.trim());
    return false;
  };

  const handleSubmit = async () => {
    const requiredUnanswered = questions.filter(q => {
      if (!q.isRequired) return false;
      const a = answers[q.id];
      if (!a) return true;
      if (q.type === "rating") return a.ratingValue === undefined;
      if (q.type === "nps") return a.npsScore === undefined;
      if (q.type === "multiple_choice") return !a.choiceValue;
      if (q.type === "free_text") return !a.textValue?.trim();
      return false;
    });

    if (requiredUnanswered.length > 0) {
      Alert.alert("Please answer all required questions");
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch(`/organizations/${orgId}/surveys/respond/${surveyId}`, {
        method: "POST",
        body: JSON.stringify({
          answers: Object.values(answers),
          isAnonymous,
        }),
      });
      Alert.alert("Thank you!", "Your feedback has been submitted.", [
        { text: "OK", onPress: onSubmitted },
      ]);
    } catch (e: unknown) {
      Alert.alert("Error", e instanceof Error ? e.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet">
      <View style={styles.formContainer}>
        {/* Header */}
        <View style={styles.formHeader}>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Feather name="x" size={22} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.formTitle} numberOfLines={1}>{title}</Text>
          <Text style={styles.formProgress}>{step + 1}/{questions.length}</Text>
        </View>

        {/* Progress bar */}
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${((step + 1) / questions.length) * 100}%` as `${number}%` }]} />
        </View>

        <ScrollView style={styles.formScroll} contentContainerStyle={styles.formScrollContent}>
          <Text style={styles.questionText}>
            {currentQuestion.questionText}
            {currentQuestion.isRequired && <Text style={styles.required}> *</Text>}
          </Text>

          {currentQuestion.type === "rating" && (
            <RatingInput
              question={currentQuestion}
              value={answers[currentQuestion.id]?.ratingValue}
              onChange={(v) => setAnswer(currentQuestion.id, { ratingValue: v })}
            />
          )}

          {currentQuestion.type === "nps" && (
            <NpsInput
              value={answers[currentQuestion.id]?.npsScore}
              onChange={(v) => setAnswer(currentQuestion.id, { npsScore: v })}
            />
          )}

          {currentQuestion.type === "multiple_choice" && (
            <View style={styles.choicesContainer}>
              {currentQuestion.options.map((opt) => {
                const selected = answers[currentQuestion.id]?.choiceValue === opt;
                return (
                  <TouchableOpacity
                    key={opt}
                    style={[styles.choiceBtn, selected && styles.choiceBtnActive]}
                    onPress={() => setAnswer(currentQuestion.id, { choiceValue: opt })}
                  >
                    <View style={[styles.radioCircle, selected && styles.radioCircleSelected]}>
                      {selected && <View style={styles.radioDot} />}
                    </View>
                    <Text style={[styles.choiceText, selected && styles.choiceTextActive]}>{opt}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {currentQuestion.type === "free_text" && (
            <TextInput
              style={styles.textInput}
              multiline
              numberOfLines={4}
              placeholder="Type your answer here..."
              placeholderTextColor={Colors.textSecondary}
              value={answers[currentQuestion.id]?.textValue ?? ""}
              onChangeText={(v) => setAnswer(currentQuestion.id, { textValue: v })}
            />
          )}
        </ScrollView>

        {/* Navigation */}
        <View style={styles.navRow}>
          {step > 0 && (
            <TouchableOpacity style={styles.backBtn} onPress={() => setStep(s => s - 1)}>
              <Feather name="arrow-left" size={18} color={Colors.textSecondary} />
              <Text style={styles.backBtnText}>Back</Text>
            </TouchableOpacity>
          )}
          <View style={{ flex: 1 }} />
          {isLastStep ? (
            <TouchableOpacity
              style={[styles.nextBtn, !canProceed() && styles.nextBtnDisabled]}
              onPress={handleSubmit}
              disabled={!canProceed() || submitting}
            >
              {submitting ? (
                <LoadingSpinner color="#fff" size="small" />
              ) : (
                <>
                  <Text style={styles.nextBtnText}>Submit</Text>
                  <Feather name="check" size={16} color="#fff" />
                </>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.nextBtn, !canProceed() && styles.nextBtnDisabled]}
              onPress={() => setStep(s => s + 1)}
              disabled={!canProceed()}
            >
              <Text style={styles.nextBtnText}>Next</Text>
              <Feather name="arrow-right" size={16} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function SurveysScreen() {
  const { user } = useAuth();
  const orgId = user?.organizationId;

  const [surveys, setSurveys] = useState<SurveyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeSurvey, setActiveSurvey] = useState<{
    id: number;
    title: string;
    description: string | null;
    isAnonymous: boolean;
    questions: SurveyQuestion[];
  } | null>(null);

  const fetchSurveys = useCallback(async () => {
    if (!orgId) return;
    try {
      const data = await apiFetch(`/organizations/${orgId}/surveys/active`);
      setSurveys(data.surveys ?? []);
    } catch (e) {
      console.error("Surveys fetch error:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orgId]);

  useFocusEffect(useCallback(() => { fetchSurveys(); }, [fetchSurveys]));

  const handleOpenSurvey = async (survey: SurveyListItem) => {
    if (survey.hasResponded) {
      Alert.alert("Already completed", "You have already responded to this survey.");
      return;
    }
    try {
      const data = await apiFetch(`/organizations/${orgId}/surveys/respond/${survey.id}`);
      setActiveSurvey({
        id: survey.id,
        title: survey.title,
        description: survey.description,
        isAnonymous: survey.isAnonymous,
        questions: data.questions ?? [],
      });
    } catch (e: unknown) {
      Alert.alert("Error", e instanceof Error ? e.message : "Could not load survey");
    }
  };

  const handleSurveySubmitted = () => {
    setActiveSurvey(null);
    fetchSurveys();
  };

  const onRefresh = () => {
    setRefreshing(true);
    fetchSurveys();
  };

  if (!orgId) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>Please log in to view surveys.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Feather name="clipboard" size={22} color={Colors.primary} />
        <Text style={styles.headerTitle}>Surveys & Feedback</Text>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <LoadingSpinner color={Colors.primary} size="large" />
        </View>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        >
          {surveys.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Feather name="clipboard" size={48} color={Colors.border} />
              <Text style={styles.emptyTitle}>No active surveys</Text>
              <Text style={styles.emptyText}>Check back later for new surveys from your club.</Text>
            </View>
          ) : (
            surveys.map((s) => (
              <TouchableOpacity
                key={s.id}
                style={[styles.card, s.hasResponded && styles.cardCompleted]}
                onPress={() => handleOpenSurvey(s)}
                activeOpacity={0.7}
              >
                <View style={styles.cardRow}>
                  <View style={styles.cardIcon}>
                    <Feather
                      name={s.hasResponded ? "check-circle" : "clipboard"}
                      size={20}
                      color={s.hasResponded ? "#4ade80" : Colors.primary}
                    />
                  </View>
                  <View style={styles.cardContent}>
                    <Text style={styles.cardTitle}>{s.title}</Text>
                    {s.description && <Text style={styles.cardDesc} numberOfLines={2}>{s.description}</Text>}
                    <View style={styles.cardMeta}>
                      {s.isAnonymous && (
                        <View style={styles.tag}>
                          <Feather name="eye-off" size={10} color={Colors.textSecondary} />
                          <Text style={styles.tagText}>Anonymous</Text>
                        </View>
                      )}
                      {s.publishedAt && (
                        <Text style={styles.cardDate}>{formatDate(s.publishedAt)}</Text>
                      )}
                    </View>
                    {s.hasResponded ? (
                      <Text style={styles.completedLabel}>Completed</Text>
                    ) : (
                      <Text style={styles.pendingLabel}>Tap to respond</Text>
                    )}
                  </View>
                  {!s.hasResponded && (
                    <Feather name="chevron-right" size={18} color={Colors.textSecondary} />
                  )}
                </View>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      )}

      {activeSurvey && (
        <SurveyForm
          orgId={orgId}
          surveyId={activeSurvey.id}
          title={activeSurvey.title}
          description={activeSurvey.description}
          isAnonymous={activeSurvey.isAnonymous}
          questions={activeSurvey.questions}
          onClose={() => setActiveSurvey(null)}
          onSubmitted={handleSurveySubmitted}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: Platform.OS === "ios" ? 60 : 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: Colors.text,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { flex: 1 },
  listContent: {
    padding: 16,
    paddingBottom: 100,
    gap: 12,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: Colors.text,
  },
  emptyText: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
  },
  cardCompleted: {
    opacity: 0.7,
    borderColor: "#4ade80",
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: Colors.primary + "20",
    alignItems: "center",
    justifyContent: "center",
  },
  cardContent: { flex: 1 },
  cardTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
    marginBottom: 4,
  },
  cardDesc: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: 8,
    lineHeight: 18,
  },
  cardMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: Colors.border,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    fontSize: 10,
    color: Colors.textSecondary,
  },
  cardDate: {
    fontSize: 11,
    color: Colors.textSecondary,
  },
  completedLabel: {
    fontSize: 12,
    color: "#4ade80",
    fontWeight: "600",
  },
  pendingLabel: {
    fontSize: 12,
    color: Colors.primary,
    fontWeight: "500",
  },
  // Form styles
  formContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  formHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "ios" ? 56 : 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 12,
  },
  closeBtn: {
    padding: 4,
  },
  formTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  formProgress: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  progressBarBg: {
    height: 3,
    backgroundColor: Colors.border,
  },
  progressBarFill: {
    height: 3,
    backgroundColor: Colors.primary,
  },
  formScroll: { flex: 1 },
  formScrollContent: {
    padding: 24,
    paddingBottom: 40,
  },
  questionText: {
    fontSize: 18,
    fontWeight: "600",
    color: Colors.text,
    lineHeight: 26,
    marginBottom: 24,
  },
  required: {
    color: Colors.error,
  },
  ratingRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  ratingBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  ratingBtnActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primary,
  },
  ratingBtnText: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  ratingBtnTextActive: {
    color: "#fff",
  },
  npsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  npsBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
  },
  npsBtnActive: {},
  npsBtnSelected: {
    transform: [{ scale: 1.1 }],
    borderWidth: 3,
  },
  npsBtnPromoter: {
    borderColor: "#4ade80",
    backgroundColor: "#4ade8020",
  },
  npsBtnPassive: {
    borderColor: "#fbbf24",
    backgroundColor: "#fbbf2420",
  },
  npsBtnDetractor: {
    borderColor: "#f87171",
    backgroundColor: "#f8717120",
  },
  npsBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  npsBtnTextActive: {
    color: Colors.text,
  },
  npsLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  npsLabel: {
    fontSize: 11,
    color: Colors.textSecondary,
  },
  choicesContainer: {
    gap: 10,
  },
  choiceBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  choiceBtnActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primary + "15",
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  radioCircleSelected: {
    borderColor: Colors.primary,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.primary,
  },
  choiceText: {
    fontSize: 15,
    color: Colors.textSecondary,
    flex: 1,
  },
  choiceTextActive: {
    color: Colors.text,
    fontWeight: "500",
  },
  textInput: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    padding: 14,
    color: Colors.text,
    fontSize: 15,
    minHeight: 120,
    textAlignVertical: "top",
  },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    paddingBottom: Platform.OS === "ios" ? 32 : 16,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: 12,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  backBtnText: {
    fontSize: 15,
    color: Colors.textSecondary,
  },
  nextBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: Colors.primary,
  },
  nextBtnDisabled: {
    opacity: 0.4,
  },
  nextBtnText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#fff",
  },
});
