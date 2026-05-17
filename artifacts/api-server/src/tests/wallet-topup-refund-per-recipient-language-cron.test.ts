/**
 * Task #2170 — wallet auto-refund digest cron must localise the digest
 * *per recipient* (using each recipient's `app_users.preferredLanguage`,
 * with the org's resolved `defaultLanguage` as fallback for external
 * recipients) and dispatch one rendered digest per language group.
 *
 * Pre-#2170 the cron rendered the digest in a single org-wide language
 * and blasted it to every recipient — so a finance team whose members
 * had set per-user preferences silently received the wrong translation.
 * This suite pins:
 *
 *   1. The cron makes one mailer call per distinct resolved language
 *      (not one per recipient, and not one org-wide blast).
 *   2. Each mailer call's `to` array contains exactly the recipients
 *      whose resolved language matches that call's `lang`.
 *   3. Internal users with a *supported* `preferredLanguage` get that
 *      language; external recipients (no `app_users` row) fall back to
 *      the org's resolved `defaultLanguage`.
 *   4. The run row's `recipientLanguages` jsonb column snapshots the
 *      per-recipient attribution so the history dashboard stays
 *      accurate even after a user later changes their preference.
 *   5. When one language group's mailer call throws, the *other*
 *      groups still go out and the run row is recorded as `failed`
 *      with an aggregated errorMessage tagged by the failing
 *      language. The `recipients` column on the run row reflects only
 *      the successfully-delivered groups.
 *
 * Note on coverage gaps: the digest's translation pack covers every
 * value in the `supported_language` Postgres enum, and
 * `app_users.preferredLanguage` is `NOT NULL` with default `"en"` —
 * so an "unsupported preference" or a literally-null preference can't
 * arise from real data. The cron's defensive branches that fall back
 * to the org default in those cases are still in place; they are
 * exercised by `wallet-topup-refund-recipient-languages.test.ts` via
 * the editor's `recipientLanguages` enrichment, which uses the same
 * `resolveRecipientDigestLanguage` helper as the cron itself.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendWalletTopupRefundScheduleEmail: vi.fn(async () => {}),
  };
});

vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (uids: number[]) => ({
      attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
    })),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  walletTopupRefundEmailSchedulesTable,
  walletTopupRefundEmailRunsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { runOneWalletTopupRefundEmailSchedule } from "../routes/side-games-v2.js";
import { sendWalletTopupRefundScheduleEmail } from "../lib/mailer.js";
import { uid } from "./helpers.js";

const sendMock = vi.mocked(sendWalletTopupRefundScheduleEmail);

let orgId: number;
let internalEnUserId: number;
let internalEsUserId: number;
let scheduleId: number;

const internalEnEmail = "en_user@org.test";
const internalEsEmail = "es_user@org.test";
const externalEmail = "external_accountant@external.test";

beforeAll(async () => {
  const tag = uid("t2170");
  // Org default is "es" so we can verify external recipients fall back
  // to "es" while internal users with their own supported preference
  // (e.g. "en") get "en" instead.
  const [org] = await db.insert(organizationsTable).values({
    name: `T2170 ${tag}`,
    slug: tag,
    contactEmail: `${tag}@example.test`,
    defaultLanguage: "es",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [enUser] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-en`,
    username: `${tag}_en`,
    email: internalEnEmail,
    displayName: "EN User",
    role: "player",
    organizationId: orgId,
    preferredLanguage: "en",
  }).returning({ id: appUsersTable.id });
  internalEnUserId = enUser.id;

  const [esUser] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-es`,
    username: `${tag}_es`,
    email: internalEsEmail,
    displayName: "ES User",
    role: "player",
    organizationId: orgId,
    preferredLanguage: "es",
  }).returning({ id: appUsersTable.id });
  internalEsUserId = esUser.id;
});

afterAll(async () => {
  await db.delete(walletTopupRefundEmailRunsTable).where(eq(walletTopupRefundEmailRunsTable.organizationId, orgId));
  await db.delete(walletTopupRefundEmailSchedulesTable).where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [internalEnUserId, internalEsUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendMock.mockClear();
  sendMock.mockImplementation(async () => {});
  await db.delete(walletTopupRefundEmailRunsTable).where(eq(walletTopupRefundEmailRunsTable.organizationId, orgId));
  await db.delete(walletTopupRefundEmailSchedulesTable).where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));

  const [s] = await db.insert(walletTopupRefundEmailSchedulesTable).values({
    organizationId: orgId,
    frequency: "weekly",
    // Mix of: external (no app_user row → org-default fallback "es"),
    // internal "es" (matches org default), internal "en" (different
    // from org default — should be split into its own group). The
    // "es" bucket should therefore contain two recipients (external
    // + es-pref) and the "en" bucket exactly one.
    recipients: [externalEmail, internalEsEmail, internalEnEmail],
    nextRunAt: new Date(),
  }).returning({ id: walletTopupRefundEmailSchedulesTable.id });
  scheduleId = s.id;
});

describe("Task #2170 — wallet auto-refund digest is localised per-recipient", () => {
  it("dispatches one mailer call per distinct resolved language with the right recipients in each group", async () => {
    const result = await runOneWalletTopupRefundEmailSchedule(scheduleId);

    expect(result.status).toBe("sent");
    // All three recipients survive the suppression filter (none are
    // bounced) so the run records every address.
    expect(result.recipients?.sort()).toEqual([
      externalEmail, internalEnEmail, internalEsEmail,
    ].sort());

    // Two distinct resolved languages → two mailer calls (NOT one
    // per recipient, NOT one org-wide call).
    expect(sendMock).toHaveBeenCalledTimes(2);

    const callsByLang = new Map<string, { to: string[]; lang: string }>();
    for (const call of sendMock.mock.calls) {
      const args = call[0]!;
      callsByLang.set(args.lang as string, {
        to: Array.isArray(args.to) ? [...args.to] : [args.to as string],
        lang: args.lang as string,
      });
    }

    // The "en" bucket contains exactly the en-preferring user.
    const enCall = callsByLang.get("en");
    expect(enCall).toBeDefined();
    expect(enCall!.to).toEqual([internalEnEmail]);

    // The "es" bucket contains the external recipient (org default
    // fallback) and the es-preferring user.
    const esCall = callsByLang.get("es");
    expect(esCall).toBeDefined();
    expect(esCall!.to.sort()).toEqual([externalEmail, internalEsEmail].sort());
  });

  it("snapshots the per-recipient language attribution onto the run row", async () => {
    await runOneWalletTopupRefundEmailSchedule(scheduleId);

    const [run] = await db.select().from(walletTopupRefundEmailRunsTable)
      .where(eq(walletTopupRefundEmailRunsTable.scheduleId, scheduleId));
    expect(run).toBeDefined();
    expect(run.status).toBe("sent");

    expect(Array.isArray(run.recipientLanguages)).toBe(true);
    const byEmail = new Map(run.recipientLanguages.map(r => [r.email, r.language]));
    expect(byEmail.size).toBe(3);
    expect(byEmail.get(externalEmail)).toBe("es");
    expect(byEmail.get(internalEsEmail)).toBe("es");
    expect(byEmail.get(internalEnEmail)).toBe("en");
  });

  it("records a failed run (with the language tag in errorMessage) when one language group's send throws, while the other group still goes out", async () => {
    // Make ONLY the "en" group's send fail. The "es" group must still
    // be dispatched — a partial-language failure must not silently
    // swallow the digest for the rest of the org.
    sendMock.mockImplementation(async (args) => {
      if (args.lang === "en") throw new Error("Postmark 422 InactiveRecipient");
    });

    const result = await runOneWalletTopupRefundEmailSchedule(scheduleId);

    expect(result.status).toBe("failed");
    // Both groups were attempted, so the mailer was called twice.
    expect(sendMock).toHaveBeenCalledTimes(2);

    // The run row's `recipients` column reflects the recipients we
    // *actually* delivered to (the "es" bucket only) — the failed
    // "en" group's lone recipient must NOT appear here.
    const [run] = await db.select().from(walletTopupRefundEmailRunsTable)
      .where(eq(walletTopupRefundEmailRunsTable.scheduleId, scheduleId));
    expect(run.status).toBe("failed");
    expect(run.recipients?.sort()).toEqual([externalEmail, internalEsEmail].sort());
    expect(run.recipients).not.toContain(internalEnEmail);

    // Task #2170 — the function return contract must match the run row:
    // `recipients` exposed to the API caller is the delivered-only set,
    // so dashboards reading the response see the same list as the row.
    expect(result.recipients?.sort()).toEqual([externalEmail, internalEsEmail].sort());
    expect(result.recipients).not.toContain(internalEnEmail);

    // The aggregated errorMessage must tag the failing language so
    // ops can tell which translation rendered or which inbox blew up.
    expect(run.errorMessage).toMatch(/\[en\]/);
    expect(run.errorMessage).toMatch(/Postmark/);

    // The recipientLanguages snapshot still records the *attempted*
    // attribution (so the dashboard can show "en_user was bucketed
    // into en, then the en send failed") — the snapshot is not
    // pruned to only the delivered recipients.
    const byEmail = new Map(run.recipientLanguages.map(r => [r.email, r.language]));
    expect(byEmail.get(internalEnEmail)).toBe("en");
    expect(byEmail.get(internalEsEmail)).toBe("es");
  });
});
