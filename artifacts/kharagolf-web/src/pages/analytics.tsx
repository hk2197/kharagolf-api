import { useState, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  AreaChart, Area,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  TrendingUp, TrendingDown, Minus, BarChart2, RefreshCw,
  Download, Mail, Plus, Trash2, Calendar, Loader2, ChevronDown,
  DollarSign, Users, Clock, Activity, Tag, Trophy, Share2, ArrowDown,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useToast } from '@/hooks/use-toast';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
function API(path: string) { return `${BASE_URL}/api${path}`; }

const CHART_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 Days' },
  { value: 'month', label: 'This Month' },
  { value: 'quarter', label: 'This Quarter' },
  { value: 'year', label: 'This Year' },
];

const PRE_BUILT_CHARTS: Record<string, string> = {
  'revenue-by-department': 'bar',
  'membership-growth': 'line',
  'tee-fill-rates': 'area',
  'lesson-bookings': 'bar',
  'fb-orders': 'area',
  'event-income': 'pie',
  'tournament-participation': 'bar',
  'pos-top-sellers': 'bar',
  'membership-revenue': 'pie',
  'revenue-comparison': 'bar',
};

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface KpiData {
  period: string;
  from: string;
  to: string;
  kpis: {
    totalRevenue: { value: number; prevValue: number; change: number | null; breakdown: Record<string, number> };
    activeMembers: { value: number; prevValue: number; change: number | null };
    teeSheetUtilisation: { value: number; totalSlots: number; bookedSlots: number };
    teeBookings: { value: number; prevValue: number; change: number | null };
    tournaments: { value: number; players: number };
    pendingEventEnquiries: { value: number };
  };
  topShopItems: { name: string; category: string | null; qty: number; revenue: number }[];
}

interface ReportData {
  reportId: string;
  period: string;
  data: unknown;
}

interface ShareLeaderboardEntry {
  userId: number;
  displayName: string | null;
  username: string | null;
  publicHandle: string | null;
  total: number;
  byMethod: { copy: number; web_share: number; native_share: number; qr_open: number };
}
interface ShareLeaderboardData {
  period: string;
  from: string;
  to: string;
  limit: number;
  totals: { total: number; byMethod: { copy: number; web_share: number; native_share: number; qr_open: number } };
  leaderboard: ShareLeaderboardEntry[];
}

interface VisitsBySource {
  web: number;
  mobile: number;
  crawler: number;
  unknown: number;
}

interface BadgeShareEntry {
  badgeType: string;
  label: string;
  icon: string;
  category: string | null;
  total: number;
  byMethod: { copy: number; web_share: number; native_share: number };
  // Task #1798 — visits attributed to this badge's public-profile page
  // over the same period (crawler hits excluded). `conversionRate` is
  // visits/shares; null when this badge had zero shares so the cell can
  // render "—" instead of dividing by zero.
  visits: number;
  visitsBySource: VisitsBySource;
  conversionRate: number | null;
}
interface BadgeShareLeaderboardData {
  period: string;
  from: string;
  to: string;
  totals: {
    total: number;
    byMethod: { copy: number; web_share: number; native_share: number };
    // Task #1798 — org-wide rollups so the leaderboard card header can
    // show a single "shares → visits" headline for the whole org.
    visits: number;
    visitsBySource: VisitsBySource;
    conversionRate: number | null;
  };
  badges: BadgeShareEntry[];
}

interface BadgeShareMemberEntry {
  userId: number;
  displayName: string | null;
  username: string | null;
  publicHandle: string | null;
  total: number;
  byMethod: { copy: number; web_share: number; native_share: number };
  // Task #1798 — per-member visit count + conversion ratio for the
  // selected badge so the drill-down sheet can show whether the people
  // sharing the most are also the people whose badges actually drive
  // visits back to their profile.
  visits: number;
  visitsBySource: VisitsBySource;
  conversionRate: number | null;
}
interface BadgeShareMemberBreakdownData {
  period: string;
  from: string;
  to: string;
  badge: { badgeType: string; label: string; icon: string; category: string | null };
  totals: {
    total: number;
    byMethod: { copy: number; web_share: number; native_share: number };
    // Task #1798 — badge-wide visit total + conversion ratio so the
    // drill-down sheet's header chip mirrors the org-wide one.
    visits: number;
    visitsBySource: VisitsBySource;
    conversionRate: number | null;
  };
  members: BadgeShareMemberEntry[];
}

interface Schedule {
  id: string;
  reportId: string;
  reportName: string;
  frequency: string;
  recipientEmail: string;
  recipientName: string;
  period: string;
  nextRunAt: string;
  lastRunAt: string | null;
}

function formatCurrency(val: number) {
  if (val >= 100000) return `₹${(val / 100000).toFixed(1)}L`;
  if (val >= 1000) return `₹${(val / 1000).toFixed(1)}K`;
  return `₹${val.toFixed(0)}`;
}

function ChangeIndicator({ change }: { change: number | null }) {
  if (change === null) return <span className="text-xs text-muted-foreground">—</span>;
  if (change > 0) return <span className="flex items-center gap-0.5 text-xs text-green-400"><TrendingUp className="w-3 h-3" />+{change}%</span>;
  if (change < 0) return <span className="flex items-center gap-0.5 text-xs text-red-400"><TrendingDown className="w-3 h-3" />{change}%</span>;
  return <span className="flex items-center gap-0.5 text-xs text-muted-foreground"><Minus className="w-3 h-3" />0%</span>;
}

