/**
 * Task #1765 — Site-wide i18n bundle for the kharagolf-website artifact.
 *
 * Task #1442 introduced `badges.ts` for the public badge landing page only,
 * because at that time the rest of the site had no i18n at all and the
 * badge page needed locale-aware copy for OG previews. This file promotes
 * the same approach to a site-wide bundle covering navigation, hero
 * sections, calls-to-action and footer copy across the marketing pages.
 *
 * Design choices:
 *
 * 1. Language list is reused from `badges.ts` (`SUPPORTED_BADGE_LANGS`) so
 *    the language switcher exposes the same 21-locale set the mobile app
 *    already supports — no second list to drift.
 *
 * 2. Strings are flat dot-namespaced keys (`nav.forClubs`, `home.hero.title`)
 *    rather than nested objects so the integrity test can iterate the key
 *    set as a flat array and the bundle stays cheap to diff in code review.
 *
 * 3. We ship complete English copy for every key plus three end-to-end
 *    non-English locales — Spanish (es), Hindi (hi) and Arabic (ar). Arabic
 *    proves out the RTL path. Any other locale falls back to English on a
 *    per-key basis (`getSiteString` does the lookup) so we never render the
 *    placeholder `nav.forClubs` to a visitor whose language we haven't
 *    translated yet.
 *
 * 4. Placeholders use the same `{{var}}` syntax as `badges.ts` and are
 *    interpolated by the same `interpolate` helper (re-exported from
 *    `index.tsx`).
 */

import type { BadgeLang } from "./badges";
import { SUPPORTED_BADGE_LANGS, RTL_BADGE_LANGS } from "./badges";

export type SiteLang = BadgeLang;

/** Same set as the badge bundle — see file header note. */
export const SUPPORTED_SITE_LANGS: readonly SiteLang[] = SUPPORTED_BADGE_LANGS;

/** Re-exported for the LocaleProvider so it can flip `<html dir>` globally. */
export const RTL_SITE_LANGS: ReadonlySet<SiteLang> = RTL_BADGE_LANGS;

/**
 * Human-readable labels shown in the language switcher. Each entry is the
 * language's own endonym so a Hindi visitor sees "हिन्दी" rather than
 * "Hindi" — matches mobile's locale picker.
 */
export const SITE_LANG_LABELS: Record<SiteLang, string> = {
  af: "Afrikaans",
  am: "አማርኛ",
  ar: "العربية",
  de: "Deutsch",
  en: "English",
  es: "Español",
  fil: "Filipino",
  fr: "Français",
  ha: "Hausa",
  hi: "हिन्दी",
  id: "Bahasa Indonesia",
  ja: "日本語",
  ko: "한국어",
  ms: "Bahasa Melayu",
  pt: "Português",
  sw: "Kiswahili",
  th: "ไทย",
  vi: "Tiếng Việt",
  yo: "Yorùbá",
  zh: "中文",
  zu: "isiZulu",
};

/**
 * The complete English bundle. This is the source of truth for the key
 * inventory — the integrity test asserts every translated locale defines
 * the same keys with matching `{{var}}` placeholders.
 *
 * Note: `as const` is applied at the bottom of the literal so the *keys*
 * are preserved as a literal union (drives `SiteKey`) without locking
 * the *values* into string-literal types — translated bundles only need
 * to be `Record<SiteKey, string>`, not "the exact English sentence".
 */
const en = {
  // Header / navigation — used on every marketing page.
  "nav.home": "Home",
  "nav.forClubs": "For Clubs",
  "nav.forGolfers": "For Golfers",
  "nav.features": "Features",
  "nav.pricing": "Pricing",
  "nav.contact": "Contact",
  "nav.bookDemo": "Book Demo",

  // Language switcher.
  "lang.label": "Language",
  "lang.switchTo": "Switch language",

  // Home — hero section.
  "home.hero.kicker": "The New Standard",
  "home.hero.titleLine1": "Mastery demands",
  "home.hero.titleLine2": "precision.",
  "home.hero.subtitle":
    "KHARAGOLF is the definitive tournament management platform for clubs that take their game seriously. Built for the modern era, rooted in heritage.",
  "home.hero.ctaPrimary": "Request Access",
  "home.hero.ctaSecondary": "Explore Platform",

  // Home — partner strip.
  "home.partners.kicker": "Trusted by clubs across the country",

  // Home — platform feature trio (under the dashboard mock).
  "home.platform.features.engine.title": "Authoritative Engine",
  "home.platform.features.engine.desc":
    "Bank-grade infrastructure ensuring your leaderboards are lightning fast and never falter, even with 500+ live scorers.",
  "home.platform.features.analytics.title": "Live Analytics",
  "home.platform.features.analytics.desc":
    "Real-time strokes gained, hole-by-hole statistics, and flighted leaderboards that update instantly across all screens.",
  "home.platform.features.ecosystem.title": "Unified Ecosystem",
  "home.platform.features.ecosystem.desc":
    "From the clubhouse TV to the player's mobile device, one seamless experience that elevates the prestige of your events.",

  // Home — "For Clubs" intro.
  "home.forClubs.kicker": "For Clubs",
  "home.forClubs.title": "A complete operating system for your club.",
  "home.forClubs.subtitle":
    "Every module your club needs — fully integrated, beautifully designed, and built for the way golf is actually run.",

  // Home — "How it works" trio.
  "home.howItWorks.title": "Up and running in days, not months.",
  "home.howItWorks.subtitle":
    "Our onboarding process is designed for busy club administrators. We do the heavy lifting.",
  "home.howItWorks.cta": "Start Your Journey",

  // Home — "How it works" three-phase steps below the heading.
  "home.howItWorks.step1.title": "Onboard",
  "home.howItWorks.step1.desc":
    "Book a demo, share your club's details, and we configure your KHARAGOLF environment — courses, tee boxes, member roles, and handicap settings.",
  "home.howItWorks.step2.title": "Configure",
  "home.howItWorks.step2.desc":
    "Import your existing membership data, create your first tournament, and customize the platform to match your club's unique identity and workflow.",
  "home.howItWorks.step3.title": "Go Live",
  "home.howItWorks.step3.desc":
    "Launch your first live event, share public scorecard links with spectators, and watch your club's operations transform in real time.",

  // Home — 8-module feature grid under "For Clubs".
  "home.modules.tournament.title": "Tournament Engine",
  "home.modules.tournament.desc":
    "Create and run any format — Strokeplay, Stableford, Match Play, Eclectic, and 10+ more — with automated scoring and flighting.",
  "home.modules.handicap.title": "Handicap & Membership",
  "home.modules.handicap.desc":
    "WHS-compliant handicap management, member profiles, tee-time bookings, and full club membership lifecycle tools.",
  "home.modules.leaderboards.title": "Live Leaderboards",
  "home.modules.leaderboards.desc":
    "Real-time scoring with strokes-gained analytics, hole-by-hole tracking, and public TV display boards for the clubhouse.",
  "home.modules.league.title": "League Management",
  "home.modules.league.desc":
    "Season-long league calendars, fixture generation, standings tables, and automatic round-result processing.",
  "home.modules.sponsorship.title": "Sponsorship Hub",
  "home.modules.sponsorship.desc":
    "Manage sponsors, assign branding rights, generate invoices, and deliver ROI reports — all from one dashboard.",
  "home.modules.comms.title": "Communications",
  "home.modules.comms.desc":
    "SMS and email campaigns, event announcements, push notifications, and a complete digital noticeboard for members.",
  "home.modules.proshop.title": "Pro Shop & Vendor",
  "home.modules.proshop.desc":
    "Integrated point-of-sale, inventory management, consignment, gift cards, and third-party vendor coordination.",
  "home.modules.analytics.title": "Analytics & Finance",
  "home.modules.analytics.desc":
    "Revenue dashboards, membership billing, dues tracking, accounting integrations, and exportable financial reports.",

  // Home — testimonials. Club names are real-world proper nouns and stay
  // untranslated; quotes, role labels and metrics translate.
  "home.testimonials.title": "What clubs are saying.",
  "home.testimonials.readCaseStudy": "Read case study",
  "home.testimonials.t1.quote":
    "KHARAGOLF transformed how we run our Club Championship. The live leaderboard had members glued to their phones for the entire event. We'd never go back.",
  "home.testimonials.t1.author": "Tournament Director",
  "home.testimonials.t1.metric": "3.4× live engagement",
  "home.testimonials.t2.quote":
    "The handicap engine is the most accurate we've ever used, and the automatic pairing system saved our committee hours of manual work every single round.",
  "home.testimonials.t2.author": "Club Secretary",
  "home.testimonials.t2.metric": "18 hrs saved / event",
  "home.testimonials.t3.quote":
    "Setting up a 72-player corporate scramble used to be a weekend project. With KHARAGOLF, our Operations Manager had it done in under two hours.",
  "home.testimonials.t3.author": "Golf Operations Manager",
  "home.testimonials.t3.metric": "Setup in <2 hrs",

  // Home — demo CTA section ("Ready to elevate your club's operations?").
  "home.demo.title": "Ready to elevate your club's operations?",
  "home.demo.subtitle":
    "Book a personalized 30-minute demonstration of KHARAGOLF. We'll show you exactly how our platform can streamline your next major tournament.",
  "home.demo.feature.schedule.title": "Schedule a Walkthrough",
  "home.demo.feature.schedule.desc": "See the platform in action with live data.",
  "home.demo.feature.migration.title": "Custom Migration Plan",
  "home.demo.feature.migration.desc":
    "We handle the import of your existing membership data.",
  "home.demo.formHeading": "Request Access",

  // Demo booking widget (DemoBooking.tsx) — calendar, form, toasts.
  "demoBooking.calendarHeading": "Pick a 30-min slot",
  "demoBooking.loadingSlots": "Loading available times…",
  "demoBooking.noSlots": "No upcoming slots available — please email us.",
  "demoBooking.detailsHeading": "Your details",
  "demoBooking.input.name": "Full name",
  "demoBooking.input.email": "Work email",
  "demoBooking.input.club": "Club / organisation",
  "demoBooking.input.phone": "Phone (optional)",
  "demoBooking.input.message": "Anything specific you'd like to see?",
  "demoBooking.interest.placeholder": "What's your primary interest?",
  "demoBooking.interest.empty": "Primary interest…",
  "demoBooking.interest.tournaments": "Tournament management",
  "demoBooking.interest.handicaps": "Handicap system",
  "demoBooking.interest.league": "League operations",
  "demoBooking.interest.full": "Full club operating system",
  "demoBooking.selected": "Selected: {{when}}",
  "demoBooking.pickPrompt": "Pick a slot on the left to enable booking.",
  "demoBooking.submitting": "Booking…",
  "demoBooking.submit": "Confirm demo",
  "demoBooking.toast.pickTime.title": "Pick a time",
  "demoBooking.toast.pickTime.desc": "Choose a slot from the calendar above.",
  "demoBooking.toast.addDetails.title": "Add your details",
  "demoBooking.toast.addDetails.desc": "Name and email are required.",
  "demoBooking.toast.booked.title": "Demo booked",
  "demoBooking.toast.booked.desc": "Confirmation emailed with a calendar invite.",
  "demoBooking.toast.failed.title": "Couldn't book the slot",
  "demoBooking.toast.failed.desc":
    "Try a different time or contact us directly.",
  "demoBooking.confirmed.heading": "You're booked.",
  "demoBooking.confirmed.note":
    "A confirmation email with a calendar invite is on its way to {{email}}.",

  // Cookie consent banner (CookieBanner.tsx). `cookies.body` uses a
  // `{{link}}` placeholder so the inline anchor stays grammatically
  // positioned in each language rather than being pinned to the end via
  // a brittle before/after split.
  "cookies.aria": "Cookie consent",
  "cookies.title": "We value your privacy",
  "cookies.body":
    "We use strictly-necessary cookies to run this site. With your consent we also use cookies for analytics and marketing. You can change your choice any time. Read more in our {{link}}.",
  "cookies.policyLink": "privacy policy",
  "cookies.necessary": "Necessary (always on)",
  "cookies.analytics": "Analytics — anonymous usage statistics",
  "cookies.marketing": "Marketing — personalised ads & offers",
  "cookies.button.customise": "Customise",
  "cookies.button.save": "Save choices",
  "cookies.button.reject": "Reject optional",
  "cookies.button.accept": "Accept all",

  // Footer.
  "footer.tagline":
    "The professional-grade golf tournament operating system for clubs that demand excellence.",
  "footer.col.platform": "Platform",
  "footer.col.company": "Company",
  "footer.link.formats": "Formats",
  "footer.link.privacy": "Privacy Policy",
  "footer.link.terms": "Terms of Service",
  "footer.link.support": "Support",
  "footer.copyright": "© {{year}} KHARAGOLF. All rights reserved.",

  // Pricing page.
  "pricing.kicker": "Pricing",
  "pricing.title": "Transparent. Predictable. Built to scale.",
  "pricing.subtitle":
    "One flat fee per club. No per-member surcharges, no event-day fees, no surprise bills when your tournament goes viral.",
  "pricing.billing.monthly": "Monthly",
  "pricing.billing.annual": "Annual",
  "pricing.billing.annualSave": "save 16%",
  "pricing.plan.mostPopular": "Most Popular",
  "pricing.plan.free": "Free",
  "pricing.plan.suffix.monthly": "/mo",
  "pricing.plan.suffix.annual": "/yr",
  "pricing.plan.members": "Members",
  "pricing.plan.unlimited": "Unlimited",
  "pricing.plan.activeEvents": "Active events",
  "pricing.plan.cta.enterprise": "Talk to sales",
  "pricing.plan.cta.default": "Get started",
  "pricing.compare.title": "Compare every feature.",
  "pricing.faq.kicker": "Pricing FAQ",
  "pricing.faq.title": "Questions, answered.",
  "pricing.demo.title": "See KHARAGOLF for your club.",
  "pricing.demo.subtitle":
    "Pick a 30-minute slot and we'll walk through your exact use case live.",

  // Capability Report — header chrome plus the long-form brochure body.
  "capability.kicker": "Platform Capability Report",
  "capability.print": "Print / Save as PDF",

  // Capability Report — long-form brochure body (English source).
  "capability.subtitle": "The Definitive Tournament Management Platform",
  "capability.quote": "Mastery demands precision.",
  "capability.intro.p1":
    "KHARAGOLF is an enterprise-grade golf club management platform purpose-built for prestigious clubs, national federations, and professional tournament directors. It unifies every dimension of club life — from WHS-compliant handicap management and live tournament scoring to tee time booking, pro shop POS, and on-course F&B ordering — into a single, beautifully designed system available in 21 languages across 6 global regions.",
  "capability.intro.p2":
    "The platform serves three audiences simultaneously: {{admin}}, {{players}}, and {{sponsors}} — across web, iOS, Android, Apple Watch, Wear OS, and Garmin.",
  "capability.intro.audience.admin": "Club Administrators",
  "capability.intro.audience.player": "Players",
  "capability.intro.audience.sponsor": "Sponsors",
  "capability.sec.channels.title": "Platform Channels",
  "capability.sec.channels.i1":
    "Enterprise Web App — Full admin command centre: tournaments, members, finance, operations",
  "capability.sec.channels.i2": "iOS App (Native) — Player portal: scoring, booking, analytics, shop (App Store)",
  "capability.sec.channels.i3": "Android App (Native) — Full iOS parity (Google Play)",
  "capability.sec.channels.i4": "Apple Watch — Wrist scoring, GPS distances, complications",
  "capability.sec.channels.i5": "Wear OS — Scorecard tiles, score vs par glance, tee time alerts",
  "capability.sec.channels.i6": "Garmin Connect IQ — Score, GPS yardage & handicap index on Garmin devices",
  "capability.sec.channels.i7": "KHARAGOLF.com — Marketing, club directory, demo requests, pricing",
  "capability.sec.channels.i8": "API / KHARAGOLF Cloud — Unified data engine powering all surfaces",
  "capability.sec.tournament.title": "Tournament & Competition Engine",
  "capability.sec.tournament.i1": "Stroke Play (Gross & Net), Stableford, Max Score, Par",
  "capability.sec.tournament.i2": "Match Play — Ryder Cup, Foursomes, Greensomes, Scramble, Best Ball, Shamble",
  "capability.sec.tournament.i3": "Multi-round events with cut lines",
  "capability.sec.tournament.i4": "Multi-course championships & interclub fixtures",
  "capability.sec.tournament.i5": "Shotgun, split tee & simultaneous starts",
  "capability.sec.tournament.i6": "Automated WHS Playing Handicap calculations",
  "capability.sec.tournament.i7": "Side games — Skins, CTP, Longest Drive, Birdies pool",
  "capability.sec.tournament.i8": "Live Leaderboard — real-time, kiosk mode, TV display board",
  "capability.sec.tournament.i9": "Public results page (shareable, no login required)",
  "capability.sec.tournament.i10": "Professional 4-panel pocket scorecards (PDF + QR)",
  "capability.sec.tournament.i11": "Draw builder — auto pairings, drag-and-drop, manual lock",
  "capability.sec.tournament.i12": "Flight management — bulk assign, drag-and-drop",
  "capability.sec.tournament.i13": "Prize payout calculator & auto-assignment",
  "capability.sec.tournament.i14": "Waitlist management with automated promotion",
  "capability.sec.tournament.i15": "Tournament templates — save and re-use formats",
  "capability.sec.tournament.i16": "Corporate & charity event management",
  "capability.sec.tournament.i17": "Eclectic scoring & Order of Merit",
  "capability.sec.tournament.i18": "Handicap simulator & what-if modelling",
  "capability.sec.tournament.i19": "Team competitions — named teams, rosters & team handicap aggregation",
  "capability.sec.tournament.i20": "Team draws, team leaderboards & team scoring",
  "capability.sec.tournament.i21": "Bulk team registration & team-based entry management",
  "capability.sec.league.title": "League Management",
  "capability.sec.league.i1": "Stroke, Stableford, Match Play & Round Robin formats",
  "capability.sec.league.i2": "Team leagues — named teams, rosters & team-based standings",
  "capability.sec.league.i3": "Season-long standings & cumulative scorecards",
  "capability.sec.league.i4": "PDF scorecard printing & export",
  "capability.sec.league.i5": "Post-round results notifications to all members",
  "capability.sec.whs.title": "World Handicap System (WHS 2024/2026)",
  "capability.sec.whs.i1": "Full WHS Rules of Handicapping compliance",
  "capability.sec.whs.i2": "Score differential — 18-hole, 9-hole & partial round prorating",
  "capability.sec.whs.i3": "ESR, Soft Cap, Hard Cap enforcement",
  "capability.sec.whs.i4": "Best 8 of last 20 differentials logic",
  "capability.sec.whs.i5": "GHIN / IGU automated score posting",
  "capability.sec.whs.i6": "Handicap committee governance & simulator",
  "capability.sec.scoring.title": "Live Scoring — All Channels",
  "capability.sec.scoring.i1": "Web scorer console — bulk grid entry for large fields",
  "capability.sec.scoring.i2": "Mobile scorer station — group-centric flow",
  "capability.sec.scoring.i3": "Player self-scoring with marker confirmation (WHS-compliant)",
  "capability.sec.scoring.i4": "Apple Watch & Wear OS standalone wrist scoring",
  "capability.sec.scoring.i5": "Offline scoring with automatic background sync",
  "capability.sec.gps.title": "GPS & Shot Tracking",
  "capability.sec.gps.i1": "Live distance to front / centre / back of green",
  "capability.sec.gps.i2": "Shot-by-shot GPS tracking (Tee → Fairway → Approach → Putt)",
  "capability.sec.gps.i3": "3D hole flyover via satellite imagery",
  "capability.sec.gps.i4": "Garmin, Apple Watch & Fitbit sync",
  "capability.sec.analytics.title": "Player Analytics & Performance",
  "capability.sec.analytics.i1": "Strokes Gained — OTT, Approach, ATG, Putting (PGA Tour baselines)",
  "capability.sec.analytics.i2": "Fairways hit, GIR, putts, scoring average trend charts",
  "capability.sec.analytics.i3": "Club distance profiling",
  "capability.sec.analytics.i4": "Practice session tracker",
  "capability.sec.analytics.i5": "Interactive round replay map",
  "capability.sec.analytics.i6": "Shareable round summary card",
  "capability.sec.analytics.i7": "National & regional rankings integration",
  "capability.sec.analytics.i8": "50+ achievement badges & gamification milestones",
  "capability.sec.achievements.title": "Achievements & Gamification",
  "capability.sec.achievements.i1": "50+ unlockable achievement badges",
  "capability.sec.achievements.i2": "Milestone tracking — first birdie, eagle, hole-in-one, sub-par round",
  "capability.sec.achievements.i3": "Seasonal challenges & club-wide leaderboard milestones",
  "capability.sec.achievements.i4": "Social sharing of achievements to club feed",
  "capability.sec.achievements.i5": "Anniversary & loyalty recognition badges",
  "capability.sec.achievements.i6": "Admin-created custom club achievement categories",
  "capability.sec.membership.title": "Membership & Club Administration",
  "capability.sec.membership.i1": "Full member lifecycle — onboarding, classification, renewal",
  "capability.sec.membership.i2": "Role-based access — Super Admin / Club Admin / Scorer / Member",
  "capability.sec.membership.i3": "Automated recurring dues billing",
  "capability.sec.membership.i4": "Digital membership card with QR code",
  "capability.sec.membership.i5": "Handicap committee tools & governance",
  "capability.sec.membership.i6": "Club governance hub — documents, board minutes, member voting",
  "capability.sec.payments.title": "Payments & Finance",
  "capability.sec.payments.i1": "Razorpay — entry fees, dues, shop (multi-currency)",
  "capability.sec.payments.i2": "COD support & GST-compliant tax invoices",
  "capability.sec.payments.i3": "Financial reporting dashboard by event / category / period",
  "capability.sec.payments.i4": "Refund workflow & payment reminders",
  "capability.sec.payments.i5": "Razorpay Payment Links",
  "capability.sec.payments.i6": "Sponsor payment & contract tracking",
  "capability.sec.communications.title": "Communications & Notifications",
  "capability.sec.communications.i1": "Email delivery (SMTP)",
  "capability.sec.communications.i2": "Push notifications — iOS & Android",
  "capability.sec.communications.i3": "SMS & WhatsApp broadcast",
  "capability.sec.communications.i4": "In-app messaging per tournament / league",
  "capability.sec.communications.i5": "Automated communication workflow builder",
  "capability.sec.communications.i6": "Club-branded email templates & post-event recaps",
  "capability.sec.branding.title": "Club Branding, White-Labelling & Sponsorship",
  "capability.sec.branding.i1": "Custom logo, colours, and domain per club",
  "capability.sec.branding.i2": "Branded scorecards, results PDFs & emails",
  "capability.sec.branding.i3": "Sponsor logos on leaderboards, scorecards & results pages",
  "capability.sec.branding.i4": "Sponsor CRM — contracts, deal values, renewals",
  "capability.sec.branding.i5": "Sponsor self-service portal",
  "capability.sec.branding.i6": "Automated ROI reporting & analytics",
  "capability.sec.branding.i7": "CTP / Longest Drive hole sponsorships",
  "capability.sec.branding.i8": "Custom registration forms & post-event surveys",
  "capability.sec.proshop.title": "Pro Shop, POS & E-Commerce",
  "capability.sec.proshop.i1": "POS terminal with barcode scanning & multi-location inventory",
  "capability.sec.proshop.i2": "Supplier purchase orders & receiving",
  "capability.sec.proshop.i3": "Returns, refunds & exchanges",
  "capability.sec.proshop.i4": "Member pricing, promotions & loyalty rewards",
  "capability.sec.proshop.i5": "Gift cards & store credit",
  "capability.sec.proshop.i6": "Online shop with dropshipping (Shiprocket + Printful)",
  "capability.sec.proshop.i7": "GST invoices & commerce analytics",
  "capability.sec.proshop.i8": "Third-party vendor / consignment operator support",
  "capability.sec.facilities.title": "Facilities & Operations Management",
  "capability.sec.facilities.i1": "Golf Cart Fleet — GPS tracking, scheduling & maintenance logs",
  "capability.sec.facilities.i2": "Driving Range & Bay Booking — time slots & billing",
  "capability.sec.facilities.i3": "Locker Room — assignments, renewals & waitlist",
  "capability.sec.facilities.i4": "Rental Equipment — clubs, trolleys, GPS devices",
  "capability.sec.facilities.i5": "Course condition reports (published live to mobile)",
  "capability.sec.facilities.i6": "F&B on-course ordering — from any hole, paid at order or on tab",
  "capability.sec.facilities.i7": "Lesson & Coaching Booking — pro calendar, student history",
  "capability.sec.facilities.i8": "Junior Golf Programmes — enrolment, progress & parent notifications",
  "capability.sec.teetime.title": "Tee Time Booking",
  "capability.sec.teetime.i1": "Member & public booking portal",
  "capability.sec.teetime.i2": "Rule-based slot engine — normal, split tee & shotgun",
  "capability.sec.teetime.i3": "Maintenance blocks & event reservations",
  "capability.sec.teetime.i4": "Booking management & cancellation workflow",
  "capability.sec.social.title": "Social & Community",
  "capability.sec.social.i1": "Club social wall & activity feed",
  "capability.sec.social.i2": "Media galleries (photos & video) per tournament & league",
  "capability.sec.social.i3": "Real-time tournament chat rooms",
  "capability.sec.social.i4": "Fantasy Golf League",
  "capability.sec.social.i5": "Golf trip & away day planner",
  "capability.sec.social.i6": "Pace of play tracker",
  "capability.sec.saas.title": "Multi-Club SaaS Platform",
  "capability.sec.saas.i1": "Self-service club onboarding with subscription billing",
  "capability.sec.saas.i2": "Super-Admin dashboard for platform-wide oversight",
  "capability.sec.saas.i3": "Per-club data isolation and access controls",
  "capability.sec.saas.i4": "Public club directory on KHARAGOLF.com",
  "capability.sec.integrations.title": "Integrations & API",
  "capability.sec.integrations.i1": "GHIN player & course data lookup",
  "capability.sec.integrations.i2": "Razorpay, Shiprocket, Printful",
  "capability.sec.integrations.i3": "OpenWeatherMap — weather widget on tournament day",
  "capability.sec.integrations.i4": "Outbound webhook API for external system integration",
  "capability.sec.integrations.i5": "Custom report builder — CSV & PDF export",
  "capability.sec.integrations.i6": "Calendar export (iCal / Google Calendar)",
  "capability.sec.lang.title": "Multi-Language Support",
  "capability.sec.lang.i1": "21 languages across 6 global regions — with full RTL support for Arabic",
  "capability.sec.lang.i2": "🌍 Global Core: English, Spanish, French, German, Portuguese",
  "capability.sec.lang.i3": "🇮🇳 South Asia: Hindi",
  "capability.sec.lang.i4": "🇸🇦 Middle East: Arabic (RTL — right-to-left layout across web and mobile)",
  "capability.sec.lang.i5": "🌏 East Asia: Japanese, Korean, Chinese (Simplified)",
  "capability.sec.lang.i6": "🌏 Southeast Asia: Thai, Bahasa Melayu, Bahasa Indonesia, Tiếng Việt, Filipino",
  "capability.sec.lang.i7": "🌍 Africa: Kiswahili, Afrikaans, Amharic, Hausa, isiZulu, Yorùbá",
  "capability.sec.lang.i8": "All UI strings translated — buttons, labels, errors, navigation, notifications",
  "capability.sec.lang.i9": "Language preference stored per user, applied automatically on login",
  "capability.sec.lang.i10": "Players change language from profile settings (web & mobile)",
  "capability.sec.lang.i11": "Club admins set a default language for their club",
  "capability.sec.lang.i12": "Public registration page respects the club's default language",
  "capability.sec.lang.i13": "Date, number, and currency formats follow locale conventions",
  "capability.sec.apps.title": "Native iOS, Android & Wearable Apps",
  "capability.sec.apps.ios.heading": "iOS — App Store Ready (Swift / SwiftUI)",
  "capability.sec.apps.ios.i1": "Full feature parity — scoring, leaderboards, handicap, tee times, shop",
  "capability.sec.apps.ios.i2": "Biometric authentication (Face ID / Touch ID)",
  "capability.sec.apps.ios.i3": "APNs push notifications",
  "capability.sec.apps.ios.i4": "Background GPS tracking & native haptic feedback",
  "capability.sec.apps.android.heading": "Android — Google Play Ready (Kotlin / Jetpack Compose)",
  "capability.sec.apps.android.i1": "Full feature parity, Material You design aligned to brand",
  "capability.sec.apps.android.i2": "Fingerprint / biometric authentication",
  "capability.sec.apps.android.i3": "FCM push notifications",
  "capability.sec.apps.android.i4": "Background GPS tracking",
  "capability.sec.apps.watchos.heading": "Apple Watch (watchOS)",
  "capability.sec.apps.watchos.i1": "Complication showing current round score & upcoming hole par",
  "capability.sec.apps.watchos.i2": "Hole-by-hole score entry using the digital crown",
  "capability.sec.apps.watchos.i3": "Live distance-to-pin display",
  "capability.sec.apps.watchos.i4": "Round timer — syncs with iPhone via WatchConnectivity",
  "capability.sec.apps.wearos.heading": "Wear OS",
  "capability.sec.apps.wearos.i1": "Scorecard entry tiles",
  "capability.sec.apps.wearos.i2": "Glance showing current score vs par",
  "capability.sec.apps.wearos.i3": "Tee time reminder notifications",
  "capability.sec.apps.wearos.i4": "Syncs with Android phone via Data Layer API",
  "capability.sec.apps.garmin.heading": "Garmin Connect IQ",
  "capability.sec.apps.garmin.i1": "Custom data field & widget — hole score, distance to pin (GPS), handicap index",
  "capability.sec.apps.garmin.i2": "Side-loadable on all compatible Garmin devices",
  "capability.footer.subtitle": "The Definitive Tournament Management Platform",
  "capability.footer.confidential": "Confidential — Prepared for prospective partners & clubs · April 2026",

  // 404.
  "notFound.title": "404 Page Not Found",
  "notFound.body": "Did you forget to add the page to the router?",

  // Task #2204 — page metadata for search engines and social previews.
  // These power <title>, <meta name="description"> and the og:/twitter:
  // title/description tags on each marketing page.
  "seo.home.title": "KHARAGOLF — Tournament & Club Operating System for Golf Clubs",
  "seo.home.description":
    "KHARAGOLF is the modern operating system for golf clubs: live tournament management, WHS-compliant handicaps, member portal, marketing tools and ROI you can measure.",
  "seo.pricing.title": "KHARAGOLF Pricing — Tournament & Club Operations Platform",
  "seo.pricing.description":
    "Transparent pricing for KHARAGOLF, the tournament and club operating system trusted by golf clubs across India. From a free Starter tier to Enterprise.",
} satisfies Record<string, string>;

