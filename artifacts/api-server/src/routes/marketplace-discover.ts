/**
 * Cross-Club Tee Time Marketplace Discovery API — Task 359
 * Mounted at: /api/marketplace-discover
 *
 * Aggregates publicly-exposed marketplace slots across all participating
 * KHARAGOLF clubs (organizations.marketplace_enabled = true and per-slot
 * is_public = true). Players search by date, location, price and group
 * size, see distance + surge indicators, and may save searches with
 * notification alerts when matching slots open.
 *
 * GET    /clubs                     Participating clubs (id, name, lat, lng, distance)
 * GET    /slots                     Cross-club slot search with filters
 * GET    /slots/:slotId             Slot detail (with club info)
 * GET    /saved-searches            List the player's saved searches
 * POST   /saved-searches            Create a saved search
 * PATCH  /saved-searches/:id        Update name / notify flag / filters
 * DELETE /saved-searches/:id        Remove a saved search
 * POST   /saved-searches/run-alerts (admin/cron) — evaluate searches and emit notifications
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  marketplaceSlotsTable,
  marketplaceBookingsTable,
  marketplaceSavedSearchesTable,
  marketplaceSavedSearchAlertsTable,
  coursesTable,
  organizationsTable,
} from "@workspace/db";
import { and, eq, gte, lte, asc, desc, inArray, sql, isNull, or } from "drizzle-orm";
import { sendTransactionalPush } from "../lib/comms";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/* ─── Cross-club discover SSE registry ───────────────────────────── */

/**
 * Set of SSE response objects subscribed to the cross-club discover
 * stream. A single set (not org-keyed) because discover clients may
 * filter by any combination of clubs and we don't know their filters
 * server-side; instead we push lightweight `{organizationId}` change
 * notifications and let each client refetch `/clubs/slot-counts` with
 * its own filters.
 */
const discoverSSEClients = new Set<Response>();

export function addDiscoverSSEClient(res: Response) {
  discoverSSEClients.add(res);
}

export function removeDiscoverSSEClient(res: Response) {
  discoverSSEClients.delete(res);
}

/**
 * Rolling buffer of recent `slot_change` events so a client that
 * briefly disconnects (network blip, server restart, app backgrounded)
 * can replay any events it missed by sending its last seen id as
 * `Last-Event-ID` (or `?lastEventId=`) when it reconnects.
 *
 * Buffer is bounded by both count (`DISCOVER_REPLAY_MAX`) and age
 * (`DISCOVER_REPLAY_TTL_MS`) to keep memory usage trivial — older
 * entries are dropped lazily on each new event. When a client's last
 * id is missing from the buffer (gap too large) we fall back to a
 * single `resync` hint so the client refetches counts immediately.
 */
interface DiscoverEvent {
  id: number;
  organizationId: number;
  at: string;
}
const DISCOVER_REPLAY_MAX = 200;
const DISCOVER_REPLAY_TTL_MS = 5 * 60_000;
const discoverEventBuffer: DiscoverEvent[] = [];
let discoverEventSeq = 0;

function pruneDiscoverBuffer(now: number): void {
  const cutoff = now - DISCOVER_REPLAY_TTL_MS;
  while (
    discoverEventBuffer.length > 0 &&
    (discoverEventBuffer.length > DISCOVER_REPLAY_MAX ||
      Date.parse(discoverEventBuffer[0]!.at) < cutoff)
  ) {
    discoverEventBuffer.shift();
  }
}

function formatDiscoverEvent(ev: DiscoverEvent): string {
  return (
    `id: ${ev.id}\n` +
    `data: ${JSON.stringify({ type: "slot_change", organizationId: ev.organizationId, at: ev.at, id: ev.id })}\n\n`
  );
}

/**
 * Replay buffered events to a single client. To avoid a reconnect
 * race where a new event arrives between replay and live subscription
 * (or vice-versa), the caller must register the client *first*, then
 * pass the sequence snapshot taken at registration time as `upToId`.
 * Replay covers `(lastId, upToId]`; any live event with id > upToId
 * is delivered through the normal broadcast path, so no event is
 * either missed or duplicated.
 */
function replayDiscoverEventsTo(res: Response, lastId: number, upToId: number): void {
  if (!Number.isFinite(lastId) || lastId <= 0) return;
  const oldestBuffered = discoverEventBuffer[0]?.id;
  // Client is ahead of us (server restart reset the sequence) OR the
  // gap exceeds our rolling buffer — either way we can't enumerate
  // exactly what was missed, so tell the client to resync counts.
  const aheadOfServer = lastId > discoverEventSeq;
  const gapExceedsBuffer = oldestBuffered != null && lastId < oldestBuffered - 1;
  if (aheadOfServer || gapExceedsBuffer) {
    try {
      res.write(`data: ${JSON.stringify({ type: "resync", reason: "gap_exceeds_buffer" })}\n\n`);
    } catch { /* client already gone */ }
    return;
  }
  if (lastId >= upToId) return;
  for (const ev of discoverEventBuffer) {
    if (ev.id <= lastId) continue;
    if (ev.id > upToId) break;
    try { res.write(formatDiscoverEvent(ev)); } catch { return; }
  }
}

