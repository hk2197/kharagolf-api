import type { ReactNode } from 'react';
import { CreditCard, Download, Loader2, ShieldAlert, ShieldCheck, Users, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PriceWithFx } from '@/components/PriceWithFx';
import type { MembershipInfo, MembershipTier } from './types';

function MembershipStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('portal');
  const configs: Record<string, { label: string; icon: ReactNode; cls: string }> = {
    active:     { label: t('membershipStatus.active'),    icon: <ShieldCheck className="w-3 h-3" />, cls: 'bg-green-500/20 text-green-400 border-green-500/30' },
    past_due:   { label: t('membershipStatus.pastDue'),   icon: <ShieldAlert className="w-3 h-3" />, cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
    cancelled:  { label: t('membershipStatus.cancelled'), icon: <XCircle className="w-3 h-3" />,     cls: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
    expired:    { label: t('membershipStatus.expired'),   icon: <XCircle className="w-3 h-3" />,     cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
    pending:    { label: t('membershipStatus.pending'),   icon: <Loader2 className="w-3 h-3 animate-spin" />, cls: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  };
  const cfg = configs[status] ?? { label: status, icon: null, cls: 'bg-gray-500/20 text-gray-400 border-gray-500/30' };
  return (
    <Badge className={`${cfg.cls} border text-xs flex items-center gap-1`}>
      {cfg.icon}
      {cfg.label}
    </Badge>
  );
}

interface MembershipTabProps {
  membership: MembershipInfo | null | undefined;
  orgId: number | null;
  tiers: MembershipTier[];
  tiersLoading: boolean;
  subscribeTierId: number | '';
  setSubscribeTierId: (id: number | '') => void;
  subscribeLoading: boolean;
  handleSubscribe: () => void | Promise<void>;
  showInDirectory: boolean | null;
  directoryOptLoading: boolean;
  handleDirectoryOptIn: (val: boolean) => void | Promise<void>;
  downloadMemberCard: () => void;
  cancelLoading: boolean;
  handleCancelSubscription: () => void | Promise<void>;
}

export function MembershipTab({
  membership,
  orgId,
  tiers,
  tiersLoading,
  subscribeTierId,
  setSubscribeTierId,
  subscribeLoading,
  handleSubscribe,
  showInDirectory,
  directoryOptLoading,
  handleDirectoryOptIn,
  downloadMemberCard,
  cancelLoading,
  handleCancelSubscription,
}: MembershipTabProps) {
  const { t } = useTranslation(['portal']);

  if (membership === null) {
    return (
      <div data-testid="portal-membership-tab">
        <Card className="glass-panel border-white/10 p-8">
          <div className="flex flex-col items-center text-center mb-6">
            <CreditCard className="w-10 h-10 text-primary/40 mb-3" />
            <p className="text-white font-semibold">{t('portal:noClubMembership')}</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">{t('portal:subscribeOrContactAdmin')}</p>
            <div className="mt-3 flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-muted-foreground">
              <span className="bg-white/10 text-white/60 rounded px-1.5 py-0.5 font-mono text-[10px]">GUEST</span>
              <span>{t('portal:browsingAsGuest')}</span>
            </div>
          </div>
          {tiers.length > 0 && (
            <div className="space-y-4 max-w-sm mx-auto">
              <div className="space-y-2">
                {tiers.map(tier => (
                  <button
                    key={tier.id}
                    onClick={() => setSubscribeTierId(tier.id)}
                    className={`w-full text-left rounded-lg border p-4 transition-all ${subscribeTierId === tier.id ? 'border-primary/60 bg-primary/10' : 'border-white/10 bg-white/5 hover:border-white/20'}`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white font-semibold text-sm">{tier.name}</p>
                        {tier.description && <p className="text-muted-foreground text-xs mt-0.5">{tier.description}</p>}
                      </div>
                      <div className="text-right ml-4 flex-shrink-0">
                        <PriceWithFx
                          orgId={orgId}
                          amount={tier.annualFee}
                          currency={tier.currency}
                          productClass="membership_dues"
                          bookedClassName="text-primary font-bold text-sm"
                          disclosureClassName="text-[10px]"
                        />
                        <p className="text-muted-foreground text-xs">{t('portal:perYear')}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              <Button
                onClick={handleSubscribe}
                disabled={!subscribeTierId || subscribeLoading}
                className="w-full bg-primary hover:bg-primary/90 text-white gap-2"
              >
                {subscribeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                {t('portal:subscribeToMembership')}
              </Button>
            </div>
          )}
          {tiersLoading && <div className="text-center text-muted-foreground text-sm mt-4"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />{t('portal:loadingTiers')}</div>}
        </Card>
      </div>
    );
  }

  if (!membership) return <div data-testid="portal-membership-tab" />;

  return (
    <div data-testid="portal-membership-tab">
      <Card className="glass-panel border-white/10 p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-white font-semibold text-lg">{membership.firstName} {membership.lastName}</p>
            {membership.memberNumber && (
              <p className="text-xs text-muted-foreground mt-0.5">Member #{membership.memberNumber}</p>
            )}
            {membership.tierName && (
              <p className="text-sm text-primary mt-1 font-medium">{membership.tierName}</p>
            )}
          </div>
          <MembershipStatusBadge status={membership.subscriptionStatus} />
        </div>

        {/* Billing details */}
        <div className="grid grid-cols-2 gap-4 pt-2 border-t border-white/5">
          {membership.annualFee && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">{t('portal:annualFee')}</p>
              <PriceWithFx
                orgId={orgId}
                amount={membership.annualFee}
                currency={membership.currency || 'INR'}
                productClass="membership_dues"
                bookedClassName="text-white font-semibold"
              />
            </div>
          )}
          {membership.subscription?.nextBillingDate && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">{t('portal:nextBilling')}</p>
              <p className="text-white font-semibold">
                {new Date(membership.subscription.nextBillingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
              </p>
            </div>
          )}
          {membership.renewalDate && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">{t('portal:renewalDate')}</p>
              <p className="text-white font-semibold">
                {new Date(membership.renewalDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
              </p>
            </div>
          )}
          {membership.subscription?.failedPaymentCount !== null && membership.subscription?.failedPaymentCount !== undefined && membership.subscription.failedPaymentCount > 0 && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">{t('portal:failedPayments')}</p>
              <p className="text-red-400 font-semibold">{membership.subscription.failedPaymentCount}</p>
            </div>
          )}
        </div>

        {/* Status alert for past_due */}
        {membership.subscriptionStatus === 'past_due' && (
          <div className="flex items-start gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
            <ShieldAlert className="w-4 h-4 text-yellow-400 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-yellow-300">{t('portal:paymentPastDue')}</p>
          </div>
        )}

        {/* Card download + directory opt-in */}
        <div className="pt-3 border-t border-white/5 flex flex-wrap gap-3">
          <Button
            variant="outline"
            size="sm"
            className="border-primary/40 text-primary hover:bg-primary/10 gap-2"
            onClick={downloadMemberCard}
          >
            <Download className="w-4 h-4" />
            {t('portal:downloadMembershipCard')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={`gap-2 ${(showInDirectory ?? true) ? 'border-green-500/40 text-green-400 hover:bg-green-500/10' : 'border-white/20 text-muted-foreground hover:text-white'}`}
            onClick={() => handleDirectoryOptIn(!(showInDirectory ?? true))}
            disabled={directoryOptLoading}
          >
            {directoryOptLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
            {(showInDirectory ?? true) ? t('portal:listedInDirectory') : t('portal:addToDirectory')}
          </Button>
        </div>

        {/* Cancel subscription */}
        {membership.subscription && !['cancelled', 'expired'].includes(membership.subscription.status) && (
          <div className="pt-3 border-t border-white/5">
            <p className="text-xs text-muted-foreground mb-3">{t('portal:cancelAnytime')}</p>
            <Button
              variant="outline"
              size="sm"
              className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              onClick={handleCancelSubscription}
              disabled={cancelLoading}
            >
              {cancelLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <XCircle className="w-4 h-4 mr-2" />}
              {t('portal:cancelSubscription')}
            </Button>
          </div>
        )}

        {/* Cancelled state */}
        {membership.subscription?.status === 'cancelled' && (
          <div className="flex items-start gap-3 bg-gray-500/10 border border-gray-500/20 rounded-lg p-3">
            <XCircle className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-gray-400">{t('portal:subscriptionCancelledContact')}</p>
          </div>
        )}
      </Card>
    </div>
  );
}
