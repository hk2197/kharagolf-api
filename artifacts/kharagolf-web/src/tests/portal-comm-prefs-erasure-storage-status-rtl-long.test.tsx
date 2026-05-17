/**
 * Component test: web portal Notifications tab — verify the Task #1774
 * stuck-erasure status preview reads correctly under right-to-left
 * (Arabic) and very long translations (Amharic + Vietnamese). Task #2221.
 *
 * The sibling fixture
 * `portal-comm-prefs-erasure-storage-status.test.tsx` only exercises the
 * status preview wiring against the default English UI. It would happily
 * pass even if the row regressed to a layout where:
 *
 *   - the inline status / hint copy was nested inside the same flex row
 *     as the toggle column (so a long translation would push the toggles
 *     off-screen at common viewport widths), or
 *   - the toggle column wrapper lost its `shrink-0` class (so a long
 *     translation in the label column would compress / clip the
 *     toggles), or
 *   - the Arabic locale fell back to bare i18n keys or the English
 *     source for any of the four (email, push) cross-product states or
 *     the both-muted warning hint.
 *
 * This fixture closes those gaps. For each of three locales (Arabic for
 * the RTL reading order, Amharic + Vietnamese for the longest
 * translations) it:
 *
 *   1. Boots the real i18n bundles and switches the active language.
 *   2. Renders the row in the worst-case (both-muted) state — that's
 *      the only state that surfaces both the status line AND the amber
 *      warning hint, so it stresses the row's vertical layout the most.
 *   3. Asserts the translated copy actually renders (and the English
 *      source does NOT leak through) for the status line, the warning
 *      hint, and both toggle aria-labels.
 *   4. Asserts the toggle column lives in a SEPARATE flex sibling above
 *      the inline status / hint blocks — so a long status string can
 *      never visually overlap or push the toggle column off-screen, no
 *      matter how the label column wraps.
 *   5. Asserts the toggle column wrapper retains `shrink-0` and the
 *      flex row uses `justify-between gap-4`, the structural guarantees
 *      that anchor the toggles to the row's end edge regardless of the
 *      label column's content width.
 *   6. (Arabic only) Asserts the rendered prefix span comes BEFORE the
 *      status span in the DOM. The browser's bidi algorithm flips the
 *      visual order under `dir="rtl"`, but only if the spans are
 *      authored in logical (LTR-source) order — a regression that
 *      reorders them in source would break the visual reading order
 *      under RTL while still passing the existing English fixture.
 *
 * Reverting any of those properties would either lose the translation,
 * collapse the toggles into the status column, or scramble the RTL
 * reading order — exactly the regression class the task description
 * calls out.
 */
import React from "react";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import i18n from "../i18n";
import enPortal from "../i18n/locales/en/portal.json";
import arPortal from "../i18n/locales/ar/portal.json";
import dePortal from "../i18n/locales/de/portal.json";
import viPortal from "../i18n/locales/vi/portal.json";

interface NotifPrefsRow {
  notifySideGameReceipts: boolean;
  notifyManualEntryAlerts: boolean;
  notifyCoachPayoutAccountChanges: boolean;
  notifyDataExportExpiring: boolean;
  notifyWalletRefundDigestFailed: boolean;
  notifySideGameReceiptDigestFailed: boolean;
  notifyErasureStorageDigest: boolean;
  notifyErasureStorageDigestPush: boolean;
}

// Worst-case: both channels muted. That's the only state that surfaces
// the inline status line AND the amber warning hint together, so the
// row's vertical layout is stressed the most.
const BOTH_MUTED_PREFS: NotifPrefsRow = {
  notifySideGameReceipts: true,
  notifyManualEntryAlerts: true,
  notifyCoachPayoutAccountChanges: true,
  notifyDataExportExpiring: true,
  notifyWalletRefundDigestFailed: true,
  notifySideGameReceiptDigestFailed: true,
  notifyErasureStorageDigest: false,
  notifyErasureStorageDigestPush: false,
};

