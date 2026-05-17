import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import {
  Play, CheckCircle2, Clock, AlertCircle, ChevronLeft, Plus, Activity,
  Users, BarChart2, RefreshCw, X, ChevronRight, Flag, Pencil, ShieldCheck,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const GOLD = '#C9A84C';

interface Round {
  round: {
    id: number;
    courseId: number;
    holesPlayed: number;
    status: string;
    grossScore: number | null;
    scoreDifferential: string | null;
    playedAt: string;
    submittedAt: string | null;
    confirmedAt: string | null;
  };
  courseName: string | null;
}

interface Course {
  id: number;
  name: string;
  rating: string | null;
  slope: number | null;
}

const STATUS_STYLE: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  draft:          { label: 'Draft', color: 'bg-white/10 text-white/50', icon: <Pencil className="w-3 h-3" /> },
  in_progress:    { label: 'In Progress', color: 'bg-blue-500/20 text-blue-300', icon: <Play className="w-3 h-3" /> },
  pending_marker: { label: 'Awaiting Marker', color: 'bg-amber-500/20 text-amber-300', icon: <Clock className="w-3 h-3" /> },
  confirmed:      { label: 'Confirmed', color: 'bg-emerald-500/20 text-emerald-300', icon: <CheckCircle2 className="w-3 h-3" /> },
  disputed:       { label: 'Disputed', color: 'bg-red-500/20 text-red-300', icon: <AlertCircle className="w-3 h-3" /> },
  unverified:     { label: 'Unverified', color: 'bg-orange-500/20 text-orange-300', icon: <AlertCircle className="w-3 h-3" /> },
};

interface AdminRound {
  round: {
    id: number;
    status: string;
    grossScore: number | null;
    scoreDifferential: string | null;
    playedAt: string;
    holesPlayed: number;
    notes: string | null;
  };
  courseName: string | null;
  userName: string | null;
  markerName: string | null;
  markerStatus: string | null;
  disputeNote: string | null;
}

