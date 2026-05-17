/**
 * Unit tests for the shared mobile <LoadingSpinner /> wrapper (Task #2181).
 *
 * The wrapper is a drop-in replacement for React Native's
 * <ActivityIndicator>. On RN-Web, ActivityIndicator renders as
 * <div role="progressbar"> with no accessible name, so screen readers
 * announce nothing when a screen is loading. The wrapper guarantees:
 *   1. A default accessibilityLabel of "Loading".
 *   2. accessibilityRole="progressbar".
 *   3. accessibilityState={{ busy: true }}.
 *   4. Callers can override the label per screen, and other ActivityIndicator
 *      props (color, size, style, testID) still pass through.
 */
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { LoadingSpinner } from "@/components/LoadingSpinner";

afterEach(() => {
  cleanup();
});

describe("LoadingSpinner", () => {
  it("exposes a default accessible name of 'Loading' to screen readers", () => {
    const { container } = render(<LoadingSpinner />);
    const node = container.querySelector('[role="progressbar"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute("aria-label")).toBe("Loading");
  });

  it("uses the supplied label as the accessible name", () => {
    const { container } = render(<LoadingSpinner label="Loading lessons" />);
    const node = container.querySelector('[role="progressbar"]');
    expect(node?.getAttribute("aria-label")).toBe("Loading lessons");
  });

  it("lets callers fully override accessibilityLabel", () => {
    const { container } = render(
      <LoadingSpinner accessibilityLabel="Fetching tee times" label="ignored" />,
    );
    const node = container.querySelector('[role="progressbar"]');
    expect(node?.getAttribute("aria-label")).toBe("Fetching tee times");
  });

  it("forwards testID and other ActivityIndicator props", () => {
    const { container } = render(
      <LoadingSpinner testID="custom-spinner" size="large" color="#ff0000" />,
    );
    const node = container.querySelector('[data-testid="custom-spinner"]');
    expect(node).not.toBeNull();
    expect(node?.getAttribute("role")).toBe("progressbar");
    expect(node?.getAttribute("aria-label")).toBe("Loading");
  });
});
