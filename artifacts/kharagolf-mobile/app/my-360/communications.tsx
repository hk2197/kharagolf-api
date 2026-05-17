import React, { useEffect, useRef, useState, useCallback } from "react";
import { View, Text, ScrollView, StyleSheet, Switch, Alert, Pressable } from "react-native";
import { Feather } from "@expo/vector-icons";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";
import { useLocalSearchParams, router } from "expo-router";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { authedFetch, useActingMemberId, actingQs } from "./_shared";

interface CommPref {
  id: number; category: string;
  emailEnabled: boolean | null; smsEnabled: boolean | null; pushEnabled: boolean | null;
  whatsappEnabled: boolean | null; inAppEnabled: boolean | null;
}

interface NotificationKeyPref {
  key: string;
  category: string;
  description: string;
  override: "realtime" | "digest" | null;
  effectiveMode: "realtime" | "digest";
}

interface NotificationKeyPrefsResponse {
  digestMode: boolean;
  keys: NotificationKeyPref[];
}

// Task #1741 — labels and descriptions resolved via i18n at render time.
// Keep the key list here as a stable source of truth so the rendering
// order and category identifiers don't depend on the locale file.
const CATEGORIES: { key: string }[] = [
  { key: "billing" },
  { key: "operations" },
  { key: "service" },
  { key: "events" },
  { key: "tournaments" },
  { key: "newsletters" },
  { key: "marketing" },
  { key: "social" },
  { key: "privacy" },
];

const CHANNELS: { key: keyof CommPref; labelKey: string }[] = [
  { key: "emailEnabled", labelKey: "commPrefs.channels.email" },
  { key: "smsEnabled", labelKey: "commPrefs.channels.sms" },
  { key: "pushEnabled", labelKey: "commPrefs.channels.push" },
  { key: "whatsappEnabled", labelKey: "commPrefs.channels.whatsapp" },
  { key: "inAppEnabled", labelKey: "commPrefs.channels.inApp" },
];

interface NotifPrefs {
  notifySideGameReceipts: boolean;
  notifyDataExportExpiring: boolean;
  notifyManualEntryAlerts: boolean;
  notifyCoachPayoutAccountChanges: boolean;
  // Task #1724 — coach-side per-event opt-out for the courtesy email
  // sent when an organisation admin manually re-verifies the coach's
  // payout account. Independent of the broader `billing` comm-prefs
  // opt-out so coaches can mute just this notice without silencing
  // payout receipts or the cron-side needs-attention email.
  notifyAdminPayoutReverify: boolean;
  // Task #1769 — controller per-event opt-out for the daily stuck-erasure
  // cleanup email. Mirrors the web portal toggle (`notifyErasureStorageDigest`)
  // so a controller who only uses the mobile app can flip the digest back
  // on without dredging up the email's unsubscribe link. We render the row
  // unconditionally (matching the rest of this screen — manual-entry, coach
  // payout, etc. are also rendered for everyone); the backend digest only
  // ever sends to controller roles, so a non-controller toggling this is
  // a no-op.
  notifyErasureStorageDigest: boolean;
  // Task #2205 — controller per-event opt-out for the in-app / push half
  // of the same stuck-erasure cleanup digest. The web portal renders two
  // independent toggles (email + in-app/push) for this digest; the mobile
  // screen now mirrors both so a controller who only uses the mobile app
  // can silence (or re-enable) the in-app pings without bouncing out to
  // the web portal. Persists through the same PATCH
  // `/portal/notification-preferences` endpoint as its email sibling.
  notifyErasureStorageDigestPush: boolean;
  // Task #2212 — audit-trail surface for the data-export-expiring
  // 24-hour heads-up reminder (Task #1773). When a member silences
  // the reminder by clicking the public unsubscribe link from one of
  // their export-ready emails, the API records the timestamp +
  // direction (`unsubscribe` / `resubscribe`) so this screen can
  // render a "Last changed via email link on <date> (unsubscribed)"
  // chip next to the toggle — mirroring the equivalent hint the web
  // portal already shows for the erasure-storage digest. Direction
  // is currently always `unsubscribe` (the per-request opt-out has
  // no public re-subscribe counterpart) but we type both possibilities
  // for shape parity with the API and the web portal.
  notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: string | null;
  notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
    | "unsubscribe"
    | "resubscribe"
    | null;
}

