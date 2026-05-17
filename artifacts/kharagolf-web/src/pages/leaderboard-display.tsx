import { useEffect, useRef, useState } from "react";
import { useParams, useSearch } from "wouter";
import { trackImpression } from "@/lib/trackSponsor";
import AdSlot from "@/components/AdSlot";

interface HoleScore {
  hole: number; round: number; strokes: number; par: number; toPar: number;
  stablefordPoints?: number; parBogeyResult?: "W" | "L" | "H" | null;
}

interface RoundScore {
  round: number; grossScore: number; scoreToPar: number; netScore?: number | null; isComplete: boolean;
}

interface Entry {
  playerId: number; playerName: string; position: number; positionDisplay: string;
  grossScore: number | null; scoreToPar: number | null; thru: string;
  flight: string | null; holesCompleted: number; isVerified: boolean;
  dns?: boolean; madeCut?: boolean | null;
  stablefordPoints?: number | null; parBogeyScore?: number | null;
  holeScores?: HoleScore[]; currentHole?: number | null;
  currentRound?: number; roundScores?: RoundScore[];
  teamId?: number | null; teamName?: string | null;
}
interface TeamMember { playerId: number; playerName: string; handicapIndex: number; grossScore: number | null; }
interface TeamEntry {
  position: number; positionDisplay: string;
  teamId: number; teamName: string; teamColour: string | null;
  grossScore: number | null; netScore: number | null;
  scoreToPar: number | null; netToPar: number | null;
  stablefordPoints: number | null; holesCompleted: number;
  members: TeamMember[];
}
interface Sponsor { id: number; name: string; logoUrl: string | null; tier: string; websiteUrl: string | null; }
interface Leaderboard {
  tournamentId: number; tournamentName: string; lastUpdated: string;
  coursePar: number; rounds: number; entries: Entry[];
  byFlight: Record<string, Entry[]>; flights: string[];
  organizationId: number | null;
  organizationName: string | null;
  organizationLogoUrl: string | null;
  organizationPrimaryColor: string | null;
  sponsors: Sponsor[];
  isTeamFormat?: boolean;
  teamEntries?: TeamEntry[];
  format?: string;
  cutLineIndex?: number | null;
  cutAfterRound?: number | null;
}

function formatScore(n: number | null) {
  if (n === null) return "-";
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

function scoreStyle(toPar: number | null): { color: string; bg: string } {
  if (toPar === null) return { color: "#9ca3af", bg: "transparent" };
  if (toPar <= -2) return { color: "#f59e0b", bg: "rgba(245,158,11,0.15)" };
  if (toPar === -1) return { color: "#ef4444", bg: "rgba(239,68,68,0.15)" };
  if (toPar === 0) return { color: "#e5e7eb", bg: "transparent" };
  if (toPar === 1) return { color: "#60a5fa", bg: "rgba(96,165,250,0.1)" };
  return { color: "#a78bfa", bg: "rgba(167,139,250,0.1)" };
}

function holeScoreBg(toPar: number): string {
  if (toPar <= -2) return "#C9A84C";
  if (toPar === -1) return "#ef4444";
  if (toPar === 0) return "rgba(255,255,255,0.05)";
  if (toPar === 1) return "#3b82f6";
  return "#8b5cf6";
}

function holeScoreColor(toPar: number): string {
  if (toPar === 0) return "#9ca3af";
  return "#fff";
}

function positionColor(pos: number): string {
  if (pos === 1) return "#f59e0b";
  if (pos === 2) return "#94a3b8";
  if (pos === 3) return "#b45309";
  return "#d1d5db";
}

function SpectatorQR({ tournamentId }: { tournamentId: number }) {
  const spectatorUrl = `${window.location.origin}/spectator/${tournamentId}`;
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=80x80&bgcolor=0a1a0e&color=C9A84C&data=${encodeURIComponent(spectatorUrl)}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "rgba(0,0,0,0.35)", border: "1px solid rgba(201,168,76,0.2)", borderRadius: 10, padding: "8px 10px" }}>
      <img src={qrSrc} alt="Spectator QR" width={72} height={72} style={{ borderRadius: 4, display: "block" }} />
      <span style={{ fontSize: 9, letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, color: "#C9A84C", textTransform: "uppercase" }}>👁 Scan to Follow Live</span>
    </div>
  );
}

