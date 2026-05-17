import { useEffect, useRef, useState } from "react";

const SESSION_KEY = "kg_session_id";

function getSessionId(): string {
  let sid = localStorage.getItem(SESSION_KEY);
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(SESSION_KEY, sid);
  }
  return sid;
}

const BASE_URL = (typeof import.meta !== "undefined" ? (import.meta.env?.BASE_URL ?? "/") : "/").replace(/\/$/, "");

type Delivery = {
  slot: { id: number; slotKey: string; rotationSeconds: number } | null;
  campaign: { id: number; weight: number } | null;
  sponsor: { id: number; name: string; logoUrl: string | null; websiteUrl: string | null } | null;
  creative: {
    id: number;
    name: string;
    mediaType: "image" | "video";
    mediaUrl: string;
    clickThroughUrl: string | null;
    headline: string | null;
    subheadline: string | null;
  } | null;
};

async function fetchDelivery(orgId: number, slotKey: string, sessionId: string, tournamentId?: number): Promise<Delivery | null> {
  const params = new URLSearchParams({ sessionId });
  if (tournamentId) params.set("tournamentId", String(tournamentId));
  const url = `${BASE_URL}/api/public/ad-slot/${orgId}/${encodeURIComponent(slotKey)}?${params.toString()}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as Delivery;
  } catch {
    return null;
  }
}

function postEvent(body: Record<string, unknown>) {
  fetch(`${BASE_URL}/api/public/sponsor-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

export interface AdSlotProps {
  orgId: number;
  slotKey: string;
  tournamentId?: number;
  className?: string;
  style?: React.CSSProperties;
  fallback?: React.ReactNode;
  /** When true, automatically rotates by re-fetching every slot.rotationSeconds. */
  rotate?: boolean;
}

/** Renders the next eligible creative for an ad slot, logs impression + click. */
export default function AdSlot({ orgId, slotKey, tournamentId, className, style, fallback = null, rotate = true }: AdSlotProps) {
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [tick, setTick] = useState(0);
  // Use a unique nonce per delivery fetch so each render/rotation logs a fresh impression,
  // even if the same creative is selected again. Frequency caps and reporting depend on this.
  const deliveryNonce = useRef(0);
  const lastLoggedNonce = useRef<number>(-1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sessionId = getSessionId();
      const d = await fetchDelivery(orgId, slotKey, sessionId, tournamentId);
      if (!cancelled) {
        deliveryNonce.current += 1;
        setDelivery(d);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, slotKey, tournamentId, tick]);

  useEffect(() => {
    if (!rotate || !delivery?.slot) return;
    const seconds = delivery.slot.rotationSeconds;
    if (!seconds || seconds <= 0) return;
    const t = setTimeout(() => setTick(n => n + 1), seconds * 1000);
    return () => clearTimeout(t);
  }, [delivery, rotate]);

  // Log one impression per delivery fetch (each rotation/refetch counts as a new render).
  useEffect(() => {
    if (!delivery?.creative || !delivery.sponsor) return;
    if (lastLoggedNonce.current === deliveryNonce.current) return;
    lastLoggedNonce.current = deliveryNonce.current;
    postEvent({
      sponsorId: delivery.sponsor.id,
      eventType: "impression",
      source: slotKey,
      sessionId: getSessionId(),
      tournamentId,
      slotKey,
      campaignId: delivery.campaign?.id,
      creativeId: delivery.creative.id,
    });
  }, [delivery, slotKey, tournamentId]);

  if (!delivery?.creative || !delivery.sponsor) return <>{fallback}</>;

  const { creative, sponsor, campaign } = delivery;
  const href = creative.clickThroughUrl || sponsor.websiteUrl || undefined;

  const handleClick = () => {
    postEvent({
      sponsorId: sponsor.id,
      eventType: "click",
      source: slotKey,
      sessionId: getSessionId(),
      tournamentId,
      slotKey,
      campaignId: campaign?.id,
      creativeId: creative.id,
    });
  };

  const inner = creative.mediaType === "video" ? (
    <video
      src={creative.mediaUrl}
      autoPlay muted loop playsInline
      style={{ width: "100%", height: "100%", objectFit: "contain" }}
    />
  ) : (
    <img
      src={creative.mediaUrl}
      alt={creative.name}
      style={{ width: "100%", height: "100%", objectFit: "contain" }}
    />
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleClick}
        className={className}
        style={{ display: "block", ...(style ?? {}) }}
        data-slot={slotKey}
        data-sponsor={sponsor.name}
      >
        {inner}
      </a>
    );
  }

  return <div className={className} style={style} data-slot={slotKey} data-sponsor={sponsor.name}>{inner}</div>;
}
