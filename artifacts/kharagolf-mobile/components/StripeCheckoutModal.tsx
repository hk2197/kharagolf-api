import React, { useEffect, useRef } from "react";
import { Modal, View, Text, ActivityIndicator, StyleSheet } from "react-native";
import Colors from "@/constants/colors";

type StripeRN = typeof import("@stripe/stripe-react-native");

let StripeModule: StripeRN | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  StripeModule = require("@stripe/stripe-react-native");
} catch {
  StripeModule = null;
}

export const stripeModuleAvailable = !!StripeModule;

interface Props {
  visible: boolean;
  publishableKey: string;
  clientSecret: string;
  /** Stripe PaymentIntent ID (e.g. "pi_..."). The server already returns this as
   *  `orderId` when `processor === "stripe"` — pass it through to avoid client-side
   *  parsing of `clientSecret`. */
  paymentIntentId: string;
  merchantDisplayName: string;
  onSuccess: (paymentIntentId: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

export function StripeCheckoutModal({
  visible, publishableKey, clientSecret, paymentIntentId, merchantDisplayName,
  onSuccess, onCancel, onError,
}: Props) {
  if (!StripeModule) {
    return (
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text style={styles.title}>Stripe required</Text>
            <Text style={styles.body}>
              Card payments need a production build. Please use the website to complete this purchase.
            </Text>
          </View>
        </View>
      </Modal>
    );
  }

  const { StripeProvider } = StripeModule;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <StripeProvider publishableKey={publishableKey} merchantIdentifier="merchant.com.kharagolf">
            <StripeRunner
              clientSecret={clientSecret}
              paymentIntentId={paymentIntentId}
              merchantDisplayName={merchantDisplayName}
              onSuccess={onSuccess}
              onCancel={onCancel}
              onError={onError}
            />
          </StripeProvider>
        </View>
      </View>
    </Modal>
  );
}

function StripeRunner({
  clientSecret, paymentIntentId, merchantDisplayName, onSuccess, onCancel, onError,
}: {
  clientSecret: string;
  paymentIntentId: string;
  merchantDisplayName: string;
  onSuccess: (paymentIntentId: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const launched = useRef(false);
  const { useStripe } = StripeModule!;
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    (async () => {
      try {
        const { error: initError } = await initPaymentSheet({
          paymentIntentClientSecret: clientSecret,
          merchantDisplayName,
        });
        if (initError) {
          onError(initError.message ?? "Could not initialise payment sheet");
          return;
        }
        const { error: presentError } = await presentPaymentSheet();
        if (presentError) {
          if (presentError.code === "Canceled") {
            onCancel();
          } else {
            onError(presentError.message ?? "Payment failed");
          }
          return;
        }
        // Server returns the PaymentIntent ID as `orderId` for Stripe orders;
        // the parent passes it through so we don't need to parse it from clientSecret.
        onSuccess(paymentIntentId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unexpected payment error";
        onError(msg);
      }
    })();
  }, [clientSecret, paymentIntentId, merchantDisplayName, initPaymentSheet, presentPaymentSheet, onSuccess, onCancel, onError]);

  return (
    <View style={styles.runner}>
      <ActivityIndicator size="large" color={Colors.primary} />
      <Text style={styles.runnerText}>Opening secure checkout…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 24 },
  card: { backgroundColor: Colors.background ?? "#0a0f0d", borderRadius: 16, padding: 24, width: "100%", maxWidth: 420 },
  title: { color: Colors.text ?? "#fff", fontSize: 18, fontWeight: "700", marginBottom: 8 },
  body: { color: Colors.textSecondary ?? "#bbb", fontSize: 14, lineHeight: 20 },
  runner: { alignItems: "center", paddingVertical: 16, gap: 12 },
  runnerText: { color: Colors.textSecondary ?? "#bbb", fontSize: 13 },
});
