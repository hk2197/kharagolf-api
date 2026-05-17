import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine, ReferenceDot,
  DefaultLegendContent,
} from 'recharts';
import { motion } from 'framer-motion';
import {
  Target, Activity, TrendingUp, Award, Wifi, WifiOff, Trash2,
  Star, Zap, Users, BarChart3, Flag, Dumbbell, Plus, X, ChevronDown, Clock,
  GitCompare, Search, Edit2, Check, MapPin,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

const SCORE_COLORS = {
  eagles: '#f59e0b',
  birdies: '#22c55e',
  pars: '#3b82f6',
  bogeys: '#f97316',
  doublePlus: '#ef4444',
};

const BADGE_CATEGORY_COLORS: Record<string, string> = {
  milestone: 'bg-purple-500/20 border-purple-500/40 text-purple-300',
  scoring: 'bg-green-500/20 border-green-500/40 text-green-300',
  consistency: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
  social: 'bg-yellow-500/20 border-yellow-500/40 text-yellow-300',
  seasonal: 'bg-orange-500/20 border-orange-500/40 text-orange-300',
};

const WEARABLE_PROVIDERS = [
  { id: 'garmin', label: 'Garmin Connect', icon: '⌚', description: 'Auto-sync from your Garmin GPS watch' },
  { id: 'apple_watch', label: 'Apple Watch', icon: '🍎', description: 'Sync from Apple Health / Watch app' },
  { id: 'fitbit', label: 'Fitbit / Google Fit', icon: '💪', description: 'Import wellness and step data' },
  { id: 'arccos', label: 'Arccos Caddie', icon: '📡', description: 'Automatic shot tracking from Arccos sensors' },
  { id: 'gpx', label: 'GPX Upload', icon: '🗺️', description: 'Import GPX files from any GPS device' },
];

interface RoundSGDetail {
  tournamentId: number; round: number;
  sgPutting: number | null; sgApproach: number | null; sgATG: number | null;
  sgOTT: number | null; sgTotal: number | null;
  hasTrackingData: boolean;
}

interface StrokesGained {
  sgPutting: number | null;
  sgApproach: number | null;
  sgATG: number | null;
  sgOffTheTee: number | null;
  sgTotal: number | null;
  trackedRounds: number;
  baseline: string;
  roundDetail: RoundSGDetail[];
  sgPuttingMeasuredRounds?: number;
  sgPuttingEstimatedRounds?: number;
  // Task #1643 — auto-pick + pin-override metadata mirroring the
  // proximity-by-club card. `preferredBaseline` is what the player has
  // pinned (or "auto"), `primaryBaseline` is what was actually used to
  // compute the numbers, and `baselineSource` lets us pick the right
  // copy ("Auto-picked from your 12.4 handicap" vs "Pinned to 10-hcp").
  preferredBaseline?: 'auto' | 'scratch' | '10' | '18';
  primaryBaseline?: 'scratch' | '10' | '18';
  baselineSource?: 'preference' | 'handicap' | 'default';
  handicapIndex?: number | null;
  // Task #2048 — one-time "your benchmark moved" notice surfaced when
  // the player is on auto and the handicap-derived cohort has crossed a
  // threshold since their last visit. `null` when there's nothing to
  // flag (player has a pinned preference, no handicap on file, the
  // first-ever fetch we just lazy-seeded, or the cohort hasn't moved).
  baselineChange?: { previousBaseline: 'scratch' | '10' | '18'; currentBaseline: 'scratch' | '10' | '18' } | null;
}

interface PlayerStats {
  roundsPlayed: number;
  scoringAvg: number | null;
  bestRound: number | null;
  worstRound: number | null;
  eagles: number; birdies: number; pars: number; bogeys: number; doublePlus: number;
  fairwayPct: number | null;
  girPct: number | null;
  avgPutts: number | null;
  putting?: { holesTracked: number; onePutts: number; threePlusPutts: number; onePuttPct: number | null; threePlusPuttPct: number | null } | null;
  shortGame?: { sandSavePct: number | null; upAndDownPct: number | null } | null;
  handicapTrend: { handicapIndex: number; recordedAt: string | null; tournamentId: number }[];
  holeAverages: { holeNumber: number; avgStrokes: number | null; avgPar: number | null; avgToPar: number | null; count: number }[];
  recentRounds: { tournamentId: number; round: number; gross: number; par: number; toPar: number; birdies: number; eagles: number; fairwayPct: number | null; girPct: number | null; avgPutts: number | null }[];
  courseBreakdown: { courseId: number; courseName?: string; rounds: number; avgGross: number; bestGross?: number | null }[];
  strokesGained?: StrokesGained | null;
  eventBreakdown?: { tournamentRounds: number; generalPlayRounds: number; tournamentScoringAvg: number | null; generalPlayScoringAvg: number | null } | null;
  period?: string;
  courseId?: number | null;
  playerName?: string | null;
  targetUserId?: number;
}

interface Achievement {
  id: number; badgeType: string; badgeLabel: string; badgeIcon: string; badgeCategory: string;
  earnedAt: string; tournamentId?: number | null; leagueId?: number | null;
}

interface WearableConnection {
  id: number; provider: string; status: string; lastSyncAt: string | null;
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

const CHART_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

type StatsPeriod = 'allTime' | 'thisYear' | 'last5rounds' | 'last10rounds' | 'last12rounds' | 'last20rounds' | 'custom';
type SGBaseline = 'scratch' | '10' | '18';
// Task #1643 — picker also surfaces "auto" so a player can let their handicap
// choose the right baseline (and re-enable auto after pinning).
type SgPickerValue = 'auto' | SGBaseline;

interface OrgMember { userId: number; role: string; displayName: string | null; email: string | null }

// ── Shot Analytics Panel (auto-shot tracking & dispersion charts) ──────────
// Task #1641 — surface a "Log practice" CTA on each "Work on This Club"
// coaching tip. The parent StatsPage owns the practice-tab state, so it
// passes a callback down here that switches tabs and pre-fills the
// practice form with the tip's club + distance band.
export type CoachingTipPracticeRequest = {
  club: string;
  clubKey: string;
  practiceDistanceYards: number | null;
};

export function ShotAnalyticsPanel({
  onLogPracticeFromTip,
}: {
  onLogPracticeFromTip?: (req: CoachingTipPracticeRequest) => void;
} = {}) {
  const { t } = useTranslation('portal');
  type Dispersion = { clubs: { club: string; shots: number; avgCarryYards: number | null; carryStdDev: number | null; leftMissPct: number | null; rightMissPct: number | null; centrePct: number | null }[] };
  type ProxBands = { bands: { band: string; shots: number; avgProximityFt: number | null; greensHit: number; greenInRegPct: number | null }[] };
  type PuttBands = { bands: { band: string; attempts: number; makes: number; makePct: number | null }[] };
  type PrimaryBaseline = 'tour' | 'scratch' | 'mid';
  type PreferredBaseline = PrimaryBaseline | 'auto';
  type BaselineSource = 'preference' | 'handicap' | 'default';
  // Task #1644 — which of the three sources the handicap was actually read
  // from (or null when no handicap is on file). Used by the "Where this
  // comes from" info row beside the baseline picker.
  type HandicapSource = 'whs' | 'history' | 'profile';
  type ProxByClub = {
    clubs: { club: string; shots: number; meanProximityFt: number | null; p90ProximityFt: number | null; greenInRegPct: number | null; benchmark: { clubKey: string; tourMeanFt: number; scratchMeanFt: number; midHandicapMeanFt: number } | null }[];
    handicapIndex?: number | null;
    handicapSource?: HandicapSource | null;
    handicapAsOf?: string | null;
    preferredBaseline?: PreferredBaseline;
    primaryBaseline?: PrimaryBaseline;
    baselineSource?: BaselineSource;
    // Task #1348 — top 1-2 clubs with the largest gap vs tour proximity benchmark.
    // Task #1640 — each tip now also carries a trend annotation vs the prior
    // 30-day window (`trendVsTourFt`, `trendLabel`, `previousMeanProximityFt`).
    // Task #2039 — each tip also carries a 6-bucket weekly gap-vs-tour
    // sparkline (`weeklyGapHistory`) so the trend label gets visual context.
    coachingTips?: {
      club: string;
      clubKey: string;
      shots: number;
      meanProximityFt: number;
      tourMeanFt: number;
      scratchMeanFt: number;
      midHandicapMeanFt: number;
      gapVsTourFt: number;
      gapVsScratchFt: number;
      practiceDistanceYards: number | null;
      aimLongFt: number;
      message: string;
      caddieHint: string;
      previousMeanProximityFt: number | null;
      trendVsTourFt: number | null;
      trendLabel: string | null;
      weeklyGapHistory: {
        weekStart: string;
        shots: number;
        meanProximityFt: number | null;
        gapVsTourFt: number | null;
      }[] | null;
    }[];
  };
  type WeatherBucketRow = { label: string; min: number; max: number; rounds: number; meanSgTotal: number | null; sgDelta: number | null };
  type WeatherCorr = {
    windowDays: number;
    baselineSgTotal: number | null;
    baselineRoundCount: number;
    windBuckets: WeatherBucketRow[];
    temperatureBuckets: WeatherBucketRow[];
    // Task #1347 — humidity & precipitation buckets join wind & temperature.
    humidityBuckets: WeatherBucketRow[];
    precipitationBuckets: WeatherBucketRow[];
    temperatureAvailable: boolean;
    humidityAvailable: boolean;
    precipitationAvailable: boolean;
    // Task #1613 — rounds in the window with no resolved temperature yet
    // (Open-Meteo archive lags by ~5 days). Surfaced as a hint on the chart.
    pendingRoundsCount: number;
    // Task #2003 — same idea for wind. Wind doesn't get the persisted
    // caddie-reading override that temperature does, so it's tracked
    // separately and powers the matching hint on the wind card.
    pendingWindRoundsCount: number;
  };

  // Task #1609 — visually de-emphasise weather buckets backed by very few rounds
  // so a single freak round in e.g. "Heavy rain" doesn't read as a real trend.
  // Tooltips still surface the raw numbers; only the bar opacity + a small caption change.
  const MIN_TRUSTWORTHY_ROUNDS = 3;
  const renderLimitedSampleNote = (buckets: WeatherBucketRow[]) => {
    const limited = buckets.filter(b => b.rounds > 0 && b.rounds < MIN_TRUSTWORTHY_ROUNDS);
    if (limited.length === 0) return null;
    return (
      <p className="text-[11px] text-muted-foreground mt-2" data-testid="weather-limited-sample">
        Limited sample (faded bars): {limited.map(b => `${b.label} (${b.rounds} round${b.rounds === 1 ? '' : 's'})`).join(', ')}.
      </p>
    );
  };

  // Task #1997 — same idea as the weather charts above, but for shot/putt counts:
  // a make-rate from 1-2 putts or a proximity average from a couple of approach
  // shots wildly swings the bar. Anything below this threshold renders faded
  // and is named in a small caption underneath the chart.
  const MIN_TRUSTWORTHY_SAMPLE = 5;

  const { data: dispersion } = useQuery<Dispersion>({
    queryKey: ['portal-dispersion'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/dispersion`, { credentials: 'include' });
      if (!res.ok) return { clubs: [] };
      return res.json();
    },
  });
  const { data: proxBands } = useQuery<ProxBands>({
    queryKey: ['portal-proximity-bands'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/proximity-bands`, { credentials: 'include' });
      if (!res.ok) return { bands: [] };
      return res.json();
    },
  });
  const { data: putts } = useQuery<PuttBands>({
    queryKey: ['portal-putting-stats'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/putting-stats`, { credentials: 'include' });
      if (!res.ok) return { bands: [] };
      return res.json();
    },
  });
  // Task #1002 — proximity-by-club + weather correlation.
  // Task #1349 — `proxByClub` now also returns the player's pinned baseline,
  // their handicap index, and the auto-derived primary baseline so we can
  // highlight one of {tour, scratch, mid} as "primary" in the chart while
  // leaving the others reachable behind a toggle.
  // Task #1348 — response also carries `coachingTips` (top 1-2 clubs vs tour).
  // Task #2041 — let the player choose how far back the trend annotation on
  // each "Work on This Club" tip looks (30d / 60d / 90d). Players who play
  // less frequently won't have enough shots in either bucket of the default
  // 30-day window, so a 60d/90d toggle gives them a meaningful comparison
  // too. We persist the choice in localStorage so it survives reloads, key
  // it into the React-Query cache so each window has its own slot, and pass
  // it as the `days` query param to the endpoint (which already echoes it
  // back as `windowDays` and into the per-tip `trendLabel`).
  type TrendWindowDays = 30 | 60 | 90;
  const TREND_WINDOW_STORAGE_KEY = 'workOnThisClub.trendWindowDays';
  const [trendWindowDays, setTrendWindowDaysState] = useState<TrendWindowDays>(() => {
    if (typeof window === 'undefined') return 30;
    const raw = window.localStorage.getItem(TREND_WINDOW_STORAGE_KEY);
    const parsed = raw ? parseInt(raw, 10) : 30;
    return parsed === 60 || parsed === 90 ? parsed : 30;
  });
  const setTrendWindowDays = useCallback((days: TrendWindowDays) => {
    setTrendWindowDaysState(days);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(TREND_WINDOW_STORAGE_KEY, String(days)); } catch { /* private mode etc */ }
    }
  }, []);
  const queryClient = useQueryClient();
  const { data: proxByClub } = useQuery<ProxByClub>({
    queryKey: ['portal-proximity-by-club', trendWindowDays],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/player/proximity-by-club?days=${trendWindowDays}`, { credentials: 'include' });
      if (!res.ok) return { clubs: [], coachingTips: [] };
      return res.json();
    },
    // Task #2041 — keep the previous tips visible while the new window's
    // request is in flight so the "Work on This Club" card doesn't blink
    // out and back in when the player toggles between 30d / 60d / 90d.
    placeholderData: keepPreviousData,
  });
  const setBaselinePref = useMutation({
    mutationFn: async (baseline: PreferredBaseline) => {
      const res = await fetch(`${BASE_URL}/api/portal/player/proximity-baseline-preference`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseline }),
      });
      if (!res.ok) throw new Error('Failed to update baseline preference');
      return res.json() as Promise<{ preferredBaseline: PreferredBaseline }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-proximity-by-club'] });
    },
  });

  // Task #2045 — log a "shown" impression once per coaching tip per session.
  //
  // We dedupe per `clubKey` for the lifetime of this panel mount so that
  // a player who scrolls back and forth, switches tabs, or triggers a
  // re-render via an unrelated query refetch doesn't inflate the
  // denominator of the conversion-rate dashboard. The set is held in a
  // ref (not state) so adding to it doesn't itself cause a re-render.
  // Failures are intentionally swallowed: telemetry must never block
  // the panel from rendering.
  const loggedImpressionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const tips = proxByClub?.coachingTips ?? [];
    for (const tip of tips) {
      if (loggedImpressionsRef.current.has(tip.clubKey)) continue;
      loggedImpressionsRef.current.add(tip.clubKey);
      void fetch(`${BASE_URL}/api/portal/coaching-tip-impression`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clubKey: tip.clubKey,
          practiceDistanceYards: tip.practiceDistanceYards,
        }),
      }).catch(() => {
        // Roll back the dedup entry so we'll retry on the next render
        // if the network blip clears.
        loggedImpressionsRef.current.delete(tip.clubKey);
      });
    }
  }, [proxByClub?.coachingTips]);
  const { data: weatherCorr } = useQuery<WeatherCorr>({
    queryKey: ['portal-weather-correlation'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/player/weather-correlation?days=30`, { credentials: 'include' });
      if (!res.ok) return {
        windowDays: 30,
        baselineSgTotal: null,
        baselineRoundCount: 0,
        windBuckets: [],
        temperatureBuckets: [],
        humidityBuckets: [],
        precipitationBuckets: [],
        temperatureAvailable: false,
        humidityAvailable: false,
        precipitationAvailable: false,
        pendingRoundsCount: 0,
        pendingWindRoundsCount: 0,
      };
      return res.json();
    },
  });

  const dispersionData = (dispersion?.clubs ?? []).filter(c => c.shots >= 3 && c.avgCarryYards !== null).map(c => ({
    club: c.club,
    avgCarry: c.avgCarryYards ?? 0,
    stdDev: c.carryStdDev ?? 0,
    leftPct: c.leftMissPct ?? 0,
    centrePct: c.centrePct ?? 0,
    rightPct: c.rightMissPct ?? 0,
    shots: c.shots,
  }));

  return (
    <div className="space-y-6">
      <Card className="glass-card border-none">
        <CardHeader>
          <CardTitle className="text-white text-base">Club Dispersion</CardTitle>
          <p className="text-xs text-muted-foreground">Average carry distance and ±1 standard deviation per club. Bars show miss-direction split.</p>
        </CardHeader>
        <CardContent>
          {dispersionData.length === 0 ? (
            <p className="text-sm text-muted-foreground">Track at least 3 shots per club to see dispersion data.</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(220, dispersionData.length * 32)}>
              <BarChart data={dispersionData} layout="vertical" margin={{ left: 50 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis type="number" stroke="rgba(255,255,255,0.6)" />
                <YAxis dataKey="club" type="category" stroke="rgba(255,255,255,0.7)" width={80} />
                <Tooltip
                  contentStyle={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.2)' }}
                  formatter={(v: number, name: string) => [`${v.toFixed(1)}${name === 'avgCarry' || name === 'stdDev' ? ' yds' : '%'}`, name]}
                />
                <Legend />
                <Bar dataKey="avgCarry" name="Avg Carry (yds)" fill="#84cc16" />
                <Bar dataKey="stdDev" name="Std Dev (yds)" fill="#fbbf24" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card className="glass-card border-none">
        <CardHeader>
          <CardTitle className="text-white text-base">Approach Proximity by Distance Band</CardTitle>
          <p className="text-xs text-muted-foreground">Average distance to the pin (feet) after the approach, plus green-in-regulation %.</p>
        </CardHeader>
        <CardContent>
          {(proxBands?.bands ?? []).every(b => b.shots === 0) ? (
            <p className="text-sm text-muted-foreground">No approach shots tracked yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={(proxBands?.bands ?? []).map(b => ({ ...b, prox: b.avgProximityFt ?? 0, gir: b.greenInRegPct ?? 0 }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis dataKey="band" stroke="rgba(255,255,255,0.6)" />
                <YAxis yAxisId="left" stroke="rgba(255,255,255,0.6)" label={{ value: 'Avg Prox (ft)', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.6)' }} />
                <YAxis yAxisId="right" orientation="right" stroke="rgba(255,255,255,0.6)" label={{ value: 'GIR %', angle: 90, position: 'insideRight', fill: 'rgba(255,255,255,0.6)' }} />
                <Tooltip contentStyle={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.2)' }} />
                <Legend />
                <Bar yAxisId="left" dataKey="prox" name="Proximity (ft)" fill="#60a5fa" />
                <Bar yAxisId="right" dataKey="gir" name="GIR %" fill="#84cc16" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Task #1002 — Proximity by Club (Task #1168 — adds tour benchmark marker) */}
      {/* Task #1349 — pick the "primary" benchmark to highlight (tour vs scratch
          vs mid-handicap) based on the player's handicap, with the others
          available behind a toggle. */}
      <Card className="glass-card border-none">
        <CardHeader>
          <CardTitle className="text-white text-base">Proximity to Pin by Club</CardTitle>
          <p className="text-xs text-muted-foreground">
            Your mean (blue) and 90th-percentile (amber) proximity per club, compared
            against your chosen benchmark — the dot on each row marks that benchmark&apos;s
            mean for the club, so the closer your blue bar reaches the dot, the tighter
            you are versus that cohort.
          </p>
        </CardHeader>
        <CardContent>
          {(() => {
            const items = (proxByClub?.clubs ?? []).filter(c => c.shots >= 3);
            const primary: PrimaryBaseline = proxByClub?.primaryBaseline ?? 'tour';
            const preferred: PreferredBaseline = proxByClub?.preferredBaseline ?? 'auto';
            const source: BaselineSource = proxByClub?.baselineSource ?? 'default';
            const hi = proxByClub?.handicapIndex ?? null;
            // Task #1644 — explain which of the three sources the handicap
            // came from + how stale it is, so a player whose number is wrong
            // knows exactly where to fix it (WHS, log a round, or profile).
            const handicapSource: HandicapSource | null = proxByClub?.handicapSource ?? null;
            const handicapAsOf = proxByClub?.handicapAsOf ?? null;
            const baselineConfig: Record<PrimaryBaseline, { label: string; field: 'tourMeanFt' | 'scratchMeanFt' | 'midHandicapMeanFt'; color: string }> = {
              tour: { label: 'PGA Tour', field: 'tourMeanFt', color: '#22c55e' },
              scratch: { label: 'Scratch', field: 'scratchMeanFt', color: '#a855f7' },
              mid: { label: 'Mid-handicap', field: 'midHandicapMeanFt', color: '#38bdf8' },
            };
            const primaryConfig = baselineConfig[primary];
            const sourceCopy =
              preferred !== 'auto' ? `Pinned to ${primaryConfig.label}.`
              : source === 'handicap' && hi !== null ? `Auto-picked from your ${hi.toFixed(1)} handicap.`
              : 'Default comparison (no handicap on file yet).';
            // Task #1644 — friendly label per source + the page where players
            // can update that source if the number looks wrong.
            const handicapSourceMeta: Record<HandicapSource, { label: string; fix: string; href: string }> = {
              whs: {
                label: t('provenance.source_whs'),
                fix: t('provenance.fix_whs'),
                href: '/handicap-profile',
              },
              history: {
                label: t('provenance.source_history'),
                fix: t('provenance.fix_history'),
                href: '/general-play',
              },
              profile: {
                label: t('provenance.source_profile'),
                fix: t('provenance.fix_profile'),
                href: '/handicap-profile',
              },
            };
            const fmtAsOf = (iso: string | null): string | null => {
              if (!iso) return null;
              const ms = new Date(iso).getTime();
              if (!Number.isFinite(ms)) return null;
              const days = Math.max(0, Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000)));
              if (days === 0) return t('provenance.asOfToday');
              if (days === 1) return t('provenance.asOfYesterday');
              if (days < 30) return t('provenance.asOfDays', { count: days });
              const months = Math.floor(days / 30);
              if (months < 12) return t(months === 1 ? 'provenance.asOfMonth' : 'provenance.asOfMonths', { count: months });
              const years = Math.floor(days / 365);
              return t(years === 1 ? 'provenance.asOfYear' : 'provenance.asOfYears', { count: years });
            };
            const sourceMeta = handicapSource ? handicapSourceMeta[handicapSource] : null;
            const asOfLabel = fmtAsOf(handicapAsOf);
            const provenance = (
              <div
                className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground"
                data-testid="proximity-handicap-provenance"
              >
                <span className="font-medium text-white/70">{t('provenance.label')}</span>
                {sourceMeta && hi !== null ? (
                  <>
                    <span>
                      {asOfLabel
                        ? t('provenance.summaryWithAsOf', {
                            handicap: hi.toFixed(1),
                            source: sourceMeta.label,
                            asOf: asOfLabel,
                          })
                        : t('provenance.summary', {
                            handicap: hi.toFixed(1),
                            source: sourceMeta.label,
                          })}
                    </span>
                    <a
                      href={sourceMeta.href}
                      className="text-amber-300 hover:text-amber-200 underline-offset-2 hover:underline"
                    >
                      {sourceMeta.fix}
                    </a>
                  </>
                ) : (
                  <>
                    {/* Only mention "default comparison" when the chart is
                        actually using the default — a pinned baseline takes
                        precedence over the handicap-derived one, so the
                        "default" framing would be misleading there. */}
                    <span>
                      {preferred === 'auto'
                        ? t('provenance.noneAuto')
                        : t('provenance.nonePinned')}
                    </span>
                    <a
                      href="/handicap-profile"
                      className="text-amber-300 hover:text-amber-200 underline-offset-2 hover:underline"
                    >
                      {t('provenance.fix_default')}
                    </a>
                  </>
                )}
              </div>
            );
            const picker = (
              <div className="mb-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Compare against:</span>
                  {(['auto', 'tour', 'scratch', 'mid'] as const).map(opt => {
                    const isActive = preferred === opt;
                    const label = opt === 'auto' ? 'Auto' : baselineConfig[opt].label;
                    return (
                      <button
                        key={opt}
                        type="button"
                        disabled={setBaselinePref.isPending || isActive}
                        onClick={() => setBaselinePref.mutate(opt)}
                        className={`rounded-full border px-3 py-1 transition-colors ${
                          isActive
                            ? 'border-amber-400/60 bg-amber-400/15 text-amber-200'
                            : 'border-white/10 bg-white/5 text-white/70 hover:border-white/30 hover:text-white'
                        } disabled:cursor-not-allowed`}
                        aria-pressed={isActive}
                        aria-label={`Set proximity baseline to ${label}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                  <span className="ml-1 text-muted-foreground">{sourceCopy}</span>
                </div>
                {provenance}
              </div>
            );
            if (items.length === 0) {
              return (
                <>
                  {picker}
                  <p className="text-sm text-muted-foreground">Track at least 3 approach shots per club to see proximity-by-club data.</p>
                </>
              );
            }
            const data = items.map(c => {
              const primaryFt = c.benchmark ? c.benchmark[primaryConfig.field] : null;
              return {
                club: c.club,
                mean: c.meanProximityFt ?? 0,
                p90: c.p90ProximityFt ?? 0,
                tour: c.benchmark?.tourMeanFt ?? null,
                scratch: c.benchmark?.scratchMeanFt ?? null,
                mid: c.benchmark?.midHandicapMeanFt ?? null,
                primaryFt,
                gap: primaryFt !== null && c.meanProximityFt !== null
                  ? Math.round((c.meanProximityFt - primaryFt) * 10) / 10
                  : null,
                shots: c.shots,
                gir: c.greenInRegPct ?? 0,
              };
            });
            const anyBenchmark = data.some(d => d.primaryFt !== null);
            return (
              <>
                {picker}
                <ResponsiveContainer width="100%" height={Math.max(260, items.length * 38)}>
                  <BarChart data={data} layout="vertical" margin={{ left: 50 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                    <XAxis
                      type="number"
                      stroke="rgba(255,255,255,0.6)"
                      label={{ value: 'Proximity (ft)', position: 'insideBottom', offset: -2, fill: 'rgba(255,255,255,0.6)' }}
                    />
                    <YAxis dataKey="club" type="category" stroke="rgba(255,255,255,0.7)" width={80} />
                    <Tooltip
                      contentStyle={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.2)' }}
                      formatter={(value, name, item) => {
                        const v = Number(value ?? 0);
                        const row = (item?.payload ?? {}) as { shots?: number; gir?: number; gap?: number | null };
                        const nameStr = String(name ?? '');
                        if (nameStr === 'mean') {
                          const gap = row.gap ?? null;
                          const gapStr = gap !== null
                            ? ` · ${gap >= 0 ? '+' : ''}${gap.toFixed(1)} ft vs ${primaryConfig.label.toLowerCase()}`
                            : '';
                          return [`${v.toFixed(1)} ft (${row.shots ?? 0} shots, ${(row.gir ?? 0).toFixed(0)}% GIR${gapStr})`, 'Your mean'];
                        }
                        if (nameStr === 'p90') return [`${v.toFixed(1)} ft`, 'Your 90th pct'];
                        return [v, nameStr];
                      }}
                    />
                    {/* recharts v3 removed `payload` from the outer
                        Legend props (it's now sourced from chart context).
                        Pass a custom payload through the `content` slot
                        as a render function so our explicit
                        benchmark/legend rows survive the prop-merge that
                        happens when recharts clones a content element
                        (a function form receives the resolved props once,
                        and we forward them while overriding `payload`). */}
                    <Legend
                      content={(props) => (
                        <DefaultLegendContent
                          {...props}
                          payload={[
                            { value: 'Your mean (ft)', type: 'square', color: '#60a5fa' },
                            { value: 'Your 90th pct (ft)', type: 'square', color: '#f59e0b' },
                            ...(anyBenchmark ? [{ value: `${primaryConfig.label} mean (ft)`, type: 'circle' as const, color: primaryConfig.color }] : []),
                          ]}
                        />
                      )}
                    />
                    {/* Task #1997 — fade clubs backed by very few shots so a
                        couple of approach swings don't read as a real proximity
                        average. Counts still show in tooltip + caption below. */}
                    <Bar
                      dataKey="mean"
                      name="Your mean (ft)"
                      shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: { shots: number } }) => {
                        const { x = 0, y = 0, width = 0, height = 0, payload } = props;
                        const shots = payload?.shots ?? 0;
                        const lowSample = shots > 0 && shots < MIN_TRUSTWORTHY_SAMPLE;
                        return <rect x={x} y={y} width={width} height={height} fill="#60a5fa" rx={3} opacity={lowSample ? 0.4 : 1} />;
                      }}
                    />
                    <Bar
                      dataKey="p90"
                      name="Your 90th pct (ft)"
                      shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: { shots: number } }) => {
                        const { x = 0, y = 0, width = 0, height = 0, payload } = props;
                        const shots = payload?.shots ?? 0;
                        const lowSample = shots > 0 && shots < MIN_TRUSTWORTHY_SAMPLE;
                        return <rect x={x} y={y} width={width} height={height} fill="#f59e0b" rx={3} opacity={lowSample ? 0.4 : 1} />;
                      }}
                    />
                    {/* Primary-baseline reference markers — one ReferenceDot per
                        club row, coloured by which cohort the player picked. */}
                    {data.map(d => d.primaryFt !== null ? (
                      <ReferenceDot
                        key={`primary-${d.club}`}
                        x={d.primaryFt}
                        y={d.club}
                        r={5}
                        fill={primaryConfig.color}
                        stroke="rgba(0,0,0,0.4)"
                        strokeWidth={1}
                        ifOverflow="extendDomain"
                      />
                    ) : null)}
                  </BarChart>
                </ResponsiveContainer>
                {(() => {
                  // Task #1997 — caption listing low-sample clubs underneath
                  // the chart, mirroring the weather-correlation treatment.
                  const limited = items.filter(c => c.shots > 0 && c.shots < MIN_TRUSTWORTHY_SAMPLE);
                  if (limited.length === 0) return null;
                  return (
                    <p className="text-[11px] text-muted-foreground mt-2" data-testid="proximity-club-limited-sample">
                      Limited sample (faded bars): {limited.map(c => `${c.club} (${c.shots} shot${c.shots === 1 ? '' : 's'})`).join(', ')}.
                    </p>
                  );
                })()}
                {anyBenchmark && (
                  <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    {data.filter(d => d.primaryFt !== null).map(d => {
                      const isPrimaryTour = primary === 'tour';
                      const isPrimaryScratch = primary === 'scratch';
                      const isPrimaryMid = primary === 'mid';
                      return (
                        <div key={d.club} className="flex items-center justify-between gap-2 rounded border border-white/5 bg-white/5 px-2 py-1">
                          <span className="font-semibold text-white">{d.club}</span>
                          <span>
                            you {d.mean.toFixed(0)} ft ·{' '}
                            <span className={isPrimaryTour ? 'font-semibold text-emerald-300' : ''}>tour {d.tour!.toFixed(0)} ft</span> ·{' '}
                            <span className={isPrimaryScratch ? 'font-semibold text-purple-300' : ''}>scratch {d.scratch!.toFixed(0)} ft</span> ·{' '}
                            <span className={isPrimaryMid ? 'font-semibold text-sky-300' : ''}>mid-hcp {d.mid!.toFixed(0)} ft</span>
                            {d.gap !== null && (
                              <span className={d.gap > 0 ? 'ml-1 text-amber-300' : 'ml-1 text-emerald-300'}>
                                ({d.gap >= 0 ? '+' : ''}{d.gap.toFixed(1)} ft vs {primaryConfig.label.toLowerCase()})
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </CardContent>
      </Card>

      {/* Task #1348 — "Work on this club" coaching callout. Surfaces the top
          1-2 clubs with the largest gap between the player's mean proximity
          and the PGA-tour benchmark, with a concrete practice distance and
          the same caddieHint that AI Caddie appends to its rationale. */}
      {(proxByClub?.coachingTips?.length ?? 0) > 0 && (
        <Card className="glass-card border-amber-400/40">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-white text-base">Work on This Club</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Where you're losing the most strokes vs the PGA-tour benchmark.
                </p>
              </div>
              {/* Task #2041 — let players widen the trend window so less
                  frequent golfers still get a meaningful comparison. The
                  selection is persisted to localStorage and threaded into
                  the proximity-by-club query as `?days=`. */}
              <div
                className="inline-flex shrink-0 rounded-md border border-white/10 bg-white/5 p-0.5"
                role="group"
                aria-label="Trend comparison window"
                data-testid="trend-window-toggle"
              >
                {([30, 60, 90] as const).map(days => {
                  const active = trendWindowDays === days;
                  return (
                    <button
                      key={days}
                      type="button"
                      onClick={() => setTrendWindowDays(days)}
                      aria-pressed={active}
                      data-testid={`trend-window-${days}d`}
                      className={`px-2 py-1 text-[11px] font-semibold rounded transition-colors ${
                        active
                          ? 'bg-amber-400/20 text-amber-200'
                          : 'text-muted-foreground hover:text-white'
                      }`}
                    >
                      {days}d
                    </button>
                  );
                })}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {proxByClub!.coachingTips!.map(tip => {
                // Task #1640 — colour-cue the trend annotation so the player
                // can scan whether each tip is improving (green), holding
                // (muted), or slipping (amber). The trend label itself is
                // pre-formatted server-side so the wording stays consistent
                // with the AI Caddie's encouragement variant. We treat
                // sub-0.5-ft moves as flat to match the "no change" label.
                const trendClass = tip.trendVsTourFt === null || Math.abs(tip.trendVsTourFt) < 0.5
                  ? "text-muted-foreground"
                  : tip.trendVsTourFt < 0
                    ? "text-emerald-300"
                    : "text-amber-300";
                return (
                  <li
                    key={tip.clubKey}
                    className="rounded-md border border-amber-400/30 bg-amber-400/5 px-3 py-2"
                    data-testid={`coaching-tip-${tip.clubKey}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-white">{tip.club}</span>
                      <span className="text-xs text-amber-300">
                        +{tip.gapVsTourFt.toFixed(1)} ft vs tour
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-white/90">{tip.message}</p>
                    {(tip.trendLabel !== null || (tip.weeklyGapHistory?.some(b => b.gapVsTourFt !== null) ?? false)) && (
                      <div className="mt-1 flex items-center gap-2">
                        {tip.trendLabel !== null && (
                          <p
                            className={`text-xs font-medium ${trendClass}`}
                            data-testid={`coaching-tip-trend-${tip.clubKey}`}
                          >
                            {tip.trendLabel}
                          </p>
                        )}
                        {/* Task #2039 — inline 6-bucket gap-vs-tour sparkline.
                            Colour matches the trend label so a single visual
                            cue carries from the text to the chart: green when
                            the player is closing the gap, amber when slipping,
                            muted when there's not enough movement to call it.
                            Buckets with no shots that week are skipped so a
                            week off doesn't drag the line to zero. */}
                        {(() => {
                          const hist = tip.weeklyGapHistory ?? [];
                          const present = hist.filter(b => b.gapVsTourFt !== null) as { gapVsTourFt: number; weekStart: string; shots: number }[];
                          if (present.length < 2) return null;
                          const sparkColor = tip.trendVsTourFt === null || Math.abs(tip.trendVsTourFt) < 0.5
                            ? '#9ca3af'
                            : tip.trendVsTourFt < 0
                              ? '#34d399'
                              : '#fbbf24';
                          const w = 64;
                          const h = 18;
                          const padX = 1;
                          const padY = 2;
                          const values = hist.map(b => b.gapVsTourFt);
                          const present2 = values.filter((v): v is number => v !== null);
                          const min = Math.min(...present2);
                          const max = Math.max(...present2);
                          const range = max - min || 1;
                          const stepX = (w - padX * 2) / Math.max(1, hist.length - 1);
                          // Build a polyline from buckets, skipping nulls.
                          const points: string[] = [];
                          hist.forEach((b, i) => {
                            if (b.gapVsTourFt === null) return;
                            const x = padX + i * stepX;
                            const y = padY + (h - padY * 2) * (1 - (b.gapVsTourFt - min) / range);
                            points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
                          });
                          const last = hist[hist.length - 1];
                          const lastIsPresent = last && last.gapVsTourFt !== null;
                          const lastX = padX + (hist.length - 1) * stepX;
                          const lastY = lastIsPresent
                            ? padY + (h - padY * 2) * (1 - (last!.gapVsTourFt! - min) / range)
                            : null;
                          const ariaLabel = `Last ${hist.length} weeks of gap vs tour: ${
                            hist.map(b => b.gapVsTourFt === null ? 'no data' : `${b.gapVsTourFt > 0 ? '+' : ''}${b.gapVsTourFt.toFixed(1)} ft`).join(', ')
                          }`;
                          return (
                            <svg
                              width={w}
                              height={h}
                              viewBox={`0 0 ${w} ${h}`}
                              aria-label={ariaLabel}
                              role="img"
                              data-testid={`coaching-tip-sparkline-${tip.clubKey}`}
                              className="flex-shrink-0"
                            >
                              <title>{ariaLabel}</title>
                              <polyline
                                fill="none"
                                stroke={sparkColor}
                                strokeWidth={1.5}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                points={points.join(' ')}
                              />
                              {lastY !== null && (
                                <circle cx={lastX} cy={lastY} r={1.75} fill={sparkColor} />
                              )}
                            </svg>
                          );
                        })()}
                      </div>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      You {tip.meanProximityFt.toFixed(0)} ft · scratch {tip.scratchMeanFt.toFixed(0)} ft · tour {tip.tourMeanFt.toFixed(0)} ft
                      {tip.practiceDistanceYards !== null && (
                        <> · practice from {tip.practiceDistanceYards} yds</>
                      )}
                    </p>
                    {/* Task #1641 — one-tap deep-link into the practice
                        logger, pre-filled with this tip's club + distance.
                        Only rendered when the parent supplied a handler so
                        the panel still works in isolation (e.g. story-book). */}
                    {onLogPracticeFromTip && (
                      <div className="mt-2 flex justify-end">
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`coaching-tip-log-practice-${tip.clubKey}`}
                          className="h-7 px-3 text-xs border-amber-400/50 text-amber-300 hover:bg-amber-400/10 hover:text-amber-200"
                          onClick={() => onLogPracticeFromTip({
                            club: tip.club,
                            clubKey: tip.clubKey,
                            practiceDistanceYards: tip.practiceDistanceYards,
                          })}
                        >
                          Log practice
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Task #1002 — Weather Correlation */}
      <Card className="glass-card border-none">
        <CardHeader>
          <CardTitle className="text-white text-base">Weather Correlation — Wind</CardTitle>
          <p className="text-xs text-muted-foreground">
            How your SG-Total shifts in different wind conditions over the last {weatherCorr?.windowDays ?? 30} days.
            Positive bars = scoring better than your personal baseline; negative = struggling in those conditions.
            {weatherCorr?.baselineSgTotal != null && weatherCorr.baselineRoundCount > 0 && (
              <> Baseline: {(weatherCorr.baselineSgTotal >= 0 ? '+' : '') + weatherCorr.baselineSgTotal.toFixed(2)} SG over {weatherCorr.baselineRoundCount} rounds.</>
            )}
          </p>
        </CardHeader>
        <CardContent>
          {/* Task #2003 — mirror the temperature card's pending-rounds hint.
              Wind comes from the same Open-Meteo archive (which lags ~5 days),
              so recent rounds disappear from the chart for the same reason
              and the same copy applies. */}
          {weatherCorr && weatherCorr.pendingWindRoundsCount > 0 && (
            <p className="mb-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              {weatherCorr.pendingWindRoundsCount} round{weatherCorr.pendingWindRoundsCount === 1 ? '' : 's'} pending weather data — check back in a few days.
            </p>
          )}
          {(weatherCorr?.windBuckets ?? []).every(b => b.rounds === 0) ? (
            <p className="text-sm text-muted-foreground">
              No wind data tied to recent rounds yet. Use the AI Caddie during play so wind conditions get logged with each round.
            </p>
          ) : (<>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={(weatherCorr?.windBuckets ?? []).map(b => ({
                label: b.label,
                delta: b.sgDelta ?? 0,
                rounds: b.rounds,
                mean: b.meanSgTotal ?? 0,
              }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.6)" />
                <YAxis stroke="rgba(255,255,255,0.6)" tickFormatter={(v: number) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.3)" />
                <Tooltip
                  contentStyle={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.2)' }}
                  formatter={(value, _n, item) => {
                    const v = Number(value ?? 0);
                    const row = (item?.payload ?? {}) as { rounds?: number; mean?: number };
                    const rounds = row.rounds ?? 0;
                    const mean = row.mean ?? 0;
                    return [
                      `${v >= 0 ? '+' : ''}${v.toFixed(2)} SG (${rounds} round${rounds === 1 ? '' : 's'} · mean ${(mean >= 0 ? '+' : '') + mean.toFixed(2)})`,
                      'Δ vs baseline',
                    ];
                  }}
                />
                <Bar
                  dataKey="delta"
                  name="Δ vs baseline"
                  shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: { delta: number; rounds: number } }) => {
                    const { x = 0, y = 0, width = 0, height = 0, payload } = props;
                    const fill = (payload?.delta ?? 0) >= 0 ? '#22c55e' : '#ef4444';
                    const rounds = payload?.rounds ?? 0;
                    const lowSample = rounds > 0 && rounds < MIN_TRUSTWORTHY_ROUNDS;
                    return <rect x={x} y={y} width={width} height={height} fill={fill} rx={3} opacity={lowSample ? 0.4 : 1} />;
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
            {renderLimitedSampleNote(weatherCorr?.windBuckets ?? [])}
          </>)}
        </CardContent>
      </Card>

      <Card className="glass-card border-none">
        <CardHeader>
          <CardTitle className="text-white text-base">Weather Correlation — Temperature</CardTitle>
          <p className="text-xs text-muted-foreground">
            How your SG-Total shifts with temperature over the last {weatherCorr?.windowDays ?? 30} days.
            Bars show the change in strokes-gained vs your personal baseline for each temperature range.
          </p>
        </CardHeader>
        <CardContent>
          {/* Task #1613 — surface rounds whose temperature hasn't resolved yet
              (Open-Meteo's archive lags ~5 days), so players know the most
              recent rounds will populate the chart in a few days. */}
          {weatherCorr && weatherCorr.pendingRoundsCount > 0 && (
            <p className="mb-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              {weatherCorr.pendingRoundsCount} round{weatherCorr.pendingRoundsCount === 1 ? '' : 's'} pending weather data — check back in a few days.
            </p>
          )}
          {!weatherCorr || (weatherCorr.temperatureBuckets ?? []).every(b => b.rounds === 0) ? (
            <p className="text-sm text-muted-foreground">
              No temperature data tied to recent rounds yet. Once a few rounds are logged at courses with location data, this chart will populate.
            </p>
          ) : (<>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={weatherCorr.temperatureBuckets.map(b => ({
                label: b.label,
                delta: b.sgDelta ?? 0,
                rounds: b.rounds,
                mean: b.meanSgTotal ?? 0,
              }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.6)" />
                <YAxis stroke="rgba(255,255,255,0.6)" tickFormatter={(v: number) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.3)" />
                <Tooltip
                  contentStyle={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.2)' }}
                  formatter={(value, _n, item) => {
                    const v = Number(value ?? 0);
                    const row = (item?.payload ?? {}) as { rounds?: number; mean?: number };
                    const rounds = row.rounds ?? 0;
                    const mean = row.mean ?? 0;
                    return [
                      `${v >= 0 ? '+' : ''}${v.toFixed(2)} SG (${rounds} round${rounds === 1 ? '' : 's'} · mean ${(mean >= 0 ? '+' : '') + mean.toFixed(2)})`,
                      'Δ vs baseline',
                    ];
                  }}
                />
                <Bar
                  dataKey="delta"
                  name="Δ vs baseline"
                  shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: { delta: number; rounds: number } }) => {
                    const { x = 0, y = 0, width = 0, height = 0, payload } = props;
                    const fill = (payload?.delta ?? 0) >= 0 ? '#22c55e' : '#ef4444';
                    const rounds = payload?.rounds ?? 0;
                    const lowSample = rounds > 0 && rounds < MIN_TRUSTWORTHY_ROUNDS;
                    return <rect x={x} y={y} width={width} height={height} fill={fill} rx={3} opacity={lowSample ? 0.4 : 1} />;
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
            {renderLimitedSampleNote(weatherCorr?.temperatureBuckets ?? [])}
          </>)}
        </CardContent>
      </Card>

      {/* Task #1347 — Weather Correlation (Humidity) */}
      <Card className="glass-card border-none">
        <CardHeader>
          <CardTitle className="text-white text-base">Weather Correlation — Humidity</CardTitle>
          <p className="text-xs text-muted-foreground">
            How your SG-Total shifts in muggy vs dry conditions over the last {weatherCorr?.windowDays ?? 30} days.
            Captured from the AI Caddie's live weather reading on each recommendation.
          </p>
        </CardHeader>
        <CardContent>
          {!weatherCorr || (weatherCorr.humidityBuckets ?? []).every(b => b.rounds === 0) ? (
            <p className="text-sm text-muted-foreground">
              No humidity data tied to recent rounds yet. Use the AI Caddie during play so humidity gets logged with each round.
            </p>
          ) : (<>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={weatherCorr.humidityBuckets.map(b => ({
                label: b.label,
                delta: b.sgDelta ?? 0,
                rounds: b.rounds,
                mean: b.meanSgTotal ?? 0,
              }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.6)" />
                <YAxis stroke="rgba(255,255,255,0.6)" tickFormatter={(v: number) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.3)" />
                <Tooltip
                  contentStyle={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.2)' }}
                  formatter={(value, _n, item) => {
                    const v = Number(value ?? 0);
                    const row = (item?.payload ?? {}) as { rounds?: number; mean?: number };
                    const rounds = row.rounds ?? 0;
                    const mean = row.mean ?? 0;
                    return [
                      `${v >= 0 ? '+' : ''}${v.toFixed(2)} SG (${rounds} round${rounds === 1 ? '' : 's'} · mean ${(mean >= 0 ? '+' : '') + mean.toFixed(2)})`,
                      'Δ vs baseline',
                    ];
                  }}
                />
                <Bar
                  dataKey="delta"
                  name="Δ vs baseline"
                  shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: { delta: number; rounds: number } }) => {
                    const { x = 0, y = 0, width = 0, height = 0, payload } = props;
                    const fill = (payload?.delta ?? 0) >= 0 ? '#22c55e' : '#ef4444';
                    const rounds = payload?.rounds ?? 0;
                    const lowSample = rounds > 0 && rounds < MIN_TRUSTWORTHY_ROUNDS;
                    return <rect x={x} y={y} width={width} height={height} fill={fill} rx={3} opacity={lowSample ? 0.4 : 1} />;
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
            {renderLimitedSampleNote(weatherCorr?.humidityBuckets ?? [])}
          </>)}
        </CardContent>
      </Card>

      {/* Task #1347 — Weather Correlation (Precipitation) */}
      <Card className="glass-card border-none">
        <CardHeader>
          <CardTitle className="text-white text-base">Weather Correlation — Rain</CardTitle>
          <p className="text-xs text-muted-foreground">
            How your SG-Total shifts when it's raining over the last {weatherCorr?.windowDays ?? 30} days.
            Buckets reflect precipitation in the hour before each AI Caddie recommendation.
          </p>
        </CardHeader>
        <CardContent>
          {!weatherCorr || (weatherCorr.precipitationBuckets ?? []).every(b => b.rounds === 0) ? (
            <p className="text-sm text-muted-foreground">
              No precipitation data tied to recent rounds yet. Use the AI Caddie during play so rain conditions get logged with each round.
            </p>
          ) : (<>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={weatherCorr.precipitationBuckets.map(b => ({
                label: b.label,
                delta: b.sgDelta ?? 0,
                rounds: b.rounds,
                mean: b.meanSgTotal ?? 0,
              }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.6)" />
                <YAxis stroke="rgba(255,255,255,0.6)" tickFormatter={(v: number) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.3)" />
                <Tooltip
                  contentStyle={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.2)' }}
                  formatter={(value, _n, item) => {
                    const v = Number(value ?? 0);
                    const row = (item?.payload ?? {}) as { rounds?: number; mean?: number };
                    const rounds = row.rounds ?? 0;
                    const mean = row.mean ?? 0;
                    return [
                      `${v >= 0 ? '+' : ''}${v.toFixed(2)} SG (${rounds} round${rounds === 1 ? '' : 's'} · mean ${(mean >= 0 ? '+' : '') + mean.toFixed(2)})`,
                      'Δ vs baseline',
                    ];
                  }}
                />
                <Bar
                  dataKey="delta"
                  name="Δ vs baseline"
                  shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: { delta: number; rounds: number } }) => {
                    const { x = 0, y = 0, width = 0, height = 0, payload } = props;
                    const fill = (payload?.delta ?? 0) >= 0 ? '#22c55e' : '#ef4444';
                    const rounds = payload?.rounds ?? 0;
                    const lowSample = rounds > 0 && rounds < MIN_TRUSTWORTHY_ROUNDS;
                    return <rect x={x} y={y} width={width} height={height} fill={fill} rx={3} opacity={lowSample ? 0.4 : 1} />;
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
            {renderLimitedSampleNote(weatherCorr?.precipitationBuckets ?? [])}
          </>)}
        </CardContent>
      </Card>

      <Card className="glass-card border-none">
        <CardHeader>
          <CardTitle className="text-white text-base">Putting Make-Rate by Distance</CardTitle>
          <p className="text-xs text-muted-foreground">Make percentages by remaining distance (in feet). Compare against PGA tour averages of 99% &lt;3ft, 50% 6-10ft.</p>
        </CardHeader>
        <CardContent>
          {(putts?.bands ?? []).every(b => b.attempts === 0) ? (
            <p className="text-sm text-muted-foreground">No putts tracked yet.</p>
          ) : (<>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={(putts?.bands ?? []).map(b => ({ ...b, makePct: b.makePct ?? 0 }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis dataKey="band" stroke="rgba(255,255,255,0.6)" />
                <YAxis stroke="rgba(255,255,255,0.6)" domain={[0, 100]} />
                <Tooltip
                  contentStyle={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.2)' }}
                  formatter={(value, _n, item) => {
                    const v = Number(value ?? 0);
                    const row = (item?.payload ?? {}) as { attempts?: number; makes?: number };
                    return [`${v.toFixed(1)}% (${row.makes ?? 0}/${row.attempts ?? 0})`, 'Make %'];
                  }}
                />
                {/* Task #1997 — fade bands backed by very few putts; the
                    raw counts still show in the tooltip + caption below. */}
                <Bar
                  dataKey="makePct"
                  name="Make %"
                  shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: { attempts: number } }) => {
                    const { x = 0, y = 0, width = 0, height = 0, payload } = props;
                    const attempts = payload?.attempts ?? 0;
                    const lowSample = attempts > 0 && attempts < MIN_TRUSTWORTHY_SAMPLE;
                    return <rect x={x} y={y} width={width} height={height} fill="#a78bfa" rx={3} opacity={lowSample ? 0.4 : 1} />;
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
            {(() => {
              const limited = (putts?.bands ?? []).filter(b => b.attempts > 0 && b.attempts < MIN_TRUSTWORTHY_SAMPLE);
              if (limited.length === 0) return null;
              return (
                <p className="text-[11px] text-muted-foreground mt-2" data-testid="putting-limited-sample">
                  Limited sample (faded bars): {limited.map(b => `${b.band} (${b.attempts} putt${b.attempts === 1 ? '' : 's'})`).join(', ')}.
                </p>
              );
            })()}
          </>)}
        </CardContent>
      </Card>
    </div>
  );
}

export default function StatsPage() {
  const { data: user } = useGetMe();
  const orgId = (user as { organizationId?: number })?.organizationId;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [period, setPeriod] = useState<StatsPeriod>('allTime');
  // Task #1643 — Admin override for the SG baseline when reviewing another
  // player. For the self-view, the baseline is now resolved server-side
  // from the player's pinned preference + handicap, so no `?baseline=`
  // query param is sent and refetching is triggered by mutating the
  // preference (see `setSgBaselinePref` below).
  const [sgBaselineAdminOverride, setSgBaselineAdminOverride] = useState<SgPickerValue>('auto');
  const [activeTab, setActiveTab] = useState<string>('mystats');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [adminViewUserId, setAdminViewUserId] = useState<number | null>(null);
  const [showAdminPicker, setShowAdminPicker] = useState(false);

  const isAdmin = ['org_admin', 'tournament_director', 'super_admin'].includes((user as { role?: string })?.role ?? '');

  const { data: stats, isLoading: statsLoading } = useQuery<PlayerStats>({
    queryKey: ['portal-stats', period, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({ period });
      if (period === 'custom' && dateFrom) params.set('dateFrom', dateFrom);
      if (period === 'custom' && dateTo) params.set('dateTo', dateTo);
      const res = await fetch(`${BASE_URL}/api/portal/stats?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load stats');
      return res.json();
    },
    enabled: !!user,
  });

  const { data: adminStats, isLoading: adminStatsLoading } = useQuery<PlayerStats>({
    queryKey: ['portal-admin-stats', adminViewUserId, period, sgBaselineAdminOverride],
    queryFn: async () => {
      const params = new URLSearchParams({ period });
      // Admin one-off override: only forward an actual cohort, not "auto"
      // (auto means: let the server resolve from the target user's pref).
      if (sgBaselineAdminOverride !== 'auto') params.set('baseline', sgBaselineAdminOverride);
      const res = await fetch(`${BASE_URL}/api/portal/stats/${adminViewUserId}?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load player stats');
      return res.json();
    },
    enabled: !!user && isAdmin && adminViewUserId !== null,
  });

  // Task #1643 — persist the player's SG baseline pin (auto/scratch/10/18)
  // so the chart remembers it across sessions and devices. Mirrors the
  // proximity-by-club mutation pattern.
  const setSgBaselinePref = useMutation({
    mutationFn: async (baseline: SgPickerValue) => {
      const res = await fetch(`${BASE_URL}/api/portal/player/sg-baseline-preference`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseline }),
      });
      if (!res.ok) throw new Error('Failed to update SG baseline preference');
      return res.json() as Promise<{ preferredBaseline: SgPickerValue }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portal-stats'] });
    },
  });

  // Task #2048 — Acknowledge a one-time "your benchmark moved" notice. The
  // banner offers two actions: dismiss (no body) and "Pin <previous>"
  // (`{ pin: previousBaseline }`). Both advance `last_seen_auto_sg_baseline`
  // server-side so the same notice doesn't re-fire until the auto-pick
  // crosses *another* threshold.
  const ackSgBaselineChange = useMutation({
    mutationFn: async (pin: SGBaseline | null) => {
      const res = await fetch(`${BASE_URL}/api/portal/player/sg-baseline-change-ack`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pin !== null ? { pin } : {}),
      });
      if (!res.ok) throw new Error('Failed to acknowledge SG baseline change');
      return res.json() as Promise<{ acknowledged: true; preferredBaseline: SgPickerValue; lastSeenAutoSgBaseline: SGBaseline | null }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portal-stats'] });
    },
  });

  // Task #2047 — Coach/admin pins (or unpins) a player's SG baseline from
  // the admin Player Analytics view. Posts to the admin-side mirror of the
  // self-PUT route, which records the change in member_audit_log so the
  // pin is attributable to the coach. After it lands we refetch the admin
  // stats panel so the source-copy block updates without a page reload.
  const setAdminSgBaselinePin = useMutation({
    mutationFn: async ({ targetUserId, baseline }: { targetUserId: number; baseline: SgPickerValue }) => {
      const res = await fetch(`${BASE_URL}/api/portal/stats/${targetUserId}/sg-baseline-preference`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseline }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Failed to pin SG baseline for player');
      }
      return res.json() as Promise<{ targetUserId: number; preferredBaseline: SgPickerValue }>;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['portal-admin-stats'] });
      toast({
        title: vars.baseline === 'auto'
          ? 'Cleared pinned baseline for player'
          : `Pinned ${vars.baseline === 'scratch' ? 'Tour/Scratch' : `${vars.baseline}-hcp`} baseline for player`,
      });
    },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const { data: orgMembers = [] } = useQuery<OrgMember[]>({
    queryKey: ['portal-org-members'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/org-members`, { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user && isAdmin,
  });

  const activeStats = adminViewUserId !== null ? adminStats : stats;
  const activeStatsLoading = adminViewUserId !== null ? adminStatsLoading : statsLoading;

  const { data: achievements, isLoading: achLoading } = useQuery<Achievement[]>({
    queryKey: ['portal-achievements'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/achievements`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load achievements');
      return res.json();
    },
    enabled: !!user,
  });

  const { data: wearables } = useQuery<WearableConnection[]>({
    queryKey: ['portal-wearables'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/wearable-connections`, { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
  });

  const { data: clubStats, isLoading: clubLoading } = useQuery<ClubStats>({
    queryKey: ['club-stats', orgId],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/club-stats`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load club stats');
      return res.json();
    },
    enabled: !!orgId && ['org_admin', 'tournament_director', 'super_admin'].includes((user as { role?: string })?.role ?? ''),
  });

  const linkWearable = useMutation({
    mutationFn: async (provider: string) => {
      const res = await fetch(`${BASE_URL}/api/portal/wearable-connections`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) throw new Error('Failed to link device');
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['portal-wearables'] }); toast({ title: 'Device linked successfully' }); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const unlinkWearable = useMutation({
    mutationFn: async (provider: string) => {
      const res = await fetch(`${BASE_URL}/api/portal/wearable-connections/${provider}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error('Failed to remove device');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['portal-wearables'] }); toast({ title: 'Device removed' }); },
  });

  type ClubProfileEntry = { club: string | null; avgDistance: number | null; minDistance: number | null; maxDistance: number | null; shotCount: number };
  // Task #709 — let the player restrict the carry averages to GPS-measured
  // shots only (watch + phone), excluding both hand-entered carries and
  // scorer-station entries that have no measured carry.
  const [trackedShotsOnly, setTrackedShotsOnly] = useState(false);
  const { data: clubProfile = [] } = useQuery<ClubProfileEntry[]>({
    queryKey: ['portal-club-profile', trackedShotsOnly],
    queryFn: async () => {
      const url = trackedShotsOnly
        ? `${BASE_URL}/api/portal/club-profile?sources=watch,phone`
        : `${BASE_URL}/api/portal/club-profile`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
  });

  type PracticeStats = { thisWeek: number; thisMonth: number; streak: number; total: number; heatmap: Record<string, number> };
  const { data: practiceStats } = useQuery<PracticeStats>({
    queryKey: ['portal-practice-stats'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/practice/stats`, { credentials: 'include' });
      if (!res.ok) return { thisWeek: 0, thisMonth: 0, streak: 0, total: 0, heatmap: {} };
      return res.json();
    },
    enabled: !!user,
  });

  // Task #2044 — personal tip-driven vs manual cohort report (default 30d window).
  type PracticeCohortClub = {
    clubKey: string;
    tipDrivenSessions: number;
    manualSessions: number;
    currentMeanProximityFt: number | null;
    priorMeanProximityFt: number | null;
    proximityImprovementFt: number | null;
    shotsCurrent: number;
    shotsPrior: number;
    cohort: 'tip' | 'manual' | 'mixed' | 'none';
  };
  type PracticeCohort = {
    windowStart: string;
    windowEnd: string;
    windowDays: number;
    summary: {
      tipDrivenSessions: number;
      manualSessions: number;
      totalSessions: number;
      tipDrivenMinutes: number;
      manualMinutes: number;
      activeTipClubKeys: string[];
      tipsConverted: number;
      conversionRate: number | null;
      // A/B headline: per-cohort mean proximity improvement (ft); positive = closer.
      tipCohortClubs: number;
      manualCohortClubs: number;
      tipCohortAvgImprovementFt: number | null;
      manualCohortAvgImprovementFt: number | null;
    };
    byClub: PracticeCohortClub[];
  };
  // Filter controls for the personal cohort report. Default = last 30
  // days, all clubs. State is local to the Practice tab.
  const cohortDefaultRange = useMemo(() => {
    const now = new Date();
    const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return { from: fmt(past), to: fmt(now) };
  }, []);
  const [cohortFromDate, setCohortFromDate] = useState<string>(cohortDefaultRange.from);
  const [cohortToDate, setCohortToDate] = useState<string>(cohortDefaultRange.to);
  const [cohortClubFilter, setCohortClubFilter] = useState<string>('');
  const cohortFromIso = useMemo(() => {
    if (!cohortFromDate || cohortFromDate.length < 10) return null;
    const d = new Date(`${cohortFromDate}T00:00:00`);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }, [cohortFromDate]);
  const cohortToIso = useMemo(() => {
    if (!cohortToDate || cohortToDate.length < 10) return null;
    const d = new Date(`${cohortToDate}T23:59:59`);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }, [cohortToDate]);

  const { data: practiceCohort } = useQuery<PracticeCohort>({
    queryKey: ['portal-practice-cohort', cohortFromIso, cohortToIso, cohortClubFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cohortFromIso) params.set('from', cohortFromIso);
      if (cohortToIso) params.set('to', cohortToIso);
      if (cohortClubFilter) params.set('clubKey', cohortClubFilter);
      const qs = params.toString();
      const url = `${BASE_URL}/api/portal/practice/cohort-stats${qs ? `?${qs}` : ''}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!user && !!cohortFromIso && !!cohortToIso,
  });

  type PracticeSession = {
    id: number;
    sessionType: string;
    durationMinutes: number | null;
    notes: string | null;
    clubFocus: string | null;
    sessionDate: string;
    // Task #1641 — set when this session was logged from a "Work on This Club"
    // coaching tip. Drives the "From coaching tip" badge in the session list
    // and is the column we'll later A/B against the manual cohort.
    source: string | null;
    clubKey: string | null;
    practiceDistanceYards: number | null;
  };
  const { data: practiceSessions = [], refetch: refetchPractice } = useQuery<PracticeSession[]>({
    queryKey: ['portal-practice-sessions'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/practice`, { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
  });

  // Task #1641 — `source` / `clubKey` / `practiceDistanceYards` are populated
  // when the practice form was deep-linked from a "Work on This Club"
  // coaching tip; "Cancel" or a successful save resets them back to "manual"
  // so the next blank-form open isn't mis-attributed.
  const EMPTY_PRACTICE_FORM = {
    sessionType: 'range',
    durationMinutes: '',
    notes: '',
    clubFocus: '',
    source: 'manual' as 'manual' | 'coaching_tip',
    clubKey: '' as string,
    practiceDistanceYards: '' as string,
  };
  const [practiceForm, setPracticeForm] = useState(EMPTY_PRACTICE_FORM);
  const [logFormOpen, setLogFormOpen] = useState(false);
  const [loggingPractice, setLoggingPractice] = useState(false);

  // ── Advanced Analytics state ──────────────────────────────────────────────
  const [compareUserId, setCompareUserId] = useState<number | null>(null);
  const [compareSearch, setCompareSearch] = useState('');
  const [editingClub, setEditingClub] = useState<string | null>(null);
  const [editingCarry, setEditingCarry] = useState('');

  type ProximityStats = { approach: { avgFeet: number; shotCount: number } | null; chip: { avgFeet: number; shotCount: number } | null; sand: { avgFeet: number; shotCount: number } | null; totalShots: number };
  const { data: proximityStats } = useQuery<ProximityStats>({
    queryKey: ['portal-proximity-stats'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/proximity-stats`, { credentials: 'include' });
      if (!res.ok) return { approach: null, chip: null, sand: null, totalShots: 0 };
      return res.json();
    },
    enabled: !!user,
  });

  type ClubGapping = { clubs: { club: string; avgCarry: number; manualOverride: boolean; shotCount: number }[]; gaps: { upperClub: string; lowerClub: string; gapYards: number; suggestion: string }[] };
  const { data: clubGapping, refetch: refetchGapping } = useQuery<ClubGapping>({
    queryKey: ['portal-club-gapping'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/club-gapping`, { credentials: 'include' });
      if (!res.ok) return { clubs: [], gaps: [] };
      return res.json();
    },
    enabled: !!user,
  });

  type CompareMember = { userId: number; displayName: string };
  const { data: compareMembers = [] } = useQuery<CompareMember[]>({
    queryKey: ['portal-org-members-compare'],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/org-members-compare`, { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
  });

  type CompareStats = { me: PlayerCompare; them: PlayerCompare };
  type PlayerCompare = { displayName: string; handicapIndex: number | null; girPct: number | null; fairwayPct: number | null; avgPutts: number | null; scoringAvg: number | null; roundsPlayed: number; sgPutting: number | null; sgApproach: number | null };
  const { data: compareStats, isFetching: compareFetching } = useQuery<CompareStats>({
    queryKey: ['portal-compare', compareUserId],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/portal/compare/${compareUserId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Compare failed');
      return res.json();
    },
    enabled: !!user && !!compareUserId,
  });

  const saveClubDistance = async (club: string, carry: number) => {
    await fetch(`${BASE_URL}/api/portal/club-distances/${encodeURIComponent(club)}`, {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carryYards: carry }),
    });
    refetchGapping();
    qc.invalidateQueries({ queryKey: ['portal-club-gapping'] });
    setEditingClub(null);
  };

  const deleteClubOverride = async (club: string) => {
    await fetch(`${BASE_URL}/api/portal/club-distances/${encodeURIComponent(club)}`, { method: 'DELETE', credentials: 'include' });
    refetchGapping();
    qc.invalidateQueries({ queryKey: ['portal-club-gapping'] });
  };

  const filteredOrgMembers = compareMembers.filter(m => m.displayName.toLowerCase().includes(compareSearch.toLowerCase()));

  const logPractice = async () => {
    setLoggingPractice(true);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/practice`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionType: practiceForm.sessionType,
          notes: practiceForm.notes,
          clubFocus: practiceForm.clubFocus,
          durationMinutes: practiceForm.durationMinutes ? parseInt(practiceForm.durationMinutes) : null,
          // Task #1641 — only forward the coaching-tip metadata when the form
          // was actually deep-linked from a tip; manual entries leave them
          // null so the cohort split stays clean.
          source: practiceForm.source,
          clubKey: practiceForm.source === 'coaching_tip' && practiceForm.clubKey ? practiceForm.clubKey : null,
          practiceDistanceYards:
            practiceForm.source === 'coaching_tip' && practiceForm.practiceDistanceYards
              ? parseInt(practiceForm.practiceDistanceYards)
              : null,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      await refetchPractice();
      qc.invalidateQueries({ queryKey: ['portal-practice-stats'] });
      setLogFormOpen(false);
      setPracticeForm(EMPTY_PRACTICE_FORM);
      toast({ title: 'Practice logged!' });
    } catch { toast({ title: 'Failed to log practice', variant: 'destructive' }); }
    finally { setLoggingPractice(false); }
  };

  // Task #1641 — deep-link entry-point invoked when a player taps "Log
  // practice" on a "Work on This Club" coaching tip in ShotAnalyticsPanel.
  // Switches to the Practice tab, opens the log form, and pre-fills it with
  // the tip's club + suggested distance so the player only has to tap "Save".
  const startPracticeFromTip = useCallback((req: CoachingTipPracticeRequest) => {
    setPracticeForm({
      sessionType: 'range',
      durationMinutes: '',
      notes: req.practiceDistanceYards !== null
        ? `From coaching tip: practice your ${req.club} from ${req.practiceDistanceYards} yds.`
        : `From coaching tip: practice your ${req.club}.`,
      clubFocus: req.club,
      source: 'coaching_tip',
      clubKey: req.clubKey,
      practiceDistanceYards: req.practiceDistanceYards !== null ? String(req.practiceDistanceYards) : '',
    });
    setLogFormOpen(true);
    setActiveTab('practice');
  }, [setPracticeForm, setLogFormOpen, setActiveTab]);

  const deletePractice = async (id: number) => {
    await fetch(`${BASE_URL}/api/portal/practice/${id}`, { method: 'DELETE', credentials: 'include' });
    refetchPractice();
    qc.invalidateQueries({ queryKey: ['portal-practice-stats'] });
  };

  const SESSION_TYPE_LABELS: Record<string, { label: string; icon: string }> = {
    range: { label: 'Driving Range', icon: '🏌️' },
    putting: { label: 'Putting Green', icon: '⛳' },
    short_game: { label: 'Short Game', icon: '🏖️' },
    on_course: { label: 'On Course', icon: '🌿' },
    simulator: { label: 'Simulator', icon: '🖥️' },
    other: { label: 'Other', icon: '🎯' },
  };

  const scoreDistData = activeStats ? [
    { name: 'Eagles', value: activeStats.eagles, color: SCORE_COLORS.eagles },
    { name: 'Birdies', value: activeStats.birdies, color: SCORE_COLORS.birdies },
    { name: 'Pars', value: activeStats.pars, color: SCORE_COLORS.pars },
    { name: 'Bogeys', value: activeStats.bogeys, color: SCORE_COLORS.bogeys },
    { name: 'Dbl+', value: activeStats.doublePlus, color: SCORE_COLORS.doublePlus },
  ].filter(d => d.value > 0) : [];

  const holeAvgData = (activeStats?.holeAverages ?? []).filter(h => h.avgToPar !== null).map(h => ({
    hole: `H${h.holeNumber}`,
    avgToPar: h.avgToPar!,
    avgStrokes: h.avgStrokes,
    count: h.count,
  }));

  const recentRoundsData = (activeStats?.recentRounds ?? []).map((r, i) => ({
    name: `R${i + 1}`, gross: r.gross, par: r.par, toPar: r.toPar, birdies: r.birdies,
  }));

  const sgBarData = activeStats?.strokesGained && activeStats.strokesGained.trackedRounds >= 5
    ? [
        { name: 'Off the Tee', value: activeStats.strokesGained.sgOffTheTee },
        { name: 'Approach', value: activeStats.strokesGained.sgApproach },
        { name: 'Around Green', value: activeStats.strokesGained.sgATG },
        { name: 'Putting', value: activeStats.strokesGained.sgPutting },
      ].filter(d => d.value !== null) as { name: string; value: number }[]
    : [];

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <header>
        <h1 className="text-3xl font-display font-bold text-white tracking-tight">Player Analytics</h1>
        <p className="text-muted-foreground mt-1">Your scoring statistics, achievements, and device connections</p>
      </header>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-white/5 border border-white/10 flex-wrap h-auto gap-1 p-1">
          <TabsTrigger value="mystats">My Stats</TabsTrigger>
          {isAdmin && <TabsTrigger value="playerstats">Player Analytics</TabsTrigger>}
          <TabsTrigger value="shotanalytics">Shot Analytics</TabsTrigger>
          <TabsTrigger value="clubs">Club Distances</TabsTrigger>
          <TabsTrigger value="practice">Practice</TabsTrigger>
          <TabsTrigger value="achievements">Achievements</TabsTrigger>
          <TabsTrigger value="compare"><GitCompare className="w-3.5 h-3.5 mr-1" />Compare</TabsTrigger>
          <TabsTrigger value="devices">Devices</TabsTrigger>
          {isAdmin && <TabsTrigger value="clubstats">Club Leaderboards</TabsTrigger>}
        </TabsList>

        {/* ── My Stats ── */}
        <TabsContent value="mystats" className="space-y-6 mt-6">
          {/* Filter controls */}
          <div className="flex flex-wrap gap-3 items-start justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium">Period</span>
              {([
                ['allTime', 'All Time'],
                ['thisYear', 'This Year'],
                ['last5rounds', 'Last 5'],
                ['last10rounds', 'Last 10'],
                ['last20rounds', 'Last 20'],
                ['custom', 'Custom Range'],
              ] as [StatsPeriod, string][]).map(([p, label]) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${period === p ? 'bg-primary text-white border-primary' : 'border-white/10 text-muted-foreground hover:border-white/30'}`}
                >
                  {label}
                </button>
              ))}
              {period === 'custom' && (
                <div className="flex items-center gap-2 mt-1">
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white" />
                  <span className="text-muted-foreground text-xs">to</span>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white" />
                </div>
              )}
            </div>
            {/* Task #1643 — SG baseline picker (auto + 3 cohorts). For self-view
                this PUTs the player's preference; for admin-view it sets a
                local one-off override. The active label below the picker
                explains *why* the current baseline was chosen.
                Task #2047 — In admin view we additionally surface a "Pin to
                player" / "Unpin player baseline" action so the coach can
                lock in the comparison cohort for the player too (audited). */}
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <span className="text-xs text-muted-foreground font-medium">SG Baseline</span>
                {(() => {
                  const isViewingOther = adminViewUserId !== null;
                  const sgMeta = activeStats?.strokesGained ?? null;
                  const currentPick: SgPickerValue = isViewingOther
                    ? sgBaselineAdminOverride
                    : (sgMeta?.preferredBaseline ?? 'auto');
                  return ([['auto', 'Auto'], ['scratch', 'Tour/Scratch'], ['10', '10 Hcp'], ['18', '18 Hcp']] as [SgPickerValue, string][]).map(([b, label]) => (
                    <button
                      key={b}
                      onClick={() => {
                        if (isViewingOther) setSgBaselineAdminOverride(b);
                        else setSgBaselinePref.mutate(b);
                      }}
                      disabled={!isViewingOther && setSgBaselinePref.isPending}
                      data-testid={`sg-baseline-${b}`}
                      aria-pressed={currentPick === b}
                      aria-label={`Set strokes-gained baseline to ${label}`}
                      className={`px-3 py-1 text-xs rounded-full border transition-colors disabled:opacity-50 ${currentPick === b ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40' : 'border-white/10 text-muted-foreground hover:border-white/30'}`}
                    >
                      {label}
                    </button>
                  ));
                })()}
              </div>
              {/* Source copy: "Auto-picked from your 12.4 handicap" vs "Pinned to 10-hcp" */}
              {(() => {
                const sgMeta = activeStats?.strokesGained ?? null;
                if (!sgMeta?.primaryBaseline) return null;
                const labelOf = (b: 'scratch' | '10' | '18') =>
                  b === 'scratch' ? 'Tour/Scratch' : b === '10' ? '10-hcp' : '18-hcp';
                const primary = labelOf(sgMeta.primaryBaseline);
                let copy: string;
                if (sgMeta.baselineSource === 'preference') {
                  copy = `Pinned to ${primary}`;
                } else if (sgMeta.baselineSource === 'handicap' && sgMeta.handicapIndex != null) {
                  copy = `Auto-picked from your ${sgMeta.handicapIndex.toFixed(1)} handicap → ${primary}`;
                } else {
                  copy = `Defaulting to ${primary} (no handicap on file yet)`;
                }
                return (
                  <p className="text-[10.5px] text-muted-foreground/80 italic" data-testid="sg-baseline-source-copy">
                    {copy}
                  </p>
                );
              })()}
              {/* Task #2047 — Pin / Unpin affordance, only when an admin is
                  viewing another player. The button persists the currently
                  selected admin override (or 'auto' to unpin) to the player's
                  preference via the audited admin-side endpoint. */}
              {(() => {
                if (adminViewUserId === null) return null;
                const sgMeta = activeStats?.strokesGained ?? null;
                const playerPin: SgPickerValue = sgMeta?.preferredBaseline ?? 'auto';
                const desired = sgBaselineAdminOverride;
                const labelOf = (b: SgPickerValue) =>
                  b === 'auto' ? 'auto'
                    : b === 'scratch' ? 'Tour/Scratch'
                      : `${b}-hcp`;
                const pinning = setAdminSgBaselinePin.isPending;
                const noChange = playerPin === desired;
                const isUnpin = desired === 'auto';
                const buttonLabel = isUnpin
                  ? (playerPin === 'auto' ? 'Player baseline not pinned' : 'Unpin player baseline')
                  : `Pin ${labelOf(desired)} to player`;
                return (
                  <div className="flex flex-col items-end gap-0.5 mt-1">
                    <p className="text-[10.5px] text-muted-foreground/80" data-testid="sg-baseline-player-pin-status">
                      {playerPin === 'auto'
                        ? 'Player has no baseline pinned (auto-picked)'
                        : `Player has pinned: ${labelOf(playerPin)}`}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setAdminSgBaselinePin.mutate({ targetUserId: adminViewUserId, baseline: desired });
                      }}
                      disabled={pinning || noChange}
                      data-testid="sg-baseline-admin-pin"
                      aria-label={buttonLabel}
                      className="px-3 py-1 text-xs rounded-full border transition-colors disabled:opacity-50 bg-yellow-500/10 text-yellow-200 border-yellow-500/40 hover:bg-yellow-500/20"
                    >
                      {pinning ? 'Saving…' : buttonLabel}
                    </button>
                  </div>
                );
              })()}
            </div>
          </div>

          {activeStatsLoading ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[...Array(4)].map((_, i) => <div key={i} className="h-24 glass-card rounded-2xl animate-pulse" />)}</div>
          ) : !activeStats || activeStats.roundsPlayed === 0 ? (
            <Card className="glass-panel p-12 text-center border-dashed">
              <Flag className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
              <p className="text-white font-medium">No rounds played yet</p>
              <p className="text-sm text-muted-foreground mt-1">Your stats will appear here once you start scoring in tournaments.</p>
            </Card>
          ) : (
            <>
              {/* Summary Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: 'Rounds Played', value: activeStats.roundsPlayed, icon: Activity, color: 'text-primary bg-primary/10' },
                  { label: 'Scoring Avg', value: activeStats.scoringAvg ?? '—', icon: Target, color: 'text-emerald-400 bg-emerald-400/10' },
                  { label: 'Best Round', value: activeStats.bestRound ?? '—', icon: TrendingUp, color: 'text-green-400 bg-green-400/10' },
                  { label: 'Worst Round', value: activeStats.worstRound ?? '—', icon: Activity, color: 'text-orange-400 bg-orange-400/10' },
                ].map((s, i) => (
                  <motion.div key={i} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}>
                    <Card className="glass-card border-none">
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
                  </motion.div>
                ))}
              </div>

              {/* Second row: fairway, GIR, putts, scrambling */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                  { label: 'Fairways Hit', value: activeStats.fairwayPct !== null ? `${activeStats.fairwayPct}%` : '—', sub: 'avg per round', color: 'text-green-400 bg-green-400/10' },
                  { label: 'GIR', value: activeStats.girPct !== null ? `${activeStats.girPct}%` : '—', sub: 'greens in regulation', color: 'text-emerald-400 bg-emerald-400/10' },
                  { label: 'Avg Putts', value: activeStats.avgPutts !== null ? activeStats.avgPutts : '—', sub: 'per hole', color: 'text-purple-400 bg-purple-400/10' },
                  { label: 'Scrambling', value: activeStats.shortGame?.upAndDownPct !== null && activeStats.shortGame?.upAndDownPct !== undefined ? `${activeStats.shortGame.upAndDownPct}%` : '—', sub: 'up & down %', color: 'text-orange-400 bg-orange-400/10' },
                ].map((s, i) => (
                  <Card key={i} className="glass-card border-none">
                    <CardContent className="p-5 text-center">
                      <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
                      <p className="text-3xl font-bold text-white font-display">{s.value}</p>
                      <p className="text-xs text-muted-foreground mt-1">{s.sub}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Sand save % */}
              {activeStats.shortGame?.sandSavePct !== null && activeStats.shortGame?.sandSavePct !== undefined && (
                <Card className="glass-card border-none">
                  <CardContent className="p-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-white">Sand Save %</p>
                      <p className="text-xs text-muted-foreground">Bunker → bogey or better</p>
                    </div>
                    <p className="text-2xl font-bold text-orange-400">{activeStats.shortGame.sandSavePct}%</p>
                  </CardContent>
                </Card>
              )}

              {/* Putting */}
              {activeStats.putting && activeStats.putting.holesTracked > 0 && (
                <Card className="glass-card border-none">
                  <CardHeader>
                    <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                      <Target className="w-4 h-4 text-purple-400" /> Putting
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-3 gap-4">
                      <div className="bg-white/5 rounded-xl p-3 text-center">
                        <p className="text-xs text-muted-foreground mb-1">Avg / Hole</p>
                        <p className="text-2xl font-bold text-white font-display">{activeStats.avgPutts !== null ? activeStats.avgPutts.toFixed(2) : '—'}</p>
                      </div>
                      <div className="bg-white/5 rounded-xl p-3 text-center">
                        <p className="text-xs text-muted-foreground mb-1">1‑Putts {activeStats.putting.onePuttPct !== null ? `(${activeStats.putting.onePuttPct}%)` : ''}</p>
                        <p className="text-2xl font-bold text-green-400 font-display">{activeStats.putting.onePutts}</p>
                      </div>
                      <div className="bg-white/5 rounded-xl p-3 text-center">
                        <p className="text-xs text-muted-foreground mb-1">3+ Putts {activeStats.putting.threePlusPuttPct !== null ? `(${activeStats.putting.threePlusPuttPct}%)` : ''}</p>
                        <p className="text-2xl font-bold text-red-400 font-display">{activeStats.putting.threePlusPutts}</p>
                      </div>
                    </div>
                    {(() => {
                      const trend = activeStats.recentRounds
                        .filter(r => r.avgPutts !== null)
                        .map(r => ({ name: `R${r.round}`, avgPutts: r.avgPutts as number }));
                      if (trend.length < 2) {
                        return (
                          <p className="text-xs text-muted-foreground">{activeStats.putting.holesTracked} holes tracked · record putts to see your trend.</p>
                        );
                      }
                      return (
                        <div>
                          <p className="text-xs text-muted-foreground mb-2">Putts per Round (avg / hole)</p>
                          <ResponsiveContainer width="100%" height={160}>
                            <LineChart data={trend}>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                              <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 11 }} />
                              <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} domain={['auto', 'auto']} />
                              <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} formatter={(v: number) => [v.toFixed(2), 'Avg Putts']} />
                              <Line type="monotone" dataKey="avgPutts" stroke="#a78bfa" strokeWidth={2} dot={{ fill: '#a78bfa', r: 3 }} activeDot={{ r: 5 }} />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>
              )}

              {/* Event Breakdown */}
              {activeStats.eventBreakdown && (activeStats.eventBreakdown.generalPlayRounds > 0) && (
                <Card className="glass-card border-none">
                  <CardHeader><CardTitle className="text-white text-sm font-semibold flex items-center gap-2"><Users className="w-4 h-4 text-blue-400" /> Tournament vs General Play</CardTitle></CardHeader>
                  <CardContent className="grid grid-cols-2 gap-4">
                    <div className="bg-white/5 rounded-xl p-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Tournament Rounds</p>
                      <p className="text-2xl font-bold text-primary">{activeStats.eventBreakdown.tournamentRounds}</p>
                      {activeStats.eventBreakdown.tournamentScoringAvg !== null && (
                        <p className="text-xs text-muted-foreground mt-1">Avg: {activeStats.eventBreakdown.tournamentScoringAvg}</p>
                      )}
                    </div>
                    <div className="bg-white/5 rounded-xl p-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Casual Rounds</p>
                      <p className="text-2xl font-bold text-blue-400">{activeStats.eventBreakdown.generalPlayRounds}</p>
                      {activeStats.eventBreakdown.generalPlayScoringAvg !== null && (
                        <p className="text-xs text-muted-foreground mt-1">Avg: {activeStats.eventBreakdown.generalPlayScoringAvg}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Score Distribution Donut */}
                <Card className="glass-card border-none">
                  <CardHeader><CardTitle className="text-white text-sm font-semibold">Score Distribution</CardTitle></CardHeader>
                  <CardContent>
                    {scoreDistData.length > 0 ? (
                      <div className="flex items-center gap-4">
                        <ResponsiveContainer width={160} height={160}>
                          <PieChart>
                            <Pie data={scoreDistData} cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={2} dataKey="value">
                              {scoreDistData.map((entry, index) => (
                                <Cell key={index} fill={entry.color} />
                              ))}
                            </Pie>
                            <Tooltip formatter={(val: number, name: string) => [val, name]} contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="flex-1 space-y-2">
                          {scoreDistData.map(d => (
                            <div key={d.name} className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }} />
                                <span className="text-muted-foreground">{d.name}</span>
                              </div>
                              <span className="text-white font-semibold">{d.value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : <p className="text-muted-foreground text-sm text-center py-8">Not enough data</p>}
                  </CardContent>
                </Card>

                {/* Scoring Trend */}
                <Card className="glass-card border-none">
                  <CardHeader><CardTitle className="text-white text-sm font-semibold">Recent Scoring Trend</CardTitle></CardHeader>
                  <CardContent>
                    {recentRoundsData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={180}>
                        <AreaChart data={recentRoundsData}>
                          <defs>
                            <linearGradient id="grossGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                              <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 11 }} />
                          <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} domain={['auto', 'auto']} />
                          <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
                          <Area type="monotone" dataKey="gross" stroke="#22c55e" strokeWidth={2} fill="url(#grossGrad)" name="Gross Score" />
                          <Line type="monotone" dataKey="par" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" name="Par" dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : <p className="text-muted-foreground text-sm text-center py-8">Play more rounds to see your trend</p>}
                  </CardContent>
                </Card>
              </div>

              {/* Hole-by-hole Averages */}
              {holeAvgData.length > 0 && (
                <Card className="glass-card border-none">
                  <CardHeader><CardTitle className="text-white text-sm font-semibold">Hole-by-Hole Averages</CardTitle></CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={holeAvgData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="hole" tick={{ fill: '#6b7280', fontSize: 10 }} />
                        <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} />
                        <Tooltip
                          contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                          formatter={(v: number, n: string) => [v.toFixed(2), n]}
                        />
                        <Bar dataKey="avgToPar" name="Avg +/-" fill="#3b82f6" radius={[4, 4, 0, 0]}>
                          {holeAvgData.map((entry, index) => (
                            <Cell key={index} fill={entry.avgToPar <= -1 ? '#22c55e' : entry.avgToPar === 0 ? '#3b82f6' : entry.avgToPar === 1 ? '#f97316' : '#ef4444'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    {/* Mini scorecard table */}
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-xs text-center">
                        <thead>
                          <tr className="text-muted-foreground">
                            <th className="py-1 px-1 text-left">Hole</th>
                            {holeAvgData.map(h => <th key={h.hole} className="py-1 px-1 w-8">{h.hole.replace('H', '')}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="text-muted-foreground">
                            <td className="py-1 text-left">Avg Par</td>
                            {holeAvgData.map(h => <td key={h.hole} className="py-1">{h.avgStrokes?.toFixed(1) ?? '—'}</td>)}
                          </tr>
                          <tr>
                            <td className="py-1 text-muted-foreground text-left">+/-</td>
                            {holeAvgData.map(h => (
                              <td key={h.hole} className={`py-1 font-semibold ${h.avgToPar! <= -1 ? 'text-green-400' : h.avgToPar === 0 ? 'text-gray-300' : h.avgToPar! <= 1 ? 'text-orange-400' : 'text-red-400'}`}>
                                {h.avgToPar! > 0 ? '+' : ''}{h.avgToPar?.toFixed(1)}
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* ── Proximity to Hole Stats ── */}
              {proximityStats && proximityStats.totalShots > 0 && (
                <Card className="glass-card border-none">
                  <CardHeader>
                    <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-blue-400" /> Proximity to Hole
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">{proximityStats.totalShots} shot{proximityStats.totalShots !== 1 ? 's' : ''} tracked</p>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-3 gap-4">
                      {[
                        { label: 'Approach', key: 'approach' as const, color: 'text-blue-400', bgColor: 'bg-blue-400/10', emoji: '🏌️' },
                        { label: 'Chip', key: 'chip' as const, color: 'text-green-400', bgColor: 'bg-green-400/10', emoji: '🏖️' },
                        { label: 'Sand', key: 'sand' as const, color: 'text-amber-400', bgColor: 'bg-amber-400/10', emoji: '⛱️' },
                      ].map(cat => {
                        const data = proximityStats[cat.key];
                        return (
                          <div key={cat.key} className={`rounded-xl p-4 text-center ${cat.bgColor}`}>
                            <p className="text-2xl mb-1">{cat.emoji}</p>
                            <p className="text-xs text-muted-foreground mb-1">{cat.label}</p>
                            {data ? (
                              <>
                                <p className={`text-2xl font-bold font-display ${cat.color}`}>{data.avgFeet}<span className="text-xs ml-1">ft</span></p>
                                <p className="text-xs text-muted-foreground mt-1">{data.shotCount} shot{data.shotCount !== 1 ? 's' : ''}</p>
                              </>
                            ) : <p className="text-sm text-muted-foreground">No data</p>}
                          </div>
                        );
                      })}
                    </div>
                    <ResponsiveContainer width="100%" height={120} className="mt-4">
                      <BarChart data={[
                        proximityStats.approach ? { name: 'Approach', feet: proximityStats.approach.avgFeet } : null,
                        proximityStats.chip ? { name: 'Chip', feet: proximityStats.chip.avgFeet } : null,
                        proximityStats.sand ? { name: 'Sand', feet: proximityStats.sand.avgFeet } : null,
                      ].filter(Boolean) as { name: string; feet: number }[]}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                        <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} unit=" ft" />
                        <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} formatter={(v: number) => [`${v} ft`, 'Avg Distance']} />
                        <Bar dataKey="feet" radius={[4, 4, 0, 0]} fill="#3b82f6" maxBarSize={40} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}

              {/* Task #2048 — One-time "your benchmark moved" notice when
                   the auto-derived SG cohort has crossed a threshold since
                   the player's last visit. Only rendered for self-view
                   (admin viewing another player should not be acking
                   notices on the target's behalf). */}
              {adminViewUserId === null && activeStats?.strokesGained?.baselineChange && (() => {
                const change = activeStats.strokesGained!.baselineChange!;
                const labelOf = (b: 'scratch' | '10' | '18') =>
                  b === 'scratch' ? 'Tour/Scratch' : b === '10' ? '10-handicap' : '18-handicap';
                const previous = labelOf(change.previousBaseline);
                const current = labelOf(change.currentBaseline);
                return (
                  <Card
                    className="glass-panel border border-yellow-500/30 bg-yellow-500/5"
                    data-testid="sg-baseline-change-banner"
                  >
                    <CardContent className="p-4 flex items-start gap-3">
                      <Zap className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
                      <div className="flex-1 text-sm">
                        <p className="text-white font-semibold mb-1">Your benchmark moved to {current}</p>
                        <p className="text-muted-foreground text-xs mb-3">
                          Your strokes-gained comparison auto-updated as your handicap changed. Pin {previous} if you'd rather keep comparing against your previous benchmark.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => ackSgBaselineChange.mutate(change.previousBaseline)}
                            disabled={ackSgBaselineChange.isPending}
                            data-testid="sg-baseline-change-pin"
                            className="px-3 py-1.5 text-xs rounded-full bg-yellow-500/20 text-yellow-300 border border-yellow-500/40 hover:bg-yellow-500/30 transition-colors disabled:opacity-50"
                          >
                            Pin {previous}
                          </button>
                          <button
                            onClick={() => ackSgBaselineChange.mutate(null)}
                            disabled={ackSgBaselineChange.isPending}
                            data-testid="sg-baseline-change-dismiss"
                            className="px-3 py-1.5 text-xs rounded-full border border-white/10 text-muted-foreground hover:border-white/30 hover:text-white transition-colors disabled:opacity-50"
                          >
                            Got it
                          </button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })()}

              {/* Strokes Gained — real data when available */}
              {activeStats?.strokesGained && activeStats.strokesGained.trackedRounds >= 5 ? (
                <Card className="glass-card border-none">
                  <CardHeader>
                    <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                      <Zap className="w-4 h-4 text-yellow-400" /> Strokes Gained Analysis
                      <span className="text-xs font-normal text-yellow-300/60 ml-1">
                        vs {activeStats.strokesGained.baseline === 'scratch' ? 'Tour/Scratch' : `${activeStats.strokesGained.baseline}-hcp`} baseline
                      </span>
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">{activeStats.strokesGained.trackedRounds} tracked rounds · positive = better than baseline</p>
                    {(activeStats.strokesGained.sgPuttingMeasuredRounds !== undefined || activeStats.strokesGained.sgPuttingEstimatedRounds !== undefined) && ((activeStats.strokesGained.sgPuttingMeasuredRounds ?? 0) + (activeStats.strokesGained.sgPuttingEstimatedRounds ?? 0) > 0) && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        SG-Putting split: {activeStats.strokesGained.sgPuttingMeasuredRounds ?? 0} measured · {activeStats.strokesGained.sgPuttingEstimatedRounds ?? 0} estimated
                      </p>
                    )}
                  </CardHeader>
                  <CardContent className="p-4 pt-0 space-y-4">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      {[
                        { label: 'SG: Putting', value: activeStats.strokesGained.sgPutting, note: '≥5 putts-tracked rounds' },
                        { label: 'SG: Approach', value: activeStats.strokesGained.sgApproach, note: 'GIR vs baseline rate' },
                        { label: 'SG: Around Green', value: activeStats.strokesGained.sgATG, note: 'Chips from missed GIR' },
                        { label: 'SG: Off the Tee', value: activeStats.strokesGained.sgOffTheTee, note: 'FIR vs baseline rate' },
                        { label: 'SG: Total', value: activeStats.strokesGained.sgTotal, note: 'Combined categories' },
                      ].map((sg) => (
                        <div key={sg.label} className="bg-white/5 rounded-xl p-3 text-center">
                          <p className="text-xs text-muted-foreground mb-1">{sg.label}</p>
                          {sg.value !== null ? (
                            <p className={`text-xl font-bold font-display ${sg.value >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {sg.value >= 0 ? '+' : ''}{sg.value.toFixed(2)}
                            </p>
                          ) : (
                            <p className="text-sm text-muted-foreground">—</p>
                          )}
                          <p className="text-[10px] text-muted-foreground mt-0.5 opacity-60">{sg.note}</p>
                        </div>
                      ))}
                    </div>
                    {/* SG Bar Chart */}
                    {sgBarData.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-2">Strokes Gained by Category</p>
                        <ResponsiveContainer width="100%" height={160}>
                          <BarChart data={sgBarData} margin={{ left: 8, right: 8 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                            <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                            <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} tickFormatter={(v: number) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))} />
                            <Tooltip
                              contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                              formatter={(v: number) => [(v >= 0 ? '+' : '') + v.toFixed(2), 'Strokes Gained']}
                            />
                            <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                            <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={40}>
                              {sgBarData.map((entry, i) => (
                                <Cell key={i} fill={entry.value >= 0 ? '#22c55e' : '#ef4444'} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                    {/* SG Trend over recent rounds */}
                    {(activeStats.strokesGained.roundDetail?.length ?? 0) > 2 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-2">SG Total — Recent Rounds</p>
                        <ResponsiveContainer width="100%" height={120}>
                          <AreaChart data={activeStats.strokesGained.roundDetail.map((r, i) => ({ name: `R${i+1}`, sg: r.sgTotal }))}>
                            <defs>
                              <linearGradient id="sgGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#eab308" stopOpacity={0.3} />
                                <stop offset="95%" stopColor="#eab308" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                            <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 10 }} />
                            <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} tickFormatter={(v: number) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))} />
                            <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                            <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                              formatter={(v: number) => [(v >= 0 ? '+' : '') + v.toFixed(2), 'SG Total']} />
                            <Area type="monotone" dataKey="sg" stroke="#eab308" strokeWidth={2} fill="url(#sgGrad)" />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ) : activeStats?.strokesGained && activeStats.strokesGained.trackedRounds > 0 ? (
                <Card className="glass-panel border border-yellow-500/20">
                  <CardContent className="p-4 flex items-start gap-3">
                    <Zap className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
                    <div className="flex-1 text-sm">
                      <p className="text-white font-semibold mb-1">Strokes Gained In Progress</p>
                      <p className="text-muted-foreground text-xs mb-2">
                        {activeStats.strokesGained.trackedRounds} of 5 required rounds tracked. Keep recording putts, GIR, and fairways to unlock SG analysis.
                      </p>
                      <div className="bg-white/10 rounded-full h-1.5 w-full">
                        <div className="bg-yellow-400 h-1.5 rounded-full transition-all" style={{ width: `${Math.min((activeStats.strokesGained.trackedRounds / 5) * 100, 100)}%` }} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <Card className="glass-panel border border-yellow-500/10">
                  <CardContent className="p-4 flex items-start gap-3">
                    <Zap className="w-5 h-5 text-yellow-400/50 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <p className="text-white font-semibold mb-1">Strokes Gained Analysis</p>
                      <p className="text-muted-foreground text-xs">
                        Requires GPS shot tracking from a wearable or GPX upload. Connect your Garmin or Arccos in the{' '}
                        <button onClick={() => setActiveTab('devices')} className="text-primary underline hover:text-primary/80">Devices tab</button>
                        {' '}to enable Putting, Approach, ATG, and Off-the-Tee analysis.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        {/* ── Player Analytics (Admin/Coach) ── */}
        {isAdmin && (
          <TabsContent value="playerstats" className="space-y-6 mt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-white font-semibold text-lg">Player Analytics</h2>
                <p className="text-xs text-muted-foreground mt-0.5">View any member's full performance breakdown</p>
              </div>
              <Button variant="outline" size="sm" className="gap-1" onClick={() => setShowAdminPicker(v => !v)}>
                <Users className="w-4 h-4" />
                {adminViewUserId ? `Viewing: ${adminStats?.playerName ?? '...'}` : 'Select Player'}
                <ChevronDown className="w-3 h-3" />
              </Button>
            </div>
            {showAdminPicker && (
              <Card className="glass-card border-none">
                <CardHeader><CardTitle className="text-white text-sm">Select Member</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-64 overflow-y-auto">
                  {orgMembers.length === 0 ? (
                    <p className="text-muted-foreground text-sm col-span-3">No members found in your organization</p>
                  ) : orgMembers.map(m => (
                    <button
                      key={m.userId}
                      onClick={() => { setAdminViewUserId(m.userId); setShowAdminPicker(false); }}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm border transition-colors ${adminViewUserId === m.userId ? 'bg-primary/20 border-primary/40 text-white' : 'border-white/10 text-muted-foreground hover:border-white/30 hover:text-white'}`}
                    >
                      <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary">
                        {(m.displayName ?? '?')[0]?.toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-white text-xs">{m.displayName ?? 'Unknown'}</p>
                        <p className="text-[10px] text-muted-foreground">{m.role}</p>
                      </div>
                    </button>
                  ))}
                </CardContent>
              </Card>
            )}
            {adminViewUserId === null ? (
              <Card className="glass-panel p-12 text-center border-dashed">
                <Users className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
                <p className="text-white font-medium">Select a player to view their stats</p>
                <p className="text-sm text-muted-foreground mt-1">Use the button above to pick a member from your organization.</p>
              </Card>
            ) : adminStatsLoading ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[...Array(4)].map((_, i) => <div key={i} className="h-24 glass-card rounded-2xl animate-pulse" />)}</div>
            ) : !adminStats || adminStats.roundsPlayed === 0 ? (
              <Card className="glass-panel p-12 text-center border-dashed">
                <Flag className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
                <p className="text-white font-medium">No rounds found for this player</p>
                <p className="text-sm text-muted-foreground mt-1">This player hasn't recorded any rounds in the selected period.</p>
              </Card>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-lg font-bold text-primary">
                    {(adminStats.playerName ?? '?')[0]?.toUpperCase()}
                  </div>
                  <div>
                    <p className="text-white font-semibold">{adminStats.playerName}</p>
                    <p className="text-xs text-muted-foreground">{adminStats.roundsPlayed} rounds · period: {adminStats.period ?? 'all time'}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    { label: 'Rounds Played', value: adminStats.roundsPlayed, icon: Activity, color: 'text-primary bg-primary/10' },
                    { label: 'Scoring Avg', value: adminStats.scoringAvg ?? '—', icon: Target, color: 'text-emerald-400 bg-emerald-400/10' },
                    { label: 'Best Round', value: adminStats.bestRound ?? '—', icon: TrendingUp, color: 'text-green-400 bg-green-400/10' },
                    { label: 'Worst Round', value: adminStats.worstRound ?? '—', icon: Activity, color: 'text-orange-400 bg-orange-400/10' },
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
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: 'Fairways Hit', value: adminStats.fairwayPct !== null ? `${adminStats.fairwayPct}%` : '—' },
                    { label: 'GIR', value: adminStats.girPct !== null ? `${adminStats.girPct}%` : '—' },
                    { label: 'Avg Putts', value: adminStats.avgPutts !== null ? adminStats.avgPutts : '—' },
                    { label: 'Eagles / Birdies', value: `${adminStats.eagles} / ${adminStats.birdies}` },
                  ].map((s, i) => (
                    <Card key={i} className="glass-card border-none">
                      <CardContent className="p-4 text-center">
                        <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
                        <p className="text-2xl font-bold text-white">{s.value}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
                {adminStats.strokesGained && adminStats.strokesGained.trackedRounds >= 5 && (
                  <Card className="glass-card border-none">
                    <CardHeader>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                            <Zap className="w-4 h-4 text-yellow-400" /> Strokes Gained
                            <span className="text-xs font-normal text-yellow-300/60">vs {adminStats.strokesGained.baseline === 'scratch' ? 'Tour/Scratch' : `${adminStats.strokesGained.baseline}-hcp`}</span>
                          </CardTitle>
                          {(adminStats.strokesGained.sgPuttingMeasuredRounds !== undefined || adminStats.strokesGained.sgPuttingEstimatedRounds !== undefined) && ((adminStats.strokesGained.sgPuttingMeasuredRounds ?? 0) + (adminStats.strokesGained.sgPuttingEstimatedRounds ?? 0) > 0) && (
                            <p className="text-xs text-muted-foreground">
                              SG-Putting split: {adminStats.strokesGained.sgPuttingMeasuredRounds ?? 0} measured · {adminStats.strokesGained.sgPuttingEstimatedRounds ?? 0} estimated
                            </p>
                          )}
                        </div>
                        {/* Task #2047 — SG baseline picker + pin/unpin control on
                            the admin coach view, so a coach can both preview a
                            cohort comparison locally and lock it in for the player
                            (audited via the admin-side endpoint). */}
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex items-center gap-2 flex-wrap justify-end">
                            <span className="text-xs text-muted-foreground font-medium">SG Baseline</span>
                            {(['auto', 'scratch', '10', '18'] as SgPickerValue[]).map(b => {
                              const label = b === 'auto' ? 'Auto' : b === 'scratch' ? 'Tour/Scratch' : b === '10' ? '10 Hcp' : '18 Hcp';
                              const active = sgBaselineAdminOverride === b;
                              return (
                                <button
                                  key={b}
                                  onClick={() => setSgBaselineAdminOverride(b)}
                                  data-testid={`playerstats-sg-baseline-${b}`}
                                  aria-pressed={active}
                                  aria-label={`Preview strokes-gained baseline ${label} for this player`}
                                  className={`px-3 py-1 text-xs rounded-full border transition-colors disabled:opacity-50 ${active ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40' : 'border-white/10 text-muted-foreground hover:border-white/30'}`}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                          {/* Source-of-truth copy mirrors the player's own Stats page */}
                          {(() => {
                            const sgMeta = adminStats.strokesGained;
                            if (!sgMeta?.primaryBaseline) return null;
                            const labelOf = (b: 'scratch' | '10' | '18') =>
                              b === 'scratch' ? 'Tour/Scratch' : b === '10' ? '10-hcp' : '18-hcp';
                            const primary = labelOf(sgMeta.primaryBaseline);
                            let copy: string;
                            if (sgMeta.baselineSource === 'preference') {
                              copy = `Player has pinned: ${primary}`;
                            } else if (sgMeta.baselineSource === 'handicap' && sgMeta.handicapIndex != null) {
                              copy = `Auto-picked from ${sgMeta.handicapIndex.toFixed(1)} handicap → ${primary}`;
                            } else {
                              copy = `Defaulting to ${primary} (no handicap on file yet)`;
                            }
                            return (
                              <p className="text-[10.5px] text-muted-foreground/80 italic" data-testid="playerstats-sg-baseline-source-copy">
                                {copy}
                              </p>
                            );
                          })()}
                          {/* Pin / Unpin affordance — persists the currently selected
                              admin override (or 'auto' to clear) to the player's
                              preference via the audited admin endpoint. */}
                          {(() => {
                            const sgMeta = adminStats.strokesGained;
                            const playerPin: SgPickerValue = sgMeta?.preferredBaseline ?? 'auto';
                            const desired = sgBaselineAdminOverride;
                            const labelOf = (b: SgPickerValue) =>
                              b === 'auto' ? 'auto'
                                : b === 'scratch' ? 'Tour/Scratch'
                                  : `${b}-hcp`;
                            const pinning = setAdminSgBaselinePin.isPending;
                            const noChange = playerPin === desired;
                            const isUnpin = desired === 'auto';
                            const buttonLabel = isUnpin
                              ? (playerPin === 'auto' ? 'Player baseline not pinned' : 'Unpin player baseline')
                              : `Pin ${labelOf(desired)} to player`;
                            return (
                              <div className="flex flex-col items-end gap-0.5 mt-1">
                                <p className="text-[10.5px] text-muted-foreground/80" data-testid="playerstats-sg-baseline-player-pin-status">
                                  {playerPin === 'auto'
                                    ? 'Player has no baseline pinned (auto-picked)'
                                    : `Player has pinned: ${labelOf(playerPin)}`}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (adminViewUserId !== null) {
                                      setAdminSgBaselinePin.mutate({ targetUserId: adminViewUserId, baseline: desired });
                                    }
                                  }}
                                  disabled={pinning || noChange}
                                  data-testid="playerstats-sg-baseline-admin-pin"
                                  aria-label={buttonLabel}
                                  className="px-3 py-1 text-xs rounded-full border transition-colors disabled:opacity-50 bg-yellow-500/10 text-yellow-200 border-yellow-500/40 hover:bg-yellow-500/20"
                                >
                                  {pinning ? 'Saving…' : buttonLabel}
                                </button>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="p-4 pt-0">
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
                        {[
                          { label: 'SG: Putting', value: adminStats.strokesGained.sgPutting },
                          { label: 'SG: Approach', value: adminStats.strokesGained.sgApproach },
                          { label: 'SG: Around Green', value: adminStats.strokesGained.sgATG },
                          { label: 'SG: Off the Tee', value: adminStats.strokesGained.sgOffTheTee },
                          { label: 'SG: Total', value: adminStats.strokesGained.sgTotal },
                        ].map(sg => (
                          <div key={sg.label} className="bg-white/5 rounded-xl p-3 text-center">
                            <p className="text-xs text-muted-foreground mb-1">{sg.label}</p>
                            {sg.value !== null ? (
                              <p className={`text-xl font-bold ${sg.value >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {sg.value >= 0 ? '+' : ''}{sg.value.toFixed(2)}
                              </p>
                            ) : <p className="text-sm text-muted-foreground">—</p>}
                          </div>
                        ))}
                      </div>
                      <ResponsiveContainer width="100%" height={160}>
                        <BarChart data={[
                          { name: 'Off the Tee', value: adminStats.strokesGained.sgOffTheTee },
                          { name: 'Approach', value: adminStats.strokesGained.sgApproach },
                          { name: 'Around Green', value: adminStats.strokesGained.sgATG },
                          { name: 'Putting', value: adminStats.strokesGained.sgPutting },
                        ].filter(d => d.value !== null) as { name: string; value: number }[]}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                          <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} tickFormatter={(v: number) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1))} />
                          <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                          <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                            formatter={(v: number) => [(v >= 0 ? '+' : '') + v.toFixed(2), 'SG']} />
                          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={40}>
                            {([
                              { name: 'Off the Tee', value: adminStats.strokesGained.sgOffTheTee },
                              { name: 'Approach', value: adminStats.strokesGained.sgApproach },
                              { name: 'Around Green', value: adminStats.strokesGained.sgATG },
                              { name: 'Putting', value: adminStats.strokesGained.sgPutting },
                            ].filter(d => d.value !== null) as { name: string; value: number }[]).map((entry, i) => (
                              <Cell key={i} fill={entry.value >= 0 ? '#22c55e' : '#ef4444'} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                )}
                {adminStats.courseBreakdown.length > 0 && (
                  <Card className="glass-card border-none">
                    <CardHeader><CardTitle className="text-white text-sm font-semibold">Course Breakdown</CardTitle></CardHeader>
                    <CardContent className="space-y-2">
                      {adminStats.courseBreakdown.slice(0, 6).map(cb => (
                        <div key={cb.courseId} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                          <div>
                            <p className="text-sm text-white">{cb.courseName ?? `Course #${cb.courseId}`}</p>
                            <p className="text-xs text-muted-foreground">{cb.rounds} round{cb.rounds !== 1 ? 's' : ''}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold text-white">Avg {cb.avgGross.toFixed(1)}</p>
                            {cb.bestGross && <p className="text-xs text-green-400">Best: {cb.bestGross}</p>}
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
                {adminStats.recentRounds.length > 0 && (
                  <Card className="glass-card border-none">
                    <CardHeader><CardTitle className="text-white text-sm font-semibold">Recent Rounds</CardTitle></CardHeader>
                    <CardContent>
                      <ResponsiveContainer width="100%" height={160}>
                        <AreaChart data={adminStats.recentRounds.map((r, i) => ({ name: `R${i+1}`, gross: r.gross, par: r.par }))}>
                          <defs>
                            <linearGradient id="adminGrossGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                              <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 10 }} />
                          <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} domain={['auto', 'auto']} />
                          <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
                          <Area type="monotone" dataKey="gross" stroke="#22c55e" strokeWidth={2} fill="url(#adminGrossGrad)" name="Gross" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </TabsContent>
        )}

        {/* ── Shot Analytics (dispersion / proximity-bands / putting) ── */}
        <TabsContent value="shotanalytics" className="space-y-6 mt-6">
          <ShotAnalyticsPanel onLogPracticeFromTip={startPracticeFromTip} />
        </TabsContent>

        {/* ── Club Distances ── */}
        <TabsContent value="clubs" className="space-y-6 mt-6">
          {/* Chart from tracked shots — card always renders (with the source toggle)
              so a player who filtered to watch/phone-only can still toggle back if
              the filtered result is empty. Task #709. */}
          <Card className="glass-card border-none">
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="text-white text-base">Average Carry Distance by Club</CardTitle>
                <p className="text-xs text-muted-foreground">From tracked shot data. Use the distance editor below to override any club.</p>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  className="accent-[#C9A84C]"
                  checked={trackedShotsOnly}
                  onChange={e => setTrackedShotsOnly(e.target.checked)}
                />
                Watch / phone only
              </label>
            </CardHeader>
            <CardContent>
              {clubProfile.length > 0 ? (
                <ResponsiveContainer width="100%" height={Math.max(300, clubProfile.length * 36)}>
                  <BarChart data={clubProfile.filter(c => c.club).map(c => ({ club: c.club!, avg: c.avgDistance ?? 0, min: c.minDistance ?? 0, max: c.maxDistance ?? 0, shots: c.shotCount }))} layout="vertical" margin={{ left: 16, right: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" dataKey="avg" tick={{ fill: '#9ca3af', fontSize: 11 }} unit=" yds" />
                    <YAxis type="category" dataKey="club" tick={{ fill: '#e5e7eb', fontSize: 12 }} width={56} />
                    <Tooltip
                      contentStyle={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff', fontSize: 12 }}
                      formatter={(val: number, _name: string, entry: { payload?: { min?: number; max?: number; shots?: number } }) => [
                        `${val.toFixed(0)} yds avg  (${(entry.payload?.min ?? 0).toFixed(0)}–${(entry.payload?.max ?? 0).toFixed(0)}) · ${entry.payload?.shots ?? 0} shots`,
                        'Carry',
                      ]}
                    />
                    <Bar dataKey="avg" fill="#C9A84C" radius={[0, 6, 6, 0]} maxBarSize={24} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-muted-foreground py-8 text-center">
                  {trackedShotsOnly
                    ? 'No watch- or phone-tracked shots yet. Uncheck the filter to see all tracked clubs.'
                    : 'No tracked shot data yet — your club averages will appear here once you log shots during a round.'}
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── Club Gapping Analysis + Manual Distance Editor ── */}
          <Card className="glass-card border-none">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-white text-base">Club Distance Profile</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">Manual overrides take precedence over tracked data. Add a new club below.</p>
              </div>
              <Button size="sm" className="bg-[#C9A84C]/20 text-[#C9A84C] hover:bg-[#C9A84C]/30 border border-[#C9A84C]/30 text-xs"
                onClick={() => { setEditingClub('__new__'); setEditingCarry(''); }}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Club
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {/* New club add row */}
              {editingClub === '__new__' && (
                <div className="flex items-center gap-2 bg-[#C9A84C]/5 border border-[#C9A84C]/30 rounded-xl px-3 py-2">
                  <input
                    type="text" placeholder="Club name (e.g. 7 Iron)"
                    className="flex-1 bg-transparent text-white text-sm placeholder:text-muted-foreground focus:outline-none"
                    value={editingCarry.includes(':') ? editingCarry.split(':')[0] : ''}
                    onChange={e => setEditingCarry(e.target.value + ':' + (editingCarry.split(':')[1] ?? ''))}
                  />
                  <input
                    type="number" placeholder="Yards"
                    className="w-20 bg-transparent text-white text-sm text-center placeholder:text-muted-foreground focus:outline-none border-l border-white/10 pl-3"
                    value={editingCarry.split(':')[1] ?? ''}
                    onChange={e => setEditingCarry((editingCarry.split(':')[0] ?? '') + ':' + e.target.value)}
                  />
                  <button className="text-green-400 hover:text-green-300" onClick={() => {
                    const [club, carryStr] = editingCarry.split(':');
                    const carry = parseInt(carryStr ?? '');
                    if (club?.trim() && !isNaN(carry) && carry > 0) saveClubDistance(club.trim(), carry);
                    else setEditingClub(null);
                  }}><Check className="w-4 h-4" /></button>
                  <button className="text-muted-foreground hover:text-white" onClick={() => setEditingClub(null)}><X className="w-4 h-4" /></button>
                </div>
              )}
              {(clubGapping?.clubs ?? []).length === 0 && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p>No club distances yet. Add them manually above or track shots during a round.</p>
                </div>
              )}
              {(clubGapping?.clubs ?? []).map(c => (
                <div key={c.club} className={`flex items-center gap-3 rounded-xl px-3 py-2 ${c.manualOverride ? 'bg-[#C9A84C]/8 border border-[#C9A84C]/20' : 'bg-white/3'}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white text-sm font-medium">{c.club}</span>
                      {c.manualOverride && <Badge className="bg-[#C9A84C]/20 text-[#C9A84C] border-0 text-[10px] px-1.5 py-0">manual</Badge>}
                      {c.shotCount > 0 && <span className="text-xs text-muted-foreground">{c.shotCount} shot{c.shotCount !== 1 ? 's' : ''}</span>}
                    </div>
                  </div>
                  {editingClub === c.club ? (
                    <div className="flex items-center gap-2">
                      <input type="number" autoFocus value={editingCarry}
                        onChange={e => setEditingCarry(e.target.value)}
                        className="w-20 bg-white/5 text-white text-sm text-center rounded-lg px-2 py-1 border border-white/20 focus:outline-none focus:border-[#C9A84C]/50"
                        onKeyDown={e => { if (e.key === 'Enter') saveClubDistance(c.club, parseInt(editingCarry)); if (e.key === 'Escape') setEditingClub(null); }}
                      />
                      <span className="text-xs text-muted-foreground">yds</span>
                      <button className="text-green-400 hover:text-green-300" onClick={() => saveClubDistance(c.club, parseInt(editingCarry))}><Check className="w-4 h-4" /></button>
                      <button className="text-muted-foreground hover:text-white" onClick={() => setEditingClub(null)}><X className="w-4 h-4" /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-[#C9A84C] font-bold">{c.avgCarry}<span className="text-xs text-muted-foreground ml-1">yds</span></span>
                      <button className="text-muted-foreground hover:text-white p-1 rounded" onClick={() => { setEditingClub(c.club); setEditingCarry(String(c.avgCarry)); }}>
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      {c.manualOverride && (
                        <button className="text-muted-foreground hover:text-red-400 p-1 rounded" onClick={() => deleteClubOverride(c.club)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          {/* ── Gap Analysis ── */}
          {(clubGapping?.gaps ?? []).length > 0 && (
            <Card className="glass-card border-none border-orange-500/20 bg-orange-500/5">
              <CardHeader>
                <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-orange-400" /> Gap Analysis
                  <Badge className="bg-orange-500/20 text-orange-400 border-0 text-xs">{clubGapping!.gaps.length} gap{clubGapping!.gaps.length !== 1 ? 's' : ''} found</Badge>
                </CardTitle>
                <p className="text-xs text-muted-foreground">Gaps &gt;15 yards between consecutive clubs</p>
              </CardHeader>
              <CardContent className="space-y-3">
                {(clubGapping?.gaps ?? []).map((gap, i) => (
                  <div key={i} className="flex items-start gap-3 p-3 bg-orange-500/5 rounded-xl border border-orange-500/10">
                    <div className="w-6 h-6 rounded-full bg-orange-500/20 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-orange-400 text-xs font-bold">{gap.gapYards}</span>
                    </div>
                    <p className="text-sm text-white/80">{gap.suggestion}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {clubProfile.length === 0 && (!clubGapping || clubGapping.clubs.length === 0) && (
            <Card className="glass-panel p-12 text-center border-dashed">
              <BarChart3 className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
              <p className="text-white font-medium">No club distance data yet</p>
              <p className="text-sm text-muted-foreground mt-1">Use "Add Club" above to enter your carry distances, or connect your Garmin to track them automatically.</p>
            </Card>
          )}
        </TabsContent>

        {/* ── Practice ── */}
        <TabsContent value="practice" className="space-y-6 mt-6">
          {/* Stats bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'This Week', value: practiceStats?.thisWeek ?? 0, unit: 'sessions' },
              { label: 'This Month', value: practiceStats?.thisMonth ?? 0, unit: 'sessions' },
              { label: 'Current Streak', value: practiceStats?.streak ?? 0, unit: 'days' },
              { label: 'Total Sessions', value: practiceStats?.total ?? 0, unit: 'all time' },
            ].map(s => (
              <Card key={s.label} className="glass-card border-none p-4 text-center">
                <p className="text-2xl font-bold text-[#C9A84C]">{s.value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{s.label}</p>
                <p className="text-xs text-white/30">{s.unit}</p>
              </Card>
            ))}
          </div>

          {/* Task #2044 — personal Tip-driven vs Manual practice split. */}
          {practiceCohort && (
            <Card className="glass-card border-none" data-testid="practice-cohort-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#C9A84C]" /> Tip-driven vs Manual — last {practiceCohort.windowDays} days
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-end gap-3" data-testid="practice-cohort-filters">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-wide text-muted-foreground">From</label>
                    <input
                      type="date"
                      value={cohortFromDate}
                      onChange={e => setCohortFromDate(e.target.value)}
                      className="h-8 rounded bg-black/40 border border-white/10 px-2 text-xs text-white"
                      data-testid="practice-cohort-filter-from"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-wide text-muted-foreground">To</label>
                    <input
                      type="date"
                      value={cohortToDate}
                      onChange={e => setCohortToDate(e.target.value)}
                      className="h-8 rounded bg-black/40 border border-white/10 px-2 text-xs text-white"
                      data-testid="practice-cohort-filter-to"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Club</label>
                    <select
                      value={cohortClubFilter}
                      onChange={e => setCohortClubFilter(e.target.value)}
                      className="h-8 rounded bg-black/40 border border-white/10 px-2 text-xs text-white"
                      data-testid="practice-cohort-filter-club"
                    >
                      <option value="">All clubs</option>
                      {[
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
                      ].map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  {(cohortFromDate !== cohortDefaultRange.from
                    || cohortToDate !== cohortDefaultRange.to
                    || cohortClubFilter) && (
                    <button
                      type="button"
                      onClick={() => {
                        setCohortFromDate(cohortDefaultRange.from);
                        setCohortToDate(cohortDefaultRange.to);
                        setCohortClubFilter('');
                      }}
                      className="h-8 px-3 rounded text-xs text-white border border-white/10 hover:bg-white/5"
                      data-testid="practice-cohort-filter-reset"
                    >
                      Reset
                    </button>
                  )}
                </div>
                {practiceCohort.summary.totalSessions === 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="practice-cohort-empty">
                    No practice sessions in this range.
                  </p>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="text-center" data-testid="practice-cohort-tip-driven">
                    <p className="text-2xl font-bold text-[#C9A84C]">{practiceCohort.summary.tipDrivenSessions}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Tip-driven</p>
                  </div>
                  <div className="text-center" data-testid="practice-cohort-manual">
                    <p className="text-2xl font-bold text-white">{practiceCohort.summary.manualSessions}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Manual</p>
                  </div>
                  <div className="text-center" data-testid="practice-cohort-conversion">
                    <p className="text-2xl font-bold text-[#C9A84C]">
                      {practiceCohort.summary.conversionRate !== null
                        ? `${practiceCohort.summary.conversionRate.toFixed(0)}%`
                        : '—'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Tips converted ({practiceCohort.summary.tipsConverted}/{practiceCohort.summary.activeTipClubKeys.length})
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold text-white">
                      {practiceCohort.summary.tipDrivenMinutes + practiceCohort.summary.manualMinutes}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">Total minutes</p>
                  </div>
                </div>

                {/* Task #2044 — A/B headline. Side-by-side mean proximity
                    improvement (ft) for clubs in the tip-cohort vs the
                    manual-cohort. Positive = closer to the pin since the
                    prior window. Only shown when at least one cohort has
                    enough data to compare. */}
                {(practiceCohort.summary.tipCohortClubs > 0 || practiceCohort.summary.manualCohortClubs > 0) && (
                  <div
                    className="grid grid-cols-2 gap-3 p-3 bg-white/5 rounded-lg border border-white/10"
                    data-testid="practice-cohort-ab-headline"
                  >
                    <div className="text-center" data-testid="practice-cohort-ab-tip">
                      <p className="text-xs text-muted-foreground">Tip-driven clubs</p>
                      <p
                        className={`text-2xl font-bold mt-1 ${
                          practiceCohort.summary.tipCohortAvgImprovementFt !== null && practiceCohort.summary.tipCohortAvgImprovementFt > 0
                            ? 'text-emerald-400'
                            : practiceCohort.summary.tipCohortAvgImprovementFt !== null && practiceCohort.summary.tipCohortAvgImprovementFt < 0
                              ? 'text-red-400'
                              : 'text-white'
                        }`}
                      >
                        {practiceCohort.summary.tipCohortAvgImprovementFt === null
                          ? '—'
                          : practiceCohort.summary.tipCohortAvgImprovementFt > 0
                            ? `−${practiceCohort.summary.tipCohortAvgImprovementFt.toFixed(1)} ft`
                            : practiceCohort.summary.tipCohortAvgImprovementFt < 0
                              ? `+${Math.abs(practiceCohort.summary.tipCohortAvgImprovementFt).toFixed(1)} ft`
                              : 'no change'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        avg improvement, {practiceCohort.summary.tipCohortClubs} club{practiceCohort.summary.tipCohortClubs === 1 ? '' : 's'}
                      </p>
                    </div>
                    <div className="text-center" data-testid="practice-cohort-ab-manual">
                      <p className="text-xs text-muted-foreground">Manual clubs</p>
                      <p
                        className={`text-2xl font-bold mt-1 ${
                          practiceCohort.summary.manualCohortAvgImprovementFt !== null && practiceCohort.summary.manualCohortAvgImprovementFt > 0
                            ? 'text-emerald-400'
                            : practiceCohort.summary.manualCohortAvgImprovementFt !== null && practiceCohort.summary.manualCohortAvgImprovementFt < 0
                              ? 'text-red-400'
                              : 'text-white'
                        }`}
                      >
                        {practiceCohort.summary.manualCohortAvgImprovementFt === null
                          ? '—'
                          : practiceCohort.summary.manualCohortAvgImprovementFt > 0
                            ? `−${practiceCohort.summary.manualCohortAvgImprovementFt.toFixed(1)} ft`
                            : practiceCohort.summary.manualCohortAvgImprovementFt < 0
                              ? `+${Math.abs(practiceCohort.summary.manualCohortAvgImprovementFt).toFixed(1)} ft`
                              : 'no change'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        avg improvement, {practiceCohort.summary.manualCohortClubs} club{practiceCohort.summary.manualCohortClubs === 1 ? '' : 's'}
                      </p>
                    </div>
                  </div>
                )}

                {practiceCohort.byClub.length > 0 && (
                  <div className="overflow-x-auto mt-2">
                    <table className="w-full text-sm" data-testid="practice-cohort-club-table">
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground border-b border-white/10">
                          <th className="px-2 py-1.5">Club</th>
                          <th className="px-2 py-1.5 text-right">Tip-driven</th>
                          <th className="px-2 py-1.5 text-right">Manual</th>
                          <th className="px-2 py-1.5 text-right">Now (ft)</th>
                          <th className="px-2 py-1.5 text-right">Prior (ft)</th>
                          <th className="px-2 py-1.5 text-right">Improvement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {practiceCohort.byClub.map(row => (
                          <tr
                            key={row.clubKey}
                            className="border-b border-white/5"
                            data-testid={`practice-cohort-club-row-${row.clubKey}`}
                          >
                            <td className="px-2 py-1.5 text-white uppercase text-xs">{row.clubKey}</td>
                            <td className="px-2 py-1.5 text-right text-amber-300">{row.tipDrivenSessions}</td>
                            <td className="px-2 py-1.5 text-right text-muted-foreground">{row.manualSessions}</td>
                            <td className="px-2 py-1.5 text-right text-white">
                              {row.currentMeanProximityFt !== null ? row.currentMeanProximityFt.toFixed(1) : '—'}
                            </td>
                            <td className="px-2 py-1.5 text-right text-muted-foreground">
                              {row.priorMeanProximityFt !== null ? row.priorMeanProximityFt.toFixed(1) : '—'}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {row.proximityImprovementFt === null ? (
                                <span className="text-muted-foreground">—</span>
                              ) : row.proximityImprovementFt > 0 ? (
                                <span className="text-emerald-400">−{row.proximityImprovementFt.toFixed(1)} ft</span>
                              ) : row.proximityImprovementFt < 0 ? (
                                <span className="text-red-400">+{Math.abs(row.proximityImprovementFt).toFixed(1)} ft</span>
                              ) : (
                                <span className="text-muted-foreground">no change</span>
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
          )}

          {/* Activity Heatmap */}
          {practiceStats && (
            <Card className="glass-card border-none">
              <CardHeader className="pb-2">
                <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#C9A84C]" /> Practice Activity — Last 52 Weeks
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(() => {
                  const heatmap = practiceStats.heatmap ?? {};
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  // Start on the Sunday 52 weeks ago
                  const startDate = new Date(today);
                  startDate.setDate(startDate.getDate() - 52 * 7);
                  startDate.setDate(startDate.getDate() - startDate.getDay());
                  const weeks: Date[][] = [];
                  const cursor = new Date(startDate);
                  while (cursor <= today) {
                    const week: Date[] = [];
                    for (let d = 0; d < 7; d++) {
                      week.push(new Date(cursor));
                      cursor.setDate(cursor.getDate() + 1);
                    }
                    weeks.push(week);
                  }
                  const maxVal = Math.max(1, ...Object.values(heatmap));
                  const cellColor = (count: number) => {
                    if (!count) return 'bg-white/5';
                    const intensity = count / maxVal;
                    if (intensity < 0.25) return 'bg-yellow-900/50';
                    if (intensity < 0.5) return 'bg-yellow-700/70';
                    if (intensity < 0.75) return 'bg-yellow-500/80';
                    return 'bg-[#C9A84C]';
                  };
                  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                  const days = ['S','M','T','W','T','F','S'];
                  return (
                    <div className="overflow-x-auto">
                      <div className="flex gap-1 min-w-0">
                        {/* Day labels */}
                        <div className="flex flex-col gap-0.5 mr-1 pt-5">
                          {days.map((d, i) => (
                            <div key={i} className="h-3 text-[9px] text-muted-foreground/60 leading-3 w-3 flex items-center justify-center">{i % 2 === 1 ? d : ''}</div>
                          ))}
                        </div>
                        {/* Weeks */}
                        <div className="flex flex-col gap-0">
                          {/* Month labels row */}
                          <div className="flex gap-0.5 mb-0.5 h-4">
                            {weeks.map((week, wi) => {
                              const firstDay = week[0];
                              const showMonth = firstDay.getDate() <= 7 && wi > 0;
                              return (
                                <div key={wi} className="w-3 text-[9px] text-muted-foreground/60 leading-none overflow-visible">
                                  {showMonth ? months[firstDay.getMonth()] : ''}
                                </div>
                              );
                            })}
                          </div>
                          {/* Grid */}
                          <div className="flex gap-0.5">
                            {weeks.map((week, wi) => (
                              <div key={wi} className="flex flex-col gap-0.5">
                                {week.map((day, di) => {
                                  const key = day.toISOString().slice(0, 10);
                                  const count = heatmap[key] ?? 0;
                                  const isFuture = day > today;
                                  return (
                                    <div
                                      key={di}
                                      title={`${key}: ${count} session${count !== 1 ? 's' : ''}`}
                                      className={`w-3 h-3 rounded-[2px] ${isFuture ? 'opacity-0' : cellColor(count)} transition-colors`}
                                    />
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      {/* Legend */}
                      <div className="flex items-center gap-2 mt-3">
                        <span className="text-[10px] text-muted-foreground/60">Less</span>
                        {['bg-white/5', 'bg-yellow-900/50', 'bg-yellow-700/70', 'bg-yellow-500/80', 'bg-[#C9A84C]'].map((c, i) => (
                          <div key={i} className={`w-3 h-3 rounded-[2px] ${c}`} />
                        ))}
                        <span className="text-[10px] text-muted-foreground/60">More</span>
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          )}

          {/* Log Practice button */}
          <div className="flex justify-between items-center">
            <h3 className="text-white font-semibold">Session History</h3>
            <Button
              size="sm"
              onClick={() => {
                // Task #1641 — when the player opens this manually (i.e. not
                // via a coaching tip), reset any leftover tip metadata so the
                // next save isn't mis-attributed to "coaching_tip".
                setLogFormOpen(v => {
                  if (!v) setPracticeForm(EMPTY_PRACTICE_FORM);
                  return !v;
                });
              }}
              className="bg-[#C9A84C] hover:bg-[#b8963e] text-black gap-1"
            >
              <Plus className="w-4 h-4" /> Log Practice
            </Button>
          </div>

          {/* Log form */}
          {logFormOpen && (
            <Card className="glass-card border-[#C9A84C]/30">
              <CardContent className="pt-5 space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {Object.entries(SESSION_TYPE_LABELS).map(([key, { label, icon }]) => (
                    <button key={key} onClick={() => setPracticeForm(f => ({ ...f, sessionType: key }))}
                      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${practiceForm.sessionType === key ? 'border-[#C9A84C] bg-[#C9A84C]/10 text-[#C9A84C]' : 'border-white/10 text-muted-foreground hover:border-white/30'}`}>
                      <span>{icon}</span> {label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Duration (minutes)</label>
                    <input type="number" placeholder="60" value={practiceForm.durationMinutes}
                      onChange={e => setPracticeForm(f => ({ ...f, durationMinutes: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-[#C9A84C]/50" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Club focus (optional)</label>
                    <input type="text" placeholder="e.g. Driver, Wedges" value={practiceForm.clubFocus}
                      onChange={e => setPracticeForm(f => ({ ...f, clubFocus: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-[#C9A84C]/50" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Notes</label>
                  <textarea placeholder="What did you work on?" value={practiceForm.notes} rows={2}
                    onChange={e => setPracticeForm(f => ({ ...f, notes: e.target.value }))}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-[#C9A84C]/50 resize-none" />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      // Task #1641 — clear tip metadata on cancel so a
                      // subsequent manual save isn't mis-tagged as
                      // "coaching_tip" and contaminating cohort splits.
                      setPracticeForm(EMPTY_PRACTICE_FORM);
                      setLogFormOpen(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" disabled={loggingPractice} onClick={logPractice} className="bg-[#C9A84C] hover:bg-[#b8963e] text-black">
                    {loggingPractice ? 'Saving…' : 'Save Session'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Session list */}
          {practiceSessions.length === 0 ? (
            <Card className="glass-panel p-10 text-center border-dashed">
              <Dumbbell className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
              <p className="text-white font-medium">No practice sessions yet</p>
              <p className="text-sm text-muted-foreground mt-1">Tap "Log Practice" to start tracking your improvement.</p>
            </Card>
          ) : (
            <div className="space-y-2">
              {practiceSessions.map(s => {
                const meta = SESSION_TYPE_LABELS[s.sessionType] ?? { label: s.sessionType, icon: '🎯' };
                return (
                  <motion.div key={s.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                    <Card className="glass-card border-none">
                      <CardContent className="py-3 px-4 flex items-center gap-3">
                        <span className="text-2xl">{meta.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-white text-sm font-medium">{meta.label}</p>
                            {s.clubFocus && <Badge className="bg-[#C9A84C]/15 text-[#C9A84C] border-0 text-xs">{s.clubFocus}</Badge>}
                            {/* Task #1641 — distinguish tip-driven sessions
                                from manual ones so the cohort split is
                                visible to players too, not just analytics. */}
                            {s.source === 'coaching_tip' && (
                              <Badge
                                data-testid="practice-session-from-tip-badge"
                                className="bg-amber-400/15 text-amber-300 border-0 text-xs"
                              >
                                From coaching tip
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                            <span>{new Date(s.sessionDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
                            {s.durationMinutes && <span className="flex items-center gap-0.5"><Clock className="w-3 h-3" />{s.durationMinutes}m</span>}
                            {s.practiceDistanceYards != null && (
                              <span>{s.practiceDistanceYards} yds</span>
                            )}
                          </div>
                          {s.notes && <p className="text-xs text-white/50 mt-1 truncate">{s.notes}</p>}
                        </div>
                        <button onClick={() => deletePractice(s.id)} className="text-muted-foreground hover:text-red-400 transition-colors p-1">
                          <X className="w-4 h-4" />
                        </button>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Achievements ── */}
        <TabsContent value="achievements" className="space-y-6 mt-6">
          {achLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">{[...Array(8)].map((_, i) => <div key={i} className="h-32 glass-card rounded-2xl animate-pulse" />)}</div>
          ) : !achievements || achievements.length === 0 ? (
            <Card className="glass-panel p-12 text-center border-dashed">
              <Award className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
              <p className="text-white font-medium">No achievements yet</p>
              <p className="text-sm text-muted-foreground mt-1">Play your first tournament to start earning badges!</p>
            </Card>
          ) : (
            <div className="space-y-6">
              <p className="text-sm text-muted-foreground">{achievements.length} badge{achievements.length !== 1 ? 's' : ''} earned</p>
              {(['milestone', 'scoring', 'consistency', 'social', 'seasonal'] as const).map(cat => {
                const catAch = achievements.filter(a => a.badgeCategory === cat);
                if (catAch.length === 0) return null;
                return (
                  <div key={cat}>
                    <h3 className="text-sm font-semibold text-white mb-3 capitalize">{cat}</h3>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                      {catAch.map(a => (
                        <motion.div key={a.id} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
                          <div className={`rounded-2xl border p-4 flex flex-col items-center text-center gap-2 ${BADGE_CATEGORY_COLORS[a.badgeCategory] ?? 'bg-white/5 border-white/10 text-white'}`}>
                            <span className="text-3xl">{a.badgeIcon}</span>
                            <p className="text-xs font-semibold leading-tight">{a.badgeLabel}</p>
                            <p className="text-xs opacity-60">{new Date(a.earnedAt).toLocaleDateString()}</p>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Compare ── */}
        <TabsContent value="compare" className="space-y-6 mt-6">
          <Card className="glass-card border-none">
            <CardHeader>
              <CardTitle className="text-white text-base flex items-center gap-2">
                <GitCompare className="w-5 h-5 text-[#C9A84C]" /> Head-to-Head Comparison
              </CardTitle>
              <p className="text-xs text-muted-foreground">Compare your stats side-by-side with another member</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Member Picker */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input type="text" placeholder="Search members…" value={compareSearch}
                  onChange={e => setCompareSearch(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-[#C9A84C]/50" />
              </div>
              {compareMembers.length === 0 && (
                <p className="text-muted-foreground text-sm text-center py-4">No other members found. Join an organization to compare with club members.</p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 max-h-48 overflow-y-auto">
                {filteredOrgMembers.map(m => (
                  <button key={m.userId}
                    onClick={() => setCompareUserId(compareUserId === m.userId ? null : m.userId)}
                    className={`text-left rounded-xl px-3 py-2 text-sm transition-colors border ${compareUserId === m.userId ? 'border-[#C9A84C] bg-[#C9A84C]/15 text-white' : 'border-white/10 text-muted-foreground hover:border-white/30 hover:text-white'}`}>
                    {m.displayName}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Comparison Grid */}
          {compareUserId && (
            compareFetching ? (
              <div className="grid grid-cols-3 gap-4">{[...Array(6)].map((_, i) => <div key={i} className="h-20 glass-card rounded-2xl animate-pulse" />)}</div>
            ) : compareStats ? (
              <div className="space-y-4">
                {/* Names header */}
                <div className="grid grid-cols-3 text-center gap-4">
                  <div className="text-sm font-semibold text-[#C9A84C]">{compareStats.me.displayName}</div>
                  <div className="text-xs text-muted-foreground flex items-center justify-center">vs</div>
                  <div className="text-sm font-semibold text-blue-400">{compareStats.them.displayName}</div>
                </div>
                {/* Stats rows */}
                {[
                  { label: 'Handicap Index', me: compareStats.me.handicapIndex?.toFixed(1) ?? '—', them: compareStats.them.handicapIndex?.toFixed(1) ?? '—', lowerBetter: true },
                  { label: 'Rounds Played', me: compareStats.me.roundsPlayed, them: compareStats.them.roundsPlayed, lowerBetter: false },
                  { label: 'Scoring Avg', me: compareStats.me.scoringAvg?.toFixed(1) ?? '—', them: compareStats.them.scoringAvg?.toFixed(1) ?? '—', lowerBetter: true },
                  { label: 'GIR %', me: compareStats.me.girPct !== null ? `${compareStats.me.girPct}%` : '—', them: compareStats.them.girPct !== null ? `${compareStats.them.girPct}%` : '—', lowerBetter: false },
                  { label: 'Fairway %', me: compareStats.me.fairwayPct !== null ? `${compareStats.me.fairwayPct}%` : '—', them: compareStats.them.fairwayPct !== null ? `${compareStats.them.fairwayPct}%` : '—', lowerBetter: false },
                  { label: 'Avg Putts/Hole', me: compareStats.me.avgPutts?.toFixed(2) ?? '—', them: compareStats.them.avgPutts?.toFixed(2) ?? '—', lowerBetter: true },
                  { label: 'SG: Putting', me: compareStats.me.sgPutting !== null ? (compareStats.me.sgPutting >= 0 ? '+' : '') + compareStats.me.sgPutting?.toFixed(2) : '—', them: compareStats.them.sgPutting !== null ? (compareStats.them.sgPutting >= 0 ? '+' : '') + compareStats.them.sgPutting?.toFixed(2) : '—', lowerBetter: false },
                  { label: 'SG: Approach', me: compareStats.me.sgApproach !== null ? (compareStats.me.sgApproach >= 0 ? '+' : '') + compareStats.me.sgApproach?.toFixed(2) : '—', them: compareStats.them.sgApproach !== null ? (compareStats.them.sgApproach >= 0 ? '+' : '') + compareStats.them.sgApproach?.toFixed(2) : '—', lowerBetter: false },
                ].map((row, i) => {
                  const meNum = typeof row.me === 'number' ? row.me : parseFloat(String(row.me).replace(/[^0-9.-]/g, ''));
                  const themNum = typeof row.them === 'number' ? row.them : parseFloat(String(row.them).replace(/[^0-9.-]/g, ''));
                  const meWins = !isNaN(meNum) && !isNaN(themNum) && (row.lowerBetter ? meNum < themNum : meNum > themNum);
                  const themWins = !isNaN(meNum) && !isNaN(themNum) && (row.lowerBetter ? themNum < meNum : themNum > meNum);
                  return (
                    <div key={i} className="grid grid-cols-3 gap-4 items-center py-2 border-b border-white/5 last:border-0">
                      <div className={`text-center font-semibold text-base ${meWins ? 'text-green-400' : 'text-white'}`}>{row.me}</div>
                      <div className="text-xs text-muted-foreground text-center">{row.label}</div>
                      <div className={`text-center font-semibold text-base ${themWins ? 'text-green-400' : 'text-white'}`}>{row.them}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-8">Could not load comparison data.</p>
            )
          )}
        </TabsContent>

        {/* ── Devices / Wearables ── */}
        <TabsContent value="devices" className="space-y-6 mt-6">
          <div className="space-y-4">
            {WEARABLE_PROVIDERS.map(p => {
              const connected = wearables?.find(w => w.provider === p.id);
              return (
                <Card key={p.id} className="glass-card border-none">
                  <CardContent className="p-5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <span className="text-2xl">{p.icon}</span>
                      <div>
                        <p className="text-white font-semibold text-sm">{p.label}</p>
                        <p className="text-xs text-muted-foreground">{p.description}</p>
                        {connected?.lastSyncAt && (
                          <p className="text-xs text-muted-foreground mt-0.5">Last sync: {new Date(connected.lastSyncAt).toLocaleDateString()}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {connected ? (
                        <>
                          <Badge className="bg-green-500/20 text-green-400 border-green-500/40 gap-1">
                            <Wifi className="w-3 h-3" /> Connected
                          </Badge>
                          <Button size="sm" variant="outline" className="border-red-500/30 text-red-400 hover:bg-red-500/10 text-xs"
                            onClick={() => unlinkWearable.mutate(p.id)} disabled={unlinkWearable.isPending}>
                            <Trash2 className="w-3 h-3 mr-1" /> Remove
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="outline" className="border-primary/30 text-primary hover:bg-primary/10 text-xs"
                          onClick={() => {
                            if (p.id === 'garmin' || p.id === 'arccos') {
                              alert(`${p.label} OAuth integration requires API credentials configured by your club admin. Contact your administrator to enable this integration.`);
                              return;
                            }
                            linkWearable.mutate(p.id);
                          }}
                          disabled={linkWearable.isPending}>
                          <WifiOff className="w-3 h-3 mr-1" /> Connect
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* ── Strokes Gained ── */}
          {stats?.strokesGained && stats.strokesGained.trackedRounds >= 5 ? (
            <Card className="glass-card border-none">
              <CardHeader>
                <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
                  <Zap className="w-4 h-4 text-yellow-400" /> Strokes Gained
                  <span className="text-xs font-normal text-yellow-300/60 ml-1">
                    vs {stats.strokesGained.baseline === 'scratch' ? 'Tour/Scratch' : `${stats.strokesGained.baseline}-hcp`} baseline
                  </span>
                </CardTitle>
                <p className="text-xs text-muted-foreground">{stats.strokesGained.trackedRounds} tracked rounds · positive = better than baseline</p>
                {(stats.strokesGained.sgPuttingMeasuredRounds !== undefined || stats.strokesGained.sgPuttingEstimatedRounds !== undefined) && ((stats.strokesGained.sgPuttingMeasuredRounds ?? 0) + (stats.strokesGained.sgPuttingEstimatedRounds ?? 0) > 0) && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    SG-Putting split: {stats.strokesGained.sgPuttingMeasuredRounds ?? 0} measured · {stats.strokesGained.sgPuttingEstimatedRounds ?? 0} estimated
                  </p>
                )}
              </CardHeader>
              <CardContent className="p-4 pt-0 grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[
                  { label: 'SG: Putting', value: stats.strokesGained.sgPutting, note: '≥5 putts-tracked rounds' },
                  { label: 'SG: Approach', value: stats.strokesGained.sgApproach, note: 'GIR vs baseline rate' },
                  { label: 'SG: Around Green', value: stats.strokesGained.sgATG, note: 'Chips from missed GIR' },
                  { label: 'SG: Off the Tee', value: stats.strokesGained.sgOffTheTee, note: 'FIR vs baseline rate' },
                  { label: 'SG: Total', value: stats.strokesGained.sgTotal, note: 'Combined categories' },
                ].map((sg) => (
                  <div key={sg.label} className="bg-white/5 rounded-xl p-3 text-center">
                    <p className="text-xs text-muted-foreground mb-1">{sg.label}</p>
                    {sg.value !== null ? (
                      <p className={`text-xl font-bold font-display ${sg.value >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {sg.value >= 0 ? '+' : ''}{sg.value.toFixed(2)}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">—</p>
                    )}
                    <p className="text-[10px] text-muted-foreground mt-0.5 opacity-60">{sg.note}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : (
            <Card className="glass-panel border border-yellow-500/20">
              <CardContent className="p-4 flex items-start gap-3">
                <Zap className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="text-white font-semibold mb-1">Strokes Gained Analysis</p>
                  <p className="text-muted-foreground text-xs">
                    {stats?.strokesGained && stats.strokesGained.trackedRounds > 0
                      ? `${stats.strokesGained.trackedRounds} of 5 required rounds tracked. Keep recording putts, GIR, and fairways to unlock SG analysis (Putting, Approach, Around-the-Green, Off-the-Tee).`
                      : 'Once you complete 5+ rounds with putts, GIR, and fairway tracking, Strokes Gained analysis will appear here — Putting, Approach, Around-the-Green, and Off-the-Tee vs your chosen baseline.'}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Club Leaderboards (admin only) ── */}
        {isAdmin && (
          <TabsContent value="clubstats" className="space-y-6 mt-6">
            {clubLoading ? (
              <div className="grid grid-cols-2 gap-4">{[...Array(4)].map((_, i) => <div key={i} className="h-48 glass-card rounded-2xl animate-pulse" />)}</div>
            ) : !clubStats ? (
              <p className="text-muted-foreground text-sm">No club data available.</p>
            ) : (
              <>
                {/* Totals */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    { label: 'Total Events', value: clubStats.totals.tournaments, icon: Trophy2 },
                    { label: 'Total Players', value: clubStats.totals.players, icon: Users },
                    { label: 'Rounds Played', value: clubStats.totals.rounds, icon: Activity },
                    { label: 'Scores Posted', value: clubStats.totals.scores, icon: Target },
                  ].map((s, i) => (
                    <Card key={i} className="glass-card border-none">
                      <CardContent className="p-4 text-center">
                        <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
                        <p className="text-2xl font-bold text-white font-display">{s.value.toLocaleString()}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Monthly Growth */}
                  <Card className="glass-card border-none">
                    <CardHeader><CardTitle className="text-white text-sm font-semibold">Monthly Player Growth</CardTitle></CardHeader>
                    <CardContent>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={clubStats.monthlyPlayerGrowth}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="month" tick={{ fill: '#6b7280', fontSize: 10 }} />
                          <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} allowDecimals={false} />
                          <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
                          <Bar dataKey="players" fill="#22c55e" radius={[4, 4, 0, 0]} name="New Players" />
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>

                  {/* Format Popularity */}
                  <Card className="glass-card border-none">
                    <CardHeader><CardTitle className="text-white text-sm font-semibold">Format Popularity</CardTitle></CardHeader>
                    <CardContent>
                      <ResponsiveContainer width="100%" height={200}>
                        <PieChart>
                          <Pie
                            data={clubStats.formatPopularity}
                            dataKey="count"
                            nameKey="format"
                            cx="50%"
                            cy="50%"
                            outerRadius={75}
                            // recharts v3 dropped derived data fields
                            // (like `count`) from PieLabelRenderProps; pull
                            // them off the underlying row payload instead.
                            label={(props: { payload?: { format?: string; count?: number } }) => {
                              const { format, count } = props.payload ?? {};
                              return `${format ?? ''} (${count ?? 0})`;
                            }}
                          >
                            {clubStats.formatPopularity.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                          </Pie>
                          <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>

                  {/* Best Scoring Average */}
                  <Card className="glass-card border-none">
                    <CardHeader><CardTitle className="text-white text-sm font-semibold">Best Scoring Average</CardTitle></CardHeader>
                    <CardContent>
                      {clubStats.bestScoringAverage.length === 0 ? (
                        <p className="text-muted-foreground text-sm text-center py-4">No data yet</p>
                      ) : (
                        <div className="space-y-2">
                          {clubStats.bestScoringAverage.map((p, i) => (
                            <div key={i} className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground w-5 text-center">{i + 1}</span>
                                <span className="text-white">{p.playerName}</span>
                                <span className="text-xs text-muted-foreground">({p.rounds} rounds)</span>
                              </div>
                              <span className="font-semibold text-green-400">{p.avgGross}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Most Birdies */}
                  <Card className="glass-card border-none">
                    <CardHeader><CardTitle className="text-white text-sm font-semibold">Most Birdies 🐦</CardTitle></CardHeader>
                    <CardContent>
                      {clubStats.mostBirdies.length === 0 ? (
                        <p className="text-muted-foreground text-sm text-center py-4">No birdies recorded yet</p>
                      ) : (
                        <div className="space-y-2">
                          {clubStats.mostBirdies.map((p, i) => (
                            <div key={i} className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground w-5 text-center">{i + 1}</span>
                                <span className="text-white">{p.playerName}</span>
                              </div>
                              <span className="font-semibold text-yellow-400">{p.birdies} 🐦</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Most Eagles */}
                  <Card className="glass-card border-none">
                    <CardHeader><CardTitle className="text-white text-sm font-semibold">Most Eagles 🦅</CardTitle></CardHeader>
                    <CardContent>
                      {clubStats.mostEagles.length === 0 ? (
                        <p className="text-muted-foreground text-sm text-center py-4">No eagles recorded yet</p>
                      ) : (
                        <div className="space-y-2">
                          {clubStats.mostEagles.map((p, i) => (
                            <div key={i} className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground w-5 text-center">{i + 1}</span>
                                <span className="text-white">{p.playerName}</span>
                              </div>
                              <span className="font-semibold text-amber-400">{p.eagles} 🦅</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Consistency Leaders */}
                  <Card className="glass-card border-none">
                    <CardHeader><CardTitle className="text-white text-sm font-semibold">Most Rounds Played</CardTitle></CardHeader>
                    <CardContent>
                      {clubStats.consistencyLeaders.length === 0 ? (
                        <p className="text-muted-foreground text-sm text-center py-4">No data yet</p>
                      ) : (
                        <div className="space-y-2">
                          {clubStats.consistencyLeaders.map((p, i) => (
                            <div key={i} className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground w-5 text-center">{i + 1}</span>
                                <span className="text-white">{p.playerName}</span>
                              </div>
                              <span className="font-semibold text-emerald-400">{p.rounds}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* Event Participation */}
                {clubStats.eventParticipation.length > 0 && (
                  <Card className="glass-card border-none">
                    <CardHeader><CardTitle className="text-white text-sm font-semibold">Event Participation (Recent)</CardTitle></CardHeader>
                    <CardContent>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={clubStats.eventParticipation} layout="vertical">
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis type="number" tick={{ fill: '#6b7280', fontSize: 10 }} />
                          <YAxis type="category" dataKey="name" width={120} tick={{ fill: '#6b7280', fontSize: 10 }} />
                          <Tooltip contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
                          <Bar dataKey="players" fill="#3b82f6" radius={[0, 4, 4, 0]} name="Players" />
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function Trophy2({ className }: { className?: string }) {
  return <BarChart3 className={className} />;
}
