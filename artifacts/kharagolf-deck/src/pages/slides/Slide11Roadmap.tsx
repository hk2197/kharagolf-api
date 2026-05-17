export default function Slide11Roadmap() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "#0b1f12" }}>
      <div className="absolute inset-0" style={{ background: "linear-gradient(160deg, #0f2a18 0%, #0b1f12 100%)" }} />
      <div className="absolute" style={{ top: "6vh", left: "7vw", width: "6vw", height: "0.35vh", background: "#C9A84C" }} />
      <div className="absolute" style={{ top: "10.5vh", left: "7vw" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.2em", fontWeight: 500, textTransform: "uppercase" }}>What's Next</div>
        <h2 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "4vw", fontWeight: 700, color: "#e8f5ee", lineHeight: 1.1, marginTop: "1.5vh" }}>Active pipeline — pending &amp; proposed</h2>
      </div>
      <div className="absolute" style={{ top: "34vh", left: "7vw", right: "7vw", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2.5vh 4vw" }}>
        <div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh", textTransform: "uppercase", letterSpacing: "0.1em" }}>Admin</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "1.5vh" }}>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", display: "flex", gap: "1.5vw", alignItems: "flex-start" }}>
              <span style={{ color: "#C9A84C", flexShrink: 0 }}>→</span>
              <span>Ops alert tunable schema on live DB</span>
            </div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", display: "flex", gap: "1.5vw", alignItems: "flex-start" }}>
              <span style={{ color: "#C9A84C", flexShrink: 0 }}>→</span>
              <span>Coach payout push delivery audit trail</span>
            </div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", display: "flex", gap: "1.5vw", alignItems: "flex-start" }}>
              <span style={{ color: "#C9A84C", flexShrink: 0 }}>→</span>
              <span>Video probe failure Slack/PagerDuty alerts</span>
            </div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", display: "flex", gap: "1.5vw", alignItems: "flex-start" }}>
              <span style={{ color: "#C9A84C", flexShrink: 0 }}>→</span>
              <span>Shared status pill for coach &amp; admin panels</span>
            </div>
          </div>
        </div>
        <div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh", textTransform: "uppercase", letterSpacing: "0.1em" }}>Player</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "1.5vh" }}>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", display: "flex", gap: "1.5vw", alignItems: "flex-start" }}>
              <span style={{ color: "#C9A84C", flexShrink: 0 }}>→</span>
              <span>Mute countdown display &amp; confirm-lift prompt</span>
            </div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", display: "flex", gap: "1.5vw", alignItems: "flex-start" }}>
              <span style={{ color: "#C9A84C", flexShrink: 0 }}>→</span>
              <span>Feed-post notification scroll-to-post</span>
            </div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", display: "flex", gap: "1.5vw", alignItems: "flex-start" }}>
              <span style={{ color: "#C9A84C", flexShrink: 0 }}>→</span>
              <span>Tournament-change preview before bulk-apply</span>
            </div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", display: "flex", gap: "1.5vw", alignItems: "flex-start" }}>
              <span style={{ color: "#C9A84C", flexShrink: 0 }}>→</span>
              <span>Committee case translations (all enums)</span>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute" style={{ bottom: "6vh", left: "7vw", right: "7vw", display: "flex", gap: "1.5vw", alignItems: "center" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Infrastructure:</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>18 CI workflows to always-on</div>
        <div style={{ color: "#2d6e42", fontSize: "1.6vw" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>Money-route test coverage</div>
        <div style={{ color: "#2d6e42", fontSize: "1.6vw" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>Mobile auth e2e suite</div>
      </div>
    </div>
  );
}
