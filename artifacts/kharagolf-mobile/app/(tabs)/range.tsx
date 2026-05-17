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
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather, Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";
import { getLocale } from "@/i18n";
import { useTranslation } from "react-i18next";
import { useHighlightFlash } from "@/hooks/use-highlight";

const GOLD = "#C9A84C";

interface Bay {
  id: number;
  bayNumber: number;
  label: string | null;
}

interface BayStatus {
  bayId: number;
  bayNumber: number;
  label: string | null;
  isBooked: boolean;
}

interface TimeSlot {
  time: string;
  isBlocked: boolean;
  isPeak: boolean;
  memberRate: number;
  visitorRate: number;
  bays: BayStatus[];
}

interface Booking {
  booking: {
    id: number;
    bayId: number;
    slotDate: string;
    slotTime: string;
    status: string;
    totalAmount: string | null;
    qrToken: string | null;
    checkedInAt: string | null;
  };
  bay: Bay | null;
}

interface RangeConfig {
  slotDurationMinutes: number;
  bucketsIncluded: number;
  ballsPerBucket: number;
  memberRate: string;
  visitorRate: string;
}

function fmtDate(d: Date) {
  return d.toISOString().split("T")[0];
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

const STATUS_COLOR: Record<string, string> = {
  confirmed: "#22c55e",
  completed: "#3b82f6",
  cancelled: "#ef4444",
  pending: GOLD,
  no_show: "#6b7280",
};

export default function RangeScreen() {
  const { t } = useTranslation("range");
  const { token, user } = useAuth();
  const { activeClub } = useActiveClub();
  const orgId = activeClub?.id;
  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : "";

  const isStaff = ["super_admin", "org_admin", "tournament_director", "pro_shop", "volunteer"].includes(user?.role ?? "");

  const today = new Date();
  const [selectedDate, setSelectedDate] = useState(fmtDate(today));
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [bays, setBays] = useState<Bay[]>([]);
  const [config, setConfig] = useState<RangeConfig | null>(null);
  const [myBookings, setMyBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const params = useLocalSearchParams<{ bookingId?: string }>();
  const { highlightId } = useHighlightFlash(params.bookingId);
  const [activeTab, setActiveTab] = useState<"slots" | "bookings">(highlightId ? "bookings" : "slots");
  useEffect(() => {
    if (highlightId != null) setActiveTab("bookings");
  }, [highlightId]);
  const [confirmSlot, setConfirmSlot] = useState<{ time: string; bayId: number; bayNumber: number; rate: number } | null>(null);
  const [booking, setBooking] = useState(false);
  const [staffBookings, setStaffBookings] = useState<Booking[]>([]);

  async function load() {
    if (!orgId || !token) return;
    try {
      const [availRes, myRes, staffRes] = await Promise.all([
        fetch(`${baseUrl}/api/organizations/${orgId}/range-bookings/availability?date=${selectedDate}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${baseUrl}/api/organizations/${orgId}/range-bookings/my`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        isStaff ? fetch(`${baseUrl}/api/organizations/${orgId}/range-bookings?date=${selectedDate}`, {
          headers: { Authorization: `Bearer ${token}` },
        }) : Promise.resolve(null),
      ]);
      if (availRes.ok) {
        const data = await availRes.json();
        setSlots(data.slots ?? []);
        setBays(data.bays ?? []);
        if (data.config) setConfig(data.config);
      }
      if (myRes.ok) setMyBookings(await myRes.json());
      if (staffRes?.ok) setStaffBookings(await staffRes.json());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (orgId && token) load();
  }, [orgId, token, selectedDate]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [orgId, token, selectedDate]);

  async function handleBook() {
    if (!confirmSlot || !orgId || !token) return;
    setBooking(true);
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/range-bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          bayId: confirmSlot.bayId,
          slotDate: selectedDate,
          slotTime: confirmSlot.time,
          playerType: "member",
        }),
      });
      if (res.ok) {
        Alert.alert(t("bookedTitle"), t("bookedMessage", { num: confirmSlot.bayNumber, time: confirmSlot.time }));
        setConfirmSlot(null);
        load();
      } else {
        const err = await res.json();
        Alert.alert(t("bookFailedTitle"), err.error ?? t("bookFailedMessage"));
      }
    } finally {
      setBooking(false);
    }
  }

  async function handleCancel(bookingId: number) {
    Alert.alert(t("cancelTitle"), t("cancelMessage"), [
      { text: t("keepBtn"), style: "cancel" },
      {
        text: t("cancelConfirm"), style: "destructive", onPress: async () => {
          const res = await fetch(`${baseUrl}/api/organizations/${orgId}/range-bookings/${bookingId}/cancel`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ reason: "User cancelled" }),
          });
          if (res.ok) {
            Alert.alert(t("cancelledTitle"), t("cancelledMessage"));
            load();
          } else {
            const err = await res.json();
            Alert.alert(t("bookFailedTitle"), err.error ?? t("cancelErrorMessage"));
          }
        },
      },
    ]);
  }

  async function handleCheckin(bookingId: number) {
    const res = await fetch(`${baseUrl}/api/organizations/${orgId}/range-bookings/${bookingId}/checkin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      Alert.alert(t("checkedInTitle"), t("checkedInMessage"));
      load();
    }
  }

  const tabs = [
    { id: "slots" as const, label: t("tabBook") },
    { id: "bookings" as const, label: t("tabBookings") },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.headerIcon}>
            <Ionicons name="golf" size={20} color={GOLD} />
          </View>
          <View>
            <Text style={styles.headerTitle}>{t("title")}</Text>
            <Text style={styles.headerSub}>{t("subtitle")}</Text>
          </View>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {tabs.map(t => (
          <TouchableOpacity key={t.id} onPress={() => setActiveTab(t.id)} style={[styles.tab, activeTab === t.id && styles.tabActive]}>
            <Text style={[styles.tabText, activeTab === t.id && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Date picker */}
      {activeTab === "slots" && (
        <View style={styles.datePicker}>
          <TouchableOpacity onPress={() => setSelectedDate(fmtDate(addDays(new Date(selectedDate), -1)))} style={styles.dateArrow}>
            <Feather name="chevron-left" size={18} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.dateText}>
            {new Date(selectedDate).toLocaleDateString(getLocale(), { weekday: "short", day: "numeric", month: "short" })}
          </Text>
          <TouchableOpacity onPress={() => setSelectedDate(fmtDate(addDays(new Date(selectedDate), 1)))} style={styles.dateArrow}>
            <Feather name="chevron-right" size={18} color={Colors.text} />
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <LoadingSpinner color={GOLD} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}
          showsVerticalScrollIndicator={false}
        >
          {/* SLOTS */}
          {activeTab === "slots" && (
            <>
              {slots.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Ionicons name="golf-outline" size={36} color={Colors.muted} />
                  <Text style={styles.emptyText}>{t("noSlots")}</Text>
                </View>
              ) : (
                <>
                  {/* Bay header */}
                  {bays.length > 0 && (
                    <View style={styles.bayHeader}>
                      <Text style={[styles.bayHeaderCell, { width: 70 }]}>{t("time")}</Text>
                      {bays.map(b => (
                        <Text key={b.id} style={styles.bayHeaderCell}>{t("bay", { num: b.bayNumber })}</Text>
                      ))}
                    </View>
                  )}
                  {slots.map(slot => (
                    <View key={slot.time} style={styles.slotRow}>
                      <View style={[styles.slotTimeCell]}>
                        <Text style={styles.slotTimeText}>{slot.time}</Text>
                        {slot.isPeak && <Text style={styles.peakBadge}>{t("peak")}</Text>}
                      </View>
                      {slot.bays.map(bayStatus => (
                        <TouchableOpacity
                          key={bayStatus.bayId}
                          disabled={bayStatus.isBooked || slot.isBlocked}
                          onPress={() => setConfirmSlot({
                            time: slot.time,
                            bayId: bayStatus.bayId,
                            bayNumber: bayStatus.bayNumber,
                            rate: slot.memberRate,
                          })}
                          style={[
                            styles.slotCell,
                            slot.isBlocked ? styles.slotBlocked
                              : bayStatus.isBooked ? styles.slotBooked
                                : styles.slotOpen,
                          ]}
                        >
                          <Text style={[
                            styles.slotCellText,
                            slot.isBlocked ? { color: "#ef444470" }
                              : bayStatus.isBooked ? { color: "#3b82f6" }
                                : { color: "#22c55e" },
                          ]}>
                            {slot.isBlocked ? "—" : bayStatus.isBooked ? t("statusBooked") : t("statusFree")}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ))}
                </>
              )}
            </>
          )}

          {/* MY BOOKINGS */}
          {activeTab === "bookings" && (
            <>
              {myBookings.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Ionicons name="calendar-outline" size={36} color={Colors.muted} />
                  <Text style={styles.emptyText}>{t("noBookings")}</Text>
                </View>
              ) : (
                myBookings.map(b => (
                  <View
                    key={b.booking.id}
                    style={[styles.bookingCard, highlightId === b.booking.id && styles.bookingCardHighlight]}
                    testID={`range-booking-${b.booking.id}`}
                  >
                    <View style={styles.bookingCardLeft}>
                      <View style={styles.bayBadge}>
                        <Text style={styles.bayBadgeText}>{b.bay?.bayNumber ?? "?"}</Text>
                      </View>
                      <View>
                        <Text style={styles.bookingTitle}>{t("bay", { num: b.bay?.bayNumber ?? "?" })} · {b.booking.slotTime}</Text>
                        <Text style={styles.bookingSubtitle}>
                          {new Date(b.booking.slotDate).toLocaleDateString(getLocale(), { weekday: "short", day: "numeric", month: "short" })}
                          {b.booking.totalAmount && parseFloat(b.booking.totalAmount) > 0 ? ` · ₹${parseFloat(b.booking.totalAmount).toLocaleString()}` : ""}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.bookingRight}>
                      <View style={[styles.statusBadge, { borderColor: STATUS_COLOR[b.booking.status] + "40", backgroundColor: STATUS_COLOR[b.booking.status] + "20" }]}>
                        <Text style={[styles.statusText, { color: STATUS_COLOR[b.booking.status] }]}>{b.booking.status}</Text>
                      </View>
                      {b.booking.status === "confirmed" && (
                        <TouchableOpacity onPress={() => handleCancel(b.booking.id)} style={styles.cancelBtn}>
                          <Text style={styles.cancelBtnText}>{t("cancelBtn")}</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                ))
              )}
            </>
          )}
        </ScrollView>
      )}

      {/* Booking Confirm Modal */}
      <Modal visible={!!confirmSlot} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t("confirmTitle")}</Text>
            <Text style={styles.modalSub}>{t("confirmBay", { num: confirmSlot?.bayNumber, time: confirmSlot?.time })}</Text>
            <Text style={styles.modalDate}>{new Date(selectedDate).toLocaleDateString(getLocale(), { weekday: "long", day: "numeric", month: "long" })}</Text>

            {config && config.bucketsIncluded > 0 && (
              <View style={styles.tokenInfo}>
                <Ionicons name="flash" size={14} color={GOLD} />
                <Text style={styles.tokenText}>
                  {t("includesBuckets", { count: config.bucketsIncluded, balls: config.ballsPerBucket })}
                </Text>
              </View>
            )}

            {confirmSlot && confirmSlot.rate > 0 && (
              <Text style={styles.rateText}>₹{confirmSlot.rate.toLocaleString()}</Text>
            )}

            <View style={styles.modalButtons}>
              <TouchableOpacity onPress={() => setConfirmSlot(null)} style={styles.modalBtnSecondary}>
                <Text style={styles.modalBtnSecondaryText}>{t("cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleBook} disabled={booking} style={styles.modalBtnPrimary}>
                {booking ? (
                  <LoadingSpinner size="small" color="#000" />
                ) : (
                  <Text style={styles.modalBtnPrimaryText}>{t("bookBay")}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: GOLD + "20", borderWidth: 1, borderColor: GOLD + "40", alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 18, fontWeight: "700", color: Colors.text },
  headerSub: { fontSize: 11, color: Colors.muted, marginTop: 1 },
  tabRow: { flexDirection: "row", paddingHorizontal: 16, gap: 4, marginBottom: 8 },
  tab: { flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 8, backgroundColor: Colors.surface },
  tabActive: { backgroundColor: GOLD + "20", borderWidth: 1, borderColor: GOLD + "40" },
  tabText: { fontSize: 13, color: Colors.muted, fontWeight: "500" },
  tabTextActive: { color: GOLD, fontWeight: "700" },
  datePicker: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16, paddingVertical: 8, marginBottom: 4 },
  dateArrow: { padding: 8 },
  dateText: { fontSize: 15, fontWeight: "600", color: Colors.text },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 100 },
  emptyBox: { alignItems: "center", justifyContent: "center", paddingVertical: 48, gap: 8 },
  emptyText: { fontSize: 14, color: Colors.muted },
  bayHeader: { flexDirection: "row", marginBottom: 4, paddingHorizontal: 4 },
  bayHeaderCell: { flex: 1, fontSize: 11, color: Colors.muted, textAlign: "center", textTransform: "uppercase", letterSpacing: 0.5 },
  slotRow: { flexDirection: "row", marginBottom: 6, alignItems: "center", gap: 4 },
  slotTimeCell: { width: 70, paddingRight: 4 },
  slotTimeText: { fontSize: 13, fontWeight: "600", color: Colors.text },
  peakBadge: { fontSize: 9, color: GOLD, fontWeight: "700", marginTop: 1 },
  slotCell: { flex: 1, height: 40, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  slotOpen: { backgroundColor: "#22c55e15", borderColor: "#22c55e30" },
  slotBooked: { backgroundColor: "#3b82f615", borderColor: "#3b82f630" },
  slotBlocked: { backgroundColor: "#ef444415", borderColor: "#ef444430" },
  slotCellText: { fontSize: 12, fontWeight: "600" },
  bookingCard: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: Colors.surface, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: Colors.border },
  bookingCardHighlight: { borderColor: GOLD, borderWidth: 2, backgroundColor: GOLD + "1A" },
  bookingCardLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  bayBadge: { width: 36, height: 36, borderRadius: 8, backgroundColor: GOLD + "20", borderWidth: 1, borderColor: GOLD + "40", alignItems: "center", justifyContent: "center" },
  bayBadgeText: { fontSize: 14, fontWeight: "700", color: GOLD },
  bookingTitle: { fontSize: 14, fontWeight: "600", color: Colors.text },
  bookingSubtitle: { fontSize: 12, color: Colors.muted, marginTop: 1 },
  bookingRight: { alignItems: "flex-end", gap: 6 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  statusText: { fontSize: 11, fontWeight: "600" },
  cancelBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: "#ef444430", backgroundColor: "#ef444415" },
  cancelBtnText: { fontSize: 11, color: "#ef4444", fontWeight: "600" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modalBox: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40, gap: 8 },
  modalTitle: { fontSize: 20, fontWeight: "700", color: Colors.text, textAlign: "center" },
  modalSub: { fontSize: 15, color: Colors.muted, textAlign: "center" },
  modalDate: { fontSize: 13, color: Colors.muted, textAlign: "center", marginBottom: 4 },
  tokenInfo: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: GOLD + "15", borderRadius: 8, padding: 10, borderWidth: 1, borderColor: GOLD + "30" },
  tokenText: { fontSize: 13, color: GOLD, fontWeight: "500" },
  rateText: { fontSize: 22, fontWeight: "700", color: Colors.text, textAlign: "center" },
  modalButtons: { flexDirection: "row", gap: 10, marginTop: 8 },
  modalBtnSecondary: { flex: 1, height: 48, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  modalBtnSecondaryText: { fontSize: 15, color: Colors.muted, fontWeight: "600" },
  modalBtnPrimary: { flex: 1, height: 48, borderRadius: 12, backgroundColor: GOLD, alignItems: "center", justifyContent: "center" },
  modalBtnPrimaryText: { fontSize: 15, fontWeight: "700", color: "#000" },
});
