import { Router, type IRouter, type Request, type Response, json as expressJson } from "express";
import { db } from "@workspace/db";
import { coursesTable, holeDetailsTable, holeGreenContoursTable, orgGhinCredentialsTable, courseHoleGeometryTable } from "@workspace/db";
import { getEffectiveMode as getEffectiveAiCaddieMode } from "../lib/aiCaddieMode.js";
import { and, eq, like } from "drizzle-orm";
import { lookupGolferByGhinNumber, searchGhinCourses, getGhinCourseDetail, resolveGhinCredentials, type GhinCredentials } from "../lib/ghin";
import { requireOrgAdmin } from "../lib/permissions";

const router: IRouter = Router({ mergeParams: true });

const GOLF_API_BASE = "https://api.golfcourseapi.com/v1";

/** Shape of a hole-details object sent in POST/PUT course request bodies */
interface HoleDetailInput {
  holeNumber: number;
  par: number;
  handicap?: number | null;
  yardageBlue?: number | null;
  yardageWhite?: number | null;
  yardageRed?: number | null;
  description?: string | null;
  greenFrontLat?: number | string | null;
  greenFrontLng?: number | string | null;
  greenCentreLat?: number | string | null;
  greenCentreLng?: number | string | null;
  greenBackLat?: number | string | null;
  greenBackLng?: number | string | null;
}

function holeDetailToRow(courseId: number, h: HoleDetailInput) {
  return {
    courseId,
    holeNumber: h.holeNumber,
    par: h.par,
    handicap: h.handicap ?? null,
    yardageBlue: h.yardageBlue ?? null,
    yardageWhite: h.yardageWhite ?? null,
    yardageRed: h.yardageRed ?? null,
    description: h.description ?? null,
    greenFrontLat: h.greenFrontLat != null ? String(h.greenFrontLat) : null,
    greenFrontLng: h.greenFrontLng != null ? String(h.greenFrontLng) : null,
    greenCentreLat: h.greenCentreLat != null ? String(h.greenCentreLat) : null,
    greenCentreLng: h.greenCentreLng != null ? String(h.greenCentreLng) : null,
    greenBackLat: h.greenBackLat != null ? String(h.greenBackLat) : null,
    greenBackLng: h.greenBackLng != null ? String(h.greenBackLng) : null,
  };
}

function getApiKey(): string | null {
  return process.env.GOLF_COURSE_API_KEY ?? null;
}

/** URL-friendly slug from a course display name. */
export function slugifyCourseName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+)|(-+$)/g, "")
    .slice(0, 80) || "course";
}

/**
 * Ensure a course slug is unique within the organization by appending
 * "-2", "-3", … on collision.
 */
