import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import {
  Clock, AlertTriangle, CheckCircle2, ChevronUp, ChevronDown,
  Settings, BarChart3, Users, Flag, Bell, BellOff, RefreshCw,
  Timer, TrendingUp, TrendingDown, Minus, Save, MapPin, Plus
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PaceGroup {
  teeTimeId: number;
  teeTime: string;
  round: number;
  startingHole: number;
  players: Array<{ id: number; name: string }>;
  currentHole: number;
  actualElapsedMinutes: number;
  targetElapsedMinutes: number;
  deviationMinutes: number;
  paceStatus: 'on_pace' | 'warning' | 'critical';
  lastHoleCompletedAt: string | null;
}

interface PaceAlert {
  id: number;
  teeTimeId: number;
  round: number;
  alertType: 'warning' | 'critical';
  deviationMinutes: number;
  currentHole: number;
  acknowledgedAt: string | null;
  createdAt: string;
  teeTime: string | null;
  players: string[];
}

interface PaceSettings {
  warningThresholdMinutes: number;
  criticalThresholdMinutes: number;
}

interface PaceBoardData {
  groups: PaceGroup[];
  settings: { warningThreshold: number; criticalThreshold: number };
  updatedAt: string;
}

interface Tournament {
  id: number;
  name: string;
  status: string;
  rounds: number;
  courseId: number | null;
}

interface Course {
  id: number;
  name: string;
  holes: number;
}

interface HoleParTime {
  holeNumber: number;
  par: number;
  parMinutes: number;
  id: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMinutes(mins: number): string {
  const h = Math.floor(Math.abs(mins) / 60);
  const m = Math.abs(mins) % 60;
  const sign = mins < 0 ? '-' : '';
  if (h === 0) return `${sign}${m}m`;
  return `${sign}${h}h ${m}m`;
}

function PaceStatusBadge({ status }: { status: string }) {
  if (status === 'critical') {
    return <Badge className="bg-red-600 text-white animate-pulse">Significantly Behind</Badge>;
  }
  if (status === 'warning') {
    return <Badge className="bg-yellow-500 text-black">Behind</Badge>;
  }
  return <Badge className="bg-green-600 text-white">On Pace</Badge>;
}

function DeviationIndicator({ deviation }: { deviation: number }) {
  const abs = Math.abs(deviation);
  if (deviation > 5) {
    return (
      <span className="flex items-center gap-1 text-red-500 font-semibold">
        <TrendingUp size={14} /> +{abs}m
      </span>
    );
  }
  if (deviation > 0) {
    return (
      <span className="flex items-center gap-1 text-yellow-600 font-semibold">
        <TrendingUp size={14} /> +{abs}m
      </span>
    );
  }
  if (deviation < -2) {
    return (
      <span className="flex items-center gap-1 text-blue-500 font-semibold">
        <TrendingDown size={14} /> -{abs}m
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-green-600 font-semibold">
      <Minus size={14} /> On Pace
    </span>
  );
}

type SortKey = 'deviation' | 'currentHole' | 'teeTime';
type SortDir = 'asc' | 'desc';

// ─── Marshal Checkpoint Dialog ────────────────────────────────────────────────

interface CheckpointDialogProps {
  open: boolean;
  onClose: () => void;
  group: PaceGroup | null;
  orgId: number;
  tournamentId: number;
  round: number;
  onSuccess: () => void;
}

function CheckpointDialog({ open, onClose, group, orgId, tournamentId, round, onSuccess }: CheckpointDialogProps) {
  const { toast } = useToast();
  const [holeNumber, setHoleNumber] = useState<number>(group?.currentHole ?? 1);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (group) setHoleNumber(group.currentHole > 0 ? group.currentHole : 1);
    setNotes('');
  }, [group]);

  const handleSave = async () => {
    if (!group) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/checkpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teeTimeId: group.teeTimeId,
          round,
          holeNumber,
          source: 'marshal',
          notes: notes || undefined,
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      toast({ title: 'Checkpoint recorded', description: `Group at hole ${holeNumber}` });
      onSuccess();
      onClose();
    } catch {
      toast({ title: 'Failed to record checkpoint', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin size={18} /> Record Marshal Checkpoint
          </DialogTitle>
        </DialogHeader>
        {group && (
          <div className="space-y-4">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Group</div>
              <div className="font-medium">{group.players.map(p => p.name).join(', ')}</div>
              <div className="text-xs text-muted-foreground">
                Tee time: {new Date(group.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Current Hole</label>
              <Select value={holeNumber.toString()} onValueChange={v => setHoleNumber(parseInt(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 18 }, (_, i) => i + 1).map(h => (
                    <SelectItem key={h} value={h.toString()}>Hole {h}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Notes (optional)</label>
              <Input
                placeholder="e.g. group waiting on par 3 backup"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save size={14} className="mr-1" />
            {saving ? 'Saving...' : 'Record Checkpoint'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Course Map ───────────────────────────────────────────────────────────────

/**
 * Schematic course map: 18 holes arranged in two nines (rows), with groups
 * plotted at their current hole position using colour-coded status circles.
 */
function CourseMap({ groups }: { groups: PaceGroup[] }) {
  const HOLES = Array.from({ length: 18 }, (_, i) => i + 1);
  const FRONT_NINE = HOLES.slice(0, 9);
  const BACK_NINE = HOLES.slice(9, 18);

  const groupsByHole = new Map<number, PaceGroup[]>();
  for (const g of groups) {
    if (g.currentHole > 0) {
      const existing = groupsByHole.get(g.currentHole) ?? [];
      groupsByHole.set(g.currentHole, [...existing, g]);
    }
  }

  const statusColor = (status: string) => {
    if (status === 'critical') return '#dc2626';
    if (status === 'warning') return '#d97706';
    return '#16a34a';
  };

  const HoleCell = ({ hole }: { hole: number }) => {
    const holeGroups = groupsByHole.get(hole) ?? [];
    return (
      <div
        key={hole}
        className="flex flex-col items-center border rounded p-1 min-w-[52px] bg-muted/30 relative"
        title={holeGroups.map(g => `${g.players.map(p => p.name).join(', ')} (${g.paceStatus})`).join('\n')}
      >
        <div className="text-[10px] font-semibold text-muted-foreground">H{hole}</div>
        <div className="flex flex-wrap gap-0.5 justify-center mt-1 min-h-[20px]">
          {holeGroups.map(g => (
            <div
              key={g.teeTimeId}
              className="rounded-full border-2 border-white"
              style={{
                width: 14,
                height: 14,
                backgroundColor: statusColor(g.paceStatus),
                boxShadow: g.paceStatus === 'critical' ? '0 0 4px 1px #dc2626' : undefined,
              }}
              title={`${g.players.map(p => p.name).join(', ')} • ${g.paceStatus} • +${g.deviationMinutes}m`}
            />
          ))}
          {holeGroups.length === 0 && (
            <div className="w-3.5 h-3.5 rounded-full bg-muted/20 border border-muted" />
          )}
        </div>
      </div>
    );
  };

  const noGroupsOnCourse = groups.filter(g => g.currentHole > 0).length === 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <MapPin size={15} /> Live Course Map
          <span className="text-xs font-normal text-muted-foreground ml-1">— group positions and pace status</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {noGroupsOnCourse ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No groups on course yet — positions will appear as scores or checkpoints are recorded.
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-xs text-muted-foreground mb-1 font-medium">Front 9</div>
              <div className="flex gap-1.5 flex-wrap">
                {FRONT_NINE.map(h => <HoleCell key={h} hole={h} />)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1 font-medium">Back 9</div>
              <div className="flex gap-1.5 flex-wrap">
                {BACK_NINE.map(h => <HoleCell key={h} hole={h} />)}
              </div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full bg-green-600" /> On Pace</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full bg-yellow-500" /> Behind</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full bg-red-600" /> Critical</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function PaceOfPlayPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;

  const [selectedTournamentId, setSelectedTournamentId] = useState<number | null>(null);
  const [selectedRound, setSelectedRound] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>('deviation');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [liveData, setLiveData] = useState<PaceBoardData | null>(null);
  const [activeTab, setActiveTab] = useState('board');
  const [alertsMuted, setAlertsMuted] = useState(false);
  const [checkpointGroup, setCheckpointGroup] = useState<PaceGroup | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  const [warningThreshold, setWarningThreshold] = useState(10);
  const [criticalThreshold, setCriticalThreshold] = useState(20);
  const [savingSettings, setSavingSettings] = useState(false);

  const [parTimes, setParTimes] = useState<HoleParTime[]>([]);
  const [savingParTimes, setSavingParTimes] = useState(false);

  const { data: tournaments = [] } = useQuery<Tournament[]>({
    queryKey: [`/api/organizations/${orgId}/tournaments`],
    queryFn: () => fetch(`/api/organizations/${orgId}/tournaments`).then(r => r.json()),
    enabled: !!orgId,
  });

  const activeTournaments = tournaments.filter(t => ['active', 'upcoming'].includes(t.status));
  const selectedTournament = tournaments.find(t => t.id === selectedTournamentId);

  const { data: courses = [] } = useQuery<Course[]>({
    queryKey: [`/api/organizations/${orgId}/courses`],
    queryFn: () => fetch(`/api/organizations/${orgId}/courses`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: paceSettings, refetch: refetchSettings } = useQuery<PaceSettings>({
    queryKey: [`/api/organizations/${orgId}/tournaments/${selectedTournamentId}/pace-settings`],
    queryFn: () => fetch(`/api/organizations/${orgId}/tournaments/${selectedTournamentId}/pace-settings`)
      .then(r => r.json()),
    enabled: !!orgId && !!selectedTournamentId,
  });

  useEffect(() => {
    if (paceSettings) {
      setWarningThreshold(paceSettings.warningThresholdMinutes);
      setCriticalThreshold(paceSettings.criticalThresholdMinutes);
    }
  }, [paceSettings]);

  const { data: boardData, refetch: refetchBoard } = useQuery<PaceBoardData>({
    queryKey: [`/api/organizations/${orgId}/tournaments/${selectedTournamentId}/pace-board`, selectedRound],
    queryFn: () => fetch(`/api/organizations/${orgId}/tournaments/${selectedTournamentId}/pace-board?round=${selectedRound}`)
      .then(r => r.json()),
    enabled: !!orgId && !!selectedTournamentId,
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (boardData) setLiveData(boardData);
  }, [boardData]);

  useEffect(() => {
    if (!selectedTournamentId) return;

    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }

    const es = new EventSource(`/api/sse/pace/${selectedTournamentId}`);
    sseRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'pace_update') {
          setLiveData(msg.data);
          if (!alertsMuted) {
            const critical = msg.data.groups?.filter((g: PaceGroup) => g.paceStatus === 'critical');
            if (critical?.length > 0) {
              toast({
                title: '⚠️ Pace Alert',
                description: `${critical.length} group(s) significantly behind schedule`,
                variant: 'destructive',
              });
            }
          }
        }
      } catch {}
    };

    es.onerror = () => {};

    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [selectedTournamentId, alertsMuted]);

  const { data: alerts = [], refetch: refetchAlerts } = useQuery<PaceAlert[]>({
    queryKey: [`/api/organizations/${orgId}/tournaments/${selectedTournamentId}/pace-alerts`, selectedRound],
    queryFn: () => fetch(`/api/organizations/${orgId}/tournaments/${selectedTournamentId}/pace-alerts?round=${selectedRound}&unacknowledged=true`)
      .then(r => r.json()),
    enabled: !!orgId && !!selectedTournamentId,
    refetchInterval: 15000,
  });

  const courseId = selectedTournament?.courseId ?? (courses[0]?.id ?? null);

  const { data: holeParTimesData = [] } = useQuery<HoleParTime[]>({
    queryKey: [`/api/organizations/${orgId}/courses/${courseId}/hole-par-times`],
    queryFn: () => fetch(`/api/organizations/${orgId}/courses/${courseId}/hole-par-times`)
      .then(r => r.json()),
    enabled: !!orgId && !!courseId && activeTab === 'config',
  });

  useEffect(() => {
    if (holeParTimesData.length > 0) setParTimes(holeParTimesData);
  }, [holeParTimesData]);

  const { data: report } = useQuery({
    queryKey: [`/api/organizations/${orgId}/tournaments/${selectedTournamentId}/pace-report`, selectedRound],
    queryFn: () => fetch(`/api/organizations/${orgId}/tournaments/${selectedTournamentId}/pace-report?round=${selectedRound}`)
      .then(r => r.json()),
    enabled: !!orgId && !!selectedTournamentId && activeTab === 'report',
  });

  const displayGroups = (liveData?.groups ?? [])
    .filter(g => g.round === selectedRound || liveData?.groups?.every(gg => gg.round === selectedRound))
    .sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'deviation') cmp = a.deviationMinutes - b.deviationMinutes;
      else if (sortKey === 'currentHole') cmp = a.currentHole - b.currentHole;
      else if (sortKey === 'teeTime') cmp = new Date(a.teeTime).getTime() - new Date(b.teeTime).getTime();
      return sortDir === 'asc' ? cmp : -cmp;
    });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return null;
    return sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />;
  };

  const acknowledgeAlert = async (alertId: number) => {
    await fetch(`/api/organizations/${orgId}/tournaments/${selectedTournamentId}/pace-alerts/${alertId}/acknowledge`, {
      method: 'POST',
    });
    refetchAlerts();
    toast({ title: 'Alert acknowledged' });
  };

  const saveSettings = async () => {
    if (!orgId || !selectedTournamentId) return;
    if (criticalThreshold <= warningThreshold) {
      toast({ title: 'Critical threshold must be greater than warning threshold', variant: 'destructive' });
      return;
    }
    setSavingSettings(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${selectedTournamentId}/pace-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ warningThresholdMinutes: warningThreshold, criticalThresholdMinutes: criticalThreshold }),
      });
      if (!res.ok) throw new Error('Save failed');
      refetchSettings();
      toast({ title: 'Pace settings saved' });
    } catch {
      toast({ title: 'Save failed', variant: 'destructive' });
    } finally { setSavingSettings(false); }
  };

  const saveParTimes = async () => {
    if (!orgId || !courseId) return;
    setSavingParTimes(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/courses/${courseId}/hole-par-times`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parTimes: parTimes.map(pt => ({ holeNumber: pt.holeNumber, parMinutes: pt.parMinutes })) }),
      });
      if (!res.ok) throw new Error('Save failed');
      toast({ title: 'Par times saved' });
    } catch {
      toast({ title: 'Save failed', variant: 'destructive' });
    } finally { setSavingParTimes(false); }
  };

  const unacknowledgedCritical = alerts.filter(a => !a.acknowledgedAt && a.alertType === 'critical').length;
  const unacknowledgedWarning = alerts.filter(a => !a.acknowledgedAt && a.alertType === 'warning').length;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Timer className="text-primary" size={28} />
            Pace of Play
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Real-time group pace monitoring for marshals and management</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={alertsMuted ? 'outline' : 'default'}
            size="sm"
            onClick={() => setAlertsMuted(!alertsMuted)}
          >
            {alertsMuted ? <BellOff size={16} className="mr-1" /> : <Bell size={16} className="mr-1" />}
            {alertsMuted ? 'Alerts Muted' : 'Alerts On'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => { refetchBoard(); refetchAlerts(); }}>
            <RefreshCw size={14} className="mr-1" /> Refresh
          </Button>
        </div>
      </div>

      {/* Tournament + Round selector */}
      <div className="flex items-center gap-4">
        <div className="w-72">
          <Select
            value={selectedTournamentId?.toString() ?? ''}
            onValueChange={(v) => setSelectedTournamentId(parseInt(v))}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select tournament..." />
            </SelectTrigger>
            <SelectContent>
              {activeTournaments.map(t => (
                <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>
              ))}
              {activeTournaments.length === 0 && tournaments.slice(0, 10).map(t => (
                <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {selectedTournament && (
          <div className="w-32">
            <Select
              value={selectedRound.toString()}
              onValueChange={(v) => setSelectedRound(parseInt(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: selectedTournament.rounds ?? 1 }, (_, i) => i + 1).map(r => (
                  <SelectItem key={r} value={r.toString()}>Round {r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {liveData && (
          <span className="text-xs text-muted-foreground">
            Last updated: {new Date(liveData.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Summary cards */}
      {liveData && selectedTournamentId && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{displayGroups.length}</div>
              <div className="text-sm text-muted-foreground flex items-center gap-1">
                <Users size={14} /> Total Groups
              </div>
            </CardContent>
          </Card>
          <Card className="border-green-500/50">
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-green-600">
                {displayGroups.filter(g => g.paceStatus === 'on_pace').length}
              </div>
              <div className="text-sm text-muted-foreground flex items-center gap-1">
                <CheckCircle2 size={14} className="text-green-500" /> On Pace
              </div>
            </CardContent>
          </Card>
          <Card className={`border-yellow-500/50 ${unacknowledgedWarning > 0 ? 'ring-1 ring-yellow-400' : ''}`}>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-yellow-600">
                {displayGroups.filter(g => g.paceStatus === 'warning').length}
              </div>
              <div className="text-sm text-muted-foreground flex items-center gap-1">
                <AlertTriangle size={14} className="text-yellow-500" /> Behind
                {unacknowledgedWarning > 0 && (
                  <Badge variant="outline" className="ml-1 text-yellow-600 border-yellow-600">{unacknowledgedWarning}</Badge>
                )}
              </div>
            </CardContent>
          </Card>
          <Card className={`border-red-500/50 ${unacknowledgedCritical > 0 ? 'ring-2 ring-red-500 animate-pulse' : ''}`}>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-red-600">
                {displayGroups.filter(g => g.paceStatus === 'critical').length}
              </div>
              <div className="text-sm text-muted-foreground flex items-center gap-1">
                <AlertTriangle size={14} className="text-red-500" /> Critical
                {unacknowledgedCritical > 0 && (
                  <Badge variant="destructive" className="ml-1">{unacknowledgedCritical}</Badge>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="board">
            <Clock size={14} className="mr-1" /> Live Board
          </TabsTrigger>
          <TabsTrigger value="alerts">
            <Bell size={14} className="mr-1" /> Alerts
            {alerts.filter(a => !a.acknowledgedAt).length > 0 && (
              <Badge variant="destructive" className="ml-1">
                {alerts.filter(a => !a.acknowledgedAt).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="report">
            <BarChart3 size={14} className="mr-1" /> Post-Round Report
          </TabsTrigger>
          <TabsTrigger value="config">
            <Settings size={14} className="mr-1" /> Configuration
          </TabsTrigger>
        </TabsList>

        {/* Live board tab */}
        <TabsContent value="board" className="space-y-4">
          {!selectedTournamentId ? (
            <Card><CardContent className="pt-6 text-center text-muted-foreground">Select a tournament to view the pace board</CardContent></Card>
          ) : (
            <>
              <CourseMap groups={displayGroups} />
              {displayGroups.length === 0 ? (
                <Card><CardContent className="pt-6 text-center text-muted-foreground">
                  No tee times recorded yet for this round. Pace data will appear as scores are submitted or checkpoints are recorded.
                </CardContent></Card>
              ) : (
            <Card>
              <CardContent className="pt-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Players</TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('teeTime')}>
                        <span className="flex items-center gap-1">Tee Time <SortIcon k="teeTime" /></span>
                      </TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('currentHole')}>
                        <span className="flex items-center gap-1">Current Hole <SortIcon k="currentHole" /></span>
                      </TableHead>
                      <TableHead>Time on Course</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('deviation')}>
                        <span className="flex items-center gap-1">Deviation <SortIcon k="deviation" /></span>
                      </TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayGroups.map(group => (
                      <TableRow
                        key={group.teeTimeId}
                        className={
                          group.paceStatus === 'critical' ? 'bg-red-50 dark:bg-red-950/20' :
                          group.paceStatus === 'warning' ? 'bg-yellow-50 dark:bg-yellow-950/20' : ''
                        }
                      >
                        <TableCell>
                          <div className="space-y-0.5">
                            {group.players.map(p => (
                              <div key={p.id} className="text-sm font-medium">{p.name}</div>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {new Date(group.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          <div className="text-xs text-muted-foreground">Hole {group.startingHole}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-bold text-lg">
                            {group.currentHole === 0 ? '—' : group.currentHole}
                          </div>
                        </TableCell>
                        <TableCell>{formatMinutes(group.actualElapsedMinutes)}</TableCell>
                        <TableCell>{group.targetElapsedMinutes > 0 ? formatMinutes(group.targetElapsedMinutes) : '—'}</TableCell>
                        <TableCell>
                          <DeviationIndicator deviation={group.deviationMinutes} />
                        </TableCell>
                        <TableCell>
                          <PaceStatusBadge status={group.paceStatus} />
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setCheckpointGroup(group)}
                            title="Record marshal checkpoint"
                          >
                            <MapPin size={13} className="mr-1" /> Check-in
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
              )}
            </>
          )}
        </TabsContent>

        {/* Alerts tab */}
        <TabsContent value="alerts">
          {!selectedTournamentId ? (
            <Card><CardContent className="pt-6 text-center text-muted-foreground">Select a tournament to view alerts</CardContent></Card>
          ) : alerts.length === 0 ? (
            <Card><CardContent className="pt-6 text-center text-muted-foreground">
              <CheckCircle2 className="mx-auto mb-2 text-green-500" size={32} />
              No active alerts
            </CardContent></Card>
          ) : (
            <div className="space-y-3">
              {alerts.map(alert => (
                <Card key={alert.id} className={alert.alertType === 'critical' ? 'border-red-500' : 'border-yellow-500'}>
                  <CardContent className="pt-4 flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <AlertTriangle
                        size={20}
                        className={alert.alertType === 'critical' ? 'text-red-500 mt-0.5' : 'text-yellow-500 mt-0.5'}
                      />
                      <div>
                        <div className="font-semibold">
                          {alert.players.join(', ')}
                          <Badge
                            className={`ml-2 ${alert.alertType === 'critical' ? 'bg-red-600' : 'bg-yellow-500 text-black'}`}
                          >
                            {alert.alertType === 'critical' ? 'Critically Behind' : 'Behind Schedule'}
                          </Badge>
                        </div>
                        <div className="text-sm text-muted-foreground mt-0.5">
                          +{alert.deviationMinutes} min behind • Hole {alert.currentHole} •{' '}
                          {new Date(alert.createdAt).toLocaleTimeString()}
                          {alert.teeTime && ` • Tee time: ${new Date(alert.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                        </div>
                      </div>
                    </div>
                    {!alert.acknowledgedAt && (
                      <Button size="sm" variant="outline" onClick={() => acknowledgeAlert(alert.id)}>
                        Acknowledge
                      </Button>
                    )}
                    {alert.acknowledgedAt && (
                      <Badge variant="outline" className="text-green-600 border-green-600">
                        <CheckCircle2 size={12} className="mr-1" /> Acknowledged
                      </Badge>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Post-round report tab */}
        <TabsContent value="report">
          {!selectedTournamentId ? (
            <Card><CardContent className="pt-6 text-center text-muted-foreground">Select a tournament to view the report</CardContent></Card>
          ) : !report ? (
            <Card><CardContent className="pt-6 text-center text-muted-foreground">Loading report...</CardContent></Card>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <Card>
                  <CardContent className="pt-4">
                    <div className="text-2xl font-bold">{report.groupCount}</div>
                    <div className="text-sm text-muted-foreground">Groups Tracked</div>
                  </CardContent>
                </Card>
                {report.alertCounts?.map((ac: { alertType: string; count: number }) => (
                  <Card key={ac.alertType}>
                    <CardContent className="pt-4">
                      <div className={`text-2xl font-bold ${ac.alertType === 'critical' ? 'text-red-600' : 'text-yellow-600'}`}>
                        {ac.count}
                      </div>
                      <div className="text-sm text-muted-foreground capitalize">
                        {ac.alertType} Alerts
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {report.slowestGroups?.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Slowest Groups</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tee Time ID</TableHead>
                          <TableHead>Hole Reached</TableHead>
                          <TableHead>Deviation</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {report.slowestGroups.map((g: { teeTimeId: number; currentHole: number; deviationMinutes: number; paceStatus: string }) => (
                          <TableRow key={g.teeTimeId}>
                            <TableCell>Group {g.teeTimeId}</TableCell>
                            <TableCell>{g.currentHole}</TableCell>
                            <TableCell>
                              <DeviationIndicator deviation={g.deviationMinutes} />
                            </TableCell>
                            <TableCell><PaceStatusBadge status={g.paceStatus} /></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              {report.bottleneckHoles?.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Hole Completion Summary</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                      {report.bottleneckHoles.map((h: { holeNumber: number; playerCount: number; parMinutes: number; checkpoints: number }) => (
                        <div key={h.holeNumber} className="border rounded p-2 text-center">
                          <div className="text-xs text-muted-foreground">Hole {h.holeNumber}</div>
                          <div className="font-bold">{h.playerCount} players</div>
                          <div className="text-xs text-muted-foreground">Target: {h.parMinutes}m</div>
                          {h.checkpoints > 0 && (
                            <div className="text-xs text-blue-500">{h.checkpoints} check-ins</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </TabsContent>

        {/* Configuration tab */}
        <TabsContent value="config">
          <div className="space-y-6">
            {/* Alert Thresholds */}
            {selectedTournamentId && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <AlertTriangle size={16} /> Alert Thresholds
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium block mb-1">
                        Warning threshold (minutes behind)
                      </label>
                      <Input
                        type="number"
                        min={1}
                        value={warningThreshold}
                        onChange={e => setWarningThreshold(parseInt(e.target.value) || 1)}
                      />
                      <p className="text-xs text-muted-foreground mt-1">Group shows as "Behind" above this deviation</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium block mb-1">
                        Critical threshold (minutes behind)
                      </label>
                      <Input
                        type="number"
                        min={2}
                        value={criticalThreshold}
                        onChange={e => setCriticalThreshold(parseInt(e.target.value) || 2)}
                      />
                      <p className="text-xs text-muted-foreground mt-1">Group shows as "Significantly Behind" above this</p>
                    </div>
                  </div>
                  <Button onClick={saveSettings} disabled={savingSettings}>
                    <Save size={14} className="mr-1" />
                    {savingSettings ? 'Saving...' : 'Save Settings'}
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Par times per hole */}
            {courseId && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Flag size={16} /> Hole Par Times
                    <span className="text-xs font-normal text-muted-foreground">
                      — Configure target minutes per hole for{' '}
                      {courses.find(c => c.id === courseId)?.name ?? 'course'}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {parTimes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Select a tournament above to configure par times</p>
                  ) : (
                    <div className="space-y-4">
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                        {parTimes.map((pt, idx) => (
                          <div key={pt.holeNumber} className="border rounded p-2">
                            <div className="text-xs text-muted-foreground text-center mb-1">
                              Hole {pt.holeNumber} (Par {pt.par})
                            </div>
                            <Input
                              type="number"
                              min={5}
                              max={60}
                              className="text-center h-8"
                              value={pt.parMinutes}
                              onChange={e => {
                                const newPts = [...parTimes];
                                newPts[idx] = { ...newPts[idx], parMinutes: parseInt(e.target.value) || 14 };
                                setParTimes(newPts);
                              }}
                            />
                            <div className="text-xs text-center text-muted-foreground mt-1">min</div>
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button onClick={saveParTimes} disabled={savingParTimes}>
                          <Save size={14} className="mr-1" />
                          {savingParTimes ? 'Saving...' : 'Save Par Times'}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            const updated = parTimes.map(pt => ({ ...pt, parMinutes: pt.par === 3 ? 11 : pt.par === 5 ? 17 : 14 }));
                            setParTimes(updated);
                          }}
                        >
                          Reset to Defaults
                        </Button>
                        <span className="text-sm text-muted-foreground">
                          Total: {parTimes.reduce((s, pt) => s + pt.parMinutes, 0)} min
                          ({Math.floor(parTimes.reduce((s, pt) => s + pt.parMinutes, 0) / 60)}h{' '}
                          {parTimes.reduce((s, pt) => s + pt.parMinutes, 0) % 60}m per group)
                        </span>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Marshal Checkpoint Dialog */}
      {orgId && selectedTournamentId && (
        <CheckpointDialog
          open={!!checkpointGroup}
          onClose={() => setCheckpointGroup(null)}
          group={checkpointGroup}
          orgId={orgId}
          tournamentId={selectedTournamentId}
          round={selectedRound}
          onSuccess={() => { refetchBoard(); refetchAlerts(); }}
        />
      )}
    </div>
  );
}
