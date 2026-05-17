import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  TrendingUp, ShoppingBag, Users, Award, Loader2,
  BarChart2, Receipt, Star, Tag,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
function API(path: string) { return `${BASE_URL}/api${path}`; }

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface ChannelStat {
  revenue: number;
  orders?: number;
  aov?: number;
  refunds?: number;
  refundRate?: number;
}

interface CommerceAnalytics {
  period: { from: string; to: string; granularity: string };
  summary: {
    totalRevenue: number;
    channels: {
      shop: ChannelStat;
      pos: ChannelStat;
      fb: ChannelStat;
      teeTimes: ChannelStat;
      memberships: ChannelStat;
      tournament: ChannelStat;
    };
  };
  revenueTrend: Array<{ period: string; revenue: number; channel: string }>;
  topProducts: {
    shop: Array<{ name: string; units: number; revenue: number }>;
    pos: Array<{ name: string; units: number; revenue: number }>;
  };
  gst: {
    overall: {
      totalInvoices: number;
      totalTaxable: number;
      cgst: number;
      sgst: number;
      igst: number;
      totalGstCollected: number;
    };
    byChannel: Array<{ channel: string; cgst: number; sgst: number; igst: number; total: number }>;
    byStateOfSupply: Array<{ state: string | null; cgst: number; sgst: number; igst: number }>;
  };
  promotionPerformance: {
    shopDiscountedOrders: number;
    shopDiscountTotal: number;
    posDiscountedTransactions: number;
    posDiscountTotal: number;
    totalDiscountGiven: number;
    promotionRate: number;
    netRevenue: number;
  };
  staffPerformance: Array<{ userId: number | null; name: string; salesCount: number; totalRevenue: number }>;
}

const INR = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

const CHANNEL_COLORS: Record<string, string> = {
  shop: '#22c55e', pos: '#3b82f6', fb: '#f59e0b', tee_times: '#8b5cf6', memberships: '#06b6d4', tournament: '#ef4444', league: '#ec4899',
};
const CHANNEL_LABELS: Record<string, string> = {
  shop: 'Online Shop', pos: 'POS / Pro Shop', fb: 'F&B', tee_times: 'Tee Times', memberships: 'Memberships', tournament: 'Tournament Fees', league: 'League Fees',
};
const CHART_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

function today() { return new Date().toISOString().slice(0, 10); }
function monthStart() { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); }

