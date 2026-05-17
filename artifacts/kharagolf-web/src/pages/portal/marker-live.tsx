import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'wouter';
import {
  Loader2, Wifi, WifiOff, Flag, User, Trophy, CheckCircle2, Clock,
  ShieldCheck, AlertTriangle, RefreshCw, MessageSquare,
} from 'lucide-react';
import { KharaGolfWordmark } from '@/components/kharagolf-brand';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

interface HolePar {
  holeNumber: number;
  par: number;
}

interface HoleScore {
  holeNumber: number;
  strokes: number;
}

interface PendingCorrection {
  id: number;
  holeNumber: number;
  requestedStrokes: number;
  reason: string | null;
  status: string;
  createdAt: string | null;
}

interface MarkerLiveData {
  submissionId: number;
  playerId: number;
  playerName: string;
  tournamentId: number;
  tournamentName: string;
  courseName: string | null;
  round: number;
  status: string;
  totalStrokes: number | null;
  holePars: HolePar[];
  scores: HoleScore[];
  corrections: PendingCorrection[];
  roundComplete: boolean;
  token: string;
}

function scoreToPar(strokes: number, par: number): number {
  return strokes - par;
}

function toParLabel(diff: number): string {
  if (diff === 0) return 'E';
  return diff > 0 ? `+${diff}` : `${diff}`;
}

function cellClass(diff: number | null): string {
  if (diff === null) return 'bg-white/5 text-muted-foreground';
  if (diff <= -2) return 'bg-amber-500/30 border border-amber-400/50 text-amber-200';
  if (diff === -1) return 'bg-red-500/25 border border-red-400/40 text-red-200';
  if (diff === 0) return 'bg-white/5 text-white';
  if (diff === 1) return 'bg-blue-500/15 border border-blue-400/30 text-blue-200';
  return 'bg-purple-500/20 border border-purple-400/35 text-purple-200';
}

