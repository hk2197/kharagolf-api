import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Modal,
  RefreshControl,
  TextInput,
  FlatList,
  Linking,
  Platform,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";
import { getLocale } from "@/i18n";
import { useTranslation } from "react-i18next";
import { PriceWithFx, fmtMoney } from "@/components/PriceWithFx";
import { useHighlightFlash } from "@/hooks/use-highlight";
// react-native-razorpay requires a native build — dynamic import to prevent crashes in Expo Go.
type RazorpayOptions = { key: string; amount: number; currency: string; order_id: string; name: string; description: string };
type RazorpaySuccess = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };
type RazorpayCheckoutType = { open: (opts: RazorpayOptions) => Promise<RazorpaySuccess> };
let RazorpayCheckout: RazorpayCheckoutType | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RazorpayCheckout = require("react-native-razorpay").default;
} catch { RazorpayCheckout = null; }

const GOLD = "#C9A84C";

interface TeeSlot {
  id: number;
  slotTime: string;
  slotDate: string;
  capacity: number;
  status: string;
  bookedCount: number;
  available: number;
  isMembersOnly: boolean;
  courseName: string | null;
  courseId: number;
  effectivePrice: number | null;
  basePrice: number | null;
  dealBadge: string | null;
  tierName: string | null;
  pricingBreakdown?: Array<{ source: string; label: string; before: number; after: number }>;
}

interface CaddieOption {
  id: number;
  name: string;
  experienceLevel: string;
  feePerRound: string;
  currency: string;
  averageRating: string | null;
  isAvailableToday: boolean;
  isBusy: boolean;
}

interface TeePricing {
  memberRate: string | null;
  guestRate: string | null;
  paymentModel: string;
  cancellationCutoffHours: number;
  maxGuestsPerBooking: number;
  baseCurrency?: string;
}

interface MyBookingWindow {
  tier: string;
  daysAhead: number | null;
}

interface SlotConstraint {
  id: number;
  name: string;
  courseId: number | null;
  minPlayers: number;
  maxPlayers: number;
  startTime: string | null;
  endTime: string | null;
  membershipTier: string | null;
}

interface MemberResult {
  id: number;
  displayName: string | null;
  username: string | null;
  email: string | null;
  memberNumber: string | null;
}

interface AddedMember { id: number; name: string; }
interface AddedGuest { name: string; email: string; }

interface Booking {
  booking: {
    id: number;
    slotId: number;
    status: string;
    partySize: number;
    totalAmount: string | null;
    createdAt: string;
  };
  slotDate: string | null;
  slotTime: string | null;
  courseName: string | null;
}

function formatDate(d: Date) { return d.toISOString().split("T")[0]; }
function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

