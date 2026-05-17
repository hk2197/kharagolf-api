/**
 * Task #369 — Public per-club marketing site renderer.
 * Renders /clubs/<slug> from the published `clubMarketingSitesTable` row,
 * including SEO meta, schema.org JSON-LD and deep-links into existing
 * booking/registration flows.
 */
import { useEffect, useRef, useState } from "react";
import { useRoute, Link } from "wouter";
import {
  Calendar, MapPin, Mail, Phone, Globe as GlobeIcon, Trophy,
  GraduationCap, UtensilsCrossed, ArrowRight, Loader2, Flag,
} from "lucide-react";
import { useCustomDomainSite } from "@/lib/custom-domain";

interface SiteResponse {
  organization: {
    id: number;
    name: string;
    slug: string;
    description: string | null;
    logoUrl: string | null;
    primaryColor: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    address: string | null;
    website: string | null;
    latitude: string | null;
    longitude: string | null;
    customDomain?: string | null;
  };
  site: {
    theme: string;
    heroImageUrl: string | null;
    heroTitle: string | null;
    heroSubtitle: string | null;
    heroCtaLabel: string | null;
    heroCtaHref: string | null;
    aboutMarkdown: string | null;
    servicesMarkdown: string | null;
    galleryImages: Array<{ url: string; caption?: string | null }>;
    sectionOrder: string[];
    enabledSections: Record<string, boolean>;
    seoTitle: string | null;
    seoDescription: string | null;
    seoOgImageUrl: string | null;
    // Task #584 — per-site brand overrides; null means "use theme default".
    brandPrimaryColor?: string | null;
    brandAccentColor?: string | null;
    brandHeadingFont?: string | null;
    // Task #666 — marketing-specific logo + favicon overrides; null means
    // "fall back to the org logo / platform default favicon".
    logoImageUrl?: string | null;
    faviconUrl?: string | null;
    publishedAt: string | null;
    cacheVersion: number;
  };
  tournaments: Array<{
    id: number; name: string; format: string; status: string;
    startDate: string | null; endDate: string | null;
    courseName: string | null; entryFee: string | null;
    registrationUrl: string;
  }>;
  courses?: Array<{
    id: number; slug: string; name: string;
    location: string | null; holes: number; par: number;
    heroImageUrl: string | null;
  }>;
  links: {
    bookTeeTime: string;
    applyMembership: string;
    viewLessons: string;
    contact: string | null;
  };
}

function setMeta(name: string, content: string, attr: "name" | "property" = "name") {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLinkRel(rel: string, href: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

/**
 * Task #666 — Swap in the club's custom favicon (if any). We mark the
 * injected <link> with data-club-favicon so we can revert to the platform
 * default favicon when the admin clears their override or the visitor
 * navigates away from a club site.
 */
function setClubFavicon(href: string | null, type?: string | null) {
  const platformIcons = Array.from(
    document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]:not([data-club-favicon])'),
  );
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="icon"][data-club-favicon]');
  if (!href) {
    if (el) el.remove();
    // Restore the platform-default favicon links if they were hidden.
    for (const p of platformIcons) p.removeAttribute("data-club-favicon-disabled");
    return;
  }
  // Hide the platform-default icon links so the browser uses the override.
  for (const p of platformIcons) p.setAttribute("data-club-favicon-disabled", "1");
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "icon");
    el.setAttribute("data-club-favicon", "1");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
  if (type) el.setAttribute("type", type);
  else el.removeAttribute("type");
}

