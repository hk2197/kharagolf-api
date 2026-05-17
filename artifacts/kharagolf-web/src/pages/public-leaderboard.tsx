import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { Wifi, WifiOff, Trophy, Monitor, Tv } from "lucide-react";
import { useGetMe } from "@workspace/api-client-react";
import { KharaGolfWordmark } from "@/components/kharagolf-brand";
import { resolveAvatarSrc } from "@/lib/avatarPresets";
import { trackImpression, trackClick } from "@/lib/trackSponsor";
import LiveOddsWidget from "@/components/LiveOddsWidget";
import PredictionGameWidget from "@/components/PredictionGameWidget";
import { FollowButton } from "@/components/FollowButton";
import { useFolloweeIds } from "@/hooks/useFolloweeIds";

interface HoleScore {
  hole: number; round: number; strokes: number; par: number; toPar: number; strokeIndex: number | null; stablefordPoints: number;
}
interface RoundScore {
  round: number; grossScore: number; scoreToPar: number; netScore: number | null; stablefordPoints: number | null; holesPlayed: number; isComplete: boolean;
}
interface Entry {
  playerId: number; userId?: number | null; playerName: string; position: number; positionDisplay: string;
  profileImage?: string | null;
  grossScore: number | null; netScore: number | null; scoreToPar: number | null; netToPar: number | null;
  stablefordPoints: number | null;
  thru: string; currentRound: number; roundScores: RoundScore[]; madeCut: boolean | null;
  flight: string | null; flights?: string[]; handicapIndex: number; playingHandicap: number;
  holeScores: HoleScore[];
  stats: { eagles: number; birdies: number; pars: number; bogeys: number; doublePlus: number; };
  isVerified: boolean;
  dns?: boolean;
  checkedIn?: boolean;
}
interface Sponsor { id: number; name: string; logoUrl: string | null; tier: string; websiteUrl: string | null; }
interface Leaderboard {
  tournamentId: number; tournamentName: string; format: string;
  coursePar: number; rounds: number; lastUpdated: string;
  entries: Entry[];
  netEntries: Entry[];
  stablefordEntries: Entry[];
  byFlight: Record<string, Entry[]>;
  flights: string[];
  organizationName: string | null;
  organizationLogoUrl: string | null;
  organizationPrimaryColor: string | null;
  sponsors: Sponsor[];
  leaderboardType?: string | null;
  availableViews?: string[];
}
interface SideGameResult { id: number; gameType: string; holeNumber: number | null; playerId: number; firstName: string | null; lastName: string | null; notes: string | null; prize: number | null; }
interface SkinResult { hole: number; round: number; winnerName: string | null; winnerScore: number | null; tied: boolean; carriedFrom: number | null; }
interface SideGameConfig { skinsEnabled: boolean; ctpEnabled: boolean; ldEnabled: boolean; greeniesEnabled: boolean; skinsPrize: number | null; ctpPrize: number | null; ldPrize: number | null; greeniesPrize: number | null; }
interface SideGameData { config: SideGameConfig | null; manual: SideGameResult[]; skins: SkinResult[]; }
interface GalleryItem { id: number; objectPath: string; caption: string | null; uploaderName: string | null; mediaType: string; createdAt: string; }

interface BracketMatch {
  id: number; round: number;
  player1Id: number; player1Name: string;
  player2Id: number; player2Name: string;
  winnerId: number | null; winnerName: string | null;
  result: string | null; isComplete: boolean;
}
interface BracketRound { round: number; label: string; matches: BracketMatch[]; }
interface BracketData { format: string; rounds: BracketRound[]; matches: BracketMatch[]; }

function BracketMatchCard({ match }: { match: BracketMatch }) {
  const p1Won = match.winnerId === match.player1Id;
  const p2Won = match.winnerId === match.player2Id;

  return (
    <div className="text-sm">
      {/* Player 1 */}
      <div className={`flex items-center justify-between gap-2 px-3 py-2 border-b border-[#1e3028] ${p1Won ? "bg-green-500/10" : ""}`}>
        <span className={`font-semibold truncate ${p1Won ? "text-green-400" : match.isComplete ? "text-gray-300" : "text-gray-200"}`}>
          {match.player1Name}
        </span>
        {p1Won && <span className="text-green-400 shrink-0 text-xs font-bold">W</span>}
      </div>
      {/* Player 2 */}
      <div className={`flex items-center justify-between gap-2 px-3 py-2 ${p2Won ? "bg-green-500/10" : ""}`}>
        <span className={`font-semibold truncate ${p2Won ? "text-green-400" : match.isComplete ? "text-gray-300" : "text-gray-200"}`}>
          {match.player2Name}
        </span>
        {p2Won && <span className="text-green-400 shrink-0 text-xs font-bold">W</span>}
      </div>
      {/* Result summary */}
      {match.result && (
        <div className="px-3 py-1 bg-[#0a1209] border-t border-[#1e3028]">
          <span className="text-[10px] text-gray-300">{match.result}</span>
        </div>
      )}
      {!match.isComplete && (
        <div className="px-3 py-1 bg-[#0a1209] border-t border-[#1e3028]">
          <span className="text-[10px] text-gray-400 italic">In progress / TBD</span>
        </div>
      )}
    </div>
  );
}

