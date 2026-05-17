/**
 * Test: notify-on-completion path for highlight reels (Task #657).
 *
 * Verifies `notifyHighlightReady` (the helper invoked by the highlight
 * worker after each render attempt):
 *   - Fires a push with type='highlight_render_complete' + reelId when
 *     the reel transitions to status='ready'.
 *   - Fires a "failed" push when the reel transitions to status='failed'.
 *   - Skips silently when the reel is still queued for retry — transient
 *     ffmpeg failures must not spam the user with "failed" notifications.
 *   - Skips when the recipient has set preferPush=false.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendPushToUsersMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({
      attempted: 1, sent: 1, failed: 0, invalid: 0,
    }),
  ),
}));

vi.mock("../lib/push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
  // Mirror the real classifyPushDelivery decision rule from src/lib/push.ts
  // so notifyHighlightReady can map the mocked result onto the right
  // sent / failed / no_address status. Without this, the import in
  // notifications.ts throws and every push call here is reported as
  // "failed" regardless of the mock's result shape.
  classifyPushDelivery: (result: { sent: number; failed: number }) => {
    if (result.sent > 0) return "sent";
    if (result.failed > 0) return "failed";
    return "no_address";
  },
}));

import { db, highlightReelsTable, organizationsTable, appUsersTable, userNotificationPrefsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { notifyHighlightReady } from "../lib/notifications.js";

let orgId: number;
let userId: number;
const reelIds: number[] = [];

async function makeReel(status: "queued" | "rendering" | "ready" | "failed", title = "My Round"): Promise<number> {
  const [r] = await db.insert(highlightReelsTable).values({
    organizationId: orgId,
    userId,
    title,
    templateId: "classic",
    status,
    attempts: status === "queued" ? 1 : 0,
    nextAttemptAt: new Date(Date.now() + 60_000),
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `HighlightNotifyOrg_${ts}`,
    slug: `highlight-notify-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `highlight-notify-${ts}`,
    username: `highlight_notify_${ts}`,
    email: `${ts}@example.test`,
    displayName: "Highlight Notify Tester",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
});

afterAll(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
  }
  if (userId) {
    await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendPushToUsersMock.mockClear();
  sendPushToUsersMock.mockResolvedValue({ attempted: 1, sent: 1, failed: 0, invalid: 0 });
  if (reelIds.length > 0) {
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
    reelIds.length = 0;
  }
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
});

describe("notifyHighlightReady — terminal-state push", () => {
  it("sends a 'ready' push with deep-link metadata when a reel finishes rendering", async () => {
    const reelId = await makeReel("ready", "Saturday Round");

    const result = await notifyHighlightReady(reelId);

    expect(result.status).toBe("sent");
    expect(result.reelStatus).toBe("ready");
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [recipients, title, body, data] = sendPushToUsersMock.mock.calls[0]!;
    expect(recipients).toEqual([userId]);
    expect(String(title).toLowerCase()).toContain("ready");
    expect(String(body)).toContain("Saturday Round");
    expect(data).toMatchObject({
      type: "highlight_render_complete",
      reelId,
      status: "ready",
      organizationId: orgId,
    });
  });

  it("sends a 'failed' push when retries are exhausted", async () => {
    const reelId = await makeReel("failed");

    const result = await notifyHighlightReady(reelId);

    expect(result.status).toBe("sent");
    expect(result.reelStatus).toBe("failed");
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [, title, , data] = sendPushToUsersMock.mock.calls[0]!;
    expect(String(title).toLowerCase()).toContain("failed");
    expect(data).toMatchObject({ type: "highlight_render_complete", reelId, status: "failed" });
  });

  it("skips silently when the reel is still queued for retry (no spam)", async () => {
    const reelId = await makeReel("queued");

    const result = await notifyHighlightReady(reelId);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("non_terminal_status");
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
  });

  it("skips when the recipient has opted out of push notifications", async () => {
    const reelId = await makeReel("ready");
    await db.insert(userNotificationPrefsTable).values({
      userId,
      preferPush: false,
    });

    const result = await notifyHighlightReady(reelId);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("opted_out");
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
  });

  it("translates the push into the recipient's preferred language", async () => {
    await db.update(appUsersTable)
      .set({ preferredLanguage: "es" })
      .where(eq(appUsersTable.id, userId));
    try {
      const reelId = await makeReel("ready", "Saturday Round");

      const result = await notifyHighlightReady(reelId);

      expect(result.status).toBe("sent");
      const [, title, body] = sendPushToUsersMock.mock.calls[0]!;
      expect(String(title)).toBe("Tu reel destacado está listo");
      expect(String(body)).toBe("Tu reel ya está listo para ver: Saturday Round.");
    } finally {
      await db.update(appUsersTable)
        .set({ preferredLanguage: "en" })
        .where(eq(appUsersTable.id, userId));
    }
  });

  it("uses the language's localised default title when the failed reel has no title", async () => {
    await db.update(appUsersTable)
      .set({ preferredLanguage: "ja" })
      .where(eq(appUsersTable.id, userId));
    try {
      const reelId = await makeReel("failed", "");

      const result = await notifyHighlightReady(reelId);

      expect(result.status).toBe("sent");
      const [, title, body] = sendPushToUsersMock.mock.calls[0]!;
      expect(String(title)).toBe("ハイライトリールの作成に失敗しました");
      expect(String(body)).toContain("ラウンドハイライト");
    } finally {
      await db.update(appUsersTable)
        .set({ preferredLanguage: "en" })
        .where(eq(appUsersTable.id, userId));
    }
  });

  it("returns no_address when the user has no registered device tokens", async () => {
    const reelId = await makeReel("ready");
    sendPushToUsersMock.mockResolvedValueOnce({ attempted: 0, sent: 0, failed: 0, invalid: 0 });

    const result = await notifyHighlightReady(reelId);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_address");
  });
});
