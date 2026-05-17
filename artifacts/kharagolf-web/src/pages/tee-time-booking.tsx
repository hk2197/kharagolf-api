import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import {
  Calendar, ChevronLeft, ChevronRight, Plus, Users, Clock, Settings,
  CheckCircle2, XCircle, RefreshCw, Lock, X, DollarSign, AlertTriangle, Pencil, Car,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

const GOLD = '#C9A84C';

interface Course {
  id: number;
  name: string;
}

interface TeeSlot {
  id: number;
  courseId: number;
  courseName: string | null;
  slotDate: string;
  slotTime: string;
  capacity: number;
  status: string;
  isMembersOnly: boolean;
  bookedCount: number;
  available: number;
  effectivePrice?: number | null;
  basePrice?: number | null;
  dealBadge?: string | null;
  tierName?: string | null;
  pricingBreakdown?: Array<{ source: string; label: string; before: number; after: number }>;
}

interface Booking {
  booking: {
    id: number;
    leadUserId: number;
    partySize: number;
    status: string;
    createdAt: string;
  };
  slotDate: string;
  slotTime: string;
  courseName: string | null;
}

interface PricingRules {
  memberRate: string;
  guestRate: string;
  twilightStartTime: string | null;
  twilightMemberRate: string | null;
  twilightGuestRate: string | null;
  maxGuestsPerBooking: number;
  paymentModel: string;
  cancellationCutoffHours: number;
  cancellationPolicyType: string;
  cancellationFeeFlat: string | null;
  membersOnlyStartTime: string | null;
  membersOnlyEndTime: string | null;
  slotIntervalMinutes: number;
  firstTeeTime: string;
  lastTeeTime: string;
}

const STATUS_COLOR: Record<string, string> = {
  open: 'text-emerald-400 bg-emerald-500/20',
  blocked: 'text-red-400 bg-red-500/20',
  booked: 'text-blue-400 bg-blue-500/20',
  members_only: 'text-amber-400 bg-amber-500/20',
};

export default function TeeTimeBookingPage() {
  const [, navigate] = useLocation();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const { toast } = useToast();
  const isAdmin = ['super_admin', 'org_admin', 'tournament_director'].includes(user?.role ?? '');

  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [slots, setSlots] = useState<TeeSlot[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [pricing, setPricing] = useState<PricingRules | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddSlot, setShowAddSlot] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState(false);
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'day' | 'week'>('day');
  const [weekData, setWeekData] = useState<Record<string, { total: number; available: number; booked: number }>>({});
  const [weekLoading, setWeekLoading] = useState(false);

  const [expandedBreakdownSlotId, setExpandedBreakdownSlotId] = useState<number | null>(null);

  const [newSlot, setNewSlot] = useState({ slotTime: '06:00', capacity: 4, isMembersOnly: false });
  const [pricingForm, setPricingForm] = useState<Partial<PricingRules>>({});
  const [saving, setSaving] = useState(false);

  // Bulk generate state
  const [showBulkGenerate, setShowBulkGenerate] = useState(false);
  const [bulkForm, setBulkForm] = useState({
    startTime: pricing?.firstTeeTime ?? '06:00',
    endTime: pricing?.lastTeeTime ?? '18:00',
    intervalMinutes: pricing?.slotIntervalMinutes ?? 10,
    capacity: 4,
  });

  // Booking dialog state
  const [showBookSlot, setShowBookSlot] = useState(false);
  const [bookingSlot, setBookingSlot] = useState<TeeSlot | null>(null);
  const [bookingForm, setBookingForm] = useState({ partySize: 1, cartRequested: false });
  const [memberSearch, setMemberSearch] = useState('');
  const [memberResults, setMemberResults] = useState<{ id: number; displayName: string | null; username: string; email: string | null }[]>([]);
  const [addedMembers, setAddedMembers] = useState<{ id: number; name: string }[]>([]);
  // Admin "book on behalf of" state
  const [onBehalfOf, setOnBehalfOf] = useState<{ id: number; name: string } | null>(null);
  const [onBehalfSearch, setOnBehalfSearch] = useState('');
  const [onBehalfResults, setOnBehalfResults] = useState<{ id: number; displayName: string | null; username: string; email: string | null }[]>([]);

  // Load courses once on mount
  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/organizations/${orgId}/courses`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((data: Course[]) => {
        setCourses(data);
        if (data.length > 0 && selectedCourseId === null) setSelectedCourseId(data[0].id);
      })
      .catch(() => {});
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    loadData();
  }, [orgId, selectedDate, selectedCourseId]);

  useEffect(() => {
    if (!orgId || viewMode !== 'week') return;
    loadWeekData();
  }, [orgId, selectedDate, selectedCourseId, viewMode]);

  function getWeekStart(dateStr: string) {
    const d = new Date(dateStr + 'T12:00:00');
    const diff = (d.getDay() + 6) % 7; // Monday as first day
    d.setDate(d.getDate() - diff);
    return d.toISOString().split('T')[0];
  }

  async function loadWeekData() {
    if (!orgId) return;
    setWeekLoading(true);
    const start = getWeekStart(selectedDate);
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start + 'T12:00:00');
      d.setDate(d.getDate() + i);
      return d.toISOString().split('T')[0];
    });
    try {
      const results = await Promise.all(dates.map(async d => {
        const params = new URLSearchParams({ date: d });
        if (selectedCourseId) params.set('courseId', String(selectedCourseId));
        const res = await fetch(`/api/organizations/${orgId}/tee-bookings/slots?${params}`, { credentials: 'include' });
        const daySlots: TeeSlot[] = res.ok ? await res.json() : [];
        return { date: d, total: daySlots.length, available: daySlots.reduce((s, sl) => s + sl.available, 0), booked: daySlots.reduce((s, sl) => s + sl.bookedCount, 0) };
      }));
      setWeekData(Object.fromEntries(results.map(r => [r.date, { total: r.total, available: r.available, booked: r.booked }])));
    } finally { setWeekLoading(false); }
  }

  async function loadData() {
    setLoading(true);
    try {
      const slotParams = new URLSearchParams({ date: selectedDate });
      if (selectedCourseId) slotParams.set('courseId', String(selectedCourseId));
      const [slotsRes, bookingsRes, pricingRes] = await Promise.all([
        fetch(`/api/organizations/${orgId}/tee-bookings/slots?${slotParams}`, { credentials: 'include' }),
        isAdmin ? fetch(`/api/organizations/${orgId}/tee-bookings`, { credentials: 'include' }) : Promise.resolve(null),
        fetch(`/api/organizations/${orgId}/tee-bookings/pricing`, { credentials: 'include' }),
      ]);

      if (slotsRes.status === 403) {
        const body = await slotsRes.json();
        if (body.code === 'SUBSCRIPTION_REQUIRED') { setSubscriptionError(true); return; }
      }
      if (slotsRes.ok) setSlots(await slotsRes.json());
      if (bookingsRes?.ok) setBookings(await bookingsRes.json());
      if (pricingRes.ok) {
        const p = await pricingRes.json();
        setPricing(p);
        setPricingForm(p ?? {});
      }
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  async function createSlot() {
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tee-bookings/slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ slotDate: selectedDate, ...newSlot, courseId: selectedCourseId ?? courses[0]?.id ?? 1 }),
      });
      if (!res.ok) {
        const body = await res.json();
        if (body.code === 'SUBSCRIPTION_REQUIRED') { setSubscriptionError(true); toast({ title: body.error, variant: 'destructive' }); return; }
        toast({ title: 'Failed to create slot', variant: 'destructive' }); return;
      }
      toast({ title: 'Slot created' });
      setShowAddSlot(false);
      loadData();
    } finally { setSaving(false); }
  }

  async function updateSlotStatus(slotId: number, status: string) {
    await fetch(`/api/organizations/${orgId}/tee-bookings/slots/${slotId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ status }),
    });
    loadData();
  }

  async function searchMembers(q: string) {
    if (!orgId || q.length < 2) { setMemberResults([]); return; }
    try {
      const res = await fetch(`/api/organizations/${orgId}/tee-bookings/members/search?q=${encodeURIComponent(q)}`, { credentials: 'include' });
      if (res.ok) setMemberResults(await res.json());
    } catch { /* noop */ }
  }

  async function searchOnBehalfMembers(q: string) {
    if (!orgId || q.length < 2) { setOnBehalfResults([]); return; }
    try {
      const res = await fetch(`/api/organizations/${orgId}/tee-bookings/members/search?q=${encodeURIComponent(q)}`, { credentials: 'include' });
      if (res.ok) setOnBehalfResults(await res.json());
    } catch { /* noop */ }
  }

  async function bookSlot() {
    if (!bookingSlot) return;
    setSaving(true);
    try {
      const players = addedMembers.map(m => ({ type: 'member', userId: m.id }));
      const body: Record<string, unknown> = {
        slotId: bookingSlot.id,
        partySize: bookingForm.partySize,
        cartRequested: bookingForm.cartRequested,
        players,
      };
      if (isAdmin && onBehalfOf) body.forUserId = onBehalfOf.id;
      const res = await fetch(`/api/organizations/${orgId}/tee-bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = await res.json();
        toast({ title: body.error ?? 'Failed to create booking', variant: 'destructive' });
        return;
      }
      const result = await res.json();
      const cartMsg =
        result.cartAssigned ? 'A golf cart has been assigned to your booking.' :
        result.cartUnavailable ? 'No carts were available — ops staff will be notified.' :
        `${bookingSlot.slotTime} tee time booked successfully.`;
      toast({
        title: 'Booking confirmed!',
        description: cartMsg,
      });
      setShowBookSlot(false);
      loadData();
    } finally { setSaving(false); }
  }

  async function savePricing() {
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tee-bookings/pricing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(pricingForm),
      });
      if (res.ok) { toast({ title: 'Pricing updated' }); setPricing(pricingForm as PricingRules); setShowPricing(false); }
      else toast({ title: 'Failed to save pricing', variant: 'destructive' });
    } finally { setSaving(false); }
  }

  async function bulkGenerateSlots() {
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tee-bookings/slots/bulk-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ courseId: selectedCourseId ?? courses[0]?.id ?? 1, date: selectedDate, ...bulkForm }),
      });
      if (res.ok) {
        const data = await res.json();
        toast({ title: `Generated ${data.created} slots`, description: `${data.total} total slots in range` });
        setShowBulkGenerate(false);
        loadData();
      } else {
        const body = await res.json();
        toast({ title: body.error ?? 'Failed to generate slots', variant: 'destructive' });
      }
    } finally { setSaving(false); }
  }

  function shiftDate(days: number) {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + days);
    setSelectedDate(d.toISOString().split('T')[0]);
  }

  if (subscriptionError) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center p-8">
        <Card className="bg-[#111827] border-[#1e2d3d] p-8 max-w-md text-center">
          <AlertTriangle className="w-12 h-12 mx-auto mb-4 text-amber-400" />
          <h2 className="text-xl font-bold text-white mb-2">Upgrade Required</h2>
          <p className="text-white/60 mb-6">Tee Time Booking requires a Starter or higher subscription. Please upgrade your plan to access this feature.</p>
          <Button onClick={() => navigate('/payments')} style={{ background: GOLD, color: '#000' }}>
            View Plans & Upgrade
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white p-4 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-white">Tee Sheet</h1>
              <p className="text-white/50 text-sm">Manage tee time slots and bookings</p>
            </div>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-white/20 text-white/70 hover:text-white"
                onClick={() => setShowPricing(true)}
              >
                <Settings className="w-4 h-4 mr-1" /> Pricing
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-white/20 text-white/70 hover:text-white"
                onClick={() => {
                  setBulkForm({ startTime: pricing?.firstTeeTime ?? '06:00', endTime: pricing?.lastTeeTime ?? '18:00', intervalMinutes: pricing?.slotIntervalMinutes ?? 10, capacity: 4 });
                  setShowBulkGenerate(true);
                }}
              >
                <RefreshCw className="w-4 h-4 mr-1" /> Generate
              </Button>
              <Button size="sm" style={{ background: GOLD, color: '#000' }} onClick={() => setShowAddSlot(true)}>
                <Plus className="w-4 h-4 mr-1" /> Add Slot
              </Button>
            </div>
          )}
        </div>

        {/* Course + View controls */}
        <div className="flex items-center gap-3 flex-wrap">
          {courses.length > 0 && (
            <div className="flex items-center gap-2">
              <Label htmlFor="tee-time-course-select" className="text-white/40 text-xs whitespace-nowrap">Course:</Label>
              <select
                id="tee-time-course-select"
                value={selectedCourseId ?? ''}
                onChange={e => setSelectedCourseId(parseInt(e.target.value))}
                className="bg-[#111827] border border-white/20 text-white rounded-md px-3 py-1.5 text-sm"
              >
                {courses.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5 border border-white/10">
            <button
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${viewMode === 'day' ? 'text-black' : 'text-white/50 hover:text-white'}`}
              style={viewMode === 'day' ? { background: GOLD } : {}}
              onClick={() => setViewMode('day')}
            >Day</button>
            <button
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${viewMode === 'week' ? 'text-black' : 'text-white/50 hover:text-white'}`}
              style={viewMode === 'week' ? { background: GOLD } : {}}
              onClick={() => setViewMode('week')}
            >Week</button>
          </div>
        </div>

        {/* Date Picker */}
        <Card className="bg-[#111827] border-[#1e2d3d] p-4">
          <div className="flex items-center justify-between">
            <Button variant="ghost" size="icon" onClick={() => shiftDate(viewMode === 'week' ? -7 : -1)}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <div className="text-center">
              {viewMode === 'week' ? (
                <div className="text-sm font-bold text-white">
                  Week of {new Date(getWeekStart(selectedDate) + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                </div>
              ) : (
                <div className="text-lg font-bold text-white">
                  {new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                </div>
              )}
              <Input
                type="date"
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="mt-1 h-7 text-xs border-white/20 bg-white/5 text-white/60 w-36 mx-auto"
              />
            </div>
            <Button variant="ghost" size="icon" onClick={() => shiftDate(viewMode === 'week' ? 7 : 1)}>
              <ChevronRight className="w-5 h-5" />
            </Button>
          </div>
        </Card>

        {/* ── Week view ── */}
        {viewMode === 'week' && (
          <Card className="bg-[#111827] border-[#1e2d3d] overflow-hidden">
            <div className="p-3 border-b border-white/10 flex items-center justify-between">
              <span className="text-sm font-semibold text-white">Weekly Tee Sheet</span>
              <span className="text-xs text-white/30">Click a day to view its slots</span>
            </div>
            {weekLoading ? (
              <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-white/30" /></div>
            ) : (
              <div className="grid grid-cols-7 divide-x divide-white/5">
                {Array.from({ length: 7 }, (_, i) => {
                  const d = new Date(getWeekStart(selectedDate) + 'T12:00:00');
                  d.setDate(d.getDate() + i);
                  const dateStr = d.toISOString().split('T')[0];
                  const info = weekData[dateStr];
                  const isToday = dateStr === new Date().toISOString().split('T')[0];
                  const isSelected = dateStr === selectedDate;
                  const fillPct = info ? (info.booked / Math.max(info.total * 4, 1)) * 100 : 0;
                  return (
                    <button
                      key={dateStr}
                      onClick={() => { setSelectedDate(dateStr); setViewMode('day'); }}
                      className={`flex flex-col items-center p-3 text-center hover:bg-white/5 transition-colors ${isSelected ? 'bg-white/10' : ''}`}
                    >
                      <span className="text-[10px] text-white/40 uppercase">{d.toLocaleDateString('en-IN', { weekday: 'short' })}</span>
                      <span className={`text-lg font-bold mt-0.5 ${isToday ? 'text-amber-400' : 'text-white'}`}>{d.getDate()}</span>
                      {info ? (
                        <>
                          <div className="w-full mt-2 h-1 bg-white/10 rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${Math.min(fillPct, 100)}%`, background: fillPct > 80 ? '#ef4444' : GOLD }} />
                          </div>
                          <span className="text-[10px] text-white/40 mt-1">{info.total} slots</span>
                          <span className="text-[10px] text-emerald-400">{info.available} avail</span>
                        </>
                      ) : (
                        <span className="text-[10px] text-white/20 mt-2">—</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {/* Slots Grid (day view) */}
        {viewMode === 'day' && (loading ? (
          <div className="flex justify-center py-20">
            <RefreshCw className="w-8 h-8 text-white/30 animate-spin" />
          </div>
        ) : slots.length === 0 ? (
          <Card className="bg-[#111827] border-[#1e2d3d] p-12 text-center">
            <Calendar className="w-8 h-8 mx-auto mb-3 text-white/20" />
            <p className="text-white/40">No tee times configured for this date.</p>
            {isAdmin && (
              <Button className="mt-4" style={{ background: GOLD, color: '#000' }} onClick={() => setShowAddSlot(true)}>
                Add Tee Time Slots
              </Button>
            )}
          </Card>
        ) : (
          // ── Timeline grid view: slots grouped by hour ──────────────────────
          (() => {
            const byHour: Record<string, TeeSlot[]> = {};
            for (const slot of slots) {
              const hour = slot.slotTime.split(':')[0] + ':00';
              if (!byHour[hour]) byHour[hour] = [];
              byHour[hour].push(slot);
            }
            const totalSlots = slots.length;
            const totalBooked = slots.reduce((s, sl) => s + sl.bookedCount, 0);
            const totalCapacity = slots.reduce((s, sl) => s + sl.capacity, 0);
            const totalBlocked = slots.filter(sl => sl.status === 'blocked').length;
            const fillPct = totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0;
            return (
              <Card className="bg-[#111827] border-[#1e2d3d] overflow-hidden">
                {/* Admin day-summary bar */}
                {isAdmin && (
                  <div className="flex items-center gap-6 px-4 py-2.5 border-b border-white/10 bg-white/[0.02]">
                    <span className="text-xs text-white/40">{totalSlots} slots</span>
                    <span className="text-xs text-emerald-400">{totalBooked} booked</span>
                    {totalBlocked > 0 && <span className="text-xs text-red-400">{totalBlocked} blocked</span>}
                    <div className="flex-1 flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(fillPct, 100)}%`, background: fillPct > 80 ? '#ef4444' : GOLD }} />
                      </div>
                      <span className="text-xs text-white/40 tabular-nums">{fillPct}% fill</span>
                    </div>
                  </div>
                )}
                {/* Header row */}
                <div className="grid grid-cols-[64px_1fr] border-b border-white/10 px-3 py-2 text-xs text-white/30 font-medium uppercase tracking-wider">
                  <span>Time</span>
                  <span>Slots</span>
                </div>

                {Object.entries(byHour).sort(([a], [b]) => a.localeCompare(b)).map(([hour, hourSlots]) => (
                  <div key={hour} className="grid grid-cols-[64px_1fr] border-b border-white/5 last:border-0">
                    {/* Hour label */}
                    <div className="flex items-start justify-center py-3 border-r border-white/5">
                      <span className="text-xs font-mono text-white/30">{hour}</span>
                    </div>

                    {/* Slots in this hour */}
                    <div className="flex flex-wrap gap-2 p-2">
                      {hourSlots.map(slot => {
                        const fillPct = (slot.bookedCount / slot.capacity) * 100;
                        const isFull = slot.available === 0;
                        return (
                          <div
                            key={slot.id}
                            className={`relative flex flex-col min-w-[90px] rounded-lg border p-2 transition-colors ${
                              slot.status === 'blocked'
                                ? 'bg-red-500/10 border-red-500/30'
                                : isFull
                                ? 'bg-white/5 border-white/10 opacity-60'
                                : 'bg-white/5 border-white/10 hover:border-white/20 cursor-pointer'
                            }`}
                          >
                            {/* Time + status icons */}
                            <div className="flex items-center gap-1 mb-1">
                              <span className="text-sm font-bold text-white tabular-nums">{slot.slotTime}</span>
                              {slot.isMembersOnly && <Lock className="w-2.5 h-2.5 text-amber-400 flex-shrink-0" />}
                              {slot.dealBadge && (
                                <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-emerald-500/30 text-emerald-200 border border-emerald-500/40" title={slot.tierName ?? "Deal"}>
                                  {slot.dealBadge}
                                </span>
                              )}
                            </div>
                            {slot.effectivePrice != null && (() => {
                              const hasBreakdown = !!slot.pricingBreakdown && slot.pricingBreakdown.length > 0;
                              const expanded = expandedBreakdownSlotId === slot.id;
                              return (
                                <>
                                  <div className="flex items-baseline gap-1 mb-1">
                                    <span className="text-xs font-semibold text-white tabular-nums">₹{slot.effectivePrice}</span>
                                    {slot.basePrice != null && slot.basePrice !== slot.effectivePrice && (
                                      <span className="text-[10px] text-white/40 line-through">₹{slot.basePrice}</span>
                                    )}
                                    {slot.tierName && <span className="text-[9px] text-white/40 ml-auto">{slot.tierName}</span>}
                                  </div>
                                  {hasBreakdown && (
                                    <>
                                      <button
                                        type="button"
                                        className="flex items-center gap-0.5 text-[10px] font-semibold mb-1 hover:opacity-80 transition-opacity"
                                        style={{ color: GOLD }}
                                        onClick={() => setExpandedBreakdownSlotId(expanded ? null : slot.id)}
                                        aria-expanded={expanded}
                                        aria-label={`${expanded ? 'Hide' : 'Show'} pricing breakdown`}
                                      >
                                        {expanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
                                        <span>{expanded ? 'Hide' : 'Show'} breakdown ({slot.pricingBreakdown!.length})</span>
                                      </button>
                                      {expanded && (
                                        <div className="mb-1.5 pt-1 border-t border-white/5 flex flex-col gap-1">
                                          {slot.pricingBreakdown!.map((step, idx) => {
                                            const delta = step.after - step.before;
                                            const deltaStr = delta === 0
                                              ? 'no change'
                                              : `${delta > 0 ? '+' : '−'}₹${Math.abs(delta).toFixed(0)}`;
                                            const deltaColor = delta < 0 ? 'text-emerald-300' : delta > 0 ? 'text-red-300' : 'text-white/40';
                                            return (
                                              <div key={idx} className="flex items-start justify-between gap-1.5">
                                                <span className="text-[10px] text-white/70 leading-tight flex-1 min-w-0 break-words">{step.label}</span>
                                                <div className="flex flex-col items-end flex-shrink-0">
                                                  <span className={`text-[10px] font-bold tabular-nums ${deltaColor}`}>{deltaStr}</span>
                                                  <span className="text-[9px] text-white/30 tabular-nums">₹{step.before.toFixed(0)} → ₹{step.after.toFixed(0)}</span>
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </>
                                  )}
                                </>
                              );
                            })()}

                            {/* Capacity indicator */}
                            <div className="flex items-center gap-1 mb-1.5">
                              <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: `${fillPct}%`, background: isFull ? '#ef4444' : GOLD }} />
                              </div>
                              <span className="text-[10px] text-white/40 tabular-nums">{slot.available}/{slot.capacity}</span>
                            </div>

                            {/* Action buttons */}
                            {slot.status === 'open' && !isFull && (
                              <div className="flex gap-1">
                                <button
                                  className="flex-1 text-[10px] font-medium rounded px-1.5 py-0.5 text-black transition-opacity hover:opacity-80"
                                  style={{ background: GOLD }}
                                  onClick={() => { setBookingSlot(slot); setBookingForm({ partySize: 1, cartRequested: false }); setAddedMembers([]); setMemberSearch(''); setMemberResults([]); setShowBookSlot(true); }}
                                >
                                  Book
                                </button>
                                {isAdmin && (
                                  <button
                                    className="text-[10px] px-1.5 py-0.5 rounded border border-white/20 text-white/50 hover:text-white hover:border-white/40 transition-colors"
                                    onClick={() => updateSlotStatus(slot.id, 'blocked')}
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                            )}
                            {slot.status === 'open' && isFull && (
                              <span className="text-[10px] text-white/30 text-center">Full</span>
                            )}
                            {isAdmin && slot.status === 'blocked' && (
                              <button
                                className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                                onClick={() => updateSlotStatus(slot.id, 'open')}
                              >
                                Open
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </Card>
            );
          })()
        ))}

        {/* Recent Bookings (admin only) */}
        {isAdmin && bookings.length > 0 && (
          <Card className="bg-[#111827] border-[#1e2d3d]">
            <div className="p-4 border-b border-white/10">
              <h2 className="font-semibold text-white">All Bookings</h2>
            </div>
            <div className="divide-y divide-white/5">
              {bookings.slice(0, 20).map(({ booking, slotDate, slotTime, courseName }) => (
                <div key={booking.id} className="p-4 flex items-center justify-between hover:bg-white/5 transition-colors">
                  <div>
                    <div className="font-medium text-white">{courseName ?? 'Course'} — {slotTime}</div>
                    <div className="text-xs text-white/40">
                      {new Date(slotDate + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                      {' · '}{booking.partySize} player{booking.partySize !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <Badge className={`text-xs capitalize ${
                    booking.status === 'confirmed' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                    : booking.status === 'cancelled' ? 'bg-red-500/20 text-red-300 border-red-500/30'
                    : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                  }`}>
                    {booking.status}
                  </Badge>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Add Slot Dialog */}
      <Dialog open={showAddSlot} onOpenChange={setShowAddSlot}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white">
          <DialogHeader>
            <DialogTitle>Add Tee Time Slot</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label className="text-white/60 text-sm">Time</Label>
              <Input
                type="time"
                value={newSlot.slotTime}
                onChange={e => setNewSlot(s => ({ ...s, slotTime: e.target.value }))}
                className="mt-1 bg-white/5 border-white/20 text-white"
              />
            </div>
            <div>
              <Label className="text-white/60 text-sm">Capacity (players)</Label>
              <Input
                type="number"
                min={1}
                max={8}
                value={newSlot.capacity}
                onChange={e => setNewSlot(s => ({ ...s, capacity: parseInt(e.target.value) || 4 }))}
                className="mt-1 bg-white/5 border-white/20 text-white"
              />
            </div>
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="membersOnly"
                checked={newSlot.isMembersOnly}
                onChange={e => setNewSlot(s => ({ ...s, isMembersOnly: e.target.checked }))}
                className="rounded"
              />
              <Label htmlFor="membersOnly" className="text-white/70 text-sm cursor-pointer">Members only</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddSlot(false)}>Cancel</Button>
            <Button onClick={createSlot} disabled={saving} style={{ background: GOLD, color: '#000' }}>
              {saving ? 'Creating...' : 'Create Slot'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pricing Dialog */}
      <Dialog open={showPricing} onOpenChange={setShowPricing}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white max-w-lg">
          <DialogHeader>
            <DialogTitle>Tee Time Pricing & Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-white/60 text-sm">Member Rate (₹)</Label>
                <Input
                  type="number"
                  value={pricingForm.memberRate ?? ''}
                  onChange={e => setPricingForm(p => ({ ...p, memberRate: e.target.value }))}
                  className="mt-1 bg-white/5 border-white/20 text-white"
                />
              </div>
              <div>
                <Label className="text-white/60 text-sm">Guest Rate (₹)</Label>
                <Input
                  type="number"
                  value={pricingForm.guestRate ?? ''}
                  onChange={e => setPricingForm(p => ({ ...p, guestRate: e.target.value }))}
                  className="mt-1 bg-white/5 border-white/20 text-white"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-white/60 text-sm">First Tee Time</Label>
                <Input
                  type="time"
                  value={pricingForm.firstTeeTime ?? '06:00'}
                  onChange={e => setPricingForm(p => ({ ...p, firstTeeTime: e.target.value }))}
                  className="mt-1 bg-white/5 border-white/20 text-white"
                />
              </div>
              <div>
                <Label className="text-white/60 text-sm">Last Tee Time</Label>
                <Input
                  type="time"
                  value={pricingForm.lastTeeTime ?? '18:00'}
                  onChange={e => setPricingForm(p => ({ ...p, lastTeeTime: e.target.value }))}
                  className="mt-1 bg-white/5 border-white/20 text-white"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-white/60 text-sm">Slot Interval (minutes)</Label>
                <Input
                  type="number"
                  value={pricingForm.slotIntervalMinutes ?? 10}
                  onChange={e => setPricingForm(p => ({ ...p, slotIntervalMinutes: parseInt(e.target.value) || 10 }))}
                  className="mt-1 bg-white/5 border-white/20 text-white"
                />
              </div>
              <div>
                <Label className="text-white/60 text-sm">Max Guests per Booking</Label>
                <Input
                  type="number"
                  value={pricingForm.maxGuestsPerBooking ?? 3}
                  onChange={e => setPricingForm(p => ({ ...p, maxGuestsPerBooking: parseInt(e.target.value) || 3 }))}
                  className="mt-1 bg-white/5 border-white/20 text-white"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-white/60 text-sm">Cancellation Cutoff (hours)</Label>
                <Input
                  type="number"
                  value={pricingForm.cancellationCutoffHours ?? 24}
                  onChange={e => setPricingForm(p => ({ ...p, cancellationCutoffHours: parseInt(e.target.value) || 24 }))}
                  className="mt-1 bg-white/5 border-white/20 text-white"
                />
              </div>
              <div>
                <Label htmlFor="tee-time-cancellation-policy-select" className="text-white/60 text-sm">Cancellation Policy</Label>
                <select
                  id="tee-time-cancellation-policy-select"
                  value={pricingForm.cancellationPolicyType ?? 'forfeit'}
                  onChange={e => setPricingForm(p => ({ ...p, cancellationPolicyType: e.target.value }))}
                  className="mt-1 w-full bg-white/5 border border-white/20 text-white rounded-md px-3 py-2 text-sm"
                >
                  <option value="forfeit">Forfeit (no refund)</option>
                  <option value="fee">Cancellation Fee</option>
                  <option value="free">Free (always refund)</option>
                </select>
              </div>
            </div>
            {pricingForm.cancellationPolicyType === 'fee' && (
              <div>
                <Label className="text-white/60 text-sm">Cancellation Fee (₹)</Label>
                <Input
                  type="number"
                  value={pricingForm.cancellationFeeFlat ?? ''}
                  onChange={e => setPricingForm(p => ({ ...p, cancellationFeeFlat: e.target.value }))}
                  className="mt-1 bg-white/5 border-white/20 text-white"
                />
              </div>
            )}
            <div>
              <Label className="text-white/60 text-sm mb-1 block">Members-Only Time Window</Label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-white/40 text-xs">From</Label>
                  <Input
                    type="time"
                    value={pricingForm.membersOnlyStartTime ?? ''}
                    onChange={e => setPricingForm(p => ({ ...p, membersOnlyStartTime: e.target.value || null }))}
                    className="mt-1 bg-white/5 border-white/20 text-white"
                  />
                </div>
                <div>
                  <Label className="text-white/40 text-xs">To</Label>
                  <Input
                    type="time"
                    value={pricingForm.membersOnlyEndTime ?? ''}
                    onChange={e => setPricingForm(p => ({ ...p, membersOnlyEndTime: e.target.value || null }))}
                    className="mt-1 bg-white/5 border-white/20 text-white"
                  />
                </div>
              </div>
              <p className="text-xs text-white/30 mt-1">Slots generated in this window will auto-set members-only.</p>
            </div>
            <div>
              <Label className="text-white/60 text-sm mb-1 block">Twilight Discount Window</Label>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-white/40 text-xs">Start (24h)</Label>
                  <Input
                    type="time"
                    value={pricingForm.twilightStartTime ?? ''}
                    onChange={e => setPricingForm(p => ({ ...p, twilightStartTime: e.target.value || null }))}
                    className="mt-1 bg-white/5 border-white/20 text-white"
                  />
                </div>
                <div>
                  <Label className="text-white/40 text-xs">Member Rate (₹)</Label>
                  <Input
                    type="number"
                    value={pricingForm.twilightMemberRate ?? ''}
                    onChange={e => setPricingForm(p => ({ ...p, twilightMemberRate: e.target.value }))}
                    className="mt-1 bg-white/5 border-white/20 text-white"
                  />
                </div>
                <div>
                  <Label className="text-white/40 text-xs">Guest Rate (₹)</Label>
                  <Input
                    type="number"
                    value={pricingForm.twilightGuestRate ?? ''}
                    onChange={e => setPricingForm(p => ({ ...p, twilightGuestRate: e.target.value }))}
                    className="mt-1 bg-white/5 border-white/20 text-white"
                  />
                </div>
              </div>
            </div>
            <div>
              <Label htmlFor="tee-time-payment-model-select" className="text-white/60 text-sm">Payment Model</Label>
              <select
                id="tee-time-payment-model-select"
                value={pricingForm.paymentModel ?? 'pay_at_checkin'}
                onChange={e => setPricingForm(p => ({ ...p, paymentModel: e.target.value }))}
                className="mt-1 w-full bg-white/5 border border-white/20 text-white rounded-md px-3 py-2 text-sm"
              >
                <option value="pay_at_checkin">Pay at Check-in</option>
                <option value="online">Online Payment (Razorpay)</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowPricing(false)}>Cancel</Button>
            <Button onClick={savePricing} disabled={saving} style={{ background: GOLD, color: '#000' }}>
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Generate Dialog */}
      <Dialog open={showBulkGenerate} onOpenChange={setShowBulkGenerate}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white max-w-sm">
          <DialogHeader>
            <DialogTitle>Generate Day's Tee Slots</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-white/50 text-sm">
              Automatically create slots from <strong className="text-white">start to end time</strong> at regular intervals for <strong className="text-white">{selectedDate}</strong>.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-white/60 text-sm">Start Time</Label>
                <Input type="time" value={bulkForm.startTime} onChange={e => setBulkForm(f => ({ ...f, startTime: e.target.value }))} className="mt-1 bg-white/5 border-white/20 text-white" />
              </div>
              <div>
                <Label className="text-white/60 text-sm">End Time</Label>
                <Input type="time" value={bulkForm.endTime} onChange={e => setBulkForm(f => ({ ...f, endTime: e.target.value }))} className="mt-1 bg-white/5 border-white/20 text-white" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-white/60 text-sm">Interval (min)</Label>
                <Input type="number" min={5} max={60} step={5} value={bulkForm.intervalMinutes} onChange={e => setBulkForm(f => ({ ...f, intervalMinutes: parseInt(e.target.value) || 10 }))} className="mt-1 bg-white/5 border-white/20 text-white" />
              </div>
              <div>
                <Label className="text-white/60 text-sm">Capacity / slot</Label>
                <Input type="number" min={1} max={8} value={bulkForm.capacity} onChange={e => setBulkForm(f => ({ ...f, capacity: parseInt(e.target.value) || 4 }))} className="mt-1 bg-white/5 border-white/20 text-white" />
              </div>
            </div>
            {pricing?.membersOnlyStartTime && pricing?.membersOnlyEndTime && (
              <div className="text-xs text-amber-400/80 bg-amber-500/10 rounded-lg p-2 border border-amber-500/20">
                Slots between <strong>{pricing.membersOnlyStartTime}</strong> – <strong>{pricing.membersOnlyEndTime}</strong> will automatically be marked members-only.
              </div>
            )}
            <div className="text-xs text-white/30 bg-white/5 rounded-lg p-2">
              Tip: Existing slots in range are skipped safely — no duplicates.
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowBulkGenerate(false)}>Cancel</Button>
            <Button onClick={bulkGenerateSlots} disabled={saving} style={{ background: GOLD, color: '#000' }}>
              {saving ? 'Generating...' : 'Generate Slots'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Book Slot Dialog */}
      <Dialog open={showBookSlot} onOpenChange={open => { setShowBookSlot(open); if (!open) { setAddedMembers([]); setMemberSearch(''); setMemberResults([]); setOnBehalfOf(null); setOnBehalfSearch(''); setOnBehalfResults([]); } }}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white max-w-sm">
          <DialogHeader>
            <DialogTitle>Book Tee Time</DialogTitle>
          </DialogHeader>
          {bookingSlot && (
            <div className="space-y-4 py-4">
              <div className="bg-white/5 rounded-lg p-3 border border-white/10">
                <div className="flex items-center gap-2 mb-1">
                  <Clock className="w-4 h-4" style={{ color: GOLD }} />
                  <span className="font-bold text-white text-lg">{bookingSlot.slotTime}</span>
                </div>
                <p className="text-white/50 text-xs">{bookingSlot.courseName ?? 'Course'} · {bookingSlot.available} spot{bookingSlot.available !== 1 ? 's' : ''} available</p>
              </div>
              {/* Admin: Book on behalf of member */}
              {isAdmin && (
                <div>
                  <Label className="text-white/60 text-sm mb-1 block">Book on behalf of member (admin)</Label>
                  {onBehalfOf ? (
                    <div className="flex items-center justify-between bg-white/10 rounded-lg px-3 py-2 text-sm">
                      <span className="text-white">{onBehalfOf.name}</span>
                      <button
                        type="button"
                        onClick={() => setOnBehalfOf(null)}
                        aria-label={`Remove ${onBehalfOf.name} from on-behalf-of`}
                        className="text-white/40 hover:text-white"
                      >
                        <X aria-hidden="true" className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <Input
                        placeholder="Search member to book for…"
                        aria-label="Search member to book on behalf of"
                        value={onBehalfSearch}
                        onChange={e => { setOnBehalfSearch(e.target.value); searchOnBehalfMembers(e.target.value); }}
                        className="bg-white/5 border-white/20 text-white text-sm"
                      />
                      {onBehalfResults.length > 0 && (
                        <div className="mt-1 bg-[#0d1117] border border-white/10 rounded-lg overflow-hidden max-h-28 overflow-y-auto">
                          {onBehalfResults.map(m => (
                            <button key={m.id} className="w-full text-left px-3 py-2 text-sm hover:bg-white/5 flex items-center justify-between"
                              onClick={() => { setOnBehalfOf({ id: m.id, name: m.displayName ?? m.username }); setOnBehalfSearch(''); setOnBehalfResults([]); }}>
                              <span className="text-white">{m.displayName ?? m.username}</span>
                              <span className="text-xs text-white/40">{m.email}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <p className="text-xs text-white/30 mt-1">Leave blank to book for yourself.</p>
                    </>
                  )}
                </div>
              )}

              <div>
                <Label className="text-white/60 text-sm">Party Size</Label>
                <Input
                  type="number"
                  min={1}
                  max={Math.min(bookingSlot.available, 4)}
                  value={bookingForm.partySize}
                  onChange={e => setBookingForm(f => ({ ...f, partySize: parseInt(e.target.value) || 1 }))}
                  className="mt-1 bg-white/5 border-white/20 text-white"
                />
              </div>

              {/* Member Search */}
              <div>
                <Label className="text-white/60 text-sm mb-1 block">Add Members to Group (optional)</Label>
                <Input
                  placeholder="Search member by name or email…"
                  aria-label="Add member to group — search by name or email"
                  value={memberSearch}
                  onChange={e => { setMemberSearch(e.target.value); searchMembers(e.target.value); }}
                  className="bg-white/5 border-white/20 text-white text-sm"
                />
                {memberResults.length > 0 && (
                  <div className="mt-1 bg-[#0d1117] border border-white/10 rounded-lg overflow-hidden max-h-32 overflow-y-auto">
                    {memberResults.filter(m => !addedMembers.find(a => a.id === m.id)).map(m => (
                      <button
                        key={m.id}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-white/5 flex items-center justify-between"
                        onClick={() => {
                          setAddedMembers(prev => [...prev, { id: m.id, name: m.displayName ?? m.username }]);
                          setMemberResults([]);
                          setMemberSearch('');
                        }}
                      >
                        <span className="text-white">{m.displayName ?? m.username}</span>
                        <span className="text-xs text-white/40">{m.email}</span>
                      </button>
                    ))}
                  </div>
                )}
                {addedMembers.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {addedMembers.map(m => (
                      <div key={m.id} className="flex items-center gap-1 bg-white/10 rounded-full px-2.5 py-0.5 text-xs text-white">
                        {m.name}
                        <button
                          type="button"
                          onClick={() => setAddedMembers(prev => prev.filter(a => a.id !== m.id))}
                          aria-label={`Remove ${m.name} from group`}
                        >
                          <X aria-hidden="true" className="w-3 h-3 text-white/40 hover:text-white" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3 p-3 bg-white/5 rounded-lg border border-white/10 cursor-pointer"
                onClick={() => setBookingForm(f => ({ ...f, cartRequested: !f.cartRequested }))}>
                <input
                  type="checkbox"
                  id="cartRequested"
                  checked={bookingForm.cartRequested}
                  onChange={e => setBookingForm(f => ({ ...f, cartRequested: e.target.checked }))}
                  className="rounded accent-amber-400 w-4 h-4"
                />
                <div className="flex items-center gap-2">
                  <Car className="w-4 h-4 text-amber-400" />
                  <Label htmlFor="cartRequested" className="text-white text-sm cursor-pointer">Request a golf cart</Label>
                </div>
              </div>
              {bookingForm.cartRequested && (
                <p className="text-xs text-amber-400/80">A cart will be automatically assigned from the available fleet.</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowBookSlot(false)}>Cancel</Button>
            <Button onClick={bookSlot} disabled={saving} style={{ background: GOLD, color: '#000' }}>
              {saving ? 'Booking...' : 'Confirm Booking'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