function KpiCard({
  title, value, prevValue, change, icon: Icon, color = 'text-primary', suffix = '', formatFn,
}: {
  title: string;
  value: number;
  prevValue?: number;
  change?: number | null;
  icon: React.ComponentType<{ className?: string }>;
  color?: string;
  suffix?: string;
  formatFn?: (v: number) => string;
}) {
  const display = formatFn ? formatFn(value) : `${value}${suffix}`;
  return (
    <Card className="glass-card border-none">
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <p className="text-xs text-muted-foreground mb-1">{title}</p>
            <p className={`text-2xl font-bold ${color}`}>{display}</p>
            {prevValue !== undefined && change !== undefined && (
              <div className="flex items-center gap-2 mt-1">
                <ChangeIndicator change={change ?? null} />
                <span className="text-xs text-muted-foreground">vs prev period</span>
              </div>
            )}
          </div>
          <div className={`p-2 rounded-lg bg-white/5 ${color}`}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Stacked bar + legend showing the visit-source mix; crawler kept in
// its own colour so link-preview share is visually distinct.
const SOURCE_COLORS: Record<keyof VisitsBySource, string> = {
  web: 'bg-blue-500',
  mobile: 'bg-violet-500',
  unknown: 'bg-zinc-500',
  crawler: 'bg-amber-500',
};
const SOURCE_LABELS: Record<keyof VisitsBySource, string> = {
  web: 'Web',
  mobile: 'Mobile',
  unknown: 'Unknown',
  crawler: 'Link previews',
};

function MiniSourceBar({
  visitsBySource,
  testIdPrefix,
}: {
  visitsBySource: VisitsBySource;
  testIdPrefix?: string;
}) {
  const order: (keyof VisitsBySource)[] = ['web', 'mobile', 'unknown', 'crawler'];
  const total = order.reduce((s, k) => s + visitsBySource[k], 0);
  if (total === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={testIdPrefix ? `${testIdPrefix}-empty` : undefined}>
        No visits yet
      </p>
    );
  }
  return (
    <div className="space-y-1.5" data-testid={testIdPrefix}>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        {order.map(k => {
          const n = visitsBySource[k];
          if (n === 0) return null;
          const pct = (n / total) * 100;
          return (
            <div
              key={k}
              className={SOURCE_COLORS[k]}
              style={{ width: `${pct}%` }}
              title={`${SOURCE_LABELS[k]}: ${n} (${Math.round(pct)}%)`}
              data-testid={testIdPrefix ? `${testIdPrefix}-seg-${k}` : undefined}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {order.map(k => {
          const n = visitsBySource[k];
          if (n === 0) return null;
          const pct = Math.round((n / total) * 100);
          return (
            <span
              key={k}
              className="inline-flex items-center gap-1"
              data-testid={testIdPrefix ? `${testIdPrefix}-legend-${k}` : undefined}
            >
              <span className={`inline-block h-2 w-2 rounded-sm ${SOURCE_COLORS[k]}`} />
              {SOURCE_LABELS[k]} {n} ({pct}%)
            </span>
          );
        })}
      </div>
    </div>
  );
}

function RevenueBreakdownChart({ breakdown }: { breakdown: Record<string, number> }) {
  const data = Object.entries(breakdown).map(([key, val]) => ({
    name: key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()),
    value: val,
  })).filter(d => d.value > 0);

  if (data.length === 0) return <p className="text-muted-foreground text-sm">No revenue data</p>;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie data={data} cx="50%" cy="50%" innerRadius={50} outerRadius={90} dataKey="value" nameKey="name">
          {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={(val: number) => [formatCurrency(val), '']} contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }} />
        <Legend formatter={(v) => <span className="text-xs text-muted-foreground">{v}</span>} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function ReportChart({ reportId, data }: { reportId: string; data: unknown }) {
  const chartType = PRE_BUILT_CHARTS[reportId] ?? 'bar';
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];

  if (rows.length === 0 && typeof data !== 'object') {
    return <p className="text-muted-foreground text-sm">No data for this period</p>;
  }

  if (reportId === 'revenue-by-department' && rows.length > 0) {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows} margin={{ left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="department" tick={{ fill: '#9ca3af', fontSize: 10 }} />
          <YAxis tickFormatter={(v) => formatCurrency(Number(v))} tick={{ fill: '#9ca3af', fontSize: 10 }} />
          <Tooltip formatter={(v: number) => [formatCurrency(v), 'Revenue']} contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }} />
          <Bar dataKey="revenue" fill="#22c55e" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (reportId === 'membership-growth' && rows.length > 0) {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="label" tick={{ fill: '#9ca3af', fontSize: 10 }} />
          <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} />
          <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }} />
          <Legend />
          <Line type="monotone" dataKey="active_total" name="Active" stroke="#22c55e" dot={false} />
          <Line type="monotone" dataKey="new_members" name="New" stroke="#3b82f6" dot={false} />
          <Line type="monotone" dataKey="churned" name="Churned" stroke="#ef4444" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (reportId === 'tee-fill-rates' && rows.length > 0) {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 9 }} />
          <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fill: '#9ca3af', fontSize: 10 }} />
          <Tooltip formatter={(v: number) => [`${v}%`, 'Fill Rate']} contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }} />
          <Area type="monotone" dataKey="fill_rate" name="Fill Rate" stroke="#22c55e" fill="rgba(34,197,94,0.15)" />
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  if (reportId === 'event-income' && rows.length > 0) {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie data={rows} cx="50%" cy="50%" outerRadius={100} dataKey="total_revenue" nameKey="status">
            {rows.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
          </Pie>
          <Tooltip formatter={(v: number) => [formatCurrency(v), '']} contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (reportId === 'revenue-comparison' && data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as { current: { label: string; revenue: number }; previous: { label: string; revenue: number } };
    const chartData = [
      { label: d.current.label, revenue: d.current.revenue },
      { label: d.previous.label, revenue: d.previous.revenue },
    ];
    return (
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="label" tick={{ fill: '#9ca3af', fontSize: 11 }} />
          <YAxis tickFormatter={(v) => formatCurrency(Number(v))} tick={{ fill: '#9ca3af', fontSize: 10 }} />
          <Tooltip formatter={(v: number) => [formatCurrency(v), 'Revenue']} contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }} />
          <Bar dataKey="revenue" fill="#22c55e" radius={[4, 4, 0, 0]}>
            {chartData.map((_, i) => <Cell key={i} fill={i === 0 ? '#22c55e' : '#3b82f6'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (rows.length > 0) {
    const firstRow = rows[0];
    const keys = Object.keys(firstRow).filter(k => k !== 'label' && k !== 'date' && k !== 'status' && k !== 'tournament' && k !== 'tier' && k !== 'name' && k !== 'category');
    const xKey = 'label' in firstRow ? 'label' : 'date' in firstRow ? 'date' : 'tournament' in firstRow ? 'tournament' : Object.keys(firstRow)[0];

    if (chartType === 'line') {
      return (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey={xKey} tick={{ fill: '#9ca3af', fontSize: 10 }} />
            <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} />
            <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }} />
            <Legend />
            {keys.map((k, i) => <Line key={k} type="monotone" dataKey={k} stroke={CHART_COLORS[i % CHART_COLORS.length]} dot={false} />)}
          </LineChart>
        </ResponsiveContainer>
      );
    }

    if (chartType === 'area') {
      return (
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey={xKey} tick={{ fill: '#9ca3af', fontSize: 10 }} />
            <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} />
            <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }} />
            <Legend />
            {keys.map((k, i) => <Area key={k} type="monotone" dataKey={k} stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={`${CHART_COLORS[i % CHART_COLORS.length]}22`} />)}
          </AreaChart>
        </ResponsiveContainer>
      );
    }

    return (
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey={xKey} tick={{ fill: '#9ca3af', fontSize: 10 }} />
          <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} />
          <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }} />
          <Legend />
          {keys.map((k, i) => <Bar key={k} dataKey={k} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]} />)}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return <p className="text-muted-foreground text-sm text-center py-8">No data for this period</p>;
}

