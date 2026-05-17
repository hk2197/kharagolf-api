/**
 * Analytics events dashboard endpoints (Task #1141 — adds coverage to Task #982).
 *
 * Routes under test (mounted under /api/organizations/:orgId/analytics):
 *   GET /events/summary  — totals + per-day series, org-scoped, range/name filters
 *   GET /events/raw      — paginated raw rows, super-admin only
 *   GET /events/export   — CSV download, org-scoped, payload-aware escaping
 *
 * What this test guards against (regressions that would otherwise be silent):
 *   - cross-org leakage on summary / raw / export (other org's rows must not
 *     appear regardless of the caller's effective org).
 *   - date-range filter ignored (out-of-window rows leaking into totals/series).
 *   - event-name filter ignored (`events=foo,bar` should narrow the result set).
 *   - super-admin gating on /events/raw downgraded to org_admin (would expose
 *     cross-org raw payloads to club admins).
 *   - CSV escaping breaking when payloads contain commas, double-quotes, or
 *     newlines — the escape helper must wrap such fields in quotes and double
 *     up internal quotes per RFC-4180.
 *
 * Uses the real PostgreSQL database (DATABASE_URL). Test data is created in
 * beforeAll and cleaned in afterAll — orgs cascade to analytics_events, so
 * we only need to clear the bridge `app_users` rows manually.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  analyticsEventsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let adminUserId: number;
let superUserId: number;
let playerUserId: number;

let adminUser: TestUser;
let superUser: TestUser;
let playerUser: TestUser;

let adminApp: ReturnType<typeof createTestApp>;
let superApp: ReturnType<typeof createTestApp>;
let playerApp: ReturnType<typeof createTestApp>;
let anonApp: ReturnType<typeof createTestApp>;

// Reference dates: window is the 10-day band [WIN_FROM, WIN_TO]. Out-of-window
// rows are placed comfortably outside on either side.
const NOW = new Date("2026-04-15T12:00:00.000Z");
const WIN_FROM = new Date("2026-04-10T00:00:00.000Z");
const WIN_TO = new Date("2026-04-20T00:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-03-01T00:00:00.000Z");
const AFTER_WINDOW = new Date("2026-05-15T00:00:00.000Z");

beforeAll(async () => {
  const stamp = Date.now();

  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_AnalyticsEventsDash_A_${stamp}`,
    slug: `test-aed-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_AnalyticsEventsDash_B_${stamp}`,
    slug: `test-aed-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-aed-admin-${stamp}`,
    username: `aed_admin_${stamp}`,
    email: `aed_admin_${stamp}@example.com`,
    displayName: "AED Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [superRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-aed-super-${stamp}`,
    username: `aed_super_${stamp}`,
    email: `aed_super_${stamp}@example.com`,
    displayName: "AED Super",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superUserId = superRow.id;

  const [playerRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-aed-player-${stamp}`,
    username: `aed_player_${stamp}`,
    email: `aed_player_${stamp}@example.com`,
    displayName: "AED Player",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerUserId = playerRow.id;

  // Org A — in-window rows across event names + occurrence days.
  //   player_login          : 2 rows on Apr 11, 1 row on Apr 12
  //   tournament_registration: 1 row on Apr 12
  //   tee_booking_created   : 1 row on Apr 13
  //   scorecard_submitted   : 1 row on Apr 13 with tricky CSV payload
  //   notification_opened   : Apr 11 (mobile surface = push),
  //                           Apr 12 (channel=push payload = push),
  //                           Apr 13 (api surface, no channel = in-app)
  //                           — exercises the per-channel breakdown
  //                           introduced in Task #1563.
  // Plus one out-of-window row (Mar 1) and one post-window row (May 15) that
  // must be excluded from the default-range queries we build below.
  await db.insert(analyticsEventsTable).values([
    {
      eventName: "player_login", organizationId: orgAId, userId: playerUserId,
      surface: "web", payload: { ip: "1.1.1.1" },
      occurredAt: new Date("2026-04-11T08:00:00.000Z"),
    },
    {
      eventName: "player_login", organizationId: orgAId, userId: playerUserId,
      surface: "web", payload: { ip: "2.2.2.2" },
      occurredAt: new Date("2026-04-11T09:00:00.000Z"),
    },
    {
      eventName: "player_login", organizationId: orgAId, userId: playerUserId,
      surface: "mobile", payload: {},
      occurredAt: new Date("2026-04-12T08:00:00.000Z"),
    },
    {
      eventName: "tournament_registration", organizationId: orgAId, userId: playerUserId,
      surface: "web", payload: { tournamentId: 99 },
      occurredAt: new Date("2026-04-12T10:00:00.000Z"),
    },
    {
      eventName: "tee_booking_created", organizationId: orgAId, userId: playerUserId,
      surface: "api", payload: { slot: "07:30" },
      occurredAt: new Date("2026-04-13T11:00:00.000Z"),
    },
    {
      // Tricky row exercising CSV escaping. The payload is jsonb, so it is
      // JSON-stringified before CSV-escaping (quotes → \", newlines → \n),
      // then CSV-wrapped + double-quoted. The requestId is a plain text
      // column and is the cleanest way to smuggle a *real* embedded
      // newline + literal quote + comma into the CSV output.
      eventName: "scorecard_submitted", organizationId: orgAId, userId: playerUserId,
      surface: "watch",
      payload: { note: 'has "quotes", a comma\nand newline', extra: "ok" },
      requestId: 'req"with"quotes,and-comma\nand-newline',
      occurredAt: new Date("2026-04-13T12:00:00.000Z"),
    },
    // notification_opened — Task #1563: per-channel breakdown.
    // Push channel can be inferred from EITHER surface=mobile OR
    // payload.channel='push'; both must be classified as "push" so the
    // dashboard's totals reconcile with what handicap-cases / portal push
    // actually emit today.
    {
      eventName: "notification_opened", organizationId: orgAId, userId: playerUserId,
      surface: "mobile",
      payload: { messageId: "abc123", pushType: "handicap_case_update", channel: "push" },
      occurredAt: new Date("2026-04-11T10:00:00.000Z"),
    },
    {
      eventName: "notification_opened", organizationId: orgAId, userId: playerUserId,
      // surface is "api" but payload.channel is "push" — still a push open.
      surface: "api",
      payload: { channel: "push", pushType: "tournament_reminder" },
      occurredAt: new Date("2026-04-12T11:00:00.000Z"),
    },
    {
      eventName: "notification_opened", organizationId: orgAId, userId: playerUserId,
      // No surface=mobile and no payload.channel — classic in-app handicap
      // notification opened on the web/portal (handicap-cases.ts).
      surface: "api",
      payload: { notificationId: 7, kind: "handicap_case", mode: "single" },
      occurredAt: new Date("2026-04-13T13:00:00.000Z"),
    },
    // Out-of-window rows (must NOT appear in summary/raw/export under default range).
    {
      eventName: "player_login", organizationId: orgAId, userId: playerUserId,
      surface: "web", payload: {},
      occurredAt: BEFORE_WINDOW,
    },
    {
      eventName: "player_login", organizationId: orgAId, userId: playerUserId,
      surface: "web", payload: {},
      occurredAt: AFTER_WINDOW,
    },
  ]);

  // Org B — must be invisible to org A's admin and to org A's export/raw/
  // summary calls. Use a recognisable surface so we can scan responses for
  // accidental leakage.
  await db.insert(analyticsEventsTable).values([
    {
      eventName: "player_login", organizationId: orgBId, userId: null,
      surface: "leaked-from-b", payload: { secret: "do-not-leak" },
      occurredAt: new Date("2026-04-12T08:00:00.000Z"),
    },
    {
      eventName: "payment_settled", organizationId: orgBId, userId: null,
      surface: "leaked-from-b", payload: { amount: 999 },
      occurredAt: new Date("2026-04-13T08:00:00.000Z"),
    },
  ]);

  adminUser = { id: adminUserId, username: `aed_admin_${stamp}`, role: "org_admin", organizationId: orgAId };
  superUser = { id: superUserId, username: `aed_super_${stamp}`, role: "super_admin" };
  playerUser = { id: playerUserId, username: `aed_player_${stamp}`, role: "player", organizationId: orgAId };

  adminApp = createTestApp(adminUser);
  superApp = createTestApp(superUser);
  playerApp = createTestApp(playerUser);
  anonApp = createTestApp(undefined);
});

afterAll(async () => {
  // analytics_events / club_members / etc. cascade on organization delete,
  // but app_users have onDelete:no-action against organizations.
  for (const uid of [adminUserId, superUserId, playerUserId]) {
    if (uid) await db.delete(appUsersTable).where(eq(appUsersTable.id, uid));
  }
  for (const oid of [orgAId, orgBId]) {
    if (oid) await db.delete(organizationsTable).where(eq(organizationsTable.id, oid));
  }
});

const BASE = (orgId: number) => `/api/organizations/${orgId}/analytics`;
const RANGE = `from=${WIN_FROM.toISOString()}&to=${WIN_TO.toISOString()}`;

describe("GET /analytics/events/summary", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(anonApp).get(`${BASE(orgAId)}/events/summary?${RANGE}`);
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const res = await request(playerApp).get(`${BASE(orgAId)}/events/summary?${RANGE}`);
    expect(res.status).toBe(403);
  });

  it("returns org-scoped totals + per-day series within the date range", async () => {
    const res = await request(adminApp).get(`${BASE(orgAId)}/events/summary?${RANGE}`);
    expect(res.status).toBe(200);

    // Totals only count in-window org-A rows. The two out-of-window
    // player_login rows (Mar 1 + May 15) must be excluded.
    expect(res.body.totals).toMatchObject({
      player_login: 3,
      tournament_registration: 1,
      tee_booking_created: 1,
      scorecard_submitted: 1,
      payment_settled: 0,
      // 3 in-window notification_opened rows — see beforeAll seed.
      notification_opened: 3,
    });

    const series: Array<{ day: string } & Record<string, number>> = res.body.series;
    const byDay = Object.fromEntries(series.map((r) => [r.day, r]));
    expect(byDay["2026-04-11"]?.player_login).toBe(2);
    expect(byDay["2026-04-12"]?.player_login).toBe(1);
    expect(byDay["2026-04-12"]?.tournament_registration).toBe(1);
    expect(byDay["2026-04-13"]?.tee_booking_created).toBe(1);
    expect(byDay["2026-04-13"]?.scorecard_submitted).toBe(1);
    // Out-of-window days must not appear at all.
    expect(byDay["2026-03-01"]).toBeUndefined();
    expect(byDay["2026-05-15"]).toBeUndefined();
  });

  it("does not leak cross-org events into another org's totals", async () => {
    // Super-admin querying org A must see exactly org A's totals — none of
    // org B's player_login / payment_settled rows.
    const res = await request(superApp).get(`${BASE(orgAId)}/events/summary?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.totals.player_login).toBe(3);
    expect(res.body.totals.payment_settled).toBe(0);
  });

  it("narrows totals when the events filter is applied", async () => {
    const res = await request(adminApp)
      .get(`${BASE(orgAId)}/events/summary?${RANGE}&events=player_login,tee_booking_created`);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual(["player_login", "tee_booking_created"]);
    // Only the requested event names appear in totals — the others are not
    // even pre-seeded as zero buckets.
    expect(Object.keys(res.body.totals).sort()).toEqual(
      ["player_login", "tee_booking_created"].sort(),
    );
    expect(res.body.totals.player_login).toBe(3);
    expect(res.body.totals.tee_booking_created).toBe(1);
  });

  // Task #1563 — `notification_opened` is fired from two very different
  // sources (native push opens via portal/notifications/push-opened, and
  // in-app handicap notification opens). The summary endpoint must split
  // the total into push vs in-app so admins can tell channels apart on the
  // analytics dashboard. push + in_app must equal the combined total.
  it("breaks notification_opened into push vs in-app channels", async () => {
    const res = await request(adminApp).get(`${BASE(orgAId)}/events/summary?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.totals.notification_opened).toBe(3);

    const breakdown = res.body.breakdowns?.notification_opened;
    expect(breakdown).toBeDefined();
    // 2 push (one with surface=mobile, one with payload.channel='push'),
    // 1 in-app (surface=api, no payload.channel).
    expect(breakdown.totals).toEqual({ push: 2, in_app: 1 });
    // Reconciliation invariant: push + in_app must equal combined total.
    expect(breakdown.totals.push + breakdown.totals.in_app).toBe(
      res.body.totals.notification_opened,
    );

    const byDay = Object.fromEntries(
      (breakdown.series as Array<{ day: string; push: number; in_app: number }>)
        .map((r) => [r.day, r]),
    );
    expect(byDay["2026-04-11"]).toEqual({ day: "2026-04-11", push: 1, in_app: 0 });
    expect(byDay["2026-04-12"]).toEqual({ day: "2026-04-12", push: 1, in_app: 0 });
    expect(byDay["2026-04-13"]).toEqual({ day: "2026-04-13", push: 0, in_app: 1 });
  });

  // Task #1948 — admins can independently toggle Push and In-App
  // channels on the dashboard. The summary endpoint must accept an
  // optional `channel` filter and scope the notification_opened totals,
  // series, and breakdown payload to the selected channel(s) only. When
  // both channels are selected (or the filter is omitted), the response
  // must be byte-for-byte identical to the pre-#1948 default.
  describe("channel filter (Task #1948)", () => {
    it("scopes notification_opened to push when channel=push", async () => {
      const res = await request(adminApp)
        .get(`${BASE(orgAId)}/events/summary?${RANGE}&channel=push`);
      expect(res.status).toBe(200);
      // Combined total now equals the push-only count (2 of the 3 rows).
      expect(res.body.totals.notification_opened).toBe(2);

      const breakdown = res.body.breakdowns?.notification_opened;
      expect(breakdown).toBeDefined();
      expect(breakdown.totals).toEqual({ push: 2, in_app: 0 });
      // The Apr-13 in-app-only day must drop out of the breakdown
      // series since it has 0 push events and no other event keeping
      // it in the bucket.
      const days = (breakdown.series as Array<{ day: string; push: number; in_app: number }>)
        .map((r) => r.day);
      expect(days).toEqual(["2026-04-11", "2026-04-12"]);

      // Combined day-by-day series for notification_opened reflects
      // push-only counts. Apr-13 has other events on it (tee_booking,
      // scorecard) so the day still appears, but notification_opened=0.
      const byDay = Object.fromEntries(
        (res.body.series as Array<{ day: string } & Record<string, number>>)
          .map((r) => [r.day, r]),
      );
      expect(byDay["2026-04-11"]?.notification_opened).toBe(1);
      expect(byDay["2026-04-12"]?.notification_opened).toBe(1);
      expect(byDay["2026-04-13"]?.notification_opened).toBe(0);
    });

    it("scopes notification_opened to in-app when channel=in_app", async () => {
      const res = await request(adminApp)
        .get(`${BASE(orgAId)}/events/summary?${RANGE}&channel=in_app`);
      expect(res.status).toBe(200);
      expect(res.body.totals.notification_opened).toBe(1);

      const breakdown = res.body.breakdowns?.notification_opened;
      expect(breakdown).toBeDefined();
      expect(breakdown.totals).toEqual({ push: 0, in_app: 1 });

      const byDay = Object.fromEntries(
        (res.body.series as Array<{ day: string } & Record<string, number>>)
          .map((r) => [r.day, r]),
      );
      expect(byDay["2026-04-11"]?.notification_opened).toBe(0);
      expect(byDay["2026-04-12"]?.notification_opened).toBe(0);
      expect(byDay["2026-04-13"]?.notification_opened).toBe(1);
    });

    it("matches the no-filter response when both channels are selected", async () => {
      const baseline = await request(adminApp)
        .get(`${BASE(orgAId)}/events/summary?${RANGE}`);
      const both = await request(adminApp)
        .get(`${BASE(orgAId)}/events/summary?${RANGE}&channel=push,in_app`);
      expect(both.status).toBe(200);
      // The reconciliation invariant from Task #1563 still holds.
      expect(both.body.totals.notification_opened).toBe(
        baseline.body.totals.notification_opened,
      );
      expect(both.body.breakdowns).toEqual(baseline.body.breakdowns);
    });

    it("ignores invalid channel values and falls back to both", async () => {
      const res = await request(adminApp)
        .get(`${BASE(orgAId)}/events/summary?${RANGE}&channel=foo,bar`);
      expect(res.status).toBe(200);
      // Invalid values are stripped — falls back to "both" so admins
      // never see an empty dashboard from a typo in a saved URL.
      expect(res.body.totals.notification_opened).toBe(3);
      expect(res.body.breakdowns?.notification_opened?.totals)
        .toEqual({ push: 2, in_app: 1 });
    });
  });

  it("omits the notification_opened breakdown when the event is filtered out", async () => {
    // When the admin un-ticks notification_opened the API server should
    // skip the extra per-channel query — the dashboard has no use for the
    // breakdown payload it cannot render.
    const res = await request(adminApp)
      .get(`${BASE(orgAId)}/events/summary?${RANGE}&events=player_login`);
    expect(res.status).toBe(200);
    expect(res.body.breakdowns).toBeUndefined();
  });

  it("returns zero totals when the date range excludes all events", async () => {
    const empty = "from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z";
    const res = await request(adminApp).get(`${BASE(orgAId)}/events/summary?${empty}`);
    expect(res.status).toBe(200);
    expect(Object.values(res.body.totals as Record<string, number>).every((n) => n === 0)).toBe(true);
    expect(res.body.series).toEqual([]);
  });
});

describe("GET /analytics/events/raw", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(anonApp).get(`${BASE(orgAId)}/events/raw?${RANGE}`);
    expect(res.status).toBe(401);
  });

  it("rejects org-admins with 403 — super-admin only", async () => {
    const res = await request(adminApp).get(`${BASE(orgAId)}/events/raw?${RANGE}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/super.?admin/i);
  });

  it("rejects regular members with 403", async () => {
    const res = await request(playerApp).get(`${BASE(orgAId)}/events/raw?${RANGE}`);
    expect(res.status).toBe(403);
  });

  it("returns paginated org-scoped rows for super-admins", async () => {
    const res = await request(superApp).get(`${BASE(orgAId)}/events/raw?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(9); // 6 base + 3 notification_opened in-window org-A rows
    expect(res.body.rows.length).toBe(9);
    // No org-B rows ever appear in an org-A scoped raw query.
    for (const row of res.body.rows as Array<{ organizationId: number; surface: string }>) {
      expect(row.organizationId).toBe(orgAId);
      expect(row.surface).not.toBe("leaked-from-b");
    }
  });

  it("respects event-name filter on the raw view", async () => {
    const res = await request(superApp)
      .get(`${BASE(orgAId)}/events/raw?${RANGE}&events=player_login`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    for (const row of res.body.rows as Array<{ eventName: string }>) {
      expect(row.eventName).toBe("player_login");
    }
  });
});

describe("GET /analytics/events/export", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(anonApp).get(`${BASE(orgAId)}/events/export?${RANGE}`);
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const res = await request(playerApp).get(`${BASE(orgAId)}/events/export?${RANGE}`);
    expect(res.status).toBe(403);
  });

  it("returns a CSV with the expected headers and only org-scoped rows", async () => {
    const res = await request(adminApp).get(`${BASE(orgAId)}/events/export?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment;.*\.csv/);

    const text = res.text;
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "id,occurred_at,event_name,organization_id,user_id,surface,request_id,payload,user_display_name,user_email",
    );
    // Header + 9 in-window org-A rows (6 base + 3 notification_opened) + 1
    // extra physical line caused by the requestId column on the
    // scorecard_submitted row carrying an embedded newline (RFC-4180
    // quoted field).
    expect(lines.length).toBe(1 + 9 + 1);
    // Org-B's identifying surface must not leak into an org-A export.
    expect(text).not.toMatch(/leaked-from-b/);
    expect(text).not.toMatch(/do-not-leak/);
  });

  it("escapes commas, double-quotes, and newlines in CSV fields", async () => {
    const res = await request(adminApp)
      .get(`${BASE(orgAId)}/events/export?${RANGE}&events=scorecard_submitted`);
    expect(res.status).toBe(200);
    const text = res.text;

    // The requestId column carries a real embedded newline + quotes +
    // comma. Per RFC-4180 the field must be wrapped in double quotes,
    // every internal `"` doubled to `""`, and the embedded newline kept
    // verbatim inside the quoted field. The resulting CSV is therefore
    // NOT "one logical row per physical line" — splitting on \n yields
    // an extra chunk for the embedded newline.
    expect(text).toContain(
      ',"req""with""quotes,and-comma\nand-newline",',
    );
    const totalChunks = text.split("\n").length;
    expect(totalChunks).toBe(1 /* header */ + 1 /* row */ + 1 /* embedded \n */);

    // The payload column is jsonb → JSON.stringify() is applied before
    // CSV escaping, so each `"` inside the JSON literal (already itself
    // escaped to `\"` by JSON.stringify) becomes `\""` after CSV doubles
    // every quote. Newlines inside the payload value were JSON-encoded
    // to the literal two-character sequence `\n`, so they do NOT add
    // further physical newlines to the CSV.
    expect(text).toContain('\\""quotes\\""');
    expect(text).toContain('has \\""quotes\\"", a comma\\nand newline');
  });

  it("excludes events outside the requested date range from the export", async () => {
    // Window that includes only the BEFORE_WINDOW row (single player_login).
    const range = "from=2026-02-01T00:00:00.000Z&to=2026-03-31T00:00:00.000Z";
    const res = await request(adminApp).get(`${BASE(orgAId)}/events/export?${range}`);
    expect(res.status).toBe(200);
    const lines = res.text.split("\n");
    expect(lines.length).toBe(1 /* header */ + 1 /* the single Mar-1 row */);
    expect(lines[1]).toContain(",player_login,");
  });
});
