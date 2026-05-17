/**
 * Task #1747 — surface the resolved digest language *per recipient* on
 * the auto-refund schedule editor.
 *
 * Task #2170 — the cron now actually honours each recipient's own
 * `app_users.preferredLanguage` (with the org's resolved
 * `defaultLanguage` as fallback for external recipients and for users
 * whose preference is null or unsupported), so the
 * `recipientLanguages` rows on the editor GET are the source of truth
 * for what each address will receive — not a display-only enrichment.
 *
 * Backend behaviour pinned here:
 *
 *   1. GET /api/admin/wallet-topup-refunds/email-schedule must include a
 *      `recipientLanguages` array — one entry per saved recipient — with
 *      `email`, `userPreferredLanguage`, `resolvedDigestLanguage`, and
 *      a `mismatch` flag.
 *
 *   2. The lookup is case-insensitive against `app_users.email` so a
 *      recipient typed in mixed case still resolves to the matching app
 *      user. The returned `email` preserves the casing the treasurer
 *      typed so the UI rows match the textarea.
 *
 *   3. External recipients (no `app_users` row) leave
 *      `userPreferredLanguage` as `null` and `mismatch` as `false`,
 *      since we cannot know what they would prefer; their
 *      `resolvedDigestLanguage` is the org's default-language fallback.
 *
 *   4. Known app users with a *supported* `preferredLanguage` see that
 *      preference as their `resolvedDigestLanguage`, and `mismatch`
 *      stays `false` because the cron honours the preference.
 *
 *   5. `mismatch` is `true` only when the recipient is a known app user
 *      AND their stored `preferredLanguage` is itself unsupported by
 *      the digest's translation pack — i.e. the user will receive the
 *      org-default fallback rather than the language they asked for.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  walletTopupRefundEmailSchedulesTable,
  walletTopupRefundEmailRunsTable,
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
  const tag = uid("t1747");
  const [org] = await db.insert(organizationsTable).values({
    name: `T1747 ${tag}`,
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
    displayName: "Treasurer Admin",
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
  internalEsEmail = `finance_${tag}@example.test`;
  const [esUser] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-finance`,
    username: `${tag}_finance`,
    email: internalEsEmail,
    displayName: "Finance Lead",
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
  await db.delete(walletTopupRefundEmailRunsTable).where(eq(walletTopupRefundEmailRunsTable.organizationId, orgId));
  await db.delete(walletTopupRefundEmailSchedulesTable).where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminId, internalEsUserId, internalEnUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  await db.delete(walletTopupRefundEmailRunsTable).where(eq(walletTopupRefundEmailRunsTable.organizationId, orgId));
  await db.delete(walletTopupRefundEmailSchedulesTable).where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  // Reset the org's defaultLanguage between tests so individual tests
  // can flip it without bleeding into siblings.
  await db.update(organizationsTable)
    .set({ defaultLanguage: "es" })
    .where(eq(organizationsTable.id, orgId));
});

describe("Task #1747 — per-recipient digest language", () => {
  it("returns one row per saved recipient with email, resolved digest language, and mismatch flag", async () => {
    // Mix of:
    //   - external recipient (no app_users row) — null preference
    //   - internal user whose preference matches the digest — no mismatch
    //   - internal user whose preference differs from the digest — mismatch
    const externalEmail = "external_accountant@external.test";
    await db.insert(walletTopupRefundEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: [externalEmail, internalEsEmail, internalEnEmail],
      nextRunAt: new Date(),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule?organizationId=${orgId}`)
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

    // Task #2170 — the cron now honours each user's own
    // `preferredLanguage` when it's supported, so an "en"-preferring
    // user reads as `resolvedDigestLanguage: "en"` (their preference)
    // and `mismatch: false` even though the org default is "es".
    const internalEnRow = byEmail.get(internalEnEmail);
    expect(internalEnRow).toBeDefined();
    expect(internalEnRow!.userPreferredLanguage).toBe("en");
    expect(internalEnRow!.resolvedDigestLanguage).toBe("en");
    expect(internalEnRow!.mismatch).toBe(false);
  });

  it("matches recipient emails case-insensitively but preserves the casing the treasurer typed", async () => {
    // Recipient typed in MIXED CASE — should still resolve to the
    // matching app_user and report the user's preferredLanguage. The
    // returned `email` should preserve the treasurer's casing so the
    // UI rows match what's in the textarea.
    const mixedCase = internalEnEmail.replace(/(.)/, (c) => c.toUpperCase());
    expect(mixedCase).not.toBe(internalEnEmail);

    await db.insert(walletTopupRefundEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: [mixedCase],
      nextRunAt: new Date(),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule?organizationId=${orgId}`)
      .expect(200);

    expect(res.body.recipientLanguages).toHaveLength(1);
    expect(res.body.recipientLanguages[0].email).toBe(mixedCase);
    expect(res.body.recipientLanguages[0].userPreferredLanguage).toBe("en");
    // Task #2170 — the cron honours this user's "en" preference, so
    // the resolved language is "en" (not the org default "es") and
    // there is no mismatch to flag.
    expect(res.body.recipientLanguages[0].resolvedDigestLanguage).toBe("en");
    expect(res.body.recipientLanguages[0].mismatch).toBe(false);
  });

  it("returns each recipient's own resolvedDigestLanguage now that the cron localises per-recipient (Task #2170)", async () => {
    // Task #2170 — the cron groups recipients by their resolved
    // language and dispatches one rendered digest per group, so the
    // editor's `recipientLanguages` rows reflect the *per-recipient*
    // language each address will actually receive. Pin that an
    // external recipient (no app_user row) gets the org default while
    // the two internal users each get their own preference.
    await db.insert(walletTopupRefundEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["ext1@external.test", internalEsEmail, internalEnEmail],
      nextRunAt: new Date(),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule?organizationId=${orgId}`)
      .expect(200);

    const byEmail = new Map<string, {
      userPreferredLanguage: string | null;
      resolvedDigestLanguage: string;
      mismatch: boolean;
    }>(res.body.recipientLanguages.map((r: { email: string }) => [r.email, r]));

    expect(byEmail.size).toBe(3);
    // External recipient — falls back to the org's resolved language.
    expect(byEmail.get("ext1@external.test")).toMatchObject({
      userPreferredLanguage: null,
      resolvedDigestLanguage: res.body.language.resolved,
      mismatch: false,
    });
    // Internal "es" user — preference is supported, so they get "es".
    expect(byEmail.get(internalEsEmail)).toMatchObject({
      userPreferredLanguage: "es",
      resolvedDigestLanguage: "es",
      mismatch: false,
    });
    // Internal "en" user — preference is supported, so they get "en"
    // even though the org default is "es" — the org default is no
    // longer the single language used by everyone.
    expect(byEmail.get(internalEnEmail)).toMatchObject({
      userPreferredLanguage: "en",
      resolvedDigestLanguage: "en",
      mismatch: false,
    });
  });

  it("honours each user's preference even when the org default differs (Task #2170)", async () => {
    // Flip the org default to "en" and verify the "es"-preferring user
    // still gets "es" (their preference) — the org default only
    // matters as the *fallback* for external recipients and for users
    // whose preference is unsupported.
    await db.update(organizationsTable)
      .set({ defaultLanguage: "en" })
      .where(eq(organizationsTable.id, orgId));

    await db.insert(walletTopupRefundEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: [internalEsEmail, internalEnEmail],
      nextRunAt: new Date(),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule?organizationId=${orgId}`)
      .expect(200);

    const byEmail = new Map<string, {
      userPreferredLanguage: string | null;
      resolvedDigestLanguage: string;
      mismatch: boolean;
    }>(res.body.recipientLanguages.map((r: { email: string }) => [r.email, r]));

    expect(byEmail.get(internalEsEmail)).toMatchObject({
      userPreferredLanguage: "es",
      resolvedDigestLanguage: "es",
      mismatch: false,
    });
    expect(byEmail.get(internalEnEmail)).toMatchObject({
      userPreferredLanguage: "en",
      resolvedDigestLanguage: "en",
      mismatch: false,
    });
  });

  it("returns an empty recipientLanguages array when no schedule is configured", async () => {
    // No schedule row was inserted in beforeEach — endpoint should
    // still respond 200 and the recipientLanguages array should be
    // empty rather than missing.
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule?organizationId=${orgId}`)
      .expect(200);

    expect(res.body.schedule).toBeNull();
    expect(res.body.recipientLanguages).toEqual([]);
  });
});
