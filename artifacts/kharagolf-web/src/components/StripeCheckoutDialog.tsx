import { useEffect, useMemo, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface StripeCheckoutResult {
  stripe_payment_intent_id: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publishableKey: string;
  clientSecret: string;
  description?: string;
  amountLabel?: string;
  onSuccess: (result: StripeCheckoutResult) => void | Promise<void>;
  onCancel?: () => void;
}

const stripeCache = new Map<string, Promise<Stripe | null>>();
function getStripePromise(publishableKey: string): Promise<Stripe | null> {
  let p = stripeCache.get(publishableKey);
  if (!p) {
    p = loadStripe(publishableKey);
    stripeCache.set(publishableKey, p);
  }
  return p;
}

export function StripeCheckoutDialog({
  open, onOpenChange, publishableKey, clientSecret, description, amountLabel, onSuccess, onCancel,
}: Props) {
  const stripePromise = useMemo(() => getStripePromise(publishableKey), [publishableKey]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && onCancel) onCancel();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Complete your payment</DialogTitle>
          {(description || amountLabel) && (
            <DialogDescription>
              {description}
              {description && amountLabel ? " — " : ""}
              {amountLabel}
            </DialogDescription>
          )}
        </DialogHeader>

        {clientSecret ? (
          <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: "night" } }}>
            <StripePayForm
              onSuccess={onSuccess}
              onCancel={() => {
                onCancel?.();
                onOpenChange(false);
              }}
            />
          </Elements>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StripePayForm({
  onSuccess, onCancel,
}: {
  onSuccess: (result: StripeCheckoutResult) => void | Promise<void>;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => { setError(null); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        setError(submitError.message ?? "Could not validate card details.");
        return;
      }
      const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
        elements,
        redirect: "if_required",
      });
      if (confirmError) {
        setError(confirmError.message ?? "Payment failed.");
        return;
      }
      if (!paymentIntent) {
        setError("Payment did not complete. Please try again.");
        return;
      }
      if (paymentIntent.status === "succeeded" || paymentIntent.status === "processing" || paymentIntent.status === "requires_capture") {
        await onSuccess({ stripe_payment_intent_id: paymentIntent.id });
      } else {
        setError(`Payment status: ${paymentIntent.status}. Please try again.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected payment error.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement onReady={() => setReady(true)} />
      {error && (
        <div className="text-sm text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2">{error}</div>
      )}
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button type="submit" disabled={!stripe || !elements || submitting || !ready}>
          {submitting ? "Processing…" : "Pay now"}
        </Button>
      </div>
    </form>
  );
}
