import { Trophy, Printer } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { SiteKey } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

const Check = () => (
  <span className="text-green-500 text-sm mt-0.5 flex-shrink-0">✓</span>
);

function FeatureGrid({ items }: { items: string[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2">
          <Check />
          <span className="text-sm text-[#c0d4c8] leading-relaxed">{item}</span>
        </div>
      ))}
    </div>
  );
}

function SectionTitle({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <h2 className="font-serif text-lg font-bold text-[#C9A84C] tracking-wide mb-5 flex items-center gap-2">
      <span className="text-xl">{icon}</span>
      {children}
    </h2>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold text-[#C9A84C] uppercase tracking-[0.12em] mt-5 mb-2.5 first:mt-0">
      {children}
    </p>
  );
}

function Section({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`px-10 py-8 border-b border-[#1a2f20] print:px-8 print:py-6 print:break-inside-avoid ${className}`}>
      {children}
    </section>
  );
}

/**
 * Build a numbered run of i18n keys for a section's bullet list, e.g.
 * `gridKeys("capability.sec.tournament", 21)` returns
 * ["capability.sec.tournament.i1", ..., "capability.sec.tournament.i21"].
 *
 * Centralised so we only have one place to bump the count when sales asks
 * to add or trim a feature bullet, and so the JSX stays readable.
 */
function gridKeys(prefix: string, count: number): SiteKey[] {
  return Array.from({ length: count }, (_, i) => `${prefix}.i${i + 1}` as SiteKey);
}

