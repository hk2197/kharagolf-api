/**
 * Integration tests: GET /organizations/:orgId/marketing/bounce-sources
 *
 * Task #1557 — "Bounce-source breakdown chart in the marketing dashboard".
 * Covers auth, org scoping, the 30-day window, the top-5 + "no source recorded"
 * bucket shape, and that unrelated reasons (unsubscribe, manual) are excluded
 * so the chart stays focused on actual deliverability problems.
 *
 * Task #1943 — "Spam complaints by source" sibling chart, served by the same
 * endpoint via `?reason=spam_complaint`. Tests below pin that bounces and
 * spam complaints stay in their own buckets and that the default behaviour
 * (no `reason` param) is still bounces.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  emailSuppressionsTable,
  marketingCampaignsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let adminUserId: number;
let outsiderUserId: number;
let admin: TestUser;
let outsider: TestUser;
let bAdmin: TestUser;

const createdSuppressionIds: number[] = [];
const createdCampaignIds: number[] = [];

async function makeCampaign(orgId: number, name: string): Promise<number> {
  const [row] = await db.insert(marketingCampaignsTable).values({
    organizationId: orgId,
    name,
    bodyHtml: "<p>x</p>",
  }).returning({ id: marketingCampaignsTable.id });
  createdCampaignIds.push(row.id);
  return row.id;
}

async function makeSuppression(opts: {
  orgId: number;
  email: string;
  reason?: string;
  triggeredByCampaignId?: number | null;
  triggeredByFlow?: string | null;
  createdAt?: Date;
}): Promise<number> {
  const values: Record<string, unknown> = {
    organizationId: opts.orgId,
    email: opts.email.toLowerCase(),
    reason: opts.reason ?? "bounced",
    bounceType: opts.reason && opts.reason !== "bounced" ? null : "BadMailbox",
    triggeredByCampaignId: opts.triggeredByCampaignId ?? null,
    triggeredByFlow: opts.triggeredByFlow ?? null,
  };
  if (opts.createdAt) values.createdAt = opts.createdAt;
  const [row] = await db.insert(emailSuppressionsTable).values(values as typeof emailSuppressionsTable.$inferInsert)
    .returning({ id: emailSuppressionsTable.id });
  createdSuppressionIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const stamp = uid("bounce-src");
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_BounceSrc_A_${stamp}`,
    slug: `test-bouncesrc-a-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_BounceSrc_B_${stamp}`,
    slug: `test-bouncesrc-b-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `bouncesrc-admin-${stamp}`,
    username: `bouncesrc_admin_${stamp}`,
    email: `bouncesrc_admin_${stamp}@example.com`,
    displayName: "BounceSrc Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [outsiderRow] = await db.insert(appUsersTable).values({
    replitUserId: `bouncesrc-outsider-${stamp}`,
    username: `bouncesrc_outsider_${stamp}`,
    email: `bouncesrc_outsider_${stamp}@example.com`,
    displayName: "BounceSrc Outsider",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = outsiderRow.id;

  admin = { id: adminUserId, username: `bouncesrc_admin_${stamp}`, displayName: "BounceSrc Admin", role: "org_admin", organizationId: orgAId };
  outsider = { id: outsiderUserId, username: `bouncesrc_outsider_${stamp}`, displayName: "BounceSrc Outsider", role: "player", organizationId: orgAId };
  bAdmin = { ...admin, organizationId: orgBId };
});

afterAll(async () => {
  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
  }
  if (createdCampaignIds.length) {
    await db.delete(marketingCampaignsTable).where(inArray(marketingCampaignsTable.id, createdCampaignIds));
  }
  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, [adminUserId, outsiderUserId].filter(Boolean) as number[]));
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (outsiderUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderUserId));
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
    createdSuppressionIds.length = 0;
  }
  if (createdCampaignIds.length) {
    await db.delete(marketingCampaignsTable).where(inArray(marketingCampaignsTable.id, createdCampaignIds));
    createdCampaignIds.length = 0;
  }
});

const URL = (orgId: number, qs = "") =>
  `/api/organizations/${orgId}/marketing/bounce-sources${qs}`;

describe("GET /marketing/bounce-sources — auth", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(401);
  });

  it("rejects non-admin players with 403", async () => {
    const app = createTestApp(outsider);
    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(403);
  });

  it("rejects admins from a different org with 403", async () => {
    const app = createTestApp(bAdmin);
    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(403);
  });
});

describe("GET /marketing/bounce-sources — empty state", () => {
  it("returns zero counts and an empty source list when no bounces exist", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.total).toBe(0);
    expect(res.body.sources).toEqual([]);
    expect(res.body.truncated).toBe(false);
  });
});

describe("GET /marketing/bounce-sources — aggregation", () => {
  it("groups bounces by campaign and flow with friendly campaign labels", async () => {
    const app = createTestApp(admin);
    const cId = await makeCampaign(orgAId, "Spring Open Promo");

    // 3 bounces from a single campaign
    for (let i = 0; i < 3; i++) {
      await makeSuppression({ orgId: orgAId, email: `c-${i}-${uid()}@example.com`, triggeredByCampaignId: cId });
    }
    // 2 bounces from dues_receipt flow
    for (let i = 0; i < 2; i++) {
      await makeSuppression({ orgId: orgAId, email: `f-${i}-${uid()}@example.com`, triggeredByFlow: "dues_receipt" });
    }
    // 1 bounce from password_reset flow
    await makeSuppression({ orgId: orgAId, email: `pw-${uid()}@example.com`, triggeredByFlow: "password_reset" });
    // 4 bounces with no attribution
    for (let i = 0; i < 4; i++) {
      await makeSuppression({ orgId: orgAId, email: `none-${i}-${uid()}@example.com` });
    }

    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(10);

    const bySrc = Object.fromEntries(res.body.sources.map((s: { key: string; count: number; label: string; campaignId: number | null; flow: string | null }) => [s.key, s]));
    expect(bySrc[`campaign:${cId}`]).toMatchObject({ count: 3, label: "Spring Open Promo", campaignId: cId, flow: null });
    expect(bySrc["flow:dues_receipt"]).toMatchObject({ count: 2, flow: "dues_receipt", campaignId: null });
    expect(bySrc["flow:password_reset"]).toMatchObject({ count: 1, flow: "password_reset" });
    expect(bySrc["none"]).toMatchObject({ count: 4, label: "No source recorded" });

    // Sorted desc by count for the named buckets, with "none" last.
    const named = res.body.sources.filter((s: { key: string }) => s.key !== "none");
    const counts = named.map((s: { count: number }) => s.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(res.body.sources[res.body.sources.length - 1].key).toBe("none");
  });

  it("excludes non-bounce reasons (unsubscribed, spam_complaint, manual) by default", async () => {
    const app = createTestApp(admin);
    await makeSuppression({ orgId: orgAId, email: `b-${uid()}@example.com`, triggeredByFlow: "campaign" });
    await makeSuppression({ orgId: orgAId, email: `u-${uid()}@example.com`, reason: "unsubscribed", triggeredByFlow: "campaign" });
    await makeSuppression({ orgId: orgAId, email: `s-${uid()}@example.com`, reason: "spam_complaint", triggeredByFlow: "campaign" });
    await makeSuppression({ orgId: orgAId, email: `m-${uid()}@example.com`, reason: "manual" });

    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("bounced");
    expect(res.body.total).toBe(1);
    expect(res.body.sources.length).toBe(1);
    expect(res.body.sources[0].key).toBe("flow:campaign");
  });

  it("scopes results to the requesting org", async () => {
    const app = createTestApp(admin);
    await makeSuppression({ orgId: orgAId, email: `a-${uid()}@example.com`, triggeredByFlow: "dues_receipt" });
    // Other-org noise that must NOT show up
    await makeSuppression({ orgId: orgBId, email: `b-${uid()}@example.com`, triggeredByFlow: "dues_receipt" });
    await makeSuppression({ orgId: orgBId, email: `b2-${uid()}@example.com`, triggeredByFlow: "dues_receipt" });

    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.sources).toEqual([
      expect.objectContaining({ key: "flow:dues_receipt", count: 1 }),
    ]);
  });

  it("ignores bounces older than the window", async () => {
    const app = createTestApp(admin);
    const recent = new Date();
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    await makeSuppression({ orgId: orgAId, email: `recent-${uid()}@example.com`, triggeredByFlow: "dues_receipt", createdAt: recent });
    await makeSuppression({ orgId: orgAId, email: `old-${uid()}@example.com`, triggeredByFlow: "dues_receipt", createdAt: old });

    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.total).toBe(1);
    expect(res.body.sources[0].count).toBe(1);
  });

  it("respects a custom days param within bounds", async () => {
    const app = createTestApp(admin);
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await makeSuppression({ orgId: orgAId, email: `old-${uid()}@example.com`, triggeredByFlow: "dues_receipt", createdAt: old });

    const within = await request(app).get(URL(orgAId, "?days=60"));
    expect(within.body.windowDays).toBe(60);
    expect(within.body.total).toBe(1);

    // Out-of-bounds value falls back to 30
    const fallback = await request(app).get(URL(orgAId, "?days=99999"));
    expect(fallback.body.windowDays).toBe(30);
    expect(fallback.body.total).toBe(0);
  });

  it("keeps only the top 5 named sources and flags truncated", async () => {
    const app = createTestApp(admin);
    // 7 distinct flows; counts arranged so the smallest two should be dropped.
    const flows = [
      ["payment_receipt", 9],
      ["dues_receipt", 8],
      ["password_reset", 7],
      ["member_invite", 6],
      ["tournament_invite", 5],
      ["league_invite", 4], // dropped
      ["email_verification", 3], // dropped
    ] as const;
    for (const [flow, n] of flows) {
      for (let i = 0; i < n; i++) {
        await makeSuppression({ orgId: orgAId, email: `${flow}-${i}-${uid()}@example.com`, triggeredByFlow: flow });
      }
    }
    // Plus a couple of "no source" rows to confirm the bucket survives truncation.
    await makeSuppression({ orgId: orgAId, email: `n1-${uid()}@example.com` });
    await makeSuppression({ orgId: orgAId, email: `n2-${uid()}@example.com` });

    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);

    const named = res.body.sources.filter((s: { key: string }) => s.key !== "none");
    expect(named.length).toBe(5);
    const top5Keys = named.map((s: { key: string }) => s.key);
    expect(top5Keys).toEqual([
      "flow:payment_receipt",
      "flow:dues_receipt",
      "flow:password_reset",
      "flow:member_invite",
      "flow:tournament_invite",
    ]);
    const noneRow = res.body.sources.find((s: { key: string }) => s.key === "none");
    expect(noneRow).toMatchObject({ count: 2 });

    // Total still reflects everything, not just the top 5
    expect(res.body.total).toBe(9 + 8 + 7 + 6 + 5 + 4 + 3 + 2);
  });

  it("falls back to 'Campaign #<id>' when the campaign row no longer exists", async () => {
    const app = createTestApp(admin);
    const cId = await makeCampaign(orgAId, "Will be deleted");
    await makeSuppression({ orgId: orgAId, email: `dc-${uid()}@example.com`, triggeredByCampaignId: cId });
    // Delete the campaign — the suppression's FK is ON DELETE SET NULL,
    // which means triggered_by_campaign_id becomes null and the row should
    // therefore land in the "none" bucket. This test pins that behaviour
    // so we'd notice if the FK action ever changed under us.
    await db.delete(marketingCampaignsTable).where(eq(marketingCampaignsTable.id, cId));
    createdCampaignIds.length = 0; // already deleted

    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.sources).toEqual([
      expect.objectContaining({ key: "none", count: 1 }),
    ]);
  });
});

/* ─── Task #1943 — spam complaint variant ────────────────────────────────
 * Same endpoint, opt-in via `?reason=spam_complaint`. We pin that:
 *   - bounces and spam complaints stay in their own buckets (one chart's
 *     data must not leak into the other),
 *   - the response echoes the requested reason so the UI can title the
 *     chart correctly,
 *   - unknown / forged reason values fall back to bounces (the historical
 *     default) instead of silently widening the scope.
 */
