/**
 * Task #1442 — i18n bundle for the public badge landing page
 * (`/p/<handle>/badge/<type>`).
 *
 * The kharagolf-website artifact does not (yet) ship a general-purpose i18n
 * runtime, but the public badge page is reachable from share links sent by
 * the mobile app where every share message is already localised. So when a
 * Hindi or Arabic-speaking player shares a badge to WhatsApp, the destination
 * page must render in the same language so the on-page copy and the
 * link-preview card agree with the share message.
 *
 * Design choices:
 *
 * 1. The supported language list mirrors the mobile bundle exactly
 *    (`SUPPORTED_BADGE_LANGS`) so a key like `badges.shareMessageUnlocked`
 *    on either side can be translated together. Where a key is also present
 *    in the mobile `profile.json` `badges` block, the value here is kept
 *    byte-equivalent so the two surfaces produce identical share text.
 *
 * 2. Language is picked up from a `?lang=xx` query param (the mobile share
 *    URL appends this), then from `navigator.language`, then `en`. That
 *    keeps the page works for shared-link recipients on devices with a
 *    different locale (the OG card and on-page hero will still match the
 *    language the sharer used) AND for direct browser visitors (they get
 *    their own browser locale).
 *
 * 3. A tiny in-file translator (`tBadge`) interpolates `{{var}}` tokens.
 *    No runtime dependency on i18next is required for this single page.
 */

export type BadgeLang =
  | "af" | "am" | "ar" | "de" | "en" | "es" | "fil" | "fr"
  | "ha" | "hi" | "id" | "ja" | "ko" | "ms" | "pt" | "sw"
  | "th" | "vi" | "yo" | "zh" | "zu";

export const SUPPORTED_BADGE_LANGS: BadgeLang[] = [
  "af", "am", "ar", "de", "en", "es", "fil", "fr",
  "ha", "hi", "id", "ja", "ko", "ms", "pt", "sw",
  "th", "vi", "yo", "zh", "zu",
];

const SUPPORTED_SET = new Set<string>(SUPPORTED_BADGE_LANGS);

/**
 * Languages that read right-to-left. Used by the public badge page to set
 * `dir="rtl"` on its outermost element so Arabic copy lays out correctly.
 */
export const RTL_BADGE_LANGS: ReadonlySet<BadgeLang> = new Set<BadgeLang>(["ar"]);

/**
 * Resolve a possibly-loose language code to one of our supported codes.
 * Accepts:
 *   - `?lang=hi` → "hi"
 *   - `?lang=zh-Hant-TW` → "zh"
 *   - `navigator.language = "pt-BR"` → "pt"
 * Falls back to `defaultLang` (default "en") for anything unknown.
 */
export function normalizeBadgeLang(input: string | null | undefined, defaultLang: BadgeLang = "en"): BadgeLang {
  if (!input) return defaultLang;
  const lower = String(input).toLowerCase().trim();
  if (!lower) return defaultLang;
  if (SUPPORTED_SET.has(lower)) return lower as BadgeLang;
  const primary = lower.split(/[-_]/, 1)[0];
  if (primary && SUPPORTED_SET.has(primary)) return primary as BadgeLang;
  return defaultLang;
}

export type BadgeStrings = {
  // Shared with mobile profile.json `badges` block (same key names + vars).
  shareTitle: string;                // {{label}} {{handle}}
  shareMessageUnlocked: string;      // {{label}} {{icon}} {{url}}
  shareMessageLocked: string;        // {{label}} {{icon}} {{url}}
  shareMessageLockedProgress: string; // {{label}} {{icon}} {{current}} {{target}} {{url}}

  // Web-only (not present on mobile share sheet).
  pageTitleUnlocked: string;     // {{name}} {{label}}
  pageTitleLocked: string;       // {{name}} {{label}} {{progress}}
  metaDescUnlocked: string;      // {{name}} {{label}} {{icon}} {{description}}
  metaDescLocked: string;        // {{name}} {{label}} {{icon}} {{progress}} {{description}}
  progressInline: string;        // {{current}} {{target}} — ` (X of Y)` snippet

  badgeUnlocked: string;
  almostThere: string;
  earnedOn: string;              // {{date}} {{handle}}
  progressLabel: string;
  xOfY: string;                  // {{current}} {{target}}
  keepPlaying: string;

  shareThisBadge: string;
  shareYourProgress: string;
  shareDescUnlocked: string;
  shareDescLocked: string;
  copyShareLink: string;
  linkCopied: string;
  shareNative: string;

  notFoundTitle: string;
  notFoundDesc: string;
  viewProfile: string;           // {{handle}}
  backTo: string;                // {{handle}}
  footer: string;                // {{year}}
};

const en: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} on KHARAGOLF",
  shareMessageUnlocked: "I just unlocked the “{{label}}” {{icon}} badge on KHARAGOLF! {{url}}",
  shareMessageLocked: "I'm closing in on the “{{label}}” {{icon}} badge on KHARAGOLF {{url}}",
  shareMessageLockedProgress: "I'm closing in on the “{{label}}” {{icon}} badge on KHARAGOLF — {{current}} of {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} unlocked “{{label}}” — KHARAGOLF",
  pageTitleLocked: "{{name}} is closing in on “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} just unlocked the {{label}} badge {{icon}} on KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} is working toward the {{label}} badge {{icon}}{{progress}} on KHARAGOLF. {{description}}",
  progressInline: " ({{current}} of {{target}})",

  badgeUnlocked: "Badge unlocked",
  almostThere: "Almost there",
  earnedOn: "Earned {{date}} · @{{handle}}",
  progressLabel: "Progress",
  xOfY: "{{current}} of {{target}}",
  keepPlaying: "Keep playing to unlock this badge.",

  shareThisBadge: "Share this badge",
  shareYourProgress: "Share your progress",
  shareDescUnlocked: "Show off your achievement on social media. Anyone with the link will see this card.",
  shareDescLocked: "Brag about being almost there. Anyone with the link will see your progress card.",
  copyShareLink: "Copy share link",
  linkCopied: "Link copied!",
  shareNative: "Share…",

  notFoundTitle: "Badge not found",
  notFoundDesc: "This player either has hidden their achievements, the badge type is unknown, or the link is incorrect.",
  viewProfile: "View {{handle}}'s profile",
  backTo: "Back to @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Badges are awarded automatically based on rounds played.",
};

