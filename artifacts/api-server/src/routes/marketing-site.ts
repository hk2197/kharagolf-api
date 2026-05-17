/**
 * Task #369 — Per-club marketing site builder.
 *
 * Admin routes (mounted at /api/organizations/:orgId/marketing-site):
 *   GET    /                — fetch this club's marketing site config
 *                              (auto-creates a default row on first read)
 *   PUT    /                — partial update
 *   POST   /publish         — publish (sets isPublished + publishedAt + bumps cache)
 *   POST   /unpublish       — unpublish (hides the public site)
 *
 * Public routes (mounted at /api/public):
 *   GET    /clubs/:slug/site  — site config + auto-rolled in tournaments,
 *                                merchandise, etc. for the slug. Returns 404
 *                                if club is missing or site is not published.
 *   GET    /sitemap.xml       — sitemap of every published club site.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac } from "crypto";
import { db } from "@workspace/db";
import { ObjectStorageService } from "../lib/objectStorage";
import { rehostExternalImageBytes, getMarketingCacheUsage } from "../lib/marketingImageCache";
import {
  clubMarketingSitesTable,
  clubMarketingSiteImagesTable,
  organizationsTable,
  tournamentsTable,
  coursesTable,
  holeDetailsTable,
  mediaTable,
  courseReviewsTable,
  courseReviewReportsTable,
  appUsersTable,
} from "@workspace/db";
import { and, eq, desc, asc, inArray, gte, sql, avg, count } from "drizzle-orm";
import {
  issueMarketingPreviewToken,
  verifyMarketingPreviewToken,
  MARKETING_PREVIEW_TOKEN_TTL_MS,
} from "../lib/marketing-preview-token";
import { gateFeature } from "../lib/featureGate";
import { notifyCourseReviewReplyPosted } from "../lib/courseReviewReplyNotify";
import { isPrivateAddress } from "../lib/privateAddressGuard";
import {
  verifyExternalImageUrl,
  MARKETING_LOGO_FAVICON_MAX_BYTES,
} from "../lib/externalImageVerifier";
import {
  enforceRateLimit,
  getClientIp,
  photoUploadUrlScopes,
  photoSubmitScopes,
  reviewSubmitScopes,
  reviewReportScopes,
} from "../lib/publicRateLimit";

const router: IRouter = Router({ mergeParams: true });
const publicRouter: IRouter = Router();
const storage = new ObjectStorageService();

const SECTION_IDS = ["hero","about","tournaments","lessons","tee_times","fb","gallery","services","contact"] as const;
const VALID_THEMES = new Set(["classic", "modern", "minimal", "bold"]);

// Task #584 — Brand override validation. Colors are #RGB or #RRGGBB hex.
// Heading fonts are restricted to a small allow-list of CSS font-family
// stacks so we don't accept arbitrary attacker-controlled CSS.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const VALID_HEADING_FONTS = new Set([
  "Inter, system-ui, sans-serif",
  "Georgia, 'Times New Roman', serif",
  "'Playfair Display', Georgia, serif",
  "Montserrat, system-ui, sans-serif",
  "'Roboto Slab', Georgia, serif",
  "'Bebas Neue', Impact, sans-serif",
  "'Courier New', monospace",
]);

const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  // Task #666 — favicons are commonly uploaded as .ico files.
  "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml",
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

function getUploadHmacSecret(): string {
  const secret = process.env["PRIVATE_OBJECT_DIR"];
  if (!secret) throw new Error("PRIVATE_OBJECT_DIR env var is required for upload token signing");
  return secret;
}
function signUploadPath(objectPath: string): string {
  return createHmac("sha256", getUploadHmacSecret()).update(objectPath).digest("hex");
}
function verifyUploadToken(objectPath: string, token: string): boolean {
  try { return signUploadPath(objectPath) === token; } catch { return false; }
}

/**
 * Task #948 — Validate a marketing-site logo/favicon URL value.
 *
 * Accepts:
 *   - null or "" → reset to NULL.
 *   - http(s) URL → must parse, use http: or https:, and the remote
 *     host must serve a real image (Task #1089). The verified bytes
 *     are then rehosted into our own object storage (Task #1250) and
 *     the persisted value becomes the internal `/api/storage/...` URL
 *     so the public mini-site never depends on the third-party host.
 *     The original external URL is returned as `sourceUrl` so the
 *     route can persist it alongside the cached one — the periodic
 *     refresh job (Task #1467) reads `*SourceUrl` to know what to
 *     re-fetch.
 *   - Internal /objects/<entityId> path → must reference a real stored
 *     object whose content-type is in the image allow-list and whose
 *     size is within the marketing logo/favicon size cap (Task #1468).
 *     Internal paths have no upstream so `sourceUrl` is null.
 *
 * Task #1468 — Logos and favicons get a tighter 1 MB cap (rather than
 * the 10 MB cap direct gallery / hero uploads use) so a malicious
 * admin can't point us at a 9 MB image and burn organization storage
 * quota when we rehost the bytes. The cap applies to both the
 * /objects/... branch (already-uploaded asset) and the external-URL
 * branch (verifier streams the bytes for rehosting).
 */
async function validateMarketingImageUrl(
  value: unknown,
  opts: { orgId: number; kind: "logo" | "favicon" },
): Promise<
  | { ok: true; value: string | null; sourceUrl: string | null }
  | { ok: false; error: string }
> {
  if (value === null || value === "") return { ok: true, value: null, sourceUrl: null };
  if (typeof value !== "string") {
    return { ok: false, error: "must be a string URL" };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null, sourceUrl: null };

  if (trimmed.startsWith("/objects/")) {
    try {
      const objFile = await storage.getObjectEntityFile(trimmed);
      const [meta] = await objFile.getMetadata();
      const ct = ((meta.contentType as string) || "").trim().toLowerCase();
      const size = meta.size ? Number(meta.size) : 0;
      if (size > MARKETING_LOGO_FAVICON_MAX_BYTES) {
        return {
          ok: false,
          error:
            "image exceeds the 1 MB maximum size for marketing logos and favicons. " +
            "Please re-export at a smaller resolution.",
        };
      }
      if (!ct || !ALLOWED_IMAGE_CONTENT_TYPES.has(ct)) {
        return {
          ok: false,
          error: "unsupported image type. Allowed: JPEG, PNG, GIF, WebP, SVG, ICO",
        };
      }
      return { ok: true, value: trimmed, sourceUrl: null };
    } catch {
      return { ok: false, error: "uploaded object not found" };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: "must be a valid http(s) URL or an /objects/... path",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "must use http:// or https://" };
  }
  // Task #1089 — Confirm the external host is reachable and is
  // actually serving an image (status 2xx, image content-type) before
  // we let an admin save the URL. Otherwise a typo or a host that goes
  // away later silently breaks the public mini-site for every visitor.
  // Task #1468 — Pass the tightened 1 MB cap so the verifier aborts
  // the download (and the rehoster never sees the bytes) for anything
  // larger than a sane logo / favicon.
  const reachable = await verifyExternalImageUrl(trimmed, {
    maxBytes: MARKETING_LOGO_FAVICON_MAX_BYTES,
  });
  if (!reachable.ok) {
    return { ok: false, error: reachable.error };
  }
  // Task #1250 — When the verifier captured the bytes (production
  // path), rehost them into our own object storage and persist that
  // internal URL so the public mini-site never has to fetch from the
  // third-party host again. Test stubs that only signal `{ok: true}`
  // without bytes fall through and persist the original URL — the
  // existing test suite (which uses fake `https://cdn.example.com/...`
  // URLs and never touches GCS) keeps working unchanged.
  if (reachable.buffer && reachable.contentType) {
    const cached = await rehostExternalImageBytes(
      reachable.buffer,
      reachable.contentType.toLowerCase(),
      { orgId: opts.orgId, kind: opts.kind, storage },
    );
    if (!cached.ok) return { ok: false, error: cached.error };
    // Task #1467 — Persist the original external URL alongside the
    // cached one so the periodic refresh job knows what to re-fetch
    // when the source image changes upstream.
    return { ok: true, value: cached.url, sourceUrl: trimmed };
  }
  return { ok: true, value: trimmed, sourceUrl: trimmed };
}

function getUser(req: Request) {
  return req.user as { id: number; organizationId?: number; role?: string } | undefined;
}

function requireSiteAdmin(req: Request, res: Response): boolean {
  const u = getUser(req);
  if (!u) { res.status(401).json({ error: "Unauthorized" }); return false; }
  const ok = ["super_admin", "org_admin", "tournament_director"].includes(u.role ?? "");
  if (!ok) { res.status(403).json({ error: "Forbidden" }); return false; }
  if (u.role !== "super_admin" && u.organizationId !== parseInt(String((req.params as Record<string, string>).orgId))) {
    res.status(403).json({ error: "Forbidden: org mismatch" });
    return false;
  }
  return true;
}

