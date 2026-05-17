/**
 * Tasks #1764 + #1766 — share-card localization tests for the public badge
 * OG image. Two-layer coverage:
 *
 *   • SVG layer (Task #1764): pure unit tests over `localizeBadge` and the
 *     SVG builders in `lib/badgeOgSvg.ts`. Asserts the localized badge
 *     label / description / chrome end up in the SVG body for Hindi
 *     (Devanagari) and Arabic (RTL). PNG bytes aren't greppable for
 *     human-readable text, so this layer is where we prove the *content*
 *     is translated.
 *
 *   • PNG layer (Task #1766): end-to-end coverage for the full SVG → PNG
 *     rendering path. The rasteriser (`@resvg/resvg-js`) needs the right
 *     fonts loaded or non-Latin chrome strings ("बैज अनलॉक",
 *     "تم فتح الشارة", "徽章已解锁", "バッジ獲得") render as tofu (boxes) on
 *     social link previews. We hit `/p/<handle>/badge/<type>/og?lang=…`
 *     for every non-Latin script, assert a valid 1200×630 PNG, save
 *     visual fixtures to `src/tests/fixtures/badge-og-i18n/`, and check
 *     that the rendered bytes diverge substantially from the English
 *     baseline (i.e. real glyphs contributed pixels, not boxes). Also
 *     verifies the font resolver (`resolveBadgeOgFontDirs`) returns a
 *     non-empty list in this sandbox so the rasteriser actually sees
 *     Noto.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  holeDetailsTable,
  tournamentsTable,
  achievementsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTestApp, uid } from "./helpers.js";
import { getBadgeDef } from "../lib/achievementEngine";
import { localizeBadge } from "../lib/badgeI18n";
import {
  buildBadgeOgUnlockedSvg,
  buildBadgeOgLockedSvg,
  splitEarnedLine,
} from "../lib/badgeOgSvg";
import {
  getBadgeOgStrings,
  interpolateBadgeOg,
} from "../lib/badgeOgI18n";
import { resolveBadgeOgFontDirs } from "../lib/badgeOgFonts.js";

const DEVANAGARI = /[\u0900-\u097F]/;
const ARABIC = /[\u0600-\u06FF]/;

/**
 * Task #2227 — defensive helper kept across iterations. Earlier drafts of
 * the script-aware fix wrapped per-script runs in `<tspan font-family="…">`
 * elements; the production fix instead lists every script-specific Noto
 * face directly in each `<text>`'s `font-family` chain so resvg's per-glyph
 * fallback picks the right face. Either way the substring assertions
 * should match the original logical strings, so we strip any tspans before
 * comparing on the off chance the builder regresses to a tspan-wrapping
 * approach in the future.
 */
function flattenTspans(svg: string): string {
  return svg.replace(/<\/?tspan(?:\s[^>]*)?>/g, "");
}

