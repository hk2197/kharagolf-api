/**
 * Task #2020 — Conversion attribution helper.
 *
 * Bridges the redirect handler (which mints a click id and stamps it
 * onto the recipient as a `kg_email_click=<id>` cookie + `?ec=<id>`
 * query string) to the destination flows where conversions actually
 * happen — booking creation, tournament registration, highlight view,
 * etc.
 *
 * Destination flows call `recordEmailConversionForRequest(req,
 * "tee_booking_created")` once the meaningful action has succeeded.
 * The helper:
 *
 *   1. Pulls the click id off the request (cookie → query → body — the
 *      cookie is the source of truth on web, the query / body fields
 *      are fall-backs for cookie-less contexts and admin-on-behalf-of
 *      flows where a frontend wants to forward the id explicitly).
 *   2. Defers to `recordEmailCtaConversion` to validate the click is
 *      within the 24h attribution window and to insert idempotently.
 *   3. Always returns; never throws. Conversion attribution is
 *      observability — never block a user's booking on it.
 *
 * Splitting "extract from request" from "record conversion" keeps the
 * core recorder testable without spinning up an Express request.
 */
import type { Request } from "express";
import { recordEmailCtaConversion, type RecordConversionResult } from "./emailCtaTracking.js";
import { EMAIL_CLICK_COOKIE } from "../routes/email-cta-tracking.js";
import { logger } from "./logger.js";

/**
 * Pull the click correlation id off an incoming request. Order:
 *   1. `kg_email_click` cookie (set by the redirect handler).
 *   2. `?ec=<id>` query string (set by the redirect handler too —
 *      cookie-loss / cross-device fallback).
 *   3. `emailClickId` body field (explicit forward from a SPA that
 *      stashed the id in localStorage for an async flow).
 *
 * Returns `null` when none are present so callers can short-circuit
 * cheaply.
 */
export function getEmailClickIdFromRequest(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  const cookieVal = cookies?.[EMAIL_CLICK_COOKIE];
  if (typeof cookieVal === "string" && cookieVal.length > 0) return cookieVal;

  const queryVal = (req.query as Record<string, unknown> | undefined)?.["ec"];
  if (typeof queryVal === "string" && queryVal.length > 0) return queryVal;

  const bodyVal = (req.body as Record<string, unknown> | undefined)?.["emailClickId"];
  if (typeof bodyVal === "string" && bodyVal.length > 0) return bodyVal;

  return null;
}

export interface RecordConversionForRequestOptions {
  /** Override the user id snapshotted from the click row. */
  userId?: number | null;
}

/**
 * Best-effort: record a conversion for the email click associated
 * with this request. Returns the recorder's result so the caller can
 * log diagnostics, but never throws — destination flows should not
 * fail because attribution failed.
 *
 * Returns `{ recorded: false, reason: "unknown_click" }` when no click
 * id was found on the request (the common case — most flows are
 * organic, not email-driven).
 */
export async function recordEmailConversionForRequest(
  req: Request,
  conversionType: string,
  opts: RecordConversionForRequestOptions = {},
): Promise<RecordConversionResult> {
  const clickId = getEmailClickIdFromRequest(req);
  if (!clickId) {
    return { recorded: false, reason: "unknown_click" };
  }
  try {
    return await recordEmailCtaConversion({
      clickId,
      conversionType,
      userId: opts.userId,
    });
  } catch (err) {
    // recordEmailCtaConversion already swallows + logs internal errors,
    // but belt-and-braces here so a future refactor that throws can't
    // ever propagate into the destination flow.
    logger.warn({ conversionType, err }, "[email-cta] conversion attribution threw");
    return { recorded: false, reason: "error" };
  }
}
