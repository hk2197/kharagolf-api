// Task #1267 — `composeDocumentRejectedNotification` reuses this `{token}`
// interpolator so notification copy is filled with the same semantics as the
// admin email pack (see helper at the bottom of the file).
import { fmtTemplate as _fmtTemplate } from "./customDomainEmailI18n";

/**
 * Task #1099 — Translations for the most-used admin / member transactional
 * emails so a Hindi/Arabic/Spanish/etc. club no longer receives a mix of
 * localised (custom-domain HTTPS) and English-only (everything else)
 * notifications.
 *
 * Mirrors the 21 languages already shipped by `customDomainEmailI18n.ts` and
 * the `supported_language` enum.
 *
 * Covered email kinds:
 *   - bouncedDigest      — daily admin digest of failing levy reminders
 *                          (sendBouncedLevyDigestEmail)
 *   - levyReceipt        — member receipt for payment / partial payment /
 *                          refund / waiver (sendLevyReceiptEmail)
 *   - documentRejected   — KYC / member-document rejection notice
 *                          (sendDocumentRejectedEmail)
 *   - payoutNotify       — coach payout-paid email (sendCoachPayoutPaidEmail)
 *
 * Strings use {placeholder} tokens identical in style to the custom-domain
 * pack and are interpolated with the shared `fmtTemplate` helper.
 */

export type AdminEmailLang =
  | "en" | "hi" | "ar" | "es" | "fr" | "de" | "pt"
  | "ja" | "ko" | "zh" | "th" | "ms" | "id" | "vi"
  | "fil" | "sw" | "af" | "am" | "ha" | "zu" | "yo";

export const ADMIN_EMAIL_LANGS: AdminEmailLang[] = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

export type AdminEmailKind =
  | "bouncedDigest"
  | "levyReceipt"
  | "documentRejected"
  | "documentUnrejected"
  | "documentPending"
  | "payoutNotify"
  | "payoutAccountReverifiedByAdmin";

export type BouncedDigestStrings = {
  headerTag: string;
  /** Subject when totalBounced === 1. Uses {orgName}. */
  subjectOne: string;
  /** Subject when totalBounced > 1. Uses {count} {orgName}. */
  subjectMany: string;
  heading: string;
  /** Body intro when totalBounced === 1. Uses {staff} {leviesCount} {orgName}. */
  introOne: string;
  /** Body intro when totalBounced > 1. Uses {staff} {count} {leviesCount} {orgName}. */
  introMany: string;
  levyHeader: string;
  bouncedHeader: string;
  latestFailureLabel: string;
  /** Footer line. Uses {orgName}. */
  footer: string;
};

export type LevyReceiptKindStrings = {
  /** Uses {levyName} {orgName}. */
  subject: string;
  heading: string;
  /** Uses {memberName} {levyName}. */
  intro: string;
  amountLabel: string;
};

export type LevyReceiptStrings = {
  headerTag: string;
  payment: LevyReceiptKindStrings;
  partialPayment: LevyReceiptKindStrings;
  refund: LevyReceiptKindStrings;
  waiver: LevyReceiptKindStrings;
  levyLabel: string;
  newBalanceLabel: string;
  currencyLabel: string;
  noteLabel: string;
  /** Uses {orgName}. */
  footer: string;
};

export type DocumentRejectedStrings = {
  headerTag: string;
  /** Uses {docLabel}. */
  subject: string;
  /** Uses {memberName}. */
  greeting: string;
  /** Uses {docLabel} {orgName}. */
  intro: string;
  reasonLabel: string;
  reupload: string;
};

export type DocumentUnrejectedStrings = {
  headerTag: string;
  /** Uses {docLabel}. */
  subject: string;
  /** Uses {memberName}. */
  greeting: string;
  /** Uses {orgName} {docLabel}. */
  intro: string;
  /** Label rendered as `${noteLabel}: ${reason}` when staff supplied an optional note. */
  noteLabel: string;
};

/**
 * Task #1909 — Translation strings for the staff-side notification fired when
 * a member uploads a new document that needs verification. Used by both the
 * push (`pushTitle` + `body`) and email (`emailSubject` + `body`) channels
 * fanned out from `documentPendingStaffNotify.ts`.
 */
export type DocumentPendingStrings = {
  headerTag: string;
  /** Push notification title (no tokens). */
  pushTitle: string;
  /** Email subject line (no tokens). */
  emailSubject: string;
  /** Push body / email body. Uses {memberName} {docTypeLabel} {docLabel}. */
  body: string;
};

export type PayoutNotifyStrings = {
  headerTag: string;
  /** Uses {amount} {orgName}. */
  subject: string;
  heading: string;
  /** Uses {coachName} {orgName}. */
  greeting: string;
  amountLabel: string;
  referenceLabel: string;
  notesLabel: string;
  eta: string;
  footer: string;
};

/**
 * Task #1723 — Translation strings for the coach-side courtesy email
 * fired when an organisation admin manually re-verifies a coach's
 * saved payout account (Task #1428). The same template covers both
 * outcomes (`verified` / `needs_attention`); fields with the
 * `Verified` / `NeedsAttention` suffix are picked based on the
 * outcome at render time.
 */
export type PayoutAccountReverifiedByAdminStrings = {
  headerTag: string;
  /** Subject when outcome === "verified". Uses {orgName}. */
  subjectVerified: string;
  /** Subject when outcome === "needs_attention". Uses {methodLabel}. */
  subjectNeedsAttention: string;
  /** Headline when outcome === "verified". */
  headingVerified: string;
  /** Headline when outcome === "needs_attention". */
  headingNeedsAttention: string;
  /** Greeting prefix rendered before the intro paragraph. Uses {coachName}. */
  greeting: string;
  /** Intro paragraph when outcome === "verified". Uses {orgName} {methodLabel}. */
  introVerified: string;
  /** Intro paragraph when outcome === "needs_attention". Uses {orgName} {methodLabel}. */
  introNeedsAttention: string;
  /** Inline label for the UPI ID method (lowercase noun used in subject/intro). */
  upiInlineLabel: string;
  /** Inline label for the bank account method (lowercase noun used in subject/intro). */
  bankInlineLabel: string;
  /** Detail-table row label for the UPI ID method. */
  upiRowLabel: string;
  /** Detail-table row label for the bank account method. */
  bankRowLabel: string;
  /** Detail-table row label for the re-verification timestamp. */
  reverifiedOnLabel: string;
  /** Detail-table row label for the verification status. */
  statusLabel: string;
  /** Status value when outcome === "verified". */
  statusValueVerified: string;
  /** Status value when outcome === "needs_attention". */
  statusValueNeedsAttention: string;
  /** Detail-table row label for the optional bank-side reason. */
  reasonLabel: string;
  footer: string;
};

export type AdminEmailStrings = {
  bouncedDigest: BouncedDigestStrings;
  levyReceipt: LevyReceiptStrings;
  documentRejected: DocumentRejectedStrings;
  documentUnrejected: DocumentUnrejectedStrings;
  documentPending: DocumentPendingStrings;
  payoutNotify: PayoutNotifyStrings;
  payoutAccountReverifiedByAdmin: PayoutAccountReverifiedByAdminStrings;
};