export default function CapabilityReport() {
  const t = useT();

  // Render the second intro paragraph by interleaving styled audience
  // labels into the translated template at the {{admin}} / {{players}} /
  // {{sponsors}} markers. We do this manually (rather than via the
  // `interpolate` helper) so each label keeps its own brand colour AND
  // the placeholder ordering stays grammatically correct in every
  // locale — the integrity test in `__tests__/site.test.ts` pins those
  // placeholders so translators can't drop them accidentally.
  const introTemplate = t("capability.intro.p2");
  const introParts = introTemplate.split(/(\{\{(?:admin|players|sponsors)\}\})/);
  const introNodes = introParts.map((part, i) => {
    if (part === "{{admin}}") {
      return (
        <strong key={i} className="text-[#C9A84C]">
          {t("capability.intro.audience.admin")}
        </strong>
      );
    }
    if (part === "{{players}}") {
      return (
        <strong key={i} className="text-green-400">
          {t("capability.intro.audience.player")}
        </strong>
      );
    }
    if (part === "{{sponsors}}") {
      return (
        <strong key={i} className="text-blue-300">
          {t("capability.intro.audience.sponsor")}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });

  return (
    <div className="min-h-screen bg-[#0A1A0F] text-[#F2F2F0] font-sans">
      {/* Sticky Print Header */}
      <div className="sticky top-0 z-50 bg-[#0A1A0F]/95 backdrop-blur-md border-b border-[#C9A84C]/40 px-6 h-16 flex items-center justify-between print:hidden">
        <div className="flex items-center gap-2">
          <Trophy className="w-6 h-6 text-[#C9A84C]" />
          <span className="font-serif font-bold text-lg tracking-wider">
            <span className="text-white">KHARA</span><span className="text-[#C9A84C]">GOLF</span>
          </span>
          <span className="text-[#C9A84C] font-mono text-[10px] ml-2 uppercase tracking-widest opacity-80">{t("capability.kicker")}</span>
        </div>
        <div className="flex items-center gap-3">
          <LanguageSwitcher />
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 bg-[#C9A84C] text-[#0A1A0F] px-5 py-2 text-xs font-bold uppercase tracking-widest hover:bg-[#D4B662] transition-colors"
          >
            <Printer className="w-3.5 h-3.5" />
            {t("capability.print")}
          </button>
        </div>
      </div>

      {/* Report Container */}
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="bg-gradient-to-b from-[#0A1A0F] to-[#112318] border-b-2 border-[#C9A84C] px-10 py-14 text-center">
          <div className="font-serif text-5xl font-black tracking-[0.18em] uppercase leading-none mb-3">
            <span className="text-white">KHARA</span><span className="text-[#C9A84C]">GOLF</span>
          </div>
          <div className="text-[11px] font-semibold tracking-[0.35em] uppercase text-[#C9A84C] opacity-85 mb-1.5">
            {t("capability.subtitle")}
          </div>
          <div className="text-sm text-[#7aab8a] italic tracking-wide">"{t("capability.quote")}"</div>
        </div>

        {/* Intro */}
        <div className="bg-[#112318] px-10 py-9 border-b border-[#1e3325]">
          <p className="text-sm text-[#c8d8cc] leading-relaxed mb-3">
            {t("capability.intro.p1")}
          </p>
          <p className="text-sm text-[#c8d8cc] leading-relaxed">
            {introNodes}
          </p>
        </div>

        {/* Platform Channels */}
        <Section className="bg-[#0f1a12]">
          <SectionTitle icon="🖥️">{t("capability.sec.channels.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.channels", 8).map(k => t(k))} />
        </Section>

        {/* Tournament Engine */}
        <Section className="bg-[#111c15]">
          <SectionTitle icon="🏆">{t("capability.sec.tournament.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.tournament", 21).map(k => t(k))} />
        </Section>

        {/* League Management */}
        <Section className="bg-[#0f1a12]">
          <SectionTitle icon="⛳">{t("capability.sec.league.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.league", 5).map(k => t(k))} />
        </Section>

        {/* WHS Engine */}
        <Section className="bg-[#111c15]">
          <SectionTitle icon="📊">{t("capability.sec.whs.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.whs", 6).map(k => t(k))} />
        </Section>

        {/* Live Scoring */}
        <Section className="bg-[#0f1a12]">
          <SectionTitle icon="📍">{t("capability.sec.scoring.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.scoring", 5).map(k => t(k))} />
        </Section>

        {/* GPS & Shot Tracking */}
        <Section className="bg-[#111c15]">
          <SectionTitle icon="🛰️">{t("capability.sec.gps.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.gps", 4).map(k => t(k))} />
        </Section>

        {/* Player Analytics */}
        <Section className="bg-[#0f1a12]">
          <SectionTitle icon="📈">{t("capability.sec.analytics.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.analytics", 8).map(k => t(k))} />
        </Section>

        {/* Achievements */}
        <Section className="bg-[#111c15]">
          <SectionTitle icon="🏅">{t("capability.sec.achievements.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.achievements", 6).map(k => t(k))} />
        </Section>

        {/* Membership & Admin */}
        <Section className="bg-[#0f1a12]">
          <SectionTitle icon="👥">{t("capability.sec.membership.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.membership", 6).map(k => t(k))} />
        </Section>

        {/* Payments */}
        <Section className="bg-[#111c15]">
          <SectionTitle icon="💳">{t("capability.sec.payments.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.payments", 6).map(k => t(k))} />
        </Section>

        {/* Communications */}
        <Section className="bg-[#0f1a12]">
          <SectionTitle icon="📣">{t("capability.sec.communications.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.communications", 6).map(k => t(k))} />
        </Section>

        {/* Branding & Sponsorship */}
        <Section className="bg-[#111c15]">
          <SectionTitle icon="🎨">{t("capability.sec.branding.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.branding", 8).map(k => t(k))} />
        </Section>

        {/* Pro Shop & E-Commerce */}
        <Section className="bg-[#0f1a12]">
          <SectionTitle icon="🛍️">{t("capability.sec.proshop.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.proshop", 8).map(k => t(k))} />
        </Section>

        {/* Facilities */}
        <Section className="bg-[#111c15]">
          <SectionTitle icon="🏗️">{t("capability.sec.facilities.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.facilities", 8).map(k => t(k))} />
        </Section>

        {/* Tee Time Booking */}
        <Section className="bg-[#0f1a12]">
          <SectionTitle icon="📅">{t("capability.sec.teetime.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.teetime", 4).map(k => t(k))} />
        </Section>

        {/* Social & Community */}
        <Section className="bg-[#111c15]">
          <SectionTitle icon="🌐">{t("capability.sec.social.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.social", 6).map(k => t(k))} />
        </Section>

        {/* Multi-Club SaaS */}
        <Section className="bg-[#0f1a12]">
          <SectionTitle icon="☁️">{t("capability.sec.saas.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.saas", 4).map(k => t(k))} />
        </Section>

        {/* Integrations & API */}
        <Section className="bg-[#111c15]">
          <SectionTitle icon="🔌">{t("capability.sec.integrations.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.integrations", 6).map(k => t(k))} />
        </Section>

        {/* Multi-Language */}
        <Section className="bg-[#0f1a12]">
          <SectionTitle icon="🌍">{t("capability.sec.lang.title")}</SectionTitle>
          <FeatureGrid items={gridKeys("capability.sec.lang", 13).map(k => t(k))} />
        </Section>

        {/* Native Apps */}
        <Section className="bg-[#111c15]">
          <SectionTitle icon="📱">{t("capability.sec.apps.title")}</SectionTitle>

          <SubHeading>{t("capability.sec.apps.ios.heading")}</SubHeading>
          <div className="mb-6">
            <FeatureGrid items={gridKeys("capability.sec.apps.ios", 4).map(k => t(k))} />
          </div>

          <SubHeading>{t("capability.sec.apps.android.heading")}</SubHeading>
          <div className="mb-6">
            <FeatureGrid items={gridKeys("capability.sec.apps.android", 4).map(k => t(k))} />
          </div>

          <SubHeading>{t("capability.sec.apps.watchos.heading")}</SubHeading>
          <div className="mb-6">
            <FeatureGrid items={gridKeys("capability.sec.apps.watchos", 4).map(k => t(k))} />
          </div>

          <SubHeading>{t("capability.sec.apps.wearos.heading")}</SubHeading>
          <div className="mb-6">
            <FeatureGrid items={gridKeys("capability.sec.apps.wearos", 4).map(k => t(k))} />
          </div>

          <SubHeading>{t("capability.sec.apps.garmin.heading")}</SubHeading>
          <FeatureGrid items={gridKeys("capability.sec.apps.garmin", 2).map(k => t(k))} />
        </Section>

        {/* Footer */}
        <footer className="bg-gradient-to-b from-[#0A1A0F] to-[#0d1e12] border-t-2 border-[#C9A84C] px-10 py-10 text-center">
          <div className="font-serif text-2xl font-black tracking-[0.18em] uppercase mb-2">
            <span className="text-white">KHARA</span><span className="text-[#C9A84C]">GOLF</span>
          </div>
          <div className="text-[10px] tracking-[0.3em] uppercase text-[#C9A84C] opacity-70 mb-5">
            {t("capability.footer.subtitle")}
          </div>
          <div className="text-sm text-[#7aab8a] leading-8">
            <span>📧 </span>
            <a href="mailto:tournamentmanager@kharagolf.com" className="text-[#C9A84C] hover:underline">
              tournamentmanager@kharagolf.com
            </a>
            <br />
            <span>🌐 </span>
            <a href="https://www.kharagolf.com" className="text-[#C9A84C] hover:underline">
              www.kharagolf.com
            </a>
          </div>
          <div className="mt-6 text-[11px] text-[#3d5c47] tracking-wide">
            {t("capability.footer.confidential")}
          </div>
        </footer>

      </div>

      {/* Print Styles */}
      <style>{`
        @media print {
          .sticky { display: none !important; }
          body { background: #0f1a12 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          section { break-inside: avoid; }
          @page { size: auto; margin: 1.5cm; }
        }
      `}</style>
    </div>
  );
}
