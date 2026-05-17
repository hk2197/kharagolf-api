import { useState, useCallback } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MapPin, Calendar, Users, Plus, Edit2, Trash2, ChevronRight, ChevronDown,
  Plane, Utensils, Clock, Home, Activity, BedDouble, Car, Flag, DollarSign,
  CheckCircle2, XCircle, AlertCircle, RefreshCw, Trophy,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgId } from '@/context/ActiveOrgContext';

const GOLD = '#C9A84C';

const API = (path: string) => `/api${path}`;

const ITEM_TYPE_ICONS: Record<string, React.ElementType> = {
  travel: Plane,
  golf_round: Flag,
  dinner: Utensils,
  accommodation: Home,
  activity: Activity,
  free_time: Clock,
};

const ITEM_TYPE_LABELS: Record<string, string> = {
  travel: 'Travel',
  golf_round: 'Golf Round',
  dinner: 'Dinner',
  accommodation: 'Accommodation',
  activity: 'Activity',
  free_time: 'Free Time',
};

const TRIP_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-white/10 text-white/60',
  open: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  confirmed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  completed: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  cancelled: 'bg-red-500/20 text-red-300 border-red-500/30',
};

interface Trip {
  id: number;
  name: string;
  destination: string;
  externalCourseName: string;
  description: string | null;
  startDate: string;
  endDate: string;
  status: string;
  maxParticipants: number | null;
  depositAmount: string | null;
  currency: string;
  estimatedTotalCost: string | null;
  notes: string | null;
}

interface Participant {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  handicapIndex: string | null;
  status: string;
  depositStatus: string;
  notes: string | null;
}

interface ItineraryItem {
  id: number;
  dayNumber: number;
  startTime: string | null;
  endTime: string | null;
  type: string;
  title: string;
  location: string | null;
  description: string | null;
  sortOrder: number;
}

interface Room {
  id: number;
  roomName: string;
  roomType: string | null;
  costPerNight: string | null;
  nights: number | null;
  notes: string | null;
  participantIds: number[];
}

interface Car {
  id: number;
  carLabel: string;
  driverParticipantId: number | null;
  totalCost: string | null;
  notes: string | null;
  participantIds: number[];
}

interface TeeSlot {
  id: number;
  roundDay: number;
  teeTime: string;
  holeStart: number;
  notes: string | null;
  participantIds: number[];
}

interface Expense {
  id: number;
  category: string;
  description: string;
  amount: string;
  paidBy: number | null;
  paidByName: string | null;
  splitBetween: number[];
  receiptUrl: string | null;
  createdAt: string;
}

interface Settlement {
  participantId: number;
  name: string;
  totalOwed: number;
  totalPaid: number;
  balance: number;
}

