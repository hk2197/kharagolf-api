/**
 * Integration tests: WhatsApp delivery-receipt webhook (Task 347).
 *
 * The transactional WhatsApp providers (Twilio, MSG91) POST a delivery
 * status callback once the carrier confirms (or rejects) message delivery.
 * `POST /api/webhooks/whatsapp` maps that callback back to the originating
 * privacy notice via `lastWhatsappMessageId` and:
 *   - On `failed`/`undelivered` → flips `lastWhatsappStatus` to "failed"
 *     and records the carrier error so the existing
 *     `retryFailedDataRequestPushSms` cron picks the row up (subject to
 *     the 5-attempt cap, enforced separately).
 *   - On `delivered`/`read` → records the carrier-confirmed terminal state
 *     so the dashboard chip reflects the truth, not just provider-accepted.
 *   - Returns 200 (not-matched) when no row owns the message id, so the
 *     provider doesn't endlessly retry callbacks for unrelated sends
 *     (e.g. levy receipts that don't yet track msg id).
 *
 * Production-mode signature/auth enforcement is asserted separately.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberDataRequestsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

async function ensureSchema() {
  // Mirrors the bootstrap in `data-request-push-sms-exhaustion.test.ts` —
  // the privacy/comm schema lags in some local environments, so we ensure
  // the columns this test touches exist via idempotent DDL.
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`
    ALTER TABLE member_data_requests
      ADD COLUMN IF NOT EXISTS last_whatsapp_status TEXT,
      ADD COLUMN IF NOT EXISTS last_whatsapp_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_whatsapp_error TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_whatsapp_message_id TEXT
  `);
  // Task 507: levy receipt attempts also track the WhatsApp provider
  // message id; the webhook now falls back to this table when no privacy
  // notice owns the id.
  await db.execute(sql`
    ALTER TABLE member_levy_receipt_attempts
      ADD COLUMN IF NOT EXISTS last_whatsapp_message_id TEXT
  `);
}

let orgId: number;
let userId: number;
let memberId: number;
const app = createTestApp();

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `WA Webhook Test ${suffix}`,
    slug: `wa-webhook-${suffix}`,
  }).returning();
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `wa-webhook-${suffix}`,
    username: `wa_webhook_${suffix}`,
    role: "player",
  }).returning();
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    userId,
    organizationId: orgId,
    role: "player",
  });

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId,
    firstName: "Wa",
    lastName: "Test",
    email: `wa_${suffix}@example.com`,
    phone: "+15551230000",
    memberNumber: `WA-${suffix}`,
    subscriptionStatus: "active",
  }).returning();
  memberId = m.id;
});

afterAll(async () => {
  // Best-effort cleanup; isolation between runs is by unique suffix.
});

async function insertSentRequest(messageId: string) {
  const [row] = await db.insert(memberDataRequestsTable).values({
    clubMemberId: memberId,
    organizationId: orgId,
    requestType: "data_export",
    status: "pending",
    lastWhatsappStatus: "sent",
    lastWhatsappMessageId: messageId,
    whatsappAttempts: 1,
  }).returning();
  return row;
}

describe("WhatsApp delivery webhook (Task 347)", () => {
  it("MSG91: failed callback flips row to failed so cron retries", async () => {
    const messageId = `msg91_req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const row = await insertSentRequest(messageId);

    const res = await request(app)
      .post("/api/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .send({ request_id: messageId, status: "failed", description: "carrier rejected" });

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.status).toBe("failed");

    const [updated] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, row.id));
    expect(updated.lastWhatsappStatus).toBe("failed");
    expect(updated.lastWhatsappError).toContain("carrier rejected");
    // Attempts unchanged — the cron will increment when it next retries.
    expect(updated.whatsappAttempts).toBe(1);
  });

  it("MSG91: delivered callback records terminal success state", async () => {
    const messageId = `msg91_req_${Date.now()}_ok`;
    const row = await insertSentRequest(messageId);

    const res = await request(app)
      .post("/api/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .send({ request_id: messageId, status: "delivered" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("delivered");

    const [updated] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, row.id));
    expect(updated.lastWhatsappStatus).toBe("delivered");
    expect(updated.lastWhatsappError).toBeNull();
  });

  it("Twilio: undelivered callback flips row to failed", async () => {
    const messageId = `SM${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const row = await insertSentRequest(messageId);

    const res = await request(app)
      .post("/api/webhooks/whatsapp")
      .type("form")
      .send({
        MessageSid: messageId,
        MessageStatus: "undelivered",
        ErrorCode: "63016",
        ErrorMessage: "Message blocked",
      });

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.status).toBe("failed");

    const [updated] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, row.id));
    expect(updated.lastWhatsappStatus).toBe("failed");
    expect(updated.lastWhatsappError).toContain("63016");
  });

  it("returns 200 with matched:false for unknown message ids", async () => {
    const res = await request(app)
      .post("/api/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .send({ request_id: "nope_does_not_exist", status: "failed" });

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(false);
  });

  it("Twilio: rejects payloads with a missing or wrong signature when TWILIO_AUTH_TOKEN is set", async () => {
    const prevToken = process.env.TWILIO_AUTH_TOKEN;
    process.env.TWILIO_AUTH_TOKEN = "test-token-do-not-leak";
    try {
      // Missing header → 401
      const missing = await request(app)
        .post("/api/webhooks/whatsapp")
        .type("form")
        .send({ MessageSid: "SMtest", MessageStatus: "delivered" });
      expect(missing.status).toBe(401);

      // Wrong signature → 401
      const wrong = await request(app)
        .post("/api/webhooks/whatsapp")
        .type("form")
        .set("X-Twilio-Signature", "not-a-real-signature")
        .send({ MessageSid: "SMtest", MessageStatus: "delivered" });
      expect(wrong.status).toBe(401);
    } finally {
      if (prevToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
      else process.env.TWILIO_AUTH_TOKEN = prevToken;
    }
  });

  it("MSG91: rejects payloads with a wrong auth key when MSG91_WEBHOOK_AUTH_KEY is set", async () => {
    const prev = process.env.MSG91_WEBHOOK_AUTH_KEY;
    process.env.MSG91_WEBHOOK_AUTH_KEY = "expected-key";
    try {
      const noKey = await request(app)
        .post("/api/webhooks/whatsapp")
        .set("Content-Type", "application/json")
        .send({ request_id: "anything", status: "failed" });
      expect(noKey.status).toBe(401);

      const wrongKey = await request(app)
        .post("/api/webhooks/whatsapp")
        .set("Content-Type", "application/json")
        .set("authkey", "totally-wrong")
        .send({ request_id: "anything", status: "failed" });
      expect(wrongKey.status).toBe(401);

      // Right key still works (acks even when no row matches)
      const rightKey = await request(app)
        .post("/api/webhooks/whatsapp")
        .set("Content-Type", "application/json")
        .set("authkey", "expected-key")
        .send({ request_id: "no_such_msg", status: "failed" });
      expect(rightKey.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.MSG91_WEBHOOK_AUTH_KEY;
      else process.env.MSG91_WEBHOOK_AUTH_KEY = prev;
    }
  });

  it("fails closed in production when no provider secret is configured", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevTwilio = process.env.TWILIO_AUTH_TOKEN;
    const prevMsg91 = process.env.MSG91_WEBHOOK_AUTH_KEY;
    process.env.NODE_ENV = "production";
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.MSG91_WEBHOOK_AUTH_KEY;
    try {
      const res = await request(app)
        .post("/api/webhooks/whatsapp")
        .set("Content-Type", "application/json")
        .send({ request_id: "x", status: "failed" });
      expect(res.status).toBe(503);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevTwilio !== undefined) process.env.TWILIO_AUTH_TOKEN = prevTwilio;
      if (prevMsg91 !== undefined) process.env.MSG91_WEBHOOK_AUTH_KEY = prevMsg91;
    }
  });

  it("ignores unmapped statuses without modifying the row", async () => {
    const messageId = `msg91_req_${Date.now()}_unmapped`;
    const row = await insertSentRequest(messageId);

    const res = await request(app)
      .post("/api/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .send({ request_id: messageId, status: "future_state_we_dont_know" });

    expect(res.status).toBe(200);
    expect(res.body.ignored).toBeDefined();

    const [unchanged] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, row.id));
    expect(unchanged.lastWhatsappStatus).toBe("sent");
  });
});