function KpiCard({ label, value, sub, icon: Icon, color = '' }: { label: string; value: string; sub?: string; icon: React.ElementType; color?: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <Icon className="h-5 w-5 text-muted-foreground mt-0.5" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function CommerceAnalyticsPage() {
  const { orgId } = useActiveOrgId();

  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [granularity, setGranularity] = useState('daily');

  const analyticsQuery = useQuery({
    queryKey: ['commerce-analytics', orgId, from, to, granularity],
    queryFn: () => {
      const params = new URLSearchParams({ from, to, granularity });
      return apiFetch<CommerceAnalytics>(API(`/organizations/${orgId}/commerce-analytics?${params}`));
    },
    enabled: !!orgId,
  });

  const data = analyticsQuery.data;

  // Build channel revenue pie data
  const channelPieData = data
    ? Object.entries(data.summary.channels).map(([key, stat]) => ({
        name: CHANNEL_LABELS[key] ?? key,
        value: stat.revenue,
        color: CHANNEL_COLORS[key] ?? '#888',
      })).filter(c => c.value > 0)
    : [];

  // Build trend data — aggregate by period across channels
  // NOTE: vals must NOT contain a 'period' key or spread will overwrite the correct label
  const trendMap = new Map<string, Record<string, number>>();
  data?.revenueTrend.forEach(r => {
    const periodStr = new Date(r.period).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
    if (!trendMap.has(periodStr)) trendMap.set(periodStr, {});
    const entry = trendMap.get(periodStr)!;
    entry[r.channel] = (entry[r.channel] ?? 0) + r.revenue;
  });
  // Spread vals first, then period last so the x-axis label always wins
  const trendData = Array.from(trendMap.entries()).map(([period, vals]) => ({ ...vals, period }));

  const topShop = data?.topProducts.shop ?? [];
  const topPos = data?.topProducts.pos ?? [];

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <BarChart2 className="h-7 w-7 text-blue-600" />
        <div>
          <h1 className="text-2xl font-bold">Commerce Analytics</h1>
          <p className="text-sm text-muted-foreground">Revenue across all channels, GST summary, and staff performance</p>
        </div>
      </div>

      {/* Date Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium">From</label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-36" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium">To</label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-36" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium">Granularity</label>
          <Select value={granularity} onValueChange={setGranularity}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {analyticsQuery.isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : !data ? (
        <div className="text-center py-24 text-muted-foreground">
          Failed to load analytics data.
        </div>
      ) : (
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview"><TrendingUp className="h-4 w-4 mr-1" />Overview</TabsTrigger>
            <TabsTrigger value="products"><ShoppingBag className="h-4 w-4 mr-1" />Top Products</TabsTrigger>
            <TabsTrigger value="gst"><Receipt className="h-4 w-4 mr-1" />GST Summary</TabsTrigger>
            <TabsTrigger value="promotions"><Tag className="h-4 w-4 mr-1" />Promotions</TabsTrigger>
            <TabsTrigger value="staff"><Users className="h-4 w-4 mr-1" />Staff Performance</TabsTrigger>
          </TabsList>

          {/* ── Overview Tab ── */}
          <TabsContent value="overview" className="space-y-4">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <KpiCard label="Total Revenue" value={INR(data.summary.totalRevenue)} icon={TrendingUp} color="text-green-600" />
              <KpiCard
                label="Shop"
                value={INR(data.summary.channels.shop.revenue)}
                sub={`${data.summary.channels.shop.orders ?? 0} orders`}
                icon={ShoppingBag}
              />
              <KpiCard
                label="POS"
                value={INR(data.summary.channels.pos.revenue)}
                sub={`${data.summary.channels.pos.orders ?? 0} transactions`}
                icon={Receipt}
              />
              <KpiCard label="F&B" value={INR(data.summary.channels.fb.revenue)} icon={Star} />
              <KpiCard label="Tee Times" value={INR(data.summary.channels.teeTimes.revenue)} icon={Award} />
              <KpiCard label="Tournament Fees" value={INR(data.summary.channels.tournament.revenue)} icon={Trophy} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Channel Pie */}
              <Card>
                <CardHeader><CardTitle className="text-base">Revenue by Channel</CardTitle></CardHeader>
                <CardContent>
                  {channelPieData.length === 0 ? (
                    <div className="text-center text-muted-foreground py-8 text-sm">No revenue data</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={280}>
                      <PieChart>
                        <Pie
                          data={channelPieData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%" cy="50%"
                          outerRadius={100}
                          label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                          labelLine={false}
                        >
                          {channelPieData.map((entry, i) => (
                            <Cell key={entry.name} fill={entry.color ?? CHART_COLORS[i % CHART_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v: number) => INR(v)} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              {/* Revenue Trend */}
              <Card>
                <CardHeader><CardTitle className="text-base">Revenue Trend</CardTitle></CardHeader>
                <CardContent>
                  {trendData.length === 0 ? (
                    <div className="text-center text-muted-foreground py-8 text-sm">No trend data</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={trendData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                        <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                        <YAxis tickFormatter={v => INR(v)} tick={{ fontSize: 10 }} width={80} />
                        <Tooltip formatter={(v: number) => INR(v)} />
                        <Legend />
                        <Line type="monotone" dataKey="shop" stroke={CHANNEL_COLORS.shop} dot={false} name="Shop" />
                        <Line type="monotone" dataKey="pos" stroke={CHANNEL_COLORS.pos} dot={false} name="POS" />
                        <Line type="monotone" dataKey="fb" stroke={CHANNEL_COLORS.fb} dot={false} name="F&B" />
                        <Line type="monotone" dataKey="tee_times" stroke={CHANNEL_COLORS.tee_times} dot={false} name="Tee Times" />
                        <Line type="monotone" dataKey="memberships" stroke={CHANNEL_COLORS.memberships} dot={false} name="Memberships" />
                        <Line type="monotone" dataKey="tournament" stroke={CHANNEL_COLORS.tournament} dot={false} name="Tournament" />
                        <Line type="monotone" dataKey="league" stroke={CHANNEL_COLORS.league} dot={false} name="League" />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Channel Detail Table */}
            <Card>
              <CardHeader><CardTitle className="text-base">Channel Breakdown</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="pb-2 text-left">Channel</th>
                      <th className="pb-2 text-right">Revenue</th>
                      <th className="pb-2 text-right">Orders/Txns</th>
                      <th className="pb-2 text-right">Avg Order Value</th>
                      <th className="pb-2 text-right">Refund Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.summary.channels).map(([key, stat]) => (
                      <tr key={key} className="border-b last:border-0">
                        <td className="py-2 font-medium flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full inline-block" style={{ background: CHANNEL_COLORS[key] }} />
                          {CHANNEL_LABELS[key] ?? key}
                        </td>
                        <td className="py-2 text-right font-bold">{INR(stat.revenue)}</td>
                        <td className="py-2 text-right">{stat.orders ?? '—'}</td>
                        <td className="py-2 text-right">{stat.aov ? INR(stat.aov) : '—'}</td>
                        <td className="py-2 text-right">
                          {stat.refundRate !== undefined
                            ? <Badge variant={stat.refundRate > 5 ? 'destructive' : 'outline'} className="text-xs">{stat.refundRate.toFixed(1)}%</Badge>
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Top Products Tab ── */}
          <TabsContent value="products" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Shop Products */}
              <Card>
                <CardHeader><CardTitle className="text-base">Top Shop Products</CardTitle></CardHeader>
                <CardContent>
                  {topShop.length === 0 ? (
                    <div className="text-center text-muted-foreground py-8 text-sm">No data</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={topShop.slice(0, 8)} layout="vertical" margin={{ left: 80, right: 20 }}>
                        <XAxis type="number" tickFormatter={v => INR(v)} tick={{ fontSize: 10 }} />
                        <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={80} />
                        <Tooltip formatter={(v: number) => INR(v)} />
                        <Bar dataKey="revenue" fill={CHANNEL_COLORS.shop} name="Revenue" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              {/* POS Items */}
              <Card>
                <CardHeader><CardTitle className="text-base">Top POS Items</CardTitle></CardHeader>
                <CardContent>
                  {topPos.length === 0 ? (
                    <div className="text-center text-muted-foreground py-8 text-sm">No data</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={topPos.slice(0, 8)} layout="vertical" margin={{ left: 80, right: 20 }}>
                        <XAxis type="number" tickFormatter={v => INR(v)} tick={{ fontSize: 10 }} />
                        <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={80} />
                        <Tooltip formatter={(v: number) => INR(v)} />
                        <Bar dataKey="revenue" fill={CHANNEL_COLORS.pos} name="Revenue" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Product Tables */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader><CardTitle className="text-base">Shop — Units & Revenue</CardTitle></CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <thead><tr className="border-b text-muted-foreground">
                      <th className="pb-2 text-left">Product</th>
                      <th className="pb-2 text-right">Units</th>
                      <th className="pb-2 text-right">Revenue</th>
                    </tr></thead>
                    <tbody>
                      {topShop.map(p => (
                        <tr key={p.name} className="border-b last:border-0">
                          <td className="py-1.5 font-medium">{p.name}</td>
                          <td className="py-1.5 text-right">{p.units}</td>
                          <td className="py-1.5 text-right">{INR(p.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base">POS — Units & Revenue</CardTitle></CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <thead><tr className="border-b text-muted-foreground">
                      <th className="pb-2 text-left">Item</th>
                      <th className="pb-2 text-right">Units</th>
                      <th className="pb-2 text-right">Revenue</th>
                    </tr></thead>
                    <tbody>
                      {topPos.map(p => (
                        <tr key={p.name} className="border-b last:border-0">
                          <td className="py-1.5 font-medium">{p.name}</td>
                          <td className="py-1.5 text-right">{p.units}</td>
                          <td className="py-1.5 text-right">{INR(p.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ── GST Summary Tab ── */}
          <TabsContent value="gst" className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <KpiCard label="Total Tax Invoices" value={String(data.gst.overall.totalInvoices)} icon={Receipt} />
              <KpiCard label="Taxable Turnover" value={INR(data.gst.overall.totalTaxable)} icon={TrendingUp} />
              <KpiCard label="Total GST Collected" value={INR(data.gst.overall.totalGstCollected)} icon={BarChart2} color="text-green-600" />
              <KpiCard label="CGST" value={INR(data.gst.overall.cgst)} icon={Receipt} color="text-blue-600" />
              <KpiCard label="SGST" value={INR(data.gst.overall.sgst)} icon={Receipt} color="text-purple-600" />
              <KpiCard label="IGST" value={INR(data.gst.overall.igst)} icon={Receipt} color="text-orange-600" />
            </div>

            {/* GST by Channel */}
            <Card>
              <CardHeader><CardTitle className="text-base">GST by Channel</CardTitle></CardHeader>
              <CardContent>
                {data.gst.byChannel.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8 text-sm">No GST invoice data for this period</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="pb-2 text-left">Channel</th>
                        <th className="pb-2 text-right">CGST</th>
                        <th className="pb-2 text-right">SGST</th>
                        <th className="pb-2 text-right">IGST</th>
                        <th className="pb-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.gst.byChannel.map(r => (
                        <tr key={r.channel} className="border-b last:border-0">
                          <td className="py-2 font-medium">{CHANNEL_LABELS[r.channel] ?? r.channel}</td>
                          <td className="py-2 text-right text-blue-600">{INR(r.cgst)}</td>
                          <td className="py-2 text-right text-purple-600">{INR(r.sgst)}</td>
                          <td className="py-2 text-right text-orange-600">{INR(r.igst)}</td>
                          <td className="py-2 text-right font-bold">{INR(r.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {/* GST by State */}
            {data.gst.byStateOfSupply.length > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">GST by State of Supply</CardTitle></CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="pb-2 text-left">State</th>
                        <th className="pb-2 text-right">CGST</th>
                        <th className="pb-2 text-right">SGST</th>
                        <th className="pb-2 text-right">IGST</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.gst.byStateOfSupply.map(r => (
                        <tr key={r.state} className="border-b last:border-0">
                          <td className="py-2 font-medium">{r.state ?? 'Unknown'}</td>
                          <td className="py-2 text-right text-blue-600">{INR(r.cgst)}</td>
                          <td className="py-2 text-right text-purple-600">{INR(r.sgst)}</td>
                          <td className="py-2 text-right text-orange-600">{INR(r.igst)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── Promotions Tab ── */}
          <TabsContent value="promotions" className="space-y-4">
            {data?.promotionPerformance && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <KpiCard
                    label="Total Discounts Given"
                    value={INR(data.promotionPerformance.totalDiscountGiven)}
                    sub="Shop + POS"
                    icon={Tag}
                    color="text-orange-600"
                  />
                  <KpiCard
                    label="Net Revenue (Shop + POS)"
                    value={INR(data.promotionPerformance.netRevenue)}
                    sub={`${INR(data.promotionPerformance.totalDiscountGiven)} in discounts applied`}
                    icon={TrendingUp}
                    color="text-green-700"
                  />
                  <KpiCard
                    label="Promotion Rate"
                    value={`${data.promotionPerformance.promotionRate.toFixed(1)}%`}
                    sub="of shop gross revenue"
                    icon={Tag}
                    color={data.promotionPerformance.promotionRate > 15 ? 'text-red-600' : 'text-green-600'}
                  />
                  <KpiCard
                    label="Discounted Shop Orders"
                    value={String(data.promotionPerformance.shopDiscountedOrders)}
                    sub={`${INR(data.promotionPerformance.shopDiscountTotal)} discount`}
                    icon={ShoppingBag}
                  />
                </div>
                <Card>
                  <CardHeader><CardTitle className="text-base">Discount Breakdown by Channel</CardTitle></CardHeader>
                  <CardContent>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="pb-2 text-left">Channel</th>
                          <th className="pb-2 text-right">Discounted Orders</th>
                          <th className="pb-2 text-right">Total Discount</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b">
                          <td className="py-2 font-medium flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full inline-block bg-green-500" /> Online Shop
                          </td>
                          <td className="py-2 text-right">{data.promotionPerformance.shopDiscountedOrders}</td>
                          <td className="py-2 text-right font-bold">{INR(data.promotionPerformance.shopDiscountTotal)}</td>
                        </tr>
                        <tr>
                          <td className="py-2 font-medium flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full inline-block bg-blue-500" /> POS / Pro Shop
                          </td>
                          <td className="py-2 text-right">{data.promotionPerformance.posDiscountedTransactions}</td>
                          <td className="py-2 text-right font-bold">{INR(data.promotionPerformance.posDiscountTotal)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>

          {/* ── Staff Performance Tab ── */}
          <TabsContent value="staff" className="space-y-4">
            <Card>
              <CardHeader><CardTitle className="text-base">POS Staff Performance</CardTitle></CardHeader>
              <CardContent>
                {data.staffPerformance.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8 text-sm">No POS transactions in this period</div>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={250}>
                      <BarChart data={data.staffPerformance.slice(0, 10)} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tickFormatter={v => INR(v)} tick={{ fontSize: 10 }} />
                        <Tooltip formatter={(v: number) => INR(v)} />
                        <Bar dataKey="totalRevenue" fill={CHANNEL_COLORS.pos} name="Revenue" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>

                    <table className="w-full text-sm mt-4">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="pb-2 text-left">Staff Member</th>
                          <th className="pb-2 text-right">Transactions</th>
                          <th className="pb-2 text-right">Revenue</th>
                          <th className="pb-2 text-right">Avg/Txn</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.staffPerformance.map(s => (
                          <tr key={s.userId ?? s.name} className="border-b last:border-0">
                            <td className="py-2 font-medium">{s.name}</td>
                            <td className="py-2 text-right">{s.salesCount}</td>
                            <td className="py-2 text-right font-bold">{INR(s.totalRevenue)}</td>
                            <td className="py-2 text-right text-muted-foreground">
                              {s.salesCount > 0 ? INR(s.totalRevenue / s.salesCount) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Trophy({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}
