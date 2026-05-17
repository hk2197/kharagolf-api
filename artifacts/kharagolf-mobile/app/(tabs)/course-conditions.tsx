import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Modal,
  TextInput,
  Alert,
  Platform,
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
      throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
    }
    return r.json();
  });
}

type CourseArea =
  | "hole_1" | "hole_2" | "hole_3" | "hole_4" | "hole_5" | "hole_6"
  | "hole_7" | "hole_8" | "hole_9" | "hole_10" | "hole_11" | "hole_12"
  | "hole_13" | "hole_14" | "hole_15" | "hole_16" | "hole_17" | "hole_18"
  | "driving_range" | "practice_green" | "clubhouse_surrounds" | "car_park" | "general";

type ConditionRating = "excellent" | "good" | "fair" | "poor" | "closed";
type NoticeType = "closure" | "gur" | "preferred_lies" | "temporary_green" | "hazard" | "general";

interface ConditionReport {
  report: {
    id: number; area: CourseArea; greenSpeed: string | null;
    fairwayCondition: ConditionRating | null; greenCondition: ConditionRating | null;
    teeCondition: ConditionRating | null; roughCondition: ConditionRating | null;
    bunkerCondition: ConditionRating | null; notes: string | null;
    reportDate: string;
  };
  reporterName: string | null;
}

interface CourseNotice {
  id: number; title: string; body: string; noticeType: NoticeType;
  area: CourseArea | null; isPinned: boolean; expiresAt: string | null;
  publishedAt: string | null;
}

const AREA_LABELS: Record<CourseArea, string> = {
  hole_1: "Hole 1", hole_2: "Hole 2", hole_3: "Hole 3", hole_4: "Hole 4",
  hole_5: "Hole 5", hole_6: "Hole 6", hole_7: "Hole 7", hole_8: "Hole 8",
  hole_9: "Hole 9", hole_10: "Hole 10", hole_11: "Hole 11", hole_12: "Hole 12",
  hole_13: "Hole 13", hole_14: "Hole 14", hole_15: "Hole 15", hole_16: "Hole 16",
  hole_17: "Hole 17", hole_18: "Hole 18",
  driving_range: "Driving Range", practice_green: "Practice Green",
  clubhouse_surrounds: "Clubhouse Surrounds", car_park: "Car Park", general: "General",
};

const CONDITION_COLORS: Record<ConditionRating, string> = {
  excellent: "#10b981", good: "#22c55e", fair: "#eab308", poor: "#f97316", closed: "#ef4444",
};

const NOTICE_TYPE_LABELS: Record<NoticeType, string> = {
  closure: "Closure", gur: "GUR", preferred_lies: "Preferred Lies",
  temporary_green: "Temp. Green", hazard: "Hazard", general: "Notice",
};

const NOTICE_TYPE_COLORS: Record<NoticeType, string> = {
  closure: "#ef4444", gur: "#f97316", preferred_lies: "#eab308",
  temporary_green: "#f59e0b", hazard: "#dc2626", general: "#3b82f6",
};

const COURSE_AREAS: CourseArea[] = [
  "hole_1","hole_2","hole_3","hole_4","hole_5","hole_6","hole_7","hole_8","hole_9",
  "hole_10","hole_11","hole_12","hole_13","hole_14","hole_15","hole_16","hole_17","hole_18",
  "driving_range","practice_green","clubhouse_surrounds","car_park","general",
];

const CONDITION_RATINGS: ConditionRating[] = ["excellent","good","fair","poor","closed"];

