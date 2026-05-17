import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import {
  ChevronLeft, Plus, User, Clock, Trash2, Edit3, Save, X,
  RefreshCw, IndianRupee, Calendar, TrendingUp, BarChart3, CheckCircle2,
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

const GOLD = '#C9A84C';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatPrice(paise: number): string {
  if (paise === 0) return 'Free';
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

interface Pro {
  id: number;
  displayName: string;
  email: string | null;
  phone: string | null;
  bio: string | null;
  photoUrl: string | null;
  specialisms: string[];
  cancellationWindowHours: number;
  isActive: boolean;
}

interface LessonType {
  id: number;
  proId: number;
  name: string;
  description: string | null;
  durationMinutes: number;
  pricePaise: number;
  isActive: boolean;
}

interface Availability {
  id: number;
  dayOfWeek: number | null;
  startTime: string | null;
  endTime: string | null;
  isBlocked: boolean;
  slotIntervalMinutes: number;
}

interface Booking {
  id: number;
  proId: number;
  proName?: string;
  lessonTypeName?: string;
  memberName: string;
  memberEmail: string | null;
  scheduledAt: string;
  durationMinutes: number;
  status: string;
  paymentStatus: string;
  amountPaise: number;
}

interface Revenue {
  kpis: {
    totalBookings: number;
    confirmedBookings: number;
    cancelledBookings: number;
    completedBookings: number;
    totalRevenuePaise: number;
  };
  byPro: { proName: string; bookings: number; revenuePaise: number }[];
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-amber-500/20 text-amber-300',
  confirmed: 'bg-emerald-500/20 text-emerald-300',
  cancelled: 'bg-red-500/20 text-red-300',
  completed: 'bg-blue-500/20 text-blue-300',
  no_show: 'bg-white/10 text-white/50',
};

export default function LessonsAdminPage() {
  const [, navigate] = useLocation();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const { toast } = useToast();

  const [tab, setTab] = useState<'pros' | 'bookings' | 'revenue'>('pros');
  const [pros, setPros] = useState<Pro[]>([]);
  const [selectedPro, setSelectedPro] = useState<Pro | null>(null);
  const [lessonTypes, setLessonTypes] = useState<LessonType[]>([]);
  const [availability, setAvailability] = useState<Availability[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [revenue, setRevenue] = useState<Revenue | null>(null);
  const [loading, setLoading] = useState(false);

  // Dialogs
  const [proDialog, setProDialog] = useState(false);
  const [editingPro, setEditingPro] = useState<Partial<Pro>>({});
  const [ltDialog, setLtDialog] = useState(false);
  const [editingLt, setEditingLt] = useState<Partial<LessonType>>({});
  const [availDialog, setAvailDialog] = useState(false);
  const [newAvail, setNewAvail] = useState({ dayOfWeek: 1, startTime: '09:00', endTime: '17:00', slotIntervalMinutes: 30 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    loadPros();
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    if (tab === 'bookings') loadBookings();
    if (tab === 'revenue') loadRevenue();
  }, [tab, orgId]);

  useEffect(() => {
    if (!selectedPro || !orgId) return;
    loadLessonTypes();
    loadAvailability();
  }, [selectedPro, orgId]);

  async function loadPros() {
    if (!orgId) return;
    const r = await fetch(`/api/organizations/${orgId}/lessons/pros`, { credentials: 'include' });
    if (r.ok) { const data = await r.json(); setPros(data); }
  }

  async function loadLessonTypes() {
    if (!selectedPro || !orgId) return;
    const r = await fetch(`/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/lesson-types`, { credentials: 'include' });
    if (r.ok) setLessonTypes(await r.json());
  }

  async function loadAvailability() {
    if (!selectedPro || !orgId) return;
    const r = await fetch(`/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/availability/templates`, { credentials: 'include' });
    if (r.ok) setAvailability(await r.json());
  }

  async function loadBookings() {
    if (!orgId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/lessons/admin/bookings`, { credentials: 'include' });
      if (r.ok) setBookings(await r.json());
    } finally { setLoading(false); }
  }

  async function loadRevenue() {
    if (!orgId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/lessons/admin/revenue`, { credentials: 'include' });
      if (r.ok) setRevenue(await r.json());
    } finally { setLoading(false); }
  }

  async function savePro() {
    if (!orgId) return;
    setSaving(true);
    try {
      const isEdit = !!editingPro.id;
      const url = isEdit
        ? `/api/organizations/${orgId}/lessons/pros/${editingPro.id}`
        : `/api/organizations/${orgId}/lessons/pros`;
      const r = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(editingPro),
      });
      if (r.ok) {
        toast({ title: isEdit ? 'Pro updated' : 'Pro created' });
        setProDialog(false);
        setEditingPro({});
        loadPros();
      } else {
        const d = await r.json();
        toast({ title: d.error ?? 'Failed', variant: 'destructive' });
      }
    } finally { setSaving(false); }
  }

  async function deletePro(pro: Pro) {
    if (!confirm(`Delete ${pro.displayName}? This will also remove all their lesson types and availability.`)) return;
    const r = await fetch(`/api/organizations/${orgId}/lessons/pros/${pro.id}`, {
      method: 'DELETE', credentials: 'include',
    });
    if (r.ok) { toast({ title: 'Pro deleted' }); loadPros(); if (selectedPro?.id === pro.id) setSelectedPro(null); }
  }

  async function saveLessonType() {
    if (!selectedPro || !orgId) return;
    setSaving(true);
    try {
      const isEdit = !!editingLt.id;
      const url = isEdit
        ? `/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/lesson-types/${editingLt.id}`
        : `/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/lesson-types`;
      const r = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(editingLt),
      });
      if (r.ok) {
        toast({ title: isEdit ? 'Lesson type updated' : 'Lesson type created' });
        setLtDialog(false);
        setEditingLt({});
        loadLessonTypes();
      } else {
        const d = await r.json(); toast({ title: d.error ?? 'Failed', variant: 'destructive' });
      }
    } finally { setSaving(false); }
  }

  async function deleteLt(lt: LessonType) {
    const r = await fetch(`/api/organizations/${orgId}/lessons/pros/${selectedPro!.id}/lesson-types/${lt.id}`, {
      method: 'DELETE', credentials: 'include',
    });
    if (r.ok) { toast({ title: 'Lesson type removed' }); loadLessonTypes(); }
  }

  async function saveAvailability() {
    if (!selectedPro || !orgId) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(newAvail),
      });
      if (r.ok) {
        toast({ title: 'Availability added' });
        setAvailDialog(false);
        loadAvailability();
      } else {
        const d = await r.json(); toast({ title: d.error ?? 'Failed', variant: 'destructive' });
      }
    } finally { setSaving(false); }
  }

  async function deleteAvailability(avail: Availability) {
    const r = await fetch(`/api/organizations/${orgId}/lessons/pros/${selectedPro!.id}/availability/${avail.id}`, {
      method: 'DELETE', credentials: 'include',
    });
    if (r.ok) { toast({ title: 'Availability removed' }); loadAvailability(); }
  }

  async function cancelBooking(bk: Booking) {
    if (!confirm('Cancel this booking?')) return;
    const r = await fetch(`/api/organizations/${orgId}/lessons/bookings/${bk.id}/cancel`, {
      method: 'POST', credentials: 'include',
    });
    if (r.ok) { toast({ title: 'Booking cancelled' }); loadBookings(); }
    else { const d = await r.json(); toast({ title: d.error ?? 'Failed', variant: 'destructive' }); }
  }

  if (!orgId) return null;

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-white">Lessons Management</h1>
            <p className="text-white/50 text-sm">Manage teaching professionals, lesson types, and bookings</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 flex-wrap">
          {([['pros', 'Professionals'], ['bookings', 'All Bookings'], ['revenue', 'Revenue']] as const).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={tab === key ? 'default' : 'outline'}
              style={tab === key ? { background: GOLD, color: '#000' } : {}}
              className={tab !== key ? 'border-white/20 text-white/70' : ''}
              onClick={() => setTab(key)}
            >
              {label}
            </Button>
          ))}
        </div>

        {/* ── PROS TAB ── */}
        {tab === 'pros' && (
          <div className="grid gap-6 md:grid-cols-[280px_1fr]">
            {/* Pro List */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white/50 uppercase tracking-wider">Professionals</span>
                <Button size="sm" style={{ background: GOLD, color: '#000' }}
                  onClick={() => { setEditingPro({ specialisms: [] }); setProDialog(true); }}>
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              {pros.length === 0 ? (
                <Card className="bg-[#111827] border-[#1e2d3d] p-6 text-center">
                  <User className="w-6 h-6 mx-auto mb-2 text-white/20" />
                  <p className="text-white/40 text-sm">No pros yet.</p>
                </Card>
              ) : (
                pros.map(pro => (
                  <Card
                    key={pro.id}
                    onClick={() => setSelectedPro(pro)}
                    className={`bg-[#111827] border p-3 cursor-pointer transition-all ${selectedPro?.id === pro.id ? 'border-[#C9A84C]' : 'border-[#1e2d3d] hover:border-white/20'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-white truncate">{pro.displayName}</div>
                        <div className="text-xs text-white/40">{pro.email ?? ''}</div>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        {selectedPro?.id === pro.id && <CheckCircle2 className="w-4 h-4" style={{ color: GOLD }} />}
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-white/40 hover:text-white"
                          onClick={e => { e.stopPropagation(); setEditingPro(pro); setProDialog(true); }}>
                          <Edit3 className="w-3 h-3" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-red-400 hover:text-red-300"
                          onClick={e => { e.stopPropagation(); deletePro(pro); }}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))
              )}
            </div>

            {/* Pro Detail */}
            <div className="space-y-4">
              {!selectedPro ? (
                <Card className="bg-[#111827] border-[#1e2d3d] p-12 text-center">
                  <User className="w-8 h-8 mx-auto mb-3 text-white/20" />
                  <p className="text-white/40">Select a professional to configure</p>
                </Card>
              ) : (
                <>
                  {/* Lesson Types */}
                  <Card className="bg-[#111827] border-[#1e2d3d]">
                    <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                      <span className="font-semibold text-white">Lesson Types</span>
                      <Button size="sm" style={{ background: GOLD, color: '#000' }}
                        onClick={() => { setEditingLt({ proId: selectedPro.id, durationMinutes: 60, pricePaise: 0 }); setLtDialog(true); }}>
                        <Plus className="w-4 h-4 mr-1" /> Add
                      </Button>
                    </div>
                    {lessonTypes.length === 0 ? (
                      <div className="p-6 text-center text-white/40 text-sm">No lesson types yet.</div>
                    ) : (
                      <div className="divide-y divide-white/5">
                        {lessonTypes.map(lt => (
                          <div key={lt.id} className="px-4 py-3 flex items-center justify-between gap-2">
                            <div>
                              <div className="font-medium text-white text-sm">{lt.name}</div>
                              <div className="text-xs text-white/40">
                                <Clock className="w-3 h-3 inline mr-1" />{lt.durationMinutes} min · {formatPrice(lt.pricePaise)}
                              </div>
                            </div>
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-white/40 hover:text-white"
                                onClick={() => { setEditingLt(lt); setLtDialog(true); }}>
                                <Edit3 className="w-3 h-3" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
                                onClick={() => deleteLt(lt)}>
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>

                  {/* Availability Templates */}
                  <Card className="bg-[#111827] border-[#1e2d3d]">
                    <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                      <span className="font-semibold text-white">Weekly Availability</span>
                      <Button size="sm" style={{ background: GOLD, color: '#000' }}
                        onClick={() => setAvailDialog(true)}>
                        <Plus className="w-4 h-4 mr-1" /> Add
                      </Button>
                    </div>
                    {availability.length === 0 ? (
                      <div className="p-6 text-center text-white/40 text-sm">No recurring slots configured.</div>
                    ) : (
                      <div className="divide-y divide-white/5">
                        {availability.map(av => (
                          <div key={av.id} className="px-4 py-3 flex items-center justify-between gap-2">
                            <div>
                              <div className="font-medium text-white text-sm">
                                {av.dayOfWeek != null ? DAYS[av.dayOfWeek] : 'Custom date'}
                              </div>
                              <div className="text-xs text-white/40">
                                {av.startTime} – {av.endTime} · Every {av.slotIntervalMinutes} min
                              </div>
                            </div>
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
                              onClick={() => deleteAvailability(av)}>
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── BOOKINGS TAB ── */}
        {tab === 'bookings' && (
          <div>
            {loading ? (
              <div className="flex justify-center py-16"><RefreshCw className="w-8 h-8 text-white/30 animate-spin" /></div>
            ) : bookings.length === 0 ? (
              <Card className="bg-[#111827] border-[#1e2d3d] p-12 text-center">
                <Calendar className="w-8 h-8 mx-auto mb-3 text-white/20" />
                <p className="text-white/40">No bookings found.</p>
              </Card>
            ) : (
              <Card className="bg-[#111827] border-[#1e2d3d]">
                <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                  <span className="font-semibold text-white">All Bookings</span>
                  <Button size="sm" variant="ghost" className="text-white/40 hover:text-white" onClick={loadBookings}>
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                </div>
                <div className="divide-y divide-white/5 max-h-[600px] overflow-y-auto">
                  {bookings.map(bk => (
                    <div key={bk.id} className="px-4 py-3 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-white text-sm">{bk.memberName}</span>
                          <span className="text-white/40 text-xs">with {bk.proName ?? 'Pro'}</span>
                        </div>
                        <div className="text-xs text-white/40 mt-0.5">
                          {formatDateShort(bk.scheduledAt)} at {formatTime(bk.scheduledAt)} · {bk.lessonTypeName ?? 'Lesson'} · {formatPrice(bk.amountPaise)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Badge className={`text-xs ${STATUS_COLOR[bk.status] ?? ''}`}>{bk.status}</Badge>
                        {['pending', 'confirmed'].includes(bk.status) && (
                          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-red-400 hover:text-red-300"
                            onClick={() => cancelBooking(bk)}>
                            <X className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ── REVENUE TAB ── */}
        {tab === 'revenue' && (
          <div className="space-y-4">
            {loading ? (
              <div className="flex justify-center py-16"><RefreshCw className="w-8 h-8 text-white/30 animate-spin" /></div>
            ) : revenue ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    { label: 'Total Bookings', value: String(revenue.kpis.totalBookings), icon: Calendar },
                    { label: 'Confirmed', value: String(revenue.kpis.confirmedBookings), icon: CheckCircle2 },
                    { label: 'Completed', value: String(revenue.kpis.completedBookings), icon: CheckCircle2 },
                    { label: 'Revenue (30d)', value: `₹${(revenue.kpis.totalRevenuePaise / 100).toLocaleString('en-IN')}`, icon: IndianRupee },
                  ].map(({ label, value, icon: Icon }) => (
                    <Card key={label} className="bg-[#111827] border-[#1e2d3d] p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Icon className="w-4 h-4" style={{ color: GOLD }} />
                        <span className="text-xs text-white/50">{label}</span>
                      </div>
                      <div className="text-2xl font-bold text-white">{value}</div>
                    </Card>
                  ))}
                </div>

                {revenue.byPro.length > 0 && (
                  <Card className="bg-[#111827] border-[#1e2d3d]">
                    <div className="px-4 py-3 border-b border-white/5">
                      <span className="font-semibold text-white">Revenue by Pro</span>
                    </div>
                    <div className="divide-y divide-white/5">
                      {revenue.byPro.sort((a, b) => b.revenuePaise - a.revenuePaise).map(p => (
                        <div key={p.proName} className="px-4 py-3 flex items-center justify-between gap-4">
                          <div>
                            <div className="font-medium text-white text-sm">{p.proName}</div>
                            <div className="text-xs text-white/40">{p.bookings} booking{p.bookings !== 1 ? 's' : ''}</div>
                          </div>
                          <span className="font-bold text-white">₹{(p.revenuePaise / 100).toLocaleString('en-IN')}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* Pro Dialog */}
      <Dialog open={proDialog} onOpenChange={setProDialog}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingPro.id ? 'Edit Pro' : 'Add Teaching Professional'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-4 max-h-[60vh] overflow-y-auto">
            <div>
              <Label className="text-white/60 text-sm">Display Name *</Label>
              <Input value={editingPro.displayName ?? ''} onChange={e => setEditingPro(p => ({ ...p, displayName: e.target.value }))}
                className="mt-1 bg-white/5 border-white/20 text-white" placeholder="Coach Name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-white/60 text-sm">Email</Label>
                <Input value={editingPro.email ?? ''} onChange={e => setEditingPro(p => ({ ...p, email: e.target.value }))}
                  className="mt-1 bg-white/5 border-white/20 text-white" placeholder="coach@club.com" />
              </div>
              <div>
                <Label className="text-white/60 text-sm">Phone</Label>
                <Input value={editingPro.phone ?? ''} onChange={e => setEditingPro(p => ({ ...p, phone: e.target.value }))}
                  className="mt-1 bg-white/5 border-white/20 text-white" placeholder="+91..." />
              </div>
            </div>
            <div>
              <Label className="text-white/60 text-sm">Bio</Label>
              <Textarea value={editingPro.bio ?? ''} onChange={e => setEditingPro(p => ({ ...p, bio: e.target.value }))}
                className="mt-1 bg-white/5 border-white/20 text-white resize-none" rows={3} placeholder="Brief description..." />
            </div>
            <div>
              <Label className="text-white/60 text-sm">Photo URL</Label>
              <Input value={editingPro.photoUrl ?? ''} onChange={e => setEditingPro(p => ({ ...p, photoUrl: e.target.value }))}
                className="mt-1 bg-white/5 border-white/20 text-white" placeholder="https://..." />
            </div>
            <div>
              <Label className="text-white/60 text-sm">Specialisms (comma-separated)</Label>
              <Input
                value={(editingPro.specialisms ?? []).join(', ')}
                onChange={e => setEditingPro(p => ({ ...p, specialisms: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                className="mt-1 bg-white/5 border-white/20 text-white" placeholder="Driving, Short game, Putting" />
            </div>
            <div>
              <Label className="text-white/60 text-sm">Cancellation Window (hours)</Label>
              <Input type="number" value={editingPro.cancellationWindowHours ?? 24}
                onChange={e => setEditingPro(p => ({ ...p, cancellationWindowHours: parseInt(e.target.value) || 24 }))}
                className="mt-1 bg-white/5 border-white/20 text-white" min={0} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setProDialog(false)}>Cancel</Button>
            <Button onClick={savePro} disabled={saving || !editingPro.displayName} style={{ background: GOLD, color: '#000' }}>
              <Save className="w-4 h-4 mr-1" />{saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lesson Type Dialog */}
      <Dialog open={ltDialog} onOpenChange={setLtDialog}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white">
          <DialogHeader>
            <DialogTitle>{editingLt.id ? 'Edit Lesson Type' : 'Add Lesson Type'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <div>
              <Label className="text-white/60 text-sm">Name *</Label>
              <Input value={editingLt.name ?? ''} onChange={e => setEditingLt(p => ({ ...p, name: e.target.value }))}
                className="mt-1 bg-white/5 border-white/20 text-white" placeholder="60-min Lesson" />
            </div>
            <div>
              <Label className="text-white/60 text-sm">Description</Label>
              <Textarea value={editingLt.description ?? ''} onChange={e => setEditingLt(p => ({ ...p, description: e.target.value }))}
                className="mt-1 bg-white/5 border-white/20 text-white resize-none" rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-white/60 text-sm">Duration (minutes)</Label>
                <Input type="number" value={editingLt.durationMinutes ?? 60}
                  onChange={e => setEditingLt(p => ({ ...p, durationMinutes: parseInt(e.target.value) || 60 }))}
                  className="mt-1 bg-white/5 border-white/20 text-white" min={15} step={15} />
              </div>
              <div>
                <Label className="text-white/60 text-sm">Price (₹)</Label>
                <Input type="number" value={editingLt.pricePaise != null ? editingLt.pricePaise / 100 : 0}
                  onChange={e => setEditingLt(p => ({ ...p, pricePaise: Math.round(parseFloat(e.target.value) * 100) || 0 }))}
                  className="mt-1 bg-white/5 border-white/20 text-white" min={0} step={100} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLtDialog(false)}>Cancel</Button>
            <Button onClick={saveLessonType} disabled={saving || !editingLt.name} style={{ background: GOLD, color: '#000' }}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Availability Dialog */}
      <Dialog open={availDialog} onOpenChange={setAvailDialog}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white">
          <DialogHeader>
            <DialogTitle>Add Weekly Availability</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <div>
              <Label className="text-white/60 text-sm">Day of Week</Label>
              <select
                value={newAvail.dayOfWeek}
                onChange={e => setNewAvail(p => ({ ...p, dayOfWeek: parseInt(e.target.value) }))}
                className="mt-1 w-full bg-white/5 border border-white/20 text-white rounded-md px-3 py-2 text-sm"
              >
                {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-white/60 text-sm">Start Time</Label>
                <Input type="time" value={newAvail.startTime}
                  onChange={e => setNewAvail(p => ({ ...p, startTime: e.target.value }))}
                  className="mt-1 bg-white/5 border-white/20 text-white" />
              </div>
              <div>
                <Label className="text-white/60 text-sm">End Time</Label>
                <Input type="time" value={newAvail.endTime}
                  onChange={e => setNewAvail(p => ({ ...p, endTime: e.target.value }))}
                  className="mt-1 bg-white/5 border-white/20 text-white" />
              </div>
            </div>
            <div>
              <Label className="text-white/60 text-sm">Slot Interval (minutes)</Label>
              <select
                value={newAvail.slotIntervalMinutes}
                onChange={e => setNewAvail(p => ({ ...p, slotIntervalMinutes: parseInt(e.target.value) }))}
                className="mt-1 w-full bg-white/5 border border-white/20 text-white rounded-md px-3 py-2 text-sm"
              >
                {[15, 30, 45, 60, 90, 120].map(n => <option key={n} value={n}>{n} min</option>)}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAvailDialog(false)}>Cancel</Button>
            <Button onClick={saveAvailability} disabled={saving} style={{ background: GOLD, color: '#000' }}>
              {saving ? 'Saving...' : 'Add Slot'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
