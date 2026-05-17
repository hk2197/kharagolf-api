import { useParams } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { useState, useCallback, useEffect, useRef } from 'react';
import { KharaGolfWordmark } from '@/components/kharagolf-brand';
import { useToast } from '@/hooks/use-toast';
import {
  KeyRound, LogOut, Loader2, Users, ChevronLeft, ChevronRight,
  CheckCircle2, Keyboard, LayoutGrid, Search, Clock, Flag, Wifi, WifiOff, Trophy,
  RefreshCw, Info, ChevronDown, ChevronUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const API = (path: string) => `/api${path}`;

interface HolePar { holeNumber: number; par: number; handicap?: number | null }
interface TeeTimePlayer { playerId: number; firstName: string; lastName: string; handicapIndex?: number | null; flight?: string | null; madeCut?: boolean | null }
interface TeeTimeGroup { id: number; teeTime: string; startingHole: number; round: number; players: TeeTimePlayer[]; isManual?: boolean }
interface Tournament { id: number; name: string; organizationId: number; courseId?: number | null; rounds?: number; status?: string; format?: string | null; maxScoreCap?: number | null; cutAfterRound?: number | null; entries?: Array<{ playerId: number; madeCut?: boolean | null }> }
interface LocalRulesConfig { preferredLies?: boolean; preferredLiesRadius?: string; preferredLiesArea?: string; reducedEsc?: boolean; reducedEscMax?: number; liftCleanPlace?: boolean; dropZones?: string; additionalNotes?: string }
interface HolesResponse { holes: HolePar[]; rounds: number; localRules?: string | null; localRulesConfig?: LocalRulesConfig | null }
interface ExistingScore { playerId: number; holeNumber: number; strokes: number; round: number }

type Phase = 'groups' | 'scoring' | 'review' | 'submitted';
type InputMode = 'tap' | 'keyboard';
type ScoreMap = Map<string, number>; // key: `${playerId}-${hole}`

interface QueuedSave {
  orgId: number;
  tid: number;
  round: number;
  scores: Array<{ playerId: number; holeNumber: number; strokes: number }>;
}

function scoreKey(playerId: number, hole: number) { return `${playerId}-${hole}`; }

function cellBg(toPar: number | null): string {
  if (toPar === null) return 'bg-white/5';
  if (toPar <= -2) return 'bg-amber-500/30 border border-amber-400/50';
  if (toPar === -1) return 'bg-red-500/25 border border-red-400/40';
  if (toPar === 0) return 'bg-white/5';
  if (toPar === 1) return 'bg-blue-500/15 border border-blue-400/30';
  return 'bg-purple-500/20 border border-purple-400/35';
}

function scoreLabel(toPar: number | null): string {
  if (toPar === null) return '';
  if (toPar <= -2) return 'Eagle';
  if (toPar === -1) return 'Birdie';
  if (toPar === 0) return 'Par';
  if (toPar === 1) return 'Bogey';
  if (toPar === 2) return 'Double';
  return `+${toPar}`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return iso; }
}

