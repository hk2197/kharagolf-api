/**
 * GHIN API service — posts adjusted gross scores to the GHIN WHS network.
 *
 * Credentials are org-scoped, stored in the `org_ghin_credentials` table.
 * Fallback to process env (GHIN_API_KEY / GHIN_API_USERNAME / GHIN_API_PASSWORD)
 * only for backward-compatibility in single-tenant deployments.
 *
 * GHIN API base URL: https://api2.ghin.com/api/v1
 *
 * When credentials are absent, the service returns an error result (NOT a simulated success).
 * Rate limiting: GHIN asks for no more than 1 request per second.
 */

import { logger } from "./logger";
import { decrypt, isEncrypted } from "./crypto";

/**
 * Decrypt a credential value if it was stored encrypted.
 * Throws if the value looks encrypted but decryption fails — this prevents
 * accidentally treating corrupted/migrated ciphertext as a plaintext credential.
 * Returns the value as-is only when it is not in encrypted format (env var fallback path).
 */
function decryptCred(value: string): string {
  if (isEncrypted(value)) {
    return decrypt(value); // throws on failure — do NOT silently fall back to ciphertext
  }
  return value;
}

const GHIN_BASE = "https://api2.ghin.com/api/v1";

export interface GhinCredentials {
  apiKey: string;
  username: string;
  password: string;
}

export interface GhinScorePayload {
  ghinNumber: string;
  firstName: string;
  lastName: string;
  courseId?: string;
  courseName?: string;
  courseRating: number;
  slope: number;
  numberOfHoles: 9 | 18;
  playedAt: string;
  adjustedGrossScore: number;
}

export type GhinPostResult =
  | { success: true; ghinScoreId?: string; response: Record<string, unknown> }
  | { success: false; error: string; code?: string; response?: Record<string, unknown> };

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

/**
 * Resolve GHIN credentials for an org.
 * Priority: orgCreds (from DB, auto-decrypted) → env fallback → null
 *
 * If org creds are present but decryption fails (e.g. ENCRYPTION_SECRET
 * not configured or rotated), logs a warning and falls through to env
 * fallback rather than throwing — callers receive null if neither source works.
 */
export function resolveGhinCredentials(orgCreds?: GhinCredentials | null): GhinCredentials | null {
  if (orgCreds?.apiKey && orgCreds?.username && orgCreds?.password) {
    try {
      return {
        apiKey: decryptCred(orgCreds.apiKey),
        username: decryptCred(orgCreds.username),
        password: decryptCred(orgCreds.password),
      };
    } catch (err) {
      logger.warn({ err }, "[ghin] Failed to decrypt org credentials — ENCRYPTION_SECRET may be missing or rotated; falling back to env");
    }
  }

  const apiKey = process.env.GHIN_API_KEY;
  const username = process.env.GHIN_API_USERNAME;
  const password = process.env.GHIN_API_PASSWORD;

  if (apiKey && username && password) return { apiKey, username, password };
  return null;
}

async function getGhinToken(creds: GhinCredentials): Promise<string | null> {
  try {
    const res = await fetch(`${GHIN_BASE}/users/sign_in.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: { email: creds.username, password: creds.password } }),
    });
    const data = await res.json() as { token?: string; error?: string };
    if (!res.ok || !data.token) {
      logger.warn({ status: res.status, data }, "[ghin] Token fetch failed");
      return null;
    }
    return data.token;
  } catch (err) {
    logger.warn({ err }, "[ghin] Token fetch error");
    return null;
  }
}

/**
 * Post a single score to GHIN.
 *
 * @param payload  Score posting data.
 * @param orgCreds Optional org-scoped credentials (from org_ghin_credentials table).
 *                 Falls back to global env vars if omitted. Returns error if neither is set.
 */
export async function postScoreToGhin(
  payload: GhinScorePayload,
  orgCreds?: GhinCredentials | null,
): Promise<GhinPostResult> {
  const creds = resolveGhinCredentials(orgCreds);

  if (!creds) {
    return {
      success: false,
      error: "GHIN credentials not configured for this organization. Add your GHIN API key in the organization settings.",
      code: "NO_CREDENTIALS",
    };
  }

  const token = await getGhinToken(creds);

  if (!token) {
    return { success: false, error: "Failed to authenticate with GHIN API. Check your GHIN credentials.", code: "AUTH_FAILED" };
  }

  try {
    const body = {
      score_posting: {
        ghin_number: payload.ghinNumber,
        first_name: payload.firstName,
        last_name: payload.lastName,
        course_name: payload.courseName ?? "Unknown Course",
        course_rating: payload.courseRating,
        slope_rating: payload.slope,
        number_of_holes: payload.numberOfHoles,
        played_at: payload.playedAt,
        adjusted_gross_score: payload.adjustedGrossScore,
      },
    };

    const res = await fetch(`${GHIN_BASE}/score_postings.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "x-api-key": creds.apiKey,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as Record<string, unknown>;

    if (res.ok) {
      const scoreId = (data as { score_posting?: { id?: string } }).score_posting?.id;
      return { success: true, ghinScoreId: scoreId, response: data };
    }

    if (res.status === 404) {
      return { success: false, error: "Golfer not found in GHIN", code: "GOLFER_NOT_FOUND", response: data };
    }

    const errMsg = typeof (data as { message?: string }).message === "string"
      ? (data as { message: string }).message
      : `GHIN API error: HTTP ${res.status}`;

    return { success: false, error: errMsg, response: data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, ghinNumber: payload.ghinNumber }, "[ghin] Post score error");
    return { success: false, error: `Network error: ${msg}` };
  }
}

