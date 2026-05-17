import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PortalHandicapCalc } from "@/pages/portal/index";

describe("PortalHandicapCalc (Task #354 regression)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              courseHandicap: 18,
              playingHandicap: 18,
              netPar: 72,
              parDiff: 0,
              projectedHandicapIndex: null,
              differential: null,
            }),
        }),
      ) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("mounts without throwing 't is not defined' and renders the calculator card", () => {
    expect(() => render(<PortalHandicapCalc currentHI={18} />)).not.toThrow();
    expect(screen.getByTestId("portal-handicap-calc")).toBeInTheDocument();
    expect(screen.getByText("Handicap What-If Calculator")).toBeInTheDocument();
    expect(screen.getByText("My Handicap Index")).toBeInTheDocument();
    expect(screen.getByText("Slope Rating")).toBeInTheDocument();
  });
});
