/**
 * Task #1174 — pre-fill the portal course-corrections form from query params.
 *
 * The course/hole detail pages now link to
 *   /portal/course-corrections?courseId=X&hole=Y&field=par&currentValue=4
 * and this page reads those params on mount so the player doesn't have to
 * re-type the course id / hole / field / current value they already came from.
 *
 * Coverage:
 *   - valid params populate the course <select>, hole input and field <select>
 *   - invalid / out-of-range params are ignored (form falls back to defaults)
 *   - the prefill notice is shown only when at least one param was honoured
 *   - the params are stripped from the URL after consumption (so a refresh
 *     doesn't re-pin them after the user has tweaked the form)
 *   - Task #1351: the `currentValue` param pre-fills the "current value" input
 *     (trimmed and length-capped), is enough on its own to trigger the prefill
 *     notice, and is stripped from the URL alongside the other deep-link params
 *   - Task #1615: when `currentValue` is supplied, the "Proposed value" input
 *     is also pre-filled with the same value so the player only edits the
 *     digit they want to change. Without `currentValue`, the proposed input
 *     stays blank (so we never invent a suggestion the player didn't see).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const navigate = vi.fn();
let currentSearch = '';

vi.mock('wouter', () => ({
  useLocation: () => ['/portal/course-corrections', navigate],
  useSearch: () => currentSearch,
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import PortalCourseCorrectionsPage from '../course-corrections';

const COURSES = [
  { id: 42, name: 'Pebble Beach' },
  { id: 99, name: 'Augusta National' },
];

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/portal/me')) {
      return new Response(JSON.stringify({ organizationId: 1 }), { status: 200 });
    }
    if (url.includes('/courses') && !url.includes('course-corrections')) {
      return new Response(JSON.stringify(COURSES), { status: 200 });
    }
    if (url.endsWith('/api/portal/course-corrections/mine')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('PortalCourseCorrectionsPage — query param pre-fill', () => {
  beforeEach(() => {
    navigate.mockReset();
    currentSearch = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('pre-fills course, hole and field from valid query params', async () => {
    currentSearch = 'courseId=42&hole=7&field=yardage';
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    // Wait for the org's courses to load so the <select> can resolve the value.
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Pebble Beach' })).toBeTruthy();
    });

    const courseSelect = screen.getByTestId('select-course') as HTMLSelectElement;
    const holeInput = screen.getByTestId('input-hole') as HTMLInputElement;
    const fieldSelect = screen.getByTestId('select-field') as HTMLSelectElement;

    expect(courseSelect.value).toBe('42');
    expect(holeInput.value).toBe('7');
    expect(fieldSelect.value).toBe('yardage');
    expect(screen.getByTestId('prefill-notice')).toBeTruthy();
  });

  it('ignores out-of-range hole numbers and unknown field names', async () => {
    currentSearch = 'courseId=42&hole=99&field=bogus';
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Pebble Beach' })).toBeTruthy();
    });

    const courseSelect = screen.getByTestId('select-course') as HTMLSelectElement;
    const holeInput = screen.getByTestId('input-hole') as HTMLInputElement;
    const fieldSelect = screen.getByTestId('select-field') as HTMLSelectElement;

    // courseId is valid → kept
    expect(courseSelect.value).toBe('42');
    // hole=99 is > 18 → dropped (input remains empty)
    expect(holeInput.value).toBe('');
    // field=bogus is not in the whitelist → falls back to the default ('par')
    expect(fieldSelect.value).toBe('par');
    // notice is still shown because courseId was honoured
    expect(screen.getByTestId('prefill-notice')).toBeTruthy();
  });

  it('does not show the prefill notice when no params are present', async () => {
    currentSearch = '';
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Pebble Beach' })).toBeTruthy();
    });

    expect(screen.queryByTestId('prefill-notice')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('strips the deep-link params from the URL after consumption', async () => {
    currentSearch = 'courseId=42&hole=7&field=par&currentValue=4';
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        '/portal/course-corrections',
        { replace: true },
      );
    });
  });

  // Task #1351 ----------------------------------------------------------------

  it('pre-fills the current value input from the currentValue query param', async () => {
    currentSearch = 'courseId=42&hole=7&field=par&currentValue=Par%204';
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Pebble Beach' })).toBeTruthy();
    });

    const currentInput = screen.getByTestId('input-current') as HTMLInputElement;
    expect(currentInput.value).toBe('Par 4');
    expect(screen.getByTestId('prefill-notice')).toBeTruthy();
  });

  it('trims and length-caps the currentValue param', async () => {
    const longValue = 'x'.repeat(500);
    currentSearch = `courseId=42&currentValue=${encodeURIComponent(`   ${longValue}   `)}`;
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Pebble Beach' })).toBeTruthy();
    });

    const currentInput = screen.getByTestId('input-current') as HTMLInputElement;
    // Whitespace stripped, then capped at MAX_CURRENT_VALUE_LEN (120) chars.
    expect(currentInput.value.length).toBe(120);
    expect(currentInput.value.startsWith('x')).toBe(true);
  });

  it('shows the prefill notice when only currentValue is supplied', async () => {
    currentSearch = 'currentValue=4';
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Pebble Beach' })).toBeTruthy();
    });

    expect(screen.getByTestId('prefill-notice')).toBeTruthy();
    const currentInput = screen.getByTestId('input-current') as HTMLInputElement;
    expect(currentInput.value).toBe('4');
  });

  it('ignores blank currentValue (whitespace only) and does not show the notice', async () => {
    currentSearch = 'currentValue=%20%20%20';
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Pebble Beach' })).toBeTruthy();
    });

    const currentInput = screen.getByTestId('input-current') as HTMLInputElement;
    expect(currentInput.value).toBe('');
    expect(screen.queryByTestId('prefill-notice')).toBeNull();
  });

  // Task #1615 ----------------------------------------------------------------

  it('seeds the proposed value with the current value so it is a one-tap edit', async () => {
    currentSearch = 'courseId=42&hole=7&field=par&currentValue=4';
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Pebble Beach' })).toBeTruthy();
    });

    const currentInput = screen.getByTestId('input-current') as HTMLInputElement;
    const proposedInput = screen.getByTestId('input-proposed') as HTMLInputElement;
    expect(currentInput.value).toBe('4');
    // The proposed value mirrors the current value on mount; the player can
    // change just the digit they want to fix instead of re-typing the whole
    // value they already saw on the previous page.
    expect(proposedInput.value).toBe('4');
  });

  it('seeds the proposed value for yardage corrections too', async () => {
    currentSearch = 'courseId=42&hole=7&field=yardage&currentValue=380';
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Pebble Beach' })).toBeTruthy();
    });

    const proposedInput = screen.getByTestId('input-proposed') as HTMLInputElement;
    expect(proposedInput.value).toBe('380');
  });

  it('leaves the proposed value blank when no currentValue is supplied', async () => {
    // We must never invent a suggestion the player didn't actually see — if
    // the linking page didn't pass a currentValue (e.g. the course mapper,
    // which only knows geometry, not par), the suggestion stays empty.
    currentSearch = 'courseId=42&hole=7&field=par';
    stubFetch();

    render(<PortalCourseCorrectionsPage />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Pebble Beach' })).toBeTruthy();
    });

    const proposedInput = screen.getByTestId('input-proposed') as HTMLInputElement;
    expect(proposedInput.value).toBe('');
  });
});
