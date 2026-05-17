/**
 * Task #1436 — surface the resolved digest language to treasurers.
 *
 * Two pieces of behaviour, both happen on the schedule admin endpoints:
 *
 * 1. GET /api/admin/wallet-topup-refunds/email-schedule must include a
 *    `language` block describing what the cron is *actually* going to
 *    render in (org's `defaultLanguage` resolved through the digest's
 *    21-language pack with EN fallback). A treasurer who set up the
 *    schedule before the org's default language was changed sees the
 *    resolved language even when their original configuration assumed
 *    English.
 *
 * 2. POST /api/admin/wallet-topup-refunds/email-schedule/send-preview
 *    fires the same digest payload as the cron — but addressed only to
 *    the requesting treasurer's own email, in the resolved language —
 *    without recording a "real" run row, advancing `lastSentAt`, or
 *    going through the bounce-aware suppression pause logic.
 *
 * The mailer is mocked so the suite never touches SMTP. The DB,
 * org/user resolution, and route auth are all real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendWalletTopupRefundScheduleEmail: vi.fn(async () => {}),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  walletTopupRefundEmailSchedulesTable,
  walletTopupRefundEmailRunsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendWalletTopupRefundScheduleEmail } from "../lib/mailer.js";
import { _resetRateLimiterForTests } from "../lib/publicRateLimit.js";
import { createTestApp, uid, type TestUser } from "./helpers.js";

const sendMock = vi.mocked(sendWalletTopupRefundScheduleEmail);

let orgId: number;
let adminId: number;
let adminEmail: string;
let scheduleId: number;
let admin: TestUser;

beforeAll(async () => {
  const tag = uid("t1436");
  const [org] = await db.insert(organizationsTable).values({
    name: `T1436 ${tag}`,
    slug: tag,
    contactEmail: `${tag}@example.test`,
    defaultLanguage: "es",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  adminEmail = `admin_${tag}@example.test`;
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

});

afterAll(async () => {
  await db.delete(walletTopupRefundEmailRunsTable).where(eq(walletTopupRefundEmailRunsTable.organizationId, orgId));
  await db.delete(walletTopupRefundEmailSchedulesTable).where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendMock.mockClear();
  sendMock.mockImplementation(async () => {});
  // Task #1748 — send-preview is now per-(user, org) rate-limited; reset
  // the shared bucket store so each `it()` starts from a full allotment.
  await _resetRateLimiterForTests();
  await db.delete(walletTopupRefundEmailRunsTable).where(eq(walletTopupRefundEmailRunsTable.organizationId, orgId));
  await db.delete(walletTopupRefundEmailSchedulesTable).where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  // Reset the org's defaultLanguage between tests so individual tests
  // can flip it (e.g. the fallback test below) without bleeding into
  // siblings.
  await db.update(organizationsTable)
    .set({ defaultLanguage: "es" })
    .where(eq(organizationsTable.id, orgId));

  const [s] = await db.insert(walletTopupRefundEmailSchedulesTable).values({
    organizationId: orgId,
    frequency: "weekly",
    recipients: ["finance@example.test", "ops@example.test"],
    nextRunAt: new Date(),
  }).returning({ id: walletTopupRefundEmailSchedulesTable.id });
  scheduleId = s.id;
});

describe("Task #1436 — wallet auto-refund digest resolved language", () => {
  it("includes the resolved language on the schedule GET response", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule?organizationId=${orgId}`)
      .expect(200);

    expect(res.body.language).toEqual({
      configured: "es",
      resolved: "es",
      isFallback: false,
    });
  });

  it("flags isFallback when the org's defaultLanguage is not in the digest's translation pack", async () => {
    // The `supported_language` enum prevents us from seeding an
    // out-of-band value through the ORM. Pin the resolver behaviour
    // unit-style instead — the route hands the org's `defaultLanguage`
    // directly to `isSupportedWalletTopupRefundDigestLang` /
    // `resolveWalletTopupRefundDigestLang`, so this test pair covers the
    // full mapping the route applies for both null and future-but-
    // untranslated values.
    const { resolveWalletTopupRefundDigestLang, isSupportedWalletTopupRefundDigestLang } =
      await import("../lib/walletTopupRefundDigestI18n.js");
    expect(resolveWalletTopupRefundDigestLang("klingon")).toBe("en");
    expect(isSupportedWalletTopupRefundDigestLang("klingon")).toBe(false);
    expect(resolveWalletTopupRefundDigestLang(null)).toBe("en");
    expect(isSupportedWalletTopupRefundDigestLang(null)).toBe(false);
  });

  it("send-preview emails the digest to the requester's own inbox in the resolved language", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgId}`)
      .expect(200);

    expect(res.body.sentTo).toBe(adminEmail);
    expect(res.body.language).toBe("es");
    expect(typeof res.body.rowCount).toBe("number");
    expect(typeof res.body.currencyCount).toBe("number");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.to).toBe(adminEmail);
    expect(call.lang).toBe("es");
    // The schedule's configured recipients (finance@/ops@) must NOT
    // receive the preview — only the requesting treasurer.
    expect(call.to).not.toContain("finance@example.test");
    expect(call.to).not.toContain("ops@example.test");
  });

  it("send-preview does not record a run row or advance lastSentAt/nextRunAt", async () => {
    const before = await db
      .select()
      .from(walletTopupRefundEmailSchedulesTable)
      .where(eq(walletTopupRefundEmailSchedulesTable.id, scheduleId));
    const beforeNextRun = before[0].nextRunAt;
    const beforeLastSent = before[0].lastSentAt;

    const app = createTestApp(admin);
    await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgId}`)
      .expect(200);

    const runs = await db
      .select()
      .from(walletTopupRefundEmailRunsTable)
      .where(eq(walletTopupRefundEmailRunsTable.scheduleId, scheduleId));
    expect(runs).toHaveLength(0);

    const after = await db
      .select()
      .from(walletTopupRefundEmailSchedulesTable)
      .where(eq(walletTopupRefundEmailSchedulesTable.id, scheduleId));
    expect(after[0].nextRunAt?.getTime()).toBe(beforeNextRun?.getTime());
    expect(after[0].lastSentAt).toBe(beforeLastSent);
  });

  it("send-preview returns 404 when the org has no schedule configured", async () => {
    await db.delete(walletTopupRefundEmailSchedulesTable).where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));

    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgId}`)
      .expect(404);

    expect(res.body.error).toMatch(/no.*schedule/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  // Task #1746 — treasurers can override the preview language without
  // mutating the schedule or the org default.
  it("send-preview honours an explicit `lang` body override", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgId}`)
      .send({ lang: "ja" })
      .expect(200);

    expect(res.body.sentTo).toBe(adminEmail);
    expect(res.body.language).toBe("ja");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].lang).toBe("ja");
  });

  it("send-preview falls back to the org default when no `lang` override is sent", async () => {
    const app = createTestApp(admin);
    // Send no body — mirrors the original one-click behaviour for users
    // who never touch the picker.
    const res = await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgId}`)
      .expect(200);

    expect(res.body.language).toBe("es");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].lang).toBe("es");
  });

  it("send-preview treats an empty-string `lang` the same as omitting it", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgId}`)
      .send({ lang: "" })
      .expect(200);

    expect(res.body.language).toBe("es");
    expect(sendMock.mock.calls[0][0].lang).toBe("es");
  });

  it("send-preview rejects an unsupported `lang` with a 400 instead of silently falling back to English", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgId}`)
      .send({ lang: "klingon" })
      .expect(400);

    expect(res.body.error).toMatch(/unsupported preview language/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("send-preview with an override does not mutate the schedule or the org's defaultLanguage", async () => {
    const app = createTestApp(admin);
    await request(app)
      .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgId}`)
      .send({ lang: "fr" })
      .expect(200);

    const [orgAfter] = await db.select({
      defaultLanguage: organizationsTable.defaultLanguage,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(orgAfter.defaultLanguage).toBe("es");

    const [schedAfter] = await db.select()
      .from(walletTopupRefundEmailSchedulesTable)
      .where(eq(walletTopupRefundEmailSchedulesTable.id, scheduleId));
    expect(schedAfter.lastSentAt).toBeNull();
  });

  // Task #2161 — the in-page "Preview" modal (GET .../preview) now
  // honours the same `lang` picker as the sibling send-preview POST so
  // a treasurer can spot-check translations inline without round-
  // tripping through their inbox. Same 21-language allowlist; same
  // 400-on-unsupported behaviour. Default (no `lang` query) still
  // resolves to the org default so the one-click "Preview" button is
  // unchanged.
  it("GET preview renders the digest in the org default when no `lang` query is provided", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule/preview?organizationId=${orgId}`)
      .expect(200);

    // Org default is "es" (set in beforeEach) — Spanish subject string
    // pulled from the digest pack confirms the body was rendered in
    // the expected locale rather than the previous English-only path.
    expect(res.body.subject).toContain("Resumen semanal de reembolsos automáticos");
  });

  it("GET preview honours an explicit `lang` query override", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule/preview?organizationId=${orgId}&lang=ja`)
      .expect(200);

    // Japanese pack subject — proves the override beat the org default
    // for this preview render.
    expect(res.body.subject).toContain("ウォレット自動返金の週次ダイジェスト");
  });

  it("GET preview treats an empty-string `lang` query the same as omitting it", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule/preview?organizationId=${orgId}&lang=`)
      .expect(200);

    expect(res.body.subject).toContain("Resumen semanal de reembolsos automáticos");
  });

  it("GET preview rejects an unsupported `lang` query with a 400 instead of silently falling back to English", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule/preview?organizationId=${orgId}&lang=klingon`)
      .expect(400);

    expect(res.body.error).toMatch(/unsupported preview language/i);
  });

  it("GET preview with an override does not mutate the schedule or the org's defaultLanguage", async () => {
    const app = createTestApp(admin);
    await request(app)
      .get(`/api/admin/wallet-topup-refunds/email-schedule/preview?organizationId=${orgId}&lang=fr`)
      .expect(200);

    const [orgAfter] = await db.select({
      defaultLanguage: organizationsTable.defaultLanguage,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(orgAfter.defaultLanguage).toBe("es");

    const [schedAfter] = await db.select()
      .from(walletTopupRefundEmailSchedulesTable)
      .where(eq(walletTopupRefundEmailSchedulesTable.id, scheduleId));
    expect(schedAfter.lastSentAt).toBeNull();
  });

  it("send-preview rejects callers without an email on file", async () => {
    const tag = uid("t1436_no_email");
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: tag,
      username: tag,
      email: null,
      displayName: "No Email Admin",
      role: "org_admin",
      organizationId: orgId,
    }).returning({ id: appUsersTable.id });
    try {
      const noEmailUser: TestUser = {
        id: u.id,
        username: tag,
        role: "org_admin",
        organizationId: orgId,
      };
      const app = createTestApp(noEmailUser);
      const res = await request(app)
        .post(`/api/admin/wallet-topup-refunds/email-schedule/send-preview?organizationId=${orgId}`)
        .expect(400);

      expect(res.body.error).toMatch(/email/i);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      await db.delete(appUsersTable).where(eq(appUsersTable.id, u.id));
    }
  });
});
