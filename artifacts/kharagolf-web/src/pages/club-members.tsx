import { Fragment, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Users, Plus, Search, Trash2, Mail, Phone, RefreshCw,
  CheckCircle2, XCircle, Clock, AlertCircle, AlertTriangle, CreditCard, Settings2, Download,
  Send, Link2, UserCheck, UserX, Copy, Receipt, DollarSign, Pencil,
  Filter, Snowflake, Ban, RotateCcw, Tag, MessageSquare, ArrowUpDown, Save, Bookmark, Coins,
  History, ChevronDown, ChevronRight, ExternalLink, Info, Repeat,
  MailCheck, MailX, MailWarning, Eye, X,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { FollowButton } from '@/components/FollowButton';
import { useFolloweeIds } from '@/hooks/useFolloweeIds';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

interface MemberAccountCharge {
  id: number;
  amount: string;
  description: string | null;
  isSettled: boolean;
  createdAt: string;
  settlementNote: string | null;
}

interface MembershipTier {
  id: number;
  name: string;
  annualFee: string;
  currency: string;
  memberCount: number;
  isActive: boolean;
  razorpayPlanId: string | null;
}

interface MemberFilters {
  search?: string;
  status?: string;
  tierId?: number | null;
  hasPortal?: 'yes' | 'no' | null;
  hasEmail?: 'yes' | 'no' | null;
}

interface SavedSegment {
  id: number;
  name: string;
  description: string | null;
  filters: MemberFilters;
  isShared: boolean;
  ownerUserId: number;
}

interface LevyCharge {
  id: number;
  clubMemberId: number;
  amount: string;
  paid: boolean;
  paidAt: string | null;
  status: 'unpaid' | 'partial' | 'paid' | 'waived' | 'refunded';
  paidAmount: string;
  refundedAmount: string;
  waivedReason: string | null;
  createdAt: string;
  // Latest receipt-email delivery outcome (Task 222).
  lastReceiptStatus: 'sent' | 'skipped' | 'failed' | null;
  lastReceiptReason: string | null;
  lastReceiptKind: 'payment' | 'partial_payment' | 'refund' | 'waiver' | null;
  lastReceiptAmount: string | null;
  lastReceiptAt: string | null;
  memberNumber: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
}
interface LevyDetailResponse {
  levy: MemberLevy;
  charges: LevyCharge[];
  summary: {
    total: number;
    paidCount: number;
    partialCount: number;
    unpaidCount: number;
    waivedCount: number;
    refundedCount: number;
    collected: string;
    outstanding: string;
    refunded: string;
    waived: string;
    currency: string;
    reminderSentCount?: number;
    reminderFailedCount?: number;
    reminderSkippedCount?: number;
    reminderUnresolvedFailedCount?: number;
    reminderByChannel?: Record<string, { sent: number; failed: number; skipped?: number; unresolvedFailed?: number }>;
    failedReceiptCount?: number;
    skippedReceiptCount?: number;
  };
}

interface BulkResendReceiptsPreviewRow {
  chargeId: number;
  clubMemberId: number;
  memberName: string;
  memberNumber: string | null;
  email: string | null;
  kind: 'payment' | 'partial_payment' | 'refund' | 'waiver' | null;
  amount: string;
  lastReceiptStatus: 'failed' | 'skipped';
  lastReceiptReason: string | null;
  predictedOutcome: 'sendable' | 'will_skip_no_email' | 'will_skip_opted_out' | 'invalid';
}

interface BulkResendReceiptsPreviewResponse {
  levyId: number;
  levyName: string;
  currency: string;
  total: number;
  sendable: number;
  willSkipNoEmail: number;
  willSkipOptedOut: number;
  invalid: number;
  rows: BulkResendReceiptsPreviewRow[];
}

type BulkResendChannelKey = 'email' | 'push' | 'sms' | 'whatsapp';
type BulkResendChannelStatus = 'sent' | 'failed' | 'no_address' | 'no_user' | 'opted_out' | 'skipped';
interface BulkResendChannelResult {
  status: BulkResendChannelStatus;
  error?: string;
}
interface BulkResendReceiptsResult {
  levyId: number;
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  channelTotals: Record<BulkResendChannelKey, Record<BulkResendChannelStatus, number>>;
  results: Array<{
    chargeId: number;
    clubMemberId: number;
    memberName: string;
    status: 'sent' | 'skipped' | 'failed';
    reason: string | null;
    kind: 'payment' | 'partial_payment' | 'refund' | 'waiver';
    amount: string;
    channels: Record<BulkResendChannelKey, BulkResendChannelResult>;
  }>;
}

interface MemberLevy {
  id: number;
  name: string;
  description: string | null;
  amount: string;
  currency: string;
  scope: 'all' | 'tier' | 'manual';
  scopeFilter: { tierIds?: number[]; memberIds?: number[] } | null;
  status: string;
  createdAt: string;
  appliedAt: string | null;
  dueDate: string | null;
}

interface ClubMember {
  id: number;
  userId: number | null;
  memberNumber: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  handicapIndex: string | null;
  whsGhinNumber: string | null;
  joinDate: string;
  renewalDate: string | null;
  subscriptionStatus: string;
  showInDirectory: boolean;
  tierId: number | null;
  tierName: string | null;
  tierAnnualFee: string | null;
  inviteToken: string | null;
  inviteTokenExpiry: string | null;
  pendingMemberLink: boolean;
}

const statusColors: Record<string, { bg: string; text: string; icon: React.ElementType }> = {
  active: { bg: 'bg-green-500/20 border-green-500/30', text: 'text-green-400', icon: CheckCircle2 },
  past_due: { bg: 'bg-yellow-500/20 border-yellow-500/30', text: 'text-yellow-400', icon: AlertCircle },
  cancelled: { bg: 'bg-gray-500/20 border-gray-500/30', text: 'text-gray-400', icon: XCircle },
  expired: { bg: 'bg-red-500/20 border-red-500/30', text: 'text-red-400', icon: XCircle },
  pending: { bg: 'bg-blue-500/20 border-blue-500/30', text: 'text-blue-400', icon: Clock },
};

const currencySymbol: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€' };

/**
 * Parse a CSV produced by the levy-ledger export endpoint into an array of
 * objects keyed by header name. The exporter quotes every field and escapes
 * embedded quotes by doubling them, so we mirror that minimal grammar here.
 * Used by the on-screen export preview so treasurers can see the same Balance
 * column they'll get in the downloaded CSV/PDF.
 */
function parseLedgerCsv(csv: string): Array<Record<string, string>> {
  if (!csv) return [];
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); records.push(row); row = []; cell = ''; }
      else if (c === '\r') { /* skip */ }
      else cell += c;
    }
  }
  if (cell !== '' || row.length > 0) { row.push(cell); records.push(row); }
  if (records.length === 0) return [];
  const header = records[0];
  return records.slice(1).filter(r => r.length === header.length).map(r => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = r[idx] ?? ''; });
    return obj;
  });
}