/**
 * Notify every connected discover-stream client that a marketplace
 * slot for the given org changed (created, booked, cancelled, edited,
 * deleted). Called from per-org marketplace mutation handlers via the
 * `broadcastSlotUpdate` helper in `marketplace.ts`.
 *
 * Each event is assigned a monotonic id and retained in a short
 * rolling window so reconnecting clients can replay missed changes.
 */
export function notifyDiscoverSlotChange(organizationId: number): void {
  const ev: DiscoverEvent = {
    id: ++discoverEventSeq,
    organizationId,
    at: new Date().toISOString(),
  };
  discoverEventBuffer.push(ev);
  pruneDiscoverBuffer(Date.now());

  if (discoverSSEClients.size === 0) return;
  const msg = formatDiscoverEvent(ev);
  for (const c of discoverSSEClients) {
    try { c.write(msg); } catch { discoverSSEClients.delete(c); }
  }
}

/** Test-only hook to reset the replay buffer between scenarios. */
export function __resetDiscoverReplayBufferForTests(): void {
  discoverEventBuffer.length = 0;
  discoverEventSeq = 0;
}

/* ─── Helpers ────────────────────────────────────────────────────── */

/** Haversine great-circle distance between two coordinates in km. */
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

interface SlotFilters {
  fromDate?: string;
  toDate?: string;
  daysOfWeek?: number[];
  orgIds?: number[];
  courseIds?: number[];
  lat?: number;
  lng?: number;
  radiusKm?: number;
  minSpots?: number;
  maxPricePaise?: number;
  surge?: ("off_peak" | "normal" | "surge")[];
}

/** Effective listing price = pricePaise (already includes any markup). When
 *  a slot has basePricePaise set, pricePaise reflects markup applied at
 *  exposure time; we display markup transparently to the player. */
function listingPrice(slot: { pricePaise: number; basePricePaise: number | null }): {
  pricePaise: number;
  basePricePaise: number;
  markupPaise: number;
} {
  const base = slot.basePricePaise ?? slot.pricePaise;
  return {
    pricePaise: slot.pricePaise,
    basePricePaise: base,
    markupPaise: Math.max(0, slot.pricePaise - base),
  };
}

/* ─── GET /clubs ─────────────────────────────────────────────────── */

router.get("/clubs", async (req: Request, res: Response) => {
  const lat = req.query.lat ? Number(req.query.lat) : null;
  const lng = req.query.lng ? Number(req.query.lng) : null;

  const rows = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      logoUrl: organizationsTable.logoUrl,
      latitude: organizationsTable.latitude,
      longitude: organizationsTable.longitude,
      address: organizationsTable.address,
    })
    .from(organizationsTable)
    .where(and(eq(organizationsTable.marketplaceEnabled, true), eq(organizationsTable.isActive, true)));

  const enriched = rows.map((c) => {
    const cLat = c.latitude != null ? Number(c.latitude) : null;
    const cLng = c.longitude != null ? Number(c.longitude) : null;
    const distance =
      lat != null && lng != null && cLat != null && cLng != null
        ? distanceKm(lat, lng, cLat, cLng)
        : null;
    return { ...c, latitude: cLat, longitude: cLng, distanceKm: distance };
  });

  // Sort by distance when geo provided
  if (lat != null && lng != null) {
    enriched.sort((a, b) => (a.distanceKm ?? 9e9) - (b.distanceKm ?? 9e9));
  }

  res.json(enriched);
});

/* ─── GET /clubs/slot-counts — lightweight live count per club ───── */

/**
 * Returns just `{ organizationId, openSlots, spotsLeft }` for every
 * participating club whose marketplace is enabled. Designed to be polled
 * (~once per minute) by the marketplace map so pin colour/badge can update
 * as tee times open or fill — without re-downloading the full slot list.
 *
 * Honours the same date / spots / price filters as `GET /slots` so the
 * counts match what the player would see if they reloaded.
 */
