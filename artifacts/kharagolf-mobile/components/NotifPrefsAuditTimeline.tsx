import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, ActivityIndicator, TouchableOpacity, StyleSheet,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { getApiUrl } from "@/utils/api";

const GOLD = "#C9A84C";

interface FieldChange {
  from: unknown;
  to: unknown;
}

interface MemberAuditLogEntry {
  id: number;
  createdAt: string;
  actorUserId: number | null;
  actorName: string | null;
  actorRole: string | null;
  entity: string;
  entityId: number;
  action: string;
  fieldChanges: Record<string, FieldChange> | null;
  reason: string | null;
  metadata: unknown;
}

interface MemberAuditLogResponse {
  entries: MemberAuditLogEntry[];
  limit: number;
}

/**
 * Mobile mirror of the web `NotifPrefsAuditTimeline` rendered inline in the
 * Players page expanded row (Task #1505). Surfaces the per-member
 * `member_audit_log` rows where entity='comm_prefs' so org admins on the
 * mobile app can self-audit "who muted this member's notifications and when?"
 * without having to switch to the web portal (Task #1853).
 *
 * Hits the same endpoint as the web component:
 *   GET /api/organizations/:orgId/members/:userId/audit-log?entity=comm_prefs&limit=20
 *
 * Defense-in-depth: the endpoint already requires org admin, but the card
 * also self-hides on 401/403 so a non-admin who somehow reaches the host
 * screen never sees a stale empty card. Loading / error / empty states
 * mirror the web copy exactly.
 */
const COMM_PREFS_FIELD_LABELS: Record<string, string> = {
  notifySideGameReceipts: "Side-game receipts",
  preferEmail: "Email channel",
  preferPush: "Push channel",
  preferSms: "SMS channel",
  preferWhatsapp: "WhatsApp channel",
  notifyMemberDocuments: "Member documents",
  notifyCommitteePeerDigest: "Committee peer digest",
  notifyManualEntryAlerts: "Manual entry alerts",
  notifyCoachPayoutAccountChanges: "Coach payout changes",
  notifyDataExportExpiring: "Data export expiring",
  notifyErasureStorageDigest: "Erasure storage digest (email)",
  notifyErasureStorageDigestPush: "Erasure storage digest (push)",
  digestMode: "Digest mode",
};

function formatPrefValue(v: unknown): string {
  if (v === true) return "On";
  if (v === false) return "Off";
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  return JSON.stringify(v);
}

