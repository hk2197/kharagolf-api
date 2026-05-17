/**
 * Task #477 — Express server that serves the KHARAGOLF marketing website
 * and server-renders public course pages so search engines see the full
 * content without executing JavaScript.
 *
 *   GET  /clubs/:clubSlug/courses/:courseSlug   → fetched + prerendered
 *   GET  *                                      → SPA shell (index.html)
 *
 * In development, Vite is mounted as middleware so HMR/asset transforms
 * still work for the React app. In production, the prebuilt static output
 * (`dist/public`) is served directly and the SSR injection happens against
 * that bundle.
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";

import {
  renderCourseBody,
  renderCourseHead,
  renderInitialDataScript,
  stripSiteDefaultHead,
  type CoursePageData,
} from "./src/lib/prerender-course.js";
import {
  renderClubBody,
  renderClubHead,
  renderInitialClubDataScript,
  stripSiteDefaultHead as stripClubDefaultHead,
  type ClubPageData,
} from "./src/lib/prerender-club.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rawPort = process.env.PORT;
if (!rawPort) throw new Error("PORT env var is required");
const PORT = Number(rawPort);
if (!Number.isFinite(PORT) || PORT <= 0) throw new Error(`Invalid PORT: ${rawPort}`);

const BASE_PATH = process.env.BASE_PATH || "/";
if (!BASE_PATH.startsWith("/") || !BASE_PATH.endsWith("/")) {
  throw new Error(`BASE_PATH must start and end with "/": got "${BASE_PATH}"`);
}
const BASE_NO_TRAIL = BASE_PATH.replace(/\/$/, "") || "";

const IS_PROD = process.env.NODE_ENV === "production";
const DIST_DIR = path.resolve(__dirname, "dist/public");
const SRC_INDEX = path.resolve(__dirname, "index.html");

function getApiBase(): string {
  // Prefer an explicit internal URL so SSR fetches don't loop through the
  // public proxy. Fall back to the deployment URL, then localhost for dev.
  const candidates = [
    process.env.API_INTERNAL_URL,
    process.env.APP_BASE_URL,
    process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : undefined,
    "http://localhost:8080",
  ];
  for (const c of candidates) {
    if (c && c.trim()) return c.replace(/\/$/, "");
  }
  return "http://localhost:8080";
}

/**
 * Task #632 / #792 — In-memory TTL cache for prerendered SSR pages.
 *
 * Crawlers (Googlebot et al.) often re-fetch the same page in tight bursts.
 * Without a cache every hit re-fetches the public API and re-runs the SSR
 * string assembly. The cache makes repeated requests for the same slug
 * within `CACHE_TTL_MS` essentially free.
 *
 * - Successful renders are cached. SPA-fallback responses (API down /
 *   timeout / 404) are never cached so transient upstream errors don't
 *   stick for the full TTL.
 * - Entries auto-expire by timestamp; we lazy-evict on read.
 * - `MAX_ENTRIES` bounds memory by dropping the oldest entry on overflow.
 * - The API server can POST `/__ssr/purge` (with `SSR_CACHE_PURGE_TOKEN`)
 *   to bust entries when content is edited or the marketing site is
 *   republished so admins see updates instantly rather than waiting for
 *   natural expiry.
 *
 * Two parallel caches: one for course pages (Task #632) keyed by
 * `${clubSlug}::${courseSlug}`, one for club pages (Task #792) keyed by
 * `${clubSlug}`. Both share the same entry shape and helpers.
 */
type SsrCacheEntry = {
  html: string;
  status: number;
  expiresAt: number;
  insertedAt: number;
  /** Published cacheVersion this entry was rendered from (club cache only). */
  cacheVersion?: number;
};

function readPositiveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const COURSE_CACHE_TTL_MS = readPositiveEnvNumber("SSR_COURSE_CACHE_TTL_MS", 60_000);
const COURSE_CACHE_MAX_ENTRIES = 500;
const courseSsrCache = new Map<string, SsrCacheEntry>();

