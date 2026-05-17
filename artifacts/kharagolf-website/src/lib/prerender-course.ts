/**
 * Task #477 — Server-side prerender helpers for the public course page.
 *
 * Produces SEO-friendly HTML (hero, stats, description, hole table, gallery,
 * JSON-LD) and the head tags (title, meta, canonical, structured data) that
 * crawlers see when JavaScript is disabled. The client React component then
 * mounts and replaces the prerendered markup using `createRoot().render()`,
 * so this output only needs to be valid, indexable HTML — not React-perfect.
 *
 * Keep this file dependency-free so it can run inside the Node SSR server
 * without touching React, Vite, or browser-only globals.
 */

export interface CoursePhoto {
  id: number;
  url: string;
  thumbnailUrl: string | null;
  caption: string | null;
  holeNumber: number | null;
  isHero: boolean;
  uploaderName: string | null;
}

export interface CourseHole {
  holeNumber: number;
  par: number;
  handicap: number | null;
  yardageBlue: number | null;
  yardageWhite: number | null;
  yardageRed: number | null;
  description: string | null;
  photoUrl: string | null;
}

export interface CourseReview {
  id: number;
  rating: number;
  title: string | null;
  body: string | null;
  reviewerDisplayName: string | null;
  displayMode: string;
  createdAt: string;
  adminReply: string | null;
  adminReplyAt: string | null;
}

export interface CoursePageData {
  club: {
    id: number;
    name: string;
    slug: string;
    logoUrl: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    address: string | null;
    website: string | null;
  };
  course: {
    id: number;
    slug: string;
    name: string;
    description: string | null;
    location: string | null;
    latitude: string | null;
    longitude: string | null;
    holes: number;
    par: number;
    rating: string | null;
    slope: number | null;
    yardage: number | null;
    designer: string | null;
    yearOpened: number | null;
    awards: string[];
    contactPhone: string | null;
    contactEmail: string | null;
    heroImageUrl: string | null;
  };
  holes: CourseHole[];
  photos: CoursePhoto[];
  reviewSummary: {
    averageRating: number | null;
    totalReviews: number;
    recent: CourseReview[];
  };
  teeTimeUrl: string;
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

function formatDate(iso: string): string {
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

/**
 * Build a description suitable for <meta name="description"> and og:description.
 * Falls back to a stat sentence when the club hasn't written a description.
 */
function buildSeoDescription(data: CoursePageData): string {
  const c = data.course;
  const club = data.club;
  if (c.description && c.description.trim().length > 0) {
    return truncate(c.description.replace(/\s+/g, " ").trim(), 300);
  }
  return truncate(
    `${c.holes}-hole, par ${c.par} golf course at ${club.name}` +
      (c.slope != null ? `. Slope ${c.slope}` : "") +
      (c.rating != null ? `, course rating ${c.rating}` : "") +
      (c.location ? `. Located in ${c.location}.` : "."),
    300,
  );
}

/**
 * Build the schema.org GolfCourse JSON-LD object exactly matching the client
 * component, so the prerendered HTML and the hydrated React tree agree.
 */
function buildGolfCourseJsonLd(data: CoursePageData, canonicalUrl: string): Record<string, unknown> {
  const c = data.course;
  const club = data.club;
  const ratingValue = data.reviewSummary.averageRating;
  return {
    "@context": "https://schema.org",
    "@type": ["GolfCourse", "SportsActivityLocation"],
    name: c.name,
    description: c.description ?? undefined,
    image: c.heroImageUrl ?? undefined,
    address: club.address ?? c.location ?? undefined,
    telephone: c.contactPhone ?? club.contactPhone ?? undefined,
    url: canonicalUrl,
    geo:
      c.latitude && c.longitude
        ? {
            "@type": "GeoCoordinates",
            latitude: c.latitude,
            longitude: c.longitude,
          }
        : undefined,
    numberOfHoles: c.holes,
    additionalProperty: [
      c.par != null ? { "@type": "PropertyValue", name: "Par", value: c.par } : null,
      c.rating != null ? { "@type": "PropertyValue", name: "Course Rating", value: c.rating } : null,
      c.slope != null ? { "@type": "PropertyValue", name: "Slope", value: c.slope } : null,
      c.yardage != null ? { "@type": "PropertyValue", name: "Yardage", value: c.yardage } : null,
      c.designer ? { "@type": "PropertyValue", name: "Designer", value: c.designer } : null,
      c.yearOpened ? { "@type": "PropertyValue", name: "Year Opened", value: c.yearOpened } : null,
    ].filter(Boolean),
    aggregateRating:
      ratingValue != null && data.reviewSummary.totalReviews > 0
        ? {
            "@type": "AggregateRating",
            ratingValue: Number(ratingValue.toFixed(1)),
            reviewCount: data.reviewSummary.totalReviews,
            bestRating: 5,
            worstRating: 1,
          }
        : undefined,
    review: data.reviewSummary.recent.slice(0, 5).map(r => ({
      "@type": "Review",
      reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5 },
      author: {
        "@type": "Person",
        name: r.displayMode === "anonymous" ? "Anonymous" : r.reviewerDisplayName ?? "Anonymous",
      },
      reviewBody: r.body ?? undefined,
      name: r.title ?? undefined,
      datePublished: r.createdAt,
    })),
  };
}

/**
 * Render the <head>-injected tags: title, description, canonical, OG/Twitter,
 * and the GolfCourse JSON-LD. The caller is responsible for stripping any
 * site-default copies of these tags before injecting these.
 */
export function renderCourseHead(data: CoursePageData, canonicalUrl: string): string {
  const c = data.course;
  const club = data.club;
  const title = `${c.name} — ${club.name} | KharaGolf`;
  const description = buildSeoDescription(data);
  const canonical = canonicalUrl;
  const jsonLd = buildGolfCourseJsonLd(data, canonical);

  const lines: string[] = [];
  lines.push(`<title>${escapeHtml(title)}</title>`);
  lines.push(`<meta name="description" content="${escapeAttr(description)}" />`);
  lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}" />`);
  lines.push(`<meta property="og:title" content="${escapeAttr(title)}" />`);
  lines.push(`<meta property="og:description" content="${escapeAttr(description)}" />`);
  lines.push(`<meta property="og:type" content="website" />`);
  lines.push(`<meta property="og:url" content="${escapeAttr(canonical)}" />`);
  if (c.heroImageUrl) {
    lines.push(`<meta property="og:image" content="${escapeAttr(c.heroImageUrl)}" />`);
  }
  lines.push(`<meta name="twitter:card" content="summary_large_image" />`);
  lines.push(`<meta name="twitter:title" content="${escapeAttr(title)}" />`);
  lines.push(`<meta name="twitter:description" content="${escapeAttr(description)}" />`);
  if (c.heroImageUrl) {
    lines.push(`<meta name="twitter:image" content="${escapeAttr(c.heroImageUrl)}" />`);
  }
  lines.push(
    `<script type="application/ld+json" data-jsonld="course">${escapeJsonForScript(jsonLd)}</script>`,
  );
  return lines.join("\n    ");
}

