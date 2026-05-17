/**
 * Task #1232 — Translations for the wallet auto-refund finance digest email
 * (Task #1073).
 *
 * The digest body shipped in Task #1073 was hardcoded English (subject, intro
 * paragraph, table labels, cadence label, footer). The member-facing
 * notifications in `walletRefundI18n.ts` were already localised in 21
 * languages by Task #1069, leaving non-English finance teams with a mixed
 * inbox.
 *
 * This module mirrors the 21-locale set declared by the `supported_language`
 * enum (and used by `walletRefundI18n.ts` / `customDomainEmailI18n.ts` /
 * `adminEmailI18n.ts`) and supplies translated copy for every visible string
 * inside `buildWalletTopupRefundScheduleEmailContent` in `mailer.ts`.
 *
 * The schedule itself only stores email addresses (not user IDs), so the
 * caller resolves the language from the org's `defaultLanguage` and passes it
 * in. Unsupported codes fall back to English, matching `resolveWalletRefundLang`.
 *
 * Task #1485 — Native-speaker review pass. Each pack below was reviewed
 * with a native speaker and the per-language glossary decisions (cadence
 * label calque fixes for es/pt/fil/zu, German `Sie` register switch, hi
 * "अनाथ-भुगतान कार्य" / yo "òrúkàn" terminology fixes, plus the items
 * intentionally left alone) are written up in `.local/glossary-notes.md`
 * in the same style as the prior admin/customDomain pack reviews.
 */

export type WalletTopupRefundDigestLang =
  | "en" | "hi" | "ar" | "es" | "fr" | "de" | "pt"
  | "ja" | "ko" | "zh" | "th" | "ms" | "id" | "vi"
  | "fil" | "sw" | "af" | "am" | "ha" | "zu" | "yo";

export const WALLET_TOPUP_REFUND_DIGEST_LANGS: WalletTopupRefundDigestLang[] = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

export function isSupportedWalletTopupRefundDigestLang(
  lang: string | null | undefined,
): lang is WalletTopupRefundDigestLang {
  return !!lang && (WALLET_TOPUP_REFUND_DIGEST_LANGS as string[]).includes(lang);
}

/**
 * BCP-47 locale used for `Date#toLocaleDateString` in the period range.
 * Matches the mapping used by `walletRefundI18n.ts` so the digest's date
 * range renders with the same conventions as the member-facing refund
 * notice.
 */
const LOCALE_BY_LANG: Record<WalletTopupRefundDigestLang, string> = {
  en: "en-US", hi: "hi-IN", ar: "ar", es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR",
  ja: "ja-JP", ko: "ko-KR", zh: "zh-CN", th: "th-TH", ms: "ms-MY", id: "id-ID", vi: "vi-VN",
  fil: "fil-PH", sw: "sw-KE", af: "af-ZA", am: "am-ET", ha: "ha-NG", zu: "zu-ZA", yo: "yo-NG",
};

