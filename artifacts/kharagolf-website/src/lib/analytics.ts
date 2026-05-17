/**
 * Funnel analytics tracker (Task #382).
 *
 * Sends events to two destinations:
 *   1. window.dataLayer (GA4 / GTM compatible) — picked up by any tag
 *      manager the user later wires in via index.html.
 *   2. POST /api/public/funnel-event — server-side beacon so we get
 *      events even when ad-blockers strip GTM.
 *
 * Events are fire-and-forget; failures are swallowed.
 */
declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

export type FunnelEvent =
  | "page_view"
  | "cta_click"
  | "pricing_view"
  | "roi_calc_started"
  | "roi_calc_completed"
  | "roi_lead_captured"
  | "demo_slot_selected"
  | "demo_booking_submitted"
  | "demo_booking_confirmed"
  | "demo_form_submitted";

export function trackFunnelEvent(event: FunnelEvent, properties: Record<string, unknown> = {}): void {
  try {
    if (typeof window !== "undefined") {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event, ...properties, ts: Date.now() });
    }
  } catch {
    /* ignore */
  }
  try {
    void fetch("/api/public/funnel-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ event, properties }),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