router.get("/clubs/slot-counts", async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  const fromDate = q.fromDate ? new Date(q.fromDate) : new Date();
  const toDate = q.toDate ? new Date(q.toDate) : new Date(Date.now() + 14 * 86_400_000);
  const minSpots = q.minSpots ? Math.max(1, parseInt(q.minSpots)) : 1;
  const maxPricePaise = q.maxPricePaise ? parseInt(q.maxPricePaise) : null;

  const conditions = [
    eq(marketplaceSlotsTable.isPublic, true),
    eq(marketplaceSlotsTable.status, "open"),
    gte(marketplaceSlotsTable.slotDate, fromDate),
    lte(marketplaceSlotsTable.slotDate, toDate),
    eq(organizationsTable.marketplaceEnabled, true),
  ];
  if (maxPricePaise != null) conditions.push(lte(marketplaceSlotsTable.pricePaise, maxPricePaise));

  const rows = await db
    .select({
      organizationId: marketplaceSlotsTable.organizationId,
      maxPlayers: marketplaceSlotsTable.maxPlayers,
      bookedPlayers: marketplaceSlotsTable.bookedPlayers,
    })
    .from(marketplaceSlotsTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, marketplaceSlotsTable.organizationId))
    .where(and(...conditions));

  const byOrg = new Map<number, { openSlots: number; spotsLeft: number }>();
  for (const r of rows) {
    const left = r.maxPlayers - r.bookedPlayers;
    if (left < minSpots) continue;
    const cur = byOrg.get(r.organizationId) ?? { openSlots: 0, spotsLeft: 0 };
    cur.openSlots += 1;
    cur.spotsLeft += left;
    byOrg.set(r.organizationId, cur);
  }

  res.json({
    asOf: new Date().toISOString(),
    counts: Array.from(byOrg.entries()).map(([organizationId, v]) => ({
      organizationId,
      openSlots: v.openSlots,
      spotsLeft: v.spotsLeft,
    })),
  });
});

/* ─── GET /stream — cross-club live slot-change SSE ──────────────── */

/**
 * Long-lived Server-Sent Events stream that pushes a lightweight
 * `{type:"slot_change", organizationId}` event whenever a marketplace
 * slot in any club is created, booked, cancelled, edited or deleted.
 *
 * The marketplace map subscribes to this so pin colour/badge updates
 * within ~1s of a tee time opening or filling. Clients receiving an
 * event refetch `/clubs/slot-counts` (with their own filters) for an
 * authoritative count. Polling is kept as a fallback for clients that
 * cannot hold a streaming connection open.
 */
router.get("/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(": connected\n\n");

  // IMPORTANT ordering: register the client *before* replaying so any
  // event emitted while we're writing replay frames (or between replay
  // and the first live broadcast) is also broadcast to this socket via
  // notifyDiscoverSlotChange. We then snapshot the current sequence
  // and only replay events with id ≤ snapshot — anything with id >
  // snapshot is guaranteed to arrive through the live path, so no
  // event is dropped or duplicated across the reconnect handshake.
  addDiscoverSSEClient(res);
  const snapshotSeq = discoverEventSeq;

  res.write(
    `data: ${JSON.stringify({ type: "ready", at: new Date().toISOString(), lastEventId: snapshotSeq })}\n\n`,
  );

  // Replay any events the client missed during a brief disconnect.
  // Accepts the standard EventSource `Last-Event-ID` header and a
  // `?lastEventId=` query fallback for clients (like our React Native
  // fetch-based reader) that can't set arbitrary headers on reconnect.
  const headerLastId = req.header("last-event-id");
  const queryLastId = typeof req.query.lastEventId === "string" ? req.query.lastEventId : undefined;
  const lastIdRaw = headerLastId ?? queryLastId;
  if (lastIdRaw) {
    const lastId = parseInt(lastIdRaw, 10);
    if (Number.isFinite(lastId)) replayDiscoverEventsTo(res, lastId, snapshotSeq);
  }

  const hb = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); } }, 30000);

  req.on("close", () => {
    clearInterval(hb);
    removeDiscoverSSEClient(res);
  });
});

/* ─── GET /slots — cross-club search ─────────────────────────────── */

