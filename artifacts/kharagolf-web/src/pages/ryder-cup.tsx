import React, { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Trophy, Users, Plus, Shield, Star, ChevronRight, Target, X, Settings } from "lucide-react";
import { useActiveOrgId } from "@/context/ActiveOrgContext";

const API = "/api";

function apiFetch(path: string, opts?: RequestInit) {
  return fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
}

type Player = { id: number; firstName: string; lastName: string; handicapIndex?: string | null };
type RyderTieBreakRule = "sudden_death" | "extra_holes_3" | "none";
type RyderConfig = { id: number; team1Name: string; team2Name: string; team1Colour: string; team2Colour: string; totalPoints: number; team1TotalPoints: string; team2TotalPoints: string; tieBreakRule?: RyderTieBreakRule | null };
type RyderSession = { id: number; sessionNumber: number; sessionType: string; name: string; team1Name: string; team2Name: string; scheduledDate?: string | null };
type RyderMatch = {
  id: number;
  sessionId: number;
  matchNumber: number;
  result: string;
  team1Points: string;
  team2Points: string;
  matchStatus?: string | null;
  holeResults?: Record<string, string>;
  team1Player1?: Player | null;
  team1Player2?: Player | null;
  team2Player1?: Player | null;
  team2Player2?: Player | null;
  concededByTeam?: string | null;
};

type RyderData = {
  config: RyderConfig | null;
  sessions: RyderSession[];
  matches: RyderMatch[];
  runningTotals: { team1: number; team2: number };
};

function playerShortName(p?: Player | null): string {
  if (!p) return "TBD";
  return `${p.firstName} ${p.lastName[0]}.`;
}

function sessionTypeLabel(t: string) {
  if (t === "foursomes") return "Foursomes";
  if (t === "four_ball") return "Four-Ball";
  if (t === "singles") return "Singles";
  return t;
}

function PointsBadge({ pts }: { pts: number }) {
  if (pts === 1) return <Badge className="bg-emerald-600 text-white">1pt</Badge>;
  if (pts === 0.5) return <Badge className="bg-yellow-600 text-white">½pt</Badge>;
  return <Badge variant="outline" className="text-gray-400">0pt</Badge>;
}

function playoffFormatLabel(rule?: RyderTieBreakRule | null): string {
  switch (rule) {
    case "extra_holes_3":
      return "3-Hole Aggregate";
    case "none":
      return "None (stays halved)";
    case "sudden_death":
    default:
      return "Sudden Death";
  }
}

