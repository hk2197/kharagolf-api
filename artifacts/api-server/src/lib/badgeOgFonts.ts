/**
 * Task #1766 — Resolve the font directories that the badge OG image
 * rasteriser (`@resvg/resvg-js`) should load so non-Latin chrome strings
 * (Hindi, Arabic, Chinese, Japanese, Korean, Thai, …) render as proper
 * glyphs instead of tofu boxes.
 *
 * Why this exists: in the Replit / NixOS sandbox the only system fonts
 * fontconfig knows about are DejaVu, which has no Devanagari / Arabic /
 * CJK coverage. The Noto font packages (`noto-fonts`, `noto-fonts-cjk-sans`)
 * are listed in `replit.nix` and live under `/nix/store/<hash>-noto-fonts*`
 * but fontconfig does not auto-scan those store paths. resvg-js, however,
 * accepts an explicit `font.fontDirs` option, so we resolve the relevant
 * Noto directories at server start (cached) and pass them in.
 *
 * The resolver is intentionally tolerant: missing directories or unusual
 * package layouts simply fall through and resvg falls back to whatever
 * fontconfig finds. The badge OG endpoint will still produce a valid
 * (Latin-only) PNG if Noto isn't present.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const NIX_STORE = "/nix/store";

/**
 * Patterns of nix-store directory names whose `share/fonts` subtree we
 * want resvg to scan. We pick the most recently modified store path per
 * pattern so upgrading the underlying nixpkgs derivation doesn't require
 * a code change here.
 */
const FONT_PACKAGE_PATTERNS: RegExp[] = [
  /^[a-z0-9]+-noto-fonts-\d/,           // base Noto (Devanagari, Arabic, Thai, Latin, …)
  /^[a-z0-9]+-noto-fonts-cjk-sans-/,    // Chinese / Japanese / Korean (sans)
  /^[a-z0-9]+-noto-fonts-cjk-serif-/,   // CJK serif fallback
  /^[a-z0-9]+-noto-fonts-cjk-\d/,       // older combined CJK package layout
  /^[a-z0-9]+-noto-fonts-extra-/,       // extended scripts (Tibetan, etc.)
  // Emoji glyphs (Task #2226). We use the *monochrome* Noto Emoji font
  // rather than the color one on purpose: `@resvg/resvg-js` v2.6.x cannot
  // rasterise the CBDT bitmap tables that ship in `NotoColorEmoji.ttf`,
  // so loading it produces empty glyph slots. `NotoEmoji-Regular.ttf`
  // (family name "Noto Emoji") uses plain outline glyphs that resvg
  // renders cleanly. The badge OG SVG falls back to this font via the
  // `sans-serif` tail of its emoji font-family chain when none of the
  // colour-emoji families (Apple/Segoe/Noto Color) are present.
  /^[a-z0-9]+-noto-fonts-monochrome-emoji-/,
];

let cached: string[] | null = null;

function findFontSubdirs(rootDir: string): string[] {
  // Walk a small, bounded subtree under <package>/share/fonts collecting
  // any directory that actually contains font files. resvg discovers
  // .ttf / .otf / .ttc inside the directories we hand it.
  const fontsRoot = path.join(rootDir, "share", "fonts");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fontsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  const stack: string[] = [fontsRoot];
  let visited = 0;
  while (stack.length > 0 && visited < 64) {
    const dir = stack.pop()!;
    visited++;
    let subEntries: fs.Dirent[];
    try {
      subEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let hasFontFile = false;
    for (const e of subEntries) {
      if (e.isFile() && /\.(ttf|otf|ttc)$/i.test(e.name)) {
        hasFontFile = true;
      } else if (e.isDirectory()) {
        stack.push(path.join(dir, e.name));
      }
    }
    if (hasFontFile) out.push(dir);
  }
  void entries;
  return out;
}

/**
 * Returns a deduplicated list of absolute directories that contain Noto
 * font files we want resvg to load. Cached after the first call.
 *
 * Test hook: pass `forceRescan: true` to bypass the cache (used by tests
 * that want to assert the resolver itself works).
 */
export function resolveBadgeOgFontDirs(opts: { forceRescan?: boolean } = {}): string[] {
  if (cached && !opts.forceRescan) return cached;

  let storeEntries: string[];
  try {
    storeEntries = fs.readdirSync(NIX_STORE);
  } catch {
    cached = [];
    return cached;
  }

  // Group store paths by which pattern they match, then pick the
  // lexicographically last (≈ newest version) per group. We rely on the
  // version suffix being part of the directory name so a plain string sort
  // is good enough; this keeps the resolver dependency-free.
  const perPattern = new Map<RegExp, string>();
  for (const name of storeEntries) {
    for (const pat of FONT_PACKAGE_PATTERNS) {
      if (pat.test(name)) {
        const prev = perPattern.get(pat);
        if (!prev || name > prev) perPattern.set(pat, name);
      }
    }
  }

  const dirs = new Set<string>();
  for (const name of perPattern.values()) {
    const root = path.join(NIX_STORE, name);
    for (const sub of findFontSubdirs(root)) dirs.add(sub);
  }

  cached = Array.from(dirs);
  return cached;
}

/**
 * Test-only: clear the cache so the next call rescans. Useful when a
 * test wants to validate behaviour after the resolver has already run
 * during server startup.
 */
export function _resetBadgeOgFontDirsCacheForTests(): void {
  cached = null;
}
