import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGetMe, useGetOrganizationStats, useListTournaments, getGetOrganizationStatsQueryKey, getListTournamentsQueryKey } from '@workspace/api-client-react';
import { isMemberAdmin } from '@workspace/member-admin-roles';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { motion } from 'framer-motion';
import {
  Trophy, Users, Activity, Target, ArrowRight, Map, RefreshCw,
  TrendingUp, BarChart2, Star, Zap, Medal, Bird, DollarSign,
  Shield, AlertTriangle, Clock, Search, Wallet, CheckCheck, Eye,
  Mail, Languages,
} from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Link } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import type { StuckWithdrawalNotifyItem, StuckWithdrawalNotifyResponse } from '@/lib/wallet-alerts-types';
import {
  AreaChart, Area, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, LineChart, Line,
  PieChart, Pie, Cell, CartesianGrid, Legend,
} from 'recharts';
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n';

const CHART_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

function API(path: string) {
  return `${BASE_URL}/api${path}`;
}

interface ClubStats {
  bestScoringAverage: { playerName: string; rounds: number; avgGross: number }[];
  mostEagles: { playerName: string; eagles: number; rounds: number }[];
  mostBirdies: { playerName: string; birdies: number; rounds: number }[];
  formatPopularity: { format: string; count: number }[];
  monthlyPlayerGrowth: { month: string; players: number }[];
  monthlyRevenue: { month: string; revenue: number }[];
  retentionRate: number | null;
  eventParticipation: { tournamentId: number; name: string; players: number; paidPlayers: number }[];
  consistencyLeaders: { playerName: string; rounds: number }[];
  totals: { tournaments: number; players: number; rounds: number; scores: number };
}

