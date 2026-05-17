/**
 * Task #1089 — Verify that an admin-supplied external image URL
 * (marketing-site logo / favicon) actually serves a real image up
 * front, so the public mini-site never hangs visitors waiting on a
 * slow / down third-party host.
 *
 * The check:
 *   - Parses the URL and requires http: or https:.
 *   - Resolves the host once via dns.lookup and refuses any address
 *     that isn't publicly routable (reuses isPrivateAddress, the
 *     same SSRF guard that protects /verify-domain).
 *   - Issues a single GET request, pinned to the vetted IP, with the
 *     original Host header / SNI preserved for TLS validation. No
 *     redirects are followed — an attacker-controlled Location
 *     header can't pivot us to an internal target.
 *   - Requires an HTTP 2xx response, an image content-type from the
 *     allow-list, and a body that does not exceed the per-call max
 *     (default 10 MB). The response stream is aborted as soon as the
 *     cap is reached so a hostile host can't exhaust memory.
 *   - Caps the wall-clock time at 8 seconds (5 s connect + per-read).
 *
 * Task #1468 — Callers can pass a tighter `maxBytes` cap for image
 * categories that have no business being large (marketing logos and
 * favicons in particular — they're typically <500 KB, so capping the
 * download at 1 MB stops a malicious admin from pointing us at a 9 MB
 * image and burning storage). The error message echoes whatever cap
 * the caller chose so the admin sees the real limit.
 *
 * A test override hook (`__setExternalImageVerifierForTests`) lets
 * unit tests substitute a deterministic stub. When NODE_ENV is
 * "test" and no override has been installed we accept the URL
 * without making any network calls — this keeps the existing
 * marketing-site test suite (which uses fake `https://cdn.example.com/...`
 * URLs) green without each test having to mock the network.
 */

import { isPrivateAddress } from "./privateAddressGuard";

const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml",
]);
/** Default max bytes when the caller doesn't supply a tighter cap. */
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
/**
 * Task #1468 — Per-call cap for marketing logo / favicon downloads.
 * Logos and favicons are typically well under 500 KB; a 1 MB ceiling
 * leaves comfortable headroom for high-DPI variants while preventing
 * a hostile admin from pointing the rehoster at a multi-megabyte
 * image and burning organization storage quota.
 */
export const MARKETING_LOGO_FAVICON_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Render a byte count as a human-friendly cap label for error
 * messages — "1 MB", "500 KB", "1024 bytes". Whole-MB and whole-KB
 * caps render without trailing decimals; uneven caps fall back to a
 * single decimal place so e.g. 1.5 MB shows as "1.5 MB".
 */
function formatMaxBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    const kb = bytes / 1024;
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
  }
  return `${bytes} bytes`;
}

/**
 * Task #1250 — On success the verifier also returns the downloaded
 * bytes and the resolved content-type so the caller can rehost the
 * image into our own object storage without paying for a second
 * round-trip to the third-party host. The fields are optional so
 * test stubs that only need to signal success/failure (the existing
 * verifier override hook contract) keep working unchanged.
 */
export type ExternalImageVerifyResult =
  | { ok: true; buffer?: Buffer; contentType?: string }
  | { ok: false; error: string };

/**
 * Task #1468 — Optional per-call options. Today only `maxBytes` is
 * tunable; future tightenings (allow-list overrides, dimension caps)
 * can be threaded through this type without breaking call sites.
 */
export interface ExternalImageVerifyOptions {
  /** Override the default 10 MB body cap with a tighter ceiling. */
  maxBytes?: number;
}

export type ExternalImageVerifier = (
  url: string,
  options?: ExternalImageVerifyOptions,
) => Promise<ExternalImageVerifyResult>;

let testOverride: ExternalImageVerifier | null = null;

/**
 * Test-only hook. Pass a function to stub the verifier for the
 * duration of a test, or `null` to restore the real implementation.
 * Not intended for production use.
 */
export function __setExternalImageVerifierForTests(fn: ExternalImageVerifier | null): void {
  testOverride = fn;
}

