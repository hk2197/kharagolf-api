/**
 * Task #2204 — unit coverage for the locale-aware SEO helpers.
 *
 * Pins the visible behaviours the marketing pages depend on:
 *   1. `applySeo` writes localised <title>, <meta description>,
 *      og:title/description and twitter:title/description tags to the
 *      head when called with translated strings.
 *   2. Passing `lang` emits an `og:locale` tag (using the BCP47
 *      language_TERRITORY mapping) so social previews advertise the
 *      right language.
 *   3. Passing `alternates` emits one `<link rel="alternate"
 *      hreflang>` per supported lang plus an `x-default` entry, with
 *      URLs that point at `?lang=<code>` versions of the canonical.
 *      A subsequent `applySeo` call with different alternates replaces
 *      the previous set rather than appending forever.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { applySeo, buildAlternateUrl } from "../seo";

beforeEach(() => {
  document.head.innerHTML = "";
  document.title = "";
});

function getMeta(attr: "name" | "property", key: string): string | null {
  return (
    document.head
      .querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
      ?.getAttribute("content") ?? null
  );
}

function getHreflangs(): { hreflang: string; href: string }[] {
  return Array.from(
    document.head.querySelectorAll<HTMLLinkElement>(
      'link[rel="alternate"][hreflang]',
    ),
  ).map(el => ({
    hreflang: el.getAttribute("hreflang") ?? "",
    href: el.getAttribute("href") ?? "",
  }));
}

describe("applySeo", () => {
  it("writes the localised title and description into the head", () => {
    applySeo({
      title: "Precios de KHARAGOLF",
      description: "Precios transparentes para clubes de golf.",
      canonical: "https://kharagolf.test/pricing",
      lang: "es",
    });
    expect(document.title).toBe("Precios de KHARAGOLF");
    expect(getMeta("name", "description")).toBe(
      "Precios transparentes para clubes de golf.",
    );
    expect(getMeta("property", "og:title")).toBe("Precios de KHARAGOLF");
    expect(getMeta("property", "og:description")).toBe(
      "Precios transparentes para clubes de golf.",
    );
    expect(getMeta("name", "twitter:title")).toBe("Precios de KHARAGOLF");
    expect(getMeta("name", "twitter:description")).toBe(
      "Precios transparentes para clubes de golf.",
    );
  });

  it("emits og:locale matching the requested lang", () => {
    applySeo({
      title: "أسعار KHARAGOLF",
      description: "أسعار شفّافة لنوادي الغولف.",
      canonical: "https://kharagolf.test/pricing",
      lang: "ar",
    });
    expect(getMeta("property", "og:locale")).toBe("ar_AE");

    applySeo({
      title: "KHARAGOLF Pricing",
      description: "Transparent pricing for golf clubs.",
      canonical: "https://kharagolf.test/pricing",
      lang: "en",
    });
    expect(getMeta("property", "og:locale")).toBe("en_US");
  });

  it("emits one hreflang link per supplied lang plus x-default", () => {
    applySeo({
      title: "Home",
      description: "Welcome.",
      canonical: "https://kharagolf.test/",
      lang: "en",
      alternates: { langs: ["en", "es", "hi", "ar"], defaultLang: "en" },
    });
    const tags = getHreflangs();
    expect(tags).toEqual([
      { hreflang: "en", href: "https://kharagolf.test/?lang=en" },
      { hreflang: "es", href: "https://kharagolf.test/?lang=es" },
      { hreflang: "hi", href: "https://kharagolf.test/?lang=hi" },
      { hreflang: "ar", href: "https://kharagolf.test/?lang=ar" },
      { hreflang: "x-default", href: "https://kharagolf.test/" },
    ]);
  });

  it("replaces hreflang alternates on subsequent calls instead of appending", () => {
    applySeo({
      title: "First",
      description: "First.",
      canonical: "https://kharagolf.test/",
      alternates: { langs: ["en", "es"], defaultLang: "en" },
    });
    expect(getHreflangs()).toHaveLength(3);

    applySeo({
      title: "Second",
      description: "Second.",
      canonical: "https://kharagolf.test/pricing",
      alternates: { langs: ["en", "hi", "ar"], defaultLang: "en" },
    });
    const tags = getHreflangs();
    expect(tags.map(t => t.hreflang)).toEqual(["en", "hi", "ar", "x-default"]);
    expect(tags[0].href).toBe("https://kharagolf.test/pricing?lang=en");
    expect(tags[3].href).toBe("https://kharagolf.test/pricing");
  });

  it("strips a stale ?lang= from the canonical when building alternates", () => {
    applySeo({
      title: "Home",
      description: "Welcome.",
      canonical: "https://kharagolf.test/?lang=ar",
      alternates: { langs: ["en", "es"], defaultLang: "en" },
    });
    const tags = getHreflangs();
    expect(tags.find(t => t.hreflang === "es")?.href).toBe(
      "https://kharagolf.test/?lang=es",
    );
    expect(tags.find(t => t.hreflang === "x-default")?.href).toBe(
      "https://kharagolf.test/",
    );
  });

  it("skips og:locale and hreflang tags when lang/alternates are omitted", () => {
    applySeo({
      title: "Plain",
      description: "Plain.",
      canonical: "https://kharagolf.test/plain",
    });
    expect(getMeta("property", "og:locale")).toBeNull();
    expect(getHreflangs()).toEqual([]);
  });

  it("clears stale og:locale and hreflang tags when a subsequent call omits them", () => {
    // First page: localised + alternates.
    applySeo({
      title: "Localised",
      description: "Localised.",
      canonical: "https://kharagolf.test/",
      lang: "es",
      alternates: { langs: ["en", "es"], defaultLang: "en" },
    });
    expect(getMeta("property", "og:locale")).toBe("es_ES");
    expect(getHreflangs()).toHaveLength(3);

    // Second page on the same SPA navigation: no lang, no alternates.
    // Without cleanup, social previews would lie about the language and
    // the SERP entry would still advertise stale alternates.
    applySeo({
      title: "Plain",
      description: "Plain.",
      canonical: "https://kharagolf.test/plain",
    });
    expect(getMeta("property", "og:locale")).toBeNull();
    expect(getHreflangs()).toEqual([]);
  });
});

describe("buildAlternateUrl", () => {
  it("appends ?lang=<code> for a language", () => {
    expect(buildAlternateUrl("https://kharagolf.test/pricing", "es")).toBe(
      "https://kharagolf.test/pricing?lang=es",
    );
  });

  it("returns the bare canonical for x-default", () => {
    expect(
      buildAlternateUrl("https://kharagolf.test/pricing?lang=es", "x-default"),
    ).toBe("https://kharagolf.test/pricing");
  });

  it("preserves other query params", () => {
    expect(
      buildAlternateUrl("https://kharagolf.test/pricing?ref=email", "hi"),
    ).toBe("https://kharagolf.test/pricing?ref=email&lang=hi");
  });
});
