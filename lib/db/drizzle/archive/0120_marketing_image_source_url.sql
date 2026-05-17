-- Task #1467 — Periodic refresh of cached marketing logos / favicons.
--
-- Task #1250 snapshots admin-supplied external `logoImageUrl` /
-- `faviconUrl` bytes into our own object storage at save time. The
-- persisted column then points at the cached internal /api/storage/...
-- URL so the public mini-site never has to hit the third-party host
-- once the snapshot is in place. But if the source image at the
-- original URL changes (a club rebrands, a CDN rotates the file), the
-- cached copy goes stale forever.
--
-- This migration records the original external URL alongside the
-- cached one so a background job can periodically re-fetch it and
-- rotate the cache when the bytes differ. Internal /objects/... paths
-- and direct uploads have no `*_source_url` set and are skipped by the
-- refresh job — there is no upstream to compare against.
--
-- Columns:
--   * <kind>_source_url             — original http(s) URL the admin
--                                     pasted in. NULL for direct
--                                     uploads / internal paths or for
--                                     legacy rows saved before this
--                                     column existed.
--   * <kind>_source_last_refreshed_at — when the refresh job last
--                                     attempted to re-download the
--                                     source URL (used for the per-row
--                                     ~weekly backoff).
--   * <kind>_source_last_refresh_error — human-readable error from the
--                                     most recent failed refresh, or
--                                     NULL on success. The cached copy
--                                     is preserved on failure; this
--                                     column only records that we
--                                     tried.

ALTER TABLE "club_marketing_sites"
  ADD COLUMN IF NOT EXISTS "logo_source_url" text,
  ADD COLUMN IF NOT EXISTS "logo_source_last_refreshed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "logo_source_last_refresh_error" text,
  ADD COLUMN IF NOT EXISTS "favicon_source_url" text,
  ADD COLUMN IF NOT EXISTS "favicon_source_last_refreshed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "favicon_source_last_refresh_error" text;
