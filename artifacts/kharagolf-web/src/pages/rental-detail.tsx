import { useEffect, useState } from 'react';
import { useRoute, useLocation } from 'wouter';
import {
  ChevronLeft, Loader2, Briefcase, Calendar, Clock, AlertTriangle,
  CheckCircle2, PackageCheck, XCircle, ShieldAlert, Tag, Receipt,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

interface RentalDetail {
  id: number;
  organizationId: number;
  assetId: number;
  teeBookingId: number | null;
  memberId: number | null;
  bookedByUserId: number | null;
  memberName: string | null;
  status: 'reserved' | 'checked_out' | 'returned' | 'cancelled';
  rentalDate: string;
  expectedReturnAt: string | null;
  checkedOutAt: string | null;
  returnedAt: string | null;
  rateCharged: string | null;
  currency: string;
  damageReported: boolean;
  damageNotes: string | null;
  damagePhotoUrls: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  assetCode: string;
  assetDescription: string | null;
  categoryId: number;
  categoryName: string;
  categoryIcon: string;
}

const STATUS_META: Record<RentalDetail['status'], { label: string; className: string; Icon: typeof Clock }> = {
  reserved: { label: 'Reserved', className: 'bg-amber-500/20 text-amber-300 border-amber-500/30', Icon: Calendar },
  checked_out: { label: 'Checked out', className: 'bg-blue-500/20 text-blue-300 border-blue-500/30', Icon: PackageCheck },
  returned: { label: 'Returned', className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30', Icon: CheckCircle2 },
  cancelled: { label: 'Cancelled', className: 'bg-red-500/20 text-red-300 border-red-500/30', Icon: XCircle },
};

function formatMoney(amount: string | number | null, currency: string): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${currency} ${amount}`;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

export default function RentalDetailPage() {
  const [, params] = useRoute('/rentals/bookings/:bookingId');
  const [, navigate] = useLocation();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number | undefined;
  const bookingId = params?.bookingId ? Number(params.bookingId) : NaN;

  const [booking, setBooking] = useState<RentalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guard: invalid route param (e.g. /rentals/bookings/abc). Surface
    // the same not-found state as the API 404 path so the user sees a
    // clear message instead of a perpetual loading spinner. Without
    // this the early-return below leaves `loading` stuck at true.
    if (!Number.isFinite(bookingId)) {
      setLoading(false);
      setError('not_found');
      return;
    }
    // Wait for `useGetMe` to resolve the caller's orgId before fetching.
    if (!orgId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/organizations/${orgId}/rentals/bookings/${bookingId}/mine`, { credentials: 'include' })
      .then(async r => {
        if (r.status === 404) throw new Error('not_found');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<RentalDetail>;
      })
      .then(d => { if (!cancelled) { setBooking(d); setLoading(false); } })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error && e.message === 'not_found' ? 'not_found' : 'load_failed');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [orgId, bookingId]);

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-3xl" data-testid="rental-detail-page">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => navigate('/portal')}
        className="mb-4 text-muted-foreground hover:text-white"
        data-testid="back-to-portal"
      >
        <ChevronLeft className="w-4 h-4 mr-1" /> Back to portal
      </Button>

      <div className="flex items-center gap-2 mb-4">
        <Briefcase className="w-5 h-5 text-primary" />
        <h1 className="text-2xl font-bold text-white">Equipment Rental</h1>
      </div>

      {loading ? (
        <Card className="glass-panel border-white/10 p-8 flex items-center gap-3 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading rental…
        </Card>
      ) : error === 'not_found' ? (
        <Card className="glass-panel border-white/10 p-8 text-center" data-testid="rental-not-found">
          <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto mb-3" />
          <p className="text-white font-semibold mb-1">Rental not found</p>
          <p className="text-sm text-muted-foreground">
            We couldn't find this rental on your account. It may have been removed or it isn't yours to view.
          </p>
        </Card>
      ) : error ? (
        <Card className="glass-panel border-white/10 p-8 text-center" data-testid="rental-error">
          <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-white font-semibold mb-1">Couldn't load rental</p>
          <p className="text-sm text-muted-foreground">Please refresh the page to try again.</p>
        </Card>
      ) : booking ? (
        <RentalBody
          booking={booking}
          orgId={orgId!}
          onCancelled={updated => setBooking(updated)}
        />
      ) : null}
    </div>
  );
}

