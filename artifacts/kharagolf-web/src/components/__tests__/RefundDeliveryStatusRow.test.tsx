/**
 * UI test: `RefundDeliveryStatusRow` — Task #1862.
 *
 * Locks in the per-status visual contract for the new four-channel
 * (Email / Push / SMS / WhatsApp) delivery row that's rendered in:
 *   - the member-facing wallet panel inside `SideGamesAdmin`
 *     (passes `showLastError={false}`), and
 *   - the admin-facing `wallet-topup-refunds.tsx` dashboard
 *     (passes `showLastError={true}` so support sees the most
 *     recent provider error inline).
 *
 * Specifically asserts:
 *   1. Each of the five mapped statuses (sent, retrying, failed,
 *      exhausted, skipped) renders the right human label.
 *   2. The unknown / not-yet-attempted state (`status: null`)
 *      collapses to an em-dash so the cell is never blank.
 *   3. `showLastError` is gated on status === failed | exhausted
 *      (member view never leaks errors; admin view only shows
 *      errors when there's actually something to act on).
 *   4. All four channel cells are always rendered, even when the
 *      backing status is null — this is what answers "did the SMS
 *      ever go out?" rather than the row silently disappearing.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import {
  RefundDeliveryStatusRow,
  refundDeliveryStatusLabel,
  type RefundDeliveryInfo,
} from '../RefundDeliveryStatusRow';

afterEach(() => cleanup());

function makeChannel(overrides: Partial<RefundDeliveryInfo['email']> = {}): RefundDeliveryInfo['email'] {
  return {
    status: null,
    attempts: 0,
    lastAt: null,
    nextRetryAt: null,
    exhaustedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe('refundDeliveryStatusLabel', () => {
  it('maps every known status (and null) to a human label', () => {
    expect(refundDeliveryStatusLabel('sent')).toBe('Sent');
    expect(refundDeliveryStatusLabel('retrying')).toBe('Retrying');
    expect(refundDeliveryStatusLabel('failed')).toBe('Failed');
    expect(refundDeliveryStatusLabel('exhausted')).toBe('Gave up');
    expect(refundDeliveryStatusLabel('skipped')).toBe('Skipped');
    expect(refundDeliveryStatusLabel(null)).toBe('—');
  });
});

describe('RefundDeliveryStatusRow (Task #1862)', () => {
  it('renders every channel cell even when statuses are null (so the row is unambiguous about "no attempt yet")', () => {
    const delivery: RefundDeliveryInfo = {
      email: makeChannel(),
      push: makeChannel(),
      sms: makeChannel(),
      whatsapp: makeChannel(),
    };
    render(
      <RefundDeliveryStatusRow
        delivery={delivery}
        rowTestId="row-r"
        channelTestIdPrefix="ch-r"
      />,
    );
    expect(screen.getByTestId('row-r')).toBeTruthy();
    for (const channel of ['email', 'push', 'sms', 'whatsapp']) {
      const cell = screen.getByTestId(`ch-r-${channel}`);
      expect(cell.getAttribute('data-status')).toBe('none');
      expect(cell.textContent).toContain('—');
    }
  });

  it('renders all five mapped statuses across the four channels with the expected labels', () => {
    const delivery: RefundDeliveryInfo = {
      email: makeChannel({ status: 'sent', attempts: 1 }),
      push: makeChannel({ status: 'retrying', attempts: 2, nextRetryAt: '2026-04-30T12:00:00Z' }),
      sms: makeChannel({ status: 'exhausted', attempts: 5, exhaustedAt: '2026-04-30T11:00:00Z' }),
      whatsapp: makeChannel({ status: 'skipped' }),
    };
    render(
      <RefundDeliveryStatusRow
        delivery={delivery}
        rowTestId="row-r2"
        channelTestIdPrefix="ch-r2"
      />,
    );
    expect(screen.getByTestId('ch-r2-email').textContent).toContain('Email: Sent');
    expect(screen.getByTestId('ch-r2-email').getAttribute('data-status')).toBe('sent');
    expect(screen.getByTestId('ch-r2-push').textContent).toContain('Push: Retrying');
    expect(screen.getByTestId('ch-r2-push').getAttribute('data-status')).toBe('retrying');
    expect(screen.getByTestId('ch-r2-sms').textContent).toContain('SMS: Gave up');
    expect(screen.getByTestId('ch-r2-sms').getAttribute('data-status')).toBe('exhausted');
    expect(screen.getByTestId('ch-r2-whatsapp').textContent).toContain('WhatsApp: Skipped');
    expect(screen.getByTestId('ch-r2-whatsapp').getAttribute('data-status')).toBe('skipped');
  });

  it('renders the transient `failed` status (no exhaustedAt, no nextRetryAt — between cron passes)', () => {
    const delivery: RefundDeliveryInfo = {
      email: makeChannel({ status: 'failed', attempts: 1, lastError: 'smtp timeout' }),
      push: makeChannel(),
      sms: makeChannel(),
      whatsapp: makeChannel(),
    };
    render(
      <RefundDeliveryStatusRow
        delivery={delivery}
        rowTestId="row-r3"
        channelTestIdPrefix="ch-r3"
      />,
    );
    expect(screen.getByTestId('ch-r3-email').textContent).toContain('Email: Failed');
    expect(screen.getByTestId('ch-r3-email').getAttribute('data-status')).toBe('failed');
  });

  describe('showLastError gating', () => {
    const deliveryWithErrors: RefundDeliveryInfo = {
      email: makeChannel({ status: 'sent', lastError: 'should never render — sent has no error to show' }),
      push: makeChannel({ status: 'retrying', lastError: 'transient retry — admin sees on dedicated retries page, not here' }),
      sms: makeChannel({
        status: 'exhausted', attempts: 5,
        lastError: 'Twilio code 30007 (carrier filtered)',
      }),
      whatsapp: makeChannel({
        status: 'failed', attempts: 1,
        lastError: 'Meta error 131026 (message undeliverable)',
      }),
    };

    it('hides every channel error when showLastError is false (member view — defence in depth)', () => {
      render(
        <RefundDeliveryStatusRow
          delivery={deliveryWithErrors}
          rowTestId="row-r4"
          channelTestIdPrefix="ch-r4"
          showLastError={false}
        />,
      );
      for (const channel of ['email', 'push', 'sms', 'whatsapp']) {
        expect(screen.queryByTestId(`ch-r4-${channel}-error`)).toBeNull();
      }
    });

    it('renders the error string ONLY for failed/exhausted channels when showLastError is true (admin view)', () => {
      render(
        <RefundDeliveryStatusRow
          delivery={deliveryWithErrors}
          rowTestId="row-r5"
          channelTestIdPrefix="ch-r5"
          showLastError
        />,
      );
      // sent → no error rendered (the cron clears the error stamp on success).
      expect(screen.queryByTestId('ch-r5-email-error')).toBeNull();
      // retrying → no inline error (the row is still actively trying;
      // admins consult the dedicated retries page for transient noise).
      expect(screen.queryByTestId('ch-r5-push-error')).toBeNull();
      // exhausted + failed → error string is rendered inline so support
      // can answer "why did the SMS not go out?" without leaving the page.
      expect(screen.getByTestId('ch-r5-sms-error').textContent).toContain('Twilio code 30007');
      expect(screen.getByTestId('ch-r5-whatsapp-error').textContent).toContain('Meta error 131026');
    });

    it('does not render an error block when showLastError is true but the channel has no lastError string', () => {
      const delivery: RefundDeliveryInfo = {
        email: makeChannel({ status: 'failed', lastError: null }),
        push: makeChannel({ status: 'exhausted', lastError: null }),
        sms: makeChannel(),
        whatsapp: makeChannel(),
      };
      render(
        <RefundDeliveryStatusRow
          delivery={delivery}
          rowTestId="row-r6"
          channelTestIdPrefix="ch-r6"
          showLastError
        />,
      );
      expect(screen.queryByTestId('ch-r6-email-error')).toBeNull();
      expect(screen.queryByTestId('ch-r6-push-error')).toBeNull();
    });
  });
});
