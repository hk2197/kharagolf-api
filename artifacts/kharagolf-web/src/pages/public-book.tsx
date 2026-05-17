import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { Calendar, Clock, MapPin, Users, Wifi, WifiOff, Download, CheckCircle2, X, ChevronLeft, ChevronRight } from "lucide-react";
import { KharaGolfWordmark } from "@/components/kharagolf-brand";
import { getLocale } from "@/i18n";
import { Trans, useTranslation } from "react-i18next";

/* ─── Types ──────────────────────────────────────────────────────── */

interface Slot {
  id: number;
  slotDate: string;
  startingHole: number;
  maxPlayers: number;
  bookedPlayers: number;
  spotsLeft: number;
  pricePaise: number;
  priceDisplay: string;
  notes: string | null;
  status: string;
  courseName: string | null;
}

interface OrgInfo {
  id: number;
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  slug: string;
}

interface BookingResult {
  id: number;
  playerName: string;
  players: number;
  amountPaise: number;
  paymentStatus: string;
  slotDate: string;
  bookedAt: string;
  razorpayOrderId?: string;
}

declare global {
  interface Window {
    Razorpay: new (opts: Record<string, unknown>) => { open(): void };
  }
}

/* ─── Helpers ────────────────────────────────────────────────────── */

const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

function apiUrl(path: string) {
  return `${baseUrl}/api${path}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(getLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

function formatDateShort(iso: string) {
  return new Date(iso).toLocaleDateString(getLocale(), { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

function groupByDate(slots: Slot[]): Record<string, Slot[]> {
  const groups: Record<string, Slot[]> = {};
  for (const s of slots) {
    const key = new Date(s.slotDate).toISOString().slice(0, 10);
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }
  return groups;
}

function generateICS(slot: Slot, org: OrgInfo, booking: BookingResult): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const fmtDt = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const start = new Date(slot.slotDate);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "CALSCALE:GREGORIAN", "PRODID:-//KHARAGOLF//Tee Time//EN",
    "BEGIN:VEVENT",
    `UID:mkt-booking-${booking.id}@kharagolf.com`,
    `DTSTAMP:${fmtDt(new Date())}`,
    `DTSTART:${fmtDt(start)}`,
    `DTEND:${fmtDt(end)}`,
    `SUMMARY:${esc(`Tee Time — ${org.name}`)}`,
    `DESCRIPTION:${esc(`Booking #${booking.id} · ${booking.players} player(s) · Hole ${slot.startingHole}${slot.courseName ? ` · ${slot.courseName}` : ""}`)}`,
    `LOCATION:${esc(slot.courseName ?? org.name)}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}

