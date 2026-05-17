/**
 * Component test: mobile member-facing per-event email opt-out
 * i18n coverage (Task #2158).
 *
 * Mirrors the web portal regression fixture
 * `artifacts/kharagolf-web/src/tests/portal-comm-prefs-email-opt-out-i18n.test.tsx`
 * (Task #1743) on the React Native side. The other tests in
 * `CommunicationsScreen.test.tsx` only assert via `testID` against the
 * default English UI, so a future PR that re-hardcodes any of the
 * per-event opt-out strings directly in JSX (instead of going through
 * `t('commPrefs.emailOptOuts.*')`) would still pass every existing
 * mobile test even though the row would no longer translate.
 *
 * This fixture closes that gap. It boots the shared i18n instance with
 * the Hindi `profile` bundle, switches the active language to Hindi,
 * renders `CommunicationsScreen`, and asserts for every per-event
 * opt-out row that:
 *
 *   1. The row's label and description render the Hindi translation
 *      sourced from `i18n/locales/hi/profile.json`.
 *   2. The English source from `i18n/locales/en/profile.json` does NOT
 *      appear on screen for that row.
 *
 * Reverting any label to a literal English string would re-introduce
 * the English copy under the Hindi locale and trip both assertions.
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
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "i18next";

import enProfile from "@/i18n/locales/en/profile.json";
import hiProfile from "@/i18n/locales/hi/profile.json";

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/constants/colors", () => ({
  default: {
    primary: "#0a0",
    background: "#000",
    surface: "#111",
    border: "#222",
    tabIconDefault: "#888",
  },
}));

vi.mock("../app/my-360/_shared", async () => {
  const actual = await vi.importActual<typeof import("../app/my-360/_shared")>(
    "../app/my-360/_shared",
  );
  return {
    ...actual,
    useActingMemberId: () => [null, () => {}],
    actingQs: () => "",
  };
});

import CommunicationsScreen from "../app/my-360/communications";

// Stub all three endpoints the screen GETs at mount with happy-path
// payloads that hydrate every per-event opt-out row's controlled
// switch (`true` defaults so the toggles render their settled state
// instead of the loading spinner). We don't care about the toggle
// wiring here — that's exhaustively covered by `CommunicationsScreen.test.tsx`
// — only that the rendered label/description text comes from the
// active locale bundle.
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("/api/portal/notification-key-prefs") && method === "GET") {
    return new Response(JSON.stringify({ digestMode: false, keys: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/notification-preferences") && method === "GET") {
    return new Response(
      JSON.stringify({
        notifySideGameReceipts: true,
        notifyDataExportExpiring: true,
        notifyManualEntryAlerts: true,
        notifyCoachPayoutAccountChanges: true,
        notifyAdminPayoutReverify: true,
        notifyErasureStorageDigest: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  if (url.includes("/api/portal/my-comm-prefs") && method === "GET") {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

// Add the Hindi `profile` resources to the shared i18n instance the
// `__tests__/setup.ts` bootstrap built (it only registers `en` by
// default). `addResourceBundle` with `deep + overwrite = true` is
// idempotent so re-running the suite locally is safe.
beforeAll(async () => {
  i18n.addResourceBundle(
    "hi",
    "profile",
    hiProfile,
    /* deep */ true,
    /* overwrite */ true,
  );
  await i18n.changeLanguage("hi");
});

