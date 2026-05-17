/**
 * Task #1030 — Pin the estimated SG-Putting marker on the share card.
 *
 * The post-round share image (rendered via captureRef in
 * `app/(tabs)/score.tsx`) reuses `<RoundSummaryCard />` for its visual.
 * When SG-Putting was estimated from scorecard putt counts (rather than
 * measured per shot), the card mirrors the in-app cue: the Putt cell
 * label gets a trailing "~", its value is prefixed with "~", and a
 * footnote is rendered explaining the marker. Without these, players
 * would share an SG-Putting number that looks measured when it isn't.
 *
 * These cases are not exercised anywhere else, so a refactor of the SG
 * cell, the footnote, or the wiring on `score.tsx`'s `puttingEstimated`
 * flag could silently regress the share image. We render the card
 * directly with both `puttingEstimated` states and assert on the visible
 * markers and footnote text.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("expo-linear-gradient", () => {
  const ReactInner = require("react") as typeof React;
  return {
    LinearGradient: ({ children, ...rest }: { children?: ReactNode }) =>
      ReactInner.createElement("div", rest, children),
  };
});

import RoundSummaryCard, {
  type RoundSummaryCardProps,
} from "../components/RoundSummaryCard";

const baseProps: RoundSummaryCardProps = {
  tournamentName: "Spring Open",
  playerName: "Jane Doe",
  round: 1,
  gross: 74,
  toPar: 2,
  holesPlayed: 18,
  eagles: 0,
  birdies: 3,
  pars: 10,
  bogeys: 4,
  doubles: 1,
  holeResults: [],
};

const baseSg = {
  sgTotal: 1.23,
  sgOTT: 0.4,
  sgApproach: 0.5,
  sgATG: 0.1,
  sgPutting: 0.23,
};

const FOOTNOTE = "~ Some holes' Putt SG was estimated from your scorecard putt count.";

afterEach(() => {
  cleanup();
});

describe("RoundSummaryCard — estimated SG-Putting marker (Task #1030)", () => {
  it("shows the '~' label, '~+x.xx' value, and footnote when puttingEstimated is true", () => {
    render(
      <RoundSummaryCard
        {...baseProps}
        sgTotals={{ ...baseSg, puttingEstimated: true }}
        sgShotsTracked={42}
      />,
    );

    // Label gains the trailing "~" only on the Putt cell.
    expect(screen.getByText("Putt ~")).toBeInTheDocument();
    expect(screen.queryByText("Putt")).not.toBeInTheDocument();

    // Value is prefixed with "~" and keeps the sign + 2dp format.
    const estimatedValue = screen.getByText("~+0.23");
    expect(estimatedValue).toBeInTheDocument();
    // The estimated value should also pick up the italic + reduced-opacity
    // styling that distinguishes it from a measured number. react-native-web
    // flattens styles onto an inline `style` attribute, so we read it directly
    // rather than relying on jsdom's computed-style resolution.
    const inlineStyle = estimatedValue.getAttribute("style") ?? "";
    expect(inlineStyle).toMatch(/font-style:\s*italic/);
    expect(inlineStyle).toMatch(/opacity:\s*0\.7/);

    // Footnote explaining the marker is present.
    expect(screen.getByText(FOOTNOTE)).toBeInTheDocument();

    // Sibling SG cells must NOT pick up the estimated styling.
    expect(screen.getByText("OTT")).toBeInTheDocument();
    expect(screen.getByText("App")).toBeInTheDocument();
    expect(screen.getByText("ATG")).toBeInTheDocument();
  });

  it("omits the '~' marker and footnote when puttingEstimated is false", () => {
    render(
      <RoundSummaryCard
        {...baseProps}
        sgTotals={{ ...baseSg, puttingEstimated: false }}
        sgShotsTracked={42}
      />,
    );

    expect(screen.getByText("Putt")).toBeInTheDocument();
    expect(screen.queryByText("Putt ~")).not.toBeInTheDocument();

    // Value uses the normal "+0.23" form, not the "~+0.23" form.
    expect(screen.getByText("+0.23")).toBeInTheDocument();
    expect(screen.queryByText("~+0.23")).not.toBeInTheDocument();

    expect(screen.queryByText(FOOTNOTE)).not.toBeInTheDocument();
  });
});
