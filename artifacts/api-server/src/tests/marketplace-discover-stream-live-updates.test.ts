/**
 * Integration test: live slot updates over the marketplace map streams (Task #837).
 *
 * Wires real HTTP requests through the marketplace router and asserts that:
 *   - the cross-club /api/marketplace-discover/stream pushes a `slot_change`
 *     event tagged with the right organizationId for create / book / cancel
 *     / delete mutations within ~1s
 *   - the per-org /api/organizations/:orgId/marketplace/stream still receives
 *     its existing `slot_update` payloads (regression guard for the
 *     `broadcastSlotUpdate` helper that fans out to both streams)
 *
 * The test stands up an in-process HTTP server so SSE long-polling actually
 * works end-to-end (supertest's request/response model can't hold streams
 * open). It uses a free slot (pricePaise=0) so the booking path auto-confirms
 * without any Razorpay round-trip, and an admin user so the cancel-window
 * check is bypassed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  marketplaceSlotsTable,
  marketplaceBookingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import { __resetDiscoverReplayBufferForTests } from "../routes/marketplace-discover.js";

interface ParsedEvent {
  id?: number;
  data: { type?: string; organizationId?: number; slot?: { id?: number } };
}

/**
 * Long-running SSE client. Keeps the underlying socket open and parses
 * data frames into `events` as they arrive so callers can poll for the
 * specific event type they expect.
 */
type SseClient = {
  events: ParsedEvent[];
  close: () => void;
};

function openSseClient(port: number, path: string): SseClient {
  const events: ParsedEvent[] = [];
  const req = http.request({
    host: "127.0.0.1",
    port,
    path,
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });
  let buf = "";
  req.on("response", (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const lines = part.split("\n");
        const idLine = lines.find((l) => l.startsWith("id:"));
        const dataLine = lines.find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          const ev: ParsedEvent = { data: JSON.parse(dataLine.slice(5).trim()) };
          if (idLine) ev.id = parseInt(idLine.slice(3).trim(), 10);
          events.push(ev);
        } catch {
          /* heartbeat / non-JSON line — ignore */
        }
      }
    });
  });
  req.on("error", () => { /* aborts on close are expected */ });
  req.end();
  return { events, close: () => { try { req.destroy(); } catch { /* noop */ } } };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let userId: number;
