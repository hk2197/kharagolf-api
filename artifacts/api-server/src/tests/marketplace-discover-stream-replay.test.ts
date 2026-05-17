/**
 * Test: GET /api/marketplace-discover/stream Last-Event-ID replay (Task #836).
 *
 * When a marketplace map client briefly disconnects (network blip, server
 * restart, app backgrounded) any `slot_change` events emitted in the gap
 * used to be lost — the client only refetched on the *next* fresh event,
 * leaving pin colours stale. The /stream endpoint now tags each event with
 * a monotonic id and replays buffered events whose id > the client's
 * `Last-Event-ID` (or `?lastEventId=` query) on reconnect.
 *
 * This spec verifies:
 *  - Live events include an `id:` SSE line and an `id` field in the JSON
 *  - A reconnecting client receives missed events via Last-Event-ID header
 *  - The query-string fallback works (some proxies strip custom headers)
 *  - A gap larger than the replay buffer triggers a `resync` hint
 */
import { describe, it, expect, beforeEach } from "vitest";
import http from "node:http";
import {
  notifyDiscoverSlotChange,
  __resetDiscoverReplayBufferForTests,
} from "../routes/marketplace-discover.js";
import { createTestApp } from "./helpers.js";

interface ParsedEvent {
  id?: number;
  data: { type?: string; organizationId?: number; id?: number; reason?: string };
}

/**
 * Open an SSE connection and collect events for `windowMs`, then return
 * the parsed list. Uses raw http to keep the socket open and abort cleanly.
 */
function collectStream(
  port: number,
  opts: { lastEventIdHeader?: number; lastEventIdQuery?: number; windowMs: number },
): Promise<ParsedEvent[]> {
  return new Promise((resolve, reject) => {
    const path =
      "/api/marketplace-discover/stream" +
      (opts.lastEventIdQuery != null ? `?lastEventId=${opts.lastEventIdQuery}` : "");
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (opts.lastEventIdHeader != null) headers["Last-Event-ID"] = String(opts.lastEventIdHeader);

    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let buf = "";
      const events: ParsedEvent[] = [];
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
          const ev: ParsedEvent = { data: JSON.parse(dataLine.slice(5).trim()) };
          if (idLine) ev.id = parseInt(idLine.slice(3).trim(), 10);
          events.push(ev);
        }
      });
      setTimeout(() => {
        req.destroy();
        resolve(events);
      }, opts.windowMs);
    });
    req.on("error", (e) => {
      // Aborts after destroy() are expected; ignore.
      if ((e as NodeJS.ErrnoException).code === "ECONNRESET") return;
    });
    req.end();
    setTimeout(() => reject(new Error("stream test timed out")), opts.windowMs + 5000);
  });
}

function startTestServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = createTestApp();
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("GET /api/marketplace-discover/stream — Last-Event-ID replay", () => {
  beforeEach(() => {
    __resetDiscoverReplayBufferForTests();
  });

  it("tags live events with a monotonic id (SSE id: line and JSON field)", async () => {
    const { port, close } = await startTestServer();
    try {
      const eventsP = collectStream(port, { windowMs: 400 });
      // Give the stream a moment to open before emitting.
      await new Promise((r) => setTimeout(r, 80));
      notifyDiscoverSlotChange(101);
      notifyDiscoverSlotChange(202);
      const events = await eventsP;

      const slotChanges = events.filter((e) => e.data.type === "slot_change");
      expect(slotChanges.length).toBe(2);
      expect(slotChanges[0]!.id).toBe(1);
      expect(slotChanges[0]!.data.id).toBe(1);
      expect(slotChanges[0]!.data.organizationId).toBe(101);
      expect(slotChanges[1]!.id).toBe(2);
      expect(slotChanges[1]!.data.organizationId).toBe(202);
    } finally {
      await close();
    }
  });

  it("replays missed events on reconnect via Last-Event-ID header", async () => {
    const { port, close } = await startTestServer();
    try {
      // Simulate events emitted while the client was disconnected.
      notifyDiscoverSlotChange(11);
      notifyDiscoverSlotChange(22);
      notifyDiscoverSlotChange(33);

      // Client reconnects, last seen id = 1 → expects events 2 and 3.
      const events = await collectStream(port, { lastEventIdHeader: 1, windowMs: 250 });
      const replayed = events.filter((e) => e.data.type === "slot_change");
      expect(replayed.map((e) => e.data.organizationId)).toEqual([22, 33]);
      expect(replayed.map((e) => e.id)).toEqual([2, 3]);
    } finally {
      await close();
    }
  });

  it("replays missed events via ?lastEventId= query fallback", async () => {
    const { port, close } = await startTestServer();
    try {
      notifyDiscoverSlotChange(11);
      notifyDiscoverSlotChange(22);

      const events = await collectStream(port, { lastEventIdQuery: 1, windowMs: 250 });
      const replayed = events.filter((e) => e.data.type === "slot_change");
      expect(replayed.length).toBe(1);
      expect(replayed[0]!.data.organizationId).toBe(22);
    } finally {
      await close();
    }
  });

  it("emits a resync hint when the gap exceeds the replay buffer", async () => {
    const { port, close } = await startTestServer();
    try {
      // Only one buffered event; client claims to have seen id=999 →
      // server can't prove what's missing, so it tells the client to resync.
      notifyDiscoverSlotChange(11);
      const events = await collectStream(port, { lastEventIdHeader: 999, windowMs: 250 });
      const resync = events.find((e) => e.data.type === "resync");
      expect(resync).toBeDefined();
      expect(resync!.data.reason).toBe("gap_exceeds_buffer");
    } finally {
      await close();
    }
  });

  it("ready frame includes server's current lastEventId so idle clients can resync after a gap", async () => {
    const { port, close } = await startTestServer();
    try {
      // Simulate prior activity before the client ever connected.
      notifyDiscoverSlotChange(7);
      notifyDiscoverSlotChange(8);

      // Client connects with no cursor. Ready frame should advertise
      // the current sequence (2) so the client can adopt it as its
      // cursor for subsequent reconnects.
      const events = await collectStream(port, { windowMs: 200 });
      const ready = events.find((e) => e.data.type === "ready");
      expect(ready).toBeDefined();
      expect(typeof (ready!.data as { lastEventId?: number }).lastEventId).toBe("number");
      expect((ready!.data as { lastEventId: number }).lastEventId).toBe(2);

      // Simulate a disconnect+gap with new mutations the client missed,
      // then reconnect using the cursor we got from `ready` (= 2).
      notifyDiscoverSlotChange(9);
      notifyDiscoverSlotChange(10);
      const replayed = await collectStream(port, { lastEventIdHeader: 2, windowMs: 200 });
      const replayedChanges = replayed.filter((e) => e.data.type === "slot_change");
      expect(replayedChanges.map((e) => e.data.organizationId)).toEqual([9, 10]);
    } finally {
      await close();
    }
  });

  it("delivers events emitted during the reconnect handshake (no replay/live race)", async () => {
    // Reconnect race: an event fires while the server is between
    // 'replay buffered events' and 'register live subscriber'. With
    // the wrong ordering, that event would be dropped — too new to
    // replay, too late to broadcast. The fix is to register first and
    // replay only up to a snapshotted seq.
    const { port, close } = await startTestServer();
    try {
      // Pretend two events happened before the client reconnected.
      notifyDiscoverSlotChange(50);
      notifyDiscoverSlotChange(60);

      // Open stream with cursor=1 so server has to replay events 2..N.
      const eventsP = collectStream(port, { lastEventIdHeader: 1, windowMs: 600 });
      // Spread emissions over the whole window so several land during
      // handshake (between replay and live broadcast). With the wrong
      // ordering, those middle events would be dropped.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 5));
        notifyDiscoverSlotChange(700 + i);
      }
      const events = await eventsP;
      const slotChanges = events.filter((e) => e.data.type === "slot_change");
      const ids = slotChanges.map((e) => e.data.id).sort((a, b) => a! - b!);
      // No duplicates.
      expect(new Set(ids).size).toBe(ids.length);
      // Both pre-handshake replays present (ids 2 from id=1 cursor onward).
      expect(ids).toContain(2);
      // All 30 emissions made during/after handshake delivered.
      for (let i = 0; i < 30; i++) {
        expect(ids).toContain(3 + i);
      }
    } finally {
      await close();
    }
  });

  it("does not replay anything when the client is already up-to-date", async () => {
    const { port, close } = await startTestServer();
    try {
      notifyDiscoverSlotChange(11);
      notifyDiscoverSlotChange(22);

      const events = await collectStream(port, { lastEventIdHeader: 2, windowMs: 200 });
      const replayed = events.filter((e) => e.data.type === "slot_change");
      expect(replayed.length).toBe(0);
    } finally {
      await close();
    }
  });
});
