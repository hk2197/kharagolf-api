import { useState, useEffect, useCallback } from 'react';
import {
  Car, Plus, RefreshCw, Wrench, BarChart2, ArrowLeft,
  CheckCircle2, AlertTriangle, Clock, Pencil, Trash2,
  ListOrdered, ChevronDown, ChevronUp, X, RotateCcw,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

type CartStatus = 'available' | 'in_use' | 'maintenance' | 'retired';
type CartType = 'single' | 'double';

interface Cart {
  id: number;
  identifier: string;
  type: CartType;
  status: CartStatus;
  notes: string | null;
  nextServiceDue: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ActiveAssignment {
  id: number;
  playerName: string | null;
  assignedAt: string;
  expectedReturnAt: string | null;
  bookingId: number | null;
  notes: string | null;
}

interface FleetBoardEntry extends Cart {
  activeAssignment: ActiveAssignment | null;
  isOverdue: boolean;
  isServiceDue: boolean;
}

interface MaintenanceLog {
  id: number;
  serviceDate: string;
  nextServiceDue: string | null;
  notes: string;
  loggedByUserId: number | null;
  createdAt: string;
}

interface UtilisationCart {
  cartId: number;
  identifier: string;
  type: CartType;
  status: CartStatus;
  totalUses: number;
  totalHours: number;
  byDay: { date: string; uses: number }[];
}

const STATUS_COLOR: Record<CartStatus, string> = {
  available: 'text-emerald-400 bg-emerald-500/20 border-emerald-500/30',
  in_use: 'text-blue-400 bg-blue-500/20 border-blue-500/30',
  maintenance: 'text-amber-400 bg-amber-500/20 border-amber-500/30',
  retired: 'text-gray-400 bg-gray-500/20 border-gray-500/30',
};

const STATUS_LABELS: Record<CartStatus, string> = {
  available: 'Available',
  in_use: 'In Use',
  maintenance: 'Maintenance',
  retired: 'Retired',
};

type Tab = 'board' | 'fleet' | 'maintenance' | 'utilisation';

export default function CartFleetPage() {
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>('board');
  const [fleetBoard, setFleetBoard] = useState<FleetBoardEntry[]>([]);
  const [carts, setCarts] = useState<Cart[]>([]);
  const [utilisation, setUtilisation] = useState<UtilisationCart[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Cart form
  const [showCartForm, setShowCartForm] = useState(false);
  const [editingCart, setEditingCart] = useState<Cart | null>(null);
  const [cartForm, setCartForm] = useState({ identifier: '', type: 'double' as CartType, status: 'available' as CartStatus, notes: '', nextServiceDue: '' });

  // Assign form
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [assigningCart, setAssigningCart] = useState<FleetBoardEntry | null>(null);
  const [assignForm, setAssignForm] = useState({ playerName: '', expectedReturnAt: '' });

  // Maintenance form
  const [showMaintenanceForm, setShowMaintenanceForm] = useState(false);
  const [selectedCartForMaint, setSelectedCartForMaint] = useState<Cart | null>(null);
  const [maintLogs, setMaintLogs] = useState<MaintenanceLog[]>([]);
  const [maintForm, setMaintForm] = useState({ serviceDate: new Date().toISOString().split('T')[0], nextServiceDue: '', notes: '' });
  const [showLogs, setShowLogs] = useState(false);

  const [utilisationFrom, setUtilisationFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [utilisationTo, setUtilisationTo] = useState(() => new Date().toISOString().split('T')[0]);

  const fetchFleetBoard = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/organizations/${orgId}/carts/fleet-board`, { credentials: 'include' });
    if (res.ok) setFleetBoard(await res.json());
  }, [orgId]);

  const fetchCarts = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/organizations/${orgId}/carts`, { credentials: 'include' });
    if (res.ok) setCarts(await res.json());
  }, [orgId]);

  const fetchUtilisation = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/organizations/${orgId}/carts/utilisation?from=${utilisationFrom}&to=${utilisationTo}`, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      setUtilisation(data.carts ?? []);
    }
  }, [orgId, utilisationFrom, utilisationTo]);

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    Promise.all([fetchFleetBoard(), fetchCarts()]).finally(() => setLoading(false));
  }, [orgId, fetchFleetBoard, fetchCarts]);

  useEffect(() => {
    if (tab === 'utilisation') fetchUtilisation();
  }, [tab, fetchUtilisation]);

  // Auto-refresh fleet board every 60s
  useEffect(() => {
    const id = setInterval(fetchFleetBoard, 60000);
    return () => clearInterval(id);
  }, [fetchFleetBoard]);

  async function handleSaveCart() {
    setSaving(true);
    try {
      const url = editingCart
        ? `/api/organizations/${orgId}/carts/${editingCart.id}`
        : `/api/organizations/${orgId}/carts`;
      const method = editingCart ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: cartForm.identifier,
          type: cartForm.type,
          status: cartForm.status,
          notes: cartForm.notes || null,
          nextServiceDue: cartForm.nextServiceDue || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        toast({ title: 'Error', description: body.error ?? 'Failed to save cart', variant: 'destructive' });
        return;
      }
      toast({ title: editingCart ? 'Cart updated' : 'Cart registered' });
      setShowCartForm(false);
      setEditingCart(null);
      await Promise.all([fetchCarts(), fetchFleetBoard()]);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCart(cartId: number) {
    if (!confirm('Remove this cart from the fleet?')) return;
    const res = await fetch(`/api/organizations/${orgId}/carts/${cartId}`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      toast({ title: 'Cart removed' });
      await Promise.all([fetchCarts(), fetchFleetBoard()]);
    }
  }

  async function handleAssign() {
    if (!assigningCart) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/carts/${assigningCart.id}/assign`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerName: assignForm.playerName || null,
          expectedReturnAt: assignForm.expectedReturnAt || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        toast({ title: 'Error', description: body.error, variant: 'destructive' });
        return;
      }
      toast({ title: `Cart ${assigningCart.identifier} assigned` });
      setShowAssignForm(false);
      await Promise.all([fetchCarts(), fetchFleetBoard()]);
    } finally {
      setSaving(false);
    }
  }

  async function handleReturn(cartId: number, identifier: string) {
    const res = await fetch(`/api/organizations/${orgId}/carts/${cartId}/return`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'available' }),
    });
    if (res.ok) {
      toast({ title: `Cart ${identifier} returned` });
      await Promise.all([fetchCarts(), fetchFleetBoard()]);
    } else {
      toast({ title: 'Error', description: 'Failed to return cart', variant: 'destructive' });
    }
  }

  async function handleSendToMaintenance(cartId: number) {
    await fetch(`/api/organizations/${orgId}/carts/${cartId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'maintenance' }),
    });
    await Promise.all([fetchCarts(), fetchFleetBoard()]);
    toast({ title: 'Cart sent to maintenance' });
  }

  async function openMaintenanceForm(cart: Cart) {
    setSelectedCartForMaint(cart);
    setShowLogs(false);
    setMaintForm({ serviceDate: new Date().toISOString().split('T')[0], nextServiceDue: '', notes: '' });
    // Load logs
    const res = await fetch(`/api/organizations/${orgId}/carts/${cart.id}/maintenance`, { credentials: 'include' });
    if (res.ok) setMaintLogs(await res.json());
    setShowMaintenanceForm(true);
  }

  async function handleSaveMaintenance() {
    if (!selectedCartForMaint) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/carts/${selectedCartForMaint.id}/maintenance`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceDate: maintForm.serviceDate,
          nextServiceDue: maintForm.nextServiceDue || null,
          notes: maintForm.notes,
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        toast({ title: 'Error', description: body.error, variant: 'destructive' });
        return;
      }
      toast({ title: 'Maintenance logged' });
      setShowMaintenanceForm(false);
      await Promise.all([fetchCarts(), fetchFleetBoard()]);
    } finally {
      setSaving(false);
    }
  }

  async function handleCheckOverdue() {
    const res = await fetch(`/api/organizations/${orgId}/carts/check-overdue`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.ok) {
      const { overdueAlerts, serviceDueCarts } = await res.json();
      toast({ title: `Overdue check complete`, description: `${overdueAlerts} overdue alert(s) sent. ${serviceDueCarts.length} cart(s) need service.` });
    }
  }

  function openNewCart() {
    setEditingCart(null);
    setCartForm({ identifier: '', type: 'double', status: 'available', notes: '', nextServiceDue: '' });
    setShowCartForm(true);
  }

  function openEditCart(cart: Cart) {
    setEditingCart(cart);
    setCartForm({
      identifier: cart.identifier,
      type: cart.type,
      status: cart.status,
      notes: cart.notes ?? '',
      nextServiceDue: cart.nextServiceDue ? cart.nextServiceDue.split('T')[0] : '',
    });
    setShowCartForm(true);
  }

  const availableCount = fleetBoard.filter(c => c.status === 'available').length;
  const inUseCount = fleetBoard.filter(c => c.status === 'in_use').length;
  const maintenanceCount = fleetBoard.filter(c => c.status === 'maintenance').length;
  const overdueCount = fleetBoard.filter(c => c.isOverdue).length;

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <RefreshCw className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Car className="w-6 h-6 text-primary" />
            Cart Fleet Management
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Manage your golf cart fleet, assignments, and maintenance</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleCheckOverdue}>
            <AlertTriangle className="w-4 h-4 mr-1" />
            Check Overdue
          </Button>
          <Button size="sm" onClick={openNewCart}>
            <Plus className="w-4 h-4 mr-1" />
            Register Cart
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Available', value: availableCount, color: 'text-emerald-400', icon: CheckCircle2 },
          { label: 'In Use', value: inUseCount, color: 'text-blue-400', icon: Car },
          { label: 'Maintenance', value: maintenanceCount, color: 'text-amber-400', icon: Wrench },
          { label: 'Overdue', value: overdueCount, color: 'text-red-400', icon: AlertTriangle },
        ].map(({ label, value, color, icon: Icon }) => (
          <Card key={label} className="p-4 bg-card/60 border-white/10">
            <div className={`text-3xl font-bold ${color}`}>{value}</div>
            <div className="text-sm text-muted-foreground mt-1 flex items-center gap-1">
              <Icon className="w-3.5 h-3.5" />
              {label}
            </div>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/10 pb-0">
        {([
          { id: 'board', label: 'Fleet Board', icon: Car },
          { id: 'fleet', label: 'All Carts', icon: ListOrdered },
          { id: 'maintenance', label: 'Maintenance', icon: Wrench },
          { id: 'utilisation', label: 'Utilisation', icon: BarChart2 },
        ] as { id: Tab; label: string; icon: typeof Car }[]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-white'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* ── FLEET BOARD ── */}
      {tab === 'board' && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {fleetBoard.length === 0 && (
            <div className="col-span-full text-center py-12 text-muted-foreground">
              <Car className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>No carts registered yet. Click "Register Cart" to add your first cart.</p>
            </div>
          )}
          {fleetBoard.map(entry => (
            <Card key={entry.id} className={`p-4 bg-card/60 border ${
              entry.isOverdue ? 'border-red-500/40' : entry.isServiceDue ? 'border-amber-500/40' : 'border-white/10'
            }`}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-white">{entry.identifier}</span>
                    <Badge variant="outline" className={`text-[10px] capitalize border ${STATUS_COLOR[entry.status]}`}>
                      {STATUS_LABELS[entry.status]}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground capitalize">{entry.type} seater</span>
                </div>
                {(entry.isOverdue || entry.isServiceDue) && (
                  <AlertTriangle className={`w-4 h-4 flex-shrink-0 ${entry.isOverdue ? 'text-red-400' : 'text-amber-400'}`} />
                )}
              </div>

              {entry.activeAssignment && (
                <div className="text-sm space-y-1 mb-3 bg-blue-500/10 rounded-lg p-2 border border-blue-500/20">
                  <div className="font-medium text-blue-300">{entry.activeAssignment.playerName ?? 'Player'}</div>
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Out: {new Date(entry.activeAssignment.assignedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {entry.activeAssignment.expectedReturnAt && (
                      <> · Due: {new Date(entry.activeAssignment.expectedReturnAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
                    )}
                  </div>
                  {entry.isOverdue && (
                    <div className="text-xs text-red-400 font-medium">Overdue for return</div>
                  )}
                </div>
              )}

              {entry.isServiceDue && (
                <div className="text-xs text-amber-400 mb-2 flex items-center gap-1">
                  <Wrench className="w-3 h-3" />
                  Service overdue
                </div>
              )}

              <div className="flex gap-2 flex-wrap">
                {entry.status === 'available' && (
                  <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => {
                    setAssigningCart(entry);
                    setAssignForm({ playerName: '', expectedReturnAt: '' });
                    setShowAssignForm(true);
                  }}>
                    <Car className="w-3 h-3 mr-1" />
                    Assign
                  </Button>
                )}
                {entry.status === 'in_use' && (
                  <Button size="sm" variant="outline" className="text-xs h-7 border-emerald-500/50 text-emerald-400" onClick={() => handleReturn(entry.id, entry.identifier)}>
                    <RotateCcw className="w-3 h-3 mr-1" />
                    Return
                  </Button>
                )}
                {entry.status !== 'maintenance' && entry.status !== 'retired' && (
                  <Button size="sm" variant="outline" className="text-xs h-7 border-amber-500/50 text-amber-400" onClick={() => handleSendToMaintenance(entry.id)}>
                    <Wrench className="w-3 h-3 mr-1" />
                    Maint.
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── ALL CARTS ── */}
      {tab === 'fleet' && (
        <div className="space-y-2">
          {carts.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Car className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>No carts registered yet.</p>
            </div>
          )}
          {carts.map(cart => (
            <Card key={cart.id} className="p-4 bg-card/60 border-white/10 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                  <Car className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-white">{cart.identifier}</span>
                    <Badge variant="outline" className={`text-[10px] capitalize border ${STATUS_COLOR[cart.status]}`}>
                      {STATUS_LABELS[cart.status]}
                    </Badge>
                    <span className="text-xs text-muted-foreground capitalize">{cart.type} seater</span>
                  </div>
                  {cart.notes && <p className="text-xs text-muted-foreground mt-0.5 truncate">{cart.notes}</p>}
                  {cart.nextServiceDue && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Next service: {new Date(cart.nextServiceDue).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openMaintenanceForm(cart)} title="Maintenance Log">
                  <Wrench className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditCart(cart)} title="Edit Cart">
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => handleDeleteCart(cart.id)} title="Remove Cart">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── MAINTENANCE ── */}
      {tab === 'maintenance' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Select a cart to log maintenance or view service history.</p>
          {carts.map(cart => {
            const isDue = cart.nextServiceDue && new Date(cart.nextServiceDue) <= new Date();
            return (
              <Card key={cart.id} className={`p-4 bg-card/60 border ${isDue ? 'border-amber-500/40' : 'border-white/10'} flex items-center justify-between gap-3`}>
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${isDue ? 'bg-amber-500/20' : 'bg-white/5'} border ${isDue ? 'border-amber-500/30' : 'border-white/10'}`}>
                    <Wrench className={`w-4 h-4 ${isDue ? 'text-amber-400' : 'text-muted-foreground'}`} />
                  </div>
                  <div>
                    <div className="font-semibold text-white">{cart.identifier}</div>
                    <div className="text-xs text-muted-foreground">
                      {cart.nextServiceDue
                        ? `Next service: ${new Date(cart.nextServiceDue).toLocaleDateString()}${isDue ? ' — OVERDUE' : ''}`
                        : 'No service scheduled'}
                    </div>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => openMaintenanceForm(cart)}>
                  <Wrench className="w-3.5 h-3.5 mr-1" />
                  Log Service
                </Button>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── UTILISATION ── */}
      {tab === 'utilisation' && (
        <div className="space-y-4">
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <Label className="text-xs mb-1 block">From</Label>
              <Input type="date" value={utilisationFrom} onChange={e => setUtilisationFrom(e.target.value)} className="h-8 text-sm w-36" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">To</Label>
              <Input type="date" value={utilisationTo} onChange={e => setUtilisationTo(e.target.value)} className="h-8 text-sm w-36" />
            </div>
            <Button size="sm" onClick={fetchUtilisation}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              Refresh
            </Button>
          </div>
          {utilisation.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <BarChart2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>No usage data for this period.</p>
            </div>
          )}
          <div className="space-y-2">
            {utilisation.map((entry, i) => {
              const maxUses = utilisation[0]?.totalUses ?? 1;
              const pct = maxUses > 0 ? (entry.totalUses / maxUses) * 100 : 0;
              return (
                <Card key={entry.cartId} className="p-4 bg-card/60 border-white/10">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-5">#{i + 1}</span>
                      <span className="font-semibold text-white">{entry.identifier}</span>
                      <span className="text-xs text-muted-foreground capitalize">({entry.type})</span>
                    </div>
                    <div className="text-sm text-right">
                      <span className="text-white font-medium">{entry.totalUses} uses</span>
                      <span className="text-muted-foreground text-xs"> · {entry.totalHours}h</span>
                    </div>
                  </div>
                  <div className="w-full bg-white/5 rounded-full h-1.5">
                    <div
                      className="h-1.5 rounded-full bg-primary transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Register / Edit Cart Dialog ── */}
      <Dialog open={showCartForm} onOpenChange={setShowCartForm}>
        <DialogContent className="bg-card border-white/10 max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCart ? 'Edit Cart' : 'Register New Cart'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs mb-1 block">Cart Identifier *</Label>
              <Input
                placeholder="e.g. Cart-01"
                value={cartForm.identifier}
                onChange={e => setCartForm(f => ({ ...f, identifier: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs mb-1 block">Type</Label>
                <select
                  value={cartForm.type}
                  onChange={e => setCartForm(f => ({ ...f, type: e.target.value as CartType }))}
                  className="w-full h-9 rounded-md border border-white/10 bg-background text-sm px-2"
                >
                  <option value="double">Double Seater</option>
                  <option value="single">Single Seater</option>
                </select>
              </div>
              <div>
                <Label className="text-xs mb-1 block">Status</Label>
                <select
                  value={cartForm.status}
                  onChange={e => setCartForm(f => ({ ...f, status: e.target.value as CartStatus }))}
                  className="w-full h-9 rounded-md border border-white/10 bg-background text-sm px-2"
                >
                  <option value="available">Available</option>
                  <option value="in_use">In Use</option>
                  <option value="maintenance">Maintenance</option>
                  <option value="retired">Retired</option>
                </select>
              </div>
            </div>
            <div>
              <Label className="text-xs mb-1 block">Next Service Due</Label>
              <Input
                type="date"
                value={cartForm.nextServiceDue}
                onChange={e => setCartForm(f => ({ ...f, nextServiceDue: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Notes</Label>
              <Input
                placeholder="Optional notes"
                value={cartForm.notes}
                onChange={e => setCartForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCartForm(false)}>Cancel</Button>
            <Button onClick={handleSaveCart} disabled={saving || !cartForm.identifier}>
              {saving ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : null}
              {editingCart ? 'Save Changes' : 'Register Cart'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Assign Cart Dialog ── */}
      <Dialog open={showAssignForm} onOpenChange={setShowAssignForm}>
        <DialogContent className="bg-card border-white/10 max-w-md">
          <DialogHeader>
            <DialogTitle>Assign Cart {assigningCart?.identifier}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs mb-1 block">Player / Group Name</Label>
              <Input
                placeholder="e.g. John Smith"
                value={assignForm.playerName}
                onChange={e => setAssignForm(f => ({ ...f, playerName: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Expected Return Time</Label>
              <Input
                type="datetime-local"
                value={assignForm.expectedReturnAt}
                onChange={e => setAssignForm(f => ({ ...f, expectedReturnAt: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAssignForm(false)}>Cancel</Button>
            <Button onClick={handleAssign} disabled={saving}>
              {saving ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : null}
              Assign Cart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Maintenance Dialog ── */}
      <Dialog open={showMaintenanceForm} onOpenChange={setShowMaintenanceForm}>
        <DialogContent className="bg-card border-white/10 max-w-lg">
          <DialogHeader>
            <DialogTitle>Maintenance — Cart {selectedCartForMaint?.identifier}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs mb-1 block">Service Date *</Label>
                <Input
                  type="date"
                  value={maintForm.serviceDate}
                  onChange={e => setMaintForm(f => ({ ...f, serviceDate: e.target.value }))}
                />
              </div>
              <div>
                <Label className="text-xs mb-1 block">Next Service Due</Label>
                <Input
                  type="date"
                  value={maintForm.nextServiceDue}
                  onChange={e => setMaintForm(f => ({ ...f, nextServiceDue: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label className="text-xs mb-1 block">Notes *</Label>
              <textarea
                className="w-full min-h-[80px] rounded-md border border-white/10 bg-background text-sm px-3 py-2 resize-none"
                placeholder="Describe the service performed..."
                value={maintForm.notes}
                onChange={e => setMaintForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>

            {/* Previous logs */}
            {maintLogs.length > 0 && (
              <div>
                <button
                  onClick={() => setShowLogs(v => !v)}
                  className="text-xs text-primary flex items-center gap-1 hover:underline"
                >
                  {showLogs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  {showLogs ? 'Hide' : 'Show'} service history ({maintLogs.length} entries)
                </button>
                {showLogs && (
                  <div className="mt-2 space-y-2 max-h-40 overflow-y-auto">
                    {maintLogs.map(log => (
                      <div key={log.id} className="text-xs bg-white/5 rounded-lg p-2 border border-white/10">
                        <div className="font-medium text-white">{new Date(log.serviceDate).toLocaleDateString()}</div>
                        <div className="text-muted-foreground mt-0.5">{log.notes}</div>
                        {log.nextServiceDue && (
                          <div className="text-muted-foreground">Next due: {new Date(log.nextServiceDue).toLocaleDateString()}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMaintenanceForm(false)}>Cancel</Button>
            <Button onClick={handleSaveMaintenance} disabled={saving || !maintForm.notes || !maintForm.serviceDate}>
              {saving ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : null}
              Log Service
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
