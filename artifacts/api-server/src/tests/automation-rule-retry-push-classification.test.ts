/**
 * Task #1787 — lock in the push delivery classification reported by the
 * automation-rule retry endpoint
 * (POST /api/organizations/:orgId/automation-rules/:ruleId/retry).
 *
 * Background
 * ----------
 * Task #1240 changed the test-send endpoint so it pipes the push fan-out
 * result through `classifyPushDelivery` and only counts a recipient as
 * delivered when the classification is `"sent"`. Task #1463 pinned that
 * behaviour for the test-send endpoint. The sibling retry endpoint applies
 * the same classifier per recipient to compute the `deliveredCount` and
 * `failedCount` written into `automation_rule_logs` (the row admins see
 * in the dashboard), but had no regression coverage — a future refactor
 * could silently flip a `failed` or `no_address` result back into
 * `deliveredCount` and inflate the dashboard numbers without breaking any
 * test.
 *
 * This suite pins the retry endpoint's bookkeeping so that:
 *   - Recipients whose push is classified as `"sent"`  → counted in
 *     `deliveredCount`.
 *   - Recipients whose push is classified as `"failed"` or `"no_address"`
 *     → counted in `failedCount`.
 *   - The row written to `automation_rule_logs` reflects those counts
 *     and carries `status` `"completed"` (all delivered),
 *     `"partial"` (some failed, some delivered) or `"failed"`
 *     (all failed) accordingly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

// ── Mocks ───────────────────────────────────────────────────────────────
// Stub the push fan-out so we control the per-recipient outcome from the
// test. The retry endpoint calls `sendTransactionalPush([recipient.userId], ...)`
// once per recipient and pipes the result through the real
// `classifyPushDelivery`, so the mock decides which classification each
// recipient ends up with. We dispatch by userId rather than relying on
// invocation order so the test does not depend on the SELECT ordering of
// the players table.
const { sendTransactionalPushMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(async (_userIds: number[]) => ({
    attempted: 1, sent: 1, failed: 0, invalid: 0,
  })),
}));

vi.mock("../lib/comms.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/comms.js")>("../lib/comms.js");
  return {
    ...actual,
    sendTransactionalPush: sendTransactionalPushMock,
  };
});

// The retry endpoint never touches the mailer for a push-channel rule,
// but stub it defensively so an accidental email-channel regression does
// not reach real SMTP from the test suite.
vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendBroadcastEmail: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  automationRulesTable,
  automationRuleLogsTable,
  tournamentsTable,
  playersTable,
  deviceTokensTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdTournamentIds: number[] = [];
const createdRuleIds: number[] = [];
const createdTokenIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-automation-retry-push";
  }
});

beforeEach(() => {
  sendTransactionalPushMock.mockReset();
  // Default to `"sent"` so any recipient we forget to wire up explicitly
  // fails the test loudly (delivered count would be wrong rather than
  // silently classified as failed).
  sendTransactionalPushMock.mockResolvedValue({
    attempted: 1, sent: 1, failed: 0, invalid: 0,
  });
});

async function makeOrg(): Promise<number> {
  const tag = uid("autorule_retry_org");
  const [org] = await db.insert(organizationsTable).values({
    name: `AutoRuleRetryOrg_${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeAdmin(orgId: number, label: string): Promise<TestUser> {
  const tag = uid(label);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: "Auto Rule Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: u.id,
    role: "org_admin",
  });
  return {
    id: u.id,
    username: tag,
    displayName: "Auto Rule Admin",
    role: "org_admin",
    organizationId: orgId,
  };
}

async function makeTournament(orgId: number): Promise<number> {
  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    name: `AutoRuleRetry Tournament ${uid()}`,
    status: "draft",
  }).returning({ id: tournamentsTable.id });
  createdTournamentIds.push(t.id);
  return t.id;
}

async function makePushRule(orgId: number, tournamentId: number): Promise<number> {
  const [rule] = await db.insert(automationRulesTable).values({
    orgId,
    tournamentId,
    name: `Push retry rule ${uid()}`,
    triggerType: "manual",
    channel: "push",
    audienceFilter: { type: "all_registrants" },
    subject: "Retry subject",
    body: "Hello {{playerName}}, this is a retry push body.",
    isActive: true,
  }).returning({ id: automationRulesTable.id });
  createdRuleIds.push(rule.id);
  return rule.id;
}

async function makePlayer(tournamentId: number, label: string): Promise<{ playerId: number; userId: number }> {
  const tag = uid(label);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: `Player ${label}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);

  // Register a device token so the underlying helper would, if not mocked,
  // actually have something to deliver to. The mock intercepts the call,
  // so this is mainly to mirror the production shape — the classifier's
  // decision is what we are actually exercising.
  const [tok] = await db.insert(deviceTokensTable).values({
    userId: u.id,
    token: `ExponentPushToken[autorule-retry-${tag}]`,
    platform: "expo",
  }).returning({ id: deviceTokensTable.id });
  createdTokenIds.push(tok.id);

  const [p] = await db.insert(playersTable).values({
    tournamentId,
    userId: u.id,
    firstName: "Player",
    lastName: label,
    email: `${tag}@test.local`,
  }).returning({ id: playersTable.id });
  return { playerId: p.id, userId: u.id };
}

afterAll(async () => {
  if (createdRuleIds.length) {
    await db.delete(automationRuleLogsTable).where(inArray(automationRuleLogsTable.ruleId, createdRuleIds));
    await db.delete(automationRulesTable).where(inArray(automationRulesTable.id, createdRuleIds));
  }
  if (createdTournamentIds.length) {
    await db.delete(playersTable).where(inArray(playersTable.tournamentId, createdTournamentIds));
    await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, createdTournamentIds));
  }
  if (createdTokenIds.length) {
    await db.delete(deviceTokensTable).where(inArray(deviceTokensTable.id, createdTokenIds));
  }
  if (createdUserIds.length) {
    await db.delete(deviceTokensTable).where(inArray(deviceTokensTable.userId, createdUserIds));
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

/**
 * Wire the push mock so that each recipient's userId resolves to a
 * pre-determined raw `PushDeliveryResult`. Anything not in the map falls
 * through to the default in `beforeEach` (which would force a test
 * failure by classifying as `"sent"` unintentionally).
 */
