import { useState, useEffect, useCallback } from 'react';
import {
  Package, Plus, RefreshCw, BarChart2, ArrowLeft,
  CheckCircle2, AlertTriangle, Clock, Pencil, Trash2,
  ChevronDown, ChevronUp, X, RotateCcw, Tag, Layers,
  ShieldAlert, DollarSign, Calendar,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function apiUrl(path: string) {
  return `${BASE}/api${path}`;
}

type AssetCondition = 'excellent' | 'good' | 'fair' | 'poor' | 'damaged' | 'retired';
type BookingStatus = 'reserved' | 'checked_out' | 'returned' | 'cancelled';

interface RentalCategory {
  id: number;
  name: string;
  description: string | null;
  dailyRate: string;
  currency: string;
  icon: string;
  isActive: boolean;
  sortOrder: number;
}

interface RentalAsset {
  id: number;
  categoryId: number;
  assetCode: string;
  description: string | null;
  condition: AssetCondition;
  dailyRateOverride: string | null;
  notes: string | null;
  isActive: boolean;
  categoryName: string;
  categoryIcon: string;
  categoryDailyRate: string;
  categoryCurrency: string;
  effectiveRate: string;
  currency: string;
  activeBooking: { bookingId: number; status: string; memberName: string | null } | null;
}

interface RentalBooking {
  id: number;
  assetId: number;
  assetCode: string;
  assetDescription: string | null;
  categoryId: number;
  categoryName: string;
  categoryIcon: string;
  teeBookingId: number | null;
  memberId: number | null;
  memberName: string | null;
  status: BookingStatus;
  rentalDate: string;
  expectedReturnAt: string | null;
  checkedOutAt: string | null;
  returnedAt: string | null;
  rateCharged: string | null;
  currency: string;
  damageReported: boolean;
  damageNotes: string | null;
  damagePhotoUrls: string[];
  notes: string | null;
}

interface RevenueData {
  categories: {
    categoryId: number;
    categoryName: string;
    categoryIcon: string;
    totalBookings: number;
    totalRevenue: number;
    currency: string;
    assets: { assetId: number; assetCode: string; totalBookings: number; totalRevenue: number }[];
  }[];
  grandTotal: number;
}

const CONDITION_COLOR: Record<AssetCondition, string> = {
  excellent: 'bg-green-500/20 text-green-400 border-green-500/30',
  good: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  fair: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  poor: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  damaged: 'bg-red-500/20 text-red-400 border-red-500/30',
  retired: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

const STATUS_COLOR: Record<BookingStatus, string> = {
  reserved: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  checked_out: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  returned: 'bg-green-500/20 text-green-400 border-green-500/30',
  cancelled: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

type View = 'assets' | 'bookings' | 'revenue';

export default function RentalsPage() {
  const { data: user } = useGetMe();
  const { toast } = useToast();
  const orgId = user?.organizationId;

  const [view, setView] = useState<View>('assets');
  const [categories, setCategories] = useState<RentalCategory[]>([]);
  const [assets, setAssets] = useState<RentalAsset[]>([]);
  const [bookings, setBookings] = useState<RentalBooking[]>([]);
  const [revenue, setRevenue] = useState<RevenueData | null>(null);
  const [loading, setLoading] = useState(false);

  // Modals
  const [showCatModal, setShowCatModal] = useState(false);
  const [editCat, setEditCat] = useState<RentalCategory | null>(null);
  const [catForm, setCatForm] = useState({ name: '', description: '', dailyRate: '', currency: 'USD', icon: 'package', sortOrder: '0' });

  const [showAssetModal, setShowAssetModal] = useState(false);
  const [editAsset, setEditAsset] = useState<RentalAsset | null>(null);
  const [assetForm, setAssetForm] = useState({ categoryId: '', assetCode: '', description: '', condition: 'good' as AssetCondition, dailyRateOverride: '', notes: '' });

  const [showBookingModal, setShowBookingModal] = useState(false);
  const [bookingForm, setBookingForm] = useState({ assetId: '', memberName: '', rentalDate: '', expectedReturnAt: '', rateCharged: '', currency: 'USD', notes: '' });

  const [showCheckinModal, setShowCheckinModal] = useState(false);
  const [checkinBooking, setCheckinBooking] = useState<RentalBooking | null>(null);
  const [checkinForm, setCheckinForm] = useState({ damageReported: false, damageNotes: '', condition: '' as AssetCondition | '', notes: '' });

  const [showDamageModal, setShowDamageModal] = useState(false);
  const [damageBooking, setDamageBooking] = useState<RentalBooking | null>(null);
  const [damageForm, setDamageForm] = useState({ damageNotes: '', condition: '' as AssetCondition | '' });

  const [bookingFilter, setBookingFilter] = useState('reserved,checked_out');
  const [expandedRevCat, setExpandedRevCat] = useState<number | null>(null);

  const fetchCategories = useCallback(async () => {
    if (!orgId) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/categories`), { credentials: 'include' });
    if (r.ok) setCategories(await r.json());
  }, [orgId]);

  const fetchAssets = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/assets`), { credentials: 'include' });
    if (r.ok) setAssets(await r.json());
    setLoading(false);
  }, [orgId]);

  const fetchBookings = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const params = bookingFilter ? `?status=${bookingFilter}` : '';
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/bookings${params}`), { credentials: 'include' });
    if (r.ok) setBookings(await r.json());
    setLoading(false);
  }, [orgId, bookingFilter]);

  const fetchRevenue = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/revenue`), { credentials: 'include' });
    if (r.ok) setRevenue(await r.json());
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    if (orgId) {
      fetchCategories();
      if (view === 'assets') fetchAssets();
      else if (view === 'bookings') fetchBookings();
      else if (view === 'revenue') fetchRevenue();
    }
  }, [orgId, view, fetchCategories, fetchAssets, fetchBookings, fetchRevenue]);

  useEffect(() => {
    if (view === 'bookings') fetchBookings();
  }, [bookingFilter, fetchBookings, view]);

  // ── Category CRUD ───────────────────────────────────────────────────────────

  function openNewCat() {
    setEditCat(null);
    setCatForm({ name: '', description: '', dailyRate: '', currency: 'USD', icon: 'package', sortOrder: '0' });
    setShowCatModal(true);
  }

  function openEditCat(cat: RentalCategory) {
    setEditCat(cat);
    setCatForm({ name: cat.name, description: cat.description ?? '', dailyRate: cat.dailyRate, currency: cat.currency, icon: cat.icon, sortOrder: String(cat.sortOrder) });
    setShowCatModal(true);
  }

  async function saveCat() {
    if (!orgId || !catForm.name) return;
    const body = { ...catForm, dailyRate: catForm.dailyRate || '0', sortOrder: parseInt(catForm.sortOrder) || 0 };
    const url = editCat
      ? apiUrl(`/organizations/${orgId}/rentals/categories/${editCat.id}`)
      : apiUrl(`/organizations/${orgId}/rentals/categories`);
    const method = editCat ? 'PATCH' : 'POST';
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
    if (!r.ok) { toast({ title: 'Error', description: (await r.json()).error, variant: 'destructive' }); return; }
    toast({ title: editCat ? 'Category updated' : 'Category created' });
    setShowCatModal(false);
    fetchCategories();
  }

  async function deleteCat(cat: RentalCategory) {
    if (!orgId || !confirm(`Delete category "${cat.name}"?`)) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/categories/${cat.id}`), { method: 'DELETE', credentials: 'include' });
    if (!r.ok) { toast({ title: 'Error', description: (await r.json()).error, variant: 'destructive' }); return; }
    toast({ title: 'Category deleted' });
    fetchCategories();
  }

  // ── Asset CRUD ──────────────────────────────────────────────────────────────

  function openNewAsset() {
    setEditAsset(null);
    setAssetForm({ categoryId: categories[0]?.id?.toString() ?? '', assetCode: '', description: '', condition: 'good', dailyRateOverride: '', notes: '' });
    setShowAssetModal(true);
  }

  function openEditAsset(a: RentalAsset) {
    setEditAsset(a);
    setAssetForm({ categoryId: String(a.categoryId), assetCode: a.assetCode, description: a.description ?? '', condition: a.condition, dailyRateOverride: a.dailyRateOverride ?? '', notes: a.notes ?? '' });
    setShowAssetModal(true);
  }

  async function saveAsset() {
    if (!orgId || !assetForm.categoryId || !assetForm.assetCode) return;
    const body: Record<string, unknown> = { ...assetForm, categoryId: parseInt(assetForm.categoryId), dailyRateOverride: assetForm.dailyRateOverride || null };
    const url = editAsset
      ? apiUrl(`/organizations/${orgId}/rentals/assets/${editAsset.id}`)
      : apiUrl(`/organizations/${orgId}/rentals/assets`);
    const method = editAsset ? 'PATCH' : 'POST';
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
    if (!r.ok) { toast({ title: 'Error', description: (await r.json()).error, variant: 'destructive' }); return; }
    toast({ title: editAsset ? 'Asset updated' : 'Asset registered' });
    setShowAssetModal(false);
    fetchAssets();
  }

  async function retireAsset(a: RentalAsset) {
    if (!orgId || !confirm(`Retire asset "${a.assetCode}"?`)) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/assets/${a.id}`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ isActive: false }),
    });
    if (!r.ok) { toast({ title: 'Error', description: (await r.json()).error, variant: 'destructive' }); return; }
    toast({ title: 'Asset retired' });
    fetchAssets();
  }

  // ── Bookings ────────────────────────────────────────────────────────────────

  function openNewBooking() {
    const availableAsset = assets.find(a => !a.activeBooking);
    setBookingForm({
      assetId: availableAsset ? String(availableAsset.id) : '',
      memberName: '',
      rentalDate: new Date().toISOString().slice(0, 16),
      expectedReturnAt: '',
      rateCharged: '',
      currency: 'USD',
      notes: '',
    });
    setShowBookingModal(true);
  }

  async function saveBooking() {
    if (!orgId || !bookingForm.assetId || !bookingForm.rentalDate) return;
    const body = {
      assetId: parseInt(bookingForm.assetId),
      memberName: bookingForm.memberName || null,
      rentalDate: bookingForm.rentalDate,
      expectedReturnAt: bookingForm.expectedReturnAt || null,
      rateCharged: bookingForm.rateCharged || null,
      currency: bookingForm.currency,
      notes: bookingForm.notes || null,
    };
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/bookings`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
    });
    if (!r.ok) { toast({ title: 'Error', description: (await r.json()).error, variant: 'destructive' }); return; }
    toast({ title: 'Booking created' });
    setShowBookingModal(false);
    fetchBookings();
    fetchAssets();
  }

  async function checkoutBooking(b: RentalBooking) {
    if (!orgId) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/bookings/${b.id}/checkout`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({}),
    });
    if (!r.ok) { toast({ title: 'Error', description: (await r.json()).error, variant: 'destructive' }); return; }
    toast({ title: `Asset ${b.assetCode} checked out` });
    fetchBookings();
    fetchAssets();
  }

  function openCheckin(b: RentalBooking) {
    setCheckinBooking(b);
    setCheckinForm({ damageReported: false, damageNotes: '', condition: '', notes: '' });
    setShowCheckinModal(true);
  }

  async function saveCheckin() {
    if (!orgId || !checkinBooking) return;
    const body: Record<string, unknown> = {
      damageReported: checkinForm.damageReported,
      notes: checkinForm.notes || null,
    };
    if (checkinForm.damageReported) body.damageNotes = checkinForm.damageNotes;
    if (checkinForm.condition) body.condition = checkinForm.condition;
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/bookings/${checkinBooking.id}/checkin`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
    });
    if (!r.ok) { toast({ title: 'Error', description: (await r.json()).error, variant: 'destructive' }); return; }
    toast({ title: 'Asset returned successfully' });
    setShowCheckinModal(false);
    fetchBookings();
    fetchAssets();
  }

  async function cancelBooking(b: RentalBooking) {
    if (!orgId || !confirm('Cancel this booking?')) return;
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/bookings/${b.id}/cancel`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({}),
    });
    if (!r.ok) { toast({ title: 'Error', description: (await r.json()).error, variant: 'destructive' }); return; }
    toast({ title: 'Booking cancelled' });
    fetchBookings();
    fetchAssets();
  }

  function openDamage(b: RentalBooking) {
    setDamageBooking(b);
    setDamageForm({ damageNotes: '', condition: '' });
    setShowDamageModal(true);
  }

  async function saveDamage() {
    if (!orgId || !damageBooking || !damageForm.damageNotes) return;
    const body: Record<string, unknown> = { damageNotes: damageForm.damageNotes };
    if (damageForm.condition) body.condition = damageForm.condition;
    const r = await fetch(apiUrl(`/organizations/${orgId}/rentals/bookings/${damageBooking.id}/damage`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
    });
    if (!r.ok) { toast({ title: 'Error', description: (await r.json()).error, variant: 'destructive' }); return; }
    toast({ title: 'Damage report filed' });
    setShowDamageModal(false);
    fetchBookings();
    fetchAssets();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const availableCount = assets.filter(a => !a.activeBooking).length;
  const checkedOutCount = assets.filter(a => a.activeBooking?.status === 'checked_out').length;
  const reservedCount = assets.filter(a => a.activeBooking?.status === 'reserved').length;

  return (
    <div className="min-h-screen bg-background text-foreground p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center">
            <Package className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Rental Equipment</h1>
            <p className="text-muted-foreground text-sm">Clubs, trolleys, GPS devices and more</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { if (view === 'assets') fetchAssets(); else if (view === 'bookings') fetchBookings(); else fetchRevenue(); }}>
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
          {view === 'assets' && (
            <Button size="sm" onClick={openNewAsset} className="bg-primary hover:bg-primary/90">
              <Plus className="w-4 h-4 mr-1" /> Add Asset
            </Button>
          )}
          {view === 'bookings' && (
            <Button size="sm" onClick={openNewBooking} className="bg-primary hover:bg-primary/90">
              <Plus className="w-4 h-4 mr-1" /> New Booking
            </Button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4 bg-card border-white/10">
          <p className="text-xs text-muted-foreground mb-1">Total Assets</p>
          <p className="text-2xl font-bold text-white">{assets.length}</p>
        </Card>
        <Card className="p-4 bg-card border-white/10">
          <p className="text-xs text-muted-foreground mb-1">Available</p>
          <p className="text-2xl font-bold text-green-400">{availableCount}</p>
        </Card>
        <Card className="p-4 bg-card border-white/10">
          <p className="text-xs text-muted-foreground mb-1">Checked Out</p>
          <p className="text-2xl font-bold text-yellow-400">{checkedOutCount}</p>
        </Card>
        <Card className="p-4 bg-card border-white/10">
          <p className="text-xs text-muted-foreground mb-1">Reserved</p>
          <p className="text-2xl font-bold text-blue-400">{reservedCount}</p>
        </Card>
      </div>

      {/* View Tabs */}
      <div className="flex gap-2 border-b border-white/10">
        {(['assets', 'bookings', 'revenue'] as View[]).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
              view === v ? 'border-primary text-white' : 'border-transparent text-muted-foreground hover:text-white'
            }`}
          >
            {v === 'assets' ? 'Asset Register' : v === 'bookings' ? 'Bookings' : 'Revenue'}
          </button>
        ))}
      </div>

      {/* ASSETS VIEW */}
      {view === 'assets' && (
        <div className="space-y-4">
          {/* Category management inline */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Layers className="w-4 h-4" /> Categories
            </h2>
            <Button variant="ghost" size="sm" onClick={openNewCat}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Category
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 mb-4">
            {categories.map(cat => (
              <div key={cat.id} className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm">
                <span className="text-white font-medium">{cat.name}</span>
                <span className="text-muted-foreground">{cat.currency} {parseFloat(cat.dailyRate).toFixed(2)}/day</span>
                <button onClick={() => openEditCat(cat)} className="text-muted-foreground hover:text-white ml-1">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => deleteCat(cat)} className="text-muted-foreground hover:text-red-400">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {categories.length === 0 && (
              <p className="text-muted-foreground text-sm">No categories yet. Add one to start.</p>
            )}
          </div>

          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Package className="w-4 h-4" /> Assets
          </h2>

          {loading && <p className="text-muted-foreground">Loading...</p>}

          {!loading && assets.length === 0 && (
            <Card className="p-8 bg-card border-white/10 text-center">
              <Package className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-white font-medium">No rental assets yet</p>
              <p className="text-muted-foreground text-sm mt-1">Add categories first, then register your rental items.</p>
            </Card>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {assets.map(asset => {
              const active = asset.activeBooking;
              return (
                <Card key={asset.id} className="p-4 bg-card border-white/10 flex flex-col gap-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-bold text-white text-base">{asset.assetCode}</p>
                      <p className="text-muted-foreground text-xs">{asset.categoryName}</p>
                      {asset.description && <p className="text-sm text-white/70 mt-0.5">{asset.description}</p>}
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => openEditAsset(asset)} className="text-muted-foreground hover:text-white p-1">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => retireAsset(asset)} className="text-muted-foreground hover:text-red-400 p-1">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={`text-xs border ${CONDITION_COLOR[asset.condition]}`}>
                      {asset.condition}
                    </Badge>
                    {active ? (
                      <Badge className={`text-xs border ${STATUS_COLOR[active.status as BookingStatus]}`}>
                        {active.status === 'checked_out' ? 'Out' : 'Reserved'}
                        {active.memberName ? ` — ${active.memberName}` : ''}
                      </Badge>
                    ) : (
                      <Badge className="text-xs border bg-green-500/20 text-green-400 border-green-500/30">Available</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <DollarSign className="w-3.5 h-3.5 inline mr-0.5" />
                    {asset.currency} {parseFloat(asset.effectiveRate).toFixed(2)}/day
                    {asset.dailyRateOverride && <span className="text-xs ml-1 text-yellow-400">(custom rate)</span>}
                  </p>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* BOOKINGS VIEW */}
      {view === 'bookings' && (
        <div className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            {[
              { label: 'Active', value: 'reserved,checked_out' },
              { label: 'Reserved', value: 'reserved' },
              { label: 'Checked Out', value: 'checked_out' },
              { label: 'Returned', value: 'returned' },
              { label: 'All', value: '' },
            ].map(f => (
              <button
                key={f.value}
                onClick={() => setBookingFilter(f.value)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  bookingFilter === f.value ? 'bg-primary text-white border-primary' : 'border-white/20 text-muted-foreground hover:text-white'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {loading && <p className="text-muted-foreground">Loading...</p>}

          {!loading && bookings.length === 0 && (
            <Card className="p-8 bg-card border-white/10 text-center">
              <Clock className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-white font-medium">No bookings found</p>
            </Card>
          )}

          <div className="space-y-3">
            {bookings.map(b => (
              <Card key={b.id} className="p-4 bg-card border-white/10">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-bold text-white">{b.assetCode}</span>
                      <span className="text-muted-foreground text-xs">{b.categoryName}</span>
                      <Badge className={`text-xs border ${STATUS_COLOR[b.status]}`}>{b.status.replace('_', ' ')}</Badge>
                      {b.damageReported && (
                        <Badge className="text-xs border bg-red-500/20 text-red-400 border-red-500/30">
                          <ShieldAlert className="w-3 h-3 mr-0.5" /> Damage
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-white/70">
                      {b.memberName || 'Unknown member'} · {new Date(b.rentalDate).toLocaleDateString()}
                      {b.expectedReturnAt && ` → ${new Date(b.expectedReturnAt).toLocaleDateString()}`}
                    </p>
                    {b.notes && <p className="text-xs text-muted-foreground mt-1">{b.notes}</p>}
                    {b.damageNotes && <p className="text-xs text-red-400 mt-1">Damage: {b.damageNotes}</p>}
                  </div>
                  <div className="flex flex-col gap-1.5 items-end shrink-0">
                    {b.status === 'reserved' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => checkoutBooking(b)} className="text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10 h-7 text-xs">
                          <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Check Out
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => cancelBooking(b)} className="text-red-400 hover:bg-red-500/10 h-7 text-xs">
                          <X className="w-3.5 h-3.5 mr-1" /> Cancel
                        </Button>
                      </>
                    )}
                    {b.status === 'checked_out' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => openCheckin(b)} className="text-green-400 border-green-500/30 hover:bg-green-500/10 h-7 text-xs">
                          <RotateCcw className="w-3.5 h-3.5 mr-1" /> Return
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openDamage(b)} className="text-red-400 hover:bg-red-500/10 h-7 text-xs">
                          <ShieldAlert className="w-3.5 h-3.5 mr-1" /> Report Damage
                        </Button>
                      </>
                    )}
                    {b.rateCharged && (
                      <span className="text-xs text-muted-foreground">{b.currency} {parseFloat(b.rateCharged).toFixed(2)}</span>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* REVENUE VIEW */}
      {view === 'revenue' && (
        <div className="space-y-4">
          {loading && <p className="text-muted-foreground">Loading...</p>}
          {revenue && (
            <>
              <Card className="p-4 bg-card border-white/10">
                <p className="text-xs text-muted-foreground mb-1">Grand Total Revenue</p>
                <p className="text-3xl font-bold text-primary">
                  {revenue.grandTotal.toFixed(2)}
                </p>
              </Card>
              <div className="space-y-3">
                {revenue.categories.map(cat => (
                  <Card key={cat.categoryId} className="bg-card border-white/10 overflow-hidden">
                    <button
                      className="w-full p-4 flex items-center justify-between hover:bg-white/5 transition-colors"
                      onClick={() => setExpandedRevCat(expandedRevCat === cat.categoryId ? null : cat.categoryId)}
                    >
                      <div className="flex items-center gap-3">
                        <Package className="w-4 h-4 text-primary" />
                        <span className="font-semibold text-white">{cat.categoryName}</span>
                        <Badge className="text-xs border border-white/20 text-muted-foreground">{cat.totalBookings} bookings</Badge>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-bold text-white">{cat.currency} {cat.totalRevenue.toFixed(2)}</span>
                        {expandedRevCat === cat.categoryId ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                      </div>
                    </button>
                    {expandedRevCat === cat.categoryId && (
                      <div className="border-t border-white/10 p-4 space-y-2">
                        {cat.assets.map(a => (
                          <div key={a.assetId} className="flex items-center justify-between text-sm">
                            <span className="text-white">{a.assetCode}</span>
                            <div className="flex items-center gap-4 text-muted-foreground">
                              <span>{a.totalBookings} bookings</span>
                              <span className="text-white font-medium">{cat.currency} {a.totalRevenue.toFixed(2)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                ))}
                {revenue.categories.length === 0 && (
                  <Card className="p-8 bg-card border-white/10 text-center">
                    <BarChart2 className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                    <p className="text-white font-medium">No revenue data yet</p>
                    <p className="text-muted-foreground text-sm">Revenue appears once bookings have been checked out or returned.</p>
                  </Card>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Category Modal ── */}
      <Dialog open={showCatModal} onOpenChange={setShowCatModal}>
        <DialogContent className="bg-card border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>{editCat ? 'Edit Category' : 'New Rental Category'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-muted-foreground text-xs">Name *</Label>
              <Input value={catForm.name} onChange={e => setCatForm(f => ({ ...f, name: e.target.value }))} className="bg-background border-white/20 text-white mt-1" placeholder="e.g. Golf Clubs" />
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">Description</Label>
              <Input value={catForm.description} onChange={e => setCatForm(f => ({ ...f, description: e.target.value }))} className="bg-background border-white/20 text-white mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground text-xs">Daily Rate</Label>
                <Input type="number" value={catForm.dailyRate} onChange={e => setCatForm(f => ({ ...f, dailyRate: e.target.value }))} className="bg-background border-white/20 text-white mt-1" placeholder="0.00" />
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Currency</Label>
                <Input value={catForm.currency} onChange={e => setCatForm(f => ({ ...f, currency: e.target.value }))} className="bg-background border-white/20 text-white mt-1" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCatModal(false)}>Cancel</Button>
            <Button onClick={saveCat} className="bg-primary hover:bg-primary/90">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Asset Modal ── */}
      <Dialog open={showAssetModal} onOpenChange={setShowAssetModal}>
        <DialogContent className="bg-card border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>{editAsset ? 'Edit Asset' : 'Register Rental Asset'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-muted-foreground text-xs">Category *</Label>
              <select
                value={assetForm.categoryId}
                onChange={e => setAssetForm(f => ({ ...f, categoryId: e.target.value }))}
                className="w-full mt-1 bg-background border border-white/20 rounded-md px-3 py-2 text-white text-sm"
              >
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">Asset Code *</Label>
              <Input value={assetForm.assetCode} onChange={e => setAssetForm(f => ({ ...f, assetCode: e.target.value }))} className="bg-background border-white/20 text-white mt-1" placeholder="e.g. CLUBS-001" />
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">Description</Label>
              <Input value={assetForm.description} onChange={e => setAssetForm(f => ({ ...f, description: e.target.value }))} className="bg-background border-white/20 text-white mt-1" placeholder="e.g. Half set, right-handed" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground text-xs">Condition</Label>
                <select
                  value={assetForm.condition}
                  onChange={e => setAssetForm(f => ({ ...f, condition: e.target.value as AssetCondition }))}
                  className="w-full mt-1 bg-background border border-white/20 rounded-md px-3 py-2 text-white text-sm"
                >
                  {(['excellent', 'good', 'fair', 'poor', 'damaged'] as AssetCondition[]).map(c => (
                    <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Custom Daily Rate (optional)</Label>
                <Input type="number" value={assetForm.dailyRateOverride} onChange={e => setAssetForm(f => ({ ...f, dailyRateOverride: e.target.value }))} className="bg-background border-white/20 text-white mt-1" placeholder="Category default" />
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">Notes</Label>
              <Input value={assetForm.notes} onChange={e => setAssetForm(f => ({ ...f, notes: e.target.value }))} className="bg-background border-white/20 text-white mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAssetModal(false)}>Cancel</Button>
            <Button onClick={saveAsset} className="bg-primary hover:bg-primary/90">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── New Booking Modal ── */}
      <Dialog open={showBookingModal} onOpenChange={setShowBookingModal}>
        <DialogContent className="bg-card border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>New Rental Booking</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-muted-foreground text-xs">Asset *</Label>
              <select
                value={bookingForm.assetId}
                onChange={e => setBookingForm(f => ({ ...f, assetId: e.target.value }))}
                className="w-full mt-1 bg-background border border-white/20 rounded-md px-3 py-2 text-white text-sm"
              >
                <option value="">Select asset...</option>
                {assets.filter(a => !a.activeBooking).map(a => (
                  <option key={a.id} value={a.id}>{a.assetCode} — {a.categoryName}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">Member / Player Name</Label>
              <Input value={bookingForm.memberName} onChange={e => setBookingForm(f => ({ ...f, memberName: e.target.value }))} className="bg-background border-white/20 text-white mt-1" placeholder="Name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground text-xs">Rental Date *</Label>
                <Input type="datetime-local" value={bookingForm.rentalDate} onChange={e => setBookingForm(f => ({ ...f, rentalDate: e.target.value }))} className="bg-background border-white/20 text-white mt-1" />
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Expected Return</Label>
                <Input type="datetime-local" value={bookingForm.expectedReturnAt} onChange={e => setBookingForm(f => ({ ...f, expectedReturnAt: e.target.value }))} className="bg-background border-white/20 text-white mt-1" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground text-xs">Rate Charged</Label>
                <Input type="number" value={bookingForm.rateCharged} onChange={e => setBookingForm(f => ({ ...f, rateCharged: e.target.value }))} className="bg-background border-white/20 text-white mt-1" placeholder="0.00" />
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Currency</Label>
                <Input value={bookingForm.currency} onChange={e => setBookingForm(f => ({ ...f, currency: e.target.value }))} className="bg-background border-white/20 text-white mt-1" />
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">Notes</Label>
              <Input value={bookingForm.notes} onChange={e => setBookingForm(f => ({ ...f, notes: e.target.value }))} className="bg-background border-white/20 text-white mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowBookingModal(false)}>Cancel</Button>
            <Button onClick={saveBooking} className="bg-primary hover:bg-primary/90">Create Booking</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Check-in Modal ── */}
      <Dialog open={showCheckinModal} onOpenChange={setShowCheckinModal}>
        <DialogContent className="bg-card border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>Return Asset — {checkinBooking?.assetCode}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="damage-check"
                checked={checkinForm.damageReported}
                onChange={e => setCheckinForm(f => ({ ...f, damageReported: e.target.checked }))}
                className="w-4 h-4"
              />
              <Label htmlFor="damage-check" className="text-white cursor-pointer">Damage reported on return</Label>
            </div>
            {checkinForm.damageReported && (
              <div>
                <Label className="text-muted-foreground text-xs">Damage Notes</Label>
                <Input value={checkinForm.damageNotes} onChange={e => setCheckinForm(f => ({ ...f, damageNotes: e.target.value }))} className="bg-background border-white/20 text-white mt-1" placeholder="Describe damage..." />
              </div>
            )}
            <div>
              <Label className="text-muted-foreground text-xs">Asset Condition After Return</Label>
              <select
                value={checkinForm.condition}
                onChange={e => setCheckinForm(f => ({ ...f, condition: e.target.value as AssetCondition }))}
                className="w-full mt-1 bg-background border border-white/20 rounded-md px-3 py-2 text-white text-sm"
              >
                <option value="">Unchanged</option>
                {(['excellent', 'good', 'fair', 'poor', 'damaged'] as AssetCondition[]).map(c => (
                  <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">Return Notes</Label>
              <Input value={checkinForm.notes} onChange={e => setCheckinForm(f => ({ ...f, notes: e.target.value }))} className="bg-background border-white/20 text-white mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCheckinModal(false)}>Cancel</Button>
            <Button onClick={saveCheckin} className="bg-green-600 hover:bg-green-700">Confirm Return</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Damage Report Modal ── */}
      <Dialog open={showDamageModal} onOpenChange={setShowDamageModal}>
        <DialogContent className="bg-card border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>File Damage Report — {damageBooking?.assetCode}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-muted-foreground text-xs">Damage Description *</Label>
              <Input value={damageForm.damageNotes} onChange={e => setDamageForm(f => ({ ...f, damageNotes: e.target.value }))} className="bg-background border-white/20 text-white mt-1" placeholder="Describe the damage..." />
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">Update Asset Condition</Label>
              <select
                value={damageForm.condition}
                onChange={e => setDamageForm(f => ({ ...f, condition: e.target.value as AssetCondition }))}
                className="w-full mt-1 bg-background border border-white/20 rounded-md px-3 py-2 text-white text-sm"
              >
                <option value="">No change</option>
                {(['poor', 'damaged'] as AssetCondition[]).map(c => (
                  <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDamageModal(false)}>Cancel</Button>
            <Button onClick={saveDamage} className="bg-red-600 hover:bg-red-700">
              <ShieldAlert className="w-4 h-4 mr-1" /> File Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
