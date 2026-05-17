-- Task #974 — Audit log of inbound Stripe webhook deliveries so admins can
-- confirm Stripe is actually delivering real events (not just the synthetic
-- "Send test event" probe), spot 401s caused by a rotated webhook secret,
-- and see at-a-glance how many deliveries were applied vs ignored.
CREATE TABLE IF NOT EXISTS "stripe_webhook_deliveries" (
  "id" serial PRIMARY KEY NOT NULL,
  "event_id" text,
  "event_type" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source_ip" text,
  "signature_valid" boolean,
  "applied" boolean DEFAULT false NOT NULL,
  "response_status" integer NOT NULL
);

CREATE INDEX IF NOT EXISTS "stripe_webhook_deliveries_received_at_idx"
  ON "stripe_webhook_deliveries" ("received_at");
