// Task #2044 — Practice cohorts dashboard: tip-driven vs manual A/B,
// per-club + per-player breakdown, filterable by clubKey + date range.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Activity, Target, Users, Calendar, Filter } from 'lucide-react';
import { useGetMe } from '@workspace/api-client-react';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const GOLD = '#C9A84C';
const TIP_COLOR = '#C9A84C';
const MANUAL_COLOR = '#6B7280';

// Mirrors server PRACTICE_DISTANCE_YARDS_BY_CLUB so the dropdown matches the API.
const CLUB_KEY_OPTIONS: { value: string; label: string }[] = [
  { value: 'driver', label: 'Driver' },
  { value: '3w', label: '3 wood' },
  { value: '5w', label: '5 wood' },
  { value: '7w', label: '7 wood' },
  { value: '2h', label: '2 hybrid' },
  { value: '3h', label: '3 hybrid' },
  { value: '4h', label: '4 hybrid' },
  { value: '5h', label: '5 hybrid' },
  { value: '3i', label: '3 iron' },
  { value: '4i', label: '4 iron' },
  { value: '5i', label: '5 iron' },
  { value: '6i', label: '6 iron' },
  { value: '7i', label: '7 iron' },
  { value: '8i', label: '8 iron' },
  { value: '9i', label: '9 iron' },
  { value: 'pw', label: 'Pitching wedge' },
  { value: 'gw', label: 'Gap wedge' },
  { value: 'sw', label: 'Sand wedge' },
  { value: 'lw', label: 'Lob wedge' },
];

function clubKeyLabel(key: string): string {
  return CLUB_KEY_OPTIONS.find(o => o.value === key)?.label ?? key.toUpperCase();
}

function isoToInputDate(iso: string): string {
  return iso.slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: isoToInputDate(past.toISOString()), to: isoToInputDate(now.toISOString()) };
}

interface CohortSummary {
  tipDrivenSessions: number;
  manualSessions: number;
  totalSessions: number;
  distinctTipPlayers: number;
  distinctManualPlayers: number;
  tipShareOfPracticePct: number | null;
  // Sample size = (player, club) row count; AvgImprovementFt positive = closer to pin.
  tipCohortPlayerClubs: number;
  manualCohortPlayerClubs: number;
  tipCohortAvgImprovementFt: number | null;
  manualCohortAvgImprovementFt: number | null;
}

interface CohortClubRow {
  clubKey: string;
  tipDrivenSessions: number;
  manualSessions: number;
  // Per-club mean proximity improvement (ft) within each cohort; *Players = sample size.
  tipCohortPlayers: number;
  manualCohortPlayers: number;
  tipCohortMeanImprovementFt: number | null;
  manualCohortMeanImprovementFt: number | null;
}

interface CohortTimelineRow {
  weekStart: string;
  tipDrivenSessions: number;
  manualSessions: number;
}

interface CohortPlayerRow {
  userId: number;
  displayName: string;
  tipDrivenSessions: number;
  manualSessions: number;
  distinctTipClubKeys: string[];
  tipShareOfPracticePct: number | null;
}

interface AdminCohortResponse {
  organizationId: number;
  windowStart: string;
  windowEnd: string;
  clubKeyFilter: string | null;
  summary: CohortSummary;
  byClub: CohortClubRow[];
  timeline: CohortTimelineRow[];
  byPlayer: CohortPlayerRow[];
}

