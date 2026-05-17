// Import `getLocale` from the dependency-light `./locale` module
// (rather than `./index`) so consumers of this helper don't pull the
// heavy i18n bootstrap and its top-level `expo-localization` import
// into their module-load chain. Critical for unit tests that newly
// route through `formatRelativeTime` (HoleMapSheet undo history, feed,
// marker, …) — they can now load without mocking the full i18n stack.
import i18n from "i18next";
import { getLocale } from "./locale";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

type Unit = "second" | "minute" | "hour" | "day" | "month" | "year";

function bucket(absMs: number): { value: number; unit: Unit } {
  if (absMs < MINUTE) return { value: Math.round(absMs / SECOND), unit: "second" };
  if (absMs < HOUR) return { value: Math.round(absMs / MINUTE), unit: "minute" };
  if (absMs < DAY) return { value: Math.round(absMs / HOUR), unit: "hour" };
  if (absMs < MONTH) return { value: Math.round(absMs / DAY), unit: "day" };
  if (absMs < YEAR) return { value: Math.round(absMs / MONTH), unit: "month" };
  return { value: Math.round(absMs / YEAR), unit: "year" };
}

function fallbackFormat(value: number, unit: Unit, past: boolean): string {
  const plural = value === 1 ? unit : `${unit}s`;
  return past ? `${value} ${plural} ago` : `in ${value} ${plural}`;
}

/**
 * Look up a translated past/future template from the `relative` namespace
 * inside `handicapCommittee.json` (Task #2101).
 *
 * Returns `null` when i18n is not initialised, the locale's bundle is
 * unavailable, or the catalogue keys are missing — so callers can fall
 * back to `Intl.RelativeTimeFormat`.
 *
 * `count` is forwarded so i18next's plural-rule resolver picks the right
 * suffix per CLDR (`_one`, `_two`, `_few`, `_many`, `_other`, `_zero`)
 * for the active language.
 */
function tryCatalogueFormat(
  value: number,
  unit: Unit,
  past: boolean,
  lng: string | undefined,
): string | null {
  const path = `relative.${past ? "past" : "future"}.${unit}`;
  const opts: Record<string, unknown> = {
    ns: "handicapCommittee",
    count: value,
    // Empty `defaultValue` lets us tell "missing key" from "successful
    // translation" without a separate `i18n.exists()` round-trip — which
    // would have to be called with `count` to honour plural suffixes anyway,
    // and was unreliable across i18next versions in practice.
    defaultValue: "",
    // Disable i18next's automatic fallback to `en` for this single lookup.
    // Otherwise a locale whose catalogue happens not to be loaded (e.g. in
    // a unit test that only registers the `en` bundle) would silently
    // resolve to the English template — defeating the whole point of
    // Task #2101 by leaking English into a non-English session. When the
    // requested locale really has no catalogue we return `null` and let
    // the caller fall back to `Intl.RelativeTimeFormat` instead.
    fallbackLng: false,
  };
  if (lng) opts.lng = lng;
  try {
    if (typeof i18n.t !== "function") return null;
    const result = i18n.t(path, opts);
    if (typeof result === "string" && result.length > 0 && result !== path) {
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

export function formatRelativeTime(
  when: string | number | Date,
  lang?: string,
): string {
  // Accept ISO strings (the original signature from Task #1659) plus the
  // raw `Date` / millisecond timestamps that older inline helpers use, so
  // every "X minutes ago" caller in the app can route through this helper
  // without each call-site having to convert formats first.
  const then =
    when instanceof Date
      ? when.getTime()
      : typeof when === "number"
        ? when
        : new Date(when).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const past = diffMs >= 0;
  const { value, unit } = bucket(Math.abs(diffMs));
  const signed = past ? -value : value;

  // Prefer the translated `relative` catalogue (Task #2101) so non-English
  // sentences like "Seen {{relative}}" no longer embed an English fragment
  // when Hermes / the host JS engine ships incomplete ICU data for a
  // smaller-community locale (ha, am, yo, zu, …). The catalogue applies
  // each language's CLDR plural rules via i18next.
  //
  // We derive the i18next language code from `getLocale(lang)` rather than
  // `i18n.language` directly so the active-locale source of truth is the
  // same one already used by the Intl fallback below — avoiding subtle
  // drift in tests (which mock `getLocale` but not `i18n.language`) and
  // keeping the helper honest even if a caller bypasses
  // `i18n.changeLanguage()`.
  const i18nLng = (lang ?? getLocale()).split("-")[0];
  const translated = tryCatalogueFormat(value, unit, past, i18nLng);
  if (translated) return translated;

  try {
    const rtf = new Intl.RelativeTimeFormat(getLocale(lang), { numeric: "always" });
    return rtf.format(signed, unit);
  } catch {
    return fallbackFormat(value, unit, past);
  }
}
