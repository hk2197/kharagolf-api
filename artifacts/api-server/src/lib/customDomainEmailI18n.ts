/**
 * Translations for the custom-domain HTTPS admin emails (active / failed).
 *
 * Mirrors the 21 languages declared by the `supported_language` enum and
 * exposed by `SUPPORTED_LANGUAGES` in the mobile/web i18n setup. Each language
 * ships subject + body strings for both the "HTTPS is live" and the
 * "HTTPS provisioning failed" templates.
 *
 * Strings use {host}, {orgName}, {recipient}, {error} placeholders.
 */

export type CustomDomainEmailLang =
  | "en" | "hi" | "ar" | "es" | "fr" | "de" | "pt"
  | "ja" | "ko" | "zh" | "th" | "ms" | "id" | "vi"
  | "fil" | "sw" | "af" | "am" | "ha" | "zu" | "yo";

export const CUSTOM_DOMAIN_EMAIL_LANGS: CustomDomainEmailLang[] = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

export type CustomDomainEmailStrings = {
  headerTag: string;
  active: {
    subject: string;     // uses {host} {orgName}
    heading: string;
    greeting: string;    // uses {recipient} {host} {orgName}
    cta: string;         // uses {host}
    footer: string;      // uses {settingsLinkOpen} {settingsLinkClose}
  };
  failed: {
    subject: string;     // uses {host} {orgName}
    heading: string;
    greeting: string;    // uses {recipient} {host}
    providerErrorLabel: string;
    /** Used as the body of the provider-error block when the upstream call returned no reason. */
    noReason: string;
    retry: string;       // uses {orgName}
    cta: string;
    /**
     * Task #1255 — One-line ETA shown above the CTA so admins know when the
     * next reminder will land if they don't fix the cert. Uses {date}, which
     * is a localised date string (Intl.DateTimeFormat dateStyle:'long').
     */
    nextReminder: string; // uses {date}
    /**
     * Task #1262 — One-line header acknowledging that a re-nudge snooze the
     * admin set has elapsed and re-nudges have resumed. Only rendered on
     * re-nudges that fired because the snooze window ended (not on the
     * initial failed transition or on threshold-only re-nudges). Uses
     * {date}, which is the localised long-format snooze-until date.
     */
    snoozeEnded: string; // uses {date}
  };
  /**
   * Task #1044 — round-robin tie-break required email
   * (sent by `sendRoundRobinTieBreakAlertEmail`, see Task #898).
   */
  tieBreak: {
    headerTag: string;
    subject: string;     // uses {orgName} {tournamentName}
    heading: string;
    greeting: string;    // uses {recipient} {tournamentName}
    cta: string;
    footer: string;      // uses {orgName}
  };
  /**
   * Task #1271 — opt-out footer rendered at the bottom of side-game
   * settlement receipt emails (sent by `sendSideGameSettlementReceiptEmail`,
   * footer originally added by Task #1105). Uses {linkOpen}, {linkClose},
   * and {orgName} placeholders so each translation can position the deep
   * link to the dedicated "Side-game payment receipts" toggle (Task #962)
   * naturally within the sentence.
   */
  sideGameReceipt: {
    optOutFooter: string; // uses {linkOpen} {linkClose} {orgName}
    /**
     * Task #1488 — translated body and table-label strings for the side-game
     * settlement receipt. Task #1271 covered only the opt-out footer; the
     * heading, greeting, table column labels, and trailing boilerplate
     * paragraph used to render in English regardless of the recipient's
     * preferred language. These keys translate the rest of the email body
     * with English fallback.
     *
     * Available placeholders (any individual string may use a subset):
     * {recipient}, {payer}, {gameLabel}, {currencySymbol}, {amount}, {orgName}.
     */
    heading: string;
    greeting: string;     // uses {recipient} {payer} {gameLabel}
    boilerplate: string;  // uses {orgName}
    labelSideGame: string;
    labelFrom: string;
    labelAmount: string;
    labelCurrency: string;
    labelMethod: string;
    labelReference: string;
    labelPaidAt: string;
    /**
     * Task #1827 — translated subject line for the side-game settlement
     * receipt email. Tasks #1271/#1488 localised the body but the inbox
     * preview still showed the hard-coded English subject from
     * `sendSideGameSettlementReceiptEmail`. Uses {currencySymbol},
     * {amount}, {gameLabel}, and {orgName} placeholders.
     */
    subject: string;
  };
};