export default function PracticeCohortsPage() {
  const { data: me } = useGetMe();
  const activeOrgId = useActiveOrgId();

  const init = defaultRange();
  const [fromDate, setFromDate] = useState(init.from);
  const [toDate, setToDate] = useState(init.to);
  const [clubKeyFilter, setClubKeyFilter] = useState<string>('');

  // Guard transient empty/partial <input type="date"> states.
  const safeIso = (raw: string, end: boolean): string | null => {
    if (!raw || raw.length < 10) return null;
    const d = new Date(`${raw}T${end ? '23:59:59' : '00:00:00'}`);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  };
  const fromIso = useMemo(() => safeIso(fromDate, false), [fromDate]);
  const toIso = useMemo(() => safeIso(toDate, true), [toDate]);

  const isAuthorisedRole =
    me?.role === 'super_admin' || me?.role === 'org_admin' || me?.role === 'tournament_director';

  const cohortQuery = useQuery<AdminCohortResponse>({
    queryKey: ['admin-practice-cohort', activeOrgId, fromIso, toIso, clubKeyFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ from: fromIso!, to: toIso! });
      if (clubKeyFilter) params.set('clubKey', clubKeyFilter);
      if (activeOrgId) params.set('orgId', String(activeOrgId));
      const res = await fetch(`${BASE_URL}/api/portal/admin/practice/cohort-stats?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!me && isAuthorisedRole && !!activeOrgId && !!fromIso && !!toIso,
  });

  if (!me) {
    return (
      <div className="p-8 text-muted-foreground" data-testid="practice-cohorts-loading">Loading…</div>
    );
  }

  if (!isAuthorisedRole) {
    return (
      <div className="p-8 text-center" data-testid="practice-cohorts-forbidden">
        <p className="text-white font-medium">Restricted</p>
        <p className="text-sm text-muted-foreground mt-1">
          Practice cohort analytics are available to org admins, tournament directors, and super admins.
        </p>
      </div>
    );
  }

  if (!activeOrgId) {
    return (
      <div className="p-8 text-center" data-testid="practice-cohorts-no-org">
        <p className="text-muted-foreground">Select a club to view practice cohort analytics.</p>
      </div>
    );
  }

  const data = cohortQuery.data;
  const summary = data?.summary;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" data-testid="practice-cohorts-page">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Activity className="w-5 h-5" style={{ color: GOLD }} /> Practice cohorts
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Did practice that started from a coaching tip close the proximity gap faster than ad-hoc range time?
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <Card className="glass-card border-none" data-testid="practice-cohorts-filters">
        <CardContent className="pt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1 flex items-center gap-1">
              <Calendar className="w-3 h-3" /> From
            </label>
            <input
              type="date"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              data-testid="practice-cohorts-from"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#C9A84C]/50"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1 flex items-center gap-1">
              <Calendar className="w-3 h-3" /> To
            </label>
            <input
              type="date"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              data-testid="practice-cohorts-to"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#C9A84C]/50"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1 flex items-center gap-1">
              <Filter className="w-3 h-3" /> Club
            </label>
            <select
              value={clubKeyFilter}
              onChange={e => setClubKeyFilter(e.target.value)}
              data-testid="practice-cohorts-club-filter"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#C9A84C]/50"
            >
              <option value="">All clubs</option>
              {CLUB_KEY_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {cohortQuery.isLoading && (
        <Card className="glass-card border-none">
          <CardContent className="py-10 text-center text-muted-foreground" data-testid="practice-cohorts-loading-data">
            Loading practice cohort data…
          </CardContent>
        </Card>
      )}

      {cohortQuery.isError && (
        <Card className="glass-card border-none border-red-500/30">
          <CardContent className="py-6 text-center text-red-300" data-testid="practice-cohorts-error">
            Failed to load cohort analytics. Please try again.
          </CardContent>
        </Card>
      )}

      {summary && (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="practice-cohorts-summary">
            <Card className="glass-card border-none p-4">
              <p className="text-xs text-muted-foreground">Tip-driven sessions</p>
              <p className="text-2xl font-bold text-white mt-1" data-testid="summary-tip-driven">
                {summary.tipDrivenSessions.toLocaleString()}
              </p>
              <p className="text-xs text-amber-300 mt-1">{summary.distinctTipPlayers} players</p>
            </Card>
            <Card className="glass-card border-none p-4">
              <p className="text-xs text-muted-foreground">Manual sessions</p>
              <p className="text-2xl font-bold text-white mt-1" data-testid="summary-manual">
                {summary.manualSessions.toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{summary.distinctManualPlayers} players</p>
            </Card>
            <Card className="glass-card border-none p-4">
              <p className="text-xs text-muted-foreground">Tip share of practice</p>
              <p className="text-2xl font-bold mt-1" style={{ color: GOLD }} data-testid="summary-tip-share">
                {summary.tipShareOfPracticePct !== null
                  ? `${summary.tipShareOfPracticePct.toFixed(1)}%`
                  : '—'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">of {summary.totalSessions} sessions</p>
            </Card>
            <Card className="glass-card border-none p-4">
              <p className="text-xs text-muted-foreground">Window</p>
              <p className="text-sm font-medium text-white mt-1">
                {data!.windowStart.slice(0, 10)} → {data!.windowEnd.slice(0, 10)}
              </p>
              {data!.clubKeyFilter && (
                <Badge className="mt-2 bg-amber-400/15 text-amber-300 border-0 text-xs">
                  {clubKeyLabel(data!.clubKeyFilter)}
                </Badge>
              )}
            </Card>
          </div>

          {/* Task #2044 — Org-wide A/B headline. Each (player, club) row
              is assigned to the cohort whose source dominated their
              practice for that club; the means here aggregate proximity
              improvement (ft) across those rows. */}
          {(summary.tipCohortPlayerClubs > 0 || summary.manualCohortPlayerClubs > 0) && (
            <Card className="glass-card border-none" data-testid="practice-cohorts-ab-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                  <Target className="w-4 h-4" style={{ color: GOLD }} /> Tip-driven vs Manual proximity gain
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center p-4 bg-white/5 rounded-lg border border-amber-400/20" data-testid="practice-cohorts-ab-tip">
                    <p className="text-xs text-muted-foreground">Tip-driven cohort</p>
                    <p
                      className={`text-3xl font-bold mt-2 ${
                        summary.tipCohortAvgImprovementFt !== null && summary.tipCohortAvgImprovementFt > 0
                          ? 'text-emerald-400'
                          : summary.tipCohortAvgImprovementFt !== null && summary.tipCohortAvgImprovementFt < 0
                            ? 'text-red-400'
                            : 'text-white'
                      }`}
                      data-testid="practice-cohorts-ab-tip-value"
                    >
                      {summary.tipCohortAvgImprovementFt === null
                        ? '—'
                        : summary.tipCohortAvgImprovementFt > 0
                          ? `−${summary.tipCohortAvgImprovementFt.toFixed(1)} ft`
                          : summary.tipCohortAvgImprovementFt < 0
                            ? `+${Math.abs(summary.tipCohortAvgImprovementFt).toFixed(1)} ft`
                            : 'no change'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      avg proximity improvement · {summary.tipCohortPlayerClubs} player×club row{summary.tipCohortPlayerClubs === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="text-center p-4 bg-white/5 rounded-lg border border-white/10" data-testid="practice-cohorts-ab-manual">
                    <p className="text-xs text-muted-foreground">Manual cohort</p>
                    <p
                      className={`text-3xl font-bold mt-2 ${
                        summary.manualCohortAvgImprovementFt !== null && summary.manualCohortAvgImprovementFt > 0
                          ? 'text-emerald-400'
                          : summary.manualCohortAvgImprovementFt !== null && summary.manualCohortAvgImprovementFt < 0
                            ? 'text-red-400'
                            : 'text-white'
                      }`}
                      data-testid="practice-cohorts-ab-manual-value"
                    >
                      {summary.manualCohortAvgImprovementFt === null
                        ? '—'
                        : summary.manualCohortAvgImprovementFt > 0
                          ? `−${summary.manualCohortAvgImprovementFt.toFixed(1)} ft`
                          : summary.manualCohortAvgImprovementFt < 0
                            ? `+${Math.abs(summary.manualCohortAvgImprovementFt).toFixed(1)} ft`
                            : 'no change'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      avg proximity improvement · {summary.manualCohortPlayerClubs} player×club row{summary.manualCohortPlayerClubs === 1 ? '' : 's'}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-3 text-center">
                  Improvement = prior-window mean proximity − current-window mean proximity. Positive means players got closer to the pin.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Weekly volume chart */}
          <Card className="glass-card border-none" data-testid="practice-cohorts-timeline-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                <Activity className="w-4 h-4" style={{ color: GOLD }} /> Weekly practice volume
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data!.timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6" data-testid="practice-cohorts-timeline-empty">
                  No practice sessions in the selected window.
                </p>
              ) : (
                <div style={{ width: '100%', height: 280 }}>
                  <ResponsiveContainer>
                    <BarChart data={data!.timeline} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                      <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="weekStart" stroke="rgba(255,255,255,0.5)" fontSize={11} />
                      <YAxis stroke="rgba(255,255,255,0.5)" fontSize={11} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{ background: '#0d1117', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6 }}
                        labelStyle={{ color: '#fff' }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="tipDrivenSessions" name="Tip-driven" stackId="a" fill={TIP_COLOR} />
                      <Bar dataKey="manualSessions" name="Manual" stackId="a" fill={MANUAL_COLOR} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Per-club breakdown */}
          <Card className="glass-card border-none" data-testid="practice-cohorts-by-club-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                <Target className="w-4 h-4" style={{ color: GOLD }} /> Sessions by club
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data!.byClub.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6" data-testid="practice-cohorts-by-club-empty">
                  No club-tagged sessions in the selected window.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="practice-cohorts-by-club-table">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b border-white/10">
                        <th className="px-3 py-2">Club</th>
                        <th className="px-3 py-2 text-right">Tip-driven</th>
                        <th className="px-3 py-2 text-right">Manual</th>
                        <th className="px-3 py-2 text-right">Total</th>
                        {/* Task #2044 — per-club A/B columns. Mean
                            proximity improvement (ft) for the players
                            whose practice for this club was dominated
                            by each source; positive = closer to pin. */}
                        <th className="px-3 py-2 text-right">Tip Δ (ft)</th>
                        <th className="px-3 py-2 text-right">Manual Δ (ft)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.byClub.map(row => {
                        const fmt = (v: number | null, n: number) => {
                          if (v === null || n === 0) return <span className="text-muted-foreground">—</span>;
                          const positive = v > 0;
                          const negative = v < 0;
                          const display = positive
                            ? `−${v.toFixed(1)}`
                            : negative
                              ? `+${Math.abs(v).toFixed(1)}`
                              : '0.0';
                          return (
                            <span
                              className={positive ? 'text-emerald-400' : negative ? 'text-red-400' : 'text-white'}
                              title={`n=${n} player${n === 1 ? '' : 's'}`}
                            >
                              {display}
                            </span>
                          );
                        };
                        return (
                          <tr
                            key={row.clubKey}
                            className="border-b border-white/5 hover:bg-white/5"
                            data-testid={`practice-cohorts-by-club-row-${row.clubKey}`}
                          >
                            <td className="px-3 py-2 text-white">{clubKeyLabel(row.clubKey)}</td>
                            <td className="px-3 py-2 text-right text-amber-300">{row.tipDrivenSessions}</td>
                            <td className="px-3 py-2 text-right text-muted-foreground">{row.manualSessions}</td>
                            <td className="px-3 py-2 text-right text-white">
                              {row.tipDrivenSessions + row.manualSessions}
                            </td>
                            <td
                              className="px-3 py-2 text-right"
                              data-testid={`practice-cohorts-by-club-row-${row.clubKey}-tip-delta`}
                            >
                              {fmt(row.tipCohortMeanImprovementFt, row.tipCohortPlayers)}
                            </td>
                            <td
                              className="px-3 py-2 text-right"
                              data-testid={`practice-cohorts-by-club-row-${row.clubKey}-manual-delta`}
                            >
                              {fmt(row.manualCohortMeanImprovementFt, row.manualCohortPlayers)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Per-player breakdown */}
          <Card className="glass-card border-none" data-testid="practice-cohorts-by-player-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                <Users className="w-4 h-4" style={{ color: GOLD }} /> Per-player engagement
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data!.byPlayer.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6" data-testid="practice-cohorts-by-player-empty">
                  No players logged practice in the selected window.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="practice-cohorts-by-player-table">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b border-white/10">
                        <th className="px-3 py-2">Player</th>
                        <th className="px-3 py-2 text-right">Tip-driven</th>
                        <th className="px-3 py-2 text-right">Manual</th>
                        <th className="px-3 py-2 text-right">Tip share</th>
                        <th className="px-3 py-2">Tip clubs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.byPlayer.map(row => (
                        <tr
                          key={row.userId}
                          className="border-b border-white/5 hover:bg-white/5"
                          data-testid={`practice-cohorts-by-player-row-${row.userId}`}
                        >
                          <td className="px-3 py-2 text-white">{row.displayName}</td>
                          <td className="px-3 py-2 text-right text-amber-300">{row.tipDrivenSessions}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{row.manualSessions}</td>
                          <td className="px-3 py-2 text-right text-white">
                            {row.tipShareOfPracticePct !== null
                              ? `${row.tipShareOfPracticePct.toFixed(1)}%`
                              : '—'}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {row.distinctTipClubKeys.length === 0
                              ? '—'
                              : row.distinctTipClubKeys.map(clubKeyLabel).join(', ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => cohortQuery.refetch()}
          data-testid="practice-cohorts-refresh"
          disabled={cohortQuery.isFetching}
        >
          {cohortQuery.isFetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
    </div>
  );
}
