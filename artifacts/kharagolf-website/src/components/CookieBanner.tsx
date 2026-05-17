import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

// Task #381 — Privacy & consent center (GDPR / India DPDP).
// Cookie / analytics consent banner shown on first visit. Choices are stored
// in localStorage so subsequent loads can read consent before initialising
// optional analytics or marketing scripts.
//
// Storage key/shape:
//   kharagolf:cookie-consent:v1 → { necessary: true, analytics: bool,
//                                   marketing: bool, decidedAt: ISOString }
// Necessary cookies (session, CSRF) are always on; the other categories
// default to off and only switch on once the user explicitly opts in.
//
// Task #2202 — All visitor-facing copy is routed through the site i18n
// bundle so es/hi/ar visitors see the banner in their chosen language.

export type CookieConsent = {
  necessary: true;
  analytics: boolean;
  marketing: boolean;
  decidedAt: string;
};

const STORAGE_KEY = "kharagolf:cookie-consent:v1";

export function readCookieConsent(): CookieConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CookieConsent;
    if (parsed && typeof parsed === "object" && parsed.decidedAt) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeCookieConsent(c: Omit<CookieConsent, "decidedAt">): CookieConsent {
  const decided: CookieConsent = { ...c, necessary: true, decidedAt: new Date().toISOString() };
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(decided)); } catch { /* ignore */ }
  // Broadcast so any listening analytics initialiser can react in the same tab.
  try { window.dispatchEvent(new CustomEvent("kharagolf:cookie-consent", { detail: decided })); } catch { /* ignore */ }
  return decided;
}

export default function CookieBanner() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    const existing = readCookieConsent();
    if (!existing) setOpen(true);
  }, []);

  if (!open) return null;

  const acceptAll = () => { writeCookieConsent({ necessary: true, analytics: true, marketing: true }); setOpen(false); };
  const rejectOptional = () => { writeCookieConsent({ necessary: true, analytics: false, marketing: false }); setOpen(false); };
  const saveCustom = () => { writeCookieConsent({ necessary: true, analytics, marketing }); setOpen(false); };

  // Render the body string with the inline policy link substituted at the
  // `{{link}}` placeholder. Splitting this way keeps the link grammatically
  // positioned in each language rather than hard-pinning it to the end.
  const bodyTemplate = t("cookies.body");
  const [bodyBefore, bodyAfter] = bodyTemplate.split("{{link}}");

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label={t("cookies.aria")}
      data-testid="cookie-banner"
      style={{
        position: "fixed", left: 0, right: 0, bottom: 0,
        background: "rgba(8, 12, 22, 0.97)",
        color: "#e5e7eb",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        padding: "16px 20px",
        zIndex: 1000,
        boxShadow: "0 -8px 24px rgba(0,0,0,0.45)",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
        <div style={{ flex: "1 1 320px", minWidth: 260 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#fff" }}>{t("cookies.title")}</div>
          <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
            {bodyBefore}
            <a href="/privacy" style={{ color: "#34d399", textDecoration: "underline" }}>{t("cookies.policyLink")}</a>
            {bodyAfter ?? ""}
          </div>
          {showCustom && (
            <div style={{ marginTop: 10, display: "grid", gap: 6, fontSize: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.6 }}>
                <input type="checkbox" checked readOnly /> {t("cookies.necessary")}
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={analytics}
                  onChange={e => setAnalytics(e.target.checked)}
                  data-testid="cookie-analytics-toggle"
                /> {t("cookies.analytics")}
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={marketing}
                  onChange={e => setMarketing(e.target.checked)}
                  data-testid="cookie-marketing-toggle"
                /> {t("cookies.marketing")}
              </label>
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {!showCustom ? (
            <button
              type="button"
              onClick={() => setShowCustom(true)}
              data-testid="cookie-customize-btn"
              style={btnGhost}
            >{t("cookies.button.customise")}</button>
          ) : (
            <button
              type="button"
              onClick={saveCustom}
              data-testid="cookie-save-btn"
              style={btnGhost}
            >{t("cookies.button.save")}</button>
          )}
          <button
            type="button"
            onClick={rejectOptional}
            data-testid="cookie-reject-btn"
            style={btnGhost}
          >{t("cookies.button.reject")}</button>
          <button
            type="button"
            onClick={acceptAll}
            data-testid="cookie-accept-btn"
            style={btnPrimary}
          >{t("cookies.button.accept")}</button>
        </div>
      </div>
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  background: "#10b981", color: "#0b0f17", border: "none",
  padding: "8px 14px", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 13,
};
const btnGhost: React.CSSProperties = {
  background: "transparent", color: "#e5e7eb",
  border: "1px solid rgba(255,255,255,0.16)",
  padding: "8px 14px", borderRadius: 8, fontWeight: 600, cursor: "pointer", fontSize: 13,
};
