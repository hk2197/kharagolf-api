import { useState, useMemo } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Wrench, Plus, Search, RefreshCw, ChevronRight, CheckCircle2, Clock, Package,
  XCircle, Edit2, Trash2, User, Mail, CalendarDays, ClipboardList, Ruler,
  AlertCircle, Filter, Bell,
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
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';

// ─── Types ───────────────────────────────────────────────────────────────────

type RepairStatus = 'received' | 'in_progress' | 'ready_for_pickup' | 'collected';
type RepairJobType = 'regrip' | 'reshaft' | 'loft_lie_adjustment' | 'cleaning' | 'other';
type FittingStatus = 'booked' | 'completed' | 'cancelled';

interface RepairJob {
  id: number;
  memberName: string;
  memberEmail: string | null;
  memberId: number | null;
  jobType: RepairJobType;
  description: string;
  status: RepairStatus;
  technicianId: number | null;
  technicianName: string | null;
  expectedCompletionDate: string | null;
  completedAt: string | null;
  notificationSentAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FittingSession {
  id: number;
  memberName: string;
  memberEmail: string | null;
  memberId: number | null;
  scheduledAt: string;
  status: FittingStatus;
  technicianId: number | null;
  technicianName: string | null;
  recommendedSpecs: {
    shaftFlex?: string;
    shaftMaterial?: string;
    headType?: string;
    loft?: string;
    lie?: string;
    gripSize?: string;
    notes?: string;
  };
  notes: string | null;
  createdAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<RepairStatus, string> = {
  received: 'Received',
  in_progress: 'In Progress',
  ready_for_pickup: 'Ready for Pickup',
  collected: 'Collected',
};

const STATUS_COLORS: Record<RepairStatus, string> = {
  received: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  in_progress: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  ready_for_pickup: 'bg-green-500/20 text-green-300 border-green-500/30',
  collected: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

const STATUS_COLUMN_COLORS: Record<RepairStatus, string> = {
  received: 'border-blue-500/30 bg-blue-500/5',
  in_progress: 'border-amber-500/30 bg-amber-500/5',
  ready_for_pickup: 'border-green-500/30 bg-green-500/5',
  collected: 'border-gray-500/30 bg-gray-500/5',
};

const STATUS_ICONS: Record<RepairStatus, React.ReactNode> = {
  received: <Package className="w-4 h-4" />,
  in_progress: <Wrench className="w-4 h-4" />,
  ready_for_pickup: <Bell className="w-4 h-4" />,
  collected: <CheckCircle2 className="w-4 h-4" />,
};

const JOB_TYPE_LABELS: Record<RepairJobType, string> = {
  regrip: 'Regrip',
  reshaft: 'Reshaft',
  loft_lie_adjustment: 'Loft/Lie Adj.',
  cleaning: 'Cleaning',
  other: 'Other',
};

const FITTING_STATUS_COLORS: Record<FittingStatus, string> = {
  booked: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  completed: 'bg-green-500/20 text-green-300 border-green-500/30',
  cancelled: 'bg-red-500/20 text-red-300 border-red-500/30',
};

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, { credentials: 'include', ...opts });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error ?? 'Request failed');
  }
  return res.json();
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ClubRepairPage() {
  const { data: me } = useGetMe();
  const { activeOrg } = useActiveOrgContext();
  const orgId = activeOrg?.id ?? me?.organizationId;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState<'repair' | 'fitting'>('repair');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showRepairDialog, setShowRepairDialog] = useState(false);
  const [showFittingDialog, setShowFittingDialog] = useState(false);
  const [editingJob, setEditingJob] = useState<RepairJob | null>(null);
  const [editingSession, setEditingSession] = useState<FittingSession | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ type: 'repair' | 'fitting'; id: number } | null>(null);

  const repairQuery = useQuery<RepairJob[]>({
    queryKey: ['repair-jobs', orgId],
    queryFn: () => apiFetch(`/api/organizations/${orgId}/repair-jobs`),
    enabled: !!orgId,
  });

  const fittingQuery = useQuery<FittingSession[]>({
    queryKey: ['fitting-sessions', orgId],
    queryFn: () => apiFetch(`/api/organizations/${orgId}/fitting-sessions`),
    enabled: !!orgId,
  });

  const filteredJobs = useMemo(() => {
    let jobs = repairQuery.data ?? [];
    if (statusFilter !== 'all') jobs = jobs.filter(j => j.status === statusFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      jobs = jobs.filter(j =>
        j.memberName.toLowerCase().includes(q) ||
        j.description.toLowerCase().includes(q) ||
        (j.technicianName ?? '').toLowerCase().includes(q)
      );
    }
    return jobs;
  }, [repairQuery.data, statusFilter, searchQuery]);

  const filteredSessions = useMemo(() => {
    let sessions = fittingQuery.data ?? [];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      sessions = sessions.filter(s =>
        s.memberName.toLowerCase().includes(q) ||
        (s.technicianName ?? '').toLowerCase().includes(q)
      );
    }
    return sessions;
  }, [fittingQuery.data, searchQuery]);

  const KANBAN_STATUSES: RepairStatus[] = ['received', 'in_progress', 'ready_for_pickup', 'collected'];

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-full mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-xl">
              <Wrench className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Club Repair & Fitting</h1>
              <p className="text-sm text-muted-foreground">Pro shop repair queue and custom fitting sessions</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { repairQuery.refetch(); fittingQuery.refetch(); }}>
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
            {activeTab === 'repair' ? (
              <Button size="sm" onClick={() => { setEditingJob(null); setShowRepairDialog(true); }}>
                <Plus className="w-4 h-4 mr-1" /> New Repair Job
              </Button>
            ) : (
              <Button size="sm" onClick={() => { setEditingSession(null); setShowFittingDialog(true); }}>
                <Plus className="w-4 h-4 mr-1" /> Book Fitting
              </Button>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {KANBAN_STATUSES.map(s => {
            const count = (repairQuery.data ?? []).filter(j => j.status === s).length;
            return (
              <Card key={s} className="border-border/50 bg-card/50">
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{STATUS_LABELS[s]}</span>
                    <span className={`text-lg font-bold ${s === 'collected' ? 'text-muted-foreground' : 'text-foreground'}`}>{count}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={v => setActiveTab(v as any)}>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <TabsList>
              <TabsTrigger value="repair">
                <Wrench className="w-4 h-4 mr-1" /> Repair Jobs
              </TabsTrigger>
              <TabsTrigger value="fitting">
                <Ruler className="w-4 h-4 mr-1" /> Fitting Sessions
              </TabsTrigger>
            </TabsList>

            <div className="flex gap-2 items-center">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <Input
                  className="pl-8 w-52 h-9 text-sm"
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
              </div>
              {activeTab === 'repair' && (
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-9 w-44">
                    <Filter className="w-3.5 h-3.5 mr-1" />
                    <SelectValue placeholder="Filter by status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    {KANBAN_STATUSES.map(s => (
                      <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {/* Repair Jobs Kanban */}
          <TabsContent value="repair" className="mt-4">
            {repairQuery.isLoading ? (
              <div className="flex justify-center py-20"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className={`grid gap-4 ${statusFilter === 'all' ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-4' : 'grid-cols-1'}`}>
                {(statusFilter === 'all' ? KANBAN_STATUSES : [statusFilter as RepairStatus]).map(status => {
                  const colJobs = filteredJobs.filter(j => j.status === status);
                  return (
                    <div key={status} className={`rounded-xl border p-3 ${STATUS_COLUMN_COLORS[status]}`}>
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-muted-foreground">{STATUS_ICONS[status]}</span>
                        <span className="font-semibold text-sm">{STATUS_LABELS[status]}</span>
                        <span className="ml-auto bg-background/60 text-xs px-2 py-0.5 rounded-full">{colJobs.length}</span>
                      </div>
                      <div className="space-y-2">
                        {colJobs.map(job => (
                          <RepairJobCard
                            key={job.id}
                            job={job}
                            onEdit={() => { setEditingJob(job); setShowRepairDialog(true); }}
                            onDelete={() => setShowDeleteConfirm({ type: 'repair', id: job.id })}
                            onStatusChange={(newStatus) => updateJobStatus(orgId!, job.id, newStatus, qc, toast)}
                          />
                        ))}
                        {colJobs.length === 0 && (
                          <div className="text-center py-8 text-muted-foreground text-xs">No jobs</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* Fitting Sessions */}
          <TabsContent value="fitting" className="mt-4">
            {fittingQuery.isLoading ? (
              <div className="flex justify-center py-20"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
            ) : filteredSessions.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground">No fitting sessions found.</div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {filteredSessions.map(session => (
                  <FittingSessionCard
                    key={session.id}
                    session={session}
                    onEdit={() => { setEditingSession(session); setShowFittingDialog(true); }}
                    onDelete={() => setShowDeleteConfirm({ type: 'fitting', id: session.id })}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Repair Job Dialog */}
      <RepairJobDialog
        open={showRepairDialog}
        onClose={() => setShowRepairDialog(false)}
        job={editingJob}
        orgId={orgId!}
        onSaved={() => { setShowRepairDialog(false); qc.invalidateQueries({ queryKey: ['repair-jobs', orgId] }); }}
        toast={toast}
      />

      {/* Fitting Session Dialog */}
      <FittingSessionDialog
        open={showFittingDialog}
        onClose={() => setShowFittingDialog(false)}
        session={editingSession}
        orgId={orgId!}
        onSaved={() => { setShowFittingDialog(false); qc.invalidateQueries({ queryKey: ['fitting-sessions', orgId] }); }}
        toast={toast}
      />

      {/* Delete Confirm */}
      <Dialog open={!!showDeleteConfirm} onOpenChange={() => setShowDeleteConfirm(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Are you sure you want to delete this {showDeleteConfirm?.type === 'repair' ? 'repair job' : 'fitting session'}? This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => {
              if (!showDeleteConfirm || !orgId) return;
              try {
                const path = showDeleteConfirm.type === 'repair'
                  ? `/api/organizations/${orgId}/repair-jobs/${showDeleteConfirm.id}`
                  : `/api/organizations/${orgId}/fitting-sessions/${showDeleteConfirm.id}`;
                await apiFetch(path, { method: 'DELETE' });
                qc.invalidateQueries({ queryKey: [showDeleteConfirm.type === 'repair' ? 'repair-jobs' : 'fitting-sessions', orgId] });
                toast({ title: 'Deleted successfully' });
                setShowDeleteConfirm(null);
              } catch (e: any) {
                toast({ title: 'Error', description: e.message, variant: 'destructive' });
              }
            }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Quick status change helper ───────────────────────────────────────────────

async function updateJobStatus(orgId: number, jobId: number, status: RepairStatus, qc: any, toast: any) {
  try {
    await apiFetch(`/api/organizations/${orgId}/repair-jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    qc.invalidateQueries({ queryKey: ['repair-jobs', orgId] });
    toast({ title: `Status updated to ${STATUS_LABELS[status]}` });
  } catch (e: any) {
    toast({ title: 'Error', description: e.message, variant: 'destructive' });
  }
}

// ─── Repair Job Card ──────────────────────────────────────────────────────────

function RepairJobCard({ job, onEdit, onDelete, onStatusChange }: {
  job: RepairJob;
  onEdit: () => void;
  onDelete: () => void;
  onStatusChange: (status: RepairStatus) => void;
}) {
  const statusOrder: RepairStatus[] = ['received', 'in_progress', 'ready_for_pickup', 'collected'];
  const currentIdx = statusOrder.indexOf(job.status);
  const nextStatus = statusOrder[currentIdx + 1] as RepairStatus | undefined;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card/80 border border-border/50 rounded-lg p-3 space-y-2 hover:border-border transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">{job.memberName}</div>
          <div className="text-xs text-muted-foreground">{JOB_TYPE_LABELS[job.jobType]}</div>
        </div>
        <div className="flex gap-1 shrink-0">
          <button onClick={onEdit} className="p-1 hover:bg-muted rounded transition-colors">
            <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <button onClick={onDelete} className="p-1 hover:bg-destructive/10 rounded transition-colors">
            <Trash2 className="w-3.5 h-3.5 text-destructive/70" />
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground line-clamp-2">{job.description}</p>

      {job.technicianName && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <User className="w-3 h-3" /> {job.technicianName}
        </div>
      )}
      {job.expectedCompletionDate && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <CalendarDays className="w-3 h-3" /> {new Date(job.expectedCompletionDate).toLocaleDateString()}
        </div>
      )}
      {job.notificationSentAt && (
        <div className="flex items-center gap-1 text-xs text-green-400">
          <Bell className="w-3 h-3" /> Notified
        </div>
      )}

      {nextStatus && (
        <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={() => onStatusChange(nextStatus)}>
          Move to {STATUS_LABELS[nextStatus]} <ChevronRight className="w-3 h-3 ml-1" />
        </Button>
      )}
    </motion.div>
  );
}

// ─── Fitting Session Card ─────────────────────────────────────────────────────

function FittingSessionCard({ session, onEdit, onDelete }: {
  session: FittingSession;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const specs = session.recommendedSpecs ?? {};
  const hasSpecs = Object.keys(specs).some(k => k !== 'notes' && specs[k as keyof typeof specs]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card/80 border border-border/50 rounded-lg p-4 space-y-3 hover:border-border transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-sm">{session.memberName}</div>
          {session.memberEmail && <div className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="w-3 h-3" />{session.memberEmail}</div>}
        </div>
        <div className="flex gap-1 shrink-0">
          <Badge className={`text-xs border ${FITTING_STATUS_COLORS[session.status]}`}>{session.status}</Badge>
          <button onClick={onEdit} className="p-1 hover:bg-muted rounded ml-1 transition-colors">
            <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <button onClick={onDelete} className="p-1 hover:bg-destructive/10 rounded transition-colors">
            <Trash2 className="w-3.5 h-3.5 text-destructive/70" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3" />{new Date(session.scheduledAt).toLocaleString()}</span>
        {session.technicianName && <span className="flex items-center gap-1"><User className="w-3 h-3" />{session.technicianName}</span>}
      </div>

      {hasSpecs && (
        <div className="bg-muted/30 rounded-lg p-2 text-xs space-y-1">
          <div className="font-medium text-muted-foreground mb-1">Recommended Specs</div>
          {specs.shaftFlex && <div><span className="text-muted-foreground">Shaft Flex:</span> {specs.shaftFlex}</div>}
          {specs.shaftMaterial && <div><span className="text-muted-foreground">Material:</span> {specs.shaftMaterial}</div>}
          {specs.headType && <div><span className="text-muted-foreground">Head:</span> {specs.headType}</div>}
          {specs.loft && <div><span className="text-muted-foreground">Loft:</span> {specs.loft}</div>}
          {specs.lie && <div><span className="text-muted-foreground">Lie:</span> {specs.lie}</div>}
          {specs.gripSize && <div><span className="text-muted-foreground">Grip Size:</span> {specs.gripSize}</div>}
          {specs.notes && <div className="text-muted-foreground mt-1 italic">{specs.notes}</div>}
        </div>
      )}

      {session.notes && <p className="text-xs text-muted-foreground italic">{session.notes}</p>}
    </motion.div>
  );
}

// ─── Repair Job Dialog ────────────────────────────────────────────────────────

function RepairJobDialog({ open, onClose, job, orgId, onSaved, toast }: {
  open: boolean;
  onClose: () => void;
  job: RepairJob | null;
  orgId: number;
  onSaved: () => void;
  toast: any;
}) {
  const isEdit = !!job;
  const [form, setForm] = useState({
    memberName: '',
    memberEmail: '',
    jobType: 'other' as RepairJobType,
    description: '',
    status: 'received' as RepairStatus,
    technicianName: '',
    expectedCompletionDate: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);

  // Sync form when editing
  const handleOpenChange = (o: boolean) => {
    if (o && job) {
      setForm({
        memberName: job.memberName,
        memberEmail: job.memberEmail ?? '',
        jobType: job.jobType,
        description: job.description,
        status: job.status,
        technicianName: job.technicianName ?? '',
        expectedCompletionDate: job.expectedCompletionDate ? job.expectedCompletionDate.slice(0, 10) : '',
        notes: job.notes ?? '',
      });
    } else if (o) {
      setForm({ memberName: '', memberEmail: '', jobType: 'other', description: '', status: 'received', technicianName: '', expectedCompletionDate: '', notes: '' });
    }
    if (!o) onClose();
  };

  // Initialize on open
  if (open && !saving && form.memberName === '' && job) {
    setForm({
      memberName: job.memberName,
      memberEmail: job.memberEmail ?? '',
      jobType: job.jobType,
      description: job.description,
      status: job.status,
      technicianName: job.technicianName ?? '',
      expectedCompletionDate: job.expectedCompletionDate ? job.expectedCompletionDate.slice(0, 10) : '',
      notes: job.notes ?? '',
    });
  }

  async function handleSave() {
    if (!form.memberName.trim() || !form.description.trim()) {
      toast({ title: 'Validation Error', description: 'Member name and description are required', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const path = isEdit
        ? `/api/organizations/${orgId}/repair-jobs/${job!.id}`
        : `/api/organizations/${orgId}/repair-jobs`;
      await apiFetch(path, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          expectedCompletionDate: form.expectedCompletionDate || null,
          technicianName: form.technicianName || null,
          memberEmail: form.memberEmail || null,
        }),
      });
      toast({ title: isEdit ? 'Repair job updated' : 'Repair job created' });
      onSaved();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Repair Job' : 'New Repair Job'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>Member Name *</Label>
              <Input value={form.memberName} onChange={e => setForm(f => ({ ...f, memberName: e.target.value }))} placeholder="John Smith" />
            </div>
            <div className="space-y-1">
              <Label>Member Email</Label>
              <Input type="email" value={form.memberEmail} onChange={e => setForm(f => ({ ...f, memberEmail: e.target.value }))} placeholder="john@example.com" />
            </div>
            <div className="space-y-1">
              <Label>Job Type</Label>
              <Select value={form.jobType} onValueChange={v => setForm(f => ({ ...f, jobType: v as RepairJobType }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(JOB_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1">
              <Label>Description *</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Describe the repair work needed..." rows={3} />
            </div>
            {isEdit && (
              <div className="space-y-1">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v as RepairStatus }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="received">Received</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="ready_for_pickup">Ready for Pickup</SelectItem>
                    <SelectItem value="collected">Collected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>Technician Name</Label>
              <Input value={form.technicianName} onChange={e => setForm(f => ({ ...f, technicianName: e.target.value }))} placeholder="Technician name" />
            </div>
            <div className="space-y-1">
              <Label>Expected Completion</Label>
              <Input type="date" value={form.expectedCompletionDate} onChange={e => setForm(f => ({ ...f, expectedCompletionDate: e.target.value }))} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>Notes</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Any additional notes..." rows={2} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : isEdit ? 'Update' : 'Create Job'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Fitting Session Dialog ───────────────────────────────────────────────────

function FittingSessionDialog({ open, onClose, session, orgId, onSaved, toast }: {
  open: boolean;
  onClose: () => void;
  session: FittingSession | null;
  orgId: number;
  onSaved: () => void;
  toast: any;
}) {
  const isEdit = !!session;
  const [form, setForm] = useState({
    memberName: '',
    memberEmail: '',
    scheduledAt: '',
    status: 'booked' as FittingStatus,
    technicianName: '',
    notes: '',
    specs: {
      shaftFlex: '',
      shaftMaterial: '',
      headType: '',
      loft: '',
      lie: '',
      gripSize: '',
      notes: '',
    },
  });
  const [saving, setSaving] = useState(false);

  const initForm = (s: FittingSession | null) => {
    if (s) {
      const specs = s.recommendedSpecs ?? {};
      setForm({
        memberName: s.memberName,
        memberEmail: s.memberEmail ?? '',
        scheduledAt: s.scheduledAt ? s.scheduledAt.slice(0, 16) : '',
        status: s.status,
        technicianName: s.technicianName ?? '',
        notes: s.notes ?? '',
        specs: {
          shaftFlex: specs.shaftFlex ?? '',
          shaftMaterial: specs.shaftMaterial ?? '',
          headType: specs.headType ?? '',
          loft: specs.loft ?? '',
          lie: specs.lie ?? '',
          gripSize: specs.gripSize ?? '',
          notes: specs.notes ?? '',
        },
      });
    } else {
      setForm({ memberName: '', memberEmail: '', scheduledAt: '', status: 'booked', technicianName: '', notes: '', specs: { shaftFlex: '', shaftMaterial: '', headType: '', loft: '', lie: '', gripSize: '', notes: '' } });
    }
  };

  // Initialize when dialog opens
  useState(() => { if (open) initForm(session); });

  async function handleSave() {
    if (!form.memberName.trim() || !form.scheduledAt) {
      toast({ title: 'Validation Error', description: 'Member name and scheduled date are required', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const recommendedSpecs = Object.fromEntries(
        Object.entries(form.specs).filter(([, v]) => v.trim() !== '')
      );
      const path = isEdit
        ? `/api/organizations/${orgId}/fitting-sessions/${session!.id}`
        : `/api/organizations/${orgId}/fitting-sessions`;
      await apiFetch(path, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberName: form.memberName,
          memberEmail: form.memberEmail || null,
          scheduledAt: form.scheduledAt,
          status: form.status,
          technicianName: form.technicianName || null,
          notes: form.notes || null,
          recommendedSpecs,
        }),
      });
      toast({ title: isEdit ? 'Fitting session updated' : 'Fitting session booked' });
      onSaved();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { onClose(); } else { initForm(session); } }}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Fitting Session' : 'Book Fitting Session'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label>Member Name *</Label>
              <Input value={form.memberName} onChange={e => setForm(f => ({ ...f, memberName: e.target.value }))} placeholder="John Smith" />
            </div>
            <div className="space-y-1">
              <Label>Member Email</Label>
              <Input type="email" value={form.memberEmail} onChange={e => setForm(f => ({ ...f, memberEmail: e.target.value }))} placeholder="john@example.com" />
            </div>
            <div className="space-y-1">
              <Label>Scheduled At *</Label>
              <Input type="datetime-local" value={form.scheduledAt} onChange={e => setForm(f => ({ ...f, scheduledAt: e.target.value }))} />
            </div>
            {isEdit && (
              <div className="space-y-1">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v as FittingStatus }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="booked">Booked</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>Technician Name</Label>
              <Input value={form.technicianName} onChange={e => setForm(f => ({ ...f, technicianName: e.target.value }))} placeholder="Fitter name" />
            </div>
          </div>

          <div className="border border-border/50 rounded-lg p-3 space-y-3">
            <div className="text-sm font-medium flex items-center gap-1.5"><Ruler className="w-4 h-4" /> Recommended Specs</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { key: 'shaftFlex', label: 'Shaft Flex', placeholder: 'e.g. Regular, Stiff' },
                { key: 'shaftMaterial', label: 'Shaft Material', placeholder: 'e.g. Steel, Graphite' },
                { key: 'headType', label: 'Head Type', placeholder: 'e.g. Blade, Cavity' },
                { key: 'loft', label: 'Loft', placeholder: 'e.g. 10.5°' },
                { key: 'lie', label: 'Lie', placeholder: 'e.g. 60°' },
                { key: 'gripSize', label: 'Grip Size', placeholder: 'e.g. Standard, Midsize' },
              ].map(({ key, label, placeholder }) => (
                <div key={key} className="space-y-1">
                  <Label className="text-xs">{label}</Label>
                  <Input
                    className="h-8 text-sm"
                    placeholder={placeholder}
                    value={form.specs[key as keyof typeof form.specs]}
                    onChange={e => setForm(f => ({ ...f, specs: { ...f.specs, [key]: e.target.value } }))}
                  />
                </div>
              ))}
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Spec Notes</Label>
                <Textarea
                  className="text-sm"
                  placeholder="Additional spec notes..."
                  rows={2}
                  value={form.specs.notes}
                  onChange={e => setForm(f => ({ ...f, specs: { ...f.specs, notes: e.target.value } }))}
                />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Session Notes</Label>
            <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Any additional session notes..." rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : isEdit ? 'Update' : 'Book Session'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
