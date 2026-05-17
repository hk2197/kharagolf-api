/**
 * Task #927 — UI coverage for the per-badge Share buttons added in Task #780.
 *
 * Two surfaces are exercised here:
 *
 * 1. The badges catalog on /p/<handle> — every unlocked badge gets a Share
 *    button whose deep link is `/p/<handle>/badge/<type>`. Locked badges must
 *    NOT have a Share button. Clicking the button calls navigator.share with
 *    the canonical URL when available, otherwise falls back to clipboard.
 *
 * 2. The dedicated landing page at /p/<handle>/badge/<type> — renders the
 *    badge title, icon, and player name, and sets the og:image meta tag to
 *    the API-rendered SVG endpoint
 *    `/api/public/p/<handle>/badge/<type>/og`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,QRSTUB") },
}));

import PublicProfilePage from "../public-profile";
import PublicBadgePage from "../public-badge";
import { LocaleProvider } from "@/lib/i18n";

const HANDLE = "tigerw";

const CATALOG = [
  { type: "first_birdie", label: "First Birdie", icon: "🐦", category: "milestone", description: "Score your first birdie" },
  { type: "10_rounds", label: "10 Rounds Played", icon: "🏅", category: "consistency", description: "Complete 10 rounds" },
];

const EARNED_AT = "2025-08-01T10:00:00.000Z";

function buildProfilePayload(opts: { withEarned: boolean } = { withEarned: true }) {
  return {
    handle: HANDLE,
    displayName: "Tiger W",
    profileImage: null,
    bio: null,
    location: null,
    homeClub: null,
    memberSince: "2020-01-01T00:00:00.000Z",
    privacy: {
      showHandicap: false,
      showRecentRounds: false,
      showAchievements: true,
      showFavoriteCourses: false,
    },
    currentHandicap: null,
    handicapJourney: [],
    recentRounds: [],
    achievements: opts.withEarned ? [{
      badgeType: "first_birdie",
      badgeLabel: "First Birdie",
      badgeIcon: "🐦",
      badgeCategory: "milestone",
      badgeDescription: "Score your first birdie",
      earnedAt: EARNED_AT,
    }] : [],
    badgeCatalog: CATALOG,
    badgeProgress: { "10_rounds": { current: 4, target: 10 } },
    favoriteCourses: [],
    deepLinks: { web: "https://example.com/web", mobile: "kharagolf://p/tigerw" },
  };
}

function stubFetch(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // Task #1752 — the public-badge page now appends `?lang=<viewer>` to
      // the profile fetch so the API can localise badge `label`/`description`.
      // Match the path regardless of the query string so existing tests
      // continue to receive the mocked payload, and language-specific tests
      // that pass `?lang=hi` etc. also resolve.
      const path = url.split("?", 1)[0];
      if (path === `/api/public/p/${HANDLE}`) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    }),
  );
}

function renderProfilePage() {
  const { hook } = memoryLocation({ path: `/p/${HANDLE}` });
  return render(
    // Task #1765 — wrap in LocaleProvider so the badge page's `useLocale`
    // call has a context. Seeded to "en" so the existing assertions
    // (which expect English copy unless `?lang=` overrides) keep passing.
    <LocaleProvider initialLang="en">
      <WouterRouter hook={hook}>
        <PublicProfilePage />
      </WouterRouter>
    </LocaleProvider>,
  );
}

function renderBadgePage(type: string, search = "") {
  const path = `/p/${HANDLE}/badge/${type}${search}`;
  const { hook } = memoryLocation({ path });
  return render(
    <LocaleProvider initialLang="en">
      <WouterRouter hook={hook}>
        <PublicBadgePage />
      </WouterRouter>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  // Reset any meta tags from a previous test so assertions are deterministic.
  document.head
    .querySelectorAll('meta[property], meta[name="twitter:image"], meta[name="twitter:title"], meta[name="twitter:description"], meta[name="twitter:card"], meta[name="description"]')
    .forEach(el => el.remove());
  document.title = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try { delete (navigator as unknown as { share?: unknown }).share; } catch { /* ignore */ }
});