const PACKS: Record<AdminEmailLang, AdminEmailStrings> = {
  en: {
    bouncedDigest: {
      headerTag: "Levy Reminders",
      subjectOne: "⚠️ 1 bounced levy reminder needs attention — {orgName}",
      subjectMany: "⚠️ {count} bounced levy reminders need attention — {orgName}",
      heading: "Bounced levy reminders — daily digest",
      introOne: "Hi {staff}, 1 levy reminder is still failing across {leviesCount} levy definition for {orgName}. Each row below links to the levy detail where you can retry the affected channels or fix the underlying contact details.",
      introMany: "Hi {staff}, {count} levy reminders are still failing across {leviesCount} levy definitions for {orgName}. Each row below links to the levy detail where you can retry the affected channels or fix the underlying contact details.",
      levyHeader: "Levy",
      bouncedHeader: "Bounced",
      latestFailureLabel: "Latest failure",
      footer: "This digest only goes out on days with unresolved failures. You are receiving it because you are an organisation administrator for {orgName}.",
    },
    levyReceipt: {
      headerTag: "Member Account",
      payment: {
        subject: "Payment receipt — {levyName} ({orgName})",
        heading: "Payment received",
        intro: "Hi {memberName}, we've recorded your payment for <strong style=\"color:#fff;\">{levyName}</strong>. Your balance is now settled.",
        amountLabel: "Amount paid",
      },
      partialPayment: {
        subject: "Partial payment receipt — {levyName} ({orgName})",
        heading: "Partial payment received",
        intro: "Hi {memberName}, we've recorded a partial payment against <strong style=\"color:#fff;\">{levyName}</strong>. A balance remains outstanding.",
        amountLabel: "Amount paid",
      },
      refund: {
        subject: "Refund issued — {levyName} ({orgName})",
        heading: "Refund issued",
        intro: "Hi {memberName}, a refund has been issued against your <strong style=\"color:#fff;\">{levyName}</strong> charge.",
        amountLabel: "Amount refunded",
      },
      waiver: {
        subject: "Charge waived — {levyName} ({orgName})",
        heading: "Charge waived",
        intro: "Hi {memberName}, your <strong style=\"color:#fff;\">{levyName}</strong> charge has been waived. Nothing further is owed.",
        amountLabel: "Amount waived",
      },
      levyLabel: "Levy",
      newBalanceLabel: "New balance",
      currencyLabel: "Currency",
      noteLabel: "Note",
      footer: "You can view your full payment history any time from the member portal. If anything looks incorrect, please reply to this email or contact {orgName} directly.",
    },
    documentRejected: {
      headerTag: "Documents",
      subject: "Document needs attention: {docLabel}",
      greeting: "Hi {memberName},",
      intro: "Your uploaded document \"{docLabel}\" was reviewed by {orgName} staff and could not be accepted.",
      reasonLabel: "Reason",
      reupload: "Please re-upload a corrected version from the member portal at your earliest convenience.",
    },
    documentUnrejected: {
      headerTag: "Documents",
      subject: "Rejection withdrawn: {docLabel}",
      greeting: "Hi {memberName},",
      intro: "{orgName} staff has withdrawn the previous rejection of your document \"{docLabel}\". It is back in the pending queue and will be reviewed again — no action is needed from you.",
      noteLabel: "Note from staff",
    },
    documentPending: {
      headerTag: "Documents",
      pushTitle: "New document awaiting review",
      emailSubject: "New member document awaiting review",
      body: "{memberName} uploaded a new {docTypeLabel} document (\"{docLabel}\") for verification.",
    },
    payoutNotify: {
      headerTag: "Coach Payout",
      subject: "Payout sent — {amount} from {orgName}",
      heading: "✅ Payout Sent",
      greeting: "Hi {coachName}, your latest swing-review payout from <strong style=\"color:#fff;\">{orgName}</strong> has been marked paid.",
      amountLabel: "Amount",
      referenceLabel: "Reference",
      notesLabel: "Notes",
      eta: "Funds typically appear in your registered account within 1–2 business days, depending on your bank.",
      footer: "You can review the full payout history any time from the Earnings tab in your coach workspace.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Payout Account",
      subjectVerified: "Your payout account was re-verified — {orgName}",
      subjectNeedsAttention: "Action needed — admin re-check flagged your payout {methodLabel}",
      headingVerified: "Your payout account was re-verified",
      headingNeedsAttention: "Your payout account needs attention after a re-check",
      greeting: "Hi {coachName},",
      introVerified: "An administrator at <strong style=\"color:#fff;\">{orgName}</strong> manually re-verified the {methodLabel} on file for your coach payouts. The check completed successfully and your payouts will continue as normal — no action is needed.",
      introNeedsAttention: "An administrator at <strong style=\"color:#fff;\">{orgName}</strong> manually re-verified the {methodLabel} on file for your coach payouts. The bank reported it as no longer valid, so your next payout will be parked until you re-save your details.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "bank account",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Bank account",
      reverifiedOnLabel: "Re-verified on",
      statusLabel: "Status",
      statusValueVerified: "Verified",
      statusValueNeedsAttention: "Needs attention",
      reasonLabel: "Reason",
      footer: "If you didn't expect an admin to re-check your account, reach out to your organisation's support team. You can also re-save your payout details in your coach workspace at any time to trigger a fresh validation yourself.",
    },
  },

  hi: {
    bouncedDigest: {
      headerTag: "शुल्क अनुस्मारक",
      subjectOne: "⚠️ 1 लौटाया गया शुल्क अनुस्मारक — {orgName}",
      subjectMany: "⚠️ {count} लौटाए गए शुल्क अनुस्मारक — {orgName}",
      heading: "लौटाए गए शुल्क अनुस्मारक — दैनिक सार",
      introOne: "नमस्ते {staff}, {orgName} के {leviesCount} शुल्क परिभाषा के अंतर्गत 1 अनुस्मारक अभी भी विफल हो रहा है। नीचे दी गई प्रत्येक पंक्ति शुल्क विवरण पर ले जाती है, जहाँ आप प्रभावित चैनलों को फिर से आज़मा सकते हैं या संपर्क विवरण ठीक कर सकते हैं।",
      introMany: "नमस्ते {staff}, {orgName} की {leviesCount} शुल्क परिभाषाओं के अंतर्गत {count} अनुस्मारक अभी भी विफल हो रहे हैं। नीचे दी गई प्रत्येक पंक्ति शुल्क विवरण पर ले जाती है, जहाँ आप प्रभावित चैनलों को फिर से आज़मा सकते हैं या संपर्क विवरण ठीक कर सकते हैं।",
      levyHeader: "शुल्क",
      bouncedHeader: "लौटा हुआ",
      latestFailureLabel: "नवीनतम विफलता",
      footer: "यह सार केवल उन दिनों भेजा जाता है जब कोई अनसुलझी विफलता हो। आप यह संदेश इसलिए पा रहे हैं क्योंकि आप {orgName} के संगठन एडमिन हैं।",
    },
    levyReceipt: {
      headerTag: "सदस्य खाता",
      payment: {
        subject: "भुगतान रसीद — {levyName} ({orgName})",
        heading: "भुगतान प्राप्त हुआ",
        intro: "नमस्ते {memberName}, हमने <strong style=\"color:#fff;\">{levyName}</strong> के लिए आपका भुगतान दर्ज कर लिया है। अब आपका कोई बकाया शेष नहीं है।",
        amountLabel: "भुगतान की गई राशि",
      },
      partialPayment: {
        subject: "आंशिक भुगतान रसीद — {levyName} ({orgName})",
        heading: "आंशिक भुगतान प्राप्त हुआ",
        intro: "नमस्ते {memberName}, हमने <strong style=\"color:#fff;\">{levyName}</strong> के विरुद्ध आंशिक भुगतान दर्ज किया है। शेष राशि अभी भी बकाया है।",
        amountLabel: "भुगतान की गई राशि",
      },
      refund: {
        subject: "रिफ़ंड जारी — {levyName} ({orgName})",
        heading: "रिफ़ंड जारी किया गया",
        intro: "नमस्ते {memberName}, आपके <strong style=\"color:#fff;\">{levyName}</strong> शुल्क के विरुद्ध रिफ़ंड जारी किया गया है।",
        amountLabel: "रिफ़ंड की राशि",
      },
      waiver: {
        subject: "शुल्क माफ़ — {levyName} ({orgName})",
        heading: "शुल्क माफ़ किया गया",
        intro: "नमस्ते {memberName}, आपका <strong style=\"color:#fff;\">{levyName}</strong> शुल्क माफ़ कर दिया गया है। कुछ और देय नहीं है।",
        amountLabel: "माफ़ की गई राशि",
      },
      levyLabel: "शुल्क",
      newBalanceLabel: "नया शेष",
      currencyLabel: "मुद्रा",
      noteLabel: "टिप्पणी",
      footer: "आप कभी भी सदस्य पोर्टल से अपना पूरा भुगतान इतिहास देख सकते हैं। यदि कुछ ग़लत लगे तो कृपया इस ईमेल का उत्तर दें या {orgName} से सीधे संपर्क करें।",
    },
    documentRejected: {
      headerTag: "दस्तावेज़",
      subject: "दस्तावेज़ पर ध्यान दें: {docLabel}",
      greeting: "नमस्ते {memberName},",
      intro: "आपके अपलोड किए गए दस्तावेज़ \"{docLabel}\" की समीक्षा {orgName} के स्टाफ ने की और उसे स्वीकार नहीं किया जा सका।",
      reasonLabel: "कारण",
      reupload: "कृपया जल्द से जल्द सदस्य पोर्टल से सही संस्करण फिर से अपलोड करें।",
    },
    documentUnrejected: {
      headerTag: "दस्तावेज़",
      subject: "अस्वीकृति वापस ली गई: {docLabel}",
      greeting: "नमस्ते {memberName},",
      intro: "{orgName} के स्टाफ ने आपके दस्तावेज़ \"{docLabel}\" की पिछली अस्वीकृति वापस ले ली है। यह अब फिर से समीक्षा के लिए लंबित कतार में है — आपकी ओर से किसी कार्रवाई की आवश्यकता नहीं है।",
      noteLabel: "स्टाफ की टिप्पणी",
    },
    documentPending: {
      headerTag: "दस्तावेज़",
      pushTitle: "समीक्षा के लिए नया दस्तावेज़",
      emailSubject: "समीक्षा के लिए नया सदस्य दस्तावेज़",
      body: "{memberName} ने सत्यापन के लिए एक नया {docTypeLabel} दस्तावेज़ (\"{docLabel}\") अपलोड किया है।",
    },
    payoutNotify: {
      headerTag: "कोच भुगतान",
      subject: "भुगतान भेजा गया — {orgName} से {amount}",
      heading: "✅ भुगतान भेजा गया",
      greeting: "नमस्ते {coachName}, <strong style=\"color:#fff;\">{orgName}</strong> से आपकी नवीनतम स्विंग-समीक्षा का भुगतान कर दिया गया है।",
      amountLabel: "राशि",
      referenceLabel: "संदर्भ",
      notesLabel: "टिप्पणियाँ",
      eta: "धनराशि आम तौर पर आपके बैंक के अनुसार 1–2 कारोबारी दिनों में आपके पंजीकृत खाते में दिख जाती है।",
      footer: "आप अपने कोच वर्कस्पेस के कमाई (Earnings) टैब से पूरा पेआउट इतिहास कभी भी देख सकते हैं।",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "भुगतान खाता",
      subjectVerified: "आपका भुगतान खाता पुनः-सत्यापित किया गया — {orgName}",
      subjectNeedsAttention: "कार्रवाई आवश्यक — एडमिन की पुनः-जाँच में आपके भुगतान {methodLabel} पर ध्यान देने की आवश्यकता है",
      headingVerified: "आपका भुगतान खाता पुनः-सत्यापित किया गया",
      headingNeedsAttention: "पुनः-जाँच के बाद आपके भुगतान खाते पर ध्यान देने की आवश्यकता है",
      greeting: "नमस्ते {coachName},",
      introVerified: "<strong style=\"color:#fff;\">{orgName}</strong> के एक एडमिन ने आपके कोच भुगतानों के लिए दर्ज {methodLabel} की मैन्युअल रूप से पुनः-जाँच की। जाँच सफलतापूर्वक पूरी हो गई और आपके भुगतान सामान्य रूप से जारी रहेंगे — किसी कार्रवाई की आवश्यकता नहीं है।",
      introNeedsAttention: "<strong style=\"color:#fff;\">{orgName}</strong> के एक एडमिन ने आपके कोच भुगतानों के लिए दर्ज {methodLabel} की मैन्युअल रूप से पुनः-जाँच की। बैंक ने इसे अब मान्य नहीं बताया, इसलिए आपका अगला भुगतान तब तक रोक दिया जाएगा जब तक आप अपना विवरण फिर से सहेज नहीं देते।",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "बैंक खाता",
      upiRowLabel: "UPI ID",
      bankRowLabel: "बैंक खाता",
      reverifiedOnLabel: "पुनः-सत्यापन तिथि",
      statusLabel: "स्थिति",
      statusValueVerified: "सत्यापित",
      statusValueNeedsAttention: "ध्यान देने की आवश्यकता है",
      reasonLabel: "कारण",
      footer: "यदि आपको उम्मीद नहीं थी कि कोई एडमिन आपके खाते की पुनः-जाँच करेगा, तो अपने संगठन की सहायता टीम से संपर्क करें। आप कभी भी अपने कोच वर्कस्पेस में अपना भुगतान विवरण फिर से सहेजकर स्वयं नई जाँच भी ट्रिगर कर सकते हैं।",
    },
  },

  ar: {
    bouncedDigest: {
      headerTag: "تذكيرات الرسوم",
      subjectOne: "⚠️ تذكير رسوم مرتد واحد بحاجة إلى متابعة — {orgName}",
      subjectMany: "⚠️ {count} من تذكيرات الرسوم المرتدة بحاجة إلى متابعة — {orgName}",
      heading: "تذكيرات الرسوم المرتدة — الملخص اليومي",
      introOne: "مرحباً {staff}, لا يزال هناك تذكير رسوم واحد فاشل ضمن {leviesCount} تعريف رسوم لـ {orgName}. كل صف أدناه مرتبط بتفاصيل الرسوم حيث يمكنك إعادة محاولة القنوات المتأثرة أو تصحيح بيانات الاتصال.",
      introMany: "مرحباً {staff}, لا تزال {count} تذكيرات رسوم فاشلة عبر {leviesCount} تعريفات رسوم لـ {orgName}. كل صف أدناه مرتبط بتفاصيل الرسوم حيث يمكنك إعادة محاولة القنوات المتأثرة أو تصحيح بيانات الاتصال.",
      levyHeader: "الرسوم",
      bouncedHeader: "مرتدّ",
      latestFailureLabel: "آخر إخفاق",
      footer: "يُرسل هذا الملخص فقط في الأيام التي تحتوي على إخفاقات لم تُحَل. تتلقى هذه الرسالة لأنك مسؤول منظمة لـ {orgName}.",
    },
    levyReceipt: {
      headerTag: "حساب العضو",
      payment: {
        subject: "إيصال دفع — {levyName} ({orgName})",
        heading: "تم استلام الدفعة",
        intro: "مرحباً {memberName}، سجّلنا دفعتك لـ <strong style=\"color:#fff;\">{levyName}</strong>. تمت تسوية رصيدك بالكامل.",
        amountLabel: "المبلغ المدفوع",
      },
      partialPayment: {
        subject: "إيصال دفع جزئي — {levyName} ({orgName})",
        heading: "تم استلام دفعة جزئية",
        intro: "مرحباً {memberName}، سجّلنا دفعة جزئية مقابل <strong style=\"color:#fff;\">{levyName}</strong>. لا يزال هناك رصيد مستحق.",
        amountLabel: "المبلغ المدفوع",
      },
      refund: {
        subject: "تم إصدار استرداد — {levyName} ({orgName})",
        heading: "تم إصدار الاسترداد",
        intro: "مرحباً {memberName}، تم إصدار استرداد مقابل رسوم <strong style=\"color:#fff;\">{levyName}</strong> الخاصة بك.",
        amountLabel: "المبلغ المُسترد",
      },
      waiver: {
        subject: "تم الإعفاء من الرسوم — {levyName} ({orgName})",
        heading: "تم الإعفاء من الرسوم",
        intro: "مرحباً {memberName}، تم الإعفاء من رسوم <strong style=\"color:#fff;\">{levyName}</strong>. لا يوجد مستحق آخر.",
        amountLabel: "المبلغ المُعفى",
      },
      levyLabel: "الرسوم",
      newBalanceLabel: "الرصيد الجديد",
      currencyLabel: "العملة",
      noteLabel: "ملاحظة",
      footer: "يمكنك مراجعة سجل المدفوعات الكامل في أي وقت من بوابة الأعضاء. إذا بدا شيء غير صحيح، يرجى الرد على هذا البريد أو الاتصال بـ {orgName} مباشرةً.",
    },
    documentRejected: {
      headerTag: "المستندات",
      subject: "مستند يحتاج إلى الانتباه: {docLabel}",
      greeting: "مرحباً {memberName}،",
      intro: "تمت مراجعة مستندك المرفوع \"{docLabel}\" من قِبَل فريق {orgName} ولم يكن من الممكن قبوله.",
      reasonLabel: "السبب",
      reupload: "يرجى إعادة رفع نسخة مصححة من بوابة الأعضاء في أقرب وقت ممكن.",
    },
    documentUnrejected: {
      headerTag: "المستندات",
      subject: "تم سحب الرفض: {docLabel}",
      greeting: "مرحباً {memberName}،",
      intro: "قام فريق {orgName} بسحب الرفض السابق لمستندك \"{docLabel}\". لقد عاد إلى قائمة الانتظار للمراجعة مرة أخرى — لا حاجة لأي إجراء منك.",
      noteLabel: "ملاحظة من الفريق",
    },
    documentPending: {
      headerTag: "المستندات",
      pushTitle: "مستند جديد في انتظار المراجعة",
      emailSubject: "مستند عضو جديد في انتظار المراجعة",
      body: "قام {memberName} برفع مستند {docTypeLabel} جديد (\"{docLabel}\") للتحقق منه.",
    },
    payoutNotify: {
      headerTag: "دفعة المدرّب",
      subject: "تم إرسال الدفعة — {amount} من {orgName}",
      heading: "✅ تم إرسال الدفعة",
      greeting: "مرحباً {coachName}، تم تسجيل أحدث دفعة لمراجعة الضربات من <strong style=\"color:#fff;\">{orgName}</strong> كمسددة.",
      amountLabel: "المبلغ",
      referenceLabel: "المرجع",
      notesLabel: "ملاحظات",
      eta: "تظهر الأموال عادةً في حسابك المسجل خلال يوم إلى يومَي عمل، حسب المصرف.",
      footer: "يمكنك مراجعة سجل المدفوعات الكامل في أي وقت من تبويب الأرباح (Earnings) في مساحة عمل المدرّب.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "حساب الدفع",
      subjectVerified: "تمت إعادة التحقق من حساب دفعتك — {orgName}",
      subjectNeedsAttention: "إجراء مطلوب — أبلغت إعادة فحص المسؤول عن مشكلة في {methodLabel} الخاصة بدفعتك",
      headingVerified: "تمت إعادة التحقق من حساب دفعتك",
      headingNeedsAttention: "حساب دفعتك يحتاج إلى الانتباه بعد إعادة الفحص",
      greeting: "مرحباً {coachName}،",
      introVerified: "قام مسؤول في <strong style=\"color:#fff;\">{orgName}</strong> يدوياً بإعادة التحقق من {methodLabel} المسجلة لمدفوعات تدريبك. اكتمل الفحص بنجاح وستستمر مدفوعاتك كالمعتاد — لا حاجة لأي إجراء.",
      introNeedsAttention: "قام مسؤول في <strong style=\"color:#fff;\">{orgName}</strong> يدوياً بإعادة التحقق من {methodLabel} المسجلة لمدفوعات تدريبك. أبلغ المصرف أنها لم تعد صالحة، لذلك ستُحجز دفعتك التالية حتى تعيد حفظ بياناتك.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "حساب مصرفي",
      upiRowLabel: "UPI ID",
      bankRowLabel: "الحساب المصرفي",
      reverifiedOnLabel: "تاريخ إعادة التحقق",
      statusLabel: "الحالة",
      statusValueVerified: "تم التحقق",
      statusValueNeedsAttention: "يحتاج إلى الانتباه",
      reasonLabel: "السبب",
      footer: "إذا لم تكن تتوقع أن يقوم مسؤول بإعادة فحص حسابك، فيرجى التواصل مع فريق دعم منظمتك. يمكنك أيضاً إعادة حفظ بيانات الدفع في مساحة عمل المدرّب في أي وقت لإجراء تحقق جديد بنفسك.",
    },
  },

  es: {
    bouncedDigest: {
      headerTag: "Recordatorios de cuotas",
      subjectOne: "⚠️ 1 recordatorio de cuota rebotado requiere atención — {orgName}",
      subjectMany: "⚠️ {count} recordatorios de cuota rebotados requieren atención — {orgName}",
      heading: "Recordatorios de cuota rebotados — resumen diario",
      introOne: "Hola {staff}, 1 recordatorio de cuota sigue fallando en {leviesCount} definición de cuota para {orgName}. Cada fila enlaza al detalle de la cuota donde puedes reintentar los canales afectados o corregir los datos de contacto.",
      introMany: "Hola {staff}, {count} recordatorios de cuota siguen fallando en {leviesCount} definiciones de cuota para {orgName}. Cada fila enlaza al detalle de la cuota donde puedes reintentar los canales afectados o corregir los datos de contacto.",
      levyHeader: "Cuota",
      bouncedHeader: "Rebotados",
      latestFailureLabel: "Último fallo",
      footer: "Este resumen solo se envía los días con fallos sin resolver. Lo recibes porque eres administrador de la organización en {orgName}.",
    },
    levyReceipt: {
      headerTag: "Cuenta del socio",
      payment: {
        subject: "Recibo de pago — {levyName} ({orgName})",
        heading: "Pago recibido",
        intro: "Hola {memberName}, hemos registrado tu pago de <strong style=\"color:#fff;\">{levyName}</strong>. Tu saldo está liquidado.",
        amountLabel: "Importe pagado",
      },
      partialPayment: {
        subject: "Recibo de pago parcial — {levyName} ({orgName})",
        heading: "Pago parcial recibido",
        intro: "Hola {memberName}, hemos registrado un pago parcial para <strong style=\"color:#fff;\">{levyName}</strong>. Aún queda un saldo pendiente.",
        amountLabel: "Importe pagado",
      },
      refund: {
        subject: "Reembolso emitido — {levyName} ({orgName})",
        heading: "Reembolso emitido",
        intro: "Hola {memberName}, se ha emitido un reembolso por tu cargo de <strong style=\"color:#fff;\">{levyName}</strong>.",
        amountLabel: "Importe reembolsado",
      },
      waiver: {
        subject: "Cargo condonado — {levyName} ({orgName})",
        heading: "Cargo condonado",
        intro: "Hola {memberName}, tu cargo de <strong style=\"color:#fff;\">{levyName}</strong> ha sido condonado. No queda nada por pagar.",
        amountLabel: "Importe condonado",
      },
      levyLabel: "Cuota",
      newBalanceLabel: "Nuevo saldo",
      currencyLabel: "Moneda",
      noteLabel: "Nota",
      footer: "Puedes ver el historial completo de pagos en cualquier momento desde el portal del socio. Si algo no parece correcto, responde a este correo o contacta a {orgName} directamente.",
    },
    documentRejected: {
      headerTag: "Documentos",
      subject: "El documento requiere atención: {docLabel}",
      greeting: "Hola {memberName},",
      intro: "Tu documento subido \"{docLabel}\" fue revisado por el personal de {orgName} y no pudo ser aceptado.",
      reasonLabel: "Motivo",
      reupload: "Por favor, vuelve a subir una versión corregida desde el portal del socio lo antes posible.",
    },
    documentUnrejected: {
      headerTag: "Documentos",
      subject: "Rechazo retirado: {docLabel}",
      greeting: "Hola {memberName},",
      intro: "El personal de {orgName} ha retirado el rechazo previo de tu documento \"{docLabel}\". Vuelve a estar en la cola pendiente y se revisará de nuevo — no necesitas hacer nada.",
      noteLabel: "Nota del personal",
    },
    documentPending: {
      headerTag: "Documentos",
      pushTitle: "Nuevo documento pendiente de revisión",
      emailSubject: "Nuevo documento de socio pendiente de revisión",
      body: "{memberName} subió un nuevo documento de {docTypeLabel} (\"{docLabel}\") para su verificación.",
    },
    payoutNotify: {
      headerTag: "Pago al coach",
      subject: "Pago enviado — {amount} de {orgName}",
      heading: "✅ Pago enviado",
      greeting: "Hola {coachName}, tu último pago por análisis de swing de <strong style=\"color:#fff;\">{orgName}</strong> se ha marcado como pagado.",
      amountLabel: "Importe",
      referenceLabel: "Referencia",
      notesLabel: "Notas",
      eta: "Los fondos suelen aparecer en tu cuenta registrada en 1–2 días hábiles, según tu banco.",
      footer: "Puedes consultar el historial completo en cualquier momento desde la pestaña Ingresos (Earnings) de tu espacio de coach.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Cuenta de pago",
      subjectVerified: "Tu cuenta de pago se volvió a verificar — {orgName}",
      subjectNeedsAttention: "Acción necesaria — la nueva verificación del admin marcó tu {methodLabel} de pago",
      headingVerified: "Tu cuenta de pago se volvió a verificar",
      headingNeedsAttention: "Tu cuenta de pago necesita atención tras una nueva verificación",
      greeting: "Hola {coachName},",
      introVerified: "Un administrador de <strong style=\"color:#fff;\">{orgName}</strong> volvió a verificar manualmente la {methodLabel} registrada para tus pagos como coach. La verificación se completó correctamente y tus pagos continuarán con normalidad — no se requiere ninguna acción.",
      introNeedsAttention: "Un administrador de <strong style=\"color:#fff;\">{orgName}</strong> volvió a verificar manualmente la {methodLabel} registrada para tus pagos como coach. El banco indicó que ya no es válida, por lo que tu próximo pago quedará retenido hasta que vuelvas a guardar tus datos.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "cuenta bancaria",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Cuenta bancaria",
      reverifiedOnLabel: "Verificado de nuevo el",
      statusLabel: "Estado",
      statusValueVerified: "Verificada",
      statusValueNeedsAttention: "Necesita atención",
      reasonLabel: "Motivo",
      footer: "Si no esperabas que un administrador volviera a verificar tu cuenta, contacta al equipo de soporte de tu organización. También puedes volver a guardar tus datos de pago en tu espacio de coach en cualquier momento para iniciar una nueva validación tú mismo.",
    },
  },

  fr: {
    bouncedDigest: {
      headerTag: "Rappels de cotisations",
      subjectOne: "⚠️ 1 rappel de cotisation rejeté nécessite votre attention — {orgName}",
      subjectMany: "⚠️ {count} rappels de cotisation rejetés nécessitent votre attention — {orgName}",
      heading: "Rappels de cotisation rejetés — résumé quotidien",
      introOne: "Bonjour {staff}, 1 rappel de cotisation échoue encore parmi {leviesCount} définition de cotisation pour {orgName}. Chaque ligne renvoie au détail de la cotisation où vous pouvez réessayer les canaux concernés ou corriger les coordonnées.",
      introMany: "Bonjour {staff}, {count} rappels de cotisation échouent encore parmi {leviesCount} définitions de cotisation pour {orgName}. Chaque ligne renvoie au détail de la cotisation où vous pouvez réessayer les canaux concernés ou corriger les coordonnées.",
      levyHeader: "Cotisation",
      bouncedHeader: "Rejetés",
      latestFailureLabel: "Dernier échec",
      footer: "Ce résumé n'est envoyé que les jours avec des échecs non résolus. Vous le recevez car vous êtes administrateur d'organisation pour {orgName}.",
    },
    levyReceipt: {
      headerTag: "Compte du membre",
      payment: {
        subject: "Reçu de paiement — {levyName} ({orgName})",
        heading: "Paiement reçu",
        intro: "Bonjour {memberName}, nous avons enregistré votre paiement pour <strong style=\"color:#fff;\">{levyName}</strong>. Votre solde est désormais réglé.",
        amountLabel: "Montant payé",
      },
      partialPayment: {
        subject: "Reçu de paiement partiel — {levyName} ({orgName})",
        heading: "Paiement partiel reçu",
        intro: "Bonjour {memberName}, nous avons enregistré un paiement partiel pour <strong style=\"color:#fff;\">{levyName}</strong>. Un solde reste dû.",
        amountLabel: "Montant payé",
      },
      refund: {
        subject: "Remboursement émis — {levyName} ({orgName})",
        heading: "Remboursement émis",
        intro: "Bonjour {memberName}, un remboursement a été émis pour votre cotisation <strong style=\"color:#fff;\">{levyName}</strong>.",
        amountLabel: "Montant remboursé",
      },
      waiver: {
        subject: "Cotisation exonérée — {levyName} ({orgName})",
        heading: "Cotisation exonérée",
        intro: "Bonjour {memberName}, votre cotisation <strong style=\"color:#fff;\">{levyName}</strong> a été exonérée. Plus rien n'est dû.",
        amountLabel: "Montant exonéré",
      },
      levyLabel: "Cotisation",
      newBalanceLabel: "Nouveau solde",
      currencyLabel: "Devise",
      noteLabel: "Note",
      footer: "Vous pouvez consulter l'historique complet des paiements à tout moment depuis le portail du membre. Si quelque chose vous semble incorrect, répondez à cet email ou contactez {orgName} directement.",
    },
    documentRejected: {
      headerTag: "Documents",
      subject: "Document à corriger : {docLabel}",
      greeting: "Bonjour {memberName},",
      intro: "Votre document téléversé \"{docLabel}\" a été examiné par l'équipe de {orgName} et n'a pas pu être accepté.",
      reasonLabel: "Motif",
      reupload: "Veuillez téléverser une version corrigée depuis le portail du membre dès que possible.",
    },
    documentUnrejected: {
      headerTag: "Documents",
      subject: "Rejet annulé : {docLabel}",
      greeting: "Bonjour {memberName},",
      intro: "Le personnel de {orgName} a annulé le rejet précédent de votre document « {docLabel} ». Il est de nouveau dans la file d'attente et sera réexaminé — aucune action n'est requise de votre part.",
      noteLabel: "Note du personnel",
    },
    documentPending: {
      headerTag: "Documents",
      pushTitle: "Nouveau document en attente de vérification",
      emailSubject: "Nouveau document de membre en attente de vérification",
      body: "{memberName} a téléversé un nouveau document {docTypeLabel} (« {docLabel} ») pour vérification.",
    },
    payoutNotify: {
      headerTag: "Paiement coach",
      subject: "Paiement envoyé — {amount} de {orgName}",
      heading: "✅ Paiement envoyé",
      greeting: "Bonjour {coachName}, votre dernier paiement d'analyse de swing de <strong style=\"color:#fff;\">{orgName}</strong> a été marqué comme payé.",
      amountLabel: "Montant",
      referenceLabel: "Référence",
      notesLabel: "Notes",
      eta: "Les fonds apparaissent généralement sur votre compte enregistré sous 1–2 jours ouvrés, selon votre banque.",
      footer: "Vous pouvez consulter l'historique complet à tout moment depuis l'onglet Revenus (Earnings) de votre espace coach.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Compte de paiement",
      subjectVerified: "Votre compte de paiement a été revérifié — {orgName}",
      subjectNeedsAttention: "Action requise — la revérification de l'admin a signalé votre {methodLabel} de paiement",
      headingVerified: "Votre compte de paiement a été revérifié",
      headingNeedsAttention: "Votre compte de paiement nécessite une attention après une nouvelle vérification",
      greeting: "Bonjour {coachName},",
      introVerified: "Un administrateur de <strong style=\"color:#fff;\">{orgName}</strong> a manuellement revérifié le {methodLabel} enregistré pour vos paiements de coach. La vérification s'est terminée avec succès et vos paiements continueront normalement — aucune action requise.",
      introNeedsAttention: "Un administrateur de <strong style=\"color:#fff;\">{orgName}</strong> a manuellement revérifié le {methodLabel} enregistré pour vos paiements de coach. La banque a indiqué qu'il n'est plus valide ; votre prochain paiement sera donc mis en attente jusqu'à ce que vous réenregistriez vos coordonnées.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "compte bancaire",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Compte bancaire",
      reverifiedOnLabel: "Revérifié le",
      statusLabel: "Statut",
      statusValueVerified: "Vérifié",
      statusValueNeedsAttention: "Nécessite attention",
      reasonLabel: "Motif",
      footer: "Si vous ne vous attendiez pas à ce qu'un administrateur revérifie votre compte, contactez l'équipe d'assistance de votre organisation. Vous pouvez aussi à tout moment réenregistrer vos coordonnées de paiement dans votre espace coach pour déclencher une nouvelle validation vous-même.",
    },
  },

  de: {
    bouncedDigest: {
      headerTag: "Beitragserinnerungen",
      subjectOne: "⚠️ 1 zurückgewiesene Beitragserinnerung benötigt Aufmerksamkeit — {orgName}",
      subjectMany: "⚠️ {count} zurückgewiesene Beitragserinnerungen benötigen Aufmerksamkeit — {orgName}",
      heading: "Zurückgewiesene Beitragserinnerungen — tägliche Zusammenfassung",
      introOne: "Hallo {staff}, 1 Beitragserinnerung schlägt weiterhin fehl, verteilt auf {leviesCount} Beitragsdefinition für {orgName}. Jede Zeile verlinkt auf das Beitragsdetail, wo Sie betroffene Kanäle erneut versuchen oder Kontaktdaten korrigieren können.",
      introMany: "Hallo {staff}, {count} Beitragserinnerungen schlagen weiterhin fehl, verteilt auf {leviesCount} Beitragsdefinitionen für {orgName}. Jede Zeile verlinkt auf das Beitragsdetail, wo Sie betroffene Kanäle erneut versuchen oder Kontaktdaten korrigieren können.",
      levyHeader: "Beitrag",
      bouncedHeader: "Fehlgeschlagen",
      latestFailureLabel: "Letzter Fehlschlag",
      footer: "Diese Zusammenfassung wird nur an Tagen mit ungelösten Fehlern verschickt. Sie erhalten sie, weil Sie Organisations-Admin für {orgName} sind.",
    },
    levyReceipt: {
      headerTag: "Mitgliedskonto",
      payment: {
        subject: "Zahlungsbeleg — {levyName} ({orgName})",
        heading: "Zahlung erhalten",
        intro: "Hallo {memberName}, wir haben Ihre Zahlung für <strong style=\"color:#fff;\">{levyName}</strong> verbucht. Ihr Saldo ist jetzt ausgeglichen.",
        amountLabel: "Gezahlter Betrag",
      },
      partialPayment: {
        subject: "Beleg über Teilzahlung — {levyName} ({orgName})",
        heading: "Teilzahlung erhalten",
        intro: "Hallo {memberName}, wir haben eine Teilzahlung für <strong style=\"color:#fff;\">{levyName}</strong> verbucht. Es verbleibt ein offener Saldo.",
        amountLabel: "Gezahlter Betrag",
      },
      refund: {
        subject: "Rückerstattung ausgestellt — {levyName} ({orgName})",
        heading: "Rückerstattung ausgestellt",
        intro: "Hallo {memberName}, für Ihre Belastung <strong style=\"color:#fff;\">{levyName}</strong> wurde eine Rückerstattung ausgestellt.",
        amountLabel: "Erstatteter Betrag",
      },
      waiver: {
        subject: "Belastung erlassen — {levyName} ({orgName})",
        heading: "Belastung erlassen",
        intro: "Hallo {memberName}, Ihre Belastung <strong style=\"color:#fff;\">{levyName}</strong> wurde erlassen. Es ist nichts weiter offen.",
        amountLabel: "Erlassener Betrag",
      },
      levyLabel: "Beitrag",
      newBalanceLabel: "Neuer Saldo",
      currencyLabel: "Währung",
      noteLabel: "Hinweis",
      footer: "Sie können Ihren vollständigen Zahlungsverlauf jederzeit im Mitgliederportal einsehen. Wenn etwas nicht stimmt, antworten Sie auf diese E-Mail oder kontaktieren Sie {orgName} direkt.",
    },
    documentRejected: {
      headerTag: "Dokumente",
      subject: "Dokument benötigt Aufmerksamkeit: {docLabel}",
      greeting: "Hallo {memberName},",
      intro: "Ihr hochgeladenes Dokument \"{docLabel}\" wurde vom Team von {orgName} geprüft und konnte nicht akzeptiert werden.",
      reasonLabel: "Grund",
      reupload: "Bitte laden Sie baldmöglichst eine korrigierte Version über das Mitgliederportal erneut hoch.",
    },
    documentUnrejected: {
      headerTag: "Dokumente",
      subject: "Ablehnung zurückgenommen: {docLabel}",
      greeting: "Hallo {memberName},",
      intro: "Die Mitarbeitenden von {orgName} haben die vorherige Ablehnung Ihres Dokuments „{docLabel}\" zurückgenommen. Es befindet sich wieder in der Prüfwarteschlange und wird erneut geprüft — Sie müssen nichts unternehmen.",
      noteLabel: "Hinweis vom Team",
    },
    documentPending: {
      headerTag: "Dokumente",
      pushTitle: "Neues Dokument zur Prüfung",
      emailSubject: "Neues Mitgliedsdokument zur Prüfung",
      body: "{memberName} hat ein neues {docTypeLabel}-Dokument („{docLabel}\") zur Überprüfung hochgeladen.",
    },
    payoutNotify: {
      headerTag: "Coach-Auszahlung",
      subject: "Auszahlung gesendet — {amount} von {orgName}",
      heading: "✅ Auszahlung gesendet",
      greeting: "Hallo {coachName}, Ihre letzte Swing-Review-Auszahlung von <strong style=\"color:#fff;\">{orgName}</strong> wurde als bezahlt markiert.",
      amountLabel: "Betrag",
      referenceLabel: "Referenz",
      notesLabel: "Notizen",
      eta: "Die Mittel erscheinen üblicherweise innerhalb von 1–2 Werktagen auf Ihrem hinterlegten Konto, je nach Bank.",
      footer: "Sie können den vollständigen Auszahlungsverlauf jederzeit im Einnahmen-Tab (Earnings) Ihres Coach-Workspace einsehen.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Auszahlungskonto",
      subjectVerified: "Ihr Auszahlungskonto wurde erneut verifiziert — {orgName}",
      subjectNeedsAttention: "Aktion erforderlich — die Admin-Neuprüfung hat Ihr Auszahlungs-{methodLabel} markiert",
      headingVerified: "Ihr Auszahlungskonto wurde erneut verifiziert",
      headingNeedsAttention: "Ihr Auszahlungskonto benötigt nach einer Neuprüfung Aufmerksamkeit",
      greeting: "Hallo {coachName},",
      introVerified: "Ein Administrator von <strong style=\"color:#fff;\">{orgName}</strong> hat das hinterlegte {methodLabel} für Ihre Coach-Auszahlungen manuell erneut verifiziert. Die Prüfung war erfolgreich und Ihre Auszahlungen werden wie gewohnt fortgesetzt — keine Aktion erforderlich.",
      introNeedsAttention: "Ein Administrator von <strong style=\"color:#fff;\">{orgName}</strong> hat das hinterlegte {methodLabel} für Ihre Coach-Auszahlungen manuell erneut verifiziert. Die Bank meldete es als nicht mehr gültig, daher wird Ihre nächste Auszahlung pausiert, bis Sie Ihre Daten erneut speichern.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "Bankkonto",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Bankkonto",
      reverifiedOnLabel: "Erneut verifiziert am",
      statusLabel: "Status",
      statusValueVerified: "Verifiziert",
      statusValueNeedsAttention: "Benötigt Aufmerksamkeit",
      reasonLabel: "Grund",
      footer: "Falls Sie nicht erwartet haben, dass ein Administrator Ihr Konto erneut prüft, wenden Sie sich an das Support-Team Ihrer Organisation. Sie können Ihre Auszahlungsdaten auch jederzeit in Ihrem Coach-Workspace erneut speichern, um selbst eine neue Validierung auszulösen.",
    },
  },

  pt: {
    bouncedDigest: {
      headerTag: "Lembretes de taxas",
      subjectOne: "⚠️ 1 lembrete de taxa rejeitado precisa de atenção — {orgName}",
      subjectMany: "⚠️ {count} lembretes de taxa rejeitados precisam de atenção — {orgName}",
      heading: "Lembretes de taxa rejeitados — resumo diário",
      introOne: "Olá {staff}, 1 lembrete de taxa ainda está falhando em {leviesCount} definição de taxa para {orgName}. Cada linha abaixo leva ao detalhe da taxa, onde você pode tentar novamente os canais afetados ou corrigir os dados de contato.",
      introMany: "Olá {staff}, {count} lembretes de taxa ainda estão falhando em {leviesCount} definições de taxa para {orgName}. Cada linha abaixo leva ao detalhe da taxa, onde você pode tentar novamente os canais afetados ou corrigir os dados de contato.",
      levyHeader: "Taxa",
      bouncedHeader: "Rejeitados",
      latestFailureLabel: "Última falha",
      footer: "Este resumo só é enviado em dias com falhas não resolvidas. Você o recebe porque é administrador da organização em {orgName}.",
    },
    levyReceipt: {
      headerTag: "Conta do membro",
      payment: {
        subject: "Recibo de pagamento — {levyName} ({orgName})",
        heading: "Pagamento recebido",
        intro: "Olá {memberName}, registramos o seu pagamento de <strong style=\"color:#fff;\">{levyName}</strong>. Seu saldo está quitado.",
        amountLabel: "Valor pago",
      },
      partialPayment: {
        subject: "Recibo de pagamento parcial — {levyName} ({orgName})",
        heading: "Pagamento parcial recebido",
        intro: "Olá {memberName}, registramos um pagamento parcial em <strong style=\"color:#fff;\">{levyName}</strong>. Ainda há saldo a pagar.",
        amountLabel: "Valor pago",
      },
      refund: {
        subject: "Reembolso emitido — {levyName} ({orgName})",
        heading: "Reembolso emitido",
        intro: "Olá {memberName}, foi emitido um reembolso referente à sua cobrança de <strong style=\"color:#fff;\">{levyName}</strong>.",
        amountLabel: "Valor reembolsado",
      },
      waiver: {
        subject: "Cobrança dispensada — {levyName} ({orgName})",
        heading: "Cobrança dispensada",
        intro: "Olá {memberName}, a sua cobrança de <strong style=\"color:#fff;\">{levyName}</strong> foi dispensada. Nada mais é devido.",
        amountLabel: "Valor dispensado",
      },
      levyLabel: "Taxa",
      newBalanceLabel: "Novo saldo",
      currencyLabel: "Moeda",
      noteLabel: "Nota",
      footer: "Você pode ver o histórico completo de pagamentos a qualquer momento no portal do membro. Se algo parecer incorreto, responda a este e-mail ou contate {orgName} diretamente.",
    },
    documentRejected: {
      headerTag: "Documentos",
      subject: "Documento requer atenção: {docLabel}",
      greeting: "Olá {memberName},",
      intro: "Seu documento enviado \"{docLabel}\" foi analisado pela equipe de {orgName} e não pôde ser aceito.",
      reasonLabel: "Motivo",
      reupload: "Por favor, envie novamente uma versão corrigida pelo portal do membro o quanto antes.",
    },
    documentUnrejected: {
      headerTag: "Documentos",
      subject: "Rejeição retirada: {docLabel}",
      greeting: "Olá {memberName},",
      intro: "A equipe de {orgName} retirou a rejeição anterior do seu documento \"{docLabel}\". Ele voltou à fila pendente e será revisado novamente — nenhuma ação é necessária da sua parte.",
      noteLabel: "Observação da equipe",
    },
    documentPending: {
      headerTag: "Documentos",
      pushTitle: "Novo documento aguardando revisão",
      emailSubject: "Novo documento de sócio aguardando revisão",
      body: "{memberName} enviou um novo documento de {docTypeLabel} (\"{docLabel}\") para verificação.",
    },
    payoutNotify: {
      headerTag: "Pagamento ao coach",
      subject: "Pagamento enviado — {amount} de {orgName}",
      heading: "✅ Pagamento enviado",
      greeting: "Olá {coachName}, seu último pagamento de análise de swing de <strong style=\"color:#fff;\">{orgName}</strong> foi marcado como pago.",
      amountLabel: "Valor",
      referenceLabel: "Referência",
      notesLabel: "Notas",
      eta: "Os fundos costumam aparecer na sua conta cadastrada em 1–2 dias úteis, dependendo do banco.",
      footer: "Você pode rever o histórico completo de pagamentos a qualquer momento na aba Ganhos (Earnings) do seu espaço de coach.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Conta de pagamento",
      subjectVerified: "Sua conta de pagamento foi reverificada — {orgName}",
      subjectNeedsAttention: "Ação necessária — a reverificação do admin sinalizou sua {methodLabel} de pagamento",
      headingVerified: "Sua conta de pagamento foi reverificada",
      headingNeedsAttention: "Sua conta de pagamento precisa de atenção após uma reverificação",
      greeting: "Olá {coachName},",
      introVerified: "Um administrador de <strong style=\"color:#fff;\">{orgName}</strong> reverificou manualmente a {methodLabel} cadastrada para seus pagamentos como coach. A verificação foi concluída com sucesso e seus pagamentos continuarão normalmente — nenhuma ação é necessária.",
      introNeedsAttention: "Um administrador de <strong style=\"color:#fff;\">{orgName}</strong> reverificou manualmente a {methodLabel} cadastrada para seus pagamentos como coach. O banco informou que ela não é mais válida; portanto, seu próximo pagamento ficará retido até você salvar seus dados novamente.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "conta bancária",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Conta bancária",
      reverifiedOnLabel: "Reverificada em",
      statusLabel: "Status",
      statusValueVerified: "Verificada",
      statusValueNeedsAttention: "Precisa de atenção",
      reasonLabel: "Motivo",
      footer: "Se você não esperava que um administrador reverificasse sua conta, entre em contato com o suporte da sua organização. Você também pode salvar novamente seus dados de pagamento no seu espaço de coach a qualquer momento para iniciar uma nova validação.",
    },
  },

  ja: {
    bouncedDigest: {
      headerTag: "賦課金リマインダー",
      subjectOne: "⚠️ 1 件の不達リマインダーに対応が必要です — {orgName}",
      subjectMany: "⚠️ {count} 件の不達リマインダーに対応が必要です — {orgName}",
      heading: "不達となった賦課金リマインダー — デイリーダイジェスト",
      introOne: "{staff} さん、{orgName} の {leviesCount} 件の賦課金定義のうち 1 件のリマインダーがまだ失敗しています。下の各行は賦課金詳細にリンクしており、影響を受けたチャネルを再試行したり連絡先情報を修正したりできます。",
      introMany: "{staff} さん、{orgName} の {leviesCount} 件の賦課金定義にまたがって {count} 件のリマインダーがまだ失敗しています。下の各行は賦課金詳細にリンクしており、影響を受けたチャネルを再試行したり連絡先情報を修正したりできます。",
      levyHeader: "賦課金",
      bouncedHeader: "不達",
      latestFailureLabel: "直近の失敗",
      footer: "このダイジェストは未解決の失敗がある日にのみ送信されます。あなたは {orgName} の組織管理者として登録されているため受信しています。",
    },
    levyReceipt: {
      headerTag: "メンバーアカウント",
      payment: {
        subject: "お支払い受領証 — {levyName} ({orgName})",
        heading: "お支払いを受領しました",
        intro: "{memberName} さん、<strong style=\"color:#fff;\">{levyName}</strong> のお支払いを記録しました。残高は精算済みです。",
        amountLabel: "お支払い額",
      },
      partialPayment: {
        subject: "一部支払いの受領証 — {levyName} ({orgName})",
        heading: "一部支払いを受領しました",
        intro: "{memberName} さん、<strong style=\"color:#fff;\">{levyName}</strong> に対する一部支払いを記録しました。残額がまだ残っています。",
        amountLabel: "お支払い額",
      },
      refund: {
        subject: "返金処理 — {levyName} ({orgName})",
        heading: "返金が完了しました",
        intro: "{memberName} さん、<strong style=\"color:#fff;\">{levyName}</strong> の請求に対して返金が行われました。",
        amountLabel: "返金額",
      },
      waiver: {
        subject: "請求免除 — {levyName} ({orgName})",
        heading: "請求が免除されました",
        intro: "{memberName} さん、<strong style=\"color:#fff;\">{levyName}</strong> の請求は免除されました。これ以上のお支払いはありません。",
        amountLabel: "免除額",
      },
      levyLabel: "賦課金",
      newBalanceLabel: "新しい残高",
      currencyLabel: "通貨",
      noteLabel: "備考",
      footer: "メンバーポータルからいつでも全支払履歴を確認できます。内容に誤りがある場合は、本メールに返信するか {orgName} へ直接ご連絡ください。",
    },
    documentRejected: {
      headerTag: "書類",
      subject: "書類に対応が必要です: {docLabel}",
      greeting: "{memberName} さん、",
      intro: "アップロードされた書類「{docLabel}」を {orgName} のスタッフが確認しましたが、受理できませんでした。",
      reasonLabel: "理由",
      reupload: "お早めにメンバーポータルから修正版を再アップロードしてください。",
    },
    documentUnrejected: {
      headerTag: "ドキュメント",
      subject: "却下を取り消しました: {docLabel}",
      greeting: "{memberName} 様、",
      intro: "{orgName} のスタッフがあなたの書類「{docLabel}」の以前の却下を取り消しました。再びレビュー待ちのキューに入っており、再度確認されます — お客様側でのご対応は不要です。",
      noteLabel: "スタッフからのメモ",
    },
    documentPending: {
      headerTag: "書類",
      pushTitle: "確認待ちの新しい書類",
      emailSubject: "確認待ちの新しいメンバー書類",
      body: "{memberName} さんが確認のために新しい {docTypeLabel} の書類「{docLabel}」をアップロードしました。",
    },
    payoutNotify: {
      headerTag: "コーチ報酬",
      subject: "報酬を送金しました — {orgName} から {amount}",
      heading: "✅ 報酬を送金しました",
      greeting: "{coachName} さん、<strong style=\"color:#fff;\">{orgName}</strong> からの最新のスイングレビュー報酬が支払い済みとして記録されました。",
      amountLabel: "金額",
      referenceLabel: "参照番号",
      notesLabel: "備考",
      eta: "資金は通常、ご利用の銀行に応じて 1～2 営業日以内に登録口座に反映されます。",
      footer: "コーチワークスペースの「報酬（Earnings）」タブからいつでも全報酬履歴を確認できます。",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "支払口座",
      subjectVerified: "支払口座が再認証されました — {orgName}",
      subjectNeedsAttention: "対応が必要です — 管理者の再確認により支払用 {methodLabel} に問題が見つかりました",
      headingVerified: "支払口座が再認証されました",
      headingNeedsAttention: "再確認の結果、支払口座の対応が必要です",
      greeting: "{coachName} さん、",
      introVerified: "<strong style=\"color:#fff;\">{orgName}</strong> の管理者がコーチ報酬用に登録されている {methodLabel} を手動で再認証しました。確認は問題なく完了し、報酬は通常どおり継続されます — 対応は不要です。",
      introNeedsAttention: "<strong style=\"color:#fff;\">{orgName}</strong> の管理者がコーチ報酬用に登録されている {methodLabel} を手動で再認証しました。銀行から有効でないと報告されたため、口座情報を再保存いただくまで次回の報酬は保留されます。",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "銀行口座",
      upiRowLabel: "UPI ID",
      bankRowLabel: "銀行口座",
      reverifiedOnLabel: "再認証日",
      statusLabel: "ステータス",
      statusValueVerified: "認証済み",
      statusValueNeedsAttention: "対応が必要",
      reasonLabel: "理由",
      footer: "管理者による口座の再確認に心当たりがない場合は、組織のサポート担当までお問い合わせください。コーチワークスペースで支払情報をいつでも再保存していただくと、ご自身で新しい認証を実行できます。",
    },
  },

  ko: {
    bouncedDigest: {
      headerTag: "회비 알림",
      subjectOne: "⚠️ 반송된 회비 알림 1건이 확인이 필요합니다 — {orgName}",
      subjectMany: "⚠️ 반송된 회비 알림 {count}건이 확인이 필요합니다 — {orgName}",
      heading: "반송된 회비 알림 — 일일 요약",
      introOne: "{staff}님, {orgName}의 {leviesCount}개 회비 정의에서 회비 알림 1건이 여전히 실패하고 있습니다. 아래 각 행은 회비 상세 페이지로 연결되며, 영향받은 채널을 재시도하거나 연락처 정보를 수정할 수 있습니다.",
      introMany: "{staff}님, {orgName}의 {leviesCount}개 회비 정의에서 회비 알림 {count}건이 여전히 실패하고 있습니다. 아래 각 행은 회비 상세 페이지로 연결되며, 영향받은 채널을 재시도하거나 연락처 정보를 수정할 수 있습니다.",
      levyHeader: "회비",
      bouncedHeader: "반송",
      latestFailureLabel: "최근 실패",
      footer: "이 요약은 미해결 실패가 있는 날에만 발송됩니다. {orgName}의 조직 관리자로 등록되어 있어 수신하셨습니다.",
    },
    levyReceipt: {
      headerTag: "회원 계정",
      payment: {
        subject: "결제 영수증 — {levyName} ({orgName})",
        heading: "결제가 접수되었습니다",
        intro: "{memberName}님, <strong style=\"color:#fff;\">{levyName}</strong> 결제를 기록했습니다. 잔액은 모두 정산되었습니다.",
        amountLabel: "결제 금액",
      },
      partialPayment: {
        subject: "부분 결제 영수증 — {levyName} ({orgName})",
        heading: "부분 결제가 접수되었습니다",
        intro: "{memberName}님, <strong style=\"color:#fff;\">{levyName}</strong>에 대한 부분 결제를 기록했습니다. 미결 잔액이 남아 있습니다.",
        amountLabel: "결제 금액",
      },
      refund: {
        subject: "환불 발행 — {levyName} ({orgName})",
        heading: "환불이 발행되었습니다",
        intro: "{memberName}님, <strong style=\"color:#fff;\">{levyName}</strong> 청구에 대해 환불이 발행되었습니다.",
        amountLabel: "환불 금액",
      },
      waiver: {
        subject: "청구 면제 — {levyName} ({orgName})",
        heading: "청구가 면제되었습니다",
        intro: "{memberName}님, <strong style=\"color:#fff;\">{levyName}</strong> 청구가 면제되었습니다. 추가로 납부할 금액은 없습니다.",
        amountLabel: "면제 금액",
      },
      levyLabel: "회비",
      newBalanceLabel: "새 잔액",
      currencyLabel: "통화",
      noteLabel: "메모",
      footer: "회원 포털에서 언제든지 전체 결제 내역을 확인할 수 있습니다. 잘못된 내용이 있다면 이 메일에 회신하시거나 {orgName}에 직접 문의해 주세요.",
    },
    documentRejected: {
      headerTag: "문서",
      subject: "문서 확인이 필요합니다: {docLabel}",
      greeting: "{memberName}님,",
      intro: "업로드하신 문서 \"{docLabel}\"를 {orgName} 직원이 검토했으나 승인할 수 없었습니다.",
      reasonLabel: "사유",
      reupload: "가능한 한 빨리 회원 포털에서 수정된 버전을 다시 업로드해 주세요.",
    },
    documentUnrejected: {
      headerTag: "문서",
      subject: "거부 철회됨: {docLabel}",
      greeting: "안녕하세요 {memberName} 님,",
      intro: "{orgName} 스태프가 회원님의 문서 \"{docLabel}\"에 대한 이전 거부를 철회했습니다. 해당 문서는 다시 검토 대기열로 돌아갔으며 다시 검토될 예정입니다 — 별도의 조치는 필요 없습니다.",
      noteLabel: "스태프 메모",
    },
    documentPending: {
      headerTag: "문서",
      pushTitle: "검토 대기 중인 새 문서",
      emailSubject: "검토 대기 중인 새 회원 문서",
      body: "{memberName}님이 확인을 위해 새 {docTypeLabel} 문서 \"{docLabel}\"을(를) 업로드했습니다.",
    },
    payoutNotify: {
      headerTag: "코치 정산",
      subject: "정산 송금 — {orgName}에서 {amount}",
      heading: "✅ 정산 송금 완료",
      greeting: "{coachName}님, <strong style=\"color:#fff;\">{orgName}</strong>의 최근 스윙 리뷰 정산이 지급 완료로 표시되었습니다.",
      amountLabel: "금액",
      referenceLabel: "참조",
      notesLabel: "메모",
      eta: "자금은 거래 은행에 따라 보통 1–2 영업일 이내에 등록된 계좌에 입금됩니다.",
      footer: "코치 워크스페이스의 수익(Earnings) 탭에서 언제든지 전체 정산 내역을 확인할 수 있습니다.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "정산 계좌",
      subjectVerified: "정산 계좌가 재인증되었습니다 — {orgName}",
      subjectNeedsAttention: "조치가 필요합니다 — 관리자 재확인에서 정산 {methodLabel}에 문제가 발견되었습니다",
      headingVerified: "정산 계좌가 재인증되었습니다",
      headingNeedsAttention: "재확인 후 정산 계좌에 조치가 필요합니다",
      greeting: "{coachName}님,",
      introVerified: "<strong style=\"color:#fff;\">{orgName}</strong>의 관리자가 코치 정산을 위해 등록된 {methodLabel}을(를) 수동으로 재인증했습니다. 확인이 정상적으로 완료되어 정산은 계속 진행됩니다 — 별도 조치는 필요하지 않습니다.",
      introNeedsAttention: "<strong style=\"color:#fff;\">{orgName}</strong>의 관리자가 코치 정산을 위해 등록된 {methodLabel}을(를) 수동으로 재인증했습니다. 은행에서 더 이상 유효하지 않다고 보고되어, 정보를 다시 저장하실 때까지 다음 정산은 보류됩니다.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "은행 계좌",
      upiRowLabel: "UPI ID",
      bankRowLabel: "은행 계좌",
      reverifiedOnLabel: "재인증 일시",
      statusLabel: "상태",
      statusValueVerified: "인증됨",
      statusValueNeedsAttention: "조치 필요",
      reasonLabel: "사유",
      footer: "관리자가 계좌를 재확인할 것이라고 예상하지 못하셨다면 조직의 지원팀에 문의하세요. 코치 워크스페이스에서 정산 정보를 다시 저장하시면 언제든지 직접 새 인증을 진행할 수 있습니다.",
    },
  },

  zh: {
    bouncedDigest: {
      headerTag: "费用提醒",
      subjectOne: "⚠️ 1 条退回的费用提醒需要处理 — {orgName}",
      subjectMany: "⚠️ {count} 条退回的费用提醒需要处理 — {orgName}",
      heading: "退回的费用提醒 — 每日摘要",
      introOne: "{staff} 您好，{orgName} 的 {leviesCount} 个费用定义中仍有 1 条费用提醒发送失败。下方每一行均链接到该费用详情，您可以在那里重试受影响的渠道或修正联系方式。",
      introMany: "{staff} 您好，{orgName} 的 {leviesCount} 个费用定义中仍有 {count} 条费用提醒发送失败。下方每一行均链接到该费用详情，您可以在那里重试受影响的渠道或修正联系方式。",
      levyHeader: "费用",
      bouncedHeader: "退回",
      latestFailureLabel: "最近一次失败",
      footer: "本摘要仅在仍有未解决失败的日期发送。您收到此邮件是因为您是 {orgName} 的机构管理员。",
    },
    levyReceipt: {
      headerTag: "会员账户",
      payment: {
        subject: "付款收据 — {levyName} ({orgName})",
        heading: "已收到付款",
        intro: "{memberName} 您好，我们已记录您对 <strong style=\"color:#fff;\">{levyName}</strong> 的付款。账户余额已结清。",
        amountLabel: "付款金额",
      },
      partialPayment: {
        subject: "部分付款收据 — {levyName} ({orgName})",
        heading: "已收到部分付款",
        intro: "{memberName} 您好，我们已记录您针对 <strong style=\"color:#fff;\">{levyName}</strong> 的部分付款。仍有余额未付清。",
        amountLabel: "付款金额",
      },
      refund: {
        subject: "已退款 — {levyName} ({orgName})",
        heading: "已发起退款",
        intro: "{memberName} 您好，针对您的 <strong style=\"color:#fff;\">{levyName}</strong> 收费已发起退款。",
        amountLabel: "退款金额",
      },
      waiver: {
        subject: "费用减免 — {levyName} ({orgName})",
        heading: "费用已减免",
        intro: "{memberName} 您好，您的 <strong style=\"color:#fff;\">{levyName}</strong> 收费已被减免，无需再付。",
        amountLabel: "减免金额",
      },
      levyLabel: "费用",
      newBalanceLabel: "新余额",
      currencyLabel: "币种",
      noteLabel: "备注",
      footer: "您可随时在会员门户查看完整付款记录。如发现任何不符之处，请回复此邮件或直接联系 {orgName}。",
    },
    documentRejected: {
      headerTag: "文件",
      subject: "文件需要处理：{docLabel}",
      greeting: "{memberName} 您好，",
      intro: "您上传的文件 “{docLabel}” 经 {orgName} 员工审核后未能被接受。",
      reasonLabel: "原因",
      reupload: "请尽快从会员门户重新上传修正后的版本。",
    },
    documentUnrejected: {
      headerTag: "文件",
      subject: "已撤回拒绝:{docLabel}",
      greeting: "{memberName} 您好,",
      intro: "{orgName} 工作人员已撤回对您的文件“{docLabel}”的先前拒绝。该文件已重新进入待审核队列,将再次进行审核——您无需采取任何操作。",
      noteLabel: "工作人员备注",
    },
    documentPending: {
      headerTag: "文件",
      pushTitle: "待审核的新文件",
      emailSubject: "待审核的新会员文件",
      body: "{memberName} 上传了一份新的 {docTypeLabel} 文件 “{docLabel}”，等待审核。",
    },
    payoutNotify: {
      headerTag: "教练结算",
      subject: "结算已支付 — 来自 {orgName} 的 {amount}",
      heading: "✅ 结算已支付",
      greeting: "{coachName} 您好，您来自 <strong style=\"color:#fff;\">{orgName}</strong> 的最新挥杆点评结算已标记为已支付。",
      amountLabel: "金额",
      referenceLabel: "参考号",
      notesLabel: "备注",
      eta: "资金通常会在 1–2 个工作日内入账至您的注册账户，具体到账时间以您的银行为准。",
      footer: "您可随时在教练工作区的「收益（Earnings）」标签页中查看完整结算记录。",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "结算账户",
      subjectVerified: "您的结算账户已重新验证 — {orgName}",
      subjectNeedsAttention: "需要处理 — 管理员重新核查发现您的结算{methodLabel}存在问题",
      headingVerified: "您的结算账户已重新验证",
      headingNeedsAttention: "重新核查后,您的结算账户需要处理",
      greeting: "{coachName} 您好,",
      introVerified: "<strong style=\"color:#fff;\">{orgName}</strong> 的管理员已手动重新核验您教练结算所登记的{methodLabel}。核验已成功完成,您的结算将照常进行 — 无需任何操作。",
      introNeedsAttention: "<strong style=\"color:#fff;\">{orgName}</strong> 的管理员已手动重新核验您教练结算所登记的{methodLabel}。银行报告其已不再有效,因此在您重新保存账户信息之前,下一笔结算将被暂存。",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "银行账户",
      upiRowLabel: "UPI ID",
      bankRowLabel: "银行账户",
      reverifiedOnLabel: "重新验证时间",
      statusLabel: "状态",
      statusValueVerified: "已验证",
      statusValueNeedsAttention: "需要处理",
      reasonLabel: "原因",
      footer: "如果您没有预料到管理员会重新核查您的账户,请联系您所在组织的支持团队。您也可以随时在教练工作区中重新保存结算信息,自行触发新的验证。",
    },
  },

  th: {
    bouncedDigest: {
      headerTag: "การแจ้งเตือนค่าธรรมเนียม",
      subjectOne: "⚠️ มีการแจ้งเตือนค่าธรรมเนียมที่ตีกลับ 1 รายการต้องดำเนินการ — {orgName}",
      subjectMany: "⚠️ มีการแจ้งเตือนค่าธรรมเนียมที่ตีกลับ {count} รายการต้องดำเนินการ — {orgName}",
      heading: "การแจ้งเตือนค่าธรรมเนียมที่ตีกลับ — สรุปประจำวัน",
      introOne: "สวัสดี {staff} ยังมีการแจ้งเตือนค่าธรรมเนียม 1 รายการที่ส่งล้มเหลวจาก {leviesCount} คำจำกัดความค่าธรรมเนียมของ {orgName} แต่ละแถวด้านล่างเชื่อมไปยังรายละเอียดค่าธรรมเนียมที่คุณสามารถลองส่งช่องทางที่ได้รับผลกระทบใหม่หรือแก้ไขข้อมูลติดต่อได้",
      introMany: "สวัสดี {staff} ยังมีการแจ้งเตือนค่าธรรมเนียม {count} รายการที่ส่งล้มเหลวจาก {leviesCount} คำจำกัดความค่าธรรมเนียมของ {orgName} แต่ละแถวด้านล่างเชื่อมไปยังรายละเอียดค่าธรรมเนียมที่คุณสามารถลองส่งช่องทางที่ได้รับผลกระทบใหม่หรือแก้ไขข้อมูลติดต่อได้",
      levyHeader: "ค่าธรรมเนียม",
      bouncedHeader: "ตีกลับ",
      latestFailureLabel: "ล้มเหลวล่าสุด",
      footer: "สรุปนี้จะถูกส่งเฉพาะในวันที่มีความล้มเหลวที่ยังไม่ได้แก้ไข คุณได้รับเพราะคุณเป็นผู้ดูแลองค์กรของ {orgName}",
    },
    levyReceipt: {
      headerTag: "บัญชีสมาชิก",
      payment: {
        subject: "ใบเสร็จการชำระเงิน — {levyName} ({orgName})",
        heading: "ได้รับการชำระเงินแล้ว",
        intro: "สวัสดี {memberName} เราได้บันทึกการชำระเงินของคุณสำหรับ <strong style=\"color:#fff;\">{levyName}</strong> เรียบร้อยแล้ว ยอดของคุณได้รับการชำระครบถ้วนแล้ว",
        amountLabel: "จำนวนที่ชำระ",
      },
      partialPayment: {
        subject: "ใบเสร็จการชำระบางส่วน — {levyName} ({orgName})",
        heading: "ได้รับการชำระบางส่วนแล้ว",
        intro: "สวัสดี {memberName} เราได้บันทึกการชำระบางส่วนสำหรับ <strong style=\"color:#fff;\">{levyName}</strong> ยังมียอดคงค้างเหลืออยู่",
        amountLabel: "จำนวนที่ชำระ",
      },
      refund: {
        subject: "คืนเงินแล้ว — {levyName} ({orgName})",
        heading: "คืนเงินแล้ว",
        intro: "สวัสดี {memberName} ได้มีการคืนเงินสำหรับการเรียกเก็บ <strong style=\"color:#fff;\">{levyName}</strong> ของคุณ",
        amountLabel: "จำนวนที่คืน",
      },
      waiver: {
        subject: "ยกเว้นการเรียกเก็บ — {levyName} ({orgName})",
        heading: "ยกเว้นการเรียกเก็บแล้ว",
        intro: "สวัสดี {memberName} การเรียกเก็บ <strong style=\"color:#fff;\">{levyName}</strong> ของคุณถูกยกเว้นแล้ว ไม่มียอดค้างต้องชำระอีก",
        amountLabel: "จำนวนที่ยกเว้น",
      },
      levyLabel: "ค่าธรรมเนียม",
      newBalanceLabel: "ยอดคงเหลือใหม่",
      currencyLabel: "สกุลเงิน",
      noteLabel: "หมายเหตุ",
      footer: "คุณสามารถดูประวัติการชำระเงินทั้งหมดได้ตลอดเวลาจากพอร์ทัลสมาชิก หากพบสิ่งใดไม่ถูกต้อง กรุณาตอบกลับอีเมลนี้หรือติดต่อ {orgName} โดยตรง",
    },
    documentRejected: {
      headerTag: "เอกสาร",
      subject: "เอกสารต้องดำเนินการ: {docLabel}",
      greeting: "สวัสดี {memberName}",
      intro: "เอกสาร \"{docLabel}\" ที่คุณอัปโหลดได้รับการตรวจสอบโดยทีมงาน {orgName} แล้วและไม่สามารถยอมรับได้",
      reasonLabel: "เหตุผล",
      reupload: "กรุณาอัปโหลดเวอร์ชันที่แก้ไขแล้วใหม่จากพอร์ทัลสมาชิกโดยเร็วที่สุด",
    },
    documentUnrejected: {
      headerTag: "เอกสาร",
      subject: "ถอนการปฏิเสธ: {docLabel}",
      greeting: "สวัสดี {memberName},",
      intro: "ทีมงานของ {orgName} ได้ถอนการปฏิเสธเอกสาร \"{docLabel}\" ของคุณก่อนหน้านี้ เอกสารกลับเข้าสู่คิวรอการตรวจสอบและจะได้รับการตรวจสอบอีกครั้ง — คุณไม่ต้องดำเนินการใดๆ",
      noteLabel: "หมายเหตุจากทีมงาน",
    },
    documentPending: {
      headerTag: "เอกสาร",
      pushTitle: "เอกสารใหม่รอการตรวจสอบ",
      emailSubject: "เอกสารสมาชิกใหม่รอการตรวจสอบ",
      body: "{memberName} อัปโหลดเอกสาร {docTypeLabel} ใหม่ (\"{docLabel}\") เพื่อรอการตรวจสอบ",
    },
    payoutNotify: {
      headerTag: "การจ่ายเงินโค้ช",
      subject: "ส่งการจ่ายเงินแล้ว — {amount} จาก {orgName}",
      heading: "✅ ส่งการจ่ายเงินแล้ว",
      greeting: "สวัสดี {coachName} การจ่ายเงินรีวิวสวิงล่าสุดของคุณจาก <strong style=\"color:#fff;\">{orgName}</strong> ได้ถูกทำเครื่องหมายว่าจ่ายแล้ว",
      amountLabel: "จำนวน",
      referenceLabel: "อ้างอิง",
      notesLabel: "หมายเหตุ",
      eta: "เงินมักจะปรากฏในบัญชีที่ลงทะเบียนภายใน 1–2 วันทำการ ขึ้นอยู่กับธนาคารของคุณ",
      footer: "คุณสามารถดูประวัติการจ่ายเงินทั้งหมดได้ตลอดเวลาจากแท็บ รายได้ (Earnings) ในพื้นที่ทำงานของโค้ช",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "บัญชีรับเงิน",
      subjectVerified: "บัญชีรับเงินของคุณได้รับการยืนยันอีกครั้ง — {orgName}",
      subjectNeedsAttention: "ต้องดำเนินการ — การตรวจสอบซ้ำของผู้ดูแลพบปัญหาที่ {methodLabel} สำหรับการจ่ายเงินของคุณ",
      headingVerified: "บัญชีรับเงินของคุณได้รับการยืนยันอีกครั้ง",
      headingNeedsAttention: "บัญชีรับเงินของคุณต้องดำเนินการหลังการตรวจสอบซ้ำ",
      greeting: "สวัสดี {coachName},",
      introVerified: "ผู้ดูแลของ <strong style=\"color:#fff;\">{orgName}</strong> ได้ตรวจสอบ {methodLabel} ที่บันทึกไว้สำหรับการจ่ายเงินโค้ชของคุณด้วยตนเองอีกครั้ง การตรวจสอบเสร็จสมบูรณ์และการจ่ายเงินจะดำเนินต่อไปตามปกติ — ไม่ต้องดำเนินการใด ๆ",
      introNeedsAttention: "ผู้ดูแลของ <strong style=\"color:#fff;\">{orgName}</strong> ได้ตรวจสอบ {methodLabel} ที่บันทึกไว้สำหรับการจ่ายเงินโค้ชของคุณด้วยตนเองอีกครั้ง ธนาคารแจ้งว่าใช้ไม่ได้แล้ว ดังนั้นการจ่ายเงินครั้งถัดไปจะถูกพักไว้จนกว่าคุณจะบันทึกข้อมูลใหม่",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "บัญชีธนาคาร",
      upiRowLabel: "UPI ID",
      bankRowLabel: "บัญชีธนาคาร",
      reverifiedOnLabel: "ยืนยันอีกครั้งเมื่อ",
      statusLabel: "สถานะ",
      statusValueVerified: "ยืนยันแล้ว",
      statusValueNeedsAttention: "ต้องดำเนินการ",
      reasonLabel: "เหตุผล",
      footer: "หากคุณไม่ได้คาดหวังว่าผู้ดูแลจะตรวจสอบบัญชีของคุณซ้ำ โปรดติดต่อทีมสนับสนุนขององค์กรของคุณ คุณยังสามารถบันทึกข้อมูลการจ่ายเงินใหม่ในพื้นที่ทำงานโค้ชเมื่อใดก็ได้เพื่อเริ่มการตรวจสอบใหม่ด้วยตนเอง",
    },
  },

  ms: {
    bouncedDigest: {
      headerTag: "Peringatan Yuran",
      subjectOne: "⚠️ 1 peringatan yuran terpental memerlukan perhatian — {orgName}",
      subjectMany: "⚠️ {count} peringatan yuran terpental memerlukan perhatian — {orgName}",
      heading: "Peringatan yuran terpental — ringkasan harian",
      introOne: "Hai {staff}, 1 peringatan yuran masih gagal merentasi {leviesCount} definisi yuran untuk {orgName}. Setiap baris di bawah memautkan ke butiran yuran di mana anda boleh mencuba semula saluran yang terjejas atau membetulkan butiran perhubungan.",
      introMany: "Hai {staff}, {count} peringatan yuran masih gagal merentasi {leviesCount} definisi yuran untuk {orgName}. Setiap baris di bawah memautkan ke butiran yuran di mana anda boleh mencuba semula saluran yang terjejas atau membetulkan butiran perhubungan.",
      levyHeader: "Yuran",
      bouncedHeader: "Terpental",
      latestFailureLabel: "Kegagalan terkini",
      footer: "Ringkasan ini dihantar hanya pada hari yang ada kegagalan belum selesai. Anda menerimanya kerana anda pentadbir organisasi untuk {orgName}.",
    },
    levyReceipt: {
      headerTag: "Akaun Ahli",
      payment: {
        subject: "Resit pembayaran — {levyName} ({orgName})",
        heading: "Pembayaran diterima",
        intro: "Hai {memberName}, kami telah merekodkan pembayaran anda untuk <strong style=\"color:#fff;\">{levyName}</strong>. Baki anda kini telah dijelaskan.",
        amountLabel: "Jumlah dibayar",
      },
      partialPayment: {
        subject: "Resit pembayaran sebahagian — {levyName} ({orgName})",
        heading: "Pembayaran sebahagian diterima",
        intro: "Hai {memberName}, kami telah merekodkan pembayaran sebahagian terhadap <strong style=\"color:#fff;\">{levyName}</strong>. Masih ada baki tertunggak.",
        amountLabel: "Jumlah dibayar",
      },
      refund: {
        subject: "Bayaran balik dikeluarkan — {levyName} ({orgName})",
        heading: "Bayaran balik dikeluarkan",
        intro: "Hai {memberName}, satu bayaran balik telah dikeluarkan untuk caj <strong style=\"color:#fff;\">{levyName}</strong> anda.",
        amountLabel: "Jumlah dikembalikan",
      },
      waiver: {
        subject: "Caj diketepikan — {levyName} ({orgName})",
        heading: "Caj diketepikan",
        intro: "Hai {memberName}, caj <strong style=\"color:#fff;\">{levyName}</strong> anda telah diketepikan. Tiada lagi yang perlu dibayar.",
        amountLabel: "Jumlah diketepikan",
      },
      levyLabel: "Yuran",
      newBalanceLabel: "Baki baharu",
      currencyLabel: "Mata wang",
      noteLabel: "Nota",
      footer: "Anda boleh melihat sejarah pembayaran penuh pada bila-bila masa dari portal ahli. Jika terdapat sesuatu yang tidak betul, sila balas e-mel ini atau hubungi {orgName} secara terus.",
    },
    documentRejected: {
      headerTag: "Dokumen",
      subject: "Dokumen perlukan perhatian: {docLabel}",
      greeting: "Hai {memberName},",
      intro: "Dokumen \"{docLabel}\" yang anda muat naik telah disemak oleh kakitangan {orgName} dan tidak dapat diterima.",
      reasonLabel: "Sebab",
      reupload: "Sila muat naik semula versi yang diperbetulkan dari portal ahli secepat mungkin.",
    },
    documentUnrejected: {
      headerTag: "Dokumen",
      subject: "Penolakan ditarik balik: {docLabel}",
      greeting: "Hai {memberName},",
      intro: "Kakitangan {orgName} telah menarik balik penolakan terdahulu terhadap dokumen anda \"{docLabel}\". Ia telah dimasukkan semula ke dalam baris gilir untuk disemak semula — tiada tindakan diperlukan daripada anda.",
      noteLabel: "Nota daripada kakitangan",
    },
    documentPending: {
      headerTag: "Dokumen",
      pushTitle: "Dokumen baharu menunggu semakan",
      emailSubject: "Dokumen ahli baharu menunggu semakan",
      body: "{memberName} telah memuat naik dokumen {docTypeLabel} baharu (\"{docLabel}\") untuk pengesahan.",
    },
    payoutNotify: {
      headerTag: "Bayaran Jurulatih",
      subject: "Bayaran dihantar — {amount} dari {orgName}",
      heading: "✅ Bayaran dihantar",
      greeting: "Hai {coachName}, bayaran ulasan ayunan terkini anda dari <strong style=\"color:#fff;\">{orgName}</strong> telah ditandakan sebagai dibayar.",
      amountLabel: "Jumlah",
      referenceLabel: "Rujukan",
      notesLabel: "Nota",
      eta: "Dana biasanya akan kelihatan di akaun anda dalam 1–2 hari bekerja, bergantung kepada bank anda.",
      footer: "Anda boleh menyemak sejarah bayaran penuh pada bila-bila masa dari tab Pendapatan (Earnings) dalam ruang kerja jurulatih anda.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Akaun Bayaran",
      subjectVerified: "Akaun bayaran anda telah disahkan semula — {orgName}",
      subjectNeedsAttention: "Tindakan diperlukan — semakan semula admin menandakan {methodLabel} bayaran anda",
      headingVerified: "Akaun bayaran anda telah disahkan semula",
      headingNeedsAttention: "Akaun bayaran anda perlukan perhatian selepas semakan semula",
      greeting: "Hai {coachName},",
      introVerified: "Seorang pentadbir di <strong style=\"color:#fff;\">{orgName}</strong> telah mengesahkan semula secara manual {methodLabel} yang didaftarkan untuk bayaran jurulatih anda. Pemeriksaan selesai dengan jayanya dan bayaran anda akan diteruskan seperti biasa — tiada tindakan diperlukan.",
      introNeedsAttention: "Seorang pentadbir di <strong style=\"color:#fff;\">{orgName}</strong> telah mengesahkan semula secara manual {methodLabel} yang didaftarkan untuk bayaran jurulatih anda. Bank melaporkan ia tidak lagi sah, jadi bayaran anda yang seterusnya akan ditahan sehingga anda menyimpan semula maklumat anda.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "akaun bank",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Akaun bank",
      reverifiedOnLabel: "Disahkan semula pada",
      statusLabel: "Status",
      statusValueVerified: "Disahkan",
      statusValueNeedsAttention: "Perlukan perhatian",
      reasonLabel: "Sebab",
      footer: "Jika anda tidak menjangkakan pentadbir akan menyemak semula akaun anda, sila hubungi pasukan sokongan organisasi anda. Anda juga boleh menyimpan semula maklumat bayaran dalam ruang kerja jurulatih pada bila-bila masa untuk memulakan pengesahan baharu sendiri.",
    },
  },

  id: {
    bouncedDigest: {
      headerTag: "Pengingat Iuran",
      subjectOne: "⚠️ 1 pengingat iuran yang gagal memerlukan perhatian — {orgName}",
      subjectMany: "⚠️ {count} pengingat iuran yang gagal memerlukan perhatian — {orgName}",
      heading: "Pengingat iuran yang gagal — ringkasan harian",
      introOne: "Halo {staff}, 1 pengingat iuran masih gagal di {leviesCount} definisi iuran untuk {orgName}. Setiap baris di bawah tertaut ke detail iuran di mana Anda dapat mencoba ulang saluran yang terdampak atau memperbaiki data kontak.",
      introMany: "Halo {staff}, {count} pengingat iuran masih gagal di {leviesCount} definisi iuran untuk {orgName}. Setiap baris di bawah tertaut ke detail iuran di mana Anda dapat mencoba ulang saluran yang terdampak atau memperbaiki data kontak.",
      levyHeader: "Iuran",
      bouncedHeader: "Gagal",
      latestFailureLabel: "Kegagalan terbaru",
      footer: "Ringkasan ini hanya dikirim pada hari dengan kegagalan belum terselesaikan. Anda menerimanya karena terdaftar sebagai admin organisasi untuk {orgName}.",
    },
    levyReceipt: {
      headerTag: "Akun Anggota",
      payment: {
        subject: "Tanda terima pembayaran — {levyName} ({orgName})",
        heading: "Pembayaran diterima",
        intro: "Halo {memberName}, kami telah mencatat pembayaran Anda untuk <strong style=\"color:#fff;\">{levyName}</strong>. Saldo Anda kini lunas.",
        amountLabel: "Jumlah dibayar",
      },
      partialPayment: {
        subject: "Tanda terima pembayaran sebagian — {levyName} ({orgName})",
        heading: "Pembayaran sebagian diterima",
        intro: "Halo {memberName}, kami telah mencatat pembayaran sebagian untuk <strong style=\"color:#fff;\">{levyName}</strong>. Masih terdapat saldo terutang.",
        amountLabel: "Jumlah dibayar",
      },
      refund: {
        subject: "Pengembalian dana — {levyName} ({orgName})",
        heading: "Pengembalian dana diterbitkan",
        intro: "Halo {memberName}, pengembalian dana telah diterbitkan untuk tagihan <strong style=\"color:#fff;\">{levyName}</strong> Anda.",
        amountLabel: "Jumlah dikembalikan",
      },
      waiver: {
        subject: "Tagihan dibebaskan — {levyName} ({orgName})",
        heading: "Tagihan dibebaskan",
        intro: "Halo {memberName}, tagihan <strong style=\"color:#fff;\">{levyName}</strong> Anda telah dibebaskan. Tidak ada lagi yang harus dibayar.",
        amountLabel: "Jumlah dibebaskan",
      },
      levyLabel: "Iuran",
      newBalanceLabel: "Saldo baru",
      currencyLabel: "Mata uang",
      noteLabel: "Catatan",
      footer: "Anda dapat melihat riwayat pembayaran lengkap kapan saja dari portal anggota. Jika ada yang tidak sesuai, balas email ini atau hubungi {orgName} langsung.",
    },
    documentRejected: {
      headerTag: "Dokumen",
      subject: "Dokumen memerlukan perhatian: {docLabel}",
      greeting: "Halo {memberName},",
      intro: "Dokumen yang Anda unggah \"{docLabel}\" telah ditinjau oleh staf {orgName} dan tidak dapat diterima.",
      reasonLabel: "Alasan",
      reupload: "Mohon unggah ulang versi yang sudah diperbaiki dari portal anggota sesegera mungkin.",
    },
    documentUnrejected: {
      headerTag: "Dokumen",
      subject: "Penolakan ditarik kembali: {docLabel}",
      greeting: "Halo {memberName},",
      intro: "Staf {orgName} telah menarik penolakan sebelumnya atas dokumen Anda \"{docLabel}\". Dokumen kembali ke antrean tinjauan dan akan diperiksa kembali — Anda tidak perlu melakukan tindakan apa pun.",
      noteLabel: "Catatan dari staf",
    },
    documentPending: {
      headerTag: "Dokumen",
      pushTitle: "Dokumen baru menunggu peninjauan",
      emailSubject: "Dokumen anggota baru menunggu peninjauan",
      body: "{memberName} mengunggah dokumen {docTypeLabel} baru (\"{docLabel}\") untuk verifikasi.",
    },
    payoutNotify: {
      headerTag: "Pembayaran Pelatih",
      subject: "Pembayaran terkirim — {amount} dari {orgName}",
      heading: "✅ Pembayaran terkirim",
      greeting: "Halo {coachName}, pembayaran ulasan ayunan terbaru Anda dari <strong style=\"color:#fff;\">{orgName}</strong> telah ditandai sebagai terbayar.",
      amountLabel: "Jumlah",
      referenceLabel: "Referensi",
      notesLabel: "Catatan",
      eta: "Dana biasanya muncul di rekening terdaftar Anda dalam 1–2 hari kerja, tergantung bank Anda.",
      footer: "Anda dapat meninjau riwayat pembayaran lengkap kapan saja dari tab Pendapatan (Earnings) di ruang kerja pelatih Anda.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Akun Pembayaran",
      subjectVerified: "Akun pembayaran Anda telah diverifikasi ulang — {orgName}",
      subjectNeedsAttention: "Tindakan diperlukan — pemeriksaan ulang admin menandai {methodLabel} pembayaran Anda",
      headingVerified: "Akun pembayaran Anda telah diverifikasi ulang",
      headingNeedsAttention: "Akun pembayaran Anda memerlukan perhatian setelah pemeriksaan ulang",
      greeting: "Halo {coachName},",
      introVerified: "Seorang administrator di <strong style=\"color:#fff;\">{orgName}</strong> telah memverifikasi ulang secara manual {methodLabel} yang terdaftar untuk pembayaran pelatih Anda. Pemeriksaan berhasil diselesaikan dan pembayaran Anda akan tetap berjalan seperti biasa — tidak diperlukan tindakan.",
      introNeedsAttention: "Seorang administrator di <strong style=\"color:#fff;\">{orgName}</strong> telah memverifikasi ulang secara manual {methodLabel} yang terdaftar untuk pembayaran pelatih Anda. Bank melaporkan bahwa data tidak lagi valid, sehingga pembayaran berikutnya akan ditahan hingga Anda menyimpan ulang detail Anda.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "rekening bank",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Rekening bank",
      reverifiedOnLabel: "Diverifikasi ulang pada",
      statusLabel: "Status",
      statusValueVerified: "Terverifikasi",
      statusValueNeedsAttention: "Memerlukan perhatian",
      reasonLabel: "Alasan",
      footer: "Jika Anda tidak menduga seorang admin akan memeriksa ulang akun Anda, hubungi tim dukungan organisasi Anda. Anda juga dapat menyimpan ulang detail pembayaran di ruang kerja pelatih kapan saja untuk memicu validasi baru sendiri.",
    },
  },

  vi: {
    bouncedDigest: {
      headerTag: "Nhắc nhở phí",
      subjectOne: "⚠️ 1 lời nhắc phí bị trả lại cần xử lý — {orgName}",
      subjectMany: "⚠️ {count} lời nhắc phí bị trả lại cần xử lý — {orgName}",
      heading: "Lời nhắc phí bị trả lại — bản tổng hợp hằng ngày",
      introOne: "Chào {staff}, vẫn còn 1 lời nhắc phí thất bại trên {leviesCount} định nghĩa phí của {orgName}. Mỗi dòng bên dưới liên kết đến chi tiết phí, nơi bạn có thể thử lại các kênh bị ảnh hưởng hoặc sửa thông tin liên hệ.",
      introMany: "Chào {staff}, vẫn còn {count} lời nhắc phí thất bại trên {leviesCount} định nghĩa phí của {orgName}. Mỗi dòng bên dưới liên kết đến chi tiết phí, nơi bạn có thể thử lại các kênh bị ảnh hưởng hoặc sửa thông tin liên hệ.",
      levyHeader: "Phí",
      bouncedHeader: "Trả lại",
      latestFailureLabel: "Lỗi gần nhất",
      footer: "Bản tổng hợp này chỉ gửi vào những ngày có lỗi chưa được giải quyết. Bạn nhận được vì là quản trị viên tổ chức của {orgName}.",
    },
    levyReceipt: {
      headerTag: "Tài khoản hội viên",
      payment: {
        subject: "Biên lai thanh toán — {levyName} ({orgName})",
        heading: "Đã nhận thanh toán",
        intro: "Chào {memberName}, chúng tôi đã ghi nhận khoản thanh toán cho <strong style=\"color:#fff;\">{levyName}</strong>. Số dư của bạn đã được tất toán.",
        amountLabel: "Số tiền đã trả",
      },
      partialPayment: {
        subject: "Biên lai thanh toán một phần — {levyName} ({orgName})",
        heading: "Đã nhận thanh toán một phần",
        intro: "Chào {memberName}, chúng tôi đã ghi nhận thanh toán một phần cho <strong style=\"color:#fff;\">{levyName}</strong>. Vẫn còn số dư cần thanh toán.",
        amountLabel: "Số tiền đã trả",
      },
      refund: {
        subject: "Đã hoàn tiền — {levyName} ({orgName})",
        heading: "Đã hoàn tiền",
        intro: "Chào {memberName}, một khoản hoàn tiền đã được phát hành cho khoản phí <strong style=\"color:#fff;\">{levyName}</strong> của bạn.",
        amountLabel: "Số tiền hoàn",
      },
      waiver: {
        subject: "Đã miễn khoản phí — {levyName} ({orgName})",
        heading: "Đã miễn khoản phí",
        intro: "Chào {memberName}, khoản phí <strong style=\"color:#fff;\">{levyName}</strong> của bạn đã được miễn. Không còn khoản nào phải trả.",
        amountLabel: "Số tiền được miễn",
      },
      levyLabel: "Phí",
      newBalanceLabel: "Số dư mới",
      currencyLabel: "Tiền tệ",
      noteLabel: "Ghi chú",
      footer: "Bạn có thể xem toàn bộ lịch sử thanh toán bất cứ lúc nào trong cổng hội viên. Nếu thấy có gì sai, vui lòng trả lời email này hoặc liên hệ trực tiếp {orgName}.",
    },
    documentRejected: {
      headerTag: "Tài liệu",
      subject: "Tài liệu cần xử lý: {docLabel}",
      greeting: "Chào {memberName},",
      intro: "Tài liệu bạn đã tải lên \"{docLabel}\" đã được nhân viên {orgName} xem xét và không thể được chấp nhận.",
      reasonLabel: "Lý do",
      reupload: "Vui lòng tải lên lại bản đã chỉnh sửa từ cổng hội viên sớm nhất có thể.",
    },
    documentUnrejected: {
      headerTag: "Tài liệu",
      subject: "Đã rút lại từ chối: {docLabel}",
      greeting: "Chào {memberName},",
      intro: "Nhân viên {orgName} đã rút lại quyết định từ chối trước đó đối với tài liệu \"{docLabel}\" của bạn. Tài liệu đã trở lại hàng đợi và sẽ được xem xét lại — bạn không cần làm gì thêm.",
      noteLabel: "Ghi chú từ nhân viên",
    },
    documentPending: {
      headerTag: "Tài liệu",
      pushTitle: "Tài liệu mới đang chờ xem xét",
      emailSubject: "Tài liệu hội viên mới đang chờ xem xét",
      body: "{memberName} đã tải lên tài liệu {docTypeLabel} mới (\"{docLabel}\") để xác minh.",
    },
    payoutNotify: {
      headerTag: "Thanh toán huấn luyện viên",
      subject: "Đã gửi khoản thanh toán — {amount} từ {orgName}",
      heading: "✅ Đã gửi khoản thanh toán",
      greeting: "Chào {coachName}, khoản thanh toán đánh giá swing mới nhất của bạn từ <strong style=\"color:#fff;\">{orgName}</strong> đã được đánh dấu là đã trả.",
      amountLabel: "Số tiền",
      referenceLabel: "Mã tham chiếu",
      notesLabel: "Ghi chú",
      eta: "Tiền thường xuất hiện trong tài khoản đăng ký của bạn trong 1–2 ngày làm việc, tùy ngân hàng.",
      footer: "Bạn có thể xem toàn bộ lịch sử thanh toán bất cứ lúc nào trong tab Thu nhập (Earnings) của không gian huấn luyện viên.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Tài khoản nhận tiền",
      subjectVerified: "Tài khoản nhận tiền của bạn đã được xác minh lại — {orgName}",
      subjectNeedsAttention: "Cần xử lý — quản trị viên kiểm tra lại đã đánh dấu {methodLabel} thanh toán của bạn",
      headingVerified: "Tài khoản nhận tiền của bạn đã được xác minh lại",
      headingNeedsAttention: "Tài khoản nhận tiền của bạn cần xử lý sau khi kiểm tra lại",
      greeting: "Chào {coachName},",
      introVerified: "Một quản trị viên tại <strong style=\"color:#fff;\">{orgName}</strong> đã xác minh lại thủ công {methodLabel} đã đăng ký cho khoản thanh toán huấn luyện viên của bạn. Việc kiểm tra hoàn tất thành công và các khoản thanh toán sẽ tiếp tục như thường lệ — không cần thao tác.",
      introNeedsAttention: "Một quản trị viên tại <strong style=\"color:#fff;\">{orgName}</strong> đã xác minh lại thủ công {methodLabel} đã đăng ký cho khoản thanh toán huấn luyện viên của bạn. Ngân hàng báo rằng nó không còn hợp lệ, vì vậy khoản thanh toán tiếp theo sẽ bị tạm giữ cho đến khi bạn lưu lại thông tin.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "tài khoản ngân hàng",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Tài khoản ngân hàng",
      reverifiedOnLabel: "Xác minh lại lúc",
      statusLabel: "Trạng thái",
      statusValueVerified: "Đã xác minh",
      statusValueNeedsAttention: "Cần xử lý",
      reasonLabel: "Lý do",
      footer: "Nếu bạn không lường trước việc quản trị viên sẽ kiểm tra lại tài khoản, hãy liên hệ với đội hỗ trợ của tổ chức bạn. Bạn cũng có thể lưu lại chi tiết thanh toán trong không gian huấn luyện viên bất cứ lúc nào để tự kích hoạt một lần xác minh mới.",
    },
  },

  fil: {
    bouncedDigest: {
      headerTag: "Mga Paalala sa Bayarin",
      subjectOne: "⚠️ 1 bounced na paalala sa bayarin ang nangangailangan ng aksyon — {orgName}",
      subjectMany: "⚠️ {count} bounced na paalala sa bayarin ang nangangailangan ng aksyon — {orgName}",
      heading: "Bounced na mga paalala sa bayarin — pang-araw-araw na buod",
      introOne: "Kumusta {staff}, 1 paalala sa bayarin ang patuloy na bumibigo sa {leviesCount} kahulugan ng bayarin para sa {orgName}. Ang bawat hilera sa ibaba ay link papunta sa detalye ng bayarin kung saan maaaring i-retry ang mga apektadong channel o ayusin ang impormasyon ng kontak.",
      introMany: "Kumusta {staff}, {count} paalala sa bayarin ang patuloy na bumibigo sa {leviesCount} kahulugan ng bayarin para sa {orgName}. Ang bawat hilera sa ibaba ay link papunta sa detalye ng bayarin kung saan maaaring i-retry ang mga apektadong channel o ayusin ang impormasyon ng kontak.",
      levyHeader: "Bayarin",
      bouncedHeader: "Bounced",
      latestFailureLabel: "Pinakabagong pagkabigo",
      footer: "Ipinapadala lamang ang buod na ito sa mga araw na may hindi pa nareresolba. Natatanggap mo ito dahil isa kang admin ng organisasyon para sa {orgName}.",
    },
    levyReceipt: {
      headerTag: "Account ng Kasapi",
      payment: {
        subject: "Resibo ng bayad — {levyName} ({orgName})",
        heading: "Natanggap ang bayad",
        intro: "Kumusta {memberName}, naitala namin ang iyong bayad para sa <strong style=\"color:#fff;\">{levyName}</strong>. Bayad na ang iyong balanse.",
        amountLabel: "Halagang binayad",
      },
      partialPayment: {
        subject: "Resibo ng bahagyang bayad — {levyName} ({orgName})",
        heading: "Natanggap ang bahagyang bayad",
        intro: "Kumusta {memberName}, naitala namin ang bahagyang bayad para sa <strong style=\"color:#fff;\">{levyName}</strong>. May natitirang balanseng dapat bayaran.",
        amountLabel: "Halagang binayad",
      },
      refund: {
        subject: "Inilabas ang refund — {levyName} ({orgName})",
        heading: "Inilabas ang refund",
        intro: "Kumusta {memberName}, naglabas kami ng refund para sa iyong singil sa <strong style=\"color:#fff;\">{levyName}</strong>.",
        amountLabel: "Halagang isinauli",
      },
      waiver: {
        subject: "Ipinawalang-bisa ang singil — {levyName} ({orgName})",
        heading: "Ipinawalang-bisa ang singil",
        intro: "Kumusta {memberName}, ang singil mong <strong style=\"color:#fff;\">{levyName}</strong> ay ipinawalang-bisa. Wala ka nang dapat bayaran.",
        amountLabel: "Halagang ipinawalang-bisa",
      },
      levyLabel: "Bayarin",
      newBalanceLabel: "Bagong balanse",
      currencyLabel: "Pera",
      noteLabel: "Tala",
      footer: "Maaari mong tingnan ang kumpletong kasaysayan ng bayad anumang oras mula sa portal ng kasapi. Kung may mukhang mali, tumugon sa email na ito o makipag-ugnayan sa {orgName} nang direkta.",
    },
    documentRejected: {
      headerTag: "Mga Dokumento",
      subject: "Dokumentong nangangailangan ng pansin: {docLabel}",
      greeting: "Kumusta {memberName},",
      intro: "Sinuri ng staff ng {orgName} ang iyong na-upload na dokumentong \"{docLabel}\" at hindi ito tinanggap.",
      reasonLabel: "Dahilan",
      reupload: "Pakiulit i-upload ang naitamang bersyon mula sa portal ng kasapi sa lalong madaling panahon.",
    },
    documentUnrejected: {
      headerTag: "Mga Dokumento",
      subject: "Binawi ang pagtanggi: {docLabel}",
      greeting: "Kumusta {memberName},",
      intro: "Binawi ng staff ng {orgName} ang dating pagtanggi sa iyong dokumentong \"{docLabel}\". Bumalik na ito sa pila para suriin muli — walang aksyon ang kailangan mong gawin.",
      noteLabel: "Tala mula sa staff",
    },
    documentPending: {
      headerTag: "Mga Dokumento",
      pushTitle: "Bagong dokumentong naghihintay ng pagsusuri",
      emailSubject: "Bagong dokumento ng kasapi na naghihintay ng pagsusuri",
      body: "Nag-upload si {memberName} ng bagong dokumentong {docTypeLabel} (\"{docLabel}\") para sa pagberipika.",
    },
    payoutNotify: {
      headerTag: "Payout sa Coach",
      subject: "Ipinadala ang payout — {amount} mula sa {orgName}",
      heading: "✅ Ipinadala ang payout",
      greeting: "Kumusta {coachName}, ang iyong pinakabagong payout para sa swing review mula sa <strong style=\"color:#fff;\">{orgName}</strong> ay namarkahan nang bayad.",
      amountLabel: "Halaga",
      referenceLabel: "Reperensiya",
      notesLabel: "Mga tala",
      eta: "Karaniwang lumalabas ang pondo sa iyong nakarehistrong account sa loob ng 1–2 araw na pang-negosyo, depende sa iyong bangko.",
      footer: "Maaari mong suriin ang kumpletong kasaysayan ng payout anumang oras mula sa tab na Kita (Earnings) sa iyong coach workspace.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Account Pambayad",
      subjectVerified: "Naberipika muli ang iyong account pambayad — {orgName}",
      subjectNeedsAttention: "Kailangan ng aksyon — natukoy ng admin re-check ang iyong {methodLabel} pambayad",
      headingVerified: "Naberipika muli ang iyong account pambayad",
      headingNeedsAttention: "Kailangan ng atensyon ang iyong account pambayad pagkatapos ng muling pagsusuri",
      greeting: "Kumusta {coachName},",
      introVerified: "Manu-mano muling binerify ng isang administrator sa <strong style=\"color:#fff;\">{orgName}</strong> ang nakatakdang {methodLabel} para sa iyong mga bayad bilang coach. Matagumpay ang pagsusuri at magpapatuloy ang mga bayad na tulad ng dati — walang aksyong kailangan.",
      introNeedsAttention: "Manu-mano muling binerify ng isang administrator sa <strong style=\"color:#fff;\">{orgName}</strong> ang nakatakdang {methodLabel} para sa iyong mga bayad bilang coach. Iniulat ng bangko na hindi na ito balido, kaya ipipigil muna ang iyong susunod na bayad hanggang i-save mong muli ang iyong mga detalye.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "bank account",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Bank account",
      reverifiedOnLabel: "Naberipika muli noong",
      statusLabel: "Status",
      statusValueVerified: "Naberipika",
      statusValueNeedsAttention: "Kailangan ng atensyon",
      reasonLabel: "Dahilan",
      footer: "Kung hindi mo inaasahan na muling susuriin ng admin ang iyong account, makipag-ugnayan sa support team ng iyong organisasyon. Maaari mo ring i-save muli ang iyong mga detalye ng bayad sa iyong coach workspace anumang oras upang ikaw mismo ang magpasimula ng bagong validation.",
    },
  },

  sw: {
    bouncedDigest: {
      headerTag: "Vikumbusho vya Ada",
      subjectOne: "⚠️ Kikumbusho 1 cha ada kilichorudi kinahitaji uangalizi — {orgName}",
      subjectMany: "⚠️ Vikumbusho {count} vya ada vilivyorudi vinahitaji uangalizi — {orgName}",
      heading: "Vikumbusho vya ada vilivyorudi — muhtasari wa kila siku",
      introOne: "Habari {staff}, kikumbusho 1 cha ada bado kinashindwa katika fasili {leviesCount} ya ada kwa {orgName}. Kila safu hapa chini inaunganishwa na maelezo ya ada ambapo unaweza kujaribu tena vituo vilivyoathiriwa au kurekebisha taarifa za mawasiliano.",
      introMany: "Habari {staff}, vikumbusho {count} vya ada bado vinashindwa katika fasili {leviesCount} za ada kwa {orgName}. Kila safu hapa chini inaunganishwa na maelezo ya ada ambapo unaweza kujaribu tena vituo vilivyoathiriwa au kurekebisha taarifa za mawasiliano.",
      levyHeader: "Ada",
      bouncedHeader: "Imerudi",
      latestFailureLabel: "Kushindwa kwa hivi karibuni",
      footer: "Muhtasari huu hutumwa tu siku ambazo kuna kushindwa kusiko tatuliwa. Unapokea kwa sababu wewe ni msimamizi wa shirika kwa {orgName}.",
    },
    levyReceipt: {
      headerTag: "Akaunti ya Mwanachama",
      payment: {
        subject: "Risiti ya malipo — {levyName} ({orgName})",
        heading: "Malipo yamepokelewa",
        intro: "Habari {memberName}, tumerekodi malipo yako ya <strong style=\"color:#fff;\">{levyName}</strong>. Salio lako sasa limelipwa.",
        amountLabel: "Kiasi kilicholipwa",
      },
      partialPayment: {
        subject: "Risiti ya malipo ya sehemu — {levyName} ({orgName})",
        heading: "Malipo ya sehemu yamepokelewa",
        intro: "Habari {memberName}, tumerekodi malipo ya sehemu dhidi ya <strong style=\"color:#fff;\">{levyName}</strong>. Salio bado linabaki.",
        amountLabel: "Kiasi kilicholipwa",
      },
      refund: {
        subject: "Marejesho yametolewa — {levyName} ({orgName})",
        heading: "Marejesho yametolewa",
        intro: "Habari {memberName}, marejesho yametolewa kwa malipo yako ya <strong style=\"color:#fff;\">{levyName}</strong>.",
        amountLabel: "Kiasi kilichorudishwa",
      },
      waiver: {
        subject: "Malipo yamesamehewa — {levyName} ({orgName})",
        heading: "Malipo yamesamehewa",
        intro: "Habari {memberName}, malipo yako ya <strong style=\"color:#fff;\">{levyName}</strong> yamesamehewa. Hakuna kingine kinachodaiwa.",
        amountLabel: "Kiasi kilichosamehewa",
      },
      levyLabel: "Ada",
      newBalanceLabel: "Salio jipya",
      currencyLabel: "Sarafu",
      noteLabel: "Maelezo",
      footer: "Unaweza kuangalia historia kamili ya malipo wakati wowote kupitia tovuti ya wanachama. Ikiwa kuna kitu kibaya, jibu barua hii au wasiliana na {orgName} moja kwa moja.",
    },
    documentRejected: {
      headerTag: "Hati",
      subject: "Hati inahitaji uangalizi: {docLabel}",
      greeting: "Habari {memberName},",
      intro: "Hati uliyopakia \"{docLabel}\" imekaguliwa na wafanyakazi wa {orgName} na haikuweza kukubaliwa.",
      reasonLabel: "Sababu",
      reupload: "Tafadhali pakia upya toleo lililorekebishwa kupitia tovuti ya wanachama haraka iwezekanavyo.",
    },
    documentUnrejected: {
      headerTag: "Hati",
      subject: "Kataa limeondolewa: {docLabel}",
      greeting: "Habari {memberName},",
      intro: "Wafanyakazi wa {orgName} wameondoa kataa la awali kwa hati yako \"{docLabel}\". Imerudi kwenye foleni ya kusubiri na itakaguliwa tena — hakuna hatua inayohitajika kutoka kwako.",
      noteLabel: "Maelezo kutoka kwa wafanyakazi",
    },
    documentPending: {
      headerTag: "Hati",
      pushTitle: "Hati mpya inangoja kukaguliwa",
      emailSubject: "Hati mpya ya mwanachama inangoja kukaguliwa",
      body: "{memberName} amepakia hati mpya ya {docTypeLabel} (\"{docLabel}\") kwa ajili ya kuthibitishwa.",
    },
    payoutNotify: {
      headerTag: "Malipo ya Kocha",
      subject: "Malipo yametumwa — {amount} kutoka {orgName}",
      heading: "✅ Malipo yametumwa",
      greeting: "Habari {coachName}, malipo yako ya hivi karibuni ya ukaguzi wa swing kutoka <strong style=\"color:#fff;\">{orgName}</strong> yameashiriwa kuwa yamelipwa.",
      amountLabel: "Kiasi",
      referenceLabel: "Marejeleo",
      notesLabel: "Maelezo",
      eta: "Fedha kawaida huonekana kwenye akaunti yako iliyosajiliwa ndani ya siku 1–2 za kazi, kulingana na benki yako.",
      footer: "Unaweza kukagua historia kamili ya malipo wakati wowote kutoka kwa kichupo cha Mapato (Earnings) katika eneo lako la kazi la kocha.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Akaunti ya Malipo",
      subjectVerified: "Akaunti yako ya malipo imethibitishwa upya — {orgName}",
      subjectNeedsAttention: "Hatua inahitajika — ukaguzi upya wa msimamizi umetambua tatizo katika {methodLabel} yako ya malipo",
      headingVerified: "Akaunti yako ya malipo imethibitishwa upya",
      headingNeedsAttention: "Akaunti yako ya malipo inahitaji uangalizi baada ya ukaguzi upya",
      greeting: "Habari {coachName},",
      introVerified: "Msimamizi katika <strong style=\"color:#fff;\">{orgName}</strong> amethibitisha kwa mkono tena {methodLabel} iliyosajiliwa kwa malipo yako ya kocha. Ukaguzi umekamilika vyema na malipo yako yataendelea kama kawaida — hakuna hatua inayohitajika.",
      introNeedsAttention: "Msimamizi katika <strong style=\"color:#fff;\">{orgName}</strong> amethibitisha kwa mkono tena {methodLabel} iliyosajiliwa kwa malipo yako ya kocha. Benki imeripoti kuwa haitumiki tena, hivyo malipo yako yajayo yatasubirishwa hadi uhifadhi tena maelezo yako.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "akaunti ya benki",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Akaunti ya benki",
      reverifiedOnLabel: "Imethibitishwa upya tarehe",
      statusLabel: "Hali",
      statusValueVerified: "Imethibitishwa",
      statusValueNeedsAttention: "Inahitaji uangalizi",
      reasonLabel: "Sababu",
      footer: "Ikiwa hukutarajia msimamizi kuangalia upya akaunti yako, wasiliana na timu ya usaidizi ya shirika lako. Pia unaweza kuhifadhi tena maelezo ya malipo katika eneo lako la kazi la kocha wakati wowote ili kuanzisha uthibitisho mpya wewe mwenyewe.",
    },
  },

  af: {
    bouncedDigest: {
      headerTag: "Heffingherinneringe",
      subjectOne: "⚠️ 1 teruggebonsde heffingherinnering verg aandag — {orgName}",
      subjectMany: "⚠️ {count} teruggebonsde heffingherinneringe verg aandag — {orgName}",
      heading: "Teruggebonsde heffingherinneringe — daaglikse opsomming",
      introOne: "Hallo {staff}, 1 heffingherinnering misluk steeds oor {leviesCount} heffingdefinisie vir {orgName}. Elke ry hieronder skakel na die heffingbesonderhede waar jy die geaffekteerde kanale kan herprobeer of die kontakbesonderhede kan regstel.",
      introMany: "Hallo {staff}, {count} heffingherinneringe misluk steeds oor {leviesCount} heffingdefinisies vir {orgName}. Elke ry hieronder skakel na die heffingbesonderhede waar jy die geaffekteerde kanale kan herprobeer of die kontakbesonderhede kan regstel.",
      levyHeader: "Heffing",
      bouncedHeader: "Teruggebons",
      latestFailureLabel: "Jongste mislukking",
      footer: "Hierdie opsomming word slegs gestuur op dae met onopgeloste mislukkings. Jy ontvang dit omdat jy 'n organisasie-administrateur vir {orgName} is.",
    },
    levyReceipt: {
      headerTag: "Lid se Rekening",
      payment: {
        subject: "Betalingskwitansie — {levyName} ({orgName})",
        heading: "Betaling ontvang",
        intro: "Hallo {memberName}, ons het jou betaling vir <strong style=\"color:#fff;\">{levyName}</strong> aangeteken. Jou saldo is nou vereffen.",
        amountLabel: "Bedrag betaal",
      },
      partialPayment: {
        subject: "Gedeeltelike betalingskwitansie — {levyName} ({orgName})",
        heading: "Gedeeltelike betaling ontvang",
        intro: "Hallo {memberName}, ons het 'n gedeeltelike betaling teen <strong style=\"color:#fff;\">{levyName}</strong> aangeteken. Daar bly steeds 'n saldo uitstaande.",
        amountLabel: "Bedrag betaal",
      },
      refund: {
        subject: "Terugbetaling uitgereik — {levyName} ({orgName})",
        heading: "Terugbetaling uitgereik",
        intro: "Hallo {memberName}, 'n terugbetaling is uitgereik teen jou <strong style=\"color:#fff;\">{levyName}</strong>-heffing.",
        amountLabel: "Bedrag terugbetaal",
      },
      waiver: {
        subject: "Heffing kwytgeskeld — {levyName} ({orgName})",
        heading: "Heffing kwytgeskeld",
        intro: "Hallo {memberName}, jou <strong style=\"color:#fff;\">{levyName}</strong>-heffing is kwytgeskeld. Niks verder is verskuldig nie.",
        amountLabel: "Bedrag kwytgeskeld",
      },
      levyLabel: "Heffing",
      newBalanceLabel: "Nuwe saldo",
      currencyLabel: "Geldeenheid",
      noteLabel: "Nota",
      footer: "Jy kan jou volledige betalingsgeskiedenis enige tyd op die lid-portaal sien. As iets verkeerd lyk, antwoord asseblief op hierdie e-pos of kontak {orgName} direk.",
    },
    documentRejected: {
      headerTag: "Dokumente",
      subject: "Dokument benodig aandag: {docLabel}",
      greeting: "Hallo {memberName},",
      intro: "Jou opgelaaide dokument \"{docLabel}\" is deur {orgName}-personeel hersien en kon nie aanvaar word nie.",
      reasonLabel: "Rede",
      reupload: "Laai asseblief sodra moontlik 'n reggemaakte weergawe weer op vanaf die lid-portaal.",
    },
    documentUnrejected: {
      headerTag: "Dokumente",
      subject: "Afwysing teruggetrek: {docLabel}",
      greeting: "Hi {memberName},",
      intro: "{orgName}-personeel het die vorige afwysing van jou dokument \"{docLabel}\" teruggetrek. Dit is terug in die wagry vir hersiening en sal weer hersien word — geen aksie van jou kant af nodig nie.",
      noteLabel: "Nota van personeel",
    },
    documentPending: {
      headerTag: "Dokumente",
      pushTitle: "Nuwe dokument wag op hersiening",
      emailSubject: "Nuwe lid-dokument wag op hersiening",
      body: "{memberName} het 'n nuwe {docTypeLabel}-dokument (\"{docLabel}\") opgelaai vir verifikasie.",
    },
    payoutNotify: {
      headerTag: "Afrigter-uitbetaling",
      subject: "Uitbetaling gestuur — {amount} vanaf {orgName}",
      heading: "✅ Uitbetaling gestuur",
      greeting: "Hallo {coachName}, jou jongste swing-resensie-uitbetaling vanaf <strong style=\"color:#fff;\">{orgName}</strong> is as betaal gemerk.",
      amountLabel: "Bedrag",
      referenceLabel: "Verwysing",
      notesLabel: "Notas",
      eta: "Fondse verskyn gewoonlik binne 1–2 werksdae in jou geregistreerde rekening, afhangend van jou bank.",
      footer: "Jy kan die volledige uitbetaalgeskiedenis enige tyd in die Verdienste-blad (Earnings) van jou afrigter-werkruimte sien.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Uitbetaalrekening",
      subjectVerified: "Jou uitbetaalrekening is hergeverifieer — {orgName}",
      subjectNeedsAttention: "Aksie nodig — admin se herkontrole het jou uitbetaal-{methodLabel} gemerk",
      headingVerified: "Jou uitbetaalrekening is hergeverifieer",
      headingNeedsAttention: "Jou uitbetaalrekening verg aandag ná 'n herkontrole",
      greeting: "Hallo {coachName},",
      introVerified: "'n Administrateur by <strong style=\"color:#fff;\">{orgName}</strong> het die {methodLabel} wat vir jou afrigter-uitbetalings geregistreer is, met die hand hergeverifieer. Die kontrole is suksesvol voltooi en jou uitbetalings sal soos gewoonlik voortgaan — geen aksie word vereis nie.",
      introNeedsAttention: "'n Administrateur by <strong style=\"color:#fff;\">{orgName}</strong> het die {methodLabel} wat vir jou afrigter-uitbetalings geregistreer is, met die hand hergeverifieer. Die bank het gerapporteer dat dit nie meer geldig is nie, dus sal jou volgende uitbetaling teruggehou word totdat jy jou besonderhede weer stoor.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "bankrekening",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Bankrekening",
      reverifiedOnLabel: "Hergeverifieer op",
      statusLabel: "Status",
      statusValueVerified: "Geverifieer",
      statusValueNeedsAttention: "Verg aandag",
      reasonLabel: "Rede",
      footer: "As jy nie verwag het dat 'n admin jou rekening sou herkontroleer nie, kontak jou organisasie se ondersteuningspan. Jy kan ook jou uitbetaalbesonderhede enige tyd in jou afrigter-werkruimte weer stoor om self 'n nuwe validasie te begin.",
    },
  },

  am: {
    bouncedDigest: {
      headerTag: "የክፍያ ማስታወሻዎች",
      subjectOne: "⚠️ 1 የተመለሰ የክፍያ ማስታወሻ ትኩረት ይጠይቃል — {orgName}",
      subjectMany: "⚠️ {count} የተመለሱ የክፍያ ማስታወሻዎች ትኩረት ይጠይቃሉ — {orgName}",
      heading: "የተመለሱ የክፍያ ማስታወሻዎች — የቀን ማጠቃለያ",
      introOne: "ሰላም {staff}, ለ {orgName} ከ {leviesCount} የክፍያ ትርጓሜዎች ውስጥ 1 የክፍያ ማስታወሻ አሁንም እያቃተ ነው። እያንዳንዱ ከታች ያለ ረድፍ ወደ ክፍያው ዝርዝር የሚያመራ ሲሆን፣ የተጎዱ መንገዶችን ድጋሚ መሞከር ወይም የግንኙነት መረጃውን ማስተካከል ትችላላችሁ።",
      introMany: "ሰላም {staff}, ለ {orgName} ከ {leviesCount} የክፍያ ትርጓሜዎች ውስጥ {count} የክፍያ ማስታወሻዎች አሁንም እየካቱ ነው። እያንዳንዱ ከታች ያለ ረድፍ ወደ ክፍያው ዝርዝር የሚያመራ ሲሆን፣ የተጎዱ መንገዶችን ድጋሚ መሞከር ወይም የግንኙነት መረጃውን ማስተካከል ትችላላችሁ።",
      levyHeader: "ክፍያ",
      bouncedHeader: "ተመልሷል",
      latestFailureLabel: "የቅርብ ጊዜ ስህተት",
      footer: "ይህ ማጠቃለያ ያልተፈቱ ስህተቶች ባሉበት ቀን ብቻ ይላካል። ይህንን የምትቀበሉት የ {orgName} ድርጅት አስተዳዳሪ ስለሆናችሁ ነው።",
    },
    levyReceipt: {
      headerTag: "የአባል መለያ",
      payment: {
        subject: "የክፍያ ደረሰኝ — {levyName} ({orgName})",
        heading: "ክፍያ ተቀብለናል",
        intro: "ሰላም {memberName}፣ ለ <strong style=\"color:#fff;\">{levyName}</strong> የከፈልክን መዝግበናል። የቀረህ ሂሳብ ተከፍሏል።",
        amountLabel: "የተከፈለ መጠን",
      },
      partialPayment: {
        subject: "የከፊል ክፍያ ደረሰኝ — {levyName} ({orgName})",
        heading: "ከፊል ክፍያ ተቀብለናል",
        intro: "ሰላም {memberName}፣ በ <strong style=\"color:#fff;\">{levyName}</strong> ላይ የከፊል ክፍያ መዝግበናል። የቀረ ሂሳብ ይቀራል።",
        amountLabel: "የተከፈለ መጠን",
      },
      refund: {
        subject: "ተመላሽ ተደርጓል — {levyName} ({orgName})",
        heading: "ተመላሽ ተደርጓል",
        intro: "ሰላም {memberName}፣ በ <strong style=\"color:#fff;\">{levyName}</strong> ክፍያ ላይ ተመላሽ ተደርጓል።",
        amountLabel: "ተመላሽ መጠን",
      },
      waiver: {
        subject: "ክፍያ ተተውሷል — {levyName} ({orgName})",
        heading: "ክፍያ ተተውሷል",
        intro: "ሰላም {memberName}፣ የ <strong style=\"color:#fff;\">{levyName}</strong> ክፍያህ ተተውሷል። ሌላ ክፍያ የለም።",
        amountLabel: "የተተወ መጠን",
      },
      levyLabel: "ክፍያ",
      newBalanceLabel: "አዲስ ቀሪ",
      currencyLabel: "ምንዛሪ",
      noteLabel: "ማስታወሻ",
      footer: "የክፍያ ታሪክህን ሙሉ በሙሉ በማንኛውም ጊዜ ከአባል ፖርታል መመልከት ትችላለህ። የተሳሳተ ነገር ካለ፣ ለዚህ ኢሜይል መልስ ስጥ ወይም በቀጥታ ለ {orgName} አግኝ።",
    },
    documentRejected: {
      headerTag: "ሰነዶች",
      subject: "ሰነድ ትኩረት ይፈልጋል፦ {docLabel}",
      greeting: "ሰላም {memberName}፣",
      intro: "ያስቀመጥከው ሰነድ \"{docLabel}\" በ {orgName} ሰራተኞች ተገምግሟል፣ ግን መቀበል አልተቻለም።",
      reasonLabel: "ምክንያት",
      reupload: "በፍጥነት የተስተካከለውን ስሪት ከአባል ፖርታል እባክዎ እንደገና ይስቀሉ።",
    },
    documentUnrejected: {
      headerTag: "ሰነዶች",
      subject: "ውድቅነት ተነስቷል: {docLabel}",
      greeting: "ሰላም {memberName}፣",
      intro: "የ{orgName} ሰራተኞች ቀደም ሲል በሰነድዎ \"{docLabel}\" ላይ የተደረገውን ውድቅነት መልሰዋል። ሰነዱ እንደገና ለግምገማ ወረፋ ተመልሷል እና እንደገና ይገመገማል — ከእርስዎ ምንም ድርጊት አያስፈልግም።",
      noteLabel: "ከሰራተኞች ማስታወሻ",
    },
    documentPending: {
      headerTag: "ሰነዶች",
      pushTitle: "ለግምገማ የሚጠብቅ አዲስ ሰነድ",
      emailSubject: "ለግምገማ የሚጠብቅ አዲስ የአባል ሰነድ",
      body: "{memberName} ለማረጋገጥ አዲስ የ{docTypeLabel} ሰነድ (\"{docLabel}\") አስቀምጧል።",
    },
    payoutNotify: {
      headerTag: "የአሰልጣኝ ክፍያ",
      subject: "ክፍያ ተልኳል — ከ {orgName} {amount}",
      heading: "✅ ክፍያ ተልኳል",
      greeting: "ሰላም {coachName}፣ የቅርብ ጊዜ የስዊንግ ግምገማ ክፍያህ ከ <strong style=\"color:#fff;\">{orgName}</strong> ተከፍሏል ተብሎ ምልክት ተደርጓል።",
      amountLabel: "መጠን",
      referenceLabel: "ማጣቀሻ",
      notesLabel: "ማስታወሻዎች",
      eta: "ገንዘቡ በተለምዶ በ1–2 የስራ ቀናት ውስጥ በተመዘገበው አካውንትህ ይታያል፣ በባንክህ ይወሰናል።",
      footer: "የተሟላ የክፍያ ታሪክህን በማንኛውም ጊዜ ከአሰልጣኝ የስራ ቦታ ውስጥ ካለው ገቢ (Earnings) ትር ማየት ትችላለህ።",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "የክፍያ መለያ",
      subjectVerified: "የክፍያ መለያህ እንደገና ተረጋግጧል — {orgName}",
      subjectNeedsAttention: "እርምጃ ያስፈልጋል — የአስተዳዳሪ እንደገና ምርመራ የክፍያ {methodLabel} ላይ ችግር አግኝቷል",
      headingVerified: "የክፍያ መለያህ እንደገና ተረጋግጧል",
      headingNeedsAttention: "ከእንደገና ምርመራ በኋላ የክፍያ መለያህ ትኩረት ይፈልጋል",
      greeting: "ሰላም {coachName}፣",
      introVerified: "የ <strong style=\"color:#fff;\">{orgName}</strong> አስተዳዳሪ ለአሰልጣኝ ክፍያህ የተመዘገበውን {methodLabel} በእጅ እንደገና አረጋግጧል። ምርመራው በተሳካ ሁኔታ ተጠናቋል እና ክፍያህ እንደተለመደው ይቀጥላል — ምንም እርምጃ አያስፈልግም።",
      introNeedsAttention: "የ <strong style=\"color:#fff;\">{orgName}</strong> አስተዳዳሪ ለአሰልጣኝ ክፍያህ የተመዘገበውን {methodLabel} በእጅ እንደገና አረጋግጧል። ባንኩ ከእንግዲህ ልክ እንዳልሆነ ሪፖርት ስላደረገ መረጃህን እንደገና እስክታስቀምጥ ድረስ የሚቀጥለው ክፍያ ይያዛል።",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "የባንክ መለያ",
      upiRowLabel: "UPI ID",
      bankRowLabel: "የባንክ መለያ",
      reverifiedOnLabel: "እንደገና የተረጋገጠ ቀን",
      statusLabel: "ሁኔታ",
      statusValueVerified: "ተረጋግጧል",
      statusValueNeedsAttention: "ትኩረት ይፈልጋል",
      reasonLabel: "ምክንያት",
      footer: "አስተዳዳሪ መለያህን እንደገና ይመረምራል ብለህ ካልጠበቅ የድርጅትህን ድጋፍ ቡድን አግኝ። እንዲሁም በማንኛውም ጊዜ በአሰልጣኝ የስራ ቦታህ ውስጥ የክፍያ መረጃህን እንደገና በማስቀመጥ አዲስ ማረጋገጫ ራስህ መጀመር ትችላለህ።",
    },
  },

  ha: {
    bouncedDigest: {
      headerTag: "Tunatarwar Kuɗi",
      subjectOne: "⚠️ Tunatarwar kuɗi 1 da ta dawo na buƙatar kulawa — {orgName}",
      subjectMany: "⚠️ Tunatarwar kuɗi {count} da suka dawo na buƙatar kulawa — {orgName}",
      heading: "Tunatarwar kuɗi da suka dawo — taƙaitaccen ranar",
      introOne: "Sannu {staff}, har yanzu tunatarwar kuɗi 1 na ƙasawa cikin ma'anar kuɗi {leviesCount} ga {orgName}. Kowane layi a ƙasa yana haɗawa da cikakkun bayanan kuɗin inda za ka iya sake gwada hanyoyi da abin ya shafa ko gyara bayanan tuntuɓa.",
      introMany: "Sannu {staff}, har yanzu tunatarwar kuɗi {count} suna ƙasawa cikin ma'anonin kuɗi {leviesCount} ga {orgName}. Kowane layi a ƙasa yana haɗawa da cikakkun bayanan kuɗin inda za ka iya sake gwada hanyoyi da abin ya shafa ko gyara bayanan tuntuɓa.",
      levyHeader: "Kuɗi",
      bouncedHeader: "Ya dawo",
      latestFailureLabel: "Ƙasawa na ƙarshe",
      footer: "Wannan taƙaitaccen ana aikawa ne kawai a kwanakin da ake da matsalolin da ba a warware ba. Kana karbar wannan saboda kai mai gudanar da ƙungiyar {orgName} ne.",
    },
    levyReceipt: {
      headerTag: "Asusun Memba",
      payment: {
        subject: "Rasit ɗin biya — {levyName} ({orgName})",
        heading: "An karɓi biya",
        intro: "Sannu {memberName}, mun rikodi biyanka don <strong style=\"color:#fff;\">{levyName}</strong>. An kammala biyan kuɗinka.",
        amountLabel: "Adadin da aka biya",
      },
      partialPayment: {
        subject: "Rasit ɗin biya na bangare — {levyName} ({orgName})",
        heading: "An karɓi biya na bangare",
        intro: "Sannu {memberName}, mun rikodi biya na bangare don <strong style=\"color:#fff;\">{levyName}</strong>. Akwai sauran kuɗi da ya rage.",
        amountLabel: "Adadin da aka biya",
      },
      refund: {
        subject: "An mayar da kuɗi — {levyName} ({orgName})",
        heading: "An mayar da kuɗi",
        intro: "Sannu {memberName}, an mayar da kuɗi don kuɗin <strong style=\"color:#fff;\">{levyName}</strong>.",
        amountLabel: "Adadin da aka mayar",
      },
      waiver: {
        subject: "An yafe biya — {levyName} ({orgName})",
        heading: "An yafe biya",
        intro: "Sannu {memberName}, an yafe kuɗin <strong style=\"color:#fff;\">{levyName}</strong>. Babu sauran abin biya.",
        amountLabel: "Adadin da aka yafe",
      },
      levyLabel: "Kuɗi",
      newBalanceLabel: "Sabon saura",
      currencyLabel: "Kuɗin ƙasa",
      noteLabel: "Bayani",
      footer: "Kana iya duba cikakkun tarihin biya a kowane lokaci daga tashar memba. Idan akwai abin da ba daidai ba, ka mayar da wannan email ko ka tuntuɓi {orgName} kai tsaye.",
    },
    documentRejected: {
      headerTag: "Takardu",
      subject: "Takarda na buƙatar kulawa: {docLabel}",
      greeting: "Sannu {memberName},",
      intro: "Ma'aikatan {orgName} sun bincika takardar da ka loda \"{docLabel}\" kuma ba a karɓe ta ba.",
      reasonLabel: "Dalili",
      reupload: "Da fatan za a sake loda nau'in da aka gyara daga tashar memba a cikin ƙanƙanin lokaci.",
    },
    documentUnrejected: {
      headerTag: "Takardu",
      subject: "An janye ƙin yarda: {docLabel}",
      greeting: "Sannu {memberName},",
      intro: "Ma'aikatan {orgName} sun janye ƙin yarda na baya na takardar ku \"{docLabel}\". Ta dawo cikin layin jira kuma za a sake duba ta — babu wani aiki da ake buƙata daga gare ku.",
      noteLabel: "Sanarwa daga ma'aikata",
    },
    documentPending: {
      headerTag: "Takardu",
      pushTitle: "Sabuwar takarda na jiran bita",
      emailSubject: "Sabuwar takardar memba na jiran bita",
      body: "{memberName} ya loda sabuwar takardar {docTypeLabel} (\"{docLabel}\") domin tabbatarwa.",
    },
    payoutNotify: {
      headerTag: "Biyan Mai Horarwa",
      subject: "An aika biya — {amount} daga {orgName}",
      heading: "✅ An aika biya",
      greeting: "Sannu {coachName}, biyan ku na ƙarshe na bita na swing daga <strong style=\"color:#fff;\">{orgName}</strong> an yi masa alama a matsayin biyayyaye.",
      amountLabel: "Adadi",
      referenceLabel: "Magana",
      notesLabel: "Bayanai",
      eta: "Kuɗin galibi yana bayyana a asusun da kuka rajista cikin kwanaki 1–2 na aiki, dangane da bankinku.",
      footer: "Kana iya duba cikakkun tarihin biya a kowane lokaci daga shafin Kuɗin Shiga (Earnings) a wurin aiki na mai horarwa.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Asusun Biya",
      subjectVerified: "An sake tabbatar da asusun biyan ku — {orgName}",
      subjectNeedsAttention: "Ana buƙatar mataki — sake binciken admin ya gano matsala a {methodLabel} na biyanku",
      headingVerified: "An sake tabbatar da asusun biyan ku",
      headingNeedsAttention: "Asusun biyan ku na buƙatar kulawa bayan sake bincike",
      greeting: "Sannu {coachName},",
      introVerified: "Manaja a <strong style=\"color:#fff;\">{orgName}</strong> ya sake tabbatar da {methodLabel} da aka rajista don biyan mai horarwa naku da hannu. An kammala binciken cikin nasara kuma biyanku zai ci gaba kamar yadda aka saba — ba a buƙatar wani mataki.",
      introNeedsAttention: "Manaja a <strong style=\"color:#fff;\">{orgName}</strong> ya sake tabbatar da {methodLabel} da aka rajista don biyan mai horarwa naku da hannu. Bankin ya bayar da rahoton cewa ba ya aiki kuma, don haka biyan ku na gaba zai jinkirta har sai kun sake adana bayanan ku.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "asusun banki",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Asusun banki",
      reverifiedOnLabel: "An sake tabbatarwa a",
      statusLabel: "Matsayi",
      statusValueVerified: "An tabbatar",
      statusValueNeedsAttention: "Yana buƙatar kulawa",
      reasonLabel: "Dalili",
      footer: "Idan ba ku tsammanin admin zai sake bincika asusun ku ba, tuntuɓi ƙungiyar tallafi ta ƙungiyar ku. Hakanan kuna iya sake adana bayanan biyan ku a wurin aiki na mai horarwa a kowane lokaci don fara sabon tabbatarwa da kanku.",
    },
  },

  zu: {
    bouncedDigest: {
      headerTag: "Izikhumbuzi Zentela",
      subjectOne: "⚠️ Isikhumbuzi sentela esi-1 esibuyile sidinga ukunakekelwa — {orgName}",
      subjectMany: "⚠️ Izikhumbuzi zentela ezi-{count} ezibuyile zidinga ukunakekelwa — {orgName}",
      heading: "Izikhumbuzi zentela ezibuyile — isifinyezo sansuku zonke",
      introOne: "Sawubona {staff}, isikhumbuzi sentela esi-1 sisahluleka kuyo yonke incazelo yentela ene-{leviesCount} ye-{orgName}. Umugqa ngamunye ngezansi uxhumana nemininingwane yentela lapho ungazama futhi izinkundla ezithintekayo noma ulungise imininingwane yokuxhumana.",
      introMany: "Sawubona {staff}, izikhumbuzi zentela ezi-{count} zisahluleka kuzo zonke izincazelo zentela ezi-{leviesCount} ze-{orgName}. Umugqa ngamunye ngezansi uxhumana nemininingwane yentela lapho ungazama futhi izinkundla ezithintekayo noma ulungise imininingwane yokuxhumana.",
      levyHeader: "Intela",
      bouncedHeader: "Kubuyele",
      latestFailureLabel: "Ukungaphumeleli kwakamuva",
      footer: "Lesi sifinyezo sithunyelwa kuphela ezinsukwini ezinokungaphumeleli okungaxazululiwe. Uthola lokhu ngoba ungumphathi wenhlangano ye-{orgName}.",
    },
    levyReceipt: {
      headerTag: "I-akhawunti Yelungu",
      payment: {
        subject: "Irisidi yenkokhelo — {levyName} ({orgName})",
        heading: "Inkokhelo itholiwe",
        intro: "Sawubona {memberName}, sirekhode inkokhelo yakho ye-<strong style=\"color:#fff;\">{levyName}</strong>. Ibhalansi yakho isikhokhelwe ngokugcwele.",
        amountLabel: "Inani elikhokhiwe",
      },
      partialPayment: {
        subject: "Irisidi yenkokhelo eyengxenye — {levyName} ({orgName})",
        heading: "Inkokhelo eyengxenye itholiwe",
        intro: "Sawubona {memberName}, sirekhode inkokhelo eyengxenye ku-<strong style=\"color:#fff;\">{levyName}</strong>. Kusenebhalansi engakakhokhwa.",
        amountLabel: "Inani elikhokhiwe",
      },
      refund: {
        subject: "Imali ibuyiselwe — {levyName} ({orgName})",
        heading: "Imali ibuyiselwe",
        intro: "Sawubona {memberName}, imali ibuyiselwe ku-<strong style=\"color:#fff;\">{levyName}</strong> wakho.",
        amountLabel: "Inani elibuyiselwe",
      },
      waiver: {
        subject: "Inkokhelo ixoliwe — {levyName} ({orgName})",
        heading: "Inkokhelo ixoliwe",
        intro: "Sawubona {memberName}, inkokhelo yakho ye-<strong style=\"color:#fff;\">{levyName}</strong> ixoliwe. Akusekho lutho okusele ukukhokha.",
        amountLabel: "Inani elixoliwe",
      },
      levyLabel: "Intela",
      newBalanceLabel: "Ibhalansi entsha",
      currencyLabel: "Imali",
      noteLabel: "Inothi",
      footer: "Ungabuka umlando ophelele wenkokhelo nganoma yisiphi isikhathi engxenyeni yelungu. Uma kukhona okungalungile, sicela uphendule le-imeyili noma uxhumane no-{orgName} ngokuqondile.",
    },
    documentRejected: {
      headerTag: "Amadokhumenti",
      subject: "Idokhumenti idinga ukunakekelwa: {docLabel}",
      greeting: "Sawubona {memberName},",
      intro: "Idokhumenti olayishile \"{docLabel}\" ibuyekezwe abasebenzi be-{orgName} kodwa ayikwazanga ukwamukelwa.",
      reasonLabel: "Isizathu",
      reupload: "Sicela ulayishe kabusha inguqulo elungisiwe engxenyeni yelungu ngokushesha okukhulu.",
    },
    documentUnrejected: {
      headerTag: "Amadokhumenti",
      subject: "Ukunqatshelwa kususiwe: {docLabel}",
      greeting: "Sawubona {memberName},",
      intro: "Abasebenzi be-{orgName} bakhiphe ukunqatshelwa kwangaphambili kwedokhumenti yakho ethi \"{docLabel}\". Sebuyele kulayini olindile futhi kuzobuyekezwa futhi — akukho sinyathelo esidingekayo kuwe.",
      noteLabel: "Inothi kubasebenzi",
    },
    documentPending: {
      headerTag: "Amadokhumenti",
      pushTitle: "Idokhumenti elisha lilinde ukubuyekezwa",
      emailSubject: "Idokhumenti elisha lelungu lilinde ukubuyekezwa",
      body: "I-{memberName} ilayishe idokhumenti elisha le-{docTypeLabel} (\"{docLabel}\") ukuze kuqinisekiswe.",
    },
    payoutNotify: {
      headerTag: "Inkokhelo Yomqeqeshi",
      subject: "Inkokhelo ithunyelwe — {amount} kusuka ku-{orgName}",
      heading: "✅ Inkokhelo ithunyelwe",
      greeting: "Sawubona {coachName}, inkokhelo yakho yokugcina yokubuyekezwa kwe-swing kusuka ku-<strong style=\"color:#fff;\">{orgName}</strong> imakwe njengekhokhiwe.",
      amountLabel: "Inani",
      referenceLabel: "Inkomba",
      notesLabel: "Amanothi",
      eta: "Imali ngokuvamile ivela ku-akhawunti yakho ebhalisiwe phakathi kwezinsuku ezi-1–2 zomsebenzi, kuya ngebhange lakho.",
      footer: "Ungabuyekeza umlando ophelele wenkokhelo nganoma yisiphi isikhathi kusuka ethebhini le-Inzuzo (Earnings) endaweni yakho yokusebenza yomqeqeshi.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "I-akhawunti Yenkokhelo",
      subjectVerified: "I-akhawunti yakho yenkokhelo iqinisekiswe kabusha — {orgName}",
      subjectNeedsAttention: "Kudingeka isenzo — ukuhlola kabusha komlawuli kuphawule i-{methodLabel} yakho yenkokhelo",
      headingVerified: "I-akhawunti yakho yenkokhelo iqinisekiswe kabusha",
      headingNeedsAttention: "I-akhawunti yakho yenkokhelo idinga ukunakekelwa ngemuva kokuhlola kabusha",
      greeting: "Sawubona {coachName},",
      introVerified: "Umlawuli ku-<strong style=\"color:#fff;\">{orgName}</strong> uqinisekise kabusha ngokungokwakhe i-{methodLabel} ebhalisiwe yenkokhelo zakho zomqeqeshi. Ukuhlolwa kuphothuliwe ngempumelelo futhi izinkokhelo zakho ziyoqhubeka ngokuvamile — akudingeki isinyathelo.",
      introNeedsAttention: "Umlawuli ku-<strong style=\"color:#fff;\">{orgName}</strong> uqinisekise kabusha ngokungokwakhe i-{methodLabel} ebhalisiwe yenkokhelo zakho zomqeqeshi. Ibhange libike ukuthi ayisasebenzi, ngakho-ke inkokhelo yakho elandelayo izobanjelwa kuze kube ulondoloze imininingwane yakho futhi.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "i-akhawunti yebhange",
      upiRowLabel: "UPI ID",
      bankRowLabel: "I-akhawunti yebhange",
      reverifiedOnLabel: "Iqinisekiswe kabusha ngo",
      statusLabel: "Isimo",
      statusValueVerified: "Iqinisekisiwe",
      statusValueNeedsAttention: "Idinga ukunakekelwa",
      reasonLabel: "Isizathu",
      footer: "Uma ubungalindele ukuthi umlawuli ahlole kabusha i-akhawunti yakho, xhumana neqembu lokweseka lenhlangano yakho. Ungaphinda ulondoloze imininingwane yakho yenkokhelo endaweni yakho yokusebenza yomqeqeshi nganoma yisiphi isikhathi ukuze uqalise ukuqinisekiswa okusha ngokwakho.",
    },
  },

  yo: {
    bouncedDigest: {
      headerTag: "Ìránnilétí Owó",
      subjectOne: "⚠️ Ìránnilétí owó 1 tó padà nílò àfiyèsí — {orgName}",
      subjectMany: "⚠️ Ìránnilétí owó {count} tó padà nílò àfiyèsí — {orgName}",
      heading: "Ìránnilétí owó tó padà — àkójọpọ̀ ojoojúmọ́",
      introOne: "Pẹ̀lẹ́ {staff}, ìránnilétí owó 1 ṣì ń kùnà ní àwọn ìtumọ̀ owó {leviesCount} fún {orgName}. Ìlà kọ̀ọ̀kan ní ìsàlẹ̀ so mọ́ àwọn àlàyé owó níbi tí o lè gbìyànjú àwọn ìkànnì tí ó kan tàbí tún àwọn ìpèdè ṣe.",
      introMany: "Pẹ̀lẹ́ {staff}, ìránnilétí owó {count} ṣì ń kùnà ní àwọn ìtumọ̀ owó {leviesCount} fún {orgName}. Ìlà kọ̀ọ̀kan ní ìsàlẹ̀ so mọ́ àwọn àlàyé owó níbi tí o lè gbìyànjú àwọn ìkànnì tí ó kan tàbí tún àwọn ìpèdè ṣe.",
      levyHeader: "Owó",
      bouncedHeader: "Ó padà",
      latestFailureLabel: "Ìkùnà tó ṣẹ̀ṣẹ̀",
      footer: "Àkójọpọ̀ yìí ni a fi ránṣẹ́ kìkì ní àwọn ọjọ́ tí àwọn ìkùnà ṣì wà láìparí. O ń gba èyí nítorí pé o jẹ́ alábojútó àjọ fún {orgName}.",
    },
    levyReceipt: {
      headerTag: "Àkáùnti Ọmọ Ẹgbẹ́",
      payment: {
        subject: "Ìwé ìgbówó — {levyName} ({orgName})",
        heading: "A ti gba owó náà",
        intro: "Pẹ̀lẹ́ {memberName}, a ti ṣe àkọsílẹ̀ owó tí o san fún <strong style=\"color:#fff;\">{levyName}</strong>. Ìyókù rẹ ti pari sísan.",
        amountLabel: "Iye tí a san",
      },
      partialPayment: {
        subject: "Ìwé ìgbówó apá kan — {levyName} ({orgName})",
        heading: "A ti gba ìsanwó apá kan",
        intro: "Pẹ̀lẹ́ {memberName}, a ti ṣe àkọsílẹ̀ ìsanwó apá kan lórí <strong style=\"color:#fff;\">{levyName}</strong>. Ìyókù ṣì wà láti san.",
        amountLabel: "Iye tí a san",
      },
      refund: {
        subject: "A dá owó padà — {levyName} ({orgName})",
        heading: "A dá owó padà",
        intro: "Pẹ̀lẹ́ {memberName}, a dá owó padà lórí ìdíyelé <strong style=\"color:#fff;\">{levyName}</strong> rẹ.",
        amountLabel: "Iye tí a dá padà",
      },
      waiver: {
        subject: "A yọ ìdíyelé kúrò — {levyName} ({orgName})",
        heading: "A yọ ìdíyelé kúrò",
        intro: "Pẹ̀lẹ́ {memberName}, ìdíyelé <strong style=\"color:#fff;\">{levyName}</strong> rẹ ti yọ kúrò. Kò sí ohun kankan tí ó kù láti san.",
        amountLabel: "Iye tí a yọ kúrò",
      },
      levyLabel: "Owó",
      newBalanceLabel: "Ìyókù tuntun",
      currencyLabel: "Owó orílẹ̀-èdè",
      noteLabel: "Àkíyèsí",
      footer: "O lè wo ìtàn ìsanwó pípé nígbà yòówù láti inú ojú-ọ̀nà ọmọ ẹgbẹ́. Bí ohunkóhun bá dabi pé kò tọ́, jọ̀wọ́ dáhùn àmèèlì yìí tàbí kàn sí {orgName} tààrà.",
    },
    documentRejected: {
      headerTag: "Àwọn Ìwé",
      subject: "Ìwé nílò àfiyèsí: {docLabel}",
      greeting: "Pẹ̀lẹ́ {memberName},",
      intro: "Àwọn òṣìṣẹ́ {orgName} ti ṣàyẹ̀wò ìwé tí o gbé sókè \"{docLabel}\" ṣùgbọ́n a kò lè gbà á.",
      reasonLabel: "Ìdí",
      reupload: "Jọ̀wọ́ tún gbé ìpele tí a ṣàtúnṣe sókè láti inú ojú-ọ̀nà ọmọ ẹgbẹ́ ní kíákíá tó bá ṣeé ṣe.",
    },
    documentUnrejected: {
      headerTag: "Àwọn Ìwé",
      subject: "Ìkọ̀sílẹ̀ ti gbà padà: {docLabel}",
      greeting: "Pẹ̀lẹ́ {memberName},",
      intro: "Àwọn òṣìṣẹ́ {orgName} ti gba ìkọ̀sílẹ̀ tí ó ṣẹlẹ̀ tẹ́lẹ̀ lórí ìwé rẹ \"{docLabel}\" padà. Ó ti padà sínú ìlà ìdúró fún àyẹ̀wò àti yóò ṣe àyẹ̀wò rẹ̀ lẹ́ẹ̀kan sí — kò sí ìgbésẹ̀ kankan tí o nílò láti ṣe.",
      noteLabel: "Àkíyèsí láti ọ̀dọ̀ àwọn òṣìṣẹ́",
    },
    documentPending: {
      headerTag: "Àwọn Ìwé",
      pushTitle: "Ìwé tuntun tó ń dúró fún àyẹ̀wò",
      emailSubject: "Ìwé ọmọ ẹgbẹ́ tuntun tó ń dúró fún àyẹ̀wò",
      body: "{memberName} ti gbé ìwé {docTypeLabel} tuntun sókè (\"{docLabel}\") fún ìfọwọ́sí.",
    },
    payoutNotify: {
      headerTag: "Ìsanwó Olùdánilẹ́kọ̀ọ́",
      subject: "A ti rán ìsanwó — {amount} láti {orgName}",
      heading: "✅ A ti rán ìsanwó",
      greeting: "Pẹ̀lẹ́ {coachName}, ìsanwó tuntun fún àyẹ̀wò swing rẹ láti <strong style=\"color:#fff;\">{orgName}</strong> ni a ti samisi pé a ti san.",
      amountLabel: "Iye",
      referenceLabel: "Ìtọ́kasí",
      notesLabel: "Àkíyèsí",
      eta: "Owó ńṣe máa ń farahàn nínú àkáùntì rẹ tí a forúkọsílẹ̀ láàrín ọjọ́ iṣẹ́ 1–2, gẹ́gẹ́ bí ilé-ìfowópamọ́ rẹ ṣe wí.",
      footer: "O lè wo ìtàn ìsanwó pípé nígbà yòówù láti inú ojú-iwé Owó-Wíwọlé (Earnings) nínú ààyè iṣẹ́ olùdánilẹ́kọ̀ọ́ rẹ.",
    },
    payoutAccountReverifiedByAdmin: {
      headerTag: "Àkáùntì Ìsanwó",
      subjectVerified: "A ti ṣàyẹ̀wò àkáùntì ìsanwó rẹ lẹ́ẹ̀kan sí — {orgName}",
      subjectNeedsAttention: "Ìgbésẹ̀ nílò — àyẹ̀wò atúnṣe ti alábòójútó ti samisi {methodLabel} ìsanwó rẹ",
      headingVerified: "A ti ṣàyẹ̀wò àkáùntì ìsanwó rẹ lẹ́ẹ̀kan sí",
      headingNeedsAttention: "Àkáùntì ìsanwó rẹ nílò àfiyèsí lẹ́yìn ìṣàyẹ̀wò atúnṣe",
      greeting: "Pẹ̀lẹ́ {coachName},",
      introVerified: "Alábòójútó ní <strong style=\"color:#fff;\">{orgName}</strong> ti ṣàyẹ̀wò {methodLabel} tí a fi forúkọsílẹ̀ fún ìsanwó olùdánilẹ́kọ̀ọ́ rẹ pẹ̀lú ọwọ́ lẹ́ẹ̀kan sí. Àyẹ̀wò náà parí pẹ̀lú àṣeyọrí àti àwọn ìsanwó rẹ yóò ń lọ bí ìṣe — kò sí ìgbésẹ̀ tí a nílò.",
      introNeedsAttention: "Alábòójútó ní <strong style=\"color:#fff;\">{orgName}</strong> ti ṣàyẹ̀wò {methodLabel} tí a fi forúkọsílẹ̀ fún ìsanwó olùdánilẹ́kọ̀ọ́ rẹ pẹ̀lú ọwọ́ lẹ́ẹ̀kan sí. Ilé-ìfowópamọ́ ti sọ pé kò tún wúlò mọ́, nítorí náà ìsanwó rẹ tó kàn yóò di ìdúró títí tí o ó fi tún tọ́jú àwọn alaye rẹ.",
      upiInlineLabel: "UPI ID",
      bankInlineLabel: "àkáùntì ilé-ìfowópamọ́",
      upiRowLabel: "UPI ID",
      bankRowLabel: "Àkáùntì ilé-ìfowópamọ́",
      reverifiedOnLabel: "A ṣàyẹ̀wò lẹ́ẹ̀kan sí ní",
      statusLabel: "Ipò",
      statusValueVerified: "Ti ṣàyẹ̀wò",
      statusValueNeedsAttention: "Nílò àfiyèsí",
      reasonLabel: "Ìdí",
      footer: "Tí o kò bá retí pé alábòójútó yóò ṣàyẹ̀wò àkáùntì rẹ lẹ́ẹ̀kan sí, kàn sí ẹgbẹ́ ìrànlọ́wọ́ ti àjọ rẹ. O tún lè tún tọ́jú àwọn alaye ìsanwó rẹ ní ààyè iṣẹ́ olùdánilẹ́kọ̀ọ́ rẹ ní ìgbà yòówù láti bẹ̀rẹ̀ ìfọwọ́sí tuntun fúnra rẹ.",
    },
  },
};

