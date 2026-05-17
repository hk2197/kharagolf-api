/**
 * Task #1622 + #2019 + #2020 — Email CTA click & conversion tracking routes.
 *
 *   GET /api/r/email/:token                        — public; verifies the
 *                                                    HMAC-signed token,
 *                                                    mints a click id,
 *                                                    records one row in
 *                                                    `email_cta_clicks`
 *                                                    (stamped with the
 *                                                    recipient's organisation id
 *                                                    from the token, #2019),
 *                                                    sets a 24h
 *                                                    `kg_email_click`
 *                                                    cookie + appends
 *                                                    `?ec=<clickId>` to
 *                                                    the destination URL,
 *                                                    then 302s the
 *                                                    recipient onto it.
 *   GET /api/admin/notification-cta-stats          — super-admin (or org-admin
 *                                                    scoped to their own org);
 *                                                    returns the per-key
 *                                                    click-through rate
 *                                                    report (#1622, #2019).
 *   GET /api/admin/notification-cta-stats/by-org — Task #2019 per-org
 *                                                    rollup. Super-admins see
 *                                                    every organisation;
 *                                                    org-admins are auto-scoped
 *                                                    to their own org.
 *   GET /api/admin/notification-conversion-stats   — super-admin; per-key
 *                                                    clicks → conversions
 *                                                    report (#2020).
 *
 * The redirect endpoint never throws on bad input — invalid / tampered
 * tokens render a small explanatory 400 page instead of a confusing
 * provider error, so an old or copy-pasted link still gives the user
 * something to read.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  EMAIL_CTA_CONVERSION_WINDOW_MS,
  generateClickId,
  getCtaConversionStats,
  getCtaStats,
  getCtaStatsByOrg,
  recordCtaClick,
  verifyCtaToken,
} from "../lib/emailCtaTracking.js";

const router: IRouter = Router();

/**
 * Cookie name carrying the most recent email click id back to
 * destination flows. Same-origin requests pick it up automatically;
 * cross-device hops fall back to the `?ec=` query string the redirect
 * also appends. Exported so the conversion attribution helper and tests
 * stay in sync without duplicating the literal.
 */
export const EMAIL_CLICK_COOKIE = "kg_email_click";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Append `?ec=<clickId>` (or `&ec=…` when there's already a query
 * string) to the destination URL. The cookie covers same-origin
 * subsequent requests; the query param is the cross-origin / cookie-
 * cleared fallback. We avoid using the WHATWG `URL` setter for the
 * search string because some odd legacy CTAs include a hash that we
 * want to preserve verbatim — easier to splice manually than to round-
 * trip through the parser.
 *
 * Falls back to the unmodified URL if it can't be parsed (the redirect
 * itself has already validated it's an http(s) URL via `verifyCtaToken`,
 * so this is just defence-in-depth).
 */