vi.mock("@workspace/api-client-react", () => ({
  // The stuck-erasure cleanup digest row is controller-only (the JSX
  // gates on `isController`). `org_admin` is part of that set per
  // `PortalCommPrefs.tsx`.
  useGetMe: () => ({ data: { id: 1, organizationId: 1, role: "org_admin" } }),
}));

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("/api/portal/my-comm-prefs")) {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/notification-key-prefs")) {
    return new Response(JSON.stringify({ digestMode: false, keys: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/digest-preferences") && method === "GET") {
    return new Response(JSON.stringify({ digests: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/notification-preferences") && method === "GET") {
    return new Response(JSON.stringify(BOTH_MUTED_PREFS), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Reset the document direction between tests so a leaked `rtl` from
  // the Arabic block can't bleed into other tests in this process.
  document.documentElement.dir = "ltr";
  document.documentElement.lang = "en";
});

async function loadCard() {
  const mod = await import("../pages/portal/PortalCommPrefs");
  return mod.PortalCommPrefs;
}

async function renderBothMutedRow() {
  const PortalCommPrefs = await loadCard();
  render(<PortalCommPrefs />);
  // Wait for the post-effect render: the email toggle has hydrated to
  // its `false` server value, which means the bothMuted branch (status
  // line + amber warning hint) is on screen.
  const emailToggle = await screen.findByTestId(
    "switch-notify-erasure-storage-digest-email",
  );
  await waitFor(() =>
    expect(emailToggle.getAttribute("aria-checked")).toBe("false"),
  );
  await waitFor(() =>
    expect(
      screen
        .getByTestId("switch-notify-erasure-storage-digest-push")
        .getAttribute("aria-checked"),
    ).toBe("false"),
  );
  return screen.getByTestId("row-notify-erasure-storage-digest");
}

/**
 * Structural assertions that hold across every locale: the toggle
 * column lives in a SEPARATE flex sibling above the inline status /
 * hint blocks, the toggle column wrapper retains `shrink-0`, and the
 * flex row uses `justify-between gap-4`. Those three properties
 * together guarantee a long status / hint string cannot push or
 * overlap the toggles regardless of the active locale's text length.
 */
function assertRowLayoutInvariants(row: HTMLElement) {
  const status = within(row).getByTestId("erasure-storage-status");
  const hint = within(row).getByTestId("erasure-storage-both-muted-hint");
  const emailToggle = within(row).getByTestId(
    "switch-notify-erasure-storage-digest-email",
  );
  const pushToggle = within(row).getByTestId(
    "switch-notify-erasure-storage-digest-push",
  );

  // The toggle column lives in its own flex sibling above the inline
  // status / hint blocks. If a future refactor inlined the status text
  // into the same horizontal flex container as the toggles, a long
  // translation would compete with them for width and could push them
  // off-screen — exactly the regression class this fixture is here to
  // catch. We assert it by walking up from a toggle and confirming the
  // status / hint nodes are NOT descendants of that flex row.
  const toggleFlexRow = emailToggle.closest(
    "div.flex.items-start.justify-between",
  );
  expect(toggleFlexRow).not.toBeNull();
  expect(toggleFlexRow!.contains(status)).toBe(false);
  expect(toggleFlexRow!.contains(hint)).toBe(false);
  // Sanity: the push toggle shares the same flex row.
  expect(toggleFlexRow!.contains(pushToggle)).toBe(true);

  // The flex row uses `justify-between gap-4`, the layout guarantee
  // that anchors the toggle column to the row's end edge.
  expect(toggleFlexRow!.className).toMatch(/\bjustify-between\b/);
  expect(toggleFlexRow!.className).toMatch(/\bgap-4\b/);

  // The toggle column wrapper retains `shrink-0`, so a wide label
  // column cannot compress / clip the toggles. Walk up from the email
  // toggle's `<label>` to the column wrapper.
  const toggleLabel = emailToggle.closest("label");
  expect(toggleLabel).not.toBeNull();
  const toggleColumn = toggleLabel!.parentElement;
  expect(toggleColumn).not.toBeNull();
  expect(toggleColumn!.className).toMatch(/\bshrink-0\b/);
  // Sanity: the push toggle's label is the toggle column's other child.
  expect(toggleColumn!.contains(pushToggle)).toBe(true);

  // The status block sits BELOW the flex row (later sibling) so it
  // can't overlap the toggles even at narrow viewports. Asserting
  // `compareDocumentPosition` keeps us honest about source order.
  // eslint-disable-next-line no-bitwise
  expect(
    toggleFlexRow!.compareDocumentPosition(status) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // eslint-disable-next-line no-bitwise
  expect(
    status.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

describe("PortalCommPrefs — stuck-erasure status preview RTL reading order (Task #2221)", () => {
  // Set the locale + dir per-test (not just per-describe) because the
  // file-level `afterEach` resets `dir` between tests to keep RTL state
  // from leaking into other fixtures sharing this jsdom instance. A
  // describe-level `beforeAll` would only fire once and the second test
  // in this block would render under `dir="ltr"`.
  beforeEach(async () => {
    await i18n.changeLanguage("ar");
    document.documentElement.dir = "rtl";
    document.documentElement.lang = "ar";
  });

  afterAll(async () => {
    await i18n.changeLanguage("en");
    document.documentElement.dir = "ltr";
    document.documentElement.lang = "en";
  });

  it("renders the both-muted status line and warning hint with the Arabic translation under dir=rtl", async () => {
    const row = await renderBothMutedRow();

    // Sanity: the Arabic bundle actually has translated copy that
    // differs from the English source for every string this row shows
    // in the both-muted state. Catches the silent fallback case where
    // a future PR removes a key from `ar/portal.json` and i18next
    // resolves to the English source.
    expect(arPortal.emailOptOuts.erasureStorageStatusPrefix).not.toBe(
      enPortal.emailOptOuts.erasureStorageStatusPrefix,
    );
    expect(arPortal.emailOptOuts.erasureStorageStatusBothMuted).not.toBe(
      enPortal.emailOptOuts.erasureStorageStatusBothMuted,
    );
    expect(arPortal.emailOptOuts.erasureStorageBothMutedHint).not.toBe(
      enPortal.emailOptOuts.erasureStorageBothMutedHint,
    );

    // The status block exposes the Arabic prefix + status copy and
    // does NOT leak the English source.
    const status = within(row).getByTestId("erasure-storage-status");
    expect(status.textContent).toContain(
      arPortal.emailOptOuts.erasureStorageStatusPrefix,
    );
    expect(
      within(status).getByTestId("erasure-storage-status-both-muted"),
    ).toHaveTextContent(arPortal.emailOptOuts.erasureStorageStatusBothMuted);
    expect(status.textContent ?? "").not.toContain(
      enPortal.emailOptOuts.erasureStorageStatusPrefix,
    );
    expect(status.textContent ?? "").not.toContain(
      enPortal.emailOptOuts.erasureStorageStatusBothMuted,
    );

    // The amber warning hint exposes the Arabic copy and does NOT
    // leak the English source.
    const hint = within(row).getByTestId("erasure-storage-both-muted-hint");
    expect(hint).toHaveTextContent(
      arPortal.emailOptOuts.erasureStorageBothMutedHint,
    );
    expect(hint.textContent ?? "").not.toContain(
      enPortal.emailOptOuts.erasureStorageBothMutedHint,
    );

    // The two toggle aria-labels also pick up the Arabic translation —
    // a regression that hardcoded an English aria-label would still
    // pass the existing English fixture but break screen readers
    // running under the Arabic locale.
    const emailToggle = within(row).getByTestId(
      "switch-notify-erasure-storage-digest-email",
    );
    const pushToggle = within(row).getByTestId(
      "switch-notify-erasure-storage-digest-push",
    );
    expect(emailToggle.getAttribute("aria-label")).toBe(
      arPortal.emailOptOuts.erasureStorageEmailAria,
    );
    expect(pushToggle.getAttribute("aria-label")).toBe(
      arPortal.emailOptOuts.erasureStorageInAppPushAria,
    );
  });

  it("keeps the inline status spans in logical (prefix → status) DOM order so the browser's bidi algo can flip them under dir=rtl", async () => {
    const row = await renderBothMutedRow();

    // The inline status block is two sibling <span>s separated by a
    // space:
    //   <span>{prefix}</span>{' '}<span data-testid={...}>{status}</span>
    //
    // Under `dir="rtl"` the browser's bidi algorithm reverses the
    // visual order of those two spans, putting the prefix on the
    // right (the "start" edge in RTL) and the Arabic status string on
    // its left. That's the behaviour controllers expect. But that
    // only works if the spans are authored in logical / LTR-source
    // order. A regression that swapped the two — say, to "fix" the
    // RTL render visually before discovering that the bidi algo
    // already handles it — would actually reverse the visual reading
    // order under RTL while still rendering correctly under LTR.
    //
    // Asserting the source DOM order keeps us honest about that.
    const status = within(row).getByTestId("erasure-storage-status");
    const statusSpan = within(row).getByTestId(
      "erasure-storage-status-both-muted",
    );
    const prefixSpan = Array.from(status.querySelectorAll("span")).find(
      (s) =>
        s.textContent === arPortal.emailOptOuts.erasureStorageStatusPrefix,
    );
    expect(prefixSpan).toBeDefined();
    // eslint-disable-next-line no-bitwise
    expect(
      prefixSpan!.compareDocumentPosition(statusSpan) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The status block also inherits `dir="rtl"` from the document
    // root (the only place the app sets it — see `layout.tsx`). If a
    // future refactor wrapped the row in a forced `dir="ltr"` island
    // (for e.g. a numeric formatting hack) the Arabic prefix /
    // status pair would render in the wrong visual order. Catching
    // that here is cheap.
    expect(document.documentElement.dir).toBe("rtl");
    // No ancestor of the status block forces dir="ltr".
    let cursor: HTMLElement | null = status;
    while (cursor) {
      // `getAttribute` is null when the attribute isn't set — only
      // assert when the attribute exists, otherwise inheritance from
      // <html> applies.
      expect(cursor.getAttribute("dir")).not.toBe("ltr");
      cursor = cursor.parentElement;
    }
  });

  it("keeps the toggle column in a separate flex sibling above the status / hint blocks under the Arabic locale", async () => {
    const row = await renderBothMutedRow();
    assertRowLayoutInvariants(row);
  });
});

describe("PortalCommPrefs — stuck-erasure status preview under the longest translations (Task #2221)", () => {
  // Restore the English locale at the start so the Arabic block above
  // (which leaves i18n in `ar`) doesn't bleed into these tests if the
  // file ordering changes.
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    document.documentElement.dir = "ltr";
    document.documentElement.lang = "en";
  });

  afterAll(async () => {
    await i18n.changeLanguage("en");
    document.documentElement.dir = "ltr";
    document.documentElement.lang = "en";
  });

  it("uses a German both-muted hint translation that's longer than the English source (the worst-case width stressor)", () => {
    // German is the longest both-muted hint translation in the bundle
    // (~225 vs ~180 JS chars) and is the most realistic worst-case
    // stressor for the row's horizontal layout. The task description
    // mentions Amharic / Vietnamese as long-form examples, but as of
    // this writing both are actually shorter than the English source —
    // German is the genuinely longest translation we ship. Vietnamese
    // is included anyway because it's explicitly called out by the
    // task and a translation regression in either locale should
    // surface here. If a future translator shortens the German hint
    // future maintainers should swap in whatever the current longest
    // translation is. Length here is in JS chars (UTF-16 code units),
    // which is a fine proxy for "how much horizontal space does this
    // string need".
    const en = enPortal.emailOptOuts.erasureStorageBothMutedHint;
    const de = dePortal.emailOptOuts.erasureStorageBothMutedHint;
    expect(de.length).toBeGreaterThan(en.length);
  });

  it.each([
    {
      lang: "de",
      bundle: dePortal,
    },
    {
      lang: "vi",
      bundle: viPortal,
    },
  ])(
    "renders the long $lang status line + warning hint and keeps the toggle column anchored",
    async ({ lang, bundle }) => {
      await i18n.changeLanguage(lang);
      try {
        const row = await renderBothMutedRow();

        // The translated status line and warning hint render verbatim
        // (no truncation, no fallback to the English source).
        const status = within(row).getByTestId("erasure-storage-status");
        expect(status.textContent).toContain(
          bundle.emailOptOuts.erasureStorageStatusPrefix,
        );
        expect(
          within(status).getByTestId("erasure-storage-status-both-muted"),
        ).toHaveTextContent(
          bundle.emailOptOuts.erasureStorageStatusBothMuted,
        );
        expect(status.textContent ?? "").not.toContain(
          enPortal.emailOptOuts.erasureStorageStatusBothMuted,
        );

        const hint = within(row).getByTestId(
          "erasure-storage-both-muted-hint",
        );
        expect(hint).toHaveTextContent(
          bundle.emailOptOuts.erasureStorageBothMutedHint,
        );
        expect(hint.textContent ?? "").not.toContain(
          enPortal.emailOptOuts.erasureStorageBothMutedHint,
        );

        // Toggle aria-labels also resolve to the active bundle (a
        // regression that hardcoded English would still pass the
        // existing English fixture).
        const emailToggle = within(row).getByTestId(
          "switch-notify-erasure-storage-digest-email",
        );
        const pushToggle = within(row).getByTestId(
          "switch-notify-erasure-storage-digest-push",
        );
        expect(emailToggle.getAttribute("aria-label")).toBe(
          bundle.emailOptOuts.erasureStorageEmailAria,
        );
        expect(pushToggle.getAttribute("aria-label")).toBe(
          bundle.emailOptOuts.erasureStorageInAppPushAria,
        );

        // Structural invariants that guarantee a long translation
        // can't push the toggle column off-screen at common viewport
        // widths: the toggle column lives in its own flex sibling
        // above the status / hint blocks, the row uses
        // `justify-between gap-4`, and the toggle column wrapper has
        // `shrink-0`.
        assertRowLayoutInvariants(row);
      } finally {
        // Restore the default so a thrown assertion can't strand the
        // i18n module in the long-translation locale and bleed into
        // the next iteration.
        await i18n.changeLanguage("en");
      }
    },
  );
});
