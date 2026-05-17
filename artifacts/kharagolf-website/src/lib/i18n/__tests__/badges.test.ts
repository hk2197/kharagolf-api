/**
 * Task #1442 — unit coverage for the public-badge i18n bundle.
 *
 * Pins three contracts that other surfaces rely on:
 *   1. Every supported language has a complete bundle whose `{{var}}`
 *      placeholders match the English source — translators occasionally
 *      drop `{{url}}` from share strings, which would silently break the
 *      mobile share flow when forwarded through the website's tBadge.
 *   2. `resolvePageLang` accepts the same primary-tag inputs we expect
 *      from `?lang=` URLs and from `navigator.language` (e.g. "pt-BR").
 *   3. `interpolate` is faithful to `{{var}}` substitution and treats
 *      missing vars as empty strings (so unused share params don't leak
 *      `{{url}}` literally into the share text).
 */
import { describe, it, expect } from "vitest";
import {
  SUPPORTED_BADGE_LANGS,
  RTL_BADGE_LANGS,
  normalizeBadgeLang,
  getBadgeStrings,
  interpolate,
  tBadge,
  resolvePageLang,
} from "../badges";

const REQUIRED_KEYS = [
  "shareTitle", "shareMessageUnlocked", "shareMessageLocked", "shareMessageLockedProgress",
  "pageTitleUnlocked", "pageTitleLocked", "metaDescUnlocked", "metaDescLocked", "progressInline",
  "badgeUnlocked", "almostThere", "earnedOn", "progressLabel", "xOfY", "keepPlaying",
  "shareThisBadge", "shareYourProgress", "shareDescUnlocked", "shareDescLocked",
  "copyShareLink", "linkCopied", "shareNative",
  "notFoundTitle", "notFoundDesc", "viewProfile", "backTo", "footer",
] as const;

function placeholdersOf(s: string): Set<string> {
  const set = new Set<string>();
  const re = /\{\{\s*(\w+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) set.add(m[1]!);
  return set;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

describe("badge i18n bundle integrity", () => {
  it("includes the 21 mobile-supported languages", () => {
    expect(SUPPORTED_BADGE_LANGS).toContain("en");
    expect(SUPPORTED_BADGE_LANGS).toContain("hi");
    expect(SUPPORTED_BADGE_LANGS).toContain("ar");
    expect(SUPPORTED_BADGE_LANGS).toHaveLength(21);
  });

  it("marks Arabic as the only RTL language in the badge bundle", () => {
    expect(RTL_BADGE_LANGS.has("ar")).toBe(true);
    expect(RTL_BADGE_LANGS.has("en")).toBe(false);
    expect(RTL_BADGE_LANGS.has("hi")).toBe(false);
  });

  it("every locale defines every required key (no missing translations)", () => {
    const en = getBadgeStrings("en");
    for (const lang of SUPPORTED_BADGE_LANGS) {
      const bundle = getBadgeStrings(lang);
      for (const key of REQUIRED_KEYS) {
        const v = bundle[key];
        expect(typeof v, `${lang}.${key} should be a string`).toBe("string");
        expect(v.length, `${lang}.${key} should not be empty`).toBeGreaterThan(0);
        // Placeholder sets must match English exactly.
        const enPh = placeholdersOf(en[key]);
        const localePh = placeholdersOf(v);
        expect(
          setsEqual(enPh, localePh),
          `${lang}.${key} placeholders should match English: en={${[...enPh].join(",")}} vs ${lang}={${[...localePh].join(",")}}`,
        ).toBe(true);
      }
    }
  });

  it("share-message keys all preserve {{url}}, {{label}} and {{icon}}", () => {
    // The mobile share button ships these strings verbatim through the OS
    // share sheet — losing `{{url}}` would silently break the share link.
    for (const lang of SUPPORTED_BADGE_LANGS) {
      const b = getBadgeStrings(lang);
      for (const key of ["shareMessageUnlocked", "shareMessageLocked", "shareMessageLockedProgress"] as const) {
        const ph = placeholdersOf(b[key]);
        expect(ph.has("url"), `${lang}.${key} missing {{url}}`).toBe(true);
        expect(ph.has("label"), `${lang}.${key} missing {{label}}`).toBe(true);
        expect(ph.has("icon"), `${lang}.${key} missing {{icon}}`).toBe(true);
      }
      const lp = placeholdersOf(b.shareMessageLockedProgress);
      expect(lp.has("current"), `${lang}.shareMessageLockedProgress missing {{current}}`).toBe(true);
      expect(lp.has("target"), `${lang}.shareMessageLockedProgress missing {{target}}`).toBe(true);
    }
  });
});

describe("normalizeBadgeLang", () => {
  it("returns supported codes unchanged", () => {
    expect(normalizeBadgeLang("hi")).toBe("hi");
    expect(normalizeBadgeLang("ar")).toBe("ar");
  });
  it("strips region/script subtags to the primary code", () => {
    expect(normalizeBadgeLang("pt-BR")).toBe("pt");
    expect(normalizeBadgeLang("zh-Hant-TW")).toBe("zh");
    expect(normalizeBadgeLang("ja_JP")).toBe("ja");
  });
  it("uppercase / surrounding whitespace is tolerated", () => {
    expect(normalizeBadgeLang("  HI  ")).toBe("hi");
    expect(normalizeBadgeLang("EN-US")).toBe("en");
  });
  it("falls back to default for unknown / empty / null", () => {
    expect(normalizeBadgeLang(null)).toBe("en");
    expect(normalizeBadgeLang("")).toBe("en");
    expect(normalizeBadgeLang("xx")).toBe("en");
    expect(normalizeBadgeLang(undefined, "hi")).toBe("hi");
  });
});

describe("interpolate / tBadge", () => {
  it("substitutes {{var}} tokens", () => {
    expect(interpolate("Hello {{name}}!", { name: "Tiger" })).toBe("Hello Tiger!");
  });
  it("treats missing vars as empty string (never leaves a literal {{x}})", () => {
    expect(interpolate("X={{a}} Y={{b}}", { a: "1" })).toBe("X=1 Y=");
  });
  it("coerces numbers", () => {
    expect(interpolate("{{x}}/{{y}}", { x: 3, y: 10 })).toBe("3/10");
  });
  it("renders the Hindi shareTitle with handle and label", () => {
    const out = tBadge("hi", "shareTitle", { label: "First Birdie", handle: "tigerw" });
    expect(out).toContain("First Birdie");
    expect(out).toContain("tigerw");
    expect(out).toContain("KHARAGOLF");
    // Confirms the Hindi shareTitle uses Devanagari ("पर") rather than the
    // English template — guards against accidentally pointing the bundle at
    // the English value.
    expect(out).toMatch(/[\u0900-\u097F]/);
  });
  it("renders Arabic 'almost there' chip in Arabic script", () => {
    const out = tBadge("ar", "almostThere");
    expect(out).toMatch(/[\u0600-\u06FF]/);
  });
});

describe("resolvePageLang", () => {
  it("prefers the ?lang= query param when present", () => {
    expect(resolvePageLang("?lang=hi")).toBe("hi");
    expect(resolvePageLang("?foo=1&lang=ar&bar=2")).toBe("ar");
  });
  it("normalises region tags from the query", () => {
    expect(resolvePageLang("?lang=pt-BR")).toBe("pt");
  });
  it("falls back to default when query is empty / missing", () => {
    // navigator is undefined in node test env, so should fall through to "en".
    expect(resolvePageLang(null)).toBe("en");
    expect(resolvePageLang("")).toBe("en");
    expect(resolvePageLang("?lang=xx")).toBe("en");
  });
});
