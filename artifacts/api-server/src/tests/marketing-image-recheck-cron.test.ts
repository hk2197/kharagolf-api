/**
 * Task #1249 — Background re-verification of saved external marketing
 * `logoImageUrl` / `faviconUrl` values.
 *
 * Coverage:
 *   1. A successful re-probe resets the failure counter + last error
 *      and stamps lastCheckedAt.
 *   2. A failed re-probe under the threshold increments the counter,
 *      stores the verifier error, and leaves the URL intact.
 *   3. A failed re-probe at-or-above the threshold auto-clears the URL,
 *      bumps cacheVersion, sends a push to org admins, and emails each
 *      org admin once with the dropped URL + last error.
 *   4. Internal `/objects/...` paths are skipped (the verifier is never
 *      consulted for them).
 *   5. The per-row backoff is honoured so the sweep can be polled
 *      aggressively without re-hitting the same external URL.
 *   6. A verifier that throws is treated as transient — the failure
 *      counter is NOT incremented, but lastCheckedAt + lastError are
 *      updated so admins still see we tried.
 *   7. Saving a fresh URL through PUT /api/organizations/:id/marketing-site
 *      resets the tracking columns so a stale counter can't auto-clear
 *      a freshly pasted replacement.
 *
 * ─── Test isolation pattern (Task #1808) ───────────────────────────────
 * The api-server test suite runs in a single vitest fork against a
 * shared dev DB, and the recheck cron iterates `club_marketing_sites`
 * globally. That means any row left behind by a sibling test file
 * (cache, refresh, by-host, library, …) — or vitest reordering files
 * so a sibling beforeAll runs first — would leak into this suite's
 * sweep results and break global summary-count assertions.
 *
 * To stay row-scoped:
 *   - Use unique source URLs (TEST_LOGO_URL / TEST_FAVICON_URL) so a
 *     scoped verifier stub can tell our row's URLs apart from any
 *     sibling row's URLs that happen to live in the same DB.
 *   - Wrap every verifier in `scopedVerifier(...)`. It returns the
 *     test's intended result for our URLs and an idempotent ok:true
 *     for any other URL, so the cron may still walk sibling rows but
 *     doesn't trip auto-clear or notification flows for them.
 *   - Assertions read THIS org's row state (via `loadRow()`) and
 *     check our admin push/email mocks for OUR admin user IDs only —
 *     never `summary.probesOk === N` style global counters.
 *
 * Future cron tests should follow the same pattern: scope verifier
 * stubs by URL/identifier, and assert against row-scoped state, not
 * sweep-wide totals.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-image-recheck-cron";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

const { sendTransactionalPushMock, sendMarketingImageBrokenEmailMock } = vi.hoisted(() => ({
  sendTransactionalPushMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 }),
  ),
  sendMarketingImageBrokenEmailMock: vi.fn(
    async (_opts: Record<string, unknown>) => undefined,
  ),
}));

vi.mock("../lib/comms.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/comms.js")>("../lib/comms.js");
  return {
    ...actual,
    sendTransactionalPush: sendTransactionalPushMock,
  };
});
vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendMarketingImageBrokenEmail: sendMarketingImageBrokenEmailMock,
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMarketingSitesTable,
  orgMembershipsTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { eq, inArray } from "drizzle-orm";
import {
  recheckExternalMarketingImages,
  _setMarketingImageRecheckTuningForTest,
} from "../lib/cron.js";
import {
  __setExternalImageVerifierForTests,
  MARKETING_LOGO_FAVICON_MAX_BYTES,
  type ExternalImageVerifyResult,
} from "../lib/externalImageVerifier.js";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let adminA: TestUser;
let adminB: TestUser;
const createdUserIds: number[] = [];
const createdMembershipUserIds: number[] = [];

// Test fixtures use unique URLs ("https://cdn.recheck-test…") so this
// suite can distinguish its own row from rows created by sibling test
// files that happen to live in the same DB while running in the same
// vitest fork. The `scopedVerifier` stub below also gates on these
// URLs so it doesn't accidentally process — or mutate the failure /
// last-error tracking on — those unrelated rows.
const TEST_LOGO_URL = "https://cdn.recheck-test.example.com/recheck-cron-logo.png";
const TEST_FAVICON_URL = "https://cdn.recheck-test.example.com/recheck-cron-favicon.ico";

/**
 * Build a verifier stub that returns the supplied result for ONLY the
 * URLs this test owns, and a benign ok:true for any other URL the
 * cron happens to encounter from sibling test rows. Returning ok:true
 * for siblings keeps assertions row-scoped without nudging unrelated
 * rows toward the auto-clear threshold.
 *
 * Pass a function instead of a result to make the verifier throw for
 * our URLs (transient-error path).
 */
