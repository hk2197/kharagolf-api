/**
 * Translations for the four non-export `DataRequestEmailKind` arms
 * dispatched by `sendDataRequestEmail` in `mailer.ts`:
 *
 *   - `filed`       — "We've received your privacy request" acknowledgement
 *   - `in_progress` — "Your privacy request is being processed" update
 *   - `completed`   — "Your privacy request is complete" notice (non-export)
 *   - `rejected`    — "Update on your privacy request" rejection notice
 *
 * Task #1745 localised only the two data-export-related notices
 * (`completed_export` ready email, `export_expiring` 24h-before
 * reminder) — the four kinds above kept rendering in English regardless
 * of the recipient's `preferredLanguage`. Task #2167 closes that gap by
 * translating the subject + body for every code in the
 * `supported_language` enum, mirroring the per-language pattern of
 * `dataExportEmailI18n.ts`.
 *
 * The shared per-language shell (header tag, metadata-table labels,
 * footer note, "Data export (portability)" type label, htmlLang/dir)
 * is reused via {@link getDataRequestEmailShell} in
 * `dataExportEmailI18n.ts` so a one-line change to the labels (e.g.
 * "Reference" → "Ref.") only has to be made in one place. The lang
 * resolution + locale-aware date formatting helpers
 * ({@link resolveDataExportEmailLang} /
 * {@link formatDataExportEmailDate}) are also reused from the export
 * module — every data-protection email therefore agrees on what
 * language a given preferredLanguage code means.
 *
 * The recipient's preferred language is already plumbed end-to-end
 * through `dataRequestNotify.ts` (initial send + retry path) and
 * `sendDataRequestEmail({ lang })` — Task #2167 only needs to wire
 * the four switch arms in `mailer.ts` to this module.
 */

import {
  type DataRequestEmailShell,
  formatDataRequestEmailString,
  getDataRequestEmailShell,
  resolveDataExportEmailLang,
  type DataExportEmailLang,
} from "./dataExportEmailI18n";

export type DataRequestEmailNonExportKind =
  | "filed"
  | "in_progress"
  | "completed"
  | "rejected";

/**
 * Per-kind copy. Every language pack provides one of these per kind.
 *
 * Templates may carry the placeholders `{name}`, `{orgName}`, `{ref}`
 * (always interpolated) and — only for `filed.bodyDueBy` and
 * `inProgress.bodyDueBy` — `{dueByStr}`, which the consumer wraps in
 * `<strong>…</strong>` markup before passing the final value into the
 * substitution. The consumer is responsible for HTML-escaping any
 * user-controlled values (member name, org name, notes) before passing
 * them in — the i18n module does no escaping itself.
 */
interface FiledKindCopy {
  /** Subject line. Placeholders: `{orgName}`, `{ref}`. */
  subject: string;
  /** `<h2>` heading (no placeholders). */
  heading: string;
  /** Greeting + intro paragraph. Placeholder: `{name}`. */
  intro: string;
  /**
   * "We will respond by … (within 30 days)" body sentence. The
   * `{dueByStr}` placeholder is replaced by the consumer with the
   * already-bolded due-date label so the rendered email matches the
   * pre-i18n English template's visual styling.
   */
  bodyDueBy: string;
  /** "We will respond within 30 days." body sentence (no due date). */
  bodyNoDueBy: string;
}

interface InProgressKindCopy {
  /** Subject line. Placeholder: `{ref}`. */
  subject: string;
  /** `<h2>` heading. */
  heading: string;
  /** Greeting + intro. Placeholder: `{name}`. */
  intro: string;
  /** "We still aim to complete it by …" sentence. Placeholder: `{dueByStr}` (consumer-bolded). */
  bodyDueBy: string;
}

interface CompletedKindCopy {
  /** Subject line. Placeholder: `{ref}`. */
  subject: string;
  /** `<h2>` heading. */
  heading: string;
  /** Greeting + intro. Placeholder: `{name}`. */
  intro: string;
  /** Lead sentence above the "Download materials" CTA when an artifact URL is present. */
  bodyWithLinkLead: string;
  /** Text rendered inside the green CTA button. */
  bodyButtonLabel: string;
}

interface RejectedKindCopy {
  /** Subject line. Placeholder: `{ref}`. */
  subject: string;
  /** `<h2>` heading. */
  heading: string;
  /** Greeting + intro. Placeholder: `{name}`. */
  intro: string;
  /** Bold "Reason from our team:" label rendered above the operator-supplied notes block. */
  bodyReasonLabel: string;
  /** Body sentence rendered when no operator notes were supplied. */
  bodyAppealHint: string;
}

interface KindPack {
  filed: FiledKindCopy;
  inProgress: InProgressKindCopy;
  completed: CompletedKindCopy;
  rejected: RejectedKindCopy;
}

