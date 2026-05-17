/**
 * Unit test for the mid-round InlineAdBanner wrapper (Task #736):
 *   - When the underlying AdSlot signals an empty delivery (frequency-cap
 *     exhausted, no eligible campaign, etc.) the banner must collapse to
 *     zero height so the surrounding scorecard / leaderboard layout
 *     doesn't reserve a blank strip.
 *   - When AdSlot signals a loaded delivery, the banner expands to the
 *     caller-supplied height.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";

vi.mock("../components/AdSlot", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: function MockAdSlot(props: { onLoaded?: (d: unknown) => void; onEmpty?: () => void }) {
      (MockAdSlot as unknown as { __last: typeof props }).__last = props;
      return React.createElement("div", { "data-testid": "mock-ad-slot" });
    },
  };
});

import InlineAdBanner from "../components/InlineAdBanner";
import MockAdSlot from "../components/AdSlot";

function flexBasisHeight(el: HTMLElement | null): string | undefined {
  if (!el) return undefined;
  // react-native-web inlines numeric heights via the style attribute.
  return el.style.height || el.getAttribute("style")?.match(/height:\s*([^;]+)/)?.[1]?.trim();
}

describe("<InlineAdBanner />", () => {
  it("collapses to zero height while the delivery is empty", () => {
    const { container } = render(
      <InlineAdBanner orgId={1} slotKey="mobile_leaderboard_footer" height={64} />,
    );
    const wrap = container.firstChild as HTMLElement;
    expect(wrap).toBeTruthy();
    // Height should be 0px before any creative loads, regardless of the
    // caller-supplied `height` prop.
    expect(flexBasisHeight(wrap)).toMatch(/^0(px)?$/);
  });

  it("expands to the configured height after AdSlot reports a loaded creative, and re-collapses on empty", () => {
    const { container } = render(
      <InlineAdBanner orgId={1} slotKey="mobile_scorecard_banner" height={48} />,
    );
    const wrap = container.firstChild as HTMLElement;

    const props = (MockAdSlot as unknown as { __last: { onLoaded?: (d: unknown) => void; onEmpty?: () => void } }).__last;
    expect(props.onLoaded).toBeTypeOf("function");
    expect(props.onEmpty).toBeTypeOf("function");

    act(() => { props.onLoaded?.({ creative: { id: 1 } }); });
    expect(flexBasisHeight(wrap)).toMatch(/^48(px)?$/);

    act(() => { props.onEmpty?.(); });
    expect(flexBasisHeight(wrap)).toMatch(/^0(px)?$/);
  });
});
