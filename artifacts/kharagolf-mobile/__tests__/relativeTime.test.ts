/**
 * Unit test: i18n relative-time helper (Task #1659).
 *
 * Verifies that the shared `formatRelativeTime` utility renders
 * translated copy for the active locale so the committee case detail
 * screen (and any other caller) renders translated copy in English,
 * Arabic, Japanese, and the other supported languages — instead of
 * leaking English fragments like "5 minutes ago" when count=2..10 in
 * Arabic (the prior i18next `_one`/`_other` JSON approach was missing
 * Arabic's `_two`/`_few`/`_many` plural buckets and silently fell back
 * to the English `_other` value).
 *
 * Task #2101 added a real translated `relative.past.*` / `relative.future.*`
 * catalogue so non-English speakers no longer see English fragments
 * embedded inside otherwise-translated sentences (e.g. Arabic "شوهد 3
 * days ago"). The catalogue is preferred when i18n is initialised; the
 * Intl-based path is the fallback for tests / call-sites that do not
 * boot the full i18n stack.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Task #2059 split `getLocale` out of `@/i18n` into the lightweight
// `@/i18n/locale` module so utilities like `formatRelativeTime` can
// import it without dragging the full i18next + expo-localization
// bootstrap in. Mock that smaller module here.
vi.mock("@/i18n/locale", () => ({
  getLocale: vi.fn(),
  LOCALE_MAP: {},
}));

// We deliberately do NOT mock `i18next` for the Intl-fallback tests —
// without `@/i18n/index.ts` being imported, i18next is uninitialised
// and `i18n.exists(...)` returns `false`, so `formatRelativeTime`
// transparently falls back to `Intl.RelativeTimeFormat`. The catalogue
// path is exercised in a separate describe block below by mocking
// i18next directly.
import { formatRelativeTime } from "../i18n/relativeTime";
import { getLocale } from "@/i18n/locale";

const NOW = new Date("2026-04-29T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(getLocale).mockReset();
});

function isoMinutesAgo(n: number): string {
  return new Date(NOW - n * 60_000).toISOString();
}
function isoHoursAgo(n: number): string {
  return new Date(NOW - n * 60 * 60_000).toISOString();
}
function isoDaysAhead(n: number): string {
  return new Date(NOW + n * 24 * 60 * 60_000).toISOString();
}

describe("formatRelativeTime (Intl fallback path)", () => {
  it("renders English copy for the en-IN locale", () => {
    vi.mocked(getLocale).mockReturnValue("en-IN");
    expect(formatRelativeTime(isoMinutesAgo(5))).toBe("5 minutes ago");
    expect(formatRelativeTime(isoMinutesAgo(1))).toBe("1 minute ago");
    expect(formatRelativeTime(isoHoursAgo(3))).toBe("3 hours ago");
    expect(formatRelativeTime(isoDaysAhead(2))).toBe("in 2 days");
  });

  it("renders translated copy for non-English locales (no English leakage)", () => {
    vi.mocked(getLocale).mockReturnValue("ja-JP");
    const ja5 = formatRelativeTime(isoMinutesAgo(5));
    expect(ja5).not.toMatch(/minute|ago|in /i);
    expect(ja5).toContain("5");

    vi.mocked(getLocale).mockReturnValue("de-DE");
    const de5 = formatRelativeTime(isoMinutesAgo(5));
    expect(de5).not.toMatch(/minute(s)? ago|in \d/i);
    expect(de5.toLowerCase()).toContain("minuten");
  });

  it("uses Arabic CLDR plural buckets that the previous i18n JSON missed", () => {
    // Arabic plural categories: zero, one, two, few, many, other.
    // The prior `_one`/`_other`-only JSON resolved counts 2..10 to the
    // English `_other` fallback, leaking "2 minutes ago" etc. into
    // Arabic-language sessions. Intl.RelativeTimeFormat handles every
    // bucket natively, so none of these should contain Latin letters.
    vi.mocked(getLocale).mockReturnValue("ar-AE");
    for (const n of [1, 2, 3, 5, 11, 100]) {
      const out = formatRelativeTime(isoMinutesAgo(n));
      expect(out, `count=${n} produced "${out}"`).not.toMatch(/[A-Za-z]/);
    }
  });

  it("returns an empty string for invalid timestamps", () => {
    vi.mocked(getLocale).mockReturnValue("en-IN");
    expect(formatRelativeTime("not-a-date")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Catalogue path (Task #2101)
// ---------------------------------------------------------------------------
//
// In production, the i18n bootstrap is imported during app start and the
// `relative.past.*` / `relative.future.*` keys live under the
// `handicapCommittee` namespace. `formatRelativeTime` prefers those
// translated templates over `Intl.RelativeTimeFormat`, so smaller-community
// locales (ha, am, yo, zu, …) whose ICU data is incomplete on Hermes still
// render fully-translated sentences inside `Seen {{relative}}`.
describe("formatRelativeTime (translated catalogue path)", () => {
  beforeEach(async () => {
    vi.resetModules();
    // Mock i18next with an in-memory catalogue keyed by lng + path. This
    // exercises the same code path the production app uses without
    // booting the heavy `@/i18n/index.ts` initialiser.
    vi.doMock("i18next", () => {
      const catalogues: Record<string, Record<string, string>> = {
        en: {
          "relative.past.minute_one": "{{count}} minute ago",
          "relative.past.minute_other": "{{count}} minutes ago",
          "relative.future.day_one": "in {{count}} day",
          "relative.future.day_other": "in {{count}} days",
        },
        ar: {
          "relative.past.minute_one": "قبل دقيقة واحدة",
          "relative.past.minute_two": "قبل دقيقتين",
          "relative.past.minute_few": "قبل {{count}} دقائق",
          "relative.past.minute_many": "قبل {{count}} دقيقة",
          "relative.past.minute_other": "قبل {{count}} دقيقة",
        },
        ha: {
          "relative.past.minute_one": "{{count}} minti da suka wuce",
          "relative.past.minute_other": "{{count}} mintoci da suka wuce",
        },
      };
      const pluralRules: Record<string, Intl.PluralRules> = {
        en: new Intl.PluralRules("en"),
        ar: new Intl.PluralRules("ar"),
        ha: new Intl.PluralRules("ha"),
      };
      function resolve(lng: string, path: string, count?: number): string | null {
        const cat = catalogues[lng];
        if (!cat) return null;
        if (typeof count === "number" && pluralRules[lng]) {
          const tag = pluralRules[lng].select(count);
          const candidate = cat[`${path}_${tag}`] ?? cat[`${path}_other`];
          if (candidate !== undefined) return candidate;
        }
        return cat[path] ?? null;
      }
      return {
        default: {
          language: "en",
          t(path: string, opts: { lng?: string; count?: number; defaultValue?: string }) {
            const lng = opts?.lng ?? "en";
            const tpl = resolve(lng, path, opts?.count);
            if (tpl == null) return opts?.defaultValue ?? path;
            if (typeof opts?.count === "number") {
              return tpl.replace(/\{\{count\}\}/g, String(opts.count));
            }
            return tpl;
          },
        },
      };
    });
  });

  afterEach(() => {
    vi.doUnmock("i18next");
    vi.resetModules();
  });

  it("uses the translated catalogue for English so output stays consistent", async () => {
    vi.mocked(getLocale).mockReturnValue("en-IN");
    const { formatRelativeTime: fmt } = await import("../i18n/relativeTime");
    expect(fmt(isoMinutesAgo(1), "en")).toBe("1 minute ago");
    expect(fmt(isoMinutesAgo(5), "en")).toBe("5 minutes ago");
    expect(fmt(isoDaysAhead(2), "en")).toBe("in 2 days");
  });

  it("renders Arabic plural buckets from the catalogue (one/two/few/many/other)", async () => {
    vi.mocked(getLocale).mockReturnValue("ar-AE");
    const { formatRelativeTime: fmt } = await import("../i18n/relativeTime");
    // Arabic CLDR: 1=one, 2=two, 3..10=few, 11..99=many, others=other
    expect(fmt(isoMinutesAgo(1), "ar")).toBe("قبل دقيقة واحدة");
    expect(fmt(isoMinutesAgo(2), "ar")).toBe("قبل دقيقتين");
    expect(fmt(isoMinutesAgo(5), "ar")).toBe("قبل 5 دقائق");
    expect(fmt(isoMinutesAgo(11), "ar")).toBe("قبل 11 دقيقة");
    // None of the Arabic outputs should contain a Latin letter.
    for (const n of [1, 2, 5, 11]) {
      expect(fmt(isoMinutesAgo(n), "ar")).not.toMatch(/[A-Za-z]/);
    }
  });

  it("renders Hausa from the catalogue when Intl ICU data may be missing", async () => {
    vi.mocked(getLocale).mockReturnValue("ha-NG");
    const { formatRelativeTime: fmt } = await import("../i18n/relativeTime");
    expect(fmt(isoMinutesAgo(1), "ha")).toBe("1 minti da suka wuce");
    expect(fmt(isoMinutesAgo(5), "ha")).toBe("5 mintoci da suka wuce");
  });

  it("falls back to Intl.RelativeTimeFormat when the catalogue has no entry for the locale", async () => {
    vi.mocked(getLocale).mockReturnValue("ja-JP");
    const { formatRelativeTime: fmt } = await import("../i18n/relativeTime");
    // No `ja` bundle in the in-memory catalogue → Intl path is used.
    const out = fmt(isoMinutesAgo(5), "ja");
    expect(out).not.toMatch(/minute|ago|in /i);
    expect(out).toContain("5");
  });
});
