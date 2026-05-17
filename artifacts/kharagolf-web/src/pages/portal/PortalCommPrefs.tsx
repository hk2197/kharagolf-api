import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useTranslation } from 'react-i18next';
import { Bell, Mail, Layers, History, X } from 'lucide-react';
import { useGetMe } from '@workspace/api-client-react';
import { Card } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const API = (path: string) => `/api${path}`;

interface NotifPrefs {
  notifySideGameReceipts: boolean;
  notifyManualEntryAlerts: boolean;
  notifyCoachPayoutAccountChanges: boolean;
  // Task #1724 — coach-side per-event opt-out for the courtesy email
  // sent when an organisation admin manually re-verifies the coach's
  // payout account. Independent of the broader `billing` comm-prefs
  // opt-out so coaches can mute just this notice without silencing
  // payout receipts or the cron-side needs-attention email.
  notifyAdminPayoutReverify: boolean;
  // Task #2150 — per-event opt-out for the security heads-up email
  // sent when an Apple/Google sign-in identity is freshly linked to
  // the player's account (`sendSocialLinkAddedSecurityEmail`, gated
  // in `routes/wave3.ts` POST /portal/me/social-links/:provider).
  // Default-on so existing players keep receiving the heads-up; the
  // toggle simply lets a frequent link/unlink power user mute just
  // this one notice without flipping the umbrella `privacy`
  // comm-prefs category.
  notifySocialLinkAdded: boolean;
  notifyDataExportExpiring: boolean;
  // Task #1429 — admin per-event opt-outs for the digest-failed alerts.
  notifyWalletRefundDigestFailed: boolean;
  notifySideGameReceiptDigestFailed: boolean;
  // Task #1762 — admin per-event opt-outs for the three Task #1444
  // levy/reminders digest-failed alerts. Same audit-only short-circuit
  // semantics as the wallet/side-game refund digest opt-outs above so an
  // admin who watches the run history dashboard can mute the email noise
  // without losing the audit trail.
  notifyLevyLedgerDigestFailed: boolean;
  notifyLevyLedgerOrgDigestFailed: boolean;
  notifyLevyRemindersDigestFailed: boolean;
  // Task #1449 — controller per-channel opt-outs for the daily
  // stuck-erasure controller digest. The email side and the in-app/push
  // side are independent: a controller can keep one channel and mute
  // the other (email-only, push-only, both, or none).
  notifyErasureStorageDigest: boolean;
  notifyErasureStorageDigestPush: boolean;
  // Task #2218 — watermark column the in-portal mute path stamps when a
  // controller flips either stuck-erasure-digest channel from true→false
  // (and the rate-limit window allowed the confirmation email to send).
  // The settings UI uses this to render a one-click "you recently muted
  // this — re-enable" tip below the toggles when the timestamp is < 30
  // days old, mirroring the email confirmation's revert link. Stays null
  // for controllers who have never silenced the digest from this screen.
  notifyErasureStorageDigestMuteConfirmationLastSentAt: string | null;
  // Task #1772 — backend audit-trail surface for the public unsubscribe
  // link. When the controller flips `notifyErasureStorageDigest` via the
  // one-click email link, the API records the timestamp + direction
  // (`unsubscribe` / `resubscribe`) so the settings UI can show a
  // "Last changed via email link" hint. Both fields are null when the
  // controller has never used the link.
  notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt: string | null;
  notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection:
    | 'unsubscribe'
    | 'resubscribe'
    | null;
  // Task #2212 — same audit-trail surface for the data-export-expiring
  // 24-hour heads-up reminder (Task #1773). When a member silences the
  // reminder by clicking the public unsubscribe link from one of their
  // export-ready emails, the API records the timestamp + direction so
  // the settings UI can render the same "Last changed via email link"
  // hint the erasure-digest row already shows. Direction is currently
  // always `unsubscribe` (the per-request opt-out has no public
  // re-subscribe counterpart) but we type both possibilities for
  // shape parity with the erasure-digest hint above.
  notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: string | null;
  notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
    | 'unsubscribe'
    | 'resubscribe'
    | null;
  // Task #1663 — super-admin per-event opt-out for the weekly
  // silent-failures CSV digest. Only meaningful for super_admin users
  // (the cron only ever fans out to them); the toggle row is gated on
  // role in the UI.
  notifySilentAlertsDigest: boolean;
  // Task #2154 — surfaced super-admin per-event opt-out for the daily
  // exhaustion admin digest cron (`notify.exhaustion.admin_digest.failed`,
  // Task #1855). Already mute-able from the dispatcher path via the
  // PER_EVENT_OPT_OUT_COLUMNS registry; the settings page now lists it
  // alongside `notifySilentAlertsDigest` so super admins can re-subscribe
  // without finding the original email.
  notifyExhaustionAdminDigestFailed: boolean;
  // Task #2154 — surfaced per-player per-event opt-out for the daily
  // "you closed the gap" coaching encouragement push
  // (`coaching.gap.closed`, Task #2040). Mute-able from the dispatcher
  // path via the PER_EVENT_OPT_OUT_COLUMNS registry; surfacing the row
  // here lets a player toggle the nudge on/off without finding the
  // original push or asking support to flip the column.
  notifyCoachingTipClosed: boolean;
}

interface NotificationKeyPref {
  key: string;
  category: string;
  description: string;
  override: 'realtime' | 'digest' | null;
  effectiveMode: 'realtime' | 'digest';
}

interface NotificationKeyPrefsResponse {
  digestMode: boolean;
  keys: NotificationKeyPref[];
}

export interface CommPrefRow {
  id: number;
  category: string;
  emailEnabled: boolean | null;
  smsEnabled: boolean | null;
  pushEnabled: boolean | null;
  whatsappEnabled: boolean | null;
  inAppEnabled: boolean | null;
}

export type CommPrefChannel =
  | 'emailEnabled'
  | 'smsEnabled'
  | 'pushEnabled'
  | 'whatsappEnabled'
  | 'inAppEnabled';

// Task #1741 — labels resolved via i18n at render time. Keep the key list
// here as a stable source of truth so the rendering order and category
// identifiers don't depend on the locale file.
const CATEGORIES: { key: string }[] = [
  { key: 'billing' },
  { key: 'operations' },
  { key: 'service' },
  { key: 'events' },
  { key: 'tournaments' },
  { key: 'newsletters' },
  { key: 'marketing' },
  { key: 'social' },
  { key: 'privacy' },
];

const CHANNELS: { field: CommPrefChannel; headerKey: string }[] = [
  { field: 'emailEnabled', headerKey: 'commPrefs.headers.email' },
  { field: 'smsEnabled', headerKey: 'commPrefs.headers.sms' },
  { field: 'pushEnabled', headerKey: 'commPrefs.headers.push' },
  { field: 'whatsappEnabled', headerKey: 'commPrefs.headers.whatsapp' },
  { field: 'inAppEnabled', headerKey: 'commPrefs.headers.inApp' },
];

