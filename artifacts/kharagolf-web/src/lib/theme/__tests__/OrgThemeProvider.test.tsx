/**
 * Task #1438 — integration test pinning the player-portal branding
 * pipeline. Asserts that when the active org has a customised theme:
 *
 *   - `OrgThemeProvider` fetches `/api/organizations/:orgId/theming`
 *     and exposes the saved logo + colours via `useOrgBranding()`.
 *   - The injected `<style id="kharagolf-org-theme-overrides">` tag
 *     overrides the `--primary` and `--accent` CSS variables on
 *     `:root`, so every shadcn/Tailwind consumer renders in the club
 *     palette.
 *   - The page favicon is swapped to the saved `faviconUrl` (and the
 *     original href is preserved on the `<link>` for restore).
 *
 * Also pins the fallback contract: when the API responds with
 * `customized: false` (the org has not saved a theme), the override
 * `<style>` tag is NOT injected and `useOrgBranding()` returns null
 * so consumers render the KHARAGOLF defaults.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 42, role: "player" } }),
}));

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgId: () => 42,
}));

import { OrgThemeProvider, useOrgBranding } from "../OrgThemeProvider";

function BrandingProbe({ onResolve }: { onResolve: (b: ReturnType<typeof useOrgBranding>) => void }) {
  const branding = useOrgBranding();
  React.useEffect(() => { onResolve(branding); }, [branding, onResolve]);
  return null;
}

const ORIGINAL_FAVICON = "/favicon.svg";

beforeEach(() => {
  document.head.innerHTML = `<link rel="icon" type="image/svg+xml" href="${ORIGINAL_FAVICON}" />`;
});

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
  document.getElementById("kharagolf-org-theme-overrides")?.remove();
  vi.restoreAllMocks();
});

describe("OrgThemeProvider — Task #1438 portal branding pipeline", () => {
  it("injects CSS var overrides, swaps the favicon, and exposes branding via context when the org has a customised theme", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          theme: {
            primaryColor: "#0033cc",
            accentColor: "#ff8800",
            fontFamily: "Inter, sans-serif",
            logoUrl: "https://cdn.example.com/club-logo.png",
            faviconUrl: "https://cdn.example.com/club-favicon.png",
            customized: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    let captured: ReturnType<typeof useOrgBranding> | undefined;
    render(
      <OrgThemeProvider>
        <BrandingProbe onResolve={(b) => { captured = b; }} />
      </OrgThemeProvider>,
    );

    await waitFor(() => {
      expect(captured?.logoUrl).toBe("https://cdn.example.com/club-logo.png");
    });

    expect(captured?.primaryColor).toBe("#0033cc");
    expect(captured?.accentColor).toBe("#ff8800");
    expect(captured?.fontFamily).toBe("Inter, sans-serif");
    expect(captured?.faviconUrl).toBe("https://cdn.example.com/club-favicon.png");

    // Assert the runtime <style> tag carries primary + accent overrides.
    await waitFor(() => {
      const tag = document.getElementById("kharagolf-org-theme-overrides");
      expect(tag).not.toBeNull();
      const css = tag?.textContent ?? "";
      expect(css).toMatch(/--primary:\s*\d+\s+\d+%\s+\d+%/);
      expect(css).toMatch(/--accent:\s*\d+\s+\d+%\s+\d+%/);
      expect(css).toMatch(/--font-display:/);
    });

    // Favicon: the existing <link> href is swapped, original href is cached.
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    expect(link).not.toBeNull();
    expect(link!.href).toContain("club-favicon.png");
    expect(link!.getAttribute("data-kharagolf-prev-href")).toContain(ORIGINAL_FAVICON);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/organizations/42/theming",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("does NOT inject overrides and exposes null branding when the org has no customised theme (defaults survive)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          theme: {
            primaryColor: null,
            accentColor: null,
            fontFamily: null,
            logoUrl: null,
            faviconUrl: null,
            customized: false,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    let captured: ReturnType<typeof useOrgBranding> | undefined = undefined;
    let observed = false;
    render(
      <OrgThemeProvider>
        <BrandingProbe onResolve={(b) => { captured = b; observed = true; }} />
      </OrgThemeProvider>,
    );

    // Wait for the fetch to settle (the probe re-runs once the
    // provider's useEffect resolves).
    await waitFor(() => {
      expect(observed).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    expect(captured).toBeNull();
    expect(document.getElementById("kharagolf-org-theme-overrides")).toBeNull();
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    expect(link!.href).toContain(ORIGINAL_FAVICON);
    expect(link!.hasAttribute("data-kharagolf-prev-href")).toBe(false);
  });
});
