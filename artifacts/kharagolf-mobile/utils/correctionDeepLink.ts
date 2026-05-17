/**
 * Task #1615 — Build the portal "Report a course data error" deep-link URL
 * shared by the mobile entry points (HoleMapSheet's per-hole link and the
 * general-play screen's course-level link).
 *
 * The portal form (artifacts/kharagolf-web/src/pages/portal/course-corrections.tsx)
 * accepts these query params:
 *   - courseId   (required) — pins the course <select>
 *   - hole       (1-18)     — optional per-hole context
 *   - field                  — par | yardage | handicap | …; defaults to "par"
 *   - currentValue           — pre-fills BOTH the "current value" and the
 *                              "your suggestion" inputs so the player only
 *                              edits the digit they want to change.
 *
 * We deliberately omit `currentValue` when it's null/undefined rather than
 * sending an empty string, so we never invent a value the player didn't
 * actually see on screen — the portal then leaves the suggestion blank.
 */
export interface CorrectionDeepLinkOptions {
  baseUrl: string;
  courseId: number | string;
  hole?: number | null;
  field?: string;
  currentValue?: string | number | null;
}

export function buildCorrectionDeepLink(opts: CorrectionDeepLinkOptions): string {
  const params = new URLSearchParams({
    courseId: String(opts.courseId),
    field: opts.field ?? 'par',
  });
  if (opts.hole != null) params.set('hole', String(opts.hole));
  if (opts.currentValue != null && String(opts.currentValue).length > 0) {
    params.set('currentValue', String(opts.currentValue));
  }
  // URLSearchParams puts entries in insertion order — keep the param order
  // stable (courseId, hole, field, currentValue) so existing tests asserting
  // exact URLs don't have to care about hash ordering.
  const ordered = new URLSearchParams();
  for (const key of ['courseId', 'hole', 'field', 'currentValue']) {
    const value = params.get(key);
    if (value != null) ordered.set(key, value);
  }
  return `${opts.baseUrl}/portal/course-corrections?${ordered.toString()}`;
}
