/**
 * Task #1270 — one-time in-app announcement pointing existing members at
 * the new "Side-game payment receipts" opt-out toggle (Tasks #962/#1105).
 *
 * Task #1105 added a discoverability footer to the side-game receipt email
 * itself, but members who never *receive* a side-game payment (because they
 * only ever pay) would never see that footer. This helper backfills a
 * dismissable in-app announcement card so those members can still find the
 * toggle.
 *
 * Design:
 *   - Lazy-on-read: we never bulk-insert backfill rows. The first time an
 *     eligible member loads the portal we insert a single
 *     `member_messages` row tagged
 *     `relatedEntity = 'side_game_receipt_toggle_announcement'`. Once
 *     marked read it stays read forever.
 *   - Eligibility = the member existed before the announcement shipped.
 *     We compare `clubMembers.createdAt` against
 *     `SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_CUTOFF` so newly-registered
 *     members never see this backfill banner.
 *   - Dismissal = `readAt` set on the row. Calling `getActive...` after
 *     dismissal returns null so the UI hides the card.
 *
 * The card deep-links to `${prefsUrl}` which mirrors the same anchor the
 * receipt email footer uses (`buildCommPrefsUrl()` in
 * `sideGameSettlementPaidNotify.ts`) so behaviour stays consistent across
 * surfaces.
 */
import { db } from "@workspace/db";
import {
  clubMembersTable,
  memberMessagesTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, desc } from "drizzle-orm";
import { logger } from "./logger";

export const SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_KEY =
  "side_game_receipt_toggle_announcement";

/**
 * Cutoff timestamp: only members whose `clubMembers.createdAt` predates
 * this value are eligible for the backfill announcement. Members joining
 * after this date are assumed to have onboarded with the toggle already
 * in place, so the announcement would be noise for them.
 *
 * Set to the day Task #1270 shipped (2026-04-24 UTC). Bumping this value
 * does NOT re-issue the announcement to existing members — once a member
 * has a row with this `relatedEntity` we never insert a second one.
 */
export const SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_CUTOFF =
  new Date("2026-04-24T00:00:00.000Z");

export const SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_SUBJECT =
  "New: control your side-game payment receipts";
export const SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_BODY =
  "You can now opt out of the email receipts another player triggers when they settle a casual side-game wager with you. Open Communication preferences to flip the \"Side-game payment receipts\" switch — it lives under Per-event email opt-outs and only affects side-game receipt emails (levy and other billing receipts are unchanged).";

export interface SideGameReceiptToggleAnnouncement {
  id: number;
  organizationId: number;
  subject: string;
  body: string;
  sentAt: string;
  readAt: string | null;
  prefsUrl: string;
  prefsAnchor: string;
}

/**
 * Resolve the public web origin for the deep link. Mirrors
 * `buildCommPrefsUrl` in `sideGameSettlementPaidNotify.ts` so the in-app
 * card and the receipt email footer point at the same `#comm-prefs`
 * anchor on the portal.
 */
function buildCommPrefsUrl(): string {
  const raw =
    process.env.APP_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    `https://${process.env.REPLIT_DEV_DOMAIN ?? "app.kharagolf.com"}`;
  const baseUrl = raw.replace(/\/+$/, "");
  return `${baseUrl}/portal#comm-prefs`;
}

/**
 * Return the active side-game-receipt-toggle announcement for the caller,
 * lazily creating one when an eligible member first asks.
 *
 * Returns `null` when:
 *   - the user has no `clubMembers` row in any org, OR
 *   - no `clubMembers` row predates the cutoff (i.e. user only joined
 *     after the announcement shipped), OR
 *   - the announcement row exists and the member already dismissed it
 *     (readAt is set).
 *
 * Never throws — DB failures are logged and surfaced as `null` so a
 * broken announcement can't take down the portal dashboard load.
 */
