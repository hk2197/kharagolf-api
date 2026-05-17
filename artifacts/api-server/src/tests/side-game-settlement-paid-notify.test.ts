/**
 * Task #614, Task #771 — recipient notification when a side-game settlement
 * is paid.
 *
 * Verifies the helper:
 *   - writes an in-app inbox row for the recipient when they have a
 *     club_members row in the instance's organization
 *   - skips the in-app row when the recipient is not a club member of
 *     the org (cross-club guest case) but still attempts push + email
 *   - skips entirely (no exception) when the settlement has no recipient
 *     userId (foreign player with no linked account)
 *   - is invoked indirectly by markSettlementPaid (Razorpay verify /
 *     webhook path)
 *   - sends a transactional email receipt to the recipient (Task #771)
 *     and respects the user-level `preferEmail` opt-out plus the
 *     member-comm `billing` category opt-out
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers.js";

// Mock the mailer BEFORE importing the unit under test so the email channel
// doesn't try to talk to real SMTP during the test run.
vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendSideGameSettlementReceiptEmail: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  playersTable,
  tournamentsTable,
  sideGameInstancesTable,
  sideGameSettlementsTable,
  clubMembersTable,
  memberMessagesTable,
  memberCommPrefsTable,
  userNotificationPrefsTable,
  coursesTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { notifySettlementPaid } from "../lib/sideGameSettlementPaidNotify.js";
import { markSettlementPaid } from "../routes/side-games-v2.js";
import { sendSideGameSettlementReceiptEmail } from "../lib/mailer.js";

const emailMock = vi.mocked(sendSideGameSettlementReceiptEmail);

let orgId: number;
let payerUserId: number;
let recipientUserId: number;
let recipientNoMemberUserId: number;
let payerPlayerId: number;
let recipientPlayerId: number;
let recipientNoMemberPlayerId: number;
let foreignPlayerId: number;
let courseId: number;
let tournamentId: number;
let instanceId: number;
let recipientClubMemberId: number;

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T614-${ts}`,
    slug: `t614-${ts}`,
    contactEmail: `t614-${ts}@example.test`,
  }).returning();
  orgId = org.id;

  const [payer] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t614_payer_${ts}`,
    username: `t614_payer_${ts}`,
    email: `payer_${ts}@example.test`,
    displayName: "Payer Q",
    role: "player",
    organizationId: orgId,
  }).returning();
  payerUserId = payer.id;

  const [rec] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t614_rec_${ts}`,
    username: `t614_rec_${ts}`,
    email: `rec_${ts}@example.test`,
    displayName: "Recipient Q",
    role: "player",
    organizationId: orgId,
  }).returning();
  recipientUserId = rec.id;

  const [recNoMember] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t614_recnm_${ts}`,
    username: `t614_recnm_${ts}`,
    email: `recnm_${ts}@example.test`,
    displayName: "Cross-club Guest",
    role: "player",
  }).returning();
  recipientNoMemberUserId = recNoMember.id;

  // club_members row only for the in-org recipient.
  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: recipientUserId,
    firstName: "Recipient",
    lastName: "Q",
    email: `rec_${ts}@example.test`,
  }).returning();
  recipientClubMemberId = cm.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "T614 Course", slug: `t614-course-${ts}`,
  }).returning();
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: "T614 Test Tournament",
    startDate: new Date(),
    rounds: 1,
    status: "completed",
  }).returning();
  tournamentId = tournament.id;

  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: payerUserId, firstName: "Payer", lastName: "Q",
  }).returning();
  payerPlayerId = pPlayer.id;

  const [rPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: recipientUserId, firstName: "Recipient", lastName: "Q",
  }).returning();
  recipientPlayerId = rPlayer.id;

  const [rNmPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: recipientNoMemberUserId, firstName: "Guest", lastName: "Q",
  }).returning();
  recipientNoMemberPlayerId = rNmPlayer.id;

  const [foreignPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: null, firstName: "Foreign", lastName: "Q",
  }).returning();
  foreignPlayerId = foreignPlayer.id;

  const [instance] = await db.insert(sideGameInstancesTable).values({
    organizationId: orgId,
    tournamentId,
    round: 1,
    gameType: "skins",
    name: "Saturday Skins",
    rules: {},
    events: {},
    status: "completed",
    participantPlayerIds: [payerPlayerId, recipientPlayerId, recipientNoMemberPlayerId, foreignPlayerId],
    participantUserIds: [payerUserId, recipientUserId, recipientNoMemberUserId],
    participantNames: {},
    createdByUserId: payerUserId,
  }).returning();
  instanceId = instance.id;
});

afterAll(async () => {
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, recipientClubMemberId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, recipientUserId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, recipientNoMemberUserId));
  await db.delete(sideGameSettlementsTable).where(eq(sideGameSettlementsTable.instanceId, instanceId));
  await db.delete(sideGameInstancesTable).where(eq(sideGameInstancesTable.id, instanceId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, recipientClubMemberId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, payerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, recipientUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, recipientNoMemberUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(() => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
});

async function makeSettlement(opts: { fromPlayerId: number | null; toPlayerId: number | null; amount: string; }) {
  const [s] = await db.insert(sideGameSettlementsTable).values({
    instanceId,
    fromPlayerId: opts.fromPlayerId,
    fromName: "Payer Q",
    toPlayerId: opts.toPlayerId,
    toName: "Recipient",
    amount: opts.amount,
    currency: "INR",
    status: "paid",
    paymentMethod: "wallet",
    paidAt: new Date(),
  }).returning();
  return s;
}

describe("Task #614 — settlement paid notification", () => {
  it("writes an in-app message when the recipient is a club member of the org", async () => {
    const s = await makeSettlement({
      fromPlayerId: payerPlayerId,
      toPlayerId: recipientPlayerId,
      amount: "12.50",
    });
    const result = await notifySettlementPaid(s.id);
    expect(result.status).not.toBe("failed");
    expect(result.inApp.status).toBe("sent");
    expect(result.inApp.messageId).toBeGreaterThan(0);

    const [msg] = await db.select().from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.clubMemberId, recipientClubMemberId),
        eq(memberMessagesTable.relatedEntity, "side_game_settlement"),
        eq(memberMessagesTable.relatedEntityId, s.id),
      )).orderBy(desc(memberMessagesTable.id)).limit(1);
    expect(msg).toBeDefined();
    expect(msg.body).toContain("Payer Q paid you ₹12.50");
    expect(msg.body).toContain("Saturday Skins");
    expect(msg.subject).toContain("₹12.50");
  });

  it("skips the in-app message when the recipient has no club membership in the org", async () => {
    const s = await makeSettlement({
      fromPlayerId: payerPlayerId,
      toPlayerId: recipientNoMemberPlayerId,
      amount: "5.00",
    });
    const result = await notifySettlementPaid(s.id);
    expect(result.inApp.status).toBe("skipped");

    const rows = await db.select().from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.relatedEntity, "side_game_settlement"),
        eq(memberMessagesTable.relatedEntityId, s.id),
      ));
    expect(rows.length).toBe(0);
  });

  it("skips silently when the recipient has no linked app user", async () => {
    const s = await makeSettlement({
      fromPlayerId: payerPlayerId,
      toPlayerId: foreignPlayerId,
      amount: "8.00",
    });
    const result = await notifySettlementPaid(s.id);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_recipient_user");
    expect(result.inApp.status).toBe("skipped");
    expect(result.push.status).toBe("skipped");
    expect(result.email.status).toBe("skipped");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("returns skipped when the settlement does not exist (no throw)", async () => {
    const result = await notifySettlementPaid(999_999_999);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("settlement_not_found");
  });

  it("/pay retried on an already-paid settlement does NOT create a duplicate notification", async () => {
    const [pending] = await db.insert(sideGameSettlementsTable).values({
      instanceId,
      fromPlayerId: payerPlayerId,
      fromName: "Payer Q",
      toPlayerId: recipientPlayerId,
      toName: "Recipient Q",
      amount: "2.00",
      currency: "INR",
      status: "pending",
    }).returning();

    const app = createTestApp({
      id: payerUserId, username: "payer", role: "player", organizationId: orgId,
    });

    const r1 = await request(app).post(`/api/side-game-settlements/${pending.id}/pay`).send({
      paymentMethod: "cash", paymentRef: "first",
    });
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe("paid");
    expect(r1.body.paymentRef).toBe("first");

    // Wait for the fire-and-forget notify from the first call to land.
    for (let i = 0; i < 50; i++) {
      const rows = await db.select({ id: memberMessagesTable.id }).from(memberMessagesTable)
        .where(and(
          eq(memberMessagesTable.relatedEntity, "side_game_settlement"),
          eq(memberMessagesTable.relatedEntityId, pending.id),
        ));
      if (rows.length > 0) break;
      await new Promise(r => setTimeout(r, 20));
    }

    // Retry with a different paymentRef — must not flip the existing
    // paymentRef and must not create a second in-app message.
    const r2 = await request(app).post(`/api/side-game-settlements/${pending.id}/pay`).send({
      paymentMethod: "cash", paymentRef: "second",
    });
    expect(r2.status).toBe(200);
    expect(r2.body.paymentRef).toBe("first");

    // Give any spurious notify a chance to write before asserting.
    await new Promise(r => setTimeout(r, 100));
    const msgs = await db.select().from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.relatedEntity, "side_game_settlement"),
        eq(memberMessagesTable.relatedEntityId, pending.id),
      ));
    expect(msgs.length).toBe(1);
  });

  it("also writes an in-app message to the payer (Task #772)", async () => {
    // Add a club_members row for the payer so the in-app insert lands.
    const [payerCm] = await db.insert(clubMembersTable).values({
      organizationId: orgId,
      userId: payerUserId,
      firstName: "Payer",
      lastName: "Q",
      email: `payer_extra_${Date.now()}@example.test`,
    }).returning();
    try {
      const s = await makeSettlement({
        fromPlayerId: payerPlayerId,
        toPlayerId: recipientPlayerId,
        amount: "7.75",
      });
      const result = await notifySettlementPaid(s.id);
      expect(result.payerInApp.status).toBe("sent");
      expect(result.payerInApp.messageId).toBeGreaterThan(0);

      const [payerMsg] = await db.select().from(memberMessagesTable)
        .where(and(
          eq(memberMessagesTable.clubMemberId, payerCm.id),
          eq(memberMessagesTable.relatedEntity, "side_game_settlement"),
          eq(memberMessagesTable.relatedEntityId, s.id),
        )).orderBy(desc(memberMessagesTable.id)).limit(1);
      expect(payerMsg).toBeDefined();
      expect(payerMsg.subject).toContain("You paid");
      expect(payerMsg.body).toContain("₹7.75");
      expect(payerMsg.body).toContain("Saturday Skins");
      expect(payerMsg.body).toContain("receipt");
    } finally {
      await db.delete(memberMessagesTable).where(eq(memberMessagesTable.clubMemberId, payerCm.id));
      await db.delete(clubMembersTable).where(eq(clubMembersTable.id, payerCm.id));
    }
  });

  it("skips the payer in-app message when the payer has no club membership in the org", async () => {
    // Payer has a linked user but no club_members row in this org.
    const s = await makeSettlement({
      fromPlayerId: payerPlayerId,
      toPlayerId: recipientPlayerId,
      amount: "1.50",
    });
    const result = await notifySettlementPaid(s.id);
    expect(result.payerInApp.status).toBe("skipped");
  });

  it("markSettlementPaid triggers a recipient notification for the in-org recipient", async () => {
    const [pending] = await db.insert(sideGameSettlementsTable).values({
      instanceId,
      fromPlayerId: payerPlayerId,
      fromName: "Payer Q",
      toPlayerId: recipientPlayerId,
      toName: "Recipient Q",
      amount: "3.25",
      currency: "INR",
      status: "pending",
    }).returning();
    const before = await db.select({ id: memberMessagesTable.id }).from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.clubMemberId, recipientClubMemberId),
        eq(memberMessagesTable.relatedEntity, "side_game_settlement"),
        eq(memberMessagesTable.relatedEntityId, pending.id),
      ));
    expect(before.length).toBe(0);

    const updated = await markSettlementPaid({
      settlementId: pending.id,
      paymentMethod: "razorpay",
      paymentRef: "pay_t614",
      source: "verify",
    });
    expect(updated?.status).toBe("paid");

    // markSettlementPaid fires the notify in the background; await a couple
    // of ticks so the in-app insert flushes before we assert on it.
    for (let i = 0; i < 50; i++) {
      const rows = await db.select({ id: memberMessagesTable.id }).from(memberMessagesTable)
        .where(and(
          eq(memberMessagesTable.clubMemberId, recipientClubMemberId),
          eq(memberMessagesTable.relatedEntity, "side_game_settlement"),
          eq(memberMessagesTable.relatedEntityId, pending.id),
        ));
      if (rows.length > 0) break;
      await new Promise(r => setTimeout(r, 20));
    }
    const after = await db.select().from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.clubMemberId, recipientClubMemberId),
        eq(memberMessagesTable.relatedEntity, "side_game_settlement"),
        eq(memberMessagesTable.relatedEntityId, pending.id),
      ));
    expect(after.length).toBe(1);
    expect(after[0].body).toContain("₹3.25");
  });

  // ── Task #771 — email channel ─────────────────────────────────────────
  describe("Task #771 — email receipt", () => {
    it("emails the recipient with payer + amount + game when in-org", async () => {
      const s = await makeSettlement({
        fromPlayerId: payerPlayerId,
        toPlayerId: recipientPlayerId,
        amount: "7.50",
      });
      const result = await notifySettlementPaid(s.id);
      expect(result.email.status).toBe("sent");
      expect(emailMock).toHaveBeenCalledTimes(1);
      const args = emailMock.mock.calls[0][0];
      expect(args.to).toMatch(/^rec_/);
      expect(args.amount).toBe("7.50");
      expect(args.currencySymbol).toBe("₹");
      expect(args.payerName).toBe("Payer Q");
      expect(args.gameLabel).toBe("Saturday Skins");
    });

    it("falls back to the app user's email for cross-club guests (no club membership)", async () => {
      const s = await makeSettlement({
        fromPlayerId: payerPlayerId,
        toPlayerId: recipientNoMemberPlayerId,
        amount: "4.00",
      });
      const result = await notifySettlementPaid(s.id);
      expect(result.email.status).toBe("sent");
      expect(emailMock).toHaveBeenCalledTimes(1);
      expect(emailMock.mock.calls[0][0].to).toMatch(/^recnm_/);
    });

    it("respects the user-level preferEmail opt-out", async () => {
      await db.insert(userNotificationPrefsTable).values({
        userId: recipientUserId,
        preferEmail: false,
        preferPush: true,
      }).onConflictDoUpdate({
        target: userNotificationPrefsTable.userId,
        set: { preferEmail: false, updatedAt: new Date() },
      });
      try {
        const s = await makeSettlement({
          fromPlayerId: payerPlayerId,
          toPlayerId: recipientPlayerId,
          amount: "1.00",
        });
        const result = await notifySettlementPaid(s.id);
        expect(result.email.status).toBe("opted_out");
        expect(emailMock).not.toHaveBeenCalled();
      } finally {
        await db.delete(userNotificationPrefsTable)
          .where(eq(userNotificationPrefsTable.userId, recipientUserId));
      }
    });

    it("respects the side-game-specific email opt-out (Task #962)", async () => {
      await db.insert(userNotificationPrefsTable).values({
        userId: recipientUserId,
        preferEmail: true,
        preferPush: true,
        notifySideGameReceipts: false,
      }).onConflictDoUpdate({
        target: userNotificationPrefsTable.userId,
        set: { preferEmail: true, notifySideGameReceipts: false, updatedAt: new Date() },
      });
      try {
        const s = await makeSettlement({
          fromPlayerId: payerPlayerId,
          toPlayerId: recipientPlayerId,
          amount: "2.00",
        });
        const result = await notifySettlementPaid(s.id);
        expect(result.email.status).toBe("opted_out");
        expect(emailMock).not.toHaveBeenCalled();
        // In-app + push are unaffected.
        expect(result.inApp.status).toBe("sent");
      } finally {
        await db.delete(userNotificationPrefsTable)
          .where(eq(userNotificationPrefsTable.userId, recipientUserId));
      }
    });

    it("respects the member-comm billing-category email opt-out", async () => {
      await db.insert(memberCommPrefsTable).values({
        organizationId: orgId,
        clubMemberId: recipientClubMemberId,
        category: "billing",
        emailEnabled: false,
        pushEnabled: true,
        smsEnabled: false,
      }).onConflictDoNothing();
      try {
        const s = await makeSettlement({
          fromPlayerId: payerPlayerId,
          toPlayerId: recipientPlayerId,
          amount: "9.00",
        });
        const result = await notifySettlementPaid(s.id);
        expect(result.email.status).toBe("opted_out");
        expect(emailMock).not.toHaveBeenCalled();
      } finally {
        await db.delete(memberCommPrefsTable).where(and(
          eq(memberCommPrefsTable.clubMemberId, recipientClubMemberId),
          eq(memberCommPrefsTable.category, "billing"),
        ));
      }
    });

    it("returns failed (best-effort) when the mailer throws but does not throw to caller", async () => {
      emailMock.mockRejectedValueOnce(new Error("smtp_unavailable"));
      const s = await makeSettlement({
        fromPlayerId: payerPlayerId,
        toPlayerId: recipientPlayerId,
        amount: "2.50",
      });
      const result = await notifySettlementPaid(s.id);
      expect(result.email.status).toBe("failed");
      expect(result.email.error).toContain("smtp_unavailable");
      // Other channels still attempted.
      expect(result.inApp.status).toBe("sent");
    });

    // Task #1502 / Task #1850 — provider_unconfigured branch (lib line 432).
    // A misconfigured mailer (no SMTP host / no RESEND_API_KEY / etc.) is an
    // env-wide condition, not a per-recipient bounce. The helper must
    // classify it once via `classifyMailerError`, mark email as terminal
    // `skipped`/`provider_not_configured`, and leave the other channels
    // untouched — so a single misconfig doesn't burn the bounded retry
    // budget or surface a per-receipt warn line.
    it("provider_unconfigured: marks email skipped/provider_not_configured (does not block other channels)", async () => {
      emailMock.mockRejectedValueOnce(new Error("SMTP host not configured"));
      const s = await makeSettlement({
        fromPlayerId: payerPlayerId,
        toPlayerId: recipientPlayerId,
        amount: "3.50",
      });
      const result = await notifySettlementPaid(s.id);
      expect(result.email.status).toBe("skipped");
      expect(result.email.error).toBe("provider_not_configured");
      // The other channels run independently; in-app still landed.
      expect(result.inApp.status).toBe("sent");
    });
  });
});
