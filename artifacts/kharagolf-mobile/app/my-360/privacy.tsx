import React, { useEffect, useState, useCallback } from "react";
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { BASE_URL, authedFetch, useActingMemberId, actingQs } from "./_shared";
import { PrivacyResendStatus } from "./PrivacyResendStatus";

interface DataRequest {
  id: number; requestType: string; status: string;
  requestedAt: string; dueBy: string | null; resolvedAt: string | null;
  notes: string | null; artifactUrl: string | null;
  lastNotificationKind: string | null; lastNotifiedAt: string | null;
  lastEmailStatus: string | null; lastEmailAt: string | null;
  lastInAppMessageId: number | null; lastInAppAt: string | null;
  lastPushStatus: string | null; lastPushAt: string | null;
  lastSmsStatus: string | null; lastSmsAt: string | null;
}

type ChannelTone = "ok" | "warn" | "muted" | "fail";
const TONE_BG: Record<ChannelTone, string> = { ok: "#16653440", warn: "#78350f40", muted: "#27272a", fail: "#7f1d1d40" };
const TONE_FG: Record<ChannelTone, string> = { ok: "#22c55e", warn: "#fbbf24", muted: "#a1a1aa", fail: "#fca5a5" };

// Task #1076: render the remaining lifetime of a signed export URL as a
// human-friendly countdown ("Expires in 2 days", "Expires in 5 hours") so
// members can see at a glance how long they have before the daily purge cron
// removes the archive. Returns null when the export is already expired or has
// no expiry (e.g. failed/pending) — callers fall back to the existing label.
function formatExportCountdown(expiresAt: string | null | undefined): { label: string; urgent: boolean } | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  // Amber threshold matches the daily "expires in 24h" reminder cron window
  // so the visual urgency lines up with when the email/in-app nudge fires.
  const urgent = hours < 24;
  if (hours < 1) {
    const minutes = Math.max(1, Math.floor(ms / (60 * 1000)));
    return { label: `Expires in ${minutes} minute${minutes === 1 ? "" : "s"}`, urgent: true };
  }
  if (hours < 24) {
    return { label: `Expires in ${hours} hour${hours === 1 ? "" : "s"}`, urgent };
  }
  const days = Math.floor(hours / 24);
  return { label: `Expires in ${days} day${days === 1 ? "" : "s"}`, urgent };
}

function channelTone(status: string | null): ChannelTone {
  switch (status) {
    case "sent": return "ok";
    case "failed": return "fail";
    case "no_address":
    case "no_user": return "warn";
    case "opted_out":
    case "skipped": return "muted";
    default: return "muted";
  }
}
function channelLabel(status: string | null): string {
  if (!status) return "n/a";
  if (status === "no_address") return "no address";
  if (status === "no_user") return "no device";
  if (status === "opted_out") return "opted out";
  if (status === "not_recorded") return "not recorded";
  return status;
}

// Account deletion is filed via the dedicated /portal/my-account-deletion
// endpoint (Task #381) so we don't surface "erasure" alongside the lighter
// access / rectification requests — full account deletion has a 30-day grace
// period and a separate confirmation flow.
const REQUEST_TYPES: { key: string; label: string; description: string }[] = [
  { key: "access", label: "Request access", description: "Get a summary of personal data we hold about you." },
  { key: "portability", label: "Data portability", description: "Receive your data in a machine-readable format." },
  { key: "rectification", label: "Correct my data", description: "Ask us to update inaccurate personal data." },
];

interface AccountDeletion {
  pending: { id: number; status: string; requestedAt: string; dueBy: string | null } | null;
  gracePeriodDays: number;
  gracePeriodEndsAt: string | null;
  canCancel: boolean;
}

