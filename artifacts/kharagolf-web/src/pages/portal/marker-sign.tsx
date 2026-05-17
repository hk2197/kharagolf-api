import { useEffect, useState, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import {
  Loader2, ArrowLeft, CheckCircle2, XCircle, ClipboardList,
  ShieldCheck, AlertCircle, ChevronRight, Search, X, User, Trophy,
  Flag, Hash, MessageSquare, PenSquare, Wifi, WifiOff, Clock,
} from 'lucide-react';
import { KharaGolfWordmark } from '@/components/kharagolf-brand';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

interface ScorecardFlag {
  id: number;
  holeNumber: number;
  markerNote: string | null;
  playerResponse: string | null;
  resolvedAt: string | null;
  flaggedAt: string;
}

interface ScorecardCorrection {
  id: number;
  holeNumber: number;
  originalScore: number;
  requestedScore: number;
  reason: string | null;
  markerDecision: string | null;
  decidedAt: string | null;
}

interface Submission {
  submissionId: number;
  playerName: string;
  tournamentName: string;
  tournamentId: number;
  organizationId: number | null;
  scoringCloseTime: string | null;
  correctionWindowHours?: number | null;
  correctionDeadlineAt?: string | null;
  round: number;
  totalStrokes: number;
  markerCode: string | null;
  status: string;
  submittedAt: string | null;
  scores: { hole: number; strokes: number }[];
  flags: ScorecardFlag[];
  corrections: ScorecardCorrection[];
}

interface LiveHoleScore {
  holeNumber: number;
  strokes: number;
  at: string;
}

function timeAgo(dateStr: string | null) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function cellBg(toPar: number | null) {
  if (toPar === null) return 'bg-white/5';
  if (toPar <= -2) return 'bg-amber-500/30 border border-amber-400/50';
  if (toPar === -1) return 'bg-red-500/25 border border-red-400/40';
  if (toPar === 0) return 'bg-white/5';
  if (toPar === 1) return 'bg-blue-500/15 border border-blue-400/30';
  return 'bg-purple-500/20 border border-purple-400/35';
}

function DeadlineCountdown({
  scoringCloseTime,
  correctionDeadlineAt,
}: {
  scoringCloseTime: string | null;
  correctionDeadlineAt?: string | null;
}) {
  const [remaining, setRemaining] = useState<string | null>(null);
  const [isNear, setIsNear] = useState(false);
  const [label, setLabel] = useState('');

  useEffect(() => {
    // Prefer the absolute correction-window deadline over the daily scoring close time
    const hasAbsoluteDeadline = !!correctionDeadlineAt;

    if (!correctionDeadlineAt && !scoringCloseTime) return;

    const compute = () => {
      const now = new Date();
      let deadline: Date;

      if (hasAbsoluteDeadline) {
        deadline = new Date(correctionDeadlineAt!);
        setLabel('Marker review window closes in');
      } else {
        const [h, m] = scoringCloseTime!.split(':').map(Number);
        deadline = new Date();
        deadline.setHours(h, m, 0, 0);
        setLabel('Scoring closes in');
      }

      if (deadline <= now) {
        setRemaining('Deadline passed');
        setIsNear(true);
        return;
      }
      const diff = Math.floor((deadline.getTime() - now.getTime()) / 1000);
      const hours = Math.floor(diff / 3600);
      const mins = Math.floor((diff % 3600) / 60);
      const secs = diff % 60;
      setIsNear(diff < 30 * 60);
      if (hours > 0) {
        setRemaining(`${hours}h ${mins}m`);
      } else {
        setRemaining(`${mins}m ${secs.toString().padStart(2, '0')}s`);
      }
    };
    compute();
    const interval = setInterval(compute, 1000);
    return () => clearInterval(interval);
  }, [scoringCloseTime, correctionDeadlineAt]);

  if (!remaining) return null;
  const isPast = remaining === 'Deadline passed';
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold ${isPast ? 'bg-red-500/20 border border-red-500/40 text-red-300' : isNear ? 'bg-red-500/15 border border-red-500/30 text-red-400' : 'bg-amber-500/10 border border-amber-500/25 text-amber-400'}`}>
      <Clock className="w-3.5 h-3.5" />
      {isPast
        ? (correctionDeadlineAt ? 'Marker review window has closed' : 'Scoring deadline has passed')
        : `${label} ${remaining}`}
    </div>
  );
}

export default function MarkerSignPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [pending, setPending] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Submission | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [disputeNote, setDisputeNote] = useState('');
  const [holeDisputeNotes, setHoleDisputeNotes] = useState<Record<number, string>>({});
  const [acting, setActing] = useState(false);
  const [done, setDone] = useState<{ action: 'countersigned' | 'disputed'; name: string } | null>(null);

  const [decidingCorrection, setDecidingCorrection] = useState<number | null>(null);

  const [code, setCode] = useState('');
  const [codeLooking, setCodeLooking] = useState(false);
  const [codeError, setCodeError] = useState('');

  const [liveScores, setLiveScores] = useState<Record<number, LiveHoleScore>>({});
  const [sseConnected, setSseConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const loadPending = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/portal/pending-submissions', { credentials: 'include' });
      if (r.ok) setPending(await r.json());
    } catch { /* silent */ }
    finally { setLoading(false); }
  };

  useEffect(() => { loadPending(); }, []);

  const connectSSE = useCallback((tournamentId: number, organizationId: number | null) => {
    if (!organizationId) return;
    if (eventSourceRef.current) { eventSourceRef.current.close(); }
    const es = new EventSource(`/api/organizations/${organizationId}/tournaments/${tournamentId}/live`, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'hole_score_entered' && msg.data) {
          const d = msg.data as { holeNumber: number; strokes: number; occurredAt: string };
          setLiveScores(prev => ({ ...prev, [d.holeNumber]: { holeNumber: d.holeNumber, strokes: d.strokes, at: d.occurredAt } }));
        }
      } catch { /* noop */ }
    };
  }, []);

  useEffect(() => {
    if (selected) {
      const initial: Record<number, LiveHoleScore> = {};
      for (const s of selected.scores) initial[s.hole] = { holeNumber: s.hole, strokes: s.strokes, at: selected.submittedAt ?? '' };
      setLiveScores(initial);
      connectSSE(selected.tournamentId, selected.organizationId);
    } else {
      eventSourceRef.current?.close();
      setSseConnected(false);
      setLiveScores({});
    }
    return () => { eventSourceRef.current?.close(); };
  }, [selected, connectSSE]);

  const handleCounterSign = async () => {
    if (!selected) return;
    setActing(true);
    try {
      const r = await fetch(`/api/portal/submissions/${selected.submissionId}/countersign`, { method: 'POST', credentials: 'include' });
      if (!r.ok) { const e = await r.json(); toast({ title: e.error ?? 'Failed to counter-sign', variant: 'destructive' }); return; }
      setDone({ action: 'countersigned', name: selected.playerName });
      setSelected(null);
      setPending(p => p.filter(s => s.submissionId !== selected.submissionId));
    } catch {
      toast({ title: 'Network error', variant: 'destructive' });
    } finally {
      setActing(false);
    }
  };

  const handleDispute = async () => {
    if (!selected) return;
    setActing(true);
    try {
      const holeFlagEntries = Object.entries(holeDisputeNotes)
        .filter(([, note]) => note.trim())
        .map(([hole, markerNote]) => ({ holeNumber: parseInt(hole), markerNote: markerNote.trim() }));

      const r = await fetch(`/api/portal/submissions/${selected.submissionId}/dispute`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: disputeNote || 'Scores disputed by marker', holes: holeFlagEntries }),
      });
      if (!r.ok) { const e = await r.json(); toast({ title: e.error ?? 'Failed to dispute', variant: 'destructive' }); return; }
      setDone({ action: 'disputed', name: selected.playerName });
      setSelected(null);
      setDisputing(false);
      setDisputeNote('');
      setHoleDisputeNotes({});
      setPending(p => p.filter(s => s.submissionId !== selected.submissionId));
    } catch {
      toast({ title: 'Network error', variant: 'destructive' });
    } finally {
      setActing(false);
    }
  };

  const handleDecideCorrection = async (correctionId: number, decision: 'accepted' | 'rejected') => {
    if (!selected) return;
    setDecidingCorrection(correctionId);
    try {
      const r = await fetch(`/api/portal/submissions/${selected.submissionId}/corrections/${correctionId}/decide`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!r.ok) { const e = await r.json(); toast({ title: e.error ?? 'Failed', variant: 'destructive' }); return; }
      toast({ title: decision === 'accepted' ? 'Correction accepted' : 'Correction rejected' });
      loadPending();
      setSelected(p => p ? { ...p, corrections: p.corrections.map(c => c.id === correctionId ? { ...c, markerDecision: decision, decidedAt: new Date().toISOString() } : c) } : null);
    } catch {
      toast({ title: 'Network error', variant: 'destructive' });
    } finally {
      setDecidingCorrection(null);
    }
  };

  const toggleHoleDisputeNote = (hole: number) => {
    setHoleDisputeNotes(prev => {
      const wasSet = hole in prev;
      if (wasSet) {
        const next = { ...prev };
        delete next[hole];
        return next;
      }
      // Fire real-time flag-hole alert to the player when marker flags a hole
      if (selected?.submissionId) {
        fetch(`/api/portal/submissions/${selected.submissionId}/flag-hole`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ holeNumber: hole }),
        }).catch(() => {});
      }
      return { ...prev, [hole]: '' };
    });
  };

  const pendingCount = pending.filter(s => s.status === 'pending').length;
  const submittedCount = pending.filter(s => s.status === 'submitted').length;
  const totalCount = pending.length;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-white/10 bg-black/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center gap-3">
          <button onClick={() => navigate('/portal')} className="text-muted-foreground hover:text-white transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <img src="/logo.png" alt="KharaGolf" className="h-8 w-8 object-contain mr-2" />
          <KharaGolfWordmark className="text-lg" />
          <Badge className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30 border text-[10px] tracking-wider">MARKER SIGN</Badge>
          {selected && (
            <div className="ml-auto flex items-center gap-1.5 text-xs">
              {sseConnected
                ? <><Wifi className="w-3.5 h-3.5 text-green-400" /><span className="text-green-400">Live</span></>
                : <><WifiOff className="w-3.5 h-3.5 text-muted-foreground" /><span className="text-muted-foreground">Offline</span></>
              }
            </div>
          )}
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">

        {done && (
          <div className={`flex items-center gap-3 p-4 rounded-xl border ${done.action === 'countersigned' ? 'bg-green-500/10 border-green-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
            {done.action === 'countersigned'
              ? <ShieldCheck className="w-5 h-5 text-green-400 shrink-0" />
              : <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />}
            <div className="flex-1">
              <p className={`font-semibold text-sm ${done.action === 'countersigned' ? 'text-green-300' : 'text-amber-300'}`}>
                {done.action === 'countersigned' ? 'Scorecard Counter-Signed' : 'Scorecard Disputed'}
              </p>
              <p className="text-xs text-muted-foreground">
                {done.name}'s round has been {done.action === 'countersigned' ? 'verified and countersigned' : 'disputed — the player will be notified'}.
              </p>
            </div>
            <button onClick={() => setDone(null)} className="text-muted-foreground hover:text-white"><X className="w-4 h-4" /></button>
          </div>
        )}

        {selected ? (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <button onClick={() => { setSelected(null); setDisputing(false); setDisputeNote(''); setHoleDisputeNotes({}); }} className="text-muted-foreground hover:text-white transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div>
                <h2 className="text-white font-display font-bold text-xl">
                  {disputing ? 'Dispute Scorecard' : 'Counter-Sign Scorecard'}
                </h2>
                <p className="text-muted-foreground text-sm">{selected.playerName} · {selected.tournamentName} · Round {selected.round}</p>
              </div>
            </div>

            {(selected.correctionDeadlineAt || selected.scoringCloseTime) && (
              <DeadlineCountdown
                scoringCloseTime={selected.scoringCloseTime}
                correctionDeadlineAt={selected.correctionDeadlineAt}
              />
            )}

            {selected.status === 'submitted' && !disputing && (
              <div className="flex items-start gap-3 p-4 rounded-xl bg-green-500/10 border border-green-500/25">
                <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-green-300">Player has signed their card</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Review the scorecard below, then countersign or dispute.</p>
                </div>
              </div>
            )}

            <Card className="glass-panel border-white/10 p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center">
                  <User className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-white font-semibold">{selected.playerName}</p>
                  <p className="text-xs text-muted-foreground">{selected.tournamentName} · Round {selected.round}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-white font-display">{selected.totalStrokes}</p>
                <p className="text-xs text-muted-foreground">total strokes</p>
              </div>
            </Card>

            {selected.scores.length > 0 && (
              <Card className="glass-panel border-white/10 overflow-hidden">
                <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                  <h3 className="text-white font-semibold text-sm flex items-center gap-2">
                    <Flag className="w-4 h-4 text-primary" /> Hole-by-Hole Scores
                  </h3>
                  {sseConnected && <span className="text-xs text-green-400 flex items-center gap-1"><Wifi className="w-3 h-3" /> Live updates</span>}
                </div>
                <div className="divide-y divide-white/[0.03]">
                  {selected.scores.map(s => {
                    const displayStrokes = liveScores[s.hole]?.strokes ?? s.strokes;
                    const isLive = liveScores[s.hole] && liveScores[s.hole].at !== (selected.submittedAt ?? '');
                    const hasFlag = s.hole in holeDisputeNotes;
                    const existingFlag = selected.flags.find(f => f.holeNumber === s.hole);
                    const pendingCorrection = selected.corrections.find(c => c.holeNumber === s.hole && !c.markerDecision);

                    return (
                      <div key={s.hole} className={`px-4 py-2.5 transition-colors ${hasFlag || existingFlag ? 'bg-amber-500/5' : ''}`}>
                        <div className="flex items-center gap-3">
                          <span className="w-7 h-7 rounded-full bg-white/5 inline-flex items-center justify-center text-xs font-bold text-white shrink-0">{s.hole}</span>
                          <div className="flex-1 flex items-center gap-2">
                            <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold text-white ${cellBg(null)}`}>{displayStrokes}</span>
                            {isLive && <span className="text-[10px] text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded">live</span>}
                            {existingFlag && (
                              <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">flagged</span>
                            )}
                            {pendingCorrection && (
                              <span className="text-[10px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded">correction pending</span>
                            )}
                          </div>
                          {disputing && (
                            <button
                              onClick={() => toggleHoleDisputeNote(s.hole)}
                              className={`p-1.5 rounded-lg transition-colors text-xs ${hasFlag ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30' : 'bg-white/5 text-muted-foreground hover:text-white hover:bg-white/10'}`}
                              title="Flag this hole"
                            >
                              <AlertCircle className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        {disputing && hasFlag && (
                          <div className="mt-2 ml-10 flex items-center gap-2">
                            <input
                              type="text"
                              value={holeDisputeNotes[s.hole] ?? ''}
                              onChange={e => setHoleDisputeNotes(prev => ({ ...prev, [s.hole]: e.target.value }))}
                              placeholder={`Note for hole ${s.hole}`}
                              className="flex-1 h-8 px-3 text-xs bg-black/30 border border-amber-500/30 rounded-lg text-white placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                            />
                          </div>
                        )}
                        {existingFlag && !disputing && (
                          <div className="mt-1 ml-10 text-xs text-amber-300 italic">{existingFlag.markerNote}</div>
                        )}
                        {pendingCorrection && !disputing && (
                          <div className="mt-2 ml-10 space-y-1">
                            <p className="text-xs text-blue-300">
                              Player requests: {pendingCorrection.originalScore} → {pendingCorrection.requestedScore}
                              {pendingCorrection.reason && ` · ${pendingCorrection.reason}`}
                            </p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleDecideCorrection(pendingCorrection.id, 'accepted')}
                                disabled={decidingCorrection === pendingCorrection.id}
                                className="px-3 py-1 rounded-lg bg-green-500/15 text-green-400 text-xs hover:bg-green-500/25 transition-colors disabled:opacity-50"
                              >
                                {decidingCorrection === pendingCorrection.id ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Accept'}
                              </button>
                              <button
                                onClick={() => handleDecideCorrection(pendingCorrection.id, 'rejected')}
                                disabled={decidingCorrection === pendingCorrection.id}
                                className="px-3 py-1 rounded-lg bg-red-500/15 text-red-400 text-xs hover:bg-red-500/25 transition-colors disabled:opacity-50"
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="px-4 py-3 bg-white/[0.03] flex items-center justify-between">
                    <span className="text-white text-sm font-semibold uppercase tracking-wider">Total</span>
                    <span className="text-primary text-base font-bold font-display">{selected.totalStrokes}</span>
                  </div>
                </div>
              </Card>
            )}

            {!disputing && (
              <div className="flex items-start gap-3 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20">
                <AlertCircle className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <p className="text-xs text-blue-300">
                  As marker, you are certifying these scores are correct as witnessed during play. Counter-signing is a formal WHS obligation. If any score is incorrect, raise a dispute and flag the specific holes.
                </p>
              </div>
            )}

            {disputing && (
              <div className="space-y-3">
                <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-300">
                    Tap the flag icon on any hole to add a specific note. The player and admin will be notified.
                  </p>
                </div>
                <label className="block text-sm font-medium text-white">Overall dispute reason <span className="text-muted-foreground font-normal">(required)</span></label>
                <textarea
                  value={disputeNote}
                  onChange={e => setDisputeNote(e.target.value)}
                  placeholder="e.g. Hole 7 score was 5, not 4 as entered"
                  className="w-full h-20 px-4 py-3 rounded-xl bg-black/30 border border-white/15 text-white placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 resize-none"
                />
              </div>
            )}

            <div className="flex gap-3">
              {disputing ? (
                <>
                  <Button onClick={() => { setDisputing(false); setDisputeNote(''); setHoleDisputeNotes({}); }} variant="outline" className="flex-1 border-white/20" disabled={acting}>
                    Cancel
                  </Button>
                  <Button onClick={handleDispute} className="flex-1 bg-amber-600 hover:bg-amber-700 text-white" disabled={acting || !disputeNote.trim()}>
                    {acting ? <Loader2 className="w-4 h-4 animate-spin" /> : <><AlertCircle className="w-4 h-4 mr-2" /> Confirm Dispute</>}
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={() => setDisputing(true)} variant="outline" className="flex-1 border-amber-500/30 text-amber-400 hover:text-amber-300 hover:border-amber-400/50" disabled={acting}>
                    <XCircle className="w-4 h-4 mr-2" /> Dispute Score
                  </Button>
                  <Button onClick={handleCounterSign} className="flex-1 bg-green-600 hover:bg-green-700 text-white" disabled={acting}>
                    {acting ? <Loader2 className="w-4 h-4 animate-spin" /> : <><ShieldCheck className="w-4 h-4 mr-2" /> Counter-Sign</>}
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-display font-bold text-white">Marker Signing</h1>
              <p className="text-muted-foreground text-sm mt-1">Counter-sign your playing partner's scorecard as their designated marker.</p>
            </div>

            <Card className="glass-panel border-white/10 p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Hash className="w-4 h-4 text-primary" />
                <h2 className="text-white font-semibold text-sm">Enter Player's Code</h2>
              </div>
              <p className="text-xs text-muted-foreground">Your playing partner was given a 6-digit code after submitting their scores. Enter it here to pull up their scorecard.</p>
              <div className="flex gap-3">
                <input
                  type="text"
                  maxLength={6}
                  value={code}
                  onChange={e => { setCode(e.target.value.replace(/\D/g, '')); setCodeError(''); }}
                  placeholder="123456"
                  className="flex-1 h-12 px-4 text-center text-xl font-mono tracking-[0.5em] bg-black/30 border border-white/15 rounded-xl text-white placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <Button
                  onClick={() => {
                    const trimmed = code.trim().replace(/\s/g, '');
                    if (trimmed.length !== 6) { setCodeError('Enter the full 6-digit code.'); return; }
                    setCodeError('');
                    setCodeLooking(true);
                    fetch(`/api/portal/submissions/by-code/${trimmed}`, { credentials: 'include' })
                      .then(r => r.ok ? r.json() : r.json().then((e: { error?: string }) => { throw new Error(e.error); }))
                      .then((sub: Submission) => setSelected({ ...sub, flags: sub.flags ?? [], corrections: sub.corrections ?? [], scoringCloseTime: sub.scoringCloseTime ?? null }))
                      .catch((e: Error) => setCodeError(e.message ?? 'Code not found or already validated.'))
                      .finally(() => setCodeLooking(false));
                  }}
                  disabled={codeLooking || code.length !== 6}
                  className="h-12 px-5 bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {codeLooking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                </Button>
              </div>
              {codeError && (
                <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> {codeError}</p>
              )}
            </Card>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-white font-semibold text-sm flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-primary" /> Awaiting Your Counter-Signature
                </h2>
                <button onClick={loadPending} className="text-xs text-muted-foreground hover:text-white flex items-center gap-1">
                  <span>{totalCount} card{totalCount !== 1 ? 's' : ''}</span>
                </button>
              </div>

              {loading ? (
                <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
              ) : pending.length === 0 ? (
                <Card className="glass-panel border-white/10 p-10 text-center">
                  <Trophy className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
                  <p className="text-muted-foreground text-sm">No pending scorecards to sign.</p>
                  <p className="text-xs text-muted-foreground mt-1">Scorecards appear here when a playing partner in your tournament submits their round for validation.</p>
                </Card>
              ) : (
                <div className="space-y-2">
                  {pending.map(sub => (
                    <button key={sub.submissionId} onClick={() => setSelected(sub)} className="w-full text-left">
                      <Card className={`glass-panel border-white/10 p-4 hover:border-primary/30 transition-all group ${sub.status === 'submitted' ? 'border-green-500/20' : ''}`}>
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                            <User className="w-5 h-5 text-muted-foreground" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-white font-semibold text-sm truncate">{sub.playerName}</p>
                            <p className="text-xs text-muted-foreground truncate">{sub.tournamentName} · Round {sub.round}</p>
                            {sub.status === 'submitted' && (
                              <p className="text-xs text-green-400 flex items-center gap-1 mt-0.5">
                                <CheckCircle2 className="w-3 h-3" /> Player has signed — awaiting your countersign
                              </p>
                            )}
                            {sub.corrections.length > 0 && sub.corrections.some(c => !c.markerDecision) && (
                              <p className="text-xs text-blue-400 flex items-center gap-1 mt-0.5">
                                <MessageSquare className="w-3 h-3" /> {sub.corrections.filter(c => !c.markerDecision).length} correction request(s)
                              </p>
                            )}
                            {sub.flags.length > 0 && (
                              <p className="text-xs text-amber-400 flex items-center gap-1 mt-0.5">
                                <AlertCircle className="w-3 h-3" /> {sub.flags.length} hole{sub.flags.length !== 1 ? 's' : ''} flagged
                              </p>
                            )}
                            {(sub.correctionDeadlineAt || sub.scoringCloseTime) && (
                              <DeadlineCountdown scoringCloseTime={sub.scoringCloseTime} correctionDeadlineAt={sub.correctionDeadlineAt} />
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-white font-bold text-lg font-display">{sub.totalStrokes}</p>
                            <p className="text-[10px] text-muted-foreground">{timeAgo(sub.submittedAt)}</p>
                            <Badge className={`mt-1 text-[10px] ${sub.status === 'submitted' ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-amber-500/15 text-amber-400 border-amber-500/30'} border`}>
                              {sub.status === 'submitted' ? 'Signed' : 'Pending'}
                            </Badge>
                          </div>
                        </div>
                      </Card>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
