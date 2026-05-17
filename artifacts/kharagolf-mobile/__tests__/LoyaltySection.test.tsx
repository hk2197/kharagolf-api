/**
 * Regression tests for the mobile <LoyaltySection /> (Task #1115 / Task #1285).
 *
 * The section was extracted from the 2000+ line `app/(tabs)/profile.tsx`
 * so the empty placeholder, points-balance card and reward catalogue can
 * be exercised without mounting the full profile screen. Mirrors the
 * pattern used by `locker-renewal-card-fx.test.tsx`.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  LoyaltySection,
  type LoyaltyAccount,
  type LoyaltyReward,
} from "../components/LoyaltySection";

afterEach(() => {
  cleanup();
});

const ACCOUNT: LoyaltyAccount = {
  pointsBalance: 1500,
  lifetimePoints: 4200,
  rollingYearPoints: 1800,
  currentTier: "gold",
};

const REWARDS: LoyaltyReward[] = [
  {
    id: 11,
    name: "Free range bucket",
    description: "Large bucket on the practice range",
    pointsCost: 500,
    rewardType: "discount",
    minTier: "bronze",
  },
  {
    id: 22,
    name: "Premium fitting session",
    description: null,
    pointsCost: 5000,
    rewardType: "discount",
    minTier: "gold",
  },
];

describe("<LoyaltySection />", () => {
  it("renders the empty placeholder when the member has no loyalty account", () => {
    render(<LoyaltySection account={null} rewards={[]} />);

    expect(screen.getByTestId("loyalty-section")).toBeInTheDocument();
    expect(screen.getByTestId("loyalty-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("loyalty-points")).not.toBeInTheDocument();
  });

  it("renders the points balance, tier badge and reward rows when populated", () => {
    render(<LoyaltySection account={ACCOUNT} rewards={REWARDS} />);

    // No empty placeholder.
    expect(screen.queryByTestId("loyalty-empty")).not.toBeInTheDocument();

    // Points balance card with tier badge.
    expect(screen.getByTestId("loyalty-points")).toBeInTheDocument();
    expect(screen.getByTestId("loyalty-points-balance")).toHaveTextContent("1,500");
    expect(screen.getByTestId("loyalty-tier-badge")).toHaveTextContent(/Gold/i);

    // Both rewards rendered with their costs.
    const affordable = screen.getByTestId("loyalty-reward-11");
    const premium = screen.getByTestId("loyalty-reward-22");
    expect(affordable).toHaveTextContent("Free range bucket");
    expect(affordable).toHaveTextContent(/500\s+pts/);
    expect(premium).toHaveTextContent("Premium fitting session");
    // The unaffordable reward shows how many more points are needed
    // (5000 - 1500 = 3500).
    expect(premium).toHaveTextContent(/3,500/);
  });

  it("invokes onSelectReward with the reward when a row is pressed", () => {
    const onSelectReward = vi.fn();
    render(
      <LoyaltySection
        account={ACCOUNT}
        rewards={REWARDS}
        onSelectReward={onSelectReward}
      />,
    );

    fireEvent.click(screen.getByTestId("loyalty-reward-11"));

    expect(onSelectReward).toHaveBeenCalledTimes(1);
    expect(onSelectReward.mock.calls[0][0]).toMatchObject({
      id: 11,
      name: "Free range bucket",
      pointsCost: 500,
    });
  });
});
