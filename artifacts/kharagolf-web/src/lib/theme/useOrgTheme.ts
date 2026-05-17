/**
 * Per-club design-token override hook.
 *
 * Wave 0 / Task #935 W0-4 — the web app already uses CSS-variable-based
 * tokens (see `src/index.css :root`). Every shadcn component reads
 * `--primary`, `--accent`, `--background`, etc.  This hook injects per-club
 * overrides at runtime so a tenant can ship its own brand color without
 * any code change.
 *
 * Inputs are HEX strings from `club_theming.primary_color` /
 * `club_theming.accent_color`. They are converted to HSL space (the format
 * the CSS vars expect) and written to `:root` via a single `<style>` tag
 * managed by this hook. Removing the provider (logout, super-admin org
 * switch back to default) restores the defaults declared in `index.css`.
 *
 * Task #1438 — the same hook also swaps the browser tab favicon to the
 * org's `faviconUrl` (and restores the original `<link rel="icon">` href on
 * unmount / reset) so customers see their club's mark in the tab strip.
 *
 * Architectural rule (from #935): tokens are the only source of color.
 * Components must NOT hard-code hex values; consume `bg-primary`,
 * `text-foreground`, `border-border`, etc. instead.
 */
import { useEffect } from "react";

export interface OrgBranding {
  primaryColor?: string | null;
  accentColor?: string | null;
  /**
   * CSS font-family string applied as the `--font-display` token (and as
   * the document body font-family fallback). Accepts the same value the
   * club admin saved (e.g. `"Inter, sans-serif"`).
   */
  fontFamily?: string | null;
  /** Optional border-radius override (rem). */
  radius?: number | null;
  /** Public URL for the club's logo (rendered by consumers via context). */
  logoUrl?: string | null;
  /** Public URL for the club's favicon — swapped into the page <head>. */
  faviconUrl?: string | null;
}

const STYLE_TAG_ID = "kharagolf-org-theme-overrides";
const FAVICON_MARKER_ATTR = "data-kharagolf-org-favicon";
const FAVICON_PREV_HREF_ATTR = "data-kharagolf-prev-href";

function hexToHslTriplet(hex: string): string | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const intVal = parseInt(m[1], 16);
  const r = ((intVal >> 16) & 0xff) / 255;
  const g = ((intVal >> 8) & 0xff) / 255;
  const b = (intVal & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

function applyFavicon(faviconUrl: string | null | undefined): void {
  if (typeof document === "undefined") return;
  // Find the page's existing favicon link (declared in index.html as
  // `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`).
  const existing = document.querySelector<HTMLLinkElement>(
    `link[rel~="icon"]:not([${FAVICON_MARKER_ATTR}])`,
  );
  if (faviconUrl) {
    if (existing) {
      // Cache the original href once so we can put it back on reset.
      if (!existing.hasAttribute(FAVICON_PREV_HREF_ATTR)) {
        existing.setAttribute(FAVICON_PREV_HREF_ATTR, existing.href);
      }
      existing.href = faviconUrl;
      // The browser caches favicons aggressively; remove `type` so it
      // re-evaluates the bytes when the URL points at a different format
      // (e.g. PNG club logo replacing the default SVG).
      existing.removeAttribute("type");
    } else {
      const tag = document.createElement("link");
      tag.rel = "icon";
      tag.href = faviconUrl;
      tag.setAttribute(FAVICON_MARKER_ATTR, "1");
      document.head.appendChild(tag);
    }
  } else if (existing && existing.hasAttribute(FAVICON_PREV_HREF_ATTR)) {
    // Restore the original href that was overwritten earlier.
    const prev = existing.getAttribute(FAVICON_PREV_HREF_ATTR) ?? "";
    existing.href = prev;
    existing.removeAttribute(FAVICON_PREV_HREF_ATTR);
    existing.type = "image/svg+xml";
  }
}

export function useOrgTheme(branding: OrgBranding | null | undefined): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const overrides: string[] = [];

    if (branding?.primaryColor) {
      const hsl = hexToHslTriplet(branding.primaryColor);
      if (hsl) {
        overrides.push(`--primary: ${hsl};`);
        overrides.push(`--ring: ${hsl};`);
      }
    }
    if (branding?.accentColor) {
      const hsl = hexToHslTriplet(branding.accentColor);
      if (hsl) overrides.push(`--accent: ${hsl};`);
    }
    if (branding?.fontFamily) {
      // Quote-safe: only allow a basic font name with comma-separated fallback.
      const sanitized = branding.fontFamily.replace(/[<>"]/g, "").trim();
      if (sanitized.length > 0) {
        // Wrap the first family in quotes so multi-word names ("Open Sans")
        // survive; if the saved value already lists fallbacks (commas), use
        // it verbatim.
        const fontDecl = sanitized.includes(",")
          ? sanitized
          : `'${sanitized}', sans-serif`;
        overrides.push(`--font-display: ${fontDecl};`);
      }
    }
    if (branding?.radius != null && Number.isFinite(branding.radius)) {
      overrides.push(`--radius: ${branding.radius}rem;`);
    }

    let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;
    if (overrides.length === 0) {
      tag?.remove();
    } else {
      if (!tag) {
        tag = document.createElement("style");
        tag.id = STYLE_TAG_ID;
        document.head.appendChild(tag);
      }
      tag.textContent = `:root { ${overrides.join(" ")} }`;
    }

    applyFavicon(branding?.faviconUrl ?? null);

    return () => {
      // Leave overrides in place on re-render; only clean up on unmount of
      // the topmost provider (handled by the consumer choosing when to
      // re-render with branding === null).
    };
  }, [
    branding?.primaryColor,
    branding?.accentColor,
    branding?.fontFamily,
    branding?.radius,
    branding?.faviconUrl,
  ]);
}
