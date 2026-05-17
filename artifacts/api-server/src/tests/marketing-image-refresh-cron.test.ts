/**
 * Task #1467 — Periodic refresh of cached marketing logos / favicons.
 *
 * Coverage:
 *   1. A successful refresh whose downloaded bytes match the bytes
 *      currently cached in storage (same content hash → same object
 *      key → same `/api/storage/...` URL) does NOT rotate the public
 *      URL or bump cacheVersion. It only stamps lastRefreshedAt and
 *      clears any prior lastRefreshError.
 *   2. A successful refresh whose downloaded bytes differ from the
 *      currently cached ones writes a NEW content-hashed object,
 *      rotates `logoImageUrl` to the new `/api/storage/...` URL, and
 *      bumps cacheVersion so visitors stop loading the stale CDN copy.
 *   3. A failed download (verifier `{ ok: false, error }`) PRESERVES
 *      the existing cached copy (URL untouched, cacheVersion
 *      untouched), stamps lastRefreshError so admins / on-call see the
 *      staleness, and stamps lastRefreshedAt so the per-row backoff
 *      kicks in.
 *   4. A verifier that throws is treated as transient — same posture
 *      as a failed download, but the message is prefixed so on-call
 *      can tell our own code blew up.
 *   5. Rows whose `logoSourceUrl` / `faviconSourceUrl` is NULL (direct
 *      uploads, internal /objects paths, legacy rows from before this
 *      column existed) are skipped entirely — the verifier is never
 *      consulted for them.
 *   6. The per-row backoff is honoured so the sweep can be polled
 *      aggressively without re-hitting the same source URL.
 *   7. Saving a fresh URL through PUT /api/organizations/:id/marketing-site
 *      records the original external URL as `logoSourceUrl` and resets
 *      the per-source refresh tracking.
 *
 * Task #2259 — Admin notification when refresh keeps failing:
 *   8. A failed refresh under the notify threshold increments the
 *      per-source consecutive-refresh-failure counter and DOES NOT
 *      email/push admins.
 *   9. The exact tick that crosses the notify threshold emails + pushes
 *      every org admin once with the failing source URL and the
 *      verifier error.
 *  10. Subsequent failures past the threshold keep the counter climbing
 *      but DO NOT re-notify (de-dup so admins aren't paged every cron
 *      tick after the first alert).
 *  11. A successful refresh resets the counter to 0 so a recovered
 *      source re-arms the alert for the next streak.
 *  12. Saving a fresh URL through the editor resets the counter so an
 *      admin who replaces a long-failing source URL doesn't sit one
 *      tick away from another email.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-image-refresh-cron";
process.env.PRIVATE_OBJECT_DIR ||= "/test-bucket/private-marketing-refresh";
process.env.API_PUBLIC_URL ||= "https://api.kharagolf.test";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

const {
  mockState,
  sendTransactionalPushMock,
  sendMarketingImageRefreshFailingEmailMock,
} = vi.hoisted(() => ({
  mockState: {
    saved: [] as Array<{ relativePath: string; buffer: Buffer; contentType: string }>,
    aclSet: [] as Array<{ rawPath: string; visibility: string; owner: string }>,
    saveRawBufferOverride: null as null | ((relativePath: string) => Promise<string>),
  },
  sendTransactionalPushMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 }),
  ),
  sendMarketingImageRefreshFailingEmailMock: vi.fn(
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
    sendMarketingImageRefreshFailingEmail: sendMarketingImageRefreshFailingEmailMock,
  };
});

vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({}) }) },
  ObjectStorageService: class {
    async saveRawBuffer(relativePath: string, buffer: Buffer, contentType: string): Promise<string> {
      if (mockState.saveRawBufferOverride) return mockState.saveRawBufferOverride(relativePath);
      mockState.saved.push({ relativePath, buffer, contentType });
      return `/objects/${relativePath}`;
    }
    async trySetObjectEntityAclPolicy(rawPath: string, policy: { owner: string; visibility: string }): Promise<string> {
      mockState.aclSet.push({ rawPath, visibility: policy.visibility, owner: policy.owner });
      return rawPath;
    }
    async getObjectEntityFile(): Promise<unknown> {
      throw new Error("not used in this test");
    }
    async getObjectEntityUploadURL(): Promise<string> {
      return "https://storage.googleapis.com/test-bucket/private-marketing-refresh/uploads/x";
    }
    normalizeObjectEntityPath(uploadURL: string): string {
      const id = uploadURL.split("/").pop();
      return `/objects/uploads/${id}`;
    }
  },
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMarketingSitesTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  refreshCachedMarketingImages,
  _setMarketingImageRefreshTuningForTest,
  MARKETING_IMAGE_REFRESH_NOTIFY_FAILURE_THRESHOLD,
} from "../lib/cron.js";
import {
  __setExternalImageVerifierForTests,
  type ExternalImageVerifyResult,
} from "../lib/externalImageVerifier.js";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let admin: TestUser;
let adminB: TestUser;
const createdUserIds: number[] = [];
const createdMembershipUserIds: number[] = [];

// 1×1 transparent PNG — small but non-empty, real image bytes.
const PNG_BYTES_A = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
// Different bytes — same format, different content (the trailing
// IDAT is byte-shifted so the SHA-256 differs from PNG_BYTES_A).
const PNG_BYTES_B = Buffer.concat([PNG_BYTES_A, Buffer.from([0x42])]);

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const slug = `mkt-refresh-${stamp}`.toLowerCase();
  const [org] = await db.insert(organizationsTable).values({
    name: `MktRefresh_${stamp}`,
    slug,
    isActive: true,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const tag = uid("org_admin");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@example.com`,
    displayName: tag,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  admin = { id: u.id, username: tag, displayName: tag, role: "org_admin", organizationId: orgId };

  // Task #2259 — Second admin reached only via org_memberships so the
  // notification flow's dedup + memberships-side recipient lookup both
  // get exercised by the threshold-crossing tests below.
  const tagB = uid("member_admin");
  const [uB] = await db.insert(appUsersTable).values({
    replitUserId: tagB,
    username: tagB,
    email: `${tagB}@example.com`,
    displayName: tagB,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(uB.id);
  adminB = { id: uB.id, username: tagB, displayName: tagB, role: "player", organizationId: orgId };
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: uB.id,
    role: "org_admin",
  });
  createdMembershipUserIds.push(uB.id);

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
  mockState.saved.length = 0;
  mockState.aclSet.length = 0;
  mockState.saveRawBufferOverride = null;
  sendTransactionalPushMock.mockClear();
  sendMarketingImageRefreshFailingEmailMock.mockClear();
  // Tighten the per-row backoff so a single sweep call exercises the
  // row regardless of when previous tests last touched it.
  _setMarketingImageRefreshTuningForTest({ perRowMs: 0 });
  // Reset the marketing-site row to a known state with a logo source
  // URL set and the cached URL pointing at /objects/.../logo-<hashA>.png.
  // (We hand-compute the hash A object path so it matches what
  // rehostExternalImageBytes would produce for PNG_BYTES_A.)
  const { createHash } = await import("crypto");
  const hashA = createHash("sha256").update(PNG_BYTES_A).digest("hex").slice(0, 32);
  const cachedLogoUrl = `https://api.kharagolf.test/api/storage/objects/marketing-cache/${orgId}/logo-${hashA}.png`;
  await db.update(clubMarketingSitesTable).set({
    logoImageUrl: cachedLogoUrl,
    logoSourceUrl: "https://cdn.refresh-test.example.com/refresh-cron-logo.png",
    logoSourceLastRefreshedAt: null,
    logoSourceLastRefreshError: null,
    logoSourceConsecutiveRefreshFailures: 0,
    faviconUrl: null,
    faviconSourceUrl: null,
    faviconSourceLastRefreshedAt: null,
    faviconSourceLastRefreshError: null,
    faviconSourceConsecutiveRefreshFailures: 0,
    cacheVersion: 5,
    // Stamp the Task #1249 (recheck) tracking columns to "just
    // checked" so the unrelated recheck cron doesn't pick up this
    // test's row when both suites run in the same vitest fork.
    logoImageUrlLastCheckedAt: new Date(),
    faviconUrlLastCheckedAt: new Date(),
  }).where(eq(clubMarketingSitesTable.organizationId, orgId));
});

afterEach(() => {
  __setExternalImageVerifierForTests(null);
  _setMarketingImageRefreshTuningForTest(null);
});

async function loadRow() {
  const [row] = await db.select().from(clubMarketingSitesTable)
    .where(eq(clubMarketingSitesTable.organizationId, orgId));
  return row;
}

// Test fixtures use a unique source URL ("https://cdn.refresh-test…")
// so this suite can distinguish its own row from rows created by
// sibling test files that happen to live in the same DB while
// running in the same vitest fork. The verifier stubs below also
// gate on this URL so they don't accidentally process — or mutate
// — those unrelated rows.
const TEST_LOGO_SOURCE_URL = "https://cdn.refresh-test.example.com/refresh-cron-logo.png";

/**
 * Build a verifier stub that responds to OUR test's source URL with
 * the supplied result, and pass-through-skips (returns ok:false with
 * a benign message) for any other URL the cron happens to encounter
 * from sibling test rows. This keeps the assertions row-scoped — we
 * only care about what happened to the test's own marketing-site row.
 */
