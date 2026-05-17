/**
 * Translations for the "post-event survey reminder" push notification
 * (Task #2012). The non-reminder/initial post-event survey push isn't
 * driven through this module — only the admin-fired reminder is —
 * because that's the only path that today builds title/body in
 * hard-coded English at the dispatch site (`/survey/remind` in
 * `wave2.ts`). The initial send-survey push uses a generic body and
 * doesn't yet need per-recipient localisation.
 *
 * Mirrors the 21 languages declared by the `supported_language` enum
 * (same set used by `highlightPushI18n.ts` / `spectatorPushI18n.ts`).
 *
 * Each language ships title + body. Bodies use a {tournament}
 * placeholder filled with the event name (or a localised
 * "the event you just played" fallback when the name is missing).
 */

export type PostEventSurveyPushLang =
  | "en" | "hi" | "ar" | "es" | "fr" | "de" | "pt"
  | "ja" | "ko" | "zh" | "th" | "ms" | "id" | "vi"
  | "fil" | "sw" | "af" | "am" | "ha" | "zu" | "yo";

export const POST_EVENT_SURVEY_PUSH_LANGS: PostEventSurveyPushLang[] = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

type Strings = { title: string; body: string };

type LangPack = {
  /** Localised fallback used when the event has no name on file. */
  defaultTournament: string;
  reminder: Strings;
};

