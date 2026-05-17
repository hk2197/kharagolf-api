import { useState } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Clock, MapPin, Users, Plus, Trash2, Edit2,
  ChevronRight, RefreshCw, DollarSign, CalendarDays, BookOpen, Layers,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';

const apiUrl = (path: string) => `/api${path}`;

/* ─── Types ──────────────────────────────────────────────────────── */

interface MarketplaceSlot {
  id: number;
  courseId: number | null;
  courseName: string | null;
  slotDate: string;
  startingHole: number;
  maxPlayers: number;
  bookedPlayers: number;
  spotsLeft: number;
  pricePaise: number;
  priceDisplay: string;
  notes: string | null;
  status: string;
}

interface SlotBooking {
  id: number;
  playerName: string;
  playerEmail: string | null;
  players: number;
  amountPaise: number;
  paymentStatus: string;
  notes: string | null;
  bookedAt: string;
  cancelledAt: string | null;
  displayName: string | null;
}

interface CourseOption {
  id: number;
  name: string;
}

interface DashboardBooking {
  id: number;
  slotId: number;
  playerName: string;
  playerEmail: string | null;
  players: number;
  amountPaise: number;
  paymentStatus: string;
  slotDate: string;
  bookedAt: string;
  cancelledAt: string | null;
  courseName: string | null;
  displayName: string | null;
  notes: string | null;
  basePricePaise: number;
  listedPricePaise: number;
  markupPaise: number;
  commissionPaise: number;
}

/* ─── Helpers ────────────────────────────────────────────────────── */

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-green-500/20 text-green-400 border-green-500/30',
  full: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  closed: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  cancelled: 'bg-red-500/20 text-red-400 border-red-500/30',
};

function SlotStatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border capitalize font-medium ${STATUS_COLORS[status] ?? STATUS_COLORS.closed}`}>
      {status}
    </span>
  );
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
}

/* ─── Slot Form ──────────────────────────────────────────────────── */

function SlotForm({
  initial,
  courses,
  onSave,
  onCancel,
  loading,
}: {
  initial?: Partial<MarketplaceSlot>;
  courses: CourseOption[];
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const toLocalISO = (iso?: string) => iso ? new Date(iso).toISOString().slice(0, 16) : '';
  const [slotDate, setSlotDate] = useState(toLocalISO(initial?.slotDate));
  const [startingHole, setStartingHole] = useState(initial?.startingHole ?? 1);
  const [maxPlayers, setMaxPlayers] = useState(initial?.maxPlayers ?? 4);
  const [pricePaise, setPricePaise] = useState((initial?.pricePaise ?? 0) / 100);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [courseId, setCourseId] = useState<number | ''>(initial?.courseId ?? '');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="text-sm font-medium mb-1.5 block">Date & Time <span className="text-red-500">*</span></label>
          <Input type="datetime-local" value={slotDate} onChange={e => setSlotDate(e.target.value)} />
        </div>
        <div>
          <label className="text-sm font-medium mb-1.5 block">Starting Hole</label>
          <Input type="number" min={1} max={18} value={startingHole} onChange={e => setStartingHole(parseInt(e.target.value))} />
        </div>
        <div>
          <label className="text-sm font-medium mb-1.5 block">Max Players</label>
          <Input type="number" min={1} max={4} value={maxPlayers} onChange={e => setMaxPlayers(parseInt(e.target.value))} />
        </div>
        <div>
          <label className="text-sm font-medium mb-1.5 block">Price (₹)</label>
          <Input type="number" min={0} step={1} value={pricePaise} onChange={e => setPricePaise(parseFloat(e.target.value))} placeholder="0 = Free" />
        </div>
        <div>
          <label className="text-sm font-medium mb-1.5 block">Course</label>
          <select
            className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={courseId}
            onChange={e => setCourseId(e.target.value ? parseInt(e.target.value) : '')}
          >
            <option value="">No specific course</option>
            {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="text-sm font-medium mb-1.5 block">Notes</label>
          <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Cart included, bring your own clubs" />
        </div>
      </div>
      <div className="flex gap-3 pt-2">
        <Button
          className="flex-1"
          disabled={!slotDate || loading}
          onClick={() => onSave({ slotDate, startingHole, maxPlayers, pricePaise: Math.round(pricePaise * 100), notes: notes || undefined, courseId: courseId || undefined })}
        >
          {loading ? 'Saving…' : 'Save Slot'}
        </Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/* ─── Main Component ─────────────────────────────────────────────── */

export default function MarketplacePage() {
  const { data: me } = useGetMe();
  const orgId = me?.organizationId ?? null;
  const qc = useQueryClient();
  const { toast } = useToast();

  const [createDialog, setCreateDialog] = useState(false);
  const [editSlot, setEditSlot] = useState<MarketplaceSlot | null>(null);
  const [bookingsSlot, setBookingsSlot] = useState<MarketplaceSlot | null>(null);
  const [statusFilter, setStatusFilter] = useState<'open' | 'all' | 'full' | 'closed'>('open');
  const [cancelWindowInput, setCancelWindowInput] = useState<string>('');

  // Bulk generator state
  const [bulkDialog, setBulkDialog] = useState(false);
  const [bulkFrom, setBulkFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [bulkTo, setBulkTo] = useState(() => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  const [bulkStartTime, setBulkStartTime] = useState('06:00');
  const [bulkEndTime, setBulkEndTime] = useState('18:00');
  const [bulkInterval, setBulkInterval] = useState(10);
  const [bulkMaxPlayers, setBulkMaxPlayers] = useState(4);
  const [bulkPrice, setBulkPrice] = useState(0);
  const [bulkStartingHole, setBulkStartingHole] = useState(1);
  const [bulkCourseId, setBulkCourseId] = useState<number | ''>('');
  const [bulkNotes, setBulkNotes] = useState('');
  const [bulkDays, setBulkDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);

  /* ── Queries ─────────────────────────────────────────────────── */

  const slotsQ = useQuery<MarketplaceSlot[]>({
    queryKey: ['marketplace-slots', orgId, statusFilter],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketplace?status=${statusFilter}&from=2020-01-01`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const bookingsQ = useQuery<SlotBooking[]>({
    queryKey: ['marketplace-bookings', orgId, bookingsSlot?.id],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketplace/${bookingsSlot!.id}/bookings`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && !!bookingsSlot,
  });

  const coursesQ = useQuery<CourseOption[]>({
    queryKey: ['org-courses', orgId],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/courses`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const settingsQ = useQuery<{
    cancelWindowHours: number;
    marketplaceEnabled: boolean;
    marketplaceDefaultPublic: boolean;
    marketplaceCommissionPct: number;
    marketplaceMarkupPct: number;
    latitude: number | null;
    longitude: number | null;
  }>({
    queryKey: ['marketplace-settings', orgId],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketplace/settings`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  /* ── Mutations ───────────────────────────────────────────────── */

  const updateSettings = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/marketplace/settings`), {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Settings saved' });
      qc.invalidateQueries({ queryKey: ['marketplace-settings', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const createSlot = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/marketplace`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Slot created' });
      qc.invalidateQueries({ queryKey: ['marketplace-slots', orgId] });
      setCreateDialog(false);
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const updateSlot = useMutation({
    mutationFn: async ({ slotId, data }: { slotId: number; data: Record<string, unknown> }) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/marketplace/${slotId}`), {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Slot updated' });
      qc.invalidateQueries({ queryKey: ['marketplace-slots', orgId] });
      setEditSlot(null);
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteSlot = useMutation({
    mutationFn: async (slotId: number) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/marketplace/${slotId}`), {
        method: 'DELETE', credentials: 'include',
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Slot deleted' });
      qc.invalidateQueries({ queryKey: ['marketplace-slots', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const cancelBooking = useMutation({
    mutationFn: async ({ slotId, bookingId }: { slotId: number; bookingId: number }) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/marketplace/${slotId}/cancel/${bookingId}`), {
        method: 'POST', credentials: 'include',
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Booking cancelled' });
      qc.invalidateQueries({ queryKey: ['marketplace-bookings', orgId] });
      qc.invalidateQueries({ queryKey: ['marketplace-slots', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const bulkCreate = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/marketplace/bulk`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json() as Promise<{ created: number; skipped: number }>;
    },
    onSuccess: (data) => {
      toast({ title: `Bulk generate complete — ${data.created} slots created, ${data.skipped} skipped` });
      qc.invalidateQueries({ queryKey: ['marketplace-slots', orgId] });
      setBulkDialog(false);
    },
    onError: (e: Error) => toast({ title: 'Bulk generate failed', description: e.message, variant: 'destructive' }),
  });

  const slots = slotsQ.data ?? [];
  const courses = coursesQ.data ?? [];

  const [dashFrom, setDashFrom] = useState(() => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const [dashTo, setDashTo] = useState(() => new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10));

  const dashQ = useQuery<{ kpis: { totalBookings: number; confirmedBookings: number; cancelledBookings: number; totalRevenuePaise: number; totalPlayers: number; totalMarkupRetainedPaise: number; totalCommissionAccruedPaise: number }; commissionPct: number; bookings: DashboardBooking[] }>({
    queryKey: ['marketplace-dashboard', orgId, dashFrom, dashTo],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketplace/dashboard?from=${dashFrom}&to=${dashTo}`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <CalendarDays className="h-7 w-7 text-[#C9A84C]" />
          <div>
            <h1 className="text-2xl font-bold">Tee Time Marketplace</h1>
            <p className="text-sm text-muted-foreground">Create and manage bookable tee time slots for members</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ['marketplace-slots', orgId] })}>
            <RefreshCw className="h-4 w-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => setBulkDialog(true)}>
            <Layers className="h-4 w-4 mr-2" /> Bulk Generate
          </Button>
          <Button size="sm" onClick={() => setCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-2" /> New Slot
          </Button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Slots', value: slots.length, icon: CalendarDays, color: 'text-blue-500' },
          { label: 'Open Spots', value: slots.filter(s => s.status === 'open').reduce((t, s) => t + s.spotsLeft, 0), icon: Users, color: 'text-green-500' },
          { label: 'Total Bookings', value: slots.reduce((t, s) => t + s.bookedPlayers, 0), icon: BookOpen, color: 'text-[#C9A84C]' },
        ].map(stat => (
          <Card key={stat.label}>
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <stat.icon className={`h-8 w-8 ${stat.color}`} />
                <div>
                  <p className="text-2xl font-bold">{stat.value}</p>
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Marketplace settings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Cancellation Window (hours)</label>
              <p className="text-xs text-muted-foreground">Players cannot cancel within this many hours of the tee time. Set to 0 to disable player self-cancellation entirely.</p>
              <Input
                type="number"
                min={0}
                max={168}
                className="w-32"
                placeholder={String(settingsQ.data?.cancelWindowHours ?? 24)}
                value={cancelWindowInput}
                onChange={e => setCancelWindowInput(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={updateSettings.isPending || cancelWindowInput === ''}
              onClick={() => {
                const h = parseInt(cancelWindowInput);
                if (!isNaN(h) && h >= 0 && h <= 168) { updateSettings.mutate({ cancelWindowHours: h }); setCancelWindowInput(''); }
              }}
            >
              {updateSettings.isPending ? 'Saving…' : 'Save'}
            </Button>
            <p className="text-sm text-muted-foreground pb-1">
              Current: <strong>{settingsQ.data?.cancelWindowHours ?? 24}h</strong>
            </p>
          </div>

          {/* Cross-club marketplace exposure (Task 359) */}
          <div className="border-t pt-4 space-y-3">
            <div>
              <h4 className="text-sm font-semibold">Cross-Club Marketplace</h4>
              <p className="text-xs text-muted-foreground">
                Expose your tee times to players from other KHARAGOLF clubs. New slots
                respect the default-exposure setting; per-slot overrides remain available.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!settingsQ.data?.marketplaceEnabled}
                  onChange={(e) => updateSettings.mutate({ marketplaceEnabled: e.target.checked })}
                />
                Participate in cross-club marketplace
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!settingsQ.data?.marketplaceDefaultPublic}
                  disabled={!settingsQ.data?.marketplaceEnabled}
                  onChange={(e) => updateSettings.mutate({ marketplaceDefaultPublic: e.target.checked })}
                />
                Auto-list new slots publicly by default
              </label>

              <div className="space-y-1">
                <label className="text-sm font-medium">Markup % (added to listed price)</label>
                <Input
                  type="number" min={0} max={100} step="0.5"
                  defaultValue={settingsQ.data?.marketplaceMarkupPct ?? 0}
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v) && v !== settingsQ.data?.marketplaceMarkupPct) {
                      updateSettings.mutate({ marketplaceMarkupPct: v });
                    }
                  }}
                  className="w-32"
                />
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Platform commission %</label>
                <Input
                  type="number" min={0} max={50} step="0.5"
                  defaultValue={settingsQ.data?.marketplaceCommissionPct ?? 0}
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v) && v !== settingsQ.data?.marketplaceCommissionPct) {
                      updateSettings.mutate({ marketplaceCommissionPct: v });
                    }
                  }}
                  className="w-32"
                />
                <p className="text-[11px] text-muted-foreground">Tracked for revenue reporting; not deducted at booking time.</p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Latitude</label>
                <Input
                  type="number" step="0.0000001"
                  defaultValue={settingsQ.data?.latitude ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value === '' ? null : parseFloat(e.target.value);
                    if (v === null || !isNaN(v)) updateSettings.mutate({ latitude: v });
                  }}
                  className="w-40"
                  placeholder="e.g. 12.9716"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Longitude</label>
                <Input
                  type="number" step="0.0000001"
                  defaultValue={settingsQ.data?.longitude ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value === '' ? null : parseFloat(e.target.value);
                    if (v === null || !isNaN(v)) updateSettings.mutate({ longitude: v });
                  }}
                  className="w-40"
                  placeholder="e.g. 77.5946"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="slots">
        <TabsList>
          <TabsTrigger value="slots">Slots</TabsTrigger>
          <TabsTrigger value="bookings">Bookings Dashboard</TabsTrigger>
        </TabsList>

        {/* ── Slots Tab ─── */}
        <TabsContent value="slots" className="space-y-4 mt-4">
          {/* Filter tabs */}
          <div className="flex gap-2">
            {(['open', 'full', 'closed', 'all'] as const).map(s => (
              <Button key={s} size="sm" variant={statusFilter === s ? 'default' : 'outline'}
                onClick={() => setStatusFilter(s)}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </Button>
            ))}
          </div>

          {slotsQ.isLoading && <div className="text-center py-8 text-muted-foreground">Loading…</div>}
          {!slotsQ.isLoading && slots.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <CalendarDays className="h-10 w-10 mx-auto mb-3 opacity-30" />
                No {statusFilter !== 'all' ? statusFilter : ''} tee time slots found.
                <br /><span className="text-sm">Create your first slot using the button above.</span>
              </CardContent>
            </Card>
          )}

          <div className="space-y-3">
            {slots.map(slot => (
              <Card key={slot.id} className="hover:shadow-md transition-shadow">
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{formatDateTime(slot.slotDate)}</span>
                        <SlotStatusBadge status={slot.status} />
                        {slot.pricePaise > 0 && <Badge variant="outline" className="text-xs text-green-400">{slot.priceDisplay}</Badge>}
                        {slot.pricePaise === 0 && <Badge variant="outline" className="text-xs">Free</Badge>}
                      </div>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{slot.courseName ?? 'Any Course'} · Hole {slot.startingHole}</span>
                        <span className="flex items-center gap-1">
                          <Users className="h-3.5 w-3.5" />
                          {slot.bookedPlayers}/{slot.maxPlayers} booked
                          {slot.spotsLeft > 0 && <span className="text-green-400">({slot.spotsLeft} left)</span>}
                        </span>
                      </div>
                      {slot.notes && <p className="text-xs text-muted-foreground italic">{slot.notes}</p>}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button size="sm" variant="outline" onClick={() => setBookingsSlot(slot)}>
                        <BookOpen className="h-3.5 w-3.5 mr-1" /> Bookings ({slot.bookedPlayers})
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditSlot(slot)}>
                        <Edit2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="outline" className="text-red-500 hover:text-red-400"
                        onClick={() => { if (confirm('Delete this slot?')) deleteSlot.mutate(slot.id); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ── Bookings Dashboard Tab ─── */}
        <TabsContent value="bookings" className="space-y-4 mt-4">
          {/* Date range filter */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <label className="text-muted-foreground font-medium">From</label>
              <Input type="date" className="w-40" value={dashFrom} onChange={e => setDashFrom(e.target.value)} />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <label className="text-muted-foreground font-medium">To</label>
              <Input type="date" className="w-40" value={dashTo} onChange={e => setDashTo(e.target.value)} />
            </div>
            <Button size="sm" variant="outline" onClick={() => qc.invalidateQueries({ queryKey: ['marketplace-dashboard', orgId] })}>
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                window.location.href = apiUrl(`/organizations/${orgId}/marketplace/dashboard/export.csv?from=${dashFrom}&to=${dashTo}`);
              }}
            >
              <DollarSign className="h-4 w-4 mr-1" /> Export CSV
            </Button>
          </div>

          {/* Revenue KPIs */}
          {dashQ.data && (
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {[
                { label: 'Total Bookings', value: dashQ.data.kpis.totalBookings, color: 'text-blue-400' },
                { label: 'Confirmed', value: dashQ.data.kpis.confirmedBookings, color: 'text-green-400' },
                { label: 'Cancelled', value: dashQ.data.kpis.cancelledBookings, color: 'text-red-400' },
                { label: 'Players', value: dashQ.data.kpis.totalPlayers, color: 'text-[#C9A84C]' },
                { label: 'Gross Revenue', value: `₹${(dashQ.data.kpis.totalRevenuePaise / 100).toFixed(0)}`, color: 'text-[#C9A84C]' },
                { label: 'Markup Retained', value: `₹${(dashQ.data.kpis.totalMarkupRetainedPaise / 100).toFixed(0)}`, color: 'text-emerald-400' },
                { label: `Commission (${dashQ.data.commissionPct}%)`, value: `₹${(dashQ.data.kpis.totalCommissionAccruedPaise / 100).toFixed(0)}`, color: 'text-purple-400' },
              ].map(kpi => (
                <Card key={kpi.label}>
                  <CardContent className="pt-4 pb-3">
                    <p className={`text-xl font-bold ${kpi.color}`}>{kpi.value}</p>
                    <p className="text-xs text-muted-foreground">{kpi.label}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Bookings table */}
          {dashQ.isLoading && <div className="py-8 text-center text-muted-foreground">Loading…</div>}
          {!dashQ.isLoading && (dashQ.data?.bookings ?? []).length === 0 && (
            <Card><CardContent className="py-10 text-center text-muted-foreground">No bookings in this date range.</CardContent></Card>
          )}
          <div className="space-y-2">
            {(dashQ.data?.bookings ?? []).map(b => (
              <div key={b.id} className="flex items-center justify-between p-3 border rounded-lg gap-3">
                <div className="space-y-0.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{b.playerName}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{b.players} player{b.players > 1 ? 's' : ''}</span>
                    <Badge variant={b.paymentStatus === 'confirmed' ? 'secondary' : 'outline'} className="text-xs shrink-0">{b.paymentStatus}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {new Date(b.slotDate).toLocaleDateString('en-IN', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                    {b.courseName ? ` · ${b.courseName}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right">
                    {b.amountPaise > 0
                      ? <p className="text-sm font-semibold text-green-400">₹{(b.amountPaise / 100).toFixed(0)}</p>
                      : <p className="text-xs text-muted-foreground">Free</p>
                    }
                    {b.markupPaise > 0 && (
                      <p className="text-[11px] text-emerald-400">+₹{(b.markupPaise / 100).toFixed(0)} markup</p>
                    )}
                    {b.commissionPaise > 0 && b.paymentStatus === 'confirmed' && (
                      <p className="text-[11px] text-purple-400">−₹{(b.commissionPaise / 100).toFixed(0)} commission</p>
                    )}
                    <p className="text-[11px] text-muted-foreground">#{b.id}</p>
                  </div>
                  {!b.cancelledAt && b.paymentStatus !== 'cancelled' && (
                    <Button size="sm" variant="outline" className="text-red-500 hover:text-red-400"
                      onClick={() => {
                        if (confirm('Cancel this booking? This cannot be undone.')) {
                          fetch(apiUrl(`/organizations/${orgId}/marketplace/${b.slotId}/cancel/${b.id}`), { method: 'POST', credentials: 'include' })
                            .then(r => r.json())
                            .then(d => {
                              if (d.success) {
                                toast({ title: 'Booking cancelled' });
                                qc.invalidateQueries({ queryKey: ['marketplace-dashboard', orgId] });
                              } else {
                                toast({ title: 'Error', description: d.error ?? 'Failed', variant: 'destructive' });
                              }
                            })
                            .catch(() => toast({ title: 'Error', description: 'Network error', variant: 'destructive' }));
                        }
                      }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* Create Slot Dialog */}
      <Dialog open={createDialog} onOpenChange={setCreateDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Tee Time Slot</DialogTitle></DialogHeader>
          <SlotForm
            courses={courses}
            onSave={data => createSlot.mutate(data)}
            onCancel={() => setCreateDialog(false)}
            loading={createSlot.isPending}
          />
        </DialogContent>
      </Dialog>

      {/* Edit Slot Dialog */}
      <Dialog open={!!editSlot} onOpenChange={open => { if (!open) setEditSlot(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Tee Time Slot</DialogTitle></DialogHeader>
          {editSlot && (
            <SlotForm
              initial={editSlot}
              courses={courses}
              onSave={data => updateSlot.mutate({ slotId: editSlot.id, data })}
              onCancel={() => setEditSlot(null)}
              loading={updateSlot.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Bookings Dialog */}
      <Dialog open={!!bookingsSlot} onOpenChange={open => { if (!open) setBookingsSlot(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bookings — {bookingsSlot ? formatDateTime(bookingsSlot.slotDate) : ''}</DialogTitle>
          </DialogHeader>
          {bookingsQ.isLoading && <div className="py-6 text-center text-muted-foreground">Loading…</div>}
          {!bookingsQ.isLoading && (bookingsQ.data ?? []).length === 0 && (
            <div className="py-8 text-center text-muted-foreground">No bookings yet for this slot.</div>
          )}
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {(bookingsQ.data ?? []).map(b => (
              <div key={b.id} className="flex items-center justify-between p-3 border rounded-lg">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{b.playerName}</span>
                    <span className="text-xs text-muted-foreground">({b.players} player{b.players > 1 ? 's' : ''})</span>
                    <Badge variant={b.paymentStatus === 'confirmed' ? 'secondary' : 'outline'} className="text-xs">
                      {b.paymentStatus}
                    </Badge>
                    {b.cancelledAt && <Badge variant="destructive" className="text-xs">Cancelled</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{b.playerEmail ?? ''} · Booked {new Date(b.bookedAt).toLocaleDateString()}</p>
                  {b.amountPaise > 0 && <p className="text-xs text-green-400">₹{(b.amountPaise / 100).toFixed(0)}</p>}
                </div>
                {!b.cancelledAt && (
                  <Button size="sm" variant="outline" className="text-red-500"
                    onClick={() => { if (confirm('Cancel this booking?')) cancelBooking.mutate({ slotId: bookingsSlot!.id, bookingId: b.id }); }}>
                    Cancel
                  </Button>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Generate Dialog */}
      <Dialog open={bulkDialog} onOpenChange={setBulkDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Layers className="h-5 w-5 text-[#C9A84C]" /> Bulk Generate Tee Time Slots</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">
              Generate tee time slots for a date range at a regular interval. Duplicate slots are automatically skipped.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">From Date <span className="text-red-500">*</span></label>
                <Input type="date" value={bulkFrom} onChange={e => setBulkFrom(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">To Date <span className="text-red-500">*</span></label>
                <Input type="date" value={bulkTo} onChange={e => setBulkTo(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">First Slot Time <span className="text-red-500">*</span></label>
                <Input type="time" value={bulkStartTime} onChange={e => setBulkStartTime(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Last Slot Start Before <span className="text-red-500">*</span></label>
                <Input type="time" value={bulkEndTime} onChange={e => setBulkEndTime(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Interval (minutes)</label>
                <Input type="number" min={5} max={120} value={bulkInterval} onChange={e => setBulkInterval(parseInt(e.target.value) || 10)} placeholder="10" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Max Players / Slot</label>
                <Input type="number" min={1} max={4} value={bulkMaxPlayers} onChange={e => setBulkMaxPlayers(parseInt(e.target.value) || 4)} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Price (₹)</label>
                <Input type="number" min={0} value={bulkPrice} onChange={e => setBulkPrice(parseFloat(e.target.value) || 0)} placeholder="0 = Free" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Starting Hole</label>
                <Input type="number" min={1} max={18} value={bulkStartingHole} onChange={e => setBulkStartingHole(parseInt(e.target.value) || 1)} />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Days of Week</label>
              <div className="flex gap-1.5 flex-wrap">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setBulkDays(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${bulkDays.includes(i) ? 'bg-primary text-primary-foreground border-primary' : 'bg-transparent text-muted-foreground border-white/20 hover:border-white/40'}`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>

            {courses.length > 0 && (
              <div>
                <label className="text-sm font-medium mb-1 block">Course (optional)</label>
                <select
                  className="w-full border rounded-md px-3 py-2 bg-background text-sm"
                  value={bulkCourseId}
                  onChange={e => setBulkCourseId(e.target.value === '' ? '' : parseInt(e.target.value))}
                >
                  <option value="">No specific course</option>
                  {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}

            <div>
              <label className="text-sm font-medium mb-1 block">Notes (optional)</label>
              <Input value={bulkNotes} onChange={e => setBulkNotes(e.target.value)} placeholder="e.g. Weekend competition slots" />
            </div>

            <div className="flex gap-3 pt-2">
              <Button variant="outline" className="flex-1" onClick={() => setBulkDialog(false)}>Cancel</Button>
              <Button
                className="flex-1"
                disabled={bulkCreate.isPending || bulkDays.length === 0}
                onClick={() => {
                  bulkCreate.mutate({
                    fromDate: bulkFrom, toDate: bulkTo,
                    startTime: bulkStartTime, endTime: bulkEndTime,
                    intervalMinutes: bulkInterval,
                    maxPlayers: bulkMaxPlayers,
                    pricePaise: Math.round(bulkPrice * 100),
                    startingHole: bulkStartingHole,
                    courseId: bulkCourseId !== '' ? bulkCourseId : undefined,
                    notes: bulkNotes || undefined,
                    daysOfWeek: bulkDays,
                  });
                }}
              >
                {bulkCreate.isPending ? 'Generating…' : 'Generate Slots'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
