/**
 * Task #1184 — Component coverage for the producer-facing "Compare reels"
 * modal that ships alongside the new Top performing / Most re-shared sort.
 *
 * The companion API integration test
 *   artifacts/api-server/src/tests/highlights-sort.test.ts
 * locks down the server's sort= contract. This test verifies the *client
 * wiring* that previously had no automated coverage:
 *
 *   1. The "Compare reels" toolbar entry-point appears once reels are
 *      loaded, and clicking it switches the gallery into compare-mode.
 *   2. A producer can pick exactly 2 (the minimum) reels, hit Compare,
 *      and the modal opens with one column per selected reel.
 *   3. A producer can pick 3 reels (the documented maximum) and the
 *      modal still opens with all three side-by-side.
 *   4. The reel with the highest TOTAL engagement
 *      (view + feed_share + share + download) is the *only* one wearing
 *      the gold "Top" badge — never the runner-up, never two reels at
 *      once even when one is newer / has fewer downloads.
 *   5. Selecting a 4th reel is silently rejected (the producer is
 *      capped at 3) — guarding the modal's grid layout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

// Task #1650 — initialise the real i18n module so the compare modal's
// translated copy (Gap to {{winner}}, Views, Feed shares, …) renders in
// the assertion-language rather than as raw t-keys. The default lng is
// English so existing assertions ("tied", "Winner", numeric diffs) keep
// matching exactly as before.
import i18n from "@/i18n";
import PortalHighlightsPage from "../highlights";

interface ReelOverrides {
  id: number;
  title?: string;
  downloadCount?: number;
  shareCount?: number;
  viewCount?: number;
  feedShareCount?: number;
}

function makeReel({
  id,
  title = `Reel ${id}`,
  downloadCount = 0,
  shareCount = 0,
  viewCount = 0,
  feedShareCount = 0,
}: ReelOverrides) {
  return {
    id,
    title,
    templateId: "classic",
    status: "ready",
    outputUrl: `/objects/reels/${id}.mp4`,
    thumbnailUrl: null,
    errorMessage: null,
    createdAt: new Date(Date.now() - id * 60 * 1000).toISOString(),
    durationSeconds: 30,
    tournamentId: null,
    feedPostId: null,
    options: {},
    attempts: 1,
    maxAttempts: 3,
    downloadCount,
    shareCount,
    viewCount,
    feedShareCount,
    bestHour: null,
  };
}

function installFetch(reels: ReturnType<typeof makeReel>[]) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/portal/highlights/templates")) {
      return new Response(JSON.stringify({ templates: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/api/portal/my-tournaments")) {
      return new Response(JSON.stringify({ tournaments: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/api/portal/highlights") && method === "GET" && !url.includes("/templates")) {
      return new Response(JSON.stringify({
        reels,
        quota: { monthlyLimit: 9999, usedThisMonth: 0, remaining: 9999 },
        sort: "recent",
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  toastMock.mockReset();
  // Reset to English so the language-agnostic assertions below (which
  // look for "tied", "Top", interpolated reel titles, …) keep passing
  // even after the non-English smoke test has flipped the language.
  void i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Task #1184 — side-by-side compare modal", () => {
  it("the compare-mode entry button is rendered once reels load", async () => {
    installFetch([
      makeReel({ id: 1, viewCount: 5 }),
      makeReel({ id: 2, viewCount: 3 }),
    ]);
    render(<PortalHighlightsPage />);

    // Wait for the toolbar to mount alongside the first card.
    expect(await screen.findByTestId("btn-start-compare")).toBeInTheDocument();
    // The Compare-action button is hidden until compare-mode is on.
    expect(screen.queryByTestId("btn-open-compare")).toBeNull();
  });

  it("opens the compare modal with two side-by-side columns and labels the higher-engagement reel as Top", async () => {
    // reel #1: total = 1+1+1+1 = 4
    // reel #2: total = 10 + 0 + 0 + 0 = 10  ← highest, must wear "Top"
    // reel #3: total = 0 + 5 + 0 + 0 = 5
    installFetch([
      makeReel({ id: 1, title: "Mixed",     viewCount: 1, feedShareCount: 1, shareCount: 1, downloadCount: 1 }),
      makeReel({ id: 2, title: "Feed Star", feedShareCount: 10 }),
      makeReel({ id: 3, title: "Sharer",    shareCount: 5 }),
    ]);
    render(<PortalHighlightsPage />);

    fireEvent.click(await screen.findByTestId("btn-start-compare"));

    fireEvent.click(await screen.findByTestId("btn-compare-toggle-1"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-2"));
    expect(screen.getByTestId("compare-count").textContent).toMatch(/^2 of 3 selected$/);

    // The Compare button is now enabled; click it to open the modal.
    const openBtn = screen.getByTestId("btn-open-compare") as HTMLButtonElement;
    expect(openBtn.disabled).toBe(false);
    fireEvent.click(openBtn);

    const modal = await screen.findByTestId("compare-modal");
    // Both selected reels are rendered as columns.
    expect(within(modal).getByTestId("compare-col-1")).toBeInTheDocument();
    expect(within(modal).getByTestId("compare-col-2")).toBeInTheDocument();
    // The unselected reel does NOT leak in.
    expect(within(modal).queryByTestId("compare-col-3")).toBeNull();

    // Reel #2 has the higher total → only #2 wears the gold "Top" badge.
    expect(within(modal).getByTestId("compare-winner-2")).toBeInTheDocument();
    expect(within(modal).queryByTestId("compare-winner-1")).toBeNull();
    // The badge label itself reads "Top" (case-insensitive guard against
    // copy churn — keeps the test honest if a marketer rewords it).
    expect(within(modal).getByTestId("compare-winner-2").textContent).toMatch(/top/i);

    // Per-column totals match what the API surfaced (4 vs 10).
    expect(within(modal).getByTestId("compare-total-1").textContent).toMatch(/\b4\b/);
    expect(within(modal).getByTestId("compare-total-2").textContent).toMatch(/\b10\b/);
  });

  it("supports the documented maximum of 3 reels and still labels exactly one as Top", async () => {
    // reel #11 wins on total = 7+5+0+0 = 12, even though #12 has more
    // raw views and #13 has more downloads — it's the *sum* that
    // determines the badge.
    installFetch([
      makeReel({ id: 11, title: "Winner",  viewCount: 7,  feedShareCount: 5 }),               // total 12
      makeReel({ id: 12, title: "Viewer",  viewCount: 9 }),                                   // total 9
      makeReel({ id: 13, title: "Saver",   downloadCount: 8 }),                               // total 8
    ]);
    render(<PortalHighlightsPage />);

    fireEvent.click(await screen.findByTestId("btn-start-compare"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-11"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-12"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-13"));
    expect(screen.getByTestId("compare-count").textContent).toMatch(/^3 of 3 selected$/);

    fireEvent.click(screen.getByTestId("btn-open-compare"));
    const modal = await screen.findByTestId("compare-modal");

    // All three columns render side-by-side.
    expect(within(modal).getByTestId("compare-col-11")).toBeInTheDocument();
    expect(within(modal).getByTestId("compare-col-12")).toBeInTheDocument();
    expect(within(modal).getByTestId("compare-col-13")).toBeInTheDocument();

    // Exactly one Top badge — the one on the reel with the highest total.
    expect(within(modal).getByTestId("compare-winner-11")).toBeInTheDocument();
    expect(within(modal).queryByTestId("compare-winner-12")).toBeNull();
    expect(within(modal).queryByTestId("compare-winner-13")).toBeNull();
  });

  it("shows the per-metric and total engagement gap to the Top reel for every non-winning column", async () => {
    // Task #1376 — producers used to mentally subtract totals to see how
    // much the "Top" reel was beating the others. Each non-winning column
    // must now show a gap row per metric (views / feed shares / shares /
    // downloads) and a total gap, so the head-to-head is decision-ready.
    //
    //   Winner  (id 31) : v=10  fs=4  sh=2  dl=1   → total 17
    //   Sharer  (id 32) : v= 4  fs=4  sh=5  dl=0   → total 13   (gap −4)
    //   Quiet   (id 33) : v= 3  fs=1  sh=0  dl=1   → total  5   (gap −12)
    installFetch([
      makeReel({ id: 31, title: "Winner", viewCount: 10, feedShareCount: 4, shareCount: 2, downloadCount: 1 }),
      makeReel({ id: 32, title: "Sharer", viewCount: 4,  feedShareCount: 4, shareCount: 5, downloadCount: 0 }),
      makeReel({ id: 33, title: "Quiet",  viewCount: 3,  feedShareCount: 1, shareCount: 0, downloadCount: 1 }),
    ]);
    render(<PortalHighlightsPage />);

    fireEvent.click(await screen.findByTestId("btn-start-compare"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-31"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-32"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-33"));
    fireEvent.click(screen.getByTestId("btn-open-compare"));

    const modal = await screen.findByTestId("compare-modal");

    // The winning column does NOT render a gap block — there's nothing to
    // catch up to. Only the runners-up surface a gap section.
    expect(within(modal).queryByTestId("compare-gap-31")).toBeNull();
    expect(within(modal).getByTestId("compare-gap-32")).toBeInTheDocument();
    expect(within(modal).getByTestId("compare-gap-33")).toBeInTheDocument();

    // "Sharer" is tied with the winner on feed shares (both 4) but loses
    // on views (−6), wins on shares (+3), ties on downloads in the
    // negative direction (−1), and trails by 4 on total.
    expect(within(modal).getByTestId("compare-gap-32-views").textContent).toMatch(/-6/);
    expect(within(modal).getByTestId("compare-gap-32-feedShares").textContent).toMatch(/tied/i);
    expect(within(modal).getByTestId("compare-gap-32-shares").textContent).toMatch(/\+3/);
    expect(within(modal).getByTestId("compare-gap-32-downloads").textContent).toMatch(/-1/);
    expect(within(modal).getByTestId("compare-gap-32-total").textContent).toMatch(/-4/);

    // "Quiet" trails on every metric and on the total.
    expect(within(modal).getByTestId("compare-gap-33-views").textContent).toMatch(/-7/);
    expect(within(modal).getByTestId("compare-gap-33-feedShares").textContent).toMatch(/-3/);
    expect(within(modal).getByTestId("compare-gap-33-shares").textContent).toMatch(/-2/);
    expect(within(modal).getByTestId("compare-gap-33-downloads").textContent).toMatch(/tied/i);
    expect(within(modal).getByTestId("compare-gap-33-total").textContent).toMatch(/-12/);

    // Each non-winning gap block names the reel it is being compared
    // against so producers know who set the bar.
    expect(within(modal).getByTestId("compare-gap-32").textContent).toMatch(/Winner/);
    expect(within(modal).getByTestId("compare-gap-33").textContent).toMatch(/Winner/);
  });

  it("renders columns sorted by total engagement (highest first), with ties falling back to selection order", async () => {
    // Task #1649 — producers complained that the "Top" reel could land in
    // the middle or right column, forcing the eye to hunt for the gap
    // reference. Columns must now sort by total engagement DESC so the
    // Top reel is always leftmost and the modal reads as a clean ladder.
    //
    //   id 41 "Mid"     v=3 fs=2 sh=0 dl=0 → total  5
    //   id 42 "Top"     v=8 fs=4 sh=2 dl=1 → total 15  ← highest, must be leftmost
    //   id 43 "TieA"    v=2 fs=0 sh=0 dl=0 → total  2  ─┐ same total as
    //   id 44 "TieB"    v=0 fs=0 sh=2 dl=0 → total  2  ─┘ TieA → selection order wins
    //
    // We deliberately tick them in a NON-engagement order so we can prove
    // the sort actually fired. Selection order: 41 → 43 → 42. Expected
    // column order in the DOM: 42 ("Top"), 41, 43.
    installFetch([
      makeReel({ id: 41, title: "Mid", viewCount: 3, feedShareCount: 2 }),
      makeReel({ id: 42, title: "Top", viewCount: 8, feedShareCount: 4, shareCount: 2, downloadCount: 1 }),
      makeReel({ id: 43, title: "TieA", viewCount: 2 }),
      makeReel({ id: 44, title: "TieB", shareCount: 2 }),
    ]);
    render(<PortalHighlightsPage />);

    fireEvent.click(await screen.findByTestId("btn-start-compare"));
    // Tick in non-engagement order to prove the sort actually runs.
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-41"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-43"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-42"));
    fireEvent.click(screen.getByTestId("btn-open-compare"));

    const modal = await screen.findByTestId("compare-modal");
    const columnIds = within(modal)
      .getAllByTestId(/^compare-col-\d+$/)
      .map(el => el.getAttribute("data-testid"));
    // Highest engagement (Top, total 15) is leftmost; mid (5) next; runner-up (2) last.
    expect(columnIds).toEqual([
      "compare-col-42",
      "compare-col-41",
      "compare-col-43",
    ]);
    // Sanity: the leftmost column is also the one wearing the "Top" badge.
    expect(within(modal).getByTestId("compare-winner-42")).toBeInTheDocument();

    // ── Tie-break case: pick TieB first, then TieA. Both have total 2,
    // so stable sort must keep the selection order: TieB before TieA.
    cleanup();
    installFetch([
      makeReel({ id: 43, title: "TieA", viewCount: 2 }),
      makeReel({ id: 44, title: "TieB", shareCount: 2 }),
    ]);
    render(<PortalHighlightsPage />);
    fireEvent.click(await screen.findByTestId("btn-start-compare"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-44"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-43"));
    fireEvent.click(screen.getByTestId("btn-open-compare"));

    const tieModal = await screen.findByTestId("compare-modal");
    const tieIds = within(tieModal)
      .getAllByTestId(/^compare-col-\d+$/)
      .map(el => el.getAttribute("data-testid"));
    expect(tieIds).toEqual(["compare-col-44", "compare-col-43"]);
  });

  it("caps selection at 3 reels and shows a toast when a 4th is attempted", async () => {
    installFetch([
      makeReel({ id: 21, viewCount: 1 }),
      makeReel({ id: 22, viewCount: 2 }),
      makeReel({ id: 23, viewCount: 3 }),
      makeReel({ id: 24, viewCount: 4 }),
    ]);
    render(<PortalHighlightsPage />);

    fireEvent.click(await screen.findByTestId("btn-start-compare"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-21"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-22"));
    fireEvent.click(await screen.findByTestId("btn-compare-toggle-23"));
    expect(screen.getByTestId("compare-count").textContent).toMatch(/^3 of 3 selected$/);

    // Attempt to add a 4th reel — the click must no-op and surface a toast.
    fireEvent.click(screen.getByTestId("btn-compare-toggle-24"));
    expect(screen.getByTestId("compare-count").textContent).toMatch(/^3 of 3 selected$/);
    await waitFor(() => expect(toastMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("btn-open-compare"));
    const modal = await screen.findByTestId("compare-modal");
    // The 4th reel never made it into the modal.
    expect(within(modal).queryByTestId("compare-col-24")).toBeNull();
  });
});

/**
 * Task #1650 / #2052 — every locale shipped under `src/i18n/locales/<lang>` must
 * supply a translated `compareModal.*` block, otherwise non-English
 * producers see English fragments inside an otherwise-localised modal.
 *
 * The smoke test below loops over every supported language, switches
 * i18n to it, opens the compare modal with two reels, and asserts that
 *   - each individual gap label cell (looked up by its per-metric
 *     `data-testid`, never by scanning concatenated text) contains the
 *     locale's translated copy and not the English source string;
 *   - the modal's surrounding chrome (title, "Top" badge, the
 *     "Total engagement:" footer label, and the footer "Close" button)
 *     is also routed through the translated `compareModal.*` keys —
 *     i.e. no fragment of the modal still reads as the English source
 *     once the locale is switched.
 *
 * The reel TITLES come from the test fixture and are intentionally
 * non-English Unicode so we can tell apart "Gap to {{winner}}
 * interpolated correctly" from "the gapTo key fell back to English".
 */
