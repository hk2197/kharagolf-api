import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Star, Search, Globe, Award, CalendarPlus, Video, PlayCircle } from 'lucide-react';
import {
  computeVoiceSyncAction,
  parseVoiceOverDurationMs,
  shouldRunVoiceSync,
} from '@workspace/voice-over-sync';

const GOLD = '#C9A84C';

// Task #1211 — mirror the coach delivery canvas (coach-workspace.tsx) so the
// member-facing playback shows the source video's true frame rate. Falls back
// to 30fps for stepping/visibility windows only until the real value is known
// (either seeded from the server or detected via requestVideoFrameCallback).
const DEFAULT_FPS = 30;

interface Coach {
  proId: number;
  organizationId: number;
  organizationName: string | null;
  displayName: string;
  bio: string | null;
  photoUrl: string | null;
  specialisms: string[];
  certifications: string[];
  yearsExperience: number;
  languages: string[];
  hourlyRatePaise: number;
  asyncReviewPricePaise: number;
  acceptsInPerson: boolean;
  acceptsAsync: boolean;
  asyncTurnaroundHours: number;
  ratingsAvg: number;
  ratingsCount: number;
}

const formatRupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

export default function CoachMarketplacePage() {
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'all' | 'in_person' | 'async'>('all');
  const [specialty, setSpecialty] = useState('');
  const [region, setRegion] = useState('');
  const [handicap, setHandicap] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [minRating, setMinRating] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [location, navigate] = useLocation();
  const [requestingPro, setRequestingPro] = useState<Coach | null>(null);

  // Parse ?review=<proId> from URL — open request modal for that coach
  useEffect(() => {
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const sp = new URLSearchParams(search);
    const reviewParam = sp.get('review');
    if (!reviewParam) return;
    const reviewProId = parseInt(reviewParam);
    if (!reviewProId) return;
    // Wait for coaches to load, then pick one
    const target = coaches.find(c => c.proId === reviewProId);
    if (target) setRequestingPro(target);
  }, [coaches, location]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (mode !== 'all') params.set('mode', mode);
    if (specialty) params.set('specialty', specialty);
    if (region) params.set('region', region);
    if (handicap) params.set('handicap', handicap);
    const minRupees = parseFloat(priceMin);
    if (priceMin && Number.isFinite(minRupees) && minRupees >= 0) {
      params.set('priceMin', String(Math.round(minRupees * 100)));
    }
    const maxRupees = parseFloat(priceMax);
    if (priceMax && Number.isFinite(maxRupees) && maxRupees >= 0) {
      params.set('priceMax', String(Math.round(maxRupees * 100)));
    }
    const minRatingNum = parseFloat(minRating);
    if (minRating && Number.isFinite(minRatingNum)) {
      params.set('minRating', String(minRatingNum));
    }
    fetch(`/api/coach-marketplace/coaches?${params.toString()}`)
      .then(r => r.json())
      .then(d => { setCoaches(d.coaches ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [q, mode, specialty, region, handicap, priceMin, priceMax, minRating]);

  // Task #1630 — keep the sidebar copy honest about which price the
  // bracket is filtering on. The API mirrors this mode→price mapping.
  const priceLabels = mode === 'in_person'
    ? { minLabel: 'Min ₹/hour', maxLabel: 'Max ₹/hour', helper: 'Filters by hourly rate' }
    : mode === 'async'
      ? { minLabel: 'Min ₹/review', maxLabel: 'Max ₹/review', helper: 'Filters by async review price' }
      : { minLabel: 'Min ₹', maxLabel: 'Max ₹', helper: 'Filters by hourly or async price' };

  // Task #2021 — translate the active mode + price bracket into a per-card
  // hint about which price column the player is actually browsing, so the
  // marketplace card can emphasize the matched price (and dim the other).
  // Mirrors the server-side mode→price mapping in
  // `artifacts/api-server/src/routes/coach-marketplace.ts` so what the card
  // emphasizes is the same column the API filtered on.
  const priceFilterActive = priceMin !== '' || priceMax !== '';
  const parsedMin = parseFloat(priceMin);
  const parsedMax = parseFloat(priceMax);
  const priceMinPaise = priceMin && Number.isFinite(parsedMin) && parsedMin >= 0
    ? Math.round(parsedMin * 100) : null;
  const priceMaxPaise = priceMax && Number.isFinite(parsedMax) && parsedMax >= 0
    ? Math.round(parsedMax * 100) : null;
  const priceFilterEffective = priceFilterActive && (priceMinPaise != null || priceMaxPaise != null);
  type SideStatus = 'active' | 'dim' | 'neutral';
  const priceSideStatus = (coach: Coach): { inPerson: SideStatus; async: SideStatus } => {
    // Explicit mode toggle wins: the column the player picked is always the
    // active side, the other becomes a dimmed reference price.
    if (mode === 'in_person') return { inPerson: 'active', async: 'dim' };
    if (mode === 'async') return { inPerson: 'dim', async: 'active' };
    // mode === 'all' — only emphasize a side when a price bracket is active.
    if (!priceFilterEffective) return { inPerson: 'neutral', async: 'neutral' };
    const inPersonInBracket = coach.acceptsInPerson
      && (priceMinPaise == null || coach.hourlyRatePaise >= priceMinPaise)
      && (priceMaxPaise == null || coach.hourlyRatePaise <= priceMaxPaise);
    const asyncInBracket = coach.acceptsAsync
      && (priceMinPaise == null || coach.asyncReviewPricePaise >= priceMinPaise)
      && (priceMaxPaise == null || coach.asyncReviewPricePaise <= priceMaxPaise);
    return {
      inPerson: coach.acceptsInPerson ? (inPersonInBracket ? 'active' : 'dim') : 'neutral',
      async: coach.acceptsAsync ? (asyncInBracket ? 'active' : 'dim') : 'neutral',
    };
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-2" style={{ color: GOLD }}>Coach Marketplace</h1>
        <p className="text-zinc-400 mb-6">Find a certified coach for in-person lessons or async swing reviews.</p>

        {/* Task #1211 — surface delivered async-review playback on the web so
            members aren't forced to switch to mobile to watch what their coach
            sent back. */}
        <MyReviewsSection />

        <div className="flex flex-wrap gap-3 mb-6">
          <div className="relative flex-1 min-w-[280px]">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-zinc-500" />
            <Input value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search by coach name…"
              className="pl-9 bg-zinc-900 border-zinc-800 text-white" />
          </div>
          <div className="flex gap-2">
            {(['all', 'in_person', 'async'] as const).map(m => (
              <Button key={m} variant={mode === m ? 'default' : 'outline'}
                onClick={() => setMode(m)}
                style={mode === m ? { backgroundColor: GOLD, color: '#000', borderColor: GOLD } : { borderColor: GOLD, color: GOLD }}>
                {m === 'all' ? 'All' : m === 'in_person' ? 'In-person' : 'Async review'}
              </Button>
            ))}
          </div>
          <Button variant="outline"
            onClick={() => setShowFilters(s => !s)}
            data-testid="button-toggle-filters"
            style={{ borderColor: GOLD, color: GOLD }}>
            {showFilters ? 'Hide filters' : 'More filters'}
          </Button>
        </div>

        {showFilters && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6 p-4 rounded-lg border border-zinc-800 bg-zinc-900/40">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Specialty</label>
              <Input value={specialty} onChange={e => setSpecialty(e.target.value)}
                placeholder="e.g. short_game"
                data-testid="filter-specialty"
                className="bg-zinc-900 border-zinc-800 text-white text-sm" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Region</label>
              <Input value={region} onChange={e => setRegion(e.target.value)}
                placeholder="e.g. Bengaluru"
                data-testid="filter-region"
                className="bg-zinc-900 border-zinc-800 text-white text-sm" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">My handicap</label>
              <Input value={handicap} onChange={e => setHandicap(e.target.value)}
                placeholder="e.g. 18"
                inputMode="decimal"
                data-testid="filter-handicap"
                className="bg-zinc-900 border-zinc-800 text-white text-sm" />
            </div>
            {/* Task #1630 — label what the price filter actually compares
                against based on the in-person/async toggle, since the API
                now applies the bracket to whichever price the coach is
                actually offering rather than always to the async fee. */}
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{priceLabels.minLabel}</label>
              <Input value={priceMin} onChange={e => setPriceMin(e.target.value)}
                placeholder="0"
                inputMode="numeric"
                data-testid="filter-price-min"
                className="bg-zinc-900 border-zinc-800 text-white text-sm" />
              <div className="text-[10px] text-zinc-500 mt-1">{priceLabels.helper}</div>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{priceLabels.maxLabel}</label>
              <Input value={priceMax} onChange={e => setPriceMax(e.target.value)}
                placeholder="any"
                inputMode="numeric"
                data-testid="filter-price-max"
                className="bg-zinc-900 border-zinc-800 text-white text-sm" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Min rating</label>
              <Input value={minRating} onChange={e => setMinRating(e.target.value)}
                placeholder="e.g. 4"
                inputMode="decimal"
                data-testid="filter-min-rating"
                className="bg-zinc-900 border-zinc-800 text-white text-sm" />
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-zinc-500">Loading coaches…</div>
        ) : coaches.length === 0 ? (
          <div className="text-zinc-500 py-20 text-center">No coaches match your filters.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {coaches.map(c => (
              <Card key={c.proId} className="bg-zinc-900 border-zinc-800 p-4">
                <div className="flex gap-3">
                  {c.photoUrl ? (
                    <img src={c.photoUrl} alt={c.displayName} className="w-16 h-16 rounded-full object-cover" />
                  ) : (
                    <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center" style={{ color: GOLD }}>
                      {c.displayName.slice(0, 1)}
                    </div>
                  )}
                  <div className="flex-1">
                    <div className="font-semibold text-white">{c.displayName}</div>
                    <div className="text-xs text-zinc-400">{c.organizationName ?? ''}</div>
                    <div className="flex items-center gap-1 mt-1 text-xs text-zinc-300">
                      <Star className="w-3 h-3 fill-current" style={{ color: GOLD }} />
                      {c.ratingsAvg.toFixed(1)} ({c.ratingsCount}) · {c.yearsExperience}y exp
                    </div>
                  </div>
                </div>
                {c.bio && <p className="text-sm text-zinc-400 mt-3 line-clamp-3">{c.bio}</p>}
                <div className="flex flex-wrap gap-1 mt-3">
                  {c.specialisms.slice(0, 3).map(s => (
                    <Badge key={s} variant="outline" className="text-xs" style={{ borderColor: GOLD + '60', color: GOLD }}>{s}</Badge>
                  ))}
                </div>
                {c.certifications.length > 0 && (
                  <div className="flex items-center gap-1 mt-2 text-xs text-zinc-400">
                    <Award className="w-3 h-3" />
                    {c.certifications.slice(0, 2).join(' · ')}
                  </div>
                )}
                {c.languages.length > 0 && (
                  <div className="flex items-center gap-1 mt-1 text-xs text-zinc-500">
                    <Globe className="w-3 h-3" /> {c.languages.join(', ')}
                  </div>
                )}
                {/* Task #2021 — emphasize whichever price the active mode +
                    price bracket actually matches against, and dim the
                    other side. When the player hasn't chosen a mode and
                    has no price filter, both sides render neutrally. */}
                {(() => {
                  const status = priceSideStatus(c);
                  const sideClass = (s: SideStatus) =>
                    s === 'active'
                      ? 'rounded px-2 py-1 -mx-2 bg-amber-400/10 ring-1 ring-amber-400/30'
                      : s === 'dim'
                        ? 'rounded px-2 py-1 -mx-2 opacity-40'
                        : '';
                  const showMatchedBadge = priceFilterEffective;
                  return (
                    <div className="grid grid-cols-2 gap-2 mt-4 pt-4 border-t border-zinc-800">
                      {c.acceptsAsync && (
                        <div
                          className={sideClass(status.async)}
                          data-testid={`coach-${c.proId}-price-async`}
                          data-side-status={status.async}
                        >
                          <div className="text-xs text-zinc-500 flex items-center gap-1 flex-wrap">
                            <span>Async review</span>
                            {status.async === 'active' && showMatchedBadge && (
                              <Badge
                                variant="outline"
                                className="text-[9px] leading-none px-1 py-0.5 h-auto"
                                style={{ borderColor: GOLD, color: GOLD }}
                                data-testid={`coach-${c.proId}-async-matches-badge`}
                              >
                                Matches filter
                              </Badge>
                            )}
                          </div>
                          <div className="font-semibold" style={{ color: GOLD }}>{formatRupees(c.asyncReviewPricePaise)}</div>
                          <div className="text-xs text-zinc-500">~{c.asyncTurnaroundHours}h</div>
                        </div>
                      )}
                      {c.acceptsInPerson && (
                        <div
                          className={sideClass(status.inPerson)}
                          data-testid={`coach-${c.proId}-price-in-person`}
                          data-side-status={status.inPerson}
                        >
                          <div className="text-xs text-zinc-500 flex items-center gap-1 flex-wrap">
                            <span>In-person / online</span>
                            {status.inPerson === 'active' && showMatchedBadge && (
                              <Badge
                                variant="outline"
                                className="text-[9px] leading-none px-1 py-0.5 h-auto"
                                style={{ borderColor: GOLD, color: GOLD }}
                                data-testid={`coach-${c.proId}-in-person-matches-badge`}
                              >
                                Matches filter
                              </Badge>
                            )}
                          </div>
                          <div className="font-semibold" style={{ color: GOLD }}>{formatRupees(c.hourlyRatePaise)}/hr</div>
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div className="grid grid-cols-1 gap-2 mt-3">
                  {c.acceptsInPerson && (
                    <Button size="sm" onClick={() => navigate(`/lessons?proId=${c.proId}`)}
                      style={{ backgroundColor: GOLD, color: '#000' }}>
                      <CalendarPlus className="w-4 h-4 mr-2" /> Book in-person / online lesson
                    </Button>
                  )}
                  {c.acceptsAsync && (
                    <Button size="sm" variant="outline"
                      onClick={() => navigate(`/coach-marketplace?review=${c.proId}`)}
                      style={{ borderColor: GOLD, color: GOLD }}>
                      <Video className="w-4 h-4 mr-2" /> Request async swing review
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
      {requestingPro && (
        <RequestReviewModal coach={requestingPro}
          onClose={() => { setRequestingPro(null); navigate('/coach-marketplace'); }} />
      )}
    </div>
  );
}

interface MySwingVideo { id: number; title: string | null; videoUrl: string; capturedAt: string }

function RequestReviewModal({ coach, onClose }: { coach: Coach; onClose: () => void }) {
  const [videos, setVideos] = useState<MySwingVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetch('/api/swing-videos', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setVideos(d.swingVideos ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const loadRzp = (): Promise<boolean> => new Promise(res => {
    if (window.Razorpay) return res(true);
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => res(true);
    s.onerror = () => res(false);
    document.body.appendChild(s);
  });

  const submit = async () => {
    if (!selectedId) { toast({ title: 'Select a swing video', variant: 'destructive' }); return; }
    setSubmitting(true);
    try {
      const r = await fetch('/api/swing-reviews/requests', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proId: coach.proId, swingVideoId: selectedId, memberPrompt: prompt }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? 'Request failed');
      const rzpOk = await loadRzp();
      const RzpCtor = (window as unknown as { Razorpay?: new (o: Record<string, unknown>) => { open(): void } }).Razorpay;
      if (!rzpOk || !RzpCtor) throw new Error('Payment SDK unavailable');
      const order = data.razorpayOrder;
      const rzp = new RzpCtor({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: 'KharaGolf swing review',
        description: `Async review by ${coach.displayName}`,
        handler: async (resp: any) => {
          const v = await fetch(`/api/swing-reviews/requests/${data.request.id}/payment/verify`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              razorpayOrderId: resp.razorpay_order_id,
              razorpayPaymentId: resp.razorpay_payment_id,
              razorpaySignature: resp.razorpay_signature,
            }),
          });
          const vd = await v.json();
          if (vd.success) { toast({ title: 'Review request paid' }); onClose(); }
          else toast({ title: 'Payment verification failed', variant: 'destructive' });
        },
      });
      rzp.open();
    } catch (e: any) {
      toast({ title: 'Could not create request', description: String(e?.message ?? e), variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <Card className="bg-zinc-900 border-zinc-800 p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold" style={{ color: GOLD }}>Request a swing review</h2>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <div className="text-sm text-zinc-300 mb-2">
          Coach: <span className="font-semibold">{coach.displayName}</span>
        </div>
        <div className="text-sm mb-4" style={{ color: GOLD }}>
          {(coach.asyncReviewPricePaise / 100).toFixed(0)} INR · ~{coach.asyncTurnaroundHours}h turnaround
        </div>
        <label className="text-sm font-semibold block mb-1" style={{ color: GOLD }}>Pick a swing video</label>
        {loading ? <div className="text-zinc-500 text-sm">Loading…</div>
          : videos.length === 0 ? <div className="text-zinc-500 text-sm py-3">
              You have no swing videos yet. Capture one in the mobile app first.
            </div>
          : <div className="space-y-2 max-h-48 overflow-y-auto mb-3">
              {videos.map(v => (
                <button key={v.id} type="button" onClick={() => setSelectedId(v.id)}
                  className={`w-full text-left p-2 rounded border ${selectedId === v.id ? 'border-amber-400 bg-amber-400/10' : 'border-zinc-700 bg-zinc-800'}`}>
                  <div className="text-sm text-white">{v.title ?? `Swing #${v.id}`}</div>
                  <div className="text-xs text-zinc-400">{new Date(v.capturedAt).toLocaleString()}</div>
                </button>
              ))}
            </div>}
        <label className="text-sm font-semibold block mb-1" style={{ color: GOLD }}>What do you want feedback on?</label>
        <Textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
          placeholder="e.g. Why am I slicing my driver?"
          className="bg-zinc-800 border-zinc-700 text-white mb-3" />
        <Button onClick={submit} disabled={submitting || !selectedId}
          style={{ backgroundColor: GOLD, color: '#000' }}>
          {submitting ? 'Submitting…' : 'Pay & submit request'}
        </Button>
      </Card>
    </div>
  );
}

/* ─── Task #1211 — Member async-review playback on the web ─────────── */

interface MyReviewListItem {
  request: {
    id: number;
    proId: number;
    status: string;
    pricePaise: number;
    createdAt: string;
    deliveredAt: string | null;
    rating: number | null;
    annotationId: number | null;
  };
  proName: string;
  proPhoto: string | null;
  videoUrl: string;
  videoThumb: string | null;
  videoFps: number | string | null;
}

const REVIEW_STATUS_LABELS: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  paid: 'Paid — in queue',
  in_review: 'Coach reviewing',
  delivered: 'Delivered',
  refunded: 'Refunded',
  expired: 'Expired',
};

function MyReviewsSection() {
  const [items, setItems] = useState<MyReviewListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<number | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/swing-reviews/my-requests', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { requests: [] })
      .then(d => {
        if (cancelled) return;
        setItems(Array.isArray(d.requests) ? d.requests : []);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  if (loading) return null;
  if (items.length === 0) return null;

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-4 mb-6" data-testid="my-reviews-section">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold" style={{ color: GOLD }}>My swing reviews</h2>
        <span className="text-xs text-zinc-500">{items.length} total</span>
      </div>
      <div className="space-y-2">
        {items.map(item => {
          const delivered = item.request.status === 'delivered';
          return (
            <div key={item.request.id}
              className="flex items-center gap-3 p-2 rounded border border-zinc-800 bg-zinc-950"
              data-testid={`my-review-row-${item.request.id}`}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-white truncate">{item.proName}</div>
                <div className="text-xs text-zinc-400">
                  {REVIEW_STATUS_LABELS[item.request.status] ?? item.request.status}
                  {' · '}
                  {new Date(item.request.createdAt).toLocaleDateString()}
                </div>
                {item.request.rating != null && (
                  <div
                    className="text-xs mt-0.5"
                    style={{ color: GOLD }}
                    data-testid={`my-review-rating-${item.request.id}`}
                  >
                    You rated: {'★'.repeat(item.request.rating)}
                  </div>
                )}
              </div>
              {delivered ? (
                <Button size="sm"
                  data-testid={`button-play-review-${item.request.id}`}
                  onClick={() => setViewing(item.request.id)}
                  style={{ backgroundColor: GOLD, color: '#000' }}>
                  <PlayCircle className="w-4 h-4 mr-1" /> Play review
                </Button>
              ) : (
                <Badge variant="outline" className="text-xs"
                  style={{ borderColor: GOLD + '60', color: GOLD }}>
                  {REVIEW_STATUS_LABELS[item.request.status] ?? item.request.status}
                </Badge>
              )}
            </div>
          );
        })}
      </div>
      {viewing != null && (
        <ReviewPlaybackModal
          id={viewing}
          onClose={() => setViewing(null)}
          onRated={() => { load(); }}
        />
      )}
    </Card>
  );
}

interface ReviewDrawShape {
  kind: 'line' | 'arrow' | 'circle' | 'angle';
  t: number;
  color: string;
  x1?: number; y1?: number; x2?: number; y2?: number;
  x?: number; y?: number; r?: number;
  ax?: number; ay?: number; bx?: number; by?: number; cx?: number; cy?: number;
}

interface ReviewDetail {
  request: {
    id: number;
    status: string;
    rating: number | null;
    ratingComment: string | null;
    annotationId: number | null;
    deliveredAt: string | null;
    memberPrompt: string | null;
  };
  video: { id: number; videoUrl: string; fps: number | string | null } | null;
  annotation: {
    id: number;
    drawings: ReviewDrawShape[] | null;
    voiceOverUrl: string | null;
    voiceOverDurationSeconds: number | string | null;
    textNotes: string | null;
  } | null;
  pro: { id: number; displayName: string; photoUrl: string | null } | null;
}

function ReviewPlaybackModal({ id, onClose, onRated }: { id: number; onClose: () => void; onRated?: () => void }) {
  const [data, setData] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState({ w: 0, h: 0 });
  const [videoTime, setVideoTime] = useState(0);
  // Task #1409 — track the source video's duration so the read-only marker
  // strip beneath the video (mirroring mobile's RequestDetailModalInner) can
  // place each drawing marker proportionally and render a playhead.
  const [videoDuration, setVideoDuration] = useState(0);
  // Task #1399 — mirror the mobile rating flow
  // (artifacts/kharagolf-mobile/app/(tabs)/coach.tsx → RequestDetailModalInner).
  // Members can submit a 1–5 star rating + optional comment after watching a
  // delivered review. POST /api/swing-reviews/requests/:id/rate enforces that
  // the rating can only be submitted once.
  const { toast } = useToast();
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [ratingComment, setRatingComment] = useState('');
  const [submittingRating, setSubmittingRating] = useState(false);

  // Mirror coach-workspace.tsx: seed fps from the server's persisted value,
  // then refine with requestVideoFrameCallback. Note: we do NOT POST detected
  // values back from this member-facing modal — the persistence endpoint
  // (POST /api/swing-reviews/requests/:id/swing-video-fps) is coach-only and
  // would 403 for the requesting member. The detected value still benefits
  // the current playback session.
  const initialFps = (() => {
    const f = Number(data?.video?.fps);
    return Number.isFinite(f) && f > 0 ? f : null;
  })();
  const [detectedFps, setDetectedFps] = useState<number | null>(initialFps);
  const fpsSamplesRef = useRef<number[]>([]);
  const lastFrameMediaTimeRef = useRef<number | null>(null);
  const fpsRvfcHandleRef = useRef<number | null>(null);
  const fpsForVisibility = detectedFps ?? DEFAULT_FPS;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/swing-reviews/requests/${id}`, { credentials: 'include' })
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error ?? 'Failed to load review');
        return body as ReviewDetail;
      })
      .then(d => {
        if (cancelled) return;
        setData(d);
        const f = Number(d?.video?.fps);
        if (Number.isFinite(f) && f > 0) setDetectedFps(f);
      })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [id]);

  const scheduleFpsProbe = useCallback(() => {
    const v = videoRef.current as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, metadata: { mediaTime: number; presentedFrames: number }) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    }) | null;
    if (!v || typeof v.requestVideoFrameCallback !== 'function') return;
    if (fpsRvfcHandleRef.current != null) return;
    if (detectedFps != null) return;
    const onFrame = (_now: number, metadata: { mediaTime: number; presentedFrames: number }) => {
      const last = lastFrameMediaTimeRef.current;
      if (last != null) {
        const dt = metadata.mediaTime - last;
        if (dt > 1 / 1000 && dt < 1 / 10) {
          fpsSamplesRef.current.push(dt);
          if (fpsSamplesRef.current.length >= 12) {
            const sorted = [...fpsSamplesRef.current].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            const fps = 1 / median;
            const common = [24, 25, 30, 50, 60, 90, 120, 240];
            const snapped = common.find(c => Math.abs(c - fps) / c < 0.04) ?? Math.round(fps * 100) / 100;
            setDetectedFps(snapped);
            fpsSamplesRef.current = [];
            return;
          }
        }
      }
      lastFrameMediaTimeRef.current = metadata.mediaTime;
      fpsRvfcHandleRef.current = v.requestVideoFrameCallback!(onFrame);
    };
    fpsRvfcHandleRef.current = v.requestVideoFrameCallback!(onFrame);
  }, [detectedFps]);

  useEffect(() => {
    return () => {
      const v = videoRef.current as (HTMLVideoElement & {
        cancelVideoFrameCallback?: (h: number) => void;
      }) | null;
      const h = fpsRvfcHandleRef.current;
      if (v && h != null && typeof v.cancelVideoFrameCallback === 'function') {
        v.cancelVideoFrameCallback(h);
      }
    };
  }, []);

  // Voice-over duration cap (milliseconds). When the video plays past this,
  // the voice-over should stop cleanly instead of looping or trailing on.
  const voiceDurationMs = parseVoiceOverDurationMs(
    data?.annotation?.voiceOverDurationSeconds,
  );

  // Keep a separate <audio> element for the voice-over and sync it to the
  // video. The drift-correction rules (throttle to 100 ms, only re-seek when
  // drift exceeds 250 ms, mirror playback rate, stop cleanly past the
  // voice-over duration) live in the shared `@workspace/voice-over-sync`
  // package so this code path and the mobile coach screen
  // (artifacts/kharagolf-mobile/app/(tabs)/coach.tsx → syncVoiceToVideo)
  // can never drift apart again.
  useEffect(() => {
    const v = videoRef.current; const a = audioRef.current;
    if (!v || !a) return;
    let lastSyncAt = 0;
    let syncing = false;
    const sync = (force: boolean) => {
      if (syncing) return;
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (!shouldRunVoiceSync(lastSyncAt, now, force)) return;
      lastSyncAt = now;
      syncing = true;
      try {
        const decision = computeVoiceSyncAction({
          videoPosMs: v.currentTime * 1000,
          audioPosMs: a.currentTime * 1000,
          videoIsPlaying: !v.paused && !v.ended,
          rate: v.playbackRate,
          capMs: voiceDurationMs,
        });
        try { if (a.playbackRate !== decision.rate) a.playbackRate = decision.rate; } catch { /* ignore */ }
        if (decision.seekToMs != null) {
          a.currentTime = decision.seekToMs / 1000;
        }
        if (decision.shouldPause && !a.paused) {
          a.pause();
        }
        if (decision.shouldPlay && a.paused) {
          a.play().catch(() => { /* autoplay/race — ignore */ });
        }
      } finally {
        syncing = false;
      }
    };
    const onPlay = () => sync(true);
    const onPause = () => { a.pause(); };
    const onSeek = () => sync(true);
    const onEnded = () => { a.pause(); };
    const onTime = () => sync(false);
    const onRate = () => {
      try { a.playbackRate = v.playbackRate; } catch { /* ignore */ }
      sync(true);
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeek);
    v.addEventListener('ended', onEnded);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('ratechange', onRate);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeek);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('ratechange', onRate);
    };
  }, [data, voiceDurationMs]);

  const onLoadedMetadata = () => {
    scheduleFpsProbe();
    const o = overlayRef.current;
    if (o) setOverlay({ w: o.clientWidth, h: o.clientHeight });
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration) && v.duration > 0) {
      setVideoDuration(v.duration);
    }
  };

  const onTimeUpdate = () => {
    const v = videoRef.current; if (!v) return;
    setVideoTime(v.currentTime);
    // Some browsers (and some HLS streams) only report a stable duration
    // after metadata + first frames; refresh on timeupdate so the marker
    // strip can position itself if onLoadedMetadata fired with NaN.
    if (videoDuration === 0 && Number.isFinite(v.duration) && v.duration > 0) {
      setVideoDuration(v.duration);
    }
  };

  const seekToDrawing = (t: number) => {
    const v = videoRef.current; if (!v) return;
    if (!Number.isFinite(t) || t < 0) return;
    const cap = videoDuration > 0 ? videoDuration : (Number.isFinite(v.duration) ? v.duration : t);
    const target = Math.max(0, Math.min(cap, t));
    try { v.currentTime = target; } catch { /* ignore */ }
    setVideoTime(target);
  };

  const drawings: ReviewDrawShape[] = Array.isArray(data?.annotation?.drawings)
    ? (data!.annotation!.drawings as ReviewDrawShape[])
    : [];
  const visibilityWindow = 0.5 / fpsForVisibility;
  const visibleShapes = drawings.filter(s => Math.abs(s.t - videoTime) <= visibilityWindow);
  const voiceUrl = data?.annotation?.voiceOverUrl ?? null;

  return (
    <div className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4"
      data-testid="review-playback-modal"
      role="dialog"
      aria-label="Swing review playback">
      <Card className="bg-zinc-900 border-zinc-800 p-6 max-w-3xl w-full max-h-[92vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-xl font-bold" style={{ color: GOLD }}>Swing review</h2>
            {data?.pro && <div className="text-sm text-zinc-400">Coach: {data.pro.displayName}</div>}
          </div>
          <Button variant="ghost" onClick={onClose} data-testid="button-close-review">Close</Button>
        </div>

        {error && <div className="text-red-400 text-sm mb-4">{error}</div>}
        {!data && !error && <div className="text-zinc-500 text-sm">Loading review…</div>}

        {data?.video && (
          <div className="space-y-2">
            <div ref={overlayRef} className="relative bg-black">
              <video
                ref={videoRef}
                src={data.video.videoUrl}
                controls
                playsInline
                crossOrigin="anonymous"
                preload="metadata"
                onLoadedMetadata={onLoadedMetadata}
                onTimeUpdate={onTimeUpdate}
                className="w-full max-h-[420px] bg-black"
                data-testid="review-video"
              />
              {drawings.length > 0 && overlay.w > 0 && (
                <svg
                  className="absolute inset-0 pointer-events-none"
                  width={overlay.w}
                  height={overlay.h}
                  viewBox={`0 0 ${overlay.w} ${overlay.h}`}
                >
                  {visibleShapes.map((s, i) => <ReviewShapeSvg key={i} shape={s} />)}
                </svg>
              )}
            </div>

            {/* Task #1409 — read-only timeline marker strip mirroring the
                mobile RequestDetailModalInner. One marker per drawing,
                positioned proportionally along the video duration. Click
                a marker to seek to that drawing's timestamp. Renders only
                when there's at least one drawing — empty reviews hide it
                to avoid an empty grey bar under the video. */}
            {drawings.length > 0 && (
              <div
                className="relative w-full h-6 mt-1 bg-zinc-800 rounded"
                aria-label="Drawing timeline"
                data-testid="review-drawing-timeline-strip"
              >
                {videoDuration > 0 && drawings.map((s, i) => {
                  if (!Number.isFinite(s.t) || s.t < 0) return null;
                  const ratio = Math.max(0, Math.min(1, s.t / videoDuration));
                  return (
                    <button
                      key={i}
                      type="button"
                      aria-label={`Drawing ${i + 1} at ${s.t.toFixed(2)} seconds. Click to jump.`}
                      title={`Drawing #${i + 1} at ${s.t.toFixed(2)}s — click to jump`}
                      data-testid={`review-drawing-marker-${i}`}
                      onClick={() => seekToDrawing(s.t)}
                      className="absolute top-0 cursor-pointer p-0"
                      style={{
                        left: `${ratio * 100}%`,
                        transform: 'translateX(-50%)',
                        width: 10,
                        height: '100%',
                        background: s.color || GOLD,
                        borderRadius: 3,
                        border: '1px solid rgba(0,0,0,0.6)',
                      }}
                    />
                  );
                })}
                {videoDuration > 0 && (
                  <div
                    aria-hidden
                    className="absolute top-0 bottom-0 w-px bg-yellow-500/70 pointer-events-none"
                    style={{ left: `${Math.max(0, Math.min(1, videoTime / videoDuration)) * 100}%` }}
                  />
                )}
              </div>
            )}

            {/* Task #1211 — fps label, mirroring coach-workspace.tsx so members
                see the same "{N}fps" / "detecting…" indicator next to the
                playback controls. */}
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span
                className="font-mono"
                data-testid="review-video-fps"
                title={detectedFps != null
                  ? `Detected source frame rate: ${detectedFps}fps`
                  : 'Detecting source frame rate…'}
              >
                {detectedFps != null ? `${Math.round(detectedFps)}fps` : 'detecting…'}
              </span>
              {drawings.length > 0 && (
                <span className="ml-2 text-zinc-500">
                  {drawings.length} drawing{drawings.length === 1 ? '' : 's'} synced to the video
                </span>
              )}
            </div>

            {voiceUrl && (
              <div className="mt-2">
                <div className="text-xs text-zinc-500 mb-1">Coach voice-over (plays with the video)</div>
                <audio
                  ref={audioRef}
                  src={voiceUrl}
                  preload="metadata"
                  controls
                  className="w-full"
                  data-testid="review-voiceover"
                />
              </div>
            )}

            {data.annotation?.textNotes && (
              <div className="mt-3 p-3 rounded bg-zinc-950 border border-zinc-800">
                <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">Coach notes</div>
                <div className="text-sm text-zinc-200 whitespace-pre-wrap">{data.annotation.textNotes}</div>
              </div>
            )}
          </div>
        )}

        {/* Task #1695 — once a delivered review has been rated, replace the
            prompt with a read-only summary of what the member submitted so
            reopening the modal shows the rating + comment instead of empty
            space. Mirrors the mobile RequestDetailModalInner treatment. */}
        {data?.request.status === 'delivered' && data.request.rating != null && (
          <div
            className="mt-6 p-4 rounded border border-zinc-800 bg-zinc-950"
            data-testid="review-rating-summary"
          >
            <div className="text-sm font-semibold mb-2" style={{ color: GOLD }}>
              You rated this review
            </div>
            <div
              className="flex gap-1 mb-2"
              role="img"
              aria-label={`You rated ${data.request.rating} out of 5 stars`}
              data-testid="review-rating-summary-stars"
            >
              {[1, 2, 3, 4, 5].map(n => {
                const filled = n <= (data.request.rating ?? 0);
                return (
                  <Star
                    key={n}
                    className="w-6 h-6"
                    style={{
                      color: filled ? GOLD : '#444',
                      fill: filled ? GOLD : 'transparent',
                    }}
                  />
                );
              })}
            </div>
            {data.request.ratingComment && (
              <div
                className="text-sm text-zinc-300 italic whitespace-pre-wrap"
                data-testid="review-rating-summary-comment"
              >
                &ldquo;{data.request.ratingComment}&rdquo;
              </div>
            )}
          </div>
        )}

        {/* Task #1399 — rating prompt; mirrors mobile RequestDetailModalInner.
            Only shown when the review has been delivered and the member has
            not rated it yet. Once data.request.rating is set (either from a
            previous rating or after submitting), the prompt disappears and the
            read-only summary above takes its place (Task #1695). */}
        {data?.request.status === 'delivered' && data.request.rating == null && (
          <div
            className="mt-6 p-4 rounded border border-zinc-800 bg-zinc-950"
            data-testid="review-rating-form"
          >
            <div className="text-sm font-semibold mb-2" style={{ color: GOLD }}>
              Rate this review
            </div>
            <div className="flex gap-1 mb-3" role="radiogroup" aria-label="Star rating">
              {[1, 2, 3, 4, 5].map(n => {
                const filled = n <= (hoverRating || rating);
                return (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={rating === n}
                    aria-label={`${n} star${n === 1 ? '' : 's'}`}
                    data-testid={`button-rate-star-${n}`}
                    onClick={() => setRating(n)}
                    onMouseEnter={() => setHoverRating(n)}
                    onMouseLeave={() => setHoverRating(0)}
                    className="p-1"
                  >
                    <Star
                      className="w-7 h-7"
                      style={{
                        color: filled ? GOLD : '#444',
                        fill: filled ? GOLD : 'transparent',
                      }}
                    />
                  </button>
                );
              })}
            </div>
            <Textarea
              placeholder="Comment (optional)"
              value={ratingComment}
              onChange={e => setRatingComment(e.target.value)}
              rows={3}
              className="bg-zinc-900 border-zinc-700 text-white"
              data-testid="input-rating-comment"
            />
            <Button
              className="mt-3"
              disabled={rating === 0 || submittingRating}
              data-testid="button-submit-rating"
              onClick={async () => {
                if (rating === 0 || submittingRating) return;
                setSubmittingRating(true);
                try {
                  const r = await fetch(`/api/swing-reviews/requests/${id}/rate`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rating, comment: ratingComment }),
                  });
                  const body = await r.json().catch(() => ({}));
                  if (!r.ok) throw new Error(body?.error ?? 'Failed to submit rating');
                  // Reflect the new rating locally so the prompt disappears
                  // before the modal closes (and in case the member keeps it
                  // open). Mirrors the mobile flow which then closes & reloads.
                  // Also persist the comment so the read-only "You rated…"
                  // summary (Task #1695) shows the just-submitted text.
                  setData(prev => prev ? { ...prev, request: { ...prev.request, rating, ratingComment: ratingComment || null } } : prev);
                  toast({ title: 'Thanks', description: 'Your rating has been recorded.' });
                  onRated?.();
                  onClose();
                } catch (e: unknown) {
                  const msg = e instanceof Error ? e.message : String(e);
                  toast({ title: 'Could not submit rating', description: msg, variant: 'destructive' });
                } finally {
                  setSubmittingRating(false);
                }
              }}
              style={{ backgroundColor: GOLD, color: '#000' }}
            >
              {submittingRating ? 'Submitting…' : 'Submit Rating'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function ReviewShapeSvg({ shape }: { shape: ReviewDrawShape }) {
  const stroke = shape.color || GOLD;
  if (shape.kind === 'line' && shape.x1 != null && shape.x2 != null) {
    return <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={stroke} strokeWidth={3} />;
  }
  if (shape.kind === 'arrow' && shape.x1 != null && shape.x2 != null) {
    const dx = (shape.x2 ?? 0) - (shape.x1 ?? 0);
    const dy = (shape.y2 ?? 0) - (shape.y1 ?? 0);
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len, uy = dy / len;
    const head = 12;
    const px = -uy, py = ux;
    const ax = (shape.x2 ?? 0) - ux * head + px * (head / 2);
    const ay = (shape.y2 ?? 0) - uy * head + py * (head / 2);
    const bx = (shape.x2 ?? 0) - ux * head - px * (head / 2);
    const by = (shape.y2 ?? 0) - uy * head - py * (head / 2);
    return (
      <g>
        <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={stroke} strokeWidth={3} />
        <path d={`M${shape.x2},${shape.y2} L${ax},${ay} L${bx},${by} Z`} fill={stroke} />
      </g>
    );
  }
  if (shape.kind === 'circle' && shape.x != null && shape.r != null) {
    return <circle cx={shape.x} cy={shape.y} r={shape.r} stroke={stroke} strokeWidth={3} fill="none" />;
  }
  if (shape.kind === 'angle' && shape.ax != null) {
    return (
      <polyline
        points={`${shape.ax},${shape.ay} ${shape.bx},${shape.by} ${shape.cx},${shape.cy}`}
        stroke={stroke}
        strokeWidth={3}
        fill="none"
      />
    );
  }
  return null;
}