interface LeaderboardEntry {
  participantId: number;
  firstName: string;
  lastName: string;
  handicapIndex: string | null;
  totalStrokes: number | null;
  holesPlayed: number;
  roundsPlayed: number;
  position: number | null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function TripForm({ trip, onSave, onClose }: { trip?: Trip; onSave: () => void; onClose: () => void }) {
  const { toast } = useToast();
  const orgId = useActiveOrgId();
  const [form, setForm] = useState({
    name: trip?.name ?? '',
    destination: trip?.destination ?? '',
    externalCourseName: trip?.externalCourseName ?? '',
    description: trip?.description ?? '',
    startDate: trip?.startDate ? trip.startDate.slice(0, 10) : '',
    endDate: trip?.endDate ? trip.endDate.slice(0, 10) : '',
    status: trip?.status ?? 'draft',
    maxParticipants: trip?.maxParticipants?.toString() ?? '',
    depositAmount: trip?.depositAmount ?? '',
    currency: trip?.currency ?? 'INR',
    estimatedTotalCost: trip?.estimatedTotalCost ?? '',
    notes: trip?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!form.name || !form.destination || !form.externalCourseName || !form.startDate || !form.endDate) {
      toast({ title: 'Required fields missing', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const body = {
        ...form,
        startDate: new Date(form.startDate).toISOString(),
        endDate: new Date(form.endDate).toISOString(),
        maxParticipants: form.maxParticipants ? parseInt(form.maxParticipants) : null,
        depositAmount: form.depositAmount || null,
        estimatedTotalCost: form.estimatedTotalCost || null,
      };
      const url = trip
        ? API(`/organizations/${orgId}/trips/${trip.id}`)
        : API(`/organizations/${orgId}/trips`);
      const method = trip ? 'PATCH' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? 'Failed to save'); }
      toast({ title: trip ? 'Trip updated' : 'Trip created' });
      onSave();
    } catch (err) {
      toast({ title: String(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const field = (k: keyof typeof form) => ({
    value: form[k] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm(f => ({ ...f, [k]: e.target.value })),
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-white/60 mb-1 block">Trip Name *</label>
          <Input placeholder="e.g. Goa Away Day 2026" className="bg-white/5 border-white/10 text-white" {...field('name')} />
        </div>
        <div>
          <label className="text-xs text-white/60 mb-1 block">Destination *</label>
          <Input placeholder="e.g. Goa, India" className="bg-white/5 border-white/10 text-white" {...field('destination')} />
        </div>
        <div>
          <label className="text-xs text-white/60 mb-1 block">External Course *</label>
          <Input placeholder="e.g. Goa Golf Club" className="bg-white/5 border-white/10 text-white" {...field('externalCourseName')} />
        </div>
        <div>
          <label className="text-xs text-white/60 mb-1 block">Start Date *</label>
          <Input type="date" className="bg-white/5 border-white/10 text-white" {...field('startDate')} />
        </div>
        <div>
          <label className="text-xs text-white/60 mb-1 block">End Date *</label>
          <Input type="date" className="bg-white/5 border-white/10 text-white" {...field('endDate')} />
        </div>
        <div>
          <label className="text-xs text-white/60 mb-1 block">Status</label>
          <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
            <SelectTrigger className="bg-white/5 border-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['draft', 'open', 'confirmed', 'completed', 'cancelled'].map(s => (
                <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-white/60 mb-1 block">Max Participants</label>
          <Input type="number" placeholder="No limit" className="bg-white/5 border-white/10 text-white" {...field('maxParticipants')} />
        </div>
        <div>
          <label className="text-xs text-white/60 mb-1 block">Deposit Amount</label>
          <Input type="number" placeholder="0" className="bg-white/5 border-white/10 text-white" {...field('depositAmount')} />
        </div>
        <div>
          <label className="text-xs text-white/60 mb-1 block">Currency</label>
          <Select value={form.currency} onValueChange={v => setForm(f => ({ ...f, currency: v }))}>
            <SelectTrigger className="bg-white/5 border-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['INR', 'USD', 'GBP', 'EUR', 'AED', 'SGD', 'AUD'].map(c => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-white/60 mb-1 block">Estimated Total Cost</label>
          <Input type="number" placeholder="0" className="bg-white/5 border-white/10 text-white" {...field('estimatedTotalCost')} />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-white/60 mb-1 block">Description</label>
          <Input placeholder="Optional description" className="bg-white/5 border-white/10 text-white" {...field('description')} />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-white/60 mb-1 block">Notes</label>
          <Input placeholder="Internal notes" className="bg-white/5 border-white/10 text-white" {...field('notes')} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving} style={{ backgroundColor: GOLD, color: '#000' }}>
          {saving ? 'Saving...' : trip ? 'Update Trip' : 'Create Trip'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function ParticipantsTab({ tripId, orgId, currency }: { tripId: number; orgId: number; currency: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ firstName: '', lastName: '', email: '', phone: '', handicapIndex: '' });

  const { data: participants = [], isLoading } = useQuery<Participant[]>({
    queryKey: ['trip-participants', tripId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/participants`));
      if (!r.ok) throw new Error('Failed to load');
      return r.json();
    },
  });

  const handleAdd = async () => {
    if (!addForm.firstName || !addForm.lastName) { toast({ title: 'Name required', variant: 'destructive' }); return; }
    const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/participants`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...addForm, handicapIndex: addForm.handicapIndex || null }),
    });
    if (!r.ok) { const e = await r.json(); toast({ title: e.error, variant: 'destructive' }); return; }
    toast({ title: 'Participant added' });
    qc.invalidateQueries({ queryKey: ['trip-participants', tripId] });
    setShowAdd(false);
    setAddForm({ firstName: '', lastName: '', email: '', phone: '', handicapIndex: '' });
  };

  const handleMarkPaid = async (pid: number) => {
    const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/participants/${pid}/deposit/mark-paid`), { method: 'POST' });
    if (!r.ok) { toast({ title: 'Failed', variant: 'destructive' }); return; }
    toast({ title: 'Marked as paid' });
    qc.invalidateQueries({ queryKey: ['trip-participants', tripId] });
  };

  const handleDelete = async (pid: number) => {
    if (!confirm('Remove this participant?')) return;
    const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/participants/${pid}`), { method: 'DELETE' });
    if (!r.ok) return;
    qc.invalidateQueries({ queryKey: ['trip-participants', tripId] });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-white/60">{participants.length} participant{participants.length !== 1 ? 's' : ''}</p>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)} style={{ backgroundColor: GOLD, color: '#000' }}>
          <Plus className="w-4 h-4 mr-1" /> Add Participant
        </Button>
      </div>
      {showAdd && (
        <Card className="bg-white/5 border-white/10">
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="First name *" className="bg-white/10 border-white/10 text-white" value={addForm.firstName} onChange={e => setAddForm(f => ({ ...f, firstName: e.target.value }))} />
              <Input placeholder="Last name *" className="bg-white/10 border-white/10 text-white" value={addForm.lastName} onChange={e => setAddForm(f => ({ ...f, lastName: e.target.value }))} />
              <Input placeholder="Email" className="bg-white/10 border-white/10 text-white" value={addForm.email} onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))} />
              <Input placeholder="Phone" className="bg-white/10 border-white/10 text-white" value={addForm.phone} onChange={e => setAddForm(f => ({ ...f, phone: e.target.value }))} />
              <Input placeholder="Handicap index" className="bg-white/10 border-white/10 text-white" value={addForm.handicapIndex} onChange={e => setAddForm(f => ({ ...f, handicapIndex: e.target.value }))} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} style={{ backgroundColor: GOLD, color: '#000' }}>Add</Button>
            </div>
          </CardContent>
        </Card>
      )}
      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-white/40" /></div>
      ) : participants.length === 0 ? (
        <div className="text-center py-8 text-white/40">No participants yet</div>
      ) : (
        <div className="space-y-2">
          {participants.map(p => (
            <div key={p.id} className="flex items-center gap-3 bg-white/5 rounded-lg p-3">
              <div className="flex-1">
                <p className="text-white font-medium">{p.firstName} {p.lastName}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {p.email && <span className="text-xs text-white/40">{p.email}</span>}
                  {p.handicapIndex && <span className="text-xs text-white/40">HCP {p.handicapIndex}</span>}
                </div>
              </div>
              <Badge className={
                p.depositStatus === 'paid' ? 'bg-emerald-500/20 text-emerald-300' :
                  'bg-amber-500/20 text-amber-300'
              }>
                {p.depositStatus === 'paid' ? '✓ Paid' : 'Unpaid'}
              </Badge>
              {p.depositStatus !== 'paid' && (
                <Button size="sm" variant="ghost" className="text-xs text-emerald-400" onClick={() => handleMarkPaid(p.id)}>
                  Mark Paid
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => handleDelete(p.id)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ItineraryTab({ tripId, orgId, tripStartDate }: { tripId: number; orgId: number; tripStartDate: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ dayNumber: '1', type: 'activity', title: '', location: '', startTime: '', endTime: '', description: '' });

  const { data: items = [], isLoading } = useQuery<ItineraryItem[]>({
    queryKey: ['trip-itinerary', tripId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/itinerary`));
      if (!r.ok) throw new Error('Failed to load');
      return r.json();
    },
  });

  const handleAdd = async () => {
    if (!addForm.title) { toast({ title: 'Title required', variant: 'destructive' }); return; }
    const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/itinerary`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...addForm, dayNumber: parseInt(addForm.dayNumber) }),
    });
    if (!r.ok) { const e = await r.json(); toast({ title: e.error, variant: 'destructive' }); return; }
    toast({ title: 'Item added' });
    qc.invalidateQueries({ queryKey: ['trip-itinerary', tripId] });
    setShowAdd(false);
    setAddForm({ dayNumber: '1', type: 'activity', title: '', location: '', startTime: '', endTime: '', description: '' });
  };

  const handleDelete = async (id: number) => {
    const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/itinerary/${id}`), { method: 'DELETE' });
    if (!r.ok) return;
    qc.invalidateQueries({ queryKey: ['trip-itinerary', tripId] });
  };

  const groupedByDay: Record<number, ItineraryItem[]> = {};
  for (const item of items) {
    if (!groupedByDay[item.dayNumber]) groupedByDay[item.dayNumber] = [];
    groupedByDay[item.dayNumber].push(item);
  }

  const startDate = new Date(tripStartDate);
  const getDayDate = (day: number) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + day - 1);
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowAdd(!showAdd)} style={{ backgroundColor: GOLD, color: '#000' }}>
          <Plus className="w-4 h-4 mr-1" /> Add Item
        </Button>
      </div>
      {showAdd && (
        <Card className="bg-white/5 border-white/10">
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-white/60 mb-1 block">Day</label>
                <Input type="number" min="1" className="bg-white/10 border-white/10 text-white" value={addForm.dayNumber} onChange={e => setAddForm(f => ({ ...f, dayNumber: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-white/60 mb-1 block">Type</label>
                <Select value={addForm.type} onValueChange={v => setAddForm(f => ({ ...f, type: v }))}>
                  <SelectTrigger className="bg-white/10 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(ITEM_TYPE_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-white/60 mb-1 block">Title *</label>
                <Input placeholder="e.g. Drive to resort" className="bg-white/10 border-white/10 text-white" value={addForm.title} onChange={e => setAddForm(f => ({ ...f, title: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-white/60 mb-1 block">Start Time</label>
                <Input type="time" className="bg-white/10 border-white/10 text-white" value={addForm.startTime} onChange={e => setAddForm(f => ({ ...f, startTime: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-white/60 mb-1 block">End Time</label>
                <Input type="time" className="bg-white/10 border-white/10 text-white" value={addForm.endTime} onChange={e => setAddForm(f => ({ ...f, endTime: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-white/60 mb-1 block">Location</label>
                <Input placeholder="Optional" className="bg-white/10 border-white/10 text-white" value={addForm.location} onChange={e => setAddForm(f => ({ ...f, location: e.target.value }))} />
              </div>
            </div>
            <Input placeholder="Description (optional)" className="bg-white/10 border-white/10 text-white" value={addForm.description} onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))} />
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} style={{ backgroundColor: GOLD, color: '#000' }}>Add</Button>
            </div>
          </CardContent>
        </Card>
      )}
      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-white/40" /></div>
      ) : items.length === 0 ? (
        <div className="text-center py-8 text-white/40">No itinerary items yet</div>
      ) : (
        <div className="space-y-4">
          {Object.entries(groupedByDay).sort(([a], [b]) => Number(a) - Number(b)).map(([day, dayItems]) => (
            <div key={day}>
              <h4 className="text-sm font-semibold text-white/80 mb-2">Day {day} — {getDayDate(Number(day))}</h4>
              <div className="space-y-2">
                {dayItems.map(item => {
                  const Icon = ITEM_TYPE_ICONS[item.type] ?? Activity;
                  return (
                    <div key={item.id} className="flex items-center gap-3 bg-white/5 rounded-lg p-3">
                      <Icon className="w-5 h-5 text-white/60 shrink-0" />
                      <div className="flex-1">
                        <p className="text-white font-medium">{item.title}</p>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-white/40">
                          {item.startTime && <span>{item.startTime}{item.endTime ? ` – ${item.endTime}` : ''}</span>}
                          {item.location && <span>· {item.location}</span>}
                        </div>
                      </div>
                      <Badge className="bg-white/10 text-white/60 text-xs">{ITEM_TYPE_LABELS[item.type]}</Badge>
                      <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => handleDelete(item.id)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RoomsTab({ tripId, orgId, participants }: { tripId: number; orgId: number; participants: Participant[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ roomName: '', roomType: '', costPerNight: '', nights: '', notes: '' });
  const [assignTarget, setAssignTarget] = useState<{ roomId: number; participantId: string } | null>(null);

  const { data: rooms = [], isLoading } = useQuery<Room[]>({
    queryKey: ['trip-rooms', tripId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/rooms`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
  });

  const handleAdd = async () => {
    if (!addForm.roomName) { toast({ title: 'Room name required', variant: 'destructive' }); return; }
    const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/rooms`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...addForm, costPerNight: addForm.costPerNight || null, nights: addForm.nights ? parseInt(addForm.nights) : null }),
    });
    if (!r.ok) return;
    toast({ title: 'Room added' });
    qc.invalidateQueries({ queryKey: ['trip-rooms', tripId] });
    setShowAdd(false);
    setAddForm({ roomName: '', roomType: '', costPerNight: '', nights: '', notes: '' });
  };

  const handleAssign = async (roomId: number, participantId: number) => {
    const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/rooms/${roomId}/assign`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId }),
    });
    if (!r.ok) return;
    qc.invalidateQueries({ queryKey: ['trip-rooms', tripId] });
  };

  const handleRemoveAssignment = async (roomId: number, pid: number) => {
    await fetch(API(`/organizations/${orgId}/trips/${tripId}/rooms/${roomId}/assign/${pid}`), { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['trip-rooms', tripId] });
  };

  const getParticipantName = (id: number) => {
    const p = participants.find(x => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : `#${id}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowAdd(!showAdd)} style={{ backgroundColor: GOLD, color: '#000' }}>
          <Plus className="w-4 h-4 mr-1" /> Add Room
        </Button>
      </div>
      {showAdd && (
        <Card className="bg-white/5 border-white/10">
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="Room name *" className="bg-white/10 border-white/10 text-white" value={addForm.roomName} onChange={e => setAddForm(f => ({ ...f, roomName: e.target.value }))} />
              <Input placeholder="Room type (e.g. Double)" className="bg-white/10 border-white/10 text-white" value={addForm.roomType} onChange={e => setAddForm(f => ({ ...f, roomType: e.target.value }))} />
              <Input type="number" placeholder="Cost per night" className="bg-white/10 border-white/10 text-white" value={addForm.costPerNight} onChange={e => setAddForm(f => ({ ...f, costPerNight: e.target.value }))} />
              <Input type="number" placeholder="Nights" className="bg-white/10 border-white/10 text-white" value={addForm.nights} onChange={e => setAddForm(f => ({ ...f, nights: e.target.value }))} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} style={{ backgroundColor: GOLD, color: '#000' }}>Add</Button>
            </div>
          </CardContent>
        </Card>
      )}
      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-white/40" /></div>
      ) : rooms.length === 0 ? (
        <div className="text-center py-8 text-white/40">No rooms configured yet</div>
      ) : (
        <div className="space-y-3">
          {rooms.map(room => {
            const totalCost = room.costPerNight && room.nights
              ? parseFloat(room.costPerNight) * room.nights : null;
            const perPerson = totalCost && room.participantIds.length > 0
              ? (totalCost / room.participantIds.length).toFixed(2) : null;
            return (
              <Card key={room.id} className="bg-white/5 border-white/10">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-white font-medium">{room.roomName}</p>
                      <div className="flex gap-2 text-xs text-white/40 mt-0.5">
                        {room.roomType && <span>{room.roomType}</span>}
                        {totalCost && <span>Total: ₹{totalCost.toFixed(0)}</span>}
                        {perPerson && <span>· Per person: ₹{perPerson}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {room.participantIds.map(pid => (
                      <span key={pid} className="flex items-center gap-1 bg-white/10 rounded-full px-2 py-0.5 text-xs text-white">
                        {getParticipantName(pid)}
                        <button onClick={() => handleRemoveAssignment(room.id, pid)} className="text-white/40 hover:text-red-400">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value=""
                      onValueChange={v => { if (v) handleAssign(room.id, parseInt(v)); }}
                    >
                      <SelectTrigger className="bg-white/5 border-white/10 text-white/60 text-xs h-8 w-40">
                        <SelectValue placeholder="Add person..." />
                      </SelectTrigger>
                      <SelectContent>
                        {participants.filter(p => !room.participantIds.includes(p.id)).map(p => (
                          <SelectItem key={p.id} value={String(p.id)}>{p.firstName} {p.lastName}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CarsTab({ tripId, orgId, participants }: { tripId: number; orgId: number; participants: Participant[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ carLabel: '', totalCost: '', notes: '' });

  const { data: cars = [], isLoading } = useQuery<Car[]>({
    queryKey: ['trip-cars', tripId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/cars`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
  });

  const handleAdd = async () => {
    if (!addForm.carLabel) { toast({ title: 'Car label required', variant: 'destructive' }); return; }
    const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/cars`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...addForm, totalCost: addForm.totalCost || null }),
    });
    if (!r.ok) return;
    toast({ title: 'Car added' });
    qc.invalidateQueries({ queryKey: ['trip-cars', tripId] });
    setShowAdd(false);
    setAddForm({ carLabel: '', totalCost: '', notes: '' });
  };

  const handleAssign = async (carId: number, participantId: number) => {
    await fetch(API(`/organizations/${orgId}/trips/${tripId}/cars/${carId}/assign`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId }),
    });
    qc.invalidateQueries({ queryKey: ['trip-cars', tripId] });
  };

  const handleRemoveAssignment = async (carId: number, pid: number) => {
    await fetch(API(`/organizations/${orgId}/trips/${tripId}/cars/${carId}/assign/${pid}`), { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['trip-cars', tripId] });
  };

  const getParticipantName = (id: number) => {
    const p = participants.find(x => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : `#${id}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowAdd(!showAdd)} style={{ backgroundColor: GOLD, color: '#000' }}>
          <Plus className="w-4 h-4 mr-1" /> Add Car
        </Button>
      </div>
      {showAdd && (
        <Card className="bg-white/5 border-white/10">
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="Car label *" className="bg-white/10 border-white/10 text-white" value={addForm.carLabel} onChange={e => setAddForm(f => ({ ...f, carLabel: e.target.value }))} />
              <Input type="number" placeholder="Total cost (optional)" className="bg-white/10 border-white/10 text-white" value={addForm.totalCost} onChange={e => setAddForm(f => ({ ...f, totalCost: e.target.value }))} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} style={{ backgroundColor: GOLD, color: '#000' }}>Add</Button>
            </div>
          </CardContent>
        </Card>
      )}
      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-white/40" /></div>
      ) : cars.length === 0 ? (
        <div className="text-center py-8 text-white/40">No cars configured yet</div>
      ) : (
        <div className="space-y-3">
          {cars.map(car => {
            const perPerson = car.totalCost && car.participantIds.length > 0
              ? (parseFloat(car.totalCost) / car.participantIds.length).toFixed(2) : null;
            return (
              <Card key={car.id} className="bg-white/5 border-white/10">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-white font-medium">{car.carLabel}</p>
                      <div className="flex gap-2 text-xs text-white/40 mt-0.5">
                        {car.totalCost && <span>Total cost: ₹{parseFloat(car.totalCost).toFixed(0)}</span>}
                        {perPerson && <span>· Per person: ₹{perPerson}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {car.participantIds.map(pid => (
                      <span key={pid} className="flex items-center gap-1 bg-white/10 rounded-full px-2 py-0.5 text-xs text-white">
                        {getParticipantName(pid)}
                        <button onClick={() => handleRemoveAssignment(car.id, pid)} className="text-white/40 hover:text-red-400">×</button>
                      </span>
                    ))}
                  </div>
                  <Select value="" onValueChange={v => { if (v) handleAssign(car.id, parseInt(v)); }}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white/60 text-xs h-8 w-40">
                      <SelectValue placeholder="Add person..." />
                    </SelectTrigger>
                    <SelectContent>
                      {participants.filter(p => !car.participantIds.includes(p.id)).map(p => (
                        <SelectItem key={p.id} value={String(p.id)}>{p.firstName} {p.lastName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TeeSlotsTab({ tripId, orgId, participants }: { tripId: number; orgId: number; participants: Participant[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ roundDay: '1', teeTime: '', holeStart: '1', notes: '' });

  const { data: slots = [], isLoading } = useQuery<TeeSlot[]>({
    queryKey: ['trip-tee-slots', tripId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/tee-slots`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
  });

  const handleAdd = async () => {
    if (!addForm.teeTime) { toast({ title: 'Tee time required', variant: 'destructive' }); return; }
    const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/tee-slots`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...addForm, roundDay: parseInt(addForm.roundDay), holeStart: parseInt(addForm.holeStart) }),
    });
    if (!r.ok) return;
    toast({ title: 'Tee slot added' });
    qc.invalidateQueries({ queryKey: ['trip-tee-slots', tripId] });
    setShowAdd(false);
    setAddForm({ roundDay: '1', teeTime: '', holeStart: '1', notes: '' });
  };

  const handleAssign = async (slotId: number, participantId: number) => {
    await fetch(API(`/organizations/${orgId}/trips/${tripId}/tee-slots/${slotId}/assign`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId }),
    });
    qc.invalidateQueries({ queryKey: ['trip-tee-slots', tripId] });
  };

  const handleRemoveAssignment = async (slotId: number, pid: number) => {
    await fetch(API(`/organizations/${orgId}/trips/${tripId}/tee-slots/${slotId}/assign/${pid}`), { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['trip-tee-slots', tripId] });
  };

  const getParticipantName = (id: number) => {
    const p = participants.find(x => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : `#${id}`;
  };

  const groupedByDay: Record<number, TeeSlot[]> = {};
  for (const slot of slots) {
    if (!groupedByDay[slot.roundDay]) groupedByDay[slot.roundDay] = [];
    groupedByDay[slot.roundDay].push(slot);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowAdd(!showAdd)} style={{ backgroundColor: GOLD, color: '#000' }}>
          <Plus className="w-4 h-4 mr-1" /> Add Tee Slot
        </Button>
      </div>
      {showAdd && (
        <Card className="bg-white/5 border-white/10">
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-white/60 mb-1 block">Round Day</label>
                <Input type="number" min="1" className="bg-white/10 border-white/10 text-white" value={addForm.roundDay} onChange={e => setAddForm(f => ({ ...f, roundDay: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-white/60 mb-1 block">Tee Time *</label>
                <Input type="time" className="bg-white/10 border-white/10 text-white" value={addForm.teeTime} onChange={e => setAddForm(f => ({ ...f, teeTime: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-white/60 mb-1 block">Starting Hole</label>
                <Input type="number" min="1" max="18" className="bg-white/10 border-white/10 text-white" value={addForm.holeStart} onChange={e => setAddForm(f => ({ ...f, holeStart: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} style={{ backgroundColor: GOLD, color: '#000' }}>Add</Button>
            </div>
          </CardContent>
        </Card>
      )}
      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-white/40" /></div>
      ) : slots.length === 0 ? (
        <div className="text-center py-8 text-white/40">No tee slots recorded yet</div>
      ) : (
        <div className="space-y-4">
          {Object.entries(groupedByDay).sort(([a], [b]) => Number(a) - Number(b)).map(([day, daySlots]) => (
            <div key={day}>
              <h4 className="text-sm font-semibold text-white/80 mb-2">Round Day {day}</h4>
              <div className="space-y-2">
                {daySlots.map(slot => (
                  <Card key={slot.id} className="bg-white/5 border-white/10">
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-white font-medium">{slot.teeTime} — Hole {slot.holeStart}</p>
                        {slot.notes && <span className="text-xs text-white/40">{slot.notes}</span>}
                      </div>
                      <div className="flex flex-wrap gap-1 mb-2">
                        {slot.participantIds.map(pid => (
                          <span key={pid} className="flex items-center gap-1 bg-white/10 rounded-full px-2 py-0.5 text-xs text-white">
                            {getParticipantName(pid)}
                            <button onClick={() => handleRemoveAssignment(slot.id, pid)} className="text-white/40 hover:text-red-400">×</button>
                          </span>
                        ))}
                      </div>
                      <Select value="" onValueChange={v => { if (v) handleAssign(slot.id, parseInt(v)); }}>
                        <SelectTrigger className="bg-white/5 border-white/10 text-white/60 text-xs h-8 w-40">
                          <SelectValue placeholder="Add person..." />
                        </SelectTrigger>
                        <SelectContent>
                          {participants.filter(p => !slot.participantIds.includes(p.id)).map(p => (
                            <SelectItem key={p.id} value={String(p.id)}>{p.firstName} {p.lastName}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExpensesTab({ tripId, orgId, participants, currency }: { tripId: number; orgId: number; participants: Participant[]; currency: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ category: 'Accommodation', description: '', amount: '', paidBy: '' });

  const { data, isLoading } = useQuery<{ expenses: Expense[]; settlement: Settlement[] }>({
    queryKey: ['trip-expenses', tripId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/expenses`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
  });

  const totalExpenses = (data?.expenses ?? []).reduce((s, e) => s + parseFloat(e.amount), 0);

  const handleAdd = async () => {
    if (!addForm.description || !addForm.amount) { toast({ title: 'Required fields missing', variant: 'destructive' }); return; }
    const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/expenses`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...addForm, amount: parseFloat(addForm.amount), paidBy: addForm.paidBy ? parseInt(addForm.paidBy) : null }),
    });
    if (!r.ok) return;
    toast({ title: 'Expense added' });
    qc.invalidateQueries({ queryKey: ['trip-expenses', tripId] });
    setShowAdd(false);
    setAddForm({ category: 'Accommodation', description: '', amount: '', paidBy: '' });
  };

  const handleDelete = async (id: number) => {
    await fetch(API(`/organizations/${orgId}/trips/${tripId}/expenses/${id}`), { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['trip-expenses', tripId] });
  };

  const sym = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '₹';

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-white/60">Total: {sym}{totalExpenses.toFixed(2)}</p>
        <Button size="sm" onClick={() => setShowAdd(!showAdd)} style={{ backgroundColor: GOLD, color: '#000' }}>
          <Plus className="w-4 h-4 mr-1" /> Add Expense
        </Button>
      </div>
      {showAdd && (
        <Card className="bg-white/5 border-white/10">
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Select value={addForm.category} onValueChange={v => setAddForm(f => ({ ...f, category: v }))}>
                <SelectTrigger className="bg-white/10 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['Accommodation', 'Transport', 'Green Fees', 'Meals', 'Equipment', 'Other'].map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input placeholder="Description *" className="bg-white/10 border-white/10 text-white" value={addForm.description} onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))} />
              <Input type="number" placeholder={`Amount (${sym})*`} className="bg-white/10 border-white/10 text-white" value={addForm.amount} onChange={e => setAddForm(f => ({ ...f, amount: e.target.value }))} />
              <Select value={addForm.paidBy} onValueChange={v => setAddForm(f => ({ ...f, paidBy: v }))}>
                <SelectTrigger className="bg-white/10 border-white/10 text-white">
                  <SelectValue placeholder="Paid by..." />
                </SelectTrigger>
                <SelectContent>
                  {participants.map(p => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.firstName} {p.lastName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} style={{ backgroundColor: GOLD, color: '#000' }}>Add</Button>
            </div>
          </CardContent>
        </Card>
      )}
      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-white/40" /></div>
      ) : (
        <>
          {(data?.expenses ?? []).length > 0 && (
            <div className="space-y-2">
              {(data?.expenses ?? []).map(e => (
                <div key={e.id} className="flex items-center gap-3 bg-white/5 rounded-lg p-3">
                  <div className="flex-1">
                    <p className="text-white font-medium">{e.description}</p>
                    <div className="flex gap-2 text-xs text-white/40 mt-0.5">
                      <span>{e.category}</span>
                      {e.paidByName && <span>· Paid by {e.paidByName}</span>}
                    </div>
                  </div>
                  <p className="text-white font-semibold">{sym}{parseFloat(e.amount).toFixed(2)}</p>
                  <Button size="sm" variant="ghost" className="text-red-400" onClick={() => handleDelete(e.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {(data?.settlement ?? []).length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-white/80 mb-2">Settlement Summary</h4>
              <div className="space-y-2">
                {(data?.settlement ?? []).map(s => (
                  <div key={s.participantId} className="flex items-center gap-3 bg-white/5 rounded-lg p-3">
                    <div className="flex-1">
                      <p className="text-white font-medium">{s.name}</p>
                      <p className="text-xs text-white/40">Owes: {sym}{s.totalOwed.toFixed(2)} · Paid: {sym}{s.totalPaid.toFixed(2)}</p>
                    </div>
                    <p className={`font-semibold ${s.balance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {s.balance >= 0 ? '+' : ''}{sym}{s.balance.toFixed(2)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(data?.expenses ?? []).length === 0 && (
            <div className="text-center py-8 text-white/40">No expenses recorded yet</div>
          )}
        </>
      )}
    </div>
  );
}

function LeaderboardTab({ tripId, orgId }: { tripId: number; orgId: number }) {
  const { data, isLoading } = useQuery<{ leaderboard: LeaderboardEntry[]; tripName: string; externalCourseName: string }>({
    queryKey: ['trip-leaderboard', tripId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/trips/${tripId}/leaderboard`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
  });

  return (
    <div className="space-y-3">
      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-white/40" /></div>
      ) : (data?.leaderboard ?? []).length === 0 ? (
        <div className="text-center py-8 text-white/40">No scores recorded yet. Scores are linked from tournament rounds played by participants.</div>
      ) : (
        <div className="space-y-2">
          {(data?.leaderboard ?? []).map((entry, idx) => (
            <div key={entry.participantId} className="flex items-center gap-3 bg-white/5 rounded-lg p-3">
              <span className="text-white/60 font-bold w-6 text-center">{entry.position ?? '—'}</span>
              <div className="flex-1">
                <p className="text-white font-medium">{entry.firstName} {entry.lastName}</p>
                <p className="text-xs text-white/40">
                  {entry.roundsPlayed} round{entry.roundsPlayed !== 1 ? 's' : ''} · {entry.holesPlayed} holes
                  {entry.handicapIndex ? ` · HCP ${entry.handicapIndex}` : ''}
                </p>
              </div>
              <p className="text-white font-semibold">
                {entry.totalStrokes !== null ? `${entry.totalStrokes} strokes` : '—'}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TripDetail({ trip, orgId, onBack }: { trip: Trip; orgId: number; onBack: () => void }) {
  const qc = useQueryClient();
  const { data: participants = [] } = useQuery<Participant[]>({
    queryKey: ['trip-participants', trip.id],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/trips/${trip.id}/participants`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-white/60 hover:text-white transition-colors">
          <ChevronRight className="w-5 h-5 rotate-180" />
        </button>
        <div>
          <h2 className="text-xl font-semibold text-white">{trip.name}</h2>
          <p className="text-sm text-white/60">{trip.destination} · {trip.externalCourseName}</p>
        </div>
        <Badge className={TRIP_STATUS_COLORS[trip.status]}>{trip.status}</Badge>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Card className="bg-white/5 border-white/10">
          <CardContent className="p-4">
            <p className="text-xs text-white/60 mb-1">Dates</p>
            <p className="text-white text-sm">{formatDate(trip.startDate)} – {formatDate(trip.endDate)}</p>
          </CardContent>
        </Card>
        <Card className="bg-white/5 border-white/10">
          <CardContent className="p-4">
            <p className="text-xs text-white/60 mb-1">Participants</p>
            <p className="text-white text-sm">{participants.length}{trip.maxParticipants ? ` / ${trip.maxParticipants}` : ''}</p>
          </CardContent>
        </Card>
        <Card className="bg-white/5 border-white/10">
          <CardContent className="p-4">
            <p className="text-xs text-white/60 mb-1">Deposit</p>
            <p className="text-white text-sm">{trip.depositAmount ? `${trip.currency} ${trip.depositAmount}` : 'None'}</p>
          </CardContent>
        </Card>
      </div>
      <Tabs defaultValue="itinerary" className="w-full">
        <TabsList className="bg-white/5 w-full flex flex-wrap h-auto gap-1">
          {['itinerary', 'participants', 'rooms', 'cars', 'tee-slots', 'expenses', 'leaderboard'].map(t => (
            <TabsTrigger key={t} value={t} className="data-[state=active]:bg-white/20 capitalize text-xs">
              {t.replace('-', ' ')}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="itinerary" className="mt-4">
          <ItineraryTab tripId={trip.id} orgId={orgId} tripStartDate={trip.startDate} />
        </TabsContent>
        <TabsContent value="participants" className="mt-4">
          <ParticipantsTab tripId={trip.id} orgId={orgId} currency={trip.currency} />
        </TabsContent>
        <TabsContent value="rooms" className="mt-4">
          <RoomsTab tripId={trip.id} orgId={orgId} participants={participants} />
        </TabsContent>
        <TabsContent value="cars" className="mt-4">
          <CarsTab tripId={trip.id} orgId={orgId} participants={participants} />
        </TabsContent>
        <TabsContent value="tee-slots" className="mt-4">
          <TeeSlotsTab tripId={trip.id} orgId={orgId} participants={participants} />
        </TabsContent>
        <TabsContent value="expenses" className="mt-4">
          <ExpensesTab tripId={trip.id} orgId={orgId} participants={participants} currency={trip.currency} />
        </TabsContent>
        <TabsContent value="leaderboard" className="mt-4">
          <LeaderboardTab tripId={trip.id} orgId={orgId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function TripsPage() {
  const orgId = useActiveOrgId();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editTrip, setEditTrip] = useState<Trip | null>(null);

  const { data: trips = [], isLoading } = useQuery<Trip[]>({
    queryKey: ['trips', orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const r = await fetch(API(`/organizations/${orgId}/trips`));
      if (!r.ok) throw new Error('Failed to load trips');
      return r.json();
    },
    enabled: !!orgId,
  });

  const handleDelete = async (trip: Trip, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete trip "${trip.name}"?`)) return;
    const r = await fetch(API(`/organizations/${orgId}/trips/${trip.id}`), { method: 'DELETE' });
    if (!r.ok) { toast({ title: 'Failed to delete', variant: 'destructive' }); return; }
    toast({ title: 'Trip deleted' });
    qc.invalidateQueries({ queryKey: ['trips', orgId] });
  };

  if (!orgId) {
    return <div className="p-8 text-center text-white/40">No organisation selected</div>;
  }

  if (selectedTrip) {
    return (
      <div className="p-6">
        <TripDetail trip={selectedTrip} orgId={orgId} onBack={() => setSelectedTrip(null)} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Golf Trips</h1>
          <p className="text-white/60 text-sm mt-1">Manage away days and golf trips for your club</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} style={{ backgroundColor: GOLD, color: '#000' }}>
          <Plus className="w-4 h-4 mr-2" /> New Trip
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><RefreshCw className="w-8 h-8 animate-spin text-white/40" /></div>
      ) : trips.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <MapPin className="w-12 h-12 text-white/20 mx-auto" />
          <p className="text-white/60 text-lg">No trips planned yet</p>
          <p className="text-white/40 text-sm">Create your first away day to get started</p>
          <Button onClick={() => setShowCreateDialog(true)} style={{ backgroundColor: GOLD, color: '#000' }}>
            <Plus className="w-4 h-4 mr-2" /> Create Trip
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {trips.map(trip => (
            <Card
              key={trip.id}
              className="bg-white/5 border-white/10 hover:bg-white/8 cursor-pointer transition-colors"
              onClick={() => setSelectedTrip(trip)}
            >
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <h3 className="text-white font-semibold text-lg leading-tight">{trip.name}</h3>
                    <div className="flex items-center gap-1.5 mt-1 text-white/60 text-sm">
                      <MapPin className="w-3.5 h-3.5" />
                      <span>{trip.destination}</span>
                    </div>
                  </div>
                  <Badge className={TRIP_STATUS_COLORS[trip.status]}>{trip.status}</Badge>
                </div>
                <div className="space-y-1.5 text-xs text-white/50">
                  <div className="flex items-center gap-1.5">
                    <Flag className="w-3.5 h-3.5" />
                    <span>{trip.externalCourseName}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>{formatDate(trip.startDate)} – {formatDate(trip.endDate)}</span>
                  </div>
                  {trip.depositAmount && (
                    <div className="flex items-center gap-1.5">
                      <DollarSign className="w-3.5 h-3.5" />
                      <span>Deposit: {trip.currency} {trip.depositAmount}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2 mt-4">
                  <Button size="sm" variant="ghost" className="text-white/40 hover:text-white" onClick={e => { e.stopPropagation(); setEditTrip(trip); }}>
                    <Edit2 className="w-4 h-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-red-400/60 hover:text-red-400" onClick={e => handleDelete(trip, e)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                  <ChevronRight className="w-4 h-4 text-white/30" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="bg-gray-900 border-white/10 text-white max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Golf Trip</DialogTitle>
          </DialogHeader>
          <TripForm
            onSave={() => { setShowCreateDialog(false); qc.invalidateQueries({ queryKey: ['trips', orgId] }); }}
            onClose={() => setShowCreateDialog(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={!!editTrip} onOpenChange={() => setEditTrip(null)}>
        <DialogContent className="bg-gray-900 border-white/10 text-white max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Trip</DialogTitle>
          </DialogHeader>
          {editTrip && (
            <TripForm
              trip={editTrip}
              onSave={() => { setEditTrip(null); qc.invalidateQueries({ queryKey: ['trips', orgId] }); }}
              onClose={() => setEditTrip(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
