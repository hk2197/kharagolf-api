import { useEffect, useState, useCallback, useRef } from 'react';
import { useRoute, useLocation } from 'wouter';
import {
  Loader2, ArrowLeft, Trophy, Target, Share2, FileDown, Check, Copy,
  PenLine, Eye, Flag, ChevronLeft, ChevronRight, CheckCircle2, LayoutGrid, Keyboard,
  AlertCircle, ShieldCheck, XCircle, Clock, RefreshCw, MessageSquare, Send,
} from 'lucide-react';
import { KharaGolfWordmark } from '@/components/kharagolf-brand';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { ShotSourceBadges, type ShotSourceBreakdown } from '@/components/ShotSourceBadges';

interface ScoreRow {
  id: number; playerId: number; holeNumber: number; round: number; strokes: number;
  putts?: number | null; fairwayHit?: boolean | null; girHit?: boolean | null;
}
interface HolePar { holeNumber: number; par: number; handicap?: number | null }
interface ScorecardData {
  player: { id: number; firstName: string; lastName: string; handicapIndex: string | null; teeBox: string | null; currentRound: number };
  tournament: {
    name: string; format: string; rounds: number;
    status?: string; organizationId?: number;
    selfPosting?: boolean; allowSelfScoring?: boolean; markerValidation?: boolean;
  };
  scores: ScoreRow[];
}

type ViewMode = 'scorecard' | 'entry';
type InputMode = 'tap' | 'keyboard';
type ScoreMap = Map<string, number>;

function scoreKey(hole: number, round: number) { return `${hole}-${round}`; }

function cellBg(toPar: number | null) {
  if (toPar === null) return 'bg-white/5';
  if (toPar <= -2) return 'bg-amber-500/30 border border-amber-400/50';
  if (toPar === -1) return 'bg-red-500/25 border border-red-400/40';
  if (toPar === 0) return 'bg-white/5';
  if (toPar === 1) return 'bg-blue-500/15 border border-blue-400/30';
  return 'bg-purple-500/20 border border-purple-400/35';
}
function scoreLabel(toPar: number | null) {
  if (toPar === null) return '';
  if (toPar <= -2) return 'Eagle';
  if (toPar === -1) return 'Birdie';
  if (toPar === 0) return 'Par';
  if (toPar === 1) return 'Bogey';
  if (toPar === 2) return 'Double';
  return `+${toPar}`;
}

