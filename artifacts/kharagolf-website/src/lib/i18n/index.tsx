/**
 * Task #1765 — Site-wide locale provider for the kharagolf-website artifact.
 *
 * Goals:
 *   - Detect the visitor's preferred language on first load.
 *     Order: localStorage `kharagolf:lang` → `navigator.language` → `en`.
 *   - Persist the visitor's choice across sessions.
 *   - Apply `<html lang>` and `<html dir>` globally so screen readers,
 *     browser translate prompts and CSS direction-sensitive rules all
 *     pick up the active locale.
 *   - Expose a tiny `useT()` hook that pages and components import to
 *     translate marketing copy (`t("home.hero.titleLine1")`).
 *
 * Notes:
 *   - We deliberately do NOT pull in `react-i18next`. The site bundle is a
 *     single-file Record (`site.ts`); a 40-line provider is enough and
 *     keeps the dependency graph small. The mobile app uses i18next
 *     because it has 21 separate JSON files per locale; the website's
 *     translation surface is much smaller.
 *   - The badge page (Task #1442) keeps its own `?lang=` URL override —
 *     see `src/pages/public-badge.tsx`. The override takes precedence
 *     over the stored preference so OG previews remain correct when a
 *     player shares a badge link in a different language than the
 *     recipient's browser.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  RTL_SITE_LANGS,
  SITE_LANG_LABELS,
  SUPPORTED_SITE_LANGS,
  getSiteString,
  type SiteKey,
  type SiteLang,
} from "./site";
import { interpolate, normalizeBadgeLang } from "./badges";

const STORAGE_KEY = "kharagolf:lang";
const STORAGE_EVENT = "kharagolf:lang-changed";

interface SetLangOptions {
  /**
   * Whether to write the new language back to `localStorage`. Defaults to
   * true (the user opened the header switcher and picked a language). The
   * badge page uses `persist: false` when honouring an explicit `?lang=`
   * URL override so a recipient who clicked an Arabic share link doesn't
   * silently end up with their site preference flipped to Arabic for
   * every subsequent visit.
   */
  persist?: boolean;
}

interface LocaleContextValue {
  lang: SiteLang;
  setLang: (lang: SiteLang, opts?: SetLangOptions) => void;
  t: (key: SiteKey, vars?: Record<string, string | number>) => string;
  isRtl: boolean;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * Pure helper exposed for tests + the badge page.
 *
 * Resolves the language to use given:
 *   - an optional explicit override (e.g. `?lang=` query param), takes
 *     precedence over everything else (used by the badge page so shared
 *     links keep the sender's language regardless of recipient setup),
 *   - the persisted user preference,
 *   - the browser's reported `navigator.language`,
 *   - English as the final fallback.
 */
export function resolveInitialLang(opts?: {
  explicit?: string | null;
  stored?: string | null;
  browser?: string | null;
}): SiteLang {
  const explicit = opts?.explicit;
  if (explicit) {
    const norm = normalizeBadgeLang(explicit, "en");
    // Only honour the explicit override if it resolves to a supported
    // language — otherwise we'd downgrade an invalid `?lang=xx` URL into
    // English even when the user has a stored preference of, say, "es".
    if (explicit && norm !== "en") return norm;
    if (norm === "en" && /^en($|[-_])/i.test(explicit)) return "en";
  }
  const stored = opts?.stored;
  if (stored) {
    const norm = normalizeBadgeLang(stored, "en");
    if (norm !== "en" || /^en($|[-_])/i.test(stored)) return norm;
  }
  const browser = opts?.browser;
  if (browser) {
    return normalizeBadgeLang(browser, "en");
  }
  return "en";
}

function readStoredLang(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredLang(lang: SiteLang) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* private browsing / quota — best-effort persistence */
  }
}

function readBrowserLang(): string | null {
  if (typeof navigator === "undefined") return null;
  return navigator.language ?? null;
}

interface LocaleProviderProps {
  children: ReactNode;
  /**
   * Test-only seed for the initial language. In production we always
   * detect from `localStorage`/`navigator.language`.
   */
  initialLang?: SiteLang;
}

export function LocaleProvider({ children, initialLang }: LocaleProviderProps) {
  const [lang, setLangState] = useState<SiteLang>(() => {
    if (initialLang) return initialLang;
    return resolveInitialLang({
      stored: readStoredLang(),
      browser: readBrowserLang(),
    });
  });

  // Keep <html lang> / <html dir> in sync whenever the language changes.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL_SITE_LANGS.has(lang) ? "rtl" : "ltr";
  }, [lang]);

  // Listen for language changes fired by other tabs / components so the
  // UI stays consistent if the user opens two windows of the marketing
  // site and toggles the switcher in one of them.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<SiteLang>).detail;
      if (detail && detail !== lang) setLangState(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      const norm = normalizeBadgeLang(e.newValue, "en");
      if (norm !== lang) setLangState(norm);
    };
    window.addEventListener(STORAGE_EVENT, onCustom as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(STORAGE_EVENT, onCustom as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, [lang]);

  const setLang = useCallback((next: SiteLang, opts?: SetLangOptions) => {
    const norm = normalizeBadgeLang(next, "en");
    setLangState(norm);
    if (opts?.persist !== false) {
      writeStoredLang(norm);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent<SiteLang>(STORAGE_EVENT, { detail: norm }));
      }
    }
  }, []);

  const t = useCallback(
    (key: SiteKey, vars?: Record<string, string | number>) => {
      const template = getSiteString(lang, key);
      return vars ? interpolate(template, vars) : template;
    },
    [lang],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({ lang, setLang, t, isRtl: RTL_SITE_LANGS.has(lang) }),
    [lang, setLang, t],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** Read the current locale + setter. */
export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useLocale must be used inside a <LocaleProvider>");
  }
  return ctx;
}

/** Convenience: just the translator. */
export function useT() {
  return useLocale().t;
}

export { SUPPORTED_SITE_LANGS, SITE_LANG_LABELS };
export type { SiteLang, SiteKey };
export { interpolate } from "./badges";
