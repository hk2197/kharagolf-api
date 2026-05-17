import { useState, useEffect, useCallback, useRef } from 'react';
import { useGetMe, type AuthUser } from '@workspace/api-client-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Trophy, Users, Star, Play, Shuffle, ChevronRight, Plus, Copy, Check,
  RefreshCw, Crown, Target, Zap, Shield, Clock, Lock, ArrowUp, ArrowDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FantasyLeague {
  id: number;
  name: string;
  description?: string;
  status: 'setup' | 'drafting' | 'active' | 'completed';
  format: 'overall_standings' | 'head_to_head';
  draftType: 'snake' | 'simultaneous';
  rosterSize: number;
  maxTeams?: number;
  draftDeadlineAt?: string;
  rosterLockAt?: string;
  inviteCode?: string;
  tournamentId?: number;
  leagueId?: number;
  teamCount: number;
  createdAt: string;
}

interface FantasyTeam {
  id: number;
  name: string;
  draftOrder?: number;
  totalFantasyPoints: number;
  position?: number;
  userId?: number;
  displayName?: string;
  username?: string;
  profileImage?: string;
  roster?: RosterPlayer[];
}

interface RosterPlayer {
  playerId: number;
  fantasyPoints: number;
  pointsBreakdown: Record<string, number>;
  playerFirstName: string;
  playerLastName: string;
}

interface DraftPick {
  id: number;
  fantasyTeamId: number;
  playerId: number;
  pickNumber: number;
  round: number;
  playerFirstName: string;
  playerLastName: string;
  playerHandicap?: string;
}

interface ScoringRule {
  id: number;
  event: string;
  points: number;
}

interface AvailablePlayer {
  id: number;
  firstName: string;
  lastName: string;
  handicapIndex?: string;
  flight?: string;
  checkedIn: boolean;
}

interface FantasyLeagueDetail extends FantasyLeague {
  teams: FantasyTeam[];
  scoringRules: ScoringRule[];
  picks: DraftPick[];
  standings: Array<{
    fantasyTeamId: number;
    playerId: number;
    fantasyPoints: number;
    pointsBreakdown: Record<string, number>;
    playerFirstName: string;
    playerLastName: string;
  }>;
  matchups: Array<{
    id: number;
    round: number;
    homeTeamId: number;
    awayTeamId: number;
    homePoints: number;
    awayPoints: number;
    winnerId?: number;
    isCompleted: boolean;
  }>;
}

interface Tournament {
  id: number;
  name: string;
  status: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  setup: { label: 'SETUP', className: 'bg-gray-500/20 text-gray-300 border-gray-500/30' },
  drafting: { label: 'DRAFTING', className: 'bg-amber-500/20 text-amber-300 border-amber-500/30 animate-pulse' },
  active: { label: 'LIVE', className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30 animate-pulse' },
  completed: { label: 'FINISHED', className: 'bg-slate-500/20 text-slate-300 border-slate-500/30' },
};

const EVENT_LABELS: Record<string, string> = {
  hole_in_one: 'Hole in One',
  eagle: 'Eagle',
  birdie: 'Birdie',
  par: 'Par',
  bogey: 'Bogey',
  double_bogey: 'Double Bogey',
  triple_bogey_plus: 'Triple Bogey+',
  finish_1st: '1st Place Finish',
  finish_2nd: '2nd Place Finish',
  finish_3rd: '3rd Place Finish',
  finish_top5: 'Top 5 Finish',
  finish_top10: 'Top 10 Finish',
  under_par_round: 'Under Par Round',
  par_round: 'Par Round',
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useFantasyLeagues(orgId: number | undefined) {
  const [leagues, setLeagues] = useState<FantasyLeague[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!orgId) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/fantasy`);
      if (res.ok) setLeagues(await res.json());
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => { refetch(); }, [refetch]);
  return { leagues, isLoading, refetch };
}

function useFantasyLeagueDetail(orgId: number | undefined, leagueId: number | null) {
  const [detail, setDetail] = useState<FantasyLeagueDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!orgId || !leagueId) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/fantasy/${leagueId}`);
      if (res.ok) setDetail(await res.json());
    } finally {
      setIsLoading(false);
    }
  }, [orgId, leagueId]);

  useEffect(() => { refetch(); }, [refetch]);
  return { detail, isLoading, refetch };
}

