/**
 * Task #662 — SSRF guardrails for outbound HTTPS verification of admin-
 * supplied custom domains. Used by the marketing-site `/verify-domain`
 * endpoint to reject any hostname that resolves to a non-publicly-
 * routable address before issuing a fetch.
 *
 * Kept as a small standalone module so the address-classification logic
 * can be unit-tested without spinning up the full Express app.
 */

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;                          // "this network"
  if (a === 10) return true;                         // RFC1918
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;           // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                         // multicast / reserved
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;        // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("ff")) return true;           // multicast
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — apply v4 rules.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateAddress(addr: { address: string; family: number }): boolean {
  return addr.family === 6 ? isPrivateIPv6(addr.address) : isPrivateIPv4(addr.address);
}
