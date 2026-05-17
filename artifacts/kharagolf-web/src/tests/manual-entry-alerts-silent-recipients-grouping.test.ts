/**
 * Task #1670 — Unit coverage for `groupSilentRecipientsByUser`, the helper
 * that powers the per-alert silent-recipients drill-down on the super-admin
 * manual-entry alert dashboard
 * (`artifacts/kharagolf-web/src/pages/manual-entry-alerts.tsx`).
 *
 * Pre-task #1670 the panel showed one row per (user, channel) failure, so
 * a person who got nothing on push *and* nothing on email rendered twice.
 * The helper now collapses those into one row per person with a badge per
 * failing channel, so ops can size the unique-people problem at a glance.
 *
 * The assertions below pin the three behaviours the panel relies on:
 *
 *   - One row per userId (with a single shared "Unknown" bucket for null).
 *   - Worst cases (most failed channels) sort to the top.
 *   - The user's display info (name/username/email) is preserved even if
 *     the first row for that user happens to have null fields.
 */
import { describe, it, expect } from "vitest";
import {
  groupSilentRecipientsByUser,
  type SilentRecipient,
} from "@/pages/manual-entry-alerts";

function recipient(overrides: Partial<SilentRecipient>): SilentRecipient {
  return {
    userId: 1,
    displayName: null,
    username: null,
    email: null,
    channel: "push",
    status: "failed",
    errorMessage: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    // Task #2075 — defaults to a real per-user delivery row; tests
    // exercising the backfill provenance path opt in via the override.
    reconstructed: false,
    ...overrides,
  };
}

describe("groupSilentRecipientsByUser (Task #1670)", () => {
  it("collapses two channel failures for the same user into one row", () => {
    const groups = groupSilentRecipientsByUser([
      recipient({
        userId: 7,
        displayName: "Jane Doe",
        email: "jane@example.com",
        channel: "push",
        status: "failed",
        errorMessage: "expo unreachable",
      }),
      recipient({
        userId: 7,
        displayName: "Jane Doe",
        email: "jane@example.com",
        channel: "email",
        status: "opted_out",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].userId).toBe(7);
    expect(groups[0].displayName).toBe("Jane Doe");
    expect(groups[0].failures.map((f) => f.channel)).toEqual(["push", "email"]);
    expect(groups[0].failures.map((f) => f.status)).toEqual(["failed", "opted_out"]);
  });

  it("sorts users with more failed channels above users with fewer", () => {
    const groups = groupSilentRecipientsByUser([
      // Single-channel failure — should sort below the both-channels user.
      recipient({ userId: 11, displayName: "Alice", channel: "push", status: "failed" }),
      // Both channels failed — should sort first.
      recipient({ userId: 22, displayName: "Bob", channel: "push", status: "failed" }),
      recipient({ userId: 22, displayName: "Bob", channel: "email", status: "no_email" }),
    ]);

    expect(groups.map((g) => g.userId)).toEqual([22, 11]);
  });

  it("keeps push before email regardless of input order", () => {
    const groups = groupSilentRecipientsByUser([
      recipient({ userId: 5, channel: "email", status: "no_email" }),
      recipient({ userId: 5, channel: "push", status: "failed" }),
    ]);

    expect(groups[0].failures.map((f) => f.channel)).toEqual(["push", "email"]);
  });

  it("buckets every null-userId row into a single 'Unknown' group", () => {
    const groups = groupSilentRecipientsByUser([
      recipient({ userId: null, channel: "push", status: "no_address" }),
      recipient({ userId: null, channel: "email", status: "no_email" }),
      recipient({ userId: null, channel: "push", status: "failed", errorMessage: "boom" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].userId).toBeNull();
    expect(groups[0].failures).toHaveLength(3);
  });

  it("backfills display info from a later row when the first row has null fields", () => {
    const groups = groupSilentRecipientsByUser([
      // First row for user 9 has no joinable user fields.
      recipient({
        userId: 9,
        displayName: null,
        username: null,
        email: null,
        channel: "push",
        status: "failed",
      }),
      // Second row joined to app_users and brought the names along.
      recipient({
        userId: 9,
        displayName: "Carol",
        username: "carol01",
        email: "carol@example.com",
        channel: "email",
        status: "opted_out",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].displayName).toBe("Carol");
    expect(groups[0].username).toBe("carol01");
    expect(groups[0].email).toBe("carol@example.com");
  });

  it("returns an empty array when given no recipients", () => {
    expect(groupSilentRecipientsByUser([])).toEqual([]);
  });
});
