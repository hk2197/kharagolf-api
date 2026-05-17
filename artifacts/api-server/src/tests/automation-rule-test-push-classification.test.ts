/**
 * Task #1463 — lock in the push delivery classification reported by the
 * admin "test-send" automation-rule endpoint
 * (POST /api/organizations/:orgId/automation-rules/:ruleId/test).
 *
 * Background
 * ----------
 * Task #1240 changed the push branch of this endpoint so it returns a real
 * `classification` ("sent" / "failed" / "no_address") and HTTP 422 instead
 * of 200 whenever delivery was not "sent". Before that change, the route
 * unconditionally responded with `{ ok: true }` even when nothing had
 * actually been delivered (e.g. the admin had no Expo token registered),
 * which masked real outages of the push pipeline (Task #1070 surface).
 *
 * This suite pins the fixed behaviour so a future refactor cannot silently
 * revert it:
 *   - When the admin has no registered devices the endpoint responds with
 *     HTTP 422 and `classification: "no_address"`.
 *   - When the push provider rejects the test message the endpoint
 *     responds with HTTP 422 and `classification: "failed"`.
 *   - When delivery actually succeeds the endpoint responds with HTTP 200,
 *     `ok: true`, and `classification: "sent"`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

// ── Mocks ───────────────────────────────────────────────────────────────
// Stub the push fan-out so we control its outcome per case. The route
// imports `sendTransactionalPush` from `../lib/comms` and pipes the result
// through `classifyPushDelivery` from `../lib/push`; we keep the real
// classifier so its decision rule (sent > failed > no_address) is
// exercised end-to-end rather than re-implemented in the mock.
const { sendTransactionalPushMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(async () => ({
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

// Email path is not under test here, but the test-send route calls it for
// `email` channel rules so we stub it to avoid touching real SMTP.
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
  deviceTokensTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdRuleIds: number[] = [];
const createdTokenIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-for-automation-test-push";
});

async function makeOrg(): Promise<number> {
  const tag = uid("autorule_org");
  const [org] = await db.insert(organizationsTable).values({
    name: `AutoRuleOrg_${tag}`,
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

async function makePushRule(orgId: number): Promise<number> {
  const [rule] = await db.insert(automationRulesTable).values({
    orgId,
    name: `Push test rule ${uid()}`,
    triggerType: "manual",
    channel: "push",
    audienceFilter: { type: "all_registrants" },
    subject: "Test subject",
    body: "Hello {{playerName}}, this is a test push body.",
    isActive: true,
  }).returning({ id: automationRulesTable.id });
  createdRuleIds.push(rule.id);
  return rule.id;
}

async function giveDeviceToken(userId: number) {
  const [row] = await db.insert(deviceTokensTable).values({
    userId,
    token: `ExponentPushToken[autorule-${uid("tok")}]`,
    platform: "expo",
  }).returning({ id: deviceTokensTable.id });
  createdTokenIds.push(row.id);
}

afterAll(async () => {
  if (createdRuleIds.length) {
    await db.delete(automationRuleLogsTable).where(inArray(automationRuleLogsTable.ruleId, createdRuleIds));
    await db.delete(automationRulesTable).where(inArray(automationRulesTable.id, createdRuleIds));
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

describe("POST /api/organizations/:orgId/automation-rules/:ruleId/test (push)", () => {
  it("returns HTTP 422 + classification:'no_address' when the admin has no registered devices", async () => {
    const orgId = await makeOrg();
    const admin = await makeAdmin(orgId, "noaddr_admin");
    const ruleId = await makePushRule(orgId);

    // The route delegates to `sendTransactionalPush`, which under the
    // hood inspects device_tokens. We model the no-address outcome
    // directly so the test stays oblivious to the helper's internals
    // (an unrelated change to the helper must not flip this case to
    // "failed" without us noticing).
    sendTransactionalPushMock.mockResolvedValueOnce({
      attempted: 0, sent: 0, failed: 0, invalid: 0,
    });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/automation-rules/${ruleId}/test`)
      .send({})
      .expect(422);

    expect(res.body.classification).toBe("no_address");
    // The admin-facing message must steer the operator to register a
    // device rather than implying the push provider is broken.
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error).toMatch(/register|device/i);
  });

  it("returns HTTP 422 + classification:'failed' when the push provider rejects the test", async () => {
    const orgId = await makeOrg();
    const admin = await makeAdmin(orgId, "failed_admin");
    const ruleId = await makePushRule(orgId);
    await giveDeviceToken(admin.id);

    sendTransactionalPushMock.mockResolvedValueOnce({
      attempted: 1, sent: 0, failed: 1, invalid: 0,
    });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/automation-rules/${ruleId}/test`)
      .send({})
      .expect(422);

    expect(res.body.classification).toBe("failed");
    expect(typeof res.body.error).toBe("string");
  });

  it("returns HTTP 200 + classification:'sent' when delivery succeeds", async () => {
    const orgId = await makeOrg();
    const admin = await makeAdmin(orgId, "sent_admin");
    const ruleId = await makePushRule(orgId);
    await giveDeviceToken(admin.id);

    sendTransactionalPushMock.mockResolvedValueOnce({
      attempted: 1, sent: 1, failed: 0, invalid: 0,
    });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/automation-rules/${ruleId}/test`)
      .send({})
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.classification).toBe("sent");
    expect(res.body.sentTo).toBe("push notification");
  });
});
