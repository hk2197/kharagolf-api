/**
 * Task #1522 — Translations for the stuck side-game receipt digest email
 * (Task #1290).
 *
 * The digest body shipped in Task #1290 was hardcoded English (subject,
 * intro paragraph, table labels, cadence label, footer). This module
 * mirrors the surface declared by `walletTopupRefundDigestI18n.ts`
 * (Task #1232) and supplies translated copy for every visible string
 * inside `buildSideGameReceiptDigestEmailContent` in `mailer.ts`.
 *
 * The schedule itself only stores email addresses (not user IDs), so the
 * caller resolves the language from the org's `defaultLanguage` and
 * passes it in. Unsupported codes fall back to English, matching
 * `resolveWalletTopupRefundDigestLang`.
 *
 * The 21-locale set matches the `supported_language` enum and the
 * existing `walletTopupRefundDigestI18n.ts` / `walletRefundI18n.ts` /
 * `customDomainEmailI18n.ts` packs so a club's finance + support staff
 * see the same translations across every cron-emitted digest.
 */

export type SideGameReceiptDigestLang =
  | "en" | "hi" | "ar" | "es" | "fr" | "de" | "pt"
  | "ja" | "ko" | "zh" | "th" | "ms" | "id" | "vi"
  | "fil" | "sw" | "af" | "am" | "ha" | "zu" | "yo";

export const SIDE_GAME_RECEIPT_DIGEST_LANGS: SideGameReceiptDigestLang[] = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

export function isSupportedSideGameReceiptDigestLang(
  lang: string | null | undefined,
): lang is SideGameReceiptDigestLang {
  return !!lang && (SIDE_GAME_RECEIPT_DIGEST_LANGS as string[]).includes(lang);
}

/**
 * BCP-47 locale used for `Date#toLocaleDateString` in the period range.
 * Matches the mapping used by `walletTopupRefundDigestI18n.ts` so the
 * digest's date range renders with the same conventions as the related
 * finance digest.
 */
const LOCALE_BY_LANG: Record<SideGameReceiptDigestLang, string> = {
  en: "en-US", hi: "hi-IN", ar: "ar", es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR",
  ja: "ja-JP", ko: "ko-KR", zh: "zh-CN", th: "th-TH", ms: "ms-MY", id: "id-ID", vi: "vi-VN",
  fil: "fil-PH", sw: "sw-KE", af: "af-ZA", am: "am-ET", ha: "ha-NG", zu: "zu-ZA", yo: "yo-NG",
};

function fmt(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? "" : String(v);
  });
}

interface LangPack {
  /** Header strip label rendered above the body card. */
  headerLabel: string;
  /** Subject when rowCount === 0. Vars: `{orgName}`. */
  subjectEmptyDaily: string;
  subjectEmptyWeekly: string;
  /** Subject when rowCount > 0. Vars: `{orgName}`, `{count}`. */
  subjectNonEmptyDaily: string;
  subjectNonEmptyWeekly: string;
  /** H2 heading inside the card. */
  headingDaily: string;
  headingWeekly: string;
  /**
   * Intro paragraph when rowCount === 0. Vars: `{orgName}`. The
   * `{orgName}` placeholder is wrapped in
   * `<strong style="color:#fff;">…</strong>` by the caller, which
   * expects `{orgName}` to appear exactly once.
   */
  introEmpty: string;
  /** Intro paragraph when rowCount > 0. Vars: `{orgName}`. */
  introNonEmptyDaily: string;
  introNonEmptyWeekly: string;
  labelPeriod: string;
  labelCadence: string;
  /** Localised cadence value rendered in the cadence row. */
  cadenceDaily: string;
  cadenceWeekly: string;
  labelExhausted: string;
  labelSkipped: string;
  labelTotal: string;
  /**
   * Footer paragraph (no template vars — the platform brand "KHARAGOLF"
   * is baked in to mirror the original English copy). Includes the
   * navigation hint to the "Stuck side-game receipts" admin panel,
   * translated where natural.
   */
  footer: string;
}

