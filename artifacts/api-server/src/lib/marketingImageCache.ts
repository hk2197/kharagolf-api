/**
 * Task #1250 / #1467 — Helpers for caching admin-supplied external
 * marketing logos / favicons into our own object storage so the public
 * mini-site never depends on a third-party host.
 *
 * Originally embedded inside `routes/marketing-site.ts`. Extracted so
 * the periodic refresh job in `lib/cron.ts` can reuse the same content
 * hashing + ACL logic without importing a route module (Task #1467).
 */

import { createHash } from "crypto";
import { ObjectStorageService } from "./objectStorage";

/**
 * Map an image content-type to a sane file extension so cached objects
 * in storage have meaningful URLs (helps with debugging and lets a CDN
 * layer do extension-based content sniffing).
 */
export const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/svg+xml": "svg",
};

/**
 * Build the publicly fetchable URL for an /objects/... entity served
 * by this API server's `/api/storage/objects/...` route. Mirrors the
 * logic in POST /images so admin-uploaded and rehosted external assets
 * share the same URL shape on the public mini-site.
 */
export function buildPublicStorageUrl(objectPath: string): string {
  const apiBase = (
    process.env.API_PUBLIC_URL
    ?? process.env.APP_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
  ).replace(/\/$/, "");
  return `${apiBase}/api/storage${objectPath}`;
}

/**
 * Task #1799 — Sum the bytes (and object count) currently stored under
 * `marketing-cache/<orgId>/` so the marketing-site admin UI can show
 * admins how much space their cached external logos / favicons are
 * using. Best-effort: if the storage backend is unreachable (e.g. a
 * test env without GCS, or the sidecar is briefly unavailable) we
 * return null so the caller can render "—" instead of a hard error.
 */
export async function getMarketingCacheUsage(
  orgId: number,
  storage?: ObjectStorageService,
): Promise<{ totalBytes: number; objectCount: number } | null> {
  const svc = storage ?? new ObjectStorageService();
  try {
    return await svc.getStorageUsageByPrefix(`marketing-cache/${orgId}/`);
  } catch (e) {
    console.warn(
      "[marketing-cache] usage lookup failed",
      { orgId, err: e instanceof Error ? e.message : String(e) },
    );
    return null;
  }
}

/**
 * Rehost a verified external image into our own object storage so the
 * public mini-site never has to depend on a third-party host. Returns
 * the publicly fetchable `/api/storage/...` URL plus the normalized
 * `/objects/...` entity path. Stored under a content-hashed key so the
 * same bytes uploaded twice (e.g. admin re-saves the same URL or the
 * refresh job re-downloads an unchanged image) collapse to a single
 * object instead of accumulating duplicates.
 */
export async function rehostExternalImageBytes(
  buffer: Buffer,
  contentType: string,
  opts: { orgId: number; kind: "logo" | "favicon"; storage?: ObjectStorageService },
): Promise<{ ok: true; url: string; objectPath: string } | { ok: false; error: string }> {
  const storage = opts.storage ?? new ObjectStorageService();
  try {
    const ext = CONTENT_TYPE_EXT[contentType] ?? "bin";
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
    const relativePath = `marketing-cache/${opts.orgId}/${opts.kind}-${hash}.${ext}`;
    const objectPath = await storage.saveRawBuffer(relativePath, buffer, contentType);
    // The `/api/storage/objects/<entityId>` route serves any object
    // whose ACL policy is explicitly "public" — same path
    // admin-uploaded logos / hero photos already use. Mark this
    // rehosted object accordingly.
    await storage.trySetObjectEntityAclPolicy(objectPath, {
      owner: `org:${opts.orgId}`,
      visibility: "public",
    });
    return { ok: true, url: buildPublicStorageUrl(objectPath), objectPath };
  } catch (e) {
    return {
      ok: false,
      error: `failed to cache image to storage: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
