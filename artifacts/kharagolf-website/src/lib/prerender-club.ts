/**
 * Task #631 — Server-side prerender helpers for the public club page
 * (`/clubs/:clubSlug`). Mirrors the structure of `prerender-course.ts`:
 * dependency-free, returns the head/body fragments and an inline
 * initial-data script so React can hydrate without re-fetching.
 *
 * The crawler-visible HTML covers everything search engines need to
 * index a club: name, description, address/contact, the configured
 * site sections (about, services), upcoming tournaments, and the list
 * of public courses with deep links to each course page.
 */

export interface ClubGalleryImage {
  url: string;
  caption?: string | null;
}

export interface ClubTournament {
  id: number;
  name: string;
  format: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  courseName: string | null;
  entryFee: string | null;
  registrationUrl: string;
}

export interface ClubCourseSummary {
  id: number;
  slug: string;
  name: string;
  location: string | null;
  holes: number;
  par: number;
  heroImageUrl: string | null;
}

export interface ClubPageData {
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
    galleryImages: ClubGalleryImage[];
    sectionOrder: string[];
    enabledSections: Record<string, boolean>;
    seoTitle: string | null;
    seoDescription: string | null;
    seoOgImageUrl: string | null;
    brandPrimaryColor?: string | null;
    brandAccentColor?: string | null;
    brandHeadingFont?: string | null;
    // Task #666 — marketing-specific logo + favicon overrides.
    logoImageUrl?: string | null;
    faviconUrl?: string | null;
    publishedAt: string | null;
    cacheVersion: number;
  };
  tournaments: ClubTournament[];
  courses?: ClubCourseSummary[];
  links: {
    bookTeeTime: string;
    applyMembership: string;
    viewLessons: string;
    contact: string | null;
  };
}

function escapeHtml(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string | number | null | undefined): string {
  return escapeHtml(s);
}

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

function formatDate(iso: string | null): string {
  if (!iso) return "TBA";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function buildSeoTitle(data: ClubPageData): string {
  const seo = data.site.seoTitle?.trim();
  if (seo) return seo;
  return `${data.organization.name} — Golf Club | KharaGolf`;
}

function buildSeoDescription(data: ClubPageData): string {
  const explicit = data.site.seoDescription?.trim();
  if (explicit) return truncate(explicit.replace(/\s+/g, " "), 300);
  const desc = data.organization.description?.trim();
  if (desc) return truncate(desc.replace(/\s+/g, " "), 300);
  const courseCount = data.courses?.length ?? 0;
  const parts = [`Welcome to ${data.organization.name}.`];
  if (courseCount > 0) {
    parts.push(`${courseCount} public course${courseCount === 1 ? "" : "s"} to explore.`);
  }
  if (data.organization.address) parts.push(data.organization.address);
  return truncate(parts.join(" "), 300);
}

/**
 * Build the schema.org GolfClub / LocalBusiness JSON-LD object describing
 * the organization and its courses. Aligns with the client component's
 * structured data so prerendered + hydrated trees match.
 */
function buildClubJsonLd(data: ClubPageData, canonicalUrl: string): Record<string, unknown> {
  const org = data.organization;
  const ogImg = data.site.seoOgImageUrl || data.site.heroImageUrl || org.logoUrl || undefined;
  return {
    "@context": "https://schema.org",
    "@type": ["GolfCourse", "LocalBusiness"],
    name: org.name,
    description: buildSeoDescription(data),
    url: canonicalUrl,
    logo: org.logoUrl ?? undefined,
    image: ogImg,
    address: org.address
      ? { "@type": "PostalAddress", streetAddress: org.address }
      : undefined,
    email: org.contactEmail ?? undefined,
    telephone: org.contactPhone ?? undefined,
    sameAs: org.website ? [org.website] : undefined,
    geo:
      org.latitude && org.longitude
        ? { "@type": "GeoCoordinates", latitude: org.latitude, longitude: org.longitude }
        : undefined,
    amenityFeature: (data.courses ?? []).map(c => ({
      "@type": "LocationFeatureSpecification",
      name: c.name,
      value: `${c.holes} holes, par ${c.par}`,
    })),
  };
}

/**
 * Render the head tags (title, meta, canonical, OG/Twitter, JSON-LD).
 * Caller is responsible for stripping site-default head tags first.
 */
export function renderClubHead(data: ClubPageData, canonicalUrl: string): string {
  const title = buildSeoTitle(data);
  const description = buildSeoDescription(data);
  const ogImg = data.site.seoOgImageUrl || data.site.heroImageUrl || data.organization.logoUrl || null;
  const jsonLd = buildClubJsonLd(data, canonicalUrl);

  const lines: string[] = [];
  lines.push(`<title>${escapeHtml(title)}</title>`);
  lines.push(`<meta name="description" content="${escapeAttr(description)}" />`);
  lines.push(`<link rel="canonical" href="${escapeAttr(canonicalUrl)}" />`);
  // Task #666 — Inject the club's custom favicon when configured. We
  // mark it with data-club-favicon so the client component can manage
  // it (and revert to the platform default) on subsequent navigations.
  if (data.site.faviconUrl) {
    const faviconUrl = data.site.faviconUrl;
    const lower = faviconUrl.split("?")[0].toLowerCase();
    let type: string | null = null;
    if (lower.endsWith(".ico")) type = "image/x-icon";
    else if (lower.endsWith(".png")) type = "image/png";
    else if (lower.endsWith(".svg")) type = "image/svg+xml";
    else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) type = "image/jpeg";
    else if (lower.endsWith(".gif")) type = "image/gif";
    else if (lower.endsWith(".webp")) type = "image/webp";
    const typeAttr = type ? ` type="${escapeAttr(type)}"` : "";
    lines.push(
      `<link rel="icon"${typeAttr} href="${escapeAttr(faviconUrl)}" data-club-favicon="1" />`,
    );
  }
  lines.push(`<meta property="og:title" content="${escapeAttr(title)}" />`);
  lines.push(`<meta property="og:description" content="${escapeAttr(description)}" />`);
  lines.push(`<meta property="og:type" content="website" />`);
  lines.push(`<meta property="og:url" content="${escapeAttr(canonicalUrl)}" />`);
  if (ogImg) lines.push(`<meta property="og:image" content="${escapeAttr(ogImg)}" />`);
  lines.push(`<meta name="twitter:card" content="${ogImg ? "summary_large_image" : "summary"}" />`);
  lines.push(`<meta name="twitter:title" content="${escapeAttr(title)}" />`);
  lines.push(`<meta name="twitter:description" content="${escapeAttr(description)}" />`);
  if (ogImg) lines.push(`<meta name="twitter:image" content="${escapeAttr(ogImg)}" />`);
  lines.push(
    `<script type="application/ld+json" data-jsonld="club">${escapeJsonForScript(jsonLd)}</script>`,
  );
  return lines.join("\n    ");
}

