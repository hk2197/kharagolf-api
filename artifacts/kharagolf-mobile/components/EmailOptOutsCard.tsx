import React, { useEffect, useState } from "react";
import {
  View, Text, ActivityIndicator, TouchableOpacity, Alert, StyleSheet,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { getApiUrl } from "@/utils/api";
import { getLocale } from "@/i18n";

const GOLD = "#C9A84C";

export interface EmailOptOut {
  userId: number;
  email: string | null;
  displayName: string;
  optedOutAt: string;
}

export interface EmailOptOutsCardProps {
  orgId: number | null | undefined;
  token: string | null | undefined;
  /**
   * Path segment under `/api/organizations/:orgId/` for both the GET (list)
   * and DELETE (re-subscribe) endpoints. e.g. `tie-break-email-opt-outs`
   * or `bounced-digest-schedule-opt-outs`.
   */
  endpointPath: string;
  iconName: React.ComponentProps<typeof Feather>["name"];
  title: string;
  subtitle: string;
  emptyText: string;
  /**
   * Build the success Alert message body shown after a successful
   * re-subscribe (e.g. `${label} will receive tie-break alert emails again.`).
   */
  buildResubscribeSuccessMessage: (label: string) => string;
  cardTestID: string;
  emptyTextTestID: string;
  listTestID: string;
  resubscribeTestIDPrefix: string;
}

/**
 * Shared mobile card that lists members who opted out of a given admin
 * email and lets an org admin re-subscribe them. Used by both
 * `TieBreakEmailOptOutsCard` (Task #1402) and `ScheduleChangeOptOutsCard`
 * (Task #1688) — see Task #2098 for the consolidation that extracted
 * this component so future changes (translation, accessibility, new
 * columns) only happen in one place.
 *
 * Self-hides on 401/403 so the section disappears for non-admin users
 * (matching the web behaviour exactly). Hits:
 *   GET    /api/organizations/:orgId/{endpointPath}
 *   DELETE /api/organizations/:orgId/{endpointPath}/:userId
 */
export function EmailOptOutsCard({
  orgId,
  token,
  endpointPath,
  iconName,
  title,
  subtitle,
  emptyText,
  buildResubscribeSuccessMessage,
  cardTestID,
  emptyTextTestID,
  listTestID,
  resubscribeTestIDPrefix,
}: EmailOptOutsCardProps) {
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [rows, setRows] = useState<EmailOptOut[]>([]);
  const [resubscribing, setResubscribing] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!orgId || !token) { setLoading(false); return; }
    let alive = true;
    // Reset state so switching from an unauthorized org to one where the
    // user IS an admin re-shows the card (and vice-versa). Without this
    // a stale `allowed=false` from the previous org would keep the
    // section hidden after the user switches clubs.
    setLoading(true);
    setAllowed(true);
    setRows([]);
    fetch(getApiUrl(`/organizations/${orgId}/${endpointPath}`), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setAllowed(false); return; }
        if (!r.ok) return;
        const data = (await r.json()) as EmailOptOut[];
        setRows(data);
      })
      .catch(() => { /* best-effort — leave loading off, allowed unchanged */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId, token, endpointPath]);

  const resubscribe = async (userId: number, label: string) => {
    if (!orgId || !token) return;
    setResubscribing((prev) => ({ ...prev, [userId]: true }));
    try {
      const res = await fetch(
        getApiUrl(`/organizations/${orgId}/${endpointPath}/${userId}`),
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok && res.status !== 204) {
        const err = await res.json().catch(() => ({} as { error?: string }));
        Alert.alert("Could not re-subscribe", err.error ?? `HTTP ${res.status}`);
        return;
      }
      setRows((prev) => prev.filter((r) => r.userId !== userId));
      Alert.alert("Re-subscribed", buildResubscribeSuccessMessage(label));
    } finally {
      setResubscribing((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    }
  };

  if (!orgId || !token) return null;
  if (!allowed) return null;

  return (
    <View style={styles.card} testID={cardTestID}>
      <View style={styles.headerRow}>
        <Feather name={iconName} size={16} color="#fbbf24" />
        <Text style={styles.title}>{title}</Text>
      </View>
      <Text style={styles.subtitle}>{subtitle}</Text>
      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={GOLD} />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      ) : rows.length === 0 ? (
        <Text style={styles.emptyText} testID={emptyTextTestID}>
          {emptyText}
        </Text>
      ) : (
        <View style={styles.list} testID={listTestID}>
          {rows.map((r) => (
            <View key={r.userId} style={styles.row}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {r.displayName}
                </Text>
                {r.email ? (
                  <Text style={styles.rowEmail} numberOfLines={1}>{r.email}</Text>
                ) : null}
                <Text style={styles.rowDate}>
                  {new Date(r.optedOutAt).toLocaleDateString(getLocale())}
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.btn, !!resubscribing[r.userId] && styles.btnDisabled]}
                disabled={!!resubscribing[r.userId]}
                onPress={() => resubscribe(r.userId, r.displayName)}
                testID={`${resubscribeTestIDPrefix}${r.userId}`}
              >
                {resubscribing[r.userId] ? (
                  <ActivityIndicator size="small" color={Colors.text} />
                ) : (
                  <Text style={styles.btnText}>Re-subscribe</Text>
                )}
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
    </View>
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
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  loadingText: { color: Colors.muted, fontSize: 12 },
  emptyText: { color: Colors.muted, fontSize: 12, marginTop: 10 },
  list: { marginTop: 10, gap: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  rowName: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  rowEmail: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  rowDate: { color: Colors.muted, fontSize: 11, marginTop: 2 },
  btn: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 96,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: Colors.text, fontSize: 12, fontWeight: "600" },
});
