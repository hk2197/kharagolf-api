/**
 * Integration tests: GET /organizations/:orgId/marketing/suppressions/:id/message
 *
 * Task #1556 — "Let admins jump from a suppression straight to the bounced
 * message preview". Covers:
 *   - auth/admin/org-scoping guards
 *   - 404 when the suppression itself doesn't belong to the caller's org
 *   - structured 404 (`error: "no_message_id"`) when the suppression has no
 *     Postmark MessageID recorded (legacy / manually-added rows)
 *   - 503 (`POSTMARK_SERVER_TOKEN not set`) when Postmark isn't configured —
 *     proves we never leak the request to api.postmarkapp.com without a token
 *   - 200 with `{ message: { htmlBody, ... } }` on the happy path with a
 *     mocked `fetch` standing in for the Postmark API
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  emailSuppressionsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";
import {
  __resetPostmarkMessageCacheForTests,
  __postmarkMessageCacheSizeForTests,
} from "../lib/email/postmarkMessageCache.js";

let orgAId: number;
let orgBId: number;
let adminUserId: number;
let outsiderUserId: number;
let admin: TestUser;
let outsider: TestUser;

const createdSuppressionIds: number[] = [];

async function makeSuppression(opts: {
  orgId: number;
  email: string;
  messageId?: string | null;
  reason?: string;
  bounceType?: string | null;
}): Promise<number> {
  const [row] = await db.insert(emailSuppressionsTable).values({
    organizationId: opts.orgId,
    email: opts.email.toLowerCase(),
    reason: opts.reason ?? "bounced",
    bounceType: opts.bounceType ?? "HardBounce",
    messageId: opts.messageId ?? null,
    description: "Recipient mailbox does not exist",
  }).returning({ id: emailSuppressionsTable.id });
  createdSuppressionIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const stamp = uid("msgpreview");
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_MsgPreview_A_${stamp}`,
    slug: `test-msgpreview-a-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_MsgPreview_B_${stamp}`,
    slug: `test-msgpreview-b-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `msgpreview-admin-${stamp}`,
    username: `msgpreview_admin_${stamp}`,
    email: `msgpreview_admin_${stamp}@example.com`,
    displayName: "Msg Preview Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [outsiderRow] = await db.insert(appUsersTable).values({
    replitUserId: `msgpreview-outsider-${stamp}`,
    username: `msgpreview_outsider_${stamp}`,
    email: `msgpreview_outsider_${stamp}@example.com`,
    displayName: "Msg Preview Outsider",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = outsiderRow.id;

  admin = {
    id: adminUserId,
    username: `msgpreview_admin_${stamp}`,
    displayName: "Msg Preview Admin",
    role: "org_admin",
    organizationId: orgAId,
  };
  outsider = {
    id: outsiderUserId,
    username: `msgpreview_outsider_${stamp}`,
    displayName: "Msg Preview Outsider",
    role: "player",
    organizationId: orgAId,
  };
});

afterAll(async () => {
  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
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
  // Task #1937 — start each case with a clean cache so HIT/MISS assertions
  // are deterministic and don't depend on test ordering.
  __resetPostmarkMessageCacheForTests();
});

const URL = (orgId: number, supId: number) =>
  `/api/organizations/${orgId}/marketing/suppressions/${supId}/message`;

// Postmark MessageIDs are UUIDs; the route's regex requires hex/dashes.
const FAKE_MESSAGE_ID = "abcd1234-5678-90ab-cdef-1234567890ab";

describe("GET /suppressions/:id/message — auth & 404", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).get(URL(orgAId, supId));
    expect(res.status).toBe(401);
  });

  it("rejects non-admin players with 403", async () => {
    const app = createTestApp(outsider);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).get(URL(orgAId, supId));
    expect(res.status).toBe(403);
  });

  it("rejects admins from a different org with 403", async () => {
    const wrongOrgAdmin: TestUser = { ...admin, organizationId: orgBId };
    const app = createTestApp(wrongOrgAdmin);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).get(URL(orgAId, supId));
    expect(res.status).toBe(403);
  });

  it("returns 404 when the suppression belongs to a different org", async () => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgBId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).get(URL(orgAId, supId));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Suppression not found");
  });

  it("returns 404 (no_message_id) when the suppression has no Postmark MessageID", async () => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: `legacy-${uid()}@example.com`, messageId: null });
    const res = await request(app).get(URL(orgAId, supId));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_message_id");
    expect(res.body.message).toMatch(/no Postmark MessageID/i);
  });
});

describe("GET /suppressions/:id/message — Postmark wiring", () => {
  let originalToken: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalToken = process.env.POSTMARK_SERVER_TOKEN;
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.POSTMARK_SERVER_TOKEN;
    else process.env.POSTMARK_SERVER_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns 503 when POSTMARK_SERVER_TOKEN is not configured", async () => {
    delete process.env.POSTMARK_SERVER_TOKEN;
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).get(URL(orgAId, supId));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("postmark_lookup_failed");
  });

  it("returns 200 with the rendered message body on success", async () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token-msgpreview";
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      // Sanity-check that we forwarded the MessageID and server token correctly.
      expect(u).toContain(`/messages/outbound/${FAKE_MESSAGE_ID}/details`);
      expect(init?.method).toBe("GET");
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["X-Postmark-Server-Token"]).toBe("test-token-msgpreview");
      return new Response(JSON.stringify({
        MessageID: FAKE_MESSAGE_ID,
        To: [
          { Email: "primary@example.com", Name: "Primary Recipient" },
          { Email: "bounce@example.com" },
        ],
        Cc: [{ Email: "cc1@example.com", Name: "CC One" }],
        Bcc: [{ Email: "bcc1@example.com" }],
        From: "noreply@kharagolf.com",
        Subject: "Hello from KHARAGOLF",
        HtmlBody: "<p>Hi there</p>",
        TextBody: "Hi there",
        Status: "Bounced",
        ReceivedAt: "2026-04-29T12:00:00Z",
        Tag: "dues_receipt",
        Metadata: { orgId: String(orgAId), flow: "dues_receipt" },
        Recipients: ["primary@example.com", "bounce@example.com", "cc1@example.com", "bcc1@example.com"],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: "bounce@example.com", messageId: FAKE_MESSAGE_ID });
    const res = await request(app).get(URL(orgAId, supId));
    expect(res.status).toBe(200);
    expect(res.body.suppression.id).toBe(supId);
    expect(res.body.message.htmlBody).toBe("<p>Hi there</p>");
    expect(res.body.message.textBody).toBe("Hi there");
    expect(res.body.message.subject).toBe("Hello from KHARAGOLF");
    expect(res.body.message.tag).toBe("dues_receipt");
    expect(res.body.message.metadata.flow).toBe("dues_receipt");
    // Task #1935 — surface the original To/Cc/Bcc lists so admins can see
    // every recipient of the bounced send, not just the suppressed address.
    expect(res.body.message.to).toEqual([
      { Email: "primary@example.com", Name: "Primary Recipient" },
      { Email: "bounce@example.com" },
    ]);
    expect(res.body.message.cc).toEqual([{ Email: "cc1@example.com", Name: "CC One" }]);
    expect(res.body.message.bcc).toEqual([{ Email: "bcc1@example.com" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults cc/bcc to empty arrays when Postmark omits them", async () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token-msgpreview";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      MessageID: FAKE_MESSAGE_ID,
      To: [{ Email: "bounce@example.com" }],
      From: "noreply@kharagolf.com",
      Subject: "Plain",
      HtmlBody: "<p>x</p>",
      TextBody: "x",
      Recipients: ["bounce@example.com"],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof globalThis.fetch;

    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: "bounce@example.com", messageId: FAKE_MESSAGE_ID });
    const res = await request(app).get(URL(orgAId, supId));
    expect(res.status).toBe(200);
    expect(res.body.message.cc).toEqual([]);
    expect(res.body.message.bcc).toEqual([]);
  });

  it("propagates Postmark 404 (aged-out body) as a 404 with error: message_not_available", async () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token-msgpreview";
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ ErrorCode: 701, Message: "Message not found." }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )) as typeof globalThis.fetch;

    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: `oldbounce-${uid()}@example.com`, messageId: FAKE_MESSAGE_ID });
    const res = await request(app).get(URL(orgAId, supId));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("message_not_available");
    expect(res.body.message).toMatch(/45 days/);
    expect(res.body.messageId).toBe(FAKE_MESSAGE_ID);
  });
});

/**
 * Task #1937 — Cache hit/miss behaviour. The route now memoises successful
 * Postmark lookups in-process so reopening the same suppression dialog
 * doesn't keep hammering Postmark's outbound-messages API. Failures are
 * deliberately not cached so transient errors recover on the next click.
 */
