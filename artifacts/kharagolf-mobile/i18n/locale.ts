// Tiny, dependency-light helper for resolving the active BCP-47 locale.
//
// Lives in its own module (rather than next to the i18next bootstrap in
// `./index`) so utilities like `formatRelativeTime` (Task #1659 →
// Task #2059) can read the active locale without forcing every consumer
// to load `expo-localization`, the full bundle of locale JSON, and the
// `i18n.use(initReactI18next).init(...)` side effect at module-import
// time. That keeps unit tests for screens that only need
// `formatRelativeTime` (HoleMapSheet undo history, feed, marker, …)
// loadable without mocking the entire i18n stack.
//
// The full `./index` module re-exports `getLocale` from here so the
// existing `import { getLocale } from "@/i18n"` call-sites across the
// app keep working unchanged.
import i18n from "i18next";

export const LOCALE_MAP: Record<string, string> = {
  en: "en-IN",
  hi: "hi-IN",
  ar: "ar-AE",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  pt: "pt-BR",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
  th: "th-TH",
  ms: "ms-MY",
  id: "id-ID",
  vi: "vi-VN",
  fil: "fil-PH",
  sw: "sw-KE",
  af: "af-ZA",
  am: "am-ET",
  ha: "ha-NG",
  zu: "zu-ZA",
  yo: "yo-NG",
};

export function getLocale(lang?: string): string {
  const l = lang ?? i18n.language ?? "en";
  return LOCALE_MAP[l] ?? l;
}
