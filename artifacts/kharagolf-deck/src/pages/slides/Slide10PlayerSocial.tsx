export default function Slide10PlayerSocial() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "#0b1f12" }}>
      <div className="absolute inset-0" style={{ background: "linear-gradient(160deg, #0f2a18 0%, #0b1f12 100%)" }} />
      <div className="absolute" style={{ top: "6vh", left: "7vw", width: "6vw", height: "0.35vh", background: "#C9A84C" }} />
      <div className="absolute" style={{ top: "10.5vh", left: "7vw" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.2em", fontWeight: 500, textTransform: "uppercase" }}>Social &amp; Community</div>
        <h2 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "4vw", fontWeight: 700, color: "#e8f5ee", lineHeight: 1.1, marginTop: "1.5vh", maxWidth: "55vw" }}>Golf is better together</h2>
      </div>
      <div className="absolute" style={{ top: "34vh", left: "7vw", right: "7vw", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "2.5vw" }}>
        <div style={{ background: "rgba(45,110,66,0.15)", border: "1px solid rgba(201,168,76,0.2)", borderRadius: "0.8vw", padding: "2.5vh 2.5vw" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "2vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>Activity Feed</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96", lineHeight: 1.5 }}>Follow other players, feed-post push notifications, in-app inbox, peer invitations</div>
        </div>
        <div style={{ background: "rgba(45,110,66,0.15)", border: "1px solid rgba(201,168,76,0.2)", borderRadius: "0.8vw", padding: "2.5vh 2.5vw" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "2vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>Coaching</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96", lineHeight: 1.5 }}>Swing video reviews with drawing timeline, voice-over caddie, coach marketplace &amp; payouts</div>
        </div>
        <div style={{ background: "rgba(45,110,66,0.15)", border: "1px solid rgba(201,168,76,0.2)", borderRadius: "0.8vw", padding: "2.5vh 2.5vw" }}>
          <div style={{ fontFamily: "Playfair Display", fontSize: "2vw", color: "#C9A84C", fontWeight: 700, marginBottom: "1.5vh" }}>Caddie Marketplace</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96", lineHeight: 1.5 }}>Browse, book, and rate caddies. AI caddie on-course with GPS integration</div>
        </div>
      </div>
      <div className="absolute" style={{ bottom: "6vh", left: "7vw", right: "7vw", display: "flex", gap: "1.5vw", alignItems: "center" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Also:</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>Fantasy golf leagues</div>
        <div style={{ color: "#2d6e42", fontSize: "1.6vw" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>Live odds &amp; predictions</div>
        <div style={{ color: "#2d6e42", fontSize: "1.6vw" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>National ladders</div>
        <div style={{ color: "#2d6e42", fontSize: "1.6vw" }}>·</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#C9A84C" }}>Media galleries &amp; highlights</div>
      </div>
    </div>
  );
}
