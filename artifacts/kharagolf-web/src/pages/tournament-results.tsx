import React, { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { Trophy, Medal, Target, ArrowLeft, Zap, Flame, ChevronDown, ChevronUp, Share2, Check, FileDown, FileText, Download } from "lucide-react";
import { KharaGolfWordmark } from "@/components/kharagolf-brand";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type RoundScore = { round: number; grossScore: number; scoreToPar: number; netScore: number | null; stablefordPoints: number | null; holesPlayed: number; isComplete: boolean };

type EntryRow = {
  position: number;
  positionDisplay: string;
  playerId: number;
  playerName: string;
  grossScore: number | null;
  netScore: number | null;
  scoreToPar: number | null;
  netToPar: number | null;
  stablefordPoints: number | null;
  holesCompleted: number;
  thru: string;
  playingHandicap: number;
  madeCut: boolean | null;
  roundScores: RoundScore[];
};

type SideGameWinner = {
  id: number;
  gameType: string;
  holeNumber: number | null;
  playerId: number;
  firstName: string | null;
  lastName: string | null;
  notes: string | null;
  prize: string | null;
};

type SkinsResult = {
  hole: number;
  round: number;
  winnerId: number | null;
  winnerName: string | null;
  winnerScore: number | null;
  tied: boolean;
  carriedFrom: number | null;
};

type HoleScore = {
  id: number;
  holeNumber: number;
  round: number;
  strokes: number;
  putts: number | null;
  fairwayHit: boolean | null;
  girHit: boolean | null;
};

type Sponsor = {
  id: number;
  name: string;
  logoUrl: string | null;
  tier: string | null;
  websiteUrl: string | null;
  displayOrder: number | null;
};

type Results = {
  tournamentId: number;
  tournamentName: string;
  format: string;
  coursePar: number;
  rounds: number;
  entries: EntryRow[];
  netEntries: EntryRow[];
  sideGamesConfig: {
    skinsEnabled: boolean;
    skinsPrize: string | null;
    ctpEnabled: boolean;
    ldEnabled: boolean;
    greeniesEnabled: boolean;
  } | null;
  sideGameWinners: SideGameWinner[];
  skinsResults: SkinsResult[];
  organizationName: string | null;
  organizationLogoUrl: string | null;
  organizationPrimaryColor: string | null;
  sponsors: Sponsor[];
  leaderboardType?: string | null;
};

function formatScore(toPar: number | null): string {
  if (toPar === null) return "-";
  if (toPar === 0) return "E";
  if (toPar > 0) return `+${toPar}`;
  return String(toPar);
}

function scoreClass(toPar: number | null): string {
  if (toPar === null) return "text-muted-foreground";
  if (toPar <= -2) return "text-amber-400 font-bold";
  if (toPar === -1) return "text-red-400 font-semibold";
  if (toPar === 0) return "text-white";
  if (toPar === 1) return "text-blue-400";
  return "text-purple-400 font-bold";
}

function Podium({ entries, isStableford }: { entries: EntryRow[]; isStableford: boolean }) {
  const top3 = entries.filter(e => e.madeCut !== false).slice(0, 3);
  if (top3.length === 0) return null;

  const podiumOrder = top3.length === 3 ? [top3[1], top3[0], top3[2]] : top3.length === 2 ? [top3[0], top3[1]] : [top3[0]];
  const heights = top3.length === 3 ? ["h-20", "h-28", "h-16"] : ["h-24", "h-18"];
  const podiumPositions = top3.length === 3 ? [1, 0, 2] : [0, 1];

  return (
    <div className="rounded-xl border border-white/10 bg-gradient-to-b from-white/5 to-transparent p-6 mb-6">
      <div className="flex items-end justify-center gap-4 mb-4">
        {podiumOrder.map((entry, i) => {
          const origIdx = podiumPositions[i];
          const trophyIcon = origIdx === 0
            ? <Trophy className="w-8 h-8 text-yellow-400" />
            : origIdx === 1
            ? <Medal className="w-6 h-6 text-gray-300" />
            : <Medal className="w-6 h-6 text-amber-600" />;

          return (
            <div key={entry.playerId} className="flex flex-col items-center gap-2">
              {trophyIcon}
              <div className="text-center">
                <div className="font-display font-bold text-white text-sm leading-tight">{entry.playerName}</div>
                <div className="text-xs text-muted-foreground">HCP {entry.playingHandicap}</div>
                <div className={`text-lg font-mono font-bold ${origIdx === 0 ? "text-yellow-400" : "text-white"}`}>
                  {isStableford ? `${entry.stablefordPoints ?? "-"} pts` : formatScore(entry.scoreToPar)}
                </div>
              </div>
              <div className={`w-24 ${heights[i]} bg-gradient-to-t ${origIdx === 0 ? "from-yellow-500/30 to-yellow-500/10 border-yellow-500/40" : "from-white/10 to-white/5 border-white/20"} border rounded-t-lg flex items-center justify-center`}>
                <span className="text-2xl font-display font-black text-white/60">{origIdx + 1}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ShareButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try { await navigator.share({ title, url }); return; } catch { /* fall through to copy */ }
    }
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleShare}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-white transition-colors px-2 py-1 rounded-lg border border-white/10 hover:border-white/20"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Share2 className="w-3.5 h-3.5" />}
      {copied ? "Copied" : "Share"}
    </button>
  );
}

function ScorecardDrilldown({ tournamentId, playerId, rounds }: { tournamentId: number; playerId: number; rounds: number }) {
  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  const [scores, setScores] = useState<HoleScore[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/players/${playerId}/scores`)
      .then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); })
      .then(setScores)
      .catch(() => setScores([]))
      .finally(() => setLoading(false));
  }, [tournamentId, playerId]);

  if (loading) {
    return <TableRow><TableCell colSpan={20} className="py-4 text-center"><div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" /></TableCell></TableRow>;
  }

  if (!scores || scores.length === 0) {
    return <TableRow className="bg-black/20"><TableCell colSpan={20} className="py-3 text-center text-muted-foreground text-sm">No scores recorded yet</TableCell></TableRow>;
  }

  const holeNums = Array.from({ length: 18 }, (_, i) => i + 1);

  return (
    <TableRow className="bg-black/30 hover:bg-black/30 border-white/10">
      <TableCell colSpan={20} className="p-0">
        <div className="px-4 py-3 overflow-x-auto">
          {Array.from({ length: rounds }, (_, ri) => {
            const roundNum = ri + 1;
            const roundScores = scores.filter(s => s.round === roundNum);
            if (roundScores.length === 0 && rounds > 1) return null;
            const scoreMap = new Map(roundScores.map(s => [s.holeNumber, s]));
            const totalStrokes = roundScores.reduce((a, s) => a + s.strokes, 0);
            return (
              <div key={roundNum} className={rounds > 1 ? "mb-3" : ""}>
                {rounds > 1 && <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Round {roundNum}</div>}
                <div className="flex items-center gap-1 flex-wrap">
                  {holeNums.map(h => {
                    const s = scoreMap.get(h);
                    return (
                      <div key={h} className="flex flex-col items-center">
                        <span className="text-muted-foreground text-[10px] leading-none mb-0.5">{h}</span>
                        <div className={`w-7 h-7 rounded flex items-center justify-center text-sm font-mono font-bold ${s ? "bg-white/10 text-white" : "bg-white/5 text-white/20"}`}>
                          {s?.strokes ?? "-"}
                        </div>
                      </div>
                    );
                  })}
                  {roundScores.length > 0 && (
                    <div className="flex flex-col items-center ml-2">
                      <span className="text-muted-foreground text-[10px] leading-none mb-0.5">TOT</span>
                      <div className="w-10 h-7 rounded bg-primary/20 flex items-center justify-center text-sm font-mono font-bold text-primary">{totalStrokes}</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </TableCell>
    </TableRow>
  );
}

function PublicEventDocuments({ baseUrl, tournamentId }: { baseUrl: string; tournamentId: number }) {
  const [docs, setDocs] = useState<Array<{ documentId: number; title: string; category: string; filename: string | null; fileSize: number | null }>>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/documents`)
      .then(r => r.ok ? r.json() : [])
      .then(d => { setDocs(d); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [baseUrl, tournamentId]);

  if (!loaded || docs.length === 0) return null;

  const CATEGORY_COLORS: Record<string, string> = {
    local_rules: 'bg-emerald-500/20 text-emerald-400',
    pace_of_play: 'bg-blue-500/20 text-blue-400',
    policy: 'bg-violet-500/20 text-violet-400',
    general: 'bg-gray-500/20 text-gray-400',
    results: 'bg-amber-500/20 text-amber-400',
    notice: 'bg-rose-500/20 text-rose-400',
  };

  const CATEGORY_LABELS: Record<string, string> = {
    local_rules: 'Local Rules', pace_of_play: 'Pace of Play', policy: 'Policy', general: 'General', results: 'Results', notice: 'Notice',
  };

  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-5">
      <p className="text-xs text-muted-foreground uppercase tracking-widest mb-4 flex items-center gap-2">
        <FileText className="w-3.5 h-3.5" /> Event Documents
      </p>
      <div className="space-y-2">
        {docs.map(doc => (
          <a
            key={doc.documentId}
            href={`${baseUrl}/api/public/tournaments/${tournamentId}/documents/${doc.documentId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-white/5 hover:bg-white/10 transition-colors group"
          >
            <div className="flex items-center gap-3">
              <FileText className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <div>
                <p className="text-white text-sm font-medium">{doc.title}</p>
                {doc.filename && <p className="text-muted-foreground text-xs">{doc.filename}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge className={`text-xs ${CATEGORY_COLORS[doc.category] ?? CATEGORY_COLORS.general}`}>
                {CATEGORY_LABELS[doc.category] ?? doc.category}
              </Badge>
              <Download className="w-3.5 h-3.5 text-muted-foreground group-hover:text-white transition-colors" />
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

export default function TournamentResultsPage() {
  const params = useParams<{ tournamentId: string }>();
  const tournamentId = parseInt(params.tournamentId ?? "0");
  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/results`)
      .then(r => {
        if (!r.ok) return Promise.reject(r.status === 403 ? "not-completed" : "not-found");
        return r.json();
      })
      .then(setResults)
      .catch((reason) => setError(reason === "not-completed" ? "not-completed" : "not-found"))
      .finally(() => setLoading(false));
  }, [tournamentId]);

  useEffect(() => {
    if (results?.organizationPrimaryColor) {
      document.documentElement.style.setProperty("--org-primary", results.organizationPrimaryColor);
    }
  }, [results?.organizationPrimaryColor]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !results) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-white">
        <Trophy className="w-16 h-16 text-muted-foreground mb-4 opacity-40" />
        <h1 className="text-2xl font-display font-bold mb-2">
          {error === "not-completed" ? "Results Not Yet Available" : "Tournament Not Found"}
        </h1>
        <p className="text-muted-foreground text-sm mb-4">
          {error === "not-completed" ? "Results will be published once the tournament is completed." : "This tournament does not exist or results have not been published."}
        </p>
        <Link href="/" className="text-primary hover:underline mt-4 flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to home
        </Link>
      </div>
    );
  }

  const isStableford = results.format === "stableford";
  const isNet = results.format === "net_stroke";
  const lbType = results.leaderboardType ?? 'both';
  const showNet = lbType === 'net' || (lbType !== 'gross' && (isNet || results.entries.some(e => e.netToPar !== null && e.netToPar !== e.scoreToPar)));
  const sideWinners = results.sideGameWinners ?? [];
  const ctpWinners = sideWinners.filter(w => w.gameType === "ctp");
  const ldWinners = sideWinners.filter(w => w.gameType === "ld");
  const greenieWinners = sideWinners.filter(w => w.gameType === "greenie");
  const skinsResults = (results.skinsResults ?? []).filter(s => s.winnerId !== null || s.tied);
  const showSkins = results.sideGamesConfig?.skinsEnabled && skinsResults.length > 0;

  return (
    <div className="min-h-screen bg-background text-white">
      <div className="border-b border-white/10 bg-black/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={results.organizationLogoUrl ?? "/logo.png"} alt="KharaGolf" className="w-8 h-8 object-contain rounded" />
            <div>
              <h1 className="font-display font-bold text-lg">{results.tournamentName}</h1>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">
                <KharaGolfWordmark /> · {results.format.replace(/_/g, " ")} · Final Results
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={`${baseUrl}/api/public/tournaments/${tournamentId}/results/pdf`}
              download
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white transition-colors px-2 py-1 rounded-lg border border-white/10 hover:border-white/20"
            >
              <FileDown className="w-3.5 h-3.5" />
              PDF Report
            </a>
            <ShareButton title={`${results.tournamentName} — Final Results`} />
            <Link href={`${baseUrl}/leaderboard/${tournamentId}`} className="text-xs text-primary hover:underline flex items-center gap-1">
              Live Leaderboard →
            </Link>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <Podium entries={lbType === "net" ? (results.netEntries ?? results.entries) : results.entries} isStableford={isStableford} />

        <Tabs defaultValue={lbType === "net" ? "net" : "gross"}>
          <TabsList className="bg-white/5 border border-white/10 flex-wrap h-auto gap-1">
            {lbType !== "net" && (
              <TabsTrigger value="gross" className="data-[state=active]:bg-primary data-[state=active]:text-black">
                {isStableford ? "Stableford" : "Gross"}
              </TabsTrigger>
            )}
            {showNet && <TabsTrigger value="net" className="data-[state=active]:bg-primary data-[state=active]:text-black">Net</TabsTrigger>}
            {showSkins && (
              <TabsTrigger value="skins" className="data-[state=active]:bg-primary data-[state=active]:text-black">
                <Flame className="w-3.5 h-3.5 mr-1" /> Skins
              </TabsTrigger>
            )}
            {ctpWinners.length > 0 && (
              <TabsTrigger value="ctp" className="data-[state=active]:bg-primary data-[state=active]:text-black">
                <Target className="w-3.5 h-3.5 mr-1" /> CTP
              </TabsTrigger>
            )}
            {ldWinners.length > 0 && (
              <TabsTrigger value="ld" className="data-[state=active]:bg-primary data-[state=active]:text-black">
                <Zap className="w-3.5 h-3.5 mr-1" /> Long Drive
              </TabsTrigger>
            )}
            {greenieWinners.length > 0 && (
              <TabsTrigger value="greenies" className="data-[state=active]:bg-primary data-[state=active]:text-black">
                <Medal className="w-3.5 h-3.5 mr-1" /> Greenies
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="gross" className="mt-4">
            <ResultsTable
              entries={results.entries}
              isStableford={isStableford}
              totalRounds={results.rounds}
              coursePar={results.coursePar}
              tournamentId={tournamentId}
            />
          </TabsContent>

          {showNet && (
            <TabsContent value="net" className="mt-4">
              <ResultsTable
                entries={results.netEntries}
                isStableford={false}
                totalRounds={results.rounds}
                coursePar={results.coursePar}
                useNet
                tournamentId={tournamentId}
              />
            </TabsContent>
          )}

          {showSkins && (
            <TabsContent value="skins" className="mt-4">
              <SkinsSection skinsResults={skinsResults} skinsPrize={results.sideGamesConfig?.skinsPrize ?? null} />
            </TabsContent>
          )}

          {ctpWinners.length > 0 && (
            <TabsContent value="ctp" className="mt-4">
              <SideGameSection title="Closest to Pin" icon={<Target className="w-4 h-4 text-green-400" />} winners={ctpWinners} />
            </TabsContent>
          )}

          {ldWinners.length > 0 && (
            <TabsContent value="ld" className="mt-4">
              <SideGameSection title="Longest Drive" icon={<Zap className="w-4 h-4 text-yellow-400" />} winners={ldWinners} />
            </TabsContent>
          )}

          {greenieWinners.length > 0 && (
            <TabsContent value="greenies" className="mt-4">
              <SideGameSection title="Greenies" icon={<Medal className="w-4 h-4 text-emerald-400" />} winners={greenieWinners} />
            </TabsContent>
          )}
        </Tabs>

        <PublicEventDocuments baseUrl={baseUrl} tournamentId={tournamentId} />

        {results.sponsors && results.sponsors.length > 0 && (
          <div className="rounded-xl border border-white/10 bg-black/30 p-5">
            <p className="text-xs text-muted-foreground uppercase tracking-widest mb-4">Tournament Sponsors</p>
            <div className="flex flex-wrap gap-5 items-center">
              {results.sponsors.map(s => (
                <a
                  key={s.id}
                  href={s.websiteUrl ?? undefined}
                  target={s.websiteUrl ? "_blank" : undefined}
                  rel="noopener noreferrer"
                  className="flex flex-col items-center gap-2 hover:opacity-80 transition-opacity"
                >
                  {s.logoUrl ? (
                    <img src={s.logoUrl} alt={s.name} className="h-10 w-auto object-contain max-w-[120px]" />
                  ) : (
                    <span className="text-sm font-semibold text-white/80 px-3 py-1.5 rounded border border-white/10 bg-white/5">{s.name}</span>
                  )}
                  {s.tier && (
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.tier}</span>
                  )}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultsTable({
  entries, isStableford, totalRounds, coursePar, useNet = false, tournamentId,
}: { entries: EntryRow[]; isStableford: boolean; totalRounds: number; coursePar: number; useNet?: boolean; tournamentId: number }) {
  const [expandedPlayer, setExpandedPlayer] = useState<number | null>(null);
  const [selectedRound, setSelectedRound] = useState<number>(0); // 0 = Total
  const [cutSectionExpanded, setCutSectionExpanded] = useState(false);
  void coursePar; void tournamentId;

  // Derive sorted entries for the selected round (sort by gross score ascending, or stableford descending)
  const sortedEntries = selectedRound === 0
    ? entries
    : [...entries].sort((a, b) => {
        const aRs = a.roundScores.find(r => r.round === selectedRound);
        const bRs = b.roundScores.find(r => r.round === selectedRound);
        if (isStableford) {
          const aScore = aRs ? -(aRs.stablefordPoints ?? 0) : Infinity;
          const bScore = bRs ? -(bRs.stablefordPoints ?? 0) : Infinity;
          return aScore - bScore;
        }
        const aScore = aRs ? aRs.grossScore : Infinity;
        const bScore = bRs ? bRs.grossScore : Infinity;
        return aScore - bScore;
      });

  // When viewing the Total column, group the missed-the-cut players into a
  // collapsible block under the survivors. Per-round views show every player
  // sorted by that round's score, since the cut decision is independent of
  // any single round.
  const survivorEntries = selectedRound === 0 ? sortedEntries.filter(e => e.madeCut !== false) : sortedEntries;
  const cutEntries = selectedRound === 0 ? sortedEntries.filter(e => e.madeCut === false) : [];
  const colSpan = 4 + (selectedRound === 0 && totalRounds > 1 ? totalRounds : 0);

  return (
    <div className="rounded-lg overflow-hidden border border-white/10 bg-black/30">
      {totalRounds > 1 && (
        <div className="flex items-center gap-1.5 px-4 pt-4 pb-2 border-b border-white/5">
          <button
            onClick={() => setSelectedRound(0)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${selectedRound === 0 ? "bg-primary text-black" : "bg-white/5 text-muted-foreground hover:text-white"}`}
          >
            Total
          </button>
          {Array.from({ length: totalRounds }, (_, i) => (
            <button
              key={i}
              onClick={() => setSelectedRound(i + 1)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${selectedRound === i + 1 ? "bg-primary text-black" : "bg-white/5 text-muted-foreground hover:text-white"}`}
            >
              R{i + 1}
            </button>
          ))}
        </div>
      )}
      <div className="overflow-x-auto relative">
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10 rounded-br-lg" />
      <Table>
        <TableHeader>
          <TableRow className="border-white/10 hover:bg-transparent sticky top-0 z-10 bg-black/60 backdrop-blur-sm">
            <TableHead className="text-muted-foreground w-12 sticky left-0 z-10 bg-black/60">Pos</TableHead>
            <TableHead className="text-muted-foreground">Player</TableHead>
            <TableHead className="text-muted-foreground text-right">HCP</TableHead>
            {selectedRound === 0 && totalRounds > 1 && Array.from({ length: totalRounds }, (_, i) => (
              <TableHead key={i} className="text-muted-foreground text-right hidden sm:table-cell">R{i + 1}</TableHead>
            ))}
            <TableHead className="text-muted-foreground text-right">
              {selectedRound > 0 ? `R${selectedRound}` : isStableford ? "Pts" : "Score"}
            </TableHead>
            <TableHead className="text-muted-foreground text-right">
              {isStableford ? "Total" : useNet ? "Net" : "Total"}
            </TableHead>
            <TableHead className="text-muted-foreground w-12">Thru</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(() => {
            const renderRow = (e: EntryRow, idx: number, opts: { isCut: boolean }) => {
            const isMC = opts.isCut;
            const isTop3 = !isMC && idx < 3;
            const isExpanded = expandedPlayer === e.playerId;
            const selectedRoundData = selectedRound > 0 ? e.roundScores.find(r => r.round === selectedRound) : null;
            return (
              <>
                <TableRow
                  key={e.playerId}
                  className={`border-white/5 cursor-pointer select-none ${isMC ? "opacity-60" : ""} ${idx % 2 === 0 ? "bg-white/[0.02]" : ""} ${isTop3 ? "border-l-2 border-l-yellow-500/40" : ""} ${isExpanded ? "bg-white/5" : "hover:bg-white/5"}`}
                  onClick={() => setExpandedPlayer(isExpanded ? null : e.playerId)}
                >
                  <TableCell className="font-mono text-sm text-muted-foreground sticky left-0 z-10 bg-card/90">
                    {isMC
                      ? <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs px-1">MC</Badge>
                      : idx === 0
                      ? <Trophy className="w-4 h-4 text-yellow-400 inline" />
                      : idx === 1
                      ? <Medal className="w-4 h-4 text-gray-300 inline" />
                      : idx === 2
                      ? <Medal className="w-4 h-4 text-amber-600 inline" />
                      : e.positionDisplay}
                  </TableCell>
                  <TableCell className="font-medium text-white">
                    <div className="flex items-center gap-1">
                      {e.playerName}
                      {isExpanded
                        ? <ChevronUp className="w-3 h-3 text-muted-foreground" />
                        : <ChevronDown className="w-3 h-3 text-muted-foreground opacity-40" />}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm">{e.playingHandicap}</TableCell>
                  {selectedRound === 0 && totalRounds > 1 && Array.from({ length: totalRounds }, (_, i) => {
                    const rs = e.roundScores.find(r => r.round === i + 1);
                    return (
                      <TableCell key={i} className="text-right hidden sm:table-cell">
                        {rs ? (
                          <span className={scoreClass(isStableford ? null : rs.scoreToPar)}>
                            {isStableford ? rs.stablefordPoints ?? "-" : rs.grossScore}
                          </span>
                        ) : "-"}
                      </TableCell>
                    );
                  })}
                  <TableCell className={`text-right ${selectedRoundData ? scoreClass(isStableford ? null : selectedRoundData.scoreToPar) : scoreClass(useNet ? e.netToPar : isStableford ? null : e.scoreToPar)}`}>
                    {selectedRoundData
                      ? (isStableford ? (selectedRoundData.stablefordPoints ?? "-") : formatScore(selectedRoundData.scoreToPar))
                      : isStableford ? (e.stablefordPoints ?? "-") : useNet ? formatScore(e.netToPar) : formatScore(e.scoreToPar)}
                  </TableCell>
                  <TableCell className="text-right text-white font-mono">
                    {selectedRoundData
                      ? (isStableford ? (selectedRoundData.stablefordPoints ?? "-") : selectedRoundData.grossScore)
                      : isStableford ? (e.stablefordPoints ?? "-") : useNet ? (e.netScore ?? "-") : (e.grossScore ?? "-")}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{e.thru}</TableCell>
                </TableRow>
                {isExpanded && (
                  <ScorecardDrilldown tournamentId={tournamentId} playerId={e.playerId} rounds={totalRounds} />
                )}
              </>
            );
            };
            return (
              <>
                {survivorEntries.map((e, idx) => (
                  <React.Fragment key={`s-${e.playerId}`}>{renderRow(e, idx, { isCut: false })}</React.Fragment>
                ))}
                {cutEntries.length > 0 && (
                  <TableRow key="cut-toggle" className="border-none hover:bg-transparent">
                    <TableCell colSpan={colSpan} className="p-0">
                      <button
                        type="button"
                        onClick={() => setCutSectionExpanded(v => !v)}
                        aria-expanded={cutSectionExpanded}
                        data-testid="results-cut-toggle"
                        className="w-full flex items-center gap-2 px-4 py-2.5 bg-black/40 border-y border-white/10 text-left hover:bg-white/5 transition-colors"
                      >
                        <span className="text-xs text-red-400 font-semibold uppercase tracking-widest">Missed the Cut</span>
                        <span className="text-xs text-muted-foreground">— {cutEntries.length} player{cutEntries.length === 1 ? "" : "s"}</span>
                        <span className="ml-auto text-muted-foreground text-xs">{cutSectionExpanded ? "▾" : "▸"}</span>
                      </button>
                    </TableCell>
                  </TableRow>
                )}
                {cutSectionExpanded && cutEntries.map((e, idx) => (
                  <React.Fragment key={`c-${e.playerId}`}>{renderRow(e, idx, { isCut: true })}</React.Fragment>
                ))}
              </>
            );
          })()}
        </TableBody>
      </Table>
      </div>
      <p className="text-xs text-muted-foreground px-4 py-2 border-t border-white/5">Click a player row to view their hole-by-hole scorecard</p>
    </div>
  );
}

function SkinsSection({ skinsResults, skinsPrize }: { skinsResults: SkinsResult[]; skinsPrize: string | null }) {
  const winners = skinsResults.filter(s => s.winnerId !== null);
  const ties = skinsResults.filter(s => s.tied);

  return (
    <div className="rounded-lg border border-white/10 bg-black/30 overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-orange-400" />
          <h3 className="font-semibold text-white">Skins</h3>
        </div>
        {skinsPrize && <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">Prize: ₹{skinsPrize}</Badge>}
      </div>
      <div className="divide-y divide-white/5">
        {winners.map(s => (
          <div key={`${s.round}-${s.hole}`} className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground text-sm w-16">Hole {s.hole}</span>
              <span className="text-white font-medium">{s.winnerName}</span>
              {s.carriedFrom && <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">Carry from {s.carriedFrom}</Badge>}
            </div>
            <span className="text-muted-foreground text-sm font-mono">{s.winnerScore}</span>
          </div>
        ))}
        {ties.length > 0 && (
          <div className="px-4 py-2 text-muted-foreground text-xs">
            Tied holes (no skin): {ties.map(t => t.hole).join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}

function SideGameSection({ title, icon, winners }: { title: string; icon: React.ReactNode; winners: SideGameWinner[] }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
        {icon}
        <h3 className="font-semibold text-white">{title}</h3>
      </div>
      <div className="divide-y divide-white/5">
        {winners.map(w => (
          <div key={w.id} className="px-4 py-3 flex items-center justify-between">
            <div>
              <span className="text-white font-medium">{w.firstName} {w.lastName}</span>
              {w.holeNumber && <span className="ml-2 text-muted-foreground text-sm">· Hole {w.holeNumber}</span>}
              {w.notes && <span className="ml-2 text-muted-foreground text-xs">· {w.notes}</span>}
            </div>
            {w.prize && <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">₹{w.prize}</Badge>}
          </div>
        ))}
      </div>
    </div>
  );
}
