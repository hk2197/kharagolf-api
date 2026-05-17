import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "wouter";
import { Wifi, WifiOff, Trophy, Star, StarOff, Bell, BellOff, Users, Camera, QrCode, UsersRound, Clock, Activity, Send } from "lucide-react";
import { useGetMe } from "@workspace/api-client-react";
import { KharaGolfWordmark } from "@/components/kharagolf-brand";
import { resolveAvatarSrc } from "@/lib/avatarPresets";
import i18n, { getLocale } from "@/i18n";
import AdSlot from "@/components/AdSlot";
import LiveOddsWidget from "@/components/LiveOddsWidget";
import { FollowButton } from "@/components/FollowButton";
import { useFolloweeIds } from "@/hooks/useFolloweeIds";

interface HoleScore {
  hole: number; round: number; strokes: number; par: number; toPar: number; strokeIndex: number | null; stablefordPoints: number; isVerified: boolean;
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
  flight: string | null; handicapIndex: number; playingHandicap: number;
  holeScores: HoleScore[];
  stats: { eagles: number; birdies: number; pars: number; bogeys: number; doublePlus: number; };
  isVerified: boolean; dns?: boolean;
}
interface Leaderboard {
  tournamentId: number; tournamentName: string; format: string;
  coursePar: number; rounds: number; lastUpdated: string;
  entries: Entry[];
  netEntries: Entry[];
  byFlight: Record<string, Entry[]>;
  flights: string[];
  organizationName: string | null;
  organizationLogoUrl: string | null;
  organizationPrimaryColor: string | null;
  leaderboardType?: string | null;
}
interface TeeTimePlayer { playerId: number; firstName: string; lastName: string; flight: string | null; handicapIndex: number | null; }
interface TeeTimeGroup { id: number; teeTime: string; hole: number | null; round: number | null; players: TeeTimePlayer[]; }
interface NotableEvent {
  tournamentId: number; playerId?: number; playerName: string;
  holeNumber: number; strokes: number; par: number; toPar: number;
  eventType: "hole_in_one" | "eagle" | "birdie" | "round_start" | "round_finish" | "tee_off";
  round?: number; occurredAt: string;
  // Server-translated copy (Task #802). The `notable-events` and SSE
  // `scoring_event` payloads include these fields when the client requests
  // a `?lang=` — we render them as-is so the spectator UI never carries
  // duplicate English copy of the highlight strings.
  title?: string;
  body?: string;
  lang?: string;
}
interface PaceGroup {
  teeTimeId: number; teeTime: string; round: number; startingHole: number | null;
  players: { id: number; name: string }[];
  currentHole: number; minutesUntilTeeOff: number;
  status: "scheduled" | "upcoming" | "in_progress" | "complete";
  lastHoleCompletedAt: string | null;
}

function formatScore(n: number | null) {
  if (n === null) return "-";
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}
function scoreColor(toPar: number | null) {
  if (toPar === null) return "text-gray-400";
  if (toPar <= -2) return "text-amber-400";
  if (toPar === -1) return "text-red-400";
  if (toPar === 0) return "text-gray-300";
  if (toPar === 1) return "text-blue-400";
  return "text-purple-400";
}
function scoreBadge(toPar: number | null) {
  if (toPar === null) return "bg-gray-700/40 text-gray-400";
  if (toPar <= -2) return "bg-amber-500/20 border border-amber-500/40 text-amber-400";
  if (toPar === -1) return "bg-red-500/20 border border-red-500/40 text-red-400";
  if (toPar === 0) return "bg-gray-600/30 text-gray-300";
  if (toPar === 1) return "bg-blue-500/20 border border-blue-500/40 text-blue-400";
  return "bg-purple-500/20 border border-purple-500/40 text-purple-400";
}

