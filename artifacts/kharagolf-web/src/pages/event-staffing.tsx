import { useState, useEffect, useCallback } from 'react';
import {
  Users, Plus, RefreshCw, CheckCircle2, XCircle, Clock, Pencil, Trash2,
  QrCode, UserCheck, AlertTriangle, ChevronDown, ChevronUp, X, DollarSign,
  UserPlus, Shield, ClipboardList, Award, BarChart2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
function API(path: string) { return `${BASE_URL}/api${path}`; }

type ExperienceLevel = 'trainee' | 'junior' | 'senior' | 'master';
type FeeMode = 'cash' | 'account';
type VolunteerRoleType = 'starter' | 'marshal' | 'scorer' | 'registration' | 'first_aid' | 'transport' | 'other';

interface Caddie {
  id: number;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  experienceLevel: ExperienceLevel;
  notes: string | null;
  isActive: boolean;
}

interface CaddieAssignment {
  id: number;
  caddieId: number;
  caddieFirstName: string;
  caddieLastName: string;
  caddieExperienceLevel: ExperienceLevel;
  caddiePhone: string | null;
  playerName: string | null;
  agreedFee: string | null;
  feeMode: FeeMode;
  feePaid: boolean;
  feePaidAt: string | null;
  notes: string | null;
  checkedIn: boolean;
}

interface VolunteerRole {
  id: number;
  title: string;
  roleType: VolunteerRoleType;
  location: string | null;
  description: string | null;
  maxVolunteers: number;
  qrToken: string;
  assignedCount: number;
  checkedInCount: number;
  assignments?: VolunteerAssignmentRow[];
}

interface VolunteerAssignmentRow {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  checkedIn: boolean;
  noShow: boolean;
}

interface Tournament {
  id: number;
  name: string;
  status: string;
  startDate: string | null;
}

interface StaffingReport {
  tournament: { name: string; startDate: string | null };
  summary: {
    caddiesAssigned: number;
    caddiesCheckedIn: number;
    caddieNoShows: number;
    volunteerRolesTotal: number;
    volunteersAssigned: number;
    volunteersCheckedIn: number;
    volunteerNoShows: number;
  };
  caddies: (CaddieAssignment & { checkedIn: boolean; noShow: boolean })[];
  volunteers: {
    role: VolunteerRole;
    assignments: (VolunteerAssignmentRow & { noShow: boolean })[];
    filled: number;
    capacity: number;
    checkedIn: number;
    noShows: number;
  }[];
}

const EXP_LABELS: Record<ExperienceLevel, string> = {
  trainee: 'Trainee', junior: 'Junior', senior: 'Senior', master: 'Master',
};
const EXP_COLORS: Record<ExperienceLevel, string> = {
  trainee: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  junior: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  senior: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  master: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
};

const ROLE_TYPE_LABELS: Record<VolunteerRoleType, string> = {
  starter: 'Starter', marshal: 'Marshal', scorer: 'Scorer',
  registration: 'Registration', first_aid: 'First Aid',
  transport: 'Transport', other: 'Other',
};

type Tab = 'board' | 'caddies' | 'roster' | 'report';

export default function EventStaffingPage() {
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;

  const [tab, setTab] = useState<Tab>('board');
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selectedTournamentId, setSelectedTournamentId] = useState<number | null>(null);

  // Caddie roster state
  const [caddies, setCaddies] = useState<Caddie[]>([]);
  // Caddie assignments
  const [caddieAssignments, setCaddieAssignments] = useState<CaddieAssignment[]>([]);
  // Volunteer roles (with expanded assignments)
  const [volunteerRoles, setVolunteerRoles] = useState<VolunteerRole[]>([]);
  const [expandedRoles, setExpandedRoles] = useState<Set<number>>(new Set());

  // Report state
  const [report, setReport] = useState<StaffingReport | null>(null);

  // Dialog states
  const [showAddCaddieDialog, setShowAddCaddieDialog] = useState(false);
  const [showEditCaddieDialog, setShowEditCaddieDialog] = useState(false);
  const [editingCaddie, setEditingCaddie] = useState<Caddie | null>(null);

  const [showAssignCaddieDialog, setShowAssignCaddieDialog] = useState(false);
  const [showAddRoleDialog, setShowAddRoleDialog] = useState(false);
  const [showAddVolunteerDialog, setShowAddVolunteerDialog] = useState(false);
  const [currentRoleId, setCurrentRoleId] = useState<number | null>(null);
  const [showCheckinDialog, setShowCheckinDialog] = useState(false);
  const [checkinTarget, setCheckinTarget] = useState<{ type: 'caddie' | 'volunteer'; id: number } | null>(null);

  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Form states
  const [caddieForm, setCaddieForm] = useState({ firstName: '', lastName: '', phone: '', email: '', experienceLevel: 'junior' as ExperienceLevel, notes: '' });
  const [assignCaddieForm, setAssignCaddieForm] = useState({ caddieId: '', playerName: '', agreedFee: '', feeMode: 'cash' as FeeMode, notes: '' });
  const [roleForm, setRoleForm] = useState({ title: '', roleType: 'marshal' as VolunteerRoleType, location: '', description: '', maxVolunteers: '1' });
  const [volunteerForm, setVolunteerForm] = useState({ firstName: '', lastName: '', email: '', phone: '', notes: '' });

  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);

  // Load tournaments
  useEffect(() => {
    if (!orgId) return;
    fetch(API(`/organizations/${orgId}/tournaments`))
      .then(r => r.json())
      .then((d: { tournaments?: Tournament[] }) => {
        const ts = d.tournaments ?? [];
        setTournaments(ts);
        if (ts.length > 0 && !selectedTournamentId) {
          const active = ts.find(t => t.status === 'active') ?? ts[0];
          setSelectedTournamentId(active.id);
        }
      })
      .catch(() => {});
  }, [orgId, selectedTournamentId]);

  // Load caddie roster
  useEffect(() => {
    if (!orgId) return;
    fetch(API(`/organizations/${orgId}/caddies`))
      .then(r => r.json())
      .then((d: { caddies?: Caddie[] }) => setCaddies(d.caddies ?? []))
      .catch(() => {});
  }, [orgId, refreshKey]);

  // Load caddie assignments for selected tournament
  useEffect(() => {
    if (!orgId || !selectedTournamentId) return;
    fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/caddie-assignments`))
      .then(r => r.json())
      .then((d: { assignments?: CaddieAssignment[] }) => setCaddieAssignments(d.assignments ?? []))
      .catch(() => {});
  }, [orgId, selectedTournamentId, refreshKey]);

  // Load volunteer roles for selected tournament
  useEffect(() => {
    if (!orgId || !selectedTournamentId) return;
    fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/volunteer-roles`))
      .then(r => r.json())
      .then((d: { roles?: VolunteerRole[] }) => setVolunteerRoles(d.roles ?? []))
      .catch(() => {});
  }, [orgId, selectedTournamentId, refreshKey]);

  // Load assignments for expanded roles
  useEffect(() => {
    if (!orgId || !selectedTournamentId) return;
    for (const roleId of expandedRoles) {
      fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/volunteer-roles/${roleId}/assignments`))
        .then(r => r.json())
        .then((d: { assignments?: VolunteerAssignmentRow[] }) => {
          setVolunteerRoles(prev => prev.map(r =>
            r.id === roleId ? { ...r, assignments: d.assignments ?? [] } : r
          ));
        })
        .catch(() => {});
    }
  }, [orgId, selectedTournamentId, expandedRoles, refreshKey]);

  // Load report
  useEffect(() => {
    if (!orgId || !selectedTournamentId || tab !== 'report') return;
    fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/staffing-report`))
      .then(r => r.json())
      .then((d: StaffingReport) => setReport(d))
      .catch(() => {});
  }, [orgId, selectedTournamentId, tab, refreshKey]);

  async function handleAddCaddie() {
    if (!orgId) return;
    setLoading(true);
    try {
      const r = await fetch(API(`/organizations/${orgId}/caddies`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(caddieForm),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      toast({ title: 'Caddie added' });
      setShowAddCaddieDialog(false);
      setCaddieForm({ firstName: '', lastName: '', phone: '', email: '', experienceLevel: 'junior', notes: '' });
      refresh();
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' });
    } finally { setLoading(false); }
  }

  async function handleEditCaddie() {
    if (!orgId || !editingCaddie) return;
    setLoading(true);
    try {
      const r = await fetch(API(`/organizations/${orgId}/caddies/${editingCaddie.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(caddieForm),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      toast({ title: 'Caddie updated' });
      setShowEditCaddieDialog(false);
      setEditingCaddie(null);
      refresh();
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' });
    } finally { setLoading(false); }
  }

  async function handleDeleteCaddie(caddieId: number) {
    if (!orgId || !confirm('Remove this caddie from the roster?')) return;
    try {
      await fetch(API(`/organizations/${orgId}/caddies/${caddieId}`), { method: 'DELETE' });
      toast({ title: 'Caddie removed' });
      refresh();
    } catch { toast({ title: 'Error', variant: 'destructive' }); }
  }

  async function handleAssignCaddie() {
    if (!orgId || !selectedTournamentId) return;
    setLoading(true);
    try {
      const r = await fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/caddie-assignments`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caddieId: parseInt(assignCaddieForm.caddieId),
          playerName: assignCaddieForm.playerName || undefined,
          agreedFee: assignCaddieForm.agreedFee || undefined,
          feeMode: assignCaddieForm.feeMode,
          notes: assignCaddieForm.notes || undefined,
        }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      toast({ title: 'Caddie assigned' });
      setShowAssignCaddieDialog(false);
      setAssignCaddieForm({ caddieId: '', playerName: '', agreedFee: '', feeMode: 'cash', notes: '' });
      refresh();
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' });
    } finally { setLoading(false); }
  }

  async function handleMarkPaid(assignmentId: number) {
    if (!orgId || !selectedTournamentId) return;
    try {
      await fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/caddie-assignments/${assignmentId}/mark-paid`), {
        method: 'POST',
      });
      toast({ title: 'Fee marked as paid' });
      refresh();
    } catch { toast({ title: 'Error', variant: 'destructive' }); }
  }

  async function handleDeleteCaddieAssignment(id: number) {
    if (!orgId || !selectedTournamentId || !confirm('Remove this caddie assignment?')) return;
    try {
      await fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/caddie-assignments/${id}`), { method: 'DELETE' });
      toast({ title: 'Assignment removed' });
      refresh();
    } catch { toast({ title: 'Error', variant: 'destructive' }); }
  }

  async function handleAddRole() {
    if (!orgId || !selectedTournamentId) return;
    setLoading(true);
    try {
      const r = await fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/volunteer-roles`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...roleForm,
          maxVolunteers: parseInt(roleForm.maxVolunteers) || 1,
        }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      toast({ title: 'Role created' });
      setShowAddRoleDialog(false);
      setRoleForm({ title: '', roleType: 'marshal', location: '', description: '', maxVolunteers: '1' });
      refresh();
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' });
    } finally { setLoading(false); }
  }

  async function handleDeleteRole(roleId: number) {
    if (!orgId || !selectedTournamentId || !confirm('Delete this volunteer role?')) return;
    try {
      await fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/volunteer-roles/${roleId}`), { method: 'DELETE' });
      toast({ title: 'Role deleted' });
      refresh();
    } catch { toast({ title: 'Error', variant: 'destructive' }); }
  }

  async function handleAddVolunteer() {
    if (!orgId || !selectedTournamentId || !currentRoleId) return;
    setLoading(true);
    try {
      const r = await fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/volunteer-roles/${currentRoleId}/assignments`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(volunteerForm),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      toast({ title: 'Volunteer assigned' });
      setShowAddVolunteerDialog(false);
      setVolunteerForm({ firstName: '', lastName: '', email: '', phone: '', notes: '' });
      refresh();
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' });
    } finally { setLoading(false); }
  }

  async function handleRemoveVolunteer(roleId: number, assignmentId: number) {
    if (!orgId || !selectedTournamentId || !confirm('Remove this volunteer?')) return;
    try {
      await fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/volunteer-roles/${roleId}/assignments/${assignmentId}`), { method: 'DELETE' });
      toast({ title: 'Volunteer removed' });
      refresh();
    } catch { toast({ title: 'Error', variant: 'destructive' }); }
  }

  async function handleManualCheckin(type: 'caddie' | 'volunteer', id: number) {
    if (!orgId || !selectedTournamentId) return;
    try {
      await fetch(API(`/organizations/${orgId}/tournaments/${selectedTournamentId}/staff-checkin/manual`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checkinType: type,
          [`${type}AssignmentId`]: id,
        }),
      });
      toast({ title: 'Checked in!' });
      refresh();
    } catch { toast({ title: 'Error', variant: 'destructive' }); }
  }

  const selectedTournament = tournaments.find(t => t.id === selectedTournamentId);

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-bold text-white flex items-center gap-2">
            <Users className="w-6 h-6 text-primary" />
            Event Day Staffing
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage caddies and volunteer marshals</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={refresh} title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Tournament selector */}
      <div className="flex items-center gap-4">
        <Label className="text-muted-foreground text-sm whitespace-nowrap">Tournament:</Label>
        <Select
          value={selectedTournamentId?.toString() ?? ''}
          onValueChange={(v) => setSelectedTournamentId(parseInt(v))}
        >
          <SelectTrigger className="w-72 bg-card border-white/10 text-white">
            <SelectValue placeholder="Select tournament..." />
          </SelectTrigger>
          <SelectContent>
            {tournaments.map(t => (
              <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/10">
        {[
          { id: 'board' as Tab, label: 'Staffing Board', icon: ClipboardList },
          { id: 'caddies' as Tab, label: 'Caddie Assignments', icon: Award },
          { id: 'roster' as Tab, label: 'Caddie Roster', icon: Users },
          { id: 'report' as Tab, label: 'Report', icon: BarChart2 },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px
              ${tab === id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-white'}`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* STAFFING BOARD TAB */}
      {tab === 'board' && (
        <div className="space-y-6">
          {/* Summary stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="glass-card border-none">
              <CardContent className="p-4">
                <div className="text-2xl font-bold text-white">{caddieAssignments.length}</div>
                <div className="text-sm text-muted-foreground">Caddies Assigned</div>
              </CardContent>
            </Card>
            <Card className="glass-card border-none">
              <CardContent className="p-4">
                <div className="text-2xl font-bold text-emerald-400">{caddieAssignments.filter(c => c.checkedIn).length}</div>
                <div className="text-sm text-muted-foreground">Caddies Checked In</div>
              </CardContent>
            </Card>
            <Card className="glass-card border-none">
              <CardContent className="p-4">
                <div className="text-2xl font-bold text-white">{volunteerRoles.reduce((acc, r) => acc + r.assignedCount, 0)}</div>
                <div className="text-sm text-muted-foreground">Volunteers Assigned</div>
              </CardContent>
            </Card>
            <Card className="glass-card border-none">
              <CardContent className="p-4">
                <div className="text-2xl font-bold text-emerald-400">{volunteerRoles.reduce((acc, r) => acc + r.checkedInCount, 0)}</div>
                <div className="text-sm text-muted-foreground">Volunteers Checked In</div>
              </CardContent>
            </Card>
          </div>

          {/* Volunteer Roles Board */}
          <Card className="glass-card border-none">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-white text-base flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                Volunteer Roles
              </CardTitle>
              {selectedTournamentId && (
                <Button size="sm" onClick={() => setShowAddRoleDialog(true)} className="gap-1">
                  <Plus className="w-3.5 h-3.5" />
                  Add Role
                </Button>
              )}
            </CardHeader>
            <CardContent className="divide-y divide-white/5">
              {volunteerRoles.length === 0 && (
                <p className="text-muted-foreground text-sm py-4 text-center">No volunteer roles defined for this tournament.</p>
              )}
              {volunteerRoles.map(role => {
                const isExpanded = expandedRoles.has(role.id);
                const isFull = role.assignedCount >= role.maxVolunteers;
                return (
                  <div key={role.id}>
                    <div className="py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-white font-medium">{role.title}</span>
                          <Badge className="text-[10px] border bg-primary/10 text-primary border-primary/20">{ROLE_TYPE_LABELS[role.roleType]}</Badge>
                          {role.location && <span className="text-xs text-muted-foreground">@ {role.location}</span>}
                        </div>
                        <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                          <span>{role.assignedCount}/{role.maxVolunteers} assigned</span>
                          <span className="text-emerald-400">{role.checkedInCount} checked in</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <div className={`w-2.5 h-2.5 rounded-full ${isFull ? 'bg-emerald-400' : 'bg-amber-400'}`} title={isFull ? 'Full' : 'Open'} />
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            setCurrentRoleId(role.id);
                            setShowAddVolunteerDialog(true);
                          }}
                        >
                          <UserPlus className="w-3.5 h-3.5 mr-1" />
                          Add
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            setExpandedRoles(prev => {
                              const next = new Set(prev);
                              if (next.has(role.id)) next.delete(role.id);
                              else next.add(role.id);
                              return next;
                            });
                          }}
                        >
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          onClick={() => handleDeleteRole(role.id)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>

                    {isExpanded && role.assignments && (
                      <div className="pb-3 space-y-2 pl-4">
                        {role.assignments.length === 0 && (
                          <p className="text-xs text-muted-foreground">No volunteers assigned yet.</p>
                        )}
                        {role.assignments.map(a => (
                          <div key={a.id} className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
                            <div className="flex-1">
                              <span className="text-sm text-white">{a.firstName} {a.lastName}</span>
                              {a.email && <span className="text-xs text-muted-foreground ml-2">{a.email}</span>}
                            </div>
                            {a.checkedIn ? (
                              <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-xs">Checked In</Badge>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs text-emerald-400 hover:text-emerald-300"
                                onClick={() => handleManualCheckin('volunteer', a.id)}
                              >
                                <UserCheck className="w-3 h-3 mr-1" />
                                Check In
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                              onClick={() => handleRemoveVolunteer(role.id, a.id)}
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Caddie Check-in Board */}
          <Card className="glass-card border-none">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-white text-base flex items-center gap-2">
                <Award className="w-4 h-4 text-primary" />
                Caddies
              </CardTitle>
            </CardHeader>
            <CardContent>
              {caddieAssignments.length === 0 && (
                <p className="text-muted-foreground text-sm text-center py-4">No caddies assigned.</p>
              )}
              <div className="divide-y divide-white/5">
                {caddieAssignments.map(ca => (
                  <div key={ca.id} className="py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-medium">{ca.caddieFirstName} {ca.caddieLastName}</span>
                        <Badge className={`text-[10px] border ${EXP_COLORS[ca.caddieExperienceLevel]}`}>
                          {EXP_LABELS[ca.caddieExperienceLevel]}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {ca.playerName ? `→ ${ca.playerName}` : 'Unassigned player'}
                        {ca.agreedFee && <span className="ml-2 text-primary">₹{ca.agreedFee} ({ca.feeMode}){ca.feePaid ? ' ✓' : ''}</span>}
                      </div>
                    </div>
                    {ca.checkedIn ? (
                      <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-xs">Checked In</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-emerald-400 hover:text-emerald-300"
                        onClick={() => handleManualCheckin('caddie', ca.id)}
                      >
                        <UserCheck className="w-3.5 h-3.5 mr-1" />
                        Check In
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* CADDIE ASSIGNMENTS TAB */}
      {tab === 'caddies' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setShowAssignCaddieDialog(true)} className="gap-1" disabled={!selectedTournamentId}>
              <Plus className="w-4 h-4" />
              Assign Caddie
            </Button>
          </div>

          <Card className="glass-card border-none">
            <CardHeader>
              <CardTitle className="text-white text-base">Caddie Assignments</CardTitle>
            </CardHeader>
            <CardContent>
              {caddieAssignments.length === 0 && (
                <p className="text-muted-foreground text-sm text-center py-6">No caddie assignments for this tournament.</p>
              )}
              <div className="divide-y divide-white/5">
                {caddieAssignments.map(ca => (
                  <div key={ca.id} className="py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-white font-medium">{ca.caddieFirstName} {ca.caddieLastName}</span>
                        <Badge className={`text-[10px] border ${EXP_COLORS[ca.caddieExperienceLevel]}`}>
                          {EXP_LABELS[ca.caddieExperienceLevel]}
                        </Badge>
                        {ca.checkedIn && <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-xs">Checked In</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3">
                        <span>{ca.playerName ? `Player: ${ca.playerName}` : 'No player assigned'}</span>
                        {ca.agreedFee && (
                          <span className={ca.feePaid ? 'text-emerald-400' : 'text-amber-400'}>
                            ₹{ca.agreedFee} ({ca.feeMode}) {ca.feePaid ? '— Paid' : '— Unpaid'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {!ca.feePaid && ca.agreedFee && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-primary hover:text-primary/80"
                          onClick={() => handleMarkPaid(ca.id)}
                        >
                          <DollarSign className="w-3.5 h-3.5 mr-1" />
                          Mark Paid
                        </Button>
                      )}
                      {!ca.checkedIn && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-emerald-400 hover:text-emerald-300"
                          onClick={() => handleManualCheckin('caddie', ca.id)}
                        >
                          <UserCheck className="w-3.5 h-3.5 mr-1" />
                          Check In
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        onClick={() => handleDeleteCaddieAssignment(ca.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* CADDIE ROSTER TAB */}
      {tab === 'roster' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => { setCaddieForm({ firstName: '', lastName: '', phone: '', email: '', experienceLevel: 'junior', notes: '' }); setShowAddCaddieDialog(true); }} className="gap-1">
              <Plus className="w-4 h-4" />
              Add Caddie
            </Button>
          </div>

          <Card className="glass-card border-none">
            <CardHeader>
              <CardTitle className="text-white text-base">Caddie Roster ({caddies.filter(c => c.isActive).length} active)</CardTitle>
            </CardHeader>
            <CardContent>
              {caddies.length === 0 && (
                <p className="text-muted-foreground text-sm text-center py-6">No caddies in roster. Add one to get started.</p>
              )}
              <div className="divide-y divide-white/5">
                {caddies.map(c => (
                  <div key={c.id} className="py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-white font-medium ${!c.isActive ? 'opacity-50' : ''}`}>
                          {c.firstName} {c.lastName}
                        </span>
                        <Badge className={`text-[10px] border ${EXP_COLORS[c.experienceLevel]}`}>
                          {EXP_LABELS[c.experienceLevel]}
                        </Badge>
                        {!c.isActive && <Badge className="bg-gray-500/20 text-gray-400 text-[10px]">Inactive</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3">
                        {c.phone && <span>{c.phone}</span>}
                        {c.email && <span>{c.email}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => {
                          setEditingCaddie(c);
                          setCaddieForm({
                            firstName: c.firstName,
                            lastName: c.lastName,
                            phone: c.phone ?? '',
                            email: c.email ?? '',
                            experienceLevel: c.experienceLevel,
                            notes: c.notes ?? '',
                          });
                          setShowEditCaddieDialog(true);
                        }}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        onClick={() => handleDeleteCaddie(c.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* REPORT TAB */}
      {tab === 'report' && (
        <div className="space-y-6">
          {!report ? (
            <p className="text-muted-foreground text-sm">Loading report...</p>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: 'Caddies Assigned', value: report.summary.caddiesAssigned, color: 'text-white' },
                  { label: 'Caddies Checked In', value: report.summary.caddiesCheckedIn, color: 'text-emerald-400' },
                  { label: 'Caddie No-Shows', value: report.summary.caddieNoShows, color: 'text-red-400' },
                  { label: 'Volunteers Assigned', value: report.summary.volunteersAssigned, color: 'text-white' },
                  { label: 'Volunteers Checked In', value: report.summary.volunteersCheckedIn, color: 'text-emerald-400' },
                  { label: 'Volunteer No-Shows', value: report.summary.volunteerNoShows, color: 'text-red-400' },
                  { label: 'Volunteer Roles', value: report.summary.volunteerRolesTotal, color: 'text-white' },
                ].map(s => (
                  <Card key={s.label} className="glass-card border-none">
                    <CardContent className="p-4">
                      <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                      <div className="text-sm text-muted-foreground">{s.label}</div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card className="glass-card border-none">
                <CardHeader>
                  <CardTitle className="text-white text-base">Caddies</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="divide-y divide-white/5">
                    {report.caddies.map(c => (
                      <div key={c.id} className="py-2 flex items-center gap-3 text-sm">
                        <span className="text-white flex-1">{c.caddieFirstName} {c.caddieLastName}</span>
                        <span className="text-muted-foreground">{c.playerName ?? '—'}</span>
                        {c.agreedFee && <span className={c.feePaid ? 'text-emerald-400' : 'text-amber-400'}>₹{c.agreedFee}</span>}
                        {c.checkedIn && !c.noShow ? (
                          <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-xs">Present</Badge>
                        ) : c.noShow ? (
                          <Badge className="bg-red-500/20 text-red-300 border-red-500/30 text-xs">No-Show</Badge>
                        ) : (
                          <Badge className="bg-gray-500/20 text-gray-400 text-xs">Not Checked In</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {report.volunteers.map(({ role, assignments, filled, capacity, checkedIn, noShows }) => (
                <Card key={role.id} className="glass-card border-none">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-white text-base">{role.title}</CardTitle>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{filled}/{capacity}</span>
                        <span className="text-emerald-400">{checkedIn} present</span>
                        {noShows > 0 && <span className="text-red-400">{noShows} no-show</span>}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="divide-y divide-white/5">
                      {assignments.map(a => (
                        <div key={a.id} className="py-2 flex items-center gap-3 text-sm">
                          <span className="text-white flex-1">{a.firstName} {a.lastName}</span>
                          {a.email && <span className="text-muted-foreground">{a.email}</span>}
                          {a.checkedIn && !a.noShow ? (
                            <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-xs">Present</Badge>
                          ) : a.noShow ? (
                            <Badge className="bg-red-500/20 text-red-300 border-red-500/30 text-xs">No-Show</Badge>
                          ) : (
                            <Badge className="bg-gray-500/20 text-gray-400 text-xs">Not Checked In</Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </div>
      )}

      {/* ADD CADDIE DIALOG */}
      <Dialog open={showAddCaddieDialog} onOpenChange={setShowAddCaddieDialog}>
        <DialogContent className="bg-card border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>Add Caddie to Roster</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>First Name *</Label>
                <Input value={caddieForm.firstName} onChange={e => setCaddieForm(f => ({ ...f, firstName: e.target.value }))} className="bg-background border-white/10" />
              </div>
              <div className="space-y-1">
                <Label>Last Name *</Label>
                <Input value={caddieForm.lastName} onChange={e => setCaddieForm(f => ({ ...f, lastName: e.target.value }))} className="bg-background border-white/10" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Phone</Label>
                <Input value={caddieForm.phone} onChange={e => setCaddieForm(f => ({ ...f, phone: e.target.value }))} className="bg-background border-white/10" />
              </div>
              <div className="space-y-1">
                <Label>Email</Label>
                <Input value={caddieForm.email} onChange={e => setCaddieForm(f => ({ ...f, email: e.target.value }))} className="bg-background border-white/10" />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Experience Level</Label>
              <Select value={caddieForm.experienceLevel} onValueChange={v => setCaddieForm(f => ({ ...f, experienceLevel: v as ExperienceLevel }))}>
                <SelectTrigger className="bg-background border-white/10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['trainee', 'junior', 'senior', 'master'] as ExperienceLevel[]).map(l => (
                    <SelectItem key={l} value={l}>{EXP_LABELS[l]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input value={caddieForm.notes} onChange={e => setCaddieForm(f => ({ ...f, notes: e.target.value }))} className="bg-background border-white/10" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddCaddieDialog(false)}>Cancel</Button>
            <Button onClick={handleAddCaddie} disabled={loading || !caddieForm.firstName || !caddieForm.lastName}>
              {loading ? 'Adding...' : 'Add Caddie'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* EDIT CADDIE DIALOG */}
      <Dialog open={showEditCaddieDialog} onOpenChange={setShowEditCaddieDialog}>
        <DialogContent className="bg-card border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>Edit Caddie</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>First Name *</Label>
                <Input value={caddieForm.firstName} onChange={e => setCaddieForm(f => ({ ...f, firstName: e.target.value }))} className="bg-background border-white/10" />
              </div>
              <div className="space-y-1">
                <Label>Last Name *</Label>
                <Input value={caddieForm.lastName} onChange={e => setCaddieForm(f => ({ ...f, lastName: e.target.value }))} className="bg-background border-white/10" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Phone</Label>
                <Input value={caddieForm.phone} onChange={e => setCaddieForm(f => ({ ...f, phone: e.target.value }))} className="bg-background border-white/10" />
              </div>
              <div className="space-y-1">
                <Label>Email</Label>
                <Input value={caddieForm.email} onChange={e => setCaddieForm(f => ({ ...f, email: e.target.value }))} className="bg-background border-white/10" />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Experience Level</Label>
              <Select value={caddieForm.experienceLevel} onValueChange={v => setCaddieForm(f => ({ ...f, experienceLevel: v as ExperienceLevel }))}>
                <SelectTrigger className="bg-background border-white/10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['trainee', 'junior', 'senior', 'master'] as ExperienceLevel[]).map(l => (
                    <SelectItem key={l} value={l}>{EXP_LABELS[l]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input value={caddieForm.notes} onChange={e => setCaddieForm(f => ({ ...f, notes: e.target.value }))} className="bg-background border-white/10" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowEditCaddieDialog(false)}>Cancel</Button>
            <Button onClick={handleEditCaddie} disabled={loading}>
              {loading ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ASSIGN CADDIE DIALOG */}
      <Dialog open={showAssignCaddieDialog} onOpenChange={setShowAssignCaddieDialog}>
        <DialogContent className="bg-card border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>Assign Caddie to Tournament</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Caddie *</Label>
              <Select value={assignCaddieForm.caddieId} onValueChange={v => setAssignCaddieForm(f => ({ ...f, caddieId: v }))}>
                <SelectTrigger className="bg-background border-white/10">
                  <SelectValue placeholder="Select caddie..." />
                </SelectTrigger>
                <SelectContent>
                  {caddies.filter(c => c.isActive).map(c => (
                    <SelectItem key={c.id} value={c.id.toString()}>
                      {c.firstName} {c.lastName} ({EXP_LABELS[c.experienceLevel]})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Player Name</Label>
              <Input
                placeholder="Player being caddied for"
                value={assignCaddieForm.playerName}
                onChange={e => setAssignCaddieForm(f => ({ ...f, playerName: e.target.value }))}
                className="bg-background border-white/10"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Agreed Fee</Label>
                <Input
                  type="number"
                  placeholder="Amount"
                  value={assignCaddieForm.agreedFee}
                  onChange={e => setAssignCaddieForm(f => ({ ...f, agreedFee: e.target.value }))}
                  className="bg-background border-white/10"
                />
              </div>
              <div className="space-y-1">
                <Label>Fee Mode</Label>
                <Select value={assignCaddieForm.feeMode} onValueChange={v => setAssignCaddieForm(f => ({ ...f, feeMode: v as FeeMode }))}>
                  <SelectTrigger className="bg-background border-white/10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="account">Account</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input
                value={assignCaddieForm.notes}
                onChange={e => setAssignCaddieForm(f => ({ ...f, notes: e.target.value }))}
                className="bg-background border-white/10"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAssignCaddieDialog(false)}>Cancel</Button>
            <Button onClick={handleAssignCaddie} disabled={loading || !assignCaddieForm.caddieId}>
              {loading ? 'Assigning...' : 'Assign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ADD VOLUNTEER ROLE DIALOG */}
      <Dialog open={showAddRoleDialog} onOpenChange={setShowAddRoleDialog}>
        <DialogContent className="bg-card border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>Add Volunteer Role</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Title *</Label>
              <Input
                placeholder="e.g. Marshal — Hole 7"
                value={roleForm.title}
                onChange={e => setRoleForm(f => ({ ...f, title: e.target.value }))}
                className="bg-background border-white/10"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Role Type</Label>
                <Select value={roleForm.roleType} onValueChange={v => setRoleForm(f => ({ ...f, roleType: v as VolunteerRoleType }))}>
                  <SelectTrigger className="bg-background border-white/10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.entries(ROLE_TYPE_LABELS) as [VolunteerRoleType, string][]).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Max Volunteers</Label>
                <Input
                  type="number"
                  min="1"
                  value={roleForm.maxVolunteers}
                  onChange={e => setRoleForm(f => ({ ...f, maxVolunteers: e.target.value }))}
                  className="bg-background border-white/10"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Location</Label>
              <Input
                placeholder="e.g. Hole 7 Tee"
                value={roleForm.location}
                onChange={e => setRoleForm(f => ({ ...f, location: e.target.value }))}
                className="bg-background border-white/10"
              />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Input
                value={roleForm.description}
                onChange={e => setRoleForm(f => ({ ...f, description: e.target.value }))}
                className="bg-background border-white/10"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddRoleDialog(false)}>Cancel</Button>
            <Button onClick={handleAddRole} disabled={loading || !roleForm.title}>
              {loading ? 'Creating...' : 'Create Role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ADD VOLUNTEER DIALOG */}
      <Dialog open={showAddVolunteerDialog} onOpenChange={setShowAddVolunteerDialog}>
        <DialogContent className="bg-card border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>Add Volunteer</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>First Name *</Label>
                <Input value={volunteerForm.firstName} onChange={e => setVolunteerForm(f => ({ ...f, firstName: e.target.value }))} className="bg-background border-white/10" />
              </div>
              <div className="space-y-1">
                <Label>Last Name *</Label>
                <Input value={volunteerForm.lastName} onChange={e => setVolunteerForm(f => ({ ...f, lastName: e.target.value }))} className="bg-background border-white/10" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Email</Label>
                <Input value={volunteerForm.email} onChange={e => setVolunteerForm(f => ({ ...f, email: e.target.value }))} className="bg-background border-white/10" />
              </div>
              <div className="space-y-1">
                <Label>Phone</Label>
                <Input value={volunteerForm.phone} onChange={e => setVolunteerForm(f => ({ ...f, phone: e.target.value }))} className="bg-background border-white/10" />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input value={volunteerForm.notes} onChange={e => setVolunteerForm(f => ({ ...f, notes: e.target.value }))} className="bg-background border-white/10" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddVolunteerDialog(false)}>Cancel</Button>
            <Button onClick={handleAddVolunteer} disabled={loading || !volunteerForm.firstName || !volunteerForm.lastName}>
              {loading ? 'Adding...' : 'Add Volunteer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
