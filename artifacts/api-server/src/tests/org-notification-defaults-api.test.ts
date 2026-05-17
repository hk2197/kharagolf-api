/**
 * Integration tests for the org-wide notification-defaults endpoints
 * (Task #1188 / #1379 / #1673).
 *
 * Coverage:
 *   - GET /organizations/:orgId/notification-defaults returns one
 *     boolean per registered key (today: `notifyManualEntryAlerts`).
 *   - GET rejects unauthenticated callers (401) and non-admin members
 *     (403). The card on the web client self-hides on these responses
 *     so it's important the API actually distinguishes them.
 *   - PATCH accepts a boolean per registered key and persists it; the
 *     next GET reflects the new value.
 *   - PATCH validates the input — non-boolean values are rejected with
 *     400, unknown keys are rejected with 400 (so typos don't ship as
 *     silent no-ops), and an empty body is rejected with 400.
 *   - PATCH RBAC matches GET — non-admin members can't change the org
 *     setting.
 *   - GET .../tournaments returns each registered per-tournament toggle
 *     for every still-relevant tournament.
 *   - POST .../apply-to-tournaments accepts any subset of registered
 *     keys, returns a per-key results array, and preserves legacy
 *     top-level fields when the manual-entry key was applied so the
 *     web client's existing toast copy keeps working.
 *   - POST /tournaments seeds the new tournament's per-tournament
 *     `notifyManualEntryAlerts` from the org-wide flag, so a club that
 *     has muted the alert org-wide gets new tournaments created with
 *     the per-tournament toggle already off.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  tournamentsTable,
  tournamentNotificationOverrideAuditTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { inArray, eq, and, desc, asc } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

async function makeOrg(label: string, opts: { notifyManualEntryAlerts?: boolean } = {}): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `OrgNotify_${tag}`,
    slug: `org-notify-${tag}`.toLowerCase(),
    ...(opts.notifyManualEntryAlerts === undefined
      ? {}
      : { notifyManualEntryAlerts: opts.notifyManualEntryAlerts }),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeUser(orgId: number, role: OrgRole): Promise<TestUser> {
  const tag = uid(role);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: role,
    role,
    organizationId: role === "org_admin" || role === "tournament_director" ? orgId : null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return {
    id: u.id,
    username: tag,
    displayName: role,
    role,
    organizationId: role === "org_admin" || role === "tournament_director" ? orgId : undefined,
  };
}

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    // FK ON DELETE CASCADE on tournaments wipes any rows the inheritance
    // test created.
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("GET /organizations/:orgId/notification-defaults", () => {
  it("returns the org-wide manual-entry default for an org_admin caller", async () => {
    const orgId = await makeOrg("get_admin", { notifyManualEntryAlerts: false });
    const admin = await makeUser(orgId, "org_admin");

    const res = await request(createTestApp(admin))
      .get(`/api/organizations/${orgId}/notification-defaults`)
      .expect(200);

    // GET projects every registered org notification default key
    // (Task #1673). The other registry keys keep their schema defaults.
    expect(res.body).toEqual({
      notifyManualEntryAlerts: false,
      notifyScheduleChanges: true,
      notifyScoreCorrections: true,
    });
  });

  it("returns the schema default (true) for a freshly created org", async () => {
    // Sanity: an org that has never touched the toggle still reads as
    // "alerts on" — proves the migration default and route default
    // line up with the documented behaviour.
    const orgId = await makeOrg("get_default");
    const admin = await makeUser(orgId, "org_admin");

    const res = await request(createTestApp(admin))
      .get(`/api/organizations/${orgId}/notification-defaults`)
      .expect(200);

    expect(res.body).toEqual({
      notifyManualEntryAlerts: true,
      notifyScheduleChanges: true,
      notifyScoreCorrections: true,
    });
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("get_authz");

    await request(createTestApp())
      .get(`/api/organizations/${orgId}/notification-defaults`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .get(`/api/organizations/${orgId}/notification-defaults`)
      .expect(403);
  });
});

describe("PATCH /organizations/:orgId/notification-defaults", () => {
  it("persists a new value and reflects it on the next GET", async () => {
    const orgId = await makeOrg("patch_persist");
    const admin = await makeUser(orgId, "org_admin");
    const app = createTestApp(admin);

    // PATCH echoes back only the keys that were sent — the optimistic
    // web client only needs the updated values to merge into local state.
    const patchRes = await request(app)
      .patch(`/api/organizations/${orgId}/notification-defaults`)
      .send({ notifyManualEntryAlerts: false })
      .expect(200);
    expect(patchRes.body).toEqual({ notifyManualEntryAlerts: false });

    // GET projects every registered key (Task #1673).
    const getRes = await request(app)
      .get(`/api/organizations/${orgId}/notification-defaults`)
      .expect(200);
    expect(getRes.body).toEqual({
      notifyManualEntryAlerts: false,
      notifyScheduleChanges: true,
      notifyScoreCorrections: true,
    });

    // And flipping back works too.
    await request(app)
      .patch(`/api/organizations/${orgId}/notification-defaults`)
      .send({ notifyManualEntryAlerts: true })
      .expect(200);
    const getRes2 = await request(app)
      .get(`/api/organizations/${orgId}/notification-defaults`)
      .expect(200);
    expect(getRes2.body).toEqual({
      notifyManualEntryAlerts: true,
      notifyScheduleChanges: true,
      notifyScoreCorrections: true,
    });
  });

  it("persists multiple keys in one PATCH (Task #1673 multi-default registry)", async () => {
    // Validates the API can accept any subset of registered keys in a
    // single PATCH so the web client doesn't need a separate request
    // per toggle when the user flips several at once.
    const orgId = await makeOrg("patch_multi_keys");
    const admin = await makeUser(orgId, "org_admin");
    const app = createTestApp(admin);

    const res = await request(app)
      .patch(`/api/organizations/${orgId}/notification-defaults`)
      .send({ notifyScheduleChanges: false, notifyScoreCorrections: false })
      .expect(200);
    // Echo only the keys that were sent; manual-entry stayed on its
    // schema default and was not touched by this PATCH.
    expect(res.body).toEqual({
      notifyScheduleChanges: false,
      notifyScoreCorrections: false,
    });

    // The next GET reflects the full picture: manual-entry untouched
    // (still true), the other two newly muted.
    const getRes = await request(app)
      .get(`/api/organizations/${orgId}/notification-defaults`)
      .expect(200);
    expect(getRes.body).toEqual({
      notifyManualEntryAlerts: true,
      notifyScheduleChanges: false,
      notifyScoreCorrections: false,
    });
  });

  it("rejects non-boolean notifyManualEntryAlerts with 400", async () => {
    const orgId = await makeOrg("patch_bad_type");
    const admin = await makeUser(orgId, "org_admin");

    const res = await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/notification-defaults`)
      .send({ notifyManualEntryAlerts: "no" })
      .expect(400);
    expect(res.body.error).toMatch(/notifyManualEntryAlerts/);
  });

  it("rejects an empty body with 400 so silent no-ops can't slip through", async () => {
    const orgId = await makeOrg("patch_empty");
    const admin = await makeUser(orgId, "org_admin");

    await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/notification-defaults`)
      .send({})
      .expect(400);
  });

  it("rejects unknown notification keys with 400 (Task #1673)", async () => {
    // Typos used to silently no-op back when the route hard-coded a
    // single supported key. Now every supplied key is matched against
    // the registry so a misnamed flag fails loudly.
    const orgId = await makeOrg("patch_unknown_key");
    const admin = await makeUser(orgId, "org_admin");

    const res = await request(createTestApp(admin))
      .patch(`/api/organizations/${orgId}/notification-defaults`)
      .send({ notifyMadeUpSetting: false })
      .expect(400);
    expect(res.body.error).toMatch(/notifyMadeUpSetting/);
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("patch_authz");

    await request(createTestApp())
      .patch(`/api/organizations/${orgId}/notification-defaults`)
      .send({ notifyManualEntryAlerts: false })
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .patch(`/api/organizations/${orgId}/notification-defaults`)
      .send({ notifyManualEntryAlerts: false })
      .expect(403);
  });
});

describe("GET /organizations/:orgId/notification-defaults/tournaments (Task #1379)", () => {
  it("returns active tournaments with their per-tournament flag for an org_admin", async () => {
    const orgId = await makeOrg("inheritance_list", { notifyManualEntryAlerts: false });
    const admin = await makeUser(orgId, "org_admin");

    // A muted draft (matches org default), an alert-on upcoming (diverges
    // from org default), and a completed event that should be excluded
    // from the inheritance summary entirely.
    const [draft] = await db.insert(tournamentsTable).values({
      organizationId: orgId,
      name: `Draft ${uid("t")}`,
      format: "stroke_play",
      status: "draft",
      notifyManualEntryAlerts: false,
    }).returning({ id: tournamentsTable.id });
    const [upcoming] = await db.insert(tournamentsTable).values({
      organizationId: orgId,
      name: `Upcoming ${uid("t")}`,
      format: "stroke_play",
      status: "upcoming",
      notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });
    await db.insert(tournamentsTable).values({
      organizationId: orgId,
      name: `Completed ${uid("t")}`,
      format: "stroke_play",
      status: "completed",
      notifyManualEntryAlerts: true,
    });

    const res = await request(createTestApp(admin))
      .get(`/api/organizations/${orgId}/notification-defaults/tournaments`)
      .expect(200);

    expect(Array.isArray(res.body.tournaments)).toBe(true);
    type Row = { id: number; notifyManualEntryAlerts: boolean; status: string };
    const rows = res.body.tournaments as Row[];
    const ids = rows.map(t => t.id).sort();
    expect(ids).toEqual([draft.id, upcoming.id].sort());
    const byId = new Map<number, Row>(rows.map(t => [t.id, t]));
    expect(byId.get(draft.id)?.notifyManualEntryAlerts).toBe(false);
    expect(byId.get(upcoming.id)?.notifyManualEntryAlerts).toBe(true);
    expect(byId.get(draft.id)?.status).toBe("draft");
    expect(byId.get(upcoming.id)?.status).toBe("upcoming");
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("inheritance_authz");

    await request(createTestApp())
      .get(`/api/organizations/${orgId}/notification-defaults/tournaments`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .get(`/api/organizations/${orgId}/notification-defaults/tournaments`)
      .expect(403);
  });
});

describe("POST /organizations/:orgId/notification-defaults/apply-to-tournaments (Task #1379)", () => {
  it("flips every divergent active tournament to the supplied value and reports the count", async () => {
    const orgId = await makeOrg("apply_explicit", { notifyManualEntryAlerts: false });
    const admin = await makeUser(orgId, "org_admin");

    // Two divergent (alert-on) and one already-matching (muted), plus a
    // completed event that should be left alone even if it diverges.
    const [t1] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `A ${uid("t")}`, format: "stroke_play",
      status: "draft", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });
    const [t2] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `B ${uid("t")}`, format: "stroke_play",
      status: "active", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });
    const [matching] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `C ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: false,
    }).returning({ id: tournamentsTable.id });
    const [done] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `D ${uid("t")}`, format: "stroke_play",
      status: "completed", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: false })
      .expect(200);
    // Per-key results array (Task #1673) plus the legacy top-level
    // fields kept for back-compat with the single-toggle UI.
    expect(res.body).toEqual({
      results: [{ key: "notifyManualEntryAlerts", value: false, updatedCount: 2 }],
      notifyManualEntryAlerts: false,
      updatedCount: 2,
    });

    const rows = await db
      .select({ id: tournamentsTable.id, flag: tournamentsTable.notifyManualEntryAlerts })
      .from(tournamentsTable)
      .where(inArray(tournamentsTable.id, [t1.id, t2.id, matching.id, done.id]));
    const byId = new Map(rows.map(r => [r.id, r.flag]));
    expect(byId.get(t1.id)).toBe(false);
    expect(byId.get(t2.id)).toBe(false);
    expect(byId.get(matching.id)).toBe(false); // unchanged but still matches
    expect(byId.get(done.id)).toBe(true); // completed event left alone
  });

  it("falls back to the stored org-wide default for every registered key when the body is empty", async () => {
    // Empty-body POST means "apply every org-wide default to its
    // matching tournaments". Per Task #1673 that now covers every key
    // in the registry, not just manual-entry. The legacy top-level
    // notifyManualEntryAlerts/updatedCount fields are still emitted for
    // back-compat with the single-toggle UI.
    const orgId = await makeOrg("apply_default", {
      notifyManualEntryAlerts: false,
    });
    const admin = await makeUser(orgId, "org_admin");

    const [t1] = await db.insert(tournamentsTable).values({
      organizationId: orgId,
      name: `Fallback ${uid("t")}`,
      format: "stroke_play",
      status: "upcoming",
      notifyManualEntryAlerts: true,
      notifyScheduleChanges: true,
      notifyScoreCorrections: true,
    }).returning({ id: tournamentsTable.id });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({})
      .expect(200);
    // Only the manual-entry key was muted org-wide; the other registered
    // keys are still on by default so their per-tournament rows already
    // match and their updatedCount is 0.
    expect(res.body).toEqual({
      results: [
        { key: "notifyManualEntryAlerts", value: false, updatedCount: 1 },
        { key: "notifyScheduleChanges", value: true, updatedCount: 0 },
        { key: "notifyScoreCorrections", value: true, updatedCount: 0 },
      ],
      notifyManualEntryAlerts: false,
      updatedCount: 1,
    });

    const [row] = await db.select({
      manualEntry: tournamentsTable.notifyManualEntryAlerts,
      schedule: tournamentsTable.notifyScheduleChanges,
      corrections: tournamentsTable.notifyScoreCorrections,
    }).from(tournamentsTable).where(eq(tournamentsTable.id, t1.id));
    expect(row.manualEntry).toBe(false);
    expect(row.schedule).toBe(true);
    expect(row.corrections).toBe(true);
  });

  it("applies multiple registered keys in one POST with per-key updatedCounts (Task #1673)", async () => {
    // Drives the master "Apply all divergent (N)" affordance on the
    // /club-settings card: a single POST that flips several org-wide
    // defaults onto their matching tournaments and reports each key's
    // updatedCount independently. The legacy top-level fields are still
    // populated because manual-entry was in the result set.
    const orgId = await makeOrg("apply_multi_keys", {
      notifyManualEntryAlerts: false,
    });
    const admin = await makeUser(orgId, "org_admin");

    // Two events, both diverging on multiple keys: alerts on across the
    // board where the new org-wide defaults want them off.
    const [t1] = await db.insert(tournamentsTable).values({
      organizationId: orgId,
      name: `Multi A ${uid("t")}`,
      format: "stroke_play",
      status: "draft",
      notifyManualEntryAlerts: true,
      notifyScheduleChanges: true,
      notifyScoreCorrections: true,
    }).returning({ id: tournamentsTable.id });
    const [t2] = await db.insert(tournamentsTable).values({
      organizationId: orgId,
      name: `Multi B ${uid("t")}`,
      format: "stroke_play",
      status: "active",
      notifyManualEntryAlerts: true,
      notifyScheduleChanges: false, // already matches the requested value
      notifyScoreCorrections: true,
    }).returning({ id: tournamentsTable.id });
    // Completed event must not be touched even when all three keys
    // diverge from what the admin is requesting.
    const [done] = await db.insert(tournamentsTable).values({
      organizationId: orgId,
      name: `Multi Done ${uid("t")}`,
      format: "stroke_play",
      status: "completed",
      notifyManualEntryAlerts: true,
      notifyScheduleChanges: true,
      notifyScoreCorrections: true,
    }).returning({ id: tournamentsTable.id });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({
        notifyManualEntryAlerts: false,
        notifyScheduleChanges: false,
        notifyScoreCorrections: false,
      })
      .expect(200);

    expect(res.body).toEqual({
      results: [
        { key: "notifyManualEntryAlerts", value: false, updatedCount: 2 },
        // Only t1 had schedule-changes on; t2 already matched.
        { key: "notifyScheduleChanges", value: false, updatedCount: 1 },
        { key: "notifyScoreCorrections", value: false, updatedCount: 2 },
      ],
      // Legacy top-level mirror because manual-entry was in the request.
      notifyManualEntryAlerts: false,
      updatedCount: 2,
    });

    const rows = await db
      .select({
        id: tournamentsTable.id,
        manualEntry: tournamentsTable.notifyManualEntryAlerts,
        schedule: tournamentsTable.notifyScheduleChanges,
        corrections: tournamentsTable.notifyScoreCorrections,
      })
      .from(tournamentsTable)
      .where(inArray(tournamentsTable.id, [t1.id, t2.id, done.id]));
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(t1.id)).toMatchObject({ manualEntry: false, schedule: false, corrections: false });
    expect(byId.get(t2.id)).toMatchObject({ manualEntry: false, schedule: false, corrections: false });
    // Completed event left untouched on every key.
    expect(byId.get(done.id)).toMatchObject({ manualEntry: true, schedule: true, corrections: true });
  });

  it("returns updatedCount=0 when every active tournament already matches", async () => {
    const orgId = await makeOrg("apply_noop", { notifyManualEntryAlerts: true });
    const admin = await makeUser(orgId, "org_admin");

    await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Match ${uid("t")}`, format: "stroke_play",
      status: "draft", notifyManualEntryAlerts: true,
    });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: true })
      .expect(200);
    expect(res.body).toEqual({
      results: [{ key: "notifyManualEntryAlerts", value: true, updatedCount: 0 }],
      notifyManualEntryAlerts: true,
      updatedCount: 0,
    });
  });

  it("rejects unknown keys in the apply body with 400 (Task #1673)", async () => {
    const orgId = await makeOrg("apply_unknown_key");
    const admin = await makeUser(orgId, "org_admin");

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyMadeUpSetting: false })
      .expect(400);
    expect(res.body.error).toMatch(/notifyMadeUpSetting/);
  });

  it("rejects non-boolean notifyManualEntryAlerts with 400", async () => {
    const orgId = await makeOrg("apply_bad_type");
    const admin = await makeUser(orgId, "org_admin");

    await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: "no" })
      .expect(400);
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("apply_authz");

    await request(createTestApp())
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: false })
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: false })
      .expect(403);
  });
});

describe("apply-to-tournaments writes per-tournament audit rows (Task #1674)", () => {
  it("inserts one audit row per tournament that actually flipped, with provenance", async () => {
    const orgId = await makeOrg("audit_basic", { notifyManualEntryAlerts: false });
    const admin = await makeUser(orgId, "org_admin");

    // Two divergent active tournaments + one already-matching tournament.
    // Only the two divergent ones should produce audit rows.
    const [t1] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Aud-A ${uid("t")}`, format: "stroke_play",
      status: "draft", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });
    const [t2] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Aud-B ${uid("t")}`, format: "stroke_play",
      status: "active", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });
    const [matching] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Aud-C ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: false,
    }).returning({ id: tournamentsTable.id });

    await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: false })
      .expect(200);

    const audits = await db
      .select()
      .from(tournamentNotificationOverrideAuditTable)
      .where(eq(tournamentNotificationOverrideAuditTable.organizationId, orgId));
    expect(audits.length).toBe(2);
    const byTournament = new Map(audits.map(a => [a.tournamentId, a]));
    expect(byTournament.has(t1.id)).toBe(true);
    expect(byTournament.has(t2.id)).toBe(true);
    expect(byTournament.has(matching.id)).toBe(false);
    for (const row of audits) {
      expect(row.setting).toBe("notify_manual_entry_alerts");
      expect(row.previousValue).toBe(true);
      expect(row.appliedValue).toBe(false);
      expect(row.appliedByUserId).toBe(admin.id);
      expect(row.acknowledgedAt).toBeNull();
      expect(row.restoredAt).toBeNull();
    }
  });

  it("writes no audit rows when nothing actually changed", async () => {
    const orgId = await makeOrg("audit_noop", { notifyManualEntryAlerts: true });
    const admin = await makeUser(orgId, "org_admin");

    await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Aud-Noop ${uid("t")}`, format: "stroke_play",
      status: "draft", notifyManualEntryAlerts: true,
    });

    await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: true })
      .expect(200);

    const audits = await db
      .select()
      .from(tournamentNotificationOverrideAuditTable)
      .where(eq(tournamentNotificationOverrideAuditTable.organizationId, orgId));
    expect(audits.length).toBe(0);
  });
});

describe("GET /tournaments/:id/manual-entry-override-notice (Task #1674)", () => {
  it("surfaces the latest unacknowledged override to a director who didn't trigger it", async () => {
    const orgId = await makeOrg("notice_show", { notifyManualEntryAlerts: false });
    const adminA = await makeUser(orgId, "org_admin");
    const directorB = await makeUser(orgId, "tournament_director");

    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Notice ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    // Admin A presses the bulk-apply button.
    await request(createTestApp(adminA))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: false })
      .expect(200);

    // Director B opens the tournament — should see the notice.
    const seenByDirector = await request(createTestApp(directorB))
      .get(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice`)
      .expect(200);
    expect(seenByDirector.body.notice).not.toBeNull();
    expect(seenByDirector.body.notice.setting).toBe("notifyManualEntryAlerts");
    expect(seenByDirector.body.notice.previousValue).toBe(true);
    expect(seenByDirector.body.notice.appliedValue).toBe(false);
    expect(seenByDirector.body.notice.appliedByName).toBeTruthy();

    // Admin A — the actor — should NOT see a notice for their own action.
    const seenByActor = await request(createTestApp(adminA))
      .get(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice`)
      .expect(200);
    expect(seenByActor.body.notice).toBeNull();
  });

  it("returns notice=null when there are no open audit rows", async () => {
    const orgId = await makeOrg("notice_empty");
    const admin = await makeUser(orgId, "org_admin");

    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Quiet ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    const res = await request(createTestApp(admin))
      .get(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice`)
      .expect(200);
    expect(res.body).toEqual({ notice: null });
  });
});

describe("POST /tournaments/:id/manual-entry-override-notice/restore (Task #1674)", () => {
  it("flips the tournament value back and acknowledges every open audit row", async () => {
    const orgId = await makeOrg("restore_basic", { notifyManualEntryAlerts: false });
    const adminA = await makeUser(orgId, "org_admin");
    const directorB = await makeUser(orgId, "tournament_director");

    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Restore ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    await request(createTestApp(adminA))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: false })
      .expect(200);

    const restoreRes = await request(createTestApp(directorB))
      .post(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice/restore`)
      .expect(200);
    expect(restoreRes.body).toEqual({ restored: true, notifyManualEntryAlerts: true });

    // Tournament value is back to true.
    const [row] = await db.select({ flag: tournamentsTable.notifyManualEntryAlerts })
      .from(tournamentsTable).where(eq(tournamentsTable.id, t.id));
    expect(row.flag).toBe(true);

    // Audit row is now acknowledged + restored.
    const [audit] = await db.select()
      .from(tournamentNotificationOverrideAuditTable)
      .where(eq(tournamentNotificationOverrideAuditTable.tournamentId, t.id));
    expect(audit.acknowledgedAt).not.toBeNull();
    expect(audit.restoredAt).not.toBeNull();

    // Notice now hides for the director.
    const after = await request(createTestApp(directorB))
      .get(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice`)
      .expect(200);
    expect(after.body).toEqual({ notice: null });
  });

  it("restores to the value before the EARLIEST open override when chained", async () => {
    // Director's preference was true; admin bulk-applies false (override #1),
    // then admin bulk-applies true (override #2). Restore should land on the
    // director's original true, not on the no-op intermediate false.
    const orgId = await makeOrg("restore_chain", { notifyManualEntryAlerts: false });
    const adminA = await makeUser(orgId, "org_admin");
    const directorB = await makeUser(orgId, "tournament_director");

    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Chain ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    await request(createTestApp(adminA))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: false })
      .expect(200);
    await request(createTestApp(adminA))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: true })
      .expect(200);

    // Two audit rows exist; both still open.
    const beforeRestore = await db.select()
      .from(tournamentNotificationOverrideAuditTable)
      .where(eq(tournamentNotificationOverrideAuditTable.tournamentId, t.id))
      .orderBy(asc(tournamentNotificationOverrideAuditTable.createdAt));
    expect(beforeRestore.length).toBe(2);
    expect(beforeRestore[0].previousValue).toBe(true);
    expect(beforeRestore[1].previousValue).toBe(false);

    const restoreRes = await request(createTestApp(directorB))
      .post(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice/restore`)
      .expect(200);
    // Restored to the EARLIEST previousValue → true.
    expect(restoreRes.body).toEqual({ restored: true, notifyManualEntryAlerts: true });

    // Both audit rows acknowledged.
    const afterRestore = await db.select()
      .from(tournamentNotificationOverrideAuditTable)
      .where(eq(tournamentNotificationOverrideAuditTable.tournamentId, t.id));
    expect(afterRestore.every(r => r.acknowledgedAt !== null)).toBe(true);
  });

  it("returns restored=false when there is nothing to undo", async () => {
    const orgId = await makeOrg("restore_empty");
    const admin = await makeUser(orgId, "org_admin");

    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Empty ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice/restore`)
      .expect(200);
    expect(res.body).toEqual({ restored: false, notifyManualEntryAlerts: null });
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("restore_authz");
    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Authz ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    await request(createTestApp())
      .post(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice/restore`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .post(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice/restore`)
      .expect(403);
  });
});

describe("POST /tournaments/:id/manual-entry-override-notice/dismiss (Task #2089)", () => {
  it("acknowledges every open audit row WITHOUT changing the tournament value", async () => {
    const orgId = await makeOrg("dismiss_basic", { notifyManualEntryAlerts: false });
    const adminA = await makeUser(orgId, "org_admin");
    const directorB = await makeUser(orgId, "tournament_director");

    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `Dismiss ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    await request(createTestApp(adminA))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: false })
      .expect(200);

    const dismissRes = await request(createTestApp(directorB))
      .post(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice/dismiss`)
      .expect(200);
    expect(dismissRes.body).toEqual({ dismissed: true });

    // Tournament value is UNCHANGED (still the bulk-applied false).
    const [row] = await db.select({ flag: tournamentsTable.notifyManualEntryAlerts })
      .from(tournamentsTable).where(eq(tournamentsTable.id, t.id));
    expect(row.flag).toBe(false);

    // Audit row is acknowledged but NOT restored — audit reports can
    // still distinguish dismissed-vs-restored using restoredAt.
    const [audit] = await db.select()
      .from(tournamentNotificationOverrideAuditTable)
      .where(eq(tournamentNotificationOverrideAuditTable.tournamentId, t.id));
    expect(audit.acknowledgedAt).not.toBeNull();
    expect(audit.restoredAt).toBeNull();

    // Notice now hides for the director.
    const after = await request(createTestApp(directorB))
      .get(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice`)
      .expect(200);
    expect(after.body).toEqual({ notice: null });
  });

  it("acknowledges every open row when multiple overrides are stacked", async () => {
    const orgId = await makeOrg("dismiss_chain", { notifyManualEntryAlerts: false });
    const adminA = await makeUser(orgId, "org_admin");
    const directorB = await makeUser(orgId, "tournament_director");

    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `DismissChain ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    await request(createTestApp(adminA))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: false })
      .expect(200);
    await request(createTestApp(adminA))
      .post(`/api/organizations/${orgId}/notification-defaults/apply-to-tournaments`)
      .send({ notifyManualEntryAlerts: true })
      .expect(200);

    await request(createTestApp(directorB))
      .post(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice/dismiss`)
      .expect(200);

    const rows = await db.select()
      .from(tournamentNotificationOverrideAuditTable)
      .where(eq(tournamentNotificationOverrideAuditTable.tournamentId, t.id));
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.acknowledgedAt !== null)).toBe(true);
    expect(rows.every(r => r.restoredAt === null)).toBe(true);
  });

  it("returns dismissed=false when there is nothing to acknowledge", async () => {
    const orgId = await makeOrg("dismiss_empty");
    const admin = await makeUser(orgId, "org_admin");

    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `DismissEmpty ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice/dismiss`)
      .expect(200);
    expect(res.body).toEqual({ dismissed: false });
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("dismiss_authz");
    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, name: `DismissAuthz ${uid("t")}`, format: "stroke_play",
      status: "upcoming", notifyManualEntryAlerts: true,
    }).returning({ id: tournamentsTable.id });

    await request(createTestApp())
      .post(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice/dismiss`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .post(`/api/organizations/${orgId}/tournaments/${t.id}/manual-entry-override-notice/dismiss`)
      .expect(403);
  });
});

describe("POST /tournaments — inherits org-wide notifyManualEntryAlerts (Task #1188)", () => {
  it("seeds new tournament with notifyManualEntryAlerts=false when the org has muted the alert", async () => {
    const orgId = await makeOrg("inherit_off", { notifyManualEntryAlerts: false });
    const admin = await makeUser(orgId, "org_admin");

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/tournaments`)
      .send({
        name: `Muted-Inherit ${uid("t")}`,
        format: "stroke_play",
      })
      .expect(201);

    expect(res.body.notifyManualEntryAlerts).toBe(false);

    // And the row in the DB matches — proves we're not just echoing
    // the request body.
    const [row] = await db.select({ flag: tournamentsTable.notifyManualEntryAlerts })
      .from(tournamentsTable).where(eq(tournamentsTable.id, res.body.id));
    expect(row.flag).toBe(false);
  });

  it("seeds new tournament with notifyManualEntryAlerts=true when the org has the alert on", async () => {
    const orgId = await makeOrg("inherit_on", { notifyManualEntryAlerts: true });
    const admin = await makeUser(orgId, "org_admin");

    const res = await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/tournaments`)
      .send({
        name: `On-Inherit ${uid("t")}`,
        format: "stroke_play",
      })
      .expect(201);

    expect(res.body.notifyManualEntryAlerts).toBe(true);

    const [row] = await db.select({ flag: tournamentsTable.notifyManualEntryAlerts })
      .from(tournamentsTable).where(eq(tournamentsTable.id, res.body.id));
    expect(row.flag).toBe(true);
  });
});
