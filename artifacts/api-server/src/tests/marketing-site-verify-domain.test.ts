/**
 * Task #662 — SSRF guard for the custom-domain verification endpoint.
 *
 * The /verify-domain route resolves the admin-supplied hostname and
 * refuses to issue an outbound HTTPS request when any resolved address
 * is non-publicly-routable. These tests cover the address classifier
 * directly so we don't need to spin up the full Express stack or rely
 * on integration DB fixtures.
 */
import { describe, it, expect } from "vitest";
import {
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateAddress,
} from "../lib/privateAddressGuard.js";

describe("privateAddressGuard — IPv4 classification", () => {
  it.each([
    "127.0.0.1",         // loopback
    "10.0.0.1",          // RFC1918
    "10.255.255.255",    // RFC1918 edge
    "172.16.0.1",        // RFC1918
    "172.31.255.255",    // RFC1918 edge
    "192.168.1.1",       // RFC1918
    "169.254.169.254",   // link-local (cloud metadata!)
    "100.64.0.1",        // CGNAT
    "100.127.255.255",   // CGNAT edge
    "0.0.0.0",           // "this network"
    "224.0.0.1",         // multicast
    "240.0.0.1",         // reserved
    "999.999.999.999",   // malformed → reject
  ])("rejects %s", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",        // just below RFC1918
    "172.32.0.1",        // just above RFC1918
    "100.63.255.255",    // just below CGNAT
    "100.128.0.0",       // just above CGNAT
    "192.169.0.1",       // just outside RFC1918
    "203.0.113.42",      // TEST-NET-3 — public per IANA, allowed by guard
  ])("accepts %s as routable", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(false);
  });
});

describe("privateAddressGuard — IPv6 classification", () => {
  it.each([
    "::",
    "::1",                                      // loopback
    "fe80::1",                                  // link-local
    "fc00::1",                                  // ULA
    "fd12:3456:789a::1",                        // ULA
    "ff02::1",                                  // multicast
    "::ffff:127.0.0.1",                         // v4-mapped loopback
    "::ffff:10.0.0.1",                          // v4-mapped RFC1918
    "::ffff:169.254.169.254",                   // v4-mapped metadata
  ])("rejects %s", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });

  it.each([
    "2001:4860:4860::8888",                     // Google public DNS
    "2606:4700:4700::1111",                     // Cloudflare public DNS
    "::ffff:8.8.8.8",                           // v4-mapped public
  ])("accepts %s as routable", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(false);
  });
});

describe("privateAddressGuard — isPrivateAddress dispatcher", () => {
  it("dispatches to v4 / v6 based on family", () => {
    expect(isPrivateAddress({ address: "127.0.0.1", family: 4 })).toBe(true);
    expect(isPrivateAddress({ address: "8.8.8.8", family: 4 })).toBe(false);
    expect(isPrivateAddress({ address: "::1", family: 6 })).toBe(true);
    expect(isPrivateAddress({ address: "2001:4860:4860::8888", family: 6 })).toBe(false);
  });

  it("blocks the AWS/GCP instance-metadata IP and loopback", () => {
    // Common SSRF targets — make absolutely sure these are blocked.
    expect(isPrivateAddress({ address: "169.254.169.254", family: 4 })).toBe(true);
    expect(isPrivateAddress({ address: "127.0.0.1", family: 4 })).toBe(true);
    expect(isPrivateAddress({ address: "0.0.0.0", family: 4 })).toBe(true);
  });
});