export async function getActiveSideGameReceiptToggleAnnouncement(
  userId: number,
): Promise<SideGameReceiptToggleAnnouncement | null> {
  try {
    const memberRows = await db
      .select({
        id: clubMembersTable.id,
        organizationId: clubMembersTable.organizationId,
        createdAt: clubMembersTable.createdAt,
      })
      .from(clubMembersTable)
      .where(eq(clubMembersTable.userId, userId));
    if (memberRows.length === 0) return null;

    // Eligibility: at least one club_members row must predate the cutoff.
    // We pick the earliest such row to anchor the announcement to (so the
    // member's *original* org owns the inbox row).
    const eligible = memberRows
      .filter(
        (m) =>
          m.createdAt &&
          m.createdAt.getTime() <
            SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_CUTOFF.getTime(),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (eligible.length === 0) return null;

    const memberIds = memberRows.map((m) => m.id);

    // Look for an existing row across ANY of the caller's club_members
    // rows so multi-club members never see two cards. Order by sentAt
    // desc and take the first — there should normally be only one.
    const existing = await db
      .select({
        id: memberMessagesTable.id,
        organizationId: memberMessagesTable.organizationId,
        subject: memberMessagesTable.subject,
        body: memberMessagesTable.body,
        sentAt: memberMessagesTable.sentAt,
        readAt: memberMessagesTable.readAt,
      })
      .from(memberMessagesTable)
      .where(
        and(
          inArray(memberMessagesTable.clubMemberId, memberIds),
          eq(
            memberMessagesTable.relatedEntity,
            SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_KEY,
          ),
          eq(memberMessagesTable.channel, "in_app"),
        ),
      )
      .orderBy(desc(memberMessagesTable.sentAt))
      .limit(1);

    const prefsUrl = buildCommPrefsUrl();

    if (existing.length > 0) {
      const row = existing[0];
      if (row.readAt) return null;
      return {
        id: row.id,
        organizationId: row.organizationId,
        subject: row.subject ?? SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_SUBJECT,
        body: row.body,
        sentAt: row.sentAt.toISOString(),
        readAt: null,
        prefsUrl,
        prefsAnchor: "comm-prefs",
      };
    }

    // Lazy insert anchored to the earliest eligible club_members row.
    const anchor = eligible[0];
    const [inserted] = await db
      .insert(memberMessagesTable)
      .values({
        organizationId: anchor.organizationId,
        clubMemberId: anchor.id,
        channel: "in_app",
        subject: SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_SUBJECT,
        body: SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_BODY,
        status: "sent",
        relatedEntity: SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_KEY,
      })
      .returning({
        id: memberMessagesTable.id,
        sentAt: memberMessagesTable.sentAt,
      });

    return {
      id: inserted.id,
      organizationId: anchor.organizationId,
      subject: SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_SUBJECT,
      body: SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_BODY,
      sentAt: inserted.sentAt.toISOString(),
      readAt: null,
      prefsUrl,
      prefsAnchor: "comm-prefs",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { userId, errMsg: reason },
      "[side-game-receipt-toggle-announcement] failed to resolve announcement",
    );
    return null;
  }
}

/**
 * Mark the side-game-receipt-toggle announcement as dismissed for every
 * `club_members` row owned by the caller. A member with two club_members
 * rows (multi-club) gets every announcement row stamped read in one call
 * so the card never reappears when they switch acting clubs.
 *
 * Returns `{ updated: number }` — the count is purely advisory. Idempotent:
 * a second call after a successful dismissal returns `updated: 0`.
 */
export async function dismissSideGameReceiptToggleAnnouncement(
  userId: number,
): Promise<{ updated: number }> {
  try {
    const memberRows = await db
      .select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(eq(clubMembersTable.userId, userId));
    if (memberRows.length === 0) return { updated: 0 };

    const memberIds = memberRows.map((m) => m.id);
    const updated = await db
      .update(memberMessagesTable)
      .set({ readAt: new Date() })
      .where(
        and(
          inArray(memberMessagesTable.clubMemberId, memberIds),
          eq(
            memberMessagesTable.relatedEntity,
            SIDE_GAME_RECEIPT_TOGGLE_ANNOUNCEMENT_KEY,
          ),
          eq(memberMessagesTable.channel, "in_app"),
          isNull(memberMessagesTable.readAt),
        ),
      )
      .returning({ id: memberMessagesTable.id });
    return { updated: updated.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { userId, errMsg: reason },
      "[side-game-receipt-toggle-announcement] failed to dismiss announcement",
    );
    return { updated: 0 };
  }
}

