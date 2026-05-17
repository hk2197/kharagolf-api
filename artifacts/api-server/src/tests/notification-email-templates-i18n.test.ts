/**
 * Task #1358 — i18n snapshots for the 29 branded notification email
 * templates. Companion to `notification-email-templates.test.ts`
 * (which locks the English baseline). This suite asserts:
 *
 *   1. Every renderer accepts a non-English `recipientLang` and emits
 *      localised subject/HTML/text without throwing or leaving blank
 *      slots (snapshotted in Spanish across all 29 keys).
 *   2. Spot-checks for fr / de / hi / ja on a representative key
 *      confirm the per-language COMMON greeting + key bundle wins.
 *   3. Field-level fallback is honoured: an unsupported language
 *      (e.g. "xx") and a partially-translated language (one of the
 *      11 langs that only has COMMON copy) both fall back to English
 *      key strings without ever rendering an empty subject/section.
 *   4. The list of localised keys matches the registry of branded
 *      renderers, so a future PR that adds a 30th template can't
 *      silently ship without translation coverage.
 */

import { describe, it, expect } from "vitest";
import {
  renderNotificationEmail,
  listBrandedNotificationKeys,
  type NotificationEmailContext,
} from "../lib/notificationEmailTemplates.js";
import {
  hasNotificationEmailTranslation,
  listLocalisedNotificationKeys,
  resolveNotificationEmailLang,
  isSupportedNotificationEmailLang,
  NOTIFICATION_EMAIL_LANGS,
  NOTIFICATION_EMAIL_GLOSSARY,
} from "../lib/notificationEmailI18n.js";

const BRANDING = {
  orgId: 42,
  orgName: "Pebble Beach GC",
  logoUrl: "https://cdn.example.com/pebble-logo.png",
  primaryColor: "#1e4d2b",
};

/** Same per-key sample data as the EN baseline test — keeps the two
 *  suites comparable side-by-side in review. */
const SAMPLE_DATA: Record<string, Record<string, unknown>> = {
  "achievement.unlocked": { achievementName: "Sub-80 Streak", points: 250 },
  "booking.confirmed": { courseName: "Ocean Course", teeDate: "2026-05-12", teeTime: "08:40", partySize: 4 },
  "booking.reminder.24h": { courseName: "Ocean Course", teeDate: "2026-05-12", teeTime: "08:40" },
  "booking.reminder.2h": { courseName: "Ocean Course", teeTime: "08:40" },
  "booking.cancelled": { courseName: "Ocean Course", teeDate: "2026-05-12", teeTime: "08:40", reason: "Course closure" },
  "booking.waitlist.promoted": { courseName: "Ocean Course", teeTime: "08:40" },
  "caddie.mode.blocked": { reason: "Tournament round mode disables AI assistance" },
  "coach.review.delivered": { coachName: "Coach Lee", reviewUrl: "https://app.example.com/reviews/9" },
  "course.correction.resolved": { decision: "accepted", fieldName: "Hole 3 yardage", holeNumber: 3, reviewNotes: "Verified by greenkeeper" },
  "handicap.committee.changed": { previousIndex: "12.4", newIndex: "11.8", reason: "Annual review adjustment" },
  "handicap.exceptional.score": { score: 68, course: "Ocean Course", reduction: "0.4" },
  "highlight.ready": { highlightUrl: "https://app.example.com/h/abc", roundName: "Saturday Match Play" },
  "leaderboard.position.change": { tournamentName: "Spring Open", previousPosition: 14, newPosition: 7 },
  "league.standings.updated": { leagueName: "Tuesday Night League", position: 3, points: 84 },
  "marker.share.requested": { fromName: "Sam Cooke", roundName: "Saturday Stableford" },
  "match.scheduled": { opponentName: "Alex Murray", matchDate: "2026-05-18", matchTime: "10:00", courseName: "Ocean Course" },
  "match.result.recorded": { opponentName: "Alex Murray", result: "won", score: "3 & 2" },
  "post.event.survey": { tournamentName: "Spring Open", surveyUrl: "https://app.example.com/surveys/123" },
  "post.round.results": { courseName: "Ocean Course", grossScore: 82, netScore: 74, handicap: "11.8" },
  "recap.year.ready": { year: 2025, recapUrl: "https://app.example.com/recap/2025" },
  "scoring.event.eagle": { holeNumber: 13, courseName: "Ocean Course" },
  "scoring.event.hole_in_one": { holeNumber: 7, courseName: "Ocean Course", club: "7-iron" },
  "tournament.cut.applied": { tournamentName: "Spring Open", throughRound: 2, madeCut: true },
  "tournament.tee.published": { tournamentName: "Spring Open", teeDate: "2026-05-12", teeTime: "08:40", round: 1 },
  "wearable.reauth.required": { provider: "Garmin Connect", reauthUrl: "https://app.example.com/wearables" },
  "interclub.qualified": { eventName: "Coastal Inter-Club", qualifiedFrom: "Spring Open" },
  "streak.milestone": { streakLabel: "10 sub-90 rounds", days: 30 },
  "near.miss": { eventName: "Spring Open", missedBy: "1 stroke" },
  "verified.handicap.expiring": { expiresOn: "2026-06-01", handicapNumber: "VH-1042" },
};

