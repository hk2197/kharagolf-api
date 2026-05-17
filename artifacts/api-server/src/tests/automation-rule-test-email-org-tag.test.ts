/**
 * Spot-check test (Task #1566) — verifies that the automation-rule
 * "test send" endpoint
 * (POST /api/organizations/:orgId/automation-rules/:ruleId/test) tags the
 * outgoing email with `orgId` so the Postmark bounce webhook (Task #981)
 * can attribute hard bounces back to the originating club instantly.
 *
 * Companion to `membership-renewal-reminder-org-tag.test.ts`. That test
 * locks the `comms.sendBroadcast` boundary; this one locks the direct
 * `mailer.sendBroadcastEmail` boundary, since the automation surface area
 * bypasses `sendBroadcast` and calls the mailer helper directly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

const { sendBroadcastEmailMock } = vi.hoisted(() => ({
  sendBroadcastEmailMock: vi.fn(
    async (
      _to: string,
      _recipientName: string,
      _subject: string,
      _body: string,
      _eventName: string,
      _opts?: {
        logoUrl?: string;
        primaryColor?: string;
        orgName?: string;
        orgId?: number;
        [k: string]: unknown;
      },
    ) => undefined,
  ),
}));

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendBroadcastEmail: sendBroadcastEmailMock,
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  automationRulesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let adminId: number;
let ruleId: number;

beforeAll(async () => {
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-task-1566-automation-test";

  const tag = uid("autorule-org-tag");
  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    displayName: "Auto Rule Admin",
    email: `${tag}-admin@example.com`,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: adminId,
    role: "org_admin",
  });

  const [rule] = await db.insert(automationRulesTable).values({
    orgId,
    name: `Email rule ${tag}`,
    triggerType: "manual",
    channel: "email",
    audienceFilter: { type: "all_registrants" },
    subject: "Hello {{playerName}}",
    body: "Body for {{playerName}} from {{orgName}}",
    isActive: true,
  }).returning({ id: automationRulesTable.id });
  ruleId = rule.id;
});

afterAll(async () => {
  await db.delete(automationRulesTable).where(eq(automationRulesTable.id, ruleId)).catch(() => {});
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, adminId)).catch(() => {});
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminId)).catch(() => {});
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId)).catch(() => {});
});

beforeEach(() => {
  sendBroadcastEmailMock.mockClear();
});

describe("Automation-rule test send → mailer org tag (Task #1566)", () => {
  it("calls sendBroadcastEmail with opts.orgId === org.id so the bounce webhook can attribute bounces back to the club", async () => {
    const app = createTestApp({
      id: adminId,
      username: "auto_admin",
      displayName: "Auto Rule Admin",
      role: "org_admin",
      organizationId: orgId,
    });

    const res = await request(app)
      .post(`/api/organizations/${orgId}/automation-rules/${ruleId}/test`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(1);
    const call = sendBroadcastEmailMock.mock.calls[0]!;
    const opts = call[5];
    // Task #1566 — the originating org id MUST be propagated so
    // `sendBroadcastEmail` can build `branding.orgId` →
    // `flowHints.metadata.orgId` and the Postmark bounce webhook
    // (Task #981) can attribute hard bounces back to this club instantly.
    expect(opts?.orgId).toBe(orgId);
  });
});
