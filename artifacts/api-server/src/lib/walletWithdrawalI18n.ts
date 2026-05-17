/**
 * Translations for the wallet withdrawal SMS / WhatsApp notice
 * (Tasks #1269, #1487).
 *
 * The push, email, and in-app inbox copy added in Task #964 are
 * separately translated; this module covers the short body fired by
 * `walletWithdrawalNotify.ts` for the three terminal outcomes:
 *
 *   - processed: "Withdrawal paid: ₹500.00 …" (with optional UTR)
 *   - failed:    "Withdrawal failed: ₹500.00 refunded …" (with reason)
 *   - reversed:  "Withdrawal reversed: ₹500.00 refunded …" (with reason)
 *
 * Mirrors the 21-language set declared by the `supported_language` enum
 * (same set used by `walletRefundI18n.ts`, `spectatorPushI18n.ts`, and
 * `highlightPushI18n.ts`). Reuses the language helpers from the wallet
 * auto-refund module so translation lookups stay consistent across
 * wallet notifications.
 *
 * Currency amounts are rendered by the caller via `formatRefundAmount`
 * from `walletRefundI18n.ts`. The `destination` and `reason` fields are
 * payment-network strings (e.g. "UPI alice@upi", "Bank rejected") and
 * stay in their original form.
 *
 * Channel variants
 * ----------------
 * SMS bodies fit the 320-char SMS budget, so the failed/reversed
 * sentences are joined inline with a " — " (em-dash) continuation.
 * WhatsApp has a 1024-char body window and no per-segment cost, and
 * native speakers across the supported 21 languages flagged the inline
 * continuation as terse / abrupt for a billing notice on WhatsApp:
 * the natural pattern there is to end the failure sentence with proper
 * punctuation and start the refund advice on a new paragraph (`\n\n`).
 *
 * To avoid forking the whole strings file, callers pass an optional
 * `channel` arg ("sms" | "whatsapp", default "sms"). When "whatsapp"
 * is passed and an override exists for that language + outcome we use
 * it; otherwise we fall back to the SMS string (which already reads
 * naturally on WhatsApp for the short `processed` body).
 *
 * The SMS strings are intentionally untouched so the 320-char budget
 * and existing SMS test coverage stay valid.
 *
 * Task #1823 — Native-speaker review pass over the SMS strings. The
 * packs below were reviewed with native speakers; per-language
 * decisions (German `du` → `Sie` register switch to match the
 * wallet-refund digest #1485, Brazilian Portuguese `revertido` →
 * `estornado` for the standard banking reversal verb, Afrikaans
 * `teruggekeer` → `omgekeer` for the standard reversal verb, plus the
 * items intentionally left alone) are written up in
 * `docs/i18n/glossary-notes.md` in the same style as the prior #1268 /
 * #1485 reviews. (The same notes are mirrored at the agent-private
 * path `.local/glossary-notes.md` referenced by the older digest pack
 * docstring; treat `docs/i18n/glossary-notes.md` as the canonical,
 * tracked copy.) The WhatsApp overrides added by Task #1487 are a
 * separate native-speaker pass (tracked by the sibling WhatsApp
 * review task) and are not in scope here.
 */
import {
  resolveWalletRefundLang,
  type WalletRefundLang,
} from "./walletRefundI18n.js";

export type WithdrawalSmsLang = WalletRefundLang;

export type WithdrawalOutcome = "processed" | "failed" | "reversed";

export type WithdrawalChannel = "sms" | "whatsapp";

export interface WithdrawalSmsVars {
  /** Locale-formatted amount, e.g. "₹500.00". */
  amount: string;
  /** ISO currency code, e.g. "INR". */
  currency: string;
  /** Member-friendly destination, e.g. "UPI alice@upi". */
  destination: string;
  /** Razorpay UTR (processed only). */
  utr?: string | null;
  /** Razorpay failure reason (failed/reversed only). */
  reason?: string | null;
}

export interface WithdrawalSmsTranslation {
  title: string;
  body: string;
}

interface LangPack {
  /** Title vars: {amount} */
  processedTitle: string;
  failedTitle: string;
  reversedTitle: string;
  /** Body vars: {amount}, {currency}, {destination}, {utr} (already
   *  formatted with leading space, or empty). */
  processedBody: string;
  /** Body vars: {amount}, {currency}, {destination}, {reason} (already
   *  formatted with leading space, or empty). */
  failedBody: string;
  reversedBody: string;
  /** Suffix vars: {utr} */
  utrSuffix: string;
  /** Suffix vars: {reason} */
  reasonSuffix: string;
}

/** Optional WhatsApp-only overrides for fields that read better with
 *  the richer WhatsApp formatting (line breaks, full punctuation). Any
 *  field omitted falls back to the SMS string for that language. */
