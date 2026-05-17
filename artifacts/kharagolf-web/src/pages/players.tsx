import { useState, useCallback, useEffect } from 'react';
import { resolveAvatarSrc } from '@/lib/avatarPresets';
import { useGetMe, useListOrgMembers, useAddOrgMember, useRemoveOrgMember, useUpdateMemberRole, useUpdateMemberNotifPrefs, useGetMemberAuditLog, useGetLastMemberPrefsDigest, getGetLastMemberPrefsDigestQueryKey } from '@workspace/api-client-react';
import type { AddMemberInputRole, UpdateRoleInputRole, MemberAuditLogEntry } from '@workspace/api-client-react';
import { motion } from 'framer-motion';
import {
  Users, UserPlus, Trash2, ShieldCheck, Search, ChevronDown, Link2, RefreshCw, Unlink, ChevronRight,
  ShieldAlert, KeyRound, CheckCircle2, Mail, Edit2, X, Eye, EyeOff, Calendar, Trophy, CreditCard, ShoppingBag,
  Flag, TrendingUp, TrendingDown, AlertCircle, Loader2, Download, BellOff, Filter, History, MailCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FollowButton } from '@/components/FollowButton';
import { useFolloweeIds } from '@/hooks/useFolloweeIds';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';

interface UnlinkedPlayerRecord {
  playerId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  tournamentId: number;
  tournamentName: string;
}

interface NotifPrefs {
  preferEmail: boolean;
  preferPush: boolean;
  preferSms: boolean;
  preferWhatsapp: boolean;
  notifySideGameReceipts: boolean;
}

