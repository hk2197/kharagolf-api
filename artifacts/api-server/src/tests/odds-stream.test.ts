/**
 * Integration tests: Live Odds SSE stream (Task #454 / #503)
 *
 * Verifies the /api/public/tournaments/:id/odds/stream endpoint:
 *   - Sends an initial snapshot on connect, and pushes a fresh `odds_update`
 *     event when the leaderboard is updated via notifyLeaderboardUpdate().
 *   - Returns 403 when allowSpectators is false, oddsWidgetsEnabled is false,
 *     or the request country is in ODDS_GEO_BLOCKLIST.
 *   - Schedules no broadcast (and therefore never calls buildOddsPayload) when
 *     no SSE clients are connected for the tournament.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Seed the geo blocklist BEFORE public.ts loads (it captures the env at module
// load time into a top-level constant). Hoisted so it runs prior to any
// `import` side effects in this file. We remember the previous value so the
// afterAll teardown can restore it and avoid cross-suite contamination.
const PREV_ODDS_GEO_BLOCKLIST = vi.hoisted(() => {
  const prev = process.env.ODDS_GEO_BLOCKLIST;
  process.env.ODDS_GEO_BLOCKLIST = "XX,YY";
  return prev;
});

// Mock buildOddsPayload BEFORE the unit under test imports it. We delegate
// to the real implementation but spy on calls so the no-op-when-empty test
// can assert call count.
vi.mock("../lib/odds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/odds.js")>();
  return {
    ...actual,
    buildOddsPayload: vi.fn(actual.buildOddsPayload),
  };
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { notifyLeaderboardUpdate } from "../lib/realtime.js";
import { buildOddsPayload } from "../lib/odds.js";

const buildOddsPayloadMock = vi.mocked(buildOddsPayload);

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;

beforeAll(async () => {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `OddsStreamOrg_${tag}`,
    slug: `odds-stream-${tag}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Odds Stream Course",
    slug: `odds-stream-course-${tag}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Odds Stream Tournament ${tag}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
    allowSpectators: true,
    oddsWidgetsEnabled: true,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = t.id;
});

afterAll(async () => {
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, testTournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));

  // Restore the env var we seeded in vi.hoisted so neighbouring suites don't
  // inherit our blocklist if vitest reuses this worker.
  if (PREV_ODDS_GEO_BLOCKLIST === undefined) delete process.env.ODDS_GEO_BLOCKLIST;
  else process.env.ODDS_GEO_BLOCKLIST = PREV_ODDS_GEO_BLOCKLIST;
});

// ── Helper: open an SSE connection against an in-process server and collect
//   parsed `data:` events until `untilEvents` have arrived (or timeout).
type SseClient = {
  events: Array<{ type: string; data?: unknown }>;
  close: () => void;
  done: Promise<void>;
};

function openSseClient(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): SseClient {
  const events: Array<{ type: string; data?: unknown }> = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const req = http.request({
    host: "127.0.0.1",
    port,
    path,
    method: "GET",
    headers: { Accept: "text/event-stream", ...headers },
  });

  let buf = "";
  req.on("response", (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      // SSE frames are separated by a blank line.
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const raw = dataLine.slice("data: ".length);
        try {
          events.push(JSON.parse(raw));
        } catch {
          /* heartbeat / non-JSON line — ignore */
        }
      }
    });
    res.on("end", () => resolveDone());
  });
  req.on("error", () => resolveDone());
  req.end();

  return {
    events,
    close: () => { try { req.destroy(); } catch { /* noop */ } resolveDone(); },
    done,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Live Odds SSE — gating", () => {
  it("returns 403 when allowSpectators is false", async () => {
    await db.update(tournamentsTable)
      .set({ allowSpectators: false, oddsWidgetsEnabled: true })
      .where(eq(tournamentsTable.id, testTournamentId));

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/tournaments/${testTournamentId}/odds/stream`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("odds_disabled");
  });

  it("returns 403 when oddsWidgetsEnabled is false", async () => {
    await db.update(tournamentsTable)
      .set({ allowSpectators: true, oddsWidgetsEnabled: false })
      .where(eq(tournamentsTable.id, testTournamentId));

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/tournaments/${testTournamentId}/odds/stream`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("odds_disabled");
  });

  it("returns 403 when the request country is in ODDS_GEO_BLOCKLIST", async () => {
    // The blocklist (`XX,YY`) was seeded into the env in vi.hoisted above so
    // it was captured by public.ts at module load.
    await db.update(tournamentsTable)
      .set({ allowSpectators: true, oddsWidgetsEnabled: true })
      .where(eq(tournamentsTable.id, testTournamentId));

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/tournaments/${testTournamentId}/odds/stream`)
      .set("cf-ipcountry", "xx");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("odds_disabled");
  });
});

describe("Live Odds SSE — streaming", () => {
  it("sends an initial snapshot and a follow-up odds_update on leaderboard change", async () => {
    await db.update(tournamentsTable)
      .set({ allowSpectators: true, oddsWidgetsEnabled: true })
      .where(eq(tournamentsTable.id, testTournamentId));

    const app = createTestApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const client = openSseClient(
      port,
      `/api/public/tournaments/${testTournamentId}/odds/stream`,
    );

    try {
      // 1) Initial snapshot should arrive shortly after connect.
      const gotInitial = await waitFor(() => client.events.length >= 1, 3000);
      expect(gotInitial).toBe(true);
      expect(client.events[0].type).toBe("odds_update");

      // 2) Trigger a leaderboard update; the scheduler debounces ~1s, so wait
      //    up to ~2.5s for a fresh odds_update to land.
      const baselineCount = client.events.length;
      notifyLeaderboardUpdate(testTournamentId, { entries: [] });

      const gotPush = await waitFor(
        () => client.events.length > baselineCount,
        2500,
      );
      expect(gotPush).toBe(true);
      expect(client.events[client.events.length - 1].type).toBe("odds_update");
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});

describe("Live Odds SSE — reconnect", () => {
  it("delivers a fresh snapshot and updates after a client disconnects and reconnects", async () => {
    await db.update(tournamentsTable)
      .set({ allowSpectators: true, oddsWidgetsEnabled: true })
      .where(eq(tournamentsTable.id, testTournamentId));

    const app = createTestApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      // First connection — receive snapshot, then disconnect.
      const first = openSseClient(
        port,
        `/api/public/tournaments/${testTournamentId}/odds/stream`,
      );
      const gotFirstSnapshot = await waitFor(() => first.events.length >= 1, 3000);
      expect(gotFirstSnapshot).toBe(true);
      first.close();
      await first.done;

      // Reconnect with a brand-new client — the new connection must also get
      // its own snapshot and receive subsequent push updates.
      const second = openSseClient(
        port,
        `/api/public/tournaments/${testTournamentId}/odds/stream`,
      );
      try {
        const gotSecondSnapshot = await waitFor(() => second.events.length >= 1, 3000);
        expect(gotSecondSnapshot).toBe(true);
        expect(second.events[0].type).toBe("odds_update");

        const baselineCount = second.events.length;
        notifyLeaderboardUpdate(testTournamentId, { entries: [] });
        const gotPush = await waitFor(
          () => second.events.length > baselineCount,
          2500,
        );
        expect(gotPush).toBe(true);
        expect(second.events[second.events.length - 1].type).toBe("odds_update");
      } finally {
        second.close();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});

describe("Live Odds SSE — broadcast scheduler", () => {
  it("is a no-op (does not call buildOddsPayload) when no clients are connected", async () => {
    // Use a tournament id with definitely no live SSE clients connected.
    const idleTournamentId = testTournamentId + 7777777;
    buildOddsPayloadMock.mockClear();

    notifyLeaderboardUpdate(idleTournamentId, { entries: [] });

    // Wait past the debounce window plus a buffer.
    await new Promise((r) => setTimeout(r, 1500));

    const callsForIdle = buildOddsPayloadMock.mock.calls
      .filter(([tid]) => tid === idleTournamentId);
    expect(callsForIdle.length).toBe(0);
  }, 10_000);
});
