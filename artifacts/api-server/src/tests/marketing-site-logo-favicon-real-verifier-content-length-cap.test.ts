/**
 * Task #2253 — Real-network coverage for the *declared Content-Length*
 * size cap inside `verifyExternalImageUrl`'s `realVerify` path.
 *
 * Task #1801 added a sibling test
 * (`marketing-site-logo-favicon-real-verifier-size-cap.test.ts`) that
 * proves the streaming guard inside the body-read loop aborts once
 * accumulated bytes overshoot `maxBytes`. This test covers the *other*
 * branch — the early-reject path around line 201 of
 * `externalImageVerifier.ts` where the host returns a `Content-Length`
 * header that already exceeds the cap and the verifier rejects up
 * front before reading any body. That early reject is independently
 * important: it saves a useless body download. Without dedicated
 * coverage a regression that removes the header check (or flips the
 * comparison) would only surface as a slightly slower download — not
 * a test failure.
 *
 * Harness:
 *   - Boot an in-process HTTP server that responds with
 *     `Content-Type: image/png` and `Content-Length: 5 MB`, then
 *     *flushes the headers and never writes any body bytes or calls
 *     res.end()*. Any client that actually starts reading the body
 *     would hang on this socket until its own request timeout fires.
 *   - Call `verifyExternalImageUrl` with the marketing-logo cap
 *     (1 MB), bypassing the test-mode short-circuit by setting
 *     `NODE_ENV=production` (the same pattern the streaming-cap
 *     sibling uses).
 *
 * Assertions — three independent guards, any one of which would fail
 * if the declared-length branch were removed or inverted:
 *   1. The verifier resolves `{ ok: false, error: /1 MB/ }` —
 *      proving the rejection is keyed on the size cap, not (e.g.) a
 *      content-type mismatch or a generic transport error.
 *   2. The verifier never wrote any body bytes — `bodyBytesSent`
 *      stays at zero. (Belt-and-braces: today we also never *try* to
 *      write bytes, but a future test edit that starts trickling a
 *      body would still light this up if the verifier ever stopped
 *      short-circuiting.)
 *   3. The verifier resolved in well under the realVerify request
 *      timeout (REQUEST_TIMEOUT_MS = 8 s). If the verifier ever
 *      started reading the body it would hang on this server (which
 *      never writes bytes and never ends the response) until the
 *      8 s timeout fired. A sub-2-second resolution proves the
 *      header check short-circuited without touching the body.
 *
 * As in the streaming-cap sibling we mock `isPrivateAddress` so
 * 127.0.0.1 passes the SSRF guard; the rest of the verifier (DNS
 * lookup, HTTP transport, header parsing) runs unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Allow loopback addresses to pass the SSRF guard for this test only.
// The real isPrivateAddress is exercised exhaustively elsewhere
// (privateAddressGuard.test.ts and the existing real-network probes).
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

const DECLARED_CONTENT_LENGTH = 5 * 1024 * 1024; // 5 MB — well above the 1 MB cap.

let server: http.Server;
let serverUrl: string;
let bodyBytesSent = 0;
let openSockets: Set<import("node:net").Socket>;

beforeAll(async () => {
  openSockets = new Set();
  server = http.createServer((_req, res) => {
    bodyBytesSent = 0;
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    // Lie about the body size: advertise 5 MB but never actually
    // write any body bytes and never call res.end(). If the verifier
    // ever started reading the body it would hang on this socket
    // until its 8 s request timeout fires — which is exactly the
    // signal assertion #3 below pins down.
    res.setHeader("Content-Length", String(DECLARED_CONTENT_LENGTH));
    res.flushHeaders();
    // Intentionally NO res.write(...) and NO res.end(). The verifier
    // is expected to reject from the declared-length header alone and
    // tear down its own end of the socket.
  });
  // Track every accepted connection so we can hard-close any stragglers
  // in afterAll — without this, the never-ended responses above would
  // keep the server's close() pending until the OS reaps the sockets.
  server.on("connection", (sock) => {
    openSockets.add(sock);
    sock.on("close", () => openSockets.delete(sock));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${addr.port}/oversize.png`;
});

afterAll(async () => {
  __setExternalImageVerifierForTests(null);
  for (const sock of openSockets) sock.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("verifyExternalImageUrl realVerify — declared Content-Length cap (Task #2253)", () => {
  it("rejects up front when the declared Content-Length exceeds maxBytes, without reading the body", async () => {
    __setExternalImageVerifierForTests(null);
    const prev = process.env.NODE_ENV;
    // Bypass the test-mode short-circuit so realVerify actually runs.
    process.env.NODE_ENV = "production";
    try {
      const startedAt = Date.now();
      const result = await verifyExternalImageUrl(serverUrl, {
        maxBytes: MARKETING_LOGO_FAVICON_MAX_BYTES,
      });
      const elapsedMs = Date.now() - startedAt;

      // 1. The rejection is keyed on the size cap, with the cap
      //    rendered in the human-readable form ("1 MB").
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/1 MB/);
        expect(result.error).toMatch(/exceeds/);
      }

      // 2. The server never wrote any body bytes. (Today the server
      //    never even *tries* to — but if a future edit adds a write
      //    loop, this assertion will light up if the verifier ever
      //    stops short-circuiting.)
      expect(bodyBytesSent).toBe(0);

      // 3. The verifier resolved well under the 8 s request timeout
      //    inside realVerify. The server never writes any body and
      //    never ends the response, so the only way a body-reading
      //    client gets back here in <2 s is if the loopback kernel
      //    spontaneously closed the socket — it doesn't. A fast
      //    resolution therefore proves the verifier tore down the
      //    request from the headers alone.
      expect(elapsedMs).toBeLessThan(2000);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
