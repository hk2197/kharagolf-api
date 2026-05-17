import { useState, useCallback } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Edit2, Trash2, Star, User, Phone, Mail, Globe, Calendar,
  BarChart2, CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp,
  AlertTriangle, Activity, Award, Search, RefreshCw, DollarSign,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgId } from '@/context/ActiveOrgContext';

const GOLD = '#C9A84C';

const EXPERIENCE_LABELS: Record<string, string> = {
  trainee: 'Trainee',
  junior: 'Junior',
  standard: 'Standard',
  senior: 'Senior',
  master: 'Master',
};

const EXPERIENCE_COLORS: Record<string, string> = {
  trainee: 'bg-slate-500/20 text-slate-300',
  junior: 'bg-blue-500/20 text-blue-300',
  standard: 'bg-green-500/20 text-green-300',
  senior: 'bg-amber-500/20 text-amber-300',
  master: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
};

const STATUS_COLORS: Record<string, string> = {
  requested: 'bg-sky-500/20 text-sky-300',
  assigned: 'bg-blue-500/20 text-blue-300',
  confirmed: 'bg-green-500/20 text-green-300',
  in_progress: 'bg-amber-500/20 text-amber-300',
  completed: 'bg-emerald-500/20 text-emerald-300',
  cancelled: 'bg-red-500/20 text-red-300',
  no_show: 'bg-rose-500/20 text-rose-300',
};

const STATUS_LABELS: Record<string, string> = {
  requested: 'Requested',
  assigned: 'Assigned',
  confirmed: 'Confirmed',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No Show',
};

interface CaddieProfile {
  id: number;
  name: string;
  photoUrl: string | null;
  experienceLevel: string;
  yearsExperience: number;
  languages: string[];
  bio: string | null;
  phone: string | null;
  email: string | null;
  feePerRound: string;
  currency: string;
  isActive: boolean;
  averageRating: string | null;
  totalRatings: number;
  totalRounds: number;
  totalEarnings: string;
  notes: string | null;
  userId: number | null;
}

interface CaddieAssignment {
  id: number;
  teeBookingId: number;
  caddieId: number;
  caddieName: string | null;
  caddieExperience: string | null;
  caddiePhoto: string | null;
  memberId: number | null;
  memberName: string | null;
  status: string;
  feeCharged: string | null;
  tipAmount: string | null;
  feeAddedToBooking: boolean;
  notes: string | null;
  slotDate: string | null;
  slotTime: string | null;
  createdAt: string;
}

interface UtilisationRow {
  caddieId: number;
  caddieName: string;
  experienceLevel: string;
  averageRating: string | null;
  totalRatings: number;
  totalAssignments: number;
  completedRounds: number;
  totalFees: number;
  totalTips: number;
  totalEarnings: number;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
function apiUrl(path: string) { return `${BASE}/api${path}`; }

function StarRating({ value }: { value: string | null }) {
  const n = value ? parseFloat(value) : 0;
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} className={`w-3.5 h-3.5 ${i <= Math.round(n) ? 'fill-amber-400 text-amber-400' : 'text-white/20'}`} />
      ))}
      {value && <span className="text-xs text-white/60 ml-1">{parseFloat(value).toFixed(1)}</span>}
    </div>
  );
}