const KEYS = listBrandedNotificationKeys();

function ctxFor(key: string, lang: string | null): NotificationEmailContext {
  return {
    recipientName: "Jordan Spieth",
    recipientLang: lang,
    branding: BRANDING,
    title: "Notification",
    body: "You have a new notification.",
    data: SAMPLE_DATA[key] ?? {},
  };
}

/** Strip volatile inline `style="…"` blocks so snapshots survive
 *  cosmetic refactors of the wrap helper while still pinning the
 *  localised copy. Same shape function the EN suite uses. */
function shape(html: string): string {
  return html
    .replace(/\s+/g, " ")
    .replace(/style="[^"]*"/g, 'style="…"')
    .trim();
}

/* ─── lang resolver guards ────────────────────────────────────────── */

describe("notificationEmailI18n — language resolver", () => {
  it("accepts every supported language code", () => {
    for (const lang of NOTIFICATION_EMAIL_LANGS) {
      expect(isSupportedNotificationEmailLang(lang)).toBe(true);
      expect(resolveNotificationEmailLang(lang)).toBe(lang);
    }
  });

  it("falls back to 'en' for unknown / null / empty inputs", () => {
    expect(resolveNotificationEmailLang(null)).toBe("en");
    expect(resolveNotificationEmailLang(undefined)).toBe("en");
    expect(resolveNotificationEmailLang("")).toBe("en");
    expect(resolveNotificationEmailLang("xx")).toBe("en");
    expect(resolveNotificationEmailLang("klingon")).toBe("en");
  });
});

/* ─── glossary structural coverage (Task #2061) ───────────────────── */

