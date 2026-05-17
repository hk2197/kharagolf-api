-- Wave 0 / Task #935 W0-2 — first-course geometry ingest.
-- Seeds a small set of in-house features for course id=50 (JSW Vijaynagar
-- Golf Club, our KHARAGOLF demo course) so the GET geometry API has
-- something real to return end-to-end. Idempotent: skipped if any row
-- for this course already exists.


-- post-merge-guard: fresh-DB guard (table:course_hole_geometry)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'course_hole_geometry') AS post_merge_dep_present \gset
\if :post_merge_dep_present

DO $$
DECLARE
  v_course_id INTEGER := 50;
BEGIN
  IF EXISTS (SELECT 1 FROM courses WHERE id = v_course_id) AND NOT EXISTS (SELECT 1 FROM course_hole_geometry WHERE course_id = v_course_id) THEN
    INSERT INTO course_hole_geometry (course_id, hole_number, feature_type, geometry, source, label, metadata) VALUES
      (v_course_id, 1, 'tee_box',
        '{"type":"Polygon","coordinates":[[[76.6310,15.1745],[76.6311,15.1745],[76.6311,15.1746],[76.6310,15.1746],[76.6310,15.1745]]]}'::jsonb,
        'in_house', 'Hole 1 Championship Tee', '{}'::jsonb),
      (v_course_id, 1, 'fairway',
        '{"type":"Polygon","coordinates":[[[76.6311,15.1746],[76.6325,15.1748],[76.6326,15.1750],[76.6312,15.1748],[76.6311,15.1746]]]}'::jsonb,
        'in_house', 'Hole 1 Fairway', '{}'::jsonb),
      (v_course_id, 1, 'green',
        '{"type":"Polygon","coordinates":[[[76.6325,15.1748],[76.6328,15.1748],[76.6328,15.1750],[76.6325,15.1750],[76.6325,15.1748]]]}'::jsonb,
        'in_house', 'Hole 1 Green', '{"surfaceArea":420}'::jsonb),
      (v_course_id, 1, 'hazard_bunker',
        '{"type":"Polygon","coordinates":[[[76.6322,15.1747],[76.6324,15.1747],[76.6324,15.1748],[76.6322,15.1748],[76.6322,15.1747]]]}'::jsonb,
        'in_house', 'Hole 1 Front-right Bunker', '{}'::jsonb),
      (v_course_id, 1, 'cart_path',
        '{"type":"LineString","coordinates":[[76.6310,15.1744],[76.6320,15.1745],[76.6328,15.1747]]}'::jsonb,
        'in_house', 'Hole 1 Cart Path', '{}'::jsonb);
    RAISE NOTICE 'Seeded course geometry for course_id=%', v_course_id;
  ELSE
    RAISE NOTICE 'Course geometry already present for course_id=% — skipped', v_course_id;
  END IF;
END $$;

\else
\echo 'parent table course_hole_geometry not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