function scopedVerifier(
  ourResult: ExternalImageVerifyResult | (() => never),
): (url: string) => Promise<ExternalImageVerifyResult> {
  return async (url: string) => {
    if (url !== TEST_LOGO_SOURCE_URL) {
      return { ok: false, error: "unrelated-test-row-skipped" };
    }
    if (typeof ourResult === "function") {
      ourResult();
      throw new Error("unreachable"); // keeps the type checker happy
    }
    return ourResult;
  };
}

describe("Task #1467 — refreshCachedMarketingImages", () => {
  it("does not rotate the URL or bump cacheVersion when refreshed bytes are unchanged", async () => {
    __setExternalImageVerifierForTests(scopedVerifier({
      ok: true,
      buffer: PNG_BYTES_A, // same bytes as the existing cache
      contentType: "image/png",
    }));

    const before = await loadRow();
    await refreshCachedMarketingImages();

    // Storage save for OUR row landed on the same content-hashed
    // key (rehostExternalImageBytes collapses identical bytes onto
    // the same object) — the cached URL is unchanged.
    const oursaved = mockState.saved.filter((s) =>
      s.relativePath.startsWith(`marketing-cache/${orgId}/`),
    );
    expect(oursaved).toHaveLength(1);
    expect(oursaved[0].relativePath).toMatch(
      new RegExp(`^marketing-cache/${orgId}/logo-[0-9a-f]+\\.png$`),
    );

    const after = await loadRow();
    expect(after.logoImageUrl).toBe(before.logoImageUrl);
    expect(after.cacheVersion).toBe(before.cacheVersion);
    expect(after.logoSourceLastRefreshedAt).toBeTruthy();
    expect(after.logoSourceLastRefreshError).toBeNull();
  });

  it("rotates the cached URL and bumps cacheVersion when refreshed bytes change", async () => {
    __setExternalImageVerifierForTests(scopedVerifier({
      ok: true,
      buffer: PNG_BYTES_B, // different bytes → different content hash → new URL
      contentType: "image/png",
    }));

    const before = await loadRow();
    await refreshCachedMarketingImages();

    const oursaved = mockState.saved.filter((s) =>
      s.relativePath.startsWith(`marketing-cache/${orgId}/`),
    );
    expect(oursaved).toHaveLength(1);
    const newRelativePath = oursaved[0].relativePath;

    const after = await loadRow();
    // logoImageUrl rotated to the new content-hashed object URL.
    expect(after.logoImageUrl).not.toBe(before.logoImageUrl);
    expect(after.logoImageUrl).toBe(
      `https://api.kharagolf.test/api/storage/objects/${newRelativePath}`,
    );
    expect(after.cacheVersion).toBe(before.cacheVersion + 1);
    expect(after.logoSourceLastRefreshedAt).toBeTruthy();
    expect(after.logoSourceLastRefreshError).toBeNull();
    // Original source URL is preserved — only the cache rotated.
    expect(after.logoSourceUrl).toBe(before.logoSourceUrl);
  });

  it("Task #2248 — passes the marketing-logo cap to the verifier and treats an over-cap source as a refresh failure", async () => {
    // The real verifier rejects with `{ok:false, error:"…cap: 1 MB"}`
    // when bytes overrun the per-call cap. Mimic that response so we
    // can assert the refresh sweep:
    //   1. forwards the 1 MB cap to the verifier (otherwise the
    //      verifier's 10 MB default would let a 5 MB logo silently
    //      pass and get rehosted on the next tick);
    //   2. records the over-cap result as a refresh failure (cached
    //      copy preserved, error stamped) — same posture as any other
    //      verifier `{ok:false}`.
    const seenOptions: Array<unknown> = [];
    __setExternalImageVerifierForTests(async (url, options) => {
      if (url !== TEST_LOGO_SOURCE_URL) {
        return { ok: false, error: "unrelated-test-row-skipped" };
      }
      seenOptions.push(options);
      return {
        ok: false,
        error: "image is 5242880 bytes which exceeds the cap (cap: 1 MB)",
      };
    });

    const before = await loadRow();
    await refreshCachedMarketingImages();

    // (1) The refresh sweep forwarded the marketing-logo cap to the
    //     verifier — without this, the verifier would have used its
    //     10 MB default and the 5 MB logo would have rehosted
    //     successfully, eating storage quota.
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]).toMatchObject({
      maxBytes: 1 * 1024 * 1024,
    });

    // (2) No storage write — over-cap source is treated exactly like
    //     any other failed verification, so we don't rehost the
    //     oversize bytes.
    const oursaved = mockState.saved.filter((s) =>
      s.relativePath.startsWith(`marketing-cache/${orgId}/`),
    );
    expect(oursaved).toHaveLength(0);

    const after = await loadRow();
    // The previously cached (within-cap) copy is preserved so the
    // public mini-site keeps rendering, and cacheVersion is untouched.
    expect(after.logoImageUrl).toBe(before.logoImageUrl);
    expect(after.cacheVersion).toBe(before.cacheVersion);
    // The over-cap error is stamped so on-call / the editor sees why
    // the cache is now stale.
    expect(after.logoSourceLastRefreshError).toContain("exceeds the cap");
    expect(after.logoSourceLastRefreshError).toContain("1 MB");
    expect(after.logoSourceLastRefreshedAt).toBeTruthy();
  });

  it("preserves the cached copy and stamps lastRefreshError when the source is unreachable", async () => {
    __setExternalImageVerifierForTests(scopedVerifier({
      ok: false,
      error: "image host returned HTTP 503",
    }));

    const before = await loadRow();
    await refreshCachedMarketingImages();

    // No storage write for OUR row — we only write when the source
    // succeeds.
    const oursaved = mockState.saved.filter((s) =>
      s.relativePath.startsWith(`marketing-cache/${orgId}/`),
    );
    expect(oursaved).toHaveLength(0);

    const after = await loadRow();
    // The cached copy is intact — the public mini-site keeps working.
    expect(after.logoImageUrl).toBe(before.logoImageUrl);
    expect(after.cacheVersion).toBe(before.cacheVersion);
    // …but on-call sees why the cache is stale.
    expect(after.logoSourceLastRefreshError).toContain("HTTP 503");
    expect(after.logoSourceLastRefreshedAt).toBeTruthy();
  });

  it("treats a thrown verifier error as transient (cache preserved, error stamped)", async () => {
    __setExternalImageVerifierForTests(scopedVerifier(() => {
      throw new Error("ECONNREFUSED outbound.example.com");
    }));

    const before = await loadRow();
    await refreshCachedMarketingImages();

    const after = await loadRow();
    expect(after.logoImageUrl).toBe(before.logoImageUrl);
    expect(after.cacheVersion).toBe(before.cacheVersion);
    expect(after.logoSourceLastRefreshError).toContain("ECONNREFUSED");
    expect(after.logoSourceLastRefreshError).toContain("verifier threw");
    expect(after.logoSourceLastRefreshedAt).toBeTruthy();
  });

  it("preserves the cached copy when the storage write itself fails", async () => {
    __setExternalImageVerifierForTests(scopedVerifier({
      ok: true,
      buffer: PNG_BYTES_B,
      contentType: "image/png",
    }));
    // Throw only for OUR row's relative path so unrelated sibling
    // rows don't get blackholed by a global storage outage stub.
    mockState.saveRawBufferOverride = async (relPath?: string) => {
      if (relPath && relPath.startsWith(`marketing-cache/${orgId}/`)) {
        throw new Error("simulated GCS outage");
      }
      return `/objects/${relPath ?? "unknown"}`;
    };

    const before = await loadRow();
    await refreshCachedMarketingImages();

    const after = await loadRow();
    expect(after.logoImageUrl).toBe(before.logoImageUrl);
    expect(after.cacheVersion).toBe(before.cacheVersion);
    expect(after.logoSourceLastRefreshError).toContain("cache image to storage");
    expect(after.logoSourceLastRefreshError).toContain("simulated GCS outage");
  });

  it("skips rows whose source URL is null (uploads, internal paths, legacy rows)", async () => {
    await db.update(clubMarketingSitesTable).set({
      logoSourceUrl: null,
      faviconSourceUrl: null,
    }).where(eq(clubMarketingSitesTable.organizationId, orgId));

    // Track verifier calls per source URL so unrelated org rows that
    // happen to live in the same DB (other test fixtures running in
    // the same vitest fork) don't pollute the assertion.
    const calledUrls: string[] = [];
    __setExternalImageVerifierForTests(async (url: string) => {
      calledUrls.push(url);
      // For our test's URL, "should-not-be-called" — return an error
      // so we'd notice if it leaked through. For other tests' URLs
      // (e.g. unrelated logoSourceUrl rows from sibling test files),
      // pass-through with an error so we don't accidentally rotate
      // their cached copies.
      return { ok: false, error: "skipped-test-no-source-url-for-this-org" };
    });
    await refreshCachedMarketingImages();
    // Our org's source URL was never probed because it's null.
    expect(calledUrls).not.toContain("https://cdn.refresh-test.example.com/refresh-cron-logo.png");

    // And our row's per-source tracking is untouched (no refreshed-at
    // stamp, no error stamp).
    const after = await loadRow();
    expect(after.logoSourceLastRefreshedAt).toBeNull();
    expect(after.logoSourceLastRefreshError).toBeNull();
  });

  it("honours the per-row backoff and skips a just-refreshed source", async () => {
    const justNow = new Date();
    await db.update(clubMarketingSitesTable).set({
      logoSourceLastRefreshedAt: justNow,
    }).where(eq(clubMarketingSitesTable.organizationId, orgId));

    // Pretend the per-row backoff is 1h so a just-refreshed row is in window.
    _setMarketingImageRefreshTuningForTest({ perRowMs: 60 * 60 * 1000 });

    const calledUrls: string[] = [];
    __setExternalImageVerifierForTests(async (url: string) => {
      calledUrls.push(url);
      return { ok: false, error: "should-not-be-probed" };
    });
    await refreshCachedMarketingImages();
    // Our org's source URL was skipped because it was just refreshed.
    expect(calledUrls).not.toContain("https://cdn.refresh-test.example.com/refresh-cron-logo.png");

    // Our row's lastRefreshedAt is unchanged (still ~justNow), and no
    // new error was stamped.
    const after = await loadRow();
    expect(after.logoSourceLastRefreshedAt?.getTime()).toBeGreaterThanOrEqual(
      justNow.getTime() - 1000,
    );
    expect(after.logoSourceLastRefreshError).toBeNull();
  });

  it("PUT /marketing-site records the original external URL as logoSourceUrl and resets refresh tracking", async () => {
    // Pre-stage a stale-refresh state so we can prove PUT clears it.
    await db.update(clubMarketingSitesTable).set({
      logoSourceLastRefreshedAt: new Date(),
      logoSourceLastRefreshError: "image host returned HTTP 503",
    }).where(eq(clubMarketingSitesTable.organizationId, orgId));

    // Verifier returns bytes, so the route will both rehost and persist
    // the source URL alongside the cached one.
    __setExternalImageVerifierForTests(async () => ({
      ok: true,
      buffer: PNG_BYTES_A,
      contentType: "image/png",
    }));

    const app = createTestApp(admin);
    const res = await request(app)
      .put(`/api/organizations/${orgId}/marketing-site`)
      .send({ logoImageUrl: "https://cdn.example.com/fresh-logo.png" });
    expect(res.status).toBe(200);

    const after = await loadRow();
    // logoImageUrl is the rehosted internal URL (Task #1250) …
    expect(after.logoImageUrl).toMatch(/\/api\/storage\/objects\/marketing-cache\//);
    // … and logoSourceUrl is the original external URL the admin pasted.
    expect(after.logoSourceUrl).toBe("https://cdn.example.com/fresh-logo.png");
    // Refresh tracking reset so a stale "last refresh failed" doesn't
    // leak into the editor / on-call digest for the freshly pasted URL.
    expect(after.logoSourceLastRefreshError).toBeNull();
    expect(after.logoSourceLastRefreshedAt).toBeNull();
  });

  it("PUT /marketing-site clears logoSourceUrl when the override is reset to null", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .put(`/api/organizations/${orgId}/marketing-site`)
      .send({ logoImageUrl: null });
    expect(res.status).toBe(200);

    const after = await loadRow();
    expect(after.logoImageUrl).toBeNull();
    expect(after.logoSourceUrl).toBeNull();
  });

  // ── Task #2259 — Admin notification on consecutive refresh failures ──

  it("Task #2259 — counts consecutive refresh failures but does NOT notify before the threshold", async () => {
    // Threshold = 3 (production value). Drive 2 failed sweeps and
    // assert the counter climbs to 2 but no email/push fires yet.
    _setMarketingImageRefreshTuningForTest({ perRowMs: 0, notifyThreshold: 3 });
    __setExternalImageVerifierForTests(scopedVerifier({
      ok: false,
      error: "image host returned HTTP 404",
    }));

    await refreshCachedMarketingImages();
    await refreshCachedMarketingImages();

    const after = await loadRow();
    expect(after.logoSourceConsecutiveRefreshFailures).toBe(2);
    expect(after.logoSourceLastRefreshError).toContain("HTTP 404");
    // Cache preserved — public mini-site still renders.
    expect(after.logoImageUrl).not.toBeNull();
    // No notification yet — we're still below the threshold.
    expect(sendMarketingImageRefreshFailingEmailMock).not.toHaveBeenCalled();
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();
  });

  it("Task #2259 — emails + pushes both org admins exactly once on the tick that crosses the threshold", async () => {
    _setMarketingImageRefreshTuningForTest({ perRowMs: 0, notifyThreshold: 3 });
    __setExternalImageVerifierForTests(scopedVerifier({
      ok: false,
      error: "image host returned HTTP 404",
    }));

    // Three failures: the third tick is the one that should notify.
    await refreshCachedMarketingImages();
    expect(sendMarketingImageRefreshFailingEmailMock).not.toHaveBeenCalled();
    await refreshCachedMarketingImages();
    expect(sendMarketingImageRefreshFailingEmailMock).not.toHaveBeenCalled();
    await refreshCachedMarketingImages();

    const after = await loadRow();
    expect(after.logoSourceConsecutiveRefreshFailures).toBe(3);

    // One email per admin (direct admin via app_users.role + member admin
    // via org_memberships) and exactly one push call carrying both ids.
    expect(sendMarketingImageRefreshFailingEmailMock).toHaveBeenCalledTimes(2);
    const recipients = sendMarketingImageRefreshFailingEmailMock.mock.calls.map(
      (c) => (c[0] as { to: string }).to,
    ).sort();
    expect(recipients).toEqual([
      `${admin.username}@example.com`,
      `${adminB.username}@example.com`,
    ].sort());

    // Every email carries the failing source URL, the verifier's error,
    // the kind, and the consecutive-failure count so on-call has all
    // the context they need without round-tripping to the editor.
    for (const call of sendMarketingImageRefreshFailingEmailMock.mock.calls) {
      const opts = call[0] as Record<string, unknown>;
      expect(opts.imageKind).toBe("logo");
      expect(opts.sourceUrl).toBe(TEST_LOGO_SOURCE_URL);
      expect(opts.lastError).toContain("HTTP 404");
      expect(opts.consecutiveFailures).toBe(3);
    }

    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);
    const [userIds, title, body, data] = sendTransactionalPushMock.mock.calls[0];
    expect(new Set(userIds)).toEqual(new Set([admin.id, adminB.id]));
    expect(title).toContain("logo");
    expect(body).toContain("cdn.refresh-test.example.com");
    expect(data).toMatchObject({
      type: "marketing_image_refresh_failing",
      imageKind: "logo",
      organizationId: orgId,
    });
  });

  it("Task #2259 — does NOT re-notify on subsequent failures past the threshold (de-dup)", async () => {
    _setMarketingImageRefreshTuningForTest({ perRowMs: 0, notifyThreshold: 3 });
    __setExternalImageVerifierForTests(scopedVerifier({
      ok: false,
      error: "image host returned HTTP 404",
    }));

    // Drive past the threshold: 3 fires, 4 and 5 should NOT.
    await refreshCachedMarketingImages();
    await refreshCachedMarketingImages();
    await refreshCachedMarketingImages();
    expect(sendMarketingImageRefreshFailingEmailMock).toHaveBeenCalledTimes(2);
    expect(sendTransactionalPushMock).toHaveBeenCalledTimes(1);

    sendMarketingImageRefreshFailingEmailMock.mockClear();
    sendTransactionalPushMock.mockClear();

    await refreshCachedMarketingImages();
    await refreshCachedMarketingImages();

    const after = await loadRow();
    // Counter keeps climbing for observability …
    expect(after.logoSourceConsecutiveRefreshFailures).toBe(5);
    // … but no further notifications fire — admins aren't paged every
    // refresh tick after the first alert.
    expect(sendMarketingImageRefreshFailingEmailMock).not.toHaveBeenCalled();
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();
  });

  it("Task #2259 — a successful refresh resets the consecutive-failure counter", async () => {
    _setMarketingImageRefreshTuningForTest({ perRowMs: 0, notifyThreshold: 3 });
    // Two failures, then a recovery.
    let mode: "fail" | "ok" = "fail";
    __setExternalImageVerifierForTests(async (url) => {
      if (url !== TEST_LOGO_SOURCE_URL) {
        return { ok: false, error: "unrelated-test-row-skipped" };
      }
      if (mode === "fail") return { ok: false, error: "image host returned HTTP 503" };
      return { ok: true, buffer: PNG_BYTES_A, contentType: "image/png" };
    });

    await refreshCachedMarketingImages();
    await refreshCachedMarketingImages();
    let row = await loadRow();
    expect(row.logoSourceConsecutiveRefreshFailures).toBe(2);

    mode = "ok";
    await refreshCachedMarketingImages();
    row = await loadRow();
    // Counter re-armed — a recovered source goes back to a clean streak.
    expect(row.logoSourceConsecutiveRefreshFailures).toBe(0);
    expect(row.logoSourceLastRefreshError).toBeNull();
    // No notifications fired during this recovery sequence.
    expect(sendMarketingImageRefreshFailingEmailMock).not.toHaveBeenCalled();
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();
  });

  it("Task #2259 — PUT /marketing-site resets the consecutive-failure counter", async () => {
    // Pre-stage a row that's been failing — counter at 2, just one
    // tick away from the production threshold.
    await db.update(clubMarketingSitesTable).set({
      logoSourceConsecutiveRefreshFailures: 2,
      logoSourceLastRefreshError: "image host returned HTTP 404",
      logoSourceLastRefreshedAt: new Date(),
    }).where(eq(clubMarketingSitesTable.organizationId, orgId));

    // Verifier returns ok bytes so the route accepts the new URL.
    __setExternalImageVerifierForTests(async () => ({
      ok: true,
      buffer: PNG_BYTES_A,
      contentType: "image/png",
    }));

    const app = createTestApp(admin);
    const res = await request(app)
      .put(`/api/organizations/${orgId}/marketing-site`)
      .send({ logoImageUrl: "https://cdn.example.com/replacement-logo.png" });
    expect(res.status).toBe(200);

    const after = await loadRow();
    // Pasting a fresh URL re-arms the counter so the admin doesn't sit
    // one tick away from another notification.
    expect(after.logoSourceConsecutiveRefreshFailures).toBe(0);
    expect(after.logoSourceUrl).toBe("https://cdn.example.com/replacement-logo.png");
    // And no email/push fired during the route handler.
    expect(sendMarketingImageRefreshFailingEmailMock).not.toHaveBeenCalled();
    expect(sendTransactionalPushMock).not.toHaveBeenCalled();
  });

  it("Task #2259 — exported notify threshold matches the production constant", async () => {
    // Cheap guard so a future tweak to the production threshold also
    // updates the test that anchors against it via the exported value.
    expect(MARKETING_IMAGE_REFRESH_NOTIFY_FAILURE_THRESHOLD).toBe(3);
  });
});