router.get("/slots", async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;

  const fromDate = q.fromDate ? new Date(q.fromDate) : new Date();
  const toDate = q.toDate ? new Date(q.toDate) : new Date(Date.now() + 14 * 86_400_000);
  const minSpots = q.minSpots ? Math.max(1, parseInt(q.minSpots)) : 1;
  const maxPricePaise = q.maxPricePaise ? parseInt(q.maxPricePaise) : null;
  const lat = q.lat ? Number(q.lat) : null;
  const lng = q.lng ? Number(q.lng) : null;
  const radiusKm = q.radiusKm ? Number(q.radiusKm) : null;
  const sort = (q.sort as "date" | "price" | "distance") ?? "date";
  const limit = Math.min(parseInt(q.limit ?? "100"), 200);
  const offset = parseInt(q.offset ?? "0");

  const orgIds = q.orgIds ? q.orgIds.split(",").map((s) => parseInt(s)).filter(Number.isFinite) : null;
  const courseIds = q.courseIds ? q.courseIds.split(",").map((s) => parseInt(s)).filter(Number.isFinite) : null;
  const daysOfWeek = q.daysOfWeek ? q.daysOfWeek.split(",").map((s) => parseInt(s)).filter(Number.isFinite) : null;
  const surge = q.surge ? q.surge.split(",") : null;

  const conditions = [
    eq(marketplaceSlotsTable.isPublic, true),
    eq(marketplaceSlotsTable.status, "open"),
    gte(marketplaceSlotsTable.slotDate, fromDate),
    lte(marketplaceSlotsTable.slotDate, toDate),
    eq(organizationsTable.marketplaceEnabled, true),
  ];
  if (orgIds && orgIds.length) conditions.push(inArray(marketplaceSlotsTable.organizationId, orgIds));
  if (courseIds && courseIds.length) conditions.push(inArray(marketplaceSlotsTable.courseId, courseIds));
  if (maxPricePaise != null) conditions.push(lte(marketplaceSlotsTable.pricePaise, maxPricePaise));
  if (surge && surge.length) conditions.push(inArray(marketplaceSlotsTable.surgeIndicator, surge));

  // Push the previously in-memory filters (minSpots, daysOfWeek, radiusKm)
  // down into SQL so `total` reflects the true count of matching slots
  // across all pages — and so we never pull more than `limit` rows into
  // memory regardless of how big the underlying result set is.
  conditions.push(
    sql`(${marketplaceSlotsTable.maxPlayers} - ${marketplaceSlotsTable.bookedPlayers}) >= ${minSpots}`,
  );
  if (daysOfWeek && daysOfWeek.length) {
    // Postgres EXTRACT(DOW) returns 0=Sun..6=Sat which matches JS getDay().
    const dowList = sql.join(
      daysOfWeek.map((d) => sql`${d}`),
      sql`, `,
    );
    conditions.push(
      sql`EXTRACT(DOW FROM ${marketplaceSlotsTable.slotDate})::int IN (${dowList})`,
    );
  }
  if (radiusKm != null && lat != null && lng != null) {
    // Haversine in SQL: drop slots whose org is missing coords or sits
    // outside the requested radius. Earth radius = 6371 km.
    conditions.push(sql`${organizationsTable.latitude} IS NOT NULL`);
    conditions.push(sql`${organizationsTable.longitude} IS NOT NULL`);
    conditions.push(sql`
      (2 * 6371 * asin(sqrt(
        power(sin(radians((${organizationsTable.latitude}::float8 - ${lat}) / 2)), 2) +
        cos(radians(${lat})) * cos(radians(${organizationsTable.latitude}::float8)) *
        power(sin(radians((${organizationsTable.longitude}::float8 - ${lng}) / 2)), 2)
      ))) <= ${radiusKm}
    `);
  }

  const whereClause = and(...conditions);

  // Authoritative count over every matching slot — independent of
  // limit/offset — so the player sees the real "X of Y results" total
  // and pagination affordances stay accurate as they page through.
  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(marketplaceSlotsTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, marketplaceSlotsTable.organizationId))
    .where(whereClause);
  const total = Number(countRows[0]?.n ?? 0);

  // Order the page in SQL too. For `distance` we order by the same
  // haversine expression used in the radius filter; when no centre
  // point is supplied we fall back to date ordering.
  const orderBy =
    sort === "price"
      ? asc(marketplaceSlotsTable.pricePaise)
      : sort === "distance" && lat != null && lng != null
        ? // Compute distance directly on the columns (no COALESCE) so
          // orgs missing coordinates produce NULL and sort last, matching
          // the previous in-memory `?? 9e9` behaviour.
          sql`(2 * 6371 * asin(sqrt(
            power(sin(radians((${organizationsTable.latitude}::float8 - ${lat}) / 2)), 2) +
            cos(radians(${lat})) * cos(radians(${organizationsTable.latitude}::float8)) *
            power(sin(radians((${organizationsTable.longitude}::float8 - ${lng}) / 2)), 2)
          ))) ASC NULLS LAST`
        : asc(marketplaceSlotsTable.slotDate);

  const rows = await db
    .select({
      slot: marketplaceSlotsTable,
      courseName: coursesTable.name,
      orgName: organizationsTable.name,
      orgSlug: organizationsTable.slug,
      orgLogoUrl: organizationsTable.logoUrl,
      orgLat: organizationsTable.latitude,
      orgLng: organizationsTable.longitude,
      orgAddress: organizationsTable.address,
      commissionPct: organizationsTable.marketplaceCommissionPct,
    })
    .from(marketplaceSlotsTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, marketplaceSlotsTable.organizationId))
    .leftJoin(coursesTable, eq(coursesTable.id, marketplaceSlotsTable.courseId))
    .where(whereClause)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  const slots = rows.map((r) => {
    const oLat = r.orgLat != null ? Number(r.orgLat) : null;
    const oLng = r.orgLng != null ? Number(r.orgLng) : null;
    const dist = lat != null && lng != null && oLat != null && oLng != null ? distanceKm(lat, lng, oLat, oLng) : null;
    const spotsLeft = r.slot.maxPlayers - r.slot.bookedPlayers;
    const price = listingPrice(r.slot);
    return {
      id: r.slot.id,
      organizationId: r.slot.organizationId,
      organizationName: r.orgName,
      organizationSlug: r.orgSlug,
      organizationLogoUrl: r.orgLogoUrl,
      organizationAddress: r.orgAddress,
      organizationLat: oLat,
      organizationLng: oLng,
      commissionPct: r.commissionPct ? Number(r.commissionPct) : 0,
      courseId: r.slot.courseId,
      courseName: r.courseName ?? null,
      slotDate: r.slot.slotDate.toISOString(),
      startingHole: r.slot.startingHole,
      maxPlayers: r.slot.maxPlayers,
      bookedPlayers: r.slot.bookedPlayers,
      spotsLeft,
      pricePaise: price.pricePaise,
      basePricePaise: price.basePricePaise,
      markupPaise: price.markupPaise,
      priceDisplay: price.pricePaise > 0 ? `₹${(price.pricePaise / 100).toFixed(0)}` : "Free",
      surgeIndicator: r.slot.surgeIndicator,
      notes: r.slot.notes,
      distanceKm: dist,
    };
  });

  res.json({ total, slots });
});

