/**
 * Task #2228 — lock in the email delivery counts reported by the
 * automation-rule retry endpoint
 * (POST /api/organizations/:orgId/automation-rules/:ruleId/retry).
 *
 * Background
 * ----------
 * Task #1787 pinned the **push** branch of the same retry loop so that
 * recipients whose push is classified as `"failed"` or `"no_address"`
 * cannot silently inflate `deliveredCount` in `automation_rule_logs`. The
 * sibling **email** branch in the same loop has no equivalent regression
 * coverage:
 *
 *   - It bumps `deliveredCount` on every successful `sendBroadcastEmail`
 *     call.
 *   - It bumps `failedCount` only inside the surrounding `try { … }
 *     catch { failedCount++ }` block.
 *   - Recipients with no email address fall through to the `else
 *     { failedCount++ }` branch.
 *
 * Nothing currently asserts that:
 *   1. Recipients with no email on file land in `failedCount` (NOT
 *      delivered).
 *   2. Recipients whose mailer call throws land in `failedCount` (NOT
 *      delivered).
 *   3. Only recipients whose `sendBroadcastEmail` resolves successfully
 *      bump `deliveredCount`.
 *   4. The row written to `automation_rule_logs` mirrors those counts and
 *      uses the right `status` (`"completed"` / `"partial"` / `"failed"`).
 *
 * A future refactor could quietly count "no email on file" as delivered
 * and inflate the dashboard numbers admins see. This suite pins all four
 * invariants so that regression breaks the test loudly instead of
 * silently mis-reporting delivery to club admins.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

// ── Mocks ───────────────────────────────────────────────────────────────
// Stub the mailer so we control the per-recipient outcome from the test.
// The retry endpoint calls `sendBroadcastEmail(recipient.email, …)` once
// per recipient that has an email address, and bumps `deliveredCount`
// on resolve / `failedCount` on throw. We dispatch by the recipient's
// email address so the test does not depend on the SELECT ordering of
// the players table.
const { sendBroadcastEmailMock, throwForEmails } = vi.hoisted(() => ({
  sendBroadcastEmailMock: vi.fn(async (_to: string, ..._rest: unknown[]) => undefined),
  throwForEmails: new Set<string>(),
}));

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendBroadcastEmail: sendBroadcastEmailMock,
  };
});

// The retry endpoint never touches the push fan-out for an email-channel
// rule, but stub it defensively so an accidental push regression does
// not reach Expo's servers from the test suite.
vi.mock("../lib/comms.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/comms.js")>("../lib/comms.js");
  return {
    ...actual,
    sendTransactionalPush: vi.fn(async () => ({
      attempted: 0, sent: 0, failed: 0, invalid: 0,
    })),
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
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdTournamentIds: number[] = [];
const createdRuleIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-automation-retry-email";
  }
});

beforeEach(() => {
  sendBroadcastEmailMock.mockReset();
  throwForEmails.clear();
  // Default: resolve. The per-test setup below adds specific recipient
  // emails to `throwForEmails` to simulate mailer failures.
  sendBroadcastEmailMock.mockImplementation(async (to: string) => {
    if (throwForEmails.has(to)) {
      throw new Error(`mock mailer failure for ${to}`);
    }
    return undefined;
  });
});

async function makeOrg(): Promise<number> {
  const tag = uid("autorule_retry_email_org");
  const [org] = await db.insert(organizationsTable).values({
    name: `AutoRuleRetryEmailOrg_${tag}`,
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
    displayName: "Auto Rule Email Admin",
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
    displayName: "Auto Rule Email Admin",
    role: "org_admin",
    organizationId: orgId,
  };
}

async function makeTournament(orgId: number): Promise<number> {
  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    name: `AutoRuleRetryEmail Tournament ${uid()}`,
    status: "draft",
  }).returning({ id: tournamentsTable.id });
  createdTournamentIds.push(t.id);
  return t.id;
}

async function makeEmailRule(orgId: number, tournamentId: number): Promise<number> {
  const [rule] = await db.insert(automationRulesTable).values({
    orgId,
    tournamentId,
    name: `Email retry rule ${uid()}`,
    triggerType: "manual",
    channel: "email",
    audienceFilter: { type: "all_registrants" },
    subject: "Retry subject for {{playerName}}",
    body: "Hello {{playerName}}, this is a retry email body.",
    isActive: true,
  }).returning({ id: automationRulesTable.id });
  createdRuleIds.push(rule.id);
  return rule.id;
}

/**
 * Insert a player with an explicit email address (or `null` to model
 * the "no email on file" case the retry loop's `else { failedCount++ }`
 * branch is supposed to absorb).
 */