function TeamScoreboard({ config, totals }: { config: RyderConfig; totals: { team1: number; team2: number } }) {
  const maxPoints = config.totalPoints;
  const pct1 = Math.min((totals.team1 / maxPoints) * 100, 100);
  const pct2 = Math.min((totals.team2 / maxPoints) * 100, 100);

  return (
    <Card className="glass-card">
      <CardContent className="py-6">
        <div className="flex justify-end mb-2">
          <Badge
            variant="outline"
            className="text-[10px] text-gray-300 border-white/20"
            data-testid="badge-playoff-format"
          >
            Playoff: {playoffFormatLabel(config.tieBreakRule)}
          </Badge>
        </div>
        <div className="grid grid-cols-3 items-center gap-4">
          <div className="text-center">
            <div className="text-3xl font-bold" style={{ color: config.team1Colour ?? "#1e40af" }}>
              {totals.team1}
            </div>
            <div className="text-sm text-gray-400 mt-1">{config.team1Name}</div>
          </div>
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-2">Points to win: {Math.ceil(maxPoints / 2 + 0.5)}</div>
            <div className="flex gap-1 items-center">
              <div className="flex-1 bg-gray-700 rounded-full h-3 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${pct1}%`, backgroundColor: config.team1Colour ?? "#1e40af" }}
                />
              </div>
              <div className="flex-1 bg-gray-700 rounded-full h-3 overflow-hidden">
                <div
                  className="h-full rounded-full float-right transition-all duration-500"
                  style={{ width: `${pct2}%`, backgroundColor: config.team2Colour ?? "#dc2626" }}
                />
              </div>
            </div>
            <div className="text-xs text-gray-500 mt-2">vs</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold" style={{ color: config.team2Colour ?? "#dc2626" }}>
              {totals.team2}
            </div>
            <div className="text-sm text-gray-400 mt-1">{config.team2Name}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MatchRow({
  match,
  session,
  config,
  onRecord,
  onHole,
}: {
  match: RyderMatch;
  session: RyderSession;
  config: RyderConfig | null;
  onRecord: (match: RyderMatch, session: RyderSession) => void;
  onHole: (match: RyderMatch, session: RyderSession) => void;
}) {
  const isSingles = session.sessionType === "singles";
  const t1 = isSingles
    ? playerShortName(match.team1Player1)
    : `${playerShortName(match.team1Player1)} / ${playerShortName(match.team1Player2)}`;
  const t2 = isSingles
    ? playerShortName(match.team2Player1)
    : `${playerShortName(match.team2Player1)} / ${playerShortName(match.team2Player2)}`;

  const isComplete = match.result !== "pending";

  return (
    <div className={`grid grid-cols-7 gap-2 items-center py-2 px-3 rounded-lg ${isComplete ? "bg-white/5" : "bg-white/3 border border-white/10"}`}>
      <div className="text-xs text-gray-500">#{match.matchNumber}</div>
      <div className="col-span-2 text-sm text-white font-medium truncate">{t1}</div>
      <div className="text-center">
        {isComplete ? (
          <div className="text-xs">
            <span style={{ color: config?.team1Colour ?? "#1e40af" }}>{match.team1Points}</span>
            {" - "}
            <span style={{ color: config?.team2Colour ?? "#dc2626" }}>{match.team2Points}</span>
          </div>
        ) : (
          <div className="text-xs text-gray-500">{match.matchStatus ?? "vs"}</div>
        )}
      </div>
      <div className="col-span-2 text-sm text-white font-medium truncate text-right">{t2}</div>
      <div className="flex gap-1 justify-end">
        {!isComplete && (
          <>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => onHole(match, session)}>
              Hole
            </Button>
            <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={() => onRecord(match, session)}>
              Result
            </Button>
          </>
        )}
        {isComplete && (
          <Badge variant="outline" className="text-[10px]">
            {match.result === "player1_wins" ? "T1 wins" : match.result === "player2_wins" ? "T2 wins" : match.result === "halved" ? "Halved" : "Done"}
          </Badge>
        )}
      </div>
    </div>
  );
}

function ConfigDialog({
  open,
  onClose,
  existing,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  existing?: RyderConfig | null;
  onSave: (data: { team1Name: string; team2Name: string; team1Colour: string; team2Colour: string; totalPoints: number; tieBreakRule: RyderTieBreakRule }) => void;
}) {
  const [team1Name, setTeam1Name] = useState(existing?.team1Name ?? "Team 1");
  const [team2Name, setTeam2Name] = useState(existing?.team2Name ?? "Team 2");
  const [team1Colour, setTeam1Colour] = useState(existing?.team1Colour ?? "#1e40af");
  const [team2Colour, setTeam2Colour] = useState(existing?.team2Colour ?? "#dc2626");
  const [totalPoints, setTotalPoints] = useState(String(existing?.totalPoints ?? 28));
  const [tieBreakRule, setTieBreakRule] = useState<RyderTieBreakRule>((existing?.tieBreakRule as RyderTieBreakRule) ?? "sudden_death");

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md bg-gray-900 text-white border-white/10">
        <DialogHeader>
          <DialogTitle>Configure Teams</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Team 1 Name</label>
              <Input value={team1Name} onChange={e => setTeam1Name(e.target.value)} className="bg-white/10 border-white/20 text-white" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Team 2 Name</label>
              <Input value={team2Name} onChange={e => setTeam2Name(e.target.value)} className="bg-white/10 border-white/20 text-white" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Team 1 Colour</label>
              <div className="flex gap-2 items-center">
                <input type="color" value={team1Colour} onChange={e => setTeam1Colour(e.target.value)} className="w-10 h-8 rounded cursor-pointer" />
                <Input value={team1Colour} onChange={e => setTeam1Colour(e.target.value)} className="bg-white/10 border-white/20 text-white text-xs" />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Team 2 Colour</label>
              <div className="flex gap-2 items-center">
                <input type="color" value={team2Colour} onChange={e => setTeam2Colour(e.target.value)} className="w-10 h-8 rounded cursor-pointer" />
                <Input value={team2Colour} onChange={e => setTeam2Colour(e.target.value)} className="bg-white/10 border-white/20 text-white text-xs" />
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-gray-400">Total Points Available</label>
            <Input
              type="number"
              value={totalPoints}
              onChange={e => setTotalPoints(e.target.value)}
              className="bg-white/10 border-white/20 text-white"
              min={2}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-gray-400">Playoff Format (when a team match is tied after 18)</label>
            <select
              value={tieBreakRule}
              onChange={e => setTieBreakRule(e.target.value as RyderTieBreakRule)}
              className="w-full rounded bg-white/10 border border-white/20 text-white text-sm px-2 py-2"
            >
              <option value="sudden_death" className="bg-gray-900">Sudden Death</option>
              <option value="extra_holes_3" className="bg-gray-900">3-Hole Aggregate Playoff</option>
              <option value="none" className="bg-gray-900">None (match stays halved)</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
            <Button
              className="flex-1 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => onSave({ team1Name, team2Name, team1Colour, team2Colour, totalPoints: Number(totalPoints), tieBreakRule })}
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddSessionDialog({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (data: { sessionType: string; name: string; scheduledDate?: string }) => void;
}) {
  const [sessionType, setSessionType] = useState("singles");
  const [name, setName] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");

  const defaultName = sessionType === "foursomes" ? "Foursomes" : sessionType === "four_ball" ? "Four-Ball" : "Singles";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md bg-gray-900 text-white border-white/10">
        <DialogHeader>
          <DialogTitle>Add Session</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs text-gray-400">Session Type</label>
            <Select value={sessionType} onValueChange={setSessionType}>
              <SelectTrigger className="bg-white/10 border-white/20 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="foursomes">Foursomes (Alternate Shot)</SelectItem>
                <SelectItem value="four_ball">Four-Ball (Better Ball)</SelectItem>
                <SelectItem value="singles">Singles</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-gray-400">Session Name</label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={defaultName}
              className="bg-white/10 border-white/20 text-white"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-gray-400">Scheduled Date (optional)</label>
            <Input
              type="date"
              value={scheduledDate}
              onChange={e => setScheduledDate(e.target.value)}
              className="bg-white/10 border-white/20 text-white"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
            <Button
              className="flex-1 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => {
                onAdd({ sessionType, name: name || defaultName, scheduledDate: scheduledDate || undefined });
                onClose();
              }}
            >
              Add Session
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddMatchDialog({
  open,
  onClose,
  session,
  players,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  session: RyderSession | null;
  players: Player[];
  onAdd: (sessionId: number, data: { team1Player1Id?: number; team1Player2Id?: number; team2Player1Id?: number; team2Player2Id?: number }) => void;
}) {
  const [t1p1, setT1p1] = useState("");
  const [t1p2, setT1p2] = useState("");
  const [t2p1, setT2p1] = useState("");
  const [t2p2, setT2p2] = useState("");

  if (!session) return null;
  const isSingles = session.sessionType === "singles";
  const isPaired = !isSingles;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md bg-gray-900 text-white border-white/10">
        <DialogHeader>
          <DialogTitle>Add Match — {session.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="text-sm font-medium" style={{ color: "#1e40af" }}>{session.team1Name}</div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400">{isPaired ? "Player 1" : "Player"}</label>
                <Select value={t1p1} onValueChange={setT1p1}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white">
                    <SelectValue placeholder="Select player" />
                  </SelectTrigger>
                  <SelectContent>
                    {players.map(p => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.firstName} {p.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {isPaired && (
                <div className="space-y-1">
                  <label className="text-xs text-gray-400">Player 2</label>
                  <Select value={t1p2} onValueChange={setT1p2}>
                    <SelectTrigger className="bg-white/10 border-white/20 text-white">
                      <SelectValue placeholder="Select player" />
                    </SelectTrigger>
                    <SelectContent>
                      {players.map(p => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.firstName} {p.lastName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium" style={{ color: "#dc2626" }}>{session.team2Name}</div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400">{isPaired ? "Player 1" : "Player"}</label>
                <Select value={t2p1} onValueChange={setT2p1}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white">
                    <SelectValue placeholder="Select player" />
                  </SelectTrigger>
                  <SelectContent>
                    {players.map(p => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.firstName} {p.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {isPaired && (
                <div className="space-y-1">
                  <label className="text-xs text-gray-400">Player 2</label>
                  <Select value={t2p2} onValueChange={setT2p2}>
                    <SelectTrigger className="bg-white/10 border-white/20 text-white">
                      <SelectValue placeholder="Select player" />
                    </SelectTrigger>
                    <SelectContent>
                      {players.map(p => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.firstName} {p.lastName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
            <Button
              className="flex-1 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => {
                onAdd(session.id, {
                  team1Player1Id: t1p1 ? Number(t1p1) : undefined,
                  team1Player2Id: t1p2 ? Number(t1p2) : undefined,
                  team2Player1Id: t2p1 ? Number(t2p1) : undefined,
                  team2Player2Id: t2p2 ? Number(t2p2) : undefined,
                });
                onClose();
              }}
            >
              Add Match
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RecordResultDialog({
  match,
  session,
  config,
  open,
  onClose,
  onSubmit,
}: {
  match: RyderMatch | null;
  session: RyderSession | null;
  config: RyderConfig | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (matchId: number, result: string, holeResults: Record<number, string>, conceededByTeam?: string, conceededOnHole?: number) => void;
}) {
  const [result, setResult] = useState("player1_wins");
  const [conceededByTeam, setConceededByTeam] = useState("");
  const [conceededOnHole, setConceededOnHole] = useState("");

  if (!match || !session) return null;
  const t1 = config?.team1Name ?? session.team1Name;
  const t2 = config?.team2Name ?? session.team2Name;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md bg-gray-900 text-white border-white/10">
        <DialogHeader>
          <DialogTitle>Record Match Result — #{match.matchNumber}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="text-sm text-gray-300">
            <span style={{ color: config?.team1Colour ?? "#1e40af" }} className="font-medium">{t1}</span>
            <span className="text-gray-500 mx-2">vs</span>
            <span style={{ color: config?.team2Colour ?? "#dc2626" }} className="font-medium">{t2}</span>
          </div>
          <div className="space-y-2">
            <label className="text-sm text-gray-400">Result</label>
            <Select value={result} onValueChange={setResult}>
              <SelectTrigger className="bg-white/10 border-white/20 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="player1_wins">{t1} Wins (1 point)</SelectItem>
                <SelectItem value="player2_wins">{t2} Wins (1 point)</SelectItem>
                <SelectItem value="halved">Halved (½ point each)</SelectItem>
                <SelectItem value="conceded">Conceded</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {result === "conceded" && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-gray-400">Conceded by</label>
                <Select value={conceededByTeam} onValueChange={setConceededByTeam}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white text-xs">
                    <SelectValue placeholder="Team" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="team1">{t1}</SelectItem>
                    <SelectItem value="team2">{t2}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400">On hole</label>
                <input
                  type="number" min={1} max={18}
                  value={conceededOnHole}
                  onChange={e => setConceededOnHole(e.target.value)}
                  className="w-full rounded bg-white/10 border border-white/20 text-white px-2 py-1 text-xs"
                  placeholder="1-18"
                />
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
            <Button
              className="flex-1 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => {
                onSubmit(
                  match.id,
                  result,
                  {},
                  conceededByTeam || undefined,
                  conceededOnHole ? Number(conceededOnHole) : undefined,
                );
              }}
            >
              Save Result
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HoleScoringDialog({
  match,
  session,
  config,
  open,
  onClose,
  onSubmit,
}: {
  match: RyderMatch | null;
  session: RyderSession | null;
  config: RyderConfig | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (matchId: number, holeNumber: number, holeResult: "team1" | "team2" | "halved") => void;
}) {
  const [hole, setHole] = useState("1");
  const [holeResult, setHoleResult] = useState<"team1" | "team2" | "halved">("team1");

  if (!match || !session) return null;
  const t1 = config?.team1Name ?? session.team1Name;
  const t2 = config?.team2Name ?? session.team2Name;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md bg-gray-900 text-white border-white/10">
        <DialogHeader>
          <DialogTitle>Record Hole Result — Match #{match.matchNumber}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="text-sm text-gray-400">Status: <span className="text-white">{match.matchStatus ?? "All Square"}</span></div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Hole Number</label>
              <input
                type="number" min={1} max={18}
                value={hole}
                onChange={e => setHole(e.target.value)}
                className="w-full rounded bg-white/10 border border-white/20 text-white px-3 py-2"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Winner</label>
              <Select value={holeResult} onValueChange={v => setHoleResult(v as "team1" | "team2" | "halved")}>
                <SelectTrigger className="bg-white/10 border-white/20 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="team1">{t1}</SelectItem>
                  <SelectItem value="team2">{t2}</SelectItem>
                  <SelectItem value="halved">Halved</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* Show existing hole results */}
          {match.holeResults && Object.keys(match.holeResults).length > 0 && (
            <div>
              <div className="text-xs text-gray-400 mb-2">Recorded holes:</div>
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: 18 }, (_, i) => i + 1).map(h => {
                  const r = match.holeResults?.[h];
                  if (!r) return null;
                  return (
                    <div key={h} className={`text-xs px-2 py-1 rounded ${r === "team1" ? "bg-blue-800" : r === "team2" ? "bg-red-800" : "bg-yellow-800"}`}>
                      H{h}: {r === "team1" ? t1 : r === "team2" ? t2 : "H"}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
            <Button
              className="flex-1 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => {
                onSubmit(match.id, Number(hole), holeResult);
                onClose();
              }}
            >
              Record Hole
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function RyderCupPage() {
  const { id } = useParams<{ id: string }>();
  const orgId = useActiveOrgId();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const [configOpen, setConfigOpen] = useState(false);
  const [addSessionOpen, setAddSessionOpen] = useState(false);
  const [addMatchOpen, setAddMatchOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<RyderSession | null>(null);
  const [recordMatch, setRecordMatch] = useState<{ match: RyderMatch; session: RyderSession } | null>(null);
  const [holeMatch, setHoleMatch] = useState<{ match: RyderMatch; session: RyderSession } | null>(null);

  const ryderQuery = useQuery<RyderData>({
    queryKey: ["ryder-cup", id, orgId],
    queryFn: async () => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/ryder-cup`);
      if (!res.ok) throw new Error("Failed to load Ryder Cup data");
      return res.json();
    },
    enabled: !!orgId && !!id,
    refetchInterval: 15000,
  });

  const playersQuery = useQuery<Player[]>({
    queryKey: ["players", id, orgId],
    queryFn: async () => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/players`);
      if (!res.ok) throw new Error("Failed to load players");
      const data = await res.json();
      return Array.isArray(data) ? data : (data.players ?? []);
    },
    enabled: !!orgId && !!id,
  });

  const saveConfig = useMutation({
    mutationFn: async (data: { team1Name: string; team2Name: string; team1Colour: string; team2Colour: string; totalPoints: number; tieBreakRule: RyderTieBreakRule }) => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/ryder-cup/config`, {
        method: "POST",
        body: JSON.stringify(data),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ryder-cup", id, orgId] });
      setConfigOpen(false);
      toast({ title: "Teams configured" });
    },
  });

  const addSession = useMutation({
    mutationFn: async (data: { sessionType: string; name: string; scheduledDate?: string }) => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/ryder-cup/sessions`, {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ryder-cup", id, orgId] });
      toast({ title: "Session added" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const addMatch = useMutation({
    mutationFn: async ({ sessionId, data }: { sessionId: number; data: Record<string, number | undefined> }) => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/ryder-cup/sessions/${sessionId}/matches`, {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ryder-cup", id, orgId] });
      toast({ title: "Match added" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const recordResult = useMutation({
    mutationFn: async ({ matchId, result, holeResults, concededByTeam, concededOnHole }: { matchId: number; result: string; holeResults: Record<number, string>; concededByTeam?: string; concededOnHole?: number }) => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/ryder-cup/matches/${matchId}/result`, {
        method: "POST",
        body: JSON.stringify({ result, holeResults, concededByTeam, concededOnHole }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ryder-cup", id, orgId] });
      setRecordMatch(null);
      toast({ title: "Result recorded" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const recordHole = useMutation({
    mutationFn: async ({ matchId, holeNumber, holeResult }: { matchId: number; holeNumber: number; holeResult: string }) => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/ryder-cup/matches/${matchId}/hole`, {
        method: "POST",
        body: JSON.stringify({ holeNumber, holeResult }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ryder-cup", id, orgId] });
      toast({ title: "Hole recorded" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteSession = useMutation({
    mutationFn: async (sessionId: number) => {
      const res = await apiFetch(`/organizations/${orgId}/tournaments/${id}/ryder-cup/sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete session");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ryder-cup", id, orgId] });
      toast({ title: "Session deleted" });
    },
  });

  const data = ryderQuery.data;
  const config = data?.config ?? null;
  const sessions = data?.sessions ?? [];
  const matches = data?.matches ?? [];
  const totals = data?.runningTotals ?? { team1: 0, team2: 0 };
  const players = playersQuery.data ?? [];

  return (
    <div className="p-6 space-y-6 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-emerald-400" />
          <div>
            <h1 className="text-2xl font-bold text-white">Ryder Cup</h1>
            <p className="text-gray-400 text-sm">Team match play event management</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/tournaments/${id}`)}>
            Back to Tournament
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}>
            <Settings className="w-4 h-4 mr-2" />
            {config ? "Edit Teams" : "Configure Teams"}
          </Button>
          {config && (
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setAddSessionOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Session
            </Button>
          )}
        </div>
      </div>

      {/* Scoreboard */}
      {config && (
        <TeamScoreboard config={config} totals={totals} />
      )}

      {!config && (
        <Card className="glass-card border-dashed border-white/20">
          <CardContent className="py-16 text-center space-y-4">
            <Shield className="w-12 h-12 text-gray-600 mx-auto" />
            <div>
              <h3 className="text-white font-medium text-lg">Configure teams first</h3>
              <p className="text-gray-400 text-sm mt-1">Set team names, colours and total points to get started</p>
            </div>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setConfigOpen(true)}>
              <Settings className="w-4 h-4 mr-2" />
              Configure Teams
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Sessions */}
      {sessions.length > 0 && (
        <div className="space-y-6">
          {sessions.map(session => {
            const sessionMatches = matches.filter(m => m.sessionId === session.id);
            return (
              <Card key={session.id} className="glass-card">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-white text-lg flex items-center gap-2">
                        <Target className="w-4 h-4 text-emerald-400" />
                        {session.name}
                        <Badge variant="outline" className="text-xs">{sessionTypeLabel(session.sessionType)}</Badge>
                      </CardTitle>
                      {session.scheduledDate && (
                        <p className="text-gray-400 text-sm mt-1">
                          {new Date(session.scheduledDate).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setSelectedSession(session); setAddMatchOpen(true); }}
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        Add Match
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-400 hover:text-red-300"
                        onClick={() => deleteSession.mutate(session.id)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {sessionMatches.length === 0 ? (
                    <div className="text-center py-8 text-gray-500 text-sm">
                      No matches yet — add matches to this session
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-7 gap-2 text-xs text-gray-500 px-3 pb-1 border-b border-white/10">
                        <div>#</div>
                        <div className="col-span-2" style={{ color: config?.team1Colour ?? "#1e40af" }}>{config?.team1Name ?? "Team 1"}</div>
                        <div className="text-center">Score</div>
                        <div className="col-span-2 text-right" style={{ color: config?.team2Colour ?? "#dc2626" }}>{config?.team2Name ?? "Team 2"}</div>
                        <div></div>
                      </div>
                      {sessionMatches.map(match => (
                        <MatchRow
                          key={match.id}
                          match={match}
                          session={session}
                          config={config}
                          onRecord={(m, s) => setRecordMatch({ match: m, session: s })}
                          onHole={(m, s) => setHoleMatch({ match: m, session: s })}
                        />
                      ))}
                      <div className="border-t border-white/10 pt-2 flex justify-between text-xs text-gray-400 px-3">
                        <span>Session points:</span>
                        <span>
                          <span style={{ color: config?.team1Colour ?? "#1e40af" }}>
                            {sessionMatches.reduce((s, m) => s + Number(m.team1Points), 0)}
                          </span>
                          {" – "}
                          <span style={{ color: config?.team2Colour ?? "#dc2626" }}>
                            {sessionMatches.reduce((s, m) => s + Number(m.team2Points), 0)}
                          </span>
                        </span>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Dialogs */}
      <ConfigDialog
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        existing={config}
        onSave={data => saveConfig.mutate(data)}
      />
      <AddSessionDialog
        open={addSessionOpen}
        onClose={() => setAddSessionOpen(false)}
        onAdd={data => addSession.mutate(data)}
      />
      <AddMatchDialog
        open={addMatchOpen && !!selectedSession}
        onClose={() => { setAddMatchOpen(false); setSelectedSession(null); }}
        session={selectedSession}
        players={players}
        onAdd={(sessionId, data) => addMatch.mutate({ sessionId, data })}
      />
      <RecordResultDialog
        match={recordMatch?.match ?? null}
        session={recordMatch?.session ?? null}
        config={config}
        open={!!recordMatch}
        onClose={() => setRecordMatch(null)}
        onSubmit={(matchId, result, holeResults, concededByTeam, concededOnHole) => {
          recordResult.mutate({ matchId, result, holeResults, concededByTeam, concededOnHole });
        }}
      />
      <HoleScoringDialog
        match={holeMatch?.match ?? null}
        session={holeMatch?.session ?? null}
        config={config}
        open={!!holeMatch}
        onClose={() => setHoleMatch(null)}
        onSubmit={(matchId, holeNumber, holeResult) => {
          recordHole.mutate({ matchId, holeNumber, holeResult });
        }}
      />
    </div>
  );
}
