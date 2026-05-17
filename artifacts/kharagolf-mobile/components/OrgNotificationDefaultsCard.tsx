import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, ActivityIndicator, TouchableOpacity, Alert, StyleSheet,
  Switch, Modal, ScrollView,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { getApiUrl } from "@/utils/api";

const GOLD = "#C9A84C";

type OrgNotifyDefaultKey =
  | "notifyManualEntryAlerts"
  | "notifyScheduleChanges"
  | "notifyScoreCorrections";

interface OrgNotifyDefaultUiSpec {
  key: OrgNotifyDefaultKey;
  label: string;
  description: string;
  shortName: string;
  enabledBadge: string;
  mutedBadge: string;
  enabledToastDescription: string;
  mutedToastDescription: string;
  enabledApplyToastDescription: string;
  mutedApplyToastDescription: string;
  summaryVerb: string;
  testIdSlug: string;
}

const ORG_NOTIFY_DEFAULTS: readonly OrgNotifyDefaultUiSpec[] = [
  {
    key: "notifyManualEntryAlerts",
    label: "Manual-entry round alerts",
    description:
      "When a round is countersigned with more than 50% of shots entered by hand, tournament directors get a push + email so they can review for data quality. Mute here to silence the alert across every tournament in the club.",
    shortName: "manual-entry alerts",
    enabledBadge: "Alerts on",
    mutedBadge: "Muted",
    enabledToastDescription:
      "Tournament directors will get a push + email when a round is scored mostly by hand.",
    mutedToastDescription:
      "No manual-entry alerts will be sent for any tournament in this club.",
    enabledApplyToastDescription:
      "Manual-entry alerts are now enabled on the matching tournaments.",
    mutedApplyToastDescription:
      "Manual-entry alerts are now muted on the matching tournaments.",
    summaryVerb: "send manual-entry alerts",
    testIdSlug: "manual-entry",
  },
  {
    key: "notifyScheduleChanges",
    label: "Schedule-change alerts",
    description:
      "When start/end dates, round times, or registration deadlines shift after a tournament is published, tournament directors get a push + email so they can re-broadcast the change to entrants.",
    shortName: "schedule-change alerts",
    enabledBadge: "Alerts on",
    mutedBadge: "Muted",
    enabledToastDescription:
      "Tournament directors will get a push + email when a published event\u2019s schedule shifts.",
    mutedToastDescription:
      "No schedule-change alerts will be sent for any tournament in this club.",
    enabledApplyToastDescription:
      "Schedule-change alerts are now enabled on the matching tournaments.",
    mutedApplyToastDescription:
      "Schedule-change alerts are now muted on the matching tournaments.",
    summaryVerb: "send schedule-change alerts",
    testIdSlug: "schedule-changes",
  },
  {
    key: "notifyScoreCorrections",
    label: "Score-correction alerts",
    description:
      "When an admin edits a previously-finalized scorecard, tournament directors get a push + email so they can audit the change.",
    shortName: "score-correction alerts",
    enabledBadge: "Alerts on",
    mutedBadge: "Muted",
    enabledToastDescription:
      "Tournament directors will get a push + email when a finalized scorecard is edited.",
    mutedToastDescription:
      "No score-correction alerts will be sent for any tournament in this club.",
    enabledApplyToastDescription:
      "Score-correction alerts are now enabled on the matching tournaments.",
    mutedApplyToastDescription:
      "Score-correction alerts are now muted on the matching tournaments.",
    summaryVerb: "send score-correction alerts",
    testIdSlug: "score-corrections",
  },
];

type NotifyDefaultsTournament = {
  id: number;
  name: string;
  status: "draft" | "upcoming" | "active" | "suspended";
  startDate: string | null;
} & Record<OrgNotifyDefaultKey, boolean>;

type OrgDefaultsState = Record<OrgNotifyDefaultKey, boolean>;

