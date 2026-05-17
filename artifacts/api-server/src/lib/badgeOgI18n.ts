/**
 * Task #1442 — Translations for the chrome strings rendered on the
 * shareable badge Open Graph image (`GET /api/public/p/:handle/badge/:type/og`).
 *
 * Only the labels that surround the (English) badge name and description are
 * translated here — the badge label/description themselves come from the
 * static catalog (`getBadgeDef(type)`) and remain in English. The 21 supported
 * languages mirror the mobile/website i18n bundle so a player who shares from,
 * e.g., the Hindi mobile app gets a Hindi-styled "BADGE UNLOCKED" / "ALMOST
 * THERE" / "Earned X · @handle" / "X of Y" / "Keep playing to unlock" hint
 * inside the social-card image their followers see.
 */

export type BadgeOgLang =
  | "af" | "am" | "ar" | "de" | "en" | "es" | "fil" | "fr"
  | "ha" | "hi" | "id" | "ja" | "ko" | "ms" | "pt" | "sw"
  | "th" | "vi" | "yo" | "zh" | "zu";

export const BADGE_OG_LANGS: BadgeOgLang[] = [
  "af", "am", "ar", "de", "en", "es", "fil", "fr",
  "ha", "hi", "id", "ja", "ko", "ms", "pt", "sw",
  "th", "vi", "yo", "zh", "zu",
];

const BADGE_OG_SET = new Set<string>(BADGE_OG_LANGS);

/** Resolve a possibly-loose `?lang=` value to one of the supported codes. */
export function normalizeBadgeOgLang(input: string | null | undefined): BadgeOgLang {
  if (!input) return "en";
  const lower = String(input).toLowerCase().trim();
  if (!lower) return "en";
  if (BADGE_OG_SET.has(lower)) return lower as BadgeOgLang;
  const primary = lower.split(/[-_]/, 1)[0];
  if (primary && BADGE_OG_SET.has(primary)) return primary as BadgeOgLang;
  return "en";
}

export type BadgeOgStrings = {
  /** Top-right ribbon on the unlocked card. Uppercased visually in SVG. */
  badgeUnlocked: string;
  /** Top-right ribbon on the locked card. Uppercased visually in SVG. */
  almostThere: string;
  /** Bottom strip on the unlocked card. {{date}} is locale-formatted. */
  earnedOn: string;
  /** "X of Y" hint on the locked card. */
  xOfY: string;
  /** Fallback hint when no numeric progress is tracked. */
  keepPlaying: string;
};

