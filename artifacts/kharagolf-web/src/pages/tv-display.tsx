import { useEffect, useRef, useState, useCallback } from "react";
import AdSlot from "@/components/AdSlot";

// ─── Types ─────────────────────────────────────────────────────────────────

interface HoleScore { hole: number; round: number; strokes: number; par: number; toPar: number; }
interface RoundScore { round: number; grossScore: number; scoreToPar: number; netScore?: number | null; isComplete: boolean; }
interface Entry {
  playerId: number; playerName: string; position: number; positionDisplay: string;
  grossScore: number | null; scoreToPar: number | null; thru: string;
  flight: string | null; holesCompleted: number; isVerified: boolean;
  dns?: boolean; holeScores?: HoleScore[]; currentHole?: number | null;
  currentRound?: number; roundScores?: RoundScore[];
}
interface Sponsor { id: number; name: string; logoUrl: string | null; tier: string; websiteUrl: string | null; }
interface SideGameResult {
  id: number; gameType: string; holeNumber: number | null; round: number | null;
  notes: string | null; prize: string | null; playerName: string;
}
interface SkinResult {
  hole: number; round: number; winnerName: string | null; winnerScore: number | null; tied: boolean;
}
interface SideGames {
  config: {
    skinsEnabled: boolean; skinsPrize: string | null;
    ctpEnabled: boolean; ctpHoles: number[]; ctpPrize: string | null;
    ldEnabled: boolean; ldHoles: number[]; ldPrize: string | null;
    greeniesEnabled: boolean; greeniesPrize: string | null;
  } | null;
  manual: SideGameResult[];
  skins: SkinResult[];
}
interface Tournament {
  id: number; name: string; format: string; status: string; rounds: number; coursePar: number;
  leaderboard: {
    entries: Entry[];
    netEntries: Entry[];
    byFlight: Record<string, Entry[]>;
    flights: string[];
    lastUpdated: string;
    isTeamFormat?: boolean;
  } | null;
  sideGames: SideGames | null;
  sponsors: Sponsor[];
}
interface DisplayData {
  org: { name: string; logoUrl: string | null; primaryColor: string | null };
  settings: {
    rotationSequence: string[];
    rotationIntervalSeconds: number;
    sponsorSlideDurationSeconds: number;
    showSponsorSlides: boolean;
    showSideGames: boolean;
    showTracker: boolean;
  };
  tournaments: Tournament[];
}

type ViewType = "leaderboard" | "tracker" | "sidegames" | "sponsor" | "pairing";

// ─── Utilities ──────────────────────────────────────────────────────────────

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

