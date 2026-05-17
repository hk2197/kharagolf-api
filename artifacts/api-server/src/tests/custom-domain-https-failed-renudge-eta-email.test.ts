/**
 * Task #1255 — The HTTPS-failed admin email tells admins when the next
 * re-nudge will land, so even admins who never open the in-app panel know
 * what to expect. The date is computed from
 * `CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS` so it stays in sync with the
 * threshold + the in-app panel line added by Task #1100.
 *
 * This file mocks the mailer module to inspect the args our route code
 * passes to `sendCustomDomainHttpsFailedEmail`. A sibling test file
 * (`custom-domain-cert-email-i18n.test.ts`) mocks nodemailer instead so
 * it can assert on the *rendered* HTML — see the new ETA-rendering case
 * added there.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

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

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

async function makeOrgWithAdmin(opts: {
  defaultLanguage: string | null;
  host: string;
}): Promise<{ orgId: number; adminEmail: string }> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: `TestOrg_HTTPSReNudgeETA_${stamp}`,
      slug: `test-https-eta-${stamp}`,
      subscriptionTier: "enterprise",
      customDomain: opts.host,
      customDomainCertStatus: "pending",
      customDomainCertNotifiedStatus: "pending",
      customDomainCertNotifiedHost: opts.host,
      ...(opts.defaultLanguage ? { defaultLanguage: opts.defaultLanguage as "en" } : {}),
    })
    .returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);

  const adminEmail = `https-eta-admin_${stamp}@example.com`;
  const [user] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `https-eta-replit_${stamp}`,
      username: `https-eta-admin_${stamp}`,
      displayName: "ETA Tester",
      email: adminEmail,
      role: "org_admin",
      organizationId: org.id,
    })
    .returning({ id: appUsersTable.id });
  createdUserIds.push(user.id);

  return { orgId: org.id, adminEmail };
}

beforeAll(() => {
  process.env.INGRESS_PROVIDER = "mock";
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  mailerSpies.sendCustomDomainHttpsFailedEmail.mockClear();
  mailerSpies.sendCustomDomainHttpsActiveEmail.mockClear();
});

describe("Task #1255 — failed-cert email passes the next re-nudge ETA", () => {
  it("passes nextReminderAt = notifiedAt + threshold on the initial failed transition", async () => {
    const host = `eta-initial-${Date.now()}.example.com`;
    const { orgId, adminEmail } = await makeOrgWithAdmin({
      defaultLanguage: "en",
      host,
    });
    const before = Date.now();

    await notifyCustomDomainCertTransition({
      orgId,
      host,
      status: "failed",
      errorMessage: "DNS not pointing to ingress",
    });

    const after = Date.now();
    const calls = mailerSpies.sendCustomDomainHttpsFailedEmail.mock.calls.filter(
      (c) => (c[0] as { to: string }).to === adminEmail,
    );
    expect(calls).toHaveLength(1);
    const arg = calls[0][0] as { nextReminderAt: Date | null | undefined };
    expect(arg.nextReminderAt).toBeInstanceOf(Date);
    const ts = (arg.nextReminderAt as Date).getTime();
    // Should be approximately notifiedAt (≈ now) + threshold days. We allow
    // a generous slack on each side so a slow DB write doesn't flake the test.
    const expectedMin = before + CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS * 24 * 60 * 60 * 1000;
    const expectedMax = after + CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS * 24 * 60 * 60 * 1000;
    expect(ts).toBeGreaterThanOrEqual(expectedMin - 1_000);
    expect(ts).toBeLessThanOrEqual(expectedMax + 1_000);
  });

  it("passes nextReminderAt = now + threshold on a re-nudge", async () => {
    const host = `eta-renudge-${Date.now()}.example.com`;
    const { orgId, adminEmail } = await makeOrgWithAdmin({
      defaultLanguage: "en",
      host,
    });
    // Park the org in failed state with notifiedAt older than the threshold
    // so the re-nudge job picks it up.
    const stale = new Date(Date.now() - (CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1) * 24 * 60 * 60 * 1000);
    await db.update(organizationsTable).set({
      customDomainCertStatus: "failed",
      customDomainCertError: "still bad",
      customDomainCertNotifiedStatus: "failed",
      customDomainCertNotifiedHost: host,
      customDomainCertNotifiedAt: stale,
    }).where(eq(organizationsTable.id, orgId));
    mailerSpies.sendCustomDomainHttpsFailedEmail.mockClear();

    const before = Date.now();
    await renudgeStaleCustomDomainHttpsFailures();
    const after = Date.now();

    const calls = mailerSpies.sendCustomDomainHttpsFailedEmail.mock.calls.filter(
      (c) => (c[0] as { to: string }).to === adminEmail,
    );
    expect(calls).toHaveLength(1);
    const arg = calls[0][0] as { nextReminderAt: Date | null | undefined };
    expect(arg.nextReminderAt).toBeInstanceOf(Date);
    const ts = (arg.nextReminderAt as Date).getTime();
    const expectedMin = before + CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS * 24 * 60 * 60 * 1000;
    const expectedMax = after + CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS * 24 * 60 * 60 * 1000;
    expect(ts).toBeGreaterThanOrEqual(expectedMin - 1_000);
    expect(ts).toBeLessThanOrEqual(expectedMax + 1_000);
  });

  it("does NOT call the failed mailer for an 'active' transition (ETA is failure-specific)", async () => {
    const host = `eta-active-${Date.now()}.example.com`;
    const { orgId } = await makeOrgWithAdmin({
      defaultLanguage: "en",
      host,
    });

    await notifyCustomDomainCertTransition({
      orgId,
      host,
      status: "active",
      errorMessage: null,
    });

    // Active path goes through a different mailer that doesn't take an ETA.
    expect(mailerSpies.sendCustomDomainHttpsActiveEmail).toHaveBeenCalled();
    expect(mailerSpies.sendCustomDomainHttpsFailedEmail).not.toHaveBeenCalled();
  });

  it("every supported language pack ships a non-empty nextReminder string with {date}", () => {
    const langs = [
      "en", "hi", "ar", "es", "fr", "de", "pt",
      "ja", "ko", "zh", "th", "ms", "id", "vi",
      "fil", "sw", "af", "am", "ha", "zu", "yo",
    ] as const;
    for (const l of langs) {
      const str = getCustomDomainEmailStrings(l).failed.nextReminder;
      expect(str.length, `lang ${l} must have a translated nextReminder`).toBeGreaterThan(0);
      expect(str, `lang ${l} must use the {date} placeholder`).toContain("{date}");
    }
    // The Hindi sentence must differ from English (smoke check that we
    // didn't accidentally copy-paste English into another pack).
    expect(getCustomDomainEmailStrings("hi").failed.nextReminder).not.toBe(
      getCustomDomainEmailStrings("en").failed.nextReminder,
    );
  });
});