function appendClickIdQuery(originalUrl: string, clickId: string): string {
  try {
    const u = new URL(originalUrl);
    u.searchParams.set("ec", clickId);
    return u.toString();
  } catch {
    return originalUrl;
  }
}
router.get("/r/email/:token", async (req: Request, res: Response) => {
  const payload = verifyCtaToken((req.params as Record<string, string>).token);
  if (!payload) {
    res.status(400).type("html").send(
      `<!doctype html><meta charset="utf-8"><title>Invalid link</title>` +
      `<body style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#fff;padding:48px 24px;text-align:center;">` +
      `<h1 style="margin:0 0 12px;">This link is no longer valid.</h1>` +
      `<p style="color:#9ca3af;">It may have been copied incorrectly or the email it came from is too old. Open KHARAGOLF directly to continue.</p>` +
      `</body>`,
    );
    return;
  }
  // Mint a fresh correlation id per click. Conversions completed in
  // the same browser within `EMAIL_CTA_CONVERSION_WINDOW_MS` will be
  // attributed back to this click via cookie or `?ec=` query lookup.
  const clickId = generateClickId();
  // Record the click before redirecting. `recordCtaClick` swallows its
  // own errors so a flaky DB never blocks the user's redirect.
  await recordCtaClick({
    notificationKey: payload.k,
    userId: payload.u,
    // Task #2019 — `o` is optional in the token (pre-2019 emails don't
    // carry it); `verifyCtaToken` normalises both `undefined` and
    // missing-from-payload to `null` here so the click row is stamped
    // as "unaffiliated" rather than dropped.
    organizationId: payload.o ?? null,
    originalUrl: payload.url,
    ipAddress: req.ip ?? null,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    clickId,
  });
  // Same-origin (HttpOnly so client JS can't tamper, SameSite=Lax so
  // it travels on the redirect-then-navigate that follows). `secure`
  // only outside dev so cookies on http://localhost still work for the
  // local feedback loop.
  res.cookie(EMAIL_CLICK_COOKIE, clickId, {
    maxAge: EMAIL_CTA_CONVERSION_WINDOW_MS,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
  });
  // 302 (not 301) so caches don't pin the redirect — that would prevent
  // future click counts from incrementing if the user hits the same
  // URL again from their inbox.
  res.redirect(302, appendClickIdQuery(payload.url, clickId));
});

/**
 * Parse + validate `?sinceDays=N`. Returns `{ since, sinceDaysParam }`
 * where `since` is `undefined` for "no window" and `sinceDaysParam` is
 * the parsed numeric value (or `null`) so it can be echoed back in the
 * response without re-parsing.
 *
 * Returns `null` (and writes a 400) when the input is malformed —
 * caller should `return` immediately.
 */
function parseSinceDays(req: Request, res: Response): { since: Date | undefined; sinceDaysParam: number | null } | null {
  const sinceDaysRaw = req.query["sinceDays"];
  if (typeof sinceDaysRaw !== "string" || sinceDaysRaw.length === 0) {
    return { since: undefined, sinceDaysParam: null };
  }
  const n = Number(sinceDaysRaw);
  if (!Number.isFinite(n) || n <= 0 || n > 3650) {
    res.status(400).json({ error: "sinceDays must be a positive number ≤ 3650" });
    return null;
  }
  return { since: new Date(Date.now() - n * 24 * 60 * 60 * 1000), sinceDaysParam: n };
}

/**
 * Resolve the effective `organizationId` filter for a CTR report:
 *
 *   - super_admin: honours `?organizationId=N` when supplied (use the
 *     literal string `"null"` to opt into the unaffiliated-only
 *     bucket); when omitted, returns `undefined` to mean "no filter,
 *     aggregate across every org".
 *   - org_admin:   ALWAYS scoped to the caller's own organisation.
 *     A query-string override is silently ignored — we don't 403 on it
 *     because that would leak the existence/non-existence of other
 *     orgs' filters; we just refuse to honour anything except the
 *     caller's own org.
 *   - other roles: not allowed at all (caller already enforces that).
 *
 * Returns `null` (and writes the relevant error response) when the
 * caller is unauthenticated / unauthorised / passed a malformed value.
 */
function resolveOrgFilter(
  req: Request,
  res: Response,
): { hasFilter: boolean; organizationId: number | null } | null {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return null;
  }
  const user = req.user as { role?: string; organizationId?: number | null } | undefined;
  const role = user?.role;
  if (role === "super_admin") {
    const raw = req.query["organizationId"];
    if (typeof raw !== "string" || raw.length === 0) {
      return { hasFilter: false, organizationId: null };
    }
    if (raw === "null") {
      // Explicit opt-in to the unaffiliated bucket only.
      return { hasFilter: true, organizationId: null };
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      res.status(400).json({ error: "organizationId must be a positive integer or 'null'" });
      return null;
    }
    return { hasFilter: true, organizationId: n };
  }
  if (role === "org_admin") {
    const orgId = user?.organizationId ?? null;
    if (orgId == null) {
      // An org_admin without an organizationId attached can't see
      // anything meaningful; refuse rather than silently returning the
      // unaffiliated-only bucket (which would be misleading).
      res.status(403).json({ error: "Org admin is not attached to an organisation." });
      return null;
    }
    return { hasFilter: true, organizationId: orgId };
  }
  res.status(403).json({ error: "Admin access required." });
  return null;
}

