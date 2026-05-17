-- Task #784 — Shared (cluster-wide) token-bucket store for the public,
-- unauthenticated marketing-site rate limiter. The previous in-process
-- Map gave each API replica its own bucket state, so a spammer behind
-- a load balancer effectively got N× the intended quota. One row per
-- logical bucket key (e.g. `photo:ip:1.2.3.4`, `review:course:42`),
-- read & mutated inside a single transaction with SELECT … FOR UPDATE
-- so concurrent requests can't double-spend a token.
CREATE TABLE IF NOT EXISTS "public_rate_limit_buckets" (
  "key" text PRIMARY KEY NOT NULL,
  "tokens" double precision NOT NULL,
  "last_refill_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "public_rate_limit_buckets_last_refill_at_idx"
  ON "public_rate_limit_buckets" ("last_refill_at");
