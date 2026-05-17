import { useEffect, useMemo, useState } from "react";
import { Calendar, Clock, Globe, ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { trackFunnelEvent } from "@/lib/analytics";
import { useT, useLocale } from "@/lib/i18n";

// Task #2202 — All visitor-facing copy is routed through the site i18n bundle
// so es/hi/ar visitors see the booking widget in their chosen language. Date
// and time labels go through `Intl.DateTimeFormat(lang)` for the same reason
// — otherwise weekday/month names would still render in English. The internal
// `en-CA` day-key inside `slotsByDay` stays English because it is a stable
// `YYYY-MM-DD` map key used only for bucketing, never shown to visitors.

type Slot = { startUtc: string; endUtc: string };

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
}

export function DemoBooking() {
  const { toast } = useToast();
  const t = useT();
  const { lang } = useLocale();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(true);
  const [tz, setTz] = useState<string>(detectTimezone());
  const [selected, setSelected] = useState<Slot | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    clubName: "",
    phone: "",
    interest: "_empty",
    message: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState<Slot | null>(null);

  useEffect(() => {
    fetch("/api/public/demo-slots")
      .then(r => r.json())
      .then((data: { slots: Slot[] }) => setSlots(data.slots ?? []))
      .catch(() => setSlots([]))
      .finally(() => setLoadingSlots(false));
  }, []);

  const slotsByDay = useMemo(() => {
    const buckets: { day: string; label: string; slots: Slot[] }[] = [];
    const seen = new Map<string, number>();
    for (const s of slots) {
      const d = new Date(s.startUtc);
      const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
      const idx = seen.get(dayKey);
      if (idx == null) {
        seen.set(dayKey, buckets.length);
        const label = new Intl.DateTimeFormat(lang, { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
        buckets.push({ day: dayKey, label, slots: [s] });
      } else {
        buckets[idx].slots.push(s);
      }
    }
    return buckets.slice(0, 7);
  }, [slots, tz, lang]);

  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(lang, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const tzLabel = useMemo(() => {
    try {
      const parts = new Intl.DateTimeFormat(lang, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date());
      return parts.find(p => p.type === "timeZoneName")?.value ?? tz;
    } catch {
      return tz;
    }
  }, [tz, lang]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) {
      toast({ title: t("demoBooking.toast.pickTime.title"), description: t("demoBooking.toast.pickTime.desc"), variant: "destructive" });
      return;
    }
    if (!form.name || !form.email) {
      toast({ title: t("demoBooking.toast.addDetails.title"), description: t("demoBooking.toast.addDetails.desc"), variant: "destructive" });
      return;
    }
    setSubmitting(true);
    trackFunnelEvent("demo_booking_submitted", { startUtc: selected.startUtc, tz });
    try {
      const res = await fetch("/api/public/demo-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          interest: form.interest === "_empty" ? undefined : form.interest,
          startUtc: selected.startUtc,
          timezone: tz,
        }),
      });
      if (!res.ok) throw new Error("booking failed");
      setConfirmed(selected);
      trackFunnelEvent("demo_booking_confirmed", { startUtc: selected.startUtc, tz });
      toast({ title: t("demoBooking.toast.booked.title"), description: t("demoBooking.toast.booked.desc") });
    } catch {
      toast({ title: t("demoBooking.toast.failed.title"), description: t("demoBooking.toast.failed.desc"), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  if (confirmed) {
    return (
      <div className="bg-[#0A1A0F] border border-[#C9A84C]/40 p-10 text-center max-w-2xl mx-auto" data-testid="demo-confirmed">
        <div className="w-14 h-14 rounded-full bg-[#C9A84C] text-[#0A1A0F] flex items-center justify-center mx-auto mb-6">
          <Check className="w-7 h-7" />
        </div>
        <h3 className="text-2xl font-serif mb-3 text-white">{t("demoBooking.confirmed.heading")}</h3>
        <p className="text-white/70 mb-1">
          {new Intl.DateTimeFormat(lang, {
            timeZone: tz, weekday: "long", day: "numeric", month: "long",
            hour: "numeric", minute: "2-digit", timeZoneName: "short",
          }).format(new Date(confirmed.startUtc))}
        </p>
        <p className="text-white/40 text-sm">
          {t("demoBooking.confirmed.note", { email: form.email })}
        </p>
      </div>
    );
  }

  return (
    <div className="grid lg:grid-cols-2 gap-10 max-w-6xl mx-auto" data-testid="demo-booking">
      {/* Calendar */}
      <div className="bg-[#0A1A0F] border border-white/10 p-8">
        <div className="flex items-center gap-2 text-[#C9A84C] uppercase tracking-[0.3em] text-xs mb-6">
          <Calendar className="w-4 h-4" /> {t("demoBooking.calendarHeading")}
        </div>

        <div className="flex items-center gap-2 mb-6 text-sm text-white/60">
          <Globe className="w-4 h-4 text-[#C9A84C]" />
          <Select value={tz} onValueChange={setTz}>
            <SelectTrigger className="bg-transparent border-white/10 text-white h-9 rounded-none w-auto" data-testid="demo-tz">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#122E1A] border-white/10 text-white max-h-72">
              {[
                "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo",
                "Europe/London", "Europe/Paris",
                "America/New_York", "America/Los_Angeles", "Australia/Sydney",
              ].map(z => (
                <SelectItem key={z} value={z}>{z.replace("_", " ")} ({tzLabel === z ? "" : ""})</SelectItem>
              ))}
              {!["Asia/Kolkata","Asia/Dubai","Asia/Singapore","Asia/Tokyo","Europe/London","Europe/Paris","America/New_York","America/Los_Angeles","Australia/Sydney"].includes(tz) && (
                <SelectItem value={tz}>{tz}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>

        {loadingSlots ? (
          <div className="text-white/40 text-sm">{t("demoBooking.loadingSlots")}</div>
        ) : slotsByDay.length === 0 ? (
          <div className="text-white/40 text-sm">{t("demoBooking.noSlots")}</div>
        ) : (
          <div className="space-y-5 max-h-[420px] overflow-y-auto pr-2">
            {slotsByDay.map(group => (
              <div key={group.day}>
                <div className="text-xs uppercase tracking-widest text-white/40 mb-2">{group.label}</div>
                <div className="grid grid-cols-3 gap-2">
                  {group.slots.map(s => {
                    const active = selected?.startUtc === s.startUtc;
                    return (
                      <button
                        key={s.startUtc}
                        type="button"
                        onClick={() => {
                          setSelected(s);
                          trackFunnelEvent("demo_slot_selected", { startUtc: s.startUtc, tz });
                        }}
                        className={`text-sm py-2 border transition-colors ${active ? "bg-[#C9A84C] text-[#0A1A0F] border-[#C9A84C] font-bold" : "border-white/10 text-white/80 hover:border-[#C9A84C]/60 hover:text-[#C9A84C]"}`}
                        data-testid={`demo-slot-${s.startUtc}`}
                      >
                        <Clock className="w-3 h-3 inline mr-1 -mt-0.5" />
                        {formatTime(s.startUtc)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="bg-[#0A1A0F] border border-white/10 p-8 space-y-4" data-testid="demo-form">
        <div className="text-[#C9A84C] uppercase tracking-[0.3em] text-xs mb-2">{t("demoBooking.detailsHeading")}</div>

        <div className="grid sm:grid-cols-2 gap-3">
          <Input className="bg-white/5 border-white/10 rounded-none h-11 focus-visible:ring-[#C9A84C]" placeholder={t("demoBooking.input.name")} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} data-testid="input-demo-name" />
          <Input type="email" className="bg-white/5 border-white/10 rounded-none h-11 focus-visible:ring-[#C9A84C]" placeholder={t("demoBooking.input.email")} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} data-testid="input-demo-email" />
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Input className="bg-white/5 border-white/10 rounded-none h-11 focus-visible:ring-[#C9A84C]" placeholder={t("demoBooking.input.club")} value={form.clubName} onChange={e => setForm({ ...form, clubName: e.target.value })} data-testid="input-demo-club" />
          <Input className="bg-white/5 border-white/10 rounded-none h-11 focus-visible:ring-[#C9A84C]" placeholder={t("demoBooking.input.phone")} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} data-testid="input-demo-phone" />
        </div>

        <Select value={form.interest} onValueChange={v => setForm({ ...form, interest: v })}>
          <SelectTrigger className="bg-white/5 border-white/10 rounded-none h-11 focus:ring-[#C9A84C]" data-testid="select-demo-interest">
            <SelectValue placeholder={t("demoBooking.interest.placeholder")} />
          </SelectTrigger>
          <SelectContent className="bg-[#122E1A] border-white/10 text-white">
            <SelectItem value="_empty">{t("demoBooking.interest.empty")}</SelectItem>
            <SelectItem value="tournaments">{t("demoBooking.interest.tournaments")}</SelectItem>
            <SelectItem value="handicaps">{t("demoBooking.interest.handicaps")}</SelectItem>
            <SelectItem value="league">{t("demoBooking.interest.league")}</SelectItem>
            <SelectItem value="full">{t("demoBooking.interest.full")}</SelectItem>
          </SelectContent>
        </Select>

        <Textarea className="bg-white/5 border-white/10 rounded-none min-h-[88px] focus-visible:ring-[#C9A84C]" placeholder={t("demoBooking.input.message")} value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} data-testid="input-demo-message" />

        <div className="text-xs text-white/40 border-t border-white/10 pt-3">
          {selected ? (
            <span className="text-[#C9A84C]">{t("demoBooking.selected", { when: new Intl.DateTimeFormat(lang, { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(selected.startUtc)) })}</span>
          ) : (
            <span>{t("demoBooking.pickPrompt")}</span>
          )}
        </div>

        <Button type="submit" disabled={submitting || !selected} className="w-full h-12 bg-[#C9A84C] text-[#0A1A0F] hover:bg-[#D4B662] rounded-none font-bold uppercase tracking-widest disabled:opacity-50" data-testid="button-submit-demo">
          {submitting ? t("demoBooking.submitting") : t("demoBooking.submit")}
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </form>
    </div>
  );
}
