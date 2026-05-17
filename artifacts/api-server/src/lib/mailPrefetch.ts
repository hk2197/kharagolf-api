// Shared heuristic for distinguishing a likely mail-client *prefetch*
// (Apple Mail Privacy Protection, GoogleImageProxy, YahooMailProxy …)
// from a likely *human* open of an email tracking pixel.
//
// History:
//   • Task #1298 introduced this logic to fix inflated open rates on the
//     export-expiring reminder pixel after Apple Mail Privacy Protection
//     (AMPP) started prefetching every <img> in inbound mail.
//   • Task #1532 narrowed the Apple IP check from the whole `17.0.0.0/8`
//     block to a curated set of AMPP relay CIDRs. The whole `/8` also
//     contains Apple's corporate network, so a real human opening the
//     email from an Apple corporate VPN was being mis-classified as a
//     prefetch.
//   • Task #1533 lifted the heuristic out of `routes/portal.ts` into
//     this shared module so any future open-pixel handler (levy-ledger
//     emails, payout-confirmation emails, side-game receipts, …) can
//     reuse the exact same classifier instead of re-implementing it and
//     re-introducing the Task #1298 bug.
//
// Heuristic (kept here so a future maintainer can audit it in one
// place):
//   • UA contains "GoogleImageProxy", "YahooMailProxy", "Mail/" or
//     "MailServices/" — well-known prefetcher signatures.
//   • Source IP falls inside one of Apple's published AMPP relay CIDRs
//     (see `APPLE_MAIL_PRIVACY_CIDRS`).
//   • The request explicitly asserts a privacy preference via
//     `DNT: 1` or `Sec-GPC: 1` — historically aimed at ad networks but
//     applies just as cleanly to engagement pixels.
// Any one signal is enough to demote the fetch to a prefetch.

import type { Request } from "express";

// Apple Mail Privacy Protection (AMPP) relay CIDRs. Apple does not
// publish a single canonical "AMPP IPs" list, but these are the ranges
// the security/anti-abuse community has reverse-engineered from live
// traffic and that are widely cited (e.g. abuse.ch, sendgrid, postmark).
// They sit inside Apple's `17.0.0.0/8` AS-714 block but, unlike that
// `/8`, exclude the corporate office network so a real human opening
// the email from an Apple VPN won't be mis-classified as a prefetch.
const APPLE_MAIL_PRIVACY_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["17.57.144.0", 22], // primary AMPP relay range
  ["17.58.85.0", 24],  // secondary AMPP relay block
];

// Tiny CIDR-match helper. IPv4-only on purpose: every published AMPP
// CIDR is IPv4, and IPv6-mapped IPv4 (`::ffff:17.x.x.x`) is unwrapped
// by the caller before we get here.
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const v = Number(part);
    if (v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

function ipv4InCidr(ip: string, baseIp: string, prefix: number): boolean {
  if (prefix < 0 || prefix > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(baseIp);
  if (ipInt === null || baseInt === null) return false;
  if (prefix === 0) return true;
  // Build the prefix mask without relying on `<<` of 32 (which is a no-op
  // in JS): for `/32` the mask is the full 32 bits set.
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export function looksLikeMailPrefetch(req: Request): boolean {
  // 1. Explicit "do not track me" privacy signals from the client.
  //    Honour them by treating the fetch as non-engagement.
  const dnt = String(req.headers["dnt"] ?? "").trim();
  const gpc = String(req.headers["sec-gpc"] ?? "").trim();
  if (dnt === "1" || gpc === "1") return true;

  // 2. Known mail-proxy User-Agent fingerprints. Match case-insensitively
  //    and tolerate the "Mail/" + "MailServices/" sub-strings AMPP uses
  //    when relaying through `mailserviceproxy.apple.com`.
  const ua = String(req.headers["user-agent"] ?? "");
  if (/GoogleImageProxy|YahooMailProxy|MailServices\/|\bMail\/[\d.]+/i.test(ua)) {
    return true;
  }

  // 3. Source IP inside one of Apple's curated AMPP relay CIDRs.
  //    `req.ip` is set because `app.set("trust proxy", true)` is in app.ts.
  //    Be tolerant of `::ffff:17.x.x.x` IPv4-in-IPv6 mapped addresses.
  const ip = String(req.ip ?? "").replace(/^::ffff:/, "");
  if (ip) {
    for (const [base, prefix] of APPLE_MAIL_PRIVACY_CIDRS) {
      if (ipv4InCidr(ip, base, prefix)) return true;
    }
  }

  return false;
}
