import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Wrench, ClipboardList, Tractor, AlertTriangle, Plus, Check, X, Edit2,
  Trash2, ChevronDown, Bell, BellOff, Pin, PinOff, Calendar, User,
  RefreshCw, CheckCircle, Clock, AlertCircle, Flag, Leaf,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
function API(path: string) { return `${BASE_URL}/api${path}`; }

// ─── Types ────────────────────────────────────────────────────────────────────

type CourseArea =
  | 'hole_1' | 'hole_2' | 'hole_3' | 'hole_4' | 'hole_5' | 'hole_6' | 'hole_7' | 'hole_8' | 'hole_9'
  | 'hole_10' | 'hole_11' | 'hole_12' | 'hole_13' | 'hole_14' | 'hole_15' | 'hole_16' | 'hole_17' | 'hole_18'
  | 'driving_range' | 'practice_green' | 'clubhouse_surrounds' | 'car_park' | 'general';

type ConditionRating = 'excellent' | 'good' | 'fair' | 'poor' | 'closed';
type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'overdue' | 'cancelled';
type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
type EquipmentType = 'mower_fairway' | 'mower_green' | 'mower_rough' | 'mower_tee' | 'irrigation_pump' | 'irrigation_controller' | 'aerator' | 'scarifier' | 'topdresser' | 'sprayer' | 'tractor' | 'utility_vehicle' | 'other';
type NoticeType = 'closure' | 'gur' | 'preferred_lies' | 'temporary_green' | 'hazard' | 'general';

interface ConditionReport {
  report: {
    id: number; area: CourseArea; greenSpeed: string | null;
    fairwayCondition: ConditionRating | null; greenCondition: ConditionRating | null;
    teeCondition: ConditionRating | null; roughCondition: ConditionRating | null;
    bunkerCondition: ConditionRating | null; notes: string | null;
    photoUrls: string[]; reportDate: string; createdAt: string;
  };
  reporterName: string | null; reporterUsername: string | null;
}

interface MaintenanceTask {
  task: {
    id: number; title: string; description: string | null; area: CourseArea | null;
    priority: TaskPriority; status: TaskStatus; dueDate: string | null;
    completedAt: string | null; completionNotes: string | null; photoUrls: string[];
    createdAt: string; updatedAt: string;
  };
  assignedName: string | null; assignedUsername: string | null;
}

interface EquipmentRecord {
  id: number; name: string; equipmentType: EquipmentType; serialNumber: string | null;
  make: string | null; model: string | null; purchaseDate: string | null;
  isActive: boolean; notes: string | null; createdAt: string;
}

interface ServiceLog {
  log: {
    id: number; serviceType: string; description: string | null;
    hoursAtService: string | null; nextServiceHours: string | null;
    nextServiceDate: string | null; cost: string | null;
    photoUrls: string[]; serviceDate: string;
  };
  loggedByName: string | null; loggedByUsername: string | null;
}

interface CourseNotice {
  notice: {
    id: number; title: string; body: string; noticeType: NoticeType;
    area: CourseArea | null; isPublished: boolean; isPinned: boolean;
    expiresAt: string | null; publishedAt: string | null; createdAt: string;
  };
  createdByName: string | null; createdByUsername: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AREA_LABELS: Record<CourseArea, string> = {
  hole_1: 'Hole 1', hole_2: 'Hole 2', hole_3: 'Hole 3', hole_4: 'Hole 4', hole_5: 'Hole 5',
  hole_6: 'Hole 6', hole_7: 'Hole 7', hole_8: 'Hole 8', hole_9: 'Hole 9',
  hole_10: 'Hole 10', hole_11: 'Hole 11', hole_12: 'Hole 12', hole_13: 'Hole 13', hole_14: 'Hole 14',
  hole_15: 'Hole 15', hole_16: 'Hole 16', hole_17: 'Hole 17', hole_18: 'Hole 18',
  driving_range: 'Driving Range', practice_green: 'Practice Green',
  clubhouse_surrounds: 'Clubhouse Surrounds', car_park: 'Car Park', general: 'General',
};

const CONDITION_COLORS: Record<ConditionRating, string> = {
  excellent: 'bg-emerald-500/20 text-emerald-400',
  good: 'bg-green-500/20 text-green-400',
  fair: 'bg-yellow-500/20 text-yellow-400',
  poor: 'bg-orange-500/20 text-orange-400',
  closed: 'bg-red-500/20 text-red-400',
};

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: 'bg-slate-500/20 text-slate-400',
  medium: 'bg-blue-500/20 text-blue-400',
  high: 'bg-orange-500/20 text-orange-400',
  urgent: 'bg-red-500/20 text-red-400',
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: 'bg-slate-500/20 text-slate-400',
  in_progress: 'bg-blue-500/20 text-blue-400',
  completed: 'bg-emerald-500/20 text-emerald-400',
  overdue: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-gray-500/20 text-gray-400',
};

