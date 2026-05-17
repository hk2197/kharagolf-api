/**
 * Regression tests for the mobile <RepairJobsSection /> (Task #1115 / Task #1285).
 *
 * The repair-jobs block was extracted from `app/(tabs)/profile.tsx` so
 * the empty placeholder, list rows, status pill and "ready for pickup"
 * acknowledgement banner can be exercised in isolation.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/i18n", () => ({
  getLocale: () => "en-US",
}));

import {
  RepairJobsSection,
  type RepairJob,
} from "../components/RepairJobsSection";

afterEach(() => {
  cleanup();
});

const IN_PROGRESS_JOB: RepairJob = {
  id: 100,
  description: "Driver regrip",
  jobType: "regrip",
  status: "in_progress",
  technicianName: "Sam Builder",
  expectedCompletionDate: new Date("2026-05-01T00:00:00Z").toISOString(),
  notificationSentAt: null,
  createdAt: new Date("2026-04-20T00:00:00Z").toISOString(),
};

const READY_JOB: RepairJob = {
  id: 200,
  description: "5 iron reshaft",
  jobType: "reshaft",
  status: "ready_for_pickup",
  technicianName: null,
  expectedCompletionDate: null,
  notificationSentAt: new Date("2026-04-22T00:00:00Z").toISOString(),
  createdAt: new Date("2026-04-10T00:00:00Z").toISOString(),
};

describe("<RepairJobsSection />", () => {
  it("renders the empty placeholder when there are no repair jobs", () => {
    render(<RepairJobsSection jobs={[]} />);

    expect(screen.getByTestId("repairs-section")).toBeInTheDocument();
    expect(screen.getByTestId("repairs-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("repair-row-100")).not.toBeInTheDocument();
  });

  it("renders job rows with technician/expected info and a ready-for-pickup banner only on ready jobs", () => {
    render(<RepairJobsSection jobs={[IN_PROGRESS_JOB, READY_JOB]} />);

    expect(screen.queryByTestId("repairs-empty")).not.toBeInTheDocument();

    const inProgress = screen.getByTestId("repair-row-100");
    expect(inProgress).toHaveTextContent("Driver regrip");
    expect(inProgress).toHaveTextContent(/In Progress/i);
    expect(inProgress).toHaveTextContent(/Sam Builder/);
    // No ready-for-pickup banner on an in-progress job.
    expect(screen.queryByTestId("repair-ready-100")).not.toBeInTheDocument();

    const ready = screen.getByTestId("repair-row-200");
    expect(ready).toHaveTextContent("5 iron reshaft");
    expect(ready).toHaveTextContent(/Ready for Pickup/i);
    expect(screen.getByTestId("repair-ready-200")).toBeInTheDocument();
  });

  it("invokes onAcknowledgeReady with the job when the ready banner is pressed", () => {
    const onAcknowledgeReady = vi.fn();
    render(
      <RepairJobsSection
        jobs={[READY_JOB]}
        onAcknowledgeReady={onAcknowledgeReady}
      />,
    );

    fireEvent.click(screen.getByTestId("repair-ready-200"));

    expect(onAcknowledgeReady).toHaveBeenCalledTimes(1);
    expect(onAcknowledgeReady.mock.calls[0][0]).toMatchObject({
      id: 200,
      description: "5 iron reshaft",
      status: "ready_for_pickup",
    });
  });
});