function fmt(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

const PACKS: Record<PostEventSurveyPushLang, LangPack> = {
  en: {
    defaultTournament: "the event you just played",
    reminder: {
      title: "Reminder: how was {tournament}?",
      body: "We'd still love a couple of minutes of feedback on the event you played.",
    },
  },
  hi: {
    defaultTournament: "वह इवेंट जो आपने अभी खेला",
    reminder: {
      title: "अनुस्मारक: {tournament} कैसा रहा?",
      body: "अगला इवेंट और भी बेहतर हो, इसके लिए अब भी कुछ मिनट की प्रतिक्रिया चाहेंगे।",
    },
  },
  ar: {
    defaultTournament: "الحدث الذي شاركت فيه للتو",
    reminder: {
      title: "تذكير: كيف كان {tournament}؟",
      body: "ما زلنا نودّ بضع دقائق من رأيك حول الحدث الذي شاركت فيه.",
    },
  },
  es: {
    defaultTournament: "el evento que acabas de jugar",
    reminder: {
      title: "Recordatorio: ¿cómo estuvo {tournament}?",
      body: "Aún nos encantaría un par de minutos de tus comentarios sobre el evento que jugaste.",
    },
  },
  fr: {
    defaultTournament: "l'événement auquel vous venez de participer",
    reminder: {
      title: "Rappel : comment s'est passé {tournament} ?",
      body: "Quelques minutes de votre avis nous aideraient encore à améliorer le prochain événement.",
    },
  },
  de: {
    defaultTournament: "das gerade gespielte Event",
    reminder: {
      title: "Erinnerung: Wie war {tournament}?",
      body: "Ein paar Minuten Feedback zum gerade gespielten Event würden uns weiterhin helfen.",
    },
  },
  pt: {
    defaultTournament: "o evento que você acabou de jogar",
    reminder: {
      title: "Lembrete: como foi {tournament}?",
      body: "Adoraríamos ainda alguns minutos de feedback sobre o evento que você jogou.",
    },
  },
  ja: {
    defaultTournament: "先ほど参加したイベント",
    reminder: {
      title: "リマインダー: {tournament} はいかがでしたか?",
      body: "参加されたイベントについて、引き続き数分のフィードバックをお願いします。",
    },
  },
  ko: {
    defaultTournament: "방금 참가한 이벤트",
    reminder: {
      title: "알림: {tournament}는 어땠나요?",
      body: "참가하신 이벤트에 대해 계속해서 짧은 피드백을 부탁드립니다.",
    },
  },
  zh: {
    defaultTournament: "您刚参加的赛事",
    reminder: {
      title: "提醒：{tournament} 体验如何？",
      body: "几分钟的反馈仍能让下一场赛事更精彩，欢迎继续分享。",
    },
  },
  th: {
    defaultTournament: "กิจกรรมที่คุณเพิ่งเล่น",
    reminder: {
      title: "เตือนความจำ: {tournament} เป็นอย่างไรบ้าง?",
      body: "เรายังอยากได้ความเห็นสักครู่เกี่ยวกับกิจกรรมที่คุณเพิ่งเล่น",
    },
  },
  ms: {
    defaultTournament: "acara yang baru anda main",
    reminder: {
      title: "Peringatan: bagaimana {tournament}?",
      body: "Kami masih mengalu-alukan beberapa minit maklum balas tentang acara yang anda mainkan.",
    },
  },
  id: {
    defaultTournament: "acara yang baru Anda mainkan",
    reminder: {
      title: "Pengingat: bagaimana {tournament}?",
      body: "Beberapa menit umpan balik tentang acara yang Anda mainkan akan tetap membantu kami.",
    },
  },
  vi: {
    defaultTournament: "sự kiện bạn vừa chơi",
    reminder: {
      title: "Nhắc nhở: {tournament} thế nào?",
      body: "Chúng tôi vẫn rất mong vài phút phản hồi về sự kiện bạn vừa chơi.",
    },
  },
  fil: {
    defaultTournament: "ang event na kakatapos mong laruan",
    reminder: {
      title: "Paalala: kumusta ang {tournament}?",
      body: "Ikalulugod pa rin namin ang ilang minutong feedback tungkol sa event na nilaro mo.",
    },
  },
  sw: {
    defaultTournament: "tukio uliloicheza tu",
    reminder: {
      title: "Ukumbusho: {tournament} ulikuwaje?",
      body: "Bado tungependa dakika kadhaa za maoni kuhusu tukio ulilocheza.",
    },
  },
  af: {
    defaultTournament: "die geleentheid wat jy pas gespeel het",
    reminder: {
      title: "Herinnering: hoe was {tournament}?",
      body: "’n Paar minute van jou terugvoer oor die geleentheid sal ons steeds help.",
    },
  },
  am: {
    defaultTournament: "አሁን የተጫወቱት ክስተት",
    reminder: {
      title: "ማስታወሻ: {tournament} እንዴት ነበር?",
      body: "ስለ ተጫወቱት ክስተት ጥቂት ደቂቃ ግብረመልስ አሁንም እንፈልጋለን።",
    },
  },
  ha: {
    defaultTournament: "taron da ka taɓa bayyana a ciki",
    reminder: {
      title: "Tunasarwa: yaya {tournament}?",
      body: "Mintuna kaɗan na ra’ayinka game da taron da ka buga har yanzu zai amfane mu.",
    },
  },
  zu: {
    defaultTournament: "umcimbi okade uwudlala",
    reminder: {
      title: "Isikhumbuzo: i-{tournament} ibinjani?",
      body: "Sisathanda imizuzu embalwa yempendulo ngomcimbi okade uwudlala.",
    },
  },
  yo: {
    defaultTournament: "ìṣẹ̀lẹ̀ tí o ṣẹ̀ṣẹ̀ ṣe",
    reminder: {
      title: "Ìránnilétí: báwo ni {tournament}?",
      body: "Ìṣẹ́jú díẹ̀ ti ìmọ̀ràn rẹ lórí ìṣẹ̀lẹ̀ tí o ṣe ṣì lè ràn wá lọ́wọ́.",
    },
  },
};

export function isSupportedPostEventSurveyPushLang(
  lang: string | null | undefined,
): lang is PostEventSurveyPushLang {
  return !!lang && (POST_EVENT_SURVEY_PUSH_LANGS as string[]).includes(lang);
}

/**
 * Translate the post-event survey REMINDER push into the recipient's
 * language. Falls back to English when the language is not supported.
 * The {tournament} placeholder is filled from the supplied event name
 * (or the language's localised default when missing/empty).
 */
export function translatePostEventSurveyReminderPush(
  lang: string | null | undefined,
  tournamentName: string | null | undefined,
): { title: string; body: string } {
  const code = isSupportedPostEventSurveyPushLang(lang) ? lang : "en";
  const pack = PACKS[code];
  const tournament = (tournamentName ?? "").trim() || pack.defaultTournament;
  return {
    title: fmt(pack.reminder.title, { tournament }),
    body: fmt(pack.reminder.body, { tournament }),
  };
}
