import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Colors from '@/constants/colors';

const CATEGORY_LABELS: Record<string, string> = {
  gps: 'GPS / Location',
  photo: 'Photos',
  video: 'Videos',
  ai: 'AI Caddie',
};

interface ConsentPromptProps {
  message: string;
  category: string;
  onDismiss?: () => void;
}

/**
 * Shown when the API returns HTTP 403 with `code: "CONSENT_REQUIRED"` (Task #469).
 * Catches `ConsentRequiredError` thrown by the api utility, and links the
 * member straight to the privacy consent centre so they can re-enable the
 * relevant category.
 */
export default function ConsentPrompt({ message, category, onDismiss }: ConsentPromptProps) {
  const router = useRouter();
  const label = CATEGORY_LABELS[category] ?? category;

  return (
    <View style={styles.container}>
      <View style={styles.iconRow}>
        <Ionicons name="shield-half" size={32} color={Colors.secondary} />
      </View>
      <Text style={styles.title}>Consent Required</Text>
      <Text style={styles.message}>{message}</Text>
      <View style={styles.badge}><Text style={styles.badgeText}>{label}</Text></View>

      <Pressable
        style={styles.primaryButton}
        onPress={() => router.push('/my-360/consents')}
      >
        <Ionicons name="settings-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
        <Text style={styles.primaryButtonText}>Open Consent Settings</Text>
      </Pressable>

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
    borderColor: '#22c55e40',
    padding: 24,
    alignItems: 'center',
  },
  iconRow: { marginBottom: 12 },
  title: { fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 8, textAlign: 'center' },
  message: { fontSize: 14, color: '#94a3b8', textAlign: 'center', lineHeight: 20, marginBottom: 12 },
  badge: {
    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20,
    backgroundColor: '#22c55e20', borderWidth: 1, borderColor: '#22c55e',
    marginBottom: 16,
  },
  badgeText: { fontSize: 13, fontWeight: '600', color: '#22c55e' },
  primaryButton: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#16a34a',
    paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: 12, marginBottom: 12,
  },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  dismissButton: { padding: 8 },
  dismissText: { color: '#64748b', fontSize: 14 },
});
