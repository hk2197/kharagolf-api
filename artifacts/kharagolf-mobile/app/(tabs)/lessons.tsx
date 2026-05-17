import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { BASE_URL, FeatureGateError } from "@/utils/api";
import { getLocale } from "@/i18n";
import { useHighlightFlash, useScrollToHighlight } from "@/hooks/use-highlight";

let RazorpayCheckout: {
  open: (opts: RzpOptions) => Promise<RzpSuccess>;
} | null = null;
try {
  RazorpayCheckout = require("react-native-razorpay").default;
} catch {
  RazorpayCheckout = null;
}

interface RzpOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string };
}
interface RzpSuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface Pro {
  id: number;
  displayName: string;
  bio: string | null;
  photoUrl: string | null;
  specialisms: string[];
}

interface LessonType {
  id: number;
  name: string;
  description: string | null;
  durationMinutes: number;
  pricePaise: number;
}

interface Slot {
  time: string;
  available: boolean;
}

interface Booking {
  id: number;
  proId: number;
  scheduledAt: string;
  durationMinutes: number;
  status: string;
  paymentStatus: string;
  amountPaise: number;
  proName?: string;
  lessonTypeName?: string;
  cancelledAt: string | null;
}

const GOLD = "#C9A84C";

function formatPrice(paise: number): string {
  if (paise === 0) return "Free";
  return `₹${(paise / 100).toLocaleString(getLocale())}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(getLocale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

const STATUS_COLOR: Record<string, string> = {
  pending: "#F59E0B",
  confirmed: "#10B981",
  cancelled: "#EF4444",
  completed: "#3B82F6",
  no_show: "#6B7280",
};

export default function LessonsScreen() {
  const insets = useSafeAreaInsets();
  const { user, token } = useAuth();
  const orgId = user?.organizationId;
  const params = useLocalSearchParams<{ bookingId?: string }>();
  // Deep-link from MyUpcomingWidget: open straight on "My" tab and flash row.
  const { highlightId } = useHighlightFlash(params.bookingId);

  const [tab, setTab] = useState<"book" | "my">(highlightId ? "my" : "book");
  useEffect(() => {
    if (highlightId != null) setTab("my");
  }, [highlightId]);
  // Deep-link from MyUpcomingWidget: the manual "My Lessons" tab press is the
  // only other code path that calls loadMyBookings, so without this effect the
  // bookings list stays empty when the user arrives via deep link and the row
  // we want to flash never mounts. Defined further down via useCallback, so we
  // declare the trigger here and let the effect fire once it's hoisted.
  // (See useEffect below the loadMyBookings declaration.)
  const myBookingsListRef = useRef<FlatList<Booking>>(null);
  const [pros, setPros] = useState<Pro[]>([]);
  const [selectedPro, setSelectedPro] = useState<Pro | null>(null);
  const [lessonTypes, setLessonTypes] = useState<LessonType[]>([]);
  const [selectedType, setSelectedType] = useState<LessonType | null>(null);

  // Week navigation
  const [weekStart, setWeekStart] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  });
  const [selectedDate, setSelectedDate] = useState<string>(toDateStr(new Date()));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [myBookings, setMyBookings] = useState<Booking[]>([]);
  const [loadingPros, setLoadingPros] = useState(true);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [booking, setBooking] = useState(false);

  // Booking confirmation modal
  const [confirmModal, setConfirmModal] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);

  const headers = useCallback(
    () => ({
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }),
    [token]
  );

  useEffect(() => {
    if (!orgId) return;
    setLoadingPros(true);
    fetch(`${BASE_URL}/api/organizations/${orgId}/lessons/pros`, {
      headers: headers(),
    })
      .then((r) => r.json())
      .then(setPros)
      .catch(() => {})
      .finally(() => setLoadingPros(false));
  }, [orgId]);

  useEffect(() => {
    if (!selectedPro || !orgId) return;
    fetch(
      `${BASE_URL}/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/lesson-types`,
      { headers: headers() }
    )
      .then((r) => r.json())
      .then(setLessonTypes)
      .catch(() => setLessonTypes([]));
  }, [selectedPro]);

  useEffect(() => {
    if (!selectedPro || !orgId) return;
    loadSlots(selectedDate);
  }, [selectedPro, selectedDate]);

  async function loadSlots(date: string) {
    if (!selectedPro || !orgId) return;
    setLoadingSlots(true);
    setSelectedSlot(null);
    try {
      const r = await fetch(
        `${BASE_URL}/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/availability?date=${date}`,
        { headers: headers() }
      );
      if (r.ok) {
        const d = await r.json();
        setSlots(d.slots ?? []);
      }
    } finally {
      setLoadingSlots(false);
    }
  }

  const loadMyBookings = useCallback(async () => {
    if (!orgId) return;
    setLoadingBookings(true);
    try {
      const r = await fetch(
        `${BASE_URL}/api/organizations/${orgId}/lessons/my-bookings`,
        { headers: headers() }
      );
      if (r.ok) setMyBookings(await r.json());
    } finally {
      setLoadingBookings(false);
    }
  }, [orgId, headers]);

  // Deep-link arrivals (?bookingId=...) flip to the "my" tab via the
  // highlightId effect above, but the manual tab onPress was the only path
  // that loaded `myBookings`. Without this fetch, the FlatList stays empty
  // and `useScrollToHighlight` has nothing to scroll to / flash. Trigger a
  // load whenever a highlightId arrives and we have credentials.
  useEffect(() => {
    if (highlightId == null) return;
    if (!orgId) return;
    void loadMyBookings();
  }, [highlightId, orgId, loadMyBookings]);

  async function handleBook() {
    if (!selectedPro || !selectedType || !selectedSlot || !orgId) return;
    setBooking(true);
    const scheduledAt = new Date(
      `${selectedDate}T${selectedSlot}:00+05:30`
    ).toISOString();

    try {
      const r = await fetch(
        `${BASE_URL}/api/organizations/${orgId}/lessons/pros/${selectedPro.id}/book`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ lessonTypeId: selectedType.id, scheduledAt }),
        }
      );
      const data = await r.json();
      if (!r.ok) {
        Alert.alert("Booking Failed", data.error ?? "Could not book lesson");
        return;
      }

      if (data.requiresPayment && data.razorpayOrder && RazorpayCheckout) {
        const { orderId, amount, keyId } = data.razorpayOrder;
        const bookingId = data.booking.id;
        try {
          const resp = await RazorpayCheckout.open({
            key: keyId,
            order_id: orderId,
            amount,
            currency: "INR",
            name: "Golf Lesson",
            description: `${selectedType.name} with ${selectedPro.displayName}`,
            prefill: { name: user?.displayName ?? "", email: user?.email ?? "" },
          });
          const verifyRes = await fetch(
            `${BASE_URL}/api/organizations/${orgId}/lessons/bookings/${bookingId}/payment/verify`,
            {
              method: "POST",
              headers: headers(),
              body: JSON.stringify({
                razorpayOrderId: resp.razorpay_order_id,
                razorpayPaymentId: resp.razorpay_payment_id,
                razorpaySignature: resp.razorpay_signature,
              }),
            }
          );
          if (verifyRes.ok) {
            Alert.alert("Success", "Lesson booked and payment confirmed!");
          } else {
            Alert.alert("Warning", "Payment received but verification failed. Contact support.");
          }
        } catch {
          Alert.alert("Cancelled", "Payment was cancelled.");
        }
      } else {
        Alert.alert("Booked!", "Your lesson has been confirmed.");
      }
      setConfirmModal(false);
      setSelectedSlot(null);
      loadSlots(selectedDate);
      loadMyBookings();
    } finally {
      setBooking(false);
    }
  }

  async function cancelBooking(bookingId: number) {
    Alert.alert("Cancel Lesson", "Are you sure you want to cancel this booking?", [
      { text: "Keep", style: "cancel" },
      {
        text: "Cancel Booking",
        style: "destructive",
        onPress: async () => {
          const r = await fetch(
            `${BASE_URL}/api/organizations/${orgId}/lessons/bookings/${bookingId}/cancel`,
            { method: "POST", headers: headers() }
          );
          if (r.ok) {
            Alert.alert("Cancelled", "Your booking has been cancelled.");
            loadMyBookings();
          } else {
            const d = await r.json();
            Alert.alert("Error", d.error ?? "Could not cancel booking");
          }
        },
      },
    ]);
  }

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Lessons & Coaching</Text>
          <Text style={styles.headerSub}>Book sessions with teaching pros</Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        <Pressable
          style={[styles.tab, tab === "book" && styles.tabActive]}
          onPress={() => setTab("book")}
        >
          <Feather name="book-open" size={14} color={tab === "book" ? "#000" : "#9CA3AF"} />
          <Text style={[styles.tabText, tab === "book" && styles.tabTextActive]}>
            Book a Lesson
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, tab === "my" && styles.tabActive]}
          onPress={() => { setTab("my"); loadMyBookings(); }}
        >
          <Feather name="calendar" size={14} color={tab === "my" ? "#000" : "#9CA3AF"} />
          <Text style={[styles.tabText, tab === "my" && styles.tabTextActive]}>
            My Lessons
          </Text>
        </Pressable>
      </View>

      {tab === "book" && (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {/* Pro Directory */}
          <Text style={styles.sectionLabel}>1. Choose a Professional</Text>
          {loadingPros ? (
            <LoadingSpinner color={GOLD} style={{ marginVertical: 20 }} />
          ) : pros.length === 0 ? (
            <View style={styles.emptyCard}>
              <Feather name="user" size={32} color="#374151" />
              <Text style={styles.emptyText}>No professionals available.</Text>
            </View>
          ) : (
            pros.map((pro) => (
              <Pressable
                key={pro.id}
                onPress={() => { setSelectedPro(pro); setSelectedType(null); setSelectedSlot(null); }}
                style={[styles.proCard, selectedPro?.id === pro.id && styles.proCardSelected]}
              >
                <View style={styles.proAvatar}>
                  <Feather name="user" size={24} color={selectedPro?.id === pro.id ? GOLD : "#6B7280"} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.proName}>{pro.displayName}</Text>
                  {pro.bio && <Text style={styles.proBio} numberOfLines={2}>{pro.bio}</Text>}
                  {pro.specialisms.length > 0 && (
                    <View style={styles.specialisms}>
                      {pro.specialisms.slice(0, 3).map((s) => (
                        <View key={s} style={styles.specialism}>
                          <Text style={styles.specialismText}>{s}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
                {selectedPro?.id === pro.id && (
                  <Feather name="check-circle" size={20} color={GOLD} />
                )}
              </Pressable>
            ))
          )}

          {selectedPro && (
            <>
              {/* Lesson Types */}
              <Text style={[styles.sectionLabel, { marginTop: 20 }]}>2. Choose a Lesson Type</Text>
              {lessonTypes.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>No lesson types configured.</Text>
                </View>
              ) : (
                lessonTypes.map((lt) => (
                  <Pressable
                    key={lt.id}
                    onPress={() => setSelectedType(lt)}
                    style={[styles.lessonTypeCard, selectedType?.id === lt.id && styles.lessonTypeCardSelected]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.ltName}>{lt.name}</Text>
                      {lt.description && <Text style={styles.ltDesc}>{lt.description}</Text>}
                      <View style={styles.ltMeta}>
                        <Feather name="clock" size={12} color="#6B7280" />
                        <Text style={styles.ltMetaText}>{lt.durationMinutes} min</Text>
                        <Text style={styles.ltMetaText}>  ·  {formatPrice(lt.pricePaise)}</Text>
                      </View>
                    </View>
                    {selectedType?.id === lt.id && <Feather name="check-circle" size={18} color={GOLD} />}
                  </Pressable>
                ))
              )}

              {selectedType && (
                <>
                  {/* Date Picker */}
                  <Text style={[styles.sectionLabel, { marginTop: 20 }]}>3. Choose a Date</Text>
                  <View style={styles.weekNav}>
                    <Pressable onPress={() => setWeekStart((w) => addDays(w, -7))} style={styles.navBtn}>
                      <Feather name="chevron-left" size={20} color="#9CA3AF" />
                    </Pressable>
                    <View style={styles.weekDays}>
                      {weekDays.map((d) => {
                        const ds = toDateStr(d);
                        const isPast = d < new Date(new Date().setHours(0, 0, 0, 0));
                        const isSelected = ds === selectedDate;
                        return (
                          <Pressable
                            key={ds}
                            disabled={isPast}
                            onPress={() => setSelectedDate(ds)}
                            style={[styles.dayBtn, isSelected && styles.dayBtnActive, isPast && styles.dayBtnPast]}
                          >
                            <Text style={[styles.dayLetter, isSelected && styles.dayLetterActive, isPast && styles.dayLetterPast]}>
                              {d.toLocaleDateString(getLocale(), { weekday: "short" }).charAt(0)}
                            </Text>
                            <Text style={[styles.dayNum, isSelected && styles.dayNumActive, isPast && styles.dayNumPast]}>
                              {d.getDate()}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <Pressable onPress={() => setWeekStart((w) => addDays(w, 7))} style={styles.navBtn}>
                      <Feather name="chevron-right" size={20} color="#9CA3AF" />
                    </Pressable>
                  </View>

                  {/* Time Slots */}
                  <Text style={[styles.sectionLabel, { marginTop: 20 }]}>4. Choose a Time</Text>
                  {loadingSlots ? (
                    <LoadingSpinner color={GOLD} style={{ marginVertical: 16 }} />
                  ) : slots.filter((s) => s.available).length === 0 ? (
                    <View style={styles.emptyCard}>
                      <Feather name="alert-circle" size={24} color="#374151" />
                      <Text style={styles.emptyText}>No available slots on this date.</Text>
                    </View>
                  ) : (
                    <View style={styles.slotsGrid}>
                      {slots
                        .filter((s) => s.available)
                        .map((slot) => (
                          <Pressable
                            key={slot.time}
                            onPress={() => { setSelectedSlot(slot.time); setConfirmModal(true); }}
                            style={[styles.slotBtn, selectedSlot === slot.time && styles.slotBtnActive]}
                          >
                            <Text style={[styles.slotText, selectedSlot === slot.time && styles.slotTextActive]}>
                              {slot.time}
                            </Text>
                          </Pressable>
                        ))}
                    </View>
                  )}
                </>
              )}
            </>
          )}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {tab === "my" && (
        <View style={{ flex: 1 }}>
          {loadingBookings ? (
            <LoadingSpinner color={GOLD} style={{ marginTop: 40 }} />
          ) : myBookings.length === 0 ? (
            <View style={[styles.emptyCard, { margin: 16 }]}>
              <Feather name="calendar" size={32} color="#374151" />
              <Text style={styles.emptyText}>No lesson bookings yet.</Text>
              <Pressable style={styles.bookNowBtn} onPress={() => setTab("book")}>
                <Text style={styles.bookNowText}>Book a Lesson</Text>
              </Pressable>
            </View>
          ) : (
            <LessonBookingsList
              listRef={myBookingsListRef}
              bookings={myBookings}
              highlightId={highlightId}
              onCancel={cancelBooking}
            />
          )}
        </View>
      )}

      {/* Booking Confirmation Modal */}
      <Modal visible={confirmModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Confirm Booking</Text>
            {selectedPro && selectedType && selectedSlot && (
              <View style={styles.modalDetails}>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Pro</Text>
                  <Text style={styles.modalValue}>{selectedPro.displayName}</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Lesson</Text>
                  <Text style={styles.modalValue}>{selectedType.name}</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Date</Text>
                  <Text style={styles.modalValue}>
                    {new Date(selectedDate + "T12:00:00").toLocaleDateString(getLocale(), {
                      weekday: "short", day: "numeric", month: "long",
                    })}
                  </Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Time</Text>
                  <Text style={styles.modalValue}>{selectedSlot} · {selectedType.durationMinutes} min</Text>
                </View>
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Amount</Text>
                  <Text style={[styles.modalValue, { color: GOLD, fontWeight: "700" }]}>
                    {formatPrice(selectedType.pricePaise)}
                  </Text>
                </View>
              </View>
            )}
            <View style={styles.modalActions}>
              <Pressable style={styles.cancelModalBtn} onPress={() => setConfirmModal(false)}>
                <Text style={styles.cancelModalText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.confirmBtn} onPress={handleBook} disabled={booking}>
                {booking ? (
                  <LoadingSpinner size="small" color="#000" />
                ) : (
                  <Text style={styles.confirmText}>
                    {selectedType?.pricePaise === 0 ? "Confirm" : "Pay & Book"}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0F172A" },
  header: { padding: 16, paddingBottom: 8 },
  headerTitle: { fontSize: 22, fontWeight: "700", color: "#F9FAFB" },
  headerSub: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  tab: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: "#1F2937" },
  tabActive: { backgroundColor: GOLD, borderColor: GOLD },
  tabText: { fontSize: 13, color: "#9CA3AF", fontWeight: "600" },
  tabTextActive: { color: "#000" },
  scroll: { flex: 1 },
  scrollContent: { padding: 16 },
  sectionLabel: { fontSize: 11, fontWeight: "700", color: "#6B7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },
  emptyCard: { backgroundColor: "#1E293B", borderRadius: 12, padding: 32, alignItems: "center", gap: 12 },
  emptyText: { color: "#6B7280", fontSize: 14, textAlign: "center" },
  proCard: { backgroundColor: "#1E293B", borderRadius: 12, padding: 12, marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: "#1F2937" },
  proCardSelected: { borderColor: GOLD },
  proAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: "#0F172A", justifyContent: "center", alignItems: "center" },
  proName: { fontSize: 15, fontWeight: "600", color: "#F9FAFB" },
  proBio: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  specialisms: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 },
  specialism: { backgroundColor: "#0F172A", borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2 },
  specialismText: { fontSize: 10, color: "#9CA3AF" },
  lessonTypeCard: { backgroundColor: "#1E293B", borderRadius: 12, padding: 12, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: "#1F2937" },
  lessonTypeCardSelected: { borderColor: GOLD },
  ltName: { fontSize: 14, fontWeight: "600", color: "#F9FAFB" },
  ltDesc: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  ltMeta: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  ltMetaText: { fontSize: 11, color: "#6B7280" },
  weekNav: { flexDirection: "row", alignItems: "center", backgroundColor: "#1E293B", borderRadius: 12, padding: 8 },
  navBtn: { padding: 8 },
  weekDays: { flex: 1, flexDirection: "row", justifyContent: "space-around" },
  dayBtn: { alignItems: "center", paddingVertical: 6, paddingHorizontal: 4, borderRadius: 8, minWidth: 36 },
  dayBtnActive: { backgroundColor: GOLD },
  dayBtnPast: { opacity: 0.3 },
  dayLetter: { fontSize: 10, color: "#9CA3AF", fontWeight: "600" },
  dayLetterActive: { color: "#000" },
  dayLetterPast: { color: "#374151" },
  dayNum: { fontSize: 14, fontWeight: "700", color: "#F9FAFB", marginTop: 2 },
  dayNumActive: { color: "#000" },
  dayNumPast: { color: "#374151" },
  slotsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  slotBtn: { backgroundColor: "#1E293B", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: "#1F2937" },
  slotBtnActive: { backgroundColor: GOLD, borderColor: GOLD },
  slotText: { fontSize: 13, fontWeight: "600", color: "#9CA3AF" },
  slotTextActive: { color: "#000" },
  bookingCard: { backgroundColor: "#1E293B", borderRadius: 12, padding: 14, marginBottom: 10, flexDirection: "row", alignItems: "flex-start" },
  bookingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  bookingPro: { fontSize: 15, fontWeight: "600", color: "#F9FAFB", flex: 1 },
  bookingType: { fontSize: 12, color: "#9CA3AF", marginTop: 2 },
  bookingDate: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  bookingPrice: { fontSize: 12, color: GOLD, marginTop: 2 },
  statusBadge: { borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  cancelBtn: { padding: 8 },
  bookNowBtn: { backgroundColor: GOLD, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 24, marginTop: 8 },
  bookNowText: { color: "#000", fontWeight: "700", fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modalContent: { backgroundColor: "#1E293B", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: "#F9FAFB", marginBottom: 16 },
  modalDetails: { gap: 10, marginBottom: 20 },
  modalRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  modalLabel: { fontSize: 13, color: "#6B7280" },
  modalValue: { fontSize: 13, color: "#F9FAFB", fontWeight: "600", textAlign: "right", flex: 1 },
  modalActions: { flexDirection: "row", gap: 12 },
  cancelModalBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: "#374151", alignItems: "center" },
  cancelModalText: { color: "#9CA3AF", fontWeight: "600" },
  confirmBtn: { flex: 2, paddingVertical: 12, borderRadius: 10, backgroundColor: GOLD, alignItems: "center", justifyContent: "center" },
  confirmText: { color: "#000", fontWeight: "700", fontSize: 15 },
  highlightCard: {
    borderColor: GOLD,
    borderWidth: 2,
    backgroundColor: GOLD + "1A",
  },
});

const getBookingId = (b: Booking) => b.id;

function LessonBookingsList({
  listRef,
  bookings,
  highlightId,
  onCancel,
}: {
  listRef: React.RefObject<FlatList<Booking> | null>;
  bookings: Booking[];
  highlightId: number | null;
  onCancel: (id: number) => void;
}) {
  useScrollToHighlight<Booking>(listRef, bookings, highlightId, getBookingId);
  return (
    <FlatList
      ref={listRef}
      data={bookings}
      keyExtractor={(b) => String(b.id)}
      contentContainerStyle={{ padding: 16 }}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        listRef.current?.scrollToOffset({
          offset: averageItemLength * index,
          animated: true,
        });
      }}
      renderItem={({ item: bk }) => {
        const isHighlight = highlightId === bk.id;
        return (
          <View
            style={[styles.bookingCard, isHighlight && styles.highlightCard]}
            testID={`lesson-booking-${bk.id}`}
          >
            <View style={{ flex: 1 }}>
              <View style={styles.bookingRow}>
                <Text style={styles.bookingPro}>{bk.proName ?? "Pro"}</Text>
                <View style={[styles.statusBadge, { backgroundColor: (STATUS_COLOR[bk.status] ?? "#6B7280") + "33" }]}>
                  <Text style={[styles.statusText, { color: STATUS_COLOR[bk.status] ?? "#6B7280" }]}>
                    {bk.status}
                  </Text>
                </View>
              </View>
              <Text style={styles.bookingType}>{bk.lessonTypeName ?? "Lesson"}</Text>
              <Text style={styles.bookingDate}>{formatDateTime(bk.scheduledAt)}</Text>
              {bk.amountPaise > 0 && (
                <Text style={styles.bookingPrice}>{formatPrice(bk.amountPaise)}</Text>
              )}
            </View>
            {["pending", "confirmed"].includes(bk.status) && (
              <Pressable onPress={() => onCancel(bk.id)} style={styles.cancelBtn}>
                <Feather name="x" size={16} color="#EF4444" />
              </Pressable>
            )}
          </View>
        );
      }}
    />
  );
}
