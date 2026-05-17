/**
 * Integration tests: account-erasure cron actually deletes the underlying
 * media files from object storage (Task #775).
 *
 * The sibling suite `account-erasure-cron.test.ts` only covers the DB-row
 * cleanup. That left a blind spot: the production deletion path
 * (`ObjectStorageService.deleteObjectByPath`) was never exercised against a
 * real GCS bucket, so a wrong path shape, missing IAM permission, or
 * accidentally renamed env var would silently leave member-uploaded files
 * behind even though the cron reported success.
 *
 * This suite uploads a real object for each of the five media kinds the
 * cron cleans up — tournament photo, swing video, highlight reel, member
 * document, and feed-post media — wires them to a member, runs
 * `processOverdueAccountErasures`, and asserts directly against the bucket
 * that the files are gone. A second test confirms that a deletion failure
 * (e.g. revoked IAM permission) is surfaced via the audit metadata's
 * `objectStorageFilesFailed` counter rather than crashing the cron.
 *
 * The whole suite is skipped when object storage is not configured so it
 * stays a no-op in offline CI.
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * `processOverdueAccountErasures` sweeps `member_data_requests` GLOBALLY.
 * The api-server vitest suite shares a dev DB across files, so unscoped
 * `result.processed` / `result.failed` totals would flake the moment a
 * sibling privacy test (e.g. account-erasure-cron) leaks an overdue
 * erasure row from another org. Every cron call is routed through
 * `processOverdueAccountErasuresRowScoped`, which snapshots OUR org's
 * open erasures before the sweep and reports per-org terminal counts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDataRequestsTable,
  memberAuditLogTable,
  memberMessagesTable,
  tournamentsTable,
  playersTable,
  mediaTable,
  swingVideosTable,
  highlightReelsTable,
  memberDocumentsTable,
  feedPostsTable,
  feedPostMediaTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { processOverdueAccountErasures, processPendingStorageDeletions } from "../lib/cron.js";
import { pendingStorageDeletionsTable } from "@workspace/db";
import { ObjectStorageService, objectStorageClient } from "../lib/objectStorage.js";

/**
 * Row-scoped wrapper around `processOverdueAccountErasures` (Task
 * #1808 / #2266). See doc-block above for rationale.
 */
async function processOverdueAccountErasuresRowScoped(
  opts?: Parameters<typeof processOverdueAccountErasures>[0],
): Promise<{ processed: number; failed: number }> {
  const beforeOpen = await db.select({ id: memberDataRequestsTable.id })
    .from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.organizationId, testOrgId),
      eq(memberDataRequestsTable.requestType, "erasure"),
      sql`${memberDataRequestsTable.status} IN ('pending','approved')`,
    ));
  await processOverdueAccountErasures(opts);
  const ids = beforeOpen.map((r) => r.id);
  if (ids.length === 0) return { processed: 0, failed: 0 };
  const after = await db.select({
    id: memberDataRequestsTable.id,
    status: memberDataRequestsTable.status,
  }).from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.organizationId, testOrgId),
      inArray(memberDataRequestsTable.id, ids),
    ));
  return {
    processed: after.filter((r) => r.status === "completed").length,
    failed: after.filter((r) => r.status === "failed").length,
  };
}

// ── Skip the suite when object storage isn't configured (offline CI). ──────
const STORAGE_CONFIGURED =
  !!process.env.PRIVATE_OBJECT_DIR && !!process.env.PUBLIC_OBJECT_SEARCH_PATHS;
const describeIfStorage = STORAGE_CONFIGURED ? describe : describe.skip;

