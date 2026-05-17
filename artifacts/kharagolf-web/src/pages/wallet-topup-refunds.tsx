import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { useGetMe } from '@workspace/api-client-react';
import { AlertTriangle, ArrowLeft, Download, Eye, Languages, Mail, RefreshCw, Send, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import type { TFunction } from 'i18next';
import { RefundDeliveryStatusRow, type RefundDeliveryInfo } from '@/components/RefundDeliveryStatusRow';

function languageDisplayName(code: string | null | undefined): string {
  if (!code) return 'English (en)';
  const found = SUPPORTED_LANGUAGES.find(l => l.code === code);
  return found ? `${found.name} (${found.code})` : code;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

const currencySymbol: Record<string, string> = {
  INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'د.إ', SGD: 'S$',
};

interface AutoRefundRow {
  id: number;
  userId: number | null;
  memberName: string | null;
  memberEmail: string | null;
  amount: number | null;
  currency: string;
  paymentRef: string | null;
  orderId: string | null;
  note: string | null;
  refundedAt: string;
  // Task #1862 — per-channel (email/push/sms/whatsapp) delivery
  // status folded in by the admin endpoint so support staff can see,
  // inline in the dashboard list, whether each refund alert went out
  // and the most recent provider error for failed/exhausted rows
  // (admin endpoint includes `lastError` on every channel; member
  // endpoint omits it).
  delivery?: RefundDeliveryInfo | null;
}

interface AutoRefundsResponse {
  items: AutoRefundRow[];
  totalsByCurrency: Record<string, { count: number; amount: number }>;
}

async function j<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

function fmtMoney(value: number | null, currency: string): string {
  if (value == null) return '—';
  const sym = currencySymbol[currency] ?? '';
  return `${sym}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDateTime(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

export default function WalletTopupRefundsPage() {
  const { data: user } = useGetMe();
  const { activeOrgId } = useActiveOrgContext();
  const orgId = activeOrgId ?? user?.organizationId;
  const { toast } = useToast();
  // Task #2192 — translate every visible string on the auto-refund
  // dashboard so non-English finance teams see a consistent UI. The
  // page-level `t` belongs to the same `admin` namespace already used
  // by `walletRefundDigestPaused.*` (Task #1760) so all wallet-refund
  // copy lives in a single bundle per locale.
  const { t } = useTranslation('admin');

  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [memberId, setMemberId] = useState<string>('');
  const [q, setQ] = useState<string>('');

  const queryParams = useMemo(() => {
    const sp = new URLSearchParams();
    if (from) sp.set('from', new Date(from).toISOString());
    if (to) {
      const d = new Date(to); d.setHours(23, 59, 59, 999);
      sp.set('to', d.toISOString());
    }
    if (memberId.trim()) sp.set('memberId', memberId.trim());
    if (q.trim()) sp.set('q', q.trim());
    return sp.toString();
  }, [from, to, memberId, q]);

  const refundsQuery = useQuery<AutoRefundsResponse>({
    queryKey: ['wallet-topup-refunds', orgId, queryParams],
    enabled: !!orgId,
    queryFn: () => j<AutoRefundsResponse>(
      `/api/admin/wallet-topup-refunds?organizationId=${orgId}${queryParams ? `&${queryParams}` : ''}`,
    ),
  });

  const totalsRows = useMemo(() => {
    const t = refundsQuery.data?.totalsByCurrency ?? {};
    return Object.entries(t).map(([cur, v]) => ({ currency: cur, ...v }));
  }, [refundsQuery.data]);

  const downloadCsv = () => {
    if (!orgId) return;
    if (from && to && from > to) {
      toast({
        title: t('walletTopupRefunds.invalidRangeTitle'),
        description: t('walletTopupRefunds.invalidRangeDescription'),
        variant: 'destructive',
      });
      return;
    }
    const url = `${BASE}/api/admin/wallet-topup-refunds.csv?organizationId=${orgId}${queryParams ? `&${queryParams}` : ''}`;
    window.location.href = url;
  };

  const items = refundsQuery.data?.items ?? [];

  return (
    <div className="min-h-screen bg-[#0a1628] text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <Link href={`${BASE}/finance-ledger`}>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-white hover:bg-white/5 gap-1.5 mb-2" data-testid="link-back-to-finance">
                <ArrowLeft className="w-3.5 h-3.5" /> {t('walletTopupRefunds.backToFinance')}
              </Button>
            </Link>
            <h1 className="text-2xl font-bold">{t('walletTopupRefunds.title')}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t('walletTopupRefunds.intro')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refundsQuery.refetch()}
            disabled={refundsQuery.isFetching}
            className="border-white/10 text-white hover:bg-white/5 gap-1.5"
            data-testid="button-refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refundsQuery.isFetching ? 'animate-spin' : ''}`} />
            {t('walletTopupRefunds.refresh')}
          </Button>
        </div>

        <Card className="bg-black/30 border-white/10">
          <CardHeader>
            <CardTitle className="text-base">{t('walletTopupRefunds.filtersTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-5 gap-3 items-end">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('walletTopupRefunds.filterFromLabel')}</label>
                <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1 bg-black/40 border-white/10 text-white" data-testid="input-refunds-from" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('walletTopupRefunds.filterToLabel')}</label>
                <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="mt-1 bg-black/40 border-white/10 text-white" data-testid="input-refunds-to" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('walletTopupRefunds.filterSearchLabel')}</label>
                <Input
                  type="search"
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder={t('walletTopupRefunds.filterSearchPlaceholder')}
                  className="mt-1 bg-black/40 border-white/10 text-white"
                  data-testid="input-refunds-search"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('walletTopupRefunds.filterMemberIdLabel')}</label>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={memberId}
                  onChange={e => setMemberId(e.target.value)}
                  placeholder={t('walletTopupRefunds.filterMemberIdPlaceholder')}
                  className="mt-1 bg-black/40 border-white/10 text-white"
                  data-testid="input-refunds-member"
                />
              </div>
              <Button
                onClick={downloadCsv}
                disabled={!orgId}
                className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5"
                data-testid="button-export-refunds-csv"
              >
                <Download className="w-4 h-4" /> {t('walletTopupRefunds.exportCsv')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {totalsRows.length > 0 && (
          <Card className="bg-black/30 border-white/10">
            <CardHeader>
              <CardTitle className="text-base">{t('walletTopupRefunds.totalsTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {totalsRows.map(t2 => (
                  <div key={t2.currency} className="border border-white/10 rounded-lg p-4 bg-black/20" data-testid={`refund-totals-${t2.currency}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">{t2.currency}</span>
                      <span className="text-xs text-muted-foreground">{t('walletTopupRefunds.totalsRefundCount', { count: t2.count })}</span>
                    </div>
                    <div className="mt-2 text-rose-300 text-lg font-semibold">{fmtMoney(t2.amount, t2.currency)}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {orgId ? <WalletTopupRefundEmailSchedulePanel orgId={orgId} /> : null}

        <Card className="bg-black/30 border-white/10">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
              <span>{t('walletTopupRefunds.refundsTitle')}</span>
              <span className="text-xs font-normal text-muted-foreground" data-testid="text-refund-count">
                {t('walletTopupRefunds.refundsRowCount', { count: items.length })}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {refundsQuery.isLoading ? (
              <div className="py-8 text-center text-muted-foreground text-sm">{t('walletTopupRefunds.refundsLoading')}</div>
            ) : refundsQuery.isError ? (
              <div className="py-8 text-center text-rose-300 text-sm">
                {(refundsQuery.error as Error)?.message ?? t('walletTopupRefunds.refundsLoadError')}
              </div>
            ) : items.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground text-sm" data-testid="text-no-refunds">
                {t('walletTopupRefunds.refundsEmpty')}
              </div>
            ) : (
              <div className="border border-white/10 rounded-lg overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-refunds">
                  <thead className="bg-black/40 text-xs text-muted-foreground uppercase tracking-wider">
                    <tr>
                      <th className="text-left px-3 py-2">{t('walletTopupRefunds.tableHeaderRefunded')}</th>
                      <th className="text-left px-3 py-2">{t('walletTopupRefunds.tableHeaderMember')}</th>
                      <th className="text-right px-3 py-2">{t('walletTopupRefunds.tableHeaderAmount')}</th>
                      <th className="text-left px-3 py-2">{t('walletTopupRefunds.tableHeaderPaymentId')}</th>
                      <th className="text-left px-3 py-2">{t('walletTopupRefunds.tableHeaderNote')}</th>
                      {/* Task #1862 — admin-facing per-channel
                          delivery status so support can answer "did
                          the SMS/WhatsApp ever go out?" without
                          opening the DB. */}
                      <th className="text-left px-3 py-2">{t('walletTopupRefunds.tableHeaderAlertDelivery')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(r => (
                      <tr key={r.id} className="border-t border-white/5" data-testid={`row-refund-${r.id}`}>
                        <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(r.refundedAt)}</td>
                        <td className="px-3 py-2">
                          <div className="text-white">
                            {r.memberName ?? (r.userId != null
                              ? t('walletTopupRefunds.memberFallback', { id: r.userId })
                              : t('walletTopupRefunds.memberFallbackUnknown'))}
                          </div>
                          {r.memberEmail && <div className="text-xs text-muted-foreground">{r.memberEmail}</div>}
                        </td>
                        <td className="px-3 py-2 text-right text-rose-300 whitespace-nowrap">{fmtMoney(r.amount, r.currency)}</td>
                        <td className="px-3 py-2 text-xs font-mono text-muted-foreground break-all">{r.paymentRef ?? '—'}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{r.note ?? '—'}</td>
                        <td className="px-3 py-2 text-xs">
                          {r.delivery ? (
                            <RefundDeliveryStatusRow
                              delivery={r.delivery}
                              rowTestId={`row-refund-delivery-${r.id}`}
                              channelTestIdPrefix={`refund-delivery-${r.id}`}
                              showLastError
                            />
                          ) : (
                            <span
                              className="text-muted-foreground"
                              data-testid={`row-refund-delivery-${r.id}-none`}
                            >
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface WalletRefundScheduleRow {
  id: number;
  organizationId: number;
  frequency: 'weekly' | 'monthly';
  recipients: string[];
  enabled: boolean;
  lastSentAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Task #1759 — per-run snapshot of recipients dropped by the bounce-aware
// filter at the moment the cron evaluated. Mirrors the metadata the
// schedule-level chip uses (Task #1443) but is sourced from
// `wallet_topup_refund_email_runs.paused_recipients` so the row stays
// accurate even after finance later lifts the suppression. No
// `suppressionId` here because the suppression row may already be gone
// — the run history is a historical snapshot, not a live join.
interface PausedRecipientSnapshot {
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
}

interface WalletRefundRunRow {
  id: number;
  scheduleId: number;
  sentAt: string;
  periodStart: string | null;
  periodEnd: string;
  recipients: string[];
  rowCount: number;
  currencyCount: number;
  status: 'sent' | 'failed' | 'skipped';
  errorMessage: string | null;
  pausedRecipients: PausedRecipientSnapshot[];
}

interface WalletRefundScheduleLanguage {
  configured: string | null;
  resolved: string;
  isFallback: boolean;
}

interface PausedRecipientRow {
  suppressionId: number;
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
  createdAt: string;
}

// Task #1747 — per-recipient resolved digest language so each address in
// the saved recipients list shows what it'll actually receive, plus a
// subtle hint when the recipient is a known app user whose own preferred
// language differs from the digest language.
interface RecipientLanguageRow {
  email: string;
  userPreferredLanguage: string | null;
  resolvedDigestLanguage: string;
  mismatch: boolean;
}

interface WalletRefundScheduleResponse {
  schedule: WalletRefundScheduleRow | null;
  history: WalletRefundRunRow[];
  language?: WalletRefundScheduleLanguage;
  pausedRecipients?: PausedRecipientRow[];
  recipientLanguages?: RecipientLanguageRow[];
}

/**
 * Friendly label for the suppression `reason` enum stored in
 * `email_suppressions.reason` so finance can read it at a glance instead of
 * decoding "spam_complaint" or "bounced". Mirrors the labels used in the
 * marketing Suppressions tab so the language is consistent across the
 * admin app — Task #1443. Translated via the `admin` namespace —
 * Task #1760, so non-EN finance teams get a consistent experience.
 */
function pausedReasonLabel(
  t: TFunction,
  reason: string,
  bounceType: string | null,
): string {
  switch (reason) {
    case 'bounced':
      return bounceType
        ? t('admin:walletRefundDigestPaused.reasonBouncedWithType', { bounceType })
        : t('admin:walletRefundDigestPaused.reasonBounced');
    case 'unsubscribed': return t('admin:walletRefundDigestPaused.reasonUnsubscribed');
    case 'spam_complaint': return t('admin:walletRefundDigestPaused.reasonSpamComplaint');
    case 'manual': return t('admin:walletRefundDigestPaused.reasonManual');
    default: return reason;
  }
}

const SCHEDULE_BASE = '/api/admin/wallet-topup-refunds/email-schedule';
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function WalletTopupRefundEmailSchedulePanel({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('admin');

  const q = useQuery<WalletRefundScheduleResponse>({
    queryKey: ['wallet-topup-refund-email-schedule', orgId],
    queryFn: async () => {
      const r = await fetch(`${SCHEDULE_BASE}?organizationId=${orgId}`, { credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId,
  });

  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('weekly');
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [hydratedFor, setHydratedFor] = useState<number | null>(null);

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
  const invalid = parsedRecipients.filter(r => !EMAIL_RX.test(r));

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${SCHEDULE_BASE}?organizationId=${orgId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency, recipients: parsedRecipients, enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ schedule: WalletRefundScheduleRow; pausedRecipients?: PausedRecipientRow[] }>;
    },
    onSuccess: (res) => {
      // Task #1443 — surface the suppression warning the moment finance
      // saves. Without this, the editor only shows a paused chip after the
      // next dashboard refresh, by which point the user has navigated away
      // from the warning context.
      const paused = res.pausedRecipients ?? [];
      if (paused.length > 0) {
        toast({
          title: t('walletRefundDigestPaused.saveToastTitle'),
          description: t('walletRefundDigestPaused.saveToastDescription', { count: paused.length }),
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('walletRefundDigestSchedule.saveToastTitle'),
          description: enabled
            ? t('walletRefundDigestSchedule.saveToastEnabled')
            : t('walletRefundDigestSchedule.saveToastPaused'),
        });
      }
      queryClient.invalidateQueries({ queryKey: ['wallet-topup-refund-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: t('walletRefundDigestSchedule.saveErrorTitle'), description: e.message, variant: 'destructive' }),
  });

  // Task #1443 — one-click "remove from suppression list" so finance can
  // unblock a fixed inbox without leaving the dashboard. The backend also
  // re-adds the address to the configured recipients list if Task #1233's
  // bounce-aware filter had already pruned it out.
  // Task #2197 — emails finance has lifted from the suppression list during
  // this session. The per-run paused chips on the history table are a
  // *snapshot* (stored on `wallet_topup_refund_email_runs.paused_recipients`
  // at the moment the cron evaluated), so they don't disappear when the
  // suppression row is removed. Tracking the lifted addresses locally lets
  // us strike them through inline so finance can see the action took
  // effect without having to reason about why the chip is still there.
  const [liftedEmails, setLiftedEmails] = useState<Set<string>>(new Set());
  const unsuppressMut = useMutation({
    mutationFn: async (email: string) => {
      const r = await fetch(`${SCHEDULE_BASE}/unsuppress?organizationId=${orgId}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ ok: true; removed: number; restoredToSchedule: boolean }>;
    },
    onSuccess: (res, email) => {
      setLiftedEmails(prev => {
        const next = new Set(prev);
        next.add(email.trim().toLowerCase());
        return next;
      });
      toast({
        title: t('walletRefundDigestPaused.unsuppressToastTitle'),
        description: res.restoredToSchedule
          ? t('walletRefundDigestPaused.unsuppressToastRestored', { email })
          : t('walletRefundDigestPaused.unsuppressToastDefault', { email }),
      });
      queryClient.invalidateQueries({ queryKey: ['wallet-topup-refund-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: t('walletRefundDigestPaused.unsuppressErrorTitle'), description: e.message, variant: 'destructive' }),
  });
  const [pausedExpanded, setPausedExpanded] = useState(false);

  const deleteMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${SCHEDULE_BASE}?organizationId=${orgId}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    },
    onSuccess: () => {
      toast({ title: t('walletRefundDigestSchedule.removeToastTitle') });
      queryClient.invalidateQueries({ queryKey: ['wallet-topup-refund-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: t('walletRefundDigestSchedule.removeErrorTitle'), description: e.message, variant: 'destructive' }),
  });

  const [previewOpen, setPreviewOpen] = useState(false);
  const previewMut = useMutation({
    // Task #2161 — the in-page preview modal now honours the same
    // language picker used by "Send preview to me", so a treasurer who
    // selects e.g. Spanish can verify the rendered HTML inline without
    // emailing themselves a copy. Falls through to the org default when
    // the picker hasn't been touched (matches the pre-2161 behaviour).
    mutationFn: async (langOverride: string) => {
      const url = new URL(`${SCHEDULE_BASE}/preview`, window.location.origin);
      url.searchParams.set('organizationId', String(orgId));
      if (langOverride) url.searchParams.set('lang', langOverride);
      const r = await fetch(url.pathname + url.search, { credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{
        subject: string; html: string; filename: string;
        rowCount: number; currencyCount: number;
        recipients: string[]; frequency: 'weekly' | 'monthly';
        periodStart: string; periodEnd: string;
      }>;
    },
    onSuccess: () => setPreviewOpen(true),
    onError: (e: Error) => toast({ title: t('walletRefundDigestSchedule.previewErrorTitle'), description: e.message, variant: 'destructive' }),
  });

  // Task #1746 — language override for the "Send preview to me" action.
  // Defaults to the resolved language from the schedule GET so a one-click
  // user gets exactly the same translation as before. The picker is
  // limited to the digest's 21 supported codes (mirrors
  // `WALLET_TOPUP_REFUND_DIGEST_LANGS` on the server) and the chosen
  // value is per-preview only — it does NOT mutate the schedule or the
  // org's `defaultLanguage`.
  const resolvedScheduleLang = q.data?.language?.resolved ?? null;
  const [previewLang, setPreviewLang] = useState<string | null>(null);
  const [previewLangHydratedFor, setPreviewLangHydratedFor] = useState<string | null>(null);
  if (resolvedScheduleLang && previewLangHydratedFor !== resolvedScheduleLang) {
    setPreviewLang(resolvedScheduleLang);
    setPreviewLangHydratedFor(resolvedScheduleLang);
  }
  const effectivePreviewLang = previewLang ?? resolvedScheduleLang ?? 'en';

  const sendPreviewMut = useMutation({
    mutationFn: async (langOverride: string) => {
      const r = await fetch(`${SCHEDULE_BASE}/send-preview?organizationId=${orgId}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: langOverride }),
      });
      if (!r.ok) {
        // Task #1748 — Surface the per-(user, org) cooldown as a friendly
        // "Please wait" toast rather than a generic 429 so the treasurer
        // knows it's a throttle, not a server failure.
        const body = await r.json().catch(() => ({} as { error?: string; retryAfter?: number }));
        if (r.status === 429) {
          const wait = typeof body.retryAfter === 'number' ? body.retryAfter : null;
          throw new Error(
            wait != null
              ? t('walletRefundDigestSchedule.previewWaitSeconds', { count: wait })
              : (body.error || t('walletRefundDigestSchedule.previewWaitGeneric')),
          );
        }
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      return r.json() as Promise<{
        sentTo: string;
        language: string;
        rowCount: number;
        currencyCount: number;
        frequency: 'weekly' | 'monthly';
        periodStart: string;
        periodEnd: string;
      }>;
    },
    onSuccess: (res) => {
      toast({
        title: t('walletRefundDigestSchedule.previewSentTitle'),
        description: t('walletRefundDigestSchedule.previewSentDescription', {
          email: res.sentTo,
          language: languageDisplayName(res.language),
        }),
      });
    },
    onError: (e: Error) => toast({ title: t('walletRefundDigestSchedule.previewSendErrorTitle'), description: e.message, variant: 'destructive' }),
  });

  const sendNowMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${SCHEDULE_BASE}/send-now?organizationId=${orgId}`, { method: 'POST', credentials: 'include' });
      if (!r.ok) {
        // Task #2174 — Surface the per-(user, org) cooldown as a friendly
        // "Please wait" toast rather than a generic 429 so the treasurer
        // knows it's a throttle, not a server failure, and so a stuck UI
        // loop doesn't keep firing real digest emails to every recipient.
        const body = await r.json().catch(() => ({} as { error?: string; retryAfter?: number }));
        if (r.status === 429) {
          const wait = typeof body.retryAfter === 'number' ? body.retryAfter : null;
          throw new Error(
            wait != null
              ? t('walletRefundDigestSchedule.sendNowWaitSeconds', { count: wait })
              : (body.error || t('walletRefundDigestSchedule.sendNowWaitGeneric')),
          );
        }
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      return r.json() as Promise<{ status: string; rowCount: number; currencyCount: number; recipients: string[]; errorMessage?: string }>;
    },
    onSuccess: (res) => {
      if (res.status === 'sent') {
        toast({
          title: t('walletRefundDigestSchedule.sendNowSentTitle'),
          description: t('walletRefundDigestSchedule.sendNowSentDescription', {
            count: res.recipients.length,
            rowCount: res.rowCount,
            currencyCount: res.currencyCount,
            recipientCount: res.recipients.length,
          }),
        });
      } else {
        toast({ title: t('walletRefundDigestSchedule.sendNowErrorTitle'), description: res.errorMessage ?? res.status, variant: 'destructive' });
      }
      queryClient.invalidateQueries({ queryKey: ['wallet-topup-refund-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: t('walletRefundDigestSchedule.sendNowErrorTitle'), description: e.message, variant: 'destructive' }),
  });

  const history = q.data?.history ?? [];
  const pausedRecipients = q.data?.pausedRecipients ?? [];
  // Task #1747 — backend tells us each saved recipient's resolved digest
  // language plus (when the recipient is a known app user) their own
  // preferred language. We render a row per saved recipient in the
  // banner so treasurers can spot mismatches before they happen.
  const recipientLanguages = q.data?.recipientLanguages ?? [];
  // Map paused emails (lower-cased) -> suppression metadata so the editor
  // can flag any address in the live textarea — not just the saved list —
  // against the org's suppression table. Task #1443.
  const pausedByLower = useMemo(() => {
    const m = new Map<string, PausedRecipientRow>();
    for (const p of pausedRecipients) m.set(p.email.trim().toLowerCase(), p);
    return m;
  }, [pausedRecipients]);
  const editedPausedRecipients = useMemo(() => {
    const seen = new Set<string>();
    const out: PausedRecipientRow[] = [];
    for (const r of parsedRecipients) {
      const lower = r.toLowerCase();
      if (seen.has(lower)) continue;
      const hit = pausedByLower.get(lower);
      if (hit) {
        seen.add(lower);
        out.push({ ...hit, email: r });
      }
    }
    return out;
  }, [parsedRecipients, pausedByLower]);

  const fmtPeriod = (start: string | null, end: string) => {
    const s = start ? new Date(start).toLocaleDateString() : '—';
    const e = new Date(end).toLocaleDateString();
    return `${s} → ${e}`;
  };
  const canSave = parsedRecipients.length > 0 && parsedRecipients.length <= 20 && invalid.length === 0;

  return (
    <Card className="bg-black/30 border-white/10" data-testid="wallet-topup-refund-email-schedule">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="w-4 h-4 text-amber-300" />
          <span>{t('walletRefundDigestSchedule.title')}</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          {t('walletRefundDigestSchedule.description')}
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="py-3 text-center text-xs text-muted-foreground">{t('walletRefundDigestSchedule.loading')}</div>
        ) : q.isError ? (
          <div className="py-3 text-center text-xs text-rose-300">{t('walletRefundDigestSchedule.loadError')}</div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">{t('walletRefundDigestSchedule.frequencyLabel')}</Label>
                <Select value={frequency} onValueChange={v => setFrequency(v as 'weekly' | 'monthly')}>
                  <SelectTrigger className="mt-1 h-8 text-xs bg-black/40 border-white/10 text-white" data-testid="select-refund-digest-frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">{t('walletRefundDigestSchedule.frequencyWeekly')}</SelectItem>
                    <SelectItem value="monthly">{t('walletRefundDigestSchedule.frequencyMonthly')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 text-xs text-white cursor-pointer h-8">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={e => setEnabled(e.target.checked)}
                    data-testid="toggle-refund-digest-enabled"
                    className="accent-amber-500"
                  />
                  {enabled ? t('walletRefundDigestSchedule.statusEnabled') : t('walletRefundDigestSchedule.statusPaused')}
                </label>
              </div>
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">{t('walletRefundDigestSchedule.recipientsLabel')}</Label>
              <Textarea
                value={recipients}
                onChange={e => setRecipients(e.target.value)}
                placeholder={t('walletRefundDigestSchedule.recipientsPlaceholder')}
                className="mt-1 bg-black/40 border-white/10 text-white text-xs min-h-[60px]"
                data-testid="input-refund-digest-recipients"
              />
              <div className="text-[10px] mt-1">
                {invalid.length > 0 ? (
                  <span className="text-rose-300">{t('walletRefundDigestSchedule.recipientsInvalid', { list: invalid.join(', ') })}</span>
                ) : parsedRecipients.length > 0 ? (
                  <span className="text-muted-foreground">{t('walletRefundDigestSchedule.recipientsCount', { count: parsedRecipients.length })}</span>
                ) : (
                  <span className="text-muted-foreground">{t('walletRefundDigestSchedule.recipientsEmpty')}</span>
                )}
              </div>
            </div>
            {sched && (
              <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground items-center">
                <span>
                  {t('walletRefundDigestSchedule.lastSentLabel', {
                    when: sched.lastSentAt ? new Date(sched.lastSentAt).toLocaleString() : t('walletRefundDigestSchedule.lastSentNever'),
                  })}
                </span>
                <span>
                  {t('walletRefundDigestSchedule.nextRunLabel', {
                    when: sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : '—',
                  })}
                </span>
                {/* Task #1443 — "X paused" chip on the saved schedule. Click
                    to expand the per-address breakdown with reasons sourced
                    from `email_suppressions`. */}
                {pausedRecipients.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setPausedExpanded(v => !v)}
                    aria-expanded={pausedExpanded}
                    data-testid="chip-refund-digest-paused-count"
                    className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-amber-200 hover:bg-amber-500/25 transition-colors"
                  >
                    <AlertTriangle className="w-3 h-3" />
                    {t('walletRefundDigestPaused.countChip', { count: pausedRecipients.length })}
                  </button>
                )}
              </div>
            )}
            {/* Task #1443 — paused-recipient warning rows. Surfaces every
                address on the *currently-edited* recipient list that hits
                the suppression table, with a one-click "Remove from
                suppression list" affordance so finance can unblock a fixed
                inbox without leaving the dashboard. We show the breakdown
                whenever there's a known-paused address in the edited list,
                or when the chip is explicitly expanded for the saved list. */}
            {(editedPausedRecipients.length > 0 || (pausedExpanded && pausedRecipients.length > 0)) && (
              <div
                className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-2"
                data-testid="panel-refund-digest-paused-recipients"
              >
                <div className="flex items-start gap-2 text-xs text-amber-100">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    {editedPausedRecipients.length > 0
                      ? t('walletRefundDigestPaused.warningEdited')
                      : t('walletRefundDigestPaused.warningSaved')}
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {(editedPausedRecipients.length > 0 ? editedPausedRecipients : pausedRecipients).map(p => (
                    <li
                      key={p.suppressionId}
                      data-testid={`refund-digest-paused-row-${p.suppressionId}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/20 bg-black/30 px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs text-amber-100 truncate" title={p.email}>{p.email}</div>
                        <div className="text-[10px] text-amber-200/80">
                          {pausedReasonLabel(t, p.reason, p.bounceType)}
                          {p.description ? ` — ${p.description}` : ''}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => unsuppressMut.mutate(p.email)}
                        disabled={unsuppressMut.isPending}
                        data-testid={`button-refund-digest-unsuppress-${p.suppressionId}`}
                        className="h-7 border-amber-500/40 text-amber-100 hover:bg-amber-500/20 gap-1 text-[11px]"
                      >
                        <X className="w-3 h-3" />
                        {t('walletRefundDigestPaused.removeButton')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {sched && q.data?.language && (
              <div
                className="rounded-md border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-muted-foreground flex items-start gap-2"
                data-testid="refund-digest-language-banner"
              >
                <Languages className="w-3.5 h-3.5 mt-0.5 text-amber-300 shrink-0" />
                <div className="space-y-0.5">
                  {/* Task #2170 — the cron now honours each recipient's own
                      `app_users.preferredLanguage` and dispatches one
                      rendered digest per language group, so the org-wide
                      language is the *fallback* used for external
                      recipients (and for users whose preference is null
                      or unsupported). The per-recipient rows below are
                      now the source of truth for what each address will
                      actually receive. */}
                  <div className="text-white">
                    <Trans
                      i18nKey="admin:walletRefundDigestSchedule.languageBanner"
                      values={{ language: languageDisplayName(q.data.language.resolved) }}
                      components={{
                        lang: (
                          <span
                            className="font-semibold text-amber-300"
                            data-testid="refund-digest-resolved-language"
                          />
                        ),
                      }}
                    />
                  </div>
                  {q.data.language.isFallback && (
                    <div className="text-amber-300" data-testid="refund-digest-language-fallback-warning">
                      {q.data.language.configured
                        ? t('walletRefundDigestSchedule.languageFallbackWarning', { configured: q.data.language.configured })
                        : t('walletRefundDigestSchedule.languageFallbackWarningNoConfig')}
                    </div>
                  )}
                  <div>
                    {t('walletRefundDigestSchedule.languagePreviewHint')}
                  </div>
                  {/* Task #1747 / #2170 — per-recipient language rows.
                      The cron now groups recipients by their resolved
                      digest language and dispatches one rendered digest
                      per group, so each row's "will receive in X" hint
                      tells the treasurer exactly what that address will
                      get. Known app users with a *supported*
                      `preferredLanguage` see their preference; external
                      recipients (no app_users row) and users whose
                      preference is unsupported fall back to the org's
                      resolved digest language. */}
                  {recipientLanguages.length > 0 && (
                    <ul
                      className="mt-1 space-y-0.5"
                      data-testid="refund-digest-recipient-languages"
                    >
                      {recipientLanguages.map((row, idx) => (
                        <li
                          key={`${row.email}-${idx}`}
                          data-testid={`refund-digest-recipient-language-row-${idx}`}
                          className="flex flex-wrap items-baseline gap-x-2"
                        >
                          <span className="font-mono text-white truncate max-w-[18rem]" title={row.email}>{row.email}</span>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-white">
                            <Trans
                              i18nKey="admin:walletRefundDigestSchedule.recipientWillReceiveIn"
                              values={{ language: languageDisplayName(row.resolvedDigestLanguage) }}
                              components={{
                                lang: (
                                  <span
                                    className="text-amber-300"
                                    data-testid={`refund-digest-recipient-language-resolved-${idx}`}
                                  />
                                ),
                              }}
                            />
                          </span>
                          {row.mismatch && row.userPreferredLanguage && (
                            <span
                              className="text-amber-300/80"
                              data-testid={`refund-digest-recipient-language-mismatch-${idx}`}
                              title={t('walletRefundDigestSchedule.recipientPreferenceMismatchTooltip', {
                                preferred: languageDisplayName(row.userPreferredLanguage),
                                resolved: languageDisplayName(row.resolvedDigestLanguage),
                              })}
                            >
                              {t('walletRefundDigestSchedule.recipientPreferenceUntranslated', {
                                language: row.userPreferredLanguage,
                              })}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => saveMut.mutate()}
                disabled={!canSave || saveMut.isPending}
                data-testid="button-save-refund-digest-schedule"
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {saveMut.isPending
                  ? t('walletRefundDigestSchedule.saveButtonSaving')
                  : sched
                    ? t('walletRefundDigestSchedule.saveButtonUpdate')
                    : t('walletRefundDigestSchedule.saveButtonCreate')}
              </Button>
              {sched && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => previewMut.mutate(effectivePreviewLang)}
                    disabled={previewMut.isPending}
                    data-testid="button-preview-refund-digest"
                    className="border-white/10 text-white gap-1.5"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    {previewMut.isPending
                      ? t('walletRefundDigestSchedule.previewButtonLoading')
                      : t('walletRefundDigestSchedule.previewButton')}
                  </Button>
                  {/* Task #1746 — language picker (defaults to the
                      resolved schedule language) so a treasurer can
                      preview any of the 21 supported translations
                      without first changing the org's default language.
                      Both controls share a row so it's clear the picker
                      modifies the adjacent send button only. */}
                  <div className="inline-flex items-stretch gap-1">
                    <Select
                      value={effectivePreviewLang}
                      onValueChange={v => setPreviewLang(v)}
                      disabled={sendPreviewMut.isPending}
                    >
                      <SelectTrigger
                        className="h-8 w-[150px] text-xs bg-black/40 border-white/10 text-white"
                        data-testid="select-refund-digest-preview-language"
                        aria-label={t('walletRefundDigestSchedule.previewLanguageLabel')}
                        title={t('walletRefundDigestSchedule.previewLanguageTitle')}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORTED_LANGUAGES.map(l => (
                          <SelectItem key={l.code} value={l.code}>
                            {l.name} ({l.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => sendPreviewMut.mutate(effectivePreviewLang)}
                      disabled={sendPreviewMut.isPending}
                      data-testid="button-send-refund-digest-preview"
                      className="border-white/10 text-white gap-1.5"
                      title={t('walletRefundDigestSchedule.sendPreviewButtonTitle')}
                    >
                      <Send className="w-3.5 h-3.5" />
                      {sendPreviewMut.isPending
                        ? t('walletRefundDigestSchedule.sendPreviewButtonSending')
                        : t('walletRefundDigestSchedule.sendPreviewButton')}
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => sendNowMut.mutate()}
                    disabled={sendNowMut.isPending || !sched.enabled || sched.recipients.length === 0}
                    data-testid="button-send-refund-digest-now"
                    className="border-white/10 text-white"
                  >
                    {sendNowMut.isPending
                      ? t('walletRefundDigestSchedule.sendNowButtonSending')
                      : t('walletRefundDigestSchedule.sendNowButton')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { if (confirm(t('walletRefundDigestSchedule.removeConfirm'))) deleteMut.mutate(); }}
                    disabled={deleteMut.isPending}
                    data-testid="button-delete-refund-digest-schedule"
                    className="text-rose-300 hover:text-rose-200"
                  >
                    {t('walletRefundDigestSchedule.removeButton')}
                  </Button>
                </>
              )}
            </div>
            {sched && (
              <div className="border border-white/10 rounded-md overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-black/40 text-[10px] text-muted-foreground uppercase tracking-wider">
                    <tr>
                      <th className="text-left px-2 py-1.5">{t('walletRefundDigestSchedule.historySent')}</th>
                      <th className="text-left px-2 py-1.5">{t('walletRefundDigestSchedule.historyPeriod')}</th>
                      <th className="text-left px-2 py-1.5">{t('walletRefundDigestSchedule.historyCurrencies')}</th>
                      <th className="text-left px-2 py-1.5">{t('walletRefundDigestSchedule.historyRefunds')}</th>
                      <th className="text-left px-2 py-1.5">{t('walletRefundDigestSchedule.historyRecipients')}</th>
                      {/* Task #1759 — per-run "X paused" column so finance can
                          see at a glance which recipients were silently
                          dropped from a specific run, without parsing the
                          free-text errorMessage. */}
                      <th className="text-left px-2 py-1.5">{t('walletRefundDigestSchedule.historyPaused')}</th>
                      <th className="text-left px-2 py-1.5">{t('walletRefundDigestSchedule.historyStatus')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.length === 0 ? (
                      <tr><td colSpan={7} className="px-2 py-3 text-center text-muted-foreground" data-testid="refund-digest-history-empty">{t('walletRefundDigestSchedule.historyEmpty')}</td></tr>
                    ) : history.map(h => {
                      const tone = h.status === 'sent' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                        : h.status === 'failed' ? 'bg-red-500/20 text-red-300 border-red-500/30'
                        : 'bg-amber-500/20 text-amber-300 border-amber-500/30';
                      // Task #1759 — defensive: an older row inserted before
                      // the column existed will still come back as `[]`
                      // thanks to the column default, but normalise
                      // `undefined`/non-array shapes so the chip never
                      // crashes the table.
                      const runPaused: PausedRecipientSnapshot[] = Array.isArray(h.pausedRecipients) ? h.pausedRecipients : [];
                      const pausedTitle = runPaused
                        .map(p => `${p.email} — ${pausedReasonLabel(t, p.reason, p.bounceType)}${p.description ? ` (${p.description})` : ''}`)
                        .join('\n');
                      const statusLabel = h.status === 'sent'
                        ? t('walletRefundDigestSchedule.statusSent')
                        : h.status === 'failed'
                          ? t('walletRefundDigestSchedule.statusFailed')
                          : t('walletRefundDigestSchedule.statusSkipped');
                      return (
                        <tr key={h.id} className="border-t border-white/5 align-top" data-testid={`refund-digest-history-row-${h.id}`}>
                          <td className="px-2 py-1.5 text-white whitespace-nowrap">{new Date(h.sentAt).toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{fmtPeriod(h.periodStart, h.periodEnd)}</td>
                          <td className="px-2 py-1.5 text-white">{h.currencyCount}</td>
                          <td className="px-2 py-1.5 text-white">{h.rowCount}</td>
                          <td className="px-2 py-1.5 text-muted-foreground max-w-[14rem] truncate" title={h.recipients.join(', ')}>
                            {t('walletRefundDigestSchedule.historyRecipientsCell', {
                              count: h.recipients.length,
                              list: h.recipients.join(', '),
                            })}
                          </td>
                          <td className="px-2 py-1.5">
                            {runPaused.length === 0 ? (
                              <span
                                className="text-muted-foreground"
                                data-testid={`refund-digest-history-paused-empty-${h.id}`}
                              >
                                —
                              </span>
                            ) : (
                              <div
                                className="space-y-0.5"
                                data-testid={`refund-digest-history-paused-${h.id}`}
                              >
                                <span
                                  title={pausedTitle}
                                  className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-amber-200 text-[10px]"
                                  data-testid={`refund-digest-history-paused-chip-${h.id}`}
                                >
                                  <AlertTriangle className="w-3 h-3" />
                                  {t('walletRefundDigestSchedule.historyPausedChip', { count: runPaused.length })}
                                </span>
                                <ul className="text-[10px] text-amber-200/80 max-w-[16rem] space-y-0.5">
                                  {runPaused.map((p, idx) => {
                                    // Task #2197 — historical paused chips
                                    // are snapshots stored on the run row,
                                    // so they don't disappear when finance
                                    // lifts the suppression. Strike through
                                    // any address already lifted in this
                                    // session so the action's outcome is
                                    // visible inline.
                                    const isLifted = liftedEmails.has(p.email.trim().toLowerCase());
                                    return (
                                      <li
                                        key={`${h.id}-${p.email}-${idx}`}
                                        className="flex items-center gap-1.5"
                                        title={`${p.email} — ${pausedReasonLabel(t, p.reason, p.bounceType)}${p.description ? ` (${p.description})` : ''}`}
                                        data-testid={`refund-digest-history-paused-row-${h.id}-${idx}`}
                                        data-lifted={isLifted ? 'true' : 'false'}
                                      >
                                        <span className={`min-w-0 flex-1 truncate ${isLifted ? 'line-through opacity-60' : ''}`}>
                                          <span className="font-mono">{p.email}</span>
                                          <span className="text-amber-300/70"> · {pausedReasonLabel(t, p.reason, p.bounceType)}</span>
                                        </span>
                                        {/* Task #2197 — let finance lift the
                                            paused address straight from this
                                            historical row instead of having
                                            to scroll back to the schedule
                                            chip. Wired to the same
                                            unsuppressMut as the schedule
                                            editor's chip (Task #1443) so the
                                            backend semantics are identical. */}
                                        <button
                                          type="button"
                                          onClick={() => unsuppressMut.mutate(p.email)}
                                          disabled={isLifted || unsuppressMut.isPending}
                                          data-testid={`button-refund-digest-history-unsuppress-${h.id}-${idx}`}
                                          title={t('admin:walletRefundDigestPaused.removeButton')}
                                          aria-label={t('admin:walletRefundDigestPaused.removeButton')}
                                          className="shrink-0 inline-flex items-center gap-0.5 rounded border border-amber-500/40 px-1.5 py-0.5 text-[10px] text-amber-100 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                        >
                                          <X className="w-2.5 h-2.5" />
                                        </button>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <Badge className={`${tone} border text-[10px]`}>{statusLabel}</Badge>
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
          <DialogContent className="max-w-3xl bg-[#0a1628] border-white/10 text-white" data-testid="dialog-refund-digest-preview">
            <DialogHeader>
              <DialogTitle className="text-white">{t('walletRefundDigestSchedule.previewDialogTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground text-xs">
                {t('walletRefundDigestSchedule.previewDialogDescription')}
              </DialogDescription>
            </DialogHeader>
            {previewMut.data && (
              <div className="space-y-3 max-h-[70vh] overflow-y-auto">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('walletRefundDigestSchedule.previewSubject')}</div>
                    <div className="text-white" data-testid="text-refund-preview-subject">{previewMut.data.subject}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('walletRefundDigestSchedule.previewRecipients')}</div>
                    <div className="text-white" data-testid="text-refund-preview-recipients">
                      {previewMut.data.recipients.length === 0 ? '—' : previewMut.data.recipients.join(', ')}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('walletRefundDigestSchedule.previewPeriod')}</div>
                    <div className="text-white">
                      {new Date(previewMut.data.periodStart).toLocaleString()} → {new Date(previewMut.data.periodEnd).toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('walletRefundDigestSchedule.previewCsvContents')}</div>
                    <div className="text-white" data-testid="text-refund-preview-counts">
                      <Trans
                        i18nKey="admin:walletRefundDigestSchedule.previewCounts"
                        count={previewMut.data.rowCount}
                        values={{
                          rowCount: previewMut.data.rowCount,
                          currencyCount: previewMut.data.currencyCount,
                        }}
                        components={{
                          rows: <span className="text-amber-400 font-semibold" />,
                          currencies: <span className="text-amber-400 font-semibold" />,
                        }}
                      />
                    </div>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{t('walletRefundDigestSchedule.previewRenderedBody')}</div>
                  <div className="border border-white/10 rounded-md bg-white overflow-hidden">
                    <iframe
                      title={t('walletRefundDigestSchedule.previewIframeTitle')}
                      srcDoc={previewMut.data.html}
                      sandbox=""
                      className="w-full h-[420px] bg-white"
                      data-testid="iframe-refund-preview-body"
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
                data-testid="button-close-refund-preview"
              >
                {t('walletRefundDigestSchedule.previewClose')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