const af: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} op KHARAGOLF",
  shareMessageUnlocked: "Ek het pas die “{{label}}” {{icon}}-kenteken op KHARAGOLF ontsluit! {{url}}",
  shareMessageLocked: "Ek is amper by die “{{label}}” {{icon}}-kenteken op KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Ek is amper by die “{{label}}” {{icon}}-kenteken op KHARAGOLF — {{current}} van {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} het “{{label}}” ontsluit — KHARAGOLF",
  pageTitleLocked: "{{name}} is amper by “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} het pas die {{label}}-kenteken {{icon}} op KHARAGOLF ontsluit. {{description}}",
  metaDescLocked: "{{name}} werk aan die {{label}}-kenteken {{icon}}{{progress}} op KHARAGOLF. {{description}}",
  progressInline: " ({{current}} van {{target}})",

  badgeUnlocked: "Kenteken ontsluit",
  almostThere: "Amper daar",
  earnedOn: "Verdien op {{date}} · @{{handle}}",
  progressLabel: "Vordering",
  xOfY: "{{current}} van {{target}}",
  keepPlaying: "Speel verder om hierdie kenteken te ontsluit.",

  shareThisBadge: "Deel hierdie kenteken",
  shareYourProgress: "Deel jou vordering",
  shareDescUnlocked: "Wys jou prestasie op sosiale media. Almal met die skakel sal hierdie kaart sien.",
  shareDescLocked: "Spog dat jy amper daar is. Almal met die skakel sal jou vorderingskaart sien.",
  copyShareLink: "Kopieer deelskakel",
  linkCopied: "Skakel gekopieer!",
  shareNative: "Deel…",

  notFoundTitle: "Kenteken nie gevind nie",
  notFoundDesc: "Hierdie speler het óf hul prestasies versteek, die kentekentipe is onbekend, óf die skakel is verkeerd.",
  viewProfile: "Bekyk {{handle}} se profiel",
  backTo: "Terug na @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Kentekens word outomaties op grond van rondtes toegeken.",
};

const am: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} በ KHARAGOLF",
  shareMessageUnlocked: "በKHARAGOLF ላይ የ“{{label}}” {{icon}} ባጅ አሁን ከፈትኩ! {{url}}",
  shareMessageLocked: "በKHARAGOLF ላይ የ“{{label}}” {{icon}} ባጅን ሊከፍት ቀርቤያለሁ {{url}}",
  shareMessageLockedProgress: "በKHARAGOLF ላይ የ“{{label}}” {{icon}} ባጅን ሊከፍት ቀርቤያለሁ — ከ{{target}} ውስጥ {{current}}! {{url}}",

  pageTitleUnlocked: "{{name}} የ“{{label}}” ባጅን ከፈተ — KHARAGOLF",
  pageTitleLocked: "{{name}} ወደ “{{label}}” እየቀረበ ነው{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} በ KHARAGOLF ላይ የ{{label}} ባጅ {{icon}} አሁን ከፈተ። {{description}}",
  metaDescLocked: "{{name}} በ KHARAGOLF ላይ የ{{label}} ባጅ {{icon}}{{progress}} ላይ እየሰራ ነው። {{description}}",
  progressInline: " (ከ{{target}} ውስጥ {{current}})",

  badgeUnlocked: "ባጅ ተከፍቷል",
  almostThere: "ቀርቧል",
  earnedOn: "የተገኘ {{date}} · @{{handle}}",
  progressLabel: "እድገት",
  xOfY: "ከ{{target}} ውስጥ {{current}}",
  keepPlaying: "ይህን ባጅ ለመክፈት መጫወት ቀጥል።",

  shareThisBadge: "ይህንን ባጅ አጋራ",
  shareYourProgress: "እድገትህን አጋራ",
  shareDescUnlocked: "ስኬትህን በማህበራዊ ድህረ-ገጾች ላይ አሳይ። ሊንኩ ያለው ሁሉ ይህን ካርድ ያያል።",
  shareDescLocked: "ስለመቀረብህ ኩራ። ሊንኩ ያለው ሁሉ የእድገት ካርድህን ያያል።",
  copyShareLink: "የማጋራት አገናኝ ቅዳ",
  linkCopied: "አገናኝ ተቀድቷል!",
  shareNative: "አጋራ…",

  notFoundTitle: "ባጅ አልተገኘም",
  notFoundDesc: "ይህ ተጫዋች ስኬቶቹን ደብቆ ሊሆን ይችላል፣ የባጅ ዓይነቱ የማይታወቅ ነው ወይም አገናኙ ስህተት ነው።",
  viewProfile: "የ{{handle}} መገለጫ ይመልከቱ",
  backTo: "ወደ @{{handle}} ተመለስ",
  footer: "© {{year}} KHARAGOLF. ባጆች በተጫወቱት ዙሮች ላይ በመመስረት በራስ-ሰር ይሰጣሉ።",
};

const ar: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} على KHARAGOLF",
  shareMessageUnlocked: "لقد فتحت للتو شارة “{{label}}” {{icon}} على KHARAGOLF! {{url}}",
  shareMessageLocked: "أوشكت على فتح شارة “{{label}}” {{icon}} على KHARAGOLF {{url}}",
  shareMessageLockedProgress: "أوشكت على فتح شارة “{{label}}” {{icon}} على KHARAGOLF — {{current}} من {{target}}! {{url}}",

  pageTitleUnlocked: "فتح {{name}} شارة “{{label}}” — KHARAGOLF",
  pageTitleLocked: "{{name}} يقترب من شارة “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "فتح {{name}} للتو شارة {{label}} {{icon}} على KHARAGOLF. {{description}}",
  metaDescLocked: "يعمل {{name}} على الحصول على شارة {{label}} {{icon}}{{progress}} على KHARAGOLF. {{description}}",
  progressInline: " ({{current}} من {{target}})",

  badgeUnlocked: "تم فتح الشارة",
  almostThere: "أوشكت",
  earnedOn: "اكتُسبت في {{date}} · @{{handle}}",
  progressLabel: "التقدّم",
  xOfY: "{{current}} من {{target}}",
  keepPlaying: "واصل اللعب لفتح هذه الشارة.",

  shareThisBadge: "شارك هذه الشارة",
  shareYourProgress: "شارك تقدّمك",
  shareDescUnlocked: "اعرض إنجازك على وسائل التواصل الاجتماعي. سيرى أي شخص لديه الرابط هذه البطاقة.",
  shareDescLocked: "تباهَ بأنك أوشكت على الوصول. سيرى أي شخص لديه الرابط بطاقة تقدّمك.",
  copyShareLink: "نسخ رابط المشاركة",
  linkCopied: "تم نسخ الرابط!",
  shareNative: "مشاركة…",

  notFoundTitle: "لم يتم العثور على الشارة",
  notFoundDesc: "إما أن هذا اللاعب أخفى إنجازاته، أو أن نوع الشارة غير معروف، أو أن الرابط غير صحيح.",
  viewProfile: "عرض ملف @{{handle}}",
  backTo: "الرجوع إلى @{{handle}}",
  footer: "© {{year}} KHARAGOLF. تُمنح الشارات تلقائياً بناءً على الجولات الملعوبة.",
};