function exportToCSV(data: unknown, filename: string) {
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] :
    typeof data === 'object' && data !== null ? [data as Record<string, unknown>] : [];

  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map(row => headers.map(h => JSON.stringify(row[h] ?? '')).join(',')),
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function exportToPDF(reportName: string, data: unknown) {
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
  const win = window.open('', '_blank');
  if (!win) return;

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const tableRows = rows.map(row => `<tr>${headers.map(h => `<td style="border:1px solid #ddd;padding:6px;">${escapeHtml(row[h])}</td>`).join('')}</tr>`).join('');
  const safeTitle = escapeHtml(reportName);

  win.document.write(`
    <!DOCTYPE html><html><head><title>${safeTitle}</title>
    <style>body{font-family:Arial,sans-serif;padding:20px;}table{border-collapse:collapse;width:100%;}th{background:#1e4d2b;color:#fff;padding:8px;border:1px solid #ddd;}td{font-size:12px;}</style>
    </head><body>
    <h2>${safeTitle}</h2>
    <p>Generated: ${escapeHtml(new Date().toLocaleString())}</p>
    ${rows.length > 0 ? `<table><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table>` : '<p>No data available</p>'}
    <script>window.print();</script>
    </body></html>
  `);
  win.document.close();
}

export default function AnalyticsPage() {
  const { activeOrgId } = useActiveOrgId();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [period, setPeriod] = useState('month');
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [reportPeriod, setReportPeriod] = useState('month');

  const [customSource, setCustomSource] = useState('pos_transactions');
  const [customMetric, setCustomMetric] = useState('count');
  const [customGroupBy, setCustomGroupBy] = useState('month');
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState(new Date().toISOString().slice(0, 10));

  const [scheduleReportId, setScheduleReportId] = useState('revenue-by-department');
  const [scheduleFreq, setScheduleFreq] = useState<'daily' | 'weekly' | 'monthly'>('monthly');
  const [scheduleEmail, setScheduleEmail] = useState('');
  const [scheduleName, setScheduleName] = useState('');
  const [schedulePeriod, setSchedulePeriod] = useState('month');

  const kpiQuery = useQuery<KpiData>({
    queryKey: ['analytics-kpi', activeOrgId, period],
    queryFn: () => apiFetch(API(`/organizations/${activeOrgId}/analytics/kpi?period=${period}`)),
    enabled: !!activeOrgId,
    refetchInterval: 5 * 60 * 1000,
  });

  const shareLeaderboardQuery = useQuery<ShareLeaderboardData>({
    queryKey: ['analytics-share-leaderboard', activeOrgId, period],
    queryFn: () => apiFetch(API(`/organizations/${activeOrgId}/analytics/profile-share-leaderboard?period=${period}&limit=10`)),
    enabled: !!activeOrgId,
  });

  const badgeShareLeaderboardQuery = useQuery<BadgeShareLeaderboardData>({
    queryKey: ['analytics-badge-share-leaderboard', activeOrgId, period],
    queryFn: () => apiFetch(API(`/organizations/${activeOrgId}/analytics/badge-share-leaderboard?period=${period}`)),
    enabled: !!activeOrgId,
  });

  // Task #1248 — drill-down: clicking a badge row opens this sheet, which
  // fetches the per-member breakdown for that badge in the same period.
  const [drilldownBadge, setDrilldownBadge] = useState<BadgeShareEntry | null>(null);
  // Task #1797 — Sort the badge-share drill-down by who shares the most.
  // Default is total desc; clicking a method header (Copy/Web/Native)
  // re-sorts by that column. State resets when the sheet closes.
  type DrilldownSortKey = 'total' | 'copy' | 'web_share' | 'native_share';
  const [drilldownSortKey, setDrilldownSortKey] = useState<DrilldownSortKey>('total');
  const badgeShareMembersQuery = useQuery<BadgeShareMemberBreakdownData>({
    queryKey: ['analytics-badge-share-members', activeOrgId, period, drilldownBadge?.badgeType],
    queryFn: () => apiFetch(API(
      `/organizations/${activeOrgId}/analytics/badge-share-leaderboard/${encodeURIComponent(drilldownBadge!.badgeType)}?period=${period}`,
    )),
    enabled: !!activeOrgId && !!drilldownBadge,
  });
  const sortedDrilldownMembers = useMemo(() => {
    const members = badgeShareMembersQuery.data?.members;
    if (!members) return [];
    const valueOf = (e: typeof members[number]) =>
      drilldownSortKey === 'total' ? e.total : e.byMethod[drilldownSortKey];
    return [...members].sort((a, b) => valueOf(b) - valueOf(a));
  }, [badgeShareMembersQuery.data, drilldownSortKey]);

  const reportsQuery = useQuery<{ reports: { id: string; name: string; category: string; description: string }[] }>({
    queryKey: ['analytics-reports-list', activeOrgId],
    queryFn: () => apiFetch(API(`/organizations/${activeOrgId}/analytics/reports`)),
    enabled: !!activeOrgId,
  });

  const reportQuery = useQuery<ReportData>({
    queryKey: ['analytics-report', activeOrgId, selectedReport, reportPeriod],
    queryFn: () => apiFetch(API(`/organizations/${activeOrgId}/analytics/reports/${selectedReport}?period=${reportPeriod}`)),
    enabled: !!activeOrgId && !!selectedReport,
  });

  const [customResult, setCustomResult] = useState<ReportData | null>(null);
  const customMutation = useMutation({
    mutationFn: () => apiFetch<ReportData>(API(`/organizations/${activeOrgId}/analytics/custom`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataSource: customSource, metric: customMetric, groupBy: customGroupBy, from: customFrom, to: customTo }),
    }),
    onSuccess: (data) => {
      setCustomResult(data);
      toast({ title: 'Report generated' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const schedulesQuery = useQuery<{ schedules: Schedule[] }>({
    queryKey: ['analytics-schedules', activeOrgId],
    queryFn: () => apiFetch(API(`/organizations/${activeOrgId}/analytics/schedules`)),
    enabled: !!activeOrgId,
  });

  const createScheduleMutation = useMutation({
    mutationFn: () => apiFetch(API(`/organizations/${activeOrgId}/analytics/schedules`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId: scheduleReportId, frequency: scheduleFreq, recipientEmail: scheduleEmail, recipientName: scheduleName, period: schedulePeriod }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['analytics-schedules', activeOrgId] });
      setScheduleEmail('');
      setScheduleName('');
      toast({ title: 'Scheduled report created' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteScheduleMutation = useMutation({
    mutationFn: (id: string) => apiFetch(API(`/organizations/${activeOrgId}/analytics/schedules/${id}`), { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['analytics-schedules', activeOrgId] });
      toast({ title: 'Schedule deleted' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const kpi = kpiQuery.data?.kpis;
  const topItems = kpiQuery.data?.topShopItems ?? [];
  const allReports = reportsQuery.data?.reports ?? [];
  const schedules = schedulesQuery.data?.schedules ?? [];

  const categories = [...new Set(allReports.map(r => r.category))];

  const handleExportCSV = useCallback(() => {
    const data = reportQuery.data?.data;
    const name = allReports.find(r => r.id === selectedReport)?.name ?? 'report';
    if (data) exportToCSV(data, `${name}.csv`);
  }, [reportQuery.data, allReports, selectedReport]);

  const handleExportPDF = useCallback(() => {
    const data = reportQuery.data?.data;
    const name = allReports.find(r => r.id === selectedReport)?.name ?? 'report';
    if (data) exportToPDF(name, data);
  }, [reportQuery.data, allReports, selectedReport]);

  if (!activeOrgId) {
    return (
      <div className="p-8 text-center">
        <p className="text-muted-foreground">Select a club to view analytics</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <BarChart2 className="w-6 h-6 text-primary" />
            Business Intelligence
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">KPI dashboard, reports, and custom analytics</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-40 bg-white/5 border-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="border-white/10" onClick={() => kpiQuery.refetch()}>
            <RefreshCw className={`w-4 h-4 ${kpiQuery.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <Tabs defaultValue="dashboard">
        <TabsList className="bg-white/5 border border-white/10">
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="reports">Pre-built Reports</TabsTrigger>
          <TabsTrigger value="custom">Custom Builder</TabsTrigger>
          <TabsTrigger value="schedule">Scheduled Delivery</TabsTrigger>
        </TabsList>

        {/* KPI DASHBOARD TAB */}
        <TabsContent value="dashboard" className="mt-4 space-y-4">
          {kpiQuery.isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : kpiQuery.isError ? (
            <Card className="glass-card border-none">
              <CardContent className="py-8 text-center">
                <p className="text-red-400">{(kpiQuery.error as Error).message}</p>
                <Button variant="outline" size="sm" className="mt-3 border-white/10" onClick={() => kpiQuery.refetch()}>Retry</Button>
              </CardContent>
            </Card>
          ) : kpi ? (
            <>
              {/* Primary KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <div className="col-span-2 md:col-span-1">
                  <KpiCard
                    title="Total Revenue"
                    value={kpi.totalRevenue.value}
                    prevValue={kpi.totalRevenue.prevValue}
                    change={kpi.totalRevenue.change}
                    icon={DollarSign}
                    color="text-green-400"
                    formatFn={formatCurrency}
                  />
                </div>
                <KpiCard
                  title="Active Members"
                  value={kpi.activeMembers.value}
                  prevValue={kpi.activeMembers.prevValue}
                  change={kpi.activeMembers.change}
                  icon={Users}
                  color="text-blue-400"
                />
                <KpiCard
                  title="Tee Sheet Fill"
                  value={kpi.teeSheetUtilisation.value}
                  icon={Activity}
                  color="text-amber-400"
                  suffix="%"
                />
                <KpiCard
                  title="Tee Bookings"
                  value={kpi.teeBookings.value}
                  prevValue={kpi.teeBookings.prevValue}
                  change={kpi.teeBookings.change}
                  icon={Clock}
                  color="text-purple-400"
                />
                <KpiCard
                  title="Tournaments"
                  value={kpi.tournaments.value}
                  icon={Trophy}
                  color="text-yellow-400"
                />
                <KpiCard
                  title="Event Enquiries"
                  value={kpi.pendingEventEnquiries.value}
                  icon={Tag}
                  color="text-pink-400"
                />
              </div>

              {/* Revenue breakdown + Top sellers */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className="glass-card border-none">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-white text-sm">Revenue by Department</CardTitle>
                    <p className="text-xs text-muted-foreground">Total: {formatCurrency(kpi.totalRevenue.value)}</p>
                  </CardHeader>
                  <CardContent>
                    <RevenueBreakdownChart breakdown={kpi.totalRevenue.breakdown} />
                  </CardContent>
                </Card>

                <Card className="glass-card border-none">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-white text-sm">Top Pro Shop Items</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    {topItems.length === 0 ? (
                      <p className="text-muted-foreground text-sm px-6 pb-4">No POS sales in period</p>
                    ) : (
                      <div className="divide-y divide-white/5">
                        {topItems.map((item, i) => (
                          <div key={i} className="flex items-center justify-between px-6 py-2.5">
                            <div>
                              <p className="text-sm text-white">{item.name}</p>
                              <p className="text-xs text-muted-foreground">{item.category ?? 'General'} · Qty: {item.qty}</p>
                            </div>
                            <span className="text-sm font-semibold text-green-400">{formatCurrency(item.revenue)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Tee sheet utilisation bar */}
              <Card className="glass-card border-none">
                <CardHeader className="pb-2">
                  <CardTitle className="text-white text-sm">Tee Sheet Utilisation</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-4">
                    <div className="flex-1 bg-white/10 rounded-full h-3 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-green-500 to-green-400 rounded-full transition-all duration-700"
                        style={{ width: `${kpi.teeSheetUtilisation.value}%` }}
                      />
                    </div>
                    <span className="text-white font-bold text-sm w-14 text-right">{kpi.teeSheetUtilisation.value}%</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {kpi.teeSheetUtilisation.bookedSlots} booked of {kpi.teeSheetUtilisation.totalSlots} total slots
                  </p>
                </CardContent>
              </Card>

              {/* Profile Share Leaderboard — which members drive profile traffic */}
              <Card className="glass-card border-none">
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-white text-sm flex items-center gap-2">
                    <Share2 className="w-4 h-4 text-primary" />
                    Profile Share Leaderboard
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">
                    {shareLeaderboardQuery.data
                      ? `${shareLeaderboardQuery.data.totals.total} shares this period`
                      : ''}
                  </span>
                </CardHeader>
                <CardContent>
                  {shareLeaderboardQuery.isLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    </div>
                  ) : shareLeaderboardQuery.isError ? (
                    <p className="text-sm text-red-400">
                      {(shareLeaderboardQuery.error as Error).message}
                    </p>
                  ) : !shareLeaderboardQuery.data || shareLeaderboardQuery.data.leaderboard.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      No profile shares logged in this period.
                    </p>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                        {(['copy', 'web_share', 'native_share', 'qr_open'] as const).map(m => (
                          <div key={m} className="bg-white/5 rounded p-2">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              {m.replace('_', ' ')}
                            </p>
                            <p className="text-white font-bold text-sm">
                              {shareLeaderboardQuery.data!.totals.byMethod[m]}
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-muted-foreground uppercase tracking-wider">
                              <th className="py-1.5 pr-2">#</th>
                              <th className="py-1.5 pr-2">Member</th>
                              <th className="py-1.5 px-2 text-right">Total</th>
                              <th className="py-1.5 px-2 text-right">Copy</th>
                              <th className="py-1.5 px-2 text-right">Web</th>
                              <th className="py-1.5 px-2 text-right">Native</th>
                              <th className="py-1.5 pl-2 text-right">QR</th>
                            </tr>
                          </thead>
                          <tbody>
                            {shareLeaderboardQuery.data!.leaderboard.map((entry, idx) => (
                              <tr key={entry.userId} className="border-t border-white/5">
                                <td className="py-1.5 pr-2 text-muted-foreground">{idx + 1}</td>
                                <td className="py-1.5 pr-2 text-white">
                                  <div className="font-medium">
                                    {entry.displayName ?? entry.username ?? `User ${entry.userId}`}
                                  </div>
                                  {entry.publicHandle && (
                                    <div className="text-xs text-muted-foreground">@{entry.publicHandle}</div>
                                  )}
                                </td>
                                <td className="py-1.5 px-2 text-right text-white font-semibold">{entry.total}</td>
                                <td className="py-1.5 px-2 text-right text-muted-foreground">{entry.byMethod.copy}</td>
                                <td className="py-1.5 px-2 text-right text-muted-foreground">{entry.byMethod.web_share}</td>
                                <td className="py-1.5 px-2 text-right text-muted-foreground">{entry.byMethod.native_share}</td>
                                <td className="py-1.5 pl-2 text-right text-muted-foreground">{entry.byMethod.qr_open}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Badge Share Leaderboard — which badges drive the most viral traffic */}
              <Card
                className="glass-card border-none"
                data-testid="card-badge-share-leaderboard"
              >
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-white text-sm flex items-center gap-2">
                    <Share2 className="w-4 h-4 text-primary" />
                    Badge Share Leaderboard
                  </CardTitle>
                  {badgeShareLeaderboardQuery.data && (() => {
                    // Crawler share is computed against raw visits (incl. crawlers)
                    // since `totals.visits` excludes them.
                    const bs = badgeShareLeaderboardQuery.data.totals.visitsBySource;
                    const rawTotal = bs.web + bs.mobile + bs.unknown + bs.crawler;
                    const crawlerPct = rawTotal > 0 ? Math.round((bs.crawler / rawTotal) * 100) : 0;
                    return (
                      <div
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                        data-testid="text-badge-share-org-totals"
                      >
                        <span>
                          {badgeShareLeaderboardQuery.data.totals.total} shares
                          {' '}→{' '}
                          {badgeShareLeaderboardQuery.data.totals.visits} visits
                        </span>
                        {/* Task #1798 — org-wide shares→visits conversion ratio.
                            Renders "—" when shares=0 so we never show a divide-by-zero. */}
                        <span
                          className="px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 font-medium"
                          data-testid="badge-badge-share-org-conversion"
                          title="Profile/badge-page visits divided by outbound shares for this period (crawler hits excluded)"
                        >
                          {badgeShareLeaderboardQuery.data.totals.conversionRate !== null
                            ? `${Math.round(badgeShareLeaderboardQuery.data.totals.conversionRate * 100)}% conv.`
                            : '— conv.'}
                        </span>
                        {bs.crawler > 0 && (
                          <span
                            className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-medium"
                            data-testid="badge-badge-share-org-crawler-pct"
                            title={`${bs.crawler} of ${rawTotal} raw visits this period came from social link-preview crawlers (Slack, Facebook, WhatsApp, etc. unfurling the URL on paste). These are excluded from the conversion rate above.`}
                          >
                            {crawlerPct}% link previews
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </CardHeader>
                <CardContent>
                  {badgeShareLeaderboardQuery.isLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    </div>
                  ) : badgeShareLeaderboardQuery.isError ? (
                    <p className="text-sm text-red-400">
                      {(badgeShareLeaderboardQuery.error as Error).message}
                    </p>
                  ) : !badgeShareLeaderboardQuery.data || badgeShareLeaderboardQuery.data.badges.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      No badge shares logged in this period.
                    </p>
                  ) : (
                    <>
                      <div className="grid grid-cols-3 gap-2 mb-3">
                        {(['copy', 'web_share', 'native_share'] as const).map(m => (
                          <div key={m} className="bg-white/5 rounded p-2">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              {m.replace('_', ' ')}
                            </p>
                            <p className="text-white font-bold text-sm">
                              {badgeShareLeaderboardQuery.data!.totals.byMethod[m]}
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-muted-foreground uppercase tracking-wider">
                              <th className="py-1.5 pr-2">#</th>
                              <th className="py-1.5 pr-2">Badge</th>
                              <th className="py-1.5 px-2 text-right">Shares</th>
                              <th className="py-1.5 px-2 text-right">Copy</th>
                              <th className="py-1.5 px-2 text-right">Web</th>
                              <th className="py-1.5 px-2 text-right">Native</th>
                              {/* Task #1798 — visits driven by this badge's
                                  share links + per-badge conversion ratio */}
                              <th className="py-1.5 px-2 text-right" title="Visits to /p/<handle>/badge/<type> attributed to this badge over the period (crawler hits excluded)">Visits</th>
                              <th className="py-1.5 pl-2 text-right" title="Visits divided by shares for this badge over the period">Conv.</th>
                            </tr>
                          </thead>
                          <tbody>
                            {badgeShareLeaderboardQuery.data!.badges.map((entry, idx) => (
                              <tr
                                key={entry.badgeType}
                                className="border-t border-white/5 cursor-pointer hover:bg-white/5"
                                onClick={() => setDrilldownBadge(entry)}
                                title="Click to see who shared this badge"
                                data-testid={`row-badge-share-${entry.badgeType}`}
                              >
                                <td className="py-1.5 pr-2 text-muted-foreground">{idx + 1}</td>
                                <td className="py-1.5 pr-2 text-white">
                                  <div className="font-medium flex items-center gap-2">
                                    <span className="text-base leading-none">{entry.icon}</span>
                                    <span>{entry.label}</span>
                                  </div>
                                  {entry.category && (
                                    <div className="text-xs text-muted-foreground ml-6">{entry.category}</div>
                                  )}
                                </td>
                                <td className="py-1.5 px-2 text-right text-white font-semibold">{entry.total}</td>
                                <td className="py-1.5 px-2 text-right text-muted-foreground">{entry.byMethod.copy}</td>
                                <td className="py-1.5 px-2 text-right text-muted-foreground">{entry.byMethod.web_share}</td>
                                <td className="py-1.5 px-2 text-right text-muted-foreground">{entry.byMethod.native_share}</td>
                                <td
                                  className="py-1.5 px-2 text-right text-white"
                                  data-testid={`cell-badge-share-visits-${entry.badgeType}`}
                                >
                                  {entry.visits}
                                </td>
                                <td
                                  className="py-1.5 pl-2 text-right text-emerald-300"
                                  data-testid={`cell-badge-share-conversion-${entry.badgeType}`}
                                >
                                  {entry.conversionRate !== null
                                    ? `${Math.round(entry.conversionRate * 100)}%`
                                    : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </>
          ) : null}
        </TabsContent>

        {/* PRE-BUILT REPORTS TAB */}
        <TabsContent value="reports" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Report list */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Report Library</p>
              {categories.map(cat => (
                <div key={cat}>
                  <p className="text-xs text-muted-foreground mb-1 mt-2">{cat}</p>
                  {allReports.filter(r => r.category === cat).map(r => (
                    <button
                      key={r.id}
                      onClick={() => setSelectedReport(r.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                        selectedReport === r.id
                          ? 'bg-primary/20 text-primary border border-primary/30'
                          : 'text-white hover:bg-white/5 border border-transparent'
                      }`}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              ))}
            </div>

            {/* Report viewer */}
            <div className="md:col-span-2">
              {!selectedReport ? (
                <Card className="glass-card border-none h-full flex items-center justify-center min-h-64">
                  <p className="text-muted-foreground">Select a report to view</p>
                </Card>
              ) : (
                <Card className="glass-card border-none">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div>
                        <CardTitle className="text-white text-sm">
                          {allReports.find(r => r.id === selectedReport)?.name}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {allReports.find(r => r.id === selectedReport)?.description}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Select value={reportPeriod} onValueChange={setReportPeriod}>
                          <SelectTrigger className="w-36 h-7 text-xs bg-white/5 border-white/10 text-white">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PERIODS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {reportQuery.data?.data && (
                          <>
                            <Button size="sm" variant="outline" className="h-7 text-xs border-white/10" onClick={handleExportCSV}>
                              <Download className="w-3 h-3 mr-1" />CSV
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 text-xs border-white/10" onClick={handleExportPDF}>
                              <Download className="w-3 h-3 mr-1" />PDF
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {reportQuery.isLoading ? (
                      <div className="flex justify-center py-12">
                        <Loader2 className="w-6 h-6 animate-spin text-primary" />
                      </div>
                    ) : reportQuery.isError ? (
                      <p className="text-red-400 text-sm">{(reportQuery.error as Error).message}</p>
                    ) : reportQuery.data ? (
                      <ReportChart reportId={selectedReport} data={reportQuery.data.data} />
                    ) : null}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>

        {/* CUSTOM REPORT BUILDER TAB */}
        <TabsContent value="custom" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="glass-card border-none">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm">Build Report</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Data Source</Label>
                  <Select value={customSource} onValueChange={setCustomSource}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pos_transactions">Pro Shop (POS)</SelectItem>
                      <SelectItem value="tee_bookings">Tee Bookings</SelectItem>
                      <SelectItem value="lesson_bookings">Lesson Bookings</SelectItem>
                      <SelectItem value="fb_orders">F&B Orders</SelectItem>
                      <SelectItem value="event_bookings">Event Bookings</SelectItem>
                      <SelectItem value="club_members">Club Members</SelectItem>
                      <SelectItem value="tournaments">Tournaments</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Metric</Label>
                  <Select value={customMetric} onValueChange={setCustomMetric}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="count">Count</SelectItem>
                      <SelectItem value="sum_revenue">Total Revenue</SelectItem>
                      <SelectItem value="avg_revenue">Average Revenue</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Group By</Label>
                  <Select value={customGroupBy} onValueChange={setCustomGroupBy}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="day">Day</SelectItem>
                      <SelectItem value="week">Week</SelectItem>
                      <SelectItem value="month">Month</SelectItem>
                      <SelectItem value="quarter">Quarter</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">From</Label>
                    <Input
                      type="date"
                      value={customFrom}
                      onChange={e => setCustomFrom(e.target.value)}
                      className="bg-white/5 border-white/10 text-white text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">To</Label>
                    <Input
                      type="date"
                      value={customTo}
                      onChange={e => setCustomTo(e.target.value)}
                      className="bg-white/5 border-white/10 text-white text-xs"
                    />
                  </div>
                </div>

                <Button
                  className="w-full"
                  onClick={() => customMutation.mutate()}
                  disabled={customMutation.isPending}
                >
                  {customMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <BarChart2 className="w-4 h-4 mr-2" />}
                  Run Report
                </Button>
              </CardContent>
            </Card>

            <div className="md:col-span-2">
              <Card className="glass-card border-none">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-white text-sm">
                      {customResult ? `${customSource.replace(/_/g, ' ')} — ${customMetric.replace(/_/g, ' ')} by ${customGroupBy}` : 'Results'}
                    </CardTitle>
                    {customResult?.rows && Array.isArray(customResult.rows) && customResult.rows.length > 0 && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" className="h-7 text-xs border-white/10"
                          onClick={() => exportToCSV(customResult.rows, 'custom-report.csv')}>
                          <Download className="w-3 h-3 mr-1" />CSV
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs border-white/10"
                          onClick={() => exportToPDF('Custom Report', customResult.rows)}>
                          <Download className="w-3 h-3 mr-1" />PDF
                        </Button>
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {customMutation.isPending ? (
                    <div className="flex justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                    </div>
                  ) : customResult?.rows && Array.isArray(customResult.rows) && customResult.rows.length > 0 ? (
                    <>
                      <ReportChart reportId="custom" data={customResult.rows} />
                      <div className="mt-4 overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr>
                              {Object.keys((customResult.rows as Record<string, unknown>[])[0]).map(k => (
                                <th key={k} className="text-left text-muted-foreground py-1 pr-4">{k}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(customResult.rows as Record<string, unknown>[]).slice(0, 20).map((row, i) => (
                              <tr key={i} className="border-t border-white/5">
                                {Object.values(row).map((v, j) => (
                                  <td key={j} className="py-1.5 pr-4 text-white">{String(v ?? '—')}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <BarChart2 className="w-12 h-12 text-white/10 mb-3" />
                      <p className="text-muted-foreground text-sm">Configure your report and click Run</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* SCHEDULED DELIVERY TAB */}
        <TabsContent value="schedule" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Create schedule form */}
            <Card className="glass-card border-none">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-primary" />
                  Schedule a Report
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Report</Label>
                  <Select value={scheduleReportId} onValueChange={setScheduleReportId}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {allReports.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Frequency</Label>
                  <Select value={scheduleFreq} onValueChange={(v) => setScheduleFreq(v as 'daily' | 'weekly' | 'monthly')}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Report Period</Label>
                  <Select value={schedulePeriod} onValueChange={setSchedulePeriod}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERIODS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Recipient Name</Label>
                  <Input
                    placeholder="Club Manager"
                    value={scheduleName}
                    onChange={e => setScheduleName(e.target.value)}
                    className="bg-white/5 border-white/10 text-white placeholder:text-muted-foreground"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Recipient Email</Label>
                  <Input
                    type="email"
                    placeholder="manager@club.com"
                    value={scheduleEmail}
                    onChange={e => setScheduleEmail(e.target.value)}
                    className="bg-white/5 border-white/10 text-white placeholder:text-muted-foreground"
                  />
                </div>

                <Button
                  className="w-full"
                  onClick={() => createScheduleMutation.mutate()}
                  disabled={createScheduleMutation.isPending || !scheduleEmail}
                >
                  {createScheduleMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <Plus className="w-4 h-4 mr-2" />
                  )}
                  Create Schedule
                </Button>
              </CardContent>
            </Card>

            {/* Active schedules */}
            <Card className="glass-card border-none">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm flex items-center gap-2">
                  <Mail className="w-4 h-4 text-primary" />
                  Active Schedules
                  <Badge variant="outline" className="border-white/20 text-muted-foreground text-xs">
                    {schedules.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {schedulesQuery.isLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  </div>
                ) : schedules.length === 0 ? (
                  <p className="text-muted-foreground text-sm px-6 pb-6">No scheduled reports yet</p>
                ) : (
                  <div className="divide-y divide-white/5">
                    {schedules.map(s => (
                      <div key={s.id} className="px-6 py-3 flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white font-medium truncate">{s.reportName}</p>
                          <p className="text-xs text-muted-foreground">{s.recipientEmail}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className="text-xs border-white/10 text-primary capitalize">{s.frequency}</Badge>
                            <span className="text-xs text-muted-foreground">
                              Next: {new Date(s.nextRunAt).toLocaleDateString()}
                            </span>
                          </div>
                          {s.lastRunAt && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Last sent: {new Date(s.lastRunAt).toLocaleString()}
                            </p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-400 hover:text-red-300 hover:bg-red-400/10 flex-shrink-0"
                          onClick={() => deleteScheduleMutation.mutate(s.id)}
                          disabled={deleteScheduleMutation.isPending}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Task #1248 — Badge share drill-down: lists members who shared the
          selected badge in the current period, with per-method counts. */}
      <Sheet open={!!drilldownBadge} onOpenChange={(open) => {
        if (!open) {
          setDrilldownBadge(null);
          // Task #1797 — reset sort to the default whenever the sheet closes,
          // so reopening starts fresh at "total desc".
          setDrilldownSortKey('total');
        }
      }}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md bg-[#0e1117] border-white/10 text-white overflow-y-auto"
          data-testid="sheet-badge-share-members"
        >
          <SheetHeader>
            <SheetTitle className="text-white flex items-center gap-2">
              {drilldownBadge && (
                <>
                  <span className="text-xl leading-none">{drilldownBadge.icon}</span>
                  <span>{drilldownBadge.label}</span>
                </>
              )}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground">
              Members who shared this badge —{' '}
              {PERIODS.find(p => p.value === period)?.label ?? period}
            </SheetDescription>
            {/* Task #1798 — badge-wide shares→visits headline so admins
                can immediately see whether this badge actually drove
                profile visits. Mirrors the org-wide chip in the card
                header but scoped to the selected badge. */}
            {drilldownBadge && badgeShareMembersQuery.data && (() => {
              const bs = badgeShareMembersQuery.data.totals.visitsBySource;
              const rawTotal = bs.web + bs.mobile + bs.unknown + bs.crawler;
              const crawlerPct = rawTotal > 0 ? Math.round((bs.crawler / rawTotal) * 100) : 0;
              return (
                <div
                  className="pt-1 flex items-center gap-2 text-xs text-muted-foreground flex-wrap"
                  data-testid="text-badge-share-drilldown-totals"
                >
                  <span>
                    {badgeShareMembersQuery.data.totals.total} shares
                    {' '}→{' '}
                    {badgeShareMembersQuery.data.totals.visits} visits attributed
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 font-medium"
                    data-testid="badge-badge-share-drilldown-conversion"
                    title="Profile/badge-page visits divided by outbound shares for this badge over the period (crawler hits excluded)"
                  >
                    {badgeShareMembersQuery.data.totals.conversionRate !== null
                      ? `${Math.round(badgeShareMembersQuery.data.totals.conversionRate * 100)}% conv.`
                      : '— conv.'}
                  </span>
                  {bs.crawler > 0 && (
                    <span
                      className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-medium"
                      data-testid="badge-badge-share-drilldown-crawler-pct"
                      title={`${bs.crawler} of ${rawTotal} raw visits to this badge came from social link-preview crawlers (Slack, Facebook, WhatsApp, etc.). These are excluded from the conversion rate above.`}
                    >
                      {crawlerPct}% link previews
                    </span>
                  )}
                </div>
              );
            })()}
            {drilldownBadge && badgeShareMembersQuery.data && (() => {
              const bs = badgeShareMembersQuery.data.totals.visitsBySource;
              const rawTotal = bs.web + bs.mobile + bs.unknown + bs.crawler;
              if (rawTotal === 0) return null;
              return (
                <div className="pt-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    Visit sources
                  </p>
                  <MiniSourceBar
                    visitsBySource={bs}
                    testIdPrefix="bar-badge-share-drilldown-sources"
                  />
                </div>
              );
            })()}
            {drilldownBadge && badgeShareMembersQuery.data && badgeShareMembersQuery.data.members.length > 0 && (
              <div className="pt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-white/10"
                  onClick={() => {
                    // Task #1797 — export rows in the same order the table
                    // is currently sorted in (sortedDrilldownMembers), so
                    // the rank column in the CSV matches what the admin
                    // sees on screen.
                    // Task #1798 — include "visits" + "conversion %" so
                    // admins can pivot/sort on attribution outside the
                    // dashboard. `conversionPct` is rounded the same way
                    // as the on-screen pill; "—" when shares=0.
                    const rows = sortedDrilldownMembers.map((entry, idx) => ({
                      rank: idx + 1,
                      member: entry.displayName ?? entry.username ?? `User ${entry.userId}`,
                      handle: entry.publicHandle ?? '',
                      total: entry.total,
                      copy: entry.byMethod.copy,
                      web: entry.byMethod.web_share,
                      native: entry.byMethod.native_share,
                      visits: entry.visits,
                      visitsWeb: entry.visitsBySource.web,
                      visitsMobile: entry.visitsBySource.mobile,
                      visitsUnknown: entry.visitsBySource.unknown,
                      visitsCrawler: entry.visitsBySource.crawler,
                      conversionPct: entry.conversionRate !== null
                        ? `${Math.round(entry.conversionRate * 100)}%`
                        : '—',
                    }));
                    const labelSlug = drilldownBadge.label
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-+|-+$/g, '') || drilldownBadge.badgeType;
                    exportToCSV(rows, `badge-share-${labelSlug}-${period}.csv`);
                  }}
                  data-testid="button-export-badge-drilldown-csv"
                >
                  <Download className="w-3 h-3 mr-1" />CSV
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-white/10"
                  onClick={() => {
                    const rows = sortedDrilldownMembers.map((entry, idx) => ({
                      rank: idx + 1,
                      member: entry.displayName ?? entry.username ?? `User ${entry.userId}`,
                      handle: entry.publicHandle ?? '',
                      total: entry.total,
                      copy: entry.byMethod.copy,
                      web: entry.byMethod.web_share,
                      native: entry.byMethod.native_share,
                      visits: entry.visits,
                      visitsWeb: entry.visitsBySource.web,
                      visitsMobile: entry.visitsBySource.mobile,
                      visitsUnknown: entry.visitsBySource.unknown,
                      visitsCrawler: entry.visitsBySource.crawler,
                      conversionPct: entry.conversionRate !== null
                        ? `${Math.round(entry.conversionRate * 100)}%`
                        : '—',
                    }));
                    const periodLabel = PERIODS.find(p => p.value === period)?.label ?? period;
                    exportToPDF(`${drilldownBadge.label} — ${periodLabel}`, rows);
                  }}
                  data-testid="button-export-badge-drilldown-pdf"
                >
                  <Download className="w-3 h-3 mr-1" />PDF
                </Button>
              </div>
            )}
          </SheetHeader>

          <div className="mt-4">
            {badgeShareMembersQuery.isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
              </div>
            ) : badgeShareMembersQuery.isError ? (
              <p className="text-sm text-red-400">
                {(badgeShareMembersQuery.error as Error).message}
              </p>
            ) : !badgeShareMembersQuery.data || badgeShareMembersQuery.data.members.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No member shared this badge in the selected period.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {(['copy', 'web_share', 'native_share'] as const).map(m => (
                    <div key={m} className="bg-white/5 rounded p-2">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {m.replace('_', ' ')}
                      </p>
                      <p className="text-white font-bold text-sm">
                        {badgeShareMembersQuery.data!.totals.byMethod[m]}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground uppercase tracking-wider">
                        <th className="py-1.5 pr-2">#</th>
                        <th className="py-1.5 pr-2">Member</th>
                        {/* Task #1797 — "Shares" (was Total) is the default
                            sort key; indicator shows when it's active.
                            Task #2249 — header is now clickable to revert
                            back to total desc after sorting by a method
                            column, without having to close+reopen the sheet.
                            Close+reopen still resets back to it. */}
                        <th className="py-1.5 px-2 text-right">
                          {(() => {
                            const active = drilldownSortKey === 'total';
                            return (
                              <button
                                type="button"
                                onClick={() => setDrilldownSortKey('total')}
                                className={`inline-flex items-center justify-end gap-1 uppercase tracking-wider hover:text-white transition-colors ${active ? 'text-white' : ''}`}
                                data-testid="sort-badge-drilldown-total"
                                aria-sort={active ? 'descending' : 'none'}
                              >
                                Shares
                                {active && (
                                  <ArrowDown className="w-3 h-3 text-primary" aria-label="sorted descending" />
                                )}
                              </button>
                            );
                          })()}
                        </th>
                        {([
                          { key: 'copy' as const, label: 'Copy', cls: 'py-1.5 px-2 text-right' },
                          { key: 'web_share' as const, label: 'Web', cls: 'py-1.5 px-2 text-right' },
                          { key: 'native_share' as const, label: 'Native', cls: 'py-1.5 px-2 text-right' },
                        ]).map(col => {
                          const active = drilldownSortKey === col.key;
                          return (
                            <th key={col.key} className={col.cls}>
                              <button
                                type="button"
                                onClick={() => setDrilldownSortKey(col.key)}
                                className={`inline-flex items-center justify-end gap-1 uppercase tracking-wider hover:text-white transition-colors ${active ? 'text-white' : ''}`}
                                data-testid={`sort-badge-drilldown-${col.key}`}
                                aria-sort={active ? 'descending' : 'none'}
                              >
                                {col.label}
                                {active && (
                                  <ArrowDown className="w-3 h-3 text-primary" aria-label="sorted descending" />
                                )}
                              </button>
                            </th>
                          );
                        })}
                        {/* Task #1798 — per-member visits & conversion */}
                        <th className="py-1.5 px-2 text-right" title="Visits to /p/<handle>/badge/<type> attributed to this member's badge over the period (crawler hits excluded)">Visits</th>
                        <th className="py-1.5 pl-2 text-right" title="This member's visits divided by their shares for this badge over the period">Conv.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDrilldownMembers.map((entry, idx) => (
                        <tr
                          key={entry.userId}
                          className="border-t border-white/5"
                          data-testid={`row-badge-share-member-${entry.userId}`}
                        >
                          <td className="py-1.5 pr-2 text-muted-foreground">{idx + 1}</td>
                          <td className="py-1.5 pr-2 text-white">
                            <div className="font-medium">
                              {entry.displayName ?? entry.username ?? `User ${entry.userId}`}
                            </div>
                            {entry.publicHandle && (
                              <div className="text-xs text-muted-foreground">@{entry.publicHandle}</div>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right text-white font-semibold">{entry.total}</td>
                          <td className="py-1.5 px-2 text-right text-muted-foreground">{entry.byMethod.copy}</td>
                          <td className="py-1.5 px-2 text-right text-muted-foreground">{entry.byMethod.web_share}</td>
                          <td className="py-1.5 px-2 text-right text-muted-foreground">{entry.byMethod.native_share}</td>
                          <td
                            className="py-1.5 px-2 text-right text-white"
                            data-testid={`cell-badge-share-member-visits-${entry.userId}`}
                          >
                            {entry.visits}
                          </td>
                          <td
                            className="py-1.5 pl-2 text-right text-emerald-300"
                            data-testid={`cell-badge-share-member-conversion-${entry.userId}`}
                          >
                            {entry.conversionRate !== null
                              ? `${Math.round(entry.conversionRate * 100)}%`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