describe("GET /suppressions/:id/message — Postmark message cache (Task #1937)", () => {
  let originalToken: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalToken = process.env.POSTMARK_SERVER_TOKEN;
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.POSTMARK_SERVER_TOKEN;
    else process.env.POSTMARK_SERVER_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeFetchMock(payloadOverride?: Record<string, unknown>) {
    return vi.fn(async () => new Response(JSON.stringify({
      MessageID: FAKE_MESSAGE_ID,
      To: [{ Email: "bounce@example.com" }],
      From: "noreply@kharagolf.com",
      Subject: "Hello from KHARAGOLF",
      HtmlBody: "<p>Hi there</p>",
      TextBody: "Hi there",
      Status: "Bounced",
      ReceivedAt: "2026-04-29T12:00:00Z",
      Tag: "dues_receipt",
      Metadata: { orgId: String(orgAId), flow: "dues_receipt" },
      Recipients: ["bounce@example.com"],
      ...payloadOverride,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }

  it("first open is a MISS, second open is a HIT served from cache without re-hitting Postmark", async () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token-cache";
    const fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: "bounce@example.com", messageId: FAKE_MESSAGE_ID });

    const first = await request(app).get(URL(orgAId, supId));
    expect(first.status).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(first.body.message.htmlBody).toBe("<p>Hi there</p>");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await request(app).get(URL(orgAId, supId));
    expect(second.status).toBe(200);
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(second.body.message.htmlBody).toBe("<p>Hi there</p>");
    expect(second.body.message.subject).toBe("Hello from KHARAGOLF");
    // Cache served the second open — Postmark was NOT called again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("?refresh=1 bypasses the cache and re-fetches from Postmark", async () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token-cache";
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      return new Response(JSON.stringify({
        MessageID: FAKE_MESSAGE_ID,
        To: [{ Email: "bounce@example.com" }],
        From: "noreply@kharagolf.com",
        // Vary subject between calls so we can prove a refresh actually
        // re-hit Postmark and updated the stored entry.
        Subject: `Hello v${callCount}`,
        HtmlBody: `<p>Body v${callCount}</p>`,
        TextBody: `Body v${callCount}`,
        Status: "Bounced",
        ReceivedAt: "2026-04-29T12:00:00Z",
        Tag: "dues_receipt",
        Metadata: { flow: "dues_receipt" },
        Recipients: ["bounce@example.com"],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: "bounce@example.com", messageId: FAKE_MESSAGE_ID });

    const a = await request(app).get(URL(orgAId, supId));
    expect(a.headers["x-cache"]).toBe("MISS");
    expect(a.body.message.subject).toBe("Hello v1");

    const b = await request(app).get(URL(orgAId, supId));
    expect(b.headers["x-cache"]).toBe("HIT");
    expect(b.body.message.subject).toBe("Hello v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const c = await request(app).get(`${URL(orgAId, supId)}?refresh=1`);
    expect(c.status).toBe(200);
    expect(c.headers["x-cache"]).toBe("MISS");
    expect(c.body.message.subject).toBe("Hello v2");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The refreshed body is now what subsequent (non-refresh) opens see.
    const d = await request(app).get(URL(orgAId, supId));
    expect(d.headers["x-cache"]).toBe("HIT");
    expect(d.body.message.subject).toBe("Hello v2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed Postmark lookups — a successful retry still reports MISS", async () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token-cache";
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        // First call: Postmark says the message has aged out.
        return new Response(
          JSON.stringify({ ErrorCode: 701, Message: "Message not found." }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      // Second call: a real success (mirrors a transient lookup recovering).
      return new Response(JSON.stringify({
        MessageID: FAKE_MESSAGE_ID,
        To: [{ Email: "bounce@example.com" }],
        From: "noreply@kharagolf.com",
        Subject: "Recovered",
        HtmlBody: "<p>ok</p>",
        TextBody: "ok",
        Status: "Bounced",
        ReceivedAt: "2026-04-29T12:00:00Z",
        Tag: null,
        Metadata: null,
        Recipients: ["bounce@example.com"],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: "bounce@example.com", messageId: FAKE_MESSAGE_ID });

    const fail = await request(app).get(URL(orgAId, supId));
    expect(fail.status).toBe(404);
    expect(fail.headers["x-cache"]).toBe("MISS");
    expect(fail.body.error).toBe("message_not_available");
    // Failures must not pollute the cache.
    expect(__postmarkMessageCacheSizeForTests()).toBe(0);

    const ok = await request(app).get(URL(orgAId, supId));
    expect(ok.status).toBe(200);
    expect(ok.headers["x-cache"]).toBe("MISS");
    expect(ok.body.message.subject).toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Now the success is cached.
    const hit = await request(app).get(URL(orgAId, supId));
    expect(hit.status).toBe(200);
    expect(hit.headers["x-cache"]).toBe("HIT");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
