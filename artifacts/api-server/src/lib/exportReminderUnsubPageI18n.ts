/**
 * Translations for the public branded HTML confirmation page rendered at
 * `GET /api/public/data-export-reminder-unsubscribe` (Task #1235), which
 * is reached via the one-click "stop reminding me about this download"
 * link embedded in the `completed_export` ready email and the
 * `export_expiring` reminder (Task #1075).
 *
 * Mirrors the 21 languages declared by the `supported_language` enum
 * (same set used by `customDomainEmailI18n.ts`, `walletRefundI18n.ts`,
 * etc.) and ships strings for the three states the page can render:
 *
 *   - ok       : "You've been unsubscribed…"   (success on first click)
 *   - already  : "You're already unsubscribed" (idempotent re-click)
 *   - invalid  : "This unsubscribe link is no longer valid"
 *
 * Members reach this page from email links carrying a `lang=` hint
 * (Task #1437) so the copy matches the language of the email they
 * clicked from. Unknown / missing language codes safely fall back to
 * English (see {@link resolveExportReminderUnsubLang}).
 */

export type ExportReminderUnsubLang =
  | "en" | "hi" | "ar" | "es" | "fr" | "de" | "pt"
  | "ja" | "ko" | "zh" | "th" | "ms" | "id" | "vi"
  | "fil" | "sw" | "af" | "am" | "ha" | "zu" | "yo";

export const EXPORT_REMINDER_UNSUB_LANGS: ExportReminderUnsubLang[] = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

export function isSupportedExportReminderUnsubLang(
  lang: string | null | undefined,
): lang is ExportReminderUnsubLang {
  return !!lang && (EXPORT_REMINDER_UNSUB_LANGS as string[]).includes(lang);
}

/** Resolve the language pack, falling back to English. */
export function resolveExportReminderUnsubLang(
  lang: string | null | undefined,
): ExportReminderUnsubLang {
  return isSupportedExportReminderUnsubLang(lang) ? lang : "en";
}

export type ExportReminderUnsubState = "ok" | "already" | "invalid";

export interface ExportReminderUnsubStrings {
  /** HTML `<title>` text (no orgName suffix; the renderer appends it). */
  title: string;
  heading: string;
  body: string;
  /** Footer copy below the card. */
  footer: string;
  /** Header sub-tag (e.g. "Data Protection"). */
  headerTag: string;
  /** BCP-47-ish HTML `lang` attribute matching the pack (e.g. "en", "hi"). */
  htmlLang: string;
  /** Set on the `<html>` tag for right-to-left scripts. */
  dir: "ltr" | "rtl";
}

interface LangPack {
  htmlLang: string;
  dir: "ltr" | "rtl";
  headerTag: string;
  footer: string;
  ok: { title: string; heading: string; body: string };
  already: { title: string; heading: string; body: string };
  invalid: { title: string; heading: string; body: string };
}