const de: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} auf KHARAGOLF",
  shareMessageUnlocked: "Ich habe gerade das Abzeichen „{{label}}“ {{icon}} auf KHARAGOLF freigeschaltet! {{url}}",
  shareMessageLocked: "Ich bin kurz davor, das Abzeichen „{{label}}“ {{icon}} auf KHARAGOLF freizuschalten {{url}}",
  shareMessageLockedProgress: "Ich bin kurz davor, das Abzeichen „{{label}}“ {{icon}} auf KHARAGOLF freizuschalten — {{current}} von {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} hat „{{label}}“ freigeschaltet — KHARAGOLF",
  pageTitleLocked: "{{name}} ist kurz vor „{{label}}“{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} hat gerade das Abzeichen {{label}} {{icon}} auf KHARAGOLF freigeschaltet. {{description}}",
  metaDescLocked: "{{name}} arbeitet auf das Abzeichen {{label}} {{icon}}{{progress}} auf KHARAGOLF hin. {{description}}",
  progressInline: " ({{current}} von {{target}})",

  badgeUnlocked: "Abzeichen freigeschaltet",
  almostThere: "Fast geschafft",
  earnedOn: "Erhalten am {{date}} · @{{handle}}",
  progressLabel: "Fortschritt",
  xOfY: "{{current}} von {{target}}",
  keepPlaying: "Spiel weiter, um dieses Abzeichen freizuschalten.",

  shareThisBadge: "Dieses Abzeichen teilen",
  shareYourProgress: "Fortschritt teilen",
  shareDescUnlocked: "Zeige deinen Erfolg in den sozialen Medien. Jeder mit dem Link sieht diese Karte.",
  shareDescLocked: "Pose damit, dass du fast da bist. Jeder mit dem Link sieht deine Fortschrittskarte.",
  copyShareLink: "Teilen-Link kopieren",
  linkCopied: "Link kopiert!",
  shareNative: "Teilen…",

  notFoundTitle: "Abzeichen nicht gefunden",
  notFoundDesc: "Diese Person hat ihre Erfolge entweder ausgeblendet, der Abzeichen-Typ ist unbekannt oder der Link ist falsch.",
  viewProfile: "Profil von {{handle}} ansehen",
  backTo: "Zurück zu @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Abzeichen werden automatisch anhand gespielter Runden vergeben.",
};

const es: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} en KHARAGOLF",
  shareMessageUnlocked: "¡Acabo de desbloquear la insignia “{{label}}” {{icon}} en KHARAGOLF! {{url}}",
  shareMessageLocked: "Estoy cerca de conseguir la insignia “{{label}}” {{icon}} en KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Estoy cerca de conseguir la insignia “{{label}}” {{icon}} en KHARAGOLF — ¡{{current}} de {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} desbloqueó “{{label}}” — KHARAGOLF",
  pageTitleLocked: "{{name}} está cerca de “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} acaba de desbloquear la insignia {{label}} {{icon}} en KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} está trabajando para conseguir la insignia {{label}} {{icon}}{{progress}} en KHARAGOLF. {{description}}",
  progressInline: " ({{current}} de {{target}})",

  badgeUnlocked: "Insignia desbloqueada",
  almostThere: "Casi lo logras",
  earnedOn: "Obtenida el {{date}} · @{{handle}}",
  progressLabel: "Progreso",
  xOfY: "{{current}} de {{target}}",
  keepPlaying: "Sigue jugando para desbloquear esta insignia.",

  shareThisBadge: "Compartir esta insignia",
  shareYourProgress: "Compartir tu progreso",
  shareDescUnlocked: "Muestra tu logro en redes sociales. Quien tenga el enlace verá esta tarjeta.",
  shareDescLocked: "Presume que ya casi llegas. Quien tenga el enlace verá tu tarjeta de progreso.",
  copyShareLink: "Copiar enlace para compartir",
  linkCopied: "¡Enlace copiado!",
  shareNative: "Compartir…",

  notFoundTitle: "Insignia no encontrada",
  notFoundDesc: "Este jugador ha ocultado sus logros, el tipo de insignia es desconocido o el enlace es incorrecto.",
  viewProfile: "Ver el perfil de {{handle}}",
  backTo: "Volver a @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Las insignias se otorgan automáticamente según las rondas jugadas.",
};

const fil: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} sa KHARAGOLF",
  shareMessageUnlocked: "Na-unlock ko na ang “{{label}}” {{icon}} badge sa KHARAGOLF! {{url}}",
  shareMessageLocked: "Malapit ko nang ma-unlock ang “{{label}}” {{icon}} badge sa KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Malapit ko nang ma-unlock ang “{{label}}” {{icon}} badge sa KHARAGOLF — {{current}} sa {{target}}! {{url}}",

  pageTitleUnlocked: "Na-unlock ni {{name}} ang “{{label}}” — KHARAGOLF",
  pageTitleLocked: "Malapit nang ma-unlock ni {{name}} ang “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "Na-unlock ni {{name}} ang {{label}} badge {{icon}} sa KHARAGOLF. {{description}}",
  metaDescLocked: "Pinupuntirya ni {{name}} ang {{label}} badge {{icon}}{{progress}} sa KHARAGOLF. {{description}}",
  progressInline: " ({{current}} sa {{target}})",

  badgeUnlocked: "Na-unlock ang badge",
  almostThere: "Malapit na",
  earnedOn: "Nakuha noong {{date}} · @{{handle}}",
  progressLabel: "Progress",
  xOfY: "{{current}} sa {{target}}",
  keepPlaying: "Magpatuloy sa paglalaro para ma-unlock ang badge na ito.",

  shareThisBadge: "I-share ang badge na ito",
  shareYourProgress: "I-share ang progress mo",
  shareDescUnlocked: "Ipagmalaki ang tagumpay mo sa social media. Makikita ng sinumang may link ang card na ito.",
  shareDescLocked: "Ipagyabang na malapit ka na. Makikita ng sinumang may link ang progress card mo.",
  copyShareLink: "Kopyahin ang share link",
  linkCopied: "Nakopya ang link!",
  shareNative: "I-share…",

  notFoundTitle: "Hindi nahanap ang badge",
  notFoundDesc: "Maaaring itinago ng manlalarong ito ang kanyang mga tagumpay, hindi kilala ang uri ng badge, o mali ang link.",
  viewProfile: "Tingnan ang profile ni {{handle}}",
  backTo: "Bumalik kay @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Awtomatikong ipinagkakaloob ang mga badge batay sa mga rondang nilaro.",
};

