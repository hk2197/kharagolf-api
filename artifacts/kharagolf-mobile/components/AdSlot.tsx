import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Pressable,
  Image,
  Linking,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

const SESSION_KEY = "kg_mobile_session_id";
let cachedSessionId: string | null = null;

async function getSessionId(): Promise<string> {
  if (cachedSessionId) return cachedSessionId;
  try {
    const existing = await AsyncStorage.getItem(SESSION_KEY);
    if (existing) {
      cachedSessionId = existing;
      return existing;
    }
  } catch { /* ignore */ }
  const sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  cachedSessionId = sid;
  try { await AsyncStorage.setItem(SESSION_KEY, sid); } catch { /* ignore */ }
  return sid;
}

export type AdDelivery = {
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

async function fetchDelivery(
  orgId: number,
  slotKey: string,
  sessionId: string,
  tournamentId?: number,
): Promise<AdDelivery | null> {
  const params = new URLSearchParams({ sessionId });
  if (tournamentId) params.set("tournamentId", String(tournamentId));
  const url = `${BASE_URL}/api/public/ad-slot/${orgId}/${encodeURIComponent(slotKey)}?${params.toString()}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as AdDelivery;
  } catch {
    return null;
  }
}

function postEvent(body: Record<string, unknown>) {
  fetch(`${BASE_URL}/api/public/sponsor-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export interface AdSlotProps {
  orgId: number;
  slotKey: string;
  tournamentId?: number;
  style?: StyleProp<ViewStyle>;
  /** When true, automatically rotates by re-fetching every slot.rotationSeconds. */
  rotate?: boolean;
  /** Notified when a delivery resolves with no creative (so callers can hide chrome). */
  onEmpty?: () => void;
  /** Notified after a creative loads. */
  onLoaded?: (d: AdDelivery) => void;
}

/** Renders the next eligible creative for an ad slot, logs impression + click. */
export default function AdSlot({
  orgId,
  slotKey,
  tournamentId,
  style,
  rotate = true,
  onEmpty,
  onLoaded,
}: AdSlotProps) {
  const [delivery, setDelivery] = useState<AdDelivery | null>(null);
  const [tick, setTick] = useState(0);
  const deliveryNonce = useRef(0);
  const lastLoggedNonce = useRef<number>(-1);
  const sessionIdRef = useRef<string | null>(null);

  // Keep latest callbacks in refs so changing their identities doesn't retrigger
  // the fetch effect (which would inflate impressions).
  const onLoadedRef = useRef(onLoaded);
  const onEmptyRef = useRef(onEmpty);
  useEffect(() => { onLoadedRef.current = onLoaded; }, [onLoaded]);
  useEffect(() => { onEmptyRef.current = onEmpty; }, [onEmpty]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sid = await getSessionId();
      sessionIdRef.current = sid;
      const d = await fetchDelivery(orgId, slotKey, sid, tournamentId);
      if (cancelled) return;
      deliveryNonce.current += 1;
      setDelivery(d);
      // Only signal "loaded" when there is a renderable image creative; the
      // mobile AdSlot only renders images today, so videos count as empty
      // for callers that gate UI on a real splash being available.
      const renderable = d?.creative && d.sponsor && d.creative.mediaType === "image";
      if (renderable) {
        onLoadedRef.current?.(d!);
      } else {
        onEmptyRef.current?.();
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

  // Log one impression per delivery fetch.
  useEffect(() => {
    if (!delivery?.creative || !delivery.sponsor) return;
    if (lastLoggedNonce.current === deliveryNonce.current) return;
    lastLoggedNonce.current = deliveryNonce.current;
    postEvent({
      sponsorId: delivery.sponsor.id,
      eventType: "impression",
      source: slotKey,
      sessionId: sessionIdRef.current,
      tournamentId,
      slotKey,
      campaignId: delivery.campaign?.id,
      creativeId: delivery.creative.id,
    });
  }, [delivery, slotKey, tournamentId]);

  const handlePress = useCallback(() => {
    if (!delivery?.creative || !delivery.sponsor) return;
    const { creative, sponsor, campaign } = delivery;
    const href = creative.clickThroughUrl || sponsor.websiteUrl;
    // Only count a click if there's somewhere to send the user; otherwise the
    // tap is a no-op and would inflate CTR.
    if (!href) return;
    postEvent({
      sponsorId: sponsor.id,
      eventType: "click",
      source: slotKey,
      sessionId: sessionIdRef.current,
      tournamentId,
      slotKey,
      campaignId: campaign?.id,
      creativeId: creative.id,
    });
    Linking.openURL(href).catch(() => {});
  }, [delivery, slotKey, tournamentId]);

  if (!delivery?.creative || !delivery.sponsor) return null;
  const { creative } = delivery;
  // Mobile slot is image-only per slot taxonomy; fall back to nothing for video.
  if (creative.mediaType !== "image") return null;

  return (
    <Pressable onPress={handlePress} style={[styles.container, style]}>
      <Image
        source={{ uri: creative.mediaUrl }}
        style={styles.image}
        resizeMode="contain"
        accessibilityLabel={creative.name}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { width: "100%", height: "100%" },
  image: { width: "100%", height: "100%" },
});
