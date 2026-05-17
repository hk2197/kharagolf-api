/**
 * Task #1005 — Coverage matrix test.
 *
 * Asserts that every key in the notification registry has an entry in
 * `DISPATCH_COVERAGE`, and vice versa. This guarantees a reviewer can
 * walk the matrix and see exactly where each notification is fired —
 * either in-process via dispatch or event-driven from a cron/webhook.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { listRegistered, hydrate } from "../lib/notificationRegistry.js";
import { DISPATCH_COVERAGE } from "../lib/notificationDispatchCoverage.js";

beforeAll(async () => {
  await hydrate();
});

describe("Task #1005 — registry → dispatch coverage", () => {
  it("every registered notification key has a coverage entry", () => {
    const missing: string[] = [];
    for (const key of listRegistered()) {
      if (!Object.prototype.hasOwnProperty.call(DISPATCH_COVERAGE, key)) {
        missing.push(key);
      }
    }
    expect(missing, `Missing coverage matrix entries for: ${missing.join(", ")}`).toEqual([]);
  });

  it("the coverage matrix has no stale entries", () => {
    const registered = new Set(listRegistered());
    const stale = Object.keys(DISPATCH_COVERAGE).filter(k => !registered.has(k));
    expect(stale, `Coverage entries not in registry: ${stale.join(", ")}`).toEqual([]);
  });

  it("every coverage entry declares a file and trigger note", () => {
    for (const [key, entry] of Object.entries(DISPATCH_COVERAGE)) {
      expect(entry.file, `${key} missing file`).toBeTruthy();
      expect(entry.note, `${key} missing note`).toBeTruthy();
      expect(["in_process", "event_driven"]).toContain(entry.mode);
    }
  });
});
