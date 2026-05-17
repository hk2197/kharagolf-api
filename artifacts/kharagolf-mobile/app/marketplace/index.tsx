/**
 * Cross-Club Tee Time Marketplace — Discover screen (Task 359)
 *
 * Browse publicly-exposed tee times across every participating KHARAGOLF
 * club, filter by date / spots / price / distance, and one-tap book the
 * slot via the same per-club booking endpoint as the home-club flow.
 */

import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  FlatList,
  RefreshControl,
  TextInput,
  Alert,
  Platform,
  Animated,
  Modal,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";

let MapView: typeof import("react-native-maps").default | null = null;
let Marker: typeof import("react-native-maps").Marker | null = null;
if (Platform.OS !== "web") {
  try {
    const maps = require("react-native-maps");
    MapView = maps.default;
    Marker = maps.Marker;
  } catch {
    /* react-native-maps unavailable; map view will show fallback */
  }
}

interface MapRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

interface ClusterPoint {
  key: string;
  latitude: number;
  longitude: number;
  members: MarketplaceClub[];
}

/**
 * Group nearby clubs into clusters using a simple grid based on the current
 * map region. Cell size shrinks as the user zooms in, so dense metro pins
 * collapse at low zoom but split apart as you zoom in.
 */
function clusterClubs(clubs: MarketplaceClub[], region: MapRegion): ClusterPoint[] {
  // ~60px-ish cell at typical phone widths: 1/12 of the visible delta
  const cellLat = Math.max(region.latitudeDelta / 12, 0.0008);
  const cellLng = Math.max(region.longitudeDelta / 12, 0.0008);
  const buckets = new Map<string, MarketplaceClub[]>();
  for (const c of clubs) {
    if (c.latitude == null || c.longitude == null) continue;
    const gx = Math.floor(c.latitude / cellLat);
    const gy = Math.floor(c.longitude / cellLng);
    const key = `${gx}:${gy}`;
    const arr = buckets.get(key);
    if (arr) arr.push(c); else buckets.set(key, [c]);
  }
  const out: ClusterPoint[] = [];
  for (const [key, members] of buckets) {
    let lat = 0, lng = 0;
    for (const m of members) { lat += m.latitude as number; lng += m.longitude as number; }
    out.push({
      key,
      latitude: lat / members.length,
      longitude: lng / members.length,
      members,
    });
  }
  return out;
}

const GOLD = "#C9A84C";

interface MarketplaceClub {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  distanceKm: number | null;
}

interface MarketplaceSlot {
  id: number;
  organizationId: number;
  organizationName: string;
  organizationLogoUrl: string | null;
  organizationAddress: string | null;
  courseName: string | null;
  slotDate: string;
  startingHole: number;
  spotsLeft: number;
  maxPlayers: number;
  pricePaise: number;
  basePricePaise: number;
  markupPaise: number;
  priceDisplay: string;
  surgeIndicator: "off_peak" | "normal" | "surge";
  distanceKm: number | null;
}

interface SavedSearch {
  id: number;
  name: string;
  filters: Record<string, unknown>;
  notifyEnabled: boolean;
  lastNotifiedAt: string | null;
  dailyCap: number | null;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  quietHoursTz: string;
}

const DAILY_CAP_PRESETS: { label: string; value: number | null }[] = [
  { label: "Default", value: null },
  { label: "3 / day", value: 3 },
  { label: "5 / day", value: 5 },
  { label: "10 / day", value: 10 },
  { label: "25 / day", value: 25 },
];

const QUIET_HOUR_PRESETS: { label: string; start: number | null; end: number | null }[] = [
  { label: "Off", start: null, end: null },
  { label: "10pm – 7am", start: 22, end: 7 },
  { label: "11pm – 8am", start: 23, end: 8 },
  { label: "9pm – 9am", start: 21, end: 9 },
];

const HOURS_OF_DAY = Array.from({ length: 24 }, (_, i) => i);

/**
 * Common IANA timezone offerings for the picker. The backend accepts any
 * valid IANA zone, but exposing a curated list keeps the picker lightweight
 * on mobile while covering the regions where KHARAGOLF clubs operate today
 * plus major travel destinations.
 */
const TIMEZONE_OPTIONS: string[] = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Colombo",
  "Asia/Kathmandu",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Africa/Johannesburg",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "UTC",
];