const fr: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} sur KHARAGOLF",
  shareMessageUnlocked: "Je viens de débloquer le badge « {{label}} » {{icon}} sur KHARAGOLF ! {{url}}",
  shareMessageLocked: "Je m'approche du badge « {{label}} » {{icon}} sur KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Je m'approche du badge « {{label}} » {{icon}} sur KHARAGOLF — {{current}} sur {{target}} ! {{url}}",

  pageTitleUnlocked: "{{name}} a débloqué « {{label}} » — KHARAGOLF",
  pageTitleLocked: "{{name}} approche du badge « {{label}} »{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} vient de débloquer le badge {{label}} {{icon}} sur KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} progresse vers le badge {{label}} {{icon}}{{progress}} sur KHARAGOLF. {{description}}",
  progressInline: " ({{current}} sur {{target}})",

  badgeUnlocked: "Badge débloqué",
  almostThere: "Presque !",
  earnedOn: "Obtenu le {{date}} · @{{handle}}",
  progressLabel: "Progression",
  xOfY: "{{current}} sur {{target}}",
  keepPlaying: "Continuez à jouer pour débloquer ce badge.",

  shareThisBadge: "Partager ce badge",
  shareYourProgress: "Partager votre progression",
  shareDescUnlocked: "Affichez votre succès sur les réseaux sociaux. Toute personne disposant du lien verra cette carte.",
  shareDescLocked: "Frimez : vous y êtes presque. Toute personne disposant du lien verra votre carte de progression.",
  copyShareLink: "Copier le lien de partage",
  linkCopied: "Lien copié !",
  shareNative: "Partager…",

  notFoundTitle: "Badge introuvable",
  notFoundDesc: "Soit ce joueur a masqué ses succès, soit le type de badge est inconnu, soit le lien est incorrect.",
  viewProfile: "Voir le profil de {{handle}}",
  backTo: "Retour vers @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Les badges sont attribués automatiquement selon les parties jouées.",
};

const ha: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} a KHARAGOLF",
  shareMessageUnlocked: "Na samu lambar yabo ta “{{label}}” {{icon}} a KHARAGOLF! {{url}}",
  shareMessageLocked: "Ina kusa da samun lambar yabo ta “{{label}}” {{icon}} a KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Ina kusa da samun lambar yabo ta “{{label}}” {{icon}} a KHARAGOLF — {{current}} cikin {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} ya samu “{{label}}” — KHARAGOLF",
  pageTitleLocked: "{{name}} yana kusa da “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} ya samu lambar yabo ta {{label}} {{icon}} a KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} yana aiki kan lambar yabo ta {{label}} {{icon}}{{progress}} a KHARAGOLF. {{description}}",
  progressInline: " ({{current}} cikin {{target}})",

  badgeUnlocked: "An samu lambar yabo",
  almostThere: "Kusa za a kai",
  earnedOn: "An samu a {{date}} · @{{handle}}",
  progressLabel: "Ci gaba",
  xOfY: "{{current}} cikin {{target}}",
  keepPlaying: "Ci gaba da wasa don buɗe wannan lambar yabo.",

  shareThisBadge: "Raba wannan lambar yabo",
  shareYourProgress: "Raba ci gabanka",
  shareDescUnlocked: "Nuna nasararka a kafofin sada zumunta. Duk wanda yake da hanyar haɗin zai ga wannan katin.",
  shareDescLocked: "Yi alfahari da kasancewa kusa. Duk wanda yake da hanyar haɗin zai ga katin ci gabanka.",
  copyShareLink: "Kwafi hanyar haɗin rabawa",
  linkCopied: "An kwafi hanyar haɗin!",
  shareNative: "Raba…",

  notFoundTitle: "Ba a sami lambar yabo ba",
  notFoundDesc: "Ko dai wannan ɗan wasan ya ɓoye nasarorinsa, nau'in lambar yabo ba a sani ba, ko hanyar haɗin ba daidai ba ce.",
  viewProfile: "Duba bayanan @{{handle}}",
  backTo: "Komawa zuwa @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Ana ba da lambobin yabo ta atomatik bisa ga zagaye da aka buga.",
};

const hi: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} KHARAGOLF पर",
  shareMessageUnlocked: "मैंने अभी KHARAGOLF पर “{{label}}” {{icon}} बैज अनलॉक किया! {{url}}",
  shareMessageLocked: "मैं KHARAGOLF पर “{{label}}” {{icon}} बैज के करीब हूँ {{url}}",
  shareMessageLockedProgress: "मैं KHARAGOLF पर “{{label}}” {{icon}} बैज के करीब हूँ — {{target}} में से {{current}}! {{url}}",

  pageTitleUnlocked: "{{name}} ने “{{label}}” अनलॉक किया — KHARAGOLF",
  pageTitleLocked: "{{name}} “{{label}}”{{progress}} के करीब है — KHARAGOLF",
  metaDescUnlocked: "{{name}} ने अभी KHARAGOLF पर {{label}} बैज {{icon}} अनलॉक किया। {{description}}",
  metaDescLocked: "{{name}} KHARAGOLF पर {{label}} बैज {{icon}}{{progress}} पाने की दिशा में है। {{description}}",
  progressInline: " ({{target}} में से {{current}})",

  badgeUnlocked: "बैज अनलॉक",
  almostThere: "लगभग पहुँच गए",
  earnedOn: "{{date}} को अर्जित · @{{handle}}",
  progressLabel: "प्रगति",
  xOfY: "{{target}} में से {{current}}",
  keepPlaying: "इस बैज को अनलॉक करने के लिए खेलते रहें।",

  shareThisBadge: "यह बैज शेयर करें",
  shareYourProgress: "अपनी प्रगति शेयर करें",
  shareDescUnlocked: "सोशल मीडिया पर अपनी उपलब्धि दिखाएँ। लिंक वाला कोई भी व्यक्ति यह कार्ड देख सकेगा।",
  shareDescLocked: "इस पर गर्व करें कि आप लगभग पहुँच चुके हैं। लिंक वाला कोई भी व्यक्ति आपका प्रगति कार्ड देख सकेगा।",
  copyShareLink: "शेयर लिंक कॉपी करें",
  linkCopied: "लिंक कॉपी हो गया!",
  shareNative: "शेयर करें…",

  notFoundTitle: "बैज नहीं मिला",
  notFoundDesc: "या तो इस खिलाड़ी ने अपनी उपलब्धियाँ छिपा रखी हैं, बैज प्रकार अज्ञात है, या लिंक गलत है।",
  viewProfile: "{{handle}} की प्रोफ़ाइल देखें",
  backTo: "@{{handle}} पर वापस जाएँ",
  footer: "© {{year}} KHARAGOLF. खेले गए राउंड के आधार पर बैज स्वतः प्रदान किए जाते हैं।",
};

