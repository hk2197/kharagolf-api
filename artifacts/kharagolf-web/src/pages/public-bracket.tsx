import { useEffect } from "react";
import { useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trophy, GitBranch, Shield, Radio, Crown, Medal, Sparkles } from "lucide-react";
import { RoundRobinStandings } from "@/components/RoundRobinStandings";

const API = "/api";

type Player = { id: number; firstName: string; lastName: string };
type HoleOwner = "player1" | "player2" | "halved";
type Match = {
  id: number; roundId: number; matchNumber: number; bracketType: string;
  player1Id?: number | null; player2Id?: number | null;
  player1IsBye: boolean; player2IsBye: boolean;
  result: string; winnerId?: number | null;
  matchStatus?: string | null;
  holeResults?: Record<string, HoleOwner> | null;
  player1?: Player | null; player2?: Player | null; winner?: Player | null;
};
type Round = { id: number; roundNumber: number; name: string; bracketType: string };
type Data = {
  tournament: { id: number; name: string; status: string } | null;
  bracket: {
    id: number; format: string; tieBreakRule: string; hasConsolation: boolean; totalRounds: number; tournamentId: number;
    championId?: number | null; runnerUpId?: number | null; completedAt?: string | null;
  };
  rounds: Round[];
  matches: Match[];
};

function name(p?: Player | null) { return p ? `${p.firstName} ${p.lastName}` : "TBD"; }

function initials(p?: Player | null) {
  if (!p) return "?";
  return `${p.firstName.charAt(0)}${p.lastName.charAt(0)}`.toUpperCase();
}

