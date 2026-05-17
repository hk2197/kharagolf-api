export const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : '';

export function getApiUrl(path: string): string {
  return `${BASE_URL}/api${path}`;
}

/**
 * Thrown when the API returns HTTP 402 — the organization's plan does not include the
 * requested feature. Callers should catch this and render <UpgradePrompt />.
 */
export class FeatureGateError extends Error {
  readonly currentTier: string;
  readonly requiredTier: string;
  readonly gateType: string;

  constructor(message: string, currentTier: string, requiredTier: string, gateType: string) {
    super(message);
    this.name = 'FeatureGateError';
    this.currentTier = currentTier;
    this.requiredTier = requiredTier;
    this.gateType = gateType;
  }
}

/**
 * Thrown when the API returns HTTP 403 with `code: "CONSENT_REQUIRED"` — the
 * member has withdrawn (or never granted) consent for the requested feature
 * category (gps, photo, video, ai, …). Callers should catch this and surface
 * an in-app prompt that links to the consent centre (Task #469).
 */
export class ConsentRequiredError extends Error {
  readonly category: string;
  constructor(message: string, category: string) {
    super(message);
    this.name = 'ConsentRequiredError';
    this.category = category;
  }
}

/** Inspect a non-ok response and throw the appropriate typed error. */
async function throwApiError(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({})) as {
    error?: string;
    code?: string;
    featureGate?: { type?: string; currentTier?: string; requiredTier?: string; message?: string };
    consentRequired?: { category?: string; message?: string };
  };
  if (res.status === 402 && body.featureGate) {
    throw new FeatureGateError(
      body.featureGate.message ?? body.error ?? 'Plan upgrade required',
      body.featureGate.currentTier ?? 'free',
      body.featureGate.requiredTier ?? 'starter',
      body.featureGate.type ?? 'unknown',
    );
  }
  if (res.status === 403 && body.code === 'CONSENT_REQUIRED' && body.consentRequired?.category) {
    throw new ConsentRequiredError(
      body.consentRequired.message ?? body.error ?? 'Consent required',
      body.consentRequired.category,
    );
  }
  throw new Error(body.error ?? `API error ${res.status}`);
}

export async function fetchPublic<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/public${path}`);
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<T>;
}

export async function postPublic<T = unknown>(path: string, body: object, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}/api/public${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<T>;
}

export async function fetchPortal<T = unknown>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/portal${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<T>;
}

export async function postPortal<T = unknown>(path: string, token: string, body: object): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/portal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<T>;
}

export async function putPortal<T = unknown>(path: string, token: string, body: object): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/portal${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<T>;
}

export async function deletePortal<T = unknown>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/portal${path}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) await throwApiError(res);
  // Tolerate 204 No Content (and any empty body) — many DELETE endpoints return no payload.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function patchPortal<T = unknown>(path: string, token: string, body: object): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/portal${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<T>;
}
