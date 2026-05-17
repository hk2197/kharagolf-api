export default function Slide06AdminAnalytics() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "#0b1f12" }}>
      <div className="absolute inset-0" style={{ background: "linear-gradient(160deg, #0f2a18 0%, #0b1f12 100%)" }} />
      <div className="absolute" style={{ top: "6vh", left: "7vw", width: "6vw", height: "0.35vh", background: "#C9A84C" }} />
      <div className="absolute" style={{ top: "10.5vh", left: "7vw", right: "7vw", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ maxWidth: "50vw" }}>
          <div style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.2em", fontWeight: 500, textTransform: "uppercase" }}>Analytics &amp; Intelligence</div>
          <h2 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "4vw", fontWeight: 700, color: "#e8f5ee", lineHeight: 1.1, marginTop: "1.5vh" }}>Data-driven club management</h2>
        </div>
      </div>
      <div className="absolute" style={{ top: "34vh", left: "7vw", right: "7vw" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2.5vh 4vw" }}>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Admin analytics dashboard</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Custom categories, event metadata, conversion tracking</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Sponsor analytics</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Trend overlays, per-slot CTR, day-slot comparisons</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Handicap committee tools</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Case management, peer review, Arabic RTL-ready</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Media &amp; swing review</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Video highlight gallery, coach marketplace, drawing timeline strip</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Governance &amp; audit trails</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Privacy requests, account erasure, comm-pref history, outbound webhooks</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.9vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>AI caddie &amp; rules assistant</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>On-course intelligence, voice caddie, rules lookups</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