function renderParagraphs(md: string | null | undefined): string {
  if (!md) return "";
  return md
    .split(/\n\s*\n/)
    .map(p => `<p>${escapeHtml(p.trim())}</p>`)
    .join("");
}

/**
 * Render an SEO-friendly, JS-free body for the club page. Replaced by the
 * React client on hydration — prioritizes indexable copy over visual
 * fidelity.
 */
export function renderClubBody(data: ClubPageData): string {
  const { organization: org, site, tournaments, courses = [], links } = data;
  const heroTitle = site.heroTitle || org.name;
  const heroSubtitle = site.heroSubtitle || org.description || "";
  const heroCtaHref = site.heroCtaHref || links.bookTeeTime;
  const heroCtaLabel = site.heroCtaLabel || "Book a tee time";
  const heroImg = site.heroImageUrl
    ? `<img src="${escapeAttr(site.heroImageUrl)}" alt="${escapeAttr(`${org.name} hero`)}" />`
    : "";

  const aboutBlock = `
    <section data-testid="ssr-about">
      <h2>About ${escapeHtml(org.name)}</h2>
      ${renderParagraphs(site.aboutMarkdown) || `<p>${escapeHtml(org.description ?? `Welcome to ${org.name}.`)}</p>`}
    </section>`;

  const servicesBlock = site.servicesMarkdown
    ? `<section data-testid="ssr-services">
        <h2>Services &amp; amenities</h2>
        ${renderParagraphs(site.servicesMarkdown)}
      </section>`
    : "";

  const tournamentsBlock =
    tournaments.length > 0
      ? `<section data-testid="ssr-tournaments">
          <h2>Upcoming tournaments</h2>
          <ul>
            ${tournaments
              .map(
                t => `
              <li>
                <a href="${escapeAttr(t.registrationUrl)}">
                  <strong>${escapeHtml(t.name)}</strong>
                </a>
                — ${escapeHtml(formatDate(t.startDate))}${t.courseName ? ` · ${escapeHtml(t.courseName)}` : ""}
              </li>`,
              )
              .join("")}
          </ul>
        </section>`
      : "";

  const coursesBlock =
    courses.length > 0
      ? `<section data-testid="ssr-courses">
          <h2>Our courses</h2>
          <ul>
            ${courses
              .map(
                c => `
              <li data-testid="ssr-course-${escapeAttr(c.slug)}">
                <a href="/clubs/${escapeAttr(org.slug)}/courses/${escapeAttr(c.slug)}">
                  <strong>${escapeHtml(c.name)}</strong>
                </a>
                — ${escapeHtml(c.holes)} holes, par ${escapeHtml(c.par)}${c.location ? ` · ${escapeHtml(c.location)}` : ""}
              </li>`,
              )
              .join("")}
          </ul>
        </section>`
      : `<section data-testid="ssr-courses"><p><em>No public courses listed yet.</em></p></section>`;

  const galleryBlock =
    site.galleryImages?.length > 0
      ? `<section data-testid="ssr-gallery">
          <h2>Gallery</h2>
          <ul>
            ${site.galleryImages
              .map(
                (g, i) => `
              <li>
                <img src="${escapeAttr(g.url)}" alt="${escapeAttr(g.caption ?? `${org.name} photo ${i + 1}`)}" loading="lazy" />
                ${g.caption ? `<figcaption>${escapeHtml(g.caption)}</figcaption>` : ""}
              </li>`,
              )
              .join("")}
          </ul>
        </section>`
      : "";

  const contactBlock = `
    <section data-testid="ssr-contact">
      <h2>Get in touch</h2>
      <ul>
        ${org.address ? `<li><strong>Address:</strong> ${escapeHtml(org.address)}</li>` : ""}
        ${org.contactEmail ? `<li><strong>Email:</strong> <a href="mailto:${escapeAttr(org.contactEmail)}">${escapeHtml(org.contactEmail)}</a></li>` : ""}
        ${org.contactPhone ? `<li><strong>Phone:</strong> <a href="tel:${escapeAttr(org.contactPhone)}">${escapeHtml(org.contactPhone)}</a></li>` : ""}
        ${org.website ? `<li><strong>Website:</strong> <a href="${escapeAttr(org.website)}" rel="noreferrer">${escapeHtml(org.website)}</a></li>` : ""}
      </ul>
    </section>`;

  return `
    <noscript><p style="background:#fef3c7;padding:8px;text-align:center">This page works best with JavaScript enabled, but all content below is fully readable without it.</p></noscript>
    <main data-testid="ssr-club-page">
      <nav aria-label="Breadcrumb">
        <a href="/">KharaGolf</a> /
        <span>${escapeHtml(org.name)}</span>
      </nav>

      <header>
        ${heroImg}
        <h1>${escapeHtml(heroTitle)}</h1>
        ${heroSubtitle ? `<p>${escapeHtml(heroSubtitle)}</p>` : ""}
        <p><a href="${escapeAttr(heroCtaHref)}" data-testid="ssr-cta-hero">${escapeHtml(heroCtaLabel)}</a></p>
      </header>

      ${aboutBlock}
      ${coursesBlock}
      ${tournamentsBlock}
      ${servicesBlock}
      ${galleryBlock}
      ${contactBlock}

      <section>
        <h2>Plan your visit</h2>
        <ul>
          <li><a href="${escapeAttr(links.bookTeeTime)}">Book a tee time</a></li>
          <li><a href="${escapeAttr(links.applyMembership)}">Apply for membership</a></li>
          <li><a href="${escapeAttr(links.viewLessons)}">View lessons &amp; coaching</a></li>
        </ul>
      </section>
    </main>`;
}

