// Verified-holder-name comparison helpers (Task #1120 / #1521).
//
// When the bank returns the account-holder name during payout-account
// verification, we compare it against what the member typed and surface an
// amber warning if the two disagree materially. The matching has to be
// tolerant of case, punctuation, common honorifics, middle names, initials,
// and word reordering — but strict enough that "Jon Smyth" doesn't silently
// pass for "John Smith".
//
// These helpers used to live in two duplicate copies inside
// `artifacts/kharagolf-web/src/components/SideGamesAdmin.tsx` (WalletPanel)
// and `artifacts/kharagolf-mobile/app/wallet.tsx` (WalletScreen). They are
// now hoisted into this shared package so a future tweak to the matching
// rules (a new honorific, a different Jaccard threshold, etc.) only has to
// be made — and re-verified — in one place. The module has zero React /
// React Native / DOM imports so it can be consumed safely from either
// runtime.

const HONORIFICS = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "mister",
  "dr",
  "shri",
  "sri",
  "smt",
  "m/s",
  "shree",
]);

/**
 * Tokenise a holder-name string into a comparable lowercase word list:
 *   - lowercase
 *   - replace non-alphanumeric runs with spaces (drops "." "," "/" etc.)
 *   - split on whitespace
 *   - drop tokens of length <= 1 (initials) and known honorifics
 *
 * Returns `[]` for null / undefined / empty input so the caller can treat
 * "no info" as "nothing to compare".
 */
export function holderNameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !HONORIFICS.has(t));
}

/**
 * Decide whether the typed and bank-verified holder names disagree enough
 * to warrant the amber "doesn't match what you entered" warning.
 *
 * Returns `false` (i.e. "looks like the same person, no warning") when:
 *   - either side has no usable tokens (we can't compare, so don't nag), OR
 *   - one side's token set is fully contained in the other (handles
 *     middle names, initials, reorderings, and one-side-shorter cases), OR
 *   - the Jaccard overlap of the two token sets is >= 0.5.
 *
 * Returns `true` when the names disagree materially (e.g. "Jon Smyth" vs
 * "John Smith"), so the UI should render the amber warning.
 */
export function holderNamesDifferSignificantly(
  typed: string | null | undefined,
  verified: string | null | undefined,
): boolean {
  const a = holderNameTokens(typed);
  const b = holderNameTokens(verified);
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  // Match if either side's tokens are entirely contained in the other (handles
  // middle names, initials, reorderings, and one-side-shorter cases).
  const aSubsetOfB = a.every((t) => setB.has(t));
  const bSubsetOfA = b.every((t) => setA.has(t));
  if (aSubsetOfB || bSubsetOfA) return false;
  // Otherwise require >=50% Jaccard overlap to consider them the "same person".
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  return jaccard < 0.5;
}
