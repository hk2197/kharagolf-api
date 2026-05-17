import { useEffect, useState } from "react";
import { Link } from "wouter";
import { applySeo, applyJsonLd } from "@/lib/seo";
import { trackFunnelEvent } from "@/lib/analytics";
import { RoiCalculator } from "@/components/RoiCalculator";
import { DemoBooking } from "@/components/DemoBooking";
import { motion, useScroll, useTransform, type Variants } from "framer-motion";
import { 
  Trophy, 
  Users, 
  Calendar, 
  MapPin, 
  ArrowRight, 
  CheckCircle2, 
  BarChart3, 
  ShieldCheck, 
  Globe, 
  ChevronRight,
  Menu,
  X,
  Search,
  Medal,
  Star,
  ExternalLink
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { useT, useLocale, SUPPORTED_SITE_LANGS } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

// Types
type Plan = {
  tier: string;
  label: string;
  priceMonthly: number;
  currency: string;
  description: string;
  maxActiveTournaments: number | null;
  maxMembers: number | null;
};

type Club = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  tier: string;
  memberCount: number;
  location: string;
};

type RankingSeries = {
  id: number;
  name: string;
  level: string;
  status: string;
  seasonStart: string | null;
  seasonEnd: string | null;
};

type LiveTournament = {
  id: number;
  name: string;
  format: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  organizationName: string;
  courseName: string | null;
  playerCount: number;
  currency: string;
};

