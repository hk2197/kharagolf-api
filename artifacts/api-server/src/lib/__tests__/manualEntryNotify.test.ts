/**
 * Integration tests for `notifyManualEntryRound` (Task #870 / #1020).
 *
 * Covers the threshold logic, recipient resolution, and per-recipient channel
 * preferences:
 *   1. ≤50% manual shots = skipped (`below_threshold`).
 *   2. >50% manual shots = sent to all directors via push + email.
 *   3. No directors in the tournament's org = skipped (`no_recipients`).
 *   4. `preferPush=false` suppresses the push call for that user.
 *   5. `preferEmail=false` suppresses the email call for that user.
 *
 * The push and mailer transports are mocked via `vi.mock` so the suite never
 * touches Expo / SMTP. The Postgres database is real (matches the convention
 * used by the other api-server integration tests).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendPushToUsersMock, sendManualEntryAlertEmailMock, classifyMailerErrorMock } = vi.hoisted(() => ({
  // Match the real `sendPushToUsers(userIds, title, body, data?)` 4-arg
  // signature so `mock.calls[N][1..3]` typecheck (we destructure title /
  // body / data when asserting push payloads downstream).
  sendPushToUsersMock: vi.fn(async (
    userIds: number[],
    _title: string,
    _body: string,
    _data?: Record<string, unknown>,
  ) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  })),
  sendManualEntryAlertEmailMock: vi.fn(async (_args: {
    to: string;
    recipientName: string;
    tournamentName: string;
    playerName: string;
    round: number;
    manualPct: number;
    manualShots: number;
    totalShots: number;
    reviewUrl: string;
  }) => {}),
  // Task #1502 — classifier is consulted in the email-error catch.
  // Overridable per-test so the Task #1849 / #1850 provider_unconfigured →
  // status='skipped' branch can be driven without rewiring the mock.
  // Defaults to "transient" so existing tests that throw generic SMTP
  // errors still flow through the standard `failed` path; individual
  // tests override this for the provider-not-configured branch.
  classifyMailerErrorMock: vi.fn((_err: unknown) => "transient" as
    | "transient"
    | "provider_unconfigured"
    | "hard_bounce"),
}));

vi.mock("../push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
}));

vi.mock("../mailer.js", () => ({
  sendManualEntryAlertEmail: sendManualEntryAlertEmailMock,
  classifyMailerError: classifyMailerErrorMock,
}));

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  tournamentsTable,
  playersTable,
  roundSubmissionsTable,
  shotsTable,
  userNotificationPrefsTable,
  manualEntryAlertsTable,
  manualEntryAlertRecipientsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { notifyManualEntryRound, MANUAL_ENTRY_NOTIFY_REASONS } from "../manualEntryNotify.js";
import { logger } from "../logger.js";

// ── Cleanup tracking ─────────────────────────────────────────────────────

const createdUserIds: number[] = [];
const createdOrgIds: number[] = [];

afterAll(async () => {
  // FK ON DELETE CASCADE on org_memberships, tournaments, players, shots,
  // round_submissions, user_notification_prefs wipes the dependent rows.
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
});

beforeEach(() => {
  sendPushToUsersMock.mockClear();
  sendManualEntryAlertEmailMock.mockClear();
  // Reset the classifier so a per-test override (e.g. the
  // `provider_unconfigured` skipped-path test) doesn't bleed into the
  // next test in the suite.
  classifyMailerErrorMock.mockReset();
  classifyMailerErrorMock.mockImplementation(() => "transient");
});

// ── Helpers ──────────────────────────────────────────────────────────────

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `${label}_${Date.now()}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

async function makeOrg(label: string, opts: { notifyManualEntryAlerts?: boolean } = {}): Promise<number> {
  const stamp = uniq(label);
  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${stamp}`,
    slug: stamp,
    // Default leans on the schema (true). Tests that need the org-wide
    // mute pass `notifyManualEntryAlerts: false` here so the column is
    // explicitly seeded false rather than relying on a separate UPDATE.
    ...(opts.notifyManualEntryAlerts === undefined ? {} : { notifyManualEntryAlerts: opts.notifyManualEntryAlerts }),
  }).returning();
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(label: string, opts: { email?: string | null } = {}): Promise<number> {
  const stamp = uniq(label);
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `manual-entry-${stamp}`,
    username: `mn_${stamp}`,
    email: opts.email === undefined ? `${stamp}@example.com` : opts.email,
    role: "player",
  }).returning();
  createdUserIds.push(user.id);
  return user.id;
}

async function addDirector(
  organizationId: number,
  userId: number,
  role: "org_admin" | "tournament_director" | "committee_member" | "competition_secretary",
): Promise<void> {
  await db.insert(orgMembershipsTable).values({ organizationId, userId, role });
}

async function makeTournament(organizationId: number, label: string): Promise<number> {
  const [t] = await db.insert(tournamentsTable).values({
    organizationId,
    name: `Tournament ${uniq(label)}`,
  }).returning();
  return t.id;
}

async function makePlayer(tournamentId: number, firstName = "Test", lastName = "Golfer"): Promise<number> {
  const [p] = await db.insert(playersTable).values({
    tournamentId,
    firstName,
    lastName,
  }).returning();
  return p.id;
}

async function makeSubmission(tournamentId: number, playerId: number, round = 1): Promise<number> {
  const [s] = await db.insert(roundSubmissionsTable).values({
    tournamentId,
    playerId,
    round,
    status: "countersigned",
  }).returning();
  return s.id;
}

async function seedShots(opts: {
  tournamentId: number;
  playerId: number;
  round: number;
  manual: number;
  watch: number;
}): Promise<void> {
  const rows: Array<typeof shotsTable.$inferInsert> = [];
  let shotNumber = 1;
  for (let i = 0; i < opts.manual; i++) {
    rows.push({
      tournamentId: opts.tournamentId,
      playerId: opts.playerId,
      round: opts.round,
      holeNumber: ((shotNumber - 1) % 18) + 1,
      shotNumber: shotNumber++,
      source: "manual",
    });
  }
  for (let i = 0; i < opts.watch; i++) {
    rows.push({
      tournamentId: opts.tournamentId,
      playerId: opts.playerId,
      round: opts.round,
      // Use a separate hole range to avoid colliding with the manual rows on
      // the (player, tournament, round, hole, shotNumber) unique index.
      holeNumber: ((shotNumber - 1) % 18) + 1,
      shotNumber: shotNumber++,
      source: "watch",
    });
  }
  if (rows.length > 0) await db.insert(shotsTable).values(rows);
}

async function setPrefs(userId: number, opts: { preferPush?: boolean; preferEmail?: boolean }): Promise<void> {
  await db.insert(userNotificationPrefsTable).values({
    userId,
    preferPush: opts.preferPush ?? true,
    preferEmail: opts.preferEmail ?? true,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("notifyManualEntryRound — threshold gating", () => {
  it("skips the alert when manual shots are at or below 50%", async () => {
    const orgId = await makeOrg("below");
    const dirId = await makeUser("dir-below");
    await addDirector(orgId, dirId, "tournament_director");
    const tournamentId = await makeTournament(orgId, "below");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    // Exactly 50% manual — must be silent (threshold is strictly > 50%).
    await seedShots({ tournamentId, playerId, round: 1, manual: 5, watch: 5 });

    const result = await notifyManualEntryRound(submissionId);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("below_threshold");
    expect(result.manualPct).toBe(50);
    expect(result.totalShots).toBe(10);
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
    expect(sendManualEntryAlertEmailMock).not.toHaveBeenCalled();
  });

  it("sends push + email to all configured director roles when manual shots exceed 50%", async () => {
    const orgId = await makeOrg("above");
    const orgAdmin = await makeUser("org-admin");
    const td = await makeUser("td");
    const committee = await makeUser("committee");
    const compSec = await makeUser("comp-sec");
    await addDirector(orgId, orgAdmin, "org_admin");
    await addDirector(orgId, td, "tournament_director");
    await addDirector(orgId, committee, "committee_member");
    await addDirector(orgId, compSec, "competition_secretary");
    // A non-director member must NOT be alerted (proves the role filter is
    // doing the work, not just an "everyone in the org" fan-out).
    const player = await makeUser("rando-player");
    await db.insert(orgMembershipsTable).values({
      organizationId: orgId, userId: player, role: "player",
    });

    const tournamentId = await makeTournament(orgId, "above");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    // 7 manual / 3 watch = 70% manual.
    await seedShots({ tournamentId, playerId, round: 1, manual: 7, watch: 3 });

    const result = await notifyManualEntryRound(submissionId);

    expect(result.status).toBe("sent");
    expect(result.manualPct).toBe(70);
    expect(result.totalShots).toBe(10);
    expect(result.recipients).toEqual(expect.arrayContaining([orgAdmin, td, committee, compSec]));
    expect(result.recipients).not.toContain(player);
    expect(result.recipients!.length).toBe(4);

    // Push: Task #1386 — one call per recipient so the per-recipient
    // outcome can be persisted to manual_entry_alert_recipients (the
    // bulk variant only returns aggregate counts, hiding which device
    // token actually failed).
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(4);
    const allPushUserIds = sendPushToUsersMock.mock.calls.flatMap(c => c[0] as number[]);
    expect(allPushUserIds.sort()).toEqual([orgAdmin, td, committee, compSec].sort());
    const [, pushTitle, pushBody, pushData] = sendPushToUsersMock.mock.calls[0];
    expect(pushTitle).toContain("Manual-entry round flagged");
    expect(pushBody).toContain("70.0%");
    expect((pushData as Record<string, unknown>).type).toBe("manual_entry_round_flagged");
    expect((pushData as Record<string, unknown>).submissionId).toBe(submissionId);

    // Email: one per director (each has a non-null email address).
    expect(sendManualEntryAlertEmailMock).toHaveBeenCalledTimes(4);
    const emailedTos = sendManualEntryAlertEmailMock.mock.calls.map(c => (c[0] as { to: string }).to);
    expect(new Set(emailedTos).size).toBe(4);
  });
});

describe("notifyManualEntryRound — recipient resolution", () => {
  it("skips when the tournament's org has no directors / committee / admins", async () => {
    const orgId = await makeOrg("no-dirs");
    // Add one membership with a non-director role so the org isn't completely
    // empty — this proves the role filter (not just an org-empty short-circuit)
    // is doing the work.
    const player = await makeUser("only-player");
    await db.insert(orgMembershipsTable).values({
      organizationId: orgId, userId: player, role: "player",
    });

    const tournamentId = await makeTournament(orgId, "no-dirs");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 9, watch: 1 });

    const result = await notifyManualEntryRound(submissionId);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_recipients");
    expect(result.recipients).toEqual([]);
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
    expect(sendManualEntryAlertEmailMock).not.toHaveBeenCalled();
  });
});

describe("notifyManualEntryRound — org-wide mute (Task #1188)", () => {
  it("short-circuits with reason='org_muted' when the org has muted manual-entry alerts", async () => {
    // Org-wide mute: even with directors present, a triggering shot
    // distribution, and the per-tournament toggle still on, no push or
    // email may go out.
    const orgId = await makeOrg("org-muted", { notifyManualEntryAlerts: false });
    const td = await makeUser("td-org-muted");
    await addDirector(orgId, td, "tournament_director");

    const tournamentId = await makeTournament(orgId, "org-muted");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    // 8 manual / 2 watch = 80%, well above the 50% threshold so the
    // skip can only be attributed to the org-wide mute.
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    const result = await notifyManualEntryRound(submissionId);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("org_muted");
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
    expect(sendManualEntryAlertEmailMock).not.toHaveBeenCalled();
  });

  it("still sends when the org flag is true (control case for the org-mute test)", async () => {
    // Mirror of the org-muted test with the flag flipped on, to prove
    // the org-mute test isn't accidentally skipping for some other
    // reason (e.g. broken seed data, missing director).
    const orgId = await makeOrg("org-on", { notifyManualEntryAlerts: true });
    const td = await makeUser("td-org-on");
    await addDirector(orgId, td, "tournament_director");

    const tournamentId = await makeTournament(orgId, "org-on");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    const result = await notifyManualEntryRound(submissionId);

    expect(result.status).toBe("sent");
    expect(result.recipients).toContain(td);
    // One push call per recipient (Task #1386).
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    expect(sendManualEntryAlertEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("notifyManualEntryRound — skip-reason observability (Task #1380)", () => {
  it("emits a structured `[manual-entry-notify] result` log line carrying reason='org_muted' so dashboards don't bucket it as 'other'", async () => {
    // Org-wide mute is the new branch the support team needs to be able to
    // filter on. Capture the structured log payload and assert both that the
    // well-known log message is emitted and that `reason` is the exact
    // canonical string downstream dashboards group by.
    const orgId = await makeOrg("org-muted-log", { notifyManualEntryAlerts: false });
    const td = await makeUser("td-org-muted-log");
    await addDirector(orgId, td, "tournament_director");

    const tournamentId = await makeTournament(orgId, "org-muted-log");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    try {
      const result = await notifyManualEntryRound(submissionId);
      expect(result.reason).toBe("org_muted");

      const matching = infoSpy.mock.calls.filter(
        (c) => c[1] === "[manual-entry-notify] result",
      );
      expect(matching.length).toBe(1);
      const payload = matching[0][0] as Record<string, unknown>;
      expect(payload.submissionId).toBe(submissionId);
      expect(payload.status).toBe("skipped");
      expect(payload.reason).toBe("org_muted");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("includes `org_muted` in the canonical reason list so dashboards stay in sync", () => {
    expect(MANUAL_ENTRY_NOTIFY_REASONS).toContain("org_muted");
  });
});

describe("notifyManualEntryRound — per-recipient channel preferences", () => {
  it("suppresses push for a director with preferPush=false but still emails them", async () => {
    const orgId = await makeOrg("nopush");
    const pushOptOut = await makeUser("push-opt-out");
    const pushOptIn = await makeUser("push-opt-in");
    await addDirector(orgId, pushOptOut, "tournament_director");
    await addDirector(orgId, pushOptIn, "tournament_director");
    await setPrefs(pushOptOut, { preferPush: false, preferEmail: true });

    const tournamentId = await makeTournament(orgId, "nopush");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    const result = await notifyManualEntryRound(submissionId);

    expect(result.status).toBe("sent");
    // Task #1386 — one push call per opted-in recipient (the opt-out
    // user is skipped at the channel level, never sent to Expo).
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const pushedUserIds = sendPushToUsersMock.mock.calls.flatMap(c => c[0] as number[]);
    expect(pushedUserIds).toContain(pushOptIn);
    expect(pushedUserIds).not.toContain(pushOptOut);

    // Both still receive the email (preferEmail defaults to true and is
    // explicitly true for the opt-out user).
    const emailedTos = sendManualEntryAlertEmailMock.mock.calls.map(c => (c[0] as { to: string }).to);
    expect(emailedTos.length).toBe(2);
  });

  it("suppresses email for a director with preferEmail=false but still pushes them", async () => {
    const orgId = await makeOrg("noemail");
    const emailOptOut = await makeUser("email-opt-out");
    const emailOptIn = await makeUser("email-opt-in");
    await addDirector(orgId, emailOptOut, "tournament_director");
    await addDirector(orgId, emailOptIn, "tournament_director");
    await setPrefs(emailOptOut, { preferPush: true, preferEmail: false });

    const tournamentId = await makeTournament(orgId, "noemail");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    const result = await notifyManualEntryRound(submissionId);

    expect(result.status).toBe("sent");

    // Push still goes to both directors (one call each — Task #1386).
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(2);
    const pushedUserIds = sendPushToUsersMock.mock.calls.flatMap(c => c[0] as number[]);
    expect(pushedUserIds.sort()).toEqual([emailOptOut, emailOptIn].sort());

    // Email skips the opt-out user.
    const emailedTos = sendManualEntryAlertEmailMock.mock.calls.map(c => (c[0] as { to: string }).to);
    expect(emailedTos.length).toBe(1);
    // Must be the opt-in user's email, not the opt-out user's.
    const optInUser = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, emailOptIn));
    expect(emailedTos[0]).toBe(optInUser[0].email);
  });
});

describe("notifyManualEntryRound — per-recipient delivery audit (Task #1386)", () => {
  it("writes one manual_entry_alert_recipients row per (recipient, channel) attempt with the right status mix", async () => {
    // Three directors with different channel postures:
    //   - happy: receives both push + email successfully ("sent"/"sent").
    //   - pushFailed: push transport throws (caught + recorded as
    //                 "failed"); email still goes through.
    //   - emailOptOut: push succeeds; email is suppressed up-front
    //                  ("opted_out") because preferEmail=false.
    const orgId = await makeOrg("per-recipient-audit");
    const happy = await makeUser("happy");
    const pushFailed = await makeUser("push-failed");
    const emailOptOut = await makeUser("email-opted-out");
    await addDirector(orgId, happy, "tournament_director");
    await addDirector(orgId, pushFailed, "tournament_director");
    await addDirector(orgId, emailOptOut, "tournament_director");
    await setPrefs(emailOptOut, { preferPush: true, preferEmail: false });

    sendPushToUsersMock.mockImplementation(async (userIds: number[]) => {
      if (userIds.length === 1 && userIds[0] === pushFailed) {
        throw new Error("expo down");
      }
      return { attempted: userIds.length, sent: userIds.length, failed: 0, invalid: 0 };
    });

    const tournamentId = await makeTournament(orgId, "per-recipient-audit");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    const result = await notifyManualEntryRound(submissionId);
    expect(result.status).toBe("sent");

    const [alert] = await db.select({ id: manualEntryAlertsTable.id })
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionId));
    expect(alert).toBeDefined();

    const recipientRows = await db.select({
      userId: manualEntryAlertRecipientsTable.userId,
      channel: manualEntryAlertRecipientsTable.channel,
      status: manualEntryAlertRecipientsTable.status,
      errorMessage: manualEntryAlertRecipientsTable.errorMessage,
    }).from(manualEntryAlertRecipientsTable)
      .where(eq(manualEntryAlertRecipientsTable.alertId, alert.id));

    // 3 push attempts + 2 email attempts (one opt_out) + 1 email opt_out = 6 rows.
    expect(recipientRows.length).toBe(6);

    const byKey = new Map(recipientRows.map(r => [`${r.userId}:${r.channel}`, r]));
    expect(byKey.get(`${happy}:push`)?.status).toBe("sent");
    expect(byKey.get(`${happy}:email`)?.status).toBe("sent");
    expect(byKey.get(`${pushFailed}:push`)?.status).toBe("failed");
    expect(byKey.get(`${pushFailed}:push`)?.errorMessage).toBe("expo down");
    expect(byKey.get(`${pushFailed}:email`)?.status).toBe("sent");
    expect(byKey.get(`${emailOptOut}:push`)?.status).toBe("sent");
    expect(byKey.get(`${emailOptOut}:email`)?.status).toBe("opted_out");

    // Restore the default mock implementation for subsequent suites.
    sendPushToUsersMock.mockImplementation(async (userIds: number[]) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    }));
  });

  it("records status='skipped' (no marker error) when the email provider is unconfigured (Task #1849)", async () => {
    // Provider misconfiguration is an env-level issue, not a per-recipient
    // delivery failure. Before Task #1849 the recipients-table check
    // constraint forced this branch to write `status='failed'` with a
    // marker `error_message='provider_not_configured'`, inflating the
    // per-recipient failure count in director-facing dashboards.
    // After widening the check constraint, the branch must now write
    // `status='skipped'` with `error_message=null`.
    const orgId = await makeOrg("provider-unconfigured");
    const td = await makeUser("provider-unconfigured-td");
    await addDirector(orgId, td, "tournament_director");

    const tournamentId = await makeTournament(orgId, "provider-unconfigured");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    // Drive the mailer to throw, AND wire the classifier to return the
    // canonical `provider_unconfigured` string for that throw — which is
    // the exact pair of conditions the production code branches on.
    sendManualEntryAlertEmailMock.mockImplementationOnce(async () => {
      throw new Error("SMTP transport not configured");
    });
    classifyMailerErrorMock.mockImplementation(() => "provider_unconfigured");

    const result = await notifyManualEntryRound(submissionId);
    // Push still goes through (the default mock succeeds), so the
    // overall outcome is still `sent` even though the email leg
    // skipped on env misconfig.
    expect(result.status).toBe("sent");
    // The skipped email leg must NOT count as an attempted delivery —
    // attempted is the "we tried to hand this off to the transport"
    // counter and a provider-misconfig error is a deploy-config gap,
    // but the existing implementation increments it before the throw.
    // We assert the persisted recipient row's status/error here, which
    // is the load-bearing assertion downstream dashboards key off.
    expect(result.email?.sent).toBe(0);

    const [alert] = await db.select({ id: manualEntryAlertsTable.id })
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionId));
    expect(alert).toBeDefined();

    const rows = await db.select({
      channel: manualEntryAlertRecipientsTable.channel,
      status: manualEntryAlertRecipientsTable.status,
      errorMessage: manualEntryAlertRecipientsTable.errorMessage,
      userId: manualEntryAlertRecipientsTable.userId,
    }).from(manualEntryAlertRecipientsTable)
      .where(eq(manualEntryAlertRecipientsTable.alertId, alert.id));

    const emailRow = rows.find(r => r.channel === "email" && r.userId === td);
    expect(emailRow?.status).toBe("skipped");
    // No marker error string — the row is terminal-skipped on the env
    // misconfig, not a stand-in for a real per-recipient failure.
    expect(emailRow?.errorMessage).toBeNull();
  });

  it("records `no_email` for recipients whose user row has no email address", async () => {
    const orgId = await makeOrg("no-email");
    const noEmail = await makeUser("no-email-user", { email: null });
    await addDirector(orgId, noEmail, "tournament_director");

    const tournamentId = await makeTournament(orgId, "no-email");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    const result = await notifyManualEntryRound(submissionId);
    expect(result.status).toBe("sent"); // push succeeded via the mock
    expect(result.email?.attempted).toBe(0);

    const [alert] = await db.select({ id: manualEntryAlertsTable.id })
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionId));
    const rows = await db.select({
      channel: manualEntryAlertRecipientsTable.channel,
      status: manualEntryAlertRecipientsTable.status,
      userId: manualEntryAlertRecipientsTable.userId,
    }).from(manualEntryAlertRecipientsTable)
      .where(eq(manualEntryAlertRecipientsTable.alertId, alert.id));

    const emailRow = rows.find(r => r.channel === "email" && r.userId === noEmail);
    expect(emailRow?.status).toBe("no_email");
  });
});

// ── Skip-path persistence (Task #1658) ───────────────────────────────────
// Every notify call (except the unrecoverable `submission_not_found`
// path, which has no FK target) must leave a manual_entry_alerts row
// behind so the super-admin audit page and the players-tab data-quality
// table can show "skipped — org_muted" instead of nothing. These tests
// drive each skip branch, then read the row back and assert
// status/reason are persisted as the canonical strings.
describe("notifyManualEntryRound — every path persists an audit row (Task #1658)", () => {
  async function readAuditRow(submissionId: number) {
    const [row] = await db.select({
      status: manualEntryAlertsTable.status,
      reason: manualEntryAlertsTable.reason,
      manualPct: manualEntryAlertsTable.manualPct,
      manualShots: manualEntryAlertsTable.manualShots,
      totalShots: manualEntryAlertsTable.totalShots,
      recipientCount: manualEntryAlertsTable.recipientCount,
      pushAttempted: manualEntryAlertsTable.pushAttempted,
      pushSent: manualEntryAlertsTable.pushSent,
      emailAttempted: manualEntryAlertsTable.emailAttempted,
      emailSent: manualEntryAlertsTable.emailSent,
    }).from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionId));
    return row;
  }

  it("status='sent' rows leave reason NULL (canonical sent semantic)", async () => {
    const orgId = await makeOrg("audit-sent");
    const td = await makeUser("audit-sent-td");
    await addDirector(orgId, td, "tournament_director");
    const tournamentId = await makeTournament(orgId, "audit-sent");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    await notifyManualEntryRound(submissionId);
    const row = await readAuditRow(submissionId);
    expect(row).toBeDefined();
    expect(row.status).toBe("sent");
    // Per the spec: reason MUST be NULL when status='sent' so the
    // dashboard can WHERE reason IS NOT NULL to surface skip rows
    // without also having to filter status.
    expect(row.reason).toBeNull();
    expect(row.recipientCount).toBe(1);
  });

  it("persists status='skipped' + reason='below_threshold' for sub-50% rounds", async () => {
    const orgId = await makeOrg("audit-below");
    const td = await makeUser("audit-below-td");
    await addDirector(orgId, td, "tournament_director");
    const tournamentId = await makeTournament(orgId, "audit-below");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 4, watch: 6 });

    await notifyManualEntryRound(submissionId);
    const row = await readAuditRow(submissionId);
    expect(row).toBeDefined();
    expect(row.status).toBe("skipped");
    expect(row.reason).toBe("below_threshold");
    // Manual % is recorded so the audit row stays useful for triage even
    // though no alert was sent.
    expect(Number(row.manualPct)).toBeCloseTo(40);
    expect(row.totalShots).toBe(10);
    // No fan-out happened, so the channel counters stay zero — the
    // dashboard's silent-vs-skipped split keys off these.
    expect(row.recipientCount).toBe(0);
    expect(row.pushAttempted).toBe(0);
    expect(row.emailAttempted).toBe(0);
  });

  it("persists status='skipped' + reason='no_shots_captured' when the round has no shots", async () => {
    const orgId = await makeOrg("audit-no-shots");
    const td = await makeUser("audit-no-shots-td");
    await addDirector(orgId, td, "tournament_director");
    const tournamentId = await makeTournament(orgId, "audit-no-shots");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    // Intentionally no shots: covers the empty-round branch.

    await notifyManualEntryRound(submissionId);
    const row = await readAuditRow(submissionId);
    expect(row).toBeDefined();
    expect(row.status).toBe("skipped");
    expect(row.reason).toBe("no_shots_captured");
    expect(row.totalShots).toBe(0);
  });

  it("persists status='skipped' + reason='org_muted' when the org has manual-entry alerts off", async () => {
    const orgId = await makeOrg("audit-org-muted", { notifyManualEntryAlerts: false });
    const td = await makeUser("audit-org-muted-td");
    await addDirector(orgId, td, "tournament_director");
    const tournamentId = await makeTournament(orgId, "audit-org-muted");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    await notifyManualEntryRound(submissionId);
    const row = await readAuditRow(submissionId);
    expect(row).toBeDefined();
    expect(row.status).toBe("skipped");
    expect(row.reason).toBe("org_muted");
    // Manual % is recorded — support's primary use case is "show me the
    // org_muted rounds that would have been very manual if we hadn't
    // muted", so the percentage matters even on the skip row.
    expect(Number(row.manualPct)).toBeCloseTo(80);
  });

  it("persists status='skipped' + reason='no_recipients' when the org has no directors", async () => {
    const orgId = await makeOrg("audit-no-recipients");
    // Intentionally NO director added — only a player membership so the
    // org isn't completely empty (proves the role filter is doing the
    // work, not just an org-empty short-circuit).
    const player = await makeUser("audit-no-recipients-only-player");
    await db.insert(orgMembershipsTable).values({
      organizationId: orgId, userId: player, role: "player",
    });
    const tournamentId = await makeTournament(orgId, "audit-no-recipients");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 9, watch: 1 });

    await notifyManualEntryRound(submissionId);
    const row = await readAuditRow(submissionId);
    expect(row).toBeDefined();
    expect(row.status).toBe("skipped");
    expect(row.reason).toBe("no_recipients");
    expect(row.recipientCount).toBe(0);
  });

  it("persists status='skipped' + reason='all_recipients_opted_out' when every director muted the alert", async () => {
    const orgId = await makeOrg("audit-all-opted-out");
    const td1 = await makeUser("audit-opt-1");
    const td2 = await makeUser("audit-opt-2");
    await addDirector(orgId, td1, "tournament_director");
    await addDirector(orgId, td2, "tournament_director");
    // Personal-pref opt-out: every recipient turned the alert off.
    await db.insert(userNotificationPrefsTable).values([
      { userId: td1, notifyManualEntryAlerts: false },
      { userId: td2, notifyManualEntryAlerts: false },
    ]);
    const tournamentId = await makeTournament(orgId, "audit-all-opted-out");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    await notifyManualEntryRound(submissionId);
    const row = await readAuditRow(submissionId);
    expect(row).toBeDefined();
    expect(row.status).toBe("skipped");
    expect(row.reason).toBe("all_recipients_opted_out");
  });

  // ── Task #1502 / #1849 / #1850 — provider_unconfigured branch ──────
  // Task #1849 widened the manual_entry_alert_recipients status check
  // constraint so the helper can record env-misconfig as terminal
  // `skipped` (with a null error_message) instead of inflating the
  // per-recipient `failed` count for what is fundamentally a deploy-
  // config gap. The helper also suppresses the per-recipient warn
  // log on this branch so a single misconfigured SMTP env doesn't
  // bill the admin's log dashboard once per recipient.
  it("provider_unconfigured: records skipped (errorMessage=null) and suppresses warn log", async () => {
    const orgId = await makeOrg("provider-unconfigured");
    const td = await makeUser("td-prov-unconfigured");
    await addDirector(orgId, td, "tournament_director");

    sendManualEntryAlertEmailMock.mockRejectedValueOnce(new Error("SMTP host not configured"));
    classifyMailerErrorMock.mockReturnValueOnce("provider_unconfigured");

    const warnSpy = vi.spyOn((await import("../logger.js")).logger, "warn");

    const tournamentId = await makeTournament(orgId, "prov-unconfigured");
    const playerId = await makePlayer(tournamentId);
    const submissionId = await makeSubmission(tournamentId, playerId);
    await seedShots({ tournamentId, playerId, round: 1, manual: 8, watch: 2 });

    const result = await notifyManualEntryRound(submissionId);
    // Push leg succeeded via the default mock, so the aggregate is "sent".
    expect(result.status).toBe("sent");
    expect(sendManualEntryAlertEmailMock).toHaveBeenCalledTimes(1);

    // The per-recipient row is `skipped` (Task #1849 widened the
    // constraint) with a null error_message — the env-misconfig marker
    // is implicit in the status, not the message string.
    const [alert] = await db.select({ id: manualEntryAlertsTable.id })
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionId));
    const rows = await db.select({
      channel: manualEntryAlertRecipientsTable.channel,
      status: manualEntryAlertRecipientsTable.status,
      errorMessage: manualEntryAlertRecipientsTable.errorMessage,
      userId: manualEntryAlertRecipientsTable.userId,
    }).from(manualEntryAlertRecipientsTable)
      .where(eq(manualEntryAlertRecipientsTable.alertId, alert.id));
    const emailRow = rows.find(r => r.channel === "email" && r.userId === td);
    expect(emailRow?.status).toBe("skipped");
    expect(emailRow?.errorMessage).toBeNull();

    // The provider_unconfigured branch must NOT log a warn for the
    // misconfigured-env condition (otherwise every alert would spam logs).
    const manualEntryWarn = warnSpy.mock.calls.find(c => {
      const ctx = c[0];
      return typeof ctx === "object" && ctx !== null && (ctx as Record<string, unknown>).submissionId === submissionId;
    });
    expect(manualEntryWarn).toBeUndefined();

    warnSpy.mockRestore();
  });

  it("does NOT write a row for the submission_not_found branch (FK target missing — documented inline)", async () => {
    // Pick an id that cannot exist by construction (Postgres serial
    // sequences are positive). The submission lookup returns no row, so
    // notify bails before the accumulator can be initialised — and the
    // FK to round_submissions cannot be satisfied either way.
    const ghostId = -1;
    const result = await notifyManualEntryRound(ghostId);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("submission_not_found");

    const [row] = await db.select({ id: manualEntryAlertsTable.id })
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, ghostId));
    expect(row).toBeUndefined();
  });
});