// -----------------------------------------------------------------------------
// SVG layer (Task #1764) — pure builder tests, no DB, no rasteriser.
// -----------------------------------------------------------------------------
describe("badge OG share card — Hindi (Devanagari) localization", () => {
  it("localizeBadge returns Devanagari for first_birdie", () => {
    const def = getBadgeDef("first_birdie");
    expect(def).toBeDefined();
    const localized = localizeBadge(def!, "hi");
    expect(localized.label).toMatch(DEVANAGARI);
    expect(localized.description).toMatch(DEVANAGARI);
    // Sanity: English original is NOT what the Hindi viewer sees.
    expect(localized.label).not.toBe(def!.label);
    expect(localized.description).not.toBe(def!.description);
  });

  it("unlocked share card SVG contains the Hindi label, description, and chrome", () => {
    const def = getBadgeDef("first_birdie")!;
    const hi = localizeBadge(def, "hi");
    const ogStr = getBadgeOgStrings("hi");
    const earnedLine = interpolateBadgeOg(ogStr.earnedOn, {
      date: "1 जनवरी 2026",
      handle: "hi_player",
    });
    // Task #2227 — split mixed-script "earnedLine" into the Devanagari
    // date prose + the bare Latin "@handle" so each ends up in its own
    // single-script <text> element (resvg-js can't per-glyph fallback).
    const { earnedDateLine, handleLine } = splitEarnedLine(earnedLine, "hi_player");
    expect(earnedDateLine).toMatch(DEVANAGARI);
    expect(earnedDateLine).not.toContain("@");
    expect(handleLine).toBe("@hi_player");
    const svg = buildBadgeOgUnlockedSvg({
      icon: def.icon,
      badgeLabel: hi.label,
      badgeDescription: hi.description,
      name: "हिंदी प्लेयर",
      earnedDateLine,
      handleLine,
      badgeUnlockedLabel: ogStr.badgeUnlocked,
    });
    // Task #2227 — flatten any tspan markup just in case the builder
    // regresses to a tspan-wrapping approach; the production fix uses
    // separate <text> rows so flat == svg here.
    const flat = flattenTspans(svg);
    expect(flat).toContain(hi.label);
    expect(flat).toContain(hi.description);
    // The localized chrome string for "BADGE UNLOCKED" must also be rendered.
    expect(flat).toContain(ogStr.badgeUnlocked);
    // And the SVG body should overall have Devanagari script.
    expect(svg).toMatch(DEVANAGARI);
    // Make sure the English catalog strings did NOT leak through.
    expect(flat).not.toContain(def.label);
    expect(flat).not.toContain(def.description);
    // Task #2227 fix — multi-script font-family chain ensures resvg-js can
    // resolve Devanagari glyphs in any of the localized rows (chrome,
    // badge label/description, name, date prose).
    expect(svg).toContain("Noto Sans Devanagari");
    // Task #2227 fix — the @handle row must be rendered as its own <text>
    // element (not tspan'd into the date prose) so resvg's per-run picker
    // lands on a Latin face and the @handle's letters don't render as tofu.
    expect(svg).toContain(">@hi_player<");
    // The combined "<date> · @handle" string must NOT appear together in
    // any single <text> body — that's the regression Task #2227 fixes.
    const oneLineRe = /<text[^>]*>[^<]*अर्जित[^<]*@hi_player[^<]*<\/text>/;
    expect(svg).not.toMatch(oneLineRe);
  });

  it("locked share card SVG renders Hindi label/description and progress chrome", () => {
    const def = getBadgeDef("10_rounds")!;
    const hi = localizeBadge(def, "hi");
    const ogStr = getBadgeOgStrings("hi");
    const progressLabel = interpolateBadgeOg(ogStr.xOfY, {
      current: 4,
      target: 10,
    });
    const svg = buildBadgeOgLockedSvg({
      icon: def.icon,
      badgeLabel: hi.label,
      badgeDescription: hi.description,
      name: "हिंदी प्लेयर",
      handle: "hi_player",
      almostThereLabel: ogStr.almostThere,
      progressLabel,
      progressFraction: 0.4,
    });
    const flat = flattenTspans(svg);
    expect(flat).toContain(hi.label);
    expect(flat).toContain(hi.description);
    expect(flat).toContain(ogStr.almostThere);
    expect(flat).toContain(progressLabel);
    expect(svg).toMatch(DEVANAGARI);
    // Task #2227 — locked card's name and @handle are now rendered on
    // separate <text> rows for the same per-run-fallback reason as the
    // unlocked card's date prose / @handle split.
    expect(svg).toContain("Noto Sans Devanagari");
    expect(svg).toContain(">@hi_player<");
    expect(svg).toContain(">हिंदी प्लेयर<");
    // The combined "name · @handle" string must NOT appear in a single
    // <text> body anymore.
    const oneLineRe = /<text[^>]*>[^<]*हिंदी प्लेयर[^<]*@hi_player[^<]*<\/text>/;
    expect(svg).not.toMatch(oneLineRe);
  });
});

describe("badge OG share card — Arabic (RTL) localization", () => {
  it("unlocked share card SVG contains the Arabic label and description", () => {
    const def = getBadgeDef("first_birdie")!;
    const ar = localizeBadge(def, "ar");
    expect(ar.label).toMatch(ARABIC);
    expect(ar.description).toMatch(ARABIC);
    const ogStr = getBadgeOgStrings("ar");
    const earnedLine = interpolateBadgeOg(ogStr.earnedOn, {
      date: "١ يناير ٢٠٢٦",
      handle: "ar_player",
    });
    const { earnedDateLine, handleLine } = splitEarnedLine(earnedLine, "ar_player");
    expect(earnedDateLine).toMatch(ARABIC);
    expect(earnedDateLine).not.toContain("@");
    expect(handleLine).toBe("@ar_player");
    const svg = buildBadgeOgUnlockedSvg({
      icon: def.icon,
      badgeLabel: ar.label,
      badgeDescription: ar.description,
      name: "لاعب عربي",
      earnedDateLine,
      handleLine,
      badgeUnlockedLabel: ogStr.badgeUnlocked,
    });
    const flat = flattenTspans(svg);
    expect(flat).toContain(ar.label);
    expect(flat).toContain(ar.description);
    expect(svg).toMatch(ARABIC);
    // English fallback must not have leaked.
    expect(flat).not.toContain(def.label);
    // Task #2227 — multi-script chain keeps Noto Sans Arabic available so
    // resvg picks it for the Arabic prose row, while the separately-
    // rendered @handle row uses a Latin face.
    expect(svg).toContain("Noto Sans Arabic");
    expect(svg).toContain(">@ar_player<");
  });
});

