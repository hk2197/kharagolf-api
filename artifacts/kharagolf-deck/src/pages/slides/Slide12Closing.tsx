const base = import.meta.env.BASE_URL;

export default function Slide12Closing() {
  return (
    <div className="relative w-screen h-screen overflow-hidden">
      <img
        src={`${base}hero-golf.png`}
        crossOrigin="anonymous"
        className="absolute inset-0 w-full h-full object-cover"
        alt="Championship golf course"
      />
      <div className="absolute inset-0" style={{ background: "linear-gradient(to left, rgba(11,31,18,0.9) 55%, rgba(11,31,18,0.55) 100%)" }} />
      <div className="absolute inset-0 flex flex-col justify-center items-end" style={{ paddingRight: "7vw" }}>
        <div style={{ fontFamily: "DM Sans, system-ui, sans-serif", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.25em", fontWeight: 500, textAlign: "right", marginBottom: "3vh" }}>THE PLATFORM</div>
        <h1 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "7vw", fontWeight: 900, color: "#e8f5ee", lineHeight: 1.0, letterSpacing: "-0.02em", textAlign: "right" }}>
          KHARA<span style={{ color: "#C9A84C" }}>GOLF</span>
        </h1>
        <p style={{ fontFamily: "DM Sans, system-ui, sans-serif", fontSize: "2vw", color: "#8aac96", marginTop: "2.5vh", textAlign: "right", maxWidth: "42vw", lineHeight: 1.4 }}>
          Professional tournament software for clubs, players, and coaches — built for the international game
        </p>
        <div style={{ marginTop: "4vh", display: "flex", flexDirection: "column", gap: "1.5vh", alignItems: "flex-end" }}>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee" }}>Web · Mobile · Watch · API</div>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#8aac96" }}>21 languages · 14+ tournament formats · 5 platforms</div>
        </div>
      </div>
      <div className="absolute bottom-[4vh] left-[5vw]">
        <div style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#8aac96" }}>kharagolf.com</div>
      </div>
    </div>
  );
}
