/**
 * Task #581 — Ingress / TLS provisioning client.
 *
 * When an admin saves a club's vanity domain we call out to the production
 * ingress (Cloudflare for SaaS, Caddy on-demand TLS, or a custom hook) so
 * that a valid certificate is provisioned for the hostname automatically.
 * This module abstracts the provider behind a tiny interface so the routes
 * don't need to care which one is wired up in a given environment.
 *
 * Provider selection (env):
 *   INGRESS_PROVIDER = "cloudflare" | "caddy" | "webhook" | "mock" | "none"
 *
 * Common env (all providers):
 *   INGRESS_PROVISION_TIMEOUT_MS  (default 10000)
 *
 * Cloudflare for SaaS:
 *   INGRESS_CF_API_TOKEN      — Cloudflare API token with custom_hostnames:edit
 *   INGRESS_CF_ZONE_ID        — Zone id that owns the fallback origin
 *   INGRESS_CF_FALLBACK_ORIGIN (optional) — origin server for the SaaS zone
 *
 * Caddy on-demand TLS / generic webhook:
 *   INGRESS_API_URL           — base URL of the ingress controller
 *   INGRESS_API_TOKEN         — bearer token (optional)
 *
 * The "mock" provider returns "active" immediately and is intended for
 * tests + local dev. The "none" provider (the default when nothing is
 * configured) skips the call and returns status "active" so the existing
 * app keeps working in environments that don't terminate TLS via this
 * code path (e.g. when an ops person runs a wildcard cert).
 */

import { logger } from "./logger";

export type CertStatus = "none" | "pending" | "active" | "failed";

export interface IngressResult {
  status: CertStatus;
  /** Provider id we recorded (for observability). */
  provider: string;
  /** Free-form provider error if status === "failed". */
  error?: string;
}

export interface IngressClient {
  readonly provider: string;
  /** Register a hostname so the ingress will terminate TLS for it. */
  registerHostname(host: string): Promise<IngressResult>;
  /** Re-check the current cert status from the ingress provider. */
  getHostnameStatus(host: string): Promise<IngressResult>;
  /** Best-effort de-register; failures are logged but never throw. */
  removeHostname(host: string): Promise<void>;
}

function timeoutMs(): number {
  const raw = process.env.INGRESS_PROVISION_TIMEOUT_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

function isLikelyHost(host: string): boolean {
  // Conservative RFC-ish hostname check — at least one dot, only valid chars,
  // no leading/trailing dot or hyphen. Errors here surface to the admin UI.
  if (!host || host.length > 253) return false;
  if (!/^[a-z0-9.-]+$/i.test(host)) return false;
  if (host.startsWith(".") || host.endsWith(".")) return false;
  if (host.startsWith("-") || host.endsWith("-")) return false;
  return host.includes(".");
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number }) {
  const ms = init.timeoutMs ?? timeoutMs();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** ── Mock / noop provider ─────────────────────────────────────────── */
class MockIngress implements IngressClient {
  readonly provider: string;
  // Test seam: lets unit tests force a particular outcome without needing
  // to spin up a fake HTTP server. Use INGRESS_MOCK_FORCE_STATUS=failed to
  // simulate a provider error.
  constructor(provider = "mock") { this.provider = provider; }
  private forced(): IngressResult {
    const status = (process.env.INGRESS_MOCK_FORCE_STATUS as CertStatus | undefined) ?? "active";
    const error = process.env.INGRESS_MOCK_FORCE_ERROR;
    return {
      provider: this.provider,
      status,
      ...(status === "failed" && error ? { error } : {}),
    };
  }
  async registerHostname(host: string): Promise<IngressResult> {
    if (!isLikelyHost(host)) {
      return { provider: this.provider, status: "failed", error: `Invalid hostname: ${host}` };
    }
    return this.forced();
  }
  async getHostnameStatus(_host: string): Promise<IngressResult> { return this.forced(); }
  async removeHostname(_host: string): Promise<void> { /* noop */ }
}

/** ── Cloudflare for SaaS ──────────────────────────────────────────── */
class CloudflareIngress implements IngressClient {
  readonly provider = "cloudflare";
  private token: string;
  private zoneId: string;
  constructor(token: string, zoneId: string) {
    this.token = token;
    this.zoneId = zoneId;
  }
  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }
  private mapStatus(cf: { status?: string; ssl?: { status?: string } } | undefined): CertStatus {
    const s = cf?.ssl?.status ?? cf?.status ?? "";
    if (!s) return "pending";
    const lc = s.toLowerCase();
    if (lc === "active" || lc === "active_redeploying") return "active";
    if (lc === "deleted" || lc.includes("error") || lc.includes("failed")) return "failed";
    return "pending";
  }
  async registerHostname(host: string): Promise<IngressResult> {
    if (!isLikelyHost(host)) {
      return { provider: this.provider, status: "failed", error: `Invalid hostname: ${host}` };
    }
    try {
      const res = await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            hostname: host,
            ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
          }),
        },
      );
      const body = await res.json().catch(() => ({})) as {
        success?: boolean; result?: { status?: string; ssl?: { status?: string } };
        errors?: Array<{ message?: string }>;
      };
      if (!res.ok || body.success === false) {
        const err = body.errors?.map(e => e.message).filter(Boolean).join("; ")
          ?? `Cloudflare HTTP ${res.status}`;
        return { provider: this.provider, status: "failed", error: err || "Cloudflare error" };
      }
      return { provider: this.provider, status: this.mapStatus(body.result) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Cloudflare request failed";
      logger.warn({ err: msg, host }, "ingress.cloudflare.register_failed");
      return { provider: this.provider, status: "failed", error: msg };
    }
  }
  async getHostnameStatus(host: string): Promise<IngressResult> {
    // Network/timeout errors here are *transient* (provider unreachable);
    // we re-throw so the cron keeps the row in 'pending' and retries on
    // the next backoff window. HTTP-level errors from the provider are a
    // definitive verdict and are returned as 'failed'.
    const url = `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames`
      + `?hostname=${encodeURIComponent(host)}`;
    const res = await fetchWithTimeout(url, { method: "GET", headers: this.headers() });
    const body = await res.json().catch(() => ({})) as {
      success?: boolean;
      result?: Array<{ status?: string; ssl?: { status?: string } }>;
      errors?: Array<{ message?: string }>;
    };
    if (!res.ok || body.success === false) {
      const err = body.errors?.map(e => e.message).filter(Boolean).join("; ")
        ?? `Cloudflare HTTP ${res.status}`;
      return { provider: this.provider, status: "failed", error: err || "Cloudflare error" };
    }
    const first = body.result?.[0];
    return { provider: this.provider, status: first ? this.mapStatus(first) : "pending" };
  }
  async removeHostname(host: string): Promise<void> {
    try {
      const lookup = `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames`
        + `?hostname=${encodeURIComponent(host)}`;
      const r = await fetchWithTimeout(lookup, { method: "GET", headers: this.headers() });
      const body = await r.json().catch(() => ({})) as {
        result?: Array<{ id?: string }>;
      };
      const id = body.result?.[0]?.id;
      if (!id) return;
      await fetchWithTimeout(
        `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames/${id}`,
        { method: "DELETE", headers: this.headers() },
      );
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e), host }, "ingress.cloudflare.remove_failed");
    }
  }
}

