/**
 * Task #950 — Verify the custom-domain HTTPS admin emails (active / failed)
 * are rendered in the org's `defaultLanguage`.
 *
 * Task #817 wired per-language rendering for these two emails but no
 * automated test guarded the wiring. A regression that drops the `lang`
 * parameter or breaks a translation key would silently send English to a
 * Hindi/Arabic/Spanish club.
 *
 * This test mocks nodemailer's transport so we can capture the *final*
 * subject + html that would be sent for each (org, status) combination,
 * then asserts each captured payload contains the localised subject +
 * heading defined in `customDomainEmailI18n.ts`. It also verifies that an
 * unsupported language code falls back to English without throwing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Set Gmail env vars BEFORE the email adapter is imported so its
// module-level credential check passes and `sendMail` actually invokes the
// (mocked) transport instead of throwing on the credentials guard.
vi.hoisted(() => {
  process.env.GMAIL_USER = process.env.GMAIL_USER || "test@example.com";
  process.env.GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "test-app-password";
  process.env.EMAIL_PROVIDER = "gmail";
});

const sendMailMock = vi.hoisted(() => vi.fn(async (_opts: { to: string; subject: string; html: string; [k: string]: unknown }) => ({ messageId: "test" })));

vi.mock("nodemailer", () => {
  const transport = { sendMail: sendMailMock };
  return {
    default: { createTransport: () => transport },
    createTransport: () => transport,
  };
});

import { db } from "@workspace/db";
import { organizationsTable, appUsersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  notifyCustomDomainCertTransition,
  CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS,
} from "../routes/organizations.js";
import {
  getCustomDomainEmailStrings,
  fmtTemplate,
  type CustomDomainEmailLang,
} from "../lib/customDomainEmailI18n.js";

interface CapturedMail {
  to: string;
  subject: string;
  html: string;
}

function capturedMails(): CapturedMail[] {
  return sendMailMock.mock.calls.map((c) => ({
    to: c[0]!.to,
    subject: c[0]!.subject,
    html: c[0]!.html,
  }));
}

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
      name: `TestOrg_CDI18n_${stamp}`,
      slug: `test-cdi18n-${stamp}`,
      subscriptionTier: "enterprise",
      // Pre-seed the cert columns so the dedup UPDATE fires (the test calls
      // `notifyCustomDomainCertTransition` directly without going through
      // PATCH branding, which would normally seed these).
      customDomain: opts.host,
      customDomainCertStatus: "pending",
      // Stamp a known prior state so each transition we trigger is
      // genuinely a state change and the dedup UPDATE claims the slot.
      customDomainCertNotifiedStatus: "pending",
      customDomainCertNotifiedHost: opts.host,
      // defaultLanguage may legitimately be null/undefined in some orgs;
      // pass it through unchanged so the fallback path is also exercised.
      ...(opts.defaultLanguage ? { defaultLanguage: opts.defaultLanguage as "en" } : {}),
    })
    .returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);

  const adminEmail = `cdi18n_admin_${stamp}@example.com`;
  const [user] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `cdi18n_replit_${stamp}`,
      username: `cdi18n_admin_${stamp}`,
      displayName: "Admin Tester",
      email: adminEmail,
      role: "org_admin",
      organizationId: org.id,
    })
    .returning({ id: appUsersTable.id });
  createdUserIds.push(user.id);

  return { orgId: org.id, adminEmail };
}

beforeAll(() => {
  // Force mock ingress so any indirect calls don't reach the network.
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
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: "test" });
});

/**
 * Helper: assert a captured mail payload contains the EXACT localised
 * subject and heading from the i18n pack for the given (lang, kind).
 */
function expectLocalisedMail(
  mail: CapturedMail,
  lang: CustomDomainEmailLang,
  kind: "active" | "failed",
  vars: { host: string; orgName: string },
) {
  const strings = getCustomDomainEmailStrings(lang);
  const expectedSubject = strings[kind].subject
    .replace("{host}", vars.host)
    .replace("{orgName}", vars.orgName);
  expect(mail.subject).toBe(expectedSubject);
  // The heading is rendered into an <h2> verbatim (no placeholders).
  expect(mail.html).toContain(strings[kind].heading);
  // Sanity: the header tag (also localised) should appear in the header block.
  expect(mail.html).toContain(strings.headerTag);
}