export default function CommunicationsScreen() {
  const { t } = useTranslation("profile");
  const { token, user } = useAuth();
  const [acting] = useActingMemberId();
  const [prefs, setPrefs] = useState<CommPref[]>([]);
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>({ notifySideGameReceipts: true, notifyDataExportExpiring: true, notifyManualEntryAlerts: true, notifyCoachPayoutAccountChanges: true, notifyAdminPayoutReverify: true, notifyErasureStorageDigest: true, notifyErasureStorageDigestPush: true, notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: null, notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection: null });
  const [keyPrefs, setKeyPrefs] = useState<NotificationKeyPrefsResponse>({ digestMode: false, keys: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  // Task #1495 — when navigated here from the side-game-receipt-toggle
  // backfill announcement card on the home screen, scroll to and briefly
  // highlight the matching row so members can find the toggle right away.
  // Mirrors the web portal flow which scrolls to `#comm-prefs` after
  // dismissing the same announcement card.
  const params = useLocalSearchParams<{ focus?: string }>();
  const scrollRef = useRef<ScrollView | null>(null);
  const sideGameRowRef = useRef<View | null>(null);
  const scrollOffsetRef = useRef(0);
  const focusedRef = useRef(false);
  const [highlightSideGame, setHighlightSideGame] = useState(false);

  // Task #2140 — one-time inline tip pointing at the new Task #1724
  // "admin payout re-verification" toggle. Coaches who already silenced
  // the broader Billing comm-prefs category would never notice the new
  // per-event switch otherwise. Persists per-user via AsyncStorage
  // (keyed by user id so dismissing on one account doesn't hide it for
  // another that signs into the same device). Default-hidden until the
  // stored flag has been read so the tip never flashes for a coach who
  // previously dismissed it.
  const tipStorageKey = user?.id != null ? `kharagolf:tip:adminPayoutReverify:dismissed:${user.id}` : null;
  const [adminPayoutReverifyTipDismissed, setAdminPayoutReverifyTipDismissed] = useState(true);
  useEffect(() => {
    let cancelled = false;
    if (!tipStorageKey) {
      setAdminPayoutReverifyTipDismissed(true);
      return () => { cancelled = true; };
    }
    AsyncStorage.getItem(tipStorageKey)
      .then(v => { if (!cancelled) setAdminPayoutReverifyTipDismissed(v === "1"); })
      .catch(() => { if (!cancelled) setAdminPayoutReverifyTipDismissed(true); });
    return () => { cancelled = true; };
  }, [tipStorageKey]);
  const dismissAdminPayoutReverifyTip = useCallback(() => {
    setAdminPayoutReverifyTipDismissed(true);
    if (!tipStorageKey) return;
    AsyncStorage.setItem(tipStorageKey, "1").catch(() => {
      /* AsyncStorage unavailable — best-effort; row still hides for the rest of this session */
    });
  }, [tipStorageKey]);

  const load = useCallback(async () => {
    if (!token) return;
    const [rows, np, kp] = await Promise.all([
      authedFetch<CommPref[]>(`/api/portal/my-comm-prefs${actingQs({ actingMemberId: acting })}`, token).catch(() => [] as CommPref[]),
      authedFetch<{ notifySideGameReceipts?: boolean; notifyDataExportExpiring?: boolean; notifyManualEntryAlerts?: boolean; notifyCoachPayoutAccountChanges?: boolean; notifyAdminPayoutReverify?: boolean; notifyErasureStorageDigest?: boolean; notifyErasureStorageDigestPush?: boolean; notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt?: string | null; notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection?: string | null } | null>(`/api/portal/notification-preferences`, token).catch(() => null),
      authedFetch<NotificationKeyPrefsResponse | null>(`/api/portal/notification-key-prefs`, token).catch(() => null),
    ]);
    setPrefs(rows);
    if (np) setNotifPrefs({
      notifySideGameReceipts: np.notifySideGameReceipts !== false,
      notifyDataExportExpiring: np.notifyDataExportExpiring !== false,
      notifyManualEntryAlerts: np.notifyManualEntryAlerts !== false,
      notifyCoachPayoutAccountChanges: np.notifyCoachPayoutAccountChanges !== false,
      notifyAdminPayoutReverify: np.notifyAdminPayoutReverify !== false,
      notifyErasureStorageDigest: np.notifyErasureStorageDigest !== false,
      notifyErasureStorageDigestPush: np.notifyErasureStorageDigestPush !== false,
      // Task #2212 — pass through the audit-trail fields the API
      // surfaces alongside the data-export-expiring toggle so the
      // row can render a "Last changed via email link on <date>
      // (unsubscribed)" hint when the member most recently flipped
      // the preference via the public unsubscribe link from one of
      // their export-ready emails. Both fields stay null for members
      // who have never used the link.
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt:
        typeof np.notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt === "string"
          ? np.notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt
          : null,
      notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
        np.notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection === "unsubscribe" ||
        np.notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection === "resubscribe"
          ? np.notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection
          : null,
    });
    if (kp && Array.isArray(kp.keys)) setKeyPrefs(kp);
  }, [token, acting]);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  // Task #1495 — once the screen has finished loading, scroll to the
  // side-game receipts row when the navigator passed `focus=sideGameReceipts`.
  // We measure both the ScrollView and the row in window-coordinates so the
  // calculation works even if the row sits inside a card that was rendered
  // partway down the screen. We retry a few times in case the layout is
  // still settling on the first frame, and only run once per visit.
  useEffect(() => {
    if (loading) return;
    if (params.focus !== "sideGameReceipts") return;
    if (focusedRef.current) return;
    focusedRef.current = true;
    setHighlightSideGame(true);
    const tryScroll = (attempt: number) => {
      const target = sideGameRowRef.current;
      const sv = scrollRef.current;
      if (target && sv) {
        // @ts-expect-error — measureInWindow exists on the host component.
        sv.measureInWindow((_sx: number, sy: number) => {
          target.measureInWindow((_tx: number, ty: number) => {
            const delta = ty - sy;
            const next = Math.max(0, scrollOffsetRef.current + delta - 24);
            sv.scrollTo({ y: next, animated: true });
          });
        });
        return;
      }
      if (attempt < 25) setTimeout(() => tryScroll(attempt + 1), 100);
    };
    setTimeout(() => tryScroll(0), 150);
    const off = setTimeout(() => setHighlightSideGame(false), 3500);
    return () => clearTimeout(off);
  }, [loading, params.focus]);

  const toggleNotifPref = async (field: keyof NotifPrefs, next: boolean) => {
    if (!token) return;
    const key = `notif:${String(field)}`;
    setSaving(key);
    const prev = notifPrefs;
    setNotifPrefs({ ...prev, [field]: next });
    try {
      await authedFetch(`/api/portal/notification-preferences`, token, {
        method: "PATCH", body: JSON.stringify({ [field]: next }),
      });
    } catch (e) {
      setNotifPrefs(prev);
      Alert.alert(t("commPrefs.couldNotSave"), (e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  // Task #1352 — set the per-key real-time/digest override. Mirrors the
  // web portal flow: always store an explicit override (rather than
  // trying to detect "matches global"), so the toggle is stable across
  // changes to the global digest_mode flag.
  //
  // Task #2005 — passing null clears the row's override and lets it
  // inherit the global digest setting again, so effectiveMode falls
  // back to whichever side digestMode points at. Mirrors the web
  // portal "Use default" link.
  const saveKeyPref = async (notifKey: string, nextMode: "realtime" | "digest" | null) => {
    if (!token) return;
    const savingKey = `key:${notifKey}`;
    setSaving(savingKey);
    const prev = keyPrefs;
    const fallbackMode: "realtime" | "digest" = prev.digestMode ? "digest" : "realtime";
    setKeyPrefs({
      digestMode: prev.digestMode,
      keys: prev.keys.map(k => k.key === notifKey
        ? { ...k, override: nextMode, effectiveMode: nextMode ?? fallbackMode }
        : k),
    });
    try {
      await authedFetch(`/api/portal/notification-key-prefs`, token, {
        method: "PATCH",
        body: JSON.stringify({ key: notifKey, deliveryMode: nextMode }),
      });
    } catch (e) {
      setKeyPrefs(prev);
      Alert.alert(t("commPrefs.couldNotSave"), (e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const prefFor = (cat: string): CommPref =>
    prefs.find(p => p.category === cat) ?? {
      id: 0, category: cat,
      emailEnabled: true, smsEnabled: false, pushEnabled: true, whatsappEnabled: false, inAppEnabled: true,
    };

  const toggle = async (cat: string, channel: keyof CommPref, next: boolean) => {
    if (!token) return;
    const key = `${cat}:${String(channel)}`;
    setSaving(key);
    try {
      const current = prefFor(cat);
      const body: Record<string, unknown> = {
        category: cat,
        emailEnabled: current.emailEnabled ?? false,
        smsEnabled: current.smsEnabled ?? false,
        pushEnabled: current.pushEnabled ?? false,
        whatsappEnabled: current.whatsappEnabled ?? false,
        inAppEnabled: current.inAppEnabled ?? false,
      };
      body[String(channel)] = next;
      await authedFetch(`/api/portal/my-comm-prefs${actingQs({ actingMemberId: acting })}`, token, {
        method: "PUT", body: JSON.stringify(body),
      });
      await load();
    } catch (e) {
      Alert.alert("Could not save", (e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <View style={styles.center}><LoadingSpinner color={Colors.primary} /></View>;

  return (
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1, backgroundColor: Colors.background }}
      contentContainerStyle={{ padding: 16 }}
      onScroll={(e) => { scrollOffsetRef.current = e.nativeEvent.contentOffset.y; }}
      scrollEventThrottle={16}
    >
      <Text style={styles.intro}>
        {t("commPrefs.intro")}
      </Text>
      <Text style={styles.helper}>
        {t("commPrefs.whatsappFootnote")}
      </Text>
      <View style={styles.card}>
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.label, { flex: 1 }]}>{t("commPrefs.emailOptOuts.sectionTitle")}</Text>
          {/* Task #2223 — link out to the suppressed-notifications log so a
              controller who muted both channels for an alert can still see
              what the cron tried to deliver. Mirrors the same link the web
              portal renders next to this section heading
              (`PortalCommPrefs.tsx` → `link-notification-audit`). */}
          <Pressable
            onPress={() => router.push("/my-360/notification-audit" as never)}
            accessibilityRole="button"
            accessibilityLabel={t("commPrefs.emailOptOuts.viewSuppressedLink")}
            testID="link-notification-audit"
            style={styles.viewSuppressedLink}
          >
            <Feather name="clock" size={12} color="#cbd5e1" />
            <Text style={styles.viewSuppressedLinkText}>
              {t("commPrefs.emailOptOuts.viewSuppressedLink")}
            </Text>
          </Pressable>
        </View>
        <Text style={styles.description}>
          {t("commPrefs.emailOptOuts.sectionDescription")}
        </Text>
        <View style={styles.channels}>
          <View style={styles.channelRow}>
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={styles.channelLabel}>{t("commPrefs.emailOptOuts.manualEntryLabel")}</Text>
              <Text style={styles.subDescription}>
                {t("commPrefs.emailOptOuts.manualEntryDesc")}
              </Text>
            </View>
            {saving === "notif:notifyManualEntryAlerts" ? (
              <LoadingSpinner color={Colors.primary} />
            ) : (
              <Switch
                value={notifPrefs.notifyManualEntryAlerts}
                onValueChange={v => toggleNotifPref("notifyManualEntryAlerts", v)}
                trackColor={{ false: "#374151", true: `${Colors.primary}80` }}
                thumbColor={notifPrefs.notifyManualEntryAlerts ? Colors.primary : "#9ca3af"}
                accessibilityLabel={t("commPrefs.emailOptOuts.manualEntryLabel")}
                testID="switch-notify-manual-entry-alerts"
              />
            )}
          </View>
          <View style={styles.channelRow}>
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={styles.channelLabel}>{t("commPrefs.emailOptOuts.coachPayoutLabel")}</Text>
              <Text style={styles.subDescription}>
                {t("commPrefs.emailOptOuts.coachPayoutDesc")}
              </Text>
            </View>
            {saving === "notif:notifyCoachPayoutAccountChanges" ? (
              <LoadingSpinner color={Colors.primary} />
            ) : (
              <Switch
                value={notifPrefs.notifyCoachPayoutAccountChanges}
                onValueChange={v => toggleNotifPref("notifyCoachPayoutAccountChanges", v)}
                trackColor={{ false: "#374151", true: `${Colors.primary}80` }}
                thumbColor={notifPrefs.notifyCoachPayoutAccountChanges ? Colors.primary : "#9ca3af"}
                accessibilityLabel={t("commPrefs.emailOptOuts.coachPayoutLabel")}
                testID="switch-notify-coach-payout-account-changes"
              />
            )}
          </View>
          {/* Task #2140 — wraps the admin-payout-reverify row in a column
              so the one-time "New" pill and the dismissable inline tip
              can render alongside the toggle without breaking the
              standard channelRow layout used by every other row above. */}
          <View testID="row-notify-admin-payout-reverify">
            <View style={styles.channelRow}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <View style={styles.labelWithBadge}>
                  <Text style={styles.channelLabel}>{t("commPrefs.emailOptOuts.adminPayoutReverifyLabel")}</Text>
                  {!adminPayoutReverifyTipDismissed && (
                    <View style={styles.newBadge} testID="badge-admin-payout-reverify-new">
                      <Text style={styles.newBadgeText}>{t("commPrefs.emailOptOuts.adminPayoutReverifyNewBadge")}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.subDescription}>
                  {t("commPrefs.emailOptOuts.adminPayoutReverifyDesc")}
                </Text>
              </View>
              {saving === "notif:notifyAdminPayoutReverify" ? (
                <LoadingSpinner color={Colors.primary} />
              ) : (
                <Switch
                  value={notifPrefs.notifyAdminPayoutReverify}
                  onValueChange={v => toggleNotifPref("notifyAdminPayoutReverify", v)}
                  trackColor={{ false: "#374151", true: `${Colors.primary}80` }}
                  thumbColor={notifPrefs.notifyAdminPayoutReverify ? Colors.primary : "#9ca3af"}
                  accessibilityLabel={t("commPrefs.emailOptOuts.adminPayoutReverifyLabel")}
                  testID="switch-notify-admin-payout-reverify"
                />
              )}
            </View>
            {!adminPayoutReverifyTipDismissed && (
              <View style={styles.tipBox} testID="tip-admin-payout-reverify">
                <Text style={styles.tipText}>{t("commPrefs.emailOptOuts.adminPayoutReverifyTipBody")}</Text>
                <Pressable
                  onPress={dismissAdminPayoutReverifyTip}
                  accessibilityRole="button"
                  accessibilityLabel={t("commPrefs.emailOptOuts.adminPayoutReverifyTipDismiss")}
                  testID="btn-dismiss-admin-payout-reverify-tip"
                  style={styles.tipDismissBtn}
                >
                  <Text style={styles.tipDismissText}>{t("commPrefs.emailOptOuts.adminPayoutReverifyTipDismiss")}</Text>
                </Pressable>
              </View>
            )}
          </View>
          {/* Task #2212 — wraps the data-export-expiring row in a column
              so the inline "Last changed via email link on <date>
              (unsubscribed)" hint can render below the toggle without
              breaking the standard channelRow layout used by the other
              rows. Mirrors the web portal hint pattern next to the
              same toggle (see PortalCommPrefs.tsx). The hint stays
              visible after the member flips the toggle back from the
              app because the audit row is permanent. */}
          <View testID="row-notify-data-export-expiring">
            <View style={styles.channelRow}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.channelLabel}>{t("commPrefs.emailOptOuts.dataExportExpiringLabel")}</Text>
                <Text style={styles.subDescription}>
                  {t("commPrefs.emailOptOuts.dataExportExpiringDesc")}
                </Text>
              </View>
              {saving === "notif:notifyDataExportExpiring" ? (
                <LoadingSpinner color={Colors.primary} />
              ) : (
                <Switch
                  value={notifPrefs.notifyDataExportExpiring}
                  onValueChange={v => toggleNotifPref("notifyDataExportExpiring", v)}
                  trackColor={{ false: "#374151", true: `${Colors.primary}80` }}
                  thumbColor={notifPrefs.notifyDataExportExpiring ? Colors.primary : "#9ca3af"}
                  accessibilityLabel={t("commPrefs.emailOptOuts.dataExportExpiringLabel")}
                  testID="switch-notify-data-export-expiring"
                />
              )}
            </View>
            {(() => {
              // Hidden when the timestamp is null (member has never used
              // the public unsubscribe link). The defensive Date parse
              // also hides the hint if the API ever sent a malformed
              // timestamp instead of crashing the row.
              const at = notifPrefs.notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt;
              const direction = notifPrefs.notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection;
              if (!at) return null;
              const parsed = new Date(at);
              if (Number.isNaN(parsed.getTime())) return null;
              const formatted = parsed.toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
              });
              const directionLabel = direction === "resubscribe"
                ? t("commPrefs.emailOptOuts.dataExportExpiringLinkChangeResubscribed")
                : t("commPrefs.emailOptOuts.dataExportExpiringLinkChangeUnsubscribed");
              return (
                <Text
                  style={styles.linkChangeHint}
                  testID="hint-notify-data-export-expiring-link-change"
                >
                  {t("commPrefs.emailOptOuts.dataExportExpiringLinkChangeHint", {
                    date: formatted,
                    direction: directionLabel,
                  })}
                </Text>
              );
            })()}
          </View>
          {/* Task #1769 — controller per-event opt-out for the daily
              stuck-erasure cleanup digest (email channel). Mirrors the
              web portal `switch-notify-erasure-storage-digest-email`
              toggle. Task #2205 added the sibling in-app/push row
              below so a controller can mute either channel
              independently from the mobile app — matching the web
              portal which has rendered both toggles since the digest
              shipped. */}
          <View style={styles.channelRow} testID="row-notify-erasure-storage-digest">
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={styles.channelLabel}>{t("commPrefs.emailOptOuts.erasureStorageDigestLabel")}</Text>
              <Text style={styles.subDescription}>
                {t("commPrefs.emailOptOuts.erasureStorageDigestDesc")}
              </Text>
            </View>
            {saving === "notif:notifyErasureStorageDigest" ? (
              <LoadingSpinner color={Colors.primary} />
            ) : (
              <Switch
                value={notifPrefs.notifyErasureStorageDigest}
                onValueChange={v => toggleNotifPref("notifyErasureStorageDigest", v)}
                trackColor={{ false: "#374151", true: `${Colors.primary}80` }}
                thumbColor={notifPrefs.notifyErasureStorageDigest ? Colors.primary : "#9ca3af"}
                accessibilityLabel={t("commPrefs.emailOptOuts.erasureStorageDigestLabel")}
                testID="switch-notify-erasure-storage-digest"
              />
            )}
          </View>
          {/* Task #2205 — controller per-event opt-out for the in-app /
              push half of the same stuck-erasure cleanup digest.
              Mirrors the web portal toggle
              (`switch-notify-erasure-storage-digest-push`) so a
              controller who only uses the mobile app can silence (or
              re-enable) the in-app pings without leaving the app. The
              two toggles are intentionally independent — flipping this
              one off does NOT silence the daily email above (and vice
              versa), matching the web portal behaviour. */}
          <View style={styles.channelRow} testID="row-notify-erasure-storage-digest-push">
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={styles.channelLabel}>{t("commPrefs.emailOptOuts.erasureStorageDigestPushLabel")}</Text>
              <Text style={styles.subDescription}>
                {t("commPrefs.emailOptOuts.erasureStorageDigestPushDesc")}
              </Text>
            </View>
            {saving === "notif:notifyErasureStorageDigestPush" ? (
              <LoadingSpinner color={Colors.primary} />
            ) : (
              <Switch
                value={notifPrefs.notifyErasureStorageDigestPush}
                onValueChange={v => toggleNotifPref("notifyErasureStorageDigestPush", v)}
                trackColor={{ false: "#374151", true: `${Colors.primary}80` }}
                thumbColor={notifPrefs.notifyErasureStorageDigestPush ? Colors.primary : "#9ca3af"}
                accessibilityLabel={t("commPrefs.emailOptOuts.erasureStorageDigestPushLabel")}
                testID="switch-notify-erasure-storage-digest-push"
              />
            )}
          </View>
          {/* Task #2220 — live "which channels are silenced" status
              preview under the two stuck-erasure cleanup digest
              toggles. Mirrors the web portal block (Task #1774) one-
              for-one: the four states map to the (email, push) cross-
              product, and the "both muted" state additionally surfaces
              an amber warning hint reminding the controller that the
              org-level escalation still needs at least one channel to
              reach them. Re-uses the same i18n keys as the web portal
              (mirrored into `profile.json` here so all 21 locales stay
              in sync). */}
          {(() => {
            const emailOn = notifPrefs.notifyErasureStorageDigest;
            const pushOn = notifPrefs.notifyErasureStorageDigestPush;
            const bothMuted = !emailOn && !pushOn;
            const statusKey = emailOn && pushOn
              ? "commPrefs.emailOptOuts.erasureStorageStatusBoth"
              : emailOn
                ? "commPrefs.emailOptOuts.erasureStorageStatusEmailOnly"
                : pushOn
                  ? "commPrefs.emailOptOuts.erasureStorageStatusPushOnly"
                  : "commPrefs.emailOptOuts.erasureStorageStatusBothMuted";
            const statusTestId = emailOn && pushOn
              ? "erasure-storage-status-both"
              : emailOn
                ? "erasure-storage-status-email-only"
                : pushOn
                  ? "erasure-storage-status-push-only"
                  : "erasure-storage-status-both-muted";
            return (
              <View testID="erasure-storage-status-block">
                <Text
                  style={[styles.erasureStatus, bothMuted && styles.erasureStatusBothMuted]}
                  accessibilityLiveRegion="polite"
                  testID="erasure-storage-status"
                >
                  <Text style={styles.subDescription}>
                    {t("commPrefs.emailOptOuts.erasureStorageStatusPrefix")}
                  </Text>
                  {" "}
                  <Text testID={statusTestId}>{t(statusKey)}</Text>
                </Text>
                {bothMuted && (
                  <Text
                    style={styles.erasureBothMutedHint}
                    accessibilityRole="text"
                    testID="erasure-storage-both-muted-hint"
                  >
                    {t("commPrefs.emailOptOuts.erasureStorageBothMutedHint")}
                  </Text>
                )}
              </View>
            );
          })()}
          <View
            ref={sideGameRowRef}
            style={[styles.channelRow, highlightSideGame && styles.channelRowHighlight]}
            testID="row-notify-side-game-receipts"
          >
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={styles.channelLabel}>{t("commPrefs.emailOptOuts.sideGameReceiptsLabel")}</Text>
              <Text style={styles.subDescription}>
                {t("commPrefs.emailOptOuts.sideGameReceiptsDesc")}
              </Text>
            </View>
            {saving === "notif:notifySideGameReceipts" ? (
              <LoadingSpinner color={Colors.primary} />
            ) : (
              <Switch
                value={notifPrefs.notifySideGameReceipts}
                onValueChange={v => toggleNotifPref("notifySideGameReceipts", v)}
                trackColor={{ false: "#374151", true: `${Colors.primary}80` }}
                thumbColor={notifPrefs.notifySideGameReceipts ? Colors.primary : "#9ca3af"}
                accessibilityLabel={t("commPrefs.emailOptOuts.sideGameReceiptsLabel")}
                testID="switch-notify-side-game-receipts"
              />
            )}
          </View>
        </View>
      </View>
      {CATEGORIES.map(c => {
        const p = prefFor(c.key);
        const catLabel = t(`commPrefs.categories.${c.key}.label`);
        const catDescription = t(`commPrefs.categories.${c.key}.description`);
        return (
          <View key={c.key} style={styles.card}>
            <Text style={styles.label}>{catLabel}</Text>
            <Text style={styles.description}>{catDescription}</Text>
            <View style={styles.channels}>
              {CHANNELS.map(ch => {
                const key = `${c.key}:${String(ch.key)}`;
                const channelLabel = t(ch.labelKey);
                return (
                  <View key={key} style={styles.channelRow}>
                    <Text style={styles.channelLabel}>{channelLabel}</Text>
                    {saving === key ? (
                      <LoadingSpinner color={Colors.primary} />
                    ) : (
                      <Switch
                        value={Boolean(p[ch.key])}
                        onValueChange={v => toggle(c.key, ch.key, v)}
                        trackColor={{ false: "#374151", true: `${Colors.primary}80` }}
                        thumbColor={p[ch.key] ? Colors.primary : "#9ca3af"}
                        accessibilityLabel={t("commPrefs.channelForCategoryAria", { channel: channelLabel, category: catLabel })}
                        testID={`switch-comm-${c.key}-${String(ch.key)}`}
                      />
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}
      {keyPrefs.keys.length > 0 && (
        <View style={styles.card} testID="section-notification-key-prefs">
          <Text style={styles.label}>{t("commPrefs.keyPrefs.sectionTitle")}</Text>
          <Text style={styles.description}>
            {t("commPrefs.keyPrefs.sectionDescription")}
          </Text>
          {/* Task #1616 — render the digest-mode status as prefix + bold word
              + suffix so the bold styling survives translation. Some
              languages may shift word order; if that becomes a problem we
              can swap to react-i18next's <Trans>. */}
          <Text style={styles.subDescription}>
            {t("commPrefs.keyPrefs.digestModePrefix")}{" "}
            <Text style={styles.digestModeValue}>
              {keyPrefs.digestMode ? t("commPrefs.keyPrefs.digestModeOn") : t("commPrefs.keyPrefs.digestModeOff")}
            </Text>
            {t("commPrefs.keyPrefs.digestModeSuffix")}
          </Text>
          <View style={styles.channels}>
            {keyPrefs.keys.map(k => {
              const isDigest = k.effectiveMode === "digest";
              const busy = saving === `key:${k.key}`;
              // Task #2017 — every digestable notification key now ships
              // with a localised description in the i18n bundle for all
              // 21 supported locales (keyed by the notification key under
              // `commPrefs.notificationKeys`). Look up the translation;
              // fall back to the API's English description only as a
              // defensive safety net for a key that gets added to the
              // registry before its translation lands.
              const translationKey = `commPrefs.notificationKeys.${k.key}`;
              const NO_KEY_TRANSLATION = "__no_translation__";
              const probed = t(translationKey, { defaultValue: NO_KEY_TRANSLATION });
              const hasTranslation = probed !== NO_KEY_TRANSLATION && probed !== translationKey;
              const description = hasTranslation ? probed : k.description;
              return (
                <View key={k.key} style={styles.keyRow} testID={`row-key-pref-${k.key}`}>
                  <View style={styles.keyInfo}>
                    <Text style={styles.channelLabel}>{description}</Text>
                    <Text style={styles.keyMeta}>{k.key} · {k.category}</Text>
                  </View>
                  {busy ? (
                    <LoadingSpinner color={Colors.primary} />
                  ) : (
                    <View style={styles.keyControls}>
                    <View style={styles.segment} accessibilityRole="radiogroup" accessibilityLabel={t("commPrefs.keyPrefs.deliveryModeAria", { key: k.key })}>
                      <Pressable
                        onPress={() => { if (isDigest) saveKeyPref(k.key, "realtime"); }}
                        style={[styles.segmentBtn, !isDigest && styles.segmentBtnActive]}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: !isDigest, checked: !isDigest }}
                        accessibilityLabel={!isDigest ? t("commPrefs.keyPrefs.realtimeSelected") : t("commPrefs.keyPrefs.realtimeNotSelected")}
                        nativeID={`btn-key-pref-${k.key}-realtime-${!isDigest ? "active" : "inactive"}`}
                        testID={`btn-key-pref-${k.key}-realtime`}
                      >
                        <Text style={[styles.segmentText, !isDigest && styles.segmentTextActive]}>{t("commPrefs.keyPrefs.realtime")}</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => { if (!isDigest) saveKeyPref(k.key, "digest"); }}
                        style={[styles.segmentBtn, styles.segmentBtnRight, isDigest && styles.segmentBtnActive]}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: isDigest, checked: isDigest }}
                        accessibilityLabel={isDigest ? t("commPrefs.keyPrefs.dailySummarySelected") : t("commPrefs.keyPrefs.dailySummaryNotSelected")}
                        nativeID={`btn-key-pref-${k.key}-digest-${isDigest ? "active" : "inactive"}`}
                        testID={`btn-key-pref-${k.key}-digest`}
                      >
                        <Text style={[styles.segmentText, isDigest && styles.segmentTextActive]}>{t("commPrefs.keyPrefs.dailySummary")}</Text>
                      </Pressable>
                    </View>
                    {/* Task #2005 — only render the "Use default" link when
                        this row currently has an explicit override; tapping
                        it clears just this key so it falls back to the
                        global digest setting. Mirrors the web portal. */}
                    {k.override !== null && (
                      <Pressable
                        onPress={() => saveKeyPref(k.key, null)}
                        style={styles.useDefaultBtn}
                        accessibilityRole="button"
                        accessibilityLabel={t("commPrefs.keyPrefs.useDefault")}
                        testID={`btn-key-pref-${k.key}-clear`}
                      >
                        <Text style={styles.useDefaultText}>{t("commPrefs.keyPrefs.useDefault")}</Text>
                      </Pressable>
                    )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  intro: { color: Colors.tabIconDefault, fontSize: 12, marginBottom: 8 },
  helper: { color: Colors.tabIconDefault, fontSize: 11, fontStyle: "italic", marginBottom: 16 },
  card: { backgroundColor: Colors.surface, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: Colors.border },
  label: { color: "#fff", fontSize: 14, fontWeight: "700" },
  description: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2, marginBottom: 8 },
  subDescription: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 },
  channels: { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8 },
  channelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6 },
  channelRowHighlight: {
    backgroundColor: `${Colors.primary}15`,
    borderRadius: 8,
    paddingHorizontal: 8,
    marginHorizontal: -8,
    borderWidth: 1,
    borderColor: `${Colors.primary}55`,
  },
  channelLabel: { color: "#cbd5e1", fontSize: 13 },
  digestModeValue: { color: "#fff", fontWeight: "600" },
  keyRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  keyInfo: { flex: 1, paddingRight: 8 },
  keyMeta: { color: Colors.tabIconDefault, fontSize: 10, marginTop: 2, fontFamily: "monospace" },
  keyControls: { alignItems: "flex-end" },
  segment: { flexDirection: "row", borderWidth: 1, borderColor: Colors.border, borderRadius: 6, overflow: "hidden" },
  useDefaultBtn: { marginTop: 4, paddingVertical: 2 },
  useDefaultText: { color: "#9ca3af", fontSize: 11, textDecorationLine: "underline" },
  segmentBtn: { paddingVertical: 6, paddingHorizontal: 10 },
  segmentBtnRight: { borderLeftWidth: 1, borderLeftColor: Colors.border },
  segmentBtnActive: { backgroundColor: Colors.primary },
  segmentText: { color: "#9ca3af", fontSize: 11 },
  segmentTextActive: { color: "#fff", fontWeight: "600" },
  // Task #2140 — styles for the one-time admin-payout-reverify "What's
  // new" tip and the inline "New" badge that flag the Task #1724 toggle
  // for coaches who already silenced the broader Billing category.
  labelWithBadge: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  newBadge: {
    backgroundColor: `${Colors.primary}33`,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  newBadgeText: {
    color: Colors.primary,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  tipBox: {
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: `${Colors.primary}33`,
    backgroundColor: `${Colors.primary}1A`,
  },
  tipText: { color: "#e2e8f0", fontSize: 12, lineHeight: 16 },
  tipDismissBtn: { alignSelf: "flex-end", marginTop: 6, paddingVertical: 4, paddingHorizontal: 8 },
  tipDismissText: { color: "#cbd5e1", fontSize: 11, fontWeight: "600" },
  // Task #2212 — inline "Last changed via email link on <date>
  // (unsubscribed)" hint that appears below the data-export-expiring
  // toggle when the API surfaces the audit-trail timestamp. Same
  // muted treatment as `subDescription` so the hint reads as
  // contextual metadata rather than a status warning.
  linkChangeHint: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 4 },
  // Task #2220 — live channel-status preview rendered under the two
  // stuck-erasure cleanup digest toggles. The neutral state mirrors
  // the muted "subDescription" treatment used elsewhere on this
  // screen; the both-muted variant flips to amber to match the web
  // portal warning treatment.
  erasureStatus: { color: "#cbd5e1", fontSize: 11, marginTop: 6 },
  erasureStatusBothMuted: { color: "#fcd34d" },
  erasureBothMutedHint: { color: "#fcd34d", fontSize: 11, marginTop: 2, opacity: 0.85 },
  // Task #2223 — header row + link styles for the suppressed-notifications
  // entry point. Mirrors the web portal's `link-notification-audit` chip
  // anchored to the right of the section title.
  sectionHeaderRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  viewSuppressedLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  viewSuppressedLinkText: { color: "#cbd5e1", fontSize: 11, fontWeight: "600", textDecorationLine: "underline" },
});
