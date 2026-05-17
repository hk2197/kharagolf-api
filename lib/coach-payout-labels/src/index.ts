/**
 * Shared per-channel label helpers for the coach payout-paid push/SMS
 * delivery state (Task #1545). Originally inlined in `coach-admin.tsx`
 * (Task #1129), then extracted to a per-artifact `coachPayoutChannelLabels.ts`
 * (Task #1306) — kept in sync by hand across web, mobile, and the
 * `coachPayoutNotify` cron module. Hoisted here so a single source of
 * truth feeds the web admin badge, the coach earnings tabs (web + mobile),
 * and the API-server cron's per-channel attempt cap.
 *
 * Status mapping mirrors the cron's view:
 *   - `failed` + attempts >= max (or `*RetryExhaustedAt` stamped) ⇒ `exhausted`
 *   - `failed` + attempts < max ⇒ `failed` (cron will retry)
 *   - `skipped` (provider unconfigured) ⇒ `skipped`
 *   - `sent` / `no_user` / `no_address` / `opted_out` map 1:1
 *   - everything else (incl. null status before first attempt) ⇒ `pending`
 */

// Per-channel cap for a single payout-paid notification (initial attempt
// + retries). Once a channel reaches this cap the cron stops retrying it
// and `*RetryExhaustedAt` is stamped on the attempts row.
export const COACH_PAYOUT_MAX_PUSH_ATTEMPTS = 5;
export const COACH_PAYOUT_MAX_SMS_ATTEMPTS = 5;

/**
 * Task #1543 — Per-payout cooldown for the coach-side "Try again"
 * button. Mirrors `COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS` on the API
 * server and the web copy of this helper; keep all three in sync.
 */
export const COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Task #1914 — Threshold (inclusive) at which the API server pages
 * org admins because the coach is stuck on a single payout and keeps
 * pressing their own self-serve "Try again" button without any
 * delivery success. Set to 3 so the *third* coach press fires the
 * alert: the first two presses are "give the cron another shot",
 * the third is a clear signal that the underlying contact problem
 * (bad phone on file, expired push token, etc.) hasn't been fixed
 * by anyone with the access to fix it. Mirrored by both the
 * `notifyAdminsOfRepeatedCoachPayoutRetries` helper and the coach
 * UIs (web + mobile) so the dispatch threshold and the user-facing
 * "we've alerted support" copy stay in lock-step.
 */
export const COACH_PAYOUT_REPEAT_RETRY_ADMIN_THRESHOLD = 3;

/**
 * Task #1914 — Threshold (inclusive) at which the coach UIs surface
 * the "Still not getting through? Contact support" hint. Set to 2 so
 * the hint appears one press *before* the admin alert trips: this
 * gives a frustrated coach an out-of-band escape hatch (email
 * support directly) instead of mashing the button until the alert
 * fires. Kept lower than the admin threshold on purpose — the goal
 * is to deflect the third press into a support ticket rather than
 * another retry whenever possible.
 */
export const COACH_PAYOUT_REPEAT_RETRY_HINT_THRESHOLD = 2;

export type CoachPayoutChannelLabel =
  | "sent"
  | "failed"
  | "exhausted"
  | "skipped"
  | "no_user"
  | "no_address"
  | "opted_out"
  | "pending";

