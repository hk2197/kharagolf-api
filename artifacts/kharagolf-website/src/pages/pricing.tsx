import { useEffect, useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { Check, X, Trophy, ArrowRight, Menu, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { applySeo, applyJsonLd } from "@/lib/seo";
import { trackFunnelEvent } from "@/lib/analytics";
import { RoiCalculator } from "@/components/RoiCalculator";
import { DemoBooking } from "@/components/DemoBooking";
import { useT, useLocale, SUPPORTED_SITE_LANGS } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

type Plan = {
  tier: string;
  label: string;
  priceMonthly: number;
  currency: string;
  description: string;
  maxActiveTournaments: number | null;
  maxMembers: number | null;
};

const FEATURE_MATRIX: { group: string; features: { name: string; tiers: Record<string, boolean | string> }[] }[] = [
  {
    group: "Tournaments",
    features: [
      { name: "Tournament formats supported", tiers: { starter: "4", pro: "14+", elite: "14+", enterprise: "14+ + custom" } },
      { name: "Live leaderboards", tiers: { starter: true, pro: true, elite: true, enterprise: true } },
      { name: "Automated pairings & flights", tiers: { starter: false, pro: true, elite: true, enterprise: true } },
      { name: "Multi-round / multi-course events", tiers: { starter: false, pro: true, elite: true, enterprise: true } },
      { name: "Side games & sweeps", tiers: { starter: false, pro: true, elite: true, enterprise: true } },
    ],
  },
  {
    group: "Handicaps & Members",
    features: [
      { name: "WHS-compliant handicap engine", tiers: { starter: true, pro: true, elite: true, enterprise: true } },
      { name: "Member portal & app", tiers: { starter: true, pro: true, elite: true, enterprise: true } },
      { name: "Membership billing & dues", tiers: { starter: false, pro: true, elite: true, enterprise: true } },
      { name: "Loyalty & rewards", tiers: { starter: false, pro: false, elite: true, enterprise: true } },
    ],
  },
  {
    group: "Operations",
    features: [
      { name: "Tee-sheet & bay bookings", tiers: { starter: false, pro: true, elite: true, enterprise: true } },
      { name: "Pro-shop POS & inventory", tiers: { starter: false, pro: false, elite: true, enterprise: true } },
      { name: "F&B on-course ordering", tiers: { starter: false, pro: false, elite: true, enterprise: true } },
      { name: "Dynamic pricing & yield mgmt", tiers: { starter: false, pro: false, elite: true, enterprise: true } },
    ],
  },
  {
    group: "Marketing & Insight",
    features: [
      { name: "Per-club marketing site", tiers: { starter: false, pro: true, elite: true, enterprise: true } },
      { name: "Email campaigns & drips", tiers: { starter: false, pro: false, elite: true, enterprise: true } },
      { name: "Business intelligence dashboards", tiers: { starter: false, pro: false, elite: true, enterprise: true } },
      { name: "Dedicated success manager", tiers: { starter: false, pro: false, elite: false, enterprise: true } },
      { name: "On-site go-live & training", tiers: { starter: false, pro: false, elite: false, enterprise: true } },
    ],
  },
];

const FAQS = [
  {
    q: "Is there a setup fee?",
    a: "No. Every plan includes guided onboarding, data import from your existing system, and admin training at no extra cost.",
  },
  {
    q: "Can we change plans later?",
    a: "Yes — you can upgrade or downgrade at any time. Changes take effect on the next billing cycle and are pro-rated.",
  },
  {
    q: "Do you charge per member or per tournament?",
    a: "Plans are flat-fee per club. There are no per-member or per-tournament surcharges within the limits of each tier.",
  },
  {
    q: "How long does it take to get live?",
    a: "Most clubs are live within 7–14 days. Enterprise migrations with custom integrations typically take 4–6 weeks.",
  },
  {
    q: "What about data ownership?",
    a: "Your data is yours. You can export every member, score, transaction and document at any time, and we will hand back a complete copy if you ever leave.",
  },
];

export default function Pricing() {
  const t = useT();
  const { lang } = useLocale();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");

  useEffect(() => {
    // Task #2204 — localised SEO metadata + hreflang alternates so a
    // Spanish/Hindi/Arabic visitor's social share preview matches the
    // language they actually saw on the page.
    applySeo({
      title: t("seo.pricing.title"),
      description: t("seo.pricing.description"),
      lang,
      alternates: { langs: SUPPORTED_SITE_LANGS, defaultLang: "en" },
    });
    applyJsonLd([
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "KHARAGOLF",
        description: "Tournament and club operating system for golf clubs.",
        brand: { "@type": "Brand", name: "KHARAGOLF" },
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "INR",
          lowPrice: "0",
          highPrice: "24999",
          offerCount: "4",
        },
      },
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: FAQS.map(f => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ]);
    trackFunnelEvent("pricing_view");
  }, [lang, t]);

  useEffect(() => {
    fetch("/api/onboarding/plans")
      .then(r => r.json())
      .then(setPlans)
      .catch(() => {});
  }, []);

  const tierOrder = ["starter", "pro", "elite", "enterprise"];
  const sortedPlans = [...plans].sort((a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier));
  const annualMultiplier = 10; // 2 months free

  return (
    <div className="min-h-screen bg-[#0A1A0F] text-[#F2F2F0] font-sans">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md border-b border-white/10 bg-[#0A1A0F]/95">
        <div className="container mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Trophy className="w-8 h-8 text-[#C9A84C]" />
            <span className="font-serif font-bold text-xl tracking-wider">KHARAGOLF</span>
          </Link>
          <div className="hidden md:flex items-center gap-8 text-sm font-medium">
            <Link href="/" className="hover:text-[#C9A84C]">{t("nav.home")}</Link>
            <Link href="/features" className="hover:text-[#C9A84C]">{t("nav.features")}</Link>
            <Link href="/pricing" className="text-[#C9A84C]">{t("nav.pricing")}</Link>
            <LanguageSwitcher />
            <a href="#demo" className="bg-[#C9A84C] text-[#0A1A0F] px-6 py-2.5 hover:bg-[#D4B662] font-bold uppercase text-xs">{t("nav.bookDemo")}</a>
          </div>
          <Link href="/" className="md:hidden text-white"><Menu /></Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-36 pb-16 bg-gradient-to-b from-[#071208] to-[#0A1A0F]">
        <div className="container mx-auto px-6 text-center max-w-3xl">
          <Badge variant="outline" className="border-[#C9A84C] text-[#C9A84C] uppercase tracking-widest bg-transparent rounded-none px-3 py-1 mb-6">
            {t("pricing.kicker")}
          </Badge>
          <h1 className="text-5xl md:text-6xl font-serif mb-6" data-testid="pricing-title">{t("pricing.title")}</h1>
          <p className="text-white/60 text-lg font-light leading-relaxed">
            {t("pricing.subtitle")}
          </p>

          {/* Billing toggle */}
          <div className="inline-flex items-center gap-2 bg-white/5 border border-white/10 p-1 mt-10">
            <button
              onClick={() => setBilling("monthly")}
              className={`px-5 py-2 text-xs font-bold uppercase tracking-widest ${billing === "monthly" ? "bg-[#C9A84C] text-[#0A1A0F]" : "text-white/60"}`}
              data-testid="billing-monthly"
            >
              {t("pricing.billing.monthly")}
            </button>
            <button
              onClick={() => setBilling("annual")}
              className={`px-5 py-2 text-xs font-bold uppercase tracking-widest ${billing === "annual" ? "bg-[#C9A84C] text-[#0A1A0F]" : "text-white/60"}`}
              data-testid="billing-annual"
            >
              {t("pricing.billing.annual")} <span className="ml-1 text-[10px] opacity-70">{t("pricing.billing.annualSave")}</span>
            </button>
          </div>
        </div>
      </section>

      {/* Plans */}
      <section className="py-16">
        <div className="container mx-auto px-6">
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto">
            {(sortedPlans.length > 0 ? sortedPlans : Array.from({ length: 4 })).map((plan, i) => {
              if (!plan) {
                return <div key={i} className="border border-white/5 bg-[#122E1A] p-8 h-[480px] animate-pulse" />;
              }
              const p = plan as Plan;
              const isPro = p.tier === "pro";
              const annualPrice = p.priceMonthly === 0 ? 0 : Math.round(p.priceMonthly * annualMultiplier);
              const displayPrice = billing === "monthly" ? p.priceMonthly : annualPrice;
              const suffix = p.priceMonthly === 0 ? "" : billing === "monthly" ? "/mo" : "/yr";
              return (
                <motion.div
                  key={p.tier}
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.05 }}
                  className={`relative p-8 flex flex-col border ${isPro ? "border-[#C9A84C] bg-[#C9A84C]/5" : "border-white/10 bg-[#122E1A]"}`}
                  data-testid={`plan-${p.tier}`}
                >
                  {isPro && (
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#C9A84C] text-[#0A1A0F] px-3 py-1 text-xs font-bold uppercase tracking-widest">
                      {t("pricing.plan.mostPopular")}
                    </div>
                  )}
                  <h3 className="text-xl font-medium mb-2 capitalize">{p.label}</h3>
                  <div className="mb-6">
                    <span className="text-4xl font-serif">
                      {displayPrice === 0 ? t("pricing.plan.free") : `₹${displayPrice.toLocaleString("en-IN")}`}
                    </span>
                    {displayPrice > 0 && <span className="text-white/50 text-sm">{suffix === "/mo" ? t("pricing.plan.suffix.monthly") : t("pricing.plan.suffix.annual")}</span>}
                  </div>
                  <p className="text-sm text-white/60 font-light mb-8 flex-grow">{p.description}</p>
                  <div className="space-y-4 mb-8 text-sm border-t border-white/10 pt-6">
                    <div className="flex justify-between"><span className="text-white/60">{t("pricing.plan.members")}</span><span className="font-medium">{p.maxMembers ?? t("pricing.plan.unlimited")}</span></div>
                    <div className="flex justify-between"><span className="text-white/60">{t("pricing.plan.activeEvents")}</span><span className="font-medium">{p.maxActiveTournaments ?? t("pricing.plan.unlimited")}</span></div>
                  </div>
                  <Button asChild className={`w-full rounded-none ${isPro ? "bg-[#C9A84C] text-[#0A1A0F] hover:bg-[#D4B662]" : "border border-white/20 bg-transparent text-white hover:bg-white/5"}`}>
                    <a href="#demo" onClick={() => trackFunnelEvent("cta_click", { source: "pricing-card", tier: p.tier })}>
                      {p.tier === "enterprise" ? t("pricing.plan.cta.enterprise") : t("pricing.plan.cta.default")}
                    </a>
                  </Button>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Feature matrix */}
      <section className="py-20 bg-[#071208] border-y border-white/5">
        <div className="container mx-auto px-6 max-w-6xl">
          <h2 className="text-3xl md:text-4xl font-serif text-center mb-12">{t("pricing.compare.title")}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="feature-matrix">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left py-4 px-4 font-medium text-white/40 uppercase tracking-wider text-xs">Feature</th>
                  {tierOrder.map(t => (
                    <th key={t} className={`py-4 px-4 text-center font-medium uppercase tracking-wider text-xs ${t === "pro" ? "text-[#C9A84C]" : "text-white/60"}`}>
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
                {FEATURE_MATRIX.map(group => (
                  <tbody key={group.group}>
                    <tr>
                      <td colSpan={5} className="pt-8 pb-3 px-4 text-[#C9A84C] uppercase tracking-widest text-xs font-bold">{group.group}</td>
                    </tr>
                    {group.features.map(f => (
                      <tr key={f.name} className="border-b border-white/5">
                        <td className="py-3 px-4 text-white/80">{f.name}</td>
                        {tierOrder.map(t => {
                          const v = f.tiers[t];
                          return (
                            <td key={t} className={`py-3 px-4 text-center ${t === "pro" ? "bg-[#C9A84C]/5" : ""}`}>
                              {typeof v === "string" ? (
                                <span className="text-white/80">{v}</span>
                              ) : v ? (
                                <Check className="w-4 h-4 text-[#C9A84C] inline" />
                              ) : (
                                <X className="w-4 h-4 text-white/20 inline" />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                ))}
            </table>
          </div>
        </div>
      </section>

      {/* ROI Calculator */}
      <RoiCalculator />

      {/* FAQ */}
      <section className="py-24 bg-[#0A1A0F]">
        <div className="container mx-auto px-6 max-w-3xl">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 text-[#C9A84C] uppercase tracking-[0.3em] text-xs mb-4">
              <Sparkles className="w-4 h-4" /> {t("pricing.faq.kicker")}
            </div>
            <h2 className="text-3xl md:text-4xl font-serif">{t("pricing.faq.title")}</h2>
          </div>
          <div className="space-y-4" data-testid="faq-list">
            {FAQS.map((f, i) => (
              <details key={i} className="group bg-[#122E1A] border border-white/10 p-6 cursor-pointer">
                <summary className="font-medium text-base list-none flex items-center justify-between">
                  {f.q}
                  <ArrowRight className="w-4 h-4 text-[#C9A84C] transition-transform group-open:rotate-90" />
                </summary>
                <p className="mt-4 text-white/60 leading-relaxed">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Demo */}
      <section id="demo" className="py-24 bg-gradient-to-b from-[#0A1A0F] to-[#071208]">
        <div className="container mx-auto px-6">
          <div className="text-center max-w-3xl mx-auto mb-12">
            <h2 className="text-3xl md:text-5xl font-serif mb-4">{t("pricing.demo.title")}</h2>
            <p className="text-white/60 font-light">{t("pricing.demo.subtitle")}</p>
          </div>
          <DemoBooking />
        </div>
      </section>

      <footer className="bg-[#050D08] py-10 border-t border-white/5 text-center text-sm text-white/30" data-testid="pricing-footer-copyright">
        {t("footer.copyright", { year: new Date().getFullYear() })}
      </footer>
    </div>
  );
}