function ChampionBanner({
  champion,
  runnerUp,
  completedAt,
  tournamentName,
}: {
  champion: Player;
  runnerUp?: Player | null;
  completedAt?: string | null;
  tournamentName?: string | null;
}) {
  const completedLabel = completedAt
    ? new Date(completedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div
      data-testid="champion-banner"
      className="relative overflow-hidden rounded-2xl border border-yellow-400/40 bg-gradient-to-br from-yellow-500/20 via-amber-500/10 to-orange-500/10 p-6 sm:p-8 shadow-lg"
    >
      <div className="absolute inset-0 pointer-events-none opacity-40">
        <div className="absolute -top-10 -right-10 w-48 h-48 rounded-full bg-yellow-400/20 blur-3xl" />
        <div className="absolute -bottom-12 -left-12 w-56 h-56 rounded-full bg-amber-500/20 blur-3xl" />
      </div>

      <div className="relative flex flex-col sm:flex-row items-center sm:items-stretch gap-5 sm:gap-6">
        <div className="flex-shrink-0 flex items-center justify-center">
          <div className="relative">
            <div
              data-testid="champion-avatar"
              className="w-24 h-24 sm:w-28 sm:h-28 rounded-full bg-gradient-to-br from-yellow-300 to-amber-600 flex items-center justify-center text-3xl sm:text-4xl font-bold text-amber-950 shadow-xl ring-4 ring-yellow-300/40"
            >
              {initials(champion)}
            </div>
            <div className="absolute -top-2 -right-2 bg-yellow-400 rounded-full p-1.5 shadow-md">
              <Crown className="w-4 h-4 sm:w-5 sm:h-5 text-amber-900" />
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0 text-center sm:text-left">
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-yellow-300 bg-yellow-500/15 border border-yellow-400/40 px-2.5 py-1 rounded-full">
            <Sparkles className="w-3 h-3" /> Champion Crowned
          </div>
          <h2
            className="mt-2 text-2xl sm:text-4xl font-bold text-white truncate"
            data-testid="champion-name"
          >
            {name(champion)}
          </h2>
          {tournamentName && (
            <p className="mt-1 text-sm text-yellow-100/80">
              wins {tournamentName}
            </p>
          )}
          <div className="mt-3 flex flex-col sm:flex-row sm:flex-wrap items-center sm:items-start gap-2 sm:gap-4 text-sm">
            {runnerUp && (
              <div
                className="inline-flex items-center gap-1.5 text-slate-200 bg-white/5 border border-white/10 px-3 py-1 rounded-full"
                data-testid="runner-up-name"
              >
                <Medal className="w-3.5 h-3.5 text-slate-300" />
                <span className="text-xs uppercase tracking-wide text-slate-400">Runner-up</span>
                <span className="font-medium">{name(runnerUp)}</span>
              </div>
            )}
            {completedLabel && (
              <div className="text-xs text-yellow-100/70">
                Completed {completedLabel}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
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

function shortName(p?: Player | null) {
  if (!p) return "—";
  return `${p.firstName.charAt(0)}. ${p.lastName}`;
}

function PlayoffSection({ m, tieBreakRule }: { m: Match; tieBreakRule: string }) {
  const results = m.holeResults ?? {};
  const playoffHoles = Object.keys(results)
    .map(k => Number(k))
    .filter(h => Number.isFinite(h) && h > 18)
    .sort((a, b) => a - b);
  if (playoffHoles.length === 0) return null;

  const aggregateMode = tieBreakRule === "extra_holes_3";
  const aggregateRange = (h: number) => aggregateMode && h >= 19 && h <= 21;

  let pp1 = 0, pp2 = 0;

  return (
    <div className="mt-2 pt-2 border-t border-amber-500/30">
      <div className="text-[10px] uppercase tracking-wide text-amber-400 mb-1 font-semibold">
        {aggregateMode ? "3-Hole Playoff" : "Sudden Death"}
      </div>
      <div className="space-y-0.5">
        {playoffHoles.map(h => {
          const r = results[String(h)];
          const isAgg = aggregateRange(h);
          if (r === "player1") pp1++;
          else if (r === "player2") pp2++;
          const label =
            r === "player1" ? shortName(m.player1) :
            r === "player2" ? shortName(m.player2) :
            "Halved";
          const tone =
            r === "player1" ? "text-emerald-400" :
            r === "player2" ? "text-emerald-400" :
            "text-gray-400";
          const isDecisive = !isAgg && (r === "player1" || r === "player2");
          return (
            <div key={h} className="flex items-center justify-between text-xs">
              <span className="text-gray-500">
                Hole {h}
                {isAgg && <span className="ml-1 text-[9px] text-amber-300/80">agg</span>}
                {!isAgg && aggregateMode && <span className="ml-1 text-[9px] text-amber-300/80">SD</span>}
              </span>
              <span className={`${tone} ${isDecisive ? "font-semibold" : ""}`}>{label}</span>
            </div>
          );
        })}
        {aggregateMode && playoffHoles.some(h => h >= 19 && h <= 21) && (
          <div className="flex items-center justify-between text-[10px] text-amber-300/90 pt-1">
            <span>Aggregate</span>
            <span>{pp1} – {pp2}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function MatchCard({ m, tieBreakRule }: { m: Match; tieBreakRule: string }) {
  const p1 = m.player1IsBye ? "BYE" : name(m.player1);
  const p2 = m.player2IsBye ? "BYE" : name(m.player2);
  const isComplete = m.result !== "pending";
  return (
    <div className={`rounded-lg border p-3 bg-white/5 backdrop-blur-sm space-y-2 ${isComplete ? "border-emerald-600/30" : "border-white/10"}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">Match {m.matchNumber}</span>
        {isComplete
          ? <Badge className="bg-emerald-600 text-xs">Closed</Badge>
          : m.matchStatus?.includes("Dormie")
            ? <Badge className="bg-amber-500 text-xs">Dormie</Badge>
            : <Badge variant="outline" className="text-xs">Live</Badge>}
      </div>
      <div className={`text-sm font-medium ${m.winnerId === m.player1Id && m.winnerId ? "text-emerald-400" : "text-white"}`}>{p1}</div>
      <div className="text-xs text-gray-500">vs</div>
      <div className={`text-sm font-medium ${m.winnerId === m.player2Id && m.winnerId ? "text-emerald-400" : "text-white"}`}>{p2}</div>
      {m.matchStatus && <div className="text-xs text-yellow-400">{m.matchStatus}</div>}
      {m.winner && <div className="text-xs text-emerald-400">Winner: {name(m.winner)}</div>}
      <PlayoffSection m={m} tieBreakRule={tieBreakRule} />
    </div>
  );
}

export default function PublicBracketPage() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const queryClient = useQueryClient();
  const q = useQuery<Data>({
    queryKey: ["public-bracket", shareToken],
    queryFn: async () => {
      const res = await fetch(`${API}/public/brackets/${shareToken}`);
      if (!res.ok) throw new Error("Failed to load bracket");
      return res.json();
    },
    refetchInterval: 30000,
  });

  // Live SSE refresh
  useEffect(() => {
    const tournamentId = q.data?.bracket?.tournamentId;
    if (!tournamentId) return;
    const es = new EventSource(`${API}/sse/bracket/${tournamentId}`);
    es.onmessage = () => queryClient.invalidateQueries({ queryKey: ["public-bracket", shareToken] });
    es.onerror = () => { es.close(); };
    return () => es.close();
  }, [q.data?.bracket?.tournamentId, shareToken, queryClient]);

  if (q.isLoading) {
    return <div className="min-h-screen bg-background p-8 text-gray-400">Loading bracket...</div>;
  }
  if (q.isError || !q.data) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Card><CardContent className="py-16 text-center text-gray-400">Bracket not found.</CardContent></Card>
      </div>
    );
  }

  const { tournament, bracket, rounds, matches } = q.data;
  const mainRounds = rounds.filter(r => r.bracketType === "main");
  const consoRounds = rounds.filter(r => r.bracketType === "consolation");
  const formatLabel = bracket.format === "round_robin" ? "Round Robin" : bracket.format === "double_elim" ? "Double Elimination" : "Single Elimination";

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <GitBranch className="w-6 h-6 text-emerald-400" />
          <div>
            <h1 className="text-2xl font-bold text-white">{tournament?.name ?? "Tournament Bracket"}</h1>
            <p className="text-gray-400 text-sm flex items-center gap-2">
              {formatLabel} <span className="text-gray-600">·</span> {bracket.totalRounds} round{bracket.totalRounds !== 1 ? "s" : ""}
              <span className="ml-3 inline-flex items-center gap-1 text-emerald-400"><Radio className="w-3 h-3 animate-pulse" /> Live</span>
            </p>
          </div>
        </div>
      </div>

      {bracket.format === "round_robin" && bracket.completedAt && bracket.championId && (() => {
        const champion =
          matches.find(m => m.player1?.id === bracket.championId)?.player1 ||
          matches.find(m => m.player2?.id === bracket.championId)?.player2 ||
          null;
        const runnerUp = bracket.runnerUpId
          ? (matches.find(m => m.player1?.id === bracket.runnerUpId)?.player1 ||
             matches.find(m => m.player2?.id === bracket.runnerUpId)?.player2 ||
             null)
          : null;
        if (!champion) return null;
        return (
          <ChampionBanner
            champion={champion}
            runnerUp={runnerUp}
            completedAt={bracket.completedAt}
            tournamentName={tournament?.name ?? null}
          />
        );
      })()}

      {bracket.format === "round_robin" && (
        <RoundRobinStandings matches={matches} bracket={bracket} />
      )}

      <div>
        <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
          <Trophy className="w-4 h-4 text-yellow-400" /> {bracket.format === "round_robin" ? "Schedule" : bracket.format === "double_elim" ? "Winners Bracket" : "Main Draw"}
        </h2>
        <div className="flex gap-6 overflow-x-auto pb-4">
          {mainRounds.map(round => {
            const rm = matches.filter(m => m.roundId === round.id);
            return (
              <div key={round.id} className="flex-shrink-0 w-56">
                <h3 className="text-sm font-medium text-gray-300 mb-3 text-center">{round.name}</h3>
                <div className="space-y-3">{rm.map(m => <MatchCard key={m.id} m={m} tieBreakRule={bracket.tieBreakRule} />)}</div>
              </div>
            );
          })}
        </div>
      </div>

      {consoRounds.length > 0 && (
        <div>
          <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
            <Shield className="w-4 h-4 text-purple-400" /> {bracket.format === "double_elim" ? "Losers Bracket" : "Consolation Bracket"}
          </h2>
          {bracket.format === "double_elim" ? (
            <div className="flex gap-4 overflow-x-auto pb-4">
              {groupLosersRoundsByLevel(consoRounds).map(group => (
                <div key={group.level ?? "misc"} className="flex-shrink-0">
                  {group.level != null && (
                    <div className="text-[10px] uppercase tracking-wider text-purple-300/70 mb-2 text-center">
                      Level {group.level}
                    </div>
                  )}
                  <div className="flex gap-4 rounded-lg border border-purple-400/20 bg-purple-400/[0.03] p-3">
                    {group.rounds.map(round => {
                      const rm = matches.filter(m => m.roundId === round.id);
                      return (
                        <div key={round.id} className="flex-shrink-0 w-56">
                          <h3 className="text-sm font-medium text-gray-300 mb-3 text-center">{round.name}</h3>
                          <div className="space-y-3">{rm.map(m => <MatchCard key={m.id} m={m} tieBreakRule={bracket.tieBreakRule} />)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex gap-6 overflow-x-auto pb-4">
              {consoRounds.map(round => {
                const rm = matches.filter(m => m.roundId === round.id);
                return (
                  <div key={round.id} className="flex-shrink-0 w-56">
                    <h3 className="text-sm font-medium text-gray-300 mb-3 text-center">{round.name}</h3>
                    <div className="space-y-3">{rm.map(m => <MatchCard key={m.id} m={m} tieBreakRule={bracket.tieBreakRule} />)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