function formatHour(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${period}`;
}

function quietHoursLabel(s: SavedSearch): string {
  if (s.quietHoursStart == null || s.quietHoursEnd == null || s.quietHoursStart === s.quietHoursEnd) {
    return "Off";
  }
  return `${formatHour(s.quietHoursStart)} – ${formatHour(s.quietHoursEnd)}`;
}

const DAYS_AHEAD_PRESETS = [3, 7, 14, 30];
const SORT_OPTIONS: { key: "date" | "price" | "distance"; label: string }[] = [
  { key: "date", label: "Soonest" },
  { key: "price", label: "Cheapest" },
  { key: "distance", label: "Nearest" },
];

export default function MarketplaceDiscoverScreen() {
  const { token } = useAuth();
  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : "";

  const [slots, setSlots] = useState<MarketplaceSlot[]>([]);
  const [clubs, setClubs] = useState<MarketplaceClub[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<"list" | "map">("list");
  /**
   * Live per-club open-slot counts, polled every minute while the map view is
   * active. Lets pin colour/badge reflect "tee times opened/filled" within
   * ~60s without re-downloading the whole slot list. Falls back to the
   * locally-derived count from `slots` until the first poll lands.
   */
  const [liveCounts, setLiveCounts] = useState<Record<number, number>>({});
  const [liveCountsAsOf, setLiveCountsAsOf] = useState<string | null>(null);
  /**
   * Per-club "just changed" markers driven by comparing each new `liveCounts`
   * tick against the previous one. `opened` = open-slot count went up (pulse
   * + NEW badge); `filled` = count dropped to zero (fade-out). Entries
   * auto-expire ~6s after they fire so the highlight doesn't stick around.
   */
  const [recentChange, setRecentChange] = useState<
    Record<number, { type: "opened" | "filled"; at: number }>
  >({});
  const prevLiveCountsRef = useRef<Record<number, number>>({});
  const [selectedOrgId, setSelectedOrgId] = useState<number | null>(null);
  const [daysAhead, setDaysAhead] = useState(7);
  const [minSpots, setMinSpots] = useState(1);
  const [maxPriceRupees, setMaxPriceRupees] = useState<string>("");
  const [sort, setSort] = useState<"date" | "price" | "distance">("date");
  const [showSaved, setShowSaved] = useState(false);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [savedName, setSavedName] = useState("");

  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    const now = new Date();
    const to = new Date(now.getTime() + daysAhead * 86_400_000);
    params.set("fromDate", now.toISOString());
    params.set("toDate", to.toISOString());
    params.set("minSpots", String(minSpots));
    if (maxPriceRupees && Number(maxPriceRupees) > 0) {
      params.set("maxPricePaise", String(Math.round(Number(maxPriceRupees) * 100)));
    }
    params.set("sort", sort);
    return params.toString();
  }, [daysAhead, minSpots, maxPriceRupees, sort]);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`${baseUrl}/api/marketplace-discover/slots?${filterQuery}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSlots(data.slots ?? []);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load tee times";
      setError(msg);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [baseUrl, filterQuery, token]);

  const loadClubs = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/marketplace-discover/clubs`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) setClubs(await res.json());
    } catch { /* non-fatal */ }
  }, [baseUrl, token]);

  const loadSaved = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${baseUrl}/api/marketplace-discover/saved-searches`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setSaved(await res.json());
    } catch { /* non-fatal */ }
  }, [baseUrl, token]);

  const loadLiveCounts = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/marketplace-discover/clubs/slot-counts?${filterQuery}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const data = await res.json();
      const map: Record<number, number> = {};
      for (const c of (data.counts ?? []) as { organizationId: number; openSlots: number }[]) {
        map[c.organizationId] = c.openSlots;
      }
      setLiveCounts(map);
      setLiveCountsAsOf(data.asOf ?? new Date().toISOString());
    } catch { /* non-fatal — pins simply won't update this tick */ }
  }, [baseUrl, filterQuery, token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadClubs(); }, [loadClubs]);
  useEffect(() => { if (showSaved) loadSaved(); }, [showSaved, loadSaved]);

  // Auto-close the cluster picker sheet if the user navigates away from
  // the map (switching to list view or opening the saved searches panel)
  // so a stale sheet can't linger over an unrelated screen.
  useEffect(() => {
    if (viewMode !== "map" || showSaved) setClusterSheet(null);
  }, [viewMode, showSaved]);

  // Live updates while the map is open. Strategy:
  //  1. Open the cross-club discover SSE stream — the server pushes a
  //     lightweight `slot_change` event whenever any club's marketplace
  //     slot is created, booked, cancelled, edited or deleted. On each
  //     event we refetch the filter-aware per-club counts so pins
  //     update within ~1s instead of waiting for the next poll tick.
  //  2. Polling fallback every 60s — keeps the map fresh on networks
  //     that block long-lived streaming connections (some corporate
  //     proxies, restrictive Wi-Fi captive portals) and bridges the
  //     gap between SSE reconnects.
  useEffect(() => {
    if (showSaved || viewMode !== "map") return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();
    // Last `slot_change` event id we've seen on this mounted view.
    // Sent on every (re)connect so the server can replay anything we
    // missed while the socket was down (server restart, network blip,
    // app momentarily backgrounded). Persists across reconnect attempts
    // within the same effect lifecycle.
    let lastEventId = 0;

    // Coalesce bursts of slot_change events (e.g. an admin bulk-creating
    // 50 slots) into a single counts refetch ~250ms later.
    const scheduleRefetch = () => {
      if (refetchTimer) return;
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        if (!cancelled) loadLiveCounts();
      }, 250);
    };

    const startPollingFallback = () => {
      if (pollTimer || cancelled) return;
      pollTimer = setInterval(() => { if (!cancelled) loadLiveCounts(); }, 60_000);
    };

    const stopPollingFallback = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };

    let isReconnect = false;
    async function connectStream() {
      try {
        // On reconnect, ask the server to replay any slot_change
        // events with id > lastEventId via both the standard SSE
        // header and a query fallback (some proxies strip custom
        // headers from streaming requests). Always refetch counts on
        // a reconnect attempt so pin colours reflect reality even if
        // we have no cursor yet (initial connect happened while idle)
        // or the replay yields nothing.
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        if (lastEventId > 0) headers["Last-Event-ID"] = String(lastEventId);
        if (isReconnect && !cancelled) loadLiveCounts();
        const url = lastEventId > 0
          ? `${baseUrl}/api/marketplace-discover/stream?lastEventId=${lastEventId}`
          : `${baseUrl}/api/marketplace-discover/stream`;
        const res = await fetch(url, { signal: ctrl.signal, headers });
        if (!res.ok || !res.body) {
          startPollingFallback();
          if (!cancelled) retryTimer = setTimeout(connectStream, 8000);
          return;
        }
        // SSE is open — stop redundant 60s polling for this connection.
        stopPollingFallback();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const lines = part.split("\n");
            const idLine = lines.find((l) => l.startsWith("id:"));
            const dataLine = lines.find((l) => l.startsWith("data:"));
            if (idLine) {
              const id = parseInt(idLine.slice(3).trim(), 10);
              if (Number.isFinite(id) && id > lastEventId) lastEventId = id;
            }
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice(5).trim()) as {
                type?: string;
                id?: number;
                lastEventId?: number;
              };
              if (typeof parsed.id === "number" && parsed.id > lastEventId) {
                lastEventId = parsed.id;
              }
              if (parsed.type === "ready" && typeof parsed.lastEventId === "number") {
                // Server tells us its current sequence on connect. Adopt
                // it as our cursor so a later reconnect (after an idle
                // period with zero slot_change events) still asks the
                // server to replay anything that happened during the gap.
                if (parsed.lastEventId > lastEventId) lastEventId = parsed.lastEventId;
              } else if (parsed.type === "slot_change") {
                scheduleRefetch();
              } else if (parsed.type === "resync") {
                // Server lost our cursor — refetch counts to resync.
                if (!cancelled) loadLiveCounts();
              }
            } catch { /* ignore malformed events */ }
          }
        }
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return;
      }
      // Disconnected (server restart, network blip, etc). Re-enable
      // polling immediately and schedule a reconnect; mark the next
      // attempt as a reconnect so it triggers an immediate counts
      // refetch even if we never saw any slot_change events.
      if (!cancelled) {
        startPollingFallback();
        isReconnect = true;
        retryTimer = setTimeout(connectStream, 8000);
      }
    }

    loadLiveCounts();
    void connectStream();

    return () => {
      cancelled = true;
      ctrl.abort();
      if (pollTimer) clearInterval(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (refetchTimer) clearTimeout(refetchTimer);
    };
  }, [showSaved, viewMode, baseUrl, token, loadLiveCounts]);

  // Reset the previous-tick baseline and any active "just changed"
  // highlights whenever the filter set changes or the map view is closed.
  // Without this, the next tick's diff would compare against a baseline
  // taken under a different filter (or a stale one from last time the map
  // was open) and pulse pins for filter-set changes rather than actual
  // live market transitions.
  useEffect(() => {
    prevLiveCountsRef.current = {};
    setRecentChange({});
    setLiveCountsAsOf(null);
  }, [filterQuery, viewMode]);

  // Compare each new live-counts tick against the previous one and flag pins
  // whose open-slot count just went up ("opened") or dropped to zero
  // ("filled"). Skip the first tick so we don't pulse every visible pin the
  // moment the map opens. Highlights auto-expire after ~6s.
  useEffect(() => {
    if (!liveCountsAsOf) return;
    const prev = prevLiveCountsRef.current;
    const isFirstTick = Object.keys(prev).length === 0;
    prevLiveCountsRef.current = { ...liveCounts };
    if (isFirstTick) return;

    const now = Date.now();
    const changes: Record<number, { type: "opened" | "filled"; at: number }> = {};
    const ids = new Set<number>();
    for (const k of Object.keys(prev)) ids.add(Number(k));
    for (const k of Object.keys(liveCounts)) ids.add(Number(k));
    for (const id of ids) {
      const prevCount = prev[id] ?? 0;
      const currCount = liveCounts[id] ?? 0;
      if (currCount > prevCount) {
        changes[id] = { type: "opened", at: now };
      } else if (currCount === 0 && prevCount > 0) {
        changes[id] = { type: "filled", at: now };
      }
    }
    if (Object.keys(changes).length === 0) return;
    setRecentChange((rc) => ({ ...rc, ...changes }));
    const timer = setTimeout(() => {
      setRecentChange((rc) => {
        const next: typeof rc = {};
        const cutoff = Date.now() - 5_500;
        for (const [k, v] of Object.entries(rc)) {
          if (v.at > cutoff) next[Number(k)] = v;
        }
        return next;
      });
    }, 6_000);
    return () => clearTimeout(timer);
  }, [liveCounts, liveCountsAsOf]);

  const visibleSlots = useMemo(
    () => (selectedOrgId == null ? slots : slots.filter((s) => s.organizationId === selectedOrgId)),
    [slots, selectedOrgId],
  );
  const selectedClub = useMemo(
    () => (selectedOrgId == null ? null : clubs.find((c) => c.id === selectedOrgId) ?? null),
    [clubs, selectedOrgId],
  );

  const mappableClubs = useMemo(
    () => clubs.filter((c) => c.latitude != null && c.longitude != null),
    [clubs],
  );
  const mapRef = useRef<import("react-native-maps").default | null>(null);
  const [mapRegion, setMapRegion] = useState<MapRegion | null>(null);
  /**
   * When a tapped cluster's members are co-located within a tiny radius
   * (e.g. multiple courses at the same resort), zooming further won't
   * separate them. Instead, surface the members in a bottom sheet so the
   * player can pick directly. `null` means no sheet is open.
   */
  const [clusterSheet, setClusterSheet] = useState<MarketplaceClub[] | null>(null);
  const selectClusterMember = useCallback((c: MarketplaceClub) => {
    setSelectedOrgId(c.id);
    setClusterSheet(null);
    if (c.latitude != null && c.longitude != null) {
      mapRef.current?.animateToRegion({
        latitude: c.latitude,
        longitude: c.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      }, 350);
    }
  }, []);
  const slotCountByOrg = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of slots) m.set(s.organizationId, (m.get(s.organizationId) ?? 0) + 1);
    return m;
  }, [slots]);
  const mapInitialRegion = useMemo(() => {
    if (mappableClubs.length === 0) {
      return { latitude: 20.5937, longitude: 78.9629, latitudeDelta: 20, longitudeDelta: 20 };
    }
    const lats = mappableClubs.map((c) => c.latitude as number);
    const lngs = mappableClubs.map((c) => c.longitude as number);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max(0.5, (maxLat - minLat) * 1.6),
      longitudeDelta: Math.max(0.5, (maxLng - minLng) * 1.6),
    };
  }, [mappableClubs]);

  const handleBook = async (slot: MarketplaceSlot) => {
    if (!token) { Alert.alert("Sign in required", "Please sign in to book a tee time."); return; }
    Alert.alert(
      `Book ${slot.organizationName}?`,
      `${formatSlotTime(slot.slotDate)} · ${slot.spotsLeft} spot${slot.spotsLeft === 1 ? "" : "s"} left\n${slot.priceDisplay}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm", onPress: async () => {
            try {
              const res = await fetch(
                `${baseUrl}/api/organizations/${slot.organizationId}/marketplace/${slot.id}/book`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ players: 1 }),
                },
              );
              const data = await res.json();
              if (!res.ok) throw new Error(data?.error || "Booking failed");
              if (data.razorpayOrderId || data.paymentRequired) {
                Alert.alert("Payment required", "Continue payment in your home-club bookings page.", [
                  { text: "OK", onPress: () => router.push("/tee-bookings") },
                ]);
              } else {
                Alert.alert("Booked!", "Your tee time is confirmed.");
                load();
              }
            } catch (e: unknown) {
              Alert.alert("Couldn't book", e instanceof Error ? e.message : "Try again");
            }
          },
        },
      ],
    );
  };

  const handleSaveSearch = async () => {
    const name = savedName.trim();
    if (!name) { Alert.alert("Name required", "Give your search a name."); return; }
    try {
      const filters: Record<string, unknown> = {
        fromDate: new Date().toISOString(),
        toDate: new Date(Date.now() + daysAhead * 86_400_000).toISOString(),
        minSpots,
      };
      if (maxPriceRupees && Number(maxPriceRupees) > 0) {
        filters.maxPricePaise = Math.round(Number(maxPriceRupees) * 100);
      }
      const res = await fetch(`${baseUrl}/api/marketplace-discover/saved-searches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, filters, notifyEnabled: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSavedName("");
      await loadSaved();
      Alert.alert("Saved", "We'll notify you when matching tee times open.");
    } catch (e: unknown) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again");
    }
  };

  const handleDeleteSaved = async (id: number) => {
    try {
      await fetch(`${baseUrl}/api/marketplace-discover/saved-searches/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await loadSaved();
    } catch { /* non-fatal */ }
  };

  /** Patch a saved search and refresh the list. */
  const updateSaved = async (id: number, patch: Record<string, unknown>) => {
    try {
      const res = await fetch(`${baseUrl}/api/marketplace-discover/saved-searches/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await res.text());
      await loadSaved();
    } catch (e: unknown) {
      Alert.alert("Couldn't update", e instanceof Error ? e.message : "Try again");
    }
  };

  const [expandedSavedId, setExpandedSavedId] = useState<number | null>(null);
  /** Saved-search id whose timezone picker modal is open, or null. */
  const [tzPickerForId, setTzPickerForId] = useState<number | null>(null);

  const renderSlot = ({ item }: { item: MarketplaceSlot }) => (
    <TouchableOpacity style={styles.card} onPress={() => handleBook(item)} activeOpacity={0.85}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.club}>{item.organizationName}</Text>
          {item.courseName ? <Text style={styles.course}>{item.courseName}</Text> : null}
          {item.organizationAddress ? (
            <Text style={styles.addr} numberOfLines={1}>
              <Feather name="map-pin" size={11} color="#888" /> {item.organizationAddress}
              {item.distanceKm != null ? `  ·  ${item.distanceKm.toFixed(1)} km` : ""}
            </Text>
          ) : null}
        </View>
        {item.surgeIndicator !== "normal" ? (
          <View style={[styles.badge, item.surgeIndicator === "surge" ? styles.badgeSurge : styles.badgeOff]}>
            <Text style={styles.badgeText}>{item.surgeIndicator === "surge" ? "HIGH DEMAND" : "OFF-PEAK"}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.cardBody}>
        <View>
          <Text style={styles.time}>{formatSlotTime(item.slotDate)}</Text>
          <Text style={styles.subtext}>Hole {item.startingHole} · {item.spotsLeft}/{item.maxPlayers} open</Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.price}>{item.priceDisplay}</Text>
          {item.markupPaise > 0 ? (
            <Text style={styles.markup}>incl. ₹{(item.markupPaise / 100).toFixed(0)} marketplace fee</Text>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}><Feather name="arrow-left" size={24} color="#fff" /></TouchableOpacity>
        <Text style={styles.headerTitle}>Tee Time Marketplace</Text>
        <TouchableOpacity onPress={() => setShowSaved((v) => !v)}>
          <Feather name={showSaved ? "x" : "bookmark"} size={22} color={GOLD} />
        </TouchableOpacity>
      </View>

      {showSaved ? (
        <ScrollView style={styles.savedPanel} contentContainerStyle={{ padding: 16 }}>
          <Text style={styles.sectionTitle}>Saved searches</Text>
          <View style={styles.savedComposer}>
            <TextInput
              placeholder="Name this search"
              placeholderTextColor="#888"
              value={savedName}
              onChangeText={setSavedName}
              style={styles.input}
            />
            <TouchableOpacity style={styles.saveBtn} onPress={handleSaveSearch}>
              <Text style={styles.saveBtnText}>Save current</Text>
            </TouchableOpacity>
          </View>
          {saved.length === 0 ? (
            <Text style={styles.empty}>No saved searches yet.</Text>
          ) : saved.map((s) => {
            const isExpanded = expandedSavedId === s.id;
            return (
              <View key={s.id} style={styles.savedCard}>
                <View style={styles.savedRowHeader}>
                  <TouchableOpacity
                    style={{ flex: 1 }}
                    onPress={() => setExpandedSavedId(isExpanded ? null : s.id)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.savedName}>{s.name}</Text>
                    <Text style={styles.savedMeta}>
                      {s.notifyEnabled ? `Cap ${s.dailyCap ?? "default"} · Quiet ${quietHoursLabel(s)}` : "Notifications off"}
                      {s.lastNotifiedAt ? ` · last alert ${new Date(s.lastNotifiedAt).toLocaleDateString()}` : ""}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setExpandedSavedId(isExpanded ? null : s.id)}
                    style={{ padding: 6 }}
                  >
                    <Feather name={isExpanded ? "chevron-up" : "chevron-down"} size={18} color="#999" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDeleteSaved(s.id)} style={{ padding: 6 }}>
                    <Feather name="trash-2" size={18} color="#c44" />
                  </TouchableOpacity>
                </View>

                {isExpanded ? (
                  <View style={styles.savedDetail}>
                    <View style={styles.savedDetailRow}>
                      <Text style={styles.savedDetailLabel}>Notifications</Text>
                      <TouchableOpacity
                        style={[styles.toggleBtn, s.notifyEnabled && styles.toggleBtnOn]}
                        onPress={() => updateSaved(s.id, { notifyEnabled: !s.notifyEnabled })}
                      >
                        <Text style={[styles.toggleBtnText, s.notifyEnabled && styles.toggleBtnTextOn]}>
                          {s.notifyEnabled ? "On" : "Off"}
                        </Text>
                      </TouchableOpacity>
                    </View>

                    <Text style={styles.savedDetailLabel}>Daily cap</Text>
                    <View style={styles.savedChoiceRow}>
                      {DAILY_CAP_PRESETS.map((p) => {
                        const active = (s.dailyCap ?? null) === p.value;
                        return (
                          <TouchableOpacity
                            key={String(p.value)}
                            onPress={() => updateSaved(s.id, { dailyCap: p.value })}
                            style={[styles.smallChip, active && styles.smallChipActive]}
                          >
                            <Text style={[styles.smallChipText, active && styles.smallChipTextActive]}>
                              {p.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <Text style={styles.savedDetailLabel}>Quiet hours</Text>
                    <View style={styles.savedChoiceRow}>
                      {QUIET_HOUR_PRESETS.map((p) => {
                        const active =
                          (s.quietHoursStart ?? null) === p.start && (s.quietHoursEnd ?? null) === p.end;
                        return (
                          <TouchableOpacity
                            key={p.label}
                            onPress={() => updateSaved(s.id, {
                              quietHoursStart: p.start,
                              quietHoursEnd: p.end,
                            })}
                            style={[styles.smallChip, active && styles.smallChipActive]}
                          >
                            <Text style={[styles.smallChipText, active && styles.smallChipTextActive]}>
                              {p.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <Text style={styles.savedDetailLabel}>Custom start</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.hourScrollRow}
                    >
                      {HOURS_OF_DAY.map((h) => {
                        const active = s.quietHoursStart === h;
                        return (
                          <TouchableOpacity
                            key={`start-${h}`}
                            onPress={() => updateSaved(s.id, {
                              quietHoursStart: h,
                              quietHoursEnd: s.quietHoursEnd ?? h,
                            })}
                            style={[styles.hourChip, active && styles.hourChipActive]}
                          >
                            <Text style={[styles.hourChipText, active && styles.hourChipTextActive]}>
                              {formatHour(h)}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>

                    <Text style={styles.savedDetailLabel}>Custom end</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.hourScrollRow}
                    >
                      {HOURS_OF_DAY.map((h) => {
                        const active = s.quietHoursEnd === h;
                        return (
                          <TouchableOpacity
                            key={`end-${h}`}
                            onPress={() => updateSaved(s.id, {
                              quietHoursStart: s.quietHoursStart ?? h,
                              quietHoursEnd: h,
                            })}
                            style={[styles.hourChip, active && styles.hourChipActive]}
                          >
                            <Text style={[styles.hourChipText, active && styles.hourChipTextActive]}>
                              {formatHour(h)}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>

                    <View style={styles.savedDetailRow}>
                      <Text style={styles.savedDetailLabel}>Timezone</Text>
                      <TouchableOpacity
                        style={styles.tzBtn}
                        onPress={() => setTzPickerForId(s.id)}
                      >
                        <Feather name="globe" size={12} color={GOLD} />
                        <Text style={styles.tzBtnText}>{s.quietHoursTz}</Text>
                        <Feather name="chevron-down" size={12} color="#999" />
                      </TouchableOpacity>
                    </View>

                    <Text style={styles.savedHint}>
                      Quiet hours use {s.quietHoursTz}. Setting start and end to the same hour turns quiet hours off.
                    </Text>
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      ) : (
        <>
          <View style={styles.modeToggle}>
            <TouchableOpacity
              onPress={() => { setViewMode("list"); setSelectedOrgId(null); }}
              style={[styles.modeBtn, viewMode === "list" && styles.modeBtnActive]}>
              <Feather name="list" size={14} color={viewMode === "list" ? "#000" : "#bbb"} />
              <Text style={[styles.modeBtnText, viewMode === "list" && styles.modeBtnTextActive]}>List</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setViewMode("map")}
              style={[styles.modeBtn, viewMode === "map" && styles.modeBtnActive]}>
              <Feather name="map" size={14} color={viewMode === "map" ? "#000" : "#bbb"} />
              <Text style={[styles.modeBtnText, viewMode === "map" && styles.modeBtnTextActive]}>Map</Text>
            </TouchableOpacity>
          </View>

          {viewMode === "list" ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
              {DAYS_AHEAD_PRESETS.map((d) => (
                <TouchableOpacity key={d}
                  onPress={() => setDaysAhead(d)}
                  style={[styles.chip, daysAhead === d && styles.chipActive]}>
                  <Text style={[styles.chipText, daysAhead === d && styles.chipTextActive]}>Next {d}d</Text>
                </TouchableOpacity>
              ))}
              {[1, 2, 3, 4].map((s) => (
                <TouchableOpacity key={`s${s}`}
                  onPress={() => setMinSpots(s)}
                  style={[styles.chip, minSpots === s && styles.chipActive]}>
                  <Text style={[styles.chipText, minSpots === s && styles.chipTextActive]}>{s}+ spot{s > 1 ? "s" : ""}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}

          {viewMode === "list" ? (
            <View style={styles.toolbar}>
              <TextInput
                placeholder="Max ₹ per slot"
                placeholderTextColor="#888"
                keyboardType="numeric"
                value={maxPriceRupees}
                onChangeText={setMaxPriceRupees}
                style={[styles.input, { flex: 1 }]}
              />
              {SORT_OPTIONS.map((o) => (
                <TouchableOpacity key={o.key}
                  onPress={() => setSort(o.key)}
                  style={[styles.sortChip, sort === o.key && styles.sortChipActive]}>
                  <Text style={[styles.sortChipText, sort === o.key && styles.sortChipTextActive]}>{o.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          {viewMode === "map" ? (
            MapView && Marker ? (
              <View style={styles.mapWrap}>
                <MapView
                  ref={(r) => { mapRef.current = r; }}
                  style={styles.map}
                  initialRegion={mapInitialRegion}
                  onRegionChangeComplete={(r) => setMapRegion(r)}
                >
                  {clusterClubs(mappableClubs, mapRegion ?? mapInitialRegion).map((cluster) => {
                    // Prefer the live-polled count (refreshed every 60s) so pin
                    // colour reflects slots opening/filling in real time. The
                    // endpoint omits clubs that currently have zero matching
                    // slots, so once a poll has landed (`liveCountsAsOf` set) a
                    // missing key means 0 — not "fall back to the stale list".
                    // Before the first poll lands, fall back to the count
                    // derived from the loaded slot list.
                    const countFor = (id: number): number =>
                      liveCountsAsOf
                        ? (liveCounts[id] ?? 0)
                        : (slotCountByOrg.get(id) ?? 0);
                    if (cluster.members.length === 1) {
                      const c = cluster.members[0];
                      const slotCount = countFor(c.id);
                      const isSelected = selectedOrgId === c.id;
                      const change = recentChange[c.id];
                      const baseColor = isSelected ? GOLD : slotCount > 0 ? "#1f7a3a" : "#888";
                      return (
                        <Marker
                          key={`pin-${c.id}`}
                          identifier={`pin-${c.id}-${slotCount}-${change?.at ?? 0}`}
                          coordinate={{ latitude: c.latitude as number, longitude: c.longitude as number }}
                          title={c.name}
                          description={
                            change?.type === "opened"
                              ? `New! ${slotCount} tee time${slotCount === 1 ? "" : "s"} available`
                              : change?.type === "filled"
                                ? "Just filled up"
                                : slotCount > 0
                                  ? `${slotCount} tee time${slotCount === 1 ? "" : "s"} available`
                                  : "No matching tee times"
                          }
                          onPress={() => setSelectedOrgId(isSelected ? null : c.id)}
                        >
                          <AnimatedPin color={baseColor} change={change?.type} />
                        </Marker>
                      );
                    }
                    const totalSlots = cluster.members.reduce(
                      (sum, m) => sum + countFor(m.id),
                      0,
                    );
                    // Roll up per-member "just changed" markers into a single
                    // cluster-level highlight so a fresh opening or a drop to
                    // zero inside a collapsed cluster isn't lost. "opened"
                    // wins over "filled" — a new slot is the more actionable
                    // signal — and we only fade the cluster when every
                    // member is now at zero, mirroring the per-pin behaviour.
                    let clusterChange: { type: "opened" | "filled"; at: number } | undefined;
                    let openedAt = 0;
                    let filledAt = 0;
                    for (const m of cluster.members) {
                      const ch = recentChange[m.id];
                      if (!ch) continue;
                      if (ch.type === "opened" && ch.at > openedAt) openedAt = ch.at;
                      if (ch.type === "filled" && ch.at > filledAt) filledAt = ch.at;
                    }
                    if (openedAt > 0) {
                      clusterChange = { type: "opened", at: openedAt };
                    } else if (filledAt > 0 && totalSlots === 0) {
                      clusterChange = { type: "filled", at: filledAt };
                    }
                    return (
                      <Marker
                        key={`cluster-${cluster.key}`}
                        identifier={`cluster-${cluster.key}-${totalSlots}-${clusterChange?.at ?? 0}`}
                        coordinate={{ latitude: cluster.latitude, longitude: cluster.longitude }}
                        title={`${cluster.members.length} clubs nearby`}
                        description={
                          clusterChange?.type === "opened"
                            ? `New! ${totalSlots} tee time${totalSlots === 1 ? "" : "s"} available nearby`
                            : clusterChange?.type === "filled"
                              ? "Nearby tee times just filled up"
                              : totalSlots > 0
                                ? `${totalSlots} tee time${totalSlots === 1 ? "" : "s"} available`
                                : "Tap to zoom in"
                        }
                        onPress={() => {
                          const lats = cluster.members.map((m) => m.latitude as number);
                          const lngs = cluster.members.map((m) => m.longitude as number);
                          const minLat = Math.min(...lats), maxLat = Math.max(...lats);
                          const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
                          // If members fall inside a tiny radius (~150m),
                          // zooming further won't separate them — the cluster
                          // grid's minimum cell (~90m) keeps re-collapsing.
                          // Open a sheet so the player can pick directly.
                          const TIGHT_DELTA = 0.0015;
                          const isTight =
                            (maxLat - minLat) < TIGHT_DELTA &&
                            (maxLng - minLng) < TIGHT_DELTA;
                          if (isTight) {
                            setClusterSheet(cluster.members);
                            return;
                          }
                          mapRef.current?.animateToRegion({
                            latitude: (minLat + maxLat) / 2,
                            longitude: (minLng + maxLng) / 2,
                            latitudeDelta: Math.max(0.01, (maxLat - minLat) * 2.2),
                            longitudeDelta: Math.max(0.01, (maxLng - minLng) * 2.2),
                          }, 350);
                        }}
                      >
                        <AnimatedClusterBubble
                          count={cluster.members.length}
                          change={clusterChange?.type}
                        />
                      </Marker>
                    );
                  })}
                </MapView>
              </View>
            ) : (
              <View style={styles.mapFallback}>
                <Feather name="map" size={32} color="#666" />
                <Text style={styles.empty}>Map view is available in the iOS and Android apps.</Text>
              </View>
            )
          ) : null}

          {viewMode === "map" && selectedClub ? (() => {
            // Prefer the live-polled count for the summary so the banner
            // agrees with the pin colour even when the loaded slot list is
            // a few seconds stale. Fall back to the loaded list before the
            // first poll completes.
            const summaryCount = liveCountsAsOf
              ? (liveCounts[selectedClub.id] ?? 0)
              : visibleSlots.length;
            return (
            <View style={styles.selectedClubBar}>
              <View style={{ flex: 1 }}>
                <Text style={styles.selectedClubName}>{selectedClub.name}</Text>
                <Text style={styles.selectedClubMeta}>
                  {summaryCount} tee time{summaryCount === 1 ? "" : "s"} matching your filters
                  {liveCountsAsOf ? ` · live as of ${formatLiveTime(liveCountsAsOf)}` : ""}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setSelectedOrgId(null)}>
                <Text style={styles.clearLink}>Show all</Text>
              </TouchableOpacity>
            </View>
            );
          })() : null}

          {loading ? (
            <LoadingSpinner color={GOLD} style={{ marginTop: 32 }} />
          ) : error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : (
            <FlatList
              data={visibleSlots}
              keyExtractor={(s) => String(s.id)}
              renderItem={renderSlot}
              contentContainerStyle={{ padding: 12, paddingBottom: 80 }}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); loadClubs(); }} tintColor={GOLD} />
              }
              ListEmptyComponent={
                <Text style={styles.empty}>
                  {selectedClub
                    ? `No tee times at ${selectedClub.name} match your filters.`
                    : "No tee times match your filters."}
                </Text>
              }
            />
          )}
        </>
      )}

      <Modal
        visible={clusterSheet != null}
        transparent
        animationType="slide"
        onRequestClose={() => setClusterSheet(null)}
      >
        <TouchableOpacity
          style={styles.sheetBackdrop}
          activeOpacity={1}
          onPress={() => setClusterSheet(null)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {clusterSheet?.length ?? 0} clubs at this location
              </Text>
              <TouchableOpacity onPress={() => setClusterSheet(null)}>
                <Feather name="x" size={20} color="#bbb" />
              </TouchableOpacity>
            </View>
            {(() => {
              const members = clusterSheet ?? [];
              const mapped = members.filter(
                (c) => c.latitude != null && c.longitude != null,
              );
              if (!MapView || !Marker || mapped.length === 0) return null;
              const lats = mapped.map((c) => c.latitude as number);
              const lngs = mapped.map((c) => c.longitude as number);
              const minLat = Math.min(...lats), maxLat = Math.max(...lats);
              const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
              const region = {
                latitude: (minLat + maxLat) / 2,
                longitude: (minLng + maxLng) / 2,
                latitudeDelta: Math.max(0.004, (maxLat - minLat) * 2.5),
                longitudeDelta: Math.max(0.004, (maxLng - minLng) * 2.5),
              };
              return (
                <View style={styles.sheetMapWrap}>
                  <MapView
                    style={styles.sheetMap}
                    initialRegion={region}
                    pointerEvents="box-none"
                    scrollEnabled={false}
                    zoomEnabled={false}
                    rotateEnabled={false}
                    pitchEnabled={false}
                  >
                    {mapped.map((c) => (
                      <Marker
                        key={`sheet-pin-${c.id}`}
                        coordinate={{
                          latitude: c.latitude as number,
                          longitude: c.longitude as number,
                        }}
                        title={c.name}
                        onPress={() => selectClusterMember(c)}
                      >
                        <View style={styles.sheetPin}>
                          <Text style={styles.sheetPinText} numberOfLines={1}>
                            {c.name}
                          </Text>
                        </View>
                      </Marker>
                    ))}
                  </MapView>
                </View>
              );
            })()}
            <ScrollView style={{ maxHeight: 320 }}>
              {(clusterSheet ?? []).map((c) => {
                const slotCount = liveCountsAsOf
                  ? (liveCounts[c.id] ?? 0)
                  : (slotCountByOrg.get(c.id) ?? 0);
                return (
                  <TouchableOpacity
                    key={c.id}
                    style={styles.sheetRow}
                    onPress={() => selectClusterMember(c)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.sheetRowName}>{c.name}</Text>
                      <Text style={styles.sheetRowMeta}>
                        {c.distanceKm != null ? `${c.distanceKm.toFixed(1)} km away` : "Distance unknown"}
                        {" · "}
                        {slotCount} tee time{slotCount === 1 ? "" : "s"}
                      </Text>
                    </View>
                    <Feather name="chevron-right" size={18} color="#666" />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={tzPickerForId != null}
        transparent
        animationType="slide"
        onRequestClose={() => setTzPickerForId(null)}
      >
        <TouchableOpacity
          style={styles.sheetBackdrop}
          activeOpacity={1}
          onPress={() => setTzPickerForId(null)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Pick a timezone</Text>
              <TouchableOpacity onPress={() => setTzPickerForId(null)}>
                <Feather name="x" size={20} color="#bbb" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 420 }}>
              {(() => {
                const target = saved.find((x) => x.id === tzPickerForId);
                const current = target?.quietHoursTz;
                const merged = current && !TIMEZONE_OPTIONS.includes(current)
                  ? [current, ...TIMEZONE_OPTIONS]
                  : TIMEZONE_OPTIONS;
                return merged.map((tz) => {
                  const active = current === tz;
                  return (
                    <TouchableOpacity
                      key={tz}
                      style={styles.sheetRow}
                      onPress={() => {
                        if (tzPickerForId != null) {
                          updateSaved(tzPickerForId, { quietHoursTz: tz });
                        }
                        setTzPickerForId(null);
                      }}
                    >
                      <Text style={[styles.sheetRowName, active && { color: GOLD }]}>{tz}</Text>
                      {active ? <Feather name="check" size={18} color={GOLD} /> : null}
                    </TouchableOpacity>
                  );
                });
              })()}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

function formatSlotTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatLiveTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

/**
 * Custom map pin that animates when its club's open-slot count just changed:
 *   - `opened`: a pulsing ring + a small "NEW" badge for ~5s.
 *   - `filled`: the dot fades down to a faint grey to draw the eye to the
 *     drop-to-zero transition before settling.
 * Plain map pins on react-native-maps can't be animated directly, so we
 * supply a custom child view to <Marker>.
 */
function AnimatedPin({
  color,
  change,
}: {
  color: string;
  change?: "opened" | "filled";
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (change === "opened") {
      pulse.setValue(0);
      const loop = Animated.loop(
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        }),
        { iterations: 4 },
      );
      loop.start();
      return () => loop.stop();
    }
    if (change === "filled") {
      fade.setValue(1);
      Animated.timing(fade, {
        toValue: 0.35,
        duration: 1500,
        useNativeDriver: true,
      }).start();
      return;
    }
    fade.setValue(1);
  }, [change, pulse, fade]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });

  return (
    <View style={pinStyles.wrap}>
      {change === "opened" ? (
        <Animated.View
          style={[
            pinStyles.ring,
            { backgroundColor: color, transform: [{ scale: ringScale }], opacity: ringOpacity },
          ]}
        />
      ) : null}
      <Animated.View
        style={[pinStyles.dot, { backgroundColor: color, opacity: fade }]}
      />
      {change === "opened" ? (
        <View style={pinStyles.badge}>
          <Text style={pinStyles.badgeText}>NEW</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Cluster bubble that mirrors AnimatedPin's highlight behaviour at the
 * cluster level. When any member of the cluster has just opened a slot,
 * the bubble pulses a coloured ring and shows a "NEW" badge. When every
 * member has just dropped to zero open slots, the bubble fades to a faint
 * grey to draw the eye to the transition the same way single pins do.
 */
function AnimatedClusterBubble({
  count,
  change,
}: {
  count: number;
  change?: "opened" | "filled";
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (change === "opened") {
      pulse.setValue(0);
      const loop = Animated.loop(
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        }),
        { iterations: 4 },
      );
      loop.start();
      return () => loop.stop();
    }
    if (change === "filled") {
      fade.setValue(1);
      Animated.timing(fade, {
        toValue: 0.35,
        duration: 1500,
        useNativeDriver: true,
      }).start();
      return;
    }
    fade.setValue(1);
  }, [change, pulse, fade]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });

  return (
    <View style={pinStyles.clusterWrap}>
      {change === "opened" ? (
        <Animated.View
          style={[
            pinStyles.clusterRing,
            { transform: [{ scale: ringScale }], opacity: ringOpacity },
          ]}
        />
      ) : null}
      <Animated.View
        style={[
          styles.clusterBubble,
          // Match the per-pin "filled" treatment from Task #682: the
          // bubble switches to a faint grey base (not just dimmed gold)
          // so the drop-to-zero transition reads at a glance.
          change === "filled" ? { backgroundColor: "#888" } : null,
          { opacity: fade },
        ]}
      >
        <Text
          style={[
            styles.clusterBubbleText,
            change === "filled" ? { color: "#fff" } : null,
          ]}
        >
          {count}
        </Text>
      </Animated.View>
      {change === "opened" ? (
        <View style={pinStyles.clusterBadge}>
          <Text style={pinStyles.badgeText}>NEW</Text>
        </View>
      ) : null}
    </View>
  );
}

const pinStyles = StyleSheet.create({
  wrap: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  ring: {
    position: "absolute",
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  badge: {
    position: "absolute",
    top: 0,
    right: 2,
    backgroundColor: "#fff",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 6,
  },
  badgeText: { fontSize: 8, fontWeight: "700", color: "#1f7a3a", letterSpacing: 0.5 },
  clusterWrap: { alignItems: "center", justifyContent: "center", padding: 6 },
  clusterRing: {
    position: "absolute",
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: GOLD,
  },
  clusterBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    backgroundColor: "#fff",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 6,
  },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors?.background ?? "#0e0e0e" },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: "#181818",
    borderBottomWidth: 1, borderBottomColor: "#222",
  },
  headerTitle: { color: "#fff", fontSize: 17, fontWeight: "600" },
  filterRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 8, alignItems: "center" },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: "#333", marginRight: 8 },
  chipActive: { backgroundColor: GOLD, borderColor: GOLD },
  chipText: { color: "#bbb", fontSize: 13 },
  chipTextActive: { color: "#000", fontWeight: "600" },
  toolbar: { flexDirection: "row", paddingHorizontal: 12, paddingBottom: 8, gap: 6, alignItems: "center" },
  input: { backgroundColor: "#1c1c1c", color: "#fff", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, fontSize: 14 },
  sortChip: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: "#333" },
  sortChipActive: { borderColor: GOLD },
  sortChipText: { color: "#bbb", fontSize: 12 },
  sortChipTextActive: { color: GOLD, fontWeight: "600" },
  card: { backgroundColor: "#1a1a1a", borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "#262626" },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", marginBottom: 10 },
  club: { color: "#fff", fontSize: 16, fontWeight: "600" },
  course: { color: "#bbb", fontSize: 13, marginTop: 2 },
  addr: { color: "#888", fontSize: 12, marginTop: 4 },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  badgeSurge: { backgroundColor: "#7c2d12" },
  badgeOff: { backgroundColor: "#1e3a5f" },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  cardBody: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  time: { color: GOLD, fontSize: 15, fontWeight: "600" },
  subtext: { color: "#999", fontSize: 12, marginTop: 4 },
  price: { color: "#fff", fontSize: 18, fontWeight: "700" },
  markup: { color: "#888", fontSize: 10, marginTop: 2 },
  empty: { color: "#888", textAlign: "center", marginTop: 32 },
  errorText: { color: "#f88", textAlign: "center", marginTop: 32, paddingHorizontal: 24 },
  savedPanel: { flex: 1 },
  sectionTitle: { color: "#fff", fontSize: 16, fontWeight: "600", marginBottom: 12 },
  savedComposer: { flexDirection: "row", gap: 8, marginBottom: 16 },
  saveBtn: { backgroundColor: GOLD, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, justifyContent: "center" },
  saveBtnText: { color: "#000", fontWeight: "600" },
  savedRow: { flexDirection: "row", alignItems: "center", padding: 12, backgroundColor: "#1a1a1a", borderRadius: 10, marginBottom: 8 },
  savedCard: { backgroundColor: "#1a1a1a", borderRadius: 10, marginBottom: 8, borderWidth: 1, borderColor: "#262626" },
  savedRowHeader: { flexDirection: "row", alignItems: "center", padding: 12, gap: 8 },
  savedName: { color: "#fff", fontSize: 14, fontWeight: "500" },
  savedMeta: { color: "#999", fontSize: 11, marginTop: 2 },
  savedDetail: { paddingHorizontal: 12, paddingBottom: 12, gap: 8, borderTopWidth: 1, borderTopColor: "#262626", paddingTop: 12 },
  savedDetailRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  savedDetailLabel: { color: "#bbb", fontSize: 12, fontWeight: "600", marginTop: 4 },
  savedChoiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  smallChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: "#333", backgroundColor: "#0e0e0e" },
  smallChipActive: { backgroundColor: GOLD, borderColor: GOLD },
  smallChipText: { color: "#bbb", fontSize: 11 },
  smallChipTextActive: { color: "#000", fontWeight: "600" },
  hourScrollRow: { gap: 6, paddingVertical: 4 },
  hourChip: {
    minWidth: 44, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 14,
    borderWidth: 1, borderColor: "#333", backgroundColor: "#0e0e0e",
    alignItems: "center", marginRight: 6,
  },
  hourChipActive: { backgroundColor: GOLD, borderColor: GOLD },
  hourChipText: { color: "#bbb", fontSize: 11 },
  hourChipTextActive: { color: "#000", fontWeight: "700" },
  tzBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
    borderWidth: 1, borderColor: "#333", backgroundColor: "#0e0e0e",
  },
  tzBtnText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  toggleBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: "#333" },
  toggleBtnOn: { backgroundColor: GOLD, borderColor: GOLD },
  toggleBtnText: { color: "#bbb", fontSize: 12, fontWeight: "600" },
  toggleBtnTextOn: { color: "#000" },
  savedHint: { color: "#777", fontSize: 10, marginTop: 4, fontStyle: "italic" },
  modeToggle: { flexDirection: "row", paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  modeBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: "#333",
  },
  modeBtnActive: { backgroundColor: GOLD, borderColor: GOLD },
  modeBtnText: { color: "#bbb", fontSize: 13 },
  modeBtnTextActive: { color: "#000", fontWeight: "600" },
  mapWrap: { height: 280, marginHorizontal: 12, marginTop: 10, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: "#262626" },
  map: { flex: 1 },
  mapFallback: {
    height: 200, marginHorizontal: 12, marginTop: 10, borderRadius: 12,
    borderWidth: 1, borderColor: "#262626", backgroundColor: "#1a1a1a",
    alignItems: "center", justifyContent: "center", gap: 12,
  },
  selectedClubBar: {
    flexDirection: "row", alignItems: "center", marginHorizontal: 12, marginTop: 10,
    paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#1a1a1a",
    borderRadius: 10, borderWidth: 1, borderColor: GOLD,
  },
  selectedClubName: { color: "#fff", fontSize: 14, fontWeight: "600" },
  selectedClubMeta: { color: "#999", fontSize: 12, marginTop: 2 },
  clearLink: { color: GOLD, fontSize: 13, fontWeight: "600" },
  clusterBubble: {
    minWidth: 36, height: 36, paddingHorizontal: 8, borderRadius: 18,
    backgroundColor: GOLD, borderWidth: 2, borderColor: "#fff",
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  clusterBubbleText: { color: "#000", fontWeight: "700", fontSize: 13 },
  sheetBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#181818", borderTopLeftRadius: 16, borderTopRightRadius: 16,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24,
    borderTopWidth: 1, borderColor: "#262626",
  },
  sheetHandle: {
    alignSelf: "center", width: 40, height: 4, borderRadius: 2,
    backgroundColor: "#444", marginBottom: 12,
  },
  sheetHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginBottom: 8,
  },
  sheetTitle: { color: "#fff", fontSize: 15, fontWeight: "600" },
  sheetRow: {
    flexDirection: "row", alignItems: "center", paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: "#222",
  },
  sheetRowName: { color: "#fff", fontSize: 14, fontWeight: "500" },
  sheetRowMeta: { color: "#999", fontSize: 12, marginTop: 3 },
  sheetMapWrap: {
    height: 140, borderRadius: 12, overflow: "hidden",
    marginBottom: 10, borderWidth: 1, borderColor: "#262626",
    backgroundColor: "#0e0e0e",
  },
  sheetMap: { flex: 1 },
  sheetPin: {
    backgroundColor: GOLD, borderRadius: 10, paddingHorizontal: 8,
    paddingVertical: 3, maxWidth: 140,
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  sheetPinText: { color: "#000", fontSize: 11, fontWeight: "700" },
});
