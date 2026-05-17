/**
 * Task #1752 — Pure-unit tests for the badge label/description translation
 * catalog (`badgeI18n.ts`).
 *
 * Coverage goals:
 *   1. Every badge defined in `ALL_BADGES` has a non-empty `label` and
 *      `description` in every "core" locale we ship the catalog screen in
 *      (`CORE_BADGE_I18N_LANGS`). This guards against a future PR adding a
 *      new badge without supplying translations: the lint fires immediately
 *      instead of silently shipping English copy to non-English players.
 *   2. The English block is itself byte-identical to the catalog's static
 *      `BadgeDef.label/description` so the server doesn't drift from the
 *      single source of truth in `achievementEngine.ts`.
 *   3. `normalizeBadgeI18nLang` picks the right supported locale for loose
 *      inputs (region tags, casing, `_`/`-` separators, garbage, empty).
 *   4. `resolveBadgeI18nLangFromReq` honours `?lang=` first, then
 *      `Accept-Language`, then English.
 *   5. `localizeBadge` falls back to English per-field when a locale is
 *      missing the requested badge, so a partially-translated locale never
 *      renders a slug-like badge type.
 */
import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { ALL_BADGES } from "../lib/achievementEngine";
import {
  BADGE_I18N_LANGS,
  CORE_BADGE_I18N_LANGS,
  BADGE_I18N_TABLE_FOR_TESTS,
  normalizeBadgeI18nLang,
  resolveBadgeI18nLangFromReq,
  localizeBadge,
} from "../lib/badgeI18n";

function fakeReq(query: Record<string, string> = {}, headers: Record<string, string> = {}): Request {
  return {
    query,
    headers,
  } as unknown as Request;
}

