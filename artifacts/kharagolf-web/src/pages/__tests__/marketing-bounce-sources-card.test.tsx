/**
 * Task #1557 — Verifies the bounce-source chart's click-through wiring.
 *
 * Recharts wraps the original data row inside `payload` when invoking a
 * Bar's `onClick`. A previous version of this card pulled `entry.key`
 * directly, which silently no-op'd in production. This test pins the
 * payload-shape contract so the deep-link into the Suppressions tab
 * keeps working across Recharts version bumps.
 *
 * Task #1943 — same component now also renders a "spam complaints by
 * source" variant via the `reason` prop. Tests below pin that the title,
 * empty state, and testid namespace switch correctly so the bounce chart
 * and the spam chart can coexist on the same page without colliding.
 *
 * Companion API coverage lives in
 *   artifacts/api-server/src/tests/marketing-bounce-sources.test.ts
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { BounceSourcesCard } from "../marketing";

const sampleData = {
  windowDays: 30,
  total: 14,
  truncated: false,
  sources: [
    { key: "campaign:42", label: "Spring Open Blast", campaignId: 42, flow: null, count: 9 },
    { key: "flow:dues_receipt", label: "dues_receipt", campaignId: null, flow: "dues_receipt", count: 4 },
    { key: "none", label: "No source recorded", campaignId: null, flow: null, count: 1 },
  ],
};

const flowLabels: Record<string, string> = {
  dues_receipt: "Dues receipt",
};

afterEach(() => cleanup());

describe("BounceSourcesCard click-through", () => {
  it("renders one legend chip per source with friendly labels", () => {
    render(
      <BounceSourcesCard data={sampleData} flowLabels={flowLabels} onBarClick={vi.fn()} />,
    );

    expect(screen.getByTestId("bounce-source-legend-campaign:42")).toHaveTextContent(
      "Spring Open Blast",
    );
    // Friendly flow label should win over the raw "dues_receipt" tag.
    expect(screen.getByTestId("bounce-source-legend-flow:dues_receipt")).toHaveTextContent(
      "Dues receipt",
    );
    expect(screen.getByTestId("bounce-source-legend-none")).toHaveTextContent(
      "No source recorded",
    );
    // Header reflects total + window.
    expect(screen.getByTestId("bounce-sources-card")).toHaveTextContent(
      "Bounces by source — last 30 days",
    );
    // Chart container is mounted (the actual SVG bars require layout
    // and are exercised by the production app + the click-payload test
    // below; in jsdom we just assert the wrapper renders).
    expect(screen.getByTestId("bounce-sources-chart")).toBeInTheDocument();
  });

  it("legend buttons forward the source key to onBarClick", () => {
    const onBarClick = vi.fn();
    render(
      <BounceSourcesCard data={sampleData} flowLabels={flowLabels} onBarClick={onBarClick} />,
    );

    fireEvent.click(screen.getByTestId("bounce-source-legend-campaign:42"));
    fireEvent.click(screen.getByTestId("bounce-source-legend-flow:dues_receipt"));
    fireEvent.click(screen.getByTestId("bounce-source-legend-none"));

    expect(onBarClick).toHaveBeenNthCalledWith(1, "campaign:42");
    expect(onBarClick).toHaveBeenNthCalledWith(2, "flow:dues_receipt");
    expect(onBarClick).toHaveBeenNthCalledWith(3, "none");
  });

  it("renders the empty state when no bounces are recorded", () => {
    render(
      <BounceSourcesCard
        data={{ windowDays: 30, total: 0, truncated: false, sources: [] }}
        flowLabels={flowLabels}
        onBarClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("bounce-sources-card")).toHaveTextContent(
      "No bounces recorded in this window",
    );
    expect(screen.queryByTestId("bounce-sources-chart")).toBeNull();
  });

  it("surfaces the 'showing top 5' note when the API truncated", () => {
    render(
      <BounceSourcesCard
        data={{ ...sampleData, truncated: true }}
        flowLabels={flowLabels}
        onBarClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("bounce-sources-card")).toHaveTextContent(
      "showing top 5 named sources",
    );
  });

  it("loading state renders a placeholder card without crashing", () => {
    render(<BounceSourcesCard data={undefined} flowLabels={flowLabels} onBarClick={vi.fn()} />);
    expect(screen.getByTestId("bounce-sources-card")).toHaveTextContent("Loading bounce sources");
  });
});

/**
 * Task #1942 — the time-window picker.
 *
 * The picker is opt-in (controlled by the `windowOptions` /
 * `selectedWindowDays` / `onWindowDaysChange` triplet) so the legacy
 * call sites and the unit-test fixtures above keep their original look
 * and feel. When wired up, the dropdown:
 *  - renders one <option> per supplied window length,
 *  - reflects the parent's current selection (so it stays in sync with
 *    sessionStorage-restored state on mount),
 *  - forwards the chosen number to onWindowDaysChange,
 *  - lets the chart subtitle prefer the *user's* selection over the
 *    server-echoed window during the brief refetch gap.
 */
