import { useEffect, useId, useState } from 'react';

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹', USD: '$', GBP: '£', AED: 'د.إ', EUR: '€', SGD: 'S$', AUD: 'A$', CAD: 'C$', JPY: '¥',
};

export function fmtMoney(amount: number | string | null | undefined, currency: string): string {
  if (amount == null || amount === '') return '—';
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!isFinite(n)) return '—';
  return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export interface QuoteDisplay {
  currency: string;
  totalAmount: number;
  fxRate: number;
  fxSource: string;
  isFallback: boolean;
  fxMarkupPct: number;
}

export interface QuoteResponse {
  booking: { currency: string; totalAmount: number; taxableAmount: number; totalTax: number };
  display: QuoteDisplay | null;
  baseCurrency: string;
  processor?: string;
}

interface Props {
  orgId: number | null | undefined;
  amount: number | string | null | undefined;
  currency: string;
  displayCurrency?: string;
  productClass?: string;
  className?: string;
  bookedClassName?: string;
  disclosureClassName?: string;
  showDisclosure?: boolean;
  /**
   * When true and a display-currency conversion exists, the FX disclosure
   * (rate, source, fallback flag, markup) is hidden inline but revealed in a
   * small popover on hover, focus, or tap of the converted amount. Useful in
   * dense tables where `showDisclosure={false}` keeps the row tidy by default.
   */
  disclosureOnHover?: boolean;
}

/**
 * Renders a price in the booked currency and, when the player has a different
 * preferred display currency, an approximate display-currency price plus an FX
 * disclosure (rate, source, markup) per task #448.
 */
export function PriceWithFx({
  orgId, amount, currency, displayCurrency, productClass,
  className = '', bookedClassName = '', disclosureClassName = '',
  showDisclosure = true, disclosureOnHover = false,
}: Props) {
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const tooltipId = useId();

  useEffect(() => {
    let cancelled = false;
    if (!orgId || amount == null || amount === '') { setQuote(null); return; }
    const n = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (!isFinite(n) || n <= 0) { setQuote(null); return; }
    fetch(`/api/organizations/${orgId}/currency-tax/quote`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: n, currency,
        displayCurrency: displayCurrency || undefined,
        productClass: productClass || undefined,
      }),
    })
      .then(r => r.ok ? r.json() as Promise<QuoteResponse> : null)
      .then(q => { if (!cancelled) setQuote(q); })
      .catch(() => { if (!cancelled) setQuote(null); });
    return () => { cancelled = true; };
  }, [orgId, amount, currency, displayCurrency, productClass]);

  // Prefer booking values from the quote response when available so the UI
  // never diverges from what the backend will actually charge.
  const bookedCurrency = quote?.booking.currency ?? currency;
  const bookedAmount = quote?.booking.totalAmount ?? amount;
  const booked = <span className={bookedClassName}>{fmtMoney(bookedAmount, bookedCurrency)}</span>;
  const display = quote?.display;

  if (!display) return <span className={className}>{booked}</span>;

  const inverse = display.fxRate > 0 ? (1 / display.fxRate) : 0;
  const disclosureText = (
    <>
      1 {bookedCurrency} = {display.fxRate.toLocaleString(undefined, { maximumFractionDigits: 4 })} {display.currency}
      {inverse > 0 && (<> (1 {display.currency} = {inverse.toLocaleString(undefined, { maximumFractionDigits: 4 })} {bookedCurrency})</>)}
      , source: {display.fxSource}{display.isFallback ? ' (fallback)' : ''}
      {display.fxMarkupPct > 0 ? `, includes ${display.fxMarkupPct}% FX markup` : ''}
    </>
  );
  const plainDisclosure =
    `1 ${bookedCurrency} = ${display.fxRate.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${display.currency}` +
    (inverse > 0 ? ` (1 ${display.currency} = ${inverse.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${bookedCurrency})` : '') +
    `, source: ${display.fxSource}${display.isFallback ? ' (fallback)' : ''}` +
    (display.fxMarkupPct > 0 ? `, includes ${display.fxMarkupPct}% FX markup` : '');

  const showHoverPopover = !showDisclosure && disclosureOnHover;

  return (
    <span className={className}>
      {booked}
      <span className="block text-xs text-muted-foreground mt-0.5">
        {showHoverPopover ? (() => {
          const open = hovered || pinned;
          return (
            <span className="relative inline-block">
              <button
                type="button"
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onFocus={() => setHovered(true)}
                onBlur={() => { setHovered(false); setPinned(false); }}
                onClick={() => setPinned(p => !p)}
                aria-describedby={open ? tooltipId : undefined}
                aria-expanded={open}
                aria-label={`Approx. ${fmtMoney(display.totalAmount, display.currency)}. ${plainDisclosure}`}
                title={plainDisclosure}
                className="cursor-help underline decoration-dotted underline-offset-2 bg-transparent border-0 p-0 text-left text-xs text-muted-foreground"
                data-testid="fx-disclosure-trigger"
              >
                Approx. <span className="font-medium text-white">{fmtMoney(display.totalAmount, display.currency)}</span>
              </button>
              {open && (
                <span
                  id={tooltipId}
                  role="tooltip"
                  data-testid="fx-disclosure-tooltip"
                  className={`absolute z-20 right-0 bottom-full mb-1 w-64 rounded-md border border-white/15 bg-black/90 p-2 text-xs leading-snug text-white shadow-lg whitespace-normal text-left ${disclosureClassName}`}
                >
                  <span className="block text-muted-foreground">Converted at</span>
                  <span className="block">{disclosureText}</span>
                </span>
              )}
            </span>
          );
        })() : (
          <>
            Approx. <span className="font-medium text-white">{fmtMoney(display.totalAmount, display.currency)}</span>
            {showDisclosure && (
              <span className={disclosureClassName}>
                {' — converted at '}
                {disclosureText}
              </span>
            )}
          </>
        )}
      </span>
    </span>
  );
}

export default PriceWithFx;
