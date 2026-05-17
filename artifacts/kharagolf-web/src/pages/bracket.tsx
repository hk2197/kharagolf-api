import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Trophy, Users, Plus, RefreshCw, CheckCircle, Shield, Shuffle, GitBranch, ArrowRight, X, ChevronRight, Share2, Radio } from "lucide-react";
import { useActiveOrgId } from "@/context/ActiveOrgContext";
import { RoundRobinStandings } from "@/components/RoundRobinStandings";

const API = "/api";

function apiFetch(path: string, opts?: RequestInit) {
  return fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
}

type Player = {
  id: number;
  firstName: string;
  lastName: string;
  handicapIndex?: string | null;
};

type BracketMatch = {
  id: number;
  roundId: number;
  matchNumber: number;
  bracketType: string;
  player1Id?: number | null;
  player2Id?: number | null;
  player1IsBye: boolean;
  player2IsBye: boolean;
  result: string;
  winnerId?: number | null;
  holeResults?: Record<string, string>;
  matchStatus?: string | null;
  player1?: Player | null;
  player2?: Player | null;
  winner?: Player | null;
};

type BracketRound = {
  id: number;
  roundNumber: number;
  name: string;
  bracketType: string;
};

type Bracket = {
  id: number;
  tournamentId: number;
  seedingMethod: string;
  hasConsolation: boolean;
  totalRounds: number;
  drawGeneratedAt?: string | null;
  format?: string;
  tieBreakRule?: string;
  shareToken?: string | null;
};

type BracketData = {
  bracket: Bracket;
  rounds: BracketRound[];
  matches: BracketMatch[];
};

function playerName(p?: Player | null): string {
  if (!p) return "TBD";
  return `${p.firstName} ${p.lastName}`;
}

function groupLosersRoundsByLevel<R extends { name: string }>(rounds: R[]): Array<{ level: number | null; rounds: R[] }> {
  const groups = new Map<number, R[]>();
  const ungrouped: R[] = [];
  for (const r of rounds) {
    const m = r.name.match(/^LB R(\d+)( Minor)?$/);
    if (m) {
      const lvl = Number(m[1]);
      if (!groups.has(lvl)) groups.set(lvl, []);
      groups.get(lvl)!.push(r);
    } else {
      ungrouped.push(r);
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.name.includes("Minor") ? 1 : 0) - (b.name.includes("Minor") ? 1 : 0));
  }
  const result: Array<{ level: number | null; rounds: R[] }> = [];
  for (const lvl of [...groups.keys()].sort((a, b) => a - b)) {
    result.push({ level: lvl, rounds: groups.get(lvl)! });
  }
  if (ungrouped.length) result.push({ level: null, rounds: ungrouped });
  return result;
}

function ResultBadge({ result }: { result: string }) {
  if (result === "pending") return <Badge variant="outline" className="text-xs">In Progress</Badge>;
  if (result === "player1_wins") return <Badge className="bg-emerald-600 text-xs">P1 Wins</Badge>;
  if (result === "player2_wins") return <Badge className="bg-emerald-600 text-xs">P2 Wins</Badge>;
  if (result === "halved") return <Badge className="bg-yellow-600 text-xs">Halved</Badge>;
  if (result === "conceded") return <Badge className="bg-orange-600 text-xs">Conceded</Badge>;
  return <Badge variant="outline" className="text-xs">{result}</Badge>;
}

