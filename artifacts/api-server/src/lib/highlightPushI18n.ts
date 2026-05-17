/**
 * Translations for "your highlight reel is ready / failed" push notifications.
 *
 * Mirrors the 21 languages declared by the `supported_language` enum and
 * exposed by `SUPPORTED_LANGUAGES` in the mobile/web i18n setup — same set
 * used by `spectatorPushI18n.ts` for the spectator highlight pushes.
 *
 * Each language ships title + body for both terminal states:
 *   - ready:  the reel rendered successfully
 *   - failed: retries exhausted
 *
 * Bodies use a {title} placeholder which is filled with the player's
 * reel title (or the localised "Round Highlights" fallback).
 *
 * Task #1824 — native-speaker review pass. The borrowed
 * "render/rendered" jargon (de "gerendert", pt "renderizado",
 * ja "レンダリング", ko "렌더링", zh "渲染", th "เรนเดอร์",
 * ms/id "dirender", vi "kết xuất", fil "Na-render", af "gerenderd",
 * hi "रेंडर") was swapped for the natural "ready / created / built"
 * verb each language actually uses for finished media. The fr
 * ready/failed bodies were rephrased to put {title} in guillemets so
 * the predicate agrees with the (always m. sing.) noun "reel" instead
 * of trying to inflect against an arbitrary user-supplied title. The
 * yo ready body's "ṣe tán ó sì ṣetán" redundancy was tightened to
 * "ti ṣetán fún wíwò". Per-language decisions (incl. items left alone
 * for am/ha/zu/ar/es) are captured in `.local/glossary-notes.md`.
 */

export type HighlightPushLang =
  | "en" | "hi" | "ar" | "es" | "fr" | "de" | "pt"
  | "ja" | "ko" | "zh" | "th" | "ms" | "id" | "vi"
  | "fil" | "sw" | "af" | "am" | "ha" | "zu" | "yo";

export const HIGHLIGHT_PUSH_LANGS: HighlightPushLang[] = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

type Strings = { title: string; body: string };

type LangPack = {
  /** Default title to use when the reel has no custom title. */
  defaultTitle: string;
  ready: Strings;
  failed: Strings;
};

