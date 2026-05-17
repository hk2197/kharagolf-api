import React from "react";
import { ActivityIndicator, type ActivityIndicatorProps } from "react-native";

export interface LoadingSpinnerProps extends ActivityIndicatorProps {
  /**
   * Accessible label announced by screen readers. Defaults to "Loading".
   * Pass a screen-specific label (e.g. "Loading lessons") when it adds context.
   */
  label?: string;
}

/**
 * Drop-in replacement for `<ActivityIndicator>` that always exposes an
 * accessible name to screen readers.
 *
 * On RN-Web `<ActivityIndicator>` renders with `role="progressbar"` but no
 * accessible name, so screen readers land on a busy region and announce
 * nothing. This wrapper adds a default `accessibilityLabel` of "Loading"
 * (overridable via `label` or `accessibilityLabel`) and an
 * `accessibilityState` of `{ busy: true }` so assistive tech announces the
 * loading state instead of staying silent.
 */
export function LoadingSpinner({
  label = "Loading",
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  ...rest
}: LoadingSpinnerProps) {
  return (
    <ActivityIndicator
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole={accessibilityRole ?? "progressbar"}
      accessibilityState={{ busy: true, ...(accessibilityState ?? {}) }}
      {...rest}
    />
  );
}

export default LoadingSpinner;