const id: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} di KHARAGOLF",
  shareMessageUnlocked: "Saya baru saja membuka lencana “{{label}}” {{icon}} di KHARAGOLF! {{url}}",
  shareMessageLocked: "Saya hampir mendapatkan lencana “{{label}}” {{icon}} di KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Saya hampir mendapatkan lencana “{{label}}” {{icon}} di KHARAGOLF — {{current}} dari {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} membuka “{{label}}” — KHARAGOLF",
  pageTitleLocked: "{{name}} hampir mendapatkan “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} baru saja membuka lencana {{label}} {{icon}} di KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} sedang berusaha mendapatkan lencana {{label}} {{icon}}{{progress}} di KHARAGOLF. {{description}}",
  progressInline: " ({{current}} dari {{target}})",

  badgeUnlocked: "Lencana terbuka",
  almostThere: "Hampir sampai",
  earnedOn: "Diperoleh {{date}} · @{{handle}}",
  progressLabel: "Progres",
  xOfY: "{{current}} dari {{target}}",
  keepPlaying: "Terus bermain untuk membuka lencana ini.",

  shareThisBadge: "Bagikan lencana ini",
  shareYourProgress: "Bagikan progresmu",
  shareDescUnlocked: "Pamerkan pencapaianmu di media sosial. Siapa pun dengan tautan ini akan melihat kartu ini.",
  shareDescLocked: "Bangga karena hampir sampai. Siapa pun dengan tautan ini akan melihat kartu progresmu.",
  copyShareLink: "Salin tautan berbagi",
  linkCopied: "Tautan disalin!",
  shareNative: "Bagikan…",

  notFoundTitle: "Lencana tidak ditemukan",
  notFoundDesc: "Pemain ini menyembunyikan pencapaiannya, jenis lencana tidak dikenal, atau tautannya salah.",
  viewProfile: "Lihat profil {{handle}}",
  backTo: "Kembali ke @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Lencana diberikan otomatis berdasarkan ronde yang dimainkan.",
};

const ja: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} KHARAGOLF",
  shareMessageUnlocked: "KHARAGOLFで「{{label}}」{{icon}} バッジを獲得しました！ {{url}}",
  shareMessageLocked: "KHARAGOLFで「{{label}}」{{icon}} バッジまであと少しです {{url}}",
  shareMessageLockedProgress: "KHARAGOLFで「{{label}}」{{icon}} バッジまであと少し — {{target}}中{{current}}！ {{url}}",

  pageTitleUnlocked: "{{name}} が「{{label}}」を獲得しました — KHARAGOLF",
  pageTitleLocked: "{{name}} が「{{label}}」まであと少し{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} がKHARAGOLFで {{label}} バッジ {{icon}} を獲得しました。{{description}}",
  metaDescLocked: "{{name}} はKHARAGOLFで {{label}} バッジ {{icon}}{{progress}} の獲得を目指しています。{{description}}",
  progressInline: "（{{target}}中{{current}}）",

  badgeUnlocked: "バッジ獲得",
  almostThere: "あと少し",
  earnedOn: "{{date}} に獲得 · @{{handle}}",
  progressLabel: "進捗",
  xOfY: "{{target}}中{{current}}",
  keepPlaying: "このバッジを獲得するためにプレーを続けましょう。",

  shareThisBadge: "このバッジを共有",
  shareYourProgress: "進捗を共有",
  shareDescUnlocked: "SNSで成果をアピール。リンクを知っている人は誰でもこのカードを見られます。",
  shareDescLocked: "あと少しという進捗を自慢しましょう。リンクを知っている人は誰でも進捗カードを見られます。",
  copyShareLink: "共有リンクをコピー",
  linkCopied: "リンクをコピーしました！",
  shareNative: "共有…",

  notFoundTitle: "バッジが見つかりません",
  notFoundDesc: "このプレーヤーは実績を非公開にしているか、バッジの種類が不明か、リンクが正しくありません。",
  viewProfile: "{{handle}} のプロフィールを見る",
  backTo: "@{{handle}} に戻る",
  footer: "© {{year}} KHARAGOLF. バッジはプレーされたラウンドに基づいて自動的に授与されます。",
};

const ko: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} KHARAGOLF",
  shareMessageUnlocked: "방금 KHARAGOLF에서 “{{label}}” {{icon}} 배지를 획득했어요! {{url}}",
  shareMessageLocked: "KHARAGOLF에서 “{{label}}” {{icon}} 배지를 거의 다 얻었어요 {{url}}",
  shareMessageLockedProgress: "KHARAGOLF에서 “{{label}}” {{icon}} 배지를 거의 다 얻었어요 — {{target}} 중 {{current}}! {{url}}",

  pageTitleUnlocked: "{{name}} 님이 “{{label}}” 배지를 획득했어요 — KHARAGOLF",
  pageTitleLocked: "{{name}} 님이 “{{label}}” 배지에 거의 다 왔어요{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} 님이 방금 KHARAGOLF에서 {{label}} 배지 {{icon}} 를 획득했어요. {{description}}",
  metaDescLocked: "{{name}} 님이 KHARAGOLF에서 {{label}} 배지 {{icon}}{{progress}} 를 향해 가고 있어요. {{description}}",
  progressInline: " ({{target}} 중 {{current}})",

  badgeUnlocked: "배지 획득",
  almostThere: "거의 다 왔어요",
  earnedOn: "{{date}} 획득 · @{{handle}}",
  progressLabel: "진행 상황",
  xOfY: "{{target}} 중 {{current}}",
  keepPlaying: "이 배지를 잠금 해제하려면 계속 플레이하세요.",

  shareThisBadge: "이 배지 공유",
  shareYourProgress: "진행 상황 공유",
  shareDescUnlocked: "성과를 SNS에서 자랑하세요. 링크가 있는 누구나 이 카드를 볼 수 있어요.",
  shareDescLocked: "거의 다 왔다는 사실을 자랑하세요. 링크가 있는 누구나 진행 상황 카드를 볼 수 있어요.",
  copyShareLink: "공유 링크 복사",
  linkCopied: "링크가 복사되었어요!",
  shareNative: "공유…",

  notFoundTitle: "배지를 찾을 수 없어요",
  notFoundDesc: "이 플레이어가 업적을 숨겼거나, 배지 종류가 알 수 없거나, 링크가 잘못되었습니다.",
  viewProfile: "{{handle}} 님의 프로필 보기",
  backTo: "@{{handle}} 님에게 돌아가기",
  footer: "© {{year}} KHARAGOLF. 배지는 플레이한 라운드를 기준으로 자동 부여됩니다.",
};