export function isSupportedAdminEmailLang(
  lang: string | null | undefined,
): lang is AdminEmailLang {
  return !!lang && (ADMIN_EMAIL_LANGS as string[]).includes(lang);
}

/**
 * Resolve the localised string pack for `lang`, returning the entire shape so
 * callers can pull whatever fields they need for the specific email kind.
 * Falls back to English for unknown / unsupported codes (mirrors the helper
 * pattern in `customDomainEmailI18n.ts`).
 */
export function getAdminEmailStrings(
  lang: string | null | undefined,
): AdminEmailStrings {
  const code = isSupportedAdminEmailLang(lang) ? lang : "en";
  return PACKS[code];
}

/**
 * Convenience helper mirroring the task description: returns the strings for
 * a single email `kind`. Useful at call sites that only need one section.
 */
export function getEmailStrings<K extends AdminEmailKind>(
  lang: string | null | undefined,
  kind: K,
): AdminEmailStrings[K] {
  return getAdminEmailStrings(lang)[kind];
}

/* ──────────────────────────────────────────────────────────────────────────
 * Task #1267 — short notification copy for member-document rejection
 *
 * `documentRejectedNotify.ts` fans out the same rejection notice across the
 * in-app inbox, push, SMS and WhatsApp channels. Task #1099 only translated
 * the email body, so the other channels still rendered hardcoded English on
 * non-English clubs. Rather than ship a parallel translation pack, the
 * helper below composes the localised channel bodies directly from the
 * existing `documentRejected` strings (subject / greeting / intro /
 * reasonLabel / reupload) — they are already plain text, already cover the
 * 21 supported languages, and produce identical English to the previous
 * hardcoded literals when composed.
 *
 * Falls back to English for unknown / unsupported language codes via
 * `getEmailStrings`.
 * ────────────────────────────────────────────────────────────────────────── */

