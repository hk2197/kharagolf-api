import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Lock, Unlock, RotateCcw, Wifi, WifiOff, ChevronDown } from 'lucide-react';
import { LiveMessagePanel } from './live-message-panel';

interface HolePar { holeNumber: number; par: number; handicap?: number | null }
interface ScorerPlayer {
  id: number;
  playerName: string;
  handicapIndex: number;
  flights: string[];
  holeScores: { hole: number; strokes: number; par: number; toPar: number }[];
}

interface ScorerGridProps {
  orgId: number;
  tournamentId: number;
  round?: number;
  players: ScorerPlayer[];
  holeData: HolePar[];
  coursePar: number;
  onScoreSaved?: () => void;
  isAdmin?: boolean;
  currentUserName?: string;
}

type UndoEntry = { playerId: number; holeNumber: number; round: number; prevStrokes: number | null };

function cellColor(toPar: number | null): string {
  if (toPar === null) return '';
  if (toPar <= -2) return 'bg-amber-500/30 text-white border border-amber-500/50';
  if (toPar === -1) return 'bg-red-500/25 text-white border border-red-500/40';
  if (toPar === 0)  return 'text-white';
  if (toPar === 1)  return 'bg-blue-500/15 text-white border border-blue-500/30';
  return 'bg-purple-500/20 text-white border border-purple-500/35';
}