export function NotifPrefsAuditTimeline({
  orgId,
  userId,
  token,
}: {
  orgId: number | null | undefined;
  userId: number | null | undefined;
  token: string | null | undefined;
}) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [allowed, setAllowed] = useState(true);
  const [error, setError] = useState(false);
  const [data, setData] = useState<MemberAuditLogResponse | null>(null);

  // Stale-response guard: bumped on every (orgId, userId, token) change AND
  // every refresh. Each in-flight fetch captures its own request id; only
  // the latest one is allowed to commit results to state. Without this, a
  // slow previous request (e.g. admin tapped member A, then quickly tapped
  // member B) could overwrite the newer member's timeline. Audit surfaces
  // are read very intentionally, so showing the wrong member's history is
  // a real correctness bug.
  const requestIdRef = useRef(0);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    if (!orgId || !userId || !token) return;
    const requestId = ++requestIdRef.current;
    if (mode === "initial") setLoading(true); else setRefreshing(true);
    setError(false);
    try {
      const r = await fetch(
        getApiUrl(`/organizations/${orgId}/members/${userId}/audit-log?entity=comm_prefs&limit=20`),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (requestId !== requestIdRef.current) return;
      if (r.status === 401 || r.status === 403) {
        setAllowed(false);
        return;
      }
      if (!r.ok) {
        setError(true);
        return;
      }
      const body = (await r.json()) as MemberAuditLogResponse;
      if (requestId !== requestIdRef.current) return;
      setData(body);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setError(true);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [orgId, userId, token]);

  // Reset and re-fetch when the (orgId, userId, token) triple changes — e.g.
  // the parent picker swapping which member's history is being shown. The
  // request-id bump in `load` automatically invalidates any in-flight call
  // from the previous member.
  useEffect(() => {
    setAllowed(true);
    setError(false);
    setData(null);
    if (orgId && userId && token) {
      void load("initial");
    } else {
      setLoading(false);
    }
  }, [orgId, userId, token, load]);

  if (!orgId || !userId || !token) return null;
  if (!allowed) return null;

  const entries = data?.entries ?? [];

  return (
    <View testID={`comm-prefs-audit-${userId}`} style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.titleRow}>
          <Feather name="clock" size={13} color={Colors.muted} />
          <Text style={styles.titleText}>Notification preference history</Text>
        </View>
        <TouchableOpacity
          disabled={loading || refreshing}
          onPress={() => void load("refresh")}
          style={styles.refreshBtn}
          testID={`comm-prefs-audit-refresh-${userId}`}
          accessibilityLabel="Refresh notification preference history"
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={Colors.muted} />
          ) : (
            <Feather name="refresh-cw" size={11} color={Colors.muted} />
          )}
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <Text style={styles.helperText}>Loading history…</Text>
      ) : error ? (
        <Text style={styles.errorText} testID={`comm-prefs-audit-error-${userId}`}>
          Couldn’t load preference history.
        </Text>
      ) : entries.length === 0 ? (
        <Text style={styles.helperText} testID={`comm-prefs-audit-empty-${userId}`}>
          No admin overrides recorded for this member's notification preferences.
        </Text>
      ) : (
        <View style={styles.list}>
          {entries.map((e) => {
            const changes = e.fieldChanges ?? {};
            const changeKeys = Object.keys(changes);
            const actorLabel = e.actorName ?? "system";
            return (
              <View
                key={e.id}
                style={styles.entry}
                testID={`comm-prefs-audit-row-${e.id}`}
              >
                <Feather name="bell-off" size={12} color="#fbbf24" style={styles.entryIcon} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  {changeKeys.length > 0 ? (
                    <View>
                      {changeKeys.map((key) => {
                        const c = changes[key];
                        const label = COMM_PREFS_FIELD_LABELS[key] ?? key;
                        const toOff = c?.to === false;
                        return (
                          <Text key={key} style={styles.entryText}>
                            <Text style={styles.entryFieldLabel}>{label}: </Text>
                            <Text style={styles.entryFrom}>{formatPrefValue(c?.from)}</Text>
                            <Text style={styles.entryArrow}> → </Text>
                            <Text style={toOff ? styles.entryToOff : styles.entryToOn}>
                              {formatPrefValue(c?.to)}
                            </Text>
                          </Text>
                        );
                      })}
                    </View>
                  ) : (
                    <Text style={styles.entryText}>
                      <Text style={styles.entryFieldLabel}>{e.action}</Text>
                      <Text style={styles.entryMeta}> · no field-level diff recorded</Text>
                    </Text>
                  )}
                  {e.reason ? (
                    <Text style={styles.entryReason}>“{e.reason}”</Text>
                  ) : null}
                  <Text style={styles.entryMeta}>
                    by <Text style={styles.entryActor}>{actorLabel}</Text>
                    {e.actorRole ? ` · ${e.actorRole.replace(/_/g, " ")}` : ""}
                    {" · "}
                    {new Date(e.createdAt).toLocaleString()}
                  </Text>
                </View>
              </View>
            );
          })}
          {data && entries.length === data.limit ? (
            <Text style={styles.helperText}>
              Showing the most recent {data.limit} entries.
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 4 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  titleText: {
    color: Colors.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  refreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  refreshText: { color: Colors.muted, fontSize: 11 },
  helperText: {
    color: Colors.muted,
    fontSize: 12,
    fontStyle: "italic",
    paddingVertical: 4,
  },
  errorText: {
    color: GOLD,
    fontSize: 12,
    fontStyle: "italic",
    paddingVertical: 4,
  },
  list: { gap: 6 },
  entry: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.25)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  entryIcon: { marginTop: 2 },
  entryText: { color: Colors.text, fontSize: 12, lineHeight: 16 },
  entryFieldLabel: { color: Colors.text, fontWeight: "600" },
  entryFrom: { color: Colors.muted },
  entryArrow: { color: Colors.muted },
  entryToOn: { color: "#34d399" },
  entryToOff: { color: "#fbbf24" },
  entryReason: {
    color: Colors.muted,
    fontSize: 11,
    fontStyle: "italic",
    marginTop: 2,
  },
  entryMeta: { color: Colors.muted, fontSize: 11, marginTop: 2 },
  entryActor: { color: Colors.text },
});
