/**
 * Translations for the data-export "Your data export is ready" notice
 * (`completed_export`, Task #618) and the 24-hour-before reminder
 * (`export_expiring`, Task #922) sent by `sendDataRequestEmail` in
 * `mailer.ts`.
 *
 * The unsubscribe confirmation page reached from the embedded
 * "stop reminding me" link is already localised
 * (`exportReminderUnsubPageI18n.ts`, Task #1437). Until this module
 * landed the emails themselves rendered in English regardless of the
 * recipient's preferred language, so a Hindi/Arabic/etc. member who
 * clicked through saw a fully localised confirmation page from a
 * fully English email. Task #1745 closes that gap by translating the
 * subject, heading, intro, button label, and the inline opt-out
 * sentence (alongside the supporting body copy) for every code in the
 * `supported_language` enum.
 *
 * Mirrors the per-language map pattern used by `walletRefundI18n.ts`
 * and `exportReminderUnsubPageI18n.ts`. English is the canonical
 * source — it's a verbatim copy of the strings previously hard-coded
 * inside the mailer switch so the wording doesn't drift. Unknown or
 * missing language codes safely fall back to English (see
 * {@link resolveDataExportEmailLang}).
 *
 * The recipient's preferred language is already resolved inside
 * `notifyDataRequest` (for the unsub URL `lang=` hint) — the same
 * value flows through `sendDataRequestEmail({ lang })` so a single
 * lookup drives both the email body and the confirmation page.
 */

export type DataExportEmailLang =
  | "en" | "hi" | "ar" | "es" | "fr" | "de" | "pt"
  | "ja" | "ko" | "zh" | "th" | "ms" | "id" | "vi"
  | "fil" | "sw" | "af" | "am" | "ha" | "zu" | "yo";

export const DATA_EXPORT_EMAIL_LANGS: DataExportEmailLang[] = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

export function isSupportedDataExportEmailLang(
  lang: string | null | undefined,
): lang is DataExportEmailLang {
  return !!lang && (DATA_EXPORT_EMAIL_LANGS as string[]).includes(lang);
}

/** Resolve the language pack, falling back to English. */
export function resolveDataExportEmailLang(
  lang: string | null | undefined,
): DataExportEmailLang {
  return isSupportedDataExportEmailLang(lang) ? lang : "en";
}

/** BCP-47 locale used for `Intl.DateTimeFormat` per supported language. */
const LOCALE_BY_LANG: Record<DataExportEmailLang, string> = {
  en: "en-US", hi: "hi-IN", ar: "ar", es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR",
  ja: "ja-JP", ko: "ko-KR", zh: "zh-CN", th: "th-TH", ms: "ms-MY", id: "id-ID", vi: "vi-VN",
  fil: "fil-PH", sw: "sw-KE", af: "af-ZA", am: "am-ET", ha: "ha-NG", zu: "zu-ZA", yo: "yo-NG",
};

/**
 * Format a date as a long-style string in the recipient's locale, with a
 * graceful fallback to the English long-form so a runtime that doesn't
 * carry the locale's date data still produces a readable label.
 */
export function formatDataExportEmailDate(
  date: Date,
  lang: DataExportEmailLang,
): string {
  try {
    return new Intl.DateTimeFormat(LOCALE_BY_LANG[lang], {
      year: "numeric", month: "long", day: "numeric",
    }).format(date);
  } catch {
    return date.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
  }
}

interface KindCopy {
  /** Subject line. Placeholders: {ref}, {orgName}. */
  subject: string;
  /** `<h2>` heading inside the email. */
  heading: string;
  /** Greeting + intro paragraph. Placeholders: {name}, {orgName}. */
  intro: string;
  /** Lead sentence above the download CTA when a one-tap link is present. */
  bodyWithLinkLead: string;
  /** Text inside the green/amber download button. */
  bodyButtonLabel: string;
  /** Hint shown below the button (in case the button doesn't work). Placeholders: {orgName}. */
  bodyFallbackHint: string;
  /** Body shown when no signed link is available — direct members to the app instead. Placeholders: {orgName}. */
  bodyNoLink: string;
  /** Opt-out sentence shown above the link text. May be empty (e.g. for the reminder). */
  optOutLead: string;
  /** Inline link text rendered as the unsubscribe anchor. */
  optOutLinkText: string;
  /** Trailing copy after the link text. May be empty. */
  optOutTrailing: string;
}

interface LangPack {
  /** BCP-47-ish HTML `lang` attribute hint. */
  htmlLang: string;
  /** Set on the outer block for right-to-left scripts. */
  dir: "ltr" | "rtl";
  /** Subtitle rendered in the branded header. */
  headerTag: string;
  /** Field labels in the metadata table. */
  labelReference: string;
  labelRequestType: string;
  labelFiledOn: string;
  labelDueBy: string;
  /** Localised type label for "Data export (portability)" — these emails are only fired for export requests. */
  typeLabelExport: string;
  /** Boilerplate footer paragraph. Placeholders: {orgName}. */
  footerNote: string;
  completed: KindCopy;
  expiring: KindCopy;
}