let courseId: number;
let app: ReturnType<typeof createTestApp>;
let server: http.Server;
let port: number;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `MktStreamLive_${stamp}`,
    slug: `mkt-stream-live-${stamp}`,
    subscriptionTier: "starter",
    marketplaceEnabled: true,
    // Default exposure on so create() sets isPublic=true (which is the only
    // way the per-org stream gets the slot payload from broadcastSlotUpdate).
    marketplaceDefaultPublic: true,
    // 0h means players can't self-cancel, but admins always bypass the
    // window — the test uses an admin user so this is irrelevant. Pick a
    // friendly default.
    marketplaceCancelWindowHours: 0,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `mkt-stream-live-${stamp}`,
    username: `mkt_stream_live_${stamp}`,
    email: `mkt_stream_live_${stamp}@example.com`,
    displayName: "Marketplace Stream Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId,
    role: "org_admin",
  });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Stream Test Course",
    slug: `stream-test-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const admin: TestUser = {
    id: userId,
    username: `mkt_stream_live_${stamp}`,
    displayName: "Marketplace Stream Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(marketplaceBookingsTable).where(eq(marketplaceBookingsTable.organizationId, orgId));
  await db.delete(marketplaceSlotsTable).where(eq(marketplaceSlotsTable.organizationId, orgId));
  await db.delete(coursesTable).where(eq(coursesTable.organizationId, orgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

/** Tiny fetch-style helper that returns parsed JSON for a JSON request. */
async function jsonRequest<T = unknown>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": String(payload.length) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { buf += c; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: buf ? (JSON.parse(buf) as T) : ({} as T) });
          } catch (e) {
            reject(new Error(`Failed to parse response from ${method} ${path}: ${(e as Error).message}\nbody=${buf}`));
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("marketplace map live updates — Task #837", () => {
  it("pushes slot_change (cross-club) and slot_update (per-org) for create / book / cancel / delete within ~1s", async () => {
    __resetDiscoverReplayBufferForTests();

    const discover = openSseClient(port, "/api/marketplace-discover/stream");
    const perOrg = openSseClient(port, `/api/organizations/${orgId}/marketplace/stream`);

    try {
      // Wait for the discover stream's `ready` frame so we know our
      // subscription is live before we trigger the first mutation. The
      // per-org stream has no ready frame, so a brief settle is enough.
      const ready = await waitFor(
        () => discover.events.some((e) => e.data.type === "ready"),
        2000,
      );
      expect(ready).toBe(true);
      await new Promise((r) => setTimeout(r, 50));

      // ── 1) CREATE ────────────────────────────────────────────────
      const slotDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const baselineDiscover = discover.events.length;
      const baselinePerOrg = perOrg.events.length;

      const created = await jsonRequest<{ id: number }>(
        "POST",
        `/api/organizations/${orgId}/marketplace`,
        { slotDate, maxPlayers: 4, pricePaise: 0, courseId, isPublic: true },
      );
      expect(created.status).toBe(201);
      const slotId = created.body.id;
      expect(typeof slotId).toBe("number");

      const sawCreateDiscover = await waitFor(
        () => discover.events
          .slice(baselineDiscover)
          .some((e) => e.data.type === "slot_change" && e.data.organizationId === orgId),
        1500,
      );
      expect(sawCreateDiscover, "discover stream did not see slot_change for create").toBe(true);

      const sawCreatePerOrg = await waitFor(
        () => perOrg.events
          .slice(baselinePerOrg)
          .some((e) => e.data.type === "slot_update" && e.data.slot?.id === slotId),
        1500,
      );
      expect(sawCreatePerOrg, "per-org stream did not see slot_update for create").toBe(true);

      // ── 2) BOOK ──────────────────────────────────────────────────
      const baselineDiscover2 = discover.events.length;
      const baselinePerOrg2 = perOrg.events.length;

      const booked = await jsonRequest<{ booking: { id: number }; requiresPayment: boolean }>(
        "POST",
        `/api/organizations/${orgId}/marketplace/${slotId}/book`,
        { players: 1 },
      );
      expect(booked.status).toBe(200);
      expect(booked.body.requiresPayment).toBe(false);
      const bookingId = booked.body.booking.id;

      const sawBookDiscover = await waitFor(
        () => discover.events
          .slice(baselineDiscover2)
          .some((e) => e.data.type === "slot_change" && e.data.organizationId === orgId),
        1500,
      );
      expect(sawBookDiscover, "discover stream did not see slot_change for book").toBe(true);

      const sawBookPerOrg = await waitFor(
        () => perOrg.events
          .slice(baselinePerOrg2)
          .some((e) => e.data.type === "slot_update" && e.data.slot?.id === slotId),
        1500,
      );
      expect(sawBookPerOrg, "per-org stream did not see slot_update for book").toBe(true);

      // ── 3) CANCEL ────────────────────────────────────────────────
      const baselineDiscover3 = discover.events.length;
      const baselinePerOrg3 = perOrg.events.length;

      const cancelled = await jsonRequest(
        "POST",
        `/api/organizations/${orgId}/marketplace/${slotId}/cancel/${bookingId}`,
      );
      expect(cancelled.status).toBe(200);

      const sawCancelDiscover = await waitFor(
        () => discover.events
          .slice(baselineDiscover3)
          .some((e) => e.data.type === "slot_change" && e.data.organizationId === orgId),
        1500,
      );
      expect(sawCancelDiscover, "discover stream did not see slot_change for cancel").toBe(true);

      const sawCancelPerOrg = await waitFor(
        () => perOrg.events
          .slice(baselinePerOrg3)
          .some((e) => e.data.type === "slot_update" && e.data.slot?.id === slotId),
        1500,
      );
      expect(sawCancelPerOrg, "per-org stream did not see slot_update for cancel").toBe(true);

      // ── 4) DELETE ────────────────────────────────────────────────
      const baselineDiscover4 = discover.events.length;
      const baselinePerOrg4 = perOrg.events.length;

      const deleted = await jsonRequest(
        "DELETE",
        `/api/organizations/${orgId}/marketplace/${slotId}`,
      );
      expect(deleted.status).toBe(200);

      const sawDeleteDiscover = await waitFor(
        () => discover.events
          .slice(baselineDiscover4)
          .some((e) => e.data.type === "slot_change" && e.data.organizationId === orgId),
        1500,
      );
      expect(sawDeleteDiscover, "discover stream did not see slot_change for delete").toBe(true);

      // Delete calls broadcastSlotUpdate(orgId) without a slot payload, so
      // the per-org stream receives a bare `slot_update` ping (no `slot`
      // field). That bare ping is the regression guard for the helper.
      const sawDeletePerOrg = await waitFor(
        () => perOrg.events
          .slice(baselinePerOrg4)
          .some((e) => e.data.type === "slot_update"),
        1500,
      );
      expect(sawDeletePerOrg, "per-org stream did not see slot_update for delete").toBe(true);
    } finally {
      discover.close();
      perOrg.close();
    }
  }, 20_000);
});
