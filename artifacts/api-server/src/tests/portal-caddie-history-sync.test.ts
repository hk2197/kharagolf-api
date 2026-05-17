/**
 * Task #990 — backend coverage for the AI Caddie chat-history sync endpoints
 * shipped in Task #843.
 *
 *   GET    /api/portal/caddie/history
 *   PUT    /api/portal/caddie/history
 *   DELETE /api/portal/caddie/history
 *
 * The mobile client mirrors the transcript to AsyncStorage and PUTs the full
 * (capped) array on every change so the history follows the player across
 * phones, tablets, and the web portal. These tests pin:
 *
 *   1. Save → load round-trip — a PUT persists messages and a subsequent GET
 *      returns the same array plus a fresh `updatedAt` ISO timestamp.
 *   2. Last-write-wins — a second PUT replaces (not appends) the stored
 *      transcript and bumps `updatedAt`.
 *   3. Sanitisation — junk entries (missing id/role/content) are stripped and
 *      the array is capped at 50 messages (CADDIE_HISTORY_MAX_MESSAGES).
 *   4. DELETE wipes the row; a follow-up GET returns an empty array and a
 *      null `updatedAt`.
 *   5. Cross-user isolation — Player A's transcript is never visible to
 *      Player B, and B clearing their (empty) history does not affect A.
 *   6. Auth gate — an unauthenticated caller gets 401 from all three verbs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db, appUsersTable, caddieChatHistoryTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let userAId: number;
let userBId: number;
let userA: TestUser;
let userB: TestUser;

beforeAll(async () => {
  const tag = uid("caddieHist");

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-a`,
    username: `${tag}_a`,
    email: `${tag}-a@test.local`,
    displayName: "Caddie History A",
    role: "player",
  }).returning({ id: appUsersTable.id });
  userAId = a.id;
  userA = { id: a.id, username: `${tag}_a`, role: "player" };

  const [b] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-b`,
    username: `${tag}_b`,
    email: `${tag}-b@test.local`,
    displayName: "Caddie History B",
    role: "player",
  }).returning({ id: appUsersTable.id });
  userBId = b.id;
  userB = { id: b.id, username: `${tag}_b`, role: "player" };
});

afterAll(async () => {
  await db.delete(caddieChatHistoryTable).where(inArray(caddieChatHistoryTable.userId, [userAId, userBId]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [userAId, userBId]));
});

beforeEach(async () => {
  await db.delete(caddieChatHistoryTable).where(inArray(caddieChatHistoryTable.userId, [userAId, userBId]));
});

const sample = (id: string, role: "user" | "assistant", content: string) => ({
  id, role, content,
});

describe("GET/PUT/DELETE /api/portal/caddie/history — sync round-trip", () => {
  it("PUT then GET returns the persisted messages and a fresh updatedAt", async () => {
    const app = createTestApp(userA);
    const messages = [
      sample("m1", "user", "What club for 150y into the wind?"),
      { ...sample("m2", "assistant", "7-iron stepped up half a club."),
        context: { shots: 12, rounds: 3, mode: "shots" as const, totalTrackedShots: 240 } },
    ];

    const put = await request(app).put("/api/portal/caddie/history")
      .send({ messages }).expect(200);
    expect(put.body.ok).toBe(true);
    expect(put.body.count).toBe(2);
    expect(typeof put.body.updatedAt).toBe("string");

    const get = await request(app).get("/api/portal/caddie/history").expect(200);
    expect(get.body.messages).toHaveLength(2);
    expect(get.body.messages[0]).toMatchObject({ id: "m1", role: "user", content: "What club for 150y into the wind?" });
    expect(get.body.messages[1]).toMatchObject({
      id: "m2", role: "assistant",
      context: { shots: 12, rounds: 3, mode: "shots", totalTrackedShots: 240 },
    });
    expect(typeof get.body.updatedAt).toBe("string");
    expect(new Date(get.body.updatedAt).toString()).not.toBe("Invalid Date");
  });

  it("a second PUT replaces (last-write-wins) the stored transcript and bumps updatedAt", async () => {
    const app = createTestApp(userA);

    const firstPut = await request(app).put("/api/portal/caddie/history")
      .send({ messages: [sample("a", "user", "first")] }).expect(200);
    const firstUpdatedAt = firstPut.body.updatedAt;

    // Wait a tick so updatedAt changes deterministically.
    await new Promise((r) => setTimeout(r, 10));

    await request(app).put("/api/portal/caddie/history")
      .send({ messages: [sample("b", "user", "second"), sample("c", "assistant", "reply")] })
      .expect(200);

    const get = await request(app).get("/api/portal/caddie/history").expect(200);
    expect(get.body.messages.map((m: { id: string }) => m.id)).toEqual(["b", "c"]);
    expect(new Date(get.body.updatedAt).getTime()).toBeGreaterThan(new Date(firstUpdatedAt).getTime());

    // Database has exactly one row for this user (upsert, not insert).
    const rows = await db.select().from(caddieChatHistoryTable)
      .where(eq(caddieChatHistoryTable.userId, userAId));
    expect(rows).toHaveLength(1);
    expect(rows[0].messages).toHaveLength(2);
  });

  it("sanitises malformed entries and caps the stored history at 50 messages", async () => {
    const app = createTestApp(userA);

    // 60 valid messages — should be capped to the most recent 50.
    const valid = Array.from({ length: 60 }, (_, i) =>
      sample(`m${i}`, i % 2 === 0 ? "user" : "assistant", `msg ${i}`));
    // Junk entries that must be filtered out.
    const junk = [
      null,
      "not-an-object",
      { id: 123, role: "user", content: "bad id type" },
      { id: "x", role: "system", content: "bad role" },
      { id: "y", role: "user" /* no content */ },
    ];

    const put = await request(app).put("/api/portal/caddie/history")
      .send({ messages: [...junk, ...valid] }).expect(200);
    expect(put.body.count).toBe(50);

    const get = await request(app).get("/api/portal/caddie/history").expect(200);
    expect(get.body.messages).toHaveLength(50);
    // Cap keeps the *last* 50, so it should start at m10 and end at m59.
    expect(get.body.messages[0].id).toBe("m10");
    expect(get.body.messages[49].id).toBe("m59");
  });

  it("DELETE wipes the row; a follow-up GET returns empty messages and null updatedAt", async () => {
    const app = createTestApp(userA);
    await request(app).put("/api/portal/caddie/history")
      .send({ messages: [sample("m1", "user", "hi")] }).expect(200);

    const del = await request(app).delete("/api/portal/caddie/history").expect(200);
    expect(del.body.ok).toBe(true);

    const get = await request(app).get("/api/portal/caddie/history").expect(200);
    expect(get.body.messages).toEqual([]);
    expect(get.body.updatedAt).toBeNull();

    const rows = await db.select().from(caddieChatHistoryTable)
      .where(eq(caddieChatHistoryTable.userId, userAId));
    expect(rows).toHaveLength(0);
  });
});