describe("notificationEmailI18n — golf-term glossary", () => {
  // The glossary is a documentation artefact, not a runtime dispatch
  // table, but a stale or partial entry would silently undermine its
  // purpose (keeping golf jargon consistent across the 30 KEY_BUNDLES).
  // Lock the structural shape so a future edit can't drop a language
  // unnoticed and so every term carries an English source-of-truth.
  const GLOSSARY_LANGS = [
    "en", "ar", "ko", "zh", "th", "ms", "id", "vi",
    "fil", "sw", "af", "am", "ha", "zu", "yo",
  ] as const;

  it("exposes a non-empty term set", () => {
    expect(Object.keys(NOTIFICATION_EMAIL_GLOSSARY).length).toBeGreaterThan(0);
  });

  it("every glossary entry carries the canonical English form", () => {
    for (const [term, entry] of Object.entries(NOTIFICATION_EMAIL_GLOSSARY)) {
      expect(typeof entry.en, `${term} is missing its English source`).toBe("string");
      expect(entry.en!.length, `${term} English form must not be empty`).toBeGreaterThan(0);
    }
  });

  it("every glossary entry covers all 14 newly-translated languages plus English", () => {
    for (const [term, entry] of Object.entries(NOTIFICATION_EMAIL_GLOSSARY)) {
      for (const lang of GLOSSARY_LANGS) {
        const value = entry[lang];
        expect(typeof value, `${term} is missing translation for ${lang}`).toBe("string");
        expect(
          (value ?? "").trim().length,
          `${term}/${lang} must not be blank`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("every glossary language code is in the supported language set", () => {
    for (const lang of GLOSSARY_LANGS) {
      expect(isSupportedNotificationEmailLang(lang)).toBe(true);
    }
  });
});

/* ─── localisation coverage parity ────────────────────────────────── */

describe("notificationEmailI18n — coverage parity with branded renderers", () => {
  it("every branded key has a localisation bundle entry", () => {
    const branded = listBrandedNotificationKeys();
    const localised = listLocalisedNotificationKeys();
    for (const key of branded) {
      expect(
        localised,
        `branded key "${key}" is missing from notificationEmailI18n KEY_BUNDLES`,
      ).toContain(key);
    }
  });
});

/* ─── translation-status flag (Task #2051) ────────────────────────── */

describe("notificationEmailI18n — hasNotificationEmailTranslation", () => {
  // Pick a key from the live registry rather than hard-coding so the
  // test stays valid as keys are renamed.
  const sampleKey = listLocalisedNotificationKeys()[0];

  it("treats English as native (it IS the canonical source)", () => {
    expect(hasNotificationEmailTranslation("en", sampleKey)).toBe(true);
  });

  it("treats unknown language codes as native — they resolve to English", () => {
    // `resolveNotificationEmailLang` collapses junk to "en", so the
    // preview will render the canonical English source. That's not
    // a "fallback" in the localisation-coverage sense — there's no
    // missing translation, just an unsupported request.
    expect(hasNotificationEmailTranslation("xx-not-real", sampleKey)).toBe(true);
    expect(hasNotificationEmailTranslation(null, sampleKey)).toBe(true);
    expect(hasNotificationEmailTranslation(undefined, sampleKey)).toBe(true);
    expect(hasNotificationEmailTranslation("", sampleKey)).toBe(true);
  });

  it("returns false for unknown notification keys", () => {
    // No bundle to translate from → caller should treat the result as
    // a fallback (the preview path actually returns 404 for unknown
    // keys, but the helper is also used defensively elsewhere).
    expect(hasNotificationEmailTranslation("en", "does.not.exist.zzz")).toBe(false);
    expect(hasNotificationEmailTranslation("es", "does.not.exist.zzz")).toBe(false);
  });

  it("returns a boolean for every (registered key, supported lang) pair", () => {
    // Smoke-test that the helper never throws or returns something
    // other than a boolean across the cartesian product of registered
    // keys and supported languages — that's the contract the preview
    // dialog relies on. We deliberately do NOT assert the result is
    // always `true` here: the whole point of Task #2051 is to allow
    // partial-translation rollouts (where some langs return `false`)
    // and surface them in the admin UI rather than hide them behind
    // a CI failure.
    for (const key of listLocalisedNotificationKeys()) {
      for (const lang of NOTIFICATION_EMAIL_LANGS) {
        const v = hasNotificationEmailTranslation(lang, key);
        expect(typeof v, `${key} / ${lang} should yield a boolean`).toBe("boolean");
      }
    }
  });

  it("agrees with renderNotificationEmail's per-language output for sampled langs", () => {
    // Cross-check that when the helper claims `native` for (key, lang),
    // the renderer actually picks up a non-English subject for at
    // least one key+lang where the localisation pack overrides the
    // subject template — proving the flag is grounded in real
    // rendering behaviour rather than just metadata. We sample a
    // representative key + non-English lang rather than looping the
    // whole matrix to keep the test cheap.
    const key = "course.correction.resolved";
    expect(hasNotificationEmailTranslation("es", key)).toBe(true);
    const out = renderNotificationEmail(key, ctxFor(key, "es"));
    expect(out).not.toBeNull();
    expect(out!.subject).not.toBe("Your course correction was accepted");
  });
});

/* ─── Spanish snapshots across all 29 templates ───────────────────── */

describe("notificationEmailTemplates — Spanish snapshots (all 29 keys)", () => {
  for (const key of KEYS) {
    it(`${key} → renders in Spanish`, () => {
      const out = renderNotificationEmail(key, ctxFor(key, "es"));
      expect(out).not.toBeNull();
      const { subject, html, text } = out!;

      // Sanity: localisation must not erase any envelope chunk.
      expect(subject.length).toBeGreaterThan(0);
      expect(html).toContain("<div");
      expect(text.length).toBeGreaterThan(0);

      // Spanish greeting + branding still surface.
      expect(text).toContain("Hola Jordan Spieth");
      expect(text).toContain("Pebble Beach GC");
      expect(html).toContain("Pebble Beach GC");
      expect(html).toContain(key);

      expect({
        key,
        lang: "es",
        subject,
        text,
        html: shape(html),
      }).toMatchSnapshot();
    });
  }
});

/* ─── Korean snapshots across all 29 templates ────────────────────── */

describe("notificationEmailTemplates — Korean snapshots (all 29 keys)", () => {
  for (const key of KEYS) {
    it(`${key} → renders in Korean`, () => {
      const out = renderNotificationEmail(key, ctxFor(key, "ko"));
      expect(out).not.toBeNull();
      const { subject, html, text } = out!;

      // Sanity: localisation must not erase any envelope chunk.
      expect(subject.length).toBeGreaterThan(0);
      expect(html).toContain("<div");
      expect(text.length).toBeGreaterThan(0);

      // Korean greeting + branding still surface.
      expect(text).toContain("안녕하세요 Jordan Spieth");
      expect(text).toContain("Pebble Beach GC");
      expect(html).toContain("Pebble Beach GC");
      expect(html).toContain(key);

      expect({
        key,
        lang: "ko",
        subject,
        text,
        html: shape(html),
      }).toMatchSnapshot();
    });
  }
});

/* ─── Spot checks for fr / de / hi / ja ───────────────────────────── */

describe("notificationEmailTemplates — multi-language spot checks", () => {
  const SPOT_KEY = "booking.confirmed";

  it("French render uses 'Bonjour' and the French subject", () => {
    const out = renderNotificationEmail(SPOT_KEY, ctxFor(SPOT_KEY, "fr"));
    expect(out).not.toBeNull();
    expect(out!.text).toContain("Bonjour Jordan Spieth");
    // Subject + subtitle should not be the English defaults.
    expect(out!.subject).not.toMatch(/^Booking confirmed/);
    expect(out!.html).not.toMatch(/Tee time confirmed/);
  });

  it("German render uses 'Hallo' and the German subject", () => {
    const out = renderNotificationEmail(SPOT_KEY, ctxFor(SPOT_KEY, "de"));
    expect(out).not.toBeNull();
    expect(out!.text).toContain("Hallo Jordan Spieth");
    expect(out!.subject).not.toMatch(/^Booking confirmed/);
  });

  it("Hindi render uses 'नमस्ते' greeting", () => {
    const out = renderNotificationEmail(SPOT_KEY, ctxFor(SPOT_KEY, "hi"));
    expect(out).not.toBeNull();
    expect(out!.text).toContain("नमस्ते Jordan Spieth");
    expect(out!.subject).not.toMatch(/^Booking confirmed/);
  });

  it("Japanese render uses 'こんにちは' greeting", () => {
    const out = renderNotificationEmail(SPOT_KEY, ctxFor(SPOT_KEY, "ja"));
    expect(out).not.toBeNull();
    expect(out!.text).toContain("こんにちは Jordan Spieth");
    expect(out!.subject).not.toMatch(/^Booking confirmed/);
  });
});

/* ─── Task #2012 — post.event.survey reminder variant per language ─── */

describe("notificationEmailTemplates — post.event.survey reminder snapshots (Task #2012)", () => {
  // Cover (a) a representative spread of fully-translated languages so
  // the per-language reminderSubject / reminderClosing / reminderText
  // wiring is visually locked, and (b) an unsupported language so the
  // English-fallback path on the reminder fields is exercised too.
  const REMINDER_LANGS: Array<string | null> = [
    "en", "es", "fr", "de", "pt", "hi", "ja", "ko", "zh",
    "ar", "th", "ms", "id", "vi", "fil", "sw",
    "af", "am", "ha", "zu", "yo",
    "xx-not-a-lang",
  ];
  const REMINDER_DATA = { ...SAMPLE_DATA["post.event.survey"], isReminder: true };

  for (const lang of REMINDER_LANGS) {
    const label = lang ?? "null";
    it(`post.event.survey reminder renders in ${label}`, () => {
      const out = renderNotificationEmail("post.event.survey", {
        recipientName: "Jordan Spieth",
        recipientLang: lang,
        branding: BRANDING,
        title: "Notification",
        body: "You have a new notification.",
        data: REMINDER_DATA,
      });
      expect(out).not.toBeNull();
      const { subject, html, text } = out!;
      expect(subject.length).toBeGreaterThan(0);
      expect(text.length).toBeGreaterThan(0);
      expect({
        key: "post.event.survey",
        variant: "reminder",
        lang: label,
        subject,
        text,
        html: shape(html),
      }).toMatchSnapshot();
    });
  }

  it("supported languages produce a different reminder subject than the non-reminder subject", () => {
    // Spot-check a handful of languages: the localised reminder subject
    // must NOT collapse to the original (non-reminder) subject. Catches a
    // future contributor accidentally setting `reminderSubject: kb.subject`.
    for (const lang of ["en", "es", "fr", "de", "ja", "ko", "zh", "ar"]) {
      const reminder = renderNotificationEmail("post.event.survey", {
        recipientName: "Jordan Spieth",
        recipientLang: lang,
        branding: BRANDING,
        title: "Notification",
        body: "Body",
        data: REMINDER_DATA,
      });
      const original = renderNotificationEmail("post.event.survey", ctxFor("post.event.survey", lang));
      expect(reminder).not.toBeNull();
      expect(original).not.toBeNull();
      expect(reminder!.subject, `lang=${lang}`).not.toBe(original!.subject);
    }
  });
});

/* ─── fallback behaviour ──────────────────────────────────────────── */

describe("notificationEmailTemplates — language fallback", () => {
  it("an unsupported language code falls back to English copy", () => {
    const en = renderNotificationEmail("achievement.unlocked", ctxFor("achievement.unlocked", "en"));
    const xx = renderNotificationEmail("achievement.unlocked", ctxFor("achievement.unlocked", "xx-not-a-lang"));
    expect(en).not.toBeNull();
    expect(xx).not.toBeNull();
    expect(xx!.subject).toBe(en!.subject);
    expect(xx!.text).toBe(en!.text);
    expect(xx!.html).toBe(en!.html);
  });

  it("null recipientLang falls back to English", () => {
    const en = renderNotificationEmail("achievement.unlocked", ctxFor("achievement.unlocked", "en"));
    const nul = renderNotificationEmail("achievement.unlocked", ctxFor("achievement.unlocked", null));
    expect(nul!.subject).toBe(en!.subject);
    expect(nul!.text).toBe(en!.text);
  });

  it("a fully-translated language renders both the localised greeting and localised key copy", () => {
    // Task #1647 brought every supported language to full per-key copy,
    // so `sw` (Swahili) now ships a Swahili subject *and* a Swahili
    // greeting. Field-level fallback for keys/fields a future contributor
    // omits is exercised by the unsupported-language case above and by
    // mergeKeyBundle's per-field guards.
    const out = renderNotificationEmail("achievement.unlocked", ctxFor("achievement.unlocked", "sw"));
    expect(out).not.toBeNull();
    // Swahili greeting word.
    expect(out!.text).toMatch(/^Habari Jordan Spieth/);
    // Subject is no longer the English default.
    const enOut = renderNotificationEmail("achievement.unlocked", ctxFor("achievement.unlocked", "en"));
    expect(out!.subject).not.toBe(enOut!.subject);
    expect(out!.subject).toMatch(/Mafanikio/);
  });
});
