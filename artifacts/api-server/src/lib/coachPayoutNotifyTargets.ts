/**
 * Task #1544 — masked-target snapshot helpers for coach payout-paid
 * push / SMS attempts.
 *
 * Coaches see a per-payout notification cell in their earnings view
 * that says whether we reached them on push and SMS. When a channel
 * fails the cell now also shows *which* phone / device we tried — a
 * coach who has rotated SIMs or switched phones can immediately tell
 * whether the failure is because we have a stale number on file.
 *
 * To avoid leaking PII we never store the raw phone number on the
 * attempts row; we store a masked form (last 4 digits + country code)
 * computed by {@link maskPhoneForCoach}. For push we don't have a
 * device-name on `device_tokens` (it only carries platform + token),
 * so {@link buildPushDeviceLabel} summarises by platform + count
 * (e.g. "1 expo device" or "2 expo, 1 ios").
 *
 * Both helpers tolerate empty input — the original send / retry path
 * passes whatever is on the recipient at attempt time and `null` is
 * a perfectly valid result (rendered as "—" in the UI).
 */

/**
 * Mask a phone number for display in the coach earnings UI. The
 * country code prefix and the last 4 digits are preserved; the
 * middle is replaced with the • bullet character so the masked form
 * is visually distinguishable from a raw number.
 *
 * Examples:
 *   "+919876543210"  -> "+91 ●●●●●● 3210"
 *   "+14155552671"   -> "+1 ●●●●● 2671"
 *   "9876543210"     -> "●●●●●● 3210"
 *   "1234"           -> "1234"      (too short to mask meaningfully)
 *   ""               -> null
 */
export function maskPhoneForCoach(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // Phone columns sometimes carry interior whitespace ("+91 98765 43210"),
  // so collapse before parsing to keep the country-code/last-4 windows aligned.
  const trimmed = phone.replace(/\s+/g, "");
  if (!trimmed) return null;
  // Phone numbers shorter than 5 digits are treated as too short to mask:
  // returning the raw value gives the coach more info than nothing without
  // exposing a meaningful subscriber number.
  if (trimmed.length <= 4) return trimmed;
  const last4 = trimmed.slice(-4);
  // Country-code detection. We don't ship a full phone parser server-side,
  // so use the standard 10-digit-subscriber heuristic that fits both of the
  // user bases this product actually serves (India `+91` + 10 digits, US
  // `+1` + 10 digits): if the number starts with `+` and has more than 10
  // digits after, the leading 1-3 digits form the country code and the
  // tail-10 are the subscriber. Falls back to a greedy 1-3 digit prefix
  // for non-conforming inputs (very short numbers, long opaque test
  // strings) so we never throw — masking is best-effort, not validation.
  let cc = "";
  if (trimmed.startsWith("+")) {
    const totalDigits = trimmed.length - 1;
    if (totalDigits > 10) {
      const ccLen = Math.min(3, totalDigits - 10);
      cc = trimmed.slice(0, ccLen + 1);
    } else {
      const m = trimmed.match(/^(\+\d{1,3})/);
      cc = m ? m[1] : "";
    }
  }
  const middleLen = trimmed.length - cc.length - 4;
  // Cap the bullet run so a long international number doesn't render as
  // a wall of dots — 6 bullets is enough to convey "we masked the middle"
  // while keeping the cell narrow.
  const dots = "●".repeat(Math.max(2, Math.min(6, middleLen)));
  return cc ? `${cc} ${dots} ${last4}` : `${dots} ${last4}`;
}

/**
 * Summarise a coach's registered push devices into a short label for
 * the coach earnings UI. We don't have a friendly device name (the
 * `device_tokens` row only carries `platform` + `token`), so the
 * label groups by platform and prefixes with the count.
 *
 * Examples:
 *   []                                          -> null
 *   [{platform:"expo"}]                         -> "1 expo device"
 *   [{platform:"expo"},{platform:"expo"}]       -> "2 expo devices"
 *   [{platform:"expo"},{platform:"ios"}]        -> "1 expo, 1 ios"
 */
export function buildPushDeviceLabel(
  devices: ReadonlyArray<{ platform: string | null }>,
): string | null {
  if (!devices.length) return null;
  const counts = new Map<string, number>();
  for (const d of devices) {
    const p = (d.platform ?? "expo").toLowerCase() || "expo";
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  if (entries.length === 1) {
    const [platform, n] = entries[0];
    return `${n} ${platform} device${n === 1 ? "" : "s"}`;
  }
  return entries.map(([p, n]) => `${n} ${p}`).join(", ");
}