export default function CaddiesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me } = useGetMe({ query: { retry: false } });
  const orgId = useActiveOrgId();

  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingCaddie, setEditingCaddie] = useState<CaddieProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [assignStatusId, setAssignStatusId] = useState<number | null>(null);
  const [newStatus, setNewStatus] = useState('');

  const [form, setForm] = useState({
    name: '', bio: '', phone: '', email: '',
    experienceLevel: 'standard', yearsExperience: '0',
    languages: '', feePerRound: '0', currency: 'INR', notes: '',
    photoUrl: '', isActive: true,
  });

  const { data: caddiesData, refetch: refetchCaddies } = useQuery({
    queryKey: [`/api/organizations/${orgId}/caddies`, { includeInactive: showInactive }],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/caddies?includeInactive=${showInactive}`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: assignmentsData, refetch: refetchAssignments } = useQuery({
    queryKey: [`/api/organizations/${orgId}/caddie-assignments`],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/caddie-assignments`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: reportData } = useQuery({
    queryKey: [`/api/organizations/${orgId}/caddies/report/utilisation`],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/caddies/report/utilisation`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const caddies: CaddieProfile[] = caddiesData?.caddies ?? [];
  const assignments: CaddieAssignment[] = assignmentsData?.assignments ?? [];
  const report: UtilisationRow[] = reportData?.report ?? [];

  const filtered = caddies.filter(c =>
    !search ||
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.email ?? '').toLowerCase().includes(search.toLowerCase())
  );

  function openCreate() {
    setEditingCaddie(null);
    setForm({ name: '', bio: '', phone: '', email: '', experienceLevel: 'standard', yearsExperience: '0', languages: '', feePerRound: '0', currency: 'INR', notes: '', photoUrl: '', isActive: true });
    setShowForm(true);
  }

  function openEdit(c: CaddieProfile) {
    setEditingCaddie(c);
    setForm({
      name: c.name,
      bio: c.bio ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
      experienceLevel: c.experienceLevel,
      yearsExperience: String(c.yearsExperience),
      languages: c.languages.join(', '),
      feePerRound: c.feePerRound,
      currency: c.currency,
      notes: c.notes ?? '',
      photoUrl: c.photoUrl ?? '',
      isActive: c.isActive,
    });
    setShowForm(true);
  }

  async function saveCaddie() {
    if (!form.name.trim()) { toast({ title: 'Name is required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        bio: form.bio || null,
        phone: form.phone || null,
        email: form.email || null,
        experienceLevel: form.experienceLevel,
        yearsExperience: parseInt(form.yearsExperience) || 0,
        languages: form.languages ? form.languages.split(',').map(l => l.trim()).filter(Boolean) : [],
        feePerRound: parseFloat(form.feePerRound) || 0,
        currency: form.currency,
        notes: form.notes || null,
        photoUrl: form.photoUrl || null,
        isActive: form.isActive,
      };

      const url = editingCaddie
        ? apiUrl(`/organizations/${orgId}/caddies/${editingCaddie.id}`)
        : apiUrl(`/organizations/${orgId}/caddies`);
      const method = editingCaddie ? 'PATCH' : 'POST';

      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed');

      toast({ title: editingCaddie ? 'Caddie updated' : 'Caddie created' });
      setShowForm(false);
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/caddies`] });
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' });
    } finally { setSaving(false); }
  }

  async function deactivateCaddie(id: number) {
    if (!confirm('Deactivate this caddie?')) return;
    const res = await fetch(apiUrl(`/organizations/${orgId}/caddies/${id}`), { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      toast({ title: 'Caddie deactivated' });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/caddies`] });
    }
  }

  async function updateAssignmentStatus(id: number, status: string) {
    const res = await fetch(apiUrl(`/organizations/${orgId}/caddie-assignments/${id}/status`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      toast({ title: 'Status updated' });
      setAssignStatusId(null);
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/caddie-assignments`] });
    } else {
      const d = await res.json();
      toast({ title: 'Error', description: d.error, variant: 'destructive' });
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <User className="w-6 h-6" style={{ color: GOLD }} />
            Caddie Management
          </h1>
          <p className="text-white/50 text-sm mt-1">Manage your caddie roster, assignments, and performance</p>
        </div>
        <Button onClick={openCreate} className="gap-2" style={{ background: GOLD, color: '#000' }}>
          <Plus className="w-4 h-4" /> Add Caddie
        </Button>
      </div>

      <Tabs defaultValue="roster">
        <TabsList className="bg-white/5">
          <TabsTrigger value="roster">Caddie Roster</TabsTrigger>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
          <TabsTrigger value="report">Utilisation Report</TabsTrigger>
        </TabsList>

        {/* ROSTER TAB */}
        <TabsContent value="roster" className="space-y-4">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
              <Input
                placeholder="Search caddies..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 bg-white/5 border-white/10"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={showInactive} onCheckedChange={v => { setShowInactive(v); }} />
              <span className="text-sm text-white/60">Show Inactive</span>
            </div>
            <Button variant="outline" size="icon" onClick={() => refetchCaddies()} className="border-white/10">
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>

          {filtered.length === 0 ? (
            <div className="text-center py-12 text-white/40">
              <User className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No caddies found. Add your first caddie to get started.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filtered.map(c => (
                <Card key={c.id} className={`bg-white/5 border-white/10 ${!c.isActive ? 'opacity-50' : ''}`}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {c.photoUrl
                          ? <img src={c.photoUrl} alt={c.name} className="w-full h-full object-cover" />
                          : <User className="w-6 h-6 text-white/40" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-white truncate">{c.name}</h3>
                          {!c.isActive && <Badge className="text-[10px] bg-red-500/20 text-red-300">Inactive</Badge>}
                        </div>
                        <Badge className={`text-[10px] mt-0.5 ${EXPERIENCE_COLORS[c.experienceLevel] ?? 'bg-white/10 text-white/60'}`}>
                          {EXPERIENCE_LABELS[c.experienceLevel] ?? c.experienceLevel}
                        </Badge>
                      </div>
                    </div>

                    <div className="space-y-1.5 text-sm">
                      <StarRating value={c.averageRating} />
                      {c.totalRatings > 0 && <span className="text-xs text-white/40">({c.totalRatings} ratings)</span>}
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="bg-white/5 rounded-lg p-2">
                        <div className="text-white/40 text-[10px] uppercase tracking-wider">Fee / Round</div>
                        <div className="font-semibold text-white">{c.currency} {parseFloat(c.feePerRound).toLocaleString()}</div>
                      </div>
                      <div className="bg-white/5 rounded-lg p-2">
                        <div className="text-white/40 text-[10px] uppercase tracking-wider">Rounds</div>
                        <div className="font-semibold text-white">{c.totalRounds}</div>
                      </div>
                    </div>

                    {(c.phone || c.email) && (
                      <div className="space-y-1 text-xs text-white/50">
                        {c.phone && <div className="flex items-center gap-1"><Phone className="w-3 h-3" /> {c.phone}</div>}
                        {c.email && <div className="flex items-center gap-1"><Mail className="w-3 h-3" /> {c.email}</div>}
                      </div>
                    )}

                    {c.languages.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {c.languages.map(l => (
                          <Badge key={l} className="text-[10px] bg-white/10 text-white/60">{l.toUpperCase()}</Badge>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-2 pt-1">
                      <Button variant="outline" size="sm" className="flex-1 border-white/10 text-white/70" onClick={() => openEdit(c)}>
                        <Edit2 className="w-3.5 h-3.5 mr-1" /> Edit
                      </Button>
                      {c.isActive && (
                        <Button variant="outline" size="sm" className="border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={() => deactivateCaddie(c.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ASSIGNMENTS TAB */}
        <TabsContent value="assignments" className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-white/50 text-sm">{assignments.length} total assignments</p>
            <Button variant="outline" size="sm" className="border-white/10" onClick={() => refetchAssignments()}>
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
          </div>

          {assignments.length === 0 ? (
            <div className="text-center py-12 text-white/40">
              <Calendar className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No caddie assignments yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {assignments.map(a => (
                <Card key={a.id} className="bg-white/5 border-white/10">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                          {a.caddiePhoto
                            ? <img src={a.caddiePhoto} alt={a.caddieName ?? ''} className="w-full h-full object-cover rounded-full" />
                            : <User className="w-4 h-4 text-white/40" />
                          }
                        </div>
                        <div>
                          <div className="font-medium text-white">{a.caddieName ?? 'Unknown Caddie'}</div>
                          <div className="text-xs text-white/50">
                            {a.slotDate} {a.slotTime ? `at ${a.slotTime}` : ''}
                            {a.memberName ? ` · ${a.memberName}` : ''}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        {a.feeCharged && (
                          <span className="text-sm text-white/60">₹{parseFloat(a.feeCharged).toLocaleString()}</span>
                        )}
                        <Badge className={`text-xs ${STATUS_COLORS[a.status] ?? 'bg-white/10 text-white/60'}`}>
                          {STATUS_LABELS[a.status] ?? a.status}
                        </Badge>
                        <Select
                          value={assignStatusId === a.id ? newStatus : a.status}
                          onValueChange={v => { setAssignStatusId(a.id); setNewStatus(v); updateAssignmentStatus(a.id, v); }}
                        >
                          <SelectTrigger className="w-32 h-7 text-xs border-white/10 bg-white/5">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(STATUS_LABELS).map(([val, label]) => (
                              <SelectItem key={val} value={val}>{label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* REPORT TAB */}
        <TabsContent value="report" className="space-y-4">
          {report.length === 0 ? (
            <div className="text-center py-12 text-white/40">
              <BarChart2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No data yet. Assignments will appear here once completed.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-white/50 text-xs uppercase tracking-wider">
                    <th className="text-left px-4 py-3">Caddie</th>
                    <th className="text-left px-4 py-3">Level</th>
                    <th className="text-right px-4 py-3">Rating</th>
                    <th className="text-right px-4 py-3">Assignments</th>
                    <th className="text-right px-4 py-3">Completed</th>
                    <th className="text-right px-4 py-3">Fees</th>
                    <th className="text-right px-4 py-3">Tips</th>
                    <th className="text-right px-4 py-3">Total Earned</th>
                  </tr>
                </thead>
                <tbody>
                  {report.map(r => (
                    <tr key={r.caddieId} className="border-b border-white/5 hover:bg-white/3">
                      <td className="px-4 py-3 text-white font-medium">{r.caddieName}</td>
                      <td className="px-4 py-3">
                        <Badge className={`text-[10px] ${EXPERIENCE_COLORS[r.experienceLevel] ?? 'bg-white/10 text-white/60'}`}>
                          {EXPERIENCE_LABELS[r.experienceLevel] ?? r.experienceLevel}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                          <span className="text-white">{r.averageRating ? parseFloat(r.averageRating).toFixed(1) : '—'}</span>
                          <span className="text-white/30">({r.totalRatings})</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-white">{r.totalAssignments}</td>
                      <td className="px-4 py-3 text-right text-emerald-400">{r.completedRounds}</td>
                      <td className="px-4 py-3 text-right text-white">₹{r.totalFees.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right text-amber-400">₹{r.totalTips.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-semibold" style={{ color: GOLD }}>₹{r.totalEarnings.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Create / Edit Caddie Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-card border-white/10 max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingCaddie ? 'Edit Caddie' : 'Add Caddie'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-1.5">
                <Label>Name *</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Full name" className="bg-white/5 border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label>Experience Level</Label>
                <Select value={form.experienceLevel} onValueChange={v => setForm(f => ({ ...f, experienceLevel: v }))}>
                  <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(EXPERIENCE_LABELS).map(([val, label]) => (
                      <SelectItem key={val} value={val}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Years Experience</Label>
                <Input type="number" value={form.yearsExperience} onChange={e => setForm(f => ({ ...f, yearsExperience: e.target.value }))} className="bg-white/5 border-white/10" min={0} />
              </div>
              <div className="space-y-1.5">
                <Label>Fee Per Round</Label>
                <Input type="number" value={form.feePerRound} onChange={e => setForm(f => ({ ...f, feePerRound: e.target.value }))} className="bg-white/5 border-white/10" min={0} />
              </div>
              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Input value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))} className="bg-white/5 border-white/10" placeholder="INR" />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="bg-white/5 border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="bg-white/5 border-white/10" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Languages (comma-separated, e.g. en, hi, ta)</Label>
                <Input value={form.languages} onChange={e => setForm(f => ({ ...f, languages: e.target.value }))} className="bg-white/5 border-white/10" placeholder="en, hi" />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Photo URL</Label>
                <Input value={form.photoUrl} onChange={e => setForm(f => ({ ...f, photoUrl: e.target.value }))} className="bg-white/5 border-white/10" placeholder="https://..." />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Bio</Label>
                <Textarea value={form.bio} onChange={e => setForm(f => ({ ...f, bio: e.target.value }))} className="bg-white/5 border-white/10" rows={2} />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Notes (admin only)</Label>
                <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="bg-white/5 border-white/10" rows={2} />
              </div>
              {editingCaddie && (
                <div className="col-span-2 flex items-center gap-3">
                  <Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
                  <Label>Active</Label>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)} className="border-white/10">Cancel</Button>
            <Button onClick={saveCaddie} disabled={saving} style={{ background: GOLD, color: '#000' }}>
              {saving ? 'Saving...' : editingCaddie ? 'Save Changes' : 'Add Caddie'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
