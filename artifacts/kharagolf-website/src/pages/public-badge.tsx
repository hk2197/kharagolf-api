/**
 * Task #780 — Public, shareable single-badge landing page at
 * /p/<handle>/badge/<type>. Renders a hero card matching the server-rendered
 * Open Graph image so the destination of a share link still feels celebratory
 * for humans who click through. Sets og:image meta to the API-rendered PNG
 * (see Task #925 — switched from SVG so Facebook/Instagram/LinkedIn link
 * previewers reliably accept and display the artwork).
 *
 * Task #924 — Locked badges are now also shareable. When the player has not
 * yet unlocked the requested badge but has progress toward it (or the badge is
 * simply visible in the public catalog), we render an "almost there" variant
 * that shows the X-of-Y progress hint and matches the locked OG card.
 *
 * Task #1442 — The page now picks up the viewer's language from the URL
 * (`?lang=xx`), falling back to `navigator.language`, then English. The
 * mobile share button appends the sender's current language so the on-page
 * hero, share copy, dynamically-set OG title/description, and the
 * server-rendered OG image (also `?lang`-aware) all agree with the share
 * message a Hindi/Arabic/etc. player just sent. Translation key names mirror
 * the mobile `profile.json` `badges` block where possible.
 */
import { useEffect, useMemo, useState } from "react";
import { useRoute, Link, useSearch } from "wouter";
import { Loader2, Share2, Copy, Check, ArrowLeft, Award, Lock } from "lucide-react";
import {
  normalizeBadgeLang,
  tBadge,
  RTL_BADGE_LANGS,
  type BadgeLang,
} from "@/lib/i18n/badges";
import { useLocale } from "@/lib/i18n";