function defaultDefaultsState(): OrgDefaultsState {
  const out = {} as OrgDefaultsState;
  for (const spec of ORG_NOTIFY_DEFAULTS) out[spec.key] = true;
  return out;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Mobile mirror of the web `OrgNotificationDefaultsCard`
 * (Tasks #1188 / #1379 / #1673). Lets an org admin flip the club-wide
 * default for each supported notification toggle and bulk-apply that
 * default to every still-active tournament whose per-tournament setting
 * differs. Self-hides on 401/403 so the card disappears for non-admin
 * users (matching the web behaviour exactly). Hits the same endpoints:
 *   GET    /api/organizations/:orgId/notification-defaults
 *   GET    /api/organizations/:orgId/notification-defaults/tournaments
 *   PATCH  /api/organizations/:orgId/notification-defaults
 *   POST   /api/organizations/:orgId/notification-defaults/apply-to-tournaments
 */
export function OrgNotificationDefaultsCard({
  orgId,
  token,
}: {
  orgId: number | null | undefined;
  token: string | null | undefined;
}) {
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [defaults, setDefaults] = useState<OrgDefaultsState>(defaultDefaultsState);
  const [tournaments, setTournaments] = useState<NotifyDefaultsTournament[]>([]);
  const [savingKey, setSavingKey] = useState<OrgNotifyDefaultKey | null>(null);
  const [confirmApply, setConfirmApply] = useState<OrgNotifyDefaultKey[] | null>(null);
  const [applying, setApplying] = useState(false);

  const authHeaders = useMemo(
    () => (token ? { Authorization: `Bearer ${token}` } : undefined),
    [token],
  );

  const loadTournaments = async () => {
    if (!orgId || !token) return;
    const r = await fetch(
      getApiUrl(`/organizations/${orgId}/notification-defaults/tournaments`),
      { headers: authHeaders },
    );
    if (!r.ok) return;
    const data = (await r.json()) as { tournaments?: NotifyDefaultsTournament[] };
    setTournaments(data.tournaments ?? []);
  };

  useEffect(() => {
    if (!orgId || !token) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setAllowed(true);
    setDefaults(defaultDefaultsState());
    setTournaments([]);
    Promise.all([
      fetch(getApiUrl(`/organizations/${orgId}/notification-defaults`), {
        headers: { Authorization: `Bearer ${token}` },
      }).then(async (r) => {
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setAllowed(false); return; }
        if (!r.ok) return;
        const data = (await r.json()) as Partial<OrgDefaultsState>;
        setDefaults((prev) => {
          const next = { ...prev };
          for (const spec of ORG_NOTIFY_DEFAULTS) {
            const v = data[spec.key];
            if (typeof v === "boolean") next[spec.key] = v;
          }
          return next;
        });
      }),
      fetch(
        getApiUrl(`/organizations/${orgId}/notification-defaults/tournaments`),
        { headers: { Authorization: `Bearer ${token}` } },
      ).then(async (r) => {
        if (!alive) return;
        if (!r.ok) return;
        const data = (await r.json()) as { tournaments?: NotifyDefaultsTournament[] };
        setTournaments(data.tournaments ?? []);
      }),
    ])
      .catch(() => { /* best-effort */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId, token]);

  if (!orgId || !token) return null;
  if (!allowed) return null;

  const onToggle = async (spec: OrgNotifyDefaultUiSpec, next: boolean) => {
    if (!orgId || !token) return;
    const prev = defaults[spec.key];
    setDefaults((d) => ({ ...d, [spec.key]: next }));
    setSavingKey(spec.key);
    try {
      const res = await fetch(
        getApiUrl(`/organizations/${orgId}/notification-defaults`),
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ [spec.key]: next }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as { error?: string }));
        setDefaults((d) => ({ ...d, [spec.key]: prev }));
        Alert.alert("Could not update", err.error ?? `HTTP ${res.status}`);
        return;
      }
      const verb = next ? "enabled" : "muted";
      Alert.alert(
        `${capitalize(spec.shortName)} ${verb} club-wide`,
        next ? spec.enabledToastDescription : spec.mutedToastDescription,
      );
    } finally {
      setSavingKey(null);
    }
  };

  const onApplyKeys = async (keys: OrgNotifyDefaultKey[]) => {
    if (!orgId || !token || keys.length === 0) return;
    setApplying(true);
    try {
      const body: Record<string, boolean> = {};
      for (const k of keys) body[k] = defaults[k];
      const res = await fetch(
        getApiUrl(
          `/organizations/${orgId}/notification-defaults/apply-to-tournaments`,
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        },
      );
      type ApplyResponse = {
        error?: string;
        results?: Array<{ key: OrgNotifyDefaultKey; value: boolean; updatedCount: number }>;
      };
      const data: ApplyResponse = await res.json().catch(() => ({} as ApplyResponse));
      if (!res.ok) {
        Alert.alert("Apply failed", data.error ?? `HTTP ${res.status}`);
        return;
      }
      const results = Array.isArray(data.results) ? data.results : [];
      if (keys.length === 1) {
        const spec = ORG_NOTIFY_DEFAULTS.find((s) => s.key === keys[0])!;
        const r = results.find((row) => row.key === keys[0]);
        const count = r?.updatedCount ?? 0;
        Alert.alert(
          count === 0
            ? "All tournaments already match the club-wide default"
            : `Applied to ${count} tournament${count === 1 ? "" : "s"}`,
          defaults[spec.key]
            ? spec.enabledApplyToastDescription
            : spec.mutedApplyToastDescription,
        );
      } else {
        const totalChanged = results.reduce(
          (acc: number, row) => acc + row.updatedCount,
          0,
        );
        Alert.alert(
          totalChanged === 0
            ? "All tournaments already match the club-wide defaults"
            : `Applied ${keys.length} default${keys.length === 1 ? "" : "s"} (${totalChanged} update${totalChanged === 1 ? "" : "s"})`,
          results
            .filter((row) => row.updatedCount > 0)
            .map((row) => {
              const spec = ORG_NOTIFY_DEFAULTS.find((s) => s.key === row.key);
              return `${spec?.shortName ?? row.key}: ${row.updatedCount}`;
            })
            .join(" · ") || "No tournaments needed updating.",
        );
      }
      await loadTournaments();
    } finally {
      setApplying(false);
    }
  };

  const totalTournaments = tournaments.length;
  const buckets = ORG_NOTIFY_DEFAULTS.map((spec) => {
    const enabled = tournaments.filter((t) => t[spec.key]).length;
    const divergent = tournaments.filter((t) => t[spec.key] !== defaults[spec.key]).length;
    return {
      spec,
      enabledCount: enabled,
      mutedCount: totalTournaments - enabled,
      divergentCount: divergent,
    };
  });

  const confirmKeys = confirmApply ?? [];
  const confirmBuckets = buckets.filter((b) => confirmKeys.includes(b.spec.key));
  const confirmTotal = confirmBuckets.reduce((acc, b) => acc + b.divergentCount, 0);

  return (
    <View style={styles.card} testID="card-org-notification-defaults">
      <View style={styles.headerRow}>
        <Feather name="bell-off" size={16} color="#fbbf24" />
        <Text style={styles.title}>Club-wide notification defaults</Text>
      </View>
      <Text style={styles.subtitle}>
        Defaults that apply to every tournament in this club. New events
        inherit these at creation time.
      </Text>

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={GOLD} />
          <Text style={styles.loadingText}>Loading defaults…</Text>
        </View>
      ) : (
        <View style={{ marginTop: 4 }}>
          {ORG_NOTIFY_DEFAULTS.map((spec, idx) => {
            const bucket = buckets[idx];
            const value = defaults[spec.key];
            return (
              <View
                key={spec.key}
                style={[
                  styles.toggleBlock,
                  idx > 0 && styles.toggleBlockDivider,
                ]}
                testID={`block-org-notify-${spec.testIdSlug}`}
              >
                <View style={styles.toggleHeader}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.toggleLabel}>{spec.label}</Text>
                    <Text style={styles.toggleDescription}>{spec.description}</Text>
                  </View>
                  <Switch
                    value={value}
                    onValueChange={(next) => onToggle(spec, next)}
                    disabled={savingKey !== null}
                    trackColor={{ false: "#3a3a3a", true: "#d97706" }}
                    thumbColor={value ? "#fbbf24" : "#cccccc"}
                    testID={`switch-org-notify-${spec.testIdSlug}`}
                    accessibilityLabel={`Send ${spec.shortName} club-wide`}
                  />
                </View>

                <View style={styles.inheritanceBlock}>
                  <View style={styles.inheritanceHeaderRow}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text style={styles.inheritanceTitle}>
                        Existing tournaments
                      </Text>
                      <Text style={styles.inheritanceDescription}>
                        The club-wide toggle only affects new events. Existing
                        tournaments keep their per-tournament setting.
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.applyBtn,
                        (applying || savingKey !== null
                          || totalTournaments === 0
                          || bucket.divergentCount === 0) && styles.btnDisabled,
                      ]}
                      disabled={
                        applying || savingKey !== null
                        || totalTournaments === 0
                        || bucket.divergentCount === 0
                      }
                      onPress={() => setConfirmApply([spec.key])}
                      testID={`button-apply-to-tournaments-${spec.testIdSlug}`}
                    >
                      {applying ? (
                        <ActivityIndicator size="small" color={Colors.text} />
                      ) : (
                        <Text style={styles.applyBtnText}>
                          Apply to all ({bucket.divergentCount})
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>

                  {totalTournaments === 0 ? (
                    <Text
                      style={styles.emptyText}
                      testID={`text-no-active-tournaments-${spec.testIdSlug}`}
                    >
                      No active tournaments in this club.
                    </Text>
                  ) : (
                    <View style={styles.summaryRow}>
                      <Text
                        style={styles.summaryText}
                        testID={`text-inheritance-summary-${spec.testIdSlug}`}
                      >
                        <Text style={styles.summaryStrong}>
                          {bucket.enabledCount}
                        </Text>
                        {" of "}
                        <Text style={styles.summaryStrong}>
                          {totalTournaments}
                        </Text>
                        {" active tournament"}
                        {totalTournaments === 1 ? "" : "s"}
                        {" "}
                        {spec.summaryVerb}
                        {bucket.mutedCount > 0
                          ? ` (${bucket.mutedCount} muted)`
                          : ""}
                        .
                      </Text>
                      {bucket.divergentCount > 0 ? (
                        <View
                          style={[styles.badge, styles.badgeWarn]}
                          testID={`badge-inheritance-divergent-${spec.testIdSlug}`}
                        >
                          <Feather name="alert-triangle" size={11} color="#fbbf24" />
                          <Text style={styles.badgeWarnText}>
                            {bucket.divergentCount} don’t match
                          </Text>
                        </View>
                      ) : (
                        <View
                          style={[styles.badge, styles.badgeOk]}
                          testID={`badge-inheritance-aligned-${spec.testIdSlug}`}
                        >
                          <Text style={styles.badgeOkText}>All match</Text>
                        </View>
                      )}
                    </View>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      <ConfirmApplyModal
        visible={confirmApply !== null}
        onClose={() => setConfirmApply(null)}
        confirmBuckets={confirmBuckets}
        confirmTotal={confirmTotal}
        defaults={defaults}
        applying={applying}
        onConfirm={() => {
          const keys = confirmKeys;
          setConfirmApply(null);
          void onApplyKeys(keys);
        }}
      />
    </View>
  );
}

function ConfirmApplyModal({
  visible,
  onClose,
  confirmBuckets,
  confirmTotal,
  defaults,
  applying,
  onConfirm,
}: {
  visible: boolean;
  onClose: () => void;
  confirmBuckets: Array<{
    spec: OrgNotifyDefaultUiSpec;
    enabledCount: number;
    mutedCount: number;
    divergentCount: number;
  }>;
  confirmTotal: number;
  defaults: OrgDefaultsState;
  applying: boolean;
  onConfirm: () => void;
}) {
  const single = confirmBuckets.length === 1 ? confirmBuckets[0] : null;
  const titleText = single
    ? `${defaults[single.spec.key] ? "Enable" : "Mute"} ${single.spec.shortName} on ${single.divergentCount} tournament${single.divergentCount === 1 ? "" : "s"}?`
    : `Apply ${confirmBuckets.length} club-wide defaults to ${confirmTotal} tournament${confirmTotal === 1 ? "" : "s"}?`;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={modalStyles.backdrop}>
        <View style={modalStyles.dialog} testID="dialog-confirm-apply-to-tournaments">
          <Text style={modalStyles.title}>{titleText}</Text>
          <Text style={modalStyles.body}>
            This updates every still-active tournament whose per-tournament
            setting differs from the new club-wide default. Completed and
            cancelled events are left untouched.
          </Text>
          {confirmBuckets.length > 1 ? (
            <ScrollView style={modalStyles.list}>
              {confirmBuckets.map((b) => {
                const targetOn = defaults[b.spec.key];
                return (
                  <View
                    key={b.spec.key}
                    style={modalStyles.listRow}
                    testID={`row-confirm-default-${b.spec.testIdSlug}`}
                  >
                    <Text style={modalStyles.listRowText}>
                      {targetOn ? "Enable" : "Mute"} {b.spec.shortName}
                    </Text>
                    <Text style={modalStyles.listRowCount}>
                      {b.divergentCount} tournament{b.divergentCount === 1 ? "" : "s"}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          ) : null}
          <View style={modalStyles.actions}>
            <TouchableOpacity
              style={modalStyles.btnGhost}
              onPress={onClose}
              testID="button-cancel-apply-to-tournaments"
            >
              <Text style={modalStyles.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[modalStyles.btnPrimary, applying && styles.btnDisabled]}
              disabled={applying}
              onPress={onConfirm}
              testID="button-confirm-apply-to-tournaments"
            >
              {applying ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={modalStyles.btnPrimaryText}>
                  {single
                    ? `Apply to ${confirmTotal} tournament${confirmTotal === 1 ? "" : "s"}`
                    : `Apply ${confirmBuckets.length} default${confirmBuckets.length === 1 ? "" : "s"}`}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: Colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
  subtitle: { color: Colors.muted, fontSize: 12, marginTop: 6, lineHeight: 17 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12 },
  loadingText: { color: Colors.muted, fontSize: 12 },
  toggleBlock: { paddingVertical: 14 },
  toggleBlockDivider: {
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.08)",
  },
  toggleHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  toggleLabel: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  toggleDescription: {
    color: Colors.muted,
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  inheritanceBlock: { marginTop: 12 },
  inheritanceHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  inheritanceTitle: { color: Colors.text, fontSize: 12, fontWeight: "600" },
  inheritanceDescription: {
    color: Colors.muted,
    fontSize: 11,
    marginTop: 3,
    lineHeight: 15,
  },
  applyBtn: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 110,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.5 },
  applyBtnText: { color: Colors.text, fontSize: 11, fontWeight: "600" },
  emptyText: { color: Colors.muted, fontSize: 12, marginTop: 10 },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },
  summaryText: { color: Colors.text, fontSize: 11, flex: 1, minWidth: 200 },
  summaryStrong: { fontWeight: "700" },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeWarn: {
    borderColor: "rgba(251,191,36,0.4)",
    backgroundColor: "rgba(251,191,36,0.08)",
  },
  badgeWarnText: { color: "#fbbf24", fontSize: 11, fontWeight: "600" },
  badgeOk: {
    borderColor: "rgba(16,185,129,0.4)",
    backgroundColor: "rgba(16,185,129,0.08)",
  },
  badgeOkText: { color: "#10b981", fontSize: 11, fontWeight: "600" },
});

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  dialog: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 18,
    width: "100%",
    maxWidth: 420,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  title: { color: Colors.text, fontSize: 15, fontWeight: "700" },
  body: { color: Colors.muted, fontSize: 12, marginTop: 8, lineHeight: 17 },
  list: { marginTop: 12, maxHeight: 200 },
  listRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  listRowText: { color: Colors.text, fontSize: 12, flex: 1 },
  listRowCount: { color: Colors.muted, fontSize: 12 },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 16,
  },
  btnGhost: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  btnGhostText: { color: Colors.text, fontSize: 12, fontWeight: "600" },
  btnPrimary: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: "#d97706",
  },
  btnPrimaryText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