const T: Record<BadgeOgLang, BadgeOgStrings> = {
  en: { badgeUnlocked: "BADGE UNLOCKED", almostThere: "ALMOST THERE", earnedOn: "Earned {{date}} · @{{handle}}", xOfY: "{{current}} of {{target}}", keepPlaying: "Keep playing to unlock" },
  af: { badgeUnlocked: "KENTEKEN ONTSLUIT", almostThere: "AMPER DAAR", earnedOn: "Verdien op {{date}} · @{{handle}}", xOfY: "{{current}} van {{target}}", keepPlaying: "Speel verder om te ontsluit" },
  am: { badgeUnlocked: "ባጅ ተከፍቷል", almostThere: "ቀርቧል", earnedOn: "የተገኘ {{date}} · @{{handle}}", xOfY: "ከ{{target}} ውስጥ {{current}}", keepPlaying: "ለመክፈት መጫወት ቀጥል" },
  ar: { badgeUnlocked: "تم فتح الشارة", almostThere: "أوشكت", earnedOn: "اكتُسبت في {{date}} · @{{handle}}", xOfY: "{{current}} من {{target}}", keepPlaying: "واصل اللعب لفتحها" },
  de: { badgeUnlocked: "ABZEICHEN FREIGESCHALTET", almostThere: "FAST GESCHAFFT", earnedOn: "Erhalten am {{date}} · @{{handle}}", xOfY: "{{current}} von {{target}}", keepPlaying: "Spiel weiter zum Freischalten" },
  es: { badgeUnlocked: "INSIGNIA DESBLOQUEADA", almostThere: "CASI LO LOGRAS", earnedOn: "Obtenida el {{date}} · @{{handle}}", xOfY: "{{current}} de {{target}}", keepPlaying: "Sigue jugando para desbloquearla" },
  fil: { badgeUnlocked: "NA-UNLOCK ANG BADGE", almostThere: "MALAPIT NA", earnedOn: "Nakuha noong {{date}} · @{{handle}}", xOfY: "{{current}} sa {{target}}", keepPlaying: "Magpatuloy upang i-unlock" },
  fr: { badgeUnlocked: "BADGE DÉBLOQUÉ", almostThere: "PRESQUE !", earnedOn: "Obtenu le {{date}} · @{{handle}}", xOfY: "{{current}} sur {{target}}", keepPlaying: "Continuez à jouer pour débloquer" },
  ha: { badgeUnlocked: "AN SAMU LAMBAR YABO", almostThere: "KUSA ZA A KAI", earnedOn: "An samu a {{date}} · @{{handle}}", xOfY: "{{current}} cikin {{target}}", keepPlaying: "Ci gaba da wasa don buɗewa" },
  hi: { badgeUnlocked: "बैज अनलॉक", almostThere: "लगभग पहुँच गए", earnedOn: "{{date}} को अर्जित · @{{handle}}", xOfY: "{{target}} में से {{current}}", keepPlaying: "अनलॉक करने के लिए खेलते रहें" },
  id: { badgeUnlocked: "LENCANA TERBUKA", almostThere: "HAMPIR SAMPAI", earnedOn: "Diperoleh {{date}} · @{{handle}}", xOfY: "{{current}} dari {{target}}", keepPlaying: "Terus bermain untuk membukanya" },
  ja: { badgeUnlocked: "バッジ獲得", almostThere: "あと少し", earnedOn: "{{date}} に獲得 · @{{handle}}", xOfY: "{{target}}中{{current}}", keepPlaying: "獲得するためにプレーを続ける" },
  ko: { badgeUnlocked: "배지 획득", almostThere: "거의 다 왔어요", earnedOn: "{{date}} 획득 · @{{handle}}", xOfY: "{{target}} 중 {{current}}", keepPlaying: "잠금 해제하려면 계속 플레이" },
  ms: { badgeUnlocked: "LENCANA DIBUKA", almostThere: "HAMPIR SAMPAI", earnedOn: "Diperoleh {{date}} · @{{handle}}", xOfY: "{{current}} drpd {{target}}", keepPlaying: "Teruskan bermain untuk membukanya" },
  pt: { badgeUnlocked: "EMBLEMA DESBLOQUEADO", almostThere: "QUASE LÁ", earnedOn: "Conquistado em {{date}} · @{{handle}}", xOfY: "{{current}} de {{target}}", keepPlaying: "Continue jogando para desbloquear" },
  sw: { badgeUnlocked: "BEJI IMEFUNGULIWA", almostThere: "KARIBU KUFIKA", earnedOn: "Ilipatikana {{date}} · @{{handle}}", xOfY: "{{current}} kati ya {{target}}", keepPlaying: "Endelea kucheza ili kuifungua" },
  th: { badgeUnlocked: "ปลดล็อกเหรียญตราแล้ว", almostThere: "ใกล้แล้ว", earnedOn: "ได้รับเมื่อ {{date}} · @{{handle}}", xOfY: "{{current}} จาก {{target}}", keepPlaying: "เล่นต่อเพื่อปลดล็อก" },
  vi: { badgeUnlocked: "HUY HIỆU ĐÃ MỞ KHOÁ", almostThere: "SẮP ĐẠT RỒI", earnedOn: "Đạt được {{date}} · @{{handle}}", xOfY: "{{current}}/{{target}}", keepPlaying: "Tiếp tục chơi để mở khoá" },
  yo: { badgeUnlocked: "BAAJÌ TI ṢÍ", almostThere: "Ó FẸ́Ẹ́ TÓ", earnedOn: "Gba ní {{date}} · @{{handle}}", xOfY: "{{current}} nínú {{target}}", keepPlaying: "Máa ṣeré láti ṣí i sílẹ̀" },
  zh: { badgeUnlocked: "徽章已解锁", almostThere: "即将达成", earnedOn: "{{date}} 获得 · @{{handle}}", xOfY: "{{target}} 中的 {{current}}", keepPlaying: "继续打球以解锁" },
  zu: { badgeUnlocked: "IBHEJI IVULIWE", almostThere: "SEKUSEDUZE", earnedOn: "Itholwe ngo-{{date}} · @{{handle}}", xOfY: "{{current}} kwa-{{target}}", keepPlaying: "Qhubeka udlala ukuze uyivule" },
};

export function getBadgeOgStrings(lang: BadgeOgLang): BadgeOgStrings {
  return T[lang] ?? T.en;
}

/** Tiny `{{var}}` interpolator (no number formatting, callers pre-format). */
export function interpolateBadgeOg(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}
