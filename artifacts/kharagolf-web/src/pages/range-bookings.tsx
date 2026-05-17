import { useState, useEffect, useCallback } from 'react';
import {
  Target, Plus, Settings, CheckCircle2, XCircle, RefreshCw, QrCode,
  Clock, Calendar, ChevronLeft, ChevronRight, Users, Zap, X, Trash2,
  AlertTriangle, DollarSign, Wifi,
} from 'lucide-react';
import { useHighlightFromQuery, useHighlightTarget } from '@/hooks/use-highlight-row';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

const GOLD = '#C9A84C';

interface Bay {
  id: number;
  bayNumber: number;
  label: string | null;
  isActive: boolean;
}

interface RangeConfig {
  slotDurationMinutes: number;
  firstSlotTime: string;
  lastSlotTime: string;
  memberRate: string;
  visitorRate: string;
  peakMemberRate: string | null;
  peakVisitorRate: string | null;
  peakStartTime: string | null;
  peakEndTime: string | null;
  ballsPerBucket: number;
  bucketsIncluded: number;
  cancellationCutoffHours: number;
  paymentModel: string;
}

interface SlotBayStatus {
  bayId: number;
  bayNumber: number;
  label: string | null;
  isBooked: boolean;
}

interface TimeSlot {
  time: string;
  isBlocked: boolean;
  isPeak: boolean;
  memberRate: number;
  visitorRate: number;
  bays: SlotBayStatus[];
}

interface Booking {
  booking: {
    id: number;
    bayId: number;
    userId: number | null;
    playerType: string;
    guestName: string | null;
    slotDate: string;
    slotTime: string;
    durationMinutes: number;
    status: string;
    totalAmount: string | null;
    checkedInAt: string | null;
    qrToken: string | null;
    createdAt: string;
  };
  bay: Bay | null;
  user: { id: number; displayName: string | null; username: string; email: string | null } | null;
}

interface Blackout {
  id: number;
  startAt: string;
  endAt: string;
  reason: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  confirmed: 'text-emerald-400 bg-emerald-500/20 border-emerald-500/30',
  completed: 'text-blue-400 bg-blue-500/20 border-blue-500/30',
  cancelled: 'text-red-400 bg-red-500/20 border-red-500/30',
  pending: 'text-amber-400 bg-amber-500/20 border-amber-500/30',
  no_show: 'text-gray-400 bg-gray-500/20 border-gray-500/30',
};