export interface CoachPayoutNotificationAttempt {
  id: number;
  pushStatus: string | null;
  pushAttempts: number;
  lastPushAt: string | null;
  lastPushError: string | null;
  pushRetryExhaustedAt: string | null;
  smsStatus: string | null;
  smsAttempts: number;
  lastSmsAt: string | null;
  lastSmsError: string | null;
  smsRetryExhaustedAt: string | null;
  // Task #1543 — last time the coach pressed "Try again" themselves.
  coachRetryRequestedAt: string | null;
  // Task #1914 — running count of coach-initiated "Try again" presses on
  // this stuck payout. Drives the UI "Still not getting through? Contact
  // support" hint after the second press, and the API server's admin
  // alert at the third. Defaults to 0 for legacy rows / fresh attempts.
  coachRetryCount: number;
  // Task #1544 — masked snapshot of the contact details we tried at attempt
  // time so the coach-facing earnings cell can show *which* phone / device
  // we attempted (e.g. "+91 ●●●●●● 4321", "1 expo device"). Both fields are
  // nullable: legacy rows pre-#1544 don't carry the snapshot, and a channel
  // with no recipient (`no_address` / `no_user`) has nothing to mask.
  pushTargetLabel: string | null;
  smsTargetMasked: string | null;
}

export function isCoachPayoutChannelResettable(label: CoachPayoutChannelLabel): boolean {
  return label === "failed" || label === "exhausted" || label === "skipped";
}

export function coachPayoutChannelLabel(
  status: string | null,
  attempts: number,
  exhaustedAt: string | null,
  maxAttempts: number,
): CoachPayoutChannelLabel {
  if (!status) return "pending";
  if (status === "failed") {
    if (exhaustedAt || attempts >= maxAttempts) return "exhausted";
    return "failed";
  }
  if (
    status === "sent" ||
    status === "skipped" ||
    status === "no_user" ||
    status === "no_address" ||
    status === "opted_out"
  ) {
    return status;
  }
  return "failed";
}

export function coachPayoutChannelBadgeStyle(
  label: CoachPayoutChannelLabel,
): { bg: string; fg: string } {
  switch (label) {
    case "sent": return { bg: "#1a4d2e", fg: "#86efac" };
    case "failed": return { bg: "#5a2d1a", fg: "#fca5a5" };
    case "exhausted": return { bg: "#3f1d1d", fg: "#f87171" };
    case "skipped": return { bg: "#2a2a2a", fg: "#cbd5e1" };
    case "opted_out": return { bg: "#2a2a2a", fg: "#cbd5e1" };
    case "no_user": return { bg: "#2a2a2a", fg: "#cbd5e1" };
    case "no_address": return { bg: "#2a2a2a", fg: "#cbd5e1" };
    case "pending": return { bg: "#2a2a2a", fg: "#9ca3af" };
  }
}

// Mobile artifact's existing alias — kept exported so the mobile coach
// screen can keep its `coachPayoutChannelColors(...)` call sites intact.
export const coachPayoutChannelColors = coachPayoutChannelBadgeStyle;

export function coachPayoutChannelText(label: CoachPayoutChannelLabel): string {
  switch (label) {
    case "sent": return "Sent";
    case "failed": return "Failed (will retry)";
    case "exhausted": return "Failed (gave up)";
    case "skipped": return "Skipped";
    case "opted_out": return "Opted out";
    case "no_user": return "No app user";
    case "no_address": return "No phone";
    case "pending": return "Pending";
  }
}

/**
 * "Non-sent" = neither channel actually delivered. We treat anything that
 * isn't `sent` as a non-delivery from the coach's point of view (failed,
 * exhausted, skipped, opted-out, no address, pending). Used by the
 * coach-facing earnings UI to show a single consolidated "we couldn't
 * reach you on push or SMS" inline note when both channels missed.
 */
export function coachPayoutBothChannelsNonSent(
  pushLabel: CoachPayoutChannelLabel,
  smsLabel: CoachPayoutChannelLabel,
): boolean {
  return pushLabel !== "sent" && smsLabel !== "sent";
}

