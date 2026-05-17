/**
 * Analytics event contract — Wave 0 / Task #935.
 *
 * `track(eventName, payload, ctx?)` is the single helper every feature should
 * call to record a structured analytics event. Two things happen:
 *
 *   1. The event is persisted to the `analytics_events` table (org-scoped)
 *      so we never lose data even when the upstream sink is down.
 *   2. If `POSTHOG_API_KEY` is configured, the event is forwarded to PostHog
 *      via their capture endpoint. Forwarding failures are logged but never
 *      throw — analytics must never break a user-facing flow.
 *
 * Five high-traffic flows are instrumented as the smoke test (see callers):
 *   - player_login
 *   - tee_booking_created
 *   - tournament_registration
 *   - scorecard_submitted
 *   - payment_settled
 */
import { db } from "@workspace/db";
import { analyticsEventsTable } from "@workspace/db";
import { logger } from "./logger";

export interface AnalyticsContext {
  organizationId?: number | null;
  userId?: number | null;
  /** Source surface — useful for funnel analysis. */
  surface?: "web" | "mobile" | "watch" | "api" | "system";
  /** Optional request id for correlating with HTTP logs. */
  requestId?: string;
}

export type AnalyticsPayload = Record<string, unknown>;

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY ?? "";
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://app.posthog.com";

async function forwardToPostHog(
  eventName: string,
  payload: AnalyticsPayload,
  ctx: AnalyticsContext,
): Promise<void> {
  if (!POSTHOG_API_KEY) return;
  try {
    const resp = await fetch(`${POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_API_KEY,
        event: eventName,
        distinct_id: ctx.userId != null ? `user_${ctx.userId}` : "anonymous",
        properties: {
          ...payload,
          $organization_id: ctx.organizationId ?? null,
          $surface: ctx.surface ?? "api",
          $request_id: ctx.requestId,
        },
        timestamp: new Date().toISOString(),
      }),
    });
    if (!resp.ok) {
      logger.debug({ status: resp.status, eventName }, "[analytics] posthog forward non-2xx (ignored)");
    }
  } catch (err) {
    logger.debug({ err, eventName }, "[analytics] posthog forward failed (ignored)");
  }
}

/**
 * Emit an analytics event. Always non-throwing — analytics MUST NOT break
 * the surrounding business flow.
 */
export async function track(
  eventName: string,
  payload: AnalyticsPayload = {},
  ctx: AnalyticsContext = {},
): Promise<void> {
  // Persist first so we have the durable record even if PostHog forwarding
  // fails or hasn't been configured yet.
  try {
    await db.insert(analyticsEventsTable).values({
      eventName,
      organizationId: ctx.organizationId ?? null,
      userId: ctx.userId ?? null,
      surface: ctx.surface ?? "api",
      payload,
      requestId: ctx.requestId ?? null,
    });
  } catch (err) {
    // Never throw — log and move on.
    logger.warn({ err, eventName }, "[analytics] persist failed (event dropped)");
  }
  // Fire-and-forget forward. Don't await on the request-critical path; spawn
  // and let it complete in the background.
  void forwardToPostHog(eventName, payload, ctx);
}