const PACKS: Record<SideGameReceiptDigestLang, LangPack> = {
  en: {
    headerLabel: "Stuck side-game receipts",
    subjectEmptyDaily: "Daily stuck side-game receipts — none for {orgName}",
    subjectEmptyWeekly: "Weekly stuck side-game receipts — none for {orgName}",
    subjectNonEmptyDaily: "Daily stuck side-game receipts — {count} need follow-up ({orgName})",
    subjectNonEmptyWeekly: "Weekly stuck side-game receipts — {count} need follow-up ({orgName})",
    headingDaily: "Daily stuck-receipt digest",
    headingWeekly: "Weekly stuck-receipt digest",
    introEmpty: "Good news — no side-game receipts at {orgName} got stuck during this period. The CSV is empty but attached for reconciliation continuity.",
    introNonEmptyDaily: "Below is the daily digest of side-game settlement receipts at {orgName} whose email or push delivery did not complete. Open the attached CSV to follow up with the affected players (or use the dashboard's \"Re-queue delivery\" action to retry).",
    introNonEmptyWeekly: "Below is the weekly digest of side-game settlement receipts at {orgName} whose email or push delivery did not complete. Open the attached CSV to follow up with the affected players (or use the dashboard's \"Re-queue delivery\" action to retry).",
    labelPeriod: "Period",
    labelCadence: "Cadence",
    cadenceDaily: "Daily",
    cadenceWeekly: "Weekly",
    labelExhausted: "Retries exhausted",
    labelSkipped: "Permanently skipped",
    labelTotal: "Total stuck rows",
    footer: "This digest is sent on a schedule by KHARAGOLF. To change the cadence or recipients, open the dashboard and edit the \"Stuck side-game receipts\" panel.",
  },

  hi: {
    headerLabel: "अटकी हुई साइड-गेम रसीदें",
    subjectEmptyDaily: "दैनिक अटकी साइड-गेम रसीदें — {orgName} के लिए कोई नहीं",
    subjectEmptyWeekly: "साप्ताहिक अटकी साइड-गेम रसीदें — {orgName} के लिए कोई नहीं",
    subjectNonEmptyDaily: "दैनिक अटकी साइड-गेम रसीदें — {count} पर फॉलो-अप ज़रूरी ({orgName})",
    subjectNonEmptyWeekly: "साप्ताहिक अटकी साइड-गेम रसीदें — {count} पर फॉलो-अप ज़रूरी ({orgName})",
    headingDaily: "दैनिक अटकी-रसीद डाइजेस्ट",
    headingWeekly: "साप्ताहिक अटकी-रसीद डाइजेस्ट",
    introEmpty: "अच्छी खबर — इस अवधि में {orgName} पर कोई भी साइड-गेम रसीद अटकी नहीं। CSV खाली है लेकिन मिलान निरंतरता के लिए संलग्न है।",
    introNonEmptyDaily: "नीचे {orgName} पर साइड-गेम सेटलमेंट रसीदों का दैनिक डाइजेस्ट है जिनकी ईमेल या पुश डिलीवरी पूरी नहीं हुई। प्रभावित खिलाड़ियों से संपर्क करने के लिए संलग्न CSV खोलें (या डैशबोर्ड के \"डिलीवरी पुनः-कतार\" क्रिया का उपयोग करें)।",
    introNonEmptyWeekly: "नीचे {orgName} पर साइड-गेम सेटलमेंट रसीदों का साप्ताहिक डाइजेस्ट है जिनकी ईमेल या पुश डिलीवरी पूरी नहीं हुई। प्रभावित खिलाड़ियों से संपर्क करने के लिए संलग्न CSV खोलें (या डैशबोर्ड के \"डिलीवरी पुनः-कतार\" क्रिया का उपयोग करें)।",
    labelPeriod: "अवधि",
    labelCadence: "आवृत्ति",
    cadenceDaily: "दैनिक",
    cadenceWeekly: "साप्ताहिक",
    labelExhausted: "पुनः-प्रयास समाप्त",
    labelSkipped: "स्थायी रूप से छोड़ा गया",
    labelTotal: "कुल अटकी पंक्तियाँ",
    footer: "यह डाइजेस्ट KHARAGOLF द्वारा शेड्यूल पर भेजा जाता है। आवृत्ति या प्राप्तकर्ताओं को बदलने के लिए, डैशबोर्ड खोलें और \"अटकी हुई साइड-गेम रसीदें\" पैनल संपादित करें।",
  },

  ar: {
    headerLabel: "إيصالات اللعبة الجانبية العالقة",
    subjectEmptyDaily: "إيصالات اللعبة الجانبية العالقة اليومية — لا يوجد شيء لـ {orgName}",
    subjectEmptyWeekly: "إيصالات اللعبة الجانبية العالقة الأسبوعية — لا يوجد شيء لـ {orgName}",
    subjectNonEmptyDaily: "إيصالات اللعبة الجانبية العالقة اليومية — {count} تحتاج إلى متابعة ({orgName})",
    subjectNonEmptyWeekly: "إيصالات اللعبة الجانبية العالقة الأسبوعية — {count} تحتاج إلى متابعة ({orgName})",
    headingDaily: "ملخص يومي للإيصالات العالقة",
    headingWeekly: "ملخص أسبوعي للإيصالات العالقة",
    introEmpty: "أخبار جيدة — لم تعلق أي إيصالات لعبة جانبية في {orgName} خلال هذه الفترة. ملف CSV فارغ لكنه مرفق للحفاظ على استمرارية التسوية.",
    introNonEmptyDaily: "في ما يلي الملخص اليومي لإيصالات تسوية اللعبة الجانبية في {orgName} التي لم تكتمل تسليمها عبر البريد الإلكتروني أو الإشعار الفوري. افتح ملف CSV المرفق لمتابعة اللاعبين المتأثرين (أو استخدم إجراء \"إعادة وضع التسليم في قائمة الانتظار\" في لوحة التحكم لإعادة المحاولة).",
    introNonEmptyWeekly: "في ما يلي الملخص الأسبوعي لإيصالات تسوية اللعبة الجانبية في {orgName} التي لم تكتمل تسليمها عبر البريد الإلكتروني أو الإشعار الفوري. افتح ملف CSV المرفق لمتابعة اللاعبين المتأثرين (أو استخدم إجراء \"إعادة وضع التسليم في قائمة الانتظار\" في لوحة التحكم لإعادة المحاولة).",
    labelPeriod: "الفترة",
    labelCadence: "التكرار",
    cadenceDaily: "يومي",
    cadenceWeekly: "أسبوعي",
    labelExhausted: "نفدت المحاولات",
    labelSkipped: "تم تخطيها نهائياً",
    labelTotal: "إجمالي الصفوف العالقة",
    footer: "يتم إرسال هذا الملخص وفق جدول زمني بواسطة KHARAGOLF. لتغيير التكرار أو المستلمين، افتح لوحة التحكم وعدّل لوحة \"إيصالات اللعبة الجانبية العالقة\".",
  },

  es: {
    headerLabel: "Recibos de juego paralelo atascados",
    subjectEmptyDaily: "Recibos de juego paralelo atascados — diario, ninguno para {orgName}",
    subjectEmptyWeekly: "Recibos de juego paralelo atascados — semanal, ninguno para {orgName}",
    subjectNonEmptyDaily: "Recibos de juego paralelo atascados — diario, {count} requieren seguimiento ({orgName})",
    subjectNonEmptyWeekly: "Recibos de juego paralelo atascados — semanal, {count} requieren seguimiento ({orgName})",
    headingDaily: "Resumen diario de recibos atascados",
    headingWeekly: "Resumen semanal de recibos atascados",
    introEmpty: "Buenas noticias — ningún recibo de juego paralelo en {orgName} quedó atascado durante este período. El CSV está vacío pero adjunto para mantener la continuidad de la conciliación.",
    introNonEmptyDaily: "A continuación está el resumen diario de los recibos de liquidación de juego paralelo en {orgName} cuya entrega por correo o notificación push no se completó. Abre el CSV adjunto para hacer seguimiento con los jugadores afectados (o usa la acción \"Reencolar entrega\" del panel para reintentar).",
    introNonEmptyWeekly: "A continuación está el resumen semanal de los recibos de liquidación de juego paralelo en {orgName} cuya entrega por correo o notificación push no se completó. Abre el CSV adjunto para hacer seguimiento con los jugadores afectados (o usa la acción \"Reencolar entrega\" del panel para reintentar).",
    labelPeriod: "Período",
    labelCadence: "Frecuencia",
    cadenceDaily: "diario",
    cadenceWeekly: "semanal",
    labelExhausted: "Reintentos agotados",
    labelSkipped: "Omitidos permanentemente",
    labelTotal: "Total de filas atascadas",
    footer: "Este resumen lo envía KHARAGOLF según un calendario. Para cambiar la frecuencia o los destinatarios, abre el panel y edita la sección \"Recibos de juego paralelo atascados\".",
  },

  fr: {
    headerLabel: "Reçus de side-game bloqués",
    subjectEmptyDaily: "Reçus de side-game bloqués — quotidien, aucun pour {orgName}",
    subjectEmptyWeekly: "Reçus de side-game bloqués — hebdomadaire, aucun pour {orgName}",
    subjectNonEmptyDaily: "Reçus de side-game bloqués — quotidien, {count} à traiter ({orgName})",
    subjectNonEmptyWeekly: "Reçus de side-game bloqués — hebdomadaire, {count} à traiter ({orgName})",
    headingDaily: "Récapitulatif quotidien des reçus bloqués",
    headingWeekly: "Récapitulatif hebdomadaire des reçus bloqués",
    introEmpty: "Bonne nouvelle — aucun reçu de side-game chez {orgName} n'est resté bloqué sur cette période. Le CSV est vide mais joint pour assurer la continuité de la réconciliation.",
    introNonEmptyDaily: "Voici le récapitulatif quotidien des reçus de règlement side-game chez {orgName} dont la livraison par e-mail ou notification n'a pas abouti. Ouvrez le CSV joint pour relancer les joueurs concernés (ou utilisez l'action \"Remettre la livraison en file\" du tableau de bord pour réessayer).",
    introNonEmptyWeekly: "Voici le récapitulatif hebdomadaire des reçus de règlement side-game chez {orgName} dont la livraison par e-mail ou notification n'a pas abouti. Ouvrez le CSV joint pour relancer les joueurs concernés (ou utilisez l'action \"Remettre la livraison en file\" du tableau de bord pour réessayer).",
    labelPeriod: "Période",
    labelCadence: "Fréquence",
    cadenceDaily: "quotidien",
    cadenceWeekly: "hebdomadaire",
    labelExhausted: "Tentatives épuisées",
    labelSkipped: "Définitivement ignorés",
    labelTotal: "Total des lignes bloquées",
    footer: "Ce récapitulatif est envoyé selon un planning par KHARAGOLF. Pour modifier la fréquence ou les destinataires, ouvrez le tableau de bord et éditez le panneau \"Reçus de side-game bloqués\".",
  },

  de: {
    headerLabel: "Hängende Side-Game-Belege",
    subjectEmptyDaily: "Tägliche hängende Side-Game-Belege — keine für {orgName}",
    subjectEmptyWeekly: "Wöchentliche hängende Side-Game-Belege — keine für {orgName}",
    subjectNonEmptyDaily: "Tägliche hängende Side-Game-Belege — {count} benötigen Nachverfolgung ({orgName})",
    subjectNonEmptyWeekly: "Wöchentliche hängende Side-Game-Belege — {count} benötigen Nachverfolgung ({orgName})",
    headingDaily: "Täglicher Bericht zu hängenden Belegen",
    headingWeekly: "Wöchentlicher Bericht zu hängenden Belegen",
    introEmpty: "Gute Nachricht — in diesem Zeitraum sind bei {orgName} keine Side-Game-Belege hängen geblieben. Die CSV ist leer, aber zur Abgleichkontinuität beigefügt.",
    introNonEmptyDaily: "Im Folgenden finden Sie den täglichen Bericht der Side-Game-Abrechnungsbelege bei {orgName}, deren Zustellung per E-Mail oder Push fehlgeschlagen ist. Öffnen Sie die beigefügte CSV, um die betroffenen Spieler nachzufassen (oder nutzen Sie die Aktion \"Zustellung neu einreihen\" im Dashboard für einen erneuten Versuch).",
    introNonEmptyWeekly: "Im Folgenden finden Sie den wöchentlichen Bericht der Side-Game-Abrechnungsbelege bei {orgName}, deren Zustellung per E-Mail oder Push fehlgeschlagen ist. Öffnen Sie die beigefügte CSV, um die betroffenen Spieler nachzufassen (oder nutzen Sie die Aktion \"Zustellung neu einreihen\" im Dashboard für einen erneuten Versuch).",
    labelPeriod: "Zeitraum",
    labelCadence: "Frequenz",
    cadenceDaily: "täglich",
    cadenceWeekly: "wöchentlich",
    labelExhausted: "Wiederholungen erschöpft",
    labelSkipped: "Dauerhaft übersprungen",
    labelTotal: "Hängende Zeilen gesamt",
    footer: "Dieser Bericht wird von KHARAGOLF nach einem Zeitplan versendet. Um die Frequenz oder Empfänger zu ändern, öffnen Sie das Dashboard und bearbeiten Sie das Panel \"Hängende Side-Game-Belege\".",
  },

  pt: {
    headerLabel: "Recibos de side-game travados",
    subjectEmptyDaily: "Recibos de side-game travados — diário, nenhum para {orgName}",
    subjectEmptyWeekly: "Recibos de side-game travados — semanal, nenhum para {orgName}",
    subjectNonEmptyDaily: "Recibos de side-game travados — diário, {count} precisam de acompanhamento ({orgName})",
    subjectNonEmptyWeekly: "Recibos de side-game travados — semanal, {count} precisam de acompanhamento ({orgName})",
    headingDaily: "Resumo diário de recibos travados",
    headingWeekly: "Resumo semanal de recibos travados",
    introEmpty: "Boa notícia — nenhum recibo de side-game em {orgName} ficou travado durante este período. O CSV está vazio, mas anexo para manter a continuidade da conciliação.",
    introNonEmptyDaily: "Abaixo está o resumo diário dos recibos de liquidação de side-game em {orgName} cuja entrega por e-mail ou push não foi concluída. Abra o CSV em anexo para acompanhar os jogadores afetados (ou use a ação \"Reenfileirar entrega\" no painel para tentar novamente).",
    introNonEmptyWeekly: "Abaixo está o resumo semanal dos recibos de liquidação de side-game em {orgName} cuja entrega por e-mail ou push não foi concluída. Abra o CSV em anexo para acompanhar os jogadores afetados (ou use a ação \"Reenfileirar entrega\" no painel para tentar novamente).",
    labelPeriod: "Período",
    labelCadence: "Frequência",
    cadenceDaily: "diário",
    cadenceWeekly: "semanal",
    labelExhausted: "Tentativas esgotadas",
    labelSkipped: "Permanentemente ignorados",
    labelTotal: "Total de linhas travadas",
    footer: "Este resumo é enviado conforme um cronograma pela KHARAGOLF. Para alterar a frequência ou os destinatários, abra o painel e edite a seção \"Recibos de side-game travados\".",
  },

  ja: {
    headerLabel: "滞留しているサイドゲーム領収",
    subjectEmptyDaily: "日次の滞留サイドゲーム領収 — {orgName} は対象なし",
    subjectEmptyWeekly: "週次の滞留サイドゲーム領収 — {orgName} は対象なし",
    subjectNonEmptyDaily: "日次の滞留サイドゲーム領収 — {count} 件のフォローアップが必要 ({orgName})",
    subjectNonEmptyWeekly: "週次の滞留サイドゲーム領収 — {count} 件のフォローアップが必要 ({orgName})",
    headingDaily: "日次の滞留領収ダイジェスト",
    headingWeekly: "週次の滞留領収ダイジェスト",
    introEmpty: "ご報告 — 今期は {orgName} で滞留したサイドゲーム領収はありません。CSV は空ですが、消し込みの継続性のため添付しています。",
    introNonEmptyDaily: "以下は {orgName} におけるサイドゲーム精算領収のうち、メールまたはプッシュ配信が完了しなかったものの日次ダイジェストです。添付の CSV を開いて該当プレイヤーへのフォローアップを行ってください（またはダッシュボードの「配信を再キュー」操作で再試行できます）。",
    introNonEmptyWeekly: "以下は {orgName} におけるサイドゲーム精算領収のうち、メールまたはプッシュ配信が完了しなかったものの週次ダイジェストです。添付の CSV を開いて該当プレイヤーへのフォローアップを行ってください（またはダッシュボードの「配信を再キュー」操作で再試行できます）。",
    labelPeriod: "期間",
    labelCadence: "頻度",
    cadenceDaily: "日次",
    cadenceWeekly: "週次",
    labelExhausted: "再試行が尽きた件数",
    labelSkipped: "恒久的にスキップ",
    labelTotal: "滞留行の合計",
    footer: "このダイジェストは KHARAGOLF がスケジュールに沿って配信します。頻度や宛先を変更するには、ダッシュボードを開いて「滞留しているサイドゲーム領収」パネルを編集してください。",
  },

  ko: {
    headerLabel: "지연된 사이드 게임 영수증",
    subjectEmptyDaily: "일일 지연된 사이드 게임 영수증 — {orgName}에 해당 없음",
    subjectEmptyWeekly: "주간 지연된 사이드 게임 영수증 — {orgName}에 해당 없음",
    subjectNonEmptyDaily: "일일 지연된 사이드 게임 영수증 — {count}건 후속 조치 필요 ({orgName})",
    subjectNonEmptyWeekly: "주간 지연된 사이드 게임 영수증 — {count}건 후속 조치 필요 ({orgName})",
    headingDaily: "일일 지연 영수증 다이제스트",
    headingWeekly: "주간 지연 영수증 다이제스트",
    introEmpty: "좋은 소식 — 이번 기간 동안 {orgName}에서 지연된 사이드 게임 영수증은 없습니다. CSV는 비어 있지만 정산 연속성을 위해 첨부됩니다.",
    introNonEmptyDaily: "다음은 {orgName}에서 이메일 또는 푸시 전송이 완료되지 않은 사이드 게임 정산 영수증의 일일 다이제스트입니다. 영향을 받은 플레이어에게 후속 조치를 위해 첨부된 CSV를 열어 주세요(또는 대시보드의 \"전송 재대기열\" 작업으로 재시도할 수 있습니다).",
    introNonEmptyWeekly: "다음은 {orgName}에서 이메일 또는 푸시 전송이 완료되지 않은 사이드 게임 정산 영수증의 주간 다이제스트입니다. 영향을 받은 플레이어에게 후속 조치를 위해 첨부된 CSV를 열어 주세요(또는 대시보드의 \"전송 재대기열\" 작업으로 재시도할 수 있습니다).",
    labelPeriod: "기간",
    labelCadence: "주기",
    cadenceDaily: "일간",
    cadenceWeekly: "주간",
    labelExhausted: "재시도 소진",
    labelSkipped: "영구 건너뜀",
    labelTotal: "전체 지연 행",
    footer: "이 다이제스트는 KHARAGOLF가 예약에 따라 전송합니다. 주기나 수신자를 변경하려면 대시보드를 열고 \"지연된 사이드 게임 영수증\" 패널을 편집하세요.",
  },

  zh: {
    headerLabel: "卡住的副赛事收据",
    subjectEmptyDaily: "每日卡住的副赛事收据 — {orgName} 无",
    subjectEmptyWeekly: "每周卡住的副赛事收据 — {orgName} 无",
    subjectNonEmptyDaily: "每日卡住的副赛事收据 — {count} 条需要跟进 ({orgName})",
    subjectNonEmptyWeekly: "每周卡住的副赛事收据 — {count} 条需要跟进 ({orgName})",
    headingDaily: "每日卡住收据摘要",
    headingWeekly: "每周卡住收据摘要",
    introEmpty: "好消息 — 本期间 {orgName} 没有副赛事收据被卡住。CSV 为空，但仍附上以保持对账连续性。",
    introNonEmptyDaily: "以下是 {orgName} 中邮件或推送投递未完成的副赛事结算收据每日摘要。请打开附件 CSV 跟进受影响的球员（或使用仪表板中的\"重新排队投递\"操作进行重试）。",
    introNonEmptyWeekly: "以下是 {orgName} 中邮件或推送投递未完成的副赛事结算收据每周摘要。请打开附件 CSV 跟进受影响的球员（或使用仪表板中的\"重新排队投递\"操作进行重试）。",
    labelPeriod: "期间",
    labelCadence: "频率",
    cadenceDaily: "每日",
    cadenceWeekly: "每周",
    labelExhausted: "重试已耗尽",
    labelSkipped: "永久跳过",
    labelTotal: "卡住行总数",
    footer: "此摘要由 KHARAGOLF 按计划发送。如需更改频率或收件人，请打开仪表板并编辑\"卡住的副赛事收据\"面板。",
  },

  th: {
    headerLabel: "ใบเสร็จเกมเสริมที่ติดค้าง",
    subjectEmptyDaily: "ใบเสร็จเกมเสริมที่ติดค้างรายวัน — ไม่มีสำหรับ {orgName}",
    subjectEmptyWeekly: "ใบเสร็จเกมเสริมที่ติดค้างรายสัปดาห์ — ไม่มีสำหรับ {orgName}",
    subjectNonEmptyDaily: "ใบเสร็จเกมเสริมที่ติดค้างรายวัน — {count} รายการต้องติดตาม ({orgName})",
    subjectNonEmptyWeekly: "ใบเสร็จเกมเสริมที่ติดค้างรายสัปดาห์ — {count} รายการต้องติดตาม ({orgName})",
    headingDaily: "สรุปรายวันใบเสร็จที่ติดค้าง",
    headingWeekly: "สรุปรายสัปดาห์ใบเสร็จที่ติดค้าง",
    introEmpty: "ข่าวดี — ไม่มีใบเสร็จเกมเสริมของ {orgName} ที่ติดค้างในช่วงนี้ ไฟล์ CSV ว่างเปล่าแต่แนบมาเพื่อความต่อเนื่องของการกระทบยอด",
    introNonEmptyDaily: "ด้านล่างนี้คือสรุปรายวันของใบเสร็จการชำระเกมเสริมที่ {orgName} ซึ่งการส่งทางอีเมลหรือพุชยังไม่สำเร็จ เปิดไฟล์ CSV ที่แนบมาเพื่อติดตามกับผู้เล่นที่ได้รับผลกระทบ (หรือใช้การกระทำ \"นำการส่งกลับเข้าคิว\" ในแดชบอร์ดเพื่อลองอีกครั้ง)",
    introNonEmptyWeekly: "ด้านล่างนี้คือสรุปรายสัปดาห์ของใบเสร็จการชำระเกมเสริมที่ {orgName} ซึ่งการส่งทางอีเมลหรือพุชยังไม่สำเร็จ เปิดไฟล์ CSV ที่แนบมาเพื่อติดตามกับผู้เล่นที่ได้รับผลกระทบ (หรือใช้การกระทำ \"นำการส่งกลับเข้าคิว\" ในแดชบอร์ดเพื่อลองอีกครั้ง)",
    labelPeriod: "ช่วงเวลา",
    labelCadence: "ความถี่",
    cadenceDaily: "รายวัน",
    cadenceWeekly: "รายสัปดาห์",
    labelExhausted: "พยายามซ้ำจนหมด",
    labelSkipped: "ข้ามอย่างถาวร",
    labelTotal: "รวมแถวที่ติดค้าง",
    footer: "สรุปนี้ส่งตามกำหนดการโดย KHARAGOLF หากต้องการเปลี่ยนความถี่หรือผู้รับ ให้เปิดแดชบอร์ดแล้วแก้ไขแผง \"ใบเสร็จเกมเสริมที่ติดค้าง\"",
  },

  ms: {
    headerLabel: "Resit permainan sampingan tersekat",
    subjectEmptyDaily: "Resit permainan sampingan tersekat harian — tiada untuk {orgName}",
    subjectEmptyWeekly: "Resit permainan sampingan tersekat mingguan — tiada untuk {orgName}",
    subjectNonEmptyDaily: "Resit permainan sampingan tersekat harian — {count} perlu tindakan susulan ({orgName})",
    subjectNonEmptyWeekly: "Resit permainan sampingan tersekat mingguan — {count} perlu tindakan susulan ({orgName})",
    headingDaily: "Ringkasan harian resit tersekat",
    headingWeekly: "Ringkasan mingguan resit tersekat",
    introEmpty: "Berita baik — tiada resit permainan sampingan di {orgName} yang tersekat dalam tempoh ini. CSV kosong tetapi dilampirkan untuk kesinambungan rekonsiliasi.",
    introNonEmptyDaily: "Di bawah ialah ringkasan harian resit penyelesaian permainan sampingan di {orgName} yang penghantaran e-mel atau push-nya tidak selesai. Buka CSV yang dilampirkan untuk tindakan susulan dengan pemain yang terjejas (atau gunakan tindakan \"Susun semula penghantaran\" pada papan pemuka untuk mencuba semula).",
    introNonEmptyWeekly: "Di bawah ialah ringkasan mingguan resit penyelesaian permainan sampingan di {orgName} yang penghantaran e-mel atau push-nya tidak selesai. Buka CSV yang dilampirkan untuk tindakan susulan dengan pemain yang terjejas (atau gunakan tindakan \"Susun semula penghantaran\" pada papan pemuka untuk mencuba semula).",
    labelPeriod: "Tempoh",
    labelCadence: "Kekerapan",
    cadenceDaily: "harian",
    cadenceWeekly: "mingguan",
    labelExhausted: "Cubaan habis",
    labelSkipped: "Dilangkau secara kekal",
    labelTotal: "Jumlah baris tersekat",
    footer: "Ringkasan ini dihantar mengikut jadual oleh KHARAGOLF. Untuk menukar kekerapan atau penerima, buka papan pemuka dan edit panel \"Resit permainan sampingan tersekat\".",
  },

  id: {
    headerLabel: "Tanda terima side-game tertahan",
    subjectEmptyDaily: "Tanda terima side-game tertahan harian — tidak ada untuk {orgName}",
    subjectEmptyWeekly: "Tanda terima side-game tertahan mingguan — tidak ada untuk {orgName}",
    subjectNonEmptyDaily: "Tanda terima side-game tertahan harian — {count} perlu ditindaklanjuti ({orgName})",
    subjectNonEmptyWeekly: "Tanda terima side-game tertahan mingguan — {count} perlu ditindaklanjuti ({orgName})",
    headingDaily: "Ringkasan harian tanda terima tertahan",
    headingWeekly: "Ringkasan mingguan tanda terima tertahan",
    introEmpty: "Kabar baik — tidak ada tanda terima side-game di {orgName} yang tertahan pada periode ini. CSV kosong tetapi tetap dilampirkan untuk kesinambungan rekonsiliasi.",
    introNonEmptyDaily: "Berikut adalah ringkasan harian tanda terima penyelesaian side-game di {orgName} yang pengiriman email atau push-nya belum selesai. Buka CSV terlampir untuk menindaklanjuti pemain yang terdampak (atau gunakan tindakan \"Antrekan ulang pengiriman\" di dasbor untuk mencoba lagi).",
    introNonEmptyWeekly: "Berikut adalah ringkasan mingguan tanda terima penyelesaian side-game di {orgName} yang pengiriman email atau push-nya belum selesai. Buka CSV terlampir untuk menindaklanjuti pemain yang terdampak (atau gunakan tindakan \"Antrekan ulang pengiriman\" di dasbor untuk mencoba lagi).",
    labelPeriod: "Periode",
    labelCadence: "Frekuensi",
    cadenceDaily: "harian",
    cadenceWeekly: "mingguan",
    labelExhausted: "Percobaan ulang habis",
    labelSkipped: "Dilewati secara permanen",
    labelTotal: "Total baris tertahan",
    footer: "Ringkasan ini dikirim sesuai jadwal oleh KHARAGOLF. Untuk mengubah frekuensi atau penerima, buka dasbor dan edit panel \"Tanda terima side-game tertahan\".",
  },

  vi: {
    headerLabel: "Biên nhận side-game bị kẹt",
    subjectEmptyDaily: "Biên nhận side-game bị kẹt hàng ngày — không có cho {orgName}",
    subjectEmptyWeekly: "Biên nhận side-game bị kẹt hàng tuần — không có cho {orgName}",
    subjectNonEmptyDaily: "Biên nhận side-game bị kẹt hàng ngày — {count} cần theo dõi ({orgName})",
    subjectNonEmptyWeekly: "Biên nhận side-game bị kẹt hàng tuần — {count} cần theo dõi ({orgName})",
    headingDaily: "Tóm tắt hàng ngày các biên nhận bị kẹt",
    headingWeekly: "Tóm tắt hàng tuần các biên nhận bị kẹt",
    introEmpty: "Tin tốt — không có biên nhận side-game nào tại {orgName} bị kẹt trong giai đoạn này. Tệp CSV trống nhưng vẫn được đính kèm để duy trì tính liên tục cho việc đối chiếu.",
    introNonEmptyDaily: "Dưới đây là bản tóm tắt hàng ngày các biên nhận thanh toán side-game tại {orgName} có việc gửi email hoặc push chưa hoàn tất. Mở tệp CSV đính kèm để theo dõi với những người chơi bị ảnh hưởng (hoặc dùng hành động \"Đưa lại vào hàng đợi gửi\" trên bảng điều khiển để thử lại).",
    introNonEmptyWeekly: "Dưới đây là bản tóm tắt hàng tuần các biên nhận thanh toán side-game tại {orgName} có việc gửi email hoặc push chưa hoàn tất. Mở tệp CSV đính kèm để theo dõi với những người chơi bị ảnh hưởng (hoặc dùng hành động \"Đưa lại vào hàng đợi gửi\" trên bảng điều khiển để thử lại).",
    labelPeriod: "Giai đoạn",
    labelCadence: "Tần suất",
    cadenceDaily: "hàng ngày",
    cadenceWeekly: "hàng tuần",
    labelExhausted: "Đã hết lần thử lại",
    labelSkipped: "Bị bỏ qua vĩnh viễn",
    labelTotal: "Tổng số dòng bị kẹt",
    footer: "Bản tóm tắt này được KHARAGOLF gửi theo lịch. Để thay đổi tần suất hoặc người nhận, mở bảng điều khiển và chỉnh sửa bảng \"Biên nhận side-game bị kẹt\".",
  },

  fil: {
    headerLabel: "Mga resibo ng side-game na natigil",
    subjectEmptyDaily: "Pang-araw-araw na natigil na resibo ng side-game — wala para sa {orgName}",
    subjectEmptyWeekly: "Lingguhang natigil na resibo ng side-game — wala para sa {orgName}",
    subjectNonEmptyDaily: "Pang-araw-araw na natigil na resibo ng side-game — {count} ang kailangang sundan ({orgName})",
    subjectNonEmptyWeekly: "Lingguhang natigil na resibo ng side-game — {count} ang kailangang sundan ({orgName})",
    headingDaily: "Pang-araw-araw na buod ng natigil na resibo",
    headingWeekly: "Lingguhang buod ng natigil na resibo",
    introEmpty: "Magandang balita — walang resibo ng side-game sa {orgName} ang natigil sa panahong ito. Walang laman ang CSV ngunit nakalakip pa rin para sa pagpapatuloy ng rekonsilyasyon.",
    introNonEmptyDaily: "Narito ang pang-araw-araw na buod ng mga resibo ng settlement ng side-game sa {orgName} na hindi natuloy ang paghahatid sa email o push. Buksan ang nakalakip na CSV upang sundan ang mga apektadong manlalaro (o gamitin ang aksyong \"I-queue muli ang paghahatid\" sa dashboard para subukang muli).",
    introNonEmptyWeekly: "Narito ang lingguhang buod ng mga resibo ng settlement ng side-game sa {orgName} na hindi natuloy ang paghahatid sa email o push. Buksan ang nakalakip na CSV upang sundan ang mga apektadong manlalaro (o gamitin ang aksyong \"I-queue muli ang paghahatid\" sa dashboard para subukang muli).",
    labelPeriod: "Panahon",
    labelCadence: "Dalas",
    cadenceDaily: "araw-araw",
    cadenceWeekly: "lingguhan",
    labelExhausted: "Naubos ang pagsubok-muli",
    labelSkipped: "Permanenteng nilaktawan",
    labelTotal: "Kabuuang natigil na hilera",
    footer: "Ang buod na ito ay ipinapadala ayon sa iskedyul ng KHARAGOLF. Upang baguhin ang dalas o mga tatanggap, buksan ang dashboard at i-edit ang panel na \"Mga resibo ng side-game na natigil\".",
  },

  sw: {
    headerLabel: "Risiti za mchezo wa pembeni zilizokwama",
    subjectEmptyDaily: "Risiti za mchezo wa pembeni zilizokwama za kila siku — hakuna kwa {orgName}",
    subjectEmptyWeekly: "Risiti za mchezo wa pembeni zilizokwama za kila wiki — hakuna kwa {orgName}",
    subjectNonEmptyDaily: "Risiti za mchezo wa pembeni zilizokwama za kila siku — {count} zinahitaji ufuatiliaji ({orgName})",
    subjectNonEmptyWeekly: "Risiti za mchezo wa pembeni zilizokwama za kila wiki — {count} zinahitaji ufuatiliaji ({orgName})",
    headingDaily: "Muhtasari wa kila siku wa risiti zilizokwama",
    headingWeekly: "Muhtasari wa kila wiki wa risiti zilizokwama",
    introEmpty: "Habari njema — hakuna risiti za mchezo wa pembeni katika {orgName} zilizokwama katika kipindi hiki. CSV ni tupu lakini imeambatishwa kwa kuendeleza upatanisho.",
    introNonEmptyDaily: "Hapa chini ni muhtasari wa kila siku wa risiti za malipo ya mchezo wa pembeni katika {orgName} ambazo utumaji wa barua pepe au arifa za push haukukamilika. Fungua CSV iliyoambatishwa kufuatilia wachezaji walioathiriwa (au tumia kitendo cha \"Rudisha utumaji kwenye foleni\" kwenye dashibodi kujaribu tena).",
    introNonEmptyWeekly: "Hapa chini ni muhtasari wa kila wiki wa risiti za malipo ya mchezo wa pembeni katika {orgName} ambazo utumaji wa barua pepe au arifa za push haukukamilika. Fungua CSV iliyoambatishwa kufuatilia wachezaji walioathiriwa (au tumia kitendo cha \"Rudisha utumaji kwenye foleni\" kwenye dashibodi kujaribu tena).",
    labelPeriod: "Kipindi",
    labelCadence: "Mzunguko",
    cadenceDaily: "kila siku",
    cadenceWeekly: "kila wiki",
    labelExhausted: "Majaribio yamekamilika",
    labelSkipped: "Imerukwa kabisa",
    labelTotal: "Jumla ya safu zilizokwama",
    footer: "Muhtasari huu hutumwa kwa ratiba na KHARAGOLF. Ili kubadilisha mzunguko au wapokeaji, fungua dashibodi na uhariri paneli ya \"Risiti za mchezo wa pembeni zilizokwama\".",
  },

  af: {
    headerLabel: "Vasgekeerde side-game-kwitansies",
    subjectEmptyDaily: "Daaglikse vasgekeerde side-game-kwitansies — geen vir {orgName} nie",
    subjectEmptyWeekly: "Weeklikse vasgekeerde side-game-kwitansies — geen vir {orgName} nie",
    subjectNonEmptyDaily: "Daaglikse vasgekeerde side-game-kwitansies — {count} benodig opvolg ({orgName})",
    subjectNonEmptyWeekly: "Weeklikse vasgekeerde side-game-kwitansies — {count} benodig opvolg ({orgName})",
    headingDaily: "Daaglikse opsomming van vasgekeerde kwitansies",
    headingWeekly: "Weeklikse opsomming van vasgekeerde kwitansies",
    introEmpty: "Goeie nuus — geen side-game-kwitansies by {orgName} het in hierdie tydperk vasgekeer nie. Die CSV is leeg maar aangeheg vir kontinuïteit van versoening.",
    introNonEmptyDaily: "Hieronder is die daaglikse opsomming van side-game-vereffeningskwitansies by {orgName} waarvan die e-pos- of push-aflewering nie voltooi is nie. Open die aangehegte CSV om met die geaffekteerde spelers op te volg (of gebruik die \"Hertou aflewering\"-aksie op die paneelbord om weer te probeer).",
    introNonEmptyWeekly: "Hieronder is die weeklikse opsomming van side-game-vereffeningskwitansies by {orgName} waarvan die e-pos- of push-aflewering nie voltooi is nie. Open die aangehegte CSV om met die geaffekteerde spelers op te volg (of gebruik die \"Hertou aflewering\"-aksie op die paneelbord om weer te probeer).",
    labelPeriod: "Tydperk",
    labelCadence: "Frekwensie",
    cadenceDaily: "daagliks",
    cadenceWeekly: "weekliks",
    labelExhausted: "Hertoetse uitgeput",
    labelSkipped: "Permanent oorgeslaan",
    labelTotal: "Totaal vasgekeerde rye",
    footer: "Hierdie opsomming word op 'n skedule deur KHARAGOLF gestuur. Om die frekwensie of ontvangers te verander, open die paneelbord en wysig die paneel \"Vasgekeerde side-game-kwitansies\".",
  },

  am: {
    headerLabel: "የተጣበቁ የጎን-ጨዋታ ደረሰኞች",
    subjectEmptyDaily: "የዕለታዊ የተጣበቁ የጎን-ጨዋታ ደረሰኞች — ለ{orgName} ምንም የለም",
    subjectEmptyWeekly: "የሳምንታዊ የተጣበቁ የጎን-ጨዋታ ደረሰኞች — ለ{orgName} ምንም የለም",
    subjectNonEmptyDaily: "የዕለታዊ የተጣበቁ የጎን-ጨዋታ ደረሰኞች — {count} ክትትል ይፈልጋሉ ({orgName})",
    subjectNonEmptyWeekly: "የሳምንታዊ የተጣበቁ የጎን-ጨዋታ ደረሰኞች — {count} ክትትል ይፈልጋሉ ({orgName})",
    headingDaily: "የዕለታዊ የተጣበቀ-ደረሰኝ ማጠቃለያ",
    headingWeekly: "የሳምንታዊ የተጣበቀ-ደረሰኝ ማጠቃለያ",
    introEmpty: "መልካም ዜና — በዚህ ወቅት በ{orgName} ምንም የጎን-ጨዋታ ደረሰኝ አልተጣበቀም። CSV ባዶ ቢሆንም ለማስታረቅ ቀጣይነት ተያይዟል።",
    introNonEmptyDaily: "ከዚህ በታች የ{orgName} የጎን-ጨዋታ ሂሳብ ማጣራት ደረሰኞች ከላኩ የኢሜይል ወይም የማስታወቂያ ስርጭት ያልተጠናቀቀ የዕለታዊ ማጠቃለያ ነው። የተጎዱትን ተጫዋቾች ለመከታተል የተያያዘውን CSV ይክፈቱ (ወይም በዳሽቦርድ ላይ ያለውን \"ማድረሻ ወደ ሰልፍ መልስ\" እርምጃ ለመሞከር ይጠቀሙ)።",
    introNonEmptyWeekly: "ከዚህ በታች የ{orgName} የጎን-ጨዋታ ሂሳብ ማጣራት ደረሰኞች ከላኩ የኢሜይል ወይም የማስታወቂያ ስርጭት ያልተጠናቀቀ የሳምንታዊ ማጠቃለያ ነው። የተጎዱትን ተጫዋቾች ለመከታተል የተያያዘውን CSV ይክፈቱ (ወይም በዳሽቦርድ ላይ ያለውን \"ማድረሻ ወደ ሰልፍ መልስ\" እርምጃ ለመሞከር ይጠቀሙ)።",
    labelPeriod: "ጊዜ",
    labelCadence: "ድግግሞሽ",
    cadenceDaily: "ዕለታዊ",
    cadenceWeekly: "ሳምንታዊ",
    labelExhausted: "ሙከራዎች አልቀዋል",
    labelSkipped: "ለዘላለም ተዘሏል",
    labelTotal: "ጠቅላላ የተጣበቁ ረድፎች",
    footer: "ይህ ማጠቃለያ በ KHARAGOLF በመርሐግብር ይላካል። ድግግሞሹን ወይም ተቀባዮችን ለመለወጥ፣ ዳሽቦርዱን ይክፈቱ እና \"የተጣበቁ የጎን-ጨዋታ ደረሰኞች\" ፓነልን ያስተካክሉ።",
  },

  ha: {
    headerLabel: "Rasit ɗin side-game da suka makale",
    subjectEmptyDaily: "Rasit ɗin side-game da suka makale na yau da kullum — babu wani don {orgName}",
    subjectEmptyWeekly: "Rasit ɗin side-game da suka makale na mako-mako — babu wani don {orgName}",
    subjectNonEmptyDaily: "Rasit ɗin side-game da suka makale na yau da kullum — {count} suna buƙatar bibiya ({orgName})",
    subjectNonEmptyWeekly: "Rasit ɗin side-game da suka makale na mako-mako — {count} suna buƙatar bibiya ({orgName})",
    headingDaily: "Taƙaitaccen yau da kullum na rasit da suka makale",
    headingWeekly: "Taƙaitaccen mako-mako na rasit da suka makale",
    introEmpty: "Labari mai daɗi — babu wata rasit ɗin side-game a {orgName} da ta makale a wannan lokacin. CSV ɗin babu komai amma an haɗa shi don ci gaba da daidaitawa.",
    introNonEmptyDaily: "A ƙasa akwai taƙaitaccen yau da kullum na rasit ɗin sasantawar side-game a {orgName} waɗanda turawar imel ko push ba ta kammala ba. Buɗe CSV ɗin da aka haɗa don bibiyar 'yan wasan da abin ya shafa (ko amfani da aikin \"Sake jera turawa\" a kan dashboard don sake gwadawa).",
    introNonEmptyWeekly: "A ƙasa akwai taƙaitaccen mako-mako na rasit ɗin sasantawar side-game a {orgName} waɗanda turawar imel ko push ba ta kammala ba. Buɗe CSV ɗin da aka haɗa don bibiyar 'yan wasan da abin ya shafa (ko amfani da aikin \"Sake jera turawa\" a kan dashboard don sake gwadawa).",
    labelPeriod: "Lokaci",
    labelCadence: "Yawaita",
    cadenceDaily: "yau da kullum",
    cadenceWeekly: "mako-mako",
    labelExhausted: "Gwaje-gwajen sun ƙare",
    labelSkipped: "An tsallake har abada",
    labelTotal: "Jimillar layukan da suka makale",
    footer: "An aika wannan taƙaitawa bisa jadawali ta KHARAGOLF. Don canza yawaitawa ko masu karɓa, buɗe dashboard kuma gyara panel ɗin \"Rasit ɗin side-game da suka makale\".",
  },

  zu: {
    headerLabel: "Amarisidi we-side-game abambekile",
    subjectEmptyDaily: "Amarisidi we-side-game abambekile esikalansuku — awekho ku-{orgName}",
    subjectEmptyWeekly: "Amarisidi we-side-game abambekile esikaleviki — awekho ku-{orgName}",
    subjectNonEmptyDaily: "Amarisidi we-side-game abambekile esikalansuku — {count} adinga ukulandelelwa ({orgName})",
    subjectNonEmptyWeekly: "Amarisidi we-side-game abambekile esikaleviki — {count} adinga ukulandelelwa ({orgName})",
    headingDaily: "Isifinyezo sansuku samarisidi abambekile",
    headingWeekly: "Isifinyezo seviki samarisidi abambekile",
    introEmpty: "Izindaba ezinhle — awekho amarisidi we-side-game ku-{orgName} abambeke kulesi sikhathi. I-CSV ayinalutho kodwa inanyathiselwe ukuze kuqhubeke ukuhambisana.",
    introNonEmptyDaily: "Ngezansi yisifinyezo sansuku samarisidi okuxazululwa kwe-side-game ku-{orgName} okukhongiswa kwawo nge-imeyili noma nge-push okungaqedwanga. Vula i-CSV enanyathiselwe ukulandelela abadlali abathintwa (noma usebenzise isenzo se-\"Buyisela ukulethwa kulayini\" kudeshibhodi ukuze uzame futhi).",
    introNonEmptyWeekly: "Ngezansi yisifinyezo seviki samarisidi okuxazululwa kwe-side-game ku-{orgName} okukhongiswa kwawo nge-imeyili noma nge-push okungaqedwanga. Vula i-CSV enanyathiselwe ukulandelela abadlali abathintwa (noma usebenzise isenzo se-\"Buyisela ukulethwa kulayini\" kudeshibhodi ukuze uzame futhi).",
    labelPeriod: "Isikhathi",
    labelCadence: "Ukuvama",
    cadenceDaily: "nsuku zonke",
    cadenceWeekly: "iviki",
    labelExhausted: "Ukuzama futhi kuphelile",
    labelSkipped: "Kweqiwa unomphela",
    labelTotal: "Isamba semigqa ebambekile",
    footer: "Lesi sifinyezo sithunyelwa ngohlelo lwe-KHARAGOLF. Ukuze ushintshe ukuvama noma abamukeli, vula ideshibhodi bese uhlela ipaneli ethi \"Amarisidi we-side-game abambekile\".",
  },

  yo: {
    headerLabel: "Àwọn ìwé ìjẹ́rìí ti ìṣeré-ẹ̀gbẹ́ tó dí",
    subjectEmptyDaily: "Ìwé ìjẹ́rìí ti ìṣeré-ẹ̀gbẹ́ tó dí ojoojúmọ́ — kò sí fún {orgName}",
    subjectEmptyWeekly: "Ìwé ìjẹ́rìí ti ìṣeré-ẹ̀gbẹ́ tó dí ọ̀sọ̀ọ̀sẹ̀ — kò sí fún {orgName}",
    subjectNonEmptyDaily: "Ìwé ìjẹ́rìí ti ìṣeré-ẹ̀gbẹ́ tó dí ojoojúmọ́ — {count} nílò àtẹ̀lé ({orgName})",
    subjectNonEmptyWeekly: "Ìwé ìjẹ́rìí ti ìṣeré-ẹ̀gbẹ́ tó dí ọ̀sọ̀ọ̀sẹ̀ — {count} nílò àtẹ̀lé ({orgName})",
    headingDaily: "Àkójọpọ̀ ojoojúmọ́ ti ìwé ìjẹ́rìí tó dí",
    headingWeekly: "Àkójọpọ̀ ọ̀sọ̀ọ̀sẹ̀ ti ìwé ìjẹ́rìí tó dí",
    introEmpty: "Ìròyìn rere — kò sí ìwé ìjẹ́rìí ìṣeré-ẹ̀gbẹ́ kankan ní {orgName} tó dí ní àkókò yìí. CSV náà ṣofo ṣùgbọ́n a so mọ́ ọn fún ìtẹ̀síwájú ìfọwọ́sowọ́pọ̀.",
    introNonEmptyDaily: "Ní ìsàlẹ̀ ni àkójọpọ̀ ojoojúmọ́ ti àwọn ìwé ìjẹ́rìí ìpinnu ìṣeré-ẹ̀gbẹ́ ní {orgName} tí fífiránṣẹ́ ímeèlì tàbí push wọn kò pé. Ṣí CSV tí a so mọ́ ọn láti tẹ̀lé àwọn akọrin tí ó ní ipa (tàbí lo ìgbésẹ̀ \"Tún fífiránṣẹ́ sí ipò\" lórí dáṣíbọ́ọ̀dù láti gbìyànjú lẹẹkansi).",
    introNonEmptyWeekly: "Ní ìsàlẹ̀ ni àkójọpọ̀ ọ̀sọ̀ọ̀sẹ̀ ti àwọn ìwé ìjẹ́rìí ìpinnu ìṣeré-ẹ̀gbẹ́ ní {orgName} tí fífiránṣẹ́ ímeèlì tàbí push wọn kò pé. Ṣí CSV tí a so mọ́ ọn láti tẹ̀lé àwọn akọrin tí ó ní ipa (tàbí lo ìgbésẹ̀ \"Tún fífiránṣẹ́ sí ipò\" lórí dáṣíbọ́ọ̀dù láti gbìyànjú lẹẹkansi).",
    labelPeriod: "Àkókò",
    labelCadence: "Ìgbà",
    cadenceDaily: "ojoojúmọ́",
    cadenceWeekly: "ọ̀sọ̀ọ̀sẹ̀",
    labelExhausted: "Àwọn ìgbìyànjú ti tán",
    labelSkipped: "A fò pa títí láé",
    labelTotal: "Àpapọ̀ àwọn ila tó dí",
    footer: "A fi àkójọpọ̀ yìí ránṣẹ́ ní àdàákadà nípasẹ̀ KHARAGOLF. Láti yí ìgbà tàbí àwọn olùgbàwọlé padà, ṣí dáṣíbọ́ọ̀dù àti ṣe àtúnṣe pánẹ́lì \"Àwọn ìwé ìjẹ́rìí ti ìṣeré-ẹ̀gbẹ́ tó dí\".",
  },
};