function RentalBody({
  booking,
  orgId,
  onCancelled,
}: {
  booking: RentalDetail;
  orgId: number;
  onCancelled: (updated: RentalDetail) => void;
}) {
  const meta = STATUS_META[booking.status];
  const StatusIcon = meta.Icon;
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Only an unfulfilled reservation can be cancelled by the member; once a
  // booking has been checked out, returned, or already cancelled it is a
  // no-op state and the action is hidden entirely (Task #2146).
  const canCancel = booking.status === 'reserved';

  async function handleConfirmCancel() {
    setCancelling(true);
    try {
      const r = await fetch(
        `/api/organizations/${orgId}/rentals/bookings/${booking.id}/cancel/mine`,
        { method: 'POST', credentials: 'include' },
      );
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const body = await r.json();
          if (body && typeof body.error === 'string') msg = body.error;
        } catch { /* non-JSON error body — keep generic message */ }
        throw new Error(msg);
      }
      const updated = (await r.json()) as RentalDetail;
      onCancelled(updated);
      setConfirmOpen(false);
      toast({ title: 'Booking cancelled' });
    } catch (e) {
      toast({
        title: "Couldn't cancel booking",
        description: e instanceof Error ? e.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="rental-detail-body">
      <Card className="glass-panel border-white/10 p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-xs text-muted-foreground">Booking</p>
            <p className="text-xl font-bold text-white" data-testid="rental-id">#{booking.id}</p>
          </div>
          <Badge className={`${meta.className} flex items-center gap-1`} data-testid="rental-status">
            <StatusIcon className="w-3 h-3" />
            {meta.label}
          </Badge>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <Row icon={Tag} label="Item">
            <span data-testid="rental-asset">{booking.categoryName} · {booking.assetCode}</span>
            {booking.assetDescription ? (
              <span className="block text-xs text-muted-foreground">{booking.assetDescription}</span>
            ) : null}
          </Row>
          <Row icon={Receipt} label="Rate charged">
            <span data-testid="rental-rate">
              {formatMoney(booking.rateCharged, booking.currency)}
            </span>
          </Row>
          <Row icon={Calendar} label="Rental date">{formatDate(booking.rentalDate)}</Row>
          <Row icon={Clock} label="Expected return">{formatDateTime(booking.expectedReturnAt)}</Row>
          {booking.checkedOutAt ? (
            <Row icon={PackageCheck} label="Checked out">{formatDateTime(booking.checkedOutAt)}</Row>
          ) : null}
          {booking.returnedAt ? (
            <Row icon={CheckCircle2} label="Returned">{formatDateTime(booking.returnedAt)}</Row>
          ) : null}
        </div>
      </Card>

      {booking.damageReported ? (
        <Card className="glass-panel border-amber-500/30 p-5" data-testid="rental-damage">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Damage reported</h2>
          </div>
          {booking.damageNotes ? (
            <p className="text-sm text-white whitespace-pre-wrap">{booking.damageNotes}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No additional notes.</p>
          )}
          {booking.damagePhotoUrls && booking.damagePhotoUrls.length > 0 ? (
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {booking.damagePhotoUrls.map((url, i) => (
                <a key={i} href={url} target="_blank" rel="noreferrer" className="block">
                  <img
                    src={url}
                    alt={`Damage photo ${i + 1}`}
                    className="w-full h-24 object-cover rounded border border-white/10"
                  />
                </a>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      {booking.notes ? (
        <Card className="glass-panel border-white/10 p-5">
          <p className="text-xs text-muted-foreground mb-1">Booking notes</p>
          <p className="text-sm text-white whitespace-pre-wrap">{booking.notes}</p>
        </Card>
      ) : null}

      {canCancel ? (
        <Card className="glass-panel border-white/10 p-5" data-testid="rental-cancel-card">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-white">Plans changed?</p>
              <p className="text-xs text-muted-foreground">
                You can cancel this rental until it's checked out at the pro shop.
              </p>
            </div>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirmOpen(true)}
              data-testid="button-cancel-rental"
            >
              <XCircle className="w-4 h-4 mr-1" /> Cancel booking
            </Button>
          </div>
        </Card>
      ) : null}

      <AlertDialog
        open={confirmOpen}
        onOpenChange={open => { if (!cancelling) setConfirmOpen(open); }}
      >
        <AlertDialogContent data-testid="dialog-confirm-cancel-rental">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this rental?</AlertDialogTitle>
            <AlertDialogDescription>
              {booking.categoryName} · {booking.assetCode} on {formatDate(booking.rentalDate)} will
              be released. You'll need to book again if you change your mind.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling} data-testid="button-cancel-rental-dismiss">
              Keep booking
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelling}
              onClick={e => {
                // Prevent the AlertDialogAction default close-on-click so we
                // can keep the dialog open while the request is in flight
                // and only dismiss it on success (or surface the error toast
                // on failure).
                e.preventDefault();
                void handleConfirmCancel();
              }}
              data-testid="button-cancel-rental-confirm"
            >
              {cancelling ? (
                <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Cancelling…</>
              ) : (
                'Cancel booking'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Clock;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="text-white">{children}</div>
      </div>
    </div>
  );
}
