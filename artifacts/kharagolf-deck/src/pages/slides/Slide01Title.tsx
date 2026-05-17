const base = import.meta.env.BASE_URL;

export default function Slide01Title() {
  return (
    <div className="relative w-screen h-screen overflow-hidden">
      <img
        src={`${base}hero-golf.png`}
        crossOrigin="anonymous"
        className="absolute inset-0 w-full h-full object-cover"
        alt="Championship golf course at golden hour"
      />
      <div className="absolute inset-0" style={{ background: "linear-gradient(to right, rgba(11,31,18,0.92) 50%, rgba(11,31,18,0.55) 100%)" }} />
      <div className="absolute inset-0 flex flex-col justify-center" style={{ paddingLeft: "7vw" }}>
        <div className="flex items-center gap-[1.2vw] mb-[3vh]">
          <div style={{ width: "3.5vw", height: "0.2vh", background: "#C9A84C" }} />
          <span style={{ fontFamily: "DM Sans, system-ui, sans-serif", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.25em", fontWeight: 500 }}>PLATFORM OVERVIEW</span>
        </div>
        <h1 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "7vw", fontWeight: 900, color: "#e8f5ee", lineHeight: 1.0, letterSpacing: "-0.02em", textWrap: "balance", maxWidth: "55vw" }}>
          KHARA<span style={{ color: "#C9A84C" }}>GOLF</span>
        </h1>
        <p style={{ fontFamily: "DM Sans, system-ui, sans-serif", fontSize: "2.2vw", color: "#8aac96", marginTop: "2.5vh", maxWidth: "45vw", fontWeight: 400, lineHeight: 1.4 }}>
          The complete professional golf tournament platform
        </p>
        <div style={{ marginTop: "4vh", display: "flex", gap: "3vw" }}>
          <div>
            <div style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "3.5vw", fontWeight: 700, color: "#C9A84C" }}>Club Admins</div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Operations · Communications · Analytics</div>
          </div>
          <div style={{ width: "0.1vw", background: "#2d6e42", margin: "0.5vh 0" }} />
          <div>
            <div style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "3.5vw", fontWeight: 700, color: "#C9A84C" }}>Players</div>
            <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Scoring · Stats · Social · Watch</div>
          </div>
        </div>
      </div>
      <div className="absolute bottom-[4vh] right-[5vw]" style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#8aac96" }}>2026</div>
    </div>
  );
}