export interface SideGameReceiptDigestTranslation {
  /**
   * Subject line, with raw `{orgName}` and `{count}` already substituted.
   * Used as a plain-text subject header — never HTML-escaped.
   */
  subject: string;
  /** Header strip label rendered above the body card. */
  headerLabel: string;
  /** H2 heading inside the card (frequency-aware). */
  heading: string;
  /**
   * Intro paragraph template with the `{orgName}` placeholder left
   * intact. The caller is expected to HTML-escape the surrounding text
   * and substitute `{orgName}` with an HTML-escaped + `<strong>`-wrapped
   * name (mirrors the original Task #1290 highlight).
   */
  introTemplate: string;
  labelPeriod: string;
  labelCadence: string;
  /** Localised cadence value (e.g. "Daily" / "Weekly" → "दैनिक" / "साप्ताहिक"). */
  cadenceLabel: string;
  labelExhausted: string;
  labelSkipped: string;
  labelTotal: string;
  /** Footer paragraph (plain text, no `{orgName}` placeholder). */
  footer: string;
  /** BCP-47 locale used for `Date#toLocaleDateString`. */
  dateLocale: string;
}

/** Resolve the language pack, falling back to English. */
export function resolveSideGameReceiptDigestLang(
  lang: string | null | undefined,
): SideGameReceiptDigestLang {
  return isSupportedSideGameReceiptDigestLang(lang) ? lang : "en";
}

