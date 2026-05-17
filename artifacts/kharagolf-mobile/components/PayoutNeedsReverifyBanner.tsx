import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import Colors from "@/constants/colors";

/**
 * Task #1511 — inline banner shown on the wallet screen when the daily
 * payout-account re-verification cron (Task #1119) has flagged the
 * member's saved UPI / bank as needing attention. Mirrors the coach
 * payout banner in `app/(tabs)/coach.tsx` (PayoutAccountCard, Task #1061)
 * and the web banner in `SideGamesAdmin.tsx` (`WalletPayoutNeedsReverifyBanner`)
 * so the same "here's the reason — re-save to resume payouts" affordance
 * shows up everywhere a member can see their saved account.
 *
 * Renders the persisted `verificationFailureReason` when present (the
 * cron always tries to populate it, but falls back to a generic line if
 * the upstream API didn't return one) and a "Re-save account" button
 * that opens the saved-account modal on the wallet screen.
 *
 * Extracted into its own module so the banner can be unit-tested without
 * importing the full wallet screen (which pulls in `react-native-razorpay`,
 * `expo-router`, and several other heavy native modules) — same pattern
 * as `WalletTxnRow.tsx` (Task #1110).
 *
 * Task #1872 — copy is now pulled from the `profile` i18n namespace
 * (`walletPayoutNeedsReverify.*`) so non-English locales no longer see a
 * raw English banner on an otherwise-localised wallet surface.
 */
export function PayoutNeedsReverifyBanner({
  method,
  reason,
  onPress,
}: {
  method: 'upi' | 'bank_account';
  reason: string | null;
  onPress: () => void;
}) {
  const { t } = useTranslation("profile");
  const title = method === 'upi'
    ? t('walletPayoutNeedsReverify.titleUpi')
    : t('walletPayoutNeedsReverify.titleBank');
  const cta = t('walletPayoutNeedsReverify.cta');
  return (
    <View
      style={styles.banner}
      accessibilityRole="alert"
      testID="banner-wallet-payout-needs-reverify"
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>
          {t('walletPayoutNeedsReverify.body')}
          {reason ? ` ${t('walletPayoutNeedsReverify.reason', { reason })}` : ''}
        </Text>
      </View>
      <Pressable
        onPress={onPress}
        style={styles.btn}
        testID="button-wallet-payout-needs-reverify-fix"
        accessibilityRole="button"
        accessibilityLabel={cta}
      >
        <Text style={styles.btnText}>{cta}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#f6b73c',
    backgroundColor: 'rgba(246, 183, 60, 0.08)',
  },
  title: { fontSize: 12, color: '#f6b73c', fontFamily: 'Inter_600SemiBold' },
  body: { fontSize: 11, color: Colors.textSecondary, fontFamily: 'Inter_500Medium', marginTop: 2 },
  btn: {
    backgroundColor: '#f6b73c',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  btnText: { color: '#000', fontSize: 12, fontFamily: 'Inter_600SemiBold' },
});
