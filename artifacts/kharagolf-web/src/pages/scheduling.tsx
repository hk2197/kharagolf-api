import { useState } from 'react';
import {
  Calendar, Users, Clock, Plus, Pencil, Trash2, CheckCircle2,
  XCircle, AlertCircle, Download, RefreshCw, ChevronLeft, ChevronRight,
  UserCheck, FileText, Settings2,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
function apiUrl(path: string) { return `${BASE}/api${path}`; }

type Department = 'pro_shop' | 'food_and_beverage' | 'grounds' | 'reception' | 'administration' | 'security' | 'maintenance' | 'other';
type ShiftStatus = 'draft' | 'published' | 'confirmed' | 'cancelled';
type LeaveType = 'annual' | 'sick' | 'unpaid' | 'personal' | 'bereavement' | 'public_holiday';
type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

interface StaffProfile {
  id: number;
  userId: number | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  department: Department;
  position: string | null;
  employmentType: string;
  hourlyRate: string | null;
  currency: string;
  annualLeaveBalance: string;
  sickLeaveBalance: string;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
}

interface Roster {
  id: number;
  name: string;
  department: Department | null;
  period: 'weekly' | 'fortnightly';
  startDate: string;
  endDate: string;
  isPublished: boolean;
  publishedAt: string | null;
  notes: string | null;
  createdAt: string;
  shifts?: Shift[];
}

interface Shift {
  id: number;
  rosterId: number | null;
  staffProfileId: number;
  staffFirstName: string;
  staffLastName: string;
  date: string;
  startTime: string;
  endTime: string;
  department: Department;
  role: string | null;
  status: ShiftStatus;
  notes: string | null;
}

interface LeaveRequest {
  id: number;
  staffProfileId: number;
  staffFirstName: string;
  staffLastName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  totalDays: string;
  reason: string | null;
  status: LeaveStatus;
  reviewNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

interface TimesheetEntry {
  id: number;
  staffProfileId: number;
  staffFirstName: string;
  staffLastName: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  breakMinutes: number;
  totalMinutes: number | null;
  regularMinutes: number | null;
  overtimeMinutes: number | null;
  isManualEntry: boolean;
  isApproved: boolean;
  notes: string | null;
  createdAt: string;
}

const DEPT_LABELS: Record<Department, string> = {
  pro_shop: 'Pro Shop',
  food_and_beverage: 'F&B',
  grounds: 'Grounds',
  reception: 'Reception',
  administration: 'Administration',
  security: 'Security',
  maintenance: 'Maintenance',
  other: 'Other',
};

const DEPT_COLORS: Record<Department, string> = {
  pro_shop: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  food_and_beverage: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  grounds: 'bg-lime-500/20 text-lime-300 border-lime-500/30',
  reception: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
  administration: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  security: 'bg-red-500/20 text-red-300 border-red-500/30',
  maintenance: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  other: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
};

const LEAVE_STATUS_COLORS: Record<LeaveStatus, string> = {
  pending: 'bg-yellow-500/20 text-yellow-300',
  approved: 'bg-emerald-500/20 text-emerald-300',
  rejected: 'bg-red-500/20 text-red-300',
  cancelled: 'bg-gray-500/20 text-gray-300',
};

const SHIFT_STATUS_COLORS: Record<ShiftStatus, string> = {
  draft: 'bg-gray-500/20 text-gray-300',
  published: 'bg-sky-500/20 text-sky-300',
  confirmed: 'bg-emerald-500/20 text-emerald-300',
  cancelled: 'bg-red-500/20 text-red-300',
};

function fmtMins(mins: number | null | undefined): string {
  if (!mins) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export default function SchedulingPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me } = useGetMe();
  const orgId = me?.organizationId;

  const [tab, setTab] = useState('rosters');
  const [rosterFilter, setRosterFilter] = useState('');
  const [staffFilter, setStaffFilter] = useState<Department | 'all'>('all');
  const [leaveFilter, setLeaveFilter] = useState<LeaveStatus | 'all'>('all');
  const [tsFrom, setTsFrom] = useState(() => {
    const d = new Date(); d.setDate(1);
    return d.toISOString().split('T')[0];
  });
  const [tsTo, setTsTo] = useState(() => {
    const d = new Date();
    return d.toISOString().split('T')[0];
  });

  const [showStaffModal, setShowStaffModal] = useState(false);
  const [editStaff, setEditStaff] = useState<StaffProfile | null>(null);
  const [showRosterModal, setShowRosterModal] = useState(false);
  const [editRoster, setEditRoster] = useState<Roster | null>(null);
  const [showShiftModal, setShowShiftModal] = useState(false);
  const [shiftRosterId, setShiftRosterId] = useState<number | null>(null);
  const [editShift, setEditShift] = useState<Shift | null>(null);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [reviewLeave, setReviewLeave] = useState<LeaveRequest | null>(null);
  const [showManualEntryModal, setShowManualEntryModal] = useState(false);
  const [showOvertimeModal, setShowOvertimeModal] = useState(false);
  const [activeRoster, setActiveRoster] = useState<Roster | null>(null);

  const { data: staffList = [], isLoading: staffLoading } = useQuery<StaffProfile[]>({
    queryKey: ['staff', orgId, staffFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (staffFilter !== 'all') params.set('department', staffFilter);
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/staff?${params}`), { credentials: 'include' });
      return r.json();
    },
    enabled: !!orgId,
  });

  const { data: rosters = [], isLoading: rostersLoading } = useQuery<Roster[]>({
    queryKey: ['rosters', orgId],
    queryFn: async () => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/rosters`), { credentials: 'include' });
      return r.json();
    },
    enabled: !!orgId,
  });

  const { data: rosterDetail } = useQuery<Roster>({
    queryKey: ['roster-detail', orgId, activeRoster?.id],
    queryFn: async () => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/rosters/${activeRoster!.id}`), { credentials: 'include' });
      return r.json();
    },
    enabled: !!orgId && !!activeRoster,
  });

  const { data: leaveRequests = [], isLoading: leaveLoading } = useQuery<LeaveRequest[]>({
    queryKey: ['leave', orgId, leaveFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (leaveFilter !== 'all') params.set('status', leaveFilter);
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/leave?${params}`), { credentials: 'include' });
      return r.json();
    },
    enabled: !!orgId,
  });

  const { data: timesheets = [], isLoading: tsLoading } = useQuery<TimesheetEntry[]>({
    queryKey: ['timesheets', orgId, tsFrom, tsTo],
    queryFn: async () => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/timesheets?from=${tsFrom}&to=${tsTo}`), { credentials: 'include' });
      return r.json();
    },
    enabled: !!orgId,
  });

  const createStaff = useMutation({
    mutationFn: async (body: object) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/staff`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['staff', orgId] }); setShowStaffModal(false); toast({ title: 'Staff member added' }); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const updateStaff = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: object }) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/staff/${id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['staff', orgId] }); setShowStaffModal(false); toast({ title: 'Staff updated' }); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const deactivateStaff = useMutation({
    mutationFn: async (id: number) => {
      await fetch(apiUrl(`/organizations/${orgId}/scheduling/staff/${id}`), { method: 'DELETE', credentials: 'include' });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['staff', orgId] }); toast({ title: 'Staff deactivated' }); },
  });

  const createRoster = useMutation({
    mutationFn: async (body: object) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/rosters`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rosters', orgId] }); setShowRosterModal(false); toast({ title: 'Roster created' }); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const publishRoster = useMutation({
    mutationFn: async (rosterId: number) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/rosters/${rosterId}/publish`), { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rosters', orgId] }); toast({ title: 'Roster published — staff notified' }); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const deleteRoster = useMutation({
    mutationFn: async (id: number) => {
      await fetch(apiUrl(`/organizations/${orgId}/scheduling/rosters/${id}`), { method: 'DELETE', credentials: 'include' });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rosters', orgId] }); setActiveRoster(null); toast({ title: 'Roster deleted' }); },
  });

  const createShift = useMutation({
    mutationFn: async (body: object) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/shifts`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roster-detail', orgId, activeRoster?.id] }); setShowShiftModal(false); toast({ title: 'Shift added' }); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const deleteShift = useMutation({
    mutationFn: async (id: number) => {
      await fetch(apiUrl(`/organizations/${orgId}/scheduling/shifts/${id}`), { method: 'DELETE', credentials: 'include' });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roster-detail', orgId, activeRoster?.id] }); toast({ title: 'Shift removed' }); },
  });

  const reviewLeaveReq = useMutation({
    mutationFn: async ({ id, action, notes }: { id: number; action: 'approve' | 'reject'; notes?: string }) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/leave/${id}/${action}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ reviewNotes: notes }) });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: (_, { action }) => { qc.invalidateQueries({ queryKey: ['leave', orgId] }); setReviewLeave(null); toast({ title: action === 'approve' ? 'Leave approved' : 'Leave rejected' }); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const approveTs = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/timesheets/${id}/approve`), { method: 'PATCH', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['timesheets', orgId] }); toast({ title: 'Timesheet approved' }); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const addManualEntry = useMutation({
    mutationFn: async (body: object) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/timesheets/manual`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['timesheets', orgId] }); setShowManualEntryModal(false); toast({ title: 'Entry added' }); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  const exportCsv = () => {
    window.open(apiUrl(`/organizations/${orgId}/scheduling/timesheets/export?from=${tsFrom}&to=${tsTo}`), '_blank');
  };

  const pendingLeave = leaveRequests.filter((l) => l.status === 'pending').length;
  const pendingTs = timesheets.filter((t) => !t.isApproved).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Staff Scheduling</h1>
          <p className="text-sm text-white/50 mt-1">Rosters, shifts, leave, and timesheets</p>
        </div>
        <div className="flex items-center gap-2">
          {pendingLeave > 0 && (
            <Badge className="bg-yellow-500/20 text-yellow-300">{pendingLeave} leave pending</Badge>
          )}
          {pendingTs > 0 && (
            <Badge className="bg-sky-500/20 text-sky-300">{pendingTs} timesheets pending</Badge>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-white/5">
          <TabsTrigger value="rosters"><Calendar className="w-4 h-4 mr-1.5" />Rosters</TabsTrigger>
          <TabsTrigger value="staff"><Users className="w-4 h-4 mr-1.5" />Staff</TabsTrigger>
          <TabsTrigger value="leave"><FileText className="w-4 h-4 mr-1.5" />Leave</TabsTrigger>
          <TabsTrigger value="timesheets"><Clock className="w-4 h-4 mr-1.5" />Timesheets</TabsTrigger>
          <TabsTrigger value="settings"><Settings2 className="w-4 h-4 mr-1.5" />Rules</TabsTrigger>
        </TabsList>

        {/* ── ROSTERS ── */}
        <TabsContent value="rosters" className="mt-4">
          {activeRoster ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="sm" onClick={() => setActiveRoster(null)}>
                  <ChevronLeft className="w-4 h-4 mr-1" />Back
                </Button>
                <div className="flex-1">
                  <h2 className="font-semibold text-white">{activeRoster.name}</h2>
                  <p className="text-xs text-white/50">{activeRoster.startDate} → {activeRoster.endDate}</p>
                </div>
                {!activeRoster.isPublished && (
                  <Button size="sm" className="bg-primary" onClick={() => publishRoster.mutate(activeRoster.id)} disabled={publishRoster.isPending}>
                    Publish Roster
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => { setShiftRosterId(activeRoster.id); setEditShift(null); setShowShiftModal(true); }}>
                  <Plus className="w-4 h-4 mr-1" />Add Shift
                </Button>
              </div>
              {rosterDetail?.shifts && rosterDetail.shifts.length > 0 ? (
                <div className="grid gap-2">
                  {rosterDetail.shifts.map((s) => (
                    <Card key={s.id} className="p-3 bg-white/5 border-white/10 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-white text-sm">{s.staffFirstName} {s.staffLastName}</span>
                          <Badge className={`text-xs ${DEPT_COLORS[s.department]}`}>{DEPT_LABELS[s.department]}</Badge>
                          <Badge className={`text-xs ${SHIFT_STATUS_COLORS[s.status]}`}>{s.status}</Badge>
                        </div>
                        <p className="text-xs text-white/50 mt-0.5">{s.date} · {s.startTime}–{s.endTime}{s.role ? ` · ${s.role}` : ''}</p>
                      </div>
                      <Button variant="ghost" size="icon" className="text-red-400 hover:text-red-300" onClick={() => deleteShift.mutate(s.id)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </Card>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-white/40">
                  <Calendar className="w-8 h-8 mx-auto mb-2" />
                  <p>No shifts yet — add shifts to this roster.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Input placeholder="Search rosters…" value={rosterFilter} onChange={(e) => setRosterFilter(e.target.value)} className="bg-white/5 border-white/10 text-white max-w-xs" />
                <Button size="sm" className="bg-primary ml-auto" onClick={() => { setEditRoster(null); setShowRosterModal(true); }}>
                  <Plus className="w-4 h-4 mr-1" />New Roster
                </Button>
              </div>
              {rostersLoading ? (
                <div className="text-center py-8 text-white/40"><RefreshCw className="w-6 h-6 animate-spin mx-auto" /></div>
              ) : rosters.length === 0 ? (
                <div className="text-center py-12 text-white/40">
                  <Calendar className="w-8 h-8 mx-auto mb-2" />
                  <p>No rosters yet.</p>
                </div>
              ) : (
                <div className="grid gap-3">
                  {rosters.filter((r) => r.name.toLowerCase().includes(rosterFilter.toLowerCase())).map((r) => (
                    <Card key={r.id} className="p-4 bg-white/5 border-white/10 flex items-center gap-4 cursor-pointer hover:bg-white/10 transition-colors" onClick={() => setActiveRoster(r)}>
                      <Calendar className="w-8 h-8 text-primary flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white">{r.name}</span>
                          <Badge className={r.isPublished ? 'bg-emerald-500/20 text-emerald-300' : 'bg-gray-500/20 text-gray-300'}>{r.isPublished ? 'Published' : 'Draft'}</Badge>
                          {r.department && <Badge className={`text-xs ${DEPT_COLORS[r.department]}`}>{DEPT_LABELS[r.department]}</Badge>}
                        </div>
                        <p className="text-sm text-white/50">{r.startDate} → {r.endDate} · {r.period}</p>
                      </div>
                      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                        {!r.isPublished && (
                          <Button size="sm" variant="outline" onClick={() => publishRoster.mutate(r.id)} disabled={publishRoster.isPending}>Publish</Button>
                        )}
                        <Button variant="ghost" size="icon" className="text-red-400 hover:text-red-300" onClick={() => deleteRoster.mutate(r.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* ── STAFF ── */}
        <TabsContent value="staff" className="mt-4">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Select value={staffFilter} onValueChange={(v) => setStaffFilter(v as Department | 'all')}>
                <SelectTrigger className="w-48 bg-white/5 border-white/10 text-white">
                  <SelectValue placeholder="All departments" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All departments</SelectItem>
                  {(Object.keys(DEPT_LABELS) as Department[]).map((d) => (
                    <SelectItem key={d} value={d}>{DEPT_LABELS[d]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" className="bg-primary ml-auto" onClick={() => { setEditStaff(null); setShowStaffModal(true); }}>
                <Plus className="w-4 h-4 mr-1" />Add Staff
              </Button>
            </div>
            {staffLoading ? (
              <div className="text-center py-8 text-white/40"><RefreshCw className="w-6 h-6 animate-spin mx-auto" /></div>
            ) : staffList.length === 0 ? (
              <div className="text-center py-12 text-white/40">
                <Users className="w-8 h-8 mx-auto mb-2" />
                <p>No staff profiles yet.</p>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {staffList.map((s) => (
                  <Card key={s.id} className="p-4 bg-white/5 border-white/10">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm flex-shrink-0">
                        {s.firstName[0]}{s.lastName[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white">{s.firstName} {s.lastName}</span>
                        </div>
                        <Badge className={`mt-1 text-xs ${DEPT_COLORS[s.department]}`}>{DEPT_LABELS[s.department]}</Badge>
                        {s.position && <p className="text-xs text-white/50 mt-1">{s.position}</p>}
                        {s.email && <p className="text-xs text-white/40">{s.email}</p>}
                        <div className="flex gap-3 mt-2 text-xs text-white/50">
                          <span>Annual: {s.annualLeaveBalance}d</span>
                          <span>Sick: {s.sickLeaveBalance}d</span>
                          {s.hourlyRate && <span>{s.hourlyRate}/hr</span>}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <Button variant="ghost" size="icon" className="w-7 h-7 text-white/60 hover:text-white" onClick={() => { setEditStaff(s); setShowStaffModal(true); }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="w-7 h-7 text-red-400 hover:text-red-300" onClick={() => deactivateStaff.mutate(s.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── LEAVE ── */}
        <TabsContent value="leave" className="mt-4">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Select value={leaveFilter} onValueChange={(v) => setLeaveFilter(v as LeaveStatus | 'all')}>
                <SelectTrigger className="w-44 bg-white/5 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {leaveLoading ? (
              <div className="text-center py-8 text-white/40"><RefreshCw className="w-6 h-6 animate-spin mx-auto" /></div>
            ) : leaveRequests.length === 0 ? (
              <div className="text-center py-12 text-white/40">
                <FileText className="w-8 h-8 mx-auto mb-2" />
                <p>No leave requests.</p>
              </div>
            ) : (
              <div className="grid gap-3">
                {leaveRequests.map((l) => (
                  <Card key={l.id} className="p-4 bg-white/5 border-white/10 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-white">{l.staffFirstName} {l.staffLastName}</span>
                        <Badge className={`text-xs ${LEAVE_STATUS_COLORS[l.status]}`}>{l.status}</Badge>
                        <Badge className="text-xs bg-white/10 text-white/70">{l.leaveType.replace('_', ' ')}</Badge>
                      </div>
                      <p className="text-sm text-white/50 mt-0.5">{l.startDate} → {l.endDate} · {l.totalDays} day{Number(l.totalDays) !== 1 ? 's' : ''}</p>
                      {l.reason && <p className="text-xs text-white/40 mt-1 italic">{l.reason}</p>}
                    </div>
                    {l.status === 'pending' && (
                      <div className="flex gap-2">
                        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => { setReviewLeave(l); reviewLeaveReq.mutate({ id: l.id, action: 'approve' }); }}>
                          <CheckCircle2 className="w-4 h-4 mr-1" />Approve
                        </Button>
                        <Button size="sm" variant="outline" className="border-red-500/50 text-red-400 hover:bg-red-500/10" onClick={() => reviewLeaveReq.mutate({ id: l.id, action: 'reject' })}>
                          <XCircle className="w-4 h-4 mr-1" />Reject
                        </Button>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── TIMESHEETS ── */}
        <TabsContent value="timesheets" className="mt-4">
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Label className="text-white/70 text-sm">From</Label>
                <Input type="date" value={tsFrom} onChange={(e) => setTsFrom(e.target.value)} className="bg-white/5 border-white/10 text-white w-40" />
                <Label className="text-white/70 text-sm">To</Label>
                <Input type="date" value={tsTo} onChange={(e) => setTsTo(e.target.value)} className="bg-white/5 border-white/10 text-white w-40" />
              </div>
              <Button size="sm" variant="outline" onClick={exportCsv} className="ml-auto">
                <Download className="w-4 h-4 mr-1" />Export CSV
              </Button>
              <Button size="sm" className="bg-primary" onClick={() => setShowManualEntryModal(true)}>
                <Plus className="w-4 h-4 mr-1" />Manual Entry
              </Button>
            </div>
            {tsLoading ? (
              <div className="text-center py-8 text-white/40"><RefreshCw className="w-6 h-6 animate-spin mx-auto" /></div>
            ) : timesheets.length === 0 ? (
              <div className="text-center py-12 text-white/40">
                <Clock className="w-8 h-8 mx-auto mb-2" />
                <p>No timesheet entries for this period.</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full text-sm">
                  <thead className="border-b border-white/10">
                    <tr className="text-white/50 text-xs">
                      <th className="text-left px-4 py-2">Staff</th>
                      <th className="text-left px-4 py-2">Date</th>
                      <th className="text-left px-4 py-2">Clock In</th>
                      <th className="text-left px-4 py-2">Clock Out</th>
                      <th className="text-left px-4 py-2">Regular</th>
                      <th className="text-left px-4 py-2">Overtime</th>
                      <th className="text-left px-4 py-2">Status</th>
                      <th className="text-right px-4 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timesheets.map((t) => (
                      <tr key={t.id} className="border-b border-white/5 hover:bg-white/5">
                        <td className="px-4 py-2.5 text-white">{t.staffFirstName} {t.staffLastName}</td>
                        <td className="px-4 py-2.5 text-white/70">{t.date}</td>
                        <td className="px-4 py-2.5 text-white/70">{t.clockIn ?? '—'}</td>
                        <td className="px-4 py-2.5 text-white/70">{t.clockOut ?? '—'}</td>
                        <td className="px-4 py-2.5 text-white/70">{fmtMins(t.regularMinutes)}</td>
                        <td className="px-4 py-2.5 text-yellow-300">{t.overtimeMinutes && t.overtimeMinutes > 0 ? fmtMins(t.overtimeMinutes) : '—'}</td>
                        <td className="px-4 py-2.5">
                          {t.isApproved ? (
                            <Badge className="bg-emerald-500/20 text-emerald-300 text-xs">Approved</Badge>
                          ) : (
                            <Badge className="bg-yellow-500/20 text-yellow-300 text-xs">{t.isManualEntry ? 'Manual' : 'Pending'}</Badge>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {!t.isApproved && (
                            <Button size="sm" variant="ghost" className="text-emerald-400 hover:text-emerald-300 h-7 px-2" onClick={() => approveTs.mutate(t.id)}>
                              <UserCheck className="w-3.5 h-3.5 mr-1" />Approve
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── OVERTIME RULES ── */}
        <TabsContent value="settings" className="mt-4">
          <OvertimeRulesSection orgId={orgId} />
        </TabsContent>
      </Tabs>

      {/* ── MODALS ── */}
      <StaffModal
        open={showStaffModal}
        onOpenChange={setShowStaffModal}
        staff={editStaff}
        onSave={(body) => editStaff ? updateStaff.mutate({ id: editStaff.id, body }) : createStaff.mutate(body)}
        saving={createStaff.isPending || updateStaff.isPending}
      />
      <RosterModal
        open={showRosterModal}
        onOpenChange={setShowRosterModal}
        roster={editRoster}
        onSave={(body) => createRoster.mutate(body)}
        saving={createRoster.isPending}
      />
      <ShiftModal
        open={showShiftModal}
        onOpenChange={setShowShiftModal}
        rosterId={shiftRosterId}
        staff={staffList}
        onSave={(body) => createShift.mutate(body)}
        saving={createShift.isPending}
      />
      <ManualTimesheetModal
        open={showManualEntryModal}
        onOpenChange={setShowManualEntryModal}
        staff={staffList}
        onSave={(body) => addManualEntry.mutate(body)}
        saving={addManualEntry.isPending}
      />
    </div>
  );
}

// ── OVERTIME RULES SECTION ────────────────────────────────────────────────────

function OvertimeRulesSection({ orgId }: { orgId: number | null | undefined }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editRule, setEditRule] = useState<{
    id: number; name: string; regularHoursPerDay: string; regularHoursPerWeek: string;
    overtimeMultiplier: string; doubleTimeMultiplier: string; weekendPenaltyMultiplier: string; publicHolidayMultiplier: string;
  } | null>(null);
  const [form, setForm] = useState({ name: '', regularHoursPerDay: '8', regularHoursPerWeek: '40', overtimeMultiplier: '1.5', doubleTimeMultiplier: '2.0', weekendPenaltyMultiplier: '1.25', publicHolidayMultiplier: '2.5' });

  const { data: rules = [] } = useQuery<typeof editRule[]>({
    queryKey: ['overtime-rules', orgId],
    queryFn: async () => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/scheduling/overtime-rules`), { credentials: 'include' });
      return r.json();
    },
    enabled: !!orgId,
  });

  const saveRule = useMutation({
    mutationFn: async (body: object) => {
      const url = editRule ? apiUrl(`/organizations/${orgId}/scheduling/overtime-rules/${editRule.id}`) : apiUrl(`/organizations/${orgId}/scheduling/overtime-rules`);
      const method = editRule ? 'PATCH' : 'POST';
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['overtime-rules', orgId] }); setShowModal(false); toast({ title: 'Rule saved' }); },
    onError: (e: Error) => toast({ title: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-white font-semibold">Overtime & Penalty Rate Rules</h3>
        <Button size="sm" className="bg-primary ml-auto" onClick={() => { setEditRule(null); setForm({ name: '', regularHoursPerDay: '8', regularHoursPerWeek: '40', overtimeMultiplier: '1.5', doubleTimeMultiplier: '2.0', weekendPenaltyMultiplier: '1.25', publicHolidayMultiplier: '2.5' }); setShowModal(true); }}>
          <Plus className="w-4 h-4 mr-1" />Add Rule
        </Button>
      </div>
      {rules.length === 0 ? (
        <div className="text-center py-10 text-white/40">
          <Settings2 className="w-8 h-8 mx-auto mb-2" />
          <p>No overtime rules configured.</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rules.map((rule) => rule && (
            <Card key={rule.id} className="p-4 bg-white/5 border-white/10">
              <div className="flex items-start justify-between">
                <div>
                  <span className="font-semibold text-white">{rule.name}</span>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-white/60">
                    <span>Regular/day: <b className="text-white">{rule.regularHoursPerDay}h</b></span>
                    <span>Regular/week: <b className="text-white">{rule.regularHoursPerWeek}h</b></span>
                    <span>OT multiplier: <b className="text-white">×{rule.overtimeMultiplier}</b></span>
                    <span>Double time: <b className="text-white">×{rule.doubleTimeMultiplier}</b></span>
                    <span>Weekend: <b className="text-white">×{rule.weekendPenaltyMultiplier}</b></span>
                    <span>Public hol.: <b className="text-white">×{rule.publicHolidayMultiplier}</b></span>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="w-7 h-7 text-white/60 hover:text-white" onClick={() => { setEditRule(rule); setForm({ name: rule.name, regularHoursPerDay: rule.regularHoursPerDay, regularHoursPerWeek: rule.regularHoursPerWeek, overtimeMultiplier: rule.overtimeMultiplier, doubleTimeMultiplier: rule.doubleTimeMultiplier, weekendPenaltyMultiplier: rule.weekendPenaltyMultiplier, publicHolidayMultiplier: rule.publicHolidayMultiplier }); setShowModal(true); }}>
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="bg-card border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>{editRule ? 'Edit Rule' : 'New Overtime Rule'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Rule Name</Label><Input className="bg-white/5 border-white/10" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Regular hrs/day</Label><Input className="bg-white/5 border-white/10" type="number" step="0.5" value={form.regularHoursPerDay} onChange={(e) => setForm((f) => ({ ...f, regularHoursPerDay: e.target.value }))} /></div>
              <div><Label>Regular hrs/week</Label><Input className="bg-white/5 border-white/10" type="number" step="0.5" value={form.regularHoursPerWeek} onChange={(e) => setForm((f) => ({ ...f, regularHoursPerWeek: e.target.value }))} /></div>
              <div><Label>OT multiplier</Label><Input className="bg-white/5 border-white/10" type="number" step="0.05" value={form.overtimeMultiplier} onChange={(e) => setForm((f) => ({ ...f, overtimeMultiplier: e.target.value }))} /></div>
              <div><Label>Double-time ×</Label><Input className="bg-white/5 border-white/10" type="number" step="0.05" value={form.doubleTimeMultiplier} onChange={(e) => setForm((f) => ({ ...f, doubleTimeMultiplier: e.target.value }))} /></div>
              <div><Label>Weekend penalty ×</Label><Input className="bg-white/5 border-white/10" type="number" step="0.05" value={form.weekendPenaltyMultiplier} onChange={(e) => setForm((f) => ({ ...f, weekendPenaltyMultiplier: e.target.value }))} /></div>
              <div><Label>Public holiday ×</Label><Input className="bg-white/5 border-white/10" type="number" step="0.05" value={form.publicHolidayMultiplier} onChange={(e) => setForm((f) => ({ ...f, publicHolidayMultiplier: e.target.value }))} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button className="bg-primary" onClick={() => saveRule.mutate(form)} disabled={saveRule.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── STAFF MODAL ───────────────────────────────────────────────────────────────

function StaffModal({ open, onOpenChange, staff, onSave, saving }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  staff: StaffProfile | null;
  onSave: (body: object) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState({
    firstName: staff?.firstName ?? '',
    lastName: staff?.lastName ?? '',
    email: staff?.email ?? '',
    phone: staff?.phone ?? '',
    department: staff?.department ?? 'pro_shop',
    position: staff?.position ?? '',
    employmentType: staff?.employmentType ?? 'full_time',
    pin: '',
    hourlyRate: staff?.hourlyRate ?? '',
    currency: staff?.currency ?? 'INR',
    annualLeaveBalance: staff?.annualLeaveBalance ?? '0',
    sickLeaveBalance: staff?.sickLeaveBalance ?? '0',
    notes: staff?.notes ?? '',
  });

  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }));

  const handleSave = () => {
    if (!form.firstName || !form.lastName) return;
    onSave(form);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-white/10 text-white max-w-lg">
        <DialogHeader><DialogTitle>{staff ? 'Edit Staff' : 'Add Staff Member'}</DialogTitle></DialogHeader>
        <div className="space-y-3 max-h-[65vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>First Name *</Label><Input className="bg-white/5 border-white/10" value={form.firstName} onChange={(e) => set('firstName', e.target.value)} /></div>
            <div><Label>Last Name *</Label><Input className="bg-white/5 border-white/10" value={form.lastName} onChange={(e) => set('lastName', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Email</Label><Input className="bg-white/5 border-white/10" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
            <div><Label>Phone</Label><Input className="bg-white/5 border-white/10" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Department</Label>
              <Select value={form.department} onValueChange={(v) => set('department', v)}>
                <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(DEPT_LABELS) as Department[]).map((d) => <SelectItem key={d} value={d}>{DEPT_LABELS[d]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Employment Type</Label>
              <Select value={form.employmentType} onValueChange={(v) => set('employmentType', v)}>
                <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="full_time">Full-time</SelectItem>
                  <SelectItem value="part_time">Part-time</SelectItem>
                  <SelectItem value="casual">Casual</SelectItem>
                  <SelectItem value="contractor">Contractor</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div><Label>Position / Title</Label><Input className="bg-white/5 border-white/10" value={form.position} onChange={(e) => set('position', e.target.value)} /></div>
          <div className="grid grid-cols-3 gap-3">
            <div><Label>Hourly Rate</Label><Input className="bg-white/5 border-white/10" type="number" step="0.01" value={form.hourlyRate} onChange={(e) => set('hourlyRate', e.target.value)} /></div>
            <div><Label>Annual Leave (d)</Label><Input className="bg-white/5 border-white/10" type="number" step="0.5" value={form.annualLeaveBalance} onChange={(e) => set('annualLeaveBalance', e.target.value)} /></div>
            <div><Label>Sick Leave (d)</Label><Input className="bg-white/5 border-white/10" type="number" step="0.5" value={form.sickLeaveBalance} onChange={(e) => set('sickLeaveBalance', e.target.value)} /></div>
          </div>
          <div><Label>Clock-in PIN</Label><Input className="bg-white/5 border-white/10" type="password" maxLength={8} placeholder="4–8 digit PIN" value={form.pin} onChange={(e) => set('pin', e.target.value)} /></div>
          <div><Label>Notes</Label><Textarea className="bg-white/5 border-white/10 resize-none" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-primary" onClick={handleSave} disabled={saving}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── ROSTER MODAL ──────────────────────────────────────────────────────────────

function RosterModal({ open, onOpenChange, roster, onSave, saving }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  roster: Roster | null;
  onSave: (body: object) => void;
  saving: boolean;
}) {
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({
    name: roster?.name ?? '',
    department: roster?.department ?? '',
    period: roster?.period ?? 'weekly',
    startDate: roster?.startDate ?? today,
    endDate: roster?.endDate ?? today,
    notes: roster?.notes ?? '',
  });
  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-white/10 text-white max-w-md">
        <DialogHeader><DialogTitle>{roster ? 'Edit Roster' : 'Create Roster'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Roster Name *</Label><Input className="bg-white/5 border-white/10" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Week 15 Pro Shop" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Department</Label>
              <Select value={form.department || "_empty"} onValueChange={(v) => set('department', v === "_empty" ? "" : v)}>
                <SelectTrigger className="bg-white/5 border-white/10"><SelectValue placeholder="All departments" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_empty">All departments</SelectItem>
                  {(Object.keys(DEPT_LABELS) as Department[]).map((d) => <SelectItem key={d} value={d}>{DEPT_LABELS[d]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Period</Label>
              <Select value={form.period} onValueChange={(v) => set('period', v)}>
                <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="fortnightly">Fortnightly</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Start Date *</Label><Input className="bg-white/5 border-white/10" type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} /></div>
            <div><Label>End Date *</Label><Input className="bg-white/5 border-white/10" type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} /></div>
          </div>
          <div><Label>Notes</Label><Textarea className="bg-white/5 border-white/10 resize-none" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-primary" onClick={() => onSave(form)} disabled={saving || !form.name}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── SHIFT MODAL ───────────────────────────────────────────────────────────────

function ShiftModal({ open, onOpenChange, rosterId, staff, onSave, saving }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rosterId: number | null;
  staff: StaffProfile[];
  onSave: (body: object) => void;
  saving: boolean;
}) {
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({ staffProfileId: '', date: today, startTime: '08:00', endTime: '16:00', department: 'pro_shop', role: '', notes: '' });
  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }));

  const handleSave = () => {
    if (!form.staffProfileId || !form.date) return;
    onSave({ ...form, rosterId, staffProfileId: parseInt(form.staffProfileId) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-white/10 text-white max-w-md">
        <DialogHeader><DialogTitle>Add Shift</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Staff Member *</Label>
            <Select value={form.staffProfileId} onValueChange={(v) => set('staffProfileId', v)}>
              <SelectTrigger className="bg-white/5 border-white/10"><SelectValue placeholder="Select staff…" /></SelectTrigger>
              <SelectContent>{staff.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.firstName} {s.lastName}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Date *</Label><Input className="bg-white/5 border-white/10" type="date" value={form.date} onChange={(e) => set('date', e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Start Time *</Label><Input className="bg-white/5 border-white/10" type="time" value={form.startTime} onChange={(e) => set('startTime', e.target.value)} /></div>
            <div><Label>End Time *</Label><Input className="bg-white/5 border-white/10" type="time" value={form.endTime} onChange={(e) => set('endTime', e.target.value)} /></div>
          </div>
          <div>
            <Label>Department</Label>
            <Select value={form.department} onValueChange={(v) => set('department', v)}>
              <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(DEPT_LABELS) as Department[]).map((d) => <SelectItem key={d} value={d}>{DEPT_LABELS[d]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Role / Task</Label><Input className="bg-white/5 border-white/10" value={form.role} onChange={(e) => set('role', e.target.value)} placeholder="e.g. Counter duty" /></div>
          <div><Label>Notes</Label><Input className="bg-white/5 border-white/10" value={form.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-primary" onClick={handleSave} disabled={saving}>Add Shift</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── MANUAL TIMESHEET MODAL ────────────────────────────────────────────────────

function ManualTimesheetModal({ open, onOpenChange, staff, onSave, saving }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  staff: StaffProfile[];
  onSave: (body: object) => void;
  saving: boolean;
}) {
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({ staffProfileId: '', date: today, clockIn: '08:00', clockOut: '16:00', breakMinutes: '0', notes: '' });
  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-white/10 text-white max-w-md">
        <DialogHeader><DialogTitle>Manual Timesheet Entry</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Staff Member *</Label>
            <Select value={form.staffProfileId} onValueChange={(v) => set('staffProfileId', v)}>
              <SelectTrigger className="bg-white/5 border-white/10"><SelectValue placeholder="Select staff…" /></SelectTrigger>
              <SelectContent>{staff.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.firstName} {s.lastName}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Date *</Label><Input className="bg-white/5 border-white/10" type="date" value={form.date} onChange={(e) => set('date', e.target.value)} /></div>
          <div className="grid grid-cols-3 gap-3">
            <div><Label>Clock In *</Label><Input className="bg-white/5 border-white/10" type="time" value={form.clockIn} onChange={(e) => set('clockIn', e.target.value)} /></div>
            <div><Label>Clock Out *</Label><Input className="bg-white/5 border-white/10" type="time" value={form.clockOut} onChange={(e) => set('clockOut', e.target.value)} /></div>
            <div><Label>Break (min)</Label><Input className="bg-white/5 border-white/10" type="number" min="0" value={form.breakMinutes} onChange={(e) => set('breakMinutes', e.target.value)} /></div>
          </div>
          <div><Label>Notes</Label><Input className="bg-white/5 border-white/10" value={form.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-primary" onClick={() => onSave({ ...form, staffProfileId: parseInt(form.staffProfileId), breakMinutes: parseInt(form.breakMinutes) })} disabled={saving || !form.staffProfileId}>Save Entry</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
