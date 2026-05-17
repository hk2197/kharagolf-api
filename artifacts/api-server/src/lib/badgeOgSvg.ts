/**
 * Pure SVG builders for the public badge share card (`/api/public/p/:handle/badge/:type/og`).
 *
 * Extracted from `routes/public.ts` so that:
 *  1. The SVG markup can be unit-tested directly (without invoking the
 *     `@resvg/resvg-js` rasteriser, which writes binary PNG bytes that aren't
 *     greppable for translated text).
 *  2. The unlocked / locked branches reuse the same XML escaping helper and
 *     stay byte-aligned visually as the route logic evolves.
 *
 * The route layer is still responsible for:
 *  - Resolving the badge def, the viewer's locale, and the localized chrome
 *    strings (badgeOgI18n) and badge label/description (badgeI18n).
 *  - Rasterising the SVG to PNG.
 */

/**
 * XML-escape a string for safe interpolation into SVG `<text>` nodes.
 * Matches the helper that previously lived inline in `routes/public.ts`.
 */
export function escSvg(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Task #2227 — script-aware font-family chains.
 *
 * Background: `@resvg/resvg-js` (via usvg + rustybuzz) does NOT do true
 * per-glyph font fallback inside a single `<text>` run. For a given text
 * run it picks ONE font face — whichever first member of the SVG
 * `font-family` chain exists, or, when none exist, whichever fontdb font
 * happens to cover the most glyphs. Once that face is picked, any glyph
 * that face doesn't carry renders as a tofu box (□).
 *
 * The badge OG card has both pure-script rows (the top-right "बैज अनलॉक"
 * chrome, the localized badge label, etc.) and the mixed-script
 * "Earned <date> · @<handle>" row that triggered Task #2227. For the
 * pure-script rows, listing every script-specific Noto face we ship in
 * the chain lets resvg fall through to the correct face without us
 * having to know the viewer's locale here. For the mixed-script row,
 * the SVG builder splits it into two adjacent rows (date prose + handle)
 * so each row is single-script and resvg's per-run picker can land on
 * the right face for each.
 *
 * The chain ends in Arial / sans-serif so behaviour degrades gracefully
 * when (in CI / a sandbox without the Noto package) those families are
 * absent — resvg's implicit fontdb scan then takes over and at worst the
 * locale-specific glyphs render as tofu while the Latin chrome stays
 * legible.
 */
export const BADGE_OG_LATIN_STACK =
  "Noto Sans, Noto Sans Devanagari, Noto Sans Arabic, Noto Sans Ethiopic, " +
  "Noto Sans Thai, Noto Sans CJK SC, Noto Sans CJK JP, Noto Sans CJK KR, " +
  "Arial, sans-serif";

/**
 * Same coverage chain but rooted in Noto Serif so the (Georgia-styled)
 * badge label keeps a serif feel where a serif Noto exists, and falls
 * through to the script-specific sans face for non-Latin scripts.
 */
export const BADGE_OG_SERIF_STACK =
  "Noto Serif, Noto Sans Devanagari, Noto Sans Arabic, Noto Sans Ethiopic, " +
  "Noto Sans Thai, Noto Sans CJK SC, Noto Sans CJK JP, Noto Sans CJK KR, " +
  "Georgia, serif";

export interface BadgeOgUnlockedParams {
  /** Emoji glyph from the badge catalog (e.g. "🦅"). */
  icon: string;
  /** Localized badge label (e.g. "पहला बर्डी"). */
  badgeLabel: string;
  /** Localized badge description / tagline. */
  badgeDescription: string;
  /** Player display name. */
  name: string;
  /**
   * Localized "Earned on <date>" prose without the trailing handle.
   * May contain Devanagari / Arabic / CJK / Thai / Ethiopic glyphs alongside
   * Latin digits from the formatted date — that's still single-script enough
   * for resvg's per-run fallback (the script-specific Noto faces all carry
   * European digits).
   */
  earnedDateLine: string;
  /** Latin "@handle" rendered on its own line so resvg's font picker can
   * land on a Latin face for it without being pulled toward the Devanagari /
   * Arabic face the prose line needs. */
  handleLine: string;
  /** Localized "BADGE UNLOCKED" header chrome. */
  badgeUnlockedLabel: string;
}

export interface BadgeOgLockedParams {
  icon: string;
  badgeLabel: string;
  badgeDescription: string;
  /** Player display name (may be localized — Devanagari / Arabic / CJK). */
  name: string;
  /** Latin handle, rendered on its own line below the name for the same
   * mixed-script reason as the unlocked card's date row. */
  handle: string;
  /** Localized "ALMOST THERE" header chrome. */
  almostThereLabel: string;
  /** Localized "X of Y" or "Keep playing to unlock…" body line. */
  progressLabel: string;
  /** Progress fraction in [0, 1]; controls the fill bar width. */
  progressFraction: number;
}

/**
 * Build the SVG markup for the "badge unlocked" share card.
 *
 * Localized text rows use the multi-script font-family stacks defined
 * above so resvg can per-run fall back to the right Noto face for any
 * supported script (Latin / Devanagari / Arabic / CJK / Thai / Ethiopic).
 * The bottom-most "Earned …" row is split across two stacked `<text>`
 * elements (date prose / @handle) so each row stays single-script —
 * see Task #2227's notes on the BADGE_OG_*_STACK constants for the
 * resvg-specific reason.
 */
export function buildBadgeOgUnlockedSvg(params: BadgeOgUnlockedParams): string {
  const { icon, badgeLabel, badgeDescription, name, earnedDateLine, handleLine, badgeUnlockedLabel } = params;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#064e3b"/>
      <stop offset="100%" stop-color="#022c22"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="38%">
      <stop offset="0%" stop-color="#10b981" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#10b981" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <text x="60" y="78" font-family="Georgia, serif" font-size="26" fill="#a7f3d0" letter-spacing="6">KHARAGOLF</text>
  <text x="1140" y="78" font-family="${BADGE_OG_LATIN_STACK}" font-size="20" fill="#86efac" text-anchor="end" letter-spacing="3" opacity="0.85">${escSvg(badgeUnlockedLabel)}</text>
  <line x1="60" y1="100" x2="1140" y2="100" stroke="#10b981" stroke-width="1" opacity="0.35"/>
  <circle cx="600" cy="285" r="130" fill="#ffffff" opacity="0.08"/>
  <circle cx="600" cy="285" r="115" fill="#022c22" stroke="#fbbf24" stroke-width="3"/>
  <text x="600" y="330" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif" font-size="120" text-anchor="middle">${escSvg(icon)}</text>
  <text x="600" y="455" font-family="${BADGE_OG_SERIF_STACK}" font-size="56" fill="#ffffff" text-anchor="middle" font-weight="bold">${escSvg(badgeLabel)}</text>
  <text x="600" y="500" font-family="${BADGE_OG_LATIN_STACK}" font-size="22" fill="#d1fae5" text-anchor="middle" opacity="0.9">${escSvg(badgeDescription)}</text>
  <line x1="380" y1="535" x2="820" y2="535" stroke="#fbbf24" stroke-width="0.8" opacity="0.6"/>
  <text x="600" y="570" font-family="${BADGE_OG_LATIN_STACK}" font-size="26" fill="#fbbf24" text-anchor="middle" font-weight="bold">${escSvg(name)}</text>
  <text x="600" y="595" font-family="${BADGE_OG_LATIN_STACK}" font-size="16" fill="#86efac" text-anchor="middle" opacity="0.85">${escSvg(earnedDateLine)}</text>
  <text x="600" y="615" font-family="Arial, sans-serif" font-size="14" fill="#86efac" text-anchor="middle" opacity="0.75">${escSvg(handleLine)}</text>
</svg>`;
}

/**
 * Build the SVG markup for the "badge locked / almost there" share card.
 */
export function buildBadgeOgLockedSvg(params: BadgeOgLockedParams): string {
  const {
    icon,
    badgeLabel,
    badgeDescription,
    name,
    handle,
    almostThereLabel,
    progressLabel,
    progressFraction,
  } = params;
  const pct = Math.max(0, Math.min(1, progressFraction));
  const barX = 330;
  const barY = 525;
  const barW = 540;
  const barH = 18;
  const fillW = Math.round(barW * pct);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="bgL" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1f2937"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <radialGradient id="glowL" cx="50%" cy="42%" r="38%">
      <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#fbbf24" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="barFill" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#fbbf24"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bgL)"/>
  <rect width="1200" height="630" fill="url(#glowL)"/>
  <text x="60" y="78" font-family="Georgia, serif" font-size="26" fill="#cbd5e1" letter-spacing="6">KHARAGOLF</text>
  <text x="1140" y="78" font-family="${BADGE_OG_LATIN_STACK}" font-size="20" fill="#fbbf24" text-anchor="end" letter-spacing="3" opacity="0.9">${escSvg(almostThereLabel)}</text>
  <line x1="60" y1="100" x2="1140" y2="100" stroke="#fbbf24" stroke-width="1" opacity="0.3"/>
  <circle cx="600" cy="265" r="130" fill="#ffffff" opacity="0.05"/>
  <circle cx="600" cy="265" r="115" fill="#0f172a" stroke="#94a3b8" stroke-width="3" stroke-dasharray="6 6"/>
  <text x="600" y="310" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif" font-size="120" text-anchor="middle" opacity="0.55">${escSvg(icon)}</text>
  <text x="600" y="425" font-family="${BADGE_OG_SERIF_STACK}" font-size="52" fill="#ffffff" text-anchor="middle" font-weight="bold">${escSvg(badgeLabel)}</text>
  <text x="600" y="468" font-family="${BADGE_OG_LATIN_STACK}" font-size="20" fill="#cbd5e1" text-anchor="middle" opacity="0.9">${escSvg(badgeDescription)}</text>
  <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="9" fill="#1e293b" stroke="#334155" stroke-width="1"/>
  ${fillW > 0 ? `<rect x="${barX}" y="${barY}" width="${fillW}" height="${barH}" rx="9" fill="url(#barFill)"/>` : ""}
  <text x="600" y="572" font-family="${BADGE_OG_LATIN_STACK}" font-size="22" fill="#fbbf24" text-anchor="middle" font-weight="bold">${escSvg(progressLabel)}</text>
  <text x="600" y="597" font-family="${BADGE_OG_LATIN_STACK}" font-size="16" fill="#94a3b8" text-anchor="middle" opacity="0.9">${escSvg(name)}</text>
  <text x="600" y="617" font-family="Arial, sans-serif" font-size="14" fill="#94a3b8" text-anchor="middle" opacity="0.8">@${escSvg(handle)}</text>
</svg>`;
}

/**
 * Task #2227 helper — split the localized `earnedOn` template's interpolated
 * result into the two halves the SVG builder needs ("date prose" without
 * the trailing handle, and the bare "@handle" string).
 *
 * Every locale in `badgeOgI18n.ts` uses the literal separator " · @" between
 * the date prose and the handle (verified across all 21 supported langs at
 * the time of writing). We split on that separator. If the separator is
 * missing for any reason (malformed template, future locale change), we fall
 * back to treating the whole interpolated string as the date prose and
 * synthesising the handle from the route's bare `handle` value.
 */
export function splitEarnedLine(
  earnedLineInterpolated: string,
  handle: string,
): { earnedDateLine: string; handleLine: string } {
  const sep = " · @";
  const idx = earnedLineInterpolated.lastIndexOf(sep);
  if (idx >= 0) {
    return {
      earnedDateLine: earnedLineInterpolated.slice(0, idx),
      handleLine: "@" + earnedLineInterpolated.slice(idx + sep.length),
    };
  }
  return {
    earnedDateLine: earnedLineInterpolated,
    handleLine: "@" + handle,
  };
}