/* ─── GET /slots/:slotId — slot detail ───────────────────────────── */

router.get("/slots/:slotId", async (req: Request, res: Response) => {
  const slotId = parseInt(String((req.params as Record<string, string>).slotId));
  const [row] = await db
    .select({
      slot: marketplaceSlotsTable,
      courseName: coursesTable.name,
      orgName: organizationsTable.name,
      orgSlug: organizationsTable.slug,
      orgLogoUrl: organizationsTable.logoUrl,
      orgAddress: organizationsTable.address,
      orgLat: organizationsTable.latitude,
      orgLng: organizationsTable.longitude,
      orgEnabled: organizationsTable.marketplaceEnabled,
    })
    .from(marketplaceSlotsTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, marketplaceSlotsTable.organizationId))
    .leftJoin(coursesTable, eq(coursesTable.id, marketplaceSlotsTable.courseId))
    .where(eq(marketplaceSlotsTable.id, slotId));

  if (!row || !row.slot.isPublic || !row.orgEnabled) {
    res.status(404).json({ error: "Slot not found" });
    return;
  }

  const price = listingPrice(row.slot);
  res.json({
    id: row.slot.id,
    organizationId: row.slot.organizationId,
    organizationName: row.orgName,
    organizationSlug: row.orgSlug,
    organizationLogoUrl: row.orgLogoUrl,
    organizationAddress: row.orgAddress,
    organizationLat: row.orgLat != null ? Number(row.orgLat) : null,
    organizationLng: row.orgLng != null ? Number(row.orgLng) : null,
    courseId: row.slot.courseId,
    courseName: row.courseName ?? null,
    slotDate: row.slot.slotDate.toISOString(),
    startingHole: row.slot.startingHole,
    maxPlayers: row.slot.maxPlayers,
    bookedPlayers: row.slot.bookedPlayers,
    spotsLeft: row.slot.maxPlayers - row.slot.bookedPlayers,
    pricePaise: price.pricePaise,
    basePricePaise: price.basePricePaise,
    markupPaise: price.markupPaise,
    surgeIndicator: row.slot.surgeIndicator,
    notes: row.slot.notes,
    status: row.slot.status,
    /** Booking is performed via the org-scoped marketplace endpoint:
     *  POST /api/organizations/:orgId/marketplace/:slotId/book                */
    bookEndpoint: `/api/organizations/${row.slot.organizationId}/marketplace/${row.slot.id}/book`,
  });
});

/* ─── Saved searches ─────────────────────────────────────────────── */

function requireUser(req: Request, res: Response): { id: number } | null {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return req.user as { id: number };
}

router.get("/saved-searches", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) return;
  const rows = await db
    .select()
    .from(marketplaceSavedSearchesTable)
    .where(eq(marketplaceSavedSearchesTable.userId, user.id))
    .orderBy(desc(marketplaceSavedSearchesTable.createdAt));
  res.json(rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    lastNotifiedAt: r.lastNotifiedAt?.toISOString() ?? null,
  })));
});

/** Validate a daily-cap override value. NULL clears the override. */
function parseDailyCap(v: unknown): { value: number | null } | { error: string } {
  if (v === null) return { value: null };
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    return { error: "dailyCap must be an integer (or null to clear)" };
  }
  if (v < 1 || v > 100) return { error: "dailyCap must be between 1 and 100" };
  return { value: v };
}

/** Validate a quiet-hours hour-of-day (0-23) value. NULL clears it. */
function parseQuietHour(v: unknown, label: string): { value: number | null } | { error: string } {
  if (v === null) return { value: null };
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    return { error: `${label} must be an integer 0-23 (or null to clear)` };
  }
  if (v < 0 || v > 23) return { error: `${label} must be between 0 and 23` };
  return { value: v };
}

