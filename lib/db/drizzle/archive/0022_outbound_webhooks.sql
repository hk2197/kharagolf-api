-- Task #149: Outbound Webhook API
-- Add webhook_endpoints and webhook_delivery_log tables

CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "secret" text NOT NULL,
  "subscribed_events" text[] NOT NULL DEFAULT '{}',
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webhook_endpoints_org_idx" ON "webhook_endpoints" ("organization_id");

CREATE TABLE IF NOT EXISTS "webhook_delivery_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "endpoint_id" integer NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status_code" integer,
  "response_time_ms" integer,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_attempted_at" timestamptz,
  "delivered_at" timestamptz,
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webhook_delivery_log_endpoint_idx" ON "webhook_delivery_log" ("endpoint_id");
CREATE INDEX IF NOT EXISTS "webhook_delivery_log_event_idx" ON "webhook_delivery_log" ("event_type");
