import { Calendar, Clock, Loader2, MapPin, RefreshCcw, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PriceWithFx } from '@/components/PriceWithFx';
import { useHighlightFromQuery, useHighlightTarget } from '@/hooks/use-highlight-row';
import type { MyTeeBooking } from './types';

interface TeeBookingsTabProps {
  bookings: MyTeeBooking[];
  setBookings: React.Dispatch<React.SetStateAction<MyTeeBooking[]>>;
  orgId: number | null;
  cancellingBookingId: number | null;
  setCancellingBookingId: React.Dispatch<React.SetStateAction<number | null>>;
}

export function TeeBookingsTab({ bookings, setBookings, orgId, cancellingBookingId, setCancellingBookingId }: TeeBookingsTabProps) {
  const { t } = useTranslation(['portal', 'common']);
  // Deep-link from /portal?tab=tee-bookings&id=N (used by the "My Upcoming"
  // widget) so a tap on a tee-time row scrolls to and flashes the booking.
  const { highlightId, consume: consumeHighlight } = useHighlightFromQuery('id');

  return (
    <div className="space-y-3" data-testid="portal-tee-bookings-tab">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-white font-semibold text-base flex items-center gap-2">
          <Clock className="w-4 h-4 text-primary" /> My Tee Time Bookings
        </h3>
        <Button
          size="sm" variant="outline"
          onClick={() => {
            if (orgId) {
              fetch(`/api/organizations/${orgId}/marketplace/my-bookings`, { credentials: 'include' })
                .then(r => r.ok ? r.json() : [])
                .then((b: MyTeeBooking[]) => setBookings(Array.isArray(b) ? b : []))
                .catch(() => {});
            }
          }}
          className="gap-1.5 text-xs"
        >
          <RefreshCcw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {bookings.length === 0 ? (
        <Card className="glass-panel border-white/10 p-12 text-center">
          <Calendar className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
          <p className="text-muted-foreground">No tee time bookings found.</p>
          <p className="text-xs text-muted-foreground mt-1">Book a tee time via your club's public booking page.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {bookings.map(b => {
            const slotDateObj = new Date(b.slotDate);
            const isPast = slotDateObj < new Date();
            const isCancelled = !!b.cancelledAt || b.paymentStatus === 'cancelled';
            const statusColor = isCancelled
              ? 'text-red-400'
              : b.paymentStatus === 'confirmed'
                ? 'text-green-400'
                : 'text-amber-400';

            return (
              <TeeBookingCard
                key={b.id}
                isHighlight={highlightId === b.id}
                onConsumeHighlight={consumeHighlight}
                isCancelled={isCancelled}
                testId={`portal-tee-booking-${b.id}`}
              >
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex flex-col items-center justify-center shrink-0">
                    <span className="text-[10px] text-primary font-semibold uppercase">
                      {slotDateObj.toLocaleDateString('en-IN', { month: 'short' })}
                    </span>
                    <span className="text-lg font-bold text-primary leading-none">
                      {slotDateObj.getDate()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-semibold text-white text-sm">
                        {slotDateObj.toLocaleTimeString(i18n.language || undefined, { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
                      </span>
                      <span className={`text-xs font-medium capitalize ${statusColor}`}>
                        {isCancelled ? t('common:cancelled') : b.paymentStatus}
                      </span>
                      {b.players > 1 && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Users className="w-3 h-3" /> {t('portal:playersCount', { count: b.players })}
                        </span>
                      )}
                    </div>
                    {b.courseName && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPin className="w-3 h-3" /> {b.courseName} · Hole {b.startingHole}
                      </p>
                    )}
                    {b.amountPaise > 0 && !isCancelled && (
                      <div className="text-xs text-green-400 mt-0.5 flex items-baseline gap-1 flex-wrap">
                        <PriceWithFx
                          orgId={orgId}
                          amount={b.amountPaise / 100}
                          currency="INR"
                          productClass="tee_time"
                          bookedClassName="text-green-400"
                          disclosureClassName="text-[10px]"
                        />
                        <span>{t('common:paid', { defaultValue: 'paid' }).toLowerCase()}</span>
                      </div>
                    )}
                    {b.notes && <p className="text-xs text-muted-foreground italic mt-0.5">{b.notes}</p>}
                  </div>
                  {!isCancelled && !isPast && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 text-red-500 hover:text-red-400 border-red-500/30 hover:border-red-400/40 text-xs"
                      disabled={cancellingBookingId === b.id}
                      onClick={async () => {
                        if (!confirm(t('portal:confirmCancelTeeTime'))) return;
                        if (!orgId) return;
                        setCancellingBookingId(b.id);
                        try {
                          const r = await fetch(`/api/organizations/${orgId}/marketplace/${b.slotId}/cancel/${b.id}`, {
                            method: 'POST', credentials: 'include',
                          });
                          if (!r.ok) {
                            const e = await r.json().catch(() => ({}));
                            alert(e.error ?? t('portal:couldNotCancelBooking'));
                          } else {
                            setBookings(prev => prev.map(bk => bk.id === b.id ? { ...bk, cancelledAt: new Date().toISOString(), paymentStatus: 'cancelled' } : bk));
                          }
                        } catch { alert(t('portal:networkError')); }
                        finally { setCancellingBookingId(null); }
                      }}
                    >
                      {cancellingBookingId === b.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('common:cancel')}
                    </Button>
                  )}
                </div>
              </TeeBookingCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TeeBookingCard({
  isHighlight,
  onConsumeHighlight,
  isCancelled,
  testId,
  children,
}: {
  isHighlight: boolean;
  onConsumeHighlight: () => void;
  isCancelled: boolean;
  testId: string;
  children: React.ReactNode;
}) {
  const setHighlightRef = useHighlightTarget<HTMLDivElement>(isHighlight, onConsumeHighlight);
  return (
    <Card
      ref={setHighlightRef}
      className={`glass-panel border-white/10 p-4 ${isCancelled ? 'opacity-60' : ''}`}
      data-testid={testId}
    >
      {children}
    </Card>
  );
}
