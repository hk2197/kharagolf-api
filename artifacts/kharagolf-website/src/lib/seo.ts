/**
 * Lightweight SEO helpers for the marketing site (Task #382).
 *
 * Task #2204 — Localised page metadata.
 *   The `<html lang>` attribute already flips with the user's selected
 *   language (Task #1765). This file adds the matching support for the
 *   `<title>`, `<meta name="description">`, Open Graph and Twitter card
 *   metadata so search engines and social previews advertise the right
 *   language. Pages pass localised `title`/`description` strings and an
 *   optional `lang` (so we can emit `og:locale`) plus `alternates` (so
 *   we can emit `<link rel="alternate" hreflang="...">` tags pointing at
 *   `?lang=xx` versions of the same path).
 *
 * The site is a single-page React app — these utilities update the
 * document `<head>` from page components so each route gets correct
 * title / description / Open Graph / canonical / hreflang / JSON-LD tags.
 */
import type { SiteLang } from "./i18n/site";

export type SeoAlternates = {
  /**
   * Languages to advertise in `<link rel="alternate" hreflang>` tags.
   * Each language gets a tag pointing at `?lang=<code>` on the same path.
   */
  langs: readonly SiteLang[];
  /**
   * Optional default language for the `x-default` hreflang entry. The
   * `x-default` tag points at the canonical URL (no `?lang=` query) so
   * search engines route uncategorised visitors to the site's default.
   */
  defaultLang?: SiteLang;
};

export type SeoOptions = {
  title: string;
  description: string;
  canonical?: string;
  image?: string;
  type?: "website" | "article" | "product";
  /**
   * Active page language (BCP47 base, e.g. "en", "es"). Drives the
   * `og:locale` meta tag. The `<html lang>` attribute is owned by the
   * `LocaleProvider` so we deliberately don't touch it here.
   */
  lang?: SiteLang;
  /** See {@link SeoAlternates}. */
  alternates?: SeoAlternates;
};

const SITE_NAME = "KHARAGOLF";
const DEFAULT_IMAGE = "/opengraph.jpg";

/**
 * Map a `SiteLang` (BCP47 base code) to a best-effort `og:locale` value.
 * Open Graph specifies `language_TERRITORY` (e.g. `en_US`); platforms
 * tolerate the bare language code but a full `xx_XX` is preferred. We
 * pick conventional defaults — pages can override per-locale later if a
 * club explicitly markets to a non-default territory.
 */
const OG_LOCALE_MAP: Record<SiteLang, string> = {
  af: "af_ZA",
  am: "am_ET",
  ar: "ar_AE",
  de: "de_DE",
  en: "en_US",
  es: "es_ES",
  fil: "fil_PH",
  fr: "fr_FR",
  ha: "ha_NG",
  hi: "hi_IN",
  id: "id_ID",
  ja: "ja_JP",
  ko: "ko_KR",
  ms: "ms_MY",
  pt: "pt_PT",
  sw: "sw_KE",
  th: "th_TH",
  vi: "vi_VN",
  yo: "yo_NG",
  zh: "zh_CN",
  zu: "zu_ZA",
};

function setMeta(attr: "name" | "property", key: string, value: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", value);
}

function setLink(rel: string, href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

/**
 * Build the URL for an hreflang alternate. Strips any existing
 * `?lang=` from the canonical, then appends the requested language as a
 * query parameter (or returns the bare canonical for `x-default`).
 */
export function buildAlternateUrl(canonical: string, lang: SiteLang | "x-default"): string {
  let url: URL;
  try {
    url = new URL(canonical);
  } catch {
    return canonical;
  }
  url.searchParams.delete("lang");
  if (lang === "x-default") {
    return url.toString().replace(/\?$/, "");
  }
  url.searchParams.set("lang", lang);
  return url.toString();
}

/** Remove every previously injected hreflang alternate. */
function clearHreflangAlternates(): void {
  document.head
    .querySelectorAll('link[data-seo-hreflang="kharagolf"]')
    .forEach(el => el.remove());
}

/**
 * Replace any existing hreflang alternates with the supplied set. We
 * tag the elements with `data-seo-hreflang="kharagolf"` so calls to
 * `applySeo` from a different page cleanly remove the previous page's
 * alternates rather than appending forever.
 */
function applyHreflangAlternates(canonical: string, alternates: SeoAlternates): void {
  clearHreflangAlternates();
  for (const lang of alternates.langs) {
    const link = document.createElement("link");
    link.setAttribute("rel", "alternate");
    link.setAttribute("hreflang", lang);
    link.setAttribute("href", buildAlternateUrl(canonical, lang));
    link.setAttribute("data-seo-hreflang", "kharagolf");
    document.head.appendChild(link);
  }
  if (alternates.defaultLang) {
    const link = document.createElement("link");
    link.setAttribute("rel", "alternate");
    link.setAttribute("hreflang", "x-default");
    link.setAttribute("href", buildAlternateUrl(canonical, "x-default"));
    link.setAttribute("data-seo-hreflang", "kharagolf");
    document.head.appendChild(link);
  }
}

function removeMeta(attr: "name" | "property", key: string): void {
  document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)?.remove();
}

export function applySeo(opts: SeoOptions): void {
  if (typeof document === "undefined") return;
  document.title = opts.title;
  setMeta("name", "description", opts.description);
  setMeta("property", "og:title", opts.title);
  setMeta("property", "og:description", opts.description);
  setMeta("property", "og:type", opts.type ?? "website");
  setMeta("property", "og:site_name", SITE_NAME);
  setMeta("property", "og:image", opts.image ?? DEFAULT_IMAGE);
  // Set or clear `og:locale` so navigating from a localised page to a
  // page that doesn't pass `lang` doesn't leave a stale locale tag in
  // the head — social previews would otherwise lie about the language.
  if (opts.lang) {
    setMeta("property", "og:locale", OG_LOCALE_MAP[opts.lang] ?? opts.lang);
  } else {
    removeMeta("property", "og:locale");
  }
  setMeta("name", "twitter:card", "summary_large_image");
  setMeta("name", "twitter:title", opts.title);
  setMeta("name", "twitter:description", opts.description);
  setMeta("name", "twitter:image", opts.image ?? DEFAULT_IMAGE);

  const canonical = opts.canonical ?? (typeof window !== "undefined" ? window.location.href.split("#")[0] : "");
  if (canonical) {
    setLink("canonical", canonical);
    setMeta("property", "og:url", canonical);
  }
  // Same residue concern as `og:locale` — always reconcile hreflang
  // alternates so the previous page's set is replaced (or cleared) when
  // the new page omits `alternates`.
  if (opts.alternates && opts.alternates.langs.length > 0 && canonical) {
    applyHreflangAlternates(canonical, opts.alternates);
  } else {
    clearHreflangAlternates();
  }
}

/**
 * Inject one or more JSON-LD blocks into the head. We tag them with a
 * common id prefix so navigation can replace them cleanly.
 */
export function applyJsonLd(blocks: Record<string, unknown>[]): void {
  if (typeof document === "undefined") return;
  // Remove previously injected blocks
  document.head.querySelectorAll('script[data-seo="kharagolf"]').forEach(el => el.remove());
  for (const block of blocks) {
    const s = document.createElement("script");
    s.type = "application/ld+json";
    s.setAttribute("data-seo", "kharagolf");
    s.text = JSON.stringify(block);
    document.head.appendChild(s);
  }
}