const PACKS: Record<CustomDomainEmailLang, CustomDomainEmailStrings> = {
  en: {
    headerTag: "Custom Domain",
    active: {
      subject: "HTTPS is live for {host} — {orgName}",
      heading: "HTTPS is now live",
      greeting: "Hi {recipient}, the SSL certificate for <strong style=\"color:#fff;\">{host}</strong> has been provisioned successfully. Players visiting {orgName} on this address will see a secure padlock — feel free to announce the new URL.",
      cta: "Visit {host}",
      footer: "Manage your domain on the {settingsLinkOpen}club settings page{settingsLinkClose}.",
    },
    failed: {
      subject: "HTTPS provisioning failed for {host} — {orgName}",
      heading: "HTTPS provisioning failed",
      greeting: "Hi {recipient}, we couldn't issue an SSL certificate for <strong style=\"color:#fff;\">{host}</strong>. The most common cause is a DNS record that hasn't been pointed at the platform yet.",
      providerErrorLabel: "Provider error",
      noReason: "The certificate provider did not return a reason.",
      retry: "Once you've corrected the DNS for {orgName}, open the club settings page and press <em>Retry</em> to ask the provider again.",
      cta: "Open club settings",
      nextReminder: "If this isn't fixed, we'll email you again on {date}.",
      snoozeEnded: "You previously snoozed these reminders until {date} — that snooze has now ended, so we're nudging you again.",
    },
    tieBreak: {
      headerTag: "Tie-Break Required",
      subject: "[{orgName}] Tie-break required — {tournamentName}",
      heading: "Round-robin tie-break required",
      greeting: "Hi {recipient}, the top of the standings is tied in <strong style=\"color:#fff;\">{tournamentName}</strong>. A tie-break match has been auto-generated and is waiting to be played.",
      cta: "Open Tie-Break Match",
      footer: "You're receiving this because you are listed as a tournament director or org admin for {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "Don't want these? {linkOpen}Turn off side-game receipts in your communication preferences{linkClose}. Other {orgName} emails are unaffected.",
      heading: "Payment received",
      greeting: "Hi {recipient}, <strong style=\"color:#fff;\">{payer}</strong> just paid you for <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "This is a record of a side-game settlement between players. If anything looks incorrect, please contact {orgName} directly.",
      labelSideGame: "Side game",
      labelFrom: "From",
      labelAmount: "Amount",
      labelCurrency: "Currency",
      labelMethod: "Method",
      labelReference: "Reference",
      labelPaidAt: "Paid at",
      subject: "You were paid {currencySymbol}{amount} for {gameLabel} ({orgName})",
    },
  },

  hi: {
    headerTag: "कस्टम डोमेन",
    active: {
      subject: "{host} के लिए HTTPS चालू है — {orgName}",
      heading: "HTTPS अब चालू है",
      greeting: "नमस्ते {recipient}, <strong style=\"color:#fff;\">{host}</strong> के लिए SSL प्रमाणपत्र सफलतापूर्वक जारी कर दिया गया है। इस पते पर {orgName} पर आने वाले खिलाड़ियों को सुरक्षित ताला दिखेगा — आप नया URL साझा कर सकते हैं।",
      cta: "{host} पर जाएँ",
      footer: "अपना डोमेन {settingsLinkOpen}क्लब सेटिंग्स पेज{settingsLinkClose} से प्रबंधित करें।",
    },
    failed: {
      subject: "{host} के लिए HTTPS सेट अप विफल — {orgName}",
      heading: "HTTPS सेट अप विफल",
      greeting: "नमस्ते {recipient}, हम <strong style=\"color:#fff;\">{host}</strong> के लिए SSL प्रमाणपत्र जारी नहीं कर सके। सबसे आम कारण यह होता है कि DNS रिकॉर्ड अभी तक प्लेटफ़ॉर्म की ओर निर्देशित नहीं है।",
      providerErrorLabel: "प्रदाता त्रुटि",
      noReason: "प्रमाणपत्र प्रदाता ने कोई कारण नहीं बताया।",
      retry: "{orgName} के लिए DNS ठीक करने के बाद, क्लब सेटिंग्स पेज खोलें और प्रदाता से फिर अनुरोध करने के लिए <em>पुनः प्रयास</em> दबाएँ।",
      cta: "क्लब सेटिंग्स खोलें",
      nextReminder: "यदि यह ठीक नहीं किया गया, तो हम आपको {date} को फिर से ईमेल करेंगे।",
      snoozeEnded: "आपने इन अनुस्मारकों को {date} तक के लिए स्थगित किया था — वह स्थगन अब समाप्त हो गया है, इसलिए हम आपको फिर से सूचित कर रहे हैं।",
    },
    tieBreak: {
      headerTag: "टाई-ब्रेक आवश्यक",
      subject: "[{orgName}] टाई-ब्रेक आवश्यक — {tournamentName}",
      heading: "राउंड-रॉबिन टाई-ब्रेक आवश्यक",
      greeting: "नमस्ते {recipient}, <strong style=\"color:#fff;\">{tournamentName}</strong> में स्टैंडिंग के शीर्ष पर बराबरी है। एक टाई-ब्रेक मैच स्वचालित रूप से बना दिया गया है और खेले जाने की प्रतीक्षा में है।",
      cta: "टाई-ब्रेक मैच खोलें",
      footer: "आप यह संदेश इसलिए प्राप्त कर रहे हैं क्योंकि आप {orgName} के लिए टूर्नामेंट डायरेक्टर या संगठन एडमिन के रूप में सूचीबद्ध हैं।",
    },
    sideGameReceipt: {
      optOutFooter: "ये नहीं चाहिए? {linkOpen}अपनी संचार प्राथमिकताओं में साइड-गेम रसीदें बंद करें{linkClose}। {orgName} के अन्य ईमेल अप्रभावित रहेंगे।",
      heading: "भुगतान प्राप्त हुआ",
      greeting: "नमस्ते {recipient}, <strong style=\"color:#fff;\">{payer}</strong> ने अभी-अभी आपको <strong style=\"color:#fff;\">{gameLabel}</strong> के लिए भुगतान किया है।",
      boilerplate: "यह खिलाड़ियों के बीच साइड-गेम निपटान का रिकॉर्ड है। यदि कुछ गलत लगे, तो कृपया सीधे {orgName} से संपर्क करें।",
      labelSideGame: "साइड-गेम",
      labelFrom: "भेजने वाला",
      labelAmount: "राशि",
      labelCurrency: "मुद्रा",
      labelMethod: "तरीका",
      labelReference: "संदर्भ संख्या",
      labelPaidAt: "भुगतान का समय",
      subject: "आपको {gameLabel} के लिए {currencySymbol}{amount} का भुगतान मिला ({orgName})",
    },
  },

  ar: {
    headerTag: "نطاق مخصص",
    active: {
      subject: "تم تفعيل HTTPS للنطاق {host} — {orgName}",
      heading: "أصبح HTTPS مفعّلاً",
      greeting: "مرحباً {recipient}، تم إصدار شهادة SSL للنطاق <strong style=\"color:#fff;\">{host}</strong> بنجاح. سيرى اللاعبون الذين يزورون {orgName} على هذا العنوان قفلاً آمناً — يمكنك الآن الإعلان عن الرابط الجديد.",
      cta: "زيارة {host}",
      footer: "أدِر نطاقك من {settingsLinkOpen}صفحة إعدادات النادي{settingsLinkClose}.",
    },
    failed: {
      subject: "فشل إعداد HTTPS للنطاق {host} — {orgName}",
      heading: "فشل إعداد HTTPS",
      greeting: "مرحباً {recipient}، لم نتمكن من إصدار شهادة SSL للنطاق <strong style=\"color:#fff;\">{host}</strong>. السبب الأكثر شيوعاً هو أنّ سجل DNS لم يتم توجيهه بعد إلى المنصة.",
      providerErrorLabel: "خطأ المزوّد",
      noReason: "لم يُرجع مزوّد الشهادة أي سبب.",
      retry: "بعد تصحيح سجل DNS لـ {orgName}، افتح صفحة إعدادات النادي واضغط <em>إعادة المحاولة</em> لطلب الشهادة مجدداً.",
      cta: "فتح إعدادات النادي",
      nextReminder: "إذا لم يتم إصلاح ذلك، فسنرسل لك بريداً إلكترونياً مرة أخرى في {date}.",
      snoozeEnded: "كنت قد أجّلت هذه التذكيرات حتى {date} — انتهت فترة التأجيل الآن، لذا نعيد تذكيرك.",
    },
    tieBreak: {
      headerTag: "مطلوب فاصل التعادل",
      subject: "[{orgName}] مطلوب فاصل تعادل — {tournamentName}",
      heading: "مطلوب فاصل تعادل في الدوري",
      greeting: "مرحباً {recipient}، تعادلت المراكز الأولى في <strong style=\"color:#fff;\">{tournamentName}</strong>. تم إنشاء مباراة فاصلة تلقائياً وهي بانتظار اللعب.",
      cta: "فتح مباراة فاصل التعادل",
      footer: "تتلقى هذه الرسالة لأنك مُدرَج كمدير بطولة أو مسؤول منظمة لـ {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "لا ترغب في تلقي هذه الرسائل؟ {linkOpen}عطّل إيصالات الألعاب الجانبية من تفضيلات الاتصال{linkClose}. لن تتأثر رسائل {orgName} الأخرى.",
      heading: "تم استلام الدفع",
      greeting: "مرحباً {recipient}، دفع لك <strong style=\"color:#fff;\">{payer}</strong> للتو مقابل <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "هذا سجل لتسوية لعبة جانبية بين اللاعبين. إذا بدا أي شيء غير صحيح، يرجى التواصل مع {orgName} مباشرة.",
      labelSideGame: "اللعبة الجانبية",
      labelFrom: "من",
      labelAmount: "المبلغ",
      labelCurrency: "العملة",
      labelMethod: "طريقة الدفع",
      labelReference: "المرجع",
      labelPaidAt: "وقت الدفع",
      subject: "تم دفع {currencySymbol}{amount} لك مقابل {gameLabel} ({orgName})",
    },
  },

  es: {
    headerTag: "Dominio personalizado",
    active: {
      subject: "HTTPS activo para {host} — {orgName}",
      heading: "HTTPS ya está activo",
      greeting: "Hola {recipient}, el certificado SSL para <strong style=\"color:#fff;\">{host}</strong> se ha emitido correctamente. Los jugadores que visiten {orgName} en esta dirección verán un candado seguro — ya puedes anunciar la nueva URL.",
      cta: "Visitar {host}",
      footer: "Gestiona tu dominio en la {settingsLinkOpen}página de configuración del club{settingsLinkClose}.",
    },
    failed: {
      subject: "Falló el aprovisionamiento de HTTPS para {host} — {orgName}",
      heading: "Falló el aprovisionamiento de HTTPS",
      greeting: "Hola {recipient}, no pudimos emitir un certificado SSL para <strong style=\"color:#fff;\">{host}</strong>. La causa más común es un registro DNS que aún no apunta a la plataforma.",
      providerErrorLabel: "Error del proveedor",
      noReason: "El proveedor del certificado no indicó ningún motivo.",
      retry: "Una vez corregido el DNS de {orgName}, abre la página de configuración del club y pulsa <em>Reintentar</em> para volver a solicitarlo al proveedor.",
      cta: "Abrir configuración del club",
      nextReminder: "Si no se corrige, te enviaremos otro correo el {date}.",
      snoozeEnded: "Habías pospuesto estos recordatorios hasta el {date} — esa pausa ya terminó, así que volvemos a avisarte.",
    },
    tieBreak: {
      headerTag: "Desempate requerido",
      subject: "[{orgName}] Desempate requerido — {tournamentName}",
      heading: "Se requiere desempate de round-robin",
      greeting: "Hola {recipient}, hay empate en la cabeza de la clasificación de <strong style=\"color:#fff;\">{tournamentName}</strong>. Se ha generado automáticamente un partido de desempate y está pendiente de jugarse.",
      cta: "Abrir partido de desempate",
      footer: "Recibes este aviso porque figuras como director de torneo o administrador de la organización en {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "¿No quieres recibir estos correos? {linkOpen}Desactiva los recibos de juegos paralelos en tus preferencias de comunicación{linkClose}. Los demás correos de {orgName} no se verán afectados.",
      heading: "Pago recibido",
      greeting: "Hola {recipient}, <strong style=\"color:#fff;\">{payer}</strong> acaba de pagarte por <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "Este es un registro de una liquidación de juego paralelo entre jugadores. Si algo no parece correcto, contacta directamente con {orgName}.",
      labelSideGame: "Juego paralelo",
      labelFrom: "De",
      labelAmount: "Importe",
      labelCurrency: "Moneda",
      labelMethod: "Método",
      labelReference: "Referencia",
      labelPaidAt: "Pagado el",
      subject: "Recibiste {currencySymbol}{amount} por {gameLabel} ({orgName})",
    },
  },

  fr: {
    headerTag: "Domaine personnalisé",
    active: {
      subject: "HTTPS actif pour {host} — {orgName}",
      heading: "HTTPS est maintenant actif",
      greeting: "Bonjour {recipient}, le certificat SSL pour <strong style=\"color:#fff;\">{host}</strong> a été délivré avec succès. Les joueurs qui visitent {orgName} à cette adresse verront un cadenas sécurisé — vous pouvez annoncer la nouvelle URL.",
      cta: "Visiter {host}",
      footer: "Gérez votre domaine depuis la {settingsLinkOpen}page des paramètres du club{settingsLinkClose}.",
    },
    failed: {
      subject: "Échec de la mise en place HTTPS pour {host} — {orgName}",
      heading: "Échec de la mise en place HTTPS",
      greeting: "Bonjour {recipient}, nous n'avons pas pu délivrer de certificat SSL pour <strong style=\"color:#fff;\">{host}</strong>. La cause la plus fréquente est un enregistrement DNS qui ne pointe pas encore vers la plateforme.",
      providerErrorLabel: "Erreur du fournisseur",
      noReason: "Le fournisseur du certificat n'a pas indiqué de raison.",
      retry: "Une fois le DNS corrigé pour {orgName}, ouvrez la page des paramètres du club et appuyez sur <em>Réessayer</em> pour redemander au fournisseur.",
      cta: "Ouvrir les paramètres du club",
      nextReminder: "Si ce n'est pas corrigé, nous vous enverrons un nouvel e-mail le {date}.",
      snoozeEnded: "Vous aviez mis en pause ces rappels jusqu'au {date} — cette pause est maintenant terminée, nous reprenons donc les notifications.",
    },
    tieBreak: {
      headerTag: "Barrage requis",
      subject: "[{orgName}] Barrage requis — {tournamentName}",
      heading: "Barrage de round-robin requis",
      greeting: "Bonjour {recipient}, il y a égalité en tête du classement de <strong style=\"color:#fff;\">{tournamentName}</strong>. Un match de barrage a été généré automatiquement et attend d'être joué.",
      cta: "Ouvrir le match de barrage",
      footer: "Vous recevez ce message car vous êtes répertorié comme directeur de tournoi ou administrateur d'organisation pour {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "Vous ne souhaitez plus recevoir ces e-mails ? {linkOpen}Désactivez les reçus de jeux annexes dans vos préférences de communication{linkClose}. Les autres e-mails de {orgName} ne sont pas affectés.",
      heading: "Paiement reçu",
      greeting: "Bonjour {recipient}, <strong style=\"color:#fff;\">{payer}</strong> vient de vous payer pour <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "Ceci est un enregistrement d'un règlement de jeu annexe entre joueurs. Si quelque chose semble incorrect, veuillez contacter {orgName} directement.",
      labelSideGame: "Jeu annexe",
      labelFrom: "De",
      labelAmount: "Montant",
      labelCurrency: "Devise",
      labelMethod: "Mode de paiement",
      labelReference: "Référence",
      labelPaidAt: "Payé le",
      subject: "Vous avez reçu {currencySymbol}{amount} pour {gameLabel} ({orgName})",
    },
  },

  de: {
    headerTag: "Eigene Domain",
    active: {
      subject: "HTTPS ist aktiv für {host} — {orgName}",
      heading: "HTTPS ist jetzt aktiv",
      greeting: "Hallo {recipient}, das SSL-Zertifikat für <strong style=\"color:#fff;\">{host}</strong> wurde erfolgreich ausgestellt. Spieler, die {orgName} unter dieser Adresse besuchen, sehen ein sicheres Schloss — Sie können die neue URL bekannt geben.",
      cta: "{host} besuchen",
      footer: "Verwalten Sie Ihre Domain auf der {settingsLinkOpen}Club-Einstellungsseite{settingsLinkClose}.",
    },
    failed: {
      subject: "HTTPS-Bereitstellung fehlgeschlagen für {host} — {orgName}",
      heading: "HTTPS-Bereitstellung fehlgeschlagen",
      greeting: "Hallo {recipient}, wir konnten kein SSL-Zertifikat für <strong style=\"color:#fff;\">{host}</strong> ausstellen. Die häufigste Ursache ist ein DNS-Eintrag, der noch nicht auf die Plattform zeigt.",
      providerErrorLabel: "Anbieterfehler",
      noReason: "Der Zertifikatsanbieter hat keinen Grund angegeben.",
      retry: "Sobald Sie den DNS für {orgName} korrigiert haben, öffnen Sie die Club-Einstellungen und drücken Sie <em>Erneut versuchen</em>, um den Anbieter erneut anzufragen.",
      cta: "Club-Einstellungen öffnen",
      nextReminder: "Wenn das Problem nicht behoben wird, senden wir Ihnen am {date} eine weitere E-Mail.",
      snoozeEnded: "Sie hatten diese Erinnerungen bis zum {date} pausiert — die Pause ist nun abgelaufen, daher melden wir uns wieder.",
    },
    tieBreak: {
      headerTag: "Stechen erforderlich",
      subject: "[{orgName}] Stechen erforderlich — {tournamentName}",
      heading: "Round-Robin-Stechen erforderlich",
      greeting: "Hallo {recipient}, an der Spitze der Tabelle von <strong style=\"color:#fff;\">{tournamentName}</strong> besteht Gleichstand. Ein Stechspiel wurde automatisch erstellt und wartet darauf, gespielt zu werden.",
      cta: "Stechspiel öffnen",
      footer: "Sie erhalten diese Nachricht, weil Sie als Turnierleiter oder Organisations-Admin für {orgName} eingetragen sind.",
    },
    sideGameReceipt: {
      optOutFooter: "Möchten Sie diese E-Mails nicht mehr erhalten? {linkOpen}Schalten Sie Side-Game-Belege in Ihren Kommunikationseinstellungen aus{linkClose}. Andere E-Mails von {orgName} sind davon nicht betroffen.",
      heading: "Zahlung erhalten",
      greeting: "Hallo {recipient}, <strong style=\"color:#fff;\">{payer}</strong> hat Sie soeben für <strong style=\"color:#fff;\">{gameLabel}</strong> bezahlt.",
      boilerplate: "Dies ist ein Beleg für die Abrechnung eines Side-Games zwischen Spielern. Falls etwas nicht stimmt, wenden Sie sich bitte direkt an {orgName}.",
      labelSideGame: "Side-Game",
      labelFrom: "Von",
      labelAmount: "Betrag",
      labelCurrency: "Währung",
      labelMethod: "Zahlungsart",
      labelReference: "Referenz",
      labelPaidAt: "Bezahlt am",
      subject: "Du hast {currencySymbol}{amount} für {gameLabel} erhalten ({orgName})",
    },
  },

  pt: {
    headerTag: "Domínio personalizado",
    active: {
      subject: "HTTPS ativo para {host} — {orgName}",
      heading: "HTTPS está ativo",
      greeting: "Olá {recipient}, o certificado SSL para <strong style=\"color:#fff;\">{host}</strong> foi emitido com sucesso. Os jogadores que visitarem {orgName} neste endereço verão um cadeado seguro — pode anunciar o novo URL.",
      cta: "Visitar {host}",
      footer: "Gerencie o seu domínio na {settingsLinkOpen}página de configurações do clube{settingsLinkClose}.",
    },
    failed: {
      subject: "Falha no provisionamento HTTPS para {host} — {orgName}",
      heading: "Falha no provisionamento HTTPS",
      greeting: "Olá {recipient}, não conseguimos emitir um certificado SSL para <strong style=\"color:#fff;\">{host}</strong>. A causa mais comum é um registro DNS que ainda não aponta para a plataforma.",
      providerErrorLabel: "Erro do provedor",
      noReason: "O provedor do certificado não retornou um motivo.",
      retry: "Depois de corrigir o DNS de {orgName}, abra a página de configurações do clube e clique em <em>Tentar novamente</em> para solicitar de novo ao provedor.",
      cta: "Abrir configurações do clube",
      nextReminder: "Se isto não for corrigido, enviaremos outro e-mail em {date}.",
      snoozeEnded: "Você havia adiado estes lembretes até {date} — esse adiamento terminou, por isso voltamos a avisar.",
    },
    tieBreak: {
      headerTag: "Desempate necessário",
      subject: "[{orgName}] Desempate necessário — {tournamentName}",
      heading: "Desempate de round-robin necessário",
      greeting: "Olá {recipient}, há empate no topo da classificação de <strong style=\"color:#fff;\">{tournamentName}</strong>. Uma partida de desempate foi gerada automaticamente e aguarda ser jogada.",
      cta: "Abrir partida de desempate",
      footer: "Você está recebendo isto porque consta como diretor de torneio ou administrador da organização em {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "Não deseja receber estes e-mails? {linkOpen}Desative os recibos de jogos paralelos nas suas preferências de comunicação{linkClose}. Os demais e-mails de {orgName} não são afetados.",
      heading: "Pagamento recebido",
      greeting: "Olá {recipient}, <strong style=\"color:#fff;\">{payer}</strong> acabou de pagar você por <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "Este é um registro de uma liquidação de jogo paralelo entre jogadores. Se algo parecer incorreto, entre em contato diretamente com {orgName}.",
      labelSideGame: "Jogo paralelo",
      labelFrom: "De",
      labelAmount: "Valor",
      labelCurrency: "Moeda",
      labelMethod: "Forma de pagamento",
      labelReference: "Referência",
      labelPaidAt: "Pago em",
      subject: "Você recebeu {currencySymbol}{amount} por {gameLabel} ({orgName})",
    },
  },

  ja: {
    headerTag: "カスタムドメイン",
    active: {
      subject: "{host} の HTTPS が有効になりました — {orgName}",
      heading: "HTTPS が有効になりました",
      greeting: "{recipient} さん、<strong style=\"color:#fff;\">{host}</strong> の SSL 証明書の発行が完了しました。このアドレスで {orgName} にアクセスするプレイヤーには安全な鍵マークが表示されます。新しい URL を案内できます。",
      cta: "{host} を開く",
      footer: "{settingsLinkOpen}クラブ設定ページ{settingsLinkClose}でドメインを管理できます。",
    },
    failed: {
      subject: "{host} の HTTPS 設定に失敗しました — {orgName}",
      heading: "HTTPS 設定に失敗しました",
      greeting: "{recipient} さん、<strong style=\"color:#fff;\">{host}</strong> の SSL 証明書を発行できませんでした。最も多い原因は、DNS レコードがまだプラットフォームに向いていないことです。",
      providerErrorLabel: "プロバイダーエラー",
      noReason: "証明書プロバイダーから理由は返されませんでした。",
      retry: "{orgName} の DNS を修正したら、クラブ設定ページを開いて <em>再試行</em> を押し、プロバイダーに再度依頼してください。",
      cta: "クラブ設定を開く",
      nextReminder: "解決されない場合、{date} に再度メールでお知らせします。",
      snoozeEnded: "これらの通知は {date} まで一時停止されていました。停止期間が終了したため、再度お知らせしています。",
    },
    tieBreak: {
      headerTag: "タイブレーク要請",
      subject: "[{orgName}] タイブレーク要請 — {tournamentName}",
      heading: "ラウンドロビンのタイブレークが必要です",
      greeting: "{recipient} さん、<strong style=\"color:#fff;\">{tournamentName}</strong> の順位表トップが同点になりました。タイブレークマッチが自動で作成され、プレー開始をお待ちしています。",
      cta: "タイブレークマッチを開く",
      footer: "このメールは、あなたが {orgName} のトーナメント ディレクターまたは組織管理者として登録されているため送信されています。",
    },
    sideGameReceipt: {
      optOutFooter: "このメールが不要な場合は、{linkOpen}通信設定からサイドゲームのレシートをオフ{linkClose}にできます。{orgName} の他のメールには影響しません。",
      heading: "支払いを受け取りました",
      greeting: "{recipient} さん、<strong style=\"color:#fff;\">{payer}</strong> さんが <strong style=\"color:#fff;\">{gameLabel}</strong> の代金を支払いました。",
      boilerplate: "これはプレイヤー間のサイドゲーム精算の記録です。誤りがある場合は、直接 {orgName} までご連絡ください。",
      labelSideGame: "サイドゲーム",
      labelFrom: "送金元",
      labelAmount: "金額",
      labelCurrency: "通貨",
      labelMethod: "支払い方法",
      labelReference: "参照番号",
      labelPaidAt: "支払い日時",
      subject: "{gameLabel} の代金 {currencySymbol}{amount} を受け取りました ({orgName})",
    },
  },

  ko: {
    headerTag: "사용자 지정 도메인",
    active: {
      subject: "{host}의 HTTPS가 활성화되었습니다 — {orgName}",
      heading: "HTTPS가 활성화되었습니다",
      greeting: "{recipient}님, <strong style=\"color:#fff;\">{host}</strong>의 SSL 인증서가 정상적으로 발급되었습니다. 이 주소로 {orgName}에 접속하는 플레이어에게 보안 잠금이 표시됩니다. 이제 새 URL을 안내하셔도 됩니다.",
      cta: "{host} 방문",
      footer: "{settingsLinkOpen}클럽 설정 페이지{settingsLinkClose}에서 도메인을 관리하세요.",
    },
    failed: {
      subject: "{host}의 HTTPS 설정에 실패했습니다 — {orgName}",
      heading: "HTTPS 설정 실패",
      greeting: "{recipient}님, <strong style=\"color:#fff;\">{host}</strong>의 SSL 인증서를 발급할 수 없습니다. 가장 흔한 원인은 DNS 레코드가 아직 플랫폼을 가리키지 않는 경우입니다.",
      providerErrorLabel: "공급자 오류",
      noReason: "인증서 공급자가 이유를 반환하지 않았습니다.",
      retry: "{orgName}의 DNS를 수정한 뒤 클럽 설정 페이지를 열고 <em>재시도</em>를 눌러 공급자에게 다시 요청하세요.",
      cta: "클럽 설정 열기",
      nextReminder: "이 문제가 해결되지 않으면 {date}에 다시 이메일로 알려드립니다.",
      snoozeEnded: "이 알림을 {date}까지 일시 중지하셨습니다. 일시 중지 기간이 끝나서 다시 알려드립니다.",
    },
    tieBreak: {
      headerTag: "타이브레이크 필요",
      subject: "[{orgName}] 타이브레이크 필요 — {tournamentName}",
      heading: "라운드 로빈 타이브레이크가 필요합니다",
      greeting: "{recipient}님, <strong style=\"color:#fff;\">{tournamentName}</strong>의 순위 상위가 동점입니다. 타이브레이크 경기가 자동으로 생성되어 진행을 기다리고 있습니다.",
      cta: "타이브레이크 경기 열기",
      footer: "{orgName}의 토너먼트 디렉터 또는 조직 관리자로 등록되어 있어 이 메일을 받으셨습니다.",
    },
    sideGameReceipt: {
      optOutFooter: "이 메일을 받지 않으시려면 {linkOpen}커뮤니케이션 환경설정에서 사이드 게임 영수증을 끄세요{linkClose}. {orgName}의 다른 이메일에는 영향이 없습니다.",
      heading: "결제를 받았습니다",
      greeting: "{recipient}님, <strong style=\"color:#fff;\">{payer}</strong>님이 방금 <strong style=\"color:#fff;\">{gameLabel}</strong> 결제를 보내셨습니다.",
      boilerplate: "이는 플레이어 간 사이드 게임 정산 기록입니다. 잘못된 점이 있으면 {orgName}에 직접 문의해 주세요.",
      labelSideGame: "사이드 게임",
      labelFrom: "보낸 사람",
      labelAmount: "금액",
      labelCurrency: "통화",
      labelMethod: "결제 방법",
      labelReference: "참조 번호",
      labelPaidAt: "결제 일시",
      subject: "{gameLabel} 대금 {currencySymbol}{amount}를 받았습니다 ({orgName})",
    },
  },

  zh: {
    headerTag: "自定义域名",
    active: {
      subject: "{host} 的 HTTPS 已启用 — {orgName}",
      heading: "HTTPS 现已启用",
      greeting: "{recipient} 您好，<strong style=\"color:#fff;\">{host}</strong> 的 SSL 证书已成功签发。通过此地址访问 {orgName} 的球员将看到安全锁标志，您可以放心宣布新网址。",
      cta: "访问 {host}",
      footer: "在 {settingsLinkOpen}俱乐部设置页面{settingsLinkClose} 管理您的域名。",
    },
    failed: {
      subject: "{host} 的 HTTPS 配置失败 — {orgName}",
      heading: "HTTPS 配置失败",
      greeting: "{recipient} 您好，我们无法为 <strong style=\"color:#fff;\">{host}</strong> 签发 SSL 证书。最常见的原因是 DNS 记录尚未指向本平台。",
      providerErrorLabel: "服务商错误",
      noReason: "证书服务商未返回任何原因。",
      retry: "在为 {orgName} 修正 DNS 后，请打开俱乐部设置页面并点击<em>重试</em>，让我们再次向服务商申请。",
      cta: "打开俱乐部设置",
      nextReminder: "如果此问题未解决，我们将于 {date} 再次向您发送邮件提醒。",
      snoozeEnded: "您此前将这些提醒暂停至 {date}，暂停期已结束，因此我们再次向您提醒。",
    },
    tieBreak: {
      headerTag: "需要加赛",
      subject: "[{orgName}] 需要加赛 — {tournamentName}",
      heading: "循环赛需要加赛",
      greeting: "{recipient} 您好，<strong style=\"color:#fff;\">{tournamentName}</strong> 排行榜榜首出现并列。系统已自动生成一场加赛对局，正等待进行。",
      cta: "打开加赛对局",
      footer: "您收到此邮件是因为您在 {orgName} 中被列为赛事总监或机构管理员。",
    },
    sideGameReceipt: {
      optOutFooter: "不想再收到这些邮件？{linkOpen}在通讯偏好中关闭边赛收据{linkClose}。{orgName} 的其他邮件不受影响。",
      heading: "已收到付款",
      greeting: "{recipient} 您好，<strong style=\"color:#fff;\">{payer}</strong> 刚刚为 <strong style=\"color:#fff;\">{gameLabel}</strong> 向您付款。",
      boilerplate: "这是球员之间边赛结算的记录。如有任何不符，请直接联系 {orgName}。",
      labelSideGame: "边赛",
      labelFrom: "付款人",
      labelAmount: "金额",
      labelCurrency: "货币",
      labelMethod: "支付方式",
      labelReference: "参考编号",
      labelPaidAt: "支付时间",
      subject: "您收到 {gameLabel} 的付款 {currencySymbol}{amount} ({orgName})",
    },
  },

  th: {
    headerTag: "โดเมนกำหนดเอง",
    active: {
      subject: "HTTPS ใช้งานได้แล้วสำหรับ {host} — {orgName}",
      heading: "HTTPS ใช้งานได้แล้ว",
      greeting: "สวัสดี {recipient} ใบรับรอง SSL สำหรับ <strong style=\"color:#fff;\">{host}</strong> ออกใบรับรองสำเร็จแล้ว ผู้เล่นที่เข้า {orgName} ผ่านที่อยู่นี้จะเห็นไอคอนแม่กุญแจปลอดภัย คุณสามารถประกาศ URL ใหม่ได้",
      cta: "เปิด {host}",
      footer: "จัดการโดเมนของคุณได้ที่ {settingsLinkOpen}หน้าตั้งค่าคลับ{settingsLinkClose}",
    },
    failed: {
      subject: "ตั้งค่า HTTPS ไม่สำเร็จสำหรับ {host} — {orgName}",
      heading: "ตั้งค่า HTTPS ไม่สำเร็จ",
      greeting: "สวัสดี {recipient} เราไม่สามารถออกใบรับรอง SSL สำหรับ <strong style=\"color:#fff;\">{host}</strong> ได้ สาเหตุที่พบบ่อยที่สุดคือเรคคอร์ด DNS ยังไม่ได้ชี้มาที่แพลตฟอร์ม",
      providerErrorLabel: "ข้อผิดพลาดจากผู้ให้บริการ",
      noReason: "ผู้ให้บริการใบรับรองไม่ได้ระบุเหตุผล",
      retry: "หลังจากแก้ไข DNS ของ {orgName} แล้ว เปิดหน้าตั้งค่าคลับและกด <em>ลองอีกครั้ง</em> เพื่อให้เราขอใบรับรองจากผู้ให้บริการอีกครั้ง",
      cta: "เปิดการตั้งค่าคลับ",
      nextReminder: "หากยังไม่ได้รับการแก้ไข เราจะส่งอีเมลแจ้งเตือนคุณอีกครั้งในวันที่ {date}",
      snoozeEnded: "คุณได้เลื่อนการแจ้งเตือนเหล่านี้ไปจนถึง {date} ระยะการเลื่อนได้สิ้นสุดลงแล้ว เราจึงเริ่มแจ้งเตือนคุณอีกครั้ง",
    },
    tieBreak: {
      headerTag: "ต้องตัดสินเสมอ",
      subject: "[{orgName}] ต้องตัดสินเสมอ — {tournamentName}",
      heading: "ต้องมีการตัดสินเสมอแบบราวด์โรบิน",
      greeting: "สวัสดี {recipient} อันดับสูงสุดของ <strong style=\"color:#fff;\">{tournamentName}</strong> เสมอกัน ระบบสร้างแมตช์ตัดสินเสมอให้อัตโนมัติแล้วและกำลังรอการเล่น",
      cta: "เปิดแมตช์ตัดสินเสมอ",
      footer: "คุณได้รับอีเมลนี้เพราะคุณถูกระบุเป็นผู้อำนวยการการแข่งขันหรือผู้ดูแลองค์กรของ {orgName}",
    },
    sideGameReceipt: {
      optOutFooter: "ไม่ต้องการรับอีเมลเหล่านี้ใช่ไหม? {linkOpen}ปิดใบเสร็จเกมเสริมในการตั้งค่าการสื่อสารของคุณ{linkClose} อีเมลอื่นจาก {orgName} จะไม่ได้รับผลกระทบ",
      heading: "ได้รับการชำระเงินแล้ว",
      greeting: "สวัสดี {recipient} <strong style=\"color:#fff;\">{payer}</strong> เพิ่งชำระเงินให้คุณสำหรับ <strong style=\"color:#fff;\">{gameLabel}</strong>",
      boilerplate: "นี่เป็นบันทึกการชำระเงินเกมเสริมระหว่างผู้เล่น หากมีสิ่งใดไม่ถูกต้อง โปรดติดต่อ {orgName} โดยตรง",
      labelSideGame: "เกมเสริม",
      labelFrom: "จาก",
      labelAmount: "จำนวน",
      labelCurrency: "สกุลเงิน",
      labelMethod: "วิธีการชำระ",
      labelReference: "อ้างอิง",
      labelPaidAt: "ชำระเมื่อ",
      subject: "คุณได้รับ {currencySymbol}{amount} สำหรับ {gameLabel} ({orgName})",
    },
  },

  ms: {
    headerTag: "Domain Tersuai",
    active: {
      subject: "HTTPS aktif untuk {host} — {orgName}",
      heading: "HTTPS kini aktif",
      greeting: "Hai {recipient}, sijil SSL untuk <strong style=\"color:#fff;\">{host}</strong> telah dikeluarkan dengan jayanya. Pemain yang melawat {orgName} di alamat ini akan melihat ikon mangga selamat — anda boleh umumkan URL baharu.",
      cta: "Lawati {host}",
      footer: "Urus domain anda di {settingsLinkOpen}halaman tetapan kelab{settingsLinkClose}.",
    },
    failed: {
      subject: "Penyediaan HTTPS gagal untuk {host} — {orgName}",
      heading: "Penyediaan HTTPS gagal",
      greeting: "Hai {recipient}, kami tidak dapat mengeluarkan sijil SSL untuk <strong style=\"color:#fff;\">{host}</strong>. Punca paling biasa ialah rekod DNS belum diarahkan ke platform.",
      providerErrorLabel: "Ralat pembekal",
      noReason: "Pembekal sijil tidak memberikan sebab.",
      retry: "Setelah anda membetulkan DNS untuk {orgName}, buka halaman tetapan kelab dan tekan <em>Cuba semula</em> untuk meminta semula daripada pembekal.",
      cta: "Buka tetapan kelab",
      nextReminder: "Jika ini tidak diperbaiki, kami akan menghantar e-mel kepada anda sekali lagi pada {date}.",
      snoozeEnded: "Anda sebelum ini telah menangguhkan peringatan ini sehingga {date} — tempoh tangguh telah tamat, jadi kami menghantar peringatan semula.",
    },
    tieBreak: {
      headerTag: "Penentu Seri Diperlukan",
      subject: "[{orgName}] Penentu seri diperlukan — {tournamentName}",
      heading: "Perlawanan penentu seri round-robin diperlukan",
      greeting: "Hai {recipient}, kedudukan teratas dalam <strong style=\"color:#fff;\">{tournamentName}</strong> seri. Satu perlawanan penentu seri telah dijana secara automatik dan menunggu untuk dimainkan.",
      cta: "Buka perlawanan penentu seri",
      footer: "Anda menerima e-mel ini kerana anda disenaraikan sebagai pengarah kejohanan atau pentadbir organisasi untuk {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "Tidak mahu menerima e-mel ini? {linkOpen}Matikan resit permainan sampingan dalam keutamaan komunikasi anda{linkClose}. E-mel {orgName} yang lain tidak terjejas.",
      heading: "Pembayaran diterima",
      greeting: "Hai {recipient}, <strong style=\"color:#fff;\">{payer}</strong> baru sahaja membayar anda untuk <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "Ini adalah rekod penyelesaian permainan sampingan antara pemain. Jika ada yang tidak betul, sila hubungi {orgName} secara langsung.",
      labelSideGame: "Permainan sampingan",
      labelFrom: "Daripada",
      labelAmount: "Jumlah",
      labelCurrency: "Mata wang",
      labelMethod: "Kaedah",
      labelReference: "Rujukan",
      labelPaidAt: "Dibayar pada",
      subject: "Anda menerima {currencySymbol}{amount} untuk {gameLabel} ({orgName})",
    },
  },

  id: {
    headerTag: "Domain Khusus",
    active: {
      subject: "HTTPS aktif untuk {host} — {orgName}",
      heading: "HTTPS kini aktif",
      greeting: "Halo {recipient}, sertifikat SSL untuk <strong style=\"color:#fff;\">{host}</strong> berhasil diterbitkan. Pemain yang mengunjungi {orgName} di alamat ini akan melihat ikon gembok aman — Anda dapat mengumumkan URL baru.",
      cta: "Kunjungi {host}",
      footer: "Kelola domain Anda di {settingsLinkOpen}halaman pengaturan klub{settingsLinkClose}.",
    },
    failed: {
      subject: "Penerbitan HTTPS gagal untuk {host} — {orgName}",
      heading: "Penerbitan HTTPS gagal",
      greeting: "Halo {recipient}, kami tidak dapat menerbitkan sertifikat SSL untuk <strong style=\"color:#fff;\">{host}</strong>. Penyebab paling umum adalah catatan DNS yang belum diarahkan ke platform.",
      providerErrorLabel: "Kesalahan penyedia",
      noReason: "Penyedia sertifikat tidak memberikan alasan.",
      retry: "Setelah Anda memperbaiki DNS untuk {orgName}, buka halaman pengaturan klub dan tekan <em>Coba lagi</em> untuk meminta kembali ke penyedia.",
      cta: "Buka pengaturan klub",
      nextReminder: "Jika ini tidak diperbaiki, kami akan mengirimi Anda email lagi pada {date}.",
      snoozeEnded: "Anda sebelumnya menunda pengingat ini hingga {date} — masa penundaan sudah berakhir, jadi kami mengingatkan Anda lagi.",
    },
    tieBreak: {
      headerTag: "Pertandingan Penentu Diperlukan",
      subject: "[{orgName}] Pertandingan penentu diperlukan — {tournamentName}",
      heading: "Pertandingan penentu round-robin diperlukan",
      greeting: "Halo {recipient}, posisi teratas di <strong style=\"color:#fff;\">{tournamentName}</strong> berimbang. Sebuah pertandingan penentu telah dibuat secara otomatis dan menunggu untuk dimainkan.",
      cta: "Buka pertandingan penentu",
      footer: "Anda menerima ini karena Anda terdaftar sebagai direktur turnamen atau admin organisasi untuk {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "Tidak ingin menerima email ini? {linkOpen}Matikan tanda terima permainan sampingan di preferensi komunikasi Anda{linkClose}. Email {orgName} lainnya tidak terpengaruh.",
      heading: "Pembayaran diterima",
      greeting: "Halo {recipient}, <strong style=\"color:#fff;\">{payer}</strong> baru saja membayar Anda untuk <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "Ini adalah catatan penyelesaian permainan sampingan antar pemain. Jika ada yang tidak benar, silakan hubungi {orgName} secara langsung.",
      labelSideGame: "Permainan sampingan",
      labelFrom: "Dari",
      labelAmount: "Jumlah",
      labelCurrency: "Mata uang",
      labelMethod: "Metode",
      labelReference: "Referensi",
      labelPaidAt: "Dibayar pada",
      subject: "Anda menerima {currencySymbol}{amount} untuk {gameLabel} ({orgName})",
    },
  },

  vi: {
    headerTag: "Tên miền tùy chỉnh",
    active: {
      subject: "HTTPS đã hoạt động cho {host} — {orgName}",
      heading: "HTTPS đã hoạt động",
      greeting: "Xin chào {recipient}, chứng chỉ SSL cho <strong style=\"color:#fff;\">{host}</strong> đã được cấp thành công. Người chơi truy cập {orgName} qua địa chỉ này sẽ thấy biểu tượng ổ khóa an toàn — bạn có thể công bố URL mới.",
      cta: "Truy cập {host}",
      footer: "Quản lý tên miền của bạn tại {settingsLinkOpen}trang cài đặt câu lạc bộ{settingsLinkClose}.",
    },
    failed: {
      subject: "Thiết lập HTTPS thất bại cho {host} — {orgName}",
      heading: "Thiết lập HTTPS thất bại",
      greeting: "Xin chào {recipient}, chúng tôi không thể cấp chứng chỉ SSL cho <strong style=\"color:#fff;\">{host}</strong>. Nguyên nhân phổ biến nhất là bản ghi DNS chưa trỏ về nền tảng.",
      providerErrorLabel: "Lỗi nhà cung cấp",
      noReason: "Nhà cung cấp chứng chỉ không cung cấp lý do.",
      retry: "Sau khi bạn đã sửa DNS cho {orgName}, hãy mở trang cài đặt câu lạc bộ và nhấn <em>Thử lại</em> để yêu cầu nhà cung cấp lần nữa.",
      cta: "Mở cài đặt câu lạc bộ",
      nextReminder: "Nếu vấn đề chưa được khắc phục, chúng tôi sẽ gửi email lại cho bạn vào {date}.",
      snoozeEnded: "Trước đây bạn đã tạm hoãn các nhắc nhở này đến {date} — thời gian tạm hoãn đã kết thúc, nên chúng tôi nhắc lại cho bạn.",
    },
    tieBreak: {
      headerTag: "Cần phân định",
      subject: "[{orgName}] Cần trận phân định — {tournamentName}",
      heading: "Cần trận phân định vòng tròn",
      greeting: "Xin chào {recipient}, vị trí dẫn đầu trong <strong style=\"color:#fff;\">{tournamentName}</strong> đang hòa. Một trận phân định đã được tự động tạo và đang chờ thi đấu.",
      cta: "Mở trận phân định",
      footer: "Bạn nhận được email này vì bạn được liệt kê là giám đốc giải đấu hoặc quản trị viên tổ chức cho {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "Bạn không muốn nhận những email này? {linkOpen}Tắt biên nhận trò chơi phụ trong tùy chọn liên lạc của bạn{linkClose}. Các email khác của {orgName} không bị ảnh hưởng.",
      heading: "Đã nhận thanh toán",
      greeting: "Xin chào {recipient}, <strong style=\"color:#fff;\">{payer}</strong> vừa thanh toán <strong style=\"color:#fff;\">{gameLabel}</strong> cho bạn.",
      boilerplate: "Đây là biên bản thanh toán trò chơi phụ giữa người chơi. Nếu có gì không chính xác, vui lòng liên hệ trực tiếp với {orgName}.",
      labelSideGame: "Trò chơi phụ",
      labelFrom: "Từ",
      labelAmount: "Số tiền",
      labelCurrency: "Tiền tệ",
      labelMethod: "Phương thức",
      labelReference: "Mã tham chiếu",
      labelPaidAt: "Thanh toán lúc",
      subject: "Bạn đã nhận {currencySymbol}{amount} cho {gameLabel} ({orgName})",
    },
  },

  fil: {
    headerTag: "Pasadyang Domain",
    active: {
      subject: "Aktibo na ang HTTPS para sa {host} — {orgName}",
      heading: "Aktibo na ang HTTPS",
      greeting: "Hi {recipient}, matagumpay na naipalabas ang SSL certificate para sa <strong style=\"color:#fff;\">{host}</strong>. Makakakita ng secure padlock ang mga manlalaro na bumibisita sa {orgName} sa address na ito — pwede mo nang ianunsyo ang bagong URL.",
      cta: "Bisitahin ang {host}",
      footer: "Pamahalaan ang iyong domain sa {settingsLinkOpen}pahina ng mga setting ng club{settingsLinkClose}.",
    },
    failed: {
      subject: "Nabigo ang pag-set up ng HTTPS para sa {host} — {orgName}",
      heading: "Nabigo ang pag-set up ng HTTPS",
      greeting: "Hi {recipient}, hindi kami nakapagbigay ng SSL certificate para sa <strong style=\"color:#fff;\">{host}</strong>. Ang pinakamadalas na dahilan ay isang DNS record na hindi pa nakaturo sa platform.",
      providerErrorLabel: "Error ng provider",
      noReason: "Walang dahilang ibinigay ang provider ng certificate.",
      retry: "Kapag naayos mo na ang DNS para sa {orgName}, buksan ang pahina ng mga setting ng club at pindutin ang <em>Subukan muli</em> para humingi ulit sa provider.",
      cta: "Buksan ang mga setting ng club",
      nextReminder: "Kung hindi pa ito naaayos, mag-eemail kami sa iyo muli sa {date}.",
      snoozeEnded: "Dati mong ipinaliban ang mga paalala na ito hanggang {date} — tapos na ang pagpapaliban, kaya pinapaalala na namin muli sa iyo.",
    },
    tieBreak: {
      headerTag: "Kailangan ng Tie-Break",
      subject: "[{orgName}] Kailangan ng tie-break — {tournamentName}",
      heading: "Kailangan ng round-robin tie-break",
      greeting: "Hi {recipient}, magkapareho ang nasa tuktok ng standings ng <strong style=\"color:#fff;\">{tournamentName}</strong>. Awtomatikong nakagawa ng tie-break match at naghihintay nang malaro.",
      cta: "Buksan ang Tie-Break Match",
      footer: "Natatanggap mo ito dahil nakalista ka bilang tournament director o admin ng organisasyon para sa {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "Ayaw mo bang matanggap ang mga ito? {linkOpen}I-off ang mga resibo sa side-game sa iyong mga communication preferences{linkClose}. Hindi maaapektuhan ang ibang mga email mula sa {orgName}.",
      heading: "Natanggap ang bayad",
      greeting: "Hi {recipient}, kakabayad lang sa iyo ni <strong style=\"color:#fff;\">{payer}</strong> para sa <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "Tala ito ng pagbabayad ng side-game sa pagitan ng mga manlalaro. Kung may mali, mangyaring direktang makipag-ugnayan sa {orgName}.",
      labelSideGame: "Side game",
      labelFrom: "Mula kay",
      labelAmount: "Halaga",
      labelCurrency: "Salapi",
      labelMethod: "Paraan",
      labelReference: "Reperensiya",
      labelPaidAt: "Binayaran noong",
      subject: "Nakatanggap ka ng {currencySymbol}{amount} para sa {gameLabel} ({orgName})",
    },
  },

  sw: {
    headerTag: "Kikoa Maalum",
    active: {
      subject: "HTTPS inafanya kazi kwa {host} — {orgName}",
      heading: "HTTPS sasa inafanya kazi",
      greeting: "Habari {recipient}, cheti cha SSL cha <strong style=\"color:#fff;\">{host}</strong> kimetolewa kwa mafanikio. Wachezaji wanaotembelea {orgName} kwa anwani hii wataona kufuli salama — unaweza kutangaza URL mpya.",
      cta: "Tembelea {host}",
      footer: "Simamia kikoa chako kwenye {settingsLinkOpen}ukurasa wa mipangilio ya klabu{settingsLinkClose}.",
    },
    failed: {
      subject: "Usanidi wa HTTPS umeshindikana kwa {host} — {orgName}",
      heading: "Usanidi wa HTTPS umeshindikana",
      greeting: "Habari {recipient}, hatukuweza kutoa cheti cha SSL kwa <strong style=\"color:#fff;\">{host}</strong>. Sababu ya kawaida ni rekodi ya DNS ambayo bado haijaelekezwa kwenye jukwaa.",
      providerErrorLabel: "Hitilafu ya mtoa huduma",
      noReason: "Mtoa huduma wa cheti hakutoa sababu.",
      retry: "Baada ya kurekebisha DNS ya {orgName}, fungua ukurasa wa mipangilio ya klabu na bonyeza <em>Jaribu tena</em> ili tuombee kwa mtoa huduma tena.",
      cta: "Fungua mipangilio ya klabu",
      nextReminder: "Ikiwa hili halitasahihishwa, tutakutumia barua pepe tena {date}.",
      snoozeEnded: "Ulikuwa umesitisha vikumbusho hivi hadi {date} — kipindi cha kusitisha kimekwisha, kwa hivyo tunakukumbusha tena.",
    },
    tieBreak: {
      headerTag: "Mchezo wa Kuvunja Sare Unahitajika",
      subject: "[{orgName}] Mchezo wa kuvunja sare unahitajika — {tournamentName}",
      heading: "Mchezo wa kuvunja sare wa round-robin unahitajika",
      greeting: "Habari {recipient}, kileleni mwa orodha ya {tournamentName} kuna sare. Mchezo wa kuvunja sare umeandaliwa kiotomatiki na unangoja kuchezwa.",
      cta: "Fungua mchezo wa kuvunja sare",
      footer: "Unapokea hii kwa sababu umeorodheshwa kama mkurugenzi wa mashindano au msimamizi wa shirika kwa {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "Hutaki kupokea hizi? {linkOpen}Zima risiti za michezo ya pembeni katika mapendeleo yako ya mawasiliano{linkClose}. Barua pepe nyingine za {orgName} hazitaathiriwa.",
      heading: "Malipo yamepokelewa",
      greeting: "Habari {recipient}, <strong style=\"color:#fff;\">{payer}</strong> amekulipa hivi punde kwa ajili ya <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "Hii ni rekodi ya malipo ya mchezo wa pembeni kati ya wachezaji. Iwapo kuna jambo lolote lisilo sahihi, tafadhali wasiliana na {orgName} moja kwa moja.",
      labelSideGame: "Mchezo wa pembeni",
      labelFrom: "Kutoka",
      labelAmount: "Kiasi",
      labelCurrency: "Sarafu",
      labelMethod: "Njia",
      labelReference: "Rejea",
      labelPaidAt: "Tarehe ya malipo",
      subject: "Umelipwa {currencySymbol}{amount} kwa ajili ya {gameLabel} ({orgName})",
    },
  },

  af: {
    headerTag: "Pasgemaakte Domein",
    active: {
      subject: "HTTPS is aktief vir {host} — {orgName}",
      heading: "HTTPS is nou aktief",
      greeting: "Hallo {recipient}, die SSL-sertifikaat vir <strong style=\"color:#fff;\">{host}</strong> is suksesvol uitgereik. Spelers wat {orgName} by hierdie adres besoek sal 'n veilige slot sien — jy kan die nuwe URL aankondig.",
      cta: "Besoek {host}",
      footer: "Bestuur jou domein op die {settingsLinkOpen}klubinstellingsbladsy{settingsLinkClose}.",
    },
    failed: {
      subject: "HTTPS-opstelling het misluk vir {host} — {orgName}",
      heading: "HTTPS-opstelling het misluk",
      greeting: "Hallo {recipient}, ons kon nie 'n SSL-sertifikaat vir <strong style=\"color:#fff;\">{host}</strong> uitreik nie. Die mees algemene oorsaak is 'n DNS-rekord wat nog nie na die platform wys nie.",
      providerErrorLabel: "Verskafferfout",
      noReason: "Die sertifikaatverskaffer het geen rede teruggegee nie.",
      retry: "Sodra jy die DNS vir {orgName} reggemaak het, maak die klubinstellingsbladsy oop en druk <em>Probeer weer</em> om die verskaffer weer te vra.",
      cta: "Maak klubinstellings oop",
      nextReminder: "As dit nie reggemaak word nie, sal ons jou weer op {date} 'n e-pos stuur.",
      snoozeEnded: "Jy het hierdie herinneringe tot {date} gepouseer — die pouse is nou verby, dus stuur ons jou weer 'n herinnering.",
    },
    tieBreak: {
      headerTag: "Uitspeelwedstryd Vereis",
      subject: "[{orgName}] Uitspeelwedstryd vereis — {tournamentName}",
      heading: "Round-robin uitspeelwedstryd vereis",
      greeting: "Hallo {recipient}, die boonste plek van die puntelys vir <strong style=\"color:#fff;\">{tournamentName}</strong> is gelyk. 'n Uitspeelwedstryd is outomaties geskep en wag om gespeel te word.",
      cta: "Maak uitspeelwedstryd oop",
      footer: "Jy ontvang hierdie omdat jy as toernooidirekteur of organisasie-administrateur vir {orgName} gelys is.",
    },
    sideGameReceipt: {
      optOutFooter: "Wil jy nie hierdie e-posse hê nie? {linkOpen}Skakel kantspeletjie-kwitansies in jou kommunikasievoorkeure af{linkClose}. Ander {orgName}-e-posse word nie geraak nie.",
      heading: "Betaling ontvang",
      greeting: "Hallo {recipient}, <strong style=\"color:#fff;\">{payer}</strong> het jou pas vir <strong style=\"color:#fff;\">{gameLabel}</strong> betaal.",
      boilerplate: "Dit is 'n rekord van 'n kantspeletjie-vereffening tussen spelers. As iets verkeerd lyk, kontak asseblief {orgName} direk.",
      labelSideGame: "Kantspeletjie",
      labelFrom: "Van",
      labelAmount: "Bedrag",
      labelCurrency: "Geldeenheid",
      labelMethod: "Metode",
      labelReference: "Verwysing",
      labelPaidAt: "Betaal op",
      subject: "Jy is {currencySymbol}{amount} betaal vir {gameLabel} ({orgName})",
    },
  },

  am: {
    headerTag: "ብጁ ጎራ",
    active: {
      subject: "HTTPS ለ{host} ሥራ ላይ ውሏል — {orgName}",
      heading: "HTTPS አሁን ሥራ ላይ ነው",
      greeting: "ሰላም {recipient}፣ ለ<strong style=\"color:#fff;\">{host}</strong> የሚያገለግል SSL ሰርተፊኬት በተሳካ ሁኔታ ተሰጥቷል። በዚህ አድራሻ {orgName}ን የሚጎበኙ ተጫዋቾች ደህንነቱ የተጠበቀ መቆለፊያ ያያሉ — አዲሱን URL መግለጽ ይችላሉ።",
      cta: "{host}ን ጎብኝ",
      footer: "ጎራዎን በ{settingsLinkOpen}የክለብ ቅንብር ገጽ{settingsLinkClose} ያስተዳድሩ።",
    },
    failed: {
      subject: "የHTTPS ማስቀመጥ ለ{host} አልተሳካም — {orgName}",
      heading: "HTTPS ማስቀመጥ አልተሳካም",
      greeting: "ሰላም {recipient}፣ ለ<strong style=\"color:#fff;\">{host}</strong> SSL ሰርተፊኬት መስጠት አልቻልንም። ብዙውን ጊዜ ምክንያቱ DNS መዝገብ ወደ መድረኩ ገና አለመጠቆሙ ነው።",
      providerErrorLabel: "የአቅራቢ ስህተት",
      noReason: "የሰርተፊኬት አቅራቢው ምክንያት አልሰጠም።",
      retry: "የ{orgName} DNSን ካስተካከሉ በኋላ የክለብ ቅንብር ገጹን ይክፈቱና ለአቅራቢው እንደገና እንዲጠይቅ <em>እንደገና ሞክር</em>ን ይጫኑ።",
      cta: "የክለብ ቅንብርን ክፈት",
      nextReminder: "ይህ ካልተስተካከለ፣ {date} እንደገና ኢሜይል እንልክልዎታለን።",
      snoozeEnded: "እነዚህን ማስታወሻዎች እስከ {date} ድረስ አዘግይተዋቸው ነበር — የማዘግየት ጊዜው አሁን አብቅቷል፣ ስለዚህ እንደገና እያስታወስንዎት ነው።",
    },
    tieBreak: {
      headerTag: "የእኩልነት ማቋረጥ ያስፈልጋል",
      subject: "[{orgName}] የእኩልነት ማቋረጥ ያስፈልጋል — {tournamentName}",
      heading: "የራውንድ-ሮቢን የእኩልነት ማቋረጥ ያስፈልጋል",
      greeting: "ሰላም {recipient}፣ የ<strong style=\"color:#fff;\">{tournamentName}</strong> የደረጃ ሰንጠረዥ የላይኛው ቦታ እኩል ነው። የእኩልነት ማቋረጥ ግጥሚያ በራስ ሰር ተፈጥሯል እና ለመጫወት እየጠበቀ ነው።",
      cta: "የእኩልነት ማቋረጥ ግጥሚያን ክፈት",
      footer: "ይህንን የተቀበሉት ለ{orgName} እንደ ውድድር ዳይሬክተር ወይም የድርጅት አስተዳዳሪ ስለተዘረዘሩ ነው።",
    },
    sideGameReceipt: {
      optOutFooter: "እነዚህን አይፈልጉም? {linkOpen}በመገናኛ ምርጫዎችዎ ውስጥ የጎንዮሽ ጨዋታ ደረሰኞችን ያጥፉ{linkClose}። ሌሎች የ{orgName} ኢሜይሎች አይነኩም።",
      heading: "ክፍያ ተቀብሏል",
      greeting: "ሰላም {recipient}፣ <strong style=\"color:#fff;\">{payer}</strong> ለ<strong style=\"color:#fff;\">{gameLabel}</strong> አሁን ከፍሎዎታል።",
      boilerplate: "ይህ በተጫዋቾች መካከል የጎንዮሽ ጨዋታ ክፍያ መዝገብ ነው። ስህተት ካለ፣ እባክዎ በቀጥታ {orgName}ን ያግኙ።",
      labelSideGame: "የጎንዮሽ ጨዋታ",
      labelFrom: "ላኪ",
      labelAmount: "መጠን",
      labelCurrency: "ምንዛሪ",
      labelMethod: "የክፍያ ዘዴ",
      labelReference: "ማጣቀሻ",
      labelPaidAt: "የተከፈለበት ጊዜ",
      subject: "ለ{gameLabel} {currencySymbol}{amount} ተከፍሎዎታል ({orgName})",
    },
  },

  ha: {
    headerTag: "Yanki na Musamman",
    active: {
      subject: "HTTPS yana aiki don {host} — {orgName}",
      heading: "HTTPS yana aiki yanzu",
      greeting: "Sannu {recipient}, an ba da takardar shaidar SSL don <strong style=\"color:#fff;\">{host}</strong> cikin nasara. 'Yan wasa da suka ziyarci {orgName} a wannan adireshi za su ga alamar makulli mai aminci — za ka iya sanar da sabon URL.",
      cta: "Ziyarci {host}",
      footer: "Sarrafa yankinka a {settingsLinkOpen}shafin saitin kungiyar{settingsLinkClose}.",
    },
    failed: {
      subject: "Saita HTTPS ya gaza don {host} — {orgName}",
      heading: "Saita HTTPS ya gaza",
      greeting: "Sannu {recipient}, ba mu iya bayar da takardar shaidar SSL don <strong style=\"color:#fff;\">{host}</strong> ba. Mafi yawan dalili shi ne rikodin DNS bai nuni zuwa dandalin ba tukuna.",
      providerErrorLabel: "Kuskuren mai bayarwa",
      noReason: "Mai bayar da takardar shaida bai bayar da dalili ba.",
      retry: "Bayan ka gyara DNS na {orgName}, buɗe shafin saitin kungiyar sannan danna <em>Sake gwadawa</em> don sake nema daga mai bayarwa.",
      cta: "Buɗe saitin kungiyar",
      nextReminder: "Idan ba a gyara wannan ba, za mu sake aiko maka da imel a ranar {date}.",
      snoozeEnded: "Ka jinkirta wadannan tunatarwa har zuwa {date} — lokacin jinkirin ya kare, don haka muna sake tunatar da kai.",
    },
    tieBreak: {
      headerTag: "Ana Buƙatar Tie-Break",
      subject: "[{orgName}] Ana buƙatar tie-break — {tournamentName}",
      heading: "Ana buƙatar tie-break na round-robin",
      greeting: "Sannu {recipient}, matsayin gaba a <strong style=\"color:#fff;\">{tournamentName}</strong> sun zama daidai. An riga an ƙirƙira wasan tie-break ta atomatik kuma yana jiran a buga.",
      cta: "Buɗe wasan tie-break",
      footer: "Kana karɓar wannan saboda an jera ka a matsayin daraktan gasa ko mai gudanar da ƙungiya na {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "Ba ka son waɗannan? {linkOpen}Kashe rasidodin wasannin gefe a cikin abubuwan da kake so na sadarwa{linkClose}. Sauran imel na {orgName} ba za a shafa su ba.",
      heading: "An karɓi biya",
      greeting: "Sannu {recipient}, <strong style=\"color:#fff;\">{payer}</strong> ya biya ka yanzu don <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "Wannan rikodin biyan wasan gefe ne tsakanin 'yan wasa. Idan akwai abin da bai dace ba, da fatan za a tuntuɓi {orgName} kai tsaye.",
      labelSideGame: "Wasan gefe",
      labelFrom: "Daga",
      labelAmount: "Adadi",
      labelCurrency: "Kuɗi",
      labelMethod: "Hanya",
      labelReference: "Lambar tunani",
      labelPaidAt: "Ranar biya",
      subject: "An biya ka {currencySymbol}{amount} don {gameLabel} ({orgName})",
    },
  },

  zu: {
    headerTag: "Idomeyini Eyenziwe Ngokwezifiso",
    active: {
      subject: "I-HTTPS isebenza ku-{host} — {orgName}",
      heading: "I-HTTPS isiyasebenza",
      greeting: "Sawubona {recipient}, isitifiketi se-SSL se-<strong style=\"color:#fff;\">{host}</strong> sikhishwe ngempumelelo. Abadlali abavakashela i-{orgName} kuleli kheli bazobona uphawu lwekhiya oluphephile — usungaqala ukumemezela i-URL entsha.",
      cta: "Vakashela i-{host}",
      footer: "Phatha idomeyini yakho {settingsLinkOpen}ekhasini lezilungiselelo zekilabhu{settingsLinkClose}.",
    },
    failed: {
      subject: "Ukulungiselela i-HTTPS kuhlulekile ku-{host} — {orgName}",
      heading: "Ukulungiselela i-HTTPS kuhlulekile",
      greeting: "Sawubona {recipient}, asikwazanga ukukhipha isitifiketi se-SSL se-<strong style=\"color:#fff;\">{host}</strong>. Imbangela ejwayelekile yirekhodi le-DNS elingakakhombisi enkundleni.",
      providerErrorLabel: "Iphutha lomhlinzeki",
      noReason: "Umhlinzeki wesitifiketi akanikezanga isizathu.",
      retry: "Uma usulungise i-DNS ye-{orgName}, vula ikhasi lezilungiselelo zekilabhu bese ucindezela u-<em>Zama futhi</em> ukucela kabusha kumhlinzeki.",
      cta: "Vula izilungiselelo zekilabhu",
      nextReminder: "Uma lokhu kungalungiswa, sizokuthumelela i-imeyili futhi ngomhla ka-{date}.",
      snoozeEnded: "Wawumise lezi zikhumbuzo kuze kube ngu-{date} — lesi sikhathi sokumiswa sesiphelile, ngakho-ke sikukhumbuza futhi.",
    },
    tieBreak: {
      headerTag: "Kudingeka Ukunqamula Ukulingana",
      subject: "[{orgName}] Kudingeka ukunqamula ukulingana — {tournamentName}",
      heading: "Kudingeka umdlalo wokunqamula ukulingana we-round-robin",
      greeting: "Sawubona {recipient}, isikhundla esiphezulu se-<strong style=\"color:#fff;\">{tournamentName}</strong> silingana. Umdlalo wokunqamula ukulingana udalwe ngokuzenzakalelayo futhi ulinde ukudlalwa.",
      cta: "Vula umdlalo wokunqamula ukulingana",
      footer: "Uthola lokhu ngoba ufakwe ohlwini njengomqondisi womqhudelwano noma umqondisi wenhlangano ye-{orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "Awufuni ukuthola lokhu? {linkOpen}Vala izincwadi zokukhokha zemidlalo eseceleni ezilungiselelweni zakho zokuxhumana{linkClose}. Amanye ama-imeyili e-{orgName} ngeke athinteke.",
      heading: "Inkokhelo itholakele",
      greeting: "Sawubona {recipient}, u-<strong style=\"color:#fff;\">{payer}</strong> usanda kukukhokhela i-<strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "Lokhu kuyirekhodi yokukhokhelwa komdlalo oseceleni phakathi kwabadlali. Uma kukhona okungalungile, sicela uxhumane no-{orgName} ngqo.",
      labelSideGame: "Umdlalo oseceleni",
      labelFrom: "Othumele",
      labelAmount: "Inani",
      labelCurrency: "Imali",
      labelMethod: "Indlela",
      labelReference: "Inkomba",
      labelPaidAt: "Ikhokhwe ngo",
      subject: "Ukhokhelwe {currencySymbol}{amount} nge-{gameLabel} ({orgName})",
    },
  },

  yo: {
    headerTag: "Agbègbè Aṣàṣàdéọ̀tọ̀",
    active: {
      subject: "HTTPS ti ń ṣiṣẹ́ fún {host} — {orgName}",
      heading: "HTTPS ti ń ṣiṣẹ́ báyìí",
      greeting: "Pẹ̀lẹ́ {recipient}, a ti gbé ìwé ẹ̀rí SSL fún <strong style=\"color:#fff;\">{host}</strong> jáde lófo. Àwọn olùṣe ere tó bá ṣe ìbẹ̀wò sí {orgName} ní àdírẹ́sì yìí yóò rí àmì kọ́kọ́rọ́ tó ní ààbò — o lè kéde URL tuntun náà.",
      cta: "Bẹ̀wò {host}",
      footer: "Bójútó agbègbè rẹ ní {settingsLinkOpen}ojú-ìwé ètò ẹgbẹ́{settingsLinkClose}.",
    },
    failed: {
      subject: "Ìṣètò HTTPS kùnà fún {host} — {orgName}",
      heading: "Ìṣètò HTTPS kùnà",
      greeting: "Pẹ̀lẹ́ {recipient}, a kò lè gbé ìwé ẹ̀rí SSL jáde fún <strong style=\"color:#fff;\">{host}</strong>. Ìdí tó wọ́pọ̀ jùlọ ni pé àkọsílẹ̀ DNS kò tíì tọ́ka sí ìpèsè náà.",
      providerErrorLabel: "Àṣìṣe láti ọ̀dọ̀ olùpèsè",
      noReason: "Olùpèsè ìwé ẹ̀rí kò pèsè ìdí kankan.",
      retry: "Lẹ́yìn tí o bá ṣàtúnṣe DNS fún {orgName}, ṣí ojú-ìwé ètò ẹgbẹ́ kí o sì tẹ <em>Gbìyànjú lẹ́ẹ̀kan sí i</em> kí à tún béèrè lọ́dọ̀ olùpèsè.",
      cta: "Ṣí ètò ẹgbẹ́",
      nextReminder: "Tí a kò bá ṣàtúnṣe èyí, a óò tún fi ìmẹ́lì ránṣẹ́ sí ọ ní {date}.",
      snoozeEnded: "O ti dáwọ́ àwọn ìránnilétí wọ̀nyí dúró títí di {date} — àkókò ìdúró ti parí, nítorí náà a tún ń ránnilétí ọ.",
    },
    tieBreak: {
      headerTag: "Ìjà Ìpinnu A Nílò",
      subject: "[{orgName}] Ìjà ìpinnu a nílò — {tournamentName}",
      heading: "Ìjà ìpinnu round-robin a nílò",
      greeting: "Pẹ̀lẹ́ {recipient}, ipo òkè ní àkójọ ìpò ti <strong style=\"color:#fff;\">{tournamentName}</strong> dọ́gba. A ti ṣẹ̀dá ìjà ìpinnu lọ́nà aládàáṣiṣẹ́, ó sì ń dúró láti ṣe é.",
      cta: "Ṣí Ìjà Ìpinnu",
      footer: "O ń gba ìfìranṣẹ́ yìí nítorí pé a ti ṣàkójọ rẹ gẹ́gẹ́ bí olùdarí ìdíje tàbí alábojútó àjọ fún {orgName}.",
    },
    sideGameReceipt: {
      optOutFooter: "O kò fẹ́ wọ̀nyí? {linkOpen}Pa àwọn ìwé ẹ̀rí ere-ẹ̀gbẹ́ kúrò ní àwọn ìfẹ́-ọkàn ìbáradọ́rọ̀ rẹ{linkClose}. Àwọn ímẹ́lì míràn láti ọ̀dọ̀ {orgName} kò ní kàn án.",
      heading: "A ti gba ìsanwó",
      greeting: "Pẹ̀lẹ́ {recipient}, <strong style=\"color:#fff;\">{payer}</strong> ṣẹ̀ṣẹ̀ san owó fún ọ fún <strong style=\"color:#fff;\">{gameLabel}</strong>.",
      boilerplate: "Èyí jẹ́ àkọsílẹ̀ ìsanwó ere-ẹ̀gbẹ́ láàárín àwọn olùṣe ere. Bí ohun kan kò bá tọ́, jọ̀wọ́ kàn sí {orgName} tààrà.",
      labelSideGame: "Ere-ẹ̀gbẹ́",
      labelFrom: "Láti ọ̀dọ̀",
      labelAmount: "Iye",
      labelCurrency: "Owó",
      labelMethod: "Ọ̀nà",
      labelReference: "Ìtọ́kasí",
      labelPaidAt: "Ìsanwó ní",
      subject: "A san {currencySymbol}{amount} fún ọ fún {gameLabel} ({orgName})",
    },
  },
};

export function isSupportedCustomDomainEmailLang(
  lang: string | null | undefined,
): lang is CustomDomainEmailLang {
  return !!lang && (CUSTOM_DOMAIN_EMAIL_LANGS as string[]).includes(lang);
}

export function getCustomDomainEmailStrings(
  lang: string | null | undefined,
): CustomDomainEmailStrings {
  const code = isSupportedCustomDomainEmailLang(lang) ? lang : "en";
  return PACKS[code];
}

export function fmtTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : ""));
}
