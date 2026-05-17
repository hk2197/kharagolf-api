/**
 * Task #1442 — unit coverage for the badge-OG language bundle
 * (`src/lib/badgeOgI18n.ts`).
 *
 * The mobile share button and the website both append `?lang=<viewer-lang>`
 * to the badge OG image URL. The OG endpoint must:
 *
 *   1. Recognise every supported mobile language (21 codes) and ignore
 *      unknown / loose region tags by falling back to English.
 *   2. Provide non-empty translations for every chrome string used by the
 *      SVG (`BADGE UNLOCKED`, `ALMOST THERE`, `Earned X · @handle`,
 *      `X of Y`, `Keep playing to unlock`).
 *   3. Preserve every `{{var}}` placeholder so the SVG generator's
 *      interpolation step never leaves a literal `{{date}}` / `{{handle}}`
 *      in the rendered card.
 *
 * Pure unit test — no DB / HTTP setup.
 */
import { describe, it, expect } from "vitest";
import {
  BADGE_OG_LANGS,
  normalizeBadgeOgLang,
  getBadgeOgStrings,
  interpolateBadgeOg,
} from "../lib/badgeOgI18n.js";

const REQUIRED_KEYS = [
  "badgeUnlocked", "almostThere", "earnedOn", "xOfY", "keepPlaying",
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

describe("badgeOgI18n bundle", () => {
  it("includes all 21 mobile-supported languages", () => {
    expect(BADGE_OG_LANGS).toHaveLength(21);
    for (const c of ["en", "hi", "ar", "zh", "ja", "ko", "pt", "es", "fr", "de"]) {
      expect(BADGE_OG_LANGS).toContain(c as (typeof BADGE_OG_LANGS)[number]);
    }
  });

  it("every locale has every required key, with placeholders matching English", () => {
    const en = getBadgeOgStrings("en");
    for (const lang of BADGE_OG_LANGS) {
      const b = getBadgeOgStrings(lang);
      for (const key of REQUIRED_KEYS) {
        const v = b[key];
        expect(typeof v).toBe("string");
        expect(v.length, `${lang}.${key} should not be empty`).toBeGreaterThan(0);
        const enPh = placeholdersOf(en[key]);
        const localePh = placeholdersOf(v);
        expect(
          setsEqual(enPh, localePh),
          `${lang}.${key} placeholders should match English: en={${[...enPh].join(",")}} vs ${lang}={${[...localePh].join(",")}}`,
        ).toBe(true);
      }
    }
  });
});

describe("normalizeBadgeOgLang", () => {
  it("returns supported codes unchanged", () => {
    expect(normalizeBadgeOgLang("hi")).toBe("hi");
    expect(normalizeBadgeOgLang("ar")).toBe("ar");
    expect(normalizeBadgeOgLang("EN")).toBe("en");
  });
  it("strips region/script subtags", () => {
    expect(normalizeBadgeOgLang("pt-BR")).toBe("pt");
    expect(normalizeBadgeOgLang("zh-Hant-TW")).toBe("zh");
  });
  it("falls back to English on unknown / empty input", () => {
    expect(normalizeBadgeOgLang(null)).toBe("en");
    expect(normalizeBadgeOgLang("")).toBe("en");
    expect(normalizeBadgeOgLang("xx")).toBe("en");
    expect(normalizeBadgeOgLang(undefined)).toBe("en");
  });
});

describe("interpolateBadgeOg", () => {
  it("interpolates date and handle into the unlocked-card earned line", () => {
    const tpl = getBadgeOgStrings("en").earnedOn;
    const out = interpolateBadgeOg(tpl, { date: "August 1, 2025", handle: "tigerw" });
    expect(out).toBe("Earned August 1, 2025 · @tigerw");
    // No literal placeholders left over.
    expect(out).not.toMatch(/\{\{/);
  });
  it("interpolates current/target into the locked-card progress hint", () => {
    const tpl = getBadgeOgStrings("hi").xOfY;
    const out = interpolateBadgeOg(tpl, { current: 4, target: 10 });
    expect(out).toContain("4");
    expect(out).toContain("10");
    expect(out).not.toMatch(/\{\{/);
  });
  it("treats missing vars as empty so the SVG never embeds a literal placeholder", () => {
    expect(interpolateBadgeOg("Hello {{a}}{{b}}", { a: "X" })).toBe("Hello X");
  });
});

describe("translations are not English fallbacks", () => {
  // Spot-check non-Latin locales — ensures the bundle isn't silently
  // pointing at the English string for these scripts.
  it("Hindi badgeUnlocked uses Devanagari", () => {
    expect(getBadgeOgStrings("hi").badgeUnlocked).toMatch(/[\u0900-\u097F]/);
  });
  it("Arabic almostThere uses Arabic script", () => {
    expect(getBadgeOgStrings("ar").almostThere).toMatch(/[\u0600-\u06FF]/);
  });
  it("Chinese keepPlaying uses CJK", () => {
    expect(getBadgeOgStrings("zh").keepPlaying).toMatch(/[\u4E00-\u9FFF]/);
  });
  it("Japanese earnedOn uses Hiragana/Katakana/CJK", () => {
    expect(getBadgeOgStrings("ja").earnedOn).toMatch(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/);
  });
});