function scoreColor(toPar: number | null) {
  if (toPar === null) return "text-gray-400";
  if (toPar <= -2) return "text-amber-400";
  if (toPar === -1) return "text-red-400";
  if (toPar === 0) return "text-gray-300";
  if (toPar === 1) return "text-blue-400";
  return "text-purple-400";
}
function scoreBg(toPar: number | null) {
  if (toPar === null) return "bg-gray-700/40";
  if (toPar <= -2) return "bg-amber-500/20 border border-amber-500/40";
  if (toPar === -1) return "bg-red-500/20 border border-red-500/40";
  if (toPar === 0) return "bg-gray-600/30";
  if (toPar === 1) return "bg-blue-500/20 border border-blue-500/40";
  return "bg-purple-500/20 border border-purple-500/40";
}
function formatScore(n: number | null) {
  if (n === null) return "-";
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}
function posColor(pos: number) {
  if (pos === 1) return "text-amber-400 font-extrabold";
  if (pos === 2) return "text-slate-300 font-bold";
  if (pos === 3) return "text-amber-700 font-bold";
  return "text-gray-400 font-semibold";
}

function PlayerRow({ entry, mode, index, totalRounds, currentUserId, isFollowing, showFollow }: { entry: Entry; mode: "gross" | "net" | "stableford"; index: number; totalRounds: number; currentUserId?: number | null; isFollowing?: boolean; showFollow?: boolean }) {
  const toPar = mode === "net" ? entry.netToPar : mode === "stableford" ? null : entry.scoreToPar;
  const total = mode === "net" ? entry.netScore : mode === "stableford" ? entry.stablefordPoints : entry.grossScore;
  const isTop3 = entry.position <= 3 && total !== null;
  const missedCut = entry.madeCut === false;
  const isDns = entry.dns === true || entry.positionDisplay === "DNS";

  const isGold = entry.position === 1 && !missedCut && !isDns && total !== null;
  const isSilver = entry.position === 2 && !missedCut && !isDns && total !== null;
  const isBronze = entry.position === 3 && !missedCut && !isDns && total !== null;

  return (
    <div className={`flex items-center gap-2 px-3 py-2.5 border-b border-white/5 transition-colors
      ${isGold ? "bg-amber-500/8 border-l-2 border-l-amber-500/60" : isSilver ? "bg-slate-400/5" : isBronze ? "bg-orange-700/6" : "hover:bg-white/3"}
      ${missedCut || isDns ? "opacity-60" : ""}`}>
      <span className={`w-9 text-center text-sm shrink-0 font-semibold ${isDns ? "text-red-400" : missedCut ? "text-gray-400" : posColor(entry.position)}`}>
        {isDns ? "DNS" : missedCut ? "MC" : total !== null
          ? (isGold ? <span className="flex items-center justify-center gap-0.5"><span>🏆</span><span>1</span></span> : entry.positionDisplay)
          : "–"}
      </span>
      {/* Avatar */}
      {(() => {
        const src = resolveAvatarSrc(entry.profileImage);
        return src ? (
          <div className="w-6 h-6 rounded-full overflow-hidden shrink-0 ring-1 ring-white/10">
            <img src={src} alt="" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="w-6 h-6 rounded-full shrink-0 bg-white/10 flex items-center justify-center text-[10px] font-bold text-gray-400">
            {entry.playerName[0]?.toUpperCase() ?? '?'}
          </div>
        );
      })()}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`font-semibold text-sm truncate ${isGold ? "text-amber-100 font-extrabold" : isSilver ? "text-slate-200 font-bold" : isBronze ? "text-orange-200 font-bold" : isTop3 && !missedCut ? "text-white" : "text-gray-200"}`}>
            {entry.playerName}
          </span>
          {entry.isVerified && !missedCut && (
            <span className="text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 rounded px-1.5 py-0.5 shrink-0">✓</span>
          )}
          {isDns && (
            <span className="text-[10px] bg-red-900/30 text-red-400 border border-red-700/30 rounded px-1.5 py-0.5 shrink-0">DNS</span>
          )}
          {missedCut && !isDns && (
            <span className="text-[10px] bg-red-900/30 text-red-400 border border-red-700/30 rounded px-1.5 py-0.5 shrink-0">MC</span>
          )}
          {showFollow && entry.userId != null && entry.userId !== currentUserId && (
            <span className="shrink-0" onClick={e => e.stopPropagation()}>
              <FollowButton userId={entry.userId} initialFollowing={!!isFollowing} size="sm" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {entry.flight && (
            <span className="text-[11px] text-gray-300 bg-gray-700/50 px-1.5 py-0.5 rounded">{entry.flight}</span>
          )}
          {mode === "net" && (
            <span className="text-[11px] text-gray-300">HCP {entry.handicapIndex}</span>
          )}
          {totalRounds > 1 && entry.roundScores.length > 0 && (
            <span className="text-[10px] text-gray-400 font-mono">
              {entry.roundScores.map(rs =>
                rs.isComplete ? (rs.scoreToPar >= 0 ? `+${rs.scoreToPar}` : `${rs.scoreToPar}`) : `*${rs.scoreToPar}`
              ).join(" · ")}
            </span>
          )}
        </div>
      </div>
      <span className="text-gray-400 text-xs w-8 text-center shrink-0">{entry.thru}</span>
      <span className={`text-base font-bold w-8 text-center shrink-0 ${total !== null ? "text-white" : "text-gray-400"}`}>
        {total ?? "–"}
      </span>
      {mode === "stableford" ? (
        <div className="w-12 text-center rounded-md py-0.5 shrink-0 bg-emerald-500/20 border border-emerald-500/40">
          <span className={`font-bold tabular-nums ${isGold || isSilver || isBronze ? "text-[22px] font-extrabold" : "text-sm"} text-emerald-400`}>
            {total !== null ? `${total}` : "–"}
          </span>
        </div>
      ) : (
        <div className={`w-12 text-center rounded-md py-0.5 shrink-0 ${scoreBg(toPar)}`}>
          <span className={`font-bold tabular-nums ${isGold || isSilver || isBronze ? "text-[22px] font-extrabold" : "text-sm"} ${scoreColor(toPar)}`}>{formatScore(toPar)}</span>
        </div>
      )}
    </div>
  );
}

function ScorecardModal({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  // Group holeScores by round for multi-round display
  const rounds = Array.from(new Set(entry.holeScores.map(h => h.round))).sort((a, b) => a - b);
  const isMultiRound = rounds.length > 1;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg bg-[#111c17] border border-[#243b2e] rounded-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-[#243b2e] flex items-center justify-between">
          <div>
            <h3 className="font-bold text-white text-lg">{entry.playerName}</h3>
            <p className="text-gray-400 text-sm">Scorecard · HCP {entry.handicapIndex} (Playing: {entry.playingHandicap})</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">×</button>
        </div>
        {entry.holeScores.length === 0 ? (
          <div className="p-8 text-center text-gray-300">No scores recorded yet</div>
        ) : (
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            {isMultiRound && entry.roundScores.length > 1 && (
              <div className="flex gap-1 px-3 py-2 border-b border-[#243b2e] bg-[#0d1a15]">
                {entry.roundScores.map(rs => (
                  <div key={rs.round} className="flex-1 text-center">
                    <div className="text-[10px] text-gray-300 font-medium">R{rs.round}</div>
                    <div className={`text-sm font-bold ${scoreColor(rs.scoreToPar)}`}>{rs.grossScore}</div>
                    <div className={`text-[10px] ${scoreColor(rs.scoreToPar)}`}>{formatScore(rs.scoreToPar)}</div>
                  </div>
                ))}
                <div className="flex-1 text-center border-l border-[#243b2e] ml-1 pl-1">
                  <div className="text-[10px] text-gray-300 font-medium">TOT</div>
                  <div className="text-sm font-bold text-white">{entry.grossScore}</div>
                  <div className={`text-[10px] ${scoreColor(entry.scoreToPar)}`}>{formatScore(entry.scoreToPar)}</div>
                </div>
              </div>
            )}
            {rounds.map(rNum => {
              const rHoles = entry.holeScores.filter(h => h.round === rNum);
              const rGross = rHoles.reduce((a, h) => a + h.strokes, 0);
              const rPar = rHoles.reduce((a, h) => a + h.par, 0);
              return (
                <table key={rNum} className="w-full text-sm mb-0">
                  <caption className="sr-only">Round {rNum} hole-by-hole scorecard</caption>
                  {isMultiRound && (
                    <thead>
                      <tr className="bg-[#152b1e]">
                        <th scope="colgroup" colSpan={4} className="px-3 py-1.5 text-left text-green-400 font-semibold text-xs">Round {rNum}</th>
                      </tr>
                    </thead>
                  )}
                  {!isMultiRound && (
                    <thead>
                      <tr className="border-b border-[#243b2e]">
                        <th scope="col" className="px-3 py-2 text-left text-gray-300 font-medium">HOLE</th>
                        <th scope="col" className="px-3 py-2 text-center text-gray-300 font-medium">PAR</th>
                        <th scope="col" className="px-3 py-2 text-center text-gray-300 font-medium">SCORE</th>
                        <th scope="col" className="px-3 py-2 text-center text-gray-300 font-medium">+/-</th>
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {rHoles.map(h => (
                      <tr key={`${rNum}-${h.hole}`} className="border-b border-[#1e3028]/60">
                        <td className="px-3 py-2 text-gray-300">Hole {h.hole}</td>
                        <td className="px-3 py-2 text-center text-gray-400">{h.par}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-block w-7 h-7 rounded-full flex items-center justify-center font-bold text-sm
                            ${h.toPar <= -2 ? "bg-amber-500/30 text-amber-400 ring-1 ring-amber-500" :
                              h.toPar === -1 ? "bg-red-500/20 text-red-400 ring-1 ring-red-500" :
                              h.toPar === 0 ? "text-white" :
                              h.toPar === 1 ? "border border-blue-400/60 text-blue-400" :
                              "border-2 border-purple-400/60 text-purple-400"}`}>
                            {h.strokes}
                          </span>
                        </td>
                        <td className={`px-3 py-2 text-center font-semibold ${scoreColor(h.toPar)}`}>{formatScore(h.toPar)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-[#243b2e] bg-[#0b1512]">
                      <td className="px-3 py-2 text-gray-400 font-semibold">{isMultiRound ? `R${rNum} Total` : "TOTAL"}</td>
                      <td className="px-3 py-2 text-center text-gray-400 font-semibold">{rPar}</td>
                      <td className="px-3 py-2 text-center text-white font-bold">{rGross}</td>
                      <td className={`px-3 py-2 text-center font-bold ${scoreColor(rGross - rPar)}`}>{formatScore(rGross - rPar)}</td>
                    </tr>
                  </tfoot>
                </table>
              );
            })}
          </div>
        )}
        {entry.stats && (
          <div className="grid grid-cols-5 p-3 gap-2 border-t border-[#243b2e]">
            {[["🦅", "Eagles", entry.stats.eagles], ["🐦", "Birdies", entry.stats.birdies], ["⚑", "Pars", entry.stats.pars], ["", "Bogeys", entry.stats.bogeys], ["", "Dbl+", entry.stats.doublePlus]].map(([icon, label, val]) => (
              <div key={String(label)} className="text-center">
                <div className="text-lg">{icon}</div>
                <div className="text-white font-bold">{val}</div>
                <div className="text-[10px] text-gray-300">{label}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PublicLeaderboard() {
  const params = useParams<{ tournamentId: string }>();
  const tournamentId = parseInt(params.tournamentId ?? "0");
  const [, navigate] = useLocation();

  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [sideGames, setSideGames] = useState<SideGameData | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [galleryLightbox, setGalleryLightbox] = useState<GalleryItem | null>(null);
  const [bracket, setBracket] = useState<BracketData | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [activeFlight, setActiveFlight] = useState<string>("Overall");
  const [mode, setMode] = useState<"gross" | "net" | "stableford">("gross");
  const [listVisible, setListVisible] = useState(true);
  const handleModeChange = (v: "gross" | "net" | "stableford") => {
    setListVisible(false);
    setTimeout(() => { setMode(v); setListVisible(true); }, 180);
  };
  const [activeTab, setActiveTab] = useState<"leaderboard" | "bracket">("leaderboard");
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
  const [cumulativeView, setCumulativeView] = useState(false);
  const [cutSectionExpanded, setCutSectionExpanded] = useState(false);
  const sseRef = useRef<EventSource | null>(null);

  // Pre-fetch the IDs the viewer already follows so each leaderboard row's
  // <FollowButton> hydrates as "Following" without flashing "Follow" first
  // (Task #1420). useGetMe + useFolloweeIds quietly no-op when the viewer is
  // not signed in so the public leaderboard stays usable for spectators.
  const { data: me } = useGetMe();
  const followeeIds = useFolloweeIds();
  const followeeIdSet = useMemo(() => new Set<number>(followeeIds), [followeeIds]);
  const showFollow = !!me?.id;
  const currentUserId = me?.id ?? null;

  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  async function loadLeaderboard(cumulative: boolean) {
    try {
      const qs = cumulative ? "?view=cumulative" : "";
      const [lbRes, sgRes, galRes, bracketRes] = await Promise.all([
        fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/leaderboard${qs}`),
        fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/side-games`),
        fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/gallery`),
        fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/bracket`),
      ]);
      if (!lbRes.ok) throw new Error("Not found");
      const data: Leaderboard = await lbRes.json();
      setLeaderboard(data);
      const orgPrimary = data.organizationPrimaryColor ?? "#22c55e";
      document.documentElement.style.setProperty("--org-primary", orgPrimary);
      document.documentElement.style.setProperty("--org-primary-20", `${orgPrimary}33`);
      document.documentElement.style.setProperty("--org-primary-30", `${orgPrimary}4d`);
      if (data.flights.length > 0) setActiveFlight(data.flights[0]);
      const views = data.availableViews ?? (
        data.leaderboardType === 'net' ? ['net'] :
        data.leaderboardType === 'stableford' ? ['stableford'] :
        ['gross', 'net']
      );
      setMode(prev => views.includes(prev) ? prev : ((views[0] as typeof prev) ?? 'gross'));
      if (sgRes.ok) { const sg = await sgRes.json(); setSideGames(sg); }
      if (galRes.ok) { const gal = await galRes.json(); setGallery(gal); }
      if (bracketRes.ok) { const br = await bracketRes.json() as BracketData; setBracket(br); }
    } catch {
      setLeaderboard(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setCutSectionExpanded(false);
  }, [activeFlight, mode, cumulativeView, tournamentId]);

  useEffect(() => {
    loadLeaderboard(cumulativeView);

    const sse = new EventSource(`${baseUrl}/api/public/tournaments/${tournamentId}/leaderboard/stream`);
    sseRef.current = sse;
    sse.onopen = () => setConnected(true);
    sse.onerror = () => setConnected(false);
    sse.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data);
        if (parsed.type === "leaderboard_update") {
          loadLeaderboard(cumulativeView);
        }
      } catch {}
    };

    return () => { sse.close(); };
  }, [tournamentId, baseUrl, cumulativeView]);

  const displayEntries = (() => {
    if (!leaderboard) return [];
    if (activeFlight === "Overall") {
      if (mode === "net") return leaderboard.netEntries;
      if (mode === "stableford") return leaderboard.stablefordEntries ?? [];
      return leaderboard.entries;
    }
    if (mode === "net") {
      return leaderboard.netEntries.filter(e =>
        (e.flights?.length ? e.flights.includes(activeFlight) : e.flight === activeFlight)
      );
    }
    if (mode === "stableford") {
      return (leaderboard.stablefordEntries ?? []).filter(e =>
        (e.flights?.length ? e.flights.includes(activeFlight) : e.flight === activeFlight)
      );
    }
    return leaderboard.byFlight[activeFlight] ?? [];
  })();

  const allFlights = leaderboard
    ? ["Overall", ...leaderboard.flights.filter(f => f !== "Overall")]
    : ["Overall"];

  const survivorEntries = displayEntries.filter(e => e.madeCut !== false);
  const cutEntries = displayEntries.filter(e => e.madeCut === false);
  const cutApplied = cutEntries.length > 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b1512] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-3 border-green-500/30 border-t-green-500 rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">Loading leaderboard...</p>
        </div>
      </div>
    );
  }

  if (!leaderboard) {
    return (
      <div className="min-h-screen bg-[#0b1512] flex items-center justify-center">
        <div className="text-center p-8">
          <Trophy className="mx-auto mb-3 text-gray-400" size={48} />
          <h2 className="text-white text-xl font-bold">Tournament Not Found</h2>
          <p className="text-gray-400 mt-2">This leaderboard link may be invalid.</p>
        </div>
      </div>
    );
  }

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-[#0b1512] font-sans overflow-x-hidden focus:outline-none">
      {/* Header */}
      <div className="bg-[#142019] border-b border-[#243b2e] sticky top-0 z-20">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src={leaderboard.organizationLogoUrl ?? "/logo.png"}
                alt={leaderboard.organizationName ?? 'KharaGolf'}
                className="h-9 w-auto object-contain rounded flex-shrink-0"
              />
              <div className="min-w-0">
                <p className="text-[10px] font-bold tracking-widest uppercase mb-0.5" style={{ color: "var(--org-primary, #22c55e)" }}>
                  {leaderboard.organizationName
                    ? <>{leaderboard.organizationName} LIVE</>
                    : <><KharaGolfWordmark /> LIVE</>}
                </p>
                <h1 className="text-white font-bold text-lg leading-tight truncate">{leaderboard.tournamentName}</h1>
                <p className="text-gray-300 text-xs mt-0.5">
                  Par {leaderboard.coursePar} · Updated {new Date(leaderboard.lastUpdated).toLocaleTimeString()}
                </p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold ${connected ? "bg-green-500/15 text-green-400 border border-green-500/30" : "bg-red-500/15 text-red-400 border border-red-500/30"}`}>
                {connected ? <Wifi size={11} /> : <WifiOff size={11} />}
                {connected ? "LIVE" : "OFFLINE"}
              </div>
              <button
                onClick={() => navigate(`/leaderboard/${tournamentId}/display`)}
                className="flex items-center gap-1 text-[11px] text-gray-300 hover:text-green-300 transition-colors"
              >
                <Monitor size={11} /> Display mode
              </button>
            </div>
          </div>

          {/* Flight tabs */}
          {allFlights.length > 1 && (
            <div className="flex gap-1.5 mt-3 overflow-x-auto pb-0.5 -mx-1 px-1 scrollbar-none">
              {allFlights.map(f => (
                <button
                  key={f}
                  onClick={() => setActiveFlight(f)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
                    activeFlight === f
                      ? "bg-green-500 text-black"
                      : "bg-[#1a2c22] text-gray-400 border border-[#243b2e] hover:border-green-500/40"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          )}

          {/* Tab navigation: Leaderboard / Bracket */}
          <div className="flex gap-1 mt-2">
            <button
              onClick={() => setActiveTab("leaderboard")}
              className={`px-3 py-1 rounded text-xs font-semibold transition-all ${
                activeTab === "leaderboard" ? "bg-[#243b2e] text-green-400" : "text-gray-400 hover:text-gray-200"
              }`}
            >
              Leaderboard
            </button>
            {bracket && bracket.format === "match_play" && (
              <button
                onClick={() => setActiveTab("bracket")}
                className={`px-3 py-1 rounded text-xs font-semibold transition-all ${
                  activeTab === "bracket" ? "bg-[#243b2e] text-green-400" : "text-gray-400 hover:text-gray-200"
                }`}
              >
                Bracket
              </button>
            )}
          </div>

          {/* View tabs: Gross / Net / Stableford + Cumulative + Spectator + Kiosk */}
          {activeTab === "leaderboard" && (
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              {(() => {
                const views = leaderboard?.availableViews ?? (
                  leaderboard?.leaderboardType === 'gross' ? ['gross'] :
                  leaderboard?.leaderboardType === 'net' ? ['net'] :
                  leaderboard?.leaderboardType === 'stableford' ? ['stableford'] :
                  ['gross', 'net']
                );
                return views.map(v => (
                  <button
                    key={v}
                    onClick={() => handleModeChange(v as "gross" | "net" | "stableford")}
                    className={`px-3 py-1 rounded text-xs font-semibold transition-all ${
                      mode === v ? "bg-[#182e20] text-green-400" : "text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {v === "gross" ? "Gross" : v === "net" ? "Net" : "Stableford"}
                  </button>
                ));
              })()}
              {(leaderboard?.rounds ?? 1) > 1 && (
                <button
                  onClick={() => setCumulativeView(v => !v)}
                  className={`px-3 py-1 rounded text-xs font-semibold transition-all ${
                    cumulativeView ? "bg-[#182e20] text-green-400" : "text-gray-400 hover:text-gray-200"
                  }`}
                >
                  Cumulative
                </button>
              )}
              <a
                href={`${baseUrl}/spectator/${tournamentId}`}
                className="ml-auto text-[11px] text-gray-300 hover:text-green-300 transition-colors flex items-center gap-1"
              >
                👁 Spectator
              </a>
              <button
                onClick={() => navigate(`/leaderboard/${tournamentId}/kiosk`)}
                className="flex items-center gap-1 text-[11px] text-gray-300 hover:text-amber-300 transition-colors"
                title="Open kiosk mode for clubhouse display"
              >
                <Tv size={11} /> Kiosk
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bracket view */}
      {activeTab === "bracket" && bracket && bracket.rounds.length > 0 && (
        <div className="max-w-full mx-auto px-4 py-4 overflow-x-auto">
          <div className="flex gap-4 min-w-max pb-4">
            {bracket.rounds.map(rnd => (
              <div key={rnd.round} className="flex flex-col gap-3 w-56 shrink-0">
                <div className="text-center">
                  <span className="text-[10px] font-bold tracking-widest uppercase text-gray-300">{rnd.label}</span>
                </div>
                <div className="flex flex-col gap-3">
                  {rnd.matches.map(match => (
                    <div
                      key={match.id}
                      className={`border rounded-xl overflow-hidden ${match.isComplete ? "border-green-500/30 bg-[#0f2018]" : "border-[#1e3028] bg-[#0d1a10]"}`}
                    >
                      <BracketMatchCard match={match} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "bracket" && bracket && bracket.rounds.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Trophy className="text-gray-400" size={40} />
          <p className="text-gray-300">No bracket matches set up yet</p>
        </div>
      )}

      {/* Live odds & prediction widgets — Task #378 (read-only, not gambling) */}
      {activeTab === "leaderboard" && (
        <div className="max-w-2xl mx-auto px-4 pb-4 space-y-3">
          <LiveOddsWidget tournamentId={tournamentId} surface="web_public" />
          <PredictionGameWidget tournamentId={tournamentId} surface="web_public" />
        </div>
      )}

      {/* Column headers — leaderboard tab only */}
      {activeTab === "leaderboard" && (
      <div className={`max-w-2xl mx-auto transition-opacity duration-200 ${listVisible ? 'opacity-100' : 'opacity-0'}`}>
        {/* Cumulative View */}
        {cumulativeView && (leaderboard?.rounds ?? 1) > 1 ? (
          <div>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1e3028] overflow-x-auto">
              <span className="w-9 text-[10px] text-gray-400 text-center font-bold tracking-wide shrink-0">POS</span>
              <span className="flex-1 text-[10px] text-gray-400 font-bold tracking-wide min-w-[80px]">PLAYER</span>
              {Array.from({ length: leaderboard?.rounds ?? 1 }, (_, i) => (
                <span key={i} className="w-10 text-[10px] text-gray-400 text-center font-bold tracking-wide shrink-0">R{i + 1}</span>
              ))}
              <span className="w-12 text-[10px] text-gray-400 text-center font-bold tracking-wide shrink-0">TOT</span>
            </div>
            {displayEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <Trophy className="text-gray-400" size={40} />
                <p className="text-gray-300">No scores submitted yet</p>
              </div>
            ) : (
              <>
                {(() => {
                  const renderRow = (entry: Entry) => {
                    const toPar = mode === "net" ? entry.netToPar : entry.scoreToPar;
                    const total = mode === "net" ? entry.netScore : entry.grossScore;
                    let cumulative = 0;
                    return (
                      <div key={entry.playerId} className={`flex items-center gap-2 px-3 py-2.5 border-b border-white/5 overflow-x-auto hover:bg-white/2 cursor-pointer ${entry.madeCut === false ? "opacity-60" : ""}`} onClick={() => setSelectedEntry(entry)}>
                        <span className={`w-9 text-center text-sm shrink-0 font-semibold ${entry.madeCut === false ? "text-gray-400" : "text-gray-400"}`}>{entry.madeCut === false ? "MC" : entry.positionDisplay}</span>
                        <span className="flex-1 text-sm font-semibold text-gray-100 truncate min-w-[80px]">{entry.playerName}</span>
                        {showFollow && entry.userId != null && entry.userId !== currentUserId && (
                          <span className="shrink-0" onClick={e => e.stopPropagation()}>
                            <FollowButton
                              userId={entry.userId}
                              initialFollowing={followeeIdSet.has(entry.userId)}
                              size="sm"
                            />
                          </span>
                        )}
                        {Array.from({ length: leaderboard?.rounds ?? 1 }, (_, i) => {
                          const rs = entry.roundScores.find(r => r.round === i + 1);
                          if (rs) cumulative += rs.scoreToPar;
                          const cumuDisplay = rs ? (cumulative === 0 ? "E" : cumulative > 0 ? `+${cumulative}` : `${cumulative}`) : "–";
                          return (
                            <div key={i} className="w-10 text-center shrink-0">
                              {rs ? (
                                <>
                                  <div className="text-[10px] text-gray-300">{rs.grossScore}</div>
                                  <div className={`text-xs font-bold ${scoreColor(rs.scoreToPar)}`}>{cumuDisplay}</div>
                                </>
                              ) : (
                                <span className="text-gray-700 text-xs">–</span>
                              )}
                            </div>
                          );
                        })}
                        <div className={`w-12 text-center rounded-md py-0.5 shrink-0 text-sm font-bold ${toPar === null ? "text-gray-300" : scoreColor(toPar)}`}>
                          {total ?? "–"}
                        </div>
                      </div>
                    );
                  };
                  return (
                    <>
                      {survivorEntries.map(renderRow)}
                      {cutApplied && (
                        <>
                          <button
                            type="button"
                            onClick={() => setCutSectionExpanded(v => !v)}
                            className="w-full flex items-center gap-2 px-3 py-2.5 bg-[#0d1a15] border-t border-b border-[#243b2e] text-left hover:bg-[#11201a] transition-colors"
                            aria-expanded={cutSectionExpanded}
                            data-testid="cut-section-toggle"
                          >
                            <span className="text-[10px] font-bold tracking-widest text-gray-400 uppercase">Missed the Cut</span>
                            <span className="text-[11px] text-gray-300">— {cutEntries.length} player{cutEntries.length === 1 ? "" : "s"}</span>
                            <span className="ml-auto text-gray-300 text-xs">{cutSectionExpanded ? "▾" : "▸"}</span>
                          </button>
                          {cutSectionExpanded && cutEntries.map(renderRow)}
                        </>
                      )}
                    </>
                  );
                })()}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1e3028]">
              <span className="w-9 text-[10px] text-gray-400 text-center font-bold tracking-wide">POS</span>
              <span className="flex-1 text-[10px] text-gray-400 font-bold tracking-wide">PLAYER</span>
              <span className="w-8 text-[10px] text-gray-400 text-center font-bold tracking-wide">THRU</span>
              <span className="w-8 text-[10px] text-gray-400 text-center font-bold tracking-wide">TOT</span>
              <span className="w-12 text-[10px] text-gray-400 text-center font-bold tracking-wide">{mode === "stableford" ? "PTS" : "+/-"}</span>
            </div>

            {/* Entries */}
            {displayEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <Trophy className="text-gray-400" size={40} />
                <p className="text-gray-300">No scores submitted yet</p>
              </div>
            ) : (
              <>
                {survivorEntries.map((entry, i) => (
                  <div key={entry.playerId} onClick={() => setSelectedEntry(entry)} className="cursor-pointer">
                    <PlayerRow
                      entry={entry}
                      mode={mode}
                      index={i}
                      totalRounds={leaderboard?.rounds ?? 1}
                      currentUserId={currentUserId}
                      isFollowing={entry.userId != null && followeeIdSet.has(entry.userId)}
                      showFollow={showFollow}
                    />
                  </div>
                ))}
                {cutApplied && (
                  <>
                    <button
                      type="button"
                      onClick={() => setCutSectionExpanded(v => !v)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 bg-[#0d1a15] border-t border-b border-[#243b2e] text-left hover:bg-[#11201a] transition-colors"
                      aria-expanded={cutSectionExpanded}
                      data-testid="cut-section-toggle"
                    >
                      <span className="text-[10px] font-bold tracking-widest text-gray-400 uppercase">Missed the Cut</span>
                      <span className="text-[11px] text-gray-300">— {cutEntries.length} player{cutEntries.length === 1 ? "" : "s"}</span>
                      <span className="ml-auto text-gray-300 text-xs">{cutSectionExpanded ? "▾" : "▸"}</span>
                    </button>
                    {cutSectionExpanded && cutEntries.map((entry, i) => (
                      <div key={entry.playerId} onClick={() => setSelectedEntry(entry)} className="cursor-pointer">
                        <PlayerRow
                          entry={entry}
                          mode={mode}
                          index={survivorEntries.length + i}
                          totalRounds={leaderboard?.rounds ?? 1}
                          currentUserId={currentUserId}
                          isFollowing={entry.userId != null && followeeIdSet.has(entry.userId)}
                          showFollow={showFollow}
                        />
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
      )}

      {/* Legend */}
      <div className="max-w-2xl mx-auto px-4 py-4 flex flex-wrap gap-x-4 gap-y-1.5">
        {[["bg-amber-500/20 border border-amber-500/40", "text-amber-400", "Eagle or better"],
          ["bg-red-500/20 border border-red-500/40", "text-red-400", "Birdie"],
          ["bg-gray-600/30", "text-gray-300", "Par"],
          ["bg-blue-500/20 border border-blue-500/40", "text-blue-400", "Bogey"],
          ["bg-purple-500/20 border border-purple-500/40", "text-purple-400", "Double+"],
        ].map(([bg, text, label]) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className={`w-5 h-5 rounded text-xs flex items-center justify-center font-bold ${bg} ${text}`}>E</div>
            <span className="text-[11px] text-gray-300">{label}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] bg-green-500/20 text-green-400 border border-green-500/30 rounded px-1">✓</span>
          <span className="text-[11px] text-gray-300">Verified</span>
        </div>
      </div>

      {/* Side Games Results */}
      {sideGames?.config && (sideGames.config.skinsEnabled || sideGames.config.ctpEnabled || sideGames.config.ldEnabled || sideGames.config.greeniesEnabled) && (
        <div className="max-w-2xl mx-auto px-4 pb-6">
          <div className="border border-[#243b2e] rounded-2xl overflow-hidden">
            <div className="bg-[#142019] px-4 py-3 border-b border-[#243b2e]">
              <h2 className="text-white font-bold text-sm tracking-wide flex items-center gap-2">
                <Trophy size={14} className="text-amber-400" /> Side Games
              </h2>
            </div>

            {/* Skins */}
            {sideGames.config.skinsEnabled && sideGames.skins.filter(s => s.winnerName).length > 0 && (
              <div className="px-4 pt-4 pb-2">
                <p className="text-[10px] font-bold tracking-widest text-gray-300 uppercase mb-2">Skins</p>
                <div className="space-y-1.5">
                  {sideGames.skins.filter(s => s.winnerName).map(s => (
                    <div key={`${s.hole}-${s.round}`} className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">Hole {s.hole}{sideGames.skins.filter(sk => sk.winnerName).some(sk => sk.carriedFrom !== null) && s.carriedFrom ? ` (carried from ${s.carriedFrom})` : ''}</span>
                      <span className="text-amber-400 font-semibold">{s.winnerName}</span>
                      {s.winnerScore && <span className="text-gray-300 text-xs ml-2">{s.winnerScore}</span>}
                    </div>
                  ))}
                  {sideGames.skins.filter(s => s.tied).length > 0 && (
                    <p className="text-[11px] text-orange-400 mt-1">
                      {sideGames.skins.filter(s => s.tied).length} hole{sideGames.skins.filter(s => s.tied).length > 1 ? 's' : ''} carrying over
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* CTP / LD / Greenie manual results */}
            {(['ctp', 'ld', 'greenie'] as const).map(type => {
              const label = type === 'ctp' ? 'Closest to Pin' : type === 'ld' ? 'Longest Drive' : 'Greenie';
              const items = sideGames.manual.filter(r => r.gameType === type);
              if (items.length === 0) return null;
              return (
                <div key={type} className="px-4 pt-3 pb-2">
                  <p className="text-[10px] font-bold tracking-widest text-gray-300 uppercase mb-2">{label}</p>
                  <div className="space-y-1.5">
                    {items.map(r => (
                      <div key={r.id} className="flex items-center justify-between text-sm">
                        <span className="text-gray-400">{r.holeNumber ? `Hole ${r.holeNumber}` : 'Overall'}</span>
                        <div className="text-right">
                          <span className="text-white font-semibold">{r.firstName && r.lastName ? `${r.firstName} ${r.lastName}` : `Player #${r.playerId}`}</span>
                          {r.notes && <span className="ml-2 text-gray-300 text-xs">· {r.notes}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Photo Gallery */}
      {gallery.length > 0 && (
        <div className="max-w-2xl mx-auto px-4 pb-6">
          <div className="border border-[#243b2e] rounded-2xl overflow-hidden">
            <div className="bg-[#142019] px-4 py-3 border-b border-[#243b2e] flex items-center gap-2">
              <span className="text-lg">📷</span>
              <h2 className="text-white font-bold text-sm tracking-wide">Tournament Gallery</h2>
              <span className="ml-auto text-xs text-gray-300">{gallery.length} photo{gallery.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="grid grid-cols-3 gap-1 p-1 bg-[#0a1209]">
              {gallery.map(item => (
                <button
                  key={item.id}
                  className="relative aspect-square overflow-hidden rounded-md group"
                  onClick={() => setGalleryLightbox(item)}
                >
                  <img
                    src={`${baseUrl}/api/storage${item.objectPath}`}
                    alt={item.caption ?? ''}
                    className="w-full h-full object-cover transition-transform group-hover:scale-105"
                  />
                  {item.caption && (
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <p className="text-white text-[10px] line-clamp-2">{item.caption}</p>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {galleryLightbox && (
        <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center" onClick={() => setGalleryLightbox(null)}>
          <button className="absolute top-4 right-4 text-white/70 hover:text-white text-2xl" onClick={() => setGalleryLightbox(null)}>×</button>
          <img
            src={`${baseUrl}/api/storage${galleryLightbox.objectPath}`}
            alt={galleryLightbox.caption ?? ''}
            className="max-w-[92vw] max-h-[80vh] object-contain rounded-lg"
            onClick={e => e.stopPropagation()}
          />
          {(galleryLightbox.caption || galleryLightbox.uploaderName) && (
            <div className="mt-4 text-center px-8">
              {galleryLightbox.caption && <p className="text-white font-medium text-sm">{galleryLightbox.caption}</p>}
              {galleryLightbox.uploaderName && <p className="text-gray-300 text-xs mt-1">by {galleryLightbox.uploaderName}</p>}
            </div>
          )}
        </div>
      )}

      {/* Sponsor logos strip */}
      {leaderboard.sponsors && leaderboard.sponsors.length > 0 && (() => {
        leaderboard.sponsors.forEach(s => trackImpression(s.id, "leaderboard", leaderboard.tournamentId));
        return (
          <div className="border-t border-[#1a3028] bg-[#0d1a10] px-4 py-4">
            <p className="text-center text-[9px] text-gray-400 uppercase tracking-widest mb-3">Presented by</p>
            <div className="flex flex-wrap justify-center items-center gap-4">
              {leaderboard.sponsors.map(s => (
                s.logoUrl ? (
                  <a key={s.id} href={s.websiteUrl ?? undefined} target="_blank" rel="noopener noreferrer" title={s.name}
                    onClick={() => trackClick(s.id, "leaderboard", leaderboard.tournamentId)}>
                    <img src={s.logoUrl} alt={s.name} className="h-8 w-auto object-contain opacity-70 hover:opacity-100 transition-opacity" />
                  </a>
                ) : (
                  <span key={s.id} className="text-[10px] text-gray-300 font-semibold">{s.name}</span>
                )
              ))}
            </div>
          </div>
        );
      })()}

      {/* Tap a player for scorecard */}
      <p className="text-center text-[11px] text-gray-400 pb-6">Tap any player to view their scorecard</p>

      {/* Scorecard modal */}
      {selectedEntry && (
        <ScorecardModal entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
      )}
    </main>
  );
}
