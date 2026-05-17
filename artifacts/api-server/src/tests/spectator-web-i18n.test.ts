/**
 * Tests for the language-aware spectator web surface (Task #802).
 *
 * The web spectator dashboard reads its highlight feed from
 *   GET /api/public/tournaments/:id/notable-events?lang=xx
 * and listens for `scoring_event` SSE messages on
 *   GET /api/public/tournaments/:id/leaderboard/stream?lang=xx
 *
 * Both surfaces must echo the strings returned by `translateSpectatorPush`
 * — the shared server-side translator already used by mobile push — so
 * no English copy lives in the web client.
 */
import { describe, it, expect, vi } from "vitest";

import {
  notifyScoringEvent,
  addSSEClient,
  removeSSEClient,
  recordNotableEvent,
  type ScoringEvent,
} from "../lib/realtime.js";
import { translateSpectatorPush } from "../lib/spectatorPushI18n.js";

type CapturedWrite = string;

function fakeRes() {
  const writes: CapturedWrite[] = [];
  const res = {
    writes,
    write: vi.fn((chunk: string) => { writes.push(chunk); return true; }),
    end: vi.fn(),
  };
  return res;
}

function parseScoringEvent(chunk: string) {
  const trimmed = chunk.replace(/^data:\s*/, "").trim();
  return JSON.parse(trimmed);
}