async function makePlayer(
  tournamentId: number,
  label: string,
  email: string | null,
): Promise<{ playerId: number; email: string | null }> {
  const [p] = await db.insert(playersTable).values({
    tournamentId,
    firstName: "Player",
    lastName: label,
    email,
  }).returning({ id: playersTable.id });
  return { playerId: p.id, email };
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
  if (createdUserIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

async function readLogRow(ruleId: number) {
  const rows = await db.select().from(automationRuleLogsTable)
    .where(eq(automationRuleLogsTable.ruleId, ruleId));
  return rows[0];
}

describe("POST /api/organizations/:orgId/automation-rules/:ruleId/retry (email)", () => {
  it("status 'completed': every recipient whose mailer call resolves lands in deliveredCount", async () => {
    const orgId = await makeOrg();
    const admin = await makeAdmin(orgId, "retry_email_completed_admin");
    const tournamentId = await makeTournament(orgId);
    const ruleId = await makeEmailRule(orgId, tournamentId);

    const tag = uid("good");
    const aEmail = `${tag}-a@test.local`;
    const bEmail = `${tag}-b@test.local`;
    await makePlayer(tournamentId, "A", aEmail);
    await makePlayer(tournamentId, "B", bEmail);

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/automation-rules/${ruleId}/retry`)
      .send({})
      .expect(200);

    expect(res.body.audienceSize).toBe(2);
    expect(res.body.deliveredCount).toBe(2);
    expect(res.body.failedCount).toBe(0);

    // Mailer was invoked once per recipient with the recipient's email
    // as the first positional arg.
    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(2);
    const calledRecipients = sendBroadcastEmailMock.mock.calls.map(c => c[0]).sort();
    expect(calledRecipients).toEqual([aEmail, bEmail].sort());

    const log = await readLogRow(ruleId);
    expect(log).toBeDefined();
    expect(log!.audienceSize).toBe(2);
    expect(log!.deliveredCount).toBe(2);
    expect(log!.failedCount).toBe(0);
    expect(log!.status).toBe("completed");
  });

  it("status 'partial': recipients with no email AND recipients whose mailer throws are NOT counted as delivered", async () => {
    const orgId = await makeOrg();
    const admin = await makeAdmin(orgId, "retry_email_partial_admin");
    const tournamentId = await makeTournament(orgId);
    const ruleId = await makeEmailRule(orgId, tournamentId);

    const tag = uid("mix");
    const goodEmail = `${tag}-good@test.local`;
    const throwingEmail = `${tag}-throws@test.local`;

    // 1) `goodEmail` — mailer resolves → must land in deliveredCount.
    await makePlayer(tournamentId, "good", goodEmail);
    // 2) `throwingEmail` — mailer throws → must land in failedCount via
    //    the surrounding try/catch.
    await makePlayer(tournamentId, "throws", throwingEmail);
    throwForEmails.add(throwingEmail);
    // 3) No email on file — must land in failedCount via the
    //    `else { failedCount++ }` fall-through. This is the regression
    //    Task #2228 specifically guards against: a future refactor
    //    could silently flip "no email on file" into deliveredCount and
    //    inflate the dashboard numbers admins see.
    await makePlayer(tournamentId, "noemail", null);

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/automation-rules/${ruleId}/retry`)
      .send({})
      .expect(200);

    expect(res.body.audienceSize).toBe(3);
    expect(res.body.deliveredCount).toBe(1);
    expect(res.body.failedCount).toBe(2);

    // Mailer is only invoked for recipients with an email address — the
    // "no email on file" recipient never reaches the mailer because it
    // is short-circuited by the `else` branch before the call is made.
    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(2);
    const calledRecipients = sendBroadcastEmailMock.mock.calls.map(c => c[0]).sort();
    expect(calledRecipients).toEqual([goodEmail, throwingEmail].sort());

    const log = await readLogRow(ruleId);
    expect(log).toBeDefined();
    expect(log!.audienceSize).toBe(3);
    expect(log!.deliveredCount).toBe(1);
    expect(log!.failedCount).toBe(2);
    expect(log!.status).toBe("partial");
  });

  it("status 'failed': every recipient (no-email + throwing-mailer) lands in failedCount and deliveredCount stays at 0", async () => {
    const orgId = await makeOrg();
    const admin = await makeAdmin(orgId, "retry_email_failed_admin");
    const tournamentId = await makeTournament(orgId);
    const ruleId = await makeEmailRule(orgId, tournamentId);

    const tag = uid("badonly");
    const throwingEmail = `${tag}-throws@test.local`;

    await makePlayer(tournamentId, "throws", throwingEmail);
    throwForEmails.add(throwingEmail);
    await makePlayer(tournamentId, "noemail", null);

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/automation-rules/${ruleId}/retry`)
      .send({})
      .expect(200);

    expect(res.body.audienceSize).toBe(2);
    expect(res.body.deliveredCount).toBe(0);
    expect(res.body.failedCount).toBe(2);

    // Only the recipient with an email triggers a mailer call (which
    // throws). The "no email on file" recipient is short-circuited.
    expect(sendBroadcastEmailMock).toHaveBeenCalledTimes(1);
    expect(sendBroadcastEmailMock.mock.calls[0]![0]).toBe(throwingEmail);

    const log = await readLogRow(ruleId);
    expect(log).toBeDefined();
    expect(log!.audienceSize).toBe(2);
    expect(log!.deliveredCount).toBe(0);
    expect(log!.failedCount).toBe(2);
    expect(log!.status).toBe("failed");
  });
});