function positionColor(pos: number): string {
  if (pos === 1) return "#f59e0b";
  if (pos === 2) return "#94a3b8";
  if (pos === 3) return "#b45309";
  return "#6b7280";
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function LeaderboardView({ tournament, animating }: { tournament: Tournament; animating: boolean }) {
  const lb = tournament.leaderboard;
  if (!lb) return <NoData message="No leaderboard data yet" />;
  const entries = lb.entries.filter(e => e.grossScore !== null).slice(0, 18);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", opacity: animating ? 0 : 1, transition: "opacity 0.4s ease" }}>
      <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 120px 80px 120px 100px", padding: "8px 48px", borderBottom: "1px solid #1a3028", background: "rgba(0,0,0,0.3)" }}>
        {["POS", "PLAYER", "FLIGHT", "THRU", "SCORE", "+/-"].map(h => (
          <div key={h} style={{ fontSize: 11, color: "#4b7060", letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, textAlign: ["POS","THRU","SCORE","+/-"].includes(h) ? "center" : "left" }}>{h}</div>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "hidden" }}>
        {entries.map((entry, i) => {
          const style = scoreStyle(entry.scoreToPar);
          return (
            <div key={entry.playerId} style={{ display: "grid", gridTemplateColumns: "60px 1fr 120px 80px 120px 100px", padding: "0 48px", height: 56, alignItems: "center", background: i === 0 ? "rgba(245,158,11,0.06)" : i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
              <div style={{ textAlign: "center", fontSize: 18, fontWeight: 800, color: entry.dns ? "#f87171" : positionColor(entry.position) }}>
                {entry.dns ? "DNS" : entry.positionDisplay}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 20, fontWeight: entry.position <= 3 ? 700 : 500, color: entry.position <= 3 ? "#fff" : "#d1d5db" }}>{entry.playerName}</span>
                {entry.isVerified && <span style={{ fontSize: 11, color: "#22c55e", background: "rgba(34,197,94,0.15)", borderRadius: 4, padding: "1px 5px", border: "1px solid rgba(34,197,94,0.3)" }}>✓</span>}
              </div>
              <div style={{ fontSize: 13, color: "#6b7280", fontFamily: "Arial, sans-serif" }}>{entry.flight ?? "–"}</div>
              <div style={{ textAlign: "center", fontSize: 16, color: "#9ca3af", fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums" }}>{entry.thru}</div>
              <div style={{ textAlign: "center", fontSize: 22, fontWeight: 700, color: "#fff", fontVariantNumeric: "tabular-nums" }}>{entry.grossScore ?? "–"}</div>
              <div style={{ textAlign: "center" }}>
                <span style={{ display: "inline-block", minWidth: 56, padding: "3px 10px", borderRadius: 8, fontSize: 18, fontWeight: 800, color: style.color, background: style.bg, fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums" }}>{formatScore(entry.scoreToPar)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrackerView({ tournament, animating }: { tournament: Tournament; animating: boolean }) {
  const lb = tournament.leaderboard;
  if (!lb) return <NoData message="No tracker data yet" />;
  const entries = lb.entries.slice(0, 20);
  const holes = Array.from({ length: 18 }, (_, i) => i + 1);

  return (
    <div style={{ flex: 1, overflowX: "auto", overflowY: "auto", opacity: animating ? 0 : 1, transition: "opacity 0.4s ease" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 1100 }}>
        <colgroup>
          <col style={{ width: 200 }} />
          <col style={{ width: 46 }} />
          {holes.map(h => <col key={h} style={{ width: 46 }} />)}
          <col style={{ width: 60 }} />
        </colgroup>
        <thead>
          <tr style={{ background: "#0d1f14", borderBottom: "2px solid #1a3028" }}>
            <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, color: "#4b7060", letterSpacing: 2, fontFamily: "Arial, sans-serif", position: "sticky", left: 0, zIndex: 2, background: "#0d1f14", boxShadow: "2px 0 6px rgba(0,0,0,0.4)" }}>PLAYER</th>
            <th style={{ padding: "10px 4px", textAlign: "center", fontSize: 11, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>THRU</th>
            {holes.map(h => (
              <th key={h} style={{ padding: "10px 2px", textAlign: "center", fontSize: 11, color: h >= 10 ? "#f59e0b" : "#4b7060", fontFamily: "Arial, sans-serif", fontWeight: 700 }}>{h}</th>
            ))}
            <th style={{ padding: "10px 4px", textAlign: "center", fontSize: 11, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>TOT</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => {
            const roundHoles = entry.holeScores ?? [];
            const scoreByHole: Record<number, HoleScore> = {};
            for (const h of roundHoles) scoreByHole[h.hole] = h;
            const totalToPar = roundHoles.reduce((s, h) => s + h.toPar, 0);
            return (
              <tr key={entry.playerId} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <td style={{ padding: "0 16px", height: 42, position: "sticky", left: 0, zIndex: 1, background: i % 2 === 0 ? "#0e1f16" : "#0b1512", boxShadow: "2px 0 6px rgba(0,0,0,0.4)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, color: "#6b7280", width: 24, flexShrink: 0, fontFamily: "Arial, sans-serif" }}>{entry.positionDisplay}</span>
                    <span style={{ fontSize: 15, fontWeight: 600, color: entry.position <= 3 ? "#fff" : "#d1d5db" }}>{entry.playerName}</span>
                  </div>
                </td>
                <td style={{ textAlign: "center", fontSize: 13, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>{entry.thru}</td>
                {holes.map(h => {
                  const hs = scoreByHole[h];
                  if (!hs) return <td key={h} style={{ textAlign: "center", fontSize: 12, color: "#374151", fontFamily: "Arial, sans-serif" }}>—</td>;
                  return (
                    <td key={h} style={{ padding: 2 }}>
                      <div style={{ width: 30, height: 30, borderRadius: 4, background: holeScoreBg(hs.toPar), display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: hs.toPar === 0 ? "#9ca3af" : "#fff", fontFamily: "Arial, sans-serif" }}>{hs.strokes}</span>
                      </div>
                    </td>
                  );
                })}
                <td style={{ textAlign: "center" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "Arial, sans-serif", color: totalToPar < 0 ? "#ef4444" : totalToPar > 0 ? "#60a5fa" : "#9ca3af" }}>
                    {roundHoles.length === 0 ? "–" : formatScore(totalToPar)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SideGamesView({ tournament, animating }: { tournament: Tournament; animating: boolean }) {
  const sg = tournament.sideGames;
  if (!sg || !sg.config) return <NoData message="No side games configured" />;

  const ctpResults = sg.manual.filter(r => r.gameType === "ctp");
  const ldResults = sg.manual.filter(r => r.gameType === "ld");
  const greenieResults = sg.manual.filter(r => r.gameType === "greenie");
  const wonSkins = sg.skins.filter(s => !s.tied && s.winnerName);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", opacity: animating ? 0 : 1, transition: "opacity 0.4s ease", padding: "24px 48px", gap: 24 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 24 }}>
        {/* Skins */}
        {sg.config.skinsEnabled && (
          <div style={{ background: "rgba(0,0,0,0.4)", border: "1px solid #1a3028", borderRadius: 12, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div style={{ fontSize: 20 }}>🎴</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#f59e0b", letterSpacing: 1 }}>SKINS</div>
                {sg.config.skinsPrize && <div style={{ fontSize: 12, color: "#6b7280" }}>{sg.config.skinsPrize}</div>}
              </div>
            </div>
            {wonSkins.length === 0 ? (
              <div style={{ fontSize: 14, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>No skins won yet</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {wonSkins.slice(0, 10).map((s, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    <div>
                      <span style={{ fontSize: 12, color: "#4b7060", fontFamily: "Arial, sans-serif", marginRight: 8 }}>Hole {s.hole}</span>
                      <span style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>{s.winnerName}</span>
                    </div>
                    <span style={{ fontSize: 13, color: "#9ca3af", fontFamily: "Arial, sans-serif" }}>{s.winnerScore} strokes</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* CTP */}
        {sg.config.ctpEnabled && (
          <div style={{ background: "rgba(0,0,0,0.4)", border: "1px solid #1a3028", borderRadius: 12, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div style={{ fontSize: 20 }}>🎯</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#22c55e", letterSpacing: 1 }}>CLOSEST TO PIN</div>
                {sg.config.ctpPrize && <div style={{ fontSize: 12, color: "#6b7280" }}>Holes: {sg.config.ctpHoles.join(", ")} · {sg.config.ctpPrize}</div>}
              </div>
            </div>
            {ctpResults.length === 0 ? (
              <div style={{ fontSize: 14, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>No winners yet</div>
            ) : (
              ctpResults.map((r) => (
                <div key={r.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>Hole {r.holeNumber}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{r.playerName}</div>
                  {r.notes && <div style={{ fontSize: 12, color: "#9ca3af" }}>{r.notes}</div>}
                </div>
              ))
            )}
          </div>
        )}

        {/* Longest Drive */}
        {sg.config.ldEnabled && (
          <div style={{ background: "rgba(0,0,0,0.4)", border: "1px solid #1a3028", borderRadius: 12, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div style={{ fontSize: 20 }}>🏌️</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#60a5fa", letterSpacing: 1 }}>LONGEST DRIVE</div>
                {sg.config.ldPrize && <div style={{ fontSize: 12, color: "#6b7280" }}>Holes: {sg.config.ldHoles.join(", ")} · {sg.config.ldPrize}</div>}
              </div>
            </div>
            {ldResults.length === 0 ? (
              <div style={{ fontSize: 14, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>No winner yet</div>
            ) : (
              ldResults.map((r) => (
                <div key={r.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>Hole {r.holeNumber}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{r.playerName}</div>
                  {r.notes && <div style={{ fontSize: 12, color: "#9ca3af" }}>{r.notes}</div>}
                </div>
              ))
            )}
          </div>
        )}

        {/* Greenies */}
        {sg.config.greeniesEnabled && (
          <div style={{ background: "rgba(0,0,0,0.4)", border: "1px solid #1a3028", borderRadius: 12, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div style={{ fontSize: 20 }}>🟢</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#86efac", letterSpacing: 1 }}>GREENIES</div>
                {sg.config.greeniesPrize && <div style={{ fontSize: 12, color: "#6b7280" }}>{sg.config.greeniesPrize}</div>}
              </div>
            </div>
            {greenieResults.length === 0 ? (
              <div style={{ fontSize: 14, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>No greenies yet</div>
            ) : (
              greenieResults.map((r) => (
                <div key={r.id} style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>{r.playerName}</div>
                  <div style={{ fontSize: 13, color: "#6b7280" }}>Hole {r.holeNumber}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SponsorSlideView({ sponsors, animating }: { sponsors: Sponsor[]; animating: boolean }) {
  const [idx, setIdx] = useState(0);
  const activeSponsors = sponsors.filter(s => s.logoUrl);

  useEffect(() => {
    if (activeSponsors.length <= 1) return;
    const t = setInterval(() => setIdx(i => (i + 1) % activeSponsors.length), 4000);
    return () => clearInterval(t);
  }, [activeSponsors.length]);

  if (activeSponsors.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", opacity: animating ? 0 : 1, transition: "opacity 0.4s ease" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🏆</div>
          <div style={{ fontSize: 24, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>Thank you to our sponsors</div>
        </div>
      </div>
    );
  }

  const sponsor = activeSponsors[idx];
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity: animating ? 0 : 1, transition: "opacity 0.4s ease", gap: 32 }}>
      <div style={{ fontSize: 13, color: "#4b7060", letterSpacing: 6, fontFamily: "Arial, sans-serif", textTransform: "uppercase" }}>Proudly Sponsored By</div>
      {sponsor.logoUrl && (
        <img src={sponsor.logoUrl} alt={sponsor.name} style={{ maxHeight: 200, maxWidth: 600, objectFit: "contain", filter: "drop-shadow(0 0 40px rgba(255,255,255,0.1))" }} />
      )}
      <div style={{ fontSize: 32, fontWeight: 700, color: "#fff", letterSpacing: 2 }}>{sponsor.name}</div>
      {sponsor.websiteUrl && (
        <div style={{ fontSize: 16, color: "#6b7280", fontFamily: "Arial, sans-serif" }}>{sponsor.websiteUrl}</div>
      )}
      {activeSponsors.length > 1 && (
        <div style={{ display: "flex", gap: 8 }}>
          {activeSponsors.map((_, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: 4, background: i === idx ? "#C9A84C" : "rgba(255,255,255,0.2)" }} />
          ))}
        </div>
      )}
    </div>
  );
}

function NoData({ message }: { message: string }) {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontSize: 20, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>{message}</div>
    </div>
  );
}

// ─── Pairing Screen ──────────────────────────────────────────────────────────

function PairingScreen({ onPaired }: { onPaired: (orgId: number, tournamentId: number | null) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(new Date());
  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  async function handlePair(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${baseUrl}/api/public/display/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Invalid code. Please try again.");
      } else {
        const d = await res.json();
        onPaired(d.organizationId, d.tournamentId);
      }
    } catch {
      setError("Connection error. Please check your network.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #071209 0%, #0a1a0e 40%, #060e08 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'Georgia', serif", color: "#e5e7eb" }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <div style={{ fontSize: 11, letterSpacing: 8, color: "#C9A84C", fontFamily: "Arial, sans-serif", fontWeight: 700, marginBottom: 12 }}>KHARAGOLF</div>
        <div style={{ fontSize: 36, fontWeight: 700, color: "#fff", marginBottom: 8 }}>TV Display Board</div>
        <div style={{ fontSize: 16, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>Enter your display code to pair this screen</div>
      </div>

      <form onSubmit={handlePair} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: 360 }}>
        <input
          type="text"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          placeholder="ENTER CODE"
          maxLength={6}
          style={{
            width: "100%",
            padding: "18px 24px",
            fontSize: 32,
            letterSpacing: 12,
            textAlign: "center",
            background: "rgba(255,255,255,0.05)",
            border: "2px solid #1a3028",
            borderRadius: 12,
            color: "#fff",
            fontFamily: "Arial, sans-serif",
            fontWeight: 700,
            outline: "none",
            boxSizing: "border-box",
          }}
          autoFocus
        />
        {error && (
          <div style={{ fontSize: 14, color: "#f87171", fontFamily: "Arial, sans-serif", textAlign: "center" }}>{error}</div>
        )}
        <button
          type="submit"
          disabled={loading || code.length < 4}
          style={{
            width: "100%",
            padding: "14px 24px",
            background: "#C9A84C",
            color: "#000",
            border: "none",
            borderRadius: 10,
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: 2,
            fontFamily: "Arial, sans-serif",
            cursor: loading || code.length < 4 ? "not-allowed" : "pointer",
            opacity: loading || code.length < 4 ? 0.5 : 1,
            textTransform: "uppercase",
          }}
        >
          {loading ? "Connecting..." : "Connect Screen"}
        </button>
      </form>

      <div style={{ marginTop: 48, fontSize: 13, color: "#374151", fontFamily: "Arial, sans-serif" }}>
        Generate a display code from the admin panel → Tournament → Display Settings
      </div>

      <div style={{ position: "absolute", bottom: 24, right: 32, fontSize: 24, color: "#22c55e", fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums" }}>
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildRotationSequence(settings: DisplayData["settings"], tournament: Tournament | undefined): ViewType[] {
  const views: ViewType[] = [];
  for (const v of settings.rotationSequence) {
    if (v === "leaderboard") views.push("leaderboard");
    else if (v === "tracker" && settings.showTracker) views.push("tracker");
    else if (v === "sidegames" && settings.showSideGames && tournament?.sideGames?.config) views.push("sidegames");
    else if (v === "sponsor" && settings.showSponsorSlides) views.push("sponsor");
  }
  if (views.length === 0) views.push("leaderboard");
  return views;
}

// ─── Main TV Display Board ────────────────────────────────────────────────────

export default function TvDisplay() {
  const [orgId, setOrgId] = useState<number | null>(null);
  const [tournamentId, setTournamentId] = useState<number | null>(null);
  const [data, setData] = useState<DisplayData | null>(null);
  const [currentView, setCurrentView] = useState<ViewType>("leaderboard");
  const [currentTournamentIdx, setCurrentTournamentIdx] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [now, setNow] = useState(new Date());
  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  const rotationRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const fetchRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check for persisted pairing in sessionStorage
  useEffect(() => {
    const stored = sessionStorage.getItem("display_pairing");
    if (stored) {
      try {
        const { orgId: oid, tournamentId: tid } = JSON.parse(stored);
        setOrgId(oid);
        setTournamentId(tid);
      } catch {}
    }
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(clock);
  }, []);

  const fetchData = useCallback(async () => {
    if (!orgId) return;
    const qs = tournamentId ? `?tournamentId=${tournamentId}` : "";
    try {
      const res = await fetch(`${baseUrl}/api/public/display/data/${orgId}${qs}`);
      if (res.ok) setData(await res.json());
    } catch {}
  }, [orgId, tournamentId, baseUrl]);

  // Fetch data + start SSE when paired
  useEffect(() => {
    if (!orgId) return;
    fetchData();
    // Poll every 30s as a fallback
    fetchRef.current = setInterval(fetchData, 30000);
    // SSE for live updates — listen on the first tournament
    return () => {
      if (fetchRef.current) clearInterval(fetchRef.current);
      if (sseRef.current) sseRef.current.close();
    };
  }, [orgId, fetchData]);

  // Connect SSE for leaderboard updates when we have tournament data
  useEffect(() => {
    if (!data || data.tournaments.length === 0) return;
    if (sseRef.current) sseRef.current.close();
    const tid = data.tournaments[currentTournamentIdx]?.id;
    if (!tid) return;
    const sse = new EventSource(`${baseUrl}/api/public/tournaments/${tid}/leaderboard/stream`);
    sseRef.current = sse;
    sse.onmessage = () => { fetchData(); };
    return () => { sse.close(); };
  }, [data?.tournaments?.length, currentTournamentIdx, baseUrl]);

  // Auto-rotation engine
  useEffect(() => {
    if (!data || !orgId) return;
    if (rotationRef.current) clearInterval(rotationRef.current);

    const settings = data.settings;
    const tournaments = data.tournaments;
    const sequence = buildRotationSequence(settings, tournaments[currentTournamentIdx]);
    let viewIdx = sequence.indexOf(currentView);
    if (viewIdx === -1) viewIdx = 0;

    const interval = settings.rotationIntervalSeconds * 1000;

    rotationRef.current = setInterval(() => {
      setAnimating(true);
      setTimeout(() => {
        viewIdx = (viewIdx + 1) % sequence.length;
        let nextView = sequence[viewIdx] as ViewType;

        // Advance tournament if wrapping full sequence
        if (viewIdx === 0 && tournaments.length > 1) {
          setCurrentTournamentIdx(prev => {
            const next = (prev + 1) % tournaments.length;
            return next;
          });
        }

        setCurrentView(nextView);
        setAnimating(false);
      }, 400);
    }, interval);

    return () => { if (rotationRef.current) clearInterval(rotationRef.current); };
  }, [data?.settings, data?.tournaments?.length, orgId]);

  function handlePaired(oid: number, tid: number | null) {
    sessionStorage.setItem("display_pairing", JSON.stringify({ orgId: oid, tournamentId: tid }));
    setOrgId(oid);
    setTournamentId(tid);
  }

  function handleUnpair() {
    sessionStorage.removeItem("display_pairing");
    setOrgId(null);
    setTournamentId(null);
    setData(null);
  }

  if (!orgId) {
    return <PairingScreen onPaired={handlePaired} />;
  }

  if (!data) {
    return (
      <div style={{ minHeight: "100vh", background: "#0a0f0c", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#22c55e", fontSize: 24, fontFamily: "Georgia, serif", letterSpacing: 8 }}>GOLF LIVE</div>
      </div>
    );
  }

  const { org, settings, tournaments } = data;
  const orgPrimary = org.primaryColor ?? "#22c55e";

  if (tournaments.length === 0) {
    return (
      <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #071209 0%, #0a1a0e 40%, #060e08 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'Georgia', serif", color: "#e5e7eb" }}>
        <div style={{ fontSize: 11, letterSpacing: 8, color: orgPrimary, fontFamily: "Arial, sans-serif", fontWeight: 700, marginBottom: 12 }}>
          {org.name.toUpperCase()}
        </div>
        <div style={{ fontSize: 28, color: "#4b7060" }}>No active tournaments</div>
        <button onClick={handleUnpair} style={{ marginTop: 32, padding: "8px 20px", background: "transparent", border: "1px solid #1a3028", color: "#4b7060", borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "Arial, sans-serif" }}>
          Change Screen
        </button>
      </div>
    );
  }

  const tournament = tournaments[Math.min(currentTournamentIdx, tournaments.length - 1)];
  const lb = tournament.leaderboard;
  const inProgress = lb?.entries.filter(e => e.holesCompleted > 0 && e.holesCompleted < 18).length ?? 0;
  const allSponsors = tournament.sponsors;

  const viewLabels: Record<ViewType, string> = {
    leaderboard: "Leaderboard",
    tracker: "Score Tracker",
    sidegames: "Side Games",
    sponsor: "Our Sponsors",
    pairing: "Pairing",
  };

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #071209 0%, #0a1a0e 40%, #060e08 100%)", fontFamily: "'Georgia', serif", color: "#e5e7eb", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Top Banner */}
      <div style={{ background: "rgba(0,0,0,0.6)", borderBottom: "2px solid #1a3a1e", padding: "16px 48px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {org.logoUrl && (
            <img src={org.logoUrl} alt={org.name} style={{ height: 50, width: "auto", objectFit: "contain", borderRadius: 6, background: "rgba(255,255,255,0.06)", padding: 4 }} />
          )}
          <div>
            <div style={{ fontSize: 11, letterSpacing: 6, fontFamily: "Arial, sans-serif", fontWeight: 700, marginBottom: 2, color: orgPrimary }}>
              {org.name.toUpperCase()}
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#fff", letterSpacing: 0.5 }}>
              {tournament.name}
            </div>
            {tournaments.length > 1 && (
              <div style={{ fontSize: 11, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>
                {currentTournamentIdx + 1} of {tournaments.length} events
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {/* View indicators */}
          <div style={{ display: "flex", gap: 6 }}>
            {buildRotationSequence(settings, tournament).map((v, i) => (
              <button
                key={v + i}
                onClick={() => { setCurrentView(v); }}
                style={{
                  padding: "4px 12px",
                  borderRadius: 20,
                  border: "1px solid",
                  borderColor: currentView === v ? orgPrimary : "#243b2e",
                  background: currentView === v ? `${orgPrimary}22` : "transparent",
                  color: currentView === v ? orgPrimary : "#4b7060",
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "Arial, sans-serif",
                  fontWeight: 700,
                  letterSpacing: 1,
                  textTransform: "uppercase" as const,
                }}
              >
                {viewLabels[v]}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <div style={{ fontSize: 30, color: orgPrimary, fontWeight: 700, fontFamily: "Arial, sans-serif", fontVariantNumeric: "tabular-nums" }}>
              {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "Arial, sans-serif" }}>
              {now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
            </div>
            {inProgress > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: 4, background: "#22c55e", boxShadow: "0 0 8px #22c55e" }} />
                <span style={{ fontSize: 11, color: "#22c55e", fontFamily: "Arial, sans-serif", letterSpacing: 1 }}>{inProgress} ON COURSE</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Section Label */}
      <div style={{ background: "#1a3a1e", borderBottom: "1px solid #243b2e", padding: "8px 48px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ fontSize: 13, color: orgPrimary, letterSpacing: 4, fontFamily: "Arial, sans-serif", fontWeight: 700 }}>
          {viewLabels[currentView]?.toUpperCase()}
        </div>
        {currentView === "leaderboard" && lb && (
          <div style={{ fontSize: 12, color: "#4b7060", fontFamily: "Arial, sans-serif" }}>Par {tournament.coursePar}</div>
        )}
        {lb?.lastUpdated && (
          <div style={{ fontSize: 11, color: "#374151", fontFamily: "Arial, sans-serif" }}>
            Updated {new Date(lb.lastUpdated).toLocaleTimeString()}
          </div>
        )}
      </div>

      {/* Main Content Area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
        {currentView === "leaderboard" && <LeaderboardView tournament={tournament} animating={animating} />}
        {currentView === "tracker" && <TrackerView tournament={tournament} animating={animating} />}
        {currentView === "sidegames" && <SideGamesView tournament={tournament} animating={animating} />}
        {currentView === "sponsor" && <SponsorSlideView sponsors={allSponsors} animating={animating} />}
      </div>

      {/* Bottom Bar */}
      <div style={{ background: "rgba(0,0,0,0.5)", borderTop: "1px solid #1a3028", padding: "10px 48px", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 20 }}>
            {[["#C9A84C", "Eagle+"], ["#ef4444", "Birdie"], ["rgba(255,255,255,0.08)", "Par"], ["#3b82f6", "Bogey"], ["#8b5cf6", "Double+"]].map(([color, label]) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "Arial, sans-serif" }}>{label}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            {allSponsors.filter(s => s.logoUrl).slice(0, 4).map(s => (
              <img key={s.id} src={s.logoUrl!} alt={s.name} style={{ height: 22, width: "auto", objectFit: "contain", opacity: 0.65 }} />
            ))}
            {orgId && (
              <div style={{ height: 28, minWidth: 120 }}>
                <AdSlot orgId={orgId} slotKey="tv_ticker" tournamentId={tournament.id} style={{ height: 28 }} />
              </div>
            )}
            <button onClick={handleUnpair} style={{ padding: "3px 10px", background: "transparent", border: "1px solid #1a3028", color: "#374151", borderRadius: 6, cursor: "pointer", fontSize: 10, fontFamily: "Arial, sans-serif", letterSpacing: 1 }}>
              UNPAIR
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