describe("Per-badge Share button on /p/<handle> badges catalog", () => {
  it("renders a Share button for unlocked badges only", async () => {
    stubFetch(buildProfilePayload());
    renderProfilePage();

    // Wait for the catalog section to mount.
    await screen.findByTestId("section-achievements");

    // Unlocked badge gets a Share button with the correct testid.
    expect(screen.getByTestId("badge-share-first_birdie")).toBeInTheDocument();
    // Locked badge has NO Share button.
    expect(screen.queryByTestId("badge-share-10_rounds")).not.toBeInTheDocument();
  });

  it("invokes navigator.share with the canonical badge deep link when available", async () => {
    stubFetch(buildProfilePayload());

    const shareMock = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: shareMock,
    });

    renderProfilePage();
    const btn = await screen.findByTestId("badge-share-first_birdie");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledTimes(1);
    });
    const calls = shareMock.mock.calls as unknown as Array<Array<{ url: string; title: string; text: string }>>;
    const arg = calls[0]![0]!;
    expect(arg.url).toBe(`${window.location.origin}/p/${HANDLE}/badge/first_birdie`);
    expect(arg.title).toContain("Tiger W");
    expect(arg.title).toContain("First Birdie");
    expect(arg.text).toContain("First Birdie");
  });

  it("falls back to copying the deep link when navigator.share is not available", async () => {
    stubFetch(buildProfilePayload());

    // Ensure navigator.share is undefined so the share helper falls back to clipboard.
    try { delete (navigator as unknown as { share?: unknown }).share; } catch { /* ignore */ }
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderProfilePage();
    const btn = await screen.findByTestId("badge-share-first_birdie");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/p/${HANDLE}/badge/first_birdie`,
      );
    });
    // Button confirms the fallback copy.
    await waitFor(() => {
      expect(btn).toHaveTextContent(/Link copied/i);
    });
  });
});

describe("Badge landing page /p/<handle>/badge/<type>", () => {
  it("renders the unlocked hero with title, icon and player name", async () => {
    stubFetch(buildProfilePayload());
    renderBadgePage("first_birdie");

    expect(await screen.findByTestId("badge-hero")).toBeInTheDocument();
    expect(screen.getByTestId("badge-label")).toHaveTextContent("First Birdie");
    expect(screen.getByTestId("badge-icon")).toHaveTextContent("🐦");
    expect(screen.getByTestId("badge-player-name")).toHaveTextContent("Tiger W");
    expect(screen.getByTestId("back-to-profile")).toHaveAttribute(
      "href",
      `/p/${HANDLE}`,
    );
  });

  it("sets og:image meta to the API-rendered SVG endpoint and updates document title", async () => {
    stubFetch(buildProfilePayload());
    renderBadgePage("first_birdie");

    await screen.findByTestId("badge-hero");

    await waitFor(() => {
      const og = document.head.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
      expect(og).not.toBeNull();
      expect(og!.content).toBe(
        `${window.location.origin}/api/public/p/${HANDLE}/badge/first_birdie/og`,
      );
    });

    const ogTitle = document.head.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
    const ogUrl = document.head.querySelector('meta[property="og:url"]') as HTMLMetaElement | null;
    const twitterImg = document.head.querySelector('meta[name="twitter:image"]') as HTMLMetaElement | null;

    expect(ogTitle?.content).toContain("First Birdie");
    expect(ogTitle?.content).toContain("Tiger W");
    expect(ogUrl?.content).toBe(
      `${window.location.origin}/p/${HANDLE}/badge/first_birdie`,
    );
    expect(twitterImg?.content).toBe(
      `${window.location.origin}/api/public/p/${HANDLE}/badge/first_birdie/og`,
    );
    expect(document.title).toContain("First Birdie");
    expect(document.title).toContain("Tiger W");
  });

  it("renders the locked 'almost there' variant with progress when the badge is not unlocked", async () => {
    stubFetch(buildProfilePayload());
    renderBadgePage("10_rounds");

    expect(await screen.findByTestId("badge-hero")).toBeInTheDocument();
    expect(screen.getByTestId("badge-label")).toHaveTextContent("10 Rounds Played");
    expect(screen.getByTestId("badge-progress-text")).toHaveTextContent("4 of 10");
    expect(screen.getByTestId("badge-player-name")).toHaveTextContent("Tiger W");

    // og:image still points at the API SVG endpoint for the locked card.
    await waitFor(() => {
      const og = document.head.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
      expect(og?.content).toBe(
        `${window.location.origin}/api/public/p/${HANDLE}/badge/10_rounds/og`,
      );
    });
  });

  it("shows a not-found state when the player has hidden achievements", async () => {
    const payload = buildProfilePayload();
    payload.privacy.showAchievements = false;
    stubFetch(payload);

    renderBadgePage("first_birdie");

    expect(await screen.findByText(/Badge not found/i)).toBeInTheDocument();
    expect(screen.queryByTestId("badge-hero")).not.toBeInTheDocument();
  });

  // Task #1442 — language-aware rendering of the badge page.
  describe("?lang= localisation", () => {
    it("renders the unlocked hero in Hindi when ?lang=hi is supplied and propagates lang to og:image", async () => {
      stubFetch(buildProfilePayload());
      renderBadgePage("first_birdie", "?lang=hi");

      const hero = await screen.findByTestId("badge-hero");
      // Devanagari text from the Hindi bundle ("बैज अनलॉक") must appear in
      // the unlocked hero chip.
      expect(hero.textContent ?? "").toMatch(/[\u0900-\u097F]/);

      // og:image must include the lang param so the server-rendered card
      // matches the page language.
      await waitFor(() => {
        const og = document.head.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
        expect(og?.content).toBe(
          `${window.location.origin}/api/public/p/${HANDLE}/badge/first_birdie/og?lang=hi`,
        );
      });

      // og:locale + <html lang> reflect the resolved language.
      const ogLocale = document.head.querySelector('meta[property="og:locale"]') as HTMLMetaElement | null;
      expect(ogLocale?.content).toBe("hi");
      expect(document.documentElement.lang).toBe("hi");
      expect(document.documentElement.dir).toBe("ltr");
    });

    it("flips the page direction to RTL for Arabic", async () => {
      stubFetch(buildProfilePayload());
      const { container } = renderBadgePage("first_birdie", "?lang=ar");

      await screen.findByTestId("badge-hero");
      expect(document.documentElement.dir).toBe("rtl");
      // Outermost element has dir="rtl" set explicitly (so SSR-style renders
      // pick it up too even before the html effect runs).
      const root = container.firstChild as HTMLElement | null;
      expect(root?.getAttribute("dir")).toBe("rtl");
    });

    it("does NOT add ?lang= to og:image when no lang param is supplied (preserves existing share URLs)", async () => {
      stubFetch(buildProfilePayload());
      renderBadgePage("first_birdie");

      await screen.findByTestId("badge-hero");
      await waitFor(() => {
        const og = document.head.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
        expect(og?.content).toBe(
          `${window.location.origin}/api/public/p/${HANDLE}/badge/first_birdie/og`,
        );
      });
    });

    // Task #2176 — When the visitor has set their site-wide locale to a
    // non-English language (e.g. via the header switcher), the share URL
    // and the og:image meta both pick up that language even without a
    // `?lang=` URL override. The previewer card a recipient sees on
    // Facebook/WhatsApp/etc. then renders in the SENDER's language —
    // matching the localized badge title rendered into the artwork.
    it("appends the sender's site language to the share URL and og:image when siteLang is non-English (Task #2176)", async () => {
      stubFetch(buildProfilePayload());
      const { hook } = memoryLocation({ path: `/p/${HANDLE}/badge/first_birdie` });
      render(
        <LocaleProvider initialLang="hi">
          <WouterRouter hook={hook}>
            <PublicBadgePage />
          </WouterRouter>
        </LocaleProvider>,
      );

      await screen.findByTestId("badge-hero");

      // og:image meta points at the API OG endpoint with `?lang=hi` so any
      // social previewer that fetches the badge artwork gets the Hindi card.
      await waitFor(() => {
        const og = document.head.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
        expect(og?.content).toBe(
          `${window.location.origin}/api/public/p/${HANDLE}/badge/first_birdie/og?lang=hi`,
        );
      });

      // The share-link surface (the URL the user copies / hands off via Web
      // Share) also carries `?lang=hi` so a friend who reshares the link
      // keeps the same language for the next viewer's destination card.
      const shareUrlEl = await screen.findByText(
        `${window.location.origin}/p/${HANDLE}/badge/first_birdie?lang=hi`,
      );
      expect(shareUrlEl).toBeInTheDocument();
    });

    // Task #1764 — the badge title and description themselves (not just the
    // page chrome) must render in the viewer's language. The API returns the
    // localized `badgeLabel` / `badgeDescription` when called with `?lang=hi`;
    // the page renderer surfaces them verbatim, so a Hindi viewer sees the
    // badge name in Devanagari, matching the rasterised OG card a recipient
    // would see if they shared the link onward.
    it("renders the localized badge label and description from the API payload (Hindi)", async () => {
      const payload = buildProfilePayload();
      // Simulate the API response when called with ?lang=hi: badge label and
      // description come back in Devanagari.
      payload.achievements = [{
        badgeType: "first_birdie",
        badgeLabel: "पहला बर्डी",
        badgeIcon: "🐦",
        badgeCategory: "milestone",
        badgeDescription: "अपना पहला बर्डी स्कोर करें",
        earnedAt: EARNED_AT,
      }];
      payload.badgeCatalog = [
        { type: "first_birdie", label: "पहला बर्डी", icon: "🐦", category: "milestone", description: "अपना पहला बर्डी स्कोर करें" },
        { type: "10_rounds", label: "10 राउंड खेले", icon: "🏅", category: "consistency", description: "10 राउंड पूरे करें" },
      ];
      stubFetch(payload);
      renderBadgePage("first_birdie", "?lang=hi");

      await screen.findByTestId("badge-hero");
      // Badge label is the localized Devanagari title — not the English original.
      expect(screen.getByTestId("badge-label")).toHaveTextContent("पहला बर्डी");
      expect(screen.getByTestId("badge-label").textContent ?? "").toMatch(/[\u0900-\u097F]/);

      // og:title and document title should reflect the localized label
      // (the page builds them from the payload it received).
      await waitFor(() => {
        const ogTitle = document.head.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
        expect(ogTitle?.content).toContain("पहला बर्डी");
      });
      expect(document.title).toContain("पहला बर्डी");
    });

    it("renders the localized badge label from the API payload (Arabic)", async () => {
      const payload = buildProfilePayload();
      payload.achievements = [{
        badgeType: "first_birdie",
        badgeLabel: "أول بيردي",
        badgeIcon: "🐦",
        badgeCategory: "milestone",
        badgeDescription: "سجّل أول بيردي لك",
        earnedAt: EARNED_AT,
      }];
      payload.badgeCatalog = [
        { type: "first_birdie", label: "أول بيردي", icon: "🐦", category: "milestone", description: "سجّل أول بيردي لك" },
        { type: "10_rounds", label: "١٠ جولات", icon: "🏅", category: "consistency", description: "أكمل ١٠ جولات" },
      ];
      stubFetch(payload);
      renderBadgePage("first_birdie", "?lang=ar");

      await screen.findByTestId("badge-hero");
      expect(screen.getByTestId("badge-label")).toHaveTextContent("أول بيردي");
      // Arabic block: \u0600-\u06FF
      expect(screen.getByTestId("badge-label").textContent ?? "").toMatch(/[\u0600-\u06FF]/);
    });
  });
});
