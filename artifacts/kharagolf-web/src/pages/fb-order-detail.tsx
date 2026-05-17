import { useEffect, useRef, useState } from 'react';
import { useRoute, useLocation } from 'wouter';
import {
  ChevronLeft, Loader2, UtensilsCrossed, Clock, MapPin, Receipt, AlertTriangle,
  CheckCircle2, ChefHat, PackageCheck, XCircle, CreditCard, Wallet,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useGetMe } from '@workspace/api-client-react';

interface OrderItem {
  id: number;
  orderId: number;
  menuItemId: number | null;
  name: string;
  price: string;
  quantity: number;
  modifiers: Array<{ groupId?: number; groupName?: string; optionId?: number; name: string; priceDelta: string }>;
  modifierTotal: string;
  itemNotes: string | null;
  createdAt: string;
}

interface OrderDetail {
  id: number;
  organizationId: number;
  userId: number | null;
  stationId: number | null;
  tabId: number | null;
  serverUserId: number | null;
  orderType: 'counter' | 'table' | 'on_course';
  tableLabel: string | null;
  holeNumber: number | null;
  status: 'received' | 'preparing' | 'ready' | 'delivered' | 'cancelled';
  paymentMethod: string;
  paymentStatus: string;
  paymentReference: string | null;
  totalAmount: string;
  currency: string;
  notes: string | null;
  bumpedAt: string | null;
  recalledAt: string | null;
  readyAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}