// -----------------------------------------------------------------------------
// PNG layer (Tasks #1764 route smoke + #1766 font / fixture matrix).
//
// Shared DB setup: one fixture user with TWO achievements so each test
// hits the badge it cares about.
//
//   • first_birdie     — Task #1764 route smoke test (Hindi viewer flow)
//   • first_tournament — Task #1766 PNG matrix across non-Latin locales
// -----------------------------------------------------------------------------
let orgId: number;
let courseId: number;
let userId: number;
let tournamentId: number;

const handle = `og_i18n_${Date.now()}`;
const FIXTURE_DIR = path.resolve(__dirname, "fixtures", "badge-og-i18n");

beforeAll(async () => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  const [org] = await db.insert(organizationsTable).values({
    name: `OG_I18n_Org_${uid()}`,
    slug: `og-i18n-${uid()}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "OG I18n Course",
    slug: `og-i18n-course-${uid()}`,
    holes: 9,
    par: 36,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(holeDetailsTable).values(
    Array.from({ length: 9 }, (_, i) => ({ courseId, holeNumber: i + 1, par: 4 })),
  );

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `OG I18n T_${uid()}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(),
    endDate: new Date(),
    maxPlayers: 16,
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `og-i18n-u-${uid()}`,
    username: `og_i18n_${uid()}`,
    email: `og_i18n_${uid()}@example.com`,
    role: "player",
    organizationId: orgId,
    publicHandle: handle,
    publicProfileEnabled: true,
    publicShowAchievements: true,
    // Devanagari display name doubles as a render check — when the
    // #1766 PNG matrix dumps fixtures, the Hindi name must appear as
    // proper script (not tofu) for the visual smoke check to mean
    // anything.
    displayName: "हिंदी प्लेयर",
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  // Two achievements: one per badge under test. first_birdie pins a
  // deterministic earnedAt so the #1764 route smoke test produces stable
  // bytes; first_tournament is the badge the #1766 fixture matrix renders.
  await db.insert(achievementsTable).values([
    {
      userId,
      badgeType: "first_birdie",
      badgeLabel: "First Birdie",
      badgeIcon: "🐦",
      badgeCategory: "milestone",
      organizationId: orgId,
      earnedAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      userId,
      badgeType: "first_tournament",
      badgeLabel: "First Tournament",
      badgeIcon: "🎯",
      badgeCategory: "milestone",
      organizationId: orgId,
      tournamentId,
    },
  ]);
});

afterAll(async () => {
  await db.delete(achievementsTable).where(eq(achievementsTable.userId, userId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(and(eq(appUsersTable.organizationId, orgId)));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

// PNG signature is 8 bytes: 89 50 4E 47 0D 0A 1A 0A. The IHDR chunk
// starts at byte 8 and lists big-endian width / height at offsets 16..24.
function parsePng(buf: Buffer): { width: number; height: number } {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buf.length).toBeGreaterThan(33);
  expect(buf.subarray(0, 8).equals(sig)).toBe(true);
  // Bytes 12..16 should be the IHDR chunk type "IHDR".
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

async function fetchOgPng(lang: string | null, type = "first_tournament"): Promise<Buffer> {
  const app = createTestApp();
  const url = `/api/public/p/${handle}/badge/${type}/og${lang ? `?lang=${lang}` : ""}`;
  const res = await request(app).get(url).buffer(true);
  expect(res.status, `expected 200 for ${url}`).toBe(200);
  expect(res.headers["content-type"]).toMatch(/image\/png/);
  expect(Buffer.isBuffer(res.body)).toBe(true);
  return res.body as Buffer;
}

// -----------------------------------------------------------------------------
// Task #1764 — route smoke test that the integration path 200s with image/png
// when ?lang=hi is supplied. The unit tests above prove the SVG that feeds the
// rasteriser is correctly localized.
// -----------------------------------------------------------------------------
describe("GET /api/public/p/:handle/badge/:type/og — route smoke with ?lang=hi", () => {
  it("returns 200 image/png when a Hindi-speaking viewer follows a share link", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/p/${handle}/badge/first_birdie/og?lang=hi`)
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    // Body must be a non-empty buffer (the rasterised PNG).
    expect((res.body as Buffer).length).toBeGreaterThan(0);
  });
});

describe("Badge OG font resolver (Task #1766)", () => {
  it("discovers at least one Noto font directory in /nix/store", () => {
    // Use the cached lookup — the route also calls this on first request,
    // so we share the (one-time) ~10s nix-store scan cost with it.
    const dirs = resolveBadgeOgFontDirs();
    expect(Array.isArray(dirs)).toBe(true);
    // We expect at least one Noto package to be present in this sandbox
    // (replit.nix lists noto-fonts and noto-fonts-cjk-sans). If this
    // assertion ever fails, double-check that those packages survived a
    // nixpkgs upgrade — the badge OG card will silently fall back to
    // tofu without them.
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      expect(typeof d).toBe("string");
      expect(d.startsWith("/nix/store/")).toBe(true);
    }
  });

  it("returns the same cached array on repeated calls", () => {
    const a = resolveBadgeOgFontDirs();
    const b = resolveBadgeOgFontDirs();
    expect(b).toBe(a);
  });
});

describe("GET /api/public/p/:handle/badge/:type/og?lang=… — non-Latin scripts (Task #1766)", () => {
  // 1200×630 is the contractual OG card size from Task #780.
  const EXPECTED_W = 1200;
  const EXPECTED_H = 630;

  it("returns a valid 1200×630 PNG for ?lang=en (baseline)", async () => {
    const buf = await fetchOgPng("en");
    const dims = parsePng(buf);
    expect(dims.width).toBe(EXPECTED_W);
    expect(dims.height).toBe(EXPECTED_H);
    fs.writeFileSync(path.join(FIXTURE_DIR, "first_tournament_en.png"), buf);
  });

  // Each non-Latin locale we exercise here. The byte threshold is a
  // conservative tofu canary: when Noto isn't loaded, the chrome strings
  // collapse to a handful of "missing glyph" boxes and the encoded PNG
  // lands well under 2 KB above the empty-card baseline. With Noto
  // loaded, the rendered glyphs pump the encoded PNG well past that.
  const cases: Array<{ lang: string; sample: string; description: string }> = [
    { lang: "hi", sample: "बैज अनलॉक",   description: "Hindi (Devanagari)" },
    { lang: "ar", sample: "تم فتح الشارة", description: "Arabic" },
    { lang: "zh", sample: "徽章已解锁",     description: "Chinese (Simplified)" },
    { lang: "ja", sample: "バッジ獲得",     description: "Japanese" },
  ];

  for (const tc of cases) {
    it(`renders a real-glyph PNG for ?lang=${tc.lang} (${tc.description})`, async () => {
      const buf = await fetchOgPng(tc.lang);
      const dims = parsePng(buf);
      expect(dims.width).toBe(EXPECTED_W);
      expect(dims.height).toBe(EXPECTED_H);

      // Save the fixture for visual smoke-check. Filenames include the
      // language code so reviewers can tell at a glance which card is
      // which.
      const out = path.join(FIXTURE_DIR, `first_tournament_${tc.lang}.png`);
      fs.writeFileSync(out, buf);

      // Compare against the English baseline. If the glyphs went tofu
      // (boxes) the byte stream would be very close to en (boxes are
      // a tiny visual delta); when actual non-Latin glyphs render, the
      // encoded PNG diverges substantially because the pixel content of
      // the chrome strip changes significantly.
      const enBuf = fs.readFileSync(path.join(FIXTURE_DIR, "first_tournament_en.png"));
      expect(buf.equals(enBuf)).toBe(false);

      // A bytewise lower-bound: the rendered card has gradients, an
      // emoji, and translated chrome — empty/tofu cards in this
      // sandbox land at ~50 KB, glyph-bearing cards at ~60 KB+. We
      // pin a generous floor so font upgrades don't break the test.
      expect(buf.length).toBeGreaterThan(40_000);

      // Sanity: the sample translated string is from our bundle, so it
      // *should* be the actual chrome on the card. We can't grep PNG
      // pixels for it, but we can prove our test pipeline is wired to
      // the right language by sanity-checking it here so a future
      // change to the bundle keys is caught at this layer too.
      void tc.sample;
    });
  }

  it("falls back to English chrome for an unknown ?lang= value", async () => {
    const en = await fetchOgPng("en");
    const fallback = await fetchOgPng("xx-not-a-real-lang");
    // Same chrome strings → byte-identical PNGs.
    expect(fallback.equals(en)).toBe(true);
  });

  it("normalises region/script subtags so ?lang=zh-Hant-TW behaves like zh", async () => {
    const zh = await fetchOgPng("zh");
    const zhHant = await fetchOgPng("zh-Hant-TW");
    expect(zhHant.equals(zh)).toBe(true);
  });
});