function MatchCard({
  match,
  onRecord,
}: {
  match: BracketMatch;
  onRecord: (match: BracketMatch) => void;
}) {
  const p1 = match.player1IsBye ? "BYE" : playerName(match.player1);
  const p2 = match.player2IsBye ? "BYE" : playerName(match.player2);
  const isComplete = match.result !== "pending";
  const winner = match.winner ? playerName(match.winner) : null;
  const inPlayoff = (match.matchStatus ?? "").includes("Playoff") || (match.matchStatus ?? "").includes("Sudden Death");

  return (
    <div
      data-match-id={match.id}
      data-testid={`bracket-match-${match.id}`}
      className={`rounded-lg border p-3 bg-white/5 backdrop-blur-sm space-y-2 transition-shadow ${isComplete ? "border-emerald-600/30" : inPlayoff ? "border-amber-500/50" : "border-white/10"}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">Match {match.matchNumber}</span>
        <ResultBadge result={match.result} />
      </div>
      <div className="space-y-1">
        <div className={`text-sm font-medium ${match.winnerId === match.player1Id && match.winnerId ? "text-emerald-400" : "text-white"}`}>
          {p1}
        </div>
        <div className="text-xs text-gray-500">vs</div>
        <div className={`text-sm font-medium ${match.winnerId === match.player2Id && match.winnerId ? "text-emerald-400" : "text-white"}`}>
          {p2}
        </div>
      </div>
      {match.matchStatus && (
        <div className={`text-xs ${inPlayoff ? "text-amber-400 font-medium" : "text-yellow-400"}`}>{match.matchStatus}</div>
      )}
      {!isComplete && (match.player1Id || match.player2Id) && (
        <Button
          variant="outline"
          size="sm"
          className={`w-full text-xs ${inPlayoff ? "border-amber-500/60 text-amber-300 hover:bg-amber-500/10" : ""}`}
          onClick={() => onRecord(match)}
        >
          {inPlayoff ? "Enter Playoff Hole" : "Record Result"}
        </Button>
      )}
      {winner && <div className="text-xs text-emerald-400">Winner: {winner}</div>}
    </div>
  );
}

function RecordResultDialog({
  match,
  bracket,
  open,
  onClose,
  onSubmit,
}: {
  match: BracketMatch | null;
  bracket: Bracket | null | undefined;
  open: boolean;
  onClose: () => void;
  onSubmit: (matchId: number, result: string, holeResults: Record<number, string>, conceeded?: { by: number; hole: number }) => void;
}) {
  const [result, setResult] = useState("player1_wins");
  const [holeResults, setHoleResults] = useState<Record<number, string>>({});
  const [conceededBy, setConceededBy] = useState<string>("");
  const [conceededOnHole, setConceededOnHole] = useState<string>("");

  // Hydrate from existing hole results when (re)opening the dialog so playoff progress persists.
  useEffect(() => {
    if (open && match) {
      const existing: Record<number, string> = {};
      const src = (match.holeResults ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(src)) {
        if (v) existing[Number(k)] = v;
      }
      setHoleResults(existing);
      setResult("player1_wins");
      setConceededBy("");
      setConceededOnHole("");
    }
  }, [open, match]);

  if (!match) return null;

  const p1 = playerName(match.player1);
  const p2 = playerName(match.player2);

  const handleHoleResult = (hole: number, val: string) => {
    setHoleResults(prev => {
      const next = { ...prev };
      if (val) next[hole] = val;
      else delete next[hole];
      return next;
    });
  };

  // Determine playoff context for tied knockout matches.
  const tieBreakRule = (bracket?.tieBreakRule ?? "sudden_death") as "sudden_death" | "extra_holes_3" | "none";
  const knockout = bracket?.format !== "round_robin";
  const playoffEnabled = knockout && tieBreakRule !== "none";
  const reg = (() => {
    let p1c = 0, p2c = 0, played = 0;
    for (let h = 1; h <= 18; h++) {
      const r = holeResults[h];
      if (!r) continue;
      played++;
      if (r === "player1") p1c++;
      else if (r === "player2") p2c++;
    }
    return { p1c, p2c, played, tied18: played === 18 && p1c === p2c };
  })();
  // Show playoff inputs whenever the bracket allows a tie-break AND any of:
  //   - 18 holes have been entered as a tie locally,
  //   - playoff hole entries already exist on the match,
  //   - the server has flagged the match as needing a playoff (matchStatus contains
  //     "Playoff" or "Sudden Death") — this covers the case where an admin reported
  //     halved without entering all 18 hole-by-hole results and got a 409 back.
  const playoffHolesEntered = Object.keys(holeResults).map(Number).filter(h => h > 18).sort((a, b) => a - b);
  const serverFlaggedPlayoff = !!match?.matchStatus &&
    (match.matchStatus.includes("Playoff") || match.matchStatus.includes("Sudden Death"));
  const showPlayoff = playoffEnabled && (reg.tied18 || playoffHolesEntered.length > 0 || serverFlaggedPlayoff);
  // Holes to render in the playoff section
  const playoffHoles: number[] = [];
  if (showPlayoff) {
    if (tieBreakRule === "extra_holes_3") {
      playoffHoles.push(19, 20, 21);
      // Continue with sudden-death holes if 19-21 tied
      let pp1 = 0, pp2 = 0, complete = 0;
      for (const h of [19, 20, 21]) {
        const r = holeResults[h];
        if (!r) continue;
        complete++;
        if (r === "player1") pp1++;
        else if (r === "player2") pp2++;
      }
      if (complete === 3 && pp1 === pp2) {
        // Find next sudden-death hole (22+) plus any already entered
        let h = 22;
        while (holeResults[h]) {
          playoffHoles.push(h);
          if (holeResults[h] === "player1" || holeResults[h] === "player2") break;
          h++;
        }
        if (!holeResults[h]) playoffHoles.push(h);
      }
    } else {
      // sudden_death: render holes 19+ through first decisive entry, plus the next blank hole
      let h = 19;
      while (holeResults[h]) {
        playoffHoles.push(h);
        if (holeResults[h] === "player1" || holeResults[h] === "player2") break;
        h++;
      }
      if (!holeResults[h]) playoffHoles.push(h);
    }
  }

  const handleSubmit = () => {
    const conceededByPlayer = conceededBy ? Number(conceededBy) : undefined;
    const conceededHole = conceededOnHole ? Number(conceededOnHole) : undefined;
    // If we're in a playoff and the user has entered playoff holes, treat as halved at 18 +
    // playoff resolution; the server will coerce the final winner.
    const effectiveResult = showPlayoff && playoffHolesEntered.length > 0 ? "halved" : result;
    onSubmit(
      match.id,
      effectiveResult,
      holeResults,
      conceededByPlayer && conceededHole ? { by: conceededByPlayer, hole: conceededHole } : undefined,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg bg-gray-900 text-white border-white/10">
        <DialogHeader>
          <DialogTitle>Record Match Result</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="text-sm text-gray-300">
            <span className="font-medium text-white">{p1}</span>
            <span className="text-gray-500 mx-2">vs</span>
            <span className="font-medium text-white">{p2}</span>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-gray-400">Match Result</label>
            <Select value={result} onValueChange={setResult}>
              <SelectTrigger className="bg-white/10 border-white/20 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="player1_wins">{p1} Wins</SelectItem>
                <SelectItem value="player2_wins">{p2} Wins</SelectItem>
                <SelectItem value="halved">Halved</SelectItem>
                <SelectItem value="conceded">Conceded</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {result === "conceded" && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-gray-400">Conceded by</label>
                <Select value={conceededBy} onValueChange={setConceededBy}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white text-xs">
                    <SelectValue placeholder="Select player" />
                  </SelectTrigger>
                  <SelectContent>
                    {match.player1Id && <SelectItem value={String(match.player1Id)}>{p1}</SelectItem>}
                    {match.player2Id && <SelectItem value={String(match.player2Id)}>{p2}</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400">On hole</label>
                <input
                  type="number"
                  min={1}
                  max={18}
                  value={conceededOnHole}
                  onChange={e => setConceededOnHole(e.target.value)}
                  className="w-full rounded bg-white/10 border border-white/20 text-white px-2 py-1 text-xs"
                  placeholder="1-18"
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="text-xs text-gray-400">Hole-by-hole results (optional)</div>
            <div className="grid grid-cols-6 gap-1">
              {Array.from({ length: 18 }, (_, i) => i + 1).map(hole => (
                <div key={hole} className="text-center">
                  <div className="text-xs text-gray-500 mb-1">{hole}</div>
                  <Select
                    value={holeResults[hole] || "_empty"}
                    onValueChange={v => handleHoleResult(hole, v === "_empty" ? "" : v)}
                  >
                    <SelectTrigger className="bg-white/10 border-white/20 text-white text-[10px] h-7 px-1">
                      <SelectValue placeholder="-" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_empty">-</SelectItem>
                      <SelectItem value="player1">P1</SelectItem>
                      <SelectItem value="player2">P2</SelectItem>
                      <SelectItem value="halved">H</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          {showPlayoff && (
            <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-amber-300">
                  {tieBreakRule === "extra_holes_3" ? "3-Hole Aggregate Playoff" : "Sudden-Death Playoff"}
                </div>
                <div className="text-[10px] text-amber-300/80">Tied at 18 — enter extra holes</div>
              </div>
              <div className="grid grid-cols-6 gap-1">
                {playoffHoles.map(hole => (
                  <div key={hole} className="text-center">
                    <div className="text-xs text-amber-300/80 mb-1">H{hole}</div>
                    <Select
                      value={holeResults[hole] || "_empty"}
                      onValueChange={v => handleHoleResult(hole, v === "_empty" ? "" : v)}
                    >
                      <SelectTrigger className="bg-amber-500/10 border-amber-500/40 text-white text-[10px] h-7 px-1">
                        <SelectValue placeholder="-" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_empty">-</SelectItem>
                        <SelectItem value="player1">P1</SelectItem>
                        <SelectItem value="player2">P2</SelectItem>
                        <SelectItem value="halved">H</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-amber-200/70">
                The winner is determined automatically once the playoff resolves.
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
            <Button onClick={handleSubmit} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
              {showPlayoff && playoffHolesEntered.length > 0 ? "Save Playoff Result" : "Save Result"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function BracketPage() {
  const { id } = useParams<{ id: string }>();
  const orgId = useActiveOrgId();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [recordMatch, setRecordMatch] = useState<BracketMatch | null>(null);

  const bracketQuery = useQuery<BracketData>({
    queryKey: ["bracket", id, orgId],
    queryFn: async () => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/bracket`);
      if (!res.ok) {
        if (res.status === 404) return { bracket: null, rounds: [], matches: [] } as unknown as BracketData;
        throw new Error("Failed to fetch bracket");
      }
      return res.json();
    },
    enabled: !!orgId && !!id,
    refetchInterval: 30000,
  });

  const [bracketFormat, setBracketFormat] = useState<"single_elim" | "double_elim" | "round_robin">("single_elim");
  const [tieBreakRule, setTieBreakRule] = useState<"sudden_death" | "extra_holes_3" | "none">("sudden_death");
  const [hasConsolation, setHasConsolation] = useState(false);

  const createBracket = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/bracket`, {
        method: "POST",
        body: JSON.stringify({
          seedingMethod: "handicap",
          format: bracketFormat,
          tieBreakRule,
          hasConsolation: bracketFormat === "single_elim" ? hasConsolation : false,
        }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bracket", id, orgId] });
      toast({ title: "Bracket created" });
    },
  });

  const updateConfig = useMutation({
    mutationFn: async (patch: { format?: string; tieBreakRule?: string; hasConsolation?: boolean }) => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/bracket`, {
        method: "POST",
        body: JSON.stringify({ seedingMethod: "handicap", ...patch }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bracket", id, orgId] });
      toast({ title: "Settings updated" });
    },
  });

  const generateDraw = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/bracket/generate-draw`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bracket", id, orgId] });
      toast({ title: "Draw generated", description: "Bracket matches created" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const recordResult = useMutation({
    mutationFn: async ({ matchId, result, holeResults, conceeded }: { matchId: number; result: string; holeResults: Record<number, string>; conceeded?: { by: number; hole: number } }) => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/bracket/matches/${matchId}/result`, {
        method: "POST",
        body: JSON.stringify({
          result,
          holeResults,
          concededByPlayerId: conceeded?.by,
          concededOnHole: conceeded?.hole,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.error === "playoff_required") {
          // Refresh so the dialog (and match card) pick up the server-flagged playoff state.
          await queryClient.invalidateQueries({ queryKey: ["bracket", id, orgId] });
          const label = body.mode === "extra_holes_3" ? "3-hole playoff" : "sudden death";
          const err = new Error(`Match is tied — ${label} required (next: hole ${body.nextHole}).`);
          (err as Error & { kind?: string }).kind = "playoff_required";
          throw err;
        }
        throw new Error(body.error ?? "Failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bracket", id, orgId] });
      setRecordMatch(null);
      toast({ title: "Result recorded" });
    },
    onError: (err: Error) => {
      const isPlayoff = (err as Error & { kind?: string }).kind === "playoff_required";
      toast({
        title: isPlayoff ? "Playoff required" : "Error",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const data = bracketQuery.data;
  const hasBracket = data && data.bracket;
  const hasDrawn = hasBracket && data.bracket.drawGeneratedAt;

  // Live SSE refresh
  useEffect(() => {
    if (!hasBracket) return;
    const tid = data?.bracket?.tournamentId;
    if (!tid) return;
    const es = new EventSource(`/api/sse/bracket/${tid}`);
    es.onmessage = () => queryClient.invalidateQueries({ queryKey: ["bracket", id, orgId] });
    es.onerror = () => es.close();
    return () => es.close();
  }, [hasBracket, data?.bracket?.tournamentId, id, orgId, queryClient]);

  // Task #899 — deep-link target match focus. When the page is opened with
  // `?match=N` (from the round-robin tie-break notification), find the
  // matching MatchCard, scroll it into view, and apply a temporary amber
  // highlight ring so the recipient can see exactly which match needs them.
  const focusedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!hasDrawn) return;
    const focusId = Number(new URLSearchParams(window.location.search).get("match"));
    if (!Number.isFinite(focusId) || focusId <= 0) return;
    if (!data?.matches?.some(m => m.id === focusId)) return;
    if (focusedRef.current === focusId) return;
    focusedRef.current = focusId;
    let cleanup: (() => void) | null = null;
    const tryFocus = (attempt: number) => {
      const el = document.querySelector<HTMLElement>(`[data-match-id="${focusId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-amber-400", "ring-offset-2", "ring-offset-[#0a0f1a]");
        const off = window.setTimeout(() => {
          el.classList.remove("ring-2", "ring-amber-400", "ring-offset-2", "ring-offset-[#0a0f1a]");
        }, 3000);
        cleanup = () => window.clearTimeout(off);
        return;
      }
      if (attempt < 20) window.setTimeout(() => tryFocus(attempt + 1), 100);
    };
    tryFocus(0);
    return () => { if (cleanup) cleanup(); };
  }, [hasDrawn, data?.matches]);

  const shareUrl = data?.bracket?.shareToken
    ? `${window.location.origin}/bracket/${data.bracket.shareToken}`
    : null;
  const copyShareUrl = useCallback(() => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    toast({ title: "Spectator link copied", description: shareUrl });
  }, [shareUrl, toast]);

  const mainRounds = data?.rounds?.filter(r => r.bracketType === "main") ?? [];
  const consolationRounds = data?.rounds?.filter(r => r.bracketType === "consolation") ?? [];

  return (
    <div className="p-6 space-y-6 min-h-screen">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <GitBranch className="w-6 h-6 text-emerald-400" />
          <div>
            <h1 className="text-2xl font-bold text-white">Match Play Bracket</h1>
            <p className="text-gray-400 text-sm flex items-center gap-2">
              {hasBracket && (
                <>
                  {data?.bracket?.format === "round_robin" ? "Round Robin" : data?.bracket?.format === "double_elim" ? "Double Elimination" : "Single Elimination"}
                  <span className="text-gray-600">·</span>
                  Tie-break: {data?.bracket?.tieBreakRule === "extra_holes_3" ? "3 extra holes" : data?.bracket?.tieBreakRule === "none" ? "None" : "Sudden death"}
                  <span className="ml-2 inline-flex items-center gap-1 text-emerald-400"><Radio className="w-3 h-3 animate-pulse" /> Live</span>
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {shareUrl && (
            <Button variant="outline" size="sm" onClick={copyShareUrl}>
              <Share2 className="w-4 h-4 mr-2" /> Share Spectator View
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/tournaments/${id}`)}
          >
            Back to Tournament
          </Button>
          {hasBracket && !hasDrawn && (
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => generateDraw.mutate()}
              disabled={generateDraw.isPending}
            >
              <Shuffle className="w-4 h-4 mr-2" />
              Generate Draw
            </Button>
          )}
          {hasBracket && hasDrawn && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => generateDraw.mutate()}
              disabled={generateDraw.isPending}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Regenerate Draw
            </Button>
          )}
        </div>
      </div>

      {bracketQuery.isLoading && (
        <Card className="glass-card">
          <CardContent className="py-12 text-center text-gray-400">Loading bracket...</CardContent>
        </Card>
      )}

      {!bracketQuery.isLoading && !hasBracket && (
        <Card className="glass-card border-dashed border-white/20">
          <CardContent className="py-12 space-y-5">
            <div className="text-center space-y-2">
              <GitBranch className="w-12 h-12 text-gray-600 mx-auto" />
              <h3 className="text-white font-medium text-lg">Build your bracket</h3>
              <p className="text-gray-400 text-sm">Choose a format, then generate the draw from your registered players.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 max-w-2xl mx-auto">
              <div className="space-y-1">
                <label className="text-xs text-gray-400">Format</label>
                <Select value={bracketFormat} onValueChange={(v) => setBracketFormat(v as typeof bracketFormat)}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single_elim">Single Elimination</SelectItem>
                    <SelectItem value="double_elim">Double Elimination</SelectItem>
                    <SelectItem value="round_robin">Round Robin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400">Tie-break</label>
                <Select value={tieBreakRule} onValueChange={(v) => setTieBreakRule(v as typeof tieBreakRule)}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sudden_death">Sudden death playoff</SelectItem>
                    <SelectItem value="extra_holes_3">3 extra holes</SelectItem>
                    <SelectItem value="none">No tie-break (allow halved)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400">Consolation</label>
                <Select
                  value={hasConsolation ? "yes" : "no"}
                  onValueChange={(v) => setHasConsolation(v === "yes")}
                  disabled={bracketFormat !== "single_elim"}
                >
                  <SelectTrigger className="bg-white/10 border-white/20 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no">No consolation</SelectItem>
                    <SelectItem value="yes">Add consolation flight</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="text-center">
              <Button
                className="bg-emerald-600 hover:bg-emerald-700"
                onClick={() => createBracket.mutate()}
                disabled={createBracket.isPending}
              >
                <Plus className="w-4 h-4 mr-2" />
                Create Bracket
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {hasBracket && !hasDrawn && (
        <Card className="glass-card border-dashed border-emerald-600/30">
          <CardContent className="py-12 text-center space-y-4">
            <Shuffle className="w-12 h-12 text-emerald-600/50 mx-auto" />
            <div>
              <h3 className="text-white font-medium">Draw not yet generated</h3>
              <p className="text-gray-400 text-sm mt-1">Players will be seeded by handicap index</p>
            </div>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => generateDraw.mutate()}
              disabled={generateDraw.isPending}
            >
              <Shuffle className="w-4 h-4 mr-2" />
              Generate Draw
            </Button>
          </CardContent>
        </Card>
      )}

      {hasBracket && hasDrawn && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Card className="glass-card">
              <CardContent className="py-4 flex items-center gap-3">
                <Trophy className="w-5 h-5 text-yellow-400" />
                <div>
                  <div className="text-white font-medium">{data.bracket.totalRounds}</div>
                  <div className="text-gray-400 text-xs">Total Rounds</div>
                </div>
              </CardContent>
            </Card>
            <Card className="glass-card">
              <CardContent className="py-4 flex items-center gap-3">
                <Users className="w-5 h-5 text-blue-400" />
                <div>
                  <div className="text-white font-medium">{data.matches.filter(m => m.bracketType === "main" && m.result !== "pending").length} / {data.matches.filter(m => m.bracketType === "main").length}</div>
                  <div className="text-gray-400 text-xs">Matches Completed</div>
                </div>
              </CardContent>
            </Card>
            <Card className="glass-card">
              <CardContent className="py-4 flex items-center gap-3">
                <Shield className="w-5 h-5 text-purple-400" />
                <div>
                  <div className="text-white font-medium">{data.bracket.hasConsolation ? "Yes" : "No"}</div>
                  <div className="text-gray-400 text-xs">Consolation Bracket</div>
                </div>
              </CardContent>
            </Card>
          </div>

          {data.bracket.format === "round_robin" && (
            <RoundRobinStandings matches={data.matches} bracket={data.bracket} />
          )}

          {/* Main Draw */}
          <div>
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <Trophy className="w-4 h-4 text-yellow-400" /> {data.bracket.format === "round_robin" ? "Schedule" : "Main Draw"}
            </h2>
            <div className="flex gap-6 overflow-x-auto pb-4">
              {mainRounds.map(round => {
                const roundMatches = data.matches.filter(
                  m => m.roundId === round.id && m.bracketType === "main",
                );
                return (
                  <div key={round.id} className="flex-shrink-0 w-56">
                    <h3 className="text-sm font-medium text-gray-300 mb-3 text-center">{round.name}</h3>
                    <div className="space-y-3">
                      {roundMatches.map(match => (
                        <MatchCard
                          key={match.id}
                          match={match}
                          onRecord={setRecordMatch}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Consolation / Losers Bracket */}
          {consolationRounds.length > 0 && (
            <div>
              <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <Shield className="w-4 h-4 text-purple-400" /> {data.bracket.format === "double_elim" ? "Losers Bracket" : "Consolation Bracket"}
              </h2>
              {data.bracket.format === "double_elim" ? (
                <div className="flex gap-4 overflow-x-auto pb-4">
                  {groupLosersRoundsByLevel(consolationRounds).map(group => (
                    <div key={group.level ?? "misc"} className="flex-shrink-0">
                      {group.level != null && (
                        <div className="text-[10px] uppercase tracking-wider text-purple-300/70 mb-2 text-center">
                          Level {group.level}
                        </div>
                      )}
                      <div className="flex gap-4 rounded-lg border border-purple-400/20 bg-purple-400/[0.03] p-3">
                        {group.rounds.map(round => {
                          const roundMatches = data.matches.filter(
                            m => m.roundId === round.id && m.bracketType === "consolation",
                          );
                          return (
                            <div key={round.id} className="flex-shrink-0 w-56">
                              <h3 className="text-sm font-medium text-gray-300 mb-3 text-center">{round.name}</h3>
                              <div className="space-y-3">
                                {roundMatches.map(match => (
                                  <MatchCard
                                    key={match.id}
                                    match={match}
                                    onRecord={setRecordMatch}
                                  />
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex gap-6 overflow-x-auto pb-4">
                  {consolationRounds.map(round => {
                    const roundMatches = data.matches.filter(
                      m => m.roundId === round.id && m.bracketType === "consolation",
                    );
                    return (
                      <div key={round.id} className="flex-shrink-0 w-56">
                        <h3 className="text-sm font-medium text-gray-300 mb-3 text-center">{round.name}</h3>
                        <div className="space-y-3">
                          {roundMatches.map(match => (
                            <MatchCard
                              key={match.id}
                              match={match}
                              onRecord={setRecordMatch}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <RecordResultDialog
        match={recordMatch ? (data?.matches?.find(m => m.id === recordMatch.id) ?? recordMatch) : null}
        bracket={data?.bracket}
        open={!!recordMatch}
        onClose={() => setRecordMatch(null)}
        onSubmit={(matchId, result, holeResults, conceeded) => {
          recordResult.mutate({ matchId, result, holeResults, conceeded });
        }}
      />
    </div>
  );
}
