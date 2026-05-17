/**
 * Task #2171 — surface the resolved digest language *per recipient* on
 * the side-game stuck-receipts digest schedule editor.
 *
 * Mirrors `wallet-topup-refund-recipient-languages.test.ts` (Task #1747)
 * since the receipt-failure schedule editor mirrors the wallet auto-
 * refund one almost line-for-line. The cron renders the digest in one
 * org-resolved language for every recipient
 * (`resolveSideGameReceiptDigestLang(org.defaultLanguage)`); the
 * per-recipient enrichment added by this task lets the recipients list
 * show "<email> → English" rows and a subtle hint when a recipient's
 * own user-language preference differs from the digest language.
 *
 * Backend behaviour pinned here:
 *
 *   1. GET /api/admin/side-game-receipt-failures/email-schedule must
 *      include a `recipientLanguages` array — one entry per saved
 *      recipient — with `email`, `userPreferredLanguage`,
 *      `resolvedDigestLanguage`, and a `mismatch` flag.
 *
 *   2. The lookup is case-insensitive against `app_users.email` so a
 *      recipient typed in mixed case still resolves to the matching app
 *      user. The returned `email` preserves the casing the admin typed
 *      so the UI rows match the textarea.
 *
 *   3. External recipients (no `app_users` row) leave
 *      `userPreferredLanguage` as `null` and `mismatch` as `false`,
 *      since we cannot know what they would prefer.
 *
 *   4. `mismatch` is `true` only when the recipient *is* a known app
 *      user AND their `preferredLanguage` differs from the digest
 *      language.
 *
 *   5. This is a display-only enrichment — the cron continues to send
 *      everyone the same org-resolved language, so
 *      `resolvedDigestLanguage` is the same for every row.
 *
 *   6. When no schedule is configured, the endpoint still responds 200
 *      and `recipientLanguages` is an empty array (never missing).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  sideGameReceiptDigestSchedulesTable,
  sideGameReceiptDigestRunsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "./helpers.js";

let orgId: number;
let adminId: number;
let admin: TestUser;
// Internal app users seeded for the case-insensitive / mismatch checks.
let internalEsUserId: number;
let internalEnUserId: number;
let internalEsEmail: string;
let internalEnEmail: string;

beforeAll(async () => {
  const tag = uid("t2171");
  const [org] = await db.insert(organizationsTable).values({
    name: `T2171 ${tag}`,
    slug: tag,
    contactEmail: `${tag}@example.test`,
    defaultLanguage: "es",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const adminEmail = `admin_${tag}@example.test`;
  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    email: adminEmail,
    displayName: "Support Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = adminRow.id;
  admin = {
    id: adminId,
    username: `${tag}_admin`,
    role: "org_admin",
    organizationId: orgId,
  };

  // An internal user whose preferredLanguage matches the org's digest
  // language ("es") — should report no mismatch.
  internalEsEmail = `support_${tag}@example.test`;
  const [esUser] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-support`,
    username: `${tag}_support`,
    email: internalEsEmail,
    displayName: "Support Lead",
    role: "player",
    organizationId: orgId,
    preferredLanguage: "es",
  }).returning({ id: appUsersTable.id });
  internalEsUserId = esUser.id;

  // An internal user whose preferredLanguage is "en" — should report a
  // mismatch when the digest language is "es".
  internalEnEmail = `ops_${tag}@example.test`;
  const [enUser] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-ops`,
    username: `${tag}_ops`,
    email: internalEnEmail,
    displayName: "Ops Lead",
    role: "player",
    organizationId: orgId,
    preferredLanguage: "en",
  }).returning({ id: appUsersTable.id });
  internalEnUserId = enUser.id;
});

afterAll(async () => {
  await db.delete(sideGameReceiptDigestRunsTable).where(eq(sideGameReceiptDigestRunsTable.organizationId, orgId));
  await db.delete(sideGameReceiptDigestSchedulesTable).where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminId, internalEsUserId, internalEnUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  await db.delete(sideGameReceiptDigestRunsTable).where(eq(sideGameReceiptDigestRunsTable.organizationId, orgId));
  await db.delete(sideGameReceiptDigestSchedulesTable).where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));
  // Reset the org's defaultLanguage between tests so individual tests
  // can flip it without bleeding into siblings.
  await db.update(organizationsTable)
    .set({ defaultLanguage: "es" })
    .where(eq(organizationsTable.id, orgId));
});

describe("Task #2171 — per-recipient digest language (side-game receipt-failure schedule)", () => {
  it("returns one row per saved recipient with email, resolved digest language, and mismatch flag", async () => {
    // Mix of:
    //   - external recipient (no app_users row) — null preference
    //   - internal user whose preference matches the digest — no mismatch
    //   - internal user whose preference differs from the digest — mismatch
    const externalEmail = "external_support@external.test";
    await db.insert(sideGameReceiptDigestSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: [externalEmail, internalEsEmail, internalEnEmail],
      nextRunAt: new Date(),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/side-game-receipt-failures/email-schedule?organizationId=${orgId}`)
      .expect(200);

    expect(res.body.recipientLanguages).toBeDefined();
    expect(Array.isArray(res.body.recipientLanguages)).toBe(true);
    expect(res.body.recipientLanguages).toHaveLength(3);

    const byEmail = new Map<string, {
      email: string;
      userPreferredLanguage: string | null;
      resolvedDigestLanguage: string;
      mismatch: boolean;
    }>(res.body.recipientLanguages.map((r: { email: string }) => [r.email, r]));

    const ext = byEmail.get(externalEmail);
    expect(ext).toBeDefined();
    expect(ext!.userPreferredLanguage).toBeNull();
    expect(ext!.resolvedDigestLanguage).toBe("es");
    expect(ext!.mismatch).toBe(false);

    const matchedInternal = byEmail.get(internalEsEmail);
    expect(matchedInternal).toBeDefined();
    expect(matchedInternal!.userPreferredLanguage).toBe("es");
    expect(matchedInternal!.resolvedDigestLanguage).toBe("es");
    expect(matchedInternal!.mismatch).toBe(false);

    const mismatchedInternal = byEmail.get(internalEnEmail);
    expect(mismatchedInternal).toBeDefined();
    expect(mismatchedInternal!.userPreferredLanguage).toBe("en");
    expect(mismatchedInternal!.resolvedDigestLanguage).toBe("es");
    expect(mismatchedInternal!.mismatch).toBe(true);
  });

  it("matches recipient emails case-insensitively but preserves the casing the admin typed", async () => {
    const mixedCase = internalEnEmail.replace(/(.)/, (c) => c.toUpperCase());
    expect(mixedCase).not.toBe(internalEnEmail);

    await db.insert(sideGameReceiptDigestSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: [mixedCase],
      nextRunAt: new Date(),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/side-game-receipt-failures/email-schedule?organizationId=${orgId}`)
      .expect(200);

    expect(res.body.recipientLanguages).toHaveLength(1);
    expect(res.body.recipientLanguages[0].email).toBe(mixedCase);
    expect(res.body.recipientLanguages[0].userPreferredLanguage).toBe("en");
    expect(res.body.recipientLanguages[0].resolvedDigestLanguage).toBe("es");
    expect(res.body.recipientLanguages[0].mismatch).toBe(true);
  });

  it("returns the same resolvedDigestLanguage for every recipient (no per-recipient localisation in the cron)", async () => {
    await db.insert(sideGameReceiptDigestSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["ext1@external.test", internalEsEmail, internalEnEmail],
      nextRunAt: new Date(),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/side-game-receipt-failures/email-schedule?organizationId=${orgId}`)
      .expect(200);

    const langs: string[] = res.body.recipientLanguages.map(
      (r: { resolvedDigestLanguage: string }) => r.resolvedDigestLanguage,
    );
    expect(langs).toHaveLength(3);
    expect(new Set(langs).size).toBe(1);
    expect(langs[0]).toBe("es");
  });

  it("flips resolvedDigestLanguage when the org's defaultLanguage changes (and re-evaluates mismatch accordingly)", async () => {
    await db.update(organizationsTable)
      .set({ defaultLanguage: "en" })
      .where(eq(organizationsTable.id, orgId));

    await db.insert(sideGameReceiptDigestSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: [internalEsEmail, internalEnEmail],
      nextRunAt: new Date(),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/side-game-receipt-failures/email-schedule?organizationId=${orgId}`)
      .expect(200);

    const byEmail = new Map<string, {
      userPreferredLanguage: string | null;
      resolvedDigestLanguage: string;
      mismatch: boolean;
    }>(res.body.recipientLanguages.map((r: { email: string }) => [r.email, r]));

    expect(byEmail.get(internalEsEmail)).toMatchObject({
      userPreferredLanguage: "es",
      resolvedDigestLanguage: "en",
      mismatch: true,
    });
    expect(byEmail.get(internalEnEmail)).toMatchObject({
      userPreferredLanguage: "en",
      resolvedDigestLanguage: "en",
      mismatch: false,
    });
  });

  it("returns an empty recipientLanguages array when no schedule is configured", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/side-game-receipt-failures/email-schedule?organizationId=${orgId}`)
      .expect(200);

    expect(res.body.schedule).toBeNull();
    expect(res.body.recipientLanguages).toEqual([]);
  });
});
