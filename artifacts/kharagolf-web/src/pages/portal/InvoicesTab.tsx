import { Download, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { Card } from '@/components/ui/card';
import { PriceWithFx } from '@/components/PriceWithFx';
import type { DuesInvoice } from './types';

interface InvoicesTabProps {
  invoices: DuesInvoice[];
  orgId: number | null;
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'text-zinc-400',
  sent: 'text-blue-400',
  paid: 'text-green-400',
  overdue: 'text-red-400',
  cancelled: 'text-zinc-500',
  void: 'text-zinc-500',
};

export function InvoicesTab({ invoices, orgId }: InvoicesTabProps) {
  const { t } = useTranslation(['portal']);

  return (
    <div className="space-y-3" data-testid="portal-invoices-tab">
      {invoices.length === 0 ? (
        <Card className="glass-panel border-white/10 p-12 text-center">
          <FileText className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
          <p className="text-muted-foreground">No invoices found.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {invoices.map(inv => {
            const isPaid = inv.status === 'paid';
            const isOverdue = inv.status === 'overdue';
            return (
              <Card key={inv.id} className="glass-panel border-white/10 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <p className="font-mono text-xs text-white">{inv.invoiceNumber}</p>
                      <span className={`text-xs font-medium ${STATUS_COLOR[inv.status] ?? 'text-zinc-400'}`}>{t(`portal:invoices.statuses.${inv.status}`, { defaultValue: inv.status })}</span>
                    </div>
                    <PriceWithFx
                      orgId={orgId}
                      amount={inv.totalAmount}
                      currency={inv.currency}
                      productClass="membership_dues"
                      bookedClassName="text-lg font-bold text-white"
                    />
                    {inv.dueDate && (
                      <p className={`text-xs mt-0.5 ${isOverdue ? 'text-red-400' : 'text-muted-foreground'}`}>
                        {isOverdue ? t('portal:invoices.overdueSince') : t('portal:invoices.due')}: {new Date(inv.dueDate).toLocaleDateString(i18n.language || undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                      </p>
                    )}
                    {isPaid && inv.paidAt && (
                      <p className="text-xs text-green-400 mt-0.5">{t('portal:invoices.paidOn', { date: new Date(inv.paidAt).toLocaleDateString(i18n.language || undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })}</p>
                    )}
                  </div>
                  {inv.razorpayPaymentLinkUrl && !isPaid && (
                    <a
                      href={inv.razorpayPaymentLinkUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg bg-primary text-white hover:bg-primary/80 transition-colors"
                    >
                      Pay Now
                    </a>
                  )}
                  {isPaid && (
                    <a
                      href={`/api/payments/dues-invoice/${inv.id}/receipt`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-shrink-0 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border border-white/10 text-white hover:bg-white/5 transition-colors"
                    >
                      <Download className="w-3 h-3" /> {t('portal:downloadReceipt', { defaultValue: 'Receipt' })}
                    </a>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