/**
 * Task #1820 — Localised label for the "Earnings" tab in the coach
 * workspace UI (web + mobile). Originally only the payout-paid email
 * footer was localised (Task #1484, see `adminEmailI18n.ts`'s
 * `payoutNotify.footer`); coaches reading e.g. the Hindi or Japanese
 * email saw "कमाई (Earnings)" / "報酬（Earnings）" but the actual
 * workspace tab was a hardcoded English "Earnings" string. Hoisted
 * here so the same map feeds the email footer drift-prevention test
 * AND the workspace tab label, preventing the two from drifting
 * again.
 *
 * Each value mirrors the localised root used in the email footer
 * (`<localised> (Earnings)`), with the bare English literal kept as
 * a parenthetical pointer for the (still partially English) coach
 * workspace navigation. The Afrikaans "-blad", German "-Tab", and
 * Zulu "le-" surface forms used inside the email's running prose
 * are dropped here because the workspace tab is already a tab.
 */
export const COACH_EARNINGS_TAB_LABEL = {
  en: "Earnings",
  hi: "कमाई (Earnings)",
  ar: "الأرباح (Earnings)",
  es: "Ingresos (Earnings)",
  fr: "Revenus (Earnings)",
  de: "Einnahmen (Earnings)",
  pt: "Ganhos (Earnings)",
  ja: "報酬（Earnings）",
  ko: "수익(Earnings)",
  zh: "收益（Earnings）",
  th: "รายได้ (Earnings)",
  ms: "Pendapatan (Earnings)",
  id: "Pendapatan (Earnings)",
  vi: "Thu nhập (Earnings)",
  fil: "Kita (Earnings)",
  sw: "Mapato (Earnings)",
  af: "Verdienste (Earnings)",
  am: "ገቢ (Earnings)",
  ha: "Kuɗin Shiga (Earnings)",
  zu: "Inzuzo (Earnings)",
  yo: "Owó-Wíwọlé (Earnings)",
} as const satisfies Record<string, string>;

export type CoachEarningsTabLang = keyof typeof COACH_EARNINGS_TAB_LABEL;

/**
 * Resolve the localised tab label for the given language, falling back
 * to English for unknown / missing language codes (mirrors the
 * fallback behaviour of `getAdminEmailStrings` on the API server).
 */
export function coachEarningsTabLabel(lang: string | null | undefined): string {
  if (!lang) return COACH_EARNINGS_TAB_LABEL.en;
  return (COACH_EARNINGS_TAB_LABEL as Record<string, string>)[lang] ?? COACH_EARNINGS_TAB_LABEL.en;
}

/**
 * Task #1544 / #1920 — Localised "tried {target}" hint rendered next to
 * a non-sent push or SMS badge in the coach earnings cell (web + mobile).
 *
 * The hint surfaces the masked contact we attempted (e.g. "+91 ●●●●●● 4321"
 * or "1 expo device") so a coach who didn't see the notification can tell
 * *which* phone / device the cron tried before they fix the underlying
 * setting. The string was hard-coded English when the cell first shipped
 * (Task #1544); this table moves it next to `COACH_EARNINGS_TAB_LABEL`
 * so the same lang→label map feeds both the web and mobile cells.
 *
 * `{target}` is the literal placeholder the helper substitutes; keep the
 * English form short ("tried X") because the cell is space-constrained
 * on mobile.
 */
export const COACH_PAYOUT_TRIED_TARGET_LABEL = {
  en: "tried {target}",
  hi: "{target} पर भेजा",
  ar: "تم المحاولة إلى {target}",
  es: "intentado a {target}",
  fr: "essayé sur {target}",
  de: "versucht an {target}",
  pt: "tentado em {target}",
  ja: "{target} に送信",
  ko: "{target}로 시도",
  zh: "已尝试 {target}",
  th: "ลองส่งไป {target}",
  ms: "cuba ke {target}",
  id: "mencoba ke {target}",
  vi: "đã thử {target}",
  fil: "sinubukan sa {target}",
  sw: "imejaribiwa kwa {target}",
  af: "probeer na {target}",
  am: "ወደ {target} ሞክረናል",
  ha: "an gwada zuwa {target}",
  zu: "kuzanyiwe ku-{target}",
  yo: "gbiyanju si {target}",
} as const satisfies Record<string, string>;