/** Validate that the given string is a valid IANA timezone identifier. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

router.post("/saved-searches", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) return;
  const { name, filters, notifyEnabled, dailyCap, quietHoursStart, quietHoursEnd, quietHoursTz } =
    req.body as {
      name?: string;
      filters?: SlotFilters;
      notifyEnabled?: boolean;
      dailyCap?: number | null;
      quietHoursStart?: number | null;
      quietHoursEnd?: number | null;
      quietHoursTz?: string;
    };
  if (!name?.trim()) { { res.status(400).json({ error: "name is required" }); return; } }
  if (!filters || typeof filters !== "object") { { res.status(400).json({ error: "filters object is required" }); return; } }

  const insertValues: typeof marketplaceSavedSearchesTable.$inferInsert = {
    userId: user.id,
    name: name.trim(),
    filters: filters as object,
    notifyEnabled: notifyEnabled !== false,
  };
  if (dailyCap !== undefined) {
    const r = parseDailyCap(dailyCap);
    if ("error" in r) { { res.status(400).json({ error: r.error }); return; } }
    insertValues.dailyCap = r.value;
  }
  if (quietHoursStart !== undefined) {
    const r = parseQuietHour(quietHoursStart, "quietHoursStart");
    if ("error" in r) { { res.status(400).json({ error: r.error }); return; } }
    insertValues.quietHoursStart = r.value;
  }
  if (quietHoursEnd !== undefined) {
    const r = parseQuietHour(quietHoursEnd, "quietHoursEnd");
    if ("error" in r) { { res.status(400).json({ error: r.error }); return; } }
    insertValues.quietHoursEnd = r.value;
  }
  if (typeof quietHoursTz === "string" && quietHoursTz.trim()) {
    const tz = quietHoursTz.trim();
    if (!isValidTimezone(tz)) { { res.status(400).json({ error: "quietHoursTz must be a valid IANA timezone" }); return; } }
    insertValues.quietHoursTz = tz;
  }

  const [row] = await db.insert(marketplaceSavedSearchesTable).values(insertValues).returning();
  res.status(201).json({ ...row, createdAt: row.createdAt.toISOString() });
});

router.patch("/saved-searches/:id", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const updates: Partial<typeof marketplaceSavedSearchesTable.$inferInsert> = {};
  if (typeof req.body.name === "string") updates.name = req.body.name.trim();
  if (req.body.filters && typeof req.body.filters === "object") updates.filters = req.body.filters;
  if (typeof req.body.notifyEnabled === "boolean") updates.notifyEnabled = req.body.notifyEnabled;
  if (req.body.dailyCap !== undefined) {
    const r = parseDailyCap(req.body.dailyCap);
    if ("error" in r) { { res.status(400).json({ error: r.error }); return; } }
    updates.dailyCap = r.value;
  }
  if (req.body.quietHoursStart !== undefined) {
    const r = parseQuietHour(req.body.quietHoursStart, "quietHoursStart");
    if ("error" in r) { { res.status(400).json({ error: r.error }); return; } }
    updates.quietHoursStart = r.value;
  }
  if (req.body.quietHoursEnd !== undefined) {
    const r = parseQuietHour(req.body.quietHoursEnd, "quietHoursEnd");
    if ("error" in r) { { res.status(400).json({ error: r.error }); return; } }
    updates.quietHoursEnd = r.value;
  }
  if (typeof req.body.quietHoursTz === "string" && req.body.quietHoursTz.trim()) {
    const tz = req.body.quietHoursTz.trim();
    if (!isValidTimezone(tz)) { { res.status(400).json({ error: "quietHoursTz must be a valid IANA timezone" }); return; } }
    updates.quietHoursTz = tz;
  }
  if (Object.keys(updates).length === 0) { { res.status(400).json({ error: "No updatable fields provided" }); return; } }
  const [row] = await db.update(marketplaceSavedSearchesTable)
    .set(updates)
    .where(and(eq(marketplaceSavedSearchesTable.id, id), eq(marketplaceSavedSearchesTable.userId, user.id)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Saved search not found" }); return; } }
  res.json({ ...row, createdAt: row.createdAt.toISOString() });
});

router.delete("/saved-searches/:id", async (req: Request, res: Response) => {
  const user = requireUser(req, res);
  if (!user) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  await db.delete(marketplaceSavedSearchesTable)
    .where(and(eq(marketplaceSavedSearchesTable.id, id), eq(marketplaceSavedSearchesTable.userId, user.id)));
  res.json({ success: true });
});

/**
 * Maximum number of saved-search alert notifications a single user may
 * receive in a rolling 24h window. Acts as an anti-spam guard so that a
 * very broad saved search (e.g. "any slot in the next 14 days") cannot
 * flood the player with pushes when a club opens many slots at once.
 *
 * Configurable via `MARKETPLACE_ALERT_DAILY_CAP_PER_USER`; defaults to 10.
 */