const ms: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} di KHARAGOLF",
  shareMessageUnlocked: "Saya baru sahaja membuka lencana “{{label}}” {{icon}} di KHARAGOLF! {{url}}",
  shareMessageLocked: "Saya hampir mendapat lencana “{{label}}” {{icon}} di KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Saya hampir mendapat lencana “{{label}}” {{icon}} di KHARAGOLF — {{current}} daripada {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} membuka “{{label}}” — KHARAGOLF",
  pageTitleLocked: "{{name}} hampir mendapat “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} baru sahaja membuka lencana {{label}} {{icon}} di KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} sedang berusaha mendapatkan lencana {{label}} {{icon}}{{progress}} di KHARAGOLF. {{description}}",
  progressInline: " ({{current}} daripada {{target}})",

  badgeUnlocked: "Lencana dibuka",
  almostThere: "Hampir sampai",
  earnedOn: "Diperoleh {{date}} · @{{handle}}",
  progressLabel: "Kemajuan",
  xOfY: "{{current}} daripada {{target}}",
  keepPlaying: "Teruskan bermain untuk membuka lencana ini.",

  shareThisBadge: "Kongsi lencana ini",
  shareYourProgress: "Kongsi kemajuan anda",
  shareDescUnlocked: "Tunjukkan pencapaian anda di media sosial. Sesiapa yang ada pautan akan melihat kad ini.",
  shareDescLocked: "Bangga kerana hampir sampai. Sesiapa yang ada pautan akan melihat kad kemajuan anda.",
  copyShareLink: "Salin pautan berkongsi",
  linkCopied: "Pautan disalin!",
  shareNative: "Kongsi…",

  notFoundTitle: "Lencana tidak ditemui",
  notFoundDesc: "Pemain ini menyembunyikan pencapaiannya, jenis lencana tidak dikenali, atau pautan salah.",
  viewProfile: "Lihat profil {{handle}}",
  backTo: "Kembali ke @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Lencana diberikan secara automatik berdasarkan pusingan yang dimainkan.",
};

const pt: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} no KHARAGOLF",
  shareMessageUnlocked: "Acabei de desbloquear o emblema “{{label}}” {{icon}} no KHARAGOLF! {{url}}",
  shareMessageLocked: "Estou perto de conquistar o emblema “{{label}}” {{icon}} no KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Estou perto de conquistar o emblema “{{label}}” {{icon}} no KHARAGOLF — {{current}} de {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} desbloqueou “{{label}}” — KHARAGOLF",
  pageTitleLocked: "{{name}} está perto de “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} acabou de desbloquear o emblema {{label}} {{icon}} no KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} está trabalhando para conquistar o emblema {{label}} {{icon}}{{progress}} no KHARAGOLF. {{description}}",
  progressInline: " ({{current}} de {{target}})",

  badgeUnlocked: "Emblema desbloqueado",
  almostThere: "Quase lá",
  earnedOn: "Conquistado em {{date}} · @{{handle}}",
  progressLabel: "Progresso",
  xOfY: "{{current}} de {{target}}",
  keepPlaying: "Continue jogando para desbloquear este emblema.",

  shareThisBadge: "Compartilhar este emblema",
  shareYourProgress: "Compartilhar seu progresso",
  shareDescUnlocked: "Mostre sua conquista nas redes sociais. Quem tiver o link verá este card.",
  shareDescLocked: "Mostre que está quase lá. Quem tiver o link verá seu card de progresso.",
  copyShareLink: "Copiar link de compartilhamento",
  linkCopied: "Link copiado!",
  shareNative: "Compartilhar…",

  notFoundTitle: "Emblema não encontrado",
  notFoundDesc: "Este jogador ocultou suas conquistas, o tipo de emblema é desconhecido ou o link está incorreto.",
  viewProfile: "Ver o perfil de {{handle}}",
  backTo: "Voltar para @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Os emblemas são concedidos automaticamente com base nas rodadas jogadas.",
};

const sw: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} kwenye KHARAGOLF",
  shareMessageUnlocked: "Nimefungua tu beji ya “{{label}}” {{icon}} kwenye KHARAGOLF! {{url}}",
  shareMessageLocked: "Niko karibu kupata beji ya “{{label}}” {{icon}} kwenye KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Niko karibu kupata beji ya “{{label}}” {{icon}} kwenye KHARAGOLF — {{current}} kati ya {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} amefungua “{{label}}” — KHARAGOLF",
  pageTitleLocked: "{{name}} yuko karibu kupata “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} amefungua tu beji ya {{label}} {{icon}} kwenye KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} anajitahidi kupata beji ya {{label}} {{icon}}{{progress}} kwenye KHARAGOLF. {{description}}",
  progressInline: " ({{current}} kati ya {{target}})",

  badgeUnlocked: "Beji imefunguliwa",
  almostThere: "Karibu kufika",
  earnedOn: "Ilipatikana {{date}} · @{{handle}}",
  progressLabel: "Maendeleo",
  xOfY: "{{current}} kati ya {{target}}",
  keepPlaying: "Endelea kucheza ili kufungua beji hii.",

  shareThisBadge: "Shiriki beji hii",
  shareYourProgress: "Shiriki maendeleo yako",
  shareDescUnlocked: "Onyesha mafanikio yako kwenye mitandao ya kijamii. Mtu yeyote mwenye kiungo ataona kadi hii.",
  shareDescLocked: "Jivunie kuwa karibu kufika. Mtu yeyote mwenye kiungo ataona kadi yako ya maendeleo.",
  copyShareLink: "Nakili kiungo cha kushiriki",
  linkCopied: "Kiungo kimenakiliwa!",
  shareNative: "Shiriki…",

  notFoundTitle: "Beji haijapatikana",
  notFoundDesc: "Mchezaji huyu ameficha mafanikio yake, aina ya beji haijulikani, au kiungo si sahihi.",
  viewProfile: "Tazama wasifu wa {{handle}}",
  backTo: "Rudi kwa @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Beji hutolewa kiotomatiki kulingana na raundi zilizochezwa.",
};

