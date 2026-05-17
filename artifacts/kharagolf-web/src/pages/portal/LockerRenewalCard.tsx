import { Lock, CreditCard, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PriceWithFx } from '@/components/PriceWithFx';

export interface LockerCardAssignment {
  id: number;
  lockerNumber: string;
  bay: string | null;
  expiryDate: string;
  startDate?: string;
  status?: string;
  annualFee: string;
  currency: string;
  paymentStatus: string;
  paymentLinkUrl: string | null;
}

/**
 * Renders a member's assigned-locker renewal card. Extracted from the
 * 3000-line `PlayerPortal` (Task #820) so the FX-aware annual fee row can be
 * regression-tested in isolation — the previous incarnation rendered the
 * booked-currency-only Text/span, so we now assert that a `<PriceWithFx>` is
 * mounted with the locker fee and produces an "Approx." line when the
 * member's preferred display currency differs from the booked currency.
 */
export function LockerRenewalCard({
  assignment,
  orgId,
}: {
  assignment: LockerCardAssignment;
  orgId: number | null | undefined;
}) {
  const { t } = useTranslation(['portal', 'common']);
  const days = Math.ceil(
    (new Date(assignment.expiryDate).getTime() - Date.now()) / 86400000,
  );

  return (
    <Card
      data-testid="locker-renewal-card"
      className="glass-panel border-white/10 p-6 space-y-5"
    >
      <div className="flex items-center gap-2 mb-2">
        <Lock className="w-5 h-5 text-primary" />
        <h3 className="text-white font-semibold text-base">
          {t('portal:tabs.myLocker')}
        </h3>
        <Badge
          className={`ml-auto text-xs ${
            assignment.paymentStatus === 'paid'
              ? 'bg-green-500/20 text-green-400 border-green-500/30'
              : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
          }`}
        >
          {assignment.paymentStatus === 'paid'
            ? t('common:paid')
            : t('portal:paymentPending')}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white/[0.04] rounded-xl p-4 border border-white/10">
          <p className="text-xs text-muted-foreground mb-1">Locker Number</p>
          <p className="text-white font-semibold text-xl font-mono">
            {assignment.lockerNumber}
          </p>
          {assignment.bay && (
            <p className="text-xs text-muted-foreground mt-1">
              Bay: {assignment.bay}
            </p>
          )}
        </div>
        <div className="bg-white/[0.04] rounded-xl p-4 border border-white/10">
          <p className="text-xs text-muted-foreground mb-1">Expires</p>
          <p className="text-white font-semibold">
            {new Date(assignment.expiryDate).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </p>
          {days <= 30 ? (
            <p
              className={`text-xs mt-1 ${
                days <= 7 ? 'text-red-400' : 'text-yellow-400'
              }`}
            >
              {days > 0 ? `${days} days remaining` : 'Expired'}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">
              {days} days remaining
            </p>
          )}
        </div>
      </div>
      <div
        data-testid="locker-renewal-fee"
        className="bg-white/[0.04] rounded-xl p-4 border border-white/10"
      >
        <p className="text-xs text-muted-foreground mb-1">
          {t('portal:annualFee')}
        </p>
        <PriceWithFx
          orgId={orgId ?? null}
          amount={assignment.annualFee}
          currency={assignment.currency}
          productClass="locker_rental"
          bookedClassName="text-white font-semibold"
        />
      </div>
      {assignment.paymentStatus !== 'paid' && assignment.paymentLinkUrl && (
        <a
          href={assignment.paymentLinkUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
        >
          <Button className="w-full bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
            <CreditCard className="w-4 h-4" />
            {t('portal:payLockerFee')}
            <ExternalLink className="w-3.5 h-3.5" />
          </Button>
        </a>
      )}
    </Card>
  );
}

export default LockerRenewalCard;
