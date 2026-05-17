/**
 * Unit test for the `formatRetryRelative` helper (Task #1499).
 *
 * The helper powers the "Email retrying — next try in 2m 14s" /
 * "Push undelivered — gave up 5m ago" suffixes on the wallet
 * withdrawal notify badges in `WalletPanel` (and is mirrored verbatim
 * in `artifacts/kharagolf-mobile/app/wallet.tsx`). A bug in the
 * formatter would silently mislead members about when their next
 * retry is due, so the bucket boundaries are locked here.
 */
import { describe, it, expect } from "vitest";
import { formatRetryRelative } from "../SideGamesAdmin";

const NOW_MS = Date.parse("2026-04-29T10:00:00.000Z");

describe("formatRetryRelative", () => {
  it("returns null for null/empty/garbage input", () => {
    expect(formatRetryRelative(null, NOW_MS)).toBeNull();
    expect(formatRetryRelative("", NOW_MS)).toBeNull();
    expect(formatRetryRelative("not a date", NOW_MS)).toBeNull();
  });

  it("formats sub-second futures as 'in <1s' and pasts as 'just now'", () => {
    const at = new Date(NOW_MS + 200).toISOString();
    expect(formatRetryRelative(at, NOW_MS)).toBe("in <1s");
    const past = new Date(NOW_MS - 50).toISOString();
    expect(formatRetryRelative(past, NOW_MS)).toBe("just now");
  });

  it("formats sub-minute future as 'in Ns'", () => {
    const at = new Date(NOW_MS + 30_000).toISOString();
    expect(formatRetryRelative(at, NOW_MS)).toBe("in 30s");
  });

  it("formats sub-hour future as 'in Mm Ss', dropping a zero-second tail", () => {
    expect(formatRetryRelative(new Date(NOW_MS + 134_000).toISOString(), NOW_MS))
      .toBe("in 2m 14s");
    expect(formatRetryRelative(new Date(NOW_MS + 5 * 60_000).toISOString(), NOW_MS))
      .toBe("in 5m");
  });

  it("formats sub-day future as 'in Hh Mm', dropping a zero-minute tail", () => {
    expect(formatRetryRelative(new Date(NOW_MS + (1 * 3600 + 3 * 60) * 1000).toISOString(), NOW_MS))
      .toBe("in 1h 3m");
    expect(formatRetryRelative(new Date(NOW_MS + 2 * 3600_000).toISOString(), NOW_MS))
      .toBe("in 2h");
  });

  it("formats multi-day future as 'in Dd Hh', dropping a zero-hour tail", () => {
    expect(formatRetryRelative(new Date(NOW_MS + (2 * 86400 + 4 * 3600) * 1000).toISOString(), NOW_MS))
      .toBe("in 2d 4h");
    expect(formatRetryRelative(new Date(NOW_MS + 3 * 86400_000).toISOString(), NOW_MS))
      .toBe("in 3d");
  });

  it("formats past timestamps with 'ago' suffix at every bucket", () => {
    expect(formatRetryRelative(new Date(NOW_MS - 42_000).toISOString(), NOW_MS))
      .toBe("42s ago");
    expect(formatRetryRelative(new Date(NOW_MS - 5 * 60_000).toISOString(), NOW_MS))
      .toBe("5m ago");
    expect(formatRetryRelative(new Date(NOW_MS - 2 * 3600_000).toISOString(), NOW_MS))
      .toBe("2h ago");
    expect(formatRetryRelative(new Date(NOW_MS - 3 * 86400_000).toISOString(), NOW_MS))
      .toBe("3d ago");
  });
});