export default function GeneralPlayPage() {
  const [, navigate] = useLocation();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin' || user?.role === 'tournament_director';
  const { toast } = useToast();

  const [rounds, setRounds] = useState<Round[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [pendingMarker, setPendingMarker] = useState<unknown[]>([]);
  const [adminRounds, setAdminRounds] = useState<AdminRound[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);

  const [newRound, setNewRound] = useState({
    courseId: '',
    holesPlayed: '18',
    playedAt: new Date().toISOString().split('T')[0],
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    loadData();
    if (isAdmin) loadAdminRounds();
  }, [orgId, isAdmin]);

  async function loadData() {
    setLoading(true);
    try {
      const [roundsRes, coursesRes, markerRes] = await Promise.all([
        fetch(`/api/portal/general-play?organizationId=${orgId}`, { credentials: 'include' }),
        fetch(`/api/organizations/${orgId}/courses`, { credentials: 'include' }),
        fetch('/api/portal/general-play/pending-marker', { credentials: 'include' }),
      ]);
      if (roundsRes.ok) setRounds(await roundsRes.json());
      if (coursesRes.ok) setCourses(await coursesRes.json());
      if (markerRes.ok) setPendingMarker(await markerRes.json());
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  async function loadAdminRounds() {
    setAdminLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/general-play`, { credentials: 'include' });
      if (res.ok) setAdminRounds(await res.json());
    } catch { /* ignore */ } finally { setAdminLoading(false); }
  }

  async function createRound() {
    if (!newRound.courseId) { toast({ title: 'Please select a course', variant: 'destructive' }); return; }
    setCreating(true);
    try {
      const res = await fetch('/api/portal/general-play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          courseId: parseInt(newRound.courseId),
          organizationId: orgId,
          holesPlayed: parseInt(newRound.holesPlayed),
          playedAt: new Date(newRound.playedAt).toISOString(),
        }),
      });
      if (!res.ok) { toast({ title: 'Failed to create round', variant: 'destructive' }); return; }
      const round = await res.json();
      toast({ title: 'Round created — start entering scores!' });
      setShowNew(false);
      navigate(`/general-play/${round.id}`);
    } finally { setCreating(false); }
  }

  async function confirmAsMarker(roundId: number) {
    const res = await fetch(`/api/portal/general-play/${roundId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      toast({ title: `Round confirmed! Differential: ${data.finalDifferential}` });
      loadData();
    } else {
      toast({ title: 'Failed to confirm round', variant: 'destructive' });
    }
  }

  const myRoundsContent = (
    <div className="space-y-4">
      {/* Pending marker actions */}
      {(pendingMarker as unknown[]).length > 0 && (
        <Card className="bg-amber-500/10 border-amber-500/30 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-amber-400" />
            <span className="font-semibold text-amber-300">{(pendingMarker as unknown[]).length} round{(pendingMarker as unknown[]).length > 1 ? 's' : ''} awaiting your countersign</span>
          </div>
          <div className="space-y-2">
            {(pendingMarker as { roundId: number; round: { userId: number; playedAt: string }; courseName: string | null }[]).map((m) => (
              <div key={m.roundId} className="flex items-center justify-between bg-black/20 rounded-lg p-3">
                <div>
                  <p className="text-sm font-medium text-white">{m.courseName ?? 'Course'}</p>
                  <p className="text-xs text-white/50">{new Date(m.round.playedAt).toLocaleDateString('en-IN')}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-red-500/40 text-red-400"
                    onClick={async () => {
                      const note = window.prompt('Reason for dispute:');
                      if (!note) return;
                      await fetch(`/api/portal/general-play/${m.roundId}/dispute`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ note }),
                      });
                      loadData();
                    }}
                  >
                    Dispute
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                    onClick={() => confirmAsMarker(m.roundId)}
                  >
                    Confirm
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Rounds List */}
      {loading ? (
        <div className="flex justify-center py-20">
          <RefreshCw className="w-8 h-8 text-white/30 animate-spin" />
        </div>
      ) : rounds.length === 0 ? (
        <Card className="bg-[#111827] border-[#1e2d3d] p-12 text-center">
          <Activity className="w-8 h-8 mx-auto mb-3 text-white/20" />
          <p className="text-white/40 mb-4">No general play rounds yet.</p>
          <Button style={{ background: GOLD, color: '#000' }} onClick={() => setShowNew(true)}>
            Post Your First Score
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {rounds.map(({ round, courseName }) => {
            const s = STATUS_STYLE[round.status] ?? STATUS_STYLE.draft;
            return (
              <Card
                key={round.id}
                className="bg-[#111827] border-[#1e2d3d] p-4 hover:border-white/20 transition-colors cursor-pointer"
                onClick={() => navigate(`/general-play/${round.id}`)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-white">{courseName ?? 'Unknown Course'}</span>
                      <Badge className={`text-xs flex items-center gap-1 ${s.color}`}>
                        {s.icon} {s.label}
                      </Badge>
                    </div>
                    <div className="text-xs text-white/40 flex items-center gap-3">
                      <span>{new Date(round.playedAt).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      <span>{round.holesPlayed} holes</span>
                      {round.grossScore && <span>Gross: {round.grossScore}</span>}
                    </div>
                  </div>
                  {round.scoreDifferential && (
                    <div className="text-right">
                      <p className="text-xs text-white/40">Differential</p>
                      <p className="text-xl font-bold" style={{ color: GOLD }}>
                        {Number(round.scoreDifferential).toFixed(1)}
                      </p>
                    </div>
                  )}
                </div>

                {round.status === 'in_progress' && (
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1 h-7 text-xs"
                      style={{ background: GOLD, color: '#000' }}
                      onClick={e => { e.stopPropagation(); navigate(`/general-play/${round.id}`); }}
                    >
                      Continue Scoring
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );

  async function adminFlagRound(roundId: number, flagged: boolean) {
    const adminNote = flagged ? window.prompt('Optional reason for flagging:') ?? '' : '';
    const res = await fetch(`/api/organizations/${orgId}/general-play/${roundId}/flag`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ flagged, adminNote: adminNote || undefined }),
    });
    if (res.ok) {
      toast({ title: flagged ? 'Round flagged as unverified' : 'Round unflagged' });
      loadAdminRounds();
    } else {
      toast({ title: 'Action failed', variant: 'destructive' });
    }
  }

  async function adminDeleteRound(roundId: number) {
    if (!window.confirm('Delete this round? This cannot be undone.')) return;
    const res = await fetch(`/api/organizations/${orgId}/general-play/${roundId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (res.ok) {
      toast({ title: 'Round removed' });
      loadAdminRounds();
    } else {
      const data = await res.json().catch(() => ({}));
      toast({ title: data.error ?? 'Failed to delete round', variant: 'destructive' });
    }
  }

  async function adminConfirmRound(roundId: number) {
    if (!window.confirm('Admin-confirm this round and post it to the handicap record?')) return;
    const res = await fetch(`/api/organizations/${orgId}/general-play/${roundId}/admin-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      toast({ title: `Round confirmed — Differential: ${data.finalDifferential}` });
      loadAdminRounds();
    } else {
      const data = await res.json().catch(() => ({}));
      toast({ title: data.error ?? 'Failed to confirm round', variant: 'destructive' });
    }
  }

  const adminRoundsContent = (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-white/50">All casual rounds posted in your club — last 100</p>
        <Button size="sm" variant="ghost" onClick={loadAdminRounds} className="text-white/50 hover:text-white">
          <RefreshCw className={`w-3.5 h-3.5 ${adminLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      {adminLoading ? (
        <div className="flex justify-center py-16"><RefreshCw className="w-6 h-6 text-white/30 animate-spin" /></div>
      ) : adminRounds.length === 0 ? (
        <Card className="bg-[#111827] border-[#1e2d3d] p-10 text-center">
          <Activity className="w-8 h-8 mx-auto mb-3 text-white/20" />
          <p className="text-white/40">No general play rounds posted yet.</p>
        </Card>
      ) : adminRounds.map(({ round, courseName, userName, markerName, disputeNote }) => {
        const s = STATUS_STYLE[round.status] ?? STATUS_STYLE.draft;
        const isUnverified = round.status === 'unverified';
        const isDisputed = round.status === 'disputed';
        const isPending = round.status === 'pending_marker';
        const isConfirmed = round.status === 'confirmed';
        return (
          <Card
            key={round.id}
            className={`bg-[#111827] border p-4 ${isUnverified ? 'border-orange-500/40 bg-orange-500/5' : isDisputed ? 'border-red-500/40 bg-red-500/5' : 'border-[#1e2d3d]'}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <span className="font-medium text-white text-sm truncate">{userName ?? 'Unknown Player'}</span>
                  <Badge className={`text-[10px] flex items-center gap-0.5 ${s.color} shrink-0`}>
                    {s.icon} {s.label}
                  </Badge>
                </div>
                <div className="text-xs text-white/40 flex items-center gap-2 flex-wrap">
                  <span>{courseName ?? '—'}</span>
                  <span>·</span>
                  <span>{round.holesPlayed}H</span>
                  <span>·</span>
                  <span>{new Date(round.playedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                  {round.grossScore != null && <><span>·</span><span>Gross {round.grossScore}</span></>}
                  {markerName && <><span>·</span><span className="text-white/50">Marker: {markerName}</span></>}
                </div>
                {disputeNote && (
                  <p className="mt-1 text-xs text-red-300/70 italic">Dispute: {disputeNote}</p>
                )}
                {isUnverified && round.notes && round.notes.startsWith('[Admin') && (
                  <p className="mt-1 text-xs text-orange-300/70 italic">{round.notes}</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                {round.scoreDifferential && (
                  <div className="text-right">
                    <p className="text-[10px] text-white/40">Diff</p>
                    <p className="text-lg font-bold" style={{ color: GOLD }}>{Number(round.scoreDifferential).toFixed(1)}</p>
                  </div>
                )}
                <div className="flex gap-1.5 flex-wrap justify-end">
                  {(isPending || isDisputed || isUnverified) && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 px-2"
                      onClick={() => adminConfirmRound(round.id)}
                    >
                      <ShieldCheck className="w-3 h-3 mr-0.5" /> Confirm
                    </Button>
                  )}
                  {isConfirmed && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] border-orange-500/40 text-orange-400 hover:bg-orange-500/10 px-2"
                      onClick={() => adminFlagRound(round.id, true)}
                    >
                      <Flag className="w-3 h-3 mr-0.5" /> Flag
                    </Button>
                  )}
                  {isUnverified && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] border-white/20 text-white/50 hover:bg-white/10 px-2"
                      onClick={() => adminFlagRound(round.id, false)}
                    >
                      Unflag
                    </Button>
                  )}
                  {!isConfirmed && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] border-red-500/30 text-red-400/70 hover:bg-red-500/10 px-2"
                      onClick={() => adminDeleteRound(round.id)}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-white">General Play</h1>
              <p className="text-white/50 text-sm">Casual rounds & score posting</p>
            </div>
          </div>
          <Button style={{ background: GOLD, color: '#000' }} onClick={() => setShowNew(true)}>
            <Plus className="w-4 h-4 mr-1" /> Post a Score
          </Button>
        </div>

        {isAdmin ? (
          <Tabs defaultValue="my-rounds">
            <TabsList className="bg-white/5 border border-white/10 mb-2">
              <TabsTrigger value="my-rounds" className="data-[state=active]:bg-white/10 data-[state=active]:text-white text-white/60 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> My Rounds
              </TabsTrigger>
              <TabsTrigger value="all-rounds" className="data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-300 text-white/60 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" /> All Club Rounds
              </TabsTrigger>
            </TabsList>
            <TabsContent value="my-rounds">{myRoundsContent}</TabsContent>
            <TabsContent value="all-rounds">{adminRoundsContent}</TabsContent>
          </Tabs>
        ) : myRoundsContent}
      </div>

      {/* New Round Dialog */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white">
          <DialogHeader>
            <DialogTitle>Post a Score</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label className="text-white/60 text-sm">Course *</Label>
              <select
                value={newRound.courseId}
                onChange={e => setNewRound(n => ({ ...n, courseId: e.target.value }))}
                className="mt-1 w-full bg-white/5 border border-white/20 text-white rounded-md px-3 py-2 text-sm"
              >
                <option value="">Select course...</option>
                {courses.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-white/60 text-sm">Holes Played</Label>
              <select
                value={newRound.holesPlayed}
                onChange={e => setNewRound(n => ({ ...n, holesPlayed: e.target.value }))}
                className="mt-1 w-full bg-white/5 border border-white/20 text-white rounded-md px-3 py-2 text-sm"
              >
                <option value="18">18 holes</option>
                <option value="9">9 holes</option>
              </select>
            </div>
            <div>
              <Label className="text-white/60 text-sm">Date Played</Label>
              <Input
                type="date"
                value={newRound.playedAt}
                onChange={e => setNewRound(n => ({ ...n, playedAt: e.target.value }))}
                max={new Date().toISOString().split('T')[0]}
                className="mt-1 bg-white/5 border-white/20 text-white"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button onClick={createRound} disabled={creating} style={{ background: GOLD, color: '#000' }}>
              {creating ? 'Creating...' : 'Start Round'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