async function getOrCreateSite(orgId: number) {
  const existing = await db.query.clubMarketingSitesTable.findFirst({
    where: eq(clubMarketingSitesTable.organizationId, orgId),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(clubMarketingSitesTable)
    .values({ organizationId: orgId })
    .returning();
  return created;
}

/* ── Admin ────────────────────────────────────────────────────────── */

router.get("/", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const site = await getOrCreateSite(orgId);
  // Task #1799 — Surface how much storage this org's cached marketing
  // logos / favicons currently occupy under marketing-cache/<orgId>/
  // so admins can see (e.g. as a "X KB used" hint in the UI) when
  // re-saves of the same external URL keep accumulating slightly
  // different bytes (e.g. a CDN re-encodes between fetches).
  const marketingCacheUsage = await getMarketingCacheUsage(orgId, storage);
  res.json({ ...site, marketingCacheUsage });
});

router.put("/", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  await getOrCreateSite(orgId); // ensure row exists

  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};

  if (b.theme !== undefined) {
    if (!VALID_THEMES.has(b.theme)) { { res.status(400).json({ error: `theme must be one of ${[...VALID_THEMES].join(", ")}` }); return; } }
    patch.theme = b.theme;
  }
  for (const k of [
    "heroImageUrl", "heroTitle", "heroSubtitle", "heroCtaLabel", "heroCtaHref",
    "aboutMarkdown", "servicesMarkdown",
    "seoTitle", "seoDescription", "seoOgImageUrl",
  ]) {
    if (b[k] !== undefined) patch[k] = b[k] === "" ? null : b[k];
  }

  // Task #948 — Validate marketing logo + favicon overrides (Task #666).
  // Accept http(s) URLs or our internal /objects/... entity paths. For
  // internal objects, verify the stored content-type is in the image
  // allow-list and that the size is within the 10 MB cap (matching the
  // limit enforced for direct uploads). Rejects bad values with 400 so
  // a typo or hostile paste can't silently break the public site or
  // push a giant download to every visitor's tab via the favicon.
  for (const k of ["logoImageUrl", "faviconUrl"] as const) {
    if (b[k] === undefined) continue;
    const result = await validateMarketingImageUrl(b[k], {
      orgId,
      kind: k === "logoImageUrl" ? "logo" : "favicon",
    });
    if (!result.ok) {
      res.status(400).json({ error: `${k}: ${result.error}` });
      return;
    }
    patch[k] = result.value;
    // Task #1249 — Saving a new URL through the editor must reset the
    // background-recheck tracking. Otherwise an admin who pastes a
    // working replacement after we auto-cleared (or while a counter
    // was mid-climb) would keep their old failure count + last-error
    // and could be auto-cleared again on the very next sweep with
    // stale state.
    //
    // Task #1467 — Also persist the original external URL alongside
    // the cached one so the periodic refresh job knows what to
    // re-fetch, and reset the per-source refresh tracking so a fresh
    // URL starts from a clean slate (no stale "last refresh failed"
    // line on the editor or in the on-call digest).
    if (k === "logoImageUrl") {
      patch.logoImageUrlConsecutiveFailures = 0;
      patch.logoImageUrlLastError = null;
      patch.logoImageUrlLastCheckedAt = null;
      patch.logoSourceUrl = result.sourceUrl;
      patch.logoSourceLastRefreshedAt = null;
      patch.logoSourceLastRefreshError = null;
      // Task #2259 — Re-arm the per-source consecutive-refresh-failure
      // counter so a freshly pasted URL starts from a clean streak.
      patch.logoSourceConsecutiveRefreshFailures = 0;
    } else {
      patch.faviconUrlConsecutiveFailures = 0;
      patch.faviconUrlLastError = null;
      patch.faviconUrlLastCheckedAt = null;
      patch.faviconSourceUrl = result.sourceUrl;
      patch.faviconSourceLastRefreshedAt = null;
      patch.faviconSourceLastRefreshError = null;
      // Task #2259 — Same as above for the favicon source URL.
      patch.faviconSourceConsecutiveRefreshFailures = 0;

    }
  }

  // Task #584 — Per-site brand overrides. null/empty resets back to the
  // theme default; otherwise validate hex colors and the font allow-list.
  for (const k of ["brandPrimaryColor", "brandAccentColor"] as const) {
    if (b[k] !== undefined) {
      if (b[k] === null || b[k] === "") {
        patch[k] = null;
      } else if (typeof b[k] === "string" && HEX_COLOR_RE.test(b[k])) {
        patch[k] = b[k];
      } else {
        res.status(400).json({ error: `${k} must be a #RRGGBB hex color or null` });
        return;
      }
    }
  }
  if (b.brandHeadingFont !== undefined) {
    if (b.brandHeadingFont === null || b.brandHeadingFont === "") {
      patch.brandHeadingFont = null;
    } else if (typeof b.brandHeadingFont === "string" && VALID_HEADING_FONTS.has(b.brandHeadingFont)) {
      patch.brandHeadingFont = b.brandHeadingFont;
    } else {
      res.status(400).json({ error: "brandHeadingFont must be one of the allowed font stacks or null" });
      return;
    }
  }

  if (b.galleryImages !== undefined) {
    if (!Array.isArray(b.galleryImages)) { { res.status(400).json({ error: "galleryImages must be an array" }); return; } }
    patch.galleryImages = b.galleryImages
      .filter((g: unknown): g is { url: string; caption?: string | null } =>
        typeof g === "object" && g !== null && typeof (g as { url?: unknown }).url === "string")
      .map((g: { url: string; caption?: string | null }) => ({ url: g.url, caption: g.caption ?? null }));
  }

  if (b.sectionOrder !== undefined) {
    if (!Array.isArray(b.sectionOrder)) { { res.status(400).json({ error: "sectionOrder must be an array" }); return; } }
    patch.sectionOrder = b.sectionOrder.filter((s: unknown): s is string => typeof s === "string" && (SECTION_IDS as readonly string[]).includes(s));
  }

  if (b.enabledSections !== undefined) {
    if (typeof b.enabledSections !== "object" || b.enabledSections === null) {
      res.status(400).json({ error: "enabledSections must be an object" }); return;
    }
    const cleaned: Record<string, boolean> = {};
    for (const id of SECTION_IDS) {
      if (id in b.enabledSections) cleaned[id] = !!b.enabledSections[id];
    }
    patch.enabledSections = cleaned;
  }

  patch.updatedAt = new Date();
  patch.cacheVersion = sql`${clubMarketingSitesTable.cacheVersion} + 1`;

  const [updated] = await db
    .update(clubMarketingSitesTable)
    .set(patch)
    .where(eq(clubMarketingSitesTable.organizationId, orgId))
    .returning();

  // Task #792 — Bust the prerendered club-page cache so admins (and the
  // search engines that hit the page next) see the updated content
  // immediately instead of waiting for the short TTL.
  lookupOrgSlug(orgId)
    .then(slug => slug ? purgeMarketingSiteClubCache(slug) : undefined)
    .catch(err => console.warn("[ssr-cache] club purge dispatch failed", { orgId, err: (err as Error).message }));

  // Task #1799 — Saving a logo / favicon may have just rehosted new
  // bytes into marketing-cache/<orgId>/, so include the refreshed
  // usage in the PUT response (same shape as GET) so the admin UI
  // can update the "X KB used" hint without an extra round-trip.
  const marketingCacheUsage = await getMarketingCacheUsage(orgId, storage);
  res.json({ ...updated, marketingCacheUsage });
});

/**
 * Task #580 — Validate, normalise and persist a club's vanity hostname.
 *
 * Accepts either a bare hostname ("golf.yourclub.com") or a pasted URL
 * ("https://golf.yourclub.com/"). We strip protocol, path and port,
 * lowercase the result, then validate each label against the RFC 1123
 * subset (alphanumeric + hyphen, no leading/trailing hyphen, ≤63 chars).
 * Returns null if the input cannot be coerced to a valid hostname.
 */
function normalizeAndValidateHostname(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (cleaned.length === 0 || cleaned.length > 253) return null;
  const labels = cleaned.split(".");
  if (labels.length < 2) return null;
  const labelRe = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  for (const l of labels) {
    if (!labelRe.test(l)) return null;
  }
  // Reject pure-numeric TLD (so "1.2.3.4" doesn't slip through).
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return cleaned;
}

/**
 * Task #580 — Org admins can set/clear their club's custom vanity domain
 * from the marketing-site admin section. Gated behind the `customDomain`
 * plan flag (Enterprise tier or per-org override). Validates hostname
 * syntax, normalises to lowercase, prevents collisions across orgs, and
 * bumps the marketing-site cache version so the live mini-site reflects
 * the new canonical URL on the next request.
 *
 * Body: { customDomain: string | null }   (empty/null clears the value)
 * Returns: { customDomain: string | null }
 */