export default function ScorerSessionPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const tid = parseInt(tournamentId ?? '0');
  const { toast } = useToast();

  const [phase, setPhase] = useState<Phase>('groups');
  const [selectedGroup, setSelectedGroup] = useState<TeeTimeGroup | null>(null);
  const [activeRound, setActiveRound] = useState(1);
  const [currentHole, setCurrentHole] = useState(1);
  const [scores, setScores] = useState<ScoreMap>(new Map());
  const [inputMode, setInputMode] = useState<InputMode>('tap');
  const [saving, setSaving] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const [isConnected, setIsConnected] = useState(navigator.onLine);
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const offlineQueue = useRef<QueuedSave[]>([]);
  const drainInProgress = useRef(false);

  // ── Connectivity monitoring ──────────────────────────────────────────────────
  useEffect(() => {
    const handleOnline = () => {
      setIsConnected(true);
      drainOfflineQueue();
    };
    const handleOffline = () => setIsConnected(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drainOfflineQueue = useCallback(async () => {
    if (drainInProgress.current || offlineQueue.current.length === 0) return;
    drainInProgress.current = true;
    try {
      const items = [...offlineQueue.current];
      offlineQueue.current = [];
      for (const item of items) {
        await fetch(API(`/organizations/${item.orgId}/tournaments/${item.tid}/scores/bulk`), {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scores: item.scores.map(s => ({ ...s, round: item.round })) }),
        });
      }
      if (items.length > 0) toast({ title: `${items.length} queued save${items.length !== 1 ? 's' : ''} synced`, description: 'Offline scores have been submitted.' });
    } catch {
      // re-queue on failure
    } finally {
      drainInProgress.current = false;
    }
  }, [toast]);

  const { data: tournament, isLoading: tLoading } = useQuery<Tournament>({
    queryKey: [`/api/public/leaderboard/${tid}`],
    queryFn: () => fetch(API(`/public/leaderboard/${tid}`)).then(r => r.ok ? r.json() : null),
    enabled: !!tid,
    retry: false,
  });

  const orgId = (tournament as any)?.organizationId;

  const { data: holesData } = useQuery<HolesResponse>({
    queryKey: [`/api/public/tournaments/${tid}/holes`],
    queryFn: () => fetch(API(`/public/tournaments/${tid}/holes`)).then(r => r.ok ? r.json() : { holes: [], rounds: 1 }),
    enabled: !!tid,
  });

  const [localRulesBannerOpen, setLocalRulesBannerOpen] = useState(true);

  const { data: teeTimesRaw = [], isLoading: ttLoading, refetch: refetchTeeTimes } = useQuery<TeeTimeGroup[]>({
    queryKey: [`/api/organizations/${orgId}/tournaments/${tid}/tee-times`],
    queryFn: () => fetch(API(`/organizations/${orgId}/tournaments/${tid}/tee-times`), { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && !!tid,
  });

  const { data: meData } = useQuery({
    queryKey: ['/api/auth/me'],
    queryFn: () => fetch(API('/auth/me'), { credentials: 'include' }).then(r => r.ok ? r.json() : null),
    retry: false,
  });

  const holes = holesData?.holes ?? [];
  const totalRounds = (tournament as any)?.rounds ?? holesData?.rounds ?? 1;
  const displayName = meData?.displayName || 'Scorer';
  const localRules = holesData?.localRules ?? null;
  const localRulesConfig = holesData?.localRulesConfig ?? null;
  const activeLocalRuleFlags: string[] = [
    ...(localRulesConfig?.preferredLies ? [`Preferred Lies${localRulesConfig.preferredLiesRadius ? ` (${localRulesConfig.preferredLiesRadius.replace('_', ' ')})` : ''}${localRulesConfig.preferredLiesArea === 'fairways_only' ? ' — Fairways Only' : localRulesConfig.preferredLiesArea === 'through_green' ? ' — Through the Green' : ''}`] : []),
    ...(localRulesConfig?.liftCleanPlace ? ['Lift, Clean & Place'] : []),
    ...(localRulesConfig?.reducedEsc ? [`Reduced ESC${localRulesConfig.reducedEscMax ? ` (max ${localRulesConfig.reducedEscMax})` : ''}`] : []),
    ...(localRulesConfig?.dropZones ? [`Drop Zones: ${localRulesConfig.dropZones}`] : []),
    ...(localRulesConfig?.additionalNotes ? [localRulesConfig.additionalNotes] : []),
  ];
  const hasLocalRules = activeLocalRuleFlags.length > 0 || !!localRules;

  const teeTimes = teeTimesRaw.filter(tt => tt.round === activeRound);

  const filteredGroups = groupSearch
    ? teeTimes.filter(tt => tt.players.some(p =>
        `${p.firstName} ${p.lastName}`.toLowerCase().includes(groupSearch.toLowerCase())
      ))
    : teeTimes;

  const holeData = holes.find(h => h.holeNumber === currentHole);
  const holePar = holeData?.par ?? 4;
  const holeHandicap = holeData?.handicap ?? currentHole;
  const totalHoles = holes.length || 18;

  const getScore = useCallback((playerId: number, hole: number): number | null => {
    const v = scores.get(scoreKey(playerId, hole));
    return v !== undefined ? v : null;
  }, [scores]);

  const setScore = useCallback((playerId: number, hole: number, strokes: number) => {
    setScores(prev => new Map(prev).set(scoreKey(playerId, hole), strokes));
  }, []);

  const getPlayerTotal = useCallback((playerId: number): { total: number | null; toPar: number | null } => {
    let total = 0; let toPar = 0; let hasAny = false;
    for (const h of holes) {
      const s = getScore(playerId, h.holeNumber);
      if (s !== null) { total += s; toPar += s - h.par; hasAny = true; }
    }
    return hasAny ? { total, toPar } : { total: null, toPar: null };
  }, [holes, getScore]);

  // ── Save a hole's scores (bulk, with offline queueing) ────────────────────
  const saveHoleScores = useCallback(async (players: TeeTimePlayer[], hole: number) => {
    if (!orgId) return;
    const scoreEntries = players
      .map(p => ({ playerId: p.playerId, holeNumber: hole, strokes: getScore(p.playerId, hole) }))
      .filter((s): s is { playerId: number; holeNumber: number; strokes: number } => s.strokes !== null);
    if (scoreEntries.length === 0) return;

    if (!isConnected) {
      offlineQueue.current.push({ orgId, tid, round: activeRound, scores: scoreEntries });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(API(`/organizations/${orgId}/tournaments/${tid}/scores/bulk`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scores: scoreEntries.map(s => ({ ...s, round: activeRound })) }),
      });
      if (!res.ok) throw new Error('Save failed');
    } catch {
      offlineQueue.current.push({ orgId, tid, round: activeRound, scores: scoreEntries });
      toast({ title: 'Saved offline', description: 'Scores queued and will sync when connected.', variant: 'default' });
    } finally {
      setSaving(false);
    }
  }, [orgId, tid, activeRound, getScore, isConnected, toast]);

  const handleNextHole = useCallback(async () => {
    if (!selectedGroup) return;
    await saveHoleScores(selectedGroup.players, currentHole);
    if (currentHole >= totalHoles) {
      setPhase('review');
    } else {
      setCurrentHole(h => h + 1);
    }
  }, [selectedGroup, currentHole, totalHoles, saveHoleScores]);

  const handlePrevHole = useCallback(() => {
    if (currentHole > 1) setCurrentHole(h => h - 1);
    else if (phase === 'review') setPhase('scoring');
  }, [currentHole, phase]);

  // ── Load existing scores when selecting a group ───────────────────────────
  const handleSelectGroup = useCallback(async (group: TeeTimeGroup) => {
    setSelectedGroup(group);
    setCurrentHole(1);
    setPhase('scoring');

    // Seed map with par defaults
    const defaultScores = new Map<string, number>();
    for (const p of group.players) {
      for (const h of holes) {
        defaultScores.set(scoreKey(p.playerId, h.holeNumber), h.par);
      }
    }
    setScores(defaultScores);

    // Fetch any already-entered scores for these players this round
    if (!orgId) return;
    try {
      const playerIds = group.players.map(p => p.playerId);
      const responses = await Promise.all(
        playerIds.map(pid =>
          fetch(API(`/organizations/${orgId}/tournaments/${tid}/scores?playerId=${pid}&round=${activeRound}`), { credentials: 'include' })
            .then(r => r.ok ? r.json() as Promise<ExistingScore[]> : [])
        )
      );
      setScores(prev => {
        const merged = new Map(prev);
        for (const arr of responses) {
          for (const s of arr) {
            if (s.round === activeRound) merged.set(scoreKey(s.playerId, s.holeNumber), s.strokes);
          }
        }
        return merged;
      });
    } catch { /* non-fatal — defaults remain */ }
  }, [holes, orgId, tid, activeRound]);

  // ── Submit round: final bulk save + mark all verified ────────────────────
  const handleSubmitRound = async () => {
    if (!selectedGroup || !orgId) return;
    setSaving(true);
    try {
      // 1. Bulk-save all scores (idempotent)
      const allScores = selectedGroup.players.flatMap(p =>
        holes
          .map(h => ({ playerId: p.playerId, holeNumber: h.holeNumber, strokes: getScore(p.playerId, h.holeNumber), round: activeRound }))
          .filter((s): s is { playerId: number; holeNumber: number; strokes: number; round: number } => s.strokes !== null)
      );
      if (allScores.length > 0) {
        await fetch(API(`/organizations/${orgId}/tournaments/${tid}/scores/bulk`), {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scores: allScores }),
        });
      }
      // 2. Drain any queued offline saves
      const queuedItems = [...offlineQueue.current];
      offlineQueue.current = [];
      for (const item of queuedItems) {
        await fetch(API(`/organizations/${item.orgId}/tournaments/${item.tid}/scores/bulk`), {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scores: item.scores.map(s => ({ ...s, round: item.round })) }),
        });
      }
      // 3. Mark all scores as verified + push notify players
      await fetch(API(`/organizations/${orgId}/tournaments/${tid}/scores/batch-verify`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerIds: selectedGroup.players.map(p => p.playerId), round: activeRound }),
      });
      setPhase('submitted');
      toast({ title: 'Round submitted!', description: 'All scores verified. Players have been notified.' });
    } catch {
      toast({ title: 'Failed to submit round', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await fetch(API('/auth/player-logout'), { method: 'POST', credentials: 'include' });
    window.location.href = '/scorer';
  };

  const isLoading = tLoading || ttLoading;

  // Extract scoring view to avoid IIFE inside JSX ternary (Babel/esbuild parse error)
  const tournamentFmt = tournament?.format ?? null;
  const maxCap = tournament?.maxScoreCap ?? null;
  const cutRound = tournament?.cutAfterRound ?? null;
  const madeCutById = new Map((tournament?.entries ?? []).map(e => [e.playerId, e.madeCut]));
  const activePlayers = selectedGroup
    ? (cutRound !== null && selectedGroup.round > cutRound
        ? selectedGroup.players.filter(p => madeCutById.get(p.playerId) !== false)
        : selectedGroup.players)
    : [];
  const scoringGroup = selectedGroup ? { ...selectedGroup, players: activePlayers } : null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-white/5 bg-card/60 backdrop-blur-xl px-4 py-3 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="KharaGolf" className="w-8 h-8 object-contain rounded" />
          <div>
            <p className="font-semibold text-white text-sm leading-tight">
              {tLoading ? 'Loading…' : (tournament as any)?.name || 'Tournament Scoring'}
            </p>
            <div className="flex items-center gap-1.5">
              <KharaGolfWordmark />
              <span className="text-muted-foreground text-xs">·</span>
              <KeyRound className="w-3 h-3 text-primary" />
              <span className="text-xs text-primary">{displayName}</span>
              <span className="text-muted-foreground text-xs">·</span>
              {isConnected
                ? <Wifi className="w-3 h-3 text-green-400" />
                : <WifiOff className="w-3 h-3 text-red-400 animate-pulse" />}
              {offlineQueue.current.length > 0 && (
                <span className="text-[10px] text-amber-400 flex items-center gap-0.5">
                  <RefreshCw className="w-2.5 h-2.5" />
                  {offlineQueue.current.length} queued
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {phase === 'scoring' && (
            <button
              onClick={() => setInputMode(m => m === 'tap' ? 'keyboard' : 'tap')}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white transition-colors px-2 py-1 rounded hover:bg-white/5"
              title={inputMode === 'tap' ? 'Switch to keyboard mode' : 'Switch to tap mode'}
              aria-label={inputMode === 'tap' ? 'Switch to keyboard mode' : 'Switch to tap mode'}
            >
              {inputMode === 'tap' ? <Keyboard className="w-3.5 h-3.5" /> : <LayoutGrid className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-colors px-2 py-1 rounded hover:bg-destructive/10"
          >
            <LogOut className="w-3.5 h-3.5" />
            Exit
          </button>
        </div>
      </header>

      {/* Offline banner */}
      {!isConnected && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
          <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-xs text-amber-300">Offline — scores are being queued and will sync when connected</span>
        </div>
      )}

      {/* Local Rules banner */}
      {hasLocalRules && (
        <div className="border-b border-primary/20 bg-primary/5">
          <button
            className="w-full px-4 py-2 flex items-center gap-2 text-left"
            onClick={() => setLocalRulesBannerOpen(o => !o)}
          >
            <Info className="w-3.5 h-3.5 text-primary shrink-0" />
            <span className="text-xs font-medium text-primary flex-1">Local Rules in Effect</span>
            {localRulesBannerOpen
              ? <ChevronUp className="w-3.5 h-3.5 text-primary/60" />
              : <ChevronDown className="w-3.5 h-3.5 text-primary/60" />}
          </button>
          {localRulesBannerOpen && (
            <div className="px-4 pb-3 space-y-1.5">
              {activeLocalRuleFlags.map((flag, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="text-primary mt-0.5">•</span>
                  <span className="text-xs text-white/80">{flag}</span>
                </div>
              ))}
              {localRules && (
                <p className="text-xs text-white/70 leading-relaxed mt-1 whitespace-pre-wrap">{localRules}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Body */}
      <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto focus:outline-none">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          </div>
        ) : phase === 'groups' ? (
          <GroupPicker
            teeTimes={filteredGroups}
            allTeeTimes={teeTimes}
            groupSearch={groupSearch}
            setGroupSearch={setGroupSearch}
            onSelectGroup={handleSelectGroup}
            totalRounds={totalRounds}
            activeRound={activeRound}
            setActiveRound={setActiveRound}
          />
        ) : phase === 'scoring' && scoringGroup ? (
          <HoleEntry
            group={scoringGroup}
            holes={holes}
            currentHole={currentHole}
            holePar={holePar}
            holeHandicap={holeHandicap}
            totalHoles={totalHoles}
            scores={scores}
            inputMode={inputMode}
            saving={saving}
            inputRefs={inputRefs}
            getScore={getScore}
            setScore={setScore}
            getPlayerTotal={getPlayerTotal}
            onPrev={handlePrevHole}
            onNext={handleNextHole}
            onBackToGroups={() => { setPhase('groups'); setSelectedGroup(null); }}
            format={tournamentFmt}
            maxScoreCap={maxCap}
          />
        ) : phase === 'review' && selectedGroup ? (
          <RoundReview
            group={selectedGroup}
            holes={holes}
            scores={scores}
            getScore={getScore}
            getPlayerTotal={getPlayerTotal}
            saving={saving}
            onBack={() => { setCurrentHole(totalHoles); setPhase('scoring'); }}
            onSubmit={handleSubmitRound}
          />
        ) : phase === 'submitted' ? (
          <SubmittedScreen
            group={selectedGroup}
            onNewGroup={() => { setPhase('groups'); setSelectedGroup(null); setScores(new Map()); refetchTeeTimes(); }}
          />
        ) : null}
      </main>
    </div>
  );
}

/* ─── Group Picker ────────────────────────────────────────────────── */
function GroupPicker({ teeTimes, allTeeTimes, groupSearch, setGroupSearch, onSelectGroup, totalRounds, activeRound, setActiveRound }: {
  teeTimes: TeeTimeGroup[];
  allTeeTimes: TeeTimeGroup[];
  groupSearch: string;
  setGroupSearch: (v: string) => void;
  onSelectGroup: (g: TeeTimeGroup) => void;
  totalRounds: number;
  activeRound: number;
  setActiveRound: (r: number) => void;
}) {
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-display font-bold text-xl">Select Your Group</h2>
          <p className="text-muted-foreground text-sm mt-0.5">{allTeeTimes.length} group{allTeeTimes.length !== 1 ? 's' : ''} · Round {activeRound}</p>
        </div>
        {totalRounds > 1 && (
          <div className="flex gap-1">
            {Array.from({ length: totalRounds }, (_, i) => i + 1).map(r => (
              <button
                key={r}
                onClick={() => setActiveRound(r)}
                className={`w-8 h-8 rounded-lg text-sm font-semibold transition-all ${activeRound === r ? 'bg-primary text-primary-foreground' : 'bg-white/5 text-muted-foreground hover:bg-white/10'}`}
              >
                {r}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={groupSearch}
          onChange={e => setGroupSearch(e.target.value)}
          placeholder="Search player name…"
          aria-label="Search players by name"
          className="pl-9 bg-black/40 border-white/10 text-white placeholder:text-muted-foreground"
        />
      </div>

      {teeTimes.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>{groupSearch ? 'No groups match your search.' : 'No tee times drawn for this round yet.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {teeTimes.map(tt => (
            <button
              key={tt.id}
              onClick={() => onSelectGroup(tt)}
              className="w-full text-left p-4 rounded-2xl bg-card border border-white/10 hover:border-primary/40 hover:bg-white/[0.03] transition-all group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="w-3.5 h-3.5 text-primary shrink-0" />
                    <span className="text-primary font-semibold text-sm">{formatTime(tt.teeTime)}</span>
                    <span className="text-muted-foreground text-xs">· Hole {tt.startingHole}</span>
                    {tt.isManual && <span className="text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded-full">Locked</span>}
                  </div>
                  <div className="space-y-1">
                    {tt.players.map(p => (
                      <div key={p.playerId} className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-primary text-[10px] font-bold shrink-0">
                          {p.firstName[0]}{p.lastName[0]}
                        </div>
                        <span className="text-white text-sm font-medium">{p.firstName} {p.lastName}</span>
                        {p.handicapIndex != null && (
                          <span className="text-xs text-muted-foreground ml-auto">HCP {Number(p.handicapIndex).toFixed(1)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0 mt-1" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Hole Entry ──────────────────────────────────────────────────── */
function HoleEntry({
  group, holes, currentHole, holePar, holeHandicap, totalHoles,
  scores, inputMode, saving, inputRefs, getScore, setScore, getPlayerTotal,
  onPrev, onNext, onBackToGroups, format, maxScoreCap,
}: {
  group: TeeTimeGroup; holes: HolePar[]; currentHole: number; holePar: number; holeHandicap: number; totalHoles: number;
  scores: ScoreMap; inputMode: InputMode; saving: boolean; inputRefs: React.MutableRefObject<Map<string, HTMLInputElement>>;
  getScore: (p: number, h: number) => number | null;
  setScore: (p: number, h: number, s: number) => void;
  getPlayerTotal: (p: number) => { total: number | null; toPar: number | null };
  onPrev: () => void; onNext: () => void; onBackToGroups: () => void;
  format?: string | null; maxScoreCap?: number | null;
}) {
  const isMaxScore = format === 'maximum_score';
  const isParBogey = format === 'par_bogey';
  // Par/bogey running W/L total across all scored holes
  const getPlayerParBogeyRunning = (playerId: number) => {
    let w = 0, l = 0, h = 0;
    for (let holeNum = 1; holeNum < currentHole; holeNum++) {
      const holePar2 = holes.find(hp => hp.holeNumber === holeNum)?.par ?? 4;
      const strokes = scores.get(scoreKey(playerId, holeNum)) ?? null;
      if (strokes === null) continue;
      if (strokes < holePar2) w++;
      else if (strokes > holePar2) l++;
      else h++;
    }
    return { w, l, h };
  };
  const allFilled = group.players.every(p => getScore(p.playerId, currentHole) !== null);
  const progress = ((currentHole - 1) / totalHoles) * 100;

  // Auto-advance: when all players scored in tap mode, move to next hole after a short delay
  const autoAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current);
    if (allFilled && inputMode === 'tap' && !saving) {
      autoAdvanceTimer.current = setTimeout(() => { onNext(); }, 1200);
    }
    return () => { if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current); };
  // only trigger when allFilled transitions to true or hole changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFilled, currentHole, inputMode]);

  return (
    <div className="flex flex-col min-h-[calc(100vh-57px)]">
      {/* Progress bar */}
      <div className="h-1 bg-white/5">
        <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>

      {/* Hole header */}
      <div className="bg-black/40 border-b border-white/5 px-4 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <button onClick={onBackToGroups} className="text-muted-foreground hover:text-white transition-colors flex items-center gap-1 text-sm">
            <ChevronLeft className="w-4 h-4" /> Groups
          </button>
          <div className="text-center">
            <div className="flex items-center gap-2 justify-center">
              <Flag className="w-4 h-4 text-primary" />
              <span className="font-display font-bold text-2xl text-white">Hole {currentHole}</span>
            </div>
            <div className="flex items-center gap-3 justify-center mt-0.5">
              <span className="text-sm text-muted-foreground">Par <span className="text-white font-semibold">{holePar}</span></span>
              <span className="text-muted-foreground">·</span>
              <span className="text-sm text-muted-foreground">SI <span className="text-white font-semibold">{holeHandicap}</span></span>
              {isMaxScore && maxScoreCap !== null && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-400/30">
                    Max {holePar + maxScoreCap}
                  </span>
                </>
              )}
              {isParBogey && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30">W/L</span>
                </>
              )}
            </div>
          </div>
          <span className="text-muted-foreground text-sm">{currentHole}/{totalHoles}</span>
        </div>
      </div>

      {/* Players */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 max-w-2xl mx-auto w-full">
        {group.players.map((player) => {
          const strokes = getScore(player.playerId, currentHole);
          const toPar = strokes !== null ? strokes - holePar : null;
          const { total, toPar: runningToPar } = getPlayerTotal(player.playerId);
          const pbRunning = isParBogey ? getPlayerParBogeyRunning(player.playerId) : null;
          const netAfterCap = isMaxScore && maxScoreCap !== null && strokes !== null
            ? Math.min(strokes, holePar + maxScoreCap)
            : strokes;

          return (
            <div key={player.playerId} className={`rounded-2xl p-4 border transition-all ${strokes !== null ? cellBg(toPar) + ' border-opacity-100' : 'bg-card border-white/10'}`}>
              {/* Player info row */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                    {player.firstName[0]}{player.lastName[0]}
                  </div>
                  <div>
                    <p className="text-white font-semibold text-sm">{player.firstName} {player.lastName}</p>
                    <p className="text-muted-foreground text-xs">
                      {player.handicapIndex != null ? `HCP ${Number(player.handicapIndex).toFixed(1)}` : ''}
                      {isParBogey && pbRunning !== null
                        ? ` · ${pbRunning.w}W ${pbRunning.l}L ${pbRunning.h}H`
                        : total !== null ? ` · Total: ${total} (${runningToPar === 0 ? 'E' : runningToPar! > 0 ? `+${runningToPar}` : runningToPar})` : ''}
                    </p>
                    {isMaxScore && maxScoreCap !== null && strokes !== null && strokes > holePar + maxScoreCap && (
                      <p className="text-amber-400 text-xs mt-0.5">Score capped: {strokes} → {netAfterCap}</p>
                    )}
                  </div>
                </div>
                {strokes !== null && toPar !== null && (
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${toPar <= -2 ? 'text-amber-400' : toPar === -1 ? 'text-red-400' : toPar === 0 ? 'text-white' : toPar === 1 ? 'text-blue-400' : 'text-purple-400'}`}>
                    {scoreLabel(toPar)}
                  </span>
                )}
              </div>

              {/* Score control */}
              {inputMode === 'tap' ? (
                <TapControl
                  strokes={strokes ?? holePar}
                  toPar={toPar}
                  onChange={v => setScore(player.playerId, currentHole, v)}
                />
              ) : (
                <div className="flex items-center justify-center">
                  <input
                    ref={el => { if (el) inputRefs.current.set(`${player.playerId}-${currentHole}`, el); else inputRefs.current.delete(`${player.playerId}-${currentHole}`); }}
                    type="number" min={1} max={20}
                    value={strokes ?? ''}
                    onChange={e => { const n = parseInt(e.target.value, 10); if (!isNaN(n) && n >= 1 && n <= 20) setScore(player.playerId, currentHole, n); }}
                    onFocus={e => e.target.select()}
                    placeholder={String(holePar)}
                    className="w-20 h-14 text-center text-2xl font-bold bg-black/30 border border-white/20 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-primary/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Navigation */}
      <div className="border-t border-white/5 bg-card/60 backdrop-blur-xl px-4 py-4 sticky bottom-0">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <button
            onClick={onPrev}
            disabled={currentHole === 1}
            className="flex items-center gap-1.5 px-4 py-3 rounded-xl border border-white/10 bg-white/5 text-white hover:bg-white/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <Button
            onClick={onNext}
            disabled={saving || !allFilled}
            className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold h-12 rounded-xl text-base"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> :
              currentHole >= totalHoles ? (
                <span className="flex items-center gap-2"><CheckCircle2 className="w-5 h-5" /> Review & Submit</span>
              ) : (
                <span className="flex items-center gap-2">Next: Hole {currentHole + 1} <ChevronRight className="w-5 h-5" /></span>
              )}
          </Button>
        </div>
        {!allFilled && inputMode === 'tap' && (
          <p className="text-center text-xs text-muted-foreground mt-2">Adjust scores to auto-advance, or tap Next</p>
        )}
        {allFilled && inputMode === 'tap' && currentHole < totalHoles && (
          <p className="text-center text-xs text-primary/70 mt-2 animate-pulse">All scored — advancing in a moment…</p>
        )}
      </div>
    </div>
  );
}

/* ─── Tap Control — +/- buttons ──────────────────────────────────── */
function TapControl({ strokes, toPar, onChange }: { strokes: number; toPar: number | null; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-4">
      <button
        onClick={() => onChange(Math.max(1, strokes - 1))}
        className="w-14 h-14 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 transition-all flex items-center justify-center text-white text-2xl font-bold select-none"
      >
        −
      </button>
      <div className={`w-20 h-20 rounded-2xl flex flex-col items-center justify-center transition-all ${cellBg(toPar)}`}>
        <span className="text-white font-display font-bold text-3xl">{strokes}</span>
        {toPar !== null && (
          <span className={`text-[10px] font-semibold ${toPar < 0 ? 'text-red-400' : toPar > 0 ? 'text-blue-400' : 'text-muted-foreground'}`}>
            {toPar === 0 ? 'Par' : toPar > 0 ? `+${toPar}` : toPar}
          </span>
        )}
      </div>
      <button
        onClick={() => onChange(Math.min(20, strokes + 1))}
        className="w-14 h-14 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 transition-all flex items-center justify-center text-white text-2xl font-bold select-none"
      >
        +
      </button>
    </div>
  );
}

/* ─── Round Review ────────────────────────────────────────────────── */
function RoundReview({ group, holes, scores, getScore, getPlayerTotal, saving, onBack, onSubmit }: {
  group: TeeTimeGroup; holes: HolePar[]; scores: ScoreMap;
  getScore: (p: number, h: number) => number | null;
  getPlayerTotal: (p: number) => { total: number | null; toPar: number | null };
  saving: boolean; onBack: () => void; onSubmit: () => void;
}) {
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-muted-foreground hover:text-white transition-colors">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div>
          <h2 className="text-white font-display font-bold text-xl">Review Round</h2>
          <p className="text-muted-foreground text-sm">Check scores before submitting</p>
        </div>
      </div>

      {group.players.map(player => {
        const { total, toPar } = getPlayerTotal(player.playerId);
        return (
          <div key={player.playerId} className="bg-card border border-white/10 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-primary text-xs font-bold">
                  {player.firstName[0]}{player.lastName[0]}
                </div>
                <span className="text-white font-semibold text-sm">{player.firstName} {player.lastName}</span>
              </div>
              <div className="flex items-center gap-2">
                {total !== null && <span className="text-white font-bold">{total}</span>}
                {toPar !== null && (
                  <span className={`text-sm font-semibold ${toPar < 0 ? 'text-green-400' : toPar > 0 ? 'text-red-400' : 'text-muted-foreground'}`}>
                    {toPar === 0 ? 'E' : toPar > 0 ? `+${toPar}` : toPar}
                  </span>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/5">
                    {holes.slice(0, 9).map(h => (
                      <th key={h.holeNumber} className="py-1.5 px-1 text-center text-muted-foreground font-medium">{h.holeNumber}</th>
                    ))}
                    {holes.length > 9 && <th className="py-1.5 px-1 text-center text-muted-foreground font-medium border-l border-white/5">OUT</th>}
                    {holes.slice(9).map(h => (
                      <th key={h.holeNumber} className="py-1.5 px-1 text-center text-muted-foreground font-medium">{h.holeNumber}</th>
                    ))}
                    {holes.length > 9 && <th className="py-1.5 px-1 text-center text-muted-foreground font-medium border-l border-white/5">IN</th>}
                    <th className="py-1.5 px-2 text-center text-muted-foreground font-medium border-l border-white/5">TOT</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {holes.slice(0, 9).map(h => {
                      const s = getScore(player.playerId, h.holeNumber);
                      const tp = s !== null ? s - h.par : null;
                      return (
                        <td key={h.holeNumber} className="py-2 px-1 text-center">
                          <span className={`inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold ${tp !== null ? cellBg(tp) : ''} text-white`}>
                            {s ?? '—'}
                          </span>
                        </td>
                      );
                    })}
                    {holes.length > 9 && (
                      <td className="py-2 px-1 text-center border-l border-white/5 font-semibold text-white/70">
                        {holes.slice(0, 9).reduce((s, h) => s + (getScore(player.playerId, h.holeNumber) ?? 0), 0) || '—'}
                      </td>
                    )}
                    {holes.slice(9).map(h => {
                      const s = getScore(player.playerId, h.holeNumber);
                      const tp = s !== null ? s - h.par : null;
                      return (
                        <td key={h.holeNumber} className="py-2 px-1 text-center">
                          <span className={`inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold ${tp !== null ? cellBg(tp) : ''} text-white`}>
                            {s ?? '—'}
                          </span>
                        </td>
                      );
                    })}
                    {holes.length > 9 && (
                      <td className="py-2 px-1 text-center border-l border-white/5 font-semibold text-white/70">
                        {holes.slice(9).reduce((s, h) => s + (getScore(player.playerId, h.holeNumber) ?? 0), 0) || '—'}
                      </td>
                    )}
                    <td className="py-2 px-2 text-center border-l border-white/5 font-bold text-white">{total ?? '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <Button
        onClick={onSubmit}
        disabled={saving}
        className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold h-14 rounded-xl text-base mt-2"
      >
        {saving ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <span className="flex items-center gap-2"><CheckCircle2 className="w-5 h-5" /> Submit & Verify Round</span>
        )}
      </Button>
      <p className="text-center text-xs text-muted-foreground">Submitting confirms all scores are correct and notifies players.</p>
    </div>
  );
}

/* ─── Submitted Screen ────────────────────────────────────────────── */
function SubmittedScreen({ group, onNewGroup }: { group: TeeTimeGroup | null; onNewGroup: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center space-y-6">
      <div className="w-20 h-20 rounded-full bg-green-500/20 border-2 border-green-500/40 flex items-center justify-center">
        <Trophy className="w-10 h-10 text-green-400" />
      </div>
      <div>
        <h2 className="font-display font-bold text-2xl text-white mb-2">Round Submitted!</h2>
        <p className="text-muted-foreground text-sm">
          Scores for {group?.players.map(p => p.firstName).join(', ')} have been verified and players notified.
        </p>
      </div>
      <Button onClick={onNewGroup} className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 h-12 rounded-xl font-semibold">
        Score Another Group
      </Button>
    </div>
  );
}