const th: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} บน KHARAGOLF",
  shareMessageUnlocked: "ฉันเพิ่งปลดล็อกเหรียญตรา “{{label}}” {{icon}} บน KHARAGOLF! {{url}}",
  shareMessageLocked: "ฉันใกล้จะได้เหรียญตรา “{{label}}” {{icon}} บน KHARAGOLF แล้ว {{url}}",
  shareMessageLockedProgress: "ฉันใกล้จะได้เหรียญตรา “{{label}}” {{icon}} บน KHARAGOLF แล้ว — {{current}} จาก {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} ปลดล็อก “{{label}}” แล้ว — KHARAGOLF",
  pageTitleLocked: "{{name}} ใกล้จะได้ “{{label}}” แล้ว{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} เพิ่งปลดล็อกเหรียญตรา {{label}} {{icon}} บน KHARAGOLF {{description}}",
  metaDescLocked: "{{name}} กำลังพยายามได้เหรียญตรา {{label}} {{icon}}{{progress}} บน KHARAGOLF {{description}}",
  progressInline: " ({{current}} จาก {{target}})",

  badgeUnlocked: "ปลดล็อกเหรียญตราแล้ว",
  almostThere: "ใกล้แล้ว",
  earnedOn: "ได้รับเมื่อ {{date}} · @{{handle}}",
  progressLabel: "ความคืบหน้า",
  xOfY: "{{current}} จาก {{target}}",
  keepPlaying: "เล่นต่อเพื่อปลดล็อกเหรียญตรานี้",

  shareThisBadge: "แชร์เหรียญตรานี้",
  shareYourProgress: "แชร์ความคืบหน้าของคุณ",
  shareDescUnlocked: "อวดความสำเร็จของคุณบนโซเชียลมีเดีย ใครก็ตามที่มีลิงก์นี้จะเห็นการ์ดนี้",
  shareDescLocked: "อวดว่าคุณใกล้จะถึงแล้ว ใครก็ตามที่มีลิงก์นี้จะเห็นการ์ดความคืบหน้าของคุณ",
  copyShareLink: "คัดลอกลิงก์แชร์",
  linkCopied: "คัดลอกลิงก์แล้ว!",
  shareNative: "แชร์…",

  notFoundTitle: "ไม่พบเหรียญตรา",
  notFoundDesc: "ผู้เล่นรายนี้ซ่อนความสำเร็จไว้ ประเภทเหรียญตราไม่เป็นที่รู้จัก หรือลิงก์ไม่ถูกต้อง",
  viewProfile: "ดูโปรไฟล์ของ {{handle}}",
  backTo: "กลับไปที่ @{{handle}}",
  footer: "© {{year}} KHARAGOLF. เหรียญตราจะมอบให้โดยอัตโนมัติตามรอบที่เล่น",
};

const vi: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} trên KHARAGOLF",
  shareMessageUnlocked: "Mình vừa mở khoá huy hiệu “{{label}}” {{icon}} trên KHARAGOLF! {{url}}",
  shareMessageLocked: "Mình sắp đạt huy hiệu “{{label}}” {{icon}} trên KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Mình sắp đạt huy hiệu “{{label}}” {{icon}} trên KHARAGOLF — {{current}}/{{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} đã mở khoá “{{label}}” — KHARAGOLF",
  pageTitleLocked: "{{name}} sắp đạt “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} vừa mở khoá huy hiệu {{label}} {{icon}} trên KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} đang cố gắng đạt huy hiệu {{label}} {{icon}}{{progress}} trên KHARAGOLF. {{description}}",
  progressInline: " ({{current}}/{{target}})",

  badgeUnlocked: "Huy hiệu đã mở khoá",
  almostThere: "Sắp đạt rồi",
  earnedOn: "Đạt được {{date}} · @{{handle}}",
  progressLabel: "Tiến độ",
  xOfY: "{{current}}/{{target}}",
  keepPlaying: "Tiếp tục chơi để mở khoá huy hiệu này.",

  shareThisBadge: "Chia sẻ huy hiệu này",
  shareYourProgress: "Chia sẻ tiến độ của bạn",
  shareDescUnlocked: "Khoe thành tích trên mạng xã hội. Ai có liên kết đều sẽ thấy thẻ này.",
  shareDescLocked: "Khoe rằng bạn sắp đạt được. Ai có liên kết đều sẽ thấy thẻ tiến độ của bạn.",
  copyShareLink: "Sao chép liên kết chia sẻ",
  linkCopied: "Đã sao chép liên kết!",
  shareNative: "Chia sẻ…",

  notFoundTitle: "Không tìm thấy huy hiệu",
  notFoundDesc: "Người chơi này đã ẩn thành tích, loại huy hiệu không xác định, hoặc liên kết không đúng.",
  viewProfile: "Xem hồ sơ của {{handle}}",
  backTo: "Quay lại @{{handle}}",
  footer: "© {{year}} KHARAGOLF. Huy hiệu được trao tự động dựa trên các vòng đã chơi.",
};

const yo: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} lórí KHARAGOLF",
  shareMessageUnlocked: "Mo ṣẹ̀ṣẹ̀ ṣí baajì “{{label}}” {{icon}} sílẹ̀ lórí KHARAGOLF! {{url}}",
  shareMessageLocked: "Mo fẹ́ẹ́ jèrè baajì “{{label}}” {{icon}} lórí KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Mo fẹ́ẹ́ jèrè baajì “{{label}}” {{icon}} lórí KHARAGOLF — {{current}} nínú {{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} ṣí “{{label}}” sílẹ̀ — KHARAGOLF",
  pageTitleLocked: "{{name}} ti fẹ́ẹ́ jèrè “{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} ṣẹ̀ṣẹ̀ ṣí baajì {{label}} {{icon}} sílẹ̀ lórí KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} ń ṣiṣẹ́ láti gba baajì {{label}} {{icon}}{{progress}} lórí KHARAGOLF. {{description}}",
  progressInline: " ({{current}} nínú {{target}})",

  badgeUnlocked: "Baajì ti ṣí",
  almostThere: "Ó fẹ́ẹ́ tó",
  earnedOn: "Gba ní {{date}} · @{{handle}}",
  progressLabel: "Ìtẹ̀síwájú",
  xOfY: "{{current}} nínú {{target}}",
  keepPlaying: "Máa ṣeré láti ṣí baajì yìí sílẹ̀.",

  shareThisBadge: "Pin baajì yìí",
  shareYourProgress: "Pin ìtẹ̀síwájú rẹ",
  shareDescUnlocked: "Fi ìṣàṣeyege rẹ hàn lórí ìkànnì àwùjọ. Ẹnikẹ́ni tó bá ní ìjápọ̀ á rí káàdì yìí.",
  shareDescLocked: "Yangàn pé ìwọ ti fẹ́ẹ́ tó. Ẹnikẹ́ni tó bá ní ìjápọ̀ á rí káàdì ìtẹ̀síwájú rẹ.",
  copyShareLink: "Daakọ ìjápọ̀ pípín",
  linkCopied: "A ti daakọ ìjápọ̀!",
  shareNative: "Pin…",

  notFoundTitle: "A kò rí baajì",
  notFoundDesc: "Yálà eléré yìí fi àwọn ìṣàṣeyege rẹ̀ pamọ́, irú baajì kò mọ̀, tàbí ìjápọ̀ kò tọ́.",
  viewProfile: "Wo profáìlì {{handle}}",
  backTo: "Padà sí @{{handle}}",
  footer: "© {{year}} KHARAGOLF. A ń pín baajì láti ọwọ́ ara wọn gẹ́gẹ́ bí àwọn yípo tí a ti ṣeré.",
};