router.patch("/custom-domain", gateFeature("customDomain"), async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const raw = (req.body ?? {}).customDomain;
  let nextDomain: string | null = null;
  if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
    const normalized = normalizeAndValidateHostname(raw);
    if (!normalized) {
      res.status(400).json({
        error: "Enter a valid hostname like golf.yourclub.com (no protocol, no path).",
      });
      return;
    }
    // Uniqueness check — case-insensitive, ignore self.
    const existing = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(and(
        sql`lower(${organizationsTable.customDomain}) = ${normalized}`,
        sql`${organizationsTable.id} <> ${orgId}`,
      ));
    if (existing.length > 0) {
      res.status(409).json({
        error: "That domain is already assigned to another club.",
      });
      return;
    }
    nextDomain = normalized;
  }

  const [org] = await db
    .update(organizationsTable)
    .set({ customDomain: nextDomain, updatedAt: new Date() })
    .where(eq(organizationsTable.id, orgId))
    .returning({ customDomain: organizationsTable.customDomain });
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  // Bump the marketing-site cache so the public mini-site picks up the
  // new canonical URL on its next ETag check (Task #438 routing).
  await getOrCreateSite(orgId);
  await db
    .update(clubMarketingSitesTable)
    .set({
      cacheVersion: sql`${clubMarketingSitesTable.cacheVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(clubMarketingSitesTable.organizationId, orgId));

  // Task #792 — Custom-domain change alters the canonical URL emitted by
  // the prerendered head, so bust the cache.
  lookupOrgSlug(orgId)
    .then(slug => slug ? purgeMarketingSiteClubCache(slug) : undefined)
    .catch(err => console.warn("[ssr-cache] club purge dispatch failed", { orgId, err: (err as Error).message }));

  res.json({ customDomain: org.customDomain });
});

/**
 * Task #662 — On-demand verification that the saved custom domain is
 * actually live: DNS resolves to our ingress target, and an HTTPS request
 * to the mini-site host returns *this* club's marketing payload.
 *
 * Returns one of:
 *   - "none"        — no domain configured (UI hides the badge)
 *   - "pending_dns" — hostname has no resolvable records yet
 *   - "mismatch"    — DNS resolves or HTTPS responds, but to the wrong target / club
 *   - "unreachable" — DNS resolves, but HTTPS fetch failed (cert pending, timeout, …)
 *   - "live"        — DNS + HTTPS both check out and the served site is ours
 *
 * The expected CNAME target is configurable via CUSTOM_DOMAIN_CNAME_TARGET
 * to match whatever the deployment ingress publishes (defaults to the same
 * value documented in the admin UI: "proxy.kharagolf.app"). Each branch
 * returns a human-readable `message` that the admin panel surfaces verbatim
 * with next-step guidance.
 */
router.post("/verify-domain", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const [org] = await db
    .select({
      id: organizationsTable.id,
      slug: organizationsTable.slug,
      customDomain: organizationsTable.customDomain,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  const checkedAt = new Date().toISOString();
  const host = (org.customDomain ?? "").trim().toLowerCase();
  if (!host) {
    res.json({
      status: "none",
      customDomain: null,
      expectedTarget: null,
      dns: null,
      https: null,
      message: null,
      checkedAt,
    });
    return;
  }

  const expectedTarget = (
    process.env.CUSTOM_DOMAIN_CNAME_TARGET ?? "proxy.kharagolf.app"
  ).toLowerCase().replace(/\.$/, "");

  // ── 1. DNS lookup (CNAME first, fall back to A records) ─────────────
  const dnsModule = await import("dns/promises");
  let dnsRecords: string[] = [];
  let dnsRecordType: "CNAME" | "A" | null = null;
  let dnsError: string | null = null;
  try {
    try {
      const cnames = await dnsModule.resolveCname(host);
      if (cnames.length > 0) {
        dnsRecords = cnames.map(c => c.toLowerCase().replace(/\.$/, ""));
        dnsRecordType = "CNAME";
      }
    } catch { /* fall through to A lookup */ }
    if (dnsRecords.length === 0) {
      try {
        const a = await dnsModule.resolve4(host);
        if (a.length > 0) {
          dnsRecords = a;
          dnsRecordType = "A";
        }
      } catch { /* keep empty */ }
    }
  } catch (e) {
    dnsError = e instanceof Error ? e.message : String(e);
  }

  if (dnsRecords.length === 0) {
    res.json({
      status: "pending_dns",
      customDomain: host,
      expectedTarget,
      dns: { records: [], recordType: null, matched: null, error: dnsError ?? "No DNS records found." },
      https: null,
      message:
        `We couldn't find any DNS records for ${host} yet. Add a CNAME at your ` +
        `domain registrar pointing ${host} to ${expectedTarget}. DNS changes can ` +
        `take up to 48 hours to propagate.`,
      checkedAt,
    });
    return;
  }

  const dnsMatched = dnsRecordType === "CNAME"
    ? dnsRecords.some(r => r === expectedTarget || r.endsWith(`.${expectedTarget}`))
    : null; // We can't easily judge A-record matches without resolving the target.

  // ── 2. HTTPS reachability — call the by-host site endpoint via the
  //       configured custom domain. A successful response that contains
  //       this org's id means the proxy is correctly routing requests.
  //
  // SSRF defense (TOCTOU-proof): resolve the host once via dns.lookup,
  // refuse to proceed if any address is non-publicly-routable, then
  // open the TCP socket directly to the vetted IP using node:https
  // (which does no further name resolution). Host header and SNI both
  // stay set to the original hostname so TLS validation and our
  // by-host router still work correctly. Redirects are not followed
  // (https.request is a single-shot request by default), so an
  // attacker-controlled Location header can't pivot us elsewhere.
  let httpsStatus: number | null = null;
  let httpsError: string | null = null;
  let returnedOrgId: number | null = null;
  let returnedSlug: string | null = null;

  let safeAddresses: { address: string; family: 4 | 6 }[] = [];
  try {
    const looked = await dnsModule.lookup(host, { all: true, verbatim: true });
    safeAddresses = looked.map(l => ({ address: l.address, family: l.family as 4 | 6 }));
  } catch (e) {
    httpsError = `DNS lookup failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  const blocked = safeAddresses.filter(isPrivateAddress);
  if (httpsError === null && (safeAddresses.length === 0 || blocked.length > 0)) {
    httpsError = "Refused to fetch host: it does not resolve to a publicly-routable address.";
  }

  if (httpsError === null && safeAddresses.length > 0) {
    const httpsModule = await import("node:https");
    const MAX_BYTES = 256 * 1024; // 256 KB cap — by-host payloads are small.

    // Try each vetted address in turn (dual-stack hosts often expose
    // both v4 and v6 — the first record may be temporarily unreachable
    // from this server's egress while the second is fine). Stop on the
    // first non-network response so we surface 4xx/5xx faithfully
    // instead of masking them with a fallback success.
    const probe = (pinned: { address: string; family: 4 | 6 }) =>
      new Promise<{ status: number | null; body: string; error: string | null }>((resolve) => {
      const req = httpsModule.request({
        host: pinned.address,
        port: 443,
        family: pinned.family,
        method: "GET",
        path: "/api/public/clubs/by-host/site",
        headers: { Host: host, Accept: "application/json" },
        servername: host,
        timeout: 10_000,
        // Force IP-pinned connect: undefined `lookup` means undici/agent
        // would still re-resolve — by passing `host` as the IP literal
        // we sidestep that and node opens the socket directly.
      }, (response) => {
        let body = "";
        let bytes = 0;
        let aborted = false;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_BYTES) {
            aborted = true;
            response.destroy();
            return;
          }
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? null,
            body,
            error: aborted ? "Response exceeded 256 KB; aborted." : null,
          });
        });
        response.on("error", (e: Error) => {
          resolve({ status: response.statusCode ?? null, body, error: e.message });
        });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ status: null, body: "", error: "Request timed out after 10 seconds." });
      });
      req.on("error", (e: NodeJS.ErrnoException) => {
        const msg = e.code ? `${e.code}${e.message ? `: ${e.message}` : ""}` : (e.message ?? "HTTPS request failed.");
        resolve({ status: null, body: "", error: msg });
      });
      req.end();
    });

    let result: { status: number | null; body: string; error: string | null } = { status: null, body: "", error: "No addresses to probe." };
    for (const addr of safeAddresses) {
      result = await probe(addr);
      // A server response (any HTTP status) is authoritative — stop.
      // Only fall through to the next address on transport-level errors.
      if (result.status !== null) break;
    }

    httpsStatus = result.status;
    if (result.error) {
      httpsError = result.error;
    } else if (httpsStatus !== null && httpsStatus >= 300 && httpsStatus < 400) {
      // Treat any redirect as "did not serve our site" — we don't follow.
      httpsError = `Host returned HTTP ${httpsStatus} redirect; not following.`;
    } else if (httpsStatus !== null && httpsStatus >= 200 && httpsStatus < 300) {
      try {
        const parsed = JSON.parse(result.body) as { organization?: { id?: number; slug?: string } };
        returnedOrgId = parsed?.organization?.id ?? null;
        returnedSlug = parsed?.organization?.slug ?? null;
      } catch {
        httpsError = "Mini-site response was not valid JSON.";
      }
    }
  }

  const httpsResult = {
    status: httpsStatus,
    ok: httpsStatus !== null && httpsStatus >= 200 && httpsStatus < 400 && !httpsError,
    error: httpsError,
    returnedOrgId,
    returnedSlug,
  };
  const dnsResult = { records: dnsRecords, recordType: dnsRecordType, matched: dnsMatched, error: null as string | null };

  // Live: HTTPS reached us AND served the right org's site.
  if (httpsResult.ok && returnedOrgId === org.id) {
    res.json({
      status: "live",
      customDomain: host,
      expectedTarget,
      dns: dnsResult,
      https: httpsResult,
      message: `${host} is live and serving your club's mini-site.`,
      checkedAt,
    });
    return;
  }

  // HTTPS reached *something*, but it isn't us → mismatch.
  if (httpsResult.ok && returnedOrgId !== null && returnedOrgId !== org.id) {
    res.json({
      status: "mismatch",
      customDomain: host,
      expectedTarget,
      dns: dnsResult,
      https: httpsResult,
      message:
        `https://${host} is reachable but is currently serving a different club's ` +
        `mini-site (${returnedSlug ?? `org #${returnedOrgId}`}). Double-check that ` +
        `your CNAME points to ${expectedTarget} and that no other club has the same ` +
        `domain configured.`,
      checkedAt,
    });
    return;
  }

  // HTTPS responded but with a non-2xx or no JSON payload → mismatch.
  if (httpsStatus !== null && !httpsError) {
    res.json({
      status: "mismatch",
      customDomain: host,
      expectedTarget,
      dns: dnsResult,
      https: httpsResult,
      message:
        `https://${host} responded with HTTP ${httpsStatus}, but didn't return your ` +
        `mini-site. Make sure the CNAME points to ${expectedTarget} and that nothing ` +
        `else is hosted at this hostname.`,
      checkedAt,
    });
    return;
  }

  // DNS pointed somewhere wrong before we could fetch — explicit mismatch.
  if (dnsMatched === false) {
    res.json({
      status: "mismatch",
      customDomain: host,
      expectedTarget,
      dns: dnsResult,
      https: httpsResult,
      message:
        `${host} resolves to ${dnsRecords.join(", ")}, but we expected a CNAME to ` +
        `${expectedTarget}. Update the DNS record at your registrar and re-check ` +
        `after propagation.`,
      checkedAt,
    });
    return;
  }

  // DNS resolved (or matched) but HTTPS failed entirely.
  res.json({
    status: "unreachable",
    customDomain: host,
    expectedTarget,
    dns: dnsResult,
    https: httpsResult,
    message:
      `DNS for ${host} resolves, but we couldn't load https://${host}` +
      (httpsError ? ` (${httpsError})` : "") +
      `. This usually means SSL is still being provisioned, or the CNAME is ` +
      `pointing to a host that isn't terminating TLS for this domain. Try again ` +
      `in a few minutes.`,
    checkedAt,
  });
});

/**
 * Image upload flow for hero / OG / gallery images.
 * Two-step like the existing media flow:
 *   1. POST /upload-url → presigned PUT URL + objectPath + token
 *   2. PUT to that URL with the file body
 *   3. POST /images with { objectPath, uploadToken } → marks the object as
 *      a publicly-readable marketing-site asset and returns a usable URL
 *      that can be saved into heroImageUrl / seoOgImageUrl / galleryImages.
 */
router.post("/upload-url", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const { contentType, size } = req.body ?? {};
  if (contentType && !ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
    res.status(400).json({ error: "Unsupported image type. Allowed: JPEG, PNG, GIF, WebP, SVG, ICO" });
    return;
  }
  if (size !== undefined && typeof size === "number" && size > MAX_IMAGE_BYTES) {
    res.status(400).json({ error: "Image too large. Maximum size is 10 MB." });
    return;
  }
  try {
    const uploadURL = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    const uploadToken = signUploadPath(objectPath);
    res.json({ uploadURL, objectPath, uploadToken });
  } catch {
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

router.post("/images", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { objectPath, uploadToken } = req.body ?? {};
  if (!objectPath || typeof objectPath !== "string") {
    res.status(400).json({ error: "objectPath required" }); return;
  }
  if (!uploadToken || !verifyUploadToken(objectPath, uploadToken)) {
    res.status(403).json({ error: "Invalid or missing upload token" }); return;
  }

  // Validate the actual stored object: image content type + size limit.
  let storedContentType = "";
  try {
    const objFile = await storage.getObjectEntityFile(objectPath);
    const [meta] = await objFile.getMetadata();
    storedContentType = (meta.contentType as string) || "";
    const storedSize = meta.size ? Number(meta.size) : 0;
    if (storedSize > MAX_IMAGE_BYTES) {
      res.status(400).json({ error: "Image exceeds the 10 MB maximum size" }); return;
    }
  } catch {
    res.status(404).json({ error: "Uploaded object not found" }); return;
  }
  if (storedContentType && !ALLOWED_IMAGE_CONTENT_TYPES.has(storedContentType)) {
    res.status(400).json({ error: "Unsupported image type. Allowed: JPEG, PNG, GIF, WebP, SVG, ICO" });
    return;
  }

  // Mark as publicly-readable so the storage GET route can serve it without
  // requiring a media table row. Owner is the org id so we can audit later.
  try {
    await storage.trySetObjectEntityAclPolicy(objectPath, {
      owner: `org:${orgId}`,
      visibility: "public",
    });
  } catch {
    res.status(500).json({ error: "Failed to mark image as public" }); return;
  }

  // Return a browser-fetchable URL. The storage GET route lives at
  // /api/storage/objects/... on this API server. We prefer an absolute
  // URL so the marketing site (potentially on a different host) can
  // load it; falls back to a relative path for local dev.
  const apiBase = (
    process.env.API_PUBLIC_URL
    ?? process.env.APP_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
  ).replace(/\/$/, "");
  const url = `${apiBase}/api/storage${objectPath}`;

  // Task #579 — Track every successfully-registered upload so admins can
  // browse and reuse previously uploaded images via the library picker.
  // Idempotent on (organizationId, objectPath) so re-registering an
  // existing object doesn't create duplicates.
  try {
    const u = getUser(req);
    let storedSize: number | null = null;
    try {
      const objFile = await storage.getObjectEntityFile(objectPath);
      const [meta] = await objFile.getMetadata();
      storedSize = meta.size ? Number(meta.size) : null;
    } catch { /* already validated above */ }
    await db
      .insert(clubMarketingSiteImagesTable)
      .values({
        organizationId: orgId,
        objectPath,
        url,
        contentType: storedContentType || null,
        sizeBytes: storedSize,
        uploadedByUserId: u?.id ?? null,
      })
      .onConflictDoNothing({
        target: [
          clubMarketingSiteImagesTable.organizationId,
          clubMarketingSiteImagesTable.objectPath,
        ],
      });
  } catch {
    // Library tracking is best-effort — never fail the upload because of it.
  }

  res.status(201).json({ url, objectPath });
});

/**
 * Task #579 — List previously uploaded marketing-site images for the
 * current club so admins can pick from them in the editor instead of
 * re-uploading the same photo.
 */
router.get("/library", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const rows = await db
    .select({
      id: clubMarketingSiteImagesTable.id,
      objectPath: clubMarketingSiteImagesTable.objectPath,
      url: clubMarketingSiteImagesTable.url,
      contentType: clubMarketingSiteImagesTable.contentType,
      sizeBytes: clubMarketingSiteImagesTable.sizeBytes,
      createdAt: clubMarketingSiteImagesTable.createdAt,
    })
    .from(clubMarketingSiteImagesTable)
    .where(eq(clubMarketingSiteImagesTable.organizationId, orgId))
    .orderBy(desc(clubMarketingSiteImagesTable.createdAt))
    .limit(500);

  // Task #749 — Annotate each image with the spots on the public site
  // that currently reference it, so the picker UI can show an "In use"
  // badge and the delete confirmation can list affected spots.
  const site = await db.query.clubMarketingSitesTable.findFirst({
    where: eq(clubMarketingSitesTable.organizationId, orgId),
  });
  const courses = await db
    .select({
      id: coursesTable.id,
      name: coursesTable.name,
      slug: coursesTable.slug,
      heroImageUrl: coursesTable.heroImageUrl,
    })
    .from(coursesTable)
    .where(eq(coursesTable.organizationId, orgId));

  // Task #900 — Each usage record carries enough info for the picker's
  // detail panel to deep-link straight to the editor section that
  // references the image. `targetTestId` points at a same-page element
  // (so the picker can scroll/focus it after closing the dialog), and
  // `href` is set when the section lives on a different admin page
  // (e.g. course pages, which are edited under /courses).
  type Usage = {
    kind: string;
    label: string;
    targetTestId?: string;
    href?: string;
    courseId?: number;
  };
  const usageByUrl = new Map<string, Usage[]>();
  const add = (url: string | null | undefined, usage: Usage) => {
    if (!url) return;
    const list = usageByUrl.get(url) ?? [];
    list.push(usage);
    usageByUrl.set(url, list);
  };
  if (site) {
    add(site.heroImageUrl, {
      kind: "hero",
      label: "Hero banner",
      targetTestId: "input-hero-image-url",
    });
    add(site.seoOgImageUrl, {
      kind: "og",
      label: "Social share image",
      targetTestId: "input-og-image-url",
    });
    add(site.logoImageUrl, {
      kind: "logo",
      label: "Marketing logo",
      targetTestId: "input-logo-image-url",
    });
    add(site.faviconUrl, {
      kind: "favicon",
      label: "Favicon",
      targetTestId: "input-favicon-url",
    });
    const gallery = Array.isArray(site.galleryImages) ? site.galleryImages : [];
    gallery.forEach((g, i) => {
      if (g && typeof g.url === "string") {
        add(g.url, {
          kind: "gallery",
          label: `Gallery photo #${i + 1}`,
          targetTestId: `gallery-row-${i}`,
        });
      }
    });
  }
  for (const c of courses) {
    add(c.heroImageUrl, {
      kind: "course",
      label: `Course: ${c.name}`,
      courseId: c.id,
      href: `/courses?courseId=${c.id}`,
    });
  }

  const annotated = rows.map(r => ({
    ...r,
    usage: usageByUrl.get(r.url) ?? [],
  }));
  res.json(annotated);
});