interface BadgePageData {
  handle: string;
  displayName: string;
  unlocked: boolean;
  badge: {
    type: string;
    label: string;
    icon: string;
    description: string;
    category: string;
    earnedAt: string | null;
  };
  progress: { current: number; target: number } | null;
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

export default function PublicBadgePage() {
  const [, params] = useRoute<{ handle: string; type: string }>("/p/:handle/badge/:type");
  const search = useSearch();
  const handle = params?.handle?.toLowerCase();
  const type = params?.type;

  // Task #1442 + Task #1765 — viewer language. The page-level rule is:
  //   1. `?lang=` URL query param (explicit override). The mobile share
  //      button appends `?lang=<sender>` so a Hindi player's WhatsApp link
  //      always renders the destination card in Hindi regardless of the
  //      recipient's browser/site preference. This must keep working so OG
  //      previews in chat apps stay correct.
  //   2. Otherwise, the visitor's site-wide locale (set via the header
  //      switcher and persisted to localStorage by the LocaleProvider).
  //
  // We push the resolved lang into the LocaleProvider with `persist: false`
  // so the provider stays the single source of truth for `<html lang>`/`dir`
  // (avoiding a race where parent + child effects both write to <html>),
  // while making sure the recipient's site preference isn't quietly
  // overwritten just because they clicked an Arabic share link.
  const { lang: siteLang, setLang: setSiteLang } = useLocale();
  const explicitLang = useMemo(() => {
    try { return new URLSearchParams(`?${search}`).get("lang"); } catch { return null; }
  }, [search]);
  const lang: BadgeLang = useMemo(
    () => (explicitLang ? normalizeBadgeLang(explicitLang, siteLang) : siteLang),
    [explicitLang, siteLang],
  );
  const isRtl = RTL_BADGE_LANGS.has(lang);

  const [data, setData] = useState<BadgePageData | null>(null);
  const [error, setError] = useState<"not-found" | "error" | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!handle || !type) return;
    setLoading(true);
    // Task #1752 — append `?lang=<viewer>` so the API returns the
    // badge `label`/`description` already translated for the viewer's
    // language. We use the resolved page language (URL `?lang` →
    // navigator.language → English) so a Hindi player who taps a share
    // link sees Hindi badge copy on the destination card.
    const url = `/api/public/p/${encodeURIComponent(handle)}?lang=${encodeURIComponent(lang)}`;
    fetch(url)
      .then(async r => {
        if (r.status === 404) { setError("not-found"); return null; }
        if (!r.ok) { setError("error"); return null; }
        return r.json();
      })
      .then((j: {
        handle: string;
        displayName: string;
        privacy: { showAchievements: boolean };
        achievements: Array<{ badgeType: string; badgeLabel: string; badgeIcon: string; badgeCategory: string; badgeDescription: string | null; earnedAt: string }>;
        badgeCatalog?: Array<{ type: string; label: string; icon: string; description: string; category: string }>;
        badgeProgress?: Record<string, { current: number; target: number }>;
      } | null) => {
        if (!j) return;
        if (!j.privacy.showAchievements) { setError("not-found"); return; }
        const earned = j.achievements.find(a => a.badgeType === type);
        const cat = j.badgeCatalog?.find(b => b.type === type);
        // Need at least the catalog entry — otherwise the badge type is
        // unknown and we can't render anything meaningful.
        if (!earned && !cat) { setError("not-found"); return; }
        const progressRaw = j.badgeProgress?.[type as string];
        const progress = progressRaw
          ? { current: Math.min(progressRaw.current, progressRaw.target), target: progressRaw.target }
          : null;
        setData({
          handle: j.handle,
          displayName: j.displayName,
          unlocked: !!earned,
          badge: {
            type: type as string,
            label: earned?.badgeLabel || cat?.label || (type as string),
            icon: earned?.badgeIcon || cat?.icon || "🏅",
            description: earned?.badgeDescription || cat?.description || "",
            category: earned?.badgeCategory || cat?.category || "",
            earnedAt: earned?.earnedAt ?? null,
          },
          progress,
        });
      })
      .catch(() => setError("error"))
      .finally(() => setLoading(false));
    // Task #1752 — `lang` is included so that switching the viewer's
    // language client-side re-fetches with the new `?lang=` and refreshes
    // the localised badge label/description.
  }, [handle, type, lang]);

  // Task #1442 + Task #1765 — when `?lang=` overrides the site preference,
  // push the override into the LocaleProvider as a transient (non-persisted)
  // change. The provider's own effect then handles `<html lang>`/`dir`,
  // which avoids a parent/child useEffect race over the document attributes.
  // On unmount we restore the visitor's previous site preference so leaving
  // the badge page doesn't strand them in the sender's language.
  useEffect(() => {
    if (!explicitLang) return;
    const normalized = normalizeBadgeLang(explicitLang, siteLang);
    if (normalized === siteLang) return;
    const previous = siteLang;
    setSiteLang(normalized, { persist: false });
    return () => {
      setSiteLang(previous, { persist: false });
    };
    // We intentionally exclude `siteLang` from deps: the effect should fire
    // when the URL `?lang=` (explicitLang) changes, not every time the
    // provider's lang updates as a result of our own setSiteLang call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explicitLang]);

  // Task #1798 — fire one badge-visit telemetry event per (handle, badge)
  // the visitor lands on, so the Badge Share Leaderboard can compute a
  // real "shares → visits" conversion rate.
  useEffect(() => {
    if (!data) return;
    try {
      void fetch(
        `/api/public/p/${encodeURIComponent(data.handle)}/badge/${encodeURIComponent(data.badge.type)}/visit-event`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "web" }),
          keepalive: true,
        },
      ).catch(() => { /* analytics only */ });
    } catch { /* ignore */ }
  }, [data?.handle, data?.badge.type]);

  // Task #2176 — Append the sender's resolved site language (not just the
  // explicit `?lang=` URL override) to share URLs and the og:image meta. The
  // mobile share button (badges.tsx) already does this, so the previewer card
  // a Hindi/Arabic/etc. player's recipient sees matches the language the
  // sender is browsing in. We only emit `?lang=` for non-English so existing
  // English share URLs stay byte-identical and previously cached OG PNGs
  // remain hits.
  const shareLangQuery = lang !== "en" ? `?lang=${encodeURIComponent(lang)}` : "";

  useEffect(() => {
    if (!data) return;
    const url = `${window.location.origin}/p/${data.handle}/badge/${data.badge.type}${shareLangQuery}`;
    // Task #1442 + Task #2176 — propagate the viewer language to the OG image
    // renderer so the social-card SVG ("BADGE UNLOCKED" / "ALMOST THERE"
    // chrome, "X of Y" hint, and the badge label/description themselves via
    // localizeBadge) matches the page language. We append the query whenever
    // the resolved page language is non-English — covering both the explicit
    // `?lang=` URL override and the visitor's site-wide locale preference.
    const ogImage = `${window.location.origin}/api/public/p/${data.handle}/badge/${encodeURIComponent(data.badge.type)}/og${shareLangQuery}`;
    const progressTxt = data.progress
      ? tBadge(lang, "progressInline", { current: data.progress.current, target: data.progress.target })
      : "";
    const title = data.unlocked
      ? tBadge(lang, "pageTitleUnlocked", { name: data.displayName, label: data.badge.label })
      : tBadge(lang, "pageTitleLocked", { name: data.displayName, label: data.badge.label, progress: progressTxt });
    const desc = data.unlocked
      ? tBadge(lang, "metaDescUnlocked", { name: data.displayName, label: data.badge.label, icon: data.badge.icon, description: data.badge.description })
      : tBadge(lang, "metaDescLocked", { name: data.displayName, label: data.badge.label, icon: data.badge.icon, progress: progressTxt, description: data.badge.description });
    document.title = title;
    setMeta("description", desc);
    setMeta("og:type", "article", "property");
    setMeta("og:title", title, "property");
    setMeta("og:description", desc, "property");
    setMeta("og:url", url, "property");
    setMeta("og:image", ogImage, "property");
    setMeta("og:image:width", "1200", "property");
    setMeta("og:image:height", "630", "property");
    setMeta("og:locale", lang, "property");
    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:title", title);
    setMeta("twitter:description", desc);
    setMeta("twitter:image", ogImage);
  }, [data, lang, explicitLang]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (error === "not-found" || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center" dir={isRtl ? "rtl" : "ltr"}>
        <h1 className="text-2xl font-semibold mb-2">{tBadge(lang, "notFoundTitle")}</h1>
        <p className="text-muted-foreground mb-6">{tBadge(lang, "notFoundDesc")}</p>
        {handle && (
          <Link href={`/p/${handle}`} className="text-emerald-700 underline">
            {tBadge(lang, "viewProfile", { handle })}
          </Link>
        )}
      </div>
    );
  }

  // Task #2176 — The share URL carries the sender's resolved language so
  // recipients (and link previewers) get the OG card and on-page copy in the
  // same language the sender is reading. Covers both an explicit `?lang=`
  // override and the visitor's site-wide locale preference.
  const shareUrl = `${window.location.origin}/p/${data.handle}/badge/${data.badge.type}${shareLangQuery}`;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const pct = data.progress && data.progress.target > 0
    ? Math.max(0, Math.min(100, Math.round((data.progress.current / data.progress.target) * 100)))
    : 0;
  const earnedDateText = data.badge.earnedAt
    ? tBadge(lang, "earnedOn", {
        date: new Date(data.badge.earnedAt).toLocaleDateString(lang, { year: "numeric", month: "long", day: "numeric" }),
        handle: data.handle,
      })
    : "";

  // Task #1798 — fire a single visit-tracking event per page view so the
  // Badge Share Leaderboard can compute a real "shares → visits" conversion
  // rate per badge. Best-effort: never blocks rendering if the POST fails,
  // and uses `keepalive` so a quick close-tab still gets the event out.
  // We only fire once we have `data` (i.e. the badge resolved against the
  // public profile catalog) so we don't record visits for 404s, hidden
  // achievements, or unknown badge types — those would already 404 the
  // POST endpoint, but skipping the request entirely keeps the network
  // panel clean and avoids unnecessary rate-limit churn.

  function trackShare(method: "copy" | "web_share" | "native_share") {
    try {
      void fetch(`/api/public/p/${encodeURIComponent(data!.handle)}/badge/${encodeURIComponent(data!.badge.type)}/share-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, source: "web" }),
        keepalive: true,
      }).catch(() => { /* analytics only */ });
    } catch { /* ignore */ }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      trackShare("copy");
    } catch { /* ignore */ }
  }
  async function nativeShare() {
    const title = tBadge(lang, "shareTitle", { label: data!.badge.label, handle: data!.handle });
    // The shared mobile keys embed `{{url}}` so the same string can be sent
    // verbatim through the OS share sheet. The Web Share API takes the URL
    // separately, so we substitute an empty string for the URL token here
    // and trim trailing whitespace to avoid a dangling space.
    let text: string;
    if (data!.unlocked) {
      text = tBadge(lang, "shareMessageUnlocked", { label: data!.badge.label, icon: data!.badge.icon, url: "" });
    } else if (data!.progress) {
      text = tBadge(lang, "shareMessageLockedProgress", {
        label: data!.badge.label,
        icon: data!.badge.icon,
        current: data!.progress.current,
        target: data!.progress.target,
        url: "",
      });
    } else {
      text = tBadge(lang, "shareMessageLocked", { label: data!.badge.label, icon: data!.badge.icon, url: "" });
    }
    try {
      await navigator.share({ title, text: text.trim(), url: shareUrl });
      trackShare("native_share");
    } catch { /* user cancelled */ }
  }

  return (
    <div className="min-h-screen bg-stone-50 text-gray-900" dir={isRtl ? "rtl" : "ltr"} data-lang={lang}>
      <header className="px-6 py-4 border-b bg-white flex items-center justify-between">
        <Link href="/" className="font-semibold tracking-tight">KHARAGOLF</Link>
        <Link href={`/p/${data.handle}`} className="text-sm text-emerald-700 inline-flex items-center gap-1 hover:underline" data-testid="back-to-profile">
          <ArrowLeft className="w-4 h-4" />{tBadge(lang, "backTo", { handle: data.handle })}
        </Link>
      </header>

      {data.unlocked ? (
        <section className="bg-gradient-to-br from-emerald-800 to-emerald-950 text-white px-6 py-14">
          <div className="max-w-2xl mx-auto text-center" data-testid="badge-hero">
            <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.3em] text-amber-300 uppercase mb-6">
              <Award className="w-4 h-4" />{tBadge(lang, "badgeUnlocked")}
            </div>
            <div
              className="mx-auto w-44 h-44 rounded-full bg-emerald-950 border-4 border-amber-300 flex items-center justify-center shadow-2xl"
              data-testid="badge-icon"
            >
              <span className="text-7xl leading-none" aria-hidden>{data.badge.icon}</span>
            </div>
            <h1 className="mt-6 text-4xl font-bold" data-testid="badge-label">{data.badge.label}</h1>
            {data.badge.description && (
              <p className="mt-3 text-emerald-100/90 max-w-md mx-auto">{data.badge.description}</p>
            )}
            <div className="mt-6 text-amber-200 font-semibold" data-testid="badge-player-name">{data.displayName}</div>
            {earnedDateText && (
              <div className="text-sm text-emerald-200/90 mt-1" data-testid="badge-earned-at">
                {earnedDateText}
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="bg-gradient-to-br from-slate-800 to-slate-950 text-white px-6 py-14">
          <div className="max-w-2xl mx-auto text-center" data-testid="badge-hero">
            <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.3em] text-amber-300 uppercase mb-6">
              <Lock className="w-4 h-4" />{tBadge(lang, "almostThere")}
            </div>
            <div
              className="mx-auto w-44 h-44 rounded-full bg-slate-950 border-4 border-dashed border-slate-400 flex items-center justify-center shadow-2xl"
              data-testid="badge-icon"
            >
              <span className="text-7xl leading-none opacity-60" aria-hidden>{data.badge.icon}</span>
            </div>
            <h1 className="mt-6 text-4xl font-bold" data-testid="badge-label">{data.badge.label}</h1>
            {data.badge.description && (
              <p className="mt-3 text-slate-200/90 max-w-md mx-auto">{data.badge.description}</p>
            )}
            {data.progress ? (
              <div className="mt-6 max-w-md mx-auto" data-testid="badge-progress">
                <div className="flex items-center justify-between text-sm font-semibold text-amber-200 mb-1.5">
                  <span>{tBadge(lang, "progressLabel")}</span>
                  <span data-testid="badge-progress-text">
                    {tBadge(lang, "xOfY", { current: data.progress.current, target: data.progress.target })}
                  </span>
                </div>
                <div className="h-3 rounded-full bg-slate-700 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-400 to-amber-300"
                    style={{ width: `${pct}%` }}
                    data-testid="badge-progress-bar"
                    role="progressbar"
                    aria-valuenow={data.progress.current}
                    aria-valuemin={0}
                    aria-valuemax={data.progress.target}
                  />
                </div>
              </div>
            ) : (
              <p className="mt-6 text-amber-200 font-semibold" data-testid="badge-progress-locked">
                {tBadge(lang, "keepPlaying")}
              </p>
            )}
            <div className="mt-6 text-amber-200 font-semibold" data-testid="badge-player-name">{data.displayName}</div>
            <div className="text-sm text-slate-300/90 mt-1">@{data.handle}</div>
          </div>
        </section>
      )}

      <main className="max-w-2xl mx-auto px-6 py-10">
        <div className="bg-white border rounded-xl p-6 text-center">
          <h2 className="font-semibold text-lg mb-2">
            {data.unlocked ? tBadge(lang, "shareThisBadge") : tBadge(lang, "shareYourProgress")}
          </h2>
          <p className="text-sm text-muted-foreground mb-5">
            {data.unlocked ? tBadge(lang, "shareDescUnlocked") : tBadge(lang, "shareDescLocked")}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={copyLink}
              data-testid="badge-page-copy"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-gray-900 text-white text-sm hover:opacity-90"
            >
              {copied ? <><Check className="w-4 h-4" />{tBadge(lang, "linkCopied")}</> : <><Copy className="w-4 h-4" />{tBadge(lang, "copyShareLink")}</>}
            </button>
            {canShare && (
              <button
                type="button"
                onClick={nativeShare}
                data-testid="badge-page-native-share"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md border border-emerald-600 text-emerald-700 text-sm hover:bg-emerald-50"
              >
                <Share2 className="w-4 h-4" />{tBadge(lang, "shareNative")}
              </button>
            )}
          </div>
          <div className="mt-4 text-xs text-muted-foreground break-all">{shareUrl}</div>
        </div>
      </main>

      <footer className="px-6 py-8 border-t text-center text-xs text-muted-foreground bg-white">
        {tBadge(lang, "footer", { year: new Date().getFullYear() })}
      </footer>
    </div>
  );
}