/**
 * Admin CTR report. Returns one row per `notificationKey` with at least
 * one send or one click; `clickThroughRate` is `null` for keys with no
 * sends (avoids division-by-zero / misleading 0% buckets).
 *
 * Optional `?sinceDays=N` restricts the click count and `lastClickAt`
 * to the trailing N days. Send counts remain the running total — see
 * the caveat in `getCtaStats`'s docstring.
 *
 * Task #2019 — Now also accepts an optional `?organizationId=N` filter
 * (`null` to opt into the unaffiliated bucket only). Org admins are
 * auto-scoped to their own organisation regardless of the query
 * parameter, so the same endpoint serves both audiences.
 */
router.get("/admin/notification-cta-stats", async (req: Request, res: Response) => {
  const orgFilter = resolveOrgFilter(req, res);
  if (!orgFilter) return;
  const sinceParsed = parseSinceDays(req, res);
  if (!sinceParsed) return;
  const opts: { since?: Date; organizationId?: number | null } = {};
  if (sinceParsed.since) opts.since = sinceParsed.since;
  if (orgFilter.hasFilter) opts.organizationId = orgFilter.organizationId;
  const rows = await getCtaStats(opts);
  res.json({
    sinceDays: sinceParsed.sinceDaysParam,
    organizationId: orgFilter.hasFilter ? orgFilter.organizationId : null,
    rows,
  });
});

/**
 * Task #2019 — Per-(org, key) CTR rollup.
 *
 * Returns one row per (organisation, notification_key) with at least
 * one send or click; `organizationId: null` rows are the
 * "unaffiliated" bucket (recipients with no organisation OR
 * pre-Task-#2019 historical sends that were never tagged).
 *
 * Authorisation:
 *   - super_admin: sees every organisation. Optional
 *     `?organizationId=N` (or `?organizationId=null`) narrows the
 *     report to a single bucket.
 *   - org_admin:   ALWAYS scoped server-side to the caller's own
 *     organisation, regardless of any query string the client sends.
 */
router.get("/admin/notification-cta-stats/by-org", async (req: Request, res: Response) => {
  const orgFilter = resolveOrgFilter(req, res);
  if (!orgFilter) return;
  const sinceParsed = parseSinceDays(req, res);
  if (!sinceParsed) return;
  const opts: { since?: Date; organizationId?: number | null } = {};
  if (sinceParsed.since) opts.since = sinceParsed.since;
  if (orgFilter.hasFilter) opts.organizationId = orgFilter.organizationId;
  const rows = await getCtaStatsByOrg(opts);
  res.json({
    sinceDays: sinceParsed.sinceDaysParam,
    organizationId: orgFilter.hasFilter ? orgFilter.organizationId : null,
    rows,
  });
});

router.get("/admin/notification-conversion-stats", async (req: Request, res: Response) => {
  const orgFilter = resolveOrgFilter(req, res);
  if (!orgFilter) return;
  const sinceParsed = parseSinceDays(req, res);
  if (!sinceParsed) return;
  const opts: { since?: Date; organizationId?: number | null } = {};
  if (sinceParsed.since) opts.since = sinceParsed.since;
  if (orgFilter.hasFilter) opts.organizationId = orgFilter.organizationId;
  const rows = await getCtaConversionStats(opts);
  res.json({
    sinceDays: sinceParsed.sinceDaysParam,
    organizationId: orgFilter.hasFilter ? orgFilter.organizationId : null,
    attributionWindowMs: EMAIL_CTA_CONVERSION_WINDOW_MS,
    rows,
  });
});

export default router;