const PACKS: Record<DataExportEmailLang, LangPack> = {
  en: {
    htmlLang: "en",
    dir: "ltr",
    headerTag: "Data Protection",
    labelReference: "Reference",
    labelRequestType: "Request type",
    labelFiledOn: "Filed on",
    labelDueBy: "Due by",
    typeLabelExport: "Data export (portability)",
    footerNote: "If you have questions about this request, reply to this email or contact {orgName} directly.",
    completed: {
      subject: "Your data export is ready (#{ref})",
      heading: "Your data export is ready to download",
      intro: "Hi {name}, the personal-data export you requested from {orgName} has finished and is ready to download.",
      bodyWithLinkLead: "Tap the button below to download your archive. The link is private to you and expires in 7 days — please save the file somewhere safe before it expires.",
      bodyButtonLabel: "⬇ Download my data archive",
      bodyFallbackHint: "If the button doesn't work you can also open the Privacy screen in the {orgName} app and download it from there.",
      bodyNoLink: "Open the Privacy screen in the {orgName} app to download your archive. It will remain available for 7 days.",
      optOutLead: "We'll send you a reminder about 24 hours before this download expires.",
      optOutLinkText: "Don't remind me about this download",
      optOutTrailing: "if you'd rather skip it.",
    },
    expiring: {
      subject: "Reminder: your data export expires soon (#{ref})",
      heading: "Your data export expires in about 24 hours",
      intro: "Hi {name}, the personal-data export you requested from {orgName} is still waiting for you to download. The download link will expire in about 24 hours — once it expires you'll need to request a fresh export from the Privacy screen.",
      bodyWithLinkLead: "Tap the button below to grab your archive before the link expires.",
      bodyButtonLabel: "⬇ Download my data archive",
      bodyFallbackHint: "If the button doesn't work you can also open the Privacy screen in the {orgName} app and download it from there.",
      bodyNoLink: "Open the Privacy screen in the {orgName} app to download your archive before it expires.",
      optOutLead: "",
      optOutLinkText: "Stop reminding me about this download",
      optOutTrailing: "",
    },
  },

  hi: {
    htmlLang: "hi",
    dir: "ltr",
    headerTag: "डेटा सुरक्षा",
    labelReference: "संदर्भ",
    labelRequestType: "अनुरोध का प्रकार",
    labelFiledOn: "दर्ज किया गया",
    labelDueBy: "नियत तिथि",
    typeLabelExport: "डेटा निर्यात (पोर्टेबिलिटी)",
    footerNote: "यदि इस अनुरोध के बारे में कोई प्रश्न हो, तो इस ईमेल का उत्तर दें या सीधे {orgName} से संपर्क करें।",
    completed: {
      subject: "आपका डेटा निर्यात तैयार है (#{ref})",
      heading: "आपका डेटा निर्यात डाउनलोड के लिए तैयार है",
      intro: "नमस्ते {name}, {orgName} से आपके द्वारा अनुरोधित व्यक्तिगत-डेटा निर्यात पूरा हो गया है और डाउनलोड के लिए तैयार है।",
      bodyWithLinkLead: "अपनी संग्रह फ़ाइल डाउनलोड करने के लिए नीचे दिए गए बटन पर टैप करें। यह लिंक केवल आपके लिए है और 7 दिनों में समाप्त हो जाएगा — कृपया समाप्त होने से पहले फ़ाइल को कहीं सुरक्षित स्थान पर सहेज लें।",
      bodyButtonLabel: "⬇ मेरा डेटा संग्रह डाउनलोड करें",
      bodyFallbackHint: "अगर बटन काम न करे, तो आप {orgName} ऐप में गोपनीयता स्क्रीन खोलकर वहाँ से भी डाउनलोड कर सकते हैं।",
      bodyNoLink: "अपनी संग्रह फ़ाइल डाउनलोड करने के लिए {orgName} ऐप में गोपनीयता स्क्रीन खोलें। यह 7 दिनों तक उपलब्ध रहेगी।",
      optOutLead: "हम आपको इस डाउनलोड के समाप्त होने से लगभग 24 घंटे पहले एक अनुस्मारक भेजेंगे।",
      optOutLinkText: "इस डाउनलोड के बारे में मुझे याद न दिलाएँ",
      optOutTrailing: "अगर आप इसे छोड़ना चाहें।",
    },
    expiring: {
      subject: "अनुस्मारक: आपका डेटा निर्यात जल्द ही समाप्त हो रहा है (#{ref})",
      heading: "आपका डेटा निर्यात लगभग 24 घंटे में समाप्त हो जाएगा",
      intro: "नमस्ते {name}, {orgName} से आपके द्वारा अनुरोधित व्यक्तिगत-डेटा निर्यात अभी भी आपके डाउनलोड की प्रतीक्षा में है। डाउनलोड लिंक लगभग 24 घंटे में समाप्त हो जाएगा — समाप्त होने पर आपको गोपनीयता स्क्रीन से एक नया निर्यात अनुरोध करना होगा।",
      bodyWithLinkLead: "लिंक के समाप्त होने से पहले अपनी संग्रह फ़ाइल लेने के लिए नीचे दिए गए बटन पर टैप करें।",
      bodyButtonLabel: "⬇ मेरा डेटा संग्रह डाउनलोड करें",
      bodyFallbackHint: "अगर बटन काम न करे, तो आप {orgName} ऐप में गोपनीयता स्क्रीन खोलकर वहाँ से भी डाउनलोड कर सकते हैं।",
      bodyNoLink: "समाप्त होने से पहले अपनी संग्रह फ़ाइल डाउनलोड करने के लिए {orgName} ऐप में गोपनीयता स्क्रीन खोलें।",
      optOutLead: "",
      optOutLinkText: "इस डाउनलोड के बारे में मुझे याद दिलाना बंद करें",
      optOutTrailing: "",
    },
  },

  ar: {
    htmlLang: "ar",
    dir: "rtl",
    headerTag: "حماية البيانات",
    labelReference: "المرجع",
    labelRequestType: "نوع الطلب",
    labelFiledOn: "تاريخ التقديم",
    labelDueBy: "الموعد النهائي",
    typeLabelExport: "تصدير البيانات (قابلية النقل)",
    footerNote: "إذا كانت لديك أسئلة حول هذا الطلب، فقم بالرد على هذا البريد الإلكتروني أو تواصل مع {orgName} مباشرة.",
    completed: {
      subject: "تصدير بياناتك جاهز (#{ref})",
      heading: "تصدير بياناتك جاهز للتنزيل",
      intro: "مرحباً {name}، تم الانتهاء من تصدير البيانات الشخصية الذي طلبته من {orgName} وهو جاهز للتنزيل.",
      bodyWithLinkLead: "انقر على الزر أدناه لتنزيل أرشيفك. هذا الرابط خاص بك وينتهي خلال 7 أيام — يرجى حفظ الملف في مكان آمن قبل انتهاء صلاحيته.",
      bodyButtonLabel: "⬇ تنزيل أرشيف بياناتي",
      bodyFallbackHint: "إذا لم يعمل الزر، يمكنك أيضاً فتح شاشة الخصوصية في تطبيق {orgName} وتنزيله من هناك.",
      bodyNoLink: "افتح شاشة الخصوصية في تطبيق {orgName} لتنزيل أرشيفك. سيظل متاحاً لمدة 7 أيام.",
      optOutLead: "سنرسل لك تذكيراً قبل حوالي 24 ساعة من انتهاء صلاحية هذا التنزيل.",
      optOutLinkText: "لا تذكرني بهذا التنزيل",
      optOutTrailing: "إذا كنت تفضل تخطي ذلك.",
    },
    expiring: {
      subject: "تذكير: تصدير بياناتك ينتهي قريباً (#{ref})",
      heading: "تصدير بياناتك ينتهي خلال حوالي 24 ساعة",
      intro: "مرحباً {name}، تصدير البيانات الشخصية الذي طلبته من {orgName} لا يزال بانتظار تنزيلك. سينتهي رابط التنزيل خلال حوالي 24 ساعة — وبعد انتهائه سيتعين عليك طلب تصدير جديد من شاشة الخصوصية.",
      bodyWithLinkLead: "انقر على الزر أدناه للحصول على أرشيفك قبل انتهاء صلاحية الرابط.",
      bodyButtonLabel: "⬇ تنزيل أرشيف بياناتي",
      bodyFallbackHint: "إذا لم يعمل الزر، يمكنك أيضاً فتح شاشة الخصوصية في تطبيق {orgName} وتنزيله من هناك.",
      bodyNoLink: "افتح شاشة الخصوصية في تطبيق {orgName} لتنزيل أرشيفك قبل انتهاء صلاحيته.",
      optOutLead: "",
      optOutLinkText: "توقف عن تذكيري بهذا التنزيل",
      optOutTrailing: "",
    },
  },

  es: {
    htmlLang: "es",
    dir: "ltr",
    headerTag: "Protección de datos",
    labelReference: "Referencia",
    labelRequestType: "Tipo de solicitud",
    labelFiledOn: "Presentada el",
    labelDueBy: "Fecha límite",
    typeLabelExport: "Exportación de datos (portabilidad)",
    footerNote: "Si tienes preguntas sobre esta solicitud, responde a este correo o contacta directamente a {orgName}.",
    completed: {
      subject: "Tu exportación de datos está lista (#{ref})",
      heading: "Tu exportación de datos está lista para descargar",
      intro: "Hola {name}, la exportación de datos personales que solicitaste a {orgName} ha terminado y está lista para descargar.",
      bodyWithLinkLead: "Pulsa el botón de abajo para descargar tu archivo. El enlace es privado y caduca en 7 días — guarda el archivo en un lugar seguro antes de que caduque.",
      bodyButtonLabel: "⬇ Descargar mi archivo de datos",
      bodyFallbackHint: "Si el botón no funciona, también puedes abrir la pantalla de Privacidad en la aplicación {orgName} y descargarlo desde allí.",
      bodyNoLink: "Abre la pantalla de Privacidad en la aplicación {orgName} para descargar tu archivo. Estará disponible durante 7 días.",
      optOutLead: "Te enviaremos un recordatorio unas 24 horas antes de que caduque esta descarga.",
      optOutLinkText: "No me recuerdes esta descarga",
      optOutTrailing: "si prefieres saltártelo.",
    },
    expiring: {
      subject: "Recordatorio: tu exportación de datos caduca pronto (#{ref})",
      heading: "Tu exportación de datos caduca en unas 24 horas",
      intro: "Hola {name}, la exportación de datos personales que solicitaste a {orgName} todavía está esperando que la descargues. El enlace de descarga caducará en unas 24 horas — una vez caducado tendrás que pedir una nueva exportación desde la pantalla de Privacidad.",
      bodyWithLinkLead: "Pulsa el botón de abajo para obtener tu archivo antes de que caduque el enlace.",
      bodyButtonLabel: "⬇ Descargar mi archivo de datos",
      bodyFallbackHint: "Si el botón no funciona, también puedes abrir la pantalla de Privacidad en la aplicación {orgName} y descargarlo desde allí.",
      bodyNoLink: "Abre la pantalla de Privacidad en la aplicación {orgName} para descargar tu archivo antes de que caduque.",
      optOutLead: "",
      optOutLinkText: "Deja de recordarme esta descarga",
      optOutTrailing: "",
    },
  },

  fr: {
    htmlLang: "fr",
    dir: "ltr",
    headerTag: "Protection des données",
    labelReference: "Référence",
    labelRequestType: "Type de demande",
    labelFiledOn: "Déposée le",
    labelDueBy: "Échéance",
    typeLabelExport: "Export de données (portabilité)",
    footerNote: "Si vous avez des questions à propos de cette demande, répondez à cet e-mail ou contactez directement {orgName}.",
    completed: {
      subject: "Votre export de données est prêt (#{ref})",
      heading: "Votre export de données est prêt à être téléchargé",
      intro: "Bonjour {name}, l'export de données personnelles que vous avez demandé à {orgName} est terminé et prêt à être téléchargé.",
      bodyWithLinkLead: "Appuyez sur le bouton ci-dessous pour télécharger votre archive. Le lien vous est personnel et expire dans 7 jours — pensez à enregistrer le fichier en lieu sûr avant l'expiration.",
      bodyButtonLabel: "⬇ Télécharger mon archive de données",
      bodyFallbackHint: "Si le bouton ne fonctionne pas, vous pouvez aussi ouvrir l'écran Confidentialité dans l'application {orgName} et la télécharger depuis là.",
      bodyNoLink: "Ouvrez l'écran Confidentialité dans l'application {orgName} pour télécharger votre archive. Elle restera disponible pendant 7 jours.",
      optOutLead: "Nous vous enverrons un rappel environ 24 heures avant l'expiration de ce téléchargement.",
      optOutLinkText: "Ne pas me rappeler ce téléchargement",
      optOutTrailing: "si vous préférez l'ignorer.",
    },
    expiring: {
      subject: "Rappel : votre export de données expire bientôt (#{ref})",
      heading: "Votre export de données expire dans environ 24 heures",
      intro: "Bonjour {name}, l'export de données personnelles que vous avez demandé à {orgName} attend toujours d'être téléchargé. Le lien de téléchargement expirera dans environ 24 heures — après expiration, vous devrez redemander un nouvel export depuis l'écran Confidentialité.",
      bodyWithLinkLead: "Appuyez sur le bouton ci-dessous pour récupérer votre archive avant l'expiration du lien.",
      bodyButtonLabel: "⬇ Télécharger mon archive de données",
      bodyFallbackHint: "Si le bouton ne fonctionne pas, vous pouvez aussi ouvrir l'écran Confidentialité dans l'application {orgName} et la télécharger depuis là.",
      bodyNoLink: "Ouvrez l'écran Confidentialité dans l'application {orgName} pour télécharger votre archive avant son expiration.",
      optOutLead: "",
      optOutLinkText: "Arrêter de me rappeler ce téléchargement",
      optOutTrailing: "",
    },
  },

  de: {
    htmlLang: "de",
    dir: "ltr",
    headerTag: "Datenschutz",
    labelReference: "Referenz",
    labelRequestType: "Anfragetyp",
    labelFiledOn: "Eingereicht am",
    labelDueBy: "Fällig am",
    typeLabelExport: "Datenexport (Portabilität)",
    footerNote: "Bei Fragen zu dieser Anfrage antworten Sie auf diese E-Mail oder kontaktieren Sie {orgName} direkt.",
    completed: {
      subject: "Ihr Datenexport ist bereit (#{ref})",
      heading: "Ihr Datenexport steht zum Download bereit",
      intro: "Hallo {name}, der Export Ihrer personenbezogenen Daten, den Sie bei {orgName} angefordert haben, ist abgeschlossen und steht zum Download bereit.",
      bodyWithLinkLead: "Tippen Sie auf die Schaltfläche unten, um Ihr Archiv herunterzuladen. Der Link ist privat und läuft in 7 Tagen ab — speichern Sie die Datei vor Ablauf an einem sicheren Ort.",
      bodyButtonLabel: "⬇ Mein Datenarchiv herunterladen",
      bodyFallbackHint: "Falls die Schaltfläche nicht funktioniert, können Sie auch den Datenschutz-Bildschirm in der {orgName}-App öffnen und es von dort herunterladen.",
      bodyNoLink: "Öffnen Sie den Datenschutz-Bildschirm in der {orgName}-App, um Ihr Archiv herunterzuladen. Es bleibt 7 Tage lang verfügbar.",
      optOutLead: "Wir senden Ihnen etwa 24 Stunden vor Ablauf dieses Downloads eine Erinnerung.",
      optOutLinkText: "Nicht an diesen Download erinnern",
      optOutTrailing: "wenn Sie sie überspringen möchten.",
    },
    expiring: {
      subject: "Erinnerung: Ihr Datenexport läuft bald ab (#{ref})",
      heading: "Ihr Datenexport läuft in etwa 24 Stunden ab",
      intro: "Hallo {name}, der bei {orgName} angeforderte Export Ihrer personenbezogenen Daten wartet noch auf Ihren Download. Der Download-Link läuft in etwa 24 Stunden ab — danach müssen Sie über den Datenschutz-Bildschirm einen neuen Export anfordern.",
      bodyWithLinkLead: "Tippen Sie auf die Schaltfläche unten, um Ihr Archiv vor Ablauf des Links zu sichern.",
      bodyButtonLabel: "⬇ Mein Datenarchiv herunterladen",
      bodyFallbackHint: "Falls die Schaltfläche nicht funktioniert, können Sie auch den Datenschutz-Bildschirm in der {orgName}-App öffnen und es von dort herunterladen.",
      bodyNoLink: "Öffnen Sie den Datenschutz-Bildschirm in der {orgName}-App, um Ihr Archiv vor Ablauf herunterzuladen.",
      optOutLead: "",
      optOutLinkText: "Erinnerungen zu diesem Download stoppen",
      optOutTrailing: "",
    },
  },

  pt: {
    htmlLang: "pt",
    dir: "ltr",
    headerTag: "Proteção de dados",
    labelReference: "Referência",
    labelRequestType: "Tipo de pedido",
    labelFiledOn: "Submetido em",
    labelDueBy: "Prazo até",
    typeLabelExport: "Exportação de dados (portabilidade)",
    footerNote: "Se tiver dúvidas sobre este pedido, responda a este e-mail ou contacte diretamente {orgName}.",
    completed: {
      subject: "A sua exportação de dados está pronta (#{ref})",
      heading: "A sua exportação de dados está pronta para descarregar",
      intro: "Olá {name}, a exportação de dados pessoais que pediu a {orgName} terminou e está pronta para descarregar.",
      bodyWithLinkLead: "Toque no botão abaixo para descarregar o seu arquivo. O link é privado e expira em 7 dias — guarde o ficheiro num local seguro antes de expirar.",
      bodyButtonLabel: "⬇ Descarregar o meu arquivo de dados",
      bodyFallbackHint: "Se o botão não funcionar, também pode abrir o ecrã de Privacidade na aplicação {orgName} e descarregá-lo a partir daí.",
      bodyNoLink: "Abra o ecrã de Privacidade na aplicação {orgName} para descarregar o seu arquivo. Estará disponível durante 7 dias.",
      optOutLead: "Enviaremos um lembrete cerca de 24 horas antes de esta transferência expirar.",
      optOutLinkText: "Não me lembrar desta transferência",
      optOutTrailing: "se preferir saltar.",
    },
    expiring: {
      subject: "Lembrete: a sua exportação de dados expira em breve (#{ref})",
      heading: "A sua exportação de dados expira em cerca de 24 horas",
      intro: "Olá {name}, a exportação de dados pessoais que pediu a {orgName} ainda aguarda a sua transferência. O link de transferência irá expirar em cerca de 24 horas — depois disso, terá de pedir uma nova exportação no ecrã de Privacidade.",
      bodyWithLinkLead: "Toque no botão abaixo para obter o seu arquivo antes de o link expirar.",
      bodyButtonLabel: "⬇ Descarregar o meu arquivo de dados",
      bodyFallbackHint: "Se o botão não funcionar, também pode abrir o ecrã de Privacidade na aplicação {orgName} e descarregá-lo a partir daí.",
      bodyNoLink: "Abra o ecrã de Privacidade na aplicação {orgName} para descarregar o seu arquivo antes de expirar.",
      optOutLead: "",
      optOutLinkText: "Parar de me lembrar desta transferência",
      optOutTrailing: "",
    },
  },

  ja: {
    htmlLang: "ja",
    dir: "ltr",
    headerTag: "データ保護",
    labelReference: "参照番号",
    labelRequestType: "リクエスト種別",
    labelFiledOn: "申請日",
    labelDueBy: "期限",
    typeLabelExport: "データエクスポート(ポータビリティ)",
    footerNote: "このリクエストについてご質問があれば、このメールに返信するか、{orgName}に直接お問い合わせください。",
    completed: {
      subject: "データエクスポートの準備が整いました (#{ref})",
      heading: "データエクスポートをダウンロードできます",
      intro: "{name}様、{orgName}にリクエストされた個人データのエクスポートが完了し、ダウンロードできるようになりました。",
      bodyWithLinkLead: "下のボタンをタップしてアーカイブをダウンロードしてください。このリンクはあなた専用で、7日後に有効期限が切れます。期限が切れる前に安全な場所に保存してください。",
      bodyButtonLabel: "⬇ データアーカイブをダウンロード",
      bodyFallbackHint: "ボタンが機能しない場合は、{orgName}アプリのプライバシー画面からもダウンロードできます。",
      bodyNoLink: "アーカイブをダウンロードするには、{orgName}アプリのプライバシー画面を開いてください。7日間ご利用いただけます。",
      optOutLead: "このダウンロードの有効期限が切れる約24時間前にリマインダーをお送りします。",
      optOutLinkText: "このダウンロードについて通知しない",
      optOutTrailing: "受け取りたくない場合はこちらから。",
    },
    expiring: {
      subject: "リマインダー: データエクスポートの有効期限が近づいています (#{ref})",
      heading: "データエクスポートの有効期限まで約24時間です",
      intro: "{name}様、{orgName}にリクエストされた個人データのエクスポートはまだダウンロードされていません。ダウンロードリンクの有効期限まで約24時間です。期限切れ後はプライバシー画面から新しいエクスポートをリクエストし直す必要があります。",
      bodyWithLinkLead: "リンクの有効期限が切れる前に、下のボタンをタップしてアーカイブを取得してください。",
      bodyButtonLabel: "⬇ データアーカイブをダウンロード",
      bodyFallbackHint: "ボタンが機能しない場合は、{orgName}アプリのプライバシー画面からもダウンロードできます。",
      bodyNoLink: "有効期限が切れる前にアーカイブをダウンロードするには、{orgName}アプリのプライバシー画面を開いてください。",
      optOutLead: "",
      optOutLinkText: "このダウンロードのリマインダーを停止",
      optOutTrailing: "",
    },
  },

  ko: {
    htmlLang: "ko",
    dir: "ltr",
    headerTag: "데이터 보호",
    labelReference: "참조",
    labelRequestType: "요청 유형",
    labelFiledOn: "신청일",
    labelDueBy: "기한",
    typeLabelExport: "데이터 내보내기(이식성)",
    footerNote: "이 요청에 관해 문의 사항이 있으시면 이 이메일에 회신하거나 {orgName}에 직접 연락해 주세요.",
    completed: {
      subject: "데이터 내보내기가 준비되었습니다 (#{ref})",
      heading: "데이터 내보내기 다운로드 준비 완료",
      intro: "{name}님, {orgName}에 요청하신 개인 데이터 내보내기가 완료되어 다운로드할 수 있습니다.",
      bodyWithLinkLead: "아래 버튼을 눌러 보관 파일을 다운로드하세요. 이 링크는 본인 전용이며 7일 후 만료됩니다 — 만료 전에 파일을 안전한 곳에 저장해 두세요.",
      bodyButtonLabel: "⬇ 내 데이터 보관 파일 다운로드",
      bodyFallbackHint: "버튼이 작동하지 않으면 {orgName} 앱의 개인정보 보호 화면에서도 다운로드할 수 있습니다.",
      bodyNoLink: "보관 파일을 다운로드하려면 {orgName} 앱의 개인정보 보호 화면을 열어주세요. 7일 동안 사용 가능합니다.",
      optOutLead: "이 다운로드 만료 약 24시간 전에 알림을 보내드립니다.",
      optOutLinkText: "이 다운로드에 대한 알림을 받지 않기",
      optOutTrailing: "건너뛰고 싶은 경우 선택해 주세요.",
    },
    expiring: {
      subject: "알림: 데이터 내보내기 만료가 임박했습니다 (#{ref})",
      heading: "데이터 내보내기가 약 24시간 후 만료됩니다",
      intro: "{name}님, {orgName}에 요청하신 개인 데이터 내보내기는 아직 다운로드되지 않았습니다. 다운로드 링크는 약 24시간 후 만료됩니다. 만료되면 개인정보 보호 화면에서 새 내보내기를 다시 요청해야 합니다.",
      bodyWithLinkLead: "링크가 만료되기 전에 아래 버튼을 눌러 보관 파일을 받으세요.",
      bodyButtonLabel: "⬇ 내 데이터 보관 파일 다운로드",
      bodyFallbackHint: "버튼이 작동하지 않으면 {orgName} 앱의 개인정보 보호 화면에서도 다운로드할 수 있습니다.",
      bodyNoLink: "만료되기 전에 보관 파일을 다운로드하려면 {orgName} 앱의 개인정보 보호 화면을 열어주세요.",
      optOutLead: "",
      optOutLinkText: "이 다운로드에 대한 알림 중지",
      optOutTrailing: "",
    },
  },

  zh: {
    htmlLang: "zh",
    dir: "ltr",
    headerTag: "数据保护",
    labelReference: "参考编号",
    labelRequestType: "请求类型",
    labelFiledOn: "提交日期",
    labelDueBy: "截止日期",
    typeLabelExport: "数据导出(可移植性)",
    footerNote: "如对此请求有任何疑问,请回复此邮件或直接联系 {orgName}。",
    completed: {
      subject: "您的数据导出已就绪 (#{ref})",
      heading: "您的数据导出可供下载",
      intro: "{name},您好。您从 {orgName} 申请的个人数据导出已完成,可供下载。",
      bodyWithLinkLead: "点击下方按钮下载您的存档。此链接仅供您本人使用,将在 7 天后失效 — 请在过期前将文件保存到安全的位置。",
      bodyButtonLabel: "⬇ 下载我的数据存档",
      bodyFallbackHint: "如果按钮无法使用,您也可以打开 {orgName} 应用中的隐私页面从那里下载。",
      bodyNoLink: "请打开 {orgName} 应用中的隐私页面下载您的存档。该存档将保留 7 天。",
      optOutLead: "我们会在此下载到期前约 24 小时向您发送提醒。",
      optOutLinkText: "不再提醒我这个下载",
      optOutTrailing: "如果您希望跳过提醒。",
    },
    expiring: {
      subject: "提醒:您的数据导出即将到期 (#{ref})",
      heading: "您的数据导出将在约 24 小时后到期",
      intro: "{name},您好。您从 {orgName} 申请的个人数据导出仍在等待您的下载。下载链接将在约 24 小时后到期 — 到期后您需要在隐私页面重新申请新的导出。",
      bodyWithLinkLead: "请在链接到期前点击下方按钮获取您的存档。",
      bodyButtonLabel: "⬇ 下载我的数据存档",
      bodyFallbackHint: "如果按钮无法使用,您也可以打开 {orgName} 应用中的隐私页面从那里下载。",
      bodyNoLink: "请在到期前打开 {orgName} 应用中的隐私页面下载您的存档。",
      optOutLead: "",
      optOutLinkText: "停止提醒我这个下载",
      optOutTrailing: "",
    },
  },

  th: {
    htmlLang: "th",
    dir: "ltr",
    headerTag: "การปกป้องข้อมูล",
    labelReference: "หมายเลขอ้างอิง",
    labelRequestType: "ประเภทคำขอ",
    labelFiledOn: "ยื่นเมื่อ",
    labelDueBy: "ครบกำหนด",
    typeLabelExport: "การส่งออกข้อมูล (ความสามารถในการพกพา)",
    footerNote: "หากมีคำถามเกี่ยวกับคำขอนี้ โปรดตอบกลับอีเมลนี้หรือติดต่อ {orgName} โดยตรง",
    completed: {
      subject: "การส่งออกข้อมูลของคุณพร้อมแล้ว (#{ref})",
      heading: "การส่งออกข้อมูลของคุณพร้อมให้ดาวน์โหลด",
      intro: "สวัสดีคุณ {name} การส่งออกข้อมูลส่วนบุคคลที่คุณขอจาก {orgName} เสร็จสิ้นแล้วและพร้อมให้ดาวน์โหลด",
      bodyWithLinkLead: "แตะปุ่มด้านล่างเพื่อดาวน์โหลดไฟล์เก็บถาวรของคุณ ลิงก์นี้เป็นของคุณคนเดียวและจะหมดอายุใน 7 วัน — โปรดบันทึกไฟล์ไว้ในที่ปลอดภัยก่อนหมดอายุ",
      bodyButtonLabel: "⬇ ดาวน์โหลดไฟล์เก็บถาวรข้อมูลของฉัน",
      bodyFallbackHint: "หากปุ่มไม่ทำงาน คุณยังสามารถเปิดหน้าจอความเป็นส่วนตัวในแอป {orgName} และดาวน์โหลดจากที่นั่นได้",
      bodyNoLink: "เปิดหน้าจอความเป็นส่วนตัวในแอป {orgName} เพื่อดาวน์โหลดไฟล์เก็บถาวรของคุณ จะใช้งานได้นาน 7 วัน",
      optOutLead: "เราจะส่งคำเตือนล่วงหน้าประมาณ 24 ชั่วโมงก่อนที่การดาวน์โหลดนี้จะหมดอายุ",
      optOutLinkText: "อย่าเตือนฉันเกี่ยวกับการดาวน์โหลดนี้",
      optOutTrailing: "หากคุณต้องการข้าม",
    },
    expiring: {
      subject: "คำเตือน: การส่งออกข้อมูลของคุณกำลังจะหมดอายุ (#{ref})",
      heading: "การส่งออกข้อมูลของคุณจะหมดอายุในอีกประมาณ 24 ชั่วโมง",
      intro: "สวัสดีคุณ {name} การส่งออกข้อมูลส่วนบุคคลที่คุณขอจาก {orgName} ยังคงรอให้คุณดาวน์โหลด ลิงก์ดาวน์โหลดจะหมดอายุในอีกประมาณ 24 ชั่วโมง — เมื่อหมดอายุแล้ว คุณจะต้องขอการส่งออกใหม่จากหน้าจอความเป็นส่วนตัว",
      bodyWithLinkLead: "แตะปุ่มด้านล่างเพื่อรับไฟล์เก็บถาวรของคุณก่อนที่ลิงก์จะหมดอายุ",
      bodyButtonLabel: "⬇ ดาวน์โหลดไฟล์เก็บถาวรข้อมูลของฉัน",
      bodyFallbackHint: "หากปุ่มไม่ทำงาน คุณยังสามารถเปิดหน้าจอความเป็นส่วนตัวในแอป {orgName} และดาวน์โหลดจากที่นั่นได้",
      bodyNoLink: "เปิดหน้าจอความเป็นส่วนตัวในแอป {orgName} เพื่อดาวน์โหลดไฟล์เก็บถาวรก่อนที่จะหมดอายุ",
      optOutLead: "",
      optOutLinkText: "หยุดการเตือนเกี่ยวกับการดาวน์โหลดนี้",
      optOutTrailing: "",
    },
  },

  ms: {
    htmlLang: "ms",
    dir: "ltr",
    headerTag: "Perlindungan Data",
    labelReference: "Rujukan",
    labelRequestType: "Jenis permintaan",
    labelFiledOn: "Difailkan pada",
    labelDueBy: "Tarikh tamat",
    typeLabelExport: "Eksport data (kemudahalihan)",
    footerNote: "Jika anda ada soalan tentang permintaan ini, balas e-mel ini atau hubungi {orgName} secara terus.",
    completed: {
      subject: "Eksport data anda sedia (#{ref})",
      heading: "Eksport data anda sedia untuk dimuat turun",
      intro: "Hai {name}, eksport data peribadi yang anda minta daripada {orgName} telah selesai dan sedia untuk dimuat turun.",
      bodyWithLinkLead: "Ketik butang di bawah untuk memuat turun arkib anda. Pautan ini peribadi untuk anda dan tamat tempoh dalam 7 hari — sila simpan fail di tempat selamat sebelum tamat tempoh.",
      bodyButtonLabel: "⬇ Muat turun arkib data saya",
      bodyFallbackHint: "Jika butang tidak berfungsi, anda juga boleh membuka skrin Privasi dalam aplikasi {orgName} dan memuat turunnya dari sana.",
      bodyNoLink: "Buka skrin Privasi dalam aplikasi {orgName} untuk memuat turun arkib anda. Ia akan tersedia selama 7 hari.",
      optOutLead: "Kami akan menghantar peringatan kira-kira 24 jam sebelum muat turun ini tamat tempoh.",
      optOutLinkText: "Jangan ingatkan saya tentang muat turun ini",
      optOutTrailing: "jika anda lebih suka melangkaunya.",
    },
    expiring: {
      subject: "Peringatan: eksport data anda akan tamat tempoh (#{ref})",
      heading: "Eksport data anda akan tamat tempoh dalam kira-kira 24 jam",
      intro: "Hai {name}, eksport data peribadi yang anda minta daripada {orgName} masih menunggu untuk dimuat turun. Pautan muat turun akan tamat tempoh dalam kira-kira 24 jam — selepas itu anda perlu meminta eksport baharu dari skrin Privasi.",
      bodyWithLinkLead: "Ketik butang di bawah untuk mengambil arkib anda sebelum pautan tamat tempoh.",
      bodyButtonLabel: "⬇ Muat turun arkib data saya",
      bodyFallbackHint: "Jika butang tidak berfungsi, anda juga boleh membuka skrin Privasi dalam aplikasi {orgName} dan memuat turunnya dari sana.",
      bodyNoLink: "Buka skrin Privasi dalam aplikasi {orgName} untuk memuat turun arkib anda sebelum tamat tempoh.",
      optOutLead: "",
      optOutLinkText: "Berhenti mengingatkan saya tentang muat turun ini",
      optOutTrailing: "",
    },
  },

  id: {
    htmlLang: "id",
    dir: "ltr",
    headerTag: "Perlindungan Data",
    labelReference: "Referensi",
    labelRequestType: "Jenis permintaan",
    labelFiledOn: "Diajukan pada",
    labelDueBy: "Batas waktu",
    typeLabelExport: "Ekspor data (portabilitas)",
    footerNote: "Jika ada pertanyaan tentang permintaan ini, balas email ini atau hubungi {orgName} langsung.",
    completed: {
      subject: "Ekspor data Anda siap (#{ref})",
      heading: "Ekspor data Anda siap diunduh",
      intro: "Halo {name}, ekspor data pribadi yang Anda minta dari {orgName} telah selesai dan siap diunduh.",
      bodyWithLinkLead: "Ketuk tombol di bawah untuk mengunduh arsip Anda. Tautan ini pribadi dan kedaluwarsa dalam 7 hari — simpan file di tempat aman sebelum kedaluwarsa.",
      bodyButtonLabel: "⬇ Unduh arsip data saya",
      bodyFallbackHint: "Jika tombol tidak berfungsi, Anda juga dapat membuka layar Privasi di aplikasi {orgName} dan mengunduhnya dari sana.",
      bodyNoLink: "Buka layar Privasi di aplikasi {orgName} untuk mengunduh arsip Anda. Akan tersedia selama 7 hari.",
      optOutLead: "Kami akan mengirim pengingat sekitar 24 jam sebelum unduhan ini kedaluwarsa.",
      optOutLinkText: "Jangan ingatkan saya tentang unduhan ini",
      optOutTrailing: "jika Anda lebih memilih melewatinya.",
    },
    expiring: {
      subject: "Pengingat: ekspor data Anda akan segera kedaluwarsa (#{ref})",
      heading: "Ekspor data Anda akan kedaluwarsa dalam sekitar 24 jam",
      intro: "Halo {name}, ekspor data pribadi yang Anda minta dari {orgName} masih menunggu untuk diunduh. Tautan unduhan akan kedaluwarsa dalam sekitar 24 jam — setelah itu, Anda perlu meminta ekspor baru dari layar Privasi.",
      bodyWithLinkLead: "Ketuk tombol di bawah untuk mengambil arsip Anda sebelum tautan kedaluwarsa.",
      bodyButtonLabel: "⬇ Unduh arsip data saya",
      bodyFallbackHint: "Jika tombol tidak berfungsi, Anda juga dapat membuka layar Privasi di aplikasi {orgName} dan mengunduhnya dari sana.",
      bodyNoLink: "Buka layar Privasi di aplikasi {orgName} untuk mengunduh arsip Anda sebelum kedaluwarsa.",
      optOutLead: "",
      optOutLinkText: "Berhenti mengingatkan saya tentang unduhan ini",
      optOutTrailing: "",
    },
  },

  vi: {
    htmlLang: "vi",
    dir: "ltr",
    headerTag: "Bảo vệ dữ liệu",
    labelReference: "Tham chiếu",
    labelRequestType: "Loại yêu cầu",
    labelFiledOn: "Ngày gửi",
    labelDueBy: "Hạn chót",
    typeLabelExport: "Xuất dữ liệu (tính di động)",
    footerNote: "Nếu có thắc mắc về yêu cầu này, vui lòng trả lời email này hoặc liên hệ trực tiếp với {orgName}.",
    completed: {
      subject: "Bản xuất dữ liệu của bạn đã sẵn sàng (#{ref})",
      heading: "Bản xuất dữ liệu của bạn đã sẵn sàng để tải xuống",
      intro: "Xin chào {name}, bản xuất dữ liệu cá nhân mà bạn yêu cầu từ {orgName} đã hoàn tất và sẵn sàng để tải xuống.",
      bodyWithLinkLead: "Nhấn vào nút bên dưới để tải xuống tệp lưu trữ của bạn. Liên kết này chỉ dành riêng cho bạn và sẽ hết hạn sau 7 ngày — hãy lưu tệp ở nơi an toàn trước khi hết hạn.",
      bodyButtonLabel: "⬇ Tải xuống tệp lưu trữ dữ liệu của tôi",
      bodyFallbackHint: "Nếu nút không hoạt động, bạn cũng có thể mở màn hình Quyền riêng tư trong ứng dụng {orgName} và tải xuống từ đó.",
      bodyNoLink: "Mở màn hình Quyền riêng tư trong ứng dụng {orgName} để tải xuống tệp lưu trữ của bạn. Tệp sẽ có sẵn trong 7 ngày.",
      optOutLead: "Chúng tôi sẽ gửi lời nhắc khoảng 24 giờ trước khi lượt tải xuống này hết hạn.",
      optOutLinkText: "Đừng nhắc tôi về lượt tải xuống này",
      optOutTrailing: "nếu bạn muốn bỏ qua.",
    },
    expiring: {
      subject: "Lời nhắc: bản xuất dữ liệu của bạn sắp hết hạn (#{ref})",
      heading: "Bản xuất dữ liệu của bạn sẽ hết hạn trong khoảng 24 giờ",
      intro: "Xin chào {name}, bản xuất dữ liệu cá nhân mà bạn yêu cầu từ {orgName} vẫn đang chờ bạn tải xuống. Liên kết tải xuống sẽ hết hạn trong khoảng 24 giờ — sau khi hết hạn, bạn sẽ cần yêu cầu bản xuất mới từ màn hình Quyền riêng tư.",
      bodyWithLinkLead: "Nhấn vào nút bên dưới để lấy tệp lưu trữ của bạn trước khi liên kết hết hạn.",
      bodyButtonLabel: "⬇ Tải xuống tệp lưu trữ dữ liệu của tôi",
      bodyFallbackHint: "Nếu nút không hoạt động, bạn cũng có thể mở màn hình Quyền riêng tư trong ứng dụng {orgName} và tải xuống từ đó.",
      bodyNoLink: "Mở màn hình Quyền riêng tư trong ứng dụng {orgName} để tải xuống tệp lưu trữ trước khi hết hạn.",
      optOutLead: "",
      optOutLinkText: "Dừng nhắc tôi về lượt tải xuống này",
      optOutTrailing: "",
    },
  },

  fil: {
    htmlLang: "fil",
    dir: "ltr",
    headerTag: "Proteksyon ng Data",
    labelReference: "Reference",
    labelRequestType: "Uri ng request",
    labelFiledOn: "Inihain noong",
    labelDueBy: "Hanggang",
    typeLabelExport: "Pag-export ng data (portability)",
    footerNote: "Kung may mga tanong tungkol sa request na ito, tumugon sa email na ito o direktang makipag-ugnayan sa {orgName}.",
    completed: {
      subject: "Handa na ang iyong data export (#{ref})",
      heading: "Handa nang i-download ang iyong data export",
      intro: "Hi {name}, tapos na ang personal-data export na hiniling mo mula sa {orgName} at handa nang i-download.",
      bodyWithLinkLead: "I-tap ang pindutan sa ibaba upang i-download ang iyong archive. Pribado sa iyo ang link na ito at mag-e-expire sa 7 araw — i-save ang file sa ligtas na lugar bago ito mag-expire.",
      bodyButtonLabel: "⬇ I-download ang aking data archive",
      bodyFallbackHint: "Kung ayaw gumana ng pindutan, maaari mo ring buksan ang Privacy screen sa app ng {orgName} at i-download ito mula doon.",
      bodyNoLink: "Buksan ang Privacy screen sa app ng {orgName} upang i-download ang iyong archive. Magagamit ito sa loob ng 7 araw.",
      optOutLead: "Magpapadala kami ng paalala mga 24 oras bago mag-expire ang download na ito.",
      optOutLinkText: "Huwag mo na akong paalalahanan tungkol sa download na ito",
      optOutTrailing: "kung mas gusto mong laktawan ito.",
    },
    expiring: {
      subject: "Paalala: malapit nang mag-expire ang iyong data export (#{ref})",
      heading: "Mag-e-expire ang iyong data export sa loob ng mga 24 oras",
      intro: "Hi {name}, ang personal-data export na hiniling mo mula sa {orgName} ay naghihintay pa rin na i-download mo. Mag-e-expire ang download link sa loob ng mga 24 oras — kapag nag-expire ay kailangan mong humiling ng bagong export mula sa Privacy screen.",
      bodyWithLinkLead: "I-tap ang pindutan sa ibaba upang makuha ang iyong archive bago mag-expire ang link.",
      bodyButtonLabel: "⬇ I-download ang aking data archive",
      bodyFallbackHint: "Kung ayaw gumana ng pindutan, maaari mo ring buksan ang Privacy screen sa app ng {orgName} at i-download ito mula doon.",
      bodyNoLink: "Buksan ang Privacy screen sa app ng {orgName} upang i-download ang iyong archive bago mag-expire.",
      optOutLead: "",
      optOutLinkText: "Itigil ang pag-paalala sa akin tungkol sa download na ito",
      optOutTrailing: "",
    },
  },

  sw: {
    htmlLang: "sw",
    dir: "ltr",
    headerTag: "Ulinzi wa Data",
    labelReference: "Marejeleo",
    labelRequestType: "Aina ya ombi",
    labelFiledOn: "Iliwasilishwa",
    labelDueBy: "Inafaa kufanyika kabla ya",
    typeLabelExport: "Kuhamisha data (uhamishaji)",
    footerNote: "Ukiwa na maswali kuhusu ombi hili, jibu barua pepe hii au wasiliana na {orgName} moja kwa moja.",
    completed: {
      subject: "Uhamishaji wako wa data uko tayari (#{ref})",
      heading: "Uhamishaji wako wa data uko tayari kupakuliwa",
      intro: "Habari {name}, uhamishaji wa data binafsi uliyoomba kutoka {orgName} umekamilika na uko tayari kupakuliwa.",
      bodyWithLinkLead: "Gusa kitufe kilicho hapa chini ili kupakua kumbukumbu yako. Kiungo hiki ni cha faragha yako na kitaisha baada ya siku 7 — tafadhali hifadhi faili mahali salama kabla ya kuisha.",
      bodyButtonLabel: "⬇ Pakua kumbukumbu yangu ya data",
      bodyFallbackHint: "Kama kitufe hakitafanya kazi, unaweza pia kufungua skrini ya Faragha katika programu ya {orgName} na kuipakua kutoka pale.",
      bodyNoLink: "Fungua skrini ya Faragha katika programu ya {orgName} ili kupakua kumbukumbu yako. Itapatikana kwa siku 7.",
      optOutLead: "Tutakutumia kikumbusho takriban saa 24 kabla ya upakuaji huu kuisha muda.",
      optOutLinkText: "Usinikumbushe kuhusu upakuaji huu",
      optOutTrailing: "kama ungependa kuruka.",
    },
    expiring: {
      subject: "Kikumbusho: uhamishaji wako wa data unaisha hivi karibuni (#{ref})",
      heading: "Uhamishaji wako wa data utaisha baada ya takriban saa 24",
      intro: "Habari {name}, uhamishaji wa data binafsi uliyoomba kutoka {orgName} bado unangojea upakuliwe. Kiungo cha kupakua kitaisha muda baada ya takriban saa 24 — kikiisha utahitaji kuomba uhamishaji mpya kutoka skrini ya Faragha.",
      bodyWithLinkLead: "Gusa kitufe kilicho hapa chini ili kuchukua kumbukumbu yako kabla ya kiungo kuisha muda.",
      bodyButtonLabel: "⬇ Pakua kumbukumbu yangu ya data",
      bodyFallbackHint: "Kama kitufe hakitafanya kazi, unaweza pia kufungua skrini ya Faragha katika programu ya {orgName} na kuipakua kutoka pale.",
      bodyNoLink: "Fungua skrini ya Faragha katika programu ya {orgName} ili kupakua kumbukumbu yako kabla ya kuisha.",
      optOutLead: "",
      optOutLinkText: "Acha kunikumbusha kuhusu upakuaji huu",
      optOutTrailing: "",
    },
  },

  af: {
    htmlLang: "af",
    dir: "ltr",
    headerTag: "Databeskerming",
    labelReference: "Verwysing",
    labelRequestType: "Tipe versoek",
    labelFiledOn: "Ingedien op",
    labelDueBy: "Sperdatum",
    typeLabelExport: "Data-uitvoer (oordraagbaarheid)",
    footerNote: "As jy vrae oor hierdie versoek het, antwoord op hierdie e-pos of kontak {orgName} direk.",
    completed: {
      subject: "Jou data-uitvoer is gereed (#{ref})",
      heading: "Jou data-uitvoer is gereed om af te laai",
      intro: "Hallo {name}, die uitvoer van persoonlike data wat jy by {orgName} aangevra het, is voltooi en gereed om af te laai.",
      bodyWithLinkLead: "Tik die knoppie hieronder om jou argief af te laai. Die skakel is privaat en verstryk binne 7 dae — stoor asseblief die lêer op 'n veilige plek voordat dit verstryk.",
      bodyButtonLabel: "⬇ Laai my data-argief af",
      bodyFallbackHint: "As die knoppie nie werk nie, kan jy ook die Privaatheidskerm in die {orgName}-app oopmaak en dit van daar af aflaai.",
      bodyNoLink: "Maak die Privaatheidskerm in die {orgName}-app oop om jou argief af te laai. Dit bly 7 dae lank beskikbaar.",
      optOutLead: "Ons stuur jou ongeveer 24 uur voor hierdie aflaai verstryk 'n herinnering.",
      optOutLinkText: "Moenie my aan hierdie aflaai herinner nie",
      optOutTrailing: "as jy dit liewer wil oorslaan.",
    },
    expiring: {
      subject: "Herinnering: jou data-uitvoer verstryk binnekort (#{ref})",
      heading: "Jou data-uitvoer verstryk binne ongeveer 24 uur",
      intro: "Hallo {name}, die uitvoer van persoonlike data wat jy by {orgName} aangevra het, wag steeds dat jy dit aflaai. Die aflaaiskakel sal binne ongeveer 24 uur verstryk — sodra dit verstryk, sal jy 'n nuwe uitvoer vanaf die Privaatheidskerm moet aanvra.",
      bodyWithLinkLead: "Tik die knoppie hieronder om jou argief te haal voordat die skakel verstryk.",
      bodyButtonLabel: "⬇ Laai my data-argief af",
      bodyFallbackHint: "As die knoppie nie werk nie, kan jy ook die Privaatheidskerm in die {orgName}-app oopmaak en dit van daar af aflaai.",
      bodyNoLink: "Maak die Privaatheidskerm in die {orgName}-app oop om jou argief af te laai voordat dit verstryk.",
      optOutLead: "",
      optOutLinkText: "Hou op om my aan hierdie aflaai te herinner",
      optOutTrailing: "",
    },
  },

  am: {
    htmlLang: "am",
    dir: "ltr",
    headerTag: "የውሂብ ጥበቃ",
    labelReference: "ማጣቀሻ",
    labelRequestType: "የጥያቄ ዓይነት",
    labelFiledOn: "የቀረበበት ቀን",
    labelDueBy: "የመጨረሻ ቀን",
    typeLabelExport: "የውሂብ ወደ ውጭ መላክ (ተንቀሳቃሽነት)",
    footerNote: "ስለዚህ ጥያቄ ጥያቄዎች ካሉዎት፣ ለዚህ ኢሜይል ምላሽ ይስጡ ወይም በቀጥታ {orgName}ን ያግኙ።",
    completed: {
      subject: "የውሂብ ወደ ውጭ መላክዎ ዝግጁ ነው (#{ref})",
      heading: "የውሂብ ወደ ውጭ መላክዎ ለማውረድ ዝግጁ ነው",
      intro: "ሰላም {name}፣ ከ{orgName} የጠየቁት የግል ውሂብ ወደ ውጭ መላክ ተጠናቋል እና ለማውረድ ዝግጁ ነው።",
      bodyWithLinkLead: "ማህደርዎን ለማውረድ ከታች ያለውን ቁልፍ ይንኩ። ይህ አገናኝ የእርስዎ ብቻ ነው እና በ7 ቀናት ውስጥ ጊዜው ያበቃል — ጊዜው ከማብቃቱ በፊት ፋይሉን በደህና ቦታ ያስቀምጡ።",
      bodyButtonLabel: "⬇ የውሂብ ማህደሬን አውርድ",
      bodyFallbackHint: "ቁልፉ የማይሰራ ከሆነ፣ በ{orgName} መተግበሪያ ውስጥ የግላዊነት ማያ ገጽ መክፈት እና ከዚያ ማውረድ ይችላሉ።",
      bodyNoLink: "ማህደርዎን ለማውረድ በ{orgName} መተግበሪያ ውስጥ የግላዊነት ማያ ገጽ ይክፈቱ። ለ7 ቀናት ይገኛል።",
      optOutLead: "ይህ ማውረድ ጊዜው ከማብቃቱ 24 ሰዓት ገደማ በፊት ማስታወሻ እንልክልዎታለን።",
      optOutLinkText: "ስለዚህ ማውረድ አታስታውሰኝ",
      optOutTrailing: "መዝለል የሚፈልጉ ከሆነ።",
    },
    expiring: {
      subject: "ማስታወሻ፦ የውሂብ ወደ ውጭ መላክዎ በቅርቡ ጊዜው ያበቃል (#{ref})",
      heading: "የውሂብ ወደ ውጭ መላክዎ በ24 ሰዓት ገደማ ውስጥ ጊዜው ያበቃል",
      intro: "ሰላም {name}፣ ከ{orgName} የጠየቁት የግል ውሂብ ወደ ውጭ መላክ አሁንም እርስዎ እንዲያወርዱት ይጠብቃል። የማውረድ አገናኙ በ24 ሰዓት ገደማ ውስጥ ጊዜው ያበቃል — ጊዜው ካበቃ በኋላ ከግላዊነት ማያ ገጽ አዲስ ወደ ውጭ መላክ መጠየቅ ይኖርብዎታል።",
      bodyWithLinkLead: "አገናኙ ጊዜው ከማብቃቱ በፊት ማህደርዎን ለማግኘት ከታች ያለውን ቁልፍ ይንኩ።",
      bodyButtonLabel: "⬇ የውሂብ ማህደሬን አውርድ",
      bodyFallbackHint: "ቁልፉ የማይሰራ ከሆነ፣ በ{orgName} መተግበሪያ ውስጥ የግላዊነት ማያ ገጽ መክፈት እና ከዚያ ማውረድ ይችላሉ።",
      bodyNoLink: "ጊዜው ከማብቃቱ በፊት ማህደርዎን ለማውረድ በ{orgName} መተግበሪያ ውስጥ የግላዊነት ማያ ገጽ ይክፈቱ።",
      optOutLead: "",
      optOutLinkText: "ስለዚህ ማውረድ ማስታወስ አቁም",
      optOutTrailing: "",
    },
  },

  ha: {
    htmlLang: "ha",
    dir: "ltr",
    headerTag: "Kariyar Bayanai",
    labelReference: "Manuni",
    labelRequestType: "Nau'in buƙata",
    labelFiledOn: "An gabatar",
    labelDueBy: "Wa'adin ƙarshe",
    typeLabelExport: "Fitar bayanai (yiwuwar ɗauka)",
    footerNote: "Idan kuna da tambayoyi game da wannan buƙata, ku amsa wannan imel ko ku tuntubi {orgName} kai tsaye.",
    completed: {
      subject: "Fitar bayananku a shirye yake (#{ref})",
      heading: "Fitar bayananku a shirye yake don saukewa",
      intro: "Sannu {name}, fitar bayanan keɓaɓɓu da ka nema daga {orgName} ya kammala kuma a shirye yake don saukewa.",
      bodyWithLinkLead: "Danna maɓallin da ke ƙasa don saukar da ajiyarka. Wannan hanyar haɗi ta keɓance maka kuma za ta ƙare cikin kwanaki 7 — don Allah ka ajiye fayil ɗin a wuri mai aminci kafin ya ƙare.",
      bodyButtonLabel: "⬇ Sauke ajiyar bayanaina",
      bodyFallbackHint: "Idan maɓallin bai yi aiki ba, kuna iya buɗe allon Sirri a cikin manhajar {orgName} ku saukar daga can.",
      bodyNoLink: "Buɗe allon Sirri a cikin manhajar {orgName} don saukar da ajiyarka. Za ta kasance na kwanaki 7.",
      optOutLead: "Za mu aiko muku da tunatarwa kusan sa'o'i 24 kafin wannan saukewa ya ƙare.",
      optOutLinkText: "Kar ka tunatar da ni game da wannan saukewa",
      optOutTrailing: "idan kuna so ku tsallake.",
    },
    expiring: {
      subject: "Tunatarwa: fitar bayananku za su ƙare nan ba da daɗewa ba (#{ref})",
      heading: "Fitar bayananku za su ƙare cikin kusan sa'o'i 24",
      intro: "Sannu {name}, fitar bayanan keɓaɓɓu da ka nema daga {orgName} har yanzu yana jiran ka saukar. Hanyar saukewa za ta ƙare cikin kusan sa'o'i 24 — bayan haka za ka buƙaci nemi sabon fitar daga allon Sirri.",
      bodyWithLinkLead: "Danna maɓallin da ke ƙasa don ɗaukar ajiyarka kafin hanyar haɗin ta ƙare.",
      bodyButtonLabel: "⬇ Sauke ajiyar bayanaina",
      bodyFallbackHint: "Idan maɓallin bai yi aiki ba, kuna iya buɗe allon Sirri a cikin manhajar {orgName} ku saukar daga can.",
      bodyNoLink: "Buɗe allon Sirri a cikin manhajar {orgName} don saukar da ajiyarka kafin ta ƙare.",
      optOutLead: "",
      optOutLinkText: "Daina tunatar da ni game da wannan saukewa",
      optOutTrailing: "",
    },
  },

  zu: {
    htmlLang: "zu",
    dir: "ltr",
    headerTag: "Ukuvikelwa Kwedatha",
    labelReference: "Inkomba",
    labelRequestType: "Uhlobo lwesicelo",
    labelFiledOn: "Sifakwe ngo",
    labelDueBy: "Kufanele kuphele ngo",
    typeLabelExport: "Ukuthumela idatha (ukufuduka)",
    footerNote: "Uma unemibuzo mayelana nalesi sicelo, phendula le-imeyili noma uxhumane no-{orgName} ngokuqondile.",
    completed: {
      subject: "Ukukhipha kwakho idatha sekulungile (#{ref})",
      heading: "Ukukhipha kwakho idatha sekulungele ukulandwa",
      intro: "Sawubona {name}, ukukhipha kwedatha yakho yomuntu osiqalile ku-{orgName} sekuqediwe futhi sekulungele ukulandwa.",
      bodyWithLinkLead: "Thepha inkinobho engezansi ukuze ulande i-archive yakho. Lesi sixhumanisi siyimfihlo yakho futhi siphelelwa yisikhathi emuva kwezinsuku ezingu-7 — sicela ulondoloze ifayela endaweni ephephile ngaphambi kokuthi siphelelwe yisikhathi.",
      bodyButtonLabel: "⬇ Landa i-archive yedatha yami",
      bodyFallbackHint: "Uma inkinobho ingasebenzi, ungavula isikrini Sokuvikela ku-app ye-{orgName} bese uyilanda lapho.",
      bodyNoLink: "Vula isikrini Sokuvikela ku-app ye-{orgName} ukuze ulande i-archive yakho. Izotholakala izinsuku ezingu-7.",
      optOutLead: "Sizokuthumela isikhumbuzo cishe ngamahora angu-24 ngaphambi kokuthi lokhu kulanda kuphelelwe yisikhathi.",
      optOutLinkText: "Ungangikhumbuzi ngalokhu kulanda",
      optOutTrailing: "uma uthanda ukukweqa.",
    },
    expiring: {
      subject: "Isikhumbuzo: ukukhipha kwakho idatha kuzophela maduze (#{ref})",
      heading: "Ukukhipha kwakho idatha kuzophela cishe ngamahora angu-24",
      intro: "Sawubona {name}, ukukhipha kwedatha yakho yomuntu osiqalile ku-{orgName} kusalindele ukuthi ukulande. Isixhumanisi sokulanda sizophela cishe ngamahora angu-24 — uma sesiphelile, kuzodingeka ucele okukhishwayo okusha esikrinini Sokuvikela.",
      bodyWithLinkLead: "Thepha inkinobho engezansi ukuze uthole i-archive yakho ngaphambi kokuthi isixhumanisi siphelelwe yisikhathi.",
      bodyButtonLabel: "⬇ Landa i-archive yedatha yami",
      bodyFallbackHint: "Uma inkinobho ingasebenzi, ungavula isikrini Sokuvikela ku-app ye-{orgName} bese uyilanda lapho.",
      bodyNoLink: "Vula isikrini Sokuvikela ku-app ye-{orgName} ukuze ulande i-archive yakho ngaphambi kokuthi iphelelwe yisikhathi.",
      optOutLead: "",
      optOutLinkText: "Yeka ukungikhumbuza ngalokhu kulanda",
      optOutTrailing: "",
    },
  },

  yo: {
    htmlLang: "yo",
    dir: "ltr",
    headerTag: "Ìdáàbòbò Dátà",
    labelReference: "Ìtọ́kasí",
    labelRequestType: "Irú ìbéèrè",
    labelFiledOn: "Tí a fi sílẹ̀ ní",
    labelDueBy: "Àkókò ìparí",
    typeLabelExport: "Ìgbéjáde dátà (gbígbé lọ)",
    footerNote: "Tí o bá ní àwọn ìbéèrè nípa ìbéèrè yìí, dáhùn ímeèlì yìí tàbí kàn sí {orgName} taara.",
    completed: {
      subject: "Ìgbéjáde dátà rẹ ti ṣetán (#{ref})",
      heading: "Ìgbéjáde dátà rẹ ti ṣetán láti gbasílẹ̀",
      intro: "Bawo {name}, ìgbéjáde dátà ti ara ẹni tí o béèrè láti ọ̀dọ̀ {orgName} ti parí ó sì ti ṣetán láti gbasílẹ̀.",
      bodyWithLinkLead: "Tẹ bọtìnì tó wà ní isalẹ̀ láti gbasílẹ̀ àkójọ rẹ. Ìjápọ̀ yìí jẹ́ ti ara ẹ nikan yóò sì parí ní ọjọ́ 7 — jọ̀wọ́ pa fáìlì náà mọ́ ní ibi tó ní ààbò kí ó tó parí.",
      bodyButtonLabel: "⬇ Gbasílẹ̀ àkójọ dátà mi",
      bodyFallbackHint: "Tí bọtìnì kò bá ṣiṣẹ́, o tún lè ṣí ojú ìbòmọlẹ̀ Aṣírí nínú ohun-èlò {orgName} kí o sì gbasílẹ̀ láti ibẹ̀.",
      bodyNoLink: "Ṣí ojú ìbòmọlẹ̀ Aṣírí nínú ohun-èlò {orgName} láti gbasílẹ̀ àkójọ rẹ. Yóò wà fún ọjọ́ 7.",
      optOutLead: "A ó fi ìránnilétí ránṣẹ́ sí ọ ní nǹkan bí wákàtí 24 kí ìgbasílẹ̀ yìí tó parí.",
      optOutLinkText: "Má ràn mí létí nípa ìgbasílẹ̀ yìí",
      optOutTrailing: "tí o bá fẹ́ fò ó.",
    },
    expiring: {
      subject: "Ìránnilétí: ìgbéjáde dátà rẹ yóò parí láìpẹ́ (#{ref})",
      heading: "Ìgbéjáde dátà rẹ yóò parí ní nǹkan bí wákàtí 24",
      intro: "Bawo {name}, ìgbéjáde dátà ti ara ẹni tí o béèrè láti ọ̀dọ̀ {orgName} ṣì ń dúró fún ọ láti gbasílẹ̀. Ìjápọ̀ ìgbasílẹ̀ yóò parí ní nǹkan bí wákàtí 24 — bí ó bá ti parí, ìwọ yóò ní láti béèrè ìgbéjáde tuntun láti ojú ìbòmọlẹ̀ Aṣírí.",
      bodyWithLinkLead: "Tẹ bọtìnì tó wà ní isalẹ̀ láti mú àkójọ rẹ kí ìjápọ̀ tó parí.",
      bodyButtonLabel: "⬇ Gbasílẹ̀ àkójọ dátà mi",
      bodyFallbackHint: "Tí bọtìnì kò bá ṣiṣẹ́, o tún lè ṣí ojú ìbòmọlẹ̀ Aṣírí nínú ohun-èlò {orgName} kí o sì gbasílẹ̀ láti ibẹ̀.",
      bodyNoLink: "Ṣí ojú ìbòmọlẹ̀ Aṣírí nínú ohun-èlò {orgName} láti gbasílẹ̀ àkójọ rẹ kí ó tó parí.",
      optOutLead: "",
      optOutLinkText: "Dáwọ́ rírán mi létí nípa ìgbasílẹ̀ yìí dúró",
      optOutTrailing: "",
    },
  },
};