function StatLeaderboard({
  title, icon: Icon, items, valueKey, valueLabel, color = 'text-primary',
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  items: Record<string, unknown>[];
  valueKey: string;
  valueLabel: string;
  color?: string;
}) {
  const { t } = useTranslation('dashboard');
  return (
    <Card className="glass-card border-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-white flex items-center gap-2 text-base">
          <Icon className={`w-4 h-4 ${color}`} />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <p className="text-muted-foreground text-sm px-6 pb-4">{t('noDataYet')}</p>
        ) : (
          <div className="divide-y divide-white/5">
            {items.slice(0, 10).map((row, i) => (
              <div key={i} className="flex items-center justify-between px-6 py-2.5">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-bold text-muted-foreground w-5 text-right">#{i + 1}</span>
                  <span className="text-sm text-white">{row.playerName as string}</span>
                </div>
                <span className={`text-sm font-semibold ${color}`}>
                  {typeof row[valueKey] === 'number' ? (row[valueKey] as number).toFixed(
                    valueKey === 'avgGross' ? 1 : 0
                  ) : String(row[valueKey])} {valueLabel}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ClubStatsTab({ orgId }: { orgId: number }) {
  const { t } = useTranslation('dashboard');
  const { data: cs, isLoading } = useQuery<ClubStats>({
    queryKey: ['/api/organizations', orgId, 'club-stats'],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/club-stats`), { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load club stats');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
      {[...Array(6)].map((_, i) => (
        <Card key={i} className="glass-card border-none h-64 animate-pulse" />
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: t('stats.tournaments'), value: cs?.totals.tournaments ?? 0, icon: Trophy },
          { label: t('stats.players'), value: cs?.totals.players ?? 0, icon: Users },
          { label: t('stats.roundsCompleted'), value: cs?.totals.rounds ?? 0, icon: Target },
          { label: t('stats.retentionRate'), value: cs?.retentionRate != null ? `${cs.retentionRate}%` : '—', icon: TrendingUp },
        ].map((s, i) => (
          <Card key={i} className="glass-card border-none">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
                <p className="text-2xl font-display font-bold text-white">{s.value}</p>
              </div>
              <s.icon className="w-5 h-5 text-primary opacity-60" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        <StatLeaderboard
          title={t('leaderboards.bestScoringAverage')}
          icon={Target}
          items={cs?.bestScoringAverage ?? []}
          valueKey="avgGross"
          valueLabel={t('leaderboards.valueLabels.avg')}
          color="text-primary"
        />
        <StatLeaderboard
          title={t('leaderboards.mostBirdies')}
          icon={Bird}
          items={cs?.mostBirdies ?? []}
          valueKey="birdies"
          valueLabel={t('leaderboards.valueLabels.birdies')}
          color="text-yellow-400"
        />
        <StatLeaderboard
          title={t('leaderboards.mostEagles')}
          icon={Star}
          items={cs?.mostEagles ?? []}
          valueKey="eagles"
          valueLabel={t('leaderboards.valueLabels.eagles')}
          color="text-orange-400"
        />
        <StatLeaderboard
          title={t('leaderboards.mostConsistent')}
          icon={Medal}
          items={cs?.consistencyLeaders ?? []}
          valueKey="rounds"
          valueLabel={t('leaderboards.valueLabels.rounds')}
          color="text-blue-400"
        />

        <Card className="glass-card border-none md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-white flex items-center gap-2 text-base">
              <Zap className="w-4 h-4 text-purple-400" />
              {t('charts.formatPopularity')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(cs?.formatPopularity ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noDataYet')}</p>
            ) : (
              <div className="flex gap-6 items-center">
                <ResponsiveContainer width={180} height={180}>
                  <PieChart>
                    <Pie
                      data={cs!.formatPopularity}
                      dataKey="count"
                      nameKey="format"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                    >
                      {cs!.formatPopularity.map((_, idx) => (
                        <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#111', border: 'none', color: '#fff' }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2 flex-1 min-w-0">
                  {cs!.formatPopularity.map((f, idx) => (
                    <div key={f.format} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: CHART_COLORS[idx % CHART_COLORS.length] }} />
                        <span className="text-white truncate capitalize">{f.format.replace(/_/g, ' ')}</span>
                      </div>
                      <span className="text-muted-foreground ml-2">{f.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {(cs?.eventParticipation ?? []).length > 0 && (
        <Card className="glass-card border-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base">{t('charts.eventParticipationLast12')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={cs!.eventParticipation} margin={{ top: 0, right: 0, left: -20, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 10 }} angle={-40} textAnchor="end" interval={0} />
                <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#111', border: 'none', color: '#fff' }} />
                <Bar dataKey="players" name={t('charts.seriesRegistered')} fill="#22c55e" radius={[3, 3, 0, 0]} />
                <Bar dataKey="paidPlayers" name={t('charts.seriesPaid')} fill="#3b82f6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AnalyticsTab({ orgId }: { orgId: number }) {
  const { t } = useTranslation('dashboard');
  const { data: cs, isLoading } = useQuery<ClubStats>({
    queryKey: ['/api/organizations', orgId, 'club-stats'],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/club-stats`), { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load analytics');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {[...Array(4)].map((_, i) => (
        <Card key={i} className="glass-card border-none h-72 animate-pulse" />
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: t('stats.totalEvents'), value: cs?.totals.tournaments ?? 0, icon: Trophy, color: 'text-primary bg-primary/10' },
          { label: t('stats.totalPlayers'), value: cs?.totals.players ?? 0, icon: Users, color: 'text-blue-400 bg-blue-400/10' },
          { label: t('stats.totalRounds'), value: cs?.totals.rounds ?? 0, icon: Activity, color: 'text-orange-400 bg-orange-400/10' },
          { label: t('stats.retentionRate'), value: cs?.retentionRate != null ? `${cs.retentionRate}%` : '—', icon: TrendingUp, color: 'text-purple-400 bg-purple-400/10' },
        ].map((s, i) => (
          <Card key={i} className="glass-card border-none">
            <CardContent className="p-5 flex items-center gap-4">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${s.color.split(' ').slice(1).join(' ')}`}>
                <s.icon className={`w-5 h-5 ${s.color.split(' ')[0]}`} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-2xl font-bold text-white font-display">{s.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="glass-card border-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-white flex items-center gap-2 text-base">
              <Users className="w-4 h-4 text-blue-400" />
              {t('charts.monthlyGrowth')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={cs?.monthlyPlayerGrowth ?? []}>
                <defs>
                  <linearGradient id="playerGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="month" tick={{ fill: '#6b7280', fontSize: 11 }} />
                <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }} />
                <Area type="monotone" dataKey="players" stroke="#22c55e" fill="url(#playerGrad)" strokeWidth={2} name={t('charts.seriesNewPlayers')} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="glass-card border-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-white flex items-center gap-2 text-base">
              <DollarSign className="w-4 h-4 text-green-400" />
              {t('charts.revenueTrend')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={cs?.monthlyRevenue ?? []} margin={{ top: 0, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="month" tick={{ fill: '#6b7280', fontSize: 11 }} />
                <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }} formatter={(v: number) => [`₹${v.toLocaleString(i18n.language || undefined)}`, t('charts.seriesRevenue')]} />
                <Line type="monotone" dataKey="revenue" stroke="#22c55e" strokeWidth={2} dot={{ fill: '#22c55e', r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="glass-card border-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-white flex items-center gap-2 text-base">
              <BarChart2 className="w-4 h-4 text-purple-400" />
              {t('charts.formatPopularity')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(cs?.formatPopularity ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noTournamentsYet')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={cs!.formatPopularity.map(f => ({ ...f, format: f.format.replace(/_/g, ' ') }))}
                  layout="vertical"
                  margin={{ top: 0, right: 0, left: 40, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#6b7280', fontSize: 11 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="format" tick={{ fill: '#9ca3af', fontSize: 10 }} width={80} />
                  <Tooltip contentStyle={{ background: '#111', border: 'none', color: '#fff' }} />
                  <Bar dataKey="count" name={t('charts.seriesTournaments')} fill="#8b5cf6" radius={[0, 3, 3, 0]}>
                    {cs!.formatPopularity.map((_, idx) => (
                      <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card border-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-white flex items-center gap-2 text-base">
              <Activity className="w-4 h-4 text-orange-400" />
              {t('charts.participationRetention')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between p-4 rounded-xl bg-white/5">
              <div>
                <p className="text-sm text-muted-foreground">{t('charts.playerRetentionRate')}</p>
                <p className="text-2xl font-bold text-white mt-1">
                  {cs?.retentionRate != null ? `${cs.retentionRate}%` : '—'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{t('stats.retentionDesc')}</p>
              </div>
              <TrendingUp className="w-8 h-8 text-orange-400 opacity-60" />
            </div>
            <div className="flex items-center justify-between p-4 rounded-xl bg-white/5">
              <div>
                <p className="text-sm text-muted-foreground">{t('stats.scoreRecords')}</p>
                <p className="text-2xl font-bold text-white mt-1">{cs?.totals.scores?.toLocaleString(i18n.language || undefined) ?? 0}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('stats.scoreRecordsDesc')}</p>
              </div>
              <Target className="w-8 h-8 text-primary opacity-60" />
            </div>
          </CardContent>
        </Card>

        {(cs?.eventParticipation ?? []).length > 0 && (
          <Card className="glass-card border-none lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-white text-base flex items-center gap-2">
                <Map className="w-4 h-4 text-orange-400" />
                {t('charts.eventParticipationLast8')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={cs!.eventParticipation.slice(-8)} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis type="number" tick={{ fill: '#6b7280', fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={100} tick={{ fill: '#6b7280', fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }} />
                  <Legend wrapperStyle={{ color: '#9ca3af', fontSize: 11 }} />
                  <Bar dataKey="players" fill="#3b82f6" radius={[0, 4, 4, 0]} name={t('charts.seriesPlayers')} />
                  <Bar dataKey="paidPlayers" fill="#22c55e" radius={[0, 4, 4, 0]} name={t('charts.seriesPaid')} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

interface OpenPrivacyRequest {
  id: number;
  clubMemberId: number;
  requestType: string;
  status: string;
  requestedAt: string;
  dueBy: string | null;
  handlerUserId: number | null;
  handlerDisplayName: string | null;
  handlerUsername: string | null;
  handlerEmail: string | null;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  // Push/SMS retry telemetry (Task #232) so admins can spot stuck or
  // exhausted notifications without drilling into Member 360.
  lastPushStatus?: string | null;
  lastSmsStatus?: string | null;
  lastWhatsappStatus?: string | null;
  pushAttempts?: number | null;
  smsAttempts?: number | null;
  whatsappAttempts?: number | null;
  pushRetryExhaustedAt?: string | null;
  smsRetryExhaustedAt?: string | null;
  whatsappRetryExhaustedAt?: string | null;
  // Task #284: true when this row is assigned to the viewer and the
  // handler-assigned in-app notice has not yet been acknowledged (i.e. the
  // handler hasn't opened the Member 360 Data tab for it since being
  // assigned).
  assignmentUnread?: boolean;
  // Task #777: most recently fired notification template kind. Used to
  // surface a dedicated "Export ready" badge and filter for the new
  // `completed_export` notice on the controller dashboard.
  lastNotificationKind?: string | null;
  lastNotifiedAt?: string | null;
}
interface OpenPrivacyResponse {
  counts: { open: number; overdue: number; dueSoon: number; exportReady?: number; exportExpiring?: number };
  requests: OpenPrivacyRequest[];
  // Task #284: total newly-assigned (un-acknowledged) requests for the
  // viewer — drives the unread badge on the "Assigned to me" toggle.
  unreadAssignedToMe?: number;
  maxPushAttempts?: number;
  maxSmsAttempts?: number;
  maxWhatsappAttempts?: number;
}

function daysUntil(dueBy: string | null): number | null {
  if (!dueBy) return null;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.ceil((new Date(dueBy).getTime() - Date.now()) / MS_PER_DAY);
}

function deadlineBadge(days: number | null): { label: string; cls: string } {
  if (days === null) return { label: 'No deadline', cls: 'bg-white/10 text-white/60 border-white/10' };
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, cls: 'bg-red-500/20 text-red-300 border-red-500/40' };
  if (days === 0) return { label: 'Due today', cls: 'bg-red-500/20 text-red-300 border-red-500/40' };
  if (days <= 7) return { label: `${days}d left`, cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
  if (days <= 14) return { label: `${days}d left`, cls: 'bg-yellow-500/15 text-yellow-200 border-yellow-500/30' };
  return { label: `${days}d left`, cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
}

type PrivacyFilter = 'all' | 'overdue' | 'due-soon' | 'export-ready' | 'export-expiring';

const PRIVACY_FILTER_KEY = 'dashboard.privacyRequests.filter';

// Task #1450 — at-a-glance count of erasures whose object-storage cleanup
// is still stuck. The daily digest already pages controllers when the
// backlog grows, but between digests there was no surface on the home
// screen showing the live state. This widget polls the lightweight
// /erasures/storage-failures/summary endpoint and self-hides when the
// backlog is empty so it adds zero noise during the (common) clean state.
// Click-through deep-links to the same `/privacy?panel=erasure-storage-failures`
// URL the digest emails use, so admins land on the exact panel they
// already know how to triage.
interface ErasureStorageFailuresSummary {
  count: number;
  totalFailedFiles: number;
  // Task #1779 — sub-count of members whose auto-retry chain has been
  // exhausted (cron has given up; they need controller intervention).
  // Mirrors the same field on the full /erasures/storage-failures
  // payload so the home badge stays in lockstep with the panel banner.
  autoRetryExhaustedCount: number;
  pendingStorageDeletions: { total: number; exhausted: number };
}

export function StuckErasureBacklogWidget({ orgId }: { orgId: number }) {
  const queryKey = ['/api/organizations', orgId, 'members-360', 'erasures', 'storage-failures', 'summary'] as const;
  const { data, isLoading } = useQuery<ErasureStorageFailuresSummary | null>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(
        API(`/organizations/${orgId}/members-360/erasures/storage-failures/summary`),
        { credentials: 'include' },
      );
      // Self-hide for non-admins instead of bubbling up an error toast.
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error('Failed to load stuck erasure summary');
      return res.json();
    },
    enabled: !!orgId,
    // Poll on the same cadence as the other "needs attention" widgets so
    // the badge clears within ~a minute of a successful retry, even if the
    // viewer never leaves the dashboard.
    refetchInterval: 60_000,
    // Refetch when the user navigates back from the governance panel so
    // the badge updates immediately after a manual cleanup, not after the
    // 60s tick.
    refetchOnWindowFocus: true,
    retry: false,
  });

  if (!isLoading && data === null) return null;
  // Don't render anything when the backlog is empty — same convention as
  // the receipt-failures and wallet-withdrawal widgets above. The badge
  // re-appears as soon as the next failure lands.
  if (!isLoading && data && data.count === 0 && data.pendingStorageDeletions.exhausted === 0) {
    return null;
  }

  const count = data?.count ?? 0;
  const totalFailed = data?.totalFailedFiles ?? 0;
  const exhaustedRows = data?.pendingStorageDeletions.exhausted ?? 0;
  // Task #1779 — members whose auto-retry chain is fully exhausted. We
  // surface this as a separate "needs your action" pill next to the
  // backlog count so a controller landing on the dashboard can tell at
  // a glance whether the cron is still working through the queue or has
  // given up and is waiting on them.
  const needsActionCount = data?.autoRetryExhaustedCount ?? 0;

  // Plain anchor instead of wouter <Link> — the digest deep link
  // `/privacy?panel=erasure-storage-failures` is the canonical
  // cross-surface URL (used in cron emails, in-app inbox, and now
  // the dashboard badge). Keeping all three on the same href means
  // there is exactly one place to update if the panel route ever
  // moves, and supportability questions ("the email link is
  // broken") apply to every surface symmetrically.
  const deepLinkHref = "/privacy?panel=erasure-storage-failures";

  return (
    <Card className="glass-card border-none" data-testid="card-stuck-erasure-backlog">
      <CardHeader className="pb-3">
        <CardTitle className="text-white text-base flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          Stuck erasure cleanups
          {!isLoading && (count > 0 || exhaustedRows > 0) && (
            // The badge itself is the primary click target — Task #1450
            // says "Clicking the badge opens /privacy?panel=…", so the
            // count pill and the explicit link below both navigate to
            // the same canonical URL.
            <a
              href={deepLinkHref}
              data-testid="badge-stuck-erasure-count"
              aria-label={`${count} stuck erasure${count === 1 ? '' : 's'} — open backlog`}
              className="ml-auto inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 hover:text-amber-100 transition-colors"
            >
              {count}
            </a>
          )}
          {!isLoading && needsActionCount > 0 && (
            // Task #1779 — destructive sub-pill so the home dashboard is
            // a true triage surface: a controller can tell at a glance
            // whether ANY of the backlog has had its auto-retry chain
            // exhausted (cron has given up; manual cleanup required) vs.
            // is still being worked through automatically. Same deep
            // link as the count pill — both land on the panel that
            // already renders the per-member "needs your action" badges
            // wired up in Task #1459.
            <a
              href={deepLinkHref}
              data-testid="badge-stuck-erasure-needs-action"
              aria-label={`${needsActionCount} member${needsActionCount === 1 ? '' : 's'} need your action — open backlog`}
              className="inline-flex items-center rounded-md border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-200 hover:bg-red-500/25 hover:text-red-100 transition-colors"
            >
              {needsActionCount} needs action
            </a>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="h-10 bg-white/5 animate-pulse rounded-lg" />
        ) : (
          <>
            <p className="text-xs text-muted-foreground" data-testid="text-stuck-erasure-summary">
              {count === 1
                ? '1 member with cleanup pending'
                : `${count} members with cleanup pending`}
              {totalFailed > 0 ? ` · ${totalFailed} orphan file${totalFailed === 1 ? '' : 's'}` : ''}
              {exhaustedRows > 0 ? ` · ${exhaustedRows} retry-exhausted` : ''}
            </p>
            <a
              href={deepLinkHref}
              data-testid="link-stuck-erasure-panel"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-200 hover:text-amber-100 underline-offset-2 hover:underline"
            >
              Open backlog
              <ArrowRight className="w-3.5 h-3.5" />
            </a>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function PrivacyRequestsWidget({ orgId, currentUserId }: { orgId: number; currentUserId: number | undefined }) {
  // Task #217: optional "Assigned to me" filter so admins can see only the
  // privacy requests they personally own. The toggle is disabled until we know
  // the viewer's user id (useGetMe still loading).
  const [mineOnly, setMineOnly] = useState(false);
  const qs = mineOnly ? '?assignedToMe=true' : '';
  const { data, isLoading } = useQuery<OpenPrivacyResponse>({
    queryKey: ['/api/organizations', orgId, 'data-requests', 'open', { mineOnly }],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/members-360/data-requests/open${qs}`), { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load privacy requests');
      return res.json();
    },
    enabled: !!orgId && (!mineOnly || !!currentUserId),
    refetchInterval: 60_000,
  });

  const [filter, setFilter] = useState<PrivacyFilter>(() => {
    if (typeof window === 'undefined') return 'all';
    const stored = window.localStorage.getItem(PRIVACY_FILTER_KEY);
    return stored === 'overdue' || stored === 'due-soon' || stored === 'export-ready' || stored === 'export-expiring'
      ? stored
      : 'all';
  });
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PRIVACY_FILTER_KEY, filter);
    }
  }, [filter]);

  const counts = data?.counts ?? { open: 0, overdue: 0, dueSoon: 0, exportReady: 0, exportExpiring: 0 };
  // Task #244: sort by deadline ascending (most overdue first, then due-soon,
  // then the rest), with requestedAt as a stable tiebreaker. Requests without
  // a deadline sort to the bottom. Done client-side so the order is guaranteed
  // regardless of API ordering and stays stable across filter/search.
  const allRequests = [...(data?.requests ?? [])].sort((a, b) => {
    const aDue = a.dueBy ? new Date(a.dueBy).getTime() : Number.POSITIVE_INFINITY;
    const bDue = b.dueBy ? new Date(b.dueBy).getTime() : Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    const aReq = new Date(a.requestedAt).getTime();
    const bReq = new Date(b.requestedAt).getTime();
    if (aReq !== bReq) return aReq - bReq;
    return a.id - b.id;
  });
  const maxPushAttempts = data?.maxPushAttempts;
  const maxSmsAttempts = data?.maxSmsAttempts;
  const maxWhatsappAttempts = data?.maxWhatsappAttempts;

  const searchTerm = search.trim().toLowerCase();
  // Prefer the API-supplied count (matches the dataset semantics on the
  // server, including completed export-ready rows that the open-only filter
  // would otherwise hide) and fall back to a client-side count for older API
  // versions.
  const exportReadyCount = counts.exportReady
    ?? allRequests.filter(r => r.lastNotificationKind === 'completed_export').length;
  // Task #922: separate KPI/filter for the "expires in 24h" reminder so
  // controllers can isolate at-risk archives without scanning the full list.
  const exportExpiringCount = counts.exportExpiring
    ?? allRequests.filter(r => r.lastNotificationKind === 'export_expiring').length;
  const requests = allRequests.filter((r) => {
    const days = daysUntil(r.dueBy);
    if (filter === 'overdue' && !(days !== null && days < 0)) return false;
    if (filter === 'due-soon' && !(days !== null && days >= 0 && days <= 7)) return false;
    if (filter === 'export-ready' && r.lastNotificationKind !== 'completed_export') return false;
    if (filter === 'export-expiring' && r.lastNotificationKind !== 'export_expiring') return false;
    if (searchTerm) {
      const memberName = [r.memberFirstName, r.memberLastName].filter(Boolean).join(' ').toLowerCase();
      if (!memberName.includes(searchTerm)) return false;
    }
    return true;
  });

  const filterTabs: { value: PrivacyFilter; label: string }[] = [
    { value: 'all', label: `All (${allRequests.length})` },
    { value: 'overdue', label: `Overdue (${counts.overdue})` },
    { value: 'due-soon', label: `Due ≤7d (${counts.dueSoon})` },
    // Task #777: surface the new "Your data export is ready" notice so
    // controllers can isolate export downloads without drilling into
    // Member 360.
    { value: 'export-ready', label: `Export ready (${exportReadyCount})` },
    // Task #922: surface the "expires in 24h" follow-up reminder so admins
    // can see at-a-glance which archives are at risk of going unread.
    { value: 'export-expiring', label: `Export expiring (${exportExpiringCount})` },
  ];

  return (
    <Card className="glass-card border-none" data-testid="privacy-requests-widget">
      <CardHeader className="pb-3">
        <CardTitle className="text-white text-base flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-purple-400" />
            Privacy requests
          </span>
          <button
            type="button"
            onClick={() => setMineOnly(v => !v)}
            disabled={!currentUserId}
            data-testid="privacy-filter-mine"
            aria-pressed={mineOnly}
            className={`relative text-[11px] font-medium uppercase tracking-wide rounded-full border px-2.5 py-1 transition-colors inline-flex items-center gap-1.5 ${
              mineOnly
                ? 'border-purple-400/60 bg-purple-500/20 text-purple-200'
                : 'border-white/10 text-white/60 hover:bg-white/5'
            } ${!currentUserId ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <span>{mineOnly ? 'Assigned to me' : 'All'}</span>
            {(data?.unreadAssignedToMe ?? 0) > 0 ? (
              <span
                data-testid="privacy-unread-badge"
                aria-label={`${data?.unreadAssignedToMe} unread assignment${(data?.unreadAssignedToMe ?? 0) === 1 ? '' : 's'}`}
                className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none"
              >
                {(data?.unreadAssignedToMe ?? 0) > 99 ? '99+' : data?.unreadAssignedToMe}
              </span>
            ) : null}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-3" data-testid="kpi-overdue">
            <div className="flex items-center gap-1.5 text-xs text-red-300/80">
              <AlertTriangle className="w-3.5 h-3.5" /> Overdue
            </div>
            <div className="text-2xl font-display font-bold text-red-300 mt-1">{counts.overdue}</div>
          </div>
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3" data-testid="kpi-due-soon">
            <div className="flex items-center gap-1.5 text-xs text-amber-300/80">
              <Clock className="w-3.5 h-3.5" /> Due in 7d
            </div>
            <div className="text-2xl font-display font-bold text-amber-300 mt-1">{counts.dueSoon}</div>
          </div>
          <div className="rounded-lg bg-white/5 border border-white/10 p-3" data-testid="kpi-open">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Shield className="w-3.5 h-3.5" /> Open
            </div>
            <div className="text-2xl font-display font-bold text-white mt-1">{counts.open}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5" data-testid="privacy-filters">
          {filterTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setFilter(tab.value)}
              data-testid={`privacy-filter-${tab.value}`}
              data-active={filter === tab.value}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                filter === tab.value
                  ? 'bg-purple-500/20 border-purple-500/40 text-purple-200'
                  : 'bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by member name…"
            aria-label="Search privacy requests by member name"
            className="h-8 pl-8 text-sm bg-white/5 border-white/10"
            data-testid="privacy-search"
          />
        </div>

        <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-4 text-center">Loading…</div>
          ) : requests.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center" data-testid="privacy-empty">
              {allRequests.length === 0 ? 'No open privacy requests.' : 'No requests match your filters.'}
            </div>
          ) : (
            requests.map((r) => {
              const days = daysUntil(r.dueBy);
              const badge = deadlineBadge(days);
              const memberName = [r.memberFirstName, r.memberLastName].filter(Boolean).join(' ') || `Member #${r.clubMemberId}`;
              const pushAttempts = r.pushAttempts ?? 0;
              const smsAttempts = r.smsAttempts ?? 0;
              const whatsappAttempts = r.whatsappAttempts ?? 0;
              const pushExhausted = !!r.pushRetryExhaustedAt;
              const smsExhausted = !!r.smsRetryExhaustedAt;
              const whatsappExhausted = !!r.whatsappRetryExhaustedAt;
              const showPush = pushAttempts > 0 || pushExhausted;
              const showSms = smsAttempts > 0 || smsExhausted;
              const showWhatsapp = whatsappAttempts > 0 || whatsappExhausted;
              const anyExhausted = pushExhausted || smsExhausted || whatsappExhausted;
              const rowBorderCls = anyExhausted
                ? 'border-red-500/40 bg-red-500/5 hover:bg-red-500/10'
                : 'border-transparent hover:border-white/10';
              return (
                <Link key={r.id} href={`/member-360/${r.clubMemberId}?tab=data`}>
                  <div
                    className={`flex items-center justify-between gap-2 p-2.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer border ${rowBorderCls}`}
                    data-testid={`privacy-row-${r.id}`}
                    data-retry-exhausted={anyExhausted ? 'true' : 'false'}
                    data-last-notification-kind={r.lastNotificationKind ?? ''}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-white truncate">{memberName}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <Badge variant="outline" className="border-white/10 text-[10px] py-0 px-1.5 capitalize">
                          {r.requestType.replace(/_/g, ' ')}
                        </Badge>
                        {r.lastNotificationKind === 'completed_export' && (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200 text-[10px] py-0 px-1.5"
                            data-testid={`privacy-export-ready-${r.id}`}
                            title={`"Your data export is ready" notice sent${r.lastNotifiedAt ? ` ${new Date(r.lastNotifiedAt).toLocaleString()}` : ''}`}
                          >
                            Export ready
                          </Badge>
                        )}
                        {r.lastNotificationKind === 'export_expiring' && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/40 bg-amber-500/10 text-amber-200 text-[10px] py-0 px-1.5"
                            data-testid={`privacy-export-expiring-${r.id}`}
                            title={`"Your data export expires soon" reminder sent${r.lastNotifiedAt ? ` ${new Date(r.lastNotifiedAt).toLocaleString()}` : ''}`}
                          >
                            Export expiring
                          </Badge>
                        )}
                        <span>· {new Date(r.requestedAt).toLocaleDateString(i18n.language || undefined, { month: 'short', day: 'numeric' })}</span>
                        <span className="text-white/40">·</span>
                        {r.handlerUserId ? (
                          <span
                            className={`text-[10px] ${r.handlerUserId === currentUserId ? 'text-purple-300' : 'text-white/60'}`}
                            data-testid={`privacy-assignee-${r.id}`}
                          >
                            {r.handlerUserId === currentUserId
                              ? 'Assigned to you'
                              : `Assigned to ${r.handlerDisplayName ?? r.handlerUsername ?? r.handlerEmail ?? `user #${r.handlerUserId}`}`}
                          </span>
                        ) : (
                          <span className="text-[10px] text-amber-300/80" data-testid={`privacy-unassigned-${r.id}`}>Unassigned</span>
                        )}
                        {(showPush || showSms || showWhatsapp) && (
                          <span className="text-white/40">·</span>
                        )}
                        {showPush && (
                          <span
                            className={`text-[10px] inline-flex items-center gap-0.5 rounded px-1.5 py-0 border ${
                              pushExhausted
                                ? 'bg-red-500/20 text-red-300 border-red-500/40'
                                : r.lastPushStatus === 'failed'
                                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                  : 'bg-white/5 text-white/60 border-white/10'
                            }`}
                            data-testid={`privacy-push-${r.id}`}
                            data-exhausted={pushExhausted ? 'true' : 'false'}
                            title={pushExhausted
                              ? `Push retries exhausted${r.pushRetryExhaustedAt ? ` ${new Date(r.pushRetryExhaustedAt).toLocaleString()}` : ''}`
                              : `Push ${r.lastPushStatus ?? 'unknown'} · ${pushAttempts}${maxPushAttempts ? `/${maxPushAttempts}` : ''} attempts`}
                          >
                            push {pushAttempts}{maxPushAttempts ? `/${maxPushAttempts}` : ''}
                            {pushExhausted && <span className="ml-0.5 font-semibold">· exhausted</span>}
                          </span>
                        )}
                        {showSms && (
                          <span
                            className={`text-[10px] inline-flex items-center gap-0.5 rounded px-1.5 py-0 border ${
                              smsExhausted
                                ? 'bg-red-500/20 text-red-300 border-red-500/40'
                                : r.lastSmsStatus === 'failed'
                                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                  : 'bg-white/5 text-white/60 border-white/10'
                            }`}
                            data-testid={`privacy-sms-${r.id}`}
                            data-exhausted={smsExhausted ? 'true' : 'false'}
                            title={smsExhausted
                              ? `SMS retries exhausted${r.smsRetryExhaustedAt ? ` ${new Date(r.smsRetryExhaustedAt).toLocaleString()}` : ''}`
                              : `SMS ${r.lastSmsStatus ?? 'unknown'} · ${smsAttempts}${maxSmsAttempts ? `/${maxSmsAttempts}` : ''} attempts`}
                          >
                            sms {smsAttempts}{maxSmsAttempts ? `/${maxSmsAttempts}` : ''}
                            {smsExhausted && <span className="ml-0.5 font-semibold">· exhausted</span>}
                          </span>
                        )}
                        {showWhatsapp && (
                          <span
                            className={`text-[10px] inline-flex items-center gap-0.5 rounded px-1.5 py-0 border ${
                              whatsappExhausted
                                ? 'bg-red-500/20 text-red-300 border-red-500/40'
                                : r.lastWhatsappStatus === 'failed'
                                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                  : r.lastWhatsappStatus === 'read'
                                    ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/40'
                                    : r.lastWhatsappStatus === 'delivered'
                                      ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40'
                                      : 'bg-white/5 text-white/60 border-white/10'
                            }`}
                            data-testid={`privacy-whatsapp-${r.id}`}
                            data-exhausted={whatsappExhausted ? 'true' : 'false'}
                            data-whatsapp-status={r.lastWhatsappStatus ?? 'unknown'}
                            title={whatsappExhausted
                              ? `WhatsApp retries exhausted${r.whatsappRetryExhaustedAt ? ` ${new Date(r.whatsappRetryExhaustedAt).toLocaleString()}` : ''}`
                              : r.lastWhatsappStatus === 'delivered'
                                ? `WhatsApp delivered — carrier confirmed receipt · ${whatsappAttempts}${maxWhatsappAttempts ? `/${maxWhatsappAttempts}` : ''} attempts`
                                : r.lastWhatsappStatus === 'read'
                                  ? `WhatsApp read — recipient opened the message · ${whatsappAttempts}${maxWhatsappAttempts ? `/${maxWhatsappAttempts}` : ''} attempts`
                                  : `WhatsApp ${r.lastWhatsappStatus ?? 'unknown'} · ${whatsappAttempts}${maxWhatsappAttempts ? `/${maxWhatsappAttempts}` : ''} attempts`}
                          >
                            whatsapp {whatsappAttempts}{maxWhatsappAttempts ? `/${maxWhatsappAttempts}` : ''}
                            {r.lastWhatsappStatus === 'read' && (
                              <Eye className="w-3 h-3 ml-0.5" aria-label="Read by recipient" />
                            )}
                            {r.lastWhatsappStatus === 'delivered' && (
                              <CheckCheck className="w-3 h-3 ml-0.5" aria-label="Delivered to recipient" />
                            )}
                            {whatsappExhausted && <span className="ml-0.5 font-semibold">· exhausted</span>}
                          </span>
                        )}
                      </div>
                    </div>
                    <Badge variant="outline" className={`text-[10px] whitespace-nowrap ${badge.cls}`}>
                      {badge.label}
                    </Badge>
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface BouncedLevyEntry {
  levyId: number;
  name: string;
  currency: string;
  unresolvedFailedCount: number;
  channels: Record<string, number>;
  latestFailureAt: string | null;
  sampleError: string | null;
}

/**
 * Dashboard banner (Task #213) — surfaces levies with bounced reminders so
 * admins are notified passively instead of having to open each levy detail
 * dialog. Each row deep-links to /club-members?openLevy=<id>, which auto-opens
 * the levy where they can use the existing "Retry failed" action.
 */
function BouncedLevyRemindersBanner({ orgId }: { orgId: number }) {
  const { data } = useQuery<{ levies: BouncedLevyEntry[]; totalBounced: number }>({
    queryKey: ['/api/organizations', orgId, 'members-360/levies/bounced-reminders'],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/members-360/levies/bounced-reminders`), { credentials: 'include' });
      if (!res.ok) return { levies: [], totalBounced: 0 };
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });

  const levies = data?.levies ?? [];
  if (levies.length === 0) return null;

  const totalBounced = data?.totalBounced ?? 0;
  const visible = levies.slice(0, 3);
  const extra = levies.length - visible.length;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      data-testid="banner-bounced-levy-reminders"
    >
      <Card className="border border-amber-500/30 bg-amber-500/5">
        <CardContent className="p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h3 className="text-sm font-semibold text-amber-100">
                  Levy reminders bounced
                </h3>
                <span className="text-xs text-amber-200/70">
                  {totalBounced} unresolved across {levies.length} {levies.length === 1 ? 'levy' : 'levies'}
                </span>
              </div>
              <p className="text-xs text-amber-200/70 mt-0.5">
                These reminders failed to deliver and need attention. Open a levy to retry the failed sends.
              </p>
              <ul className="mt-3 space-y-1.5">
                {visible.map((l) => {
                  const channelSummary = Object.entries(l.channels)
                    .map(([ch, n]) => `${n} ${ch.replace('_', ' ')}`).join(', ');
                  return (
                    <li key={l.levyId}>
                      <Link
                        href={`/club-members?openLevy=${l.levyId}`}
                        data-testid={`link-bounced-levy-${l.levyId}`}
                      >
                        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-black/30 hover:bg-black/40 border border-white/5 transition-colors cursor-pointer">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-white truncate">{l.name}</p>
                            <p className="text-[11px] text-amber-200/70 truncate">
                              {l.unresolvedFailedCount} failed{channelSummary ? ` · ${channelSummary}` : ''}
                              {l.sampleError ? ` · ${l.sampleError}` : ''}
                            </p>
                          </div>
                          <ArrowRight className="w-4 h-4 text-amber-300/70 flex-shrink-0" />
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {extra > 0 && (
                <div className="mt-2">
                  <Link href="/club-members">
                    <span className="text-xs text-amber-300/80 hover:text-amber-200 underline underline-offset-2 cursor-pointer">
                      + {extra} more {extra === 1 ? 'levy' : 'levies'} with failures — view all
                    </span>
                  </Link>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

interface LeviesSummaryResponse {
  levies: unknown[];
  totalsByCurrency: Record<string, {
    collected: number; outstanding: number; refunded: number; waived: number;
    chargesCount: number; leviesCount: number;
  }>;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(i18n.language || undefined, {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString(i18n.language || undefined)}`;
  }
}

// ─── Stalled export-expiring reminder drill-down (Task #1297) ──────────
//
// Sibling to the Task #1124 open-rate widget. The aggregate widget tells
// admins *how many* members opened the courtesy reminder; this list
// tells them *who* opened it and then never came back to download — the
// cohort most at risk of having to re-request their data once the daily
// purger runs.
//
// "Send personal nudge" reuses the existing per-request resend handler
// so we get the full multi-channel pipeline (in-app + email + opted-in
// push/SMS/WhatsApp) without a new endpoint, and the resend is recorded
// in the audit log just like a manual Member 360 resend.
// ─── Controller "expiring reminder open-rate" widget (Task #1531) ──────
// Aggregate-stats sibling of <StalledExpiringReminderWidget />: surfaces
// the open / click / prefetch counts the API computes from the export-
// expiring reminder tracking pixel, so admins see at a glance how the
// new reminder is performing. The headline open rate excludes opens
// that the pixel handler classified as automated prefetches (Apple Mail
// Privacy Protection, GoogleImageProxy, etc.) — without surfacing the
// `prefetched` count, admins have no way to tell *how many* opens the
// heuristic suppressed. The "Include prefetches" checkbox flips
// `?includePrefetches=1` so the inflated number is one click away when
// debugging the heuristic.
interface ExpiringReminderStatsDailyBucket {
  date: string;
  sent: number;
  opened: number;
  prefetched: number;
  clicked: number;
}
interface ExpiringReminderStatsResponse {
  windowDays: number;
  since: string;
  sent: number;
  opened: number;
  prefetched: number;
  clicked: number;
  openRate: number | null;
  clickRate: number | null;
  includePrefetches: boolean;
  // Task #1890 — per-day buckets for the inline sparkline. `opened`
  // here is always the *real* (non-prefetched) opens regardless of the
  // headline `includePrefetches` toggle so the chart can stack the
  // prefetched portion as a visually-distinct dashed area.
  daily?: ExpiringReminderStatsDailyBucket[];
}

function formatPct(rate: number | null): string {
  if (rate == null) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

// Task #1889 — admin-selectable comparison window for the open-rate widget.
// The API already accepts `?days=` (1–365); these are the three buckets
// the dashboard exposes so admins can flip between "this week", the
// rolling-30 default, and the prior-month-style 90d view without having
// to query the endpoint by hand.
type ExpiringReminderWindowKey = '7d' | '30d' | '90d';
const EXPIRING_REMINDER_WINDOW_OPTIONS: { value: ExpiringReminderWindowKey; days: number; label: string }[] = [
  { value: '7d', days: 7, label: '7d' },
  { value: '30d', days: 30, label: '30d' },
  { value: '90d', days: 90, label: '90d' },
];
// sessionStorage so the choice survives navigation / refreshes within
// the same dashboard session but does not silently outlive the tab.
// Mirrors the path-shaped naming used by the React-Query cache keys
// elsewhere in this file so it's obvious which widget owns the entry.
const EXPIRING_REMINDER_WINDOW_STORAGE_KEY =
  'kharagolf:expiring-reminder-stats:windowDays';
const isExpiringReminderWindowKey = (v: unknown): v is ExpiringReminderWindowKey =>
  v === '7d' || v === '30d' || v === '90d';

// Task #1890 — compact inline sparkline rendered above the stat tiles.
// Plots the per-day *open rate* (opened/sent) as a solid amber area
// and stacks the per-day *prefetch rate* (prefetched/sent) on top as
// a hatched dashed-outline area, so admins can see at a glance both
// how the underlying open-rate is trending and how much of the visible
// activity is privacy-proxy prefetches that the headline number is
// hiding. Plotting rates (not raw counts) is critical: a day with 100
// sent / 5 opens (5%) and a day with 10 sent / 5 opens (50%) must read
// as very different points on the chart, not the same height.
//
// Each day exposes a native <title> tooltip with the exact counts and
// the day's open rate so hover gives precise numbers without dragging
// in a charting library for one widget. Days with `sent === 0` plot at
// the baseline (rate = 0) — there's no rate to compute, but suppressing
// the bucket entirely would break the time-axis continuity that's the
// whole point of the chart.
function ExpiringReminderTrendSparkline({ daily }: { daily: ExpiringReminderStatsDailyBucket[] }) {
  if (daily.length === 0) return null;
  const w = 280;
  const h = 56;
  const padX = 2;
  const padY = 4;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;

  // Per-day rates. A bucket with `sent === 0` has no defined rate, so
  // both series read 0 for that day (flat baseline). The stack invariant
  // is `openRate + prefetchRate <= 1` since they're disjoint subsets of
  // the same `sent` denominator (the pixel handler routes a tracked
  // hit into exactly one of opened/prefetched).
  const rates = daily.map(d => {
    const openRate = d.sent > 0 ? d.opened / d.sent : 0;
    const prefetchRate = d.sent > 0 ? d.prefetched / d.sent : 0;
    return { openRate, prefetchRate };
  });

  // Y-axis spans 0..ceiling, where ceiling tracks the busiest day's
  // total rate so the chart fills the available height even when the
  // open rate stays well below 100% (which is the realistic case —
  // export-reminder open rates typically run 10–40%). Falling back to a
  // small floor prevents a zero-division and keeps an all-empty window
  // rendering as a visible flat baseline rather than collapsing.
  const maxRate = Math.max(0.05, ...rates.map(r => r.openRate + r.prefetchRate));
  const stepX = daily.length > 1 ? innerW / (daily.length - 1) : 0;
  const yFor = (rate: number) => padY + innerH - (rate / maxRate) * innerH;
  const xFor = (i: number) => padX + i * stepX;

  // Build polylines for the two stacked series. The "open rate" line
  // hugs the bottom; the "open rate + prefetch rate" line sits on top,
  // and the dashed area between them is the prefetch contribution.
  const openedPts = rates.map((r, i) => `${xFor(i)},${yFor(r.openRate)}`).join(' ');
  const totalPts = rates.map((r, i) => `${xFor(i)},${yFor(r.openRate + r.prefetchRate)}`).join(' ');
  // Closed polygon for the open-rate area (down to the baseline).
  const baselineY = padY + innerH;
  const openedArea = [
    `${xFor(0)},${baselineY}`,
    openedPts,
    `${xFor(daily.length - 1)},${baselineY}`,
  ].join(' ');
  // Closed polygon for the prefetch-rate area (between openRate and
  // openRate+prefetchRate).
  const prefetchAreaPts = [
    ...rates.map((r, i) => `${xFor(i)},${yFor(r.openRate)}`),
    ...rates.slice().reverse().map((r, i) => {
      const idx = rates.length - 1 - i;
      return `${xFor(idx)},${yFor(r.openRate + r.prefetchRate)}`;
    }),
  ].join(' ');

  return (
    <div
      className="border border-white/10 rounded-md bg-black/30 px-3 py-2"
      data-testid="expiring-reminder-trend-sparkline"
    >
      <div className="flex items-center justify-between text-[10px] text-muted-foreground leading-tight mb-1">
        <span className="uppercase tracking-wider">Daily trend ({daily.length}d)</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm bg-amber-400" />
            opens
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block w-2 h-2 rounded-sm border border-amber-300/80"
              style={{ background: 'repeating-linear-gradient(45deg, rgba(251,191,36,0.25) 0 2px, transparent 2px 4px)' }}
            />
            prefetches
          </span>
        </span>
      </div>
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Daily export reminder open rate trend"
      >
        <defs>
          <pattern
            id="expiring-reminder-prefetch-hatch"
            patternUnits="userSpaceOnUse"
            width="4"
            height="4"
            patternTransform="rotate(45)"
          >
            <rect width="4" height="4" fill="rgba(251,191,36,0.10)" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(251,191,36,0.55)" strokeWidth="1" />
          </pattern>
        </defs>
        {/* Real-opens area (solid amber). */}
        <polygon
          points={openedArea}
          fill="rgba(251,191,36,0.35)"
          stroke="rgb(251,191,36)"
          strokeWidth="1"
          data-testid="expiring-reminder-trend-opens-area"
        />
        {/* Prefetched area, stacked on top, hatched + dashed outline. */}
        <polygon
          points={prefetchAreaPts}
          fill="url(#expiring-reminder-prefetch-hatch)"
          stroke="rgb(251,191,36)"
          strokeWidth="1"
          strokeDasharray="3 2"
          opacity="0.85"
          data-testid="expiring-reminder-trend-prefetches-area"
        />
        {/* Outline of the total (opens+prefetches) for emphasis. */}
        <polyline
          points={totalPts}
          fill="none"
          stroke="rgb(251,191,36)"
          strokeWidth="1"
          strokeDasharray="3 2"
          opacity="0.9"
        />
        {/* Per-day hover hit-targets carrying the exact counts in a
            native <title> tooltip. Sized to fill the column so admins
            don't have to land on the polyline pixel-precisely. */}
        {daily.map((d, i) => {
          const colW = daily.length > 1 ? innerW / daily.length : innerW;
          const x = padX + i * (daily.length > 1 ? stepX : 0) - colW / 2;
          const rate = d.sent > 0 ? `${((d.opened / d.sent) * 100).toFixed(1)}%` : '—';
          return (
            <rect
              key={d.date}
              x={Math.max(0, x)}
              y={padY}
              width={Math.max(1, colW)}
              height={innerH}
              fill="transparent"
              data-testid={`expiring-reminder-trend-day-${d.date}`}
            >
              <title>
                {`${d.date} · ${d.sent} sent · ${d.opened} opened · ${d.prefetched} prefetched · ${d.clicked} clicked · open rate ${rate}`}
              </title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

export function ExpiringReminderStatsWidget({ orgId }: { orgId: number }) {
  const [includePrefetches, setIncludePrefetches] = useState(false);
  const [windowKey, setWindowKey] = useState<ExpiringReminderWindowKey>(() => {
    if (typeof window === 'undefined') return '30d';
    try {
      const stored = window.sessionStorage.getItem(EXPIRING_REMINDER_WINDOW_STORAGE_KEY);
      if (isExpiringReminderWindowKey(stored)) return stored;
    } catch {
      // sessionStorage can throw in private-mode / sandboxed iframes —
      // silently fall through to the default.
    }
    return '30d';
  });
  const windowDays =
    EXPIRING_REMINDER_WINDOW_OPTIONS.find((opt) => opt.value === windowKey)?.days ?? 30;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(EXPIRING_REMINDER_WINDOW_STORAGE_KEY, windowKey);
    } catch {
      // ignore quota / privacy-mode failures
    }
  }, [windowKey]);

  // Cache key includes both the toggle and the selected window so
  // flipping either triggers a refetch and the variants cache separately.
  const queryKey = [
    '/api/organizations', orgId,
    'members-360', 'data-requests', 'expiring-reminder-stats',
    { includePrefetches, windowDays },
  ] as const;

  const { data, isLoading } = useQuery<ExpiringReminderStatsResponse | null>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (includePrefetches) params.set('includePrefetches', '1');
      // Always pin `?days=` so the URL reflects the active window even
      // when it matches the API default — keeps the network tab honest
      // and makes the cache key behaviour easier to reason about.
      params.set('days', String(windowDays));
      const qs = `?${params.toString()}`;
      const res = await fetch(
        API(`/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats${qs}`),
        { credentials: 'include' },
      );
      // Self-hide for non-admin viewers, mirroring StalledExpiringReminderWidget.
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error('Failed to load expiring reminder stats');
      return res.json();
    },
    enabled: !!orgId,
    retry: false,
  });

  if (!isLoading && data === null) return null;

  const sent = data?.sent ?? 0;
  const opened = data?.opened ?? 0;
  const prefetched = data?.prefetched ?? 0;
  const clicked = data?.clicked ?? 0;
  const openRate = data?.openRate ?? null;
  const clickRate = data?.clickRate ?? null;

  return (
    <Card className="glass-card border-none" data-testid="expiring-reminder-stats-widget">
      <CardHeader className="pb-3">
        <CardTitle className="text-white text-base flex items-center gap-2">
          <Mail className="w-4 h-4 text-amber-400" />
          Export reminder open rate
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Open and click telemetry from the export-expiring courtesy
          reminder. Opens that look like automated prefetches from
          privacy-protecting mail clients are hidden by default.
        </p>

        {/* Task #1889 — window selector. Mirrors the pill-button visual
            language of the stalled-reminders filter row below for
            visual consistency on the same dashboard column. */}
        <div
          className="flex flex-wrap items-center gap-1.5"
          data-testid="expiring-reminder-window-selector"
          role="tablist"
          aria-label="Open-rate time window"
        >
          {EXPIRING_REMINDER_WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={windowKey === opt.value}
              onClick={() => setWindowKey(opt.value)}
              data-testid={`expiring-reminder-window-${opt.value}`}
              data-active={windowKey === opt.value}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                windowKey === opt.value
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
                  : 'bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="text-sm text-muted-foreground py-4 text-center">Loading…</div>
        ) : (
          <>
            {data?.daily && data.daily.length > 0 ? (
              <ExpiringReminderTrendSparkline daily={data.daily} />
            ) : null}

            <div className="flex items-baseline gap-2 flex-wrap">
              <span
                className="text-3xl font-semibold text-white tabular-nums"
                data-testid="expiring-reminder-open-rate"
              >
                {formatPct(openRate)}
              </span>
              <span className="text-xs text-muted-foreground">open rate</span>
              {prefetched > 0 && !includePrefetches ? (
                <span
                  className="text-xs text-amber-200/90"
                  data-testid="expiring-reminder-prefetches-hidden"
                >
                  ({prefetched} prefetch{prefetched === 1 ? '' : 'es'} hidden)
                </span>
              ) : null}
              {prefetched > 0 && includePrefetches ? (
                <span
                  className="text-xs text-amber-200/90"
                  data-testid="expiring-reminder-prefetches-included"
                >
                  (incl. {prefetched} prefetch{prefetched === 1 ? '' : 'es'})
                </span>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div
                className="rounded-lg border border-white/10 bg-white/5 p-2"
                data-testid="expiring-reminder-stat-sent"
              >
                <div className="text-muted-foreground">Sent</div>
                <div className="text-white text-base tabular-nums">{sent}</div>
              </div>
              <div
                className="rounded-lg border border-white/10 bg-white/5 p-2"
                data-testid="expiring-reminder-stat-opened"
              >
                <div className="text-muted-foreground">Opened</div>
                <div className="text-white text-base tabular-nums">{opened}</div>
              </div>
              <div
                className="rounded-lg border border-white/10 bg-white/5 p-2"
                data-testid="expiring-reminder-stat-clicked"
              >
                <div className="text-muted-foreground">
                  Clicked ({formatPct(clickRate)})
                </div>
                <div className="text-white text-base tabular-nums">{clicked}</div>
              </div>
              <div
                className="rounded-lg border border-white/10 bg-white/5 p-2"
                data-testid="expiring-reminder-stat-prefetched"
              >
                <div className="text-muted-foreground">Prefetches filtered</div>
                <div className="text-white text-base tabular-nums">{prefetched}</div>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <Checkbox
                checked={includePrefetches}
                onCheckedChange={(v) => setIncludePrefetches(v === true)}
                data-testid="expiring-reminder-include-prefetches"
              />
              <span>Include prefetches in open rate (debug)</span>
            </label>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Task #1891 — per-channel delivery status persisted by the resend handler
// in `memberAuditLogTable.metadata.channels`. Same shape as the resend-history
// popover already renders on Member 360. `at` and `error` are absent for
// legacy audit rows (the parser then returns status only).
interface StalledNudgeChannelDetail {
  status: string;
  at: string | null;
  error: string | null;
}
interface StalledNudgeChannels {
  email: StalledNudgeChannelDetail | null;
  inApp: StalledNudgeChannelDetail | null;
  push: StalledNudgeChannelDetail | null;
  sms: StalledNudgeChannelDetail | null;
}

interface StalledReminderItem {
  id: number;
  clubMemberId: number;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberEmail: string | null;
  resolvedAt: string | null;
  expiringNoticeSentAt: string | null;
  expiringReminderEmailOpenedAt: string | null;
  expiringReminderEmailClickedAt: string | null;
  lastNotificationKind: string | null;
  lastNotifiedAt: string | null;
  purgesAt: string | null;
  // Task #1528 — most recent admin-triggered resend on this request, joined
  // from memberAuditLogTable. Lets the widget show "Nudged Xm ago by Asha"
  // and warn before a second admin double-fires within the same window.
  lastNudgedAt: string | null;
  lastNudgedByDisplayName: string | null;
  // Task #1891 — per-channel statuses from the latest resend so the widget
  // can show "✓ email · ✓ in-app · ✗ push" inline. Null when there's no
  // nudge yet, or when the audit row carried no parseable channel detail.
  lastNudgedChannels: StalledNudgeChannels | null;
}
interface StalledRemindersResponse {
  filter: 'all' | 'opened-only' | 'clicked';
  validDays: number;
  counts: { total: number; openedOnly: number; clicked: number };
  items: StalledReminderItem[];
}

type StalledFilter = 'all' | 'opened-only' | 'clicked';

function timeUntil(target: string | null): string {
  if (!target) return '—';
  const ms = new Date(target).getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';
  if (ms <= 0) return 'purged';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h left`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH === 0 ? `${days}d left` : `${days}d ${remH}h left`;
}

// Task #1528 — short relative-past label for the "Nudged 12m ago by Asha"
// line. Kept inline (vs pulling in date-fns just for this widget) to match
// the lightweight style of `timeUntil` above. Resolution is intentionally
// coarse (just now / Nm / Nh / Nd) — admins only need to know whether
// the row was already touched recently before they double-fire a nudge.
function timeSince(target: string | null): string {
  if (!target) return '—';
  const ms = Date.now() - new Date(target).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / (60 * 1000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Window inside which a second nudge from another admin is treated as a
// likely double-send: the button is disabled and the row carries an
// inline "already nudged" indicator. Sized to be longer than the typical
// admin's between-actions latency but short enough that a deliberate
// follow-up an hour later still works without ceremony.
const STALLED_NUDGE_RECENT_WINDOW_MS = 60 * 60 * 1000;

// Task #1891 — display labels for the per-channel ✓/✗ row under each
// stalled-export entry. Order mirrors the resend-history popover on
// Member 360 (email → in-app → push → SMS) so admins see the same
// progression in both surfaces.
const STALLED_NUDGE_CHANNEL_LABELS: ReadonlyArray<{
  key: keyof StalledNudgeChannels; label: string;
}> = [
  { key: 'email', label: 'email' },
  { key: 'inApp', label: 'in-app' },
  { key: 'push', label: 'push' },
  { key: 'sms', label: 'sms' },
];

// Statuses we treat as "the message actually went out". Anything else
// (failed / skipped / opted_out / no_address / etc.) flags as ✗ so the
// admin sees at a glance which channel needs another look. `read` and
// `delivered` are carrier-confirmation states (Task #506) and count as
// success — the member definitely received the notice.
const STALLED_NUDGE_SUCCESS_STATUSES = new Set([
  'sent', 'delivered', 'read', 'queued',
]);

function stalledNudgeChannelTooltip(label: string, detail: StalledNudgeChannelDetail): string {
  const lines = [`${label}: ${detail.status}`];
  if (detail.at) lines.push(`at ${new Date(detail.at).toLocaleString()}`);
  if (detail.error) lines.push(`error: ${detail.error}`);
  return lines.join('\n');
}

export function StalledExpiringReminderWidget({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StalledFilter>('all');
  // Mirror the endpoint path (members-360/data-requests/expiring-reminder-stalled)
  // so the React-Query cache key collides only with this exact resource.
  const queryKey = ['/api/organizations', orgId, 'members-360', 'data-requests', 'expiring-reminder-stalled', { filter }] as const;
  // Prefix used to invalidate every filter variant after a nudge so the
  // counts on the unfocused tabs stay in sync with the freshly-resent row.
  const queryKeyPrefix = ['/api/organizations', orgId, 'members-360', 'data-requests', 'expiring-reminder-stalled'] as const;

  const { data, isLoading } = useQuery<StalledRemindersResponse | null>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(
        API(`/organizations/${orgId}/members-360/data-requests/expiring-reminder-stalled?filter=${filter}`),
        { credentials: 'include' },
      );
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error('Failed to load stalled reminders');
      return res.json();
    },
    enabled: !!orgId,
    refetchInterval: 60_000,
    retry: false,
  });

  // Task #1881 — the success/failure toast carries `recipientLabel` so an
  // admin firing nudges across several stalled rows can tell at a glance
  // *who* the confirmation refers to (and which row failed when one
  // does), instead of having to cross-reference the disabled state in
  // the list.
  const nudgeMutation = useMutation<unknown, Error, { memberId: number; requestId: number; recipientLabel: string }>({
    mutationFn: async ({ memberId, requestId }) => {
      const res = await fetch(
        API(`/organizations/${orgId}/members-360/${memberId}/data-requests/${requestId}/resend`),
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Resend failed');
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      toast({
        title: 'Personal nudge sent',
        description: `The export-expiring reminder was re-delivered to ${variables.recipientLabel}.`,
      });
      // Invalidate every filter variant so unfocused tabs (All / Opened
      // only / Clicked) reflect the freshly-resent row's new state on
      // the next mount instead of waiting for the 60s refetchInterval.
      void queryClient.invalidateQueries({ queryKey: queryKeyPrefix });
    },
    onError: (err, variables) => {
      toast({
        title: 'Could not send nudge',
        description: `${variables.recipientLabel}: ${err.message}`,
        variant: 'destructive',
      });
    },
  });

  if (!isLoading && data === null) return null;

  const counts = data?.counts ?? { total: 0, openedOnly: 0, clicked: 0 };
  const items = data?.items ?? [];

  const filterTabs: { value: StalledFilter; label: string }[] = [
    { value: 'all', label: `All (${counts.total})` },
    { value: 'opened-only', label: `Opened only (${counts.openedOnly})` },
    { value: 'clicked', label: `Clicked (${counts.clicked})` },
  ];

  return (
    <Card className="glass-card border-none" data-testid="stalled-expiring-reminders-widget">
      <CardHeader className="pb-3">
        <CardTitle className="text-white text-base flex items-center gap-2">
          <Eye className="w-4 h-4 text-amber-400" />
          Stalled export reminders
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Members who opened the export-expiring reminder but haven't
          downloaded their archive. Send a personal nudge before the
          daily purger removes the file.
        </p>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="stalled-filters">
          {filterTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setFilter(tab.value)}
              data-testid={`stalled-filter-${tab.value}`}
              data-active={filter === tab.value}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                filter === tab.value
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
                  : 'bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-4 text-center">Loading…</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center" data-testid="stalled-empty">
              No stalled reminders.
            </div>
          ) : (
            items.map((row) => {
              const memberName =
                [row.memberFirstName, row.memberLastName].filter(Boolean).join(' ')
                || `Member #${row.clubMemberId}`;
              // Task #1881 — recipient label embedded in the success/error
              // toast. Prefer the display name; if both name parts are
              // missing (anonymised exports, deleted profile, etc.) fall
              // back to the club's member number, then to the internal id
              // as a last resort so the toast is *never* anonymous.
              const recipientLabel =
                [row.memberFirstName, row.memberLastName].filter(Boolean).join(' ')
                || row.memberNumber
                || `Member #${row.clubMemberId}`;
              const clicked = !!row.expiringReminderEmailClickedAt;
              const purgeLabel = timeUntil(row.purgesAt);
              const openedAt = row.expiringReminderEmailOpenedAt
                ? new Date(row.expiringReminderEmailOpenedAt).toLocaleString(i18n.language || undefined)
                : '—';
              const purgesAtLabel = row.purgesAt
                ? new Date(row.purgesAt).toLocaleString(i18n.language || undefined)
                : '—';
              const isPending = nudgeMutation.isPending
                && nudgeMutation.variables?.requestId === row.id;
              // Task #1528 — inline "who last nudged this row" indicator. The
              // freshness check is purely client-side (we never re-evaluate
              // the recency window on the server) so the button re-enables
              // automatically as the timestamp ages past the threshold on
              // the next refetch / re-render.
              const lastNudgedAtLabel = row.lastNudgedAt
                ? new Date(row.lastNudgedAt).toLocaleString(i18n.language || undefined)
                : null;
              const nudgedRecently = !!row.lastNudgedAt
                && (Date.now() - new Date(row.lastNudgedAt).getTime()) < STALLED_NUDGE_RECENT_WINDOW_MS;
              const nudgedByName = row.lastNudgedByDisplayName ?? 'an admin';
              return (
                <div
                  key={row.id}
                  className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-white/10 bg-white/5"
                  data-testid={`stalled-row-${row.id}`}
                  data-clicked={clicked ? 'true' : 'false'}
                  data-nudged-recently={nudgedRecently ? 'true' : 'false'}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link href={`/member-360/${row.clubMemberId}?tab=data`}>
                        <span
                          className="text-sm font-medium text-white truncate hover:text-amber-200 cursor-pointer"
                          data-testid={`stalled-member-${row.id}`}
                        >
                          {memberName}
                        </span>
                      </Link>
                      {clicked ? (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 bg-amber-500/10 text-amber-200 text-[10px] py-0 px-1.5"
                        >
                          Clicked
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-white/20 bg-white/5 text-white/70 text-[10px] py-0 px-1.5"
                        >
                          Opened only
                        </Badge>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                      <span title={openedAt} data-testid={`stalled-opened-${row.id}`}>
                        Opened {openedAt}
                      </span>
                      <span className="text-white/30">·</span>
                      <span
                        title={purgesAtLabel}
                        data-testid={`stalled-purges-${row.id}`}
                        className={purgeLabel.includes('h left') && !purgeLabel.includes('d') ? 'text-red-300' : ''}
                      >
                        Purges in {purgeLabel}
                      </span>
                    </div>
                    {row.lastNudgedAt ? (
                      <div
                        className={`text-[11px] mt-0.5 ${nudgedRecently ? 'text-amber-300' : 'text-white/40'}`}
                        title={lastNudgedAtLabel ?? undefined}
                        data-testid={`stalled-last-nudge-${row.id}`}
                      >
                        Nudged {timeSince(row.lastNudgedAt)} by {nudgedByName}
                      </div>
                    ) : null}
                    {/* Task #1891 — per-channel ✓/✗ row so admins can see
                        whether the personal nudge actually went out before
                        deciding to retry. Only render when the audit row
                        carried at least one channel detail (legacy rows
                        get suppressed so the widget stays uncluttered). */}
                    {row.lastNudgedAt && row.lastNudgedChannels ? (() => {
                      const ch = row.lastNudgedChannels;
                      const visible = STALLED_NUDGE_CHANNEL_LABELS
                        .map(({ key, label }) => ({ key, label, detail: ch[key] }))
                        .filter((c): c is { key: keyof StalledNudgeChannels; label: string; detail: StalledNudgeChannelDetail } => c.detail != null);
                      if (visible.length === 0) return null;
                      return (
                        <div
                          className="text-[11px] mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5"
                          data-testid={`stalled-nudge-channels-${row.id}`}
                        >
                          {visible.map(({ key, label, detail }, idx) => {
                            const ok = STALLED_NUDGE_SUCCESS_STATUSES.has(detail.status);
                            return (
                              <span key={key} className="flex items-center gap-1">
                                {idx > 0 ? <span className="text-white/20">·</span> : null}
                                <span
                                  className={`cursor-help ${ok ? 'text-emerald-300' : 'text-red-300'}`}
                                  title={stalledNudgeChannelTooltip(label, detail)}
                                  data-testid={`stalled-nudge-channel-${key}-${row.id}`}
                                  data-channel-status={detail.status}
                                  data-channel-ok={ok ? 'true' : 'false'}
                                >
                                  <span aria-hidden="true">{ok ? '✓' : '✗'}</span>{' '}
                                  <span>{label}</span>
                                </span>
                              </span>
                            );
                          })}
                        </div>
                      );
                    })() : null}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isPending || nudgedRecently}
                    onClick={() => {
                      // Defense-in-depth for the recent-nudge guard: the
                      // `disabled` prop above already blocks the normal
                      // pointer path, but if a future refactor drops it
                      // (or a test/automation forces a click through) the
                      // confirm() fallback still gives the second admin a
                      // chance to back out before double-firing the nudge.
                      if (
                        nudgedRecently
                        && !window.confirm(
                          `${memberName} was already nudged ${timeSince(row.lastNudgedAt)} by ${nudgedByName}. Send another nudge anyway?`,
                        )
                      ) {
                        return;
                      }
                      nudgeMutation.mutate({ memberId: row.clubMemberId, requestId: row.id, recipientLabel });
                    }}
                    data-testid={`stalled-nudge-${row.id}`}
                    title={
                      nudgedRecently
                        ? `Already nudged ${timeSince(row.lastNudgedAt)} by ${nudgedByName}`
                        : undefined
                    }
                    className="border-amber-500/40 hover:bg-amber-500/10 text-amber-200 text-xs disabled:opacity-50"
                  >
                    {isPending
                      ? 'Sending…'
                      : nudgedRecently
                        ? 'Just nudged'
                        : 'Send nudge'}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Levy totals widget (Task #281) — surfaces the per-currency aggregates from
 * the existing `/levies-summary` endpoint so org_admins/treasurers can see
 * what's owed/collected at a glance from the dashboard, with a deep-link to
 * /finance-ledger for full reconciliation. Multi-currency clubs get one tile
 * per currency (no meaningless cross-currency sums).
 */
export function LevyTotalsWidget({ orgId }: { orgId: number }) {
  // Visibility mirrors the backend's `requireMemberAdmin` policy
  // (org_admin / super_admin / membership_secretary / treasurer). Rather than
  // hardcoding the role list on the client — `treasurer` and
  // `membership_secretary` come from org membership, not `user.role` — the
  // widget self-hides if the API responds 401/403, matching the pattern used
  // by BouncedDigestPrefsCard in club-settings. This guarantees treasurers
  // see the tile while non-finance users do not.
  const { data, isLoading } = useQuery<LeviesSummaryResponse | null>({
    queryKey: ['/api/organizations', orgId, 'members-360/levies-summary'],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/members-360/levies-summary`), { credentials: 'include' });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error('Failed to load levy totals');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 60 * 1000,
    retry: false,
  });

  if (!isLoading && data === null) return null;

  const entries = Object.entries(data?.totalsByCurrency ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Card className="glass-card border-none" data-testid="card-levy-totals">
      <CardHeader className="pb-3">
        <CardTitle className="text-white text-base flex items-center gap-2">
          <Wallet className="w-4 h-4 text-emerald-400" />
          Levy totals
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <div className="h-20 bg-white/5 animate-pulse rounded-lg" />
            <div className="h-20 bg-white/5 animate-pulse rounded-lg" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No levies yet.</p>
        ) : (
          entries.map(([currency, t]) => (
            <div
              key={currency}
              className="rounded-lg border border-white/5 bg-black/30 p-3"
              data-testid={`tile-levy-totals-${currency}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {currency}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t.leviesCount} {t.leviesCount === 1 ? 'levy' : 'levies'} · {t.chargesCount} {t.chargesCount === 1 ? 'charge' : 'charges'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-[11px] text-muted-foreground">Collected</p>
                  <p className="text-sm font-semibold text-emerald-300" data-testid={`tile-${currency}-collected`}>
                    {formatMoney(t.collected, currency)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Outstanding</p>
                  <p className="text-sm font-semibold text-amber-300" data-testid={`tile-${currency}-outstanding`}>
                    {formatMoney(t.outstanding, currency)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Refunded</p>
                  <p className="text-sm font-semibold text-blue-300" data-testid={`tile-${currency}-refunded`}>
                    {formatMoney(t.refunded, currency)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Waived</p>
                  <p className="text-sm font-semibold text-white/70" data-testid={`tile-${currency}-waived`}>
                    {formatMoney(t.waived, currency)}
                  </p>
                </div>
              </div>
            </div>
          ))
        )}
        <Link href="/finance-ledger">
          <Button
            variant="outline"
            size="sm"
            className="w-full border-white/10 hover:bg-white/5 mt-1"
            data-testid="link-levy-totals-ledger"
          >
            Open finance ledger <ArrowRight className="w-3.5 h-3.5 ml-2" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

// ─── Stuck side-game receipt deliveries (Task #1117) ──────────────────
//
// Surfaces side-game payment receipts whose email/push delivery has
// either run out of retries (`*RetryExhaustedAt` stamped) or been
// permanently skipped by the helper (no email on file, push opted out,
// SMTP not configured, …). Until now nobody was notified — operators
// had to query the database to find players whose receipts never
// arrived. The widget self-hides for non-admins (the API responds
// 401/403) so it never surfaces to members.
interface StuckReceiptItem {
  id: number;
  settlementId: number;
  recipientUserId: number;
  // Task #1291: optional clubMembers.id resolved server-side. When
  // present we render the recipient name as a link to Member 360 so
  // admins can contact the affected member without leaving the page.
  recipientClubMemberId: number | null;
  payerName: string;
  recipientName: string | null;
  recipientEmail: string | null;
  gameLabel: string;
  currency: string;
  amount: number;
  paidAt: string | null;
  emailStatus: string | null;
  emailAttempts: number;
  lastEmailError: string | null;
  emailRetryExhaustedAt: string | null;
  pushStatus: string | null;
  pushAttempts: number;
  lastPushError: string | null;
  pushRetryExhaustedAt: string | null;
  emailStuck: boolean;
  pushStuck: boolean;
}

interface StuckReceiptsResponse {
  items: StuckReceiptItem[];
  counts: { total: number; exhausted: number; skipped: number };
  // Task #1874: pagination metadata so the widget can let admins page
  // beyond the first 200 stuck rows during a real outage instead of
  // silently truncating the list (the cron-emailed CSV pulls up to 1000
  // rows, so without this the two surfaces would drift apart).
  pagination?: { limit: number; offset: number; hasMore: boolean };
}

const STUCK_RECEIPTS_PAGE_SIZE = 200;

const RECEIPT_CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'د.إ', SGD: 'S$',
};

function fmtReceiptMoney(amount: number, currency: string): string {
  const sym = RECEIPT_CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${sym}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Stuck side-game receipts daily/weekly digest schedule (Task #1290) ──
//
// Mirrors `WalletTopupRefundEmailSchedulePanel` (Task #1073). Org admins
// configure a per-org cadence + recipient list and the cron emails the
// elapsed-period CSV of stuck side-game receipts to support so follow-up
// no longer requires anyone to remember to log in. The schedule endpoint
// 401s/403s for non-admins, so we self-hide on auth errors instead of
// toasting on every dashboard load (same shape as the failures widget
// directly below).

interface ReceiptDigestScheduleRow {
  id: number;
  organizationId: number;
  frequency: 'daily' | 'weekly';
  recipients: string[];
  enabled: boolean;
  lastSentAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Task #2196 — per-recipient suppression metadata captured by the cron
// at the moment the bounce-aware filter pruned the address from a run.
// Mirrors `ReceiptDigestRunRow.pausedRecipients` and the wallet
// auto-refund counterpart added in Task #1759. Sourced from
// `side_game_receipt_digest_runs.paused_recipients` so the row stays
// accurate even after support later lifts the suppression — the run
// history is a historical snapshot, not a live join.
interface ReceiptDigestPausedRecipientSnapshot {
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
}

interface ReceiptDigestRunRow {
  id: number;
  scheduleId: number;
  sentAt: string;
  periodStart: string | null;
  periodEnd: string;
  recipients: string[];
  rowCount: number;
  exhaustedCount: number;
  skippedCount: number;
  status: 'sent' | 'failed' | 'skipped';
  errorMessage: string | null;
  // Task #2196 — defaults to `[]` thanks to the column default; treated
  // defensively in the renderer because pre-#2196 rows can still come
  // back without the field if a stale serializer drops it.
  pausedRecipients?: ReceiptDigestPausedRecipientSnapshot[];
}

/**
 * Friendly label for the suppression `reason` enum stored in
 * `email_suppressions.reason` so support can read it at a glance instead
 * of decoding "spam_complaint" or "bounced". Mirrors the wallet
 * auto-refund equivalent in `wallet-topup-refunds.tsx` (Task #1443) but
 * stays plain-English here since the side-game receipt digest panel is
 * not yet wired through the admin i18n namespace — translation is
 * tracked separately as a follow-up.
 */
function receiptDigestPausedReasonLabel(reason: string, bounceType: string | null): string {
  switch (reason) {
    case 'bounced':
      return bounceType ? `Bounced (${bounceType})` : 'Bounced';
    case 'unsubscribed': return 'Unsubscribed';
    case 'spam_complaint': return 'Spam complaint';
    case 'manual': return 'Manually suppressed';
    default: return reason;
  }
}

interface ReceiptDigestOverdueBy {
  overdueByMs: number;
  periodMs: number;
  expectedAt: string;
}

// Task #2171 — per-recipient resolved digest language so each saved
// recipient row can show what it'll actually receive, plus a subtle
// "prefers X" hint when an internal recipient's own preferred
// language differs from the digest language. Mirrors the wallet
// auto-refund schedule editor (Task #1747).
interface ReceiptDigestRecipientLanguageRow {
  email: string;
  userPreferredLanguage: string | null;
  resolvedDigestLanguage: string;
  mismatch: boolean;
}

interface ReceiptDigestScheduleResponse {
  schedule: ReceiptDigestScheduleRow | null;
  history: ReceiptDigestRunRow[];
  // Task #1877 — populated when `nextRunAt` is more than one full
  // period in the past with no later history row. Drives the inline
  // "missed run" warning banner above the run-history table.
  overdueBy?: ReceiptDigestOverdueBy | null;
  // Task #2171 — one entry per saved recipient with the language the
  // cron would actually email them in. Empty array when no schedule
  // is configured.
  recipientLanguages?: ReceiptDigestRecipientLanguageRow[];
}

function receiptDigestLanguageDisplayName(code: string | null | undefined): string {
  if (!code) return 'English (en)';
  const found = SUPPORTED_LANGUAGES.find(l => l.code === code);
  return found ? `${found.name} (${found.code})` : code;
}

function formatReceiptDigestOverdue(overdueByMs: number): string {
  const minutes = Math.floor(overdueByMs / (60 * 1000));
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

const RECEIPT_DIGEST_BASE = '/admin/side-game-receipt-failures/email-schedule';
const RECEIPT_DIGEST_EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ReceiptDigestRunSparkline({ history }: { history: ReceiptDigestRunRow[] }) {
  if (history.length === 0) return null;
  // History arrives newest-first; reverse so the sparkline reads left-to-right
  // chronologically (oldest run on the left, latest on the right).
  const ordered = [...history].slice(0, 24).reverse();
  const max = Math.max(1, ...ordered.map(r => r.rowCount));
  const w = 220;
  const h = 36;
  const barW = w / ordered.length;
  const cleanCount = ordered.filter(r => r.status === 'sent' && r.rowCount === 0).length;
  const stuckCount = ordered.filter(r => r.status === 'sent' && r.rowCount > 0).length;
  const otherCount = ordered.length - cleanCount - stuckCount;
  return (
    <div
      className="border border-white/10 rounded-md bg-black/30 px-3 py-2 flex items-center justify-between gap-3"
      data-testid="receipt-digest-history-sparkline"
    >
      <div className="text-[10px] text-muted-foreground leading-tight">
        <div className="uppercase tracking-wider">Trend ({ordered.length} run{ordered.length === 1 ? '' : 's'})</div>
        <div>
          <span className="text-sky-300" data-testid="receipt-digest-clean-count">{cleanCount}</span> clean
          {' · '}
          <span className="text-amber-300" data-testid="receipt-digest-stuck-count">{stuckCount}</span> with stuck
          {otherCount > 0 ? <> {' · '}<span className="text-rose-300" data-testid="receipt-digest-other-count">{otherCount}</span> failed/skipped</> : null}
        </div>
      </div>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className="shrink-0"
        role="img"
        aria-label="Stuck-receipt counts per recent digest run"
      >
        {ordered.map((r, i) => {
          const isClean = r.status === 'sent' && r.rowCount === 0;
          const isStuck = r.status === 'sent' && r.rowCount > 0;
          const isFailed = r.status === 'failed';
          // Clean runs render as a thin baseline tick so an admin can still
          // see the period was processed; bars represent stuck rowCount.
          const barH = isClean ? 2 : Math.max(2, Math.round((r.rowCount / max) * (h - 4)));
          const fill = isFailed
            ? '#f87171'
            : isStuck
              ? '#fbbf24'
              : isClean
                ? '#7dd3fc'
                : '#a3a3a3';
          const x = i * barW + 1;
          const y = h - barH;
          const titleParts = [
            r.status === 'sent' && r.rowCount === 0 ? 'Clean week — 0 stuck' : `${r.status} · ${r.rowCount} stuck`,
            new Date(r.sentAt).toLocaleString(),
          ];
          return (
            <rect
              key={r.id}
              x={x}
              y={y}
              width={Math.max(1, barW - 2)}
              height={barH}
              fill={fill}
              opacity={isClean ? 0.85 : 1}
              data-testid={`receipt-digest-spark-bar-${r.id}`}
            >
              <title>{titleParts.join(' · ')}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

export function SideGameReceiptDigestSchedulePanel({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = ['side-game-receipt-digest-schedule', orgId] as const;

  const q = useQuery<ReceiptDigestScheduleResponse | null>({
    queryKey,
    queryFn: async () => {
      const r = await fetch(API(`${RECEIPT_DIGEST_BASE}?organizationId=${orgId}`), { credentials: 'include' });
      if (r.status === 401 || r.status === 403) return null;
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId,
    retry: false,
  });

  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('weekly');
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

  const parsedRecipients = recipients.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  const invalid = parsedRecipients.filter(r => !RECEIPT_DIGEST_EMAIL_RX.test(r));
  const canSave = parsedRecipients.length > 0 && parsedRecipients.length <= 20 && invalid.length === 0;

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(API(`${RECEIPT_DIGEST_BASE}?organizationId=${orgId}`), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency, recipients: parsedRecipients, enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      toast({
        title: 'Stuck-receipts digest schedule saved',
        description: enabled
          ? 'Support will receive the next stuck-receipts CSV automatically.'
          : 'Schedule paused; no emails will be sent.',
      });
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(API(`${RECEIPT_DIGEST_BASE}?organizationId=${orgId}`), { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    },
    onSuccess: () => {
      toast({ title: 'Schedule removed' });
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => toast({ title: 'Remove failed', description: e.message, variant: 'destructive' }),
  });

  const [previewOpen, setPreviewOpen] = useState(false);
  const previewMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(API(`${RECEIPT_DIGEST_BASE}/preview?organizationId=${orgId}`), { credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{
        subject: string; html: string; filename: string;
        rowCount: number; exhaustedCount: number; skippedCount: number;
        recipients: string[]; frequency: 'daily' | 'weekly';
        periodStart: string; periodEnd: string;
      }>;
    },
    onSuccess: () => setPreviewOpen(true),
    onError: (e: Error) => toast({ title: 'Preview failed', description: e.message, variant: 'destructive' }),
  });

  const sendNowMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(API(`${RECEIPT_DIGEST_BASE}/send-now?organizationId=${orgId}`), { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ status: string; rowCount: number; exhaustedCount: number; skippedCount: number; recipients: string[]; errorMessage?: string }>;
    },
    onSuccess: (res) => {
      if (res.status === 'sent') {
        toast({
          title: 'Digest sent',
          description: `Delivered ${res.rowCount} stuck-receipt row${res.rowCount === 1 ? '' : 's'} (${res.exhaustedCount} exhausted, ${res.skippedCount} skipped) to ${res.recipients.length} recipient${res.recipients.length === 1 ? '' : 's'}.`,
        });
      } else {
        toast({ title: 'Send failed', description: res.errorMessage ?? res.status, variant: 'destructive' });
      }
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => toast({ title: 'Send failed', description: e.message, variant: 'destructive' }),
  });

  // Self-hide for non-admins (same shape as SideGameReceiptFailuresWidget).
  if (!q.isLoading && q.data === null) return null;

  const history = q.data?.history ?? [];
  const overdueBy = q.data?.overdueBy ?? null;
  // Task #2171 — backend tells us each saved recipient's resolved digest
  // language plus (when the recipient is a known app user) their own
  // preferred language. Render a row per saved recipient so support
  // admins can spot mismatches before they happen — mirrors the
  // wallet auto-refund schedule editor (Task #1747).
  const recipientLanguages = q.data?.recipientLanguages ?? [];
  const fmtPeriod = (start: string | null, end: string) => {
    const s = start ? new Date(start).toLocaleDateString() : '—';
    const e = new Date(end).toLocaleDateString();
    return `${s} → ${e}`;
  };

  return (
    <Card className="glass-card border-none" data-testid="card-stuck-receipts-digest-schedule">
      <CardHeader className="pb-3">
        <CardTitle className="text-white text-base flex items-center gap-2">
          <Mail className="w-4 h-4 text-amber-300" />
          Email stuck-receipts digest to support on a schedule
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Send the stuck side-game receipts CSV automatically each day or week so follow-up can happen entirely from the inbox — no need to remember to log in.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="py-3 text-center text-xs text-muted-foreground">Loading schedule…</div>
        ) : q.isError ? (
          <div className="py-3 text-center text-xs text-rose-300">Failed to load schedule.</div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">Frequency</Label>
                <Select value={frequency} onValueChange={v => setFrequency(v as 'daily' | 'weekly')}>
                  <SelectTrigger className="mt-1 h-8 text-xs bg-black/40 border-white/10 text-white" data-testid="select-receipt-digest-frequency" aria-label="Frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 text-xs text-white cursor-pointer h-8">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={e => setEnabled(e.target.checked)}
                    data-testid="toggle-receipt-digest-enabled"
                    className="accent-amber-500"
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
                placeholder="support@club.com, ops@club.com"
                className="mt-1 bg-black/40 border-white/10 text-white text-xs min-h-[60px]"
                data-testid="input-receipt-digest-recipients"
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
              <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                <span>Last sent: {sched.lastSentAt ? new Date(sched.lastSentAt).toLocaleString() : 'never'}</span>
                <span>Next run: {sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : '—'}</span>
              </div>
            )}
            {/* Task #2171 — per-recipient resolved digest language. The
                cron renders the digest in one org-wide language for every
                recipient (resolveSideGameReceiptDigestLang), but a
                support admin benefits from seeing "<email> → English"
                inline so they can spot when an external recipient or an
                internal user with their own `preferredLanguage` will
                receive something other than what they expect. The
                "prefers X" hint is shown only for known app users whose
                own preference differs from the resolved digest language;
                external recipients (no app_users row) just show the
                resolved language with no preference hint, since we
                cannot know what they would prefer. Mirrors the wallet
                auto-refund schedule editor (Task #1747). */}
            {sched && recipientLanguages.length > 0 && (
              <div
                className="rounded-md border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-muted-foreground flex items-start gap-2"
                data-testid="receipt-digest-language-banner"
              >
                <Languages className="w-3.5 h-3.5 mt-0.5 text-amber-300 shrink-0" />
                <ul
                  className="space-y-0.5 flex-1"
                  data-testid="receipt-digest-recipient-languages"
                >
                  {recipientLanguages.map((row, idx) => (
                    <li
                      key={`${row.email}-${idx}`}
                      data-testid={`receipt-digest-recipient-language-row-${idx}`}
                      className="flex flex-wrap items-baseline gap-x-2"
                    >
                      <span className="font-mono text-white truncate max-w-[18rem]" title={row.email}>{row.email}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="text-white">{receiptDigestLanguageDisplayName(row.resolvedDigestLanguage)}</span>
                      {row.mismatch && row.userPreferredLanguage && (
                        <span
                          className="text-amber-300"
                          data-testid={`receipt-digest-recipient-language-mismatch-${idx}`}
                          title={`This recipient's own language preference is ${receiptDigestLanguageDisplayName(row.userPreferredLanguage)}, but the digest is sent in ${receiptDigestLanguageDisplayName(row.resolvedDigestLanguage)}.`}
                        >
                          · prefers {receiptDigestLanguageDisplayName(row.userPreferredLanguage)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => saveMut.mutate()}
                disabled={!canSave || saveMut.isPending}
                data-testid="button-save-receipt-digest-schedule"
                className="bg-amber-600 hover:bg-amber-700 text-white"
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
                    data-testid="button-preview-receipt-digest"
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
                    data-testid="button-send-receipt-digest-now"
                    className="border-white/10 text-white"
                  >
                    {sendNowMut.isPending ? 'Sending…' : 'Send now'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { if (confirm('Remove the stuck-receipts digest schedule?')) deleteMut.mutate(); }}
                    disabled={deleteMut.isPending}
                    data-testid="button-delete-receipt-digest-schedule"
                    className="text-rose-300 hover:text-rose-200"
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
            {sched && (
              <>
                {overdueBy && (
                  <div
                    className="border border-rose-500/40 bg-rose-500/10 rounded-md px-3 py-2 flex items-start gap-2"
                    role="alert"
                    data-testid="receipt-digest-missed-run-warning"
                  >
                    <AlertTriangle className="w-4 h-4 text-rose-300 mt-0.5 shrink-0" />
                    <div className="text-xs text-rose-100 leading-snug flex-1">
                      <div className="font-semibold text-rose-200">Missed scheduled run</div>
                      <div className="mt-0.5">
                        The {sched.frequency} stuck-receipts digest was due{' '}
                        <span className="font-semibold" data-testid="receipt-digest-missed-run-overdue">
                          {formatReceiptDigestOverdue(overdueBy.overdueByMs)}
                        </span>{' '}
                        ago ({new Date(overdueBy.expectedAt).toLocaleString()}) but no run has been recorded since.
                        The cron may be stalled —{' '}
                        <Link
                          href="/webhooks"
                          className="underline text-rose-200 hover:text-white"
                          data-testid="link-receipt-digest-cron-diagnostics"
                        >
                          open cron / webhook diagnostics
                        </Link>
                        .
                      </div>
                    </div>
                  </div>
                )}
                <ReceiptDigestRunSparkline history={history} />
                <div className="border border-white/10 rounded-md overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-black/40 text-[10px] text-muted-foreground uppercase tracking-wider">
                      <tr>
                        <th className="text-left px-2 py-1.5">Sent</th>
                        <th className="text-left px-2 py-1.5">Period</th>
                        <th className="text-left px-2 py-1.5">Rows</th>
                        <th className="text-left px-2 py-1.5">Exhausted</th>
                        <th className="text-left px-2 py-1.5">Skipped</th>
                        <th className="text-left px-2 py-1.5">Recipients</th>
                        {/* Task #2196 — per-run "X paused" column so support
                            can see at a glance which recipients were
                            silently dropped from a specific run, without
                            parsing the free-text errorMessage. Mirrors
                            the wallet auto-refund counterpart added in
                            Task #1759. */}
                        <th className="text-left px-2 py-1.5">Paused</th>
                        <th className="text-left px-2 py-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.length === 0 ? (
                        <tr><td colSpan={8} className="px-2 py-3 text-center text-muted-foreground" data-testid="receipt-digest-history-empty">No digest emails sent yet.</td></tr>
                      ) : history.map(h => {
                        const isClean = h.status === 'sent' && h.rowCount === 0;
                        const isStuck = h.status === 'sent' && h.rowCount > 0;
                        const rowTint = h.status === 'failed'
                          ? 'bg-red-500/10'
                          : h.status === 'skipped'
                            ? 'bg-amber-500/5'
                            : isStuck
                              ? 'bg-amber-500/10'
                              : 'bg-sky-500/5';
                        const badgeTone = isClean
                          ? 'bg-sky-500/20 text-sky-300 border-sky-500/30'
                          : isStuck
                            ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                            : h.status === 'failed'
                              ? 'bg-red-500/20 text-red-300 border-red-500/30'
                              : 'bg-amber-500/20 text-amber-300 border-amber-500/30';
                        const badgeLabel = isClean
                          ? 'clean — 0 stuck'
                          : isStuck
                            ? `sent · ${h.rowCount} stuck`
                            : h.status;
                        const rowsCell = isStuck
                          ? <span className="text-amber-300 font-semibold">{h.rowCount}</span>
                          : isClean
                            ? <span className="text-sky-300">0</span>
                            : <span className="text-white">{h.rowCount}</span>;
                        const dataAttrs: Record<string, string> = {
                          'data-testid': `receipt-digest-history-row-${h.id}`,
                          'data-clean-week': isClean ? 'true' : 'false',
                          'data-has-stuck': isStuck ? 'true' : 'false',
                        };
                        return (
                          <tr
                            key={h.id}
                            className={`border-t border-white/5 ${rowTint}`}
                            {...dataAttrs}
                          >
                            <td className="px-2 py-1.5 text-white whitespace-nowrap">{new Date(h.sentAt).toLocaleString()}</td>
                            <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{fmtPeriod(h.periodStart, h.periodEnd)}</td>
                            <td className="px-2 py-1.5">{rowsCell}</td>
                            <td className="px-2 py-1.5 text-white">{h.exhaustedCount}</td>
                            <td className="px-2 py-1.5 text-white">{h.skippedCount}</td>
                            <td className="px-2 py-1.5 text-muted-foreground max-w-[14rem] truncate" title={h.recipients.join(', ')}>
                              {h.recipients.length}
                            </td>
                            {/* Task #2196 — per-row paused-recipients chip
                                + per-recipient breakdown. Mirrors the
                                wallet auto-refund dashboard pattern from
                                Task #1759 (`wallet-topup-refunds.tsx`).
                                Reads from the historical snapshot column
                                so the row stays accurate even after
                                support later lifts the suppression. */}
                            <td className="px-2 py-1.5 align-top">
                              {(() => {
                                const paused = h.pausedRecipients ?? [];
                                if (paused.length === 0) {
                                  return <span className="text-muted-foreground" data-testid={`receipt-digest-history-paused-empty-${h.id}`}>—</span>;
                                }
                                return (
                                  <div className="space-y-1" data-testid={`receipt-digest-history-paused-${h.id}`}>
                                    <Badge
                                      className="bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] whitespace-nowrap inline-flex items-center gap-1"
                                      data-testid={`receipt-digest-history-paused-chip-${h.id}`}
                                    >
                                      <AlertTriangle className="w-3 h-3" />
                                      {paused.length} paused
                                    </Badge>
                                    <ul className="text-[10px] text-amber-200/90 space-y-0.5 max-w-[14rem]">
                                      {paused.map((p, idx) => (
                                        <li
                                          key={`${p.email}-${idx}`}
                                          className="truncate"
                                          title={p.description ? `${p.email} — ${receiptDigestPausedReasonLabel(p.reason, p.bounceType)}: ${p.description}` : `${p.email} — ${receiptDigestPausedReasonLabel(p.reason, p.bounceType)}`}
                                          data-testid={`receipt-digest-history-paused-row-${h.id}-${idx}`}
                                        >
                                          <span className="text-white/90">{p.email}</span>
                                          <span className="text-amber-300/80"> · {receiptDigestPausedReasonLabel(p.reason, p.bounceType)}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="px-2 py-1.5">
                              <Badge className={`${badgeTone} border text-[10px] whitespace-nowrap`} data-testid={`receipt-digest-history-status-${h.id}`}>{badgeLabel}</Badge>
                              {h.errorMessage && <div className="text-[10px] text-rose-300 mt-1 truncate max-w-[14rem]" title={h.errorMessage}>{h.errorMessage}</div>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-3xl bg-[#0a1628] border-white/10 text-white" data-testid="dialog-receipt-digest-preview">
            <DialogHeader>
              <DialogTitle className="text-white">Preview — next stuck-receipts digest email</DialogTitle>
              <DialogDescription className="text-muted-foreground text-xs">
                This is what the next scheduled email would look like if it were sent right now. Nothing has been sent and no run was recorded.
              </DialogDescription>
            </DialogHeader>
            {previewMut.data && (() => {
              // Task #1878 — mirror the dashboard's clean-vs-stuck tone
              // (Task #1523) inside the preview dialog so admins see the
              // same at-a-glance signal recipients will see in their
              // inbox. The rendered body iframe already inherits the
              // emerald accent + `[clean]` subject from the mailer; the
              // surrounding metadata block also switches accent so the
              // header doesn't read alarmingly amber when the digest is
              // calm.
              const isClean = previewMut.data.rowCount === 0;
              const toneAccent = isClean ? 'text-emerald-300' : 'text-amber-400';
              const toneTagClass = isClean
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                : 'bg-amber-500/15 text-amber-300 border-amber-500/30';
              const toneTagLabel = isClean ? 'clean — 0 stuck' : `needs follow-up · ${previewMut.data.rowCount} stuck`;
              return (
                <div className="space-y-3 max-h-[70vh] overflow-y-auto" data-clean-week={isClean ? 'true' : 'false'} data-testid="receipt-preview-pane">
                  <div>
                    <Badge
                      className={`${toneTagClass} border text-[10px]`}
                      data-testid="badge-receipt-preview-tone"
                    >
                      {toneTagLabel}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Subject</div>
                      <div className={isClean ? 'text-emerald-200' : 'text-white'} data-testid="text-receipt-preview-subject">{previewMut.data.subject}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Recipients</div>
                      <div className="text-white" data-testid="text-receipt-preview-recipients">
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
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">CSV contents</div>
                      <div className="text-white" data-testid="text-receipt-preview-counts">
                        {isClean ? (
                          <span className="text-emerald-300">No action needed this period — empty CSV attached for reconciliation continuity.</span>
                        ) : (
                          <>
                            <span className={`${toneAccent} font-semibold`}>{previewMut.data.rowCount}</span> row{previewMut.data.rowCount === 1 ? '' : 's'}
                            {' · '}
                            <span className={`${toneAccent} font-semibold`}>{previewMut.data.exhaustedCount}</span> exhausted
                            {' · '}
                            <span className={`${toneAccent} font-semibold`}>{previewMut.data.skippedCount}</span> skipped
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Rendered body</div>
                    <div className="border border-white/10 rounded-md bg-white overflow-hidden">
                      <iframe
                        title="Email body preview"
                        srcDoc={previewMut.data.html}
                        sandbox=""
                        className="w-full h-[420px] bg-white"
                        data-testid="iframe-receipt-preview-body"
                      />
                    </div>
                  </div>
                </div>
              );
            })()}
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPreviewOpen(false)}
                className="border-white/10 text-white"
                data-testid="button-close-receipt-preview"
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export function SideGameReceiptFailuresWidget({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Task #1888: localise the panel into the same 21 languages the
  // stuck-receipts digest email (Task #1522) supports so non-English
  // admins who follow the email's "open the dashboard and edit the
  // 'Stuck side-game receipts' panel" link don't land on English copy.
  // Strings live under `dashboard.stuckReceipts.*` in each locale's
  // `dashboard.json`.
  const { t } = useTranslation('dashboard');
  // Maps the raw `emailStatus` / `pushStatus` payload values returned by
  // `/admin/side-game-receipt-failures` (see STUCK_STATUSES in
  // `artifacts/api-server/src/routes/side-games-v2.ts`:
  // `["skipped", "no_address", "opted_out", "no_user"]`, plus
  // `"failed"` and any defensive value the cron may surface in future)
  // onto translated pill labels so the status pill text never leaks
  // raw English snake_case codes to non-English admins. Falls back to
  // the unknown label if the API ever introduces a new code we haven't
  // localised yet — preferable to printing the raw code.
  const localiseStatus = (status: string | null | undefined): string => {
    const fallback = t('stuckReceipts.statuses.unknown');
    if (!status) return t('stuckReceipts.channelSkipped');
    const key = `stuckReceipts.statuses.${status}`;
    const translated = t(key);
    return translated === key ? fallback : translated;
  };
  // Task #1874: page through stuck rows so admins can see > 200 entries
  // during a real outage. The infinite query fetches the first page
  // automatically and the "Load more" button below appends subsequent
  // pages while the org-wide totals (returned in `counts`) drive the
  // header badge / summary so the badge never misleadingly shows "200"
  // when there are actually hundreds more.
  const queryKey = ['/api/admin/side-game-receipt-failures', orgId] as const;

  const {
    data,
    isLoading,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
  } = useInfiniteQuery<StuckReceiptsResponse | null, Error>({
    queryKey,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const offset = typeof pageParam === 'number' ? pageParam : 0;
      const res = await fetch(
        API(`/admin/side-game-receipt-failures?organizationId=${orgId}&limit=${STUCK_RECEIPTS_PAGE_SIZE}&offset=${offset}`),
        { credentials: 'include' },
      );
      // Mirrors LevyTotalsWidget — self-hide if the viewer isn't an org
      // admin instead of bubbling up an error toast on every dashboard
      // load.
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error('Failed to load stuck receipt deliveries');
      return res.json() as Promise<StuckReceiptsResponse>;
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage?.pagination?.hasMore) return undefined;
      return lastPage.pagination.offset + lastPage.pagination.limit;
    },
    enabled: !!orgId,
    refetchInterval: 60_000,
    retry: false,
  });

  const resend = useMutation({
    mutationFn: async (attemptId: number) => {
      const res = await fetch(API(`/admin/side-game-receipt-failures/${attemptId}/resend`), {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Resend failed');
      }
      return res.json() as Promise<{ ok: boolean; requeued: { email: boolean; push: boolean } }>;
    },
    onSuccess: (result) => {
      // Task #1888: build the channel list from translated tokens so
      // the toast description (e.g. "Will retry email & push on the
      // next cron tick.") renders entirely in the org's language.
      const channelLabels = [
        result.requeued.email ? t('stuckReceipts.toast.channelEmail') : null,
        result.requeued.push ? t('stuckReceipts.toast.channelPush') : null,
      ].filter((c): c is string => Boolean(c));
      const channels = channelLabels.length > 0
        ? channelLabels.join(t('stuckReceipts.toast.channelSeparator'))
        : t('stuckReceipts.toast.channelDelivery');
      toast({
        title: t('stuckReceipts.toast.successTitle'),
        description: t('stuckReceipts.toast.successDescription', { channels }),
      });
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => {
      toast({
        title: t('stuckReceipts.toast.errorTitle'),
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  // The first page is the source of truth for "is the viewer an admin"
  // (null on 401/403) and for the org-wide counts; subsequent pages
  // only contribute additional rows.
  const firstPage = data?.pages[0];
  if (!isLoading && firstPage === null) return null;

  const items = (data?.pages ?? [])
    .filter((p): p is StuckReceiptsResponse => p !== null)
    .flatMap(p => p.items);
  const counts = firstPage?.counts;
  if (!isLoading && counts && counts.total === 0) return null;

  return (
    <Card className="glass-card border-none" data-testid="card-stuck-receipts">
      <CardHeader className="pb-3">
        <CardTitle className="text-white text-base flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          {t('stuckReceipts.title')}
          {counts && counts.total > 0 && (
            <Badge variant="outline" className="ml-auto border-amber-500/40 bg-amber-500/15 text-amber-200" data-testid="badge-stuck-receipts-count">
              {counts.total}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <div className="h-16 bg-white/5 animate-pulse rounded-lg" />
            <div className="h-16 bg-white/5 animate-pulse rounded-lg" />
          </div>
        ) : (
          <>
            {counts && (
              <p className="text-xs text-muted-foreground" data-testid="text-stuck-receipts-summary">
                {t('stuckReceipts.summary', { exhausted: counts.exhausted, skipped: counts.skipped })}
                {counts.total > items.length && (
                  // Task #1874: tell admins exactly how many rows are
                  // hidden behind the "Load more" button so they know
                  // the dashboard is consistent with the digest CSV
                  // even before they expand the full list.
                  <span data-testid="text-stuck-receipts-truncation">
                    {t('stuckReceipts.truncation', { shown: items.length, total: counts.total })}
                  </span>
                )}
              </p>
            )}
            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {items.map(it => (
                <div
                  key={it.id}
                  className="rounded-lg border border-white/5 bg-black/30 p-3 space-y-2"
                  data-testid={`row-stuck-receipt-${it.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      {it.recipientClubMemberId != null ? (
                        // Task #1291: deep-link the recipient to their Member
                        // 360 profile so admins can contact them in one click.
                        // We open the Audit tab — it surfaces the receipt
                        // delivery trail (see member-360 AuditTab) which is
                        // the most relevant context for a stuck receipt.
                        <Link
                          href={`/member-360/${it.recipientClubMemberId}?tab=audit`}
                          data-testid={`link-stuck-recipient-${it.id}`}
                        >
                          <p
                            className="text-sm font-semibold text-white truncate hover:text-primary cursor-pointer underline-offset-2 hover:underline"
                            data-testid={`text-stuck-recipient-${it.id}`}
                          >
                            {it.recipientName ?? t('stuckReceipts.userFallback', { id: it.recipientUserId })}
                          </p>
                        </Link>
                      ) : (
                        <p className="text-sm font-semibold text-white truncate" data-testid={`text-stuck-recipient-${it.id}`}>
                          {it.recipientName ?? t('stuckReceipts.userFallback', { id: it.recipientUserId })}
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground truncate">
                        {t('stuckReceipts.rowDetails', {
                          game: it.gameLabel,
                          settlementId: it.settlementId,
                          payer: it.payerName,
                        })}
                      </p>
                    </div>
                    <span className="text-sm font-semibold text-emerald-300 whitespace-nowrap">
                      {fmtReceiptMoney(it.amount, it.currency)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {it.emailStuck && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 bg-amber-500/15 text-amber-200 text-[10px]"
                        data-testid={`badge-stuck-email-${it.id}`}
                        data-status={it.emailStatus ?? 'unknown'}
                        title={it.lastEmailError ?? undefined}
                      >
                        {t('stuckReceipts.channelEmail')} · {it.emailRetryExhaustedAt
                          ? t('stuckReceipts.channelExhausted', { count: it.emailAttempts })
                          : localiseStatus(it.emailStatus)}
                      </Badge>
                    )}
                    {it.pushStuck && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 bg-amber-500/15 text-amber-200 text-[10px]"
                        data-testid={`badge-stuck-push-${it.id}`}
                        data-status={it.pushStatus ?? 'unknown'}
                        title={it.lastPushError ?? undefined}
                      >
                        {t('stuckReceipts.channelPush')} · {it.pushRetryExhaustedAt
                          ? t('stuckReceipts.channelExhausted', { count: it.pushAttempts })
                          : localiseStatus(it.pushStatus)}
                      </Badge>
                    )}
                    {it.recipientEmail && (
                      <Badge variant="outline" className="border-white/10 bg-white/5 text-white/70 text-[10px]">
                        {it.recipientEmail}
                      </Badge>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-white/10 hover:bg-white/5"
                      onClick={() => resend.mutate(it.id)}
                      disabled={resend.isPending && resend.variables === it.id}
                      data-testid={`button-resend-receipt-${it.id}`}
                    >
                      <RefreshCw className="w-3 h-3 mr-1.5" />
                      {resend.isPending && resend.variables === it.id
                        ? t('stuckReceipts.resending')
                        : t('stuckReceipts.resendButton')}
                    </Button>
                  </div>
                </div>
              ))}
              {/* Task #1874: paginate so admins can see > 200 stuck rows. */}
              {hasNextPage && (
                <div className="flex justify-center pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-white/10 hover:bg-white/5"
                    onClick={() => fetchNextPage()}
                    disabled={isFetchingNextPage}
                    data-testid="button-load-more-stuck-receipts"
                  >
                    {isFetchingNextPage
                      ? t('stuckReceipts.loading')
                      : t('stuckReceipts.loadMore', { remaining: (counts?.total ?? 0) - items.length })}
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Task #1278 — Wallet withdrawal alert delivery failures widget.
// Mirrors `SideGameReceiptFailuresWidget`: surfaces wallet-withdrawal
// notify rows whose email/push retries have either been exhausted or
// permanently skipped. Read-only — support staff use this list to
// proactively reach out to members whose payout confirmation never
// arrived (the matching member-facing badge tells the member which
// channel went silent). Self-hides for non-admins.

export function WalletWithdrawalNotifyFailuresWidget({ orgId }: { orgId: number }) {
  const queryKey = ['/api/admin/wallet-withdrawal-notify-failures', orgId] as const;

  const { data, isLoading } = useQuery<StuckWithdrawalNotifyResponse | null>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(API(`/admin/wallet-withdrawal-notify-failures?organizationId=${orgId}`), {
        credentials: 'include',
      });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error('Failed to load stuck wallet withdrawal alerts');
      return res.json();
    },
    enabled: !!orgId,
    refetchInterval: 60_000,
    retry: false,
  });

  if (!isLoading && data === null) return null;
  if (!isLoading && data && data.items.length === 0) return null;

  const items = data?.items ?? [];
  const counts = data?.counts;

  return (
    <Card className="glass-card border-none" data-testid="card-stuck-wallet-withdrawals">
      <CardHeader className="pb-3">
        <CardTitle className="text-white text-base flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          Stuck wallet withdrawal alerts
          {counts && counts.total > 0 && (
            <Badge
              variant="outline"
              className="ml-auto border-amber-500/40 bg-amber-500/15 text-amber-200"
              data-testid="badge-stuck-withdrawals-count"
            >
              {counts.total}
            </Badge>
          )}
        </CardTitle>
        <Link
          href={`${BASE_URL}/admin/wallet-alerts`}
          className="text-[11px] text-amber-200/80 hover:text-amber-200 underline mt-1 inline-block"
          data-testid="link-stuck-withdrawals-view-all"
        >
          View all & filter →
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <div className="h-16 bg-white/5 animate-pulse rounded-lg" />
            <div className="h-16 bg-white/5 animate-pulse rounded-lg" />
          </div>
        ) : (
          <>
            {counts && (
              <p className="text-xs text-muted-foreground" data-testid="text-stuck-withdrawals-summary">
                {counts.exhausted} retried until exhausted · {counts.skipped} skipped before delivery
              </p>
            )}
            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {items.map(it => {
                const outcomeLabel = it.outcome === 'processed'
                  ? 'paid'
                  : it.outcome === 'reversed' ? 'reversed' : 'failed';
                return (
                  <div
                    key={it.id}
                    className="rounded-lg border border-white/5 bg-black/30 p-3 space-y-2"
                    data-testid={`row-stuck-withdrawal-${it.id}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        {it.recipientClubMemberId != null ? (
                          // Task #1869: deep-link the recipient to their
                          // Member 360 profile so admins can contact them in
                          // one click — mirrors the side-game receipts widget
                          // (Task #1291). We open the Financial tab — it
                          // surfaces the wallet / withdrawal trail (see
                          // member-360 FinancialTab) which is the most
                          // relevant context for a stuck wallet payout
                          // notification.
                          <Link
                            href={`/member-360/${it.recipientClubMemberId}?tab=financial`}
                            data-testid={`link-stuck-withdrawal-recipient-${it.id}`}
                          >
                            <p
                              className="text-sm font-semibold text-white truncate hover:text-primary cursor-pointer underline-offset-2 hover:underline"
                              data-testid={`text-stuck-withdrawal-recipient-${it.id}`}
                            >
                              {it.recipientName ?? `User #${it.userId}`}
                            </p>
                          </Link>
                        ) : (
                          <p className="text-sm font-semibold text-white truncate" data-testid={`text-stuck-withdrawal-recipient-${it.id}`}>
                            {it.recipientName ?? `User #${it.userId}`}
                          </p>
                        )}
                        <p className="text-[11px] text-muted-foreground truncate">
                          Withdrawal #{it.withdrawalId} {outcomeLabel} · {it.destination}
                          {it.utr ? ` · UTR ${it.utr}` : ''}
                        </p>
                      </div>
                      <span className="text-sm font-semibold text-amber-300 whitespace-nowrap">
                        {fmtReceiptMoney(it.amount, it.currency)}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {it.emailStuck && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 bg-amber-500/15 text-amber-200 text-[10px]"
                          data-testid={`badge-stuck-withdrawal-email-${it.id}`}
                          data-status={it.emailStatus ?? 'unknown'}
                          title={it.lastEmailError ?? undefined}
                        >
                          Email · {it.emailRetryExhaustedAt ? `exhausted (${it.emailAttempts})` : it.emailStatus ?? 'skipped'}
                        </Badge>
                      )}
                      {it.pushStuck && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 bg-amber-500/15 text-amber-200 text-[10px]"
                          data-testid={`badge-stuck-withdrawal-push-${it.id}`}
                          data-status={it.pushStatus ?? 'unknown'}
                          title={it.lastPushError ?? undefined}
                        >
                          Push · {it.pushRetryExhaustedAt ? `exhausted (${it.pushAttempts})` : it.pushStatus ?? 'skipped'}
                        </Badge>
                      )}
                      {it.recipientEmail && (
                        <Badge
                          variant="outline"
                          className="border-white/10 bg-white/5 text-white/70 text-[10px]"
                        >
                          {it.recipientEmail}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { t } = useTranslation('dashboard');
  const queryClient = useQueryClient();
  const { data: user, isLoading: userLoading, refetch: refetchUser } = useGetMe();
  const orgId = useActiveOrgId() ?? user?.organizationId ?? undefined;
  const { data: stats, isLoading: statsLoading } = useGetOrganizationStats(orgId as number, { query: { enabled: !!orgId, queryKey: getGetOrganizationStatsQueryKey(orgId as number) } });
  const { data: tournaments } = useListTournaments(orgId as number, {}, { query: { enabled: !!orgId, queryKey: getListTournamentsQueryKey(orgId as number) } });
  const [dashTab, setDashTab] = useState('overview');

  const isAdmin = ['org_admin', 'tournament_director', 'super_admin'].includes((user as { role?: string })?.role ?? '');
  // Task #2210 — gate the four member-360 controller widgets via the shared
  // `isMemberAdmin` helper so treasurers and membership secretaries (whose
  // elevated role lives in `org_memberships`, not on `app_users.role`) get
  // the same widgets the server's `requireMemberAdmin` already authorises
  // them for. The hard-coded ['org_admin','super_admin'] allow-list silently
  // excluded those roles before this task. The helper consumes the
  // `memberAdminOrgIds` field surfaced on `/auth/me`.
  const isMemberAdminUser = isMemberAdmin(
    user as { role?: string; organizationId?: number | null; memberAdminOrgIds?: number[] | null } | undefined,
    orgId ?? null,
  );

  const activeTournaments = tournaments?.filter(t => t.status === 'active') || [];

  useEffect(() => {
    if (!userLoading && !orgId) {
      const timer = setTimeout(() => {
        queryClient.removeQueries({ queryKey: ['/api/auth/me'] });
        refetchUser();
      }, 3000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [userLoading, orgId, queryClient, refetchUser]);

  if (!userLoading && !orgId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center glass-panel rounded-3xl p-12 max-w-md">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/30 flex items-center justify-center mx-auto mb-6">
            <Trophy className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-2xl font-display font-bold text-white mb-2">{t('settingUp')}</h2>
          <p className="text-muted-foreground mb-6">{t('settingUpDesc')}</p>
          <div className="flex flex-col gap-3">
            <Button
              onClick={() => {
                queryClient.removeQueries({ queryKey: ['/api/auth/me'] });
                refetchUser();
              }}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              <RefreshCw className="w-4 h-4 mr-2" /> {t('refreshNow')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => window.location.href = '/api/logout'}
              className="text-muted-foreground hover:text-white"
            >
              {t('signOut')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-4">{t('retrying')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <header>
        <h1 className="text-3xl font-display font-bold text-white tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('subtitle', { name: user?.organizationName ?? '' })}</p>
      </header>

      {isAdmin && orgId ? <BouncedLevyRemindersBanner orgId={orgId} /> : null}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { label: t('stats.activeEvents'), value: stats?.activeTournaments || 0, icon: Activity, color: 'text-primary', bg: 'bg-primary/10' },
          { label: t('stats.totalPlayers'), value: stats?.totalPlayers || 0, icon: Users, color: 'text-blue-400', bg: 'bg-blue-400/10' },
          { label: t('stats.roundsPlayed'), value: stats?.totalRounds || 0, icon: Target, color: 'text-orange-400', bg: 'bg-orange-400/10' },
          { label: t('stats.totalEvents'), value: stats?.totalTournaments || 0, icon: Trophy, color: 'text-purple-400', bg: 'bg-purple-400/10' },
        ].map((stat, i) => (
          <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}>
            <Card className="glass-card border-none">
              <CardContent className="p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">{stat.label}</p>
                  {statsLoading ? (
                    <div className="h-8 w-16 bg-white/5 animate-pulse rounded" />
                  ) : (
                    <h3 className="text-3xl font-display font-bold text-white">{stat.value}</h3>
                  )}
                </div>
                <div className={`w-12 h-12 rounded-2xl ${stat.bg} flex items-center justify-center`}>
                  <stat.icon className={`w-6 h-6 ${stat.color}`} />
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      <Tabs value={dashTab} onValueChange={setDashTab}>
        <TabsList className="bg-black/40 border border-white/5 p-1 rounded-xl h-auto">
          <TabsTrigger value="overview" className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white px-5 py-2.5 font-semibold">
            {t('tabs.overview')}
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="club-stats" className="rounded-lg data-[state=active]:bg-primary/20 data-[state=active]:text-primary px-5 py-2.5 font-semibold flex items-center gap-2">
              <Medal className="w-4 h-4" /> {t('tabs.clubStats')}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="analytics" className="rounded-lg data-[state=active]:bg-blue-500/20 data-[state=active]:text-blue-400 px-5 py-2.5 font-semibold flex items-center gap-2">
              <BarChart2 className="w-4 h-4" /> {t('tabs.analytics')}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-display font-semibold text-white">{t('liveEvents')}</h2>
                <Link href="/tournaments">
                  <Button variant="outline" size="sm" className="border-white/10 hover:bg-white/5">
                    {t('viewAll')} <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </Link>
              </div>

              <div className="space-y-4">
                {activeTournaments.length === 0 ? (
                  <Card className="glass-panel p-8 text-center border-dashed">
                    <Trophy className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
                    <p className="text-white font-medium">{t('noActiveTournaments')}</p>
                    <p className="text-sm text-muted-foreground mt-1 mb-4">{t('noActiveTournamentsDesc')}</p>
                    <Link href="/tournaments">
                      <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">{t('createTournament')}</Button>
                    </Link>
                  </Card>
                ) : (
                  activeTournaments.map(tournament => (
                    <motion.div key={tournament.id} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}>
                      <Card className="glass-card border-none hover:bg-white/5 transition-colors cursor-pointer">
                        <CardContent className="p-5">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <Badge className="bg-primary/20 text-primary border-primary/30 text-xs uppercase tracking-wide">
                                  {t('live')}
                                </Badge>
                                <Badge variant="outline" className="border-white/10 text-muted-foreground text-xs">
                                  {tournament.format?.replace(/_/g, ' ')}
                                </Badge>
                              </div>
                              <h3 className="text-base font-semibold text-white truncate">{tournament.name}</h3>
                              <p className="text-sm text-muted-foreground mt-0.5">
                                {tournament.startDate ? new Date(tournament.startDate).toLocaleDateString(i18n.language || undefined, { month: 'short', day: 'numeric' }) : t('tbd')}
                                {tournament.endDate && tournament.endDate !== tournament.startDate ? ` – ${new Date(tournament.endDate).toLocaleDateString(i18n.language || undefined, { month: 'short', day: 'numeric' })}` : ''}
                              </p>
                            </div>
                            <Link href={`/tournaments/${tournament.id}`}>
                              <Button size="sm" variant="outline" className="border-white/10 hover:bg-white/5 shrink-0">
                                {t('view')} <ArrowRight className="w-3.5 h-3.5 ml-1" />
                              </Button>
                            </Link>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-6">
              <Card className="glass-card border-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-white text-base flex items-center gap-2">
                    <Activity className="w-4 h-4 text-primary" />
                    {t('quickLinks.title')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {[
                    { href: '/tournaments', label: t('quickLinks.allTournaments'), icon: Trophy },
                    { href: '/courses', label: t('quickLinks.courses'), icon: Map },
                    { href: '/stats', label: t('quickLinks.clubStats'), icon: TrendingUp },
                  ].map(link => (
                    <Link key={link.href} href={link.href}>
                      <div className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
                        <link.icon className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm text-white">{link.label}</span>
                        <ArrowRight className="w-3.5 h-3.5 text-muted-foreground ml-auto" />
                      </div>
                    </Link>
                  ))}
                </CardContent>
              </Card>

              {orgId ? <LevyTotalsWidget orgId={orgId} /> : null}

              {orgId ? <SideGameReceiptFailuresWidget orgId={orgId} /> : null}

              {orgId ? <SideGameReceiptDigestSchedulePanel orgId={orgId} /> : null}

              {orgId ? <WalletWithdrawalNotifyFailuresWidget orgId={orgId} /> : null}

              {isMemberAdminUser && orgId ? <StuckErasureBacklogWidget orgId={orgId} /> : null}

              {isMemberAdminUser && orgId ? <PrivacyRequestsWidget orgId={orgId} currentUserId={(user as { id?: number })?.id} /> : null}

              {isMemberAdminUser && orgId ? <ExpiringReminderStatsWidget orgId={orgId} /> : null}

              {isMemberAdminUser && orgId ? <StalledExpiringReminderWidget orgId={orgId} /> : null}
            </div>
          </div>
        </TabsContent>

        {isAdmin && (
          <TabsContent value="club-stats" className="mt-6">
            {orgId ? <ClubStatsTab orgId={orgId} /> : null}
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="analytics" className="mt-6">
            {orgId ? <AnalyticsTab orgId={orgId} /> : null}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
