/**
 * Task #1631 — UI smoke test for the "Preview template" action in the
 * notification-template registry on the channels admin tab.
 *
 * Verifies that:
 *   1. Clicking "Preview template" for a registered key fetches
 *      `/api/admin/notification-templates/:key/preview` and renders the
 *      sample title / body / HTML returned by the API in a dialog.
 *   2. A 404 from the same endpoint (e.g. the key was unregistered between
 *      the list fetch and the click) surfaces a friendly inline error in
 *      the same dialog instead of a blank panel or a thrown render error.
 *
 * Companion to the API contract test for the preview endpoint
 * (artifacts/api-server/src/tests/notification-dispatch-and-digest.test.ts,
 * Task #1005), which pins down the response shape this UI relies on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin", preferredLanguage: "es" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import SettingsPage from "../admin";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const ORG = {
  id: 42,
  name: "Pine Valley",
  slug: "pinevalley",
  description: null,
  logoUrl: null,
  primaryColor: "#1e4d2b",
  customDomain: null,
  subscriptionTier: "enterprise",
  isActive: true,
  contactEmail: null,
  contactPhone: null,
  address: null,
  website: null,
  defaultLanguage: "en",
};

const REGISTERED_KEYS = [
  "handicap.committee.changed",
  "course.correction.resolved",
];

const REGISTERED_ENTRIES = REGISTERED_KEYS.map((key) => ({
  key,
  category: "handicap",
  description: `Sample description for ${key}.`,
  digestable: true,
  defaultChannels: ["email", "push"],
  auditRequired: true,
}));

const AVAILABLE_LANGUAGES = [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
];

function previewBodyFor(lang: string) {
  // Echo `lang` so the FE can confirm fallback behaviour. Title /
  // body change with lang to prove the picker really triggered a
  // re-fetch (en vs es vs fr).
  const titles: Record<string, string> = {
    en: "Your handicap was updated",
    es: "Tu hándicap fue actualizado",
    fr: "Votre handicap a été mis à jour",
  };
  const title = titles[lang] ?? titles.en;
  return {
    key: "handicap.committee.changed",
    category: "handicap",
    description: "The handicap committee changed your handicap index.",
    digestable: true,
    defaultChannels: ["email", "push"],
    auditRequired: true,
    branded: true,
    lang,
    availableLanguages: AVAILABLE_LANGUAGES,
    sample: {
      title,
      body: `[Sample-${lang}] The handicap committee changed your handicap index.`,
      html: `<!doctype html><html><body><div>${title}</div></body></html>`,
    },
  };
}

function nonBrandedPreviewBody(lang: string) {
  return {
    key: "handicap.committee.changed",
    category: "handicap",
    description: "Generic only — no branded renderer.",
    digestable: true,
    defaultChannels: ["email", "push"],
    auditRequired: true,
    branded: false,
    lang,
    availableLanguages: AVAILABLE_LANGUAGES,
    sample: {
      title: "Generic title",
      body: "Generic body",
      html: "<!doctype html><html><body><h2>Generic title</h2></body></html>",
    },
  };
}

let fetchedUrls: string[];

function installFetch(
  opts: { previewStatus?: number; nonBranded?: boolean } = {},
) {
  fetchedUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchedUrls.push(url);
      if (url.endsWith("/api/organizations/42")) {
        return jsonResponse(ORG);
      }
      if (url.endsWith("/api/admin/channel-status")) {
        return jsonResponse({
          channels: {
            email: { active: false, provider: null, setupInstructions: null },
            push: { active: false, provider: null, setupInstructions: null },
            sms: { active: false, provider: null, setupInstructions: null },
            whatsapp: { active: false, provider: null, setupInstructions: null },
          },
          payments: {
            stripe: {
              baseCurrency: "USD",
              usesStripe: false,
              secretKeyConfigured: false,
              webhookSecretConfigured: false,
              webhookEndpoint: "/api/stripe/webhook",
              warning: false,
              setupInstructions: null,
            },
          },
        });
      }
      if (url.endsWith("/api/admin/notification-templates")) {
        return jsonResponse({ keys: REGISTERED_ENTRIES });
      }
      if (url.includes("/api/admin/notification-templates/") && url.includes("/preview")) {
        if (opts.previewStatus === 404) {
          return jsonResponse({ error: "unknown notification key" }, 404);
        }
        // Echo the requested `lang` so the FE picker behaviour is
        // exercised end-to-end. Default to `en` if missing.
        const m = url.match(/[?&]lang=([^&]+)/);
        const lang = m ? decodeURIComponent(m[1]) : "en";
        return jsonResponse(
          opts.nonBranded ? nonBrandedPreviewBody(lang) : previewBodyFor(lang),
        );
      }
      if (url.endsWith("/api/admin/wearable-reauth-alert-settings")) {
        return jsonResponse({
          orgId: 42,
          settings: {
            minCount: 0, minSharePct: 0, minAttempted: 0, wowMinDelta: null, email: null,
          },
          defaults: {
            minCount: 0, minSharePct: 0, minAttempted: 0, wowMinDelta: 0, fallbackEmail: null,
          },
        });
      }
      if (url.endsWith("/api/admin/wellness-sweep-status")) {
        return jsonResponse({ lastSweep: null });
      }
      if (url.startsWith("/api/admin/wellness-sweep-history")) {
        return jsonResponse({ runs: [] });
      }
      // Other admin queries the channels section fires (week-over-week
      // re-auth drift, reauth-alert-history, etc.) read deeply nested
      // shapes from `data` directly and would crash the render with an
      // empty {}. Return 404 so each query's `if (!r.ok) throw` keeps
      // `data` undefined and the corresponding UI block doesn't render.
      if (url.startsWith("/api/admin/")) {
        return jsonResponse({ error: "not relevant to this test" }, 404);
      }
      return jsonResponse({}, 200);
    }),
  );
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

async function switchToChannelsSection() {
  // Sidebar nav buttons are plain-text and translated, so we match
  // any visible button whose label contains "channel".
  const buttons = await screen.findAllByRole("button");
  const channelsButton = buttons.find(b => /channel/i.test(b.textContent ?? ""));
  if (!channelsButton) throw new Error("Could not find a channels-section sidebar button");
  fireEvent.click(channelsButton);
}

// Radix Select calls scrollIntoView on focus, which jsdom doesn't ship.
// Stub it so the language picker can mount without crashing the tree
// (Task #1648).
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element["scrollIntoView"];
  if (!('hasPointerCapture' in Element.prototype)) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!('releasePointerCapture' in Element.prototype)) {
    (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture =
      () => {};
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin.tsx — Preview template action (Task #1631)", () => {
  beforeEach(() => {
    installFetch();
  });

  it("renders a Preview template button next to View audit for each registered key, and opens the preview dialog on click", async () => {
    renderPage();

    // Switch to the channels section so the registry list renders. The
    // sidebar nav button is plain text whose label varies by translation,
    // so we match on `/channel/i` across all visible buttons.
    await switchToChannelsSection();

    // Wait for the registry list to fetch and render both rows.
    const previewBtn = await screen.findByTestId(
      `button-registry-preview-template-${REGISTERED_KEYS[0]}`,
    );
    expect(previewBtn).toBeInTheDocument();

    // The "View audit" deep-link must remain visible alongside it — we
    // are *adding* an action, not replacing the existing one.
    expect(
      screen.getByTestId(`link-registry-view-audit-${REGISTERED_KEYS[0]}`),
    ).toBeInTheDocument();

    // Click "Preview template" → preview endpoint is called and the
    // dialog opens with the sample title + body rendered.
    //
    // Task #1648 — the FE now defaults the language picker to the
    // admin's own preferredLanguage (mocked to "es"), so the URL
    // carries `?lang=es`.
    fireEvent.click(previewBtn);

    await waitFor(() => {
      expect(
        fetchedUrls.some(u =>
          u.includes(
            `/api/admin/notification-templates/${encodeURIComponent(REGISTERED_KEYS[0])}/preview`,
          ) && u.includes("lang=es"),
        ),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId("dialog-notification-template-preview")).toBeInTheDocument();
      expect(screen.getByTestId("text-preview-title").textContent).toContain(
        "Tu hándicap fue actualizado",
      );
    });

    // The HTML iframe should be sandboxed and use srcDoc (not src) so the
    // template HTML can't reach back into the admin shell.
    const iframe = screen.getByTestId("iframe-preview-html") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(iframe.getAttribute("srcdoc")).toContain("Tu hándicap fue actualizado");
  });

  it("shows a friendly error when the preview endpoint returns 404 (key no longer registered)", async () => {
    installFetch({ previewStatus: 404 });
    renderPage();

    await switchToChannelsSection();

    const previewBtn = await screen.findByTestId(
      `button-registry-preview-template-${REGISTERED_KEYS[0]}`,
    );
    fireEvent.click(previewBtn);

    await waitFor(() => {
      const err = screen.getByTestId("text-preview-error");
      expect(err).toBeInTheDocument();
      expect(err.textContent).toMatch(/no longer registered/i);
    });

    // The dialog is still open (so the admin can read the error), but no
    // sample title/body sections render.
    expect(screen.queryByTestId("text-preview-title")).not.toBeInTheDocument();
    expect(screen.queryByTestId("text-preview-body")).not.toBeInTheDocument();
  });

  // Task #1648 — language picker for branded templates.
  it("renders a language picker that re-fetches the preview when changed (branded templates)", async () => {
    renderPage();
    await switchToChannelsSection();

    const previewBtn = await screen.findByTestId(
      `button-registry-preview-template-${REGISTERED_KEYS[0]}`,
    );
    fireEvent.click(previewBtn);

    // Initial render — picker visible, defaulted to admin's preferredLanguage ("es").
    const picker = await screen.findByTestId("select-preview-language");
    expect(picker).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("text-preview-title").textContent).toContain(
        "Tu hándicap fue actualizado",
      );
    });

    // Change the picker to French. The dialog re-fetches with `?lang=fr`
    // and the title updates accordingly.
    fireEvent.click(picker);
    const frOption = await screen.findByTestId("option-preview-language-fr");
    fireEvent.click(frOption);

    await waitFor(() => {
      expect(
        fetchedUrls.some(u =>
          u.includes(
            `/api/admin/notification-templates/${encodeURIComponent(REGISTERED_KEYS[0])}/preview`,
          ) && u.includes("lang=fr"),
        ),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId("text-preview-title").textContent).toContain(
        "Votre handicap a été mis à jour",
      );
    });
  });

  it("hides the language picker for non-branded templates (no per-language strings)", async () => {
    installFetch({ nonBranded: true });
    renderPage();
    await switchToChannelsSection();

    const previewBtn = await screen.findByTestId(
      `button-registry-preview-template-${REGISTERED_KEYS[0]}`,
    );
    fireEvent.click(previewBtn);

    // Wait for the preview to render so the picker would have had a
    // chance to mount if it were going to.
    await waitFor(() => {
      expect(screen.getByTestId("text-preview-title").textContent).toContain(
        "Generic title",
      );
    });

    expect(screen.queryByTestId("select-preview-language")).not.toBeInTheDocument();
    expect(screen.queryByTestId("container-preview-language")).not.toBeInTheDocument();
  });
});
