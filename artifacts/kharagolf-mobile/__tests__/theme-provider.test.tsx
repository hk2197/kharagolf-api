/**
 * Task #1438 — pins the source-of-truth contract for the mobile theme
 * provider. Specifically:
 *
 *   - When the active org has NO `club_theming` row (i.e. the API
 *     `customized` flag is false / branding is null), the player tab
 *     bar must fall back to the KHARAGOLF defaults — not infer a
 *     "customised" state from any leaked legacy colours.
 *   - When the API explicitly says `customized: true`, the saved
 *     accent flows through to consumers via `useTheme().tokens.colors`
 *     and the `customized` flag.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";
import { DEFAULT_DARK_TOKENS } from "../theme/tokens";

function Probe({ onResolve }: { onResolve: (value: ReturnType<typeof useTheme>) => void }) {
  const value = useTheme();
  onResolve(value);
  return null;
}

describe("ThemeProvider — Task #1438 customised contract", () => {
  it("returns customized=false and KHARAGOLF default tokens when no branding is supplied", () => {
    let captured: ReturnType<typeof useTheme> | undefined;
    render(
      <ThemeProvider>
        <Probe onResolve={(v) => { captured = v; }} />
      </ThemeProvider>,
    );
    expect(captured).toBeDefined();
    expect(captured!.customized).toBe(false);
    expect(captured!.logoUrl).toBeNull();
    expect(captured!.tokens.colors.primary).toBe(DEFAULT_DARK_TOKENS.colors.primary);
    expect(captured!.tokens.colors.accent).toBe(DEFAULT_DARK_TOKENS.colors.accent);
  });

  it("returns customized=false when branding is explicitly null", () => {
    let captured: ReturnType<typeof useTheme> | undefined;
    render(
      <ThemeProvider branding={null}>
        <Probe onResolve={(v) => { captured = v; }} />
      </ThemeProvider>,
    );
    expect(captured!.customized).toBe(false);
    expect(captured!.tokens.colors.accent).toBe(DEFAULT_DARK_TOKENS.colors.accent);
  });

  it("does NOT infer customised=true from colour fields alone (legacy fallback path)", () => {
    // Simulates the loading-window legacy fallback in
    // ActiveClubThemeProvider when the caller forgets to set the
    // explicit `customized` flag. Without that flag the provider
    // must treat the branding as not customised so consumers like
    // the tab bar use the KHARAGOLF default accent.
    let captured: ReturnType<typeof useTheme> | undefined;
    render(
      <ThemeProvider branding={{ primaryColor: "#ff0000", accentColor: "#00ff00" }}>
        <Probe onResolve={(v) => { captured = v; }} />
      </ThemeProvider>,
    );
    expect(captured!.customized).toBe(false);
  });

  it("returns customized=true and applies the accent override when the saved theme is supplied", () => {
    let captured: ReturnType<typeof useTheme> | undefined;
    render(
      <ThemeProvider
        branding={{
          primaryColor: "#1a1a1a",
          accentColor: "#ff8800",
          fontFamily: "Outfit",
          logoUrl: "https://cdn.example.com/logo.png",
          customized: true,
        }}
      >
        <Probe onResolve={(v) => { captured = v; }} />
      </ThemeProvider>,
    );
    expect(captured!.customized).toBe(true);
    expect(captured!.logoUrl).toBe("https://cdn.example.com/logo.png");
    expect(captured!.tokens.colors.primary).toBe("#1a1a1a");
    expect(captured!.tokens.colors.accent).toBe("#ff8800");
  });
});