export default function MarkerLivePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const { toast } = useToast();

  const [data, setData] = useState<MarkerLiveData | null>(null);
  const [scores, setScores] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [countersigning, setCountersigning] = useState(false);
  const [countersigned, setCountersigned] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      // Use the public /api/marker-live endpoint — no login required
      const r = await fetch(`/api/marker-live/${token}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setError(e.error ?? 'Unable to load this live view');
        return;
      }
      const json: MarkerLiveData = await r.json();
      setData(json);
      const scoreMap: Record<number, number> = {};
      for (const s of json.scores) scoreMap[s.holeNumber] = s.strokes;
      setScores(scoreMap);
    } catch {
      setError('Network error — please check your connection');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!token || !data) return;

    const es = new EventSource(`/api/marker-live/${token}/stream`);
    eventSourceRef.current = es;

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'hole_score_entered' && msg.data) {
          const d = msg.data as { holeNumber: number; strokes: number };
          setScores(prev => ({ ...prev, [d.holeNumber]: d.strokes }));
        }
        if (msg.type === 'score_snapshot' && Array.isArray(msg.data)) {
          const snap = msg.data as HoleScore[];
          setScores(prev => {
            const updated = { ...prev };
            for (const s of snap) updated[s.holeNumber] = s.strokes;
            return updated;
          });
        }
      } catch { /* noop */ }
    };

    return () => {
      es.close();
      setSseConnected(false);
    };
  }, [token, data]);

  const handleCountersign = async () => {
    if (!data) return;
    setCountersigning(true);
    try {
      // Public countersign endpoint — token is the credential
      const r = await fetch(`/api/marker-live/${token}/countersign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        toast({ title: e.error ?? 'Failed to countersign', variant: 'destructive' });
        return;
      }
      setCountersigned(true);
      eventSourceRef.current?.close();
      toast({ title: 'Scorecard counter-signed', description: `${data.playerName}'s round has been verified.` });
    } catch {
      toast({ title: 'Network error', variant: 'destructive' });
    } finally {
      setCountersigning(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground text-sm">Loading live scorecard…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto" />
          <h1 className="text-white font-bold text-xl">Link Unavailable</h1>
          <p className="text-muted-foreground text-sm">{error}</p>
          <p className="text-muted-foreground text-xs">Ask the player to share a new link if the round is still in progress.</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const holePars = data.holePars.length > 0
    ? data.holePars
    : Array.from({ length: 18 }, (_, i) => ({ holeNumber: i + 1, par: 4 }));

  const totalHoles = holePars.length;
  const scoredCount = Object.keys(scores).length;
  const allHolesScored = scoredCount >= totalHoles;

  const totalStrokes = Object.values(scores).reduce((s, v) => s + v, 0);
  // Par for scored holes only — prevents nonsensical values mid-round
  const totalPar = holePars.filter(h => scores[h.holeNumber] !== undefined).reduce((s, h) => s + h.par, 0);
  const totalToPar = scoredCount > 0 ? totalStrokes - totalPar : null;

  const isSubmitted = data.status === 'submitted';
  // Countersign requires: all holes scored + player has signed (status = submitted)
  const canCountersign = allHolesScored && isSubmitted && !countersigned;

  const pendingCorrections = (data.corrections ?? []).filter(c => c.status === 'pending');

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-white/10 bg-black/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <img src="/logo.png" alt="KharaGolf" className="h-8 w-8 object-contain" />
          <KharaGolfWordmark className="text-lg" />
          <Badge className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30 border text-[10px] tracking-wider ml-1">MARKER VIEW</Badge>
          <div className="ml-auto flex items-center gap-1.5 text-xs">
            {sseConnected
              ? <><Wifi className="w-3.5 h-3.5 text-green-400" /><span className="text-green-400">Live</span></>
              : <><WifiOff className="w-3.5 h-3.5 text-muted-foreground" /><span className="text-muted-foreground">Connecting…</span></>
            }
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">

        {countersigned && (
          <div className="flex items-center gap-3 p-4 rounded-xl bg-green-500/10 border border-green-500/30">
            <ShieldCheck className="w-5 h-5 text-green-400 shrink-0" />
            <div>
              <p className="text-green-300 font-semibold text-sm">Scorecard Counter-Signed</p>
              <p className="text-muted-foreground text-xs">{data.playerName}'s round has been formally verified.</p>
            </div>
          </div>
        )}

        {/* Player + Round info */}
        <Card className="glass-panel border-white/10 p-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center shrink-0">
              <User className="w-6 h-6 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-lg leading-tight truncate">{data.playerName}</p>
              <p className="text-muted-foreground text-sm truncate">{data.tournamentName}{data.courseName ? ` · ${data.courseName}` : ''} · Round {data.round}</p>
            </div>
            {scoredCount > 0 && (
              <div className="text-right shrink-0">
                <p className={`text-2xl font-bold font-display ${totalToPar !== null && totalToPar < 0 ? 'text-red-400' : totalToPar === 0 ? 'text-white' : 'text-blue-400'}`}>
                  {totalToPar !== null ? toParLabel(totalToPar) : '-'}
                </p>
                <p className="text-xs text-muted-foreground">{scoredCount}/{totalHoles} holes</p>
              </div>
            )}
          </div>
        </Card>

        {/* Status banner */}
        {!countersigned && (
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${
            allHolesScored && isSubmitted
              ? 'bg-green-500/10 border-green-500/25 text-green-300'
              : allHolesScored
              ? 'bg-amber-500/10 border-amber-500/25 text-amber-300'
              : scoredCount === 0
              ? 'bg-white/5 border-white/10 text-muted-foreground'
              : 'bg-primary/10 border-primary/25 text-primary'
          }`}>
            {allHolesScored && isSubmitted
              ? <><CheckCircle2 className="w-4 h-4 shrink-0" /> Player has signed the scorecard — ready to countersign</>
              : allHolesScored
              ? <><Trophy className="w-4 h-4 shrink-0" /> Round complete — waiting for player to sign</>
              : scoredCount === 0
              ? <><Clock className="w-4 h-4 shrink-0" /> Waiting for scores to appear…</>
              : <><Flag className="w-4 h-4 shrink-0" /> Round in progress — {scoredCount} of {totalHoles} holes scored</>
            }
          </div>
        )}

        {/* Pending corrections notice */}
        {pendingCorrections.length > 0 && !countersigned && (
          <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/25">
            <MessageSquare className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-amber-300 font-semibold text-sm mb-1.5">Pending Score Corrections</p>
              <ul className="space-y-1">
                {pendingCorrections.map(c => (
                  <li key={c.id} className="text-xs text-amber-200/80">
                    Hole {c.holeNumber}: player requested <span className="font-bold text-amber-200">{c.requestedStrokes} strokes</span>
                    {c.reason ? ` — "${c.reason}"` : ''}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-amber-200/60 mt-2">
                These corrections must be resolved by the administrator before the round is finalised.
              </p>
            </div>
          </div>
        )}

        {/* Hole-by-hole scorecard */}
        <Card className="glass-panel border-white/10 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
            <h3 className="text-white font-semibold text-sm flex items-center gap-2">
              <Flag className="w-4 h-4 text-primary" /> Hole-by-Hole Scores
            </h3>
            {sseConnected && scoredCount > 0 && (
              <span className="text-xs text-green-400 flex items-center gap-1">
                <Wifi className="w-3 h-3" /> Updating live
              </span>
            )}
          </div>

          <div className="divide-y divide-white/[0.04]">
            {holePars.map(h => {
              const s = scores[h.holeNumber];
              const diff = s !== undefined ? scoreToPar(s, h.par) : null;
              const hasPendingCorrection = pendingCorrections.some(c => c.holeNumber === h.holeNumber);
              return (
                <div key={h.holeNumber} className={`flex items-center px-4 py-2.5 gap-3 ${hasPendingCorrection ? 'bg-amber-500/5' : ''}`}>
                  <span className="w-7 h-7 rounded-full bg-white/5 inline-flex items-center justify-center text-xs font-bold text-white shrink-0">
                    {h.holeNumber}
                  </span>
                  <div className="flex-1 flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">Par {h.par}</span>
                    {hasPendingCorrection && (
                      <span className="text-[10px] text-amber-400 font-medium">correction pending</span>
                    )}
                  </div>
                  <div className={`w-9 h-9 rounded-full inline-flex items-center justify-center text-sm font-bold ${cellClass(diff)}`}>
                    {s !== undefined ? s : <span className="text-muted-foreground/40">—</span>}
                  </div>
                  {diff !== null && (
                    <span className={`text-xs w-8 text-right ${diff < 0 ? 'text-red-400' : diff === 0 ? 'text-muted-foreground' : 'text-blue-400'}`}>
                      {toParLabel(diff)}
                    </span>
                  )}
                </div>
              );
            })}

            {scoredCount > 0 && (
              <div className="px-4 py-3 bg-white/[0.03] flex items-center justify-between">
                <div>
                  <span className="text-white text-sm font-semibold uppercase tracking-wider">Total</span>
                  {totalToPar !== null && (
                    <span className={`ml-2 text-xs font-semibold ${totalToPar < 0 ? 'text-red-400' : totalToPar === 0 ? 'text-muted-foreground' : 'text-blue-400'}`}>
                      {toParLabel(totalToPar)}
                    </span>
                  )}
                </div>
                <span className="text-primary text-lg font-bold font-display">{totalStrokes}</span>
              </div>
            )}
          </div>
        </Card>

        {/* Countersign button — only shown when all holes scored + player has signed */}
        {canCountersign && !countersigned && (
          <div className="space-y-3">
            <div className="flex items-start gap-3 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20">
              <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <p className="text-xs text-blue-300">
                As the marker, you are certifying that these scores are correct as witnessed during play. Counter-signing is a formal WHS obligation.
              </p>
            </div>
            <Button
              onClick={handleCountersign}
              disabled={countersigning}
              className="w-full bg-green-600 hover:bg-green-700 text-white"
            >
              {countersigning
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Countersigning…</>
                : <><ShieldCheck className="w-4 h-4 mr-2" /> Counter-Sign Scorecard</>
              }
            </Button>
          </div>
        )}

        {/* Refresh button */}
        {!sseConnected && !countersigned && (
          <Button
            variant="outline"
            className="w-full border-white/20"
            onClick={() => { fetchData(); }}
          >
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh Scores
          </Button>
        )}

        <p className="text-center text-xs text-muted-foreground pb-4">
          Powered by KharaGolf · This link is private — only share with your designated marker
        </p>
      </div>
    </div>
  );
}
