import { useState, useEffect, useCallback, useRef } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Wallet, Users, Play, CheckCircle2, IndianRupee, RefreshCw, Download, History, ShieldCheck, BellRing, BellOff, Send } from 'lucide-react';
import {
  COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  COACH_PAYOUT_MAX_SMS_ATTEMPTS,
  type CoachPayoutChannelLabel,
  type CoachPayoutNotificationAttempt,
  coachPayoutChannelLabel as channelLabel,
  isCoachPayoutChannelResettable as isResettable,
  coachPayoutChannelBadgeStyle as channelBadgeStyle,
  coachPayoutChannelText as channelText,
} from '@workspace/coach-payout-labels';

const GOLD = '#C9A84C';
const formatRupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

const csvEscape = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const rupeesPlain = (paise: number) => (paise / 100).toFixed(2);

interface PayoutAccountHistoryEntry {
  id: number;
  proId?: number;
  proName?: string | null;
  changeKind: string;
  method: string;
  accountHolderName: string | null;
  upiVpaMasked: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  payoutAccountId: string | null;
  changedByUserId: number | null;
  changedByRole: string | null;
  changedByName: string | null;
  // Task #1222 — populated for `admin_reverify` rows; null for legacy
  // `created` / `updated` rows.
  verificationOutcome: string | null;
  verificationReason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

// Task #1222 — Friendly label for the audit-row change kind. Keeps the
// CSV column human-readable and the in-app history list consistent.
function changeKindLabel(h: PayoutAccountHistoryEntry): string {
  if (h.changeKind === 'created') return 'Account added';
  if (h.changeKind === 'admin_reverify') {
    const outcome = h.verificationOutcome ?? 'unknown';
    return `Admin re-verified (${outcome})`;
  }
  return 'Account updated';
}

// Task #1427 — change-type filter values shared by the per-coach dialog
// and the org-wide CSV export controls. Mirrors the API's accepted
// `changeKind` query-parameter values plus an `all` sentinel.
type ChangeKindFilter = 'all' | 'created' | 'updated' | 'admin_reverify';
const CHANGE_KIND_FILTER_OPTIONS: { value: ChangeKindFilter; label: string; chipLabel: string }[] = [
  { value: 'all', label: 'All change types', chipLabel: 'All' },
  { value: 'created', label: 'Account added', chipLabel: 'Account added' },
  { value: 'updated', label: 'Account updated', chipLabel: 'Account updated' },
  { value: 'admin_reverify', label: 'Admin re-verified payout', chipLabel: 'Admin re-verifications' },
];

// Task #1719 — the per-coach payout-history dialog deep-link is encoded
// in the URL hash. Two shapes are supported:
//   • `#payout-history`                   — open the dialog with the
//                                           default ("All change types")
//                                           filter (back-compat with
//                                           Task #1223 admin emails).
//   • `#payout-history=:changeKind`       — open the dialog and pre-
//                                           apply the matching filter
//                                           chip (e.g. so the admin
//                                           re-verify email can land on
//                                           "Admin re-verifications").
// Returned `kind` falls back to "all" for unknown values so a typo in
// the hash never breaks the dialog.
const PAYOUT_HISTORY_HASH = '#payout-history';
function parsePayoutHistoryHash(hash: string): { matches: boolean; kind: ChangeKindFilter } {
  if (!hash.startsWith(PAYOUT_HISTORY_HASH)) return { matches: false, kind: 'all' };
  const rest = hash.slice(PAYOUT_HISTORY_HASH.length);
  if (rest === '') return { matches: true, kind: 'all' };
  if (rest[0] !== '=') return { matches: false, kind: 'all' };
  const candidate = rest.slice(1);
  const known = CHANGE_KIND_FILTER_OPTIONS.find(o => o.value === candidate);
  return { matches: true, kind: known ? known.value : 'all' };
}
function buildPayoutHistoryHash(kind: ChangeKindFilter): string {
  return kind === 'all' ? PAYOUT_HISTORY_HASH : `${PAYOUT_HISTORY_HASH}=${kind}`;
}

function maskedDetails(h: PayoutAccountHistoryEntry): string {
  if (h.method === 'upi') return h.upiVpaMasked ? `UPI ${h.upiVpaMasked}` : 'UPI';
  if (h.method === 'bank_account') {
    const acc = h.bankAccountLast4 ? `Account ****${h.bankAccountLast4}` : 'Bank account';
    return h.bankIfsc ? `${acc} (IFSC ${h.bankIfsc})` : acc;
  }
  return h.method;
}

function downloadCsv(filename: string, lines: string[]) {
  const csv = '\ufeff' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportPayoutAccountHistoryCsv(
  filename: string,
  history: PayoutAccountHistoryEntry[],
  fallbackCoachName?: string,
) {
  const header = [
    'Timestamp',
    'Coach',
    'Change',
    'Method',
    'Masked details',
    'Account holder',
    'Payout account ID',
    'Changed by',
    'Role',
    // Task #1222 — surface the verification outcome/reason for
    // `admin_reverify` rows so the compliance/finance audit feed is
    // self-contained (no need to cross-reference logs).
    'Verification outcome',
    'Verification reason',
    'IP',
  ];
  const lines = [header.join(',')];
  for (const h of history) {
    lines.push([
      csvEscape(new Date(h.createdAt).toISOString()),
      csvEscape(h.proName ?? fallbackCoachName ?? ''),
      csvEscape(h.changeKind),
      csvEscape(h.method),
      csvEscape(maskedDetails(h)),
      csvEscape(h.accountHolderName ?? ''),
      csvEscape(h.payoutAccountId ?? ''),
      csvEscape(h.changedByName ?? ''),
      csvEscape(h.changedByRole ?? ''),
      csvEscape(h.verificationOutcome ?? ''),
      csvEscape(h.verificationReason ?? ''),
      csvEscape(h.ipAddress ?? ''),
    ].join(','));
  }
  downloadCsv(filename, lines);
}

function exportPayoutsCsv(rows: PayoutRow[]) {
  const header = [
    'Coach',
    'Period start',
    'Period end',
    'Gross (₹)',
    'Platform fee (₹)',
    'Net (₹)',
    'Status',
    'Paid date',
    'Reference',
    'Notes',
  ];
  const lines = [header.join(',')];
  for (const { payout: p, proName } of rows) {
    lines.push([
      csvEscape(proName),
      csvEscape(new Date(p.periodStart).toISOString().slice(0, 10)),
      csvEscape(new Date(p.periodEnd).toISOString().slice(0, 10)),
      csvEscape(rupeesPlain(p.grossPaise)),
      csvEscape(rupeesPlain(p.platformFeePaise)),
      csvEscape(rupeesPlain(p.netPayoutPaise)),
      csvEscape(p.status),
      csvEscape(p.paidAt ? new Date(p.paidAt).toISOString().slice(0, 10) : ''),
      csvEscape(p.payoutReference ?? ''),
      csvEscape(p.notes ?? ''),
    ].join(','));
  }
  const csv = '\ufeff' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `coach-payouts-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface AdminCoach {
  proId: number;
  displayName: string;
  isActive: boolean;
  userId: number | null;
  isListed: boolean;
  revenueSharePct: number;
  lifetimeGrossPaise: number;
  lifetimeNetPayoutPaise: number;
  deliveredCount: number;
  outstandingGrossPaise: number;
  outstandingNetPayoutPaise: number;
  outstandingCount: number;
  // Task #1221 — payout-verification status surfaced inline.
  payoutMethod: string | null;
  payoutVerificationStatus: string | null;
  payoutVerifiedAt: string | null;
  payoutVerificationFailureReason: string | null;
}

type PayoutVerificationLabel = 'verified' | 'needs_attention' | 'unconfigured' | 'pending';

function payoutVerificationLabel(c: AdminCoach): PayoutVerificationLabel {
  if (!c.payoutMethod) return 'unconfigured';
  if (c.payoutVerificationStatus === 'verified') return 'verified';
  if (c.payoutVerificationStatus === 'needs_attention') return 'needs_attention';
  return 'pending';
}

function payoutVerificationBadgeStyle(label: PayoutVerificationLabel): { bg: string; fg: string } {
  switch (label) {
    case 'verified': return { bg: '#1a4d2e', fg: '#86efac' };
    case 'needs_attention': return { bg: '#5a3a1a', fg: '#fcd34d' };
    case 'pending': return { bg: '#2a2a2a', fg: '#cbd5e1' };
    case 'unconfigured': return { bg: '#2a2a2a', fg: '#9ca3af' };
  }
}

function payoutVerificationText(label: PayoutVerificationLabel): string {
  switch (label) {
    case 'verified': return 'Verified';
    case 'needs_attention': return 'Needs attention';
    case 'pending': return 'Pending';
    case 'unconfigured': return 'Not configured';
  }
}

interface PayoutRow {
  payout: {
    id: number;
    proId: number;
    organizationId: number;
    periodStart: string;
    periodEnd: string;
    grossPaise: number;
    netPayoutPaise: number;
    platformFeePaise: number;
    status: 'pending' | 'paid';
    paidAt: string | null;
    payoutReference: string | null;
    notes: string | null;
    createdAt: string;
  };
  proName: string;
  // Task #1129 — per-payout push/SMS attempts row (left-joined; null when
  // mark-paid hasn't fired yet). Channel-state helpers live in the shared
  // `@workspace/coach-payout-labels` package (extracted in Task #1306,
  // hoisted out of the per-artifact copies in Task #1545).
  notification: CoachPayoutNotificationAttempt | null;
}

export default function CoachAdminPage() {
  const [coaches, setCoaches] = useState<AdminCoach[]>([]);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [editingShare, setEditingShare] = useState<Record<number, string>>({});
  const [savingShare, setSavingShare] = useState<Record<number, boolean>>({});
  const [markPaying, setMarkPaying] = useState<PayoutRow | null>(null);
  const [historyCoach, setHistoryCoach] = useState<AdminCoach | null>(null);
  const [exportingAllHistory, setExportingAllHistory] = useState(false);
  // Task #1427 — change-type filter applied to the org-wide CSV export.
  // Defaults to "all" so the existing behaviour is preserved.
  const [historyExportKind, setHistoryExportKind] = useState<ChangeKindFilter>('all');
  const [reverifying, setReverifying] = useState<Record<number, boolean>>({});
  const [resendingNotif, setResendingNotif] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const exportAllHistory = async () => {
    setExportingAllHistory(true);
    try {
      // Task #1427 — when the admin has narrowed the export to a
      // specific change kind, pass it through to the API so the server
      // does the filtering (avoids over-fetching for large orgs).
      const url = historyExportKind === 'all'
        ? '/api/coach-marketplace/admin/payout-account/history'
        : `/api/coach-marketplace/admin/payout-account/history?changeKind=${encodeURIComponent(historyExportKind)}`;
      const r = await fetch(url, { credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || `Failed (${r.status})`);
      const history: PayoutAccountHistoryEntry[] = d.history ?? [];
      if (history.length === 0) {
        const noun = historyExportKind === 'all'
          ? 'payout-account changes'
          : `${CHANGE_KIND_FILTER_OPTIONS.find(o => o.value === historyExportKind)?.label.toLowerCase() ?? 'matching'} rows`;
        toast({ title: 'Nothing to export', description: `No ${noun} recorded for any coach yet.` });
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const suffix = historyExportKind === 'all' ? '' : `-${historyExportKind.replace(/_/g, '-')}`;
      exportPayoutAccountHistoryCsv(
        `payout-account-history-all-coaches${suffix}-${stamp}.csv`,
        history,
      );
      toast({ title: 'CSV exported', description: `${history.length} change${history.length === 1 ? '' : 's'} downloaded.` });
    } catch (e: any) {
      toast({ title: 'Export failed', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setExportingAllHistory(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cr = await fetch('/api/coach-marketplace/admin/coaches', { credentials: 'include' });
      if (!cr.ok) {
        const e = await cr.json().catch(() => ({}));
        throw new Error(e.error || `Failed to load coaches (${cr.status})`);
      }
      const cj = await cr.json();
      setCoaches(cj.coaches ?? []);

      const pr = await fetch('/api/swing-reviews/admin/payouts', { credentials: 'include' });
      if (!pr.ok) {
        const e = await pr.json().catch(() => ({}));
        throw new Error(e.error || `Failed to load payouts (${pr.status})`);
      }
      const pj = await pr.json();
      setPayouts(pj.payouts ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Task #1223 — honour the deep link from the admin payout-account-change
  // email (`/coach-admin?coach=:proId#payout-history`): once the coach list
  // has loaded, auto-scroll to the matching row and open its payout-history
  // dialog. Runs once per page load; falls back silently (no error toast)
  // if the coach is no longer in the list.
  // Task #1719 — the hash now also carries the optional change-kind chip
  // selection (`#payout-history=admin_reverify`) so the admin re-verify
  // email can land directly on the matching filter chip in the dialog.
  const deepLinkHandledRef = useRef(false);
  const [deepLinkInitialKind, setDeepLinkInitialKind] = useState<ChangeKindFilter>('all');
  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    if (loading) return;
    if (typeof window === 'undefined') return;
    const parsed = parsePayoutHistoryHash(window.location.hash);
    if (!parsed.matches) return;
    const params = new URLSearchParams(window.location.search);
    const coachParam = params.get('coach');
    if (!coachParam) return;
    const proId = Number(coachParam);
    if (!Number.isFinite(proId) || proId <= 0) return;

    deepLinkHandledRef.current = true;

    const coach = coaches.find(c => c.proId === proId);
    if (!coach) return;

    setDeepLinkInitialKind(parsed.kind);
    setHistoryCoach(coach);
    // Defer the scroll until after React has painted the row so the
    // `data-testid` selector resolves to a real DOM node.
    window.setTimeout(() => {
      const row = document.querySelector(`[data-testid="row-coach-${proId}"]`);
      if (row && typeof (row as HTMLElement).scrollIntoView === 'function') {
        (row as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  }, [loading, coaches]);

  const saveShare = async (coach: AdminCoach) => {
    const raw = editingShare[coach.proId];
    const pct = Number(raw);
    if (!isFinite(pct) || pct < 0 || pct > 100) {
      toast({ title: 'Invalid revenue share', description: 'Enter 0–100', variant: 'destructive' });
      return;
    }
    setSavingShare(s => ({ ...s, [coach.proId]: true }));
    try {
      const r = await fetch(`/api/coach-marketplace/pros/${coach.proId}/revenue-share`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueSharePct: pct }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Failed (${r.status})`);
      toast({ title: 'Revenue share updated', description: `${coach.displayName} now keeps ${pct}%` });
      setEditingShare(s => { const n = { ...s }; delete n[coach.proId]; return n; });
      await load();
    } catch (e: any) {
      toast({ title: 'Update failed', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setSavingShare(s => ({ ...s, [coach.proId]: false }));
    }
  };

  const resendPayoutNotification = async (row: PayoutRow) => {
    const id = row.payout.id;
    setResendingNotif(s => ({ ...s, [id]: true }));
    try {
      const r = await fetch(`/api/swing-reviews/admin/payouts/${id}/resend-notification`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.success) throw new Error(data?.error || `Failed (${r.status})`);
      const channels = [
        data.resetPush ? 'push' : null,
        data.resetSms ? 'SMS' : null,
      ].filter(Boolean).join(' + ');
      toast({
        title: 'Notification queued for retry',
        description: `Payout #${id}: ${channels || 'channels'} reset — the cron will re-send within ~15 min.`,
      });
      await load();
    } catch (e: any) {
      toast({ title: 'Resend failed', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setResendingNotif(s => ({ ...s, [id]: false }));
    }
  };

  const reverifyPayoutAccount = async (coach: AdminCoach) => {
    setReverifying(s => ({ ...s, [coach.proId]: true }));
    try {
      const r = await fetch(`/api/coach-marketplace/admin/coaches/${coach.proId}/payout-account/reverify`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || `Failed (${r.status})`);
      const outcome: string = data.outcome ?? 'unknown';
      const reason: string | null = data.reason ?? null;
      if (outcome === 'verified') {
        toast({ title: 'Payout account re-verified', description: `${coach.displayName}'s account is active.` });
      } else if (outcome === 'needs_attention') {
        toast({
          title: 'Re-verification failed',
          description: reason ?? 'Account needs attention. The coach has been notified.',
          variant: 'destructive',
        });
      } else if (outcome === 'skipped') {
        toast({ title: 'Re-verification pending', description: reason ?? 'Validation is still in flight; try again shortly.' });
      } else {
        toast({ title: 'Re-verification error', description: reason ?? outcome, variant: 'destructive' });
      }
    } catch (e: any) {
      toast({ title: 'Re-verify failed', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setReverifying(s => ({ ...s, [coach.proId]: false }));
    }
  };

  const runBatch = async () => {
    setRunning(true);
    try {
      const r = await fetch('/api/swing-reviews/admin/payouts/run', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Failed (${r.status})`);
      if (data.message) {
        toast({ title: 'Nothing to pay out', description: data.message });
      } else {
        toast({ title: 'Payout batch created', description: `${data.count} new payout${data.count === 1 ? '' : 's'} queued` });
      }
      await load();
    } catch (e: any) {
      toast({ title: 'Payout run failed', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <div className="p-8 text-zinc-400">Loading coach administration…</div>;

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6" data-testid="page-coach-admin">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold mb-1" style={{ color: GOLD }}>
              Coach Revenue & Payouts
            </h1>
            <p className="text-zinc-400">
              Set per-coach revenue share, see what's owed, and run payout batches.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={load} style={{ borderColor: '#666', color: '#ccc' }}
              data-testid="button-refresh">
              <RefreshCw className="w-4 h-4 mr-2" /> Refresh
            </Button>
            <Button onClick={runBatch} disabled={running} style={{ backgroundColor: GOLD, color: '#000' }}
              data-testid="button-run-payout-batch">
              <Play className="w-4 h-4 mr-2" /> {running ? 'Running…' : 'Run payout batch'}
            </Button>
          </div>
        </div>

        {error && (
          <Card className="bg-red-950/40 border-red-800 p-4 text-red-200" data-testid="text-error">
            {error}
          </Card>
        )}

        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5" style={{ color: GOLD }} />
              <h2 className="font-semibold text-lg" style={{ color: GOLD }}>Coaches ({coaches.length})</h2>
            </div>
            <div className="flex items-center gap-2">
              {/* Task #1427 — change-type filter for the org-wide CSV export. */}
              <label htmlFor="select-export-history-kind" className="sr-only">
                Filter export by change type
              </label>
              <select
                id="select-export-history-kind"
                value={historyExportKind}
                onChange={e => setHistoryExportKind(e.target.value as ChangeKindFilter)}
                disabled={exportingAllHistory || coaches.length === 0}
                className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm rounded h-9 px-2"
                data-testid="select-export-history-kind"
              >
                {CHANGE_KIND_FILTER_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={exportAllHistory}
                disabled={exportingAllHistory || coaches.length === 0}
                style={{ borderColor: '#666', color: '#ccc' }}
                data-testid="button-export-all-history-csv"
              >
                <Download className="w-4 h-4 mr-2" />
                {exportingAllHistory ? 'Exporting…' : 'Export history (CSV)'}
              </Button>
            </div>
          </div>
          {coaches.length === 0 ? (
            <div className="text-zinc-500 text-sm py-6 text-center" data-testid="text-no-coaches">
              No teaching pros yet. Add coaches in Lessons admin first.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-zinc-500 text-left border-b border-zinc-800">
                    <th className="py-2 pr-3">Coach</th>
                    <th className="pr-3">Listed</th>
                    <th className="pr-3">Payout account</th>
                    <th className="pr-3">Revenue share</th>
                    <th className="pr-3 text-right">Lifetime gross</th>
                    <th className="pr-3 text-right">Lifetime net</th>
                    <th className="pr-3 text-right">Outstanding (net)</th>
                    <th className="pr-3 text-right" />
                  </tr>
                </thead>
                <tbody>
                  {coaches.map(c => {
                    const editing = editingShare[c.proId] !== undefined;
                    const value = editing ? editingShare[c.proId] : String(c.revenueSharePct);
                    const verifyLabel = payoutVerificationLabel(c);
                    const verifyStyle = payoutVerificationBadgeStyle(verifyLabel);
                    const hasPayoutAccount = !!c.payoutMethod;
                    const reverifyDisabled = reverifying[c.proId] || !hasPayoutAccount;
                    const reverifyTitle = !hasPayoutAccount
                      ? 'Coach has not saved a payout account yet'
                      : 'Re-verify the saved payout account with the bank';
                    return (
                      <tr key={c.proId} className="border-b border-zinc-800 hover:bg-zinc-800/30"
                        data-testid={`row-coach-${c.proId}`}>
                        <td className="py-3 pr-3">
                          <div className="font-semibold" data-testid={`text-coach-name-${c.proId}`}>
                            {c.displayName}
                          </div>
                          <div className="text-xs text-zinc-500">
                            #{c.proId}{!c.isActive && <Badge variant="outline" className="ml-2">inactive</Badge>}
                          </div>
                        </td>
                        <td className="pr-3">
                          {c.isListed
                            ? <Badge style={{ backgroundColor: GOLD, color: '#000' }} data-testid={`badge-listed-${c.proId}`}>Listed</Badge>
                            : <Badge variant="outline" className="text-zinc-400" data-testid={`badge-unlisted-${c.proId}`}>Unlisted</Badge>}
                        </td>
                        <td className="pr-3">
                          <div className="flex flex-col gap-1">
                            <Badge
                              style={{ backgroundColor: verifyStyle.bg, color: verifyStyle.fg }}
                              title={verifyLabel === 'needs_attention' && c.payoutVerificationFailureReason
                                ? c.payoutVerificationFailureReason
                                : undefined}
                              data-testid={`badge-payout-verification-${c.proId}`}
                            >
                              {payoutVerificationText(verifyLabel)}
                            </Badge>
                            {c.payoutVerifiedAt && (verifyLabel === 'verified' || verifyLabel === 'needs_attention') && (
                              <span className="text-xs text-zinc-500"
                                data-testid={`text-payout-verified-at-${c.proId}`}>
                                {verifyLabel === 'verified' ? 'Verified' : 'Last verified'}{' '}
                                {new Date(c.payoutVerifiedAt).toLocaleDateString()}
                              </span>
                            )}
                            {verifyLabel === 'needs_attention' && c.payoutVerificationFailureReason && (
                              <span className="text-xs text-amber-300/80 max-w-[16rem] truncate"
                                title={c.payoutVerificationFailureReason}
                                data-testid={`text-payout-failure-reason-${c.proId}`}>
                                {c.payoutVerificationFailureReason}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="pr-3">
                          <div className="flex items-center gap-2">
                            <Input
                              type="number" min={0} max={100} step={0.5}
                              value={value}
                              onChange={e => setEditingShare(s => ({ ...s, [c.proId]: e.target.value }))}
                              className="bg-zinc-800 border-zinc-700 text-white w-20 h-8"
                              data-testid={`input-share-${c.proId}`}
                            />
                            <span className="text-zinc-400">%</span>
                            {editing && (
                              <>
                                <Button
                                  size="sm" disabled={savingShare[c.proId]}
                                  onClick={() => saveShare(c)}
                                  style={{ backgroundColor: GOLD, color: '#000' }}
                                  data-testid={`button-save-share-${c.proId}`}>
                                  {savingShare[c.proId] ? 'Saving…' : 'Save'}
                                </Button>
                                <Button
                                  size="sm" variant="outline"
                                  onClick={() => setEditingShare(s => { const n = { ...s }; delete n[c.proId]; return n; })}
                                  style={{ borderColor: '#666', color: '#ccc' }}>
                                  Cancel
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="pr-3 text-right" data-testid={`text-lifetime-gross-${c.proId}`}>
                          {formatRupees(c.lifetimeGrossPaise)}
                          <div className="text-xs text-zinc-500">{c.deliveredCount} delivered</div>
                        </td>
                        <td className="pr-3 text-right text-zinc-300" data-testid={`text-lifetime-net-${c.proId}`}>
                          {formatRupees(c.lifetimeNetPayoutPaise)}
                        </td>
                        <td className="pr-3 text-right font-semibold" style={{ color: GOLD }}
                          data-testid={`text-outstanding-${c.proId}`}>
                          {formatRupees(c.outstandingNetPayoutPaise)}
                          <div className="text-xs text-zinc-500 font-normal">
                            {c.outstandingCount} unpaid · gross {formatRupees(c.outstandingGrossPaise)}
                          </div>
                        </td>
                        <td className="pr-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button size="sm" variant="outline"
                              onClick={() => reverifyPayoutAccount(c)}
                              disabled={reverifyDisabled}
                              title={reverifyTitle}
                              style={{ borderColor: '#666', color: '#ccc' }}
                              data-testid={`button-reverify-payout-${c.proId}`}>
                              <ShieldCheck className="w-3 h-3 mr-1" />
                              {reverifying[c.proId] ? 'Re-verifying…' : 'Re-verify now'}
                            </Button>
                            <Button size="sm" variant="outline"
                              onClick={() => setHistoryCoach(c)}
                              style={{ borderColor: '#666', color: '#ccc' }}
                              data-testid={`button-payout-history-${c.proId}`}>
                              <History className="w-3 h-3 mr-1" /> Payout history
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="bg-zinc-900 border-zinc-800 p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <Wallet className="w-5 h-5" style={{ color: GOLD }} />
              <h2 className="font-semibold text-lg" style={{ color: GOLD }}>Payouts ({payouts.length})</h2>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => exportPayoutsCsv(payouts)}
              disabled={payouts.length === 0}
              style={{ borderColor: '#666', color: '#ccc' }}
              data-testid="button-export-payouts-csv"
            >
              <Download className="w-4 h-4 mr-2" /> Export CSV
            </Button>
          </div>
          {payouts.length === 0 ? (
            <div className="text-zinc-500 text-sm py-6 text-center" data-testid="text-no-payouts">
              No payouts yet. Run a batch above to aggregate delivered, unpaid reviews into per-coach payouts.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-zinc-500 text-left border-b border-zinc-800">
                    <th className="py-2 pr-3">#</th>
                    <th className="pr-3">Coach</th>
                    <th className="pr-3">Period</th>
                    <th className="pr-3 text-right">Gross</th>
                    <th className="pr-3 text-right">Net</th>
                    <th className="pr-3">Status</th>
                    <th className="pr-3">Reference</th>
                    <th className="pr-3">Notification</th>
                    <th className="pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {payouts.map(row => {
                    const p = row.payout;
                    const n = row.notification;
                    const pushLabel: CoachPayoutChannelLabel = n
                      ? channelLabel(n.pushStatus, n.pushAttempts, n.pushRetryExhaustedAt, COACH_PAYOUT_MAX_PUSH_ATTEMPTS)
                      : 'pending';
                    const smsLabel: CoachPayoutChannelLabel = n
                      ? channelLabel(n.smsStatus, n.smsAttempts, n.smsRetryExhaustedAt, COACH_PAYOUT_MAX_SMS_ATTEMPTS)
                      : 'pending';
                    const canResend = n != null && (isResettable(pushLabel) || isResettable(smsLabel));
                    const pushStyle = channelBadgeStyle(pushLabel);
                    const smsStyle = channelBadgeStyle(smsLabel);
                    return (
                      <tr key={p.id} className="border-b border-zinc-800 hover:bg-zinc-800/30"
                        data-testid={`row-payout-${p.id}`}>
                        <td className="py-3 pr-3 text-zinc-500">#{p.id}</td>
                        <td className="pr-3 font-semibold">{row.proName}</td>
                        <td className="pr-3 text-zinc-400 text-xs">
                          {new Date(p.periodStart).toLocaleDateString()} – {new Date(p.periodEnd).toLocaleDateString()}
                        </td>
                        <td className="pr-3 text-right">{formatRupees(p.grossPaise)}</td>
                        <td className="pr-3 text-right font-semibold" style={{ color: GOLD }}>
                          {formatRupees(p.netPayoutPaise)}
                        </td>
                        <td className="pr-3">
                          {p.status === 'paid'
                            ? <Badge style={{ backgroundColor: '#1a4d2e', color: '#86efac' }}
                                data-testid={`badge-status-${p.id}`}>
                                <CheckCircle2 className="w-3 h-3 mr-1 inline" /> Paid
                              </Badge>
                            : <Badge variant="outline" className="text-amber-300 border-amber-700"
                                data-testid={`badge-status-${p.id}`}>Pending</Badge>}
                          {p.paidAt && <div className="text-xs text-zinc-500 mt-1">{new Date(p.paidAt).toLocaleDateString()}</div>}
                        </td>
                        <td className="pr-3 text-xs text-zinc-400">
                          {p.payoutReference ?? '—'}
                          {p.notes && <div className="text-zinc-500 italic max-w-xs truncate" title={p.notes}>{p.notes}</div>}
                        </td>
                        <td className="pr-3 text-xs" data-testid={`cell-notification-${p.id}`}>
                          {p.status !== 'paid' ? (
                            <span className="text-zinc-600">—</span>
                          ) : !n ? (
                            <Badge style={{ backgroundColor: '#2a2a2a', color: '#9ca3af' }}
                              data-testid={`badge-notif-pending-${p.id}`}>
                              Pending
                            </Badge>
                          ) : (() => {
                            // Task #1919 — surface the masked snapshot of the
                            // push device / SMS number we last tried for any
                            // non-sent / non-opted-out channel so admins
                            // triaging "I never got my notification" can tell
                            // a stale-on-file recipient from a provider
                            // outage without bouncing into the database.
                            // Hidden on `sent` (delivered, no need) and on
                            // `opted_out` (no recipient to expose) — same
                            // gating as the coach-facing cell in
                            // `coach-workspace.tsx`.
                            const showPushTarget = pushLabel !== 'sent' && pushLabel !== 'opted_out' && !!n.pushTargetLabel;
                            const showSmsTarget = smsLabel !== 'sent' && smsLabel !== 'opted_out' && !!n.smsTargetMasked;
                            return (
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1 flex-wrap" title={n.lastPushError ?? undefined}>
                                {pushLabel === 'sent'
                                  ? <BellRing className="w-3 h-3 text-emerald-400" />
                                  : <BellOff className="w-3 h-3 text-zinc-400" />}
                                <span className="text-zinc-500">Push</span>
                                <Badge
                                  style={{ backgroundColor: pushStyle.bg, color: pushStyle.fg }}
                                  data-testid={`badge-notif-push-${p.id}`}
                                  data-status={pushLabel}
                                >
                                  {channelText(pushLabel)}
                                </Badge>
                                {n.pushAttempts > 0 && (
                                  <span className="text-zinc-600">×{n.pushAttempts}</span>
                                )}
                                {showPushTarget && (
                                  <span
                                    className="text-[11px] text-zinc-400"
                                    data-testid={`target-notif-push-${p.id}`}
                                  >
                                    tried {n.pushTargetLabel}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1 flex-wrap" title={n.lastSmsError ?? undefined}>
                                {smsLabel === 'sent'
                                  ? <BellRing className="w-3 h-3 text-emerald-400" />
                                  : <BellOff className="w-3 h-3 text-zinc-400" />}
                                <span className="text-zinc-500">SMS</span>
                                <Badge
                                  style={{ backgroundColor: smsStyle.bg, color: smsStyle.fg }}
                                  data-testid={`badge-notif-sms-${p.id}`}
                                  data-status={smsLabel}
                                >
                                  {channelText(smsLabel)}
                                </Badge>
                                {n.smsAttempts > 0 && (
                                  <span className="text-zinc-600">×{n.smsAttempts}</span>
                                )}
                                {showSmsTarget && (
                                  <span
                                    className="text-[11px] text-zinc-400 font-mono"
                                    data-testid={`target-notif-sms-${p.id}`}
                                  >
                                    tried {n.smsTargetMasked}
                                  </span>
                                )}
                              </div>
                            </div>
                            );
                          })()}
                        </td>
                        <td className="pr-3">
                          <div className="flex flex-col gap-1 items-start">
                            {p.status === 'pending' && (
                              <Button size="sm" onClick={() => setMarkPaying(row)}
                                style={{ backgroundColor: GOLD, color: '#000' }}
                                data-testid={`button-mark-paid-${p.id}`}>
                                <IndianRupee className="w-3 h-3 mr-1" /> Mark paid
                              </Button>
                            )}
                            {canResend && (
                              <Button size="sm" variant="outline"
                                onClick={() => resendPayoutNotification(row)}
                                disabled={!!resendingNotif[p.id]}
                                style={{ borderColor: '#666', color: '#ccc' }}
                                data-testid={`button-resend-notif-${p.id}`}>
                                <Send className="w-3 h-3 mr-1" />
                                {resendingNotif[p.id] ? 'Resending…' : 'Resend notification'}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {markPaying && (
        <MarkPaidDialog
          row={markPaying}
          onClose={(reload) => { setMarkPaying(null); if (reload) load(); }}
        />
      )}

      {historyCoach && (
        <PayoutAccountHistoryDialog
          coach={historyCoach}
          initialFilterKind={deepLinkInitialKind}
          onClose={() => {
            // Reset for the next open so a row click after a deep-link
            // visit doesn't inherit the email's chip selection.
            setDeepLinkInitialKind('all');
            setHistoryCoach(null);
          }}
        />
      )}
    </div>
  );
}

function PayoutAccountHistoryDialog({
  coach,
  onClose,
  initialFilterKind = 'all',
}: {
  coach: AdminCoach;
  onClose: () => void;
  initialFilterKind?: ChangeKindFilter;
}) {
  const [items, setItems] = useState<PayoutAccountHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Task #1427 — filter the in-dialog list (and per-coach CSV export)
  // by change kind. Defaults to "all" so the existing behaviour is
  // preserved.
  // Task #1719 — the filter is now also driven by the `#payout-history`
  // URL hash so deep-links from admin emails (and chip clicks) survive a
  // refresh / share.
  const [filterKind, setFilterKind] = useState<ChangeKindFilter>(initialFilterKind);
  const { toast } = useToast();

  // Task #1719 — when the chip selection changes, reflect it in the URL
  // hash without pushing a new history entry so the browser back button
  // still leaves the page (instead of cycling through chip clicks).
  const updateFilterKind = useCallback((next: ChangeKindFilter) => {
    setFilterKind(next);
    if (typeof window === 'undefined') return;
    const url = `${window.location.pathname}${window.location.search}${buildPayoutHistoryHash(next)}`;
    window.history.replaceState(window.history.state, '', url);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/coach-marketplace/admin/coaches/${coach.proId}/payout-account/history?limit=10000`,
      { credentials: 'include' })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return;
        if (!ok) { setError(d?.error ?? 'Failed to load history'); return; }
        setItems(d.history ?? []);
      })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [coach.proId]);

  // Task #1427 — applied to both the rendered list and the per-coach
  // CSV export below.
  const filteredItems = items
    ? (filterKind === 'all' ? items : items.filter(h => h.changeKind === filterKind))
    : null;

  const exportCsv = () => {
    if (!filteredItems || filteredItems.length === 0) {
      toast({
        title: 'Nothing to export',
        description: filterKind === 'all'
          ? 'No payout-account changes recorded yet.'
          : 'No matching change-type rows for this coach.',
      });
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const safeName = coach.displayName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || `coach-${coach.proId}`;
    const suffix = filterKind === 'all' ? '' : `-${filterKind.replace(/_/g, '-')}`;
    exportPayoutAccountHistoryCsv(
      `payout-account-history-${safeName}${suffix}-${stamp}.csv`,
      filteredItems,
      coach.displayName,
    );
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <Card className="bg-zinc-900 border-zinc-800 p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        data-testid="dialog-payout-history">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-xl font-bold" style={{ color: GOLD }}>
              Payout-account history
            </h2>
            <p className="text-zinc-400 text-sm">{coach.displayName}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={exportCsv}
              disabled={!filteredItems || filteredItems.length === 0}
              style={{ borderColor: '#666', color: '#ccc' }}
              data-testid="button-export-history-csv"
            >
              <Download className="w-4 h-4 mr-1" /> Export history (CSV)
            </Button>
            <Button variant="ghost" onClick={onClose} data-testid="button-close-history">Close</Button>
          </div>
        </div>

        {/* Task #1427 — change-type filter for the dialog list + CSV export.
            Task #1719 — surfaced as one-click chips above the list (instead
            of a hidden dropdown) so admins reading a busy audit feed can
            switch with a single click; the active chip is mirrored into the
            URL hash so refreshing the page or sharing the link preserves
            the selection. */}
        {!error && items && items.length > 0 && (
          <div className="mb-3">
            <div
              role="tablist"
              aria-label="Filter payout-account history by change type"
              className="flex flex-wrap items-center gap-1.5"
              data-testid="chips-history-filter-kind"
            >
              {CHANGE_KIND_FILTER_OPTIONS.map(opt => {
                const active = filterKind === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => updateFilterKind(opt.value)}
                    className={`px-3 h-7 rounded-full text-xs border transition-colors ${
                      active
                        ? 'border-transparent text-black font-semibold'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
                    }`}
                    style={active ? { backgroundColor: GOLD } : undefined}
                    data-testid={`chip-history-filter-${opt.value}`}
                  >
                    {opt.chipLabel}
                  </button>
                );
              })}
              <span className="text-zinc-500 text-xs ml-1" data-testid="text-history-filter-count">
                {(filteredItems?.length ?? 0)} of {items.length}
              </span>
            </div>
          </div>
        )}

        {error && <div className="text-sm text-red-400" data-testid="text-history-error">{error}</div>}
        {!error && items === null && <div className="text-zinc-500 text-sm">Loading…</div>}
        {!error && items && items.length === 0 && (
          <div className="text-zinc-500 text-sm py-6 text-center" data-testid="text-history-empty">
            No payout-account changes recorded for this coach yet.
          </div>
        )}
        {!error && filteredItems && items && items.length > 0 && filteredItems.length === 0 && (
          <div className="text-zinc-500 text-sm py-6 text-center" data-testid="text-history-filter-empty">
            No rows match the selected change type.
          </div>
        )}
        {!error && filteredItems && filteredItems.length > 0 && (
          <ul className="space-y-3">
            {filteredItems.map(h => (
              <li key={h.id} className="bg-zinc-800/60 border border-zinc-700 rounded p-3 text-sm"
                data-testid={`history-row-${h.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-zinc-200">
                    {changeKindLabel(h)}
                    <span className="text-zinc-500 font-normal ml-2">
                      ({h.method === 'upi' ? 'UPI' : 'Bank account'})
                    </span>
                  </span>
                  <span className="text-zinc-500 text-xs">{new Date(h.createdAt).toLocaleString()}</span>
                </div>
                <div className="text-zinc-300 mt-1 text-xs">
                  {h.method === 'upi' && h.upiVpaMasked && <span>UPI {h.upiVpaMasked}</span>}
                  {h.method === 'bank_account' && h.bankAccountLast4 && (
                    <span>Account •••• {h.bankAccountLast4}{h.bankIfsc && <span className="ml-2">IFSC {h.bankIfsc}</span>}</span>
                  )}
                  {h.accountHolderName && <span className="text-zinc-500"> · {h.accountHolderName}</span>}
                </div>
                {h.changeKind === 'admin_reverify' && h.verificationReason && (
                  <div className="text-zinc-400 mt-1 text-xs" data-testid={`history-reason-${h.id}`}>
                    Reason: {h.verificationReason}
                  </div>
                )}
                <div className="text-zinc-500 mt-1 text-xs">
                  By {h.changedByName ?? 'unknown'}{h.changedByRole ? ` (${h.changedByRole})` : ''}
                  {h.ipAddress && <span> · IP {h.ipAddress}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function MarkPaidDialog({ row, onClose }: { row: PayoutRow; onClose: (reload: boolean) => void }) {
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const submit = async () => {
    if (!reference.trim()) {
      toast({ title: 'Reference required', description: 'Enter a payout reference (e.g. UPI/UTR id)', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/swing-reviews/admin/payouts/${row.payout.id}/mark-paid`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: reference.trim(), notes: notes.trim() }),
      });
      const data = await r.json();
      if (!r.ok || !data.success) throw new Error(data.error || `Failed (${r.status})`);
      toast({ title: 'Marked paid', description: `Payout #${row.payout.id} for ${row.proName}` });
      onClose(true);
    } catch (e: any) {
      toast({ title: 'Failed', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const formatRupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <Card className="bg-zinc-900 border-zinc-800 p-6 max-w-md w-full" data-testid="dialog-mark-paid">
        <h2 className="text-xl font-bold mb-1" style={{ color: GOLD }}>
          Mark payout #{row.payout.id} as paid
        </h2>
        <p className="text-zinc-400 text-sm mb-4">
          {row.proName} · Net {formatRupees(row.payout.netPayoutPaise)}
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-zinc-400 block mb-1">Reference / UTR</label>
            <Input
              value={reference} onChange={e => setReference(e.target.value)}
              placeholder="UPI/UTR/bank reference"
              className="bg-zinc-800 border-zinc-700 text-white"
              data-testid="input-reference"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-zinc-400 block mb-1">Notes (optional)</label>
            <Textarea
              value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Any extra context"
              rows={3}
              className="bg-zinc-800 border-zinc-700 text-white"
              data-testid="input-notes"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={() => onClose(false)} disabled={submitting}
            style={{ borderColor: '#666', color: '#ccc' }}
            data-testid="button-cancel">
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}
            style={{ backgroundColor: GOLD, color: '#000' }}
            data-testid="button-confirm-mark-paid">
            {submitting ? 'Saving…' : 'Confirm paid'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
