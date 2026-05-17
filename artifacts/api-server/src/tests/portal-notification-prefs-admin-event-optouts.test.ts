/**
 * Task #1429 — Portal endpoint round-trip for the admin per-event
 * opt-outs added in this task.
 *
 * The dispatcher behaviour is covered in
 * `notification-dispatch-and-digest.test.ts` (event_opted_out short-circuit
 * for both new keys); this suite covers the *plumbing* between the portal
 * UI and the database column, so a regression where the GET strips the
 * field, the PATCH ignores the field, or the upsert defaults are wrong
 * would surface here even if the dispatcher itself stays correct.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  organizationsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let userId: number;

beforeAll(async () => {
  const tag = uid("portal-admin-event-optouts");
  const [org] = await db.insert(organizationsTable).values({
    name: `Portal Admin Event Opt-outs ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-user`,
    username: `${tag}_user`,
    displayName: "Admin Event Opt-out User",
    email: `${tag}@example.com`,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
});

afterAll(async () => {
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("GET /api/portal/notification-preferences — admin per-event opt-outs", () => {
  it("defaults the two new admin opt-outs to true when no prefs row exists", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });
    const res = await request(app).get("/api/portal/notification-preferences");
    expect(res.status).toBe(200);
    expect(res.body.notifyWalletRefundDigestFailed).toBe(true);
    expect(res.body.notifySideGameReceiptDigestFailed).toBe(true);
    // Task #1762 — three new admin per-event opt-outs for the
    // levy/reminders digest-failed alerts default-on too, mirroring
    // the wallet/side-game refund digest defaults above.
    expect(res.body.notifyLevyLedgerDigestFailed).toBe(true);
    expect(res.body.notifyLevyLedgerOrgDigestFailed).toBe(true);
    expect(res.body.notifyLevyRemindersDigestFailed).toBe(true);
    // Task #2154 — surfaced super-admin per-event opt-out for the daily
    // exhaustion-admin-digest cron failed alert. Default-on when the
    // prefs row is absent so existing super_admins keep receiving it.
    expect(res.body.notifyExhaustionAdminDigestFailed).toBe(true);
    // Task #2154 — surfaced player-facing per-event opt-out for the
    // "you closed the gap" coaching push. Default-on so existing players
    // keep receiving the encouragement nudge after the surface lands.
    expect(res.body.notifyCoachingTipClosed).toBe(true);
  });
});

describe("PATCH /api/portal/notification-preferences — admin per-event opt-outs", () => {
  it("persists notifyWalletRefundDigestFailed and surfaces it on the next GET", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyWalletRefundDigestFailed).toBe(false);
    // Patch must NOT bleed into the sibling column.
    expect(patch.body.notifySideGameReceiptDigestFailed).toBe(true);

    const get = await request(app).get("/api/portal/notification-preferences");
    expect(get.status).toBe(200);
    expect(get.body.notifyWalletRefundDigestFailed).toBe(false);
    expect(get.body.notifySideGameReceiptDigestFailed).toBe(true);

    const reset = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyWalletRefundDigestFailed: true });
    expect(reset.body.notifyWalletRefundDigestFailed).toBe(true);
  });

  it("persists notifySideGameReceiptDigestFailed independently of the sibling field", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifySideGameReceiptDigestFailed: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifySideGameReceiptDigestFailed).toBe(false);
    expect(patch.body.notifyWalletRefundDigestFailed).toBe(true);

    const get = await request(app).get("/api/portal/notification-preferences");
    expect(get.body.notifySideGameReceiptDigestFailed).toBe(false);
    expect(get.body.notifyWalletRefundDigestFailed).toBe(true);

    const reset = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifySideGameReceiptDigestFailed: true });
    expect(reset.body.notifySideGameReceiptDigestFailed).toBe(true);
  });

  // Task #1762 — assert each of the three new admin per-event opt-outs
  // round-trips through PATCH/GET without bleeding into the others. We
  // pick `notifyLevyLedgerOrgDigestFailed` as the "sentinel" sibling on
  // every assertion: a regression where the route accidentally aliases
  // two columns to the same Drizzle field would fail the
  // `expect(...notifyLevyLedgerOrgDigestFailed).toBe(true)` line on the
  // first and third tests, even when only the matching opt-out was
  // PATCHed.
  it("persists notifyLevyLedgerDigestFailed independently of the sibling levy fields", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyLevyLedgerDigestFailed: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyLevyLedgerDigestFailed).toBe(false);
    expect(patch.body.notifyLevyLedgerOrgDigestFailed).toBe(true);
    expect(patch.body.notifyLevyRemindersDigestFailed).toBe(true);

    const get = await request(app).get("/api/portal/notification-preferences");
    expect(get.body.notifyLevyLedgerDigestFailed).toBe(false);
    expect(get.body.notifyLevyLedgerOrgDigestFailed).toBe(true);
    expect(get.body.notifyLevyRemindersDigestFailed).toBe(true);

    const reset = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyLevyLedgerDigestFailed: true });
    expect(reset.body.notifyLevyLedgerDigestFailed).toBe(true);
  });

  it("persists notifyLevyLedgerOrgDigestFailed independently of the sibling levy fields", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyLevyLedgerOrgDigestFailed: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyLevyLedgerOrgDigestFailed).toBe(false);
    expect(patch.body.notifyLevyLedgerDigestFailed).toBe(true);
    expect(patch.body.notifyLevyRemindersDigestFailed).toBe(true);

    const get = await request(app).get("/api/portal/notification-preferences");
    expect(get.body.notifyLevyLedgerOrgDigestFailed).toBe(false);
    expect(get.body.notifyLevyLedgerDigestFailed).toBe(true);
    expect(get.body.notifyLevyRemindersDigestFailed).toBe(true);

    const reset = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyLevyLedgerOrgDigestFailed: true });
    expect(reset.body.notifyLevyLedgerOrgDigestFailed).toBe(true);
  });

  it("persists notifyLevyRemindersDigestFailed independently of the sibling levy fields", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyLevyRemindersDigestFailed: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyLevyRemindersDigestFailed).toBe(false);
    expect(patch.body.notifyLevyLedgerDigestFailed).toBe(true);
    expect(patch.body.notifyLevyLedgerOrgDigestFailed).toBe(true);

    const get = await request(app).get("/api/portal/notification-preferences");
    expect(get.body.notifyLevyRemindersDigestFailed).toBe(false);
    expect(get.body.notifyLevyLedgerDigestFailed).toBe(true);
    expect(get.body.notifyLevyLedgerOrgDigestFailed).toBe(true);

    const reset = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyLevyRemindersDigestFailed: true });
    expect(reset.body.notifyLevyRemindersDigestFailed).toBe(true);
  });

  // Task #2154 — surfaced super-admin per-event opt-out for the daily
  // exhaustion-admin-digest cron failed alert. Same plumbing assertions
  // as the levy/wallet siblings: PATCH must persist, GET must surface,
  // and unrelated columns must stay untouched. We pick
  // `notifyLevyRemindersDigestFailed` as the cross-column sentinel
  // because both fields share the same dispatcher channel ("email") and
  // a regression where the route accidentally aliased the two columns
  // to the same Drizzle field would only surface here.
  it("persists notifyExhaustionAdminDigestFailed independently of the sibling fields", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyExhaustionAdminDigestFailed: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyExhaustionAdminDigestFailed).toBe(false);
    expect(patch.body.notifyLevyRemindersDigestFailed).toBe(true);
    expect(patch.body.notifyCoachingTipClosed).toBe(true);

    const get = await request(app).get("/api/portal/notification-preferences");
    expect(get.body.notifyExhaustionAdminDigestFailed).toBe(false);
    expect(get.body.notifyLevyRemindersDigestFailed).toBe(true);
    expect(get.body.notifyCoachingTipClosed).toBe(true);

    const reset = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyExhaustionAdminDigestFailed: true });
    expect(reset.body.notifyExhaustionAdminDigestFailed).toBe(true);
  });

  // Task #2154 — surfaced player-facing per-event opt-out for the
  // "you closed the gap" coaching push. Channel-agnostic round-trip:
  // the dispatcher writes a `channel: "push"` audit row when this fires
  // (see the dedicated audit suite below), but the GET/PATCH plumbing
  // is the same as every other per-event flag.
  it("persists notifyCoachingTipClosed independently of the sibling fields", async () => {
    const app = createTestApp({ id: userId, username: "u", role: "org_admin" });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyCoachingTipClosed: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyCoachingTipClosed).toBe(false);
    expect(patch.body.notifyExhaustionAdminDigestFailed).toBe(true);
    expect(patch.body.notifyLevyRemindersDigestFailed).toBe(true);

    const get = await request(app).get("/api/portal/notification-preferences");
    expect(get.body.notifyCoachingTipClosed).toBe(false);
    expect(get.body.notifyExhaustionAdminDigestFailed).toBe(true);

    const reset = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyCoachingTipClosed: true });
    expect(reset.body.notifyCoachingTipClosed).toBe(true);
  });
});
