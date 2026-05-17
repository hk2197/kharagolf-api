import React from 'react';
import { View, Text, StyleSheet, Pressable, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Colors from '@/constants/colors';

const TIER_LABELS: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

interface UpgradePromptProps {
  message: string;
  currentTier?: string;
  requiredTier?: string;
  /** URL to the web admin upgrade page — if provided shows an "Upgrade Plan" button */
  upgradeUrl?: string;
  onDismiss?: () => void;
}

/**
 * Shown when the club's plan does not include the requested feature (HTTP 402).
 * Catches FeatureGateError thrown by API utility functions.
 */
export default function UpgradePrompt({
  message,
  currentTier = 'free',
  requiredTier = 'starter',
  upgradeUrl,
  onDismiss,
}: UpgradePromptProps) {
  const currentLabel = TIER_LABELS[currentTier] ?? currentTier;
  const requiredLabel = TIER_LABELS[requiredTier] ?? requiredTier;

  return (
    <View style={styles.container}>
      <View style={styles.iconRow}>
        <Ionicons name="lock-closed" size={32} color={Colors.secondary} />
      </View>
      <Text style={styles.title}>Plan Upgrade Required</Text>
      <Text style={styles.message}>{message}</Text>

      <View style={styles.tierRow}>
        <View style={[styles.tierBadge, styles.tierBadgeCurrent]}>
          <Text style={styles.tierBadgeText}>{currentLabel}</Text>
        </View>
        <Ionicons name="arrow-forward" size={16} color={Colors.muted} />
        <View style={[styles.tierBadge, styles.tierBadgeRequired]}>
          <Text style={[styles.tierBadgeText, styles.tierBadgeTextRequired]}>{requiredLabel}</Text>
        </View>
      </View>

      {upgradeUrl && (
        <Pressable
          style={styles.upgradeButton}
          onPress={() => Linking.openURL(upgradeUrl)}
        >
          <Ionicons name="rocket-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
          <Text style={styles.upgradeButtonText}>Upgrade Plan</Text>
        </Pressable>
      )}

      {onDismiss && (
        <Pressable onPress={onDismiss} style={styles.dismissButton}>
          <Text style={styles.dismissText}>Dismiss</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    margin: 16,
    backgroundColor: '#1a1a2e',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#f59e0b40',
    padding: 24,
    alignItems: 'center',
  },
  iconRow: {
    marginBottom: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 8,
    textAlign: 'center',
  },
  message: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  tierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 20,
  },
  tierBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: '#334155',
  },
  tierBadgeCurrent: {
    backgroundColor: '#1e293b',
  },
  tierBadgeRequired: {
    backgroundColor: '#f59e0b20',
    borderWidth: 1,
    borderColor: '#f59e0b',
  },
  tierBadgeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#94a3b8',
  },
  tierBadgeTextRequired: {
    color: '#f59e0b',
  },
  upgradeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16a34a',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 12,
  },
  upgradeButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  dismissButton: {
    padding: 8,
  },
  dismissText: {
    color: '#64748b',
    fontSize: 14,
  },
});