export default function LeaderboardDisplay() {
  const params = useParams<{ tournamentId: string }>();
  const searchStr = useSearch();
  const tournamentId = parseInt(params.tournamentId ?? "0");

  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [currentFlightIdx, setCurrentFlightIdx] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [now, setNow] = useState(new Date());
  const [displayMode, setDisplayMode] = useState<"leaderboard" | "tracker">(
    new URLSearchParams(searchStr).get("view") === "tracker" ? "tracker" : "leaderboard"
  );
  const [cumulativeView, setCumulativeView] = useState(
    new URLSearchParams(searchStr).get("view") === "cumulative"
  );
  const [expandedTeams, setExpandedTeams] = useState<Set<number>>(new Set());
  const sseRef = useRef<EventSource | null>(null);
  const cycleRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  async function fetchLeaderboard(cumulative?: boolean) {
    try {
      const qs = cumulative ? "?view=cumulative" : "";
      const res = await fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/leaderboard${qs}`);
      if (res.ok) {
        const data: Leaderboard = await res.json();
        setLeaderboard(data);
        const orgPrimary = data.organizationPrimaryColor ?? "#22c55e";
        document.documentElement.style.setProperty("--org-primary", orgPrimary);
        document.documentElement.style.setProperty("--org-primary-20", `${orgPrimary}33`);
      }
    } catch {}
  }

  useEffect(() => {
    fetchLeaderboard(cumulativeView);
    const sse = new EventSource(`${baseUrl}/api/public/tournaments/${tournamentId}/leaderboard/stream`);
    sseRef.current = sse;
    sse.onmessage = () => { fetchLeaderboard(cumulativeView); };
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      sse.close();
      clearInterval(clock);
    };
  }, [tournamentId, cumulativeView]);

  // Keyboard shortcut: T = toggle tracker/leaderboard
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "t" || e.key === "T") {
        setDisplayMode(m => m === "leaderboard" ? "tracker" : "leaderboard");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-cycle through flights every 20 seconds (leaderboard mode only)
  useEffect(() => {
    if (!leaderboard || leaderboard.flights.length <= 1 || displayMode === "tracker") return;
    const allTabs = ["Overall", ...leaderboard.flights];
    cycleRef.current = setInterval(() => {
      setAnimating(true);
      setTimeout(() => {
        setCurrentFlightIdx(prev => (prev + 1) % allTabs.length);
        setAnimating(false);
      }, 500);
    }, 20000);
    return () => { if (cycleRef.current) clearInterval(cycleRef.current); };
  }, [leaderboard?.flights.length, displayMode]);

  if (!leaderboard) {
    return (
      <div style={{ minHeight: "100vh", background: "#0a0f0c", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "var(--org-primary, #22c55e)", fontSize: 24, fontFamily: "Georgia, serif", letterSpacing: 8 }}>GOLF LIVE</div>
      </div>
    );
  }

  const allTabs = ["Overall", ...leaderboard.flights.filter(f => f !== "Overall")];
  const activeFlight = allTabs[currentFlightIdx] ?? "Overall";
  const flightKey = leaderboard.byFlight[activeFlight] !== undefined
    ? activeFlight
    : Object.keys(leaderboard.byFlight).find(k => k.toLowerCase() === activeFlight.toLowerCase()) ?? activeFlight;
  const allFlightEntries = activeFlight === "Overall"
    ? leaderboard.entries.filter(e => e.grossScore !== null)
    : (leaderboard.byFlight[flightKey] ?? []);
  const survivorFlightEntries = allFlightEntries.filter(e => e.madeCut !== false);
  const cutFlightEntries = allFlightEntries.filter(e => e.madeCut === false);
  const displayEntries = survivorFlightEntries.slice(0, 18);

  const inProgress = leaderboard.entries.filter(e => e.holesCompleted > 0 && e.holesCompleted < 18).length;
  const holes = Array.from({ length: 18 }, (_, i) => i + 1);

  return (
    <main id="main-content" tabIndex={-1} style={{
      minHeight: "100vh",
      background: "linear-gradient(160deg, #071209 0%, #0a1a0e 40%, #060e08 100%)",
      fontFamily: "'Georgia', serif",
      color: "#e5e7eb",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      outline: "none",
    }}>
      {/* Top banner */}
      <div style={{
        background: "rgba(0,0,0,0.6)",
        borderBottom: "2px solid #1a3a1e",
        padding: "20px 48px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <img
            src={leaderboard.organizationLogoUrl ?? "/logo.png"}
            alt={leaderboard.organizationName ?? "KharaGolf"}
            style={{ height: 56, width: "auto", objectFit: "contain", borderRadius: 6, background: "rgba(255,255,255,0.06)", padding: 4 }}
          />
          <div>
            <div style={{ fontSize: 11, letterSpacing: 6, fontFamily: "Arial, sans-serif", fontWeight: 700, marginBottom: 4 }}>
              {leaderboard.organizationName
                ? <span style={{ color: "var(--org-primary, #22c55e)" }}>{leaderboard.organizationName.toUpperCase()} ENTERPRISE</span>
                : <><span style={{ color: "#ffffff" }}>KHARA</span><span style={{ color: "#C9A84C" }}>GOLF</span><span style={{ color: "#ffffff" }}> ENTERPRISE</span></>}
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#ffffff", letterSpacing: 1 }}>
              {leaderboard.tournamentName}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {/* QR code for spectators */}
          <SpectatorQR tournamentId={tournamentId} />

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {/* View toggle */}
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "1px solid #243b2e" }}>
                {(["leaderboard", "tracker"] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => { setDisplayMode(m); if (m === "tracker") setCumulativeView(false); }}
                    style={{
                      padding: "4px 14px",
                      background: displayMode === m && !cumulativeView ? "var(--org-primary, #22c55e)" : "transparent",
                      color: displayMode === m && !cumulativeView ? "#000" : "#d1d5db",
                      border: "none",
                      cursor: "pointer",
                      fontSize: 11,
                      fontFamily: "Arial, sans-serif",
                      fontWeight: 700,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                    }}
                  >
                    {m === "leaderboard" ? "Standings" : "⛳ Tracker"}
                  </button>
                ))}
                {(leaderboard?.rounds ?? 1) > 1 && (
                  <button
                    onClick={() => { setCumulativeView(v => !v); setDisplayMode("leaderboard"); }}
                    style={{
                      padding: "4px 14px",
                      background: cumulativeView ? "#C9A84C" : "transparent",
                      color: cumulativeView ? "#000" : "#d1d5db",
                      border: "none",
                      borderLeft: "1px solid #243b2e",
                      cursor: "pointer",
                      fontSize: 11,
                      fontFamily: "Arial, sans-serif",
                      fontWeight: 700,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                    }}
                  >
                    Cumulative
                  </button>
                )}
              </div>
              <div style={{ fontSize: 32, color: "var(--org-primary, #22c55e)", fontWeight: 700, fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums" }}>
                {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </div>
            </div>
            <div style={{ fontSize: 13, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>
              {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            </div>
            {inProgress > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: 4, background: "#22c55e", boxShadow: "0 0 8px #22c55e" }} />
                <span style={{ fontSize: 12, color: "#22c55e", fontFamily: "Arial, sans-serif", letterSpacing: 1 }}>{inProgress} PLAYER{inProgress !== 1 ? "S" : ""} ON COURSE</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {displayMode === "tracker" ? (
        /* ─── Tracker Grid ──────────────────────────────────────────────────────── */
        <div style={{ flex: 1, overflowX: "auto", overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 1100 }}>
            <colgroup>
              <col style={{ width: 220 }} />
              <col style={{ width: 50 }} />
              {holes.map(h => <col key={h} style={{ width: 48 }} />)}
              <col style={{ width: 64 }} />
            </colgroup>
            <thead>
              <tr style={{ background: "#0d1f14", borderBottom: "2px solid #1a3028" }}>
                <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, color: "#4b7060", letterSpacing: 2, fontFamily: "Arial, sans-serif", position: "sticky", left: 0, zIndex: 2, background: "#0d1f14", boxShadow: "2px 0 6px rgba(0,0,0,0.4)" }}>PLAYER</th>
                <th style={{ padding: "10px 4px", textAlign: "center", fontSize: 11, color: "#4b7060", letterSpacing: 2, fontFamily: "Arial, sans-serif" }}>THRU</th>
                {holes.map(h => (
                  <th key={h} style={{ padding: "10px 2px", textAlign: "center", fontSize: 11, color: h >= 10 ? "#f59e0b" : "#4b7060", letterSpacing: 1, fontFamily: "Arial, sans-serif", fontWeight: 700 }}>
                    {h}
                  </th>
                ))}
                <th style={{ padding: "10px 4px", textAlign: "center", fontSize: 11, color: "#4b7060", letterSpacing: 2, fontFamily: "Arial, sans-serif" }}>TOT</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.entries.slice(0, 24).map((entry, i) => {
                const roundHoles = entry.holeScores ?? [];
                const scoreByHole: Record<number, HoleScore> = {};
                for (const h of roundHoles) scoreByHole[h.hole] = h;
                const totalToPar = roundHoles.reduce((s, h) => s + h.toPar, 0);

                return (
                  <tr key={entry.playerId} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <td style={{ padding: "0 16px", height: 44, position: "sticky", left: 0, zIndex: 1, background: i % 2 === 0 ? "#0e1f16" : "#0b1512", boxShadow: "2px 0 6px rgba(0,0,0,0.4)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, color: "#9ca3af", fontFamily: "Arial, sans-serif", width: 24, flexShrink: 0 }}>{entry.positionDisplay}</span>
                        <span style={{ fontSize: 15, fontWeight: 600, color: entry.position <= 3 ? "#fff" : "#d1d5db", letterSpacing: 0.2 }}>{entry.playerName}</span>
                      </div>
                    </td>
                    <td style={{ textAlign: "center", fontSize: 13, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>{entry.thru}</td>
                    {holes.map(h => {
                      const hs = scoreByHole[h];
                      const isCurrentHole = h === entry.currentHole && !hs;
                      if (isCurrentHole) {
                        return (
                          <td key={h} style={{ textAlign: "center", padding: 2 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 4, background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.4)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}>
                              <div style={{ width: 6, height: 6, borderRadius: 3, background: "#22c55e" }} />
                            </div>
                          </td>
                        );
                      }
                      if (!hs) {
                        return (
                          <td key={h} style={{ textAlign: "center", fontSize: 12, color: "#374151", fontFamily: "Arial, sans-serif" }}>—</td>
                        );
                      }
                      return (
                        <td key={h} style={{ padding: 2 }}>
                          <div style={{
                            width: 32, height: 32, borderRadius: 4,
                            background: holeScoreBg(hs.toPar),
                            display: "flex", alignItems: "center", justifyContent: "center",
                            margin: "0 auto",
                          }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: holeScoreColor(hs.toPar), fontFamily: "Arial, sans-serif" }}>{hs.strokes}</span>
                          </div>
                        </td>
                      );
                    })}
                    <td style={{ textAlign: "center" }}>
                      <span style={{
                        fontSize: 14, fontWeight: 700, fontFamily: "Arial, sans-serif",
                        color: totalToPar < 0 ? "#ef4444" : totalToPar > 0 ? "#60a5fa" : "#9ca3af",
                      }}>
                        {roundHoles.length === 0 ? "–" : totalToPar === 0 ? "E" : totalToPar > 0 ? `+${totalToPar}` : String(totalToPar)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Hint */}
          <div style={{ padding: "8px 24px", fontSize: 11, color: "#374151", fontFamily: "Arial, sans-serif", letterSpacing: 1 }}>
            Press <kbd style={{ background: "#1a2c22", color: "#4b7060", padding: "1px 5px", borderRadius: 3, border: "1px solid #243b2e" }}>T</kbd> to toggle between Standings and Tracker Grid
          </div>
        </div>
      ) : (
        /* ─── Standings (existing layout) ─────────────────────────────────────── */
        <>
          {/* Flight label */}
          <div style={{
            background: "#1a3a1e",
            borderBottom: "1px solid #243b2e",
            padding: "10px 48px",
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}>
            <div style={{ fontSize: 13, color: "var(--org-primary, #22c55e)", letterSpacing: 4, fontFamily: "Arial, sans-serif", fontWeight: 700 }}>
              {activeFlight.toUpperCase()}
            </div>
            {allTabs.length > 1 && (
              <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                {allTabs.map((f, i) => (
                  <button
                    key={f}
                    onClick={() => { setCurrentFlightIdx(i); }}
                    style={{
                      padding: "3px 12px",
                      borderRadius: 20,
                      border: "1px solid",
                      borderColor: i === currentFlightIdx ? "var(--org-primary, #22c55e)" : "#243b2e",
                      background: i === currentFlightIdx ? "color-mix(in srgb, var(--org-primary, #22c55e) 12%, transparent)" : "transparent",
                      color: i === currentFlightIdx ? "var(--org-primary, #22c55e)" : "#d1d5db",
                      fontSize: 12,
                      cursor: "pointer",
                      fontFamily: "Arial, sans-serif",
                      transition: "all 0.2s",
                    }}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
            <div style={{ marginLeft: allTabs.length > 1 ? 8 : "auto", fontSize: 12, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>
              Par {leaderboard.coursePar}
            </div>
          </div>

          {cumulativeView ? (
            /* ─── Cumulative Round-by-Round View ─────────────────────────────── */
            <>
              {/* Cumulative header */}
              <div style={{ display: "grid", gridTemplateColumns: `60px 1fr ${Array.from({ length: leaderboard.rounds ?? 1 }, () => "80px").join(" ")} 100px`, padding: "8px 48px", borderBottom: "1px solid #1a3028", background: "rgba(0,0,0,0.3)" }}>
                {["POS", "PLAYER", ...Array.from({ length: leaderboard.rounds ?? 1 }, (_, i) => `RD ${i + 1}`), "TOTAL"].map(h => (
                  <div key={h} style={{ fontSize: 11, color: "#4b7060", letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, textAlign: h === "POS" || h.startsWith("RD") || h === "TOTAL" ? "center" : "left" }}>{h}</div>
                ))}
              </div>
              <div style={{ flex: 1, overflowY: "hidden", opacity: animating ? 0 : 1, transition: "opacity 0.5s ease" }}>
                {displayEntries.map((entry, i) => {
                  const rds = leaderboard.rounds ?? 1;
                  return (
                    <div key={entry.playerId} style={{ display: "grid", gridTemplateColumns: `60px 1fr ${Array.from({ length: rds }, () => "80px").join(" ")} 100px`, padding: "0 48px", height: 52, alignItems: "center", background: i === 0 ? "rgba(245,158,11,0.06)" : i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      <div style={{ textAlign: "center", fontSize: 18, fontWeight: 800, color: entry.grossScore !== null ? positionColor(entry.position) : "#4b7060" }}>{entry.grossScore !== null ? entry.positionDisplay : "–"}</div>
                      <div style={{ fontSize: 18, fontWeight: entry.position <= 3 ? 700 : 500, color: entry.position <= 3 ? "#ffffff" : "#d1d5db" }}>{entry.playerName}</div>
                      {Array.from({ length: rds }, (_, r) => {
                        const rs = (entry.roundScores ?? []).find(s => s.round === r + 1);
                        const col = rs?.scoreToPar != null ? (rs.scoreToPar < 0 ? "#ef4444" : rs.scoreToPar > 0 ? "#60a5fa" : "#9ca3af") : "#4b7060";
                        return (
                          <div key={r} style={{ textAlign: "center", fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums" }}>
                            {rs?.isComplete ? (
                              <span style={{ fontSize: 16, fontWeight: 700, color: col }}>{formatScore(rs.scoreToPar)}</span>
                            ) : (
                              <span style={{ fontSize: 14, color: "#374151" }}>–</span>
                            )}
                            {rs?.isComplete && (
                              <div style={{ fontSize: 10, color: "#4b7060" }}>{rs.grossScore}</div>
                            )}
                          </div>
                        );
                      })}
                      <div style={{ textAlign: "center" }}>
                        <span style={{ display: "inline-block", minWidth: 56, padding: "3px 10px", borderRadius: 8, fontSize: 18, fontWeight: 800, fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums", color: scoreStyle(entry.scoreToPar).color, background: scoreStyle(entry.scoreToPar).bg }}>
                          {formatScore(entry.scoreToPar)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {cutFlightEntries.length > 0 && (
                <div
                  data-testid="display-cut-section-cumulative"
                  style={{
                    background: "rgba(0,0,0,0.5)",
                    borderTop: "1px solid rgba(239,68,68,0.25)",
                    padding: "10px 48px 12px",
                    flexShrink: 0,
                    maxHeight: 130,
                    overflow: "hidden",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: "#f87171", letterSpacing: 3, fontFamily: "Arial, sans-serif", fontWeight: 700 }}>
                      MISSED THE CUT
                    </span>
                    <span style={{ fontSize: 10, color: "#9ca3af", fontFamily: "Arial, sans-serif", letterSpacing: 1 }}>
                      {cutFlightEntries.length} PLAYER{cutFlightEntries.length !== 1 ? "S" : ""}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
                    {cutFlightEntries.slice(0, 24).map(p => (
                      <div key={p.playerId} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 13, fontFamily: "Arial, sans-serif", color: "#9ca3af" }}>
                        <span style={{ opacity: 0.85 }}>{p.playerName}</span>
                        <span style={{ color: "#9ca3af", fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{formatScore(p.scoreToPar)}</span>
                      </div>
                    ))}
                    {cutFlightEntries.length > 24 && (
                      <span style={{ fontSize: 12, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>
                        + {cutFlightEntries.length - 24} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            /* ─── Normal Standings ──────────────────────────────────────────── */
            <>
          {/* Column headers */}
          {(() => {
            const fmt = leaderboard.format ?? "";
            // maximum_score is capped stroke play — displays same as stroke play (SCORE / +/-)
            const isStableford = fmt === "stableford" || fmt === "team_stableford";
            const isParBogey = fmt === "par_bogey";
            const scoreHeader = isStableford ? "PTS" : isParBogey ? "W/L" : "SCORE";
            const diffHeader = isStableford || isParBogey ? "" : "+/-";
            return (
              <div style={{
                display: "grid",
                gridTemplateColumns: "60px 1fr 120px 80px 120px 100px",
                padding: "8px 48px",
                borderBottom: "1px solid #1a3028",
                background: "rgba(0,0,0,0.3)",
              }}>
                {["POS", "PLAYER", "FLIGHT", "THRU", scoreHeader, diffHeader].map(h => (
                  <div key={h} style={{ fontSize: 11, color: "#4b7060", letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, textAlign: h === "POS" || h === "THRU" || h === scoreHeader || h === diffHeader ? "center" : "left" }}>
                    {h}
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Entries */}
          <div style={{
            flex: 1,
            overflowY: "hidden",
            opacity: animating ? 0 : 1,
            transition: "opacity 0.5s ease",
          }}>
            {/* ── Team Standings (when isTeamFormat + teamEntries present) ── */}
            {leaderboard.isTeamFormat && leaderboard.teamEntries && leaderboard.teamEntries.length > 0 ? (
              leaderboard.teamEntries.slice(0, 16).map((team, i) => {
                const style = scoreStyle(team.scoreToPar);
                const isExpanded = expandedTeams.has(team.teamId);
                return (
                  <div key={team.teamId}>
                    <div
                      onClick={() => setExpandedTeams(prev => { const next = new Set(prev); isExpanded ? next.delete(team.teamId) : next.add(team.teamId); return next; })}
                      style={{ display: "grid", gridTemplateColumns: "60px 1fr 80px 80px 100px", padding: "0 48px", height: 60, alignItems: "center", cursor: "pointer", background: i === 0 ? "rgba(245,158,11,0.06)" : i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent", borderBottom: isExpanded ? "none" : "1px solid rgba(255,255,255,0.04)", transition: "background 0.2s" }}
                    >
                      <div style={{ textAlign: "center", fontSize: 18, fontWeight: 800, color: team.grossScore !== null ? positionColor(team.position) : "#4b7060" }}>{team.grossScore !== null ? team.positionDisplay : "–"}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {team.teamColour && <div style={{ width: 14, height: 14, borderRadius: "50%", background: team.teamColour, flexShrink: 0 }} />}
                        <span style={{ fontSize: 20, fontWeight: team.position <= 3 ? 700 : 500, color: team.position <= 3 ? "#ffffff" : "#d1d5db", letterSpacing: 0.3 }}>{team.teamName}</span>
                        <span style={{ fontSize: 11, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>{team.members.length} players</span>
                        <span style={{ fontSize: 13, color: "#4b7060", marginLeft: "auto" }}>{isExpanded ? "▲" : "▼"}</span>
                      </div>
                      <div style={{ textAlign: "center", fontSize: 13, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>{team.holesCompleted > 0 ? `T${team.holesCompleted}` : "–"}</div>
                      <div style={{ textAlign: "center", fontSize: 14, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>{team.grossScore ?? "–"}</div>
                      <div style={{ textAlign: "center" }}>
                        <span style={{ display: "inline-block", minWidth: 56, padding: "3px 10px", borderRadius: 8, fontSize: 18, fontWeight: 800, fontFamily: "Arial, sans-serif", color: style.color, background: style.bg }}>{formatScore(team.scoreToPar)}</span>
                      </div>
                    </div>
                    {isExpanded && (
                      <div style={{ background: "rgba(0,0,0,0.3)", borderBottom: "1px solid rgba(255,255,255,0.04)", padding: "8px 48px 12px 120px" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px", gap: 2, marginBottom: 4 }}>
                          {["PLAYER", "SCORE", "+/-"].map(h => <div key={h} style={{ fontSize: 10, color: "#4b7060", letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, textAlign: h !== "PLAYER" ? "center" : "left" }}>{h}</div>)}
                        </div>
                        {team.members.map((m, mi) => (
                          <div key={m.playerId} style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px", gap: 2, padding: "4px 0", borderTop: mi > 0 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                            <div style={{ fontSize: 14, color: "#d1d5db" }}>{m.playerName} <span style={{ fontSize: 11, color: "#4b7060" }}>HCP {m.handicapIndex}</span></div>
                            <div style={{ textAlign: "center", fontSize: 14, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>{m.grossScore ?? "–"}</div>
                            <div style={{ textAlign: "center", fontSize: 14, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>–</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (() => {
              const fmt = leaderboard.format ?? "";
              // maximum_score is capped stroke play — displays gross score + to-par (not stableford points)
              const isStablefordFmt = fmt === "stableford" || fmt === "team_stableford";
              const isParBogeyFmt = fmt === "par_bogey";

              return displayEntries.map((entry, i) => {
              const style = scoreStyle(entry.scoreToPar);
              const isEven = i % 2 === 0;
              const isMissedCut = entry.madeCut === false;
              // Display score: stableford points or par/bogey score or gross
              const displayScore = isStablefordFmt
                ? (entry.stablefordPoints !== null && entry.stablefordPoints !== undefined ? String(entry.stablefordPoints) : "–")
                : isParBogeyFmt
                  ? (entry.parBogeyScore !== null && entry.parBogeyScore !== undefined
                    ? (entry.parBogeyScore > 0 ? `+${entry.parBogeyScore}` : entry.parBogeyScore === 0 ? "A/S" : String(entry.parBogeyScore))
                    : "–")
                  : (entry.grossScore !== null ? String(entry.grossScore) : "–");
              const scoreColor = isStablefordFmt
                ? (entry.stablefordPoints !== null && entry.stablefordPoints !== undefined ? "#C9A84C" : "#4b7060")
                : isParBogeyFmt
                  ? (entry.parBogeyScore !== null && entry.parBogeyScore !== undefined
                    ? (entry.parBogeyScore > 0 ? "#ef4444" : entry.parBogeyScore < 0 ? "#60a5fa" : "#9ca3af")
                    : "#4b7060")
                  : entry.grossScore !== null ? "#ffffff" : "#4b7060";
              return (
                <div
                  key={entry.playerId}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "60px 1fr 120px 80px 120px 100px",
                    padding: "0 48px",
                    height: 56,
                    alignItems: "center",
                    background: i === 0 ? "rgba(245,158,11,0.06)" : isEven ? "rgba(255,255,255,0.02)" : "transparent",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    opacity: isMissedCut ? 0.6 : 1,
                  }}
                >
                  <div style={{ textAlign: "center", fontSize: 18, fontWeight: 800, color: entry.dns ? "#f87171" : isMissedCut ? "#d1d5db" : entry.grossScore !== null || entry.stablefordPoints !== null ? positionColor(entry.position) : "#4b7060" }}>
                    {entry.dns ? "DNS" : isMissedCut ? "MC" : entry.grossScore !== null || entry.stablefordPoints !== null ? entry.positionDisplay : "–"}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 20, fontWeight: entry.position <= 3 && !entry.dns && !isMissedCut ? 700 : 500, color: entry.dns || isMissedCut ? "#9ca3af" : entry.position <= 3 ? "#ffffff" : "#d1d5db", letterSpacing: 0.3 }}>
                      {entry.playerName}
                    </span>
                    {entry.dns && (
                      <span style={{ fontSize: 10, background: "rgba(239,68,68,0.2)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, padding: "2px 6px" }}>DNS</span>
                    )}
                    {isMissedCut && !entry.dns && (
                      <span style={{ fontSize: 10, background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 4, padding: "2px 6px", letterSpacing: 1 }}>MC</span>
                    )}
                    {entry.isVerified && !entry.dns && !isMissedCut && (
                      <span style={{ fontSize: 11, color: "#22c55e", background: "rgba(34,197,94,0.15)", borderRadius: 4, padding: "1px 5px", border: "1px solid rgba(34,197,94,0.3)" }}>✓</span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>
                    {entry.flight ?? "–"}
                  </div>
                  <div style={{ textAlign: "center", fontSize: 16, color: "#9ca3af", fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums" }}>
                    {entry.thru}
                  </div>
                  <div style={{ textAlign: "center", fontSize: 22, fontWeight: 700, color: scoreColor, fontVariantNumeric: "tabular-nums" }}>
                    {displayScore}
                  </div>
                  <div style={{ textAlign: "center" }}>
                    {isStablefordFmt || isParBogeyFmt ? null : (
                    <span style={{
                      display: "inline-block",
                      minWidth: 56, padding: "3px 10px", borderRadius: 8,
                      fontSize: 18, fontWeight: 800,
                      color: style.color, background: style.bg,
                      fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums",
                    }}>
                      {formatScore(entry.scoreToPar)}
                    </span>
                    )}
                  </div>
                </div>
              );
            });
            })()}
          </div>

          {/* ── Missed the Cut (always-on secondary block, no toggle) ── */}
          {cutFlightEntries.length > 0 && (
            <div
              data-testid="display-cut-section"
              style={{
                background: "rgba(0,0,0,0.5)",
                borderTop: "1px solid rgba(239,68,68,0.25)",
                padding: "10px 48px 12px",
                flexShrink: 0,
                maxHeight: 130,
                overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "#f87171", letterSpacing: 3, fontFamily: "Arial, sans-serif", fontWeight: 700 }}>
                  MISSED THE CUT
                </span>
                <span style={{ fontSize: 10, color: "#9ca3af", fontFamily: "Arial, sans-serif", letterSpacing: 1 }}>
                  {cutFlightEntries.length} PLAYER{cutFlightEntries.length !== 1 ? "S" : ""}
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
                {cutFlightEntries.slice(0, 24).map(p => (
                  <div key={p.playerId} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 13, fontFamily: "Arial, sans-serif", color: "#9ca3af" }}>
                    <span style={{ opacity: 0.85 }}>{p.playerName}</span>
                    <span style={{ color: "#9ca3af", fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{formatScore(p.scoreToPar)}</span>
                  </div>
                ))}
                {cutFlightEntries.length > 24 && (
                  <span style={{ fontSize: 12, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>
                    + {cutFlightEntries.length - 24} more
                  </span>
                )}
              </div>
            </div>
          )}
            </>
          )}
        </>
      )}

      {/* Bottom bar */}
      <div style={{
        background: "rgba(0,0,0,0.5)",
        borderTop: "1px solid #1a3028",
        padding: "12px 48px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 24 }}>
            {[["#C9A84C", "Eagle or Better"], ["#ef4444", "Birdie"], ["rgba(255,255,255,0.08)", "Par"], ["#3b82f6", "Bogey"], ["#8b5cf6", "Double+"]].map(([color, label]) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                <span style={{ fontSize: 11, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>{label}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>
            Live · Updated {new Date(leaderboard.lastUpdated).toLocaleTimeString()}
          </div>
        </div>
        {leaderboard.sponsors && leaderboard.sponsors.length > 0 && (() => {
          leaderboard.sponsors.forEach(s => trackImpression(s.id, "display"));
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 20, borderTop: "1px solid #1a3028", paddingTop: 8 }}>
              <span style={{ fontSize: 9, color: "#4b7060", fontFamily: "Arial, sans-serif", letterSpacing: 3, textTransform: "uppercase" }}>Sponsors</span>
              {leaderboard.sponsors.map(s => (
                s.logoUrl ? (
                  <img key={s.id} src={s.logoUrl} alt={s.name} style={{ height: 24, width: "auto", objectFit: "contain", opacity: 0.7 }} />
                ) : (
                  <span key={s.id} style={{ fontSize: 11, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>{s.name}</span>
                )
              ))}
              {leaderboard.organizationId && (
                <div style={{ marginLeft: "auto", height: 32, minWidth: 100 }}>
                  <AdSlot
                    orgId={leaderboard.organizationId}
                    slotKey="leaderboard_bug"
                    tournamentId={leaderboard.tournamentId}
                    style={{ height: 32 }}
                  />
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </main>
  );
}
