import { useEffect, useState } from "react";
import { useParams } from "wouter";

interface TeeTimePlayer {
  playerId: number;
  firstName: string;
  lastName: string;
  flight: string | null;
  handicapIndex: number | null;
}

interface TeeTimeGroup {
  id: number;
  teeTime: string;
  startingHole: number;
  round: number;
  players: TeeTimePlayer[];
}

interface FlightInfo {
  id: number;
  name: string;
}

interface ScorecardData {
  tournamentName: string;
  format: string;
  courseName: string | null;
  coursePar: number;
  holeCount: number;
  organizationName: string | null;
  organizationLogoUrl: string | null;
  organizationPrimaryColor: string | null;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function PocketScorecards() {
  const params = useParams<{ orgId: string; tournamentId: string }>();
  const { orgId, tournamentId } = params;

  const [teeTimes, setTeeTimes] = useState<TeeTimeGroup[]>([]);
  const [scorecard, setScorecard] = useState<ScorecardData | null>(null);
  const [flights, setFlights] = useState<FlightInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const defaultRound = parseInt(new URLSearchParams(window.location.search).get('round') ?? '1') || 1;
  const [roundFilter, setRoundFilter] = useState<number>(defaultRound);
  const [flightFilter, setFlightFilter] = useState<string>("all");
  const [downloading, setDownloading] = useState(false);

  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  useEffect(() => {
    async function load() {
      try {
        const [ttRes, scRes, detRes] = await Promise.all([
          fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times`, { credentials: "include" }),
          fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/scorecards`, { credentials: "include" }),
          fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}`, { credentials: "include" }),
        ]);
        if (!ttRes.ok) throw new Error("Failed to load tee times");
        if (!scRes.ok) throw new Error("Failed to load scorecard data");
        const ttData: TeeTimeGroup[] = await ttRes.json();
        const scData: ScorecardData = await scRes.json();
        setTeeTimes(ttData);
        setScorecard(scData);
        if (detRes.ok) {
          const detData = await detRes.json();
          if (detData.flights) setFlights(detData.flights);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [orgId, tournamentId]);

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      const params = new URLSearchParams({ round: String(roundFilter) });
      if (flightFilter !== "all") params.set("flight", flightFilter);
      const res = await fetch(
        `${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/pocket-scorecards/pdf?${params}`,
        { credentials: "include" }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Download failed" }));
        alert(err.error || "Failed to generate PDF");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `PocketScorecards_R${roundFilter}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      alert("Failed to download PDF");
    } finally {
      setDownloading(false);
    }
  };

  if (loading) return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif" }}>
      <p style={{ color: "#9ca3af" }}>Loading pocket scorecards...</p>
    </div>
  );
  if (error || !scorecard) return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif" }}>
      <p style={{ color: "#ef4444" }}>{error ?? "Failed to load"}</p>
    </div>
  );

  const rounds = Array.from(new Set(teeTimes.map(tt => tt.round))).sort();
  const filteredGroups = teeTimes.filter(tt => {
    if (tt.round !== roundFilter) return false;
    if (flightFilter !== "all") {
      return tt.players.some(p => p.flight === flightFilter);
    }
    return true;
  });
  const orgPrimary = scorecard.organizationPrimaryColor ?? "#22c55e";
  const totalPlayers = filteredGroups.reduce((s, g) => {
    if (flightFilter !== "all") return s + g.players.filter(p => p.flight === flightFilter).length;
    return s + g.players.length;
  }, 0);

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#ffffff", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px" }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 20 }}>🃏</span>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Pocket Scorecards</h1>
          </div>
          <p style={{ color: "#9ca3af", fontSize: 14, margin: 0 }}>
            {scorecard.organizationName ?? "KHARAGOLF"} &mdash; {scorecard.tournamentName}
          </p>
          {scorecard.courseName && (
            <p style={{ color: "#6b7280", fontSize: 13, margin: "4px 0 0" }}>{scorecard.courseName}</p>
          )}
        </div>

        <div style={{
          background: "#111111", border: "1px solid #222", borderRadius: 12, padding: 20, marginBottom: 24,
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 13, color: "#9ca3af", fontWeight: 500 }}>Round:</label>
            <select
              value={roundFilter}
              onChange={e => setRoundFilter(parseInt(e.target.value))}
              style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #333", background: "#1a1a1a", color: "#fff", fontSize: 13, cursor: "pointer" }}
            >
              {(rounds.length > 0 ? rounds : [1]).map(r => (
                <option key={r} value={r}>Round {r}</option>
              ))}
            </select>
          </div>

          {flights.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 13, color: "#9ca3af", fontWeight: 500 }}>Flight:</label>
              <select
                value={flightFilter}
                onChange={e => setFlightFilter(e.target.value)}
                style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #333", background: "#1a1a1a", color: "#fff", fontSize: 13, cursor: "pointer" }}
              >
                <option value="all">All Flights</option>
                {flights.map(f => (
                  <option key={f.id} value={f.name}>{f.name}</option>
                ))}
              </select>
            </div>
          )}

          <div style={{ flex: 1 }} />

          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#6b7280" }}>
            <span>{totalPlayers} player{totalPlayers !== 1 ? "s" : ""} &middot; {filteredGroups.length} group{filteredGroups.length !== 1 ? "s" : ""}</span>
          </div>

          <button
            onClick={downloadPdf}
            disabled={downloading || filteredGroups.length === 0}
            style={{
              padding: "10px 24px",
              background: downloading ? "#333" : orgPrimary,
              color: downloading ? "#999" : "#000",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 700,
              cursor: downloading ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {downloading ? "Generating..." : "Download PDF"}
          </button>
        </div>

        <div style={{
          background: "#111111", border: "1px solid #222", borderRadius: 12, padding: 20, marginBottom: 24,
        }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px", color: "#d1d5db" }}>4-Panel Foldable Card Layout</h3>

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div>
              <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, fontWeight: 600 }}>SIDE A (print first)</p>
              <div style={{ display: "flex", border: "1px solid #333", borderRadius: 4, overflow: "hidden", width: 320, height: 200 }}>
                <div style={{ width: "50%", borderRight: "1px dashed #444", padding: 10, background: "#1a1a1a", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                  <div>
                    <p style={{ fontSize: 8, color: "#888", fontWeight: 700, margin: 0 }}>PANEL 4 &mdash; BACK COVER</p>
                    <p style={{ fontSize: 7, color: "#666", margin: "4px 0 0" }}>Local Rules</p>
                    <div style={{ margin: "4px 0", height: 1, background: "#333" }} />
                    <p style={{ fontSize: 7, color: "#666", margin: "2px 0 0" }}>Sponsors (Tiered)</p>
                    <div style={{ marginTop: 2 }}>
                      {["Title", "Gold", "Silver", "Bronze"].map(t => (
                        <div key={t} style={{ fontSize: 6, color: "#555", padding: "1px 0" }}>{t}</div>
                      ))}
                    </div>
                    <p style={{ fontSize: 7, color: "#666", margin: "4px 0 0" }}>Hole Sponsors</p>
                  </div>
                  <p style={{ fontSize: 6, color: "#444", margin: 0 }}>org website</p>
                </div>
                <div style={{ width: "50%", padding: 10, background: "#1a1a1a", display: "flex", flexDirection: "column" }}>
                  <div style={{ background: orgPrimary, borderRadius: 2, padding: "3px 6px", marginBottom: 6 }}>
                    <p style={{ fontSize: 7, color: "#000", fontWeight: 700, margin: 0, textAlign: "center" }}>CLUB NAME</p>
                  </div>
                  <p style={{ fontSize: 8, color: "#888", fontWeight: 700, margin: 0 }}>PANEL 1 &mdash; FRONT COVER</p>
                  <p style={{ fontSize: 7, color: "#666", margin: "4px 0 0" }}>Tournament Name</p>
                  <p style={{ fontSize: 7, color: "#666", margin: "2px 0 0" }}>Course | Date | Round</p>
                  <div style={{ margin: "4px 0", height: 1, background: "#333" }} />
                  <p style={{ fontSize: 8, color: "#aaa", fontWeight: 700, margin: "2px 0 0" }}>Player Name</p>
                  <p style={{ fontSize: 7, color: "#666", margin: "2px 0" }}>HCP &rarr; Playing HCP</p>
                  <p style={{ fontSize: 7, color: "#666", margin: 0 }}>Tee Time | Starting Hole</p>
                  <p style={{ fontSize: 7, color: "#666", margin: "4px 0 0" }}>Playing Partners</p>
                </div>
              </div>
            </div>

            <div>
              <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, fontWeight: 600 }}>SIDE B (flip short edge)</p>
              <div style={{ display: "flex", border: "1px solid #333", borderRadius: 4, overflow: "hidden", width: 320, height: 200 }}>
                <div style={{ width: "50%", borderRight: "1px dashed #444", padding: 10, background: "#1a1a1a" }}>
                  <p style={{ fontSize: 8, color: "#888", fontWeight: 700, margin: 0 }}>PANEL 2 &mdash; FRONT 9</p>
                  <div style={{ marginTop: 6 }}>
                    <div style={{ display: "flex", gap: 2 }}>
                      {["H", "Yd", "P", "SI", "G", "N", "Pt"].map(h => (
                        <div key={h} style={{ width: 18, fontSize: 5, color: "#888", textAlign: "center", fontWeight: 700, background: "#222", padding: "2px 0", borderRadius: 1 }}>{h}</div>
                      ))}
                    </div>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
                      <div key={n} style={{ display: "flex", gap: 2, marginTop: 1 }}>
                        <div style={{ width: 18, fontSize: 5, color: "#aaa", textAlign: "center", padding: "1px 0" }}>{n}</div>
                        {[0, 0, 0, 0, 0, 0].map((_, i) => (
                          <div key={i} style={{ width: 18, fontSize: 5, color: "#444", textAlign: "center", padding: "1px 0", borderBottom: "1px dotted #333" }}>&nbsp;</div>
                        ))}
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 2, marginTop: 2 }}>
                      <div style={{ width: 18, fontSize: 5, color: "#aaa", textAlign: "center", fontWeight: 700 }}>OUT</div>
                    </div>
                  </div>
                </div>
                <div style={{ width: "50%", padding: 10, background: "#1a1a1a" }}>
                  <p style={{ fontSize: 8, color: "#888", fontWeight: 700, margin: 0 }}>PANEL 3 &mdash; BACK 9</p>
                  <div style={{ marginTop: 6 }}>
                    <div style={{ display: "flex", gap: 2 }}>
                      {["H", "Yd", "P", "SI", "G", "N", "Pt"].map(h => (
                        <div key={h} style={{ width: 18, fontSize: 5, color: "#888", textAlign: "center", fontWeight: 700, background: "#222", padding: "2px 0", borderRadius: 1 }}>{h}</div>
                      ))}
                    </div>
                    {[10, 11, 12, 13, 14, 15, 16, 17, 18].map(n => (
                      <div key={n} style={{ display: "flex", gap: 2, marginTop: 1 }}>
                        <div style={{ width: 18, fontSize: 5, color: "#aaa", textAlign: "center", padding: "1px 0" }}>{n}</div>
                        {[0, 0, 0, 0, 0, 0].map((_, i) => (
                          <div key={i} style={{ width: 18, fontSize: 5, color: "#444", textAlign: "center", padding: "1px 0", borderBottom: "1px dotted #333" }}>&nbsp;</div>
                        ))}
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 2, marginTop: 2 }}>
                      <div style={{ width: 18, fontSize: 5, color: "#aaa", textAlign: "center", fontWeight: 700 }}>IN</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <p style={{ fontSize: 6, color: "#555", margin: 0 }}>Signature lines</p>
                    <p style={{ fontSize: 5, color: "#444", margin: "2px 0 0" }}>Score legend</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style={{
          background: "#111111", border: "1px solid #222", borderRadius: 12, padding: 20, marginBottom: 24,
        }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px", color: "#d1d5db" }}>Print Instructions</h3>
          <ol style={{ margin: 0, paddingLeft: 20, color: "#9ca3af", fontSize: 13, lineHeight: 2 }}>
            <li>Click <strong style={{ color: "#fff" }}>Download PDF</strong> above to generate the scorecards.</li>
            <li>Open the PDF and select <strong style={{ color: "#fff" }}>Print double-sided</strong>, flip on <strong style={{ color: "#fff" }}>short edge</strong>.</li>
            <li>Each player gets 2 pages (Side A + Side B). When folded in half, it becomes an A6 pocket card.</li>
            <li>Cut along the fold line if printing 2-up on A4.</li>
          </ol>
        </div>

        {filteredGroups.length === 0 ? (
          <div style={{
            background: "#111111", border: "1px solid #222", borderRadius: 12, padding: 40, textAlign: "center",
          }}>
            <p style={{ color: "#6b7280", fontSize: 14, margin: 0 }}>
              No tee times found for Round {roundFilter}
              {flightFilter !== "all" ? ` (${flightFilter})` : ""}.
              Please generate the draw first.
            </p>
          </div>
        ) : (
          <div style={{
            background: "#111111", border: "1px solid #222", borderRadius: 12, padding: 20,
          }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 16px", color: "#d1d5db" }}>
              Player Cards Preview ({totalPlayers} cards)
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
              {filteredGroups.map(group => {
                const players = flightFilter !== "all"
                  ? group.players.filter(p => p.flight === flightFilter)
                  : group.players;
                return players.map(p => (
                  <div key={p.playerId} style={{
                    background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 8, padding: 12,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <div>
                        <p style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "#fff" }}>
                          {p.firstName} {p.lastName}
                        </p>
                        {p.flight && (
                          <span style={{ fontSize: 10, color: orgPrimary, fontWeight: 600 }}>{p.flight}</span>
                        )}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <p style={{ fontSize: 13, fontWeight: 700, color: orgPrimary, margin: 0 }}>
                          {formatTime(group.teeTime)}
                        </p>
                        <p style={{ fontSize: 10, color: "#6b7280", margin: 0 }}>
                          Hole {group.startingHole}
                        </p>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>
                      {p.handicapIndex != null && <span>HI: {p.handicapIndex}</span>}
                    </div>
                    {group.players.length > 1 && (
                      <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #2a2a2a" }}>
                        <p style={{ fontSize: 10, color: "#555", fontWeight: 600, margin: "0 0 2px" }}>Playing with:</p>
                        {group.players.filter(x => x.playerId !== p.playerId).map(x => (
                          <p key={x.playerId} style={{ fontSize: 10, color: "#777", margin: "1px 0" }}>
                            {x.firstName} {x.lastName}
                            {x.handicapIndex != null ? ` (${x.handicapIndex})` : ""}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ));
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
