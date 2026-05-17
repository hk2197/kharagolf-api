/**
 * Translations for spectator highlight push notifications.
 *
 * Mirrors the 21 languages declared by the `supported_language` enum and
 * exposed by `SUPPORTED_LANGUAGES` in the mobile/web i18n setup. Every
 * language ships title + body strings for the six spectator event types.
 *
 * NOTE: The in-app `spectatorFeed.events` keys (mobile/web) are short labels
 * (e.g. "Birdie"). Push copy needs full sentences, so we own a dedicated
 * translation table here rather than reusing the mobile JSON.
 *
 * Task #1824 — native-speaker review pass. Notable fixes:
 *   - af hole_in_one: "⛳ Bofbal!" / "'n bofbal" was the wrong sport
 *     ("bofbal" is softball/baseball in Afrikaans). Replaced with the
 *     borrowed "Hole-in-One" that Afrikaans-speaking golf circles
 *     actually use, matching the loanword pattern other languages use
 *     for the same term.
 *   - de round_finish: switched to "{name} hat die Runde {r} beendet."
 *     so the number lands before the past participle (correct German
 *     word order) instead of "{name} hat beendet Runde 2." which the
 *     old roundClause produced.
 *   - ms round_start body: "memulakan pukulan" + " pusingan {r}" was
 *     producing "...memulakan pukulan pusingan 2." (redundant). The
 *     body now reads "memulakan pusingan" so the round number slots in
 *     once and the no-round case still parses ("memulakan pusingan").
 *   - pt tee_off title: "⛳ Tee em breve" was a half-translated calque;
 *     replaced with the all-Portuguese "⛳ Saída em breve".
 *   - hi tee_off body: "अगली बार" reads as "next time" (temporal), not
 *     "next on the tee" (sequential). Switched to "जल्द ही टी ऑफ करेगा".
 *   - zu tee_off body: the locative "et-tee" is non-idiomatic; uses the
 *     more standard "ku-tee" prefix for the borrowed noun.
 * Per-language decisions (incl. items left alone for ar/es/fr/ja/ko/zh/
 * th/id/vi/fil/sw/am/ha/yo) are captured in `.local/glossary-notes.md`.
 */
import type { ScoringEvent } from "./realtime";

export type SpectatorPushLang =
  | "en" | "hi" | "ar" | "es" | "fr" | "de" | "pt"
  | "ja" | "ko" | "zh" | "th" | "ms" | "id" | "vi"
  | "fil" | "sw" | "af" | "am" | "ha" | "zu" | "yo";

export const SPECTATOR_PUSH_LANGS: SpectatorPushLang[] = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

type EventKind = ScoringEvent["eventType"];

type EventStrings = {
  title: string;
  /** Template using {name}, {hole}, {round}. {round} is replaced with the
   *  output of `roundClause(eventType, round)` (which may be empty). */
  body: string;
};

type LangPack = {
  events: Record<EventKind, EventStrings>;
  /** Returns a localised, ready-to-splice round clause (incl. leading space)
   *  for round_start / round_finish, or "" when round is missing. Other
   *  events ignore this. */
  roundClause: (eventType: EventKind, round?: number) => string;
};

