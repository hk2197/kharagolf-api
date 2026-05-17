import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Crown, Medal, Trophy } from "lucide-react";
import { useMemo, useState } from "react";
import {
  computeRoundRobinStandings,
  TIE_BREAK_DESCRIPTION,
  type StandingsMatch,
} from "@/lib/round-robin-standings";

type SortKey = "rank" | "played" | "wins" | "losses" | "halved" | "holesWon" | "points";

type BracketSummary = {
  championId?: number | null;
  runnerUpId?: number | null;
  completedAt?: string | Date | null;
  tieBreakRule?: string | null;
  [key: string]: unknown;
} | null | undefined;

export function RoundRobinStandings({
  matches,
  bracket,
}: {
  matches: StandingsMatch[];
  bracket?: BracketSummary;
}) {
  const standings = useMemo(() => computeRoundRobinStandings(matches), [matches]);
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    const arr = [...standings];
    arr.sort((a, b) => {
      const av = a[sortKey] as number;
      const bv = b[sortKey] as number;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [standings, sortKey, sortDir]);

  const toggle = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(k === "rank" ? "asc" : "desc");
    }
  };

  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  if (standings.length === 0) {
    return (
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="text-white text-lg flex items-center gap-2">
            <Trophy className="w-4 h-4 text-yellow-400" /> Standings
          </CardTitle>
        </CardHeader>
        <CardContent className="text-gray-400 text-sm">
          Standings will appear once the draw is generated.
        </CardContent>
      </Card>
    );
  }

  const headerCls =
    "text-xs text-gray-400 font-medium px-2 py-2 cursor-pointer select-none hover:text-white";

  const championId = bracket?.championId ?? null;
  const runnerUpId = bracket?.runnerUpId ?? null;
  const isComplete = !!bracket?.completedAt && !!championId;
  const topTied = standings[0]?.tied && !isComplete;
  const tieBreakRule = bracket?.tieBreakRule ?? "sudden_death";

  return (
    <Card className="glass-card" data-testid="rr-standings">
      <CardHeader>
        <CardTitle className="text-white text-lg flex items-center gap-2">
          <Trophy className="w-4 h-4 text-yellow-400" /> Standings
          {isComplete && (
            <span
              className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-yellow-300 bg-yellow-500/10 border border-yellow-400/40 px-2 py-0.5 rounded-full"
              data-testid="rr-complete-badge"
            >
              <Crown className="w-3 h-3" /> Complete
            </span>
          )}
        </CardTitle>
        <p className="text-xs text-gray-500 mt-1">{TIE_BREAK_DESCRIPTION}</p>
        {topTied && (
          <p
            className="text-xs text-yellow-300 mt-1"
            data-testid="rr-tiebreak-pending"
          >
            Top of the table is tied — a {tieBreakRule === "extra_holes_3" ? "3-hole playoff" : "sudden-death"} tie-break is needed.
          </p>
        )}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-white/10">
              <tr className="text-left">
                <th className={headerCls} onClick={() => toggle("rank")}>#{arrow("rank")}</th>
                <th className="text-xs text-gray-400 font-medium px-2 py-2">Player</th>
                <th className={headerCls} onClick={() => toggle("played")}>P{arrow("played")}</th>
                <th className={headerCls} onClick={() => toggle("wins")}>W{arrow("wins")}</th>
                <th className={headerCls} onClick={() => toggle("losses")}>L{arrow("losses")}</th>
                <th className={headerCls} onClick={() => toggle("halved")}>H{arrow("halved")}</th>
                <th className={headerCls} onClick={() => toggle("holesWon")}>Holes Won{arrow("holesWon")}</th>
                <th className={headerCls} onClick={() => toggle("points")}>Pts{arrow("points")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => {
                const isChampion = championId === row.playerId;
                const isRunnerUp = runnerUpId === row.playerId;
                const rowCls = isChampion
                  ? "border-b border-yellow-400/30 bg-yellow-500/10"
                  : isRunnerUp
                    ? "border-b border-slate-300/20 bg-slate-300/5"
                    : "border-b border-white/5";
                return (
                  <tr
                    key={row.playerId}
                    className={rowCls}
                    data-testid={isChampion ? "rr-champion-row" : isRunnerUp ? "rr-runnerup-row" : undefined}
                  >
                    <td className="px-2 py-2 text-gray-300">{row.rank}</td>
                    <td className="px-2 py-2 text-white font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {isChampion && <Crown className="w-3.5 h-3.5 text-yellow-300" />}
                        {isRunnerUp && <Medal className="w-3.5 h-3.5 text-slate-200" />}
                        {row.player.firstName} {row.player.lastName}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-gray-300">{row.played}</td>
                    <td className="px-2 py-2 text-emerald-400">{row.wins}</td>
                    <td className="px-2 py-2 text-rose-400">{row.losses}</td>
                    <td className="px-2 py-2 text-yellow-400">{row.halved}</td>
                    <td className="px-2 py-2 text-gray-300">{row.holesWon}</td>
                    <td className="px-2 py-2 text-white font-semibold">{row.points}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
