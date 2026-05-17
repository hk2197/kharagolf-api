/**
 * Integration tests: Push Delivery Stats Accounting
 *
 * Verifies that sendPushToUsers returns accurate PushDeliveryResult in four scenarios:
 *   1. No registered device tokens → all zeroed, Expo API never called
 *   2. Invalid (non-Expo) token format → counted as invalid, API never called
 *   3. Expo API HTTP error → failed count equals chunk size, sent=0
 *   4. Mixed ok/error tickets from Expo → per-ticket counts are accurate
 *
 * Uses the real DB for device-token fixtures and mocks globalThis.fetch to control
 * the Expo API responses without making real network calls.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  deviceTokensTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendPushToUsers } from "../lib/push.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let testOrgId: number;
let testUserId: number;
let noTokenUserId: number;
let validTokenId: number;
let invalidTokenId: number;

const VALID_EXPO_TOKEN = "ExponentPushToken[push-stats-valid-token]";
const INVALID_TOKEN = "fcm:legacy-device-token-not-expo-format";

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PushDelivery_${Date.now()}`,
    slug: `test-push-delivery-${Date.now()}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  // User WITH a valid Expo token
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `push-delivery-user-${Date.now()}`,
    username: `push_delivery_${Date.now()}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [validRow] = await db.insert(deviceTokensTable).values({
    userId: testUserId,
    token: VALID_EXPO_TOKEN,
    platform: "expo",
  }).returning({ id: deviceTokensTable.id });
  validTokenId = validRow.id;

  // User WITH an invalid (non-Expo) token
  const [userB] = await db.insert(appUsersTable).values({
    replitUserId: `push-delivery-invalid-${Date.now()}`,
    username: `push_invalid_${Date.now()}`,
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  noTokenUserId = userB.id;

  const [invalidRow] = await db.insert(deviceTokensTable).values({
    userId: noTokenUserId,
    token: INVALID_TOKEN,
    platform: "fcm",
  }).returning({ id: deviceTokensTable.id });
  invalidTokenId = invalidRow.id;
});

afterAll(async () => {
  await db.delete(deviceTokensTable).where(eq(deviceTokensTable.id, validTokenId));
  await db.delete(deviceTokensTable).where(eq(deviceTokensTable.id, invalidTokenId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, noTokenUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Scenario 1: No device tokens for user ─────────────────────────────────

describe("sendPushToUsers — no-token scenario", () => {
  it("returns zeroed stats when userIds list is empty", async () => {
    const result = await sendPushToUsers([], "Title", "Body");
    expect(result).toEqual({ attempted: 0, sent: 0, failed: 0, invalid: 0 });
  });

  it("returns zeroed stats and does NOT call Expo when user has no tokens", async () => {
    // Use a userId that has no device token in the DB (synthetic ID)
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await sendPushToUsers([999_999_999], "Title", "Body");
    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.invalid).toBe(0);
    const expoCalls = fetchSpy.mock.calls.filter(
      ([url]) => typeof url === "string" && (url as string).includes("exp.host"),
    );
    expect(expoCalls).toHaveLength(0);
  });
});

// ── Scenario 2: Invalid (non-Expo) token format ───────────────────────────

describe("sendPushToUsers — invalid token format", () => {
  it("counts non-Expo tokens as invalid and does NOT call Expo API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await sendPushToUsers([noTokenUserId], "Title", "Body");
    expect(result.invalid).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    const expoCalls = fetchSpy.mock.calls.filter(
      ([url]) => typeof url === "string" && (url as string).includes("exp.host"),
    );
    expect(expoCalls).toHaveLength(0);
  });
});

// ── Scenario 3: Expo API HTTP error ──────────────────────────────────────

describe("sendPushToUsers — Expo API HTTP error", () => {
  it("records failed=1 sent=0 when Expo returns a non-2xx status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 }),
    );
    const result = await sendPushToUsers([testUserId], "Title", "Body");
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.invalid).toBe(0);
  });

  it("records failed count when fetch throws a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network failure"));
    const result = await sendPushToUsers([testUserId], "Title", "Body");
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });
});

// ── Scenario 4: Expo ticket-level errors ──────────────────────────────────

describe("sendPushToUsers — ticket-level accounting", () => {
  it("records sent=1 for an ok ticket", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ status: "ok", id: "ticket-1" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await sendPushToUsers([testUserId], "Title", "Body");
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("records failed=1 for an error ticket", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ status: "error", message: "DeviceNotRegistered", details: { error: "DeviceNotRegistered" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await sendPushToUsers([testUserId], "Title", "Body");
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("counts missing tickets as failed (Expo returns fewer tickets than messages)", async () => {
    // Insert a second token temporarily so we have 2 messages but only 1 ticket in response
    const [extra] = await db.insert(deviceTokensTable).values({
      userId: testUserId,
      token: "ExponentPushToken[push-stats-extra-token]",
      platform: "expo",
    }).returning({ id: deviceTokensTable.id });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ status: "ok", id: "ticket-1" }] }), // only 1 ticket for 2 messages
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await sendPushToUsers([testUserId], "Title", "Body");
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);

    await db.delete(deviceTokensTable).where(eq(deviceTokensTable.id, extra.id));
  });
});