// ─── GHIN Player Lookup ────────────────────────────────────────────────────

export interface GhinGolferResult {
  ghinNumber: string;
  firstName: string;
  lastName: string;
  handicapIndex: number | null;
  homeClub: string | null;
  state: string | null;
  status: string | null;
}

export type GhinGolferLookupResult =
  | { success: true; golfer: GhinGolferResult }
  | { success: false; error: string; code?: string };

/**
 * Look up a golfer by GHIN number.
 * Uses the GHIN golfers search endpoint.
 */
export async function lookupGolferByGhinNumber(
  ghinNumber: string,
  orgCreds?: GhinCredentials | null,
): Promise<GhinGolferLookupResult> {
  const creds = resolveGhinCredentials(orgCreds);
  if (!creds) {
    return { success: false, error: "GHIN credentials not configured for this organization.", code: "NO_CREDENTIALS" };
  }

  const token = await getGhinToken(creds);
  if (!token) {
    return { success: false, error: "Failed to authenticate with GHIN API.", code: "AUTH_FAILED" };
  }

  try {
    const res = await fetch(`${GHIN_BASE}/golfers/search.json?golf_association_id=&per_page=1&golfer_id=${encodeURIComponent(ghinNumber)}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "x-api-key": creds.apiKey,
      },
    });

    const data = await res.json() as { golfers?: Array<Record<string, unknown>> };

    if (!res.ok) {
      if (res.status === 404) return { success: false, error: "Golfer not found in GHIN.", code: "NOT_FOUND" };
      return { success: false, error: `GHIN API error: HTTP ${res.status}`, code: "API_ERROR" };
    }

    const golfers = data.golfers ?? [];
    if (golfers.length === 0) {
      return { success: false, error: "No golfer found with that GHIN number.", code: "NOT_FOUND" };
    }

    const g = golfers[0];
    return {
      success: true,
      golfer: {
        ghinNumber: String(g.ghin_number ?? ghinNumber),
        firstName: String(g.first_name ?? ""),
        lastName: String(g.last_name ?? ""),
        handicapIndex: g.handicap_index != null ? parseFloat(String(g.handicap_index)) : null,
        homeClub: g.club_name != null ? String(g.club_name) : null,
        state: g.state != null ? String(g.state) : null,
        status: g.status != null ? String(g.status) : null,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, ghinNumber }, "[ghin] Player lookup error");
    return { success: false, error: `Network error: ${msg}` };
  }
}

// ─── GHIN Course Search ────────────────────────────────────────────────────

export interface GhinCourseResult {
  ghinCourseId: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  facilityName: string | null;
  tees?: Array<{
    name: string;
    gender: string | null;
    courseRating: number | null;
    slopeRating: number | null;
    par: number | null;
    yardage: number | null;
  }>;
}

export type GhinCourseSearchResult =
  | { success: true; courses: GhinCourseResult[] }
  | { success: false; error: string; code?: string };

export type GhinCourseDetailResult =
  | { success: true; course: GhinCourseResult }
  | { success: false; error: string; code?: string };

/**
 * Search the GHIN course database.
 */
export async function searchGhinCourses(
  query: string,
  country?: string,
  orgCreds?: GhinCredentials | null,
): Promise<GhinCourseSearchResult> {
  const creds = resolveGhinCredentials(orgCreds);
  if (!creds) return { success: false, error: "GHIN credentials not configured.", code: "NO_CREDENTIALS" };

  const token = await getGhinToken(creds);
  if (!token) return { success: false, error: "Failed to authenticate with GHIN API.", code: "AUTH_FAILED" };

  try {
    const params = new URLSearchParams({ search_term: query, per_page: "15" });
    if (country) params.set("country_code", country);

    const res = await fetch(`${GHIN_BASE}/courses.json?${params.toString()}`, {
      headers: { "Authorization": `Bearer ${token}`, "x-api-key": creds.apiKey },
    });

    const data = await res.json() as { courses?: Array<Record<string, unknown>> };
    if (!res.ok) return { success: false, error: `GHIN API error: HTTP ${res.status}`, code: "API_ERROR" };

    const courses: GhinCourseResult[] = (data.courses ?? []).map(mapGhinCourse);
    return { success: true, courses };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Network error: ${msg}` };
  }
}