function fmtDate(d: Date) {
  return d.toISOString().split('T')[0];
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export default function RangeBookingsPage() {
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const { toast } = useToast();
  const isAdmin = ['super_admin', 'org_admin', 'tournament_director'].includes(user?.role ?? '');
  const isStaff = isAdmin || ['pro_shop', 'volunteer'].includes(user?.role ?? '');

  const [activeTab, setActiveTab] = useState<'book' | 'dashboard' | 'admin'>(isStaff ? 'dashboard' : 'book');
  const [selectedDate, setSelectedDate] = useState(fmtDate(new Date()));
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [bays, setBays] = useState<Bay[]>([]);
  const [config, setConfig] = useState<RangeConfig | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [myBookings, setMyBookings] = useState<Booking[]>([]);
  const [blackouts, setBlackouts] = useState<Blackout[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBookingDialog, setShowBookingDialog] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<{ time: string; bayId: number; bayNumber: number; rate: number } | null>(null);
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [showAddBayDialog, setShowAddBayDialog] = useState(false);
  const [showBlackoutDialog, setShowBlackoutDialog] = useState(false);
  const [showQrDialog, setShowQrDialog] = useState<{ token: string; bayNumber: number; slotTime: string } | null>(null);
  const [rescheduleBooking, setRescheduleBooking] = useState<Booking | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('');
  const [rescheduling, setRescheduling] = useState(false);

  // Visitor walk-in booking (staff only)
  const [showVisitorDialog, setShowVisitorDialog] = useState(false);
  const [visitorBayId, setVisitorBayId] = useState('');
  const [visitorDate, setVisitorDate] = useState(fmtDate(new Date()));
  const [visitorTime, setVisitorTime] = useState('');
  const [visitorName, setVisitorName] = useState('');
  const [visitorEmail, setVisitorEmail] = useState('');
  const [bookingVisitor, setBookingVisitor] = useState(false);

  // Booking form
  const [bookingPlayerType, setBookingPlayerType] = useState<'member' | 'visitor'>('member');
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [booking, setBooking] = useState(false);

  // Deep-link from the "My Upcoming" widget: /range-bookings?bookingId=N
  // forces the member-facing booking view and visually highlights the row.
  const { highlightId, consume: consumeHighlight } = useHighlightFromQuery('bookingId');
  useEffect(() => {
    if (highlightId !== null) setActiveTab('book');
  }, [highlightId]);

  // Config form
  const [configForm, setConfigForm] = useState<RangeConfig>({
    slotDurationMinutes: 30,
    firstSlotTime: '06:00',
    lastSlotTime: '21:00',
    memberRate: '0',
    visitorRate: '0',
    peakMemberRate: null,
    peakVisitorRate: null,
    peakStartTime: null,
    peakEndTime: null,
    ballsPerBucket: 50,
    bucketsIncluded: 1,
    cancellationCutoffHours: 2,
    paymentModel: 'pay_at_checkin',
  });

  // Bay form
  const [newBayNumber, setNewBayNumber] = useState('');
  const [newBayLabel, setNewBayLabel] = useState('');

  // Blackout form
  const [blackoutStart, setBlackoutStart] = useState('');
  const [blackoutEnd, setBlackoutEnd] = useState('');
  const [blackoutReason, setBlackoutReason] = useState('');

  const loadAvailability = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/organizations/${orgId}/range-bookings/availability?date=${selectedDate}`);
    if (res.ok) {
      const data = await res.json();
      setSlots(data.slots ?? []);
      setBays(data.bays ?? []);
      if (data.config) setConfig(data.config);
    }
  }, [orgId, selectedDate]);

  const loadBookings = useCallback(async () => {
    if (!orgId) return;
    const [adminRes, myRes, blackoutRes] = await Promise.all([
      isStaff ? fetch(`/api/organizations/${orgId}/range-bookings?date=${selectedDate}`) : Promise.resolve(null),
      fetch(`/api/organizations/${orgId}/range-bookings/my`),
      isAdmin ? fetch(`/api/organizations/${orgId}/range-bookings/blackouts`) : Promise.resolve(null),
    ]);
    if (adminRes?.ok) setBookings(await adminRes.json());
    if (myRes.ok) setMyBookings(await myRes.json());
    if (blackoutRes?.ok) setBlackouts(await blackoutRes.json());
  }, [orgId, selectedDate, isStaff, isAdmin]);

  const loadConfig = useCallback(async () => {
    if (!orgId || !isAdmin) return;
    const res = await fetch(`/api/organizations/${orgId}/range-bookings/config`);
    if (res.ok) {
      const c = await res.json();
      if (c) setConfigForm(c);
    }
  }, [orgId, isAdmin]);

  async function load() {
    setLoading(true);
    await Promise.all([loadAvailability(), loadBookings(), loadConfig()]);
    setLoading(false);
  }

  useEffect(() => {
    if (orgId) load();
  }, [orgId, selectedDate]);

  async function handleBook() {
    if (!selectedSlot) return;
    setBooking(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/range-bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bayId: selectedSlot.bayId,
          slotDate: selectedDate,
          slotTime: selectedSlot.time,
          playerType: bookingPlayerType,
          guestName: bookingPlayerType === 'visitor' ? guestName : undefined,
          guestEmail: bookingPlayerType === 'visitor' ? guestEmail : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast({ title: 'Booking failed', description: err.error, variant: 'destructive' });
        return;
      }
      toast({ title: 'Bay booked!', description: `Bay ${selectedSlot.bayNumber} at ${selectedSlot.time}` });
      setShowBookingDialog(false);
      load();
    } finally {
      setBooking(false);
    }
  }

  async function handleCancel(bookingId: number) {
    const res = await fetch(`/api/organizations/${orgId}/range-bookings/${bookingId}/cancel`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'User cancelled' }),
    });
    if (res.ok) {
      toast({ title: 'Booking cancelled' });
      load();
    } else {
      const err = await res.json();
      toast({ title: 'Cancellation failed', description: err.error, variant: 'destructive' });
    }
  }

  async function handleVisitorBooking() {
    if (!visitorBayId || !visitorDate || !visitorTime || !visitorName || !visitorEmail) return;
    setBookingVisitor(true);
    try {
      const res = await fetch(`/api/public/organizations/${orgId}/range-bookings/visitor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bayId: parseInt(visitorBayId),
          slotDate: visitorDate,
          slotTime: visitorTime,
          guestName: visitorName,
          guestEmail: visitorEmail,
        }),
      });
      if (res.ok) {
        toast({ title: 'Visitor bay booked!', description: `Confirmation sent to ${visitorEmail}` });
        setShowVisitorDialog(false);
        setVisitorBayId(''); setVisitorTime(''); setVisitorName(''); setVisitorEmail('');
        load();
      } else {
        const err = await res.json();
        toast({ title: 'Visitor booking failed', description: err.error, variant: 'destructive' });
      }
    } finally {
      setBookingVisitor(false);
    }
  }

  async function handleReschedule() {
    if (!rescheduleBooking || !rescheduleDate || !rescheduleTime) return;
    setRescheduling(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/range-bookings/${rescheduleBooking.booking.id}/reschedule`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newSlotDate: rescheduleDate, newSlotTime: rescheduleTime }),
        },
      );
      if (res.ok) {
        toast({ title: 'Booking rescheduled', description: `New slot: ${rescheduleTime} on ${rescheduleDate}` });
        setRescheduleBooking(null);
        load();
      } else {
        const err = await res.json();
        toast({ title: 'Reschedule failed', description: err.error, variant: 'destructive' });
      }
    } finally {
      setRescheduling(false);
    }
  }

  async function handleCheckin(bookingId: number) {
    const res = await fetch(`/api/organizations/${orgId}/range-bookings/${bookingId}/checkin`, {
      method: 'POST',
    });
    if (res.ok) {
      toast({ title: 'Checked in!' });
      load();
    } else {
      const err = await res.json();
      toast({ title: 'Check-in failed', description: err.error, variant: 'destructive' });
    }
  }

  async function handleSaveConfig() {
    const res = await fetch(`/api/organizations/${orgId}/range-bookings/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configForm),
    });
    if (res.ok) {
      toast({ title: 'Configuration saved' });
      setShowConfigDialog(false);
      load();
    } else {
      toast({ title: 'Failed to save config', variant: 'destructive' });
    }
  }

  async function handleAddBay() {
    if (!newBayNumber) return;
    const res = await fetch(`/api/organizations/${orgId}/range-bookings/bays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bayNumber: parseInt(newBayNumber), label: newBayLabel || undefined }),
    });
    if (res.ok) {
      toast({ title: 'Bay added' });
      setShowAddBayDialog(false);
      setNewBayNumber('');
      setNewBayLabel('');
      load();
    } else {
      const err = await res.json();
      toast({ title: 'Failed to add bay', description: err.error, variant: 'destructive' });
    }
  }

  async function handleDeactivateBay(bayId: number) {
    const res = await fetch(`/api/organizations/${orgId}/range-bookings/bays/${bayId}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      toast({ title: 'Bay deactivated' });
      load();
    }
  }

  async function handleAddBlackout() {
    if (!blackoutStart || !blackoutEnd) return;
    const res = await fetch(`/api/organizations/${orgId}/range-bookings/blackouts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startAt: blackoutStart, endAt: blackoutEnd, reason: blackoutReason || undefined }),
    });
    if (res.ok) {
      toast({ title: 'Blackout period added' });
      setShowBlackoutDialog(false);
      setBlackoutStart('');
      setBlackoutEnd('');
      setBlackoutReason('');
      load();
    }
  }

  async function handleDeleteBlackout(id: number) {
    await fetch(`/api/organizations/${orgId}/range-bookings/blackouts/${id}`, { method: 'DELETE' });
    load();
  }

  async function handleShowQr(bookingId: number) {
    const res = await fetch(`/api/organizations/${orgId}/range-bookings/${bookingId}/qr`);
    if (res.ok) {
      const data = await res.json();
      setShowQrDialog({ token: data.qrToken, bayNumber: data.bayNumber, slotTime: data.slotTime });
    }
  }

  const tabs = [
    { id: 'book', label: 'Book a Bay' },
    ...(isStaff ? [{ id: 'dashboard', label: 'Staff Dashboard' }] : []),
    ...(isAdmin ? [{ id: 'admin', label: 'Admin Config' }] : []),
  ] as { id: 'book' | 'dashboard' | 'admin'; label: string }[];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${GOLD}20`, border: `1px solid ${GOLD}40` }}>
            <Target className="w-5 h-5" style={{ color: GOLD }} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Driving Range</h1>
            <p className="text-sm text-muted-foreground">Bay bookings &amp; availability</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="gap-2">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-white/10 pb-0">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Date Picker (shared) */}
      {(activeTab === 'book' || activeTab === 'dashboard') && (
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSelectedDate(fmtDate(addDays(new Date(selectedDate), -1)))}
            className="p-2 rounded-lg border border-white/10 hover:bg-white/5 text-muted-foreground hover:text-white"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="bg-card border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
          />
          <button
            onClick={() => setSelectedDate(fmtDate(addDays(new Date(selectedDate), 1)))}
            className="p-2 rounded-lg border border-white/10 hover:bg-white/5 text-muted-foreground hover:text-white"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="text-sm text-muted-foreground">
            {new Date(selectedDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
          </span>
        </div>
      )}

      {/* BOOK TAB */}
      {activeTab === 'book' && (
        <div className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center h-40 text-muted-foreground">Loading...</div>
          ) : slots.length === 0 ? (
            <Card className="p-8 text-center border-white/10 bg-card/50">
              <Target className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">No time slots configured yet.</p>
              {isAdmin && (
                <Button variant="outline" className="mt-4" onClick={() => setActiveTab('admin')}>
                  Configure Range
                </Button>
              )}
            </Card>
          ) : (
            <div className="space-y-2">
              {/* Bay header */}
              {bays.length > 0 && (
                <div className="grid gap-2 text-xs text-muted-foreground font-medium uppercase tracking-wider pb-1" style={{ gridTemplateColumns: `120px repeat(${bays.length}, 1fr)` }}>
                  <span>Time</span>
                  {bays.map(b => <span key={b.id} className="text-center">Bay {b.bayNumber}{b.label ? ` · ${b.label}` : ''}</span>)}
                </div>
              )}

              {slots.map(slot => (
                <div
                  key={slot.time}
                  className="grid gap-2 items-center"
                  style={{ gridTemplateColumns: `120px repeat(${bays.length || 1}, 1fr)` }}
                >
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm text-white font-medium">{slot.time}</span>
                    {slot.isPeak && (
                      <Badge className="text-[10px] px-1 py-0" style={{ background: `${GOLD}20`, color: GOLD, border: `1px solid ${GOLD}40` }}>
                        Peak
                      </Badge>
                    )}
                    {slot.isBlocked && (
                      <Badge variant="destructive" className="text-[10px] px-1 py-0">Blocked</Badge>
                    )}
                  </div>
                  {slot.bays.map(bayStatus => (
                    <button
                      key={bayStatus.bayId}
                      disabled={bayStatus.isBooked || slot.isBlocked}
                      onClick={() => {
                        setSelectedSlot({
                          time: slot.time,
                          bayId: bayStatus.bayId,
                          bayNumber: bayStatus.bayNumber,
                          rate: slot.memberRate,
                        });
                        setShowBookingDialog(true);
                      }}
                      className={`h-10 rounded-lg text-sm font-medium transition-all border ${
                        slot.isBlocked
                          ? 'bg-red-500/10 border-red-500/20 text-red-400/50 cursor-not-allowed'
                          : bayStatus.isBooked
                            ? 'bg-blue-500/10 border-blue-500/20 text-blue-400 cursor-not-allowed'
                            : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 cursor-pointer'
                      }`}
                    >
                      {slot.isBlocked ? 'Blocked' : bayStatus.isBooked ? 'Booked' : 'Available'}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* My Bookings */}
          {myBookings.length > 0 && (
            <div className="mt-6 space-y-2">
              <h3 className="text-sm font-semibold text-white uppercase tracking-wider">My Bookings</h3>
              {/*
                Deep-linked bookings (e.g. /range-bookings?bookingId=N from the
                "My Upcoming" widget) might fall outside the first five rows of
                the most recent ten, so the visible list is widened just enough
                to surface the targeted record while still capping at 10 to
                avoid an unbounded list.
              */}
              {(highlightId !== null
                ? Array.from(new Set([
                    ...myBookings.slice(0, 5).map(b => b.booking.id),
                    highlightId,
                  ])).map(id => myBookings.find(b => b.booking.id === id)).filter((b): b is Booking => Boolean(b))
                : myBookings.slice(0, 5)
              ).slice(0, 10).map(b => (
                <RangeMyBookingCard
                  key={b.booking.id}
                  b={b}
                  isHighlight={highlightId === b.booking.id}
                  onConsumeHighlight={consumeHighlight}
                  onShowQr={handleShowQr}
                  onReschedule={() => { setRescheduleBooking(b); setRescheduleDate(''); setRescheduleTime(''); }}
                  onCancel={handleCancel}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* DASHBOARD TAB */}
      {activeTab === 'dashboard' && isStaff && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Today&apos;s Bookings</h2>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setShowVisitorDialog(true)} className="gap-1.5 text-xs" style={{ background: GOLD, color: '#000' }}>
                <Users className="w-3.5 h-3.5" /> Walk-in Visitor
              </Button>
              <Badge variant="outline" className="text-muted-foreground border-white/10">
                {bookings.filter(b => b.booking.status === 'confirmed').length} confirmed
              </Badge>
            </div>
          </div>

          {bookings.length === 0 ? (
            <Card className="p-8 text-center border-white/10 bg-card/50">
              <Wifi className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground">No bookings for this date.</p>
            </Card>
          ) : (
            <div className="space-y-2">
              {bookings.map(b => (
                <Card key={b.booking.id} className="p-4 border-white/10 bg-card/50">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center text-lg font-bold" style={{ background: `${GOLD}15`, border: `1px solid ${GOLD}30`, color: GOLD }}>
                        {b.bay?.bayNumber ?? '?'}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white flex items-center gap-2">
                          Bay {b.bay?.bayNumber ?? '?'} — {b.booking.slotTime}
                          <Badge className={`text-xs border ${STATUS_STYLES[b.booking.status] ?? ''}`}>
                            {b.booking.status}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {b.user ? (b.user.displayName || b.user.username) : (b.booking.guestName || 'Unknown')}
                          {b.booking.totalAmount && parseFloat(b.booking.totalAmount) > 0 && ` · ₹${parseFloat(b.booking.totalAmount).toLocaleString()}`}
                          {' · '}{b.booking.durationMinutes}min
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {b.booking.status === 'confirmed' && (
                        <>
                          <Button
                            size="sm"
                            onClick={() => handleCheckin(b.booking.id)}
                            className="gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> Check In
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCancel(b.booking.id)}
                            className="gap-1 text-xs text-red-400 hover:text-red-300"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                          </Button>
                        </>
                      )}
                      {b.booking.status === 'completed' && b.booking.checkedInAt && (
                        <span className="text-xs text-emerald-400">
                          ✓ {new Date(b.booking.checkedInAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ADMIN TAB */}
      {activeTab === 'admin' && isAdmin && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Range Config */}
          <Card className="p-5 border-white/10 bg-card/50 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-white flex items-center gap-2">
                <Settings className="w-4 h-4" style={{ color: GOLD }} /> Range Configuration
              </h3>
              <Button size="sm" variant="outline" onClick={() => setShowConfigDialog(true)}>Edit</Button>
            </div>
            {config ? (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between text-muted-foreground"><span>Hours:</span><span className="text-white">{config.firstSlotTime} – {config.lastSlotTime}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Slot duration:</span><span className="text-white">{config.slotDurationMinutes}min</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Member rate:</span><span className="text-white">₹{parseFloat(config.memberRate).toLocaleString()}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Visitor rate:</span><span className="text-white">₹{parseFloat(config.visitorRate).toLocaleString()}</span></div>
                {config.peakStartTime && <div className="flex justify-between text-muted-foreground"><span>Peak hours:</span><span className="text-white">{config.peakStartTime} – {config.peakEndTime}</span></div>}
                <div className="flex justify-between text-muted-foreground"><span>Balls/bucket:</span><span className="text-white">{config.ballsPerBucket} × {config.bucketsIncluded} included</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Cancel window:</span><span className="text-white">{config.cancellationCutoffHours}h</span></div>
              </div>
            ) : <p className="text-sm text-muted-foreground">Not configured yet.</p>}
          </Card>

          {/* Bays */}
          <Card className="p-5 border-white/10 bg-card/50 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-white flex items-center gap-2">
                <Target className="w-4 h-4" style={{ color: GOLD }} /> Bays ({bays.length})
              </h3>
              <Button size="sm" variant="outline" onClick={() => setShowAddBayDialog(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Bay
              </Button>
            </div>
            <div className="space-y-2">
              {bays.length === 0 && <p className="text-sm text-muted-foreground">No bays configured.</p>}
              {bays.map(bay => (
                <div key={bay.id} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
                  <span className="text-sm text-white">Bay {bay.bayNumber}{bay.label ? ` · ${bay.label}` : ''}</span>
                  <Button variant="ghost" size="sm" onClick={() => handleDeactivateBay(bay.id)} className="text-red-400 hover:text-red-300 h-7 px-2">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </Card>

          {/* Blackout Periods */}
          <Card className="p-5 border-white/10 bg-card/50 space-y-4 md:col-span-2">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-white flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" /> Blackout Periods
              </h3>
              <Button size="sm" variant="outline" onClick={() => setShowBlackoutDialog(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Blackout
              </Button>
            </div>
            {blackouts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No blackout periods.</p>
            ) : (
              <div className="space-y-2">
                {blackouts.map(b => (
                  <div key={b.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                    <div>
                      <span className="text-sm text-white">
                        {new Date(b.startAt).toLocaleDateString('en-GB')} {new Date(b.startAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        {' → '}
                        {new Date(b.endAt).toLocaleDateString('en-GB')} {new Date(b.endAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {b.reason && <p className="text-xs text-muted-foreground mt-0.5">{b.reason}</p>}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => handleDeleteBlackout(b.id)} className="text-red-400 hover:text-red-300 h-7 px-2">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Book Bay Dialog */}
      <Dialog open={showBookingDialog} onOpenChange={setShowBookingDialog}>
        <DialogContent className="bg-card border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: GOLD }}>Book Bay {selectedSlot?.bayNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm">{selectedDate} at {selectedSlot?.time}</span>
            </div>

            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">Player Type</Label>
              <div className="flex gap-2">
                {(['member', 'visitor'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setBookingPlayerType(t)}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      bookingPlayerType === t
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-white/10 text-muted-foreground hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                    {config && <span className="block text-xs opacity-70">
                      ₹{parseFloat(t === 'member' ? config.memberRate : config.visitorRate).toLocaleString()}
                    </span>}
                  </button>
                ))}
              </div>
            </div>

            {bookingPlayerType === 'visitor' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Guest Name</Label>
                  <Input value={guestName} onChange={e => setGuestName(e.target.value)} placeholder="Full name" className="bg-white/5 border-white/10" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Guest Email</Label>
                  <Input value={guestEmail} onChange={e => setGuestEmail(e.target.value)} placeholder="email@example.com" type="email" className="bg-white/5 border-white/10" />
                </div>
              </div>
            )}

            {config && config.bucketsIncluded > 0 && (
              <div className="flex items-center gap-2 text-sm text-emerald-400 bg-emerald-500/10 rounded-lg p-3">
                <Zap className="w-4 h-4" />
                Includes {config.bucketsIncluded} bucket{config.bucketsIncluded > 1 ? 's' : ''} ({config.ballsPerBucket} balls each)
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBookingDialog(false)}>Cancel</Button>
            <Button onClick={handleBook} disabled={booking} style={{ background: GOLD, color: '#000' }}>
              {booking ? 'Booking...' : 'Confirm Booking'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Config Dialog */}
      <Dialog open={showConfigDialog} onOpenChange={setShowConfigDialog}>
        <DialogContent className="bg-card border-white/10 text-white max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle style={{ color: GOLD }}>Range Configuration</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">Opening Time</Label>
                <Input type="time" value={configForm.firstSlotTime} onChange={e => setConfigForm(f => ({ ...f, firstSlotTime: e.target.value }))} className="bg-white/5 border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">Closing Time</Label>
                <Input type="time" value={configForm.lastSlotTime} onChange={e => setConfigForm(f => ({ ...f, lastSlotTime: e.target.value }))} className="bg-white/5 border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">Slot Duration (min)</Label>
                <Input type="number" value={configForm.slotDurationMinutes} onChange={e => setConfigForm(f => ({ ...f, slotDurationMinutes: parseInt(e.target.value) }))} className="bg-white/5 border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">Cancel Window (hrs)</Label>
                <Input type="number" value={configForm.cancellationCutoffHours} onChange={e => setConfigForm(f => ({ ...f, cancellationCutoffHours: parseInt(e.target.value) }))} className="bg-white/5 border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">Member Rate (₹)</Label>
                <Input type="number" value={configForm.memberRate} onChange={e => setConfigForm(f => ({ ...f, memberRate: e.target.value }))} className="bg-white/5 border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">Visitor Rate (₹)</Label>
                <Input type="number" value={configForm.visitorRate} onChange={e => setConfigForm(f => ({ ...f, visitorRate: e.target.value }))} className="bg-white/5 border-white/10" />
              </div>
            </div>

            <div className="border-t border-white/10 pt-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Peak Pricing (optional)</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Peak Start</Label>
                  <Input type="time" value={configForm.peakStartTime ?? ''} onChange={e => setConfigForm(f => ({ ...f, peakStartTime: e.target.value || null }))} className="bg-white/5 border-white/10" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Peak End</Label>
                  <Input type="time" value={configForm.peakEndTime ?? ''} onChange={e => setConfigForm(f => ({ ...f, peakEndTime: e.target.value || null }))} className="bg-white/5 border-white/10" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Peak Member Rate (₹)</Label>
                  <Input type="number" value={configForm.peakMemberRate ?? ''} onChange={e => setConfigForm(f => ({ ...f, peakMemberRate: e.target.value || null }))} className="bg-white/5 border-white/10" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Peak Visitor Rate (₹)</Label>
                  <Input type="number" value={configForm.peakVisitorRate ?? ''} onChange={e => setConfigForm(f => ({ ...f, peakVisitorRate: e.target.value || null }))} className="bg-white/5 border-white/10" />
                </div>
              </div>
            </div>

            <div className="border-t border-white/10 pt-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ball Token Credits</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Balls per Bucket</Label>
                  <Input type="number" value={configForm.ballsPerBucket} onChange={e => setConfigForm(f => ({ ...f, ballsPerBucket: parseInt(e.target.value) }))} className="bg-white/5 border-white/10" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm text-muted-foreground">Buckets Included</Label>
                  <Input type="number" value={configForm.bucketsIncluded} onChange={e => setConfigForm(f => ({ ...f, bucketsIncluded: parseInt(e.target.value) }))} className="bg-white/5 border-white/10" />
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfigDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveConfig} style={{ background: GOLD, color: '#000' }}>Save Configuration</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Bay Dialog */}
      <Dialog open={showAddBayDialog} onOpenChange={setShowAddBayDialog}>
        <DialogContent className="bg-card border-white/10 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle style={{ color: GOLD }}>Add Bay</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Bay Number</Label>
              <Input type="number" value={newBayNumber} onChange={e => setNewBayNumber(e.target.value)} placeholder="e.g. 1" className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Label (optional)</Label>
              <Input value={newBayLabel} onChange={e => setNewBayLabel(e.target.value)} placeholder="e.g. Top floor left" className="bg-white/5 border-white/10" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddBayDialog(false)}>Cancel</Button>
            <Button onClick={handleAddBay} style={{ background: GOLD, color: '#000' }}>Add Bay</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Blackout Dialog */}
      <Dialog open={showBlackoutDialog} onOpenChange={setShowBlackoutDialog}>
        <DialogContent className="bg-card border-white/10 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle style={{ color: GOLD }}>Add Blackout Period</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Start</Label>
              <Input type="datetime-local" value={blackoutStart} onChange={e => setBlackoutStart(e.target.value)} className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">End</Label>
              <Input type="datetime-local" value={blackoutEnd} onChange={e => setBlackoutEnd(e.target.value)} className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Reason (optional)</Label>
              <Input value={blackoutReason} onChange={e => setBlackoutReason(e.target.value)} placeholder="e.g. Maintenance" className="bg-white/5 border-white/10" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBlackoutDialog(false)}>Cancel</Button>
            <Button onClick={handleAddBlackout} style={{ background: GOLD, color: '#000' }}>Add Blackout</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Visitor Walk-in Booking Dialog */}
      <Dialog open={showVisitorDialog} onOpenChange={setShowVisitorDialog}>
        <DialogContent className="bg-card border-white/10 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle style={{ color: GOLD }}>Walk-in Visitor Booking</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Visitor Name</Label>
              <Input value={visitorName} onChange={e => setVisitorName(e.target.value)} placeholder="Full name" className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Visitor Email</Label>
              <Input type="email" value={visitorEmail} onChange={e => setVisitorEmail(e.target.value)} placeholder="email@example.com" className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Bay</Label>
              <select
                value={visitorBayId}
                onChange={e => setVisitorBayId(e.target.value)}
                className="w-full h-9 px-3 rounded-md bg-white/5 border border-white/10 text-white text-sm"
              >
                <option value="">Select bay...</option>
                {bays.map(bay => (
                  <option key={bay.id} value={bay.id}>{bay.bayNumber}{bay.label ? ` — ${bay.label}` : ''}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">Date</Label>
                <Input type="date" value={visitorDate} min={fmtDate(new Date())} onChange={e => setVisitorDate(e.target.value)} className="bg-white/5 border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">Time</Label>
                <Input type="time" value={visitorTime} onChange={e => setVisitorTime(e.target.value)} className="bg-white/5 border-white/10" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowVisitorDialog(false)}>Cancel</Button>
            <Button
              onClick={handleVisitorBooking}
              disabled={bookingVisitor || !visitorName || !visitorEmail || !visitorBayId || !visitorDate || !visitorTime}
              style={{ background: GOLD, color: '#000' }}
            >
              {bookingVisitor ? 'Booking...' : 'Book & Send Email'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reschedule Dialog */}
      <Dialog open={!!rescheduleBooking} onOpenChange={() => setRescheduleBooking(null)}>
        <DialogContent className="bg-card border-white/10 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle style={{ color: GOLD }}>Reschedule Booking</DialogTitle>
          </DialogHeader>
          {rescheduleBooking && (
            <div className="space-y-4 py-2">
              <div className="text-sm text-muted-foreground">
                Current: Bay {rescheduleBooking.bay?.bayNumber} &bull; {rescheduleBooking.booking.slotTime}
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">New Date</Label>
                <Input
                  type="date"
                  value={rescheduleDate}
                  min={fmtDate(new Date())}
                  onChange={e => setRescheduleDate(e.target.value)}
                  className="bg-white/5 border-white/10"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-muted-foreground">New Time</Label>
                <Input
                  type="time"
                  value={rescheduleTime}
                  onChange={e => setRescheduleTime(e.target.value)}
                  className="bg-white/5 border-white/10"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRescheduleBooking(null)}>Cancel</Button>
            <Button
              onClick={handleReschedule}
              disabled={rescheduling || !rescheduleDate || !rescheduleTime}
              style={{ background: GOLD, color: '#000' }}
            >
              {rescheduling ? 'Rescheduling...' : 'Confirm Reschedule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR Dialog */}
      <Dialog open={!!showQrDialog} onOpenChange={() => setShowQrDialog(null)}>
        <DialogContent className="bg-card border-white/10 text-white max-w-sm text-center">
          <DialogHeader>
            <DialogTitle style={{ color: GOLD }}>Check-In QR Code</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-4">
            {showQrDialog?.token ? (
              <div className="mx-auto w-48 h-48 rounded-xl overflow-hidden border-2" style={{ borderColor: `${GOLD}40` }}>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(`KHGF:range:${orgId}:${showQrDialog.token}`)}`}
                  alt="Check-in QR Code"
                  className="w-full h-full object-cover"
                />
              </div>
            ) : (
              <div className="w-40 h-40 mx-auto rounded-xl flex items-center justify-center" style={{ background: `${GOLD}10`, border: `2px solid ${GOLD}40` }}>
                <QrCode className="w-20 h-20" style={{ color: GOLD }} />
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-white">Bay {showQrDialog?.bayNumber} · {showQrDialog?.slotTime}</p>
              <p className="text-xs text-muted-foreground mt-1 font-mono break-all">{showQrDialog?.token?.slice(0, 16)}...</p>
            </div>
            <p className="text-xs text-muted-foreground">Show this QR code to range staff for check-in</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface RangeMyBookingCardProps {
  b: Booking;
  isHighlight: boolean;
  onConsumeHighlight: () => void;
  onShowQr: (id: number) => void;
  onReschedule: () => void;
  onCancel: (id: number) => void;
}

function RangeMyBookingCard({ b, isHighlight, onConsumeHighlight, onShowQr, onReschedule, onCancel }: RangeMyBookingCardProps) {
  const setHighlightRef = useHighlightTarget<HTMLDivElement>(isHighlight, onConsumeHighlight);
  return (
    <Card
      ref={setHighlightRef}
      className="p-4 border-white/10 bg-card/50 flex items-center justify-between"
      data-testid={`range-booking-${b.booking.id}`}
    >
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${GOLD}15`, border: `1px solid ${GOLD}30` }}>
          <span className="text-sm font-bold" style={{ color: GOLD }}>{b.bay?.bayNumber ?? '?'}</span>
        </div>
        <div>
          <div className="text-sm font-medium text-white">
            Bay {b.bay?.bayNumber ?? '?'}{b.bay?.label ? ` · ${b.bay.label}` : ''} — {b.booking.slotTime}
          </div>
          <div className="text-xs text-muted-foreground">
            {new Date(b.booking.slotDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            {b.booking.totalAmount && parseFloat(b.booking.totalAmount) > 0 && ` · ₹${parseFloat(b.booking.totalAmount).toLocaleString()}`}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge className={`text-xs border ${STATUS_STYLES[b.booking.status] ?? ''}`}>
          {b.booking.status}
        </Badge>
        {b.booking.status === 'confirmed' && (
          <>
            <Button variant="ghost" size="sm" onClick={() => onShowQr(b.booking.id)} className="gap-1 text-xs">
              <QrCode className="w-3.5 h-3.5" /> QR
            </Button>
            <Button variant="ghost" size="sm" onClick={onReschedule} className="text-amber-400 hover:text-amber-300 gap-1 text-xs">
              <RefreshCw className="w-3.5 h-3.5" /> Reschedule
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onCancel(b.booking.id)} className="text-red-400 hover:text-red-300 gap-1 text-xs">
              <X className="w-3.5 h-3.5" /> Cancel
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