export interface DocumentRejectedNotification {
  /** In-app `member_messages.subject`. */
  inAppSubject: string;
  /** In-app `member_messages.body`, mirrors the previous EN multi-paragraph layout. */
  inAppBody: string;
  /** Push notification title — same as the in-app subject. */
  pushTitle: string;
  /** Push notification body — truncated to 200 chars (Apple/Android friendly). */
  pushBody: string;
  /** SMS body — `subject\nbody`, truncated to 480 chars (mirrors the previous EN slice). */
  smsBody: string;
  /** WhatsApp body — same shape as SMS so providers receive a single short message. */
  whatsappBody: string;
}

export function composeDocumentRejectedNotification(opts: {
  lang?: string | null;
  /** Pre-formatted "Firstname Lastname" or fallback (e.g. "there"). */
  memberName: string;
  /** Document title or document type when title is missing. */
  docLabel: string;
  /** Organisation display name. */
  orgName: string;
  /** Free-text staff-supplied rejection reason. */
  reason: string;
}): DocumentRejectedNotification {
  const s = getEmailStrings(opts.lang ?? null, "documentRejected");
  const inAppSubject = _fmtTemplate(s.subject, { docLabel: opts.docLabel });
  const greetingLine = _fmtTemplate(s.greeting, { memberName: opts.memberName });
  const introLine = _fmtTemplate(s.intro, {
    docLabel: opts.docLabel,
    orgName: opts.orgName,
  });
  const reasonLine = `${s.reasonLabel}: ${opts.reason}`;
  const inAppBody = [greetingLine, introLine, reasonLine, s.reupload].join("\n\n");
  const pushTitle = inAppSubject;
  const pushBody =
    inAppBody.length > 200 ? inAppBody.slice(0, 197) + "..." : inAppBody;
  const sms = `${inAppSubject}\n${inAppBody}`.slice(0, 480);
  return {
    inAppSubject,
    inAppBody,
    pushTitle,
    pushBody,
    smsBody: sms,
    whatsappBody: sms,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Task #1538 — short notification copy for member-document UN-rejection
 *
 * `documentUnrejectedNotify.ts` is the sibling of `documentRejectedNotify.ts`
 * — staff have *withdrawn* a previous rejection, so the previously rejected
 * document is now back in the pending queue. It fans out the same notice
 * across the in-app inbox, push, SMS, and WhatsApp channels.
 *
 * Mirrors `composeDocumentRejectedNotification`: the helper composes the
 * localised channel bodies directly from a small `documentUnrejected` pack so
 * a Hindi/Arabic/Spanish/etc. club no longer receives English-only copy on
 * the operations channels.
 *
 * Falls back to English for unknown / unsupported language codes via
 * `getEmailStrings`.
 * ────────────────────────────────────────────────────────────────────────── */

export interface DocumentUnrejectedNotification {
  /** In-app `member_messages.subject`. */
  inAppSubject: string;
  /** In-app `member_messages.body`, mirrors the previous EN multi-paragraph layout. */
  inAppBody: string;
  /** Push notification title — same as the in-app subject. */
  pushTitle: string;
  /** Push notification body — truncated to 200 chars (Apple/Android friendly). */
  pushBody: string;
  /** SMS body — `subject\nbody`, truncated to 480 chars (mirrors the previous EN slice). */
  smsBody: string;
  /** WhatsApp body — same shape as SMS so providers receive a single short message. */
  whatsappBody: string;
}

export function composeDocumentUnrejectedNotification(opts: {
  lang?: string | null;
  /** Pre-formatted "Firstname Lastname" or fallback (e.g. "there"). */
  memberName: string;
  /** Document title or document type when title is missing. */
  docLabel: string;
  /** Organisation display name. */
  orgName: string;
  /** Optional free-text staff-supplied note explaining the withdrawal. */
  reason?: string | null;
}): DocumentUnrejectedNotification {
  const s = getEmailStrings(opts.lang ?? null, "documentUnrejected");
  const inAppSubject = _fmtTemplate(s.subject, { docLabel: opts.docLabel });
  const greetingLine = _fmtTemplate(s.greeting, { memberName: opts.memberName });
  const introLine = _fmtTemplate(s.intro, {
    docLabel: opts.docLabel,
    orgName: opts.orgName,
  });
  const parts = [greetingLine, introLine];
  if (opts.reason && opts.reason.trim()) {
    parts.push(`${s.noteLabel}: ${opts.reason.trim()}`);
  }
  const inAppBody = parts.join("\n\n");
  const pushTitle = inAppSubject;
  const pushBody =
    inAppBody.length > 200 ? inAppBody.slice(0, 197) + "..." : inAppBody;
  const sms = `${inAppSubject}\n${inAppBody}`.slice(0, 480);
  return {
    inAppSubject,
    inAppBody,
    pushTitle,
    pushBody,
    smsBody: sms,
    whatsappBody: sms,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Task #1909 — short notification copy for the staff "new member document
 * awaiting review" notice
 *
 * `documentPendingStaffNotify.ts` fans out the same notice to all org_admin
 * and membership_secretary staff via push (`pushTitle` + `body`) and email
 * (`emailSubject` + `body`). Previously hardcoded English at the call site
 * in `portal.ts`. Mirrors the rejected/unrejected helpers but with only the
 * two channels actually used by the staff fanout (no member-facing in-app /
 * SMS / WhatsApp).
 *
 * Falls back to English for unknown / unsupported language codes via
 * `getEmailStrings`.
 * ────────────────────────────────────────────────────────────────────────── */

export interface DocumentPendingStaffNotification {
  /** Push notification title — short, no tokens. */
  pushTitle: string;
  /** Push notification body — truncated to 200 chars (Apple/Android friendly). */
  pushBody: string;
  /** Email subject line. */
  emailSubject: string;
  /** Email body (also reused as the un-truncated push source). */
  emailBody: string;
}

export function composeDocumentPendingStaffNotification(opts: {
  lang?: string | null;
  /** Pre-formatted "Firstname Lastname" or display fallback (e.g. "A member"). */
  memberName: string;
  /** Document type already humanised (underscores replaced with spaces). */
  docTypeLabel: string;
  /** Document title supplied by the member. */
  docLabel: string;
}): DocumentPendingStaffNotification {
  const s = getEmailStrings(opts.lang ?? null, "documentPending");
  const body = _fmtTemplate(s.body, {
    memberName: opts.memberName,
    docTypeLabel: opts.docTypeLabel,
    docLabel: opts.docLabel,
  });
  const pushBody = body.length > 200 ? body.slice(0, 197) + "..." : body;
  return {
    pushTitle: s.pushTitle,
    pushBody,
    emailSubject: s.emailSubject,
    emailBody: body,
  };
}