export type SiteKey = keyof typeof en;
export type SiteStrings = Record<SiteKey, string>;

/** Spanish — full coverage. */
const es: SiteStrings = {
  "nav.home": "Inicio",
  "nav.forClubs": "Para clubes",
  "nav.forGolfers": "Para golfistas",
  "nav.features": "Funciones",
  "nav.pricing": "Precios",
  "nav.contact": "Contacto",
  "nav.bookDemo": "Reservar demo",

  "lang.label": "Idioma",
  "lang.switchTo": "Cambiar idioma",

  "home.hero.kicker": "El nuevo estándar",
  "home.hero.titleLine1": "La maestría exige",
  "home.hero.titleLine2": "precisión.",
  "home.hero.subtitle":
    "KHARAGOLF es la plataforma definitiva de gestión de torneos para clubes que se toman en serio su juego. Hecha para la era moderna, con raíces en la tradición.",
  "home.hero.ctaPrimary": "Solicitar acceso",
  "home.hero.ctaSecondary": "Explorar la plataforma",

  "home.partners.kicker": "La confianza de clubes en todo el país",

  "home.platform.features.engine.title": "Motor confiable",
  "home.platform.features.engine.desc":
    "Infraestructura de nivel bancario que garantiza clasificaciones rapidísimas y sin fallos, incluso con más de 500 anotadores en vivo.",
  "home.platform.features.analytics.title": "Analítica en vivo",
  "home.platform.features.analytics.desc":
    "Strokes gained en tiempo real, estadísticas hoyo a hoyo y leaderboards por flights que se actualizan al instante en todas las pantallas.",
  "home.platform.features.ecosystem.title": "Ecosistema unificado",
  "home.platform.features.ecosystem.desc":
    "Del televisor del club al móvil del jugador, una sola experiencia fluida que eleva el prestigio de sus eventos.",

  "home.forClubs.kicker": "Para clubes",
  "home.forClubs.title": "Un sistema operativo completo para tu club.",
  "home.forClubs.subtitle":
    "Todos los módulos que tu club necesita — integrados, con un diseño cuidado y pensados para cómo se gestiona realmente el golf.",

  "home.howItWorks.title": "En marcha en días, no en meses.",
  "home.howItWorks.subtitle":
    "Nuestro proceso de onboarding está diseñado para administradores ocupados. Nosotros hacemos el trabajo pesado.",
  "home.howItWorks.cta": "Comienza tu camino",

  "home.howItWorks.step1.title": "Onboarding",
  "home.howItWorks.step1.desc":
    "Reserva una demo, comparte los datos de tu club y configuramos tu entorno KHARAGOLF — campos, tee boxes, roles de socios y ajustes de hándicap.",
  "home.howItWorks.step2.title": "Configurar",
  "home.howItWorks.step2.desc":
    "Importa tus datos de socios actuales, crea tu primer torneo y personaliza la plataforma para que coincida con la identidad y el flujo de trabajo de tu club.",
  "home.howItWorks.step3.title": "En vivo",
  "home.howItWorks.step3.desc":
    "Lanza tu primer evento en vivo, comparte enlaces públicos a las tarjetas con los espectadores y observa cómo las operaciones de tu club se transforman en tiempo real.",

  "home.modules.tournament.title": "Motor de torneos",
  "home.modules.tournament.desc":
    "Crea y ejecuta cualquier formato — Strokeplay, Stableford, Match Play, Eclectic y más de 10 — con puntuación y flighting automáticos.",
  "home.modules.handicap.title": "Hándicap y socios",
  "home.modules.handicap.desc":
    "Gestión de hándicap conforme al WHS, perfiles de socios, reservas de tee time y herramientas para todo el ciclo de vida de la membresía.",
  "home.modules.leaderboards.title": "Leaderboards en vivo",
  "home.modules.leaderboards.desc":
    "Puntuación en tiempo real con analítica de strokes gained, seguimiento hoyo a hoyo y pantallas públicas para la casa club.",
  "home.modules.league.title": "Gestión de ligas",
  "home.modules.league.desc":
    "Calendarios de liga para toda la temporada, generación de fixtures, tablas de clasificación y procesamiento automático de resultados.",
  "home.modules.sponsorship.title": "Hub de patrocinios",
  "home.modules.sponsorship.desc":
    "Gestiona patrocinadores, asigna derechos de marca, genera facturas y entrega informes de ROI — todo desde un solo panel.",
  "home.modules.comms.title": "Comunicaciones",
  "home.modules.comms.desc":
    "Campañas de SMS y email, anuncios de eventos, notificaciones push y un tablón digital completo para los socios.",
  "home.modules.proshop.title": "Pro shop y proveedores",
  "home.modules.proshop.desc":
    "Punto de venta integrado, gestión de inventario, consignación, tarjetas de regalo y coordinación con proveedores externos.",
  "home.modules.analytics.title": "Analítica y finanzas",
  "home.modules.analytics.desc":
    "Paneles de ingresos, facturación de socios, control de cuotas, integraciones contables e informes financieros exportables.",

  "home.testimonials.title": "Lo que dicen los clubes.",
  "home.testimonials.readCaseStudy": "Leer caso de estudio",
  "home.testimonials.t1.quote":
    "KHARAGOLF transformó la forma en que organizamos nuestro Club Championship. La leaderboard en vivo tuvo a los socios pegados al móvil durante todo el evento. No volveríamos atrás.",
  "home.testimonials.t1.author": "Director de torneos",
  "home.testimonials.t1.metric": "3,4× más participación en vivo",
  "home.testimonials.t2.quote":
    "El motor de hándicap es el más preciso que hemos usado, y el sistema de emparejamiento automático ahorró a nuestro comité horas de trabajo manual en cada ronda.",
  "home.testimonials.t2.author": "Secretario del club",
  "home.testimonials.t2.metric": "18 h ahorradas / evento",
  "home.testimonials.t3.quote":
    "Montar un scramble corporativo de 72 jugadores solía ser un proyecto de fin de semana. Con KHARAGOLF, nuestro responsable de operaciones lo hizo en menos de dos horas.",
  "home.testimonials.t3.author": "Responsable de operaciones de golf",
  "home.testimonials.t3.metric": "Listo en <2 h",

  "home.demo.title": "¿Listo para llevar las operaciones de tu club al siguiente nivel?",
  "home.demo.subtitle":
    "Reserva una demostración personalizada de 30 minutos de KHARAGOLF. Te mostraremos exactamente cómo nuestra plataforma puede agilizar tu próximo gran torneo.",
  "home.demo.feature.schedule.title": "Agenda un recorrido",
  "home.demo.feature.schedule.desc":
    "Ve la plataforma en acción con datos en vivo.",
  "home.demo.feature.migration.title": "Plan de migración a medida",
  "home.demo.feature.migration.desc":
    "Nos encargamos de importar los datos de tus socios actuales.",
  "home.demo.formHeading": "Solicitar acceso",

  "demoBooking.calendarHeading": "Elige una franja de 30 min",
  "demoBooking.loadingSlots": "Cargando horarios disponibles…",
  "demoBooking.noSlots":
    "No hay franjas próximas disponibles — escríbenos por correo.",
  "demoBooking.detailsHeading": "Tus datos",
  "demoBooking.input.name": "Nombre completo",
  "demoBooking.input.email": "Correo de trabajo",
  "demoBooking.input.club": "Club / organización",
  "demoBooking.input.phone": "Teléfono (opcional)",
  "demoBooking.input.message": "¿Algo concreto que te gustaría ver?",
  "demoBooking.interest.placeholder": "¿Cuál es tu principal interés?",
  "demoBooking.interest.empty": "Interés principal…",
  "demoBooking.interest.tournaments": "Gestión de torneos",
  "demoBooking.interest.handicaps": "Sistema de hándicap",
  "demoBooking.interest.league": "Operaciones de liga",
  "demoBooking.interest.full": "Sistema operativo completo del club",
  "demoBooking.selected": "Seleccionado: {{when}}",
  "demoBooking.pickPrompt":
    "Elige una franja a la izquierda para activar la reserva.",
  "demoBooking.submitting": "Reservando…",
  "demoBooking.submit": "Confirmar demo",
  "demoBooking.toast.pickTime.title": "Elige una hora",
  "demoBooking.toast.pickTime.desc":
    "Selecciona una franja del calendario de arriba.",
  "demoBooking.toast.addDetails.title": "Añade tus datos",
  "demoBooking.toast.addDetails.desc":
    "El nombre y el correo son obligatorios.",
  "demoBooking.toast.booked.title": "Demo reservada",
  "demoBooking.toast.booked.desc":
    "Te enviamos la confirmación con la invitación al calendario.",
  "demoBooking.toast.failed.title": "No se pudo reservar la franja",
  "demoBooking.toast.failed.desc":
    "Prueba con otra hora o contáctanos directamente.",
  "demoBooking.confirmed.heading": "¡Reserva confirmada!",
  "demoBooking.confirmed.note":
    "Te enviamos un correo de confirmación con la invitación al calendario a {{email}}.",

  "cookies.aria": "Consentimiento de cookies",
  "cookies.title": "Valoramos tu privacidad",
  "cookies.body":
    "Usamos cookies estrictamente necesarias para que el sitio funcione. Con tu consentimiento, también usamos cookies de analítica y marketing. Puedes cambiar tu elección en cualquier momento. Más información en nuestra {{link}}.",
  "cookies.policyLink": "política de privacidad",
  "cookies.necessary": "Necesarias (siempre activas)",
  "cookies.analytics": "Analítica — estadísticas de uso anónimas",
  "cookies.marketing": "Marketing — anuncios y ofertas personalizados",
  "cookies.button.customise": "Personalizar",
  "cookies.button.save": "Guardar elección",
  "cookies.button.reject": "Rechazar opcionales",
  "cookies.button.accept": "Aceptar todas",

  "footer.tagline":
    "El sistema operativo de torneos de golf de grado profesional para clubes que exigen excelencia.",
  "footer.col.platform": "Plataforma",
  "footer.col.company": "Compañía",
  "footer.link.formats": "Formatos",
  "footer.link.privacy": "Política de privacidad",
  "footer.link.terms": "Términos del servicio",
  "footer.link.support": "Soporte",
  "footer.copyright": "© {{year}} KHARAGOLF. Todos los derechos reservados.",

  "pricing.kicker": "Precios",
  "pricing.title": "Transparente. Predecible. Diseñado para escalar.",
  "pricing.subtitle":
    "Una tarifa plana por club. Sin recargos por miembro, sin cargos por día de evento, sin facturas sorpresa cuando su torneo se hace viral.",
  "pricing.billing.monthly": "Mensual",
  "pricing.billing.annual": "Anual",
  "pricing.billing.annualSave": "ahorra 16%",
  "pricing.plan.mostPopular": "Más popular",
  "pricing.plan.free": "Gratis",
  "pricing.plan.suffix.monthly": "/mes",
  "pricing.plan.suffix.annual": "/año",
  "pricing.plan.members": "Miembros",
  "pricing.plan.unlimited": "Ilimitado",
  "pricing.plan.activeEvents": "Eventos activos",
  "pricing.plan.cta.enterprise": "Hablar con ventas",
  "pricing.plan.cta.default": "Empezar",
  "pricing.compare.title": "Compara cada función.",
  "pricing.faq.kicker": "FAQ de precios",
  "pricing.faq.title": "Preguntas, respondidas.",
  "pricing.demo.title": "Vea KHARAGOLF para su club.",
  "pricing.demo.subtitle":
    "Elija una franja de 30 minutos y le mostraremos en vivo su caso exacto.",

  "capability.kicker": "Informe de capacidades de la plataforma",
  "capability.print": "Imprimir / Guardar como PDF",

  // Capability Report — long-form brochure body (Spanish).
  "capability.subtitle": "La plataforma definitiva de gestión de torneos",
  "capability.quote": "La maestría exige precisión.",
  "capability.intro.p1":
    "KHARAGOLF es una plataforma de gestión de clubes de golf de nivel empresarial, creada específicamente para clubes de prestigio, federaciones nacionales y directores de torneos profesionales. Unifica cada faceta de la vida del club —desde la gestión de hándicap conforme a WHS y el scoring de torneos en vivo hasta la reserva de tee times, el TPV de la pro shop y los pedidos de F&B en el campo— en un único sistema, bellamente diseñado y disponible en 21 idiomas a través de 6 regiones globales.",
  "capability.intro.p2":
    "La plataforma sirve a tres audiencias simultáneamente: {{admin}}, {{players}} y {{sponsors}}, en web, iOS, Android, Apple Watch, Wear OS y Garmin.",
  "capability.intro.audience.admin": "Administradores de club",
  "capability.intro.audience.player": "Jugadores",
  "capability.intro.audience.sponsor": "Patrocinadores",
  "capability.sec.channels.title": "Canales de la plataforma",
  "capability.sec.channels.i1":
    "Web empresarial — Centro de mando del admin: torneos, miembros, finanzas, operaciones",
  "capability.sec.channels.i2":
    "App iOS (nativa) — Portal del jugador: scoring, reservas, analítica, tienda (App Store)",
  "capability.sec.channels.i3": "App Android (nativa) — Paridad total con iOS (Google Play)",
  "capability.sec.channels.i4": "Apple Watch — Scoring de muñeca, distancias GPS, complications",
  "capability.sec.channels.i5": "Wear OS — Tiles de tarjeta, vista score vs par, avisos de tee time",
  "capability.sec.channels.i6":
    "Garmin Connect IQ — Score, yardaje GPS e índice de hándicap en dispositivos Garmin",
  "capability.sec.channels.i7": "KHARAGOLF.com — Marketing, directorio de clubes, demos y precios",
  "capability.sec.channels.i8": "API / KHARAGOLF Cloud — Motor de datos unificado para todas las superficies",
  "capability.sec.tournament.title": "Motor de torneos y competición",
  "capability.sec.tournament.i1": "Stroke Play (gross y net), Stableford, Max Score, Par",
  "capability.sec.tournament.i2": "Match Play — Ryder Cup, Foursomes, Greensomes, Scramble, Best Ball, Shamble",
  "capability.sec.tournament.i3": "Eventos a varias rondas con líneas de corte",
  "capability.sec.tournament.i4": "Campeonatos multi-campo y encuentros interclub",
  "capability.sec.tournament.i5": "Salidas shotgun, split tee y simultáneas",
  "capability.sec.tournament.i6": "Cálculo automático del Playing Handicap WHS",
  "capability.sec.tournament.i7": "Side games — Skins, CTP, Longest Drive, pool de birdies",
  "capability.sec.tournament.i8": "Leaderboard en vivo — tiempo real, modo kiosko, panel TV",
  "capability.sec.tournament.i9": "Página pública de resultados (compartible, sin login)",
  "capability.sec.tournament.i10": "Tarjetas de bolsillo profesionales de 4 paneles (PDF + QR)",
  "capability.sec.tournament.i11": "Constructor de draws — emparejamientos auto, drag-and-drop, bloqueo manual",
  "capability.sec.tournament.i12": "Gestión de flights — asignación masiva, drag-and-drop",
  "capability.sec.tournament.i13": "Calculadora de premios y asignación automática",
  "capability.sec.tournament.i14": "Lista de espera con promoción automática",
  "capability.sec.tournament.i15": "Plantillas de torneo — guarda y reutiliza formatos",
  "capability.sec.tournament.i16": "Eventos corporativos y benéficos",
  "capability.sec.tournament.i17": "Scoring eclectic y Order of Merit",
  "capability.sec.tournament.i18": "Simulador de hándicap y modelado what-if",
  "capability.sec.tournament.i19": "Competiciones por equipos — equipos, plantillas y agregación de hándicap",
  "capability.sec.tournament.i20": "Draws, leaderboards y scoring por equipos",
  "capability.sec.tournament.i21": "Inscripción masiva y gestión de inscripciones por equipo",
  "capability.sec.league.title": "Gestión de ligas",
  "capability.sec.league.i1": "Stroke, Stableford, Match Play y Round Robin",
  "capability.sec.league.i2": "Ligas por equipos — equipos, plantillas y clasificaciones",
  "capability.sec.league.i3": "Clasificaciones de temporada y tarjetas acumuladas",
  "capability.sec.league.i4": "Impresión y exportación de tarjetas en PDF",
  "capability.sec.league.i5": "Notificaciones de resultados a todos los miembros tras cada ronda",
  "capability.sec.whs.title": "Sistema mundial de hándicap (WHS 2024/2026)",
  "capability.sec.whs.i1": "Cumplimiento total de las Rules of Handicapping del WHS",
  "capability.sec.whs.i2": "Score differential — 18 hoyos, 9 hoyos y prorrateo de rondas parciales",
  "capability.sec.whs.i3": "ESR, Soft Cap y Hard Cap aplicados",
  "capability.sec.whs.i4": "Lógica de los 8 mejores diferenciales de los últimos 20",
  "capability.sec.whs.i5": "Subida automática de scores a GHIN / IGU",
  "capability.sec.whs.i6": "Gobernanza del comité de hándicap y simulador",
  "capability.sec.scoring.title": "Scoring en vivo — Todos los canales",
  "capability.sec.scoring.i1": "Consola web del anotador — entrada masiva en grilla para campos grandes",
  "capability.sec.scoring.i2": "Estación móvil del anotador — flujo centrado en el grupo",
  "capability.sec.scoring.i3": "Auto-scoring del jugador con confirmación del marker (cumple WHS)",
  "capability.sec.scoring.i4": "Scoring autónomo de muñeca en Apple Watch y Wear OS",
  "capability.sec.scoring.i5": "Scoring offline con sincronización automática en segundo plano",
  "capability.sec.gps.title": "GPS y seguimiento de tiros",
  "capability.sec.gps.i1": "Distancia en vivo a frente / centro / fondo del green",
  "capability.sec.gps.i2": "Seguimiento GPS tiro a tiro (Tee → Calle → Approach → Putt)",
  "capability.sec.gps.i3": "Vuelo 3D del hoyo con imágenes satelitales",
  "capability.sec.gps.i4": "Sincronización con Garmin, Apple Watch y Fitbit",
  "capability.sec.analytics.title": "Analítica y rendimiento del jugador",
  "capability.sec.analytics.i1": "Strokes Gained — OTT, Approach, ATG, Putting (baselines del PGA Tour)",
  "capability.sec.analytics.i2": "Calles, GIR, putts y gráficos de tendencia del scoring",
  "capability.sec.analytics.i3": "Perfilado de distancias por palo",
  "capability.sec.analytics.i4": "Registro de sesiones de práctica",
  "capability.sec.analytics.i5": "Mapa interactivo de repetición de la ronda",
  "capability.sec.analytics.i6": "Tarjeta resumen de la ronda compartible",
  "capability.sec.analytics.i7": "Integración con rankings nacionales y regionales",
  "capability.sec.analytics.i8": "Más de 50 insignias de logros y hitos de gamificación",
  "capability.sec.achievements.title": "Logros y gamificación",
  "capability.sec.achievements.i1": "Más de 50 insignias de logros desbloqueables",
  "capability.sec.achievements.i2": "Hitos — primer birdie, eagle, hole-in-one, ronda bajo par",
  "capability.sec.achievements.i3": "Retos de temporada y hitos del leaderboard del club",
  "capability.sec.achievements.i4": "Compartir logros en el feed social del club",
  "capability.sec.achievements.i5": "Insignias de aniversario y reconocimiento por fidelidad",
  "capability.sec.achievements.i6": "Categorías de logros del club personalizadas por el admin",
  "capability.sec.membership.title": "Membresía y administración del club",
  "capability.sec.membership.i1": "Ciclo de vida del miembro — alta, clasificación, renovación",
  "capability.sec.membership.i2": "Acceso por roles — Super Admin / Admin de club / Anotador / Miembro",
  "capability.sec.membership.i3": "Facturación recurrente automática de cuotas",
  "capability.sec.membership.i4": "Tarjeta digital de socio con código QR",
  "capability.sec.membership.i5": "Herramientas y gobernanza del comité de hándicap",
  "capability.sec.membership.i6": "Gobernanza del club — documentos, actas y votaciones de socios",
  "capability.sec.payments.title": "Pagos y finanzas",
  "capability.sec.payments.i1": "Razorpay — inscripciones, cuotas, tienda (multi-divisa)",
  "capability.sec.payments.i2": "Soporte COD y facturas fiscales conformes a GST",
  "capability.sec.payments.i3": "Panel financiero por evento / categoría / período",
  "capability.sec.payments.i4": "Flujo de reembolsos y recordatorios de pago",
  "capability.sec.payments.i5": "Razorpay Payment Links",
  "capability.sec.payments.i6": "Seguimiento de pagos y contratos de patrocinadores",
  "capability.sec.communications.title": "Comunicaciones y notificaciones",
  "capability.sec.communications.i1": "Envío de email (SMTP)",
  "capability.sec.communications.i2": "Notificaciones push — iOS y Android",
  "capability.sec.communications.i3": "Difusión por SMS y WhatsApp",
  "capability.sec.communications.i4": "Mensajería in-app por torneo / liga",
  "capability.sec.communications.i5": "Constructor de flujos de comunicación automatizada",
  "capability.sec.communications.i6": "Plantillas de email con marca del club y resúmenes post-evento",
  "capability.sec.branding.title": "Marca, white-label y patrocinio del club",
  "capability.sec.branding.i1": "Logo, colores y dominio personalizados por club",
  "capability.sec.branding.i2": "Tarjetas, PDF de resultados y emails con marca",
  "capability.sec.branding.i3": "Logos de patrocinadores en leaderboards, tarjetas y resultados",
  "capability.sec.branding.i4": "CRM de patrocinadores — contratos, importes, renovaciones",
  "capability.sec.branding.i5": "Portal self-service para patrocinadores",
  "capability.sec.branding.i6": "Reportes y analítica de ROI automáticos",
  "capability.sec.branding.i7": "Patrocinios de hoyo CTP / Longest Drive",
  "capability.sec.branding.i8": "Formularios de inscripción y encuestas post-evento personalizables",
  "capability.sec.proshop.title": "Pro Shop, TPV y e-commerce",
  "capability.sec.proshop.i1": "Terminal TPV con escaneo de barras e inventario multi-local",
  "capability.sec.proshop.i2": "Órdenes de compra y recepción de proveedores",
  "capability.sec.proshop.i3": "Devoluciones, reembolsos y cambios",
  "capability.sec.proshop.i4": "Precios para socios, promociones y recompensas de fidelidad",
  "capability.sec.proshop.i5": "Tarjetas regalo y crédito de tienda",
  "capability.sec.proshop.i6": "Tienda online con dropshipping (Shiprocket + Printful)",
  "capability.sec.proshop.i7": "Facturas GST y analítica de comercio",
  "capability.sec.proshop.i8": "Soporte para vendedores externos / consignación",
  "capability.sec.facilities.title": "Instalaciones y operaciones",
  "capability.sec.facilities.i1": "Flota de buggies — GPS, programación y mantenimiento",
  "capability.sec.facilities.i2": "Driving range y reserva de bays — franjas y facturación",
  "capability.sec.facilities.i3": "Vestuarios — asignaciones, renovaciones y lista de espera",
  "capability.sec.facilities.i4": "Equipo de alquiler — palos, carros, dispositivos GPS",
  "capability.sec.facilities.i5": "Reportes de estado del campo (publicados en vivo al móvil)",
  "capability.sec.facilities.i6": "Pedidos de F&B en el campo — desde cualquier hoyo, al pedir o a cuenta",
  "capability.sec.facilities.i7": "Reserva de clases — calendario del pro, historial del alumno",
  "capability.sec.facilities.i8": "Programas de golf junior — inscripciones, progreso y avisos a padres",
  "capability.sec.teetime.title": "Reserva de tee times",
  "capability.sec.teetime.i1": "Portal de reserva para socios y público",
  "capability.sec.teetime.i2": "Motor de slots por reglas — normal, split tee y shotgun",
  "capability.sec.teetime.i3": "Bloqueos por mantenimiento y reservas para eventos",
  "capability.sec.teetime.i4": "Gestión de reservas y flujo de cancelación",
  "capability.sec.social.title": "Social y comunidad",
  "capability.sec.social.i1": "Muro social del club y feed de actividad",
  "capability.sec.social.i2": "Galerías (foto y vídeo) por torneo y liga",
  "capability.sec.social.i3": "Salas de chat de torneo en tiempo real",
  "capability.sec.social.i4": "Liga de Fantasy Golf",
  "capability.sec.social.i5": "Planificador de viajes y away days",
  "capability.sec.social.i6": "Tracker de pace of play",
  "capability.sec.saas.title": "Plataforma SaaS multi-club",
  "capability.sec.saas.i1": "Onboarding self-service del club con facturación por suscripción",
  "capability.sec.saas.i2": "Panel de Super-Admin para supervisión global",
  "capability.sec.saas.i3": "Aislamiento de datos y controles de acceso por club",
  "capability.sec.saas.i4": "Directorio público de clubes en KHARAGOLF.com",
  "capability.sec.integrations.title": "Integraciones y API",
  "capability.sec.integrations.i1": "Búsqueda de jugadores y campos en GHIN",
  "capability.sec.integrations.i2": "Razorpay, Shiprocket, Printful",
  "capability.sec.integrations.i3": "OpenWeatherMap — widget meteorológico el día del torneo",
  "capability.sec.integrations.i4": "API de webhooks salientes para integración con sistemas externos",
  "capability.sec.integrations.i5": "Constructor de informes — exportación CSV y PDF",
  "capability.sec.integrations.i6": "Exportación de calendario (iCal / Google Calendar)",
  "capability.sec.lang.title": "Soporte multi-idioma",
  "capability.sec.lang.i1": "21 idiomas en 6 regiones globales — con soporte RTL completo para árabe",
  "capability.sec.lang.i2": "🌍 Núcleo global: inglés, español, francés, alemán, portugués",
  "capability.sec.lang.i3": "🇮🇳 Sur de Asia: hindi",
  "capability.sec.lang.i4": "🇸🇦 Oriente Medio: árabe (RTL — diseño de derecha a izquierda en web y móvil)",
  "capability.sec.lang.i5": "🌏 Asia Oriental: japonés, coreano, chino (simplificado)",
  "capability.sec.lang.i6":
    "🌏 Sudeste asiático: tailandés, Bahasa Melayu, Bahasa Indonesia, Tiếng Việt, filipino",
  "capability.sec.lang.i7": "🌍 África: kiswahili, afrikáans, amhárico, hausa, isiZulu, yorùbá",
  "capability.sec.lang.i8": "Toda la UI traducida — botones, etiquetas, errores, navegación, notificaciones",
  "capability.sec.lang.i9": "Preferencia de idioma guardada por usuario y aplicada al iniciar sesión",
  "capability.sec.lang.i10": "Los jugadores cambian el idioma desde su perfil (web y móvil)",
  "capability.sec.lang.i11": "Los admins definen un idioma por defecto para su club",
  "capability.sec.lang.i12": "La página pública de inscripción respeta el idioma del club",
  "capability.sec.lang.i13": "Los formatos de fecha, número y moneda siguen las convenciones locales",
  "capability.sec.apps.title": "Apps nativas iOS, Android y wearables",
  "capability.sec.apps.ios.heading": "iOS — Listo para App Store (Swift / SwiftUI)",
  "capability.sec.apps.ios.i1": "Paridad total — scoring, leaderboards, hándicap, tee times, tienda",
  "capability.sec.apps.ios.i2": "Autenticación biométrica (Face ID / Touch ID)",
  "capability.sec.apps.ios.i3": "Notificaciones push APNs",
  "capability.sec.apps.ios.i4": "GPS en segundo plano y feedback háptico nativo",
  "capability.sec.apps.android.heading": "Android — Listo para Google Play (Kotlin / Jetpack Compose)",
  "capability.sec.apps.android.i1": "Paridad total, diseño Material You alineado a la marca",
  "capability.sec.apps.android.i2": "Autenticación por huella / biométrica",
  "capability.sec.apps.android.i3": "Notificaciones push FCM",
  "capability.sec.apps.android.i4": "GPS en segundo plano",
  "capability.sec.apps.watchos.heading": "Apple Watch (watchOS)",
  "capability.sec.apps.watchos.i1": "Complication con score actual y par del próximo hoyo",
  "capability.sec.apps.watchos.i2": "Entrada de score hoyo a hoyo con la corona digital",
  "capability.sec.apps.watchos.i3": "Distancia al hoyo en vivo",
  "capability.sec.apps.watchos.i4": "Cronómetro de ronda — sincroniza con iPhone vía WatchConnectivity",
  "capability.sec.apps.wearos.heading": "Wear OS",
  "capability.sec.apps.wearos.i1": "Tiles de entrada de tarjeta",
  "capability.sec.apps.wearos.i2": "Glance con score actual frente a par",
  "capability.sec.apps.wearos.i3": "Avisos de tee time",
  "capability.sec.apps.wearos.i4": "Sincroniza con el teléfono Android vía Data Layer API",
  "capability.sec.apps.garmin.heading": "Garmin Connect IQ",
  "capability.sec.apps.garmin.i1": "Data field y widget — score del hoyo, distancia (GPS), índice de hándicap",
  "capability.sec.apps.garmin.i2": "Side-loadable en todos los Garmin compatibles",
  "capability.footer.subtitle": "La plataforma definitiva de gestión de torneos",
  "capability.footer.confidential": "Confidencial — Preparado para socios y clubes potenciales · Abril 2026",

  "notFound.title": "Página no encontrada (404)",
  "notFound.body": "¿Olvidaste añadir esta página al router?",

  "seo.home.title": "KHARAGOLF — Sistema operativo de torneos y clubes de golf",
  "seo.home.description":
    "KHARAGOLF es el sistema operativo moderno para clubes de golf: gestión de torneos en vivo, hándicaps conformes con WHS, portal de socios, herramientas de marketing y un ROI medible.",
  "seo.pricing.title": "Precios de KHARAGOLF — Plataforma de torneos y operaciones de club",
  "seo.pricing.description":
    "Precios transparentes de KHARAGOLF, el sistema operativo de torneos y clubes en el que confían los clubes de golf de toda la India. Desde el plan Starter gratuito hasta Enterprise.",
};