export const MARKETPLACE_ALERT_DAILY_CAP_PER_USER: number = (() => {
  const raw = process.env.MARKETPLACE_ALERT_DAILY_CAP_PER_USER;
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

/**
 * Returns true if `now` falls inside the quiet-hours window
 * [startHour, endHour) interpreted in `tz`. Supports overnight windows
 * (e.g. 22→7). Returns false when start/end are unset or equal.
 */
export function isInQuietHours(
  now: Date,
  startHour: number | null | undefined,
  endHour: number | null | undefined,
  tz: string,
): boolean {
  if (startHour == null || endHour == null || startHour === endHour) return false;
  // Get the "hour of day" in the target timezone using Intl
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
  // Intl may emit "24" for midnight on some runtimes; normalise to 0-23.
  const hour = parseInt(hourPart, 10) % 24;
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // Overnight window (e.g. 22→7): inside if hour ≥ start OR hour < end
  return hour >= startHour || hour < endHour;
}

/**
 * Evaluate every active saved search, find newly-matching slots, and send
 * a push notification to the owner. Idempotent thanks to the
 * (search_id, slot_id) unique index on the alerts table. Enforces a
 * per-user-per-day cap so a single user is never spammed.
 *
 * Returns the number of new alert rows recorded across all searches.
 */
export async function runSavedSearchAlerts(): Promise<{ notifications: number; searchesEvaluated: number }> {
  const searches = await db
    .select()
    .from(marketplaceSavedSearchesTable)
    .where(eq(marketplaceSavedSearchesTable.notifyEnabled, true));

  // Pre-compute alert counts in the last 24h, both per-user (for the global
  // cap that applies to searches without an override) and per-search (for
  // searches that opt into a custom cap).
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentRows = await db
    .select({
      userId: marketplaceSavedSearchesTable.userId,
      searchId: marketplaceSavedSearchAlertsTable.searchId,
      hasOverride: sql<boolean>`(${marketplaceSavedSearchesTable.dailyCap} is not null)`,
      cnt: sql<number>`count(*)::int`,
    })
    .from(marketplaceSavedSearchAlertsTable)
    .innerJoin(
      marketplaceSavedSearchesTable,
      eq(marketplaceSavedSearchesTable.id, marketplaceSavedSearchAlertsTable.searchId),
    )
    .where(gte(marketplaceSavedSearchAlertsTable.alertedAt, since24h))
    .groupBy(
      marketplaceSavedSearchesTable.userId,
      marketplaceSavedSearchAlertsTable.searchId,
      marketplaceSavedSearchesTable.dailyCap,
    );

  // Per-user count includes only alerts from searches WITHOUT an override —
  // searches that opt in to their own cap are excluded from the global
  // budget so a power user can raise their personal limit beyond the
  // platform default.
  const recentCountByUser = new Map<number, number>();
  const recentCountBySearch = new Map<number, number>();
  for (const r of recentRows) {
    const cnt = Number(r.cnt);
    recentCountBySearch.set(r.searchId, (recentCountBySearch.get(r.searchId) ?? 0) + cnt);
    if (!r.hasOverride) {
      recentCountByUser.set(r.userId, (recentCountByUser.get(r.userId) ?? 0) + cnt);
    }
  }

  const now = new Date();
  let notified = 0;
  for (const search of searches) {
    try {
      // Effective cap: per-search override when set, else the global default.
      // Per-search overrides BYPASS the global per-user cap so users can
      // explicitly opt in to more (or fewer) alerts than the default.
      let remainingForSearch: number;
      if (search.dailyCap != null) {
        const usedForSearch = recentCountBySearch.get(search.id) ?? 0;
        remainingForSearch = search.dailyCap - usedForSearch;
        if (remainingForSearch <= 0) {
          logger.info(
            { userId: search.userId, searchId: search.id, cap: search.dailyCap, used: usedForSearch, scope: "per-search" },
            "[marketplace-alerts] per-search daily cap reached — skipping",
          );
          continue;
        }
      } else {
        const usedForUser = recentCountByUser.get(search.userId) ?? 0;
        remainingForSearch = MARKETPLACE_ALERT_DAILY_CAP_PER_USER - usedForUser;
        if (remainingForSearch <= 0) {
          logger.info(
            { userId: search.userId, searchId: search.id, cap: MARKETPLACE_ALERT_DAILY_CAP_PER_USER, used: usedForUser, scope: "global" },
            "[marketplace-alerts] global per-user daily cap reached — skipping",
          );
          continue;
        }
      }

      // Quiet hours — defer alerts (don't lose them; the next run will pick
      // them up when the window has passed because we won't have inserted
      // alert rows for them yet).
      if (isInQuietHours(now, search.quietHoursStart, search.quietHoursEnd, search.quietHoursTz)) {
        logger.info(
          {
            userId: search.userId,
            searchId: search.id,
            quietStart: search.quietHoursStart,
            quietEnd: search.quietHoursEnd,
            tz: search.quietHoursTz,
          },
          "[marketplace-alerts] inside quiet hours — deferring",
        );
        continue;
      }

      const f = (search.filters ?? {}) as SlotFilters;
      const fromDate = f.fromDate ? new Date(f.fromDate) : new Date();
      const toDate = f.toDate ? new Date(f.toDate) : new Date(Date.now() + 14 * 86_400_000);

      const conditions = [
        eq(marketplaceSlotsTable.isPublic, true),
        eq(marketplaceSlotsTable.status, "open"),
        gte(marketplaceSlotsTable.slotDate, fromDate),
        lte(marketplaceSlotsTable.slotDate, toDate),
        eq(organizationsTable.marketplaceEnabled, true),
      ];
      if (f.orgIds?.length) conditions.push(inArray(marketplaceSlotsTable.organizationId, f.orgIds));
      if (f.courseIds?.length) conditions.push(inArray(marketplaceSlotsTable.courseId, f.courseIds));
      if (f.maxPricePaise != null) conditions.push(lte(marketplaceSlotsTable.pricePaise, f.maxPricePaise));

      const matches = await db
        .select({ slot: marketplaceSlotsTable, orgName: organizationsTable.name })
        .from(marketplaceSlotsTable)
        .innerJoin(organizationsTable, eq(organizationsTable.id, marketplaceSlotsTable.organizationId))
        .where(and(...conditions));

      const fresh = matches.filter((m) => {
        const spots = m.slot.maxPlayers - m.slot.bookedPlayers;
        if (spots < (f.minSpots ?? 1)) return false;
        if (f.daysOfWeek?.length && !f.daysOfWeek.includes(m.slot.slotDate.getDay())) return false;
        return true;
      });

      if (fresh.length === 0) continue;

      // Skip slots we already alerted this search about
      const existing = await db
        .select({ slotId: marketplaceSavedSearchAlertsTable.slotId })
        .from(marketplaceSavedSearchAlertsTable)
        .where(eq(marketplaceSavedSearchAlertsTable.searchId, search.id));
      const alreadyAlertedSet = new Set(existing.map((e) => e.slotId));
      let newOnes = fresh.filter((m) => !alreadyAlertedSet.has(m.slot.id));
      if (newOnes.length === 0) continue;

      // Trim to the effective remaining headroom (per-search override, or
      // global default when no override is set on this search).
      if (newOnes.length > remainingForSearch) {
        newOnes = newOnes.slice(0, remainingForSearch);
        logger.info(
          {
            userId: search.userId,
            searchId: search.id,
            cap: search.dailyCap ?? MARKETPLACE_ALERT_DAILY_CAP_PER_USER,
            scope: search.dailyCap != null ? "per-search" : "global",
            kept: newOnes.length,
          },
          "[marketplace-alerts] trimmed alerts to respect daily cap",
        );
      }

      // Send a single combined push & record alerts
      const sample = newOnes[0];
      const dateStr = sample.slot.slotDate.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short",
      });
      const title = `${newOnes.length} new tee time${newOnes.length === 1 ? "" : "s"} match "${search.name}"`;
      const body = newOnes.length === 1
        ? `${sample.orgName} — ${dateStr}`
        : `Earliest: ${sample.orgName}, ${dateStr} (and ${newOnes.length - 1} more)`;

      // Task #1240 — fire-and-forget; the PushDeliveryResult is discarded
      // (only the throw path is logged). No `classifyPushDelivery` mapping
      // needed — the alert row written below is the durable signal.
      sendTransactionalPush([search.userId], title, body, {
        type: "marketplace_saved_search_match",
        savedSearchId: search.id,
        slotIds: newOnes.map((m) => m.slot.id),
      }).catch((e) => logger.warn({ err: e }, "marketplace alert push failed"));

      await db.insert(marketplaceSavedSearchAlertsTable)
        .values(newOnes.map((m) => ({ searchId: search.id, slotId: m.slot.id })))
        .onConflictDoNothing();

      await db.update(marketplaceSavedSearchesTable)
        .set({ lastNotifiedAt: new Date(), lastMatchCount: newOnes.length })
        .where(eq(marketplaceSavedSearchesTable.id, search.id));

      notified += newOnes.length;
      // Update the in-memory tally so subsequent searches in this run see
      // the updated headroom. Only count toward the per-user global budget
      // when this search is using the global default (no override).
      if (search.dailyCap == null) {
        const prev = recentCountByUser.get(search.userId) ?? 0;
        recentCountByUser.set(search.userId, prev + newOnes.length);
      } else {
        const prev = recentCountBySearch.get(search.id) ?? 0;
        recentCountBySearch.set(search.id, prev + newOnes.length);
      }
    } catch (err) {
      logger.warn({ err, searchId: search.id }, "saved search alert evaluation failed");
    }
  }

  return { notifications: notified, searchesEvaluated: searches.length };
}

/**
 * POST /saved-searches/run-alerts — manual trigger for the alert evaluator.
 * Designed to be invoked from a periodic worker (cron) or by an admin.
 */
router.post("/saved-searches/run-alerts", async (req: Request, res: Response) => {
  // Allow super_admin or shared cron header
  const adminHeader = req.headers["x-cron-secret"];
  const isAdmin = (req.user as { role?: string })?.role === "super_admin";
  if (!isAdmin && adminHeader !== process.env.CRON_SECRET) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const result = await runSavedSearchAlerts();
  res.json({ success: true, notifications: result.notifications, searchesEvaluated: result.searchesEvaluated });
});

export default router;
