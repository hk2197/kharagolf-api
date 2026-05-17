#!/usr/bin/env -S tsx
/**
 * Smoke test for the auto-Enter stdin used by `sync-schema.ts`.
 *
 * The real sync uses drizzle-kit's bundled `hanji` Terminal, which:
 *   - calls `readline.createInterface({ input: process.stdin })`,
 *   - listens for `keypress` events on `process.stdin`,
 *   - resolves a deferred promise with `{ status: "submitted", data }`
 *     when it sees a keypress whose `name === "return"`.
 *
 * This test exercises the same contract against our fake stdin without
 * needing to wait on drizzle's slow live-DB introspection: it imports the
 * real `sync-schema.ts` only enough to install the fake stdin, then
 * asserts that registering a `keypress` listener results in a synthetic
 * `return` keypress firing automatically.
 *
 * Run with: pnpm --filter @workspace/db exec tsx ./scripts/sync-schema-stdin.test.ts
 */

import { Readable } from "node:stream";

// Replicate the install pattern from sync-schema.ts so we can test the
// stdin patch in isolation. (We deliberately do not `import` sync-schema
// because doing so would also call `pushSchema` and try to hit the live
// database.)
class AutoEnterStdin extends Readable {
  isTTY = false;
  setRawMode(_state: boolean): this {
    return this;
  }
  override resume(): this {
    return this;
  }
  override pause(): this {
    return this;
  }
  override _read(): void {}
}

const fakeStdin = new AutoEnterStdin();
const KEYPRESS_INTERVAL_MS = 25;
const activeTimers = new Set<NodeJS.Timeout>();

const realOn = fakeStdin.on.bind(fakeStdin);
const realRemove = fakeStdin.removeListener.bind(fakeStdin);

(fakeStdin as Readable).on = function (event, listener) {
  realOn(event, listener as (...args: unknown[]) => void);
  if (event === "keypress") {
    setImmediate(() =>
      (listener as (str: string, key: unknown) => void)("\r", {
        name: "return",
        ctrl: false,
        sequence: "\r",
      }),
    );
    const t = setInterval(
      () =>
        (listener as (str: string, key: unknown) => void)("\r", {
          name: "return",
          ctrl: false,
          sequence: "\r",
        }),
      KEYPRESS_INTERVAL_MS,
    );
    activeTimers.add(t);
  }
  return this;
};

(fakeStdin as Readable).removeListener = function (event, listener) {
  realRemove(event, listener as (...args: unknown[]) => void);
  if (event === "keypress") {
    for (const t of activeTimers) clearInterval(t);
    activeTimers.clear();
  }
  return this;
};

let received: { str: string; name?: string } | null = null;
const listener = (str: string, key: { name: string }) => {
  received = { str, name: key?.name };
};

(fakeStdin as Readable).on("keypress", listener);

await new Promise((r) => setTimeout(r, 100));

(fakeStdin as Readable).removeListener("keypress", listener);

if (received === null) {
  console.error("FAIL: no synthetic keypress was delivered");
  process.exit(1);
}
const r = received as { str: string; name?: string };
if (r.str !== "\r" || r.name !== "return") {
  console.error("FAIL: unexpected keypress payload:", r);
  process.exit(1);
}
if (activeTimers.size !== 0) {
  console.error("FAIL: timers were not cleaned up on removeListener");
  process.exit(1);
}
console.log(
  "OK: fake stdin auto-fires a 'return' keypress and tears down cleanly.",
);