const ROLE_CONFIG: Record<string, { label: string; className: string }> = {
  org_admin:            { label: 'Admin',               className: 'bg-primary/20 text-primary border-primary/30' },
  tournament_director:  { label: 'Director',            className: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  player:               { label: 'Player',              className: 'bg-white/10 text-white border-white/20' },
  pro_shop:             { label: 'Pro Shop',            className: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  spectator:            { label: 'Spectator',           className: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
  committee_member:     { label: 'Committee Member',    className: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  volunteer:            { label: 'Volunteer',           className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
};

const ROLE_OPTIONS = [
  { value: 'org_admin', label: 'Admin' },
  { value: 'tournament_director', label: 'Tournament Director' },
  { value: 'player', label: 'Player' },
  { value: 'pro_shop', label: 'Pro Shop' },
  { value: 'spectator', label: 'Spectator' },
  { value: 'committee_member', label: 'Committee Member' },
  { value: 'volunteer', label: 'Volunteer' },
];

/* ── Types for Player Accounts tab ── */
interface PortalAccount {
  id: number;
  displayName: string | null;
  username: string;
  email: string | null;
  role: string;
  memberRole: string;
  emailVerified: boolean;
  isPortalAccount: boolean;
  organizationId: number | null;
  joinedAt: string;
  createdAt: string;
  updatedAt: string;
  profileImage?: string | null;
}

interface PortalAccountDetail extends PortalAccount {
  hasPassword: boolean;
  ghinNumber: string | null;
  registrations: Array<{
    playerId: number;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    handicapIndex: string | null;
    paymentStatus: string;
    checkedIn: boolean;
    registeredAt: string;
    tournamentId: number;
    tournamentName: string;
    tournamentStatus: string;
    tournamentDate: string | null;
  }>;
  shopOrders: Array<{
    id: number;
    productName: string;
    quantity: number;
    totalAmount: string;
    currency: string;
    status: string;
    createdAt: string;
  }>;
  clubMemberships: Array<{
    clubMemberId: number;
    memberNumber: string | null;
    subscriptionStatus: string;
    joinDate: string;
    renewalDate: string | null;
    lastPaymentAt: string | null;
    nextBillingDate: string | null;
  }>;
  recentActivity: Array<{
    type: string;
    description: string;
    timestamp: string;
  }>;
  paymentSummary: {
    tournamentsRegistered: number;
    tournamentsPaid: number;
    tournamentsPending: number;
    shopOrderCount: number;
    shopTotalSpend: number;
    shopTotalRefunded: number;
  };
}

const ADMIN_ROLES = new Set(['org_admin', 'tournament_director', 'super_admin']);

/**
 * Compact channel-preference badge used in the Member Directory's notify column.
 * Renders three states:
 *   - admin + enabled  → coloured pill, click flips OFF (mute) via the
 *     confirmation dialog. Shown for every channel so admins can mute on a
 *     member's behalf when the member calls in.
 *   - admin + disabled → muted pill, click flips ON via the same dialog.
 *   - non-admin        → tooltip-only enabled pill, no click target. Disabled
 *     channels are simply not rendered for non-admins (matches the original
 *     read-only behaviour where opt-outs other than side-game receipts were
 *     hidden).
 */
function ChannelBadge({
  channel,
  shortLabel,
  enabled,
  enabledClass,
  isAdmin,
  onToggle,
}: {
  channel: 'preferEmail' | 'preferPush' | 'preferSms' | 'preferWhatsapp';
  shortLabel: string;
  enabled: boolean;
  enabledClass: string;
  isAdmin: boolean;
  onToggle: (nextValue: boolean) => void;
}) {
  const enabledTooltip = `Receives ${shortLabel === 'WA' ? 'WhatsApp' : shortLabel} notifications`;
  const disabledTooltip = `Member opted out of ${shortLabel === 'WA' ? 'WhatsApp' : shortLabel} notifications`;
  const baseClass = 'text-[10px] px-1.5 py-0.5 rounded border';

  if (enabled) {
    if (isAdmin) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid={`notif-${channel}-toggle-${enabled ? 'on' : 'off'}`}
              onClick={() => onToggle(false)}
              className={`${baseClass} ${enabledClass} hover:brightness-125 cursor-pointer`}
            >
              {shortLabel}
            </button>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            Click to mute {shortLabel === 'WA' ? 'WhatsApp' : shortLabel} notifications for this member
          </TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`${baseClass} ${enabledClass} cursor-default`}>{shortLabel}</span>
        </TooltipTrigger>
        <TooltipContent className="text-xs">{enabledTooltip}</TooltipContent>
      </Tooltip>
    );
  }

  // Disabled state — only surfaced to admins (non-admins see nothing, matching
  // the original UI for the channel badges).
  if (!isAdmin) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={`notif-${channel}-toggle-off`}
          onClick={() => onToggle(true)}
          className={`${baseClass} bg-white/5 text-muted-foreground border-white/10 hover:bg-white/10 hover:text-emerald-400 line-through cursor-pointer`}
        >
          {shortLabel}
        </button>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        {disabledTooltip}. Click to re-enable on this member's behalf.
      </TooltipContent>
    </Tooltip>
  );
}

export default function PlayersPage() {
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const isAdmin = ADMIN_ROLES.has(user?.role ?? '');
  const [activeTab, setActiveTab] = useState<'directory' | 'accounts'>('directory');

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-white tracking-tight">Players</h1>
          <p className="text-muted-foreground mt-1">Manage members, roles, and portal accounts for your organization.</p>
        </div>
      </div>

      {/* Top-level tab switcher — Player Accounts tab only visible to admins/directors */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList className="bg-black/40 border border-white/5 p-1 rounded-xl">
          <TabsTrigger value="directory" className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white text-muted-foreground px-5 py-1.5 text-sm font-medium">
            <Users className="w-4 h-4 mr-2" />
            Member Directory
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="accounts" className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white text-muted-foreground px-5 py-1.5 text-sm font-medium">
              <ShieldAlert className="w-4 h-4 mr-2" />
              Player Accounts
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>

      {activeTab === 'directory' ? (
        <MemberDirectoryTab orgId={orgId} currentUserId={user?.id} isAdmin={isAdmin} />
      ) : isAdmin ? (
        <PlayerAccountsTab orgId={orgId} />
      ) : null}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   MEMBER DIRECTORY TAB (existing functionality)
════════════════════════════════════════════════════════════════ */

function MemberDirectoryTab({ orgId, currentUserId, isAdmin }: { orgId: number; currentUserId?: number; isAdmin: boolean }) {
  const { data: members, isLoading } = useListOrgMembers(orgId, { query: { enabled: !!orgId } });
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [syncingUserId, setSyncingUserId] = useState<number | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<number | null>(null);
  const [playerRecords, setPlayerRecords] = useState<Record<number, Array<{ playerId: number; firstName: string; lastName: string; email: string | null; tournamentId: number }>>>({});
  const [loadingRecordsFor, setLoadingRecordsFor] = useState<number | null>(null);
  const [unlinkingPlayerId, setUnlinkingPlayerId] = useState<number | null>(null);
  const [committeeAdjs, setCommitteeAdjs] = useState<Record<number, Array<{
    id: number; playerId: number; firstName: string; lastName: string;
    previousHandicapIndex: number | null; newHandicapIndex: number;
    adjustmentStrokes: number | null; adjustmentReason: string;
    committeeNotes: string | null; adjusterName: string | null;
    tournamentName: string | null; adjustedAt: string;
  }>>>({});
  const [loadingAdjsFor, setLoadingAdjsFor] = useState<number | null>(null);
  const [flagDialogUserId, setFlagDialogUserId] = useState<number | null>(null);
  const [flagPlayerId, setFlagPlayerId] = useState<number | null>(null);
  const [flagPlayerName, setFlagPlayerName] = useState('');
  const [flagDiff, setFlagDiff] = useState('');
  const [flagNotes, setFlagNotes] = useState('');
  const [flagSubmitting, setFlagSubmitting] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkTargetUserId, setLinkTargetUserId] = useState<number | null>(null);
  const [linkTargetUserName, setLinkTargetUserName] = useState('');
  const [unlinkedRecords, setUnlinkedRecords] = useState<UnlinkedPlayerRecord[]>([]);
  const [loadingUnlinked, setLoadingUnlinked] = useState(false);
  const [linkingPlayerId, setLinkingPlayerId] = useState<number | null>(null);
  const [linkSearch, setLinkSearch] = useState('');
  // Admin-side notification preference toggle dialog. `field` selects which
  // pref the dialog targets — originally just side-game receipts (Task #1272),
  // extended in Task #1506 to cover the channel toggles so admins running
  // phone-support workflows can flip Email / Push / SMS / WhatsApp on a
  // member's behalf with the same confirmation + audit trail.
  type NotifPrefField = 'preferEmail' | 'preferPush' | 'preferSms' | 'preferWhatsapp' | 'notifySideGameReceipts';
  const [notifDialog, setNotifDialog] = useState<{
    userId: number;
    memberLabel: string;
    field: NotifPrefField;
    nextValue: boolean;
  } | null>(null);
  const [notifReason, setNotifReason] = useState('');

  // Friendly labels + per-channel copy for the confirmation dialog and the
  // success toast — kept in one place so adding another channel later only
  // needs one edit.
  const NOTIF_FIELD_META: Record<NotifPrefField, { label: string; channelNoun: string }> = {
    preferEmail:           { label: 'Email notifications',     channelNoun: 'email notifications' },
    preferPush:            { label: 'Push notifications',      channelNoun: 'push notifications' },
    preferSms:             { label: 'SMS notifications',       channelNoun: 'SMS notifications' },
    preferWhatsapp:        { label: 'WhatsApp notifications',  channelNoun: 'WhatsApp notifications' },
    notifySideGameReceipts:{ label: 'Side-game receipts',      channelNoun: 'side-game receipt emails' },
  };

  // Recently-changed-prefs panel (Task #1490). Treasurers want to spot a
  // sudden spike in opt-outs after a noisy push. Each row in the panel
  // is a channel/category with the count of currently-opted-out members
  // whose `user_notification_prefs.updated_at` falls inside the window;
  // clicking a row narrows the table below to those userIds.
  type PrefChangeRow = {
    key: string;
    label: string;
    group: 'channel' | 'category';
    optedOutCount: number;
    userIds: number[];
    // Task #1833 — week-over-week buckets so the panel can render a
    // ▲/▼ delta + percentage and highlight rows with a >50% spike.
    currentWeekOptedOutCount: number;
    priorWeekOptedOutCount: number;
  };
  const [recentChanges, setRecentChanges] = useState<{ windowDays: number; totalUsersChanged: number; rows: PrefChangeRow[] } | null>(null);
  const [loadingRecentChanges, setLoadingRecentChanges] = useState(false);
  const [recentChangesError, setRecentChangesError] = useState(false);
  const [prefFilter, setPrefFilter] = useState<{ key: string; label: string; userIds: Set<number> } | null>(null);

  // Extracted so the panel can be refreshed after admin-side preference
  // mutations (e.g. the side-game receipt toggle below) — otherwise the
  // panel would silently drift out of sync until the page reloads.
  const fetchRecentChanges = useCallback(async () => {
    if (!orgId || !isAdmin) return;
    setLoadingRecentChanges(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/notification-prefs/recent-changes`, { credentials: 'include' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setRecentChanges(data);
      setRecentChangesError(false);
    } catch {
      // Panel is best-effort; surface a distinct error state so admins
      // do not mistake a failed fetch for "no opt-outs".
      setRecentChangesError(true);
    } finally {
      setLoadingRecentChanges(false);
    }
  }, [orgId, isAdmin]);

  useEffect(() => { fetchRecentChanges(); }, [fetchRecentChanges]);

  // Task #1831 — "Last digest sent" card. Reads the most recent
  // `member_audit_log` row written by the monthly `sendMemberPrefsDigest`
  // cron so controllers can confirm who's still on the distribution list
  // without poking the audit log table directly. Admin-only (gated by
  // the same RBAC as the rest of the panel via the server endpoint).
  const {
    data: lastDigestData,
    isLoading: loadingLastDigest,
    isError: lastDigestError,
    refetch: refetchLastDigest,
  } = useGetLastMemberPrefsDigest(orgId, {
    query: {
      enabled: !!orgId && isAdmin,
      queryKey: getGetLastMemberPrefsDigestQueryKey(orgId),
    },
  });
  const lastDigest = lastDigestData?.lastDigest ?? null;

  async function fetchPlayerRecords(userId: number) {
    setLoadingRecordsFor(userId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/${userId}/player-records`, { credentials: 'include' });
      const data = await res.json();
      setPlayerRecords(prev => ({ ...prev, [userId]: Array.isArray(data) ? data : [] }));
    } catch {
      setPlayerRecords(prev => ({ ...prev, [userId]: [] }));
    } finally {
      setLoadingRecordsFor(null);
    }
  }

  async function fetchCommitteeAdjs(userId: number, playerIds: number[]) {
    if (!playerIds.length) return;
    setLoadingAdjsFor(userId);
    try {
      const allAdjs: typeof committeeAdjs[number] = [];
      await Promise.all(playerIds.map(async (pid) => {
        const res = await fetch(`/api/organizations/${orgId}/handicap/adjustments?playerId=${pid}`, { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data)) allAdjs.push(...data);
      }));
      allAdjs.sort((a, b) => new Date(b.adjustedAt).getTime() - new Date(a.adjustedAt).getTime());
      setCommitteeAdjs(prev => ({ ...prev, [userId]: allAdjs }));
    } catch {
      setCommitteeAdjs(prev => ({ ...prev, [userId]: [] }));
    } finally {
      setLoadingAdjsFor(null);
    }
  }

  async function toggleExpanded(userId: number) {
    if (expandedUserId === userId) {
      setExpandedUserId(null);
    } else {
      setExpandedUserId(userId);
      if (!playerRecords[userId]) {
        const res = await fetch(`/api/organizations/${orgId}/members/${userId}/player-records`, { credentials: 'include' });
        const data = await res.json();
        const recs = Array.isArray(data) ? data : [];
        setPlayerRecords(prev => ({ ...prev, [userId]: recs }));
        if (recs.length && !committeeAdjs[userId]) {
          await fetchCommitteeAdjs(userId, recs.map((r: { playerId: number }) => r.playerId));
        }
      } else if (!committeeAdjs[userId] && (playerRecords[userId] ?? []).length) {
        await fetchCommitteeAdjs(userId, playerRecords[userId].map(r => r.playerId));
      }
    }
  }

  async function submitFlagFromPlayer() {
    if (!flagPlayerId || !flagDiff) return;
    setFlagSubmitting(true);
    try {
      const diff = parseFloat(flagDiff);
      if (isNaN(diff)) { toast({ title: 'Invalid differential', variant: 'destructive' }); return; }
      const res = await fetch(`/api/organizations/${orgId}/handicap/exceptional-scores`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: flagPlayerId, scoreDifferential: diff, notes: flagNotes || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to flag');
      toast({ title: 'Score flagged for committee review', description: `Flag #${data.id} created` });
      setFlagDialogUserId(null);
      setFlagPlayerId(null);
      setFlagPlayerName('');
      setFlagDiff('');
      setFlagNotes('');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Flag failed';
      toast({ title: msg, variant: 'destructive' });
    } finally {
      setFlagSubmitting(false);
    }
  }

  async function unlinkPlayerRecord(userId: number, playerId: number) {
    setUnlinkingPlayerId(playerId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/${userId}/player-records/${playerId}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Unlink failed');
      toast({ title: 'Player record unlinked', description: data.message });
      setPlayerRecords(prev => ({ ...prev, [userId]: (prev[userId] ?? []).filter(r => r.playerId !== playerId) }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unlink failed';
      toast({ title: msg, variant: 'destructive' });
    } finally {
      setUnlinkingPlayerId(null);
    }
  }

  async function syncPlayerRecords(userId: number) {
    setSyncingUserId(userId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/${userId}/sync-player-records`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sync failed');
      toast({ title: 'Player records synced', description: data.message });
      invalidate();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Sync failed';
      toast({ title: msg, variant: 'destructive' });
    } finally {
      setSyncingUserId(null);
    }
  }

  async function openLinkDialog(userId: number, displayName: string) {
    setLinkTargetUserId(userId);
    setLinkTargetUserName(displayName);
    setLinkSearch('');
    setLinkDialogOpen(true);
    setLoadingUnlinked(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/unlinked-player-records`, { credentials: 'include' });
      const data = await res.json();
      setUnlinkedRecords(Array.isArray(data) ? data : []);
    } catch {
      setUnlinkedRecords([]);
    } finally {
      setLoadingUnlinked(false);
    }
  }

  async function linkPlayerRecord(playerId: number) {
    if (!linkTargetUserId) return;
    setLinkingPlayerId(playerId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/${linkTargetUserId}/player-records`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Link failed');
      toast({ title: 'Player record linked', description: data.message });
      setUnlinkedRecords(prev => prev.filter(r => r.playerId !== playerId));
      await fetchPlayerRecords(linkTargetUserId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Link failed';
      toast({ title: msg, variant: 'destructive' });
    } finally {
      setLinkingPlayerId(null);
    }
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/members`] });

  const { mutate: removeOrgMember } = useRemoveOrgMember({
    mutation: {
      onSuccess: () => { toast({ title: 'Member removed from organization' }); invalidate(); },
      onError: () => toast({ title: 'Failed to remove member', variant: 'destructive' }),
    }
  });

  const { mutate: updateRole } = useUpdateMemberRole({
    mutation: {
      onSuccess: () => { toast({ title: 'Role updated' }); invalidate(); },
      onError: () => toast({ title: 'Failed to update role', variant: 'destructive' }),
    }
  });

  const { mutate: updateMemberNotifPrefs, isPending: notifSaving } = useUpdateMemberNotifPrefs({
    mutation: {
      onSuccess: (_data, vars) => {
        // The mutation always carries exactly one toggleable field (the
        // dialog only flips one at a time). Surface a contextual toast that
        // names the channel + direction so the admin sees what they changed.
        const data = vars.data as Record<string, unknown>;
        const changedField = (Object.keys(NOTIF_FIELD_META) as NotifPrefField[])
          .find(k => typeof data[k] === 'boolean');
        const turnedOn = changedField ? data[changedField] === true : false;
        const meta = changedField ? NOTIF_FIELD_META[changedField] : null;
        toast({
          title: meta
            ? (turnedOn
                ? `${meta.label} re-enabled for this member`
                : `${meta.label} muted for this member`)
            : 'Notification preferences updated',
        });
        setNotifDialog(null);
        setNotifReason('');
        invalidate();
        // Keep the "Recently changed prefs" panel in sync — the toggle
        // we just sent bumps `user_notification_prefs.updated_at`, so the
        // counts/userIds for the affected row would otherwise be stale
        // until the next page load.
        fetchRecentChanges();
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : 'Failed to update preference';
        toast({ title: msg, variant: 'destructive' });
      },
    }
  });

  const submitNotifToggle = useCallback(() => {
    if (!notifDialog) return;
    updateMemberNotifPrefs({
      orgId,
      userId: notifDialog.userId,
      data: {
        [notifDialog.field]: notifDialog.nextValue,
        ...(notifReason.trim() ? { reason: notifReason.trim() } : {}),
      },
    });
  }, [notifDialog, notifReason, orgId, updateMemberNotifPrefs]);

  const filtered = (members ?? []).filter(m => {
    if (roleFilter !== 'all' && m.role !== roleFilter) return false;
    if (prefFilter && !prefFilter.userIds.has(m.userId)) return false;
    if (search) {
      const q = search.toLowerCase();
      return (m.displayName ?? '').toLowerCase().includes(q) || m.username.toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q);
    }
    return true;
  });

  const roleCounts = (members ?? []).reduce<Record<string, number>>((acc, m) => {
    acc[m.role] = (acc[m.role] ?? 0) + 1;
    return acc;
  }, {});

  const [exportingPrefs, setExportingPrefs] = useState(false);
  const onExportNotifPrefs = useCallback(async () => {
    if (!orgId) return;
    setExportingPrefs(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/notification-prefs.csv`, {
        credentials: 'include',
      });
      if (!res.ok) {
        toast({ title: 'Export failed', description: `Server returned ${res.status}.`, variant: 'destructive' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `member-notification-prefs-org-${orgId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: 'Export failed', description: 'Network error while downloading CSV.', variant: 'destructive' });
    } finally {
      setExportingPrefs(false);
    }
  }, [orgId, toast]);

  // Task #1851 — org-wide download of every comm_prefs audit row, sibling
  // to the snapshot CSV button above. Compliance/treasury staff want the
  // full change history, not just the current snapshot, for offline review.
  const [exportingAudit, setExportingAudit] = useState(false);
  const onExportPrefsAudit = useCallback(async () => {
    if (!orgId) return;
    setExportingAudit(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/audit-log.csv`, {
        credentials: 'include',
      });
      if (!res.ok) {
        toast({ title: 'Export failed', description: `Server returned ${res.status}.`, variant: 'destructive' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `comm-prefs-audit-org-${orgId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: 'Export failed', description: 'Network error while downloading CSV.', variant: 'destructive' });
    } finally {
      setExportingAudit(false);
    }
  }, [orgId, toast]);

  return (
    <div className="space-y-6">
      <div className="flex justify-end gap-2 flex-wrap">
        {/* Task #1851 — admin-only org-wide download of every comm_prefs
            audit row (the change history, not the snapshot) for offline
            compliance review. */}
        {isAdmin && (
          <Button
            variant="outline"
            onClick={onExportPrefsAudit}
            disabled={exportingAudit || !orgId}
            data-testid="export-prefs-audit"
            className="border-white/10 bg-black/40 text-white hover:bg-white/5"
            title="Download a CSV of every notification preference change recorded in this organization"
          >
            {exportingAudit ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
            Download all preference changes
          </Button>
        )}
        <Button
          variant="outline"
          onClick={onExportNotifPrefs}
          disabled={exportingPrefs || !orgId}
          className="border-white/10 bg-black/40 text-white hover:bg-white/5"
          title="Download a CSV of every member's notification channel and category preferences"
        >
          {exportingPrefs ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
          Export Notification Prefs (CSV)
        </Button>
        <Button onClick={() => setInviteOpen(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_15px_rgba(34,197,94,0.2)]">
          <UserPlus className="w-4 h-4 mr-2" /> Add Member
        </Button>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Members', value: members?.length ?? 0, color: 'text-white' },
          { label: 'Players', value: roleCounts['player'] ?? 0, color: 'text-primary' },
          { label: 'Admins / Directors', value: (roleCounts['org_admin'] ?? 0) + (roleCounts['tournament_director'] ?? 0), color: 'text-emerald-400' },
          { label: 'Other Roles', value: (roleCounts['pro_shop'] ?? 0) + (roleCounts['spectator'] ?? 0), color: 'text-orange-400' },
        ].map((s, i) => (
          <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card className="glass-card p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{s.label}</p>
              <p className={`text-2xl font-display font-bold ${s.color}`}>{s.value}</p>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Recently changed prefs (admin only) — Task #1490 */}
      {isAdmin && (
        <Card data-testid="recent-prefs-panel" className="glass-panel border-white/5 p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <p className="text-sm font-semibold text-white flex items-center gap-2">
                <BellOff className="w-4 h-4 text-amber-400" />
                Recently changed prefs
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Members opted-out by channel/category in the last {recentChanges?.windowDays ?? 30} days
                {recentChanges ? <> · {recentChanges.totalUsersChanged} member{recentChanges.totalUsersChanged === 1 ? '' : 's'} changed prefs</> : null}
              </p>
            </div>
            {prefFilter && (
              <Badge
                data-testid="recent-prefs-active-filter"
                className="bg-amber-500/15 text-amber-400 border border-amber-500/30 text-xs gap-1.5 cursor-pointer hover:bg-amber-500/25"
                onClick={() => setPrefFilter(null)}
              >
                <Filter className="w-3 h-3" /> {prefFilter.label}
                <X className="w-3 h-3 ml-0.5" />
              </Badge>
            )}
          </div>
          {loadingRecentChanges && !recentChanges ? (
            <p className="text-xs text-muted-foreground italic">Loading recent activity…</p>
          ) : recentChangesError && !recentChanges ? (
            <div className="flex items-center justify-between gap-2" data-testid="recent-prefs-error">
              <p className="text-xs text-amber-400 italic">
                Couldn’t load recent activity. The counts below may be missing or stale.
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={fetchRecentChanges}
                className="h-6 px-2 text-xs hover:bg-white/5 text-amber-400 gap-1"
              >
                <RefreshCw className="w-3 h-3" /> Retry
              </Button>
            </div>
          ) : !recentChanges || recentChanges.rows.every(r => r.optedOutCount === 0) ? (
            <p className="text-xs text-muted-foreground italic" data-testid="recent-prefs-empty">
              No notification opt-outs recorded in the last {recentChanges?.windowDays ?? 30} days.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {recentChanges.rows
                .filter(r => r.optedOutCount > 0)
                .map(r => {
                  const active = prefFilter?.key === r.key;
                  // Task #1833 — week-over-week delta. Treasurers want to
                  // catch a *sudden* spike (e.g. 100 vs 5 the week before)
                  // much faster than scanning the raw 30-day count, so we
                  // surface a ▲/▼ indicator + percentage and visually
                  // highlight rows whose current week is more than 50%
                  // higher than the prior week.
                  const cur = r.currentWeekOptedOutCount;
                  const prev = r.priorWeekOptedOutCount;
                  // When the prior week is zero we cannot compute a finite
                  // percentage. Treat any non-zero current count as a
                  // "new" spike so it still gets highlighted; otherwise
                  // suppress the indicator entirely.
                  let deltaPct: number | null;
                  let deltaDirection: 'up' | 'down' | 'flat' | 'new';
                  if (prev === 0 && cur === 0) {
                    deltaPct = null;
                    deltaDirection = 'flat';
                  } else if (prev === 0) {
                    deltaPct = null;
                    deltaDirection = 'new';
                  } else {
                    deltaPct = Math.round(((cur - prev) / prev) * 100);
                    if (cur > prev) deltaDirection = 'up';
                    else if (cur < prev) deltaDirection = 'down';
                    else deltaDirection = 'flat';
                  }
                  // >50% week-over-week increase OR a brand-new spike
                  // (prior = 0, current > 0) is the threshold the task
                  // calls out for amber/red highlighting.
                  const isSpike =
                    deltaDirection === 'new' ||
                    (deltaDirection === 'up' && (deltaPct ?? 0) > 50);
                  const baseClasses = active
                    ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                    : isSpike
                      ? 'bg-red-500/10 border-red-500/40 text-white hover:bg-red-500/15'
                      : 'bg-black/30 border-white/5 text-white hover:bg-white/5 hover:border-white/15';
                  return (
                    <button
                      key={r.key}
                      type="button"
                      data-testid={`recent-prefs-row-${r.key}`}
                      data-spike={isSpike ? 'true' : 'false'}
                      data-delta-direction={deltaDirection}
                      onClick={() => {
                        if (active) {
                          setPrefFilter(null);
                        } else {
                          setPrefFilter({ key: r.key, label: r.label, userIds: new Set(r.userIds) });
                        }
                      }}
                      className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-left transition-colors ${baseClasses}`}
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">{r.label}</p>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {r.group === 'channel' ? 'Channel' : 'Category'}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {deltaDirection !== 'flat' && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                data-testid={`recent-prefs-delta-${r.key}`}
                                className={`inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded ${
                                  isSpike
                                    ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                                    : deltaDirection === 'up'
                                      ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                                      : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                }`}
                              >
                                {deltaDirection === 'down' ? (
                                  <TrendingDown className="w-3 h-3" />
                                ) : (
                                  <TrendingUp className="w-3 h-3" />
                                )}
                                {deltaDirection === 'new'
                                  ? 'NEW'
                                  : `${deltaPct! > 0 ? '+' : ''}${deltaPct}%`}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                              {deltaDirection === 'new'
                                ? `${cur} opt-out${cur === 1 ? '' : 's'} this week, none in the prior week`
                                : `${cur} opt-out${cur === 1 ? '' : 's'} this week vs ${prev} the week before`}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <span
                          className={`text-sm font-bold tabular-nums px-2 py-0.5 rounded ${
                            active ? 'bg-amber-500/30 text-amber-100' : 'bg-white/5 text-amber-400'
                          }`}
                        >
                          {r.optedOutCount}
                        </span>
                      </div>
                    </button>
                  );
                })}
            </div>
          )}
        </Card>
      )}

      {/* Last digest sent (admin only) — Task #1831 */}
      {isAdmin && (
        <Card data-testid="last-digest-panel" className="glass-panel border-white/5 p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <p className="text-sm font-semibold text-white flex items-center gap-2">
                <MailCheck className="w-4 h-4 text-emerald-400" />
                Last member-prefs digest sent
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Most recent monthly digest sent to controllers, with recipient list and counts.
              </p>
            </div>
            {lastDigestError && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => refetchLastDigest()}
                className="h-6 px-2 text-xs hover:bg-white/5 text-amber-400 gap-1"
                data-testid="last-digest-retry"
              >
                <RefreshCw className="w-3 h-3" /> Retry
              </Button>
            )}
          </div>
          {loadingLastDigest && !lastDigestData ? (
            <p className="text-xs text-muted-foreground italic">Loading last digest…</p>
          ) : lastDigestError && !lastDigestData ? (
            <p className="text-xs text-amber-400 italic" data-testid="last-digest-error">
              Couldn’t load the last digest. Try again in a moment.
            </p>
          ) : !lastDigest ? (
            <p className="text-xs text-muted-foreground italic" data-testid="last-digest-empty">
              No member-prefs digest has been sent yet for this organization.
            </p>
          ) : (
            <div className="space-y-3" data-testid="last-digest-content">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded-lg border border-white/5 bg-black/30 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sent</p>
                  <p className="text-sm font-medium text-white tabular-nums" data-testid="last-digest-sent-at">
                    {new Date(lastDigest.sentAt).toLocaleString()}
                  </p>
                  {lastDigest.period ? (
                    <p className="text-[10px] text-muted-foreground mt-0.5">Period {lastDigest.period}</p>
                  ) : null}
                </div>
                <div className="rounded-lg border border-white/5 bg-black/30 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">CSV rows</p>
                  <p className="text-sm font-bold text-white tabular-nums" data-testid="last-digest-row-count">
                    {lastDigest.memberRows}
                  </p>
                </div>
                <div className="rounded-lg border border-white/5 bg-black/30 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Delivered</p>
                  <p className="text-sm font-bold text-emerald-400 tabular-nums" data-testid="last-digest-delivered">
                    {lastDigest.recipientsEmailed}
                  </p>
                </div>
                <div className="rounded-lg border border-white/5 bg-black/30 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Suppressed</p>
                  <p className="text-sm font-bold text-amber-400 tabular-nums" data-testid="last-digest-suppressed">
                    {lastDigest.recipientsSuppressed}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                  Recipients ({lastDigest.recipients.length})
                </p>
                {lastDigest.recipients.length === 0 ? (
                  <p
                    className="text-xs text-muted-foreground italic"
                    data-testid="last-digest-recipients-empty"
                  >
                    No recipients recorded — the digest may have only logged suppressed opt-outs.
                  </p>
                ) : (
                  <ul
                    className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto"
                    data-testid="last-digest-recipients-list"
                  >
                    {lastDigest.recipients.map(r => (
                      <li
                        key={r.userId}
                        data-testid={`last-digest-recipient-${r.userId}`}
                        className="text-[11px] px-2 py-1 rounded border border-white/10 bg-black/30 text-white"
                      >
                        <span className="font-mono">{r.email}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center glass-panel p-3 rounded-2xl">
        <div className="flex gap-1.5 p-1 bg-black/40 rounded-xl w-full sm:w-auto overflow-x-auto flex-shrink-0">
          {['all', 'player', 'org_admin', 'tournament_director', 'pro_shop'].map(r => (
            <button
              key={r}
              onClick={() => setRoleFilter(r)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                roleFilter === r ? 'bg-white/10 text-white shadow-sm' : 'text-muted-foreground hover:text-white hover:bg-white/5'
              }`}
            >
              {r === 'all' ? 'All' : ROLE_CONFIG[r]?.label ?? r}
              {r !== 'all' && roleCounts[r] ? <span className="ml-1 text-muted-foreground">({roleCounts[r]})</span> : null}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 bg-black/40 border-white/5 text-white rounded-xl h-9"
          />
        </div>
      </div>

      {/* Table */}
      <Card className="glass-panel border-none overflow-hidden">
        {isLoading ? (
          <div className="p-12 flex justify-center">
            <div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Users className="w-12 h-12 text-muted-foreground opacity-30 mx-auto mb-3" />
            <p className="text-muted-foreground">
              {search || roleFilter !== 'all' ? 'No members match your search.' : 'No members yet. Add your first member.'}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-black/40">
              <TableRow className="border-white/5">
                <TableHead className="text-muted-foreground font-semibold">Member</TableHead>
                <TableHead className="text-muted-foreground font-semibold">Username</TableHead>
                <TableHead className="text-muted-foreground font-semibold">Email</TableHead>
                <TableHead className="text-muted-foreground font-semibold">Role</TableHead>
                <TableHead className="text-muted-foreground font-semibold">Channels</TableHead>
                <TableHead className="text-muted-foreground font-semibold">Joined</TableHead>
                <TableHead className="text-muted-foreground font-semibold text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(m => {
                const rc = ROLE_CONFIG[m.role] ?? { label: m.role, className: 'bg-gray-500/20 text-gray-400 border-gray-500/30' };
                const isExpanded = expandedUserId === m.userId;
                const linked = playerRecords[m.userId] ?? [];
                const notifPrefs = (m as typeof m & { notifPrefs?: NotifPrefs | null }).notifPrefs;
                return (
                  <>
                    <TableRow key={m.id} className="border-white/5 hover:bg-white/[0.02]">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <button onClick={() => toggleExpanded(m.userId)} className="w-5 h-5 flex-shrink-0 text-muted-foreground hover:text-primary focus:outline-none transition-transform" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none' }}>
                            <ChevronRight className="w-4 h-4" />
                          </button>
                          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-primary/60 to-emerald-600/60 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                            {(m.displayName || m.username)[0].toUpperCase()}
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-white">{m.displayName || m.username}</span>
                            {m.isLocalAuth && (
                              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${m.emailVerified ? 'text-primary' : 'text-yellow-500'}`}>
                                <Link2 className="w-2.5 h-2.5" />
                                {m.emailVerified ? 'Portal Account' : 'Portal (Unverified)'}
                              </span>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-sm">{m.username}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">{m.email ?? '—'}</TableCell>
                      <TableCell>
                        <Select
                          value={m.role}
                          onValueChange={(newRole) => updateRole({ orgId, userId: m.userId, data: { role: newRole as UpdateRoleInputRole } })}
                        >
                          <SelectTrigger className="h-7 px-2 text-xs bg-transparent border-transparent hover:bg-white/5 w-auto gap-1">
                            <Badge className={`${rc.className} text-xs border pointer-events-none`}>{rc.label}</Badge>
                            <ChevronDown className="w-3 h-3 text-muted-foreground" />
                          </SelectTrigger>
                          <SelectContent className="bg-card border-white/10 text-white">
                            {ROLE_OPTIONS.map(opt => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {notifPrefs ? (
                          <div className="flex items-center gap-1 flex-wrap">
                            <ChannelBadge
                              channel="preferEmail"
                              shortLabel="Email"
                              enabled={notifPrefs.preferEmail}
                              enabledClass="bg-emerald-500/15 text-emerald-400 border-emerald-500/25"
                              isAdmin={isAdmin}
                              onToggle={(nextValue) => {
                                setNotifReason('');
                                setNotifDialog({
                                  userId: m.userId,
                                  memberLabel: m.displayName || m.username,
                                  field: 'preferEmail',
                                  nextValue,
                                });
                              }}
                            />
                            <ChannelBadge
                              channel="preferPush"
                              shortLabel="Push"
                              enabled={notifPrefs.preferPush}
                              enabledClass="bg-primary/15 text-primary border-primary/25"
                              isAdmin={isAdmin}
                              onToggle={(nextValue) => {
                                setNotifReason('');
                                setNotifDialog({
                                  userId: m.userId,
                                  memberLabel: m.displayName || m.username,
                                  field: 'preferPush',
                                  nextValue,
                                });
                              }}
                            />
                            <ChannelBadge
                              channel="preferSms"
                              shortLabel="SMS"
                              enabled={notifPrefs.preferSms}
                              enabledClass="bg-green-500/15 text-green-400 border-green-500/25"
                              isAdmin={isAdmin}
                              onToggle={(nextValue) => {
                                setNotifReason('');
                                setNotifDialog({
                                  userId: m.userId,
                                  memberLabel: m.displayName || m.username,
                                  field: 'preferSms',
                                  nextValue,
                                });
                              }}
                            />
                            <ChannelBadge
                              channel="preferWhatsapp"
                              shortLabel="WA"
                              enabled={notifPrefs.preferWhatsapp}
                              enabledClass="bg-emerald-500/15 text-emerald-400 border-emerald-500/25"
                              isAdmin={isAdmin}
                              onToggle={(nextValue) => {
                                setNotifReason('');
                                setNotifDialog({
                                  userId: m.userId,
                                  memberLabel: m.displayName || m.username,
                                  field: 'preferWhatsapp',
                                  nextValue,
                                });
                              }}
                            />

                            {!notifPrefs.notifySideGameReceipts ? (
                              isAdmin ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      data-testid={`notif-side-game-receipts-opt-out-${m.userId}`}
                                      onClick={() => {
                                        setNotifReason('');
                                        setNotifDialog({
                                          userId: m.userId,
                                          memberLabel: m.displayName || m.username,
                                          field: 'notifySideGameReceipts',
                                          nextValue: true,
                                        });
                                      }}
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/25 hover:bg-amber-500/25 cursor-pointer"
                                    >
                                      No side-game receipts
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent className="text-xs">Click to re-enable side-game receipt emails for this member</TooltipContent>
                                </Tooltip>
                              ) : (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span
                                      data-testid={`notif-side-game-receipts-opt-out-${m.userId}`}
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/25 cursor-default"
                                    >
                                      No side-game receipts
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent className="text-xs">Member opted out of side-game receipt emails</TooltipContent>
                                </Tooltip>
                              )
                            ) : isAdmin ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    data-testid={`notif-side-game-receipts-toggle-${m.userId}`}
                                    onClick={() => {
                                      setNotifReason('');
                                      setNotifDialog({
                                        userId: m.userId,
                                        memberLabel: m.displayName || m.username,
                                        field: 'notifySideGameReceipts',
                                        nextValue: false,
                                      });
                                    }}
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground border border-white/10 hover:bg-white/10 hover:text-amber-400 cursor-pointer"
                                  >
                                    Mute side-game
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent className="text-xs">Opt this member out of side-game receipt emails on their behalf</TooltipContent>
                              </Tooltip>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {m.isLocalAuth && m.email && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={syncingUserId === m.userId}
                                  onClick={() => syncPlayerRecords(m.userId)}
                                  className="h-7 w-7 p-0 text-muted-foreground hover:text-primary hover:bg-primary/10"
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${syncingUserId === m.userId ? 'animate-spin' : ''}`} />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="text-xs">
                                Sync player records by email
                              </TooltipContent>
                            </Tooltip>
                          )}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => openLinkDialog(m.userId, m.displayName || m.username)}
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-emerald-400 hover:bg-emerald-400/10"
                              >
                                <Link2 className="w-3.5 h-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="text-xs">
                              Manually link a player record
                            </TooltipContent>
                          </Tooltip>
                          {m.userId !== currentUserId ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => removeOrgMember({ orgId, userId: m.userId })}
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground flex items-center justify-end gap-1">
                              <ShieldCheck className="w-3.5 h-3.5 text-primary" /> You
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow key={`${m.id}-records`} className="border-white/5 bg-black/20">
                        <TableCell colSpan={7} className="py-3 px-6">
                          <div className="pl-9">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                              <Link2 className="w-3 h-3" /> Linked Player Records
                            </p>
                            {loadingRecordsFor === m.userId && (
                              <p className="text-xs text-muted-foreground">Loading...</p>
                            )}
                            {!loadingRecordsFor && linked.length === 0 && (
                              <p className="text-xs text-muted-foreground italic">No linked player records. Use Sync to link by email.</p>
                            )}
                            {linked.map(r => (
                              <div key={r.playerId} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
                                <div>
                                  <span className="text-sm text-white font-medium">{r.firstName} {r.lastName}</span>
                                  <span className="text-xs text-muted-foreground ml-2">Tournament #{r.tournamentId}</span>
                                  {r.email && <span className="text-xs text-muted-foreground ml-2">· {r.email}</span>}
                                </div>
                                <div className="flex items-center gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      setFlagPlayerId(r.playerId);
                                      setFlagPlayerName(`${r.firstName} ${r.lastName}`);
                                      setFlagDiff('');
                                      setFlagNotes('');
                                      setFlagDialogUserId(m.userId);
                                    }}
                                    className="h-6 px-2 text-xs text-muted-foreground hover:text-yellow-400 hover:bg-yellow-400/10 gap-1"
                                  >
                                    <Flag className="w-3 h-3" /> Flag
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={unlinkingPlayerId === r.playerId}
                                    onClick={() => unlinkPlayerRecord(m.userId, r.playerId)}
                                    className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1"
                                  >
                                    <Unlink className="w-3 h-3" /> Unlink
                                  </Button>
                                </div>
                              </div>
                            ))}

                            {/* ── Committee Adjustment Audit Trail ── */}
                            <div className="mt-4">
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                <TrendingUp className="w-3 h-3" /> Handicap Committee Adjustments
                              </p>
                              {loadingAdjsFor === m.userId && (
                                <p className="text-xs text-muted-foreground">Loading...</p>
                              )}
                              {!loadingAdjsFor && (committeeAdjs[m.userId] ?? []).length === 0 && (
                                <p className="text-xs text-muted-foreground italic">No committee adjustments on record.</p>
                              )}
                              {(committeeAdjs[m.userId] ?? []).map(adj => {
                                const delta = adj.adjustmentStrokes;
                                const deltaStr = delta != null
                                  ? (delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1))
                                  : null;
                                return (
                                  <div key={adj.id} className="flex items-start justify-between py-1.5 border-b border-white/5 last:border-0 gap-2">
                                    <div className="flex items-start gap-2">
                                      <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                                      <div>
                                        <span className="text-xs text-white font-medium">{adj.adjustmentReason}</span>
                                        {adj.committeeNotes && <span className="text-xs text-muted-foreground ml-1">— {adj.committeeNotes}</span>}
                                        <div className="text-[10px] text-muted-foreground mt-0.5">
                                          {adj.firstName} {adj.lastName}
                                          {adj.adjusterName && <> · by {adj.adjusterName}</>}
                                          {adj.tournamentName && <> · {adj.tournamentName}</>}
                                          {' · '}{new Date(adj.adjustedAt).toLocaleDateString()}
                                        </div>
                                      </div>
                                    </div>
                                    <div className="text-right flex-shrink-0">
                                      {deltaStr && (
                                        <span className="text-xs font-bold text-amber-400">{deltaStr}</span>
                                      )}
                                      <div className="text-[10px] text-muted-foreground">
                                        {adj.previousHandicapIndex != null ? adj.previousHandicapIndex.toFixed(1) : '—'} → {adj.newHandicapIndex.toFixed(1)}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            {/* ── Notification Preference History (Task #1505) ── */}
                            {isAdmin && (
                              <NotifPrefsAuditTimeline orgId={orgId} userId={m.userId} />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <InviteMemberDialog open={inviteOpen} onClose={() => setInviteOpen(false)} orgId={orgId} onSuccess={invalidate} />

      {/* Link Player Record Dialog */}
      <Dialog open={linkDialogOpen} onOpenChange={v => !v && setLinkDialogOpen(false)}>
        <DialogContent className="glass-panel border-white/10 sm:max-w-[540px]">
          <DialogHeader>
            <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
              <Link2 className="w-5 h-5 text-emerald-400" /> Link Player Record
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              Linking a record to <span className="text-white font-medium">{linkTargetUserName}</span>
            </p>
          </DialogHeader>
          <div className="space-y-3 mt-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search unlinked records..."
                value={linkSearch}
                onChange={e => setLinkSearch(e.target.value)}
                className="pl-9 bg-black/40 border-white/5 text-white"
              />
            </div>
            {loadingUnlinked ? (
              <div className="py-8 flex justify-center">
                <div className="w-6 h-6 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
                {unlinkedRecords
                  .filter(r => {
                    if (!linkSearch) return true;
                    const q = linkSearch.toLowerCase();
                    return (
                      `${r.firstName} ${r.lastName}`.toLowerCase().includes(q) ||
                      (r.email ?? '').toLowerCase().includes(q) ||
                      r.tournamentName.toLowerCase().includes(q)
                    );
                  })
                  .map(r => (
                    <div key={r.playerId} className="flex items-center justify-between p-3 rounded-lg bg-black/30 border border-white/5 hover:border-emerald-400/30 hover:bg-emerald-400/5 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white">{r.firstName} {r.lastName}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {r.tournamentName}
                          {r.email ? <span className="ml-2">· {r.email}</span> : null}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        disabled={linkingPlayerId === r.playerId}
                        onClick={() => linkPlayerRecord(r.playerId)}
                        className="ml-3 h-7 px-3 text-xs bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 gap-1"
                        variant="ghost"
                      >
                        {linkingPlayerId === r.playerId ? (
                          <div className="w-3 h-3 rounded-full border border-emerald-400 border-t-transparent animate-spin" />
                        ) : (
                          <Link2 className="w-3 h-3" />
                        )}
                        Link
                      </Button>
                    </div>
                  ))}
                {!loadingUnlinked && unlinkedRecords.filter(r => {
                  if (!linkSearch) return true;
                  const q = linkSearch.toLowerCase();
                  return `${r.firstName} ${r.lastName}`.toLowerCase().includes(q) || (r.email ?? '').toLowerCase().includes(q) || r.tournamentName.toLowerCase().includes(q);
                }).length === 0 && (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    {linkSearch ? 'No records match your search.' : 'No unlinked player records found in this organization.'}
                  </div>
                )}
              </div>
            )}
            <div className="flex justify-end pt-1">
              <Button variant="ghost" onClick={() => setLinkDialogOpen(false)} className="hover:bg-white/5 text-white">
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Flag Score from Player Record Dialog */}
      <Dialog open={!!flagDialogUserId} onOpenChange={v => !v && setFlagDialogUserId(null)}>
        <DialogContent className="glass-panel border-white/10 sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
              <Flag className="w-5 h-5 text-yellow-400" /> Flag for ESR Review
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              Flagging <span className="text-white font-medium">{flagPlayerName}</span> for Exceptional Score Review
            </p>
          </DialogHeader>
          <div className="space-y-3 mt-1">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Score Differential *</label>
              <Input
                type="number"
                step="0.1"
                placeholder="e.g. 7.5"
                value={flagDiff}
                onChange={e => setFlagDiff(e.target.value)}
                className="bg-black/40 border-white/10 text-white"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Enter the score differential that triggered this review</p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Notes (optional)</label>
              <Input
                placeholder="Context or reason for flagging..."
                value={flagNotes}
                onChange={e => setFlagNotes(e.target.value)}
                className="bg-black/40 border-white/10 text-white"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setFlagDialogUserId(null)} className="hover:bg-white/5 text-white">Cancel</Button>
              <Button
                disabled={!flagDiff || flagSubmitting}
                onClick={submitFlagFromPlayer}
                className="bg-yellow-500 hover:bg-yellow-400 text-black font-semibold gap-1"
              >
                {flagSubmitting ? 'Submitting…' : <><Flag className="w-3 h-3" /> Submit Flag</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Admin override — toggle one of a member's notification preferences
          (side-game receipts or any of the channel toggles). */}
      <Dialog open={!!notifDialog} onOpenChange={v => { if (!v && !notifSaving) { setNotifDialog(null); setNotifReason(''); } }}>
        <DialogContent className="glass-panel border-white/10 sm:max-w-[440px]">
          {(() => {
            // The dialog only opens via setNotifDialog(...), so `field` is
            // always populated when DialogContent is shown. Pulling the meta
            // out into a local keeps the JSX below readable.
            const meta = notifDialog ? NOTIF_FIELD_META[notifDialog.field] : null;
            const labelLower = meta ? meta.label.toLowerCase() : '';
            const isSideGame = notifDialog?.field === 'notifySideGameReceipts';
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
                    <Mail className="w-5 h-5 text-amber-400" />
                    {notifDialog?.nextValue
                      ? `Re-enable ${labelLower}`
                      : `Mute ${labelLower}`}
                  </DialogTitle>
                  <p className="text-sm text-muted-foreground">
                    {notifDialog?.nextValue ? (
                      <>You're turning {meta?.channelNoun ?? 'this preference'} back <span className="text-emerald-400 font-medium">ON</span> for <span className="text-white font-medium">{notifDialog?.memberLabel}</span>.</>
                    ) : (
                      <>You're opting <span className="text-white font-medium">{notifDialog?.memberLabel}</span> out of {meta?.channelNoun ?? 'this preference'} on their behalf.</>
                    )}
                  </p>
                </DialogHeader>
                <div className="space-y-3 mt-1">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Reason (optional, recorded in audit log)</label>
                    <Input
                      placeholder="e.g. Member requested by phone on 24 Apr"
                      value={notifReason}
                      onChange={e => setNotifReason(e.target.value)}
                      disabled={notifSaving}
                      data-testid="notif-toggle-reason"
                      className="bg-black/40 border-white/10 text-white"
                    />
                    {isSideGame && (
                      <p className="text-[10px] text-muted-foreground mt-1">
                        In-app inbox + push notifications are not affected — only the receipt email channel.
                      </p>
                    )}
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button
                      variant="ghost"
                      disabled={notifSaving}
                      onClick={() => { setNotifDialog(null); setNotifReason(''); }}
                      className="hover:bg-white/5 text-white"
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={notifSaving}
                      onClick={submitNotifToggle}
                      data-testid="notif-toggle-submit"
                      className={notifDialog?.nextValue
                        ? 'bg-emerald-500 hover:bg-emerald-400 text-black font-semibold'
                        : 'bg-amber-500 hover:bg-amber-400 text-black font-semibold'}
                    >
                      {notifSaving
                        ? 'Saving…'
                        : (notifDialog?.nextValue ? 'Re-enable' : 'Mute')}
                    </Button>
                  </div>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   NOTIFICATION PREFERENCE HISTORY  (Task #1505)
   ─────────────────────────────────────────────────────────────────
   Per-member chronological view of `member_audit_log` rows where
   `entity = 'comm_prefs'`. Rendered inline in the Members table's
   expanded row so admins can self-audit "who muted this member's
   side-game receipts and when?" without leaving the Players page.
════════════════════════════════════════════════════════════════ */

const COMM_PREFS_FIELD_LABELS: Record<string, string> = {
  notifySideGameReceipts: 'Side-game receipts',
  preferEmail: 'Email channel',
  preferPush: 'Push channel',
  preferSms: 'SMS channel',
  preferWhatsapp: 'WhatsApp channel',
  notifyMemberDocuments: 'Member documents',
  notifyCommitteePeerDigest: 'Committee peer digest',
  notifyManualEntryAlerts: 'Manual entry alerts',
  notifyCoachPayoutAccountChanges: 'Coach payout changes',
  notifyDataExportExpiring: 'Data export expiring',
  notifyErasureStorageDigest: 'Erasure storage digest (email)',
  notifyErasureStorageDigestPush: 'Erasure storage digest (push)',
  digestMode: 'Digest mode',
};

function formatPrefValue(v: unknown): string {
  if (v === true) return 'On';
  if (v === false) return 'Off';
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  return JSON.stringify(v);
}

function NotifPrefsAuditTimeline({ orgId, userId }: { orgId: number; userId: number }) {
  // Task #1852 — filter state for the date-range + actor controls. Inputs
  // are kept as raw strings (HTML datetime-local format) so the user can
  // partially type without React forcing a re-render mid-edit. We only
  // serialise to ISO when sending to the API. `actorUserId === ''` means
  // "any actor".
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  const [actorInput, setActorInput] = useState('');

  // Convert "YYYY-MM-DDTHH:mm" (datetime-local) to ISO for the API. Empty /
  // invalid inputs are dropped so we never poison the request with NaN.
  const toIso = (v: string): string | undefined => {
    if (!v) return undefined;
    const d = new Date(v);
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString();
  };

  const params: {
    entity: string;
    limit: number;
    from?: string;
    to?: string;
    actorUserId?: number;
  } = { entity: 'comm_prefs', limit: 20 };
  const fromIso = toIso(fromInput);
  const toIsoVal = toIso(toInput);
  if (fromIso) params.from = fromIso;
  if (toIsoVal) params.to = toIsoVal;
  if (actorInput) {
    const parsed = parseInt(actorInput, 10);
    if (!isNaN(parsed)) params.actorUserId = parsed;
  }

  // Fetched per-member when the row is expanded. The hook is keyed by
  // (orgId, userId, params) so changing a filter triggers a refetch and the
  // unfiltered view stays cached separately. Limit 20 matches the brief.
  const { data, isLoading, isError, refetch, isFetching } = useGetMemberAuditLog(
    orgId,
    userId,
    params,
    { query: { staleTime: 30_000 } },
  );

  const entries = data?.entries ?? [];
  const availableActors = data?.availableActors ?? [];
  const hasActiveFilters = Boolean(params.from || params.to || params.actorUserId);

  const clearFilters = () => {
    setFromInput('');
    setToInput('');
    setActorInput('');
  };

  // Task #1851 — per-member CSV download. Plain fetch (rather than the
  // generated client) so we can stream the CSV blob straight to a hidden
  // <a download> element, matching the pattern used by the org-wide
  // "Export Notification Prefs (CSV)" button at the top of the Members
  // tab.
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const onDownloadHistory = useCallback(async () => {
    setDownloading(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/members/${userId}/audit-log.csv`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        toast({ title: 'Download failed', description: `Server returned ${res.status}.`, variant: 'destructive' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `comm-prefs-audit-org-${orgId}-user-${userId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: 'Download failed', description: 'Network error while downloading CSV.', variant: 'destructive' });
    } finally {
      setDownloading(false);
    }
  }, [orgId, userId, toast]);

  return (
    <div className="mt-4" data-testid={`comm-prefs-audit-${userId}`}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <History className="w-3 h-3" /> Notification Preference History
        </p>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={downloading}
            onClick={onDownloadHistory}
            data-testid={`comm-prefs-audit-download-${userId}`}
            title="Download this member's preference change history as CSV"
            className="h-6 px-2 text-[10px] text-muted-foreground hover:text-white hover:bg-white/5 gap-1"
          >
            {downloading
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Download className="w-3 h-3" />}
            Download history
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={isFetching}
            onClick={() => refetch()}
            className="h-6 px-2 text-[10px] text-muted-foreground hover:text-white hover:bg-white/5 gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>
      {/* Task #1852 — date-range + actor filter controls. Native inputs keep
          this lightweight (no extra UI deps) and the flex-wrap layout
          collapses gracefully on narrow screens. */}
      <div
        className="mb-2 flex flex-wrap items-end gap-2 p-2 rounded border border-white/5 bg-black/10"
        data-testid={`comm-prefs-audit-filters-${userId}`}
      >
        <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wider">From</span>
          <input
            type="datetime-local"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
            data-testid={`comm-prefs-audit-from-${userId}`}
            className="h-7 px-2 text-xs rounded border border-white/10 bg-black/30 text-white"
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wider">To</span>
          <input
            type="datetime-local"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            data-testid={`comm-prefs-audit-to-${userId}`}
            className="h-7 px-2 text-xs rounded border border-white/10 bg-black/30 text-white"
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wider">Actor</span>
          <select
            value={actorInput}
            onChange={(e) => setActorInput(e.target.value)}
            data-testid={`comm-prefs-audit-actor-${userId}`}
            className="h-7 px-2 text-xs rounded border border-white/10 bg-black/30 text-white min-w-[10rem]"
          >
            <option value="">Any actor</option>
            {availableActors.map((a) => (
              <option key={a.actorUserId} value={String(a.actorUserId)}>
                {a.actorName ?? `User #${a.actorUserId}`}
              </option>
            ))}
          </select>
        </label>
        {hasActiveFilters && (
          <Button
            size="sm"
            variant="ghost"
            onClick={clearFilters}
            data-testid={`comm-prefs-audit-clear-${userId}`}
            className="h-7 px-2 text-[10px] text-muted-foreground hover:text-white hover:bg-white/5"
          >
            Clear
          </Button>
        )}
      </div>
      {isLoading ? (
        <p className="text-xs text-muted-foreground italic">Loading history…</p>
      ) : isError ? (
        <p className="text-xs text-amber-400 italic" data-testid={`comm-prefs-audit-error-${userId}`}>
          Couldn’t load preference history.
        </p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground italic" data-testid={`comm-prefs-audit-empty-${userId}`}>
          No admin overrides recorded for this member's notification preferences.
        </p>
      ) : (
        <div className="space-y-1.5">
          {entries.map((e: MemberAuditLogEntry) => {
            const changes = e.fieldChanges ?? {};
            const changeKeys = Object.keys(changes);
            const actorLabel = e.actorName ?? 'system';
            return (
              <div
                key={e.id}
                data-testid={`comm-prefs-audit-row-${e.id}`}
                className="flex items-start gap-2 py-1.5 px-2 rounded border border-white/5 bg-black/20"
              >
                <BellOff className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  {changeKeys.length > 0 ? (
                    <div className="space-y-0.5">
                      {changeKeys.map(key => {
                        const c = changes[key];
                        const label = COMM_PREFS_FIELD_LABELS[key] ?? key;
                        return (
                          <p key={key} className="text-xs text-white">
                            <span className="font-medium">{label}:</span>{' '}
                            <span className="text-muted-foreground">{formatPrefValue(c?.from)}</span>
                            {' → '}
                            <span className={c?.to === false ? 'text-amber-400' : 'text-emerald-400'}>
                              {formatPrefValue(c?.to)}
                            </span>
                          </p>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-white">
                      <span className="font-medium">{e.action}</span>
                      <span className="text-muted-foreground"> · no field-level diff recorded</span>
                    </p>
                  )}
                  {e.reason && (
                    <p className="text-[11px] text-muted-foreground italic mt-0.5">“{e.reason}”</p>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    by <span className="text-white/80">{actorLabel}</span>
                    {e.actorRole && <> · {e.actorRole.replaceAll('_', ' ')}</>}
                    {' · '}{new Date(e.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            );
          })}
          {data && entries.length === data.limit && (
            <p className="text-[10px] text-muted-foreground italic pt-1">
              Showing the most recent {data.limit} entries.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   PLAYER ACCOUNTS TAB (new — portal account management)
════════════════════════════════════════════════════════════════ */

function PlayerAccountsTab({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  // Pre-fetch followee IDs so each player row's <FollowButton> hydrates as
  // "Following" without flashing "Follow" first (Task #1227). Uses the same
  // shared hook as member-360 and club-members so the cache is reused.
  const followeeIds = useFolloweeIds();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [verifiedFilter, setVerifiedFilter] = useState<'all' | 'verified' | 'unverified'>('all');
  const [page, setPage] = useState(1);
  const [accounts, setAccounts] = useState<PortalAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [verifiedTotal, setVerifiedTotal] = useState(0);
  const [unverifiedTotal, setUnverifiedTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<PortalAccountDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  // Edit profile state
  const [editingProfile, setEditingProfile] = useState(false);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // Set password dialog
  const [pwDialogOpen, setPwDialogOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  // Action loading states
  const [sendingReset, setSendingReset] = useState(false);
  const [forcingVerify, setForcingVerify] = useState(false);
  const [removingPhoto, setRemovingPhoto] = useState(false);

  // GHIN edit state
  const [editingGhin, setEditingGhin] = useState(false);
  const [editGhin, setEditGhin] = useState('');
  const [savingGhin, setSavingGhin] = useState(false);
  const [lookingUpGhin, setLookingUpGhin] = useState(false);
  const [ghinPreview, setGhinPreview] = useState<{ firstName: string; lastName: string; handicapIndex: number | null; club?: string } | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const fetchAccounts = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '50',
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        ...(verifiedFilter !== 'all' ? { verified: verifiedFilter } : {}),
      });
      const res = await fetch(`/api/admin/players?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load accounts');
      const data = await res.json();
      setAccounts(Array.isArray(data.players) ? data.players : []);
      setTotal(data.total ?? 0);
      setVerifiedTotal(data.verifiedTotal ?? 0);
      setUnverifiedTotal(data.unverifiedTotal ?? 0);
      setPages(data.pages ?? 1);
    } catch {
      toast({ title: 'Failed to load player accounts', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [orgId, page, debouncedSearch, verifiedFilter, toast]);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  async function openDetail(account: PortalAccount) {
    setDetailOpen(true);
    setDetailLoading(true);
    setSelectedAccount(null);
    setEditingProfile(false);
    setEditingGhin(false);
    try {
      const res = await fetch(`/api/admin/players/${account.id}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load player detail');
      const data: PortalAccountDetail = await res.json();
      setSelectedAccount(data);
      setEditName(data.displayName ?? '');
      setEditEmail(data.email ?? '');
      setEditGhin(data.ghinNumber ?? '');
    } catch {
      toast({ title: 'Failed to load player detail', variant: 'destructive' });
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveGhin() {
    if (!selectedAccount) return;
    setSavingGhin(true);
    try {
      const res = await fetch(`/api/admin/players/${selectedAccount.id}/ghin`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ghinNumber: editGhin.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to update GHIN');
      toast({ title: 'GHIN number updated' });
      setSelectedAccount(prev => prev ? { ...prev, ghinNumber: data.ghinNumber } : prev);
      setEditingGhin(false);
    } catch (e: unknown) {
      toast({ title: e instanceof Error ? e.message : 'Failed to update GHIN', variant: 'destructive' });
    } finally {
      setSavingGhin(false);
    }
  }

  async function lookupGhinPlayer() {
    if (!editGhin.trim()) { toast({ title: 'Enter a GHIN number first', variant: 'destructive' }); return; }
    setLookingUpGhin(true);
    setGhinPreview(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/courses/ghin/player/${editGhin.trim()}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: res.status === 404 ? 'GHIN number not found' : data.error ?? 'Lookup failed', variant: 'destructive' });
        return;
      }
      setGhinPreview({
        firstName: data.firstName ?? '',
        lastName: data.lastName ?? '',
        handicapIndex: data.handicapIndex ?? null,
        club: data.club ?? data.clubName ?? undefined,
      });
    } catch {
      toast({ title: 'GHIN lookup failed', variant: 'destructive' });
    } finally {
      setLookingUpGhin(false);
    }
  }

  async function saveProfile() {
    if (!selectedAccount) return;
    setSavingProfile(true);
    try {
      const res = await fetch(`/api/admin/players/${selectedAccount.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: editName, email: editEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Update failed');
      toast({ title: 'Profile updated successfully' });
      setSelectedAccount(prev => prev ? { ...prev, ...data } : prev);
      setAccounts(prev => prev.map(a => a.id === selectedAccount.id ? { ...a, ...data } : a));
      setEditingProfile(false);
    } catch (e: unknown) {
      toast({ title: e instanceof Error ? e.message : 'Update failed', variant: 'destructive' });
    } finally {
      setSavingProfile(false);
    }
  }

  async function sendPasswordReset() {
    if (!selectedAccount) return;
    setSendingReset(true);
    try {
      const res = await fetch(`/api/admin/players/${selectedAccount.id}/send-password-reset`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to send reset');
      toast({ title: 'Password reset email sent', description: data.message });
    } catch (e: unknown) {
      toast({ title: e instanceof Error ? e.message : 'Failed to send reset', variant: 'destructive' });
    } finally {
      setSendingReset(false);
    }
  }

  async function forceVerify() {
    if (!selectedAccount) return;
    setForcingVerify(true);
    try {
      const res = await fetch(`/api/admin/players/${selectedAccount.id}/force-verify`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to verify');
      toast({ title: 'Email marked as verified' });
      setSelectedAccount(prev => prev ? { ...prev, emailVerified: true } : prev);
      setAccounts(prev => prev.map(a => a.id === selectedAccount.id ? { ...a, emailVerified: true } : a));
    } catch (e: unknown) {
      toast({ title: e instanceof Error ? e.message : 'Failed to verify', variant: 'destructive' });
    } finally {
      setForcingVerify(false);
    }
  }

  async function adminRemovePhoto() {
    if (!selectedAccount) return;
    setRemovingPhoto(true);
    try {
      const res = await fetch(`/api/admin/players/${selectedAccount.id}/avatar`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to remove photo');
      toast({ title: 'Profile photo removed' });
      setSelectedAccount(prev => prev ? { ...prev, profileImage: null } : prev);
      setAccounts(prev => prev.map(a => a.id === selectedAccount.id ? { ...a, profileImage: null } : a));
    } catch (e: unknown) {
      toast({ title: e instanceof Error ? e.message : 'Failed to remove photo', variant: 'destructive' });
    } finally {
      setRemovingPhoto(false);
    }
  }

  async function setPassword() {
    if (!selectedAccount || !newPassword) return;
    if (newPassword.length < 8) {
      toast({ title: 'Password must be at least 8 characters', variant: 'destructive' });
      return;
    }
    setSavingPassword(true);
    try {
      const res = await fetch(`/api/admin/players/${selectedAccount.id}/set-password`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to set password');
      toast({ title: 'Password updated successfully' });
      setPwDialogOpen(false);
      setNewPassword('');
      setShowPassword(false);
    } catch (e: unknown) {
      toast({ title: e instanceof Error ? e.message : 'Failed to set password', variant: 'destructive' });
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Stats strip — totals are full-dataset counts from the server */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Player Accounts', value: verifiedTotal + unverifiedTotal, color: 'text-white' },
          { label: 'Verified', value: verifiedTotal, color: 'text-primary' },
          { label: 'Unverified', value: unverifiedTotal, color: 'text-yellow-400' },
        ].map((s, i) => (
          <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card className="glass-card p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{s.label}</p>
              <p className={`text-2xl font-display font-bold ${s.color}`}>{s.value}</p>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center glass-panel p-3 rounded-2xl">
        <div className="flex gap-1.5 p-1 bg-black/40 rounded-xl flex-shrink-0">
          {(['all', 'verified', 'unverified'] as const).map(f => (
            <button
              key={f}
              onClick={() => { setVerifiedFilter(f); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all capitalize ${
                verifiedFilter === f ? 'bg-white/10 text-white shadow-sm' : 'text-muted-foreground hover:text-white hover:bg-white/5'
              }`}
            >
              {f === 'all' ? 'All Accounts' : f === 'verified' ? '✓ Verified' : '⚠ Unverified'}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 bg-black/40 border-white/5 text-white rounded-xl h-9"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <Card className="glass-panel border-none overflow-hidden">
        {loading ? (
          <div className="p-12 flex justify-center">
            <div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-16">
            <ShieldAlert className="w-12 h-12 text-muted-foreground opacity-30 mx-auto mb-3" />
            <p className="text-muted-foreground">
              {search || verifiedFilter !== 'all' ? 'No accounts match your search.' : 'No player accounts found. Accounts appear here once a member joins your organization.'}
            </p>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader className="bg-black/40">
                <TableRow className="border-white/5">
                  <TableHead className="text-muted-foreground font-semibold">Player</TableHead>
                  <TableHead className="text-muted-foreground font-semibold">Email</TableHead>
                  <TableHead className="text-muted-foreground font-semibold">Status</TableHead>
                  <TableHead className="text-muted-foreground font-semibold">Role</TableHead>
                  <TableHead className="text-muted-foreground font-semibold">Registered</TableHead>
                  <TableHead className="text-muted-foreground font-semibold text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map(a => {
                  const displayRole = a.memberRole ?? a.role;
                  const rc = ROLE_CONFIG[displayRole] ?? { label: displayRole, className: 'bg-gray-500/20 text-gray-400 border-gray-500/30' };
                  return (
                    <TableRow
                      key={a.id}
                      className="border-white/5 hover:bg-white/[0.03] cursor-pointer"
                      onClick={() => openDetail(a)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0 overflow-hidden ${
                            a.isPortalAccount ? 'bg-gradient-to-tr from-emerald-600/60 to-primary/60' : 'bg-gradient-to-tr from-gray-600/60 to-gray-400/60'
                          }`}>
                            {(() => { const src = resolveAvatarSrc(a.profileImage); return src ? <img src={src} alt="" className="w-full h-full object-cover" /> : (a.displayName || a.username)[0]?.toUpperCase() ?? '?'; })()}
                          </div>
                          <div>
                            <p className="font-medium text-white text-sm">{a.displayName || a.username}</p>
                            <p className="text-xs text-muted-foreground font-mono flex items-center gap-1.5">
                              {a.username}
                              {a.isPortalAccount
                                ? <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">Portal</span>
                                : <span className="text-[10px] px-1 py-0.5 rounded bg-gray-500/15 text-gray-400 border border-gray-500/20">Replit OAuth</span>
                              }
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">{a.email ?? '—'}</TableCell>
                      <TableCell>
                        {a.emailVerified ? (
                          <Badge className="bg-primary/15 text-primary border border-primary/25 text-xs gap-1">
                            <CheckCircle2 className="w-3 h-3" /> Verified
                          </Badge>
                        ) : (
                          <Badge className="bg-yellow-500/15 text-yellow-400 border border-yellow-500/25 text-xs gap-1">
                            <Mail className="w-3 h-3" /> Unverified
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={`${rc.className} text-xs border`}>{rc.label}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(a.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-2">
                          <FollowButton userId={a.id} initialFollowing={followeeIds.includes(a.id)} />
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => openDetail(a)}
                                className="h-7 px-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 gap-1"
                              >
                                <Edit2 className="w-3.5 h-3.5" /> Manage
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">View and manage this account</TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {/* Pagination */}
            {pages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-white/5">
                <p className="text-xs text-muted-foreground">{total} total accounts</p>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={page <= 1}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    className="h-7 px-3 text-xs hover:bg-white/5 text-muted-foreground disabled:opacity-40"
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground flex items-center px-2">{page} / {pages}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={page >= pages}
                    onClick={() => setPage(p => Math.min(pages, p + 1))}
                    className="h-7 px-3 text-xs hover:bg-white/5 text-muted-foreground disabled:opacity-40"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Detail Side Sheet */}
      <Sheet open={detailOpen} onOpenChange={v => { if (!v) { setDetailOpen(false); setSelectedAccount(null); setEditingProfile(false); } }}>
        <SheetContent className="glass-panel border-white/10 w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader className="mb-6">
            <SheetTitle className="text-white font-display text-xl flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-primary" /> Player Account
            </SheetTitle>
          </SheetHeader>

          {detailLoading ? (
            <div className="flex justify-center py-16">
              <div className="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
            </div>
          ) : selectedAccount ? (
            <div className="space-y-6">
              {/* Profile section */}
              <div className="glass-card rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Profile</p>
                  {!editingProfile ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { setEditName(selectedAccount.displayName ?? ''); setEditEmail(selectedAccount.email ?? ''); setEditingProfile(true); }}
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-white gap-1"
                    >
                      <Edit2 className="w-3 h-3" /> Edit
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingProfile(false)}
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-white"
                    >
                      Cancel
                    </Button>
                  )}
                </div>

                {editingProfile ? (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Display Name</label>
                      <Input
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        placeholder="Display name"
                        className="bg-black/50 border-white/10 text-white h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Email Address</label>
                      <Input
                        value={editEmail}
                        onChange={e => setEditEmail(e.target.value)}
                        placeholder="email@example.com"
                        type="email"
                        className="bg-black/50 border-white/10 text-white h-8 text-sm"
                      />
                    </div>
                    <Button
                      onClick={saveProfile}
                      disabled={savingProfile}
                      className="w-full h-8 text-sm bg-primary hover:bg-primary/90 text-primary-foreground"
                    >
                      {savingProfile ? 'Saving...' : 'Save Changes'}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-emerald-600/60 to-primary/60 flex items-center justify-center text-white font-bold text-lg flex-shrink-0 overflow-hidden">
                        {(() => { const src = resolveAvatarSrc(selectedAccount.profileImage); return src ? <img src={src} alt="Avatar" className="w-full h-full object-cover" /> : (selectedAccount.displayName || selectedAccount.username)[0]?.toUpperCase() ?? '?'; })()}
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold text-white">{selectedAccount.displayName || selectedAccount.username}</p>
                        <p className="text-xs text-muted-foreground font-mono">{selectedAccount.username}</p>
                        {selectedAccount.profileImage && (
                          <button
                            onClick={adminRemovePhoto}
                            disabled={removingPhoto}
                            className="text-[10px] text-red-400 hover:text-red-300 mt-0.5 flex items-center gap-1 transition-colors disabled:opacity-50"
                          >
                            {removingPhoto ? 'Removing...' : '✕ Remove photo'}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-1">
                      <div className="bg-black/30 rounded-lg p-2.5">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Email</p>
                        <p className="text-sm text-white break-all">{selectedAccount.email ?? '—'}</p>
                      </div>
                      <div className="bg-black/30 rounded-lg p-2.5">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Status</p>
                        {selectedAccount.emailVerified ? (
                          <p className="text-sm text-primary flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Verified</p>
                        ) : (
                          <p className="text-sm text-yellow-400 flex items-center gap-1"><Mail className="w-3.5 h-3.5" /> Unverified</p>
                        )}
                      </div>
                      <div className="bg-black/30 rounded-lg p-2.5">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Role</p>
                        <p className="text-sm text-white">{ROLE_CONFIG[selectedAccount.memberRole ?? selectedAccount.role]?.label ?? (selectedAccount.memberRole ?? selectedAccount.role)}</p>
                      </div>
                      <div className="bg-black/30 rounded-lg p-2.5">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Registered</p>
                        <p className="text-sm text-white">{new Date(selectedAccount.createdAt).toLocaleDateString()}</p>
                      </div>
                    </div>
                    {selectedAccount.hasPassword && (
                      <div className="bg-black/30 rounded-lg p-2.5 flex items-center gap-2">
                        <KeyRound className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <p className="text-xs text-muted-foreground">
                          Password authentication enabled — password is securely hashed and never visible
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* GHIN Number */}
              <div className="glass-card rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">GHIN / Handicap</p>
                  {!editingGhin ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { setEditGhin(selectedAccount.ghinNumber ?? ''); setEditingGhin(true); }}
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-white gap-1"
                    >
                      <Edit2 className="w-3 h-3" /> Edit
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingGhin(false)}
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-white"
                    >
                      Cancel
                    </Button>
                  )}
                </div>
                {editingGhin ? (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">GHIN Number</label>
                      <div className="flex gap-2">
                        <Input
                          value={editGhin}
                          onChange={e => { setEditGhin(e.target.value); setGhinPreview(null); }}
                          placeholder="e.g. 1234567"
                          className="bg-black/50 border-white/10 text-white h-8 text-sm font-mono flex-1"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={lookupGhinPlayer}
                          disabled={lookingUpGhin || !editGhin.trim()}
                          className="h-8 px-3 text-xs border-white/10 text-muted-foreground hover:text-white gap-1 shrink-0"
                        >
                          {lookingUpGhin ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                          Lookup
                        </Button>
                      </div>
                      <p className="text-[10px] text-muted-foreground">Enter GHIN number then click Lookup to verify and auto-fill player info.</p>
                    </div>
                    {ghinPreview && (
                      <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 space-y-1">
                        <p className="text-[10px] text-primary uppercase tracking-wider font-semibold">GHIN Verified</p>
                        <p className="text-sm text-white font-medium">{ghinPreview.firstName} {ghinPreview.lastName}</p>
                        {ghinPreview.handicapIndex !== null && (
                          <p className="text-xs text-muted-foreground">Handicap Index: <span className="text-white font-semibold">{ghinPreview.handicapIndex.toFixed(1)}</span></p>
                        )}
                        {ghinPreview.club && (
                          <p className="text-xs text-muted-foreground">Club: {ghinPreview.club}</p>
                        )}
                      </div>
                    )}
                    <Button
                      onClick={saveGhin}
                      disabled={savingGhin}
                      className="w-full h-8 text-sm bg-primary hover:bg-primary/90 text-primary-foreground"
                    >
                      {savingGhin ? 'Saving...' : 'Save GHIN'}
                    </Button>
                  </div>
                ) : (
                  <div className="bg-black/30 rounded-lg p-2.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">GHIN Number</p>
                    <p className="text-sm text-white font-mono">{selectedAccount.ghinNumber ?? <span className="text-muted-foreground italic">Not set</span>}</p>
                  </div>
                )}
              </div>

              {/* Admin Actions */}
              <div className="glass-card rounded-xl p-4 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Admin Actions</p>

                {selectedAccount.isPortalAccount ? (
                  <>
                    <div className="grid grid-cols-1 gap-2">
                      <Button
                        variant="ghost"
                        disabled={sendingReset || !selectedAccount.email}
                        onClick={sendPasswordReset}
                        className="w-full h-9 justify-start gap-2 text-sm text-muted-foreground hover:text-white hover:bg-white/5 border border-white/5"
                      >
                        <Mail className="w-4 h-4 text-emerald-400" />
                        {sendingReset ? 'Sending...' : 'Send Password Reset Email'}
                      </Button>

                      {!selectedAccount.emailVerified && (
                        <Button
                          variant="ghost"
                          disabled={forcingVerify}
                          onClick={forceVerify}
                          className="w-full h-9 justify-start gap-2 text-sm text-muted-foreground hover:text-white hover:bg-white/5 border border-white/5"
                        >
                          <CheckCircle2 className="w-4 h-4 text-primary" />
                          {forcingVerify ? 'Verifying...' : 'Force Verify Email (skip email link)'}
                        </Button>
                      )}

                      <Button
                        variant="ghost"
                        onClick={() => { setPwDialogOpen(true); setNewPassword(''); setShowPassword(false); }}
                        className="w-full h-9 justify-start gap-2 text-sm text-muted-foreground hover:text-white hover:bg-white/5 border border-white/5"
                      >
                        <KeyRound className="w-4 h-4 text-orange-400" />
                        Set New Password Directly
                      </Button>
                    </div>

                    <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
                      Passwords are one-way hashed and can never be viewed. Use "Send Password Reset" to let the player choose their own password, or "Set New Password" to assign one on their behalf (useful when a player is onsite and locked out).
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground italic py-1">
                    Password and verification actions are only available for portal (email+password) accounts.
                    This account uses Replit OAuth.
                  </p>
                )}
              </div>

              {/* Payment Summary */}
              {selectedAccount.paymentSummary && (
                <div className="glass-card rounded-xl p-4 space-y-3">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <CreditCard className="w-3 h-3" /> Payment Summary
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-black/30 rounded-lg p-2.5 text-center">
                      <p className="text-lg font-bold text-primary">{selectedAccount.paymentSummary.tournamentsPaid}</p>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Tournaments Paid</p>
                    </div>
                    <div className="bg-black/30 rounded-lg p-2.5 text-center">
                      <p className="text-lg font-bold text-yellow-400">{selectedAccount.paymentSummary.tournamentsPending}</p>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Pending Payment</p>
                    </div>
                    <div className="bg-black/30 rounded-lg p-2.5 text-center">
                      <p className="text-lg font-bold text-white">{selectedAccount.paymentSummary.shopOrderCount}</p>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Shop Orders</p>
                    </div>
                    <div className="bg-black/30 rounded-lg p-2.5 text-center">
                      <p className="text-lg font-bold text-white">
                        ₹{selectedAccount.paymentSummary.shopTotalSpend.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </p>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Shop Spend</p>
                    </div>
                  </div>
                  {selectedAccount.paymentSummary.shopTotalRefunded > 0 && (
                    <p className="text-xs text-muted-foreground">
                      ₹{selectedAccount.paymentSummary.shopTotalRefunded.toLocaleString('en-IN')} refunded from shop orders
                    </p>
                  )}
                </div>
              )}

              {/* Recent Activity */}
              {selectedAccount.recentActivity.length > 0 && (
                <div className="glass-card rounded-xl p-4 space-y-3">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <RefreshCw className="w-3 h-3" /> Recent Activity
                  </p>
                  <div className="space-y-2">
                    {selectedAccount.recentActivity.map((activity, i) => (
                      <div key={i} className="flex items-start gap-2.5">
                        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${
                          activity.type === 'tournament_registration' ? 'bg-primary' :
                          activity.type === 'shop_order' ? 'bg-emerald-400' : 'bg-muted-foreground'
                        }`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-white leading-relaxed">{activity.description}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {new Date(activity.timestamp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tournament Registrations */}
              <div className="glass-card rounded-xl p-4 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Trophy className="w-3 h-3" /> Tournament Registrations ({selectedAccount.registrations.length})
                </p>

                {selectedAccount.registrations.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No tournament registrations in this organization yet.</p>
                ) : (
                  <div className="space-y-2">
                    {selectedAccount.registrations.map(r => (
                      <div key={r.playerId} className="bg-black/30 rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-white truncate">{r.tournamentName}</p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 font-semibold uppercase tracking-wide ${
                            r.paymentStatus === 'paid' ? 'bg-primary/15 text-primary border border-primary/25' :
                            r.paymentStatus === 'refunded' ? 'bg-gray-500/15 text-gray-400 border border-gray-500/25' :
                            'bg-yellow-500/15 text-yellow-400 border border-yellow-500/25'
                          }`}>
                            {r.paymentStatus}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            {r.tournamentDate ? new Date(r.tournamentDate).toLocaleDateString() : 'TBD'}
                          </span>
                          <span>{r.firstName} {r.lastName}</span>
                          {r.handicapIndex && <span>HCP {r.handicapIndex}</span>}
                          {r.checkedIn && (
                            <span className="flex items-center gap-1 text-primary">
                              <CheckCircle2 className="w-3 h-3" /> Checked in
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Shop Order History */}
              {selectedAccount.shopOrders.length > 0 && (
                <div className="glass-card rounded-xl p-4 space-y-3">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <ShoppingBag className="w-3 h-3" /> Shop Order History ({selectedAccount.shopOrders.length})
                  </p>
                  <div className="space-y-2">
                    {selectedAccount.shopOrders.map(o => (
                      <div key={o.id} className="bg-black/30 rounded-lg p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-white truncate">{o.productName}</p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 font-semibold uppercase tracking-wide ${
                            o.status === 'delivered' || o.status === 'shipped' ? 'bg-primary/15 text-primary border border-primary/25' :
                            o.status === 'refunded' || o.status === 'cancelled' ? 'bg-gray-500/15 text-gray-400 border border-gray-500/25' :
                            'bg-yellow-500/15 text-yellow-400 border border-yellow-500/25'
                          }`}>
                            {o.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                          <span>Qty: {o.quantity}</span>
                          <span>{o.currency} {Number(o.totalAmount).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                          <span>{new Date(o.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Club Membership */}
              {selectedAccount.clubMemberships.length > 0 && (
                <div className="glass-card rounded-xl p-4 space-y-3">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Users className="w-3 h-3" /> Club Membership
                  </p>
                  <div className="space-y-2">
                    {selectedAccount.clubMemberships.map(m => (
                      <div key={m.clubMemberId} className="bg-black/30 rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-white">
                            {m.memberNumber ? `#${m.memberNumber}` : 'Club Member'}
                          </p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide ${
                            m.subscriptionStatus === 'active' ? 'bg-primary/15 text-primary border border-primary/25' :
                            m.subscriptionStatus === 'expired' || m.subscriptionStatus === 'cancelled' ? 'bg-gray-500/15 text-gray-400 border border-gray-500/25' :
                            'bg-yellow-500/15 text-yellow-400 border border-yellow-500/25'
                          }`}>
                            {m.subscriptionStatus}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          <span>Joined {new Date(m.joinDate).toLocaleDateString()}</span>
                          {m.renewalDate && <span>Renews {new Date(m.renewalDate).toLocaleDateString()}</span>}
                          {m.lastPaymentAt && <span>Last paid {new Date(m.lastPaymentAt).toLocaleDateString()}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Set Password Dialog */}
      <Dialog open={pwDialogOpen} onOpenChange={v => { if (!v) { setPwDialogOpen(false); setNewPassword(''); setShowPassword(false); } }}>
        <DialogContent className="glass-panel border-white/10 sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-orange-400" /> Set New Password
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            {selectedAccount && (
              <p className="text-sm text-muted-foreground">
                Setting a new password for <span className="text-white font-medium">{selectedAccount.displayName || selectedAccount.email}</span>.
                Their old password and any active reset links will be invalidated immediately.
              </p>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">New Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  className="bg-black/50 border-white/10 text-white pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {newPassword.length > 0 && newPassword.length < 8 && (
                <p className="text-xs text-destructive">Password must be at least 8 characters</p>
              )}
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <Button
                variant="ghost"
                onClick={() => { setPwDialogOpen(false); setNewPassword(''); setShowPassword(false); }}
                className="hover:bg-white/5 text-white"
              >
                Cancel
              </Button>
              <Button
                onClick={setPassword}
                disabled={savingPassword || newPassword.length < 8}
                className="bg-orange-500 hover:bg-orange-600 text-white"
              >
                {savingPassword ? 'Setting...' : 'Set Password'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─── Invite Member Dialog ───────────────────────────────────────── */

function InviteMemberDialog({ open, onClose, orgId, onSuccess }: {
  open: boolean; onClose: () => void; orgId: number; onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('player');

  const resetAndClose = () => { setUsername(''); setRole('player'); onClose(); };

  const { mutate: addMember, isPending } = useAddOrgMember({
    mutation: {
      onSuccess: () => {
        toast({ title: `${username} added to organization` });
        onSuccess();
        resetAndClose();
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error ?? 'Failed to add member';
        toast({ title: msg, variant: 'destructive' });
      },
    }
  });

  const handleAdd = () => {
    if (!username.trim()) { toast({ title: 'Username is required', variant: 'destructive' }); return; }
    addMember({ orgId, data: { username: username.trim(), role: role as AddMemberInputRole } });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && resetAndClose()}>
      <DialogContent className="glass-panel border-white/10 sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-primary" /> Add Member
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-white">Replit Username *</label>
            <Input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="e.g. jsmith"
              className="bg-black/50 border-white/10 text-white font-mono"
            />
            <p className="text-xs text-muted-foreground">The member must have logged in at least once to be added.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-white">Role</label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="bg-black/50 border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-card border-white/10 text-white">
                {ROLE_OPTIONS.map(opt => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="ghost" onClick={resetAndClose} className="hover:bg-white/5 text-white">Cancel</Button>
            <Button onClick={handleAdd} disabled={isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {isPending ? 'Adding...' : 'Add Member'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
