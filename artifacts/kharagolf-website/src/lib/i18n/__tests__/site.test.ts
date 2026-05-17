/**
 * Task #1765 — unit coverage for the site-wide i18n bundle and the
 * `resolveInitialLang` precedence helper.
 *
 * Pins three contracts:
 *   1. Every fully-translated locale defines the same key set as English
 *      AND uses the same `{{var}}` placeholders. (A translator dropping
 *      `{{year}}` from `footer.copyright` would silently render an empty
 *      year in production.)
 *   2. `getSiteString` falls back per-key to English for partially
 *      translated locales rather than returning the literal key name.
 *   3. `resolveInitialLang` honours: explicit override → stored
 *      preference → browser → English. The badge page relies on the
 *      explicit override winning (Task #1442 OG previews).
 */
import { describe, it, expect } from "vitest";
import {
  FULLY_TRANSLATED_SITE_LANGS,
  RTL_SITE_LANGS,
  SITE_BUNDLES,
  SITE_KEYS,
  SITE_LANG_LABELS,
  SUPPORTED_SITE_LANGS,
  getSiteString,
} from "../site";
import { resolveInitialLang } from "../index";

function placeholdersOf(s: string): Set<string> {
  const set = new Set<string>();
  const re = /\{\{\s*(\w+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) set.add(m[1]!);
  return set;
}

describe("SUPPORTED_SITE_LANGS", () => {
  it("includes English and several non-English locales", () => {
    expect(SUPPORTED_SITE_LANGS).toContain("en");
    expect(SUPPORTED_SITE_LANGS).toContain("es");
    expect(SUPPORTED_SITE_LANGS.length).toBeGreaterThanOrEqual(10);
  });

  it("has a label for every supported lang", () => {
    for (const lang of SUPPORTED_SITE_LANGS) {
      expect(SITE_LANG_LABELS[lang]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("marks Arabic as RTL", () => {
    expect(RTL_SITE_LANGS.has("ar")).toBe(true);
    expect(RTL_SITE_LANGS.has("en")).toBe(false);
    expect(RTL_SITE_LANGS.has("hi")).toBe(false);
  });
});

describe("fully-translated bundles", () => {
  for (const lang of FULLY_TRANSLATED_SITE_LANGS) {
    it(`${lang} defines every site key`, () => {
      const bundle = SITE_BUNDLES[lang]!;
      expect(bundle).toBeTruthy();
      for (const key of SITE_KEYS) {
        expect(bundle[key], `${lang} missing "${key}"`).toBeTypeOf("string");
        expect(bundle[key].length, `${lang} empty "${key}"`).toBeGreaterThan(0);
      }
    });

    it(`${lang} preserves every {{var}} placeholder from English`, () => {
      const bundle = SITE_BUNDLES[lang]!;
      const en = SITE_BUNDLES.en!;
      for (const key of SITE_KEYS) {
        const expected = placeholdersOf(en[key]);
        const actual = placeholdersOf(bundle[key]);
        expect(actual, `${lang}/${key} placeholders`).toEqual(expected);
      }
    });
  }
});

describe("Task #2202 home + demo + cookies coverage", () => {
  // Pin the new key surface added by Task #2202 so a future refactor that
  // accidentally drops a key (and therefore silently regresses to English
  // for hi/ar/es visitors via the per-key fallback) gets flagged here
  // instead of in production.
  const NEW_KEYS = [
    "home.testimonials.title",
    "home.testimonials.t1.quote",
    "home.testimonials.t2.quote",
    "home.testimonials.t3.quote",
    "home.testimonials.readCaseStudy",
    "home.modules.tournament.title",
    "home.modules.handicap.title",
    "home.modules.leaderboards.title",
    "home.modules.league.title",
    "home.modules.sponsorship.title",
    "home.modules.comms.title",
    "home.modules.proshop.title",
    "home.modules.analytics.title",
    "home.howItWorks.step1.title",
    "home.howItWorks.step2.title",
    "home.howItWorks.step3.title",
    "home.demo.title",
    "home.demo.subtitle",
    "home.demo.formHeading",
    "demoBooking.calendarHeading",
    "demoBooking.selected",
    "demoBooking.confirmed.note",
    "cookies.title",
    "cookies.body",
    "cookies.button.accept",
  ] as const;

  it("declares every Task #2202 key in SITE_KEYS", () => {
    for (const key of NEW_KEYS) {
      expect(SITE_KEYS, `SITE_KEYS missing "${key}"`).toContain(key);
    }
  });

  it("translates every Task #2202 key in es/hi/ar (no English bleed-through)", () => {
    for (const lang of ["es", "hi", "ar"] as const) {
      for (const key of NEW_KEYS) {
        const translated = getSiteString(lang, key);
        const english = getSiteString("en", key);
        expect(translated.length, `${lang}/${key} empty`).toBeGreaterThan(0);
        // Pure punctuation/placeholder-only strings would equal English; none
        // of the new keys fall in that bucket.
        expect(translated, `${lang}/${key} not localised`).not.toBe(english);
      }
    }
  });

  it("preserves the {{when}} and {{email}} placeholders in DemoBooking", () => {
    for (const lang of ["es", "hi", "ar"] as const) {
      expect(getSiteString(lang, "demoBooking.selected")).toContain("{{when}}");
      expect(getSiteString(lang, "demoBooking.confirmed.note")).toContain("{{email}}");
    }
  });

  it("preserves the {{link}} placeholder in cookies.body for inline JSX injection", () => {
    for (const lang of ["en", "es", "hi", "ar"] as const) {
      expect(getSiteString(lang, "cookies.body")).toContain("{{link}}");
    }
  });

  it("renders Intl date labels in the active locale (DemoBooking weekday/month strings)", () => {
    // Sanity-check the contract DemoBooking depends on: when we pass the
    // active language code into `Intl.DateTimeFormat`, weekday/month labels
    // must come back in that language rather than English. This guards
    // against a regression where someone re-introduces a hardcoded `en-GB`
    // formatter and silently leaks English weekday names to es/hi/ar
    // visitors on the demo booking widget. Substring checks against
    // "Monday"/"May" would false-positive on Spanish "mayo" so we lean on
    // strict inequality plus a hi/ar script-class check (Devanagari /
    // Arabic) for languages whose alphabets differ from Latin.
    const sample = new Date("2026-05-04T09:00:00Z"); // Monday
    const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" };
    const en = new Intl.DateTimeFormat("en", opts).format(sample);
    expect(en.toLowerCase()).toContain("monday");
    expect(en.toLowerCase()).toContain("may");
    for (const lang of ["es", "hi", "ar"] as const) {
      const localised = new Intl.DateTimeFormat(lang, opts).format(sample);
      expect(localised, `${lang} Intl date label should not equal English`).not.toBe(en);
    }
    expect(new Intl.DateTimeFormat("hi", opts).format(sample), "hi label should contain Devanagari characters").toMatch(/[\u0900-\u097F]/);
    expect(new Intl.DateTimeFormat("ar", opts).format(sample), "ar label should contain Arabic-script characters").toMatch(/[\u0600-\u06FF]/);
  });
});

describe("getSiteString", () => {
  it("returns the translated value when present", () => {
    expect(getSiteString("es", "nav.pricing")).toBe("Precios");
    expect(getSiteString("hi", "nav.home")).toBe("होम");
    expect(getSiteString("ar", "nav.contact")).toBe("تواصل معنا");
  });

  it("falls back to English for locales without a bundle", () => {
    // pt is in SUPPORTED_SITE_LANGS but not in FULLY_TRANSLATED_SITE_LANGS.
    expect(getSiteString("pt", "nav.pricing")).toBe(getSiteString("en", "nav.pricing"));
  });
});

describe("resolveInitialLang", () => {
  it("prefers an explicit override (badge ?lang=)", () => {
    expect(
      resolveInitialLang({ explicit: "ar", stored: "es", browser: "fr-FR" }),
    ).toBe("ar");
    // Explicit "en" wins over stored "es" (the user navigated to ?lang=en
    // for a reason — usually because the original share was English).
    expect(
      resolveInitialLang({ explicit: "en-US", stored: "es", browser: "fr-FR" }),
    ).toBe("en");
  });

  it("ignores explicit values that don't map to a supported lang", () => {
    expect(
      resolveInitialLang({ explicit: "xx-YY", stored: "es", browser: "fr-FR" }),
    ).toBe("es");
  });

  it("falls back to stored when no explicit override", () => {
    expect(resolveInitialLang({ stored: "hi", browser: "fr-FR" })).toBe("hi");
  });

  it("falls back to browser when no stored preference", () => {
    expect(resolveInitialLang({ browser: "pt-BR" })).toBe("pt");
  });

  it("returns English when nothing is provided", () => {
    expect(resolveInitialLang()).toBe("en");
    expect(resolveInitialLang({})).toBe("en");
  });
});