afterAll(async () => {
  // Restore the default so we don't leak Hindi state into other test
  // files that share this worker's i18n module instance.
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The opt-out rows visible to a logged-in member on the mobile
// `my-360/communications` screen. The mobile screen does not gate any
// of these rows on role (matching how the rest of this screen renders
// the controller-flavoured rows for everyone — see the comment in
// `communications.tsx` next to the erasure-storage-digest row). For
// rows that have an explicit `testID` on the row container we scope
// the text assertions inside that container; for the rest we look up
// the row via the switch's testID and walk to the row container.
const VISIBLE_OPT_OUT_ROWS: Array<{
  switchTestId: string;
  labelKey: keyof typeof enProfile.commPrefs.emailOptOuts;
  descKey: keyof typeof enProfile.commPrefs.emailOptOuts;
}> = [
  {
    switchTestId: "switch-notify-manual-entry-alerts",
    labelKey: "manualEntryLabel",
    descKey: "manualEntryDesc",
  },
  {
    switchTestId: "switch-notify-coach-payout-account-changes",
    labelKey: "coachPayoutLabel",
    descKey: "coachPayoutDesc",
  },
  {
    switchTestId: "switch-notify-admin-payout-reverify",
    labelKey: "adminPayoutReverifyLabel",
    descKey: "adminPayoutReverifyDesc",
  },
  {
    switchTestId: "switch-notify-data-export-expiring",
    labelKey: "dataExportExpiringLabel",
    descKey: "dataExportExpiringDesc",
  },
  {
    switchTestId: "switch-notify-erasure-storage-digest",
    labelKey: "erasureStorageDigestLabel",
    descKey: "erasureStorageDigestDesc",
  },
  {
    switchTestId: "switch-notify-side-game-receipts",
    labelKey: "sideGameReceiptsLabel",
    descKey: "sideGameReceiptsDesc",
  },
];

// Walk up from the per-row Switch (which is the only stable testID on
// every row) until we hit a node that contains both the row's label
// and description text — that's the row container we want to scope
// `within(...)` assertions to.
function rowContainerFor(switchEl: HTMLElement, hiLabel: string, hiDesc: string): HTMLElement {
  let node: HTMLElement | null = switchEl.parentElement;
  while (node) {
    const text = node.textContent ?? "";
    if (text.includes(hiLabel) && text.includes(hiDesc)) return node;
    node = node.parentElement;
  }
  throw new Error(
    `Could not find a row container around ${switchEl.getAttribute("data-testid") ?? "<switch>"} that contains both label and description.`,
  );
}

describe("CommunicationsScreen — per-event opt-out i18n coverage (Task #2158)", () => {
  it("renders the opt-out section header in the active language (hi)", async () => {
    render(<CommunicationsScreen />);

    // Wait for the screen to finish hydrating before reading any text
    // — until then the screen renders only an ActivityIndicator.
    await screen.findByTestId("switch-notify-manual-entry-alerts");

    // Sanity: the Hindi bundle actually has translated copy for the
    // section header. If a future PR ships a new opt-out without
    // translating these, this assertion fails before the per-row
    // assertions do.
    expect(hiProfile.commPrefs.emailOptOuts.sectionTitle).not.toBe(
      enProfile.commPrefs.emailOptOuts.sectionTitle,
    );
    expect(hiProfile.commPrefs.emailOptOuts.sectionDescription).not.toBe(
      enProfile.commPrefs.emailOptOuts.sectionDescription,
    );

    expect(
      screen.getByText(hiProfile.commPrefs.emailOptOuts.sectionTitle),
    ).toBeInTheDocument();
    expect(
      screen.getByText(hiProfile.commPrefs.emailOptOuts.sectionDescription),
    ).toBeInTheDocument();

    // And the English source for the header is NOT in the document — a
    // hardcoded literal would re-introduce it under the Hindi locale.
    expect(
      screen.queryByText(enProfile.commPrefs.emailOptOuts.sectionTitle),
    ).toBeNull();
    expect(
      screen.queryByText(enProfile.commPrefs.emailOptOuts.sectionDescription),
    ).toBeNull();
  });

  it.each(VISIBLE_OPT_OUT_ROWS)(
    "renders the Hindi translation (not the English source) for $labelKey",
    async ({ switchTestId, labelKey, descKey }) => {
      render(<CommunicationsScreen />);

      const switchEl = await screen.findByTestId(switchTestId);
      // Wait for the controlled toggle to finish hydrating from the
      // GET so we're asserting against the post-effect render.
      await waitFor(() => {
        const cb = switchEl.querySelector("input[type='checkbox']") as HTMLInputElement | null;
        expect(cb).not.toBeNull();
      });

      const enLabel = enProfile.commPrefs.emailOptOuts[labelKey];
      const enDesc = enProfile.commPrefs.emailOptOuts[descKey];
      const hiLabel = hiProfile.commPrefs.emailOptOuts[labelKey];
      const hiDesc = hiProfile.commPrefs.emailOptOuts[descKey];

      // Sanity: the locale file actually has translated copy for this
      // row. Catches the case where a new opt-out ships without an
      // entry in `hi/profile.json` (i18next would silently fall back
      // to en).
      expect(hiLabel).toBeDefined();
      expect(hiDesc).toBeDefined();
      expect(hiLabel).not.toBe(enLabel);
      expect(hiDesc).not.toBe(enDesc);

      const row = rowContainerFor(switchEl, hiLabel, hiDesc);

      // The row renders its translated label and description...
      expect(within(row).getByText(hiLabel)).toBeInTheDocument();
      expect(within(row).getByText(hiDesc)).toBeInTheDocument();

      // ...and crucially NOT the English source. A future commit that
      // re-hardcodes the label as a string literal would re-introduce
      // the English copy under the Hindi locale and trip this
      // assertion — exactly the regression class the task description
      // calls out.
      expect(within(row).queryByText(enLabel)).toBeNull();
      expect(within(row).queryByText(enDesc)).toBeNull();
    },
  );
});
