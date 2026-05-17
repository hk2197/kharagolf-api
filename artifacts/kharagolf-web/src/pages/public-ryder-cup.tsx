import { useEffect } from "react";
import { useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shield, Radio } from "lucide-react";

const API = "/api";

type Player = { id: number; firstName: string; lastName: string };
type TeamHoleOwner = "team1" | "team2" | "halved";
type Match = {
  id: number; sessionId: number; matchNumber: number; result: string;
  team1Points: string; team2Points: string; matchStatus?: string | null;
  team1Player1?: Player | null; team1Player2?: Player | null;
  team2Player1?: Player | null; team2Player2?: Player | null;
  holeResults?: Record<string, TeamHoleOwner> | null;
};
type Session = { id: number; sessionNumber: number; name: string; sessionType: string };
type Data = {
  tournament: { id: number; name: string } | null;
  config: {
    tournamentId: number; team1Name: string; team2Name: string;
    team1Colour: string; team2Colour: string; totalPoints: number;
    tieBreakRule?: string | null;
  };
  sessions: Session[];
  matches: Match[];
  runningTotals: { team1: number; team2: number };
};

function name(p?: Player | null) { return p ? `${p.firstName} ${p.lastName}` : "TBD"; }

function TeamPlayoffSection({
  m, tieBreakRule, team1Name, team2Name, team1Colour, team2Colour,
}: {
  m: Match; tieBreakRule: string;
  team1Name: string; team2Name: string;
  team1Colour: string; team2Colour: string;
}) {
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
          if (r === "team1") pp1++;
          else if (r === "team2") pp2++;
          const label =
            r === "team1" ? team1Name :
            r === "team2" ? team2Name :
            "Halved";
          const colour =
            r === "team1" ? team1Colour :
            r === "team2" ? team2Colour :
            undefined;
          const isDecisive = !isAgg && (r === "team1" || r === "team2");
          return (
            <div key={h} className="flex items-center justify-between text-xs">
              <span className="text-gray-500">
                Hole {h}
                {isAgg && <span className="ml-1 text-[9px] text-amber-300/80">agg</span>}
                {!isAgg && aggregateMode && <span className="ml-1 text-[9px] text-amber-300/80">SD</span>}
              </span>
              <span
                className={isDecisive ? "font-semibold" : ""}
                style={colour ? { color: colour } : { color: "#9CA3AF" }}
              >
                {label}
              </span>
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

export default function PublicRyderCupPage() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const queryClient = useQueryClient();
  const q = useQuery<Data>({
    queryKey: ["public-ryder", shareToken],
    queryFn: async () => {
      const res = await fetch(`${API}/public/ryder-cup/${shareToken}`);
      if (!res.ok) throw new Error("Failed to load Ryder Cup");
      return res.json();
    },
    refetchInterval: 15000,
  });

  useEffect(() => {
    const tid = q.data?.config?.tournamentId;
    if (!tid) return;
    const es = new EventSource(`${API}/sse/ryder-cup/${tid}`);
    es.onmessage = () => queryClient.invalidateQueries({ queryKey: ["public-ryder", shareToken] });
    es.onerror = () => es.close();
    return () => es.close();
  }, [q.data?.config?.tournamentId, shareToken, queryClient]);

  if (q.isLoading) return <div className="min-h-screen bg-background p-8 text-gray-400">Loading...</div>;
  if (q.isError || !q.data) {
    return <div className="min-h-screen bg-background p-8"><Card><CardContent className="py-16 text-center text-gray-400">Not found.</CardContent></Card></div>;
  }
  const { tournament, config, sessions, matches, runningTotals } = q.data;
  const target = Math.floor(config.totalPoints / 2) + 1;

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="w-6 h-6 text-amber-400" />
        <div>
          <h1 className="text-2xl font-bold text-white">{tournament?.name ?? "Ryder Cup"}</h1>
          <p className="text-gray-400 text-sm inline-flex items-center gap-2">
            Team match · First to {target} pts
            <span className="ml-2 inline-flex items-center gap-1 text-emerald-400"><Radio className="w-3 h-3 animate-pulse" /> Live</span>
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="py-6 grid grid-cols-3 items-center text-center">
          <div>
            <div className="text-5xl font-bold" style={{ color: config.team1Colour ?? "#1e40af" }}>{runningTotals.team1}</div>
            <div className="text-sm text-gray-300 mt-2">{config.team1Name}</div>
          </div>
          <div className="text-gray-500 text-sm">of {config.totalPoints} points</div>
          <div>
            <div className="text-5xl font-bold" style={{ color: config.team2Colour ?? "#dc2626" }}>{runningTotals.team2}</div>
            <div className="text-sm text-gray-300 mt-2">{config.team2Name}</div>
          </div>
        </CardContent>
      </Card>

      {sessions.map(session => {
        const sm = matches.filter(m => m.sessionId === session.id);
        return (
          <div key={session.id}>
            <h2 className="text-lg font-bold text-white mb-3">{session.name} <span className="text-xs text-gray-400 ml-2">{session.sessionType.replace("_", " ")}</span></h2>
            <div className="space-y-2">
              {sm.map(m => {
                const isSingles = session.sessionType === "singles";
                const t1 = isSingles ? name(m.team1Player1) : `${name(m.team1Player1)} / ${name(m.team1Player2)}`;
                const t2 = isSingles ? name(m.team2Player1) : `${name(m.team2Player1)} / ${name(m.team2Player2)}`;
                const isComplete = m.result !== "pending";
                return (
                  <div key={m.id} className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-400">Match {m.matchNumber}</span>
                      {isComplete
                        ? <Badge className="bg-emerald-600 text-xs">{m.team1Points} – {m.team2Points}</Badge>
                        : m.matchStatus?.includes("Dormie")
                          ? <Badge className="bg-amber-500 text-xs">{m.matchStatus}</Badge>
                          : <Badge variant="outline" className="text-xs">{m.matchStatus ?? "All Square"}</Badge>}
                    </div>
                    <div className="flex justify-between text-sm">
                      <span style={{ color: config.team1Colour ?? "#1e40af" }}>{t1}</span>
                      <span className="text-gray-500 text-xs">vs</span>
                      <span style={{ color: config.team2Colour ?? "#dc2626" }}>{t2}</span>
                    </div>
                    <TeamPlayoffSection
                      m={m}
                      tieBreakRule={config.tieBreakRule ?? "sudden_death"}
                      team1Name={config.team1Name}
                      team2Name={config.team2Name}
                      team1Colour={config.team1Colour ?? "#1e40af"}
                      team2Colour={config.team2Colour ?? "#dc2626"}
                    />
                  </div>
                );
              })}
              {sm.length === 0 && <div className="text-gray-500 text-sm italic">No matches yet</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