/** Hindi — full coverage. */
const hi: SiteStrings = {
  "nav.home": "होम",
  "nav.forClubs": "क्लबों के लिए",
  "nav.forGolfers": "गोल्फरों के लिए",
  "nav.features": "विशेषताएँ",
  "nav.pricing": "मूल्य",
  "nav.contact": "संपर्क",
  "nav.bookDemo": "डेमो बुक करें",

  "lang.label": "भाषा",
  "lang.switchTo": "भाषा बदलें",

  "home.hero.kicker": "नया मानक",
  "home.hero.titleLine1": "महारत के लिए चाहिए",
  "home.hero.titleLine2": "सटीकता।",
  "home.hero.subtitle":
    "KHARAGOLF उन क्लबों के लिए निश्चित टूर्नामेंट प्रबंधन प्लेटफ़ॉर्म है जो अपने खेल को गंभीरता से लेते हैं। आधुनिक युग के लिए बनाया गया, परंपरा में जड़ें।",
  "home.hero.ctaPrimary": "एक्सेस का अनुरोध करें",
  "home.hero.ctaSecondary": "प्लेटफ़ॉर्म एक्सप्लोर करें",

  "home.partners.kicker": "देशभर के क्लबों का भरोसा",

  "home.platform.features.engine.title": "विश्वसनीय इंजन",
  "home.platform.features.engine.desc":
    "बैंक-ग्रेड इंफ्रास्ट्रक्चर जो आपके लीडरबोर्ड को बिजली की रफ़्तार से और बिना रुकावट के चलाता है, 500+ लाइव स्कोरर्स के साथ भी।",
  "home.platform.features.analytics.title": "लाइव एनालिटिक्स",
  "home.platform.features.analytics.desc":
    "रीयल-टाइम स्ट्रोक्स गेन्ड, होल-दर-होल आंकड़े और फ्लाइटेड लीडरबोर्ड जो हर स्क्रीन पर तुरंत अपडेट होते हैं।",
  "home.platform.features.ecosystem.title": "एकीकृत इकोसिस्टम",
  "home.platform.features.ecosystem.desc":
    "क्लबहाउस के टीवी से लेकर खिलाड़ी के मोबाइल तक, एक ही सहज अनुभव जो आपके आयोजनों की प्रतिष्ठा बढ़ाता है।",

  "home.forClubs.kicker": "क्लबों के लिए",
  "home.forClubs.title": "आपके क्लब के लिए एक संपूर्ण ऑपरेटिंग सिस्टम।",
  "home.forClubs.subtitle":
    "हर वो मॉड्यूल जो आपके क्लब को चाहिए — पूरी तरह एकीकृत, खूबसूरती से डिज़ाइन किया हुआ और गोल्फ चलाने के असली तरीक़े के लिए बना।",

  "home.howItWorks.title": "महीनों में नहीं, दिनों में चालू।",
  "home.howItWorks.subtitle":
    "हमारी ऑनबोर्डिंग प्रक्रिया व्यस्त क्लब प्रशासकों के लिए डिज़ाइन की गई है। भारी काम हम करते हैं।",
  "home.howItWorks.cta": "अपनी यात्रा शुरू करें",

  "home.howItWorks.step1.title": "ऑनबोर्ड",
  "home.howItWorks.step1.desc":
    "एक डेमो बुक करें, अपने क्लब का विवरण साझा करें, और हम आपका KHARAGOLF वातावरण कॉन्फ़िगर करते हैं — कोर्स, टी बॉक्स, सदस्य भूमिकाएँ और हैंडिकैप सेटिंग्स।",
  "home.howItWorks.step2.title": "कॉन्फ़िगर करें",
  "home.howItWorks.step2.desc":
    "अपनी मौजूदा सदस्यता डेटा आयात करें, अपना पहला टूर्नामेंट बनाएँ, और प्लेटफ़ॉर्म को अपने क्लब की पहचान और कार्यप्रवाह के अनुरूप ढालें।",
  "home.howItWorks.step3.title": "लाइव हो जाएँ",
  "home.howItWorks.step3.desc":
    "अपना पहला लाइव इवेंट लॉन्च करें, दर्शकों के साथ सार्वजनिक स्कोरकार्ड लिंक साझा करें, और देखें कि आपके क्लब का संचालन रीयल-टाइम में कैसे बदलता है।",

  "home.modules.tournament.title": "टूर्नामेंट इंजन",
  "home.modules.tournament.desc":
    "किसी भी प्रारूप को बनाएँ और चलाएँ — स्ट्रोक प्ले, स्टेबलफ़ोर्ड, मैच प्ले, इक्लेक्टिक और 10+ अन्य — स्वचालित स्कोरिंग और फ़्लाइटिंग के साथ।",
  "home.modules.handicap.title": "हैंडिकैप और सदस्यता",
  "home.modules.handicap.desc":
    "WHS-अनुरूप हैंडिकैप प्रबंधन, सदस्य प्रोफ़ाइल, टी-टाइम बुकिंग और पूरे क्लब सदस्यता जीवन-चक्र के टूल।",
  "home.modules.leaderboards.title": "लाइव लीडरबोर्ड",
  "home.modules.leaderboards.desc":
    "स्ट्रोक्स गेन्ड एनालिटिक्स के साथ रीयल-टाइम स्कोरिंग, होल-दर-होल ट्रैकिंग और क्लबहाउस के लिए सार्वजनिक टीवी डिस्प्ले बोर्ड।",
  "home.modules.league.title": "लीग प्रबंधन",
  "home.modules.league.desc":
    "पूरे सीज़न के लीग कैलेंडर, फ़िक्स्चर निर्माण, स्टैंडिंग टेबल और स्वचालित राउंड-रिज़ल्ट प्रसंस्करण।",
  "home.modules.sponsorship.title": "स्पॉन्सरशिप हब",
  "home.modules.sponsorship.desc":
    "एक ही डैशबोर्ड से प्रायोजकों का प्रबंधन करें, ब्रांडिंग अधिकार सौंपें, चालान बनाएँ और ROI रिपोर्ट प्रदान करें।",
  "home.modules.comms.title": "संचार",
  "home.modules.comms.desc":
    "SMS और ईमेल अभियान, इवेंट घोषणाएँ, पुश सूचनाएँ और सदस्यों के लिए संपूर्ण डिजिटल नोटिसबोर्ड।",
  "home.modules.proshop.title": "प्रो शॉप और वेंडर",
  "home.modules.proshop.desc":
    "एकीकृत पॉइंट-ऑफ़-सेल, इन्वेंटरी प्रबंधन, कंसाइनमेंट, गिफ़्ट कार्ड और तृतीय-पक्ष विक्रेता समन्वय।",
  "home.modules.analytics.title": "एनालिटिक्स और वित्त",
  "home.modules.analytics.desc":
    "राजस्व डैशबोर्ड, सदस्यता बिलिंग, बकाया ट्रैकिंग, अकाउंटिंग एकीकरण और निर्यात योग्य वित्तीय रिपोर्ट।",

  "home.testimonials.title": "क्लब क्या कह रहे हैं।",
  "home.testimonials.readCaseStudy": "केस स्टडी पढ़ें",
  "home.testimonials.t1.quote":
    "KHARAGOLF ने हमारे क्लब चैंपियनशिप के संचालन का तरीका बदल दिया। लाइव लीडरबोर्ड पर सदस्य पूरे आयोजन के दौरान अपने फ़ोन से चिपके रहे। हम कभी पीछे नहीं लौटेंगे।",
  "home.testimonials.t1.author": "टूर्नामेंट निदेशक",
  "home.testimonials.t1.metric": "3.4× लाइव सहभागिता",
  "home.testimonials.t2.quote":
    "हैंडिकैप इंजन सबसे सटीक है जो हमने कभी इस्तेमाल किया है, और स्वचालित पेयरिंग प्रणाली ने हर राउंड में हमारी समिति के घंटों का मैन्युअल काम बचाया।",
  "home.testimonials.t2.author": "क्लब सचिव",
  "home.testimonials.t2.metric": "18 घंटे/इवेंट की बचत",
  "home.testimonials.t3.quote":
    "72-खिलाड़ियों का कॉर्पोरेट स्क्रैम्बल सेट करना पहले एक वीकेंड का प्रोजेक्ट हुआ करता था। KHARAGOLF के साथ, हमारे ऑपरेशंस मैनेजर ने इसे दो घंटे से भी कम में पूरा कर लिया।",
  "home.testimonials.t3.author": "गोल्फ ऑपरेशंस प्रबंधक",
  "home.testimonials.t3.metric": "सेटअप <2 घंटे में",

  "home.demo.title": "क्या आप अपने क्लब के संचालन को अगले स्तर पर ले जाने के लिए तैयार हैं?",
  "home.demo.subtitle":
    "KHARAGOLF का 30-मिनट का व्यक्तिगत डेमो बुक करें। हम आपको ठीक-ठीक दिखाएँगे कि हमारा प्लेटफ़ॉर्म आपके अगले बड़े टूर्नामेंट को कैसे सरल बना सकता है।",
  "home.demo.feature.schedule.title": "वॉकथ्रू शेड्यूल करें",
  "home.demo.feature.schedule.desc":
    "लाइव डेटा के साथ प्लेटफ़ॉर्म को क्रिया में देखें।",
  "home.demo.feature.migration.title": "कस्टम माइग्रेशन योजना",
  "home.demo.feature.migration.desc":
    "हम आपके मौजूदा सदस्यता डेटा का आयात संभालते हैं।",
  "home.demo.formHeading": "एक्सेस का अनुरोध करें",

  "demoBooking.calendarHeading": "30-मिनट का स्लॉट चुनें",
  "demoBooking.loadingSlots": "उपलब्ध समय लोड हो रहा है…",
  "demoBooking.noSlots":
    "कोई आगामी स्लॉट उपलब्ध नहीं — कृपया हमें ईमेल करें।",
  "demoBooking.detailsHeading": "आपकी जानकारी",
  "demoBooking.input.name": "पूरा नाम",
  "demoBooking.input.email": "कार्य ईमेल",
  "demoBooking.input.club": "क्लब / संगठन",
  "demoBooking.input.phone": "फ़ोन (वैकल्पिक)",
  "demoBooking.input.message": "क्या कुछ ख़ास है जो आप देखना चाहेंगे?",
  "demoBooking.interest.placeholder": "आपकी मुख्य रुचि क्या है?",
  "demoBooking.interest.empty": "मुख्य रुचि…",
  "demoBooking.interest.tournaments": "टूर्नामेंट प्रबंधन",
  "demoBooking.interest.handicaps": "हैंडिकैप प्रणाली",
  "demoBooking.interest.league": "लीग संचालन",
  "demoBooking.interest.full": "क्लब का संपूर्ण ऑपरेटिंग सिस्टम",
  "demoBooking.selected": "चयनित: {{when}}",
  "demoBooking.pickPrompt":
    "बुकिंग सक्षम करने के लिए बाईं ओर से एक स्लॉट चुनें।",
  "demoBooking.submitting": "बुक हो रहा है…",
  "demoBooking.submit": "डेमो की पुष्टि करें",
  "demoBooking.toast.pickTime.title": "एक समय चुनें",
  "demoBooking.toast.pickTime.desc":
    "ऊपर दिए गए कैलेंडर से एक स्लॉट चुनें।",
  "demoBooking.toast.addDetails.title": "अपनी जानकारी जोड़ें",
  "demoBooking.toast.addDetails.desc": "नाम और ईमेल आवश्यक हैं।",
  "demoBooking.toast.booked.title": "डेमो बुक हो गया",
  "demoBooking.toast.booked.desc":
    "कैलेंडर निमंत्रण के साथ पुष्टि ईमेल भेज दी गई है।",
  "demoBooking.toast.failed.title": "स्लॉट बुक नहीं हो सका",
  "demoBooking.toast.failed.desc":
    "कोई दूसरा समय चुनें या सीधे हमसे संपर्क करें।",
  "demoBooking.confirmed.heading": "आपकी बुकिंग हो गई।",
  "demoBooking.confirmed.note":
    "कैलेंडर निमंत्रण के साथ पुष्टि ईमेल {{email}} पर भेजी जा रही है।",

  "cookies.aria": "कुकी सहमति",
  "cookies.title": "हम आपकी निजता को महत्व देते हैं",
  "cookies.body":
    "हम इस साइट को चलाने के लिए केवल आवश्यक कुकीज़ का उपयोग करते हैं। आपकी सहमति से हम एनालिटिक्स और मार्केटिंग के लिए भी कुकीज़ का उपयोग करते हैं। आप अपनी पसंद कभी भी बदल सकते हैं। अधिक जानकारी हमारी {{link}} में पढ़ें।",
  "cookies.policyLink": "गोपनीयता नीति",
  "cookies.necessary": "आवश्यक (हमेशा चालू)",
  "cookies.analytics": "एनालिटिक्स — गुमनाम उपयोग आँकड़े",
  "cookies.marketing": "मार्केटिंग — व्यक्तिगत विज्ञापन और ऑफ़र",
  "cookies.button.customise": "अनुकूलित करें",
  "cookies.button.save": "विकल्प सहेजें",
  "cookies.button.reject": "वैकल्पिक अस्वीकार करें",
  "cookies.button.accept": "सभी स्वीकार करें",

  "footer.tagline":
    "उत्कृष्टता की मांग करने वाले क्लबों के लिए पेशेवर-स्तर का गोल्फ टूर्नामेंट ऑपरेटिंग सिस्टम।",
  "footer.col.platform": "प्लेटफ़ॉर्म",
  "footer.col.company": "कंपनी",
  "footer.link.formats": "फ़ॉर्मेट",
  "footer.link.privacy": "गोपनीयता नीति",
  "footer.link.terms": "सेवा की शर्तें",
  "footer.link.support": "सहायता",
  "footer.copyright": "© {{year}} KHARAGOLF. सर्वाधिकार सुरक्षित।",

  "pricing.kicker": "मूल्य",
  "pricing.title": "पारदर्शी। अनुमान योग्य। स्केल के लिए बनी।",
  "pricing.subtitle":
    "हर क्लब के लिए एक फ़्लैट शुल्क। प्रति-सदस्य कोई अधिभार नहीं, इवेंट-डे की कोई फीस नहीं, टूर्नामेंट के वायरल होने पर कोई चौंकाने वाला बिल नहीं।",
  "pricing.billing.monthly": "मासिक",
  "pricing.billing.annual": "वार्षिक",
  "pricing.billing.annualSave": "16% बचाएँ",
  "pricing.plan.mostPopular": "सबसे लोकप्रिय",
  "pricing.plan.free": "मुफ़्त",
  "pricing.plan.suffix.monthly": "/माह",
  "pricing.plan.suffix.annual": "/वर्ष",
  "pricing.plan.members": "सदस्य",
  "pricing.plan.unlimited": "असीमित",
  "pricing.plan.activeEvents": "सक्रिय इवेंट",
  "pricing.plan.cta.enterprise": "सेल्स से बात करें",
  "pricing.plan.cta.default": "शुरू करें",
  "pricing.compare.title": "हर सुविधा की तुलना करें।",
  "pricing.faq.kicker": "मूल्य FAQ",
  "pricing.faq.title": "सवाल, जवाब।",
  "pricing.demo.title": "अपने क्लब के लिए KHARAGOLF देखें।",
  "pricing.demo.subtitle":
    "30 मिनट का स्लॉट चुनें और हम आपके सटीक उपयोग को लाइव दिखाएँगे।",

  "capability.kicker": "प्लेटफ़ॉर्म क्षमता रिपोर्ट",
  "capability.print": "प्रिंट करें / PDF के रूप में सहेजें",

  // Capability Report — long-form brochure body (Hindi).
  "capability.subtitle": "द डेफिनिटिव टूर्नामेंट प्रबंधन प्लेटफ़ॉर्म",
  "capability.quote": "महारत के लिए चाहिए सटीकता।",
  "capability.intro.p1":
    "KHARAGOLF एक एंटरप्राइज़-ग्रेड गोल्फ क्लब प्रबंधन प्लेटफ़ॉर्म है, जो प्रतिष्ठित क्लबों, राष्ट्रीय फेडरेशनों और पेशेवर टूर्नामेंट डायरेक्टरों के लिए विशेष रूप से बनाया गया है। यह क्लब जीवन के हर पहलू को एक ही, ख़ूबसूरती से डिज़ाइन किए सिस्टम में जोड़ता है — WHS-अनुरूप हैंडीकैप प्रबंधन और लाइव टूर्नामेंट स्कोरिंग से लेकर टी-टाइम बुकिंग, प्रो शॉप POS और ऑन-कोर्स F&B ऑर्डरिंग तक — 6 वैश्विक क्षेत्रों की 21 भाषाओं में उपलब्ध।",
  "capability.intro.p2":
    "प्लेटफ़ॉर्म एक साथ तीन ऑडियंस को सेवा देता है: {{admin}}, {{players}} और {{sponsors}} — वेब, iOS, Android, Apple Watch, Wear OS और Garmin पर।",
  "capability.intro.audience.admin": "क्लब प्रशासक",
  "capability.intro.audience.player": "खिलाड़ी",
  "capability.intro.audience.sponsor": "प्रायोजक",
  "capability.sec.channels.title": "प्लेटफ़ॉर्म चैनल",
  "capability.sec.channels.i1": "एंटरप्राइज़ वेब ऐप — पूर्ण एडमिन कमांड सेंटर: टूर्नामेंट, सदस्य, वित्त, संचालन",
  "capability.sec.channels.i2": "iOS ऐप (नेटिव) — खिलाड़ी पोर्टल: स्कोरिंग, बुकिंग, एनालिटिक्स, शॉप (App Store)",
  "capability.sec.channels.i3": "Android ऐप (नेटिव) — पूर्ण iOS समानता (Google Play)",
  "capability.sec.channels.i4": "Apple Watch — कलाई पर स्कोरिंग, GPS दूरी, complications",
  "capability.sec.channels.i5": "Wear OS — स्कोरकार्ड tiles, स्कोर बनाम पार झलक, टी-टाइम अलर्ट",
  "capability.sec.channels.i6": "Garmin Connect IQ — Garmin डिवाइसों पर स्कोर, GPS यार्डेज और हैंडीकैप इंडेक्स",
  "capability.sec.channels.i7": "KHARAGOLF.com — मार्केटिंग, क्लब डायरेक्टरी, डेमो अनुरोध, मूल्य",
  "capability.sec.channels.i8": "API / KHARAGOLF Cloud — सभी सतहों को चलाने वाला एकीकृत डेटा इंजन",
  "capability.sec.tournament.title": "टूर्नामेंट और प्रतियोगिता इंजन",
  "capability.sec.tournament.i1": "Stroke Play (Gross & Net), Stableford, Max Score, Par",
  "capability.sec.tournament.i2": "Match Play — Ryder Cup, Foursomes, Greensomes, Scramble, Best Ball, Shamble",
  "capability.sec.tournament.i3": "कट लाइन के साथ बहु-राउंड इवेंट",
  "capability.sec.tournament.i4": "बहु-कोर्स चैंपियनशिप और इंटरक्लब फिक्स्चर",
  "capability.sec.tournament.i5": "Shotgun, split tee और एक साथ शुरुआत",
  "capability.sec.tournament.i6": "स्वचालित WHS Playing Handicap गणना",
  "capability.sec.tournament.i7": "साइड गेम — Skins, CTP, Longest Drive, Birdies pool",
  "capability.sec.tournament.i8": "लाइव लीडरबोर्ड — रीयल-टाइम, kiosk मोड, TV डिस्प्ले बोर्ड",
  "capability.sec.tournament.i9": "सार्वजनिक परिणाम पृष्ठ (शेयर करने योग्य, बिना लॉगिन)",
  "capability.sec.tournament.i10": "पेशेवर 4-पैनल पॉकेट स्कोरकार्ड (PDF + QR)",
  "capability.sec.tournament.i11": "ड्रॉ बिल्डर — ऑटो पेयरिंग, drag-and-drop, मैनुअल लॉक",
  "capability.sec.tournament.i12": "फ्लाइट प्रबंधन — थोक असाइन, drag-and-drop",
  "capability.sec.tournament.i13": "पुरस्कार भुगतान कैलकुलेटर और स्वचालित आवंटन",
  "capability.sec.tournament.i14": "स्वचालित प्रोमोशन के साथ वेटलिस्ट प्रबंधन",
  "capability.sec.tournament.i15": "टूर्नामेंट टेम्पलेट — फ़ॉर्मेट सहेजें और पुनः उपयोग करें",
  "capability.sec.tournament.i16": "कॉर्पोरेट और चैरिटी इवेंट प्रबंधन",
  "capability.sec.tournament.i17": "Eclectic स्कोरिंग और Order of Merit",
  "capability.sec.tournament.i18": "हैंडीकैप सिमुलेटर और what-if मॉडलिंग",
  "capability.sec.tournament.i19": "टीम प्रतियोगिताएँ — टीम, रोस्टर और टीम हैंडीकैप एकत्रीकरण",
  "capability.sec.tournament.i20": "टीम ड्रॉ, टीम लीडरबोर्ड और टीम स्कोरिंग",
  "capability.sec.tournament.i21": "थोक टीम पंजीकरण और टीम-आधारित प्रविष्टि प्रबंधन",
  "capability.sec.league.title": "लीग प्रबंधन",
  "capability.sec.league.i1": "Stroke, Stableford, Match Play और Round Robin फ़ॉर्मेट",
  "capability.sec.league.i2": "टीम लीग — टीम, रोस्टर और टीम-आधारित स्टैंडिंग्स",
  "capability.sec.league.i3": "मौसमी स्टैंडिंग्स और संचयी स्कोरकार्ड",
  "capability.sec.league.i4": "PDF स्कोरकार्ड प्रिंटिंग और निर्यात",
  "capability.sec.league.i5": "हर राउंड के बाद सभी सदस्यों को परिणाम सूचनाएँ",
  "capability.sec.whs.title": "World Handicap System (WHS 2024/2026)",
  "capability.sec.whs.i1": "WHS Rules of Handicapping का पूर्ण अनुपालन",
  "capability.sec.whs.i2": "Score differential — 18-होल, 9-होल और आंशिक राउंड का प्रोरेटिंग",
  "capability.sec.whs.i3": "ESR, Soft Cap, Hard Cap लागू",
  "capability.sec.whs.i4": "अंतिम 20 में से सर्वश्रेष्ठ 8 differentials का तर्क",
  "capability.sec.whs.i5": "GHIN / IGU में स्वचालित स्कोर पोस्टिंग",
  "capability.sec.whs.i6": "हैंडीकैप समिति शासन और सिमुलेटर",
  "capability.sec.scoring.title": "लाइव स्कोरिंग — सभी चैनल",
  "capability.sec.scoring.i1": "वेब स्कोरर कंसोल — बड़े फ़ील्ड के लिए बल्क ग्रिड एंट्री",
  "capability.sec.scoring.i2": "मोबाइल स्कोरर स्टेशन — समूह-केंद्रित प्रवाह",
  "capability.sec.scoring.i3": "Marker पुष्टि के साथ खिलाड़ी सेल्फ-स्कोरिंग (WHS-अनुरूप)",
  "capability.sec.scoring.i4": "Apple Watch और Wear OS पर स्वतंत्र कलाई स्कोरिंग",
  "capability.sec.scoring.i5": "स्वचालित बैकग्राउंड सिंक के साथ ऑफ़लाइन स्कोरिंग",
  "capability.sec.gps.title": "GPS और शॉट ट्रैकिंग",
  "capability.sec.gps.i1": "ग्रीन के front / centre / back तक लाइव दूरी",
  "capability.sec.gps.i2": "शॉट-दर-शॉट GPS ट्रैकिंग (Tee → Fairway → Approach → Putt)",
  "capability.sec.gps.i3": "उपग्रह इमेजरी से 3D होल flyover",
  "capability.sec.gps.i4": "Garmin, Apple Watch और Fitbit के साथ सिंक",
  "capability.sec.analytics.title": "खिलाड़ी एनालिटिक्स और प्रदर्शन",
  "capability.sec.analytics.i1": "Strokes Gained — OTT, Approach, ATG, Putting (PGA Tour बेसलाइन)",
  "capability.sec.analytics.i2": "Fairways hit, GIR, putts, स्कोरिंग औसत ट्रेंड चार्ट",
  "capability.sec.analytics.i3": "क्लब दूरी प्रोफाइलिंग",
  "capability.sec.analytics.i4": "अभ्यास सत्र ट्रैकर",
  "capability.sec.analytics.i5": "इंटरैक्टिव राउंड रीप्ले मानचित्र",
  "capability.sec.analytics.i6": "शेयर करने योग्य राउंड सारांश कार्ड",
  "capability.sec.analytics.i7": "राष्ट्रीय और क्षेत्रीय रैंकिंग एकीकरण",
  "capability.sec.analytics.i8": "50+ उपलब्धि बैज और गैमिफिकेशन माइलस्टोन",
  "capability.sec.achievements.title": "उपलब्धियाँ और गैमिफिकेशन",
  "capability.sec.achievements.i1": "50+ अनलॉक करने योग्य उपलब्धि बैज",
  "capability.sec.achievements.i2": "माइलस्टोन — पहला birdie, eagle, hole-in-one, sub-par राउंड",
  "capability.sec.achievements.i3": "मौसमी चुनौतियाँ और क्लब-व्यापी लीडरबोर्ड माइलस्टोन",
  "capability.sec.achievements.i4": "क्लब फ़ीड पर उपलब्धियों की सोशल शेयरिंग",
  "capability.sec.achievements.i5": "वर्षगांठ और लॉयल्टी पहचान बैज",
  "capability.sec.achievements.i6": "एडमिन-निर्मित कस्टम क्लब उपलब्धि श्रेणियाँ",
  "capability.sec.membership.title": "सदस्यता और क्लब प्रशासन",
  "capability.sec.membership.i1": "पूर्ण सदस्य जीवनचक्र — ऑनबोर्डिंग, वर्गीकरण, नवीनीकरण",
  "capability.sec.membership.i2": "भूमिका-आधारित एक्सेस — Super Admin / Club Admin / Scorer / Member",
  "capability.sec.membership.i3": "स्वचालित आवर्ती शुल्क बिलिंग",
  "capability.sec.membership.i4": "QR कोड के साथ डिजिटल सदस्यता कार्ड",
  "capability.sec.membership.i5": "हैंडीकैप समिति उपकरण और शासन",
  "capability.sec.membership.i6": "क्लब शासन हब — दस्तावेज़, बोर्ड कार्यवृत्त, सदस्य मतदान",
  "capability.sec.payments.title": "भुगतान और वित्त",
  "capability.sec.payments.i1": "Razorpay — एंट्री शुल्क, फ़ीस, शॉप (बहु-मुद्रा)",
  "capability.sec.payments.i2": "COD समर्थन और GST-अनुरूप टैक्स इनवॉइस",
  "capability.sec.payments.i3": "इवेंट / श्रेणी / अवधि के अनुसार वित्तीय रिपोर्टिंग डैशबोर्ड",
  "capability.sec.payments.i4": "रिफंड वर्कफ़्लो और भुगतान रिमाइंडर",
  "capability.sec.payments.i5": "Razorpay Payment Links",
  "capability.sec.payments.i6": "प्रायोजक भुगतान और अनुबंध ट्रैकिंग",
  "capability.sec.communications.title": "संचार और सूचनाएँ",
  "capability.sec.communications.i1": "ईमेल डिलीवरी (SMTP)",
  "capability.sec.communications.i2": "पुश सूचनाएँ — iOS और Android",
  "capability.sec.communications.i3": "SMS और WhatsApp ब्रॉडकास्ट",
  "capability.sec.communications.i4": "टूर्नामेंट / लीग के लिए इन-ऐप मैसेजिंग",
  "capability.sec.communications.i5": "स्वचालित संचार वर्कफ़्लो बिल्डर",
  "capability.sec.communications.i6": "क्लब-ब्रांडेड ईमेल टेम्पलेट और पोस्ट-इवेंट सारांश",
  "capability.sec.branding.title": "क्लब ब्रांडिंग, व्हाइट-लेबलिंग और प्रायोजन",
  "capability.sec.branding.i1": "प्रति क्लब कस्टम लोगो, रंग और डोमेन",
  "capability.sec.branding.i2": "ब्रांडेड स्कोरकार्ड, परिणाम PDF और ईमेल",
  "capability.sec.branding.i3": "लीडरबोर्ड, स्कोरकार्ड और परिणामों पर प्रायोजक लोगो",
  "capability.sec.branding.i4": "प्रायोजक CRM — अनुबंध, सौदा मूल्य, नवीनीकरण",
  "capability.sec.branding.i5": "प्रायोजक सेल्फ-सर्विस पोर्टल",
  "capability.sec.branding.i6": "स्वचालित ROI रिपोर्टिंग और एनालिटिक्स",
  "capability.sec.branding.i7": "CTP / Longest Drive होल प्रायोजन",
  "capability.sec.branding.i8": "कस्टम पंजीकरण फ़ॉर्म और पोस्ट-इवेंट सर्वेक्षण",
  "capability.sec.proshop.title": "Pro Shop, POS और ई-कॉमर्स",
  "capability.sec.proshop.i1": "बारकोड स्कैनिंग और बहु-स्थान इन्वेंटरी के साथ POS टर्मिनल",
  "capability.sec.proshop.i2": "आपूर्तिकर्ता खरीद आदेश और प्राप्ति",
  "capability.sec.proshop.i3": "रिटर्न, रिफंड और एक्सचेंज",
  "capability.sec.proshop.i4": "सदस्य मूल्य, प्रोमोशन और लॉयल्टी पुरस्कार",
  "capability.sec.proshop.i5": "गिफ्ट कार्ड और स्टोर क्रेडिट",
  "capability.sec.proshop.i6": "Dropshipping के साथ ऑनलाइन शॉप (Shiprocket + Printful)",
  "capability.sec.proshop.i7": "GST इनवॉइस और कॉमर्स एनालिटिक्स",
  "capability.sec.proshop.i8": "तृतीय-पक्ष विक्रेता / consignment ऑपरेटर समर्थन",
  "capability.sec.facilities.title": "सुविधाएँ और संचालन प्रबंधन",
  "capability.sec.facilities.i1": "गोल्फ कार्ट फ्लीट — GPS ट्रैकिंग, शेड्यूलिंग और रखरखाव लॉग",
  "capability.sec.facilities.i2": "Driving Range और Bay बुकिंग — समय स्लॉट और बिलिंग",
  "capability.sec.facilities.i3": "लॉकर रूम — असाइनमेंट, नवीनीकरण और वेटलिस्ट",
  "capability.sec.facilities.i4": "किराये के उपकरण — क्लब, ट्रॉली, GPS डिवाइस",
  "capability.sec.facilities.i5": "कोर्स की स्थिति रिपोर्ट (मोबाइल पर लाइव प्रकाशित)",
  "capability.sec.facilities.i6": "F&B ऑन-कोर्स ऑर्डरिंग — किसी भी होल से, ऑर्डर पर या टैब पर भुगतान",
  "capability.sec.facilities.i7": "क्लास और कोचिंग बुकिंग — प्रो कैलेंडर, छात्र इतिहास",
  "capability.sec.facilities.i8": "जूनियर गोल्फ कार्यक्रम — नामांकन, प्रगति और अभिभावक सूचनाएँ",
  "capability.sec.teetime.title": "टी-टाइम बुकिंग",
  "capability.sec.teetime.i1": "सदस्य और सार्वजनिक बुकिंग पोर्टल",
  "capability.sec.teetime.i2": "नियम-आधारित स्लॉट इंजन — सामान्य, split tee और shotgun",
  "capability.sec.teetime.i3": "रखरखाव ब्लॉक और इवेंट आरक्षण",
  "capability.sec.teetime.i4": "बुकिंग प्रबंधन और रद्दीकरण वर्कफ़्लो",
  "capability.sec.social.title": "सोशल और समुदाय",
  "capability.sec.social.i1": "क्लब सोशल वॉल और गतिविधि फ़ीड",
  "capability.sec.social.i2": "टूर्नामेंट और लीग के लिए मीडिया गैलरियाँ (फ़ोटो और वीडियो)",
  "capability.sec.social.i3": "रीयल-टाइम टूर्नामेंट चैट रूम",
  "capability.sec.social.i4": "Fantasy Golf League",
  "capability.sec.social.i5": "गोल्फ ट्रिप और away day प्लानर",
  "capability.sec.social.i6": "Pace of play ट्रैकर",
  "capability.sec.saas.title": "मल्टी-क्लब SaaS प्लेटफ़ॉर्म",
  "capability.sec.saas.i1": "सब्सक्रिप्शन बिलिंग के साथ सेल्फ-सर्विस क्लब ऑनबोर्डिंग",
  "capability.sec.saas.i2": "प्लेटफ़ॉर्म-व्यापी निगरानी के लिए Super-Admin डैशबोर्ड",
  "capability.sec.saas.i3": "प्रति-क्लब डेटा अलगाव और एक्सेस नियंत्रण",
  "capability.sec.saas.i4": "KHARAGOLF.com पर सार्वजनिक क्लब डायरेक्टरी",
  "capability.sec.integrations.title": "एकीकरण और API",
  "capability.sec.integrations.i1": "GHIN खिलाड़ी और कोर्स डेटा लुकअप",
  "capability.sec.integrations.i2": "Razorpay, Shiprocket, Printful",
  "capability.sec.integrations.i3": "OpenWeatherMap — टूर्नामेंट के दिन मौसम विजेट",
  "capability.sec.integrations.i4": "बाहरी सिस्टम एकीकरण के लिए आउटबाउंड webhook API",
  "capability.sec.integrations.i5": "कस्टम रिपोर्ट बिल्डर — CSV और PDF निर्यात",
  "capability.sec.integrations.i6": "कैलेंडर निर्यात (iCal / Google Calendar)",
  "capability.sec.lang.title": "बहु-भाषा समर्थन",
  "capability.sec.lang.i1": "6 वैश्विक क्षेत्रों में 21 भाषाएँ — अरबी के लिए पूर्ण RTL समर्थन",
  "capability.sec.lang.i2": "🌍 ग्लोबल कोर: अंग्रेज़ी, स्पेनिश, फ़्रेंच, जर्मन, पुर्तगाली",
  "capability.sec.lang.i3": "🇮🇳 दक्षिण एशिया: हिंदी",
  "capability.sec.lang.i4": "🇸🇦 मध्य पूर्व: अरबी (RTL — वेब और मोबाइल पर दाएँ-से-बाएँ लेआउट)",
  "capability.sec.lang.i5": "🌏 पूर्वी एशिया: जापानी, कोरियाई, चीनी (सरलीकृत)",
  "capability.sec.lang.i6":
    "🌏 दक्षिण-पूर्व एशिया: थाई, Bahasa Melayu, Bahasa Indonesia, Tiếng Việt, फ़िलिपिनो",
  "capability.sec.lang.i7": "🌍 अफ़्रीका: स्वाहिली, अफ़्रीकांस, अम्हारिक, हौसा, isiZulu, यॉरूबा",
  "capability.sec.lang.i8": "सभी UI स्ट्रिंग्स अनुवादित — बटन, लेबल, त्रुटियाँ, नेविगेशन, सूचनाएँ",
  "capability.sec.lang.i9": "प्रति उपयोगकर्ता भाषा वरीयता संग्रहित और लॉगिन पर स्वचालित रूप से लागू",
  "capability.sec.lang.i10": "खिलाड़ी प्रोफ़ाइल सेटिंग्स से भाषा बदलते हैं (वेब और मोबाइल)",
  "capability.sec.lang.i11": "क्लब एडमिन अपने क्लब के लिए डिफ़ॉल्ट भाषा सेट करते हैं",
  "capability.sec.lang.i12": "सार्वजनिक पंजीकरण पृष्ठ क्लब की डिफ़ॉल्ट भाषा का सम्मान करता है",
  "capability.sec.lang.i13": "तिथि, संख्या और मुद्रा प्रारूप स्थानीय परंपराओं का पालन करते हैं",
  "capability.sec.apps.title": "नेटिव iOS, Android और वियरेबल ऐप्स",
  "capability.sec.apps.ios.heading": "iOS — App Store के लिए तैयार (Swift / SwiftUI)",
  "capability.sec.apps.ios.i1": "पूर्ण फीचर समानता — स्कोरिंग, लीडरबोर्ड, हैंडीकैप, टी-टाइम, शॉप",
  "capability.sec.apps.ios.i2": "बायोमेट्रिक प्रमाणीकरण (Face ID / Touch ID)",
  "capability.sec.apps.ios.i3": "APNs पुश सूचनाएँ",
  "capability.sec.apps.ios.i4": "बैकग्राउंड GPS ट्रैकिंग और नेटिव हैप्टिक फ़ीडबैक",
  "capability.sec.apps.android.heading": "Android — Google Play के लिए तैयार (Kotlin / Jetpack Compose)",
  "capability.sec.apps.android.i1": "पूर्ण फीचर समानता, ब्रांड के अनुरूप Material You डिज़ाइन",
  "capability.sec.apps.android.i2": "फ़िंगरप्रिंट / बायोमेट्रिक प्रमाणीकरण",
  "capability.sec.apps.android.i3": "FCM पुश सूचनाएँ",
  "capability.sec.apps.android.i4": "बैकग्राउंड GPS ट्रैकिंग",
  "capability.sec.apps.watchos.heading": "Apple Watch (watchOS)",
  "capability.sec.apps.watchos.i1": "वर्तमान राउंड स्कोर और अगले होल पार दिखाता complication",
  "capability.sec.apps.watchos.i2": "डिजिटल क्राउन से होल-दर-होल स्कोर एंट्री",
  "capability.sec.apps.watchos.i3": "पिन तक लाइव दूरी प्रदर्शन",
  "capability.sec.apps.watchos.i4": "राउंड टाइमर — WatchConnectivity के माध्यम से iPhone के साथ सिंक",
  "capability.sec.apps.wearos.heading": "Wear OS",
  "capability.sec.apps.wearos.i1": "स्कोरकार्ड एंट्री tiles",
  "capability.sec.apps.wearos.i2": "वर्तमान स्कोर बनाम पार दिखाने वाला Glance",
  "capability.sec.apps.wearos.i3": "टी-टाइम रिमाइंडर सूचनाएँ",
  "capability.sec.apps.wearos.i4": "Data Layer API के माध्यम से Android फ़ोन के साथ सिंक",
  "capability.sec.apps.garmin.heading": "Garmin Connect IQ",
  "capability.sec.apps.garmin.i1": "कस्टम डेटा फ़ील्ड और विजेट — होल स्कोर, पिन तक दूरी (GPS), हैंडीकैप इंडेक्स",
  "capability.sec.apps.garmin.i2": "सभी संगत Garmin डिवाइसों पर साइड-लोड करने योग्य",
  "capability.footer.subtitle": "द डेफिनिटिव टूर्नामेंट प्रबंधन प्लेटफ़ॉर्म",
  "capability.footer.confidential": "गोपनीय — संभावित भागीदारों और क्लबों के लिए तैयार · अप्रैल 2026",

  "notFound.title": "404 पेज नहीं मिला",
  "notFound.body": "क्या आप पेज को राउटर में जोड़ना भूल गए?",

  "seo.home.title": "KHARAGOLF — गोल्फ क्लबों के लिए टूर्नामेंट और क्लब ऑपरेटिंग सिस्टम",
  "seo.home.description":
    "KHARAGOLF गोल्फ क्लबों के लिए आधुनिक ऑपरेटिंग सिस्टम है: लाइव टूर्नामेंट प्रबंधन, WHS-अनुरूप हैंडीकैप, मेंबर पोर्टल, मार्केटिंग टूल और मापने योग्य ROI।",
  "seo.pricing.title": "KHARAGOLF मूल्य निर्धारण — टूर्नामेंट और क्लब ऑपरेशन प्लेटफ़ॉर्म",
  "seo.pricing.description":
    "KHARAGOLF का पारदर्शी मूल्य निर्धारण — पूरे भारत के गोल्फ क्लबों का भरोसेमंद टूर्नामेंट और क्लब ऑपरेटिंग सिस्टम। मुफ़्त Starter से लेकर Enterprise तक।",
};

