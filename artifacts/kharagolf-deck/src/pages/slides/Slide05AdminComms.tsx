export default function Slide05AdminComms() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "#0b1f12" }}>
      <div className="absolute inset-0" style={{ background: "linear-gradient(160deg, #0f2a18 0%, #0b1f12 100%)" }} />
      <div className="absolute" style={{ top: "6vh", left: "7vw", width: "6vw", height: "0.35vh", background: "#C9A84C" }} />
      <div className="absolute" style={{ top: "10.5vh", left: "7vw" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.2em", fontWeight: 500, textTransform: "uppercase" }}>Communications &amp; Notifications</div>
        <h2 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "4vw", fontWeight: 700, color: "#e8f5ee", lineHeight: 1.1, marginTop: "1.5vh", maxWidth: "55vw" }}>Reach every member, in their language</h2>
      </div>
      <div className="absolute" style={{ top: "36vh", left: "7vw", right: "7vw", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "2vw" }}>
        <div style={{ background: "rgba(45,110,66,0.15)", border: "1px solid rgba(201,168,76,0.18)", borderRadius: "0.8vw", padding: "2.5vh 2vw" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "2vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>21 Languages</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96", lineHeight: 1.5 }}>Full i18n coverage including Arabic RTL, Swahili, Yoruba, and more</div>
        </div>
        <div style={{ background: "rgba(45,110,66,0.15)", border: "1px solid rgba(201,168,76,0.18)", borderRadius: "0.8vw", padding: "2.5vh 2vw" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "2vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>Push &amp; Email</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96", lineHeight: 1.5 }}>Localized transactional emails, push deep-links, in-app inbox, digest preferences</div>
        </div>
        <div style={{ background: "rgba(45,110,66,0.15)", border: "1px solid rgba(201,168,76,0.18)", borderRadius: "0.8vw", padding: "2.5vh 2vw" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "2vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>Ops Alerts</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96", lineHeight: 1.5 }}>Slack &amp; PagerDuty wiring, dry-run mode, tunable thresholds, audit trail</div>
        </div>
        <div style={{ background: "rgba(45,110,66,0.15)", border: "1px solid rgba(201,168,76,0.18)", borderRadius: "0.8vw", padding: "2.5vh 2vw" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "2vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>Automation</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96", lineHeight: 1.5 }}>Rule-based push classification, recap broadcasts, weekly digest, schedule-change alerts</div>
        </div>
      </div>
      <div className="absolute" style={{ bottom: "6vh", left: "7vw", right: "7vw", display: "flex", gap: "1.5vw", alignItems: "center" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Coming:</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>Web admin alert lint</div>
        <div style={{ color: "#2d6e42", fontSize: "1.6vw" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>Coach payout notifications</div>
        <div style={{ color: "#2d6e42", fontSize: "1.6vw" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>Admin re-subscribe push (21 languages)</div>
      </div>
    </div>
  );
}