/**
 * Render an SEO-friendly, JS-free HTML body for the course page. The React
 * client replaces this on mount via createRoot — so styling fidelity isn't
 * critical, but every piece of indexable copy must be present.
 */
export function renderCourseBody(data: CoursePageData): string {
  const { club, course, holes, photos, reviewSummary, teeTimeUrl } = data;
  const galleryPhotos = photos.filter(p => !p.holeNumber);
  const heroImg = course.heroImageUrl
    ? `<img src="${escapeAttr(course.heroImageUrl)}" alt="${escapeAttr(`${course.name} signature view`)}" />`
    : "";
  const ratingBlock =
    reviewSummary.averageRating != null && reviewSummary.totalReviews > 0
      ? `<p data-testid="ssr-rating"><strong>${escapeHtml(reviewSummary.averageRating.toFixed(1))}</strong> / 5 across ${escapeHtml(reviewSummary.totalReviews)} verified review${reviewSummary.totalReviews === 1 ? "" : "s"}.</p>`
      : "";

  const descBlock = course.description
    ? course.description
        .split(/\n\s*\n/)
        .map(p => `<p>${escapeHtml(p)}</p>`)
        .join("")
    : `<p><em>The club hasn't added a description yet.</em></p>`;

  const awardsBlock =
    course.awards.length > 0
      ? `<section><h3>Recognition</h3><ul>${course.awards
          .map(a => `<li>${escapeHtml(a)}</li>`)
          .join("")}</ul></section>`
      : "";

  const detailsBlock = `
    <aside>
      <h3>Course details</h3>
      <dl>
        ${course.designer ? `<dt>Designer</dt><dd>${escapeHtml(course.designer)}</dd>` : ""}
        ${course.yearOpened ? `<dt>Year opened</dt><dd>${escapeHtml(course.yearOpened)}</dd>` : ""}
        ${course.contactPhone ? `<dt>Phone</dt><dd><a href="tel:${escapeAttr(course.contactPhone)}">${escapeHtml(course.contactPhone)}</a></dd>` : ""}
        ${course.contactEmail ? `<dt>Email</dt><dd><a href="mailto:${escapeAttr(course.contactEmail)}">${escapeHtml(course.contactEmail)}</a></dd>` : ""}
      </dl>
    </aside>`;

  const holeRows = holes
    .map(
      h => `
      <tr data-testid="ssr-hole-${escapeAttr(h.holeNumber)}">
        <td>${escapeHtml(h.holeNumber)}</td>
        <td>${escapeHtml(h.par)}</td>
        <td>${escapeHtml(h.handicap ?? "—")}</td>
        <td>${escapeHtml(h.yardageBlue ?? "—")}</td>
        <td>${escapeHtml(h.yardageWhite ?? "—")}</td>
        <td>${escapeHtml(h.yardageRed ?? "—")}</td>
      </tr>`,
    )
    .join("");

  const holeTable =
    holes.length > 0
      ? `<section>
          <h2>Hole by hole</h2>
          <table>
            <thead>
              <tr><th>Hole</th><th>Par</th><th>HCP</th><th>Blue</th><th>White</th><th>Red</th></tr>
            </thead>
            <tbody>${holeRows}</tbody>
          </table>
        </section>`
      : "";

  const galleryBlock =
    galleryPhotos.length > 0
      ? `<section>
          <h2>Course gallery</h2>
          <ul>
            ${galleryPhotos
              .map(
                p => `
              <li>
                <img src="${escapeAttr(p.thumbnailUrl ?? p.url)}" alt="${escapeAttr(p.caption ?? `${course.name} photo`)}" loading="lazy" />
                ${p.caption ? `<figcaption>${escapeHtml(p.caption)}${p.uploaderName ? ` — ${escapeHtml(p.uploaderName)}` : ""}</figcaption>` : ""}
              </li>`,
              )
              .join("")}
          </ul>
        </section>`
      : "";

  const reviewBlock =
    reviewSummary.recent.length > 0
      ? `<section>
          <h2>Player reviews</h2>
          <ul>
            ${reviewSummary.recent
              .map(
                r => `
              <li>
                <p><strong>${escapeHtml(r.rating)} / 5</strong> — ${escapeHtml(
                  r.displayMode === "anonymous" ? "Anonymous golfer" : r.reviewerDisplayName ?? "A KharaGolf player",
                )} · ${escapeHtml(formatDate(r.createdAt))}</p>
                ${r.title ? `<h3>${escapeHtml(r.title)}</h3>` : ""}
                ${r.body ? `<p>${escapeHtml(r.body)}</p>` : ""}
                ${r.adminReply ? `<blockquote data-testid="ssr-admin-reply-${escapeHtml(r.id)}"><p><strong>Reply from ${escapeHtml(club.name)}${r.adminReplyAt ? ` · ${escapeHtml(formatDate(r.adminReplyAt))}` : ""}:</strong></p><p>${escapeHtml(r.adminReply)}</p></blockquote>` : ""}
              </li>`,
              )
              .join("")}
          </ul>
        </section>`
      : `<p><em>No reviews yet — be the first to share your round.</em></p>`;

  return `
    <noscript><p style="background:#fef3c7;padding:8px;text-align:center">This page works best with JavaScript enabled, but all content below is fully readable without it.</p></noscript>
    <main data-testid="ssr-course-page">
      <nav aria-label="Breadcrumb">
        <a href="/">KharaGolf</a> /
        <a href="/clubs/${escapeAttr(club.slug)}">${escapeHtml(club.name)}</a> /
        <span>${escapeHtml(course.name)}</span>
      </nav>

      <header>
        ${heroImg}
        <h1>${escapeHtml(course.name)}</h1>
        ${course.location ? `<p>${escapeHtml(course.location)}</p>` : ""}
        ${ratingBlock}
        <p><a href="${escapeAttr(teeTimeUrl)}" data-testid="ssr-cta-book-tee-time">Book a tee time</a></p>
      </header>

      <section aria-label="Course stats">
        <ul>
          <li><strong>Holes:</strong> ${escapeHtml(course.holes)}</li>
          <li><strong>Par:</strong> ${escapeHtml(course.par)}</li>
          <li><strong>Course Rating:</strong> ${escapeHtml(course.rating ?? "—")}</li>
          <li><strong>Slope:</strong> ${escapeHtml(course.slope ?? "—")}</li>
          <li><strong>Yardage:</strong> ${escapeHtml(course.yardage ? course.yardage.toLocaleString("en-US") : "—")}</li>
        </ul>
      </section>

      <section>
        <h2>About the course</h2>
        ${descBlock}
        ${awardsBlock}
      </section>

      ${detailsBlock}
      ${holeTable}
      ${galleryBlock}
      ${reviewBlock}

      <section>
        <h2>Ready to play ${escapeHtml(course.name)}?</h2>
        <p><a href="${escapeAttr(teeTimeUrl)}">Book a tee time at ${escapeHtml(club.name)}</a></p>
      </section>
    </main>`;
}

/**
 * Strip the site-default head tags that the course page needs to override
 * (title, description, OG/Twitter image+title+description, canonical link)
 * so the per-course versions don't end up duplicated in the document head.
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
 * Inline the prerendered course JSON so the client component can hydrate
 * without re-fetching on the first render.
 */
export function renderInitialDataScript(data: CoursePageData, canonicalPath: string): string {
  return `<script>window.__COURSE_INITIAL_DATA__=${escapeJsonForScript(data)};window.__COURSE_INITIAL_PATH__=${escapeJsonForScript(canonicalPath)};</script>`;
}