// ─── Create League Dialog ─────────────────────────────────────────────────────

function CreateFantasyLeagueDialog({
  orgId, tournaments, onCreated,
}: {
  orgId: number; tournaments: Tournament[]; onCreated: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: '', description: '', tournamentId: '', format: 'overall_standings',
    draftType: 'snake', rosterSize: '5', maxTeams: '',
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.tournamentId) {
      toast({ title: 'Missing fields', description: 'Name and tournament are required.', variant: 'destructive' });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/fantasy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          description: form.description || undefined,
          tournamentId: parseInt(form.tournamentId),
          format: form.format,
          draftType: form.draftType,
          rosterSize: parseInt(form.rosterSize) || 5,
          maxTeams: form.maxTeams ? parseInt(form.maxTeams) : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? 'Failed to create fantasy league');
      }
      toast({ title: 'Fantasy league created!', description: form.name });
      setOpen(false);
      setForm({ name: '', description: '', tournamentId: '', format: 'overall_standings', draftType: 'snake', rosterSize: '5', maxTeams: '' });
      onCreated();
    } catch (err) {
      toast({ title: 'Error', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} className="gap-2">
        <Plus className="w-4 h-4" />
        Create Fantasy League
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trophy className="w-5 h-5 text-primary" />
              Create Fantasy League
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">League Name *</label>
              <Input
                placeholder="e.g. Club Championship Fantasy 2025"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">Description</label>
              <Input
                placeholder="Optional description..."
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">Linked Tournament *</label>
              <Select value={form.tournamentId} onValueChange={v => setForm(f => ({ ...f, tournamentId: v }))}>
                <SelectTrigger><SelectValue placeholder="Select tournament..." /></SelectTrigger>
                <SelectContent>
                  {tournaments.map(t => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-1 block">Format</label>
                <Select value={form.format} onValueChange={v => setForm(f => ({ ...f, format: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="overall_standings">Overall Standings</SelectItem>
                    <SelectItem value="head_to_head">Head-to-Head</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-1 block">Draft Type</label>
                <Select value={form.draftType} onValueChange={v => setForm(f => ({ ...f, draftType: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="snake">Snake Draft</SelectItem>
                    <SelectItem value="simultaneous">Simultaneous</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-1 block">Roster Size</label>
                <Input
                  type="number" min="1" max="18"
                  value={form.rosterSize}
                  onChange={e => setForm(f => ({ ...f, rosterSize: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-1 block">Max Teams (optional)</label>
                <Input
                  type="number" min="2"
                  placeholder="No limit"
                  value={form.maxTeams}
                  onChange={e => setForm(f => ({ ...f, maxTeams: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} className="flex-1">Cancel</Button>
              <Button type="submit" disabled={loading} className="flex-1">
                {loading ? 'Creating...' : 'Create League'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Fantasy League Card ──────────────────────────────────────────────────────

function FantasyLeagueCard({ league, onSelect }: { league: FantasyLeague; onSelect: () => void }) {
  const statusCfg = STATUS_CONFIG[league.status] ?? STATUS_CONFIG.setup;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card border border-border rounded-xl overflow-hidden hover:border-primary/40 transition-colors cursor-pointer group"
      onClick={onSelect}
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={statusCfg.className}>{statusCfg.label}</Badge>
            <Badge variant="outline" className="text-xs border-border text-muted-foreground">
              {league.format === 'head_to_head' ? 'H2H' : 'Standings'}
            </Badge>
            <Badge variant="outline" className="text-xs border-border text-muted-foreground capitalize">
              {league.draftType.replace('_', ' ')} Draft
            </Badge>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 group-hover:text-primary transition-colors mt-0.5" />
        </div>
        <h3 className="font-semibold text-foreground text-lg mb-1">{league.name}</h3>
        {league.description && (
          <p className="text-sm text-muted-foreground mb-3 line-clamp-2">{league.description}</p>
        )}
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" />
            {league.teamCount} team{league.teamCount !== 1 ? 's' : ''}
          </span>
          <span className="flex items-center gap-1.5">
            <Star className="w-3.5 h-3.5" />
            {league.rosterSize} per roster
          </span>
          {league.maxTeams && (
            <span className="flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" />
              Max {league.maxTeams}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Leaderboard View ─────────────────────────────────────────────────────────

function FantasyLeaderboard({ detail }: { detail: FantasyLeagueDetail }) {
  const standingsByTeam = new Map<number, RosterPlayer[]>();
  for (const s of detail.standings) {
    if (!standingsByTeam.has(s.fantasyTeamId)) standingsByTeam.set(s.fantasyTeamId, []);
    standingsByTeam.get(s.fantasyTeamId)!.push(s as RosterPlayer);
  }

  return (
    <div className="space-y-3">
      {detail.teams.map((team, idx) => {
        const roster = standingsByTeam.get(team.id) ?? [];
        const pos = team.position ?? idx + 1;
        const posIcon = pos === 1 ? <Crown className="w-4 h-4 text-yellow-400" /> :
          pos === 2 ? <Trophy className="w-4 h-4 text-slate-300" /> :
          pos === 3 ? <Trophy className="w-4 h-4 text-amber-600" /> : null;

        return (
          <motion.div
            key={team.id}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: idx * 0.05 }}
            className={`bg-card border rounded-xl p-4 ${pos === 1 ? 'border-yellow-500/30 bg-yellow-500/5' : 'border-border'}`}
          >
            <div className="flex items-center gap-4">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg shrink-0
                ${pos === 1 ? 'bg-yellow-500/20 text-yellow-400' :
                  pos === 2 ? 'bg-slate-500/20 text-slate-300' :
                  pos === 3 ? 'bg-amber-700/20 text-amber-600' :
                  'bg-muted text-muted-foreground'}`}
              >
                {posIcon ?? pos}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground">{team.name}</span>
                  {team.displayName && (
                    <span className="text-xs text-muted-foreground">({team.displayName})</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  {roster.slice(0, 5).map(r => (
                    <span key={r.playerId} className="text-xs text-muted-foreground">
                      {r.playerFirstName} {r.playerLastName}
                      {r.fantasyPoints !== 0 && (
                        <span className={`ml-1 font-medium ${r.fantasyPoints > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {r.fantasyPoints > 0 ? '+' : ''}{r.fantasyPoints}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-2xl font-bold text-primary">{team.totalFantasyPoints}</div>
                <div className="text-xs text-muted-foreground">pts</div>
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── Draft Board ──────────────────────────────────────────────────────────────

function DraftBoard({
  orgId, detail, onPick, onStartDraft, isAdmin,
  currentUserId,
}: {
  orgId: number;
  detail: FantasyLeagueDetail;
  onPick: () => void;
  onStartDraft: () => void;
  isAdmin: boolean;
  currentUserId?: number;
}) {
  const { toast } = useToast();
  const [availablePlayers, setAvailablePlayers] = useState<AvailablePlayer[]>([]);
  const [pickLoading, setPickLoading] = useState(false);
  const [search, setSearch] = useState('');

  const loadAvailable = useCallback(async () => {
    const res = await fetch(`/api/organizations/${orgId}/fantasy/${detail.id}/available-players`);
    if (res.ok) setAvailablePlayers(await res.json());
  }, [orgId, detail.id]);

  useEffect(() => { loadAvailable(); }, [loadAvailable]);

  const myTeam = detail.teams.find(t => t.userId === currentUserId);

  // Compute whose turn it is (snake draft)
  const numTeams = detail.teams.length;
  const totalPicks = detail.picks.length;
  const maxPicks = detail.rosterSize * numTeams;
  const isDraftComplete = totalPicks >= maxPicks;

  let currentTeamId: number | null = null;
  if (!isDraftComplete && detail.status === 'drafting' && detail.draftType === 'snake') {
    const sortedTeams = [...detail.teams].sort((a, b) => (a.draftOrder ?? 99) - (b.draftOrder ?? 99));
    const draftRound = Math.floor(totalPicks / numTeams);
    const pickInRound = totalPicks % numTeams;
    const isEven = draftRound % 2 === 0;
    const idx = isEven ? pickInRound : (numTeams - 1 - pickInRound);
    currentTeamId = sortedTeams[idx]?.id ?? null;
  }

  const isMyTurn = myTeam?.id === currentTeamId;

  const filtered = availablePlayers.filter(p =>
    `${p.firstName} ${p.lastName}`.toLowerCase().includes(search.toLowerCase()),
  );

  async function handlePick(playerId: number) {
    setPickLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/fantasy/${detail.id}/pick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? 'Failed to make pick');
      }
      toast({ title: 'Pick made!', description: 'Your player has been drafted.' });
      onPick();
      loadAvailable();
    } catch (err) {
      toast({ title: 'Error', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setPickLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Draft status */}
      {detail.status === 'setup' && isAdmin && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
          <p className="text-amber-300 text-sm mb-3">
            The draft hasn't started yet. Once at least 2 teams have joined, you can start the draft.
            Draft order will be assigned randomly.
          </p>
          <Button
            onClick={onStartDraft}
            disabled={detail.teams.length < 2}
            className="gap-2 bg-amber-600 hover:bg-amber-700"
          >
            <Shuffle className="w-4 h-4" />
            Start Draft ({detail.teams.length} teams)
          </Button>
        </div>
      )}

      {detail.status === 'drafting' && (
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-foreground">Draft Progress</h3>
            <span className="text-sm text-muted-foreground">
              Pick {totalPicks + 1} of {maxPicks}
            </span>
          </div>

          {/* Current turn indicator */}
          {currentTeamId && !isDraftComplete && (
            <div className={`mb-4 p-3 rounded-lg ${isMyTurn ? 'bg-primary/20 border border-primary/50' : 'bg-muted/20 border border-border'}`}>
              <div className="flex items-center gap-2">
                {isMyTurn ? (
                  <>
                    <Zap className="w-4 h-4 text-primary" />
                    <span className="text-primary font-medium">It's your turn to pick!</span>
                  </>
                ) : (
                  <>
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      Waiting for {detail.teams.find(t => t.id === currentTeamId)?.name ?? 'another team'} to pick...
                    </span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Pick list */}
          <div className="space-y-1 text-sm text-muted-foreground max-h-32 overflow-y-auto mb-4">
            {detail.picks.map(pick => (
              <div key={pick.id} className="flex items-center justify-between py-0.5">
                <span className="text-primary font-medium">#{pick.pickNumber}</span>
                <span>{detail.teams.find(t => t.id === pick.fantasyTeamId)?.name}</span>
                <span>{pick.playerFirstName} {pick.playerLastName}</span>
              </div>
            ))}
          </div>

          {/* Available player picker */}
          {(isMyTurn || (detail.draftType === 'simultaneous' && myTeam)) && !isDraftComplete && (
            <div>
              <Input
                placeholder="Search players..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="mb-3"
              />
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {filtered.map(p => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/30 transition-colors"
                  >
                    <div>
                      <span className="font-medium text-foreground">{p.firstName} {p.lastName}</span>
                      {p.handicapIndex && (
                        <span className="ml-2 text-xs text-muted-foreground">HCP {p.handicapIndex}</span>
                      )}
                      {p.flight && (
                        <span className="ml-2 text-xs text-muted-foreground">Flight {p.flight}</span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      disabled={pickLoading}
                      onClick={() => handlePick(p.id)}
                      className="text-xs"
                    >
                      Draft
                    </Button>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <p className="text-center text-muted-foreground py-4 text-sm">No available players</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Teams & rosters */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {detail.teams
          .sort((a, b) => (a.draftOrder ?? 99) - (b.draftOrder ?? 99))
          .map(team => {
            const teamPicks = detail.picks.filter(p => p.fantasyTeamId === team.id);
            return (
              <div key={team.id} className={`bg-card border rounded-xl p-4 ${team.userId === currentUserId ? 'border-primary/40' : 'border-border'}`}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="font-semibold text-foreground">{team.name}</h4>
                    {team.displayName && (
                      <p className="text-xs text-muted-foreground">{team.displayName}</p>
                    )}
                  </div>
                  {team.draftOrder && (
                    <Badge variant="outline" className="text-xs">
                      Draft #{team.draftOrder}
                    </Badge>
                  )}
                </div>
                <div className="space-y-1">
                  {teamPicks.map(pick => (
                    <div key={pick.id} className="flex items-center gap-2 text-sm">
                      <span className="w-4 text-xs text-muted-foreground">{teamPicks.indexOf(pick) + 1}.</span>
                      <span className="text-foreground">{pick.playerFirstName} {pick.playerLastName}</span>
                      {pick.playerHandicap && (
                        <span className="text-xs text-muted-foreground ml-auto">HCP {pick.playerHandicap}</span>
                      )}
                    </div>
                  ))}
                  {teamPicks.length < detail.rosterSize && detail.status === 'drafting' && (
                    <div className="text-xs text-muted-foreground italic">
                      {detail.rosterSize - teamPicks.length} picks remaining
                    </div>
                  )}
                  {teamPicks.length === 0 && detail.status !== 'drafting' && (
                    <p className="text-xs text-muted-foreground italic">No picks yet</p>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

// ─── Scoring Rules Editor ─────────────────────────────────────────────────────

function ScoringRulesEditor({
  orgId, detail, onSaved,
}: {
  orgId: number; detail: FantasyLeagueDetail; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [rules, setRules] = useState<ScoringRule[]>(detail.scoringRules);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/fantasy/${detail.id}/scoring-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      if (!res.ok) throw new Error('Failed to save rules');
      toast({ title: 'Scoring rules saved!' });
      onSaved();
    } catch (err) {
      toast({ title: 'Error', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {rules.map((rule, idx) => (
          <div key={rule.event} className="flex items-center justify-between bg-card border border-border rounded-lg px-3 py-2">
            <label className="text-sm text-foreground">{EVENT_LABELS[rule.event] ?? rule.event}</label>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost" size="sm"
                onClick={() => setRules(rs => rs.map((r, i) => i === idx ? { ...r, points: r.points - 1 } : r))}
                className="h-6 w-6 p-0"
              >
                <ArrowDown className="w-3 h-3" />
              </Button>
              <span className={`text-sm font-bold w-6 text-center ${rule.points > 0 ? 'text-emerald-400' : rule.points < 0 ? 'text-red-400' : 'text-muted-foreground'}`}>
                {rule.points > 0 ? '+' : ''}{rule.points}
              </span>
              <Button
                variant="ghost" size="sm"
                onClick={() => setRules(rs => rs.map((r, i) => i === idx ? { ...r, points: r.points + 1 } : r))}
                className="h-6 w-6 p-0"
              >
                <ArrowUp className="w-3 h-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Button onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save Scoring Rules'}
      </Button>
    </div>
  );
}

// ─── League Detail View ───────────────────────────────────────────────────────

type DetailTab = 'leaderboard' | 'draft' | 'scoring' | 'matchups';

function FantasyLeagueDetail({
  orgId, leagueId, onBack, isAdmin, currentUserId,
}: {
  orgId: number; leagueId: number; onBack: () => void; isAdmin: boolean; currentUserId?: number;
}) {
  const { toast } = useToast();
  const { detail, isLoading, refetch } = useFantasyLeagueDetail(orgId, leagueId);
  const [tab, setTab] = useState<DetailTab>('leaderboard');
  const [copied, setCopied] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // SSE: subscribe to live fantasy updates
  useEffect(() => {
    if (!detail?.id) return;
    const es = new EventSource(`/api/sse/fantasy/${detail.id}`);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as { type: string };
        if (msg.type === 'fantasy_update') {
          refetch();
        }
      } catch { /* ignore */ }
    };
    return () => { es.close(); };
  }, [detail?.id, refetch]);

  async function handleStartDraft() {
    const res = await fetch(`/api/organizations/${orgId}/fantasy/${leagueId}/start-draft`, {
      method: 'POST',
    });
    if (res.ok) {
      toast({ title: 'Draft started!' });
      refetch();
    } else {
      const err = await res.json().catch(() => ({})) as { error?: string };
      toast({ title: 'Error', description: err.error ?? 'Failed to start draft', variant: 'destructive' });
    }
  }

  async function handleRecalc() {
    await fetch(`/api/organizations/${orgId}/fantasy/${leagueId}/recalc`, { method: 'POST' });
    toast({ title: 'Points recalculated' });
    refetch();
  }

  function copyInviteCode() {
    if (detail?.inviteCode) {
      navigator.clipboard.writeText(detail.inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }
  if (!detail) return null;

  const statusCfg = STATUS_CONFIG[detail.status] ?? STATUS_CONFIG.setup;

  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'leaderboard', label: 'Leaderboard' },
    { id: 'draft', label: 'Draft' },
    { id: 'scoring', label: 'Scoring Rules' },
    ...(detail.format === 'head_to_head' ? [{ id: 'matchups' as DetailTab, label: 'Matchups' }] : []),
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button
            onClick={onBack}
            className="text-sm text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1"
          >
            ← Back to Fantasy Leagues
          </button>
          <h2 className="text-2xl font-bold text-foreground">{detail.name}</h2>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <Badge variant="outline" className={statusCfg.className}>{statusCfg.label}</Badge>
            <Badge variant="outline" className="text-xs border-border text-muted-foreground">
              {detail.format === 'head_to_head' ? 'Head-to-Head' : 'Overall Standings'}
            </Badge>
            <Badge variant="outline" className="text-xs border-border text-muted-foreground capitalize">
              {detail.draftType.replace('_', ' ')} Draft
            </Badge>
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <Users className="w-3.5 h-3.5" /> {detail.teams.length} teams
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {detail.inviteCode && (
            <Button variant="outline" size="sm" onClick={copyInviteCode} className="gap-2">
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {detail.inviteCode}
            </Button>
          )}
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={handleRecalc} className="gap-2">
              <RefreshCw className="w-3.5 h-3.5" />
              Recalc
            </Button>
          )}
        </div>
      </div>

      {/* Tab navigation */}
      <div className="flex border-b border-border">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
        >
          {tab === 'leaderboard' && <FantasyLeaderboard detail={detail} />}
          {tab === 'draft' && (
            <DraftBoard
              orgId={orgId}
              detail={detail}
              onPick={refetch}
              onStartDraft={handleStartDraft}
              isAdmin={isAdmin}
              currentUserId={currentUserId}
            />
          )}
          {tab === 'scoring' && isAdmin && (
            <ScoringRulesEditor orgId={orgId} detail={detail} onSaved={refetch} />
          )}
          {tab === 'scoring' && !isAdmin && (
            <div className="space-y-3">
              {detail.scoringRules.map(rule => (
                <div key={rule.event} className="flex items-center justify-between bg-card border border-border rounded-lg px-4 py-2">
                  <span className="text-sm text-foreground">{EVENT_LABELS[rule.event] ?? rule.event}</span>
                  <span className={`text-sm font-bold ${rule.points > 0 ? 'text-emerald-400' : rule.points < 0 ? 'text-red-400' : 'text-muted-foreground'}`}>
                    {rule.points > 0 ? '+' : ''}{rule.points} pts
                  </span>
                </div>
              ))}
            </div>
          )}
          {tab === 'matchups' && (
            <div className="space-y-3">
              {detail.matchups.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  Matchups will be generated when the draft completes.
                </p>
              ) : (
                detail.matchups.map(m => {
                  const home = detail.teams.find(t => t.id === m.homeTeamId);
                  const away = detail.teams.find(t => t.id === m.awayTeamId);
                  return (
                    <div key={m.id} className="bg-card border border-border rounded-xl p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-center flex-1">
                          <p className="font-semibold text-foreground">{home?.name ?? 'Team'}</p>
                          <p className="text-2xl font-bold text-primary">{m.homePoints}</p>
                        </div>
                        <div className="text-center px-4">
                          <span className="text-xs text-muted-foreground uppercase tracking-wider">vs</span>
                          {m.isCompleted && (
                            <div className="mt-1">
                              <Badge variant="outline" className="text-xs">
                                {m.winnerId ? 'Complete' : 'Draw'}
                              </Badge>
                            </div>
                          )}
                        </div>
                        <div className="text-center flex-1">
                          <p className="font-semibold text-foreground">{away?.name ?? 'Team'}</p>
                          <p className="text-2xl font-bold text-primary">{m.awayPoints}</p>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ─── Join Fantasy League ──────────────────────────────────────────────────────

function JoinFantasyDialog({
  orgId, leagues, onJoined,
}: {
  orgId: number; leagues: FantasyLeague[]; onJoined: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ leagueId: '', teamName: '', inviteCode: '' });

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!form.leagueId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/fantasy/${form.leagueId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamName: form.teamName || undefined, inviteCode: form.inviteCode || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? 'Failed to join');
      }
      toast({ title: 'Joined!', description: 'Your team has been created.' });
      setOpen(false);
      onJoined();
    } catch (err) {
      toast({ title: 'Error', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} className="gap-2">
        <Users className="w-4 h-4" />
        Join a League
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle>Join Fantasy League</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">Select League</label>
              <Select value={form.leagueId} onValueChange={v => setForm(f => ({ ...f, leagueId: v }))}>
                <SelectTrigger><SelectValue placeholder="Choose a league..." /></SelectTrigger>
                <SelectContent>
                  {leagues.filter(l => l.status === 'setup' || l.status === 'drafting').map(l => (
                    <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">Team Name (optional)</label>
              <Input
                placeholder="My Team"
                value={form.teamName}
                onChange={e => setForm(f => ({ ...f, teamName: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">Invite Code (if required)</label>
              <Input
                placeholder="XXXXX"
                value={form.inviteCode}
                onChange={e => setForm(f => ({ ...f, inviteCode: e.target.value.toUpperCase() }))}
                className="font-mono"
              />
            </div>
            <div className="flex gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} className="flex-1">Cancel</Button>
              <Button type="submit" disabled={loading || !form.leagueId} className="flex-1">
                {loading ? 'Joining...' : 'Join League'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function FantasyPage() {
  const { data: user } = useGetMe();
  const typedUser = user as AuthUser | undefined;
  const orgId = typedUser?.organizationId ?? undefined;
  const isAdmin = ['super_admin', 'org_admin', 'tournament_director'].includes(typedUser?.role ?? '');
  const currentUserId = typedUser?.id;

  const { leagues, isLoading, refetch } = useFantasyLeagues(orgId);
  const [selectedLeagueId, setSelectedLeagueId] = useState<number | null>(null);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/organizations/${orgId}/tournaments`)
      .then(r => r.ok ? r.json() : [])
      .then((ts: Tournament[]) => setTournaments(ts))
      .catch(() => {});
  }, [orgId]);

  if (selectedLeagueId) {
    return (
      <FantasyLeagueDetail
        orgId={orgId!}
        leagueId={selectedLeagueId}
        onBack={() => setSelectedLeagueId(null)}
        isAdmin={isAdmin}
        currentUserId={currentUserId}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Trophy className="w-7 h-7 text-primary" />
            Fantasy Golf
          </h1>
          <p className="text-muted-foreground mt-1">
            Draft real club players and earn fantasy points based on their actual tournament performance.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <JoinFantasyDialog orgId={orgId!} leagues={leagues} onJoined={refetch} />
          {isAdmin && (
            <CreateFantasyLeagueDialog
              orgId={orgId!}
              tournaments={tournaments}
              onCreated={refetch}
            />
          )}
        </div>
      </div>

      {/* League list */}
      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <RefreshCw className="w-6 h-6 text-primary animate-spin" />
        </div>
      ) : leagues.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-center">
          <Trophy className="w-16 h-16 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-semibold text-muted-foreground">No Fantasy Leagues Yet</h3>
          <p className="text-sm text-muted-foreground/70 mt-1 max-w-md">
            {isAdmin
              ? 'Create the first fantasy league for your club members to compete in.'
              : 'No fantasy leagues have been created yet. Check back soon!'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {leagues.map(league => (
            <FantasyLeagueCard
              key={league.id}
              league={league}
              onSelect={() => setSelectedLeagueId(league.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
