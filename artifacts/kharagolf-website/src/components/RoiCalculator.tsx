import { useEffect, useMemo, useState } from "react";
import { Calculator, Sparkles, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { trackFunnelEvent } from "@/lib/analytics";

type RoiResult = {
  totalAnnual: number;
  netRoi: number;
  platformCostAnnual: number;
  roiMultiple: number | null;
  breakdown: {
    staffSavingsAnnual: number;
    paperSavingsAnnual: number;
    retentionUplift: number;
    hoursSavedAnnual: number;
  };
};

const fmtINR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function RoiCalculator() {
  const { toast } = useToast();
  const [members, setMembers] = useState(450);
  const [tournaments, setTournaments] = useState(12);
  const [hoursPerEvent, setHoursPerEvent] = useState(12);
  const [hourlyRate, setHourlyRate] = useState(800);
  const [uplift, setUplift] = useState(8);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [clubName, setClubName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [serverResult, setServerResult] = useState<RoiResult | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // Fast client-side preview — keeps the UI responsive while users tweak sliders.
  const local = useMemo<RoiResult>(() => {
    const hoursSaved = hoursPerEvent * 0.7;
    const staff = Math.round(hoursSaved * hourlyRate * tournaments);
    const paper = Math.round(1500 * tournaments);
    const retention = Math.round(members * 18000 * (uplift / 100));
    const total = staff + paper + retention;
    const platformCost = tournaments <= 4 ? 0 : tournaments <= 24 ? 9999 * 12 : 24999 * 12;
    return {
      totalAnnual: total,
      netRoi: total - platformCost,
      platformCostAnnual: platformCost,
      roiMultiple: platformCost > 0 ? +(total / platformCost).toFixed(1) : null,
      breakdown: {
        staffSavingsAnnual: staff,
        paperSavingsAnnual: paper,
        retentionUplift: retention,
        hoursSavedAnnual: +(hoursSaved * tournaments).toFixed(0),
      },
    };
  }, [members, tournaments, hoursPerEvent, hourlyRate, uplift]);

  const display = serverResult ?? local;

  useEffect(() => {
    trackFunnelEvent("roi_calc_started");
  }, []);

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !name) {
      toast({ title: "Almost there", description: "Add your name and email so we can send you the report.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/public/roi-calculation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, email, clubName: clubName || undefined,
          members, tournamentsPerYear: tournaments,
          hoursPerTournament: hoursPerEvent, hourlyRate,
          greenFeeUplift: uplift,
        }),
      });
      if (!res.ok) throw new Error("calc failed");
      const data = (await res.json()) as RoiResult;
      setServerResult(data);
      setSubmitted(true);
      trackFunnelEvent("roi_lead_captured", { totalAnnual: data.totalAnnual });
      trackFunnelEvent("roi_calc_completed", { totalAnnual: data.totalAnnual });
      toast({ title: "Report sent", description: `Check ${email} for your full ROI breakdown.` });
    } catch {
      toast({ title: "Couldn't send report", description: "Please try again in a moment.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section id="roi" className="py-32 bg-[#071208] border-y border-white/5">
      <div className="container mx-auto px-6">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 text-[#C9A84C] uppercase tracking-[0.3em] text-xs mb-4">
            <Sparkles className="w-4 h-4" /> ROI Calculator
          </div>
          <h2 className="text-3xl md:text-5xl font-serif mb-6">See what KHARAGOLF returns to your club.</h2>
          <p className="text-white/60 font-light text-lg">
            Move the sliders to match your club's profile. We'll compute the recovered staff hours,
            print costs eliminated, and member-retention uplift you can expect in year one.
          </p>
        </div>

        <div className="grid lg:grid-cols-5 gap-8 max-w-7xl mx-auto">
          {/* Inputs */}
          <div className="lg:col-span-3 bg-[#0A1A0F] border border-white/10 p-8 md:p-10">
            <div className="space-y-8">
              <SliderRow
                label="Active members"
                value={members}
                min={50}
                max={3000}
                step={25}
                display={members.toLocaleString("en-IN")}
                onChange={setMembers}
                testId="roi-members"
              />
              <SliderRow
                label="Tournaments per year"
                value={tournaments}
                min={1}
                max={60}
                step={1}
                display={String(tournaments)}
                onChange={setTournaments}
                testId="roi-tournaments"
              />
              <SliderRow
                label="Admin hours per tournament"
                value={hoursPerEvent}
                min={2}
                max={40}
                step={1}
                display={`${hoursPerEvent} h`}
                onChange={setHoursPerEvent}
                testId="roi-hours"
              />
              <SliderRow
                label="Loaded hourly cost (₹)"
                value={hourlyRate}
                min={200}
                max={3000}
                step={50}
                display={fmtINR(hourlyRate)}
                onChange={setHourlyRate}
                testId="roi-rate"
              />
              <SliderRow
                label="Expected revenue uplift"
                value={uplift}
                min={0}
                max={25}
                step={1}
                display={`${uplift}%`}
                onChange={setUplift}
                testId="roi-uplift"
              />
            </div>
          </div>

          {/* Results */}
          <div className="lg:col-span-2 bg-gradient-to-br from-[#C9A84C]/10 via-[#0D2214] to-[#0A1A0F] border border-[#C9A84C]/30 p-8 md:p-10 flex flex-col">
            <div className="flex items-center gap-2 text-[#C9A84C] uppercase tracking-[0.3em] text-xs mb-6">
              <Calculator className="w-4 h-4" /> Your estimate
            </div>
            <div className="mb-6">
              <div className="text-xs uppercase tracking-widest text-white/40 mb-2">Annual value</div>
              <div className="text-4xl md:text-5xl font-serif text-[#C9A84C]" data-testid="roi-total">
                {fmtINR(display.totalAnnual)}
              </div>
              {display.roiMultiple && (
                <div className="text-sm text-white/60 mt-2">
                  {display.roiMultiple}× return on platform investment
                </div>
              )}
            </div>

            <div className="space-y-3 text-sm border-t border-white/10 pt-6 mb-6">
              <Row label="Staff hours recovered" value={`${display.breakdown.hoursSavedAnnual.toLocaleString("en-IN")} h/yr`} />
              <Row label="Staff cost saved" value={fmtINR(display.breakdown.staffSavingsAnnual)} />
              <Row label="Paper / printing eliminated" value={fmtINR(display.breakdown.paperSavingsAnnual)} />
              <Row label="Retention uplift" value={fmtINR(display.breakdown.retentionUplift)} />
              <Row label="Platform cost" value={display.platformCostAnnual === 0 ? "Free" : fmtINR(display.platformCostAnnual)} subtle />
            </div>

            {!submitted ? (
              <form onSubmit={handleEmail} className="mt-auto space-y-3" data-testid="roi-lead-form">
                <Input
                  className="bg-white/5 border-white/10 rounded-none h-11 focus-visible:ring-[#C9A84C]"
                  placeholder="Your name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  data-testid="roi-name"
                />
                <Input
                  className="bg-white/5 border-white/10 rounded-none h-11 focus-visible:ring-[#C9A84C]"
                  placeholder="Work email"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  data-testid="roi-email"
                />
                <Input
                  className="bg-white/5 border-white/10 rounded-none h-11 focus-visible:ring-[#C9A84C]"
                  placeholder="Club name (optional)"
                  value={clubName}
                  onChange={e => setClubName(e.target.value)}
                  data-testid="roi-club"
                />
                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-12 bg-[#C9A84C] text-[#0A1A0F] hover:bg-[#D4B662] rounded-none font-bold uppercase tracking-widest"
                  data-testid="roi-submit"
                >
                  {submitting ? "Sending…" : "Email me the full report"}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </form>
            ) : (
              <div className="mt-auto text-sm text-white/70 leading-relaxed border-t border-white/10 pt-6">
                Report sent. A KHARAGOLF specialist will follow up within one business day —
                or <a href="#demo" className="text-[#C9A84C] underline">book a demo now</a>.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({ label, value, subtle }: { label: string; value: string; subtle?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${subtle ? "text-white/40" : "text-white/80"}`}>
      <span className="font-light">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function SliderRow({
  label, value, min, max, step, display, onChange, testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
  testId: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-bold uppercase tracking-wider text-white/50">{label}</label>
        <span className="text-[#C9A84C] font-medium tabular-nums" data-testid={`${testId}-display`}>{display}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={v => onChange(v[0] ?? value)}
        data-testid={testId}
      />
    </div>
  );
}