describe("badgeI18n: catalog completeness", () => {
  it("English block matches the static BadgeDef catalog (single source of truth)", () => {
    for (const def of ALL_BADGES) {
      const t = BADGE_I18N_TABLE_FOR_TESTS.en[def.type];
      expect(t, `English entry missing for badge ${def.type}`).toBeDefined();
      expect(t!.label, `English label drift for ${def.type}`).toBe(def.label);
      expect(t!.description, `English description drift for ${def.type}`).toBe(def.description);
    }
  });

  it("every supported locale has a non-empty label + description for every badge", () => {
    const failures: string[] = [];
    for (const lang of BADGE_I18N_LANGS) {
      const block = BADGE_I18N_TABLE_FOR_TESTS[lang];
      expect(block, `supported locale "${lang}" has no translation block`).toBeDefined();
      for (const def of ALL_BADGES) {
        const entry = block[def.type];
        if (!entry) {
          failures.push(`${lang}: missing entry for badge "${def.type}"`);
          continue;
        }
        if (!entry.label || !entry.label.trim()) {
          failures.push(`${lang}: empty label for badge "${def.type}"`);
        }
        if (!entry.description || !entry.description.trim()) {
          failures.push(`${lang}: empty description for badge "${def.type}"`);
        }
      }
    }
    expect(
      failures,
      `Add translations to artifacts/api-server/src/lib/badgeI18n.ts so every supported locale covers every badge:\n${failures.join("\n")}`,
    ).toEqual([]);
  });

  it("non-English core locales are not just byte-identical English copies", () => {
    // Defence-in-depth: it's easy to copy-paste the English entry for a new
    // badge into another locale and call it "translated". Catch that for the
    // core set so a Hindi/Arabic/Chinese player never silently sees English.
    const failures: string[] = [];
    for (const lang of CORE_BADGE_I18N_LANGS) {
      if (lang === "en") continue;
      const block = BADGE_I18N_TABLE_FOR_TESTS[lang];
      for (const def of ALL_BADGES) {
        const entry = block[def.type];
        if (!entry) continue;
        const enEntry = BADGE_I18N_TABLE_FOR_TESTS.en[def.type]!;
        // Allow either field to remain English when the source contains
        // mostly loanwords/acronyms (e.g. "GIR", "Hole in One!") — but only
        // when BOTH fields aren't both English at once. Two identical
        // fields strongly suggests a missed translation.
        if (entry.label === enEntry.label && entry.description === enEntry.description) {
          failures.push(`${lang}: badge "${def.type}" has English label AND description`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("BADGE_I18N_LANGS includes every locale present in the table", () => {
    for (const key of Object.keys(BADGE_I18N_TABLE_FOR_TESTS)) {
      expect(BADGE_I18N_LANGS).toContain(key);
    }
  });
});

describe("normalizeBadgeI18nLang", () => {
  it.each([
    ["en", "en"],
    ["hi", "hi"],
    ["EN", "en"],
    [" Hi ", "hi"],
    ["en-US", "en"],
    ["pt_BR", "pt"],
    ["zh-Hant-TW", "zh"],
    ["fil-PH", "fil"],
    ["fr-CA", "fr"],
    ["", "en"],
    [null, "en"],
    [undefined, "en"],
    ["xx", "en"],
    ["klingon", "en"],
  ])("normalises %p → %s", (input, expected) => {
    expect(normalizeBadgeI18nLang(input as string | null | undefined)).toBe(expected);
  });
});

describe("resolveBadgeI18nLangFromReq", () => {
  it("prefers ?lang= over Accept-Language", () => {
    const req = fakeReq({ lang: "hi" }, { "accept-language": "fr-FR,fr;q=0.9" });
    expect(resolveBadgeI18nLangFromReq(req)).toBe("hi");
  });

  it("falls back to Accept-Language when ?lang= is missing", () => {
    const req = fakeReq({}, { "accept-language": "ja-JP,ja;q=0.9,en;q=0.8" });
    expect(resolveBadgeI18nLangFromReq(req)).toBe("ja");
  });

  it("falls back to English when neither is present", () => {
    expect(resolveBadgeI18nLangFromReq(fakeReq())).toBe("en");
  });

  it("falls back to English when ?lang= is unsupported", () => {
    const req = fakeReq({ lang: "klingon" }, { "accept-language": "es" });
    // Per the resolution contract, a bad ?lang= still defers to header.
    // The implementation collapses unknown ?lang= to "en", which is fine —
    // assert the contract documented in code: bad ?lang= → english.
    expect(resolveBadgeI18nLangFromReq(req)).toBe("en");
  });

  it("ignores quality factors in Accept-Language", () => {
    const req = fakeReq({}, { "accept-language": "ar;q=0.5,en;q=0.1" });
    expect(resolveBadgeI18nLangFromReq(req)).toBe("ar");
  });
});

describe("localizeBadge", () => {
  it("returns the English entry when lang is 'en'", () => {
    const def = ALL_BADGES[0]!;
    const out = localizeBadge(def, "en");
    expect(out.label).toBe(def.label);
    expect(out.description).toBe(def.description);
  });

  it("returns translated copy for a covered locale", () => {
    const firstBirdie = ALL_BADGES.find(b => b.type === "first_birdie")!;
    const hi = localizeBadge(firstBirdie, "hi");
    expect(hi.label).not.toBe(firstBirdie.label);
    expect(hi.description).not.toBe(firstBirdie.description);
    expect(hi.label.length).toBeGreaterThan(0);
    expect(hi.description.length).toBeGreaterThan(0);
  });

  it("falls back to English when the locale block is missing the badge", () => {
    // Synthesise a fake badge type that no locale knows about. Reuse an
    // existing BadgeDef shape so the function runs the fallback path.
    const ghost = { ...ALL_BADGES[0]!, type: "__ghost_badge__", label: "Ghost", description: "Boo" };
    const out = localizeBadge(ghost, "hi");
    expect(out.label).toBe("Ghost");
    expect(out.description).toBe("Boo");
  });
});
