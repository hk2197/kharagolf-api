import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { trackImpression } from "@/lib/trackSponsor";

interface HoleScore {
  hole: number; round: number; strokes: number; par: number; toPar: number;
  stablefordPoints: number;
}
interface RoundScore {
  round: number; grossScore: number; scoreToPar: number; netScore: number | null;
  stablefordPoints: number | null; holesPlayed: number; isComplete: boolean;
}
interface Entry {
  playerId: number; playerName: string; position: number; positionDisplay: string;
  profileImage?: string | null;
  grossScore: number | null; netScore: number | null; scoreToPar: number | null;
  netToPar: number | null; stablefordPoints: number | null;
  thru: string; currentRound: number; roundScores: RoundScore[];
  madeCut: boolean | null; flight: string | null; flights?: string[];
  handicapIndex: number; holeScores: HoleScore[]; isVerified: boolean; dns?: boolean;
}
interface Sponsor { id: number; name: string; logoUrl: string | null; tier: string; websiteUrl: string | null; }
interface Leaderboard {
  tournamentId: number; tournamentName: string; format: string;
  coursePar: number; rounds: number; lastUpdated: string;
  entries: Entry[];
  netEntries: Entry[];
  stablefordEntries: Entry[];
  organizationName: string | null;
  organizationLogoUrl: string | null;
  organizationPrimaryColor: string | null;
  sponsors: Sponsor[];
  leaderboardType?: string | null;
  availableViews?: string[];
}

type ViewMode = "gross" | "net" | "stableford";

const VIEW_LABELS: Record<ViewMode, string> = { gross: "GROSS", net: "NET", stableford: "STABLEFORD" };
const VIEW_CYCLE_MS = 30_000;
const REFRESH_MS = 15_000;