import { SUPPORTED_LANGUAGES } from "@/i18n";

describe("Task #1650 — gap-section copy is fully localised", () => {
  // English is the source language; nothing to verify there.
  const nonEnglish = SUPPORTED_LANGUAGES.filter((l) => l.code !== "en");

  for (const lang of nonEnglish) {
    it(`renders the gap block in ${lang.code} (${lang.name}) with no English fragments`, async () => {
      installFetch([
        // Use Unicode-only titles so the "Gap to {{winner}}" interpolation
        // is unambiguously verifiable: if the locale's gapTo template
        // ever falls back to English, the rendered text would contain
        // "Gap to" verbatim and the assertion below would catch it.
        // Tied on feedShares (both 4) so we exercise the locale's
        // "tied" key on the feedShares row; the totals row falls back
        // to a numeric diff so it does not collide with the "tied"
        // assertions.
        makeReel({ id: 41, title: "★Top★",   viewCount: 10, feedShareCount: 4, shareCount: 2, downloadCount: 1 }),
        makeReel({ id: 42, title: "★Other★", viewCount: 4,  feedShareCount: 4, shareCount: 5, downloadCount: 0 }),
      ]);

      await i18n.changeLanguage(lang.code);

      render(<PortalHighlightsPage />);

      fireEvent.click(await screen.findByTestId("btn-start-compare"));
      fireEvent.click(await screen.findByTestId("btn-compare-toggle-41"));
      fireEvent.click(await screen.findByTestId("btn-compare-toggle-42"));
      fireEvent.click(screen.getByTestId("btn-open-compare"));

      const gap = await screen.findByTestId("compare-gap-42");

      // ── 1. The gapTo header must use the locale's translated template
      //       AND interpolate the winner reel title into it. We assert
      //       on textContent for the gap container instead of `toHaveTextContent`
      //       because the heading is a sibling node, but we look for
      //       both signals (the title and the absence of "Gap to").
      const headerText = (gap.querySelector("p")?.textContent ?? "");
      expect(headerText).toContain("★Top★");
      expect(headerText.toLowerCase()).not.toContain("gap to");

      // ── 2. Each per-metric label cell must hold the localised label.
      //       We look up the cell's <span> with the muted-foreground
      //       class — that's the label half of the row, the diff/tied
      //       half is the second span. Pulling the label cell directly
      //       avoids any concatenation pitfalls with diff numbers.
      const expectedLabels: Record<'views' | 'feedShares' | 'shares' | 'downloads' | 'total', string> = {
        views:      i18n.t('portal:compareModal.views'),
        feedShares: i18n.t('portal:compareModal.feedShares'),
        shares:     i18n.t('portal:compareModal.shares'),
        downloads:  i18n.t('portal:compareModal.downloads'),
        total:      i18n.t('portal:compareModal.total'),
      };
      const englishSources: Record<string, string> = {
        views:      'Views',
        feedShares: 'Feed shares',
        shares:     'Shares',
        downloads:  'Downloads',
        total:      'Total',
      };

      for (const key of ['views', 'feedShares', 'shares', 'downloads', 'total'] as const) {
        const row = within(gap).getByTestId(`compare-gap-42-${key}`);
        const labelCell = row.querySelector('span:first-child');
        expect(labelCell, `compare-gap-42-${key} is missing a label cell`).not.toBeNull();
        const cellText = labelCell!.textContent ?? '';

        // The label cell must equal the translated label exactly —
        // i.e. neither empty (key fallback) nor the English source.
        expect(cellText).toBe(expectedLabels[key]);
        // Defence in depth: also confirm the English source word is
        // NOT what we just rendered. (The exact-equality check above
        // already implies this for any non-English locale, but the
        // explicit assertion makes the intent unmistakable.)
        if (expectedLabels[key] !== englishSources[key]) {
          expect(cellText.toLowerCase()).not.toBe(englishSources[key].toLowerCase());
        }
      }

      // ── 3. The feedShares row is tied on both reels (4 vs 4) — the
      //       diff cell must render the locale's "tied" word, not the
      //       English "tied" (unless they happen to coincide, which
      //       no locale we ship currently does for this string).
      const expectedTied = i18n.t('portal:compareModal.tied');
      const tiedRow = within(gap).getByTestId('compare-gap-42-feedShares');
      const tiedCell = tiedRow.querySelectorAll('span')[1];
      expect(tiedCell?.textContent ?? '').toBe(expectedTied);
      if (expectedTied !== 'tied') {
        expect((tiedCell?.textContent ?? '').toLowerCase()).not.toBe('tied');
      }

      // ── 4. Task #2052 — the rest of the modal chrome (title, "Top"
      //       badge, the "Total engagement:" footer label, and the
      //       footer "Close" button) must also use the locale's
      //       translated copy. We assert each piece by its testid /
      //       role so we never depend on substring scanning of the
      //       whole modal.
      const modal = await screen.findByTestId('compare-modal');

      // 4a. Dialog title — looked up by role so we get the actual
      //     <h2> element ShadCN renders for DialogTitle.
      const expectedTitle = i18n.t('portal:compareModal.title');
      const titleEl = within(modal).getByRole('heading');
      expect(titleEl.textContent ?? '').toBe(expectedTitle);
      if (expectedTitle !== 'Compare reels') {
        expect((titleEl.textContent ?? '').toLowerCase()).not.toContain('compare reels');
      }

      // 4b. "Top" badge — the winning column wears it; #41 is the
      //     winner in this fixture (total 17 vs 13).
      const expectedTop = i18n.t('portal:compareModal.top');
      const topBadge = within(modal).getByTestId('compare-winner-41');
      // The badge also contains the trophy <svg> icon, so we check
      // that the localised word appears inside it.
      expect(topBadge.textContent ?? '').toContain(expectedTop);
      if (expectedTop !== 'Top') {
        // Defence in depth: the English source word must NOT appear
        // anywhere inside the localised badge for non-English locales.
        expect((topBadge.textContent ?? '').toLowerCase()).not.toContain('top');
      }

      // 4c. "Total engagement:" footer label — every column gets one;
      //     we check the non-winning column (#42) so the assertion
      //     also exercises a column with a gap section sitting under
      //     the total. The numeric total is rendered inside its own
      //     <span>, so we read the leading text node directly to
      //     compare against the localised label.
      const expectedTotalLabel = i18n.t('portal:compareModal.totalEngagementLabel');
      const totalEl = within(modal).getByTestId('compare-total-42');
      // First child node is the label text; the bolded number is the
      // following <span>. Trim trailing whitespace introduced by JSX.
      const totalLabelText = (totalEl.firstChild?.textContent ?? '').trim();
      expect(totalLabelText).toBe(expectedTotalLabel);
      if (expectedTotalLabel !== 'Total engagement:') {
        expect(totalLabelText.toLowerCase()).not.toContain('total engagement');
      }
      // The numeric total (13 = 4+4+5+0) is still rendered alongside
      // the localised label — guard against accidental loss of the
      // value when refactoring the markup.
      expect(totalEl.textContent ?? '').toMatch(/\b13\b/);

      // 4d. Footer "Close" button. ShadCN's DialogContent injects its
      //     own hidden top-right "X" icon button with an sr-only
      //     "Close" label that we cannot (and should not) translate —
      //     it is a library-managed a11y affordance. So instead of
      //     asserting on the absence of an English "Close" anywhere
      //     in the modal, we look up our footer button specifically
      //     by its DialogFooter ancestor and assert the visible label
      //     comes from the locale.
      const expectedClose = i18n.t('portal:compareModal.close');
      const closeBtn = within(modal).getByRole('button', { name: expectedClose });
      expect(closeBtn).toBeInTheDocument();
      // The footer button must carry our localised text — not a
      // residual English "Close" — even when the locale has its own
      // word for it. Read textContent (rather than the accessible
      // name) so we are guarded against the icon-button's sr-only
      // label sneaking into the comparison.
      expect((closeBtn.textContent ?? '').trim()).toBe(expectedClose);

      // 4e. Empty-state copy. To force the empty-state branch we
      //     deselect one of the two reels while the modal is still
      //     open: compareReels drops below 2 and the dialog re-renders
      //     with the empty-state paragraph instead of the column grid.
      //     The toggle buttons live behind the modal in the gallery
      //     but are still reachable via testid in jsdom.
      const expectedEmpty = i18n.t('portal:compareModal.empty');
      fireEvent.click(screen.getByTestId('btn-compare-toggle-41'));
      const reopenedModal = await screen.findByTestId('compare-modal');
      // The column grid is gone; only the empty-state <p> remains.
      expect(within(reopenedModal).queryByTestId('compare-col-41')).toBeNull();
      expect(within(reopenedModal).queryByTestId('compare-col-42')).toBeNull();
      expect(reopenedModal.textContent ?? '').toContain(expectedEmpty);
      if (expectedEmpty !== 'Pick at least two reels to compare.') {
        expect((reopenedModal.textContent ?? '').toLowerCase()).not.toContain('pick at least');
      }
    });
  }
});