function inferFaviconType(url: string): string | null {
  const lower = url.split("?")[0].toLowerCase();
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

function setJsonLd(id: string, data: unknown) {
  let el = document.head.querySelector<HTMLScriptElement>(`script[data-jsonld="${id}"]`);
  if (!el) {
    el = document.createElement("script");
    el.type = "application/ld+json";
    el.setAttribute("data-jsonld", id);
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(data);
}

function themeClasses(theme: string) {
  switch (theme) {
    case "modern":  return { hero: "bg-gradient-to-br from-emerald-700 via-emerald-900 to-black text-white", section: "bg-white text-gray-900", accent: "text-emerald-600" };
    case "minimal": return { hero: "bg-white text-gray-900 border-b", section: "bg-white text-gray-900", accent: "text-gray-900" };
    case "bold":    return { hero: "bg-black text-white", section: "bg-zinc-50 text-gray-900", accent: "text-amber-500" };
    case "classic":
    default:        return { hero: "bg-emerald-900 text-white", section: "bg-stone-50 text-gray-900", accent: "text-emerald-700" };
  }
}

function paragraphs(md: string | null | undefined) {
  if (!md) return null;
  return md.split(/\n\s*\n/).map((p, i) => (
    <p key={i} className="mb-4 leading-relaxed whitespace-pre-line">{p.trim()}</p>
  ));
}

// Task #631 — When the SSR pipeline prerendered this page, the payload was
// inlined as `window.__CLUB_INITIAL_DATA__`. Consume it once and clear the
// global so a back/forward navigation to a different club doesn't reuse
// stale data.
function consumeInitialClubData(currentPath: string): SiteResponse | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    __CLUB_INITIAL_DATA__?: SiteResponse;
    __CLUB_INITIAL_PATH__?: string;
  };
  const data = w.__CLUB_INITIAL_DATA__;
  const path = w.__CLUB_INITIAL_PATH__;
  if (!data) return null;
  if (path && path !== currentPath) return null;
  delete w.__CLUB_INITIAL_DATA__;
  delete w.__CLUB_INITIAL_PATH__;
  return data;
}

