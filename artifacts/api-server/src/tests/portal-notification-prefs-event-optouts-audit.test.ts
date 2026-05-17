/**
 * Task #2154 — PATCH /api/portal/notification-preferences writes a
 * `notification_audit_log` row when the user toggles any per-event
 * opt-out from the in-portal Notifications settings page.
 *
 * Until this task only the email-link mute path
 * (`/api/public/notification-event-mute` and the matching resubscribe,
 * Task #1734) wrote the canonical paper-trail row that proves an alert
 * was suppressed by user choice rather than lost. An admin who muted
 * (or re-enabled) the same alert from the settings page left no entry,
 * which made it impossible to reconstruct who silenced an alert when
 * an incident surfaced later.
 *
 * The settings-page PATCH now mirrors that pattern with two distinct
 * reasons (`event_opted_out_via_settings_page` /
 * `event_opted_in_via_settings_page`) so the existing audit surface
 * (`/portal/notification-audit`) renders them out of the box and ops
 * can tell settings-page mutes apart from email-link mutes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  organizationsTable,
  userNotificationPrefsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, eq, desc, inArray } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let userId: number;

beforeAll(async () => {
  const tag = uid("portal-event-optouts-audit");
  const [org] = await db.insert(organizationsTable).values({
    name: `Portal Event Opt-outs Audit ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-user`,
    username: `${tag}_user`,
    displayName: "Portal Event Opt-outs Audit User",
    email: `${tag}@example.com`,
    role: "super_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
});

afterAll(async () => {
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.userId, userId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Reset prefs + audit timeline for THIS user only between cases so each
  // test starts from the schema defaults (every per-event flag = true)
  // and a clean audit log. Scoping by userId keeps the suite parallel-safe
  // with any other audit-emitting test that runs concurrently.
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.userId, userId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
});

async function listSettingsPageAuditRowsForUser() {
  return db
    .select({
      id: notificationAuditLogTable.id,
      notificationKey: notificationAuditLogTable.notificationKey,
      userId: notificationAuditLogTable.userId,
      channel: notificationAuditLogTable.channel,
      status: notificationAuditLogTable.status,
      reason: notificationAuditLogTable.reason,
      payload: notificationAuditLogTable.payload,
    })
    .from(notificationAuditLogTable)
    .where(and(
      eq(notificationAuditLogTable.userId, userId),
      inArray(notificationAuditLogTable.reason, [
        "event_opted_out_via_settings_page",
        "event_opted_in_via_settings_page",
      ]),
    ))
    .orderBy(desc(notificationAuditLogTable.createdAt));
}

describe("Task #2154 — PATCH /api/portal/notification-preferences settings-page audit", () => {
  it("writes an audit row keyed by the dispatcher slug when the user mutes a per-event opt-out", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "super_admin", organizationId: orgId });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyExhaustionAdminDigestFailed: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyExhaustionAdminDigestFailed).toBe(false);

    const rows = await listSettingsPageAuditRowsForUser();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Notification key must be the dispatcher slug (matches what the
    // dispatcher itself writes when it short-circuits a recipient with
    // this column false), not the camel-case column name. Otherwise the
    // `/portal/notification-audit` surface that groups by key would
    // double-count flips against this column.
    expect(row.notificationKey).toBe("notify.exhaustion.admin_digest.failed");
    expect(row.channel).toBe("email");
    expect(row.status).toBe("skipped");
    expect(row.reason).toBe("event_opted_out_via_settings_page");
    expect(row.payload).toMatchObject({
      source: "portal_notification_preferences",
      direction: "unsubscribe",
      previousFlag: true,
      field: "notifyExhaustionAdminDigestFailed",
    });
  });

  it("writes an opt-in audit row when the user re-enables a previously-muted per-event opt-out", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "super_admin", organizationId: orgId });

    // Seed the muted state (writes one audit row).
    const off = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyExhaustionAdminDigestFailed: false });
    expect(off.status).toBe(200);

    // Re-enable.
    const on = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyExhaustionAdminDigestFailed: true });
    expect(on.status).toBe(200);
    expect(on.body.notifyExhaustionAdminDigestFailed).toBe(true);

    const rows = await listSettingsPageAuditRowsForUser();
    // Newest first per the orderBy above.
    expect(rows).toHaveLength(2);
    const resubscribe = rows[0];
    expect(resubscribe.notificationKey).toBe("notify.exhaustion.admin_digest.failed");
    expect(resubscribe.reason).toBe("event_opted_in_via_settings_page");
    expect(resubscribe.payload).toMatchObject({
      source: "portal_notification_preferences",
      direction: "resubscribe",
      previousFlag: false,
      field: "notifyExhaustionAdminDigestFailed",
    });
  });

  it("writes a row per flipped column when several per-event opt-outs change in a single PATCH", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "super_admin", organizationId: orgId });

    // Flip three independent per-event opt-outs in one request. The
    // PATCH body deliberately mixes channels (the dispatcher writes
    // `channel: "email"` for every email-only key and `channel: "push"`
    // for `notifyCoachingTipClosed`, but the settings page is channel-
    // agnostic and pins everything to "email" so the audit surface
    // groups by key without a schema-level change).
    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({
        notifyExhaustionAdminDigestFailed: false,
        notifyLevyRemindersDigestFailed: false,
        notifyCoachingTipClosed: false,
      });
    expect(patch.status).toBe(200);

    const rows = await listSettingsPageAuditRowsForUser();
    expect(rows).toHaveLength(3);
    const keys = rows.map((r) => r.notificationKey).sort();
    expect(keys).toEqual([
      "coaching.gap.closed",
      "levy.reminders.digest.failed",
      "notify.exhaustion.admin_digest.failed",
    ]);
    for (const r of rows) {
      expect(r.reason).toBe("event_opted_out_via_settings_page");
      expect(r.payload).toMatchObject({
        source: "portal_notification_preferences",
        direction: "unsubscribe",
        previousFlag: true,
      });
    }
  });

  it("does NOT write a row when the supplied value matches the stored value (no-op save)", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "super_admin", organizationId: orgId });

    // Schema default is true, so PATCHing true on a fresh prefs row is a
    // no-op and must not pollute the audit timeline with a from=true →
    // to=true row.
    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyExhaustionAdminDigestFailed: true });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyExhaustionAdminDigestFailed).toBe(true);

    const rows = await listSettingsPageAuditRowsForUser();
    expect(rows).toHaveLength(0);
  });

  it("does NOT write a row when no per-event opt-out is supplied in the PATCH body", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "super_admin", organizationId: orgId });

    // PATCHing only a non-per-event field (e.g. `preferPush`) must not
    // synthesize a settings-page audit row — the diff guard requires the
    // per-event flag itself to actually be supplied and to genuinely
    // flip.
    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ preferPush: false });
    expect(patch.status).toBe(200);

    const rows = await listSettingsPageAuditRowsForUser();
    expect(rows).toHaveLength(0);
  });
});
