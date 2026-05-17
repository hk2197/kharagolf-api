/**
 * Shared helper: replace `process.stdin` with a fake Readable that
 * auto-fires `\r` (Enter) keypresses whenever drizzle-kit's bundled
 * `hanji` Terminal class attaches a `keypress` listener. This makes
 * every drizzle Select / ResolveSelect prompt deterministically pick
 * the first option, which is always the safe choice:
 *
 *   - "rename vs. create new" → defaults to **create new** (the new
 *     table/column is created; the missing one stays in `deleted` and
 *     surfaces in the diff so callers can decide what to do with it).
 *   - "truncate this table to add a unique constraint?" → defaults to
 *     **No, add the constraint without truncating** (no data loss; the
 *     apply will fail loudly later if existing rows violate the
 *     constraint).
 *
 * Usage (call ONCE, before importing drizzle-kit/api):
 *
 *   import { installAutoEnterStdin } from "./auto-enter-stdin.ts";
 *   installAutoEnterStdin();
 *   const drizzleApi = await import("drizzle-kit/api");
 *
 * Originally lifted out of `sync-schema.ts` so the new
 * `check-migrations-cover-schema.ts` (Task #1199) can reuse the exact
 * same prompt-handling without duplicating ~80 lines of fragile glue.
 */

import { Readable } from "node:stream";

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
  override _read(): void {
    // No real input; we synthesize keypress events directly.
  }
}

let installed = false;

export function installAutoEnterStdin(): void {
  if (installed) return;
  installed = true;

  const fakeStdin = new AutoEnterStdin();
  const KEYPRESS_INTERVAL_MS = 25;
  const activeKeypressTimers = new Set<NodeJS.Timeout>();

  const realOn = fakeStdin.on.bind(fakeStdin);
  const realRemoveListener = fakeStdin.removeListener.bind(fakeStdin);

  function fireReturn(cb: (...args: unknown[]) => void): void {
    try {
      cb("\r", { name: "return", ctrl: false, sequence: "\r" });
    } catch {
      /* drizzle's handler already detached — ignore. */
    }
  }

  (fakeStdin as Readable).on = function patchedOn(
    this: Readable,
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) {
    realOn(event, listener);
    if (event === "keypress") {
      // Defer the first press so the Terminal constructor finishes
      // binding its `resolve` callback, then keep tapping Enter until
      // the listener is detached. This handles both single Select
      // prompts and the rename-resolution loop in
      // `promptNamedWithSchemasConflict`.
      setImmediate(() => fireReturn(listener));
      const timer = setInterval(
        () => fireReturn(listener),
        KEYPRESS_INTERVAL_MS,
      );
      activeKeypressTimers.add(timer);
    }
    return this;
  };

  (fakeStdin as Readable).removeListener = function patchedRemoveListener(
    this: Readable,
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) {
    realRemoveListener(event, listener);
    if (event === "keypress") {
      for (const timer of activeKeypressTimers) {
        clearInterval(timer);
      }
      activeKeypressTimers.clear();
    }
    return this;
  };

  Object.defineProperty(process, "stdin", {
    value: fakeStdin,
    writable: true,
    configurable: true,
  });
}
