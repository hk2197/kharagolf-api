/**
 * Task #1317 — report a tapped native push notification to the analytics
 * pipeline so the admin dashboard's `notification_opened` event reflects
 * mobile reach, not just web/portal in-app opens.
 *
 * Called from both notification-tap entry points in `app/_layout.tsx`:
 *   • cold-start  — `Notifications.getLastNotificationResponseAsync()`
 *   • warm-start  — `Notifications.addNotificationResponseReceivedListener`
 *
 * Failure-tolerant by design: analytics MUST NOT break the deep-link tap.
 * Swallows network errors, missing tokens, missing payloads, etc.
 */
import { getApiUrl } from "@/utils/api";

const PUSH_OPENED_PATH = "/portal/notifications/push-opened";

/** Fields the API extracts as first-class context — kept in sync with the
 *  server-side allow-list in `routes/communications.ts`. */
const FORWARDED_KEYS = [
  "tournamentId", "leagueId", "payoutId", "reelId", "matchId",
  "caseId", "noticeId", "token", "deepLink",
] as const;

interface ReportPushOpenedInput {
  /** Bearer token for the portal API. When missing, the report is skipped. */
  authToken: string | null | undefined;
  /** The push `data` payload (whatever the server attached when sending). */
  data: Record<string, unknown> | undefined;
  /** Expo notification request identifier — used as a best-effort dedupe key. */
  messageId?: string | null;
}

export async function reportPushOpened(input: ReportPushOpenedInput): Promise<void> {
  if (!input.authToken) return;

  // Report every tap — even when the OS handed us a malformed / legacy
  // notification with no `data` blob. The server accepts an empty body
  // and writes a `notification_opened` row with null discriminators so
  // the dashboard reach-vs-engagement count stays accurate.
  const data: Record<string, unknown> = input.data ?? {};
  const body: Record<string, unknown> = {
    messageId: input.messageId ?? null,
    type: typeof data.type === "string" ? data.type : null,
    url: typeof data.url === "string" ? data.url : null,
  };
  if (typeof data.organizationId === "number" || typeof data.organizationId === "string") {
    body.organizationId = data.organizationId;
  }
  for (const k of FORWARDED_KEYS) {
    if (data[k] != null) body[k] = data[k];
  }

  try {
    await fetch(getApiUrl(PUSH_OPENED_PATH), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${input.authToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    /* analytics is best-effort: swallow network/JSON failures */
  }
}