// ── Schema bootstrap (mirrors account-erasure-cron.test.ts). ──────────────
async function ensurePrivacySchema() {
  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_messages (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sender_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      channel text NOT NULL DEFAULT 'in_app',
      subject text,
      body text NOT NULL,
      status text NOT NULL DEFAULT 'sent',
      sent_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz,
      error_message text,
      related_entity text,
      related_entity_id integer
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_data_requests (
      id serial PRIMARY KEY,
      club_member_id integer NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      request_type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz NOT NULL DEFAULT now(),
      due_by timestamptz,
      resolved_at timestamptz,
      notes text,
      artifact_url text,
      handler_user_id integer REFERENCES app_users(id) ON DELETE SET NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_audit_log (
      id serial PRIMARY KEY,
      club_member_id integer REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      actor_name text,
      actor_role text,
      entity text NOT NULL,
      entity_id integer,
      action text NOT NULL,
      field_changes jsonb,
      reason text,
      metadata jsonb,
      ip_address text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE member_audit_log ADD COLUMN IF NOT EXISTS metadata jsonb`);
  await db.execute(sql`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS erased_at timestamptz`);
}

// Resolve an object-entity path ("/objects/<rel>") back to the GCS file
// handle so we can independently confirm bucket-side existence.
function resolveEntityPath(entityPath: string): { bucketName: string; objectName: string } {
  const svc = new ObjectStorageService();
  let dir = svc.getPrivateObjectDir(); // "/<bucket>/<prefix...>"
  if (!dir.endsWith("/")) dir = `${dir}/`;
  const rel = entityPath.replace(/^\/objects\//, "");
  const full = `${dir}${rel}`; // "/<bucket>/<prefix>/<rel>"
  const parts = full.split("/").filter((s) => s.length > 0);
  return { bucketName: parts[0], objectName: parts.slice(1).join("/") };
}

async function bucketObjectExists(entityPath: string): Promise<boolean> {
  const { bucketName, objectName } = resolveEntityPath(entityPath);
  const [exists] = await objectStorageClient.bucket(bucketName).file(objectName).exists();
  return exists;
}

async function uploadFixture(kind: string): Promise<string> {
  // Uses saveRawBuffer so paths end up in the canonical "/objects/<rel>"
  // form the rest of the codebase persists.
  const svc = new ObjectStorageService();
  const rel = `acct-erasure-test/${kind}-${randomUUID()}.bin`;
  return svc.saveRawBuffer(rel, Buffer.from(`fixture-${kind}`), "application/octet-stream");
}

let testOrgId: number;
const cleanupUserIds: number[] = [];
// Track every uploaded fixture so the afterAll hook can scrub anything the
// cron failed to remove (keeps the bucket clean between runs).
const uploadedFixturePaths = new Set<string>();

beforeAll(async () => {
  if (!STORAGE_CONFIGURED) return;
  await ensurePrivacySchema();
  const ts = Date.now();
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: `TestOrg_AcctErasureStorage_${ts}`,
      slug: `test-acct-erasure-storage-${ts}`,
    })
    .returning({ id: organizationsTable.id });
  testOrgId = org.id;
});

afterAll(async () => {
  if (!STORAGE_CONFIGURED) return;
  // Best-effort cleanup of bucket fixtures (cron should have removed them
  // already, but a failed test can leave orphans).
  const svc = new ObjectStorageService();
  for (const p of uploadedFixturePaths) {
    try {
      await svc.deleteObjectByPath(p);
    } catch {
      /* ignore */
    }
  }
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
  await db.delete(feedPostMediaTable).where(sql`post_id IN (SELECT id FROM feed_posts WHERE organization_id = ${testOrgId})`);
  await db.delete(feedPostsTable).where(eq(feedPostsTable.organizationId, testOrgId));
  await db.delete(memberDocumentsTable).where(eq(memberDocumentsTable.organizationId, testOrgId));
  await db.delete(highlightReelsTable).where(eq(highlightReelsTable.organizationId, testOrgId));
  await db.delete(swingVideosTable).where(eq(swingVideosTable.organizationId, testOrgId));
  await db.delete(mediaTable).where(eq(mediaTable.organizationId, testOrgId));
  await db.delete(playersTable).where(sql`tournament_id IN (SELECT id FROM tournaments WHERE organization_id = ${testOrgId})`);
  await db.delete(tournamentsTable).where(eq(tournamentsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  for (const id of cleanupUserIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  if (!STORAGE_CONFIGURED) return;
  await db.delete(pendingStorageDeletionsTable).where(eq(pendingStorageDeletionsTable.organizationId, testOrgId));
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
  await db.delete(feedPostMediaTable).where(sql`post_id IN (SELECT id FROM feed_posts WHERE organization_id = ${testOrgId})`);
  await db.delete(feedPostsTable).where(eq(feedPostsTable.organizationId, testOrgId));
  await db.delete(memberDocumentsTable).where(eq(memberDocumentsTable.organizationId, testOrgId));
  await db.delete(highlightReelsTable).where(eq(highlightReelsTable.organizationId, testOrgId));
  await db.delete(swingVideosTable).where(eq(swingVideosTable.organizationId, testOrgId));
  await db.delete(mediaTable).where(eq(mediaTable.organizationId, testOrgId));
  await db.delete(playersTable).where(sql`tournament_id IN (SELECT id FROM tournaments WHERE organization_id = ${testOrgId})`);
  await db.delete(tournamentsTable).where(eq(tournamentsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function createMemberWithUser(suffix: string) {
  const ts = Date.now();
  const [user] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `acct-erasure-storage-${suffix}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
      username: `acct_erasure_storage_${suffix}_${ts}`,
      email: `${suffix}_${ts}@example.test`,
      displayName: `Real Name ${suffix}`,
      role: "player",
      organizationId: testOrgId,
    })
    .returning({ id: appUsersTable.id });
  cleanupUserIds.push(user.id);

  const [member] = await db
    .insert(clubMembersTable)
    .values({
      organizationId: testOrgId,
      firstName: "Real",
      lastName: `Subject_${suffix}`,
      email: `member_${suffix}_${ts}@example.test`,
      memberNumber: `M-${suffix}-${ts}`,
      userId: user.id,
    })
    .returning({ id: clubMembersTable.id });
  return { memberId: member.id, userId: user.id };
}

interface MediaFixtureBundle {
  tournamentPhoto: string;
  swingVideo: string;
  highlightReel: string;
  memberDocument: string;
  feedPostMedia: string;
}

async function wireUpAllMediaKinds(memberId: number, userId: number): Promise<MediaFixtureBundle> {
  const ts = Date.now();
  // 1. Tournament photo (mediaTable, owned via uploadedByUserId).
  const [tourn] = await db
    .insert(tournamentsTable)
    .values({ organizationId: testOrgId, name: `T_${ts}` })
    .returning({ id: tournamentsTable.id });
  const tournamentPhoto = await uploadFixture("tournament-photo");
  uploadedFixturePaths.add(tournamentPhoto);
  await db.insert(mediaTable).values({
    organizationId: testOrgId,
    uploadedByUserId: userId,
    uploaderName: "Real Name",
    objectPath: tournamentPhoto,
    tournamentId: tourn.id,
  } as never);

  // 2. Swing video.
  const swingVideo = await uploadFixture("swing-video");
  uploadedFixturePaths.add(swingVideo);
  await db.insert(swingVideosTable).values({
    userId,
    organizationId: testOrgId,
    title: "Drive cam",
    videoUrl: swingVideo,
  });

  // 3. Highlight reel (server-rendered output).
  const highlightReel = await uploadFixture("highlight-reel");
  uploadedFixturePaths.add(highlightReel);
  await db.insert(highlightReelsTable).values({
    organizationId: testOrgId,
    userId,
    outputObjectPath: highlightReel,
  });

  // 4. Member document.
  const memberDocument = await uploadFixture("member-document");
  uploadedFixturePaths.add(memberDocument);
  await db.insert(memberDocumentsTable).values({
    clubMemberId: memberId,
    organizationId: testOrgId,
    documentType: "id_proof",
    title: "Passport",
    fileUrl: memberDocument,
  });

  // 5. Feed-post media (post authored by the member).
  const [post] = await db
    .insert(feedPostsTable)
    .values({ organizationId: testOrgId, authorUserId: userId, body: "Eagle on 7!" })
    .returning({ id: feedPostsTable.id });
  const feedPostMedia = await uploadFixture("feed-post");
  uploadedFixturePaths.add(feedPostMedia);
  await db.insert(feedPostMediaTable).values({ postId: post.id, url: feedPostMedia });

  return { tournamentPhoto, swingVideo, highlightReel, memberDocument, feedPostMedia };
}

describeIfStorage("account-erasure cron — object-storage cleanup (integration)", () => {
  it("removes every member-uploaded file from the bucket across all five media kinds", async () => {
    const { memberId, userId } = await createMemberWithUser("all_kinds");
    const fixtures = await wireUpAllMediaKinds(memberId, userId);

    // Pre-check: every fixture is genuinely in the bucket before we run the cron,
    // so a passing post-condition is meaningful (not just "file never existed").
    for (const p of Object.values(fixtures)) {
      expect(await bucketObjectExists(p)).toBe(true);
    }

    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "erasure",
      status: "pending",
      requestedAt: past,
      dueBy: past,
    });

    const result = await processOverdueAccountErasuresRowScoped();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // Post-condition: each file is actually gone from the bucket.
    for (const [kind, p] of Object.entries(fixtures)) {
      const stillThere = await bucketObjectExists(p);
      expect(stillThere, `${kind} file (${p}) was not removed from object storage`).toBe(false);
    }

    // Audit metadata recorded the bucket-side outcome for the controller UI.
    const [auditRow] = await db
      .select()
      .from(memberAuditLogTable)
      .where(
        and(
          eq(memberAuditLogTable.organizationId, testOrgId),
          eq(memberAuditLogTable.entity, "club_member"),
          eq(memberAuditLogTable.entityId, memberId),
          eq(memberAuditLogTable.action, "delete"),
        ),
      )
      .orderBy(desc(memberAuditLogTable.id));
    expect(auditRow).toBeDefined();
    const meta = auditRow.metadata as {
      objectStorageDisabled?: boolean;
      objectStorageFilesDeleted?: number;
      objectStorageFilesFailed?: number;
    };
    expect(meta.objectStorageDisabled).toBe(false);
    expect(meta.objectStorageFilesFailed).toBe(0);
    expect(meta.objectStorageFilesDeleted).toBeGreaterThanOrEqual(5);
  });

  it("surfaces a deletion failure in objectStorageFilesFailed instead of crashing the cron", async () => {
    const { memberId, userId } = await createMemberWithUser("perm_denied");
    const fixtures = await wireUpAllMediaKinds(memberId, userId);

    // Simulate a missing-bucket-permission for a single file: the swing
    // video deletion call throws as it would in production when the IAM
    // role is misconfigured. The cron must catch the throw, increment
    // objectStorageFilesFailed, and still process the request rather than
    // bubbling the error and abandoning the row.
    const realDelete = ObjectStorageService.prototype.deleteObjectByPath;
    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectByPath")
      .mockImplementation(async function (this: ObjectStorageService, path) {
        if (path === fixtures.swingVideo) {
          throw new Error("403 Forbidden: storage.objects.delete denied");
        }
        return realDelete.call(this, path);
      });

    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "erasure",
      status: "pending",
      requestedAt: past,
      dueBy: past,
    });

    const result = await processOverdueAccountErasuresRowScoped();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(spy).toHaveBeenCalled();

    const [auditRow] = await db
      .select()
      .from(memberAuditLogTable)
      .where(
        and(
          eq(memberAuditLogTable.organizationId, testOrgId),
          eq(memberAuditLogTable.entity, "club_member"),
          eq(memberAuditLogTable.entityId, memberId),
          eq(memberAuditLogTable.action, "delete"),
        ),
      )
      .orderBy(desc(memberAuditLogTable.id));
    expect(auditRow).toBeDefined();
    const meta = auditRow.metadata as {
      objectStorageDisabled?: boolean;
      objectStorageFilesDeleted?: number;
      objectStorageFilesFailed?: number;
    };
    expect(meta.objectStorageDisabled).toBe(false);
    // The simulated permission denial must be visible to controllers.
    expect(meta.objectStorageFilesFailed).toBeGreaterThanOrEqual(1);
    // The other four files were still removed from the bucket.
    expect(meta.objectStorageFilesDeleted).toBeGreaterThanOrEqual(4);

    // Sanity: the erasure request itself was closed even though one
    // bucket op failed — failures are surfaced via metadata, not by
    // re-queueing the row indefinitely.
    const [reqAfter] = await db
      .select()
      .from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.clubMemberId, memberId));
    expect(reqAfter.status).toBe("completed");

    // Tidy: the swing-video fixture is still in the bucket because the
    // mocked call rejected — remove it directly so the bucket stays clean.
    spy.mockRestore();
    try {
      await new ObjectStorageService().deleteObjectByPath(fixtures.swingVideo);
    } catch {
      /* ignore */
    }
  });

  // Task #973 — verify the pending-deletion retry queue actually drains
  // orphan files on a later pass instead of leaving them in the bucket.
  it("retries failed object-storage deletions on a later pass and cleans the orphan", async () => {
    const { memberId, userId } = await createMemberWithUser("retry_pass");
    const fixtures = await wireUpAllMediaKinds(memberId, userId);

    // First pass: simulate a transient backend hiccup that fails just the
    // swing-video delete. The cron should still complete the request and
    // enqueue the orphan into pending_storage_deletions for a later retry.
    const realDelete = ObjectStorageService.prototype.deleteObjectByPath;
    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectByPath")
      .mockImplementation(async function (this: ObjectStorageService, path) {
        if (path === fixtures.swingVideo) {
          throw new Error("503 Service Unavailable: please retry");
        }
        return realDelete.call(this, path);
      });

    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "erasure",
      status: "pending",
      requestedAt: past,
      dueBy: past,
    });

    const firstPass = await processOverdueAccountErasuresRowScoped();
    expect(firstPass.processed).toBe(1);
    expect(await bucketObjectExists(fixtures.swingVideo)).toBe(true);

    // The failed path is now sitting in the retry queue with attempts=0
    // and a future nextAttemptAt (initial backoff window).
    const enqueued = await db.select().from(pendingStorageDeletionsTable)
      .where(eq(pendingStorageDeletionsTable.organizationId, testOrgId));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].path).toBe(fixtures.swingVideo);
    expect(enqueued[0].attempts).toBe(0);
    expect(enqueued[0].clubMemberId).toBe(memberId);

    // Worker tick BEFORE the backoff has elapsed — must be a no-op so we
    // don't hammer the backend straight after a failure.
    spy.mockRestore();
    const earlyResult = await processPendingStorageDeletions({ now: new Date() });
    expect(earlyResult.attempted).toBe(0);
    expect(await bucketObjectExists(fixtures.swingVideo)).toBe(true);

    // Worker tick AFTER the backoff window: the transient error is gone,
    // so the orphan is removed from the bucket and the queue row is dropped.
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h, well past 5min initial backoff
    const retryResult = await processPendingStorageDeletions({ now: future });
    expect(retryResult.attempted).toBe(1);
    expect(retryResult.deleted + retryResult.missing).toBe(1);
    expect(retryResult.failed).toBe(0);
    expect(await bucketObjectExists(fixtures.swingVideo)).toBe(false);

    const remaining = await db.select().from(pendingStorageDeletionsTable)
      .where(eq(pendingStorageDeletionsTable.organizationId, testOrgId));
    expect(remaining).toHaveLength(0);
  });
});
