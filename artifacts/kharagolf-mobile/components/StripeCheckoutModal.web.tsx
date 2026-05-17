import React, { useEffect, useRef } from "react";
import { Modal, View, Text, StyleSheet } from "react-native";
import Colors from "@/constants/colors";

export const stripeModuleAvailable = false;

interface Props {
  visible: boolean;
  publishableKey: string;
  clientSecret: string;
  paymentIntentId: string;
  merchantDisplayName: string;
  onSuccess: (paymentIntentId: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

export function StripeCheckoutModal({ visible, onCancel, onError }: Props) {
  const notified = useRef(false);
  useEffect(() => {
    if (visible && !notified.current) {
      notified.current = true;
      onError(
        "Card payments are unavailable in the web preview. Please use the native iOS or Android app to complete this purchase."
      );
    }
    if (!visible) notified.current = false;
  }, [visible, onError]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Card payments unavailable on web</Text>
          <Text style={styles.body}>
            Stripe card payments require the native mobile build. Please use the iOS or Android app
            to complete this purchase.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    backgroundColor: Colors.background ?? "#0a0f0d",
    borderRadius: 16,
    padding: 24,
    width: "100%",
    maxWidth: 420,
  },
  title: { color: Colors.text ?? "#fff", fontSize: 18, fontWeight: "700", marginBottom: 8 },
  body: { color: Colors.textSecondary ?? "#bbb", fontSize: 14, lineHeight: 20 },
});