export async function ensureUniqueCourseSlug(orgId: number, base: string, ignoreCourseId?: number): Promise<string> {
  const existing = await db
    .select({ slug: coursesTable.slug, id: coursesTable.id })
    .from(coursesTable)
    .where(and(eq(coursesTable.organizationId, orgId), like(coursesTable.slug, `${base}%`)));
  const taken = new Set(existing.filter(r => r.id !== ignoreCourseId).map(r => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

async function getOrgGhinCreds(orgId: number): Promise<GhinCredentials | null> {
  const [row] = await db
    .select({ apiKey: orgGhinCredentialsTable.ghinApiKey, username: orgGhinCredentialsTable.ghinApiUsername, password: orgGhinCredentialsTable.ghinApiPassword })
    .from(orgGhinCredentialsTable)
    .where(eq(orgGhinCredentialsTable.organizationId, orgId));
  if (!row) return null;
  return resolveGhinCredentials({ apiKey: row.apiKey, username: row.username, password: row.password });
}

// GET /organizations/:orgId/courses/ghin/player/:ghinNumber
// Look up a golfer by GHIN number — auto-fills name + handicap on player forms
router.get("/ghin/player/:ghinNumber", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { ghinNumber } = (req.params as Record<string, string>);
  if (!ghinNumber) { { res.status(400).json({ error: "ghinNumber is required" }); return; } }

  const orgCreds = await getOrgGhinCreds(orgId);
  const result = await lookupGolferByGhinNumber(ghinNumber, orgCreds);

  if (!result.success) {
    const status = result.code === "NO_CREDENTIALS" ? 503 : result.code === "NOT_FOUND" ? 404 : 502;
    res.status(status).json({ error: result.error, code: result.code });
    return;
  }
  res.json(result.golfer);
});

// GET /organizations/:orgId/courses/lookup/ghin?q=...&country=...
// Search GHIN course database (GHIN-first, no GolfCourseAPI fallback here)
router.get("/lookup/ghin", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const q = String(req.query.q ?? "").trim();
  const country = String(req.query.country ?? "").trim();
  if (!q) { { res.status(400).json({ error: "q is required" }); return; } }

  const orgCreds = await getOrgGhinCreds(orgId);
  const result = await searchGhinCourses(q, country || undefined, orgCreds);

  if (!result.success) {
    const status = result.code === "NO_CREDENTIALS" ? 503 : 502;
    res.status(status).json({ error: result.error, code: result.code });
    return;
  }
  res.json({ courses: result.courses, source: "ghin" });
});

// GET /organizations/:orgId/courses/lookup/ghin/detail/:ghinCourseId
// Fetch full GHIN course detail (tee sets, rating, slope)
router.get("/lookup/ghin/detail/:ghinCourseId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { ghinCourseId } = (req.params as Record<string, string>);

  const orgCreds = await getOrgGhinCreds(orgId);
  const result = await getGhinCourseDetail(ghinCourseId, orgCreds);

  if (!result.success) {
    const status = result.code === "NOT_FOUND" ? 404 : result.code === "NO_CREDENTIALS" ? 503 : 502;
    res.status(status).json({ error: result.error, code: result.code });
    return;
  }
  res.json(result.course);
});

