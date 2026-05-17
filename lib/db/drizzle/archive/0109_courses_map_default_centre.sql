-- Task #1312 — "Remember each course's location so the mapper opens there next time."
--
-- The course mapper (artifacts/kharagolf-web/src/pages/course-mapper.tsx)
-- already has a Nominatim place-search box, but every reopen of an empty
-- course still drops the admin at the [20, 0] world view, forcing them
-- to search again. We add three nullable columns to `courses` so the
-- mapper can persist the centre an admin lands on (either by picking a
-- search result or saving the first feature) and fly straight there on
-- the next open.
--
-- Kept separate from the existing `courses.latitude` / `courses.longitude`
-- columns because those feed the weather correlation, the public course
-- page and member-app marker placement; conflating "where the admin
-- pans the mapper" with "the canonical course location" would silently
-- move the course on those unrelated surfaces.

ALTER TABLE "courses"
  ADD COLUMN IF NOT EXISTS "map_default_lat"  numeric(10, 7),
  ADD COLUMN IF NOT EXISTS "map_default_lng"  numeric(10, 7),
  ADD COLUMN IF NOT EXISTS "map_default_zoom" integer;