function downloadICS(slot: Slot, org: OrgInfo, booking: BookingResult) {
  const blob = new Blob([generateICS(slot, org, booking)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tee-time-${booking.id}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── QR Confirmation Modal ──────────────────────────────────────── */

function BookingConfirmedModal({
  booking,
  slot,
  org,
  onClose,
  onCancelled,
}: {
  booking: BookingResult;
  slot: Slot;
  org: OrgInfo;
  onClose: () => void;
  onCancelled?: () => void;
}) {
  const { t } = useTranslation("publicBook");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const qrData = `KHARAGOLF:BOOKING:${booking.id}:${org.slug}`;
  const qrUrl = apiUrl(`/public/qr?data=${encodeURIComponent(qrData)}&size=220&color=C9A84C&bg=0b1512`);

  async function cancelBooking() {
    if (!confirm(t("cancelBooking") + " – " + t("cancelledMsg").slice(0, 60) + "?")) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(apiUrl(`/public/orgs/by-slug/${org.slug}/marketplace/bookings/${booking.id}/cancel`), {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) { setCancelError(data.error ?? t("errors.cancellationFailed")); return; }
      setCancelled(true);
      onCancelled?.();
    } catch {
      setCancelError(t("errors.networkError"));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm bg-[#111c17] border border-[#243b2e] rounded-2xl overflow-hidden">
        <div className="bg-[#142019] p-4 border-b border-[#243b2e] flex items-center justify-between">
          <div className="flex items-center gap-2">
            {cancelled
              ? <X size={18} className="text-red-400" />
              : <CheckCircle2 size={18} className="text-green-400" />
            }
            <span className="font-bold text-white">{cancelled ? t("bookingCancelled") : t("bookingConfirmed")}</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {cancelled ? (
            <p className="text-sm text-gray-400">{t("cancelledMsg")}</p>
          ) : (
            <>
              {/* Slot info */}
              <div className="space-y-1.5 text-sm text-gray-300">
                <div className="flex gap-2 items-center">
                  <Calendar size={14} className="text-[#C9A84C] shrink-0" />
                  <span>{formatDate(slot.slotDate)}</span>
                </div>
                <div className="flex gap-2 items-center">
                  <Clock size={14} className="text-[#C9A84C] shrink-0" />
                  <span>{formatTime(slot.slotDate)} · {t("hole", { n: slot.startingHole })}</span>
                </div>
                {slot.courseName && (
                  <div className="flex gap-2 items-center">
                    <MapPin size={14} className="text-[#C9A84C] shrink-0" />
                    <span>{slot.courseName}</span>
                  </div>
                )}
                <div className="flex gap-2 items-center">
                  <Users size={14} className="text-[#C9A84C] shrink-0" />
                  <span>{t("players")}: {booking.players}</span>
                </div>
              </div>

              {/* QR code */}
              <div className="flex flex-col items-center gap-2 py-2">
                <div className="rounded-xl overflow-hidden border border-[#243b2e] p-1 bg-[#0b1512]">
                  <img src={qrUrl} alt="Booking QR" width={150} height={150} className="block" />
                </div>
                <p className="text-[11px] text-gray-500">{t("bookingRef", { id: booking.id })}</p>
              </div>

              {/* Actions */}
              <button
                onClick={() => downloadICS(slot, org, booking)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#243b2e] text-green-400 text-sm font-semibold hover:bg-[#2d4a38] transition-colors"
              >
                <Download size={15} /> {t("addToCalendar")}
              </button>
              {cancelError && <p className="text-xs text-red-400">{cancelError}</p>}
              <button
                onClick={cancelBooking}
                disabled={cancelling}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-red-500/30 text-red-400 text-xs font-medium hover:bg-red-900/20 transition-colors disabled:opacity-40"
              >
                {cancelling ? t("cancelling") : t("cancelBooking")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Slot Card ──────────────────────────────────────────────────── */

function SlotCard({
  slot,
  orgSlug,
  orgId,
  onBooked,
}: {
  slot: Slot;
  orgSlug: string;
  orgId: number;
  onBooked: (booking: BookingResult, slot: Slot) => void;
}) {
  const { t } = useTranslation("publicBook");
  const [players, setPlayers] = useState(1);
  const [notes, setNotes] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFull = slot.status === "full" || slot.spotsLeft <= 0;
  const isFree = slot.pricePaise === 0;

  async function book() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/public/orgs/by-slug/${orgSlug}/marketplace/${slot.id}/book`), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ players, notes: notes || undefined }),
      });
      if (res.status === 401) {
        setError("__auth__");
        return;
      }
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? t("errors.bookingFailed")); return; }

      if (!data.requiresPayment) {
        onBooked({ ...data.booking, slotDate: slot.slotDate }, slot);
        return;
      }

      // Razorpay checkout
      if (!window.Razorpay) {
        setError(t("errors.paymentGatewayNotLoaded"));
        return;
      }
      const rzp = new window.Razorpay({
        key: data.razorpayOrder.keyId,
        amount: data.razorpayOrder.amount,
        currency: data.razorpayOrder.currency,
        order_id: data.razorpayOrder.orderId,
        name: "KHARAGOLF Tee Time",
        description: `${slot.courseName ?? "Golf"} · Hole ${slot.startingHole} · ${players} player(s)`,
        theme: { color: "#C9A84C" },
        handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
          const verRes = await fetch(apiUrl(`/public/orgs/by-slug/${orgSlug}/marketplace/${slot.id}/payment/verify`), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bookingId: data.booking.id,
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            }),
          });
          if (verRes.ok) {
            onBooked({ ...data.booking, slotDate: slot.slotDate }, slot);
          } else {
            const e = await verRes.json();
            setError(e.error ?? t("errors.paymentVerificationFailed"));
          }
        },
      });
      rzp.open();
    } catch {
      setError(t("errors.networkError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`rounded-xl border transition-all ${isFull ? "border-white/5 opacity-60" : "border-[#1e3028] hover:border-[#2d4a38]"} bg-[#111c17] overflow-hidden`}>
      <button
        className="w-full text-left px-4 py-3.5 flex items-center justify-between gap-3"
        onClick={() => !isFull && setExpanded(v => !v)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-semibold">{formatTime(slot.slotDate)}</span>
            {slot.courseName && (
              <span className="text-xs text-gray-500 flex items-center gap-1">
                <MapPin size={10} /> {slot.courseName}
              </span>
            )}
            <span className="text-xs text-gray-500">{t("hole", { n: slot.startingHole })}</span>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <span className={`text-xs font-semibold ${isFull ? "text-gray-500" : slot.spotsLeft <= 1 ? "text-amber-400" : "text-green-400"}`}>
              {isFull ? t("full") : t("spotsLeft", { count: slot.spotsLeft })}
            </span>
            <span className="text-xs text-gray-400">{slot.priceDisplay}</span>
            {slot.notes && <span className="text-xs text-gray-600 italic truncate max-w-[120px]">{slot.notes}</span>}
          </div>
        </div>
        <div className="shrink-0">
          {isFull ? (
            <span className="text-xs text-gray-500 bg-gray-700/30 px-2.5 py-1.5 rounded-lg">{t("full")}</span>
          ) : (
            <span className={`text-xs font-bold px-3 py-1.5 rounded-lg transition-colors ${expanded ? "bg-[#243b2e] text-green-400" : "bg-green-500/20 text-green-400 hover:bg-green-500/30"}`}>
              {expanded ? t("close") : t("book")}
            </span>
          )}
        </div>
      </button>

      {expanded && !isFull && (
        <div className="px-4 pb-4 border-t border-[#1e3028] pt-3 space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-400 w-16 shrink-0">{t("players")}</label>
            <div className="flex items-center gap-2">
              {[1, 2, 3, 4].filter(n => n <= slot.spotsLeft).map(n => (
                <button
                  key={n}
                  onClick={() => setPlayers(n)}
                  className={`w-8 h-8 rounded-lg text-sm font-bold border transition-all ${players === n ? "bg-[#C9A84C] border-[#C9A84C] text-black" : "border-[#243b2e] text-gray-400 hover:border-green-500/40"}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-400 w-16 shrink-0">{t("notes")}</label>
            <input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
              className="flex-1 bg-[#0b1512] border border-[#243b2e] rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-green-500/50"
            />
          </div>
          {slot.pricePaise > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">{t("total", { players, price: slot.priceDisplay })}</span>
              <span className="font-bold text-[#C9A84C]">₹{((slot.pricePaise * players) / 100).toFixed(0)}</span>
            </div>
          )}
          {error === "__auth__" ? (
            <p className="text-sm text-amber-400">
              <Trans i18nKey="signInPrompt" ns="publicBook" components={[<a href={`${baseUrl}/portal`} className="underline font-semibold" />]} />
            </p>
          ) : error ? (
            <p className="text-sm text-red-400">{error}</p>
          ) : null}
          <button
            onClick={book}
            disabled={loading}
            className="w-full py-2.5 rounded-xl font-semibold text-sm bg-[#C9A84C] text-black hover:bg-[#d4b55a] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <><span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" /> {t("processing")}</>
            ) : isFree ? t("confirmFree") : t("pay", { price: slot.priceDisplay, players })}
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Calendar Nav ───────────────────────────────────────────────── */

function CalendarNav({
  dates,
  activeDate,
  onSelect,
}: {
  dates: string[];
  activeDate: string;
  onSelect: (d: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="relative">
      <div ref={scrollRef} className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {dates.map(d => {
          const isActive = d === activeDate;
          const dt = new Date(d + "T00:00:00");
          return (
            <button
              key={d}
              onClick={() => onSelect(d)}
              className={`shrink-0 flex flex-col items-center px-3 py-2 rounded-xl border transition-all min-w-[52px] ${
                isActive
                  ? "bg-[#C9A84C] border-[#C9A84C] text-black"
                  : "border-[#1e3028] text-gray-400 hover:border-[#2d4a38] bg-[#111c17]"
              }`}
            >
              <span className="text-[10px] font-bold uppercase">{dt.toLocaleDateString(getLocale(), { weekday: "short", timeZone: "UTC" })}</span>
              <span className="text-lg font-extrabold leading-tight">{dt.getUTCDate()}</span>
              <span className="text-[9px]">{dt.toLocaleDateString(getLocale(), { month: "short", timeZone: "UTC" })}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────────────── */

export default function PublicBookPage() {
  const { t } = useTranslation("publicBook");
  const params = useParams<{ orgSlug: string }>();
  const orgSlug = params.orgSlug ?? "";

  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeDate, setActiveDate] = useState<string>("");
  const [confirmedBooking, setConfirmedBooking] = useState<{ booking: BookingResult; slot: Slot } | null>(null);

  const sseRef = useRef<EventSource | null>(null);

  // Load Razorpay script
  useEffect(() => {
    if (document.getElementById("razorpay-script")) return;
    const s = document.createElement("script");
    s.id = "razorpay-script";
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    document.head.appendChild(s);
  }, []);

  async function fetchSlots() {
    try {
      const res = await fetch(apiUrl(`/public/orgs/by-slug/${orgSlug}/marketplace`));
      if (!res.ok) { setError(t("errors.notAvailable")); return; }
      const data = await res.json();
      setOrg(data.organization);
      setSlots(data.slots ?? []);
      if (data.organization.primaryColor) {
        document.documentElement.style.setProperty("--org-primary", data.organization.primaryColor);
      }
      if (data.slots?.length > 0 && !activeDate) {
        const firstDate = new Date(data.slots[0].slotDate).toISOString().slice(0, 10);
        setActiveDate(firstDate);
      }
    } catch {
      setError(t("errors.failedToLoad"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSlots();

    const sse = new EventSource(apiUrl(`/public/orgs/by-slug/${orgSlug}/marketplace/stream`));
    sseRef.current = sse;
    sse.onopen = () => setConnected(true);
    sse.onerror = () => setConnected(false);
    sse.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "slot_update" || msg.type === "init") {
          fetchSlots();
        }
      } catch {}
    };

    return () => { sse.close(); };
  }, [orgSlug]);

  const grouped = groupByDate(slots);
  const dates = Object.keys(grouped).sort();
  const activeSlots = grouped[activeDate] ?? [];

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b1512] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-3 border-green-500/30 border-t-green-500 rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#0b1512] flex items-center justify-center">
        <div className="text-center p-8 max-w-sm">
          <Calendar className="mx-auto mb-3 text-gray-600" size={48} />
          <h2 className="text-white text-xl font-bold">{t("unavailable")}</h2>
          <p className="text-gray-400 mt-2 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b1512] font-sans">
      {/* Header */}
      <div className="bg-[#142019] border-b border-[#243b2e] sticky top-0 z-20">
        <div className="max-w-lg mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              {org?.logoUrl ? (
                <img src={org.logoUrl} alt={org.name} className="h-8 w-auto object-contain rounded" />
              ) : null}
              <div>
                <p className="text-[10px] font-bold tracking-widest uppercase text-[#C9A84C]">
                  {org?.name ?? <KharaGolfWordmark />}
                </p>
                <h1 className="text-white font-bold text-base leading-tight">{t("title")}</h1>
              </div>
            </div>
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold ${connected ? "bg-green-500/15 text-green-400 border border-green-500/30" : "bg-gray-500/15 text-gray-400 border border-gray-500/30"}`}>
              {connected ? <Wifi size={11} /> : <WifiOff size={11} />}
              {connected ? t("live") : "–"}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-4 space-y-4">
        {slots.length === 0 ? (
          <div className="text-center py-16">
            <Calendar className="mx-auto mb-3 text-gray-700" size={48} />
            <h2 className="text-white font-bold text-lg">{t("noSlots")}</h2>
            <p className="text-gray-400 text-sm mt-1">{t("noSlotsSub")}</p>
          </div>
        ) : (
          <>
            {/* Calendar picker */}
            <CalendarNav dates={dates} activeDate={activeDate} onSelect={setActiveDate} />

            {/* Date heading */}
            {activeDate && (
              <div className="flex items-center justify-between">
                <h2 className="text-white font-semibold">
                  {new Date(activeDate + "T00:00:00").toLocaleDateString(getLocale(), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}
                </h2>
                <span className="text-xs text-gray-500">{activeSlots.length} slot{activeSlots.length !== 1 ? "s" : ""}</span>
              </div>
            )}

            {/* Slot cards */}
            <div className="space-y-2">
              {activeSlots.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">{t("noSlotsDate")}</div>
              ) : (
                activeSlots.map(slot => (
                  <SlotCard
                    key={slot.id}
                    slot={slot}
                    orgSlug={orgSlug}
                    orgId={org!.id}
                    onBooked={(booking, s) => setConfirmedBooking({ booking, slot: s })}
                  />
                ))
              )}
            </div>

            {/* Info footer */}
            <div className="text-center text-[11px] text-gray-600 pt-2 space-y-1">
              <p>{t("footer")}</p>
              <p>{t("poweredBy")} <KharaGolfWordmark /></p>
            </div>
          </>
        )}
      </div>

      {/* Booking confirmation modal */}
      {confirmedBooking && org && (
        <BookingConfirmedModal
          booking={confirmedBooking.booking}
          slot={confirmedBooking.slot}
          org={org}
          onClose={() => { setConfirmedBooking(null); fetchSlots(); }}
          onCancelled={fetchSlots}
        />
      )}
    </div>
  );
}