export default function ClubSitePage({ slugOverride }: { slugOverride?: string } = {}) {
  const [, params] = useRoute<{ slug: string }>("/clubs/:slug");
  const slug = slugOverride ?? params?.slug;
  const customDomain = useCustomDomainSite();
  // When the SPA was loaded from a club's vanity domain (Task #438),
  // CustomDomainProvider has already fetched the site payload — reuse
  // it to avoid a duplicate request.
  const prefetched = slugOverride && customDomain.slug === slugOverride
    ? (customDomain.prefetched as SiteResponse | null)
    : null;
  const ssrInitial = !prefetched && typeof window !== "undefined"
    ? consumeInitialClubData(window.location.pathname)
    : null;
  const initial = prefetched ?? ssrInitial;
  const [data, setData] = useState<SiteResponse | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initial);
  // Skip the first post-mount fetch when SSR (or custom-domain prefetch)
  // already supplied the payload — re-fetching would clobber the
  // prerendered tree for a tick.
  const hadInitialData = useRef(initial != null);

  // Task #437 — admins open this page with `?preview=<token>` from the
  // editor. The token is forwarded to the API so we render the current
  // saved draft (even if the site is unpublished).
  const previewToken = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("preview")
    : null;

  useEffect(() => {
    if (!slug || prefetched) return;
    if (hadInitialData.current) {
      hadInitialData.current = false;
      return;
    }
    setLoading(true);
    // When invoked via slugOverride (custom domain mode) the slug is
    // not part of the URL, so we still fetch by-slug for consistency.
    const url = previewToken
      ? `/api/public/clubs/${encodeURIComponent(slug)}/site?preview=${encodeURIComponent(previewToken)}`
      : `/api/public/clubs/${encodeURIComponent(slug)}/site`;
    fetch(url)
      .then(async r => {
        if (r.status === 404) { setError("not-found"); return null; }
        if (!r.ok) { setError("error"); return null; }
        return r.json();
      })
      .then((json: SiteResponse | null) => { if (json) setData(json); })
      .catch(() => setError("error"))
      .finally(() => setLoading(false));
  }, [slug, prefetched]);

  // SEO + schema.org
  useEffect(() => {
    if (!data) return;
    const { organization: org, site } = data;
    const title = site.seoTitle?.trim() || `${org.name} — Golf Club`;
    const desc = site.seoDescription?.trim() || org.description || `Welcome to ${org.name}.`;
    const ogImg = site.seoOgImageUrl || site.heroImageUrl || org.logoUrl || "";
    // Task #438 — Canonical URL prefers the club's custom domain when
    // one has been configured, otherwise falls back to the path-based
    // form on the current host.
    const customHost = org.customDomain?.toLowerCase() || null;
    const url = customHost
      ? `https://${customHost}/`
      : `${window.location.origin}/clubs/${org.slug}`;

    document.title = title;
    setMeta("description", desc);
    setMeta("og:title", title, "property");
    setMeta("og:description", desc, "property");
    setMeta("og:type", "website", "property");
    setMeta("og:url", url, "property");
    if (ogImg) setMeta("og:image", ogImg, "property");
    setMeta("twitter:card", ogImg ? "summary_large_image" : "summary");
    setMeta("twitter:title", title);
    setMeta("twitter:description", desc);
    setLinkRel("canonical", url);

    // Task #666 — Inject the club's custom favicon when configured;
    // fall back to the platform default otherwise.
    if (site.faviconUrl) {
      setClubFavicon(site.faviconUrl, inferFaviconType(site.faviconUrl));
    } else {
      setClubFavicon(null);
    }

    setJsonLd("club", {
      "@context": "https://schema.org",
      "@type": "GolfCourse",
      name: org.name,
      description: desc,
      url,
      logo: org.logoUrl ?? undefined,
      image: ogImg || undefined,
      address: org.address ? { "@type": "PostalAddress", streetAddress: org.address } : undefined,
      email: org.contactEmail ?? undefined,
      telephone: org.contactPhone ?? undefined,
      geo: org.latitude && org.longitude ? { "@type": "GeoCoordinates", latitude: org.latitude, longitude: org.longitude } : undefined,
    });

    if (data.tournaments.length) {
      setJsonLd("tournaments", data.tournaments.slice(0, 10).map(t => ({
        "@context": "https://schema.org",
        "@type": "SportsEvent",
        name: t.name,
        startDate: t.startDate,
        endDate: t.endDate,
        location: { "@type": "Place", name: t.courseName ?? org.name },
        url: `${window.location.origin}${t.registrationUrl}`,
        organizer: { "@type": "Organization", name: org.name },
      })));
    }
  }, [data]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (error === "not-found" || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
        <h1 className="text-2xl font-semibold mb-2">Club not found</h1>
        <p className="text-muted-foreground mb-6">This club doesn't have a published site yet.</p>
        <Link href="/" className="text-emerald-600 underline">Return home</Link>
      </div>
    );
  }

  const { organization: org, site, tournaments, links, courses = [] } = data;
  const t = themeClasses(site.theme);
  const enabled = site.enabledSections;
  const order = site.sectionOrder?.length ? site.sectionOrder : ["hero","about","tournaments","lessons","tee_times","fb","gallery","services","contact"];
  const heroCtaHref = site.heroCtaHref || links.bookTeeTime;

  // Task #584 — Per-site brand overrides applied on top of the chosen theme.
  // Inline styles have higher specificity than the Tailwind theme classes,
  // so setting them per-element cleanly overrides the theme defaults while
  // omitting them (null/undefined) reverts to the theme.
  const brandPrimary = site.brandPrimaryColor || null;
  const brandAccent = site.brandAccentColor || null;
  const brandFont = site.brandHeadingFont || null;
  const accentStyle = brandAccent ? { color: brandAccent } : undefined;
  const headingStyle = brandFont
    ? (brandAccent ? { color: brandAccent, fontFamily: brandFont } : { fontFamily: brandFont })
    : accentStyle;
  // Root-level CSS variables — exposed for any future custom CSS hooks.
  const rootStyle: React.CSSProperties = {};
  if (brandPrimary) (rootStyle as Record<string, string>)["--brand-primary"] = brandPrimary;
  if (brandAccent) (rootStyle as Record<string, string>)["--brand-accent"] = brandAccent;
  if (brandFont) (rootStyle as Record<string, string>)["--brand-heading-font"] = brandFont;

  function Section({ id, children }: { id: string; children: React.ReactNode }) {
    if (enabled[id] === false) return null;
    return <section id={id} className={`px-6 py-16 ${t.section}`}>{children}</section>;
  }

  return (
    <div className="min-h-screen bg-white text-gray-900" style={rootStyle} data-testid="club-site-root">
      {previewToken && (
        <div
          data-testid="preview-banner"
          className="bg-amber-500 text-black text-sm font-medium px-4 py-2 text-center sticky top-0 z-50"
        >
          Draft preview — this view shows unpublished changes and is only visible to admins.
        </div>
      )}
      {/* Top bar */}
      <header className="px-6 py-4 border-b flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Task #666 — Prefer the marketing-specific logo when set;
              fall back to the org's generic logo. */}
          {(() => {
            const headerLogo = site.logoImageUrl || org.logoUrl;
            return headerLogo ? (
              <img
                src={headerLogo}
                alt={`${org.name} logo`}
                className="h-9 w-9 rounded object-cover"
                data-testid="site-header-logo"
              />
            ) : null;
          })()}
          <div className="font-semibold">{org.name}</div>
        </div>
        <Link href="/" className="text-sm text-muted-foreground hover:underline">KHARAGOLF</Link>
      </header>

      {order.map((id) => {
        if (id === "hero") {
          if (enabled.hero === false) return null;
          // Task #584 — heroImageUrl wins over the brand primary color
          // (the image is the strongest visual element); without an image,
          // brandPrimary overrides the theme's hero background.
          const heroStyle: React.CSSProperties = site.heroImageUrl
            ? { backgroundImage: `linear-gradient(rgba(0,0,0,0.45),rgba(0,0,0,0.55)), url(${site.heroImageUrl})`, backgroundSize: "cover", backgroundPosition: "center", color: "white" }
            : (brandPrimary ? { backgroundColor: brandPrimary, color: "white" } : {});
          return (
            <section
              key="hero"
              data-testid="hero-section"
              className={`relative px-6 py-24 md:py-32 ${t.hero}`}
              style={heroStyle}
            >
              <div className="max-w-4xl mx-auto text-center">
                <h1 className="text-4xl md:text-6xl font-bold mb-4" style={brandFont ? { fontFamily: brandFont } : undefined}>{site.heroTitle || org.name}</h1>
                {site.heroSubtitle && <p className="text-lg md:text-xl mb-8 opacity-95">{site.heroSubtitle}</p>}
                <a href={heroCtaHref} data-testid="hero-cta" className="inline-flex items-center gap-2 bg-white text-gray-900 px-6 py-3 rounded-lg font-medium hover:opacity-90">
                  {site.heroCtaLabel || "Book a tee time"} <ArrowRight className="w-4 h-4" />
                </a>
              </div>
            </section>
          );
        }
        if (id === "about") {
          return (
            <Section key="about" id="about">
              <div className="max-w-3xl mx-auto">
                <h2 className={`text-3xl font-semibold mb-6 ${t.accent}`} style={headingStyle}>About {org.name}</h2>
                {paragraphs(site.aboutMarkdown) ?? <p className="text-muted-foreground">{org.description ?? "Welcome to our club."}</p>}
              </div>
            </Section>
          );
        }
        if (id === "tournaments") {
          return (
            <Section key="tournaments" id="tournaments">
              <div className="max-w-5xl mx-auto">
                <h2 className={`text-3xl font-semibold mb-2 flex items-center gap-2 ${t.accent}`} style={headingStyle}><Trophy className="w-7 h-7" />Upcoming tournaments</h2>
                <p className="text-muted-foreground mb-8">Open events and registrations from {org.name}.</p>
                {tournaments.length === 0 ? (
                  <div className="text-muted-foreground">No tournaments scheduled right now. Check back soon.</div>
                ) : (
                  <div className="grid md:grid-cols-2 gap-4">
                    {tournaments.map(t2 => (
                      <a key={t2.id} href={t2.registrationUrl} className="block border rounded-lg p-5 hover:shadow-md transition" data-testid={`tournament-${t2.id}`}>
                        <div className="font-semibold text-lg">{t2.name}</div>
                        <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                          <Calendar className="w-4 h-4" />
                          {t2.startDate ? new Date(t2.startDate).toLocaleDateString() : "TBA"}
                          {t2.courseName && <> · {t2.courseName}</>}
                        </div>
                        <div className="mt-3 text-sm font-medium inline-flex items-center gap-1">Register <ArrowRight className="w-3 h-3" /></div>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </Section>
          );
        }
        if (id === "lessons") {
          return (
            <Section key="lessons" id="lessons">
              <div className="max-w-3xl mx-auto text-center">
                <h2 className={`text-3xl font-semibold mb-4 flex items-center justify-center gap-2 ${t.accent}`} style={headingStyle}><GraduationCap className="w-7 h-7" />Lessons & coaching</h2>
                <p className="text-muted-foreground mb-6">Book a session with one of our PGA professionals or sign up for a clinic.</p>
                <a href={links.viewLessons} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gray-900 text-white hover:opacity-90">
                  Book a lesson <ArrowRight className="w-4 h-4" />
                </a>
              </div>
            </Section>
          );
        }
        if (id === "tee_times") {
          return (
            <Section key="tee_times" id="tee_times">
              <div className="max-w-3xl mx-auto text-center">
                <h2 className={`text-3xl font-semibold mb-4 ${t.accent}`} style={headingStyle}>Tee times & membership</h2>
                <p className="text-muted-foreground mb-6">Reserve your slot online or apply to become a member.</p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <a href={links.bookTeeTime} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">
                    Book tee time <ArrowRight className="w-4 h-4" />
                  </a>
                  <a href={links.applyMembership} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border hover:bg-gray-50">
                    Apply for membership
                  </a>
                </div>
              </div>
            </Section>
          );
        }
        if (id === "fb") {
          return (
            <Section key="fb" id="fb">
              <div className="max-w-3xl mx-auto text-center">
                <h2 className={`text-3xl font-semibold mb-4 flex items-center justify-center gap-2 ${t.accent}`} style={headingStyle}><UtensilsCrossed className="w-7 h-7" />Food & Beverage</h2>
                <p className="text-muted-foreground">Visit our clubhouse restaurant and on-course refreshments.</p>
              </div>
            </Section>
          );
        }
        if (id === "gallery") {
          if (!site.galleryImages?.length) return null;
          return (
            <Section key="gallery" id="gallery">
              <div className="max-w-6xl mx-auto">
                <h2 className={`text-3xl font-semibold mb-8 ${t.accent}`} style={headingStyle}>Gallery</h2>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {site.galleryImages.map((g, i) => (
                    <figure key={i} className="overflow-hidden rounded-lg">
                      <img src={g.url} alt={g.caption ?? `${org.name} photo ${i+1}`} className="w-full aspect-square object-cover hover:scale-105 transition" loading="lazy" />
                      {g.caption && <figcaption className="text-xs text-muted-foreground mt-1">{g.caption}</figcaption>}
                    </figure>
                  ))}
                </div>
              </div>
            </Section>
          );
        }
        if (id === "services") {
          if (!site.servicesMarkdown) return null;
          return (
            <Section key="services" id="services">
              <div className="max-w-3xl mx-auto">
                <h2 className={`text-3xl font-semibold mb-6 ${t.accent}`} style={headingStyle}>Services & amenities</h2>
                {paragraphs(site.servicesMarkdown)}
              </div>
            </Section>
          );
        }
        if (id === "contact") {
          return (
            <Section key="contact" id="contact">
              <div className="max-w-3xl mx-auto">
                <h2 className={`text-3xl font-semibold mb-6 ${t.accent}`} style={headingStyle}>Get in touch</h2>
                <ul className="space-y-3">
                  {org.address && <li className="flex items-start gap-3"><MapPin className="w-5 h-5 mt-0.5 text-muted-foreground" /><span>{org.address}</span></li>}
                  {org.contactEmail && <li className="flex items-start gap-3"><Mail className="w-5 h-5 mt-0.5 text-muted-foreground" /><a href={`mailto:${org.contactEmail}`} className="hover:underline">{org.contactEmail}</a></li>}
                  {org.contactPhone && <li className="flex items-start gap-3"><Phone className="w-5 h-5 mt-0.5 text-muted-foreground" /><a href={`tel:${org.contactPhone}`} className="hover:underline">{org.contactPhone}</a></li>}
                  {org.website && <li className="flex items-start gap-3"><GlobeIcon className="w-5 h-5 mt-0.5 text-muted-foreground" /><a href={org.website} target="_blank" rel="noreferrer" className="hover:underline">{org.website}</a></li>}
                </ul>
              </div>
            </Section>
          );
        }
        return null;
      })}

      {/* ── Task #384: link-out to public course pages ─────────────── */}
      {courses.length > 0 && (
        <section id="courses" className={`px-6 py-16 ${t.section}`}>
          <div className="max-w-5xl mx-auto">
            <h2 className={`text-3xl font-semibold mb-2 flex items-center gap-2 ${t.accent}`} style={headingStyle}>
              <Flag className="w-7 h-7" /> Our courses
            </h2>
            <p className="text-muted-foreground mb-8">
              Explore each course in detail — slope, rating, hole-by-hole yardages and player reviews.
            </p>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {courses.map(c => (
                <Link
                  key={c.id}
                  href={`/clubs/${org.slug}/courses/${c.slug}`}
                  className="block border rounded-lg overflow-hidden hover:shadow-md transition bg-white"
                  data-testid={`course-card-${c.slug}`}
                >
                  {c.heroImageUrl && (
                    <img src={c.heroImageUrl} alt={`${c.name} hero`} className="w-full aspect-[16/9] object-cover" loading="lazy" />
                  )}
                  <div className="p-4">
                    <div className="font-semibold text-lg">{c.name}</div>
                    <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5" />{c.location ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground mt-2">{c.holes} holes · Par {c.par}</div>
                    <div className="mt-3 text-sm font-medium text-emerald-700 inline-flex items-center gap-1">
                      View course <ArrowRight className="w-3 h-3" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <footer className="px-6 py-8 border-t text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} {org.name}. Powered by <Link href="/" className="hover:underline">KHARAGOLF</Link>.
      </footer>
    </div>
  );
}