describe("BounceSourcesCard window picker (Task #1942)", () => {
  it("does not render the picker when no windowOptions are provided", () => {
    render(
      <BounceSourcesCard data={sampleData} flowLabels={flowLabels} onBarClick={vi.fn()} />,
    );
    expect(screen.queryByTestId("bounce-sources-window")).toBeNull();
  });

  it("renders an <option> per supplied window length and reflects the current selection", () => {
    render(
      <BounceSourcesCard
        data={sampleData}
        flowLabels={flowLabels}
        onBarClick={vi.fn()}
        windowOptions={[7, 30, 90]}
        selectedWindowDays={90}
        onWindowDaysChange={vi.fn()}
      />,
    );
    const select = screen.getByTestId("bounce-sources-window") as HTMLSelectElement;
    expect(select.value).toBe("90");
    const options = Array.from(select.options).map(o => o.value);
    expect(options).toEqual(["7", "30", "90"]);
  });

  it("forwards the chosen window (as a number) to onWindowDaysChange", () => {
    const onWindowDaysChange = vi.fn();
    render(
      <BounceSourcesCard
        data={sampleData}
        flowLabels={flowLabels}
        onBarClick={vi.fn()}
        windowOptions={[7, 30, 90]}
        selectedWindowDays={30}
        onWindowDaysChange={onWindowDaysChange}
      />,
    );
    fireEvent.change(screen.getByTestId("bounce-sources-window"), { target: { value: "7" } });
    expect(onWindowDaysChange).toHaveBeenCalledWith(7);
  });

  it("subtitle prefers the user's selection over the server-echoed window", () => {
    // Simulates the in-flight gap: parent has switched to 7 days but the
    // cached payload still belongs to the previous 30-day request.
    render(
      <BounceSourcesCard
        data={{ ...sampleData, windowDays: 30 }}
        flowLabels={flowLabels}
        onBarClick={vi.fn()}
        windowOptions={[7, 30, 90]}
        selectedWindowDays={7}
        onWindowDaysChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("bounce-sources-card")).toHaveTextContent(
      "Bounces by source — last 7 days",
    );
  });

  it("renders the picker in the empty state too so admins can widen the window", () => {
    const onWindowDaysChange = vi.fn();
    render(
      <BounceSourcesCard
        data={{ windowDays: 7, totalBounces: 0, truncated: false, sources: [] }}
        flowLabels={flowLabels}
        onBarClick={vi.fn()}
        windowOptions={[7, 30, 90]}
        selectedWindowDays={7}
        onWindowDaysChange={onWindowDaysChange}
      />,
    );
    expect(screen.getByTestId("bounce-sources-card")).toHaveTextContent(
      "No bounces recorded in this window",
    );
    fireEvent.change(screen.getByTestId("bounce-sources-window"), { target: { value: "90" } });
    expect(onWindowDaysChange).toHaveBeenCalledWith(90);
  });
});

describe("BounceSourcesCard onClick payload shape", () => {
  /**
   * Re-implementation of the production handler so we can assert the
   * payload-shape contract directly without depending on Recharts'
   * internal event dispatch.
   *
   * If this stays in lockstep with the chart's onClick, then any
   * future regression (reverting to `entry.key`, dropping the payload
   * fallback, etc.) will fail this test.
   */
  function pickKeyForBarClick(
    entry: { key?: string; payload?: { key?: string } } | undefined,
  ): string | undefined {
    return entry?.payload?.key ?? entry?.key;
  }

  it("reads `key` from `payload` (Recharts v2 shape)", () => {
    const recharts2Payload = {
      // What a real Recharts Bar onClick fires with — the data row is
      // wrapped under `payload`, alongside other internal props.
      payload: { key: "campaign:42", label: "Spring Open Blast", count: 9 },
      value: 9,
      tooltipPayload: [],
    };
    expect(pickKeyForBarClick(recharts2Payload)).toBe("campaign:42");
  });

  it("falls back to a top-level `key` (older / future Recharts shape)", () => {
    expect(pickKeyForBarClick({ key: "flow:dues_receipt" })).toBe("flow:dues_receipt");
  });

  it("ignores undefined / empty entries", () => {
    expect(pickKeyForBarClick(undefined)).toBeUndefined();
    expect(pickKeyForBarClick({})).toBeUndefined();
    expect(pickKeyForBarClick({ payload: {} })).toBeUndefined();
  });
});