export function ScorerGrid({ orgId, tournamentId, round = 1, players, holeData, coursePar, onScoreSaved, isAdmin = false, currentUserName }: ScorerGridProps) {
  const { toast } = useToast();

  const holes = holeData.length > 0
    ? holeData
    : Array.from({ length: 18 }, (_, i) => ({ holeNumber: i + 1, par: 4 }));

  const allFlights = Array.from(new Set(players.flatMap(p => p.flights))).filter(Boolean);

  const [scores, setScores] = useState<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const p of players) {
      for (const hs of p.holeScores) {
        m.set(`${p.id}-${round}-${hs.hole}`, hs.strokes);
      }
    }
    return m;
  });

  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [locked, setLocked] = useState(false);
  const [flightFilter, setFlightFilter] = useState<string>('all');
  const [isConnected, setIsConnected] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const undoStack = useRef<UndoEntry[]>([]);
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  // Track which keys are "locally owned" (user has typed in them) to avoid SSE overwriting active edits
  const locallyEdited = useRef<Set<string>>(new Set());
  // Track keys explicitly cleared by the user (blank input) so blur can issue DELETE
  const pendingClears = useRef<Set<string>>(new Set());

  const filteredPlayers = flightFilter === 'all'
    ? players
    : players.filter(p => p.flights.includes(flightFilter));

  // Reset scores map when players or round changes (e.g. round selector changes)
  useEffect(() => {
    const m = new Map<string, number>();
    for (const p of players) {
      for (const hs of p.holeScores) {
        m.set(`${p.id}-${round}-${hs.hole}`, hs.strokes);
      }
    }
    setScores(m);
    locallyEdited.current.clear();
    pendingClears.current.clear();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round, players]);

  const getStrokes = (playerId: number, holeNumber: number): number | null => {
    const v = scores.get(`${playerId}-${round}-${holeNumber}`);
    return v !== undefined ? v : null;
  };

  const getTotal = (playerId: number): number | null => {
    let total = 0;
    let hasAny = false;
    for (const h of holes) {
      const s = getStrokes(playerId, h.holeNumber);
      if (s !== null) { total += s; hasAny = true; }
    }
    return hasAny ? total : null;
  };

  const getToPar = (playerId: number): number | null => {
    let toPar = 0;
    let hasAny = false;
    for (const h of holes) {
      const s = getStrokes(playerId, h.holeNumber);
      if (s !== null) { toPar += s - h.par; hasAny = true; }
    }
    return hasAny ? toPar : null;
  };

  const saveScore = useCallback(async (playerId: number, holeNumber: number, strokes: number) => {
    const key = `${playerId}-${round}-${holeNumber}`;
    setSaving(prev => new Set(prev).add(key));
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/scores`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, holeNumber, strokes, round }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaved(prev => {
        const next = new Set(prev).add(key);
        setTimeout(() => setSaved(s => { const c = new Set(s); c.delete(key); return c; }), 1500);
        return next;
      });
      onScoreSaved?.();
    } catch {
      toast({ title: 'Failed to save score', variant: 'destructive' });
    } finally {
      setSaving(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, [orgId, tournamentId, round, onScoreSaved, toast]);

  const handleChange = (playerId: number, holeNumber: number, raw: string) => {
    const key = `${playerId}-${round}-${holeNumber}`;
    const prev = scores.get(key) ?? null;
    const n = parseInt(raw, 10);
    if (!raw) {
      // Mark as pending clear; release local edit ownership so SSE can still send updates
      // while the user has the cell blanked — the DELETE fires on blur, not here
      setScores(m => { const c = new Map(m); c.delete(key); return c; });
      locallyEdited.current.delete(key);
      pendingClears.current.add(key);
      return;
    }
    // Non-empty: cancel any pending clear for this cell
    pendingClears.current.delete(key);
    if (isNaN(n) || n < 1 || n > 20) return;
    undoStack.current.push({ playerId, holeNumber, round, prevStrokes: prev });
    if (undoStack.current.length > 50) undoStack.current.shift();
    locallyEdited.current.add(key);
    setScores(m => new Map(m).set(key, n));
  };

  const handleBlur = (playerId: number, holeNumber: number) => {
    const key = `${playerId}-${round}-${holeNumber}`;
    const strokes = getStrokes(playerId, holeNumber);
    if (strokes !== null) {
      saveScore(playerId, holeNumber, strokes);
      locallyEdited.current.delete(key);
      pendingClears.current.delete(key);
    } else if (pendingClears.current.has(key)) {
      pendingClears.current.delete(key);
      clearScore(playerId, holeNumber);
    }
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    playerIdx: number,
    holeIdx: number, // index into full holes[] array
  ) => {
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      let nextPlayerIdx = playerIdx;
      let nextHoleIdx = holeIdx;

      if (e.key === 'Tab') {
        // Move to next hole; wrap to next player
        nextHoleIdx = holeIdx + 1;
        if (nextHoleIdx >= holes.length) { nextHoleIdx = 0; nextPlayerIdx = playerIdx + 1; }
      } else {
        // Enter: move to next player; wrap to next hole
        nextPlayerIdx = playerIdx + 1;
        if (nextPlayerIdx >= filteredPlayers.length) {
          nextPlayerIdx = 0;
          nextHoleIdx = holeIdx + 1;
        }
        if (nextHoleIdx >= holes.length) nextHoleIdx = 0;
      }
      if (nextPlayerIdx >= filteredPlayers.length) nextPlayerIdx = 0;

      const nextKey = `${filteredPlayers[nextPlayerIdx]?.id}-${round}-${holes[nextHoleIdx]?.holeNumber}`;
      const nextInput = inputRefs.current.get(nextKey);
      nextInput?.focus();
      nextInput?.select();
    }
  };

  const clearScore = useCallback(async (playerId: number, holeNumber: number) => {
    try {
      await fetch(
        `/api/organizations/${orgId}/tournaments/${tournamentId}/scores/${playerId}/${holeNumber}?round=${round}`,
        { method: 'DELETE', credentials: 'include' },
      );
      onScoreSaved?.();
    } catch {
      // best-effort — local state is already cleared
    }
  }, [orgId, tournamentId, round, onScoreSaved]);

  const handleUndo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    const { playerId, holeNumber, round: entryRound, prevStrokes } = entry;
    const key = `${playerId}-${entryRound}-${holeNumber}`;
    if (prevStrokes === null) {
      // Undo back to blank: clear locally AND persist delete to server
      setScores(m => { const c = new Map(m); c.delete(key); return c; });
      locallyEdited.current.delete(key);
      clearScore(playerId, holeNumber);
    } else {
      setScores(m => new Map(m).set(key, prevStrokes));
      locallyEdited.current.add(key);
      saveScore(playerId, holeNumber, prevStrokes);
    }
  }, [saveScore, clearScore]);

  useEffect(() => {
    const handleCtrlZ = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); handleUndo(); }
    };
    window.addEventListener('keydown', handleCtrlZ);
    return () => window.removeEventListener('keydown', handleCtrlZ);
  }, [handleUndo]);

  useEffect(() => {
    let sse: EventSource | null = null;
    let timer: number;
    const connect = () => {
      sse = new EventSource(`/api/sse/leaderboard/${tournamentId}`);
      sse.onopen = () => setIsConnected(true);
      sse.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'leaderboard_update') {
            setScores(prev => {
              const next = new Map(prev);
              for (const entry of (msg.data as Array<{
                id?: number; playerId?: number;
                holeScores?: Array<{ hole: number; strokes: number; round?: number }>;
              }>)) {
                const pid = entry.id ?? entry.playerId;
                if (pid == null) continue;
                for (const hs of (entry.holeScores ?? [])) {
                  // Only update cells that belong to the current round
                  const hsRound = hs.round ?? 1;
                  if (hsRound !== round) continue;
                  const k = `${pid}-${round}-${hs.hole}`;
                  if (!locallyEdited.current.has(k)) {
                    next.set(k, hs.strokes);
                  }
                }
              }
              return next;
            });
          }
        } catch { /* ignore */ }
      };
      sse.onerror = () => {
        setIsConnected(false);
        sse?.close();
        timer = window.setTimeout(connect, 3000);
      };
    };
    connect();
    return () => { sse?.close(); clearTimeout(timer); };
  }, [tournamentId]);

  const front9 = holes.filter(h => h.holeNumber <= 9);
  const back9 = holes.filter(h => h.holeNumber > 9);
  const hasBothNines = front9.length > 0 && back9.length > 0;

  // Render a single score input cell
  const renderInput = (player: ScorerPlayer, h: HolePar, playerIdx: number, holeArrayIdx: number) => {
    const key = `${player.id}-${round}-${h.holeNumber}`;
    const strokes = getStrokes(player.id, h.holeNumber);
    const tp = strokes !== null ? strokes - h.par : null;
    return (
      <td key={h.holeNumber} className="p-1 text-center hidden sm:table-cell">
        <div className={`relative rounded-md ${cellColor(tp)} ${saved.has(key) ? 'ring-1 ring-primary/60' : ''}`}>
          {saving.has(key) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-2.5 h-2.5 border border-primary/40 border-t-primary rounded-full animate-spin" />
            </div>
          )}
          <input
            ref={el => { if (el) inputRefs.current.set(`${player.id}-${round}-${h.holeNumber}`, el); else inputRefs.current.delete(`${player.id}-${round}-${h.holeNumber}`); }}
            type="number"
            min={1}
            max={20}
            value={strokes ?? ''}
            disabled={locked}
            onChange={e => handleChange(player.id, h.holeNumber, e.target.value)}
            onBlur={() => handleBlur(player.id, h.holeNumber)}
            onKeyDown={e => handleKeyDown(e, playerIdx, holeArrayIdx)}
            onFocus={e => e.target.select()}
            className="w-10 h-8 text-center text-sm font-bold bg-transparent focus:outline-none focus:ring-1 focus:ring-primary/50 rounded-md disabled:opacity-50 disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
        </div>
      </td>
    );
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          {allFlights.length > 0 && (
            <Select value={flightFilter} onValueChange={setFlightFilter}>
              <SelectTrigger className="bg-black/40 border-white/10 text-white w-40 h-8 text-sm">
                <SelectValue placeholder="All Players" />
              </SelectTrigger>
              <SelectContent className="bg-card border-white/10 text-white">
                <SelectItem value="all">All Players</SelectItem>
                {allFlights.map(f => <SelectItem key={f} value={f}>Flight {f}</SelectItem>)}
              </SelectContent>
            </Select>
          )}

          <button
            onClick={() => setLocked(l => !l)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
              locked
                ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20'
                : 'bg-white/5 border-white/10 text-white hover:bg-white/10'
            }`}
          >
            {locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
            {locked ? 'Locked' : 'Lock Scores'}
          </button>

          <button
            onClick={handleUndo}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-white/10 bg-white/5 text-white hover:bg-white/10 transition-all"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Undo
          </button>
        </div>

        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1.5 text-xs font-medium ${isConnected ? 'text-primary' : 'text-muted-foreground'}`}>
            {isConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {isConnected ? 'Live' : 'Offline'}
          </div>
        </div>
      </div>

      {/* Keyboard shortcut help */}
      <button
        onClick={() => setHelpOpen(h => !h)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white transition-colors"
      >
        <ChevronDown className={`w-3 h-3 transition-transform ${helpOpen ? 'rotate-180' : ''}`} />
        Keyboard shortcuts
      </button>
      {helpOpen && (
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground glass-panel rounded-xl p-4">
          <span><kbd className="bg-white/10 px-1.5 py-0.5 rounded text-white">Tab</kbd> → next hole</span>
          <span><kbd className="bg-white/10 px-1.5 py-0.5 rounded text-white">Enter</kbd> → next player</span>
          <span><kbd className="bg-white/10 px-1.5 py-0.5 rounded text-white">Ctrl+Z</kbd> → undo</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-amber-500/30 border border-amber-500/50" /> Eagle</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-red-500/25 border border-red-500/40" /> Birdie</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-blue-500/15 border border-blue-500/30" /> Bogey</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-purple-500/20 border border-purple-500/35" /> Double+</span>
        </div>
      )}

      {/* Grid */}
      <div className="overflow-x-auto rounded-xl border border-white/5 relative">
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
        <table className="w-full text-sm border-collapse min-w-[700px]">
          <thead>
            <tr className="bg-black/60 sticky top-0 z-10">
              <th className="sticky left-0 z-20 bg-[#0a100a] border-b border-r border-white/10 text-left px-4 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider min-w-[160px]">
                Player
              </th>
              {hasBothNines ? (
                <>
                  {front9.map(h => (
                    <th key={h.holeNumber} className="border-b border-white/10 text-center px-2 py-2 min-w-[44px] hidden sm:table-cell">
                      <div className="text-white font-bold text-xs">{h.holeNumber}</div>
                      <div className="text-[10px] text-primary">{h.par}</div>
                    </th>
                  ))}
                  <th className="border-b border-l border-white/10 text-center px-2 py-2 min-w-[48px]">
                    <div className="text-muted-foreground font-semibold text-xs">OUT</div>
                    <div className="text-[10px] text-primary">{front9.reduce((s, h) => s + h.par, 0)}</div>
                  </th>
                  {back9.map(h => (
                    <th key={h.holeNumber} className="border-b border-white/10 text-center px-2 py-2 min-w-[44px] hidden sm:table-cell">
                      <div className="text-white font-bold text-xs">{h.holeNumber}</div>
                      <div className="text-[10px] text-primary">{h.par}</div>
                    </th>
                  ))}
                  <th className="border-b border-l border-white/10 text-center px-2 py-2 min-w-[48px]">
                    <div className="text-muted-foreground font-semibold text-xs">IN</div>
                    <div className="text-[10px] text-primary">{back9.reduce((s, h) => s + h.par, 0)}</div>
                  </th>
                </>
              ) : (
                holes.map(h => (
                  <th key={h.holeNumber} className="border-b border-white/10 text-center px-2 py-2 min-w-[44px] hidden sm:table-cell">
                    <div className="text-white font-bold text-xs">{h.holeNumber}</div>
                    <div className="text-[10px] text-primary">{h.par}</div>
                  </th>
                ))
              )}
              <th className="border-b border-l border-white/10 text-center px-3 py-2 min-w-[56px]">
                <div className="text-muted-foreground font-semibold text-xs">TOT</div>
                <div className="text-[10px] text-primary">{coursePar}</div>
              </th>
              <th className="border-b border-white/10 text-center px-3 py-2 min-w-[56px]">
                <div className="text-muted-foreground font-semibold text-xs">+/-</div>
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredPlayers.map((player, playerIdx) => {
              const total = getTotal(player.id);
              const toPar = getToPar(player.id);
              const front9Total = front9.reduce((s, h) => s + (getStrokes(player.id, h.holeNumber) ?? 0), 0);
              const back9Total = back9.reduce((s, h) => s + (getStrokes(player.id, h.holeNumber) ?? 0), 0);
              const hasFront = front9.some(h => getStrokes(player.id, h.holeNumber) !== null);
              const hasBack = back9.some(h => getStrokes(player.id, h.holeNumber) !== null);

              return (
                <tr key={player.id} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors group">
                  <td className="sticky left-0 z-10 bg-[#0a100a] group-hover:bg-[#0d140d] border-r border-white/10 px-4 py-2">
                    <div className="font-semibold text-white text-sm truncate max-w-[150px]">{player.playerName}</div>
                    <div className="text-xs text-muted-foreground">HCP {player.handicapIndex.toFixed(1)}</div>
                  </td>

                  {hasBothNines ? (
                    <>
                      {front9.map((h, holeIdx) => renderInput(player, h, playerIdx, holeIdx))}
                      <td className="border-l border-white/10 text-center px-2 py-1 text-sm font-semibold text-white/70">
                        {hasFront ? front9Total : '—'}
                      </td>
                      {back9.map((h, holeIdx) =>
                        // holeArrayIdx = front9.length + holeIdx (no +1 since OUT col has no input)
                        renderInput(player, h, playerIdx, front9.length + holeIdx)
                      )}
                      <td className="border-l border-white/10 text-center px-2 py-1 text-sm font-semibold text-white/70">
                        {hasBack ? back9Total : '—'}
                      </td>
                    </>
                  ) : (
                    holes.map((h, holeIdx) => renderInput(player, h, playerIdx, holeIdx))
                  )}

                  <td className="border-l border-white/10 text-center px-3 py-2 font-display font-bold text-white">
                    {total ?? '—'}
                  </td>
                  <td className={`text-center px-3 py-2 font-bold text-sm ${
                    toPar === null ? 'text-muted-foreground' :
                    toPar < 0 ? 'text-green-400' :
                    toPar > 0 ? 'text-red-400' : 'text-white'
                  }`}>
                    {toPar === null ? '—' : toPar === 0 ? 'E' : toPar > 0 ? `+${toPar}` : toPar}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filteredPlayers.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No players {flightFilter !== 'all' ? `in flight "${flightFilter}"` : 'registered'}.
        </div>
      )}
    </div>
  );
}

/* ─── League Round Scorer Grid ────────────────────────────────── */

type LeagueMemberRow = {
  id: number;
  firstName: string;
  lastName: string;
  handicapIndex?: number | null;
};

type HoleResult = { strokes?: number; result?: string; points?: number };

interface LeagueScorerGridProps {
  orgId: number;
  leagueId: number;
  roundId: number;
  format: string;
  members: LeagueMemberRow[];
  holeCount?: number;
  onSubmitted?: () => void;
  isAdmin?: boolean;
  currentUserName?: string;
}

type MatchResultVal = 'win' | 'halve' | 'loss';

const MATCH_OPTIONS: { value: MatchResultVal; label: string; color: string }[] = [
  { value: 'win',   label: 'W', color: 'bg-green-500/20 text-green-400 border-green-500/30' },
  { value: 'halve', label: 'H', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  { value: 'loss',  label: 'L', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
];

const BOGEY_OPTIONS = [
  { value: 'plus',  label: '+', color: 'text-green-400' },
  { value: 'equal', label: '=', color: 'text-white' },
  { value: 'minus', label: '−', color: 'text-red-400' },
];

type LeagueMemberScore = {
  grossScore?: number;
  netScore?: number;
  stablefordPoints?: number;
  matchResult?: string;
  holeScores?: Record<string, HoleResult>;
};

type LeagueUndoEntry =
  | { memberId: number; field: string; prev: number | string | undefined; holeKey?: undefined }
  | { memberId: number; holeKey: string; holeField: 'strokes' | 'result' | 'points'; prev: number | string | undefined; field?: undefined };

type RoundResultRow = { memberId: number; roundId: number; grossScore?: number | null; netScore?: number | null; stablefordPoints?: number | null; matchResult?: string | null; holeScores?: Record<string, HoleResult> | null };

function useLeagueRoundScores(orgId: number, leagueId: number, roundId: number) {
  const [data, setData] = useState<Record<number, LeagueMemberScore>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/organizations/${orgId}/leagues/${leagueId}/rounds/${roundId}/scores`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((rows: Array<{ memberId: number } & LeagueMemberScore>) => {
        const m: Record<number, LeagueMemberScore> = {};
        for (const row of rows) m[row.memberId] = {
          grossScore: row.grossScore ?? undefined,
          netScore: row.netScore ?? undefined,
          stablefordPoints: row.stablefordPoints ?? undefined,
          matchResult: row.matchResult ?? undefined,
          holeScores: row.holeScores ?? undefined,
        };
        setData(m);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orgId, leagueId, roundId]);

  return { data, loading };
}

function useLeagueAllScores(orgId: number, leagueId: number) {
  const [data, setData] = useState<RoundResultRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/organizations/${orgId}/leagues/${leagueId}/scores`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((rows: RoundResultRow[]) => setData(rows))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orgId, leagueId]);

  return { data, loading };
}

export function LeagueScorerGrid({ orgId, leagueId, roundId, format, members, holeCount = 18, onSubmitted, isAdmin = false, currentUserName }: LeagueScorerGridProps) {
  const { toast } = useToast();
  const { data: existingScores, loading } = useLeagueRoundScores(orgId, leagueId, roundId);
  const { data: allLeagueScores } = useLeagueAllScores(orgId, leagueId);
  const [scores, setScores] = useState<Record<number, LeagueMemberScore>>({});
  const [submitting, setSubmitting] = useState(false);
  const [locked, setLocked] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const undoStack = useRef<LeagueUndoEntry[]>([]);
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const isEclectic = format === 'eclectic';

  // Compute eclectic best-per-hole from all rounds EXCEPT current
  const eclecticBestPerHole = useMemo<Record<number, Record<number, number>>>(() => {
    if (!isEclectic || allLeagueScores.length === 0) return {};
    const priorRows = allLeagueScores.filter(r => r.roundId !== roundId);
    const best: Record<number, Record<number, number>> = {};
    for (const row of priorRows) {
      if (!row.holeScores) continue;
      if (!best[row.memberId]) best[row.memberId] = {};
      for (const [holeKey, hs] of Object.entries(row.holeScores)) {
        const hole = parseInt(holeKey, 10);
        const strokes = (hs as HoleResult).strokes;
        if (strokes != null && strokes > 0) {
          if (best[row.memberId][hole] == null || strokes < best[row.memberId][hole]) {
            best[row.memberId][hole] = strokes;
          }
        }
      }
    }
    return best;
  }, [isEclectic, allLeagueScores, roundId]);

  // Find the most recent previous round total per member
  const prevRoundTotals = useMemo<Record<number, { gross?: number; net?: number; points?: number }>>(() => {
    const priorRows = allLeagueScores.filter(r => r.roundId !== roundId);
    if (priorRows.length === 0) return {};
    // Group by memberId, take the row with highest roundId as the "previous" round
    const byMember: Record<number, RoundResultRow[]> = {};
    for (const row of priorRows) {
      if (!byMember[row.memberId]) byMember[row.memberId] = [];
      byMember[row.memberId].push(row);
    }
    const totals: Record<number, { gross?: number; net?: number; points?: number }> = {};
    for (const [midStr, rows] of Object.entries(byMember)) {
      const mid = parseInt(midStr, 10);
      const sorted = rows.sort((a, b) => b.roundId - a.roundId);
      const latest = sorted[0];
      totals[mid] = {
        gross: latest.grossScore ?? undefined,
        net: latest.netScore ?? undefined,
        points: latest.stablefordPoints ?? undefined,
      };
    }
    return totals;
  }, [allLeagueScores, roundId]);

  const hasPrevData = Object.keys(prevRoundTotals).length > 0;

  useEffect(() => {
    if (!loading) {
      // For eclectic: prefill best-per-hole into holeScores for members with no current data
      if (isEclectic && Object.keys(eclecticBestPerHole).length > 0) {
        setScores(prev => {
          const merged = { ...existingScores };
          for (const [midStr, bestHoles] of Object.entries(eclecticBestPerHole)) {
            const mid = parseInt(midStr, 10);
            // Only prefill if the member has no scores in the current round
            if (!merged[mid]?.holeScores || Object.keys(merged[mid].holeScores ?? {}).length === 0) {
              merged[mid] = {
                ...(merged[mid] ?? {}),
                holeScores: Object.fromEntries(
                  Object.entries(bestHoles).map(([h, strokes]) => [h, { strokes }])
                ),
              };
            }
          }
          return { ...prev, ...merged };
        });
      } else {
        setScores(existingScores);
      }
    }
  }, [loading, existingScores, isEclectic, eclecticBestPerHole]);

  const holes = Array.from({ length: holeCount }, (_, i) => i + 1);

  const isStroke = ['stroke_play', 'net_stroke', 'foursomes', 'greensomes', 'shamble', 'texas_scramble', 'eclectic'].includes(format);
  const isStableford = ['stableford', 'alliance', 'better_ball', 'waltz', 'order_of_merit'].includes(format);
  const isMatchPlay = format === 'match_play';
  const isBogey = format === 'bogey';

  const getScore = (memberId: number): LeagueMemberScore => scores[memberId] ?? {};

  const pushUndo = (memberId: number, field: string, prev: number | string | undefined) => {
    undoStack.current.push({ memberId, field, prev });
    if (undoStack.current.length > 100) undoStack.current.shift();
  };

  const handleUndo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    if (entry.holeKey != null) {
      // Hole-level undo: restore previous value in holeScores[holeKey][holeField]
      const { memberId, holeKey, holeField, prev } = entry;
      setScores(s => {
        const prevHoles = s[memberId]?.holeScores ?? {};
        return {
          ...s,
          [memberId]: {
            ...s[memberId],
            holeScores: {
              ...prevHoles,
              [holeKey]: { ...prevHoles[holeKey], [holeField]: prev },
            },
          },
        };
      });
    } else {
      // Top-level field undo (grossScore, matchResult, etc.)
      const { memberId, field, prev } = entry;
      setScores(s => ({ ...s, [memberId]: { ...s[memberId], [field]: prev } }));
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); handleUndo(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleUndo]);

  const updateField = (memberId: number, field: string, value: number | string | undefined) => {
    const prev = (scores[memberId] as Record<string, number | string | undefined>)?.[field];
    pushUndo(memberId, field, prev);
    setScores(s => ({ ...s, [memberId]: { ...s[memberId], [field]: value } }));
  };

  const updateHoleScore = (memberId: number, hole: number, field: 'strokes' | 'result' | 'points', value: number | string | undefined) => {
    const holeKey = String(hole);
    // Push undo entry before mutating state
    const prevHoleVal = (scores[memberId]?.holeScores ?? {})[holeKey]?.[field];
    undoStack.current.push({ memberId, holeKey, holeField: field, prev: prevHoleVal });
    if (undoStack.current.length > 100) undoStack.current.shift();

    setScores(s => {
      const prev = s[memberId]?.holeScores ?? {};
      return {
        ...s,
        [memberId]: {
          ...s[memberId],
          holeScores: {
            ...prev,
            [holeKey]: { ...prev[holeKey], [field]: value },
          },
        },
      };
    });
  };

  const getHoleScore = (memberId: number, hole: number): HoleResult =>
    scores[memberId]?.holeScores?.[String(hole)] ?? {};

  // Match play: group members into adjacent pairs [[m0,m1],[m2,m3],...]
  const pairs: [typeof members[0], typeof members[0] | null][] = useMemo(() => {
    if (!isMatchPlay) return [];
    const result: [typeof members[0], typeof members[0] | null][] = [];
    for (let i = 0; i < members.length; i += 2) {
      result.push([members[i], members[i + 1] ?? null]);
    }
    return result;
  }, [isMatchPlay, members]);

  // Update both sides of a pair with reciprocal W/H/L results
  const updateMatchPairResult = (m1Id: number, m2Id: number | null, clickedId: number, result: MatchResultVal | undefined) => {
    const INVERSE: Record<MatchResultVal, MatchResultVal> = { win: 'loss', halve: 'halve', loss: 'win' };
    setScores(prev => {
      const next = { ...prev };
      const otherId = clickedId === m1Id ? m2Id : m1Id;
      // Toggle off if same value
      const newResult = prev[clickedId]?.matchResult === result ? undefined : result;
      next[clickedId] = { ...(next[clickedId] ?? {}), matchResult: newResult };
      if (otherId !== null) {
        const otherResult = newResult ? INVERSE[newResult] : undefined;
        next[otherId] = { ...(next[otherId] ?? {}), matchResult: otherResult };
      }
      return next;
    });
  };

  // Tab/Enter keyboard nav for league grid (numeric inputs only)
  const handleLeagueKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    memberIdx: number,
    fieldKey: string, // a unique key like `${memberId}-gross` or `${memberId}-hole-${h}`
    nextMemberKey?: string,
    nextFieldKey?: string,
  ) => {
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      const targetKey = e.key === 'Tab' ? nextFieldKey : nextMemberKey;
      if (targetKey) {
        const next = inputRefs.current.get(targetKey);
        next?.focus();
        next?.select();
      }
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const payload = members.map(m => {
        const s = getScore(m.id);
        let gross = s.grossScore;
        let net = s.netScore;

        if ((isStroke || isEclectic) && !gross) {
          const holeStrokes = Object.values(s.holeScores ?? {}).map(h => h.strokes ?? 0);
          const sum = holeStrokes.reduce((a, b) => a + b, 0);
          gross = sum > 0 ? sum : undefined;
          const hcp = m.handicapIndex ? Math.round(Number(m.handicapIndex)) : 0;
          net = gross !== undefined ? gross - hcp : undefined;
        }

        if (isBogey && !gross) {
          const results = Object.values(s.holeScores ?? {});
          const pts = results.reduce((acc, h) => {
            if (h.result === 'plus') return acc + 1;
            if (h.result === 'minus') return acc - 1;
            return acc;
          }, 0);
          gross = pts;
        }

        return {
          memberId: m.id,
          grossScore: gross ?? null,
          netScore: net ?? null,
          stablefordPoints: s.stablefordPoints ?? null,
          matchResult: s.matchResult ?? null,
          holeScores: s.holeScores ?? null,
        };
      });

      const res = await fetch(`/api/organizations/${orgId}/leagues/${leagueId}/rounds/${roundId}/scores`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scores: payload }),
      });

      if (!res.ok) throw new Error();
      toast({ title: 'Round scores saved! Standings updated.' });
      onSubmitted?.();
    } catch {
      toast({ title: 'Failed to save round scores', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-12">
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="flex gap-4 items-start">
    <div className="flex-1 min-w-0 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setLocked(l => !l)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${locked ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-white/5 border-white/10 text-white hover:bg-white/10'}`}
          >
            {locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
            {locked ? 'Locked' : 'Lock'}
          </button>
          <button onClick={() => setHelpOpen(h => !h)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-white">
            <ChevronDown className={`w-3 h-3 transition-transform ${helpOpen ? 'rotate-180' : ''}`} /> Shortcuts
          </button>
          <button onClick={handleUndo} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-white/10 bg-white/5 text-white hover:bg-white/10">
            <RotateCcw className="w-3 h-3" /> Undo
          </button>
        </div>
        <Button onClick={handleSubmit} disabled={submitting || locked} className="bg-primary hover:bg-primary/90 text-primary-foreground">
          {submitting ? 'Saving...' : 'Save & Update Standings'}
        </Button>
      </div>

      {helpOpen && (
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground glass-panel rounded-xl p-3">
          <span><kbd className="bg-white/10 px-1.5 py-0.5 rounded text-white">Tab</kbd> next field</span>
          <span><kbd className="bg-white/10 px-1.5 py-0.5 rounded text-white">Enter</kbd> next member</span>
          <span><kbd className="bg-white/10 px-1.5 py-0.5 rounded text-white">Ctrl+Z</kbd> undo</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-white/5 relative">
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-black/60 border-b border-white/10 sticky top-0 z-10">
              <th className="text-left px-4 py-2.5 text-xs text-muted-foreground font-semibold uppercase tracking-wider min-w-[160px] sticky left-0 z-20 bg-black/60">Member</th>
              {(isStroke || isEclectic) && holes.map(h => (
                <th key={h} className="text-center px-2 py-2.5 text-xs text-muted-foreground font-semibold min-w-[44px] hidden sm:table-cell">{h}</th>
              ))}
              {(isStroke || isEclectic) && (
                <th className="text-center px-3 py-2.5 text-xs text-muted-foreground font-semibold border-l border-white/10">Total</th>
              )}
              {isStableford && (
                <>
                  <th className="text-center px-3 py-2.5 text-xs text-muted-foreground font-semibold">Gross</th>
                  <th className="text-center px-3 py-2.5 text-xs text-muted-foreground font-semibold">Net</th>
                  <th className="text-center px-3 py-2.5 text-xs text-muted-foreground font-semibold">Points</th>
                </>
              )}
              {isMatchPlay && (
                <th className="text-center px-3 py-2.5 text-xs text-muted-foreground font-semibold">Result</th>
              )}
              {isBogey && holes.map(h => (
                <th key={h} className="text-center px-2 py-2.5 text-xs text-muted-foreground font-semibold min-w-[44px] hidden sm:table-cell">{h}</th>
              ))}
              {isBogey && (
                <th className="text-center px-3 py-2.5 text-xs text-muted-foreground font-semibold border-l border-white/10">Total</th>
              )}
              {hasPrevData && (
                <th className="text-center px-3 py-2.5 text-xs text-muted-foreground font-semibold border-l border-white/10 bg-white/[0.02]">Prev</th>
              )}
            </tr>
          </thead>
          <tbody>
            {/* Match play: render pair rows */}
            {isMatchPlay && pairs.map(([m1, m2]) => {
              const s1 = getScore(m1.id);
              const s2 = m2 ? getScore(m2.id) : null;
              const prev1 = prevRoundTotals[m1.id];
              const prev2 = m2 ? prevRoundTotals[m2.id] : null;

              const renderMemberResult = (m: typeof members[0], s: LeagueMemberScore) => (
                <div key={m.id} className="flex items-center justify-between gap-2 py-0.5">
                  <div>
                    <span className="text-sm font-semibold text-white">{m.firstName} {m.lastName}</span>
                    {m.handicapIndex != null && <span className="text-xs text-muted-foreground ml-1.5">HCP {Number(m.handicapIndex).toFixed(1)}</span>}
                  </div>
                  <div className="flex gap-1">
                    {MATCH_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        disabled={locked}
                        onClick={() => updateMatchPairResult(m1.id, m2?.id ?? null, m.id, opt.value)}
                        className={`w-8 h-8 rounded-lg text-xs font-bold border transition-all disabled:opacity-40 ${
                          s.matchResult === opt.value ? opt.color : 'bg-white/5 text-muted-foreground border-white/10 hover:bg-white/10'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              );

              return (
                <tr key={`pair-${m1.id}-${m2?.id ?? 'bye'}`} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                  <td colSpan={2} className="px-4 py-2">
                    <div className="space-y-1">
                      {renderMemberResult(m1, s1)}
                      {m2 ? (
                        <>
                          <div className="text-center text-xs text-muted-foreground/40 font-medium">vs</div>
                          {renderMemberResult(m2, s2!)}
                        </>
                      ) : (
                        <div className="text-xs text-muted-foreground/40 text-center">BYE</div>
                      )}
                    </div>
                  </td>
                  {hasPrevData && (
                    <td className="border-l border-white/10 text-center px-3 py-2 text-xs font-semibold text-muted-foreground bg-white/[0.02]">
                      {prev1?.gross ? `${prev1.gross}` : '—'}
                      {m2 && prev2?.gross ? ` / ${prev2.gross}` : ''}
                    </td>
                  )}
                </tr>
              );
            })}

            {/* All other formats: individual member rows */}
            {!isMatchPlay && members.map((m, memberIdx) => {
              const s = getScore(m.id);
              const strokeTotal = (isStroke || isEclectic)
                ? (() => {
                    const vals = Object.values(s.holeScores ?? {}).map(h => h.strokes ?? 0).filter(v => v > 0);
                    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
                  })()
                : null;
              const bogeyTotal = isBogey
                ? Object.values(s.holeScores ?? {}).reduce((acc, h) => {
                    if (h.result === 'plus') return acc + 1;
                    if (h.result === 'minus') return acc - 1;
                    return acc;
                  }, 0)
                : null;
              const hasBogeyScores = isBogey && Object.values(s.holeScores ?? {}).some(h => h.result);

              return (
                <tr key={m.id} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-2.5 sticky left-0 z-10 bg-[#0a100a]">
                    <div className="font-semibold text-white text-sm">{m.firstName} {m.lastName}</div>
                    {m.handicapIndex != null && <div className="text-xs text-muted-foreground">HCP {Number(m.handicapIndex).toFixed(1)}</div>}
                  </td>

                  {(isStroke || isEclectic) && holes.map((h, hIdx) => {
                    const hs = getHoleScore(m.id, h);
                    const refKey = `${m.id}-hole-${h}`;
                    const nextHoleKey = hIdx + 1 < holes.length ? `${m.id}-hole-${holes[hIdx + 1]}` : undefined;
                    const nextMemberKey = memberIdx + 1 < members.length ? `${members[memberIdx + 1].id}-hole-${h}` : undefined;
                    return (
                      <td key={h} className="p-1 text-center hidden sm:table-cell">
                        <input
                          ref={el => { if (el) inputRefs.current.set(refKey, el); else inputRefs.current.delete(refKey); }}
                          type="number"
                          min={1}
                          max={20}
                          value={hs.strokes ?? ''}
                          disabled={locked}
                          onChange={e => {
                            const v = parseInt(e.target.value, 10);
                            updateHoleScore(m.id, h, 'strokes', isNaN(v) ? undefined : v);
                          }}
                          onFocus={e => e.target.select()}
                          onKeyDown={e => handleLeagueKeyDown(e, memberIdx, refKey, nextMemberKey, nextHoleKey)}
                          className="w-10 h-8 text-center text-sm font-bold bg-white/5 border border-white/10 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none text-white"
                        />
                      </td>
                    );
                  })}

                  {(isStroke || isEclectic) && (
                    <td className="border-l border-white/10 text-center px-3 py-2 font-bold text-white">
                      {strokeTotal ?? '—'}
                    </td>
                  )}

                  {isStableford && (
                    <>
                      <td className="p-2 text-center">
                        <input
                          type="number"
                          min={0}
                          value={s.grossScore ?? ''}
                          disabled={locked}
                          onChange={e => updateField(m.id, 'grossScore', parseInt(e.target.value) || undefined)}
                          onFocus={e => e.target.select()}
                          className="w-14 h-8 text-center text-sm font-bold bg-white/5 border border-white/10 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-40 text-white [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                      </td>
                      <td className="p-2 text-center">
                        <input
                          type="number"
                          min={0}
                          value={s.netScore ?? ''}
                          disabled={locked}
                          onChange={e => updateField(m.id, 'netScore', parseInt(e.target.value) || undefined)}
                          onFocus={e => e.target.select()}
                          className="w-14 h-8 text-center text-sm font-bold bg-white/5 border border-white/10 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-40 text-white [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                      </td>
                      <td className="p-2 text-center">
                        <input
                          type="number"
                          min={0}
                          value={s.stablefordPoints ?? ''}
                          disabled={locked}
                          onChange={e => updateField(m.id, 'stablefordPoints', parseInt(e.target.value) || undefined)}
                          onFocus={e => e.target.select()}
                          className="w-14 h-8 text-center text-sm font-bold bg-white/5 border border-primary/20 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-40 text-primary [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                      </td>
                    </>
                  )}

                  {isMatchPlay && (
                    <td className="p-2 text-center">
                      <div className="flex gap-1 justify-center">
                        {MATCH_OPTIONS.map(opt => (
                          <button
                            key={opt.value}
                            disabled={locked}
                            onClick={() => updateField(m.id, 'matchResult', s.matchResult === opt.value ? undefined : opt.value)}
                            className={`w-8 h-8 rounded-lg text-xs font-bold border transition-all disabled:opacity-40 ${
                              s.matchResult === opt.value ? opt.color : 'bg-white/5 text-muted-foreground border-white/10 hover:bg-white/10'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  )}

                  {isBogey && holes.map(h => {
                    const hs = getHoleScore(m.id, h);
                    return (
                      <td key={h} className="p-1 text-center hidden sm:table-cell">
                        <div className="flex flex-col gap-0.5 items-center">
                          {BOGEY_OPTIONS.map(opt => (
                            <button
                              key={opt.value}
                              disabled={locked}
                              onClick={() => updateHoleScore(m.id, h, 'result', hs.result === opt.value ? undefined : opt.value)}
                              className={`w-8 h-5 rounded text-[10px] font-bold transition-all disabled:opacity-40 ${
                                hs.result === opt.value
                                  ? `${opt.color} bg-white/10`
                                  : 'text-muted-foreground hover:text-white'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </td>
                    );
                  })}

                  {isBogey && (
                    <td className={`border-l border-white/10 text-center px-3 py-2 font-bold ${
                      hasBogeyScores
                        ? (bogeyTotal! > 0 ? 'text-green-400' : bogeyTotal! < 0 ? 'text-red-400' : 'text-white')
                        : 'text-muted-foreground'
                    }`}>
                      {hasBogeyScores ? (bogeyTotal! > 0 ? `+${bogeyTotal}` : String(bogeyTotal)) : '—'}
                    </td>
                  )}

                  {hasPrevData && (() => {
                    const prev = prevRoundTotals[m.id];
                    let display = '—';
                    if (prev) {
                      if (isStableford && prev.points != null) display = `${prev.points}pts`;
                      else if (prev.gross != null) display = String(prev.gross);
                    }
                    return (
                      <td className="border-l border-white/10 text-center px-3 py-2 text-xs font-semibold text-muted-foreground bg-white/[0.02]" title="Previous round total">
                        {display}
                      </td>
                    );
                  })()}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    <LiveMessagePanel
      streamUrl={`/api/organizations/${orgId}/leagues/${leagueId}/announcements/stream`}
      postUrl={`/api/organizations/${orgId}/leagues/${leagueId}/announcements`}
      authorName={currentUserName ?? 'Admin'}
      isAdmin={isAdmin}
    />
    </div>
  );
}