export default function Home() {
  const { toast } = useToast();
  const t = useT();
  const { lang } = useLocale();
  const { scrollY } = useScroll();
  const navBackground = useTransform(scrollY, [0, 100], ["rgba(10, 26, 15, 0)", "rgba(10, 26, 15, 0.95)"]);
  const navBorder = useTransform(scrollY, [0, 100], ["rgba(255, 255, 255, 0)", "rgba(255, 255, 255, 0.1)"]);

  const [plans, setPlans] = useState<Plan[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [rankings, setRankings] = useState<RankingSeries[]>([]);
  const [liveTournaments, setLiveTournaments] = useState<LiveTournament[]>([]);
  const [clubSearch, setClubSearch] = useState("");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    clubName: "",
    phone: "",
    interest: "_empty",
    preferredDemoTime: "_empty",
    message: ""
  });

  useEffect(() => {
    fetch("/api/onboarding/plans")
      .then(res => res.json())
      .then(data => setPlans(data))
      .catch(err => console.error("Failed to load plans", err));

    fetch("/api/onboarding/clubs")
      .then(res => res.json())
      .then(data => setClubs(data))
      .catch(err => console.error("Failed to load clubs", err));

    fetch("/api/public/rankings")
      .then(res => res.json())
      .then(data => setRankings(Array.isArray(data) ? data : []))
      .catch(err => console.error("Failed to load rankings", err));

    fetch("/api/public/tournaments")
      .then(res => res.json())
      .then(data => setLiveTournaments(Array.isArray(data) ? data : []))
      .catch(err => console.error("Failed to load tournaments", err));
  }, []);

  useEffect(() => {
    // Task #2204 — push localised title/description/og tags so social
    // previews and search engines reflect the active language. Re-runs
    // when `lang` changes so an in-session language switch updates the
    // document head too.
    applySeo({
      title: t('seo.home.title'),
      description: t('seo.home.description'),
      lang,
      alternates: { langs: SUPPORTED_SITE_LANGS, defaultLang: 'en' },
    });
    applyJsonLd([
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'KHARAGOLF',
        url: typeof window !== 'undefined' ? window.location.origin : 'https://kharagolf.com',
        logo: '/favicon.svg',
        sameAs: ['https://twitter.com/kharagolf', 'https://instagram.com/kharagolf', 'https://linkedin.com/company/kharagolf'],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'KHARAGOLF',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, iOS, Android',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
        aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.9', reviewCount: '47' },
      },
    ]);
    trackFunnelEvent('page_view', { page: 'home' });
  }, [lang, t]);


  const filteredClubs = clubs.filter(c =>
    c.name.toLowerCase().includes(clubSearch.toLowerCase()) ||
    c.location.toLowerCase().includes(clubSearch.toLowerCase())
  );

  const handleDemoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    
    try {
      const res = await fetch("/api/public/demo-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          clubName: formData.clubName || undefined,
          phone: formData.phone || undefined,
          interest: formData.interest === "_empty" ? undefined : formData.interest,
          preferredDemoTime: formData.preferredDemoTime === "_empty" ? undefined : formData.preferredDemoTime,
          message: formData.message || undefined,
        }),
      });

      if (!res.ok) throw new Error("Submission failed");
      
      toast({
        title: "Request Received",
        description: "A member of our concierage team will contact you shortly.",
      });
      
      setFormData({ name: "", email: "", clubName: "", phone: "", interest: "_empty", preferredDemoTime: "_empty", message: "" });
    } catch (error) {
      toast({
        title: "Error",
        description: "Could not submit your request. Please try again later.",
        variant: "destructive"
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const fadeInUp: Variants = {
    hidden: { opacity: 0, y: 30 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.25, 0.1, 0.25, 1] } }
  };

  const staggerContainer: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.1 }
    }
  };

  return (
    <div className="min-h-screen bg-[#0A1A0F] text-[#F2F2F0] font-sans selection:bg-[#C9A84C] selection:text-[#0A1A0F]">
      {/* Navigation */}
      <motion.nav 
        className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md border-b"
        style={{ backgroundColor: navBackground, borderBottomColor: navBorder }}
      >
        <div className="container mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Trophy className="w-8 h-8 text-[#C9A84C]" />
            <div>
              <span className="font-serif font-bold text-xl tracking-wider">KHARAGOLF</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-8 text-sm font-medium tracking-wide">
            <a href="#for-clubs" className="hover:text-[#C9A84C] transition-colors">{t("nav.forClubs")}</a>
            <a href="#for-golfers" className="hover:text-[#C9A84C] transition-colors">{t("nav.forGolfers")}</a>
            <Link href="/pricing" className="hover:text-[#C9A84C] transition-colors">{t("nav.pricing")}</Link>
            <a href="#demo" className="hover:text-[#C9A84C] transition-colors">{t("nav.contact")}</a>
            <LanguageSwitcher />
            <a href="#demo" className="bg-[#C9A84C] text-[#0A1A0F] px-6 py-2.5 rounded hover:bg-[#D4B662] transition-colors font-bold uppercase text-xs">
              {t("nav.bookDemo")}
            </a>
          </div>

          <button 
            className="md:hidden text-white"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            data-testid="button-mobile-menu"
          >
            {isMenuOpen ? <X /> : <Menu />}
          </button>
        </div>
        
        {/* Mobile Menu */}
        {isMenuOpen && (
          <div className="md:hidden absolute top-20 left-0 right-0 bg-[#0A1A0F] border-b border-white/10 p-6 flex flex-col gap-4">
            <a href="#for-clubs" onClick={() => setIsMenuOpen(false)} className="text-lg">{t("nav.forClubs")}</a>
            <a href="#for-golfers" onClick={() => setIsMenuOpen(false)} className="text-lg">{t("nav.forGolfers")}</a>
            <Link href="/pricing" onClick={() => setIsMenuOpen(false)} className="text-lg">{t("nav.pricing")}</Link>
            <a href="#demo" onClick={() => setIsMenuOpen(false)} className="text-lg">{t("nav.contact")}</a>
            <div className="mt-2"><LanguageSwitcher /></div>
            <a href="#demo" onClick={() => setIsMenuOpen(false)} className="text-[#C9A84C] font-bold text-lg mt-4">{t("nav.bookDemo")}</a>
          </div>
        )}
      </motion.nav>

      {/* Hero Section */}
      <section className="relative min-h-[100dvh] flex items-center pt-20 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <div className="absolute inset-0 bg-gradient-to-b from-[#0A1A0F]/80 via-[#0A1A0F]/60 to-[#0A1A0F] z-10" />
          <img 
            src="/hero-golf.jpg" 
            alt="Premium Golf Course" 
            className="w-full h-full object-cover object-center opacity-40 scale-105 animate-slow-pan"
          />
        </div>

        <div className="container mx-auto px-6 relative z-10">
          <motion.div 
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
            className="max-w-4xl"
          >
            <motion.div variants={fadeInUp} className="mb-6 flex items-center gap-3">
              <Badge variant="outline" className="border-[#C9A84C] text-[#C9A84C] uppercase tracking-widest bg-transparent rounded-none px-3 py-1">
                {t("home.hero.kicker")}
              </Badge>
            </motion.div>
            
            <motion.h1 
              variants={fadeInUp}
              className="text-5xl md:text-7xl lg:text-8xl font-serif font-medium leading-[1.1] mb-8"
              data-testid="home-hero-title"
            >
              {t("home.hero.titleLine1")} <br/>
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#C9A84C] to-[#E5CC85]">{t("home.hero.titleLine2")}</span>
            </motion.h1>
            
            <motion.p 
              variants={fadeInUp}
              className="text-xl md:text-2xl text-white/70 font-light max-w-2xl mb-12 leading-relaxed"
            >
              {t("home.hero.subtitle")}
            </motion.p>
            
            <motion.div variants={fadeInUp} className="flex flex-col sm:flex-row gap-4">
              <Button size="lg" className="bg-[#C9A84C] text-[#0A1A0F] hover:bg-[#D4B662] rounded-none h-14 px-8 text-sm font-bold uppercase tracking-widest" asChild>
                <a href="#demo">{t("home.hero.ctaPrimary")}</a>
              </Button>
              <Button size="lg" variant="outline" className="border-white/20 text-white hover:bg-white/5 rounded-none h-14 px-8 text-sm font-bold uppercase tracking-widest" asChild>
                <a href="#platform">{t("home.hero.ctaSecondary")}</a>
              </Button>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Partner Club Logo Strip */}
      <section className="py-10 bg-[#071208] border-b border-white/5">
        <div className="container mx-auto px-6">
          <p className="text-center text-white/30 text-xs uppercase tracking-[0.3em] mb-8">{t("home.partners.kicker")}</p>
          <div className="flex flex-wrap justify-center items-center gap-10 opacity-40 grayscale">
            {clubs.slice(0, 6).map(club => (
              <div key={club.id} className="flex items-center gap-2">
                {club.logoUrl ? (
                  <img src={club.logoUrl} alt={club.name} className="h-8 object-contain" />
                ) : (
                  <div className="flex items-center gap-2">
                    <Trophy className="w-5 h-5 text-[#C9A84C]" />
                    <span className="font-serif text-white text-sm tracking-wide">{club.name}</span>
                  </div>
                )}
              </div>
            ))}
            {clubs.length === 0 && (
              ["Royal Golf Club", "Emerald Greens", "Fairway Estate", "The Links Club", "Pinnacle Golf", "Sunrise GC"].map(name => (
                <div key={name} className="flex items-center gap-2">
                  <Trophy className="w-4 h-4 text-[#C9A84C]" />
                  <span className="font-serif text-white/70 text-sm tracking-wide">{name}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Platform Dashboard Preview */}
      <section id="platform" className="py-24 relative bg-gradient-to-b from-[#0A1A0F] to-[#0D2214]">
        <div className="container mx-auto px-6">
          <motion.div 
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8 }}
            className="relative rounded-2xl border border-white/10 bg-[#122E1A]/50 p-2 shadow-2xl shadow-[#C9A84C]/5 overflow-hidden"
          >
            <div className="absolute inset-0 bg-gradient-to-tr from-[#C9A84C]/10 to-transparent opacity-20" />
            <img 
              src="/platform-mock.png" 
              alt="KHARAGOLF Dashboard" 
              className="w-full h-auto rounded-xl border border-white/5"
            />
          </motion.div>

          <div className="grid md:grid-cols-3 gap-12 mt-24">
            {[
              {
                icon: ShieldCheck,
                title: t("home.platform.features.engine.title"),
                desc: t("home.platform.features.engine.desc"),
              },
              {
                icon: BarChart3,
                title: t("home.platform.features.analytics.title"),
                desc: t("home.platform.features.analytics.desc"),
              },
              {
                icon: Globe,
                title: t("home.platform.features.ecosystem.title"),
                desc: t("home.platform.features.ecosystem.desc"),
              }
            ].map((feature, i) => (
              <motion.div 
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
                className="border-l border-white/10 pl-6"
              >
                <feature.icon className="w-8 h-8 text-[#C9A84C] mb-6" strokeWidth={1.5} />
                <h3 className="text-xl font-serif mb-3">{feature.title}</h3>
                <p className="text-white/60 font-light leading-relaxed">{feature.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* For Clubs — 8-Module Feature Grid */}
      <section id="for-clubs" className="py-32 bg-[#071208]">
        <div className="container mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center max-w-3xl mx-auto mb-20"
          >
            <Badge variant="outline" className="border-[#C9A84C] text-[#C9A84C] uppercase tracking-widest bg-transparent rounded-none px-3 py-1 mb-6">
              {t("home.forClubs.kicker")}
            </Badge>
            <h2 className="text-3xl md:text-5xl font-serif mb-6">{t("home.forClubs.title")}</h2>
            <p className="text-white/60 font-light text-lg">
              {t("home.forClubs.subtitle")}
            </p>
          </motion.div>

          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.08 } } }}
            className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-white/5"
          >
            {[
              {
                icon: Trophy,
                title: t("home.modules.tournament.title"),
                desc: t("home.modules.tournament.desc"),
              },
              {
                icon: Users,
                title: t("home.modules.handicap.title"),
                desc: t("home.modules.handicap.desc"),
              },
              {
                icon: BarChart3,
                title: t("home.modules.leaderboards.title"),
                desc: t("home.modules.leaderboards.desc"),
              },
              {
                icon: Calendar,
                title: t("home.modules.league.title"),
                desc: t("home.modules.league.desc"),
              },
              {
                icon: ShieldCheck,
                title: t("home.modules.sponsorship.title"),
                desc: t("home.modules.sponsorship.desc"),
              },
              {
                icon: Globe,
                title: t("home.modules.comms.title"),
                desc: t("home.modules.comms.desc"),
              },
              {
                icon: ChevronRight,
                title: t("home.modules.proshop.title"),
                desc: t("home.modules.proshop.desc"),
              },
              {
                icon: CheckCircle2,
                title: t("home.modules.analytics.title"),
                desc: t("home.modules.analytics.desc"),
              }
            ].map((module, i) => (
              <motion.div
                key={i}
                variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
                className="group bg-[#071208] p-8 hover:bg-[#0D2214] transition-colors border border-white/0 hover:border-[#C9A84C]/20"
              >
                <module.icon className="w-7 h-7 text-[#C9A84C] mb-5" strokeWidth={1.5} />
                <h3 className="text-lg font-serif mb-3 group-hover:text-[#C9A84C] transition-colors">{module.title}</h3>
                <p className="text-sm text-white/50 font-light leading-relaxed">{module.desc}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-32 bg-[#0A1A0F]">
        <div className="container mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center max-w-2xl mx-auto mb-20"
          >
            <h2 className="text-3xl md:text-5xl font-serif mb-6">{t("home.howItWorks.title")}</h2>
            <p className="text-white/60 font-light text-lg">
              {t("home.howItWorks.subtitle")}
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto relative">
            <div className="hidden md:block absolute top-8 left-1/3 right-1/3 h-px bg-gradient-to-r from-transparent via-[#C9A84C]/30 to-transparent" />
            {[
              {
                step: "01",
                title: t("home.howItWorks.step1.title"),
                desc: t("home.howItWorks.step1.desc"),
              },
              {
                step: "02",
                title: t("home.howItWorks.step2.title"),
                desc: t("home.howItWorks.step2.desc"),
              },
              {
                step: "03",
                title: t("home.howItWorks.step3.title"),
                desc: t("home.howItWorks.step3.desc"),
              }
            ].map((phase, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.15 }}
                className="relative text-center p-8"
              >
                <div className="w-16 h-16 border border-[#C9A84C]/40 rounded-full flex items-center justify-center mx-auto mb-6">
                  <span className="text-[#C9A84C] font-mono font-bold text-lg">{phase.step}</span>
                </div>
                <h3 className="text-2xl font-serif mb-4">{phase.title}</h3>
                <p className="text-white/60 font-light leading-relaxed">{phase.desc}</p>
              </motion.div>
            ))}
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mt-16"
          >
            <Button className="bg-[#C9A84C] text-[#0A1A0F] hover:bg-[#D4B662] rounded-none h-14 px-10 font-bold uppercase tracking-widest" asChild>
              <a href="#demo">{t("home.howItWorks.cta")}</a>
            </Button>
          </motion.div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-32 bg-[#0D2214] border-y border-white/5">
        <div className="container mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl md:text-5xl font-serif mb-4">{t("home.testimonials.title")}</h2>
          </motion.div>

          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } }}
            className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto"
          >
            {[
              {
                // Club names are real-world proper nouns and stay in their
                // original form across locales.
                quote: t("home.testimonials.t1.quote"),
                author: t("home.testimonials.t1.author"),
                club: "DLF Golf & Country Club",
                metric: t("home.testimonials.t1.metric"),
                caseStudyUrl: "/clubs/dlf-golf"
              },
              {
                quote: t("home.testimonials.t2.quote"),
                author: t("home.testimonials.t2.author"),
                club: "Royal Calcutta Golf Club",
                metric: t("home.testimonials.t2.metric"),
                caseStudyUrl: "/clubs/royal-calcutta"
              },
              {
                quote: t("home.testimonials.t3.quote"),
                author: t("home.testimonials.t3.author"),
                club: "Eagleton Golf Resort",
                metric: t("home.testimonials.t3.metric"),
                caseStudyUrl: "/clubs/eagleton"
              }
            ].map((testimonial, i) => (
              <motion.div
                key={i}
                variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
                className="bg-[#0A1A0F] border border-white/10 p-10 relative"
              >
                <div className="text-[#C9A84C] text-5xl font-serif leading-none mb-6 opacity-40">"</div>
                <p className="text-white/80 font-light leading-relaxed mb-8 text-lg">{testimonial.quote}</p>
                <div className="border-t border-white/10 pt-6">
                  <p className="font-medium text-sm">{testimonial.author}</p>
                  <p className="text-[#C9A84C] text-sm font-light mt-1">{testimonial.club}</p>
                  <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/5">
                    <span className="text-xs uppercase tracking-widest text-[#C9A84C]/80">{testimonial.metric}</span>
                    <Link href={testimonial.caseStudyUrl} onClick={() => trackFunnelEvent("cta_click", { source: "testimonial", club: testimonial.club })} className="text-xs uppercase tracking-widest text-white/60 hover:text-[#C9A84C] inline-flex items-center gap-1" data-testid={`case-study-${testimonial.club.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{t("home.testimonials.readCaseStudy")} <ExternalLink className="w-3 h-3" /></Link>
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* Formats Marquee / Grid */}
      <section id="formats" className="py-32 bg-[#0A1A0F] border-y border-white/5 overflow-hidden">
        <div className="container mx-auto px-6 mb-16 text-center">
          <h2 className="text-3xl md:text-5xl font-serif mb-6">14+ Formats. Zero Compromise.</h2>
          <p className="text-white/60 max-w-2xl mx-auto font-light text-lg">
            Whether it's the Club Championship or a corporate scramble, KHARAGOLF handles the math, flights, and pairings with absolute precision.
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-4 container mx-auto px-6 max-w-5xl">
          {[
            "Strokeplay", "Stableford", "Match Play", "Skins", "Scramble", "4Ball", 
            "Bogey", "Par", "Eclectic", "Club Championship", "League", "Corporate/Charity", 
            "Fantasy Golf", "Ryder Cup Style"
          ].map((format, i) => (
            <motion.div
              key={format}
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.05 }}
              className="px-6 py-3 border border-white/10 bg-[#122E1A] text-white/90 rounded-full font-medium tracking-wide text-sm hover:border-[#C9A84C]/50 hover:text-[#C9A84C] transition-colors cursor-default"
            >
              {format}
            </motion.div>
          ))}
        </div>
      </section>

      {/* For Golfers Hub */}
      <section id="for-golfers" className="py-32 relative bg-[#071208]">
        <div className="container mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center max-w-3xl mx-auto mb-20"
          >
            <Badge variant="outline" className="border-[#C9A84C] text-[#C9A84C] uppercase tracking-widest bg-transparent rounded-none px-3 py-1 mb-6">
              For Golfers
            </Badge>
            <h2 className="text-4xl md:text-6xl font-serif mb-6 leading-tight">
              Feel like you're on the <span className="text-[#C9A84C] italic">professional tour.</span>
            </h2>
            <p className="text-white/60 text-lg font-light">
              Live leaderboards, player rankings, and event access — all from the course or your couch.
            </p>
          </motion.div>

          {/* Features row */}
          <div className="grid md:grid-cols-3 gap-8 mb-20">
            {[
              { icon: Trophy, title: "Live Leaderboards", desc: "Follow tournaments hole-by-hole with real-time score updates and stroke-play standings." },
              { icon: Medal, title: "Player Rankings", desc: "Track your position in regional and national series points tables across formats and seasons." },
              { icon: Star, title: "Full Event History", desc: "Access past scorecards, round statistics, handicap trends, and head-to-head records." }
            ].map((f, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
                className="border border-white/10 p-8 bg-[#0A1A0F]"
              >
                <f.icon className="w-8 h-8 text-[#C9A84C] mb-5" strokeWidth={1.5} />
                <h3 className="text-xl font-serif mb-3">{f.title}</h3>
                <p className="text-white/60 font-light leading-relaxed">{f.desc}</p>
              </motion.div>
            ))}
          </div>

          {/* Golfer CTA Cards */}
          <div className="grid md:grid-cols-2 gap-6 mb-20">
            <div className="border border-[#C9A84C]/30 bg-[#C9A84C]/5 p-8 flex flex-col gap-4">
              <Users className="w-8 h-8 text-[#C9A84C]" strokeWidth={1.5} />
              <div>
                <h3 className="text-xl font-serif mb-2">Apply for Membership</h3>
                <p className="text-white/60 font-light text-sm leading-relaxed">
                  Join a club on KHARAGOLF and gain access to official handicaps, tournaments, and a verified player profile.
                </p>
              </div>
              <Button className="mt-auto bg-[#C9A84C] text-[#0A1A0F] hover:bg-[#D4B662] rounded-none font-bold uppercase text-xs h-11 w-fit px-6" asChild>
                <a href="#clubs">Find a Club</a>
              </Button>
            </div>
            <div className="border border-white/10 bg-[#0A1A0F] p-8 flex flex-col gap-4">
              <Calendar className="w-8 h-8 text-[#C9A84C]" strokeWidth={1.5} />
              <div>
                <h3 className="text-xl font-serif mb-2">Book a Tee Time</h3>
                <p className="text-white/60 font-light text-sm leading-relaxed">
                  Browse available tee times at your club. Reserve your slot and get instant confirmation right from your phone.
                </p>
              </div>
              <Button variant="outline" className="mt-auto border-white/20 text-white hover:bg-white/5 rounded-none font-bold uppercase text-xs h-11 w-fit px-6" asChild>
                <a href="#demo">Contact Your Club</a>
              </Button>
            </div>
          </div>

          {/* Live Tournament Leaderboard Feed */}
          <div className="mb-20">
            <div className="flex items-center gap-3 mb-8">
              <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
              <h3 className="text-2xl md:text-3xl font-serif">Live &amp; Upcoming Events.</h3>
            </div>
            <p className="text-white/50 font-light mb-8 -mt-4">Active and upcoming tournaments running on KHARAGOLF right now.</p>
            {liveTournaments.length > 0 ? (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {liveTournaments.slice(0, 6).map((t, i) => (
                  <motion.div
                    key={t.id}
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.05 }}
                    className="group border border-white/10 bg-[#0A1A0F] p-6 hover:border-[#C9A84C]/40 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <span className={`text-[10px] uppercase tracking-widest px-2 py-1 font-bold ${t.status === "active" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-white/5 text-white/40 border border-white/10"}`}>
                        {t.status === "active" ? "Live" : "Upcoming"}
                      </span>
                      <span className="text-[10px] uppercase tracking-widest text-white/30">{t.format?.replace(/_/g, " ")}</span>
                    </div>
                    <h4 className="font-serif text-lg mb-1 group-hover:text-[#C9A84C] transition-colors leading-snug">{t.name}</h4>
                    <p className="text-white/40 text-sm mb-3">{t.organizationName}</p>
                    {t.courseName && <p className="text-white/30 text-xs flex items-center gap-1"><MapPin className="w-3 h-3" />{t.courseName}</p>}
                    <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/5">
                      <span className="text-xs text-white/30 flex items-center gap-1"><Users className="w-3 h-3" />{t.playerCount} players</span>
                      <a
                        href={`/api/public/tournaments/${t.id}/leaderboard`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-[#C9A84C] flex items-center gap-1 hover:underline font-medium"
                      >
                        Leaderboard <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="border border-white/10 p-10 bg-[#0A1A0F] text-center">
                <Trophy className="w-8 h-8 text-white/20 mx-auto mb-3" />
                <p className="text-white/40 font-light">No live events at the moment.</p>
                <p className="text-white/30 text-sm mt-1">Check back soon — clubs publish new tournaments regularly.</p>
              </div>
            )}
          </div>

          {/* Searchable clubs directory */}
          <div className="mb-16">
            <div className="flex flex-col md:flex-row justify-between items-end mb-8 gap-4">
              <div>
                <h3 className="text-2xl md:text-3xl font-serif mb-2">Find your club.</h3>
                <p className="text-white/50 font-light">Search for clubs on KHARAGOLF and access their live events.</p>
              </div>
              <div className="relative w-full md:w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                <input
                  type="text"
                  placeholder="Club name or location…"
                  value={clubSearch}
                  onChange={e => setClubSearch(e.target.value)}
                  className="w-full bg-[#0A1A0F] border border-white/20 pl-10 pr-4 py-3 text-sm focus:outline-none focus:border-[#C9A84C] transition-colors placeholder:text-white/30"
                />
              </div>
            </div>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredClubs.length > 0 ? (
                filteredClubs.slice(0, 9).map((club, i) => (
                  <motion.div
                    key={club.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="group bg-[#0A1A0F] border border-white/10 p-6 hover:border-[#C9A84C]/50 transition-colors flex items-center gap-4"
                  >
                    <div className="w-12 h-12 bg-white/5 rounded-full flex items-center justify-center shrink-0">
                      {club.logoUrl ? (
                        <img src={club.logoUrl} alt={club.name} className="w-8 h-8 object-contain" />
                      ) : (
                        <Trophy className="w-5 h-5 text-white/30" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <h4 className="font-serif group-hover:text-[#C9A84C] transition-colors truncate">{club.name}</h4>
                      <div className="flex items-center gap-3 text-xs text-white/40 mt-1">
                        <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{club.location}</span>
                        <span className="flex items-center gap-1"><Users className="w-3 h-3" />{club.memberCount}</span>
                      </div>
                    </div>
                    <ExternalLink className="w-4 h-4 text-white/20 group-hover:text-[#C9A84C] transition-colors ml-auto shrink-0" />
                  </motion.div>
                ))
              ) : clubs.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="bg-[#0A1A0F] border border-white/5 p-6 animate-pulse flex items-center gap-4">
                    <div className="w-12 h-12 bg-white/5 rounded-full shrink-0" />
                    <div className="flex-1">
                      <div className="h-4 bg-white/5 rounded w-3/4 mb-2" />
                      <div className="h-3 bg-white/5 rounded w-1/2" />
                    </div>
                  </div>
                ))
              ) : (
                <div className="col-span-3 py-12 text-center text-white/30">
                  No clubs match your search. <button onClick={() => setClubSearch("")} className="text-[#C9A84C] underline ml-1">Clear</button>
                </div>
              )}
            </div>
          </div>

          {/* Live Rankings */}
          <div>
            <h3 className="text-2xl md:text-3xl font-serif mb-2">Live Rankings Series.</h3>
            <p className="text-white/50 font-light mb-8">Active public ranking series open to all affiliated clubs.</p>
            {rankings.length > 0 ? (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {rankings.map((series, i) => (
                  <motion.div
                    key={series.id}
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.05 }}
                    className="border border-white/10 p-6 bg-[#0A1A0F] hover:border-[#C9A84C]/40 transition-colors group"
                  >
                    <Medal className="w-6 h-6 text-[#C9A84C] mb-4" strokeWidth={1.5} />
                    <h4 className="font-serif text-lg mb-1 group-hover:text-[#C9A84C] transition-colors">{series.name}</h4>
                    <p className="text-white/40 text-sm capitalize">{series.level} · {series.status}</p>
                    {series.seasonStart && (
                      <p className="text-white/30 text-xs mt-2">
                        {new Date(series.seasonStart).getFullYear()} Season
                      </p>
                    )}
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="border border-white/10 p-8 bg-[#0A1A0F] text-center">
                <Medal className="w-8 h-8 text-white/20 mx-auto mb-3" />
                <p className="text-white/40 font-light">No active public rankings at this time.</p>
                <p className="text-white/30 text-sm mt-1">Check back when clubs publish their season series.</p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Clubs Directory */}
      <section id="clubs" className="py-32 bg-[#0D2214] border-y border-white/5">
        <div className="container mx-auto px-6">
          <div className="flex flex-col md:flex-row justify-between items-end mb-16 gap-6">
            <div>
              <h2 className="text-3xl md:text-5xl font-serif mb-4">Trusted by the best.</h2>
              <p className="text-white/60 max-w-lg font-light text-lg">
                Join an elite network of prestigious clubs utilizing KHARAGOLF to manage their tournaments and members.
              </p>
            </div>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {clubs.length > 0 ? (
              clubs.slice(0, 6).map((club, i) => (
                <motion.div 
                  key={club.id}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1 }}
                  className="group bg-[#0A1A0F] border border-white/10 p-8 hover:border-[#C9A84C]/50 transition-colors"
                >
                  <div className="w-16 h-16 bg-white/5 rounded-full mb-6 flex items-center justify-center">
                    {club.logoUrl ? (
                      <img src={club.logoUrl} alt={club.name} className="w-10 h-10 object-contain" />
                    ) : (
                      <MapPin className="w-6 h-6 text-white/40" />
                    )}
                  </div>
                  <h3 className="text-xl font-serif mb-2 group-hover:text-[#C9A84C] transition-colors">{club.name}</h3>
                  <div className="flex items-center gap-4 text-sm text-white/50 font-light">
                    <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {club.location}</span>
                    <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {club.memberCount}</span>
                  </div>
                </motion.div>
              ))
            ) : (
              // Loading skeletons
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-[#0A1A0F] border border-white/5 p-8 animate-pulse">
                  <div className="w-16 h-16 bg-white/5 rounded-full mb-6" />
                  <div className="h-6 w-3/4 bg-white/5 rounded mb-4" />
                  <div className="h-4 w-1/2 bg-white/5 rounded" />
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* ROI Calculator */}
      <RoiCalculator />

      {/* Pricing */}
      <section id="pricing" className="py-32">
        <div className="container mx-auto px-6">
          <div className="text-center max-w-3xl mx-auto mb-20">
            <h2 className="text-3xl md:text-5xl font-serif mb-6">Investment in Excellence.</h2>
            <p className="text-white/60 font-light text-lg">
              Transparent, straightforward pricing designed to scale from private country clubs to massive municipal operations.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto">
            {plans.length > 0 ? (
              plans.map((plan, i) => (
                <motion.div 
                  key={plan.tier}
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1 }}
                  className={`relative p-8 flex flex-col border ${plan.tier === 'pro' ? 'border-[#C9A84C] bg-[#C9A84C]/5' : 'border-white/10 bg-[#122E1A]'}`}
                >
                  {plan.tier === 'pro' && (
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#C9A84C] text-[#0A1A0F] px-3 py-1 text-xs font-bold uppercase tracking-widest">
                      Standard
                    </div>
                  )}
                  
                  <h3 className="text-xl font-medium mb-2 capitalize">{plan.label}</h3>
                  <div className="mb-6">
                    <span className="text-4xl font-serif">
                      {plan.priceMonthly === 0 ? "Free" : `₹${plan.priceMonthly.toLocaleString()}`}
                    </span>
                    {plan.priceMonthly > 0 && <span className="text-white/50 text-sm">/mo</span>}
                  </div>
                  
                  <p className="text-sm text-white/60 font-light mb-8 flex-grow">
                    {plan.description}
                  </p>
                  
                  <div className="space-y-4 mb-8 text-sm border-t border-white/10 pt-6">
                    <div className="flex items-center justify-between">
                      <span className="text-white/60">Members</span>
                      <span className="font-medium">{plan.maxMembers ? plan.maxMembers : 'Unlimited'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-white/60">Active Events</span>
                      <span className="font-medium">{plan.maxActiveTournaments ? plan.maxActiveTournaments : 'Unlimited'}</span>
                    </div>
                  </div>
                  
                  <Button 
                    variant={plan.tier === 'pro' ? 'default' : 'outline'}
                    className={`w-full rounded-none ${plan.tier === 'pro' ? 'bg-[#C9A84C] text-[#0A1A0F] hover:bg-[#D4B662]' : 'border-white/20 text-white hover:bg-white/5'}`}
                    asChild
                  >
                    <a href="#demo">Get Started</a>
                  </Button>
                </motion.div>
              ))
            ) : (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="border border-white/5 bg-[#122E1A] p-8 h-[400px] animate-pulse rounded-sm" />
              ))
            )}
          </div>
        </div>
      </section>

      {/* Demo / Contact */}
      <section id="demo" className="py-32 bg-[#C9A84C] text-[#0A1A0F] relative overflow-hidden">
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10 mix-blend-multiply" />
        
        <div className="container mx-auto px-6 relative z-10">
          <div className="grid lg:grid-cols-2 gap-16 max-w-6xl mx-auto">
            <div>
              <h2 className="text-4xl md:text-6xl font-serif mb-6 leading-tight font-bold">
                {t("home.demo.title")}
              </h2>
              <p className="text-lg mb-12 font-medium opacity-80">
                {t("home.demo.subtitle")}
              </p>
              
              <div className="space-y-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full border border-[#0A1A0F]/20 flex items-center justify-center">
                    <Calendar className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="font-bold">{t("home.demo.feature.schedule.title")}</h4>
                    <p className="text-sm opacity-80">{t("home.demo.feature.schedule.desc")}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full border border-[#0A1A0F]/20 flex items-center justify-center">
                    <Users className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="font-bold">{t("home.demo.feature.migration.title")}</h4>
                    <p className="text-sm opacity-80">{t("home.demo.feature.migration.desc")}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#0A1A0F] p-8 md:p-10 rounded-xl text-white shadow-2xl">
              <h3 className="text-2xl font-serif mb-6 text-white">{t("home.demo.formHeading")}</h3>
              <div className="col-span-1 -mx-6 sm:mx-0"><DemoBooking /></div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#050D08] pt-16 pb-10 border-t border-white/5">
        <div className="container mx-auto px-6">
          <div className="grid md:grid-cols-4 gap-12 mb-12">
            <div className="md:col-span-2">
              <div className="flex items-center gap-2 mb-4">
                <Trophy className="w-6 h-6 text-[#C9A84C]" />
                <span className="font-serif font-bold tracking-wider">KHARAGOLF</span>
              </div>
              <p className="text-white/40 font-light text-sm max-w-xs leading-relaxed">
                {t("footer.tagline")}
              </p>
              <div className="flex items-center gap-5 mt-6">
                <a href="https://twitter.com/kharagolf" target="_blank" rel="noopener noreferrer" aria-label="Twitter" className="text-white/30 hover:text-[#C9A84C] transition-colors text-sm">Twitter / X</a>
                <span className="text-white/10">·</span>
                <a href="https://instagram.com/kharagolf" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="text-white/30 hover:text-[#C9A84C] transition-colors text-sm">Instagram</a>
                <span className="text-white/10">·</span>
                <a href="https://linkedin.com/company/kharagolf" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn" className="text-white/30 hover:text-[#C9A84C] transition-colors text-sm">LinkedIn</a>
              </div>
            </div>
            <div>
              <h4 className="text-xs uppercase tracking-widest text-white/30 mb-5">{t("footer.col.platform")}</h4>
              <ul className="space-y-3 text-sm text-white/50">
                <li><a href="#for-clubs" className="hover:text-white transition-colors">{t("nav.forClubs")}</a></li>
                <li><a href="#for-golfers" className="hover:text-white transition-colors">{t("nav.forGolfers")}</a></li>
                <li><a href="#formats" className="hover:text-white transition-colors">{t("footer.link.formats")}</a></li>
                <li><a href="#pricing" className="hover:text-white transition-colors">{t("nav.pricing")}</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs uppercase tracking-widest text-white/30 mb-5">{t("footer.col.company")}</h4>
              <ul className="space-y-3 text-sm text-white/50">
                <li><a href="#demo" className="hover:text-white transition-colors">{t("nav.contact")}</a></li>
                <li><a href="#" className="hover:text-white transition-colors">{t("footer.link.privacy")}</a></li>
                <li><a href="#" className="hover:text-white transition-colors">{t("footer.link.terms")}</a></li>
                <li><a href="#" className="hover:text-white transition-colors">{t("footer.link.support")}</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-white/5 pt-8 text-center text-sm text-white/20" data-testid="home-footer-copyright">
            {t("footer.copyright", { year: new Date().getFullYear() })}
          </div>
        </div>
      </footer>
    </div>
  );
}