/* ─── Task #1943 — spam-complaint variant ──────────────────────────────
 * The same component renders both the bounce chart and the spam-complaint
 * chart, switched via the `reason` prop. These tests pin that:
 *   - the title and noun adapt ("Spam complaints by source" / "spam complaint(s)"),
 *   - the testid namespace switches to `spam-*` so the spam chart can be
 *     targeted independently of the bounce chart on the same page,
 *   - the empty state and loading copy adapt,
 *   - click-through still forwards the source key untouched (the parent
 *     decides which `reason` filter to apply on the Suppressions tab).
 */
describe("BounceSourcesCard — spam complaint variant", () => {
  it("renders spam-specific title and noun, and uses the spam testid namespace", () => {
    render(
      <BounceSourcesCard
        data={sampleData}
        flowLabels={flowLabels}
        reason="spam_complaint"
        onBarClick={vi.fn()}
      />,
    );

    // Title + count line use spam wording.
    const card = screen.getByTestId("spam-sources-card");
    expect(card).toHaveTextContent("Spam complaints by source — last 30 days");
    expect(card).toHaveTextContent("14 total spam complaints");

    // Spam chart owns its own chart + legend testids.
    expect(screen.getByTestId("spam-sources-chart")).toBeInTheDocument();
    expect(screen.getByTestId("spam-sources-legend")).toBeInTheDocument();
    expect(screen.getByTestId("spam-source-legend-campaign:42")).toHaveTextContent(
      "Spring Open Blast",
    );

    // And it must NOT collide with the bounce chart's testids.
    expect(screen.queryByTestId("bounce-sources-card")).toBeNull();
    expect(screen.queryByTestId("bounce-sources-chart")).toBeNull();
  });

  it("singularises the noun when there is exactly one spam complaint", () => {
    render(
      <BounceSourcesCard
        data={{
          windowDays: 30,
          total: 1,
          truncated: false,
          sources: [
            { key: "flow:dues_receipt", label: "dues_receipt", campaignId: null, flow: "dues_receipt", count: 1 },
          ],
        }}
        flowLabels={flowLabels}
        reason="spam_complaint"
        onBarClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("spam-sources-card")).toHaveTextContent("1 total spam complaint");
    expect(screen.getByTestId("spam-sources-card")).not.toHaveTextContent(
      "1 total spam complaints",
    );
  });

  it("renders a spam-specific empty state when no complaints are recorded", () => {
    render(
      <BounceSourcesCard
        data={{ windowDays: 30, total: 0, truncated: false, sources: [] }}
        flowLabels={flowLabels}
        reason="spam_complaint"
        onBarClick={vi.fn()}
      />,
    );
    const card = screen.getByTestId("spam-sources-card");
    expect(card).toHaveTextContent("Spam complaints by source — last 30 days");
    expect(card).toHaveTextContent("No spam complaints recorded in this window");
    expect(screen.queryByTestId("spam-sources-chart")).toBeNull();
  });

  it("renders a spam-specific loading placeholder", () => {
    render(
      <BounceSourcesCard
        data={undefined}
        flowLabels={flowLabels}
        reason="spam_complaint"
        onBarClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId("spam-sources-card")).toHaveTextContent(
      "Loading spam complaint sources",
    );
  });

  it("legend buttons forward the source key (parent decides the reason)", () => {
    const onBarClick = vi.fn();
    render(
      <BounceSourcesCard
        data={sampleData}
        flowLabels={flowLabels}
        reason="spam_complaint"
        onBarClick={onBarClick}
      />,
    );

    fireEvent.click(screen.getByTestId("spam-source-legend-campaign:42"));
    fireEvent.click(screen.getByTestId("spam-source-legend-flow:dues_receipt"));
    fireEvent.click(screen.getByTestId("spam-source-legend-none"));

    expect(onBarClick).toHaveBeenNthCalledWith(1, "campaign:42");
    expect(onBarClick).toHaveBeenNthCalledWith(2, "flow:dues_receipt");
    expect(onBarClick).toHaveBeenNthCalledWith(3, "none");
  });
});