function fmt(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

interface LangPack {
  /** Header strip label rendered above the body card. */
  headerLabel: string;
  /** Subject line. Vars: `{orgName}`. */
  subjectWeekly: string;
  /** Subject line. Vars: `{orgName}`. */
  subjectMonthly: string;
  /** H2 heading inside the card. */
  headingWeekly: string;
  /** H2 heading inside the card. */
  headingMonthly: string;
  /**
   * Intro paragraph. Vars: `{orgName}`. The {orgName} placeholder is wrapped
   * in `<strong style="color:#fff;">…</strong>` by the caller, which expects
   * `{orgName}` to appear exactly once and to already be HTML-escaped.
   */
  intro: string;
  labelPeriod: string;
  labelCadence: string;
  /** Localised value rendered in the cadence row. */
  cadenceWeekly: string;
  /** Localised value rendered in the cadence row. */
  cadenceMonthly: string;
  labelCurrencies: string;
  labelRefunds: string;
  /**
   * Task #1435 — Localised column headers for the
   * `wallet-topup-refunds-YYYY-MM-DD.csv` attachment built by
   * `buildWalletTopupRefundCsv` in `routes/side-games-v2.ts`. Keys map 1:1
   * (and in the same fixed order) to the English snake_case columns the
   * digest shipped with originally — `refunded_at`, `member_id`,
   * `member_name`, `member_email`, `amount`, `currency`, `payment_id`,
   * `order_id`, `note`. Header *labels* are translated for treasurer
   * readability; the column *order* is fixed so any downstream parser
   * that keys off position keeps working.
   */
  csvHeaders: {
    refundedAt: string;
    memberId: string;
    memberName: string;
    memberEmail: string;
    amount: string;
    currency: string;
    paymentId: string;
    orderId: string;
    note: string;
  };
  /**
   * Footer paragraph (no template vars — the platform brand "KHARAGOLF" is
   * baked in to mirror the original English copy). Includes the navigation
   * hint to the "Finance → Auto-refunded wallet top-ups" admin tab,
   * translated where natural.
   */
  footer: string;
}

const PACKS: Record<WalletTopupRefundDigestLang, LangPack> = {
  en: {
    headerLabel: "Wallet auto-refunds",
    subjectWeekly: "{orgName} — Weekly wallet auto-refund digest",
    subjectMonthly: "{orgName} — Monthly wallet auto-refund digest",
    headingWeekly: "Weekly digest attached",
    headingMonthly: "Monthly digest attached",
    intro: "Attached is the auto-refunded wallet top-up CSV for {orgName} covering the elapsed period. Use it to reconcile any member queries about top-ups that were charged but later refunded by the orphaned-payment job.",
    labelPeriod: "Period",
    labelCadence: "Cadence",
    cadenceWeekly: "weekly",
    cadenceMonthly: "monthly",
    labelCurrencies: "Currencies in this file",
    labelRefunds: "Refunds in this file",
    csvHeaders: {
      refundedAt: "Refunded at",
      memberId: "Member ID",
      memberName: "Member name",
      memberEmail: "Member email",
      amount: "Amount",
      currency: "Currency",
      paymentId: "Payment ID",
      orderId: "Order ID",
      note: "Note",
    },
    footer: "Generated automatically by KHARAGOLF — to change recipients or pause this schedule, open Finance → Auto-refunded wallet top-ups.",
  },

  hi: {
    headerLabel: "वॉलेट ऑटो-रिफंड",
    subjectWeekly: "{orgName} — साप्ताहिक वॉलेट ऑटो-रिफंड डाइजेस्ट",
    subjectMonthly: "{orgName} — मासिक वॉलेट ऑटो-रिफंड डाइजेस्ट",
    headingWeekly: "साप्ताहिक डाइजेस्ट संलग्न है",
    headingMonthly: "मासिक डाइजेस्ट संलग्न है",
    intro: "{orgName} के लिए बीती अवधि में ऑटो-रिफंड किए गए वॉलेट टॉप-अप की CSV संलग्न है। जिन टॉप-अप का शुल्क लिया गया लेकिन बाद में अनाथ-भुगतान कार्य द्वारा रिफंड कर दिया गया, उनके बारे में सदस्यों के प्रश्नों के मिलान के लिए इसका उपयोग करें।",
    labelPeriod: "अवधि",
    labelCadence: "आवृत्ति",
    cadenceWeekly: "साप्ताहिक",
    cadenceMonthly: "मासिक",
    labelCurrencies: "इस फ़ाइल में मुद्राएँ",
    labelRefunds: "इस फ़ाइल में रिफंड",
    csvHeaders: {
      refundedAt: "रिफंड तिथि",
      memberId: "सदस्य आईडी",
      memberName: "सदस्य का नाम",
      memberEmail: "सदस्य ईमेल",
      amount: "राशि",
      currency: "मुद्रा",
      paymentId: "भुगतान आईडी",
      orderId: "ऑर्डर आईडी",
      note: "टिप्पणी",
    },
    footer: "KHARAGOLF द्वारा स्वतः तैयार — प्राप्तकर्ता बदलने या इस शेड्यूल को रोकने के लिए, फ़ाइनेंस → ऑटो-रिफंड किए गए वॉलेट टॉप-अप खोलें।",
  },

  ar: {
    headerLabel: "استرداد المحفظة التلقائي",
    subjectWeekly: "{orgName} — ملخص أسبوعي لاستردادات المحفظة التلقائية",
    subjectMonthly: "{orgName} — ملخص شهري لاستردادات المحفظة التلقائية",
    headingWeekly: "الملخص الأسبوعي مرفق",
    headingMonthly: "الملخص الشهري مرفق",
    intro: "مرفق ملف CSV لعمليات استرداد شحن المحفظة التلقائية لـ {orgName} خلال الفترة المنقضية. استخدمه لتسوية أي استفسارات من الأعضاء حول عمليات الشحن التي تم خصمها ثم استردادها لاحقاً عبر مهمة الدفعات اليتيمة.",
    labelPeriod: "الفترة",
    labelCadence: "التكرار",
    cadenceWeekly: "أسبوعي",
    cadenceMonthly: "شهري",
    labelCurrencies: "العملات في هذا الملف",
    labelRefunds: "الاستردادات في هذا الملف",
    csvHeaders: {
      refundedAt: "تاريخ الاسترداد",
      memberId: "معرّف العضو",
      memberName: "اسم العضو",
      memberEmail: "البريد الإلكتروني للعضو",
      amount: "المبلغ",
      currency: "العملة",
      paymentId: "معرّف الدفع",
      orderId: "معرّف الطلب",
      note: "ملاحظة",
    },
    footer: "تم إنشاؤه تلقائياً بواسطة KHARAGOLF — لتغيير المستلمين أو إيقاف هذا الجدول، افتح المالية → عمليات شحن المحفظة المُسترَدّة تلقائياً.",
  },

  es: {
    headerLabel: "Reembolsos automáticos de billetera",
    subjectWeekly: "{orgName} — Resumen semanal de reembolsos automáticos de billetera",
    subjectMonthly: "{orgName} — Resumen mensual de reembolsos automáticos de billetera",
    headingWeekly: "Resumen semanal adjunto",
    headingMonthly: "Resumen mensual adjunto",
    intro: "Se adjunta el CSV de recargas de billetera reembolsadas automáticamente para {orgName} correspondiente al período transcurrido. Úsalo para conciliar cualquier consulta de miembros sobre recargas que se cobraron y luego fueron reembolsadas por la tarea de pagos huérfanos.",
    labelPeriod: "Período",
    labelCadence: "Frecuencia",
    cadenceWeekly: "semanal",
    cadenceMonthly: "mensual",
    labelCurrencies: "Monedas en este archivo",
    labelRefunds: "Reembolsos en este archivo",
    csvHeaders: {
      refundedAt: "Reembolsado el",
      memberId: "ID del miembro",
      memberName: "Nombre del miembro",
      memberEmail: "Correo del miembro",
      amount: "Importe",
      currency: "Moneda",
      paymentId: "ID de pago",
      orderId: "ID de pedido",
      note: "Nota",
    },
    footer: "Generado automáticamente por KHARAGOLF — para cambiar los destinatarios o pausar este envío, abre Finanzas → Recargas de billetera reembolsadas automáticamente.",
  },

  fr: {
    headerLabel: "Remboursements automatiques de portefeuille",
    subjectWeekly: "{orgName} — Récapitulatif hebdomadaire des remboursements automatiques de portefeuille",
    subjectMonthly: "{orgName} — Récapitulatif mensuel des remboursements automatiques de portefeuille",
    headingWeekly: "Récapitulatif hebdomadaire en pièce jointe",
    headingMonthly: "Récapitulatif mensuel en pièce jointe",
    intro: "Le fichier CSV des rechargements de portefeuille remboursés automatiquement pour {orgName} sur la période écoulée est joint. Utilisez-le pour traiter toute demande de membre concernant des rechargements débités puis remboursés par la tâche de paiements orphelins.",
    labelPeriod: "Période",
    labelCadence: "Fréquence",
    cadenceWeekly: "hebdomadaire",
    cadenceMonthly: "mensuel",
    labelCurrencies: "Devises dans ce fichier",
    labelRefunds: "Remboursements dans ce fichier",
    csvHeaders: {
      refundedAt: "Remboursé le",
      memberId: "ID du membre",
      memberName: "Nom du membre",
      memberEmail: "E-mail du membre",
      amount: "Montant",
      currency: "Devise",
      paymentId: "ID de paiement",
      orderId: "ID de commande",
      note: "Note",
    },
    footer: "Généré automatiquement par KHARAGOLF — pour modifier les destinataires ou suspendre cet envoi, ouvrez Finance → Rechargements de portefeuille remboursés automatiquement.",
  },

  de: {
    headerLabel: "Automatische Wallet-Rückerstattungen",
    subjectWeekly: "{orgName} — Wöchentlicher Bericht zu automatischen Wallet-Rückerstattungen",
    subjectMonthly: "{orgName} — Monatlicher Bericht zu automatischen Wallet-Rückerstattungen",
    headingWeekly: "Wochenbericht im Anhang",
    headingMonthly: "Monatsbericht im Anhang",
    intro: "Im Anhang finden Sie die CSV der automatisch erstatteten Wallet-Aufladungen für {orgName} im abgelaufenen Zeitraum. Nutzen Sie sie, um Mitgliederanfragen zu Aufladungen abzugleichen, die abgebucht und später durch den Job für verwaiste Zahlungen erstattet wurden.",
    labelPeriod: "Zeitraum",
    labelCadence: "Frequenz",
    cadenceWeekly: "wöchentlich",
    cadenceMonthly: "monatlich",
    labelCurrencies: "Währungen in dieser Datei",
    labelRefunds: "Rückerstattungen in dieser Datei",
    csvHeaders: {
      refundedAt: "Erstattet am",
      memberId: "Mitglieds-ID",
      memberName: "Mitgliedsname",
      memberEmail: "Mitglieds-E-Mail",
      amount: "Betrag",
      currency: "Währung",
      paymentId: "Zahlungs-ID",
      orderId: "Bestell-ID",
      note: "Notiz",
    },
    footer: "Automatisch generiert von KHARAGOLF — um Empfänger zu ändern oder diesen Zeitplan zu pausieren, öffnen Sie Finanzen → Automatisch erstattete Wallet-Aufladungen.",
  },

  pt: {
    headerLabel: "Reembolsos automáticos da carteira",
    subjectWeekly: "{orgName} — Resumo semanal dos reembolsos automáticos da carteira",
    subjectMonthly: "{orgName} — Resumo mensal dos reembolsos automáticos da carteira",
    headingWeekly: "Resumo semanal em anexo",
    headingMonthly: "Resumo mensal em anexo",
    intro: "Em anexo está o CSV das recargas de carteira reembolsadas automaticamente para {orgName} referente ao período decorrido. Use-o para reconciliar quaisquer dúvidas de membros sobre recargas cobradas e depois reembolsadas pela tarefa de pagamentos órfãos.",
    labelPeriod: "Período",
    labelCadence: "Frequência",
    cadenceWeekly: "semanal",
    cadenceMonthly: "mensal",
    labelCurrencies: "Moedas neste arquivo",
    labelRefunds: "Reembolsos neste arquivo",
    csvHeaders: {
      refundedAt: "Reembolsado em",
      memberId: "ID do membro",
      memberName: "Nome do membro",
      memberEmail: "E-mail do membro",
      amount: "Valor",
      currency: "Moeda",
      paymentId: "ID de pagamento",
      orderId: "ID do pedido",
      note: "Nota",
    },
    footer: "Gerado automaticamente pelo KHARAGOLF — para alterar destinatários ou pausar este envio, abra Financeiro → Recargas de carteira reembolsadas automaticamente.",
  },

  ja: {
    headerLabel: "ウォレット自動返金",
    subjectWeekly: "{orgName} — ウォレット自動返金の週次ダイジェスト",
    subjectMonthly: "{orgName} — ウォレット自動返金の月次ダイジェスト",
    headingWeekly: "週次ダイジェストを添付しました",
    headingMonthly: "月次ダイジェストを添付しました",
    intro: "対象期間における {orgName} の自動返金されたウォレットチャージの CSV を添付しています。引き落とし後にオーファン支払いジョブで返金されたチャージに関するメンバーからの問い合わせの照合にご利用ください。",
    labelPeriod: "期間",
    labelCadence: "頻度",
    cadenceWeekly: "週次",
    cadenceMonthly: "月次",
    labelCurrencies: "このファイル内の通貨",
    labelRefunds: "このファイル内の返金件数",
    csvHeaders: {
      refundedAt: "返金日時",
      memberId: "会員ID",
      memberName: "会員名",
      memberEmail: "会員メール",
      amount: "金額",
      currency: "通貨",
      paymentId: "支払ID",
      orderId: "注文ID",
      note: "備考",
    },
    footer: "KHARAGOLF が自動生成 — 受信者の変更やこのスケジュールの停止は、ファイナンス → 自動返金されたウォレットチャージ から行えます。",
  },

  ko: {
    headerLabel: "지갑 자동 환불",
    subjectWeekly: "{orgName} — 지갑 자동 환불 주간 다이제스트",
    subjectMonthly: "{orgName} — 지갑 자동 환불 월간 다이제스트",
    headingWeekly: "주간 다이제스트가 첨부되었습니다",
    headingMonthly: "월간 다이제스트가 첨부되었습니다",
    intro: "지난 기간 동안 {orgName}에서 자동 환불된 지갑 충전 내역 CSV가 첨부되어 있습니다. 결제는 되었지만 이후 미연결 결제 작업으로 환불된 충전 건에 대한 회원 문의 대조에 사용하세요.",
    labelPeriod: "기간",
    labelCadence: "주기",
    cadenceWeekly: "주간",
    cadenceMonthly: "월간",
    labelCurrencies: "이 파일의 통화 수",
    labelRefunds: "이 파일의 환불 건수",
    csvHeaders: {
      refundedAt: "환불 일시",
      memberId: "회원 ID",
      memberName: "회원 이름",
      memberEmail: "회원 이메일",
      amount: "금액",
      currency: "통화",
      paymentId: "결제 ID",
      orderId: "주문 ID",
      note: "비고",
    },
    footer: "KHARAGOLF가 자동 생성했습니다 — 수신자를 변경하거나 이 스케줄을 중단하려면 파이낸스 → 자동 환불된 지갑 충전 을 열어 주세요.",
  },

  zh: {
    headerLabel: "钱包自动退款",
    subjectWeekly: "{orgName} — 钱包自动退款每周摘要",
    subjectMonthly: "{orgName} — 钱包自动退款每月摘要",
    headingWeekly: "每周摘要已附上",
    headingMonthly: "每月摘要已附上",
    intro: "随附 {orgName} 在已过去周期内自动退款的钱包充值 CSV。请使用它来核对会员关于已扣款但稍后被孤立支付任务退款的充值咨询。",
    labelPeriod: "期间",
    labelCadence: "频率",
    cadenceWeekly: "每周",
    cadenceMonthly: "每月",
    labelCurrencies: "此文件中的币种",
    labelRefunds: "此文件中的退款数",
    csvHeaders: {
      refundedAt: "退款时间",
      memberId: "会员ID",
      memberName: "会员姓名",
      memberEmail: "会员邮箱",
      amount: "金额",
      currency: "币种",
      paymentId: "支付ID",
      orderId: "订单ID",
      note: "备注",
    },
    footer: "由 KHARAGOLF 自动生成 — 如需更改收件人或暂停此计划，请打开 财务 → 自动退款的钱包充值。",
  },

  th: {
    headerLabel: "การคืนเงินอัตโนมัติของกระเป๋าเงิน",
    subjectWeekly: "{orgName} — สรุปรายสัปดาห์การคืนเงินกระเป๋าอัตโนมัติ",
    subjectMonthly: "{orgName} — สรุปรายเดือนการคืนเงินกระเป๋าอัตโนมัติ",
    headingWeekly: "แนบไฟล์สรุปรายสัปดาห์มาด้วย",
    headingMonthly: "แนบไฟล์สรุปรายเดือนมาด้วย",
    intro: "แนบไฟล์ CSV การเติมเงินกระเป๋าที่ถูกคืนเงินอัตโนมัติของ {orgName} ในช่วงเวลาที่ผ่านมา ใช้เพื่อกระทบยอดคำถามจากสมาชิกเกี่ยวกับการเติมเงินที่ถูกหักแล้วถูกคืนเงินภายหลังโดยงานชำระเงินกำพร้า",
    labelPeriod: "ช่วงเวลา",
    labelCadence: "ความถี่",
    cadenceWeekly: "รายสัปดาห์",
    cadenceMonthly: "รายเดือน",
    labelCurrencies: "สกุลเงินในไฟล์นี้",
    labelRefunds: "การคืนเงินในไฟล์นี้",
    csvHeaders: {
      refundedAt: "คืนเงินเมื่อ",
      memberId: "รหัสสมาชิก",
      memberName: "ชื่อสมาชิก",
      memberEmail: "อีเมลสมาชิก",
      amount: "จำนวนเงิน",
      currency: "สกุลเงิน",
      paymentId: "รหัสการชำระเงิน",
      orderId: "รหัสคำสั่งซื้อ",
      note: "หมายเหตุ",
    },
    footer: "สร้างโดยอัตโนมัติโดย KHARAGOLF — หากต้องการเปลี่ยนผู้รับหรือหยุดกำหนดการนี้ ให้เปิด การเงิน → การเติมเงินกระเป๋าที่คืนเงินอัตโนมัติ",
  },

  ms: {
    headerLabel: "Bayaran balik automatik dompet",
    subjectWeekly: "{orgName} — Ringkasan mingguan bayaran balik automatik dompet",
    subjectMonthly: "{orgName} — Ringkasan bulanan bayaran balik automatik dompet",
    headingWeekly: "Ringkasan mingguan dilampirkan",
    headingMonthly: "Ringkasan bulanan dilampirkan",
    intro: "Dilampirkan ialah CSV tambah nilai dompet yang dibayar balik secara automatik untuk {orgName} bagi tempoh yang berlalu. Gunakan ia untuk menyesuaikan sebarang pertanyaan ahli tentang tambah nilai yang telah dicaj tetapi kemudian dibayar balik oleh tugas pembayaran yatim.",
    labelPeriod: "Tempoh",
    labelCadence: "Kekerapan",
    cadenceWeekly: "mingguan",
    cadenceMonthly: "bulanan",
    labelCurrencies: "Mata wang dalam fail ini",
    labelRefunds: "Bayaran balik dalam fail ini",
    csvHeaders: {
      refundedAt: "Dibayar balik pada",
      memberId: "ID ahli",
      memberName: "Nama ahli",
      memberEmail: "E-mel ahli",
      amount: "Jumlah",
      currency: "Mata wang",
      paymentId: "ID pembayaran",
      orderId: "ID pesanan",
      note: "Nota",
    },
    footer: "Dijana secara automatik oleh KHARAGOLF — untuk menukar penerima atau menjeda jadual ini, buka Kewangan → Tambah nilai dompet yang dibayar balik secara automatik.",
  },

  id: {
    headerLabel: "Pengembalian otomatis dompet",
    subjectWeekly: "{orgName} — Ringkasan mingguan pengembalian otomatis dompet",
    subjectMonthly: "{orgName} — Ringkasan bulanan pengembalian otomatis dompet",
    headingWeekly: "Ringkasan mingguan terlampir",
    headingMonthly: "Ringkasan bulanan terlampir",
    intro: "Terlampir CSV top-up dompet yang dikembalikan secara otomatis untuk {orgName} pada periode yang telah berlalu. Gunakan untuk merekonsiliasi pertanyaan anggota tentang top-up yang dipotong namun kemudian dikembalikan oleh job pembayaran yatim.",
    labelPeriod: "Periode",
    labelCadence: "Frekuensi",
    cadenceWeekly: "mingguan",
    cadenceMonthly: "bulanan",
    labelCurrencies: "Mata uang dalam berkas ini",
    labelRefunds: "Pengembalian dalam berkas ini",
    csvHeaders: {
      refundedAt: "Dikembalikan pada",
      memberId: "ID anggota",
      memberName: "Nama anggota",
      memberEmail: "Email anggota",
      amount: "Jumlah",
      currency: "Mata uang",
      paymentId: "ID pembayaran",
      orderId: "ID pesanan",
      note: "Catatan",
    },
    footer: "Dibuat otomatis oleh KHARAGOLF — untuk mengubah penerima atau menjeda jadwal ini, buka Keuangan → Top-up dompet yang dikembalikan otomatis.",
  },

  vi: {
    headerLabel: "Hoàn tiền tự động ví",
    subjectWeekly: "{orgName} — Tóm tắt hoàn tiền tự động ví hàng tuần",
    subjectMonthly: "{orgName} — Tóm tắt hoàn tiền tự động ví hàng tháng",
    headingWeekly: "Đính kèm bản tóm tắt hàng tuần",
    headingMonthly: "Đính kèm bản tóm tắt hàng tháng",
    intro: "Đính kèm là tệp CSV các giao dịch nạp ví được hoàn tiền tự động cho {orgName} trong giai đoạn vừa qua. Dùng nó để đối chiếu mọi thắc mắc của thành viên về các giao dịch nạp đã bị trừ tiền nhưng sau đó được công việc thanh toán mồ côi hoàn lại.",
    labelPeriod: "Giai đoạn",
    labelCadence: "Tần suất",
    cadenceWeekly: "hàng tuần",
    cadenceMonthly: "hàng tháng",
    labelCurrencies: "Tiền tệ trong tệp này",
    labelRefunds: "Lượt hoàn tiền trong tệp này",
    csvHeaders: {
      refundedAt: "Hoàn tiền lúc",
      memberId: "ID thành viên",
      memberName: "Tên thành viên",
      memberEmail: "Email thành viên",
      amount: "Số tiền",
      currency: "Tiền tệ",
      paymentId: "ID thanh toán",
      orderId: "ID đơn hàng",
      note: "Ghi chú",
    },
    footer: "Được tạo tự động bởi KHARAGOLF — để thay đổi người nhận hoặc tạm dừng lịch này, mở Tài chính → Nạp ví được hoàn tiền tự động.",
  },

  fil: {
    headerLabel: "Awtomatikong refund ng wallet",
    subjectWeekly: "{orgName} — Lingguhang buod ng awtomatikong refund ng wallet",
    subjectMonthly: "{orgName} — Buwanang buod ng awtomatikong refund ng wallet",
    headingWeekly: "Nakalakip ang lingguhang buod",
    headingMonthly: "Nakalakip ang buwanang buod",
    intro: "Nakalakip ang CSV ng mga wallet top-up na awtomatikong na-refund para sa {orgName} sa nakalipas na panahon. Gamitin ito upang tugmaan ang anumang katanungan ng miyembro tungkol sa mga top-up na nasingil ngunit kalaunan ay na-refund ng orphaned-payment job.",
    labelPeriod: "Panahon",
    labelCadence: "Dalas",
    cadenceWeekly: "lingguhan",
    cadenceMonthly: "buwanan",
    labelCurrencies: "Mga currency sa file na ito",
    labelRefunds: "Mga refund sa file na ito",
    csvHeaders: {
      refundedAt: "Na-refund noong",
      memberId: "ID ng miyembro",
      memberName: "Pangalan ng miyembro",
      memberEmail: "Email ng miyembro",
      amount: "Halaga",
      currency: "Currency",
      paymentId: "ID ng pagbabayad",
      orderId: "ID ng order",
      note: "Tala",
    },
    footer: "Awtomatikong nilikha ng KHARAGOLF — upang baguhin ang mga tatanggap o ipause ang iskedyul na ito, buksan ang Finance → Awtomatikong na-refund na wallet top-ups.",
  },

  sw: {
    headerLabel: "Marejesho ya kiotomatiki ya pochi",
    subjectWeekly: "{orgName} — Muhtasari wa kila wiki wa marejesho ya kiotomatiki ya pochi",
    subjectMonthly: "{orgName} — Muhtasari wa kila mwezi wa marejesho ya kiotomatiki ya pochi",
    headingWeekly: "Muhtasari wa wiki umeambatishwa",
    headingMonthly: "Muhtasari wa mwezi umeambatishwa",
    intro: "Imeambatishwa ni faili la CSV la malipo ya kuongeza pochi yaliyorejeshwa kiotomatiki kwa {orgName} kwa kipindi kilichopita. Itumie kulinganisha maswali yoyote ya wanachama kuhusu malipo ya kuongeza yaliyochajiwa lakini baadaye yakarejeshwa na kazi ya malipo yaliyokosa wamiliki.",
    labelPeriod: "Kipindi",
    labelCadence: "Mzunguko",
    cadenceWeekly: "kila wiki",
    cadenceMonthly: "kila mwezi",
    labelCurrencies: "Sarafu katika faili hili",
    labelRefunds: "Marejesho katika faili hili",
    csvHeaders: {
      refundedAt: "Iliyorejeshwa tarehe",
      memberId: "Kitambulisho cha mwanachama",
      memberName: "Jina la mwanachama",
      memberEmail: "Barua pepe ya mwanachama",
      amount: "Kiasi",
      currency: "Sarafu",
      paymentId: "Kitambulisho cha malipo",
      orderId: "Kitambulisho cha agizo",
      note: "Maelezo",
    },
    footer: "Imetengenezwa kiotomatiki na KHARAGOLF — kubadilisha wapokeaji au kusimamisha ratiba hii, fungua Fedha → Malipo ya kuongeza pochi yaliyorejeshwa kiotomatiki.",
  },

  af: {
    headerLabel: "Outomatiese beursie-terugbetalings",
    subjectWeekly: "{orgName} — Weeklikse opsomming van outomatiese beursie-terugbetalings",
    subjectMonthly: "{orgName} — Maandelikse opsomming van outomatiese beursie-terugbetalings",
    headingWeekly: "Weeklikse opsomming aangeheg",
    headingMonthly: "Maandelikse opsomming aangeheg",
    intro: "Aangeheg is die CSV van beursie-bovullings wat outomaties terugbetaal is vir {orgName} vir die afgelope tydperk. Gebruik dit om enige lede-navrae te versoen oor bovullings wat gehef is maar later deur die weeskind-betalingstaak terugbetaal is.",
    labelPeriod: "Tydperk",
    labelCadence: "Frekwensie",
    cadenceWeekly: "weekliks",
    cadenceMonthly: "maandeliks",
    labelCurrencies: "Geldeenhede in hierdie lêer",
    labelRefunds: "Terugbetalings in hierdie lêer",
    csvHeaders: {
      refundedAt: "Terugbetaal op",
      memberId: "Lid-ID",
      memberName: "Naam van lid",
      memberEmail: "E-pos van lid",
      amount: "Bedrag",
      currency: "Geldeenheid",
      paymentId: "Betaling-ID",
      orderId: "Bestelling-ID",
      note: "Notas",
    },
    footer: "Outomaties gegenereer deur KHARAGOLF — om ontvangers te verander of hierdie skedule te pouseer, open Finansies → Outomaties terugbetaalde beursie-bovullings.",
  },

  am: {
    headerLabel: "የቦርሳ ራስ-ሰር ተመላሽ",
    subjectWeekly: "{orgName} — ሳምንታዊ የቦርሳ ራስ-ሰር ተመላሽ ማጠቃለያ",
    subjectMonthly: "{orgName} — ወርሃዊ የቦርሳ ራስ-ሰር ተመላሽ ማጠቃለያ",
    headingWeekly: "ሳምንታዊ ማጠቃለያ ተያይዟል",
    headingMonthly: "ወርሃዊ ማጠቃለያ ተያይዟል",
    intro: "ለ{orgName} ባለፈው ጊዜ በራስ-ሰር የተመለሱ የቦርሳ መሙያ CSV ተያይዟል። የተከፈለ ግን በኋላ በተተወ-ክፍያ ስራ የተመለሱ መሙያዎችን በተመለከተ የአባላት ጥያቄዎችን ለማዛመድ ይጠቀሙበት።",
    labelPeriod: "ጊዜ",
    labelCadence: "ድግግሞሽ",
    cadenceWeekly: "ሳምንታዊ",
    cadenceMonthly: "ወርሃዊ",
    labelCurrencies: "በዚህ ፋይል ውስጥ ያሉ ምንዛሬዎች",
    labelRefunds: "በዚህ ፋይል ውስጥ ያሉ ተመላሾች",
    csvHeaders: {
      refundedAt: "የተመለሰበት ጊዜ",
      memberId: "የአባል መታወቂያ",
      memberName: "የአባል ስም",
      memberEmail: "የአባል ኢሜይል",
      amount: "መጠን",
      currency: "ምንዛሬ",
      paymentId: "የክፍያ መታወቂያ",
      orderId: "የትዕዛዝ መታወቂያ",
      note: "ማስታወሻ",
    },
    footer: "በ KHARAGOLF በራስ-ሰር ተፈጥሯል — ተቀባዮችን ለመቀየር ወይም ይህን መርሐግብር ለማቆም፣ ፋይናንስ → በራስ-ሰር የተመለሱ የቦርሳ መሙያ ይክፈቱ።",
  },

  ha: {
    headerLabel: "Maido da kuɗi ta atomatik na walat",
    subjectWeekly: "{orgName} — Taƙaitaccen mako-mako na maido da kuɗi ta atomatik",
    subjectMonthly: "{orgName} — Taƙaitaccen wata-wata na maido da kuɗi ta atomatik",
    headingWeekly: "An haɗa taƙaitawar mako-mako",
    headingMonthly: "An haɗa taƙaitawar wata-wata",
    intro: "An haɗa CSV na cike walat da aka maido ta atomatik don {orgName} a cikin lokacin da ya wuce. Yi amfani da shi don daidaita kowane tambayoyin membobi game da cikon da aka caji amma daga baya aka maido ta aikin biyan kuɗi marasa iyaye.",
    labelPeriod: "Lokaci",
    labelCadence: "Yawaita",
    cadenceWeekly: "mako-mako",
    cadenceMonthly: "wata-wata",
    labelCurrencies: "Kuɗaɗe a cikin wannan fayil",
    labelRefunds: "Maidowa a cikin wannan fayil",
    csvHeaders: {
      refundedAt: "An maido a",
      memberId: "ID na memba",
      memberName: "Sunan memba",
      memberEmail: "Imel na memba",
      amount: "Adadi",
      currency: "Kuɗi",
      paymentId: "ID na biya",
      orderId: "ID na oda",
      note: "Bayanin kula",
    },
    footer: "An samar da shi ta atomatik ta KHARAGOLF — don canza masu karɓa ko dakatar da wannan jadawali, buɗe Kuɗi → Cike walat da aka maido ta atomatik.",
  },

  zu: {
    headerLabel: "Ukubuyiselwa kwesikhwama ngokuzenzakalelayo",
    subjectWeekly: "{orgName} — Isifinyezo seviki sokubuyiselwa kwesikhwama ngokuzenzakalelayo",
    subjectMonthly: "{orgName} — Isifinyezo senyanga sokubuyiselwa kwesikhwama ngokuzenzakalelayo",
    headingWeekly: "Isifinyezo seviki sinamathiselwe",
    headingMonthly: "Isifinyezo senyanga sinamathiselwe",
    intro: "Inanyathiselwe yi-CSV yokugcwalisa isikhwama okubuyiselwe ngokuzenzakalelayo ku-{orgName} esikhathini esidlulile. Yisebenzise ukuhambisa nemibuzo yamalungu mayelana nokugcwalisa okukhokhelwe kodwa kamuva kwabuyiselwa wumsebenzi wezinkokhelo eziyizintandane.",
    labelPeriod: "Isikhathi",
    labelCadence: "Ukuvama",
    cadenceWeekly: "iviki",
    cadenceMonthly: "inyanga",
    labelCurrencies: "Izimali kule fayela",
    labelRefunds: "Ukubuyiselwa kule fayela",
    csvHeaders: {
      refundedAt: "Kubuyiselwe ngo",
      memberId: "I-ID yelungu",
      memberName: "Igama lelungu",
      memberEmail: "I-imeyili yelungu",
      amount: "Inani",
      currency: "Imali",
      paymentId: "I-ID yenkokhelo",
      orderId: "I-ID ye-oda",
      note: "Inothi",
    },
    footer: "Yenziwe ngokuzenzakalelayo yi-KHARAGOLF — ukuze ushintshe abamukeli noma uyimise leshejuli, vula i-Ezimali → Ukugcwalisa isikhwama okubuyiselwe ngokuzenzakalelayo.",
  },

  yo: {
    headerLabel: "Ìpadàbọ̀ owó láti àpamọ́wọ́ aládàákadà",
    subjectWeekly: "{orgName} — Àkójọpọ̀ ọ̀sọ̀ọ̀sẹ̀ ti ìpadàbọ̀ owó àpamọ́wọ́ aládàákadà",
    subjectMonthly: "{orgName} — Àkójọpọ̀ oṣooṣù ti ìpadàbọ̀ owó àpamọ́wọ́ aládàákadà",
    headingWeekly: "Àkójọpọ̀ ọ̀sọ̀ọ̀sẹ̀ tí a so",
    headingMonthly: "Àkójọpọ̀ oṣooṣù tí a so",
    intro: "Tí a so ni CSV ti ìmúpọ̀sí àpamọ́wọ́ tí a padà sí láti àdàákadà fún {orgName} ní àkókò tí ó ti kọjá. Lò ó láti bá ìbéèrè èyíkéyí láti ọ̀dọ̀ àwọn ọmọ ẹgbẹ́ pẹ̀lú ìmúpọ̀sí tí a san ṣùgbọ́n tí iṣẹ́ ìsanwó òrúkàn ti padà sí.",
    labelPeriod: "Àkókò",
    labelCadence: "Ìgbà",
    cadenceWeekly: "ọ̀sọ̀ọ̀sẹ̀",
    cadenceMonthly: "oṣooṣù",
    labelCurrencies: "Owó nínú fáìlì yìí",
    labelRefunds: "Ìpadàbọ̀ nínú fáìlì yìí",
    csvHeaders: {
      refundedAt: "Padà ní",
      memberId: "ID ọmọ ẹgbẹ́",
      memberName: "Orúkọ ọmọ ẹgbẹ́",
      memberEmail: "Ímeèlì ọmọ ẹgbẹ́",
      amount: "Iye",
      currency: "Owó",
      paymentId: "ID ìsanwó",
      orderId: "ID ètò",
      note: "Àkíyèsí",
    },
    footer: "A ṣẹ̀dá rẹ̀ ní àdàákadà nípasẹ̀ KHARAGOLF — láti yí àwọn olùgbàwọlé padà tàbí dúró pẹ́ ètò yìí, ṣí Ìnáwó → Ìmúpọ̀sí àpamọ́wọ́ tí a padà sí láti àdàákadà.",
  },
};

export interface WalletTopupRefundDigestTranslation {
  /**
   * Subject line, with raw `{orgName}` already substituted. Used as a
   * plain-text subject header — never HTML-escaped.
   */
  subject: string;
  /** Header strip label rendered above the body card. */
  headerLabel: string;
  /** H2 heading inside the card (frequency-aware). */
  heading: string;
  /**
   * Intro paragraph template with the `{orgName}` placeholder left intact.
   * The caller is expected to HTML-escape the surrounding text and
   * substitute `{orgName}` with an HTML-escaped + `<strong>`-wrapped name
   * (mirrors the original Task #1073 highlight).
   */
  introTemplate: string;
  labelPeriod: string;
  labelCadence: string;
  /** Localised cadence value (e.g. "weekly" / "monthly" → "साप्ताहिक" / "मासिक"). */
  cadenceLabel: string;
  labelCurrencies: string;
  labelRefunds: string;
  /** Footer paragraph (plain text, no `{orgName}` placeholder). */
  footer: string;
  /** BCP-47 locale used for `Date#toLocaleDateString`. */
  dateLocale: string;
}

/** Resolve the language pack, falling back to English. */
export function resolveWalletTopupRefundDigestLang(
  lang: string | null | undefined,
): WalletTopupRefundDigestLang {
  return isSupportedWalletTopupRefundDigestLang(lang) ? lang : "en";
}

/**
 * Task #1435 — Localised column headers for the
 * `wallet-topup-refunds-YYYY-MM-DD.csv` attachment built by
 * `buildWalletTopupRefundCsv` in `routes/side-games-v2.ts`.
 *
 * Returns the headers as a fixed-order array that matches 1:1 the legacy
 * English snake_case columns the Task #1073 digest shipped with —
 * `refunded_at`, `member_id`, `member_name`, `member_email`, `amount`,
 * `currency`, `payment_id`, `order_id`, `note`. Only the *labels* change
 * per locale; the column *order* is fixed so any downstream parser that
 * keys off position (rather than header text) keeps working.
 *
 * Unsupported `lang` codes fall back to English, mirroring the email
 * digest's translation behaviour.
 */
export function translateWalletTopupRefundCsvHeaders(
  lang: string | null | undefined,
): [string, string, string, string, string, string, string, string, string] {
  const code = resolveWalletTopupRefundDigestLang(lang);
  const h = PACKS[code].csvHeaders;
  return [
    h.refundedAt,
    h.memberId,
    h.memberName,
    h.memberEmail,
    h.amount,
    h.currency,
    h.paymentId,
    h.orderId,
    h.note,
  ];
}

/**
 * Translate the wallet auto-refund digest into the recipient's language.
 *
 * Returns the resolved subject (with raw `orgName` already substituted) and
 * the body label/heading/footer strings, plus an `introTemplate` that still
 * contains the `{orgName}` placeholder so the mailer can HTML-escape the
 * paragraph and re-wrap the org name in its highlight `<strong>` exactly
 * like the original English copy.
 */
export function translateWalletTopupRefundDigest(
  lang: string | null | undefined,
  vars: { orgName: string; frequency: "weekly" | "monthly" },
): WalletTopupRefundDigestTranslation {
  const code = resolveWalletTopupRefundDigestLang(lang);
  const pack = PACKS[code];
  const isWeekly = vars.frequency === "weekly";
  return {
    subject: fmt(isWeekly ? pack.subjectWeekly : pack.subjectMonthly, { orgName: vars.orgName }),
    headerLabel: pack.headerLabel,
    heading: isWeekly ? pack.headingWeekly : pack.headingMonthly,
    introTemplate: pack.intro,
    labelPeriod: pack.labelPeriod,
    labelCadence: pack.labelCadence,
    cadenceLabel: isWeekly ? pack.cadenceWeekly : pack.cadenceMonthly,
    labelCurrencies: pack.labelCurrencies,
    labelRefunds: pack.labelRefunds,
    footer: pack.footer,
    dateLocale: LOCALE_BY_LANG[code],
  };
}