async function realVerify(
  rawUrl: string,
  options?: ExternalImageVerifyOptions,
): Promise<ExternalImageVerifyResult> {
  const maxBytes = options?.maxBytes && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_IMAGE_BYTES;
  const maxBytesLabel = formatMaxBytes(maxBytes);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "must be a valid http(s) URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "must use http:// or https://" };
  }
  const host = parsed.hostname;
  if (!host) return { ok: false, error: "URL is missing a hostname" };

  const dnsModule = await import("dns/promises");
  let safeAddresses: { address: string; family: 4 | 6 }[] = [];
  try {
    const looked = await dnsModule.lookup(host, { all: true, verbatim: true });
    safeAddresses = looked.map(l => ({ address: l.address, family: l.family as 4 | 6 }));
  } catch (e) {
    return {
      ok: false,
      error: `host did not resolve: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (safeAddresses.length === 0) {
    return { ok: false, error: "host did not resolve to any address" };
  }
  if (safeAddresses.some(isPrivateAddress)) {
    return {
      ok: false,
      error: "host resolves to a non-publicly-routable address",
    };
  }

  const isHttps = parsed.protocol === "https:";
  const transport = isHttps
    ? await import("node:https")
    : await import("node:http");
  const port = parsed.port
    ? Number(parsed.port)
    : (isHttps ? 443 : 80);
  const path = `${parsed.pathname || "/"}${parsed.search || ""}`;

  const probe = (pinned: { address: string; family: 4 | 6 }) =>
    new Promise<ExternalImageVerifyResult>((resolve) => {
      const req = transport.request({
        host: pinned.address,
        port,
        family: pinned.family,
        method: "GET",
        path,
        headers: {
          Host: parsed.host,
          Accept: "image/*",
          "User-Agent": "KharagolfImageVerifier/1.0",
        },
        servername: host,
        timeout: REQUEST_TIMEOUT_MS,
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          resolve({
            ok: false,
            error: `image host returned HTTP ${status}`,
          });
          return;
        }
        const ct = (response.headers["content-type"] || "")
          .toString()
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (!ct || !ALLOWED_IMAGE_CONTENT_TYPES.has(ct)) {
          response.destroy();
          resolve({
            ok: false,
            error: ct
              ? `unsupported image content-type "${ct}"`
              : "host did not return an image content-type",
          });
          return;
        }
        const declaredLen = Number(response.headers["content-length"] ?? "");
        if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
          response.destroy();
          resolve({
            ok: false,
            error: `image exceeds the ${maxBytesLabel} maximum size`,
          });
          return;
        }
        // Task #1250 / #1468 — Buffer the bytes (within the per-call
        // cap) so the caller can rehost them into our own object
        // storage. Public visitor pages then never have to fetch from
        // the third-party host again, even if it later goes slow /
        // dies. The streaming guard aborts the response the instant we
        // overshoot the cap so a hostile host can't push past the limit
        // by trickling data after the headers.
        const chunks: Buffer[] = [];
        let bytes = 0;
        let aborted = false;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            aborted = true;
            response.destroy();
            // Resolve immediately rather than waiting for an "end"
            // event — destroying the response stream emits "close"
            // but not "end", so deferring the size error to the
            // "end" handler would leave the call hanging until the
            // outer request timeout fires.
            resolve({
              ok: false,
              error: `image exceeds the ${maxBytesLabel} maximum size`,
            });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (aborted) return; // already resolved by the data handler
          if (bytes === 0) {
            resolve({ ok: false, error: "image host returned an empty body" });
          } else {
            resolve({
              ok: true,
              buffer: Buffer.concat(chunks, bytes),
              contentType: ct,
            });
          }
        });
        response.on("error", (e: Error) => {
          if (aborted) return; // size-cap rejection already resolved
          resolve({ ok: false, error: `image download failed: ${e.message}` });
        });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({
          ok: false,
          error: `image host did not respond within ${REQUEST_TIMEOUT_MS / 1000}s`,
        });
      });
      req.on("error", (e: NodeJS.ErrnoException) => {
        const msg = e.code
          ? `${e.code}${e.message ? `: ${e.message}` : ""}`
          : (e.message ?? "image fetch failed");
        resolve({ ok: false, error: `could not reach image host: ${msg}` });
      });
      req.end();
    });

  let result: ExternalImageVerifyResult = {
    ok: false,
    error: "no addresses to probe",
  };
  for (const addr of safeAddresses) {
    result = await probe(addr);
    if (result.ok) return result;
    // Only fall through on transport-level errors (couldn't reach
    // host). Stop on authoritative HTTP responses we've classified.
    if (!/could not reach image host/.test(result.error)) break;
  }
  return result;
}

export async function verifyExternalImageUrl(
  url: string,
  options?: ExternalImageVerifyOptions,
): Promise<ExternalImageVerifyResult> {
  if (testOverride) return testOverride(url, options);
  // Default test behaviour: skip the network so existing tests that
  // use fake `https://cdn.example.com/...` URLs keep passing without
  // having to register an override. Tests that exercise the real
  // verification install one via `__setExternalImageVerifierForTests`.
  if (process.env.NODE_ENV === "test") return { ok: true };
  return realVerify(url, options);
}