type WhatsappOverrides = Partial<
  Pick<
    LangPack,
    | "processedBody"
    | "failedBody"
    | "reversedBody"
    | "utrSuffix"
    | "reasonSuffix"
  >
>;

function fmt(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

const PACKS: Record<WithdrawalSmsLang, LangPack> = {
  en: {
    processedTitle: "Withdrawal paid: {amount}",
    failedTitle: "Withdrawal failed: {amount} refunded",
    reversedTitle: "Withdrawal reversed: {amount} refunded",
    processedBody: "Your withdrawal of {amount} {currency} from your wallet has been paid to {destination}.{utr}",
    failedBody: "Your {amount} {currency} withdrawal to {destination} could not be processed.{reason} The full amount has been refunded to your wallet — you can try again or use a different account.",
    reversedBody: "Your {amount} {currency} withdrawal to {destination} was reversed.{reason} The full amount has been refunded to your wallet — you can try again or use a different account.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Reason: {reason}.",
  },

  hi: {
    processedTitle: "निकासी का भुगतान हुआ: {amount}",
    failedTitle: "निकासी विफल: {amount} वापस किया गया",
    reversedTitle: "निकासी पलट दी गई: {amount} वापस किया गया",
    processedBody: "आपके वॉलेट से {amount} {currency} की निकासी {destination} पर भेज दी गई है।{utr}",
    failedBody: "आपकी {amount} {currency} की निकासी {destination} पर पूरी नहीं हो सकी।{reason} पूरी राशि आपके वॉलेट में वापस कर दी गई है — आप दोबारा कोशिश कर सकते हैं या किसी दूसरे खाते का उपयोग कर सकते हैं।",
    reversedBody: "आपकी {amount} {currency} की निकासी {destination} पर पलट दी गई।{reason} पूरी राशि आपके वॉलेट में वापस कर दी गई है — आप दोबारा कोशिश कर सकते हैं या किसी दूसरे खाते का उपयोग कर सकते हैं।",
    utrSuffix: " UTR {utr}।",
    reasonSuffix: " कारण: {reason}।",
  },

  ar: {
    processedTitle: "تم دفع السحب: {amount}",
    failedTitle: "فشل السحب: تم استرداد {amount}",
    reversedTitle: "تم عكس السحب: تم استرداد {amount}",
    processedBody: "تم تحويل سحب بقيمة {amount} {currency} من محفظتك إلى {destination}.{utr}",
    failedBody: "تعذّر إجراء سحب بقيمة {amount} {currency} إلى {destination}.{reason} تم استرداد المبلغ بالكامل إلى محفظتك — يمكنك المحاولة مرة أخرى أو استخدام حساب آخر.",
    reversedBody: "تم عكس عملية السحب بقيمة {amount} {currency} إلى {destination}.{reason} تم استرداد المبلغ بالكامل إلى محفظتك — يمكنك المحاولة مرة أخرى أو استخدام حساب آخر.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " السبب: {reason}.",
  },

  es: {
    processedTitle: "Retiro pagado: {amount}",
    failedTitle: "Retiro fallido: {amount} reembolsado",
    reversedTitle: "Retiro revertido: {amount} reembolsado",
    processedBody: "Tu retiro de {amount} {currency} desde tu billetera se ha pagado a {destination}.{utr}",
    failedBody: "Tu retiro de {amount} {currency} a {destination} no pudo procesarse.{reason} El importe íntegro se ha reembolsado a tu billetera — puedes intentarlo de nuevo o usar otra cuenta.",
    reversedBody: "Tu retiro de {amount} {currency} a {destination} fue revertido.{reason} El importe íntegro se ha reembolsado a tu billetera — puedes intentarlo de nuevo o usar otra cuenta.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Motivo: {reason}.",
  },

  fr: {
    processedTitle: "Retrait payé : {amount}",
    failedTitle: "Retrait échoué : {amount} remboursé",
    reversedTitle: "Retrait annulé : {amount} remboursé",
    processedBody: "Votre retrait de {amount} {currency} depuis votre portefeuille a été versé sur {destination}.{utr}",
    failedBody: "Votre retrait de {amount} {currency} vers {destination} n'a pas pu être traité.{reason} La totalité du montant a été remboursée sur votre portefeuille — vous pouvez réessayer ou utiliser un autre compte.",
    reversedBody: "Votre retrait de {amount} {currency} vers {destination} a été annulé.{reason} La totalité du montant a été remboursée sur votre portefeuille — vous pouvez réessayer ou utiliser un autre compte.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Motif : {reason}.",
  },

  de: {
    processedTitle: "Auszahlung ausgeführt: {amount}",
    failedTitle: "Auszahlung fehlgeschlagen: {amount} erstattet",
    reversedTitle: "Auszahlung storniert: {amount} erstattet",
    processedBody: "Ihre Auszahlung über {amount} {currency} aus Ihrem Wallet wurde an {destination} überwiesen.{utr}",
    failedBody: "Ihre Auszahlung über {amount} {currency} an {destination} konnte nicht durchgeführt werden.{reason} Der gesamte Betrag wurde Ihrem Wallet erstattet — Sie können es erneut versuchen oder ein anderes Konto verwenden.",
    reversedBody: "Ihre Auszahlung über {amount} {currency} an {destination} wurde storniert.{reason} Der gesamte Betrag wurde Ihrem Wallet erstattet — Sie können es erneut versuchen oder ein anderes Konto verwenden.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Grund: {reason}.",
  },

  pt: {
    processedTitle: "Saque pago: {amount}",
    failedTitle: "Saque falhou: {amount} reembolsado",
    reversedTitle: "Saque estornado: {amount} reembolsado",
    processedBody: "Seu saque de {amount} {currency} da carteira foi pago em {destination}.{utr}",
    failedBody: "Seu saque de {amount} {currency} para {destination} não pôde ser processado.{reason} O valor total foi reembolsado à sua carteira — você pode tentar novamente ou usar outra conta.",
    reversedBody: "Seu saque de {amount} {currency} para {destination} foi estornado.{reason} O valor total foi reembolsado à sua carteira — você pode tentar novamente ou usar outra conta.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Motivo: {reason}.",
  },

  ja: {
    processedTitle: "出金完了：{amount}",
    failedTitle: "出金失敗：{amount}を返金しました",
    reversedTitle: "出金取消：{amount}を返金しました",
    processedBody: "ウォレットからの{amount} {currency}の出金が{destination}に支払われました。{utr}",
    failedBody: "{destination}への{amount} {currency}の出金が処理できませんでした。{reason} 全額をウォレットに返金しました — もう一度お試しいただくか、別の口座をご利用ください。",
    reversedBody: "{destination}への{amount} {currency}の出金が取り消されました。{reason} 全額をウォレットに返金しました — もう一度お試しいただくか、別の口座をご利用ください。",
    utrSuffix: " UTR {utr}。",
    reasonSuffix: " 理由：{reason}。",
  },

  ko: {
    processedTitle: "출금 완료: {amount}",
    failedTitle: "출금 실패: {amount} 환불됨",
    reversedTitle: "출금 취소: {amount} 환불됨",
    processedBody: "지갑에서 {amount} {currency} 출금이 {destination}(으)로 지급되었습니다.{utr}",
    failedBody: "{destination}(으)로의 {amount} {currency} 출금을 처리할 수 없습니다.{reason} 전체 금액이 지갑으로 환불되었습니다 — 다시 시도하시거나 다른 계좌를 이용해 주세요.",
    reversedBody: "{destination}(으)로의 {amount} {currency} 출금이 취소되었습니다.{reason} 전체 금액이 지갑으로 환불되었습니다 — 다시 시도하시거나 다른 계좌를 이용해 주세요.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " 사유: {reason}.",
  },

  zh: {
    processedTitle: "提现已支付：{amount}",
    failedTitle: "提现失败：已退还{amount}",
    reversedTitle: "提现已撤销：已退还{amount}",
    processedBody: "您从钱包提现的 {amount} {currency} 已支付至 {destination}。{utr}",
    failedBody: "您向 {destination} 提现 {amount} {currency} 未能完成。{reason} 全部金额已退回您的钱包——您可以重新尝试或使用其他账户。",
    reversedBody: "您向 {destination} 提现 {amount} {currency} 已被撤销。{reason} 全部金额已退回您的钱包——您可以重新尝试或使用其他账户。",
    utrSuffix: " UTR {utr}。",
    reasonSuffix: " 原因：{reason}。",
  },

  th: {
    processedTitle: "จ่ายเงินถอนแล้ว: {amount}",
    failedTitle: "ถอนเงินไม่สำเร็จ: คืนเงิน {amount} แล้ว",
    reversedTitle: "ยกเลิกการถอนเงิน: คืนเงิน {amount} แล้ว",
    processedBody: "การถอนเงิน {amount} {currency} จากกระเป๋าของคุณได้จ่ายไปยัง {destination} แล้ว{utr}",
    failedBody: "การถอนเงิน {amount} {currency} ไปยัง {destination} ดำเนินการไม่สำเร็จ{reason} ยอดเงินทั้งหมดได้คืนกลับเข้ากระเป๋าของคุณแล้ว — คุณสามารถลองใหม่หรือใช้บัญชีอื่นได้",
    reversedBody: "การถอนเงิน {amount} {currency} ไปยัง {destination} ถูกยกเลิก{reason} ยอดเงินทั้งหมดได้คืนกลับเข้ากระเป๋าของคุณแล้ว — คุณสามารถลองใหม่หรือใช้บัญชีอื่นได้",
    utrSuffix: " UTR {utr}",
    reasonSuffix: " สาเหตุ: {reason}",
  },

  ms: {
    processedTitle: "Pengeluaran dibayar: {amount}",
    failedTitle: "Pengeluaran gagal: {amount} dibayar balik",
    reversedTitle: "Pengeluaran dibatalkan: {amount} dibayar balik",
    processedBody: "Pengeluaran sebanyak {amount} {currency} dari dompet anda telah dibayar ke {destination}.{utr}",
    failedBody: "Pengeluaran {amount} {currency} ke {destination} tidak dapat diproses.{reason} Jumlah penuh telah dibayar balik ke dompet anda — anda boleh cuba lagi atau guna akaun lain.",
    reversedBody: "Pengeluaran {amount} {currency} ke {destination} telah dibatalkan.{reason} Jumlah penuh telah dibayar balik ke dompet anda — anda boleh cuba lagi atau guna akaun lain.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Sebab: {reason}.",
  },

  id: {
    processedTitle: "Penarikan dibayar: {amount}",
    failedTitle: "Penarikan gagal: {amount} dikembalikan",
    reversedTitle: "Penarikan dibatalkan: {amount} dikembalikan",
    processedBody: "Penarikan sebesar {amount} {currency} dari dompet Anda telah dibayarkan ke {destination}.{utr}",
    failedBody: "Penarikan {amount} {currency} ke {destination} tidak dapat diproses.{reason} Seluruh jumlah telah dikembalikan ke dompet Anda — Anda dapat mencoba lagi atau menggunakan akun lain.",
    reversedBody: "Penarikan {amount} {currency} ke {destination} dibatalkan.{reason} Seluruh jumlah telah dikembalikan ke dompet Anda — Anda dapat mencoba lagi atau menggunakan akun lain.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Alasan: {reason}.",
  },

  vi: {
    processedTitle: "Đã chi trả khoản rút: {amount}",
    failedTitle: "Rút tiền thất bại: đã hoàn {amount}",
    reversedTitle: "Đã hủy giao dịch rút tiền: đã hoàn {amount}",
    processedBody: "Khoản rút {amount} {currency} từ ví của bạn đã được chuyển đến {destination}.{utr}",
    failedBody: "Khoản rút {amount} {currency} đến {destination} không thể xử lý.{reason} Toàn bộ số tiền đã được hoàn vào ví của bạn — bạn có thể thử lại hoặc dùng tài khoản khác.",
    reversedBody: "Khoản rút {amount} {currency} đến {destination} đã bị hủy.{reason} Toàn bộ số tiền đã được hoàn vào ví của bạn — bạn có thể thử lại hoặc dùng tài khoản khác.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Lý do: {reason}.",
  },

  fil: {
    processedTitle: "Nabayaran ang withdrawal: {amount}",
    failedTitle: "Hindi natuloy ang withdrawal: na-refund ang {amount}",
    reversedTitle: "Binawi ang withdrawal: na-refund ang {amount}",
    processedBody: "Ang iyong withdrawal na {amount} {currency} mula sa wallet ay ipinadala sa {destination}.{utr}",
    failedBody: "Ang withdrawal mong {amount} {currency} papunta sa {destination} ay hindi natapos.{reason} Ibinalik na ang buong halaga sa iyong wallet — maaari kang subukang muli o gumamit ng ibang account.",
    reversedBody: "Ang withdrawal mong {amount} {currency} papunta sa {destination} ay binawi.{reason} Ibinalik na ang buong halaga sa iyong wallet — maaari kang subukang muli o gumamit ng ibang account.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Dahilan: {reason}.",
  },

  sw: {
    processedTitle: "Utoaji umelipwa: {amount}",
    failedTitle: "Utoaji umeshindwa: {amount} imerejeshwa",
    reversedTitle: "Utoaji umetenguliwa: {amount} imerejeshwa",
    processedBody: "Utoaji wako wa {amount} {currency} kutoka kwenye pochi yako umelipwa kwenda {destination}.{utr}",
    failedBody: "Utoaji wako wa {amount} {currency} kwenda {destination} haukuweza kushughulikiwa.{reason} Kiasi chote kimerejeshwa kwenye pochi yako — unaweza kujaribu tena au kutumia akaunti nyingine.",
    reversedBody: "Utoaji wako wa {amount} {currency} kwenda {destination} ulitenguliwa.{reason} Kiasi chote kimerejeshwa kwenye pochi yako — unaweza kujaribu tena au kutumia akaunti nyingine.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Sababu: {reason}.",
  },

  af: {
    processedTitle: "Onttrekking betaal: {amount}",
    failedTitle: "Onttrekking het misluk: {amount} terugbetaal",
    reversedTitle: "Onttrekking omgekeer: {amount} terugbetaal",
    processedBody: "Jou onttrekking van {amount} {currency} uit jou beursie is na {destination} betaal.{utr}",
    failedBody: "Jou onttrekking van {amount} {currency} na {destination} kon nie verwerk word nie.{reason} Die volle bedrag is na jou beursie terugbetaal — jy kan weer probeer of 'n ander rekening gebruik.",
    reversedBody: "Jou onttrekking van {amount} {currency} na {destination} is omgekeer.{reason} Die volle bedrag is na jou beursie terugbetaal — jy kan weer probeer of 'n ander rekening gebruik.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Rede: {reason}.",
  },

  am: {
    processedTitle: "ማውጣት ተከፍሏል: {amount}",
    failedTitle: "ማውጣት አልተሳካም: {amount} ተመላሽ ተደርጓል",
    reversedTitle: "ማውጣት ተቀልብሷል: {amount} ተመላሽ ተደርጓል",
    processedBody: "ከኪስ ቦርሳዎ የወጣው {amount} {currency} ወደ {destination} ተከፍሏል።{utr}",
    failedBody: "ወደ {destination} የተደረገው {amount} {currency} ማውጣት ሊካሄድ አልቻለም።{reason} ሙሉው መጠን ወደ ኪስ ቦርሳዎ ተመላሽ ተደርጓል — እንደገና መሞከር ወይም ሌላ መለያ መጠቀም ይችላሉ።",
    reversedBody: "ወደ {destination} የተደረገው {amount} {currency} ማውጣት ተቀልብሷል።{reason} ሙሉው መጠን ወደ ኪስ ቦርሳዎ ተመላሽ ተደርጓል — እንደገና መሞከር ወይም ሌላ መለያ መጠቀም ይችላሉ።",
    utrSuffix: " UTR {utr}።",
    reasonSuffix: " ምክንያት: {reason}።",
  },

  ha: {
    processedTitle: "An biya cire kuɗi: {amount}",
    failedTitle: "Cire kuɗi ya gaza: an mayar da {amount}",
    reversedTitle: "An soke cire kuɗi: an mayar da {amount}",
    processedBody: "An biya cire kuɗin ku na {amount} {currency} daga walat ɗinku zuwa {destination}.{utr}",
    failedBody: "Cire kuɗin ku na {amount} {currency} zuwa {destination} bai gudana ba.{reason} An mayar da duka kuɗin zuwa walat ɗinku — za ku iya sake gwadawa ko amfani da wani asusu.",
    reversedBody: "An soke cire kuɗin ku na {amount} {currency} zuwa {destination}.{reason} An mayar da duka kuɗin zuwa walat ɗinku — za ku iya sake gwadawa ko amfani da wani asusu.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Dalili: {reason}.",
  },

  zu: {
    processedTitle: "Ukukhipha imali kukhokhiwe: {amount}",
    failedTitle: "Ukukhipha kuhlulekile: {amount} kubuyiselwe",
    reversedTitle: "Ukukhipha kuhoxisiwe: {amount} kubuyiselwe",
    processedBody: "Ukukhipha kwakho kuka-{amount} {currency} esikhwameni sakho kukhokhelwe ku-{destination}.{utr}",
    failedBody: "Ukukhipha kwakho kuka-{amount} {currency} ku-{destination} akukwazanga ukucutshungulwa.{reason} Inani eligcwele libuyiselwe esikhwameni sakho — ungazama futhi noma usebenzise enye i-akhawunti.",
    reversedBody: "Ukukhipha kwakho kuka-{amount} {currency} ku-{destination} kuhoxisiwe.{reason} Inani eligcwele libuyiselwe esikhwameni sakho — ungazama futhi noma usebenzise enye i-akhawunti.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Isizathu: {reason}.",
  },

  yo: {
    processedTitle: "A ti san owó tí a yọ: {amount}",
    failedTitle: "Yíyọ owó kùnà: a ti dá {amount} padà",
    reversedTitle: "A ti yí yíyọ owó padà: a ti dá {amount} padà",
    processedBody: "Yíyọ owó {amount} {currency} látinú àpamọ́wọ́ rẹ ni a ti san fún {destination}.{utr}",
    failedBody: "Yíyọ owó {amount} {currency} sí {destination} kò lè ṣẹlẹ̀.{reason} A ti dá gbogbo iye náà padà sí àpamọ́wọ́ rẹ — o lè gbìyànjú lẹ́ẹ̀kansí tàbí lo àkáǹtì míràn.",
    reversedBody: "Yíyọ owó {amount} {currency} sí {destination} ni a ti yí padà.{reason} A ti dá gbogbo iye náà padà sí àpamọ́wọ́ rẹ — o lè gbìyànjú lẹ́ẹ̀kansí tàbí lo àkáǹtì míràn.",
    utrSuffix: " UTR {utr}.",
    reasonSuffix: " Ìdí: {reason}.",
  },
};

/**
 * Native-speaker reviewed WhatsApp overrides (Task #1826).
 *
 * For every supported language, the SMS `failedBody` / `reversedBody`
 * uses the inline " — " / "——" continuation to fit the 320-char SMS
 * budget. On WhatsApp that reads as terse for a billing notice, so we
 * replace the em-dash continuation with a paragraph break (`\n\n`),
 * end the failure clause with a full stop, and capitalise the start
 * of the refund-and-retry clause where the language requires it.
 *
 * `processedBody` is short and reads naturally on both surfaces, so
 * it inherits from the SMS pack with no override. UTR / reason
 * suffixes are likewise unchanged across channels — they're
 * single-clause additions to the body sentence.
 *
 * Anything not listed here falls back to the SMS string for that
 * language + outcome.
 */
const WHATSAPP_OVERRIDES: Partial<Record<WithdrawalSmsLang, WhatsappOverrides>> = {
  en: {
    failedBody: "Your {amount} {currency} withdrawal to {destination} could not be processed.{reason}\n\nThe full amount has been refunded to your wallet. You can try again or use a different account.",
    reversedBody: "Your {amount} {currency} withdrawal to {destination} was reversed.{reason}\n\nThe full amount has been refunded to your wallet. You can try again or use a different account.",
  },

  hi: {
    failedBody: "आपकी {amount} {currency} की निकासी {destination} पर पूरी नहीं हो सकी।{reason}\n\nपूरी राशि आपके वॉलेट में वापस कर दी गई है। आप दोबारा कोशिश कर सकते हैं या किसी दूसरे खाते का उपयोग कर सकते हैं।",
    reversedBody: "आपकी {amount} {currency} की निकासी {destination} पर पलट दी गई।{reason}\n\nपूरी राशि आपके वॉलेट में वापस कर दी गई है। आप दोबारा कोशिश कर सकते हैं या किसी दूसरे खाते का उपयोग कर सकते हैं।",
  },

  ar: {
    failedBody: "تعذّر إجراء سحب بقيمة {amount} {currency} إلى {destination}.{reason}\n\nتم استرداد المبلغ بالكامل إلى محفظتك. يمكنك المحاولة مرة أخرى أو استخدام حساب آخر.",
    reversedBody: "تم عكس عملية السحب بقيمة {amount} {currency} إلى {destination}.{reason}\n\nتم استرداد المبلغ بالكامل إلى محفظتك. يمكنك المحاولة مرة أخرى أو استخدام حساب آخر.",
  },

  es: {
    failedBody: "Tu retiro de {amount} {currency} a {destination} no pudo procesarse.{reason}\n\nEl importe íntegro se ha reembolsado a tu billetera. Puedes intentarlo de nuevo o usar otra cuenta.",
    reversedBody: "Tu retiro de {amount} {currency} a {destination} fue revertido.{reason}\n\nEl importe íntegro se ha reembolsado a tu billetera. Puedes intentarlo de nuevo o usar otra cuenta.",
  },

  fr: {
    failedBody: "Votre retrait de {amount} {currency} vers {destination} n'a pas pu être traité.{reason}\n\nLa totalité du montant a été remboursée sur votre portefeuille. Vous pouvez réessayer ou utiliser un autre compte.",
    reversedBody: "Votre retrait de {amount} {currency} vers {destination} a été annulé.{reason}\n\nLa totalité du montant a été remboursée sur votre portefeuille. Vous pouvez réessayer ou utiliser un autre compte.",
  },

  de: {
    failedBody: "Deine Auszahlung über {amount} {currency} an {destination} konnte nicht durchgeführt werden.{reason}\n\nDer gesamte Betrag wurde deinem Wallet erstattet. Du kannst es erneut versuchen oder ein anderes Konto verwenden.",
    reversedBody: "Deine Auszahlung über {amount} {currency} an {destination} wurde storniert.{reason}\n\nDer gesamte Betrag wurde deinem Wallet erstattet. Du kannst es erneut versuchen oder ein anderes Konto verwenden.",
  },

  pt: {
    failedBody: "Seu saque de {amount} {currency} para {destination} não pôde ser processado.{reason}\n\nO valor total foi reembolsado à sua carteira. Você pode tentar novamente ou usar outra conta.",
    reversedBody: "Seu saque de {amount} {currency} para {destination} foi revertido.{reason}\n\nO valor total foi reembolsado à sua carteira. Você pode tentar novamente ou usar outra conta.",
  },

  ja: {
    failedBody: "{destination}への{amount} {currency}の出金が処理できませんでした。{reason}\n\n全額をウォレットに返金しました。もう一度お試しいただくか、別の口座をご利用ください。",
    reversedBody: "{destination}への{amount} {currency}の出金が取り消されました。{reason}\n\n全額をウォレットに返金しました。もう一度お試しいただくか、別の口座をご利用ください。",
  },

  ko: {
    failedBody: "{destination}(으)로의 {amount} {currency} 출금을 처리할 수 없습니다.{reason}\n\n전체 금액이 지갑으로 환불되었습니다. 다시 시도하시거나 다른 계좌를 이용해 주세요.",
    reversedBody: "{destination}(으)로의 {amount} {currency} 출금이 취소되었습니다.{reason}\n\n전체 금액이 지갑으로 환불되었습니다. 다시 시도하시거나 다른 계좌를 이용해 주세요.",
  },

  zh: {
    failedBody: "您向 {destination} 提现 {amount} {currency} 未能完成。{reason}\n\n全部金额已退回您的钱包。您可以重新尝试或使用其他账户。",
    reversedBody: "您向 {destination} 提现 {amount} {currency} 已被撤销。{reason}\n\n全部金额已退回您的钱包。您可以重新尝试或使用其他账户。",
  },

  th: {
    failedBody: "การถอนเงิน {amount} {currency} ไปยัง {destination} ดำเนินการไม่สำเร็จ{reason}\n\nยอดเงินทั้งหมดได้คืนกลับเข้ากระเป๋าของคุณแล้ว คุณสามารถลองใหม่หรือใช้บัญชีอื่นได้",
    reversedBody: "การถอนเงิน {amount} {currency} ไปยัง {destination} ถูกยกเลิก{reason}\n\nยอดเงินทั้งหมดได้คืนกลับเข้ากระเป๋าของคุณแล้ว คุณสามารถลองใหม่หรือใช้บัญชีอื่นได้",
  },

  ms: {
    failedBody: "Pengeluaran {amount} {currency} ke {destination} tidak dapat diproses.{reason}\n\nJumlah penuh telah dibayar balik ke dompet anda. Anda boleh cuba lagi atau guna akaun lain.",
    reversedBody: "Pengeluaran {amount} {currency} ke {destination} telah dibatalkan.{reason}\n\nJumlah penuh telah dibayar balik ke dompet anda. Anda boleh cuba lagi atau guna akaun lain.",
  },

  id: {
    failedBody: "Penarikan {amount} {currency} ke {destination} tidak dapat diproses.{reason}\n\nSeluruh jumlah telah dikembalikan ke dompet Anda. Anda dapat mencoba lagi atau menggunakan akun lain.",
    reversedBody: "Penarikan {amount} {currency} ke {destination} dibatalkan.{reason}\n\nSeluruh jumlah telah dikembalikan ke dompet Anda. Anda dapat mencoba lagi atau menggunakan akun lain.",
  },

  vi: {
    failedBody: "Khoản rút {amount} {currency} đến {destination} không thể xử lý.{reason}\n\nToàn bộ số tiền đã được hoàn vào ví của bạn. Bạn có thể thử lại hoặc dùng tài khoản khác.",
    reversedBody: "Khoản rút {amount} {currency} đến {destination} đã bị hủy.{reason}\n\nToàn bộ số tiền đã được hoàn vào ví của bạn. Bạn có thể thử lại hoặc dùng tài khoản khác.",
  },

  fil: {
    failedBody: "Ang withdrawal mong {amount} {currency} papunta sa {destination} ay hindi natapos.{reason}\n\nIbinalik na ang buong halaga sa iyong wallet. Maaari kang subukang muli o gumamit ng ibang account.",
    reversedBody: "Ang withdrawal mong {amount} {currency} papunta sa {destination} ay binawi.{reason}\n\nIbinalik na ang buong halaga sa iyong wallet. Maaari kang subukang muli o gumamit ng ibang account.",
  },

  sw: {
    failedBody: "Utoaji wako wa {amount} {currency} kwenda {destination} haukuweza kushughulikiwa.{reason}\n\nKiasi chote kimerejeshwa kwenye pochi yako. Unaweza kujaribu tena au kutumia akaunti nyingine.",
    reversedBody: "Utoaji wako wa {amount} {currency} kwenda {destination} ulitenguliwa.{reason}\n\nKiasi chote kimerejeshwa kwenye pochi yako. Unaweza kujaribu tena au kutumia akaunti nyingine.",
  },

  af: {
    failedBody: "Jou onttrekking van {amount} {currency} na {destination} kon nie verwerk word nie.{reason}\n\nDie volle bedrag is na jou beursie terugbetaal. Jy kan weer probeer of 'n ander rekening gebruik.",
    reversedBody: "Jou onttrekking van {amount} {currency} na {destination} is teruggekeer.{reason}\n\nDie volle bedrag is na jou beursie terugbetaal. Jy kan weer probeer of 'n ander rekening gebruik.",
  },

  am: {
    failedBody: "ወደ {destination} የተደረገው {amount} {currency} ማውጣት ሊካሄድ አልቻለም።{reason}\n\nሙሉው መጠን ወደ ኪስ ቦርሳዎ ተመላሽ ተደርጓል። እንደገና መሞከር ወይም ሌላ መለያ መጠቀም ይችላሉ።",
    reversedBody: "ወደ {destination} የተደረገው {amount} {currency} ማውጣት ተቀልብሷል።{reason}\n\nሙሉው መጠን ወደ ኪስ ቦርሳዎ ተመላሽ ተደርጓል። እንደገና መሞከር ወይም ሌላ መለያ መጠቀም ይችላሉ።",
  },

  ha: {
    failedBody: "Cire kuɗin ku na {amount} {currency} zuwa {destination} bai gudana ba.{reason}\n\nAn mayar da duka kuɗin zuwa walat ɗinku. Za ku iya sake gwadawa ko amfani da wani asusu.",
    reversedBody: "An soke cire kuɗin ku na {amount} {currency} zuwa {destination}.{reason}\n\nAn mayar da duka kuɗin zuwa walat ɗinku. Za ku iya sake gwadawa ko amfani da wani asusu.",
  },

  zu: {
    failedBody: "Ukukhipha kwakho kuka-{amount} {currency} ku-{destination} akukwazanga ukucutshungulwa.{reason}\n\nInani eligcwele libuyiselwe esikhwameni sakho. Ungazama futhi noma usebenzise enye i-akhawunti.",
    reversedBody: "Ukukhipha kwakho kuka-{amount} {currency} ku-{destination} kuhoxisiwe.{reason}\n\nInani eligcwele libuyiselwe esikhwameni sakho. Ungazama futhi noma usebenzise enye i-akhawunti.",
  },

  yo: {
    failedBody: "Yíyọ owó {amount} {currency} sí {destination} kò lè ṣẹlẹ̀.{reason}\n\nA ti dá gbogbo iye náà padà sí àpamọ́wọ́ rẹ. O lè gbìyànjú lẹ́ẹ̀kansí tàbí lo àkáǹtì míràn.",
    reversedBody: "Yíyọ owó {amount} {currency} sí {destination} ni a ti yí padà.{reason}\n\nA ti dá gbogbo iye náà padà sí àpamọ́wọ́ rẹ. O lè gbìyànjú lẹ́ẹ̀kansí tàbí lo àkáǹtì míràn.",
  },
};

/**
 * Translate the wallet withdrawal notice into the recipient's
 * preferred language. Falls back to English when the language is
 * unsupported or no translation exists.
 *
 * `channel` defaults to `"sms"` for backward compatibility — the
 * existing SMS callers and tests don't need to change. Pass
 * `"whatsapp"` to opt into the native-speaker reviewed WhatsApp
 * variants (Task #1826), which read more naturally on WhatsApp's
 * larger message window.
 */
export function translateWithdrawalSms(
  lang: string | null | undefined,
  outcome: WithdrawalOutcome,
  vars: WithdrawalSmsVars,
  channel: WithdrawalChannel = "sms",
): WithdrawalSmsTranslation {
  const code = resolveWalletRefundLang(lang);
  const pack = PACKS[code];
  const overrides = channel === "whatsapp" ? WHATSAPP_OVERRIDES[code] : undefined;

  const titleTpl =
    outcome === "processed"
      ? pack.processedTitle
      : outcome === "reversed"
        ? pack.reversedTitle
        : pack.failedTitle;

  const utrSuffixTpl = overrides?.utrSuffix ?? pack.utrSuffix;
  const reasonSuffixTpl = overrides?.reasonSuffix ?? pack.reasonSuffix;
  const utrFragment = vars.utr
    ? fmt(utrSuffixTpl, { utr: vars.utr })
    : "";
  const reasonFragment = vars.reason
    ? fmt(reasonSuffixTpl, { reason: vars.reason })
    : "";

  const bodyTpl =
    outcome === "processed"
      ? overrides?.processedBody ?? pack.processedBody
      : outcome === "reversed"
        ? overrides?.reversedBody ?? pack.reversedBody
        : overrides?.failedBody ?? pack.failedBody;

  const baseVars = {
    amount: vars.amount,
    currency: vars.currency,
    destination: vars.destination,
    utr: utrFragment,
    reason: reasonFragment,
  };

  return {
    title: fmt(titleTpl, baseVars),
    body: fmt(bodyTpl, baseVars),
  };
}
