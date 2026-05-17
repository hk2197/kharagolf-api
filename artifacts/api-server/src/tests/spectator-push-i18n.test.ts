/**
 * Tests for language-aware spectator highlight push notifications.
 *
 * Verifies that `deliverSpectatorPush` looks up each recipient's
 * `preferredLanguage` and dispatches one push batch per language with
 * localised title + body strings.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendPushToUsersMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({
      attempted: 0, sent: 0, failed: 0, invalid: 0,
    }),
  ),
}));

vi.mock("../lib/push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
}));

import { db } from "@workspace/db";
import {
  organizationsTable, appUsersTable, tournamentsTable, playersTable,
  teeTimesTable, teeTimePlayersTable, spectatorFollowsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { deliverSpectatorPush } from "../lib/spectatorNotify.js";
import {
  translateSpectatorPush, SPECTATOR_PUSH_LANGS,
  type SpectatorPushLang,
} from "../lib/spectatorPushI18n.js";

let testOrgId: number;
let tournamentId: number;
const userIds: number[] = [];
const playerIds: number[] = [];
const teeTimeIds: number[] = [];

async function makeUser(suffix: string, lang: SpectatorPushLang) {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `spec-i18n-${suffix}-${ts}`,
    username: `spec_i18n_${suffix}_${ts}`,
    email: `${suffix}_${ts}@example.test`,
    displayName: `Spectator ${suffix}`,
    role: "player",
    organizationId: testOrgId,
    preferredLanguage: lang,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makePlayer(firstName: string) {
  const [p] = await db.insert(playersTable).values({
    tournamentId, firstName, lastName: "Test",
  }).returning({ id: playersTable.id });
  playerIds.push(p.id);
  return p.id;
}

async function makeTeeTime(players: number[]) {
  const [tt] = await db.insert(teeTimesTable).values({
    tournamentId, round: 1,
    teeTime: new Date(Date.now() + 60 * 60 * 1000),
    startingHole: 1,
  }).returning({ id: teeTimesTable.id });
  teeTimeIds.push(tt.id);
  for (const playerId of players) {
    await db.insert(teeTimePlayersTable).values({ teeTimeId: tt.id, playerId });
  }
  return tt.id;
}

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `SpecI18nOrg_${ts}`,
    slug: `spec-i18n-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [tourn] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    name: `SpecI18n_${ts}`,
    status: "active",
    startDate: new Date(),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tourn.id;
});

afterAll(async () => {
  if (teeTimeIds.length > 0) {
    await db.delete(teeTimePlayersTable).where(inArray(teeTimePlayersTable.teeTimeId, teeTimeIds));
    await db.delete(teeTimesTable).where(inArray(teeTimesTable.id, teeTimeIds));
  }
  if (userIds.length > 0) {
    await db.delete(spectatorFollowsTable).where(inArray(spectatorFollowsTable.userId, userIds));
  }
  if (playerIds.length > 0) {
    await db.delete(playersTable).where(inArray(playersTable.id, playerIds));
  }
  if (tournamentId) {
    await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  }
  if (userIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(() => {
  sendPushToUsersMock.mockClear();
});

describe("translateSpectatorPush", () => {
  it("ships title + body for every supported language and event type", () => {
    const event = {
      tournamentId: 1, playerId: 1, playerName: "Alex", holeNumber: 7,
      strokes: 1, par: 3, toPar: -2,
      occurredAt: new Date().toISOString(),
      round: 2,
    };
    const eventTypes = [
      "hole_in_one", "eagle", "birdie", "round_start", "round_finish", "tee_off",
    ] as const;

    for (const lang of SPECTATOR_PUSH_LANGS) {
      for (const eventType of eventTypes) {
        const out = translateSpectatorPush(lang, { ...event, eventType });
        expect(out.title.length).toBeGreaterThan(0);
        expect(out.body.length).toBeGreaterThan(0);
      }
    }
  });

  it("interpolates player name, hole and round into the body", () => {
    const base = {
      tournamentId: 1, playerId: 1, playerName: "Jin",
      holeNumber: 12, strokes: 2, par: 4, toPar: -2,
      occurredAt: new Date().toISOString(),
      round: 3,
    };

    const enHio = translateSpectatorPush("en", { ...base, eventType: "hole_in_one" });
    expect(enHio.body).toContain("Jin");
    expect(enHio.body).toContain("12");

    const frEagle = translateSpectatorPush("fr", { ...base, eventType: "eagle" });
    expect(frEagle.body).toContain("Jin");
    expect(frEagle.body).toContain("12");
    expect(frEagle.title).toBe("🦅 Eagle !");

    const koStart = translateSpectatorPush("ko", { ...base, eventType: "round_start" });
    expect(koStart.body).toContain("Jin");
    expect(koStart.body).toContain("3"); // round number

    const zhFinish = translateSpectatorPush("zh", { ...base, eventType: "round_finish", round: undefined });
    // No round → no round clause appended.
    expect(zhFinish.body).not.toContain("第");
  });

  it("falls back to English for unknown languages", () => {
    const out = translateSpectatorPush("xx" as never, {
      tournamentId: 1, playerId: 1, playerName: "Sam", holeNumber: 4,
      strokes: 2, par: 3, toPar: -1, eventType: "birdie",
      occurredAt: new Date().toISOString(),
    });
    expect(out.title).toBe("🐦 Birdie");
    expect(out.body).toContain("Sam");
  });
});

describe("deliverSpectatorPush language grouping", () => {
  it("sends one push batch per recipient language with localised copy", async () => {
    const player = await makePlayer("LangPlayer");
    await makeTeeTime([player]);

    const enUser = await makeUser("en_user", "en");
    const frUser = await makeUser("fr_user", "fr");
    const jaUser = await makeUser("ja_user", "ja");
    const fr2User = await makeUser("fr2_user", "fr");

    for (const uid of [enUser, frUser, jaUser, fr2User]) {
      await db.insert(spectatorFollowsTable).values({
        userId: uid, tournamentId, playerId: player, notifyBirdie: true,
      });
    }

    await deliverSpectatorPush({
      tournamentId, playerId: player, playerName: "Alex Birdie",
      holeNumber: 9, strokes: 3, par: 4, toPar: -1,
      eventType: "birdie",
      occurredAt: new Date().toISOString(),
    });

    // Three language buckets: en, fr (2 users), ja.
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(3);

    const calls = sendPushToUsersMock.mock.calls.map((c) => ({
      ids: (c[0] as number[]).slice().sort((a, b) => a - b),
      title: c[1] as string,
      body: c[2] as string,
      data: c[3] as { lang?: string; type?: string },
    }));

    const enCall = calls.find((c) => c.data.lang === "en");
    const frCall = calls.find((c) => c.data.lang === "fr");
    const jaCall = calls.find((c) => c.data.lang === "ja");

    expect(enCall).toBeDefined();
    expect(frCall).toBeDefined();
    expect(jaCall).toBeDefined();

    expect(enCall!.ids).toEqual([enUser]);
    expect(frCall!.ids).toEqual([frUser, fr2User].sort((a, b) => a - b));
    expect(jaCall!.ids).toEqual([jaUser]);

    expect(enCall!.title).toBe("🐦 Birdie");
    expect(enCall!.body).toContain("Alex Birdie");
    expect(enCall!.body).toContain("9");

    expect(frCall!.title).toBe("🐦 Birdie");
    expect(frCall!.body).toContain("trou 9");

    expect(jaCall!.title).toBe("🐦 バーディー");
    expect(jaCall!.body).toContain("9番ホール");

    // The data envelope retains a stable type for client routing.
    for (const c of calls) {
      expect(c.data.type).toBe("spectator_birdie");
    }
  });
});
