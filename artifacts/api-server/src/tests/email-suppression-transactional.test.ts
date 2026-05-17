/**
 * Task #1139 — Honor email_suppressions in transactional sends.
 *
 * Coverage:
 *   - sendTransactionalEmail short-circuits with `{ ok: true, suppressed: true }`
 *     when the recipient is on the suppression list (no provider call made).
 *   - The check is org-scoped when `organizationId` is provided.
 *   - The bypass flag (used by sendPasswordResetEmail) skips the lookup so
 *     locked-out admins can still receive recovery mail even after a hard
 *     bounce parked their address on the list.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db, emailSuppressionsTable, organizationsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import {
  sendTransactionalEmail,
  getActiveMailProvider,
  type MailProvider,
  type SendResult,
  type TransactionalEmail,
} from "../lib/email/adapter.js";
import { uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdEmails: string[] = [];

let captured: TransactionalEmail[] = [];
let originalSend: MailProvider["send"];
let originalConfigured: MailProvider["isConfigured"];

beforeAll(() => {
  // Stub the active provider so no real network calls are made and so we
  // can assert that suppressed sends never reach `provider.send`.
  const provider = getActiveMailProvider();
  originalSend = provider.send.bind(provider);
  originalConfigured = provider.isConfigured.bind(provider);
  (provider as { isConfigured: MailProvider["isConfigured"] }).isConfigured = () => true;
  (provider as { send: MailProvider["send"] }).send = async (msg) => {
    captured.push(msg);
    return { ok: true, provider: provider.name, messageId: "stub-1" } satisfies SendResult;
  };
});

afterAll(async () => {
  const provider = getActiveMailProvider();
  (provider as { send: MailProvider["send"] }).send = originalSend;
  (provider as { isConfigured: MailProvider["isConfigured"] }).isConfigured = originalConfigured;
  if (createdEmails.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.email, createdEmails));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  captured = [];
});

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `SUP_${tag}`, slug: `sup-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

async function suppress(email: string, orgId: number, reason = "bounced") {
  createdEmails.push(email.toLowerCase());
  await db.insert(emailSuppressionsTable).values({
    organizationId: orgId, email: email.toLowerCase(), reason,
  });
}

describe("sendTransactionalEmail honors email_suppressions (Task #1139)", () => {
  it("short-circuits when the recipient is on the suppression list (any org)", async () => {
    const orgId = await makeOrg("hit");
    const to = `bad-${uid("e")}@example.com`;
    await suppress(to, orgId, "bounced");

    const result = await sendTransactionalEmail({
      to, subject: "Hi", html: "<p>Hello</p>",
    });

    expect(result.ok).toBe(true);
    expect(result.suppressed).toBe(true);
    expect(captured.length).toBe(0);
  });

  it("scopes the lookup to the org id when provided", async () => {
    const orgA = await makeOrg("scopeA");
    const orgB = await makeOrg("scopeB");
    const to = `scope-${uid("e")}@example.com`;
    // Suppressed only in orgA.
    await suppress(to, orgA, "spam_complaint");

    // Send on behalf of orgB — should go through.
    const okResult = await sendTransactionalEmail({
      to, subject: "Hi B", html: "<p>Hello</p>", organizationId: orgB,
    });
    expect(okResult.ok).toBe(true);
    expect(okResult.suppressed).toBeFalsy();
    expect(captured.length).toBe(1);
    captured = [];

    // Send on behalf of orgA — should be suppressed.
    const blocked = await sendTransactionalEmail({
      to, subject: "Hi A", html: "<p>Hello</p>", organizationId: orgA,
    });
    expect(blocked.ok).toBe(true);
    expect(blocked.suppressed).toBe(true);
    expect(captured.length).toBe(0);
  });

  it("delivers when the recipient is NOT on the suppression list", async () => {
    const fresh = `fresh-${uid("e")}@example.com`;
    const result = await sendTransactionalEmail({
      to: fresh, subject: "Hi", html: "<p>Hello</p>",
    });
    expect(result.ok).toBe(true);
    expect(result.suppressed).toBeFalsy();
    expect(captured.length).toBe(1);
    expect(captured[0].to).toBe(fresh);
  });

  it("bypassSuppression=true delivers even when address is suppressed (e.g. password reset)", async () => {
    const orgId = await makeOrg("bypass");
    const to = `locked-${uid("e")}@example.com`;
    await suppress(to, orgId, "bounced");

    const result = await sendTransactionalEmail({
      to,
      subject: "Reset your password",
      html: "<p>Reset link</p>",
      bypassSuppression: true,
    });

    expect(result.ok).toBe(true);
    expect(result.suppressed).toBeFalsy();
    expect(captured.length).toBe(1);
    expect(captured[0].to).toBe(to);
  });

  it("handles 'Name <email@host>' formatted recipients", async () => {
    const orgId = await makeOrg("fmt");
    const bare = `fmt-${uid("e")}@example.com`;
    await suppress(bare, orgId, "bounced");

    const result = await sendTransactionalEmail({
      to: `"Some One" <${bare}>`,
      subject: "Hi",
      html: "<p>Hello</p>",
    });
    expect(result.suppressed).toBe(true);
    expect(captured.length).toBe(0);
  });
});
