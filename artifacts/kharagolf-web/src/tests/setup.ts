import "@testing-library/jest-dom/vitest";

// Initialize react-i18next with the full English bundle so component tests
// that render translated copy (e.g. anything calling `t('…')`) see the real
// English strings instead of the bare translation keys. Importing the
// project's shared i18n entry point keeps the namespace list, default
// language, and resource bundles in sync with the running app, so any
// future test that touches translated copy inherits a working translator
// without having to opt in. Task #2166.
import "../i18n";

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
}

if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverPolyfill as unknown as typeof ResizeObserver;
}