const NOTICE_TYPE_LABELS: Record<NoticeType, string> = {
  closure: 'Course Closure', gur: 'Ground Under Repair', preferred_lies: 'Preferred Lies',
  temporary_green: 'Temporary Green', hazard: 'Hazard Notice', general: 'General Notice',
};

const EQUIPMENT_TYPE_LABELS: Record<EquipmentType, string> = {
  mower_fairway: 'Fairway Mower', mower_green: 'Green Mower', mower_rough: 'Rough Mower',
  mower_tee: 'Tee Mower', irrigation_pump: 'Irrigation Pump',
  irrigation_controller: 'Irrigation Controller', aerator: 'Aerator', scarifier: 'Scarifier',
  topdresser: 'Topdresser', sprayer: 'Sprayer', tractor: 'Tractor',
  utility_vehicle: 'Utility Vehicle', other: 'Other',
};

function fmtDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const COURSE_AREAS: CourseArea[] = [
  'hole_1','hole_2','hole_3','hole_4','hole_5','hole_6','hole_7','hole_8','hole_9',
  'hole_10','hole_11','hole_12','hole_13','hole_14','hole_15','hole_16','hole_17','hole_18',
  'driving_range','practice_green','clubhouse_surrounds','car_park','general',
];

const CONDITION_RATINGS: ConditionRating[] = ['excellent', 'good', 'fair', 'poor', 'closed'];

// ─── Conditions Tab ──────────────────────────────────────────────────────────

