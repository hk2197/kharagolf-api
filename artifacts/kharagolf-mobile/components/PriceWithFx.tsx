import React, { useEffect, useState } from "react";
import { Pressable, Text, View, StyleSheet, type TextStyle, type StyleProp } from "react-native";
import Colors from "@/constants/colors";
import { BASE_URL } from "@/utils/api";

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹", USD: "$", GBP: "£", EUR: "€", AED: "د.إ", SGD: "S$", AUD: "A$", CAD: "C$", JPY: "¥",
};

export function fmtMoney(amount: number | string | null | undefined, currency: string): string {
  if (amount == null || amount === "") return "—";
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (!isFinite(n)) return "—";
  return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

interface QuoteDisplay {
  currency: string; totalAmount: number; fxRate: number;
  fxSource: string; isFallback: boolean; fxMarkupPct: number;
}
interface QuoteResponse {
  booking: { currency: string; totalAmount: number; taxableAmount?: number; totalTax?: number };
  display: QuoteDisplay | null;
  baseCurrency: string;
}

interface Props {
  orgId: number | null | undefined;
  amount: number | string | null | undefined;
  currency: string;
  token?: string | null;
  displayCurrency?: string;
  productClass?: string;
  bookedStyle?: StyleProp<TextStyle>;
  disclosureStyle?: StyleProp<TextStyle>;
  showDisclosure?: boolean;
  /**
   * When true and a display-currency conversion exists, the FX disclosure
   * (rate, source, fallback flag, markup) is hidden inline but revealed when
   * the user taps the converted amount. Useful in dense lists where
   * `showDisclosure={false}` keeps each row tidy by default.
   */
  disclosureOnHover?: boolean;
}

/**
 * Mobile reusable price renderer — shows the booked currency and, when the
 * player has a different preferred currency, an approximate display amount with
 * the FX disclosure (rate, source, markup) per task #448.
 */
export function PriceWithFx({
  orgId, amount, currency, token, displayCurrency, productClass,
  bookedStyle, disclosureStyle, showDisclosure = true, disclosureOnHover = false,
}: Props) {
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [tapOpen, setTapOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!orgId || amount == null || amount === "") { setQuote(null); return; }
    const n = typeof amount === "string" ? parseFloat(amount) : amount;
    if (!isFinite(n) || n <= 0) { setQuote(null); return; }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    fetch(`${BASE_URL}/api/organizations/${orgId}/currency-tax/quote`, {
      method: "POST",
      headers,
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
  }, [orgId, amount, currency, token, displayCurrency, productClass]);

  const bookedCurrency = quote?.booking.currency ?? currency;
  const bookedAmount = quote?.booking.totalAmount ?? amount;
  const display = quote?.display;
  if (!display) {
    return <Text style={bookedStyle}>{fmtMoney(bookedAmount, bookedCurrency)}</Text>;
  }
  const inverse = display.fxRate > 0 ? 1 / display.fxRate : 0;
  const disclosureLine =
    `1 ${bookedCurrency} = ${display.fxRate.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${display.currency}` +
    (inverse > 0 ? ` (1 ${display.currency} = ${inverse.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${bookedCurrency})` : "") +
    `, source: ${display.fxSource}${display.isFallback ? " (fallback)" : ""}` +
    (display.fxMarkupPct > 0 ? `, includes ${display.fxMarkupPct}% FX markup` : "");

  const tapToReveal = !showDisclosure && disclosureOnHover;
  const disclosureVisible = showDisclosure || (tapToReveal && tapOpen);

  const approxLine = (
    <Text style={[styles.approx, disclosureStyle]}>
      Approx. <Text style={styles.approxBold}>{fmtMoney(display.totalAmount, display.currency)}</Text>
      {showDisclosure ? " — converted at" : ""}
      {tapToReveal ? (tapOpen ? " ▴" : " ▾") : ""}
    </Text>
  );

  return (
    <View>
      <Text style={bookedStyle}>{fmtMoney(bookedAmount, bookedCurrency)}</Text>
      {tapToReveal ? (
        <Pressable
          onPress={() => setTapOpen(o => !o)}
          accessibilityRole="button"
          accessibilityLabel={`Approx. ${fmtMoney(display.totalAmount, display.currency)}. ${disclosureLine}`}
          accessibilityHint="Tap to show or hide the FX rate"
          testID="fx-disclosure-trigger"
          hitSlop={6}
        >
          {approxLine}
        </Pressable>
      ) : approxLine}
      {disclosureVisible && (
        <Text
          style={[styles.disclosure, disclosureStyle]}
          testID={tapToReveal ? "fx-disclosure-tooltip" : undefined}
        >
          {disclosureLine}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  approx: { fontSize: 12, color: Colors.muted, marginTop: 2 },
  approxBold: { color: Colors.text, fontWeight: "600" },
  disclosure: { fontSize: 11, color: Colors.muted, marginTop: 1 },
});

export default PriceWithFx;