/**
 * Task #1544 / #1920 — Localised "Update notification settings" link
 * label rendered inside the both-channels-missed inline note in the
 * coach earnings cell (web + mobile).
 *
 * The link deep-links to the coach's communication preferences screen so
 * a coach who missed the payout-paid push *and* SMS can fix the
 * underlying contact problem (re-enable push, update phone, etc.) in one
 * tap. Like the "tried" hint above, the label was hard-coded English
 * when the cell first shipped (Task #1544); this table hoists it into
 * the same shared lang→label map.
 */
export const COACH_PAYOUT_UPDATE_PREFS_LINK_LABEL = {
  en: "Update notification settings",
  hi: "सूचना सेटिंग्स अपडेट करें",
  ar: "تحديث إعدادات الإشعارات",
  es: "Actualizar ajustes de notificaciones",
  fr: "Mettre à jour les paramètres de notification",
  de: "Benachrichtigungseinstellungen aktualisieren",
  pt: "Atualizar configurações de notificação",
  ja: "通知設定を更新",
  ko: "알림 설정 업데이트",
  zh: "更新通知设置",
  th: "อัปเดตการตั้งค่าการแจ้งเตือน",
  ms: "Kemas kini tetapan pemberitahuan",
  id: "Perbarui pengaturan notifikasi",
  vi: "Cập nhật cài đặt thông báo",
  fil: "I-update ang mga setting ng notification",
  sw: "Sasisha mipangilio ya arifa",
  af: "Werk kennisgewing-instellings op",
  am: "የማሳወቂያ ቅንብሮችን አዘምን",
  ha: "Sabunta saitunan sanarwa",
  zu: "Buyekeza izilungiselelo zezaziso",
  yo: "Mu eto isakiyesi pada",
} as const satisfies Record<string, string>;

/**
 * Resolve the localised "tried {target}" hint, substituting `{target}`
 * with the supplied masked contact string. Falls back to the English
 * template for unknown / missing language codes (mirrors
 * `coachEarningsTabLabel`).
 */
export function coachPayoutTriedTargetLabel(
  lang: string | null | undefined,
  target: string,
): string {
  const template = lang
    ? (COACH_PAYOUT_TRIED_TARGET_LABEL as Record<string, string>)[lang]
      ?? COACH_PAYOUT_TRIED_TARGET_LABEL.en
    : COACH_PAYOUT_TRIED_TARGET_LABEL.en;
  return template.replace("{target}", target);
}

/**
 * Resolve the localised "Update notification settings" link label.
 * Falls back to English for unknown / missing language codes.
 */
export function coachPayoutUpdatePrefsLinkLabel(
  lang: string | null | undefined,
): string {
  if (!lang) return COACH_PAYOUT_UPDATE_PREFS_LINK_LABEL.en;
  return (COACH_PAYOUT_UPDATE_PREFS_LINK_LABEL as Record<string, string>)[lang]
    ?? COACH_PAYOUT_UPDATE_PREFS_LINK_LABEL.en;
}

/**
 * Task #1543 — Whether the coach-side "Try again" button should be
 * shown on a payout. Mirrors the web copy.
 */
export function coachPayoutCanCoachRetry(
  notification: CoachPayoutNotificationAttempt | null,
  now: number,
  cooldownMs: number = COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS,
): boolean {
  return coachPayoutRetryState(notification, now, cooldownMs).kind === "button";
}

/**
 * Task #1913 — Tri-state for the coach-facing "Try again" affordance:
 *   - `button`    : at least one channel is resettable AND the per-payout
 *                   cooldown has elapsed. Render the button.
 *   - `countdown` : at least one channel is resettable AND the coach
 *                   pressed "Try again" within the cooldown window.
 *                   Render a "Try again in Xm Ys" line so the coach
 *                   knows the system is still working and when the
 *                   button comes back. `remainingMs` is how much
 *                   longer the cooldown lasts.
 *   - `hidden`    : nothing to retry (both channels delivered, or no
 *                   notification row yet). Render nothing.
 *
 * The button/countdown branches are mutually exclusive so the UI never
 * shows both at the same time. `remainingMs` is only meaningful for
 * `countdown`; it is `0` for the other branches.
 */
