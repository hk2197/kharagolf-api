/**
 * Translations for the wallet top-up auto-refund notice (Task #1069).
 *
 * The push, email, and in-app inbox copy added in Task #919 were
 * English-only. This module mirrors the 21 locales declared by the
 * `supported_language` enum (same set used by `spectatorPushI18n.ts`
 * and `highlightPushI18n.ts`) and translates every member-facing
 * string fired from `walletTopupRefundNotify.ts`:
 *
 *   - push title + body
 *   - in-app inbox subject + body (with optional refund-reference suffix)
 *   - email subject
 *   - the visible text strings inside the email HTML template
 *     (`sendWalletTopupAutoRefundedEmail` in `mailer.ts`)
 *
 * Currency amounts are formatted with `Intl.NumberFormat` against a
 * locale derived from the recipient's preferred language so that
 * digit grouping, decimal separator, and symbol placement match the
 * reader's expectations.
 */

export type WalletRefundLang =
  | "en" | "hi" | "ar" | "es" | "fr" | "de" | "pt"
  | "ja" | "ko" | "zh" | "th" | "ms" | "id" | "vi"
  | "fil" | "sw" | "af" | "am" | "ha" | "zu" | "yo";

export const WALLET_REFUND_LANGS: WalletRefundLang[] = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

export function isSupportedWalletRefundLang(lang: string | null | undefined): lang is WalletRefundLang {
  return !!lang && (WALLET_REFUND_LANGS as string[]).includes(lang);
}

/** BCP-47 locale used for `Intl.NumberFormat` per supported language. */
const LOCALE_BY_LANG: Record<WalletRefundLang, string> = {
  en: "en-US", hi: "hi-IN", ar: "ar", es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR",
  ja: "ja-JP", ko: "ko-KR", zh: "zh-CN", th: "th-TH", ms: "ms-MY", id: "id-ID", vi: "vi-VN",
  fil: "fil-PH", sw: "sw-KE", af: "af-ZA", am: "am-ET", ha: "ha-NG", zu: "zu-ZA", yo: "yo-NG",
};

/**
 * Format a money amount for a given locale and currency.
 *
 * Uses `Intl.NumberFormat` so digit grouping, decimal separators, and
 * symbol placement match the reader's locale conventions. Falls back to
 * a `${symbol}${amount}` string if the runtime can't honour the locale.
 */