/**
 * Strip the site-default head tags that the club page needs to override
 * so per-club versions don't end up duplicated.
 */
export function stripSiteDefaultHead(template: string): string {
  return template
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/gi, "")
    .replace(/<meta\s+property=["']og:title["'][^>]*>\s*/gi, "")
    .replace(/<meta\s+property=["']og:description["'][^>]*>\s*/gi, "")
    .replace(/<meta\s+property=["']og:image["'][^>]*>\s*/gi, "")
    .replace(/<meta\s+property=["']og:url["'][^>]*>\s*/gi, "")
    .replace(/<meta\s+name=["']twitter:title["'][^>]*>\s*/gi, "")
    .replace(/<meta\s+name=["']twitter:description["'][^>]*>\s*/gi, "")
    .replace(/<meta\s+name=["']twitter:image["'][^>]*>\s*/gi, "")
    .replace(/<link\s+rel=["']canonical["'][^>]*>\s*/gi, "");
}

/**
 * Inline the prerendered club JSON so the client component can hydrate
 * without re-fetching on first render.
 */
export function renderInitialClubDataScript(data: ClubPageData, canonicalPath: string): string {
  return `<script>window.__CLUB_INITIAL_DATA__=${escapeJsonForScript(data)};window.__CLUB_INITIAL_PATH__=${escapeJsonForScript(canonicalPath)};</script>`;
}