const PACKS: Record<DataExportEmailLang, KindPack> = {
  en: {
    filed: {
      subject: "Privacy request received — {orgName} (#{ref})",
      heading: "We've received your privacy request",
      intro: "Thank you, {name}. We have received your data-protection request and it has been logged in our records.",
      bodyDueBy: "In line with applicable data-protection regulations (GDPR / DPDP), we will respond to your request {dueByStr} (within 30 days).",
      bodyNoDueBy: "In line with applicable data-protection regulations (GDPR / DPDP), we will respond to your request within 30 days.",
    },
    inProgress: {
      subject: "Privacy request update — in progress (#{ref})",
      heading: "Your privacy request is being processed",
      intro: "Hi {name}, our team has begun working on your data-protection request.",
      bodyDueBy: "We still aim to complete it by {dueByStr}. You'll receive another email once it has been resolved.",
    },
    completed: {
      subject: "Privacy request completed (#{ref})",
      heading: "Your privacy request is complete",
      intro: "Hi {name}, your data-protection request has been resolved.",
      bodyWithLinkLead: "You can download the materials related to your request using the secure link below:",
      bodyButtonLabel: "Download materials",
    },
    rejected: {
      subject: "Privacy request — outcome (#{ref})",
      heading: "Update on your privacy request",
      intro: "Hi {name}, after review we are unable to fulfil your data-protection request as submitted.",
      bodyReasonLabel: "Reason from our team:",
      bodyAppealHint: "Please reply to this email or contact your club administrator if you would like to discuss the decision or appeal it.",
    },
  },

  hi: {
    filed: {
      subject: "गोपनीयता अनुरोध प्राप्त हुआ — {orgName} (#{ref})",
      heading: "हमें आपका गोपनीयता अनुरोध मिल गया है",
      intro: "धन्यवाद, {name}। हमें आपका डेटा-सुरक्षा अनुरोध प्राप्त हुआ है और इसे हमारे रिकॉर्ड में दर्ज कर लिया गया है।",
      bodyDueBy: "लागू डेटा-सुरक्षा नियमों (GDPR / DPDP) के अनुसार, हम आपके अनुरोध का उत्तर {dueByStr} तक (30 दिनों के भीतर) देंगे।",
      bodyNoDueBy: "लागू डेटा-सुरक्षा नियमों (GDPR / DPDP) के अनुसार, हम आपके अनुरोध का उत्तर 30 दिनों के भीतर देंगे।",
    },
    inProgress: {
      subject: "गोपनीयता अनुरोध अपडेट — प्रगति पर है (#{ref})",
      heading: "आपका गोपनीयता अनुरोध संसाधित किया जा रहा है",
      intro: "नमस्ते {name}, हमारी टीम ने आपके डेटा-सुरक्षा अनुरोध पर काम शुरू कर दिया है।",
      bodyDueBy: "हमारा लक्ष्य अब भी इसे {dueByStr} तक पूरा करना है। हल होने के बाद आपको एक और ईमेल प्राप्त होगा।",
    },
    completed: {
      subject: "गोपनीयता अनुरोध पूरा हुआ (#{ref})",
      heading: "आपका गोपनीयता अनुरोध पूरा हो गया है",
      intro: "नमस्ते {name}, आपका डेटा-सुरक्षा अनुरोध हल कर दिया गया है।",
      bodyWithLinkLead: "आप नीचे दिए गए सुरक्षित लिंक से अपने अनुरोध से संबंधित सामग्री डाउनलोड कर सकते हैं:",
      bodyButtonLabel: "सामग्री डाउनलोड करें",
    },
    rejected: {
      subject: "गोपनीयता अनुरोध — परिणाम (#{ref})",
      heading: "आपके गोपनीयता अनुरोध पर अपडेट",
      intro: "नमस्ते {name}, समीक्षा के बाद हम आपके डेटा-सुरक्षा अनुरोध को प्रस्तुत रूप में पूरा करने में असमर्थ हैं।",
      bodyReasonLabel: "हमारी टीम का कारण:",
      bodyAppealHint: "यदि आप इस निर्णय पर चर्चा करना या अपील करना चाहें, तो इस ईमेल का उत्तर दें या अपने क्लब व्यवस्थापक से संपर्क करें।",
    },
  },

  ar: {
    filed: {
      subject: "تم استلام طلب الخصوصية — {orgName} (#{ref})",
      heading: "لقد استلمنا طلب الخصوصية الخاص بك",
      intro: "شكراً لك يا {name}. لقد استلمنا طلب حماية البيانات الخاص بك وتم تسجيله في سجلاتنا.",
      bodyDueBy: "وفقاً للوائح حماية البيانات المعمول بها (GDPR / DPDP)، سنرد على طلبك {dueByStr} (خلال 30 يوماً).",
      bodyNoDueBy: "وفقاً للوائح حماية البيانات المعمول بها (GDPR / DPDP)، سنرد على طلبك خلال 30 يوماً.",
    },
    inProgress: {
      subject: "تحديث طلب الخصوصية — قيد التنفيذ (#{ref})",
      heading: "طلب الخصوصية الخاص بك قيد المعالجة",
      intro: "مرحباً {name}، بدأ فريقنا العمل على طلب حماية البيانات الخاص بك.",
      bodyDueBy: "ما زلنا نهدف إلى إتمامه بحلول {dueByStr}. ستتلقى بريداً إلكترونياً آخر بمجرد حله.",
    },
    completed: {
      subject: "اكتمل طلب الخصوصية (#{ref})",
      heading: "اكتمل طلب الخصوصية الخاص بك",
      intro: "مرحباً {name}، تم حل طلب حماية البيانات الخاص بك.",
      bodyWithLinkLead: "يمكنك تنزيل المواد المتعلقة بطلبك عبر الرابط الآمن أدناه:",
      bodyButtonLabel: "تنزيل المواد",
    },
    rejected: {
      subject: "طلب الخصوصية — النتيجة (#{ref})",
      heading: "تحديث بشأن طلب الخصوصية الخاص بك",
      intro: "مرحباً {name}، بعد المراجعة لا يمكننا تلبية طلب حماية البيانات الخاص بك بالصيغة المقدمة.",
      bodyReasonLabel: "السبب من فريقنا:",
      bodyAppealHint: "إذا كنت ترغب في مناقشة القرار أو الطعن فيه، فيرجى الرد على هذا البريد الإلكتروني أو التواصل مع مسؤول النادي الخاص بك.",
    },
  },

  es: {
    filed: {
      subject: "Solicitud de privacidad recibida — {orgName} (#{ref})",
      heading: "Hemos recibido tu solicitud de privacidad",
      intro: "Gracias, {name}. Hemos recibido tu solicitud de protección de datos y la hemos registrado.",
      bodyDueBy: "De conformidad con la normativa aplicable de protección de datos (GDPR / DPDP), responderemos a tu solicitud {dueByStr} (en un plazo de 30 días).",
      bodyNoDueBy: "De conformidad con la normativa aplicable de protección de datos (GDPR / DPDP), responderemos a tu solicitud en un plazo de 30 días.",
    },
    inProgress: {
      subject: "Actualización de la solicitud de privacidad — en curso (#{ref})",
      heading: "Tu solicitud de privacidad se está procesando",
      intro: "Hola {name}, nuestro equipo ha comenzado a trabajar en tu solicitud de protección de datos.",
      bodyDueBy: "Seguimos con el objetivo de completarla antes del {dueByStr}. Recibirás otro correo electrónico cuando se haya resuelto.",
    },
    completed: {
      subject: "Solicitud de privacidad completada (#{ref})",
      heading: "Tu solicitud de privacidad está completa",
      intro: "Hola {name}, tu solicitud de protección de datos ha sido resuelta.",
      bodyWithLinkLead: "Puedes descargar los materiales relacionados con tu solicitud mediante el enlace seguro a continuación:",
      bodyButtonLabel: "Descargar materiales",
    },
    rejected: {
      subject: "Solicitud de privacidad — resultado (#{ref})",
      heading: "Actualización sobre tu solicitud de privacidad",
      intro: "Hola {name}, tras la revisión no podemos atender tu solicitud de protección de datos tal como se presentó.",
      bodyReasonLabel: "Motivo de nuestro equipo:",
      bodyAppealHint: "Responde a este correo o contacta con el administrador de tu club si deseas discutir la decisión o presentar una apelación.",
    },
  },

  fr: {
    filed: {
      subject: "Demande de confidentialité reçue — {orgName} (#{ref})",
      heading: "Nous avons reçu votre demande de confidentialité",
      intro: "Merci, {name}. Nous avons reçu votre demande de protection des données et l'avons enregistrée dans nos dossiers.",
      bodyDueBy: "Conformément aux réglementations applicables en matière de protection des données (RGPD / DPDP), nous répondrons à votre demande {dueByStr} (sous 30 jours).",
      bodyNoDueBy: "Conformément aux réglementations applicables en matière de protection des données (RGPD / DPDP), nous répondrons à votre demande sous 30 jours.",
    },
    inProgress: {
      subject: "Mise à jour de la demande de confidentialité — en cours (#{ref})",
      heading: "Votre demande de confidentialité est en cours de traitement",
      intro: "Bonjour {name}, notre équipe a commencé à travailler sur votre demande de protection des données.",
      bodyDueBy: "Nous visons toujours à la finaliser d'ici le {dueByStr}. Vous recevrez un autre e-mail dès qu'elle sera résolue.",
    },
    completed: {
      subject: "Demande de confidentialité terminée (#{ref})",
      heading: "Votre demande de confidentialité est terminée",
      intro: "Bonjour {name}, votre demande de protection des données a été résolue.",
      bodyWithLinkLead: "Vous pouvez télécharger les documents liés à votre demande en utilisant le lien sécurisé ci-dessous :",
      bodyButtonLabel: "Télécharger les documents",
    },
    rejected: {
      subject: "Demande de confidentialité — résultat (#{ref})",
      heading: "Mise à jour sur votre demande de confidentialité",
      intro: "Bonjour {name}, après examen, nous ne pouvons pas donner suite à votre demande de protection des données telle qu'elle a été soumise.",
      bodyReasonLabel: "Motif de notre équipe :",
      bodyAppealHint: "Répondez à cet e-mail ou contactez l'administrateur de votre club si vous souhaitez discuter de la décision ou faire appel.",
    },
  },

  de: {
    filed: {
      subject: "Datenschutzanfrage eingegangen — {orgName} (#{ref})",
      heading: "Wir haben Ihre Datenschutzanfrage erhalten",
      intro: "Danke, {name}. Wir haben Ihre Datenschutzanfrage erhalten und in unseren Unterlagen registriert.",
      bodyDueBy: "Gemäß den geltenden Datenschutzbestimmungen (DSGVO / DPDP) werden wir Ihre Anfrage {dueByStr} (innerhalb von 30 Tagen) beantworten.",
      bodyNoDueBy: "Gemäß den geltenden Datenschutzbestimmungen (DSGVO / DPDP) werden wir Ihre Anfrage innerhalb von 30 Tagen beantworten.",
    },
    inProgress: {
      subject: "Datenschutzanfrage – Update — in Bearbeitung (#{ref})",
      heading: "Ihre Datenschutzanfrage wird bearbeitet",
      intro: "Hallo {name}, unser Team hat mit der Bearbeitung Ihrer Datenschutzanfrage begonnen.",
      bodyDueBy: "Wir streben weiterhin an, sie bis zum {dueByStr} abzuschließen. Sie erhalten eine weitere E-Mail, sobald sie erledigt ist.",
    },
    completed: {
      subject: "Datenschutzanfrage abgeschlossen (#{ref})",
      heading: "Ihre Datenschutzanfrage ist abgeschlossen",
      intro: "Hallo {name}, Ihre Datenschutzanfrage wurde bearbeitet.",
      bodyWithLinkLead: "Sie können die zu Ihrer Anfrage gehörigen Materialien über den sicheren Link unten herunterladen:",
      bodyButtonLabel: "Materialien herunterladen",
    },
    rejected: {
      subject: "Datenschutzanfrage – Ergebnis (#{ref})",
      heading: "Update zu Ihrer Datenschutzanfrage",
      intro: "Hallo {name}, nach Prüfung können wir Ihre Datenschutzanfrage in der eingereichten Form nicht erfüllen.",
      bodyReasonLabel: "Begründung unseres Teams:",
      bodyAppealHint: "Antworten Sie auf diese E-Mail oder wenden Sie sich an Ihren Clubadministrator, wenn Sie die Entscheidung besprechen oder Einspruch erheben möchten.",
    },
  },

  pt: {
    filed: {
      subject: "Pedido de privacidade recebido — {orgName} (#{ref})",
      heading: "Recebemos o seu pedido de privacidade",
      intro: "Obrigado, {name}. Recebemos o seu pedido de proteção de dados e ele foi registado nos nossos arquivos.",
      bodyDueBy: "De acordo com a regulamentação aplicável de proteção de dados (RGPD / DPDP), responderemos ao seu pedido {dueByStr} (no prazo de 30 dias).",
      bodyNoDueBy: "De acordo com a regulamentação aplicável de proteção de dados (RGPD / DPDP), responderemos ao seu pedido no prazo de 30 dias.",
    },
    inProgress: {
      subject: "Atualização do pedido de privacidade — em curso (#{ref})",
      heading: "O seu pedido de privacidade está a ser processado",
      intro: "Olá {name}, a nossa equipa começou a tratar do seu pedido de proteção de dados.",
      bodyDueBy: "Continuamos com o objetivo de o concluir até {dueByStr}. Receberá outro e-mail assim que estiver resolvido.",
    },
    completed: {
      subject: "Pedido de privacidade concluído (#{ref})",
      heading: "O seu pedido de privacidade está concluído",
      intro: "Olá {name}, o seu pedido de proteção de dados foi resolvido.",
      bodyWithLinkLead: "Pode descarregar os materiais relacionados com o seu pedido através do link seguro abaixo:",
      bodyButtonLabel: "Descarregar materiais",
    },
    rejected: {
      subject: "Pedido de privacidade — resultado (#{ref})",
      heading: "Atualização sobre o seu pedido de privacidade",
      intro: "Olá {name}, após análise não podemos satisfazer o seu pedido de proteção de dados conforme apresentado.",
      bodyReasonLabel: "Motivo da nossa equipa:",
      bodyAppealHint: "Responda a este e-mail ou contacte o administrador do seu clube se quiser discutir a decisão ou apresentar recurso.",
    },
  },

  ja: {
    filed: {
      subject: "プライバシーリクエストを受領しました — {orgName} (#{ref})",
      heading: "プライバシーリクエストを受領しました",
      intro: "{name}様、ありがとうございます。データ保護に関するリクエストを受領し、記録に登録いたしました。",
      bodyDueBy: "適用されるデータ保護規制(GDPR / DPDP)に従い、{dueByStr}まで(30日以内)にリクエストにご回答いたします。",
      bodyNoDueBy: "適用されるデータ保護規制(GDPR / DPDP)に従い、30日以内にリクエストにご回答いたします。",
    },
    inProgress: {
      subject: "プライバシーリクエストの更新 — 処理中 (#{ref})",
      heading: "プライバシーリクエストを処理中です",
      intro: "{name}様、当チームがデータ保護リクエストの対応を開始しました。",
      bodyDueBy: "引き続き{dueByStr}までの完了を目指しています。解決次第、改めてメールをお送りします。",
    },
    completed: {
      subject: "プライバシーリクエストが完了しました (#{ref})",
      heading: "プライバシーリクエストが完了しました",
      intro: "{name}様、データ保護リクエストの対応が完了いたしました。",
      bodyWithLinkLead: "下記の安全なリンクから、リクエストに関連する資料をダウンロードできます:",
      bodyButtonLabel: "資料をダウンロード",
    },
    rejected: {
      subject: "プライバシーリクエスト — 結果 (#{ref})",
      heading: "プライバシーリクエストに関するご連絡",
      intro: "{name}様、審査の結果、ご提出いただいた形でのデータ保護リクエストには対応いたしかねます。",
      bodyReasonLabel: "当チームからの理由:",
      bodyAppealHint: "決定について話し合いまたは異議を申し立てたい場合は、このメールに返信するか、クラブ管理者にお問い合わせください。",
    },
  },

  ko: {
    filed: {
      subject: "개인정보 요청이 접수되었습니다 — {orgName} (#{ref})",
      heading: "개인정보 요청을 접수했습니다",
      intro: "{name}님, 감사합니다. 데이터 보호 요청을 접수하여 기록에 등록했습니다.",
      bodyDueBy: "관련 데이터 보호 규정(GDPR / DPDP)에 따라 {dueByStr}까지(30일 이내) 요청에 회신드리겠습니다.",
      bodyNoDueBy: "관련 데이터 보호 규정(GDPR / DPDP)에 따라 30일 이내에 요청에 회신드리겠습니다.",
    },
    inProgress: {
      subject: "개인정보 요청 업데이트 — 처리 중 (#{ref})",
      heading: "개인정보 요청이 처리되고 있습니다",
      intro: "{name}님, 저희 팀이 데이터 보호 요청 처리를 시작했습니다.",
      bodyDueBy: "계속해서 {dueByStr}까지 완료하는 것을 목표로 하고 있습니다. 해결되면 다시 이메일을 보내드립니다.",
    },
    completed: {
      subject: "개인정보 요청이 완료되었습니다 (#{ref})",
      heading: "개인정보 요청이 완료되었습니다",
      intro: "{name}님, 데이터 보호 요청이 처리되었습니다.",
      bodyWithLinkLead: "아래의 안전한 링크를 사용하여 요청 관련 자료를 다운로드할 수 있습니다:",
      bodyButtonLabel: "자료 다운로드",
    },
    rejected: {
      subject: "개인정보 요청 — 결과 (#{ref})",
      heading: "개인정보 요청에 대한 안내",
      intro: "{name}님, 검토 결과 제출하신 형태로는 데이터 보호 요청을 처리할 수 없습니다.",
      bodyReasonLabel: "저희 팀의 사유:",
      bodyAppealHint: "결정에 대해 논의하거나 이의를 제기하고 싶으시면 이 이메일에 회신하거나 클럽 관리자에게 연락해 주세요.",
    },
  },

  zh: {
    filed: {
      subject: "已收到您的隐私请求 — {orgName} (#{ref})",
      heading: "我们已收到您的隐私请求",
      intro: "感谢您,{name}。我们已收到您的数据保护请求,并已登记入档。",
      bodyDueBy: "根据适用的数据保护法规(GDPR / DPDP),我们将在 {dueByStr} 之前(30 天内)回复您的请求。",
      bodyNoDueBy: "根据适用的数据保护法规(GDPR / DPDP),我们将在 30 天内回复您的请求。",
    },
    inProgress: {
      subject: "隐私请求进度 — 处理中 (#{ref})",
      heading: "您的隐私请求正在处理中",
      intro: "{name},您好。我们的团队已开始处理您的数据保护请求。",
      bodyDueBy: "我们仍计划在 {dueByStr} 之前完成。处理完成后,您将收到另一封电子邮件。",
    },
    completed: {
      subject: "隐私请求已完成 (#{ref})",
      heading: "您的隐私请求已完成",
      intro: "{name},您好。您的数据保护请求已处理完成。",
      bodyWithLinkLead: "您可以通过下面的安全链接下载与请求相关的资料:",
      bodyButtonLabel: "下载资料",
    },
    rejected: {
      subject: "隐私请求 — 结果 (#{ref})",
      heading: "关于您的隐私请求的更新",
      intro: "{name},您好。经审核,我们无法按所提交的形式处理您的数据保护请求。",
      bodyReasonLabel: "我们团队给出的理由:",
      bodyAppealHint: "如果您希望讨论该决定或提出申诉,请回复此邮件或联系您的俱乐部管理员。",
    },
  },

  th: {
    filed: {
      subject: "ได้รับคำขอความเป็นส่วนตัวแล้ว — {orgName} (#{ref})",
      heading: "เราได้รับคำขอความเป็นส่วนตัวของคุณแล้ว",
      intro: "ขอบคุณคุณ {name} เราได้รับคำขอด้านการคุ้มครองข้อมูลของคุณและได้บันทึกไว้ในระบบของเราแล้ว",
      bodyDueBy: "ตามข้อบังคับการคุ้มครองข้อมูลที่เกี่ยวข้อง (GDPR / DPDP) เราจะตอบกลับคำขอของคุณ {dueByStr} (ภายใน 30 วัน)",
      bodyNoDueBy: "ตามข้อบังคับการคุ้มครองข้อมูลที่เกี่ยวข้อง (GDPR / DPDP) เราจะตอบกลับคำขอของคุณภายใน 30 วัน",
    },
    inProgress: {
      subject: "อัปเดตคำขอความเป็นส่วนตัว — กำลังดำเนินการ (#{ref})",
      heading: "คำขอความเป็นส่วนตัวของคุณกำลังดำเนินการ",
      intro: "สวัสดีคุณ {name} ทีมงานของเราได้เริ่มดำเนินการกับคำขอด้านการคุ้มครองข้อมูลของคุณแล้ว",
      bodyDueBy: "เรายังคงตั้งเป้าหมายที่จะดำเนินการให้แล้วเสร็จภายใน {dueByStr} คุณจะได้รับอีเมลอีกครั้งเมื่อดำเนินการเสร็จสิ้น",
    },
    completed: {
      subject: "คำขอความเป็นส่วนตัวเสร็จสิ้นแล้ว (#{ref})",
      heading: "คำขอความเป็นส่วนตัวของคุณเสร็จสิ้นแล้ว",
      intro: "สวัสดีคุณ {name} คำขอด้านการคุ้มครองข้อมูลของคุณได้รับการดำเนินการเสร็จสิ้นแล้ว",
      bodyWithLinkLead: "คุณสามารถดาวน์โหลดเอกสารที่เกี่ยวข้องกับคำขอของคุณได้จากลิงก์ที่ปลอดภัยด้านล่าง:",
      bodyButtonLabel: "ดาวน์โหลดเอกสาร",
    },
    rejected: {
      subject: "คำขอความเป็นส่วนตัว — ผลลัพธ์ (#{ref})",
      heading: "อัปเดตเกี่ยวกับคำขอความเป็นส่วนตัวของคุณ",
      intro: "สวัสดีคุณ {name} หลังจากการพิจารณา เราไม่สามารถดำเนินการตามคำขอด้านการคุ้มครองข้อมูลของคุณตามที่ส่งมาได้",
      bodyReasonLabel: "เหตุผลจากทีมของเรา:",
      bodyAppealHint: "หากคุณต้องการหารือเกี่ยวกับการตัดสินใจนี้หรือยื่นอุทธรณ์ โปรดตอบกลับอีเมลนี้หรือติดต่อผู้ดูแลคลับของคุณ",
    },
  },

  ms: {
    filed: {
      subject: "Permintaan privasi diterima — {orgName} (#{ref})",
      heading: "Kami telah menerima permintaan privasi anda",
      intro: "Terima kasih, {name}. Kami telah menerima permintaan perlindungan data anda dan ia telah dicatatkan dalam rekod kami.",
      bodyDueBy: "Selaras dengan peraturan perlindungan data yang berkenaan (GDPR / DPDP), kami akan menjawab permintaan anda {dueByStr} (dalam tempoh 30 hari).",
      bodyNoDueBy: "Selaras dengan peraturan perlindungan data yang berkenaan (GDPR / DPDP), kami akan menjawab permintaan anda dalam tempoh 30 hari.",
    },
    inProgress: {
      subject: "Kemas kini permintaan privasi — sedang diproses (#{ref})",
      heading: "Permintaan privasi anda sedang diproses",
      intro: "Hai {name}, pasukan kami telah mula mengendalikan permintaan perlindungan data anda.",
      bodyDueBy: "Kami masih berhasrat menyelesaikannya menjelang {dueByStr}. Anda akan menerima e-mel lain setelah ia diselesaikan.",
    },
    completed: {
      subject: "Permintaan privasi selesai (#{ref})",
      heading: "Permintaan privasi anda telah selesai",
      intro: "Hai {name}, permintaan perlindungan data anda telah diselesaikan.",
      bodyWithLinkLead: "Anda boleh memuat turun bahan-bahan berkaitan permintaan anda menggunakan pautan selamat di bawah:",
      bodyButtonLabel: "Muat turun bahan",
    },
    rejected: {
      subject: "Permintaan privasi — keputusan (#{ref})",
      heading: "Kemas kini tentang permintaan privasi anda",
      intro: "Hai {name}, selepas semakan, kami tidak dapat memenuhi permintaan perlindungan data anda seperti yang diserahkan.",
      bodyReasonLabel: "Sebab daripada pasukan kami:",
      bodyAppealHint: "Sila balas e-mel ini atau hubungi pentadbir kelab anda jika anda ingin membincangkan keputusan atau membuat rayuan.",
    },
  },

  id: {
    filed: {
      subject: "Permintaan privasi diterima — {orgName} (#{ref})",
      heading: "Kami telah menerima permintaan privasi Anda",
      intro: "Terima kasih, {name}. Kami telah menerima permintaan perlindungan data Anda dan telah mencatatnya dalam catatan kami.",
      bodyDueBy: "Sesuai dengan peraturan perlindungan data yang berlaku (GDPR / DPDP), kami akan menanggapi permintaan Anda {dueByStr} (dalam waktu 30 hari).",
      bodyNoDueBy: "Sesuai dengan peraturan perlindungan data yang berlaku (GDPR / DPDP), kami akan menanggapi permintaan Anda dalam waktu 30 hari.",
    },
    inProgress: {
      subject: "Pembaruan permintaan privasi — sedang diproses (#{ref})",
      heading: "Permintaan privasi Anda sedang diproses",
      intro: "Halo {name}, tim kami telah mulai menangani permintaan perlindungan data Anda.",
      bodyDueBy: "Kami masih menargetkan untuk menyelesaikannya pada {dueByStr}. Anda akan menerima email lain setelah selesai.",
    },
    completed: {
      subject: "Permintaan privasi selesai (#{ref})",
      heading: "Permintaan privasi Anda telah selesai",
      intro: "Halo {name}, permintaan perlindungan data Anda telah diselesaikan.",
      bodyWithLinkLead: "Anda dapat mengunduh materi terkait permintaan Anda menggunakan tautan aman di bawah ini:",
      bodyButtonLabel: "Unduh materi",
    },
    rejected: {
      subject: "Permintaan privasi — hasil (#{ref})",
      heading: "Pembaruan tentang permintaan privasi Anda",
      intro: "Halo {name}, setelah peninjauan, kami tidak dapat memenuhi permintaan perlindungan data Anda sebagaimana diajukan.",
      bodyReasonLabel: "Alasan dari tim kami:",
      bodyAppealHint: "Silakan balas email ini atau hubungi administrator klub Anda jika Anda ingin membahas keputusan ini atau mengajukan banding.",
    },
  },

  vi: {
    filed: {
      subject: "Đã nhận yêu cầu về quyền riêng tư — {orgName} (#{ref})",
      heading: "Chúng tôi đã nhận yêu cầu về quyền riêng tư của bạn",
      intro: "Cảm ơn bạn, {name}. Chúng tôi đã nhận yêu cầu bảo vệ dữ liệu của bạn và đã ghi nhận trong hồ sơ.",
      bodyDueBy: "Theo các quy định bảo vệ dữ liệu hiện hành (GDPR / DPDP), chúng tôi sẽ phản hồi yêu cầu của bạn {dueByStr} (trong vòng 30 ngày).",
      bodyNoDueBy: "Theo các quy định bảo vệ dữ liệu hiện hành (GDPR / DPDP), chúng tôi sẽ phản hồi yêu cầu của bạn trong vòng 30 ngày.",
    },
    inProgress: {
      subject: "Cập nhật yêu cầu về quyền riêng tư — đang xử lý (#{ref})",
      heading: "Yêu cầu về quyền riêng tư của bạn đang được xử lý",
      intro: "Xin chào {name}, đội ngũ của chúng tôi đã bắt đầu xử lý yêu cầu bảo vệ dữ liệu của bạn.",
      bodyDueBy: "Chúng tôi vẫn đặt mục tiêu hoàn thành trước {dueByStr}. Bạn sẽ nhận được một email khác sau khi yêu cầu được giải quyết.",
    },
    completed: {
      subject: "Yêu cầu về quyền riêng tư đã hoàn tất (#{ref})",
      heading: "Yêu cầu về quyền riêng tư của bạn đã hoàn tất",
      intro: "Xin chào {name}, yêu cầu bảo vệ dữ liệu của bạn đã được giải quyết.",
      bodyWithLinkLead: "Bạn có thể tải xuống tài liệu liên quan đến yêu cầu của mình bằng liên kết an toàn bên dưới:",
      bodyButtonLabel: "Tải xuống tài liệu",
    },
    rejected: {
      subject: "Yêu cầu về quyền riêng tư — kết quả (#{ref})",
      heading: "Cập nhật về yêu cầu quyền riêng tư của bạn",
      intro: "Xin chào {name}, sau khi xem xét, chúng tôi không thể đáp ứng yêu cầu bảo vệ dữ liệu của bạn như đã gửi.",
      bodyReasonLabel: "Lý do từ đội ngũ của chúng tôi:",
      bodyAppealHint: "Vui lòng trả lời email này hoặc liên hệ với quản trị viên câu lạc bộ của bạn nếu bạn muốn thảo luận về quyết định hoặc khiếu nại.",
    },
  },

  fil: {
    filed: {
      subject: "Natanggap ang privacy request — {orgName} (#{ref})",
      heading: "Natanggap namin ang iyong privacy request",
      intro: "Salamat, {name}. Natanggap namin ang iyong data-protection request at naitala na ito sa aming mga rekord.",
      bodyDueBy: "Alinsunod sa mga naaangkop na regulasyon sa proteksyon ng data (GDPR / DPDP), tutugon kami sa iyong kahilingan {dueByStr} (sa loob ng 30 araw).",
      bodyNoDueBy: "Alinsunod sa mga naaangkop na regulasyon sa proteksyon ng data (GDPR / DPDP), tutugon kami sa iyong kahilingan sa loob ng 30 araw.",
    },
    inProgress: {
      subject: "Update sa privacy request — kasalukuyang pinoproseso (#{ref})",
      heading: "Pinoproseso na ang iyong privacy request",
      intro: "Hi {name}, sinimulan na ng aming team ang pagproseso ng iyong data-protection request.",
      bodyDueBy: "Sinisikap pa rin naming matapos ito bago ang {dueByStr}. Makakatanggap ka ng isa pang email kapag naresolba na ito.",
    },
    completed: {
      subject: "Tapos na ang privacy request (#{ref})",
      heading: "Tapos na ang iyong privacy request",
      intro: "Hi {name}, naresolba na ang iyong data-protection request.",
      bodyWithLinkLead: "Maaari mong i-download ang mga materyales na may kaugnayan sa iyong kahilingan gamit ang secure na link sa ibaba:",
      bodyButtonLabel: "I-download ang mga materyales",
    },
    rejected: {
      subject: "Privacy request — resulta (#{ref})",
      heading: "Update tungkol sa iyong privacy request",
      intro: "Hi {name}, pagkatapos ng pagsusuri, hindi namin maaasikaso ang iyong data-protection request gaya ng isinumite.",
      bodyReasonLabel: "Dahilan mula sa aming team:",
      bodyAppealHint: "Tumugon sa email na ito o makipag-ugnayan sa administrator ng iyong club kung nais mong pag-usapan ang desisyon o iapela ito.",
    },
  },

  sw: {
    filed: {
      subject: "Ombi la faragha limepokelewa — {orgName} (#{ref})",
      heading: "Tumepokea ombi lako la faragha",
      intro: "Asante, {name}. Tumepokea ombi lako la ulinzi wa data na limeingizwa kwenye rekodi zetu.",
      bodyDueBy: "Kulingana na kanuni za ulinzi wa data zinazotumika (GDPR / DPDP), tutajibu ombi lako {dueByStr} (ndani ya siku 30).",
      bodyNoDueBy: "Kulingana na kanuni za ulinzi wa data zinazotumika (GDPR / DPDP), tutajibu ombi lako ndani ya siku 30.",
    },
    inProgress: {
      subject: "Sasisho la ombi la faragha — linachakatwa (#{ref})",
      heading: "Ombi lako la faragha linachakatwa",
      intro: "Habari {name}, timu yetu imeanza kushughulikia ombi lako la ulinzi wa data.",
      bodyDueBy: "Bado tunalenga kulikamilisha ifikapo {dueByStr}. Utapokea barua pepe nyingine pindi litakapotatuliwa.",
    },
    completed: {
      subject: "Ombi la faragha limekamilika (#{ref})",
      heading: "Ombi lako la faragha limekamilika",
      intro: "Habari {name}, ombi lako la ulinzi wa data limeshughulikiwa.",
      bodyWithLinkLead: "Unaweza kupakua nyenzo zinazohusiana na ombi lako kupitia kiungo salama hapa chini:",
      bodyButtonLabel: "Pakua nyenzo",
    },
    rejected: {
      subject: "Ombi la faragha — matokeo (#{ref})",
      heading: "Sasisho kuhusu ombi lako la faragha",
      intro: "Habari {name}, baada ya ukaguzi, hatuwezi kutimiza ombi lako la ulinzi wa data kama lilivyowasilishwa.",
      bodyReasonLabel: "Sababu kutoka kwa timu yetu:",
      bodyAppealHint: "Tafadhali jibu barua pepe hii au wasiliana na msimamizi wa klabu yako ikiwa ungependa kujadili uamuzi huu au kukata rufaa.",
    },
  },

  af: {
    filed: {
      subject: "Privaatheidversoek ontvang — {orgName} (#{ref})",
      heading: "Ons het jou privaatheidversoek ontvang",
      intro: "Dankie, {name}. Ons het jou databeskermingsversoek ontvang en in ons rekords opgeneem.",
      bodyDueBy: "In ooreenstemming met die toepaslike databeskermingsregulasies (GDPR / DPDP) sal ons jou versoek {dueByStr} (binne 30 dae) beantwoord.",
      bodyNoDueBy: "In ooreenstemming met die toepaslike databeskermingsregulasies (GDPR / DPDP) sal ons jou versoek binne 30 dae beantwoord.",
    },
    inProgress: {
      subject: "Privaatheidversoek-opdatering — aan die gang (#{ref})",
      heading: "Jou privaatheidversoek word verwerk",
      intro: "Hallo {name}, ons span het begin om jou databeskermingsversoek te hanteer.",
      bodyDueBy: "Ons mik steeds daarop om dit teen {dueByStr} te voltooi. Jy sal nog 'n e-pos ontvang sodra dit opgelos is.",
    },
    completed: {
      subject: "Privaatheidversoek voltooi (#{ref})",
      heading: "Jou privaatheidversoek is voltooi",
      intro: "Hallo {name}, jou databeskermingsversoek is opgelos.",
      bodyWithLinkLead: "Jy kan die materiaal wat met jou versoek verband hou aflaai deur die veilige skakel hieronder te gebruik:",
      bodyButtonLabel: "Laai materiaal af",
    },
    rejected: {
      subject: "Privaatheidversoek — uitkoms (#{ref})",
      heading: "Opdatering oor jou privaatheidversoek",
      intro: "Hallo {name}, na hersiening kan ons nie jou databeskermingsversoek soos ingedien nakom nie.",
      bodyReasonLabel: "Rede van ons span:",
      bodyAppealHint: "Antwoord asseblief op hierdie e-pos of kontak jou klubadministrateur as jy die besluit wil bespreek of teen die besluit appèl wil aanteken.",
    },
  },

  am: {
    filed: {
      subject: "የግላዊነት ጥያቄ ተቀብሏል — {orgName} (#{ref})",
      heading: "የግላዊነት ጥያቄዎን ተቀብለናል",
      intro: "አመሰግናለሁ {name}። የውሂብ ጥበቃ ጥያቄዎን ተቀብለን በመዝገቦቻችን ላይ ተመዝግቧል።",
      bodyDueBy: "ተተግባሪ የውሂብ ጥበቃ ደንቦች (GDPR / DPDP) መሠረት፣ ጥያቄዎን {dueByStr} ድረስ (በ30 ቀናት ውስጥ) እንመልሳለን።",
      bodyNoDueBy: "ተተግባሪ የውሂብ ጥበቃ ደንቦች (GDPR / DPDP) መሠረት፣ ጥያቄዎን በ30 ቀናት ውስጥ እንመልሳለን።",
    },
    inProgress: {
      subject: "የግላዊነት ጥያቄ ዝመና — በሂደት ላይ ነው (#{ref})",
      heading: "የግላዊነት ጥያቄዎ እየተስተናገደ ነው",
      intro: "ሰላም {name}፣ ቡድናችን የውሂብ ጥበቃ ጥያቄዎ ላይ መሥራት ጀምሯል።",
      bodyDueBy: "አሁንም በ{dueByStr} ድረስ ለመጨረስ እያቀድን ነው። ሲፈታ ሌላ ኢሜይል ይደርስዎታል።",
    },
    completed: {
      subject: "የግላዊነት ጥያቄ ተጠናቋል (#{ref})",
      heading: "የግላዊነት ጥያቄዎ ተጠናቋል",
      intro: "ሰላም {name}፣ የውሂብ ጥበቃ ጥያቄዎ ተፈትቷል።",
      bodyWithLinkLead: "ከታች ያለውን ደህንነቱ የተጠበቀ አገናኝ በመጠቀም ከጥያቄዎ ጋር የተያያዙ ቁሳቁሶችን ማውረድ ይችላሉ:",
      bodyButtonLabel: "ቁሳቁሶችን አውርድ",
    },
    rejected: {
      subject: "የግላዊነት ጥያቄ — ውጤት (#{ref})",
      heading: "ስለ ግላዊነት ጥያቄዎ ዝመና",
      intro: "ሰላም {name}፣ ከግምገማ በኋላ የውሂብ ጥበቃ ጥያቄዎን በቀረበበት መልኩ ማስፈጸም አንችልም።",
      bodyReasonLabel: "ከቡድናችን ምክንያት:",
      bodyAppealHint: "ውሳኔውን ለመወያየት ወይም ለመከራከር ከፈለጉ፣ እባክዎ ለዚህ ኢሜይል ምላሽ ይስጡ ወይም የክለብ አስተዳዳሪዎን ያግኙ።",
    },
  },

  ha: {
    filed: {
      subject: "An karbi buƙatar sirri — {orgName} (#{ref})",
      heading: "Mun karbi buƙatar sirrinka",
      intro: "Mun gode, {name}. Mun karbi buƙatar kariyar bayananka kuma an shigar da ita cikin bayananmu.",
      bodyDueBy: "Bisa ga ƙa'idodin kariyar bayanai masu aiki (GDPR / DPDP), za mu amsa buƙatarka {dueByStr} (cikin kwanaki 30).",
      bodyNoDueBy: "Bisa ga ƙa'idodin kariyar bayanai masu aiki (GDPR / DPDP), za mu amsa buƙatarka cikin kwanaki 30.",
    },
    inProgress: {
      subject: "Sabunta buƙatar sirri — ana kan aikatawa (#{ref})",
      heading: "Ana kan aiwatar da buƙatar sirrinka",
      intro: "Sannu {name}, ƙungiyarmu ta fara aiki kan buƙatar kariyar bayananka.",
      bodyDueBy: "Har yanzu muna nufin kammala ta kafin {dueByStr}. Za ka karbi wani imel idan an warware shi.",
    },
    completed: {
      subject: "An kammala buƙatar sirri (#{ref})",
      heading: "An kammala buƙatar sirrinka",
      intro: "Sannu {name}, an warware buƙatar kariyar bayananka.",
      bodyWithLinkLead: "Kana iya saukar da abubuwan da suka shafi buƙatarka ta amfani da hanyar haɗi mai aminci a ƙasa:",
      bodyButtonLabel: "Sauke abubuwa",
    },
    rejected: {
      subject: "Buƙatar sirri — sakamako (#{ref})",
      heading: "Sabunta game da buƙatar sirrinka",
      intro: "Sannu {name}, bayan dubawa, ba za mu iya cika buƙatar kariyar bayananka kamar yadda aka gabatar ba.",
      bodyReasonLabel: "Dalili daga ƙungiyarmu:",
      bodyAppealHint: "Don Allah amsa wannan imel ko tuntuɓi mai gudanarwa na kungiyarka idan kana son tattauna shawarar ko ɗaukaka ƙara.",
    },
  },

  zu: {
    filed: {
      subject: "Isicelo sokuvikela imfihlo sitholiwe — {orgName} (#{ref})",
      heading: "Sithole isicelo sakho sokuvikela imfihlo",
      intro: "Siyabonga, {name}. Sithole isicelo sakho sokuvikelwa kwedatha futhi siloba kumarekhodi ethu.",
      bodyDueBy: "Ngokuvumelana nemithetho yokuvikelwa kwedatha esebenzayo (GDPR / DPDP), sizophendula isicelo sakho {dueByStr} (kungakapheli izinsuku ezingu-30).",
      bodyNoDueBy: "Ngokuvumelana nemithetho yokuvikelwa kwedatha esebenzayo (GDPR / DPDP), sizophendula isicelo sakho kungakapheli izinsuku ezingu-30.",
    },
    inProgress: {
      subject: "Isibuyekezo sesicelo sokuvikela imfihlo — siyaqhutshwa (#{ref})",
      heading: "Isicelo sakho sokuvikela imfihlo siyacutshungulwa",
      intro: "Sawubona {name}, ithimba lethu seliqalile ukusebenza esicelweni sakho sokuvikelwa kwedatha.",
      bodyDueBy: "Sisaqonde ukusiqedela ngo-{dueByStr}. Uzothola enye i-imeyili lapho sesixazululiwe.",
    },
    completed: {
      subject: "Isicelo sokuvikela imfihlo siqedelwe (#{ref})",
      heading: "Isicelo sakho sokuvikela imfihlo siqediwe",
      intro: "Sawubona {name}, isicelo sakho sokuvikelwa kwedatha sesixazululiwe.",
      bodyWithLinkLead: "Ungalanda izinto eziphathelene nesicelo sakho usebenzisa isixhumanisi esiphephile esingezansi:",
      bodyButtonLabel: "Landa izinto",
    },
    rejected: {
      subject: "Isicelo sokuvikela imfihlo — umphumela (#{ref})",
      heading: "Isibuyekezo mayelana nesicelo sakho sokuvikela imfihlo",
      intro: "Sawubona {name}, ngemva kokubuyekezwa, asikwazi ukugcwalisa isicelo sakho sokuvikelwa kwedatha njengoba sihanjisiwe.",
      bodyReasonLabel: "Isizathu esivela ethimbeni lethu:",
      bodyAppealHint: "Sicela uphendule le-imeyili noma uxhumane nomphathi weklabhu yakho uma ufuna ukuxoxa ngesinqumo noma ukufaka isicelo socwaningo.",
    },
  },

  yo: {
    filed: {
      subject: "Ìbéèrè ìpamọ́ ti gba — {orgName} (#{ref})",
      heading: "A ti gba ìbéèrè ìpamọ́ rẹ",
      intro: "O ṣeun, {name}. A ti gba ìbéèrè ìdáàbòbò dátà rẹ a sì ti forúkọ rẹ̀ sínú àkọsílẹ̀ wa.",
      bodyDueBy: "Ní ìbámu pẹ̀lú àwọn òfin ìdáàbòbò dátà tó wúlò (GDPR / DPDP), a ó dáhùn ìbéèrè rẹ {dueByStr} (laàrín ọjọ́ 30).",
      bodyNoDueBy: "Ní ìbámu pẹ̀lú àwọn òfin ìdáàbòbò dátà tó wúlò (GDPR / DPDP), a ó dáhùn ìbéèrè rẹ laàrín ọjọ́ 30.",
    },
    inProgress: {
      subject: "Ìmúdájú ìbéèrè ìpamọ́ — ń lọ lọ́wọ́ (#{ref})",
      heading: "Ìbéèrè ìpamọ́ rẹ wà ní ìṣiṣẹ́",
      intro: "Báwo {name}, ẹgbẹ́ wa ti bẹ̀rẹ̀ síní ṣiṣẹ́ lórí ìbéèrè ìdáàbòbò dátà rẹ.",
      bodyDueBy: "A ṣì ń lépa láti pari rẹ̀ ní {dueByStr}. Ìwọ yóò gba ímeèlì míràn lẹ́yìn tí a bá yanjú rẹ̀.",
    },
    completed: {
      subject: "Ìbéèrè ìpamọ́ ti parí (#{ref})",
      heading: "Ìbéèrè ìpamọ́ rẹ ti parí",
      intro: "Báwo {name}, a ti yanjú ìbéèrè ìdáàbòbò dátà rẹ.",
      bodyWithLinkLead: "O lè gba àwọn ohun èlò tó jẹmọ́ ìbéèrè rẹ nípa lílo ìjápọ̀ aláìléwu nísàlẹ̀:",
      bodyButtonLabel: "Gba àwọn ohun èlò",
    },
    rejected: {
      subject: "Ìbéèrè ìpamọ́ — àbájáde (#{ref})",
      heading: "Ìmúdájú nípa ìbéèrè ìpamọ́ rẹ",
      intro: "Báwo {name}, lẹ́yìn àyẹ̀wò, a kò lè mú ìbéèrè ìdáàbòbò dátà rẹ ṣẹ bí a ti fi sílẹ̀.",
      bodyReasonLabel: "Ìdí láti ọ̀dọ̀ ẹgbẹ́ wa:",
      bodyAppealHint: "Jọ̀wọ́ dáhùn ímeèlì yìí tàbí kàn sí alábòójútó ọmọ ẹgbẹ́ rẹ tí o bá fẹ́ jíròrò ìpinnu náà tàbí gbé ẹjọ́.",
    },
  },
};