export function formatRefundAmount(
  amount: number,
  currency: string,
  lang: WalletRefundLang,
  fallbackSymbol: string,
): string {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(LOCALE_BY_LANG[lang], {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "symbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safeAmount);
  } catch {
    return `${fallbackSymbol}${(Math.round(safeAmount * 100) / 100).toFixed(2)}`;
  }
}

function fmt(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

interface LangPack {
  /** Push notification. */
  pushTitle: string;          // vars: {amount}
  pushBody: string;           // vars: {amount}, {currency}
  /** In-app inbox row. */
  inAppSubject: string;       // vars: {amount}
  inAppBody: string;          // vars: {amount}, {currency}
  inAppRefundSuffix: string;  // vars: {refundId}
  /** Email. */
  emailSubject: string;       // vars: {amount}, {orgName}
  emailHeaderLabel: string;
  emailH2: string;
  /** Greeting + intro paragraph, including the "<strong>amount</strong>" markup. */
  emailIntroHtml: string;     // vars: {name}, {amount}, {orgName}, {days}
  /** Bold "5–7 working days" phrase used inside the intro. */
  emailDaysPhrase: string;
  emailLabelAmount: string;
  emailLabelCurrency: string;
  emailLabelOriginalPayment: string;
  emailLabelRefundReference: string;
  /** Footer paragraph. */
  emailFooter: string;        // vars: {orgName}
}

const PACKS: Record<WalletRefundLang, LangPack> = {
  en: {
    pushTitle: "Refund on its way: {amount}",
    pushBody: "Your wallet top-up of {amount} didn't land, so we've refunded it. It will appear on your original payment method in 5–7 working days.",
    inAppSubject: "Refund on its way: {amount}",
    inAppBody: "Your wallet top-up of {amount} didn't land, so we've refunded it. It will appear on your original payment method in 5–7 working days.",
    inAppRefundSuffix: " Refund reference: {refundId}.",
    emailSubject: "Refund on its way: {amount} top-up reversed ({orgName})",
    emailHeaderLabel: "Wallet Top-Up Refund",
    emailH2: "Refund on its way",
    emailIntroHtml: "Hi {name}, your recent wallet top-up of <strong style=\"color:#fff;\">{amount}</strong> at {orgName} was charged to your bank but never credited to your wallet. We've reversed the charge — the amount should appear on your original payment method in <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "5–7 working days",
    emailLabelAmount: "Amount",
    emailLabelCurrency: "Currency",
    emailLabelOriginalPayment: "Original payment",
    emailLabelRefundReference: "Refund reference",
    emailFooter: "You don't need to do anything — the refund will land on the same card, UPI handle, or bank account you used for the original top-up. If it hasn't arrived after 7 working days, please contact {orgName} with the refund reference above.",
  },

  hi: {
    pushTitle: "रिफंड भेजा जा रहा है: {amount}",
    pushBody: "आपका वॉलेट टॉप-अप {amount} पूरा नहीं हो सका, इसलिए हमने इसे रिफंड कर दिया है। यह आपकी मूल भुगतान विधि में 5–7 कार्य दिवसों में दिखाई देगा।",
    inAppSubject: "रिफंड भेजा जा रहा है: {amount}",
    inAppBody: "आपका वॉलेट टॉप-अप {amount} पूरा नहीं हो सका, इसलिए हमने इसे रिफंड कर दिया है। यह आपकी मूल भुगतान विधि में 5–7 कार्य दिवसों में दिखाई देगा।",
    inAppRefundSuffix: " रिफंड संदर्भ: {refundId}।",
    emailSubject: "रिफंड भेजा जा रहा है: {amount} का टॉप-अप वापस किया गया ({orgName})",
    emailHeaderLabel: "वॉलेट टॉप-अप रिफंड",
    emailH2: "रिफंड भेजा जा रहा है",
    emailIntroHtml: "नमस्ते {name}, {orgName} पर आपका हाल का वॉलेट टॉप-अप <strong style=\"color:#fff;\">{amount}</strong> आपके बैंक से कट गया लेकिन वॉलेट में जमा नहीं हुआ। हमने यह राशि वापस कर दी है — यह आपकी मूल भुगतान विधि में <strong style=\"color:#fff;\">{days}</strong> में आ जाएगी।",
    emailDaysPhrase: "5–7 कार्य दिवसों",
    emailLabelAmount: "राशि",
    emailLabelCurrency: "मुद्रा",
    emailLabelOriginalPayment: "मूल भुगतान",
    emailLabelRefundReference: "रिफंड संदर्भ",
    emailFooter: "आपको कुछ नहीं करना है — रिफंड उसी कार्ड, UPI हैंडल या बैंक खाते में आ जाएगा जिसका उपयोग आपने मूल टॉप-अप के लिए किया था। यदि 7 कार्य दिवसों के बाद भी यह नहीं आया है, तो ऊपर दिए गए रिफंड संदर्भ के साथ {orgName} से संपर्क करें।",
  },

  ar: {
    pushTitle: "الاسترداد في الطريق: {amount}",
    pushBody: "لم يصل شحن محفظتك بقيمة {amount}، لذا قمنا باسترداده. سيظهر المبلغ في طريقة الدفع الأصلية خلال 5–7 أيام عمل.",
    inAppSubject: "الاسترداد في الطريق: {amount}",
    inAppBody: "لم يصل شحن محفظتك بقيمة {amount}، لذا قمنا باسترداده. سيظهر المبلغ في طريقة الدفع الأصلية خلال 5–7 أيام عمل.",
    inAppRefundSuffix: " مرجع الاسترداد: {refundId}.",
    emailSubject: "الاسترداد في الطريق: تم عكس شحن بقيمة {amount} ({orgName})",
    emailHeaderLabel: "استرداد شحن المحفظة",
    emailH2: "الاسترداد في الطريق",
    emailIntroHtml: "مرحباً {name}، تم خصم مبلغ شحن محفظتك الأخير <strong style=\"color:#fff;\">{amount}</strong> لدى {orgName} من بنكك لكنه لم يُضف إلى محفظتك. لقد عكسنا الخصم — يفترض أن يصل المبلغ إلى طريقة الدفع الأصلية خلال <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "5–7 أيام عمل",
    emailLabelAmount: "المبلغ",
    emailLabelCurrency: "العملة",
    emailLabelOriginalPayment: "الدفع الأصلي",
    emailLabelRefundReference: "مرجع الاسترداد",
    emailFooter: "لا يلزمك فعل أي شيء — سيصل الاسترداد إلى نفس البطاقة أو حساب UPI أو الحساب المصرفي الذي استخدمته للشحن الأصلي. إذا لم يصل بعد 7 أيام عمل، يرجى التواصل مع {orgName} مع ذكر مرجع الاسترداد أعلاه.",
  },

  es: {
    pushTitle: "Reembolso en camino: {amount}",
    pushBody: "Tu recarga de billetera de {amount} no se completó, así que la hemos reembolsado. Aparecerá en tu método de pago original en 5–7 días hábiles.",
    inAppSubject: "Reembolso en camino: {amount}",
    inAppBody: "Tu recarga de billetera de {amount} no se completó, así que la hemos reembolsado. Aparecerá en tu método de pago original en 5–7 días hábiles.",
    inAppRefundSuffix: " Referencia de reembolso: {refundId}.",
    emailSubject: "Reembolso en camino: recarga de {amount} revertida ({orgName})",
    emailHeaderLabel: "Reembolso de recarga de billetera",
    emailH2: "Reembolso en camino",
    emailIntroHtml: "Hola {name}, tu reciente recarga de billetera de <strong style=\"color:#fff;\">{amount}</strong> en {orgName} se cobró a tu banco pero nunca se acreditó a tu billetera. Hemos revertido el cargo — el importe debería aparecer en tu método de pago original en <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "5–7 días hábiles",
    emailLabelAmount: "Importe",
    emailLabelCurrency: "Moneda",
    emailLabelOriginalPayment: "Pago original",
    emailLabelRefundReference: "Referencia del reembolso",
    emailFooter: "No tienes que hacer nada: el reembolso llegará a la misma tarjeta, UPI o cuenta bancaria que usaste para la recarga original. Si no ha llegado después de 7 días hábiles, contacta con {orgName} indicando la referencia del reembolso anterior.",
  },

  fr: {
    pushTitle: "Remboursement en cours : {amount}",
    pushBody: "Votre rechargement de portefeuille de {amount} n'a pas abouti, nous l'avons donc remboursé. Il apparaîtra sur votre moyen de paiement initial sous 5–7 jours ouvrés.",
    inAppSubject: "Remboursement en cours : {amount}",
    inAppBody: "Votre rechargement de portefeuille de {amount} n'a pas abouti, nous l'avons donc remboursé. Il apparaîtra sur votre moyen de paiement initial sous 5–7 jours ouvrés.",
    inAppRefundSuffix: " Référence du remboursement : {refundId}.",
    emailSubject: "Remboursement en cours : rechargement de {amount} annulé ({orgName})",
    emailHeaderLabel: "Remboursement du rechargement",
    emailH2: "Remboursement en cours",
    emailIntroHtml: "Bonjour {name}, votre rechargement récent de <strong style=\"color:#fff;\">{amount}</strong> chez {orgName} a été débité de votre banque mais n'a jamais été crédité sur votre portefeuille. Nous avons annulé le débit — le montant devrait apparaître sur votre moyen de paiement initial sous <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "5–7 jours ouvrés",
    emailLabelAmount: "Montant",
    emailLabelCurrency: "Devise",
    emailLabelOriginalPayment: "Paiement initial",
    emailLabelRefundReference: "Référence du remboursement",
    emailFooter: "Vous n'avez rien à faire : le remboursement sera crédité sur la même carte, le même UPI ou le même compte bancaire que celui utilisé pour le rechargement initial. S'il n'arrive pas dans les 7 jours ouvrés, contactez {orgName} en indiquant la référence ci-dessus.",
  },

  de: {
    pushTitle: "Rückerstattung unterwegs: {amount}",
    pushBody: "Deine Wallet-Aufladung über {amount} ist nicht angekommen, daher haben wir sie erstattet. Der Betrag wird innerhalb von 5–7 Werktagen auf deinem ursprünglichen Zahlungsmittel erscheinen.",
    inAppSubject: "Rückerstattung unterwegs: {amount}",
    inAppBody: "Deine Wallet-Aufladung über {amount} ist nicht angekommen, daher haben wir sie erstattet. Der Betrag wird innerhalb von 5–7 Werktagen auf deinem ursprünglichen Zahlungsmittel erscheinen.",
    inAppRefundSuffix: " Erstattungsreferenz: {refundId}.",
    emailSubject: "Rückerstattung unterwegs: Aufladung über {amount} storniert ({orgName})",
    emailHeaderLabel: "Wallet-Aufladung Rückerstattung",
    emailH2: "Rückerstattung unterwegs",
    emailIntroHtml: "Hallo {name}, deine letzte Wallet-Aufladung über <strong style=\"color:#fff;\">{amount}</strong> bei {orgName} wurde von deiner Bank abgebucht, aber deinem Wallet nicht gutgeschrieben. Wir haben die Buchung storniert — der Betrag sollte innerhalb von <strong style=\"color:#fff;\">{days}</strong> auf deinem ursprünglichen Zahlungsmittel erscheinen.",
    emailDaysPhrase: "5–7 Werktagen",
    emailLabelAmount: "Betrag",
    emailLabelCurrency: "Währung",
    emailLabelOriginalPayment: "Ursprüngliche Zahlung",
    emailLabelRefundReference: "Erstattungsreferenz",
    emailFooter: "Du musst nichts unternehmen — die Rückerstattung erfolgt auf dieselbe Karte, denselben UPI-Handle oder dasselbe Bankkonto, das du für die ursprüngliche Aufladung verwendet hast. Sollte sie nach 7 Werktagen nicht angekommen sein, wende dich mit der oben genannten Erstattungsreferenz an {orgName}.",
  },

  pt: {
    pushTitle: "Reembolso a caminho: {amount}",
    pushBody: "Sua recarga de carteira de {amount} não foi concluída, então fizemos o reembolso. O valor aparecerá no seu método de pagamento original em 5–7 dias úteis.",
    inAppSubject: "Reembolso a caminho: {amount}",
    inAppBody: "Sua recarga de carteira de {amount} não foi concluída, então fizemos o reembolso. O valor aparecerá no seu método de pagamento original em 5–7 dias úteis.",
    inAppRefundSuffix: " Referência do reembolso: {refundId}.",
    emailSubject: "Reembolso a caminho: recarga de {amount} revertida ({orgName})",
    emailHeaderLabel: "Reembolso de recarga da carteira",
    emailH2: "Reembolso a caminho",
    emailIntroHtml: "Olá {name}, sua recarga recente de <strong style=\"color:#fff;\">{amount}</strong> em {orgName} foi cobrada do seu banco mas nunca foi creditada na sua carteira. Revertemos a cobrança — o valor deve aparecer no seu método de pagamento original em <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "5–7 dias úteis",
    emailLabelAmount: "Valor",
    emailLabelCurrency: "Moeda",
    emailLabelOriginalPayment: "Pagamento original",
    emailLabelRefundReference: "Referência do reembolso",
    emailFooter: "Você não precisa fazer nada — o reembolso cairá no mesmo cartão, conta UPI ou conta bancária usada na recarga original. Se não chegar após 7 dias úteis, entre em contato com {orgName} informando a referência acima.",
  },

  ja: {
    pushTitle: "返金処理中：{amount}",
    pushBody: "ウォレットへの{amount}のチャージが完了しなかったため、返金処理を行いました。元のお支払い方法に5〜7営業日以内に反映されます。",
    inAppSubject: "返金処理中：{amount}",
    inAppBody: "ウォレットへの{amount}のチャージが完了しなかったため、返金処理を行いました。元のお支払い方法に5〜7営業日以内に反映されます。",
    inAppRefundSuffix: " 返金参照番号：{refundId}。",
    emailSubject: "返金処理中：{amount}のチャージを取り消しました（{orgName}）",
    emailHeaderLabel: "ウォレットチャージの返金",
    emailH2: "返金処理中",
    emailIntroHtml: "{name} 様、{orgName} での先日の<strong style=\"color:#fff;\">{amount}</strong>のウォレットチャージは銀行口座から引き落とされましたが、ウォレットには反映されませんでした。引き落としを取り消しました — 元のお支払い方法に<strong style=\"color:#fff;\">{days}</strong>以内に反映される予定です。",
    emailDaysPhrase: "5〜7営業日",
    emailLabelAmount: "金額",
    emailLabelCurrency: "通貨",
    emailLabelOriginalPayment: "元の支払い",
    emailLabelRefundReference: "返金参照番号",
    emailFooter: "お客様の操作は不要です — 返金は元のチャージにご利用いただいたカード、UPI、または銀行口座に振り込まれます。7営業日経っても入金がない場合は、上記の返金参照番号を添えて {orgName} までお問い合わせください。",
  },

  ko: {
    pushTitle: "환불 진행 중: {amount}",
    pushBody: "지갑 충전 {amount}이(가) 완료되지 않아 환불 처리했습니다. 원래 결제 수단으로 영업일 기준 5–7일 이내에 반환됩니다.",
    inAppSubject: "환불 진행 중: {amount}",
    inAppBody: "지갑 충전 {amount}이(가) 완료되지 않아 환불 처리했습니다. 원래 결제 수단으로 영업일 기준 5–7일 이내에 반환됩니다.",
    inAppRefundSuffix: " 환불 참조 번호: {refundId}.",
    emailSubject: "환불 진행 중: {amount} 충전이 취소되었습니다 ({orgName})",
    emailHeaderLabel: "지갑 충전 환불",
    emailH2: "환불 진행 중",
    emailIntroHtml: "{name}님, {orgName}에서 진행하신 최근 <strong style=\"color:#fff;\">{amount}</strong> 지갑 충전이 은행에서 결제되었지만 지갑에는 반영되지 않았습니다. 결제를 취소했으며 — 해당 금액은 원래 결제 수단으로 <strong style=\"color:#fff;\">{days}</strong> 이내에 환불됩니다.",
    emailDaysPhrase: "영업일 기준 5–7일",
    emailLabelAmount: "금액",
    emailLabelCurrency: "통화",
    emailLabelOriginalPayment: "원래 결제",
    emailLabelRefundReference: "환불 참조 번호",
    emailFooter: "별도로 하실 일은 없습니다 — 환불은 원래 충전에 사용하신 카드, UPI 또는 은행 계좌로 입금됩니다. 영업일 기준 7일 후에도 입금되지 않은 경우, 위 환불 참조 번호와 함께 {orgName}으로 문의해 주세요.",
  },

  zh: {
    pushTitle: "退款已在路上：{amount}",
    pushBody: "您的钱包充值 {amount} 未到账，我们已为您退款。款项将在 5–7 个工作日内退回您的原支付方式。",
    inAppSubject: "退款已在路上：{amount}",
    inAppBody: "您的钱包充值 {amount} 未到账，我们已为您退款。款项将在 5–7 个工作日内退回您的原支付方式。",
    inAppRefundSuffix: " 退款参考号：{refundId}。",
    emailSubject: "退款已在路上：{amount} 充值已撤销（{orgName}）",
    emailHeaderLabel: "钱包充值退款",
    emailH2: "退款已在路上",
    emailIntroHtml: "{name} 您好，您在 {orgName} 最近一次 <strong style=\"color:#fff;\">{amount}</strong> 的钱包充值已从银行扣款，但未到账钱包。我们已撤销该笔扣款 — 款项预计将在 <strong style=\"color:#fff;\">{days}</strong> 内退回您的原支付方式。",
    emailDaysPhrase: "5–7 个工作日",
    emailLabelAmount: "金额",
    emailLabelCurrency: "货币",
    emailLabelOriginalPayment: "原付款",
    emailLabelRefundReference: "退款参考号",
    emailFooter: "您无需操作 — 退款将退回到您原充值时使用的银行卡、UPI 或银行账户。如 7 个工作日后仍未到账，请凭上方退款参考号联系 {orgName}。",
  },

  th: {
    pushTitle: "การคืนเงินกำลังดำเนินการ: {amount}",
    pushBody: "การเติมเงินเข้ากระเป๋าจำนวน {amount} ไม่สำเร็จ เราจึงได้คืนเงินให้คุณแล้ว เงินจะกลับเข้าวิธีชำระเงินเดิมภายใน 5–7 วันทำการ",
    inAppSubject: "การคืนเงินกำลังดำเนินการ: {amount}",
    inAppBody: "การเติมเงินเข้ากระเป๋าจำนวน {amount} ไม่สำเร็จ เราจึงได้คืนเงินให้คุณแล้ว เงินจะกลับเข้าวิธีชำระเงินเดิมภายใน 5–7 วันทำการ",
    inAppRefundSuffix: " หมายเลขอ้างอิงการคืนเงิน: {refundId}",
    emailSubject: "การคืนเงินกำลังดำเนินการ: ยกเลิกการเติมเงิน {amount} แล้ว ({orgName})",
    emailHeaderLabel: "คืนเงินการเติมเงินกระเป๋า",
    emailH2: "การคืนเงินกำลังดำเนินการ",
    emailIntroHtml: "สวัสดี {name} การเติมเงินกระเป๋าล่าสุดของคุณจำนวน <strong style=\"color:#fff;\">{amount}</strong> ที่ {orgName} ถูกหักจากธนาคารแล้วแต่ไม่ได้เข้ากระเป๋า เราได้ยกเลิกรายการหักเงินนี้ — ยอดเงินจะกลับเข้าวิธีชำระเงินเดิมของคุณภายใน <strong style=\"color:#fff;\">{days}</strong>",
    emailDaysPhrase: "5–7 วันทำการ",
    emailLabelAmount: "จำนวนเงิน",
    emailLabelCurrency: "สกุลเงิน",
    emailLabelOriginalPayment: "การชำระเงินต้นทาง",
    emailLabelRefundReference: "หมายเลขอ้างอิงการคืนเงิน",
    emailFooter: "คุณไม่ต้องดำเนินการใดๆ — เงินคืนจะกลับเข้าบัตร UPI หรือบัญชีธนาคารเดิมที่คุณใช้เติมเงิน หากยังไม่ได้รับเงินภายใน 7 วันทำการ โปรดติดต่อ {orgName} พร้อมหมายเลขอ้างอิงด้านบน",
  },

  ms: {
    pushTitle: "Bayaran balik dalam perjalanan: {amount}",
    pushBody: "Tambah nilai dompet anda sebanyak {amount} tidak berjaya, jadi kami telah membayar balik. Ia akan muncul pada kaedah pembayaran asal anda dalam 5–7 hari bekerja.",
    inAppSubject: "Bayaran balik dalam perjalanan: {amount}",
    inAppBody: "Tambah nilai dompet anda sebanyak {amount} tidak berjaya, jadi kami telah membayar balik. Ia akan muncul pada kaedah pembayaran asal anda dalam 5–7 hari bekerja.",
    inAppRefundSuffix: " Rujukan bayaran balik: {refundId}.",
    emailSubject: "Bayaran balik dalam perjalanan: tambah nilai {amount} dibatalkan ({orgName})",
    emailHeaderLabel: "Bayaran Balik Tambah Nilai Dompet",
    emailH2: "Bayaran balik dalam perjalanan",
    emailIntroHtml: "Hai {name}, tambah nilai dompet terkini anda sebanyak <strong style=\"color:#fff;\">{amount}</strong> di {orgName} telah dicaj kepada bank anda tetapi tidak dikreditkan ke dompet. Kami telah membatalkan caj tersebut — jumlahnya sepatutnya muncul pada kaedah pembayaran asal anda dalam <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "5–7 hari bekerja",
    emailLabelAmount: "Jumlah",
    emailLabelCurrency: "Mata wang",
    emailLabelOriginalPayment: "Pembayaran asal",
    emailLabelRefundReference: "Rujukan bayaran balik",
    emailFooter: "Anda tidak perlu melakukan apa-apa — bayaran balik akan masuk ke kad, UPI atau akaun bank yang sama yang anda gunakan untuk tambah nilai asal. Jika ia tidak diterima selepas 7 hari bekerja, sila hubungi {orgName} dengan rujukan bayaran balik di atas.",
  },

  id: {
    pushTitle: "Pengembalian dana sedang diproses: {amount}",
    pushBody: "Top-up dompet Anda sebesar {amount} tidak berhasil, jadi kami sudah mengembalikan dananya. Dana akan kembali ke metode pembayaran asal Anda dalam 5–7 hari kerja.",
    inAppSubject: "Pengembalian dana sedang diproses: {amount}",
    inAppBody: "Top-up dompet Anda sebesar {amount} tidak berhasil, jadi kami sudah mengembalikan dananya. Dana akan kembali ke metode pembayaran asal Anda dalam 5–7 hari kerja.",
    inAppRefundSuffix: " Referensi pengembalian: {refundId}.",
    emailSubject: "Pengembalian dana sedang diproses: top-up {amount} dibatalkan ({orgName})",
    emailHeaderLabel: "Pengembalian Dana Top-Up Dompet",
    emailH2: "Pengembalian dana sedang diproses",
    emailIntroHtml: "Halo {name}, top-up dompet terbaru Anda sebesar <strong style=\"color:#fff;\">{amount}</strong> di {orgName} sudah dipotong dari bank Anda tetapi tidak masuk ke dompet. Kami telah membatalkan pemotongan tersebut — jumlahnya akan kembali ke metode pembayaran asal Anda dalam <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "5–7 hari kerja",
    emailLabelAmount: "Jumlah",
    emailLabelCurrency: "Mata uang",
    emailLabelOriginalPayment: "Pembayaran asal",
    emailLabelRefundReference: "Referensi pengembalian",
    emailFooter: "Anda tidak perlu melakukan apa pun — dana akan dikembalikan ke kartu, UPI, atau rekening bank yang sama yang Anda gunakan untuk top-up asal. Jika belum sampai setelah 7 hari kerja, silakan hubungi {orgName} dengan menyertakan referensi pengembalian di atas.",
  },

  vi: {
    pushTitle: "Đang hoàn tiền: {amount}",
    pushBody: "Khoản nạp ví {amount} của bạn không thành công, nên chúng tôi đã hoàn tiền. Số tiền sẽ về phương thức thanh toán gốc trong 5–7 ngày làm việc.",
    inAppSubject: "Đang hoàn tiền: {amount}",
    inAppBody: "Khoản nạp ví {amount} của bạn không thành công, nên chúng tôi đã hoàn tiền. Số tiền sẽ về phương thức thanh toán gốc trong 5–7 ngày làm việc.",
    inAppRefundSuffix: " Mã hoàn tiền: {refundId}.",
    emailSubject: "Đang hoàn tiền: đã hoàn lại khoản nạp {amount} ({orgName})",
    emailHeaderLabel: "Hoàn tiền nạp ví",
    emailH2: "Đang hoàn tiền",
    emailIntroHtml: "Xin chào {name}, khoản nạp ví gần đây <strong style=\"color:#fff;\">{amount}</strong> của bạn tại {orgName} đã bị trừ ở ngân hàng nhưng chưa được cộng vào ví. Chúng tôi đã hoàn lại giao dịch — số tiền sẽ về phương thức thanh toán gốc trong <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "5–7 ngày làm việc",
    emailLabelAmount: "Số tiền",
    emailLabelCurrency: "Tiền tệ",
    emailLabelOriginalPayment: "Thanh toán gốc",
    emailLabelRefundReference: "Mã hoàn tiền",
    emailFooter: "Bạn không cần làm gì — số tiền hoàn sẽ về cùng thẻ, UPI hoặc tài khoản ngân hàng mà bạn đã dùng để nạp. Nếu sau 7 ngày làm việc vẫn chưa nhận được, vui lòng liên hệ {orgName} kèm mã hoàn tiền ở trên.",
  },

  fil: {
    pushTitle: "Paparating na ang refund: {amount}",
    pushBody: "Hindi nakapasok ang iyong wallet top-up na {amount}, kaya na-refund na namin ito. Babalik ito sa orihinal mong paraan ng pagbabayad sa loob ng 5–7 araw ng trabaho.",
    inAppSubject: "Paparating na ang refund: {amount}",
    inAppBody: "Hindi nakapasok ang iyong wallet top-up na {amount}, kaya na-refund na namin ito. Babalik ito sa orihinal mong paraan ng pagbabayad sa loob ng 5–7 araw ng trabaho.",
    inAppRefundSuffix: " Reference ng refund: {refundId}.",
    emailSubject: "Paparating na ang refund: na-reverse ang top-up na {amount} ({orgName})",
    emailHeaderLabel: "Refund ng Wallet Top-Up",
    emailH2: "Paparating na ang refund",
    emailIntroHtml: "Hi {name}, ang iyong kamakailang wallet top-up na <strong style=\"color:#fff;\">{amount}</strong> sa {orgName} ay nasingil sa iyong banko ngunit hindi pumasok sa iyong wallet. Na-reverse na namin ang singil — dapat lumabas ang halaga sa orihinal mong paraan ng pagbabayad sa loob ng <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "5–7 araw ng trabaho",
    emailLabelAmount: "Halaga",
    emailLabelCurrency: "Pera",
    emailLabelOriginalPayment: "Orihinal na bayad",
    emailLabelRefundReference: "Reference ng refund",
    emailFooter: "Hindi mo na kailangang gumawa ng kahit ano — babalik ang refund sa parehong card, UPI, o bank account na ginamit mo sa orihinal na top-up. Kung hindi pa ito dumating pagkatapos ng 7 araw ng trabaho, makipag-ugnayan sa {orgName} kasama ang reference ng refund sa itaas.",
  },

  sw: {
    pushTitle: "Marejesho yanakuja: {amount}",
    pushBody: "Kuongeza pochi yako kwa {amount} hakukufaulu, hivyo tumekurejeshea. Kitarudi kwa njia yako ya awali ya malipo ndani ya siku 5–7 za kazi.",
    inAppSubject: "Marejesho yanakuja: {amount}",
    inAppBody: "Kuongeza pochi yako kwa {amount} hakukufaulu, hivyo tumekurejeshea. Kitarudi kwa njia yako ya awali ya malipo ndani ya siku 5–7 za kazi.",
    inAppRefundSuffix: " Marejeleo ya marejesho: {refundId}.",
    emailSubject: "Marejesho yanakuja: kuongeza pochi kwa {amount} kumebatilishwa ({orgName})",
    emailHeaderLabel: "Marejesho ya Kuongeza Pochi",
    emailH2: "Marejesho yanakuja",
    emailIntroHtml: "Habari {name}, kuongeza pochi yako kwa <strong style=\"color:#fff;\">{amount}</strong> kwenye {orgName} kulitozwa benki yako lakini hakikuingia kwenye pochi yako. Tumebatilisha malipo — kiasi kinapaswa kuonekana kwenye njia yako ya awali ya malipo ndani ya <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "siku 5–7 za kazi",
    emailLabelAmount: "Kiasi",
    emailLabelCurrency: "Sarafu",
    emailLabelOriginalPayment: "Malipo ya awali",
    emailLabelRefundReference: "Marejeleo ya marejesho",
    emailFooter: "Hauhitaji kufanya chochote — marejesho yatarudi kwenye kadi, UPI, au akaunti ya benki ile ile uliyotumia kuongeza pochi awali. Ikiwa haijawasili baada ya siku 7 za kazi, tafadhali wasiliana na {orgName} ukitaja marejeleo ya marejesho yaliyo hapo juu.",
  },

  af: {
    pushTitle: "Terugbetaling op pad: {amount}",
    pushBody: "Jou beursie-aanvulling van {amount} het nie deurgekom nie, dus het ons dit terugbetaal. Dit sal binne 5–7 werksdae op jou oorspronklike betaalmetode verskyn.",
    inAppSubject: "Terugbetaling op pad: {amount}",
    inAppBody: "Jou beursie-aanvulling van {amount} het nie deurgekom nie, dus het ons dit terugbetaal. Dit sal binne 5–7 werksdae op jou oorspronklike betaalmetode verskyn.",
    inAppRefundSuffix: " Terugbetalingsverwysing: {refundId}.",
    emailSubject: "Terugbetaling op pad: aanvulling van {amount} omgekeer ({orgName})",
    emailHeaderLabel: "Beursie-aanvullingsterugbetaling",
    emailH2: "Terugbetaling op pad",
    emailIntroHtml: "Hallo {name}, jou onlangse beursie-aanvulling van <strong style=\"color:#fff;\">{amount}</strong> by {orgName} is van jou bank afgetrek maar het nooit jou beursie bereik nie. Ons het die transaksie omgekeer — die bedrag behoort binne <strong style=\"color:#fff;\">{days}</strong> op jou oorspronklike betaalmetode te verskyn.",
    emailDaysPhrase: "5–7 werksdae",
    emailLabelAmount: "Bedrag",
    emailLabelCurrency: "Geldeenheid",
    emailLabelOriginalPayment: "Oorspronklike betaling",
    emailLabelRefundReference: "Terugbetalingsverwysing",
    emailFooter: "Jy hoef niks te doen nie — die terugbetaling sal teruggaan na dieselfde kaart, UPI of bankrekening wat jy vir die oorspronklike aanvulling gebruik het. As dit na 7 werksdae nog nie aangekom het nie, kontak asseblief {orgName} met die bostaande terugbetalingsverwysing.",
  },

  am: {
    pushTitle: "ተመላሽ ገንዘብ በመንገድ ላይ ነው፡ {amount}",
    pushBody: "የእርስዎ የቦርሳ ሙሌት {amount} አልገባም፣ ስለዚህ ተመልሰናልዎታል። መጠኑ በ5–7 የስራ ቀናት ውስጥ ወደ መነሻ የክፍያ ዘዴዎ ይመለሳል።",
    inAppSubject: "ተመላሽ ገንዘብ በመንገድ ላይ ነው፡ {amount}",
    inAppBody: "የእርስዎ የቦርሳ ሙሌት {amount} አልገባም፣ ስለዚህ ተመልሰናልዎታል። መጠኑ በ5–7 የስራ ቀናት ውስጥ ወደ መነሻ የክፍያ ዘዴዎ ይመለሳል።",
    inAppRefundSuffix: " የተመላሽ ማጣቀሻ፡ {refundId}።",
    emailSubject: "ተመላሽ ገንዘብ በመንገድ ላይ ነው፡ የ{amount} ሙሌት ተመለሰ ({orgName})",
    emailHeaderLabel: "የቦርሳ ሙሌት ተመላሽ",
    emailH2: "ተመላሽ ገንዘብ በመንገድ ላይ ነው",
    emailIntroHtml: "ሰላም {name}፣ በ{orgName} ላይ የቅርብ ጊዜ የቦርሳ ሙሌትዎ <strong style=\"color:#fff;\">{amount}</strong> ከባንክዎ ተቆርጧል ነገር ግን ወደ ቦርሳዎ አልገባም። ክፍያውን ቀልብሰናል — መጠኑ በ<strong style=\"color:#fff;\">{days}</strong> ውስጥ ወደ መነሻ የክፍያ ዘዴዎ ይመለሳል።",
    emailDaysPhrase: "5–7 የስራ ቀናት",
    emailLabelAmount: "መጠን",
    emailLabelCurrency: "ምንዛሬ",
    emailLabelOriginalPayment: "የመጀመሪያ ክፍያ",
    emailLabelRefundReference: "የተመላሽ ማጣቀሻ",
    emailFooter: "ምንም ማድረግ አያስፈልግዎትም — ተመላሹ ለመጀመሪያው ሙሌት ለተጠቀሙበት ካርድ፣ UPI ወይም ባንክ ሂሳብ ይመለሳል። በ7 የስራ ቀናት ውስጥ ካልደረሰ፣ እባክዎ ከላይ ያለውን የተመላሽ ማጣቀሻ ይዘው {orgName}ን ያነጋግሩ።",
  },

  ha: {
    pushTitle: "Ana mayar maka da kuɗi: {amount}",
    pushBody: "Cika walat ɗinka na {amount} bai yi nasara ba, don haka mun mayar maka. Zai bayyana a hanyar biyan kuɗin asali a cikin kwanaki 5–7 na aiki.",
    inAppSubject: "Ana mayar maka da kuɗi: {amount}",
    inAppBody: "Cika walat ɗinka na {amount} bai yi nasara ba, don haka mun mayar maka. Zai bayyana a hanyar biyan kuɗin asali a cikin kwanaki 5–7 na aiki.",
    inAppRefundSuffix: " Lambar mayar da kuɗi: {refundId}.",
    emailSubject: "Ana mayar da kuɗi: an soke cika na {amount} ({orgName})",
    emailHeaderLabel: "Mayar da Cika Walat",
    emailH2: "Ana mayar da kuɗi",
    emailIntroHtml: "Sannu {name}, cika walat ɗinka na baya-bayan nan na <strong style=\"color:#fff;\">{amount}</strong> a {orgName} an cire shi daga bankin ka amma bai shiga walat ba. Mun soke caji — kuɗin za su bayyana a hanyar biyan kuɗin asali a cikin <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "kwanaki 5–7 na aiki",
    emailLabelAmount: "Adadi",
    emailLabelCurrency: "Kuɗi",
    emailLabelOriginalPayment: "Biyan kuɗin asali",
    emailLabelRefundReference: "Lambar mayar da kuɗi",
    emailFooter: "Ba kwa buƙatar yin komai — kuɗin za su koma zuwa katin, UPI, ko asusun banki ɗaya da kuka yi amfani da shi don cikar asali. Idan bai zo ba bayan kwanaki 7 na aiki, da fatan za a tuntuɓi {orgName} tare da lambar mayar da kuɗi da aka ambata a sama.",
  },

  zu: {
    pushTitle: "Imali ebuyiselwayo iyeza: {amount}",
    pushBody: "Ukufaka kwesikhwama sakho se-{amount} akuphumelelanga, ngakho-ke sikubuyiselile. Kuzovela endleleni yakho yokukhokha yokuqala ezinsukwini ezingu-5–7 zokusebenza.",
    inAppSubject: "Imali ebuyiselwayo iyeza: {amount}",
    inAppBody: "Ukufaka kwesikhwama sakho se-{amount} akuphumelelanga, ngakho-ke sikubuyiselile. Kuzovela endleleni yakho yokukhokha yokuqala ezinsukwini ezingu-5–7 zokusebenza.",
    inAppRefundSuffix: " Inkomba yokubuyiselwa: {refundId}.",
    emailSubject: "Imali ebuyiselwayo iyeza: ukufaka kwe-{amount} kuphenjuliwe ({orgName})",
    emailHeaderLabel: "Imali Ebuyiselwayo Yokufaka Esikhwameni",
    emailH2: "Imali ebuyiselwayo iyeza",
    emailIntroHtml: "Sawubona {name}, ukufaka kwakho kwakamuva kwesikhwama se-<strong style=\"color:#fff;\">{amount}</strong> e-{orgName} kukhokhiwe ebhange lakho kodwa akuzange kufakwe esikhwameni sakho. Sesiphendule isikweletu — imali kufanele ivele endleleni yakho yokukhokha yokuqala phakathi kwe-<strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "izinsuku ezingu-5–7 zokusebenza",
    emailLabelAmount: "Inani",
    emailLabelCurrency: "Imali",
    emailLabelOriginalPayment: "Inkokhelo yokuqala",
    emailLabelRefundReference: "Inkomba yokubuyiselwa",
    emailFooter: "Awudingi ukwenza lutho — imali ebuyiswayo izobuyela ekhadini elifanayo, ku-UPI, noma ku-akhawunti yebhange oyisebenzisile ekufakeni kokuqala. Uma ingakafiki ngemva kwezinsuku ezingu-7 zokusebenza, sicela uxhumane ne-{orgName} nenkomba yokubuyiselwa engenhla.",
  },

  yo: {
    pushTitle: "Owó ìpadàbọ̀ ń bọ̀: {amount}",
    pushBody: "Ìfikún àpamọ́wọ́ rẹ tí ó jẹ́ {amount} kò ṣàṣeyọrí, nítorí náà a ti dá a padà. Yóò fara hàn lórí ọ̀nà ìsanwó ìpilẹ̀ṣẹ̀ rẹ láàrín 5–7 ọjọ́ iṣẹ́.",
    inAppSubject: "Owó ìpadàbọ̀ ń bọ̀: {amount}",
    inAppBody: "Ìfikún àpamọ́wọ́ rẹ tí ó jẹ́ {amount} kò ṣàṣeyọrí, nítorí náà a ti dá a padà. Yóò fara hàn lórí ọ̀nà ìsanwó ìpilẹ̀ṣẹ̀ rẹ láàrín 5–7 ọjọ́ iṣẹ́.",
    inAppRefundSuffix: " Ìtọ́kasí ìpadàbọ̀: {refundId}.",
    emailSubject: "Owó ìpadàbọ̀ ń bọ̀: ìfikún {amount} ti yí padà ({orgName})",
    emailHeaderLabel: "Ìpadàbọ̀ Ìfikún Àpamọ́wọ́",
    emailH2: "Owó ìpadàbọ̀ ń bọ̀",
    emailIntroHtml: "Pẹ̀lẹ́ {name}, ìfikún àpamọ́wọ́ rẹ tuntun tí ó jẹ́ <strong style=\"color:#fff;\">{amount}</strong> ní {orgName} ni a ti gba láti ọ̀dọ̀ báńkì rẹ ṣùgbọ́n kò wọ àpamọ́wọ́ rẹ. A ti yí ẹ̀sùn náà padà — iye náà yẹ kí ó hàn lórí ọ̀nà ìsanwó ìpilẹ̀ṣẹ̀ rẹ láàrín <strong style=\"color:#fff;\">{days}</strong>.",
    emailDaysPhrase: "5–7 ọjọ́ iṣẹ́",
    emailLabelAmount: "Iye",
    emailLabelCurrency: "Owó",
    emailLabelOriginalPayment: "Ìsanwó ìpilẹ̀ṣẹ̀",
    emailLabelRefundReference: "Ìtọ́kasí ìpadàbọ̀",
    emailFooter: "Ìwọ kò ní láti ṣe ohunkóhun — owó ìpadàbọ̀ yóò padà sí káàdì, UPI, tàbí àkọọ́lẹ̀ báńkì kan náà tí o lò fún ìfikún ìpilẹ̀ṣẹ̀. Tí kò bá ti dé lẹ́yìn ọjọ́ iṣẹ́ 7, jọ̀wọ́ kàn sí {orgName} pẹ̀lú ìtọ́kasí ìpadàbọ̀ tí ó wà lókè.",
  },
};

export interface WalletRefundTranslationVars {
  /** Recipient's display name (already trimmed; mailer escapes for HTML). */
  name: string;
  /** Locale-formatted currency string (e.g. "₹1,234.56", "1.234,56 €"). */
  amount: string;
  /** Organisation/club name as it appears in branding. */
  orgName: string;
  /** Razorpay refund id, when present. */
  refundId: string | null;
}

export interface WalletRefundTranslation {
  pushTitle: string;
  pushBody: string;
  inAppSubject: string;
  inAppBody: string;
  emailSubject: string;
  emailHeaderLabel: string;
  emailH2: string;
  /** Pre-composed intro paragraph HTML. The {name}/{orgName} placeholders
   *  must be HTML-escaped by the caller before composing. */
  emailIntroHtml: string;
  emailLabelAmount: string;
  emailLabelCurrency: string;
  emailLabelOriginalPayment: string;
  emailLabelRefundReference: string;
  emailFooter: string;
}

/** Resolve the language pack, falling back to English. */
export function resolveWalletRefundLang(lang: string | null | undefined): WalletRefundLang {
  return isSupportedWalletRefundLang(lang) ? lang : "en";
}

/**
 * Translate the wallet auto-refund notice into the recipient's language.
 *
 * Returns ready-to-use strings for the push, in-app, and email channels.
 * The caller is responsible for HTML-escaping any user-controlled values
 * embedded in `vars` (the email HTML template uses `name`/`orgName`
 * inside its rendered markup).
 */
export function translateWalletRefund(
  lang: string | null | undefined,
  vars: WalletRefundTranslationVars,
): WalletRefundTranslation {
  const code = resolveWalletRefundLang(lang);
  const pack = PACKS[code];
  const baseVars = {
    name: vars.name,
    amount: vars.amount,
    orgName: vars.orgName,
    days: pack.emailDaysPhrase,
  };
  const inAppBody = fmt(pack.inAppBody, baseVars);
  const refundSuffix = vars.refundId
    ? fmt(pack.inAppRefundSuffix, { refundId: vars.refundId })
    : "";
  return {
    pushTitle: fmt(pack.pushTitle, baseVars),
    pushBody: fmt(pack.pushBody, baseVars),
    inAppSubject: fmt(pack.inAppSubject, baseVars),
    inAppBody: refundSuffix ? `${inAppBody}${refundSuffix}` : inAppBody,
    emailSubject: fmt(pack.emailSubject, baseVars),
    emailHeaderLabel: pack.emailHeaderLabel,
    emailH2: pack.emailH2,
    emailIntroHtml: fmt(pack.emailIntroHtml, baseVars),
    emailLabelAmount: pack.emailLabelAmount,
    emailLabelCurrency: pack.emailLabelCurrency,
    emailLabelOriginalPayment: pack.emailLabelOriginalPayment,
    emailLabelRefundReference: pack.emailLabelRefundReference,
    emailFooter: fmt(pack.emailFooter, baseVars),
  };
}