describe("GET /marketing/bounce-sources?reason=spam_complaint", () => {
  it("groups spam complaints by source and excludes bounces", async () => {
    const app = createTestApp(admin);
    const cId = await makeCampaign(orgAId, "Holiday Blast");

    // Spam complaints that should appear in the spam chart
    for (let i = 0; i < 4; i++) {
      await makeSuppression({
        orgId: orgAId,
        email: `spam-c-${i}-${uid()}@example.com`,
        reason: "spam_complaint",
        triggeredByCampaignId: cId,
      });
    }
    for (let i = 0; i < 2; i++) {
      await makeSuppression({
        orgId: orgAId,
        email: `spam-f-${i}-${uid()}@example.com`,
        reason: "spam_complaint",
        triggeredByFlow: "dues_receipt",
      });
    }
    // Unattributed spam complaint — should land in the "none" bucket
    await makeSuppression({
      orgId: orgAId,
      email: `spam-n-${uid()}@example.com`,
      reason: "spam_complaint",
    });
    // A bounce — must NOT show up in the spam-complaint chart
    await makeSuppression({
      orgId: orgAId,
      email: `bounce-${uid()}@example.com`,
      triggeredByCampaignId: cId,
    });
    // Unsubscribe + manual — also excluded
    await makeSuppression({ orgId: orgAId, email: `u-${uid()}@example.com`, reason: "unsubscribed", triggeredByFlow: "dues_receipt" });
    await makeSuppression({ orgId: orgAId, email: `m-${uid()}@example.com`, reason: "manual" });

    const res = await request(app).get(URL(orgAId, "?reason=spam_complaint"));
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("spam_complaint");
    expect(res.body.total).toBe(7);

    const bySrc = Object.fromEntries(
      res.body.sources.map((s: { key: string; count: number; label: string }) => [s.key, s]),
    );
    expect(bySrc[`campaign:${cId}`]).toMatchObject({ count: 4, label: "Holiday Blast" });
    expect(bySrc["flow:dues_receipt"]).toMatchObject({ count: 2 });
    expect(bySrc["none"]).toMatchObject({ count: 1, label: "No source recorded" });
    // Bounces must not appear in the spam chart
    expect(res.body.sources.find((s: { key: string }) => s.key === `campaign:${cId}`)?.count).toBe(4);
  });

  it("returns the spam complaints empty state without crashing", async () => {
    const app = createTestApp(admin);
    // Plenty of bounces, zero spam complaints
    await makeSuppression({ orgId: orgAId, email: `b1-${uid()}@example.com`, triggeredByFlow: "dues_receipt" });
    await makeSuppression({ orgId: orgAId, email: `b2-${uid()}@example.com`, triggeredByFlow: "dues_receipt" });

    const res = await request(app).get(URL(orgAId, "?reason=spam_complaint"));
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("spam_complaint");
    expect(res.body.total).toBe(0);
    expect(res.body.sources).toEqual([]);
    expect(res.body.truncated).toBe(false);
  });

  it("falls back to bounces when reason is unknown / forged", async () => {
    const app = createTestApp(admin);
    await makeSuppression({ orgId: orgAId, email: `b-${uid()}@example.com`, triggeredByFlow: "dues_receipt" });
    await makeSuppression({ orgId: orgAId, email: `s-${uid()}@example.com`, reason: "spam_complaint", triggeredByFlow: "dues_receipt" });
    // Unsubscribed must NOT be served via this endpoint, even when the
    // caller asks for it explicitly — the chart is deliverability-only.
    await makeSuppression({ orgId: orgAId, email: `u-${uid()}@example.com`, reason: "unsubscribed", triggeredByFlow: "dues_receipt" });

    const res = await request(app).get(URL(orgAId, "?reason=unsubscribed"));
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("bounced");
    expect(res.body.total).toBe(1);
    expect(res.body.sources[0].key).toBe("flow:dues_receipt");
    expect(res.body.sources[0].count).toBe(1);
  });

  it("scopes spam complaints to the requesting org", async () => {
    const app = createTestApp(admin);
    await makeSuppression({ orgId: orgAId, email: `a-${uid()}@example.com`, reason: "spam_complaint", triggeredByFlow: "dues_receipt" });
    // Other-org noise that must NOT show up
    await makeSuppression({ orgId: orgBId, email: `b-${uid()}@example.com`, reason: "spam_complaint", triggeredByFlow: "dues_receipt" });

    const res = await request(app).get(URL(orgAId, "?reason=spam_complaint"));
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("spam_complaint");
    expect(res.body.total).toBe(1);
  });
});
