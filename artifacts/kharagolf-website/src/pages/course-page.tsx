/**
 * Task #384 — Public course page renderer.
 * Renders /clubs/<clubSlug>/courses/<courseSlug> with hero photo,
 * slope/rating/par/designer/awards, hole-by-hole gallery & yardages,
 * verified player reviews, photo upload prompt, tee-time CTA, and
 * SEO + schema.org GolfCourse JSON-LD.
 */
import { useEffect, useState, useCallback, useRef, type FormEvent } from "react";
import { useRoute, Link } from "wouter";
import {
  MapPin, Star, Calendar, ArrowRight, Loader2, Trophy, ChevronLeft,
  Camera, Phone, Mail, Flag, Pencil, Upload, X, ChevronRight,
} from "lucide-react";

interface CoursePhoto {
  id: number;
  url: string;
  thumbnailUrl: string | null;
  caption: string | null;
  holeNumber: number | null;
  isHero: boolean;
  uploaderName: string | null;
}

interface CourseHole {
  holeNumber: number;
  par: number;
  handicap: number | null;
  yardageBlue: number | null;
  yardageWhite: number | null;
  yardageRed: number | null;
  description: string | null;
  photoUrl: string | null;
}

interface CourseReview {
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

interface CoursePageData {
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

function StarRow({ value, max = 5, size = 16 }: { value: number; max?: number; size?: number }) {
  const filled = Math.round(value);
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`Rated ${value.toFixed(1)} of ${max}`}>
      {Array.from({ length: max }).map((_, i) => (
        <Star
          key={i}
          size={size}
          className={i < filled ? "text-amber-400 fill-amber-400" : "text-gray-300"}
        />
      ))}
    </span>
  );
}

function formatDate(iso: string) {
  try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return iso; }
}

/**
 * Task #477 — When this page is server-rendered, the SSR layer inlines the
 * fetched payload as `window.__COURSE_INITIAL_DATA__` (paired with the path
 * it was prerendered for). We pick it up on first mount so we don't double-
 * fetch and so the visible content matches what crawlers already saw. The
 * data is consumed once, then cleared, so client-side navigation falls back
 * to a normal fetch.
 */
function consumeInitialCourseData(currentPath: string): CoursePageData | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    __COURSE_INITIAL_DATA__?: CoursePageData;
    __COURSE_INITIAL_PATH__?: string;
  };
  const data = w.__COURSE_INITIAL_DATA__;
  const initialPath = w.__COURSE_INITIAL_PATH__;
  if (!data) return null;
  // Only honour the inlined payload when we're rendering the same URL the
  // server prerendered for. Avoids a stale flash if someone client-navigates
  // away and back to a different course.
  if (initialPath && currentPath && initialPath !== currentPath) return null;
  delete w.__COURSE_INITIAL_DATA__;
  delete w.__COURSE_INITIAL_PATH__;
  return data;
}