interface DataExport {
  id: number; status: string; requestedAt: string; resolvedAt: string | null;
  artifactUrl: string | null;
  computedStatus: "pending" | "ready" | "expired" | "failed";
  expiresAt: string | null;
  // Task #773: stamped by the daily purge cron when the archive file is
  // actually removed from object storage. NULL on legacy rows that were
  // cleared before the column existed; the UI then falls back to expiresAt.
  purgedAt: string | null;
  downloadUrl: string | null;
  signedUrlEndpoint: string | null;
}
// Task #970: cron-written audit entries (entity=data_export) so the mobile
// "My data" timeline can show members exactly when the system auto-deleted
// each archive — closing the data-minimisation guarantee visibly.
interface DataExportAuditEntry {
  id: number;
  exportId: number | null;
  action: string;
  reason: string | null;
  source: string | null;
  createdAt: string;
  actorName: string | null;
}
interface DataExportsResponse {
  exports: DataExport[];
  validForDays: number;
  auditEntries?: DataExportAuditEntry[];
}

export default function PrivacyScreen() {
  const { token } = useAuth();
  const [acting] = useActingMemberId();
  const [requests, setRequests] = useState<DataRequest[]>([]);
  const [deletion, setDeletion] = useState<AccountDeletion | null>(null);
  const [exports, setExports] = useState<DataExport[]>([]);
  const [exportAuditEntries, setExportAuditEntries] = useState<DataExportAuditEntry[]>([]);
  const [exportValidDays, setExportValidDays] = useState<number>(7);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [resending, setResending] = useState<number | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [requestingExport, setRequestingExport] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    const [rows, del, exp] = await Promise.all([
      authedFetch<DataRequest[]>(`/api/portal/my-data-requests${actingQs({ actingMemberId: acting })}`, token).catch(() => []),
      authedFetch<AccountDeletion>(`/api/portal/my-account-deletion${actingQs({ actingMemberId: acting })}`, token).catch(() => null),
      authedFetch<DataExportsResponse>(`/api/portal/my-data-export${actingQs({ actingMemberId: acting })}`, token).catch(() => null),
    ]);
    setRequests(rows);
    setDeletion(del);
    setExports(exp?.exports ?? []);
    setExportAuditEntries(exp?.auditEntries ?? []);
    if (exp?.validForDays) setExportValidDays(exp.validForDays);
  }, [token, acting]);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  const file = (key: string, label: string) => {
    Alert.alert(label, `Submit a ${label.toLowerCase()} request? Your club has 30 days to respond.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Submit", style: "destructive", onPress: async () => {
          if (!token) return;
          setSubmitting(key);
          try {
            await authedFetch(`/api/portal/my-data-requests${actingQs({ actingMemberId: acting })}`, token, {
              method: "POST",
              body: JSON.stringify({ requestType: key }),
            });
            await load();
            Alert.alert("Submitted", "Your request has been recorded. The club will respond within 30 days.");
          } catch (e) {
            Alert.alert("Could not submit", (e as Error).message);
          } finally {
            setSubmitting(null);
          }
        },
      },
    ]);
  };

  const resend = (r: DataRequest) => {
    Alert.alert(
      "Resend acknowledgement",
      "Ask the club to re-send the most recent privacy notice for this request?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Resend", onPress: async () => {
            if (!token) return;
            setResending(r.id);
            try {
              await authedFetch(`/api/portal/my-data-requests/${r.id}/resend${actingQs({ actingMemberId: acting })}`, token, {
                method: "POST",
              });
              await load();
              Alert.alert("Resent", "We have re-sent the notice across the available channels.");
            } catch (e) {
              Alert.alert("Could not resend", (e as Error).message);
            } finally {
              setResending(null);
            }
          },
        },
      ],
    );
  };

  // Task #468 — request a tracked archive export. Idempotent: if a pending
  // export already exists the server returns it, so the button is safe to tap
  // multiple times without queuing duplicates.
  const requestArchiveExport = async () => {
    if (!token || requestingExport) return;
    setRequestingExport(true);
    try {
      await authedFetch(`/api/portal/my-data-export${actingQs({ actingMemberId: acting })}`, token, {
        method: "POST", body: JSON.stringify({}),
      });
      await load();
      Alert.alert("Export requested", "We will keep your archive available for 7 days. Tap the latest entry to download.");
    } catch (e) {
      Alert.alert("Could not request export", (e as Error).message);
    } finally {
      setRequestingExport(false);
    }
  };

  // Append additional query params to a URL string in a way that works whether
  // or not the URL already has a `?`. The previous implementation
  // (`actingQs(...).replace(/^\?/, "&")`) was buggy because it always assumed
  // a `?` was already present, producing URLs like `/download&actingMemberId=…`
  // when the base path had no query string. This helper does the right thing.
  const appendQuery = (url: string, qs: string) => {
    if (!qs) return url;
    const params = qs.startsWith("?") ? qs.slice(1) : qs;
    if (!params) return url;
    return url + (url.includes("?") ? "&" : "?") + params;
  };

  const downloadArchive = async (e: DataExport) => {
    if (!token || !e.downloadUrl) return;
    try {
      let url: string;
      let needsAuthHeader = true;
      // Prefer a real signed object-storage URL (mints from /signed-url) so we
      // can fetch the archive directly from storage with no auth. Fall back to
      // the authenticated proxy /download endpoint if the signed-url endpoint
      // can't be reached or the object isn't present.
      if (e.signedUrlEndpoint) {
        try {
          const signedRes = await authedFetch<{ url: string; signed: boolean }>(
            appendQuery(e.signedUrlEndpoint, actingQs({ actingMemberId: acting })),
            token,
          );
          // If the server returned an absolute (signed) URL, fetch it directly
          // without our bearer token. If it returned a relative proxy URL, we
          // still need our auth header.
          if (signedRes.signed && /^https?:\/\//i.test(signedRes.url)) {
            url = signedRes.url;
            needsAuthHeader = false;
          } else {
            url = signedRes.url.startsWith("http") ? signedRes.url : `${BASE_URL}${signedRes.url}`;
            url = appendQuery(url, actingQs({ actingMemberId: acting }));
          }
        } catch {
          url = appendQuery(`${BASE_URL}${e.downloadUrl}`, actingQs({ actingMemberId: acting }));
        }
      } else {
        url = appendQuery(`${BASE_URL}${e.downloadUrl}`, actingQs({ actingMemberId: acting }));
      }
      const filename = `kharagolf-export-${e.id}.json`;
      const target = `${FileSystem.cacheDirectory ?? ""}${filename}`;
      const result = await FileSystem.downloadAsync(url, target, {
        headers: needsAuthHeader ? { Authorization: `Bearer ${token}` } : {},
      });
      if (result.status >= 400) throw new Error(`Server returned ${result.status}`);
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(result.uri, { mimeType: "application/json", dialogTitle: "Save your data export" });
      } else {
        Alert.alert("Saved", `Export saved to ${result.uri}`);
      }
    } catch (err) {
      Alert.alert("Download failed", (err as Error).message);
    }
  };

  const [exporting, setExporting] = useState(false);
  const downloadExport = async () => {
    if (!token || exporting) return;
    setExporting(true);
    try {
      const url = `${BASE_URL}/api/portal/my-export${actingQs({ actingMemberId: acting })}`;
      const filename = `kharagolf-export-${Date.now()}.json`;
      const target = `${FileSystem.cacheDirectory ?? ""}${filename}`;
      const result = await FileSystem.downloadAsync(url, target, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (result.status >= 400) {
        throw new Error(`Server returned ${result.status}`);
      }
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(result.uri, { mimeType: "application/json", dialogTitle: "Save your data export" });
      } else {
        Alert.alert("Saved", `Export saved to ${result.uri}`);
      }
    } catch (e) {
      Alert.alert("Export failed", (e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <View style={styles.center}><LoadingSpinner color={Colors.primary} /></View>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: Colors.background }} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.intro}>
        Under data-protection law (GDPR / DPDP) you may exercise the rights below at any time.
      </Text>

      <TouchableOpacity style={styles.exportBtn} onPress={downloadExport} activeOpacity={0.75} disabled={exporting}>
        {exporting
          ? <LoadingSpinner color="#fff" />
          : <><Feather name="download" size={18} color="#fff" /><Text style={styles.exportText}>Instant data export (JSON)</Text></>}
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Export my data</Text>
      <Text style={styles.description}>
        Generate a tracked archive of your data. Archives stay available for {exportValidDays} days
        and are recorded so the club can audit access requests under GDPR / DPDP.
      </Text>
      <TouchableOpacity
        style={[styles.exportBtn, { marginTop: 10, backgroundColor: "#0ea5e9" }]}
        onPress={requestArchiveExport}
        activeOpacity={0.75}
        disabled={requestingExport}
        testID="request-data-export"
      >
        {requestingExport
          ? <LoadingSpinner color="#fff" />
          : <><Feather name="archive" size={18} color="#fff" /><Text style={styles.exportText}>Export my data</Text></>}
      </TouchableOpacity>
      {exports.length > 0 && (
        <View style={{ marginTop: 8 }}>
          {exports.map(e => {
            // Task #1076: when the archive is still downloadable, surface a
            // live countdown ("Expires in 2 days") and flip the badge tone to
            // amber inside the last 24h so the deadline matches the reminder
            // cron's window.
            const countdown = e.computedStatus === "ready" ? formatExportCountdown(e.expiresAt) : null;
            // Task #1123: once the daily purge cron clears the archive
            // (purgedAt set, or computedStatus has flipped to "expired") swap
            // the live countdown for a static "Expired on <date>" badge so the
            // member can still see exactly when the download window closed —
            // mirroring the deadline they were nudged about by email.
            const expiredOnDate = (() => {
              if (e.computedStatus !== "expired") return null;
              const src = e.purgedAt ?? e.expiresAt;
              if (!src) return null;
              const d = new Date(src);
              return Number.isFinite(d.getTime()) ? d : null;
            })();
            const tone =
              e.computedStatus === "ready"
                ? (countdown?.urgent ? "warn" : "ok")
                : e.computedStatus === "pending" ? "warn"
                : e.computedStatus === "failed" ? "fail" : "muted";
            return (
              <TouchableOpacity
                key={e.id}
                style={styles.requestCard}
                activeOpacity={e.computedStatus === "ready" ? 0.75 : 1}
                disabled={e.computedStatus !== "ready"}
                onPress={() => downloadArchive(e)}
                testID={`data-export-${e.id}`}
              >
                <View style={styles.requestHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Archive #{e.id}</Text>
                    <Text style={styles.description}>
                      Requested {new Date(e.requestedAt).toLocaleString()}
                      {e.purgedAt
                        ? ` · auto-deleted by the system on ${new Date(e.purgedAt).toLocaleDateString()}`
                        : e.expiresAt ? ` · expires ${new Date(e.expiresAt).toLocaleDateString()}` : ""}
                    </Text>
                    {countdown && (
                      <Text
                        testID={`data-export-countdown-${e.id}`}
                        style={[
                          styles.description,
                          { marginTop: 4, fontWeight: "600", color: countdown.urgent ? TONE_FG.warn : TONE_FG.ok },
                        ]}
                      >
                        {countdown.label}
                        {countdown.urgent ? " — download soon" : ""}
                      </Text>
                    )}
                    {expiredOnDate && (
                      <Text
                        testID={`data-export-expired-on-${e.id}`}
                        style={[
                          styles.description,
                          { marginTop: 4, fontWeight: "600", color: TONE_FG.muted },
                        ]}
                      >
                        Expired on {expiredOnDate.toLocaleDateString()}
                      </Text>
                    )}
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: TONE_BG[tone] }]}>
                    <Text style={[styles.statusText, { color: TONE_FG[tone] }]}>
                      {e.computedStatus.toUpperCase()}
                    </Text>
                  </View>
                </View>
                {e.computedStatus === "ready" && (
                  <Text style={[styles.description, { marginTop: 6, color: TONE_FG.ok }]}>
                    Tap to download.
                  </Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {exportAuditEntries.length > 0 && (
        <View style={{ marginTop: 12 }} testID="data-export-audit-timeline">
          <Text style={styles.label}>Data-export activity</Text>
          <Text style={styles.description}>
            A log of when your archives were created or auto-deleted.
          </Text>
          {exportAuditEntries.map(a => {
            const isPurge = a.action === "purge";
            const isCron = a.source === "cron";
            const friendly = isPurge
              ? `Data export${a.exportId ? ` #${a.exportId}` : ""} was auto-deleted on ${new Date(a.createdAt).toLocaleDateString()} by the system`
              : `Data export${a.exportId ? ` #${a.exportId}` : ""} ${a.action}`;
            return (
              <View
                key={a.id}
                style={[styles.requestCard, { marginTop: 6 }]}
                testID={`data-export-audit-${a.id}`}
              >
                <View style={styles.requestHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>{friendly}</Text>
                    <Text style={styles.description}>
                      {new Date(a.createdAt).toLocaleString()}
                      {a.reason ? ` · ${a.reason}` : ""}
                    </Text>
                  </View>
                  {isCron && (
                    <View
                      style={[styles.statusBadge, { backgroundColor: "#0c4a6e40" }]}
                      testID={`data-export-audit-source-${a.id}`}
                    >
                      <Text style={[styles.statusText, { color: "#7dd3fc" }]}>
                        SYSTEM
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      <Text style={styles.sectionTitle}>Account deletion</Text>
      {deletion?.pending ? (
        <View style={styles.requestCard}>
          <Text style={styles.label}>Deletion scheduled</Text>
          <Text style={styles.description}>
            Filed {new Date(deletion.pending.requestedAt).toLocaleDateString()}.
            {deletion.gracePeriodEndsAt
              ? ` Your account and personal data will be erased after ${new Date(deletion.gracePeriodEndsAt).toLocaleDateString()}.`
              : ""}
          </Text>
          <Text style={[styles.description, { marginTop: 6 }]}>
            You can cancel any time within the {deletion.gracePeriodDays}-day grace period.
          </Text>
          {deletion.canCancel && (
            <TouchableOpacity
              style={[styles.exportBtn, { marginTop: 10, backgroundColor: "#374151" }]}
              activeOpacity={0.75}
              disabled={deletingAccount}
              onPress={() => Alert.alert("Cancel deletion?", "Your account will remain active and the scheduled deletion will be withdrawn.", [
                { text: "Keep deletion", style: "cancel" },
                {
                  text: "Cancel deletion", onPress: async () => {
                    if (!token) return;
                    setDeletingAccount(true);
                    try {
                      await authedFetch(`/api/portal/my-account-deletion${actingQs({ actingMemberId: acting })}`, token, { method: "DELETE" });
                      await load();
                      Alert.alert("Cancelled", "Your account deletion has been withdrawn.");
                    } catch (e) {
                      Alert.alert("Could not cancel", (e as Error).message);
                    } finally { setDeletingAccount(false); }
                  },
                },
              ])}
            >
              {deletingAccount ? <LoadingSpinner color="#fff" /> : <Text style={styles.exportText}>Cancel deletion</Text>}
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <TouchableOpacity
          style={[styles.card, { borderColor: "#7f1d1d80" }]}
          activeOpacity={0.75}
          disabled={deletingAccount}
          onPress={() => Alert.alert(
            "Delete my account",
            "Your account and all personal data will be erased after a 30-day grace period. You can cancel any time within those 30 days. Continue?",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete my account", style: "destructive", onPress: async () => {
                  if (!token) return;
                  setDeletingAccount(true);
                  try {
                    await authedFetch(`/api/portal/my-account-deletion${actingQs({ actingMemberId: acting })}`, token, {
                      method: "POST", body: JSON.stringify({}),
                    });
                    await load();
                    Alert.alert("Scheduled", "Your account deletion is scheduled. You can cancel within 30 days.");
                  } catch (e) {
                    Alert.alert("Could not schedule", (e as Error).message);
                  } finally { setDeletingAccount(false); }
                },
              },
            ],
          )}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.label, { color: "#fca5a5" }]}>Delete my account</Text>
            <Text style={styles.description}>Schedules permanent deletion after a 30-day grace period.</Text>
          </View>
          {deletingAccount
            ? <LoadingSpinner color={Colors.primary} />
            : <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />}
        </TouchableOpacity>
      )}

      <Text style={styles.sectionTitle}>File a request</Text>
      {REQUEST_TYPES.map(t => (
        <TouchableOpacity key={t.key} style={styles.card} onPress={() => file(t.key, t.label)} activeOpacity={0.75} disabled={submitting === t.key}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>{t.label}</Text>
            <Text style={styles.description}>{t.description}</Text>
          </View>
          {submitting === t.key
            ? <LoadingSpinner color={Colors.primary} />
            : <Feather name="chevron-right" size={18} color={Colors.tabIconDefault} />}
        </TouchableOpacity>
      ))}

      <Text style={styles.sectionTitle}>My open requests</Text>
      {requests.length === 0 ? (
        <Text style={styles.emptyText}>No open requests.</Text>
      ) : requests.map(r => {
        const hasInApp = !!(r.lastInAppMessageId || r.lastInAppAt);
        const inAppStatus = hasInApp ? "sent" : (r.lastNotificationKind ? "not_recorded" : null);
        const channels: { key: string; label: string; status: string | null; at: string | null }[] = [
          { key: "in-app", label: "in-app", status: inAppStatus, at: r.lastInAppAt },
          { key: "email", label: "email", status: r.lastEmailStatus, at: r.lastEmailAt },
          { key: "push", label: "push", status: r.lastPushStatus, at: r.lastPushAt },
          { key: "sms", label: "SMS", status: r.lastSmsStatus, at: r.lastSmsAt },
        ];
        const hasAnyChannel = channels.some(c => c.status || c.at) || !!r.lastNotificationKind || !!r.lastNotifiedAt;
        return (
          <View key={r.id} style={styles.requestCard}>
            <View style={styles.requestHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{r.requestType.toUpperCase()}</Text>
                <Text style={styles.description}>Filed {new Date(r.requestedAt).toLocaleDateString()}{r.dueBy ? ` · due by ${new Date(r.dueBy).toLocaleDateString()}` : ""}</Text>
                {r.notes && <Text style={styles.description}>{r.notes}</Text>}
              </View>
              <View style={[styles.statusBadge, r.status === "completed" ? { backgroundColor: "#16653440" } : r.status === "rejected" ? { backgroundColor: "#7f1d1d40" } : { backgroundColor: "#78350f40" }]}>
                <Text style={[styles.statusText, r.status === "completed" ? { color: "#22c55e" } : r.status === "rejected" ? { color: "#fca5a5" } : { color: "#fbbf24" }]}>
                  {r.status.toUpperCase()}
                </Text>
              </View>
            </View>
            {r.lastNotificationKind === "export_expiring" && (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Export expiring soon"
                style={styles.exportExpiringPill}
                activeOpacity={0.75}
                onPress={() => {
                  const readyExport = exports.find(e => e.computedStatus === "ready");
                  const lastAt = r.lastNotifiedAt
                    ? new Date(r.lastNotifiedAt).toLocaleString()
                    : "recently";
                  const buttons: Parameters<typeof Alert.alert>[2] = [
                    { text: "Close", style: "cancel" },
                    { text: "Resend reminder", onPress: () => resend(r) },
                  ];
                  if (readyExport) {
                    buttons.push({
                      text: "Download archive",
                      onPress: () => downloadArchive(readyExport),
                    });
                  }
                  Alert.alert(
                    "Export expiring soon",
                    `We sent you a reminder ${lastAt} that your data export download link is about to expire.${
                      readyExport ? "\n\nTap “Download archive” to save it before it auto-deletes." : ""
                    }`,
                    buttons,
                  );
                }}
                testID={`data-request-export-expiring-pill-${r.id}`}
              >
                <Feather name="download" size={12} color="#fbbf24" />
                <Text style={styles.exportExpiringPillText}>Export expiring soon · Reminder sent</Text>
              </TouchableOpacity>
            )}
            <PrivacyResendStatus
              request={r}
              resending={resending === r.id}
              onResend={() => resend(r)}
            />

            {hasAnyChannel && (
              <View style={styles.channelsBlock}>
                <Text style={styles.channelsHeader}>
                  {r.lastNotificationKind ? `Last notice (${r.lastNotificationKind})` : "Last notice"}
                  {r.lastNotifiedAt ? ` · ${new Date(r.lastNotifiedAt).toLocaleString()}` : ""}
                </Text>
                <View style={styles.channelsList}>
                  {channels.map(c => {
                    const tone = channelTone(c.status);
                    return (
                      <View key={c.key} style={styles.channelRow}>
                        <View style={[styles.channelBadge, { backgroundColor: TONE_BG[tone] }]}>
                          <Text style={[styles.channelText, { color: TONE_FG[tone] }]}>
                            {c.label}: {channelLabel(c.status)}
                          </Text>
                        </View>
                        <Text style={styles.channelTimestamp}>
                          {c.at ? new Date(c.at).toLocaleString() : "—"}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}
          </View>
        );
      })}

      <Text style={styles.legend}>
        In-app and email are always attempted. Push and SMS only deliver when you have opted in for privacy notices on those channels and have a registered device or phone number.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  emptyText: { color: Colors.tabIconDefault, fontSize: 13, fontStyle: "italic" },
  intro: { color: Colors.tabIconDefault, fontSize: 12, marginBottom: 16 },
  exportBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: Colors.primary, paddingVertical: 14, borderRadius: 12, marginBottom: 20 },
  exportText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  sectionTitle: { color: "#fff", fontSize: 13, fontWeight: "700", marginBottom: 8, marginTop: 8, textTransform: "uppercase", letterSpacing: 0.5 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.surface, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: Colors.border },
  requestCard: { backgroundColor: Colors.surface, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: Colors.border },
  requestHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  channelsBlock: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: Colors.border },
  channelsHeader: { color: Colors.tabIconDefault, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 },
  channelsList: { gap: 4 },
  channelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  channelBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, minWidth: 110 },
  channelText: { fontSize: 10, fontWeight: "700" },
  channelTimestamp: { color: Colors.tabIconDefault, fontSize: 10, flex: 1 },
  legend: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 12, lineHeight: 16, fontStyle: "italic" },
  label: { color: "#fff", fontSize: 14, fontWeight: "700" },
  description: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  statusText: { fontSize: 10, fontWeight: "700" },
  resendBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: Colors.primary, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, marginTop: 10 },
  resendBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  cooldownHint: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 10, paddingVertical: 6 },
  cooldownHintText: { color: Colors.tabIconDefault, fontSize: 11, fontStyle: "italic" },
  exportExpiringPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#f59e0b66",
    backgroundColor: "#78350f33",
  },
  exportExpiringPillText: { color: "#fbbf24", fontSize: 11, fontWeight: "700" },
});