/**
 * Translate the stuck-receipt digest into the recipient's language.
 *
 * Returns the resolved subject (with raw `orgName` / `count` already
 * substituted) and the body label/heading/footer strings, plus an
 * `introTemplate` that still contains the `{orgName}` placeholder so the
 * mailer can HTML-escape the paragraph and re-wrap the org name in its
 * highlight `<strong>` exactly like the original English copy.
 */
export function translateSideGameReceiptDigest(
  lang: string | null | undefined,
  vars: { orgName: string; frequency: "daily" | "weekly"; rowCount: number },
): SideGameReceiptDigestTranslation {
  const code = resolveSideGameReceiptDigestLang(lang);
  const pack = PACKS[code];
  const isDaily = vars.frequency === "daily";
  const isEmpty = vars.rowCount === 0;
  const subjectTpl = isEmpty
    ? (isDaily ? pack.subjectEmptyDaily : pack.subjectEmptyWeekly)
    : (isDaily ? pack.subjectNonEmptyDaily : pack.subjectNonEmptyWeekly);
  const introTemplate = isEmpty
    ? pack.introEmpty
    : (isDaily ? pack.introNonEmptyDaily : pack.introNonEmptyWeekly);
  return {
    subject: fmt(subjectTpl, { orgName: vars.orgName, count: vars.rowCount }),
    headerLabel: pack.headerLabel,
    heading: isDaily ? pack.headingDaily : pack.headingWeekly,
    introTemplate,
    labelPeriod: pack.labelPeriod,
    labelCadence: pack.labelCadence,
    cadenceLabel: isDaily ? pack.cadenceDaily : pack.cadenceWeekly,
    labelExhausted: pack.labelExhausted,
    labelSkipped: pack.labelSkipped,
    labelTotal: pack.labelTotal,
    footer: pack.footer,
    dateLocale: LOCALE_BY_LANG[code],
  };
}