interface BulkAuditDetailRow {
  auditId: number;
  clubMemberId: number | null;
  action: string;
  entityId: number | null;
  fieldChanges: Record<string, { from: unknown; to: unknown }> | null;
  createdAt: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

const REVERSIBLE_BULK_ACTIONS = new Set(['freeze', 'suspend', 'tag', 'tier_change']);
const REDOABLE_BULK_ACTIONS = new Set(['freeze', 'suspend', 'tag', 'tier_change']);
const REVERSIBLE_EVENT_TYPES = new Set(['payment', 'refund', 'waive']);

interface LevyChargeEvent {
  id: number;
  eventType: 'payment' | 'refund' | 'waive' | 'reversal' | string;
  amount: string;
  method: string | null;
  processorReference: string | null;
  note: string | null;
  reason: string | null;
  actorUserId: number | null;
  actorName: string | null;
  occurredAt: string;
  reversesEventId: number | null;
  reversed: boolean;
  reversedByEventId: number | null;
  reversedAt: string | null;
  reversedByActorName: string | null;
  runningPaid: string;
  runningRefunded: string;
  runningBalance: string;
}

interface LevyReminderHistoryRow {
  id: number;
  clubMemberId: number;
  channel: string;
  status: string;
  sentAt: string;
  errorMessage: string | null;
  subject: string | null;
  memberNumber: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
}

interface LevyReminderHistoryResponse {
  levyId: number;
  total: number;
  returnedCount: number;
  truncated: boolean;
  channels: string[];
  history: LevyReminderHistoryRow[];
}

function LevyReminderHistory({
  orgId, levyId,
}: {
  orgId: number; levyId: number;
}) {
  const [statusFilter, setStatusFilter] = useState<'all' | 'failed'>('all');
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const params = new URLSearchParams();
  if (statusFilter === 'failed') params.set('status', 'failed');
  if (channelFilter !== 'all') params.set('channel', channelFilter);
  const qs = params.toString();
  const q = useQuery<LevyReminderHistoryResponse>({
    queryKey: ['levy-reminder-history', orgId, levyId, statusFilter, channelFilter],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levies/${levyId}/reminders${qs ? `?${qs}` : ''}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId && !!levyId,
  });
  const channelOptions = q.data?.channels ?? [];
  const rows = q.data?.history ?? [];
  const fmtChannel = (c: string) => c.replace('_', ' ');
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-3" data-testid="levy-reminder-history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Reminder history</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {q.isLoading ? 'Loading…' : `${q.data?.total ?? 0} attempt${(q.data?.total ?? 0) === 1 ? '' : 's'}${q.data?.truncated ? ` (showing latest ${q.data?.returnedCount ?? 0})` : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | 'failed')}>
            <SelectTrigger className="h-8 text-xs bg-black/40 border-white/10 text-white w-[130px]" data-testid="select-reminder-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="failed">Failed only</SelectItem>
            </SelectContent>
          </Select>
          <Select value={channelFilter} onValueChange={setChannelFilter}>
            <SelectTrigger className="h-8 text-xs bg-black/40 border-white/10 text-white w-[130px]" data-testid="select-reminder-channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {channelOptions.map(c => (
                <SelectItem key={c} value={c}>{fmtChannel(c)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <a
            href={`/api/organizations/${orgId}/members-360/levies/${levyId}/reminders.csv${qs ? `?${qs}` : ''}`}
            className="h-8 px-3 inline-flex items-center rounded-md text-xs bg-white/10 hover:bg-white/20 text-white border border-white/10"
            data-testid="button-reminder-history-csv"
            download
          >
            Download CSV
          </a>
        </div>
      </div>
      {q.isLoading ? (
        <div className="py-4 text-center text-xs text-muted-foreground">Loading reminder history…</div>
      ) : q.isError ? (
        <div className="py-4 text-center text-xs text-rose-300">Failed to load reminder history.</div>
      ) : rows.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground" data-testid="reminder-history-empty">
          No reminder attempts match the current filters.
        </div>
      ) : (
        <div className="border border-white/10 rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-black/40 text-[10px] text-muted-foreground uppercase tracking-wider">
              <tr>
                <th className="text-left px-2 py-1.5">Member</th>
                <th className="text-left px-2 py-1.5">Channel</th>
                <th className="text-left px-2 py-1.5">Status</th>
                <th className="text-left px-2 py-1.5">When</th>
                <th className="text-left px-2 py-1.5">Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const failed = r.status === 'failed';
                const skipped = r.status === 'skipped';
                const badgeClass = failed
                  ? 'bg-red-500/20 text-red-300 border-red-500/30'
                  : skipped
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                    : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
                const badgeLabel = skipped ? 'skipped (opted out)' : r.status;
                const errorCellClass = skipped
                  ? 'px-2 py-1.5 text-amber-300/80 max-w-[18rem] truncate'
                  : 'px-2 py-1.5 text-rose-300 max-w-[18rem] truncate';
                const errorText = r.errorMessage ?? (failed ? 'unknown' : skipped ? 'opted out' : '—');
                return (
                  <tr key={r.id} className="border-t border-white/5" data-testid={`reminder-history-row-${r.id}`}>
                    <td className="px-2 py-1.5 text-white">
                      <div className="font-medium">{r.firstName} {r.lastName}</div>
                      <div className="text-[10px] text-muted-foreground">{r.memberNumber ?? '—'}{r.email ? ` · ${r.email}` : ''}</div>
                    </td>
                    <td className="px-2 py-1.5 text-white capitalize">{fmtChannel(r.channel)}</td>
                    <td className="px-2 py-1.5">
                      <Badge className={`${badgeClass} border text-[10px]`} data-testid={`reminder-history-status-${r.id}`}>
                        {badgeLabel}
                      </Badge>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">
                      {new Date(r.sentAt).toLocaleString()}
                    </td>
                    <td className={errorCellClass} title={r.errorMessage ?? undefined}>
                      {errorText}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface LevyLedgerEmailScheduleRow {
  id: number;
  frequency: 'weekly' | 'monthly';
  recipients: string[];
  enabled: boolean;
  /** Org-level club-wide digest only — Task #322. */
  deliveryFormat?: 'combined' | 'per_levy_zip' | 'both';
  lastSentAt: string | null;
  nextRunAt: string | null;
}

/**
 * Per-run snapshot of a recipient that was silently dropped from this
 * specific levy-ledger digest run because they were on the org's
 * `email_suppressions` list when the cron evaluated. Persisted on
 * `levyLedgerEmailRunsTable.pausedRecipients` /
 * `levyLedgerEmailOrgRunsTable.pausedRecipients` (Task #1763) so the
 * run-history "X paused" chip (Task #2199) reflects what was actually
 * pruned at the time of that run, even after the suppression was lifted
 * or the schedule's recipient list was edited. Shape mirrors
 * `WalletTopupRefundEmailRunPausedRecipient` so the levy-ledger panels
 * can use the same `levyLedgerPausedReasonLabel` helper as the wallet
 * auto-refund history (Task #1759 follow-up).
 */
interface LevyLedgerEmailRunPausedRecipientSnapshot {
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
}

interface LevyLedgerEmailRunRow {
  id: number;
  sentAt: string;
  periodStart: string | null;
  periodEnd: string;
  recipients: string[];
  rowCount: number;
  status: 'sent' | 'failed' | 'skipped';
  errorMessage: string | null;
  /**
   * Snapshot of which recipients were on the suppression list when this
   * specific run was dispatched (Task #2199). Older rows inserted before
   * Task #1763's column landed will come back as `[]` thanks to the
   * column default; treat `undefined` defensively all the same.
   */
  pausedRecipients?: LevyLedgerEmailRunPausedRecipientSnapshot[];
}

/**
 * One paused recipient row returned by the levy-ledger schedule endpoints
 * (Task #1763). Mirrors the wallet auto-refund digest shape (Task #1443) so
 * the React panels can use the same `pausedReasonLabel` helper for both.
 */
interface LevyLedgerPausedRecipientRow {
  /**
   * Live suppression row id when the address is currently on
   * `email_suppressions`, or `null` when the row was sourced from a
   * past run's snapshot because the suppression was lifted in the
   * meantime. The "remove from suppression list" button is hidden when
   * this is null since there is nothing to remove.
   */
  suppressionId: number | null;
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
  createdAt: string;
  /**
   * True when this row was *not* on the schedule's saved recipients
   * list — it survives only via the most recent run's snapshot,
   * meaning Task #1444's cron has already pruned the address out of
   * `schedule.recipients`. Drives the "auto-removed on last run" copy
   * in the warning panel.
   */
  fromRunSnapshot?: boolean;
}

/**
 * Friendly label for the suppression `reason` enum stored in
 * `email_suppressions.reason`. Mirrors the labels used on the wallet
 * auto-refund digest dashboard (Task #1443) and the marketing
 * Suppressions tab so the language is consistent across the admin app.
 * Translated via the `admin` namespace — Task #2200, so non-EN admins
 * see the same warning vocabulary as the wallet dashboard.
 */
function levyLedgerPausedReasonLabel(
  t: TFunction,
  reason: string,
  bounceType: string | null,
): string {
  switch (reason) {
    case 'bounced':
      return bounceType
        ? t('admin:levyLedgerDigestPaused.reasonBouncedWithType', { bounceType })
        : t('admin:levyLedgerDigestPaused.reasonBounced');
    case 'unsubscribed': return t('admin:levyLedgerDigestPaused.reasonUnsubscribed');
    case 'spam_complaint': return t('admin:levyLedgerDigestPaused.reasonSpamComplaint');
    case 'manual': return t('admin:levyLedgerDigestPaused.reasonManual');
    default: return reason;
  }
}

interface LevyLedgerEmailScheduleResponse {
  schedule: LevyLedgerEmailScheduleRow | null;
  history: LevyLedgerEmailRunRow[];
  pausedRecipients?: LevyLedgerPausedRecipientRow[];
}

interface LevyEmailPdfHistoryRow {
  id: number;
  createdAt: string;
  actorName: string | null;
  actorRole: string | null;
  recipients: string[];
  status: 'sent' | 'failed';
  errorMessage: string | null;
  rowCount: number | null;
  totals: Record<string, unknown> | null;
  currency: string | null;
  filename: string | null;
  message: string | null;
}

/**
 * Recent on-demand auditor PDF sends for the open levy (Task #312).
 * Mirrors the schedule history panel — newest-first, status-coloured, with
 * the captured error message on failures so admins can confirm the send
 * (and to whom) without leaving the Export ledger dialog.
 */
function LevyEmailPdfHistoryPanel({ orgId, levyId }: { orgId: number; levyId: number }) {
  const q = useQuery<{ sends: LevyEmailPdfHistoryRow[]; limit: number }>({
    queryKey: ['levy-email-pdf-history', orgId, levyId],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levies/${levyId}/email-pdf-history`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId && !!levyId,
    refetchInterval: 30_000,
  });
  const sends = q.data?.sends ?? [];
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2" data-testid="levy-email-pdf-history">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Auditor PDF send history</p>
        {sends.length > 0 && (
          <span className="text-[10px] text-muted-foreground">Last {sends.length}</span>
        )}
      </div>
      {q.isLoading ? (
        <div className="py-2 text-center text-xs text-muted-foreground">Loading history…</div>
      ) : q.isError ? (
        <div className="py-2 text-center text-xs text-rose-300">Failed to load history.</div>
      ) : sends.length === 0 ? (
        <div className="py-2 text-center text-xs text-muted-foreground">
          No auditor sends yet. Use the form above to email the ledger PDF.
        </div>
      ) : (
        <ul className="space-y-1.5 max-h-56 overflow-auto pr-1">
          {sends.map(s => {
            const ts = new Date(s.createdAt);
            const totalsObj = (s.totals ?? {}) as Record<string, unknown>;
            const numOr = (k: string) => typeof totalsObj[k] === 'number' ? (totalsObj[k] as number) : null;
            const payment = numOr('payment');
            const refund = numOr('refund');
            const waive = numOr('waive');
            const net = payment != null || refund != null
              ? +(((payment ?? 0) - (refund ?? 0)).toFixed(2))
              : null;
            const sym = s.currency ? (currencySymbol[s.currency] ?? '') : '';
            return (
              <li
                key={s.id}
                className={`rounded border px-2 py-1.5 text-[11px] ${
                  s.status === 'failed'
                    ? 'border-rose-500/40 bg-rose-500/10'
                    : 'border-white/10 bg-black/30'
                }`}
                data-testid={`levy-email-pdf-history-row-${s.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-white font-medium">
                    {ts.toLocaleString()}
                  </span>
                  <span
                    className={`uppercase tracking-wider text-[9px] font-semibold ${
                      s.status === 'failed' ? 'text-rose-300' : 'text-emerald-300'
                    }`}
                    data-testid={`levy-email-pdf-history-status-${s.id}`}
                  >
                    {s.status}
                  </span>
                </div>
                <div className="text-muted-foreground mt-0.5 break-words">
                  To: <span className="text-white">{s.recipients.join(', ') || '—'}</span>
                </div>
                <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3" data-testid={`levy-email-pdf-history-totals-${s.id}`}>
                  {s.rowCount != null && (
                    <span>{s.rowCount} row{s.rowCount === 1 ? '' : 's'}</span>
                  )}
                  {payment != null && (
                    <span>Payments: {sym}{payment.toLocaleString()}</span>
                  )}
                  {refund != null && refund > 0 && (
                    <span className="text-rose-300">Refunds: {sym}{refund.toLocaleString()}</span>
                  )}
                  {waive != null && waive > 0 && (
                    <span>Waives: {sym}{waive.toLocaleString()}</span>
                  )}
                  {net != null && (
                    <span className="text-white">Net: {sym}{net.toLocaleString()}</span>
                  )}
                  {s.actorName && (
                    <span>By {s.actorName}{s.actorRole ? ` (${s.actorRole})` : ''}</span>
                  )}
                </div>
                {s.status === 'failed' && s.errorMessage && (
                  <div className="mt-1 text-rose-300 break-words" data-testid={`levy-email-pdf-history-error-${s.id}`}>
                    {s.errorMessage}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function LevyLedgerEmailSchedulePanel({ orgId, levyId }: { orgId: number; levyId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const q = useQuery<LevyLedgerEmailScheduleResponse>({
    queryKey: ['levy-ledger-email-schedule', orgId, levyId],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levies/${levyId}/email-schedule`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId && !!levyId,
  });

  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('weekly');
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [hydratedFor, setHydratedFor] = useState<number | null>(null);

  // Hydrate the form from server state once per levy. We watch the schedule's
  // `id` (or "none") so editing locally doesn't get clobbered by every refetch.
  const sched = q.data?.schedule ?? null;
  const hydrationKey = sched ? sched.id : -1;
  if (hydratedFor !== hydrationKey && q.isSuccess) {
    if (sched) {
      setFrequency(sched.frequency);
      setRecipients(sched.recipients.join(', '));
      setEnabled(sched.enabled);
    } else {
      setFrequency('weekly');
      setRecipients('');
      setEnabled(true);
    }
    setHydratedFor(hydrationKey);
  }

  const parsedRecipients = recipients
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const invalid = parsedRecipients.filter(r => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));

  // Task #1763 — the server is the source of truth for the paused list
  // so we render it as-is. It already unions the live suppressions for
  // saved recipients with the most recent run's pausedRecipients
  // snapshot, which lets us keep showing addresses Task #1444's cron
  // has pruned out of `schedule.recipients`. Intersecting with the
  // textarea would re-introduce the bug from the code review.
  const apiPaused: LevyLedgerPausedRecipientRow[] = q.data?.pausedRecipients ?? [];

  // Task #2200 — paused-recipients warnings are routed through the i18n
  // catalog (`admin:levyLedgerDigestPaused.*`) so non-EN admins see the
  // same translated suppression vocabulary as the wallet auto-refund
  // dashboard. The non-paused toast titles are intentionally left in
  // English here — they are out of scope for Task #2200 and will be
  // covered in a follow-up that translates the rest of the panel.
  const { t } = useTranslation('admin');

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levies/${levyId}/email-schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency, recipients: parsedRecipients, enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ schedule: LevyLedgerEmailScheduleRow; pausedRecipients?: LevyLedgerPausedRecipientRow[] }>;
    },
    onSuccess: (res) => {
      // Task #1763 — surface the suppression warning the moment the admin
      // saves. Without this, the editor would only show a paused chip
      // after the next dashboard refresh, by which point the user has
      // navigated away from the warning context.
      const paused = res.pausedRecipients ?? [];
      if (paused.length > 0) {
        toast({
          title: t('admin:levyLedgerDigestPaused.saveToastTitle'),
          description: t('admin:levyLedgerDigestPaused.saveToastDescription', { count: paused.length }),
          variant: 'destructive',
        });
      } else {
        toast({ title: 'Schedule saved', description: enabled ? 'The treasurer will receive the next ledger automatically.' : 'Schedule paused; no emails will be sent.' });
      }
      queryClient.invalidateQueries({ queryKey: ['levy-ledger-email-schedule', orgId, levyId] });
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  // Task #1763 — one-click "remove from suppression list" so admins can
  // unblock a fixed inbox without leaving the levy edit drawer. The
  // backend also re-adds the address to the configured recipients list
  // if Task #1444's bounce-aware filter had already pruned it out.
  const unsuppressMut = useMutation({
    mutationFn: async (email: string) => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levies/${levyId}/email-schedule/unsuppress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ ok: true; removed: number; restoredToSchedule: boolean }>;
    },
    onSuccess: (res, email) => {
      toast({
        title: t('admin:levyLedgerDigestPaused.unsuppressToastTitle'),
        description: res.restoredToSchedule
          ? t('admin:levyLedgerDigestPaused.unsuppressToastRestored', { email })
          : t('admin:levyLedgerDigestPaused.unsuppressToastDefault', { email }),
      });
      queryClient.invalidateQueries({ queryKey: ['levy-ledger-email-schedule', orgId, levyId] });
    },
    onError: (e: Error) => toast({ title: t('admin:levyLedgerDigestPaused.unsuppressErrorTitle'), description: e.message, variant: 'destructive' }),
  });
  const [pausedExpanded, setPausedExpanded] = useState(false);

  const deleteMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levies/${levyId}/email-schedule`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    },
    onSuccess: () => {
      toast({ title: 'Schedule removed' });
      queryClient.invalidateQueries({ queryKey: ['levy-ledger-email-schedule', orgId, levyId] });
    },
    onError: (e: Error) => toast({ title: 'Remove failed', description: e.message, variant: 'destructive' }),
  });

  const [preview, setPreview] = useState<{
    rowCount: number;
    periodStart: string;
    periodEnd: string;
    recipients: string[];
    rows: Array<{
      date: string;
      member: string;
      memberNumber: string;
      currency: string;
      type: string;
      amount: string;
      runningPaid: string;
      runningRefunded: string;
      runningBalance: string;
    }>;
  } | null>(null);
  const [expandedPreviewRows, setExpandedPreviewRows] = useState<Set<number>>(new Set());
  const previewMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levies/${levyId}/email-schedule/preview`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ rowCount: number; periodStart: string; periodEnd: string; recipients: string[]; frequency: string; csv: string }>;
    },
    onSuccess: (res) => {
      const parsed = parseLedgerCsv(res.csv ?? '');
      const PREVIEW_ROW_LIMIT = 5;
      const rows = parsed.slice(0, PREVIEW_ROW_LIMIT).map(r => ({
        date: r.date ?? '',
        member: r.member ?? '',
        memberNumber: r.member_number ?? '',
        currency: r.currency ?? '',
        type: r.type ?? '',
        amount: r.amount ?? '',
        runningPaid: r.running_paid ?? '',
        runningRefunded: r.running_refunded ?? '',
        runningBalance: r.running_balance ?? '',
      }));
      setPreview({ rowCount: res.rowCount, periodStart: res.periodStart, periodEnd: res.periodEnd, recipients: res.recipients, rows });
      setExpandedPreviewRows(new Set());
      toast({ title: 'Preview ready', description: `${res.rowCount} ledger row${res.rowCount === 1 ? '' : 's'} would be sent to ${res.recipients.length} recipient${res.recipients.length === 1 ? '' : 's'}. No email was sent.` });
    },
    onError: (e: Error) => toast({ title: 'Preview failed', description: e.message, variant: 'destructive' }),
  });

  const sendNowMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levies/${levyId}/email-schedule/send-now`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ status: string; rowCount: number; recipients: string[]; errorMessage?: string }>;
    },
    onSuccess: (res) => {
      if (res.status === 'sent') {
        toast({ title: 'Email sent', description: `Delivered ${res.rowCount} ledger row${res.rowCount === 1 ? '' : 's'} to ${res.recipients.length} recipient${res.recipients.length === 1 ? '' : 's'}.` });
      } else {
        toast({ title: 'Send failed', description: res.errorMessage ?? res.status, variant: 'destructive' });
      }
      queryClient.invalidateQueries({ queryKey: ['levy-ledger-email-schedule', orgId, levyId] });
    },
    onError: (e: Error) => toast({ title: 'Send failed', description: e.message, variant: 'destructive' }),
  });

  const history = q.data?.history ?? [];
  const fmtPeriod = (start: string | null, end: string) => {
    const s = start ? new Date(start).toLocaleDateString() : '—';
    const e = new Date(end).toLocaleDateString();
    return `${s} → ${e}`;
  };
  const canSave = parsedRecipients.length > 0 && parsedRecipients.length <= 20 && invalid.length === 0;

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-3" data-testid="levy-ledger-email-schedule">
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Email schedule</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Cron emails the period's CSV ledger to each recipient automatically.
        </p>
      </div>
      {q.isLoading ? (
        <div className="py-3 text-center text-xs text-muted-foreground">Loading schedule…</div>
      ) : q.isError ? (
        <div className="py-3 text-center text-xs text-rose-300">Failed to load schedule.</div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px] text-muted-foreground">Frequency</Label>
              <Select value={frequency} onValueChange={v => setFrequency(v as 'weekly' | 'monthly')}>
                <SelectTrigger className="mt-1 h-8 text-xs bg-black/40 border-white/10 text-white" data-testid="select-ledger-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 text-xs text-white cursor-pointer h-8">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                  data-testid="toggle-ledger-enabled"
                  className="accent-indigo-500"
                />
                {enabled ? 'Enabled' : 'Paused'}
              </label>
            </div>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">Recipients (comma- or whitespace-separated)</Label>
            <Textarea
              value={recipients}
              onChange={e => setRecipients(e.target.value)}
              placeholder="treasurer@club.com, secretary@club.com"
              className="mt-1 bg-black/40 border-white/10 text-white text-xs min-h-[60px]"
              data-testid="input-ledger-recipients"
            />
            <div className="text-[10px] mt-1">
              {invalid.length > 0 ? (
                <span className="text-rose-300">Invalid: {invalid.join(', ')}</span>
              ) : parsedRecipients.length > 0 ? (
                <span className="text-muted-foreground">{parsedRecipients.length} recipient{parsedRecipients.length === 1 ? '' : 's'}</span>
              ) : (
                <span className="text-muted-foreground">Enter at least one email address.</span>
              )}
            </div>
          </div>
          {sched && (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span>Last sent: {sched.lastSentAt ? new Date(sched.lastSentAt).toLocaleString() : 'never'}</span>
              <span>Next run: {sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : '—'}</span>
              {apiPaused.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPausedExpanded(v => !v)}
                  data-testid="chip-ledger-paused-recipients"
                  className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300 hover:bg-amber-500/20"
                  title={t('admin:levyLedgerDigestPaused.chipTitle')}
                >
                  <AlertTriangle className="h-3 w-3" />
                  {t('admin:levyLedgerDigestPaused.countChip', { count: apiPaused.length })}
                </button>
              )}
            </div>
          )}
          {apiPaused.length > 0 && pausedExpanded && (
            <div
              className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 space-y-1.5"
              data-testid="ledger-paused-recipients-panel"
            >
              <div className="flex items-center gap-1.5 text-[11px] text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="font-medium">
                  {t('admin:levyLedgerDigestPaused.panelHeader')}
                </span>
              </div>
              {apiPaused.map(p => (
                <div
                  key={p.suppressionId ?? `snapshot:${p.email.toLowerCase()}`}
                  className="flex items-center justify-between gap-2 rounded bg-black/30 px-2 py-1.5 text-xs text-white"
                  data-testid={`ledger-paused-row-${p.email}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11px]" data-testid={`ledger-paused-email-${p.email}`}>{p.email}</div>
                    <div className="text-[10px] text-amber-200/80">
                      {levyLedgerPausedReasonLabel(t, p.reason, p.bounceType)}
                      {p.description ? ` · ${p.description}` : ''}
                      {' · '}
                      {t('admin:levyLedgerDigestPaused.rowPausedOn', { date: new Date(p.createdAt).toLocaleDateString() })}
                      {p.fromRunSnapshot ? ` · ${t('admin:levyLedgerDigestPaused.rowAutoRemoved')}` : ''}
                    </div>
                  </div>
                  {p.suppressionId !== null ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => unsuppressMut.mutate(p.email)}
                      disabled={unsuppressMut.isPending}
                      data-testid={`button-ledger-unsuppress-${p.email}`}
                      className="h-7 px-2 text-[11px] text-amber-200 hover:text-amber-100 hover:bg-amber-500/20"
                      title={t('admin:levyLedgerDigestPaused.removeButtonTitle')}
                    >
                      <X className="mr-1 h-3 w-3" />
                      {t('admin:levyLedgerDigestPaused.removeButton')}
                    </Button>
                  ) : (
                    <span
                      data-testid={`ledger-paused-history-${p.email}`}
                      className="text-[10px] text-amber-200/60 italic shrink-0"
                      title={t('admin:levyLedgerDigestPaused.fromRunHistoryTitle')}
                    >
                      {t('admin:levyLedgerDigestPaused.fromRunHistory')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => saveMut.mutate()}
              disabled={!canSave || saveMut.isPending}
              data-testid="button-save-ledger-schedule"
              className="bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              {saveMut.isPending ? 'Saving…' : sched ? 'Update schedule' : 'Create schedule'}
            </Button>
            {sched && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => previewMut.mutate()}
                  disabled={previewMut.isPending}
                  data-testid="button-preview-ledger"
                  className="border-white/10 text-white"
                >
                  {previewMut.isPending ? 'Building…' : 'Preview'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendNowMut.mutate()}
                  disabled={sendNowMut.isPending || !sched.enabled || sched.recipients.length === 0}
                  data-testid="button-send-ledger-now"
                  className="border-white/10 text-white"
                >
                  {sendNowMut.isPending ? 'Sending…' : 'Send now'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { if (confirm('Remove this email schedule?')) deleteMut.mutate(); }}
                  disabled={deleteMut.isPending}
                  data-testid="button-delete-ledger-schedule"
                  className="text-rose-300 hover:text-rose-200"
                >
                  Remove
                </Button>
              </>
            )}
          </div>
          {preview && (
            <div className="rounded-md border border-indigo-500/30 bg-indigo-500/10 p-2 text-xs text-white" data-testid="ledger-preview-result">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium" data-testid="ledger-preview-rowcount">
                    {preview.rowCount} row{preview.rowCount === 1 ? '' : 's'} would be sent — no email was sent.
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    Period {new Date(preview.periodStart).toLocaleString()} → {new Date(preview.periodEnd).toLocaleString()} · {preview.recipients.length} recipient{preview.recipients.length === 1 ? '' : 's'}
                  </div>
                </div>
                <a
                  href={`/api/organizations/${orgId}/members-360/levies/${levyId}/email-schedule/preview?download=1`}
                  className="h-8 px-3 inline-flex items-center rounded-md text-xs bg-white/10 hover:bg-white/20 text-white border border-white/10"
                  data-testid="link-download-ledger-preview"
                  download
                >
                  Download preview CSV
                </a>
              </div>
              {preview.rows.length > 0 ? (
                <div className="mt-2 border border-white/5 rounded overflow-x-auto bg-black/30">
                  <table className="w-full text-[11px]" data-testid="ledger-preview-table">
                    <thead className="bg-black/40 text-[10px] text-muted-foreground uppercase tracking-wider">
                      <tr>
                        <th className="text-left px-2 py-1.5 w-6"></th>
                        <th className="text-left px-2 py-1.5">Date</th>
                        <th className="text-left px-2 py-1.5">Member</th>
                        <th className="text-left px-2 py-1.5">Type</th>
                        <th className="text-right px-2 py-1.5">Amount</th>
                        <th className="text-right px-2 py-1.5">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r, idx) => {
                        const sym = currencySymbol[r.currency] ?? '';
                        const amt = parseFloat(r.amount || '0');
                        const balance = parseFloat(r.runningBalance || '0');
                        const paid = parseFloat(r.runningPaid || '0');
                        const refunded = parseFloat(r.runningRefunded || '0');
                        const dateLabel = r.date ? new Date(r.date).toLocaleString() : '';
                        const tooltip = `Paid to date ${sym}${paid.toLocaleString()} · Refunded to date ${sym}${refunded.toLocaleString()}`;
                        const expanded = expandedPreviewRows.has(idx);
                        const toggle = () => {
                          setExpandedPreviewRows(prev => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx); else next.add(idx);
                            return next;
                          });
                        };
                        return (
                          <Fragment key={idx}>
                            <tr
                              className="border-t border-white/5 cursor-pointer hover:bg-white/5"
                              title={tooltip}
                              onClick={toggle}
                              data-testid={`ledger-preview-row-${idx}`}
                            >
                              <td className="px-2 py-1.5 text-muted-foreground">
                                <span className="inline-block w-3 text-center" aria-hidden>{expanded ? '▾' : '▸'}</span>
                              </td>
                              <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{dateLabel}</td>
                              <td className="px-2 py-1.5 text-white">
                                {r.member || '—'}
                                {r.memberNumber && <span className="text-muted-foreground"> · {r.memberNumber}</span>}
                              </td>
                              <td className="px-2 py-1.5 text-muted-foreground">{r.type}</td>
                              <td className="px-2 py-1.5 text-right text-amber-300 whitespace-nowrap">{sym}{amt.toLocaleString()}</td>
                              <td
                                className="px-2 py-1.5 text-right text-white font-medium whitespace-nowrap"
                                data-testid={`ledger-preview-balance-${idx}`}
                              >
                                {sym}{balance.toLocaleString()}
                              </td>
                            </tr>
                            {expanded && (
                              <tr className="border-t border-white/5 bg-black/40" data-testid={`ledger-preview-detail-${idx}`}>
                                <td></td>
                                <td colSpan={5} className="px-2 py-1.5 text-[10px] text-muted-foreground">
                                  <span className="text-green-400" data-testid={`ledger-preview-running-paid-${idx}`}>
                                    Running paid: {sym}{paid.toLocaleString()}
                                  </span>
                                  <span className="mx-2">·</span>
                                  <span className="text-rose-300" data-testid={`ledger-preview-running-refunded-${idx}`}>
                                    Running refunded: {sym}{refunded.toLocaleString()}
                                  </span>
                                  <span className="mx-2">·</span>
                                  <span className="text-white">
                                    Running balance: {sym}{balance.toLocaleString()}
                                  </span>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  {preview.rowCount > preview.rows.length && (
                    <div className="px-2 py-1.5 text-[10px] text-muted-foreground border-t border-white/5" data-testid="ledger-preview-more">
                      … {preview.rowCount - preview.rows.length} more row{preview.rowCount - preview.rows.length === 1 ? '' : 's'} in the full file.
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-2 text-[10px] text-muted-foreground" data-testid="ledger-preview-empty">
                  No ledger activity in this period.
                </div>
              )}
            </div>
          )}
          {sched && (
            <div className="border border-white/10 rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-black/40 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-2 py-1.5">Sent</th>
                    <th className="text-left px-2 py-1.5">Period</th>
                    <th className="text-left px-2 py-1.5">Rows</th>
                    <th className="text-left px-2 py-1.5">Recipients</th>
                    {/* Task #2199 — per-run "X paused" column so treasurers
                        can see at a glance which recipients were silently
                        dropped from a specific run, without parsing the
                        free-text errorMessage. Mirrors the wallet auto-refund
                        digest history (Task #1759). */}
                    <th className="text-left px-2 py-1.5">Paused</th>
                    <th className="text-left px-2 py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr><td colSpan={6} className="px-2 py-3 text-center text-muted-foreground" data-testid="ledger-history-empty">No emails sent yet.</td></tr>
                  ) : history.map(h => {
                    const tone = h.status === 'sent' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                      : h.status === 'failed' ? 'bg-red-500/20 text-red-300 border-red-500/30'
                      : 'bg-amber-500/20 text-amber-300 border-amber-500/30';
                    // Task #2199 — defensive: an older row inserted before
                    // the column existed will still come back as `[]`
                    // thanks to the column default, but normalise
                    // `undefined`/non-array shapes so the chip never
                    // crashes the table.
                    const runPaused: LevyLedgerEmailRunPausedRecipientSnapshot[] =
                      Array.isArray(h.pausedRecipients) ? h.pausedRecipients : [];
                    const pausedTitle = runPaused
                      .map(p => `${p.email} — ${levyLedgerPausedReasonLabel(p.reason, p.bounceType)}${p.description ? ` (${p.description})` : ''}`)
                      .join('\n');
                    return (
                      <tr key={h.id} className="border-t border-white/5 align-top" data-testid={`ledger-history-row-${h.id}`}>
                        <td className="px-2 py-1.5 text-white whitespace-nowrap">{new Date(h.sentAt).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{fmtPeriod(h.periodStart, h.periodEnd)}</td>
                        <td className="px-2 py-1.5 text-white">{h.rowCount}</td>
                        <td className="px-2 py-1.5 text-muted-foreground max-w-[14rem] truncate" title={h.recipients.join(', ')}>
                          {h.recipients.length} ({h.recipients.join(', ')})
                        </td>
                        <td className="px-2 py-1.5">
                          {runPaused.length === 0 ? (
                            <span
                              className="text-muted-foreground"
                              data-testid={`ledger-history-paused-empty-${h.id}`}
                            >
                              —
                            </span>
                          ) : (
                            <div
                              className="space-y-0.5"
                              data-testid={`ledger-history-paused-${h.id}`}
                            >
                              <span
                                title={pausedTitle}
                                className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-amber-200 text-[10px]"
                                data-testid={`ledger-history-paused-chip-${h.id}`}
                              >
                                <AlertTriangle className="w-3 h-3" />
                                {runPaused.length} paused
                              </span>
                              <ul className="text-[10px] text-amber-200/80 max-w-[16rem] space-y-0.5">
                                {runPaused.map((p, idx) => (
                                  <li
                                    key={`${h.id}-${p.email}-${idx}`}
                                    className="truncate"
                                    title={`${p.email} — ${levyLedgerPausedReasonLabel(p.reason, p.bounceType)}${p.description ? ` (${p.description})` : ''}`}
                                    data-testid={`ledger-history-paused-row-${h.id}-${idx}`}
                                  >
                                    <span className="font-mono">{p.email}</span>
                                    <span className="text-amber-300/70"> · {levyLedgerPausedReasonLabel(p.reason, p.bounceType)}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge className={`${tone} border text-[10px]`}>{h.status}</Badge>
                          {h.errorMessage && <div className="text-[10px] text-rose-300 mt-1 truncate max-w-[14rem]" title={h.errorMessage}>{h.errorMessage}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface LevyReceiptAttemptRow {
  id: number;
  kind: 'payment' | 'refund' | 'waiver' | string;
  transactionAmount: string | null;
  newBalance: string | null;
  note: string | null;
  createdAt: string;
  pushStatus: string | null;
  pushAttempts: number | null;
  lastPushAt: string | null;
  lastPushError: string | null;
  lastPushRetryAt: string | null;
  pushRetryExhaustedAt: string | null;
  smsStatus: string | null;
  smsAttempts: number | null;
  lastSmsAt: string | null;
  lastSmsError: string | null;
  lastSmsRetryAt: string | null;
  smsRetryExhaustedAt: string | null;
  whatsappStatus: string | null;
  whatsappAttempts: number | null;
  lastWhatsappAt: string | null;
  lastWhatsappError: string | null;
  lastWhatsappRetryAt: string | null;
  whatsappRetryExhaustedAt: string | null;
}
interface LevyReceiptHistoryResponse {
  chargeId: number;
  currency: string;
  maxPushAttempts: number;
  maxSmsAttempts: number;
  maxWhatsappAttempts: number;
  attempts: LevyReceiptAttemptRow[];
}
function receiptChannelBadgeColor(status: string | null): string {
  switch (status) {
    case 'sent': return 'border-emerald-500/40 text-emerald-300';
    case 'failed': return 'border-red-500/40 text-red-300';
    case 'no_address':
    case 'no_user':
    case 'no_device': return 'border-amber-500/40 text-amber-300';
    case 'opted_out':
    case 'skipped': return 'border-white/20 text-white/50';
    default: return 'border-white/20 text-white/60';
  }
}
function LevyChargeReceipts({
  orgId, levyId, memberId,
}: {
  orgId: number; levyId: number; memberId: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const q = useQuery<LevyReceiptHistoryResponse>({
    queryKey: ['levy-charge-receipts', orgId, levyId, memberId],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levies/${levyId}/charges/${memberId}/receipts`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId && !!levyId && !!memberId,
  });
  const retryMut = useMutation({
    mutationFn: async (vars: { attemptId: number; channel: 'push' | 'sms' | 'whatsapp' }) => {
      const r = await fetch(
        `/api/organizations/${orgId}/members-360/levies/${levyId}/charges/${memberId}/receipts/${vars.attemptId}/retry-channel`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: vars.channel }),
        },
      );
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ result: { channel: string; status: string; attempts: number; exhausted: boolean; error?: string } }>;
    },
    onSuccess: (res, vars) => {
      const r = res?.result;
      const ok = r?.status === 'sent';
      const cap = vars.channel === 'push'
        ? (q.data?.maxPushAttempts ?? 5)
        : vars.channel === 'sms'
          ? (q.data?.maxSmsAttempts ?? 5)
          : (q.data?.maxWhatsappAttempts ?? 5);
      const channelLabel = vars.channel === 'whatsapp' ? 'WhatsApp' : vars.channel.toUpperCase();
      toast({
        title: ok ? `${channelLabel} retry sent` : `${channelLabel} retry — ${r?.status ?? 'unknown'}`,
        description: r
          ? `Attempt ${r.attempts} of ${cap}${r.exhausted ? ' — retry cap reached' : ''}${r.error ? ` · ${r.error}` : ''}`
          : undefined,
        variant: ok ? 'default' : 'destructive',
      });
      queryClient.invalidateQueries({ queryKey: ['levy-charge-receipts', orgId, levyId, memberId] });
    },
    onError: (e: Error, vars) => toast({ title: `${vars.channel === 'whatsapp' ? 'WhatsApp' : vars.channel.toUpperCase()} retry failed`, description: e.message, variant: 'destructive' }),
  });
  if (q.isLoading) return <div className="px-3 py-3 text-xs text-muted-foreground">Loading receipt notifications…</div>;
  if (q.isError) return <div className="px-3 py-3 text-xs text-rose-300">Failed to load receipt notifications.</div>;
  const attempts = q.data?.attempts ?? [];
  if (attempts.length === 0) {
    return (
      <div className="px-3 py-3 space-y-2" data-testid={`levy-charge-receipts-${memberId}`}>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Receipt notifications</div>
        <div className="text-xs text-muted-foreground">No receipt notifications recorded yet.</div>
      </div>
    );
  }
  const maxPush = q.data?.maxPushAttempts ?? 5;
  const maxSms = q.data?.maxSmsAttempts ?? 5;
  const maxWhatsapp = q.data?.maxWhatsappAttempts ?? 5;
  const kindLabel = (k: string) => {
    const pretty = k.replace(/_/g, ' ');
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
  };
  const kindColor = (k: string) =>
    k === 'payment' ? 'text-green-400 border-green-500/30 bg-green-500/10'
    : k === 'refund' ? 'text-rose-300 border-rose-500/30 bg-rose-500/10'
    : 'text-purple-300 border-purple-500/30 bg-purple-500/10';
  return (
    <div className="px-3 py-3 space-y-2" data-testid={`levy-charge-receipts-${memberId}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Receipt notifications</div>
      <ul className="space-y-2">
        {attempts.map(a => {
          const pushAttempts = a.pushAttempts ?? 0;
          const smsAttempts = a.smsAttempts ?? 0;
          const pushTooltip = [
            pushAttempts > 0 ? `Attempts: ${pushAttempts}/${maxPush}` : null,
            a.lastPushAt ? `Last attempt: ${new Date(a.lastPushAt).toLocaleString()}` : null,
            a.lastPushRetryAt ? `Last retry: ${new Date(a.lastPushRetryAt).toLocaleString()}` : null,
            a.pushRetryExhaustedAt ? `Retries exhausted ${new Date(a.pushRetryExhaustedAt).toLocaleString()}` : null,
            a.lastPushError ? `Error: ${a.lastPushError}` : null,
          ].filter(Boolean).join(' · ') || undefined;
          const smsTooltip = [
            smsAttempts > 0 ? `Attempts: ${smsAttempts}/${maxSms}` : null,
            a.lastSmsAt ? `Last attempt: ${new Date(a.lastSmsAt).toLocaleString()}` : null,
            a.lastSmsRetryAt ? `Last retry: ${new Date(a.lastSmsRetryAt).toLocaleString()}` : null,
            a.smsRetryExhaustedAt ? `Retries exhausted ${new Date(a.smsRetryExhaustedAt).toLocaleString()}` : null,
            a.lastSmsError ? `Error: ${a.lastSmsError}` : null,
          ].filter(Boolean).join(' · ') || undefined;
          const whatsappAttempts = a.whatsappAttempts ?? 0;
          const whatsappTooltip = [
            whatsappAttempts > 0 ? `Attempts: ${whatsappAttempts}/${maxWhatsapp}` : null,
            a.lastWhatsappAt ? `Last attempt: ${new Date(a.lastWhatsappAt).toLocaleString()}` : null,
            a.lastWhatsappRetryAt ? `Last retry: ${new Date(a.lastWhatsappRetryAt).toLocaleString()}` : null,
            a.whatsappRetryExhaustedAt ? `Retries exhausted ${new Date(a.whatsappRetryExhaustedAt).toLocaleString()}` : null,
            a.lastWhatsappError ? `Error: ${a.lastWhatsappError}` : null,
          ].filter(Boolean).join(' · ') || undefined;
          return (
            <li key={a.id} className="flex items-start gap-3 text-xs" data-testid={`levy-receipt-attempt-${a.id}`}>
              <span className={`shrink-0 inline-flex items-center justify-center px-2 py-0.5 rounded border ${kindColor(a.kind)} font-semibold`}>
                {kindLabel(a.kind)}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant="outline"
                    className={`${receiptChannelBadgeColor(a.pushStatus)} cursor-help`}
                    title={pushTooltip}
                    data-testid={`levy-receipt-push-${a.id}`}
                  >
                    push: {a.pushStatus ?? 'unknown'} · {pushAttempts}/{maxPush}
                  </Badge>
                  {a.pushRetryExhaustedAt && (
                    <span
                      className="text-[10px] text-red-300 border border-red-500/40 bg-red-500/10 rounded px-1.5 py-0.5"
                      data-testid={`levy-receipt-push-exhausted-${a.id}`}
                      title={`Retries exhausted ${new Date(a.pushRetryExhaustedAt).toLocaleString()}`}
                    >
                      push exhausted
                    </span>
                  )}
                  <Badge
                    variant="outline"
                    className={`${receiptChannelBadgeColor(a.smsStatus)} cursor-help`}
                    title={smsTooltip}
                    data-testid={`levy-receipt-sms-${a.id}`}
                  >
                    sms: {a.smsStatus ?? 'unknown'} · {smsAttempts}/{maxSms}
                  </Badge>
                  {a.smsRetryExhaustedAt && (
                    <span
                      className="text-[10px] text-red-300 border border-red-500/40 bg-red-500/10 rounded px-1.5 py-0.5"
                      data-testid={`levy-receipt-sms-exhausted-${a.id}`}
                      title={`Retries exhausted ${new Date(a.smsRetryExhaustedAt).toLocaleString()}`}
                    >
                      sms exhausted
                    </span>
                  )}
                  <Badge
                    variant="outline"
                    className={`${receiptChannelBadgeColor(a.whatsappStatus)} cursor-help`}
                    title={whatsappTooltip}
                    data-testid={`levy-receipt-whatsapp-${a.id}`}
                  >
                    whatsapp: {a.whatsappStatus ?? 'unknown'} · {whatsappAttempts}/{maxWhatsapp}
                  </Badge>
                  {a.whatsappRetryExhaustedAt && (
                    <span
                      className="text-[10px] text-red-300 border border-red-500/40 bg-red-500/10 rounded px-1.5 py-0.5"
                      data-testid={`levy-receipt-whatsapp-exhausted-${a.id}`}
                      title={`Retries exhausted ${new Date(a.whatsappRetryExhaustedAt).toLocaleString()}`}
                    >
                      whatsapp exhausted
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(a.createdAt).toLocaleString()}
                  {a.lastPushAt ? ` · last push ${new Date(a.lastPushAt).toLocaleString()}` : ''}
                  {a.lastSmsAt ? ` · last sms ${new Date(a.lastSmsAt).toLocaleString()}` : ''}
                  {a.lastWhatsappAt ? ` · last whatsapp ${new Date(a.lastWhatsappAt).toLocaleString()}` : ''}
                </div>
                {a.note && <div className="text-muted-foreground mt-0.5">{a.note}</div>}
                {(a.pushStatus === 'failed' || a.smsStatus === 'failed' || a.whatsappStatus === 'failed') && (
                  <div className="flex flex-wrap items-center gap-2 mt-1.5">
                    {a.pushStatus === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={pushAttempts >= maxPush || !!a.pushRetryExhaustedAt || retryMut.isPending}
                        onClick={() => retryMut.mutate({ attemptId: a.id, channel: 'push' })}
                        title={pushAttempts >= maxPush || !!a.pushRetryExhaustedAt
                          ? 'Push retry cap reached'
                          : 'Force an immediate push retry'}
                        data-testid={`levy-receipt-retry-push-${a.id}`}
                      >
                        <Send className="w-3.5 h-3.5 mr-1" />Retry push now
                      </Button>
                    )}
                    {a.smsStatus === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={smsAttempts >= maxSms || !!a.smsRetryExhaustedAt || retryMut.isPending}
                        onClick={() => retryMut.mutate({ attemptId: a.id, channel: 'sms' })}
                        title={smsAttempts >= maxSms || !!a.smsRetryExhaustedAt
                          ? 'SMS retry cap reached'
                          : 'Force an immediate SMS retry'}
                        data-testid={`levy-receipt-retry-sms-${a.id}`}
                      >
                        <Send className="w-3.5 h-3.5 mr-1" />Retry SMS now
                      </Button>
                    )}
                    {a.whatsappStatus === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={whatsappAttempts >= maxWhatsapp || !!a.whatsappRetryExhaustedAt || retryMut.isPending}
                        onClick={() => retryMut.mutate({ attemptId: a.id, channel: 'whatsapp' })}
                        title={whatsappAttempts >= maxWhatsapp || !!a.whatsappRetryExhaustedAt
                          ? 'WhatsApp retry cap reached'
                          : 'Force an immediate WhatsApp retry'}
                        data-testid={`levy-receipt-retry-whatsapp-${a.id}`}
                      >
                        <Send className="w-3.5 h-3.5 mr-1" />Retry WhatsApp now
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface OrgLevyLedgerEmailScheduleResponse {
  schedule: (Omit<LevyLedgerEmailScheduleRow, never> & { levyCount?: number }) | null;
  history: Array<LevyLedgerEmailRunRow & { levyCount?: number }>;
  pausedRecipients?: LevyLedgerPausedRecipientRow[];
}

export function OrgLevyLedgerEmailSchedulePanel({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const q = useQuery<OrgLevyLedgerEmailScheduleResponse>({
    queryKey: ['org-levy-ledger-email-schedule', orgId],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levy-ledger/email-schedule`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId,
  });

  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('weekly');
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [deliveryFormat, setDeliveryFormat] = useState<'combined' | 'per_levy_zip' | 'both'>('combined');
  const [hydratedFor, setHydratedFor] = useState<number | null>(null);

  const sched = q.data?.schedule ?? null;
  const hydrationKey = sched ? sched.id : -1;
  if (hydratedFor !== hydrationKey && q.isSuccess) {
    if (sched) {
      setFrequency(sched.frequency);
      setRecipients(sched.recipients.join(', '));
      setEnabled(sched.enabled);
      setDeliveryFormat(sched.deliveryFormat ?? 'combined');
    } else {
      setFrequency('weekly');
      setRecipients('');
      setEnabled(true);
      setDeliveryFormat('combined');
    }
    setHydratedFor(hydrationKey);
  }

  const parsedRecipients = recipients
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const invalid = parsedRecipients.filter(r => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));

  // Task #1763 — same pattern as the per-levy panel: render the server's
  // paused list verbatim. The server already unions live suppressions
  // for saved recipients with the most recent run's snapshot, so an
  // address Task #1444's cron pruned out of `schedule.recipients` is
  // still surfaced here. Intersecting with the textarea would re-introduce
  // the bug that was raised in code review.
  const apiPaused: LevyLedgerPausedRecipientRow[] = q.data?.pausedRecipients ?? [];
  const [pausedExpanded, setPausedExpanded] = useState(false);

  // Task #2200 — translate paused-recipients warnings on the club-wide
  // digest panel through the shared `admin:levyLedgerDigestPaused.*`
  // catalog so non-EN admins see the same vocabulary as the wallet
  // auto-refund dashboard.
  const { t } = useTranslation('admin');

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levy-ledger/email-schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency, recipients: parsedRecipients, enabled, deliveryFormat }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ schedule: LevyLedgerEmailScheduleRow & { levyCount?: number }; pausedRecipients?: LevyLedgerPausedRecipientRow[] }>;
    },
    onSuccess: (res) => {
      const paused = res.pausedRecipients ?? [];
      if (paused.length > 0) {
        toast({
          title: t('admin:levyLedgerDigestPaused.saveToastTitle'),
          description: t('admin:levyLedgerDigestPaused.saveToastDescription', { count: paused.length }),
          variant: 'destructive',
        });
      } else {
        toast({ title: 'Club-wide digest saved', description: enabled ? 'Treasurers will receive the next combined ledger automatically.' : 'Schedule paused; no emails will be sent.' });
      }
      queryClient.invalidateQueries({ queryKey: ['org-levy-ledger-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  // Task #1763 — one-click unsuppress for the club-wide digest editor.
  const unsuppressMut = useMutation({
    mutationFn: async (email: string) => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levy-ledger/email-schedule/unsuppress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ ok: true; removed: number; restoredToSchedule: boolean }>;
    },
    onSuccess: (res, email) => {
      toast({
        title: t('admin:levyLedgerDigestPaused.unsuppressToastTitle'),
        description: res.restoredToSchedule
          ? t('admin:levyLedgerDigestPaused.unsuppressToastRestored', { email })
          : t('admin:levyLedgerDigestPaused.unsuppressToastDefault', { email }),
      });
      queryClient.invalidateQueries({ queryKey: ['org-levy-ledger-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: t('admin:levyLedgerDigestPaused.unsuppressErrorTitle'), description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levy-ledger/email-schedule`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    },
    onSuccess: () => {
      toast({ title: 'Schedule removed' });
      queryClient.invalidateQueries({ queryKey: ['org-levy-ledger-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Remove failed', description: e.message, variant: 'destructive' }),
  });

  const sendNowMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levy-ledger/email-schedule/send-now`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ status: string; rowCount: number; levyCount: number; recipients: string[]; errorMessage?: string }>;
    },
    onSuccess: (res) => {
      if (res.status === 'sent') {
        toast({ title: 'Digest sent', description: `Delivered ${res.rowCount} ledger row${res.rowCount === 1 ? '' : 's'} across ${res.levyCount} lev${res.levyCount === 1 ? 'y' : 'ies'} to ${res.recipients.length} recipient${res.recipients.length === 1 ? '' : 's'}.` });
      } else {
        toast({ title: 'Send failed', description: res.errorMessage ?? res.status, variant: 'destructive' });
      }
      queryClient.invalidateQueries({ queryKey: ['org-levy-ledger-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Send failed', description: e.message, variant: 'destructive' }),
  });

  const [previewOpen, setPreviewOpen] = useState(false);
  const previewMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levy-ledger/email-schedule/preview`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{
        subject: string; html: string;
        combinedFilename: string; zipFilename: string;
        rowCount: number; levyCount: number;
        deliveryFormat: 'combined' | 'per_levy_zip' | 'both';
        recipients: string[]; frequency: 'weekly' | 'monthly';
        periodStart: string; periodEnd: string;
        csvSample: { header: string; rows: string[]; totalRows: number; sampleSize: number } | null;
        perLevyFiles: Array<{ filename: string; rowCount: number }> | null;
      }>;
    },
    onSuccess: () => setPreviewOpen(true),
    onError: (e: Error) => toast({ title: 'Preview failed', description: e.message, variant: 'destructive' }),
  });

  const history = q.data?.history ?? [];
  const fmtPeriod = (start: string | null, end: string) => {
    const s = start ? new Date(start).toLocaleDateString() : '—';
    const e = new Date(end).toLocaleDateString();
    return `${s} → ${e}`;
  };
  const canSave = parsedRecipients.length > 0 && parsedRecipients.length <= 20 && invalid.length === 0;

  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3" data-testid="org-levy-ledger-email-schedule">
      <div className="flex items-start gap-2">
        <Receipt className="w-4 h-4 text-amber-300 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-white">Club-wide ledger digest</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Email a single combined CSV covering every levy's activity for the period — one digest per cadence, regardless of how many fundraisers are active.
          </p>
        </div>
      </div>
      {q.isLoading ? (
        <div className="py-3 text-center text-xs text-muted-foreground">Loading schedule…</div>
      ) : q.isError ? (
        <div className="py-3 text-center text-xs text-rose-300">Failed to load schedule.</div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px] text-muted-foreground">Frequency</Label>
              <Select value={frequency} onValueChange={v => setFrequency(v as 'weekly' | 'monthly')}>
                <SelectTrigger className="mt-1 h-8 text-xs bg-black/40 border-white/10 text-white" data-testid="select-org-ledger-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 text-xs text-white cursor-pointer h-8">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                  data-testid="toggle-org-ledger-enabled"
                  className="accent-amber-500"
                />
                {enabled ? 'Enabled' : 'Paused'}
              </label>
            </div>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">Delivery format</Label>
            <Select value={deliveryFormat} onValueChange={v => setDeliveryFormat(v as 'combined' | 'per_levy_zip' | 'both')}>
              <SelectTrigger className="mt-1 h-8 text-xs bg-black/40 border-white/10 text-white" data-testid="select-org-ledger-delivery-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="combined">Combined CSV (one file)</SelectItem>
                <SelectItem value="per_levy_zip">Per-levy CSV pack (ZIP)</SelectItem>
                <SelectItem value="both">Both — combined CSV + per-levy ZIP</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground mt-1">
              {deliveryFormat === 'combined'
                ? 'One CSV listing every levy in chronological order.'
                : deliveryFormat === 'per_levy_zip'
                  ? 'A ZIP attachment with one CSV per levy — keep books separated per fundraiser.'
                  : 'Sends both attachments in the same email so books stay separated and you still have the rolled-up view.'}
            </p>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">Recipients (comma- or whitespace-separated)</Label>
            <Textarea
              value={recipients}
              onChange={e => setRecipients(e.target.value)}
              placeholder="treasurer@club.com, secretary@club.com"
              className="mt-1 bg-black/40 border-white/10 text-white text-xs min-h-[60px]"
              data-testid="input-org-ledger-recipients"
            />
            <div className="text-[10px] mt-1">
              {invalid.length > 0 ? (
                <span className="text-rose-300">Invalid: {invalid.join(', ')}</span>
              ) : parsedRecipients.length > 0 ? (
                <span className="text-muted-foreground">{parsedRecipients.length} recipient{parsedRecipients.length === 1 ? '' : 's'}</span>
              ) : (
                <span className="text-muted-foreground">Enter at least one email address.</span>
              )}
            </div>
          </div>
          {sched && (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span>Last sent: {sched.lastSentAt ? new Date(sched.lastSentAt).toLocaleString() : 'never'}</span>
              <span>Next run: {sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : '—'}</span>
              {apiPaused.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPausedExpanded(v => !v)}
                  data-testid="chip-org-ledger-paused-recipients"
                  className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300 hover:bg-amber-500/20"
                  title={t('admin:levyLedgerDigestPaused.chipTitle')}
                >
                  <AlertTriangle className="h-3 w-3" />
                  {t('admin:levyLedgerDigestPaused.countChip', { count: apiPaused.length })}
                </button>
              )}
            </div>
          )}
          {apiPaused.length > 0 && pausedExpanded && (
            <div
              className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 space-y-1.5"
              data-testid="org-ledger-paused-recipients-panel"
            >
              <div className="flex items-center gap-1.5 text-[11px] text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="font-medium">
                  {t('admin:levyLedgerDigestPaused.panelHeader')}
                </span>
              </div>
              {apiPaused.map(p => (
                <div
                  key={p.suppressionId ?? `snapshot:${p.email.toLowerCase()}`}
                  className="flex items-center justify-between gap-2 rounded bg-black/30 px-2 py-1.5 text-xs text-white"
                  data-testid={`org-ledger-paused-row-${p.email}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11px]" data-testid={`org-ledger-paused-email-${p.email}`}>{p.email}</div>
                    <div className="text-[10px] text-amber-200/80">
                      {levyLedgerPausedReasonLabel(t, p.reason, p.bounceType)}
                      {p.description ? ` · ${p.description}` : ''}
                      {' · '}
                      {t('admin:levyLedgerDigestPaused.rowPausedOn', { date: new Date(p.createdAt).toLocaleDateString() })}
                      {p.fromRunSnapshot ? ` · ${t('admin:levyLedgerDigestPaused.rowAutoRemoved')}` : ''}
                    </div>
                  </div>
                  {p.suppressionId !== null ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => unsuppressMut.mutate(p.email)}
                      disabled={unsuppressMut.isPending}
                      data-testid={`button-org-ledger-unsuppress-${p.email}`}
                      className="h-7 px-2 text-[11px] text-amber-200 hover:text-amber-100 hover:bg-amber-500/20"
                      title={t('admin:levyLedgerDigestPaused.removeButtonTitle')}
                    >
                      <X className="mr-1 h-3 w-3" />
                      {t('admin:levyLedgerDigestPaused.removeButton')}
                    </Button>
                  ) : (
                    <span
                      data-testid={`org-ledger-paused-history-${p.email}`}
                      className="text-[10px] text-amber-200/60 italic shrink-0"
                      title={t('admin:levyLedgerDigestPaused.fromRunHistoryTitle')}
                    >
                      {t('admin:levyLedgerDigestPaused.fromRunHistory')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => saveMut.mutate()}
              disabled={!canSave || saveMut.isPending}
              data-testid="button-save-org-ledger-schedule"
              className="bg-amber-600 hover:bg-amber-500 text-white"
            >
              {saveMut.isPending ? 'Saving…' : sched ? 'Update schedule' : 'Create schedule'}
            </Button>
            {sched && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => previewMut.mutate()}
                  disabled={previewMut.isPending}
                  data-testid="button-preview-org-ledger"
                  className="border-white/10 text-white gap-1.5"
                >
                  <Eye className="w-3.5 h-3.5" />
                  {previewMut.isPending ? 'Loading…' : 'Preview'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendNowMut.mutate()}
                  disabled={sendNowMut.isPending || !sched.enabled || sched.recipients.length === 0}
                  data-testid="button-send-org-ledger-now"
                  className="border-white/10 text-white"
                >
                  {sendNowMut.isPending ? 'Sending…' : 'Send now'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { if (confirm('Remove the club-wide ledger digest schedule?')) deleteMut.mutate(); }}
                  disabled={deleteMut.isPending}
                  data-testid="button-delete-org-ledger-schedule"
                  className="text-rose-300 hover:text-rose-200"
                >
                  Remove
                </Button>
              </>
            )}
          </div>
          {sched && (
            <div className="border border-white/10 rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-black/40 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-2 py-1.5">Sent</th>
                    <th className="text-left px-2 py-1.5">Period</th>
                    <th className="text-left px-2 py-1.5">Levies</th>
                    <th className="text-left px-2 py-1.5">Rows</th>
                    <th className="text-left px-2 py-1.5">Recipients</th>
                    {/* Task #2199 — per-run "X paused" column on the
                        club-wide combined ledger digest history, mirroring
                        the per-levy table above and the wallet auto-refund
                        digest history (Task #1759). */}
                    <th className="text-left px-2 py-1.5">Paused</th>
                    <th className="text-left px-2 py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr><td colSpan={7} className="px-2 py-3 text-center text-muted-foreground" data-testid="org-ledger-history-empty">No digests sent yet.</td></tr>
                  ) : history.map(h => {
                    const tone = h.status === 'sent' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                      : h.status === 'failed' ? 'bg-red-500/20 text-red-300 border-red-500/30'
                      : 'bg-amber-500/20 text-amber-300 border-amber-500/30';
                    // Task #2199 — see per-levy panel above for the
                    // defensive normalisation rationale.
                    const runPaused: LevyLedgerEmailRunPausedRecipientSnapshot[] =
                      Array.isArray(h.pausedRecipients) ? h.pausedRecipients : [];
                    const pausedTitle = runPaused
                      .map(p => `${p.email} — ${levyLedgerPausedReasonLabel(p.reason, p.bounceType)}${p.description ? ` (${p.description})` : ''}`)
                      .join('\n');
                    return (
                      <tr key={h.id} className="border-t border-white/5 align-top" data-testid={`org-ledger-history-row-${h.id}`}>
                        <td className="px-2 py-1.5 text-white whitespace-nowrap">{new Date(h.sentAt).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{fmtPeriod(h.periodStart, h.periodEnd)}</td>
                        <td className="px-2 py-1.5 text-white">{h.levyCount ?? '—'}</td>
                        <td className="px-2 py-1.5 text-white">{h.rowCount}</td>
                        <td className="px-2 py-1.5 text-muted-foreground max-w-[14rem] truncate" title={h.recipients.join(', ')}>
                          {h.recipients.length} ({h.recipients.join(', ')})
                        </td>
                        <td className="px-2 py-1.5">
                          {runPaused.length === 0 ? (
                            <span
                              className="text-muted-foreground"
                              data-testid={`org-ledger-history-paused-empty-${h.id}`}
                            >
                              —
                            </span>
                          ) : (
                            <div
                              className="space-y-0.5"
                              data-testid={`org-ledger-history-paused-${h.id}`}
                            >
                              <span
                                title={pausedTitle}
                                className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-amber-200 text-[10px]"
                                data-testid={`org-ledger-history-paused-chip-${h.id}`}
                              >
                                <AlertTriangle className="w-3 h-3" />
                                {runPaused.length} paused
                              </span>
                              <ul className="text-[10px] text-amber-200/80 max-w-[16rem] space-y-0.5">
                                {runPaused.map((p, idx) => (
                                  <li
                                    key={`${h.id}-${p.email}-${idx}`}
                                    className="truncate"
                                    title={`${p.email} — ${levyLedgerPausedReasonLabel(p.reason, p.bounceType)}${p.description ? ` (${p.description})` : ''}`}
                                    data-testid={`org-ledger-history-paused-row-${h.id}-${idx}`}
                                  >
                                    <span className="font-mono">{p.email}</span>
                                    <span className="text-amber-300/70"> · {levyLedgerPausedReasonLabel(p.reason, p.bounceType)}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge className={`${tone} border text-[10px]`}>{h.status}</Badge>
                          {h.errorMessage && <div className="text-[10px] text-rose-300 mt-1 truncate max-w-[14rem]" title={h.errorMessage}>{h.errorMessage}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-3xl bg-[#0a1628] border-white/10 text-white" data-testid="dialog-org-ledger-preview">
          <DialogHeader>
            <DialogTitle className="text-white">Preview — next club-wide ledger digest</DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              This is what the next scheduled digest would look like if it were sent right now. Nothing has been sent and no run was recorded.
            </DialogDescription>
          </DialogHeader>
          {previewMut.data && (
            <div className="space-y-3 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Subject</div>
                  <div className="text-white" data-testid="text-org-preview-subject">{previewMut.data.subject}</div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Recipients</div>
                  <div className="text-white" data-testid="text-org-preview-recipients">
                    {previewMut.data.recipients.length === 0 ? '—' : previewMut.data.recipients.join(', ')}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Period</div>
                  <div className="text-white">
                    {new Date(previewMut.data.periodStart).toLocaleString()} → {new Date(previewMut.data.periodEnd).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Digest contents</div>
                  <div className="text-white" data-testid="text-org-preview-counts">
                    <span className="text-amber-400 font-semibold">{previewMut.data.rowCount}</span> row{previewMut.data.rowCount === 1 ? '' : 's'}
                    {' · '}
                    <span className="text-amber-400 font-semibold">{previewMut.data.levyCount}</span> lev{previewMut.data.levyCount === 1 ? 'y' : 'ies'}
                    {' · '}
                    <span className="text-muted-foreground">{previewMut.data.deliveryFormat === 'combined' ? 'Combined CSV' : previewMut.data.deliveryFormat === 'per_levy_zip' ? 'Per-levy ZIP' : 'Combined CSV + per-levy ZIP'}</span>
                  </div>
                </div>
              </div>
              {previewMut.data.csvSample && (
                <div data-testid="org-preview-csv-sample">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                    Combined CSV sample ({previewMut.data.combinedFilename})
                  </div>
                  <pre className="border border-white/10 rounded-md bg-black/60 text-white text-[11px] leading-snug font-mono p-2 overflow-x-auto whitespace-pre">
{[previewMut.data.csvSample.header, ...previewMut.data.csvSample.rows].join('\n') || '(empty)'}
                  </pre>
                  <div className="text-[10px] text-muted-foreground mt-1" data-testid="org-preview-csv-footer">
                    Showing {previewMut.data.csvSample.sampleSize} of {previewMut.data.csvSample.totalRows} row{previewMut.data.csvSample.totalRows === 1 ? '' : 's'}
                    {previewMut.data.csvSample.totalRows > previewMut.data.csvSample.sampleSize ? ' (sample truncated)' : ''}.
                  </div>
                </div>
              )}
              {previewMut.data.perLevyFiles && (
                <div data-testid="org-preview-per-levy-files">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                    Per-levy ZIP contents ({previewMut.data.zipFilename})
                  </div>
                  <div className="border border-white/10 rounded-md overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-black/40 text-[10px] text-muted-foreground uppercase tracking-wider">
                        <tr>
                          <th className="text-left px-2 py-1.5">Filename</th>
                          <th className="text-right px-2 py-1.5">Rows</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewMut.data.perLevyFiles.length === 0 ? (
                          <tr><td colSpan={2} className="px-2 py-2 text-center text-muted-foreground">No files.</td></tr>
                        ) : previewMut.data.perLevyFiles.map(f => (
                          <tr key={f.filename} className="border-t border-white/5">
                            <td className="px-2 py-1.5 font-mono text-white truncate max-w-[28rem]" title={f.filename}>{f.filename}</td>
                            <td className="px-2 py-1.5 text-right text-white">{f.rowCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1">
                    {previewMut.data.perLevyFiles.length} file{previewMut.data.perLevyFiles.length === 1 ? '' : 's'} in the ZIP.
                  </div>
                </div>
              )}
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Rendered body</div>
                <div className="border border-white/10 rounded-md bg-white overflow-hidden">
                  <iframe
                    title="Email body preview"
                    srcDoc={previewMut.data.html}
                    sandbox=""
                    className="w-full h-[420px] bg-white"
                    data-testid="iframe-org-preview-body"
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPreviewOpen(false)}
              className="border-white/10 text-white"
              data-testid="button-close-org-preview"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LevyChargeActivity({
  orgId, levyId, memberId, currency,
}: {
  orgId: number; levyId: number; memberId: number; currency: string;
}) {
  const sym = currencySymbol[currency] ?? '';
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const q = useQuery<{ chargeId: number; currency: string; events: LevyChargeEvent[] }>({
    queryKey: ['levy-charge-events', orgId, levyId, memberId],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/levies/${levyId}/charges/${memberId}/events`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId && !!levyId && !!memberId,
  });
  const [reverseTarget, setReverseTarget] = useState<LevyChargeEvent | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reversing, setReversing] = useState(false);
  const submitReverse = async () => {
    if (!reverseTarget) return;
    const reason = reverseReason.trim();
    if (!reason) {
      toast({ title: 'Reason required', description: 'Explain why this entry is being reversed.', variant: 'destructive' });
      return;
    }
    setReversing(true);
    try {
      const r = await fetch(
        `/api/organizations/${orgId}/members-360/levies/${levyId}/charges/${memberId}/events/${reverseTarget.id}/reverse`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) },
      );
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      toast({ title: 'Entry reversed', description: 'Charge totals have been recalculated.' });
      setReverseTarget(null);
      setReverseReason('');
      // Refresh both the timeline and the per-charge totals shown above it.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['levy-charge-events', orgId, levyId, memberId] }),
        queryClient.invalidateQueries({ queryKey: ['levy-charges', orgId, levyId] }),
        queryClient.invalidateQueries({ queryKey: ['member-360', orgId, memberId] }),
      ]);
    } catch (e) {
      toast({ title: 'Reverse failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setReversing(false); }
  };
  if (q.isLoading) return <div className="px-3 py-3 text-xs text-muted-foreground">Loading activity…</div>;
  if (q.isError) return <div className="px-3 py-3 text-xs text-rose-300">Failed to load activity.</div>;
  const events = q.data?.events ?? [];
  if (events.length === 0) return <div className="px-3 py-3 text-xs text-muted-foreground">No itemised events recorded yet.</div>;
  const eventsById = new Map(events.map(e => [e.id, e] as const));
  return (
    <div className="px-3 py-3 space-y-2" data-testid={`levy-charge-activity-${memberId}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Activity timeline</div>
      <ol className="space-y-2">
        {events.map(ev => {
          const colour = ev.eventType === 'payment' ? 'text-green-400 border-green-500/30 bg-green-500/10'
            : ev.eventType === 'refund' ? 'text-rose-300 border-rose-500/30 bg-rose-500/10'
            : ev.eventType === 'reversal' ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
            : 'text-purple-300 border-purple-500/30 bg-purple-500/10';
          const label = ev.eventType.charAt(0).toUpperCase() + ev.eventType.slice(1);
          const reversesEv = ev.reversesEventId != null ? eventsById.get(ev.reversesEventId) : undefined;
          const canReverse = !ev.reversed && ev.eventType !== 'reversal' && REVERSIBLE_EVENT_TYPES.has(ev.eventType);
          let blockedReason: string | null = null;
          let blockedShort: string | null = null;
          if (ev.reversed) {
            const when = ev.reversedAt ? new Date(ev.reversedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
            const who = ev.reversedByActorName;
            const parts = [`Already reversed by entry #${ev.reversedByEventId ?? '?'}`];
            if (when) parts.push(`on ${when}`);
            if (who) parts.push(`by ${who}`);
            blockedReason = parts.join(' ') + '.';
            blockedShort = 'Already reversed';
          } else if (ev.eventType === 'reversal') {
            blockedReason = 'Reversal entries cannot themselves be reversed — record a fresh payment or refund instead.';
            blockedShort = 'Cannot reverse a reversal';
          } else if (!REVERSIBLE_TYPES.has(ev.eventType)) {
            blockedReason = `Entries of type "${ev.eventType}" cannot be reversed.`;
            blockedShort = 'Not reversible';
          }
          return (
            <li key={ev.id} className="flex items-start gap-3 text-xs" data-testid={`levy-charge-event-${ev.id}`}>
              <span className={`shrink-0 inline-flex items-center justify-center px-2 py-0.5 rounded border ${colour} font-semibold`}>
                {label}
              </span>
              <div className={`flex-1 min-w-0 ${ev.reversed ? 'opacity-60 line-through decoration-amber-400/60' : ''}`}>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-white font-medium">{sym}{parseFloat(ev.amount).toLocaleString()}</span>
                  {ev.method && <span className="text-muted-foreground">via {ev.method.replace('_', ' ')}</span>}
                  {ev.processorReference && (
                    <span className="text-muted-foreground">ref <code className="bg-black/40 px-1 rounded">{ev.processorReference}</code></span>
                  )}
                  {ev.reversed && (
                    <span className="text-[10px] text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5 no-underline" data-testid={`levy-charge-event-reversed-${ev.id}`}>
                      Reversed
                    </span>
                  )}
                  {ev.reversed && blockedReason && (
                    <span className="text-[10px] text-muted-foreground no-underline" data-testid={`levy-charge-event-reversed-detail-${ev.id}`}>
                      {blockedReason}
                    </span>
                  )}
                  {ev.eventType === 'reversal' && reversesEv && (
                    <span className="text-[10px] text-muted-foreground no-underline">
                      undoes #{reversesEv.id} ({reversesEv.eventType} {sym}{parseFloat(reversesEv.amount).toLocaleString()})
                    </span>
                  )}
                </div>
                {(ev.note || ev.reason) && (
                  <div className="text-muted-foreground mt-0.5">{ev.note ?? ev.reason}</div>
                )}
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(ev.occurredAt).toLocaleString()}
                  {ev.actorName ? ` · by ${ev.actorName}` : ''}
                </div>
                <div
                  className="text-[10px] text-cyan-300/80 mt-0.5 no-underline"
                  data-testid={`levy-charge-event-balance-${ev.id}`}
                  title={`Paid to date ${sym}${parseFloat(ev.runningPaid).toLocaleString()} · Refunded to date ${sym}${parseFloat(ev.runningRefunded).toLocaleString()}`}
                >
                  Balance after: <span className="text-white font-medium">{sym}{parseFloat(ev.runningBalance).toLocaleString()}</span>
                  <span className="text-muted-foreground"> · paid {sym}{parseFloat(ev.runningPaid).toLocaleString()} · refunded {sym}{parseFloat(ev.runningRefunded).toLocaleString()}</span>
                </div>
              </div>
              {canReverse ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => { setReverseTarget(ev); setReverseReason(''); }}
                  className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 gap-1 h-6 px-2 text-[10px]"
                  data-testid={`button-reverse-event-${ev.id}`}
                >
                  <RotateCcw className="w-3 h-3" />
                  Reverse
                </Button>
              ) : blockedReason ? (
                <span
                  title={blockedReason}
                  aria-label={blockedReason}
                  className="shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded border border-white/10 bg-white/5 text-[10px] text-muted-foreground cursor-help"
                  data-testid={`reverse-blocked-${ev.id}`}
                >
                  <Info className="w-3 h-3" />
                  <span>{blockedShort}</span>
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <Dialog open={!!reverseTarget} onOpenChange={(o) => { if (!o && !reversing) { setReverseTarget(null); setReverseReason(''); } }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md" data-testid="dialog-reverse-event">
          <DialogHeader>
            <DialogTitle>Reverse this entry?</DialogTitle>
          </DialogHeader>
          {reverseTarget && (
            <div className="space-y-3 text-sm">
              <p>
                A compensating <span className="font-semibold text-amber-300">reversal</span> entry will be added for the{' '}
                <span className="capitalize">{reverseTarget.eventType}</span> of{' '}
                <span className="font-semibold text-white">{sym}{parseFloat(reverseTarget.amount).toLocaleString()}</span>
                {reverseTarget.processorReference ? <> (ref <code className="bg-black/40 px-1 rounded text-xs">{reverseTarget.processorReference}</code>)</> : null}.
                The original row stays in the ledger; the charge balance is recalculated from the surviving entries.
              </p>
              <div className="space-y-1.5">
                <label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="reverse-reason">
                  Reason (required)
                </label>
                <Textarea
                  id="reverse-reason"
                  value={reverseReason}
                  onChange={(e) => setReverseReason(e.target.value)}
                  placeholder="e.g. wrong member, duplicate entry, incorrect amount"
                  className="bg-black/40 border-white/10 text-white"
                  data-testid="input-reverse-reason"
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => { setReverseTarget(null); setReverseReason(''); }}
              disabled={reversing}
              className="border-white/10 text-white hover:bg-white/5"
              data-testid="button-reverse-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={submitReverse}
              disabled={reversing || !reverseReason.trim()}
              className="bg-amber-500 hover:bg-amber-600 text-black gap-1.5"
              data-testid="button-reverse-confirm"
            >
              {reversing ? 'Reversing…' : (<><RotateCcw className="w-4 h-4" />Reverse entry</>)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface CohortChoice {
  key: string;
  label: string;
  memberIds: number[];
  description?: string;
  filters?: MemberFilters;
  savedSegmentId?: number;
}

export function BulkAuditDetails({
  orgId, bucket, entity, reason, actorUserId, actionType, memberCount, canReverse, onReversed,
  cohortChoices,
}: {
  orgId: number; bucket: string; entity: string; reason: string | null; actorUserId: number | null;
  actionType: string; memberCount: number; canReverse: boolean; onReversed: () => void;
  cohortChoices: CohortChoice[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [redoOpen, setRedoOpen] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cohortKey, setCohortKey] = useState<string>(cohortChoices[0]?.key ?? '');
  const [saveAsSegment, setSaveAsSegment] = useState(false);
  const [newSegmentName, setNewSegmentName] = useState('');
  useEffect(() => {
    if (!cloneOpen) return;
    if (!cohortChoices.find(c => c.key === cohortKey)) {
      setCohortKey(cohortChoices[0]?.key ?? '');
    }
  }, [cloneOpen, cohortChoices, cohortKey]);
  useEffect(() => {
    if (!cloneOpen) {
      setSaveAsSegment(false);
      setNewSegmentName('');
    }
  }, [cloneOpen]);
  const selectedCohort = cohortChoices.find(c => c.key === cohortKey) ?? null;
  // Only offer "Save as segment" when the chosen cohort isn't already a saved
  // segment — re-saving an existing one would just create a duplicate.
  const canSaveAsSegment = !!selectedCohort && selectedCohort.savedSegmentId == null;
  const [showSkippedList, setShowSkippedList] = useState(false);
  const [showWillChangeList, setShowWillChangeList] = useState(false);
  const redoPreviewQuery = useQuery<{
    willChange: number; alreadyInTargetState: number; affectedMembers: number; originalAction: string;
    skippedMembers?: Array<{ id: number; firstName: string; lastName: string; memberNumber: string | null; email: string | null }>;
    willChangeMembers?: Array<{ id: number; firstName: string; lastName: string; memberNumber: string | null }>;
  }>({
    queryKey: ['bulk-action-redo-preview', orgId, bucket, entity, reason, actorUserId],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/bulk-action/redo/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket, entity, reason, actorUserId, includeMembers: true }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: redoOpen && !!orgId && !!bucket && !!entity,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const reversePreviewQuery = useQuery<{
    willChange: number; alreadyReversed: number; affectedMembers: number; originalAction: string;
  }>({
    queryKey: ['bulk-action-reverse-preview', orgId, bucket, entity, reason, actorUserId],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/bulk-action/reverse/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket, entity, reason, actorUserId }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: confirmOpen && !!orgId && !!bucket && !!entity,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const detailsQuery = useQuery<{ rows: BulkAuditDetailRow[]; truncated: boolean; limit: number }>({
    queryKey: ['bulk-audit-details', orgId, bucket, entity, reason, actorUserId],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('bucket', bucket);
      params.set('entity', entity);
      params.set('reason', reason ?? '');
      if (actorUserId != null) params.set('actorUserId', String(actorUserId));
      const r = await fetch(`/api/organizations/${orgId}/members-360/bulk-audit/details?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId && !!bucket && !!entity,
  });

  const isReverseOfEntry = !!reason && /^bulk reverse-of\b/.test(reason);
  const isRedoOfEntry = !!reason && /^bulk redo-of\b/.test(reason);
  const isDerivativeEntry = isReverseOfEntry || isRedoOfEntry;
  const reversible = canReverse && REVERSIBLE_BULK_ACTIONS.has(actionType) && !isDerivativeEntry;
  const redoable = canReverse && REDOABLE_BULK_ACTIONS.has(actionType) && !isDerivativeEntry;
  const cloneable = redoable && cohortChoices.length > 0;
  const nonReversibleReason: Record<string, string> = {
    message: "Bulk messages can't be unsent — they've already been delivered to members.",
    reinstate: "Bulk reinstate can't be auto-reversed — freeze or suspend the affected members manually if needed.",
  };
  const showNonReversibleNote =
    canReverse && !isDerivativeEntry && !REVERSIBLE_BULK_ACTIONS.has(actionType) && !!nonReversibleReason[actionType];
  const reverseLabel: Record<string, string> = {
    freeze: 'Unfreeze all', suspend: 'Reinstate all',
    tag: 'Remove tag from all', tier_change: 'Restore previous tier for all',
  };
  const redoLabel: Record<string, string> = {
    freeze: 'Re-freeze the same members', suspend: 'Re-suspend the same members',
    tag: 'Re-add the tag to the same members', tier_change: 'Re-apply the tier change to the same members',
  };
  const submitReverse = async () => {
    setReversing(true);
    try {
      // Refresh the preview right before committing so the admin sees (and is
      // submitting against) the freshest cohort numbers, not whatever was
      // cached when the dialog opened.
      await reversePreviewQuery.refetch();
      const r = await fetch(`/api/organizations/${orgId}/members-360/bulk-action/reverse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket, entity, reason, actorUserId }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      toast({
        title: 'Bulk action reversed',
        description: `${data.reversed} reversed${data.skipped ? `, ${data.skipped} skipped` : ''}.`,
      });
      setConfirmOpen(false);
      onReversed();
    } catch (e) {
      toast({ title: 'Reverse failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setReversing(false); }
  };

  const submitClone = async () => {
    if (!selectedCohort) {
      toast({ title: 'Pick a cohort first', variant: 'destructive' });
      return;
    }
    if (selectedCohort.memberIds.length === 0) {
      toast({ title: 'Cohort is empty', description: 'Adjust the filter or pick a different segment.', variant: 'destructive' });
      return;
    }
    if (saveAsSegment && canSaveAsSegment && !newSegmentName.trim()) {
      toast({ title: 'Segment name required', variant: 'destructive' });
      return;
    }
    setCloning(true);
    try {
      // Persist the cohort as a saved segment first so admins can reach it
      // from the segments dropdown next time. We do this before the clone so
      // a clone failure doesn't lose the saved cohort the admin asked for.
      if (saveAsSegment && canSaveAsSegment) {
        const segRes = await fetch(`/api/organizations/${orgId}/members-360/saved-segments`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newSegmentName.trim(),
            description: selectedCohort.description ?? null,
            filters: selectedCohort.filters ?? {},
            isShared: false,
          }),
        });
        if (!segRes.ok) {
          throw new Error((await segRes.json().catch(() => ({}))).error || `Failed to save segment (HTTP ${segRes.status})`);
        }
        await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/members-360/saved-segments`] });
      }
      const r = await fetch(`/api/organizations/${orgId}/members-360/bulk-action/clone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket, entity, reason, actorUserId,
          memberIds: selectedCohort.memberIds,
          cohortLabel: selectedCohort.label,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      toast({
        title: 'Bulk action re-applied to fresh cohort',
        description: `${data.redone} re-applied${data.skipped ? `, ${data.skipped} skipped` : ''} (cohort: ${selectedCohort.label}).`,
      });
      setCloneOpen(false);
      onReversed();
    } catch (e) {
      toast({ title: 'Re-apply failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setCloning(false); }
  };

  const submitRedo = async () => {
    setRedoing(true);
    try {
      // Refresh the preview right before committing so the admin sees (and is
      // submitting against) the freshest cohort numbers, not whatever was
      // cached when the dialog opened.
      await redoPreviewQuery.refetch();
      const r = await fetch(`/api/organizations/${orgId}/members-360/bulk-action/redo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket, entity, reason, actorUserId }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      toast({
        title: 'Bulk action re-applied',
        description: `${data.redone} re-applied${data.skipped ? `, ${data.skipped} skipped` : ''}.`,
      });
      setRedoOpen(false);
      onReversed();
    } catch (e) {
      toast({ title: 'Re-apply failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setRedoing(false); }
  };

  if (detailsQuery.isLoading) {
    return <div className="text-xs text-muted-foreground py-3 text-center" data-testid="bulk-audit-details-loading">Loading affected members…</div>;
  }
  if (detailsQuery.isError) {
    return (
      <div className="text-xs text-red-300 py-3 text-center" data-testid="bulk-audit-details-error">
        Failed to load: {(detailsQuery.error as Error).message}
      </div>
    );
  }
  const rows = detailsQuery.data?.rows ?? [];
  const truncated = detailsQuery.data?.truncated ?? false;
  const limit = detailsQuery.data?.limit ?? 0;
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground py-3 text-center">No member rows found for this bulk action.</div>;
  }
  return (
    <TooltipProvider delayDuration={150}>
      <div className="mt-3 pt-3 border-t border-white/10 space-y-1.5" data-testid="list-bulk-audit-details">
        {(reversible || redoable) && (
          <div className="flex items-center justify-end gap-2 mb-2">
            {redoable && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRedoOpen(true)}
                className="border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 gap-1.5 h-7 text-xs"
                data-testid={`button-bulk-audit-redo-${bucket}`}
              >
                <Repeat className="w-3 h-3" />
                Re-apply to same members
              </Button>
            )}
            {cloneable && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setCloneOpen(true)}
                className="border-sky-500/40 text-sky-300 hover:bg-sky-500/10 gap-1.5 h-7 text-xs"
                data-testid={`button-bulk-audit-clone-${bucket}`}
              >
                <Filter className="w-3 h-3" />
                Re-apply to filtered members
              </Button>
            )}
            {reversible && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirmOpen(true)}
                className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 gap-1.5 h-7 text-xs"
                data-testid={`button-bulk-audit-undo-${bucket}`}
              >
                <RotateCcw className="w-3 h-3" />
                Undo for all
              </Button>
            )}
          </div>
        )}
        {showNonReversibleNote && (
          <div
            className="flex items-start gap-1.5 text-xs text-muted-foreground italic mb-2"
            data-testid={`bulk-audit-not-reversible-${bucket}`}
          >
            <Info className="w-3 h-3 mt-0.5 flex-shrink-0 opacity-70" aria-hidden="true" />
            <span>{nonReversibleReason[actionType]}</span>
          </div>
        )}
        <Dialog open={cloneOpen} onOpenChange={(o) => { if (!cloning) setCloneOpen(o); }}>
          <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md" data-testid="dialog-bulk-clone-confirm">
            <DialogHeader>
              <DialogTitle>Re-apply to a fresh cohort?</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p>
                Replay the original{' '}
                <span className="capitalize font-semibold text-white">{actionType.replace('_', ' ')}</span>{' '}
                action against the cohort you choose below. Members already in the target state are skipped.
              </p>
              <div className="space-y-1.5">
                <label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="clone-cohort">
                  Cohort
                </label>
                <Select value={cohortKey} onValueChange={setCohortKey}>
                  <SelectTrigger id="clone-cohort" className="bg-black/40 border-white/10 text-white" data-testid="select-clone-cohort">
                    <SelectValue placeholder="Pick a cohort" />
                  </SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    {cohortChoices.map(c => (
                      <SelectItem key={c.key} value={c.key} data-testid={`option-clone-cohort-${c.key}`}>
                        {c.label} — {c.memberIds.length.toLocaleString()} member{c.memberIds.length === 1 ? '' : 's'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedCohort?.description && (
                  <p className="text-[11px] text-muted-foreground mt-1">{selectedCohort.description}</p>
                )}
              </div>
              <div
                className="rounded border border-sky-500/30 bg-sky-500/10 px-2.5 py-2 text-xs text-sky-200"
                data-testid="clone-cohort-preview"
              >
                <span className="font-semibold">{(selectedCohort?.memberIds.length ?? 0).toLocaleString()}</span>{' '}
                member{(selectedCohort?.memberIds.length ?? 0) === 1 ? '' : 's'} will be checked
                {selectedCohort ? <> from <span className="font-semibold">{selectedCohort.label}</span></> : null}.
                Each one already in the target state will be skipped.
              </div>
              <div
                className="rounded border border-white/10 bg-black/30 px-2.5 py-2 space-y-2"
                data-testid="clone-save-as-segment"
              >
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="clone-save-as-segment-toggle" className="text-xs text-white">
                    Save this cohort as a segment
                  </label>
                  <Switch
                    id="clone-save-as-segment-toggle"
                    checked={saveAsSegment && canSaveAsSegment}
                    disabled={!canSaveAsSegment}
                    onCheckedChange={(v) => setSaveAsSegment(Boolean(v))}
                    data-testid="switch-clone-save-as-segment"
                  />
                </div>
                {!canSaveAsSegment && selectedCohort?.savedSegmentId != null && (
                  <p className="text-[11px] text-muted-foreground">
                    This cohort is already saved as a segment.
                  </p>
                )}
                {saveAsSegment && canSaveAsSegment && (
                  <Input
                    value={newSegmentName}
                    onChange={(e) => setNewSegmentName(e.target.value)}
                    placeholder="Segment name"
                    className="bg-black/40 border-white/10 text-white h-8 text-xs"
                    data-testid="input-clone-save-as-segment-name"
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                A new bulk-audit entry will be recorded as <code className="bg-black/40 px-1 rounded">bulk redo-of … (filtered)</code>{' '}
                so this re-apply links back to the source bucket and is itself fully audited.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setCloneOpen(false)} disabled={cloning}
                className="border-white/10 text-white hover:bg-white/5" data-testid="button-bulk-clone-cancel">
                Cancel
              </Button>
              <Button
                onClick={submitClone}
                disabled={cloning || !selectedCohort || selectedCohort.memberIds.length === 0}
                className="bg-sky-500 hover:bg-sky-600 text-black gap-1.5"
                data-testid="button-bulk-clone-confirm"
              >
                {cloning ? 'Re-applying…' : (<><Filter className="w-4 h-4" />Re-apply to cohort</>)}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={redoOpen} onOpenChange={(o) => { if (!redoing) setRedoOpen(o); }}>
          <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md" data-testid="dialog-bulk-redo-confirm">
            <DialogHeader>
              <DialogTitle>Re-apply bulk action?</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p>
                This will <span className="font-semibold text-white">{redoLabel[actionType] ?? 're-apply the action'}</span>{' '}
                to the same <span className="font-semibold text-white">{memberCount} member{memberCount !== 1 ? 's' : ''}</span>{' '}
                affected by the original <span className="capitalize">{actionType.replace('_', ' ')}</span> action.
                Members already in the target state are skipped.
              </p>
              <div
                className="rounded border border-emerald-500/20 bg-emerald-500/5 p-2.5 text-xs"
                data-testid={`bulk-redo-preview-${bucket}`}
              >
                <div className="uppercase tracking-wide text-[10px] mb-1 opacity-70 text-emerald-200">
                  Pre-flight preview
                </div>
                {redoPreviewQuery.isLoading ? (
                  <div className="text-muted-foreground" data-testid="bulk-redo-preview-loading">
                    Counting members that will actually change…
                  </div>
                ) : redoPreviewQuery.isError ? (
                  <div className="text-red-300" data-testid="bulk-redo-preview-error">
                    Couldn't compute preview: {(redoPreviewQuery.error as Error).message}
                  </div>
                ) : redoPreviewQuery.data ? (
                  <div className="text-white" data-testid="bulk-redo-preview-counts">
                    <span className="font-semibold text-emerald-300" data-testid="bulk-redo-preview-will-change">
                      {redoPreviewQuery.data.willChange}
                    </span>{' '}
                    will change,{' '}
                    <span className="font-semibold text-muted-foreground" data-testid="bulk-redo-preview-already">
                      {redoPreviewQuery.data.alreadyInTargetState}
                    </span>{' '}
                    already in target state
                    {redoPreviewQuery.data.affectedMembers !== memberCount && (
                      <span className="block mt-1 text-[11px] text-amber-300">
                        Cohort changed: {redoPreviewQuery.data.affectedMembers} member
                        {redoPreviewQuery.data.affectedMembers !== 1 ? 's' : ''} still in this org.
                      </span>
                    )}
                    {redoPreviewQuery.data.willChange > 0 && (
                      <div className="mt-2 border-t border-emerald-500/20 pt-2">
                        <button
                          type="button"
                          onClick={() => setShowWillChangeList(v => !v)}
                          className="flex items-center gap-1 text-[11px] text-emerald-200 hover:text-white"
                          data-testid={`button-bulk-redo-toggle-will-change-${bucket}`}
                          aria-expanded={showWillChangeList}
                        >
                          {showWillChangeList
                            ? <ChevronDown className="w-3 h-3" />
                            : <ChevronRight className="w-3 h-3" />}
                          {showWillChangeList ? 'Hide' : 'Show'} {redoPreviewQuery.data.willChange} member
                          {redoPreviewQuery.data.willChange !== 1 ? 's' : ''} that will change
                        </button>
                        {showWillChangeList && (
                          <div
                            className="mt-2 max-h-48 overflow-y-auto rounded border border-white/10 bg-black/40"
                            data-testid={`bulk-redo-will-change-list-${bucket}`}
                          >
                            {redoPreviewQuery.data.willChangeMembers && redoPreviewQuery.data.willChangeMembers.length > 0 ? (
                              <ul className="divide-y divide-white/5 text-[11px]">
                                {redoPreviewQuery.data.willChangeMembers.map(m => (
                                  <li
                                    key={m.id}
                                    className="px-2 py-1.5 flex items-center justify-between gap-2"
                                    data-testid={`bulk-redo-will-change-row-${m.id}`}
                                  >
                                    <span className="text-white truncate">
                                      {m.firstName} {m.lastName}
                                    </span>
                                    <span className="text-muted-foreground whitespace-nowrap">
                                      {m.memberNumber ?? '—'}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                                No member details available.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {redoPreviewQuery.data.alreadyInTargetState > 0 && (
                      <div className="mt-2 border-t border-emerald-500/20 pt-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() => setShowSkippedList(v => !v)}
                            className="flex items-center gap-1 text-[11px] text-emerald-200 hover:text-white"
                            data-testid={`button-bulk-redo-toggle-skipped-${bucket}`}
                            aria-expanded={showSkippedList}
                          >
                            {showSkippedList
                              ? <ChevronDown className="w-3 h-3" />
                              : <ChevronRight className="w-3 h-3" />}
                            {showSkippedList ? 'Hide' : 'Show'} {redoPreviewQuery.data.alreadyInTargetState} member
                            {redoPreviewQuery.data.alreadyInTargetState !== 1 ? 's' : ''} that will be skipped
                          </button>
                          {redoPreviewQuery.data.skippedMembers && redoPreviewQuery.data.skippedMembers.length > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                const rows = redoPreviewQuery.data!.skippedMembers!;
                                const escape = (v: string | null | undefined) => {
                                  let s = v == null ? '' : String(v);
                                  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
                                  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
                                };
                                const header = ['Name', 'Member Number', 'Email'].join(',');
                                const body = rows
                                  .map(m => [
                                    escape(`${m.firstName} ${m.lastName}`.trim()),
                                    escape(m.memberNumber),
                                    escape(m.email),
                                  ].join(','))
                                  .join('\n');
                                const csv = `${header}\n${body}\n`;
                                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = `redo-skipped-${bucket}-${new Date().toISOString().slice(0, 10)}.csv`;
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                              }}
                              className="flex items-center gap-1 text-[11px] text-emerald-200 hover:text-white border border-emerald-500/30 rounded px-2 py-0.5"
                              data-testid={`button-bulk-redo-download-skipped-${bucket}`}
                            >
                              <Download className="w-3 h-3" />
                              Download CSV
                            </button>
                          )}
                        </div>
                        {showSkippedList && (
                          <div
                            className="mt-2 max-h-48 overflow-y-auto rounded border border-white/10 bg-black/40"
                            data-testid={`bulk-redo-skipped-list-${bucket}`}
                          >
                            {redoPreviewQuery.data.skippedMembers && redoPreviewQuery.data.skippedMembers.length > 0 ? (
                              <ul className="divide-y divide-white/5 text-[11px]">
                                {redoPreviewQuery.data.skippedMembers.map(m => (
                                  <li
                                    key={m.id}
                                    className="px-2 py-1.5 flex items-center justify-between gap-2"
                                    data-testid={`bulk-redo-skipped-row-${m.id}`}
                                  >
                                    <span className="text-white truncate">
                                      {m.firstName} {m.lastName}
                                    </span>
                                    <span className="text-muted-foreground whitespace-nowrap">
                                      {m.memberNumber ?? '—'}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                                No member details available.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
              {reason && (
                <div className="bg-black/40 border border-white/10 rounded p-2 text-xs text-muted-foreground">
                  <div className="uppercase tracking-wide text-[10px] mb-1 opacity-70">Original reason</div>
                  <div className="break-words">{reason}</div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                A new bulk-audit entry will be recorded as <code className="bg-black/40 px-1 rounded">bulk redo-of</code> so this re-apply is itself fully audited.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setRedoOpen(false)} disabled={redoing}
                className="border-white/10 text-white hover:bg-white/5" data-testid="button-bulk-redo-cancel">
                Cancel
              </Button>
              <Button onClick={submitRedo} disabled={redoing}
                className="bg-emerald-500 hover:bg-emerald-600 text-black gap-1.5"
                data-testid="button-bulk-redo-confirm">
                {redoing ? 'Re-applying…' : (<><Repeat className="w-4 h-4" />Re-apply</>)}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={confirmOpen} onOpenChange={(o) => { if (!reversing) setConfirmOpen(o); }}>
          <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md" data-testid="dialog-bulk-undo-confirm">
            <DialogHeader>
              <DialogTitle>Reverse bulk action?</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p>
                This will apply <span className="font-semibold text-white">{reverseLabel[actionType] ?? 'the inverse'}</span>{' '}
                to <span className="font-semibold text-white">{memberCount} member{memberCount !== 1 ? 's' : ''}</span>{' '}
                that were affected by the original <span className="capitalize">{actionType.replace('_', ' ')}</span> action.
                Members already back in the original state are skipped.
              </p>
              <div
                className="rounded border border-amber-500/20 bg-amber-500/5 p-2.5 text-xs"
                data-testid={`bulk-reverse-preview-${bucket}`}
              >
                <div className="uppercase tracking-wide text-[10px] mb-1 opacity-70 text-amber-200">
                  Pre-flight preview
                </div>
                {reversePreviewQuery.isLoading ? (
                  <div className="text-muted-foreground" data-testid="bulk-reverse-preview-loading">
                    Counting members that will actually change…
                  </div>
                ) : reversePreviewQuery.isError ? (
                  <div className="text-red-300" data-testid="bulk-reverse-preview-error">
                    Couldn't compute preview: {(reversePreviewQuery.error as Error).message}
                  </div>
                ) : reversePreviewQuery.data ? (
                  <div className="text-white" data-testid="bulk-reverse-preview-counts">
                    <span className="font-semibold text-amber-300" data-testid="bulk-reverse-preview-will-change">
                      {reversePreviewQuery.data.willChange}
                    </span>{' '}
                    will change,{' '}
                    <span className="font-semibold text-muted-foreground" data-testid="bulk-reverse-preview-already">
                      {reversePreviewQuery.data.alreadyReversed}
                    </span>{' '}
                    already reversed
                    {reversePreviewQuery.data.affectedMembers !== memberCount && (
                      <span className="block mt-1 text-[11px] text-amber-300">
                        Cohort changed: {reversePreviewQuery.data.affectedMembers} member
                        {reversePreviewQuery.data.affectedMembers !== 1 ? 's' : ''} still in this org.
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
              {reason && (
                <div className="bg-black/40 border border-white/10 rounded p-2 text-xs text-muted-foreground">
                  <div className="uppercase tracking-wide text-[10px] mb-1 opacity-70">Original reason</div>
                  <div className="break-words">{reason}</div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                A new bulk-audit entry will be recorded as <code className="bg-black/40 px-1 rounded">bulk reverse-of</code> so this reversal is itself fully audited.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={reversing}
                className="border-white/10 text-white hover:bg-white/5" data-testid="button-bulk-undo-cancel">
                Cancel
              </Button>
              <Button onClick={submitReverse} disabled={reversing}
                className="bg-amber-500 hover:bg-amber-600 text-black gap-1.5"
                data-testid="button-bulk-undo-confirm">
                {reversing ? 'Reversing…' : (<><RotateCcw className="w-4 h-4" />Reverse it</>)}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {truncated && (
          <div
            className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5 mb-2"
            data-testid="bulk-audit-details-truncated"
          >
            Showing the first {limit.toLocaleString()} affected members. The full list is larger — export bulk-action history for the complete record.
          </div>
        )}
        {rows.map(r => {
          const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.email || `Member #${r.clubMemberId ?? '?'}`;
          return (
            <div key={r.auditId} className="flex items-center justify-between gap-3 text-xs" data-testid={`bulk-audit-detail-row-${r.auditId}`}>
              <div className="flex-1 min-w-0 truncate">
                {r.clubMemberId != null ? (
                  <Link
                    href={`/member-360/${r.clubMemberId}`}
                    className="text-primary hover:underline inline-flex items-center gap-1"
                    data-testid={`link-member-360-${r.clubMemberId}`}
                  >
                    <ExternalLink className="w-3 h-3" />
                    {name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{name}</span>
                )}
                {r.email && <span className="text-muted-foreground ml-2 opacity-70">{r.email}</span>}
              </div>
              <BulkAuditChangeSummary row={r} />
              <span className="text-muted-foreground capitalize whitespace-nowrap">{r.action}</span>
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

const TRUNCATE_AT = 32;

function fmtVal(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function TruncatedValue({ value, testId }: { value: string; testId?: string }) {
  if (value.length <= TRUNCATE_AT) {
    return <span data-testid={testId}>{value}</span>;
  }
  const short = `${value.slice(0, TRUNCATE_AT - 1)}…`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-2" data-testid={testId}>
          {short}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-words">{value}</TooltipContent>
    </Tooltip>
  );
}

function BulkAuditChangeSummary({ row }: { row: BulkAuditDetailRow }) {
  // Render the most relevant per-member change inline. Audit rows written
  // before fieldChanges was populated get an em-dash placeholder.
  const fc = row.fieldChanges ?? null;
  const testId = `bulk-audit-detail-change-${row.auditId}`;

  // Lifecycle entries: show the new status (e.g. "→ frozen")
  if (fc && 'lifecycleStatus' in fc) {
    const to = fmtVal(fc.lifecycleStatus.to);
    return (
      <span className="text-xs text-emerald-300 whitespace-nowrap font-medium" data-testid={testId}>
        → <TruncatedValue value={to} />
      </span>
    );
  }
  // Tag entries: show the tag value
  if (fc && 'tag' in fc) {
    const to = fmtVal(fc.tag.to);
    return (
      <span className="text-xs text-sky-300 whitespace-nowrap" data-testid={testId}>
        + <TruncatedValue value={to} />
      </span>
    );
  }
  // Tier entries: show "from → to" tier names
  if (fc && 'tier' in fc) {
    const from = fmtVal(fc.tier.from);
    const to = fmtVal(fc.tier.to);
    return (
      <span className="text-xs text-amber-300 whitespace-nowrap" data-testid={testId}>
        <TruncatedValue value={from} /> → <TruncatedValue value={to} />
      </span>
    );
  }
  // Generic fallback: show the first changed field as "key: from → to"
  if (fc) {
    const keys = Object.keys(fc);
    if (keys.length > 0) {
      const k = keys[0];
      const from = fmtVal(fc[k].from);
      const to = fmtVal(fc[k].to);
      return (
        <span className="text-xs text-muted-foreground whitespace-nowrap" data-testid={testId}>
          {k}: <TruncatedValue value={from} /> → <TruncatedValue value={to} />
        </span>
      );
    }
  }
  // Legacy audit rows (pre-fieldChanges) just show an em-dash here; the
  // surrounding row still links through to Member 360 for full context.
  return <span className="text-xs text-muted-foreground/60 whitespace-nowrap" data-testid={testId}>—</span>;
}

export default function ClubMembersPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;
  const currentUserId = user?.id;

  // Pre-fetch which users the current viewer already follows so the button
  // hydrates as "Following" instead of flashing "Follow" first (Task #1227).
  const followeeIds = useFolloweeIds();

  const [filters, setFilters] = useState<MemberFilters>({});
  const search = filters.search ?? '';
  const setSearch = (v: string) => { setFilters(f => ({ ...f, search: v })); setActiveSegmentId(null); };
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null);
  const [saveSegmentOpen, setSaveSegmentOpen] = useState(false);
  const [renameSegment, setRenameSegment] = useState<{ id: number; name: string; description: string; isShared: boolean } | null>(null);
  const [renameSegmentSubmitting, setRenameSegmentSubmitting] = useState(false);
  const [segmentForm, setSegmentForm] = useState({ name: '', description: '', isShared: false });
  const [bulkActionType, setBulkActionType] = useState<null | 'freeze' | 'suspend' | 'reinstate' | 'tag' | 'message' | 'tier_change'>(null);
  const [bulkAuditOpen, setBulkAuditOpen] = useState(false);
  const [bulkAuditFilters, setBulkAuditFilters] = useState<{ from: string; to: string; action: string }>({ from: '', to: '', action: '__any' });
  const [expandedBulkAuditKey, setExpandedBulkAuditKey] = useState<string | null>(null);
  const [expandedClonesKeys, setExpandedClonesKeys] = useState<Set<string>>(new Set());
  const [bulkPayload, setBulkPayload] = useState<{ reason?: string; tag?: string; subject?: string; body?: string; channel?: string; tierId?: string }>({});
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [createLevyOpen, setCreateLevyOpen] = useState(false);
  const [levyForm, setLevyForm] = useState({ name: '', description: '', amount: '', currency: 'INR', scope: 'all' as 'all' | 'tier' | 'manual', tierIds: [] as number[], dueDate: '' });
  const [applyingLevyId, setApplyingLevyId] = useState<number | null>(null);
  const [openLevyId, setOpenLevyId] = useState<number | null>(null);
  // When deep-linked from Member 360 (Task #243) the URL also carries
  // `highlightMember=<id>` so the levy detail dialog can call out the row that
  // triggered the navigation. The highlight clears after a few seconds so it
  // doesn't permanently style the row.
  const [highlightMemberId, setHighlightMemberId] = useState<number | null>(null);
  // Charge id we should auto-focus once the levy detail dialog has loaded
  // (Task #236: deep-link from the Member 360 audit log straight to the
  // per-charge Activity timeline so admins can reverse the entry there).
  const [pendingFocusChargeId, setPendingFocusChargeId] = useState<number | null>(null);
  // If the dashboard banner (Task #213) or Member 360 (Tasks #236/#243)
  // deep-links here with ?openLevy=<id> (and optionally &openCharge=<id>
  // and/or &highlightMember=<id>), open that levy's detail dialog
  // automatically and strip the params so a refresh doesn't keep reopening it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('openLevy');
    const rawCharge = params.get('openCharge');
    const hm = params.get('highlightMember');
    // Task #1805: deep-links from the forecast accuracy email schedule's
    // "missing email" hint pass `?search=<displayName|username>` so admins
    // land directly on the affected member's row to fill in an email.
    const searchParam = params.get('search');
    if (!raw && !rawCharge && !hm && !searchParam) return;
    if (raw) {
      const id = parseInt(raw, 10);
      if (Number.isFinite(id)) setOpenLevyId(id);
    }
    if (rawCharge) {
      const cid = parseInt(rawCharge, 10);
      if (Number.isFinite(cid)) setPendingFocusChargeId(cid);
    }
    if (hm) {
      const hmId = parseInt(hm, 10);
      if (Number.isFinite(hmId)) setHighlightMemberId(hmId);
    }
    if (searchParam) {
      setFilters(f => ({ ...f, search: searchParam }));
    }
    params.delete('openLevy');
    params.delete('openCharge');
    params.delete('highlightMember');
    params.delete('search');
    const newSearch = params.toString();
    const url = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
    window.history.replaceState(null, '', url);
  }, []);
  // Clear the highlight after a short window so it doesn't stay styled forever.
  useEffect(() => {
    if (highlightMemberId == null) return;
    const t = setTimeout(() => setHighlightMemberId(null), 6000);
    return () => clearTimeout(t);
  }, [highlightMemberId]);
  const [payingChargeId, setPayingChargeId] = useState<number | null>(null);
  const [resendReceiptChargeId, setResendReceiptChargeId] = useState<number | null>(null);
  const [chargeAction, setChargeAction] = useState<{
    charge: LevyCharge;
    kind: 'payment' | 'refund' | 'waive';
  } | null>(null);
  const [chargeActionForm, setChargeActionForm] = useState<{ amount: string; reason: string; note: string; method: string; processorReference: string }>({ amount: '', reason: '', note: '', method: '', processorReference: '' });
  const [chargeActionSubmitting, setChargeActionSubmitting] = useState(false);
  const [activityChargeId, setActivityChargeId] = useState<number | null>(null);
  const [reminderHistoryOpen, setReminderHistoryOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminderForm, setReminderForm] = useState<{ channel: string; subject: string; body: string }>({ channel: 'in_app', subject: '', body: '' });
  const [reminderSending, setReminderSending] = useState(false);
  const [exportLedgerOpen, setExportLedgerOpen] = useState(false);
  const [exportLedgerForm, setExportLedgerForm] = useState<{ from: string; to: string; type: 'all' | 'payment' | 'refund' | 'waive'; notes: string }>({ from: '', to: '', type: 'all', notes: '' });
  const [emailLedgerRecipients, setEmailLedgerRecipients] = useState('');
  const [emailLedgerMessage, setEmailLedgerMessage] = useState('');
  const [emailLedgerSending, setEmailLedgerSending] = useState(false);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [bulkResendingReceipts, setBulkResendingReceipts] = useState(false);
  // Pre-flight preview dialog for bulk receipt resend (Task #293).
  // `selectedChargeIds === null` means "use the preview's defaults" (sendable
  // rows pre-checked, predicted skips/invalid rows unchecked); once the admin
  // toggles a row we materialise the explicit set so further refetches don't
  // wipe their choices.
  const [bulkResendPreviewOpen, setBulkResendPreviewOpen] = useState(false);
  const [bulkResendSelected, setBulkResendSelected] = useState<Set<number> | null>(null);
  // Results dialog (Task #508): we keep the full per-channel breakdown the
  // server returns from POST .../resend-failed-receipts so admins can see
  // which channel (email/push/SMS/WhatsApp) succeeded or failed for each
  // member without drilling into the per-charge receipts history.
  const [bulkResendResult, setBulkResendResult] = useState<BulkResendReceiptsResult | null>(null);
  const [bulkResendResultOpen, setBulkResendResultOpen] = useState(false);
  const bulkResendPreviewQuery = useQuery<BulkResendReceiptsPreviewResponse>({
    queryKey: [`/api/organizations/${orgId}/members-360/levies/${openLevyId}/resend-failed-receipts/preview`],
    queryFn: () => fetch(`/api/organizations/${orgId}/members-360/levies/${openLevyId}/resend-failed-receipts/preview`).then(async r => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    }),
    enabled: !!orgId && !!openLevyId && bulkResendPreviewOpen,
    staleTime: 0,
  });
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [addTierOpen, setAddTierOpen] = useState(false);
  const [memberForm, setMemberForm] = useState({ firstName: '', lastName: '', email: '', phone: '', tierId: '', handicapIndex: '', whsGhinNumber: '' });
  const [tierForm, setTierForm] = useState({ name: '', description: '', annualFee: '', currency: 'INR', gracePeriodDays: '14' });
  const [saving, setSaving] = useState(false);
  const [bulkSending, setBulkSending] = useState(false);
  const [sendingInviteId, setSendingInviteId] = useState<number | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkInviteSending, setBulkInviteSending] = useState(false);
  const [chargesMemberId, setChargesMemberId] = useState<number | null>(null);
  const [chargesMemberName, setChargesMemberName] = useState('');
  const [settleNote, setSettleNote] = useState('');
  const [editMemberId, setEditMemberId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', tierId: '', handicapIndex: '', whsGhinNumber: '',
    renewalDate: '', subscriptionStatus: 'pending', showInDirectory: true,
  });

  const { data: tiers = [] } = useQuery<MembershipTier[]>({
    queryKey: [`/api/organizations/${orgId}/membership-tiers`],
    queryFn: () => fetch(`/api/organizations/${orgId}/membership-tiers`).then(r => { if (!r.ok) throw new Error('Failed to load tiers'); return r.json(); }),
    enabled: !!orgId,
  });

  const { data: rawMembers, isLoading } = useQuery<ClubMember[]>({
    queryKey: [`/api/organizations/${orgId}/membership-tiers/members`],
    queryFn: () => fetch(`/api/organizations/${orgId}/club-members/members`).then(r => { if (!r.ok) throw new Error('Failed to load members'); return r.json(); }),
    enabled: !!orgId,
  });
  const members: ClubMember[] = Array.isArray(rawMembers) ? rawMembers : [];

  const { data: practiceAdminData = [] } = useQuery<{ userId: number; sessionCount: number; roundCount: number }[]>({
    queryKey: [`/api/organizations/${orgId}/practice/admin`],
    queryFn: () => fetch(`/api/organizations/${orgId}/practice/admin`).then(r => r.ok ? r.json() : []),
    enabled: !!orgId,
  });
  const activityByUserId = new Map(practiceAdminData.map(p => [p.userId, { sessions: p.sessionCount, rounds: p.roundCount }]));

  const chargesQuery = useQuery<{ charges: MemberAccountCharge[]; outstandingBalance: number }>({
    queryKey: ['pos-member-charges', orgId, chargesMemberId],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/pos/member-charges/${chargesMemberId}`);
      if (!r.ok) throw new Error('Failed to load charges');
      return r.json();
    },
    enabled: !!orgId && !!chargesMemberId,
  });

  const settleAllMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/pos/member-charges/settle-all/${chargesMemberId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: settleNote || 'Month-end settlement' }),
      });
      if (!r.ok) throw new Error('Failed to settle charges');
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'All charges settled' });
      chargesQuery.refetch();
      setSettleNote('');
    },
    onError: (e: Error) => {
      toast({ title: 'Settlement failed', description: e.message, variant: 'destructive' });
    },
  });

  const { data: savedSegments = [] } = useQuery<SavedSegment[]>({
    queryKey: [`/api/organizations/${orgId}/members-360/saved-segments`],
    queryFn: () => fetch(`/api/organizations/${orgId}/members-360/saved-segments`).then(r => r.ok ? r.json() : []),
    enabled: !!orgId,
  });

  interface BulkAuditEntry {
    bucket: string;
    actorUserId: number | null;
    actorName: string | null;
    actorRole: string | null;
    reason: string | null;
    entity: string;
    actionType: string;
    memberCount: number;
    firstAt: string;
    lastAt: string;
    sourceBucket: string | null;
  }

  const bulkAuditQuery = useQuery<BulkAuditEntry[]>({
    queryKey: [`/api/organizations/${orgId}/members-360/bulk-audit`, bulkAuditFilters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (bulkAuditFilters.from) params.set('from', new Date(bulkAuditFilters.from).toISOString());
      if (bulkAuditFilters.to) {
        const d = new Date(bulkAuditFilters.to); d.setHours(23, 59, 59, 999);
        params.set('to', d.toISOString());
      }
      if (bulkAuditFilters.action && bulkAuditFilters.action !== '__any') params.set('action', bulkAuditFilters.action);
      const r = await fetch(`/api/organizations/${orgId}/members-360/bulk-audit?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId && bulkAuditOpen,
  });

  const { data: levies = [] } = useQuery<MemberLevy[]>({
    queryKey: [`/api/organizations/${orgId}/members-360/levies`],
    queryFn: () => fetch(`/api/organizations/${orgId}/members-360/levies`).then(r => r.ok ? r.json() : []),
    enabled: !!orgId,
  });

  const levyDetailQuery = useQuery<LevyDetailResponse>({
    queryKey: [`/api/organizations/${orgId}/members-360/levies/${openLevyId}/charges`],
    queryFn: () => fetch(`/api/organizations/${orgId}/members-360/levies/${openLevyId}/charges`).then(r => {
      if (!r.ok) throw new Error('Failed to load levy charges'); return r.json();
    }),
    enabled: !!orgId && !!openLevyId,
  });

  // Task #236: once the deep-linked levy detail finishes loading, expand the
  // requested charge's Activity timeline and scroll it into view so the admin
  // lands directly on the entry they wanted to reverse.
  useEffect(() => {
    if (pendingFocusChargeId == null) return;
    const charges = levyDetailQuery.data?.charges;
    if (!charges) return;
    const match = charges.find(c => c.id === pendingFocusChargeId);
    if (!match) {
      // Charge not in this levy (stale link / cross-levy id) — give up silently.
      setPendingFocusChargeId(null);
      return;
    }
    setActivityChargeId(pendingFocusChargeId);
    const cid = pendingFocusChargeId;
    setPendingFocusChargeId(null);
    // Wait one paint so the activity row is mounted before scrolling.
    requestAnimationFrame(() => {
      const el = document.getElementById(`levy-charge-row-${cid}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-amber-400/60');
        window.setTimeout(() => {
          el.classList.remove('ring-2', 'ring-amber-400/60');
        }, 2400);
      }
    });
  }, [pendingFocusChargeId, levyDetailQuery.data?.charges]);

  const markChargePaid = async (memberId: number, chargeId: number) => {
    setPayingChargeId(chargeId);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/members-360/levies/${openLevyId}/charges/${memberId}/pay`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      toast({ title: 'Charge marked as paid' });
      levyDetailQuery.refetch();
    } catch (e) {
      toast({ title: 'Failed to mark paid', description: (e as Error).message, variant: 'destructive' });
    } finally { setPayingChargeId(null); }
  };

  const openChargeAction = (charge: LevyCharge, kind: 'payment' | 'refund' | 'waive') => {
    const amt = parseFloat(charge.amount);
    const paid = parseFloat(charge.paidAmount || '0');
    const refunded = parseFloat(charge.refundedAmount || '0');
    const remaining = Math.max(0, +(amt - paid - refunded).toFixed(2));
    const refundable = Math.max(0, +(paid - refunded).toFixed(2));
    setChargeAction({ charge, kind });
    setChargeActionForm({
      amount: kind === 'payment' ? remaining.toString() : kind === 'refund' ? refundable.toString() : '',
      reason: '',
      note: '',
      method: '',
      processorReference: '',
    });
  };

  const submitChargeAction = async () => {
    if (!chargeAction || !openLevyId) return;
    const { charge, kind } = chargeAction;
    const orgPath = `${BASE}/api/organizations/${orgId}/members-360/levies/${openLevyId}/charges/${charge.clubMemberId}`;
    let url = '', body: Record<string, unknown> = {};
    if (kind === 'payment') {
      const amount = parseFloat(chargeActionForm.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        toast({ title: 'Enter a valid payment amount', variant: 'destructive' }); return;
      }
      url = `${orgPath}/payment`;
      body = {
        amount,
        note: chargeActionForm.note || undefined,
        method: chargeActionForm.method || undefined,
        processorReference: chargeActionForm.processorReference || undefined,
      };
    } else if (kind === 'refund') {
      const amount = parseFloat(chargeActionForm.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        toast({ title: 'Enter a valid refund amount', variant: 'destructive' }); return;
      }
      if (!chargeActionForm.reason.trim()) {
        toast({ title: 'Reason is required for refunds', variant: 'destructive' }); return;
      }
      url = `${orgPath}/refund`;
      body = {
        amount,
        reason: chargeActionForm.reason.trim(),
        method: chargeActionForm.method || undefined,
        processorReference: chargeActionForm.processorReference || undefined,
      };
    } else {
      if (!chargeActionForm.reason.trim()) {
        toast({ title: 'Reason is required to waive a charge', variant: 'destructive' }); return;
      }
      url = `${orgPath}/waive`;
      body = { reason: chargeActionForm.reason.trim() };
    }
    setChargeActionSubmitting(true);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Request failed');
      toast({
        title: kind === 'payment' ? 'Payment recorded' : kind === 'refund' ? 'Refund recorded' : 'Charge waived',
      });
      setChargeAction(null);
      levyDetailQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ['levy-charge-receipts', orgId, openLevyId, chargeAction.charge.clubMemberId] });
      queryClient.invalidateQueries({ queryKey: ['levy-charge-events', orgId, openLevyId, chargeAction.charge.clubMemberId] });
    } catch (e) {
      toast({ title: 'Action failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setChargeActionSubmitting(false); }
  };

  const resendLevyReceipt = async (charge: LevyCharge) => {
    if (!openLevyId) return;
    setResendReceiptChargeId(charge.id);
    try {
      const r = await fetch(
        `${BASE}/api/organizations/${orgId}/members-360/levies/${openLevyId}/charges/${charge.clubMemberId}/resend-receipt`,
        { method: 'POST' },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Failed to resend receipt');
      const status = data.receipt?.status as 'sent' | 'skipped' | 'failed' | undefined;
      if (status === 'sent') {
        toast({ title: 'Receipt resent', description: charge.email ?? 'Email delivered to provider.' });
      } else if (status === 'skipped') {
        toast({
          title: 'Receipt skipped',
          description: data.receipt?.reason === 'no_email'
            ? 'Member has no email on file.'
            : 'Member has opted out of billing emails.',
          variant: 'destructive',
        });
      } else {
        toast({ title: 'Receipt failed', description: data.receipt?.reason ?? 'Mailer error.', variant: 'destructive' });
      }
      levyDetailQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ['levy-charge-receipts', orgId, openLevyId, charge.clubMemberId] });
    } catch (e) {
      toast({ title: 'Resend failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setResendReceiptChargeId(null); }
  };

  // Pre-flight preview now front-loads the bulk action (Task #293): instead
  // of firing a confirm() and POSTing the entire failed/skipped set, opening
  // the dialog triggers the preview query which classifies each charge as
  // sendable / will_skip_no_email / will_skip_opted_out / invalid. The admin
  // then deselects rows or fixes contact info before submitting.
  const openBulkResendPreview = () => {
    if (!openLevyId) return;
    const s = levyDetailQuery.data?.summary;
    const target = (s?.failedReceiptCount ?? 0) + (s?.skippedReceiptCount ?? 0);
    if (!target) return;
    setBulkResendSelected(null);
    setBulkResendPreviewOpen(true);
  };

  const bulkResendDefaultSelectedIds = (rows: BulkResendReceiptsPreviewRow[]): Set<number> =>
    new Set(rows.filter(r => r.predictedOutcome === 'sendable').map(r => r.chargeId));

  const bulkResendEffectiveSelected = (): Set<number> => {
    if (bulkResendSelected) return bulkResendSelected;
    return bulkResendDefaultSelectedIds(bulkResendPreviewQuery.data?.rows ?? []);
  };

  const toggleBulkResendRow = (chargeId: number) => {
    const current = new Set(bulkResendEffectiveSelected());
    if (current.has(chargeId)) current.delete(chargeId);
    else current.add(chargeId);
    setBulkResendSelected(current);
  };

  const setBulkResendAll = (rows: BulkResendReceiptsPreviewRow[], on: boolean) => {
    setBulkResendSelected(on ? new Set(rows.map(r => r.chargeId)) : new Set());
  };

  const submitBulkResendSelected = async () => {
    if (!openLevyId) return;
    const selected = bulkResendEffectiveSelected();
    const previewRows = bulkResendPreviewQuery.data?.rows ?? [];
    const chargeIds = previewRows.map(r => r.chargeId).filter(id => selected.has(id));
    if (chargeIds.length === 0) {
      toast({ title: 'Nothing to resend', description: 'Select at least one row to proceed.', variant: 'destructive' });
      return;
    }
    setBulkResendingReceipts(true);
    try {
      const r = await fetch(
        `${BASE}/api/organizations/${orgId}/members-360/levies/${openLevyId}/resend-failed-receipts`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chargeIds }),
        },
      );
      const data = await r.json().catch(() => ({} as Partial<BulkResendReceiptsResult> & { error?: string })) as BulkResendReceiptsResult & { error?: string };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const deselected = previewRows.length - chargeIds.length;
      const parts = [`${data.sent} sent`];
      if (data.skipped) parts.push(`${data.skipped} skipped`);
      if (data.failed) parts.push(`${data.failed} failed`);
      if (deselected > 0) parts.push(`${deselected} deselected`);
      toast({
        title: `Resend complete: ${data.attempted} attempted`,
        description: parts.join(' · '),
        variant: data.failed > 0 ? 'destructive' : undefined,
      });
      // Surface the per-channel breakdown in a dedicated results dialog so
      // admins can see which channel succeeded/failed for each member at a
      // glance (Task #508). The pre-flight dialog is closed first so the
      // results dialog isn't stacked on top of it.
      setBulkResendPreviewOpen(false);
      setBulkResendSelected(null);
      setBulkResendResult(data);
      setBulkResendResultOpen(true);
      levyDetailQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ['levy-charge-receipts', orgId, openLevyId] });
    } catch (e) {
      toast({ title: 'Bulk resend failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setBulkResendingReceipts(false); }
  };

  const sendLevyReminder = async () => {
    if (!openLevyId) return;
    setReminderSending(true);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/members-360/levies/${openLevyId}/remind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: reminderForm.channel,
          subject: reminderForm.subject || undefined,
          body: reminderForm.body || undefined,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      const data = await r.json() as { sentCount: number; failedCount: number; skippedCount?: number };
      const skipped = data.skippedCount ?? 0;
      const parts = [`${data.sentCount} sent`];
      if (data.failedCount > 0 || skipped > 0) parts.push(`${data.failedCount} failed`);
      if (skipped > 0) parts.push(`${skipped} skipped (opted out)`);
      toast({ title: 'Reminders sent', description: parts.join(', ') });
      setReminderOpen(false);
      setReminderForm({ channel: 'in_app', subject: '', body: '' });
    } catch (e) {
      toast({ title: 'Failed to send reminders', description: (e as Error).message, variant: 'destructive' });
    } finally { setReminderSending(false); }
  };

  const retryFailedReminders = async () => {
    if (!openLevyId) return;
    setRetryingFailed(true);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/members-360/levies/${openLevyId}/retry-failed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Failed');
      const data = await r.json() as { retriedCount: number; sentCount: number; failedCount: number; skippedCount?: number; lastFailureReason?: string };
      if (data.retriedCount === 0) {
        toast({ title: 'No failed reminders to retry' });
      } else {
        const parts = [`${data.sentCount} sent`, `${data.failedCount} still failing`];
        if ((data.skippedCount ?? 0) > 0) parts.push(`${data.skippedCount} skipped (opted out)`);
        const desc = `${parts.join(', ')}${data.lastFailureReason ? ` — ${data.lastFailureReason}` : ''}`;
        toast({
          title: data.failedCount === 0 ? 'Reminders retried' : 'Some retries still failing',
          description: desc,
          variant: data.failedCount === 0 ? 'default' : 'destructive',
        });
      }
      levyDetailQuery.refetch();
    } catch (e) {
      toast({ title: 'Retry failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setRetryingFailed(false); }
  };

  const matchesFilters = (m: ClubMember, f: MemberFilters): boolean => {
    const q = (f.search ?? '').toLowerCase();
    if (q && !`${m.firstName} ${m.lastName} ${m.email ?? ''}`.toLowerCase().includes(q)) return false;
    if (f.status && m.subscriptionStatus !== f.status) return false;
    if (f.tierId != null && m.tierId !== f.tierId) return false;
    if (f.hasPortal === 'yes' && m.userId == null) return false;
    if (f.hasPortal === 'no' && m.userId != null) return false;
    if (f.hasEmail === 'yes' && !m.email) return false;
    if (f.hasEmail === 'no' && m.email) return false;
    return true;
  };
  const filtered = members.filter(m => matchesFilters(m, filters));

  // Cohort options for "Re-apply to filtered members" (Task #233): the live
  // filtered list plus every saved segment, each pre-resolved to memberIds so
  // the picker can show an accurate preview count before confirmation.
  const describeFilters = (f: MemberFilters): string => {
    const parts: string[] = [];
    if (f.search) parts.push(`search "${f.search}"`);
    if (f.status) parts.push(`status=${f.status}`);
    if (f.tierId != null) {
      const t = tiers.find(tt => tt.id === f.tierId);
      parts.push(`tier=${t?.name ?? f.tierId}`);
    }
    if (f.hasPortal) parts.push(`portal=${f.hasPortal}`);
    if (f.hasEmail) parts.push(`email=${f.hasEmail}`);
    return parts.length ? parts.join(', ') : 'no filters (all members)';
  };
  const cohortChoices: CohortChoice[] = [
    {
      key: 'current-filter',
      label: 'Current filter',
      memberIds: filtered.map(m => m.id),
      description: describeFilters(filters),
      filters,
    },
    ...savedSegments.map(s => ({
      key: `segment-${s.id}`,
      label: `Segment: ${s.name}`,
      memberIds: members.filter(m => matchesFilters(m, s.filters ?? {})).map(m => m.id),
      description: s.description ?? describeFilters(s.filters ?? {}),
      filters: s.filters ?? {},
      savedSegmentId: s.id,
    })),
  ];

  const applySegment = (id: number) => {
    const seg = savedSegments.find(s => s.id === id);
    if (!seg) return;
    setFilters(seg.filters ?? {});
    setActiveSegmentId(id);
    toast({ title: `Loaded segment: ${seg.name}` });
  };

  const clearFilters = () => { setFilters({}); setActiveSegmentId(null); };

  const saveSegment = async () => {
    if (!segmentForm.name.trim()) { toast({ title: 'Segment name required', variant: 'destructive' }); return; }
    try {
      const res = await fetch(`/api/organizations/${orgId}/members-360/saved-segments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: segmentForm.name, description: segmentForm.description || null, filters, isShared: segmentForm.isShared }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/members-360/saved-segments`] });
      setSaveSegmentOpen(false);
      setSegmentForm({ name: '', description: '', isShared: false });
      toast({ title: 'Segment saved' });
    } catch (e) {
      toast({ title: 'Failed to save segment', description: (e as Error).message, variant: 'destructive' });
    }
  };

  const submitRenameSegment = async () => {
    if (!renameSegment) return;
    const trimmed = renameSegment.name.trim();
    if (!trimmed) { toast({ title: 'Segment name required', variant: 'destructive' }); return; }
    const trimmedDesc = renameSegment.description.trim();
    setRenameSegmentSubmitting(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members-360/saved-segments/${renameSegment.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, description: trimmedDesc ? trimmedDesc : null, isShared: renameSegment.isShared }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Save failed');
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/members-360/saved-segments`] });
      setRenameSegment(null);
      toast({ title: 'Segment updated' });
    } catch (e) {
      toast({ title: 'Failed to update segment', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setRenameSegmentSubmitting(false);
    }
  };

  const deleteSegment = async (id: number) => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/members-360/saved-segments/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      if (activeSegmentId === id) setActiveSegmentId(null);
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/members-360/saved-segments`] });
      toast({ title: 'Segment deleted' });
    } catch (e) {
      toast({ title: 'Failed to delete segment', description: (e as Error).message, variant: 'destructive' });
    }
  };

  const openBulkAction = (type: NonNullable<typeof bulkActionType>) => {
    setBulkPayload({ channel: 'in_app' });
    setBulkActionType(type);
  };

  const submitBulkAction = async () => {
    if (!bulkActionType) return;
    const memberIds = Array.from(selectedIds);
    if (memberIds.length === 0) { toast({ title: 'Select members first', variant: 'destructive' }); return; }
    let payload: Record<string, unknown> | undefined;
    if (bulkActionType === 'freeze' || bulkActionType === 'suspend' || bulkActionType === 'reinstate') {
      payload = bulkPayload.reason ? { reason: bulkPayload.reason } : undefined;
    } else if (bulkActionType === 'tag') {
      if (!bulkPayload.tag?.trim()) { toast({ title: 'Tag required', variant: 'destructive' }); return; }
      payload = { tag: bulkPayload.tag.trim() };
    } else if (bulkActionType === 'message') {
      if (!bulkPayload.body?.trim()) { toast({ title: 'Message body required', variant: 'destructive' }); return; }
      payload = { body: bulkPayload.body, subject: bulkPayload.subject, channel: bulkPayload.channel ?? 'in_app' };
    } else if (bulkActionType === 'tier_change') {
      if (!bulkPayload.tierId) { toast({ title: 'Select a tier', variant: 'destructive' }); return; }
      payload = { tierId: parseInt(bulkPayload.tierId) };
    }
    setBulkSubmitting(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members-360/bulk-action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberIds, action: bulkActionType, payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk action failed');
      toast({ title: `${bulkActionType.replace('_', ' ')} applied`, description: `Processed ${data.processed}${data.skipped ? `, skipped ${data.skipped}` : ''}` });
      setBulkActionType(null);
      setBulkPayload({});
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers/members`] });
    } catch (e) {
      toast({ title: 'Bulk action failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setBulkSubmitting(false); }
  };

  const createLevy = async () => {
    if (!levyForm.name.trim() || !levyForm.amount) { toast({ title: 'Name and amount required', variant: 'destructive' }); return; }
    if (levyForm.scope === 'tier' && levyForm.tierIds.length === 0) {
      toast({ title: 'Pick at least one tier', variant: 'destructive' }); return;
    }
    if (levyForm.scope === 'manual' && selectedIds.size === 0) {
      toast({ title: 'Select members in the Members tab first', variant: 'destructive' }); return;
    }
    try {
      const body: Record<string, unknown> = {
        name: levyForm.name, description: levyForm.description || null,
        amount: levyForm.amount, currency: levyForm.currency, scope: levyForm.scope,
        dueDate: levyForm.dueDate || null,
      };
      if (levyForm.scope === 'tier') body.scopeFilter = { tierIds: levyForm.tierIds };
      else if (levyForm.scope === 'manual') body.scopeFilter = { memberIds: Array.from(selectedIds) };
      const res = await fetch(`/api/organizations/${orgId}/members-360/levies`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create levy');
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/members-360/levies`] });
      setCreateLevyOpen(false);
      setLevyForm({ name: '', description: '', amount: '', currency: 'INR', scope: 'all', tierIds: [], dueDate: '' });
      toast({ title: 'Levy created' });
    } catch (e) {
      toast({ title: 'Failed to create levy', description: (e as Error).message, variant: 'destructive' });
    }
  };

  const applyLevy = async (id: number) => {
    setApplyingLevyId(id);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members-360/levies/${id}/apply`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to apply levy');
      toast({ title: 'Levy applied', description: `Applied to ${data.appliedToCount} members` });
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/members-360/levies`] });
    } catch (e) {
      toast({ title: 'Failed to apply levy', description: (e as Error).message, variant: 'destructive' });
    } finally { setApplyingLevyId(null); }
  };

  const filterCount = [filters.status, filters.tierId, filters.hasPortal, filters.hasEmail].filter(v => v != null && v !== '').length;

  const saveMember = async () => {
    if (!memberForm.firstName || !memberForm.lastName) {
      toast({ title: 'First and last name are required', variant: 'destructive' }); return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/club-members/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...memberForm, tierId: memberForm.tierId ? parseInt(memberForm.tierId) : undefined }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers/members`] });
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers`] });
      setAddMemberOpen(false);
      setMemberForm({ firstName: '', lastName: '', email: '', phone: '', tierId: '', handicapIndex: '', whsGhinNumber: '' });
      toast({ title: 'Member added successfully' });
    } catch (e) {
      toast({ title: 'Failed to add member', description: (e as Error).message, variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const openEditMember = (m: ClubMember) => {
    setEditMemberId(m.id);
    setEditForm({
      firstName: m.firstName ?? '',
      lastName: m.lastName ?? '',
      email: m.email ?? '',
      phone: m.phone ?? '',
      tierId: m.tierId != null ? String(m.tierId) : '',
      handicapIndex: m.handicapIndex ?? '',
      whsGhinNumber: m.whsGhinNumber ?? '',
      renewalDate: m.renewalDate ? m.renewalDate.slice(0, 10) : '',
      subscriptionStatus: m.subscriptionStatus ?? 'pending',
      showInDirectory: m.showInDirectory ?? true,
    });
  };

  const updateMember = async () => {
    if (!editForm.firstName || !editForm.lastName) {
      toast({ title: 'First and last name are required', variant: 'destructive' }); return;
    }
    if (editMemberId == null) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        firstName: editForm.firstName,
        lastName: editForm.lastName,
        email: editForm.email || null,
        phone: editForm.phone || null,
        tierId: editForm.tierId ? parseInt(editForm.tierId) : null,
        handicapIndex: editForm.handicapIndex || null,
        whsGhinNumber: editForm.whsGhinNumber || null,
        renewalDate: editForm.renewalDate || null,
        subscriptionStatus: editForm.subscriptionStatus,
        showInDirectory: editForm.showInDirectory,
      };
      const res = await fetch(`/api/organizations/${orgId}/club-members/members/${editMemberId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to update member');
      }
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers/members`] });
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers`] });
      setEditMemberId(null);
      toast({ title: 'Member updated' });
    } catch (e) {
      toast({ title: 'Failed to update member', description: (e as Error).message, variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const saveTier = async () => {
    if (!tierForm.name) { toast({ title: 'Tier name required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const payload = {
        ...tierForm,
        annualFee: tierForm.annualFee && tierForm.annualFee.trim() !== '' ? tierForm.annualFee.trim() : '0',
      };
      const res = await fetch(`/api/organizations/${orgId}/membership-tiers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let errorMsg = 'Failed to create tier';
        try {
          const data = JSON.parse(text);
          errorMsg = data.error || errorMsg;
        } catch {
          if (text && !text.trimStart().startsWith('<')) errorMsg = text;
        }
        throw new Error(errorMsg);
      }
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers`] });
      setAddTierOpen(false);
      setTierForm({ name: '', description: '', annualFee: '', currency: 'INR', gracePeriodDays: '14' });
      toast({ title: 'Membership tier created' });
    } catch (e) {
      toast({ title: 'Failed to create tier', description: (e as Error).message, variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const deleteMember = async (id: number) => {
    await fetch(`/api/organizations/${orgId}/club-members/members/${id}`, { method: 'DELETE' });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers/members`] });
    toast({ title: 'Member removed' });
  };

  const deleteTier = async (id: number) => {
    await fetch(`/api/organizations/${orgId}/membership-tiers/${id}`, { method: 'DELETE' });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers`] });
    toast({ title: 'Tier deleted' });
  };

  const sendInvite = async (memberId: number) => {
    setSendingInviteId(memberId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/club-members/${memberId}/send-invite`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? 'Failed to send invite', variant: 'destructive' });
        return;
      }
      if (data.emailError) {
        await navigator.clipboard.writeText(data.link ?? '').catch(() => {});
        toast({ title: 'Email unavailable — invite link copied', description: 'Paste it and share manually.' });
      } else {
        toast({ title: 'Invite sent', description: 'An invite email has been sent to the member.' });
      }
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers/members`] });
    } finally {
      setSendingInviteId(null);
    }
  };

  const copyInviteLink = async (memberId: number) => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/club-members/${memberId}/invite-link`);
      const data = await res.json();
      if (!res.ok) { toast({ title: data.error ?? 'No invite link', variant: 'destructive' }); return; }
      await navigator.clipboard.writeText(data.link);
      setCopiedLinkId(memberId);
      toast({ title: 'Invite link copied to clipboard' });
      setTimeout(() => setCopiedLinkId(null), 3000);
    } catch {
      toast({ title: 'Failed to copy link', variant: 'destructive' });
    }
  };

  const dismissPendingLink = async (memberId: number) => {
    await fetch(`/api/organizations/${orgId}/club-members/${memberId}/dismiss-pending-link`, { method: 'PATCH' });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers/members`] });
    toast({ title: 'Pending link request dismissed' });
  };

  const sendBulkInvites = async () => {
    const eligible = filtered.filter(m => selectedIds.has(m.id) && !m.userId && m.email);
    if (!eligible.length) { toast({ title: 'No eligible members selected', description: 'Select members without portal accounts that have an email address.', variant: 'destructive' }); return; }
    setBulkInviteSending(true);
    let sent = 0; let failed = 0;
    for (const m of eligible) {
      const res = await fetch(`/api/organizations/${orgId}/club-members/${m.id}/send-invite`, { method: 'POST' });
      if (res.ok) sent++; else failed++;
    }
    setBulkInviteSending(false);
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers/members`] });
    toast({ title: `Invites sent: ${sent}${failed ? ` (${failed} failed)` : ''}` });
  };

  const toggleSelect = (id: number) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const sendBulkRenewalReminders = async () => {
    setBulkSending(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/club-members/members/bulk-renew-reminder`, { method: 'POST' });
      const data = await res.json();
      toast({ title: `Renewal reminders sent`, description: `${data.sent} members notified` });
    } catch {
      toast({ title: 'Failed to send reminders', variant: 'destructive' });
    } finally { setBulkSending(false); }
  };

  const downloadMemberCard = async (memberId: number, memberName: string) => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/club-members/members/${memberId}/card`, { credentials: 'include' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to download card');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `membership-card-${memberName.replace(/\s+/g, '-').toLowerCase()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast({ title: 'Download failed', description: (e as Error).message, variant: 'destructive' });
    }
  };

  const dueForRenewal = members.filter(m => {
    if (!m.renewalDate) return false;
    const due = new Date(m.renewalDate);
    const now = new Date();
    const diff = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return diff <= 30 && diff > 0;
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto p-8 space-y-6">
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <Users className="w-6 h-6 text-primary" />
                <h1 className="text-2xl font-display font-bold text-white tracking-tight">Club Members</h1>
                {members.filter(m => m.pendingMemberLink).length > 0 && (
                  <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 border text-xs">
                    {members.filter(m => m.pendingMemberLink).length} pending link{members.filter(m => m.pendingMemberLink).length > 1 ? 's' : ''}
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground text-sm">Manage membership tiers, club members, and recurring billing</p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setBulkAuditOpen(true)} variant="outline" className="border-white/10 text-white hover:bg-white/5 gap-2" data-testid="button-bulk-audit">
                <History className="w-4 h-4" />
                Bulk Action History
              </Button>
              <Button onClick={sendBulkRenewalReminders} disabled={bulkSending} variant="outline" className="border-white/10 text-white hover:bg-white/5 gap-2">
                {bulkSending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                Renewal Reminders
              </Button>
              <Button onClick={() => setAddMemberOpen(true)} className="bg-primary hover:bg-primary/90 text-white gap-2">
                <Plus className="w-4 h-4" /> Add Member
              </Button>
            </div>
          </div>
        </motion.div>

        {/* Renewal alerts */}
        {dueForRenewal.length > 0 && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0" />
            <div>
              <p className="text-white font-medium text-sm">{dueForRenewal.length} member{dueForRenewal.length > 1 ? 's' : ''} up for renewal within 30 days</p>
              <p className="text-yellow-400/70 text-xs mt-0.5">{dueForRenewal.map(m => `${m.firstName} ${m.lastName}`).join(', ')}</p>
            </div>
          </div>
        )}

        <Tabs defaultValue="members" className="w-full">
          <TabsList className="bg-black/40 border border-white/5 p-1 rounded-xl">
            <TabsTrigger value="members" className="rounded-lg data-[state=active]:bg-primary/20 data-[state=active]:text-primary px-5 py-2.5 font-semibold flex items-center gap-2">
              <Users className="w-4 h-4" /> Members ({members.length})
            </TabsTrigger>
            <TabsTrigger value="tiers" className="rounded-lg data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400 px-5 py-2.5 font-semibold flex items-center gap-2">
              <Settings2 className="w-4 h-4" /> Tiers ({tiers.length})
            </TabsTrigger>
            <TabsTrigger value="levies" className="rounded-lg data-[state=active]:bg-amber-500/20 data-[state=active]:text-amber-400 px-5 py-2.5 font-semibold flex items-center gap-2">
              <Coins className="w-4 h-4" /> Levies ({levies.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="members" className="mt-4">
            <div className="mb-4 space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search members by name or email…"
                  className="pl-10 bg-black/40 border-white/10 text-white" />
              </div>

              {/* Filters + Saved Segments */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mr-1">
                  <Filter className="w-3.5 h-3.5" /> Filters
                </div>
                <Select value={filters.status ?? '__any'} onValueChange={v => { setFilters(f => ({ ...f, status: v === '__any' ? undefined : v })); setActiveSegmentId(null); }}>
                  <SelectTrigger className="bg-black/40 border-white/10 text-white h-8 w-[140px] text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    <SelectItem value="__any" className="text-white hover:bg-white/5">Any status</SelectItem>
                    {['active','past_due','cancelled','expired','pending'].map(s => (
                      <SelectItem key={s} value={s} className="text-white hover:bg-white/5">{s.replace('_', ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={filters.tierId != null ? String(filters.tierId) : '__any'} onValueChange={v => { setFilters(f => ({ ...f, tierId: v === '__any' ? null : parseInt(v) })); setActiveSegmentId(null); }}>
                  <SelectTrigger className="bg-black/40 border-white/10 text-white h-8 w-[160px] text-xs"><SelectValue placeholder="Tier" /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    <SelectItem value="__any" className="text-white hover:bg-white/5">Any tier</SelectItem>
                    {tiers.map(t => <SelectItem key={t.id} value={String(t.id)} className="text-white hover:bg-white/5">{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filters.hasPortal ?? '__any'} onValueChange={v => { setFilters(f => ({ ...f, hasPortal: v === '__any' ? null : v as 'yes' | 'no' })); setActiveSegmentId(null); }}>
                  <SelectTrigger className="bg-black/40 border-white/10 text-white h-8 w-[150px] text-xs"><SelectValue placeholder="Portal" /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    <SelectItem value="__any" className="text-white hover:bg-white/5">Any portal</SelectItem>
                    <SelectItem value="yes" className="text-white hover:bg-white/5">Has portal</SelectItem>
                    <SelectItem value="no" className="text-white hover:bg-white/5">No portal</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={filters.hasEmail ?? '__any'} onValueChange={v => { setFilters(f => ({ ...f, hasEmail: v === '__any' ? null : v as 'yes' | 'no' })); setActiveSegmentId(null); }}>
                  <SelectTrigger className="bg-black/40 border-white/10 text-white h-8 w-[140px] text-xs"><SelectValue placeholder="Email" /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    <SelectItem value="__any" className="text-white hover:bg-white/5">Any email</SelectItem>
                    <SelectItem value="yes" className="text-white hover:bg-white/5">Has email</SelectItem>
                    <SelectItem value="no" className="text-white hover:bg-white/5">No email</SelectItem>
                  </SelectContent>
                </Select>
                {(filterCount > 0 || filters.search) && (
                  <button onClick={clearFilters} className="text-xs text-muted-foreground hover:text-white px-2 py-1 transition-colors">Clear</button>
                )}

                <div className="ml-auto flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-8 border-white/10 text-white hover:bg-white/5 gap-1.5 text-xs">
                        <Bookmark className="w-3.5 h-3.5" />
                        {activeSegmentId ? (savedSegments.find(s => s.id === activeSegmentId)?.name ?? 'Segment') : 'Saved Segments'}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="bg-[#0a1628] border-white/10 text-white w-64">
                      <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wider">Load Segment</DropdownMenuLabel>
                      {savedSegments.length === 0 && (
                        <div className="px-2 py-3 text-xs text-muted-foreground text-center">No saved segments yet</div>
                      )}
                      {savedSegments.map(seg => (
                        <DropdownMenuItem key={seg.id} className="flex items-center justify-between gap-2 hover:bg-white/5 focus:bg-white/5"
                          onSelect={(e) => { e.preventDefault(); applySegment(seg.id); }}>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm truncate">{seg.name}</div>
                            {seg.isShared && <div className="text-[10px] text-muted-foreground">shared</div>}
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); setRenameSegment({ id: seg.id, name: seg.name, description: seg.description ?? '', isShared: seg.isShared }); }}
                            className="text-muted-foreground hover:text-white p-1"
                            title="Edit segment"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteSegment(seg.id); }}
                            className="text-muted-foreground hover:text-destructive p-1"
                            title="Delete segment"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator className="bg-white/10" />
                      <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setSaveSegmentOpen(true); }} className="hover:bg-white/5 focus:bg-white/5 gap-2">
                        <Save className="w-3.5 h-3.5" /> Save current filters…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {selectedIds.size > 0 && (
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-primary/10 border border-primary/30 rounded-xl px-4 py-2.5 flex-wrap backdrop-blur">
                  <span className="text-sm text-primary font-medium">{selectedIds.size} selected</span>
                  <Separator orientation="vertical" className="h-5 bg-white/10" />
                  <Button onClick={() => openBulkAction('freeze')} size="sm" variant="outline" className="h-8 border-white/10 text-white hover:bg-white/5 gap-1.5 text-xs">
                    <Snowflake className="w-3.5 h-3.5" /> Freeze
                  </Button>
                  <Button onClick={() => openBulkAction('suspend')} size="sm" variant="outline" className="h-8 border-white/10 text-white hover:bg-white/5 gap-1.5 text-xs">
                    <Ban className="w-3.5 h-3.5" /> Suspend
                  </Button>
                  <Button onClick={() => openBulkAction('reinstate')} size="sm" variant="outline" className="h-8 border-white/10 text-white hover:bg-white/5 gap-1.5 text-xs">
                    <RotateCcw className="w-3.5 h-3.5" /> Reinstate
                  </Button>
                  <Button onClick={() => openBulkAction('tag')} size="sm" variant="outline" className="h-8 border-white/10 text-white hover:bg-white/5 gap-1.5 text-xs">
                    <Tag className="w-3.5 h-3.5" /> Tag
                  </Button>
                  <Button onClick={() => openBulkAction('message')} size="sm" variant="outline" className="h-8 border-white/10 text-white hover:bg-white/5 gap-1.5 text-xs">
                    <MessageSquare className="w-3.5 h-3.5" /> Message
                  </Button>
                  <Button onClick={() => openBulkAction('tier_change')} size="sm" variant="outline" className="h-8 border-white/10 text-white hover:bg-white/5 gap-1.5 text-xs">
                    <ArrowUpDown className="w-3.5 h-3.5" /> Change Tier
                  </Button>
                  <Separator orientation="vertical" className="h-5 bg-white/10" />
                  <Button onClick={sendBulkInvites} disabled={bulkInviteSending} size="sm" className="bg-primary hover:bg-primary/90 text-white h-8 gap-1.5 text-xs">
                    {bulkInviteSending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    Invites
                  </Button>
                  <button onClick={() => setSelectedIds(new Set())} className="text-xs text-muted-foreground hover:text-white ml-auto transition-colors">Clear selection</button>
                </div>
              )}
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground">Loading members...</div>
            ) : filtered.length === 0 ? (
              <Card className="glass-card">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <Users className="w-12 h-12 text-primary/40 mb-4" />
                  <p className="text-white font-semibold mb-1">No members yet</p>
                  <p className="text-muted-foreground text-sm">Add your first club member to get started with membership management.</p>
                  <Button onClick={() => setAddMemberOpen(true)} className="mt-4 bg-primary hover:bg-primary/90 text-white gap-2">
                    <Plus className="w-4 h-4" /> Add Member
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3">
                {filtered.map(m => {
                  const status = statusColors[m.subscriptionStatus] ?? statusColors.pending;
                  const StatusIcon = status.icon;
                  const daysUntilRenewal = m.renewalDate
                    ? Math.ceil((new Date(m.renewalDate).getTime() - Date.now()) / 86400000)
                    : null;
                  const isLinked = m.userId != null;
                  const isPending = !isLinked && m.pendingMemberLink;
                  const hasInvite = !isLinked && !isPending && !!m.inviteToken;
                  const isSelected = selectedIds.has(m.id);
                  return (
                    <Card key={m.id} className={`glass-card hover:border-white/10 transition-all ${isSelected ? 'ring-1 ring-primary/40' : ''}`}>
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(m.id)}
                            className="mt-3 accent-primary cursor-pointer flex-shrink-0"
                          />
                          <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-base flex-shrink-0 mt-0.5">
                            {m.firstName[0]}{m.lastName[0]}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-white">{m.firstName} {m.lastName}</span>
                              {m.memberNumber && <span className="text-xs text-muted-foreground font-mono">{m.memberNumber}</span>}
                              {m.tierName && <Badge className="bg-white/10 text-white border-white/10 text-xs">{m.tierName}</Badge>}
                              <Badge className={`border text-xs ${status.bg} ${status.text}`}>
                                <StatusIcon className="w-3 h-3 mr-1" />
                                {m.subscriptionStatus.replace('_', ' ')}
                              </Badge>
                              {daysUntilRenewal !== null && daysUntilRenewal <= 30 && daysUntilRenewal > 0 && (
                                <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-xs">Renews in {daysUntilRenewal}d</Badge>
                              )}
                              {isLinked && (
                                <Badge className="bg-green-500/20 text-green-400 border-green-500/30 border text-xs flex items-center gap-1">
                                  <UserCheck className="w-3 h-3" /> Portal linked
                                </Badge>
                              )}
                              {isPending && (
                                <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 border text-xs flex items-center gap-1">
                                  <AlertCircle className="w-3 h-3" /> Pending link
                                </Badge>
                              )}
                              {hasInvite && (
                                <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 border text-xs flex items-center gap-1">
                                  <Send className="w-3 h-3" /> Invited
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-4 mt-1 flex-wrap">
                              {m.email && <a href={`mailto:${m.email}`} className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"><Mail className="w-3 h-3" />{m.email}</a>}
                              {m.phone && <span className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="w-3 h-3" />{m.phone}</span>}
                              {m.handicapIndex && <span className="text-xs text-muted-foreground">HCP {m.handicapIndex}</span>}
                              {m.tierAnnualFee && <span className="text-xs text-primary font-medium">{currencySymbol['INR'] ?? '₹'}{parseFloat(m.tierAnnualFee).toLocaleString()}/yr</span>}
                              {m.userId != null && (() => {
                                const activity = activityByUserId.get(m.userId);
                                const sessions = activity?.sessions ?? 0;
                                const rounds = activity?.rounds ?? 0;
                                return (
                                  <>
                                    <span className={`text-xs flex items-center gap-1 font-medium ${sessions > 0 ? 'text-[#C9A84C]' : 'text-muted-foreground/40'}`}>
                                      🏋️ {sessions} practice{sessions !== 1 ? 's' : ''}
                                    </span>
                                    <span className={`text-xs flex items-center gap-1 font-medium ${rounds > 0 ? 'text-emerald-400' : 'text-muted-foreground/40'}`}>
                                      ⛳ {rounds} round{rounds !== 1 ? 's' : ''}
                                    </span>
                                    {(sessions > 0 || rounds > 0) && <span className="text-xs text-muted-foreground/40">last 30d</span>}
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                            {!isLinked && !isPending && m.email && (
                              <button
                                onClick={() => sendInvite(m.id)}
                                disabled={sendingInviteId === m.id}
                                className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary border border-primary/20 hover:border-primary/40 rounded-md px-2 py-1 transition-all disabled:opacity-50"
                                title={hasInvite ? 'Resend invite' : 'Send invite'}
                              >
                                {sendingInviteId === m.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                                {hasInvite ? 'Resend' : 'Invite'}
                              </button>
                            )}
                            {hasInvite && (
                              <button
                                onClick={() => copyInviteLink(m.id)}
                                className="text-muted-foreground hover:text-primary transition-colors p-1"
                                title="Copy invite link"
                              >
                                {copiedLinkId === m.id ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                              </button>
                            )}
                            {isPending && (
                              <button
                                onClick={() => dismissPendingLink(m.id)}
                                className="text-xs text-amber-400/70 hover:text-amber-400 border border-amber-500/20 hover:border-amber-500/40 rounded-md px-2 py-1 transition-all"
                                title="Dismiss pending link request"
                              >
                                Dismiss
                              </button>
                            )}
                            <button
                              onClick={() => downloadMemberCard(m.id, `${m.firstName} ${m.lastName}`)}
                              className="text-muted-foreground hover:text-primary transition-colors p-1"
                              title="Download membership card"
                            >
                              <Download className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => { setChargesMemberId(m.id); setChargesMemberName(`${m.firstName} ${m.lastName}`); }}
                              className="text-muted-foreground hover:text-primary transition-colors p-1"
                              title="View account charges"
                            >
                              <Receipt className="w-4 h-4" />
                            </button>
                            {m.userId != null && currentUserId !== m.userId && (
                              <FollowButton
                                userId={m.userId}
                                initialFollowing={followeeIds.includes(m.userId)}
                              />
                            )}
                            <Link
                              href={`/member-360/${m.id}`}
                              className="text-muted-foreground hover:text-primary transition-colors p-1"
                              title="Open Member 360°"
                            >
                              <UserCheck className="w-4 h-4" />
                            </Link>
                            <button
                              onClick={() => openEditMember(m)}
                              className="text-muted-foreground hover:text-primary transition-colors p-1"
                              title="Edit member"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button onClick={() => deleteMember(m.id)} className="text-muted-foreground hover:text-destructive transition-colors p-1">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="tiers" className="mt-4">
            <div className="flex justify-end mb-4">
              <Button onClick={() => setAddTierOpen(true)} className="bg-emerald-700 hover:bg-emerald-800 text-white gap-2">
                <Plus className="w-4 h-4" /> Create Tier
              </Button>
            </div>

            {tiers.length === 0 ? (
              <Card className="glass-card">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <CreditCard className="w-12 h-12 text-emerald-500/40 mb-4" />
                  <p className="text-white font-semibold mb-1">No membership tiers</p>
                  <p className="text-muted-foreground text-sm">Create tiers like Full, Social, Junior, or Corporate membership.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {tiers.map(t => (
                  <Card key={t.id} className={`glass-card ${!t.isActive ? 'opacity-60' : ''}`}>
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h3 className="font-semibold text-white">{t.name}</h3>
                          <p className="text-primary font-medium text-lg mt-1">
                            {currencySymbol[t.currency] ?? '₹'}{parseFloat(t.annualFee).toLocaleString()}<span className="text-muted-foreground text-sm font-normal">/yr</span>
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge className="bg-white/10 text-white border-white/10 text-xs">{t.memberCount} members</Badge>
                          <button onClick={() => deleteTier(t.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      {t.razorpayPlanId && (
                        <div className="flex items-center gap-1.5 text-xs text-green-400 mt-2">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Razorpay subscription plan linked
                        </div>
                      )}
                      {!t.razorpayPlanId && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2">
                          <AlertCircle className="w-3.5 h-3.5" /> No Razorpay plan (manual billing)
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="levies" className="mt-4">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-muted-foreground">Apply special charges (capital levies, course-improvement contributions, locker fees) to all members, a tier, or a manual selection.</p>
              <Button onClick={() => setCreateLevyOpen(true)} className="bg-amber-600 hover:bg-amber-700 text-white gap-2">
                <Plus className="w-4 h-4" /> Create Levy
              </Button>
            </div>

            {orgId != null && (
              <div className="mb-4">
                <OrgLevyLedgerEmailSchedulePanel orgId={orgId} />
              </div>
            )}

            {levies.length === 0 ? (
              <Card className="glass-card">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <Coins className="w-12 h-12 text-amber-500/40 mb-4" />
                  <p className="text-white font-semibold mb-1">No levies yet</p>
                  <p className="text-muted-foreground text-sm">Create a levy and apply it to your members.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3">
                {levies.map(l => (
                  <Card key={l.id} className="glass-card">
                    <CardContent className="p-4 flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-white">{l.name}</span>
                          <Badge className="bg-white/10 text-white border-white/10 text-xs">{l.scope}</Badge>
                          {l.status === 'applied' ? (
                            <Badge className="bg-green-500/20 text-green-400 border-green-500/30 border text-xs">Applied{l.appliedAt ? ` ${new Date(l.appliedAt).toLocaleDateString()}` : ''}</Badge>
                          ) : (
                            <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 border text-xs">Draft</Badge>
                          )}
                          <span className="text-amber-400 font-medium text-sm">{currencySymbol[l.currency] ?? '₹'}{parseFloat(l.amount).toLocaleString()}</span>
                        </div>
                        {l.description && <p className="text-xs text-muted-foreground mt-1">{l.description}</p>}
                        {l.dueDate && <p className="text-xs text-muted-foreground mt-1">Due: {new Date(l.dueDate).toLocaleDateString()}</p>}
                      </div>
                      <div className="flex items-center gap-2">
                        {l.status !== 'applied' && (
                          <Button onClick={() => applyLevy(l.id)} disabled={applyingLevyId === l.id} size="sm" className="bg-amber-600 hover:bg-amber-700 text-white h-8 gap-1.5 text-xs">
                            {applyingLevyId === l.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Coins className="w-3.5 h-3.5" />}
                            Apply
                          </Button>
                        )}
                        {l.status === 'applied' && (
                          <Button onClick={() => setOpenLevyId(l.id)} size="sm" variant="outline" className="border-white/10 text-white hover:bg-white/5 h-8 gap-1.5 text-xs">
                            <Receipt className="w-3.5 h-3.5" /> View payments
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Save Segment Dialog */}
      <Dialog open={saveSegmentOpen} onOpenChange={setSaveSegmentOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>Save Filter as Segment</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Name *</label>
              <Input value={segmentForm.name} onChange={e => setSegmentForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Past-due full members" className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Description</label>
              <Input value={segmentForm.description} onChange={e => setSegmentForm(f => ({ ...f, description: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div className="flex items-center justify-between bg-black/30 border border-white/10 rounded-lg px-3 py-2.5">
              <div>
                <p className="text-sm text-white">Share with all admins</p>
                <p className="text-xs text-muted-foreground">Other admins in your club can load this segment</p>
              </div>
              <Switch checked={segmentForm.isShared} onCheckedChange={v => setSegmentForm(f => ({ ...f, isShared: v }))} />
            </div>
            <div className="text-xs text-muted-foreground bg-black/30 rounded-lg p-3 border border-white/10">
              Current filters: {filterCount === 0 && !filters.search ? 'none' : [
                filters.search && `search="${filters.search}"`,
                filters.status && `status=${filters.status}`,
                filters.tierId != null && `tier=${tiers.find(t => t.id === filters.tierId)?.name ?? filters.tierId}`,
                filters.hasPortal && `portal=${filters.hasPortal}`,
                filters.hasEmail && `email=${filters.hasEmail}`,
              ].filter(Boolean).join(', ')}
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={saveSegment} className="flex-1 bg-primary hover:bg-primary/90 text-white">Save Segment</Button>
              <Button variant="outline" onClick={() => setSaveSegmentOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renameSegment !== null} onOpenChange={(o) => { if (!o) setRenameSegment(null); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>Edit Segment</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Name *</label>
              <Input
                value={renameSegment?.name ?? ''}
                onChange={e => setRenameSegment(s => s ? { ...s, name: e.target.value } : s)}
                onKeyDown={e => { if (e.key === 'Enter' && !renameSegmentSubmitting) submitRenameSegment(); }}
                autoFocus
                className="mt-1 bg-black/40 border-white/10 text-white"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Description</label>
              <Textarea
                value={renameSegment?.description ?? ''}
                onChange={e => setRenameSegment(s => s ? { ...s, description: e.target.value } : s)}
                className="mt-1 bg-black/40 border-white/10 text-white min-h-[80px]"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm">Share with all admins</div>
                <div className="text-xs text-muted-foreground">Other admins in this club can apply this segment.</div>
              </div>
              <Switch
                checked={renameSegment?.isShared ?? false}
                onCheckedChange={(v) => setRenameSegment(s => s ? { ...s, isShared: v } : s)}
              />
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={submitRenameSegment} disabled={renameSegmentSubmitting} className="flex-1 bg-primary hover:bg-primary/90 text-white">
                {renameSegmentSubmitting ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="outline" onClick={() => setRenameSegment(null)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Action Audit History Dialog */}
      <Dialog open={bulkAuditOpen} onOpenChange={setBulkAuditOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="w-5 h-5 text-primary" />
              Bulk Action History
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="flex flex-wrap gap-3 items-end bg-black/30 border border-white/10 rounded-lg p-3">
              <div className="flex-1 min-w-[140px]">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">From</label>
                <Input
                  type="date"
                  value={bulkAuditFilters.from}
                  onChange={e => setBulkAuditFilters(f => ({ ...f, from: e.target.value }))}
                  className="mt-1 bg-black/40 border-white/10 text-white h-9 text-sm"
                  data-testid="input-bulk-audit-from"
                />
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">To</label>
                <Input
                  type="date"
                  value={bulkAuditFilters.to}
                  onChange={e => setBulkAuditFilters(f => ({ ...f, to: e.target.value }))}
                  className="mt-1 bg-black/40 border-white/10 text-white h-9 text-sm"
                  data-testid="input-bulk-audit-to"
                />
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Action</label>
                <Select value={bulkAuditFilters.action} onValueChange={v => setBulkAuditFilters(f => ({ ...f, action: v }))}>
                  <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white h-9 text-sm" data-testid="select-bulk-audit-action">
                    <SelectValue placeholder="Any action" />
                  </SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    <SelectItem value="__any" className="text-white hover:bg-white/5">Any action</SelectItem>
                    <SelectItem value="freeze" className="text-white hover:bg-white/5">Freeze</SelectItem>
                    <SelectItem value="suspend" className="text-white hover:bg-white/5">Suspend</SelectItem>
                    <SelectItem value="reinstate" className="text-white hover:bg-white/5">Reinstate</SelectItem>
                    <SelectItem value="tag" className="text-white hover:bg-white/5">Tag</SelectItem>
                    <SelectItem value="message" className="text-white hover:bg-white/5">Message</SelectItem>
                    <SelectItem value="tier_change" className="text-white hover:bg-white/5">Tier change</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(bulkAuditFilters.from || bulkAuditFilters.to || bulkAuditFilters.action !== '__any') && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBulkAuditFilters({ from: '', to: '', action: '__any' })}
                  className="h-9 border-white/10 text-white hover:bg-white/5 text-xs"
                  data-testid="button-bulk-audit-clear"
                >
                  Clear
                </Button>
              )}
            </div>

            {bulkAuditQuery.isLoading ? (
              <div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>
            ) : bulkAuditQuery.isError ? (
              <div className="py-12 text-center text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg" data-testid="bulk-audit-error">
                Failed to load bulk action history: {(bulkAuditQuery.error as Error).message}
              </div>
            ) : (bulkAuditQuery.data?.length ?? 0) === 0 ? (
              <div className="py-12 text-center text-muted-foreground text-sm">
                No bulk actions match these filters.
              </div>
            ) : (() => {
              const entries = bulkAuditQuery.data!;
              // Normalize bucket strings so source/clone matching is robust against
              // slight serialization differences (Task #267).
              const normBucket = (b: string): string => {
                const d = new Date(b);
                return Number.isNaN(d.getTime()) ? b : d.toISOString();
              };
              // Recognize every entry's bucket so clone-of-clone lineage can nest
              // beyond a single level.
              const allBuckets = new Set(entries.map(e => normBucket(e.bucket)));
              const childrenBySource = new Map<string, BulkAuditEntry[]>();
              const topLevel: BulkAuditEntry[] = [];
              for (const e of entries) {
                if (e.sourceBucket && allBuckets.has(normBucket(e.sourceBucket))) {
                  const k = normBucket(e.sourceBucket);
                  const arr = childrenBySource.get(k) ?? [];
                  arr.push(e);
                  childrenBySource.set(k, arr);
                } else {
                  topLevel.push(e);
                }
              }
              // Children come back in the same desc-by-time order as the parent query;
              // re-sort ascending under the source so the lineage reads chronologically.
              for (const arr of childrenBySource.values()) {
                arr.sort((a, b) => new Date(a.lastAt).getTime() - new Date(b.lastAt).getTime());
              }

              const actionColors: Record<string, string> = {
                freeze: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
                suspend: 'bg-red-500/20 text-red-300 border-red-500/30',
                reinstate: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
                tag: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
                message: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
                tier_change: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
              };

              const renderRow = (
                entry: BulkAuditEntry,
                idx: string,
                opts: { isClone?: boolean } = {},
              ) => {
                const actionLabel = entry.actionType.replace('_', ' ');
                const cls = actionColors[entry.actionType] ?? 'bg-white/10 text-white border-white/10';
                const when = new Date(entry.lastAt);
                const key = `${entry.bucket}-${entry.actorUserId ?? 'null'}-${entry.entity}-${entry.reason ?? ''}`;
                const isExpanded = expandedBulkAuditKey === key;
                const children = childrenBySource.get(normBucket(entry.bucket)) ?? [];
                const cloneCount = children.length;
                const hasClones = cloneCount > 0;
                const clonesExpanded = hasClones && expandedClonesKeys.has(key);
                const toggleExpanded = () =>
                  setExpandedBulkAuditKey(prev => prev === key ? null : key);
                return (
                  <div key={`${entry.bucket}-${entry.actorUserId}-${entry.entity}-${idx}`}
                    className={`bg-black/30 border border-white/10 rounded-lg p-3 ${opts.isClone ? 'border-l-2 border-l-amber-400/60' : ''}`}
                    data-testid={opts.isClone ? `bulk-audit-clone-entry-${idx}` : `bulk-audit-entry-${idx}`}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={toggleExpanded}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleExpanded();
                        }
                      }}
                      className="w-full text-left flex items-start justify-between gap-3 flex-wrap cursor-pointer hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-white/20 rounded"
                      data-testid={opts.isClone ? `button-bulk-audit-clone-expand-${idx}` : `button-bulk-audit-expand-${idx}`}
                      aria-expanded={isExpanded}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {isExpanded
                          ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                          : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                        <Badge className={`border text-xs capitalize ${cls}`}>{actionLabel}</Badge>
                        {opts.isClone && (
                          <Badge className="border text-[10px] uppercase tracking-wider bg-amber-500/15 text-amber-300 border-amber-400/30">
                            Clone
                          </Badge>
                        )}
                        <span className="text-sm text-white font-medium">
                          {entry.memberCount} member{entry.memberCount !== 1 ? 's' : ''}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          by {entry.actorName ?? 'Unknown'}
                          {entry.actorRole && <span className="ml-1 opacity-70">({entry.actorRole})</span>}
                        </span>
                        {hasClones && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedClonesKeys(prev => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key); else next.add(key);
                                return next;
                              });
                            }}
                            onKeyDown={(e) => e.stopPropagation()}
                            className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                              clonesExpanded
                                ? 'bg-amber-500/25 text-amber-200 border-amber-400/50'
                                : 'bg-amber-500/10 text-amber-300 border-amber-400/30 hover:bg-amber-500/20'
                            }`}
                            aria-expanded={clonesExpanded}
                            data-testid={`button-bulk-audit-clones-toggle-${idx}`}
                          >
                            {clonesExpanded
                              ? <ChevronDown className="w-3 h-3" />
                              : <ChevronRight className="w-3 h-3" />}
                            {cloneCount} clone{cloneCount === 1 ? '' : 's'}
                          </button>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground" title={when.toISOString()}>
                        {when.toLocaleString()}
                      </span>
                    </div>
                    {entry.reason && (
                      <p className="text-xs text-muted-foreground mt-1.5 break-words pl-6">
                        {entry.reason}
                      </p>
                    )}
                    {isExpanded && orgId && (
                      <BulkAuditDetails
                        orgId={orgId}
                        bucket={entry.bucket}
                        entity={entry.entity}
                        reason={entry.reason}
                        actorUserId={entry.actorUserId}
                        actionType={entry.actionType}
                        memberCount={entry.memberCount}
                        canReverse={user?.role === 'super_admin' || user?.role === 'org_admin'}
                        cohortChoices={cohortChoices}
                        onReversed={() => {
                          queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/members-360/bulk-audit`] });
                          queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/membership-tiers/members`] });
                          setExpandedBulkAuditKey(null);
                        }}
                      />
                    )}
                    {clonesExpanded && (
                      <div
                        className="mt-3 pl-4 border-l border-amber-400/30 space-y-2"
                        data-testid={`bulk-audit-clones-${idx}`}
                      >
                        {children.map((child, ci) =>
                          renderRow(child, `${idx}-c${ci}`, { isClone: true }),
                        )}
                      </div>
                    )}
                  </div>
                );
              };

              return (
                <div className="space-y-2" data-testid="list-bulk-audit">
                  {topLevel.map((entry, i) => renderRow(entry, String(i)))}
                </div>
              );
            })()}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              onClick={() => {
                const params = new URLSearchParams();
                if (bulkAuditFilters.from) params.set('from', new Date(bulkAuditFilters.from).toISOString());
                if (bulkAuditFilters.to) {
                  const d = new Date(bulkAuditFilters.to); d.setHours(23, 59, 59, 999);
                  params.set('to', d.toISOString());
                }
                if (bulkAuditFilters.action && bulkAuditFilters.action !== '__any') params.set('action', bulkAuditFilters.action);
                params.set('format', 'csv');
                window.location.href = `/api/organizations/${orgId}/members-360/bulk-audit?${params.toString()}`;
              }}
              disabled={(bulkAuditQuery.data?.length ?? 0) === 0}
              className="border-white/10 text-white hover:bg-white/5 gap-2"
              data-testid="button-bulk-audit-export-csv"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </Button>
            <Button variant="outline" onClick={() => setBulkAuditOpen(false)} className="border-white/10 text-white hover:bg-white/5">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Action Dialog */}
      <Dialog open={bulkActionType != null} onOpenChange={open => { if (!open) { setBulkActionType(null); setBulkPayload({}); } }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="capitalize">{bulkActionType?.replace('_', ' ')} — {selectedIds.size} member{selectedIds.size !== 1 ? 's' : ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            {(bulkActionType === 'freeze' || bulkActionType === 'suspend' || bulkActionType === 'reinstate') && (
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Reason (optional)</label>
                <Input value={bulkPayload.reason ?? ''} onChange={e => setBulkPayload(p => ({ ...p, reason: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" />
              </div>
            )}
            {bulkActionType === 'tag' && (
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Tag *</label>
                <Input value={bulkPayload.tag ?? ''} onChange={e => setBulkPayload(p => ({ ...p, tag: e.target.value }))} placeholder="e.g. vip, junior-program" className="mt-1 bg-black/40 border-white/10 text-white" />
              </div>
            )}
            {bulkActionType === 'message' && (
              <>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider">Channel</label>
                  <Select value={bulkPayload.channel ?? 'in_app'} onValueChange={v => setBulkPayload(p => ({ ...p, channel: v }))}>
                    <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                      {['in_app','email','sms','whatsapp'].map(c => <SelectItem key={c} value={c} className="text-white hover:bg-white/5">{c.replace('_',' ')}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider">Subject</label>
                  <Input value={bulkPayload.subject ?? ''} onChange={e => setBulkPayload(p => ({ ...p, subject: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider">Body *</label>
                  <Textarea value={bulkPayload.body ?? ''} onChange={e => setBulkPayload(p => ({ ...p, body: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white min-h-[100px]" />
                </div>
              </>
            )}
            {bulkActionType === 'tier_change' && (
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">New Tier *</label>
                <Select value={bulkPayload.tierId ?? ''} onValueChange={v => setBulkPayload(p => ({ ...p, tierId: v }))}>
                  <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue placeholder="Select tier…" /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    {tiers.map(t => <SelectItem key={t.id} value={String(t.id)} className="text-white hover:bg-white/5">{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <Button onClick={submitBulkAction} disabled={bulkSubmitting} className="flex-1 bg-primary hover:bg-primary/90 text-white">
                {bulkSubmitting ? 'Applying…' : 'Apply to selection'}
              </Button>
              <Button variant="outline" onClick={() => { setBulkActionType(null); setBulkPayload({}); }} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Levy Dialog */}
      <Dialog open={createLevyOpen} onOpenChange={setCreateLevyOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Create Levy</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Name *</label>
              <Input value={levyForm.name} onChange={e => setLevyForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Capital improvement 2026" className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Description</label>
              <Textarea value={levyForm.description} onChange={e => setLevyForm(f => ({ ...f, description: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white min-h-[60px]" />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Amount *</label>
                <Input type="number" value={levyForm.amount} onChange={e => setLevyForm(f => ({ ...f, amount: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" />
              </div>
              <div className="w-28">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Currency</label>
                <Select value={levyForm.currency} onValueChange={v => setLevyForm(f => ({ ...f, currency: v }))}>
                  <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    {['INR','USD','GBP','EUR'].map(c => <SelectItem key={c} value={c} className="text-white hover:bg-white/5">{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Apply To</label>
              <Select value={levyForm.scope} onValueChange={v => setLevyForm(f => ({ ...f, scope: v as 'all' | 'tier' | 'manual', tierIds: [] }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  <SelectItem value="all" className="text-white hover:bg-white/5">All members</SelectItem>
                  <SelectItem value="tier" className="text-white hover:bg-white/5">Specific tier(s)</SelectItem>
                  <SelectItem value="manual" className="text-white hover:bg-white/5">Manual selection ({selectedIds.size} selected)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {levyForm.scope === 'tier' && (
              <div className="space-y-2 bg-black/30 border border-white/10 rounded-lg p-3 max-h-48 overflow-y-auto">
                {tiers.map(t => (
                  <label key={t.id} className="flex items-center gap-2 text-sm text-white cursor-pointer">
                    <input
                      type="checkbox"
                      checked={levyForm.tierIds.includes(t.id)}
                      onChange={e => setLevyForm(f => ({
                        ...f,
                        tierIds: e.target.checked ? [...f.tierIds, t.id] : f.tierIds.filter(id => id !== t.id),
                      }))}
                      className="accent-primary"
                    />
                    {t.name} <span className="text-xs text-muted-foreground">({t.memberCount} members)</span>
                  </label>
                ))}
                {tiers.length === 0 && <p className="text-xs text-muted-foreground">No tiers configured</p>}
              </div>
            )}
            {levyForm.scope === 'manual' && selectedIds.size === 0 && (
              <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                Select members in the Members tab before creating a manual-scope levy.
              </div>
            )}
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Due Date (optional)</label>
              <Input type="date" value={levyForm.dueDate} onChange={e => setLevyForm(f => ({ ...f, dueDate: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={createLevy} className="flex-1 bg-amber-600 hover:bg-amber-700 text-white">Create Levy</Button>
              <Button variant="outline" onClick={() => setCreateLevyOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
            <p className="text-xs text-muted-foreground">After creation, click "Apply" on the levy card to charge the targeted members.</p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Resend Receipts Pre-flight Preview (Task #293) */}
      <Dialog
        open={bulkResendPreviewOpen}
        onOpenChange={(o) => {
          if (bulkResendingReceipts) return;
          setBulkResendPreviewOpen(o);
          if (!o) setBulkResendSelected(null);
        }}
      >
        <DialogContent
          className="bg-[#0a1628] border border-white/10 text-white max-w-2xl max-h-[85vh] overflow-y-auto"
          data-testid="dialog-bulk-resend-receipts-preview"
        >
          <DialogHeader>
            <DialogTitle>Resend failed receipts — pre-flight</DialogTitle>
          </DialogHeader>
          {bulkResendPreviewQuery.isLoading ? (
            <div className="py-8 text-center text-muted-foreground text-sm" data-testid="bulk-resend-preview-loading">
              Classifying receipts…
            </div>
          ) : bulkResendPreviewQuery.isError ? (
            <div className="py-6 text-sm text-red-300" data-testid="bulk-resend-preview-error">
              Couldn't load preview: {(bulkResendPreviewQuery.error as Error).message}
            </div>
          ) : bulkResendPreviewQuery.data ? (
            (() => {
              const data = bulkResendPreviewQuery.data;
              const sym = currencySymbol[data.currency] ?? '';
              const selected = bulkResendEffectiveSelected();
              const allSelected = data.rows.length > 0 && data.rows.every(r => selected.has(r.chargeId));
              const noneSelected = data.rows.every(r => !selected.has(r.chargeId));
              const labelFor = (o: BulkResendReceiptsPreviewRow['predictedOutcome']) =>
                o === 'sendable' ? 'Sendable'
                : o === 'will_skip_no_email' ? 'Will skip — no email'
                : o === 'will_skip_opted_out' ? 'Will skip — opted out'
                : 'Invalid — no prior receipt';
              const classFor = (o: BulkResendReceiptsPreviewRow['predictedOutcome']) =>
                o === 'sendable' ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10'
                : o === 'will_skip_no_email' ? 'border-amber-500/30 text-amber-300 bg-amber-500/10'
                : o === 'will_skip_opted_out' ? 'border-white/15 text-white/60 bg-white/5'
                : 'border-rose-500/30 text-rose-300 bg-rose-500/10';
              return (
                <div className="space-y-3 text-sm">
                  <div className="text-xs text-muted-foreground">
                    Predicted outcome for each charge based on the member's billing-email pref and contact info.
                    Sendable rows are pre-selected; rows that would skip again are unchecked. Adjust as needed before resending.
                  </div>
                  <div
                    className="rounded border border-white/10 bg-black/30 p-2.5 text-xs flex flex-wrap items-center gap-x-4 gap-y-1"
                    data-testid="bulk-resend-preview-counts"
                  >
                    <span><span className="font-semibold text-white" data-testid="bulk-resend-preview-total">{data.total}</span> total</span>
                    <span><span className="font-semibold text-emerald-300" data-testid="bulk-resend-preview-sendable">{data.sendable}</span> sendable</span>
                    <span><span className="font-semibold text-amber-300" data-testid="bulk-resend-preview-no-email">{data.willSkipNoEmail}</span> no email</span>
                    <span><span className="font-semibold text-white/70" data-testid="bulk-resend-preview-opted-out">{data.willSkipOptedOut}</span> opted out</span>
                    {data.invalid > 0 && (
                      <span><span className="font-semibold text-rose-300" data-testid="bulk-resend-preview-invalid">{data.invalid}</span> invalid</span>
                    )}
                  </div>
                  {data.rows.length === 0 ? (
                    <div className="py-6 text-center text-muted-foreground text-sm" data-testid="bulk-resend-preview-empty">
                      No failed or skipped receipts to resend.
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-xs">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-white/20 bg-black/40"
                            checked={allSelected}
                            ref={el => { if (el) el.indeterminate = !allSelected && !noneSelected; }}
                            onChange={(e) => setBulkResendAll(data.rows, e.target.checked)}
                            data-testid="bulk-resend-preview-toggle-all"
                          />
                          <span className="text-white/80">Select all</span>
                        </label>
                        <span className="text-muted-foreground" data-testid="bulk-resend-preview-selected-count">
                          {Array.from(selected).filter(id => data.rows.some(r => r.chargeId === id)).length} selected
                        </span>
                      </div>
                      <div className="max-h-[45vh] overflow-y-auto rounded border border-white/10 bg-black/30">
                        <ul className="divide-y divide-white/5">
                          {data.rows.map(row => {
                            const isOn = selected.has(row.chargeId);
                            const kindLabel = row.kind === 'partial_payment' ? 'partial payment' : row.kind ?? '—';
                            return (
                              <li
                                key={row.chargeId}
                                className="px-3 py-2 flex items-center gap-3"
                                data-testid={`bulk-resend-preview-row-${row.chargeId}`}
                              >
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 rounded border-white/20 bg-black/40"
                                  checked={isOn}
                                  onChange={() => toggleBulkResendRow(row.chargeId)}
                                  data-testid={`bulk-resend-preview-row-toggle-${row.chargeId}`}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-white text-sm truncate" data-testid={`bulk-resend-preview-row-name-${row.chargeId}`}>
                                    {row.memberName || `Member #${row.clubMemberId}`}
                                    {row.memberNumber && (
                                      <span className="text-muted-foreground text-[11px] ml-2">{row.memberNumber}</span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground truncate">
                                    <span className="capitalize">{kindLabel}</span>
                                    {row.amount && row.kind && (
                                      <span> · {sym}{parseFloat(row.amount).toLocaleString()}</span>
                                    )}
                                    <span> · last: {row.lastReceiptStatus}</span>
                                    {row.email
                                      ? <span> · {row.email}</span>
                                      : <span className="text-amber-300/80"> · no email</span>}
                                  </div>
                                </div>
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${classFor(row.predictedOutcome)}`}
                                  data-testid={`bulk-resend-preview-row-outcome-${row.chargeId}`}
                                >
                                  {labelFor(row.predictedOutcome)}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </>
                  )}
                </div>
              );
            })()
          ) : null}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              disabled={bulkResendingReceipts}
              onClick={() => { setBulkResendPreviewOpen(false); setBulkResendSelected(null); }}
              className="border-white/10 text-white hover:bg-white/5"
              data-testid="button-bulk-resend-preview-cancel"
            >
              Cancel
            </Button>
            <Button
              disabled={
                bulkResendingReceipts
                || bulkResendPreviewQuery.isLoading
                || !bulkResendPreviewQuery.data
                || (bulkResendPreviewQuery.data.rows.length > 0
                    && bulkResendPreviewQuery.data.rows.every(r => !bulkResendEffectiveSelected().has(r.chargeId)))
              }
              onClick={submitBulkResendSelected}
              className="bg-rose-600 hover:bg-rose-700 text-white gap-1.5"
              data-testid="button-bulk-resend-preview-confirm"
            >
              <Send className="w-4 h-4" />
              {bulkResendingReceipts
                ? 'Resending…'
                : (() => {
                    const n = bulkResendPreviewQuery.data
                      ? Array.from(bulkResendEffectiveSelected())
                          .filter(id => bulkResendPreviewQuery.data!.rows.some(r => r.chargeId === id)).length
                      : 0;
                    return `Resend ${n} selected`;
                  })()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Resend Receipts Results — per-channel breakdown (Task #508) */}
      <Dialog
        open={bulkResendResultOpen}
        onOpenChange={(o) => {
          setBulkResendResultOpen(o);
          if (!o) setBulkResendResult(null);
        }}
      >
        <DialogContent
          className="bg-[#0a1628] border border-white/10 text-white max-w-4xl max-h-[85vh] overflow-y-auto"
          data-testid="dialog-bulk-resend-receipts-results"
        >
          <DialogHeader>
            <DialogTitle>Resend results — per-channel breakdown</DialogTitle>
          </DialogHeader>
          {bulkResendResult && (() => {
            const data = bulkResendResult;
            const channelKeys: BulkResendChannelKey[] = ['email', 'push', 'sms', 'whatsapp'];
            const channelLabel: Record<BulkResendChannelKey, string> = {
              email: 'Email', push: 'Push', sms: 'SMS', whatsapp: 'WhatsApp',
            };
            const statusLabel: Record<BulkResendChannelStatus, string> = {
              sent: 'sent', failed: 'failed', no_address: 'no address',
              no_user: 'no user', opted_out: 'opted out', skipped: 'skipped',
            };
            const cellClass = (s: BulkResendChannelStatus) =>
              s === 'sent' ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10'
              : s === 'failed' ? 'border-rose-500/30 text-rose-300 bg-rose-500/10'
              : s === 'opted_out' ? 'border-white/15 text-white/60 bg-white/5'
              : s === 'no_address' || s === 'no_user' ? 'border-amber-500/30 text-amber-300 bg-amber-500/10'
              : 'border-white/10 text-white/55 bg-white/5';
            // For each channel, find the dominant error/reason among non-sent
            // outcomes so we can surface a friendly hint like
            // "(provider not configured)" alongside the skipped count.
            const channelHint = (k: BulkResendChannelKey): string | null => {
              const counts = new Map<string, number>();
              for (const r of data.results) {
                const c = r.channels[k];
                if (!c || c.status === 'sent') continue;
                const reason = c.error ?? null;
                if (!reason) continue;
                counts.set(reason, (counts.get(reason) ?? 0) + 1);
              }
              if (counts.size === 0) return null;
              let top: [string, number] | null = null;
              for (const entry of counts) {
                if (!top || entry[1] > top[1]) top = entry;
              }
              if (!top) return null;
              return top[0] === 'provider_not_configured' ? 'provider not configured' : top[0];
            };
            const channelSummaryParts = (k: BulkResendChannelKey): string => {
              const totals = data.channelTotals?.[k];
              if (!totals) return '—';
              const parts: string[] = [`${totals.sent} sent`];
              const order: BulkResendChannelStatus[] = ['failed', 'opted_out', 'no_address', 'no_user', 'skipped'];
              for (const s of order) {
                const n = totals[s];
                if (!n) continue;
                parts.push(`${n} ${statusLabel[s]}`);
              }
              const hint = channelHint(k);
              const base = parts.join(', ');
              return hint ? `${base} (${hint})` : base;
            };
            return (
              <div className="space-y-3 text-sm">
                <div
                  className="rounded border border-white/10 bg-black/30 p-2.5 text-xs flex flex-wrap items-center gap-x-4 gap-y-1"
                  data-testid="bulk-resend-results-aggregate"
                >
                  <span><span className="font-semibold text-white" data-testid="bulk-resend-results-attempted">{data.attempted}</span> attempted</span>
                  <span><span className="font-semibold text-emerald-300" data-testid="bulk-resend-results-sent">{data.sent}</span> sent</span>
                  {data.skipped > 0 && (
                    <span><span className="font-semibold text-white/70" data-testid="bulk-resend-results-skipped">{data.skipped}</span> skipped</span>
                  )}
                  {data.failed > 0 && (
                    <span><span className="font-semibold text-rose-300" data-testid="bulk-resend-results-failed">{data.failed}</span> failed</span>
                  )}
                </div>
                <div
                  className="rounded border border-white/10 bg-black/30 p-2.5 text-xs space-y-1"
                  data-testid="bulk-resend-results-channel-totals"
                >
                  {channelKeys.map(k => (
                    <div key={k} className="flex flex-wrap items-baseline gap-x-2" data-testid={`bulk-resend-results-channel-totals-${k}`}>
                      <span className="font-semibold text-white">{channelLabel[k]}:</span>
                      <span className="text-white/80">{channelSummaryParts(k)}</span>
                    </div>
                  ))}
                </div>
                {data.results.length === 0 ? (
                  <div className="py-6 text-center text-muted-foreground text-sm" data-testid="bulk-resend-results-empty">
                    No charges were attempted.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded border border-white/10 bg-black/30">
                    <table className="w-full text-xs" data-testid="bulk-resend-results-table">
                      <thead className="text-[10px] uppercase tracking-wider text-muted-foreground bg-white/5">
                        <tr>
                          <th className="px-2 py-1.5 text-left">Member</th>
                          <th className="px-2 py-1.5 text-left">Status</th>
                          {channelKeys.map(k => (
                            <th key={k} className="px-2 py-1.5 text-left">{channelLabel[k]}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {data.results.map(row => (
                          <tr key={row.chargeId} data-testid={`bulk-resend-results-row-${row.chargeId}`}>
                            <td className="px-2 py-1.5 text-white">
                              <div className="truncate max-w-[14rem]" data-testid={`bulk-resend-results-row-name-${row.chargeId}`}>
                                {row.memberName || `Member #${row.clubMemberId}`}
                              </div>
                              <div className="text-[10px] text-muted-foreground capitalize">
                                {row.kind === 'partial_payment' ? 'partial payment' : row.kind}
                              </div>
                            </td>
                            <td className="px-2 py-1.5">
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${
                                  row.status === 'sent' ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10'
                                  : row.status === 'skipped' ? 'border-white/15 text-white/60 bg-white/5'
                                  : 'border-rose-500/30 text-rose-300 bg-rose-500/10'
                                }`}
                                title={row.reason ?? undefined}
                                data-testid={`bulk-resend-results-row-status-${row.chargeId}`}
                              >
                                {row.status}
                                {row.reason ? ` · ${row.reason}` : ''}
                              </span>
                            </td>
                            {channelKeys.map(k => {
                              const ch = row.channels?.[k];
                              const status = ch?.status ?? 'skipped';
                              return (
                                <td key={k} className="px-2 py-1.5">
                                  <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${cellClass(status)}`}
                                    title={ch?.error ?? undefined}
                                    data-testid={`bulk-resend-results-row-channel-${row.chargeId}-${k}`}
                                  >
                                    {statusLabel[status]}
                                    {ch?.error ? ' !' : ''}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}
          <DialogFooter>
            <Button
              onClick={() => { setBulkResendResultOpen(false); setBulkResendResult(null); }}
              className="bg-white/10 hover:bg-white/15 text-white"
              data-testid="button-bulk-resend-results-close"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Levy Detail Dialog */}
      <Dialog open={openLevyId != null} onOpenChange={open => { if (!open) { setOpenLevyId(null); } }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{levyDetailQuery.data?.levy?.name ?? 'Levy'} — Payments</DialogTitle>
          </DialogHeader>
          {levyDetailQuery.isLoading ? (
            <div className="py-8 text-center text-muted-foreground text-sm">Loading…</div>
          ) : levyDetailQuery.data ? (
            <div className="space-y-4 mt-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-black/30 border border-white/10 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Members charged</p>
                  <p className="text-lg font-semibold text-white">{levyDetailQuery.data.summary.total}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {levyDetailQuery.data.summary.paidCount} paid · {levyDetailQuery.data.summary.partialCount} partial · {levyDetailQuery.data.summary.unpaidCount} unpaid
                    {levyDetailQuery.data.summary.waivedCount ? ` · ${levyDetailQuery.data.summary.waivedCount} waived` : ''}
                    {levyDetailQuery.data.summary.refundedCount ? ` · ${levyDetailQuery.data.summary.refundedCount} refunded` : ''}
                  </p>
                </div>
                <div className="bg-black/30 border border-white/10 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Collected</p>
                  <p className="text-lg font-semibold text-green-400">
                    {currencySymbol[levyDetailQuery.data.summary.currency] ?? ''}{parseFloat(levyDetailQuery.data.summary.collected).toLocaleString()}
                  </p>
                </div>
                <div className="bg-black/30 border border-white/10 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Outstanding</p>
                  <p className="text-lg font-semibold text-amber-400">
                    {currencySymbol[levyDetailQuery.data.summary.currency] ?? ''}{parseFloat(levyDetailQuery.data.summary.outstanding).toLocaleString()}
                  </p>
                </div>
                <div className="bg-black/30 border border-white/10 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Refunded / Waived</p>
                  <p className="text-sm font-semibold text-rose-300">
                    {currencySymbol[levyDetailQuery.data.summary.currency] ?? ''}{parseFloat(levyDetailQuery.data.summary.refunded).toLocaleString()} refunded
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {currencySymbol[levyDetailQuery.data.summary.currency] ?? ''}{parseFloat(levyDetailQuery.data.summary.waived).toLocaleString()} waived
                  </p>
                </div>
              </div>
              {(() => {
                const s = levyDetailQuery.data.summary;
                const sentCount = s.reminderSentCount ?? 0;
                const failedCount = s.reminderFailedCount ?? 0;
                const skippedCount = s.reminderSkippedCount ?? 0;
                const unresolvedCount = s.reminderUnresolvedFailedCount ?? failedCount;
                if (sentCount === 0 && failedCount === 0 && skippedCount === 0) return null;
                const channels = Object.entries(s.reminderByChannel ?? {});
                return (
                  <div className={`rounded-lg border p-3 flex flex-wrap items-center justify-between gap-3 ${unresolvedCount > 0 ? 'bg-red-500/5 border-red-500/30' : 'bg-emerald-500/5 border-emerald-500/30'}`} data-testid="levy-reminder-summary">
                    <div className="text-xs text-white/80">
                      <div className="font-medium text-white">
                        Reminder delivery: <span className="text-emerald-300">{sentCount} sent</span>
                        {failedCount > 0 && (
                          <> · <span className="text-red-300" data-testid="levy-reminder-failed-count">{failedCount} failed</span>
                            {unresolvedCount !== failedCount && (
                              <span className="text-white/60"> ({unresolvedCount} still unresolved)</span>
                            )}
                          </>
                        )}
                        {skippedCount > 0 && (
                          <> · <span className="text-amber-300" data-testid="levy-reminder-skipped-count">{skippedCount} skipped (opted out)</span></>
                        )}
                      </div>
                      {channels.length > 0 && (
                        <div className="text-muted-foreground mt-0.5">
                          {channels.map(([ch, v]) => {
                            const u = v.unresolvedFailed ?? v.failed;
                            const sk = v.skipped ?? 0;
                            return (
                              <span key={ch} className="mr-3">
                                {ch.replace('_', ' ')}: {v.sent} sent
                                {v.failed ? `, ${v.failed} failed` : ''}
                                {v.failed && u !== v.failed ? ` (${u} unresolved)` : ''}
                                {sk ? `, ${sk} skipped` : ''}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {unresolvedCount > 0 && (
                      <Button
                        size="sm"
                        disabled={retryingFailed}
                        onClick={retryFailedReminders}
                        className="bg-red-600 hover:bg-red-700 text-white gap-1.5 h-8 text-xs"
                        data-testid="button-retry-failed-reminders"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> {retryingFailed ? 'Retrying…' : `Retry ${unresolvedCount} failed`}
                      </Button>
                    )}
                  </div>
                );
              })()}
              {(() => {
                const s = levyDetailQuery.data.summary;
                const failedReceipts = s.failedReceiptCount ?? 0;
                const skippedReceipts = s.skippedReceiptCount ?? 0;
                const totalToResend = failedReceipts + skippedReceipts;
                if (totalToResend === 0) return null;
                const breakdown: string[] = [];
                if (failedReceipts) breakdown.push(`${failedReceipts} failed`);
                if (skippedReceipts) breakdown.push(`${skippedReceipts} skipped`);
                return (
                  <div className="rounded-lg border p-3 flex flex-wrap items-center justify-between gap-3 bg-rose-500/5 border-rose-500/30" data-testid="levy-receipt-summary">
                    <div className="text-xs text-white/80">
                      <div className="font-medium text-white flex items-center gap-1.5">
                        <MailX className="w-3.5 h-3.5 text-rose-300" />
                        Receipts needing attention: <span className="text-rose-300" data-testid="levy-failed-receipt-count">{totalToResend}</span>
                      </div>
                      <div className="text-muted-foreground mt-0.5">
                        {breakdown.join(' · ')} — replays the most recent payment, refund or waiver receipt for each affected charge.
                      </div>
                    </div>
                    <Button
                      size="sm"
                      disabled={bulkResendingReceipts}
                      onClick={openBulkResendPreview}
                      className="bg-rose-600 hover:bg-rose-700 text-white gap-1.5 h-8 text-xs"
                      data-testid="button-bulk-resend-receipts"
                    >
                      <Send className="w-3.5 h-3.5" />
                      {bulkResendingReceipts
                        ? 'Resending…'
                        : skippedReceipts && failedReceipts
                          ? `Resend all ${totalToResend} failed/skipped`
                          : skippedReceipts
                            ? `Resend all ${totalToResend} skipped`
                            : `Resend all ${totalToResend} failed`}
                    </Button>
                  </div>
                );
              })()}
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setReminderHistoryOpen(o => !o)}
                  className="text-muted-foreground hover:text-white hover:bg-white/5 h-7 text-xs gap-1.5 px-2"
                  data-testid="button-toggle-reminder-history"
                >
                  {reminderHistoryOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <History className="w-3.5 h-3.5" />
                  {reminderHistoryOpen ? 'Hide reminder history' : 'Show reminder history'}
                </Button>
                {reminderHistoryOpen && orgId != null && openLevyId != null && (
                  <div className="mt-2 space-y-3">
                    <LevyLedgerEmailSchedulePanel orgId={orgId} levyId={openLevyId} />
                    <LevyReminderHistory orgId={orgId} levyId={openLevyId} />
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{levyDetailQuery.data.summary.unpaidCount} unpaid charge{levyDetailQuery.data.summary.unpaidCount === 1 ? '' : 's'}</p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setExportLedgerForm({ from: '', to: '', type: 'all', notes: '' });
                      setExportLedgerOpen(true);
                    }}
                    className="border-white/10 text-white hover:bg-white/5 gap-1.5 h-8 text-xs"
                    data-testid="button-export-levy-ledger"
                  >
                    <Download className="w-3.5 h-3.5" /> Export ledger
                  </Button>
                  <Button
                    size="sm"
                    disabled={levyDetailQuery.data.summary.unpaidCount === 0}
                    onClick={() => {
                      const d = levyDetailQuery.data!;
                      setReminderForm({
                        channel: 'in_app',
                        subject: `Reminder: ${d.levy.name} outstanding`,
                        body: '',
                      });
                      setReminderOpen(true);
                    }}
                    className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5 h-8 text-xs disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" /> Send reminder to unpaid
                  </Button>
                </div>
              </div>
              <div className="border border-white/10 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-black/30 text-xs text-muted-foreground uppercase tracking-wider">
                    <tr>
                      <th className="text-left px-3 py-2">Member</th>
                      <th className="text-left px-3 py-2">Charge</th>
                      <th className="text-left px-3 py-2">Paid / Refunded</th>
                      <th className="text-left px-3 py-2">Balance</th>
                      <th className="text-left px-3 py-2">Status</th>
                      <th className="text-left px-3 py-2">Receipt</th>
                      <th className="text-right px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {levyDetailQuery.data.charges.map(c => {
                      const sym = currencySymbol[levyDetailQuery.data!.summary.currency] ?? '';
                      const amt = parseFloat(c.amount);
                      const paidAmt = parseFloat(c.paidAmount || '0');
                      const refundedAmt = parseFloat(c.refundedAmount || '0');
                      const balance = Math.max(0, +(amt - paidAmt - refundedAmt).toFixed(2));
                      const settled = c.status === 'paid' || c.status === 'waived' || c.status === 'refunded';
                      const canRefund = paidAmt - refundedAmt > 0;
                      const canWaive = c.status === 'unpaid' || c.status === 'partial';
                      const statusBadge =
                        c.status === 'paid' ? <Badge className="bg-green-500/20 text-green-400 border-green-500/30 border text-xs">Paid{c.paidAt ? ` ${new Date(c.paidAt).toLocaleDateString()}` : ''}</Badge> :
                        c.status === 'partial' ? <Badge className="bg-blue-500/20 text-blue-300 border-blue-500/30 border text-xs">Partial</Badge> :
                        c.status === 'waived' ? <Badge className="bg-purple-500/20 text-purple-300 border-purple-500/30 border text-xs" title={c.waivedReason ?? undefined}>Waived</Badge> :
                        c.status === 'refunded' ? <Badge className="bg-rose-500/20 text-rose-300 border-rose-500/30 border text-xs">Refunded</Badge> :
                        <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 border text-xs">Unpaid</Badge>;
                      const activityOpen = activityChargeId === c.id;
                      const isHighlighted = highlightMemberId === c.clubMemberId;
                      return (
                        <Fragment key={c.id}>
                        <tr
                          id={`levy-charge-row-${c.id}`}
                          className={`border-t border-white/5 transition-shadow ${isHighlighted ? 'bg-amber-500/10 ring-1 ring-amber-500/40' : ''}`}
                          data-testid={isHighlighted ? `row-highlighted-${c.clubMemberId}` : `levy-charge-row-${c.id}`}
                        >
                          <td className="px-3 py-2 text-white">
                            <div className="font-medium">{c.firstName} {c.lastName}</div>
                            <div className="text-xs text-muted-foreground">{c.memberNumber ?? '—'}{c.email ? ` · ${c.email}` : ''}</div>
                          </td>
                          <td className="px-3 py-2 text-amber-400">
                            {sym}{amt.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-xs text-white">
                            <div className="text-green-400">{sym}{paidAmt.toLocaleString()} paid</div>
                            {refundedAmt > 0 && <div className="text-rose-300">{sym}{refundedAmt.toLocaleString()} refunded</div>}
                          </td>
                          <td className="px-3 py-2">
                            <span className={balance > 0 ? 'text-amber-400 font-semibold' : 'text-muted-foreground'}>
                              {sym}{balance.toLocaleString()}
                            </span>
                          </td>
                          <td className="px-3 py-2">{statusBadge}</td>
                          <td className="px-3 py-2">
                            {(() => {
                              const rs = c.lastReceiptStatus;
                              if (!rs) {
                                return <span className="text-xs text-muted-foreground" data-testid={`receipt-status-${c.id}`}>—</span>;
                              }
                              const at = c.lastReceiptAt ? new Date(c.lastReceiptAt) : null;
                              const tsLabel = at ? at.toLocaleString() : '';
                              const kindLabel = c.lastReceiptKind === 'partial_payment' ? 'partial payment'
                                : c.lastReceiptKind ?? '';
                              const baseTitle = `${kindLabel ? `${kindLabel} receipt — ` : ''}${tsLabel}`;
                              if (rs === 'sent') {
                                return (
                                  <div className="flex items-center gap-1.5" data-testid={`receipt-status-${c.id}`}>
                                    <Badge
                                      className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 border text-xs gap-1"
                                      title={baseTitle}
                                    >
                                      <MailCheck className="w-3 h-3" /> Sent
                                    </Badge>
                                    {at && <span className="text-[10px] text-muted-foreground">{at.toLocaleDateString()}</span>}
                                  </div>
                                );
                              }
                              const reasonText = c.lastReceiptReason
                                ? c.lastReceiptReason === 'no_email' ? 'No email on file'
                                : c.lastReceiptReason === 'billing_email_opted_out' ? 'Billing email opt-out'
                                : c.lastReceiptReason
                                : (rs === 'skipped' ? 'Skipped' : 'Send failed');
                              return (
                                <div className="flex items-center gap-1.5 flex-wrap" data-testid={`receipt-status-${c.id}`}>
                                  <Badge
                                    className={rs === 'failed'
                                      ? 'bg-rose-500/20 text-rose-300 border-rose-500/30 border text-xs gap-1'
                                      : 'bg-amber-500/20 text-amber-300 border-amber-500/30 border text-xs gap-1'}
                                    title={`${baseTitle}${reasonText ? ` — ${reasonText}` : ''}`}
                                  >
                                    {rs === 'failed' ? <MailX className="w-3 h-3" /> : <MailWarning className="w-3 h-3" />}
                                    {rs === 'failed' ? 'Failed' : 'Skipped'}
                                  </Badge>
                                  <span className="text-[10px] text-muted-foreground" title={reasonText}>{reasonText}</span>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={resendReceiptChargeId === c.id}
                                    onClick={() => resendLevyReceipt(c)}
                                    className="h-6 px-2 text-[11px] text-amber-300 hover:bg-white/5 gap-1"
                                    data-testid={`button-resend-receipt-${c.id}`}
                                  >
                                    <Send className="w-3 h-3" />
                                    {resendReceiptChargeId === c.id ? 'Sending…' : 'Resend'}
                                  </Button>
                                </div>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="inline-flex items-center gap-1.5 flex-wrap justify-end">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setActivityChargeId(activityOpen ? null : c.id)}
                                className="text-muted-foreground hover:text-white hover:bg-white/5 h-7 text-xs gap-1.5"
                                data-testid={`button-activity-${c.id}`}
                                title="Show payment activity"
                              >
                                <History className="w-3 h-3" />
                                {activityOpen ? 'Hide activity' : 'Activity'}
                              </Button>
                              {!settled && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={payingChargeId === c.id || chargeActionSubmitting}
                                  onClick={() => openChargeAction(c, 'payment')}
                                  className="border-white/10 text-white hover:bg-white/5 h-7 text-xs gap-1.5"
                                  data-testid={`button-record-payment-${c.id}`}
                                >
                                  <CheckCircle2 className="w-3 h-3" />
                                  Record payment
                                </Button>
                              )}
                              {canRefund && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={chargeActionSubmitting}
                                  onClick={() => openChargeAction(c, 'refund')}
                                  className="border-rose-500/30 text-rose-200 hover:bg-rose-500/10 h-7 text-xs gap-1.5"
                                  data-testid={`button-refund-${c.id}`}
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  Refund
                                </Button>
                              )}
                              {canWaive && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={chargeActionSubmitting}
                                  onClick={() => openChargeAction(c, 'waive')}
                                  className="border-purple-500/30 text-purple-200 hover:bg-purple-500/10 h-7 text-xs gap-1.5"
                                  data-testid={`button-waive-${c.id}`}
                                >
                                  <Ban className="w-3 h-3" />
                                  Waive
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {activityOpen && (
                          <tr className="border-t border-white/5 bg-black/20">
                            <td colSpan={7} className="p-0">
                              <LevyChargeActivity
                                orgId={orgId!}
                                levyId={openLevyId!}
                                memberId={c.clubMemberId}
                                currency={levyDetailQuery.data!.summary.currency}
                              />
                              <LevyChargeReceipts
                                orgId={orgId!}
                                levyId={openLevyId!}
                                memberId={c.clubMemberId}
                              />
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                    {levyDetailQuery.data.charges.length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground text-xs">No charges recorded for this levy.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground text-sm">Could not load this levy.</div>
          )}
        </DialogContent>
      </Dialog>

      {/* Send Reminder Dialog */}
      <Dialog open={reminderOpen} onOpenChange={open => { if (!open) setReminderOpen(false); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>Send reminder to unpaid members</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Channel</label>
              <Select value={reminderForm.channel} onValueChange={v => setReminderForm(f => ({ ...f, channel: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {['in_app','email','sms','whatsapp'].map(c => <SelectItem key={c} value={c} className="text-white hover:bg-white/5">{c.replace('_',' ')}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Subject</label>
              <Input value={reminderForm.subject} onChange={e => setReminderForm(f => ({ ...f, subject: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Message (leave blank for default)</label>
              <Textarea value={reminderForm.body} onChange={e => setReminderForm(f => ({ ...f, body: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white min-h-[100px]" placeholder="Default reminder text will include the levy name, amount and due date." />
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={sendLevyReminder} disabled={reminderSending} className="flex-1 bg-amber-600 hover:bg-amber-700 text-white">
                {reminderSending ? 'Sending…' : 'Send reminders'}
              </Button>
              <Button variant="outline" onClick={() => setReminderOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Export Levy Ledger Dialog */}
      <Dialog open={exportLedgerOpen} onOpenChange={open => { if (!open) { setExportLedgerOpen(false); setEmailLedgerRecipients(''); setEmailLedgerMessage(''); } }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>Export levy payment ledger</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <p className="text-xs text-muted-foreground">
              Downloads a ledger of every payment, refund and waive event on this levy with date, member, type, amount, method, processor reference, note/reason and actor. Choose CSV for spreadsheets or PDF for a paginated, club-branded copy auditors can sign. Leave the filters empty to export everything.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">From</label>
                <Input type="date" value={exportLedgerForm.from} onChange={e => setExportLedgerForm(f => ({ ...f, from: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" data-testid="input-export-from" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">To</label>
                <Input type="date" value={exportLedgerForm.to} onChange={e => setExportLedgerForm(f => ({ ...f, to: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" data-testid="input-export-to" />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Event type</label>
              <Select value={exportLedgerForm.type} onValueChange={v => setExportLedgerForm(f => ({ ...f, type: v as typeof f.type }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white" data-testid="select-export-type"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  <SelectItem value="all" className="text-white hover:bg-white/5">All events</SelectItem>
                  <SelectItem value="payment" className="text-white hover:bg-white/5">Payments</SelectItem>
                  <SelectItem value="refund" className="text-white hover:bg-white/5">Refunds</SelectItem>
                  <SelectItem value="waive" className="text-white hover:bg-white/5">Waives</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Notes for auditor (PDF only)</label>
              <Textarea
                value={exportLedgerForm.notes}
                onChange={e => setExportLedgerForm(f => ({ ...f, notes: e.target.value.slice(0, 1000) }))}
                placeholder="Optional notes printed in the signature panel on the last page."
                rows={3}
                maxLength={1000}
                className="mt-1 bg-black/40 border-white/10 text-white text-sm"
                data-testid="input-export-notes"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">{exportLedgerForm.notes.length}/1000</p>
            </div>
            <div className="flex gap-3 pt-2">
              {(['csv', 'pdf'] as const).map(format => (
                <Button
                  key={format}
                  onClick={() => {
                    if (!openLevyId || !orgId) return;
                    if (exportLedgerForm.from && exportLedgerForm.to && exportLedgerForm.from > exportLedgerForm.to) {
                      toast({ title: 'Invalid date range', description: 'The "from" date must be on or before the "to" date.', variant: 'destructive' });
                      return;
                    }
                    const params = new URLSearchParams();
                    params.set('levyId', String(openLevyId));
                    if (exportLedgerForm.from) params.set('from', new Date(exportLedgerForm.from).toISOString());
                    if (exportLedgerForm.to) {
                      const d = new Date(exportLedgerForm.to);
                      d.setHours(23, 59, 59, 999);
                      params.set('to', d.toISOString());
                    }
                    if (exportLedgerForm.type !== 'all') params.set('type', exportLedgerForm.type);
                    if (format === 'pdf' && exportLedgerForm.notes.trim()) {
                      params.set('notes', exportLedgerForm.notes.trim());
                    }
                    const url = `${BASE}/api/organizations/${orgId}/members-360/levy-ledger.${format}?${params.toString()}`;
                    window.location.href = url;
                    setExportLedgerOpen(false);
                  }}
                  className={`flex-1 text-white gap-1.5 ${format === 'csv' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}
                  data-testid={`button-download-levy-ledger-${format}`}
                >
                  <Download className="w-4 h-4" /> Download {format.toUpperCase()}
                </Button>
              ))}
              <Button variant="outline" onClick={() => setExportLedgerOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
            <Separator className="bg-white/10" />
            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium text-white">Email PDF to auditor</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Sends the same PDF as an attachment with the period and totals in the body. The send is logged in the audit trail.
                </p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Recipient(s)</label>
                <Input
                  value={emailLedgerRecipients}
                  onChange={e => setEmailLedgerRecipients(e.target.value)}
                  placeholder="auditor@example.com, partner@firm.com"
                  className="mt-1 bg-black/40 border-white/10 text-white"
                  data-testid="input-email-ledger-recipients"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Separate multiple addresses with commas. Up to 20.</p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Message (optional)</label>
                <Textarea
                  value={emailLedgerMessage}
                  onChange={e => setEmailLedgerMessage(e.target.value)}
                  placeholder="Add a short note for the auditor…"
                  className="mt-1 bg-black/40 border-white/10 text-white min-h-[60px]"
                  maxLength={2000}
                  data-testid="input-email-ledger-message"
                />
              </div>
              <Button
                disabled={emailLedgerSending || !emailLedgerRecipients.trim()}
                onClick={async () => {
                  if (!openLevyId || !orgId) return;
                  if (exportLedgerForm.from && exportLedgerForm.to && exportLedgerForm.from > exportLedgerForm.to) {
                    toast({ title: 'Invalid date range', description: 'The "from" date must be on or before the "to" date.', variant: 'destructive' });
                    return;
                  }
                  const recipients = emailLedgerRecipients.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
                  const invalid = recipients.filter(r => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
                  if (recipients.length === 0) {
                    toast({ title: 'Recipient required', description: 'Add at least one auditor email address.', variant: 'destructive' });
                    return;
                  }
                  if (invalid.length) {
                    toast({ title: 'Invalid email', description: invalid.join(', '), variant: 'destructive' });
                    return;
                  }
                  const params = new URLSearchParams();
                  params.set('levyId', String(openLevyId));
                  if (exportLedgerForm.from) params.set('from', new Date(exportLedgerForm.from).toISOString());
                  if (exportLedgerForm.to) {
                    const d = new Date(exportLedgerForm.to);
                    d.setHours(23, 59, 59, 999);
                    params.set('to', d.toISOString());
                  }
                  if (exportLedgerForm.type !== 'all') params.set('type', exportLedgerForm.type);
                  setEmailLedgerSending(true);
                  try {
                    const r = await fetch(`${BASE}/api/organizations/${orgId}/members-360/levy-ledger.pdf/email?${params.toString()}`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ recipients, message: emailLedgerMessage.trim() || undefined }),
                    });
                    const data = await r.json().catch(() => ({}));
                    if (!r.ok) throw new Error(data.error || data.errorMessage || `HTTP ${r.status}`);
                    toast({
                      title: 'Email sent',
                      description: `Delivered the ledger PDF (${data.rowCount ?? 0} row${data.rowCount === 1 ? '' : 's'}) to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.`,
                    });
                    setEmailLedgerRecipients('');
                    setEmailLedgerMessage('');
                    queryClient.invalidateQueries({ queryKey: ['levy-email-pdf-history', orgId, openLevyId] });
                    setExportLedgerOpen(false);
                  } catch (err) {
                    toast({ title: 'Send failed', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
                    queryClient.invalidateQueries({ queryKey: ['levy-email-pdf-history', orgId, openLevyId] });
                  } finally {
                    setEmailLedgerSending(false);
                  }
                }}
                className="w-full bg-sky-600 hover:bg-sky-700 text-white gap-1.5"
                data-testid="button-email-ledger-pdf"
              >
                <Mail className="w-4 h-4" /> {emailLedgerSending ? 'Sending…' : 'Email PDF to auditor'}
              </Button>
            </div>
            {openLevyId && orgId && (
              <LevyEmailPdfHistoryPanel orgId={orgId} levyId={openLevyId} />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Levy Charge Action Dialog (payment / refund / waive) */}
      <Dialog open={chargeAction != null} onOpenChange={open => { if (!open) setChargeAction(null); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>
              {chargeAction?.kind === 'payment' && 'Record payment'}
              {chargeAction?.kind === 'refund' && 'Record refund'}
              {chargeAction?.kind === 'waive' && 'Waive charge'}
              {chargeAction && ` — ${chargeAction.charge.firstName} ${chargeAction.charge.lastName}`}
            </DialogTitle>
          </DialogHeader>
          {chargeAction && (() => {
            const sym = currencySymbol[levyDetailQuery.data?.summary.currency ?? 'INR'] ?? '';
            const c = chargeAction.charge;
            const amt = parseFloat(c.amount);
            const paidAmt = parseFloat(c.paidAmount || '0');
            const refundedAmt = parseFloat(c.refundedAmount || '0');
            const balance = Math.max(0, +(amt - paidAmt - refundedAmt).toFixed(2));
            const refundable = Math.max(0, +(paidAmt - refundedAmt).toFixed(2));
            return (
              <div className="space-y-4 mt-2">
                <div className="bg-black/30 border border-white/10 rounded-lg p-3 text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">Total charge</span><span className="text-white">{sym}{amt.toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Already paid</span><span className="text-green-400">{sym}{paidAmt.toLocaleString()}</span></div>
                  {refundedAmt > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Already refunded</span><span className="text-rose-300">{sym}{refundedAmt.toLocaleString()}</span></div>}
                  <div className="flex justify-between font-semibold"><span className="text-muted-foreground">Outstanding balance</span><span className="text-amber-400">{sym}{balance.toLocaleString()}</span></div>
                  {chargeAction.kind === 'refund' && (
                    <div className="flex justify-between font-semibold"><span className="text-muted-foreground">Refundable</span><span className="text-rose-300">{sym}{refundable.toLocaleString()}</span></div>
                  )}
                </div>
                {(chargeAction.kind === 'payment' || chargeAction.kind === 'refund') && (
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">
                      {chargeAction.kind === 'payment' ? 'Payment amount *' : 'Refund amount *'}
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={chargeActionForm.amount}
                      onChange={e => setChargeActionForm(f => ({ ...f, amount: e.target.value }))}
                      className="mt-1 bg-black/40 border-white/10 text-white"
                      data-testid="input-charge-action-amount"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {chargeAction.kind === 'payment'
                        ? `Up to ${sym}${balance.toLocaleString()}. Enter a smaller amount to record a partial payment.`
                        : `Up to ${sym}${refundable.toLocaleString()}.`}
                    </p>
                  </div>
                )}
                {chargeAction.kind === 'payment' && (
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">Note (optional)</label>
                    <Input
                      value={chargeActionForm.note}
                      onChange={e => setChargeActionForm(f => ({ ...f, note: e.target.value }))}
                      placeholder="e.g. cash at front desk, cheque #123"
                      className="mt-1 bg-black/40 border-white/10 text-white"
                      data-testid="input-charge-action-note"
                    />
                  </div>
                )}
                {(chargeAction.kind === 'payment' || chargeAction.kind === 'refund') && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground uppercase tracking-wider">Method (optional)</label>
                      <Select value={chargeActionForm.method || '__none'} onValueChange={v => setChargeActionForm(f => ({ ...f, method: v === '__none' ? '' : v }))}>
                        <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white" data-testid="select-charge-action-method"><SelectValue placeholder="Select method" /></SelectTrigger>
                        <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                          <SelectItem value="__none" className="text-white hover:bg-white/5">—</SelectItem>
                          {['cash','card','bank_transfer','online','cheque','credit_note','other'].map(m => (
                            <SelectItem key={m} value={m} className="text-white hover:bg-white/5">{m.replace('_',' ')}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground uppercase tracking-wider">Reference (optional)</label>
                      <Input
                        value={chargeActionForm.processorReference}
                        onChange={e => setChargeActionForm(f => ({ ...f, processorReference: e.target.value }))}
                        placeholder="e.g. UPI ref, receipt #"
                        className="mt-1 bg-black/40 border-white/10 text-white"
                        data-testid="input-charge-action-reference"
                      />
                    </div>
                  </div>
                )}
                {(chargeAction.kind === 'refund' || chargeAction.kind === 'waive') && (
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">Reason *</label>
                    <Textarea
                      value={chargeActionForm.reason}
                      onChange={e => setChargeActionForm(f => ({ ...f, reason: e.target.value }))}
                      placeholder={chargeAction.kind === 'refund' ? 'e.g. duplicate charge, member resigned' : 'e.g. financial hardship, board approval'}
                      className="mt-1 bg-black/40 border-white/10 text-white min-h-[80px]"
                      data-testid="textarea-charge-action-reason"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">Captured in the audit log for compliance.</p>
                  </div>
                )}
                <div className="flex gap-3 pt-2">
                  <Button
                    onClick={submitChargeAction}
                    disabled={chargeActionSubmitting}
                    className={
                      chargeAction.kind === 'payment'
                        ? 'flex-1 bg-emerald-600 hover:bg-emerald-700 text-white'
                        : chargeAction.kind === 'refund'
                          ? 'flex-1 bg-rose-600 hover:bg-rose-700 text-white'
                          : 'flex-1 bg-purple-600 hover:bg-purple-700 text-white'
                    }
                    data-testid="button-charge-action-submit"
                  >
                    {chargeActionSubmitting ? 'Saving…' : (
                      chargeAction.kind === 'payment' ? 'Record payment' :
                      chargeAction.kind === 'refund' ? 'Record refund' : 'Waive charge'
                    )}
                  </Button>
                  <Button variant="outline" onClick={() => setChargeAction(null)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Edit Member Dialog */}
      <Dialog open={editMemberId != null} onOpenChange={open => { if (!open) setEditMemberId(null); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit Club Member</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">First Name *</label>
                <Input value={editForm.firstName} onChange={e => setEditForm(f => ({ ...f, firstName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Last Name *</label>
                <Input value={editForm.lastName} onChange={e => setEditForm(f => ({ ...f, lastName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            </div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Email</label>
              <Input type="email" value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Phone</label>
              <Input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Membership Tier</label>
              <Select value={editForm.tierId} onValueChange={v => setEditForm(f => ({ ...f, tierId: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue placeholder="Select tier…" /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {tiers.map(t => <SelectItem key={t.id} value={String(t.id)} className="text-white hover:bg-white/5">{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Handicap Index</label>
                <Input type="number" value={editForm.handicapIndex} onChange={e => setEditForm(f => ({ ...f, handicapIndex: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">WHS/GHIN Number</label>
                <Input value={editForm.whsGhinNumber} onChange={e => setEditForm(f => ({ ...f, whsGhinNumber: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Renewal Date</label>
                <Input type="date" value={editForm.renewalDate} onChange={e => setEditForm(f => ({ ...f, renewalDate: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Subscription Status</label>
                <Select value={editForm.subscriptionStatus} onValueChange={v => setEditForm(f => ({ ...f, subscriptionStatus: v }))}>
                  <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    {['active', 'past_due', 'cancelled', 'expired', 'pending'].map(s => (
                      <SelectItem key={s} value={s} className="text-white hover:bg-white/5">{s.replace('_', ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between bg-black/30 border border-white/10 rounded-lg px-3 py-2.5">
              <div>
                <p className="text-sm text-white">Show in directory</p>
                <p className="text-xs text-muted-foreground">Display this member in the club directory</p>
              </div>
              <Switch checked={editForm.showInDirectory} onCheckedChange={v => setEditForm(f => ({ ...f, showInDirectory: v }))} />
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={updateMember} disabled={saving} className="flex-1 bg-primary hover:bg-primary/90 text-white">{saving ? 'Saving…' : 'Save Changes'}</Button>
              <Button variant="outline" onClick={() => setEditMemberId(null)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Member Dialog */}
      <Dialog open={addMemberOpen} onOpenChange={setAddMemberOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg">
          <DialogHeader><DialogTitle>Add Club Member</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">First Name *</label>
                <Input value={memberForm.firstName} onChange={e => setMemberForm(f => ({ ...f, firstName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Last Name *</label>
                <Input value={memberForm.lastName} onChange={e => setMemberForm(f => ({ ...f, lastName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            </div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Email</label>
              <Input type="email" value={memberForm.email} onChange={e => setMemberForm(f => ({ ...f, email: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Phone</label>
              <Input value={memberForm.phone} onChange={e => setMemberForm(f => ({ ...f, phone: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Membership Tier</label>
              <Select value={memberForm.tierId} onValueChange={v => setMemberForm(f => ({ ...f, tierId: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue placeholder="Select tier…" /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {tiers.map(t => <SelectItem key={t.id} value={String(t.id)} className="text-white hover:bg-white/5">{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Handicap Index</label>
                <Input type="number" value={memberForm.handicapIndex} onChange={e => setMemberForm(f => ({ ...f, handicapIndex: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">WHS/GHIN Number</label>
                <Input value={memberForm.whsGhinNumber} onChange={e => setMemberForm(f => ({ ...f, whsGhinNumber: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={saveMember} disabled={saving} className="flex-1 bg-primary hover:bg-primary/90 text-white">{saving ? 'Adding…' : 'Add Member'}</Button>
              <Button variant="outline" onClick={() => setAddMemberOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Member Account Charges Dialog */}
      <Dialog open={!!chargesMemberId} onOpenChange={open => { if (!open) setChargesMemberId(null); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="w-5 h-5 text-primary" />
              Account Charges — {chargesMemberName}
            </DialogTitle>
          </DialogHeader>
          {chargesQuery.isLoading && <div className="py-8 text-center text-muted-foreground">Loading...</div>}
          {chargesQuery.data && (
            <div className="space-y-4">
              <div className="bg-primary/10 border border-primary/20 rounded-lg p-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-5 h-5 text-primary" />
                  <span className="font-medium">Outstanding Balance</span>
                </div>
                <span className="text-xl font-bold">₹{chargesQuery.data.outstandingBalance.toFixed(2)}</span>
              </div>

              {chargesQuery.data.outstandingBalance > 0 && (
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground uppercase tracking-wider">Settlement Note</label>
                  <Input
                    value={settleNote}
                    onChange={e => setSettleNote(e.target.value)}
                    placeholder="Month-end settlement"
                    className="bg-black/40 border-white/10 text-white"
                  />
                  <Button
                    onClick={() => settleAllMutation.mutate()}
                    disabled={settleAllMutation.isPending}
                    className="w-full bg-emerald-700 hover:bg-emerald-800 text-white"
                  >
                    {settleAllMutation.isPending ? 'Settling...' : 'Settle All Outstanding Charges'}
                  </Button>
                </div>
              )}

              <Separator className="border-white/10" />

              <div className="max-h-64 overflow-y-auto space-y-2">
                {chargesQuery.data.charges.length === 0 && (
                  <p className="text-muted-foreground text-sm text-center py-4">No account charges found</p>
                )}
                {chargesQuery.data.charges.map((charge: MemberAccountCharge) => (
                  <div key={charge.id} className={`rounded-lg px-3 py-2 text-sm flex justify-between items-center ${charge.isSettled ? 'bg-white/5 opacity-60' : 'bg-white/10'}`}>
                    <div>
                      <div className="font-medium">{charge.description ?? 'Pro shop charge'}</div>
                      <div className="text-xs text-muted-foreground">{new Date(charge.createdAt).toLocaleDateString()}</div>
                      {charge.isSettled && charge.settlementNote && (
                        <div className="text-xs text-green-400">{charge.settlementNote}</div>
                      )}
                    </div>
                    <div className="text-right">
                      <div className={`font-bold ${charge.isSettled ? 'text-muted-foreground line-through' : 'text-white'}`}>
                        ₹{parseFloat(charge.amount).toFixed(2)}
                      </div>
                      <Badge variant={charge.isSettled ? 'secondary' : 'default'} className="text-xs">
                        {charge.isSettled ? 'Settled' : 'Outstanding'}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setChargesMemberId(null)} className="border-white/10 text-white hover:bg-white/5">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Tier Dialog */}
      <Dialog open={addTierOpen} onOpenChange={setAddTierOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>Create Membership Tier</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Tier Name *</label>
              <Input value={tierForm.name} onChange={e => setTierForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Full Member, Social, Junior" className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Description</label>
              <Input value={tierForm.description} onChange={e => setTierForm(f => ({ ...f, description: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div className="flex gap-3">
              <div className="flex-1"><label className="text-xs text-muted-foreground uppercase tracking-wider">Annual Fee</label>
                <Input type="number" value={tierForm.annualFee} onChange={e => setTierForm(f => ({ ...f, annualFee: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div className="w-28"><label className="text-xs text-muted-foreground uppercase tracking-wider">Currency</label>
                <Select value={tierForm.currency} onValueChange={v => setTierForm(f => ({ ...f, currency: v }))}>
                  <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    {['INR', 'USD', 'GBP', 'EUR'].map(c => <SelectItem key={c} value={c} className="text-white hover:bg-white/5">{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Grace Period (days)</label>
              <Input type="number" value={tierForm.gracePeriodDays} onChange={e => setTierForm(f => ({ ...f, gracePeriodDays: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <p className="text-xs text-muted-foreground">A Razorpay subscription plan will be automatically created for this tier if Razorpay is configured.</p>
            <div className="flex gap-3 pt-2">
              <Button onClick={saveTier} disabled={saving} className="flex-1 bg-emerald-700 hover:bg-emerald-800 text-white">{saving ? 'Creating…' : 'Create Tier'}</Button>
              <Button variant="outline" onClick={() => setAddTierOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