/**
 * Task #579 — Remove an image from the club's library and delete the
 * underlying object from storage. The DB row is removed even if the
 * storage delete fails (e.g. object already gone) so the orphan
 * doesn't keep cluttering the picker.
 */
router.delete("/library/:imageId", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const imageId = parseInt(String((req.params as Record<string, string>).imageId));
  if (!Number.isFinite(imageId)) {
    res.status(400).json({ error: "Invalid imageId" }); return;
  }
  const [row] = await db
    .select({
      id: clubMarketingSiteImagesTable.id,
      objectPath: clubMarketingSiteImagesTable.objectPath,
    })
    .from(clubMarketingSiteImagesTable)
    .where(and(
      eq(clubMarketingSiteImagesTable.id, imageId),
      eq(clubMarketingSiteImagesTable.organizationId, orgId),
    ));
  if (!row) { { res.status(404).json({ error: "Image not found" }); return; } }

  try {
    const objFile = await storage.getObjectEntityFile(row.objectPath);
    await objFile.delete({ ignoreNotFound: true });
  } catch {
    // Best-effort: drop the DB row even if the object is already gone.
  }
  await db
    .delete(clubMarketingSiteImagesTable)
    .where(and(
      eq(clubMarketingSiteImagesTable.id, imageId),
      eq(clubMarketingSiteImagesTable.organizationId, orgId),
    ));
  res.status(204).end();
});

router.post("/publish", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  await getOrCreateSite(orgId);
  const [updated] = await db
    .update(clubMarketingSitesTable)
    .set({
      isPublished: true,
      publishedAt: new Date(),
      cacheVersion: sql`${clubMarketingSitesTable.cacheVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(clubMarketingSitesTable.organizationId, orgId))
    .returning();

  // Task #792 — Publish flips the public site live; bust the prerendered
  // club-page cache so crawlers don't keep serving the previous render.
  lookupOrgSlug(orgId)
    .then(slug => slug ? purgeMarketingSiteClubCache(slug) : undefined)
    .catch(err => console.warn("[ssr-cache] club purge dispatch failed", { orgId, err: (err as Error).message }));

  res.json(updated);
});

/**
 * Task #437 — Issue a short-lived HMAC token that the public site
 * endpoint accepts via `?preview=<token>`. Lets admins preview the
 * current saved draft (whether or not it is published) at
 *   /clubs/<slug>?preview=<token>
 */
router.post("/preview-token", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  await getOrCreateSite(orgId); // ensure a draft row exists
  const token = issueMarketingPreviewToken(orgId);
  res.json({ token, expiresInMs: MARKETING_PREVIEW_TOKEN_TTL_MS });
});

router.post("/unpublish", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  await getOrCreateSite(orgId);
  const [updated] = await db
    .update(clubMarketingSitesTable)
    .set({
      isPublished: false,
      cacheVersion: sql`${clubMarketingSitesTable.cacheVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(clubMarketingSitesTable.organizationId, orgId))
    .returning();

  // Task #792 — Unpublish should immediately hide the prerendered page,
  // not leave the previous render cached for the TTL window.
  lookupOrgSlug(orgId)
    .then(slug => slug ? purgeMarketingSiteClubCache(slug) : undefined)
    .catch(err => console.warn("[ssr-cache] club purge dispatch failed", { orgId, err: (err as Error).message }));

  res.json(updated);
});

/* ── Public ───────────────────────────────────────────────────────── */

const ORG_PUBLIC_COLUMNS = {
  id: organizationsTable.id,
  name: organizationsTable.name,
  slug: organizationsTable.slug,
  description: organizationsTable.description,
  logoUrl: organizationsTable.logoUrl,
  primaryColor: organizationsTable.primaryColor,
  contactEmail: organizationsTable.contactEmail,
  contactPhone: organizationsTable.contactPhone,
  address: organizationsTable.address,
  website: organizationsTable.website,
  latitude: organizationsTable.latitude,
  longitude: organizationsTable.longitude,
  customDomain: organizationsTable.customDomain,
} as const;

/**
 * Task #438 — Normalise an incoming Host header to a comparable hostname:
 * lowercased, port stripped. Returns null for empty/invalid input.
 */
function normalizeHost(host: string | undefined | null): string | null {
  if (!host) return null;
  const trimmed = String(host).trim().toLowerCase();
  if (!trimmed) return null;
  // Strip port (handles both "example.com:8080" and IPv6 brackets).
  const noPort = trimmed.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return noPort || null;
}

function resolveRequestHost(req: Request): string | null {
  // Some proxy chains forward a comma-separated list of hosts in
  // X-Forwarded-Host (e.g. "edge.example.com, internal-lb"). The
  // first entry is always the client-facing hostname.
  const fwd = req.headers["x-forwarded-host"];
  const fwdRaw = Array.isArray(fwd) ? fwd[0] : fwd;
  const firstFwd = typeof fwdRaw === "string" ? fwdRaw.split(",")[0] : undefined;
  return normalizeHost(firstFwd || req.headers.host);
}

async function loadOrgByCustomHost(host: string) {
  const [org] = await db
    .select(ORG_PUBLIC_COLUMNS)
    .from(organizationsTable)
    .where(and(
      // Task #663 — strip leading/trailing whitespace (incl. tabs/newlines)
      // and lowercase the stored value so legacy rows that were saved with
      // stray whitespace or mixed case still resolve. New writes are
      // normalised at the org admin endpoints, but we keep this defensive
      // comparison so admin typos don't silently 404 the mini-site.
      sql`regexp_replace(lower(${organizationsTable.customDomain}), '^\\s+|\\s+$', '', 'g') = ${host}`,
      eq(organizationsTable.isActive, true),
    ));
  return org ?? null;
}

type PublicOrg = NonNullable<Awaited<ReturnType<typeof loadOrgByCustomHost>>>;

async function buildClubSitePayload(req: Request, res: Response, org: PublicOrg) {

  const site = await db.query.clubMarketingSitesTable.findFirst({
    where: eq(clubMarketingSitesTable.organizationId, org.id),
  });
  // Task #437 — admins may preview the current draft (even if unpublished)
  // by passing `?preview=<token>` issued from /preview-token. The token is
  // bound to the org, so it cannot be used to peek at other clubs' drafts.
  const previewParam = typeof req.query.preview === "string" ? req.query.preview : null;
  const previewOrgId = previewParam ? verifyMarketingPreviewToken(previewParam) : null;
  const isPreview = previewOrgId !== null && site && previewOrgId === org.id;
  if (!site || (!site.isPublished && !isPreview)) { { res.status(404).json({ error: "Site not published" }); return; } }

  const enabled = site.enabledSections as Record<string, boolean>;

  // Pull tournaments lazily — only when the section is enabled.
  let tournaments: Array<{
    id: number; name: string; format: string; status: string;
    startDate: string | null; endDate: string | null;
    courseName: string | null; entryFee: string | null;
    registrationUrl: string;
  }> = [];
  if (enabled.tournaments !== false) {
    const rows = await db
      .select({
        id: tournamentsTable.id,
        name: tournamentsTable.name,
        format: tournamentsTable.format,
        status: tournamentsTable.status,
        startDate: tournamentsTable.startDate,
        endDate: tournamentsTable.endDate,
        entryFee: tournamentsTable.entryFee,
        courseId: tournamentsTable.courseId,
      })
      .from(tournamentsTable)
      .where(and(
        eq(tournamentsTable.organizationId, org.id),
        inArray(tournamentsTable.status, ["upcoming", "active"]),
      ))
      .orderBy(asc(tournamentsTable.startDate))
      .limit(12);

    const courseIds = rows.map(r => r.courseId).filter((id): id is number => id != null);
    const courses = courseIds.length
      ? await db.select({ id: coursesTable.id, name: coursesTable.name })
          .from(coursesTable).where(inArray(coursesTable.id, courseIds))
      : [];
    const courseMap = new Map(courses.map(c => [c.id, c.name]));

    tournaments = rows.map(r => ({
      id: r.id,
      name: r.name,
      format: r.format,
      status: r.status,
      startDate: r.startDate ? new Date(r.startDate as unknown as string).toISOString() : null,
      endDate: r.endDate ? new Date(r.endDate as unknown as string).toISOString() : null,
      courseName: r.courseId ? (courseMap.get(r.courseId) ?? null) : null,
      entryFee: r.entryFee ?? null,
      // Placeholder — overwritten below once the absolute base URL is
      // computed so deep links resolve across artifact boundaries.
      registrationUrl: `/register/${org.id}/${r.id}`,
    }));
  }

  // Deep links for CTAs — point at existing flows in the kharagolf-web
  // enterprise app. We resolve to an absolute URL so the links work even
  // when the marketing site is served from a different host than the
  // app (custom club domain, separate marketing domain, etc).
  const appBase = (
    process.env.APP_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
  ).replace(/\/$/, "");
  // The kharagolf-web artifact is served under /kharagolf-web in this
  // workspace; in production the same app may be mounted at /. Allow an
  // explicit override via WEB_APP_PATH (e.g. "" for root).
  const appPath = (process.env.WEB_APP_PATH ?? "/kharagolf-web").replace(/\/$/, "");
  const link = (p: string) => `${appBase}${appPath}${p}`;
  const links = {
    bookTeeTime: link(`/marketplace?org=${org.id}`),
    applyMembership: link(`/login?signup=1&club=${org.slug}`),
    viewLessons: link(`/lessons?org=${org.id}`),
    contact: org.contactEmail ? `mailto:${org.contactEmail}` : null,
  };

  // Tournament registration lives in the kharagolf-web app at
  // /register/:orgId/:tournamentId.
  tournaments = tournaments.map(t => ({
    ...t,
    registrationUrl: link(`/register/${org.id}/${t.id}`),
  }));

  // ETag from cacheVersion + updatedAt allows fast invalidation while still
  // letting Cloudflare/browsers cache the JSON.
  const etag = `W/"site-${site.cacheVersion}-${new Date(site.updatedAt).getTime()}${isPreview ? "-preview" : ""}"`;
  if (!isPreview && req.headers["if-none-match"] === etag) { { res.status(304).end(); return; } }
  res.setHeader("ETag", etag);
  // Preview responses must not be cached so admins always see the latest draft.
  res.setHeader(
    "Cache-Control",
    isPreview ? "private, no-store" : "public, max-age=60, stale-while-revalidate=600",
  );

  // Public courses for this club — surfaced on the marketing site so
  // visitors can drill into /clubs/:slug/courses/:courseSlug pages.
  const publicCourses = await db
    .select({
      id: coursesTable.id,
      slug: coursesTable.slug,
      name: coursesTable.name,
      location: coursesTable.location,
      holes: coursesTable.holes,
      par: coursesTable.par,
      heroImageUrl: coursesTable.heroImageUrl,
    })
    .from(coursesTable)
    .where(and(eq(coursesTable.organizationId, org.id), eq(coursesTable.isPublic, true)))
    .orderBy(asc(coursesTable.name));

  res.json({
    organization: org,
    courses: publicCourses,
    site: {
      theme: site.theme,
      heroImageUrl: site.heroImageUrl,
      heroTitle: site.heroTitle,
      heroSubtitle: site.heroSubtitle,
      heroCtaLabel: site.heroCtaLabel,
      heroCtaHref: site.heroCtaHref,
      aboutMarkdown: site.aboutMarkdown,
      servicesMarkdown: site.servicesMarkdown,
      galleryImages: site.galleryImages,
      sectionOrder: site.sectionOrder,
      enabledSections: site.enabledSections,
      seoTitle: site.seoTitle,
      seoDescription: site.seoDescription,
      seoOgImageUrl: site.seoOgImageUrl,
      brandPrimaryColor: site.brandPrimaryColor,
      brandAccentColor: site.brandAccentColor,
      brandHeadingFont: site.brandHeadingFont,
      // Task #666 — marketing-specific logo + favicon (null = fall back to
      // org logo / platform default favicon on the public site).
      logoImageUrl: site.logoImageUrl,
      faviconUrl: site.faviconUrl,
      publishedAt: site.publishedAt,
      cacheVersion: site.cacheVersion,
    },
    tournaments,
    links,
  });
}

/**
 * Task #438 — Custom-domain lookup. The website SPA hits this from the
 * root of a club's vanity domain (e.g. https://pinevalley.golf/) so we
 * can resolve which club to render at "/" without exposing the slug.
 * Falls back to 404 when the host is not assigned to any active org.
 *
 * NOTE: must be registered before the `/clubs/:slug/site` param route so
 * "by-host" is not interpreted as a slug.
 */
publicRouter.get("/clubs/by-host/site", async (req, res) => {
  const host = resolveRequestHost(req);
  if (!host) { { res.status(404).json({ error: "Unknown host" }); return; } }
  const org = await loadOrgByCustomHost(host);
  if (!org) { { res.status(404).json({ error: "No club mapped to this host" }); return; } }
  await buildClubSitePayload(req, res, org);
});

publicRouter.get("/clubs/:slug/site", async (req, res) => {
  const slug = (req.params as Record<string, string>).slug;
  const [org] = await db
    .select(ORG_PUBLIC_COLUMNS)
    .from(organizationsTable)
    .where(and(eq(organizationsTable.slug, slug), eq(organizationsTable.isActive, true)));
  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }
  await buildClubSitePayload(req, res, org);
});