export default function TeeBookingsScreen() {
  const { t } = useTranslation("teeBookings");
  const { token, user } = useAuth();
  const { activeClub } = useActiveClub();
  const orgId = activeClub?.id;
  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : "";

  const today = new Date();
  const [selectedDate, setSelectedDate] = useState(formatDate(today));
  const [slots, setSlots] = useState<TeeSlot[]>([]);
  const [pricing, setPricing] = useState<TeePricing | null>(null);
  const [myBookings, setMyBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const params = useLocalSearchParams<{ bookingId?: string }>();
  const { highlightId } = useHighlightFlash(params.bookingId);
  const [showSlots, setShowSlots] = useState(highlightId == null);
  useEffect(() => {
    if (highlightId != null) setShowSlots(false);
  }, [highlightId]);
  const [myBookingWindow, setMyBookingWindow] = useState<MyBookingWindow | null>(null);
  const [slotConstraints, setSlotConstraints] = useState<SlotConstraint[]>([]);
  // null until the pricing endpoint returns baseCurrency; PriceWithFx is only
  // rendered once we know the club's authoritative base currency to avoid
  // misquoting against a default like INR.
  const [clubCurrency, setClubCurrency] = useState<string | null>(null);

  // Booking flow state
  const [partySize, setPartySize] = useState(1);  // selected before slot pick
  const [confirmSlot, setConfirmSlot] = useState<TeeSlot | null>(null);
  const [booking, setBooking] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberResults, setMemberResults] = useState<MemberResult[]>([]);
  const [addedMembers, setAddedMembers] = useState<AddedMember[]>([]);
  const [addedGuests, setAddedGuests] = useState<AddedGuest[]>([]);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");

  // Caddie request
  const [caddies, setCaddies] = useState<CaddieOption[]>([]);
  const [selectedCaddieId, setSelectedCaddieId] = useState<number | null>(null);
  const [caddieNotes, setCaddieNotes] = useState("");

  // Pricing breakdown expand/collapse
  const [showPricingBreakdown, setShowPricingBreakdown] = useState(false);

  // Reset cached club currency when the active org changes, so we never
  // render FX quotes against a stale base currency from a previously
  // selected club.
  useEffect(() => { setClubCurrency(null); }, [orgId]);

  async function load() {
    if (!orgId || !token) return;
    try {
      const [slotsRes, myRes, pricingRes, windowRes] = await Promise.all([
        fetch(`${baseUrl}/api/organizations/${orgId}/tee-bookings/slots?date=${selectedDate}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${baseUrl}/api/organizations/${orgId}/tee-bookings/my`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${baseUrl}/api/organizations/${orgId}/tee-bookings/pricing`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${baseUrl}/api/organizations/${orgId}/tee-bookings/booking-window/me`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      let loadedSlots: TeeSlot[] = [];
      if (slotsRes.ok) { loadedSlots = await slotsRes.json(); setSlots(loadedSlots); }
      if (myRes.ok) setMyBookings(await myRes.json());
      if (pricingRes.ok) {
        const p: TeePricing = await pricingRes.json();
        setPricing(p);
        // Drop any previously cached currency if the response no longer
        // includes one — better to fall back to plain rendering than to
        // quote against a stale value.
        setClubCurrency(p?.baseCurrency ? String(p.baseCurrency).toUpperCase() : null);
      } else {
        setClubCurrency(null);
      }
      if (windowRes.ok) setMyBookingWindow(await windowRes.json());

      // Fetch all player count constraints for the org on this date (no courseId filter).
      // The API returns all rules (org-wide + course-specific); the display function
      // filters them per slot's courseId to avoid cross-course mismatches.
      const constraintsRes = await fetch(
        `${baseUrl}/api/organizations/${orgId}/tee-bookings/slot-constraints?date=${selectedDate}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (constraintsRes.ok) setSlotConstraints(await constraintsRes.json());
    } catch { /* ignore */ } finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => { load(); }, [orgId, token, selectedDate]);
  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [orgId, token, selectedDate]);

  async function searchMembers(q: string) {
    if (!orgId || !token || q.length < 2) { setMemberResults([]); return; }
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tee-bookings/members/search?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMemberResults(await res.json());
    } catch { /* noop */ }
  }

  function resetBookingDialog() {
    setConfirmSlot(null);
    setAddedMembers([]);
    setAddedGuests([]);
    setMemberSearch("");
    setMemberResults([]);
    setGuestName("");
    setGuestEmail("");
    setSelectedCaddieId(null);
    setCaddieNotes("");
    setCaddies([]);
    setShowPricingBreakdown(false);
  }

  async function loadCaddies(date: string) {
    if (!orgId || !token) return;
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/caddies/available?date=${date}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setCaddies(data.caddies ?? []);
      }
    } catch { /* ignore */ }
  }

  async function bookSlot() {
    if (!confirmSlot || !orgId || !token) return;
    setBooking(true);
    try {
      const memberPlayers = addedMembers.map(m => ({ type: "member", userId: m.id }));
      const guestPlayers = addedGuests.map(g => ({ type: "guest", guestName: g.name, guestEmail: g.email || undefined }));
      const players = [...memberPlayers, ...guestPlayers];
      // partySize was selected by the user before choosing the slot; extra players beyond
      // that count are trimmed so the submission always matches the selected group size.
      const trimmedPlayers = players.slice(0, partySize - 1);

      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tee-bookings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ slotId: confirmSlot.id, partySize, players: trimmedPlayers }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert(t("bookFailedTitle"), err.error ?? t("bookFailedMessage"));
        return;
      }
      const newBooking = await res.json();

      // Payment handling — for online/prepaid, always request the payment order from the server.
      // The server computes the authoritative total from all player fee rows (member + guests).
      // We check orderData.amount to decide whether Razorpay is needed (may be 0 for free bookings).
      const isOnline = pricing?.paymentModel === "online" || pricing?.paymentModel === "prepaid";
      if (isOnline) {
        const orderRes = await fetch(`${baseUrl}/api/organizations/${orgId}/tee-bookings/${newBooking.id}/payment-order`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
        if (orderRes.ok) {
          const orderData = await orderRes.json();
          if (orderData.amount > 0) {
            if (!RazorpayCheckout) {
              const webDomain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
              const paymentUrl = webDomain
                ? `https://${webDomain}/tee-bookings?order=${orderData.orderId}`
                : null;
              Alert.alert(
                t("paymentUnavailableTitle"),
                t("paymentUnavailableMessage"),
                [
                  { text: t("payInBrowser"), onPress: () => { if (paymentUrl) Linking.openURL(paymentUrl); } },
                  {
                    text: t("payAtClub"),
                    onPress: () => {
                      resetBookingDialog();
                      load();
                    },
                  },
                ]
              );
              return;
            }
            try {
              const paymentRes = await RazorpayCheckout.open({
                key: orderData.keyId,
                amount: orderData.amount,
                currency: "INR",
                order_id: orderData.orderId,
                name: activeClub?.name ?? "Golf Club",
                description: `Tee time — ${confirmSlot.slotTime} on ${selectedDate}`,
              });
              const verifyRes = await fetch(`${baseUrl}/api/organizations/${orgId}/tee-bookings/${newBooking.id}/verify-payment`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  razorpayPaymentId: paymentRes.razorpay_payment_id,
                  razorpayOrderId: paymentRes.razorpay_order_id,
                  razorpaySignature: paymentRes.razorpay_signature,
                }),
              });
              if (verifyRes.ok) {
                Alert.alert(t("paySuccessTitle"), t("paySuccessMessage", { time: confirmSlot.slotTime, date: selectedDate }));
              } else {
                const errBody = await verifyRes.json().catch(() => ({}));
                Alert.alert(t("payVerifyFailTitle"), errBody.error ?? t("payVerifyFailMessage"));
              }
            } catch {
              Alert.alert(t("payHeldTitle"), t("payHeldMessage"));
            }
            resetBookingDialog();
            load();
            return;
          }
          // amount=0 — free booking, fall through to success alert
        } else {
          // payment-order API failed — booking is held pending, not confirmed
          const orderErr = await orderRes.json().catch(() => ({}));
          Alert.alert(
            t("payNotStartedTitle"),
            orderErr.error ?? t("payNotStartedMessage")
          );
          resetBookingDialog();
          load();
          return;
        }
      }

      // If a caddie was requested, submit the request
      if (selectedCaddieId && newBooking?.id) {
        try {
          await fetch(`${baseUrl}/api/organizations/${orgId}/tee-bookings/${newBooking.id}/caddie-request`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ caddieId: selectedCaddieId, notes: caddieNotes || undefined }),
          });
        } catch { /* caddie request failed silently */ }
      }

      // Pay-at-checkin or genuinely free prepaid — booking complete
      Alert.alert(t("bookSuccessTitle"), t("bookSuccessMessage", { time: confirmSlot.slotTime, date: selectedDate }));
      resetBookingDialog();
      load();
    } finally { setBooking(false); }
  }

  async function performCancel(bookingId: number) {
    const res = await fetch(`${baseUrl}/api/portal/tee-bookings/${bookingId}/cancel-and-promote`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "user_cancelled" }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      load();
      const promoted = data?.promotion?.promoted;
      if (promoted) {
        Alert.alert(
          t("cancelledTitle"),
          `Your slot was given to a player on the waitlist.`,
        );
      } else {
        Alert.alert(t("cancelledTitle"));
      }
    } else {
      const err = await res.json().catch(() => ({}));
      Alert.alert(t("cancelFailTitle"), err.error ?? t("cancelFailMessage"));
    }
  }

  async function cancelBooking(bookingId: number) {
    // react-native-web's Alert.alert is a no-op stub, so the destructive
    // callback never fires in the web preview. Use window.confirm there
    // (which Playwright/test harnesses can accept) and Alert.alert on
    // native where the buttoned dialog actually renders.
    if (Platform.OS === "web") {
      const ok = typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(`${t("cancelTitle")}\n\n${t("cancelMessage")}`)
        : true;
      if (!ok) return;
      await performCancel(bookingId);
      return;
    }
    Alert.alert(t("cancelTitle"), t("cancelMessage"), [
      { text: t("keepBtn"), style: "cancel" },
      {
        text: t("cancelConfirm"), style: "destructive", onPress: () => { void performCancel(bookingId); },
      },
    ]);
  }

  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));

  // Booking window from server (tier-resolved for this user)
  const maxBookAheadDays = myBookingWindow?.daysAhead ?? null;

  function isDateOutOfWindow(dateStr: string) {
    if (maxBookAheadDays == null) return false;
    const diff = Math.round((new Date(dateStr).getTime() - today.getTime()) / 86400000);
    return diff > maxBookAheadDays;
  }

  /** Returns the most restrictive player count constraint label for a given slot time and course */
  function getSlotConstraintLabel(slotTime: string, slotCourseId: number): string | null {
    const constraints = slotConstraints.filter(c => {
      // Only apply org-wide rules (courseId null) or rules for this specific course
      if (c.courseId !== null && c.courseId !== slotCourseId) return false;
      if (!c.startTime || !c.endTime) return true;
      return slotTime >= c.startTime && slotTime < c.endTime;
    });
    if (constraints.length === 0) return null;
    const parts: string[] = [];
    const minMax = constraints.reduce(
      (acc, c) => ({ min: Math.max(acc.min, c.minPlayers), max: Math.min(acc.max, c.maxPlayers) }),
      { min: 1, max: 4 },
    );
    if (minMax.min > 1) parts.push(`min ${minMax.min}`);
    if (minMax.max < 4) parts.push(`max ${minMax.max}`);
    return parts.length > 0 ? parts.join(", ") + " players" : null;
  }

  const availableSlots = slots.filter(s => s.status !== "blocked" && s.available >= partySize);
  const insufficientOrFull = slots.filter(s => s.status === "blocked" || s.available < partySize);
  const memberRate = pricing?.memberRate ? Number(pricing.memberRate) : null;
  const guestRate = pricing?.guestRate ? Number(pricing.guestRate) : null;
  const maxGuests = pricing?.maxGuestsPerBooking ?? 3;

  const estimatedTotal = confirmSlot
    ? (memberRate ?? 0) * (1 + addedMembers.length) + (guestRate ?? 0) * addedGuests.length
    : 0;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 4 }}>
          <Feather name="chevron-left" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t("title")}</Text>
      </View>

      {activeClub && (
        <View style={styles.clubBanner}>
          <Feather name="map-pin" size={13} color={GOLD} />
          <Text style={styles.clubBannerText}>{activeClub.name}</Text>
        </View>
      )}

      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tab, showSlots && styles.tabActive]}
          onPress={() => setShowSlots(true)}
          testID="tee-bookings-tab-book"
        >
          <Text style={[styles.tabText, showSlots && styles.tabTextActive]}>{t("tabBook")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, !showSlots && styles.tabActive]}
          onPress={() => setShowSlots(false)}
          testID="tee-bookings-tab-mine"
        >
          <Text style={[styles.tabText, !showSlots && styles.tabTextActive]}>{t("tabMyBookings", { count: myBookings.length })}</Text>
        </TouchableOpacity>
      </View>

      {showSlots ? (
        <>
          {maxBookAheadDays != null && (
            <View style={styles.windowBanner}>
              <Feather name="clock" size={12} color={GOLD} />
              <Text style={styles.windowBannerText}>
                {t("windowBanner", { days: maxBookAheadDays })}
              </Text>
            </View>
          )}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dateScroll} contentContainerStyle={styles.dateScrollContent}>
            {days.map(d => {
              const ds = formatDate(d);
              const isSelected = ds === selectedDate;
              const outOfWindow = isDateOutOfWindow(ds);
              return (
                <TouchableOpacity
                  key={ds}
                  style={[styles.dateChip, isSelected && styles.dateChipActive, outOfWindow && styles.dateChipDisabled]}
                  onPress={() => {
                    if (outOfWindow) {
                      Alert.alert(t("outsideWindowTitle"), t("outsideWindowMessage", { days: maxBookAheadDays }));
                    } else {
                      setSelectedDate(ds);
                    }
                  }}
                >
                  <Text style={[styles.dateDayName, isSelected && { color: "#000" }, outOfWindow && { color: Colors.muted }]}>{d.toLocaleDateString(getLocale(), { weekday: "short" })}</Text>
                  <Text style={[styles.dateDayNum, isSelected && { color: "#000" }, outOfWindow && { color: Colors.muted }]}>{d.getDate()}</Text>
                  {outOfWindow && <Text style={{ fontSize: 8, color: Colors.muted }}>{t("locked")}</Text>}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Party size selector — must be chosen before viewing available slots */}
          <View style={styles.partySizeRow}>
            <Text style={styles.partySizeLabel}>{t("partySize")}:</Text>
            {[1, 2, 3, 4].map(n => (
              <TouchableOpacity
                key={n}
                style={[styles.partySizeBtn, partySize === n && styles.partySizeBtnActive]}
                onPress={() => setPartySize(n)}
              >
                <Text style={[styles.partySizeBtnText, partySize === n && styles.partySizeBtnTextActive]}>{n}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <ScrollView style={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}>
            {loading ? (
              <LoadingSpinner color={GOLD} style={{ marginTop: 40 }} />
            ) : availableSlots.length === 0 && insufficientOrFull.length === 0 ? (
              <View style={styles.empty}>
                <Feather name="calendar" size={32} color={Colors.muted} />
                <Text style={styles.emptyText}>{t("noSlots")}</Text>
              </View>
            ) : (
              <>
                <Text style={styles.sectionLabel}>{t("selectSlot")}</Text>
                {availableSlots.length === 0 ? (
                  <View style={styles.empty}>
                    <Text style={styles.emptyText}>No slots with {partySize} spots available — try fewer players</Text>
                  </View>
                ) : availableSlots.map(slot => (
                  <TouchableOpacity key={slot.id} style={styles.slotCard} onPress={() => { setConfirmSlot(slot); setAddedMembers([]); setAddedGuests([]); loadCaddies(slot.slotDate); }}>
                    <View style={styles.slotLeft}>
                      <Text style={styles.slotTime}>{slot.slotTime ?? "--:--"}</Text>
                      {slot.courseName && <Text style={styles.slotCourse}>{slot.courseName}</Text>}
                      {slot.isMembersOnly && <Text style={styles.membersOnlyBadge}>{t("membersOnly")}</Text>}
                      {slot.slotTime && (() => {
                        const label = getSlotConstraintLabel(slot.slotTime, slot.courseId);
                        return label ? <Text style={styles.constraintBadge}>{label}</Text> : null;
                      })()}
                    </View>
                    <View style={styles.slotRight}>
                      <Text style={styles.slotSpots}>{t("spots", { count: slot.available })}</Text>
                      {slot.dealBadge && (
                        <View style={styles.dealBadge}>
                          <Text style={styles.dealBadgeText}>{slot.dealBadge}</Text>
                        </View>
                      )}
                      {slot.effectivePrice != null ? (
                        <View style={styles.priceRow}>
                          {clubCurrency ? (
                            <PriceWithFx
                              orgId={orgId}
                              token={token}
                              amount={slot.effectivePrice}
                              currency={clubCurrency}
                              productClass="tee_time"
                              bookedStyle={styles.slotPriceEffective}
                              showDisclosure={false}
                              disclosureOnHover
                            />
                          ) : (
                            <Text style={styles.slotPriceEffective}>
                              {fmtMoney(slot.effectivePrice, clubCurrency ?? "INR")}
                            </Text>
                          )}
                          {slot.basePrice != null && slot.basePrice !== slot.effectivePrice && (
                            <Text style={styles.slotPriceStrike}>
                              {fmtMoney(slot.basePrice, clubCurrency ?? "INR")}
                            </Text>
                          )}
                        </View>
                      ) : memberRate != null && memberRate > 0 ? (
                        clubCurrency ? (
                          <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                            <PriceWithFx
                              orgId={orgId}
                              token={token}
                              amount={memberRate}
                              currency={clubCurrency}
                              productClass="tee_time"
                              bookedStyle={styles.slotPrice}
                              showDisclosure={false}
                              disclosureOnHover
                            />
                            <Text style={styles.slotPrice}>/member</Text>
                          </View>
                        ) : (
                          <Text style={styles.slotPrice}>{fmtMoney(memberRate, "INR")}/member</Text>
                        )
                      ) : null}
                      {slot.tierName && (
                        <Text style={styles.slotTierName}>{slot.tierName}</Text>
                      )}
                    </View>
                    <View style={styles.bookBtn}><Text style={styles.bookBtnText}>{t("confirmBooking")}</Text></View>
                  </TouchableOpacity>
                ))}
                {insufficientOrFull.length > 0 && (
                  <>
                    <Text style={[styles.sectionLabel, { marginTop: 12 }]}>Fully Booked / No Space for {partySize}</Text>
                    {insufficientOrFull.map(slot => (
                      <View key={slot.id} style={[styles.slotCard, { opacity: 0.5 }]}>
                        <View style={styles.slotLeft}>
                          <Text style={styles.slotTime}>{slot.slotTime ?? "--:--"}</Text>
                          {slot.courseName && <Text style={styles.slotCourse}>{slot.courseName}</Text>}
                        </View>
                        <View style={[styles.bookBtn, { backgroundColor: Colors.border }]}>
                          <Text style={[styles.bookBtnText, { color: Colors.muted }]}>
                            {slot.available <= 0 ? "Full" : `${slot.available} spot${slot.available !== 1 ? "s" : ""}`}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </>
                )}
              </>
            )}
          </ScrollView>
        </>
      ) : (
        <ScrollView style={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}>
          {loading ? (
            <LoadingSpinner color={GOLD} style={{ marginTop: 40 }} />
          ) : myBookings.length === 0 ? (
            <View style={styles.empty}>
              <Feather name="calendar" size={32} color={Colors.muted} />
              <Text style={styles.emptyText}>{t("noBookings")}</Text>
              <TouchableOpacity style={styles.emptyBtn} onPress={() => setShowSlots(true)}>
                <Text style={styles.emptyBtnText}>{t("tabBook")}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            myBookings.map(({ booking: b, slotDate, slotTime, courseName }) => {
              const upcoming = slotDate ? new Date(slotDate) >= today : false;
              const isHighlight = highlightId === b.id;
              return (
                <View
                  key={b.id}
                  style={[styles.bookingCard, isHighlight && styles.bookingCardHighlight]}
                  testID={`tee-booking-${b.id}`}
                >
                  <View style={styles.bookingLeft}>
                    <Text style={styles.bookingDate}>
                      {slotDate ? new Date(slotDate).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" }) : "—"}
                    </Text>
                    <Text style={styles.bookingTime}>{slotTime ?? "—"}</Text>
                    {courseName && <Text style={styles.bookingCourse}>{courseName}</Text>}
                    <Text style={styles.bookingPlayers}>{b.partySize} player{b.partySize !== 1 ? "s" : ""}</Text>
                    <Text
                      style={[styles.bookingStatus, {
                        color: b.status === "confirmed" ? "#22c55e" : b.status === "cancelled" ? Colors.error : GOLD,
                      }]}
                      testID={`tee-booking-status-${b.id}`}
                    >
                      {b.status.charAt(0).toUpperCase() + b.status.slice(1)}
                    </Text>
                  </View>
                  {b.status === "confirmed" && upcoming && (
                    <TouchableOpacity
                      style={styles.cancelBtn}
                      onPress={() => cancelBooking(b.id)}
                      testID={`tee-booking-cancel-${b.id}`}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel booking"
                    >
                      <Text style={styles.cancelBtnText}>Cancel</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })
          )}
        </ScrollView>
      )}

      {/* Booking Modal */}
      <Modal visible={!!confirmSlot} transparent animationType="slide" onRequestClose={resetBookingDialog}>
        <View style={styles.modalBg}>
          <ScrollView style={styles.modal} contentContainerStyle={{ paddingBottom: 32 }}>
            {confirmSlot && (
              <>
                <Text style={styles.modalTitle}>{t("title")} — {confirmSlot.slotTime}</Text>
                <Text style={{ color: Colors.muted, fontSize: 13, marginBottom: 8 }}>
                  {t(partySize - 1 !== 1 ? "groupInfo_other" : "groupInfo", { size: partySize, extra: partySize - 1 })}
                </Text>

                {/* Slot details */}
                <View style={styles.modalDetailRow}>
                  <Text style={styles.modalLabel}>{t("common:date", "Date")}</Text>
                  <Text style={styles.modalValue}>{selectedDate}</Text>
                </View>
                {confirmSlot.courseName && (
                  <View style={styles.modalDetailRow}>
                    <Text style={styles.modalLabel}>{t("common:course", "Course")}</Text>
                    <Text style={styles.modalValue}>{confirmSlot.courseName}</Text>
                  </View>
                )}
                <View style={styles.modalDetailRow}>
                  <Text style={styles.modalLabel}>{t("spots", { count: confirmSlot.available })}</Text>
                  <Text style={styles.modalValue}>{confirmSlot.available} / {confirmSlot.capacity}</Text>
                </View>
                {(confirmSlot.tierName || confirmSlot.dealBadge || confirmSlot.effectivePrice != null) && (
                  <View style={styles.tierBox}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {confirmSlot.tierName && (
                        <Text style={styles.tierBoxName}>{confirmSlot.tierName}</Text>
                      )}
                      {confirmSlot.dealBadge && (
                        <View style={styles.dealBadge}>
                          <Text style={styles.dealBadgeText}>{confirmSlot.dealBadge}</Text>
                        </View>
                      )}
                    </View>
                    {confirmSlot.effectivePrice != null && (
                      <View style={styles.priceRow}>
                        {clubCurrency ? (
                          <PriceWithFx
                            orgId={orgId}
                            token={token}
                            amount={confirmSlot.effectivePrice}
                            currency={clubCurrency}
                            productClass="tee_time"
                            bookedStyle={styles.tierBoxPrice}
                            showDisclosure={false}
                            disclosureOnHover
                          />
                        ) : (
                          <Text style={styles.tierBoxPrice}>
                            {fmtMoney(confirmSlot.effectivePrice, clubCurrency ?? "INR")}
                          </Text>
                        )}
                        {confirmSlot.basePrice != null && confirmSlot.basePrice !== confirmSlot.effectivePrice && (
                          <Text style={styles.slotPriceStrike}>
                            {fmtMoney(confirmSlot.basePrice, clubCurrency ?? "INR")}
                          </Text>
                        )}
                      </View>
                    )}
                    {confirmSlot.tierName && (
                      <Text style={styles.tierBoxReason}>{confirmSlot.tierName} pricing in effect</Text>
                    )}
                    {confirmSlot.pricingBreakdown && confirmSlot.pricingBreakdown.length > 0 && (
                      <>
                        <TouchableOpacity
                          style={styles.breakdownToggle}
                          onPress={() => setShowPricingBreakdown(v => !v)}
                        >
                          <Feather
                            name={showPricingBreakdown ? "chevron-up" : "chevron-down"}
                            size={14}
                            color={GOLD}
                          />
                          <Text style={styles.breakdownToggleText}>
                            {showPricingBreakdown ? "Hide" : "Show"} pricing breakdown ({confirmSlot.pricingBreakdown.length})
                          </Text>
                        </TouchableOpacity>
                        {showPricingBreakdown && (
                          <View style={styles.breakdownList}>
                            {confirmSlot.pricingBreakdown.map((step, idx) => {
                              const delta = step.after - step.before;
                              const deltaStr = delta === 0
                                ? "no change"
                                : `${delta > 0 ? "+" : "−"}${fmtMoney(Math.abs(delta), clubCurrency ?? "INR")}`;
                              const deltaColor = delta < 0 ? "#86efac" : delta > 0 ? "#f87171" : Colors.muted;
                              return (
                                <View key={idx} style={styles.breakdownRow}>
                                  <Text style={styles.breakdownLabel} numberOfLines={2}>{step.label}</Text>
                                  <View style={styles.breakdownAmountCol}>
                                    <Text style={[styles.breakdownDelta, { color: deltaColor }]}>{deltaStr}</Text>
                                    <Text style={styles.breakdownBeforeAfter}>
                                      {fmtMoney(step.before, clubCurrency ?? "INR")} → {fmtMoney(step.after, clubCurrency ?? "INR")}
                                    </Text>
                                  </View>
                                </View>
                              );
                            })}
                          </View>
                        )}
                      </>
                    )}
                  </View>
                )}

                {/* Add co-members */}
                <Text style={styles.sectionTitle}>{t("addMember")}</Text>
                <TextInput
                  style={styles.searchInput}
                  placeholder={t("searchPlaceholder")}
                  placeholderTextColor={Colors.muted}
                  value={memberSearch}
                  onChangeText={q => { setMemberSearch(q); searchMembers(q); }}
                />
                {memberResults.length > 0 && (
                  <FlatList
                    data={memberResults.filter(m => !addedMembers.find(a => a.id === m.id))}
                    keyExtractor={m => String(m.id)}
                    scrollEnabled={false}
                    renderItem={({ item: m }) => (
                      <TouchableOpacity style={styles.memberResultRow} onPress={() => {
                        setAddedMembers(prev => [...prev, { id: m.id, name: m.displayName ?? m.username ?? "Member" }]);
                        setMemberSearch(""); setMemberResults([]);
                      }}>
                        <Text style={styles.memberResultName}>{m.displayName ?? m.username}</Text>
                        {m.memberNumber && <Text style={styles.memberResultSub}>#{m.memberNumber}</Text>}
                      </TouchableOpacity>
                    )}
                  />
                )}
                {addedMembers.map(m => (
                  <View key={m.id} style={styles.chip}>
                    <Text style={styles.chipText}>{m.name}</Text>
                    <TouchableOpacity onPress={() => setAddedMembers(prev => prev.filter(a => a.id !== m.id))}>
                      <Feather name="x" size={12} color={Colors.muted} />
                    </TouchableOpacity>
                  </View>
                ))}

                {/* Guests — only for non-members-only slots */}
                {!confirmSlot.isMembersOnly && (
                  <>
                    <Text style={styles.sectionTitle}>Add a Guest (optional)</Text>
                    <View style={styles.guestRow}>
                      <TextInput
                        style={[styles.searchInput, { flex: 1, marginRight: 6 }]}
                        placeholder={t("guestName")}
                        placeholderTextColor={Colors.muted}
                        value={guestName}
                        onChangeText={setGuestName}
                      />
                      <TextInput
                        style={[styles.searchInput, { flex: 1 }]}
                        placeholder={t("guestEmail")}
                        placeholderTextColor={Colors.muted}
                        value={guestEmail}
                        onChangeText={setGuestEmail}
                        keyboardType="email-address"
                      />
                    </View>
                    <TouchableOpacity style={styles.addGuestBtn} onPress={() => {
                      if (!guestName.trim()) return;
                      if (addedGuests.length >= maxGuests) {
                        Alert.alert(`Max ${maxGuests} guest(s) allowed`); return;
                      }
                      setAddedGuests(prev => [...prev, { name: guestName.trim(), email: guestEmail.trim() }]);
                      setGuestName(""); setGuestEmail("");
                    }}>
                      <Text style={styles.addGuestBtnText}>+ {t("addGuest")}</Text>
                    </TouchableOpacity>
                    {addedGuests.map((g, i) => (
                      <View key={i} style={styles.chip}>
                        <Text style={styles.chipText}>{g.name}{g.email ? ` (${g.email})` : ""}</Text>
                        <TouchableOpacity onPress={() => setAddedGuests(prev => prev.filter((_, idx) => idx !== i))}>
                          <Feather name="x" size={12} color={Colors.muted} />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </>
                )}

                {/* Caddie Request */}
                {caddies.length > 0 && (
                  <>
                    <Text style={styles.sectionTitle}>Request a Caddie (optional)</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                      <TouchableOpacity
                        style={[styles.caddieChip, !selectedCaddieId && styles.caddieChipSelected]}
                        onPress={() => setSelectedCaddieId(null)}
                      >
                        <Text style={[styles.caddieChipText, !selectedCaddieId && { color: "#000" }]}>No Caddie</Text>
                      </TouchableOpacity>
                      {caddies.filter(c => c.isAvailableToday && !c.isBusy).map(c => {
                        const sel = selectedCaddieId === c.id;
                        const subStyle = [styles.caddieChipSub, sel && { color: "#000" }];
                        return (
                          <TouchableOpacity
                            key={c.id}
                            style={[styles.caddieChip, sel && styles.caddieChipSelected]}
                            onPress={() => setSelectedCaddieId(c.id)}
                          >
                            <Text style={[styles.caddieChipText, sel && { color: "#000" }]}>{c.name}</Text>
                            {orgId ? (
                              <PriceWithFx
                                orgId={orgId}
                                token={token}
                                amount={c.feePerRound}
                                currency={c.currency}
                                productClass="caddie_fee"
                                bookedStyle={subStyle}
                                disclosureStyle={subStyle}
                                showDisclosure={false}
                                disclosureOnHover
                              />
                            ) : (
                              <Text style={subStyle}>{fmtMoney(c.feePerRound, c.currency)}</Text>
                            )}
                            <Text style={subStyle}>{c.experienceLevel}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                    {selectedCaddieId && (
                      <TextInput
                        style={styles.searchInput}
                        placeholder={t("caddieNotes")}
                        placeholderTextColor={Colors.muted}
                        value={caddieNotes}
                        onChangeText={setCaddieNotes}
                      />
                    )}
                  </>
                )}

                {/* Pricing summary */}
                {memberRate != null && memberRate > 0 && (
                  <View style={styles.pricingBox}>
                    <View style={[styles.modalDetailRow, { alignItems: "flex-start" }]}>
                      <Text style={styles.modalLabel}>
                        {t("memberRate")} × {1 + addedMembers.length}
                      </Text>
                      <View style={{ alignItems: "flex-end", flexShrink: 1 }}>
                        {clubCurrency ? (
                          <PriceWithFx
                            orgId={orgId}
                            token={token}
                            amount={memberRate * (1 + addedMembers.length)}
                            currency={clubCurrency}
                            productClass="tee_time"
                            bookedStyle={styles.modalValue}
                            disclosureStyle={{ textAlign: "right" }}
                            showDisclosure={false}
                            disclosureOnHover
                          />
                        ) : (
                          <Text style={styles.modalValue}>
                            {fmtMoney(memberRate * (1 + addedMembers.length), clubCurrency ?? "INR")}
                          </Text>
                        )}
                      </View>
                    </View>
                    {addedGuests.length > 0 && guestRate != null && guestRate > 0 && (
                      <View style={[styles.modalDetailRow, { alignItems: "flex-start" }]}>
                        <Text style={styles.modalLabel}>
                          {t("guestRate")} × {addedGuests.length}
                        </Text>
                        <View style={{ alignItems: "flex-end", flexShrink: 1 }}>
                          {clubCurrency ? (
                            <PriceWithFx
                              orgId={orgId}
                              token={token}
                              amount={guestRate * addedGuests.length}
                              currency={clubCurrency}
                              productClass="tee_time"
                              bookedStyle={styles.modalValue}
                              disclosureStyle={{ textAlign: "right" }}
                              showDisclosure={false}
                              disclosureOnHover
                            />
                          ) : (
                            <Text style={styles.modalValue}>
                              {fmtMoney(guestRate * addedGuests.length, clubCurrency ?? "INR")}
                            </Text>
                          )}
                        </View>
                      </View>
                    )}
                    <View style={[styles.modalDetailRow, { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8, marginTop: 4, alignItems: "flex-start" }]}>
                      <Text style={[styles.modalLabel, { color: Colors.text, fontWeight: "600" }]}>{t("estimatedTotal")}</Text>
                      <View style={{ alignItems: "flex-end", flexShrink: 1 }}>
                        {clubCurrency ? (
                          <PriceWithFx
                            orgId={orgId}
                            token={token}
                            amount={estimatedTotal}
                            currency={clubCurrency}
                            productClass="tee_time"
                            bookedStyle={[styles.modalValue, { color: GOLD }]}
                            disclosureStyle={{ textAlign: "right" }}
                          />
                        ) : (
                          <Text style={[styles.modalValue, { color: GOLD }]}>
                            {fmtMoney(estimatedTotal, clubCurrency ?? "INR")}
                          </Text>
                        )}
                      </View>
                    </View>
                    <View style={styles.modalDetailRow}>
                      <Text style={styles.modalLabel}>{t("common:payment", "Payment")}</Text>
                      <Text style={styles.modalValue}>
                        {pricing?.paymentModel === "online" || pricing?.paymentModel === "prepaid"
                          ? t("payOnline")
                          : t("payAtCheckin")}
                      </Text>
                    </View>
                  </View>
                )}

                <View style={styles.modalActions}>
                  <TouchableOpacity style={styles.modalCancel} onPress={resetBookingDialog}>
                    <Text style={styles.modalCancelText}>{t("cancel")}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.modalConfirm, booking && { opacity: 0.6 }]} onPress={bookSlot} disabled={booking}>
                    <Text style={styles.modalConfirmText}>
                      {booking ? t("booking") : (pricing?.paymentModel === "online" || pricing?.paymentModel === "prepaid") && memberRate
                        ? t("bookAndPay")
                        : t("confirmBooking")}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  title: { flex: 1, fontSize: 20, fontWeight: "700", color: Colors.text },
  clubBanner: { flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 16, marginBottom: 8 },
  clubBannerText: { color: GOLD, fontSize: 13, fontWeight: "500" },
  tabRow: { flexDirection: "row", marginHorizontal: 16, backgroundColor: Colors.surface, borderRadius: 10, padding: 4, marginBottom: 8 },
  tab: { flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 8 },
  tabActive: { backgroundColor: GOLD },
  tabText: { color: Colors.muted, fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: "#000" },
  dateScroll: { maxHeight: 80 },
  dateScrollContent: { paddingHorizontal: 16, gap: 8, paddingVertical: 8 },
  dateChip: { width: 56, alignItems: "center", paddingVertical: 8, borderRadius: 10, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  dateChipActive: { backgroundColor: GOLD, borderColor: GOLD },
  dateChipDisabled: { opacity: 0.35 },
  windowBanner: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 6, backgroundColor: "rgba(201,168,76,0.1)" },
  windowBannerText: { color: GOLD, fontSize: 11, fontWeight: "500" },
  constraintBadge: { fontSize: 10, color: "#8B9EC5", fontWeight: "500", marginTop: 2 },
  dateDayName: { color: Colors.muted, fontSize: 11, fontWeight: "500" },
  dateDayNum: { color: Colors.text, fontSize: 18, fontWeight: "700" },
  scroll: { flex: 1 },
  partySizeRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  partySizeLabel: { color: Colors.muted, fontSize: 13, fontWeight: "600", marginRight: 4 },
  partySizeBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  partySizeBtnActive: { backgroundColor: GOLD, borderColor: GOLD },
  partySizeBtnText: { color: Colors.muted, fontWeight: "700", fontSize: 15 },
  partySizeBtnTextActive: { color: "#000" },
  sectionLabel: { fontSize: 12, color: Colors.muted, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginHorizontal: 16, marginBottom: 6, marginTop: 4 },
  slotCard: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.surface, marginHorizontal: 16, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: Colors.border },
  slotLeft: { flex: 1 },
  slotTime: { color: Colors.text, fontSize: 20, fontWeight: "700" },
  slotCourse: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  membersOnlyBadge: { color: GOLD, fontSize: 10, fontWeight: "700", marginTop: 3, textTransform: "uppercase" },
  slotRight: { alignItems: "flex-end", marginRight: 12 },
  slotSpots: { color: "#22c55e", fontSize: 12, fontWeight: "600" },
  slotPrice: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 },
  slotPriceEffective: { color: Colors.text, fontSize: 14, fontWeight: "700" },
  slotPriceStrike: { color: Colors.muted, fontSize: 11, textDecorationLine: "line-through" },
  slotTierName: { color: Colors.muted, fontSize: 10, marginTop: 1 },
  dealBadge: { backgroundColor: "rgba(34,197,94,0.18)", borderWidth: 1, borderColor: "rgba(34,197,94,0.4)", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, marginTop: 3, alignSelf: "flex-end" },
  dealBadgeText: { color: "#86efac", fontSize: 9, fontWeight: "700", letterSpacing: 0.3 },
  tierBox: { backgroundColor: Colors.background, borderRadius: 10, padding: 12, marginTop: 8, gap: 4 },
  tierBoxName: { color: Colors.text, fontSize: 13, fontWeight: "700" },
  tierBoxPrice: { color: GOLD, fontSize: 18, fontWeight: "700" },
  tierBoxReason: { color: Colors.muted, fontSize: 11 },
  breakdownToggle: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  breakdownToggleText: { color: GOLD, fontSize: 12, fontWeight: "600" },
  breakdownList: { marginTop: 6, gap: 6, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 6 },
  breakdownRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  breakdownLabel: { flex: 1, color: Colors.text, fontSize: 12 },
  breakdownAmountCol: { alignItems: "flex-end" },
  breakdownDelta: { fontSize: 12, fontWeight: "700" },
  breakdownBeforeAfter: { color: Colors.muted, fontSize: 10, marginTop: 1 },
  bookBtn: { backgroundColor: GOLD, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  bookBtnText: { color: "#000", fontWeight: "700", fontSize: 13 },
  bookingCard: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.surface, marginHorizontal: 16, borderRadius: 12, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.border },
  bookingCardHighlight: { borderColor: GOLD, borderWidth: 2, backgroundColor: GOLD + "1A" },
  bookingLeft: { flex: 1 },
  bookingDate: { color: Colors.text, fontSize: 15, fontWeight: "600" },
  bookingTime: { color: GOLD, fontSize: 18, fontWeight: "700", marginTop: 2 },
  bookingCourse: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  bookingPlayers: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  bookingStatus: { fontSize: 12, fontWeight: "600", marginTop: 4 },
  cancelBtn: { borderWidth: 1, borderColor: `${Colors.error}60`, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  cancelBtnText: { color: Colors.error, fontSize: 13, fontWeight: "600" },
  empty: { alignItems: "center", paddingVertical: 40 },
  emptyText: { color: Colors.muted, fontSize: 15, marginTop: 12 },
  emptyBtn: { marginTop: 16, backgroundColor: GOLD, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  emptyBtnText: { color: "#000", fontWeight: "700" },
  // Modal
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modal: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: "90%" },
  modalTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, marginBottom: 16 },
  modalDetailRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8 },
  modalLabel: { color: Colors.muted, fontSize: 13 },
  modalValue: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  sectionTitle: { color: Colors.muted, fontSize: 12, fontWeight: "600", textTransform: "uppercase", marginTop: 16, marginBottom: 8 },
  searchInput: { backgroundColor: Colors.background, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, color: Colors.text, padding: 10, fontSize: 14, marginBottom: 6 },
  memberResultRow: { flexDirection: "row", justifyContent: "space-between", padding: 10, borderBottomWidth: 1, borderBottomColor: Colors.border },
  memberResultName: { color: Colors.text, fontSize: 14 },
  memberResultSub: { color: Colors.muted, fontSize: 12 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: Colors.background, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 4, marginRight: 6, marginTop: 4, alignSelf: "flex-start" },
  chipText: { color: Colors.text, fontSize: 12 },
  guestRow: { flexDirection: "row", marginBottom: 6 },
  addGuestBtn: { backgroundColor: Colors.background, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, paddingVertical: 8, alignItems: "center", marginBottom: 8 },
  addGuestBtnText: { color: GOLD, fontWeight: "600", fontSize: 13 },
  caddieChip: { backgroundColor: Colors.background, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8, minWidth: 90 },
  caddieChipSelected: { backgroundColor: GOLD, borderColor: GOLD },
  caddieChipText: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  caddieChipSub: { color: Colors.muted, fontSize: 11, marginTop: 2 },
  pricingBox: { backgroundColor: Colors.background, borderRadius: 10, padding: 12, marginTop: 16 },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 20 },
  modalCancel: { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, alignItems: "center" },
  modalCancelText: { color: Colors.text, fontWeight: "600" },
  modalConfirm: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: GOLD, alignItems: "center" },
  modalConfirmText: { color: "#000", fontWeight: "700" },
});
