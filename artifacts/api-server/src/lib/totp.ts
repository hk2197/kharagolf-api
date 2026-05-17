/**
 * TOTP (RFC 6238) — Wave 3 W3-A.
 *
 * Pure-Node implementation, no third-party deps. SHA-1, 30-second window,
 * 6-digit codes. Verifier accepts ±1 step to tolerate clock skew.
 *
 * NOTE: Secrets must be base32-encoded before passing to otpauth_url() so
 * authenticator apps (Google / Authy / 1Password) can read them.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateBase32Secret(bytes = 20): string {
  const buf = randomBytes(bytes);
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").toUpperCase().replace(/\s+/g, "");
  let bits = "";
  for (const ch of clean) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new Error(`invalid base32 char ${ch}`);
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

export function totp(secretBase32: string, when: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(when / 1000 / STEP_SECONDS));
}

/** Verify a code with ±1 step tolerance for clock skew. */
export function verifyTotp(secretBase32: string, code: string, when: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(when / 1000 / STEP_SECONDS);
  const codeBuf = Buffer.from(code, "utf8");
  let ok = false;
  for (const c of [counter - 1, counter, counter + 1]) {
    const expected = Buffer.from(hotp(secret, c), "utf8");
    if (expected.length === codeBuf.length && timingSafeEqual(expected, codeBuf)) {
      ok = true;
    }
  }
  return ok;
}

/** Build an otpauth:// URL for QR provisioning. */
export function otpauthUrl(opts: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