const zh: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} 在 KHARAGOLF",
  shareMessageUnlocked: "我刚刚在 KHARAGOLF 解锁了「{{label}}」{{icon}} 徽章！ {{url}}",
  shareMessageLocked: "我即将在 KHARAGOLF 解锁「{{label}}」{{icon}} 徽章 {{url}}",
  shareMessageLockedProgress: "我即将在 KHARAGOLF 解锁「{{label}}」{{icon}} 徽章 — {{target}} 中的 {{current}}！ {{url}}",

  pageTitleUnlocked: "{{name}} 解锁了「{{label}}」 — KHARAGOLF",
  pageTitleLocked: "{{name}} 即将解锁「{{label}}」{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} 刚刚在 KHARAGOLF 解锁了 {{label}} 徽章 {{icon}}。{{description}}",
  metaDescLocked: "{{name}} 正在 KHARAGOLF 上努力获得 {{label}} 徽章 {{icon}}{{progress}}。{{description}}",
  progressInline: "（{{target}} 中的 {{current}}）",

  badgeUnlocked: "徽章已解锁",
  almostThere: "即将达成",
  earnedOn: "{{date}} 获得 · @{{handle}}",
  progressLabel: "进度",
  xOfY: "{{target}} 中的 {{current}}",
  keepPlaying: "继续打球以解锁此徽章。",

  shareThisBadge: "分享此徽章",
  shareYourProgress: "分享你的进度",
  shareDescUnlocked: "在社交媒体上展示你的成就。任何人有此链接都能看到这张卡片。",
  shareDescLocked: "炫耀你即将达成。任何人有此链接都能看到你的进度卡片。",
  copyShareLink: "复制分享链接",
  linkCopied: "链接已复制！",
  shareNative: "分享…",

  notFoundTitle: "未找到徽章",
  notFoundDesc: "该玩家可能已隐藏其成就，徽章类型未知，或链接错误。",
  viewProfile: "查看 {{handle}} 的个人主页",
  backTo: "返回 @{{handle}}",
  footer: "© {{year}} KHARAGOLF。徽章根据所打回合自动颁发。",
};

const zu: BadgeStrings = {
  shareTitle: "{{label}} — @{{handle}} ku-KHARAGOLF",
  shareMessageUnlocked: "Ngisanda kuvula ibheji ye-“{{label}}” {{icon}} ku-KHARAGOLF! {{url}}",
  shareMessageLocked: "Sengisondele ekutholeni ibheji ye-“{{label}}” {{icon}} ku-KHARAGOLF {{url}}",
  shareMessageLockedProgress: "Sengisondele ekutholeni ibheji ye-“{{label}}” {{icon}} ku-KHARAGOLF — {{current}} kwa-{{target}}! {{url}}",

  pageTitleUnlocked: "{{name}} uvule “{{label}}” — KHARAGOLF",
  pageTitleLocked: "{{name}} usondele ku-“{{label}}”{{progress}} — KHARAGOLF",
  metaDescUnlocked: "{{name}} usanda kuvula ibheji ye-{{label}} {{icon}} ku-KHARAGOLF. {{description}}",
  metaDescLocked: "{{name}} usebenza ekutholeni ibheji ye-{{label}} {{icon}}{{progress}} ku-KHARAGOLF. {{description}}",
  progressInline: " ({{current}} kwa-{{target}})",

  badgeUnlocked: "Ibheji ivuliwe",
  almostThere: "Sekuseduze",
  earnedOn: "Itholwe ngo-{{date}} · @{{handle}}",
  progressLabel: "Inqubekela phambili",
  xOfY: "{{current}} kwa-{{target}}",
  keepPlaying: "Qhubeka udlala ukuze uvule lebheji.",

  shareThisBadge: "Yabelana ngalebheji",
  shareYourProgress: "Yabelana ngenqubekela phambili yakho",
  shareDescUnlocked: "Khombisa impumelelo yakho ezinkundleni zokuxhumana. Noma ubani onesixhumanisi uzobona leli khadi.",
  shareDescLocked: "Ziqhayise ngokusondela. Noma ubani onesixhumanisi uzobona ikhadi lakho lenqubekela phambili.",
  copyShareLink: "Kopisha isixhumanisi sokwabelana",
  linkCopied: "Isixhumanisi sikopishiwe!",
  shareNative: "Yabelana…",

  notFoundTitle: "Ibheji ayitholakalanga",
  notFoundDesc: "Lo mdlali kungenzeka ufihle ezakhe izimpumelelo, uhlobo lwebheji aluvumelekile, noma isixhumanisi siyiphutha.",
  viewProfile: "Buka iphrofayela ka-{{handle}}",
  backTo: "Buyela ku-@{{handle}}",
  footer: "© {{year}} KHARAGOLF. Amabheji aniketwa ngokuzenzakalelayo ngokususelwa kumakhona adlaliwe.",
};

const BUNDLES: Record<BadgeLang, BadgeStrings> = {
  af, am, ar, de, en, es, fil, fr, ha, hi, id, ja, ko, ms, pt, sw, th, vi, yo, zh, zu,
};

export function getBadgeStrings(lang: BadgeLang): BadgeStrings {
  return BUNDLES[lang] ?? BUNDLES.en;
}

/**
 * Tiny `{{var}}` interpolator. Numeric values are converted to strings
 * (no locale-specific number formatting — the page passes already-formatted
 * dates and integer counts).
 */
export function interpolate(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Convenience translator scoped to a language. */
export function tBadge(
  lang: BadgeLang,
  key: keyof BadgeStrings,
  vars?: Record<string, string | number>,
): string {
  return interpolate(getBadgeStrings(lang)[key], vars);
}

/**
 * Resolve the page language from the URL `?lang=` query param, falling back
 * to `navigator.language`, then `en`. Safe to call in non-browser test
 * environments — the navigator fallback is only consulted when `window` is
 * defined.
 */
export function resolvePageLang(search: string | undefined | null): BadgeLang {
  let qp: string | null = null;
  try {
    const sp = new URLSearchParams(search ?? "");
    qp = sp.get("lang");
  } catch {
    qp = null;
  }
  if (qp) return normalizeBadgeLang(qp);
  if (typeof navigator !== "undefined" && navigator.language) {
    return normalizeBadgeLang(navigator.language);
  }
  return "en";
}
