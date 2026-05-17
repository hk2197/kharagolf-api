export default function Slide02AdminSection() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "linear-gradient(135deg, #0b1f12 0%, #132b1c 100%)" }}>
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 70% 50%, rgba(201,168,76,0.08) 0%, transparent 65%)" }} />
      <div className="absolute" style={{ top: "5vh", left: "7vw", right: "7vw", height: "0.3vh", background: "linear-gradient(to right, #C9A84C, transparent)" }} />
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div style={{ fontFamily: "DM Sans, system-ui, sans-serif", fontSize: "1.6vw", color: "#C9A84C", letterSpacing: "0.3em", fontWeight: 500, marginBottom: "3vh" }}>SECTION ONE</div>
        <h2 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "8vw", fontWeight: 900, color: "#e8f5ee", letterSpacing: "-0.02em", lineHeight: 1.0, textAlign: "center" }}>Club Admin</h2>
        <h2 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "8vw", fontWeight: 900, color: "#C9A84C", letterSpacing: "-0.02em", lineHeight: 1.0, textAlign: "center" }}>Features</h2>
        <p style={{ fontFamily: "DM Sans, system-ui, sans-serif", fontSize: "2vw", color: "#8aac96", marginTop: "4vh", textAlign: "center" }}>Tournaments · Members · Communications · Analytics</p>
      </div>
      <div className="absolute" style={{ bottom: "5vh", left: "7vw", right: "7vw", height: "0.15vh", background: "rgba(201,168,76,0.25)" }} />
    </div>
  );
}