/* ── Task #384 — Public Course Pages ─────────────────────────────────
 * Public, server-friendly endpoints for /clubs/:clubSlug/courses/:courseSlug
 * pages on the marketing site:
 *   GET  /clubs/:slug/courses                              — list public courses
 *   GET  /clubs/:slug/courses/:courseSlug                  — full detail
 *   GET  /clubs/:slug/courses/:courseSlug/reviews          — paginated approved reviews
 *   POST /clubs/:slug/courses/:courseSlug/reviews          — submit (always pending)
 *   POST /course-reviews/:reviewId/report                  — flag abuse
 * Admin moderation routes are mounted under /organizations/:orgId/marketing-site
 * below.
 * ─────────────────────────────────────────────────────────────────── */

const REVIEW_DISPLAY_MODES = new Set(["public", "anonymous"]);

function buildAppLinks(orgId: number, courseId?: number) {
  const appBase = (
    process.env.APP_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
  ).replace(/\/$/, "");
  const appPath = (process.env.WEB_APP_PATH ?? "/kharagolf-web").replace(/\/$/, "");
  const params = new URLSearchParams({ org: String(orgId) });
  if (courseId) params.set("courseId", String(courseId));
  return `${appBase}${appPath}/marketplace?${params.toString()}`;
}

async function loadOrgBySlug(slug: string) {
  const [org] = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      logoUrl: organizationsTable.logoUrl,
      contactPhone: organizationsTable.contactPhone,
      contactEmail: organizationsTable.contactEmail,
      address: organizationsTable.address,
      website: organizationsTable.website,
    })
    .from(organizationsTable)
    .where(and(eq(organizationsTable.slug, slug), eq(organizationsTable.isActive, true)));
  return org ?? null;
}

publicRouter.get("/clubs/:slug/courses", async (req, res) => {
  const org = await loadOrgBySlug((req.params as Record<string, string>).slug);
  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }

  const rows = await db
    .select({
      id: coursesTable.id,
      slug: coursesTable.slug,
      name: coursesTable.name,
      location: coursesTable.location,
      holes: coursesTable.holes,
      par: coursesTable.par,
      rating: coursesTable.rating,
      slope: coursesTable.slope,
      yardage: coursesTable.yardage,
      heroImageUrl: coursesTable.heroImageUrl,
      designer: coursesTable.designer,
    })
    .from(coursesTable)
    .where(and(eq(coursesTable.organizationId, org.id), eq(coursesTable.isPublic, true)))
    .orderBy(asc(coursesTable.name));

  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  res.json({ club: org, courses: rows });
});

publicRouter.get("/clubs/:slug/courses/:courseSlug", async (req, res) => {
  const org = await loadOrgBySlug((req.params as Record<string, string>).slug);
  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }

  const [course] = await db
    .select()
    .from(coursesTable)
    .where(and(
      eq(coursesTable.organizationId, org.id),
      eq(coursesTable.slug, (req.params as Record<string, string>).courseSlug),
      eq(coursesTable.isPublic, true),
    ));
  if (!course) { { res.status(404).json({ error: "Course not found" }); return; } }

  // Hole-by-hole details (yardages, par, handicap, descriptions)
  const holes = await db
    .select()
    .from(holeDetailsTable)
    .where(eq(holeDetailsTable.courseId, course.id))
    .orderBy(asc(holeDetailsTable.holeNumber));

  // Approved photos (gallery + per-hole). Hero image falls back to the first
  // approved hero-flagged photo if no explicit hero URL is set on the course.
  const photos = await db
    .select({
      id: mediaTable.id,
      objectPath: mediaTable.objectPath,
      thumbnailPath: mediaTable.thumbnailPath,
      caption: mediaTable.caption,
      holeNumber: mediaTable.holeNumber,
      isHero: mediaTable.isHero,
      uploaderName: mediaTable.uploaderName,
      createdAt: mediaTable.createdAt,
    })
    .from(mediaTable)
    .where(and(
      eq(mediaTable.courseId, course.id),
      eq(mediaTable.approved, true),
    ))
    .orderBy(desc(mediaTable.isHero), asc(mediaTable.holeNumber), desc(mediaTable.createdAt));

  // Review aggregate + recent approved reviews
  const [agg] = await db
    .select({
      avgRating: avg(courseReviewsTable.rating),
      totalReviews: count(courseReviewsTable.id),
    })
    .from(courseReviewsTable)
    .where(and(
      eq(courseReviewsTable.courseId, course.id),
      eq(courseReviewsTable.status, "approved"),
    ));

  const recentReviews = await db
    .select({
      id: courseReviewsTable.id,
      rating: courseReviewsTable.rating,
      title: courseReviewsTable.title,
      body: courseReviewsTable.body,
      reviewerDisplayName: courseReviewsTable.reviewerDisplayName,
      displayMode: courseReviewsTable.displayMode,
      createdAt: courseReviewsTable.createdAt,
      adminReply: courseReviewsTable.adminReply,
      adminReplyAt: courseReviewsTable.adminReplyAt,
    })
    .from(courseReviewsTable)
    .where(and(
      eq(courseReviewsTable.courseId, course.id),
      eq(courseReviewsTable.status, "approved"),
    ))
    .orderBy(desc(courseReviewsTable.createdAt))
    .limit(6);

  const heroImageUrl = course.heroImageUrl
    ?? photos.find(p => p.isHero)?.objectPath
    ?? photos[0]?.objectPath
    ?? null;

  // Tee-time CTA — prefer course-level override, otherwise deep-link into
  // the marketplace booking flow filtered to this course.
  const teeTimeUrl = course.teeTimeCtaUrl ?? buildAppLinks(org.id, course.id);

  res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
  res.json({
    club: org,
    course: {
      id: course.id,
      slug: course.slug,
      name: course.name,
      description: course.description,
      location: course.location,
      // Task #1558 — Newly mapped courses often have a remembered mapper
      // centre (`mapDefault*`, Task #1312) but no explicit
      // latitude/longitude yet, because admins haven't re-entered the
      // coordinates by hand on the course form. Fall back to the
      // remembered centre so the public course page (and its schema.org
      // JSON-LD geo block) still gets a marker without an admin edit.
      latitude: course.latitude ?? course.mapDefaultLat,
      longitude: course.longitude ?? course.mapDefaultLng,
      holes: course.holes,
      par: course.par,
      rating: course.rating,
      slope: course.slope,
      yardage: course.yardage,
      designer: course.designer,
      yearOpened: course.yearOpened,
      awards: course.awards ?? [],
      contactPhone: course.contactPhone ?? org.contactPhone ?? null,
      contactEmail: course.contactEmail ?? org.contactEmail ?? null,
      heroImageUrl,
    },
    holes: holes.map(h => ({
      holeNumber: h.holeNumber,
      par: h.par,
      handicap: h.handicap,
      yardageBlue: h.yardageBlue,
      yardageWhite: h.yardageWhite,
      yardageRed: h.yardageRed,
      description: h.description,
      photoUrl: photos.find(p => p.holeNumber === h.holeNumber)?.objectPath ?? null,
    })),
    photos: photos.map(p => ({
      id: p.id,
      url: p.objectPath,
      thumbnailUrl: p.thumbnailPath,
      caption: p.caption,
      holeNumber: p.holeNumber,
      isHero: p.isHero,
      uploaderName: p.uploaderName,
    })),
    reviewSummary: {
      averageRating: agg?.avgRating != null ? Number(agg.avgRating) : null,
      totalReviews: Number(agg?.totalReviews ?? 0),
      recent: recentReviews,
    },
    teeTimeUrl,
  });
});