function formatScore(n: number | null, mode: ViewMode): string {
  if (n === null) return "–";
  if (mode === "stableford") return `${n}`;
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

function toParValue(e: Entry, mode: ViewMode): number | null {
  if (mode === "net") return e.netToPar;
  if (mode === "stableford") return e.stablefordPoints;
  return e.scoreToPar;
}

function scoreColor(toPar: number | null, mode: ViewMode): string {
  if (mode === "stableford") {
    if (toPar === null) return "#9ca3af";
    if (toPar >= 4) return "#f59e0b";
    if (toPar >= 3) return "#ef4444";
    if (toPar >= 2) return "#e5e7eb";
    return "#9ca3af";
  }
  if (toPar === null) return "#9ca3af";
  if (toPar <= -2) return "#f59e0b";
  if (toPar === -1) return "#ef4444";
  if (toPar === 0) return "#e5e7eb";
  if (toPar === 1) return "#60a5fa";
  return "#a78bfa";
}

function positionBadgeColor(pos: number): string {
  if (pos === 1) return "#f59e0b";
  if (pos === 2) return "#94a3b8";
  if (pos === 3) return "#cd7f32";
  return "#4b5563";
}

function getEntries(lb: Leaderboard, mode: ViewMode): Entry[] {
  if (mode === "net") return lb.netEntries ?? [];
  if (mode === "stableford") return lb.stablefordEntries ?? [];
  return lb.entries ?? [];
}

export default function LeaderboardKiosk() {
  const params = useParams<{ tournamentId: string }>();
  const tournamentId = parseInt(params.tournamentId ?? "0");

  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("gross");
  const [viewIdx, setViewIdx] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [sponsorIdx, setSponsorIdx] = useState(0);
  const [now, setNow] = useState(new Date());
  const sseRef = useRef<EventSource | null>(null);
  const cycleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sponsorCycleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  async function fetchLeaderboard() {
    try {
      const res = await fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/leaderboard`);
      if (res.ok) {
        const data: Leaderboard = await res.json();
        setLeaderboard(data);
        const orgPrimary = data.organizationPrimaryColor ?? "#22c55e";
        document.documentElement.style.setProperty("--org-primary", orgPrimary);
        const views = (data.availableViews ?? ["gross"]).filter(
          (v): v is ViewMode => ["gross", "net", "stableford"].includes(v)
        );
        if (views.length > 0) {
          setViewMode(prev => views.includes(prev) ? prev : views[0]);
          setViewIdx(prev => {
            const idx = views.indexOf(viewMode);
            return idx >= 0 ? idx : 0;
          });
        }
      }
    } catch {}
  }

  useEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    fetchLeaderboard();

    const sse = new EventSource(`${baseUrl}/api/public/tournaments/${tournamentId}/leaderboard/stream`);
    sseRef.current = sse;
    sse.onmessage = () => { fetchLeaderboard(); };

    refreshRef.current = setInterval(fetchLeaderboard, REFRESH_MS);
    const clock = setInterval(() => setNow(new Date()), 1000);

    return () => {
      sse.close();
      if (refreshRef.current) clearInterval(refreshRef.current);
      clearInterval(clock);
      if (cycleRef.current) clearInterval(cycleRef.current);
      if (sponsorCycleRef.current) clearInterval(sponsorCycleRef.current);
    };
  }, [tournamentId]);

  const availableViews: ViewMode[] = leaderboard?.availableViews?.filter(
    (v): v is ViewMode => ["gross", "net", "stableford"].includes(v)
  ) ?? ["gross"];

  useEffect(() => {
    if (cycleRef.current) clearInterval(cycleRef.current);
    if (availableViews.length <= 1) return;
    cycleRef.current = setInterval(() => {
      setAnimating(true);
      setTimeout(() => {
        setViewIdx(prev => {
          const next = (prev + 1) % availableViews.length;
          setViewMode(availableViews[next]);
          return next;
        });
        setAnimating(false);
      }, 600);
    }, VIEW_CYCLE_MS);
    return () => { if (cycleRef.current) clearInterval(cycleRef.current); };
  }, [availableViews.length]);

  useEffect(() => {
    if (!leaderboard?.sponsors?.length) return;
    if (sponsorCycleRef.current) clearInterval(sponsorCycleRef.current);
    const count = leaderboard.sponsors.length;
    if (count > 1) {
      sponsorCycleRef.current = setInterval(() => {
        setSponsorIdx(i => (i + 1) % count);
      }, 6000);
    }
    return () => { if (sponsorCycleRef.current) clearInterval(sponsorCycleRef.current); };
  }, [leaderboard?.sponsors?.length]);

  useEffect(() => {
    if (leaderboard?.sponsors) {
      leaderboard.sponsors.forEach(s => trackImpression(s.id, "kiosk"));
    }
  }, [leaderboard?.sponsors]);

  if (!leaderboard) {
    return (
      <div style={{ minHeight: "100vh", background: "#060d09", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
        <div style={{ width: 48, height: 48, border: "3px solid rgba(34,197,94,0.2)", borderTopColor: "#22c55e", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
        <div style={{ color: "var(--org-primary, #22c55e)", fontSize: 20, fontFamily: "Georgia, serif", letterSpacing: 6 }}>LOADING LEADERBOARD</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const allEntries = getEntries(leaderboard, viewMode).filter(e => !e.dns);
  const entries = allEntries.filter(e => e.madeCut !== false).slice(0, 20);
  const cutPlayers = allEntries.filter(e => e.madeCut === false);
  const inProgress = leaderboard.entries.filter(e => e.scoreToPar !== null && (e.thru ?? "") !== "F" && (e.thru ?? "") !== "").length;
  const sponsors = leaderboard.sponsors ?? [];
  const activeSponsor = sponsors.length > 0 ? sponsors[sponsorIdx] : null;
  const orgColor = leaderboard.organizationPrimaryColor ?? "#22c55e";

  return (
    <div style={{
      minHeight: "100vh", height: "100vh",
      background: "linear-gradient(160deg, #060e07 0%, #0a1a0e 50%, #060a07 100%)",
      fontFamily: "'Georgia', serif",
      color: "#e5e7eb",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      position: "fixed",
      inset: 0,
    }}>
      {/* ── Header ── */}
      <div style={{
        background: "rgba(0,0,0,0.55)",
        borderBottom: `3px solid ${orgColor}30`,
        padding: "18px 56px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <img
            src={leaderboard.organizationLogoUrl ?? "/logo.png"}
            alt={leaderboard.organizationName ?? "KharaGolf"}
            style={{ height: 60, width: "auto", objectFit: "contain", borderRadius: 8, background: "rgba(255,255,255,0.05)", padding: 6 }}
            onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <div>
            <div style={{ fontSize: 11, letterSpacing: 6, fontFamily: "Arial, sans-serif", fontWeight: 700, color: orgColor, marginBottom: 4 }}>
              {(leaderboard.organizationName ?? "KharaGolf").toUpperCase()} · LIVE LEADERBOARD
            </div>
            <div style={{ fontSize: 30, fontWeight: 700, color: "#ffffff", letterSpacing: 0.5 }}>
              {leaderboard.tournamentName}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          {/* View mode badge */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {availableViews.map((v, i) => (
              <button
                key={v}
                onClick={() => { setViewMode(v); setViewIdx(i); }}
                style={{
                  padding: "5px 16px",
                  borderRadius: 20,
                  border: `1.5px solid ${viewMode === v ? orgColor : "rgba(255,255,255,0.1)"}`,
                  background: viewMode === v ? `${orgColor}22` : "transparent",
                  color: viewMode === v ? orgColor : "#4b5563",
                  fontSize: 12,
                  fontFamily: "Arial, sans-serif",
                  fontWeight: 700,
                  letterSpacing: 2,
                  cursor: "pointer",
                  transition: "all 0.3s",
                }}
              >
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 36, color: orgColor, fontWeight: 700, fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums" }}>
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {inProgress > 0 && (
              <>
                <div style={{ width: 8, height: 8, borderRadius: 4, background: "#22c55e", boxShadow: "0 0 8px #22c55e", animation: "pulse 2s infinite" }} />
                <span style={{ fontSize: 12, color: "#22c55e", fontFamily: "Arial, sans-serif", letterSpacing: 1 }}>
                  {inProgress} PLAYER{inProgress !== 1 ? "S" : ""} ON COURSE
                </span>
              </>
            )}
            <span style={{ fontSize: 11, color: "#4b5563", fontFamily: "Arial, sans-serif", letterSpacing: 1, marginLeft: 8 }}>
              Par {leaderboard.coursePar}
            </span>
          </div>
        </div>
      </div>

      {/* ── Column Headers ── */}
      <div style={{
        background: "rgba(0,0,0,0.4)",
        padding: "8px 56px",
        display: "grid",
        gridTemplateColumns: "72px 1fr 80px 80px 90px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        flexShrink: 0,
      }}>
        {["POS", "PLAYER", "THRU", "TOTAL", viewMode === "stableford" ? "PTS" : "+/-"].map(h => (
          <div key={h} style={{ fontSize: 11, color: "#4b5563", letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, textAlign: h === "POS" || h === "THRU" || h === "TOTAL" || h === "+/-" || h === "PTS" ? "center" : "left" }}>
            {h}
          </div>
        ))}
      </div>

      {/* ── Leaderboard entries ── */}
      <div style={{
        flex: 1,
        overflow: "hidden",
        opacity: animating ? 0 : 1,
        transition: "opacity 0.6s ease",
      }}>
        {entries.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", gap: 16 }}>
            <div style={{ fontSize: 48, opacity: 0.3 }}>🏆</div>
            <div style={{ color: "#4b5563", fontSize: 20, fontFamily: "Arial, sans-serif" }}>No scores yet</div>
          </div>
        ) : entries.map((entry, i) => {
          const val = toParValue(entry, viewMode);
          const totalDisplay = viewMode === "net" ? entry.netScore : viewMode === "stableford" ? entry.stablefordPoints : entry.grossScore;
          const missedCut = entry.madeCut === false;
          const isGold = entry.position === 1 && !missedCut && totalDisplay !== null;

          return (
            <div
              key={entry.playerId}
              style={{
                display: "grid",
                gridTemplateColumns: "72px 1fr 80px 80px 90px",
                padding: "0 56px",
                height: `calc((100vh - 220px - ${cutPlayers.length > 0 ? 152 : 0}px) / ${Math.min(entries.length, 20)})`,
                minHeight: 40,
                maxHeight: 72,
                alignItems: "center",
                background: isGold ? "rgba(245,158,11,0.05)" : i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent",
                borderBottom: "1px solid rgba(255,255,255,0.03)",
                borderLeft: isGold ? `3px solid ${orgColor}80` : "3px solid transparent",
                opacity: missedCut ? 0.5 : 1,
              }}
            >
              <div style={{ textAlign: "center", fontSize: 22, fontWeight: 800, color: positionBadgeColor(entry.position), fontFamily: "Arial, sans-serif" }}>
                {missedCut ? "MC" : totalDisplay !== null ? entry.positionDisplay : "–"}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 22, fontWeight: entry.position <= 3 ? 700 : 500, color: entry.position <= 3 ? "#ffffff" : "#d1d5db", letterSpacing: 0.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {entry.playerName}
                </div>
                {entry.isVerified && !missedCut && (
                  <span style={{ fontSize: 10, background: "rgba(34,197,94,0.15)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 4, padding: "2px 5px", fontFamily: "Arial, sans-serif", flexShrink: 0 }}>✓</span>
                )}
              </div>
              <div style={{ textAlign: "center", fontSize: 18, color: "#6b7280", fontFamily: "Arial, sans-serif" }}>
                {entry.thru || "–"}
              </div>
              <div style={{ textAlign: "center", fontSize: 22, fontWeight: 600, color: totalDisplay !== null ? "#ffffff" : "#4b5563", fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums" }}>
                {totalDisplay ?? "–"}
              </div>
              <div style={{ textAlign: "center" }}>
                <span style={{
                  display: "inline-block",
                  minWidth: 64,
                  padding: "3px 10px",
                  borderRadius: 8,
                  fontSize: 22,
                  fontWeight: 800,
                  fontFamily: "Arial, sans-serif",
                  fontVariantNumeric: "tabular-nums",
                  color: viewMode === "stableford" ? "#34d399" : scoreColor(val, viewMode),
                  background: viewMode === "stableford" ? "rgba(52,211,153,0.1)" : val !== null && val < 0 ? "rgba(239,68,68,0.1)" : "transparent",
                }}>
                  {formatScore(val, viewMode)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Missed the Cut (always-on secondary block, no toggle) ── */}
      {cutPlayers.length > 0 && (
        <div
          data-testid="kiosk-cut-section"
          style={{
            background: "rgba(0,0,0,0.5)",
            borderTop: "1px solid rgba(239,68,68,0.25)",
            padding: "10px 56px 12px",
            flexShrink: 0,
            maxHeight: 140,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: "#f87171", letterSpacing: 3, fontFamily: "Arial, sans-serif", fontWeight: 700 }}>
              MISSED THE CUT
            </span>
            <span style={{ fontSize: 10, color: "#6b7280", fontFamily: "Arial, sans-serif", letterSpacing: 1 }}>
              {cutPlayers.length} PLAYER{cutPlayers.length !== 1 ? "S" : ""}
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
            {cutPlayers.slice(0, 24).map(p => {
              const v = toParValue(p, viewMode);
              return (
                <div key={p.playerId} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 13, fontFamily: "Arial, sans-serif", color: "#9ca3af" }}>
                  <span style={{ opacity: 0.85 }}>{p.playerName}</span>
                  <span style={{ color: "#6b7280", fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{formatScore(v, viewMode)}</span>
                </div>
              );
            })}
            {cutPlayers.length > 24 && (
              <span style={{ fontSize: 12, color: "#6b7280", fontFamily: "Arial, sans-serif" }}>
                + {cutPlayers.length - 24} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Auto-cycle progress bar ── */}
      {availableViews.length > 1 && (
        <div style={{ height: 2, background: "rgba(255,255,255,0.05)", flexShrink: 0 }}>
          <div style={{
            height: "100%",
            background: orgColor,
            animation: `progress ${VIEW_CYCLE_MS}ms linear infinite`,
            transformOrigin: "left",
          }} />
        </div>
      )}

      {/* ── Sponsor banner ── */}
      <div style={{
        background: "rgba(0,0,0,0.6)",
        borderTop: "1px solid rgba(255,255,255,0.06)",
        padding: "10px 56px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0,
        minHeight: 60,
      }}>
        <div style={{ fontSize: 10, color: "#374151", fontFamily: "Arial, sans-serif", letterSpacing: 3, fontWeight: 700 }}>
          {activeSponsor ? "PRESENTED BY" : "POWERED BY KHARAGOLF"}
        </div>
        {activeSponsor ? (
          activeSponsor.logoUrl ? (
            <img
              src={activeSponsor.logoUrl}
              alt={activeSponsor.name}
              style={{ height: 36, maxWidth: 180, objectFit: "contain", opacity: 0.85 }}
            />
          ) : (
            <span style={{ fontSize: 18, fontFamily: "Arial, sans-serif", fontWeight: 700, color: "#6b7280" }}>{activeSponsor.name}</span>
          )
        ) : null}
        <div style={{ fontSize: 11, color: "#374151", fontFamily: "Arial, sans-serif", letterSpacing: 2 }}>
          {availableViews.length > 1 ? `AUTO-CYCLING · 30s` : "LIVE"}
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes progress { from { width: 0%; } to { width: 100%; } }
      `}</style>
    </div>
  );
}
