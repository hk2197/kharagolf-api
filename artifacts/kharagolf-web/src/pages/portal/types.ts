export interface PlayerUser {
  id: number;
  email: string;
  displayName: string;
  username: string;
  role: string;
  organizationId?: number;
  emailVerified: boolean;
  isLocalAuth: boolean;
  profileImage?: string | null;
  preferredLanguage?: string;
}

export interface LeagueRow {
  memberId: number;
  leagueId: number;
  leagueName: string;
  leagueFormat: string;
  leagueStatus: string;
  seasonStart: string | null;
  seasonEnd: string | null;
  totalPoints: number | null;
  position: number | null;
  roundsPlayed: number | null;
}

export interface MembershipInfo {
  id: number;
  firstName: string;
  lastName: string;
  memberNumber: string | null;
  subscriptionStatus: string;
  renewalDate: string | null;
  tierName: string | null;
  annualFee: string | null;
  currency: string | null;
  subscription: {
    id: number;
    status: string;
    nextBillingDate: string | null;
    razorpaySubscriptionId: string | null;
    failedPaymentCount: number | null;
  } | null;
}

export interface MembershipTier {
  id: number;
  name: string;
  description: string | null;
  annualFee: string;
  currency: string;
  gracePeriodDays: number;
  razorpayPlanId: string | null;
}

export interface DuesInvoice {
  id: number;
  invoiceNumber: string;
  status: string;
  totalAmount: string;
  paidAmount: string;
  currency: string;
  dueDate: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
  razorpayPaymentLinkUrl: string | null;
  sentAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface MyTeeBooking {
  id: number;
  slotId: number;
  playerName: string;
  players: number;
  amountPaise: number;
  paymentStatus: string;
  notes: string | null;
  bookedAt: string;
  cancelledAt: string | null;
  slotDate: string;
  startingHole: number;
  courseName: string | null;
  slotStatus: string;
}

export interface LockerAssignment {
  id: number;
  lockerNumber: string;
  bay: string | null;
  expiryDate: string;
  startDate: string;
  status: string;
  annualFee: string;
  currency: string;
  paymentStatus: string;
  paymentLinkUrl: string | null;
}

export interface LockerWaitlistEntry {
  id: number;
  requestedAt: string;
  status: string;
}

export interface NotifPrefs {
  preferEmail: boolean;
  preferPush: boolean;
  preferSms: boolean;
  preferWhatsapp: boolean;
  notifyMemberDocuments: boolean;
  notifyCommitteePeerDigest: boolean;
}

export interface NotifCaps {
  hasPhone: boolean;
  hasPushToken: boolean;
  isCommitteeMember: boolean;
}

export const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400 border-green-500/30',
  upcoming: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  completed: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  draft: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
};