/** ── Generic webhook / Caddy admin endpoint ───────────────────────── */
class WebhookIngress implements IngressClient {
  readonly provider: string;
  private base: string;
  private token?: string;
  constructor(base: string, token: string | undefined, provider: string) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
    this.provider = provider;
  }
  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }
  private mapStatus(s: string | undefined): CertStatus {
    if (!s) return "pending";
    const lc = s.toLowerCase();
    if (lc === "active" || lc === "ready" || lc === "issued") return "active";
    if (lc === "failed" || lc === "error") return "failed";
    return "pending";
  }
  async registerHostname(host: string): Promise<IngressResult> {
    if (!isLikelyHost(host)) {
      return { provider: this.provider, status: "failed", error: `Invalid hostname: ${host}` };
    }
    try {
      const res = await fetchWithTimeout(`${this.base}/hostnames`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ hostname: host }),
      });
      const body = await res.json().catch(() => ({})) as { status?: string; error?: string };
      if (!res.ok) {
        return { provider: this.provider, status: "failed", error: body.error ?? `HTTP ${res.status}` };
      }
      return { provider: this.provider, status: this.mapStatus(body.status) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Ingress request failed";
      return { provider: this.provider, status: "failed", error: msg };
    }
  }
  async getHostnameStatus(host: string): Promise<IngressResult> {
    // Network/timeout errors here are *transient* (provider unreachable);
    // we re-throw so the cron keeps the row in 'pending' and retries on
    // the next backoff window. HTTP-level errors from the provider are a
    // definitive verdict and are returned as 'failed'.
    const res = await fetchWithTimeout(
      `${this.base}/hostnames/${encodeURIComponent(host)}`,
      { method: "GET", headers: this.headers() },
    );
    const body = await res.json().catch(() => ({})) as { status?: string; error?: string };
    if (!res.ok) {
      return { provider: this.provider, status: "failed", error: body.error ?? `HTTP ${res.status}` };
    }
    return { provider: this.provider, status: this.mapStatus(body.status) };
  }
  async removeHostname(host: string): Promise<void> {
    try {
      await fetchWithTimeout(`${this.base}/hostnames/${encodeURIComponent(host)}`, {
        method: "DELETE", headers: this.headers(),
      });
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e), host }, "ingress.webhook.remove_failed");
    }
  }
}

let cachedClient: IngressClient | null = null;

/**
 * Resolve the configured ingress client. Memoised across calls; tests can
 * force a re-resolve via `resetIngressClient()`.
 */
export function getIngressClient(): IngressClient {
  if (cachedClient) return cachedClient;
  const provider = (process.env.INGRESS_PROVIDER ?? "").toLowerCase();
  switch (provider) {
    case "cloudflare": {
      const token = process.env.INGRESS_CF_API_TOKEN;
      const zone = process.env.INGRESS_CF_ZONE_ID;
      if (!token || !zone) {
        logger.warn("INGRESS_PROVIDER=cloudflare but INGRESS_CF_API_TOKEN/INGRESS_CF_ZONE_ID missing — falling back to mock");
        cachedClient = new MockIngress("mock");
      } else {
        cachedClient = new CloudflareIngress(token, zone);
      }
      break;
    }
    case "caddy":
    case "webhook": {
      const base = process.env.INGRESS_API_URL;
      if (!base) {
        logger.warn(`INGRESS_PROVIDER=${provider} but INGRESS_API_URL missing — falling back to mock`);
        cachedClient = new MockIngress("mock");
      } else {
        cachedClient = new WebhookIngress(base, process.env.INGRESS_API_TOKEN, provider);
      }
      break;
    }
    case "mock":
      cachedClient = new MockIngress("mock");
      break;
    case "":
    case "none":
    default:
      cachedClient = new MockIngress("none");
      break;
  }
  return cachedClient;
}

/** Test/dev seam — drops the memoised provider so env changes take effect. */
export function resetIngressClient(): void { cachedClient = null; }

/** Exposed for tests so they can validate the host check in isolation. */
export const __test = { isLikelyHost };