function fmt(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

const PACKS: Record<HighlightPushLang, LangPack> = {
  en: {
    defaultTitle: "Round Highlights",
    ready:  { title: "Your highlight reel is ready",  body: "{title} is rendered and ready to watch." },
    failed: { title: "Your highlight reel failed",    body: "{title} couldn't be rendered. Tap to try again." },
  },
  hi: {
    defaultTitle: "राउंड हाइलाइट्स",
    // Hindi marks gender on the verb, but we don't know whether the
    // user-supplied {title} is masculine or feminine. Phrase both bodies
    // so the verb agrees with a fixed Hindi noun ("रील" / reel — feminine)
    // rather than with {title} itself, which avoids gender drift on
    // custom titles.
    ready:  { title: "आपकी हाइलाइट रील तैयार है",     body: "आपकी रील ({title}) अब तैयार है। देखने के लिए टैप करें।" },
    failed: { title: "आपकी हाइलाइट रील विफल रही",      body: "हम आपकी रील ({title}) तैयार नहीं कर सके। दोबारा कोशिश करने के लिए टैप करें।" },
  },
  ar: {
    defaultTitle: "أبرز لقطات الجولة",
    // The earlier ready body agreed "جاهزاً" with "إعداد" (preparation)
    // even though native readers parse it as agreeing with {title}. Move
    // the title to the end and keep the agreeing adjective on the fixed
    // word "ملخّصك" (your highlight reel — masc), which is gender-stable
    // regardless of the custom title.
    ready:  { title: "ملخّص لقطاتك جاهز",             body: "أصبح ملخّصك جاهزاً للمشاهدة: {title}." },
    failed: { title: "تعذّر إنشاء ملخّص لقطاتك",      body: "تعذّر إنشاء {title}. اضغط للمحاولة مرة أخرى." },
  },
  es: {
    defaultTitle: "Lo más destacado de la ronda",
    // Avoid agreeing "está listo" with the custom {title} (which can be
    // feminine, plural, etc.) — anchor the agreement to "tu reel" (masc
    // sg) and append the title at the end.
    ready:  { title: "Tu reel destacado está listo",   body: "Tu reel ya está listo para ver: {title}." },
    failed: { title: "Tu reel destacado falló",        body: "No se pudo generar {title}. Toca para intentarlo de nuevo." },
  },
  fr: {
    defaultTitle: "Moments forts du tour",
    // Same rationale as es/pt: keep the agreeing adjective on a fixed
    // French word ("votre reel", masc sg) instead of on the dynamic
    // {title}, and put {title} at the end.
    ready:  { title: "Votre reel est prêt",            body: "Votre reel est prêt à être visionné : {title}." },
    failed: { title: "Échec de votre reel",            body: "Impossible de générer {title}. Appuyez pour réessayer." },
  },
  de: {
    defaultTitle: "Runden-Highlights",
    ready:  { title: "Dein Highlight-Reel ist fertig", body: "{title} ist fertig und kann jetzt angesehen werden." },
    failed: { title: "Dein Highlight-Reel ist fehlgeschlagen", body: "{title} konnte nicht erstellt werden. Tippe, um es erneut zu versuchen." },
  },
  pt: {
    defaultTitle: "Destaques da rodada",
    // Anchor agreement on "seu reel" (masc sg) instead of {title}, which
    // can be feminine or plural and would force the wrong concord.
    ready:  { title: "Seu reel de destaques está pronto", body: "Seu reel está pronto para assistir: {title}." },
    failed: { title: "Falha no seu reel de destaques", body: "Não foi possível renderizar {title}. Toque para tentar novamente." },
  },
  ja: {
    defaultTitle: "ラウンドハイライト",
    ready:  { title: "ハイライトリールが完成しました", body: "{title}が完成し、ご視聴いただけます。" },
    failed: { title: "ハイライトリールの作成に失敗しました", body: "{title}を作成できませんでした。タップしてもう一度お試しください。" },
  },
  ko: {
    defaultTitle: "라운드 하이라이트",
    ready:  { title: "하이라이트 영상이 준비되었습니다", body: "{title} 영상이 완성되어 시청할 수 있습니다." },
    failed: { title: "하이라이트 영상 생성에 실패했습니다", body: "{title} 영상을 만들지 못했습니다. 다시 시도하려면 탭하세요." },
  },
  zh: {
    defaultTitle: "本轮精彩集锦",
    ready:  { title: "您的精彩集锦已就绪",            body: "{title} 已生成，可以观看。" },
    failed: { title: "您的精彩集锦生成失败",          body: "无法生成 {title}。点击重试。" },
  },
  th: {
    defaultTitle: "ไฮไลต์รอบ",
    ready:  { title: "รีลไฮไลต์ของคุณพร้อมแล้ว",      body: "{title} พร้อมให้รับชมแล้ว" },
    failed: { title: "สร้างรีลไฮไลต์ไม่สำเร็จ",       body: "สร้าง {title} ไม่สำเร็จ แตะเพื่อลองอีกครั้ง" },
  },
  ms: {
    defaultTitle: "Sorotan Pusingan",
    ready:  { title: "Reel sorotan anda sudah sedia", body: "{title} telah siap dan boleh ditonton." },
    failed: { title: "Reel sorotan anda gagal",       body: "{title} gagal disiapkan. Ketik untuk mencuba lagi." },
  },
  id: {
    defaultTitle: "Sorotan Ronde",
    ready:  { title: "Reel sorotan Anda sudah siap",  body: "{title} sudah siap untuk ditonton." },
    failed: { title: "Reel sorotan Anda gagal",       body: "{title} gagal dibuat. Ketuk untuk mencoba lagi." },
  },
  vi: {
    defaultTitle: "Khoảnh khắc nổi bật của vòng",
    ready:  { title: "Reel nổi bật của bạn đã sẵn sàng", body: "{title} đã sẵn sàng để xem." },
    failed: { title: "Tạo reel nổi bật thất bại",     body: "Không thể tạo {title}. Nhấn để thử lại." },
  },
  fil: {
    defaultTitle: "Mga Highlight ng Round",
    ready:  { title: "Handa na ang iyong highlight reel", body: "Handa nang panoorin ang {title}." },
    failed: { title: "Nabigo ang iyong highlight reel", body: "Hindi nagawa ang {title}. I-tap para subukan ulit." },
  },
  sw: {
    defaultTitle: "Vivutio vya Raundi",
    ready:  { title: "Reel yako ya vivutio iko tayari", body: "{title} iko tayari kutazamwa." },
    failed: { title: "Reel yako ya vivutio imeshindikana", body: "{title} haikuweza kutengenezwa. Gusa ili ujaribu tena." },
  },
  af: {
    defaultTitle: "Rondte-hoogtepunte",
    // "gerenderd" is the Dutch past participle; Afrikaans uses "gerender"
    // (no trailing -d).
    ready:  { title: "Jou hoogtepunt-rolprent is gereed", body: "{title} is gerender en gereed om te kyk." },
    failed: { title: "Jou hoogtepunt-rolprent het misluk", body: "{title} kon nie gerender word nie. Tik om weer te probeer." },
  },
  am: {
    defaultTitle: "የዙር ድምቀቶች",
    ready:  { title: "የእርስዎ የድምቀት ሪል ዝግጁ ነው",       body: "{title} ተሰናድቷል እና ለመመልከት ዝግጁ ነው።" },
    failed: { title: "የእርስዎ የድምቀት ሪል አልተሳካም",       body: "{title} ሊሰናዳ አልቻለም። እንደገና ለመሞከር ይንኩ።" },
  },
  ha: {
    defaultTitle: "Manyan Lokuta na Zagaye",
    // Anchor pronouns on "reel ɗinka" (your reel — masc) instead of on
    // {title}, and use the impersonal "an + verb" for the failure path
    // so we never need to gender the verb against an unknown title.
    ready:  { title: "Reel ɗinka na manyan lokuta a shirye yake", body: "Reel ɗinka ({title}) yana shirye don kallo." },
    failed: { title: "Reel ɗinka na manyan lokuta ya kasa",  body: "An kasa shirya reel ɗinka ({title}). Danna don sake gwadawa." },
  },
  zu: {
    defaultTitle: "Okuvelele Komzuliswano",
    // The previous bodies prefixed the user-supplied {title} with "I-" to
    // form the noun-class prefix, but the default Zulu title already
    // starts with its own prefix ("Okuvelele Komzuliswano") and custom
    // titles are unpredictable. Anchor the verb agreement on the fixed
    // noun "i-reel yakho" instead and append the title plainly.
    ready:  { title: "I-reel yakho yokuvelele isilungile",  body: "I-reel yakho isikulungele ukubukwa: {title}." },
    failed: { title: "I-reel yakho yokuvelele yehlulekile", body: "I-reel yakho ayikwazanga ukwenziwa: {title}. Thepha ukuze uzame futhi." },
  },
  yo: {
    defaultTitle: "Àkójọpọ̀ Ìyípo",
    // The earlier ready body said "ti ṣe tán" ("has finished doing") and
    // then "ṣetán" ("ready") — the same root twice in one sentence. Use
    // a single, cleaner verb.
    ready:  { title: "Reel àkójọpọ̀ rẹ ti ṣetán",          body: "Reel rẹ ti ṣetán fún wíwò: {title}." },
    failed: { title: "Reel àkójọpọ̀ rẹ kùnà",              body: "A kò lè ṣe {title}. Tẹ̀ láti gbìyànjú lẹ́ẹ̀kan sí i." },
  },
};

export function isSupportedHighlightPushLang(lang: string | null | undefined): lang is HighlightPushLang {
  return !!lang && (HIGHLIGHT_PUSH_LANGS as string[]).includes(lang);
}

/**
 * Translate the highlight-ready / highlight-failed push into the
 * recipient's language. Falls back to English when the language is not
 * yet supported. The reel title (when present) is interpolated as-is;
 * when missing, the language's localised default is used.
 */
export function translateHighlightPush(
  lang: string | null | undefined,
  status: "ready" | "failed",
  reelTitle?: string | null,
): { title: string; body: string } {
  const code = isSupportedHighlightPushLang(lang) ? lang : "en";
  const pack = PACKS[code];
  const strings = status === "ready" ? pack.ready : pack.failed;
  const title = (reelTitle ?? "").trim() || pack.defaultTitle;
  return {
    title: strings.title,
    body: fmt(strings.body, { title }),
  };
}