export function PortalCommPrefs() {
  const { t } = useTranslation('portal');
  // Task #1453 — gate the controller-only "Stuck erasure cleanup digest"
  // toggle on the same role check the portal already uses to surface
  // controller-only notification preferences (see ProfileTab.tsx and
  // portal/index.tsx): any non-player / non-spectator role. The backend
  // erasure-storage digest only ever sends to org_admin /
  // membership_secretary / treasurer recipients (see cron.ts), so a
  // player or spectator would never have anything to opt in/out of.
  const { data: me } = useGetMe();
  const isController = Boolean(me?.role && me.role !== 'player' && me.role !== 'spectator');
  const [commPrefs, setCommPrefs] = useState<CommPrefRow[]>([]);
  const [savingCommPref, setSavingCommPref] = useState<string | null>(null);
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>({ notifySideGameReceipts: true, notifyManualEntryAlerts: true, notifyCoachPayoutAccountChanges: true, notifyAdminPayoutReverify: true, notifySocialLinkAdded: true, notifyDataExportExpiring: true, notifyWalletRefundDigestFailed: true, notifySideGameReceiptDigestFailed: true, notifyLevyLedgerDigestFailed: true, notifyLevyLedgerOrgDigestFailed: true, notifyLevyRemindersDigestFailed: true, notifyErasureStorageDigest: true, notifyErasureStorageDigestPush: true, notifyErasureStorageDigestMuteConfirmationLastSentAt: null, notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt: null, notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection: null, notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt: null, notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection: null, notifySilentAlertsDigest: true, notifyExhaustionAdminDigestFailed: true, notifyCoachingTipClosed: true });
  const [savingNotifPref, setSavingNotifPref] = useState<string | null>(null);
  const [keyPrefs, setKeyPrefs] = useState<NotificationKeyPrefsResponse>({ digestMode: false, keys: [] });
  const [savingKeyPref, setSavingKeyPref] = useState<string | null>(null);
  const [resettingKeyPrefs, setResettingKeyPrefs] = useState(false);
  // Task #1832 — single "Email digests" surface. The list comes from
  // `GET /api/portal/digest-preferences` which queries the shared digest
  // subscription registry on the API and only returns the user-scoped
  // entries (per-org digests live elsewhere).
  const [digestPrefs, setDigestPrefs] = useState<{ id: string; label: string; description: string; optedIn: boolean }[]>([]);
  const [savingDigestPref, setSavingDigestPref] = useState<string | null>(null);
  // Task #1619 — confirmation prompt before wiping every per-notification
  // override. Tracking the open state separately from `resettingKeyPrefs`
  // lets us close the dialog as soon as the user confirms while still
  // showing the busy label on the trigger button until the request settles.
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  // Task #2140 — one-time inline tip pointing at the new Task #1724
  // "admin payout re-verification" toggle. Coaches who already silenced
  // the broader Billing comm-prefs category would never notice the new
  // per-event switch otherwise. Persists per-user via `localStorage`
  // (keyed by user id so dismissing on one account doesn't hide it for
  // a different one signing in on the same browser). The first render
  // before `me` resolves keeps the tip hidden so anonymous viewers and
  // role-gated mounts never flash it.
  const tipStorageKey = me?.id != null ? `kharagolf:tip:adminPayoutReverify:dismissed:${me.id}` : null;
  const [adminPayoutReverifyTipDismissed, setAdminPayoutReverifyTipDismissed] = useState(true);
  useEffect(() => {
    if (!tipStorageKey) {
      setAdminPayoutReverifyTipDismissed(true);
      return;
    }
    try {
      const v = window.localStorage.getItem(tipStorageKey);
      setAdminPayoutReverifyTipDismissed(v === '1');
    } catch {
      setAdminPayoutReverifyTipDismissed(true);
    }
  }, [tipStorageKey]);
  function dismissAdminPayoutReverifyTip() {
    setAdminPayoutReverifyTipDismissed(true);
    if (!tipStorageKey) return;
    try {
      window.localStorage.setItem(tipStorageKey, '1');
    } catch {
      /* localStorage unavailable — best-effort; row still hides for the rest of this session */
    }
  }

  // Task #2218 — per-user, per-watermark dismissal flag for the
  // "recently muted" tip rendered below the stuck-erasure-digest
  // toggles. The storage key embeds the watermark ISO string so a
  // *new* mute (which advances the watermark to a new timestamp)
  // surfaces the tip again rather than silently staying dismissed.
  // The first render before `me` resolves and before the API hydrates
  // the watermark stays dismissed (`true`) so anonymous viewers and
  // pre-hydration mounts never flash an empty tip.
  const recentlyMutedAt = notifPrefs.notifyErasureStorageDigestMuteConfirmationLastSentAt;
  const recentlyMutedTipStorageKey = me?.id != null && recentlyMutedAt
    ? `kharagolf:tip:erasureDigestRecentlyMuted:dismissed:${me.id}:${recentlyMutedAt}`
    : null;
  const [recentlyMutedTipDismissed, setRecentlyMutedTipDismissed] = useState(true);
  useEffect(() => {
    if (!recentlyMutedTipStorageKey) {
      setRecentlyMutedTipDismissed(true);
      return;
    }
    try {
      const v = window.localStorage.getItem(recentlyMutedTipStorageKey);
      setRecentlyMutedTipDismissed(v === '1');
    } catch {
      setRecentlyMutedTipDismissed(true);
    }
  }, [recentlyMutedTipStorageKey]);
  function dismissRecentlyMutedTip() {
    setRecentlyMutedTipDismissed(true);
    if (!recentlyMutedTipStorageKey) return;
    try {
      window.localStorage.setItem(recentlyMutedTipStorageKey, '1');
    } catch {
      /* localStorage unavailable — best-effort; tip still hides for the rest of this session */
    }
  }
  // Task #2218 — one-click revert from the "recently muted" tip. Mirrors
  // the email confirmation's revert link (`maybeSendErasureDigestMuteConfirmation`):
  // re-enable BOTH stuck-erasure-digest channels in a single PATCH so the
  // server sees one atomic change (no risk of one channel being saved
  // without the other if the page navigates away mid-flight). Optimistic
  // update mirrors `saveNotifPref` — revert on failure. After the save
  // settles the tip dismisses itself for this watermark since neither
  // channel is muted anymore.
  const [revertingRecentlyMuted, setRevertingRecentlyMuted] = useState(false);
  async function revertRecentlyMutedDigest() {
    if (revertingRecentlyMuted) return;
    setRevertingRecentlyMuted(true);
    const prev = notifPrefs;
    setNotifPrefs({
      ...prev,
      notifyErasureStorageDigest: true,
      notifyErasureStorageDigestPush: true,
    });
    try {
      const r = await fetch(API('/portal/notification-preferences'), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notifyErasureStorageDigest: true,
          notifyErasureStorageDigestPush: true,
        }),
      });
      if (!r.ok) {
        setNotifPrefs(prev);
      } else {
        dismissRecentlyMutedTip();
      }
    } catch {
      setNotifPrefs(prev);
    }
    setRevertingRecentlyMuted(false);
  }

  useEffect(() => {
    fetch(API('/portal/my-comm-prefs'), { credentials: 'include' })
      .then(r => (r.ok ? r.json() : []))
      .then((rows: CommPrefRow[]) => setCommPrefs(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    fetch(API('/portal/notification-preferences'), { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((np) => {
        if (np) setNotifPrefs({
          notifySideGameReceipts: np.notifySideGameReceipts !== false,
          notifyManualEntryAlerts: np.notifyManualEntryAlerts !== false,
          notifyCoachPayoutAccountChanges: np.notifyCoachPayoutAccountChanges !== false,
          notifyAdminPayoutReverify: np.notifyAdminPayoutReverify !== false,
          notifySocialLinkAdded: np.notifySocialLinkAdded !== false,
          notifyDataExportExpiring: np.notifyDataExportExpiring !== false,
          notifyWalletRefundDigestFailed: np.notifyWalletRefundDigestFailed !== false,
          notifySideGameReceiptDigestFailed: np.notifySideGameReceiptDigestFailed !== false,
          notifyLevyLedgerDigestFailed: np.notifyLevyLedgerDigestFailed !== false,
          notifyLevyLedgerOrgDigestFailed: np.notifyLevyLedgerOrgDigestFailed !== false,
          notifyLevyRemindersDigestFailed: np.notifyLevyRemindersDigestFailed !== false,
          notifyErasureStorageDigest: np.notifyErasureStorageDigest !== false,
          notifyErasureStorageDigestPush: np.notifyErasureStorageDigestPush !== false,
          // Task #2218 — watermark column the API surfaces alongside the
          // toggles so the row can render an in-portal "you recently
          // muted this — re-enable" banner when the controller comes
          // back to the screen days after silencing the digest. Stays
          // null for controllers who have never silenced it from this
          // page (or whose last mute is older than the rate-limit window
          // wrote the watermark for).
          notifyErasureStorageDigestMuteConfirmationLastSentAt:
            typeof np.notifyErasureStorageDigestMuteConfirmationLastSentAt === 'string'
              ? np.notifyErasureStorageDigestMuteConfirmationLastSentAt
              : null,
          // Task #1772 — pass through the audit-trail fields the API
          // surfaces alongside the toggle so the row can render a
          // "Last changed via email link on <date> (unsubscribed)"
          // hint when the controller most recently flipped the
          // preference via the one-click email link. Both fields stay
          // null for controllers who have never used the link.
          notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt:
            typeof np.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt === 'string'
              ? np.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt
              : null,
          notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection:
            np.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection === 'unsubscribe' ||
            np.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection === 'resubscribe'
              ? np.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection
              : null,
          // Task #2212 — same audit-trail surface for the data-export-
          // expiring 24-hour heads-up reminder (Task #1773). The API
          // emits identical-shaped fields next to the toggle so the
          // chip can render the same "Last changed via email link on
          // <date> (unsubscribed)" line a member would see for the
          // erasure-storage digest. Both fields stay null when the
          // member has never used the per-request unsubscribe link.
          notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt:
            typeof np.notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt === 'string'
              ? np.notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt
              : null,
          notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
            np.notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection === 'unsubscribe' ||
            np.notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection === 'resubscribe'
              ? np.notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection
              : null,
          notifySilentAlertsDigest: np.notifySilentAlertsDigest !== false,
          notifyExhaustionAdminDigestFailed: np.notifyExhaustionAdminDigestFailed !== false,
          notifyCoachingTipClosed: np.notifyCoachingTipClosed !== false,
        });
      })
      .catch(() => {});
    fetch(API('/portal/notification-key-prefs'), { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((data: NotificationKeyPrefsResponse | null) => {
        if (data && Array.isArray(data.keys)) setKeyPrefs(data);
      })
      .catch(() => {});
    // Task #1832 — load the user-scoped digest subscriptions. The API
    // returns an empty array for users with no eligible digests
    // (player / spectator), so the section renders nothing for them
    // without the component needing to know the role rules.
    fetch(API('/portal/digest-preferences'), { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((data: { digests?: { id: string; label: string; description: string; optedIn: boolean }[] } | null) => {
        if (data && Array.isArray(data.digests)) setDigestPrefs(data.digests);
      })
      .catch(() => {});
  }, []);

  // Task #1619 — actual reset, only invoked from the confirm dialog action.
  async function performResetKeyPrefs() {
    if (resettingKeyPrefs) return;
    const hasOverrides = keyPrefs.keys.some(k => k.override !== null);
    if (!hasOverrides) return;
    setResettingKeyPrefs(true);
    try {
      const r = await fetch(API('/portal/notification-key-prefs'), {
        method: 'DELETE',
        credentials: 'include',
      });
      if (r.ok) {
        const refreshed = await fetch(API('/portal/notification-key-prefs'), { credentials: 'include' });
        if (refreshed.ok) {
          const data: NotificationKeyPrefsResponse = await refreshed.json();
          if (data && Array.isArray(data.keys)) setKeyPrefs(data);
        }
      }
    } catch {
      /* silent */
    }
    setResettingKeyPrefs(false);
  }

  async function saveKeyPref(key: string, nextMode: 'realtime' | 'digest' | null) {
    setSavingKeyPref(key);
    const prev = keyPrefs;
    // Optimistic update: bump both override + effectiveMode so the UI
    // reflects the user's choice immediately. We always store an explicit
    // override (rather than trying to detect "matches global"), which
    // makes the toggle's on/off state stable across changes to the global
    // digest_mode flag.
    //
    // Task #1618 — passing null clears the row's override and lets it
    // inherit the global digest setting again, so effectiveMode falls
    // back to whichever side digestMode points at.
    const fallbackMode: 'realtime' | 'digest' = prev.digestMode ? 'digest' : 'realtime';
    setKeyPrefs({
      digestMode: prev.digestMode,
      keys: prev.keys.map(k => k.key === key
        ? { ...k, override: nextMode, effectiveMode: nextMode ?? fallbackMode }
        : k),
    });
    try {
      const r = await fetch(API('/portal/notification-key-prefs'), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, deliveryMode: nextMode }),
      });
      if (!r.ok) setKeyPrefs(prev);
    } catch {
      setKeyPrefs(prev);
    }
    setSavingKeyPref(null);
  }

  // Task #1832 — flip a single user-scoped digest subscription from
  // the in-portal "Email digests" section. Optimistic update with
  // revert-on-failure mirrors `saveNotifPref` so the toggle feels
  // instant. The API records an audit row tagged with `source =
  // "portal_digest_settings"` regardless of which channel the user
  // came from.
  async function saveDigestPref(id: string, optedIn: boolean) {
    setSavingDigestPref(id);
    const prev = digestPrefs;
    setDigestPrefs(prev.map(d => d.id === id ? { ...d, optedIn } : d));
    try {
      const r = await fetch(API(`/portal/digest-preferences/${encodeURIComponent(id)}`), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optedIn }),
      });
      if (!r.ok) setDigestPrefs(prev);
    } catch {
      setDigestPrefs(prev);
    }
    setSavingDigestPref(null);
  }

  async function saveNotifPref(field: keyof NotifPrefs, value: boolean) {
    setSavingNotifPref(field);
    const prev = notifPrefs;
    setNotifPrefs({ ...prev, [field]: value });
    try {
      const r = await fetch(API('/portal/notification-preferences'), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!r.ok) {
        setNotifPrefs(prev);
      }
    } catch {
      setNotifPrefs(prev);
    }
    setSavingNotifPref(null);
  }

  function commPrefFor(category: string): CommPrefRow {
    return (
      commPrefs.find(p => p.category === category) ?? {
        id: 0,
        category,
        emailEnabled: true,
        smsEnabled: false,
        pushEnabled: true,
        whatsappEnabled: false,
        inAppEnabled: true,
      }
    );
  }

  async function saveCommPref(category: string, channel: CommPrefChannel, value: boolean) {
    const key = `${category}:${channel}`;
    setSavingCommPref(key);
    const current = commPrefFor(category);
    const body = {
      category,
      emailEnabled: current.emailEnabled ?? false,
      smsEnabled: current.smsEnabled ?? false,
      pushEnabled: current.pushEnabled ?? false,
      whatsappEnabled: current.whatsappEnabled ?? false,
      inAppEnabled: current.inAppEnabled ?? false,
      [channel]: value,
    };
    try {
      const r = await fetch(API('/portal/my-comm-prefs'), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const updated: CommPrefRow = await r.json();
        setCommPrefs(prev => {
          const idx = prev.findIndex(p => p.category === category);
          if (idx === -1) return [...prev, updated];
          const next = prev.slice();
          next[idx] = updated;
          return next;
        });
      }
    } catch {
      /* silent */
    }
    setSavingCommPref(null);
  }

  return (
    <Card id="comm-prefs" className="glass-panel border-white/10 p-6 scroll-mt-24" data-testid="card-comm-prefs">
      <div className="flex items-center gap-2 mb-3">
        <Bell className="w-5 h-5 text-primary" />
        <h3 className="text-white font-semibold text-base">{t('commPrefs.sectionTitle')}</h3>
      </div>
      <p className="text-sm text-muted-foreground mb-2">
        {t('commPrefs.intro')}
      </p>
      <p className="text-xs text-muted-foreground italic mb-5">
        {t('commPrefs.whatsappFootnote')}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="table-comm-prefs">
          <thead className="text-white/50">
            <tr>
              <th className="text-left py-2 pr-3">{t('commPrefs.headers.category')}</th>
              {CHANNELS.map(ch => (
                <th key={ch.field} className="px-2">{t(ch.headerKey)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map(cat => {
              const p = commPrefFor(cat.key);
              return (
                <tr key={cat.key} className="border-t border-white/5">
                  <td className="py-2 pr-3 text-white/90">{t(`commPrefs.categories.${cat.key}`)}</td>
                  {CHANNELS.map(ch => {
                    const rowKey = `${cat.key}:${ch.field}`;
                    const on = Boolean(p[ch.field]);
                    const busy = savingCommPref === rowKey;
                    return (
                      <td key={ch.field} className="text-center px-2">
                        <button
                          disabled={busy}
                          onClick={() => saveCommPref(cat.key, ch.field, !on)}
                          className={`w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                          aria-checked={on}
                          role="switch"
                          data-testid={`switch-comm-${cat.key}-${ch.field}`}
                        >
                          <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-6 pt-5 border-t border-white/10">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <Mail className="w-4 h-4 text-primary" />
          <h4 className="text-white font-semibold text-sm">{t('emailOptOuts.sectionTitle')}</h4>
          {/* Task #1775 — link out to the suppressed-notifications log so a
              controller who muted both channels for an alert can still see
              what fired. Sits next to the section heading so it's visible no
              matter which row got the user here from an unsubscribe link. */}
          <Link
            href="/portal/notification-audit"
            className="ml-auto inline-flex items-center gap-1 text-xs text-white/60 hover:text-white/90 underline-offset-2 hover:underline"
            data-testid="link-notification-audit"
          >
            <History className="w-3.5 h-3.5" />
            {t('emailOptOuts.viewSuppressedLink')}
          </Link>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          {t('emailOptOuts.sectionDescription')}
        </p>
        <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-manual-entry-alerts">
          <div>
            <div className="text-sm text-white/90">{t('emailOptOuts.manualEntryLabel')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('emailOptOuts.manualEntryDesc')}
            </div>
          </div>
          {(() => {
            const on = notifPrefs.notifyManualEntryAlerts;
            const busy = savingNotifPref === 'notifyManualEntryAlerts';
            return (
              <button
                disabled={busy}
                onClick={() => saveNotifPref('notifyManualEntryAlerts', !on)}
                className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                aria-checked={on}
                role="switch"
                data-testid="switch-notify-manual-entry-alerts"
              >
                <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </button>
            );
          })()}
        </div>
        <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-coach-payout-account-changes">
          <div>
            <div className="text-sm text-white/90">{t('emailOptOuts.coachPayoutLabel')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('emailOptOuts.coachPayoutDesc')}
            </div>
          </div>
          {(() => {
            const on = notifPrefs.notifyCoachPayoutAccountChanges;
            const busy = savingNotifPref === 'notifyCoachPayoutAccountChanges';
            return (
              <button
                disabled={busy}
                onClick={() => saveNotifPref('notifyCoachPayoutAccountChanges', !on)}
                className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                aria-checked={on}
                role="switch"
                data-testid="switch-notify-coach-payout-account-changes"
              >
                <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </button>
            );
          })()}
        </div>
        <div className="py-2 mb-3" data-testid="row-notify-admin-payout-reverify">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-white/90">{t('emailOptOuts.adminPayoutReverifyLabel')}</span>
                {/* Task #2140 — one-time "New" pill the first time a coach
                    opens this screen after the Task #1724 toggle ships,
                    so coaches who already silenced the broader Billing
                    category notice the new per-event switch. Hidden once
                    the inline tip below is dismissed. */}
                {!adminPayoutReverifyTipDismissed && (
                  <span
                    className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-primary/20 text-primary text-[10px] font-semibold uppercase tracking-wide"
                    data-testid="badge-admin-payout-reverify-new"
                  >
                    {t('emailOptOuts.adminPayoutReverifyNewBadge')}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t('emailOptOuts.adminPayoutReverifyDesc')}
              </div>
            </div>
            {(() => {
              const on = notifPrefs.notifyAdminPayoutReverify;
              const busy = savingNotifPref === 'notifyAdminPayoutReverify';
              return (
                <button
                  disabled={busy}
                  onClick={() => saveNotifPref('notifyAdminPayoutReverify', !on)}
                  className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  aria-checked={on}
                  role="switch"
                  data-testid="switch-notify-admin-payout-reverify"
                >
                  <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                </button>
              );
            })()}
          </div>
          {!adminPayoutReverifyTipDismissed && (
            <div
              className="mt-2 flex items-start gap-2 rounded-md border border-primary/20 bg-primary/10 px-3 py-2 text-xs text-white/80"
              role="note"
              data-testid="tip-admin-payout-reverify"
            >
              <span className="flex-1">{t('emailOptOuts.adminPayoutReverifyTipBody')}</span>
              <button
                type="button"
                onClick={dismissAdminPayoutReverifyTip}
                className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-white/70 hover:text-white hover:bg-white/10 transition-colors focus:outline-none"
                aria-label={t('emailOptOuts.adminPayoutReverifyTipDismiss')}
                data-testid="btn-dismiss-admin-payout-reverify-tip"
              >
                <span>{t('emailOptOuts.adminPayoutReverifyTipDismiss')}</span>
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
        {/* Task #2150 — per-event opt-out for the security heads-up
            email sent when an Apple/Google sign-in identity is freshly
            attached to the player's account (Task #1736). Default-on
            so the typical user keeps receiving the alert; surfacing the
            switch here lets a power user who links/unlinks providers
            frequently mute just this notice without flipping the
            umbrella `privacy` comm-prefs category. The label leads with
            "Account security" framing so it reads as a Security event
            even though the section heading is the generic emailOptOuts
            list. */}
        <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-social-link-added">
          <div>
            <div className="text-sm text-white/90">{t('emailOptOuts.socialLinkAddedLabel')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('emailOptOuts.socialLinkAddedDesc')}
            </div>
          </div>
          {(() => {
            const on = notifPrefs.notifySocialLinkAdded;
            const busy = savingNotifPref === 'notifySocialLinkAdded';
            return (
              <button
                disabled={busy}
                onClick={() => saveNotifPref('notifySocialLinkAdded', !on)}
                className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                aria-checked={on}
                role="switch"
                data-testid="switch-notify-social-link-added"
              >
                <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </button>
            );
          })()}
        </div>
        <div className="py-2 mb-3" data-testid="row-notify-data-export-expiring">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm text-white/90">{t('emailOptOuts.dataExportExpiringLabel')}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t('emailOptOuts.dataExportExpiringDesc')}
              </div>
            </div>
            {(() => {
              const on = notifPrefs.notifyDataExportExpiring;
              const busy = savingNotifPref === 'notifyDataExportExpiring';
              return (
                <button
                  disabled={busy}
                  onClick={() => saveNotifPref('notifyDataExportExpiring', !on)}
                  className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  aria-checked={on}
                  role="switch"
                  data-testid="switch-notify-data-export-expiring"
                >
                  <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                </button>
              );
            })()}
          </div>
          {(() => {
            // Task #2212 — surface the audit-trail hint the API exposes
            // alongside the toggle so a member who muted the 24-hour
            // heads-up reminder by clicking the public unsubscribe link
            // from one of their export-ready emails can still see when
            // (and which way) it was last flipped from the link, without
            // having to dig up the original email. Hidden when the
            // timestamp is null (member has never used the link). Mirrors
            // the Task #1772 erasure-storage-digest hint pattern below
            // so both rows render the same chip when the audit row
            // exists. The hint stays visible even after the member
            // flips the toggle back from the portal because the
            // member_audit_log row is permanent.
            const at = notifPrefs.notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt;
            const direction = notifPrefs.notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection;
            if (!at) return null;
            const parsed = new Date(at);
            if (Number.isNaN(parsed.getTime())) return null;
            const formatted = parsed.toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            });
            const directionLabel = direction === 'resubscribe'
              ? t('emailOptOuts.dataExportExpiringLinkChangeResubscribed')
              : t('emailOptOuts.dataExportExpiringLinkChangeUnsubscribed');
            return (
              <div
                className="mt-1 text-xs text-muted-foreground"
                data-testid="hint-notify-data-export-expiring-link-change"
              >
                {t('emailOptOuts.dataExportExpiringLinkChangeHint', {
                  date: formatted,
                  direction: directionLabel,
                })}
              </div>
            );
          })()}
        </div>
        {isController && (() => {
          // Task #1774 — derive a one-line live status under the two
          // toggles so a controller can tell at a glance which channels
          // are still reaching them. The four states map 1-to-1 to the
          // (email, push) cross-product the Task #1449 toggles produce.
          // The "both muted" state additionally surfaces a warning hint
          // because in that state the controller will only see new
          // stuck-erasure alerts if they happen to open the audit log
          // (the org-level escalation still fans out via these two
          // channels).
          const emailOn = notifPrefs.notifyErasureStorageDigest;
          const pushOn = notifPrefs.notifyErasureStorageDigestPush;
          const bothMuted = !emailOn && !pushOn;
          const statusKey = emailOn && pushOn
            ? 'emailOptOuts.erasureStorageStatusBoth'
            : emailOn
              ? 'emailOptOuts.erasureStorageStatusEmailOnly'
              : pushOn
                ? 'emailOptOuts.erasureStorageStatusPushOnly'
                : 'emailOptOuts.erasureStorageStatusBothMuted';
          const statusTestId = emailOn && pushOn
            ? 'erasure-storage-status-both'
            : emailOn
              ? 'erasure-storage-status-email-only'
              : pushOn
                ? 'erasure-storage-status-push-only'
                : 'erasure-storage-status-both-muted';
          return (
            <div className="py-2 mb-3" data-testid="row-notify-erasure-storage-digest">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm text-white/90">{t('emailOptOuts.erasureStorageDigestLabel')}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {t('emailOptOuts.erasureStorageDigestDesc')}
                  </div>
                </div>
                <div className="shrink-0 flex flex-col gap-2 items-end">
                  {(() => {
                    const on = emailOn;
                    const busy = savingNotifPref === 'notifyErasureStorageDigest';
                    return (
                      <label className="flex items-center gap-2 text-xs text-white/70">
                        <span>{t('emailOptOuts.erasureStorageEmail')}</span>
                        <button
                          disabled={busy}
                          onClick={() => saveNotifPref('notifyErasureStorageDigest', !on)}
                          className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                          aria-checked={on}
                          role="switch"
                          aria-label={t('emailOptOuts.erasureStorageEmailAria')}
                          data-testid="switch-notify-erasure-storage-digest-email"
                        >
                          <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                        </button>
                      </label>
                    );
                  })()}
                  {(() => {
                    const on = pushOn;
                    const busy = savingNotifPref === 'notifyErasureStorageDigestPush';
                    return (
                      <label className="flex items-center gap-2 text-xs text-white/70">
                        <span>{t('emailOptOuts.erasureStorageInAppPush')}</span>
                        <button
                          disabled={busy}
                          onClick={() => saveNotifPref('notifyErasureStorageDigestPush', !on)}
                          className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                          aria-checked={on}
                          role="switch"
                          aria-label={t('emailOptOuts.erasureStorageInAppPushAria')}
                          data-testid="switch-notify-erasure-storage-digest-push"
                        >
                          <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                        </button>
                      </label>
                    );
                  })()}
                </div>
              </div>
              <div
                className={`mt-2 text-xs ${bothMuted ? 'text-amber-300' : 'text-white/60'}`}
                aria-live="polite"
                data-testid="erasure-storage-status"
              >
                <span className="text-muted-foreground">{t('emailOptOuts.erasureStorageStatusPrefix')}</span>{' '}
                <span data-testid={statusTestId}>{t(statusKey)}</span>
              </div>
              {bothMuted && (
                <div
                  className="mt-1 text-xs text-amber-300/80"
                  role="note"
                  data-testid="erasure-storage-both-muted-hint"
                >
                  {t('emailOptOuts.erasureStorageBothMutedHint')}
                </div>
              )}
              {(() => {
                // Task #2218 — "you recently muted this" tip with a
                // one-click revert. Closes the loop on the email
                // confirmation Task #1776 already sends when a controller
                // silences the digest from the in-portal toggle: a
                // controller who comes back days later wondering "why
                // did the digest stop?" now sees a small banner and can
                // re-enable both channels without leaving the page.
                //
                // Visibility rules:
                //   - watermark column is non-null (controller muted via
                //     the in-portal toggle at least once)
                //   - watermark < 30 days old
                //   - at least ONE channel currently muted (re-enabling
                //     both makes the tip irrelevant — re-rendering it
                //     when nothing's muted would be confusing)
                //   - tip not dismissed for THIS watermark (a fresh mute
                //     advances the timestamp and re-surfaces the tip)
                const at = recentlyMutedAt;
                if (!at) return null;
                if (recentlyMutedTipDismissed) return null;
                if (emailOn && pushOn) return null;
                const parsed = new Date(at);
                if (Number.isNaN(parsed.getTime())) return null;
                const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
                const ageMs = Date.now() - parsed.getTime();
                if (ageMs < 0 || ageMs > THIRTY_DAYS_MS) return null;
                const formatted = parsed.toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                });
                // The body copy reflects which channel(s) the controller
                // actually has muted right now, so a controller who
                // already re-enabled one side gets accurate framing.
                const channelsKey = !emailOn && !pushOn
                  ? 'emailOptOuts.recentlyMutedTipChannelsBoth'
                  : !emailOn
                    ? 'emailOptOuts.recentlyMutedTipChannelsEmail'
                    : 'emailOptOuts.recentlyMutedTipChannelsPush';
                const channelsTestId = !emailOn && !pushOn
                  ? 'recently-muted-tip-channels-both'
                  : !emailOn
                    ? 'recently-muted-tip-channels-email'
                    : 'recently-muted-tip-channels-push';
                return (
                  <div
                    className="mt-2 flex items-start gap-2 rounded-md border border-primary/20 bg-primary/10 px-3 py-2 text-xs text-white/80"
                    role="note"
                    data-testid="tip-erasure-storage-digest-recently-muted"
                  >
                    <span className="flex-1" data-testid={channelsTestId}>
                      {t('emailOptOuts.recentlyMutedTipBody', {
                        date: formatted,
                        channels: t(channelsKey),
                      })}
                    </span>
                    <button
                      type="button"
                      disabled={revertingRecentlyMuted}
                      onClick={revertRecentlyMutedDigest}
                      className={`shrink-0 inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium text-primary hover:text-white hover:bg-primary/30 transition-colors focus:outline-none ${revertingRecentlyMuted ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                      data-testid="btn-revert-recently-muted-erasure-digest"
                    >
                      {t('emailOptOuts.recentlyMutedTipRevert')}
                    </button>
                    <button
                      type="button"
                      onClick={dismissRecentlyMutedTip}
                      className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-white/70 hover:text-white hover:bg-white/10 transition-colors focus:outline-none"
                      aria-label={t('emailOptOuts.recentlyMutedTipDismiss')}
                      data-testid="btn-dismiss-recently-muted-erasure-digest-tip"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })()}
              {(() => {
                // Task #1772 — surface the audit-trail hint the API exposes
                // alongside the toggle so a controller who muted the digest
                // by clicking the email's one-click unsubscribe link can
                // still see when (and which way) it was last flipped from
                // the link, without having to dig up the original email.
                // Hidden when the timestamp is null (controller has never
                // used the link). Lives inside the same row wrapper as the
                // Task #1774 status preview / both-muted warning so all
                // three pieces of context render together below the
                // toggles.
                const at = notifPrefs.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt;
                const direction = notifPrefs.notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection;
                if (!at) return null;
                const parsed = new Date(at);
                if (Number.isNaN(parsed.getTime())) return null;
                const formatted = parsed.toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                });
                const directionLabel = direction === 'unsubscribe'
                  ? t('emailOptOuts.erasureStorageDigestLinkChangeUnsubscribed')
                  : t('emailOptOuts.erasureStorageDigestLinkChangeResubscribed');
                return (
                  <div
                    className="mt-1 text-xs text-muted-foreground"
                    data-testid="hint-notify-erasure-storage-digest-link-change"
                  >
                    {t('emailOptOuts.erasureStorageDigestLinkChangeHint', {
                      date: formatted,
                      direction: directionLabel,
                    })}
                  </div>
                );
              })()}
            </div>
          );
        })()}
        <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-wallet-refund-digest-failed">
          <div>
            <div className="text-sm text-white/90">{t('emailOptOuts.walletRefundDigestFailedLabel')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('emailOptOuts.walletRefundDigestFailedDesc')}
            </div>
          </div>
          {(() => {
            const on = notifPrefs.notifyWalletRefundDigestFailed;
            const busy = savingNotifPref === 'notifyWalletRefundDigestFailed';
            return (
              <button
                disabled={busy}
                onClick={() => saveNotifPref('notifyWalletRefundDigestFailed', !on)}
                className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                aria-checked={on}
                role="switch"
                data-testid="switch-notify-wallet-refund-digest-failed"
              >
                <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </button>
            );
          })()}
        </div>
        <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-side-game-receipt-digest-failed">
          <div>
            <div className="text-sm text-white/90">{t('emailOptOuts.sideGameReceiptDigestFailedLabel')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('emailOptOuts.sideGameReceiptDigestFailedDesc')}
            </div>
          </div>
          {(() => {
            const on = notifPrefs.notifySideGameReceiptDigestFailed;
            const busy = savingNotifPref === 'notifySideGameReceiptDigestFailed';
            return (
              <button
                disabled={busy}
                onClick={() => saveNotifPref('notifySideGameReceiptDigestFailed', !on)}
                className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                aria-checked={on}
                role="switch"
                data-testid="switch-notify-side-game-receipt-digest-failed"
              >
                <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </button>
            );
          })()}
        </div>
        {/* Task #1762 — three new admin per-event opt-outs for the levy
            ledger / bounced-reminders digest failure alerts wired in by
            Task #1444. Rendered alongside (not gated to admins) the
            wallet/side-game refund digest opt-outs above so the row
            ordering matches `PER_EVENT_OPT_OUT_COLUMNS` in
            `notifyDispatch.ts` and a player who never receives them
            still sees a stable settings page (toggling them is harmless
            because they only ever fan out to admin/treasurer/
            membership_secretary roles). */}
        <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-levy-ledger-digest-failed">
          <div>
            <div className="text-sm text-white/90">{t('emailOptOuts.levyLedgerDigestFailedLabel')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('emailOptOuts.levyLedgerDigestFailedDesc')}
            </div>
          </div>
          {(() => {
            const on = notifPrefs.notifyLevyLedgerDigestFailed;
            const busy = savingNotifPref === 'notifyLevyLedgerDigestFailed';
            return (
              <button
                disabled={busy}
                onClick={() => saveNotifPref('notifyLevyLedgerDigestFailed', !on)}
                className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                aria-checked={on}
                role="switch"
                data-testid="switch-notify-levy-ledger-digest-failed"
              >
                <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </button>
            );
          })()}
        </div>
        <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-levy-ledger-org-digest-failed">
          <div>
            <div className="text-sm text-white/90">{t('emailOptOuts.levyLedgerOrgDigestFailedLabel')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('emailOptOuts.levyLedgerOrgDigestFailedDesc')}
            </div>
          </div>
          {(() => {
            const on = notifPrefs.notifyLevyLedgerOrgDigestFailed;
            const busy = savingNotifPref === 'notifyLevyLedgerOrgDigestFailed';
            return (
              <button
                disabled={busy}
                onClick={() => saveNotifPref('notifyLevyLedgerOrgDigestFailed', !on)}
                className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                aria-checked={on}
                role="switch"
                data-testid="switch-notify-levy-ledger-org-digest-failed"
              >
                <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </button>
            );
          })()}
        </div>
        <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-levy-reminders-digest-failed">
          <div>
            <div className="text-sm text-white/90">{t('emailOptOuts.levyRemindersDigestFailedLabel')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('emailOptOuts.levyRemindersDigestFailedDesc')}
            </div>
          </div>
          {(() => {
            const on = notifPrefs.notifyLevyRemindersDigestFailed;
            const busy = savingNotifPref === 'notifyLevyRemindersDigestFailed';
            return (
              <button
                disabled={busy}
                onClick={() => saveNotifPref('notifyLevyRemindersDigestFailed', !on)}
                className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                aria-checked={on}
                role="switch"
                data-testid="switch-notify-levy-reminders-digest-failed"
              >
                <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </button>
            );
          })()}
        </div>
        {me?.role === 'super_admin' && (
          <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-silent-alerts-digest">
            <div>
              <div className="text-sm text-white/90">{t('emailOptOuts.silentAlertsDigestLabel')}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t('emailOptOuts.silentAlertsDigestDesc')}
              </div>
            </div>
            {(() => {
              const on = notifPrefs.notifySilentAlertsDigest;
              const busy = savingNotifPref === 'notifySilentAlertsDigest';
              return (
                <button
                  disabled={busy}
                  onClick={() => saveNotifPref('notifySilentAlertsDigest', !on)}
                  className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  aria-checked={on}
                  role="switch"
                  data-testid="switch-notify-silent-alerts-digest"
                >
                  <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                </button>
              );
            })()}
          </div>
        )}
        {/* Task #2154 — surfaced super-admin toggle for the daily
            exhaustion-admin-digest cron failed alert
            (`notify.exhaustion.admin_digest.failed`). Same role gate as
            silent-alerts-digest because the cron only ever fans out to
            super_admin. Without this row, a super_admin who muted the
            alert via the email link could not re-subscribe without
            finding the original message. */}
        {me?.role === 'super_admin' && (
          <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-exhaustion-admin-digest-failed">
            <div>
              <div className="text-sm text-white/90">{t('emailOptOuts.exhaustionAdminDigestFailedLabel')}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t('emailOptOuts.exhaustionAdminDigestFailedDesc')}
              </div>
            </div>
            {(() => {
              const on = notifPrefs.notifyExhaustionAdminDigestFailed;
              const busy = savingNotifPref === 'notifyExhaustionAdminDigestFailed';
              return (
                <button
                  disabled={busy}
                  onClick={() => saveNotifPref('notifyExhaustionAdminDigestFailed', !on)}
                  className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  aria-checked={on}
                  role="switch"
                  data-testid="switch-notify-exhaustion-admin-digest-failed"
                >
                  <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                </button>
              );
            })()}
          </div>
        )}
        {/* Task #2154 — surfaced player-facing toggle for the
            "you closed the gap" coaching encouragement push
            (`coaching.gap.closed`). Visible to everyone (the dispatcher
            only sends to players, but spectators-with-an-attached-player
            still own the same row); previously only mute-able from the
            push itself. */}
        <div className="flex items-start justify-between gap-4 py-2 mb-3" data-testid="row-notify-coaching-tip-closed">
          <div>
            <div className="text-sm text-white/90">{t('emailOptOuts.coachingTipClosedLabel')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('emailOptOuts.coachingTipClosedDesc')}
            </div>
          </div>
          {(() => {
            const on = notifPrefs.notifyCoachingTipClosed;
            const busy = savingNotifPref === 'notifyCoachingTipClosed';
            return (
              <button
                disabled={busy}
                onClick={() => saveNotifPref('notifyCoachingTipClosed', !on)}
                className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                aria-checked={on}
                role="switch"
                data-testid="switch-notify-coaching-tip-closed"
              >
                <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </button>
            );
          })()}
        </div>
        <div className="flex items-start justify-between gap-4 py-2" data-testid="row-notify-side-game-receipts">
          <div>
            <div className="text-sm text-white/90">{t('emailOptOuts.sideGameReceiptsLabel')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t('emailOptOuts.sideGameReceiptsDesc')}
            </div>
          </div>
          {(() => {
            const on = notifPrefs.notifySideGameReceipts;
            const busy = savingNotifPref === 'notifySideGameReceipts';
            return (
              <button
                disabled={busy}
                onClick={() => saveNotifPref('notifySideGameReceipts', !on)}
                className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                aria-checked={on}
                role="switch"
                data-testid="switch-notify-side-game-receipts"
              >
                <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </button>
            );
          })()}
        </div>
      </div>

      {/* Task #1832 — single "Email digests" surface. Lists every
          user-scoped controller-facing email digest the registry knows
          about (today: stuck-erasure cleanup, monthly member-prefs)
          alongside the caller's current opt-in state. Hidden entirely
          for users who have no eligible digests (the API returns an
          empty array for player / spectator). Per-(user, org) digests
          like the bounced-digest schedule pair stay on their existing
          per-org subscription surface — see the registry comments. */}
      {digestPrefs.length > 0 && (
        <div className="mt-6 pt-5 border-t border-white/10" data-testid="section-digest-prefs">
          <div className="flex items-center gap-2 mb-3">
            <Mail className="w-4 h-4 text-primary" />
            <h4 className="text-white font-semibold text-sm">{t('digestPrefs.sectionTitle')}</h4>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            {t('digestPrefs.sectionDescription')}
          </p>
          {digestPrefs.map(d => {
            const on = d.optedIn;
            const busy = savingDigestPref === d.id;
            return (
              <div
                key={d.id}
                className="flex items-start justify-between gap-4 py-2 border-b border-white/5 last:border-0"
                data-testid={`row-digest-pref-${d.id}`}
              >
                <div>
                  <div className="text-sm text-white/90">{d.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{d.description}</div>
                </div>
                <button
                  disabled={busy}
                  onClick={() => saveDigestPref(d.id, !on)}
                  className={`shrink-0 w-9 h-5 rounded-full transition-colors relative focus:outline-none ${on ? 'bg-primary' : 'bg-white/20'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  aria-checked={on}
                  role="switch"
                  data-testid={`switch-digest-pref-${d.id}`}
                >
                  <span className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform absolute top-[3px] ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {keyPrefs.keys.length > 0 && (
        <div className="mt-6 pt-5 border-t border-white/10" data-testid="section-notification-key-prefs">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" />
              <h4 className="text-white font-semibold text-sm">{t('commPrefsKey.sectionTitle')}</h4>
            </div>
            {(() => {
              const hasOverrides = keyPrefs.keys.some(k => k.override !== null);
              const disabled = resettingKeyPrefs || !hasOverrides;
              return (
                <button
                  type="button"
                  // Task #1619 — open the confirm dialog instead of firing the
                  // DELETE immediately so a misclick can't wipe every override.
                  onClick={() => { if (!disabled) setConfirmResetOpen(true); }}
                  disabled={disabled}
                  data-testid="btn-reset-notification-key-prefs"
                  className={`text-xs px-3 py-1 rounded-md border border-white/15 transition-colors ${disabled ? 'opacity-40 cursor-not-allowed text-white/50' : 'text-white/80 hover:bg-white/10 cursor-pointer'}`}
                >
                  {resettingKeyPrefs ? t('commPrefsKey.resetting') : t('commPrefsKey.resetButton')}
                </button>
              );
            })()}
          </div>
          <p className="text-xs text-muted-foreground mb-1">
            {t('commPrefsKey.sectionDescription')}
          </p>
          {/* Task #1616 — render the digest-mode status as prefix + bold word
              + suffix so the bold styling survives translation. Some
              languages may shift word order; if that becomes a problem we
              can swap to react-i18next's <Trans>. */}
          <p className="text-xs text-muted-foreground mb-4">
            {t('commPrefsKey.digestModePrefix')}{' '}
            <span className="text-white/80 font-medium">
              {keyPrefs.digestMode ? t('commPrefsKey.digestModeOn') : t('commPrefsKey.digestModeOff')}
            </span>
            {t('commPrefsKey.digestModeSuffix')}
          </p>
          <div className="space-y-2">
            {keyPrefs.keys.map(k => {
              const isDigest = k.effectiveMode === 'digest';
              const busy = savingKeyPref === k.key;
              // Task #2017 — every digestable notification key now ships
              // with a localised description in the i18n bundle for all
              // 21 supported locales (keyed by the notification key under
              // `notificationKeys`). Look up the translation; fall back
              // to the API's English description only as a defensive
              // safety net for a key that gets added to the registry
              // before its translation lands.
              const translationKey = `notificationKeys.${k.key}`;
              const NO_KEY_TRANSLATION = '__no_translation__';
              const probed = t(translationKey, { defaultValue: NO_KEY_TRANSLATION });
              const hasTranslation = probed !== NO_KEY_TRANSLATION && probed !== translationKey;
              const description = hasTranslation ? probed : k.description;
              return (
                <div
                  key={k.key}
                  className="flex items-start justify-between gap-4 py-2 border-b border-white/5 last:border-0"
                  data-testid={`row-key-pref-${k.key}`}
                >
                  <div className="min-w-0">
                    <div className="text-sm text-white/90 truncate">{description}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">
                      {k.key} · {k.category}
                    </div>
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <div className="inline-flex rounded-md overflow-hidden border border-white/10" role="group" aria-label={t('commPrefsKey.deliveryModeAria', { key: k.key })}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => { if (isDigest) saveKeyPref(k.key, 'realtime'); }}
                        aria-pressed={!isDigest}
                        data-testid={`btn-key-pref-${k.key}-realtime`}
                        className={`px-3 py-1 text-xs transition-colors ${!isDigest ? 'bg-primary text-white' : 'bg-transparent text-white/60 hover:text-white/90'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                      >
                        {t('commPrefsKey.realtime')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => { if (!isDigest) saveKeyPref(k.key, 'digest'); }}
                        aria-pressed={isDigest}
                        data-testid={`btn-key-pref-${k.key}-digest`}
                        className={`px-3 py-1 text-xs transition-colors border-l border-white/10 ${isDigest ? 'bg-primary text-white' : 'bg-transparent text-white/60 hover:text-white/90'} ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                      >
                        {t('commPrefsKey.dailySummary')}
                      </button>
                    </div>
                    {/* Task #1618 — only render the "Use default" link when
                        this row currently has an explicit override; clicking
                        it clears just this key so it falls back to the
                        global digest setting. */}
                    {k.override !== null && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => saveKeyPref(k.key, null)}
                        data-testid={`btn-key-pref-${k.key}-clear`}
                        className={`text-[11px] underline-offset-2 hover:underline ${busy ? 'opacity-50 cursor-not-allowed text-white/40' : 'text-white/60 hover:text-white/90 cursor-pointer'}`}
                      >
                        {t('commPrefsKey.useDefault')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Task #1619 — confirm prompt before wiping every per-key override.
          The DELETE only runs when the user clicks the action; cancelling
          (via button, ESC, or overlay click) leaves preferences untouched. */}
      <AlertDialog
        open={confirmResetOpen}
        onOpenChange={open => {
          if (!open && !resettingKeyPrefs) setConfirmResetOpen(false);
        }}
      >
        <AlertDialogContent data-testid="dialog-confirm-reset-notification-key-prefs">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('commPrefsKey.resetConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('commPrefsKey.resetConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="btn-cancel-reset-notification-key-prefs"
              disabled={resettingKeyPrefs}
            >
              {t('commPrefsKey.resetConfirmCancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="btn-confirm-reset-notification-key-prefs"
              disabled={resettingKeyPrefs}
              onClick={(e) => {
                // Close the dialog immediately, then run the DELETE in the
                // background. The trigger button shows the "Resetting…"
                // busy state while the request is in flight.
                e.preventDefault();
                setConfirmResetOpen(false);
                void performResetKeyPrefs();
              }}
            >
              {resettingKeyPrefs ? t('commPrefsKey.resetting') : t('commPrefsKey.resetButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default PortalCommPrefs;
