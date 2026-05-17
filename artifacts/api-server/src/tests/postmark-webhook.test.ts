/**
 * Task #981 — Postmark bounce/complaint webhook.
 *
 * Coverage:
 *   - Production refuses requests without `POSTMARK_WEBHOOK_USER`/`PASSWORD` set.
 *   - Bad / missing Basic-auth credentials are rejected with 401.
 *   - Hard-bounce events insert a row in `email_suppressions` for every org
 *     that is resolvable from the recipient's metadata, recent campaigns or
 *     org memberships — and that row then shows up via the existing admin
 *     `GET /organizations/:orgId/marketing/suppressions` endpoint.
 *   - Spam complaints suppress with reason `spam_complaint`.
 *   - SubscriptionChange (SuppressSending=true) suppresses as `unsubscribed`.
 *   - Transient bounces (`Type: "Transient"`) ack but do NOT suppress.
 *   - Inserts are idempotent (replaying the same event is a no-op).
 *   - Repeating the webhook for an unknown email succeeds without writing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  emailSuppressionsTable,
  marketingCampaignsTable,
  emailTemplatesMarketingTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

import { createTestApp, uid, type TestUser } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdEmails: string[] = [];
const createdCampaignIds: number[] = [];
const createdTemplateIds: number[] = [];

beforeAll(() => {
  process.env.POSTMARK_WEBHOOK_USER = "pm-user";
  process.env.POSTMARK_WEBHOOK_PASSWORD = "pm-pass";
  process.env.NODE_ENV = "test";
});

afterAll(async () => {
  if (createdEmails.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.email, createdEmails));
  }
  if (createdCampaignIds.length) {
    await db.delete(marketingCampaignsTable).where(inArray(marketingCampaignsTable.id, createdCampaignIds));
  }
  if (createdTemplateIds.length) {
    await db.delete(emailTemplatesMarketingTable).where(inArray(emailTemplatesMarketingTable.id, createdTemplateIds));
  }
  if (createdUserIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `PM_${tag}`, slug: `pm-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeMember(email: string, orgId: number): Promise<TestUser> {
  const tag = uid("u");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag, username: tag, email, role: "player",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId: u.id, role: "player" });
  return { id: u.id, username: tag, role: "player" };
}

function basicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

describe("POST /api/webhooks/postmark", () => {
  it("rejects requests with bad Basic auth credentials", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "WRONG"))
      .send({ RecordType: "Bounce", Type: "HardBounce", Email: "x@example.com" });
    expect(res.status).toBe(401);
  });

  it("records a hard-bounce suppression resolved via the user's org membership", async () => {
    const orgId = await makeOrg("hb");
    const email = `bounce-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "Bounce",
        Type: "BadMailbox",
        Email: email,
        MessageID: "abc-123",
        Description: "The mailbox does not exist.",
      });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.suppressedFor).toContain(orgId);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("bounced");
    // Task #1138 — bounce metadata persisted alongside the suppression.
    expect(rows[0].bounceType).toBe("BadMailbox");
    expect(rows[0].messageId).toBe("abc-123");
    expect(rows[0].description).toBe("The mailbox does not exist.");

    // Replay refreshes the metadata and stays idempotent on the row.
    const res2 = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({ RecordType: "Bounce", Type: "HardBounce", Email: email, MessageID: "def-456" });
    expect(res2.status).toBe(200);
    const rows2 = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows2.length).toBe(1);
    expect(rows2[0].bounceType).toBe("HardBounce");
    expect(rows2[0].messageId).toBe("def-456");
    // Description falls back to a canned string when Postmark omits it.
    expect(rows2[0].description).toMatch(/permanently rejected/i);
  });

  it("records a spam-complaint suppression with reason=spam_complaint", async () => {
    const orgId = await makeOrg("sc");
    const email = `sc-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({ RecordType: "SpamComplaint", Email: email, Metadata: { orgId: String(orgId) } });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("spam_complaint");
  });

  it("records an unsubscribe via SubscriptionChange", async () => {
    const orgId = await makeOrg("uc");
    const email = `unsub-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "SubscriptionChange",
        EmailAddress: email,
        SuppressSending: true,
        Metadata: { orgId: String(orgId) },
      });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("unsubscribed");
  });

  it("a Bounce of Type=Subscribe clears existing suppressions for that org", async () => {
    const orgId = await makeOrg("rs");
    const email = `resub-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);

    // Pre-seed a suppression so we can confirm it gets cleared.
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId, email: email.toLowerCase(), reason: "bounced",
    });

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({ RecordType: "Bounce", Type: "Subscribe", Email: email });
    expect(res.status).toBe(200);
    expect(res.body.resubscribed).toBe(true);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(0);
  });

  it("a SubscriptionChange with SuppressSending=false clears existing suppressions", async () => {
    const orgId = await makeOrg("rs2");
    const email = `resub2-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);

    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId, email: email.toLowerCase(), reason: "unsubscribed",
    });

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "SubscriptionChange",
        EmailAddress: email,
        SuppressSending: false,
        Metadata: { orgId: String(orgId) },
      });
    expect(res.status).toBe(200);
    expect(res.body.resubscribed).toBe(true);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(0);
  });

  it("fails closed in production when basic-auth credentials are not configured", async () => {
    const savedUser = process.env.POSTMARK_WEBHOOK_USER;
    const savedPass = process.env.POSTMARK_WEBHOOK_PASSWORD;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.POSTMARK_WEBHOOK_USER;
    delete process.env.POSTMARK_WEBHOOK_PASSWORD;
    process.env.NODE_ENV = "production";
    try {
      const app = createTestApp();
      const res = await request(app)
        .post("/api/webhooks/postmark")
        .send({ RecordType: "Bounce", Type: "HardBounce", Email: "anyone@example.com" });
      expect(res.status).toBe(503);
    } finally {
      if (savedUser) process.env.POSTMARK_WEBHOOK_USER = savedUser;
      if (savedPass) process.env.POSTMARK_WEBHOOK_PASSWORD = savedPass;
      if (savedNodeEnv) process.env.NODE_ENV = savedNodeEnv; else delete process.env.NODE_ENV;
    }
  });

  it("Task #1310 — persists triggeredByCampaignId from Metadata.campaignId when campaign belongs to org", async () => {
    const orgId = await makeOrg("tc");
    const email = `tc-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);
    const [c] = await db.insert(marketingCampaignsTable).values({
      organizationId: orgId, name: `c-${uid("n")}`, bodyHtml: "x",
    }).returning({ id: marketingCampaignsTable.id });
    createdCampaignIds.push(c.id);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "Bounce",
        Type: "HardBounce",
        Email: email,
        Metadata: { orgId: String(orgId), campaignId: String(c.id) },
        Tag: "campaign",
      });
    expect(res.status).toBe(200);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].triggeredByCampaignId).toBe(c.id);
    expect(rows[0].triggeredByFlow).toBe("campaign");
  });

  it("Task #1310 — refuses to persist triggeredByCampaignId if campaign belongs to a different org", async () => {
    const orgA = await makeOrg("ta");
    const orgB = await makeOrg("tb");
    const email = `xorg-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgA);
    // Campaign owned by orgB but webhook claims orgA — must NOT cross-link.
    const [c] = await db.insert(marketingCampaignsTable).values({
      organizationId: orgB, name: `cb-${uid("n")}`, bodyHtml: "x",
    }).returning({ id: marketingCampaignsTable.id });
    createdCampaignIds.push(c.id);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "Bounce",
        Type: "HardBounce",
        Email: email,
        Metadata: { orgId: String(orgA), campaignId: String(c.id) },
      });
    expect(res.status).toBe(200);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgA), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].triggeredByCampaignId).toBeNull();
  });

  it("Task #1555 — persists triggeredByTemplateId from Metadata.templateId when template belongs to org", async () => {
    const orgId = await makeOrg("tt");
    const email = `tt-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);
    const [tpl] = await db.insert(emailTemplatesMarketingTable).values({
      organizationId: orgId, name: `tpl-${uid("n")}`, bodyHtml: "<p>x</p>",
    }).returning({ id: emailTemplatesMarketingTable.id });
    createdTemplateIds.push(tpl.id);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "Bounce",
        Type: "HardBounce",
        Email: email,
        Metadata: { orgId: String(orgId), templateId: String(tpl.id) },
      });
    expect(res.status).toBe(200);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].triggeredByTemplateId).toBe(tpl.id);
  });

  it("Task #1555 — refuses to persist triggeredByTemplateId if template belongs to a different org", async () => {
    const orgA = await makeOrg("tta");
    const orgB = await makeOrg("ttb");
    const email = `xorg-tpl-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgA);
    // Template owned by orgB but webhook claims orgA — must NOT cross-link.
    const [tpl] = await db.insert(emailTemplatesMarketingTable).values({
      organizationId: orgB, name: `tplb-${uid("n")}`, bodyHtml: "<p>x</p>",
    }).returning({ id: emailTemplatesMarketingTable.id });
    createdTemplateIds.push(tpl.id);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "Bounce",
        Type: "HardBounce",
        Email: email,
        Metadata: { orgId: String(orgA), templateId: String(tpl.id) },
      });
    expect(res.status).toBe(200);

    // Suppression is still recorded (the bounce is real) — we just drop the
    // forged template attribution rather than expose orgB's template id to orgA.
    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgA), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].triggeredByTemplateId).toBeNull();
  });

  it("Task #1555 — accepts a global template (is_global=true) across orgs", async () => {
    const orgId = await makeOrg("ttg");
    const email = `global-tpl-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);
    // Global templates may have a null organization_id and is_global=true —
    // they're shared across every org so the cross-org check must allow them.
    const [tpl] = await db.insert(emailTemplatesMarketingTable).values({
      organizationId: null, name: `tplg-${uid("n")}`, bodyHtml: "<p>x</p>", isGlobal: true,
    }).returning({ id: emailTemplatesMarketingTable.id });
    createdTemplateIds.push(tpl.id);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "Bounce",
        Type: "HardBounce",
        Email: email,
        Metadata: { orgId: String(orgId), templateId: String(tpl.id) },
      });
    expect(res.status).toBe(200);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].triggeredByTemplateId).toBe(tpl.id);
  });

  it("Task #1310 — persists triggeredByFlow from Metadata.flow (primary path for transactional sends)", async () => {
    const orgId = await makeOrg("tm");
    const email = `tm-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);

    const app = createTestApp();
    // mailer.flowHints() puts the flow on Metadata.flow (and also Tag).
    // Many transactional flows (e.g. dues_receipt, tournament_registration)
    // never set a custom Postmark Tag; the webhook must read flow from
    // Metadata. This test asserts that path independently of Tag.
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "Bounce",
        Type: "HardBounce",
        Email: email,
        Metadata: { orgId: String(orgId), flow: "dues_receipt" },
      });
    expect(res.status).toBe(200);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].triggeredByFlow).toBe("dues_receipt");
    expect(rows[0].triggeredByCampaignId).toBeNull();
  });

  it("Task #1310 — Metadata.flow takes precedence over Tag when both are present", async () => {
    const orgId = await makeOrg("tp");
    const email = `tp-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "Bounce",
        Type: "HardBounce",
        Email: email,
        Metadata: { orgId: String(orgId), flow: "tournament_invite" },
        Tag: "campaign",
      });
    expect(res.status).toBe(200);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].triggeredByFlow).toBe("tournament_invite");
  });

  it("Task #1310 — persists triggeredByFlow from Postmark Tag for transactional flows", async () => {
    const orgId = await makeOrg("tf");
    const email = `tf-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({
        RecordType: "Bounce",
        Type: "HardBounce",
        Email: email,
        Metadata: { orgId: String(orgId) },
        Tag: "password_reset",
      });
    expect(res.status).toBe(200);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(1);
    expect(rows[0].triggeredByFlow).toBe("password_reset");
    expect(rows[0].triggeredByCampaignId).toBeNull();
  });

  it("transient bounces are acked but do NOT suppress", async () => {
    const orgId = await makeOrg("tr");
    const email = `transient-${uid("e")}@example.com`;
    createdEmails.push(email.toLowerCase());
    await makeMember(email, orgId);

    const app = createTestApp();
    const res = await request(app)
      .post("/api/webhooks/postmark")
      .set("Authorization", basicAuth("pm-user", "pm-pass"))
      .send({ RecordType: "Bounce", Type: "Transient", Email: email });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);

    const rows = await db.select().from(emailSuppressionsTable)
      .where(and(eq(emailSuppressionsTable.organizationId, orgId), eq(emailSuppressionsTable.email, email.toLowerCase())));
    expect(rows.length).toBe(0);
  });
});
