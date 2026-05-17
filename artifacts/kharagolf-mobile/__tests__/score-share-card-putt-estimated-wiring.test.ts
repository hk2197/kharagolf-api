/**
 * Task #1191 — Pin the share-card wiring so the estimated putt marker
 * can't be silently dropped.
 *
 * Task #1030 covered `<RoundSummaryCard />` itself: when its `sgTotals`
 * prop has `puttingEstimated: true`, the card renders the "~" label,
 * "~+x.xx" value, and footnote. What that test does NOT cover is the
 * wiring on `app/(tabs)/score.tsx`'s share-card render: the share modal
 * mounts `<RoundSummaryCard />` inside the `cardRef` view that
 * `react-native-view-shot` captures, and it must forward the SG-round
 * totals (which carry the `puttingEstimated` flag from the SG-round
 * query) into the card. A refactor that drops or renames `sgTotals=`,
 * stops sourcing it from the SG-round query result, or removes
 * `puttingEstimated` from either the producer or consumer type would
 * silently regress the shared image.
 *
 * Mounting `score.tsx` end-to-end is impractical (6k+ lines, native
 * deps), so we pin the invariant via a source-level assertion, the
 * same approach used by the sibling banner-placement test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCORE_SRC = readFileSync(
  resolve(__dirname, "../app/(tabs)/score.tsx"),
  "utf8",
);
const CARD_SRC = readFileSync(
  resolve(__dirname, "../components/RoundSummaryCard.tsx"),
  "utf8",
);

/**
 * Walk the `<View ... ref={cardRef}>` capture wrapper and return the
 * source slice nested inside it. Mirrors the helper in
 * round-summary-banner-placement.test.ts.
 */
function findCardRefBlock(src: string): { start: number; end: number } {
  const openIdx = src.indexOf("ref={cardRef}");
  expect(openIdx, "expected ref={cardRef} View to exist in score.tsx").toBeGreaterThan(-1);
  const tagOpenEnd = src.indexOf(">", openIdx);
  expect(tagOpenEnd).toBeGreaterThan(openIdx);
  let depth = 1;
  let i = tagOpenEnd + 1;
  while (i < src.length && depth > 0) {
    const nextOpen = src.indexOf("<View", i);
    const nextClose = src.indexOf("</View>", i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + "<View".length;
    } else {
      depth -= 1;
      i = nextClose + "</View>".length;
    }
  }
  expect(depth, "ref={cardRef} View should have a matching </View>").toBe(0);
  return { start: openIdx, end: i };
}

/**
 * Extract the full `<RoundSummaryCard ... />` JSX (props block) from a
 * source slice. Returns the substring from `<RoundSummaryCard` through
 * the matching self-closing `/>` so callers can parse individual props.
 */
function extractRoundSummaryCardJsx(slice: string): string {
  const tagIdx = slice.indexOf("<RoundSummaryCard");
  expect(
    tagIdx,
    "<RoundSummaryCard ...> must be rendered inside the share-card capture wrapper",
  ).toBeGreaterThan(-1);
  // Walk forward, balancing `{` and `}` so we don't terminate on a `>`
  // that lives inside a JSX expression like `sgTotals={sgRound?.totals ?? null}`.
  let braceDepth = 0;
  for (let i = tagIdx; i < slice.length; i++) {
    const ch = slice[i];
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth -= 1;
    else if (ch === "/" && slice[i + 1] === ">" && braceDepth === 0) {
      return slice.slice(tagIdx, i + 2);
    }
  }
  throw new Error(
    "could not find closing /> for <RoundSummaryCard> inside the share-card capture wrapper",
  );
}

/**
 * Pull the right-hand side expression of a JSX prop like `name={...}`,
 * respecting nested braces.
 */
function extractPropExpression(jsx: string, propName: string): string {
  const propIdx = jsx.indexOf(`${propName}=`);
  expect(
    propIdx,
    `<RoundSummaryCard /> must declare the ${propName} prop in its share-card render`,
  ).toBeGreaterThan(-1);
  const braceStart = jsx.indexOf("{", propIdx);
  expect(braceStart).toBeGreaterThan(propIdx);
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

describe("score.tsx share-card wiring forwards puttingEstimated (Task #1191)", () => {
  it("renders <RoundSummaryCard /> inside the cardRef capture wrapper", () => {
    const { start, end } = findCardRefBlock(SCORE_SRC);
    const inside = SCORE_SRC.slice(start, end);
    expect(
      inside.includes("<RoundSummaryCard"),
      "<RoundSummaryCard ...> must live inside the cardRef View so it ends up in the captured PNG",
    ).toBe(true);
  });

  it("forwards the SG-round query's totals (which carry puttingEstimated) into sgTotals=", () => {
    const { start, end } = findCardRefBlock(SCORE_SRC);
    const inside = SCORE_SRC.slice(start, end);
    const cardJsx = extractRoundSummaryCardJsx(inside);

    // The sgTotals prop must exist and must be sourced from the SG-round
    // query result. `sgRound.totals` is the only object in score.tsx
    // whose type carries `puttingEstimated`; routing sgTotals through
    // anything else (or dropping the prop entirely) would drop the flag.
    const sgTotalsExpr = extractPropExpression(cardJsx, "sgTotals");
    expect(
      sgTotalsExpr,
      "sgTotals must be sourced from the SG-round query result (sgRound.totals)",
    ).toMatch(/sgRound[?.]?\.totals/);
  });

  it("keeps puttingEstimated on the SG-round totals shape produced in score.tsx", () => {
    // The producer side of the wiring: SGRoundResponse.totals must keep
    // the puttingEstimated field so it can flow into sgTotals=.
    const responseTypeMatch = SCORE_SRC.match(
      /interface\s+SGRoundResponse\s*\{[\s\S]*?\n\}/,
    );
    expect(responseTypeMatch, "SGRoundResponse interface must exist in score.tsx").not.toBeNull();
    const responseType = responseTypeMatch![0];
    expect(responseType).toMatch(/totals\s*:\s*\{[^}]*puttingEstimated\?:\s*boolean[^}]*\}/);
  });

  it("keeps puttingEstimated on RoundSummaryCardProps['sgTotals'] (consumer side)", () => {
    // The consumer side: <RoundSummaryCard /> must still accept the
    // puttingEstimated flag, otherwise the producer's value would be
    // silently discarded by TypeScript-stripped JSX at runtime.
    const propsMatch = CARD_SRC.match(
      /export\s+interface\s+RoundSummaryCardProps\s*\{[\s\S]*?\n\}/,
    );
    expect(propsMatch, "RoundSummaryCardProps interface must exist").not.toBeNull();
    const propsSrc = propsMatch![0];
    const sgTotalsBlock = propsSrc.match(/sgTotals\?:\s*\{[\s\S]*?\}\s*\|\s*null/);
    expect(
      sgTotalsBlock,
      "RoundSummaryCardProps.sgTotals must remain an object (or null) shape",
    ).not.toBeNull();
    expect(sgTotalsBlock![0]).toMatch(/puttingEstimated\?:\s*boolean/);
  });
});
