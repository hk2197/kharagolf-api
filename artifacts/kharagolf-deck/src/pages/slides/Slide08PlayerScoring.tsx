export default function Slide08PlayerScoring() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "#0b1f12" }}>
      <div className="absolute inset-0" style={{ background: "linear-gradient(160deg, #0f2a18 0%, #0b1f12 100%)" }} />
      <div className="absolute" style={{ top: "6vh", left: "7vw", width: "6vw", height: "0.35vh", background: "#C9A84C" }} />
      <div className="absolute" style={{ top: "10.5vh", left: "7vw" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.2em", fontWeight: 500, textTransform: "uppercase" }}>Live Scoring &amp; GPS</div>
        <h2 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "4vw", fontWeight: 700, color: "#e8f5ee", lineHeight: 1.1, marginTop: "1.5vh", maxWidth: "55vw" }}>Every shot tracked, every round captured</h2>
      </div>
      <div className="absolute" style={{ top: "34vh", left: "7vw", right: "7vw", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2vh 5vw" }}>
        <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
          <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Mobile scorer kiosk</div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Shared iPad mode, marker confirmation, auto-shot payload</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
          <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>GPS distance &amp; mapping</div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Hole map with 3D green view, shot distance, course bundle</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
          <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Apple Watch &amp; Wear OS</div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Watch scoring, mute sessions, GPS chart drilldown, Garmin ConnectIQ</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
          <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Offline scoring</div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Full round capture without connectivity, syncs on reconnect</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
          <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>General play rounds</div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Non-tournament rounds, practice tracker, range session log</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
          <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Shareable round cards</div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Social share cards, year-in-golf summary, spectator follows</div>
          </div>
        </div>
      </div>
      <div className="absolute" style={{ bottom: "6vh", left: "7vw", right: "7vw", display: "flex", gap: "1.5vw", alignItems: "center" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Upcoming:</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>Interactive round replay map</div>
        <div style={{ color: "#2d6e42", fontSize: "1.6vw" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>Cross-replica mute fan-out</div>
        <div style={{ color: "#2d6e42", fontSize: "1.6vw" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>mute countdown display</div>
      </div>
    </div>
  );
}
