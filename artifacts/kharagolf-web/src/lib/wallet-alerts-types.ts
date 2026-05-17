export interface StuckWithdrawalNotifyItem {
  id: number;
  withdrawalId: number;
  organizationId: number;
  userId: number;
  // Task #1869 — resolved club_members.id for the recipient (or null
  // when the recipient has no membership row in this org). Mirrors the
  // sibling field on the side-game-receipts widget (Task #1291) and is
  // what the dashboard widget uses to deep-link the recipient name to
  // their Member 360 (Financial tab).
  recipientClubMemberId: number | null;
  outcome: string;
  amount: number;
  currency: string;
  destination: string;
  utr: string | null;
  reason: string | null;
  createdAt: string;
  recipientName: string | null;
  recipientEmail: string | null;
  emailStatus: string | null;
  emailAttempts: number;
  lastEmailAt: string | null;
  lastEmailError: string | null;
  emailRetryExhaustedAt: string | null;
  pushStatus: string | null;
  pushAttempts: number;
  lastPushAt: string | null;
  lastPushError: string | null;
  pushRetryExhaustedAt: string | null;
  // Task #1825 — SMS / WhatsApp delivery snapshot. Audit-only (these
  // channels are not retried by the wallet-withdrawal cron) so there is
  // no `*Stuck` flag — a row only ever appears in the failures
  // worklist via an email/push problem. Surfaced so admins can confirm
  // "did the member actually get pinged on SMS / WhatsApp?".
  smsStatus: string | null;
  smsError: string | null;
  lastSmsAt: string | null;
  whatsappStatus: string | null;
  whatsappError: string | null;
  lastWhatsappAt: string | null;
  emailStuck: boolean;
  pushStuck: boolean;
}

export interface StuckWithdrawalNotifyCounts {
  total: number;
  exhausted: number;
  skipped: number;
}

export interface StuckWithdrawalNotifyResponse {
  items: StuckWithdrawalNotifyItem[];
  counts: StuckWithdrawalNotifyCounts;
  page?: { limit: number; offset: number };
  filters?: {
    channel: 'email' | 'push' | null;
    state: 'exhausted' | 'skipped' | null;
    q: string | null;
  };
}