function scopedVerifier(
  ourResult: ExternalImageVerifyResult | (() => never),
  opts?: { onOurCall?: (url: string, options?: { maxBytes?: number }) => void },
): (url: string, options?: { maxBytes?: number }) => Promise<ExternalImageVerifyResult> {
  return async (url, options) => {
    if (url !== TEST_LOGO_URL && url !== TEST_FAVICON_URL) {
      // Sibling row — return ok:true so we neither bump their failure
      // counter nor trip their auto-clear flow.
      return { ok: true };
    }
    opts?.onOurCall?.(url, options);
    if (typeof ourResult === "function") {
      ourResult();
      throw new Error("unreachable"); // keeps the type checker happy
    }
    return ourResult;
  };
}

async function makeUser(orgIdArg: number, role: OrgRole): Promise<TestUser> {
  const tag = uid(role);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@example.com`,
    displayName: tag,
    role,
    organizationId: orgIdArg,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName: tag, role, organizationId: orgIdArg };
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const slug = `mkt-recheck-${stamp}`.toLowerCase();
  const [org] = await db.insert(organizationsTable).values({
    name: `MktRecheck_${stamp}`,
    slug,
    isActive: true,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  // Two org admins so the dedup logic + per-recipient email loop both
  // get exercised. Admin A is org_admin via app_users.role; Admin B is
  // org_admin via org_memberships only — both should be reached.
  adminA = await makeUser(orgId, "org_admin");
  adminB = await makeUser(orgId, "player");
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: adminB.id,
    role: "org_admin",
  });
  createdMembershipUserIds.push(adminB.id);

  await db.insert(clubMarketingSitesTable).values({ organizationId: orgId });
});

afterAll(async () => {
  await db.delete(clubMarketingSitesTable).where(
    eq(clubMarketingSitesTable.organizationId, orgId),
  );
  if (createdMembershipUserIds.length) {
    await db.delete(orgMembershipsTable).where(
      inArray(orgMembershipsTable.userId, createdMembershipUserIds),
    );
  }
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendTransactionalPushMock.mockClear();
  sendMarketingImageBrokenEmailMock.mockClear();
  // Reset tuning + reset the marketing-site row to a known state with
  // both URLs populated and never-checked.
  _setMarketingImageRecheckTuningForTest({ perRowMs: 0, autoClearThreshold: 3 });
  await db.update(clubMarketingSitesTable).set({
    logoImageUrl: TEST_LOGO_URL,
    logoImageUrlLastCheckedAt: null,
    logoImageUrlConsecutiveFailures: 0,
    logoImageUrlLastError: null,
    faviconUrl: TEST_FAVICON_URL,
    faviconUrlLastCheckedAt: null,
    faviconUrlConsecutiveFailures: 0,
    faviconUrlLastError: null,
    cacheVersion: 1,
  }).where(eq(clubMarketingSitesTable.organizationId, orgId));
});

afterEach(() => {
  __setExternalImageVerifierForTests(null);
  _setMarketingImageRecheckTuningForTest(null);
});

async function loadRow() {
  const [row] = await db.select().from(clubMarketingSitesTable)
    .where(eq(clubMarketingSitesTable.organizationId, orgId));
  return row;
}

describe("Task #1249 — recheckExternalMarketingImages", () => {
  it("resets the failure counter + last error when the verifier reports ok", async () => {
    // Pre-stage a half-failed counter so we can prove ok wipes it out.
    await db.update(clubMarketingSitesTable).set({
      logoImageUrlConsecutiveFailures: 2,
      logoImageUrlLastError: "image host returned HTTP 500",
      faviconUrlConsecutiveFailures: 2,
      faviconUrlLastError: "image host did not respond within 8s",
    }).where(eq(clubMarketingSitesTable.organizationId, orgId));

    __setExternalImageVerifierForTests(scopedVerifier({ ok: true }));
    await recheckExternalMarketingImages();

    const row = await loadRow();
    expect(row.logoImageUrl).toBe(TEST_LOGO_URL);
    expect(row.logoImageUrlConsecutiveFailures).toBe(0);
    expect(row.logoImageUrlLastError).toBeNull();
    expect(row.logoImageUrlLastCheckedAt).toBeTruthy();
    expect(row.faviconUrl).toBe(TEST_FAVICON_URL);
    expect(row.faviconUrlConsecutiveFailures).toBe(0);
    expect(row.faviconUrlLastError).toBeNull();
    // Our org's admins were not pushed/emailed (nothing was cleared).
    for (const call of sendTransactionalPushMock.mock.calls) {
      const recipients = call[0] as number[];
      expect(recipients).not.toContain(adminA.id);
      expect(recipients).not.toContain(adminB.id);
    }
    expect(sendMarketingImageBrokenEmailMock).not.toHaveBeenCalled();
  });

  it("increments the failure counter without clearing when below threshold", async () => {
    __setExternalImageVerifierForTests(scopedVerifier({
      ok: false,
      error: "image host returned HTTP 503",
    }));
    await recheckExternalMarketingImages();

    const row = await loadRow();
    // URL still intact, counter ticked from 0 → 1 (well below threshold=3).
    expect(row.logoImageUrl).toBe(TEST_LOGO_URL);
    expect(row.logoImageUrlConsecutiveFailures).toBe(1);
    expect(row.logoImageUrlLastError).toContain("HTTP 503");
    expect(row.faviconUrl).toBe(TEST_FAVICON_URL);
    expect(row.faviconUrlConsecutiveFailures).toBe(1);
    expect(row.faviconUrlLastError).toContain("HTTP 503");
    for (const call of sendTransactionalPushMock.mock.calls) {
      const recipients = call[0] as number[];
      expect(recipients).not.toContain(adminA.id);
      expect(recipients).not.toContain(adminB.id);
    }
    expect(sendMarketingImageBrokenEmailMock).not.toHaveBeenCalled();
    // Nothing was cleared, so cacheVersion stays put.
    expect(row.cacheVersion).toBe(1);
  });

  it("auto-clears the URL, bumps cacheVersion, and notifies org admins at threshold", async () => {
    // Pre-stage so this single run crosses the threshold for the LOGO
    // (not the favicon — we want to prove only the failed kind is
    // touched, and that admins are notified per-image).
    await db.update(clubMarketingSitesTable).set({
      logoImageUrlConsecutiveFailures: 2, // +1 this pass = 3 = threshold
      logoImageUrlLastError: "image host returned HTTP 404",
      faviconUrl: null, // skip favicon entirely this run
      cacheVersion: 7,
    }).where(eq(clubMarketingSitesTable.organizationId, orgId));

    __setExternalImageVerifierForTests(scopedVerifier({
      ok: false,
      error: "image host returned HTTP 404",
    }));
    await recheckExternalMarketingImages();

    const row = await loadRow();
    // URL cleared, tracking reset, cacheVersion bumped.
    expect(row.logoImageUrl).toBeNull();
    expect(row.logoImageUrlConsecutiveFailures).toBe(0);
    expect(row.logoImageUrlLastError).toBeNull();
    expect(row.logoImageUrlLastCheckedAt).toBeTruthy();
    expect(row.cacheVersion).toBe(8);

    // Find OUR push call (sibling rows return ok:true so they don't
    // trigger a push at all, but assert by content not call count).
    const ourPushCalls = sendTransactionalPushMock.mock.calls.filter(call => {
      const recipients = call[0] as number[];
      return recipients.includes(adminA.id) || recipients.includes(adminB.id);
    });
    expect(ourPushCalls).toHaveLength(1);
    const pushedUserIds = ourPushCalls[0]![0] as number[];
    expect(pushedUserIds).toContain(adminA.id);
    expect(pushedUserIds).toContain(adminB.id);
    expect(pushedUserIds.length).toBe(2);

    // Each admin got one email with the dropped URL + last error.
    const ourEmailCalls = sendMarketingImageBrokenEmailMock.mock.calls.filter(call => {
      const args = call[0] as { to: string };
      return args.to === `${adminA.username}@example.com`
        || args.to === `${adminB.username}@example.com`;
    });
    expect(ourEmailCalls).toHaveLength(2);
    const emailedTo = ourEmailCalls.map(c => (c[0] as { to: string }).to);
    expect(emailedTo).toContain(`${adminA.username}@example.com`);
    expect(emailedTo).toContain(`${adminB.username}@example.com`);
    const firstArgs = ourEmailCalls[0]![0] as {
      imageKind: string;
      clearedUrl: string;
      consecutiveFailures: number;
      lastError: string | null;
    };
    expect(firstArgs.imageKind).toBe("logo");
    expect(firstArgs.clearedUrl).toBe(TEST_LOGO_URL);
    expect(firstArgs.consecutiveFailures).toBe(3);
    expect(firstArgs.lastError).toContain("HTTP 404");
  });

  it("does not consult the verifier for /objects/... internal paths", async () => {
    await db.update(clubMarketingSitesTable).set({
      logoImageUrl: "/objects/uploads/internal-logo",
      faviconUrl: "/objects/uploads/internal-favicon",
    }).where(eq(clubMarketingSitesTable.organizationId, orgId));

    // Track per-URL so unrelated sibling rows don't pollute the
    // assertion — we only care that OUR row's internal paths were
    // never probed.
    const calledForOurUrls: string[] = [];
    __setExternalImageVerifierForTests(async (url: string) => {
      if (url === TEST_LOGO_URL || url === TEST_FAVICON_URL
        || url === "/objects/uploads/internal-logo"
        || url === "/objects/uploads/internal-favicon") {
        calledForOurUrls.push(url);
        return { ok: false, error: "should-not-be-called-for-internal-paths" };
      }
      return { ok: true };
    });
    await recheckExternalMarketingImages();
    expect(calledForOurUrls).toHaveLength(0);

    // Our row's tracking is untouched (counters stayed at 0, no
    // lastError stamped from a verifier hit).
    const row = await loadRow();
    expect(row.logoImageUrlConsecutiveFailures).toBe(0);
    expect(row.logoImageUrlLastError).toBeNull();
    expect(row.faviconUrlConsecutiveFailures).toBe(0);
    expect(row.faviconUrlLastError).toBeNull();
  });

  it("honours the per-row backoff and skips a just-checked URL", async () => {
    // Mark both URLs as freshly checked.
    const justNow = new Date();
    await db.update(clubMarketingSitesTable).set({
      logoImageUrlLastCheckedAt: justNow,
      faviconUrlLastCheckedAt: justNow,
    }).where(eq(clubMarketingSitesTable.organizationId, orgId));

    // Pretend the per-row backoff is 1h so a just-checked row is in window.
    _setMarketingImageRecheckTuningForTest({ perRowMs: 60 * 60 * 1000, autoClearThreshold: 3 });

    const calledForOurUrls: string[] = [];
    __setExternalImageVerifierForTests(async (url: string) => {
      if (url === TEST_LOGO_URL || url === TEST_FAVICON_URL) {
        calledForOurUrls.push(url);
        return { ok: false, error: "should-not-be-probed" };
      }
      return { ok: true };
    });
    await recheckExternalMarketingImages();
    expect(calledForOurUrls).toHaveLength(0);

    // Our row's lastCheckedAt is still ~justNow and tracking is clean.
    const row = await loadRow();
    expect(row.logoImageUrlLastCheckedAt?.getTime()).toBeGreaterThanOrEqual(
      justNow.getTime() - 1000,
    );
    expect(row.logoImageUrlConsecutiveFailures).toBe(0);
    expect(row.logoImageUrlLastError).toBeNull();
  });

  it("treats a thrown verifier error as transient (no counter bump)", async () => {
    __setExternalImageVerifierForTests(scopedVerifier(() => {
      throw new Error("ECONNREFUSED outbound.example.com");
    }));
    await recheckExternalMarketingImages();

    const row = await loadRow();
    // Counter stays at 0 — the verifier blew up, that's our problem
    // not the admin's. lastCheckedAt + lastError still updated so
    // the next pass respects backoff and admins can see we tried.
    expect(row.logoImageUrlConsecutiveFailures).toBe(0);
    expect(row.logoImageUrlLastError).toContain("ECONNREFUSED");
    expect(row.logoImageUrlLastCheckedAt).toBeTruthy();
    expect(row.faviconUrlConsecutiveFailures).toBe(0);
    expect(row.faviconUrlLastError).toContain("ECONNREFUSED");
    for (const call of sendTransactionalPushMock.mock.calls) {
      const recipients = call[0] as number[];
      expect(recipients).not.toContain(adminA.id);
      expect(recipients).not.toContain(adminB.id);
    }
    expect(sendMarketingImageBrokenEmailMock).not.toHaveBeenCalled();
  });

  it("passes the marketing 1 MB cap so an over-cap response feeds the auto-clear flow", async () => {
    // Task #1800 — Save-time validation already caps marketing logos /
    // favicons at 1 MB (Task #1468). The background re-verify must
    // pass the same cap so a stored URL whose host later swaps in a
    // 5 MB image is auto-cleared the same way re-saving it through
    // the admin UI would. Pre-stage the logo at threshold-1 so a
    // single over-cap pass flips it to cleared, and skip favicon to
    // keep the assertions narrow.
    await db.update(clubMarketingSitesTable).set({
      logoImageUrlConsecutiveFailures: 2, // +1 over-cap = 3 = threshold
      logoImageUrlLastError: null,
      faviconUrl: null,
      cacheVersion: 4,
    }).where(eq(clubMarketingSitesTable.organizationId, orgId));

    const seenMaxBytesForOurUrl: Array<number | undefined> = [];
    __setExternalImageVerifierForTests(scopedVerifier(
      {
        ok: false,
        error: "image body exceeds 1 MB cap (got >1048576 bytes)",
      },
      {
        onOurCall: (_url, options) => {
          seenMaxBytesForOurUrl.push(options?.maxBytes);
        },
      },
    ));

    await recheckExternalMarketingImages();

    // The verifier saw the marketing-image cap (not the 10 MB default)
    // for OUR row's URL. Assert per-our-URL so a sibling row that
    // happens to also be probed in this sweep doesn't add noise.
    expect(seenMaxBytesForOurUrl).toEqual([MARKETING_LOGO_FAVICON_MAX_BYTES]);

    const row = await loadRow();
    expect(row.logoImageUrl).toBeNull();
    expect(row.logoImageUrlConsecutiveFailures).toBe(0);
    expect(row.logoImageUrlLastError).toBeNull();
    expect(row.logoImageUrlLastCheckedAt).toBeTruthy();
    expect(row.cacheVersion).toBe(5);

    const ourPushCalls = sendTransactionalPushMock.mock.calls.filter(call => {
      const recipients = call[0] as number[];
      return recipients.includes(adminA.id) || recipients.includes(adminB.id);
    });
    expect(ourPushCalls).toHaveLength(1);
    const ourEmailCalls = sendMarketingImageBrokenEmailMock.mock.calls.filter(call => {
      const args = call[0] as { to: string };
      return args.to === `${adminA.username}@example.com`
        || args.to === `${adminB.username}@example.com`;
    });
    expect(ourEmailCalls).toHaveLength(2);
    const firstEmail = ourEmailCalls[0][0] as {
      imageKind: string;
      clearedUrl: string;
      lastError: string | null;
    };
    expect(firstEmail.imageKind).toBe("logo");
    expect(firstEmail.clearedUrl).toBe(TEST_LOGO_URL);
    expect(firstEmail.lastError).toContain("exceeds 1 MB cap");
  });

  it("PUT /marketing-site resets the tracking columns when a new URL is saved", async () => {
    // Pre-stage a near-auto-clear state on the existing row.
    await db.update(clubMarketingSitesTable).set({
      logoImageUrlConsecutiveFailures: 2,
      logoImageUrlLastError: "image host returned HTTP 500",
      logoImageUrlLastCheckedAt: new Date(),
    }).where(eq(clubMarketingSitesTable.organizationId, orgId));

    // Verifier short-circuits to ok in tests by default, so the PUT
    // will accept the new URL and the route should reset tracking.
    const app = createTestApp(adminA);
    const res = await request(app)
      .put(`/api/organizations/${orgId}/marketing-site`)
      .send({ logoImageUrl: "https://cdn.example.com/fresh-logo.png" });
    expect(res.status).toBe(200);

    const row = await loadRow();
    expect(row.logoImageUrl).toBe("https://cdn.example.com/fresh-logo.png");
    expect(row.logoImageUrlConsecutiveFailures).toBe(0);
    expect(row.logoImageUrlLastError).toBeNull();
    expect(row.logoImageUrlLastCheckedAt).toBeNull();
  });
});
