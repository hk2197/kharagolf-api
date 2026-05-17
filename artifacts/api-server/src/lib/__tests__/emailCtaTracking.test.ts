/**
 * Task #1622 — Pure unit tests for the email CTA tracking helpers.
 *
 * Focuses on the parts that don't touch the DB:
 *   • signCtaToken / verifyCtaToken round-trip
 *   • verifyCtaToken rejects tampered, mis-signed, malformed, and
 *     non-http(s) tokens (so the redirect route can never be turned
 *     into a generic open redirect)
 *   • wrapCtaUrl preserves the destination's origin and yields a token
 *     that decodes back to the original URL
 *   • wrapCtaUrl returns the bare URL untouched for non-absolute /
 *     non-http(s) inputs (so we never lose the CTA itself just because
 *     a caller passed a malformed URL)
 *
 * Recording functions (`recordCtaClick`, `recordCtaSend`) and the
 * report aggregation are covered by the integration test that hits
 * the real `/r/email/:token` route + Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { signCtaToken, verifyCtaToken, wrapCtaUrl, generateClickId } from "../emailCtaTracking.js";

const ORIGINAL_SECRET = process.env["EMAIL_CTA_TRACKING_SECRET"];

beforeAll(() => {
  // Ensure a deterministic secret for the unit tests regardless of
  // whether the test container has SESSION_SECRET set.
  process.env["EMAIL_CTA_TRACKING_SECRET"] = "unit-test-cta-secret-do-not-use-in-prod";
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env["EMAIL_CTA_TRACKING_SECRET"];
  } else {
    process.env["EMAIL_CTA_TRACKING_SECRET"] = ORIGINAL_SECRET;
  }
});

describe("emailCtaTracking — token signing", () => {
  it("round-trips a valid payload", () => {
    const t = signCtaToken({ k: "booking.confirmed", u: 42, url: "https://app.kharagolf.com/portal/bookings/7" });
    const v = verifyCtaToken(t);
    expect(v).not.toBeNull();
    expect(v?.k).toBe("booking.confirmed");
    expect(v?.u).toBe(42);
    expect(v?.url).toBe("https://app.kharagolf.com/portal/bookings/7");
  });

  it("preserves a null userId (anonymous send)", () => {
    const t = signCtaToken({ k: "highlight.ready", u: null, url: "https://app.kharagolf.com/h/123" });
    const v = verifyCtaToken(t);
    expect(v?.u).toBeNull();
  });

  it("round-trips an organization id (Task #2019)", () => {
    const t = signCtaToken({ k: "booking.confirmed", u: 42, o: 7, url: "https://app.kharagolf.com/portal/bookings/7" });
    const v = verifyCtaToken(t);
    expect(v?.o).toBe(7);
  });

  it("normalises a missing org id to null (pre-Task-#2019 token compatibility)", () => {
    // Tokens minted before Task #2019 carry no `o` field at all. The
    // verifier MUST still accept them and surface `o: null` so the
    // redirect route logs the click as "unaffiliated" rather than
    // 400-ing the recipient on an old email link.
    const t = signCtaToken({ k: "booking.confirmed", u: 1, url: "https://app.kharagolf.com/" });
    const v = verifyCtaToken(t);
    expect(v?.o).toBeNull();
  });

  it("normalises an explicit null org id (unaffiliated recipient)", () => {
    const t = signCtaToken({ k: "highlight.ready", u: null, o: null, url: "https://app.kharagolf.com/h/9" });
    const v = verifyCtaToken(t);
    expect(v?.o).toBeNull();
  });

  it("rejects tampered tokens (signature mismatch)", () => {
    const t = signCtaToken({ k: "booking.confirmed", u: 1, url: "https://app.kharagolf.com/" });
    // Flip a single byte of the body half — the signature is now invalid.
    const dot = t.lastIndexOf(".");
    const tampered = `${t.slice(0, dot - 1)}A${t.slice(dot)}`;
    expect(verifyCtaToken(tampered)).toBeNull();
  });

  it("rejects tokens signed with a different secret", () => {
    const t = signCtaToken({ k: "booking.confirmed", u: 1, url: "https://app.kharagolf.com/" });
    process.env["EMAIL_CTA_TRACKING_SECRET"] = "completely-different-secret-now";
    expect(verifyCtaToken(t)).toBeNull();
    // Restore so the rest of the suite can keep round-tripping.
    process.env["EMAIL_CTA_TRACKING_SECRET"] = "unit-test-cta-secret-do-not-use-in-prod";
  });

  it("rejects malformed tokens", () => {
    expect(verifyCtaToken("")).toBeNull();
    expect(verifyCtaToken(null)).toBeNull();
    expect(verifyCtaToken(undefined)).toBeNull();
    expect(verifyCtaToken(42 as unknown)).toBeNull();
    expect(verifyCtaToken("nodot")).toBeNull();
    expect(verifyCtaToken(".sigonly")).toBeNull();
    expect(verifyCtaToken("bodyonly.")).toBeNull();
  });

  it("rejects payloads carrying non-http(s) URLs (open-redirect guard)", () => {
    // Synthesise a properly-signed token whose payload smuggles a
    // `javascript:` URL. `verifyCtaToken` must still refuse it so
    // an attacker who somehow obtains the secret can't turn the
    // redirect into a script execution.
    const malicious = signCtaToken({ k: "booking.confirmed", u: 1, url: "javascript:alert(1)" });
    expect(verifyCtaToken(malicious)).toBeNull();

    const fileUrl = signCtaToken({ k: "booking.confirmed", u: 1, url: "file:///etc/passwd" });
    expect(verifyCtaToken(fileUrl)).toBeNull();
  });
});

describe("emailCtaTracking — wrapCtaUrl", () => {
  it("wraps an absolute https URL with a same-origin tracking redirect", () => {
    const wrapped = wrapCtaUrl("booking.confirmed", 99, 4, "https://app.kharagolf.com/portal/bookings/7?ref=email");
    expect(wrapped.startsWith("https://app.kharagolf.com/api/r/email/")).toBe(true);
    // The token half (everything after `/r/email/`) must verify back to
    // the original URL — so the redirect route knows exactly where to
    // send the recipient.
    const token = wrapped.split("/r/email/")[1]!;
    const v = verifyCtaToken(token);
    expect(v?.k).toBe("booking.confirmed");
    expect(v?.u).toBe(99);
    // Task #2019 — org id round-trips through the wrap → verify cycle.
    expect(v?.o).toBe(4);
    expect(v?.url).toBe("https://app.kharagolf.com/portal/bookings/7?ref=email");
  });

  it("encodes a null org id as 'unaffiliated' (Task #2019)", () => {
    const wrapped = wrapCtaUrl("highlight.ready", 99, null, "https://app.kharagolf.com/h/1");
    const token = wrapped.split("/r/email/")[1]!;
    const v = verifyCtaToken(token);
    expect(v?.o).toBeNull();
  });

  it("preserves the destination origin (no cross-domain redirect)", () => {
    const wrapped = wrapCtaUrl("highlight.ready", null, null, "http://staging.kharagolf.com:3001/h/42");
    expect(wrapped.startsWith("http://staging.kharagolf.com:3001/api/r/email/")).toBe(true);
  });

  it("returns the input untouched for non-absolute URLs", () => {
    expect(wrapCtaUrl("booking.confirmed", 1, null, "/portal/bookings/7")).toBe("/portal/bookings/7");
    expect(wrapCtaUrl("booking.confirmed", 1, null, "")).toBe("");
  });

  it("returns the input untouched for non-http(s) protocols", () => {
    expect(wrapCtaUrl("booking.confirmed", 1, null, "mailto:ops@kharagolf.com")).toBe("mailto:ops@kharagolf.com");
    expect(wrapCtaUrl("booking.confirmed", 1, null, "tel:+1234")).toBe("tel:+1234");
  });
});

describe("emailCtaTracking — generateClickId (Task #2020)", () => {
  it("returns a non-empty URL-safe string", () => {
    const id = generateClickId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(10);
    // base64url alphabet only — no `+`, `/`, or `=` padding so the id
    // can be dropped straight into a cookie value or `?ec=` query
    // string without any further escaping.
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces unique ids across many invocations", () => {
    // 1k draws of 16 random bytes — collision probability is
    // astronomical (~2^-128), so any duplicate here is a regression.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateClickId());
    expect(seen.size).toBe(1000);
  });
});
