export default function Slide04AdminMembers() {
  return (
    <div className="relative w-screen h-screen overflow-hidden" style={{ background: "#0b1f12" }}>
      <div className="absolute inset-0" style={{ background: "linear-gradient(160deg, #0f2a18 0%, #0b1f12 100%)" }} />
      <div className="absolute" style={{ top: "6vh", left: "7vw", width: "6vw", height: "0.35vh", background: "#C9A84C" }} />
      <div className="absolute" style={{ top: "10.5vh", left: "7vw", right: "50vw" }}>
        <div style={{ fontFamily: "DM Sans, system-ui, sans-serif", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.2em", fontWeight: 500, textTransform: "uppercase" }}>Members &amp; Club Operations</div>
        <h2 style={{ fontFamily: "Playfair Display, Georgia, serif", fontSize: "4vw", fontWeight: 700, color: "#e8f5ee", lineHeight: 1.1, marginTop: "1.5vh" }}>Everything an admin needs, on any device</h2>
        <div style={{ marginTop: "4vh", display: "flex", flexDirection: "column", gap: "2.5vh" }}>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.8vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Member management</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Roster, classifications, handicap profiles, onboarding, dues billing</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.8vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Tee time booking</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Full marketplace, dynamic pricing, cart &amp; caddie bookings, QR check-in</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.8vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Finance &amp; commerce</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Razorpay &amp; Stripe payments, GST invoices, commissions, F&amp;B POS, gift cards</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "2vw", alignItems: "flex-start" }}>
            <div style={{ width: "0.5vw", height: "0.5vw", borderRadius: "50%", background: "#C9A84C", marginTop: "0.8vh", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.8vw", color: "#e8f5ee", fontWeight: 700 }}>Club settings from mobile</div>
              <div style={{ fontFamily: "DM Sans", fontSize: "1.6vw", color: "#8aac96" }}>Notification defaults, audit panels, bounced digest prefs — all on your phone</div>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute" style={{ top: "6vh", right: "5vw", width: "38vw", bottom: "6vh", background: "rgba(45,110,66,0.12)", border: "1px solid rgba(201,168,76,0.15)", borderRadius: "1vw", display: "flex", flexDirection: "column", justifyContent: "center", padding: "3vh 3vw", gap: "2.5vh" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.5vw", color: "#C9A84C", letterSpacing: "0.15em", fontWeight: 500 }}>ON THE ROADMAP</div>
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", lineHeight: 1.4 }}>Accounting &amp; finance integration</div>
        <div style={{ height: "0.1vh", background: "rgba(201,168,76,0.2)" }} />
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", lineHeight: 1.4 }}>Multi-currency, GST &amp; tax automation</div>
        <div style={{ height: "0.1vh", background: "rgba(201,168,76,0.2)" }} />
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", lineHeight: 1.4 }}>Procurement &amp; vendor management</div>
        <div style={{ height: "0.1vh", background: "rgba(201,168,76,0.2)" }} />
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", lineHeight: 1.4 }}>Locker &amp; consignment tracking</div>
        <div style={{ height: "0.1vh", background: "rgba(201,168,76,0.2)" }} />
        <div style={{ fontFamily: "DM Sans", fontSize: "1.7vw", color: "#e8f5ee", lineHeight: 1.4 }}>Corporate &amp; charity golf events</div>
      </div>
    </div>
  );
}
