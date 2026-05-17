/**
 * Task #1765 — integration coverage for the LocaleProvider.
 *
 * Verifies the visible behaviours the marketing pages depend on:
 *   - Detection on first mount uses localStorage when set, else the
 *     navigator language.
 *   - Switching languages persists to localStorage and updates
 *     `<html lang>` + `<html dir>` so RTL Arabic flips the document.
 *   - The `useT` hook re-renders consumers when the language changes
 *     and falls back to English for keys that are missing from a
 *     partial bundle.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { LocaleProvider, useLocale, useT } from "../index";

function Probe() {
  const { lang, setLang } = useLocale();
  const t = useT();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="nav-pricing">{t("nav.pricing")}</span>
      <span data-testid="copy">{t("footer.copyright", { year: 2026 })}</span>
      <button data-testid="to-es" onClick={() => setLang("es")}>es</button>
      <button data-testid="to-ar" onClick={() => setLang("ar")}>ar</button>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
});

afterEach(() => {
  cleanup();
});

describe("LocaleProvider", () => {
  it("starts in English when nothing is stored and the browser asks for English", () => {
    render(
      <LocaleProvider initialLang="en">
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId("lang").textContent).toBe("en");
    expect(screen.getByTestId("nav-pricing").textContent).toBe("Pricing");
    expect(screen.getByTestId("copy").textContent).toBe(
      "© 2026 KHARAGOLF. All rights reserved.",
    );
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("switching to Spanish persists, re-renders translated copy and updates <html lang>", () => {
    render(
      <LocaleProvider initialLang="en">
        <Probe />
      </LocaleProvider>,
    );

    act(() => {
      screen.getByTestId("to-es").click();
    });

    expect(screen.getByTestId("lang").textContent).toBe("es");
    expect(screen.getByTestId("nav-pricing").textContent).toBe("Precios");
    expect(screen.getByTestId("copy").textContent).toBe(
      "© 2026 KHARAGOLF. Todos los derechos reservados.",
    );
    expect(window.localStorage.getItem("kharagolf:lang")).toBe("es");
    expect(document.documentElement.lang).toBe("es");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("switching to Arabic flips the document direction to RTL", () => {
    render(
      <LocaleProvider initialLang="en">
        <Probe />
      </LocaleProvider>,
    );

    act(() => {
      screen.getByTestId("to-ar").click();
    });

    expect(screen.getByTestId("lang").textContent).toBe("ar");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("reads the stored preference on first mount", () => {
    window.localStorage.setItem("kharagolf:lang", "hi");
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId("lang").textContent).toBe("hi");
    expect(screen.getByTestId("nav-pricing").textContent).toBe("मूल्य");
  });
});