function mockPerUser(map: Record<number, { sent: number; failed: number; invalid?: number }>) {
  sendTransactionalPushMock.mockImplementation(async (userIds: number[]) => {
    const targetUserId = userIds[0]!;
    const r = map[targetUserId];
    if (!r) {
      return { attempted: 1, sent: 1, failed: 0, invalid: 0 };
    }
    return {
      attempted: 1,
      sent: r.sent,
      failed: r.failed,
      invalid: r.invalid ?? 0,
    };
  });
}

async function readLogRow(ruleId: number) {
  const rows = await db.select().from(automationRuleLogsTable)
    .where(eq(automationRuleLogsTable.ruleId, ruleId));
  return rows[0];
}

describe("POST /api/organizations/:orgId/automation-rules/:ruleId/retry (push)", () => {
  it("status 'completed': every recipient classified as 'sent' lands in deliveredCount", async () => {
    const orgId = await makeOrg();
    const admin = await makeAdmin(orgId, "retry_completed_admin");
    const tournamentId = await makeTournament(orgId);
    const ruleId = await makePushRule(orgId, tournamentId);
    const a = await makePlayer(tournamentId, "A");
    const b = await makePlayer(tournamentId, "B");

    mockPerUser({
      [a.userId]: { sent: 1, failed: 0 },
      [b.userId]: { sent: 1, failed: 0 },
    });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/automation-rules/${ruleId}/retry`)
      .send({})
      .expect(200);

    expect(res.body.audienceSize).toBe(2);
    expect(res.body.deliveredCount).toBe(2);
    expect(res.body.failedCount).toBe(0);

    const log = await readLogRow(ruleId);
    expect(log).toBeDefined();
    expect(log!.audienceSize).toBe(2);
    expect(log!.deliveredCount).toBe(2);
    expect(log!.failedCount).toBe(0);
    expect(log!.status).toBe("completed");
  });

  it("status 'partial': mixed classifications split deliveredCount vs failedCount and the 'no_address' result is NOT counted as delivered", async () => {
    const orgId = await makeOrg();
    const admin = await makeAdmin(orgId, "retry_partial_admin");
    const tournamentId = await makeTournament(orgId);
    const ruleId = await makePushRule(orgId, tournamentId);
    const sentPlayer = await makePlayer(tournamentId, "sent");
    const failedPlayer = await makePlayer(tournamentId, "failed");
    // `no_address` is the regression we are guarding against: a recipient
    // whose underlying fan-out returned `attempted=1, sent=0, failed=0`
    // (e.g. their only registered token was non-Expo / invalid). Before
    // Task #1240 wired in `classifyPushDelivery`, this case could be
    // mis-counted as delivered.
    const noAddressPlayer = await makePlayer(tournamentId, "noaddr");

    mockPerUser({
      [sentPlayer.userId]:      { sent: 1, failed: 0 },
      [failedPlayer.userId]:    { sent: 0, failed: 1 },
      [noAddressPlayer.userId]: { sent: 0, failed: 0, invalid: 1 },
    });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/automation-rules/${ruleId}/retry`)
      .send({})
      .expect(200);

    expect(res.body.audienceSize).toBe(3);
    // Only the `"sent"` recipient bumps deliveredCount. Both the
    // `"failed"` and `"no_address"` recipients land in failedCount —
    // this is the invariant a future refactor must not silently break.
    expect(res.body.deliveredCount).toBe(1);
    expect(res.body.failedCount).toBe(2);

    const log = await readLogRow(ruleId);
    expect(log).toBeDefined();
    expect(log!.audienceSize).toBe(3);
    expect(log!.deliveredCount).toBe(1);
    expect(log!.failedCount).toBe(2);
    expect(log!.status).toBe("partial");
  });

  it("status 'failed': every recipient classified as 'failed' or 'no_address' lands in failedCount", async () => {
    const orgId = await makeOrg();
    const admin = await makeAdmin(orgId, "retry_failed_admin");
    const tournamentId = await makeTournament(orgId);
    const ruleId = await makePushRule(orgId, tournamentId);
    const failedPlayer = await makePlayer(tournamentId, "all_failed");
    const noAddressPlayer = await makePlayer(tournamentId, "all_noaddr");

    mockPerUser({
      [failedPlayer.userId]:    { sent: 0, failed: 1 },
      [noAddressPlayer.userId]: { sent: 0, failed: 0, invalid: 1 },
    });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/automation-rules/${ruleId}/retry`)
      .send({})
      .expect(200);

    expect(res.body.audienceSize).toBe(2);
    expect(res.body.deliveredCount).toBe(0);
    expect(res.body.failedCount).toBe(2);

    const log = await readLogRow(ruleId);
    expect(log).toBeDefined();
    expect(log!.audienceSize).toBe(2);
    expect(log!.deliveredCount).toBe(0);
    expect(log!.failedCount).toBe(2);
    expect(log!.status).toBe("failed");
  });
});
