import { useState, useEffect } from 'react';
import {
  CalendarDays, Plus, ChevronLeft, ChevronRight, Building2, UtensilsCrossed,
  FileText, CheckCircle2, Clock, X, Pencil, Trash2, Mail, DollarSign,
  Users, MapPin, RefreshCw, ArrowLeft, ChevronDown, ChevronUp, Send,
  ClipboardList, AlertCircle, Phone, Briefcase, Star,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
function apiUrl(path: string) { return `${BASE}/api${path}`; }

type EnquiryStatus = 'enquiry' | 'quote_sent' | 'confirmed' | 'invoiced' | 'paid' | 'cancelled';
type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';
type SpaceLayout = 'theatre' | 'classroom' | 'banquet' | 'cabaret' | 'boardroom' | 'cocktail' | 'u_shape' | 'hollow_square';

interface FunctionSpace {
  id: number;
  name: string;
  description: string | null;
  capacitySeated: number | null;
  capacityStanding: number | null;
  facilities: string[];
  avEquipment: string[];
  basePricePerDay: string | null;
  currency: string;
  photoUrls: string[];
  isActive: boolean;
  sortOrder: number;
}

interface CateringPackage {
  id: number;
  name: string;
  description: string | null;
  pricePerHead: string;
  currency: string;
  menuItems: { category: string; items: string[] }[];
  inclusions: string[];
  minimumGuests: number | null;
  isActive: boolean;
}

interface EventBooking {
  id: number;
  status: EnquiryStatus;
  eventName: string;
  eventType: string | null;
  eventDate: string;
  startTime: string | null;
  endTime: string | null;
  organiserName: string;
  organiserEmail: string;
  organiserPhone: string | null;
  organiserCompany: string | null;
  expectedGuests: number | null;
  finalGuestCount: number | null;
  layout: SpaceLayout | null;
  totalAmount: string | null;
  currency: string;
  depositPaid: boolean;
  functionSpaceId: number | null;
  spaceName: string | null;
  cateringPackageId: number | null;
  packageName: string | null;
  assignedToUserId: number | null;
  assignedToName: string | null;
  createdAt: string;
  cateringNotes?: string | null;
  avRequirements?: string | null;
  specialRequirements?: string | null;
  spaceHireAmount?: string | null;
  cateringAmount?: string | null;
  extras?: { description: string; amount: number }[];
  depositAmount?: string | null;
  internalNotes?: string | null;
}

interface EventInvoice {
  id: number;
  invoiceNumber: string;
  status: InvoiceStatus;
  lineItems: { description: string; quantity: number; unitPrice: number; total: number }[];
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  totalAmount: string;
  currency: string;
  dueDate: string | null;
  paidAt: string | null;
  notes: string | null;
  sentAt: string | null;
}

const STATUS_CONFIG: Record<EnquiryStatus, { label: string; color: string; bgColor: string }> = {
  enquiry:    { label: 'Enquiry',    color: 'text-blue-400',   bgColor: 'bg-blue-500/20 border-blue-500/30' },
  quote_sent: { label: 'Quote Sent', color: 'text-amber-400',  bgColor: 'bg-amber-500/20 border-amber-500/30' },
  confirmed:  { label: 'Confirmed',  color: 'text-green-400',  bgColor: 'bg-green-500/20 border-green-500/30' },
  invoiced:   { label: 'Invoiced',   color: 'text-purple-400', bgColor: 'bg-purple-500/20 border-purple-500/30' },
  paid:       { label: 'Paid',       color: 'text-emerald-400',bgColor: 'bg-emerald-500/20 border-emerald-500/30' },
  cancelled:  { label: 'Cancelled',  color: 'text-red-400',    bgColor: 'bg-red-500/20 border-red-500/30' },
};

const PIPELINE_STATUSES: EnquiryStatus[] = ['enquiry', 'quote_sent', 'confirmed', 'invoiced', 'paid'];
const EVENT_TYPES = ['Corporate Day', 'Wedding', 'Award Dinner', 'Society Event', 'Member Function', 'Birthday', 'Conference', 'Product Launch', 'Fundraiser', 'Other'];
const LAYOUTS: SpaceLayout[] = ['theatre', 'classroom', 'banquet', 'cabaret', 'boardroom', 'cocktail', 'u_shape', 'hollow_square'];

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatCurrency(amount: string | null, currency = 'INR') {
  if (!amount) return '—';
  return `${currency} ${parseFloat(amount).toLocaleString('en-IN', { minimumFractionDigits: 0 })}`;
}

export default function EventsPage() {
  const { data: user } = useGetMe();
  const { toast } = useToast();
  const orgId = user?.organizationId;

  const [view, setView] = useState<'pipeline' | 'calendar' | 'spaces' | 'catering'>('pipeline');
  const [bookings, setBookings] = useState<EventBooking[]>([]);
  const [spaces, setSpaces] = useState<FunctionSpace[]>([]);
  const [cateringPackages, setCateringPackages] = useState<CateringPackage[]>([]);
  const [loading, setLoading] = useState(false);

  // Pipeline
  const [statusFilter, setStatusFilter] = useState<EnquiryStatus | ''>('');
  const [searchQ, setSearchQ] = useState('');
  const [selectedBooking, setSelectedBooking] = useState<EventBooking | null>(null);
  const [bookingDetail, setBookingDetail] = useState<{ booking: EventBooking; space: FunctionSpace | null; cateringPackage: CateringPackage | null; invoice: EventInvoice | null } | null>(null);

  // Calendar
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth() + 1);
  const [calBookings, setCalBookings] = useState<EventBooking[]>([]);

  // Modals
  const [showBookingForm, setShowBookingForm] = useState(false);
  const [showSpaceForm, setShowSpaceForm] = useState(false);
  const [showCateringForm, setShowCateringForm] = useState(false);
  const [showInvoiceForm, setShowInvoiceForm] = useState(false);
  const [editingSpace, setEditingSpace] = useState<FunctionSpace | null>(null);
  const [editingCatering, setEditingCatering] = useState<CateringPackage | null>(null);

  const fetchBookings = async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (searchQ) params.set('search', searchQ);
      const r = await fetch(apiUrl(`/organizations/${orgId}/events/bookings?${params}`), { credentials: 'include' });
      const d = await r.json();
      setBookings(d.bookings ?? []);
    } finally { setLoading(false); }
  };

  const fetchSpaces = async () => {
    if (!orgId) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/events/spaces`), { credentials: 'include' });
    const d = await r.json();
    setSpaces(d.spaces ?? []);
  };

  const fetchCatering = async () => {
    if (!orgId) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/events/catering-packages`), { credentials: 'include' });
    const d = await r.json();
    setCateringPackages(d.packages ?? []);
  };

  const fetchCalendar = async () => {
    if (!orgId) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/events/calendar?year=${calYear}&month=${calMonth}`), { credentials: 'include' });
    const d = await r.json();
    setCalBookings(d.bookings ?? []);
  };

  const fetchBookingDetail = async (id: number) => {
    if (!orgId) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/events/bookings/${id}`), { credentials: 'include' });
    const d = await r.json();
    setBookingDetail(d);
    setSelectedBooking(d.booking);
  };

  useEffect(() => {
    if (!orgId) return;
    fetchSpaces();
    fetchCatering();
  }, [orgId]);

  useEffect(() => {
    if (view === 'pipeline') fetchBookings();
    if (view === 'calendar') fetchCalendar();
  }, [view, orgId, statusFilter]);

  useEffect(() => {
    if (view === 'calendar') fetchCalendar();
  }, [calYear, calMonth]);

  const advanceStatus = async (bookingId: number, newStatus: EnquiryStatus) => {
    if (!orgId) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/events/bookings/${bookingId}/status`), {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (r.ok) {
      toast({ title: 'Status updated', description: `Booking moved to ${STATUS_CONFIG[newStatus].label}` });
      fetchBookings();
      if (bookingDetail?.booking.id === bookingId) fetchBookingDetail(bookingId);
    }
  };

  const cancelBooking = async (bookingId: number) => {
    if (!orgId || !confirm('Cancel this booking?')) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/events/bookings/${bookingId}`), { method: 'DELETE', credentials: 'include' });
    if (r.ok) { toast({ title: 'Booking cancelled' }); fetchBookings(); setSelectedBooking(null); setBookingDetail(null); }
  };

  const generateInvoice = async (bookingId: number, data: { taxRate: number; dueDate: string; notes: string }) => {
    if (!orgId) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/events/bookings/${bookingId}/invoice`), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (r.ok) {
      toast({ title: 'Invoice generated' });
      setShowInvoiceForm(false);
      fetchBookingDetail(bookingId);
    }
  };

  const sendInvoice = async (bookingId: number) => {
    if (!orgId) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/events/bookings/${bookingId}/invoice/send`), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    const d = await r.json();
    if (r.ok) toast({ title: d.emailDelivered ? 'Invoice sent via email' : 'Invoice marked as sent (email not configured)' });
    fetchBookingDetail(bookingId);
  };

  const markInvoicePaid = async (bookingId: number) => {
    if (!orgId) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/events/bookings/${bookingId}/invoice/mark-paid`), {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    if (r.ok) { toast({ title: 'Invoice marked as paid' }); fetchBookingDetail(bookingId); fetchBookings(); }
  };

  const groupByStatus = (bkgs: EventBooking[]) => {
    const result: Record<EnquiryStatus, EventBooking[]> = {
      enquiry: [], quote_sent: [], confirmed: [], invoiced: [], paid: [], cancelled: [],
    };
    for (const b of bkgs) result[b.status]?.push(b);
    return result;
  };

  if (selectedBooking) {
    return (
      <BookingDetailView
        booking={selectedBooking}
        detail={bookingDetail}
        spaces={spaces}
        cateringPackages={cateringPackages}
        onBack={() => { setSelectedBooking(null); setBookingDetail(null); }}
        onStatusChange={advanceStatus}
        onCancel={cancelBooking}
        onGenerateInvoice={(id) => { setShowInvoiceForm(true); }}
        onSendInvoice={sendInvoice}
        onMarkPaid={markInvoicePaid}
        showInvoiceForm={showInvoiceForm}
        onCloseInvoiceForm={() => setShowInvoiceForm(false)}
        onSubmitInvoice={(data) => generateInvoice(selectedBooking.id, data)}
        orgId={orgId ?? 0}
        onRefresh={() => fetchBookingDetail(selectedBooking.id)}
      />
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <CalendarDays className="w-7 h-7 text-primary" />
            Events & Functions
          </h1>
          <p className="text-muted-foreground mt-1">Manage function spaces, event bookings, and banquet invoicing</p>
        </div>
        <div className="flex gap-2">
          {view === 'pipeline' && (
            <Button onClick={() => setShowBookingForm(true)} className="bg-primary hover:bg-primary/90">
              <Plus className="w-4 h-4 mr-1" /> New Booking
            </Button>
          )}
          {view === 'spaces' && (
            <Button onClick={() => { setEditingSpace(null); setShowSpaceForm(true); }} className="bg-primary hover:bg-primary/90">
              <Plus className="w-4 h-4 mr-1" /> Add Space
            </Button>
          )}
          {view === 'catering' && (
            <Button onClick={() => { setEditingCatering(null); setShowCateringForm(true); }} className="bg-primary hover:bg-primary/90">
              <Plus className="w-4 h-4 mr-1" /> Add Package
            </Button>
          )}
        </div>
      </div>

      {/* View tabs */}
      <div className="flex gap-1 bg-white/5 rounded-xl p-1 w-fit">
        {[
          { key: 'pipeline', label: 'Pipeline', icon: ClipboardList },
          { key: 'calendar', label: 'Calendar', icon: CalendarDays },
          { key: 'spaces', label: 'Spaces', icon: Building2 },
          { key: 'catering', label: 'Catering', icon: UtensilsCrossed },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setView(key as typeof view)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              view === key ? 'bg-primary text-white' : 'text-muted-foreground hover:text-white'
            }`}
          >
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {/* Pipeline view */}
      {view === 'pipeline' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex gap-3 flex-wrap">
            <Input
              placeholder="Search by name, email, event…"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchBookings()}
              className="w-64 bg-white/5 border-white/10"
            />
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as EnquiryStatus | '')}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">All statuses</option>
              {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={fetchBookings} className="border-white/10">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>

          {/* Kanban pipeline */}
          {!statusFilter ? (
            <div className="grid grid-cols-5 gap-3 min-w-[900px] overflow-x-auto">
              {PIPELINE_STATUSES.map(status => {
                const grouped = groupByStatus(bookings);
                const col = grouped[status] ?? [];
                const cfg = STATUS_CONFIG[status];
                return (
                  <div key={status} className="space-y-2">
                    <div className={`px-3 py-1.5 rounded-lg border text-xs font-semibold ${cfg.bgColor} ${cfg.color} flex items-center justify-between`}>
                      <span>{cfg.label}</span>
                      <span className="bg-white/10 rounded-full px-1.5 py-0.5 text-[10px]">{col.length}</span>
                    </div>
                    <div className="space-y-2 min-h-[200px]">
                      {col.map(b => (
                        <BookingCard key={b.id} booking={b} onClick={() => fetchBookingDetail(b.id)} />
                      ))}
                      {col.length === 0 && (
                        <div className="text-center text-muted-foreground text-xs py-8 border border-dashed border-white/10 rounded-lg">
                          No bookings
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-2">
              {bookings.map(b => (
                <BookingListRow key={b.id} booking={b} onClick={() => fetchBookingDetail(b.id)} />
              ))}
              {bookings.length === 0 && !loading && (
                <div className="text-center text-muted-foreground py-16">No bookings found</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Calendar view */}
      {view === 'calendar' && (
        <EventCalendar
          year={calYear}
          month={calMonth}
          bookings={calBookings}
          onPrev={() => {
            if (calMonth === 1) { setCalYear(y => y - 1); setCalMonth(12); }
            else setCalMonth(m => m - 1);
          }}
          onNext={() => {
            if (calMonth === 12) { setCalYear(y => y + 1); setCalMonth(1); }
            else setCalMonth(m => m + 1);
          }}
          onSelect={(b) => fetchBookingDetail(b.id)}
        />
      )}

      {/* Spaces view */}
      {view === 'spaces' && (
        <SpacesView
          spaces={spaces}
          onEdit={(s) => { setEditingSpace(s); setShowSpaceForm(true); }}
          onDeactivate={async (id) => {
            if (!orgId) return;
            await fetch(apiUrl(`/organizations/${orgId}/events/spaces/${id}`), {
              method: 'DELETE', credentials: 'include',
            });
            fetchSpaces();
            toast({ title: 'Space deactivated' });
          }}
        />
      )}

      {/* Catering view */}
      {view === 'catering' && (
        <CateringView
          packages={cateringPackages}
          onEdit={(p) => { setEditingCatering(p); setShowCateringForm(true); }}
          onDeactivate={async (id) => {
            if (!orgId) return;
            await fetch(apiUrl(`/organizations/${orgId}/events/catering-packages/${id}`), {
              method: 'DELETE', credentials: 'include',
            });
            fetchCatering();
            toast({ title: 'Package deactivated' });
          }}
        />
      )}

      {/* Booking form modal */}
      {showBookingForm && (
        <BookingFormModal
          spaces={spaces}
          cateringPackages={cateringPackages}
          onClose={() => setShowBookingForm(false)}
          onSave={async (data) => {
            if (!orgId) return;
            const r = await fetch(apiUrl(`/organizations/${orgId}/events/bookings`), {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data),
            });
            if (r.ok) {
              toast({ title: 'Booking created' });
              setShowBookingForm(false);
              fetchBookings();
            } else {
              const d = await r.json();
              toast({ title: 'Error', description: d.error, variant: 'destructive' });
            }
          }}
        />
      )}

      {/* Space form modal */}
      {showSpaceForm && (
        <SpaceFormModal
          space={editingSpace}
          onClose={() => setShowSpaceForm(false)}
          onSave={async (data) => {
            if (!orgId) return;
            const url = editingSpace
              ? apiUrl(`/organizations/${orgId}/events/spaces/${editingSpace.id}`)
              : apiUrl(`/organizations/${orgId}/events/spaces`);
            const r = await fetch(url, {
              method: editingSpace ? 'PATCH' : 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data),
            });
            if (r.ok) {
              toast({ title: editingSpace ? 'Space updated' : 'Space created' });
              setShowSpaceForm(false);
              fetchSpaces();
            }
          }}
        />
      )}

      {/* Catering form modal */}
      {showCateringForm && (
        <CateringFormModal
          pkg={editingCatering}
          onClose={() => setShowCateringForm(false)}
          onSave={async (data) => {
            if (!orgId) return;
            const url = editingCatering
              ? apiUrl(`/organizations/${orgId}/events/catering-packages/${editingCatering.id}`)
              : apiUrl(`/organizations/${orgId}/events/catering-packages`);
            const r = await fetch(url, {
              method: editingCatering ? 'PATCH' : 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data),
            });
            if (r.ok) {
              toast({ title: editingCatering ? 'Package updated' : 'Package created' });
              setShowCateringForm(false);
              fetchCatering();
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Booking Card (Kanban) ─────────────────────────────────────────────────────
function BookingCard({ booking, onClick }: { booking: EventBooking; onClick: () => void }) {
  const cfg = STATUS_CONFIG[booking.status];
  return (
    <div onClick={onClick} className="bg-card border border-white/10 rounded-lg p-3 cursor-pointer hover:border-primary/30 hover:bg-white/5 transition-all">
      <p className="font-semibold text-white text-sm truncate">{booking.eventName}</p>
      <p className="text-muted-foreground text-xs mt-0.5">{formatDate(booking.eventDate)}</p>
      {booking.spaceName && <p className="text-muted-foreground text-xs">{booking.spaceName}</p>}
      <div className="flex items-center gap-1.5 mt-2">
        <Users className="w-3 h-3 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{booking.expectedGuests ?? '?'} guests</span>
      </div>
      {booking.totalAmount && (
        <p className="text-xs text-primary mt-1 font-semibold">{formatCurrency(booking.totalAmount, booking.currency)}</p>
      )}
    </div>
  );
}

// ─── Booking List Row ──────────────────────────────────────────────────────────
function BookingListRow({ booking, onClick }: { booking: EventBooking; onClick: () => void }) {
  const cfg = STATUS_CONFIG[booking.status];
  return (
    <div onClick={onClick} className="bg-card border border-white/10 rounded-lg p-4 cursor-pointer hover:border-primary/30 transition-all flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-white">{booking.eventName}</p>
        <p className="text-muted-foreground text-sm">{booking.organiserName} {booking.organiserCompany ? `· ${booking.organiserCompany}` : ''}</p>
      </div>
      <div className="text-right">
        <p className="text-sm text-white">{formatDate(booking.eventDate)}</p>
        {booking.spaceName && <p className="text-xs text-muted-foreground">{booking.spaceName}</p>}
      </div>
      <div className={`px-2.5 py-1 rounded-full border text-xs font-semibold ${cfg.bgColor} ${cfg.color}`}>{cfg.label}</div>
      {booking.totalAmount && <p className="text-sm font-semibold text-primary w-24 text-right">{formatCurrency(booking.totalAmount, booking.currency)}</p>}
    </div>
  );
}

// ─── Booking Detail View ───────────────────────────────────────────────────────
function BookingDetailView({
  booking, detail, spaces, cateringPackages,
  onBack, onStatusChange, onCancel, onGenerateInvoice, onSendInvoice, onMarkPaid,
  showInvoiceForm, onCloseInvoiceForm, onSubmitInvoice, orgId, onRefresh,
}: {
  booking: EventBooking;
  detail: { booking: EventBooking; space: FunctionSpace | null; cateringPackage: CateringPackage | null; invoice: EventInvoice | null } | null;
  spaces: FunctionSpace[];
  cateringPackages: CateringPackage[];
  onBack: () => void;
  onStatusChange: (id: number, status: EnquiryStatus) => void;
  onCancel: (id: number) => void;
  onGenerateInvoice: (id: number) => void;
  onSendInvoice: (id: number) => void;
  onMarkPaid: (id: number) => void;
  showInvoiceForm: boolean;
  onCloseInvoiceForm: () => void;
  onSubmitInvoice: (data: { taxRate: number; dueDate: string; notes: string }) => void;
  orgId: number;
  onRefresh: () => void;
}) {
  const cfg = STATUS_CONFIG[booking.status];
  const currentStepIdx = PIPELINE_STATUSES.indexOf(booking.status);
  const inv = detail?.invoice;

  const nextStatus = currentStepIdx >= 0 && currentStepIdx < PIPELINE_STATUSES.length - 1
    ? PIPELINE_STATUSES[currentStepIdx + 1]
    : null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <div className={`px-3 py-1 rounded-full border text-sm font-semibold ${cfg.bgColor} ${cfg.color}`}>{cfg.label}</div>
        <h1 className="text-xl font-bold text-white flex-1">{booking.eventName}</h1>
        <div className="flex gap-2">
          {nextStatus && booking.status !== 'cancelled' && (
            <Button size="sm" onClick={() => onStatusChange(booking.id, nextStatus)} className="bg-primary hover:bg-primary/90">
              Move to {STATUS_CONFIG[nextStatus].label}
            </Button>
          )}
          {booking.status !== 'cancelled' && booking.status !== 'paid' && (
            <>
              {booking.status === 'confirmed' && !inv && (
                <Button size="sm" variant="outline" onClick={() => onGenerateInvoice(booking.id)} className="border-white/10">
                  <FileText className="w-4 h-4 mr-1" /> Generate Invoice
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => onCancel(booking.id)} className="border-red-500/30 text-red-400">
                <X className="w-4 h-4 mr-1" /> Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-0">
        {PIPELINE_STATUSES.map((s, i) => {
          const done = currentStepIdx >= i;
          const active = currentStepIdx === i;
          return (
            <div key={s} className="flex-1 flex items-center">
              <div className={`h-1.5 flex-1 ${i === 0 ? 'rounded-l-full' : ''} ${i === PIPELINE_STATUSES.length - 1 ? 'rounded-r-full' : ''} ${done ? 'bg-primary' : 'bg-white/10'}`} />
              {i < PIPELINE_STATUSES.length - 1 && (
                <div className={`w-3 h-3 rounded-full border-2 ${done ? 'bg-primary border-primary' : 'bg-card border-white/20'}`} />
              )}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Event details */}
        <div className="col-span-2 space-y-4">
          <Card className="p-5 bg-card border-white/10 space-y-4">
            <h2 className="font-semibold text-white text-base">Event Details</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label="Event Date" value={formatDate(booking.eventDate)} />
              <Detail label="Time" value={booking.startTime && booking.endTime ? `${booking.startTime} – ${booking.endTime}` : booking.startTime ?? '—'} />
              <Detail label="Event Type" value={booking.eventType ?? '—'} />
              <Detail label="Layout" value={booking.layout ? booking.layout.replace('_', '-') : '—'} />
              <Detail label="Expected Guests" value={String(booking.expectedGuests ?? '—')} />
              <Detail label="Final Guest Count" value={String(booking.finalGuestCount ?? '—')} />
              <Detail label="Function Space" value={detail?.space?.name ?? booking.spaceName ?? '—'} />
              <Detail label="Catering Package" value={detail?.cateringPackage?.name ?? booking.packageName ?? '—'} />
            </div>
            {booking.cateringNotes && <DetailBlock label="Catering Notes" value={booking.cateringNotes} />}
            {booking.avRequirements && <DetailBlock label="AV Requirements" value={booking.avRequirements} />}
            {booking.specialRequirements && <DetailBlock label="Special Requirements" value={booking.specialRequirements} />}
          </Card>

          {/* Organiser */}
          <Card className="p-5 bg-card border-white/10 space-y-4">
            <h2 className="font-semibold text-white text-base">Organiser Contact</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label="Name" value={booking.organiserName} />
              <Detail label="Email" value={booking.organiserEmail} />
              <Detail label="Phone" value={booking.organiserPhone ?? '—'} />
              <Detail label="Company" value={booking.organiserCompany ?? '—'} />
            </div>
          </Card>

          {/* Invoice section */}
          {inv && (
            <Card className="p-5 bg-card border-white/10 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-white text-base">Invoice {inv.invoiceNumber}</h2>
                <div className="flex gap-2">
                  {(inv.status === 'draft' || inv.status === 'sent') && (
                    <>
                      {inv.status === 'draft' && (
                        <Button size="sm" variant="outline" onClick={() => onSendInvoice(booking.id)} className="border-white/10">
                          <Send className="w-3.5 h-3.5 mr-1" /> Send
                        </Button>
                      )}
                      <Button size="sm" onClick={() => onMarkPaid(booking.id)} className="bg-emerald-600 hover:bg-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Mark Paid
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-white/10 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-white/5">
                    <tr>
                      <th className="text-left px-4 py-2 text-muted-foreground font-medium">Description</th>
                      <th className="text-right px-4 py-2 text-muted-foreground font-medium">Qty</th>
                      <th className="text-right px-4 py-2 text-muted-foreground font-medium">Unit Price</th>
                      <th className="text-right px-4 py-2 text-muted-foreground font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.lineItems.map((li, i) => (
                      <tr key={i} className="border-t border-white/5">
                        <td className="px-4 py-2 text-white">{li.description}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{li.quantity}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{formatCurrency(String(li.unitPrice), inv.currency)}</td>
                        <td className="px-4 py-2 text-right text-white font-medium">{formatCurrency(String(li.total), inv.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-white/10 bg-white/5">
                    <tr>
                      <td colSpan={3} className="px-4 py-2 text-right text-muted-foreground">Subtotal</td>
                      <td className="px-4 py-2 text-right text-white">{formatCurrency(inv.subtotal, inv.currency)}</td>
                    </tr>
                    {parseFloat(inv.taxRate) > 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-2 text-right text-muted-foreground">Tax ({inv.taxRate}%)</td>
                        <td className="px-4 py-2 text-right text-white">{formatCurrency(inv.taxAmount, inv.currency)}</td>
                      </tr>
                    )}
                    <tr>
                      <td colSpan={3} className="px-4 py-3 text-right font-semibold text-white">Total</td>
                      <td className="px-4 py-3 text-right font-bold text-primary text-base">{formatCurrency(inv.totalAmount, inv.currency)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="flex gap-6 text-sm">
                <Detail label="Status" value={inv.status.charAt(0).toUpperCase() + inv.status.slice(1)} />
                {inv.dueDate && <Detail label="Due Date" value={formatDate(inv.dueDate)} />}
                {inv.paidAt && <Detail label="Paid On" value={formatDate(inv.paidAt)} />}
              </div>
            </Card>
          )}
        </div>

        {/* Financials sidebar */}
        <div className="space-y-4">
          <Card className="p-5 bg-card border-white/10 space-y-3">
            <h2 className="font-semibold text-white text-base">Financials</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Space Hire</span>
                <span className="text-white">{formatCurrency(booking.spaceHireAmount ?? null, booking.currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Catering</span>
                <span className="text-white">{formatCurrency(booking.cateringAmount ?? null, booking.currency)}</span>
              </div>
              {(booking.extras ?? []).map((e, i) => (
                <div key={i} className="flex justify-between">
                  <span className="text-muted-foreground">{e.description}</span>
                  <span className="text-white">{formatCurrency(String(e.amount), booking.currency)}</span>
                </div>
              ))}
              <div className="border-t border-white/10 pt-2 flex justify-between font-semibold">
                <span className="text-white">Total</span>
                <span className="text-primary">{formatCurrency(booking.totalAmount, booking.currency)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Deposit</span>
                <span className={booking.depositPaid ? 'text-green-400' : 'text-red-400'}>
                  {formatCurrency(booking.depositAmount ?? null, booking.currency)} {booking.depositPaid ? '✓' : '(unpaid)'}
                </span>
              </div>
            </div>
          </Card>

          {booking.internalNotes && (
            <Card className="p-5 bg-card border-white/10">
              <h2 className="font-semibold text-white text-sm mb-2">Internal Notes</h2>
              <p className="text-muted-foreground text-sm">{booking.internalNotes}</p>
            </Card>
          )}
        </div>
      </div>

      {showInvoiceForm && (
        <InvoiceFormModal
          booking={booking}
          onClose={onCloseInvoiceForm}
          onSubmit={onSubmitInvoice}
        />
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-white mt-0.5">{value}</p>
    </div>
  );
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs mb-1">{label}</p>
      <p className="text-white bg-white/5 rounded-lg px-3 py-2 text-sm">{value}</p>
    </div>
  );
}

// ─── Calendar ─────────────────────────────────────────────────────────────────
function EventCalendar({ year, month, bookings, onPrev, onNext, onSelect }: {
  year: number; month: number; bookings: EventBooking[];
  onPrev: () => void; onNext: () => void; onSelect: (b: EventBooking) => void;
}) {
  const monthName = new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const startPad = (firstDay + 6) % 7;

  const dayBookings: Record<number, EventBooking[]> = {};
  for (const b of bookings) {
    const d = new Date(b.eventDate).getDate();
    if (!dayBookings[d]) dayBookings[d] = [];
    dayBookings[d].push(b);
  }

  const cells: (number | null)[] = [...Array(startPad).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={onPrev} className="border-white/10"><ChevronLeft className="w-4 h-4" /></Button>
        <h2 className="text-lg font-semibold text-white">{monthName}</h2>
        <Button variant="outline" size="sm" onClick={onNext} className="border-white/10"><ChevronRight className="w-4 h-4" /></Button>
        <span className="text-muted-foreground text-sm ml-2">{bookings.length} event{bookings.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
          <div key={d} className="text-center text-xs font-medium text-muted-foreground py-2">{d}</div>
        ))}
        {cells.map((day, i) => (
          <div key={i} className={`min-h-[80px] rounded-lg border ${day ? 'border-white/10 bg-card p-1.5' : 'border-transparent'}`}>
            {day && (
              <>
                <p className="text-xs text-muted-foreground mb-1">{day}</p>
                {(dayBookings[day] ?? []).map(b => {
                  const cfg = STATUS_CONFIG[b.status];
                  return (
                    <div key={b.id} onClick={() => onSelect(b)}
                      className={`text-[10px] rounded px-1 py-0.5 mb-0.5 cursor-pointer truncate font-medium border ${cfg.bgColor} ${cfg.color}`}
                    >
                      {b.eventName}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Spaces View ──────────────────────────────────────────────────────────────
function SpacesView({ spaces, onEdit, onDeactivate }: {
  spaces: FunctionSpace[]; onEdit: (s: FunctionSpace) => void; onDeactivate: (id: number) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-4">
      {spaces.map(s => (
        <Card key={s.id} className={`p-5 bg-card border-white/10 space-y-3 ${!s.isActive ? 'opacity-50' : ''}`}>
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-semibold text-white">{s.name}</h3>
              {s.description && <p className="text-muted-foreground text-sm mt-0.5">{s.description}</p>}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => onEdit(s)}><Pencil className="w-3.5 h-3.5" /></Button>
              {s.isActive && <Button size="sm" variant="ghost" onClick={() => onDeactivate(s.id)}><X className="w-3.5 h-3.5 text-red-400" /></Button>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {s.capacitySeated && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Users className="w-3.5 h-3.5" /> {s.capacitySeated} seated
              </div>
            )}
            {s.capacityStanding && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Users className="w-3.5 h-3.5" /> {s.capacityStanding} standing
              </div>
            )}
          </div>
          {s.basePricePerDay && (
            <p className="text-primary font-semibold text-sm">{formatCurrency(s.basePricePerDay, s.currency)}/day</p>
          )}
          {s.facilities && s.facilities.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {s.facilities.slice(0, 4).map((f, i) => (
                <span key={i} className="text-[10px] bg-white/5 text-muted-foreground px-2 py-0.5 rounded-full">{f}</span>
              ))}
              {s.facilities.length > 4 && <span className="text-[10px] text-muted-foreground">+{s.facilities.length - 4}</span>}
            </div>
          )}
        </Card>
      ))}
      {spaces.length === 0 && (
        <div className="col-span-3 text-center text-muted-foreground py-16">
          No function spaces configured. Click "Add Space" to get started.
        </div>
      )}
    </div>
  );
}

// ─── Catering View ────────────────────────────────────────────────────────────
function CateringView({ packages, onEdit, onDeactivate }: {
  packages: CateringPackage[]; onEdit: (p: CateringPackage) => void; onDeactivate: (id: number) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-4">
      {packages.map(p => (
        <Card key={p.id} className={`p-5 bg-card border-white/10 space-y-3 ${!p.isActive ? 'opacity-50' : ''}`}>
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-semibold text-white">{p.name}</h3>
              {p.description && <p className="text-muted-foreground text-sm mt-0.5">{p.description}</p>}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => onEdit(p)}><Pencil className="w-3.5 h-3.5" /></Button>
              {p.isActive && <Button size="sm" variant="ghost" onClick={() => onDeactivate(p.id)}><X className="w-3.5 h-3.5 text-red-400" /></Button>}
            </div>
          </div>
          <p className="text-primary font-bold text-lg">{formatCurrency(p.pricePerHead, p.currency)}<span className="text-sm font-normal text-muted-foreground">/head</span></p>
          {p.minimumGuests && <p className="text-xs text-muted-foreground">Min {p.minimumGuests} guests</p>}
          {p.menuItems && p.menuItems.length > 0 && (
            <div className="space-y-1">
              {p.menuItems.slice(0, 3).map((mi, i) => (
                <div key={i}>
                  <p className="text-xs font-medium text-white">{mi.category}</p>
                  <p className="text-xs text-muted-foreground">{mi.items.slice(0, 3).join(', ')}{mi.items.length > 3 ? '…' : ''}</p>
                </div>
              ))}
            </div>
          )}
          {p.inclusions && p.inclusions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {p.inclusions.map((inc, i) => (
                <span key={i} className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full">{inc}</span>
              ))}
            </div>
          )}
        </Card>
      ))}
      {packages.length === 0 && (
        <div className="col-span-3 text-center text-muted-foreground py-16">
          No catering packages configured. Click "Add Package" to get started.
        </div>
      )}
    </div>
  );
}

// ─── Booking Form Modal ────────────────────────────────────────────────────────
function BookingFormModal({ spaces, cateringPackages, onClose, onSave }: {
  spaces: FunctionSpace[]; cateringPackages: CateringPackage[];
  onClose: () => void; onSave: (data: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState<Record<string, string | number | boolean | undefined>>({
    status: 'enquiry', currency: 'INR', depositPaid: false,
  });
  const f = (k: string, v: unknown) => setForm(p => ({ ...p, [k]: v as string | number | boolean | undefined }));

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-card border-white/10">
        <DialogHeader><DialogTitle>New Event Booking</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="col-span-2">
            <Label>Event Name *</Label>
            <Input value={form.eventName as string ?? ''} onChange={e => f('eventName', e.target.value)} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Event Type</Label>
            <select value={form.eventType as string ?? ''} onChange={e => f('eventType', e.target.value)} className="w-full mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white">
              <option value="">Select type…</option>
              {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <Label>Status</Label>
            <select value={form.status as string} onChange={e => f('status', e.target.value)} className="w-full mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white">
              {Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div>
            <Label>Event Date *</Label>
            <Input type="date" value={form.eventDate as string ?? ''} onChange={e => f('eventDate', e.target.value)} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Start Time</Label>
              <Input type="time" value={form.startTime as string ?? ''} onChange={e => f('startTime', e.target.value)} className="mt-1 bg-white/5 border-white/10" />
            </div>
            <div>
              <Label>End Time</Label>
              <Input type="time" value={form.endTime as string ?? ''} onChange={e => f('endTime', e.target.value)} className="mt-1 bg-white/5 border-white/10" />
            </div>
          </div>
          <div>
            <Label>Organiser Name *</Label>
            <Input value={form.organiserName as string ?? ''} onChange={e => f('organiserName', e.target.value)} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Organiser Email *</Label>
            <Input type="email" value={form.organiserEmail as string ?? ''} onChange={e => f('organiserEmail', e.target.value)} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={form.organiserPhone as string ?? ''} onChange={e => f('organiserPhone', e.target.value)} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Company</Label>
            <Input value={form.organiserCompany as string ?? ''} onChange={e => f('organiserCompany', e.target.value)} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Expected Guests</Label>
            <Input type="number" value={form.expectedGuests as string ?? ''} onChange={e => f('expectedGuests', e.target.value)} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Layout</Label>
            <select value={form.layout as string ?? ''} onChange={e => f('layout', e.target.value)} className="w-full mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white">
              <option value="">Select layout…</option>
              {LAYOUTS.map(l => <option key={l} value={l}>{l.replace('_', '-')}</option>)}
            </select>
          </div>
          <div>
            <Label>Function Space</Label>
            <select value={form.functionSpaceId as string ?? ''} onChange={e => f('functionSpaceId', e.target.value)} className="w-full mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white">
              <option value="">Select space…</option>
              {spaces.filter(s => s.isActive).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <Label>Catering Package</Label>
            <select value={form.cateringPackageId as string ?? ''} onChange={e => f('cateringPackageId', e.target.value)} className="w-full mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white">
              <option value="">None</option>
              {cateringPackages.filter(p => p.isActive).map(p => <option key={p.id} value={p.id}>{p.name} ({p.currency} {p.pricePerHead}/head)</option>)}
            </select>
          </div>
          <div>
            <Label>Space Hire Amount</Label>
            <Input type="number" value={form.spaceHireAmount as string ?? ''} onChange={e => f('spaceHireAmount', e.target.value)} className="mt-1 bg-white/5 border-white/10" placeholder="0.00" />
          </div>
          <div>
            <Label>Catering Amount</Label>
            <Input type="number" value={form.cateringAmount as string ?? ''} onChange={e => f('cateringAmount', e.target.value)} className="mt-1 bg-white/5 border-white/10" placeholder="0.00" />
          </div>
          <div>
            <Label>Total Amount</Label>
            <Input type="number" value={form.totalAmount as string ?? ''} onChange={e => f('totalAmount', e.target.value)} className="mt-1 bg-white/5 border-white/10" placeholder="0.00" />
          </div>
          <div>
            <Label>Deposit Amount</Label>
            <Input type="number" value={form.depositAmount as string ?? ''} onChange={e => f('depositAmount', e.target.value)} className="mt-1 bg-white/5 border-white/10" placeholder="0.00" />
          </div>
          <div className="col-span-2">
            <Label>Catering Notes</Label>
            <Textarea value={form.cateringNotes as string ?? ''} onChange={e => f('cateringNotes', e.target.value)} className="mt-1 bg-white/5 border-white/10" rows={2} />
          </div>
          <div className="col-span-2">
            <Label>AV Requirements</Label>
            <Textarea value={form.avRequirements as string ?? ''} onChange={e => f('avRequirements', e.target.value)} className="mt-1 bg-white/5 border-white/10" rows={2} />
          </div>
          <div className="col-span-2">
            <Label>Special Requirements</Label>
            <Textarea value={form.specialRequirements as string ?? ''} onChange={e => f('specialRequirements', e.target.value)} className="mt-1 bg-white/5 border-white/10" rows={2} />
          </div>
          <div className="col-span-2">
            <Label>Internal Notes</Label>
            <Textarea value={form.internalNotes as string ?? ''} onChange={e => f('internalNotes', e.target.value)} className="mt-1 bg-white/5 border-white/10" rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-white/10">Cancel</Button>
          <Button onClick={() => onSave(form)} className="bg-primary hover:bg-primary/90">Create Booking</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Space Form Modal ──────────────────────────────────────────────────────────
function SpaceFormModal({ space, onClose, onSave }: {
  space: FunctionSpace | null; onClose: () => void; onSave: (data: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState({
    name: space?.name ?? '',
    description: space?.description ?? '',
    capacitySeated: space?.capacitySeated ?? '',
    capacityStanding: space?.capacityStanding ?? '',
    basePricePerDay: space?.basePricePerDay ?? '',
    currency: space?.currency ?? 'INR',
    facilitiesStr: (space?.facilities ?? []).join(', '),
    avEquipmentStr: (space?.avEquipment ?? []).join(', '),
    sortOrder: space?.sortOrder ?? 0,
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg bg-card border-white/10">
        <DialogHeader><DialogTitle>{space ? 'Edit Space' : 'Add Function Space'}</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label>Name *</Label>
            <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} className="mt-1 bg-white/5 border-white/10" rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Seated Capacity</Label>
              <Input type="number" value={form.capacitySeated} onChange={e => setForm(p => ({ ...p, capacitySeated: e.target.value }))} className="mt-1 bg-white/5 border-white/10" />
            </div>
            <div>
              <Label>Standing Capacity</Label>
              <Input type="number" value={form.capacityStanding} onChange={e => setForm(p => ({ ...p, capacityStanding: e.target.value }))} className="mt-1 bg-white/5 border-white/10" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Base Price/Day</Label>
              <Input type="number" value={form.basePricePerDay} onChange={e => setForm(p => ({ ...p, basePricePerDay: e.target.value }))} className="mt-1 bg-white/5 border-white/10" />
            </div>
            <div>
              <Label>Currency</Label>
              <Input value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))} className="mt-1 bg-white/5 border-white/10" />
            </div>
          </div>
          <div>
            <Label>Facilities (comma-separated)</Label>
            <Input value={form.facilitiesStr} onChange={e => setForm(p => ({ ...p, facilitiesStr: e.target.value }))} className="mt-1 bg-white/5 border-white/10" placeholder="Projector, PA System, WiFi…" />
          </div>
          <div>
            <Label>AV Equipment (comma-separated)</Label>
            <Input value={form.avEquipmentStr} onChange={e => setForm(p => ({ ...p, avEquipmentStr: e.target.value }))} className="mt-1 bg-white/5 border-white/10" placeholder="Microphone, Screen, Lighting…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-white/10">Cancel</Button>
          <Button onClick={() => onSave({
            name: form.name,
            description: form.description || null,
            capacitySeated: form.capacitySeated || null,
            capacityStanding: form.capacityStanding || null,
            basePricePerDay: form.basePricePerDay || null,
            currency: form.currency,
            facilities: form.facilitiesStr ? form.facilitiesStr.split(',').map(s => s.trim()).filter(Boolean) : [],
            avEquipment: form.avEquipmentStr ? form.avEquipmentStr.split(',').map(s => s.trim()).filter(Boolean) : [],
            sortOrder: form.sortOrder,
          })} className="bg-primary hover:bg-primary/90">{space ? 'Save Changes' : 'Create Space'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Catering Form Modal ───────────────────────────────────────────────────────
function CateringFormModal({ pkg, onClose, onSave }: {
  pkg: CateringPackage | null; onClose: () => void; onSave: (data: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState({
    name: pkg?.name ?? '',
    description: pkg?.description ?? '',
    pricePerHead: pkg?.pricePerHead ?? '',
    currency: pkg?.currency ?? 'INR',
    minimumGuests: pkg?.minimumGuests ?? '',
    inclusionsStr: (pkg?.inclusions ?? []).join(', '),
    menuItems: pkg?.menuItems ?? [] as { category: string; items: string[] }[],
    newCat: '', newItems: '',
  });

  const addMenuSection = () => {
    if (!form.newCat) return;
    setForm(p => ({
      ...p,
      menuItems: [...p.menuItems, { category: p.newCat, items: p.newItems.split(',').map(s => s.trim()).filter(Boolean) }],
      newCat: '', newItems: '',
    }));
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto bg-card border-white/10">
        <DialogHeader><DialogTitle>{pkg ? 'Edit Package' : 'Add Catering Package'}</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label>Package Name *</Label>
            <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} className="mt-1 bg-white/5 border-white/10" rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Price Per Head *</Label>
              <Input type="number" value={form.pricePerHead} onChange={e => setForm(p => ({ ...p, pricePerHead: e.target.value }))} className="mt-1 bg-white/5 border-white/10" />
            </div>
            <div>
              <Label>Currency</Label>
              <Input value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))} className="mt-1 bg-white/5 border-white/10" />
            </div>
          </div>
          <div>
            <Label>Minimum Guests</Label>
            <Input type="number" value={form.minimumGuests} onChange={e => setForm(p => ({ ...p, minimumGuests: e.target.value }))} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Inclusions (comma-separated)</Label>
            <Input value={form.inclusionsStr} onChange={e => setForm(p => ({ ...p, inclusionsStr: e.target.value }))} className="mt-1 bg-white/5 border-white/10" placeholder="Welcome drink, Tea/Coffee…" />
          </div>
          <div>
            <Label>Menu Sections</Label>
            {form.menuItems.map((mi, i) => (
              <div key={i} className="bg-white/5 rounded-lg p-2 mb-2 flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-white">{mi.category}</p>
                  <p className="text-xs text-muted-foreground">{mi.items.join(', ')}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setForm(p => ({ ...p, menuItems: p.menuItems.filter((_, j) => j !== i) }))}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            ))}
            <div className="grid grid-cols-5 gap-2 mt-2">
              <Input value={form.newCat} onChange={e => setForm(p => ({ ...p, newCat: e.target.value }))} placeholder="Category" className="col-span-2 bg-white/5 border-white/10 text-sm" />
              <Input value={form.newItems} onChange={e => setForm(p => ({ ...p, newItems: e.target.value }))} placeholder="Items (comma-sep)" className="col-span-2 bg-white/5 border-white/10 text-sm" />
              <Button size="sm" variant="outline" onClick={addMenuSection} className="border-white/10"><Plus className="w-3.5 h-3.5" /></Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-white/10">Cancel</Button>
          <Button onClick={() => onSave({
            name: form.name,
            description: form.description || null,
            pricePerHead: form.pricePerHead,
            currency: form.currency,
            minimumGuests: form.minimumGuests || null,
            inclusions: form.inclusionsStr ? form.inclusionsStr.split(',').map(s => s.trim()).filter(Boolean) : [],
            menuItems: form.menuItems,
          })} className="bg-primary hover:bg-primary/90">{pkg ? 'Save Changes' : 'Create Package'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Invoice Form Modal ────────────────────────────────────────────────────────
function InvoiceFormModal({ booking, onClose, onSubmit }: {
  booking: EventBooking; onClose: () => void;
  onSubmit: (data: { taxRate: number; dueDate: string; notes: string }) => void;
}) {
  const [taxRate, setTaxRate] = useState('18');
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().split('T')[0];
  });
  const [notes, setNotes] = useState('');

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm bg-card border-white/10">
        <DialogHeader><DialogTitle>Generate Invoice</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Invoice will be generated from the booking financials (space hire, catering, extras).</p>
          <div>
            <Label>Tax Rate (%)</Label>
            <Input type="number" value={taxRate} onChange={e => setTaxRate(e.target.value)} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Due Date</Label>
            <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="mt-1 bg-white/5 border-white/10" />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} className="mt-1 bg-white/5 border-white/10" rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-white/10">Cancel</Button>
          <Button onClick={() => onSubmit({ taxRate: parseFloat(taxRate || '0'), dueDate, notes })} className="bg-primary hover:bg-primary/90">Generate</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
