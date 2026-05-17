/**
 * Feed @-mentions parser — Wave 3 W3-G.
 *
 * Extracts @handles from post body. Handle = letters/digits/underscore/dot,
 * 2-32 chars, must follow whitespace or string start, not after a letter/dot.
 */

const MENTION_RE = /(^|[\s(])@([A-Za-z0-9_.]{2,32})(?=$|[\s)),.!?])/g;

export function extractMentionHandles(body: string): string[] {
  if (!body) return [];
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    out.add(m[2].toLowerCase().replace(/\.+$/, ""));
  }
  return Array.from(out);
}
