/**
 * Task #1438 — verifies the central branding resolver picks the right
 * source for emails / membership cards / overlays.
 *
 * Order of preference:
 *   1. club_theming row (when `customized: true`)
 *   2. Legacy organizations.* fallback
 *   3. undefined → callers fall back to KHARAGOLF defaults
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn() },
}));

import { db } from "@workspace/db";
import {
  resolveOrgBranding,
  invalidateClubThemeCache,
  defaultClubTheme,
} from "../clubTheming.js";

const mockedExecute = db.execute as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedExecute.mockReset();
  invalidateClubThemeCache(7);
});

describe("resolveOrgBranding", () => {
  it("prefers the club_theming row when the org has customised", async () => {
    mockedExecute.mockResolvedValueOnce({
      rows: [{
        primary_color: "#ff0000",
        accent_color: "#00ff00",
        font_family: "Outfit",
        logo_url: "https://cdn.example.com/club.png",
        favicon_url: null,
      }],
    });
    const branding = await resolveOrgBranding(7, {
      name: "Sample Club",
      logoUrl: "https://legacy.example.com/old.png",
      primaryColor: "#000000",
    });
    expect(branding).toEqual({
      orgName: "Sample Club",
      logoUrl: "https://cdn.example.com/club.png",
      primaryColor: "#ff0000",
    });
  });

  it("falls back to organizations.* when the org has no theme row", async () => {
    mockedExecute.mockResolvedValueOnce({ rows: [] });
    const branding = await resolveOrgBranding(7, {
      name: "Sample Club",
      logoUrl: "https://legacy.example.com/old.png",
      primaryColor: "#0a7c46",
    });
    expect(branding).toEqual({
      orgName: "Sample Club",
      logoUrl: "https://legacy.example.com/old.png",
      primaryColor: "#0a7c46",
    });
  });

  it("falls back to organizations.* when club_theming is customised but the field is null", async () => {
    mockedExecute.mockResolvedValueOnce({
      rows: [{
        primary_color: "#ff0000",
        accent_color: "#00ff00",
        font_family: null,
        logo_url: null,
        favicon_url: null,
      }],
    });
    const branding = await resolveOrgBranding(7, {
      name: "Sample Club",
      logoUrl: "https://legacy.example.com/old.png",
      primaryColor: null,
    });
    expect(branding.logoUrl).toBe("https://legacy.example.com/old.png");
    expect(branding.primaryColor).toBe("#ff0000");
  });

  it("returns undefined for missing values when both sources are empty", async () => {
    mockedExecute.mockResolvedValueOnce({ rows: [] });
    const branding = await resolveOrgBranding(7);
    expect(branding.logoUrl).toBeUndefined();
    expect(branding.primaryColor).toBeUndefined();
    expect(branding.orgName).toBeUndefined();
  });

  it("treats DB errors as 'no customised theme' and uses fallback", async () => {
    mockedExecute.mockRejectedValueOnce(new Error("connection refused"));
    const branding = await resolveOrgBranding(7, {
      name: "Sample Club",
      logoUrl: "https://legacy.example.com/old.png",
    });
    expect(branding.logoUrl).toBe("https://legacy.example.com/old.png");
  });
});

describe("defaultClubTheme", () => {
  it("returns customized=false so clients keep their built-in defaults", () => {
    const t = defaultClubTheme();
    expect(t.customized).toBe(false);
    expect(t.primaryColor).toMatch(/^#/);
    expect(t.accentColor).toMatch(/^#/);
    expect(t.logoUrl).toBeNull();
    expect(t.faviconUrl).toBeNull();
  });
});
