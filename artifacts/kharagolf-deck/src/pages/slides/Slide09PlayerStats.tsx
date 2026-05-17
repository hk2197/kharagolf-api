export default function Slide09PlayerStats() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "#0b1f12" }}>
      <div className="absolute inset-0" style={{ background: "linear-gradient(160deg, #0f2a18 0%, #0b1f12 100%)" }} />
      <div className="absolute" style={{ top: "6vh", left: "7vw", width: "6vw", height: "0.35vh", background: "#C9A84C" }} />
      <div className="absolute" style={{ top: "10.5vh", left: "7vw", right: "55vw" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.2em", fontWeight: 500, textTransform: "uppercase" }}>Statistics &amp; Handicap</div>
        <h2 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "4vw", fontWeight: 700, color: "#e8f5ee", lineHeight: 1.1, marginTop: "1.5vh" }}>Know your game, improve your game</h2>
        <div style={{ marginTop: "3.5vh", display: "flex", flexDirection: "column", gap: "2vh" }}>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Strokes gained analysis</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Baseline pinning, weather overlays, low-sample weather bars</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>WHS handicap management</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Annual review, simulator, committee oversight, peer review</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Club distance profiling</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Per-club averages, fitting session tracking, health connect sync</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Achievement badges</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Shareable OG cards, badge share rollups, progress milestones</div>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute" style={{ top: "8vh", right: "5vw", width: "42vw", bottom: "8vh", display: "flex", flexDirection: "column", gap: "2.5vh" }}>
        <div style={{ background: "rgba(45,110,66,0.15)", border: "1px solid rgba(201,168,76,0.2)", borderRadius: "0.8vw", padding: "2.5vh 2.5vw", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "1.8vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>Wearables &amp; Health</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96", lineHeight: 1.5 }}>Apple Watch, Wear OS, Garmin ConnectIQ, iOS watch extension — all synchronized. Health Connect background sync for step and heart rate data.</div>
        </div>
        <div style={{ background: "rgba(45,110,66,0.15)", border: "1px solid rgba(201,168,76,0.2)", borderRadius: "0.8vw", padding: "2.5vh 2.5vw", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "1.8vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>Wellness Dashboard</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96", lineHeight: 1.5 }}>WoW drift acknowledgment, wellness re-auth, coach payout focus — full health &amp; fitness integration.</div>
        </div>
      </div>
    </div>
  );
}