export type CoachPayoutRetryState =
  | { kind: "hidden"; remainingMs: 0 }
  | { kind: "button"; remainingMs: 0 }
  | { kind: "countdown"; remainingMs: number };

export function coachPayoutRetryState(
  notification: CoachPayoutNotificationAttempt | null,
  now: number,
  cooldownMs: number = COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS,
): CoachPayoutRetryState {
  if (!notification) return { kind: "hidden", remainingMs: 0 };
  const pushLabel = coachPayoutChannelLabel(
    notification.pushStatus, notification.pushAttempts,
    notification.pushRetryExhaustedAt, COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  );
  const smsLabel = coachPayoutChannelLabel(
    notification.smsStatus, notification.smsAttempts,
    notification.smsRetryExhaustedAt, COACH_PAYOUT_MAX_SMS_ATTEMPTS,
  );
  if (!isCoachPayoutChannelResettable(pushLabel) && !isCoachPayoutChannelResettable(smsLabel)) {
    return { kind: "hidden", remainingMs: 0 };
  }
  if (notification.coachRetryRequestedAt) {
    const last = Date.parse(notification.coachRetryRequestedAt);
    if (Number.isFinite(last)) {
      const remaining = last + cooldownMs - now;
      if (remaining > 0) return { kind: "countdown", remainingMs: remaining };
    }
  }
  return { kind: "button", remainingMs: 0 };
}

/**
 * Task #1913 — Format a cooldown-remaining duration as a short
 * "Xm Ys" / "Ys" string for the inline countdown rendered next to
 * the (hidden) "Try again" button. Mirrors the wording in the task
 * description ("Try again in 4m 30s") so web and mobile tick in
 * lockstep.
 *
 * - Always rounds *up* to the next whole second so a freshly-pressed
 *   button shows "5m 00s" rather than briefly "4m 59s".
 * - Pads the seconds component to two digits when minutes are shown
 *   so the text width is stable and the countdown doesn't jitter
 *   between e.g. "4m 9s" and "4m 10s".
 * - Drops the minutes component below 60s so the final stretch reads
 *   "59s" → "1s" → button reappears.
 */
export function formatCoachPayoutRetryCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Task #1914 — Whether the coach UI should surface the "Still not
 * getting through? Contact support" hint on this payout. We show it
 * once the coach has hit "Try again" at least
 * `COACH_PAYOUT_REPEAT_RETRY_HINT_THRESHOLD` times AND at least one
 * channel still hasn't delivered (i.e. there's still something to be
 * stuck on). Hiding the hint when both channels have actually
 * delivered avoids a stale "contact support" prompt sticking around
 * after the cron eventually got through on a later attempt.
 */
export function coachPayoutShouldShowSupportHint(
  notification: CoachPayoutNotificationAttempt | null,
  threshold: number = COACH_PAYOUT_REPEAT_RETRY_HINT_THRESHOLD,
): boolean {
  if (!notification) return false;
  if ((notification.coachRetryCount ?? 0) < threshold) return false;
  const pushLabel = coachPayoutChannelLabel(
    notification.pushStatus, notification.pushAttempts,
    notification.pushRetryExhaustedAt, COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  );
  const smsLabel = coachPayoutChannelLabel(
    notification.smsStatus, notification.smsAttempts,
    notification.smsRetryExhaustedAt, COACH_PAYOUT_MAX_SMS_ATTEMPTS,
  );
  // If both channels delivered, the coach is no longer stuck — drop
  // the hint so it doesn't linger after the underlying problem cleared.
  if (pushLabel === "sent" && smsLabel === "sent") return false;
  return true;
}