function fmtDate(d: string | null | undefined) {
  if (!d) return "";
  return new Date(d).toLocaleDateString(getLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function RatingBadge({ rating }: { rating: ConditionRating | null | undefined }) {
  if (!rating) return null;
  return (
    <View style={[styles.ratingBadge, { backgroundColor: CONDITION_COLORS[rating] + "30" }]}>
      <Text style={[styles.ratingText, { color: CONDITION_COLORS[rating] }]}>{rating}</Text>
    </View>
  );
}

// ─── Public Course Conditions (Member View) ───────────────────────────────────

function PublicConditionsView({ orgId }: { orgId: number }) {
  const [data, setData] = React.useState<{ notices: CourseNotice[]; latestReports: { report: ConditionReport["report"] }[] } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/public/organizations/${orgId}/course-conditions`);
      setData(res as typeof data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orgId]);

  React.useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingSpinner style={styles.center} color={Colors.primary} />;

  const notices = data?.notices ?? [];
  const reports = data?.latestReports ?? [];

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={Colors.primary} />}
    >
      {notices.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Course Notices</Text>
          {notices.map(notice => (
            <View key={notice.id} style={[styles.noticeCard, { borderLeftColor: NOTICE_TYPE_COLORS[notice.noticeType] }]}>
              <View style={styles.noticeHeader}>
                {notice.isPinned && <Feather name="bookmark" size={12} color={Colors.primary} style={{ marginRight: 4 }} />}
                <View style={[styles.noticeBadge, { backgroundColor: NOTICE_TYPE_COLORS[notice.noticeType] + "30" }]}>
                  <Text style={[styles.noticeBadgeText, { color: NOTICE_TYPE_COLORS[notice.noticeType] }]}>{NOTICE_TYPE_LABELS[notice.noticeType]}</Text>
                </View>
                {notice.area && <Text style={styles.noticeArea}>{AREA_LABELS[notice.area]}</Text>}
              </View>
              <Text style={styles.noticeTitle}>{notice.title}</Text>
              <Text style={styles.noticeBody}>{notice.body}</Text>
              {notice.expiresAt && (
                <Text style={styles.noticeExpiry}>Expires: {fmtDate(notice.expiresAt)}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {reports.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Today's Conditions</Text>
          {reports.map(({ report }) => (
            <View key={report.id} style={styles.reportCard}>
              <Text style={styles.reportArea}>{AREA_LABELS[report.area]}</Text>
              <View style={styles.ratingsRow}>
                {report.greenSpeed && (
                  <View style={styles.stimp}>
                    <Text style={styles.stimpLabel}>Stimp</Text>
                    <Text style={styles.stimpValue}>{report.greenSpeed}</Text>
                  </View>
                )}
                {report.fairwayCondition && <RatingBadge rating={report.fairwayCondition} />}
                {report.greenCondition && <RatingBadge rating={report.greenCondition} />}
                {report.teeCondition && <RatingBadge rating={report.teeCondition} />}
              </View>
              {report.notes && <Text style={styles.reportNotes} numberOfLines={2}>{report.notes}</Text>}
              <Text style={styles.reportTime}>{fmtDate(report.reportDate)}</Text>
            </View>
          ))}
        </View>
      )}

      {notices.length === 0 && reports.length === 0 && (
        <View style={styles.emptyState}>
          <Feather name="sun" size={48} color={Colors.textSecondary} />
          <Text style={styles.emptyTitle}>Course in Good Shape</Text>
          <Text style={styles.emptySubtitle}>No active notices. Check back for daily condition updates.</Text>
        </View>
      )}
    </ScrollView>
  );
}

// ─── Greenkeeper Form (Staff View) ───────────────────────────────────────────

function GreenkeeperView({ orgId }: { orgId: number }) {
  const [reports, setReports] = React.useState<ConditionReport[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [showModal, setShowModal] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [activeTaskTab, setActiveTaskTab] = React.useState<"reports" | "tasks">("reports");

  const [tasks, setTasks] = React.useState<Array<{ task: { id: number; title: string; status: string; priority: string; area: CourseArea | null; dueDate: string | null }; assignedName: string | null }>>([]);

  const [form, setForm] = React.useState({
    area: "" as CourseArea | "",
    greenSpeed: "",
    fairwayCondition: "" as ConditionRating | "",
    greenCondition: "" as ConditionRating | "",
    teeCondition: "" as ConditionRating | "",
    notes: "",
  });

  const [areaPickerOpen, setAreaPickerOpen] = React.useState(false);

  const loadReports = useCallback(async () => {
    try {
      const res = await apiFetch(`/organizations/${orgId}/maintenance/conditions?limit=20`) as { reports: ConditionReport[] };
      setReports(res.reports ?? []);
    } catch (e) { console.error(e); }
  }, [orgId]);

  const loadTasks = useCallback(async () => {
    try {
      const res = await apiFetch(`/organizations/${orgId}/maintenance/tasks?status=pending,in_progress&limit=30`) as { tasks: typeof tasks };
      setTasks(res.tasks ?? []);
    } catch (e) { console.error(e); }
  }, [orgId]);

  const load = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadReports(), loadTasks()]);
    setLoading(false);
    setRefreshing(false);
  }, [loadReports, loadTasks]);

  React.useEffect(() => { load(); }, [load]);

  const handleSubmit = async () => {
    if (!form.area) { Alert.alert("Required", "Please select an area."); return; }
    setSaving(true);
    try {
      await apiFetch(`/organizations/${orgId}/maintenance/conditions`, {
        method: "POST",
        body: JSON.stringify({
          area: form.area,
          greenSpeed: form.greenSpeed || undefined,
          fairwayCondition: form.fairwayCondition || undefined,
          greenCondition: form.greenCondition || undefined,
          teeCondition: form.teeCondition || undefined,
          notes: form.notes || undefined,
        }),
      });
      setShowModal(false);
      setForm({ area: "", greenSpeed: "", fairwayCondition: "", greenCondition: "", teeCondition: "", notes: "" });
      await loadReports();
    } catch (e: unknown) {
      Alert.alert("Error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateTask = async (taskId: number, status: string) => {
    try {
      await apiFetch(`/organizations/${orgId}/maintenance/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await loadTasks();
    } catch (e: unknown) {
      Alert.alert("Error", (e as Error).message);
    }
  };

  const PRIORITY_COLORS: Record<string, string> = {
    low: "#64748b", medium: "#3b82f6", high: "#f97316", urgent: "#ef4444",
  };

  if (loading) return <LoadingSpinner style={styles.center} color={Colors.primary} />;

  return (
    <View style={styles.flex}>
      <View style={styles.tabRow}>
        {(["reports", "tasks"] as const).map(t => (
          <TouchableOpacity
            key={t}
            style={[styles.tabBtn, activeTaskTab === t && styles.tabBtnActive]}
            onPress={() => setActiveTaskTab(t)}
          >
            <Text style={[styles.tabBtnText, activeTaskTab === t && styles.tabBtnTextActive]}>
              {t === "reports" ? "Condition Log" : `Tasks (${tasks.length})`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={Colors.primary} />}
      >
        {activeTaskTab === "reports" ? (
          <View style={styles.section}>
            {reports.length === 0 ? (
              <View style={styles.emptyState}>
                <Feather name="clipboard" size={40} color={Colors.textSecondary} />
                <Text style={styles.emptyTitle}>No Reports Today</Text>
                <Text style={styles.emptySubtitle}>Log the first condition report using the button below.</Text>
              </View>
            ) : reports.map(({ report, reporterName }) => (
              <View key={report.id} style={styles.reportCard}>
                <Text style={styles.reportArea}>{AREA_LABELS[report.area]}</Text>
                <View style={styles.ratingsRow}>
                  {report.greenSpeed && (
                    <View style={styles.stimp}>
                      <Text style={styles.stimpLabel}>Stimp</Text>
                      <Text style={styles.stimpValue}>{report.greenSpeed}</Text>
                    </View>
                  )}
                  {report.fairwayCondition && <RatingBadge rating={report.fairwayCondition} />}
                  {report.greenCondition && <RatingBadge rating={report.greenCondition} />}
                  {report.teeCondition && <RatingBadge rating={report.teeCondition} />}
                  {report.roughCondition && <RatingBadge rating={report.roughCondition} />}
                </View>
                {report.notes && <Text style={styles.reportNotes} numberOfLines={3}>{report.notes}</Text>}
                <View style={styles.reportMeta}>
                  <Text style={styles.reportTime}>{fmtDate(report.reportDate)}</Text>
                  {reporterName && <Text style={styles.reportTime}>{reporterName}</Text>}
                </View>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.section}>
            {tasks.length === 0 ? (
              <View style={styles.emptyState}>
                <Feather name="check-circle" size={40} color={Colors.primary} />
                <Text style={styles.emptyTitle}>All Clear!</Text>
                <Text style={styles.emptySubtitle}>No pending tasks assigned to you.</Text>
              </View>
            ) : tasks.map(({ task, assignedName }) => (
              <View key={task.id} style={styles.taskCard}>
                <View style={styles.taskHeader}>
                  <View style={[styles.priorityDot, { backgroundColor: PRIORITY_COLORS[task.priority] ?? "#64748b" }]} />
                  <Text style={styles.taskTitle} numberOfLines={2}>{task.title}</Text>
                </View>
                {task.area && <Text style={styles.taskArea}>{AREA_LABELS[task.area]}</Text>}
                {task.dueDate && (
                  <Text style={[styles.taskDue, new Date(task.dueDate) < new Date() ? { color: "#ef4444" } : {}]}>
                    Due: {fmtDate(task.dueDate)}
                  </Text>
                )}
                <View style={styles.taskActions}>
                  {task.status === "pending" && (
                    <TouchableOpacity style={styles.taskActionBtn} onPress={() => updateTask(task.id, "in_progress")}>
                      <Feather name="play" size={14} color={Colors.primary} />
                      <Text style={styles.taskActionText}>Start</Text>
                    </TouchableOpacity>
                  )}
                  {task.status !== "completed" && (
                    <TouchableOpacity style={[styles.taskActionBtn, styles.taskActionComplete]} onPress={() => updateTask(task.id, "completed")}>
                      <Feather name="check" size={14} color="#10b981" />
                      <Text style={[styles.taskActionText, { color: "#10b981" }]}>Complete</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {activeTaskTab === "reports" && (
        <TouchableOpacity style={styles.fab} onPress={() => setShowModal(true)}>
          <Feather name="plus" size={24} color="#fff" />
        </TouchableOpacity>
      )}

      <Modal visible={showModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowModal(false)}>
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Log Condition Report</Text>
            <TouchableOpacity onPress={() => setShowModal(false)}>
              <Feather name="x" size={22} color={Colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.fieldLabel}>Area *</Text>
            <TouchableOpacity style={styles.select} onPress={() => setAreaPickerOpen(true)}>
              <Text style={form.area ? styles.selectText : styles.selectPlaceholder}>
                {form.area ? AREA_LABELS[form.area] : "Select area..."}
              </Text>
              <Feather name="chevron-down" size={16} color={Colors.textSecondary} />
            </TouchableOpacity>

            <Text style={styles.fieldLabel}>Green Speed (Stimp)</Text>
            <TextInput
              style={styles.input}
              value={form.greenSpeed}
              onChangeText={v => setForm(f => ({ ...f, greenSpeed: v }))}
              placeholder="e.g. 9.5"
              keyboardType="decimal-pad"
              placeholderTextColor={Colors.textSecondary}
            />

            <Text style={styles.fieldLabel}>Fairway Condition</Text>
            <View style={styles.ratingRow}>
              {CONDITION_RATINGS.map(r => (
                <TouchableOpacity
                  key={r}
                  style={[styles.ratingPill, form.fairwayCondition === r && { backgroundColor: CONDITION_COLORS[r] + "40", borderColor: CONDITION_COLORS[r] }]}
                  onPress={() => setForm(f => ({ ...f, fairwayCondition: f.fairwayCondition === r ? "" : r }))}
                >
                  <Text style={[styles.ratingPillText, form.fairwayCondition === r && { color: CONDITION_COLORS[r] }]}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.fieldLabel}>Green Condition</Text>
            <View style={styles.ratingRow}>
              {CONDITION_RATINGS.map(r => (
                <TouchableOpacity
                  key={r}
                  style={[styles.ratingPill, form.greenCondition === r && { backgroundColor: CONDITION_COLORS[r] + "40", borderColor: CONDITION_COLORS[r] }]}
                  onPress={() => setForm(f => ({ ...f, greenCondition: f.greenCondition === r ? "" : r }))}
                >
                  <Text style={[styles.ratingPillText, form.greenCondition === r && { color: CONDITION_COLORS[r] }]}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.fieldLabel}>Tee Condition</Text>
            <View style={styles.ratingRow}>
              {CONDITION_RATINGS.map(r => (
                <TouchableOpacity
                  key={r}
                  style={[styles.ratingPill, form.teeCondition === r && { backgroundColor: CONDITION_COLORS[r] + "40", borderColor: CONDITION_COLORS[r] }]}
                  onPress={() => setForm(f => ({ ...f, teeCondition: f.teeCondition === r ? "" : r }))}
                >
                  <Text style={[styles.ratingPillText, form.teeCondition === r && { color: CONDITION_COLORS[r] }]}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.fieldLabel}>Notes</Text>
            <TextInput
              style={[styles.input, styles.textarea]}
              value={form.notes}
              onChangeText={v => setForm(f => ({ ...f, notes: v }))}
              placeholder="Additional observations..."
              multiline
              numberOfLines={4}
              placeholderTextColor={Colors.textSecondary}
              textAlignVertical="top"
            />

            <TouchableOpacity style={[styles.submitBtn, saving && { opacity: 0.6 }]} onPress={handleSubmit} disabled={saving}>
              {saving ? <LoadingSpinner color="#fff" size="small" /> : <Text style={styles.submitText}>Submit Report</Text>}
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={areaPickerOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setAreaPickerOpen(false)}>
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select Area</Text>
            <TouchableOpacity onPress={() => setAreaPickerOpen(false)}>
              <Feather name="x" size={22} color={Colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView>
            {COURSE_AREAS.map(area => (
              <TouchableOpacity
                key={area}
                style={[styles.areaItem, form.area === area && styles.areaItemActive]}
                onPress={() => { setForm(f => ({ ...f, area })); setAreaPickerOpen(false); }}
              >
                <Text style={[styles.areaItemText, form.area === area && styles.areaItemTextActive]}>
                  {AREA_LABELS[area]}
                </Text>
                {form.area === area && <Feather name="check" size={16} color={Colors.primary} />}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function CourseConditionsScreen() {
  const { session } = useAuth();
  const orgId = session?.organizationId;
  const role = session?.role;

  const isGroundStaff = role && ["org_admin", "tournament_director", "volunteer"].includes(role);

  const [tab, setTab] = useState<"public" | "staff">(isGroundStaff ? "staff" : "public");

  if (!orgId) {
    return (
      <View style={styles.center}>
        <Feather name="sun" size={48} color={Colors.textSecondary} />
        <Text style={styles.emptyTitle}>Course Conditions</Text>
        <Text style={styles.emptySubtitle}>Please log in to view course conditions.</Text>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Course Conditions</Text>
        {isGroundStaff && (
          <View style={styles.headerTabs}>
            <TouchableOpacity
              style={[styles.headerTab, tab === "public" && styles.headerTabActive]}
              onPress={() => setTab("public")}
            >
              <Text style={[styles.headerTabText, tab === "public" && styles.headerTabTextActive]}>Member View</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.headerTab, tab === "staff" && styles.headerTabActive]}
              onPress={() => setTab("staff")}
            >
              <Text style={[styles.headerTabText, tab === "staff" && styles.headerTabTextActive]}>Greenkeeper</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {tab === "public" ? (
        <PublicConditionsView orgId={orgId} />
      ) : (
        <GreenkeeperView orgId={orgId} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 100 },
  header: { paddingTop: 60, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: "700", color: Colors.text, marginBottom: 12 },
  headerTabs: { flexDirection: "row", backgroundColor: Colors.background, borderRadius: 8, padding: 2 },
  headerTab: { flex: 1, paddingVertical: 6, alignItems: "center", borderRadius: 6 },
  headerTabActive: { backgroundColor: Colors.primary },
  headerTabText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  headerTabTextActive: { color: "#fff" },
  tabRow: { flexDirection: "row", backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tabBtn: { flex: 1, paddingVertical: 12, alignItems: "center" },
  tabBtnActive: { borderBottomWidth: 2, borderBottomColor: Colors.primary },
  tabBtnText: { fontSize: 14, fontWeight: "500", color: Colors.textSecondary },
  tabBtnTextActive: { color: Colors.primary, fontWeight: "700" },
  section: { gap: 12 },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: Colors.text, marginBottom: 4 },
  noticeCard: { backgroundColor: Colors.surface, borderRadius: 12, padding: 14, borderLeftWidth: 3 },
  noticeHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  noticeBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  noticeBadgeText: { fontSize: 11, fontWeight: "700" },
  noticeArea: { fontSize: 12, color: Colors.textSecondary },
  noticeTitle: { fontSize: 15, fontWeight: "700", color: Colors.text, marginBottom: 4 },
  noticeBody: { fontSize: 14, color: Colors.textSecondary, lineHeight: 20 },
  noticeExpiry: { fontSize: 12, color: "#f59e0b", marginTop: 6 },
  reportCard: { backgroundColor: Colors.surface, borderRadius: 12, padding: 14 },
  reportArea: { fontSize: 15, fontWeight: "700", color: Colors.text, marginBottom: 8 },
  ratingsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  ratingBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20 },
  ratingText: { fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
  stimp: { backgroundColor: Colors.primary + "20", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20, flexDirection: "row", gap: 4, alignItems: "center" },
  stimpLabel: { fontSize: 11, color: Colors.primary, fontWeight: "600" },
  stimpValue: { fontSize: 13, color: Colors.primary, fontWeight: "700" },
  reportNotes: { fontSize: 13, color: Colors.textSecondary, marginTop: 4 },
  reportMeta: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  reportTime: { fontSize: 11, color: Colors.textSecondary },
  taskCard: { backgroundColor: Colors.surface, borderRadius: 12, padding: 14 },
  taskHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 4 },
  priorityDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6, flexShrink: 0 },
  taskTitle: { fontSize: 14, fontWeight: "600", color: Colors.text, flex: 1 },
  taskArea: { fontSize: 12, color: Colors.textSecondary, marginBottom: 2, marginLeft: 16 },
  taskDue: { fontSize: 12, color: Colors.textSecondary, marginLeft: 16, marginBottom: 8 },
  taskActions: { flexDirection: "row", gap: 8, marginLeft: 16 },
  taskActionBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: Colors.primary },
  taskActionComplete: { borderColor: "#10b981" },
  taskActionText: { fontSize: 13, fontWeight: "600", color: Colors.primary },
  emptyState: { alignItems: "center", justifyContent: "center", paddingVertical: 60 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, marginTop: 16, marginBottom: 8 },
  emptySubtitle: { fontSize: 14, color: Colors.textSecondary, textAlign: "center", paddingHorizontal: 24 },
  fab: { position: "absolute", bottom: 100, right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 8 },
  modalContainer: { flex: 1, backgroundColor: Colors.background },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.border },
  modalTitle: { fontSize: 18, fontWeight: "700", color: Colors.text },
  modalScroll: { flex: 1, padding: 16 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: Colors.text, marginBottom: 6, marginTop: 14 },
  input: { backgroundColor: Colors.surface, borderRadius: 10, padding: 12, color: Colors.text, fontSize: 15, borderWidth: 1, borderColor: Colors.border },
  textarea: { minHeight: 100 },
  select: { backgroundColor: Colors.surface, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: Colors.border, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  selectText: { color: Colors.text, fontSize: 15 },
  selectPlaceholder: { color: Colors.textSecondary, fontSize: 15 },
  ratingRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  ratingPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface },
  ratingPillText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary, textTransform: "capitalize" },
  submitBtn: { backgroundColor: Colors.primary, borderRadius: 12, padding: 16, alignItems: "center", marginTop: 24 },
  submitText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  areaItem: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.border },
  areaItemActive: { backgroundColor: Colors.primary + "10" },
  areaItemText: { fontSize: 15, color: Colors.text },
  areaItemTextActive: { color: Colors.primary, fontWeight: "700" },
});