/**
 * Vars for {@link translateDataRequestEmail}. The consumer is
 * responsible for HTML-escaping any user-controlled values before
 * passing them in (`name`, `orgName`).
 */
export interface DataRequestEmailTranslationVars {
  /** HTML-escaped recipient display name. */
  name: string;
  /** HTML-escaped organisation name. */
  orgName: string;
  /** Numeric data-request id; rendered as `#{ref}`. */
  ref: string | number;
}

/**
 * Translation result. Carries the per-language shell (labels, header
 * tag, footer note, html `lang`/`dir` attributes, and the
 * "Data export (portability)" type label) alongside per-kind copy.
 *
 * Per-kind fields are populated according to the requested `kind`:
 * - `filed`       → `filed.bodyDueBy`, `filed.bodyNoDueBy`
 * - `in_progress` → `inProgress.bodyDueBy`
 * - `completed`   → `completed.bodyWithLinkLead`, `completed.bodyButtonLabel`
 * - `rejected`    → `rejected.bodyReasonLabel`, `rejected.bodyAppealHint`
 *
 * `subject`, `heading`, and `intro` always reflect the requested kind.
 */
export interface DataRequestEmailTranslation extends DataRequestEmailShell {
  /** Subject line with `{ref}` (and `{orgName}` for `filed`) already substituted. */
  subject: string;
  /** `<h2>` heading copy. */
  heading: string;
  /** Greeting + intro paragraph with `{name}` already substituted. */
  intro: string;
  /** Per-kind copy bundle — only the fields for the requested kind are guaranteed to be set. */
  filed: { bodyDueBy: string; bodyNoDueBy: string };
  inProgress: { bodyDueBy: string };
  completed: { bodyWithLinkLead: string; bodyButtonLabel: string };
  rejected: { bodyReasonLabel: string; bodyAppealHint: string };
}