async function golfApiGet<T>(path: string): Promise<T> {
  const key = getApiKey();
  if (!key) throw new Error("GOLF_COURSE_API_KEY not configured");
  const res = await fetch(`${GOLF_API_BASE}${path}`, {
    headers: { Authorization: `Key ${key}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`GolfCourseAPI error ${res.status}: ${text}`);
  }
  return await res.json() as T;
}

// GET /organizations/:orgId/courses/lookup/status
// Returns whether the GolfCourseAPI key is configured so the UI can indicate feature availability
router.get("/lookup/status", (_req: Request, res: Response) => {
  res.json({ configured: !!getApiKey() });
});

// GET /organizations/:orgId/courses/lookup?q=search_query
// Proxy to GolfCourseAPI search — keeps API key server-side
router.get("/lookup", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  const country = String(req.query.country ?? "").trim();
  if (!q) { { res.status(400).json({ error: "q (search query) is required" }); return; } }

  if (!getApiKey()) {
    res.status(503).json({
      error: "Course lookup is not configured. Add the GOLF_COURSE_API_KEY environment secret to enable this feature.",
      notConfigured: true,
    });
    return;
  }

  try {
    // GolfCourseAPI does not have a dedicated country filter; include country in the search term for better relevance
    const searchTerm = country ? `${q} ${country}` : q;
    const data = await golfApiGet<{ courses: GolfApiSearchResult[] }>(
      `/search?search_query=${encodeURIComponent(searchTerm)}`
    );
    res.json({ courses: (data.courses ?? []).slice(0, 10) });
  } catch (err: unknown) {
    const msg = err !== null && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Failed to contact GolfCourseAPI";
    res.status(502).json({ error: msg });
  }
});

// GET /organizations/:orgId/courses/lookup/detail/:externalId
// Fetch full course detail from GolfCourseAPI and return normalised for our schema
router.get("/lookup/detail/:externalId", async (req: Request, res: Response) => {
  const externalId = (req.params as Record<string, string>).externalId;

  if (!getApiKey()) {
    res.status(503).json({ error: "GOLF_COURSE_API_KEY not configured", notConfigured: true });
    return;
  }

  try {
    const data = await golfApiGet<GolfApiCourse>(`/courses/${externalId}`);

    // Pick the best tee set: prefer male "Blue" or "Championship", else first male tee
    const maleTees: GolfApiTee[] = data.tees?.male ?? [];
    const primaryTee: GolfApiTee | undefined =
      maleTees.find(t => /blue|championship/i.test(t.tee_name)) ?? maleTees[0];

    const location = [
      data.location?.city,
      data.location?.state,
      data.location?.country,
    ]
      .filter(Boolean)
      .join(", ");

    const holeDetails = (primaryTee?.holes ?? []).map((h, i) => ({
      holeNumber: i + 1,
      par: h.par,
      handicap: h.handicap ?? null,
      yardageBlue: h.yardage ?? null,
      yardageWhite:
        (maleTees.find(t => /white|medal/i.test(t.tee_name))?.holes[i]?.yardage ?? null),
      yardageRed:
        (
          (data.tees?.female ?? []).find(t => /red/i.test(t.tee_name)) ??
          (data.tees?.female ?? [])[0]
        )?.holes[i]?.yardage ?? null,
    }));

    res.json({
      externalCourseId: String(data.id),
      name: data.course_name || data.club_name,
      location: location || data.location?.address || null,
      holes: primaryTee?.number_of_holes ?? 18,
      par: primaryTee?.par_total ?? 72,
      rating: primaryTee?.course_rating ?? null,
      slope: primaryTee?.slope_rating ?? null,
      yardage: primaryTee?.total_yards ?? null,
      holeDetails,
      tees: maleTees.map(t => ({
        name: t.tee_name,
        rating: t.course_rating,
        slope: t.slope_rating,
        yardage: t.total_yards,
      })),
    });
  } catch (err: unknown) {
    const msg = err !== null && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Failed to contact GolfCourseAPI";
    res.status(502).json({ error: msg });
  }
});

// GET /organizations/:orgId/courses
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const courses = await db.select().from(coursesTable).where(eq(coursesTable.organizationId, orgId)).orderBy(coursesTable.name);
  res.json(courses);
});

// POST /organizations/:orgId/courses
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { name, location, holes, par, rating, slope, yardage, externalCourseId, holeDetails } = req.body;

  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  // Generate a URL-friendly slug from the name; uniqueness within the org
  // is ensured by appending a numeric suffix on collision.
  const baseSlug = slugifyCourseName(name);
  const slug = await ensureUniqueCourseSlug(orgId, baseSlug);

  const [course] = await db
    .insert(coursesTable)
    .values({
      organizationId: orgId,
      name,
      location,
      holes: holes ?? 18,
      par: par ?? 72,
      rating: rating ? String(rating) : null,
      slope,
      yardage,
      externalCourseId: externalCourseId ?? null,
      slug,
    })
    .returning();

  if (holeDetails?.length) {
    await db.insert(holeDetailsTable).values(
      (holeDetails as HoleDetailInput[]).map(h => holeDetailToRow(course.id, h)),
    );
  } else {
    const defaultHoles = Array.from({ length: holes ?? 18 }, (_, i) => ({
      courseId: course.id,
      holeNumber: i + 1,
      par: 4,
    }));
    await db.insert(holeDetailsTable).values(defaultHoles);
  }

  const createdHoles = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, course.id)).orderBy(holeDetailsTable.holeNumber);
  res.status(201).json({ ...course, holeDetails: createdHoles });
});

// GET /organizations/:orgId/courses/:courseId
router.get("/:courseId", async (req: Request, res: Response) => {
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, courseId));
  if (!course) { { res.status(404).json({ error: "Course not found" }); return; } }

  const holes = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId)).orderBy(holeDetailsTable.holeNumber);
  res.json({ ...course, holeDetails: holes });
});

// PUT /organizations/:orgId/courses/:courseId
router.put("/:courseId", async (req: Request, res: Response) => {
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  const { name, location, holes, par, rating, slope, yardage, externalCourseId, holeDetails } = req.body;

  const [course] = await db
    .update(coursesTable)
    .set({
      name,
      location,
      holes,
      par,
      rating: rating ? String(rating) : null,
      slope,
      yardage,
      ...(externalCourseId !== undefined ? { externalCourseId } : {}),
    })
    .where(eq(coursesTable.id, courseId))
    .returning();

  if (!course) { { res.status(404).json({ error: "Course not found" }); return; } }

  if (holeDetails?.length) {
    await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
    await db.insert(holeDetailsTable).values(
      (holeDetails as HoleDetailInput[]).map(h => holeDetailToRow(course.id, h))
    );
  }

  const updatedHoles = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId)).orderBy(holeDetailsTable.holeNumber);
  res.json({ ...course, holeDetails: updatedHoles });
});

// PUT /organizations/:orgId/courses/:courseId/map-center
// Task #1312 — admin-only: persist the mapper's "remembered centre" for
// this course (lat/lng, optional zoom). The course mapper UI calls this
// when an admin picks a search result or saves the first feature on a
// blank course, so the next open of the mapper flies straight to the
// course instead of starting at the world view.
//
// Stored on dedicated `map_default_*` columns rather than reusing
// `courses.latitude` / `courses.longitude` so editing the mapper centre
// doesn't silently move the course on weather correlation, the public
// course page, or member-app marker placement.
router.put("/:courseId/map-center", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  if (Number.isNaN(courseId)) { { res.status(400).json({ error: "Invalid courseId" }); return; } }

  const { mapDefaultLat, mapDefaultLng, mapDefaultZoom } = req.body as {
    mapDefaultLat?: number | string | null;
    mapDefaultLng?: number | string | null;
    mapDefaultZoom?: number | null;
  };

  // Coerce + validate. Allow explicit null to clear, otherwise require a
  // finite lat/lng pair (zoom is optional and clamped to Leaflet's
  // documented 0–22 range so a bad payload can't render an unusable map).
  const latNum = mapDefaultLat == null ? null : Number(mapDefaultLat);
  const lngNum = mapDefaultLng == null ? null : Number(mapDefaultLng);
  if (mapDefaultLat != null && !(Number.isFinite(latNum) && latNum! >= -90 && latNum! <= 90)) {
    res.status(400).json({ error: "mapDefaultLat must be a number between -90 and 90" }); return;
  }
  if (mapDefaultLng != null && !(Number.isFinite(lngNum) && lngNum! >= -180 && lngNum! <= 180)) {
    res.status(400).json({ error: "mapDefaultLng must be a number between -180 and 180" }); return;
  }
  // Both lat and lng must be supplied together (or both cleared).
  if ((mapDefaultLat == null) !== (mapDefaultLng == null)) {
    res.status(400).json({ error: "mapDefaultLat and mapDefaultLng must be set together" }); return;
  }
  let zoomVal: number | null = null;
  if (mapDefaultZoom != null) {
    const z = Number(mapDefaultZoom);
    if (!Number.isFinite(z) || z < 0 || z > 22) {
      res.status(400).json({ error: "mapDefaultZoom must be an integer between 0 and 22" }); return;
    }
    zoomVal = Math.round(z);
  }

  // Tenant-scope: ensure the course belongs to this org before writing.
  const [course] = await db.select({ id: coursesTable.id }).from(coursesTable)
    .where(and(eq(coursesTable.id, courseId), eq(coursesTable.organizationId, orgId)))
    .limit(1);
  if (!course) { { res.status(404).json({ error: "Course not found in this organization" }); return; } }

  const [updated] = await db
    .update(coursesTable)
    .set({
      mapDefaultLat: latNum == null ? null : String(latNum),
      mapDefaultLng: lngNum == null ? null : String(lngNum),
      mapDefaultZoom: zoomVal,
    })
    .where(eq(coursesTable.id, courseId))
    .returning({
      id: coursesTable.id,
      mapDefaultLat: coursesTable.mapDefaultLat,
      mapDefaultLng: coursesTable.mapDefaultLng,
      mapDefaultZoom: coursesTable.mapDefaultZoom,
    });

  res.json(updated);
});

// PUT /organizations/:orgId/courses/:courseId/holes/:holeNumber/gps
// Update GPS coordinates for a single hole
router.put("/:courseId/holes/:holeNumber/gps", async (req: Request, res: Response) => {
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  const holeNumber = parseInt(String((req.params as Record<string, string>).holeNumber));
  const { greenFrontLat, greenFrontLng, greenCentreLat, greenCentreLng, greenBackLat, greenBackLng } = req.body;

  const [hole] = await db
    .update(holeDetailsTable)
    .set({
      greenFrontLat: greenFrontLat ? String(greenFrontLat) : null,
      greenFrontLng: greenFrontLng ? String(greenFrontLng) : null,
      greenCentreLat: greenCentreLat ? String(greenCentreLat) : null,
      greenCentreLng: greenCentreLng ? String(greenCentreLng) : null,
      greenBackLat: greenBackLat ? String(greenBackLat) : null,
      greenBackLng: greenBackLng ? String(greenBackLng) : null,
    })
    .where(and(eq(holeDetailsTable.courseId, courseId), eq(holeDetailsTable.holeNumber, holeNumber)))
    .returning();

  if (!hole) { { res.status(404).json({ error: "Hole not found" }); return; } }
  res.json(hole);
});

// ── GREEN CONTOUR DATA (Task #358) ─────────────────────────────────────────
// Stores LIDAR / surveyed elevation grids around the green so the mobile
// 3D renderer can colour slope severity and draw putt-break arrows.

interface ContourBody {
  originLat: number | string;
  originLng: number | string;
  rows: number;
  cols: number;
  cellMeters?: number | string;
  elevations: number[];
  source?: string | null;
}

// GET /organizations/:orgId/courses/:courseId/holes/:holeNumber/contour
router.get("/:courseId/holes/:holeNumber/contour", async (req: Request, res: Response) => {
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  const holeNumber = parseInt(String((req.params as Record<string, string>).holeNumber));
  const [contour] = await db.select().from(holeGreenContoursTable).where(
    and(eq(holeGreenContoursTable.courseId, courseId), eq(holeGreenContoursTable.holeNumber, holeNumber)),
  );
  if (!contour) { { res.status(404).json({ error: "No contour data for this hole" }); return; } }
  res.json(contour);
});

// PUT /organizations/:orgId/courses/:courseId/holes/:holeNumber/contour
// Admin-only: upload or refresh the green contour grid for a hole.
router.put("/:courseId/holes/:holeNumber/contour", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  const holeNumber = parseInt(String((req.params as Record<string, string>).holeNumber));
  const body = req.body as ContourBody;

  if (!Array.isArray(body.elevations) || body.rows <= 0 || body.cols <= 0) {
    res.status(400).json({ error: "rows, cols and elevations[] are required" }); return;
  }
  if (body.elevations.length !== body.rows * body.cols) {
    res.status(400).json({ error: `elevations length (${body.elevations.length}) must equal rows * cols (${body.rows * body.cols})` }); return;
  }

  const row = {
    courseId,
    holeNumber,
    originLat: String(body.originLat),
    originLng: String(body.originLng),
    rows: body.rows,
    cols: body.cols,
    cellMeters: String(body.cellMeters ?? "1.5"),
    elevations: body.elevations,
    source: body.source ?? "manual",
    updatedAt: new Date(),
  };

  const [saved] = await db
    .insert(holeGreenContoursTable)
    .values(row)
    .onConflictDoUpdate({
      target: [holeGreenContoursTable.courseId, holeGreenContoursTable.holeNumber],
      set: {
        originLat: row.originLat,
        originLng: row.originLng,
        rows: row.rows,
        cols: row.cols,
        cellMeters: row.cellMeters,
        elevations: row.elevations,
        source: row.source,
        updatedAt: row.updatedAt,
      },
    })
    .returning();

  res.json(saved);
});

// PUT /organizations/:orgId/courses/:courseId/contour/bulk
// Admin-only: upload contour grids for many holes in a single request.
// Body: { holes: { "1": ContourBody, "2": ContourBody, ... } }
//   — or shorthand: { "1": ContourBody, "2": ContourBody, ... }
// Each hole is validated and upserted independently; the response reports
// per-hole success/failure so partial uploads don't block the rest.
router.put("/:courseId/contour/bulk", expressJson({ limit: "10mb" }), async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const courseId = parseInt(String((req.params as Record<string, string>).courseId));

  const body = (req.body ?? {}) as Record<string, unknown> & { holes?: Record<string, unknown> };
  const holesMap: Record<string, unknown> =
    body.holes && typeof body.holes === "object" && !Array.isArray(body.holes)
      ? body.holes as Record<string, unknown>
      : Object.fromEntries(Object.entries(body).filter(([k]) => /^\d+$/.test(k)));

  const entries = Object.entries(holesMap);
  if (entries.length === 0) {
    res.status(400).json({ error: "No hole entries found. Expected { holes: { '1': {...}, '2': {...} } } or top-level numeric keys." });
    return;
  }

  type Result = { holeNumber: number; ok: true; rows: number; cols: number } | { holeNumber: number; ok: false; error: string };
  const results: Result[] = [];

  for (const [key, raw] of entries) {
    const holeNumber = parseInt(key);
    if (!Number.isInteger(holeNumber) || holeNumber < 1 || holeNumber > 999) {
      results.push({ holeNumber: NaN, ok: false, error: `Invalid hole number key "${key}".` });
      continue;
    }
    const c = raw as Partial<ContourBody> | null;
    if (!c || typeof c !== "object") {
      results.push({ holeNumber, ok: false, error: "Hole payload must be an object." });
      continue;
    }
    if (!Array.isArray(c.elevations) || !c.rows || !c.cols || c.rows <= 0 || c.cols <= 0) {
      results.push({ holeNumber, ok: false, error: "rows, cols and elevations[] are required." });
      continue;
    }
    if (c.elevations.length !== c.rows * c.cols) {
      results.push({ holeNumber, ok: false, error: `elevations length (${c.elevations.length}) must equal rows * cols (${c.rows * c.cols}).` });
      continue;
    }
    if (c.originLat == null || c.originLng == null) {
      results.push({ holeNumber, ok: false, error: "originLat and originLng are required." });
      continue;
    }
    try {
      const row = {
        courseId,
        holeNumber,
        originLat: String(c.originLat),
        originLng: String(c.originLng),
        rows: c.rows,
        cols: c.cols,
        cellMeters: String(c.cellMeters ?? "1.5"),
        elevations: c.elevations,
        source: c.source ?? "bulk",
        updatedAt: new Date(),
      };
      await db
        .insert(holeGreenContoursTable)
        .values(row)
        .onConflictDoUpdate({
          target: [holeGreenContoursTable.courseId, holeGreenContoursTable.holeNumber],
          set: {
            originLat: row.originLat,
            originLng: row.originLng,
            rows: row.rows,
            cols: row.cols,
            cellMeters: row.cellMeters,
            elevations: row.elevations,
            source: row.source,
            updatedAt: row.updatedAt,
          },
        });
      results.push({ holeNumber, ok: true, rows: row.rows, cols: row.cols });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Database error";
      results.push({ holeNumber, ok: false, error: msg });
    }
  }

  const saved = results.filter(r => r.ok).length;
  const failed = results.length - saved;
  res.status(failed === results.length ? 400 : 200).json({
    summary: { total: results.length, saved, failed },
    results: results.sort((a, b) => (a.holeNumber || 0) - (b.holeNumber || 0)),
  });
});

// DELETE /organizations/:orgId/courses/:courseId/holes/:holeNumber/contour
router.delete("/:courseId/holes/:holeNumber/contour", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  const holeNumber = parseInt(String((req.params as Record<string, string>).holeNumber));
  await db.delete(holeGreenContoursTable).where(
    and(eq(holeGreenContoursTable.courseId, courseId), eq(holeGreenContoursTable.holeNumber, holeNumber)),
  );
  res.json({ deleted: true });
});

export default router;

// ── GolfCourseAPI types ───────────────────────────────────────────────

interface GolfApiSearchResult {
  id: number;
  club_name: string;
  course_name: string;
  location?: { address?: string; city?: string; state?: string; country?: string };
}

interface GolfApiHole {
  par: number;
  yardage: number;
  handicap?: number;
}

interface GolfApiTee {
  tee_name: string;
  course_rating: number;
  slope_rating: number;
  total_yards: number;
  total_meters: number;
  number_of_holes: number;
  par_total: number;
  holes: GolfApiHole[];
}

interface GolfApiCourse {
  id: number;
  club_name: string;
  course_name: string;
  location?: {
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
  };
  tees?: {
    male?: GolfApiTee[];
    female?: GolfApiTee[];
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Wave 0 / Task #935 — course geometry (greens, hazards, fairway centerlines,
// tee boxes) for the hybrid in-house mapper + GHIN/USGA fallback. Every row
// is org-scoped transitively via course → organization cascade.
// ─────────────────────────────────────────────────────────────────────────

const VALID_FEATURE_TYPES = new Set([
  "green", "fairway", "hazard_water", "hazard_bunker",
  "hazard_oob", "tee_box", "cart_path",
]);
const VALID_SOURCES = new Set(["in_house", "ghin", "usga", "user_drawn"]);

interface GeometryFeatureInput {
  holeNumber: number;
  featureType: string;
  geometry: {
    type: "Polygon" | "LineString" | "Point" | "MultiPolygon";
    coordinates: unknown;
  };
  source?: string;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
}

// GET /organizations/:orgId/courses/:courseId/geometry — list every polygon
// for this course (publicly readable, like hole_details).
router.get("/:courseId/geometry", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  if (Number.isNaN(orgId) || Number.isNaN(courseId)) {
    res.status(400).json({ error: "Invalid orgId or courseId" });
    return;
  }
  // Tenant-scope: the route is mounted under /organizations/:orgId, so the
  // course must belong to that org. Without this check, knowing any
  // course id would expose another tenant's geometry (IDOR).
  const [course] = await db.select({ id: coursesTable.id }).from(coursesTable)
    .where(and(eq(coursesTable.id, courseId), eq(coursesTable.organizationId, orgId)))
    .limit(1);
  if (!course) { { res.status(404).json({ error: "Course not found in this organization" }); return; } }

  const rows = await db.select().from(courseHoleGeometryTable)
    .where(eq(courseHoleGeometryTable.courseId, courseId));
  res.json({ courseId, features: rows });
});

// POST /organizations/:orgId/courses/:courseId/geometry — admin-only bulk
// upsert of feature polygons. Replaces the entire geometry set for this
// course so the in-house mapper UI can save its current canvas atomically.
router.post("/:courseId/geometry", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!(await requireOrgAdmin(req, res, orgId))) return;
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  if (Number.isNaN(courseId)) { { res.status(400).json({ error: "Invalid courseId" }); return; } }

  const body = req.body as { features?: GeometryFeatureInput[]; replace?: boolean };
  const features = Array.isArray(body.features) ? body.features : null;
  if (!features) { { res.status(400).json({ error: "features[] is required" }); return; } }

  for (const f of features) {
    if (!Number.isInteger(f.holeNumber) || f.holeNumber < 1 || f.holeNumber > 36) {
      res.status(400).json({ error: `Invalid holeNumber: ${f.holeNumber}` }); return;
    }
    if (!VALID_FEATURE_TYPES.has(f.featureType)) {
      res.status(400).json({ error: `Invalid featureType: ${f.featureType}` }); return;
    }
    if (f.source && !VALID_SOURCES.has(f.source)) {
      res.status(400).json({ error: `Invalid source: ${f.source}` }); return;
    }
    if (!f.geometry || typeof f.geometry !== "object" || !("type" in f.geometry) || !("coordinates" in f.geometry)) {
      res.status(400).json({ error: "Each feature.geometry must be a GeoJSON-shaped object" }); return;
    }
  }

  // Verify the course actually belongs to this org before writing.
  const [course] = await db.select({ id: coursesTable.id }).from(coursesTable)
    .where(and(eq(coursesTable.id, courseId), eq(coursesTable.organizationId, orgId)))
    .limit(1);
  if (!course) { { res.status(404).json({ error: "Course not found in this organization" }); return; } }

  if (body.replace !== false) {
    await db.delete(courseHoleGeometryTable).where(eq(courseHoleGeometryTable.courseId, courseId));
  }

  if (features.length > 0) {
    await db.insert(courseHoleGeometryTable).values(features.map((f) => ({
      courseId,
      holeNumber: f.holeNumber,
      featureType: f.featureType,
      geometry: f.geometry,
      source: f.source ?? "in_house",
      label: f.label ?? null,
      metadata: f.metadata ?? {},
    })));
  }

  const rows = await db.select().from(courseHoleGeometryTable)
    .where(eq(courseHoleGeometryTable.courseId, courseId));
  res.json({ courseId, features: rows, replaced: body.replace !== false });
});

// Wave 1 W1-B — Course bundle pre-cache.
// GET /organizations/:orgId/courses/:courseId/bundle — single payload
// containing everything the mobile app needs to play the course offline:
// hole details, full geometry, and the AI-Caddie mode resolved for the
// optional ?tournamentId / ?leagueId / ?generalPlayRoundId. Designed to
// be cached client-side under a 24h TTL.
router.get("/:courseId/bundle", async (req: Request, res: Response) => {
  // Auth required: bundle exposes full course geometry; treat as
  // member-only data even though it's not personally identifying.
  if (!req.user) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  if (Number.isNaN(orgId) || Number.isNaN(courseId)) {
    res.status(400).json({ error: "Invalid orgId or courseId" });
    return;
  }
  const [course] = await db.select().from(coursesTable)
    .where(and(eq(coursesTable.id, courseId), eq(coursesTable.organizationId, orgId)))
    .limit(1);
  if (!course) { { res.status(404).json({ error: "Course not found in this organization" }); return; } }

  const [holes, geometry] = await Promise.all([
    db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId)),
    db.select().from(courseHoleGeometryTable).where(eq(courseHoleGeometryTable.courseId, courseId)),
  ]);

  const tournamentId = req.query.tournamentId ? parseInt(String(req.query.tournamentId)) : null;
  const leagueId = req.query.leagueId ? parseInt(String(req.query.leagueId)) : null;
  const generalPlayRoundId = req.query.generalPlayRoundId ? parseInt(String(req.query.generalPlayRoundId)) : null;

  let aiCaddieMode: "open" | "distance_only" | "lockdown" = "open";
  if (tournamentId || leagueId || generalPlayRoundId) {
    aiCaddieMode = await getEffectiveAiCaddieMode({
      tournamentId: Number.isFinite(tournamentId!) ? tournamentId : null,
      leagueId: Number.isFinite(leagueId!) ? leagueId : null,
      generalPlayRoundId: Number.isFinite(generalPlayRoundId!) ? generalPlayRoundId : null,
    });
  }

  res.json({
    courseId,
    course: { id: course.id, name: course.name, organizationId: course.organizationId },
    holes,
    geometry,
    roundContext: {
      tournamentId, leagueId, generalPlayRoundId,
      aiCaddieMode,
    },
    cachedAt: new Date().toISOString(),
  });
});
