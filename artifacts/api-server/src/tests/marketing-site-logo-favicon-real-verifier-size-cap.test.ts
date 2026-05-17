/**
 * Task #1801 — Real-network coverage for the streaming size cap inside
 * `verifyExternalImageUrl`'s `realVerify` path.
 *
 * The marketing-site admin route already exercises the `maxBytes`
 * plumbing through a stubbed verifier
 * (`marketing-site-logo-favicon-cache.test.ts`), but the production
 * code path that actually streams response bytes and aborts on
 * overshoot only had indirect coverage. This test boots a tiny
 * in-process HTTP server that advertises an `image/png` content-type
 * (with no `Content-Length` so the verifier can't reject up front)
 * and trickles >1 MB of bytes. We then call the verifier directly
 * with the marketing-logo cap (1 MB) and assert that:
 *   - the verifier resolves with `{ ok: false, error: /1 MB/ }`, and
 *   - the underlying request socket was destroyed by the verifier
 *     (the server observes `close` on the request before it has
 *     finished writing the full payload).
 *
 * We bypass the SSRF guard for this single file by mocking
 * `isPrivateAddress` so 127.0.0.1 is treated as routable; the rest of
 * the verifier (including its real DNS lookup and HTTP transport) runs
 * unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Allow loopback addresses to pass the SSRF guard for this test only.
// The real isPrivateAddress is exercised exhaustively elsewhere
// (privateAddressGuard.test.ts and the existing real-network probe).
vi.mock("../lib/privateAddressGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/privateAddressGuard.js")>();
  return {
    ...actual,
    isPrivateAddress: () => false,
  };
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  verifyExternalImageUrl,
  __setExternalImageVerifierForTests,
  MARKETING_LOGO_FAVICON_MAX_BYTES,
} from "../lib/externalImageVerifier.js";

let server: http.Server;
let serverUrl: string;
let lastResponseClosedBeforeEnd = false;

beforeAll(async () => {
  // Stream up to 64 MB of zeros in 64 KB chunks, far past the 1 MB
  // cap and big enough that the loopback kernel buffer can't swallow
  // the whole payload before the verifier gets a chance to abort. We
  // deliberately omit Content-Length so the verifier cannot reject up
  // front from the declared header — the streaming guard inside the
  // body loop is what we want to exercise.
  const CHUNK = Buffer.alloc(64 * 1024, 0);
  const TARGET_BYTES = 64 * 1024 * 1024;
  server = http.createServer((_req, res) => {
    lastResponseClosedBeforeEnd = false;
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Transfer-Encoding", "chunked");
    // The verifier's call to `response.destroy()` propagates back as
    // a write error (EPIPE / ECONNRESET) on the server's response
    // stream, *or* a `close` event before `writableEnded` flips. We
    // accept either signal — both prove the request socket was torn
    // down while we still had bytes to send, i.e. no hanging socket.
    res.on("error", () => { lastResponseClosedBeforeEnd = true; });
    res.on("close", () => {
      if (!res.writableEnded) lastResponseClosedBeforeEnd = true;
    });
    let written = 0;
    const writeNext = () => {
      if (res.destroyed || res.writableEnded) return;
      if (written >= TARGET_BYTES) {
        res.end();
        return;
      }
      written += CHUNK.length;
      const ok = res.write(CHUNK, (err) => {
        if (err) lastResponseClosedBeforeEnd = true;
      });
      if (ok) setImmediate(writeNext);
      else res.once("drain", writeNext);
    };
    writeNext();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${addr.port}/giant.png`;
});

afterAll(async () => {
  __setExternalImageVerifierForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("verifyExternalImageUrl realVerify — streaming size cap (Task #1801)", () => {
  it("rejects an oversize body once the streaming cap is hit and tears down the socket", async () => {
    __setExternalImageVerifierForTests(null);
    const prev = process.env.NODE_ENV;
    // Bypass the test-mode short-circuit so realVerify actually runs.
    process.env.NODE_ENV = "production";
    try {
      const result = await verifyExternalImageUrl(serverUrl, {
        maxBytes: MARKETING_LOGO_FAVICON_MAX_BYTES,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/1 MB/);
        expect(result.error).toMatch(/exceeds/);
      }
      // The verifier must have torn down the connection before our
      // server finished writing the full payload — otherwise it
      // isn't honouring the streaming guard. The TCP close event
      // propagates back to the server asynchronously, so poll for
      // up to a couple of seconds rather than asserting on a single
      // event-loop tick. (Empirically the close fires within tens of
      // milliseconds on loopback; the cap is purely a safety net so
      // we never hang the test suite.)
      const deadline = Date.now() + 2000;
      while (!lastResponseClosedBeforeEnd && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(lastResponseClosedBeforeEnd).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