/**
 * Get full detail for a GHIN course, including tee sets.
 */
export async function getGhinCourseDetail(
  ghinCourseId: string,
  orgCreds?: GhinCredentials | null,
): Promise<GhinCourseDetailResult> {
  const creds = resolveGhinCredentials(orgCreds);
  if (!creds) return { success: false, error: "GHIN credentials not configured.", code: "NO_CREDENTIALS" };

  const token = await getGhinToken(creds);
  if (!token) return { success: false, error: "Failed to authenticate with GHIN API.", code: "AUTH_FAILED" };

  try {
    const res = await fetch(`${GHIN_BASE}/courses/${encodeURIComponent(ghinCourseId)}.json`, {
      headers: { "Authorization": `Bearer ${token}`, "x-api-key": creds.apiKey },
    });

    if (!res.ok) {
      if (res.status === 404) return { success: false, error: "Course not found in GHIN.", code: "NOT_FOUND" };
      return { success: false, error: `GHIN API error: HTTP ${res.status}`, code: "API_ERROR" };
    }

    const data = await res.json() as { course?: Record<string, unknown> };
    if (!data.course) return { success: false, error: "No course data returned.", code: "NOT_FOUND" };

    return { success: true, course: mapGhinCourseDetail(data.course) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Network error: ${msg}` };
  }
}

function mapGhinCourse(c: Record<string, unknown>): GhinCourseResult {
  return {
    ghinCourseId: String(c.id ?? c.course_id ?? ""),
    name: String(c.course_name ?? c.name ?? ""),
    city: c.city != null ? String(c.city) : null,
    state: c.state != null ? String(c.state) : null,
    country: c.country != null ? String(c.country) : null,
    facilityName: c.facility_name != null ? String(c.facility_name) : null,
  };
}

function mapGhinCourseDetail(c: Record<string, unknown>): GhinCourseResult {
  const teeData = (c.tees as Array<Record<string, unknown>> | undefined) ?? [];
  const tees = teeData.map(t => ({
    name: String(t.tee_name ?? t.name ?? ""),
    gender: t.gender != null ? String(t.gender) : null,
    courseRating: t.course_rating != null ? parseFloat(String(t.course_rating)) : null,
    slopeRating: t.slope_rating != null ? parseFloat(String(t.slope_rating)) : null,
    par: t.total_par != null ? parseInt(String(t.total_par), 10) : null,
    yardage: t.total_yards != null ? parseInt(String(t.total_yards), 10) : null,
  }));
  return { ...mapGhinCourse(c), tees };
}

/**
 * Post scores for multiple players with rate limiting (1 per second).
 */
export async function postScoresBulk(
  payloads: GhinScorePayload[],
  orgCreds?: GhinCredentials | null,
): Promise<GhinPostResult[]> {
  const results: GhinPostResult[] = [];
  for (let i = 0; i < payloads.length; i++) {
    results.push(await postScoreToGhin(payloads[i], orgCreds));
    if (i < payloads.length - 1) {
      await sleep(1100);
    }
  }
  return results;
}