const STATUS_META: Record<OrderDetail['status'], { label: string; className: string; Icon: typeof Clock }> = {
  received: { label: 'Received', className: 'bg-amber-500/20 text-amber-300 border-amber-500/30', Icon: Receipt },
  preparing: { label: 'Preparing', className: 'bg-blue-500/20 text-blue-300 border-blue-500/30', Icon: ChefHat },
  ready: { label: 'Ready', className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30', Icon: PackageCheck },
  delivered: { label: 'Delivered', className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30', Icon: CheckCircle2 },
  cancelled: { label: 'Cancelled', className: 'bg-red-500/20 text-red-300 border-red-500/30', Icon: XCircle },
};

const ORDER_TYPE_LABEL: Record<OrderDetail['orderType'], string> = {
  counter: 'Counter pickup',
  table: 'Table service',
  on_course: 'On-course delivery',
};

function formatMoney(amount: string | number, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${currency} ${amount}`;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function FbOrderDetailPage() {
  const [, params] = useRoute('/fb-orders/:orderId');
  const [, navigate] = useLocation();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number | undefined;
  const orderId = params?.orderId ? Number(params.orderId) : NaN;

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusJustChanged, setStatusJustChanged] = useState(false);
  const pulseTimerRef = useRef<number | null>(null);
  // Mirror the latest status seen so the SSE handler can detect actual
  // transitions synchronously. Reading from React state inside the handler
  // would either be stale (closure) or lazy (state updater), so a ref keeps
  // the comparison reliable across renders.
  const lastStatusRef = useRef<OrderDetail['status'] | null>(null);

  useEffect(() => {
    // Guard: invalid route param (e.g. /fb-orders/abc). Surface the same
    // not-found state as the API 404 path so the user sees a clear
    // message instead of a perpetual loading spinner. Without this the
    // early-return below leaves `loading` stuck at true forever.
    if (!Number.isFinite(orderId)) {
      setLoading(false);
      setError('not_found');
      return;
    }
    // Wait for `useGetMe` to resolve the caller's orgId before fetching.
    if (!orgId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/organizations/${orgId}/fb/orders/${orderId}/mine`, { credentials: 'include' })
      .then(async r => {
        if (r.status === 404) throw new Error('not_found');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<OrderDetail>;
      })
      .then(d => { if (!cancelled) { setOrder(d); lastStatusRef.current = d.status; setLoading(false); } })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error && e.message === 'not_found' ? 'not_found' : 'load_failed');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [orgId, orderId]);

  // Live order status via SSE. The api-server broadcasts every status change
  // on this per-order stream, so members see "preparing → ready → delivered"
  // updates in place without refreshing. We only subscribe once we know the
  // org and have a valid order id, and we tear the connection down on unmount.
  useEffect(() => {
    if (!orgId || !Number.isFinite(orderId)) return;

    const sse = new EventSource(
      `/api/organizations/${orgId}/fb/orders/${orderId}/sse`,
      { withCredentials: true },
    );

    sse.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type?: string; data?: { orderId?: number; status?: OrderDetail['status'] } };
        if (msg.type !== 'order_status' || !msg.data?.status) return;
        const nextStatus = msg.data.status;
        // Compare against the ref synchronously. The server pushes the
        // current status as the very first frame on connect, so without
        // this guard members would see a "status changed" cue on every
        // page load — even though nothing actually changed.
        const didChange = lastStatusRef.current !== null && lastStatusRef.current !== nextStatus;
        lastStatusRef.current = nextStatus;
        setOrder(prev => {
          if (!prev) return prev;
          if (prev.status === nextStatus) return prev;
          // Stamp the relevant client-side timestamp when crossing into ready/
          // delivered so the existing rows render without waiting for a refetch.
          // The authoritative server value will overwrite this on next load.
          const nowIso = new Date().toISOString();
          return {
            ...prev,
            status: nextStatus,
            readyAt: nextStatus === 'ready' && !prev.readyAt ? nowIso : prev.readyAt,
            deliveredAt: nextStatus === 'delivered' && !prev.deliveredAt ? nowIso : prev.deliveredAt,
            updatedAt: nowIso,
          };
        });
        if (!didChange) return;
        setStatusJustChanged(true);
        if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = window.setTimeout(() => setStatusJustChanged(false), 4000);
      } catch {
        // Ignore malformed frames; the next message will refresh state.
      }
    };

    return () => {
      sse.close();
      if (pulseTimerRef.current) {
        window.clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = null;
      }
    };
  }, [orgId, orderId]);

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-3xl" data-testid="fb-order-detail-page">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => navigate('/portal')}
        className="mb-4 text-muted-foreground hover:text-white"
        data-testid="back-to-portal"
      >
        <ChevronLeft className="w-4 h-4 mr-1" /> Back to portal
      </Button>

      <div className="flex items-center gap-2 mb-4">
        <UtensilsCrossed className="w-5 h-5 text-primary" />
        <h1 className="text-2xl font-bold text-white">F&amp;B Order</h1>
      </div>

      {loading ? (
        <Card className="glass-panel border-white/10 p-8 flex items-center gap-3 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading order…
        </Card>
      ) : error === 'not_found' ? (
        <Card className="glass-panel border-white/10 p-8 text-center" data-testid="fb-order-not-found">
          <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto mb-3" />
          <p className="text-white font-semibold mb-1">Order not found</p>
          <p className="text-sm text-muted-foreground">
            We couldn't find this order on your account. It may have been removed or it isn't yours to view.
          </p>
        </Card>
      ) : error ? (
        <Card className="glass-panel border-white/10 p-8 text-center" data-testid="fb-order-error">
          <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-white font-semibold mb-1">Couldn't load order</p>
          <p className="text-sm text-muted-foreground">Please refresh the page to try again.</p>
        </Card>
      ) : order ? (
        <FbOrderBody order={order} statusJustChanged={statusJustChanged} />
      ) : null}
    </div>
  );
}