/**
 * Translate the four non-export `DataRequestEmailKind` arms for a
 * given language code (Task #2167).
 *
 * Returns the English pack when `lang` is missing or unsupported
 * (mirrors {@link resolveDataExportEmailLang}).
 *
 * `vars.name` and `vars.orgName` are interpolated directly into the
 * returned strings and rendered into the email HTML, so the caller
 * MUST pass HTML-escaped values when those fields can carry
 * user-controlled content. The `{dueByStr}` placeholder inside
 * `filed.bodyDueBy` and `inProgress.bodyDueBy` is left intact for
 * the consumer to wrap with `<strong>…</strong>` markup before
 * substitution — see `mailer.ts` for the rendered usage.
 */
export function translateDataRequestEmail(
  lang: string | null | undefined,
  kind: DataRequestEmailNonExportKind,
  vars: DataRequestEmailTranslationVars,
): DataRequestEmailTranslation {
  const code = resolveDataExportEmailLang(lang);
  const pack = PACKS[code];
  const shell = getDataRequestEmailShell(lang);
  const baseVars = {
    name: vars.name,
    orgName: vars.orgName,
    ref: String(vars.ref),
  };

  let subject: string;
  let heading: string;
  let intro: string;
  switch (kind) {
    case "filed":
      subject = formatDataRequestEmailString(pack.filed.subject, baseVars);
      heading = pack.filed.heading;
      intro = formatDataRequestEmailString(pack.filed.intro, baseVars);
      break;
    case "in_progress":
      subject = formatDataRequestEmailString(pack.inProgress.subject, baseVars);
      heading = pack.inProgress.heading;
      intro = formatDataRequestEmailString(pack.inProgress.intro, baseVars);
      break;
    case "completed":
      subject = formatDataRequestEmailString(pack.completed.subject, baseVars);
      heading = pack.completed.heading;
      intro = formatDataRequestEmailString(pack.completed.intro, baseVars);
      break;
    case "rejected":
      subject = formatDataRequestEmailString(pack.rejected.subject, baseVars);
      heading = pack.rejected.heading;
      intro = formatDataRequestEmailString(pack.rejected.intro, baseVars);
      break;
  }

  return {
    ...shell,
    footerNote: formatDataRequestEmailString(shell.footerNote, baseVars),
    subject,
    heading,
    intro,
    filed: {
      bodyDueBy: pack.filed.bodyDueBy,
      bodyNoDueBy: pack.filed.bodyNoDueBy,
    },
    inProgress: {
      bodyDueBy: pack.inProgress.bodyDueBy,
    },
    completed: {
      bodyWithLinkLead: pack.completed.bodyWithLinkLead,
      bodyButtonLabel: pack.completed.bodyButtonLabel,
    },
    rejected: {
      bodyReasonLabel: pack.rejected.bodyReasonLabel,
      bodyAppealHint: pack.rejected.bodyAppealHint,
    },
  };
}
