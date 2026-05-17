-- Task #690 — Persist the per-(user, round) GPS chunk buffer.
--
-- Task #525 introduced a buffered stream of GPS samples the phone uploads
-- every few minutes during a round via /portal/shots/ingest. That buffer
-- previously lived in a process-local Map, so an api-server restart mid-
-- round dropped every chunked sample and the round-end commit detect call
-- saw fewer shots than it should. This table moves that buffer into
-- Postgres so chunks survive deploys, autoscale, and crashes.
--
-- The unique index on (user_id, context_key, sample_timestamp_ms) gives
-- free idempotency for retried chunks via ON CONFLICT DO NOTHING — a
-- network-retried chunk contributes zero new rows. Rows older than the 8h
-- TTL are pruned on every read/write (per-context) and by an opportunistic
-- global sweep so abandoned rounds eventually get reaped.

CREATE TABLE IF NOT EXISTS "gps_chunk_buffer" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "context_key" text NOT NULL,
  "sample_timestamp_ms" numeric(16, 0) NOT NULL,
  "lat" numeric(10, 7) NOT NULL,
  "lng" numeric(10, 7) NOT NULL,
  "accuracy_m" numeric(8, 2),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "gps_chunk_buffer_user_ctx_ts_uniq"
  ON "gps_chunk_buffer" ("user_id", "context_key", "sample_timestamp_ms");

-- Supports the global TTL prune which scans by sample_timestamp_ms only.
CREATE INDEX IF NOT EXISTS "gps_chunk_buffer_sample_ts_idx"
  ON "gps_chunk_buffer" ("sample_timestamp_ms");

CREATE INDEX IF NOT EXISTS "gps_chunk_buffer_created_idx"
  ON "gps_chunk_buffer" ("created_at");
