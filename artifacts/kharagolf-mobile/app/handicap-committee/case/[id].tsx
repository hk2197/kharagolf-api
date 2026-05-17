import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Modal,
  TextInput,
  Switch,
  Alert,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { getApiUrl } from "@/utils/api";
import { getLocale } from "@/i18n";
import { formatRelativeTime } from "@/i18n/relativeTime";

const GOLD = "#C9A84C";

interface PeerReview {
  id: number;
  reviewerUserId: number | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
  recommendation: "confirm" | "dispute" | "insufficient_info" | null;
  comment: string | null;
  invitedAt: string;
  respondedAt: string | null;
  seenAt: string | null;
  expiresAt: string | null;
}

interface AuditEntry {
  id: number;
  action: string;
  details: string | null;
  createdAt: string;
  actorName: string | null;
}

interface CaseDetail {
  id: number;
  organizationId: number;
  subjectUserId: number;
  subjectName: string | null;
  subjectEmail: string | null;
  kind: string;
  status: string;
  details: string | null;
  periodLabel: string | null;
  createdAt: string;
  decision: string | null;
  decisionRationale: string | null;
  peerReviews: PeerReview[];
  auditLog: AuditEntry[];
}

interface OrgMember {
  userId: number;
  displayName: string | null;
  email: string | null;
  role: string;
}

type CaseDecision = "no_action" | "soft_cap" | "hard_cap" | "index_adjustment";

const STATUS_COLOR: Record<string, string> = {
  open: "#3b82f6",
  assigned: "#a855f7",
  in_review: "#f59e0b",
  awaiting_peer: "#f59e0b",
  decided: "#10b981",
  closed: "#94a3b8",
  reopened: "#f59e0b",
};

const REC_COLOR: Record<string, string> = {
  confirm: "#10b981",
  dispute: "#ef4444",
  insufficient_info: "#94a3b8",
};

const RECOMMENDATION_KEYS: Record<string, string> = {
  confirm: "confirm",
  dispute: "dispute",
  insufficient_info: "insufficient_info",
};

const DECISIONS: CaseDecision[] = ["no_action", "soft_cap", "hard_cap", "index_adjustment"];

const COMMITTEE_ROLES = new Set(["committee_member", "org_admin", "super_admin"]);

type PeerFilter = "all" | "opened_unresponded" | "unopened";

