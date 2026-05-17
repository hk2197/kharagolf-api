const SESSION_KEY = "kg_session_id";

function getSessionId(): string {
  let sid = localStorage.getItem(SESSION_KEY);
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(SESSION_KEY, sid);
  }
  return sid;
}

const impressionSent = new Set<string>();

const BASE_URL = (typeof import.meta !== "undefined" ? (import.meta.env?.BASE_URL ?? "/") : "/").replace(/\/$/, "");

function fire(sponsorId: number, eventType: "impression" | "click", source: string, tournamentId?: number) {
  const sessionId = getSessionId();
  fetch(`${BASE_URL}/api/public/sponsor-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sponsorId, eventType, source, sessionId, ...(tournamentId ? { tournamentId } : {}) }),
    keepalive: true,
  }).catch(() => {});
}

export function trackImpression(sponsorId: number, source: string, tournamentId?: number) {
  const key = `${sponsorId}:${source}:${tournamentId ?? ""}`;
  if (impressionSent.has(key)) return;
  impressionSent.add(key);
  fire(sponsorId, "impression", source, tournamentId);
}

export function trackClick(sponsorId: number, source: string, tournamentId?: number) {
  fire(sponsorId, "click", source, tournamentId);
}