function FbOrderBody({ order, statusJustChanged }: { order: OrderDetail; statusJustChanged: boolean }) {
  const meta = STATUS_META[order.status];
  const StatusIcon = meta.Icon;
  const itemsTotalNum = order.items.reduce((sum, it) => {
    const line = (Number(it.price) + Number(it.modifierTotal)) * it.quantity;
    return sum + (Number.isFinite(line) ? line : 0);
  }, 0);

  return (
    <div className="space-y-4" data-testid="fb-order-detail-body">
      <Card className="glass-panel border-white/10 p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-xs text-muted-foreground">Order</p>
            <p className="text-xl font-bold text-white" data-testid="fb-order-id">#{order.id}</p>
          </div>
          <Badge
            className={`${meta.className} flex items-center gap-1.5 ${statusJustChanged ? 'ring-2 ring-white/40 ring-offset-1 ring-offset-transparent' : ''}`}
            data-testid="fb-order-status"
          >
            {statusJustChanged ? (
              <span
                className="relative inline-flex w-2 h-2"
                data-testid="fb-order-status-pulse"
                aria-label="Status just updated"
              >
                <span className="absolute inset-0 rounded-full bg-current opacity-75 animate-ping" />
                <span className="relative inline-flex w-2 h-2 rounded-full bg-current" />
              </span>
            ) : (
              <StatusIcon className="w-3 h-3" />
            )}
            {meta.label}
          </Badge>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <Row icon={Clock} label="Placed">
            {formatDateTime(order.createdAt)}
          </Row>
          <Row icon={MapPin} label="Fulfilment">
            {ORDER_TYPE_LABEL[order.orderType]}
            {order.holeNumber ? ` · Hole ${order.holeNumber}` : ''}
            {order.tableLabel ? ` · ${order.tableLabel}` : ''}
          </Row>
          {order.readyAt ? (
            <Row icon={PackageCheck} label="Ready">{formatDateTime(order.readyAt)}</Row>
          ) : null}
          {order.deliveredAt ? (
            <Row icon={CheckCircle2} label="Delivered">{formatDateTime(order.deliveredAt)}</Row>
          ) : null}
          <Row
            icon={order.paymentMethod === 'account_charge' ? Wallet : CreditCard}
            label="Payment"
          >
            {order.paymentMethod === 'account_charge' ? 'Charged to account' : 'Card on delivery'}
            <span className="text-muted-foreground"> · {order.paymentStatus}</span>
          </Row>
        </div>
      </Card>

      <Card className="glass-panel border-white/10 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Receipt className="w-4 h-4 text-primary" />
          <h2 className="font-semibold text-white">Items</h2>
        </div>
        {order.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No line items recorded.</p>
        ) : (
          <ul className="divide-y divide-white/10" data-testid="fb-order-items">
            {order.items.map(item => (
              <li key={item.id} className="py-3 flex items-start gap-3" data-testid={`fb-order-item-${item.id}`}>
                <span className="text-sm text-muted-foreground w-8 shrink-0 text-center">×{item.quantity}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-white">{item.name}</p>
                  {item.modifiers && item.modifiers.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {item.modifiers.map(m => m.name).join(', ')}
                    </p>
                  ) : null}
                  {item.itemNotes ? (
                    <p className="text-xs text-muted-foreground italic">"{item.itemNotes}"</p>
                  ) : null}
                </div>
                <span className="text-sm text-white shrink-0">
                  {formatMoney((Number(item.price) + Number(item.modifierTotal)) * item.quantity, order.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/10">
          <span className="text-sm text-muted-foreground">Items subtotal</span>
          <span className="text-sm text-white">{formatMoney(itemsTotalNum, order.currency)}</span>
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="font-semibold text-white">Total</span>
          <span className="font-semibold text-white" data-testid="fb-order-total">
            {formatMoney(order.totalAmount, order.currency)}
          </span>
        </div>
      </Card>

      {order.notes ? (
        <Card className="glass-panel border-white/10 p-5">
          <p className="text-xs text-muted-foreground mb-1">Order notes</p>
          <p className="text-sm text-white whitespace-pre-wrap">{order.notes}</p>
        </Card>
      ) : null}
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Clock;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-white">{children}</p>
      </div>
    </div>
  );
}