/** Arabic — full coverage. RTL. */
const ar: SiteStrings = {
  "nav.home": "الرئيسية",
  "nav.forClubs": "للنوادي",
  "nav.forGolfers": "للاعبي الغولف",
  "nav.features": "الميزات",
  "nav.pricing": "الأسعار",
  "nav.contact": "تواصل معنا",
  "nav.bookDemo": "احجز عرضًا توضيحيًا",

  "lang.label": "اللغة",
  "lang.switchTo": "تغيير اللغة",

  "home.hero.kicker": "المعيار الجديد",
  "home.hero.titleLine1": "الإتقان يتطلب",
  "home.hero.titleLine2": "دقة.",
  "home.hero.subtitle":
    "KHARAGOLF هي المنصة الحاسمة لإدارة البطولات للنوادي التي تأخذ لعبتها على محمل الجد. مبنية لعصر حديث، وأصولها في التراث.",
  "home.hero.ctaPrimary": "اطلب الوصول",
  "home.hero.ctaSecondary": "استكشف المنصة",

  "home.partners.kicker": "نوادٍ في جميع أنحاء البلاد تثق بنا",

  "home.platform.features.engine.title": "محرك موثوق",
  "home.platform.features.engine.desc":
    "بنية تحتية بمستوى المصارف تضمن لوحات صدارة سريعة جدًا ولا تتعطل، حتى مع أكثر من 500 مسجِّل مباشر.",
  "home.platform.features.analytics.title": "تحليلات مباشرة",
  "home.platform.features.analytics.desc":
    "ضربات مكتسبة في الوقت الفعلي، إحصائيات حفرة بحفرة، ولوحات صدارة مقسّمة إلى مجموعات تتحدّث فورًا على جميع الشاشات.",
  "home.platform.features.ecosystem.title": "منظومة موحَّدة",
  "home.platform.features.ecosystem.desc":
    "من شاشة النادي إلى هاتف اللاعب، تجربة واحدة سلسة ترفع من هيبة فعالياتك.",

  "home.forClubs.kicker": "للنوادي",
  "home.forClubs.title": "نظام تشغيل متكامل لناديك.",
  "home.forClubs.subtitle":
    "كل وحدة يحتاجها ناديك — مدمجة بالكامل، بتصميم أنيق، ومبنية للطريقة التي تُدار بها رياضة الغولف فعلًا.",

  "home.howItWorks.title": "جاهز خلال أيام، لا أشهر.",
  "home.howItWorks.subtitle":
    "صُممت عملية تأهيلنا لمسؤولي النوادي المشغولين. نحن نتولى العمل الثقيل.",
  "home.howItWorks.cta": "ابدأ رحلتك",

  "home.howItWorks.step1.title": "التأهيل",
  "home.howItWorks.step1.desc":
    "احجز عرضًا توضيحيًا، شارك تفاصيل ناديك، وسنقوم بإعداد بيئة KHARAGOLF الخاصة بك — الملاعب، صناديق الانطلاق، أدوار الأعضاء، وإعدادات الهانديكاب.",
  "home.howItWorks.step2.title": "الإعداد",
  "home.howItWorks.step2.desc":
    "استورد بيانات أعضائك الحاليين، أنشئ بطولتك الأولى، وخصّص المنصة لتتطابق مع هوية ناديك وسير عمله.",
  "home.howItWorks.step3.title": "الإطلاق المباشر",
  "home.howItWorks.step3.desc":
    "أطلق فعاليتك الأولى مباشرةً، وشارك روابط بطاقات النتائج العامة مع المتفرجين، وراقب كيف تتحوّل عمليات ناديك في الوقت الفعلي.",

  "home.modules.tournament.title": "محرّك البطولات",
  "home.modules.tournament.desc":
    "أنشئ ونفّذ أي صيغة — Strokeplay وStableford وMatch Play وEclectic وأكثر من 10 صيغ أخرى — مع تسجيل وتقسيم تلقائيين.",
  "home.modules.handicap.title": "الهانديكاب والعضوية",
  "home.modules.handicap.desc":
    "إدارة هانديكاب متوافقة مع WHS، وملفات الأعضاء، وحجوزات أوقات الانطلاق، وأدوات كاملة لدورة حياة العضوية.",
  "home.modules.leaderboards.title": "لوحات صدارة مباشرة",
  "home.modules.leaderboards.desc":
    "تسجيل في الوقت الفعلي مع تحليلات strokes gained، ومتابعة حفرة بحفرة، ولوحات عرض تلفزيونية عامة لمبنى النادي.",
  "home.modules.league.title": "إدارة الدوريات",
  "home.modules.league.desc":
    "تقاويم دوري لموسم كامل، وتوليد المباريات، وجداول الترتيب، ومعالجة تلقائية لنتائج الجولات.",
  "home.modules.sponsorship.title": "مركز الرعاية",
  "home.modules.sponsorship.desc":
    "إدارة الرعاة، وتعيين حقوق العلامة التجارية، وإصدار الفواتير، وتسليم تقارير العائد على الاستثمار — كل ذلك من لوحة واحدة.",
  "home.modules.comms.title": "الاتصالات",
  "home.modules.comms.desc":
    "حملات الرسائل النصية والبريد الإلكتروني، وإعلانات الفعاليات، والإشعارات الفورية، ولوحة إعلانات رقمية كاملة للأعضاء.",
  "home.modules.proshop.title": "المتجر والموردون",
  "home.modules.proshop.desc":
    "نقطة بيع متكاملة، وإدارة المخزون، والبيع بالأمانة، وبطاقات الهدايا، والتنسيق مع الموردين الخارجيين.",
  "home.modules.analytics.title": "التحليلات والمالية",
  "home.modules.analytics.desc":
    "لوحات الإيرادات، وفوترة العضوية، وتتبع الاشتراكات، والتكامل المحاسبي، وتقارير مالية قابلة للتصدير.",

  "home.testimonials.title": "ماذا تقول النوادي.",
  "home.testimonials.readCaseStudy": "اقرأ دراسة الحالة",
  "home.testimonials.t1.quote":
    "غيّر KHARAGOLF طريقة إدارتنا لبطولة النادي. أبقت لوحة الصدارة المباشرة الأعضاء ملتصقين بهواتفهم طوال الفعالية. لن نعود أبدًا إلى الوراء.",
  "home.testimonials.t1.author": "مدير البطولات",
  "home.testimonials.t1.metric": "تفاعل مباشر أعلى ×3.4",
  "home.testimonials.t2.quote":
    "محرّك الهانديكاب هو الأكثر دقة من بين كل ما استخدمناه، ووفّر نظام التزويج التلقائي على لجنتنا ساعات من العمل اليدوي في كل جولة.",
  "home.testimonials.t2.author": "أمين النادي",
  "home.testimonials.t2.metric": "توفير 18 ساعة / فعالية",
  "home.testimonials.t3.quote":
    "كان إعداد سكرامبل شركات لـ 72 لاعبًا مشروع عطلة نهاية أسبوع. مع KHARAGOLF، أنجزه مدير العمليات لدينا في أقل من ساعتين.",
  "home.testimonials.t3.author": "مدير عمليات الغولف",
  "home.testimonials.t3.metric": "الإعداد في أقل من ساعتين",

  "home.demo.title": "هل أنت مستعد للارتقاء بعمليات ناديك؟",
  "home.demo.subtitle":
    "احجز عرضًا توضيحيًا مخصصًا لمدة 30 دقيقة من KHARAGOLF. سنريك بالضبط كيف يمكن لمنصتنا تبسيط بطولتك الكبرى القادمة.",
  "home.demo.feature.schedule.title": "حدّد موعد جولة تعريفية",
  "home.demo.feature.schedule.desc":
    "شاهد المنصة وهي تعمل ببيانات حقيقية.",
  "home.demo.feature.migration.title": "خطة ترحيل مخصّصة",
  "home.demo.feature.migration.desc":
    "نتولّى استيراد بيانات أعضائك الحاليين.",
  "home.demo.formHeading": "اطلب الوصول",

  "demoBooking.calendarHeading": "اختر فترة 30 دقيقة",
  "demoBooking.loadingSlots": "جارٍ تحميل الأوقات المتاحة…",
  "demoBooking.noSlots":
    "لا توجد فترات قادمة متاحة — يُرجى مراسلتنا عبر البريد الإلكتروني.",
  "demoBooking.detailsHeading": "بياناتك",
  "demoBooking.input.name": "الاسم الكامل",
  "demoBooking.input.email": "بريد العمل",
  "demoBooking.input.club": "النادي / المؤسسة",
  "demoBooking.input.phone": "الهاتف (اختياري)",
  "demoBooking.input.message": "هل ثمّة شيء محدّد تودّ أن تراه؟",
  "demoBooking.interest.placeholder": "ما اهتمامك الأساسي؟",
  "demoBooking.interest.empty": "الاهتمام الأساسي…",
  "demoBooking.interest.tournaments": "إدارة البطولات",
  "demoBooking.interest.handicaps": "نظام الهانديكاب",
  "demoBooking.interest.league": "عمليات الدوري",
  "demoBooking.interest.full": "نظام تشغيل النادي الكامل",
  "demoBooking.selected": "المحدّد: {{when}}",
  "demoBooking.pickPrompt":
    "اختر فترة على اليسار لتفعيل الحجز.",
  "demoBooking.submitting": "جارٍ الحجز…",
  "demoBooking.submit": "تأكيد العرض التوضيحي",
  "demoBooking.toast.pickTime.title": "اختر وقتًا",
  "demoBooking.toast.pickTime.desc":
    "اختر فترة من التقويم أعلاه.",
  "demoBooking.toast.addDetails.title": "أضف بياناتك",
  "demoBooking.toast.addDetails.desc":
    "الاسم والبريد الإلكتروني مطلوبان.",
  "demoBooking.toast.booked.title": "تم حجز العرض",
  "demoBooking.toast.booked.desc":
    "أُرسلت رسالة تأكيد بدعوة تقويم.",
  "demoBooking.toast.failed.title": "تعذّر حجز هذه الفترة",
  "demoBooking.toast.failed.desc":
    "جرّب وقتًا آخر أو تواصل معنا مباشرة.",
  "demoBooking.confirmed.heading": "تم حجزك.",
  "demoBooking.confirmed.note":
    "رسالة تأكيد بدعوة تقويم في طريقها إلى {{email}}.",

  "cookies.aria": "موافقة الكوكيز",
  "cookies.title": "نحن نقدّر خصوصيتك",
  "cookies.body":
    "نستخدم كوكيز ضرورية فقط لتشغيل هذا الموقع. وبموافقتك نستخدم أيضًا كوكيز للتحليلات والتسويق. يمكنك تغيير اختيارك في أي وقت. اقرأ المزيد في {{link}}.",
  "cookies.policyLink": "سياسة الخصوصية",
  "cookies.necessary": "ضرورية (مفعّلة دائمًا)",
  "cookies.analytics": "التحليلات — إحصائيات استخدام مجهولة الهوية",
  "cookies.marketing": "التسويق — إعلانات وعروض مخصّصة",
  "cookies.button.customise": "تخصيص",
  "cookies.button.save": "حفظ الاختيارات",
  "cookies.button.reject": "رفض الاختيارية",
  "cookies.button.accept": "قبول الكل",

  "footer.tagline":
    "نظام تشغيل بطولات الغولف بمستوى احترافي للنوادي التي تطلب التميّز.",
  "footer.col.platform": "المنصة",
  "footer.col.company": "الشركة",
  "footer.link.formats": "الصيغ",
  "footer.link.privacy": "سياسة الخصوصية",
  "footer.link.terms": "شروط الخدمة",
  "footer.link.support": "الدعم",
  "footer.copyright": "© {{year}} KHARAGOLF. جميع الحقوق محفوظة.",

  "pricing.kicker": "الأسعار",
  "pricing.title": "شفّاف. يمكن التنبؤ به. مبني للنمو.",
  "pricing.subtitle":
    "رسم ثابت لكل نادٍ. لا رسوم لكل عضو، ولا رسوم في يوم الفعالية، ولا فواتير مفاجئة عندما تنتشر بطولتك.",
  "pricing.billing.monthly": "شهريًا",
  "pricing.billing.annual": "سنويًا",
  "pricing.billing.annualSave": "وفّر 16%",
  "pricing.plan.mostPopular": "الأكثر شيوعًا",
  "pricing.plan.free": "مجاني",
  "pricing.plan.suffix.monthly": "/شهر",
  "pricing.plan.suffix.annual": "/سنة",
  "pricing.plan.members": "الأعضاء",
  "pricing.plan.unlimited": "غير محدود",
  "pricing.plan.activeEvents": "الفعاليات النشطة",
  "pricing.plan.cta.enterprise": "تحدّث مع المبيعات",
  "pricing.plan.cta.default": "ابدأ الآن",
  "pricing.compare.title": "قارن كل ميزة.",
  "pricing.faq.kicker": "الأسئلة الشائعة عن الأسعار",
  "pricing.faq.title": "أسئلة وإجابات.",
  "pricing.demo.title": "شاهد KHARAGOLF لناديك.",
  "pricing.demo.subtitle":
    "اختر فترة 30 دقيقة وسنعرض حالة استخدامك المحددة مباشرة.",

  "capability.kicker": "تقرير قدرات المنصة",
  "capability.print": "طباعة / حفظ كملف PDF",

  // Capability Report — long-form brochure body (Arabic).
  "capability.subtitle": "المنصة الحاسمة لإدارة بطولات الغولف",
  "capability.quote": "الإتقان يتطلب الدقة.",
  "capability.intro.p1":
    "KHARAGOLF منصة بمستوى المؤسسات لإدارة نوادي الغولف، مصممة خصيصًا للنوادي المرموقة والاتحادات الوطنية ومديري البطولات المحترفين. تجمع كل أبعاد حياة النادي — من إدارة الهانديكاب وفق WHS وتسجيل البطولات المباشر إلى حجز أوقات الانطلاق ونقاط البيع في المتجر وطلبات الطعام والشراب على الملعب — في نظام واحد بتصميم أنيق، متاح بـ 21 لغة عبر 6 مناطق عالمية.",
  "capability.intro.p2":
    "تخدم المنصة ثلاث فئات في وقت واحد: {{admin}}, {{players}} و{{sponsors}} — عبر الويب وiOS وAndroid وApple Watch وWear OS وGarmin.",
  "capability.intro.audience.admin": "إداريو النوادي",
  "capability.intro.audience.player": "اللاعبون",
  "capability.intro.audience.sponsor": "الرعاة",
  "capability.sec.channels.title": "قنوات المنصة",
  "capability.sec.channels.i1":
    "تطبيق ويب للمؤسسات — مركز قيادة الإدارة الكامل: البطولات والأعضاء والمالية والعمليات",
  "capability.sec.channels.i2": "تطبيق iOS أصلي — بوابة اللاعب: التسجيل والحجز والتحليلات والمتجر (App Store)",
  "capability.sec.channels.i3": "تطبيق Android أصلي — تطابق كامل مع iOS (Google Play)",
  "capability.sec.channels.i4": "Apple Watch — تسجيل من المعصم ومسافات GPS وcomplications",
  "capability.sec.channels.i5":
    "Wear OS — بطاقات بطاقات النتائج، نظرة سريعة على النتيجة مقابل البار، تنبيهات وقت الانطلاق",
  "capability.sec.channels.i6": "Garmin Connect IQ — النتيجة ومسافة GPS ومؤشر الهانديكاب على أجهزة Garmin",
  "capability.sec.channels.i7": "KHARAGOLF.com — التسويق ودليل النوادي وطلبات العروض والأسعار",
  "capability.sec.channels.i8": "API / KHARAGOLF Cloud — محرك بيانات موحَّد يشغّل جميع الواجهات",
  "capability.sec.tournament.title": "محرك البطولات والمنافسات",
  "capability.sec.tournament.i1": "Stroke Play (Gross و Net)، Stableford، Max Score، Par",
  "capability.sec.tournament.i2": "Match Play — Ryder Cup و Foursomes و Greensomes و Scramble و Best Ball و Shamble",
  "capability.sec.tournament.i3": "أحداث متعددة الجولات مع خطوط قطع",
  "capability.sec.tournament.i4": "بطولات متعددة الملاعب ومباريات بين النوادي",
  "capability.sec.tournament.i5": "انطلاقات shotgun و split tee ومتزامنة",
  "capability.sec.tournament.i6": "حساب آلي للـ Playing Handicap وفق WHS",
  "capability.sec.tournament.i7": "ألعاب جانبية — Skins و CTP و Longest Drive وbirdies pool",
  "capability.sec.tournament.i8": "لوحة صدارة مباشرة — في الوقت الفعلي، وضع kiosk، شاشة تلفاز",
  "capability.sec.tournament.i9": "صفحة نتائج عامة (قابلة للمشاركة، بدون تسجيل دخول)",
  "capability.sec.tournament.i10": "بطاقات جيب احترافية بأربع لوحات (PDF + QR)",
  "capability.sec.tournament.i11": "منشئ القرعة — اقتران تلقائي وسحب وإفلات وقفل يدوي",
  "capability.sec.tournament.i12": "إدارة الـ flights — تعيين بالجملة وسحب وإفلات",
  "capability.sec.tournament.i13": "حاسبة دفع الجوائز وتوزيع تلقائي",
  "capability.sec.tournament.i14": "إدارة قائمة الانتظار مع ترقية تلقائية",
  "capability.sec.tournament.i15": "قوالب البطولات — احفظ وأعد استخدام التنسيقات",
  "capability.sec.tournament.i16": "إدارة الفعاليات المؤسسية والخيرية",
  "capability.sec.tournament.i17": "تسجيل Eclectic و Order of Merit",
  "capability.sec.tournament.i18": "محاكي الهانديكاب ونمذجة what-if",
  "capability.sec.tournament.i19": "منافسات الفرق — فرق مسماة وقوائم وتجميع هانديكاب الفريق",
  "capability.sec.tournament.i20": "قرعات وفرق ولوحات صدارة وتسجيل للفرق",
  "capability.sec.tournament.i21": "تسجيل فرق بالجملة وإدارة الإدخالات على أساس الفريق",
  "capability.sec.league.title": "إدارة الدوريات",
  "capability.sec.league.i1": "صيغ Stroke و Stableford و Match Play و Round Robin",
  "capability.sec.league.i2": "دوريات الفرق — فرق مسماة وقوائم وترتيب على أساس الفرق",
  "capability.sec.league.i3": "ترتيب طوال الموسم وبطاقات نتائج تراكمية",
  "capability.sec.league.i4": "طباعة وتصدير بطاقات النتائج بصيغة PDF",
  "capability.sec.league.i5": "إشعارات نتائج بعد كل جولة لجميع الأعضاء",
  "capability.sec.whs.title": "نظام الهانديكاب العالمي (WHS 2024/2026)",
  "capability.sec.whs.i1": "التزام كامل بقواعد الهانديكاب الخاصة بـ WHS",
  "capability.sec.whs.i2": "Score differential — 18 حفرة و 9 حفر وتقسيم الجولات الجزئية",
  "capability.sec.whs.i3": "تطبيق ESR و Soft Cap و Hard Cap",
  "capability.sec.whs.i4": "منطق أفضل 8 differentials من آخر 20",
  "capability.sec.whs.i5": "ترحيل النتائج تلقائيًا إلى GHIN / IGU",
  "capability.sec.whs.i6": "حوكمة لجنة الهانديكاب ومحاكٍ",
  "capability.sec.scoring.title": "التسجيل المباشر — جميع القنوات",
  "capability.sec.scoring.i1": "وحدة تحكم المسجِّل عبر الويب — إدخال بالجملة في شبكة للحقول الكبيرة",
  "capability.sec.scoring.i2": "محطة المسجِّل عبر الجوال — تدفق متمحور حول المجموعة",
  "capability.sec.scoring.i3": "تسجيل ذاتي للاعب مع تأكيد marker (متوافق مع WHS)",
  "capability.sec.scoring.i4": "تسجيل مستقل من المعصم على Apple Watch و Wear OS",
  "capability.sec.scoring.i5": "تسجيل دون اتصال مع مزامنة تلقائية في الخلفية",
  "capability.sec.gps.title": "GPS وتتبع الضربات",
  "capability.sec.gps.i1": "مسافة مباشرة إلى مقدمة / وسط / مؤخرة الـ green",
  "capability.sec.gps.i2": "تتبع GPS ضربة بضربة (Tee → Fairway → Approach → Putt)",
  "capability.sec.gps.i3": "طيران ثلاثي الأبعاد فوق الحفرة بصور الأقمار الصناعية",
  "capability.sec.gps.i4": "مزامنة مع Garmin و Apple Watch و Fitbit",
  "capability.sec.analytics.title": "تحليلات وأداء اللاعب",
  "capability.sec.analytics.i1": "Strokes Gained — OTT و Approach و ATG و Putting (مرجعيات PGA Tour)",
  "capability.sec.analytics.i2": "Fairways و GIR و puts ورسوم بيانية لاتجاه متوسط النتيجة",
  "capability.sec.analytics.i3": "تحليل مسافات كل مضرب",
  "capability.sec.analytics.i4": "متعقّب جلسات التدريب",
  "capability.sec.analytics.i5": "خريطة تفاعلية لإعادة عرض الجولة",
  "capability.sec.analytics.i6": "بطاقة ملخص جولة قابلة للمشاركة",
  "capability.sec.analytics.i7": "تكامل مع التصنيفات الوطنية والإقليمية",
  "capability.sec.analytics.i8": "أكثر من 50 وسامًا للإنجازات ومحطات gamification",
  "capability.sec.achievements.title": "الإنجازات والـ Gamification",
  "capability.sec.achievements.i1": "أكثر من 50 وسام إنجاز قابل للفتح",
  "capability.sec.achievements.i2": "محطات — أول birdie و eagle و hole-in-one وجولة تحت البار",
  "capability.sec.achievements.i3": "تحديات موسمية ومحطات لوحة صدارة على مستوى النادي",
  "capability.sec.achievements.i4": "مشاركة الإنجازات على feed النادي",
  "capability.sec.achievements.i5": "أوسمة الذكرى السنوية والولاء",
  "capability.sec.achievements.i6": "فئات إنجازات نادٍ مخصصة من إنشاء الإدارة",
  "capability.sec.membership.title": "العضوية وإدارة النادي",
  "capability.sec.membership.i1": "دورة حياة كاملة للعضو — التسجيل والتصنيف والتجديد",
  "capability.sec.membership.i2": "وصول حسب الدور — Super Admin / Club Admin / Scorer / Member",
  "capability.sec.membership.i3": "فوترة دورية تلقائية للرسوم",
  "capability.sec.membership.i4": "بطاقة عضوية رقمية برمز QR",
  "capability.sec.membership.i5": "أدوات وحوكمة لجنة الهانديكاب",
  "capability.sec.membership.i6": "محور حوكمة النادي — وثائق ومحاضر مجلس وتصويت الأعضاء",
  "capability.sec.payments.title": "المدفوعات والمالية",
  "capability.sec.payments.i1": "Razorpay — رسوم الدخول والاشتراكات والمتجر (متعدد العملات)",
  "capability.sec.payments.i2": "دعم COD وفواتير ضريبية متوافقة مع GST",
  "capability.sec.payments.i3": "لوحة تقارير مالية حسب الفعالية / الفئة / الفترة",
  "capability.sec.payments.i4": "سير عمل الاسترجاع وتذكيرات الدفع",
  "capability.sec.payments.i5": "Razorpay Payment Links",
  "capability.sec.payments.i6": "تتبع مدفوعات وعقود الرعاة",
  "capability.sec.communications.title": "الاتصالات والإشعارات",
  "capability.sec.communications.i1": "إرسال البريد الإلكتروني (SMTP)",
  "capability.sec.communications.i2": "إشعارات push — iOS و Android",
  "capability.sec.communications.i3": "بث SMS و WhatsApp",
  "capability.sec.communications.i4": "مراسلة داخل التطبيق لكل بطولة / دوري",
  "capability.sec.communications.i5": "منشئ سير عمل اتصالات آلي",
  "capability.sec.communications.i6": "قوالب بريد إلكتروني بهوية النادي وملخصات بعد الفعالية",
  "capability.sec.branding.title": "هوية النادي والـ White-label والرعاية",
  "capability.sec.branding.i1": "شعار وألوان ودومين مخصص لكل نادٍ",
  "capability.sec.branding.i2": "بطاقات نتائج وPDF نتائج ورسائل بريد بهوية النادي",
  "capability.sec.branding.i3": "شعارات الرعاة على لوحات الصدارة وبطاقات النتائج وصفحات النتائج",
  "capability.sec.branding.i4": "CRM للرعاة — عقود وقيم صفقات وتجديدات",
  "capability.sec.branding.i5": "بوابة خدمة ذاتية للرعاة",
  "capability.sec.branding.i6": "تقارير وتحليلات ROI تلقائية",
  "capability.sec.branding.i7": "رعايات حفر CTP / Longest Drive",
  "capability.sec.branding.i8": "نماذج تسجيل واستبيانات بعد الفعالية مخصصة",
  "capability.sec.proshop.title": "المتجر ونقاط البيع والتجارة الإلكترونية",
  "capability.sec.proshop.i1": "محطة POS مع مسح الباركود ومخزون متعدد المواقع",
  "capability.sec.proshop.i2": "أوامر شراء واستلام من الموردين",
  "capability.sec.proshop.i3": "إرجاع واسترداد واستبدال",
  "capability.sec.proshop.i4": "تسعير للأعضاء وعروض ومكافآت ولاء",
  "capability.sec.proshop.i5": "بطاقات هدايا ورصيد متجر",
  "capability.sec.proshop.i6": "متجر إلكتروني مع dropshipping (Shiprocket + Printful)",
  "capability.sec.proshop.i7": "فواتير GST وتحليلات تجارية",
  "capability.sec.proshop.i8": "دعم البائعين الخارجيين / الـ consignment",
  "capability.sec.facilities.title": "إدارة المرافق والعمليات",
  "capability.sec.facilities.i1": "أسطول عربات الغولف — تتبع GPS وجدولة وسجلات صيانة",
  "capability.sec.facilities.i2": "حجز Driving Range و Bays — فترات وفوترة",
  "capability.sec.facilities.i3": "غرف الخزائن — تخصيص وتجديد وقائمة انتظار",
  "capability.sec.facilities.i4": "معدات للإيجار — مضارب وعربات وأجهزة GPS",
  "capability.sec.facilities.i5": "تقارير حالة الملعب (تُنشر مباشرةً على الجوال)",
  "capability.sec.facilities.i6": "طلب طعام وشراب على الملعب — من أي حفرة، الدفع عند الطلب أو على حساب",
  "capability.sec.facilities.i7": "حجز الدروس والتدريب — تقويم المحترف وسجل الطالب",
  "capability.sec.facilities.i8": "برامج Junior Golf — التسجيل والتقدم وإشعارات الوالدين",
  "capability.sec.teetime.title": "حجز أوقات الانطلاق",
  "capability.sec.teetime.i1": "بوابة حجز للأعضاء والعموم",
  "capability.sec.teetime.i2": "محرك فترات قائم على القواعد — عادي و split tee و shotgun",
  "capability.sec.teetime.i3": "حجوزات صيانة وحجوزات للفعاليات",
  "capability.sec.teetime.i4": "إدارة الحجز وسير عمل الإلغاء",
  "capability.sec.social.title": "السوشيال والمجتمع",
  "capability.sec.social.i1": "حائط النادي الاجتماعي وfeed الأنشطة",
  "capability.sec.social.i2": "معارض وسائط (صور وفيديو) لكل بطولة ودوري",
  "capability.sec.social.i3": "غرف دردشة مباشرة للبطولات",
  "capability.sec.social.i4": "Fantasy Golf League",
  "capability.sec.social.i5": "مخطط رحلات وأيام بعيدة عن النادي",
  "capability.sec.social.i6": "متعقّب pace of play",
  "capability.sec.saas.title": "منصة SaaS متعددة النوادي",
  "capability.sec.saas.i1": "تأهيل ذاتي للنادي مع فوترة بالاشتراك",
  "capability.sec.saas.i2": "لوحة Super-Admin للإشراف على المنصة بأكملها",
  "capability.sec.saas.i3": "عزل بيانات وضوابط وصول لكل نادٍ",
  "capability.sec.saas.i4": "دليل نوادٍ عام على KHARAGOLF.com",
  "capability.sec.integrations.title": "التكاملات وواجهة API",
  "capability.sec.integrations.i1": "بحث بيانات اللاعبين والملاعب في GHIN",
  "capability.sec.integrations.i2": "Razorpay و Shiprocket و Printful",
  "capability.sec.integrations.i3": "OpenWeatherMap — أداة طقس في يوم البطولة",
  "capability.sec.integrations.i4": "API webhook صادرة لتكامل الأنظمة الخارجية",
  "capability.sec.integrations.i5": "منشئ تقارير مخصصة — تصدير CSV و PDF",
  "capability.sec.integrations.i6": "تصدير التقويم (iCal / Google Calendar)",
  "capability.sec.lang.title": "دعم متعدد اللغات",
  "capability.sec.lang.i1": "21 لغة عبر 6 مناطق عالمية — مع دعم RTL كامل للعربية",
  "capability.sec.lang.i2": "🌍 النواة العالمية: الإنجليزية والإسبانية والفرنسية والألمانية والبرتغالية",
  "capability.sec.lang.i3": "🇮🇳 جنوب آسيا: الهندية",
  "capability.sec.lang.i4": "🇸🇦 الشرق الأوسط: العربية (RTL — تخطيط من اليمين إلى اليسار في الويب والجوال)",
  "capability.sec.lang.i5": "🌏 شرق آسيا: اليابانية والكورية والصينية (المبسطة)",
  "capability.sec.lang.i6":
    "🌏 جنوب شرق آسيا: التايلاندية و Bahasa Melayu و Bahasa Indonesia و Tiếng Việt والفلبينية",
  "capability.sec.lang.i7": "🌍 أفريقيا: السواحيلية والأفريقانية والأمهرية والهوسا و isiZulu واليوروبية",
  "capability.sec.lang.i8": "كل سلاسل الواجهة مترجمة — أزرار وعلامات وأخطاء وتنقل وإشعارات",
  "capability.sec.lang.i9": "تخزين تفضيل اللغة لكل مستخدم وتطبيقه تلقائيًا عند تسجيل الدخول",
  "capability.sec.lang.i10": "اللاعبون يغيّرون اللغة من إعدادات الملف الشخصي (ويب وجوال)",
  "capability.sec.lang.i11": "إداريو النوادي يضبطون لغة افتراضية لناديهم",
  "capability.sec.lang.i12": "صفحة التسجيل العامة تحترم اللغة الافتراضية للنادي",
  "capability.sec.lang.i13": "تنسيقات التاريخ والأرقام والعملة تتبع الأعراف المحلية",
  "capability.sec.apps.title": "تطبيقات أصلية لـ iOS و Android والأجهزة القابلة للارتداء",
  "capability.sec.apps.ios.heading": "iOS — جاهز لـ App Store (Swift / SwiftUI)",
  "capability.sec.apps.ios.i1": "تطابق وظائف كامل — التسجيل ولوحات الصدارة والهانديكاب وأوقات الانطلاق والمتجر",
  "capability.sec.apps.ios.i2": "مصادقة بيومترية (Face ID / Touch ID)",
  "capability.sec.apps.ios.i3": "إشعارات APNs",
  "capability.sec.apps.ios.i4": "تتبع GPS في الخلفية وردود haptic أصلية",
  "capability.sec.apps.android.heading": "Android — جاهز لـ Google Play (Kotlin / Jetpack Compose)",
  "capability.sec.apps.android.i1": "تطابق وظائف كامل بتصميم Material You متوافق مع الهوية",
  "capability.sec.apps.android.i2": "مصادقة بصمة / بيومترية",
  "capability.sec.apps.android.i3": "إشعارات FCM",
  "capability.sec.apps.android.i4": "تتبع GPS في الخلفية",
  "capability.sec.apps.watchos.heading": "Apple Watch (watchOS)",
  "capability.sec.apps.watchos.i1": "Complication يعرض نتيجة الجولة الحالية وبار الحفرة القادمة",
  "capability.sec.apps.watchos.i2": "إدخال نتيجة لكل حفرة باستخدام التاج الرقمي",
  "capability.sec.apps.watchos.i3": "عرض مباشر للمسافة إلى الراية",
  "capability.sec.apps.watchos.i4": "مؤقت الجولة — يتزامن مع iPhone عبر WatchConnectivity",
  "capability.sec.apps.wearos.heading": "Wear OS",
  "capability.sec.apps.wearos.i1": "بطاقات إدخال بطاقة النتائج",
  "capability.sec.apps.wearos.i2": "Glance يعرض النتيجة الحالية مقابل البار",
  "capability.sec.apps.wearos.i3": "إشعارات تذكير بأوقات الانطلاق",
  "capability.sec.apps.wearos.i4": "يتزامن مع هاتف Android عبر Data Layer API",
  "capability.sec.apps.garmin.heading": "Garmin Connect IQ",
  "capability.sec.apps.garmin.i1": "حقل بيانات وأداة مخصصة — نتيجة الحفرة، المسافة إلى الراية (GPS)، مؤشر الهانديكاب",
  "capability.sec.apps.garmin.i2": "قابل للتحميل الجانبي على جميع أجهزة Garmin المتوافقة",
  "capability.footer.subtitle": "المنصة الحاسمة لإدارة بطولات الغولف",
  "capability.footer.confidential": "سرّي — أُعدّ للشركاء والنوادي المحتملين · أبريل 2026",

  "notFound.title": "404 الصفحة غير موجودة",
  "notFound.body": "هل نسيت إضافة الصفحة إلى الموجِّه؟",

  "seo.home.title": "KHARAGOLF — نظام تشغيل البطولات والنوادي لنوادي الغولف",
  "seo.home.description":
    "KHARAGOLF هو نظام التشغيل الحديث لنوادي الغولف: إدارة بطولات مباشرة، هانديكاب متوافق مع WHS، بوابة أعضاء، أدوات تسويق وعائد استثمار قابل للقياس.",
  "seo.pricing.title": "أسعار KHARAGOLF — منصة بطولات وعمليات النوادي",
  "seo.pricing.description":
    "أسعار شفّافة لـ KHARAGOLF، نظام تشغيل البطولات والنوادي الذي تثق به نوادي الغولف في جميع أنحاء الهند. من باقة Starter المجانية إلى Enterprise.",
};

const BUNDLES: Partial<Record<SiteLang, SiteStrings>> = { en, es, hi, ar };

/**
 * Look up a single key for a given language. Falls back to English on a
 * per-key basis so a partially translated locale never renders the literal
 * key (`nav.forClubs`) to a real visitor.
 */
export function getSiteString(lang: SiteLang, key: SiteKey): string {
  const bundle = BUNDLES[lang];
  if (bundle) {
    const v = bundle[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return en[key];
}

/**
 * Locales for which we ship a complete translated bundle. The integrity
 * test iterates this list (rather than `SUPPORTED_SITE_LANGS`) so adding
 * a new language to the switcher doesn't immediately demand 100% coverage
 * — incomplete locales fall back per-key via `getSiteString`.
 */
export const FULLY_TRANSLATED_SITE_LANGS: readonly SiteLang[] = ["en", "es", "hi", "ar"];

/** Exposed for tests. */
export const SITE_BUNDLES = BUNDLES;
export const SITE_KEYS = Object.keys(en) as readonly SiteKey[];
