/**
 * Task #1262 — Tell admins by email when a snooze ends and re-nudges resume.
 *
 * Verifies that when `renudgeStaleCustomDomainHttpsFailures` fires a re-nudge
 * because an admin's snooze window has just elapsed (vs simply because the
 * standard threshold passed), it:
 *   - Passes `previouslySnoozedUntil` (the snooze-until date the admin set)
 *     down to `sendCustomDomainHttpsFailedEmail` so the template can render
 *     a "you snoozed this until X — that snooze has now ended" header.
 *   - Atomically clears `customDomainCertRenudgeSnoozedUntil` on the org
 *     row so subsequent re-nudges in the same failure cycle don't repeat
 *     the same acknowledgement.
 *   - Does NOT pass `previouslySnoozedUntil` for re-nudges that fire purely
 *     because the threshold passed (no snooze was ever set).
 *   - Does NOT pass `previouslySnoozedUntil` on the initial failed
 *     transition (handled by `notifyCustomDomainCertTransition`, not the
 *     re-nudge job).
 *   - Translates the snoozeEnded line for all 21 supported languages.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const mailerSpies = vi.hoisted(() => ({
  sendCustomDomainHttpsFailedEmail: vi.fn(
    async (_opts: { to: string; nextReminderAt?: Date | null; previouslySnoozedUntil?: Date | null; [k: string]: unknown }) => undefined,
  ),
  sendCustomDomainHttpsActiveEmail: vi.fn(
    async (_opts: { to: string; [k: string]: unknown }) => undefined,
  ),
}));
vi.mock("../lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...orig,
    sendCustomDomainHttpsFailedEmail: mailerSpies.sendCustomDomainHttpsFailedEmail,
    sendCustomDomainHttpsActiveEmail: mailerSpies.sendCustomDomainHttpsActiveEmail,
  };
});

import { db } from "@workspace/db";
import { organizationsTable, appUsersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  notifyCustomDomainCertTransition,
  renudgeStaleCustomDomainHttpsFailures,
  CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS,
} from "../routes/organizations.js";
import { getCustomDomainEmailStrings } from "../lib/customDomainEmailI18n.js";

// Per-test cleanup tracking — tests in other files share the same DB and
// the renudge job scans all orgs, so we delete our rows immediately after
// each test (in afterEach) instead of waiting until afterAll. This shrinks
// the window where other concurrent test files see our failed orgs and
// pick them up in their renudge() calls.
const perTestOrgIds: number[] = [];
const perTestUserIds: number[] = [];

async function makeOrgWithAdmin(opts: { host: string }): Promise<{
  orgId: number;
  adminEmail: string;
}> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: `TestOrg_HTTPSReNudgeSnoozeEnded_${stamp}`,
      slug: `test-https-snooze-ended-${stamp}`,
      subscriptionTier: "enterprise",
      customDomain: opts.host,
    })
    .returning({ id: organizationsTable.id });
  perTestOrgIds.push(org.id);

  const adminEmail = `https-snooze-ended-admin_${stamp}@example.com`;
  const [user] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `https-snooze-ended-replit_${stamp}`,
      username: `https-snooze-ended-admin_${stamp}`,
      displayName: "Snooze-Ended Tester",
      email: adminEmail,
      role: "org_admin",
      organizationId: org.id,
    })
    .returning({ id: appUsersTable.id });
  perTestUserIds.push(user.id);

  return { orgId: org.id, adminEmail };
}

async function setOrgFailedState(
  orgId: number,
  host: string,
  notifiedAtDaysAgo: number,
  snoozedUntil: Date | null,
) {
  const notifiedAt = new Date(Date.now() - notifiedAtDaysAgo * 24 * 60 * 60 * 1000);
  await db
    .update(organizationsTable)
    .set({
      customDomainCertStatus: "failed",
      customDomainCertError: "DNS not pointing to ingress",
      customDomainCertNotifiedStatus: "failed",
      customDomainCertNotifiedHost: host,
      customDomainCertNotifiedAt: notifiedAt,
      customDomainCertRenudgeSnoozedUntil: snoozedUntil,
    })
    .where(eq(organizationsTable.id, orgId));
}

beforeAll(() => {
  process.env.INGRESS_PROVIDER = "mock";
});

afterAll(() => {
  // No-op — afterEach handles per-test cleanup. Kept defensively in case
  // a test throws before afterEach can record IDs.
});

beforeEach(() => {
  mailerSpies.sendCustomDomainHttpsFailedEmail.mockClear();
  mailerSpies.sendCustomDomainHttpsActiveEmail.mockClear();
});

afterEach(async () => {
  // Drop the rows this test created right away so they don't leak into
  // other concurrently-running test files' renudge() scans (vitest's
  // file-level parallelism in singleFork mode shares the DB across files).
  if (perTestUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, perTestUserIds));
    perTestUserIds.length = 0;
  }
  if (perTestOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, perTestOrgIds));
    perTestOrgIds.length = 0;
  }
});

describe("Task #1262 — re-nudge after snooze acknowledges the elapsed snooze", () => {
  it("passes previouslySnoozedUntil = snoozeEnd date when the snooze window has elapsed", async () => {
    const host = `snooze-ended-${Date.now()}.example.com`;
    const { orgId, adminEmail } = await makeOrgWithAdmin({ host });

    // Snooze that ended 1 day ago.
    const snoozedUntil = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await setOrgFailedState(
      orgId,
      host,
      CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
      snoozedUntil,
    );

    await renudgeStaleCustomDomainHttpsFailures();

    const calls = mailerSpies.sendCustomDomainHttpsFailedEmail.mock.calls.filter(
      (c) => (c[0] as { to: string }).to === adminEmail,
    );
    expect(calls).toHaveLength(1);
    const arg = calls[0][0] as { previouslySnoozedUntil: Date | null | undefined };
    expect(arg.previouslySnoozedUntil).toBeInstanceOf(Date);
    expect((arg.previouslySnoozedUntil as Date).getTime()).toBe(snoozedUntil.getTime());
  });

  it("clears customDomainCertRenudgeSnoozedUntil after the snooze-ended re-nudge fires", async () => {
    const host = `snooze-clear-${Date.now()}.example.com`;
    const { orgId } = await makeOrgWithAdmin({ host });

    const snoozedUntil = new Date(Date.now() - 12 * 60 * 60 * 1000);
    await setOrgFailedState(
      orgId,
      host,
      CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
      snoozedUntil,
    );

    await renudgeStaleCustomDomainHttpsFailures();

    const [row] = await db
      .select({
        snoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(row.snoozedUntil).toBeNull();
  });

  it("does NOT pass previouslySnoozedUntil for a threshold-only re-nudge (no snooze was ever set)", async () => {
    const host = `threshold-only-${Date.now()}.example.com`;
    const { orgId, adminEmail } = await makeOrgWithAdmin({ host });

    await setOrgFailedState(
      orgId,
      host,
      CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
      null,
    );

    await renudgeStaleCustomDomainHttpsFailures();

    const calls = mailerSpies.sendCustomDomainHttpsFailedEmail.mock.calls.filter(
      (c) => (c[0] as { to: string }).to === adminEmail,
    );
    expect(calls).toHaveLength(1);
    const arg = calls[0][0] as { previouslySnoozedUntil: Date | null | undefined };
    expect(arg.previouslySnoozedUntil ?? null).toBeNull();
  });

  it("does NOT pass previouslySnoozedUntil on the initial failed transition", async () => {
    const host = `initial-failed-${Date.now()}.example.com`;
    const { orgId, adminEmail } = await makeOrgWithAdmin({ host });

    await notifyCustomDomainCertTransition({
      orgId,
      host,
      status: "failed",
      errorMessage: "DNS not pointing to ingress",
    });

    const calls = mailerSpies.sendCustomDomainHttpsFailedEmail.mock.calls.filter(
      (c) => (c[0] as { to: string }).to === adminEmail,
    );
    expect(calls).toHaveLength(1);
    const arg = calls[0][0] as { previouslySnoozedUntil: Date | null | undefined };
    expect(arg.previouslySnoozedUntil ?? null).toBeNull();
  });

  it("every supported language pack ships a non-empty snoozeEnded string with {date}", () => {
    const langs = [
      "en", "hi", "ar", "es", "fr", "de", "pt",
      "ja", "ko", "zh", "th", "ms", "id", "vi",
      "fil", "sw", "af", "am", "ha", "zu", "yo",
    ] as const;
    for (const l of langs) {
      const str = getCustomDomainEmailStrings(l).failed.snoozeEnded;
      expect(str.length, `lang ${l} must have a translated snoozeEnded`).toBeGreaterThan(0);
      expect(str, `lang ${l} must use the {date} placeholder`).toContain("{date}");
    }
    // Smoke check: Hindi must differ from English so we didn't copy-paste.
    expect(getCustomDomainEmailStrings("hi").failed.snoozeEnded).not.toBe(
      getCustomDomainEmailStrings("en").failed.snoozeEnded,
    );
  });
});
