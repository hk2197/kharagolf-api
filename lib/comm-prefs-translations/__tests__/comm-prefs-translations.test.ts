/**
 * Unit test: Communications channel matrix translations (Task #2163).
 *
 * The Communications preferences UI on web (PortalCommPrefs.tsx) and
 * mobile (app/my-360/communications.tsx) renders the channel matrix
 * headers, intro paragraph, WhatsApp footnote and category labels via
 * i18n keys:
 *
 *   - web    → portal.json `commPrefs.{intro, whatsappFootnote,
 *               headers.*, categories.*}`
 *   - mobile → profile.json `commPrefs.{intro, whatsappFootnote,
 *               channels.*, categories.*.label}`
 *
 * When those keys were first localised (Tasks #1741 etc.) no automated
 * test ensured the translations stay in place. The repo-wide lint
 * scripts (`check-portal-translations.mjs`, `check-mobile-translations.mjs`)
 * only catch *missing* keys or English fallbacks for *new* keys: they
 * are happy when an existing key is silently changed back to its
 * English source value. A future contributor editing the page could
 * therefore reintroduce hardcoded English on any of these strings and
 * the build would stay green.
 *
 * This suite reads en/portal.json and en/profile.json and asserts
 * that, for at least two non-English locales (Hindi and Arabic), the
 * channel matrix headers, intro, WhatsApp footnote and category
 * labels are NOT byte-identical to the English source. Acronym /
 * loanword headers (SMS, WhatsApp) are excluded from the per-header
 * inequality check because they travel unchanged across scripts in
 * several locales — the rest of the matrix (Category, Email, Push,
 * In-app on web; Email, Push, In-app on mobile) is asserted explicitly.
 *
 * Adding a new locale that legitimately keeps a non-acronym header
 * identical to English would require updating the per-locale
 * exception map at the top of this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const WEB_LOCALES_DIR = join(
  REPO_ROOT,
  "artifacts",
  "kharagolf-web",
  "src",
  "i18n",
  "locales",
);
const MOBILE_LOCALES_DIR = join(
  REPO_ROOT,
  "artifacts",
  "kharagolf-mobile",
  "i18n",
  "locales",
);

interface WebCommPrefs {
  sectionTitle: string;
  intro: string;
  whatsappFootnote: string;
  headers: Record<string, string>;
  categories: Record<string, string>;
}

interface MobileCommPrefs {
  intro: string;
  whatsappFootnote: string;
  channels: Record<string, string>;
  categories: Record<string, { label: string; description: string }>;
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadWebCommPrefs(lang: string): WebCommPrefs {
  const bundle = loadJson<{ commPrefs: WebCommPrefs }>(
    join(WEB_LOCALES_DIR, lang, "portal.json"),
  );
  return bundle.commPrefs;
}

function loadMobileCommPrefs(lang: string): MobileCommPrefs {
  const bundle = loadJson<{ commPrefs: MobileCommPrefs }>(
    join(MOBILE_LOCALES_DIR, lang, "profile.json"),
  );
  return bundle.commPrefs;
}

const NON_ENGLISH_LOCALES = ["hi", "ar"] as const;
type NonEnglishLocale = (typeof NON_ENGLISH_LOCALES)[number];

// Channel matrix headers rendered by PortalCommPrefs.tsx. SMS and
// WhatsApp are intentionally excluded from the "must differ from
// English" assertion because they are acronyms / brand names that
// travel unchanged across many scripts (e.g. Hindi keeps "SMS" and
// "WhatsApp" verbatim).
const WEB_TRANSLATABLE_HEADER_KEYS = [
  "category",
  "email",
  "push",
  "inApp",
] as const;

// The mobile screen renders channel headers from `commPrefs.channels.*`
// inside each category card (no separate "category" column header — the
// card title already shows the category label). Same loanword exclusion
// rule applies.
const MOBILE_TRANSLATABLE_CHANNEL_KEYS = ["email", "push", "inApp"] as const;

const CATEGORY_KEYS = [
  "billing",
  "operations",
  "service",
  "events",
  "tournaments",
  "newsletters",
  "marketing",
  "social",
  "privacy",
] as const;

const WEB_EN = loadWebCommPrefs("en");
const MOBILE_EN = loadMobileCommPrefs("en");

const WEB_LOCALES: Record<NonEnglishLocale, WebCommPrefs> = Object.fromEntries(
  NON_ENGLISH_LOCALES.map((l) => [l, loadWebCommPrefs(l)]),
) as Record<NonEnglishLocale, WebCommPrefs>;

const MOBILE_LOCALES: Record<NonEnglishLocale, MobileCommPrefs> =
  Object.fromEntries(
    NON_ENGLISH_LOCALES.map((l) => [l, loadMobileCommPrefs(l)]),
  ) as Record<NonEnglishLocale, MobileCommPrefs>;

describe("web portal commPrefs translations (PortalCommPrefs.tsx)", () => {
  it("English bundle exposes every key the matrix renders", () => {
    // Drift guard: this suite asserts shape against the English
    // bundle. If a key is removed from English (e.g. someone renames
    // `headers.inApp`) the assertions below would silently pass with
    // `undefined === undefined`. Pin the expected shape here so the
    // first failure is loud.
    expect(WEB_EN.intro).toBeTruthy();
    expect(WEB_EN.whatsappFootnote).toBeTruthy();
    for (const key of WEB_TRANSLATABLE_HEADER_KEYS) {
      expect(WEB_EN.headers[key], `headers.${key}`).toBeTruthy();
    }
    for (const key of CATEGORY_KEYS) {
      expect(WEB_EN.categories[key], `categories.${key}`).toBeTruthy();
    }
  });

  describe.each(NON_ENGLISH_LOCALES)("locale: %s", (lang) => {
    const block = WEB_LOCALES[lang];

    it("translates the intro paragraph", () => {
      expect(block.intro).toBeTruthy();
      expect(block.intro).not.toBe(WEB_EN.intro);
    });

    it("translates the WhatsApp footnote", () => {
      expect(block.whatsappFootnote).toBeTruthy();
      expect(block.whatsappFootnote).not.toBe(WEB_EN.whatsappFootnote);
    });

    it("translates the channel matrix headers (excluding SMS / WhatsApp loanwords)", () => {
      for (const key of WEB_TRANSLATABLE_HEADER_KEYS) {
        expect(block.headers[key], `headers.${key}`).toBeTruthy();
        expect(block.headers[key], `headers.${key}`).not.toBe(
          WEB_EN.headers[key],
        );
      }
    });

    it("translates every category label", () => {
      // Stronger drift guard: every category label is a regular noun
      // that should localise — none are loanwords. Reverting any
      // single label back to its English source must fail.
      for (const key of CATEGORY_KEYS) {
        expect(block.categories[key], `categories.${key}`).toBeTruthy();
        expect(block.categories[key], `categories.${key}`).not.toBe(
          WEB_EN.categories[key],
        );
      }
    });
  });
});

describe("mobile profile commPrefs translations (app/my-360/communications.tsx)", () => {
  it("English bundle exposes every key the screen renders", () => {
    expect(MOBILE_EN.intro).toBeTruthy();
    expect(MOBILE_EN.whatsappFootnote).toBeTruthy();
    for (const key of MOBILE_TRANSLATABLE_CHANNEL_KEYS) {
      expect(MOBILE_EN.channels[key], `channels.${key}`).toBeTruthy();
    }
    for (const key of CATEGORY_KEYS) {
      expect(
        MOBILE_EN.categories[key]?.label,
        `categories.${key}.label`,
      ).toBeTruthy();
    }
  });

  describe.each(NON_ENGLISH_LOCALES)("locale: %s", (lang) => {
    const block = MOBILE_LOCALES[lang];

    it("translates the intro paragraph", () => {
      expect(block.intro).toBeTruthy();
      expect(block.intro).not.toBe(MOBILE_EN.intro);
    });

    it("translates the WhatsApp footnote", () => {
      expect(block.whatsappFootnote).toBeTruthy();
      expect(block.whatsappFootnote).not.toBe(MOBILE_EN.whatsappFootnote);
    });

    it("translates the channel column labels (excluding SMS / WhatsApp loanwords)", () => {
      for (const key of MOBILE_TRANSLATABLE_CHANNEL_KEYS) {
        expect(block.channels[key], `channels.${key}`).toBeTruthy();
        expect(block.channels[key], `channels.${key}`).not.toBe(
          MOBILE_EN.channels[key],
        );
      }
    });

    it("translates every category label", () => {
      for (const key of CATEGORY_KEYS) {
        const label = block.categories[key]?.label;
        expect(label, `categories.${key}.label`).toBeTruthy();
        expect(label, `categories.${key}.label`).not.toBe(
          MOBILE_EN.categories[key].label,
        );
      }
    });
  });
});