export default function PortalScoresPage() {
  const [, params] = useRoute('/portal/scores/:tournamentId');
  const [, navigate] = useLocation();
  const tournamentId = params?.tournamentId;
  const { toast } = useToast();

  const [data, setData] = useState<ScorecardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Entry mode state
  const [viewMode, setViewMode] = useState<ViewMode>('scorecard');
  const [holes, setHoles] = useState<HolePar[]>([]);
  const [scores, setScores] = useState<ScoreMap>(new Map());
  const [activeRound, setActiveRound] = useState(1);
  const [currentHole, setCurrentHole] = useState(1);
  const [inputMode, setInputMode] = useState<InputMode>('tap');
  const [saving, setSaving] = useState(false);
  const [entryPhase, setEntryPhase] = useState<'entry' | 'review' | 'done'>('entry');

  // Submission state (player's own round submission with marker code)
  interface ScorecardCorrection {
    id: number; holeNumber: number; originalScore: number; requestedScore: number;
    reason: string | null; markerDecision: string | null; decidedAt: string | null;
  }
  interface ScorecardFlag {
    id: number; holeNumber: number; markerNote: string | null;
    playerResponse: string | null; resolvedAt: string | null;
  }
  interface SubmissionStatus {
    submissionId: number; status: string; totalStrokes: number | null;
    submittedAt: string | null; reviewedAt: string | null;
    rejectionReason: string | null; markerCode: string | null;
    countersignedAt: string | null; disputeNote: string | null;
    committeeOverrideNote: string | null; committeeOverrideAt: string | null;
    deadlineAt: string | null;
    corrections: ScorecardCorrection[];
    flags: ScorecardFlag[];
  }
  const [submissionStatus, setSubmissionStatus] = useState<SubmissionStatus | null>(null);
  const [markerCode, setMarkerCode] = useState<string | null>(null);

  // Task #868 — per-round shot source breakdowns (Watch/Phone/Scorer/Manual %).
  // Mirrors the badges shown on the general-play round summary so tournament
  // participants can also see how reliable their tracking was.
  const [sourceBreakdowns, setSourceBreakdowns] = useState<Record<number, ShotSourceBreakdown>>({});

  // Correction request state
  const [correctionHole, setCorrectionHole] = useState<number | null>(null);
  const [correctionScore, setCorrectionScore] = useState<number>(0);
  const [correctionReason, setCorrectionReason] = useState('');
  const [sendingCorrection, setSendingCorrection] = useState(false);

  // Auto-poll interval ref for pending submissions
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSubmissionStatus = useCallback(async (tid: string, round: number) => {
    try {
      const r = await fetch(`/api/portal/my-submission-status/${tid}/${round}`, { credentials: 'include' });
      if (r.ok) {
        const s: SubmissionStatus = await r.json();
        setSubmissionStatus(s);
        if ((s.status === 'pending' || s.status === 'submitted') && s.markerCode) {
          setMarkerCode(s.markerCode);
          setEntryPhase('done');
        } else if (s.status === 'countersigned' || s.status === 'approved') {
          setEntryPhase('done');
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        } else if (s.status === 'disputed' || s.status === 'rejected') {
          setEntryPhase('done');
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        }
      }
    } catch { /* silent */ }
  }, []);

  // Auto-poll submission status every 15s when pending or submitted (awaiting marker)
  useEffect(() => {
    if (!tournamentId) return;
    if (submissionStatus?.status === 'pending' || submissionStatus?.status === 'submitted') {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => {
          loadSubmissionStatus(tournamentId, activeRound);
        }, 15000);
      }
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [tournamentId, submissionStatus?.status, activeRound, loadSubmissionStatus]);

  const handleRequestCorrection = useCallback(async () => {
    if (!submissionStatus || correctionHole === null || !correctionScore) return;
    setSendingCorrection(true);
    try {
      const r = await fetch(`/api/portal/submissions/${submissionStatus.submissionId}/corrections`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holeNumber: correctionHole, requestedScore: correctionScore, reason: correctionReason }),
      });
      if (r.ok) {
        toast({ title: 'Correction requested', description: 'Your marker will be notified to review.' });
        setCorrectionHole(null);
        setCorrectionScore(0);
        setCorrectionReason('');
        // Reload status to get updated corrections list
        if (tournamentId) loadSubmissionStatus(tournamentId, activeRound);
      } else {
        const e = await r.json();
        toast({ title: e.error ?? 'Failed to request correction', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Network error', variant: 'destructive' });
    } finally {
      setSendingCorrection(false);
    }
  }, [submissionStatus, correctionHole, correctionScore, correctionReason, tournamentId, activeRound, loadSubmissionStatus, toast]);

  useEffect(() => {
    if (!tournamentId) return;
    fetch(`/api/portal/my-scores/${tournamentId}`, { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error('Not found or not authorized'); return r.json(); })
      .then((d: ScorecardData) => {
        setData(d);
        // Pre-load existing scores into entry map
        const m = new Map<string, number>();
        for (const s of d.scores) m.set(scoreKey(s.holeNumber, s.round), s.strokes);
        setScores(m);
        if ((d.tournament.allowSelfScoring || d.tournament.selfPosting) && d.tournament.status === 'active') {
          setViewMode('entry');
        }
        // Load submission status
        loadSubmissionStatus(tournamentId, d.player.currentRound ?? 1);
        // Task #868 — fetch source breakdown for every round that has scores so
        // the player can see how their tracking was captured (watch/phone/etc).
        const roundsWithScores = Array.from(new Set(d.scores.map(s => s.round)));
        Promise.all(roundsWithScores.map(async r => {
          try {
            const res = await fetch(`/api/portal/rounds/${r}/source-breakdown?tournamentId=${tournamentId}`, { credentials: 'include' });
            if (!res.ok) return null;
            const b: ShotSourceBreakdown = await res.json();
            return [r, b] as const;
          } catch { return null; }
        })).then(results => {
          const next: Record<number, ShotSourceBreakdown> = {};
          for (const entry of results) if (entry) next[entry[0]] = entry[1];
          setSourceBreakdowns(next);
        });
      })
      .catch(e => setError(e.message ?? 'Failed to load scores'))
      .finally(() => setLoading(false));
  }, [tournamentId, loadSubmissionStatus]);

  useEffect(() => {
    if (!tournamentId) return;
    fetch(`/api/public/tournaments/${tournamentId}/holes`)
      .then(r => r.ok ? r.json() : { holes: [] })
      .then((d: { holes: HolePar[] }) => setHoles(d.holes))
      .catch(() => {});
  }, [tournamentId]);

  const getScore = useCallback((hole: number, round: number): number | null => {
    const v = scores.get(scoreKey(hole, round));
    return v !== undefined ? v : null;
  }, [scores]);

  const setScore = useCallback((hole: number, round: number, strokes: number) => {
    setScores(prev => new Map(prev).set(scoreKey(hole, round), strokes));
  }, []);

  const holePar = holes.find(h => h.holeNumber === currentHole)?.par ?? 4;
  const holeHandicap = holes.find(h => h.holeNumber === currentHole)?.handicap ?? currentHole;
  const totalHoles = holes.length || 18;

  const getRoundTotal = (round: number) => {
    let total = 0; let toPar = 0; let has = false;
    for (const h of holes) {
      const s = getScore(h.holeNumber, round);
      if (s !== null) { total += s; toPar += s - h.par; has = true; }
    }
    return has ? { total, toPar } : { total: null, toPar: null };
  };

  const allFilled = holes.every(h => getScore(h.holeNumber, activeRound) !== null);

  const saveHole = useCallback(async (hole: number) => {
    if (!data?.tournament.organizationId) return;
    const strokes = getScore(hole, activeRound);
    if (strokes === null || !data?.player.id) return;
    setSaving(true);
    try {
      await fetch(`/api/portal/watch/submit-score`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: Number(tournamentId),
          playerId: data.player.id,
          holeNumber: hole,
          strokes,
          round: activeRound,
        }),
      });
    } catch {
      toast({ title: 'Failed to save score', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [data, tournamentId, activeRound, getScore, toast]);

  const handleNextHole = async () => {
    await saveHole(currentHole);
    if (currentHole >= totalHoles) setEntryPhase('review');
    else setCurrentHole(h => h + 1);
  };

  const handleSubmitRound = async () => {
    if (!data) return;
    setSaving(true);
    try {
      // Step 1: Save all hole scores
      for (const h of holes) {
        const strokes = getScore(h.holeNumber, activeRound);
        if (strokes === null) continue;
        await fetch(`/api/portal/watch/submit-score`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tournamentId: Number(tournamentId),
            playerId: data.player.id,
            holeNumber: h.holeNumber,
            strokes,
            round: activeRound,
          }),
        });
      }

      if (data.tournament.markerValidation) {
        // Step 2a: Create a pending round_submission record (if not exists)
        let submissionId: number | null = submissionStatus?.submissionId ?? null;
        let code: string | null = submissionStatus?.markerCode ?? null;
        if (!submissionId) {
          const submitRes = await fetch(`/api/public/tournaments/${tournamentId}/players/${data.player.id}/submit`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ round: activeRound }),
          });
          if (submitRes.ok) {
            const submitData = await submitRes.json();
            submissionId = submitData.submissionId;
            code = submitData.markerCode ?? null;
          }
        }

        // Step 2b: Player formally signs (pending → submitted)
        if (submissionId) {
          const signRes = await fetch(`/api/portal/submissions/${submissionId}/sign`, {
            method: 'POST', credentials: 'include',
          });
          if (signRes.ok) {
            setMarkerCode(code);
            setSubmissionStatus(prev => prev ? { ...prev, status: 'submitted', markerCode: code } : {
              submissionId: submissionId!,
              status: 'submitted',
              totalStrokes: null,
              submittedAt: new Date().toISOString(),
              reviewedAt: null,
              rejectionReason: null,
              markerCode: code,
              countersignedAt: null,
              disputeNote: null,
              committeeOverrideNote: null,
              committeeOverrideAt: null,
              deadlineAt: null,
              corrections: [],
              flags: [],
            });
          }
        }
      }

      setEntryPhase('done');
      toast({ title: 'Card signed!', description: data.tournament.markerValidation ? 'Share the code with your marker to countersign.' : 'Your scores have been saved.' });
      const r = await fetch(`/api/portal/my-scores/${tournamentId}`, { credentials: 'include' });
      if (r.ok) { const d = await r.json(); setData(d); }
    } catch {
      toast({ title: 'Failed to submit round', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  async function handleShare() {
    if (!data) return;
    setSharing(true);
    try {
      const r = await fetch(`/api/portal/tournament-player/${data.player.id}/scorecard/share`, {
        method: 'POST', credentials: 'include',
      });
      if (!r.ok) throw new Error('Failed to generate share link');
      const { shareUrl: url } = await r.json();
      setShareUrl(url);
    } catch { alert('Could not generate share link. Please try again.'); }
    finally { setSharing(false); }
  }

  async function handleCopy() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <Target className="w-12 h-12 text-muted-foreground opacity-30" />
        <p className="text-muted-foreground">{error || 'Scorecard not found.'}</p>
        <Button variant="ghost" onClick={() => navigate('/portal')} className="gap-2 text-muted-foreground hover:text-white">
          <ArrowLeft className="w-4 h-4" /> Back to Portal
        </Button>
      </div>
    );
  }

  const canEnter = !!(data.tournament.allowSelfScoring || data.tournament.selfPosting) && data.tournament.status === 'active';
  const rounds = Array.from({ length: data.tournament.rounds || 1 }, (_, i) => i + 1);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-white/10 bg-black/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center gap-3">
          <button onClick={() => navigate('/portal')} className="text-muted-foreground hover:text-white transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <img src="/logo.png" alt="KharaGolf" className="h-8 w-8 object-contain mr-2" />
          <KharaGolfWordmark className="text-lg" />
          <Badge className="bg-primary/20 text-primary border-primary/30 border text-[10px] tracking-wider">PLAYER PORTAL</Badge>
          {canEnter && (
            <div className="ml-auto flex items-center gap-1 bg-white/5 rounded-lg p-1">
              <button
                onClick={() => setViewMode('entry')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${viewMode === 'entry' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-white'}`}
              >
                <PenLine className="w-3.5 h-3.5" /> Enter
              </button>
              <button
                onClick={() => setViewMode('scorecard')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${viewMode === 'scorecard' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-white'}`}
              >
                <Eye className="w-3.5 h-3.5" /> View
              </button>
            </div>
          )}
        </div>
      </header>

      {viewMode === 'entry' && canEnter ? (
        /* ── Score Entry Mode ── */
        <div className="flex flex-col min-h-[calc(100vh-57px)]">
          {/* Progress */}
          <div className="h-1 bg-white/5">
            <div className="h-full bg-primary transition-all" style={{ width: `${entryPhase === 'done' ? 100 : Math.min(((currentHole - 1) / totalHoles) * 100, 100)}%` }} />
          </div>

          {entryPhase === 'done' ? (
            <div className="flex flex-col flex-1 p-6 space-y-5 max-w-lg mx-auto w-full">
              {/* Status banner */}
              {submissionStatus?.status === 'countersigned' || submissionStatus?.status === 'approved' ? (
                <div className="flex flex-col items-center text-center py-6 space-y-3">
                  <div className="w-20 h-20 rounded-full bg-green-500/20 border-2 border-green-500/40 flex items-center justify-center">
                    <ShieldCheck className="w-10 h-10 text-green-400" />
                  </div>
                  <h2 className="font-display font-bold text-2xl text-green-400">Round Counter-Signed!</h2>
                  <p className="text-muted-foreground text-sm">Your round {activeRound} scorecard has been counter-signed by your marker{submissionStatus.countersignedAt ? ` on ${new Date(submissionStatus.countersignedAt).toLocaleDateString()}` : ''}.</p>
                  <Badge className="bg-green-500/15 text-green-400 border-green-500/30 border text-xs">Verified ✓</Badge>
                </div>
              ) : submissionStatus?.status === 'disputed' || submissionStatus?.status === 'rejected' ? (
                <div className="flex flex-col items-center text-center py-4 space-y-3">
                  <div className="w-16 h-16 rounded-full bg-amber-500/20 border-2 border-amber-500/40 flex items-center justify-center">
                    <AlertCircle className="w-8 h-8 text-amber-400" />
                  </div>
                  <h2 className="font-display font-bold text-xl text-amber-400">Scorecard Disputed</h2>
                  {(submissionStatus.disputeNote || submissionStatus.rejectionReason) && (
                    <div className="w-full px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-left">
                      <p className="text-xs text-amber-300"><span className="font-semibold">Marker note:</span> {submissionStatus.disputeNote ?? submissionStatus.rejectionReason}</p>
                    </div>
                  )}
                  {/* Marker flags on specific holes */}
                  {submissionStatus.flags.length > 0 && (
                    <div className="w-full space-y-2">
                      <p className="text-xs text-muted-foreground text-left font-semibold">Flagged holes:</p>
                      {submissionStatus.flags.map(f => (
                        <div key={f.id} className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20">
                          <div className="w-6 h-6 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0 mt-0.5">
                            <span className="text-xs font-bold text-amber-400">{f.holeNumber}</span>
                          </div>
                          <p className="text-xs text-amber-300">{f.markerNote ?? 'Hole flagged'}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : submissionStatus?.status === 'submitted' ? (
                <div className="flex flex-col items-center text-center py-6 space-y-3">
                  <div className="w-20 h-20 rounded-full bg-emerald-500/10 border-2 border-emerald-500/30 flex items-center justify-center">
                    <PenLine className="w-10 h-10 text-emerald-400" />
                  </div>
                  <h2 className="font-display font-bold text-2xl text-emerald-400">Card Signed!</h2>
                  <p className="text-muted-foreground text-sm">Your round {activeRound} scorecard is signed. Share the code below with your marker.</p>
                  <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 border text-xs">Awaiting Marker Countersign</Badge>
                </div>
              ) : (
                <div className="flex flex-col items-center text-center py-6 space-y-3">
                  <div className="w-20 h-20 rounded-full bg-primary/10 border-2 border-primary/30 flex items-center justify-center">
                    <Trophy className="w-10 h-10 text-primary" />
                  </div>
                  <h2 className="font-display font-bold text-2xl text-white">Scores Submitted!</h2>
                  <p className="text-muted-foreground text-sm">Your round {activeRound} scores have been saved.</p>
                </div>
              )}

              {/* Marker code — shown when submitted (player signed, awaiting countersign) or still pending */}
              {data.tournament.markerValidation && (submissionStatus?.status === 'submitted' || submissionStatus?.status === 'pending') && (markerCode || submissionStatus?.markerCode) && (
                <div className="px-6 py-5 rounded-2xl bg-amber-500/10 border border-amber-500/40 space-y-3">
                  <div className="flex items-center justify-center gap-2">
                    <Clock className="w-4 h-4 text-amber-400" />
                    <p className="text-amber-300 text-sm font-semibold">Awaiting Marker Counter-Signature</p>
                  </div>
                  <p className="text-xs text-amber-400/80 text-center">Show this code to your playing partner (marker) so they can verify your scorecard:</p>
                  <div className="flex items-center justify-center gap-2">
                    {(markerCode ?? submissionStatus?.markerCode ?? '').split('').map((digit, i) => (
                      <span key={i} className="w-10 h-12 rounded-xl bg-black/40 border-2 border-amber-500/50 flex items-center justify-center text-2xl font-bold font-mono text-amber-300">
                        {digit}
                      </span>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground text-center">Your marker must be registered in the same tournament and log in to the portal to counter-sign.</p>
                  <Button variant="ghost" size="sm" onClick={() => loadSubmissionStatus(tournamentId!, activeRound)} className="w-full text-xs text-amber-400 hover:text-amber-300 gap-1">
                    <RefreshCw className="w-3 h-3" /> Check status
                  </Button>
                </div>
              )}

              {/* No marker validation — simple done */}
              {!data.tournament.markerValidation && submissionStatus?.status !== 'rejected' && submissionStatus?.status !== 'disputed' && (
                <div className="flex items-start gap-3 p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                  <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                  <p className="text-sm text-green-300">Your scores are officially recorded.</p>
                </div>
              )}

              {/* Correction requests section (shown only in submitted = between Step 1 sign and Step 2 countersign) */}
              {submissionStatus?.status === 'submitted' && (
                <div className="space-y-3">
                  <h3 className="text-white font-semibold text-sm flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-primary" /> Request Score Corrections
                  </h3>
                  <p className="text-xs text-muted-foreground">If any hole score needs to be corrected before your marker countersigns, request it below. Your marker will be notified to review and accept or reject each correction.</p>

                  {/* Existing corrections list */}
                  {submissionStatus.corrections.length > 0 && (
                    <div className="space-y-2">
                      {submissionStatus.corrections.map(c => (
                        <div key={c.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${c.markerDecision === 'accepted' ? 'bg-green-500/10 border-green-500/20' : c.markerDecision === 'rejected' ? 'bg-red-500/10 border-red-500/20' : 'bg-blue-500/10 border-blue-500/20'}`}>
                          <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                            <span className="text-xs font-bold text-white">{c.holeNumber}</span>
                          </div>
                          <div className="flex-1">
                            <p className="text-xs text-white">{c.originalScore} → {c.requestedScore}</p>
                            {c.reason && <p className="text-[10px] text-muted-foreground">{c.reason}</p>}
                          </div>
                          <Badge className={`text-[10px] border ${c.markerDecision === 'accepted' ? 'bg-green-500/15 text-green-400 border-green-500/30' : c.markerDecision === 'rejected' ? 'bg-red-500/15 text-red-400 border-red-500/30' : 'bg-blue-500/15 text-blue-400 border-blue-500/30'}`}>
                            {c.markerDecision ?? 'Pending'}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* New correction form */}
                  {correctionHole !== null ? (
                    <Card className="glass-panel border-white/10 p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-white text-sm font-semibold">Correction Request — Hole {correctionHole}</h4>
                        <button onClick={() => { setCorrectionHole(null); setCorrectionScore(0); setCorrectionReason(''); }} className="text-muted-foreground hover:text-white"><XCircle className="w-4 h-4" /></button>
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="text-xs text-muted-foreground w-28 shrink-0">Correct score:</label>
                        <input
                          type="number" min={1} max={20} value={correctionScore || ''}
                          onChange={e => setCorrectionScore(parseInt(e.target.value) || 0)}
                          className="w-20 h-9 text-center text-sm font-bold bg-black/30 border border-white/20 rounded-lg text-white focus:outline-none focus:ring-1 focus:ring-primary/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                          placeholder="e.g. 5"
                        />
                      </div>
                      <input
                        type="text" value={correctionReason}
                        onChange={e => setCorrectionReason(e.target.value)}
                        placeholder="Reason (optional)"
                        className="w-full h-9 px-3 text-sm bg-black/30 border border-white/15 rounded-lg text-white placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                      />
                      <Button onClick={handleRequestCorrection} disabled={sendingCorrection || !correctionScore} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground h-9 text-sm gap-2">
                        {sendingCorrection ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Send className="w-3.5 h-3.5" /> Send Request</>}
                      </Button>
                    </Card>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {holes.slice(0, 18).map(h => {
                        const existing = submissionStatus.corrections.find(c => c.holeNumber === h.holeNumber);
                        return (
                          <button
                            key={h.holeNumber}
                            onClick={() => { setCorrectionHole(h.holeNumber); setCorrectionScore(getScore(h.holeNumber, activeRound) ?? h.par); }}
                            disabled={!!existing}
                            className={`h-9 rounded-lg text-xs font-semibold transition-all ${existing ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20 cursor-not-allowed' : 'bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-white border border-white/10'}`}
                          >
                            H{h.holeNumber}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Committee override notice */}
              {submissionStatus?.committeeOverrideNote && (
                <div className="flex items-start gap-3 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                  <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-300"><span className="font-semibold">Committee override:</span> {submissionStatus.committeeOverrideNote}</p>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                {submissionStatus?.status === 'disputed' || submissionStatus?.status === 'rejected' ? (
                  <>
                    <Button onClick={() => { setEntryPhase('entry'); setCurrentHole(1); setViewMode('scorecard'); }} variant="outline" className="flex-1 border-white/20 text-muted-foreground">
                      View Scorecard
                    </Button>
                    <Button onClick={() => navigate('/portal')} className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground">
                      Dashboard
                    </Button>
                  </>
                ) : (
                  <>
                    <Button onClick={() => { setEntryPhase('entry'); setCurrentHole(1); setViewMode('scorecard'); }} variant="outline" className="flex-1 border-white/20">
                      View Scorecard
                    </Button>
                    <Button onClick={() => navigate('/portal')} className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground">
                      Dashboard
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : entryPhase === 'review' ? (
            /* ── Review ── */
            <div className="max-w-2xl mx-auto w-full p-4 space-y-4">
              <div className="flex items-center gap-3">
                <button onClick={() => { setCurrentHole(totalHoles); setEntryPhase('entry'); }} className="text-muted-foreground hover:text-white transition-colors">
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div>
                  <h2 className="text-white font-display font-bold text-xl">Review Round {activeRound}</h2>
                  <p className="text-muted-foreground text-sm">Check before submitting</p>
                </div>
              </div>

              {/* Mini scorecard */}
              <Card className="glass-panel border-white/10 overflow-hidden">
                <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                  <span className="text-white font-semibold text-sm">{data.player.firstName} {data.player.lastName}</span>
                  {(() => { const { total, toPar } = getRoundTotal(activeRound); return total !== null ? (
                    <div className="flex items-center gap-2">
                      <span className="text-white font-bold">{total}</span>
                      <span className={`text-sm font-semibold ${toPar! < 0 ? 'text-green-400' : toPar! > 0 ? 'text-red-400' : 'text-muted-foreground'}`}>
                        {toPar === 0 ? 'E' : toPar! > 0 ? `+${toPar}` : toPar}
                      </span>
                    </div>
                  ) : null; })()}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/5">
                        {holes.map(h => (
                          <th key={h.holeNumber} className={`py-1.5 px-1 text-center text-muted-foreground font-medium ${h.holeNumber === 10 ? 'border-l border-white/10' : ''}`}>{h.holeNumber}</th>
                        ))}
                        <th className="py-1.5 px-2 text-center text-muted-foreground font-medium border-l border-white/5">TOT</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        {holes.map(h => {
                          const s = getScore(h.holeNumber, activeRound);
                          const tp = s !== null ? s - h.par : null;
                          return (
                            <td key={h.holeNumber} className={`py-2 px-1 text-center ${h.holeNumber === 10 ? 'border-l border-white/10' : ''}`}>
                              <span className={`inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold ${tp !== null ? cellBg(tp) : ''} text-white`}>
                                {s ?? '—'}
                              </span>
                            </td>
                          );
                        })}
                        {(() => { const { total } = getRoundTotal(activeRound); return (
                          <td className="py-2 px-2 text-center border-l border-white/5 font-bold text-white">{total ?? '—'}</td>
                        ); })()}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Card>

              {data.tournament.markerValidation ? (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/25 space-y-2">
                    <div className="flex items-start gap-2">
                      <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-emerald-300">WHS Player Declaration</p>
                        <p className="text-xs text-emerald-200/80 mt-1 leading-relaxed">
                          I certify that the scores entered above are correct as recorded hole-by-hole, and that I have complied with all Rules of Golf applicable to this round. I understand that signing this card makes it my official scorecard for handicap and competition purposes.
                        </p>
                      </div>
                    </div>
                  </div>
                  <Button
                    onClick={handleSubmitRound}
                    disabled={saving}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold h-14 rounded-xl text-base"
                  >
                    {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="flex items-center gap-2"><PenLine className="w-5 h-5" /> Sign & Submit Card</span>}
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">Your marker will countersign after reviewing your scores.</p>
                </div>
              ) : (
                <Button
                  onClick={handleSubmitRound}
                  disabled={saving}
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold h-14 rounded-xl text-base"
                >
                  {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="flex items-center gap-2"><CheckCircle2 className="w-5 h-5" /> Submit Round {activeRound}</span>}
                </Button>
              )}
            </div>
          ) : (
            /* ── Hole Entry ── */
            <>
              {/* Round selector + hole header */}
              <div className="bg-black/40 border-b border-white/5 px-4 py-4">
                <div className="max-w-2xl mx-auto">
                  {rounds.length > 1 && (
                    <div className="flex gap-1 mb-3">
                      {rounds.map(r => (
                        <button
                          key={r}
                          onClick={() => { setActiveRound(r); setCurrentHole(1); setEntryPhase('entry'); }}
                          className={`w-8 h-8 rounded-lg text-sm font-semibold transition-all ${activeRound === r ? 'bg-primary text-primary-foreground' : 'bg-white/5 text-muted-foreground hover:bg-white/10'}`}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Flag className="w-4 h-4 text-primary" />
                      <span className="font-display font-bold text-2xl text-white">Hole {currentHole}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-muted-foreground">Par <span className="text-white font-semibold">{holePar}</span></span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-sm text-muted-foreground">SI <span className="text-white font-semibold">{holeHandicap}</span></span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground text-sm">{currentHole}/{totalHoles}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Score entry */}
              <div className="flex-1 flex flex-col items-center justify-center p-6 max-w-sm mx-auto w-full">
                <div className="text-center mb-6">
                  <p className="text-muted-foreground text-sm mb-1">{data.player.firstName} {data.player.lastName}</p>
                  {data.player.handicapIndex && <p className="text-xs text-muted-foreground">HCP {data.player.handicapIndex}</p>}
                </div>

                {/* Mode toggle */}
                <div className="flex items-center gap-2 mb-6">
                  <button
                    onClick={() => setInputMode(m => m === 'tap' ? 'keyboard' : 'tap')}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white px-2 py-1 rounded hover:bg-white/5 transition-colors"
                  >
                    {inputMode === 'tap' ? <Keyboard className="w-3.5 h-3.5" /> : <LayoutGrid className="w-3.5 h-3.5" />}
                    {inputMode === 'tap' ? 'Keyboard mode' : 'Tap mode'}
                  </button>
                </div>

                {/* Score control */}
                {(() => {
                  const s = getScore(currentHole, activeRound);
                  const strokes = s ?? holePar;
                  const toPar = s !== null ? s - holePar : null;
                  return inputMode === 'tap' ? (
                    <div className="flex items-center justify-center gap-6">
                      <button
                        onClick={() => setScore(currentHole, activeRound, Math.max(1, strokes - 1))}
                        className="w-16 h-16 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 transition-all flex items-center justify-center text-white text-3xl font-bold select-none"
                      >−</button>
                      <div className={`w-24 h-24 rounded-2xl flex flex-col items-center justify-center transition-all ${cellBg(toPar)}`}>
                        <span className="text-white font-display font-bold text-4xl">{strokes}</span>
                        {toPar !== null && (
                          <span className={`text-xs font-semibold mt-0.5 ${toPar < 0 ? 'text-red-400' : toPar > 0 ? 'text-blue-400' : 'text-muted-foreground'}`}>
                            {scoreLabel(toPar)}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => setScore(currentHole, activeRound, Math.min(20, strokes + 1))}
                        className="w-16 h-16 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 transition-all flex items-center justify-center text-white text-3xl font-bold select-none"
                      >+</button>
                    </div>
                  ) : (
                    <input
                      type="number" min={1} max={20}
                      value={s ?? ''}
                      onChange={e => { const n = parseInt(e.target.value, 10); if (!isNaN(n) && n >= 1 && n <= 20) setScore(currentHole, activeRound, n); }}
                      onFocus={e => e.target.select()}
                      placeholder={String(holePar)}
                      className="w-28 h-20 text-center text-4xl font-bold bg-black/30 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-primary/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  );
                })()}

                {/* Running total */}
                {(() => { const { total, toPar } = getRoundTotal(activeRound); return total !== null ? (
                  <div className="mt-6 text-center">
                    <p className="text-xs text-muted-foreground">Round total through hole {currentHole - 1 + (getScore(currentHole, activeRound) !== null ? 1 : 0)}</p>
                    <p className="text-white font-semibold">{total} ({toPar === 0 ? 'E' : toPar! > 0 ? `+${toPar}` : toPar})</p>
                  </div>
                ) : null; })()}
              </div>

              {/* Navigation */}
              <div className="border-t border-white/5 bg-card/60 backdrop-blur-xl px-4 py-4 sticky bottom-0">
                <div className="max-w-sm mx-auto flex items-center gap-3">
                  <button
                    onClick={() => { if (currentHole > 1) setCurrentHole(h => h - 1); }}
                    disabled={currentHole === 1}
                    className="flex items-center gap-1.5 px-4 py-3 rounded-xl border border-white/10 bg-white/5 text-white hover:bg-white/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <Button
                    onClick={handleNextHole}
                    disabled={saving || getScore(currentHole, activeRound) === null}
                    className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold h-12 rounded-xl text-base"
                  >
                    {saving ? <Loader2 className="w-5 h-5 animate-spin" /> :
                      currentHole >= totalHoles ? (
                        <span className="flex items-center gap-2"><CheckCircle2 className="w-5 h-5" /> Review</span>
                      ) : (
                        <span className="flex items-center gap-2">Hole {currentHole + 1} <ChevronRight className="w-5 h-5" /></span>
                      )
                    }
                  </Button>
                </div>
                {getScore(currentHole, activeRound) === null && (
                  <p className="text-center text-xs text-muted-foreground mt-2">Tap +/- to set your score</p>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        /* ── Scorecard View ── */
        <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-display font-bold text-white">{data.tournament.name}</h1>
              <p className="text-muted-foreground text-sm mt-1">
                {data.player.firstName} {data.player.lastName}
                {data.player.handicapIndex && ` · HCP ${data.player.handicapIndex}`}
                {data.player.teeBox && ` · ${data.player.teeBox} tees`}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {data.scores.length > 0 && (
                <>
                  <Button size="sm" variant="outline" className="gap-2 border-white/20 hover:border-primary/50 text-muted-foreground hover:text-white" onClick={handleShare} disabled={sharing}>
                    {sharing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Share2 className="w-3.5 h-3.5" />}
                    Share
                  </Button>
                  <a
                    href={`/api/public/scorecard/${shareUrl ? shareUrl.split('/').pop() : ''}/pdf`}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border border-white/20 hover:border-primary/50 text-muted-foreground hover:text-white transition-colors ${!shareUrl ? 'pointer-events-none opacity-40' : ''}`}
                    download
                  >
                    <FileDown className="w-3.5 h-3.5" /> PDF
                  </a>
                </>
              )}
            </div>
          </div>

          {shareUrl && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-primary/5 border border-primary/20">
              <Share2 className="w-4 h-4 text-primary shrink-0" />
              <span className="text-xs text-muted-foreground truncate flex-1">{shareUrl}</span>
              <button onClick={handleCopy} className="shrink-0 text-muted-foreground hover:text-white transition-colors">
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          )}

          {data.scores.length === 0 ? (
            <Card className="glass-panel border-white/10 p-12 text-center">
              <Trophy className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
              <p className="text-muted-foreground">No scores recorded yet.</p>
              {canEnter && (
                <Button onClick={() => setViewMode('entry')} className="mt-4 bg-primary hover:bg-primary/90 text-primary-foreground gap-2">
                  <PenLine className="w-4 h-4" /> Enter Your Scores
                </Button>
              )}
            </Card>
          ) : (
            <div className="space-y-6">
              {rounds.map(round => {
                const roundScores = data.scores.filter(s => s.round === round);
                if (roundScores.length === 0) return null;
                const total = roundScores.reduce((sum, s) => sum + s.strokes, 0);
                const puttsTotal = roundScores.reduce((sum, s) => sum + (s.putts ?? 0), 0);
                const sortedScores = [...roundScores].sort((a, b) => a.holeNumber - b.holeNumber);
                return (
                  <Card key={round} className="glass-panel border-white/10 overflow-hidden">
                    <div className="p-4 border-b border-white/5 flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h2 className="font-semibold text-white">Round {round}</h2>
                        {/* Task #868 — Watch/Phone/Scorer/Manual % badges so
                            tournament players can see how their shots were
                            captured, just like the general-play summary. */}
                        <ShotSourceBadges breakdown={sourceBreakdowns[round] ?? null} className="" />
                      </div>
                      <div className="flex items-center gap-4">
                        {puttsTotal > 0 && <span className="text-xs text-muted-foreground">{puttsTotal} putts</span>}
                        <Badge className="bg-primary/20 text-primary border-primary/30 border text-sm font-bold px-3">{total} strokes</Badge>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-white/5 bg-black/20">
                            <th className="text-left px-4 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider">Hole</th>
                            <th className="text-center px-3 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider">Strokes</th>
                            {roundScores.some(s => s.putts != null) && <th className="text-center px-3 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider">Putts</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {sortedScores.map(s => (
                            <tr key={s.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                              <td className="px-4 py-2.5 font-medium text-white">
                                <span className="w-7 h-7 rounded-full bg-white/5 inline-flex items-center justify-center text-xs font-bold">{s.holeNumber}</span>
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold ${s.strokes <= 3 ? 'bg-yellow-500/20 text-yellow-300' : s.strokes >= 6 ? 'bg-red-500/20 text-red-400' : 'text-white'}`}>{s.strokes}</span>
                              </td>
                              {roundScores.some(sc => sc.putts != null) && <td className="px-3 py-2.5 text-center text-muted-foreground">{s.putts ?? '—'}</td>}
                            </tr>
                          ))}
                          <tr className="bg-white/[0.03] font-bold">
                            <td className="px-4 py-3 text-white text-sm uppercase tracking-wider">Total</td>
                            <td className="px-3 py-3 text-center text-primary text-base">{total}</td>
                            {roundScores.some(s => s.putts != null) && <td className="px-3 py-3 text-center text-muted-foreground">{puttsTotal || '—'}</td>}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          <div className="flex justify-center pt-4">
            <Button variant="ghost" onClick={() => navigate('/portal')} className="gap-2 text-muted-foreground hover:text-white">
              <ArrowLeft className="w-4 h-4" /> Back to Dashboard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