function FollowedPlayerCard({ entry, mode }: { entry: Entry; mode: "gross" | "net" }) {
  const toPar = mode === "net" ? entry.netToPar : entry.scoreToPar;
  const total = mode === "net" ? entry.netScore : entry.grossScore;
  const src = resolveAvatarSrc(entry.profileImage);
  const latestHole = entry.holeScores.length > 0
    ? entry.holeScores.reduce((a, b) => (a.round > b.round || (a.round === b.round && a.hole > b.hole)) ? a : b)
    : null;

  return (
    <div className="bg-[#131f1a] border border-[#243b2e] rounded-2xl p-4 relative overflow-hidden">
      {entry.userId != null && (
        <div className="absolute top-2 right-2">
          <FollowButton userId={entry.userId} initialFollowing={true} size="sm" />
        </div>
      )}
      <div className="flex items-center gap-3 mb-3">
        {src ? (
          <img src={src} alt="" className="w-12 h-12 rounded-full object-cover ring-2 ring-amber-500/40 shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-lg font-bold text-gray-400 shrink-0">
            {entry.playerName[0]?.toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-bold text-white text-base truncate">{entry.playerName}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs font-bold text-gray-400">#{entry.positionDisplay}</span>
            {entry.flight && <span className="text-[10px] bg-gray-700/50 text-gray-400 px-1.5 py-0.5 rounded">{entry.flight}</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-2xl font-extrabold tabular-nums ${scoreColor(toPar)}`}>{formatScore(toPar)}</div>
          <div className="text-xs text-gray-500 mt-0.5">Thru {entry.thru}</div>
        </div>
      </div>
      {/* Last hole highlight */}
      {latestHole && (
        <div className={`flex items-center justify-between rounded-xl px-3 py-2 ${scoreBadge(latestHole.toPar)}`}>
          <span className="text-sm font-semibold">Hole {latestHole.hole} — Par {latestHole.par}</span>
          <span className="text-lg font-extrabold">{latestHole.strokes}</span>
          <span className="text-sm font-bold">{formatScore(latestHole.toPar)}</span>
        </div>
      )}
      {/* Round by round */}
      {entry.roundScores.length > 1 && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-[#1e3028]">
          {entry.roundScores.map(rs => (
            <div key={rs.round} className="flex-1 text-center">
              <div className="text-[10px] text-gray-600">R{rs.round}</div>
              <div className={`text-sm font-bold ${scoreColor(rs.scoreToPar)}`}>{rs.grossScore}</div>
            </div>
          ))}
          <div className="flex-1 text-center border-l border-[#1e3028] ml-1 pl-1">
            <div className="text-[10px] text-gray-600">TOT</div>
            <div className="text-sm font-bold text-white">{total ?? "—"}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function CompactPlayerRow({ entry, followed, mode, currentUserId, showFollow }: {
  entry: Entry; followed: boolean; mode: "gross" | "net"; currentUserId: number | null; showFollow: boolean;
}) {
  const toPar = mode === "net" ? entry.netToPar : entry.scoreToPar;
  const total = mode === "net" ? entry.netScore : entry.grossScore;
  const isDns = entry.dns || entry.positionDisplay === "DNS";
  const missedCut = entry.madeCut === false;
  const src = resolveAvatarSrc(entry.profileImage);
  const canFollow = showFollow && entry.userId != null && entry.userId !== currentUserId;

  return (
    <div className={`flex items-center gap-2 px-3 py-2.5 border-b border-white/5 ${followed ? "bg-amber-500/5 border-l-2 border-l-amber-500/50" : "hover:bg-white/2"}`}>
      <span className={`w-8 text-center text-sm shrink-0 font-semibold ${isDns ? "text-red-400" : missedCut ? "text-gray-600" : entry.position === 1 ? "text-amber-400 font-extrabold" : "text-gray-400"}`}>
        {isDns ? "DNS" : missedCut ? "MC" : entry.positionDisplay}
      </span>
      {src ? (
        <img src={src} alt="" className="w-6 h-6 rounded-full object-cover shrink-0 ring-1 ring-white/10" />
      ) : (
        <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-gray-400 shrink-0">
          {entry.playerName[0]?.toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-gray-100 truncate">{entry.playerName}</div>
        {entry.flight && <span className="text-[10px] text-gray-500">{entry.flight}</span>}
      </div>
      <span className="text-gray-400 text-xs w-8 text-center shrink-0">{entry.thru}</span>
      <span className="text-sm font-bold w-8 text-center shrink-0 text-white">{total ?? "—"}</span>
      <div className={`w-12 text-center rounded-md py-0.5 text-sm font-bold shrink-0 ${scoreBadge(toPar)}`}>
        {formatScore(toPar)}
      </div>
      {canFollow ? (
        <span className="ml-1 shrink-0">
          <FollowButton userId={entry.userId!} initialFollowing={followed} size="sm" />
        </span>
      ) : followed ? (
        <Star size={14} className="ml-1 shrink-0 text-amber-400" fill="currentColor" />
      ) : (
        <span className="ml-1 shrink-0 w-3.5" />
      )}
    </div>
  );
}

function QRModal({ url, onClose }: { url: string; onClose: () => void }) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}&bgcolor=0b1512&color=22c55e&format=png`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#111c17] border border-[#243b2e] rounded-2xl p-6 flex flex-col items-center gap-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-white font-bold text-lg">Share Spectator View</h3>
        <img src={qrUrl} alt="QR Code" className="w-48 h-48 rounded-xl" />
        <p className="text-gray-400 text-xs text-center break-all max-w-[200px]">{url}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(url); }}
          className="px-4 py-2 bg-green-500/20 text-green-400 border border-green-500/30 rounded-xl text-sm font-semibold hover:bg-green-500/30 transition-colors"
        >
          Copy Link
        </button>
        <button onClick={onClose} className="text-gray-500 text-sm hover:text-gray-300">Close</button>
      </div>
    </div>
  );
}

export default function SpectatorPage() {
  const params = useParams<{ tournamentId: string }>();
  const tournamentId = parseInt(params.tournamentId ?? "0");

  // Player follows are sourced from the portal-wide follow list so following a
  // player on the leaderboard / member-360 carries through to the spectator
  // view (and vice-versa) instead of the old session-only star toggle that
  // disappeared on refresh (Task #1730). The hook quietly returns [] for
  // signed-out spectators so the page still renders cleanly.
  const { data: me } = useGetMe();
  const followeeUserIds = useFolloweeIds();
  const followeeUserIdSet = useMemo(() => new Set<number>(followeeUserIds), [followeeUserIds]);
  const currentUserId = me?.id ?? null;
  const showFollow = !!me?.id;

  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [groups, setGroups] = useState<TeeTimeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [followedGroupIds, setFollowedGroupIds] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(`spectator_groups_${tournamentId}`) ?? "[]");
    } catch { return []; }
  });
  const [mode, setMode] = useState<"gross" | "net">("gross");
  const [tab, setTab] = useState<"players" | "groups">("players");
  const [showQR, setShowQR] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  // Test-notification state (Task #941). Lets a signed-in spectator preview a
  // sample push in their currently selected language. Surfaces success /
  // no-device / rate-limited / login-required / failure inline in their UI
  // language. When the browser already has Notification permission we also
  // pop the previewed alert so web-only spectators (no mobile device) still
  // see the localised wording exactly as it will appear.
  const [testPushSending, setTestPushSending] = useState(false);
  const [testPushStatus, setTestPushStatus] = useState<{
    kind: "sent" | "noDevice" | "rateLimited" | "failed" | "loginRequired";
    seconds?: number;
    preview?: { title: string; body: string };
  } | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const [notableEvents, setNotableEvents] = useState<NotableEvent[]>([]);
  const [paceGroups, setPaceGroups] = useState<PaceGroup[]>([]);
  // Track the active i18n language so the polling/SSE effects re-fire when
  // the spectator switches languages mid-session — otherwise the highlight
  // feed and browser pushes would stay stuck in the previous language until
  // the page is reloaded (Task #802).
  const [activeLang, setActiveLang] = useState<string>(i18n.language || "en");
  const [cutSectionExpanded, setCutSectionExpanded] = useState(false);
  useEffect(() => {
    const onChange = (lng: string) => setActiveLang(lng || "en");
    i18n.on("languageChanged", onChange);
    return () => { i18n.off("languageChanged", onChange); };
  }, []);

  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  const spectatorUrl = `${window.location.origin}${baseUrl}/spectator/${tournamentId}`;

  useEffect(() => {
    localStorage.setItem(`spectator_groups_${tournamentId}`, JSON.stringify(followedGroupIds));
  }, [followedGroupIds, tournamentId]);

  // Clean up the legacy ephemeral player-follow store now that follows live in
  // the portal-wide list (Task #1730). Older sessions can keep accumulating
  // stale player IDs otherwise.
  useEffect(() => {
    try { localStorage.removeItem(`spectator_follow_${tournamentId}`); } catch { /* ignore */ }
  }, [tournamentId]);

  useEffect(() => {
    fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/tee-sheet`)
      .then(r => r.ok ? r.json() : [])
      .then((data: TeeTimeGroup[]) => setGroups(data))
      .catch(() => setGroups([]));
  }, [tournamentId, baseUrl]);

  useEffect(() => {
    let stopped = false;
    async function refresh() {
      try {
        const [evRes, paceRes] = await Promise.all([
          fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/notable-events?limit=20&lang=${encodeURIComponent(activeLang)}`),
          fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/pace-board`),
        ]);
        if (!stopped && evRes.ok) {
          const data = await evRes.json();
          setNotableEvents(data.events ?? []);
        }
        if (!stopped && paceRes.ok) {
          const data = await paceRes.json();
          setPaceGroups(data.groups ?? []);
        }
      } catch { /* ignore */ }
    }
    refresh();
    const id = setInterval(refresh, 30000);
    return () => { stopped = true; clearInterval(id); };
  }, [tournamentId, baseUrl, activeLang]);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/leaderboard`);
        if (!res.ok) throw new Error("Not found");
        const data: Leaderboard = await res.json();
        setLeaderboard(data);
        if (data.leaderboardType === "net") setMode("net");
        const orgPrimary = data.organizationPrimaryColor ?? "#22c55e";
        document.documentElement.style.setProperty("--org-primary", orgPrimary);
      } catch {
        setLeaderboard(null);
      } finally {
        setLoading(false);
      }
    }
    load();

    const sse = new EventSource(`${baseUrl}/api/public/tournaments/${tournamentId}/leaderboard/stream?lang=${encodeURIComponent(activeLang)}`);
    sseRef.current = sse;
    sse.onopen = () => setConnected(true);
    sse.onerror = () => setConnected(false);
    sse.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data);
        if (parsed.type === "leaderboard_update") {
          load();
          if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
            new Notification(
              i18n.t("notifications.leaderboardUpdatedTitle", { defaultValue: "Leaderboard Updated" }),
              {
                body: i18n.t("notifications.leaderboardUpdatedBody", { defaultValue: "Scores have been updated." }),
                icon: "/logo.png",
              }
            );
          }
        } else if (parsed.type === "scoring_event") {
          // Spectator highlight (birdie / eagle / HIO / round_start / round_finish / tee_off).
          // Server has already translated `title` + `body` into the recipient's
          // language using the shared spectator push translator (Task #802) —
          // the web client renders them as-is and never owns its own copy.
          const ev: NotableEvent = parsed.data;
          setNotableEvents(prev => {
            const next = [ev, ...prev];
            return next.slice(0, 20);
          });
          if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
            const title = ev.title ?? "Tournament update";
            const body = ev.body ?? `${ev.playerName} — hole ${ev.holeNumber}`;
            new Notification(title, { body, icon: "/logo.png" });
          }
        }
      } catch {}
    };
    return () => { sse.close(); };
  }, [tournamentId, baseUrl, notificationsEnabled, activeLang]);

  function toggleGroupFollow(groupId: number) {
    setFollowedGroupIds(prev =>
      prev.includes(groupId) ? prev.filter(id => id !== groupId) : [...prev, groupId]
    );
  }

  async function sendTestNotification() {
    if (testPushSending) return;
    setTestPushSending(true);
    setTestPushStatus(null);
    try {
      const res = await fetch(`${baseUrl}/api/portal/spectator-test-push`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "birdie", lang: activeLang }),
      });
      const json = await res.json().catch(() => ({})) as {
        delivered?: boolean;
        reason?: string;
        language?: string;
        preview?: { title: string; body: string };
        retryAfterSeconds?: number;
        error?: string;
      };
      if (res.status === 401) {
        setTestPushStatus({ kind: "loginRequired" });
        return;
      }
      if (res.status === 429) {
        setTestPushStatus({ kind: "rateLimited", seconds: json.retryAfterSeconds ?? 30 });
        return;
      }
      if (!res.ok) {
        setTestPushStatus({ kind: "failed", preview: json.preview });
        return;
      }
      // Pop the previewed alert in the browser too so web-only spectators
      // (without a registered mobile device) can see the localised wording.
      if (json.preview && "Notification" in window && Notification.permission === "granted") {
        try {
          new Notification(json.preview.title, { body: json.preview.body, icon: "/logo.png" });
        } catch { /* notification quota / focus issues — ignore */ }
      }
      if (json.delivered) {
        setTestPushStatus({ kind: "sent", preview: json.preview });
      } else if (json.reason === "no_device_token") {
        setTestPushStatus({ kind: "noDevice", preview: json.preview });
      } else {
        setTestPushStatus({ kind: "failed", preview: json.preview });
      }
    } catch {
      setTestPushStatus({ kind: "failed" });
    } finally {
      setTestPushSending(false);
    }
  }

  async function requestNotifications() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm === "granted") setNotificationsEnabled(true);
    } else if (Notification.permission === "granted") {
      setNotificationsEnabled(prev => !prev);
    }
  }

  const allEntries = leaderboard
    ? (mode === "net" ? leaderboard.netEntries : leaderboard.entries)
    : [];
  const survivorEntries = allEntries.filter(e => e.madeCut !== false);
  const cutEntries = allEntries.filter(e => e.madeCut === false);
  // Translate the portal-wide list of followee user IDs into the playerIds we
  // actually highlight on this leaderboard. A player only counts as
  // "followed" here when their tournament row links to a portal user the
  // viewer follows (Task #1730).
  const followedPlayerIdSet = new Set<number>();
  for (const e of allEntries) {
    if (e.userId != null && followeeUserIdSet.has(e.userId)) {
      followedPlayerIdSet.add(e.playerId);
    }
  }
  const followedEntries = allEntries.filter(e => followedPlayerIdSet.has(e.playerId));
  const followedGroups = groups.filter(g => followedGroupIds.includes(g.id));
  // For a followed group, resolve each player's live entry from the leaderboard
  function getGroupEntries(group: TeeTimeGroup): Entry[] {
    const ids = new Set(group.players.map(p => p.playerId));
    return allEntries.filter(e => ids.has(e.playerId));
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b1512] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-3 border-green-500/30 border-t-green-500 rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">Loading spectator view...</p>
        </div>
      </div>
    );
  }

  if (!leaderboard) {
    return (
      <div className="min-h-screen bg-[#0b1512] flex items-center justify-center">
        <div className="text-center p-8">
          <Trophy className="mx-auto mb-3 text-gray-600" size={48} />
          <h2 className="text-white text-xl font-bold">Tournament Not Found</h2>
          <p className="text-gray-400 mt-2">This spectator link may be invalid.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b1512] font-sans pb-16">
      {/* Header */}
      <div className="bg-[#0d1c14] border-b border-[#1e3028] sticky top-0 z-20">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src={leaderboard.organizationLogoUrl ?? "/logo.png"}
                alt={leaderboard.organizationName ?? "KharaGolf"}
                className="h-8 w-auto object-contain rounded shrink-0"
              />
              <div className="min-w-0">
                <p className="text-[10px] font-bold tracking-widest uppercase text-green-400 mb-0.5">
                  {leaderboard.organizationName ? <>{leaderboard.organizationName}</> : <><KharaGolfWordmark /></>} SPECTATOR
                </p>
                <h1 className="text-white font-bold text-base leading-tight truncate">{leaderboard.tournamentName}</h1>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold ${connected ? "bg-green-500/15 text-green-400 border border-green-500/30" : "bg-red-500/15 text-red-400 border border-red-500/30"}`}>
                {connected ? <Wifi size={10} /> : <WifiOff size={10} />}
                {connected ? "LIVE" : "OFFLINE"}
              </div>
              <button
                onClick={requestNotifications}
                title={notificationsEnabled ? "Disable notifications" : "Enable score notifications"}
                className={`p-1.5 rounded-full transition-colors ${notificationsEnabled ? "text-amber-400 bg-amber-500/10" : "text-gray-500 hover:text-gray-300"}`}
              >
                {notificationsEnabled ? <Bell size={14} /> : <BellOff size={14} />}
              </button>
              <button
                onClick={() => setShowQR(true)}
                title="Share spectator QR"
                className="p-1.5 rounded-full text-gray-500 hover:text-green-400 transition-colors"
              >
                <QrCode size={14} />
              </button>
            </div>
          </div>

          {/* Mode tabs */}
          {leaderboard.leaderboardType !== "gross" && leaderboard.leaderboardType !== "net" && (
            <div className="flex gap-1 mt-2">
              {(["gross", "net"] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1 rounded text-xs font-semibold transition-all ${mode === m ? "bg-[#243b2e] text-green-400" : "text-gray-600 hover:text-gray-400"}`}
                >
                  {m === "gross" ? "Gross" : "Net"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="max-w-2xl mx-auto">
        {/* Test-notification preview (Task #941). Mirrors the mobile
            spectator-follows action so web spectators can verify how alerts
            will read in their selected language before subscribing to real
            follows. The status line + previewed copy are surfaced inline. */}
        <div className="px-4 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#1e3028] bg-[#0f1a15] px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-gray-300">{i18n.t("common:spectatorTest.button")}</div>
              <div className="text-[11px] text-gray-500 truncate">{i18n.t("common:spectatorTest.subtitle")}</div>
            </div>
            <button
              type="button"
              onClick={sendTestNotification}
              disabled={testPushSending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs font-semibold text-green-300 transition-colors hover:bg-green-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="button-spectator-test-push"
            >
              <Send size={12} />
              {testPushSending ? i18n.t("common:spectatorTest.sending") : i18n.t("common:spectatorTest.button")}
            </button>
          </div>
          {testPushStatus && (
            <div
              className={`mt-2 rounded-xl border px-3 py-2 text-xs ${
                testPushStatus.kind === "sent"
                  ? "border-green-500/30 bg-green-500/10 text-green-300"
                  : testPushStatus.kind === "noDevice"
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                  : testPushStatus.kind === "rateLimited"
                  ? "border-orange-500/30 bg-orange-500/10 text-orange-200"
                  : testPushStatus.kind === "loginRequired"
                  ? "border-blue-500/30 bg-blue-500/10 text-blue-200"
                  : "border-red-500/30 bg-red-500/10 text-red-300"
              }`}
              data-testid="status-spectator-test-push"
              role="status"
            >
              <div className="font-semibold">
                {testPushStatus.kind === "sent" && i18n.t("common:spectatorTest.sent")}
                {testPushStatus.kind === "noDevice" && i18n.t("common:spectatorTest.noDevice")}
                {testPushStatus.kind === "rateLimited" && i18n.t("common:spectatorTest.rateLimited", { seconds: testPushStatus.seconds ?? 30 })}
                {testPushStatus.kind === "loginRequired" && i18n.t("common:spectatorTest.loginRequired")}
                {testPushStatus.kind === "failed" && i18n.t("common:spectatorTest.failed")}
              </div>
              {testPushStatus.preview && (
                <div className="mt-1 rounded-lg bg-black/30 px-2 py-1.5 text-gray-200">
                  <div className="text-[11px] font-bold">{testPushStatus.preview.title}</div>
                  <div className="text-[11px] text-gray-300">{testPushStatus.preview.body}</div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="px-4 pt-4">
          <LiveOddsWidget tournamentId={tournamentId} surface="web_spectator" />
        </div>
        {/* Pace / Tee-off countdown — show next 3 upcoming/in-progress groups,
            prioritizing followed groups. */}
        {paceGroups.length > 0 && (() => {
          const upcoming = paceGroups
            .filter(g => g.status !== "complete")
            .sort((a, b) => {
              const af = followedGroupIds.includes(a.teeTimeId) ? 0 : 1;
              const bf = followedGroupIds.includes(b.teeTimeId) ? 0 : 1;
              if (af !== bf) return af - bf;
              return new Date(a.teeTime).getTime() - new Date(b.teeTime).getTime();
            })
            .slice(0, 3);
          if (upcoming.length === 0) return null;
          return (
            <div className="px-4 pt-4 pb-1">
              <div className="flex items-center gap-2 mb-2">
                <Clock size={14} className="text-emerald-400" />
                <span className="text-emerald-400 font-bold text-sm uppercase tracking-wide">Pace & Tee Times</span>
              </div>
              <div className="space-y-2">
                {upcoming.map(g => {
                  const followed = followedGroupIds.includes(g.teeTimeId);
                  const teeStr = new Date(g.teeTime).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
                  let label: string;
                  if (g.status === "in_progress") label = `On hole ${g.currentHole}`;
                  else if (g.minutesUntilTeeOff > 0) label = `Tees off in ${g.minutesUntilTeeOff} min`;
                  else if (g.minutesUntilTeeOff > -5) label = "Teeing off now";
                  else label = `Tee time ${teeStr}`;
                  const statusColor =
                    g.status === "in_progress" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
                    : g.status === "upcoming" ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
                    : "text-gray-400 bg-gray-500/10 border-gray-500/20";
                  return (
                    <div key={g.teeTimeId} className={`rounded-xl border px-3 py-2 flex items-center gap-3 ${followed ? "bg-amber-500/5 border-amber-500/30" : "border-[#1e3028]"}`}>
                      <div className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${statusColor}`}>{label}</div>
                      <div className="flex-1 min-w-0 text-xs text-gray-300 truncate">
                        {g.players.map(p => p.name).join(", ")}
                      </div>
                      <span className="text-[10px] text-gray-500 shrink-0">R{g.round} · {teeStr}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Notable events feed (birdies/eagles/HIO/round events) */}
        {notableEvents.length > 0 && (
          <div className="px-4 pt-4 pb-1">
            <div className="flex items-center gap-2 mb-2">
              <Activity size={14} className="text-amber-400" />
              <span className="text-amber-400 font-bold text-sm uppercase tracking-wide">Notable moments</span>
            </div>
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {notableEvents.slice().reverse().map((ev, i) => {
                // Render the server-translated title + body verbatim. The
                // emoji icon is part of the localised title (e.g. "⛳ Hole-in-One!"
                // / "🦅 ¡Eagle!"), so we no longer build it on the client and
                // never duplicate the English copy here (Task #802). Older API
                // builds without translations fall back to a generic line.
                const time = new Date(ev.occurredAt).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
                const followed = ev.playerId != null && followedPlayerIdSet.has(ev.playerId);
                const title = ev.title ?? `${ev.playerName} · hole ${ev.holeNumber}`;
                const body = ev.body ?? "";
                return (
                  <div key={i} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${followed ? "bg-amber-500/5 border-amber-500/30" : "border-[#1e3028] bg-[#0f1a15]"}`}>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-gray-200 truncate">{title}</div>
                      {body && (
                        <div className="text-[11px] text-gray-400 truncate">{body}</div>
                      )}
                    </div>
                    <span className="text-[10px] text-gray-600 shrink-0 tabular-nums">{time}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Followed Players */}
        {followedEntries.length > 0 && (
          <div className="px-4 pt-4 pb-2">
            <div className="flex items-center gap-2 mb-3">
              <Star size={14} className="text-amber-400" fill="currentColor" />
              <span className="text-amber-400 font-bold text-sm uppercase tracking-wide">Following</span>
              <span className="ml-auto text-xs text-gray-500">{followedEntries.length} player{followedEntries.length !== 1 ? "s" : ""}</span>
            </div>
            <div className="space-y-3">
              {followedEntries.map(entry => (
                <FollowedPlayerCard
                  key={entry.playerId}
                  entry={entry}
                  mode={mode}
                />
              ))}
            </div>
          </div>
        )}

        {followedEntries.length === 0 && (
          <div className="mx-4 mt-4 px-4 py-4 border border-dashed border-[#243b2e] rounded-2xl text-center">
            <Star size={24} className="mx-auto mb-2 text-gray-600" />
            {showFollow ? (
              <>
                <p className="text-gray-500 text-sm font-medium">Tap Follow next to any player to track them</p>
                <p className="text-gray-600 text-xs mt-1">Your follows are shared with the rest of KharaGolf</p>
              </>
            ) : (
              <>
                <p className="text-gray-500 text-sm font-medium">Sign in to follow players</p>
                <p className="text-gray-600 text-xs mt-1">Followed players are highlighted across the app</p>
              </>
            )}
          </div>
        )}

        {/* Tab switcher */}
        <div className="flex gap-1 px-4 mt-4">
          <button
            onClick={() => setTab("players")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${tab === "players" ? "bg-[#243b2e] text-green-400" : "text-gray-600 hover:text-gray-400"}`}
          >
            <Users size={11} /> Players
          </button>
          {groups.length > 0 && (
            <button
              onClick={() => setTab("groups")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${tab === "groups" ? "bg-[#243b2e] text-green-400" : "text-gray-600 hover:text-gray-400"}`}
            >
              <UsersRound size={11} /> Groups ({groups.length})
            </button>
          )}
        </div>

        {/* All Players tab */}
        {tab === "players" && (
          <div className="mt-2">
            <div className="border-t border-[#1e3028]">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#1e3028]">
                <span className="w-8 text-[10px] text-gray-600 text-center font-bold tracking-wide">POS</span>
                <span className="w-6 shrink-0" />
                <span className="flex-1 text-[10px] text-gray-600 font-bold tracking-wide">PLAYER</span>
                <span className="w-8 text-[10px] text-gray-600 text-center font-bold tracking-wide">THRU</span>
                <span className="w-8 text-[10px] text-gray-600 text-center font-bold tracking-wide">TOT</span>
                <span className="w-12 text-[10px] text-gray-600 text-center font-bold tracking-wide">+/-</span>
                <span className="w-6 shrink-0" />
              </div>
              {survivorEntries.map(entry => (
                <CompactPlayerRow
                  key={entry.playerId}
                  entry={entry}
                  followed={followedPlayerIdSet.has(entry.playerId)}
                  mode={mode}
                  currentUserId={currentUserId}
                  showFollow={showFollow}
                />
              ))}
              {cutEntries.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setCutSectionExpanded(v => !v)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 bg-[#0d1a15] border-t border-b border-[#243b2e] text-left hover:bg-[#11201a] transition-colors"
                    aria-expanded={cutSectionExpanded}
                    data-testid="spectator-cut-toggle"
                  >
                    <span className="text-[10px] font-bold tracking-widest text-gray-400 uppercase">Missed the Cut</span>
                    <span className="text-[11px] text-gray-500">— {cutEntries.length} player{cutEntries.length === 1 ? "" : "s"}</span>
                    <span className="ml-auto text-gray-500 text-xs">{cutSectionExpanded ? "▾" : "▸"}</span>
                  </button>
                  {cutSectionExpanded && cutEntries.map(entry => (
                    <CompactPlayerRow
                      key={entry.playerId}
                      entry={entry}
                      followed={followedPlayerIdSet.has(entry.playerId)}
                      mode={mode}
                      currentUserId={currentUserId}
                      showFollow={showFollow}
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        {/* Groups tab */}
        {tab === "groups" && (
          <div className="mt-2 px-4 space-y-3">
            {followedGroups.length > 0 && (
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <UsersRound size={13} className="text-amber-400" />
                  <span className="text-amber-400 font-bold text-xs uppercase tracking-wide">Following Groups</span>
                </div>
                {followedGroups.map(group => {
                  const groupEntries = getGroupEntries(group);
                  const teeStr = new Date(group.teeTime).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
                  return (
                    <div key={group.id} className="bg-[#131f1a] border border-amber-500/30 rounded-2xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <span className="text-amber-400 text-xs font-bold">Hole {group.hole ?? "—"} · R{group.round ?? 1} · {teeStr}</span>
                        </div>
                        <button onClick={() => toggleGroupFollow(group.id)} className="text-amber-400 hover:text-gray-400 transition-colors">
                          <Star size={14} fill="currentColor" />
                        </button>
                      </div>
                      <div className="space-y-1">
                        {groupEntries.length > 0 ? groupEntries.map(entry => {
                          const toPar = mode === "net" ? entry.netToPar : entry.scoreToPar;
                          const total = mode === "net" ? entry.netScore : entry.grossScore;
                          return (
                            <div key={entry.playerId} className="flex items-center gap-2 py-1 border-b border-[#1e3028] last:border-0">
                              <span className="text-xs text-gray-400 w-6 font-bold">{entry.positionDisplay}</span>
                              <span className="flex-1 text-sm font-semibold text-gray-100">{entry.playerName}</span>
                              <span className="text-xs text-gray-400 w-8 text-center">{entry.thru}</span>
                              <span className="text-sm font-bold text-white w-8 text-center">{total ?? "—"}</span>
                              <span className={`w-12 text-center rounded-md py-0.5 text-sm font-bold ${scoreBadge(toPar)}`}>{formatScore(toPar)}</span>
                            </div>
                          );
                        }) : group.players.map(p => (
                          <div key={p.playerId} className="flex items-center gap-2 py-1">
                            <span className="flex-1 text-sm text-gray-400">{p.firstName} {p.lastName}</span>
                            <span className="text-xs text-gray-600">No scores yet</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-2 mb-1">
              <span className="text-gray-500 text-xs font-bold uppercase tracking-wide">All Groups — Tap to Follow</span>
            </div>
            {groups.map(group => {
              const followed = followedGroupIds.includes(group.id);
              const teeStr = new Date(group.teeTime).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
              const groupEntries = getGroupEntries(group);
              const bestEntry = groupEntries.sort((a, b) => (a.scoreToPar ?? 99) - (b.scoreToPar ?? 99))[0];
              return (
                <div key={group.id} className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 ${followed ? "bg-amber-500/5 border-amber-500/30" : "border-[#1e3028] hover:border-[#243b2e]"}`}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-gray-400">
                      Hole {group.hole ?? "—"} · R{group.round ?? 1} · {teeStr}
                    </div>
                    <div className="text-sm font-semibold text-gray-200 mt-0.5 truncate">
                      {group.players.map(p => `${p.firstName} ${p.lastName}`).join(", ")}
                    </div>
                    {bestEntry && (
                      <div className="text-[10px] text-gray-500 mt-0.5">
                        Best: {bestEntry.playerName} {formatScore(bestEntry.scoreToPar)} thru {bestEntry.thru}
                      </div>
                    )}
                  </div>
                  <button onClick={() => toggleGroupFollow(group.id)} className={`shrink-0 transition-colors ${followed ? "text-amber-400" : "text-gray-600 hover:text-amber-400"}`}>
                    {followed ? <Star size={16} fill="currentColor" /> : <StarOff size={16} />}
                  </button>
                </div>
              );
            })}
            {groups.length === 0 && (
              <div className="text-center py-8 text-gray-600 text-sm">No tee times have been set up for this tournament yet.</div>
            )}
          </div>
        )}

        {/* Sponsor ad — player_card slot */}
        {leaderboard.organizationId != null && (
          <div className="px-4 pt-4">
            <AdSlot
              orgId={leaderboard.organizationId}
              slotKey="player_card"
              tournamentId={tournamentId}
              className="block w-full rounded-2xl overflow-hidden border border-[#1e3028]"
              style={{ aspectRatio: "5 / 1", background: "#0d1c14" }}
            />
          </div>
        )}

        {/* Photo Gallery Section */}
        <div className="px-4 pt-4 pb-2">
          <a
            href={`${baseUrl}/leaderboard/${tournamentId}`}
            className="flex items-center justify-center gap-2 py-3 border border-[#243b2e] rounded-2xl text-gray-400 hover:text-green-400 hover:border-green-500/30 transition-colors text-sm font-semibold"
          >
            <Camera size={14} />
            View Tournament Gallery & Full Leaderboard →
          </a>
        </div>

        <p className="text-center text-[11px] text-gray-600 py-4 px-4">
          Spectator mode — no login required · Scores update in real-time
        </p>
      </div>

      {showQR && <QRModal url={spectatorUrl} onClose={() => setShowQR(false)} />}
    </div>
  );
}
