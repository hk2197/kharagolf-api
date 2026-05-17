/**
 * UI test (Task #1888): Stuck side-game receipts widget — localisation parity
 * with the digest email (Task #1522).
 *
 * Task #1522 localised the stuck side-game receipts digest *email* into 21
 * languages, but the dashboard panel that the email's footer points to
 * ("open the dashboard and edit the 'Stuck side-game receipts' panel") was
 * still English-only. Task #1888 closes that gap.
 *
 * Mounts <SideGameReceiptFailuresWidget /> twice — once under `lng=de` and
 * once under `lng=ja` — with a mocked admin payload, and asserts:
 *   - the panel header title renders in the active language (the de/ja copy
 *     mirrors the headerLabel used by `sideGameReceiptDigestI18n.ts` in the
 *     api-server)
 *   - the "Re-queue delivery" button label renders in the active language
 *   - the success toast title + description render in the active language
 *     after clicking the button
 *
 * Regression guard: if the widget ever stopped piping the panel surface
 * through `useTranslation('dashboard')`, or if a `dashboard.stuckReceipts.*`
 * key was deleted from one of the supported locales' `dashboard.json`,
 * this test would fail.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enDashboard from "../../i18n/locales/en/dashboard.json";
import hiDashboard from "../../i18n/locales/hi/dashboard.json";
import arDashboard from "../../i18n/locales/ar/dashboard.json";
import esDashboard from "../../i18n/locales/es/dashboard.json";
import frDashboard from "../../i18n/locales/fr/dashboard.json";
import deDashboard from "../../i18n/locales/de/dashboard.json";
import ptDashboard from "../../i18n/locales/pt/dashboard.json";
import jaDashboard from "../../i18n/locales/ja/dashboard.json";
import koDashboard from "../../i18n/locales/ko/dashboard.json";
import zhDashboard from "../../i18n/locales/zh/dashboard.json";
import thDashboard from "../../i18n/locales/th/dashboard.json";
import msDashboard from "../../i18n/locales/ms/dashboard.json";
import idDashboard from "../../i18n/locales/id/dashboard.json";
import viDashboard from "../../i18n/locales/vi/dashboard.json";
import filDashboard from "../../i18n/locales/fil/dashboard.json";
import swDashboard from "../../i18n/locales/sw/dashboard.json";
import afDashboard from "../../i18n/locales/af/dashboard.json";
import amDashboard from "../../i18n/locales/am/dashboard.json";
import haDashboard from "../../i18n/locales/ha/dashboard.json";
import zuDashboard from "../../i18n/locales/zu/dashboard.json";
import yoDashboard from "../../i18n/locales/yo/dashboard.json";

const ALL_PACKS: Record<string, typeof enDashboard> = {
  en: enDashboard, hi: hiDashboard, ar: arDashboard, es: esDashboard,
  fr: frDashboard, de: deDashboard, pt: ptDashboard, ja: jaDashboard,
  ko: koDashboard, zh: zhDashboard, th: thDashboard, ms: msDashboard,
  id: idDashboard, vi: viDashboard, fil: filDashboard, sw: swDashboard,
  af: afDashboard, am: amDashboard, ha: haDashboard, zu: zuDashboard,
  yo: yoDashboard,
};

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { SideGameReceiptFailuresWidget } from "../dashboard";

const ORG_ID = 42;
const ATTEMPT_ID = 9001;

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      lng: "en",
      fallbackLng: "en",
      defaultNS: "dashboard",
      ns: ["dashboard"],
      resources: {
        en: { dashboard: enDashboard },
        de: { dashboard: deDashboard },
        ja: { dashboard: jaDashboard },
        ar: { dashboard: arDashboard },
      },
      interpolation: { escapeValue: false },
    });
  } else {
    // The panel may have been mounted by a sibling test that only loaded
    // the `en` namespace — top up with the locales this fixture asserts.
    i18n.addResourceBundle("de", "dashboard", deDashboard, true, true);
    i18n.addResourceBundle("ja", "dashboard", jaDashboard, true, true);
    i18n.addResourceBundle("ar", "dashboard", arDashboard, true, true);
  }
});

function fixtureResponse() {
  return {
    items: [
      {
        id: ATTEMPT_ID,
        settlementId: 555,
        recipientUserId: 700,
        recipientClubMemberId: null,
        payerName: "Payer Patty",
        recipientName: "Linked Larry",
        recipientEmail: "larry@example.com",
        gameLabel: "Skins",
        currency: "INR",
        amount: 1200,
        paidAt: "2026-04-29T10:00:00Z",
        emailStatus: "failed",
        emailAttempts: 4,
        lastEmailError: "smtp boom",
        emailRetryExhaustedAt: "2026-04-29T10:30:00Z",
        pushStatus: null,
        pushAttempts: 0,
        lastPushError: null,
        pushRetryExhaustedAt: null,
        emailStuck: true,
        pushStuck: false,
      },
    ],
    counts: { total: 1, exhausted: 1, skipped: 0 },
  };
}

let resendResolver: ((value: Response) => void) | null = null;

function installFetch() {
  resendResolver = null;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes(`/admin/side-game-receipt-failures/${ATTEMPT_ID}/resend`)) {
      void init; // resend is body-less — see resend mutation in dashboard.tsx
      return new Promise<Response>(resolve => {
        resendResolver = resolve;
      });
    }
    if (url.includes("/admin/side-game-receipt-failures")) {
      return new Response(JSON.stringify(fixtureResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderWidget() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SideGameReceiptFailuresWidget orgId={ORG_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
  installFetch();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("<SideGameReceiptFailuresWidget /> — locale parity with digest email (Task #1888)", () => {
  it("renders the panel header, button, and toast copy in German under lng=de", async () => {
    await i18n.changeLanguage("de");
    const user = userEvent.setup();
    renderWidget();

    // Panel header — must match the digest email's de `headerLabel` so
    // an admin who follows the email's footer link sees the same words.
    // Wait for the row to land first; the card shell renders during
    // loading state with only a skeleton inside (no row testid yet).
    const row = await screen.findByTestId(`row-stuck-receipt-${ATTEMPT_ID}`);
    const card = screen.getByTestId("card-stuck-receipts");
    expect(within(card).getByText("Hängende Side-Game-Belege")).toBeInTheDocument();

    // Resend button label and pending-state label.
    const button = within(row).getByTestId(`button-resend-receipt-${ATTEMPT_ID}`);
    expect(button).toHaveTextContent("Zustellung neu einreihen");

    await user.click(button);
    await waitFor(() => {
      expect(button).toHaveTextContent("Wird eingereiht…");
    });

    // Resolve the resend mutation — only email was re-queued.
    expect(resendResolver).not.toBeNull();
    resendResolver!(
      new Response(
        JSON.stringify({ ok: true, requeued: { email: true, push: false } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as Response,
    );

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Beleg erneut eingereiht",
          description: "Wiederholt E-Mail beim nächsten Cron-Lauf.",
        }),
      );
    });
  });

  it("renders the panel header, button, and toast copy in Japanese under lng=ja", async () => {
    await i18n.changeLanguage("ja");
    const user = userEvent.setup();
    renderWidget();

    const row = await screen.findByTestId(`row-stuck-receipt-${ATTEMPT_ID}`);
    const card = screen.getByTestId("card-stuck-receipts");
    expect(within(card).getByText("滞留しているサイドゲーム領収")).toBeInTheDocument();

    const button = within(row).getByTestId(`button-resend-receipt-${ATTEMPT_ID}`);
    expect(button).toHaveTextContent("配信を再キュー");

    await user.click(button);
    await waitFor(() => {
      expect(button).toHaveTextContent("再キュー中…");
    });

    expect(resendResolver).not.toBeNull();
    resendResolver!(
      new Response(
        JSON.stringify({ ok: true, requeued: { email: true, push: true } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as Response,
    );

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "領収を再キューしました",
          description: "次回の cron 実行で メール・プッシュ を再試行します。",
        }),
      );
    });
  });

  it("translates the email/push status pills instead of leaking raw English status codes", async () => {
    // Regression guard for code-review feedback on Task #1888: the API
    // returns raw lower-snake-case status codes
    // (`skipped`, `no_address`, `opted_out`, `no_user`, `failed`) and
    // the widget previously rendered them verbatim, breaking the
    // "all status pills must be translated" acceptance criterion.
    await i18n.changeLanguage("de");

    // Override the default fixture so the email pill exercises a
    // non-exhausted, non-null status (`skipped`) and the push pill
    // exercises another raw token (`no_address`). Both must surface as
    // translated German text — never the raw API tokens.
    const customFixture = {
      items: [
        {
          ...fixtureResponse().items[0],
          emailStatus: "skipped",
          emailRetryExhaustedAt: null,
          pushStatus: "no_address",
          pushRetryExhaustedAt: null,
          pushStuck: true,
        },
      ],
      counts: { total: 1, exhausted: 0, skipped: 1 },
    };

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/admin/side-game-receipt-failures")) {
        return new Response(JSON.stringify(customFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }) as unknown as Response;
      }
      return new Response("not found", { status: 404 }) as unknown as Response;
    }) as typeof fetch;

    renderWidget();

    const row = await screen.findByTestId(`row-stuck-receipt-${ATTEMPT_ID}`);
    const emailPill = within(row).getByTestId(`badge-stuck-email-${ATTEMPT_ID}`);
    const pushPill = within(row).getByTestId(`badge-stuck-push-${ATTEMPT_ID}`);

    // Translated German labels per `dashboard.json` `stuckReceipts.statuses.*`.
    expect(emailPill).toHaveTextContent("E-Mail · übersprungen");
    expect(pushPill).toHaveTextContent("Push · keine Adresse hinterlegt");

    // Hard regression guard: the raw API tokens must never reach the DOM.
    expect(emailPill.textContent).not.toMatch(/\bskipped\b/);
    expect(pushPill.textContent).not.toMatch(/\bno_address\b/);
  });

  it("covers the same 21 language codes as the digest email pack", () => {
    // Mirrors `SIDE_GAME_RECEIPT_DIGEST_LANGS` in
    // `artifacts/api-server/src/lib/sideGameReceiptDigestI18n.ts` — every
    // locale that ships a digest email must also ship a translated panel.
    const expected = [
      "en", "hi", "ar", "es", "fr", "de", "pt",
      "ja", "ko", "zh", "th", "ms", "id", "vi",
      "fil", "sw", "af", "am", "ha", "zu", "yo",
    ] as const;
    expect(Object.keys(ALL_PACKS).sort()).toEqual([...expected].sort());
    for (const lang of expected) {
      const pack = ALL_PACKS[lang] as { stuckReceipts?: Record<string, unknown> };
      const stuck = pack.stuckReceipts as
        | { title?: string; resendButton?: string; toast?: { successTitle?: string } }
        | undefined;
      expect(stuck?.title, `missing stuckReceipts.title for ${lang}`).toBeTruthy();
      expect(stuck?.resendButton, `missing stuckReceipts.resendButton for ${lang}`).toBeTruthy();
      expect(stuck?.toast?.successTitle, `missing stuckReceipts.toast.successTitle for ${lang}`).toBeTruthy();
    }
  });
});