async function fetchCase(orgId: number, caseId: number, token: string): Promise<CaseDetail> {
  const res = await fetch(getApiUrl(`/organizations/${orgId}/handicap/cases/${caseId}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<CaseDetail>;
}

async function fetchMembers(orgId: number, token: string): Promise<OrgMember[]> {
  const res = await fetch(
    getApiUrl(`/organizations/${orgId}/members?role=committee_member,org_admin,super_admin`),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<OrgMember[]>;
}

async function postAction<T = unknown>(
  url: string, token: string, body: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(j.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export default function CommitteeCaseDetailScreen() {
  const { t } = useTranslation("handicapCommittee");
  const { token } = useAuth();
  const params = useLocalSearchParams<{ id: string; orgId?: string }>();
  const caseId = Number(params.id);
  const orgIdParam = params.orgId ? Number(params.orgId) : null;

  const [data, setData] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peerFilter, setPeerFilter] = useState<PeerFilter>("all");

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);

  // Modals
  const [assignOpen, setAssignOpen] = useState(false);
  const [peerOpen, setPeerOpen] = useState(false);
  const [decideOpen, setDecideOpen] = useState(false);
  const [peerSeenSummaryOpen, setPeerSeenSummaryOpen] = useState(false);

  // Form state
  const [assigneeId, setAssigneeId] = useState<number | null>(null);
  const [peerReviewerId, setPeerReviewerId] = useState<number | null>(null);
  const [decision, setDecision] = useState<CaseDecision | null>(null);
  const [rationale, setRationale] = useState("");
  const [adjStrokes, setAdjStrokes] = useState("");
  const [adjCap, setAdjCap] = useState("");
  const [adjNotes, setAdjNotes] = useState("");
  const [applyToPlayer, setApplyToPlayer] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!token || !caseId || !orgIdParam) {
      setLoading(false);
      setRefreshing(false);
      if (!orgIdParam) setError(t("errors.missingOrgContext"));
      return;
    }
    try {
      const json = await fetchCase(orgIdParam, caseId, token);
      setData(json);
      setError(null);
    } catch (e) {
      setError((e as Error).message || t("errors.couldNotLoad"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, caseId, orgIdParam, t]);

  useEffect(() => { load(); }, [load]);

  const ensureMembers = useCallback(async () => {
    if (membersLoaded || !token || !orgIdParam) return;
    try {
      const list = await fetchMembers(orgIdParam, token);
      setMembers(list);
      setMembersLoaded(true);
    } catch (e) {
      Alert.alert(t("errors.membersLoadFailed"), (e as Error).message);
    }
  }, [membersLoaded, token, orgIdParam, t]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const peerReviewsAll = data?.peerReviews ?? [];
  const peerResponses = peerReviewsAll.filter(p => p.respondedAt);
  const peerPendingAll = peerReviewsAll.filter(p => !p.respondedAt);
  const peerPending = peerPendingAll.filter(p => {
    if (peerFilter === "opened_unresponded") return !!p.seenAt;
    if (peerFilter === "unopened") return !p.seenAt;
    return true;
  });
  const openedUnrespondedCount = peerPendingAll.filter(p => !!p.seenAt).length;
  const unopenedCount = peerPendingAll.filter(p => !p.seenAt).length;
  const peerOpenedAll = peerReviewsAll.filter(p => !!p.seenAt);
  const peerUnopenedAll = peerReviewsAll.filter(p => !p.seenAt);
  const reviewerLabel = (p: PeerReview) =>
    p.reviewerName ?? p.reviewerEmail ?? `User #${p.reviewerUserId ?? "—"}`;

  // The /members endpoint ignores the ?role= query, so filter to committee-
  // eligible roles client-side to keep the pickers honest.
  const eligibleMembers = useMemo(
    () => members.filter(m => COMMITTEE_ROLES.has(m.role)),
    [members],
  );
  const peerCandidates = useMemo(
    () => eligibleMembers.filter(m => m.userId !== data?.subjectUserId),
    [eligibleMembers, data?.subjectUserId],
  );

  const isTerminal = data?.status === "closed" || data?.status === "decided";
  const canDecide = !isTerminal;
  const canAssign = !isTerminal;
  const canInvitePeer = !isTerminal;

  const openAssign = () => {
    setAssigneeId(null);
    ensureMembers();
    setAssignOpen(true);
  };
  const openPeer = () => {
    setPeerReviewerId(null);
    ensureMembers();
    setPeerOpen(true);
  };
  const openDecide = () => {
    setDecision(null);
    setRationale("");
    setAdjStrokes("");
    setAdjCap("");
    setAdjNotes("");
    setApplyToPlayer(false);
    setDecideOpen(true);
  };

  const submitAssign = async () => {
    if (!token || !orgIdParam || !assigneeId) return;
    setSubmitting(true);
    try {
      await postAction(
        getApiUrl(`/organizations/${orgIdParam}/handicap/cases/${caseId}/assign`),
        token,
        { assigneeUserId: assigneeId },
      );
      setAssignOpen(false);
      await load();
    } catch (e) {
      Alert.alert(t("errors.assignFailed"), (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitPeerInvite = async () => {
    if (!token || !orgIdParam || !peerReviewerId) return;
    setSubmitting(true);
    try {
      await postAction(
        getApiUrl(`/organizations/${orgIdParam}/handicap/cases/${caseId}/peer-invite`),
        token,
        { reviewerUserId: peerReviewerId },
      );
      setPeerOpen(false);
      await load();
    } catch (e) {
      Alert.alert(t("errors.peerInviteFailed"), (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitDecide = async () => {
    if (!token || !orgIdParam || !decision) return;
    if (!rationale.trim()) {
      Alert.alert(t("validation.rationaleRequiredTitle"), t("validation.rationaleRequiredMessage"));
      return;
    }
    const body: Record<string, unknown> = { decision, rationale: rationale.trim() };
    if (decision === "index_adjustment") {
      const s = Number(adjStrokes);
      if (!Number.isFinite(s) || s <= 0) {
        Alert.alert(t("validation.invalidStrokesTitle"), t("validation.invalidStrokesMessage"));
        return;
      }
      body.createAdjustment = {
        adjustmentStrokes: s,
        notes: adjNotes.trim() || undefined,
      };
    } else if (decision === "soft_cap" || decision === "hard_cap") {
      const cap = Number(adjCap);
      if (!Number.isFinite(cap) || cap < 0 || cap > 54) {
        Alert.alert(t("validation.invalidCapTitle"), t("validation.invalidCapMessage"));
        return;
      }
      body.createAdjustment = {
        capValue: cap,
        notes: adjNotes.trim() || undefined,
      };
    }
    if (applyToPlayer && decision !== "no_action") {
      body.applyToPlayer = true;
    }
    setSubmitting(true);
    try {
      await postAction(
        getApiUrl(`/organizations/${orgIdParam}/handicap/cases/${caseId}/decide`),
        token,
        body,
      );
      setDecideOpen(false);
      await load();
    } catch (e) {
      Alert.alert(t("errors.decisionFailed"), (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 4 }} accessibilityLabel={t("header.back")}>
          <Feather name="chevron-left" size={24} color={Colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Feather name="shield" size={18} color={GOLD} />
            <Text style={styles.title}>{t("header.caseNumber", { id: caseId })}</Text>
          </View>
          <Text style={styles.subtitle}>{t("header.subtitle")}</Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}
      >
        {loading ? (
          <LoadingSpinner color={GOLD} style={{ marginTop: 60 }} />
        ) : error ? (
          <View style={styles.empty}>
            <Feather name="alert-triangle" size={36} color="#ef4444" />
            <Text style={styles.emptyTitle}>{t("errors.couldNotOpen")}</Text>
            <Text style={styles.emptyText}>{error}</Text>
          </View>
        ) : !data ? (
          <View style={styles.empty}>
            <Feather name="file" size={36} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t("errors.notFound")}</Text>
          </View>
        ) : (
          <View style={{ paddingBottom: 24 }}>
            <View style={styles.card} testID={`case-summary-${data.id}`}>
              <View style={styles.summaryRow}>
                <View style={[styles.statusPill, { backgroundColor: `${STATUS_COLOR[data.status] ?? "#94a3b8"}22`, borderColor: `${STATUS_COLOR[data.status] ?? "#94a3b8"}55` }]}>
                  <Text style={[styles.statusText, { color: STATUS_COLOR[data.status] ?? "#94a3b8" }]}>
                    {data.status.replace(/_/g, " ").toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.kindText}>{data.kind.replace(/_/g, " ")}</Text>
              </View>

              <Text style={styles.subjectLabel}>{t("summary.subject")}</Text>
              <Text style={styles.subjectName}>{data.subjectName ?? "—"}</Text>
              {data.subjectEmail ? <Text style={styles.subjectEmail}>{data.subjectEmail}</Text> : null}

              {data.periodLabel ? (
                <>
                  <Text style={styles.subjectLabel}>{t("summary.period")}</Text>
                  <Text style={styles.body}>{data.periodLabel}</Text>
                </>
              ) : null}

              {data.details ? (
                <>
                  <Text style={styles.subjectLabel}>{t("summary.details")}</Text>
                  <Text style={styles.body}>{data.details}</Text>
                </>
              ) : null}

              {data.decision ? (
                <>
                  <Text style={styles.subjectLabel}>{t("summary.decision")}</Text>
                  <Text style={styles.body}>{data.decision.replace(/_/g, " ")}</Text>
                  {data.decisionRationale ? (
                    <Text style={styles.bodyMuted}>{data.decisionRationale}</Text>
                  ) : null}
                </>
              ) : null}

              <Text style={styles.metaText}>
                {t("summary.openedAt", { date: new Date(data.createdAt).toLocaleString(getLocale()) })}
              </Text>
            </View>

            {(canAssign || canInvitePeer || canDecide) && (
              <View style={styles.actionRow}>
                {canAssign && (
                  <TouchableOpacity
                    style={[styles.actionBtn, submitting && styles.actionBtnDisabled]}
                    onPress={openAssign}
                    disabled={submitting}
                    testID="action-assign"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: submitting }}
                  >
                    <Feather name="user-plus" size={14} color={Colors.text} />
                    <Text style={styles.actionBtnText}>{t("actions.assign")}</Text>
                  </TouchableOpacity>
                )}
                {canInvitePeer && (
                  <TouchableOpacity
                    style={[styles.actionBtn, submitting && styles.actionBtnDisabled]}
                    onPress={openPeer}
                    disabled={submitting}
                    testID="action-peer-invite"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: submitting }}
                  >
                    <Feather name="users" size={14} color={Colors.text} />
                    <Text style={styles.actionBtnText}>{t("actions.invitePeer")}</Text>
                  </TouchableOpacity>
                )}
                {canDecide && (
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.actionBtnPrimary, submitting && styles.actionBtnDisabled]}
                    onPress={openDecide}
                    disabled={submitting}
                    testID="action-decide"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: submitting }}
                  >
                    <Feather name="check-circle" size={14} color="#0b0b0b" />
                    <Text style={[styles.actionBtnText, styles.actionBtnTextPrimary]}>{t("actions.recordDecision")}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {peerReviewsAll.length > 0 && (
              <View style={styles.peerSummaryRow}>
                <TouchableOpacity
                  onPress={() => setPeerSeenSummaryOpen(true)}
                  onLongPress={() => setPeerSeenSummaryOpen(true)}
                  style={[
                    styles.peerSummaryBadge,
                    peerOpenedAll.length === peerReviewsAll.length
                      ? styles.peerSummaryBadgeAllSeen
                      : null,
                  ]}
                  testID={`peer-opened-summary-${data.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={t("peerSummary.badgeAccessibility", {
                    opened: peerOpenedAll.length,
                    total: peerReviewsAll.length,
                  })}
                >
                  <Feather
                    name="eye"
                    size={12}
                    color={
                      peerOpenedAll.length === peerReviewsAll.length
                        ? Colors.text
                        : Colors.muted
                    }
                  />
                  <Text
                    style={[
                      styles.peerSummaryText,
                      peerOpenedAll.length === peerReviewsAll.length
                        ? styles.peerSummaryTextAllSeen
                        : null,
                    ]}
                  >
                    {t("peerSummary.badge", {
                      opened: peerOpenedAll.length,
                      total: peerReviewsAll.length,
                    })}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            <Text style={styles.sectionTitle}>
              {peerResponses.length > 0
                ? t("peerResponses.headingWithCount", { count: peerResponses.length })
                : t("peerResponses.heading")}
            </Text>
            {peerResponses.length === 0 ? (
              <View style={styles.emptyInline}>
                <Text style={styles.emptyText}>{t("peerResponses.empty")}</Text>
              </View>
            ) : (
              peerResponses.map(p => {
                const tone = REC_COLOR[p.recommendation ?? ""] ?? "#94a3b8";
                const recKey = p.recommendation && RECOMMENDATION_KEYS[p.recommendation];
                const label = recKey
                  ? t(`peerResponses.recommendations.${recKey}`)
                  : t("peerResponses.recommendations.responded");
                const seenLabel = p.seenAt
                  ? t("peerResponses.seenRelative", { relative: formatRelativeTime(p.seenAt) })
                  : t("peerResponses.notYetOpened");
                return (
                  <View key={p.id} style={styles.card} testID={`peer-response-${p.id}`}>
                    <View style={styles.summaryRow}>
                      <Text style={styles.reviewerName}>{p.reviewerName ?? t("peerResponses.reviewerFallback")}</Text>
                      <View style={[styles.recPill, { backgroundColor: `${tone}22`, borderColor: `${tone}55` }]}>
                        <Text style={[styles.recText, { color: tone }]}>{label}</Text>
                      </View>
                    </View>
                    <View style={styles.seenRow}>
                      <View
                        style={[
                          styles.seenPill,
                          p.seenAt
                            ? { backgroundColor: "#94a3b822", borderColor: "#94a3b855" }
                            : { backgroundColor: "transparent", borderColor: Colors.border },
                        ]}
                        testID={`peer-seen-${p.id}`}
                      >
                        <Feather
                          name={p.seenAt ? "eye" : "eye-off"}
                          size={11}
                          color={p.seenAt ? Colors.text : Colors.muted}
                        />
                        <Text style={[styles.seenText, { color: p.seenAt ? Colors.text : Colors.muted }]}>
                          {seenLabel}
                        </Text>
                      </View>
                    </View>
                    {p.comment ? <Text style={styles.body}>{p.comment}</Text> : null}
                    <Text style={styles.metaText}>
                      {t("peerResponses.respondedAt", {
                        date: p.respondedAt ? new Date(p.respondedAt).toLocaleString(getLocale()) : "—",
                      })}
                    </Text>
                  </View>
                );
              })
            )}

            {peerPendingAll.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>{t("pendingPeer.heading", { count: peerPendingAll.length })}</Text>
                <View style={styles.filterRow}>
                  {([
                    { key: "all" as const, label: t("pendingPeer.filters.all", { count: peerPendingAll.length }) },
                    { key: "opened_unresponded" as const, label: t("pendingPeer.filters.openedUnresponded", { count: openedUnrespondedCount }) },
                    { key: "unopened" as const, label: t("pendingPeer.filters.unopened", { count: unopenedCount }) },
                  ]).map(opt => {
                    const active = peerFilter === opt.key;
                    return (
                      <TouchableOpacity
                        key={opt.key}
                        onPress={() => setPeerFilter(opt.key)}
                        style={[styles.filterPill, active && styles.filterPillActive]}
                        testID={`peer-filter-${opt.key}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                      >
                        <Text style={[styles.filterText, active && styles.filterTextActive]}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {peerPending.length === 0 ? (
                  <View style={styles.emptyInline}>
                    <Text style={styles.emptyText}>{t("pendingPeer.empty")}</Text>
                  </View>
                ) : (
                  peerPending.map(p => {
                    const seenLabel = p.seenAt
                      ? t("peerResponses.seenRelative", { relative: formatRelativeTime(p.seenAt) })
                      : t("peerResponses.notYetOpened");
                    const invitedDate = new Date(p.invitedAt).toLocaleString(getLocale());
                    return (
                      <View key={p.id} style={styles.card} testID={`peer-pending-${p.id}`}>
                        <View style={styles.summaryRow}>
                          <Text style={styles.reviewerName}>{p.reviewerName ?? t("peerResponses.reviewerFallback")}</Text>
                          <View
                            style={[
                              styles.seenPill,
                              p.seenAt
                                ? { backgroundColor: "#94a3b822", borderColor: "#94a3b855" }
                                : { backgroundColor: "transparent", borderColor: Colors.border },
                            ]}
                            testID={`peer-seen-${p.id}`}
                          >
                            <Feather
                              name={p.seenAt ? "eye" : "eye-off"}
                              size={11}
                              color={p.seenAt ? Colors.text : Colors.muted}
                            />
                            <Text style={[styles.seenText, { color: p.seenAt ? Colors.text : Colors.muted }]}>
                              {seenLabel}
                            </Text>
                          </View>
                        </View>
                        <Text style={styles.metaText}>
                          {p.seenAt
                            ? t("pendingPeer.invitedWithSeen", {
                                invited: invitedDate,
                                seen: new Date(p.seenAt).toLocaleString(getLocale()),
                              })
                            : t("pendingPeer.invited", { date: invitedDate })}
                        </Text>
                      </View>
                    );
                  })
                )}
              </>
            )}

            {data.auditLog.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>{t("activity.heading")}</Text>
                <View style={styles.card}>
                  {data.auditLog.slice(0, 20).map(a => (
                    <View key={a.id} style={styles.auditRow}>
                      <View style={styles.auditDot} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.auditAction}>{a.action.replace(/_/g, " ")}</Text>
                        {a.details ? <Text style={styles.bodyMuted}>{a.details}</Text> : null}
                        <Text style={styles.metaText}>
                          {new Date(a.createdAt).toLocaleString(getLocale())}
                          {a.actorName ? ` · ${a.actorName}` : ""}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              </>
            )}
          </View>
        )}
      </ScrollView>

      {/* Assign modal */}
      <MemberPickerModal
        visible={assignOpen}
        title={t("assignModal.title")}
        subtitle={t("assignModal.subtitle")}
        members={eligibleMembers}
        selectedId={assigneeId}
        onSelect={setAssigneeId}
        onClose={() => setAssignOpen(false)}
        onSubmit={submitAssign}
        submitLabel={t("assignModal.submit")}
        submitting={submitting}
        membersLoaded={membersLoaded}
        testIDPrefix="assign"
      />

      {/* Peer invite modal */}
      <MemberPickerModal
        visible={peerOpen}
        title={t("peerModal.title")}
        subtitle={t("peerModal.subtitle")}
        members={peerCandidates}
        selectedId={peerReviewerId}
        onSelect={setPeerReviewerId}
        onClose={() => setPeerOpen(false)}
        onSubmit={submitPeerInvite}
        submitLabel={t("peerModal.submit")}
        submitting={submitting}
        membersLoaded={membersLoaded}
        testIDPrefix="peer"
      />

      {/* Peer opened/unopened summary modal */}
      <Modal
        visible={peerSeenSummaryOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPeerSeenSummaryOpen(false)}
      >
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>{t("peerSummary.sheetTitle")}</Text>
                <Text style={styles.sheetSubtitle}>
                  {t("peerSummary.sheetSubtitle", {
                    opened: peerOpenedAll.length,
                    total: peerReviewsAll.length,
                  })}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setPeerSeenSummaryOpen(false)}
                accessibilityLabel={t("peerSummary.close")}
                testID="peer-opened-summary-close"
              >
                <Feather name="x" size={20} color={Colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 420 }}>
              <Text style={styles.formLabel}>
                {t("peerSummary.openedHeading", { count: peerOpenedAll.length })}
              </Text>
              {peerOpenedAll.length === 0 ? (
                <Text style={styles.emptyText}>{t("peerSummary.noneOpened")}</Text>
              ) : (
                peerOpenedAll.map(p => (
                  <View
                    key={p.id}
                    style={styles.peerSummaryItem}
                    testID={`peer-opened-summary-opened-${p.id}`}
                  >
                    <Feather name="eye" size={14} color={Colors.text} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.peerSummaryItemName}>{reviewerLabel(p)}</Text>
                      {p.seenAt ? (
                        <Text style={styles.peerSummaryItemMeta}>
                          {t("peerSummary.seenRelative", { relative: formatRelativeTime(p.seenAt) })}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))
              )}

              <Text style={styles.formLabel}>
                {t("peerSummary.notYetOpenedHeading", { count: peerUnopenedAll.length })}
              </Text>
              {peerUnopenedAll.length === 0 ? (
                <Text style={styles.emptyText}>{t("peerSummary.everyoneOpened")}</Text>
              ) : (
                peerUnopenedAll.map(p => (
                  <View
                    key={p.id}
                    style={styles.peerSummaryItem}
                    testID={`peer-opened-summary-unopened-${p.id}`}
                  >
                    <Feather name="eye-off" size={14} color={Colors.muted} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.peerSummaryItemName}>{reviewerLabel(p)}</Text>
                      <Text style={styles.peerSummaryItemMeta}>
                        {t("peerSummary.invitedRelative", { relative: formatRelativeTime(p.invitedAt) })}
                      </Text>
                    </View>
                  </View>
                ))
              )}
            </ScrollView>
            <View style={styles.sheetFooter}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnSecondary]}
                onPress={() => setPeerSeenSummaryOpen(false)}
              >
                <Text style={styles.modalBtnSecondaryText}>{t("peerSummary.close")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Decide modal */}
      <Modal
        visible={decideOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setDecideOpen(false)}
      >
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{t("decideModal.title")}</Text>
              <TouchableOpacity onPress={() => setDecideOpen(false)} accessibilityLabel={t("common.close")}>
                <Feather name="x" size={20} color={Colors.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 520 }} keyboardShouldPersistTaps="handled">
              <Text style={styles.formLabel}>{t("decideModal.decisionLabel")}</Text>
              <View style={styles.choiceRow}>
                {DECISIONS.map(d => {
                  const active = decision === d;
                  return (
                    <TouchableOpacity
                      key={d}
                      onPress={() => setDecision(d)}
                      style={[styles.choicePill, active && styles.choicePillActive]}
                      testID={`decision-${d}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <Text style={[styles.choiceText, active && styles.choiceTextActive]}>
                        {t(`decisions.${d}`)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.formLabel}>{t("decideModal.rationaleLabel")}</Text>
              <TextInput
                style={styles.input}
                value={rationale}
                onChangeText={setRationale}
                placeholder={t("decideModal.rationalePlaceholder")}
                placeholderTextColor={Colors.muted}
                multiline
                numberOfLines={3}
                testID="decision-rationale"
              />

              {decision === "index_adjustment" && (
                <>
                  <Text style={styles.formLabel}>{t("decideModal.strokesLabel")}</Text>
                  <TextInput
                    style={styles.input}
                    value={adjStrokes}
                    onChangeText={setAdjStrokes}
                    placeholder={t("decideModal.strokesPlaceholder")}
                    placeholderTextColor={Colors.muted}
                    keyboardType="decimal-pad"
                    testID="decision-strokes"
                  />
                </>
              )}

              {(decision === "soft_cap" || decision === "hard_cap") && (
                <>
                  <Text style={styles.formLabel}>{t("decideModal.capLabel")}</Text>
                  <TextInput
                    style={styles.input}
                    value={adjCap}
                    onChangeText={setAdjCap}
                    placeholder={t("decideModal.capPlaceholder")}
                    placeholderTextColor={Colors.muted}
                    keyboardType="decimal-pad"
                    testID="decision-cap"
                  />
                </>
              )}

              {decision && decision !== "no_action" && (
                <>
                  <Text style={styles.formLabel}>{t("decideModal.notesLabel")}</Text>
                  <TextInput
                    style={styles.input}
                    value={adjNotes}
                    onChangeText={setAdjNotes}
                    placeholder={t("decideModal.notesPlaceholder")}
                    placeholderTextColor={Colors.muted}
                    multiline
                    numberOfLines={2}
                    testID="decision-notes"
                  />
                  <View style={styles.switchRow}>
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={styles.switchTitle}>{t("decideModal.applyToPlayerTitle")}</Text>
                      <Text style={styles.switchHelp}>
                        {t("decideModal.applyToPlayerHelp")}
                      </Text>
                    </View>
                    <Switch
                      value={applyToPlayer}
                      onValueChange={setApplyToPlayer}
                      testID="decision-apply"
                    />
                  </View>
                </>
              )}
            </ScrollView>
            <View style={styles.sheetFooter}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnSecondary]}
                onPress={() => setDecideOpen(false)}
                disabled={submitting}
              >
                <Text style={styles.modalBtnSecondaryText}>{t("memberPicker.cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalBtn,
                  styles.modalBtnPrimary,
                  (!decision || !rationale.trim() || submitting) && styles.modalBtnDisabled,
                ]}
                onPress={submitDecide}
                disabled={!decision || !rationale.trim() || submitting}
                testID="decision-submit"
              >
                {submitting
                  ? <LoadingSpinner color="#0b0b0b" />
                  : <Text style={styles.modalBtnPrimaryText}>{t("decideModal.submit")}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

interface MemberPickerProps {
  visible: boolean;
  title: string;
  subtitle: string;
  members: OrgMember[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitting: boolean;
  membersLoaded: boolean;
  testIDPrefix: string;
}

function MemberPickerModal({
  visible, title, subtitle, members, selectedId, onSelect,
  onClose, onSubmit, submitLabel, submitting, membersLoaded, testIDPrefix,
}: MemberPickerProps) {
  const { t } = useTranslation("handicapCommittee");
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sheetTitle}>{title}</Text>
              <Text style={styles.sheetSubtitle}>{subtitle}</Text>
            </View>
            <TouchableOpacity onPress={onClose} accessibilityLabel={t("common.close")}>
              <Feather name="x" size={20} color={Colors.muted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ maxHeight: 420 }}>
            {!membersLoaded ? (
              <LoadingSpinner color={GOLD} style={{ marginVertical: 24 }} />
            ) : members.length === 0 ? (
              <Text style={styles.emptyText}>{t("memberPicker.noMembers")}</Text>
            ) : (
              members.map(m => {
                const active = selectedId === m.userId;
                return (
                  <TouchableOpacity
                    key={m.userId}
                    onPress={() => onSelect(m.userId)}
                    style={[styles.memberRow, active && styles.memberRowActive]}
                    testID={`${testIDPrefix}-member-${m.userId}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.memberName}>{m.displayName ?? m.email ?? `User #${m.userId}`}</Text>
                      <Text style={styles.memberMeta}>
                        {m.email ?? "—"} · {m.role.replace(/_/g, " ")}
                      </Text>
                    </View>
                    {active ? <Feather name="check" size={18} color={GOLD} /> : null}
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>
          <View style={styles.sheetFooter}>
            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnSecondary]}
              onPress={onClose}
              disabled={submitting}
            >
              <Text style={styles.modalBtnSecondaryText}>{t("memberPicker.cancel")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modalBtn,
                styles.modalBtnPrimary,
                (!selectedId || submitting) && styles.modalBtnDisabled,
              ]}
              onPress={onSubmit}
              disabled={!selectedId || submitting}
              testID={`${testIDPrefix}-submit`}
            >
              {submitting
                ? <LoadingSpinner color="#0b0b0b" />
                : <Text style={styles.modalBtnPrimaryText}>{submitLabel}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 20, fontWeight: "700", color: Colors.text },
  subtitle: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  scroll: { flex: 1 },
  empty: { alignItems: "center", padding: 32, marginTop: 32 },
  emptyInline: { paddingHorizontal: 16, paddingVertical: 12 },
  emptyTitle: { color: Colors.text, fontSize: 15, fontWeight: "600", marginTop: 12 },
  emptyText: { color: Colors.muted, fontSize: 13, textAlign: "center", marginTop: 6, lineHeight: 18 },
  card: {
    backgroundColor: Colors.surface, marginHorizontal: 16, marginTop: 8, padding: 14,
    borderRadius: 12, borderWidth: 1, borderColor: Colors.border,
  },
  summaryRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  statusPill: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  kindText: { color: Colors.muted, fontSize: 12, textTransform: "capitalize" },
  subjectLabel: { color: Colors.muted, fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8 },
  subjectName: { color: Colors.text, fontSize: 15, fontWeight: "600", marginTop: 2 },
  subjectEmail: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  body: { color: Colors.text, fontSize: 13, marginTop: 4, lineHeight: 18 },
  bodyMuted: { color: Colors.muted, fontSize: 12, marginTop: 4, lineHeight: 17 },
  metaText: { color: Colors.muted, fontSize: 11, marginTop: 8 },
  sectionTitle: { color: Colors.text, fontSize: 14, fontWeight: "700", marginTop: 16, marginHorizontal: 16 },
  reviewerName: { color: Colors.text, fontSize: 14, fontWeight: "600" },
  recPill: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  recText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  seenRow: { flexDirection: "row", marginTop: 2, marginBottom: 4 },
  seenPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  seenText: { fontSize: 11, fontWeight: "600" },
  peerSummaryRow: {
    flexDirection: "row", marginHorizontal: 16, marginTop: 16,
  },
  peerSummaryBadge: {
    flexDirection: "row", alignItems: "center", gap: 6,
    borderWidth: 1, borderColor: Colors.border, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 5,
    backgroundColor: Colors.surface,
  },
  peerSummaryBadgeAllSeen: {
    borderColor: `${GOLD}88`, backgroundColor: `${GOLD}22`,
  },
  peerSummaryText: { color: Colors.muted, fontSize: 12, fontWeight: "600" },
  peerSummaryTextAllSeen: { color: Colors.text },
  peerSummaryItem: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 10, paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  peerSummaryItemName: { color: Colors.text, fontSize: 14, fontWeight: "600" },
  peerSummaryItemMeta: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  filterRow: {
    flexDirection: "row", flexWrap: "wrap", gap: 6,
    marginHorizontal: 16, marginTop: 8,
  },
  filterPill: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 5, backgroundColor: Colors.surface,
  },
  filterPillActive: { borderColor: GOLD, backgroundColor: `${GOLD}22` },
  filterText: { color: Colors.muted, fontSize: 11, fontWeight: "600" },
  filterTextActive: { color: Colors.text },
  auditRow: { flexDirection: "row", gap: 10, paddingVertical: 6 },
  auditDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: GOLD, marginTop: 8 },
  auditAction: { color: Colors.text, fontSize: 13, fontWeight: "600", textTransform: "capitalize" },
  actionRow: {
    flexDirection: "row", flexWrap: "wrap", gap: 8,
    marginHorizontal: 16, marginTop: 12,
  },
  actionBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 8, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  actionBtnPrimary: { backgroundColor: GOLD, borderColor: GOLD },
  actionBtnDisabled: { opacity: 0.5 },
  actionBtnText: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  actionBtnTextPrimary: { color: "#0b0b0b" },
  sheetBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24,
    borderTopWidth: 1, borderColor: Colors.border,
  },
  sheetHandle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.border,
    alignSelf: "center", marginBottom: 8,
  },
  sheetHeader: {
    flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between",
    marginBottom: 8, gap: 12,
  },
  sheetTitle: { color: Colors.text, fontSize: 16, fontWeight: "700" },
  sheetSubtitle: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  sheetFooter: {
    flexDirection: "row", gap: 10, marginTop: 12,
  },
  formLabel: {
    color: Colors.muted, fontSize: 11, fontWeight: "600",
    textTransform: "uppercase", letterSpacing: 0.5, marginTop: 12, marginBottom: 6,
  },
  input: {
    backgroundColor: Colors.background, color: Colors.text,
    borderWidth: 1, borderColor: Colors.border, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
    textAlignVertical: "top",
  },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  choicePill: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 6, backgroundColor: Colors.background,
  },
  choicePillActive: { borderColor: GOLD, backgroundColor: `${GOLD}22` },
  choiceText: { color: Colors.muted, fontSize: 12, fontWeight: "600" },
  choiceTextActive: { color: Colors.text },
  switchRow: {
    flexDirection: "row", alignItems: "center",
    marginTop: 14, paddingVertical: 8,
  },
  switchTitle: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  switchHelp: { color: Colors.muted, fontSize: 11, marginTop: 2, lineHeight: 15 },
  modalBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },
  modalBtnPrimary: { backgroundColor: GOLD },
  modalBtnPrimaryText: { color: "#0b0b0b", fontWeight: "700", fontSize: 14 },
  modalBtnSecondary: { backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border },
  modalBtnSecondaryText: { color: Colors.text, fontWeight: "600", fontSize: 14 },
  modalBtnDisabled: { opacity: 0.5 },
  memberRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 12, paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  memberRowActive: { backgroundColor: `${GOLD}11` },
  memberName: { color: Colors.text, fontSize: 14, fontWeight: "600" },
  memberMeta: { color: Colors.muted, fontSize: 12, marginTop: 2 },
});
