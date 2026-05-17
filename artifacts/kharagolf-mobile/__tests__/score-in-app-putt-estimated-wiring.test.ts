/**
 * Task #1373 — Pin the in-app putt-estimated marker wiring on the
 * score screen.
 *
 * Task #1191's sibling test pinned the share-card render of the
 * estimated SG-Putting marker. The same `app/(tabs)/score.tsx` file
 * also renders the marker in three other (non-share) places:
 *
 *   1. The in-round per-hole SG row
 *   2. The in-round round-totals SG row
 *   3. The post-round summary screen's SG row
 *
 * Each site reads `puttingEstimated` (from `sgForHole` or
 * `sgRound.totals`) and threads it into `<SGStat estimated={...} />`,
 * with a sibling footnote that is conditional on the same flag.
 * A refactor that drops the `estimated` prop, sources it from the
 * wrong object, or removes the footnote conditional would silently
 * regress the in-app cue. We pin the invariant via source-level
 * assertions, the same approach the sibling share-card wiring test
 * uses (mounting the 5k+ line screen end-to-end is impractical).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCORE_SRC = readFileSync(
  resolve(__dirname, "../app/(tabs)/score.tsx"),
  "utf8",
);

/**
 * Walk forward from a `<SGStat ...` opening tag and return the full
 * self-closing JSX (through the matching `/>`). Brace-aware so a `>`
 * inside a JSX expression like `value={a > b ? x : y}` doesn't end
 * the tag prematurely.
 */
function extractSelfClosingJsx(src: string, tagStart: number, tagName: string): string {
  let braceDepth = 0;
  for (let i = tagStart + tagName.length; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth -= 1;
    else if (ch === "/" && src[i + 1] === ">" && braceDepth === 0) {
      return src.slice(tagStart, i + 2);
    }
  }
  throw new Error(`could not find closing /> for ${tagName} starting at ${tagStart}`);
}

/**
 * Pull the right-hand side expression of a JSX prop like `name={...}`,
 * respecting nested braces. Returns null if the prop is absent.
 */
function extractPropExpression(jsx: string, propName: string): string | null {
  const propIdx = jsx.indexOf(`${propName}=`);
  if (propIdx === -1) return null;
  const braceStart = jsx.indexOf("{", propIdx);
  if (braceStart === -1) return null;
  let depth = 1;
  for (let i = braceStart + 1; i < jsx.length; i++) {
    if (jsx[i] === "{") depth += 1;
    else if (jsx[i] === "}") {
      depth -= 1;
      if (depth === 0) return jsx.slice(braceStart + 1, i).trim();
    }
  }
  throw new Error(`unterminated expression for prop ${propName}`);
}

/**
 * Find every `<SGStat label="Putt" .../>` self-closing JSX tag in
 * `score.tsx` and return its source position + full JSX text.
 */
function findPuttSGStatSites(): Array<{ index: number; jsx: string }> {
  const sites: Array<{ index: number; jsx: string }> = [];
  const needle = '<SGStat label="Putt"';
  let from = 0;
  while (true) {
    const idx = SCORE_SRC.indexOf(needle, from);
    if (idx === -1) break;
    const jsx = extractSelfClosingJsx(SCORE_SRC, idx, "<SGStat");
    sites.push({ index: idx, jsx });
    from = idx + jsx.length;
  }
  return sites;
}

describe("score.tsx in-app SG-Putting estimated marker wiring (Task #1373)", () => {
  const sites = findPuttSGStatSites();

  it("renders the Putt SGStat at all three non-share sites", () => {
    // Per the task brief: per-hole SG row, round-totals SG row, and
    // post-round summary SG row. The share-card uses
    // <RoundSummaryCard /> (covered by Task #1191), not <SGStat>, so
    // these three are the complete set of in-app marker sites.
    expect(
      sites.length,
      "expected exactly three <SGStat label=\"Putt\" .../> sites in score.tsx",
    ).toBe(3);
  });

  it.each([0, 1, 2] as const)(
    "site %i forwards the matching object's puttingEstimated into the estimated prop",
    (siteIdx) => {
      const site = sites[siteIdx];
      expect(site, `site #${siteIdx} should exist`).toBeDefined();

      const valueExpr = extractPropExpression(site.jsx, "value");
      const estimatedExpr = extractPropExpression(site.jsx, "estimated");

      expect(
        valueExpr,
        `site #${siteIdx} <SGStat label="Putt" .../> must declare a value= prop`,
      ).not.toBeNull();
      expect(
        estimatedExpr,
        `site #${siteIdx} <SGStat label="Putt" .../> must declare an estimated= prop so the cue can render`,
      ).not.toBeNull();

      // Both props must read off the same object (sgForHole or
      // sgRound.totals) — sourcing `estimated` from a different
      // object than `value` would let the marker drift out of sync
      // with the figure it qualifies.
      const valueMatch = valueExpr!.match(/^(.+)\.sgPutting$/);
      const estimatedMatch = estimatedExpr!.match(/^(.+)\.puttingEstimated$/);
      expect(
        valueMatch,
        `site #${siteIdx} value= must read \`<obj>.sgPutting\` (got: ${valueExpr})`,
      ).not.toBeNull();
      expect(
        estimatedMatch,
        `site #${siteIdx} estimated= must read \`<obj>.puttingEstimated\` (got: ${estimatedExpr})`,
      ).not.toBeNull();
      expect(
        estimatedMatch![1],
        `site #${siteIdx} estimated= must source from the same object as value= (value=${valueMatch![1]} vs estimated=${estimatedMatch![1]})`,
      ).toBe(valueMatch![1]);

      // And the source object must be one of the two SG-round shapes
      // that actually carry `puttingEstimated` per the
      // SGRoundResponse / SGHoleBreakdown types declared in score.tsx.
      const sourceObj = valueMatch![1];
      expect(
        ["sgForHole", "sgRound.totals", "sgRound?.totals"],
        `site #${siteIdx} must source the Putt stat from sgForHole or sgRound.totals (got: ${sourceObj})`,
      ).toContain(sourceObj);
    },
  );

  it.each([0, 1, 2] as const)(
    "site %i renders a footnote conditionally on the same puttingEstimated flag",
    (siteIdx) => {
      const site = sites[siteIdx];
      const estimatedExpr = extractPropExpression(site.jsx, "estimated")!;
      // Whatever object feeds estimated= must also gate a sibling
      // footnote, so the "~" cue and its explanation always travel
      // together. We scan a window after the SGStat for
      // `<estimatedExpr> && (` followed by a footnote text node.
      const tail = SCORE_SRC.slice(site.index, site.index + 1200);
      const conditional = `${estimatedExpr} && (`;
      expect(
        tail,
        `site #${siteIdx} must gate its footnote on \`${conditional}\` so the explanation matches the marker`,
      ).toContain(conditional);

      // The footnote itself must mention "estimated" + "scorecard"
      // (per the existing copy in all three sites) so a refactor
      // that strips the explanation also fails this test.
      const condIdx = tail.indexOf(conditional);
      const footnoteWindow = tail.slice(condIdx, condIdx + 500);
      expect(
        footnoteWindow,
        `site #${siteIdx} footnote must explain that Putt SG was estimated from the scorecard`,
      ).toMatch(/estimated[\s\S]*scorecard/i);
    },
  );
});
