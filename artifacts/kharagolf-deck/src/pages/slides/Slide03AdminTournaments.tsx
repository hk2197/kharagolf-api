export default function Slide03AdminTournaments() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "#0b1f12" }}>
      <div className="absolute" style={{ top: 0, left: 0, right: 0, height: "100%", background: "linear-gradient(160deg, #0f2a18 0%, #0b1f12 100%)" }} />
      <div className="absolute" style={{ top: "6vh", left: "7vw", width: "6vw", height: "0.35vh", background: "#C9A84C" }} />
      <div className="absolute" style={{ top: "6vh", left: "7vw", right: "7vw" }}>
        <div style={{ paddingTop: "4.5vh" }}>
          <div style={{ fontFamily: "DM Sans, system-ui, sans-serif", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.2em", fontWeight: 500, textTransform: "uppercase" }}>Tournament Management</div>
          <h2 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "4.5vw", fontWeight: 700, color: "#e8f5ee", lineHeight: 1.1, marginTop: "1.5vh", letterSpacing: "-0.01em" }}>Run Every Format,<br />From One Dashboard</h2>
        </div>
      </div>
      <div className="absolute" style={{ top: "32vh", left: "7vw", right: "7vw", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "2.5vw" }}>
        <div style={{ background: "rgba(45,110,66,0.18)", border: "1px solid rgba(201,168,76,0.2)", borderRadius: "0.8vw", padding: "3vh 2.5vw" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "2.2vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>14+ Formats</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#8aac96", lineHeight: 1.5 }}>Stroke play, Stableford, Match play, Round robin, Shotgun, Fantasy, and more</div>
        </div>
        <div style={{ background: "rgba(45,110,66,0.18)", border: "1px solid rgba(201,168,76,0.2)", borderRadius: "0.8vw", padding: "3vh 2.5vw" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "2.2vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>Draw Tools</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#8aac96", lineHeight: 1.5 }}>Flights, pairings, brackets, tee sheets, and bulk flight assignment in one step</div>
        </div>
        <div style={{ background: "rgba(45,110,66,0.18)", border: "1px solid rgba(201,168,76,0.2)", borderRadius: "0.8vw", padding: "3vh 2.5vw" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "2.2vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>Scorecards</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#8aac96", lineHeight: 1.5 }}>Pocket foldable PDFs, live leaderboard display boards, and player portal scoring</div>
        </div>
      </div>
      <div className="absolute" style={{ bottom: "6vh", left: "7vw", right: "7vw", display: "flex", gap: "3vw", alignItems: "center" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#8aac96" }}>Coming soon:</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#C9A84C" }}>Multi-course championships</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#2d6e42" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#C9A84C" }}>Club championship interclub</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#2d6e42" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#C9A84C" }}>Cross-club ladders</div>
      </div>
    </div>
  );
}