function ConditionsTab({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    area: '' as CourseArea | '',
    greenSpeed: '', fairwayCondition: '', greenCondition: '',
    teeCondition: '', roughCondition: '', bunkerCondition: '',
    notes: '', reportDate: new Date().toISOString().slice(0, 16),
  });

  const { data, isLoading } = useQuery<{ reports: ConditionReport[] }>({
    queryKey: [`/api/organizations/${orgId}/maintenance/conditions`],
    queryFn: () => fetch(API(`/organizations/${orgId}/maintenance/conditions?limit=50`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: summaryData } = useQuery<{ reports: ConditionReport[] }>({
    queryKey: [`/api/organizations/${orgId}/maintenance/conditions/summary`],
    queryFn: () => fetch(API(`/organizations/${orgId}/maintenance/conditions/summary`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const create = useMutation({
    mutationFn: (body: object) => fetch(API(`/organizations/${orgId}/maintenance/conditions`), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/conditions`] });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/conditions/summary`] });
      toast({ title: 'Condition report logged' });
      setShowForm(false);
      setForm({ area: '', greenSpeed: '', fairwayCondition: '', greenCondition: '', teeCondition: '', roughCondition: '', bunkerCondition: '', notes: '', reportDate: new Date().toISOString().slice(0, 16) });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const del = useMutation({
    mutationFn: (id: number) => fetch(API(`/organizations/${orgId}/maintenance/conditions/${id}`), {
      method: 'DELETE', credentials: 'include',
    }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/conditions`] });
      toast({ title: 'Report deleted' });
    },
  });

  const handleSubmit = () => {
    if (!form.area) { toast({ title: 'Area is required', variant: 'destructive' }); return; }
    create.mutate({
      area: form.area, greenSpeed: form.greenSpeed || undefined,
      fairwayCondition: form.fairwayCondition || undefined,
      greenCondition: form.greenCondition || undefined,
      teeCondition: form.teeCondition || undefined,
      roughCondition: form.roughCondition || undefined,
      bunkerCondition: form.bunkerCondition || undefined,
      notes: form.notes || undefined,
      reportDate: form.reportDate ? new Date(form.reportDate).toISOString() : undefined,
    });
  };

  const weeklyCount = summaryData?.reports?.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Leaf className="w-4 h-4 text-primary" />
          <span>{weeklyCount} report{weeklyCount !== 1 ? 's' : ''} this week</span>
        </div>
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4 mr-1" /> Log Condition
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-3">
          {(data?.reports ?? []).length === 0 ? (
            <Card><CardContent className="py-10 text-center text-muted-foreground">No condition reports yet</CardContent></Card>
          ) : (data?.reports ?? []).map(({ report, reporterName, reporterUsername }) => (
            <Card key={report.id} className="border-white/5 bg-card/50">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-white">{AREA_LABELS[report.area]}</span>
                      {report.greenSpeed && (
                        <Badge variant="outline" className="text-xs">Stimp {report.greenSpeed}</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {report.fairwayCondition && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONDITION_COLORS[report.fairwayCondition]}`}>Fairway: {report.fairwayCondition}</span>
                      )}
                      {report.greenCondition && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONDITION_COLORS[report.greenCondition]}`}>Green: {report.greenCondition}</span>
                      )}
                      {report.teeCondition && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONDITION_COLORS[report.teeCondition]}`}>Tee: {report.teeCondition}</span>
                      )}
                      {report.roughCondition && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONDITION_COLORS[report.roughCondition]}`}>Rough: {report.roughCondition}</span>
                      )}
                      {report.bunkerCondition && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONDITION_COLORS[report.bunkerCondition]}`}>Bunker: {report.bunkerCondition}</span>
                      )}
                    </div>
                    {report.notes && <p className="text-sm text-muted-foreground mt-1.5 line-clamp-2">{report.notes}</p>}
                    <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                      <span>{fmtDateTime(report.reportDate)}</span>
                      {(reporterName || reporterUsername) && (
                        <span className="flex items-center gap-1"><User className="w-3 h-3" />{reporterName || reporterUsername}</span>
                      )}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-red-400 flex-shrink-0"
                    onClick={() => { if (confirm('Delete this report?')) del.mutate(report.id); }}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Log Condition Report</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Area *</Label>
              <Select value={form.area} onValueChange={v => setForm(f => ({ ...f, area: v as CourseArea }))}>
                <SelectTrigger><SelectValue placeholder="Select area" /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {COURSE_AREAS.map(a => <SelectItem key={a} value={a}>{AREA_LABELS[a]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Report Date/Time</Label>
              <Input type="datetime-local" value={form.reportDate} onChange={e => setForm(f => ({ ...f, reportDate: e.target.value }))} />
            </div>
            <div>
              <Label>Green Speed (Stimpmeter)</Label>
              <Input type="number" min="0" max="20" step="0.1" placeholder="e.g. 9.5" value={form.greenSpeed}
                onChange={e => setForm(f => ({ ...f, greenSpeed: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(['fairwayCondition', 'greenCondition', 'teeCondition', 'roughCondition', 'bunkerCondition'] as const).map(field => (
                <div key={field}>
                  <Label className="capitalize">{field.replace('Condition', '').replace(/([A-Z])/g, ' $1')}</Label>
                  <Select value={((form as never)[field] as string) || "_empty"} onValueChange={v => setForm(f => ({ ...f, [field]: v === "_empty" ? "" : v }))}>
                    <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_empty">—</SelectItem>
                      {CONDITION_RATINGS.map(r => <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea rows={3} placeholder="Additional observations..." value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={create.isPending}>
              {create.isPending ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : null} Submit Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Tasks Tab ────────────────────────────────────────────────────────────────

function TasksTab({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editTask, setEditTask] = useState<MaintenanceTask | null>(null);
  const [filterStatus, setFilterStatus] = useState('');
  const [form, setForm] = useState({
    title: '', description: '', area: '', priority: 'medium', dueDate: '', assignedToId: '',
  });

  const { data, isLoading } = useQuery<{ tasks: MaintenanceTask[] }>({
    queryKey: [`/api/organizations/${orgId}/maintenance/tasks`, filterStatus],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      return fetch(API(`/organizations/${orgId}/maintenance/tasks?${params}`), { credentials: 'include' }).then(r => r.json());
    },
    enabled: !!orgId,
  });

  const { data: overdueData } = useQuery<{ tasks: MaintenanceTask[] }>({
    queryKey: [`/api/organizations/${orgId}/maintenance/tasks/overdue`],
    queryFn: () => fetch(API(`/organizations/${orgId}/maintenance/tasks/overdue`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });
  const overdueCount = overdueData?.tasks?.length ?? 0;

  const create = useMutation({
    mutationFn: (body: object) => fetch(API(`/organizations/${orgId}/maintenance/tasks`), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/tasks`] });
      toast({ title: 'Task created' });
      setShowForm(false);
      setForm({ title: '', description: '', area: '', priority: 'medium', dueDate: '', assignedToId: '' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: object }) =>
      fetch(API(`/organizations/${orgId}/maintenance/tasks/${id}`), {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/tasks`] });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/tasks/overdue`] });
      toast({ title: 'Task updated' });
      setEditTask(null);
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const del = useMutation({
    mutationFn: (id: number) => fetch(API(`/organizations/${orgId}/maintenance/tasks/${id}`), {
      method: 'DELETE', credentials: 'include',
    }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/tasks`] });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/tasks/overdue`] });
      toast({ title: 'Task deleted' });
    },
  });

  const handleSubmit = () => {
    if (!form.title.trim()) { toast({ title: 'Title is required', variant: 'destructive' }); return; }
    create.mutate({
      title: form.title, description: form.description || undefined,
      area: form.area || undefined, priority: form.priority,
      dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : undefined,
      assignedToId: form.assignedToId ? parseInt(form.assignedToId) : undefined,
    });
  };

  const StatusIcon = ({ status }: { status: TaskStatus }) => {
    if (status === 'completed') return <CheckCircle className="w-4 h-4 text-emerald-400" />;
    if (status === 'overdue') return <AlertCircle className="w-4 h-4 text-red-400" />;
    if (status === 'in_progress') return <RefreshCw className="w-4 h-4 text-blue-400" />;
    if (status === 'cancelled') return <X className="w-4 h-4 text-gray-400" />;
    return <Clock className="w-4 h-4 text-muted-foreground" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          {overdueCount > 0 && (
            <div className="flex items-center gap-1.5 text-sm text-red-400">
              <AlertTriangle className="w-4 h-4" />
              <span>{overdueCount} overdue</span>
            </div>
          )}
          <Select value={filterStatus || "_empty"} onValueChange={v => setFilterStatus(v === "_empty" ? "" : v)}>
            <SelectTrigger className="w-36 h-8 text-sm"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_empty">All</SelectItem>
              {(['pending','in_progress','completed','overdue','cancelled'] as TaskStatus[]).map(s => (
                <SelectItem key={s} value={s} className="capitalize">{s.replace('_', ' ')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4 mr-1" /> New Task
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-3">
          {(data?.tasks ?? []).length === 0 ? (
            <Card><CardContent className="py-10 text-center text-muted-foreground">No tasks found</CardContent></Card>
          ) : (data?.tasks ?? []).map(({ task, assignedName, assignedUsername }) => (
            <Card key={task.id} className="border-white/5 bg-card/50">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <StatusIcon status={task.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-white">{task.title}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PRIORITY_COLORS[task.priority]}`}>{task.priority}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[task.status]}`}>{task.status.replace('_', ' ')}</span>
                    </div>
                    {task.description && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{task.description}</p>}
                    <div className="flex flex-wrap gap-3 mt-2 text-xs text-muted-foreground">
                      {task.area && <span>{AREA_LABELS[task.area]}</span>}
                      {task.dueDate && <span className={`flex items-center gap-1 ${new Date(task.dueDate) < new Date() && task.status !== 'completed' ? 'text-red-400' : ''}`}>
                        <Calendar className="w-3 h-3" /> Due {fmtDate(task.dueDate)}
                      </span>}
                      {(assignedName || assignedUsername) && (
                        <span className="flex items-center gap-1"><User className="w-3 h-3" />{assignedName || assignedUsername}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => setEditTask({ task, assignedName, assignedUsername })}>
                      <Edit2 className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="hover:text-red-400"
                      onClick={() => { if (confirm('Delete task?')) del.mutate(task.id); }}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Maintenance Task</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Title *</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Task description" />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea rows={2} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Area</Label>
                <Select value={form.area || "_empty"} onValueChange={v => setForm(f => ({ ...f, area: v === "_empty" ? "" : v }))}>
                  <SelectTrigger><SelectValue placeholder="Select area" /></SelectTrigger>
                  <SelectContent className="max-h-60">
                    <SelectItem value="_empty">— None —</SelectItem>
                    {COURSE_AREAS.map(a => <SelectItem key={a} value={a}>{AREA_LABELS[a]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Priority</Label>
                <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(['low','medium','high','urgent'] as TaskPriority[]).map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Due Date</Label>
              <Input type="datetime-local" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={create.isPending}>
              {create.isPending ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : null} Create Task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editTask && (
        <Dialog open onOpenChange={() => setEditTask(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Update Task</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div>
                <Label>Status</Label>
                <Select defaultValue={editTask.task.status} onValueChange={v => update.mutate({ id: editTask.task.id, body: { status: v } })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(['pending','in_progress','completed','cancelled'] as TaskStatus[]).map(s => (
                      <SelectItem key={s} value={s} className="capitalize">{s.replace('_', ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Completion Notes</Label>
                <Textarea rows={3} defaultValue={editTask.task.completionNotes ?? ''} id="completion-notes" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditTask(null)}>Cancel</Button>
              <Button onClick={() => {
                const notes = (document.getElementById('completion-notes') as HTMLTextAreaElement)?.value;
                update.mutate({ id: editTask.task.id, body: { completionNotes: notes } });
              }} disabled={update.isPending}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Equipment Tab ────────────────────────────────────────────────────────────

function EquipmentTab({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [selectedEquip, setSelectedEquip] = useState<EquipmentRecord | null>(null);
  const [showLogForm, setShowLogForm] = useState(false);
  const [form, setForm] = useState({ name: '', equipmentType: '' as EquipmentType | '', make: '', model: '', serialNumber: '', notes: '' });
  const [logForm, setLogForm] = useState({ serviceType: '', description: '', hoursAtService: '', nextServiceHours: '', cost: '', serviceDate: new Date().toISOString().slice(0, 16) });

  const { data, isLoading } = useQuery<{ equipment: EquipmentRecord[] }>({
    queryKey: [`/api/organizations/${orgId}/maintenance/equipment`],
    queryFn: () => fetch(API(`/organizations/${orgId}/maintenance/equipment`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: logsData } = useQuery<{ logs: ServiceLog[] }>({
    queryKey: [`/api/organizations/${orgId}/maintenance/equipment/${selectedEquip?.id}/service-logs`],
    queryFn: () => fetch(API(`/organizations/${orgId}/maintenance/equipment/${selectedEquip!.id}/service-logs`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!selectedEquip,
  });

  const create = useMutation({
    mutationFn: (body: object) => fetch(API(`/organizations/${orgId}/maintenance/equipment`), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/equipment`] });
      toast({ title: 'Equipment added' });
      setShowForm(false);
      setForm({ name: '', equipmentType: '', make: '', model: '', serialNumber: '', notes: '' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const createLog = useMutation({
    mutationFn: (body: object) => fetch(API(`/organizations/${orgId}/maintenance/equipment/${selectedEquip!.id}/service-logs`), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/equipment/${selectedEquip?.id}/service-logs`] });
      toast({ title: 'Service log added' });
      setShowLogForm(false);
      setLogForm({ serviceType: '', description: '', hoursAtService: '', nextServiceHours: '', cost: '', serviceDate: new Date().toISOString().slice(0, 16) });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{data?.equipment?.length ?? 0} piece{(data?.equipment?.length ?? 0) !== 1 ? 's' : ''} of equipment</span>
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4 mr-1" /> Add Equipment
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {isLoading ? (
          <div className="col-span-2 flex items-center justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (data?.equipment ?? []).length === 0 ? (
          <Card className="col-span-2"><CardContent className="py-10 text-center text-muted-foreground">No equipment registered yet</CardContent></Card>
        ) : (data?.equipment ?? []).map(equip => (
          <Card key={equip.id} className="border-white/5 bg-card/50 cursor-pointer hover:border-primary/30 transition-colors"
            onClick={() => setSelectedEquip(s => s?.id === equip.id ? null : equip)}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-white">{equip.name}</p>
                  <p className="text-xs text-muted-foreground">{EQUIPMENT_TYPE_LABELS[equip.equipmentType]}</p>
                  {(equip.make || equip.model) && (
                    <p className="text-xs text-muted-foreground">{[equip.make, equip.model].filter(Boolean).join(' ')}</p>
                  )}
                  {equip.serialNumber && <p className="text-xs text-muted-foreground mt-0.5">S/N: {equip.serialNumber}</p>}
                </div>
                <Badge variant={equip.isActive ? 'default' : 'secondary'} className="text-xs">
                  {equip.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {selectedEquip && (
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{selectedEquip.name} — Service Log</CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => { setSelectedEquip(null); setShowLogForm(false); }}>
                  <X className="w-4 h-4" />
                </Button>
                <Button size="sm" onClick={() => setShowLogForm(true)}>
                  <Plus className="w-4 h-4 mr-1" /> Log Service
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {(logsData?.logs ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No service records yet</p>
            ) : (logsData?.logs ?? []).map(({ log, loggedByName }) => (
              <div key={log.id} className="p-3 rounded-lg bg-card/50 border border-white/5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium text-white text-sm">{log.serviceType}</p>
                    {log.description && <p className="text-xs text-muted-foreground mt-0.5">{log.description}</p>}
                    <div className="flex gap-3 mt-1.5 text-xs text-muted-foreground">
                      <span>{fmtDate(log.serviceDate)}</span>
                      {log.hoursAtService && <span>{log.hoursAtService}h at service</span>}
                      {log.cost && <span>₹{parseFloat(log.cost).toLocaleString()}</span>}
                      {loggedByName && <span>{loggedByName}</span>}
                    </div>
                    {log.nextServiceDate && (
                      <p className="text-xs text-amber-400 mt-1">Next service: {fmtDate(log.nextServiceDate)}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add Equipment</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Name *</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Greens Mower #1" />
            </div>
            <div>
              <Label>Type *</Label>
              <Select value={form.equipmentType} onValueChange={v => setForm(f => ({ ...f, equipmentType: v as EquipmentType }))}>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {(Object.entries(EQUIPMENT_TYPE_LABELS)).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Make</Label><Input value={form.make} onChange={e => setForm(f => ({ ...f, make: e.target.value }))} placeholder="e.g. John Deere" /></div>
              <div><Label>Model</Label><Input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder="e.g. 2500E" /></div>
            </div>
            <div><Label>Serial Number</Label><Input value={form.serialNumber} onChange={e => setForm(f => ({ ...f, serialNumber: e.target.value }))} /></div>
            <div><Label>Notes</Label><Textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button onClick={() => {
              if (!form.name.trim() || !form.equipmentType) { toast({ title: 'Name and type required', variant: 'destructive' }); return; }
              create.mutate({ name: form.name, equipmentType: form.equipmentType, make: form.make || undefined, model: form.model || undefined, serialNumber: form.serialNumber || undefined, notes: form.notes || undefined });
            }} disabled={create.isPending}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showLogForm} onOpenChange={setShowLogForm}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Log Service — {selectedEquip?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div><Label>Service Type *</Label><Input value={logForm.serviceType} onChange={e => setLogForm(f => ({ ...f, serviceType: e.target.value }))} placeholder="e.g. Oil change, blade sharpening" /></div>
            <div><Label>Description</Label><Textarea rows={2} value={logForm.description} onChange={e => setLogForm(f => ({ ...f, description: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Hours at Service</Label><Input type="number" step="0.1" value={logForm.hoursAtService} onChange={e => setLogForm(f => ({ ...f, hoursAtService: e.target.value }))} /></div>
              <div><Label>Next Service (hrs)</Label><Input type="number" step="0.1" value={logForm.nextServiceHours} onChange={e => setLogForm(f => ({ ...f, nextServiceHours: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Cost</Label><Input type="number" step="0.01" value={logForm.cost} onChange={e => setLogForm(f => ({ ...f, cost: e.target.value }))} /></div>
              <div><Label>Service Date</Label><Input type="datetime-local" value={logForm.serviceDate} onChange={e => setLogForm(f => ({ ...f, serviceDate: e.target.value }))} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLogForm(false)}>Cancel</Button>
            <Button onClick={() => {
              if (!logForm.serviceType.trim()) { toast({ title: 'Service type required', variant: 'destructive' }); return; }
              createLog.mutate({ serviceType: logForm.serviceType, description: logForm.description || undefined, hoursAtService: logForm.hoursAtService || undefined, nextServiceHours: logForm.nextServiceHours || undefined, cost: logForm.cost || undefined, serviceDate: logForm.serviceDate ? new Date(logForm.serviceDate).toISOString() : undefined });
            }} disabled={createLog.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Notices Tab ──────────────────────────────────────────────────────────────

function NoticesTab({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', noticeType: 'general' as NoticeType, area: '', isPinned: false, expiresAt: '' });

  const { data, isLoading } = useQuery<{ notices: CourseNotice[] }>({
    queryKey: [`/api/organizations/${orgId}/maintenance/notices`],
    queryFn: () => fetch(API(`/organizations/${orgId}/maintenance/notices`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const create = useMutation({
    mutationFn: (body: object) => fetch(API(`/organizations/${orgId}/maintenance/notices`), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/notices`] });
      toast({ title: 'Notice created' });
      setShowForm(false);
      setForm({ title: '', body: '', noticeType: 'general', area: '', isPinned: false, expiresAt: '' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const publish = useMutation({
    mutationFn: ({ id, pub }: { id: number; pub: boolean }) =>
      fetch(API(`/organizations/${orgId}/maintenance/notices/${id}/publish`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publish: pub }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/notices`] });
    },
  });

  const del = useMutation({
    mutationFn: (id: number) => fetch(API(`/organizations/${orgId}/maintenance/notices/${id}`), {
      method: 'DELETE', credentials: 'include',
    }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/maintenance/notices`] });
      toast({ title: 'Notice deleted' });
    },
  });

  const NOTICE_COLORS: Record<NoticeType, string> = {
    closure: 'bg-red-500/20 text-red-400', gur: 'bg-orange-500/20 text-orange-400',
    preferred_lies: 'bg-yellow-500/20 text-yellow-400', temporary_green: 'bg-amber-500/20 text-amber-400',
    hazard: 'bg-red-600/20 text-red-300', general: 'bg-blue-500/20 text-blue-400',
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {(data?.notices ?? []).filter(n => n.notice.isPublished).length} published notice{(data?.notices ?? []).filter(n => n.notice.isPublished).length !== 1 ? 's' : ''}
        </span>
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4 mr-1" /> New Notice
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-3">
          {(data?.notices ?? []).length === 0 ? (
            <Card><CardContent className="py-10 text-center text-muted-foreground">No notices yet</CardContent></Card>
          ) : (data?.notices ?? []).map(({ notice, createdByName }) => (
            <Card key={notice.id} className={`border-white/5 bg-card/50 ${notice.isPublished ? 'border-l-2 border-l-primary' : ''}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {notice.isPinned && <Pin className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                      <span className="font-medium text-white">{notice.title}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${NOTICE_COLORS[notice.noticeType]}`}>{NOTICE_TYPE_LABELS[notice.noticeType]}</span>
                      {notice.isPublished ? (
                        <Badge className="text-xs bg-primary/20 text-primary">Published</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">Draft</Badge>
                      )}
                    </div>
                    {notice.area && <p className="text-xs text-muted-foreground mt-0.5">{AREA_LABELS[notice.area]}</p>}
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{notice.body}</p>
                    <div className="flex flex-wrap gap-3 mt-2 text-xs text-muted-foreground">
                      {notice.expiresAt && <span className="flex items-center gap-1 text-amber-400"><Calendar className="w-3 h-3" /> Expires {fmtDate(notice.expiresAt)}</span>}
                      {createdByName && <span className="flex items-center gap-1"><User className="w-3 h-3" />{createdByName}</span>}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button variant="ghost" size="sm" title={notice.isPublished ? 'Unpublish' : 'Publish'}
                      onClick={() => publish.mutate({ id: notice.id, pub: !notice.isPublished })}>
                      {notice.isPublished ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" className="hover:text-red-400"
                      onClick={() => { if (confirm('Delete notice?')) del.mutate(notice.id); }}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Course Notice</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div><Label>Title *</Label><Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Hole 7 – GUR in effect" /></div>
            <div>
              <Label>Notice Type</Label>
              <Select value={form.noticeType} onValueChange={v => setForm(f => ({ ...f, noticeType: v as NoticeType }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.entries(NOTICE_TYPE_LABELS)).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Area</Label>
              <Select value={form.area || "_empty"} onValueChange={v => setForm(f => ({ ...f, area: v === "_empty" ? "" : v }))}>
                <SelectTrigger><SelectValue placeholder="All course" /></SelectTrigger>
                <SelectContent className="max-h-60">
                  <SelectItem value="_empty">All course</SelectItem>
                  {COURSE_AREAS.map(a => <SelectItem key={a} value={a}>{AREA_LABELS[a]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Body *</Label><Textarea rows={4} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} placeholder="Full notice text..." /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Expires (optional)</Label><Input type="datetime-local" value={form.expiresAt} onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} /></div>
              <div className="flex items-center gap-2 pt-6">
                <Switch checked={form.isPinned} onCheckedChange={v => setForm(f => ({ ...f, isPinned: v }))} id="pin-switch" />
                <Label htmlFor="pin-switch">Pin to top</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button onClick={() => {
              if (!form.title.trim() || !form.body.trim()) { toast({ title: 'Title and body required', variant: 'destructive' }); return; }
              create.mutate({ title: form.title, body: form.body, noticeType: form.noticeType, area: form.area || undefined, isPinned: form.isPinned, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined });
            }} disabled={create.isPending}>Create Notice</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CourseMaintenancePage() {
  const { activeOrgId } = useActiveOrgContext();
  const orgId = activeOrgId;

  if (!orgId) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-muted-foreground">Select an organization to view course maintenance</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Leaf className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">Course Maintenance</h1>
          <p className="text-sm text-muted-foreground">Greenkeeper logs, task management, equipment records, and course notices</p>
        </div>
      </motion.div>

      <Tabs defaultValue="conditions">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="conditions" className="flex items-center gap-1.5">
            <Leaf className="w-3.5 h-3.5" /><span className="hidden sm:inline">Conditions</span>
          </TabsTrigger>
          <TabsTrigger value="tasks" className="flex items-center gap-1.5">
            <ClipboardList className="w-3.5 h-3.5" /><span className="hidden sm:inline">Tasks</span>
          </TabsTrigger>
          <TabsTrigger value="equipment" className="flex items-center gap-1.5">
            <Tractor className="w-3.5 h-3.5" /><span className="hidden sm:inline">Equipment</span>
          </TabsTrigger>
          <TabsTrigger value="notices" className="flex items-center gap-1.5">
            <Flag className="w-3.5 h-3.5" /><span className="hidden sm:inline">Notices</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="conditions" className="mt-4">
          <ConditionsTab orgId={orgId} />
        </TabsContent>
        <TabsContent value="tasks" className="mt-4">
          <TasksTab orgId={orgId} />
        </TabsContent>
        <TabsContent value="equipment" className="mt-4">
          <EquipmentTab orgId={orgId} />
        </TabsContent>
        <TabsContent value="notices" className="mt-4">
          <NoticesTab orgId={orgId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
