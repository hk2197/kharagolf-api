/**
 * Task #1765 — Header language switcher for the marketing site.
 *
 * Renders a small `<select>`-based dropdown listing every supported locale
 * by its endonym (e.g. "हिन्दी" for Hindi). Choosing a language calls
 * `setLang` on the locale context which:
 *   - persists the choice to `localStorage` (`kharagolf:lang`),
 *   - flips `<html lang>` / `<html dir>` globally,
 *   - re-renders every component that consumed `useT()`.
 *
 * We deliberately use a native `<select>` rather than a Radix dropdown so
 * the switcher works inside the header on mobile (large finger target,
 * native iOS/Android picker) and prints fine on the capability report.
 */

import { Globe } from "lucide-react";
import {
  SITE_LANG_LABELS,
  SUPPORTED_SITE_LANGS,
  useLocale,
  type SiteLang,
} from "@/lib/i18n";

interface LanguageSwitcherProps {
  /** Tailwind classes for the outer wrapper. */
  className?: string;
  /** Visual variant. `light` = dark text on light bg; `dark` = light text. */
  variant?: "light" | "dark";
}

export function LanguageSwitcher({ className = "", variant = "dark" }: LanguageSwitcherProps) {
  const { lang, setLang, t } = useLocale();

  const isDark = variant === "dark";
  const wrapperBase = isDark
    ? "border border-white/15 bg-white/5 text-white hover:bg-white/10"
    : "border border-gray-300 bg-white text-gray-900 hover:bg-gray-50";

  return (
    <label
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs cursor-pointer transition-colors ${wrapperBase} ${className}`}
      data-testid="language-switcher"
    >
      <Globe className="w-3.5 h-3.5 opacity-80" aria-hidden />
      <span className="sr-only">{t("lang.switchTo")}</span>
      <select
        aria-label={t("lang.label")}
        className="bg-transparent text-current text-xs font-medium uppercase tracking-wider focus:outline-none cursor-pointer pr-1"
        value={lang}
        onChange={(e) => setLang(e.target.value as SiteLang)}
        data-testid="language-switcher-select"
      >
        {SUPPORTED_SITE_LANGS.map((l) => (
          <option key={l} value={l} className="text-gray-900">
            {SITE_LANG_LABELS[l]} ({l.toUpperCase()})
          </option>
        ))}
      </select>
    </label>
  );
}

export default LanguageSwitcher;