publicRouter.get("/clubs/:slug/courses/:courseSlug/reviews", async (req, res) => {
  const org = await loadOrgBySlug((req.params as Record<string, string>).slug);
  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }
  const [course] = await db.select({ id: coursesTable.id })
    .from(coursesTable)
    .where(and(eq(coursesTable.organizationId, org.id), eq(coursesTable.slug, (req.params as Record<string, string>).courseSlug)));
  if (!course) { { res.status(404).json({ error: "Course not found" }); return; } }

  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20")) || 20));
  const page = Math.max(1, parseInt(String(req.query.page ?? "1")) || 1);
  const offset = (page - 1) * limit;

  const reviews = await db
    .select({
      id: courseReviewsTable.id,
      rating: courseReviewsTable.rating,
      title: courseReviewsTable.title,
      body: courseReviewsTable.body,
      reviewerDisplayName: courseReviewsTable.reviewerDisplayName,
      displayMode: courseReviewsTable.displayMode,
      createdAt: courseReviewsTable.createdAt,
      adminReply: courseReviewsTable.adminReply,
      adminReplyAt: courseReviewsTable.adminReplyAt,
    })
    .from(courseReviewsTable)
    .where(and(
      eq(courseReviewsTable.courseId, course.id),
      eq(courseReviewsTable.status, "approved"),
    ))
    .orderBy(desc(courseReviewsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({ page, limit, reviews });
});

publicRouter.post("/clubs/:slug/courses/:courseSlug/reviews", async (req, res) => {
  const org = await loadOrgBySlug((req.params as Record<string, string>).slug);
  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }
  const [course] = await db.select({ id: coursesTable.id })
    .from(coursesTable)
    .where(and(eq(coursesTable.organizationId, org.id), eq(coursesTable.slug, (req.params as Record<string, string>).courseSlug)));
  if (!course) { { res.status(404).json({ error: "Course not found" }); return; } }

  // Task #626 — throttle public review submissions per IP + per course
  // so spammers can't fill the moderation queue.
  if (!(await enforceRateLimit(res, reviewSubmitScopes(getClientIp(req), course.id)))) return;

  const b = req.body ?? {};
  const rating = parseInt(String(b.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ error: "rating must be an integer 1–5" }); return;
  }
  const displayMode = REVIEW_DISPLAY_MODES.has(b.displayMode) ? b.displayMode : "public";
  const reviewerDisplayName = typeof b.reviewerDisplayName === "string" ? b.reviewerDisplayName.slice(0, 80) : null;
  const reviewerEmail = typeof b.reviewerEmail === "string" ? b.reviewerEmail.slice(0, 200) : null;
  const title = typeof b.title === "string" ? b.title.slice(0, 200) : null;
  const body = typeof b.body === "string" ? b.body.slice(0, 4000) : null;

  // Authenticated submissions are attributed to the user; anonymous
  // submissions still require a name+email so admins can verify them.
  const u = getUser(req);
  if (!u && (!reviewerDisplayName || !reviewerEmail)) {
    res.status(400).json({ error: "reviewerDisplayName and reviewerEmail are required for anonymous submissions" });
    return;
  }

  const [created] = await db
    .insert(courseReviewsTable)
    .values({
      organizationId: org.id,
      courseId: course.id,
      userId: u?.id ?? null,
      reviewerDisplayName: reviewerDisplayName ?? null,
      reviewerEmail: reviewerEmail ?? null,
      displayMode,
      rating,
      title,
      body,
      status: "pending",
    })
    .returning();

  res.status(201).json({ id: created.id, status: created.status });
});

/**
 * Task #475 — Public photo submission flow for course pages.
 *
 *   POST /clubs/:slug/courses/:courseSlug/photos/upload-url
 *     → presigned PUT URL + objectPath + token (mirrors the admin variant
 *       but is open to the public so signed-in players & visitors can
 *       contribute photos directly from the public course page).
 *
 *   POST /clubs/:slug/courses/:courseSlug/photos
 *     → finalise the upload as a `media` row.  Submissions land in the
 *       existing moderation queue (`approved=false`) unless the
 *       authenticated submitter is a club admin for this org, in which
 *       case the photo is auto-approved (matching the existing admin
 *       upload behaviour).
 */
publicRouter.post("/clubs/:slug/courses/:courseSlug/photos/upload-url", async (req, res) => {
  const org = await loadOrgBySlug((req.params as Record<string, string>).slug);
  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }
  const [course] = await db.select({ id: coursesTable.id })
    .from(coursesTable)
    .where(and(
      eq(coursesTable.organizationId, org.id),
      eq(coursesTable.slug, (req.params as Record<string, string>).courseSlug),
      eq(coursesTable.isPublic, true),
    ));
  if (!course) { { res.status(404).json({ error: "Course not found" }); return; } }

  // Task #626 — throttle presigned-upload issuance per IP + per course
  // so spammers can't burn through object-storage quota.
  if (!(await enforceRateLimit(res, photoUploadUrlScopes(getClientIp(req), course.id)))) return;

  const { contentType, size } = req.body ?? {};
  if (contentType && !ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
    res.status(400).json({ error: "Unsupported image type. Allowed: JPEG, PNG, GIF, WebP" }); return;
  }
  if (size !== undefined && typeof size === "number" && size > MAX_IMAGE_BYTES) {
    res.status(400).json({ error: "Image too large. Maximum size is 10 MB." }); return;
  }
  try {
    const uploadURL = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    const uploadToken = signUploadPath(objectPath);
    res.json({ uploadURL, objectPath, uploadToken });
  } catch {
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

publicRouter.post("/clubs/:slug/courses/:courseSlug/photos", async (req, res) => {
  const org = await loadOrgBySlug((req.params as Record<string, string>).slug);
  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }
  const [course] = await db.select({ id: coursesTable.id, holes: coursesTable.holes })
    .from(coursesTable)
    .where(and(
      eq(coursesTable.organizationId, org.id),
      eq(coursesTable.slug, (req.params as Record<string, string>).courseSlug),
      eq(coursesTable.isPublic, true),
    ));
  if (!course) { { res.status(404).json({ error: "Course not found" }); return; } }

  // Task #626 — throttle public photo submissions per IP + per course so
  // spammers can't flood the moderation queue with junk photos.
  if (!(await enforceRateLimit(res, photoSubmitScopes(getClientIp(req), course.id)))) return;

  const b = req.body ?? {};
  if (typeof b.objectPath !== "string" || !b.objectPath) {
    res.status(400).json({ error: "objectPath is required" }); return;
  }
  if (typeof b.uploadToken !== "string" || !verifyUploadToken(b.objectPath, b.uploadToken)) {
    res.status(403).json({ error: "Invalid or missing upload token" }); return;
  }

  // Validate stored object: image content-type + size limit.
  let storedContentType = "";
  try {
    const objFile = await storage.getObjectEntityFile(b.objectPath);
    const [meta] = await objFile.getMetadata();
    storedContentType = (meta.contentType as string) || "";
    const storedSize = meta.size ? Number(meta.size) : 0;
    if (storedSize > MAX_IMAGE_BYTES) {
      res.status(400).json({ error: "Image exceeds the 10 MB maximum size" }); return;
    }
  } catch {
    res.status(404).json({ error: "Uploaded object not found" }); return;
  }
  if (storedContentType && !ALLOWED_IMAGE_CONTENT_TYPES.has(storedContentType)) {
    res.status(400).json({ error: "Unsupported image type. Allowed: JPEG, PNG, GIF, WebP" }); return;
  }

  // Mark publicly readable so admins (and the live page once approved)
  // can fetch it through the storage GET route.
  try {
    await storage.trySetObjectEntityAclPolicy(b.objectPath, {
      owner: `org:${org.id}`,
      visibility: "public",
    });
  } catch {
    res.status(500).json({ error: "Failed to mark image as public" }); return;
  }

  const u = getUser(req);
  const uploaderName = typeof b.uploaderName === "string" ? b.uploaderName.trim().slice(0, 80) : "";
  const caption = typeof b.caption === "string" ? b.caption.slice(0, 500) : null;
  let holeNumber: number | null = null;
  if (b.holeNumber != null && b.holeNumber !== "") {
    const n = parseInt(String(b.holeNumber));
    const max = course.holes ?? 99;
    if (!Number.isFinite(n) || n < 1 || n > max) {
      res.status(400).json({ error: `holeNumber must be between 1 and ${max}` }); return;
    }
    holeNumber = n;
  }
  // Anonymous submitters must give a name so admins can credit/audit.
  if (!u && !uploaderName) {
    res.status(400).json({ error: "uploaderName is required for anonymous submissions" }); return;
  }

  // Auto-approve when the authenticated submitter is a club admin for this
  // org (or a super-admin), mirroring the admin upload route.
  const isClubAdminUser =
    !!u && (
      u.role === "super_admin"
      || (["org_admin", "tournament_director"].includes(u.role ?? "") && u.organizationId === org.id)
    );

  const [created] = await db.insert(mediaTable).values({
    organizationId: org.id,
    courseId: course.id,
    objectPath: b.objectPath,
    caption,
    holeNumber,
    isHero: false,
    mediaType: "image",
    uploadedByUserId: u?.id ?? null,
    uploaderName: uploaderName || null,
    approved: isClubAdminUser,
  }).returning({ id: mediaTable.id, approved: mediaTable.approved });

  res.status(201).json({
    id: created.id,
    approved: created.approved,
    status: created.approved ? "approved" : "pending",
  });
});

publicRouter.post("/course-reviews/:reviewId/report", async (req, res) => {
  const reviewId = parseInt(String((req.params as Record<string, string>).reviewId));
  if (!Number.isFinite(reviewId)) { { res.status(400).json({ error: "Invalid review id" }); return; } }
  const [review] = await db.select({ id: courseReviewsTable.id })
    .from(courseReviewsTable).where(eq(courseReviewsTable.id, reviewId));
  if (!review) { { res.status(404).json({ error: "Review not found" }); return; } }

  // Task #626 — throttle review-report submissions per IP so spammers
  // can't flood the moderation queue with bogus reports.
  if (!(await enforceRateLimit(res, reviewReportScopes(getClientIp(req), reviewId)))) return;

  const b = req.body ?? {};
  const reason = (typeof b.reason === "string" ? b.reason : "").slice(0, 1000);
  if (!reason) { { res.status(400).json({ error: "reason is required" }); return; } }
  const reporterEmail = typeof b.reporterEmail === "string" ? b.reporterEmail.slice(0, 200) : null;
  const u = getUser(req);

  await db.insert(courseReviewReportsTable).values({
    reviewId,
    reporterUserId: u?.id ?? null,
    reporterEmail,
    reason,
  });

  // Bump the abuse count; admin moderation queue surfaces high-count rows.
  await db
    .update(courseReviewsTable)
    .set({ abuseReportCount: sql`${courseReviewsTable.abuseReportCount} + 1` })
    .where(eq(courseReviewsTable.id, reviewId));

  res.status(202).json({ ok: true });
});

/* ── Admin: course public-page management & moderation ──────────────── */

router.patch("/courses/:courseId/public-fields", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  const [course] = await db.select().from(coursesTable)
    .where(and(eq(coursesTable.id, courseId), eq(coursesTable.organizationId, orgId)));
  if (!course) { { res.status(404).json({ error: "Course not found" }); return; } }

  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  for (const k of ["description", "heroImageUrl", "designer", "contactPhone", "contactEmail", "teeTimeCtaUrl"]) {
    if (b[k] !== undefined) patch[k] = b[k] === "" ? null : b[k];
  }
  if (b.yearOpened !== undefined) patch.yearOpened = b.yearOpened == null ? null : parseInt(b.yearOpened);
  if (b.isPublic !== undefined) patch.isPublic = !!b.isPublic;
  if (b.awards !== undefined) {
    if (!Array.isArray(b.awards)) { { res.status(400).json({ error: "awards must be an array of strings" }); return; } }
    patch.awards = b.awards.filter((a: unknown): a is string => typeof a === "string");
  }
  if (b.slug !== undefined) {
    const cleaned = String(b.slug).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 80);
    if (!cleaned) { { res.status(400).json({ error: "slug cannot be empty" }); return; } }
    patch.slug = cleaned;
  }
  const [updated] = await db.update(coursesTable).set(patch).where(eq(coursesTable.id, courseId)).returning();

  // Task #632 — Bust the marketing-website's prerendered SSR cache so admins
  // see their edits immediately rather than waiting for the ~60s TTL. Purge
  // both the old and new slugs in case the slug itself was renamed. Looks up
  // the org slug here (joining org would have been overkill on the read).
  const [org] = await db
    .select({ slug: organizationsTable.slug })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (org?.slug) {
    const slugs = new Set<string>([course.slug]);
    if (typeof patch.slug === "string") slugs.add(patch.slug);
    for (const s of slugs) {
      void purgeMarketingSiteCourseCache(org.slug, s);
    }
  }

  res.json(updated);
});

