/**
 * Regression tests for the mobile <FittingSessionsSection /> (Task #1115 / Task #1285).
 *
 * The fitting-sessions block was extracted from `app/(tabs)/profile.tsx`
 * so the empty placeholder, list rows, recommended-spec rendering and
 * "open session" interaction can be exercised in isolation.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/i18n", () => ({
  getLocale: () => "en-US",
}));

import {
  FittingSessionsSection,
  type FittingSession,
} from "../components/FittingSessionsSection";

afterEach(() => {
  cleanup();
});

const BOOKED: FittingSession = {
  id: 7,
  scheduledAt: new Date("2026-05-12T15:30:00Z").toISOString(),
  status: "booked",
  technicianName: "Lee Fitter",
  recommendedSpecs: {},
  notes: null,
};

const COMPLETED: FittingSession = {
  id: 8,
  scheduledAt: new Date("2026-04-01T15:30:00Z").toISOString(),
  status: "completed",
  technicianName: "Lee Fitter",
  recommendedSpecs: {
    shaftFlex: "Stiff",
    lieAngle: "+1°",
    notes: "Recommended a soft step on the 7 iron.",
  },
  notes: "Bring driver next visit.",
};

describe("<FittingSessionsSection />", () => {
  it("renders the empty placeholder when there are no fitting sessions", () => {
    render(<FittingSessionsSection sessions={[]} />);

    expect(screen.getByTestId("fittings-section")).toBeInTheDocument();
    expect(screen.getByTestId("fittings-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("fitting-row-7")).not.toBeInTheDocument();
  });

  it("renders rows with status badge, technician and recommended specs when populated", () => {
    render(<FittingSessionsSection sessions={[BOOKED, COMPLETED]} />);

    expect(screen.queryByTestId("fittings-empty")).not.toBeInTheDocument();

    const booked = screen.getByTestId("fitting-row-7");
    expect(booked).toHaveTextContent(/Booked/i);
    expect(booked).toHaveTextContent(/Lee Fitter/);

    const completed = screen.getByTestId("fitting-row-8");
    expect(completed).toHaveTextContent(/Completed/i);
    // Recommended specs block lifts non-notes fields and renders the
    // notes line as italic supporting text.
    expect(completed).toHaveTextContent(/Recommended Specs/i);
    expect(completed).toHaveTextContent(/shaft Flex/);
    expect(completed).toHaveTextContent(/Stiff/);
    expect(completed).toHaveTextContent(/lie Angle/);
    expect(completed).toHaveTextContent(/\+1°/);
    expect(completed).toHaveTextContent(/Recommended a soft step on the 7 iron\./);
    expect(completed).toHaveTextContent(/Bring driver next visit\./);
  });

  it("invokes onSelectSession with the matching session when a row is pressed", () => {
    const onSelectSession = vi.fn();
    render(
      <FittingSessionsSection
        sessions={[COMPLETED]}
        onSelectSession={onSelectSession}
      />,
    );

    fireEvent.click(screen.getByTestId("fitting-row-8"));

    expect(onSelectSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession.mock.calls[0][0]).toMatchObject({
      id: 8,
      status: "completed",
      technicianName: "Lee Fitter",
    });
  });
});
