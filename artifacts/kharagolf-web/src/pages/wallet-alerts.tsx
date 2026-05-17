import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, Download, Filter, Mail,
  MessageCircle, MessageSquare,
  RefreshCw, RotateCw, Search, Smartphone, X, XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import type { StuckWithdrawalNotifyResponse } from '@/lib/wallet-alerts-types';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
function API(path: string) {
  return `${BASE_URL}/api${path}`;
}

const PAGE_SIZE = 50;

const currencySymbol: Record<string, string> = {
  INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'د.إ', SGD: 'S$',
};

function fmtMoney(value: number, currency: string): string {
  const sym = currencySymbol[currency] ?? '';
  return `${sym}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function outcomeLabel(outcome: string): string {
  if (outcome === 'processed') return 'Paid';
  if (outcome === 'reversed') return 'Reversed';
  if (outcome === 'failed') return 'Failed';
  return outcome;
}

interface AcknowledgeResponse {
  acknowledged: number;
  alreadyAcknowledged: number;
  notFound: number;
}

interface RetryResponse {
  requeued: number;
  emailRequeued: number;
  pushRequeued: number;
  alreadyHealthy: number;
  notFound: number;
}

export default function WalletAlertsPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const orgId = useActiveOrgId() ?? me?.organizationId ?? null;
  const isAdmin = ['org_admin', 'tournament_director', 'super_admin'].includes(
    (me as { role?: string } | undefined)?.role ?? '',
  );

  const [channel, setChannel] = useState<'all' | 'email' | 'push'>('all');
  const [state, setState] = useState<'all' | 'exhausted' | 'skipped'>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const queryParams = useMemo(() => {
    const sp = new URLSearchParams();
    if (orgId) sp.set('organizationId', String(orgId));
    if (channel !== 'all') sp.set('channel', channel);
    if (state !== 'all') sp.set('state', state);
    if (q.trim()) sp.set('q', q.trim());
    sp.set('limit', String(PAGE_SIZE));
    sp.set('offset', String(page * PAGE_SIZE));
    return sp.toString();
  }, [orgId, channel, state, q, page]);

  // Task #1844 — CSV download mirrors the JSON filters but drops
  // pagination so finance/support get the full filtered worklist in
  // one shot, not just the page they're looking at.
  const csvHref = useMemo(() => {
    if (!orgId) return null;
    const sp = new URLSearchParams();
    sp.set('organizationId', String(orgId));
    if (channel !== 'all') sp.set('channel', channel);
    if (state !== 'all') sp.set('state', state);
    if (q.trim()) sp.set('q', q.trim());
    return API(`/admin/wallet-withdrawal-notify-failures.csv?${sp.toString()}`);
  }, [orgId, channel, state, q]);

  const queryKey = ['wallet-withdrawal-notify-failures', orgId, channel, state, q, page] as const;

  const { data, isLoading, isFetching, isError, error, refetch } =
    useQuery<StuckWithdrawalNotifyResponse>({
      queryKey,
      enabled: !!orgId && isAdmin,
      queryFn: async () => {
        const res = await fetch(API(`/admin/wallet-withdrawal-notify-failures?${queryParams}`), {
          credentials: 'include',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({} as { error?: string }));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      },
      refetchInterval: 60_000,
    });

  const items = data?.items ?? [];
  const counts = data?.counts;
  const total = counts?.total ?? 0;
  const effectivePageSize = data?.page?.limit ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
  const filtersActive = channel !== 'all' || state !== 'all' || q.trim().length > 0;

  // Drop selections for rows that no longer appear in the worklist (e.g.
  // because they were just acknowledged, retried, or moved off-page).
  // Without this, an admin could keep "Retry selected" enabled for ids
  // that the server has long since cleared, leading to confusing 0-row
  // success toasts.
  useEffect(() => {
    setSelectedIds(prev => {
      const visible = new Set(items.map(i => i.id));
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (visible.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [items]);

  const clearFilters = () => {
    setChannel('all');
    setState('all');
    setQ('');
    setPage(0);
  };

  const onChannelChange = (v: 'all' | 'email' | 'push') => { setChannel(v); setPage(0); };
  const onStateChange = (v: 'all' | 'exhausted' | 'skipped') => { setState(v); setPage(0); };
  const onSearchChange = (v: string) => { setQ(v); setPage(0); };

  // Invalidate every cache entry that hangs off the wallet-alerts
  // endpoint (the dashboard widget uses one prefix, this page uses
  // another) so the row counts shrink everywhere as soon as a bulk
  // action lands.
  const invalidateAlertCaches = () => {
    void queryClient.invalidateQueries({
      predicate: q => Array.isArray(q.queryKey)
        && typeof q.queryKey[0] === 'string'
        && q.queryKey[0].includes('wallet-withdrawal-notify-failures'),
    });
  };

  const ackMutation = useMutation({
    mutationFn: async (ids: number[]): Promise<AcknowledgeResponse> => {
      const res = await fetch(API('/admin/wallet-withdrawal-notify-failures/acknowledge'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId, ids }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<AcknowledgeResponse>;
    },
    onSuccess: (result, ids) => {
      const msg = result.alreadyAcknowledged > 0
        ? `Dismissed ${result.acknowledged} alert${result.acknowledged === 1 ? '' : 's'} (${result.alreadyAcknowledged} already cleared).`
        : `Dismissed ${result.acknowledged} alert${result.acknowledged === 1 ? '' : 's'}.`;
      toast({ title: 'Alerts dismissed', description: msg });
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      invalidateAlertCaches();
    },
    onError: (err: Error) => {
      toast({
        variant: 'destructive',
        title: 'Could not dismiss alerts',
        description: err.message,
      });
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (ids: number[]): Promise<RetryResponse> => {
      const res = await fetch(API('/admin/wallet-withdrawal-notify-failures/retry'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId, ids }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<RetryResponse>;
    },
    onSuccess: (result, ids) => {
      const msg = result.requeued === 0
        ? 'Selected alerts already had no stuck channels to retry.'
        : `Re-queued ${result.requeued} alert${result.requeued === 1 ? '' : 's'} for delivery (${result.emailRequeued} email · ${result.pushRequeued} push).`;
      toast({ title: 'Retry queued', description: msg });
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      invalidateAlertCaches();
    },
    onError: (err: Error) => {
      toast({
        variant: 'destructive',
        title: 'Could not re-queue alerts',
        description: err.message,
      });
    },
  });

  const isMutating = ackMutation.isPending || retryMutation.isPending;

  const allOnPageSelected = items.length > 0 && items.every(i => selectedIds.has(i.id));
  const someOnPageSelected = items.some(i => selectedIds.has(i.id));

  const togglePageSelection = (checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) {
        for (const it of items) next.add(it.id);
      } else {
        for (const it of items) next.delete(it.id);
      }
      return next;
    });
  };

  const toggleRow = (id: number, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  if (meLoading) {
    return (
      <div className="min-h-screen bg-[#0a1628] text-white p-6 flex items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!orgId || !isAdmin) {
    return (
      <div className="min-h-screen bg-[#0a1628] text-white p-6">
        <div className="max-w-3xl mx-auto bg-black/30 border border-white/10 rounded-xl p-6 text-center">
          <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
          <h1 className="text-lg font-semibold mb-1">Admins only</h1>
          <p className="text-sm text-muted-foreground">
            This page is restricted to organization admins.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a1628] text-white p-6" data-testid="page-wallet-alerts">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <Link href={`${BASE_URL}/`}>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-white hover:bg-white/5 gap-1.5 mb-2"
                data-testid="link-back-to-dashboard"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back to dashboard
              </Button>
            </Link>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              Stuck wallet withdrawal alerts
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Withdrawal notifications whose email or push delivery is stuck — either retried
              until exhausted, or skipped because the channel was missing or opted out. Reach
              out to the member to confirm the payout landed even though the receipt didn't.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {csvHref && (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="border-white/10 text-white hover:bg-white/5 gap-1.5"
                data-testid="button-export-csv"
              >
                <a href={csvHref} download>
                  <Download className="w-3.5 h-3.5" />
                  Export CSV
                </a>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="border-white/10 text-white hover:bg-white/5 gap-1.5"
              data-testid="button-refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        <Card className="bg-black/30 border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Filter className="w-4 h-4 text-primary" /> Filters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-4 gap-3 items-end">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Channel</label>
                <Select value={channel} onValueChange={(v) => onChannelChange(v as typeof channel)}>
                  <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white" data-testid="select-channel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All channels</SelectItem>
                    <SelectItem value="email">Email only</SelectItem>
                    <SelectItem value="push">Push only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">State</label>
                <Select value={state} onValueChange={(v) => onStateChange(v as typeof state)}>
                  <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white" data-testid="select-state">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All states</SelectItem>
                    <SelectItem value="exhausted">Retried until exhausted</SelectItem>
                    <SelectItem value="skipped">Skipped before delivery</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Recipient name or email</label>
                <div className="relative mt-1">
                  <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <Input
                    type="search"
                    value={q}
                    onChange={e => onSearchChange(e.target.value)}
                    placeholder="e.g. Alice or alice@…"
                    className="pl-8 bg-black/40 border-white/10 text-white"
                    data-testid="input-recipient-search"
                  />
                </div>
              </div>
            </div>
            {filtersActive && (
              <div className="mt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="text-xs text-muted-foreground hover:text-white"
                  data-testid="button-clear-filters"
                >
                  <X className="w-3 h-3 mr-1" /> Clear filters
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {counts && (
          <div className="grid grid-cols-3 gap-3">
            <SummaryCard
              label="Total stuck"
              value={counts.total}
              accent="text-amber-300"
              testId="summary-total"
            />
            <SummaryCard
              label="Retried until exhausted"
              value={counts.exhausted}
              accent="text-rose-300"
              testId="summary-exhausted"
            />
            <SummaryCard
              label="Skipped before delivery"
              value={counts.skipped}
              accent="text-amber-300"
              testId="summary-skipped"
            />
          </div>
        )}

        {selectedIds.size > 0 && (
          <div
            className="sticky top-2 z-10 flex items-center gap-3 flex-wrap rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm"
            data-testid="bar-bulk-actions"
          >
            <span className="text-amber-100 font-medium" data-testid="text-bulk-selection-count">
              {selectedIds.size} alert{selectedIds.size === 1 ? '' : 's'} selected
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isMutating}
                onClick={() => retryMutation.mutate([...selectedIds])}
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20 hover:text-white gap-1.5"
                data-testid="button-bulk-retry"
              >
                <RotateCw className={`w-3.5 h-3.5 ${retryMutation.isPending ? 'animate-spin' : ''}`} />
                Retry selected
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isMutating}
                onClick={() => ackMutation.mutate([...selectedIds])}
                className="border-white/20 bg-white/5 text-white hover:bg-white/10 gap-1.5"
                data-testid="button-bulk-dismiss"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                Dismiss selected
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={isMutating}
                onClick={() => setSelectedIds(new Set())}
                className="text-white/70 hover:text-white hover:bg-white/5"
                data-testid="button-bulk-clear-selection"
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}

        <Card className="bg-black/30 border-white/10">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
              <span>Alerts</span>
              {counts && (
                <span className="text-xs font-normal text-muted-foreground" data-testid="text-alerts-count">
                  {counts.total.toLocaleString()} match{counts.total === 1 ? '' : 'es'}
                  {counts.total > 0 && (
                    <>
                      {' · '}
                      showing {(page * effectivePageSize + 1).toLocaleString()}–
                      {Math.min((page + 1) * effectivePageSize, counts.total).toLocaleString()}
                    </>
                  )}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="py-8 text-center text-muted-foreground text-sm">Loading…</div>
            ) : isError ? (
              <div
                className="py-6 text-center text-rose-300 text-sm bg-rose-500/10 border border-rose-500/30 rounded-lg"
                data-testid="text-alerts-error"
              >
                Couldn't load alerts: {(error as Error)?.message ?? 'Unknown error'}
              </div>
            ) : items.length === 0 ? (
              <div
                className="py-10 text-center text-muted-foreground text-sm"
                data-testid="text-no-alerts"
              >
                {filtersActive
                  ? 'No stuck wallet alerts match the current filters.'
                  : 'No stuck wallet withdrawal alerts. All clear.'}
              </div>
            ) : (
              <>
                <div className="border border-white/10 rounded-lg overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-wallet-alerts">
                    <thead className="bg-black/40 text-xs text-muted-foreground uppercase tracking-wider">
                      <tr>
                        <th className="text-left px-3 py-2 w-8">
                          <Checkbox
                            checked={allOnPageSelected ? true : (someOnPageSelected ? 'indeterminate' : false)}
                            onCheckedChange={(v) => togglePageSelection(v === true)}
                            aria-label="Select all visible alerts"
                            data-testid="checkbox-select-all"
                          />
                        </th>
                        <th className="text-left px-3 py-2">When</th>
                        <th className="text-left px-3 py-2">Recipient</th>
                        <th className="text-left px-3 py-2">Withdrawal</th>
                        <th className="text-right px-3 py-2">Amount</th>
                        <th className="text-left px-3 py-2">Channels</th>
                        <th className="text-right px-3 py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(it => {
                        const isSelected = selectedIds.has(it.id);
                        const eitherStuck = it.emailStuck || it.pushStuck;
                        return (
                          <tr
                            key={it.id}
                            className={`border-t border-white/5 align-top ${isSelected ? 'bg-amber-500/5' : ''}`}
                            data-testid={`row-wallet-alert-${it.id}`}
                          >
                            <td className="px-3 py-2">
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={(v) => toggleRow(it.id, v === true)}
                                aria-label={`Select alert ${it.id}`}
                                data-testid={`checkbox-row-${it.id}`}
                              />
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                              {fmtDateTime(it.createdAt)}
                            </td>
                            <td className="px-3 py-2">
                              <Link
                                href={`${BASE_URL}/member-360/${it.userId}?tab=financial`}
                                className="text-white hover:text-primary transition-colors"
                                data-testid={`link-recipient-${it.id}`}
                              >
                                {it.recipientName ?? `User #${it.userId}`}
                              </Link>
                              {it.recipientEmail && (
                                <div className="text-xs text-muted-foreground truncate max-w-[18rem]">
                                  {it.recipientEmail}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <Link
                                href={`${BASE_URL}/member-360/${it.userId}?tab=financial&withdrawalId=${it.withdrawalId}#withdrawal-${it.withdrawalId}`}
                                className="text-white hover:text-primary transition-colors text-sm"
                                data-testid={`link-withdrawal-${it.id}`}
                              >
                                Withdrawal #{it.withdrawalId}
                              </Link>
                              <div className="text-xs text-muted-foreground">
                                {outcomeLabel(it.outcome)} · {it.destination}
                                {it.utr ? ` · UTR ${it.utr}` : ''}
                              </div>
                              {it.reason && (
                                <div className="text-[10px] text-rose-300/80 mt-0.5">{it.reason}</div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right text-amber-300 whitespace-nowrap font-semibold">
                              {fmtMoney(it.amount, it.currency)}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1.5">
                                {it.emailStuck && (
                                  <Badge
                                    variant="outline"
                                    className="border-amber-500/40 bg-amber-500/15 text-amber-200 text-[10px] gap-1"
                                    data-testid={`badge-alert-email-${it.id}`}
                                    data-status={it.emailStatus ?? 'unknown'}
                                    title={it.lastEmailError ?? undefined}
                                  >
                                    <Mail className="w-3 h-3" />
                                    Email · {it.emailRetryExhaustedAt
                                      ? `exhausted (${it.emailAttempts})`
                                      : it.emailStatus ?? 'skipped'}
                                  </Badge>
                                )}
                                {it.pushStuck && (
                                  <Badge
                                    variant="outline"
                                    className="border-amber-500/40 bg-amber-500/15 text-amber-200 text-[10px] gap-1"
                                    data-testid={`badge-alert-push-${it.id}`}
                                    data-status={it.pushStatus ?? 'unknown'}
                                    title={it.lastPushError ?? undefined}
                                  >
                                    <Smartphone className="w-3 h-3" />
                                    Push · {it.pushRetryExhaustedAt
                                      ? `exhausted (${it.pushAttempts})`
                                      : it.pushStatus ?? 'skipped'}
                                  </Badge>
                                )}
                                {/* Task #1825 — SMS / WhatsApp delivery
                                    snapshot. These channels are not
                                    retried by the wallet-withdrawal
                                    cron, so we render them as a
                                    read-only neutral pill (no amber
                                    "stuck" colour) — the row only
                                    surfaces here because email or push
                                    is stuck above. */}
                                {it.smsStatus && (
                                  <Badge
                                    variant="outline"
                                    className="border-white/15 bg-white/5 text-white/80 text-[10px] gap-1"
                                    data-testid={`badge-alert-sms-${it.id}`}
                                    data-status={it.smsStatus}
                                    title={it.smsError ?? undefined}
                                  >
                                    <MessageSquare className="w-3 h-3" />
                                    SMS · {it.smsStatus}
                                  </Badge>
                                )}
                                {it.whatsappStatus && (
                                  <Badge
                                    variant="outline"
                                    className="border-white/15 bg-white/5 text-white/80 text-[10px] gap-1"
                                    data-testid={`badge-alert-whatsapp-${it.id}`}
                                    data-status={it.whatsappStatus}
                                    title={it.whatsappError ?? undefined}
                                  >
                                    <MessageCircle className="w-3 h-3" />
                                    WhatsApp · {it.whatsappStatus}
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              <div className="flex items-center justify-end gap-1.5">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={isMutating || !eitherStuck}
                                  onClick={() => retryMutation.mutate([it.id])}
                                  className="h-7 px-2 text-emerald-200 hover:text-emerald-100 hover:bg-emerald-500/10 gap-1"
                                  data-testid={`button-retry-${it.id}`}
                                  title="Re-queue email and push delivery for this alert"
                                >
                                  <RotateCw className="w-3 h-3" />
                                  Retry
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={isMutating}
                                  onClick={() => ackMutation.mutate([it.id])}
                                  className="h-7 px-2 text-white/70 hover:text-white hover:bg-white/5 gap-1"
                                  data-testid={`button-dismiss-${it.id}`}
                                  title="Mark this alert as manually followed up"
                                >
                                  <XCircle className="w-3 h-3" />
                                  Dismiss
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-between gap-3 mt-4">
                    <div className="text-xs text-muted-foreground" data-testid="text-page-indicator">
                      Page {page + 1} of {totalPages}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page === 0 || isFetching}
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        className="border-white/10 text-white hover:bg-white/5 gap-1"
                        data-testid="button-prev-page"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" /> Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page + 1 >= totalPages || isFetching}
                        onClick={() => setPage(p => p + 1)}
                        className="border-white/10 text-white hover:bg-white/5 gap-1"
                        data-testid="button-next-page"
                      >
                        Next <ChevronRight className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
  testId,
}: {
  label: string;
  value: number;
  accent: string;
  testId: string;
}) {
  return (
    <Card className="bg-black/30 border-white/10" data-testid={testId}>
      <CardContent className="pt-5 pb-5">
        <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className={`mt-1 text-2xl font-semibold ${accent}`}>{value.toLocaleString()}</p>
      </CardContent>
    </Card>
  );
}