function fmt(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

/**
 * Per-language shell shared by every data-protection email — used by the
 * sibling `dataRequestEmailI18n.ts` module (Task #2167) so the four
 * non-export `DataRequestEmailKind` arms (`filed`, `in_progress`,
 * `completed`, `rejected`) can emit the same labels, header tag,
 * footer note, type label, and `lang`/`dir` HTML attributes the two
 * export-related kinds already use, without duplicating the
 * per-language strings stored in `PACKS`.
 *
 * Returns the English shell when the supplied `lang` is missing or
 * unsupported (mirrors {@link resolveDataExportEmailLang}).
 */
export interface DataRequestEmailShell {
  htmlLang: string;
  dir: "ltr" | "rtl";
  headerTag: string;
  labelReference: string;
  labelRequestType: string;
  labelFiledOn: string;
  labelDueBy: string;
  /** Localised "Data export (portability)" type label — only used by the export-related arms. */
  typeLabelExport: string;
  /** Footer paragraph template; carries the `{orgName}` placeholder. */
  footerNote: string;
}

export function getDataRequestEmailShell(
  lang: string | null | undefined,
): DataRequestEmailShell {
  const code = resolveDataExportEmailLang(lang);
  const pack = PACKS[code];
  return {
    htmlLang: pack.htmlLang,
    dir: pack.dir,
    headerTag: pack.headerTag,
    labelReference: pack.labelReference,
    labelRequestType: pack.labelRequestType,
    labelFiledOn: pack.labelFiledOn,
    labelDueBy: pack.labelDueBy,
    typeLabelExport: pack.typeLabelExport,
    footerNote: pack.footerNote,
  };
}

/** Same `fmt` template helper used internally — exported for the sibling
 * `dataRequestEmailI18n.ts` module so the two i18n hubs share an
 * identical placeholder substitution rule (`{var}` → value). */
export function formatDataRequestEmailString(
  tpl: string,
  vars: Record<string, string>,
): string {
  return fmt(tpl, vars);
}

export type DataExportEmailKind = "completed_export" | "export_expiring";

export interface DataExportEmailTranslationVars {
  /** Already-HTML-escaped recipient display name (used inside `intro`). */
  name: string;
  /** Already-HTML-escaped organisation name. */
  orgName: string;
  /** Numeric data-request id; rendered as `#{ref}`. */
  ref: string | number;
}

export interface DataExportEmailTranslation {
  htmlLang: string;
  dir: "ltr" | "rtl";
  headerTag: string;
  /** Subject line (plain text, with the recipient's `#{ref}` and orgName already substituted). */
  subject: string;
  /** `<h2>` heading. */
  heading: string;
  /** Greeting + intro paragraph (allows the embedded `<strong>` markup callers may inject). */
  intro: string;
  /** Lead sentence above the download CTA when a one-tap link is present. */
  bodyWithLinkLead: string;
  /** Text inside the download button. */
  bodyButtonLabel: string;
  /** Hint shown below the button (in case the button doesn't work). */
  bodyFallbackHint: string;
  /** Body shown when no signed link is available. */
  bodyNoLink: string;
  /** Sentence above the opt-out anchor (may be empty). */
  optOutLead: string;
  /** Inline link text rendered as the unsubscribe anchor. */
  optOutLinkText: string;
  /** Trailing copy after the link text (may be empty). */
  optOutTrailing: string;
  /** Field labels rendered in the metadata table. */
  labelReference: string;
  labelRequestType: string;
  labelFiledOn: string;
  labelDueBy: string;
  /** Localised "Data export (portability)" type label. */
  typeLabelExport: string;
  /** Boilerplate footer paragraph. */
  footerNote: string;
}

/**
 * Translate the data-export email strings for a given language code.
 *
 * `vars.name` and `vars.orgName` are interpolated directly into the
 * returned strings (and rendered into the email HTML), so the caller
 * MUST pass HTML-escaped values when those fields can carry
 * user-controlled content.
 */
export function translateDataExportEmail(
  lang: string | null | undefined,
  kind: DataExportEmailKind,
  vars: DataExportEmailTranslationVars,
): DataExportEmailTranslation {
  const code = resolveDataExportEmailLang(lang);
  const pack = PACKS[code];
  const kindCopy = kind === "completed_export" ? pack.completed : pack.expiring;
  const baseVars = {
    name: vars.name,
    orgName: vars.orgName,
    ref: String(vars.ref),
  };
  return {
    htmlLang: pack.htmlLang,
    dir: pack.dir,
    headerTag: pack.headerTag,
    subject: fmt(kindCopy.subject, baseVars),
    heading: kindCopy.heading,
    intro: fmt(kindCopy.intro, baseVars),
    bodyWithLinkLead: kindCopy.bodyWithLinkLead,
    bodyButtonLabel: kindCopy.bodyButtonLabel,
    bodyFallbackHint: fmt(kindCopy.bodyFallbackHint, baseVars),
    bodyNoLink: fmt(kindCopy.bodyNoLink, baseVars),
    optOutLead: kindCopy.optOutLead,
    optOutLinkText: kindCopy.optOutLinkText,
    optOutTrailing: kindCopy.optOutTrailing,
    labelReference: pack.labelReference,
    labelRequestType: pack.labelRequestType,
    labelFiledOn: pack.labelFiledOn,
    labelDueBy: pack.labelDueBy,
    typeLabelExport: pack.typeLabelExport,
    footerNote: fmt(pack.footerNote, baseVars),
  };
}
