import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import {
  Coffee, RefreshCw, Clock, CheckCircle2, Package, Truck, XCircle,
  ChevronRight, ArrowUpCircle, RotateCcw, Users,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface OrderItemModifier { name: string; priceDelta: string }
interface OrderItem {
  name: string;
  price: string;
  quantity: number;
  modifiers?: OrderItemModifier[] | null;
  itemNotes?: string | null;
}

interface FbOrder {
  id: number;
  holeNumber?: number;
  status: 'received' | 'preparing' | 'ready' | 'delivered' | 'cancelled';
  paymentMethod: string;
  totalAmount: string;
  currency: string;
  notes?: string;
  userName?: string;
  userEmail?: string;
  stationId?: number;
  serverUserId?: number | null;
  orderType?: 'counter' | 'table' | 'on_course';
  tableLabel?: string | null;
  bumpedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}

interface ServerSalesRow {
  serverUserId: number | null;
  serverName: string;
  orderCount: number;
  revenue: string;
}

interface Station {
  id: number;
  name: string;
  isActive: boolean;
}

interface RevenueData {
  totalRevenue: string;
  totalOrders: number;
  cancelledOrders: number;
  avgOrderValue: string;
  dailyRevenue: { date: string; revenue: string }[];
  topItems: { name: string; quantity: number; revenue: number }[];
  categoryRevenue: { name: string; revenue: number; quantity: number }[];
}

const STATUS_CONFIG = {
  received: { label: 'Received', color: 'bg-amber-500/15 text-amber-400 border-amber-500/30', icon: Clock, next: 'preparing', nextLabel: 'Start Preparing' },
  preparing: { label: 'Preparing', color: 'bg-blue-500/15 text-blue-400 border-blue-500/30', icon: Package, next: 'ready', nextLabel: 'Mark Ready' },
  ready: { label: 'Ready', color: 'bg-green-500/15 text-green-400 border-green-500/30', icon: CheckCircle2, next: 'delivered', nextLabel: 'Mark Delivered' },
  delivered: { label: 'Delivered', color: 'bg-muted text-muted-foreground border-border', icon: Truck, next: null, nextLabel: null },
  cancelled: { label: 'Cancelled', color: 'bg-red-500/15 text-red-400 border-red-500/30', icon: XCircle, next: null, nextLabel: null },
};

function fmtPrice(price: string | number, currency = 'INR') {
  return currency === 'INR' ? `₹${parseFloat(String(price)).toFixed(2)}` : `${currency} ${parseFloat(String(price)).toFixed(2)}`;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

export default function FbFulfillmentPage() {
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;
  const qc = useQueryClient();

  const [selectedStation, setSelectedStation] = useState<string>('all');
  const [selectedServer, setSelectedServer] = useState<string>('all');
  const [hideBumped, setHideBumped] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('active');
  const [updatingOrder, setUpdatingOrder] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'queue' | 'history' | 'revenue' | 'servers'>('queue');
  const [revenueDate, setRevenueDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [serversStart, setServersStart] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().split('T')[0]; });
  const [serversEnd, setServersEnd] = useState(() => new Date().toISOString().split('T')[0]);
  const sseRef = useRef<EventSource | null>(null);

  const { data: stations = [] } = useQuery<Station[]>({
    queryKey: [`fb-stations-${orgId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/fb/stations`).then(r => r.json()),
    enabled: !!orgId,
  });

  const fetchOrders = useCallback(async () => {
    if (!orgId) return [];
    const params = new URLSearchParams();
    if (selectedStation !== 'all') params.set('stationId', selectedStation);
    const url = `/api/organizations/${orgId}/fb/orders?${params}`;
    return fetch(url).then(r => r.json());
  }, [orgId, selectedStation]);

  const { data: orders = [], refetch: refetchOrders, isLoading } = useQuery<FbOrder[]>({
    queryKey: [`fb-orders-${orgId}-${selectedStation}`],
    queryFn: fetchOrders,
    enabled: !!orgId,
    refetchInterval: 30000,
  });

  const { data: revenue } = useQuery<RevenueData>({
    queryKey: [`fb-revenue-${orgId}-${revenueDate}`],
    queryFn: () =>
      fetch(`/api/organizations/${orgId}/fb/reports/revenue?startDate=${revenueDate}&endDate=${revenueDate}`)
        .then(r => r.json()),
    enabled: !!orgId && activeTab === 'revenue',
  });

  const { data: serverSales = [] } = useQuery<ServerSalesRow[]>({
    queryKey: [`fb-server-sales-${orgId}-${serversStart}-${serversEnd}`],
    queryFn: () =>
      fetch(`/api/organizations/${orgId}/fb/reports/server-sales?startDate=${serversStart}&endDate=${serversEnd}`)
        .then(r => r.json()),
    enabled: !!orgId && activeTab === 'servers',
  });

  // SSE connection for real-time order updates
  useEffect(() => {
    if (!orgId) return;
    const es = new EventSource(`/api/organizations/${orgId}/fb/sse/orders`);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'new_order' || msg.type === 'order_status') {
          qc.invalidateQueries({ queryKey: [`fb-orders-${orgId}-${selectedStation}`] });
          if (msg.type === 'new_order') {
            toast({ title: `New order #${msg.data.id}`, description: `Hole ${msg.data.holeNumber ?? '?'} — ${fmtPrice(msg.data.totalAmount, msg.data.currency)}` });
          }
        }
      } catch {}
    };
    sseRef.current = es;
    return () => es.close();
  }, [orgId, selectedStation]);

  async function bumpOrder(order: FbOrder) {
    setUpdatingOrder(order.id);
    try {
      await fetch(`/api/organizations/${orgId}/fb/orders/${order.id}/bump`, { method: 'POST' });
      await refetchOrders();
      toast({ title: `Bumped #${order.id}` });
    } catch { toast({ title: 'Bump failed', variant: 'destructive' }); }
    finally { setUpdatingOrder(null); }
  }

  async function recallOrder(order: FbOrder) {
    setUpdatingOrder(order.id);
    try {
      await fetch(`/api/organizations/${orgId}/fb/orders/${order.id}/recall`, { method: 'POST' });
      await refetchOrders();
      toast({ title: `Recalled #${order.id}` });
    } catch { toast({ title: 'Recall failed', variant: 'destructive' }); }
    finally { setUpdatingOrder(null); }
  }

  async function updateStatus(order: FbOrder, newStatus: string) {
    if (!orgId) return;
    setUpdatingOrder(order.id);
    try {
      const r = await fetch(`/api/organizations/${orgId}/fb/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!r.ok) throw new Error('Update failed');
      await refetchOrders();
      toast({ title: `Order #${order.id} → ${STATUS_CONFIG[newStatus as keyof typeof STATUS_CONFIG]?.label}` });
    } catch {
      toast({ title: 'Update failed', variant: 'destructive' });
    } finally { setUpdatingOrder(null); }
  }

  const activeStatuses = ['received', 'preparing', 'ready'];
  const filteredOrders = orders.filter(o => {
    if (filterStatus === 'active') {
      if (!activeStatuses.includes(o.status)) return false;
    } else if (filterStatus !== 'all' && o.status !== filterStatus) return false;
    if (hideBumped && o.bumpedAt) return false;
    if (selectedServer !== 'all' && String(o.serverUserId ?? '') !== selectedServer) return false;
    return true;
  });
  const serverIdsInQueue = Array.from(new Set(orders.map(o => o.serverUserId).filter((x): x is number => typeof x === 'number')));

  const activeCount = orders.filter(o => activeStatuses.includes(o.status)).length;

  if (!orgId) return (
    <div className="p-8 text-center text-muted-foreground">Select an organization to view the fulfillment queue.</div>
  );

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Coffee className="w-6 h-6 text-primary" /> F&B Fulfillment
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Real-time order queue for kitchen & bar staff</p>
        </div>
        <div className="flex items-center gap-2">
          {activeCount > 0 && (
            <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 border text-sm px-3">
              {activeCount} active
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => refetchOrders()}>
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList className="mb-6">
          <TabsTrigger value="queue">Order Queue</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="revenue">Revenue</TabsTrigger>
          <TabsTrigger value="servers"><Users className="w-4 h-4 mr-1" />Server Sales</TabsTrigger>
        </TabsList>

        {/* ── ORDER QUEUE ── */}
        <TabsContent value="queue">
          {/* Filters */}
          <div className="flex gap-3 mb-4 flex-wrap items-center">
            <Select value={selectedStation} onValueChange={setSelectedStation}>
              <SelectTrigger className="w-48"><SelectValue placeholder="All stations" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Stations</SelectItem>
                {stations.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active Only</SelectItem>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="received">Received</SelectItem>
                <SelectItem value="preparing">Preparing</SelectItem>
                <SelectItem value="ready">Ready</SelectItem>
                <SelectItem value="delivered">Delivered</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            {serverIdsInQueue.length > 0 && (
              <Select value={selectedServer} onValueChange={setSelectedServer}>
                <SelectTrigger className="w-40"><SelectValue placeholder="All servers" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Servers</SelectItem>
                  {serverIdsInQueue.map(id => <SelectItem key={id} value={String(id)}>Server #{id}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={hideBumped} onChange={e => setHideBumped(e.target.checked)} />
              Hide bumped
            </label>
          </div>

          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Loading orders...</div>
          ) : filteredOrders.length === 0 ? (
            <Card><CardContent className="p-12 text-center">
              <Coffee className="w-12 h-12 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground">No orders in queue</p>
            </CardContent></Card>
          ) : (
            <div className="grid gap-4">
              {filteredOrders.map(order => {
                const cfg = STATUS_CONFIG[order.status];
                const StatusIcon = cfg.icon;
                return (
                  <Card key={order.id} className="overflow-hidden">
                    <CardContent className="p-0">
                      <div className="flex">
                        <div className={`w-1.5 ${order.bumpedAt ? 'bg-zinc-500' : order.status === 'received' ? 'bg-amber-500' : order.status === 'preparing' ? 'bg-blue-500' : order.status === 'ready' ? 'bg-green-500' : 'bg-muted'}`} />
                        <div className="flex-1 p-4">
                          <div className="flex items-start justify-between mb-3">
                            <div>
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span className="font-bold text-lg">Order #{order.id}</span>
                                <Badge variant="outline" className={cfg.color}>
                                  <StatusIcon className="w-3 h-3 mr-1" />{cfg.label}
                                </Badge>
                                {order.bumpedAt && <Badge variant="secondary" className="text-xs">Bumped</Badge>}
                                {order.orderType === 'table' && order.tableLabel && <Badge variant="secondary" className="text-xs">Table {order.tableLabel}</Badge>}
                                {order.orderType === 'counter' && <Badge variant="secondary" className="text-xs">Counter</Badge>}
                                {order.holeNumber != null && (
                                  <Badge variant="secondary" className="text-xs">Hole {order.holeNumber}</Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {order.userName ?? 'Guest'} · {timeAgo(order.createdAt)}
                                {order.serverUserId != null && ` · Server #${order.serverUserId}`}
                                {order.paymentMethod === 'account_charge' && ' · Account Charge'}
                              </p>
                            </div>
                            <span className="font-bold text-primary">{fmtPrice(order.totalAmount, order.currency)}</span>
                          </div>

                          {/* Items with modifiers */}
                          <div className="bg-muted/30 rounded-lg p-3 mb-3 space-y-2">
                            {order.items.map((item, i) => (
                              <div key={i} className="text-sm">
                                <div className="flex justify-between">
                                  <span className="text-foreground font-medium">{item.quantity}× {item.name}</span>
                                  <span className="text-muted-foreground">{fmtPrice(parseFloat(item.price) * item.quantity, order.currency)}</span>
                                </div>
                                {item.modifiers && item.modifiers.length > 0 && (
                                  <ul className="ml-6 mt-0.5 text-xs text-muted-foreground list-disc">
                                    {item.modifiers.map((m, j) => (
                                      <li key={j}>{m.name}{parseFloat(m.priceDelta) !== 0 && ` (+${fmtPrice(m.priceDelta, order.currency)})`}</li>
                                    ))}
                                  </ul>
                                )}
                                {item.itemNotes && (
                                  <p className="ml-6 mt-0.5 text-xs italic text-amber-400">⚠ {item.itemNotes}</p>
                                )}
                              </div>
                            ))}
                          </div>

                          {order.notes && (
                            <p className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-3">
                              📝 {order.notes}
                            </p>
                          )}

                          <div className="flex gap-2 flex-wrap">
                            {cfg.next && (
                              <Button size="sm" onClick={() => updateStatus(order, cfg.next!)} disabled={updatingOrder === order.id} className="flex-1 min-w-[120px]">
                                {updatingOrder === order.id ? 'Updating...' : cfg.nextLabel}
                                <ChevronRight className="w-4 h-4 ml-1" />
                              </Button>
                            )}
                            {!order.bumpedAt && (order.status === 'ready' || order.status === 'preparing') && (
                              <Button size="sm" variant="outline" onClick={() => bumpOrder(order)} disabled={updatingOrder === order.id}>
                                <ArrowUpCircle className="w-4 h-4 mr-1" /> Bump
                              </Button>
                            )}
                            {order.bumpedAt && (
                              <Button size="sm" variant="outline" onClick={() => recallOrder(order)} disabled={updatingOrder === order.id}>
                                <RotateCcw className="w-4 h-4 mr-1" /> Recall
                              </Button>
                            )}
                            {order.status !== 'cancelled' && order.status !== 'delivered' && (
                              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive"
                                onClick={() => updateStatus(order, 'cancelled')} disabled={updatingOrder === order.id}>
                                Cancel
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── HISTORY ── */}
        <TabsContent value="history">
          <div className="grid gap-3">
            {orders.filter(o => o.status === 'delivered' || o.status === 'cancelled').slice(0, 50).map(order => {
              const cfg = STATUS_CONFIG[order.status];
              const StatusIcon = cfg.icon;
              return (
                <Card key={order.id}>
                  <CardContent className="p-4 flex items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold">Order #{order.id}</span>
                        <Badge variant="outline" className={`text-xs ${cfg.color}`}>
                          <StatusIcon className="w-3 h-3 mr-1" />{cfg.label}
                        </Badge>
                        {order.holeNumber && <span className="text-xs text-muted-foreground">Hole {order.holeNumber}</span>}
                      </div>
                      <p className="text-xs text-muted-foreground">{order.userName ?? 'Guest'} · {new Date(order.createdAt).toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">{order.items.map(i => `${i.quantity}× ${i.name}`).join(', ')}</p>
                    </div>
                    <span className="font-bold text-primary">{fmtPrice(order.totalAmount, order.currency)}</span>
                  </CardContent>
                </Card>
              );
            })}
            {orders.filter(o => o.status === 'delivered' || o.status === 'cancelled').length === 0 && (
              <Card><CardContent className="p-8 text-center text-muted-foreground">No completed orders yet.</CardContent></Card>
            )}
          </div>
        </TabsContent>

        {/* ── REVENUE ── */}
        <TabsContent value="revenue">
          <div className="flex items-center gap-4 mb-6">
            <div>
              <label className="text-sm font-medium block mb-1">Date</label>
              <input type="date" value={revenueDate} onChange={e => setRevenueDate(e.target.value)}
                className="border rounded px-3 py-2 text-sm bg-background" />
            </div>
          </div>

          {!revenue ? (
            <div className="text-center py-12 text-muted-foreground">Loading revenue data...</div>
          ) : (
            <div className="space-y-6">
              {/* KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Total Revenue', value: fmtPrice(revenue.totalRevenue) },
                  { label: 'Total Orders', value: String(revenue.totalOrders) },
                  { label: 'Avg Order Value', value: fmtPrice(revenue.avgOrderValue) },
                  { label: 'Cancelled', value: String(revenue.cancelledOrders) },
                ].map(kpi => (
                  <Card key={kpi.label}>
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground mb-1">{kpi.label}</p>
                      <p className="text-xl font-bold">{kpi.value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Top items */}
              {revenue.topItems.length > 0 && (
                <Card>
                  <CardHeader><CardTitle className="text-base">Top Items</CardTitle></CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {revenue.topItems.slice(0, 10).map((item, i) => (
                        <div key={i} className="flex items-center justify-between">
                          <span className="text-sm">{item.name}</span>
                          <div className="flex items-center gap-4 text-sm">
                            <span className="text-muted-foreground">{item.quantity} sold</span>
                            <span className="font-semibold text-primary">{fmtPrice(item.revenue)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Category breakdown */}
              {revenue.categoryRevenue.length > 0 && (
                <Card>
                  <CardHeader><CardTitle className="text-base">By Category</CardTitle></CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {revenue.categoryRevenue.map((cat, i) => (
                        <div key={i} className="flex items-center justify-between">
                          <span className="text-sm">{cat.name}</span>
                          <div className="flex items-center gap-4 text-sm">
                            <span className="text-muted-foreground">{cat.quantity} items</span>
                            <span className="font-semibold text-primary">{fmtPrice(cat.revenue)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </TabsContent>

        {/* ── SERVER SALES ── */}
        <TabsContent value="servers">
          <div className="flex items-end gap-3 mb-6 flex-wrap">
            <div>
              <label className="text-sm font-medium block mb-1">From</label>
              <input type="date" value={serversStart} onChange={e => setServersStart(e.target.value)} className="border rounded px-3 py-2 text-sm bg-background" />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">To</label>
              <input type="date" value={serversEnd} onChange={e => setServersEnd(e.target.value)} className="border rounded px-3 py-2 text-sm bg-background" />
            </div>
          </div>
          {serverSales.length === 0 ? (
            <Card><CardContent className="p-8 text-center text-muted-foreground">No server sales in this range.</CardContent></Card>
          ) : (
            <Card>
              <CardHeader><CardTitle className="text-base">Sales by Server</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground border-b">
                    <tr><th className="text-left py-2">Server</th><th className="text-right">Orders</th><th className="text-right">Revenue</th></tr>
                  </thead>
                  <tbody>
                    {serverSales.map((row, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-2">{row.serverName || `Server #${row.serverUserId ?? '—'}`}</td>
                        <td className="text-right">{row.orderCount}</td>
                        <td className="text-right font-semibold text-primary">{fmtPrice(row.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