describe("Spectator highlight web surface — Task #802", () => {
  it("notifyScoringEvent decorates each SSE client with translated title/body in their language", () => {
    const tournamentId = 99_990_001;
    const enRes = fakeRes() as unknown as Parameters<typeof addSSEClient>[1] & { writes: CapturedWrite[] };
    const esRes = fakeRes() as unknown as Parameters<typeof addSSEClient>[1] & { writes: CapturedWrite[] };
    const jaRes = fakeRes() as unknown as Parameters<typeof addSSEClient>[1] & { writes: CapturedWrite[] };
    const noLangRes = fakeRes() as unknown as Parameters<typeof addSSEClient>[1] & { writes: CapturedWrite[] };

    addSSEClient(tournamentId, enRes, "en");
    addSSEClient(tournamentId, esRes, "es");
    addSSEClient(tournamentId, jaRes, "ja");
    // Older client / no lang param — defaults to English.
    addSSEClient(tournamentId, noLangRes);

    const event: ScoringEvent = {
      tournamentId,
      playerId: 555,
      playerName: "Tiger Woods",
      holeNumber: 7,
      strokes: 1,
      par: 4,
      toPar: -3,
      eventType: "hole_in_one",
      occurredAt: new Date().toISOString(),
    };

    notifyScoringEvent(tournamentId, event);

    const enExp = translateSpectatorPush("en", event);
    const esExp = translateSpectatorPush("es", event);
    const jaExp = translateSpectatorPush("ja", event);

    const enMsg = parseScoringEvent((enRes as unknown as { writes: CapturedWrite[] }).writes[0]);
    const esMsg = parseScoringEvent((esRes as unknown as { writes: CapturedWrite[] }).writes[0]);
    const jaMsg = parseScoringEvent((jaRes as unknown as { writes: CapturedWrite[] }).writes[0]);
    const fbMsg = parseScoringEvent((noLangRes as unknown as { writes: CapturedWrite[] }).writes[0]);

    expect(enMsg.type).toBe("scoring_event");
    expect(enMsg.data.title).toBe(enExp.title);
    expect(enMsg.data.body).toBe(enExp.body);
    expect(enMsg.data.lang).toBe("en");

    expect(esMsg.data.title).toBe(esExp.title);
    expect(esMsg.data.body).toBe(esExp.body);
    expect(esMsg.data.body).toContain("Tiger Woods");
    expect(esMsg.data.lang).toBe("es");

    expect(jaMsg.data.title).toBe(jaExp.title);
    expect(jaMsg.data.body).toBe(jaExp.body);
    expect(jaMsg.data.lang).toBe("ja");

    expect(fbMsg.data.title).toBe(enExp.title);
    expect(fbMsg.data.lang).toBe("en");

    // The web client must be able to render the highlight without owning
    // its own copy — strings should already differ across languages.
    expect(esMsg.data.title).not.toBe(enMsg.data.title);
    expect(jaMsg.data.title).not.toBe(enMsg.data.title);

    removeSSEClient(tournamentId, enRes);
    removeSSEClient(tournamentId, esRes);
    removeSSEClient(tournamentId, jaRes);
    removeSSEClient(tournamentId, noLangRes);
  });

  it("notable-events route translates each event in the requested language", async () => {
    // We import the route module lazily so the realtime singletons are
    // already initialised by the previous test (and so vitest doesn't try
    // to bootstrap the express app twice).
    const { default: publicRouter } = await import("../routes/public.js");

    const tournamentId = 99_990_002;
    const baseEvent: ScoringEvent = {
      tournamentId,
      playerId: 42,
      playerName: "María García",
      holeNumber: 12,
      strokes: 3,
      par: 5,
      toPar: -2,
      eventType: "eagle",
      occurredAt: new Date().toISOString(),
    };
    recordNotableEvent(tournamentId, baseEvent);
    recordNotableEvent(tournamentId, { ...baseEvent, eventType: "hole_in_one", strokes: 1, toPar: -4, holeNumber: 17 });

    // Find the registered route handler instead of spinning up a real
    // server — keeps the test hermetic.
    const layer = (publicRouter as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ method?: string; handle: (req: unknown, res: unknown, next: unknown) => unknown }> } }> })
      .stack
      .find((l) => l.route?.path === "/tournaments/:tournamentId/notable-events");
    expect(layer?.route).toBeDefined();
    const handler = layer!.route!.stack[0].handle;

    async function call(lang: string | undefined) {
      const req = {
        params: { tournamentId: String(tournamentId) },
        query: lang === undefined ? {} : { lang },
      } as unknown;
      const captured: { body?: unknown } = {};
      const res = {
        json: (body: unknown) => { captured.body = body; return res; },
        status: () => res,
      } as unknown;
      await handler(req, res, () => {});
      return captured.body as { events: Array<ScoringEvent & { title: string; body: string; lang: string }> };
    }

    const en = await call("en");
    const es = await call("es");
    const ja = await call("ja");
    const def = await call(undefined);
    const bogus = await call("xx-not-real");

    expect(en.events).toHaveLength(2);
    expect(es.events).toHaveLength(2);
    expect(ja.events).toHaveLength(2);

    for (const ev of en.events) {
      expect(ev.title).toBe(translateSpectatorPush("en", ev).title);
      expect(ev.lang).toBe("en");
    }
    for (const ev of es.events) {
      expect(ev.title).toBe(translateSpectatorPush("es", ev).title);
      expect(ev.body).toContain("María García");
      expect(ev.lang).toBe("es");
    }
    for (const ev of ja.events) {
      expect(ev.title).toBe(translateSpectatorPush("ja", ev).title);
      expect(ev.lang).toBe("ja");
    }

    // Missing or unsupported langs fall back cleanly to English.
    expect(def.events[0].lang).toBe("en");
    expect(bogus.events[0].lang).toBe("en");
    expect(bogus.events[0].title).toBe(translateSpectatorPush("en", bogus.events[0]).title);

    // Spanish + Japanese copy must actually differ from English for at
    // least one event — the whole point of the change is that the web
    // spectator dashboard receives non-English strings instead of falling
    // back to the hard-coded English labels it used to render locally.
    // (Some short loanwords like "Birdie" coincide across en/es titles, so
    // we assert at least one event differs rather than all of them.)
    expect(es.events.some((e, i) => e.title !== en.events[i].title || e.body !== en.events[i].body)).toBe(true);
    expect(ja.events.some((e, i) => e.title !== en.events[i].title || e.body !== en.events[i].body)).toBe(true);
  });
});
