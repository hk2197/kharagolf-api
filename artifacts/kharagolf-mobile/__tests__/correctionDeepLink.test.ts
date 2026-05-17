/**
 * Task #1615 — Shared deep-link builder used by both mobile entry points
 * into the portal "Report a course data error" form:
 *   - HoleMapSheet's per-hole "Report an error on hole N" link
 *     (artifacts/kharagolf-mobile/components/HoleMapSheet.tsx)
 *   - general-play screen's course-level "Report a course data error" link
 *     (artifacts/kharagolf-mobile/app/general-play/[id].tsx)
 *
 * The portal form pre-fills both the "current value" and "your suggestion"
 * inputs from the `currentValue` query param, so this builder must:
 *   - Forward `currentValue` whenever the linking screen knows it
 *   - OMIT `currentValue` when the value is null/undefined/empty, so we never
 *     invent a value the player didn't actually see on screen
 *   - Keep param order stable across the two call sites so the URL contract
 *     is predictable (existing tests assert exact strings).
 */
import { describe, it, expect } from 'vitest';
import { buildCorrectionDeepLink } from '../utils/correctionDeepLink';

const BASE = 'https://kharagolf.test';

describe('buildCorrectionDeepLink', () => {
  it('builds the per-hole URL with hole + currentValue (HoleMapSheet path)', () => {
    expect(
      buildCorrectionDeepLink({
        baseUrl: BASE,
        courseId: 42,
        hole: 7,
        field: 'par',
        currentValue: 4,
      }),
    ).toBe(
      'https://kharagolf.test/portal/course-corrections?courseId=42&hole=7&field=par&currentValue=4',
    );
  });

  it('builds the course-level URL without hole, with coursePar (general-play path)', () => {
    expect(
      buildCorrectionDeepLink({
        baseUrl: BASE,
        courseId: 42,
        field: 'par',
        currentValue: 72,
      }),
    ).toBe(
      'https://kharagolf.test/portal/course-corrections?courseId=42&field=par&currentValue=72',
    );
  });

  it('omits currentValue when null (per-hole, e.g. par missing from bundle)', () => {
    const url = buildCorrectionDeepLink({
      baseUrl: BASE,
      courseId: 42,
      hole: 7,
      field: 'par',
      currentValue: null,
    });
    expect(url).toBe(
      'https://kharagolf.test/portal/course-corrections?courseId=42&hole=7&field=par',
    );
    expect(url).not.toContain('currentValue');
  });

  it('omits currentValue when null (course-level, e.g. legacy round with no coursePar)', () => {
    const url = buildCorrectionDeepLink({
      baseUrl: BASE,
      courseId: 42,
      field: 'par',
      currentValue: null,
    });
    expect(url).toBe(
      'https://kharagolf.test/portal/course-corrections?courseId=42&field=par',
    );
    expect(url).not.toContain('currentValue');
  });

  it('defaults the field to "par" when not specified', () => {
    const url = buildCorrectionDeepLink({
      baseUrl: BASE,
      courseId: 42,
      hole: 7,
    });
    expect(url).toContain('field=par');
  });

  it('keeps param order stable (courseId, hole, field, currentValue)', () => {
    // The web-side report-error tests assert exact URL strings, and the
    // hole/field/currentValue ordering matters for that contract. Lock it
    // in here so a future refactor doesn't silently flip it.
    const url = buildCorrectionDeepLink({
      baseUrl: BASE,
      courseId: 1,
      hole: 2,
      field: 'yardage',
      currentValue: '380',
    });
    expect(url).toBe(
      'https://kharagolf.test/portal/course-corrections?courseId=1&hole=2&field=yardage&currentValue=380',
    );
  });
});