const PACKS: Record<ExportReminderUnsubLang, LangPack> = {
  en: {
    htmlLang: "en",
    dir: "ltr",
    headerTag: "Data Protection",
    footer: "You can close this window. If you have questions, reply to the email this link came from.",
    ok: {
      title: "You've been unsubscribed",
      heading: "You've been unsubscribed from this reminder",
      body: "We won't send you the 24-hour heads-up about this data export expiring. Your download link itself is unchanged — open the Privacy screen in the app whenever you're ready to grab your archive.",
    },
    already: {
      title: "Already unsubscribed",
      heading: "You're already unsubscribed",
      body: "You've previously asked us not to remind you about this data export. No further action is needed — you won't get the 24-hour reminder.",
    },
    invalid: {
      title: "Link no longer valid",
      heading: "This unsubscribe link is no longer valid",
      body: "It may have already been used, or the data export it referred to has expired. You can manage email preferences from the Privacy screen in the app whenever you like.",
    },
  },

  hi: {
    htmlLang: "hi",
    dir: "ltr",
    headerTag: "डेटा सुरक्षा",
    footer: "आप यह विंडो बंद कर सकते हैं। यदि कोई प्रश्न हो, तो उस ईमेल का उत्तर दें जिससे यह लिंक आया था।",
    ok: {
      title: "आपकी सदस्यता रद्द कर दी गई",
      heading: "आपको इस अनुस्मारक से हटा दिया गया है",
      body: "हम आपको इस डेटा निर्यात की समाप्ति से पहले 24 घंटे का अनुस्मारक नहीं भेजेंगे। आपका डाउनलोड लिंक स्वयं अपरिवर्तित है — जब भी आप अपनी संग्रह फ़ाइल लेने के लिए तैयार हों, ऐप में गोपनीयता स्क्रीन खोलें।",
    },
    already: {
      title: "पहले से अनसब्सक्राइब्ड",
      heading: "आप पहले ही अनसब्सक्राइब्ड हैं",
      body: "आपने पहले हमसे इस डेटा निर्यात के बारे में अनुस्मारक न भेजने को कहा है। किसी और कार्रवाई की आवश्यकता नहीं है — आपको 24 घंटे का अनुस्मारक नहीं मिलेगा।",
    },
    invalid: {
      title: "लिंक अब मान्य नहीं है",
      heading: "यह अनसब्सक्राइब लिंक अब मान्य नहीं है",
      body: "हो सकता है कि इसका उपयोग पहले ही हो चुका हो, या जिस डेटा निर्यात से यह जुड़ा था उसकी अवधि समाप्त हो गई हो। आप किसी भी समय ऐप में गोपनीयता स्क्रीन से ईमेल प्राथमिकताएँ प्रबंधित कर सकते हैं।",
    },
  },

  ar: {
    htmlLang: "ar",
    dir: "rtl",
    headerTag: "حماية البيانات",
    footer: "يمكنك إغلاق هذه النافذة. إذا كانت لديك أسئلة، فقم بالرد على البريد الإلكتروني الذي جاء منه هذا الرابط.",
    ok: {
      title: "تم إلغاء اشتراكك",
      heading: "تم إلغاء اشتراكك في هذا التذكير",
      body: "لن نرسل لك التذكير قبل انتهاء صلاحية هذا التصدير بـ 24 ساعة. رابط التنزيل نفسه لم يتغير — افتح شاشة الخصوصية في التطبيق متى أردت تنزيل أرشيفك.",
    },
    already: {
      title: "ملغى الاشتراك مسبقاً",
      heading: "أنت ملغى الاشتراك بالفعل",
      body: "لقد طلبت منا سابقاً عدم تذكيرك بهذا التصدير للبيانات. لا حاجة لأي إجراء إضافي — لن يصلك تذكير الـ 24 ساعة.",
    },
    invalid: {
      title: "الرابط لم يعد صالحاً",
      heading: "رابط إلغاء الاشتراك هذا لم يعد صالحاً",
      body: "ربما تم استخدامه بالفعل، أو انتهت صلاحية تصدير البيانات الذي يشير إليه. يمكنك إدارة تفضيلات البريد الإلكتروني من شاشة الخصوصية في التطبيق متى شئت.",
    },
  },

  es: {
    htmlLang: "es",
    dir: "ltr",
    headerTag: "Protección de datos",
    footer: "Puedes cerrar esta ventana. Si tienes alguna pregunta, responde al correo desde el que provino este enlace.",
    ok: {
      title: "Te has dado de baja",
      heading: "Te has dado de baja de este recordatorio",
      body: "No te enviaremos el aviso 24 horas antes de que caduque esta exportación de datos. Tu enlace de descarga no cambia — abre la pantalla de Privacidad en la aplicación cuando quieras obtener tu archivo.",
    },
    already: {
      title: "Ya estás dado de baja",
      heading: "Ya estás dado de baja",
      body: "Ya nos habías pedido que no te recordáramos esta exportación de datos. No es necesaria ninguna acción adicional — no recibirás el recordatorio de 24 horas.",
    },
    invalid: {
      title: "Enlace ya no válido",
      heading: "Este enlace de baja ya no es válido",
      body: "Puede que ya se haya utilizado, o que la exportación de datos a la que se refería haya caducado. Puedes gestionar las preferencias de correo desde la pantalla de Privacidad en la aplicación cuando quieras.",
    },
  },

  fr: {
    htmlLang: "fr",
    dir: "ltr",
    headerTag: "Protection des données",
    footer: "Vous pouvez fermer cette fenêtre. Pour toute question, répondez à l'e-mail dont provient ce lien.",
    ok: {
      title: "Vous êtes désinscrit",
      heading: "Vous êtes désinscrit de ce rappel",
      body: "Nous ne vous enverrons pas le rappel 24 heures avant l'expiration de cet export de données. Votre lien de téléchargement reste inchangé — ouvrez l'écran Confidentialité dans l'application dès que vous êtes prêt à récupérer votre archive.",
    },
    already: {
      title: "Déjà désinscrit",
      heading: "Vous êtes déjà désinscrit",
      body: "Vous nous avez déjà demandé de ne pas vous rappeler cet export de données. Aucune action supplémentaire n'est nécessaire — vous ne recevrez pas le rappel de 24 heures.",
    },
    invalid: {
      title: "Lien non valide",
      heading: "Ce lien de désinscription n'est plus valide",
      body: "Il a peut-être déjà été utilisé, ou l'export de données auquel il faisait référence a expiré. Vous pouvez gérer vos préférences e-mail depuis l'écran Confidentialité dans l'application à tout moment.",
    },
  },

  de: {
    htmlLang: "de",
    dir: "ltr",
    headerTag: "Datenschutz",
    footer: "Sie können dieses Fenster schließen. Bei Fragen antworten Sie bitte auf die E-Mail, aus der dieser Link stammt.",
    ok: {
      title: "Sie haben sich abgemeldet",
      heading: "Sie haben sich von dieser Erinnerung abgemeldet",
      body: "Wir senden Ihnen keine Erinnerung 24 Stunden vor Ablauf dieses Datenexports. Ihr Download-Link selbst bleibt unverändert — öffnen Sie den Datenschutz-Bildschirm in der App, sobald Sie Ihr Archiv herunterladen möchten.",
    },
    already: {
      title: "Bereits abgemeldet",
      heading: "Sie sind bereits abgemeldet",
      body: "Sie haben uns bereits gebeten, Sie nicht an diesen Datenexport zu erinnern. Keine weitere Aktion erforderlich — Sie erhalten die 24-Stunden-Erinnerung nicht.",
    },
    invalid: {
      title: "Link nicht mehr gültig",
      heading: "Dieser Abmelde-Link ist nicht mehr gültig",
      body: "Möglicherweise wurde er bereits verwendet, oder der zugehörige Datenexport ist abgelaufen. Sie können die E-Mail-Einstellungen jederzeit über den Datenschutz-Bildschirm in der App verwalten.",
    },
  },

  pt: {
    htmlLang: "pt",
    dir: "ltr",
    headerTag: "Proteção de dados",
    footer: "Pode fechar esta janela. Se tiver dúvidas, responda ao e-mail do qual veio este link.",
    ok: {
      title: "Cancelou a subscrição",
      heading: "A sua subscrição deste lembrete foi cancelada",
      body: "Não lhe enviaremos o aviso 24 horas antes de esta exportação de dados expirar. O seu link de download em si não muda — abra o ecrã de Privacidade na aplicação quando quiser obter o seu arquivo.",
    },
    already: {
      title: "Já cancelou a subscrição",
      heading: "Já cancelou a subscrição",
      body: "Já nos pediu para não o lembrarmos desta exportação de dados. Não é necessária mais nenhuma ação — não receberá o lembrete de 24 horas.",
    },
    invalid: {
      title: "Link já não válido",
      heading: "Este link de cancelamento já não é válido",
      body: "Pode já ter sido utilizado, ou a exportação de dados a que se referia expirou. Pode gerir as preferências de e-mail no ecrã de Privacidade da aplicação a qualquer momento.",
    },
  },

  ja: {
    htmlLang: "ja",
    dir: "ltr",
    headerTag: "データ保護",
    footer: "このウィンドウを閉じてかまいません。ご質問がある場合は、このリンクが届いたメールに返信してください。",
    ok: {
      title: "配信停止が完了しました",
      heading: "このリマインダーの配信を停止しました",
      body: "このデータエクスポートの有効期限切れ24時間前のお知らせはお送りしません。ダウンロードリンク自体は変わりません — アーカイブを取得する準備ができたら、アプリのプライバシー画面を開いてください。",
    },
    already: {
      title: "すでに配信停止済みです",
      heading: "すでに配信停止済みです",
      body: "以前にこのデータエクスポートのリマインダーを停止するよう依頼いただいています。追加の操作は不要です — 24時間前のリマインダーは届きません。",
    },
    invalid: {
      title: "リンクは無効です",
      heading: "この配信停止リンクは無効です",
      body: "すでに使用済みか、対象のデータエクスポートの有効期限が切れている可能性があります。メールの設定はいつでもアプリのプライバシー画面から変更できます。",
    },
  },

  ko: {
    htmlLang: "ko",
    dir: "ltr",
    headerTag: "데이터 보호",
    footer: "이 창을 닫으셔도 됩니다. 문의가 있으시면 이 링크가 발송된 이메일에 회신해 주세요.",
    ok: {
      title: "수신을 거부했습니다",
      heading: "이 알림 수신을 거부했습니다",
      body: "이 데이터 내보내기 만료 24시간 전 알림을 보내드리지 않습니다. 다운로드 링크 자체는 변경되지 않습니다 — 보관 파일을 받을 준비가 되면 앱의 개인정보 보호 화면을 열어주세요.",
    },
    already: {
      title: "이미 수신 거부됨",
      heading: "이미 수신을 거부하셨습니다",
      body: "이전에 이 데이터 내보내기에 대한 알림을 보내지 말아 달라고 요청하셨습니다. 추가 조치는 필요하지 않습니다 — 24시간 알림은 발송되지 않습니다.",
    },
    invalid: {
      title: "링크가 더 이상 유효하지 않음",
      heading: "이 수신 거부 링크는 더 이상 유효하지 않습니다",
      body: "이미 사용되었거나 대상 데이터 내보내기가 만료되었을 수 있습니다. 언제든지 앱의 개인정보 보호 화면에서 이메일 환경설정을 관리할 수 있습니다.",
    },
  },

  zh: {
    htmlLang: "zh",
    dir: "ltr",
    headerTag: "数据保护",
    footer: "您可以关闭此窗口。如有疑问,请回复您收到此链接的邮件。",
    ok: {
      title: "已取消订阅",
      heading: "您已取消订阅此提醒",
      body: "我们不会再向您发送此数据导出到期前 24 小时的提醒。您的下载链接本身保持不变 — 准备好获取存档时,请打开应用中的隐私页面。",
    },
    already: {
      title: "已取消订阅",
      heading: "您已经取消订阅",
      body: "您此前已要求不再就此数据导出向您发送提醒。无需进一步操作 — 您将不会收到 24 小时提醒。",
    },
    invalid: {
      title: "链接已失效",
      heading: "此取消订阅链接已失效",
      body: "它可能已被使用,或所对应的数据导出已过期。您可以随时在应用的隐私页面中管理邮件偏好设置。",
    },
  },

  th: {
    htmlLang: "th",
    dir: "ltr",
    headerTag: "การปกป้องข้อมูล",
    footer: "คุณสามารถปิดหน้าต่างนี้ได้ หากมีคำถามโปรดตอบกลับอีเมลที่ส่งลิงก์นี้มา",
    ok: {
      title: "ยกเลิกการรับแจ้งเตือนแล้ว",
      heading: "ยกเลิกการรับการแจ้งเตือนนี้แล้ว",
      body: "เราจะไม่ส่งคำเตือนล่วงหน้า 24 ชั่วโมงก่อนที่การส่งออกข้อมูลนี้จะหมดอายุ ลิงก์ดาวน์โหลดของคุณยังคงเหมือนเดิม — เปิดหน้าจอความเป็นส่วนตัวในแอปเมื่อคุณพร้อมรับไฟล์เก็บถาวร",
    },
    already: {
      title: "ยกเลิกแล้ว",
      heading: "คุณยกเลิกการรับแจ้งเตือนแล้ว",
      body: "คุณเคยขอให้เราไม่เตือนเรื่องการส่งออกข้อมูลนี้แล้ว ไม่ต้องดำเนินการใด ๆ เพิ่มเติม — คุณจะไม่ได้รับการแจ้งเตือนล่วงหน้า 24 ชั่วโมง",
    },
    invalid: {
      title: "ลิงก์ใช้ไม่ได้แล้ว",
      heading: "ลิงก์ยกเลิกการรับนี้ใช้ไม่ได้แล้ว",
      body: "อาจถูกใช้ไปแล้ว หรือการส่งออกข้อมูลที่เกี่ยวข้องหมดอายุแล้ว คุณสามารถจัดการการตั้งค่าอีเมลได้ตลอดเวลาจากหน้าจอความเป็นส่วนตัวในแอป",
    },
  },

  ms: {
    htmlLang: "ms",
    dir: "ltr",
    headerTag: "Perlindungan Data",
    footer: "Anda boleh menutup tetingkap ini. Jika anda ada soalan, balas e-mel yang menghantar pautan ini.",
    ok: {
      title: "Anda telah berhenti melanggan",
      heading: "Anda telah berhenti melanggan peringatan ini",
      body: "Kami tidak akan menghantar peringatan 24 jam sebelum eksport data ini tamat tempoh. Pautan muat turun anda sendiri tidak berubah — buka skrin Privasi dalam aplikasi bila-bila masa anda bersedia untuk mengambil arkib anda.",
    },
    already: {
      title: "Telah berhenti melanggan",
      heading: "Anda telah berhenti melanggan",
      body: "Anda sebelum ini meminta kami untuk tidak mengingatkan anda tentang eksport data ini. Tiada tindakan lanjut diperlukan — anda tidak akan menerima peringatan 24 jam.",
    },
    invalid: {
      title: "Pautan tidak lagi sah",
      heading: "Pautan henti langgan ini tidak lagi sah",
      body: "Ia mungkin telah digunakan, atau eksport data yang dirujuknya telah tamat tempoh. Anda boleh mengurus pilihan e-mel dari skrin Privasi dalam aplikasi pada bila-bila masa.",
    },
  },

  id: {
    htmlLang: "id",
    dir: "ltr",
    headerTag: "Perlindungan Data",
    footer: "Anda dapat menutup jendela ini. Jika ada pertanyaan, balas email tempat tautan ini berasal.",
    ok: {
      title: "Anda telah berhenti berlangganan",
      heading: "Anda telah berhenti berlangganan pengingat ini",
      body: "Kami tidak akan mengirim pemberitahuan 24 jam sebelum ekspor data ini kedaluwarsa. Tautan unduhan Anda sendiri tidak berubah — buka layar Privasi di aplikasi kapan pun Anda siap mengambil arsip Anda.",
    },
    already: {
      title: "Sudah berhenti berlangganan",
      heading: "Anda sudah berhenti berlangganan",
      body: "Anda sebelumnya telah meminta kami untuk tidak mengingatkan Anda tentang ekspor data ini. Tidak diperlukan tindakan lebih lanjut — Anda tidak akan menerima pengingat 24 jam.",
    },
    invalid: {
      title: "Tautan tidak berlaku",
      heading: "Tautan berhenti berlangganan ini tidak berlaku lagi",
      body: "Mungkin sudah digunakan, atau ekspor data yang dirujuk telah kedaluwarsa. Anda dapat mengelola preferensi email dari layar Privasi di aplikasi kapan saja.",
    },
  },

  vi: {
    htmlLang: "vi",
    dir: "ltr",
    headerTag: "Bảo vệ dữ liệu",
    footer: "Bạn có thể đóng cửa sổ này. Nếu có thắc mắc, vui lòng trả lời email mà liên kết này được gửi đến.",
    ok: {
      title: "Bạn đã hủy đăng ký",
      heading: "Bạn đã hủy đăng ký lời nhắc này",
      body: "Chúng tôi sẽ không gửi lời nhắc trước 24 giờ về việc lần xuất dữ liệu này sắp hết hạn. Liên kết tải xuống của bạn không thay đổi — hãy mở màn hình Quyền riêng tư trong ứng dụng bất cứ khi nào bạn sẵn sàng nhận tệp lưu trữ.",
    },
    already: {
      title: "Đã hủy đăng ký",
      heading: "Bạn đã hủy đăng ký từ trước",
      body: "Bạn đã từng yêu cầu chúng tôi không nhắc về lần xuất dữ liệu này. Không cần thực hiện thêm hành động nào — bạn sẽ không nhận được lời nhắc 24 giờ.",
    },
    invalid: {
      title: "Liên kết không còn hiệu lực",
      heading: "Liên kết hủy đăng ký này không còn hiệu lực",
      body: "Có thể nó đã được sử dụng, hoặc lần xuất dữ liệu liên quan đã hết hạn. Bạn có thể quản lý tùy chọn email từ màn hình Quyền riêng tư trong ứng dụng bất cứ lúc nào.",
    },
  },

  fil: {
    htmlLang: "fil",
    dir: "ltr",
    headerTag: "Proteksyon ng Data",
    footer: "Maaari mong isara ang window na ito. Kung may mga tanong, tumugon sa email kung saan galing ang link na ito.",
    ok: {
      title: "Na-unsubscribe ka na",
      heading: "Na-unsubscribe ka na sa paalalang ito",
      body: "Hindi ka na namin papadalhan ng paalala 24 na oras bago mag-expire ang data export na ito. Ang download link mismo ay hindi nagbago — buksan ang Privacy screen sa app kapag handa ka nang kunin ang iyong archive.",
    },
    already: {
      title: "Na-unsubscribe na",
      heading: "Na-unsubscribe ka na noon pa",
      body: "Hiniling mo na sa amin dati na huwag ka nang paalalahanan tungkol sa data export na ito. Hindi na kailangan ng karagdagang aksyon — hindi mo matatanggap ang 24-oras na paalala.",
    },
    invalid: {
      title: "Hindi na valid ang link",
      heading: "Hindi na valid ang unsubscribe link na ito",
      body: "Maaaring nagamit na ito, o nag-expire na ang data export na tinutukoy nito. Maaari mong pamahalaan ang mga email preferences mula sa Privacy screen sa app anumang oras.",
    },
  },

  sw: {
    htmlLang: "sw",
    dir: "ltr",
    headerTag: "Ulinzi wa Data",
    footer: "Unaweza kufunga dirisha hili. Ukiwa na maswali, jibu barua pepe ambayo kiungo hiki kilitumwa kutoka.",
    ok: {
      title: "Umejiondoa",
      heading: "Umejiondoa kwenye kikumbusho hiki",
      body: "Hatutakutumia tahadhari ya saa 24 kabla ya kuisha kwa muda wa kuhamisha data hii. Kiungo chako cha kupakua chenyewe hakijabadilika — fungua skrini ya Faragha kwenye programu wakati wowote unapokuwa tayari kuchukua kumbukumbu yako.",
    },
    already: {
      title: "Tayari umejiondoa",
      heading: "Tayari umejiondoa",
      body: "Ulituomba awali tusikukumbushe kuhusu kuhamisha data hii. Hakuna hatua nyingine inayohitajika — hutapokea kikumbusho cha saa 24.",
    },
    invalid: {
      title: "Kiungo hakitumiki tena",
      heading: "Kiungo hiki cha kujiondoa hakitumiki tena",
      body: "Huenda kimetumika tayari, au kuhamisha data inayohusu kumeisha muda. Unaweza kusimamia mapendeleo ya barua pepe kutoka kwa skrini ya Faragha katika programu wakati wowote.",
    },
  },

  af: {
    htmlLang: "af",
    dir: "ltr",
    headerTag: "Databeskerming",
    footer: "Jy kan hierdie venster sluit. As jy vrae het, antwoord die e-pos waaruit hierdie skakel gekom het.",
    ok: {
      title: "Jou intekening is gekanselleer",
      heading: "Jy is van hierdie herinnering uitgeskryf",
      body: "Ons sal nie die 24-uur-vooraf-kennisgewing oor die verstryking van hierdie data-uitvoer stuur nie. Jou aflaaiskakel self bly onveranderd — open die Privaatheidskerm in die app wanneer jy gereed is om jou argief te haal.",
    },
    already: {
      title: "Reeds uitgeskryf",
      heading: "Jy is reeds uitgeskryf",
      body: "Jy het ons reeds versoek om jou nie aan hierdie data-uitvoer te herinner nie. Geen verdere aksie nodig nie — jy sal nie die 24-uur-herinnering ontvang nie.",
    },
    invalid: {
      title: "Skakel nie meer geldig nie",
      heading: "Hierdie uitskryfskakel is nie meer geldig nie",
      body: "Dit is dalk reeds gebruik, of die data-uitvoer waarna dit verwys het, het verstryk. Jy kan e-posvoorkeure enige tyd vanaf die Privaatheidskerm in die app bestuur.",
    },
  },

  am: {
    htmlLang: "am",
    dir: "ltr",
    headerTag: "የውሂብ ጥበቃ",
    footer: "ይህን መስኮት መዝጋት ይችላሉ። ጥያቄዎች ካሉዎት፣ ይህ አገናኝ ከመጣበት ኢሜይል ምላሽ ይስጡ።",
    ok: {
      title: "ምዝገባዎ ተሰርዟል",
      heading: "ከዚህ ማስታወሻ ምዝገባዎ ተሰርዟል",
      body: "ይህ የውሂብ ወደ ውጭ መላክ ከማብቃቱ 24 ሰዓት በፊት ማስታወሻ አንልክልዎትም። የማውረጃ አገናኙ ራሱ አልተቀየረም — ማህደርዎን ለማግኘት ሲዘጋጁ በመተግበሪያው ውስጥ የግላዊነት ማያ ገጽ ይክፈቱ።",
    },
    already: {
      title: "አስቀድሞ ተሰርዟል",
      heading: "አስቀድመው ተሰርዘዋል",
      body: "ቀደም ሲል ስለዚህ የውሂብ ወደ ውጭ መላክ እንዳናስታውስዎት ጠይቀውን ነበር። ተጨማሪ እርምጃ አያስፈልግም — የ24 ሰዓት ማስታወሻ አያገኙም።",
    },
    invalid: {
      title: "አገናኙ ከእንግዲህ አይሰራም",
      heading: "ይህ የምዝገባ ሰረዝ አገናኝ ከእንግዲህ አይሰራም",
      body: "ቀደም ሲል ጥቅም ላይ ውሏል ሊሆን ይችላል፣ ወይም የተጠቀሰው የውሂብ ወደ ውጭ መላክ አብቅቷል። በማንኛውም ጊዜ ከመተግበሪያው የግላዊነት ማያ ገጽ የኢሜይል ምርጫዎችን ማስተዳደር ይችላሉ።",
    },
  },

  ha: {
    htmlLang: "ha",
    dir: "ltr",
    headerTag: "Kariyar Bayanai",
    footer: "Kuna iya rufe wannan taga. Idan kuna da tambayoyi, ku amsa wasiƙar imel da wannan hanyar haɗi ta zo daga.",
    ok: {
      title: "An cire ku daga shiga",
      heading: "An cire ku daga wannan tunatarwa",
      body: "Ba za mu aiko muku da gargaɗin sa'o'i 24 kafin wannan fitar bayanan ya ƙare ba. Hanyar haɗin saukar da kanta ba ta canza ba — buɗe allon Sirri a cikin manhajar a duk lokacin da kuke shirye don ɗaukar ajiyar ku.",
    },
    already: {
      title: "An riga an cire shiga",
      heading: "Kun riga kun cire shiga",
      body: "Kun nemi mu a baya kada mu tunatar da ku game da wannan fitar bayanai. Babu wani aiki da ake bukata — ba za ku samu tunatarwar sa'o'i 24 ba.",
    },
    invalid: {
      title: "Hanyar haɗi ba ta aiki",
      heading: "Wannan hanyar cire shiga ba ta aiki",
      body: "Wataƙila an riga an yi amfani da ita, ko kuma fitar bayanan da ta nuna ya ƙare. Kuna iya kula da abubuwan da kuka fi so na imel daga allon Sirri a cikin manhajar a kowane lokaci.",
    },
  },

  zu: {
    htmlLang: "zu",
    dir: "ltr",
    headerTag: "Ukuvikelwa Kwedatha",
    footer: "Ungalivala leli windi. Uma unemibuzo, phendula i-imeyili leli xhumano elivela kuyo.",
    ok: {
      title: "Ukhanseliwe ukubhalisa",
      heading: "Ukhanseliwe kulesi sikhumbuzo",
      body: "Ngeke sikuthumelele isexwayiso samahora angu-24 ngaphambi kokuthi lokhu kukhipha kwedatha kuphelelwe yisikhathi. Isixhumanisi sakho sokulanda asishintshanga — vula isikrini Sokuvikela ku-app noma nini lapho usukulungele ukuthatha i-archive yakho.",
    },
    already: {
      title: "Sekukhanseliwe",
      heading: "Sewukhanseliwe kakade",
      body: "Sewacela ngaphambili ukuthi singakukhumbuzi ngalokhu kukhipha kwedatha. Akudingeki esinye isenzo — ngeke uthole isikhumbuzi samahora angu-24.",
    },
    invalid: {
      title: "Isixhumanisi asisasebenzi",
      heading: "Lesi sixhumanisi sokukhansela asisasebenzi",
      body: "Singabe sasivele sasetshenziswa, noma ukukhipha kwedatha okukhomba kuye sekuphelelwe yisikhathi. Ungaphatha izintandokazi ze-imeyili kusukela kusikrini Sokuvikela ku-app noma nini.",
    },
  },

  yo: {
    htmlLang: "yo",
    dir: "ltr",
    headerTag: "Ìdáàbòbò Dátà",
    footer: "O lè ti ferese yìí. Bí o bá ní àwọn ìbéèrè, dáhùn ímeèlì tí ìjápọ̀ yìí ti wá.",
    ok: {
      title: "A ti yọ ọ́ kúrò",
      heading: "A ti yọ ọ́ kúrò nínú ìránnilétí yìí",
      body: "A kò ní fi ìṣílétí wákàtí 24 ránṣẹ́ sí ọ kí ìfagilé ìgbéjáde dátà yìí tó parí. Ìjápọ̀ ìgbàsílẹ̀ rẹ fúnra rẹ kò yipada — ṣí ojú ìbòmọlẹ̀ Aṣírí nínú ohun-èlò nígbàkigbà tí o bá ti múra láti gba àkójọ rẹ.",
    },
    already: {
      title: "A ti yọ ọ́ kúrò tẹ́lẹ̀",
      heading: "O ti yọkúrò tẹ́lẹ̀",
      body: "O ti béèrè lọ́wọ́ wa tẹ́lẹ̀ kí a má rán ọ létí nípa ìgbéjáde dátà yìí. Kò sí ìṣe mìíràn tó pọn dandan — o kò ní gba ìránnilétí wákàtí 24.",
    },
    invalid: {
      title: "Ìjápọ̀ kò tún ṣiṣẹ́",
      heading: "Ìjápọ̀ ìyọkúrò yìí kò tún ṣiṣẹ́",
      body: "Ó ṣeé ṣe kí a ti lò ó tẹ́lẹ̀, tàbí kí ìgbéjáde dátà tí ó ń tọ́ka sí ti parí. O lè ṣàkóso àwọn ààyò ímeèlì láti ojú ìbòmọlẹ̀ Aṣírí nínú ohun-èlò nígbàkigbà.",
    },
  },
};

/** Translate the unsubscribe page strings for a given language code. */
export function translateExportReminderUnsubPage(
  lang: string | null | undefined,
  state: ExportReminderUnsubState,
): ExportReminderUnsubStrings {
  const code = resolveExportReminderUnsubLang(lang);
  const pack = PACKS[code];
  const stateCopy = pack[state];
  return {
    title: stateCopy.title,
    heading: stateCopy.heading,
    body: stateCopy.body,
    footer: pack.footer,
    headerTag: pack.headerTag,
    htmlLang: pack.htmlLang,
    dir: pack.dir,
  };
}