const CLUB_CACHE_TTL_MS = readPositiveEnvNumber("SSR_CLUB_CACHE_TTL_MS", 60_000);
const CLUB_CACHE_MAX_ENTRIES = 500;
const clubSsrCache = new Map<string, SsrCacheEntry>();

function readCacheEntry(cache: Map<string, SsrCacheEntry>, key: string): SsrCacheEntry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit;
}
function writeCacheEntry(
  cache: Map<string, SsrCacheEntry>,
  maxEntries: number,
  key: string,
  entry: Omit<SsrCacheEntry, "expiresAt" | "insertedAt"> & { ttlMs: number },
): void {
  if (cache.size >= maxEntries && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  // Re-insert so the entry moves to the most-recent slot for LRU-ish eviction.
  cache.delete(key);
  const now = Date.now();
  cache.set(key, {
    html: entry.html,
    status: entry.status,
    cacheVersion: entry.cacheVersion,
    expiresAt: now + entry.ttlMs,
    insertedAt: now,
  });
}

function courseCacheKey(clubSlug: string, courseSlug: string): string {
  return `${clubSlug.toLowerCase()}::${courseSlug.toLowerCase()}`;
}
function readCourseCache(clubSlug: string, courseSlug: string): SsrCacheEntry | null {
  return readCacheEntry(courseSsrCache, courseCacheKey(clubSlug, courseSlug));
}
function writeCourseCache(clubSlug: string, courseSlug: string, html: string, status: number): void {
  writeCacheEntry(courseSsrCache, COURSE_CACHE_MAX_ENTRIES, courseCacheKey(clubSlug, courseSlug), {
    html,
    status,
    ttlMs: COURSE_CACHE_TTL_MS,
  });
}
/** Purge a single entry, every entry for a club, or the whole cache. */
function purgeCourseCache(opts: { clubSlug?: string; courseSlug?: string; all?: boolean }): number {
  if (opts.all) {
    const n = courseSsrCache.size;
    courseSsrCache.clear();
    return n;
  }
  if (opts.clubSlug && opts.courseSlug) {
    return courseSsrCache.delete(courseCacheKey(opts.clubSlug, opts.courseSlug)) ? 1 : 0;
  }
  if (opts.clubSlug) {
    const prefix = `${opts.clubSlug.toLowerCase()}::`;
    let n = 0;
    for (const k of [...courseSsrCache.keys()]) {
      if (k.startsWith(prefix)) { courseSsrCache.delete(k); n++; }
    }
    return n;
  }
  return 0;
}

/**
 * Task #792 — Club page cache. Keyed on the lowercased club slug. The
 * stored entry remembers the published `cacheVersion` it was rendered
 * from so we can surface it via the `X-SSR-Cache-Version` response
 * header for observability and so callers can confirm an invalidation
 * actually took effect.
 */
function clubCacheKey(clubSlug: string): string {
  return clubSlug.toLowerCase();
}
function readClubCache(clubSlug: string): SsrCacheEntry | null {
  return readCacheEntry(clubSsrCache, clubCacheKey(clubSlug));
}
function writeClubCache(clubSlug: string, html: string, status: number, cacheVersion: number | undefined): void {
  writeCacheEntry(clubSsrCache, CLUB_CACHE_MAX_ENTRIES, clubCacheKey(clubSlug), {
    html,
    status,
    cacheVersion,
    ttlMs: CLUB_CACHE_TTL_MS,
  });
}
function purgeClubCache(opts: { clubSlug?: string; all?: boolean }): number {
  if (opts.all) {
    const n = clubSsrCache.size;
    clubSsrCache.clear();
    return n;
  }
  if (opts.clubSlug) {
    return clubSsrCache.delete(clubCacheKey(opts.clubSlug)) ? 1 : 0;
  }
  return 0;
}
function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function publicOriginFromRequest(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim()
    || (req.protocol ?? "https");
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim()
    || req.headers.host
    || "";
  return `${proto}://${host}`;
}

export interface CreateAppOptions {
  /** Skip mounting Vite middleware (and the dev SPA fallback). Useful for tests. */
  withoutVite?: boolean;
}

export async function createApp(options: CreateAppOptions = {}): Promise<Express> {
  const app = express();
  app.disable("x-powered-by");

  let vite: import("vite").ViteDevServer | null = null;
  if (!IS_PROD && !options.withoutVite) {
    const { createServer } = await import("vite");
    vite = await createServer({
      configFile: path.resolve(__dirname, "vite.config.ts"),
      server: { middlewareMode: true, host: "0.0.0.0" },
      appType: "custom",
      base: BASE_PATH,
    });
  }

  // Task #632 — Internal purge endpoint. Mounted BEFORE the SSR route so a
  // poorly-configured BASE_PATH can't accidentally route purge calls into
  // the catch-all SPA fallback. Auth: shared-secret header. If the env var
  // is not set, the endpoint refuses every request (cache still works via
  // natural TTL expiry).
  app.post(`${BASE_NO_TRAIL}/__ssr/purge`, express.json({ limit: "8kb" }), (req, res) => {
    const expected = process.env.SSR_CACHE_PURGE_TOKEN ?? "";
    const provided = String(req.headers["x-ssr-purge-token"] ?? "");
    if (!expected || !provided || !tokensMatch(expected, provided)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const b = (req.body ?? {}) as {
      clubSlug?: unknown;
      courseSlug?: unknown;
      kind?: unknown;
      all?: unknown;
    };
    const clubSlug = typeof b.clubSlug === "string" && b.clubSlug ? b.clubSlug : undefined;
    const courseSlug = typeof b.courseSlug === "string" && b.courseSlug ? b.courseSlug : undefined;
    const all = b.all === true;
    // `kind` narrows which cache(s) to purge. Default behavior (no kind):
    //   - all:true                 → purge BOTH caches
    //   - clubSlug + courseSlug    → purge that course entry
    //   - clubSlug only            → purge the club entry AND every course
    //                                under that club (since republishing or
    //                                editing the marketing site also affects
    //                                the courses-list block on the club page)
    const rawKind = typeof b.kind === "string" ? b.kind.toLowerCase() : "";
    const kind: "club" | "course" | "both" =
      rawKind === "club" ? "club" : rawKind === "course" ? "course" : "both";
    if (!all && !clubSlug) {
      res.status(400).json({ error: "Provide { all: true } or { clubSlug, courseSlug?, kind? }" });
      return;
    }
    let purgedCourse = 0;
    let purgedClub = 0;
    if (kind === "course" || kind === "both") {
      purgedCourse = purgeCourseCache({ clubSlug, courseSlug, all });
    }
    if (kind === "club" || kind === "both") {
      // Course slug is meaningless for club entries — ignore it here.
      purgedClub = purgeClubCache({ clubSlug, all });
    }
    res.json({ purged: purgedCourse + purgedClub, purgedCourse, purgedClub });
  });

  // Course SSR — registered BEFORE vite so vite's middleware can't intercept
  // the page request. Anything else falls through to the SPA shell.
  const courseRoute = `${BASE_NO_TRAIL}/clubs/:clubSlug/courses/:courseSlug`;
  app.get(courseRoute, async (req, res, next) => {
    try {
      await handleCourseSSR(req, res, vite);
    } catch (err) {
      if (vite) vite.ssrFixStacktrace(err as Error);
      console.error("[ssr] course page failed", err);
      next(err);
    }
  });

  // Task #631 — Club SSR. Registered AFTER the course route so the more
  // specific path takes priority, and BEFORE vite middleware so the page
  // request isn't intercepted.
  const clubRoute = `${BASE_NO_TRAIL}/clubs/:clubSlug`;
  app.get(clubRoute, async (req, res, next) => {
    try {
      await handleClubSSR(req, res, vite);
    } catch (err) {
      if (vite) vite.ssrFixStacktrace(err as Error);
      console.error("[ssr] club page failed", err);
      next(err);
    }
  });

  if (vite) {
    app.use(vite.middlewares);
  }

  if (IS_PROD) {
    // Serve hashed assets (JS/CSS/images) under the artifact's base path.
    app.use(
      BASE_PATH,
      express.static(DIST_DIR, {
        index: false,
        maxAge: "1h",
        setHeaders: (res, filePath) => {
          if (/\.[a-f0-9]{8,}\.(js|css|woff2?|png|jpg|jpeg|svg|webp)$/i.test(filePath)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );

    // SPA fallback for everything else under the base path. Express 5 uses
    // path-to-regexp v8 which requires named wildcards instead of `*`.
    app.get("/{*splat}", async (_req, res, next) => {
      try {
        const html = await fs.readFile(path.join(DIST_DIR, "index.html"), "utf-8");
        res
          .status(200)
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .setHeader("Cache-Control", "public, max-age=60")
          .send(html);
      } catch (err) {
        next(err);
      }
    });
  } else {
    // Dev SPA fallback — feed the source index.html through Vite so HMR works.
    app.use(async (req, res, next) => {
      try {
        let template = await fs.readFile(SRC_INDEX, "utf-8");
        template = await vite!.transformIndexHtml(req.originalUrl, template);
        res
          .status(200)
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .send(template);
      } catch (err) {
        if (vite) vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });
  }

  return app;
}

async function start() {
  const app = await createApp();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `[kharagolf-website] listening on :${PORT} (base=${BASE_PATH}, mode=${IS_PROD ? "production" : "development"})`,
    );
  });
}

async function handleCourseSSR(
  req: Request,
  res: Response,
  vite: import("vite").ViteDevServer | null,
): Promise<void> {
  const { clubSlug, courseSlug } = req.params as { clubSlug: string; courseSlug: string };

  // Task #632 — Serve repeat hits from the in-memory cache. Bypass the cache
  // when an admin appends `?nocache=1` so editors can force a fresh render.
  const bypass = req.query.nocache === "1";
  if (!bypass) {
    const cached = readCourseCache(clubSlug, courseSlug);
    if (cached) {
      res
        .status(cached.status)
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=600")
        .setHeader("X-SSR", "course")
        .setHeader("X-SSR-Cache", "hit")
        .send(cached.html);
      return;
    }
  }

  const apiUrl = `${getApiBase()}/api/public/clubs/${encodeURIComponent(clubSlug)}/courses/${encodeURIComponent(courseSlug)}`;

  let data: CoursePageData | null = null;
  let upstreamStatus = 0;
  try {
    // Cap the upstream fetch so a slow/failed API never blocks the response.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const resp = await fetch(apiUrl, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    upstreamStatus = resp.status;
    if (resp.ok) {
      data = (await resp.json()) as CoursePageData;
    }
  } catch (err) {
    console.warn("[ssr] upstream fetch failed", { apiUrl, err: (err as Error).message });
  }

  // If the API is unhappy, fall back to the SPA shell so the React app can
  // render its own loading / not-found UI. The page is still served, just
  // without prerendered content for that one request.
  if (!data) {
    await sendSpaShell(req, res, vite, upstreamStatus === 404 ? 404 : 200);
    return;
  }

  const template = await loadIndexTemplate(req, vite);
  const stripped = stripSiteDefaultHead(template);
  const canonicalUrl = `${publicOriginFromRequest(req)}${req.path}`;
  const headHtml = renderCourseHead(data, canonicalUrl);
  const bodyHtml = renderCourseBody(data);
  const initialData = renderInitialDataScript(data, req.path);

  let html = stripped.replace("</head>", `    ${headHtml}\n  </head>`);
  if (html.includes('<div id="root"></div>')) {
    html = html.replace(
      '<div id="root"></div>',
      `<div id="root">${bodyHtml}</div>\n    ${initialData}`,
    );
  } else {
    // Defensive: if the index template ever changes, still inject the data.
    html = html.replace("</body>", `    ${initialData}\n  </body>`);
  }

  // Task #632 — Cache the assembled HTML for subsequent crawler hits within
  // the TTL window. SPA-fallback paths above never reach this point so we
  // only cache real prerendered renders.
  writeCourseCache(clubSlug, courseSlug, html, 200);

  res
    .status(200)
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=600")
    .setHeader("X-SSR", "course")
    .setHeader("X-SSR-Cache", "miss")
    .send(html);
}

async function handleClubSSR(
  req: Request,
  res: Response,
  vite: import("vite").ViteDevServer | null,
): Promise<void> {
  const { clubSlug } = req.params as { clubSlug: string };

  // Task #792 — Serve repeat hits from the in-memory cache. Bypass with
  // `?nocache=1` so editors can force a fresh render.
  const bypass = req.query.nocache === "1";
  if (!bypass) {
    const cached = readClubCache(clubSlug);
    if (cached) {
      const r = res
        .status(cached.status)
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=600")
        .setHeader("X-SSR", "club")
        .setHeader("X-SSR-Cache", "hit");
      if (cached.cacheVersion !== undefined) {
        r.setHeader("X-SSR-Cache-Version", String(cached.cacheVersion));
      }
      r.send(cached.html);
      return;
    }
  }

  const apiUrl = `${getApiBase()}/api/public/clubs/${encodeURIComponent(clubSlug)}/site`;

  let data: ClubPageData | null = null;
  let upstreamStatus = 0;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const resp = await fetch(apiUrl, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    upstreamStatus = resp.status;
    if (resp.ok) {
      data = (await resp.json()) as ClubPageData;
    }
  } catch (err) {
    console.warn("[ssr] club upstream fetch failed", { apiUrl, err: (err as Error).message });
  }

  if (!data) {
    await sendSpaShell(req, res, vite, upstreamStatus === 404 ? 404 : 200);
    return;
  }

  const template = await loadIndexTemplate(req, vite);
  const stripped = stripClubDefaultHead(template);
  const canonicalUrl = `${publicOriginFromRequest(req)}${req.path}`;
  const headHtml = renderClubHead(data, canonicalUrl);
  const bodyHtml = renderClubBody(data);
  const initialData = renderInitialClubDataScript(data, req.path);

  let html = stripped.replace("</head>", `    ${headHtml}\n  </head>`);
  if (html.includes('<div id="root"></div>')) {
    html = html.replace(
      '<div id="root"></div>',
      `<div id="root">${bodyHtml}</div>\n    ${initialData}`,
    );
  } else {
    html = html.replace("</body>", `    ${initialData}\n  </body>`);
  }

  // Task #792 — Cache the assembled HTML for subsequent crawler hits within
  // the TTL window. SPA-fallback paths above never reach this point so we
  // only cache real prerendered renders. Stash the published cacheVersion
  // so we can surface it via response headers and confirm invalidations.
  const cacheVersion = typeof data.site?.cacheVersion === "number" ? data.site.cacheVersion : undefined;
  writeClubCache(clubSlug, html, 200, cacheVersion);

  const r = res
    .status(200)
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=600")
    .setHeader("X-SSR", "club")
    .setHeader("X-SSR-Cache", "miss");
  if (cacheVersion !== undefined) {
    r.setHeader("X-SSR-Cache-Version", String(cacheVersion));
  }
  r.send(html);
}

async function sendSpaShell(
  req: Request,
  res: Response,
  vite: import("vite").ViteDevServer | null,
  status: number,
): Promise<void> {
  const template = await loadIndexTemplate(req, vite);
  res
    .status(status)
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .setHeader("Cache-Control", "no-store")
    .send(template);
}

async function loadIndexTemplate(
  req: Request,
  vite: import("vite").ViteDevServer | null,
): Promise<string> {
  if (IS_PROD) {
    return fs.readFile(path.join(DIST_DIR, "index.html"), "utf-8");
  }
  let template = await fs.readFile(SRC_INDEX, "utf-8");
  template = await vite!.transformIndexHtml(req.originalUrl, template);
  return template;
}

const isDirectInvocation =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  start().catch(err => {
    console.error("[kharagolf-website] failed to start", err);
    process.exit(1);
  });
}