export default function CoursePage() {
  const [, params] = useRoute<{ clubSlug: string; courseSlug: string }>("/clubs/:clubSlug/courses/:courseSlug");
  const clubSlug = params?.clubSlug;
  const courseSlug = params?.courseSlug;

  const initial = typeof window !== "undefined"
    ? consumeInitialCourseData(window.location.pathname)
    : null;
  const [data, setData] = useState<CoursePageData | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(initial == null);
  const [activeHole, setActiveHole] = useState<CourseHole | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!clubSlug || !courseSlug) return;
    setLoading(true);
    fetch(`/api/public/clubs/${encodeURIComponent(clubSlug)}/courses/${encodeURIComponent(courseSlug)}`)
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<CoursePageData>;
      })
      .then(d => { setData(d); setError(null); })
      .catch((e: Error) => { setError(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, [clubSlug, courseSlug]);

  // Skip the initial fetch when SSR has already inlined the payload — the
  // load() call would otherwise blank the prerendered content for a tick.
  const hadInitialData = useRef(initial != null);
  useEffect(() => {
    if (hadInitialData.current) {
      hadInitialData.current = false;
      return;
    }
    load();
  }, [load]);

  // SEO + schema.org GolfCourse JSON-LD
  useEffect(() => {
    if (!data) return;
    const c = data.course;
    const club = data.club;
    const title = `${c.name} — ${club.name} | KharaGolf`;
    const description = (c.description ?? `Slope ${c.slope ?? "—"}, Course Rating ${c.rating ?? "—"}, ${c.holes} holes, par ${c.par} at ${club.name}.`).slice(0, 300);
    document.title = title;
    setMeta("description", description);
    setMeta("og:title", title, "property");
    setMeta("og:description", description, "property");
    setMeta("og:type", "website", "property");
    if (c.heroImageUrl) setMeta("og:image", c.heroImageUrl, "property");
    setMeta("twitter:card", "summary_large_image");

    setLinkRel("canonical", `${window.location.origin}/clubs/${club.slug}/courses/${c.slug}`);

    const ratingValue = data.reviewSummary.averageRating;
    setJsonLd("course", {
      "@context": "https://schema.org",
      "@type": ["GolfCourse", "SportsActivityLocation"],
      name: c.name,
      description: c.description ?? undefined,
      image: c.heroImageUrl ?? undefined,
      address: club.address ?? c.location ?? undefined,
      telephone: c.contactPhone ?? club.contactPhone ?? undefined,
      url: `${window.location.origin}/clubs/${club.slug}/courses/${c.slug}`,
      geo: c.latitude && c.longitude ? {
        "@type": "GeoCoordinates",
        latitude: c.latitude,
        longitude: c.longitude,
      } : undefined,
      numberOfHoles: c.holes,
      additionalProperty: [
        c.par != null ? { "@type": "PropertyValue", name: "Par", value: c.par } : null,
        c.rating != null ? { "@type": "PropertyValue", name: "Course Rating", value: c.rating } : null,
        c.slope != null ? { "@type": "PropertyValue", name: "Slope", value: c.slope } : null,
        c.yardage != null ? { "@type": "PropertyValue", name: "Yardage", value: c.yardage } : null,
        c.designer ? { "@type": "PropertyValue", name: "Designer", value: c.designer } : null,
        c.yearOpened ? { "@type": "PropertyValue", name: "Year Opened", value: c.yearOpened } : null,
      ].filter(Boolean),
      aggregateRating: ratingValue != null && data.reviewSummary.totalReviews > 0 ? {
        "@type": "AggregateRating",
        ratingValue: Number(ratingValue.toFixed(1)),
        reviewCount: data.reviewSummary.totalReviews,
        bestRating: 5,
        worstRating: 1,
      } : undefined,
      review: data.reviewSummary.recent.slice(0, 5).map(r => ({
        "@type": "Review",
        reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5 },
        author: { "@type": "Person", name: r.displayMode === "anonymous" ? "Anonymous" : (r.reviewerDisplayName ?? "Anonymous") },
        reviewBody: r.body ?? undefined,
        name: r.title ?? undefined,
        datePublished: r.createdAt,
      })),
    });
  }, [data]);

  // Only show the full-screen spinner on the *initial* fetch. Background
  // refreshes (e.g. after a visitor submits a photo and we re-pull the
  // course payload) must NOT blank the page — doing so unmounts child
  // components like PhotoSubmissionForm and wipes their local success
  // state, so the visitor never sees the "Thanks for sharing!" panel.
  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <Loader2 className="animate-spin text-emerald-700" size={32} />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-stone-50 p-6 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Course not found</h1>
        <p className="text-gray-600 mb-6">{error ?? "We couldn't find that course."}</p>
        <Link href="/" className="text-emerald-700 underline">← Back home</Link>
      </div>
    );
  }

  const { club, course, holes, photos, reviewSummary, teeTimeUrl } = data;
  // Gallery shows every approved course photo — including those tagged
  // to a specific hole — so visitors can browse the full visual story
  // of the course. Hole-tagged photos still appear as a thumbnail next
  // to their hole row in the table above.
  const galleryPhotos = photos;

  return (
    <div className="min-h-screen bg-stone-50 text-gray-900">
      {/* ── Breadcrumb ─────────────────────────────────────────────── */}
      <nav aria-label="Breadcrumb" className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 text-sm text-gray-600 flex items-center gap-2 flex-wrap">
          <Link href="/" className="hover:text-emerald-700">KharaGolf</Link>
          <span>/</span>
          <Link href={`/clubs/${club.slug}`} className="hover:text-emerald-700">{club.name}</Link>
          <span>/</span>
          <span className="text-gray-900 font-medium">{course.name}</span>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <header className="relative bg-emerald-900 text-white overflow-hidden">
        {course.heroImageUrl && (
          <img
            src={course.heroImageUrl}
            alt={`${course.name} signature view`}
            className="absolute inset-0 w-full h-full object-cover opacity-50"
            loading="eager"
          />
        )}
        <div className="relative max-w-6xl mx-auto px-4 py-16 md:py-24">
          <Link href={`/clubs/${club.slug}`} className="inline-flex items-center gap-1 text-sm text-emerald-100 hover:text-white mb-4">
            <ChevronLeft size={16} /> Back to {club.name}
          </Link>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-3">{course.name}</h1>
          {course.location && (
            <p className="flex items-center gap-2 text-emerald-100 text-lg">
              <MapPin size={18} /> {course.location}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4 mt-6">
            {reviewSummary.averageRating != null && reviewSummary.totalReviews > 0 && (
              <div className="flex items-center gap-2 bg-black/30 backdrop-blur-sm px-3 py-2 rounded-lg">
                <StarRow value={reviewSummary.averageRating} />
                <span className="font-semibold">{reviewSummary.averageRating.toFixed(1)}</span>
                <span className="text-emerald-100 text-sm">({reviewSummary.totalReviews} review{reviewSummary.totalReviews === 1 ? "" : "s"})</span>
              </div>
            )}
            <a
              href={teeTimeUrl}
              className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-black font-semibold px-5 py-3 rounded-lg shadow-md transition"
              data-testid="cta-book-tee-time"
            >
              <Calendar size={18} /> Book a tee time <ArrowRight size={16} />
            </a>
          </div>
        </div>
      </header>

      {/* ── Stats strip ─────────────────────────────────────────────── */}
      <section className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
          <Stat label="Holes" value={course.holes} />
          <Stat label="Par" value={course.par} />
          <Stat label="Course Rating" value={course.rating ?? "—"} />
          <Stat label="Slope" value={course.slope ?? "—"} />
          <Stat label="Yardage" value={course.yardage ? course.yardage.toLocaleString() : "—"} />
        </div>
      </section>

      {/* ── About + Sidebar ─────────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-4 py-10 grid md:grid-cols-3 gap-8">
        <div className="md:col-span-2">
          <h2 className="text-2xl font-semibold mb-4">About the course</h2>
          {course.description ? (
            <div className="prose max-w-none text-gray-700">
              {course.description.split(/\n\s*\n/).map((p, i) => (
                <p key={i} className="mb-4 leading-relaxed whitespace-pre-line">{p}</p>
              ))}
            </div>
          ) : (
            <p className="text-gray-500 italic">The club hasn't added a description yet.</p>
          )}

          {course.awards.length > 0 && (
            <div className="mt-8">
              <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <Trophy size={18} className="text-amber-500" /> Recognition
              </h3>
              <ul className="space-y-2">
                {course.awards.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-gray-700">
                    <span className="text-amber-500 mt-1">•</span> {a}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside className="md:col-span-1 space-y-3 text-sm">
          <div className="bg-white border rounded-lg p-5 shadow-sm">
            <h3 className="font-semibold text-gray-900 mb-3">Course details</h3>
            <dl className="space-y-2 text-gray-700">
              {course.designer && <Detail label="Designer" value={course.designer} />}
              {course.yearOpened && <Detail label="Year opened" value={String(course.yearOpened)} />}
              {course.contactPhone && (
                <Detail
                  label="Phone"
                  value={<a href={`tel:${course.contactPhone}`} className="text-emerald-700 hover:underline inline-flex items-center gap-1"><Phone size={12} />{course.contactPhone}</a>}
                />
              )}
              {course.contactEmail && (
                <Detail
                  label="Email"
                  value={<a href={`mailto:${course.contactEmail}`} className="text-emerald-700 hover:underline inline-flex items-center gap-1"><Mail size={12} />{course.contactEmail}</a>}
                />
              )}
            </dl>
          </div>

          <CourseMapPreview
            latitude={course.latitude}
            longitude={course.longitude}
            courseName={course.name}
          />
        </aside>
      </section>

      {/* ── Hole-by-hole ────────────────────────────────────────────── */}
      {holes.length > 0 && (
        <section className="bg-white border-y">
          <div className="max-w-6xl mx-auto px-4 py-10">
            <h2 className="text-2xl font-semibold mb-6 flex items-center gap-2">
              <Flag size={22} className="text-emerald-700" /> Hole by hole
            </h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-stone-100 text-gray-700">
                  <tr>
                    <th className="px-3 py-2 text-left">Hole</th>
                    <th className="px-3 py-2 text-left">Par</th>
                    <th className="px-3 py-2 text-left">HCP</th>
                    <th className="px-3 py-2 text-left">Blue</th>
                    <th className="px-3 py-2 text-left">White</th>
                    <th className="px-3 py-2 text-left">Red</th>
                    <th className="px-3 py-2 text-left">Photo</th>
                  </tr>
                </thead>
                <tbody>
                  {holes.map(h => (
                    <tr
                      key={h.holeNumber}
                      className="border-t hover:bg-stone-50 cursor-pointer"
                      onClick={() => setActiveHole(h)}
                      data-testid={`hole-row-${h.holeNumber}`}
                    >
                      <td className="px-3 py-2 font-semibold">{h.holeNumber}</td>
                      <td className="px-3 py-2">{h.par}</td>
                      <td className="px-3 py-2">{h.handicap ?? "—"}</td>
                      <td className="px-3 py-2">{h.yardageBlue ?? "—"}</td>
                      <td className="px-3 py-2">{h.yardageWhite ?? "—"}</td>
                      <td className="px-3 py-2">{h.yardageRed ?? "—"}</td>
                      <td className="px-3 py-2">
                        {h.photoUrl ? (
                          <img src={h.photoUrl} alt={`Hole ${h.holeNumber}`} className="w-14 h-10 object-cover rounded" loading="lazy" />
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── Hole modal ───────────────────────────────────────────────── */}
      {activeHole && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setActiveHole(null)}
        >
          <div className="bg-white rounded-lg max-w-xl w-full overflow-hidden" onClick={e => e.stopPropagation()}>
            {activeHole.photoUrl && (
              <img src={activeHole.photoUrl} alt={`Hole ${activeHole.holeNumber}`} className="w-full max-h-80 object-cover" />
            )}
            <div className="p-5">
              <h3 className="text-xl font-semibold mb-2">Hole {activeHole.holeNumber} — Par {activeHole.par}</h3>
              <p className="text-sm text-gray-600 mb-3">
                Blue {activeHole.yardageBlue ?? "—"}y · White {activeHole.yardageWhite ?? "—"}y · Red {activeHole.yardageRed ?? "—"}y
                {activeHole.handicap != null && ` · HCP ${activeHole.handicap}`}
              </p>
              {activeHole.description && <p className="text-gray-700 leading-relaxed">{activeHole.description}</p>}
              <button
                onClick={() => setActiveHole(null)}
                className="mt-4 text-sm text-emerald-700 hover:underline"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Photo gallery ───────────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <Camera size={22} className="text-emerald-700" /> Course gallery
          </h2>
        </div>
        {galleryPhotos.length > 0 ? (
          <div
            className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
            data-testid="course-gallery"
          >
            {galleryPhotos.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setLightboxIndex(i)}
                className="relative group rounded-lg overflow-hidden bg-gray-200 aspect-[4/3] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                data-testid={`gallery-photo-${p.id}`}
                aria-label={`Open photo${p.caption ? `: ${p.caption}` : ""}`}
              >
                <img
                  src={p.thumbnailUrl ?? p.url}
                  alt={p.caption ?? `${course.name} photo`}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  loading="lazy"
                />
                {(p.caption || p.uploaderName) && (
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent text-white text-xs p-2 text-left">
                    {p.caption}{p.uploaderName ? ` — ${p.uploaderName}` : ""}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 italic mb-6">No photos yet — be the first to share one of your favourite views.</p>
        )}

        <div className="mt-8">
          <PhotoSubmissionForm
            clubSlug={club.slug}
            courseSlug={course.slug}
            holes={holes.map(h => h.holeNumber)}
            onSubmitted={load}
          />
        </div>
      </section>

      {/* ── Gallery lightbox ────────────────────────────────────────── */}
      {lightboxIndex !== null && galleryPhotos[lightboxIndex] && (
        <GalleryLightbox
          photos={galleryPhotos}
          index={lightboxIndex}
          courseName={course.name}
          onClose={() => setLightboxIndex(null)}
          onNavigate={(next) => setLightboxIndex(next)}
        />
      )}

      {/* ── Reviews ─────────────────────────────────────────────────── */}
      <section className="bg-white border-y">
        <div className="max-w-6xl mx-auto px-4 py-10">
          <div className="flex items-end justify-between mb-6 flex-wrap gap-3">
            <div>
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Star size={22} className="text-amber-500" /> Player reviews
              </h2>
              {reviewSummary.totalReviews > 0 && reviewSummary.averageRating != null && (
                <p className="text-gray-600 mt-1">
                  Averaging <strong>{reviewSummary.averageRating.toFixed(1)}/5</strong> across {reviewSummary.totalReviews} verified review{reviewSummary.totalReviews === 1 ? "" : "s"}.
                </p>
              )}
            </div>
          </div>

          {reviewSummary.recent.length === 0 ? (
            <p className="text-gray-500 italic mb-6">No reviews yet — be the first to share your round.</p>
          ) : (
            <ul className="space-y-4 mb-8">
              {reviewSummary.recent.map(r => (
                <li key={r.id} className="border rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <StarRow value={r.rating} size={14} />
                    <span className="text-sm text-gray-600">
                      {r.displayMode === "anonymous" ? "Anonymous golfer" : (r.reviewerDisplayName ?? "A KharaGolf player")} · {formatDate(r.createdAt)}
                    </span>
                  </div>
                  {r.title && <h3 className="font-semibold text-gray-900">{r.title}</h3>}
                  {r.body && <p className="text-gray-700 mt-1 whitespace-pre-line">{r.body}</p>}
                  {r.adminReply && (
                    <div
                      className="mt-3 ml-4 border-l-4 border-emerald-500 bg-emerald-50 p-3 rounded"
                      data-testid={`admin-reply-${r.id}`}
                    >
                      <p className="text-xs font-semibold text-emerald-800">
                        Reply from {club.name}
                        {r.adminReplyAt && ` · ${formatDate(r.adminReplyAt)}`}
                      </p>
                      <p className="text-sm text-gray-800 mt-1 whitespace-pre-line">{r.adminReply}</p>
                    </div>
                  )}
                  <button
                    onClick={async () => {
                      const reason = window.prompt("Tell us why you're flagging this review:");
                      if (!reason) return;
                      const res = await fetch(`/api/public/course-reviews/${r.id}/report`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ reason }),
                      });
                      alert(res.ok ? "Thanks — our moderators will review it." : "Couldn't submit your report. Try again later.");
                    }}
                    className="text-xs text-gray-500 hover:text-red-600 mt-2"
                  >
                    Report this review
                  </button>
                </li>
              ))}
            </ul>
          )}

          <ReviewForm clubSlug={club.slug} courseSlug={course.slug} onSubmitted={load} />
        </div>
      </section>

      {/* ── Bottom CTA ──────────────────────────────────────────────── */}
      <section className="bg-emerald-900 text-white">
        <div className="max-w-6xl mx-auto px-4 py-12 text-center">
          <h2 className="text-3xl font-bold mb-3">Ready to play {course.name}?</h2>
          <p className="text-emerald-100 mb-6">Book your tee time directly through KharaGolf.</p>
          <a
            href={teeTimeUrl}
            className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-black font-semibold px-6 py-3 rounded-lg shadow-md"
          >
            <Calendar size={18} /> Book now <ArrowRight size={16} />
          </a>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-2xl md:text-3xl font-bold text-emerald-800">{value}</div>
      <div className="text-xs uppercase tracking-wide text-gray-500 mt-1">{label}</div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

/**
 * Task #1939 — Small embedded map preview shown on the public course page
 * when the API returns lat/lng for the course (which since Task #1558 also
 * covers the mapper-centre fallback). Uses OpenStreetMap's static embed
 * iframe so we don't pull in Leaflet just for a thumbnail. Renders nothing
 * when either coordinate is missing or unparsable, mirroring how the admin
 * "Located near …" line on the courses list hides itself.
 */
function CourseMapPreview({
  latitude,
  longitude,
  courseName,
}: {
  latitude: string | null;
  longitude: string | null;
  courseName: string;
}) {
  if (!latitude || !longitude) return null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // ~0.01° ≈ 1.1km of padding around the marker so the pin sits in the
  // middle of the tile rather than at the edge of the bbox.
  const delta = 0.01;
  const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;
  const embedSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
  const osmHref = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
  return (
    <div className="bg-white border rounded-lg p-5 shadow-sm" data-testid="course-map-preview">
      <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
        <MapPin size={16} className="text-emerald-700" /> Where it is
      </h3>
      <iframe
        src={embedSrc}
        title={`Map showing the location of ${courseName}`}
        className="w-full h-48 rounded border border-gray-200"
        loading="lazy"
        data-testid="course-map-iframe"
      />
      <a
        href={osmHref}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline mt-2"
        data-testid="course-map-osm-link"
      >
        <MapPin size={12} /> View on OpenStreetMap
      </a>
    </div>
  );
}

function GalleryLightbox({
  photos, index, courseName, onClose, onNavigate,
}: {
  photos: CoursePhoto[];
  index: number;
  courseName: string;
  onClose: () => void;
  onNavigate: (next: number) => void;
}) {
  const photo = photos[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onNavigate(index - 1);
      else if (e.key === "ArrowRight" && index < photos.length - 1) onNavigate(index + 1);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [index, photos.length, onClose, onNavigate]);

  if (!photo) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="gallery-lightbox"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white p-2"
        aria-label="Close"
        data-testid="lightbox-close"
      >
        <X size={28} />
      </button>
      {index > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
          className="absolute left-4 md:left-8 text-white/80 hover:text-white p-2 bg-black/40 rounded-full"
          aria-label="Previous photo"
          data-testid="lightbox-prev"
        >
          <ChevronLeft size={28} />
        </button>
      )}
      {index < photos.length - 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }}
          className="absolute right-4 md:right-8 text-white/80 hover:text-white p-2 bg-black/40 rounded-full"
          aria-label="Next photo"
          data-testid="lightbox-next"
        >
          <ChevronRight size={28} />
        </button>
      )}
      <figure
        className="max-w-5xl max-h-full flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={photo.url}
          alt={photo.caption ?? `${courseName} photo`}
          className="max-h-[80vh] w-auto object-contain rounded shadow-lg"
        />
        <figcaption className="text-white/90 text-sm mt-3 text-center">
          {photo.caption}
          {photo.uploaderName && (
            <span className="block text-white/60 text-xs mt-1">Photo by {photo.uploaderName}</span>
          )}
          <span className="block text-white/50 text-xs mt-1">
            {index + 1} / {photos.length}
          </span>
        </figcaption>
      </figure>
    </div>
  );
}

function PhotoSubmissionForm({
  clubSlug, courseSlug, holes, onSubmitted,
}: {
  clubSlug: string;
  courseSlug: string;
  holes: number[];
  onSubmitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [holeNumber, setHoleNumber] = useState<string>("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setFile(null); setCaption(""); setHoleNumber(""); setName("");
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) { setError("Please choose a photo to upload."); return; }
    if (file.size > 10 * 1024 * 1024) { setError("Photo must be 10 MB or smaller."); return; }
    setSubmitting(true); setError(null);
    try {
      // 1. Get a signed upload URL
      const urlRes = await fetch(
        `/api/public/clubs/${encodeURIComponent(clubSlug)}/courses/${encodeURIComponent(courseSlug)}/photos/upload-url`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: file.type, size: file.size }),
        },
      );
      if (!urlRes.ok) {
        const j = await urlRes.json().catch(() => ({}));
        throw new Error(j.error ?? `Upload URL failed (HTTP ${urlRes.status})`);
      }
      const { uploadURL, objectPath, uploadToken } =
        (await urlRes.json()) as { uploadURL: string; objectPath: string; uploadToken: string };

      // 2. PUT the file to the signed URL
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) throw new Error(`Upload failed (HTTP ${putRes.status})`);

      // 3. Finalise — register the media row in the moderation queue
      const finRes = await fetch(
        `/api/public/clubs/${encodeURIComponent(clubSlug)}/courses/${encodeURIComponent(courseSlug)}/photos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            objectPath,
            uploadToken,
            caption: caption || null,
            holeNumber: holeNumber || null,
            uploaderName: name || null,
          }),
        },
      );
      if (!finRes.ok) {
        const j = await finRes.json().catch(() => ({}));
        throw new Error(j.error ?? `Submission failed (HTTP ${finRes.status})`);
      }
      setSuccess(true);
      reset();
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); setSuccess(false); }}
        className="inline-flex items-center gap-2 border border-emerald-700 text-emerald-700 hover:bg-emerald-50 font-semibold px-4 py-2 rounded-lg"
        data-testid="button-open-photo-submit"
      >
        <Upload size={16} /> Submit a photo
      </button>
    );
  }

  if (success) {
    return (
      <div className="border rounded-lg p-5 bg-emerald-50 text-emerald-900" data-testid="photo-submit-success">
        <p className="font-semibold mb-1">Thanks for sharing!</p>
        <p className="text-sm">Your photo is in our moderation queue and will appear here once a club admin approves it.</p>
        <div className="mt-3 flex gap-3">
          <button className="text-sm underline" onClick={() => setSuccess(false)}>Submit another</button>
          <button className="text-sm text-gray-600 underline" onClick={() => { setSuccess(false); setOpen(false); }}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="border rounded-lg p-5 bg-stone-50"
      data-testid="form-submit-photo"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Upload size={16} /> Share a photo of this course
        </h3>
        <button
          type="button"
          onClick={() => { setOpen(false); reset(); }}
          className="text-gray-500 hover:text-gray-800"
          aria-label="Close form"
        >
          <X size={18} />
        </button>
      </div>

      <div className="mb-3">
        <label className="block text-sm text-gray-700 mb-1">Photo (JPEG, PNG, GIF or WebP — max 10 MB)</label>
        <input
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm"
          data-testid="input-photo-file"
        />
      </div>

      <div className="grid md:grid-cols-2 gap-3 mb-3">
        <input
          type="text"
          placeholder="Your name (shown alongside the photo)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border rounded px-3 py-2 text-sm"
          data-testid="input-photo-name"
          maxLength={80}
        />
        <select
          value={holeNumber}
          onChange={(e) => setHoleNumber(e.target.value)}
          className="border rounded px-3 py-2 text-sm bg-white"
          data-testid="select-photo-hole"
        >
          <option value="">No specific hole</option>
          {holes.map((h) => (
            <option key={h} value={h}>Hole {h}</option>
          ))}
        </select>
      </div>

      <input
        type="text"
        placeholder="Caption (optional)"
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        className="w-full border rounded px-3 py-2 text-sm mb-3"
        maxLength={500}
        data-testid="input-photo-caption"
      />

      {error && <p className="text-sm text-red-600 mb-2" role="alert">{error}</p>}

      <button
        type="submit"
        disabled={submitting || !file}
        className="bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white font-semibold px-5 py-2 rounded inline-flex items-center gap-2"
        data-testid="button-submit-photo"
      >
        {submitting ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
        {submitting ? "Uploading…" : "Submit for review"}
      </button>
      <p className="text-xs text-gray-500 mt-2">Photos are moderated before they appear on the course page.</p>
    </form>
  );
}

function ReviewForm({ clubSlug, courseSlug, onSubmitted }: { clubSlug: string; courseSlug: string; onSubmitted: () => void }) {
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [displayMode, setDisplayMode] = useState<"public" | "anonymous">("public");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      const res = await fetch(`/api/public/clubs/${encodeURIComponent(clubSlug)}/courses/${encodeURIComponent(courseSlug)}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating, title: title || null, body: body || null,
          reviewerDisplayName: name || null, reviewerEmail: email || null,
          displayMode,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setSuccess(true);
      setTitle(""); setBody(""); setName(""); setEmail(""); setRating(5);
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="border rounded-lg p-5 bg-emerald-50 text-emerald-900">
        <p className="font-semibold mb-1">Thanks for your review!</p>
        <p className="text-sm">It's awaiting moderation and will appear on this page once approved.</p>
        <button className="text-sm underline mt-2" onClick={() => setSuccess(false)}>Submit another</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="border rounded-lg p-5 bg-stone-50">
      <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
        <Pencil size={16} /> Write a review
      </h3>
      <div className="mb-3">
        <label className="block text-sm text-gray-700 mb-1">Your rating</label>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map(v => (
            <button
              type="button"
              key={v}
              onClick={() => setRating(v)}
              className="p-1"
              aria-label={`${v} stars`}
              data-testid={`rating-${v}`}
            >
              <Star size={24} className={v <= rating ? "text-amber-400 fill-amber-400" : "text-gray-300"} />
            </button>
          ))}
        </div>
      </div>
      <div className="grid md:grid-cols-2 gap-3 mb-3">
        <input
          type="text" placeholder="Your name" required value={name}
          onChange={e => setName(e.target.value)}
          className="border rounded px-3 py-2 text-sm"
          data-testid="input-reviewer-name"
        />
        <input
          type="email" placeholder="Your email (kept private)" required value={email}
          onChange={e => setEmail(e.target.value)}
          className="border rounded px-3 py-2 text-sm"
          data-testid="input-reviewer-email"
        />
      </div>
      <input
        type="text" placeholder="Title (optional)" value={title}
        onChange={e => setTitle(e.target.value)}
        className="w-full border rounded px-3 py-2 text-sm mb-3"
      />
      <textarea
        placeholder="Share your experience…" value={body}
        onChange={e => setBody(e.target.value)}
        rows={4}
        className="w-full border rounded px-3 py-2 text-sm mb-3"
        data-testid="input-review-body"
      />
      <label className="flex items-center gap-2 text-sm text-gray-700 mb-3">
        <input
          type="checkbox" checked={displayMode === "anonymous"}
          onChange={e => setDisplayMode(e.target.checked ? "anonymous" : "public")}
        />
        Post anonymously (your name won't be shown)
      </label>
      {error && <p className="text-sm text-red-600 mb-2" role="alert">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white font-semibold px-5 py-2 rounded"
        data-testid="button-submit-review"
      >
        {submitting ? "Submitting…" : "Submit review"}
      </button>
      <p className="text-xs text-gray-500 mt-2">All reviews are moderated before publishing.</p>
    </form>
  );
}
