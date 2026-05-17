import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'wouter';
import { useHighlightFromQuery, useHighlightTarget } from '@/hooks/use-highlight-row';
import {
  ChevronLeft, ChevronRight, User, Clock, Star, Calendar, CheckCircle2,
  RefreshCw, X, BookOpen, IndianRupee, AlertTriangle,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

const GOLD = '#C9A84C';

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open(): void };
  }
}

interface Pro {
  id: number;
  displayName: string;
  email: string | null;
  phone: string | null;
  bio: string | null;
  photoUrl: string | null;
  specialisms: string[];
}

interface LessonType {
  id: number;
  name: string;
  description: string | null;
  durationMinutes: number;
  pricePaise: number;
}

interface Slot {
  time: string;
  available: boolean;
}

interface Booking {
  id: number;
  proId: number;
  lessonTypeId: number;
  scheduledAt: string;
  durationMinutes: number;
  status: string;
  paymentStatus: string;
  amountPaise: number;
  proName?: string;
  lessonTypeName?: string;
  cancelledAt: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  confirmed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  cancelled: 'bg-red-500/20 text-red-300 border-red-500/30',
  completed: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  no_show: 'bg-white/10 text-white/50',
};

function formatPrice(paise: number): string {
  if (paise === 0) return 'Free';
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

export default function LessonsPage() {
  const [, navigate] = useLocation();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const { toast } = useToast();

  const [pros, setPros] = useState<Pro[]>([]);
  const [selectedPro, setSelectedPro] = useState<Pro | null>(null);
  const [lessonTypes, setLessonTypes] = useState<LessonType[]>([]);
  const [selectedType, setSelectedType] = useState<LessonType | null>(null);
  const [weekStart, setWeekStart] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  });
  const [selectedDate, setSelectedDate] = useState<string>(toDateStr(new Date()));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [bookingDialog, setBookingDialog] = useState(false);
  const [booking, setBooking] = useState(false);
  const [myBookings, setMyBookings] = useState<Booking[]>([]);
  const [tab, setTab] = useState<'book' | 'my-bookings'>('book');

  // Deep-link from the "My Upcoming" widget: /lessons?bookingId=N opens the
  // My Bookings tab and visually highlights the matching row.
  const { highlightId, consume: consumeHighlight } = useHighlightFromQuery('bookingId');
  useEffect(() => {
    if (highlightId !== null) setTab('my-bookings');
  }, [highlightId]);

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/organizations/${orgId}/lessons/pros`, { credentials: 'include' })
      .then(r => r.json()).then(setPros).catch(() => {});
    loadMyBookings();
  }, [orgId]);

  useEffect(() => {
    if (!selectedPro || !orgId) return;
    fetch(`/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/lesson-types`, { credentials: 'include' })
      .then(r => r.json()).then(setLessonTypes).catch(() => setLessonTypes([]));
  }, [selectedPro, orgId]);

  useEffect(() => {
    if (!selectedPro || !orgId) return;
    loadSlots(selectedDate);
  }, [selectedPro, selectedDate, orgId]);

  async function loadSlots(date: string) {
    if (!selectedPro || !orgId) return;
    setLoadingSlots(true);
    setSelectedSlot(null);
    try {
      const r = await fetch(`/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/availability?date=${date}`, { credentials: 'include' });
      if (r.ok) { const d = await r.json(); setSlots(d.slots ?? []); }
    } finally { setLoadingSlots(false); }
  }

  const loadMyBookings = useCallback(async () => {
    if (!orgId) return;
    try {
      const r = await fetch(`/api/organizations/${orgId}/lessons/my-bookings`, { credentials: 'include' });
      if (r.ok) setMyBookings(await r.json());
    } catch {}
  }, [orgId]);

  async function handleBook() {
    if (!selectedPro || !selectedType || !selectedSlot || !orgId) return;
    setBooking(true);

    const scheduledAt = new Date(`${selectedDate}T${selectedSlot}:00+05:30`).toISOString();

    try {
      const r = await fetch(`/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ lessonTypeId: selectedType.id, scheduledAt }),
      });
      const data = await r.json();
      if (!r.ok) { toast({ title: data.error ?? 'Booking failed', variant: 'destructive' }); return; }

      if (data.requiresPayment && data.razorpayOrder) {
        const { orderId, amount, keyId } = data.razorpayOrder;
        const bookingId = data.booking.id;

        if (!window.Razorpay) {
          const script = document.createElement('script');
          script.src = 'https://checkout.razorpay.com/v1/checkout.js';
          document.head.appendChild(script);
          await new Promise(res => { script.onload = res; });
        }

        const rzp = new window.Razorpay({
          key: keyId,
          order_id: orderId,
          amount,
          currency: 'INR',
          name: 'Golf Lesson',
          description: `${selectedType.name} with ${selectedPro.displayName}`,
          handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
            const verifyRes = await fetch(`/api/organizations/${orgId}/lessons/bookings/${bookingId}/payment/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              }),
            });
            if (verifyRes.ok) {
              toast({ title: 'Lesson booked & payment confirmed!' });
              setBookingDialog(false);
              setSelectedSlot(null);
              loadSlots(selectedDate);
              loadMyBookings();
            } else {
              toast({ title: 'Payment verification failed', variant: 'destructive' });
            }
          },
        });
        rzp.open();
      } else {
        toast({ title: 'Lesson booked successfully!' });
        setBookingDialog(false);
        setSelectedSlot(null);
        loadSlots(selectedDate);
        loadMyBookings();
      }
    } finally { setBooking(false); }
  }

  async function cancelBooking(bookingId: number) {
    if (!confirm('Cancel this lesson booking?')) return;
    const r = await fetch(`/api/organizations/${orgId}/lessons/bookings/${bookingId}/cancel`, {
      method: 'POST', credentials: 'include',
    });
    if (r.ok) { toast({ title: 'Booking cancelled' }); loadMyBookings(); }
    else { const d = await r.json(); toast({ title: d.error ?? 'Cancel failed', variant: 'destructive' }); }
  }

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  if (!orgId) {
    return <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center text-white/50">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white p-4 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')} aria-label="Back to portal">
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-white">Lessons & Coaching</h1>
            <p className="text-white/50 text-sm">Book a lesson with our teaching professionals</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={tab === 'book' ? 'default' : 'outline'}
            style={tab === 'book' ? { background: GOLD, color: '#000' } : {}}
            className={tab !== 'book' ? 'border-white/20 text-white/70' : ''}
            onClick={() => setTab('book')}
          >
            <BookOpen className="w-4 h-4 mr-1" /> Book a Lesson
          </Button>
          <Button
            size="sm"
            variant={tab === 'my-bookings' ? 'default' : 'outline'}
            style={tab === 'my-bookings' ? { background: GOLD, color: '#000' } : {}}
            className={tab !== 'my-bookings' ? 'border-white/20 text-white/70' : ''}
            onClick={() => { setTab('my-bookings'); loadMyBookings(); }}
          >
            <Calendar className="w-4 h-4 mr-1" /> My Lessons
          </Button>
        </div>

        {tab === 'book' && (
          <>
            {/* Pro Directory */}
            <div>
              <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-3">1. Choose a Professional</h2>
              {pros.length === 0 ? (
                <Card className="bg-[#111827] border-[#1e2d3d] p-8 text-center">
                  <User className="w-8 h-8 mx-auto mb-3 text-white/20" />
                  <p className="text-white/60">No teaching professionals available.</p>
                </Card>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {pros.map(pro => (
                    <Card
                      key={pro.id}
                      onClick={() => { setSelectedPro(pro); setSelectedType(null); setSelectedSlot(null); }}
                      className={`bg-[#111827] border p-4 cursor-pointer transition-all ${selectedPro?.id === pro.id ? 'border-[#C9A84C]' : 'border-[#1e2d3d] hover:border-white/20'}`}
                    >
                      <div className="flex items-start gap-3">
                        {pro.photoUrl ? (
                          <img src={pro.photoUrl} alt={pro.displayName} className="w-12 h-12 rounded-full object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                            <User className="w-6 h-6 text-white/60" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-white truncate">{pro.displayName}</div>
                          {pro.bio && <p className="text-xs text-white/50 mt-0.5 line-clamp-2">{pro.bio}</p>}
                          {pro.specialisms.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {pro.specialisms.slice(0, 3).map(s => (
                                <span key={s} className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 text-white/60">{s}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        {selectedPro?.id === pro.id && (
                          <CheckCircle2 className="w-5 h-5 flex-shrink-0" style={{ color: GOLD }} />
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>

            {selectedPro && (
              <>
                {/* Lesson Type Selection */}
                <div>
                  <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-3">2. Choose a Lesson Type</h2>
                  {lessonTypes.length === 0 ? (
                    <Card className="bg-[#111827] border-[#1e2d3d] p-6 text-center">
                      <p className="text-white/60 text-sm">No lesson types configured for this pro.</p>
                    </Card>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      {lessonTypes.map(lt => (
                        <Card
                          key={lt.id}
                          onClick={() => setSelectedType(lt)}
                          className={`bg-[#111827] border p-4 cursor-pointer transition-all ${selectedType?.id === lt.id ? 'border-[#C9A84C]' : 'border-[#1e2d3d] hover:border-white/20'}`}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium text-white">{lt.name}</div>
                              {lt.description && <p className="text-xs text-white/50 mt-0.5">{lt.description}</p>}
                              <div className="flex items-center gap-3 mt-2 text-xs text-white/60">
                                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{lt.durationMinutes} min</span>
                                <span className="flex items-center gap-1"><IndianRupee className="w-3 h-3" />{formatPrice(lt.pricePaise)}</span>
                              </div>
                            </div>
                            {selectedType?.id === lt.id && <CheckCircle2 className="w-5 h-5 flex-shrink-0" style={{ color: GOLD }} />}
                          </div>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>

                {selectedType && (
                  <>
                    {/* Date Picker */}
                    <div>
                      <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-3">3. Choose a Date</h2>
                      <Card className="bg-[#111827] border-[#1e2d3d] p-4">
                        <div className="flex items-center justify-between mb-3">
                          <Button variant="ghost" size="icon" aria-label="Previous week" onClick={() => setWeekStart(w => addDays(w, -7))}>
                            <ChevronLeft className="w-4 h-4" />
                          </Button>
                          <span className="text-sm text-white/60">
                            {weekDays[0].toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} –{' '}
                            {weekDays[6].toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </span>
                          <Button variant="ghost" size="icon" aria-label="Next week" onClick={() => setWeekStart(w => addDays(w, 7))}>
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </div>
                        <div className="grid grid-cols-7 gap-1">
                          {weekDays.map(d => {
                            const ds = toDateStr(d);
                            const isPast = d < new Date(new Date().setHours(0, 0, 0, 0));
                            const isSelected = ds === selectedDate;
                            return (
                              <button
                                key={ds}
                                disabled={isPast}
                                onClick={() => setSelectedDate(ds)}
                                className={`flex flex-col items-center py-2 px-1 rounded-lg text-xs transition-all ${
                                  isSelected ? 'text-black font-bold' : isPast ? 'text-white/20 cursor-not-allowed' : 'text-white/70 hover:bg-white/10'
                                }`}
                                style={isSelected ? { background: GOLD } : {}}
                              >
                                <span>{d.toLocaleDateString('en-IN', { weekday: 'short' }).charAt(0)}</span>
                                <span className="font-semibold mt-0.5">{d.getDate()}</span>
                              </button>
                            );
                          })}
                        </div>
                      </Card>
                    </div>

                    {/* Time Slots */}
                    <div>
                      <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-3">4. Choose a Time</h2>
                      {loadingSlots ? (
                        <div className="flex justify-center py-8">
                          <RefreshCw className="w-6 h-6 text-white/30 animate-spin" />
                        </div>
                      ) : slots.filter(s => s.available).length === 0 ? (
                        <Card className="bg-[#111827] border-[#1e2d3d] p-8 text-center">
                          <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-white/30" />
                          <p className="text-white/60 text-sm">No available slots on this date.</p>
                        </Card>
                      ) : (
                        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                          {slots.filter(s => s.available).map(slot => (
                            <button
                              key={slot.time}
                              onClick={() => { setSelectedSlot(slot.time); setBookingDialog(true); }}
                              className={`py-2 px-2 rounded-lg text-xs font-medium transition-all border ${
                                selectedSlot === slot.time
                                  ? 'border-[#C9A84C] text-black'
                                  : 'border-white/20 text-white/70 hover:border-white/40 hover:text-white bg-white/5'
                              }`}
                              style={selectedSlot === slot.time ? { background: GOLD } : {}}
                            >
                              {slot.time}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {tab === 'my-bookings' && (
          <div>
            {myBookings.length === 0 ? (
              <Card className="bg-[#111827] border-[#1e2d3d] p-12 text-center">
                <Calendar className="w-8 h-8 mx-auto mb-3 text-white/20" />
                <p className="text-white/60">You have no lesson bookings yet.</p>
                <Button className="mt-4" style={{ background: GOLD, color: '#000' }} onClick={() => setTab('book')}>
                  Book a Lesson
                </Button>
              </Card>
            ) : (
              <div className="space-y-3">
                {myBookings.map(bk => (
                  <LessonBookingCard
                    key={bk.id}
                    booking={bk}
                    isHighlight={highlightId === bk.id}
                    onConsumeHighlight={consumeHighlight}
                    onCancel={cancelBooking}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Booking Confirmation Dialog */}
      <Dialog open={bookingDialog} onOpenChange={setBookingDialog}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white">
          <DialogHeader>
            <DialogTitle>Confirm Booking</DialogTitle>
          </DialogHeader>
          {selectedPro && selectedType && selectedSlot && (
            <div className="py-4 space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-white/60" />
                <span className="text-white/70">Pro:</span>
                <span className="text-white font-medium">{selectedPro.displayName}</span>
              </div>
              <div className="flex items-center gap-2">
                <Star className="w-4 h-4 text-white/60" />
                <span className="text-white/70">Lesson:</span>
                <span className="text-white font-medium">{selectedType.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-white/60" />
                <span className="text-white/70">Date:</span>
                <span className="text-white font-medium">
                  {new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-white/60" />
                <span className="text-white/70">Time:</span>
                <span className="text-white font-medium">{selectedSlot} · {selectedType.durationMinutes} min</span>
              </div>
              <div className="flex items-center gap-2">
                <IndianRupee className="w-4 h-4 text-white/60" />
                <span className="text-white/70">Amount:</span>
                <span className="text-white font-bold text-base">{formatPrice(selectedType.pricePaise)}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBookingDialog(false)}>Cancel</Button>
            <Button onClick={handleBook} disabled={booking} style={{ background: GOLD, color: '#000' }}>
              {booking ? 'Processing...' : selectedType?.pricePaise === 0 ? 'Confirm Booking' : 'Proceed to Payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface LessonBookingCardProps {
  booking: Booking;
  isHighlight: boolean;
  onConsumeHighlight: () => void;
  onCancel: (id: number) => void;
}

function LessonBookingCard({ booking: bk, isHighlight, onConsumeHighlight, onCancel }: LessonBookingCardProps) {
  const setHighlightRef = useHighlightTarget<HTMLDivElement>(isHighlight, onConsumeHighlight);
  return (
    <Card
      ref={setHighlightRef}
      className="bg-[#111827] border-[#1e2d3d] p-4"
      data-testid={`lesson-booking-${bk.id}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white">{bk.proName ?? 'Pro'}</span>
            <span className="text-white/60">·</span>
            <span className="text-white/70 text-sm">{bk.lessonTypeName ?? 'Lesson'}</span>
          </div>
          <div className="text-xs text-white/60 mt-1">
            {formatDateShort(bk.scheduledAt)} at {formatTime(bk.scheduledAt)}
            {' · '}{bk.durationMinutes} min
            {bk.amountPaise > 0 && <> · {formatPrice(bk.amountPaise)}</>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge className={`text-xs capitalize ${STATUS_COLOR[bk.status] ?? ''}`}>{bk.status}</Badge>
          {['pending', 'confirmed'].includes(bk.status) && (
            <Button size="sm" variant="ghost"
              className="h-7 px-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
              onClick={() => onCancel(bk.id)}>
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
