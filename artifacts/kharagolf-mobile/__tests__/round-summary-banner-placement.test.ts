/**
 * Task #886 — Structural test for the post-round summary sponsor banner.
 *
 * The round summary screen mounts an `<InlineAdBanner slotKey="mobile_round_summary" />`
 * so we have sold inventory after every round. Critically, the banner
 * MUST live outside the `cardRef` view that `react-native-view-shot`
 * captures for the "Share Round Summary" image — otherwise sponsor
 * creatives would leak into shared screenshots.
 *
 * Mounting `score.tsx` end-to-end is impractical (5k+ lines, native
 * deps), so we pin the invariant via a source-level assertion: the
 * `mobile_round_summary` banner must appear in the file, and its
 * occurrence must NOT fall between `<View collapsable={false} ref={cardRef}`
 * and the matching closing `</View>` of that capture wrapper.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCORE_SRC = readFileSync(
  resolve(__dirname, "../app/(tabs)/score.tsx"),
  "utf8",
);

function findCardRefBlock(src: string): { start: number; end: number } {
  const openIdx = src.indexOf("ref={cardRef}");
  expect(openIdx, "expected ref={cardRef} View to exist in score.tsx").toBeGreaterThan(-1);
  // Walk forward, tracking <View ...> / </View> depth from the wrapper that
  // owns this ref. The wrapper is always rendered as `<View ... ref={cardRef}>`,
  // so depth starts at 1 immediately after the opening tag's `>`.
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

describe("post-round summary sponsor banner placement (Task #886)", () => {
  it("mounts an InlineAdBanner with slotKey='mobile_round_summary' on the round summary screen", () => {
    // The banner must use the new slot key — that's what the api-server
    // seeds and what per-slot metrics roll up under.
    expect(SCORE_SRC).toMatch(/<InlineAdBanner[\s\S]*?slotKey=["']mobile_round_summary["']/);
  });

  it("renders the banner inside the RoundSummaryScreen component, not on some unrelated screen", () => {
    const summaryStart = SCORE_SRC.indexOf("function RoundSummaryScreen(");
    expect(summaryStart, "RoundSummaryScreen should be defined in score.tsx").toBeGreaterThan(-1);
    const bannerIdx = SCORE_SRC.indexOf('slotKey="mobile_round_summary"');
    expect(bannerIdx, "mobile_round_summary slot must be referenced in score.tsx").toBeGreaterThan(-1);
    expect(bannerIdx).toBeGreaterThan(summaryStart);
  });

  it("keeps the sponsor banner OUTSIDE the cardRef capture view so it isn't included in shared screenshots", () => {
    const { start, end } = findCardRefBlock(SCORE_SRC);
    const inside = SCORE_SRC.slice(start, end);
    expect(
      inside.includes("mobile_round_summary"),
      "mobile_round_summary banner must NOT be nested inside the cardRef View " +
        "(react-native-view-shot would capture it into the shared image)",
    ).toBe(false);
    // Sanity check: there is at least one occurrence in the file outside that block.
    const outsideOccurrences =
      SCORE_SRC.slice(0, start).split("mobile_round_summary").length - 1 +
      SCORE_SRC.slice(end).split("mobile_round_summary").length - 1;
    expect(outsideOccurrences).toBeGreaterThan(0);
  });
});
