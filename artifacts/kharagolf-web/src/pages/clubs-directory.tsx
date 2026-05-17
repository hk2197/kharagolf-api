import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useLocation } from 'wouter';
import {
  Building2, Search, MapPin, Globe, Mail, Users, Trophy,
  ChevronRight, ExternalLink, Loader2, AlertCircle,
  Calendar, UserPlus, Clock, ChevronLeft, Lock, X, CalendarCheck, ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useGetMe } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open(): void };
  }
}

interface Club {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  subscriptionTier: string;
  contactEmail: string | null;
  website: string | null;
  address: string | null;
  createdAt: string;
}

interface Tournament {
  id: number;
  name: string;
  format: string;
  status: string;
  startDate: string | null;
  entryFee: string | null;
  currency: string;
  playerCount: number;
  maxPlayers: number | null;
  isFull: boolean;
}

interface RecentTournament {
  id: number;
  name: string;
  format: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
}

interface ClubDetail extends Club {
  memberCount: number;
  recentTournaments?: RecentTournament[];
}

// Directory listing page
export function ClubsDirectoryPage() {
  const [search, setSearch] = useState('');
  const [, navigate] = useLocation();

  const { data: clubs = [], isLoading } = useQuery<Club[]>({
    queryKey: ['/api/onboarding/clubs'],
    queryFn: () => fetch('/api/onboarding/clubs').then(r => r.json()),
    staleTime: 60000,
  });

  const filtered = clubs.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.address?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-[#0a0f0d]">
      {/* Hero */}
      <div className="relative overflow-hidden py-16 px-4 text-center border-b border-white/5">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent pointer-events-none" />
        <div className="relative max-w-2xl mx-auto">
          <div className="flex items-center justify-center gap-2 mb-4">
            <img src="/logo.png" alt="KHARAGOLF" className="w-10 h-10 object-contain" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            <span className="text-2xl font-bold text-white">KHARAGOLF</span>
          </div>
          <h1 className="text-4xl font-bold text-white mb-3">Golf Clubs Directory</h1>
          <p className="text-muted-foreground text-lg mb-8">
            Find and join golf clubs across India on the KHARAGOLF platform.
          </p>
          <div className="flex gap-3 max-w-md mx-auto">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name or location..."
                className="pl-9 bg-white/5 border-white/10 text-white placeholder:text-muted-foreground"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Register CTA */}
      <div className="py-4 px-4 bg-primary/5 border-b border-primary/20 text-center">
        <p className="text-sm text-muted-foreground">
          Running a golf club?{' '}
          <button
            onClick={() => navigate('/register-club')}
            className="text-primary hover:underline font-medium"
          >
            Register your club for free →
          </button>
        </p>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Building2 className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-white font-semibold mb-2">No clubs found</h3>
            <p className="text-muted-foreground text-sm">
              {search ? 'Try a different search term.' : 'No clubs have been registered yet.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground mb-4">{filtered.length} club{filtered.length !== 1 ? 's' : ''} found</p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map(club => (
                <button
                  key={club.id}
                  onClick={() => navigate(`/clubs/${club.slug}`)}
                  className="text-left group"
                >
                  <Card className="bg-black/40 border-white/10 hover:border-primary/40 transition-all h-full">
                    <div
                      className="h-1.5 w-full rounded-t-xl transition-all"
                      style={{ backgroundColor: club.primaryColor || '#1e4d2b' }}
                    />
                    <CardHeader className="pb-3">
                      <div className="flex items-start gap-3">
                        {club.logoUrl ? (
                          <img src={club.logoUrl} alt="" className="w-12 h-12 rounded-xl object-contain bg-white/10 p-1 flex-shrink-0" />
                        ) : (
                          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                            <Building2 className="w-6 h-6 text-primary" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <h3 className="font-bold text-white group-hover:text-primary transition-colors truncate">{club.name}</h3>
                          {club.address && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <MapPin className="w-3 h-3 flex-shrink-0" />
                              <span className="truncate">{club.address}</span>
                            </p>
                          )}
                        </div>
                        <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0 mt-1" />
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      {club.description && (
                        <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{club.description}</p>
                      )}
                      <div className="flex gap-2 text-xs text-muted-foreground">
                        {club.website && (
                          <span className="flex items-center gap-1"><Globe className="w-3 h-3" />Website</span>
                        )}
                        {club.contactEmail && (
                          <span className="flex items-center gap-1"><Mail className="w-3 h-3" />Contact</span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Individual club public page
interface TeeSlot {
  id: number;
  slotDate: string;
  slotTime: string;
  capacity: number;
  status: string;
  isMembersOnly: boolean;
  courseId: number;
  courseName: string | null;
  bookedCount: number;
}

interface TeePricing {
  memberRate: string | null;
  guestRate: string | null;
  paymentModel: string;
  cancellationCutoffHours: number;
  maxGuestsPerBooking: number;
}

export function ClubPublicPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  const { data: me } = useGetMe();
  const { toast } = useToast();

  const today = new Date().toISOString().split('T')[0];
  const [teeDate, setTeeDate] = useState(today);
  const [teeSlots, setTeeSlots] = useState<TeeSlot[] | null>(null);
  const [teePricing, setTeePricing] = useState<TeePricing | null>(null);
  const [teeLoading, setTeeLoading] = useState(false);
  const [teeUpgradeRequired, setTeeUpgradeRequired] = useState(false);

  // Booking dialog state
  const [bookingSlot, setBookingSlot] = useState<TeeSlot | null>(null);
  const [partySize, setPartySize] = useState(1);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberResults, setMemberResults] = useState<{ id: number; displayName: string | null; username: string; email: string | null }[]>([]);
  const [addedMembers, setAddedMembers] = useState<{ id: number; name: string }[]>([]);
  const [addedGuests, setAddedGuests] = useState<{ name: string; email: string }[]>([]);
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [booking, setBooking] = useState(false);

  // My Bookings + Replace Player state
  type MyBooking = { booking: { id: number; status: string; partySize: number; paymentModel: string }; slotDate: string; slotTime: string; courseName: string | null };
  type BookingPlayer = { id: number; playerType: string; userId: number | null; guestName: string | null; guestEmail: string | null; confirmationStatus: string; displayName: string | null; username: string | null };
  const [myBookings, setMyBookings] = useState<MyBooking[] | null>(null);
  const [expandBookingId, setExpandBookingId] = useState<number | null>(null);
  const [bookingPlayers, setBookingPlayers] = useState<Record<number, BookingPlayer[]>>({});
  const [replaceDialogBookingId, setReplaceDialogBookingId] = useState<number | null>(null);
  const [replaceTargetPlayerId, setReplaceTargetPlayerId] = useState<number | null>(null);
  const [replaceSearch, setReplaceSearch] = useState('');
  const [replaceResults, setReplaceResults] = useState<{ id: number; displayName: string | null; username: string }[]>([]);
  const [replaceGuestMode, setReplaceGuestMode] = useState(false);
  const [replaceGuestName, setReplaceGuestName] = useState('');
  const [replaceGuestEmail, setReplaceGuestEmail] = useState('');
  const [replacing, setReplacing] = useState(false);

  async function fetchMyBookings(orgId: number) {
    const res = await fetch(`/api/organizations/${orgId}/tee-bookings/my`, { credentials: 'include' });
    if (res.ok) setMyBookings(await res.json());
  }

  async function fetchBookingPlayers(orgId: number, bookingId: number) {
    if (bookingPlayers[bookingId]) return;
    const r = await fetch(`/api/organizations/${orgId}/tee-bookings/${bookingId}/players`, { credentials: 'include' });
    if (r.ok) { const data = await r.json(); setBookingPlayers(prev => ({ ...prev, [bookingId]: data })); }
  }

  async function searchReplaceMembers(orgId: number, q: string) {
    if (q.length < 2) { setReplaceResults([]); return; }
    const r = await fetch(`/api/organizations/${orgId}/tee-bookings/members/search?q=${encodeURIComponent(q)}`, { credentials: 'include' });
    if (r.ok) setReplaceResults(await r.json());
  }

  async function submitReplacePlayer(orgId: number, bookingId: number, newUserId?: number, guestN?: string, guestE?: string) {
    setReplacing(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/tee-bookings/${bookingId}/replace-player`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ declinedPlayerId: replaceTargetPlayerId ?? undefined, newUserId, newGuestName: guestN, newGuestEmail: guestE }),
      });
      if (r.ok) {
        toast({ title: 'Player replaced', description: 'The new player has been notified.' });
        setReplaceDialogBookingId(null);
        setReplaceTargetPlayerId(null);
        setReplaceSearch('');
        setReplaceResults([]);
        setReplaceGuestMode(false);
        setReplaceGuestName('');
        setReplaceGuestEmail('');
        setBookingPlayers(prev => { const n = { ...prev }; delete n[bookingId]; return n; });
        await fetchMyBookings(orgId);
      } else {
        const err = await r.json().catch(() => ({}));
        toast({ title: 'Replace failed', description: err.error ?? 'Please try again.', variant: 'destructive' });
      }
    } finally { setReplacing(false); }
  }

  function resetBookingDialog() {
    setBookingSlot(null);
    setAddedMembers([]);
    setAddedGuests([]);
    setGuestName('');
    setGuestEmail('');
    setMemberResults([]);
    setMemberSearch('');
  }

  const { data: club, isLoading, error } = useQuery<ClubDetail>({
    queryKey: ['/api/onboarding/clubs', slug],
    queryFn: () => fetch(`/api/onboarding/clubs/${slug}`).then(async r => {
      if (!r.ok) throw new Error('Club not found');
      return r.json();
    }),
    staleTime: 60000,
    enabled: !!slug,
  });

  const { data: publicTournaments = [] } = useQuery<Tournament[]>({
    queryKey: ['/api/public/tournaments', club?.id],
    queryFn: async () => {
      if (!club?.id) return [];
      const res = await fetch(`/api/public/tournaments?orgId=${club.id}`);
      if (!res.ok) return [];
      const data = await res.json();
      return (Array.isArray(data) ? data : (data.tournaments ?? [])).filter(
        (t: Tournament) => t.status === 'upcoming' || t.status === 'active'
      );
    },
    enabled: !!club?.id,
    staleTime: 30000,
  });

  async function fetchTeeSlots(orgId: number, date: string) {
    setTeeLoading(true);
    setTeeUpgradeRequired(false);
    try {
      const res = await fetch(`/api/public/tee-slots?orgId=${orgId}&date=${date}`);
      if (res.ok) {
        const data = await res.json();
        setTeeSlots(data.slots ?? []);
        setTeePricing(data.pricing);
      } else if (res.status === 403) {
        const data = await res.json().catch(() => ({}));
        if (data.code === 'SUBSCRIPTION_REQUIRED') setTeeUpgradeRequired(true);
      }
    } catch { /**/ } finally { setTeeLoading(false); }
  }

  function shiftDate(days: number) {
    const d = new Date(teeDate);
    d.setDate(d.getDate() + days);
    const newDate = d.toISOString().split('T')[0];
    setTeeDate(newDate);
    if (club?.id) fetchTeeSlots(club.id, newDate);
  }

  async function searchMembers(q: string, orgId: number) {
    if (q.length < 2) { setMemberResults([]); return; }
    try {
      const res = await fetch(`/api/organizations/${orgId}/tee-bookings/members/search?q=${encodeURIComponent(q)}`, { credentials: 'include' });
      if (res.ok) setMemberResults(await res.json());
    } catch { /* noop */ }
  }

  async function bookTeeTime() {
    if (!bookingSlot || !club) return;
    setBooking(true);
    try {
      const memberPlayers = addedMembers.map(m => ({ type: 'member', userId: m.id }));
      const guestPlayers = addedGuests.map(g => ({ type: 'guest', guestName: g.name, guestEmail: g.email || undefined }));
      const players = [...memberPlayers, ...guestPlayers];
      const res = await fetch(`/api/organizations/${club.id}/tee-bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ slotId: bookingSlot.id, partySize, players }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({ title: body.error ?? 'Failed to book', variant: 'destructive' }); return;
      }
      const newBooking = await res.json();

      // If online/prepaid payment model, request the authoritative payment order from the server.
      // The server computes the payable total from all player fee rows (member + guests),
      // so we always call payment-order for isPrepaid — never guess from memberRate.
      const isPrepaid = teePricing?.paymentModel === 'online' || teePricing?.paymentModel === 'prepaid';
      if (isPrepaid) {
        const orderRes = await fetch(`/api/organizations/${club.id}/tee-bookings/${newBooking.id}/payment-order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
        if (orderRes.ok) {
          const orderData = await orderRes.json();
          // Only open Razorpay when there is a non-zero amount; free bookings fall through.
          if (orderData.amount > 0) {
            await new Promise<void>((resolve) => {
              const script = document.createElement('script');
              script.src = 'https://checkout.razorpay.com/v1/checkout.js';
              script.async = true;
              script.onload = () => {
                const rz = new window.Razorpay({
                  key: orderData.keyId,
                  amount: orderData.amount,
                  currency: 'INR',
                  order_id: orderData.orderId,
                  name: club.name,
                  description: `Tee time — ${bookingSlot.slotTime} on ${teeDate}`,
                  handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
                    const verifyRes = await fetch(`/api/organizations/${club.id}/tee-bookings/${newBooking.id}/verify-payment`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({
                        razorpayPaymentId: response.razorpay_payment_id,
                        razorpayOrderId: response.razorpay_order_id,
                        razorpaySignature: response.razorpay_signature,
                      }),
                    });
                    if (verifyRes.ok) {
                      toast({ title: 'Payment successful! Tee time confirmed.', description: `${bookingSlot.slotTime} on ${teeDate}` });
                    } else {
                      const errBody = await verifyRes.json().catch(() => ({}));
                      toast({ title: 'Payment verification failed', description: errBody.error ?? 'Please contact support.', variant: 'destructive' });
                    }
                    resolve();
                  },
                  modal: { ondismiss: () => { toast({ title: 'Payment cancelled', description: 'Your booking is held but unpaid.' }); resolve(); } },
                  prefill: {},
                  theme: { color: club.primaryColor || '#1e4d2b' },
                });
                rz.open();
              };
              document.body.appendChild(script);
            });
            setBookingSlot(null);
            resetBookingDialog();
            fetchTeeSlots(club.id, teeDate);
            return;
          }
          // amount=0 — free booking, fall through to success toast
        } else {
          // payment-order API failed — booking is held pending, not confirmed
          const orderErr = await orderRes.json().catch(() => ({}));
          toast({
            title: 'Booking held — payment not started',
            description: orderErr.error ?? 'Could not initialise payment. Your booking is reserved but unpaid. Please retry payment from your bookings page.',
            variant: 'destructive',
          });
          resetBookingDialog();
          fetchTeeSlots(club.id, teeDate);
          return;
        }
      }

      // Pay-at-checkin or genuinely free prepaid — booking complete
      toast({ title: 'Tee time booked!', description: `${bookingSlot.slotTime} on ${teeDate}` });
      resetBookingDialog();
      fetchTeeSlots(club.id, teeDate);
    } finally { setBooking(false); }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0f0d] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !club) {
    return (
      <div className="min-h-screen bg-[#0a0f0d] flex flex-col items-center justify-center p-4 text-center">
        <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">Club Not Found</h2>
        <p className="text-muted-foreground mb-4">This club page doesn't exist or has been removed.</p>
        <Button variant="outline" onClick={() => navigate('/clubs')}>Browse all clubs</Button>
      </div>
    );
  }

  const primaryColor = club.primaryColor || '#1e4d2b';

  const formatName = (format: string) => format.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  return (
    <>
    <div className="min-h-screen bg-[#0a0f0d]">
      {/* Club Hero Banner */}
      <div
        className="relative py-12 px-4 text-center border-b border-white/5"
        style={{ background: `linear-gradient(135deg, ${primaryColor}15 0%, transparent 60%)` }}
      >
        <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundColor: primaryColor }} />
        <div className="max-w-2xl mx-auto">
          <button
            onClick={() => navigate('/clubs')}
            className="text-xs text-muted-foreground hover:text-primary mb-6 flex items-center gap-1 mx-auto"
          >
            ← All Clubs
          </button>
          {club.logoUrl ? (
            <img src={club.logoUrl} alt={club.name} className="w-20 h-20 rounded-2xl object-contain bg-white/10 p-2 mx-auto mb-4 shadow-lg" />
          ) : (
            <div className="w-20 h-20 rounded-2xl bg-white/10 flex items-center justify-center mx-auto mb-4">
              <Building2 className="w-10 h-10 text-white/60" />
            </div>
          )}
          <h1 className="text-3xl font-bold text-white mb-2">{club.name}</h1>
          {club.address && (
            <p className="text-muted-foreground flex items-center gap-1.5 justify-center mb-3">
              <MapPin className="w-4 h-4" style={{ color: primaryColor }} />
              {club.address}
            </p>
          )}
          {club.description && (
            <p className="text-muted-foreground max-w-md mx-auto mb-4">{club.description}</p>
          )}
          <div className="flex items-center justify-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Users className="w-4 h-4" style={{ color: primaryColor }} />
              {club.memberCount} Members
            </span>
            {club.contactEmail && (
              <a href={`mailto:${club.contactEmail}`} className="flex items-center gap-1.5 hover:text-white transition-colors">
                <Mail className="w-4 h-4" />
                Contact
              </a>
            )}
            {club.website && (
              <a href={club.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-white transition-colors">
                <Globe className="w-4 h-4" />
                Website
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Upcoming Tournaments */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Trophy className="w-5 h-5" style={{ color: primaryColor }} />
              Open Tournaments
            </h2>
          </div>

          {publicTournaments.length === 0 ? (
            <div className="bg-white/5 border border-white/10 rounded-xl p-8 text-center">
              <Calendar className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground text-sm">No open tournaments at the moment.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {publicTournaments.map(t => (
                <Card key={t.id} className="bg-black/40 border-white/10 hover:border-white/20 transition-all">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-white truncate">{t.name}</h3>
                          <Badge className="text-xs" style={{ backgroundColor: `${primaryColor}20`, color: primaryColor, borderColor: `${primaryColor}40` }}>
                            {formatName(t.format)}
                          </Badge>
                          {t.status === 'active' && (
                            <Badge className="text-xs bg-green-500/20 text-green-400 border-green-500/30">Live</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          {t.startDate && (
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {new Date(t.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Users className="w-3 h-3" />
                            {t.playerCount}{t.maxPlayers ? `/${t.maxPlayers}` : ''} players
                            {t.isFull && <span className="text-yellow-400 ml-1">(Full)</span>}
                          </span>
                          {t.entryFee && parseFloat(t.entryFee) > 0 && (
                            <span>₹{parseFloat(t.entryFee).toLocaleString('en-IN')} entry</span>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => navigate(`/register/${club.id}/${t.id}`)}
                        style={{ backgroundColor: primaryColor }}
                        className="flex-shrink-0 text-white hover:opacity-90"
                      >
                        {t.isFull ? 'Waitlist' : 'Register'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* Tee Time Booking */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Clock className="w-5 h-5" style={{ color: primaryColor }} />
              Book a Tee Time
            </h2>
          </div>

          {/* Date Picker Row */}
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => shiftDate(-1)}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/70 hover:text-white transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input
              type="date"
              value={teeDate}
              min={today}
              onChange={e => {
                setTeeDate(e.target.value);
                if (club?.id) fetchTeeSlots(club.id, e.target.value);
              }}
              className="flex-1 bg-white/5 border border-white/10 text-white rounded-lg px-3 py-2 text-sm text-center"
            />
            <button
              onClick={() => shiftDate(1)}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/70 hover:text-white transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <Button
              size="sm"
              onClick={() => fetchTeeSlots(club.id, teeDate)}
              style={{ backgroundColor: primaryColor }}
              className="text-white hover:opacity-90 shrink-0"
            >
              {teeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Check'}
            </Button>
          </div>

          {/* Slot Results */}
          {teeUpgradeRequired ? (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-8 text-center">
              <Lock className="w-8 h-8 text-amber-400 mx-auto mb-2" />
              <p className="text-amber-300 font-semibold text-sm mb-1">Tee Time Booking Requires Starter Plan</p>
              <p className="text-muted-foreground text-xs">This club needs a Starter or higher subscription to enable online tee time booking.</p>
            </div>
          ) : teeSlots === null ? (
            <div className="bg-white/5 border border-white/10 rounded-xl p-8 text-center">
              <Clock className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground text-sm">Select a date and tap "Check" to see available tee times.</p>
            </div>
          ) : teeLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 text-muted-foreground animate-spin" /></div>
          ) : teeSlots.length === 0 ? (
            <div className="bg-white/5 border border-white/10 rounded-xl p-8 text-center">
              <Calendar className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground text-sm">No available tee times for this date.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {teeSlots.map(slot => {
                const spotsLeft = slot.capacity - slot.bookedCount;
                const memberRate = teePricing?.memberRate ? parseFloat(teePricing.memberRate) : 0;
                const priceText = memberRate > 0
                  ? `₹${memberRate.toLocaleString('en-IN')}/member`
                  : teePricing?.paymentModel === 'pay_at_checkin' ? 'Pay at course' : 'Free';
                return (
                  <div
                    key={slot.id}
                    className="bg-white/5 border border-white/10 hover:border-white/20 rounded-xl p-4 text-center transition-colors"
                  >
                    <p className="text-lg font-bold text-white flex items-center justify-center gap-1">
                      {slot.slotTime}
                      {slot.isMembersOnly && <Lock className="w-3 h-3 text-amber-400" />}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{slot.courseName ?? 'Course'}</p>
                    <p className="text-xs text-muted-foreground">{spotsLeft} of {slot.capacity} spots</p>
                    <p className="text-xs mt-1" style={{ color: primaryColor }}>{priceText}</p>
                    {me ? (
                      <Button
                        size="sm"
                        className="w-full mt-2 text-white text-xs h-7 hover:opacity-90"
                        style={{ backgroundColor: primaryColor }}
                        disabled={spotsLeft === 0}
                        onClick={() => {
                          setBookingSlot(slot);
                          setPartySize(1);
                          setAddedMembers([]);
                          setMemberSearch('');
                          setMemberResults([]);
                        }}
                      >
                        {spotsLeft === 0 ? 'Full' : 'Book →'}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full mt-2 text-xs h-7 border-white/20 text-white/60"
                        onClick={() => navigate('/portal')}
                      >
                        Sign in to Book
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* My Upcoming Bookings (lead view) */}
        {me && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <CalendarCheck className="w-5 h-5" style={{ color: primaryColor }} />
                My Tee Bookings
              </h2>
              <Button size="sm" variant="ghost" className="text-xs text-muted-foreground hover:text-white"
                onClick={() => fetchMyBookings(club.id)}>
                Refresh
              </Button>
            </div>

            {myBookings === null ? (
              <Button size="sm" variant="outline" className="border-white/20 text-white/70 hover:text-white w-full"
                onClick={() => fetchMyBookings(club.id)}>
                Load My Bookings
              </Button>
            ) : myBookings.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-4">No bookings yet.</p>
            ) : (
              <div className="space-y-2">
                {myBookings.map(mb => {
                  const b = mb.booking;
                  const dateLabel = mb.slotDate ? new Date(mb.slotDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
                  const isExpanded = expandBookingId === b.id;
                  const statusColor = b.status === 'confirmed' ? '#22c55e' : b.status === 'cancelled' ? '#ef4444' : '#f59e0b';
                  const players = bookingPlayers[b.id] ?? [];
                  const needsReplacement = players.some(p => p.confirmationStatus === 'declined' || (p.userId === null && p.confirmationStatus === 'pending'));

                  return (
                    <div key={b.id} className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
                      <button
                        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-white/5 transition-colors"
                        onClick={() => {
                          setExpandBookingId(isExpanded ? null : b.id);
                          if (!isExpanded) fetchBookingPlayers(club.id, b.id);
                        }}
                      >
                        <div>
                          <p className="text-sm font-semibold text-white">{mb.slotTime} · {dateLabel}</p>
                          <p className="text-xs text-muted-foreground">{mb.courseName ?? 'Course'} · {b.partySize} players</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {needsReplacement && isExpanded && (
                            <span className="text-xs bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full">Open seat</span>
                          )}
                          <span className="text-xs font-medium" style={{ color: statusColor }}>
                            {b.status.charAt(0).toUpperCase() + b.status.slice(1)}
                          </span>
                          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="px-4 pb-3 border-t border-white/10 pt-3 space-y-2">
                          {players.length === 0 ? (
                            <p className="text-xs text-muted-foreground">Loading players…</p>
                          ) : (
                            players.map(p => {
                              const name = p.displayName ?? p.username ?? p.guestName ?? 'TBD';
                              const isDeclined = p.confirmationStatus === 'declined';
                              const isPlaceholder = p.userId === null && p.confirmationStatus === 'pending' && !p.guestName;
                              const statusIcon = p.confirmationStatus === 'confirmed' ? '✓' : isDeclined ? '✗' : '…';
                              return (
                                <div key={p.id} className="flex items-center justify-between gap-2">
                                  <span className={`text-xs ${isDeclined || isPlaceholder ? 'text-muted-foreground line-through' : 'text-white'}`}>
                                    {statusIcon} {isPlaceholder ? 'Open seat (TBD)' : name}
                                  </span>
                                  {(isDeclined || isPlaceholder) && b.status !== 'cancelled' && (
                                    <button
                                      className="text-xs text-amber-400 hover:text-amber-300 underline"
                                      onClick={() => {
                                        setReplaceDialogBookingId(b.id);
                                        setReplaceTargetPlayerId(isDeclined ? p.id : null);
                                        setReplaceSearch('');
                                        setReplaceResults([]);
                                        setReplaceGuestMode(false);
                                        setReplaceGuestName('');
                                        setReplaceGuestEmail('');
                                      }}
                                    >
                                      Replace
                                    </button>
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Replace Player Dialog */}
            {replaceDialogBookingId !== null && (
              <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                <div className="bg-background border border-border rounded-2xl w-full max-w-sm p-5 space-y-4">
                  <h3 className="font-semibold text-white text-base">Replace Player</h3>

                  <div className="flex gap-2">
                    <button onClick={() => setReplaceGuestMode(false)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${!replaceGuestMode ? 'text-white' : 'text-muted-foreground bg-white/5'}`}
                      style={!replaceGuestMode ? { backgroundColor: primaryColor } : {}}>
                      Member
                    </button>
                    <button onClick={() => setReplaceGuestMode(true)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${replaceGuestMode ? 'text-white' : 'text-muted-foreground bg-white/5'}`}
                      style={replaceGuestMode ? { backgroundColor: primaryColor } : {}}>
                      Guest
                    </button>
                  </div>

                  {!replaceGuestMode ? (
                    <div className="space-y-2">
                      <input
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-white/30"
                        placeholder="Search member…"
                        value={replaceSearch}
                        onChange={e => { setReplaceSearch(e.target.value); searchReplaceMembers(club.id, e.target.value); }}
                      />
                      {replaceResults.length > 0 && (
                        <div className="bg-white/5 border border-white/10 rounded-lg divide-y divide-white/10 max-h-40 overflow-y-auto">
                          {replaceResults.map(m => (
                            <button key={m.id} className="w-full px-3 py-2 text-left text-sm text-white hover:bg-white/10 transition-colors"
                              onClick={() => submitReplacePlayer(club.id, replaceDialogBookingId!, m.id)}>
                              {m.displayName ?? m.username}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <input
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-white/30"
                        placeholder="Guest name"
                        value={replaceGuestName}
                        onChange={e => setReplaceGuestName(e.target.value)}
                      />
                      <input
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-white/30"
                        placeholder="Guest email (optional)"
                        value={replaceGuestEmail}
                        onChange={e => setReplaceGuestEmail(e.target.value)}
                      />
                      <Button
                        size="sm"
                        disabled={!replaceGuestName || replacing}
                        className="w-full text-white hover:opacity-90"
                        style={{ backgroundColor: primaryColor }}
                        onClick={() => submitReplacePlayer(club.id, replaceDialogBookingId!, undefined, replaceGuestName, replaceGuestEmail || undefined)}
                      >
                        {replacing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add Guest'}
                      </Button>
                    </div>
                  )}

                  <button onClick={() => { setReplaceDialogBookingId(null); setReplaceTargetPlayerId(null); }}
                    className="w-full text-center text-xs text-muted-foreground hover:text-white py-1 transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Recent Results */}
        {club.recentTournaments && club.recentTournaments.length > 0 && (
          <section>
            <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
              <Trophy className="w-5 h-5 text-muted-foreground" />
              Recent Results
            </h2>
            <div className="space-y-2">
              {club.recentTournaments.map(t => (
                <div key={t.id} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium text-white text-sm truncate">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatName(t.format)}
                      {t.startDate && ` · ${new Date(t.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                    </p>
                  </div>
                  <Badge className="text-xs bg-muted text-muted-foreground border-border flex-shrink-0">Completed</Badge>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Join CTA */}
        <section>
          <div
            className="rounded-xl p-6 text-center border"
            style={{ background: `${primaryColor}10`, borderColor: `${primaryColor}30` }}
          >
            <UserPlus className="w-8 h-8 mx-auto mb-3" style={{ color: primaryColor }} />
            <h3 className="text-lg font-bold text-white mb-2">Join {club.name}</h3>
            <p className="text-muted-foreground text-sm mb-4">
              Become a member to access tournaments, track your handicap, and connect with fellow golfers.
            </p>
            <div className="flex gap-3 justify-center">
              <Button
                onClick={() => navigate('/portal')}
                style={{ backgroundColor: primaryColor }}
                className="text-white hover:opacity-90"
              >
                <UserPlus className="w-4 h-4 mr-1.5" />
                Join this Club
              </Button>
              {club.contactEmail && (
                <Button variant="outline" asChild>
                  <a href={`mailto:${club.contactEmail}?subject=Membership Enquiry - ${club.name}`}>
                    <Mail className="w-4 h-4 mr-1.5" /> Contact Club
                  </a>
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>

    {/* Booking Dialog */}
    <Dialog open={!!bookingSlot} onOpenChange={open => { if (!open) resetBookingDialog(); }}>
      <DialogContent className="bg-[#111] border border-white/10 text-white max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <Clock className="w-4 h-4" style={{ color: primaryColor }} />
            Book Tee Time — {bookingSlot?.slotTime}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="bg-white/5 rounded-lg p-3 text-sm flex justify-between">
            <span className="text-muted-foreground">{teeDate}</span>
            <span className="text-white font-medium">{bookingSlot?.courseName ?? 'Course'}</span>
          </div>
          <div>
            <Label className="text-muted-foreground text-xs mb-1 block">Party Size</Label>
            <Input
              type="number"
              min={1}
              max={bookingSlot ? bookingSlot.capacity - bookingSlot.bookedCount : 4}
              value={partySize}
              onChange={e => setPartySize(Math.max(1, parseInt(e.target.value) || 1))}
              className="bg-white/5 border-white/10 text-white"
            />
          </div>

          {club && me && (
            <div>
              <Label className="text-muted-foreground text-xs mb-1 block">Add Members to Group (optional)</Label>
              <Input
                placeholder="Search by name or email…"
                value={memberSearch}
                onChange={e => {
                  setMemberSearch(e.target.value);
                  searchMembers(e.target.value, club.id);
                }}
                className="bg-white/5 border-white/10 text-white text-sm"
              />
              {memberResults.length > 0 && (
                <div className="mt-1 bg-[#1a1a1a] border border-white/10 rounded-lg overflow-hidden max-h-36 overflow-y-auto">
                  {memberResults.filter(m => !addedMembers.find(a => a.id === m.id)).map(m => (
                    <button
                      key={m.id}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-white/5 flex items-center justify-between group"
                      onClick={() => {
                        setAddedMembers(prev => [...prev, { id: m.id, name: m.displayName ?? m.username }]);
                        setMemberResults([]);
                        setMemberSearch('');
                      }}
                    >
                      <span className="text-white">{m.displayName ?? m.username}</span>
                      <span className="text-xs text-muted-foreground">{m.email}</span>
                    </button>
                  ))}
                </div>
              )}
              {addedMembers.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {addedMembers.map(m => (
                    <div key={m.id} className="flex items-center gap-1 bg-white/10 rounded-full px-2 py-0.5 text-xs text-white">
                      {m.name}
                      <button onClick={() => setAddedMembers(prev => prev.filter(a => a.id !== m.id))}>
                        <X className="w-3 h-3 text-muted-foreground hover:text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Guest section — only shown for non-members-only slots */}
          {club && me && bookingSlot && !bookingSlot.isMembersOnly && (
            <div>
              <Label className="text-muted-foreground text-xs mb-1 block">Add a Guest (optional)</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="Guest name"
                  value={guestName}
                  onChange={e => setGuestName(e.target.value)}
                  className="bg-white/5 border-white/10 text-white text-sm flex-1"
                />
                <Input
                  placeholder="Email (optional)"
                  value={guestEmail}
                  onChange={e => setGuestEmail(e.target.value)}
                  className="bg-white/5 border-white/10 text-white text-sm flex-1"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="border-white/20 text-white hover:bg-white/10 shrink-0"
                  onClick={() => {
                    if (!guestName.trim()) return;
                    const maxGuests = teePricing?.maxGuestsPerBooking ?? 3;
                    if (addedGuests.length >= maxGuests) {
                      toast({ title: `Maximum ${maxGuests} guest(s) allowed`, variant: 'destructive' }); return;
                    }
                    setAddedGuests(prev => [...prev, { name: guestName.trim(), email: guestEmail.trim() }]);
                    setGuestName('');
                    setGuestEmail('');
                  }}
                >
                  Add
                </Button>
              </div>
              {addedGuests.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {addedGuests.map((g, i) => (
                    <div key={i} className="flex items-center gap-1 bg-white/10 rounded-full px-2 py-0.5 text-xs text-white">
                      <span>{g.name}</span>
                      {g.email && <span className="text-muted-foreground">({g.email})</span>}
                      <button onClick={() => setAddedGuests(prev => prev.filter((_, idx) => idx !== i))}>
                        <X className="w-3 h-3 text-muted-foreground hover:text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {teePricing && parseFloat(teePricing.memberRate ?? '0') > 0 && (
            <div className="text-xs text-muted-foreground border border-white/10 rounded-lg p-3 space-y-1">
              <div className="flex justify-between"><span>Member rate</span><span className="text-white">₹{parseFloat(teePricing.memberRate!).toLocaleString('en-IN')}/player</span></div>
              {teePricing.guestRate && parseFloat(teePricing.guestRate) > 0 && (
                <div className="flex justify-between"><span>Guest rate</span><span className="text-white">₹{parseFloat(teePricing.guestRate).toLocaleString('en-IN')}/player</span></div>
              )}
              <div className="flex justify-between"><span>Guests added</span><span className="text-white">{addedGuests.length}</span></div>
              <div className="flex justify-between font-medium border-t border-white/10 pt-1 mt-1">
                <span>Est. total</span>
                <span className="text-white">₹{(
                  (parseFloat(teePricing.memberRate ?? '0') * (1 + addedMembers.length)) +
                  (parseFloat(teePricing.guestRate ?? '0') * addedGuests.length)
                ).toLocaleString('en-IN')}</span>
              </div>
              <div className="flex justify-between"><span>Payment</span><span className="text-white capitalize">{teePricing.paymentModel.replace(/_/g, ' ')}</span></div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={resetBookingDialog}>Cancel</Button>
          <Button
            disabled={booking}
            onClick={bookTeeTime}
            className="text-black font-semibold"
            style={{ backgroundColor: primaryColor }}
          >
            {booking ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            Confirm Booking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