/**
 * Task #632 — Best-effort POST to the marketing website's `/__ssr/purge`
 * endpoint. Authenticated by a shared secret. We never fail the parent
 * request on purge errors — the cache will fall back to its short TTL.
 *
 * Required env (both must be set, otherwise this is a no-op):
 *   - MARKETING_SITE_INTERNAL_URL  e.g. http://localhost:3001  or  https://kharagolf.com
 *   - SSR_CACHE_PURGE_TOKEN        shared secret matching the website's env
 */
async function purgeMarketingSiteCourseCache(clubSlug: string, courseSlug: string): Promise<void> {
  await postSsrPurge({ clubSlug, courseSlug, kind: "course" });
}

/**
 * Task #792 — Best-effort POST to invalidate the marketing website's
 * prerendered club-page cache. Called from every endpoint that bumps
 * the marketing-site `cacheVersion` (save, publish, unpublish, custom
 * domain change) so admins and search engines see the updated club
 * page on the next request rather than waiting for the short TTL.
 *
 * Same env requirements / failure semantics as the course variant.
 */
async function purgeMarketingSiteClubCache(clubSlug: string): Promise<void> {
  await postSsrPurge({ clubSlug, kind: "club" });
}

async function postSsrPurge(body: {
  clubSlug?: string;
  courseSlug?: string;
  kind?: "club" | "course";
  all?: boolean;
}): Promise<void> {
  const baseUrl = process.env.MARKETING_SITE_INTERNAL_URL;
  const token = process.env.SSR_CACHE_PURGE_TOKEN;
  if (!baseUrl || !token) return;
  const url = `${baseUrl.replace(/\/$/, "")}/__ssr/purge`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_000);
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ssr-purge-token": token,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.warn("[ssr-cache] purge failed", { url, body, err: (err as Error).message });
  }
}

/**
 * Task #792 — Look up an org's slug for purge calls. Returns null when
 * the org doesn't exist (purge is then a no-op).
 */
async function lookupOrgSlug(orgId: number): Promise<string | null> {
  const [org] = await db
    .select({ slug: organizationsTable.slug })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  return org?.slug ?? null;
}

/**
 * Task #798 — Best-effort purge of the prerendered course-page cache for a
 * batch of course IDs (deduped). Used by review and photo moderation
 * endpoints so newly-approved/rejected content shows up to crawlers
 * immediately rather than waiting for the ~60s TTL. Single-row endpoints
 * pass a one-element array; bulk endpoints pass the affected courseIds and
 * we dedupe so each course is purged exactly once.
 *
 * Fire-and-forget — never fails the parent request. Course IDs are filtered
 * to the supplied org so a stale row can't trigger a cross-tenant purge.
 */
async function purgeMarketingSiteCoursesByIds(
  orgId: number,
  courseIds: ReadonlyArray<number | null | undefined>,
): Promise<void> {
  const unique = Array.from(new Set(
    courseIds.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0),
  ));
  if (unique.length === 0) return;
  try {
    const rows = await db
      .select({
        courseId: coursesTable.id,
        courseSlug: coursesTable.slug,
        orgSlug: organizationsTable.slug,
      })
      .from(coursesTable)
      .innerJoin(organizationsTable, eq(organizationsTable.id, coursesTable.organizationId))
      .where(and(
        eq(coursesTable.organizationId, orgId),
        inArray(coursesTable.id, unique),
      ));
    for (const r of rows) {
      void purgeMarketingSiteCourseCache(r.orgSlug, r.courseSlug);
    }
  } catch (err) {
    console.warn("[ssr-cache] course purge dispatch failed", {
      orgId, courseIds: unique, err: (err as Error).message,
    });
  }
}

router.get("/course-reviews", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const status = String(req.query.status ?? "pending");
  const reviews = await db
    .select({
      id: courseReviewsTable.id,
      courseId: courseReviewsTable.courseId,
      rating: courseReviewsTable.rating,
      title: courseReviewsTable.title,
      body: courseReviewsTable.body,
      reviewerDisplayName: courseReviewsTable.reviewerDisplayName,
      reviewerEmail: courseReviewsTable.reviewerEmail,
      displayMode: courseReviewsTable.displayMode,
      status: courseReviewsTable.status,
      abuseReportCount: courseReviewsTable.abuseReportCount,
      createdAt: courseReviewsTable.createdAt,
      adminReply: courseReviewsTable.adminReply,
      adminReplyAt: courseReviewsTable.adminReplyAt,
    })
    .from(courseReviewsTable)
    .where(and(eq(courseReviewsTable.organizationId, orgId), eq(courseReviewsTable.status, status)))
    .orderBy(desc(courseReviewsTable.abuseReportCount), desc(courseReviewsTable.createdAt))
    .limit(200);
  res.json(reviews);
});

// Task #628 — admin posts (or clears) a public reply on a review.
// Body: { reply: string | null }. Empty string / null clears the reply.
router.put("/course-reviews/:reviewId/reply", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const reviewId = parseInt(String((req.params as Record<string, string>).reviewId));
  if (!Number.isFinite(reviewId)) { { res.status(400).json({ error: "Invalid review id" }); return; } }
  const u = getUser(req);
  const raw = req.body?.reply;
  let reply: string | null = null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    reply = trimmed.length === 0 ? null : trimmed.slice(0, 2000);
  } else if (raw != null) {
    res.status(400).json({ error: "reply must be a string or null" });
    return;
  }
  const [updated] = await db
    .update(courseReviewsTable)
    .set({
      adminReply: reply,
      adminReplyAt: reply ? new Date() : null,
      adminReplyByUserId: reply ? (u?.id ?? null) : null,
    })
    .where(and(eq(courseReviewsTable.id, reviewId), eq(courseReviewsTable.organizationId, orgId)))
    .returning();
  if (!updated) { { res.status(404).json({ error: "Review not found" }); return; } }
  // Task #789 — email the original reviewer when a reply is set or updated.
  // Cleared replies (reply === null) are skipped, and anonymous reviewers
  // without a reviewer_email are skipped silently inside the helper.
  // Fire-and-forget: a notification failure must not fail the admin save.
  if (reply) {
    notifyCourseReviewReplyPosted(updated.id).catch(() => { /* logged inside */ });
  }
  res.json(updated);
});

router.patch("/course-reviews/:reviewId", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const reviewId = parseInt(String((req.params as Record<string, string>).reviewId));
  const u = getUser(req);
  const b = req.body ?? {};
  const allowed = new Set(["approved", "rejected", "hidden", "pending"]);
  if (!allowed.has(b.status)) { { res.status(400).json({ error: `status must be one of ${[...allowed].join(", ")}` }); return; } }
  const [updated] = await db
    .update(courseReviewsTable)
    .set({
      status: b.status,
      moderationNote: typeof b.moderationNote === "string" ? b.moderationNote.slice(0, 1000) : null,
      moderatedByUserId: u?.id ?? null,
      moderatedAt: new Date(),
    })
    .where(and(eq(courseReviewsTable.id, reviewId), eq(courseReviewsTable.organizationId, orgId)))
    .returning();
  if (!updated) { { res.status(404).json({ error: "Review not found" }); return; } }

  // Task #798 — Bust the prerendered course-page cache so newly-approved
  // (or newly-hidden) reviews show up to crawlers immediately rather than
  // waiting for the ~60s TTL.
  void purgeMarketingSiteCoursesByIds(orgId, [updated.courseId]);

  res.json(updated);
});

router.get("/course-photos", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const status = String(req.query.status ?? "pending");
  const approved = status === "approved";
  const rows = await db
    .select()
    .from(mediaTable)
    .where(and(
      eq(mediaTable.organizationId, orgId),
      eq(mediaTable.approved, approved),
      sql`${mediaTable.courseId} is not null`,
    ))
    .orderBy(desc(mediaTable.createdAt))
    .limit(200);
  res.json(rows);
});

