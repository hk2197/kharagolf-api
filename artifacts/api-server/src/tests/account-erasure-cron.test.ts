/**
 * Integration tests: Automatic account-erasure worker (Task #467).
 *
 * Self-serve account deletions are filed as `erasure` rows in
 * member_data_requests with `dueBy = requestedAt + 30 days`. After the grace
 * window elapses the cron worker `processOverdueAccountErasures` must:
 *   1. Find every open erasure row whose `dueBy <= now()`.
 *   2. Anonymise the linked clubMember PII (name, email, phone, dob, ghin, …)
 *      and any linked appUser (display name, email, public profile, auth tokens).
 *   3. Mark the request `completed` with a `resolvedAt` timestamp.
 *   4. Record an audit row tagged `metadata.source = "cron"` so the controller
 *      can see the erasure was performed by the worker.
 *   5. Leave rows whose grace window has NOT yet elapsed completely untouched.
 *   6. Skip rows already in a terminal state (completed / rejected) so cancelled
 *      deletions are never re-processed.
 *
 * Together this guarantees the controller's "Privacy" overdue counter (which
 * counts open erasures with `dueBy <= now()`) returns to zero after one cron
 * pass.
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * `processOverdueAccountErasures` sweeps `member_data_requests` GLOBALLY.
 * The api-server vitest suite shares a dev DB across files, so unscoped
 * `result.processed` / `result.failed` totals would flake the moment a
 * sibling privacy test (e.g. account-erasure-cron-storage) leaks an
 * overdue erasure row from another org. We therefore route every cron
 * invocation through `processOverdueAccountErasuresRowScoped(...)`, a
 * thin wrapper that snapshots OUR org's open erasures before the sweep
 * and reports counts derived from this org's terminal-state delta.
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
  swingAnnotationsTable,
  swingComparisonsTable,
  highlightReelsTable,
  memberDocumentsTable,
  memberDocumentVersionsTable,
  feedPostsTable,
  feedPostMediaTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { processOverdueAccountErasures } from "../lib/cron.js";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";

/**
 * Row-scoped wrapper around `processOverdueAccountErasures` (Task
 * #1808 / #2266). Snapshots which open erasures live in OUR test org
 * BEFORE the global sweep runs, then re-reads those exact ids AFTER
 * the sweep to compute per-org `processed` / `failed` counts. This
 * keeps assertions stable even when a sibling cron test seeds an
 * overdue erasure for a different org that happens to be eligible
 * during the same sweep.
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

// ── Schema bootstrap (mirrors other privacy tests) ──────────────────────────
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
  // Task #467 — tombstone column refused by upsertUser on subsequent OAuth login.
  await db.execute(sql`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS erased_at timestamptz`);
  // Task #971 — daily data-export purge cron stamps purged_at; the
  // account-erasure worker also writes it so the column must exist.
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS purged_at timestamptz`);
}

let testOrgId: number;
const cleanupMemberIds: number[] = [];
const cleanupUserIds: number[] = [];

beforeAll(async () => {
  await ensurePrivacySchema();
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_AcctErasure_${ts}`,
    slug: `test-acct-erasure-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
  await db.delete(mediaTable).where(eq(mediaTable.organizationId, testOrgId));
  await db.delete(playersTable).where(sql`tournament_id IN (SELECT id FROM tournaments WHERE organization_id = ${testOrgId})`);
  await db.delete(tournamentsTable).where(eq(tournamentsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  if (cleanupUserIds.length > 0) {
    for (const id of cleanupUserIds) {
      await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
    }
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  // Clean per-test state so each scenario starts fresh.
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, testOrgId));
  await db.delete(memberDataRequestsTable).where(eq(memberDataRequestsTable.organizationId, testOrgId));
  await db.delete(mediaTable).where(eq(mediaTable.organizationId, testOrgId));
  await db.delete(playersTable).where(sql`tournament_id IN (SELECT id FROM tournaments WHERE organization_id = ${testOrgId})`);
  await db.delete(tournamentsTable).where(eq(tournamentsTable.organizationId, testOrgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, testOrgId));
  cleanupMemberIds.length = 0;
});

async function createMemberWithUser(suffix: string) {
  const ts = Date.now();
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `acct-erasure-${suffix}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    username: `acct_erasure_${suffix}_${ts}`,
    email: `${suffix}_${ts}@example.test`,
    displayName: `Real Name ${suffix}`,
    profileImage: "https://cdn.example.test/avatar.png",
    publicHandle: `handle_${suffix}_${ts}`,
    publicProfileEnabled: true,
    publicBio: "Loves golf",
    publicLocation: "Bengaluru",
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  cleanupUserIds.push(user.id);

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Real",
    lastName: `Subject_${suffix}`,
    email: `member_${suffix}_${ts}@example.test`,
    phone: "+15555550199",
    dateOfBirth: new Date("1980-04-12"),
    whsGhinNumber: "1234567",
    memberNumber: `M-${suffix}-${ts}`,
    showInDirectory: true,
    userId: user.id,
  }).returning({ id: clubMembersTable.id });
  cleanupMemberIds.push(member.id);
  return { memberId: member.id, userId: user.id };
}

describe("processOverdueAccountErasures", () => {
  it("anonymises overdue erasures, marks them completed, and writes an audit row", async () => {
    const { memberId, userId } = await createMemberWithUser("overdue");
    const requestedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const dueBy = new Date(Date.now() - 24 * 60 * 60 * 1000); // a day overdue
    const [req] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "erasure",
      status: "pending",
      requestedAt,
      dueBy,
      notes: "Account deletion (self-serve, 30-day grace period)",
    }).returning();

    const result = await processOverdueAccountErasuresRowScoped();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // Request closed.
    const [after] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, req.id));
    expect(after.status).toBe("completed");
    expect(after.resolvedAt).not.toBeNull();
    expect(after.notes).toContain("Auto-erasure (cron)");

    // Member PII scrubbed.
    const [member] = await db.select().from(clubMembersTable).where(eq(clubMembersTable.id, memberId));
    expect(member.firstName).toBe("Deleted");
    expect(member.lastName).toBe("Member");
    expect(member.email).toBeNull();
    expect(member.phone).toBeNull();
    expect(member.dateOfBirth).toBeNull();
    expect(member.whsGhinNumber).toBeNull();
    expect(member.memberNumber).toBeNull();
    expect(member.showInDirectory).toBe(false);
    expect(member.subscriptionStatus).toBe("expired");

    // Linked app user PII scrubbed.
    const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, userId));
    expect(user.email).toBeNull();
    expect(user.displayName).toBe("Deleted Member");
    expect(user.profileImage).toBeNull();
    expect(user.publicHandle).toBeNull();
    expect(user.publicProfileEnabled).toBe(false);
    expect(user.publicBio).toBeNull();
    expect(user.publicLocation).toBeNull();
    expect(user.passwordHash).toBeNull();

    // Audit trail: at least one cron-tagged row mentioning the data_request and
    // one delete-style row for club_member.
    const audits = await db.select().from(memberAuditLogTable)
      .where(eq(memberAuditLogTable.organizationId, testOrgId))
      .orderBy(desc(memberAuditLogTable.id));
    const dataRequestAudit = audits.find(a => a.entity === "data_request" && a.entityId === req.id);
    expect(dataRequestAudit).toBeDefined();
    expect((dataRequestAudit!.metadata as { source?: string } | null)?.source).toBe("cron");
    const memberAudit = audits.find(a => a.entity === "club_member" && a.action === "delete");
    expect(memberAudit).toBeDefined();
    expect((memberAudit!.metadata as { source?: string } | null)?.source).toBe("cron");
  });

  it("leaves erasures whose grace window has not yet elapsed completely untouched", async () => {
    const { memberId } = await createMemberWithUser("grace");
    const dueBy = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // still 5 days left
    const [req] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "erasure",
      status: "pending",
      requestedAt: new Date(),
      dueBy,
    }).returning();

    const result = await processOverdueAccountErasuresRowScoped();
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);

    const [after] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, req.id));
    expect(after.status).toBe("pending");
    expect(after.resolvedAt).toBeNull();

    const [member] = await db.select().from(clubMembersTable).where(eq(clubMembersTable.id, memberId));
    expect(member.firstName).toBe("Real");
    expect(member.email).not.toBeNull();
  });

  it("skips already-completed and cancelled (rejected) erasures", async () => {
    const { memberId: completedMemberId } = await createMemberWithUser("done");
    const { memberId: cancelledMemberId } = await createMemberWithUser("cancel");
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: completedMemberId,
      requestType: "erasure",
      status: "completed",
      requestedAt: past,
      dueBy: past,
      resolvedAt: past,
    });
    await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: cancelledMemberId,
      requestType: "erasure",
      status: "rejected",
      requestedAt: past,
      dueBy: past,
      notes: "cancelled by member",
    });

    const result = await processOverdueAccountErasuresRowScoped();
    expect(result.processed).toBe(0);

    // Both members keep their original PII.
    for (const mid of [completedMemberId, cancelledMemberId]) {
      const [m] = await db.select().from(clubMembersTable).where(eq(clubMembersTable.id, mid));
      expect(m.firstName).toBe("Real");
      expect(m.email).not.toBeNull();
    }
  });

  it("scrubs PII on the member's tournament players and purges their uploaded media", async () => {
    const { memberId, userId } = await createMemberWithUser("scores_media");
    const ts = Date.now();
    const [tourn] = await db.insert(tournamentsTable).values({
      organizationId: testOrgId,
      name: `T_${ts}`,
    }).returning({ id: tournamentsTable.id });

    // Two tournament entries (the member's "scores ownership" handle).
    const [p1] = await db.insert(playersTable).values({
      tournamentId: tourn.id,
      userId,
      firstName: "Real",
      lastName: "Player",
      email: "real.player@example.test",
      phone: "+15555550111",
      ghinNumber: "9999999",
    }).returning({ id: playersTable.id });
    const [p2] = await db.insert(playersTable).values({
      tournamentId: tourn.id,
      userId,
      firstName: "Real",
      lastName: "Player",
      email: "real.player2@example.test",
      phone: "+15555550112",
      ghinNumber: "9999998",
    }).returning({ id: playersTable.id });

    // Player without a userId — must NOT be touched.
    const [pOther] = await db.insert(playersTable).values({
      tournamentId: tourn.id,
      firstName: "Other",
      lastName: "Golfer",
      email: "other@example.test",
    }).returning({ id: playersTable.id });

    // Two media uploads attributed to the member, plus one unrelated upload.
    const [m1] = await db.insert(mediaTable).values({
      organizationId: testOrgId,
      uploadedByUserId: userId,
      uploaderName: "Real Name scores_media",
      objectPath: "uploads/photo-1.jpg",
    }).returning({ id: mediaTable.id });
    const [m2] = await db.insert(mediaTable).values({
      organizationId: testOrgId,
      uploadedByUserId: userId,
      uploaderName: "Real Name scores_media",
      objectPath: "uploads/photo-2.jpg",
    }).returning({ id: mediaTable.id });
    const [mOther] = await db.insert(mediaTable).values({
      organizationId: testOrgId,
      uploadedByUserId: null,
      uploaderName: "Someone Else",
      objectPath: "uploads/other.jpg",
    }).returning({ id: mediaTable.id });

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

    // Member's player rows scrubbed.
    for (const pid of [p1.id, p2.id]) {
      const [pl] = await db.select().from(playersTable).where(eq(playersTable.id, pid));
      expect(pl.firstName).toBe("Deleted");
      expect(pl.lastName).toBe("Member");
      expect(pl.email).toBeNull();
      expect(pl.phone).toBeNull();
      expect(pl.ghinNumber).toBeNull();
    }
    // Unrelated player untouched.
    const [pOtherAfter] = await db.select().from(playersTable).where(eq(playersTable.id, pOther.id));
    expect(pOtherAfter.firstName).toBe("Other");
    expect(pOtherAfter.email).toBe("other@example.test");

    // Member's media rows purged outright (Task #616 — storage files would
    // also be deleted in a production environment with object storage
    // configured; the in-memory test DB has no GCS bucket, so we only
    // assert the DB-row deletion here).
    for (const mid of [m1.id, m2.id]) {
      const md = await db.select().from(mediaTable).where(eq(mediaTable.id, mid));
      expect(md.length).toBe(0);
    }
    // Unrelated media untouched.
    const [mOtherAfter] = await db.select().from(mediaTable).where(eq(mediaTable.id, mOther.id));
    expect(mOtherAfter.uploaderName).toBe("Someone Else");

    // Audit log records the side-effect counts and the per-table breakdown
    // controllers need to verify exactly what was removed (Task #616).
    const audits = await db.select().from(memberAuditLogTable)
      .where(eq(memberAuditLogTable.organizationId, testOrgId));
    const memberAudit = audits.find(a => a.entity === "club_member" && a.action === "delete");
    expect(memberAudit).toBeDefined();
    const meta = memberAudit!.metadata as {
      playerRowsScrubbed?: number;
      mediaRowsScrubbed?: number;
      mediaTablesPurged?: Record<string, number>;
      objectStorageDisabled?: boolean;
    };
    expect(meta.playerRowsScrubbed).toBe(2);
    expect(meta.mediaRowsScrubbed).toBe(2);
    expect(meta.mediaTablesPurged?.media).toBe(2);
    // The audit log must record the object-storage outcome — controllers
    // need to distinguish "nothing to delete" from "couldn't delete".
    expect(meta).toHaveProperty("objectStorageDisabled");
    expect(meta).toHaveProperty("objectStorageFilesDeleted" as keyof typeof meta);
  });

  it("hard-purges swing videos, annotations, comparisons, highlight reels, member documents, and feed-post media (Task #616)", async () => {
    const { memberId, userId } = await createMemberWithUser("media_purge");
    const ts = Date.now();

    // Swing video + annotation + comparison
    const [sv1] = await db.insert(swingVideosTable).values({
      userId,
      organizationId: testOrgId,
      title: "Drive cam",
      videoUrl: `swings/${ts}/drive.mp4`,
      thumbnailUrl: `swings/${ts}/drive.jpg`,
    }).returning();
    const [sv2] = await db.insert(swingVideosTable).values({
      userId,
      organizationId: testOrgId,
      videoUrl: `swings/${ts}/iron.mp4`,
    }).returning();
    await db.insert(swingAnnotationsTable).values({
      swingVideoId: sv1.id,
      authorUserId: userId,
      voiceOverUrl: `swings/${ts}/voiceover.m4a`,
    });
    await db.insert(swingComparisonsTable).values({
      userId,
      leftVideoId: sv1.id,
      rightVideoId: sv2.id,
    } as never);

    // Highlight reel
    await db.insert(highlightReelsTable).values({
      organizationId: testOrgId,
      userId,
      outputObjectPath: `reels/${ts}/r.mp4`,
      thumbnailPath: `reels/${ts}/r.jpg`,
    });

    // Member document + version
    const [doc] = await db.insert(memberDocumentsTable).values({
      clubMemberId: memberId,
      organizationId: testOrgId,
      documentType: "id_proof",
      title: "Passport",
      fileUrl: `docs/${ts}/passport.pdf`,
    }).returning();
    await db.insert(memberDocumentVersionsTable).values({
      memberDocumentId: doc.id,
      clubMemberId: memberId,
      organizationId: testOrgId,
      title: "Passport (old)",
      fileUrl: `docs/${ts}/passport-v1.pdf`,
    });

    // Feed post + media authored by the member
    const [post] = await db.insert(feedPostsTable).values({
      organizationId: testOrgId,
      authorUserId: userId,
      body: "Eagle on 7!",
    }).returning();
    await db.insert(feedPostMediaTable).values({
      postId: post.id,
      url: `feed/${ts}/eagle.jpg`,
    });

    // Schedule erasure in the past so the cron processes it.
    await db.insert(memberDataRequestsTable).values({
      clubMemberId: memberId,
      organizationId: testOrgId,
      requestType: "erasure",
      status: "approved",
      requestedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      approvedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      dueBy: new Date(Date.now() - 1000),
      notes: "Task #616 broad-purge test",
    } as never);

    const result = await processOverdueAccountErasuresRowScoped({ batchSize: 5 });
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    // Every member-owned media row is gone.
    expect((await db.select().from(swingVideosTable).where(eq(swingVideosTable.userId, userId))).length).toBe(0);
    expect((await db.select().from(swingAnnotationsTable).where(eq(swingAnnotationsTable.authorUserId, userId))).length).toBe(0);
    expect((await db.select().from(swingComparisonsTable).where(eq(swingComparisonsTable.userId, userId))).length).toBe(0);
    expect((await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.userId, userId))).length).toBe(0);
    expect((await db.select().from(memberDocumentsTable).where(eq(memberDocumentsTable.clubMemberId, memberId))).length).toBe(0);
    expect((await db.select().from(memberDocumentVersionsTable).where(eq(memberDocumentVersionsTable.clubMemberId, memberId))).length).toBe(0);
    expect((await db.select().from(feedPostMediaTable).where(eq(feedPostMediaTable.postId, post.id))).length).toBe(0);

    // Audit metadata records each touched table so controllers can verify
    // exactly what was removed without re-querying. Filter by entityId so
    // we pick out the audit row for this specific erased member.
    const memberAudits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "club_member"),
        eq(memberAuditLogTable.entityId, memberId),
        eq(memberAuditLogTable.action, "delete"),
      ))
      .orderBy(desc(memberAuditLogTable.id));
    expect(memberAudits.length).toBeGreaterThan(0);
    const purged = ((memberAudits[0].metadata as { mediaTablesPurged?: Record<string, number> }).mediaTablesPurged) ?? {};
    expect(purged.swing_videos).toBe(2);
    expect(purged.swing_annotations).toBe(1);
    expect(purged.swing_comparisons).toBe(1);
    expect(purged.highlight_reels).toBe(1);
    expect(purged.member_documents).toBe(1);
    expect(purged.member_document_versions).toBe(1);
    expect(purged.feed_post_media).toBe(1);
  });

  it("blocks the OAuth login path from re-hydrating PII on an erased account", async () => {
    // Importing inside the test keeps the auth module out of the global require
    // graph for the other tests (they don't need its OIDC env vars).
    const { upsertUserForTest } = await import("../routes/auth.js");

    const { memberId, userId } = await createMemberWithUser("rehydrate");
    // Capture the immutable replit subject before the cron scrubs the row.
    const [origUser] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, userId));
    const replitSub = origUser.replitUserId;

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

    // Sanity: tombstone written, PII gone.
    const [erased] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, userId));
    expect(erased.erasedAt).not.toBeNull();
    expect(erased.email).toBeNull();
    expect(erased.displayName).toBe("Deleted Member");

    // Simulate the OAuth callback handing the same `sub` back with full PII
    // (this is exactly what would happen on a re-login).
    await expect(upsertUserForTest({
      sub: replitSub,
      email: "real.person@example.test",
      first_name: "Real",
      last_name: "Person",
      profile_image_url: "https://cdn.example.test/avatar.png",
      username: "real_person",
    })).rejects.toMatchObject({ code: "ACCOUNT_ERASED" });

    // PII must NOT have been resurrected.
    const [stillErased] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, userId));
    expect(stillErased.email).toBeNull();
    expect(stillErased.displayName).toBe("Deleted Member");
    expect(stillErased.profileImage).toBeNull();
    expect(stillErased.erasedAt).not.toBeNull();
  });

  it("drains a backlog larger than one batch in a single worker invocation", async () => {
    // Seed 5 overdue erasures and run with batchSize=2 — the worker must page
    // through (3 batches of 2/2/1) and end with overdue=0.
    const TOTAL = 5;
    for (let i = 0; i < TOTAL; i++) {
      const { memberId } = await createMemberWithUser(`backlog_${i}`);
      const past = new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000);
      await db.insert(memberDataRequestsTable).values({
        organizationId: testOrgId,
        clubMemberId: memberId,
        requestType: "erasure",
        status: "pending",
        requestedAt: past,
        dueBy: past,
      });
    }

    const overdueWhere = and(
      eq(memberDataRequestsTable.organizationId, testOrgId),
      eq(memberDataRequestsTable.requestType, "erasure"),
      sql`${memberDataRequestsTable.status} NOT IN ('completed', 'rejected')`,
      sql`${memberDataRequestsTable.dueBy} <= now()`,
    );
    const before = await db.select({ id: memberDataRequestsTable.id })
      .from(memberDataRequestsTable).where(overdueWhere);
    expect(before.length).toBe(TOTAL);

    const result = await processOverdueAccountErasuresRowScoped({ batchSize: 2 });
    expect(result.processed).toBe(TOTAL);
    expect(result.batches).toBeGreaterThanOrEqual(3);

    const after = await db.select({ id: memberDataRequestsTable.id })
      .from(memberDataRequestsTable).where(overdueWhere);
    expect(after.length).toBe(0);
  });

  it("sends a final 'completed' notice using the previously-known contact details before scrubbing PII (Task #615)", async () => {
    const { memberId } = await createMemberWithUser("notify_completed");
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [req] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "erasure",
      status: "pending",
      requestedAt: past,
      dueBy: past,
    }).returning();

    const result = await processOverdueAccountErasuresRowScoped();
    expect(result.processed).toBe(1);

    // 1) An in-app message addressed to the member was created with the
    //    'completed' subject — the member sees a final confirmation in the
    //    portal even though their email/phone are now scrubbed.
    const messages = await db.select().from(memberMessagesTable)
      .where(eq(memberMessagesTable.clubMemberId, memberId));
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const completedMsg = messages.find(m => /completed/i.test(m.subject ?? ""));
    expect(completedMsg).toBeDefined();

    // 2) The data-request row tracks the most recent notification kind so the
    //    resend-history popover can surface it (Task #615 done-looks-like).
    const [after] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, req.id));
    expect(after.lastNotificationKind).toBe("completed");
    expect(after.lastInAppMessageId).not.toBeNull();
    expect(after.lastInAppAt).not.toBeNull();
    expect(after.status).toBe("completed");

    // 3) An audit row mirrors the manual admin completion path: a
    //    `data_request_notification` create entry tagged source=cron with
    //    per-channel delivery results in metadata.
    const audits = await db.select().from(memberAuditLogTable)
      .where(eq(memberAuditLogTable.organizationId, testOrgId));
    const notifyAudit = audits.find(
      a => a.entity === "data_request_notification" && a.entityId === req.id && a.action === "create",
    );
    expect(notifyAudit).toBeDefined();
    const meta = notifyAudit!.metadata as {
      source?: string;
      autoErasure?: boolean;
      kind?: string;
      channels?: Record<string, { status?: string }>;
    } | null;
    expect(meta?.source).toBe("cron");
    expect(meta?.autoErasure).toBe(true);
    expect(meta?.kind).toBe("completed");
    expect(meta?.channels?.email?.status).toBeDefined();
    expect(meta?.channels?.inApp?.status).toBe("sent");
    expect(meta?.channels?.push?.status).toBeDefined();
    expect(meta?.channels?.sms?.status).toBeDefined();
  });

  it("drives the controller's overdue counter back to zero after one pass", async () => {
    // Three overdue erasures across separate members.
    const created: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { memberId } = await createMemberWithUser(`batch_${i}`);
      const past = new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000);
      const [r] = await db.insert(memberDataRequestsTable).values({
        organizationId: testOrgId,
        clubMemberId: memberId,
        requestType: "erasure",
        status: "pending",
        requestedAt: past,
        dueBy: past,
      }).returning({ id: memberDataRequestsTable.id });
      created.push(r.id);
    }

    // Sanity: counter is 3 before the cron pass.
    const overdueBefore = await db.select({ id: memberDataRequestsTable.id })
      .from(memberDataRequestsTable)
      .where(and(
        eq(memberDataRequestsTable.organizationId, testOrgId),
        eq(memberDataRequestsTable.requestType, "erasure"),
        sql`${memberDataRequestsTable.status} NOT IN ('completed', 'rejected')`,
        sql`${memberDataRequestsTable.dueBy} <= now()`,
      ));
    expect(overdueBefore.length).toBe(3);

    const result = await processOverdueAccountErasuresRowScoped();
    expect(result.processed).toBe(3);

    // Counter back to zero.
    const overdueAfter = await db.select({ id: memberDataRequestsTable.id })
      .from(memberDataRequestsTable)
      .where(and(
        eq(memberDataRequestsTable.organizationId, testOrgId),
        eq(memberDataRequestsTable.requestType, "erasure"),
        sql`${memberDataRequestsTable.status} NOT IN ('completed', 'rejected')`,
        sql`${memberDataRequestsTable.dueBy} <= now()`,
      ));
    expect(overdueAfter.length).toBe(0);
  });

  it("auto-purges outstanding data-export archives belonging to the erased member (Task #971)", async () => {
    // Mock object storage so the cron can actually attempt deletions in the
    // unit-test environment (the bucket isn't reachable here, but the
    // helper must still exercise its happy path: delete file → clear
    // artifactUrl → stamp purgedAt → write data_export purge audit row).
    // We track each path the cron tries to delete so the test can assert
    // both DB state AND that the file-deletion call was actually issued.
    const deletedPaths: string[] = [];
    vi.spyOn(ObjectStorageService.prototype, "getPrivateObjectDir").mockReturnValue("/test-bucket/private");
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockImplementation(
      async function (this: ObjectStorageService, objectPath: string) {
        return {
          delete: async () => { deletedPaths.push(objectPath); },
        } as unknown as Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>>;
      },
    );

    const { memberId } = await createMemberWithUser("export_purge");
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Two completed `access` (data-export) rows for this member, both still
    // inside the 7-day retention window — the daily purger has not yet
    // touched them. Plus one already-purged row (artifactUrl null) which
    // must be left alone, and one "access" row belonging to a *different*
    // member which must also be left alone.
    const [exp1] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "access",
      status: "completed",
      requestedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      resolvedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      artifactUrl: "/objects/uploads/export-1.json",
    }).returning();
    const [exp2] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "access",
      status: "completed",
      requestedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      resolvedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      artifactUrl: "/objects/uploads/export-2.json",
    }).returning();
    const [expAlreadyPurged] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "access",
      status: "completed",
      requestedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      resolvedAt: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000),
      artifactUrl: null,
    }).returning();

    const { memberId: otherMemberId } = await createMemberWithUser("export_other");
    const [otherExport] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: otherMemberId,
      requestType: "access",
      status: "completed",
      requestedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      resolvedAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      artifactUrl: "/objects/uploads/other-export.json",
    }).returning();

    // The erasure row that drives the worker.
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

    // Both outstanding exports are purged: artifactUrl cleared, purgedAt stamped.
    for (const id of [exp1.id, exp2.id]) {
      const [r] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, id));
      expect(r.artifactUrl).toBeNull();
      expect(r.purgedAt).not.toBeNull();
    }

    // Already-purged row left alone — no new purgedAt stamp written for it.
    const [stillPurged] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, expAlreadyPurged.id));
    expect(stillPurged.artifactUrl).toBeNull();
    expect(stillPurged.purgedAt).toBeNull();

    // Other member's export untouched.
    const [otherAfter] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, otherExport.id));
    expect(otherAfter.artifactUrl).toBe("/objects/uploads/other-export.json");
    expect(otherAfter.purgedAt).toBeNull();

    // One audit row per purged export, tagged source=account_erasure.
    const purgeAudits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "data_export"),
        eq(memberAuditLogTable.action, "purge"),
      ));
    const purgedIds = new Set(purgeAudits.map(a => a.entityId));
    expect(purgedIds.has(exp1.id)).toBe(true);
    expect(purgedIds.has(exp2.id)).toBe(true);
    expect(purgedIds.has(expAlreadyPurged.id)).toBe(false);
    expect(purgedIds.has(otherExport.id)).toBe(false);
    for (const audit of purgeAudits) {
      const meta = audit.metadata as { source?: string; artifactUrl?: string } | null;
      expect(meta?.source).toBe("account_erasure");
      expect(meta?.artifactUrl).toMatch(/^\/objects\/uploads\/export-/);
    }

    // The club_member delete audit row records the per-member counters so
    // controllers can tell at a glance how many archives were purged as
    // part of the erasure.
    const [memberDeleteAudit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "club_member"),
        eq(memberAuditLogTable.entityId, memberId),
        eq(memberAuditLogTable.action, "delete"),
      ));
    expect(memberDeleteAudit).toBeDefined();
    const meta = memberDeleteAudit.metadata as { dataExportArchivesPurged?: number; dataExportArchivesFailed?: number } | null;
    expect(meta?.dataExportArchivesPurged).toBe(2);
    expect(meta?.dataExportArchivesFailed).toBe(0);

    // The cron actually invoked the file-deletion call for each export
    // (and only for the two belonging to the erased member). This is the
    // critical privacy guarantee — we must not just clear the DB pointer
    // while leaving the PII-bearing file in storage.
    expect(deletedPaths.sort()).toEqual([
      "/objects/uploads/export-1.json",
      "/objects/uploads/export-2.json",
    ]);
  });

  it("does NOT mark archives purged when object storage is unavailable (Task #971)", async () => {
    // Force the helper's storage-availability probe to fail. A passing
    // assertion here is the privacy-critical guarantee: we never record
    // an archive as purged unless the file was actually deleted.
    vi.spyOn(ObjectStorageService.prototype, "getPrivateObjectDir").mockImplementation(() => {
      throw new Error("PRIVATE_OBJECT_DIR not configured (test)");
    });

    const { memberId } = await createMemberWithUser("export_storage_down");
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [exp] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "access",
      status: "completed",
      requestedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      resolvedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      artifactUrl: "/objects/uploads/export-still-there.json",
    }).returning();

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

    // artifactUrl preserved so a future retry has the pointer to act on,
    // and purgedAt was NOT stamped — the file is still in storage.
    const [after] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, exp.id));
    expect(after.artifactUrl).toBe("/objects/uploads/export-still-there.json");
    expect(after.purgedAt).toBeNull();

    // No data_export purge audit row was emitted for the unfinished delete.
    const purgeAudits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "data_export"),
        eq(memberAuditLogTable.action, "purge"),
        eq(memberAuditLogTable.entityId, exp.id),
      ));
    expect(purgeAudits.length).toBe(0);

    // The club_member delete audit reports the failure so controllers
    // can surface it in the per-member erasure history.
    const [memberDeleteAudit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "club_member"),
        eq(memberAuditLogTable.entityId, memberId),
        eq(memberAuditLogTable.action, "delete"),
      ));
    const meta = memberDeleteAudit.metadata as { dataExportArchivesPurged?: number; dataExportArchivesFailed?: number } | null;
    expect(meta?.dataExportArchivesPurged).toBe(0);
    expect(meta?.dataExportArchivesFailed).toBe(1);
  });

  it("does NOT mark archives purged when object storage rejects the delete call (Task #971)", async () => {
    // Storage is configured but the bucket-delete call itself throws (e.g.
    // a transient 5xx or a misconfigured IAM role). The artifactUrl pointer
    // must be preserved so the next pass can retry, and no purge audit
    // row must be emitted.
    vi.spyOn(ObjectStorageService.prototype, "getPrivateObjectDir").mockReturnValue("/test-bucket/private");
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockImplementation(
      async function (this: ObjectStorageService) {
        return {
          delete: async () => { throw new Error("503 Service Unavailable"); },
        } as unknown as Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>>;
      },
    );

    const { memberId } = await createMemberWithUser("export_delete_fail");
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [exp] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "access",
      status: "completed",
      requestedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      resolvedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      artifactUrl: "/objects/uploads/export-rejected.json",
    }).returning();
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

    const [after] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, exp.id));
    expect(after.artifactUrl).toBe("/objects/uploads/export-rejected.json");
    expect(after.purgedAt).toBeNull();

    const purgeAudits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "data_export"),
        eq(memberAuditLogTable.action, "purge"),
        eq(memberAuditLogTable.entityId, exp.id),
      ));
    expect(purgeAudits.length).toBe(0);
  });

  it("treats already-missing storage objects as successfully purged (Task #971)", async () => {
    // Eventual-consistency catch-up: the file was already deleted by an
    // earlier run but the DB pointer wasn't cleared. The helper treats
    // this as success so the row gets cleaned up rather than lingering
    // forever on the failure branch.
    vi.spyOn(ObjectStorageService.prototype, "getPrivateObjectDir").mockReturnValue("/test-bucket/private");
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockImplementation(
      async function (this: ObjectStorageService) {
        return {
          delete: async () => { throw new ObjectNotFoundError(); },
        } as unknown as Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>>;
      },
    );

    const { memberId } = await createMemberWithUser("export_already_gone");
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [exp] = await db.insert(memberDataRequestsTable).values({
      organizationId: testOrgId,
      clubMemberId: memberId,
      requestType: "access",
      status: "completed",
      requestedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      resolvedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      artifactUrl: "/objects/uploads/export-ghost.json",
    }).returning();
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

    const [after] = await db.select().from(memberDataRequestsTable).where(eq(memberDataRequestsTable.id, exp.id));
    expect(after.artifactUrl).toBeNull();
    expect(after.purgedAt).not.toBeNull();

    const [purgeAudit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "data_export"),
        eq(memberAuditLogTable.action, "purge"),
        eq(memberAuditLogTable.entityId, exp.id),
      ));
    expect(purgeAudit).toBeDefined();
    const meta = purgeAudit.metadata as { source?: string; alreadyMissing?: boolean } | null;
    expect(meta?.source).toBe("account_erasure");
    expect(meta?.alreadyMissing).toBe(true);
  });
});