describe("cross-user isolation — one player's history never leaks to another", () => {
  it("player A's transcript is invisible to player B and vice-versa", async () => {
    const appA = createTestApp(userA);
    const appB = createTestApp(userB);

    await request(appA).put("/api/portal/caddie/history")
      .send({ messages: [sample("a1", "user", "A's secret question")] }).expect(200);
    await request(appB).put("/api/portal/caddie/history")
      .send({ messages: [sample("b1", "user", "B's separate question")] }).expect(200);

    const aRes = await request(appA).get("/api/portal/caddie/history").expect(200);
    const bRes = await request(appB).get("/api/portal/caddie/history").expect(200);

    expect(aRes.body.messages).toHaveLength(1);
    expect(aRes.body.messages[0].id).toBe("a1");
    expect(aRes.body.messages[0].content).toBe("A's secret question");

    expect(bRes.body.messages).toHaveLength(1);
    expect(bRes.body.messages[0].id).toBe("b1");
    expect(bRes.body.messages[0].content).toBe("B's separate question");
  });

  it("player B clearing their history does not touch player A's row", async () => {
    const appA = createTestApp(userA);
    const appB = createTestApp(userB);

    await request(appA).put("/api/portal/caddie/history")
      .send({ messages: [sample("a1", "user", "keep me")] }).expect(200);

    // B has nothing, but issues DELETE anyway (idempotent).
    await request(appB).delete("/api/portal/caddie/history").expect(200);

    const aRes = await request(appA).get("/api/portal/caddie/history").expect(200);
    expect(aRes.body.messages).toHaveLength(1);
    expect(aRes.body.messages[0].id).toBe("a1");
  });
});

describe("auth gate — unauthenticated callers are rejected", () => {
  it("GET, PUT, and DELETE all return 401 with no session", async () => {
    const app = createTestApp(/* no user */);
    await request(app).get("/api/portal/caddie/history").expect(401);
    await request(app).put("/api/portal/caddie/history").send({ messages: [] }).expect(401);
    await request(app).delete("/api/portal/caddie/history").expect(401);
  });
});