router.patch("/course-photos/:mediaId", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const mediaId = parseInt(String((req.params as Record<string, string>).mediaId));
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.approved !== undefined) patch.approved = !!b.approved;
  if (b.caption !== undefined) patch.caption = b.caption === "" ? null : String(b.caption).slice(0, 500);
  if (b.holeNumber !== undefined) patch.holeNumber = b.holeNumber == null ? null : parseInt(b.holeNumber);
  if (b.isHero !== undefined) patch.isHero = !!b.isHero;
  const [updated] = await db.update(mediaTable).set(patch)
    .where(and(eq(mediaTable.id, mediaId), eq(mediaTable.organizationId, orgId)))
    .returning();
  if (!updated) { { res.status(404).json({ error: "Photo not found" }); return; } }

  // Task #798 — Bust the prerendered course-page cache so newly-approved
  // (or hidden / re-captioned / hero-toggled) photos are visible to
  // crawlers immediately. Skips the dispatch when the photo isn't tied
  // to a course (purgeMarketingSiteCoursesByIds filters non-positive ids).
  void purgeMarketingSiteCoursesByIds(orgId, [updated.courseId]);

  res.json(updated);
});

router.delete("/course-photos/:mediaId", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const mediaId = parseInt(String((req.params as Record<string, string>).mediaId));
  const r = await db.delete(mediaTable)
    .where(and(eq(mediaTable.id, mediaId), eq(mediaTable.organizationId, orgId)))
    .returning({ id: mediaTable.id, courseId: mediaTable.courseId });
  if (!r.length) { { res.status(404).json({ error: "Photo not found" }); return; } }

  // Task #798 — A delete here is the per-row reject UX, so purge the
  // course page that previously showed this photo.
  void purgeMarketingSiteCoursesByIds(orgId, [r[0].courseId]);

  res.status(204).end();
});

/**
 * Bulk-moderate pending course reviews in one request (Task #629).
 *
 * Mirrors the documents bulk-verify/reject contract: per-row failures (not
 * found, wrong org, already in the target state) are surfaced individually
 * so the batch never aborts on the first stale row. Org-scope is always
 * enforced via the organizationId filter on every update.
 */
router.post("/course-reviews/moderate-bulk", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const u = getUser(req);

  const rawIds = Array.isArray(req.body?.reviewIds) ? req.body.reviewIds : null;
  if (!rawIds || rawIds.length === 0) {
    res.status(400).json({ error: "reviewIds (non-empty array) is required." }); return;
  }
  if (rawIds.length > 200) {
    res.status(400).json({ error: "Cannot moderate more than 200 reviews in one request." }); return;
  }
  const allowed = new Set(["approved", "rejected", "hidden"]);
  const status = String(req.body?.status ?? "");
  if (!allowed.has(status)) {
    res.status(400).json({ error: `status must be one of ${[...allowed].join(", ")}` }); return;
  }

  const ids: number[] = [];
  for (const v of rawIds) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  if (ids.length === 0) { { res.status(400).json({ error: "No valid reviewIds supplied." }); return; } }

  const existing = await db.select().from(courseReviewsTable)
    .where(and(
      eq(courseReviewsTable.organizationId, orgId),
      inArray(courseReviewsTable.id, ids),
    ));
  const byId = new Map(existing.map((r) => [r.id, r]));

  const updated: Array<{ id: number; courseId: number; status: string }> = [];
  const errors: Array<{ reviewId: number; error: string }> = [];
  const now = new Date();

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) { errors.push({ reviewId: id, error: "Review not found in this organization." }); continue; }
    if (row.status === status) { errors.push({ reviewId: id, error: `Review is already ${status}.` }); continue; }
    try {
      const [r] = await db.update(courseReviewsTable)
        .set({ status, moderatedByUserId: u?.id ?? null, moderatedAt: now })
        .where(and(
          eq(courseReviewsTable.id, id),
          eq(courseReviewsTable.organizationId, orgId),
        ))
        .returning();
      if (!r) { errors.push({ reviewId: id, error: "Review state changed before it could be updated." }); continue; }
      updated.push({ id: r.id, courseId: r.courseId, status: r.status });
    } catch {
      errors.push({ reviewId: id, error: "Internal error while updating this review." });
    }
  }

  // Task #798 — Purge the prerendered course-page cache once per affected
  // course (deduped) so newly-approved or hidden reviews are visible to
  // crawlers immediately rather than waiting for the ~60s TTL.
  void purgeMarketingSiteCoursesByIds(orgId, updated.map(u => u.courseId));

  res.json({
    updatedCount: updated.length,
    errorCount: errors.length,
    status,
    updated,
    errors,
  });
});

/**
 * Bulk-moderate pending course photos in one request (Task #629).
 *
 * `action: "approve"` flips approved=true on each row.
 * `action: "reject"` deletes the rows, matching the per-row reject UX which
 * has always been a hard delete (there's no soft-rejected state on media).
 */
router.post("/course-photos/moderate-bulk", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const rawIds = Array.isArray(req.body?.photoIds) ? req.body.photoIds : null;
  if (!rawIds || rawIds.length === 0) {
    res.status(400).json({ error: "photoIds (non-empty array) is required." }); return;
  }
  if (rawIds.length > 200) {
    res.status(400).json({ error: "Cannot moderate more than 200 photos in one request." }); return;
  }
  const action = String(req.body?.action ?? "");
  if (action !== "approve" && action !== "reject") {
    res.status(400).json({ error: "action must be 'approve' or 'reject'." }); return;
  }

  const ids: number[] = [];
  for (const v of rawIds) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  if (ids.length === 0) { { res.status(400).json({ error: "No valid photoIds supplied." }); return; } }

  const existing = await db.select().from(mediaTable)
    .where(and(
      eq(mediaTable.organizationId, orgId),
      inArray(mediaTable.id, ids),
    ));
  const byId = new Map(existing.map((m) => [m.id, m]));

  const updated: Array<{ id: number; courseId: number | null }> = [];
  const errors: Array<{ photoId: number; error: string }> = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) { errors.push({ photoId: id, error: "Photo not found in this organization." }); continue; }
    try {
      if (action === "approve") {
        if (row.approved) { errors.push({ photoId: id, error: "Photo is already approved." }); continue; }
        const [r] = await db.update(mediaTable)
          .set({ approved: true })
          .where(and(eq(mediaTable.id, id), eq(mediaTable.organizationId, orgId)))
          .returning();
        if (!r) { errors.push({ photoId: id, error: "Photo state changed before it could be approved." }); continue; }
        updated.push({ id: r.id, courseId: r.courseId });
      } else {
        const r = await db.delete(mediaTable)
          .where(and(eq(mediaTable.id, id), eq(mediaTable.organizationId, orgId)))
          .returning({ id: mediaTable.id, courseId: mediaTable.courseId });
        if (!r.length) { errors.push({ photoId: id, error: "Photo state changed before it could be deleted." }); continue; }
        updated.push({ id: r[0].id, courseId: r[0].courseId });
      }
    } catch {
      errors.push({ photoId: id, error: `Internal error while ${action === "approve" ? "approving" : "deleting"} this photo.` });
    }
  }

  // Task #798 — Purge the prerendered course-page cache once per affected
  // course (deduped) so newly-approved (or rejected/deleted) photos are
  // visible to crawlers immediately rather than waiting for the ~60s TTL.
  void purgeMarketingSiteCoursesByIds(orgId, updated.map(u => u.courseId));

  res.json({
    updatedCount: updated.length,
    errorCount: errors.length,
    action,
    updated,
    errors,
  });
});

router.post("/courses/:courseId/photos", async (req, res) => {
  if (!requireSiteAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  const b = req.body ?? {};
  if (typeof b.objectPath !== "string" || !b.objectPath) {
    res.status(400).json({ error: "objectPath is required" }); return;
  }
  const u = getUser(req);
  const [created] = await db.insert(mediaTable).values({
    organizationId: orgId,
    courseId,
    objectPath: b.objectPath,
    thumbnailPath: typeof b.thumbnailPath === "string" ? b.thumbnailPath : null,
    caption: typeof b.caption === "string" ? b.caption.slice(0, 500) : null,
    holeNumber: b.holeNumber == null ? null : parseInt(b.holeNumber),
    isHero: !!b.isHero,
    mediaType: typeof b.mediaType === "string" ? b.mediaType : "image",
    uploadedByUserId: u?.id ?? null,
    uploaderName: typeof b.uploaderName === "string" ? b.uploaderName : null,
    approved: true, // admin-uploaded photos skip moderation
  }).returning();
  res.status(201).json(created);
});

publicRouter.get("/sitemap.xml", async (req, res) => {
  // Sitemap of all published club sites + their key sub-pages on the
  // marketing website (tournaments registration deep links).
  const rows = await db
    .select({
      slug: organizationsTable.slug,
      customDomain: organizationsTable.customDomain,
      updatedAt: clubMarketingSitesTable.updatedAt,
    })
    .from(clubMarketingSitesTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, clubMarketingSitesTable.organizationId))
    .where(and(
      eq(clubMarketingSitesTable.isPublished, true),
      eq(organizationsTable.isActive, true),
    ));

  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "kharagolf.com";
  const base = `${proto}://${host}`;

  // Task #438 — When a club has a custom domain set, the canonical URL
  // for its mini-site is the root of that domain rather than a path on
  // the main marketing site. The sitemap reflects that mapping so the
  // correct URLs get indexed.
  const customDomainBySlug = new Map<string, string>();
  for (const r of rows) {
    const host = normalizeHost(r.customDomain);
    if (host) customDomainBySlug.set(r.slug, `https://${host}`);
  }
  // Club home: when a custom domain is set the mini-site is served at
  // the root of that domain. Sub-pages (e.g. course detail) keep the
  // existing `/clubs/<slug>/...` path since the SPA routes them by
  // path on every host.
  const clubHomeUrl = (slug: string) => customDomainBySlug.get(slug) ?? `${base}/clubs/${slug}`;
  const clubPathUrl = (slug: string, sub: string) =>
    `${customDomainBySlug.get(slug) ?? base}/clubs/${slug}${sub}`;

  // Include public course pages alongside the club home pages so search
  // engines can crawl /clubs/<slug>/courses/<courseSlug>.
  const courseRows = rows.length
    ? await db
        .select({
          orgSlug: organizationsTable.slug,
          courseSlug: coursesTable.slug,
          createdAt: coursesTable.createdAt,
        })
        .from(coursesTable)
        .innerJoin(organizationsTable, eq(organizationsTable.id, coursesTable.organizationId))
        .where(and(
          eq(coursesTable.isPublic, true),
          inArray(organizationsTable.slug, rows.map(r => r.slug)),
        ))
    : [];

  const urls = rows.map(r => `
    <url>
      <loc>${clubHomeUrl(r.slug)}</loc>
      <lastmod>${new Date(r.updatedAt).toISOString()}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.8</priority>
    </url>`).join("") + courseRows.map(c => `
    <url>
      <loc>${clubPathUrl(c.orgSlug, `/courses/${c.courseSlug}`)}</loc>
      <lastmod>${new Date(c.createdAt).toISOString()}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.7</priority>
    </url>`).join("");

  // Public player profiles (Task #383) — opt-in only.
  const profileRows = await db
    .select({ handle: appUsersTable.publicHandle, updatedAt: appUsersTable.updatedAt })
    .from(appUsersTable)
    .where(eq(appUsersTable.publicProfileEnabled, true))
    .limit(50000);
  const profileUrls = profileRows
    .filter(p => !!p.handle)
    .map(p => `
    <url>
      <loc>${base}/p/${p.handle}</loc>
      <lastmod>${new Date(p.updatedAt).toISOString()}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.6</priority>
    </url>`).join("");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>${urls}${profileUrls}
</urlset>`;

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(body);
});

export default router;
export { publicRouter as marketingSitePublicRouter };