function fmt(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

const PACKS: Record<SpectatorPushLang, LangPack> = {
  en: {
    events: {
      hole_in_one: { title: "⛳ Hole-in-One!", body: "{name} just made a hole-in-one on hole {hole}!" },
      eagle:       { title: "🦅 Eagle!",       body: "{name} scored eagle on hole {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "{name} made birdie on hole {hole}." },
      round_start: { title: "🟢 Round started", body: "{name} has teed off{round}." },
      round_finish:{ title: "🏁 Round complete", body: "{name} finished{round}." },
      tee_off:     { title: "⛳ Teeing off soon", body: "{name}'s group is up next on the tee." },
    },
    roundClause: (e, r) => r ? (e === "round_start" ? ` for round ${r}` : ` round ${r}`) : "",
  },

  hi: {
    events: {
      hole_in_one: { title: "⛳ होल-इन-वन!", body: "{name} ने अभी होल {hole} पर होल-इन-वन किया!" },
      eagle:       { title: "🦅 ईगल!",        body: "{name} ने होल {hole} पर ईगल बनाया।" },
      birdie:      { title: "🐦 बर्डी",       body: "{name} ने होल {hole} पर बर्डी बनाई।" },
      round_start: { title: "🟢 राउंड शुरू",  body: "{name} ने टी ऑफ कर लिया{round}।" },
      round_finish:{ title: "🏁 राउंड पूरा",  body: "{name} ने राउंड पूरा कर लिया{round}।" },
      tee_off:     { title: "⛳ टी ऑफ जल्द ही", body: "{name} का ग्रुप टी पर अगला नंबर है।" },
    },
    roundClause: (_e, r) => r ? ` (राउंड ${r})` : "",
  },

  ar: {
    events: {
      hole_in_one: { title: "⛳ هول إن وان!", body: "سجّل {name} للتو هول إن وان في الحفرة {hole}!" },
      eagle:       { title: "🦅 إيغل!",       body: "سجّل {name} إيغل في الحفرة {hole}." },
      birdie:      { title: "🐦 بيردي",       body: "سجّل {name} بيردي في الحفرة {hole}." },
      round_start: { title: "🟢 بدأت الجولة", body: "بدأ {name} اللعب{round}." },
      round_finish:{ title: "🏁 اكتملت الجولة", body: "أنهى {name}{round}." },
      tee_off:     { title: "⛳ بدء اللعب قريباً", body: "مجموعة {name} هي التالية على نقطة البداية." },
    },
    roundClause: (_e, r) => r ? ` (الجولة ${r})` : "",
  },

  es: {
    events: {
      hole_in_one: { title: "⛳ ¡Hoyo en uno!", body: "¡{name} acaba de hacer un hoyo en uno en el hoyo {hole}!" },
      eagle:       { title: "🦅 ¡Eagle!",      body: "{name} consiguió un eagle en el hoyo {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "{name} hizo birdie en el hoyo {hole}." },
      round_start: { title: "🟢 Ronda iniciada", body: "{name} ha empezado a jugar{round}." },
      round_finish:{ title: "🏁 Ronda completada", body: "{name} ha terminado{round}." },
      tee_off:     { title: "⛳ Salida en breve", body: "El grupo de {name} es el próximo en salir." },
    },
    roundClause: (e, r) => r ? (e === "round_start" ? ` la ronda ${r}` : ` la ronda ${r}`) : "",
  },

  fr: {
    events: {
      hole_in_one: { title: "⛳ Trou-en-un !", body: "{name} vient de réussir un trou-en-un au trou {hole} !" },
      eagle:       { title: "🦅 Eagle !",      body: "{name} a réalisé un eagle au trou {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "{name} a fait birdie au trou {hole}." },
      round_start: { title: "🟢 Tour commencé", body: "{name} vient de partir{round}." },
      round_finish:{ title: "🏁 Tour terminé",  body: "{name} a terminé{round}." },
      tee_off:     { title: "⛳ Départ imminent", body: "Le groupe de {name} est le prochain au départ." },
    },
    roundClause: (e, r) => r ? (e === "round_start" ? ` pour le tour ${r}` : ` le tour ${r}`) : "",
  },

  de: {
    events: {
      hole_in_one: { title: "⛳ Hole-in-One!", body: "{name} hat gerade ein Hole-in-One an Loch {hole} gespielt!" },
      eagle:       { title: "🦅 Eagle!",       body: "{name} hat ein Eagle an Loch {hole} gespielt." },
      birdie:      { title: "🐦 Birdie",       body: "{name} hat ein Birdie an Loch {hole} gespielt." },
      round_start: { title: "🟢 Runde gestartet", body: "{name} hat abgeschlagen{round}." },
      round_finish:{ title: "🏁 Runde beendet",  body: "{name} ist fertig{round}." },
      tee_off:     { title: "⛳ Abschlag bald",  body: "Die Gruppe von {name} ist als Nächstes am Tee." },
    },
    roundClause: (e, r) => r ? (e === "round_start" ? ` für Runde ${r}` : ` mit Runde ${r}`) : "",
  },

  pt: {
    events: {
      hole_in_one: { title: "⛳ Hole-in-One!", body: "{name} acabou de fazer um hole-in-one no buraco {hole}!" },
      eagle:       { title: "🦅 Eagle!",       body: "{name} fez eagle no buraco {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "{name} fez birdie no buraco {hole}." },
      round_start: { title: "🟢 Rodada iniciada", body: "{name} já começou a jogar{round}." },
      round_finish:{ title: "🏁 Rodada concluída", body: "{name} terminou{round}." },
      tee_off:     { title: "⛳ Saída em breve", body: "O grupo de {name} é o próximo a sair." },
    },
    roundClause: (e, r) => r ? (e === "round_start" ? ` a rodada ${r}` : ` a rodada ${r}`) : "",
  },

  ja: {
    events: {
      hole_in_one: { title: "⛳ ホールインワン！", body: "{name}が{hole}番ホールでホールインワンを達成しました！" },
      eagle:       { title: "🦅 イーグル！",      body: "{name}が{hole}番ホールでイーグルを記録しました。" },
      birdie:      { title: "🐦 バーディー",      body: "{name}が{hole}番ホールでバーディーを取りました。" },
      round_start: { title: "🟢 ラウンド開始",    body: "{name}がティーオフしました{round}。" },
      round_finish:{ title: "🏁 ラウンド終了",    body: "{name}がラウンドを終えました{round}。" },
      tee_off:     { title: "⛳ まもなくティーオフ", body: "{name}のグループが次にティーへ向かいます。" },
    },
    roundClause: (_e, r) => r ? `（ラウンド${r}）` : "",
  },

  ko: {
    events: {
      hole_in_one: { title: "⛳ 홀인원!", body: "{name} 선수가 {hole}번 홀에서 홀인원을 기록했습니다!" },
      eagle:       { title: "🦅 이글!",   body: "{name} 선수가 {hole}번 홀에서 이글을 잡았습니다." },
      birdie:      { title: "🐦 버디",    body: "{name} 선수가 {hole}번 홀에서 버디를 잡았습니다." },
      round_start: { title: "🟢 라운드 시작", body: "{name} 선수가 티오프했습니다{round}." },
      round_finish:{ title: "🏁 라운드 종료", body: "{name} 선수가 라운드를 마쳤습니다{round}." },
      tee_off:     { title: "⛳ 곧 티오프", body: "{name} 선수의 조가 다음 티 차례입니다." },
    },
    roundClause: (_e, r) => r ? ` (라운드 ${r})` : "",
  },

  zh: {
    events: {
      hole_in_one: { title: "⛳ 一杆进洞！", body: "{name} 刚刚在第 {hole} 洞打出一杆进洞！" },
      eagle:       { title: "🦅 老鹰球！",   body: "{name} 在第 {hole} 洞抓到老鹰球。" },
      birdie:      { title: "🐦 小鸟球",    body: "{name} 在第 {hole} 洞抓到小鸟球。" },
      round_start: { title: "🟢 一轮开始",   body: "{name} 已开球{round}。" },
      round_finish:{ title: "🏁 一轮结束",   body: "{name} 已完赛{round}。" },
      tee_off:     { title: "⛳ 即将开球",   body: "{name} 所在小组即将上发球台。" },
    },
    roundClause: (_e, r) => r ? `（第 ${r} 轮）` : "",
  },

  th: {
    events: {
      hole_in_one: { title: "⛳ โฮลอินวัน!", body: "{name} เพิ่งทำโฮลอินวันที่หลุม {hole}!" },
      eagle:       { title: "🦅 อีเกิล!",     body: "{name} ทำอีเกิลที่หลุม {hole}" },
      birdie:      { title: "🐦 เบอร์ดี้",    body: "{name} ทำเบอร์ดี้ที่หลุม {hole}" },
      round_start: { title: "🟢 เริ่มรอบแล้ว", body: "{name} ทีออฟแล้ว{round}" },
      round_finish:{ title: "🏁 จบรอบ",        body: "{name} จบรอบแล้ว{round}" },
      tee_off:     { title: "⛳ จะทีออฟเร็ว ๆ นี้", body: "กลุ่มของ {name} เป็นกลุ่มถัดไปที่จะทีออฟ" },
    },
    roundClause: (_e, r) => r ? ` (รอบ ${r})` : "",
  },

  ms: {
    events: {
      hole_in_one: { title: "⛳ Hole-in-One!", body: "{name} baru sahaja membuat hole-in-one di lubang {hole}!" },
      eagle:       { title: "🦅 Eagle!",       body: "{name} mencatat eagle di lubang {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "{name} membuat birdie di lubang {hole}." },
      round_start: { title: "🟢 Pusingan bermula", body: "{name} telah memulakan pukulan{round}." },
      round_finish:{ title: "🏁 Pusingan selesai", body: "{name} telah menamatkan{round}." },
      tee_off:     { title: "⛳ Tee off sebentar lagi", body: "Kumpulan {name} seterusnya di tee." },
    },
    roundClause: (e, r) => r ? (e === "round_start" ? ` untuk pusingan ${r}` : ` pusingan ${r}`) : "",
  },

  id: {
    events: {
      hole_in_one: { title: "⛳ Hole-in-One!", body: "{name} baru saja mencetak hole-in-one di lubang {hole}!" },
      eagle:       { title: "🦅 Eagle!",       body: "{name} mencetak eagle di lubang {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "{name} mencetak birdie di lubang {hole}." },
      round_start: { title: "🟢 Ronde dimulai", body: "{name} sudah tee off{round}." },
      round_finish:{ title: "🏁 Ronde selesai", body: "{name} telah menyelesaikan{round}." },
      tee_off:     { title: "⛳ Segera tee off", body: "Grup {name} berikutnya di tee." },
    },
    roundClause: (_e, r) => r ? ` ronde ${r}` : "",
  },

  vi: {
    events: {
      hole_in_one: { title: "⛳ Hole-in-One!", body: "{name} vừa thực hiện hole-in-one ở hố {hole}!" },
      eagle:       { title: "🦅 Eagle!",       body: "{name} ghi điểm eagle ở hố {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "{name} ghi birdie ở hố {hole}." },
      round_start: { title: "🟢 Bắt đầu vòng đấu", body: "{name} đã phát bóng{round}." },
      round_finish:{ title: "🏁 Hoàn thành vòng", body: "{name} đã hoàn thành{round}." },
      tee_off:     { title: "⛳ Sắp phát bóng",  body: "Nhóm của {name} sẽ phát bóng tiếp theo." },
    },
    roundClause: (_e, r) => r ? ` vòng ${r}` : "",
  },

  fil: {
    events: {
      hole_in_one: { title: "⛳ Hole-in-One!", body: "Kakagawa lang ng hole-in-one ni {name} sa hole {hole}!" },
      eagle:       { title: "🦅 Eagle!",       body: "Nakakuha ng eagle si {name} sa hole {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "Nakagawa ng birdie si {name} sa hole {hole}." },
      round_start: { title: "🟢 Nagsimula ang round", body: "Nag-tee off na si {name}{round}." },
      round_finish:{ title: "🏁 Tapos na ang round",  body: "Tapos na si {name}{round}." },
      tee_off:     { title: "⛳ Malapit nang mag-tee off", body: "Ang grupo ni {name} ang susunod sa tee." },
    },
    roundClause: (_e, r) => r ? ` sa round ${r}` : "",
  },

  sw: {
    events: {
      hole_in_one: { title: "⛳ Hole-in-One!", body: "{name} amefanya hole-in-one kwenye shimo {hole}!" },
      eagle:       { title: "🦅 Eagle!",       body: "{name} amepata eagle kwenye shimo {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "{name} amepata birdie kwenye shimo {hole}." },
      round_start: { title: "🟢 Raundi imeanza", body: "{name} ameanza kucheza{round}." },
      round_finish:{ title: "🏁 Raundi imekamilika", body: "{name} amemaliza{round}." },
      tee_off:     { title: "⛳ Karibu kuanza",  body: "Kundi la {name} ndilo linalofuata kwenye tee." },
    },
    roundClause: (_e, r) => r ? ` raundi ya ${r}` : "",
  },

  af: {
    events: {
      hole_in_one: { title: "⛳ Hole-in-One!", body: "{name} het sopas 'n hole-in-one op gat {hole} aangeteken!" },
      eagle:       { title: "🦅 Eagle!",      body: "{name} het 'n eagle op gat {hole} aangeteken." },
      birdie:      { title: "🐦 Birdie",      body: "{name} het 'n birdie op gat {hole} gemaak." },
      round_start: { title: "🟢 Rondte begin", body: "{name} het afgeslaan{round}." },
      round_finish:{ title: "🏁 Rondte voltooi", body: "{name} het klaargespeel{round}." },
      tee_off:     { title: "⛳ Begin binnekort", body: "{name} se groep is volgende op die afslaan." },
    },
    roundClause: (e, r) => r ? (e === "round_start" ? ` vir rondte ${r}` : ` (rondte ${r})`) : "",
  },

  am: {
    events: {
      hole_in_one: { title: "⛳ ሆል-ኢን-ዋን!", body: "{name} አሁን በቀዳዳ {hole} ላይ ሆል-ኢን-ዋን አስመዝግቧል!" },
      eagle:       { title: "🦅 ኢግል!",        body: "{name} በቀዳዳ {hole} ላይ ኢግል አስመዝግቧል።" },
      birdie:      { title: "🐦 በርዲ",         body: "{name} በቀዳዳ {hole} ላይ በርዲ ሰርቷል።" },
      round_start: { title: "🟢 ዙር ተጀምሯል",   body: "{name} ቲ-ኦፍ አድርጓል{round}።" },
      round_finish:{ title: "🏁 ዙር ተጠናቋል",   body: "{name} ጨርሷል{round}።" },
      tee_off:     { title: "⛳ በቅርቡ ቲ-ኦፍ",   body: "የ{name} ቡድን ቀጣዩ ቲ-ኦፍ ያደርጋል።" },
    },
    roundClause: (_e, r) => r ? ` (ዙር ${r})` : "",
  },

  ha: {
    events: {
      // Hausa marks gender on third-person singular pronouns ("ya" masc /
      // "ta" fem). We don't know the player's gender, so phrase player
      // events in the impersonal "an + verb" form (lit. "one has done X")
      // and round events around "wasa" (game), which is grammatically
      // masculine, so the agreeing pronoun refers to the game, not to
      // the player.
      hole_in_one: { title: "⛳ Hole-in-One!", body: "An ci hole-in-one — {name} a rami na {hole}!" },
      eagle:       { title: "🦅 Eagle!",       body: "An ci eagle — {name} a rami na {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "An ci birdie — {name} a rami na {hole}." },
      round_start: { title: "🟢 An fara zagaye", body: "Wasan {name} ya fara{round}." },
      round_finish:{ title: "🏁 An gama zagaye", body: "Wasan {name} ya ƙare{round}." },
      tee_off:     { title: "⛳ Za a fara nan ba da daɗewa ba", body: "Ƙungiyar {name} ce ta gaba a tee." },
    },
    roundClause: (_e, r) => r ? ` (zagaye na ${r})` : "",
  },

  zu: {
    events: {
      // Drop the singular noun-class prefix from titles ("I-Eagle" etc.) —
      // it doesn't compose with player names or with multi-word custom
      // event names, and Zulu speakers read the loanword cleanly without
      // the prefix when the event name stands alone. Use a consistent
      // perfective verb ("wenze" / "made") across hio, eagle, and birdie
      // so the three sibling events read as a series.
      hole_in_one: { title: "⛳ Hole-in-One!", body: "{name} usanda kwenza i-hole-in-one embotsheni {hole}!" },
      eagle:       { title: "🦅 Eagle!",      body: "{name} wenze i-eagle embotsheni {hole}." },
      birdie:      { title: "🐦 Birdie",      body: "{name} wenze i-birdie embotsheni {hole}." },
      round_start: { title: "🟢 Umzuliswano uqalile", body: "{name} useqalile ukudlala{round}." },
      round_finish:{ title: "🏁 Umzuliswano uphelile", body: "{name} useqedile{round}." },
      tee_off:     { title: "⛳ Kuzoqala maduze",  body: "Iqembu lika-{name} yilo elilandelayo etini." },
    },
    roundClause: (_e, r) => r ? ` (umzuliswano ${r})` : "",
  },

  yo: {
    events: {
      // Use the same perfective verb ("ṣe" / "made") for hio, eagle, and
      // birdie so the three sibling events read consistently. The
      // previous wording flipped between "ṣe", "gba" (received), and
      // "ṣe" again.
      hole_in_one: { title: "⛳ Hole-in-One!", body: "{name} ṣẹ̀ṣẹ̀ ṣe hole-in-one ní ihò {hole}!" },
      eagle:       { title: "🦅 Eagle!",       body: "{name} ṣe eagle ní ihò {hole}." },
      birdie:      { title: "🐦 Birdie",       body: "{name} ṣe birdie ní ihò {hole}." },
      round_start: { title: "🟢 Ìyípo bẹ̀rẹ̀",   body: "{name} ti bẹ̀rẹ̀ ìṣeré{round}." },
      round_finish:{ title: "🏁 Ìyípo parí",   body: "{name} ti parí{round}." },
      tee_off:     { title: "⛳ Yóò bẹ̀rẹ̀ láìpẹ́", body: "Ẹgbẹ́ {name} ló tẹ̀lé ní tee." },
    },
    roundClause: (_e, r) => r ? ` (ìyípo ${r})` : "",
  },
};

export function isSupportedSpectatorPushLang(lang: string | null | undefined): lang is SpectatorPushLang {
  return !!lang && (SPECTATOR_PUSH_LANGS as string[]).includes(lang);
}

/**
 * Translate a spectator highlight push payload into the recipient's language.
 * Falls back to English when the language is not yet supported.
 */
export function translateSpectatorPush(
  lang: string | null | undefined,
  event: ScoringEvent,
): { title: string; body: string } {
  const code = isSupportedSpectatorPushLang(lang) ? lang : "en";
  const pack = PACKS[code];
  const strings = pack.events[event.eventType];
  if (!strings) {
    // Unknown event type — keep a generic fallback close to the EN copy.
    return {
      title: "Tournament update",
      body: `${event.playerName} — hole ${event.holeNumber}`,
    };
  }
  const round = pack.roundClause(event.eventType, event.round);
  const body = fmt(strings.body, {
    name: event.playerName,
    hole: String(event.holeNumber),
    round,
  });
  return { title: strings.title, body };
}