describe("Task #950 — custom-domain HTTPS admin email is rendered in the club's language", () => {
  it("renders the 'active' email in Hindi for an org with defaultLanguage='hi'", async () => {
    const host = `hi-active-${Date.now()}.example.com`;
    const { orgId, adminEmail } = await makeOrgWithAdmin({
      defaultLanguage: "hi",
      host,
    });

    await notifyCustomDomainCertTransition({
      orgId,
      host,
      status: "active",
      errorMessage: null,
    });

    const mails = capturedMails().filter((m) => m.to === adminEmail);
    expect(mails).toHaveLength(1);
    const [orgRow] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expectLocalisedMail(mails[0], "hi", "active", { host, orgName: orgRow.name });
    // Spot-check we didn't accidentally render the English heading.
    const en = getCustomDomainEmailStrings("en");
    expect(mails[0].html).not.toContain(en.active.heading);
  });

  it("renders the 'failed' email in Hindi for an org with defaultLanguage='hi'", async () => {
    const host = `hi-failed-${Date.now()}.example.com`;
    const { orgId, adminEmail } = await makeOrgWithAdmin({
      defaultLanguage: "hi",
      host,
    });

    await notifyCustomDomainCertTransition({
      orgId,
      host,
      status: "failed",
      errorMessage: "DNS not pointing to ingress",
    });

    const mails = capturedMails().filter((m) => m.to === adminEmail);
    expect(mails).toHaveLength(1);
    const [orgRow] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expectLocalisedMail(mails[0], "hi", "failed", { host, orgName: orgRow.name });
    // The provider-error label + the upstream error message both appear.
    const hi = getCustomDomainEmailStrings("hi");
    expect(mails[0].html).toContain(hi.failed.providerErrorLabel);
    expect(mails[0].html).toContain("DNS not pointing to ingress");
    const en = getCustomDomainEmailStrings("en");
    expect(mails[0].html).not.toContain(en.failed.heading);
  });

  it("renders the 'active' email in English for an org with defaultLanguage='en'", async () => {
    const host = `en-active-${Date.now()}.example.com`;
    const { orgId, adminEmail } = await makeOrgWithAdmin({
      defaultLanguage: "en",
      host,
    });

    await notifyCustomDomainCertTransition({
      orgId,
      host,
      status: "active",
      errorMessage: null,
    });

    const mails = capturedMails().filter((m) => m.to === adminEmail);
    expect(mails).toHaveLength(1);
    const [orgRow] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expectLocalisedMail(mails[0], "en", "active", { host, orgName: orgRow.name });
  });

  it("renders the 'failed' email in English for an org with defaultLanguage='en'", async () => {
    const host = `en-failed-${Date.now()}.example.com`;
    const { orgId, adminEmail } = await makeOrgWithAdmin({
      defaultLanguage: "en",
      host,
    });

    await notifyCustomDomainCertTransition({
      orgId,
      host,
      status: "failed",
      errorMessage: null, // null exercises the localised noReason fallback
    });

    const mails = capturedMails().filter((m) => m.to === adminEmail);
    expect(mails).toHaveLength(1);
    const [orgRow] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expectLocalisedMail(mails[0], "en", "failed", { host, orgName: orgRow.name });
    // When errorMessage is null the localised "noReason" copy is shown.
    const en = getCustomDomainEmailStrings("en");
    expect(mails[0].html).toContain(en.failed.noReason);
  });

  it("includes the localised next-reminder ETA sentence with the threshold-derived date (Task #1255)", async () => {
    const host = `eta-render-${Date.now()}.example.com`;
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

    const mails = capturedMails().filter((m) => m.to === adminEmail);
    expect(mails).toHaveLength(1);
    const html = mails[0].html;

    // The ETA sentence must be rendered with the localised long-format date
    // computed from CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS. Allow a small
    // window because the cert-notify and the test capture the time
    // independently — the date label is the same as long as both sides land
    // on the same calendar day, which a ~1-day window guarantees.
    const en = getCustomDomainEmailStrings("en").failed;
    const fmt = new Intl.DateTimeFormat("en", { dateStyle: "long" });
    const candidates = new Set<string>();
    for (let offsetMs = -1_000; offsetMs <= 60_000; offsetMs += 1_000) {
      const eta = new Date(before + offsetMs + CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS * 24 * 60 * 60 * 1000);
      candidates.add(fmt.format(eta));
    }
    const sentence = en.nextReminder.replace("{date}", "");
    // The localised intro sentence (sans the date) must always appear.
    expect(html).toContain(sentence.split("{")[0].trim().slice(0, 20));
    // And at least one of our threshold-derived dates must appear in the body.
    const matched = [...candidates].some((d) => html.includes(d));
    expect(matched, `Expected the rendered HTML to include one of the candidate dates ${[...candidates].join(", ")}`).toBe(true);

    // Belt-and-braces: the rendered substring should equal the templated
    // sentence with one of those dates substituted.
    const sentenceMatches = [...candidates].some((d) =>
      html.includes(fmtTemplate(en.nextReminder, { date: d })),
    );
    expect(sentenceMatches).toBe(true);
  });

  it("renders the ETA sentence in Hindi for a Hindi org", async () => {
    const host = `eta-render-hi-${Date.now()}.example.com`;
    const { orgId, adminEmail } = await makeOrgWithAdmin({
      defaultLanguage: "hi",
      host,
    });

    await notifyCustomDomainCertTransition({
      orgId,
      host,
      status: "failed",
      errorMessage: "DNS not pointing to ingress",
    });

    const mails = capturedMails().filter((m) => m.to === adminEmail);
    expect(mails).toHaveLength(1);
    const html = mails[0].html;
    const hi = getCustomDomainEmailStrings("hi").failed;
    // The localised intro fragment must appear (sans the {date} placeholder).
    const introFragment = hi.nextReminder.split("{date}")[0].trim();
    expect(introFragment.length).toBeGreaterThan(0);
    expect(html).toContain(introFragment.slice(0, 10));
    // English ETA must NOT leak into the Hindi email.
    const en = getCustomDomainEmailStrings("en").failed;
    expect(html).not.toContain(en.nextReminder.split("{date}")[0].trim());
  });

  it("falls back to English (without throwing) for an unsupported language code", async () => {
    const host = `xx-active-${Date.now()}.example.com`;
    // Bypass the supported_language enum at the column level by writing the
    // language directly via an UPDATE that the schema would normally reject
    // — instead we simulate "unsupported lang" by passing null at insert
    // time and then forcing a bogus value through the i18n helper directly.
    // Functionally this matches what would happen if a future enum value
    // were added without a translation pack: `getCustomDomainEmailStrings`
    // returns the EN pack and the email renders fine.
    const { orgId, adminEmail } = await makeOrgWithAdmin({
      defaultLanguage: null,
      host,
    });

    // Sanity: helper returns EN pack for unknown codes and never throws.
    expect(() =>
      getCustomDomainEmailStrings("xx-not-a-real-lang"),
    ).not.toThrow();
    const fallback = getCustomDomainEmailStrings("xx-not-a-real-lang");
    const en = getCustomDomainEmailStrings("en");
    expect(fallback.active.heading).toBe(en.active.heading);
    expect(fallback.failed.heading).toBe(en.failed.heading);

    // End-to-end: orgs with no defaultLanguage hit the same fallback path
    // and the notify pipeline still delivers a (well-formed, English) email.
    await expect(
      notifyCustomDomainCertTransition({
        orgId,
        host,
        status: "active",
        errorMessage: null,
      }),
    ).resolves.not.toThrow();

    const mails = capturedMails().filter((m) => m.to === adminEmail);
    expect(mails).toHaveLength(1);
    const [orgRow] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expectLocalisedMail(mails[0], "en", "active", { host, orgName: orgRow.name });
  });
});
