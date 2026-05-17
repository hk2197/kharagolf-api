# 0004 — Transactional email provider: Postmark

Date: 2026-04-22
Status: Accepted

## Context

KHARAGOLF has been sending all transactional email (verification links,
password resets, member invites, payment receipts, broadcasts, levy
ledgers, etc.) through a single personal Gmail account using SMTP.

This was fine for early-stage usage but does not scale:

- Gmail caps outbound at ~500 messages/day per account, far below what a
  modest club base will produce.
- There is no first-class signal for hard bounces, spam complaints or
  list-unsubscribes — failed sends look like generic SMTP errors.
- We have no IP / domain reputation we control; deliverability is
  entirely at the mercy of Gmail's anti-abuse heuristics.
- A Gmail outage or account suspension takes the whole product down.

Wave 0 (Task #935) shipped a provider-agnostic adapter
(`artifacts/api-server/src/lib/email/adapter.ts`) so the actual SMTP /
HTTP transport is selected by `EMAIL_PROVIDER`. The adapter shipped with
real Gmail support and stubs for Postmark, Resend and SendGrid.

## Decision

We are wiring **Postmark** up as the production transactional provider.

Why Postmark over Resend / SendGrid:

- Best-in-class deliverability for transactional traffic. Their
  separation of "transactional" and "broadcast" streams is a natural
  fit for our split between per-flow `send*Email()` helpers and the
  marketing campaign sender.
- Webhook payloads are well-defined and stable, with first-class
  `Bounce`, `SpamComplaint` and `SubscriptionChange` event types — we
  can map directly into the existing `email_suppressions` table without
  a translation layer.
- HTTP API (`POST https://api.postmarkapp.com/email`) is a single
  `fetch` call — no SDK to add, no extra dependency.
- HTTP Basic Auth on the webhook endpoint is officially supported,
  which matches the Replit env-var workflow without exposing any new
  secret-rotation surface.

Resend stays a reasonable second choice and SendGrid a third; both
remain wired as stubs in `adapter.ts` so a future swap is still a
one-line env change.

## Implementation

- `lib/email/adapter.ts`: replaced the Postmark stub with a real `fetch`
  client. Reads `POSTMARK_SERVER_TOKEN` (required) and
  `POSTMARK_MESSAGE_STREAM` (optional, defaults to `"outbound"`).
  Forwards `tags` (as `Tag` + `Metadata.tags`) and `metadata` (as
  Postmark `Metadata`) so the bounce webhook can attribute events back
  to the originating org.
- `routes/webhooks.ts`: new `POST /api/webhooks/postmark` endpoint.
  Authenticated with HTTP Basic Auth via `POSTMARK_WEBHOOK_USER` /
  `POSTMARK_WEBHOOK_PASSWORD`. Hard bounces, spam complaints, and
  `SubscriptionChange` (`SuppressSending: true`) events insert rows
  into `email_suppressions`, which is the same table the existing
  marketing admin UI under the *Suppressions* tab reads from.
- The org for a given event is resolved in this order:
  1. `Metadata.orgId` from the original send.
  2. Every org that has recently sent the recipient a marketing
     campaign (looked up via `campaign_recipients`, ordered by most
     recent). Once an address is bad, it is bad for everyone.
  3. Every org the recipient is currently a member of.
- The webhook also handles the resubscribe direction: a Postmark
  `SubscriptionChange` with `SuppressSending: false`, or a `Bounce` of
  `Type: "Subscribe"`, deletes any existing suppression rows for the
  resolved org(s).
- Existing 40+ `sendBroadcastEmail` / `sendMail` callers continue to
  work unchanged — only the underlying transport changes when
  `EMAIL_PROVIDER=postmark` is set.

## Cutover

To roll out:

1. Verify the sending domain in Postmark and configure SPF / DKIM /
   Return-Path DNS records.
2. Set `EMAIL_PROVIDER=postmark`, `POSTMARK_SERVER_TOKEN`, and the
   webhook Basic-auth credentials on the production deployment.
3. In the Postmark dashboard, point the bounce / spam / subscription
   webhook at `https://<host>/api/webhooks/postmark` with the same
   Basic-auth credentials.
4. Soak in Postmark's sandbox mode first and confirm webhook events
   land in the `email_suppressions` table (visible in the Marketing →
   Suppressions admin view).
5. Once verified, flip `EMAIL_PROVIDER` and retire the Gmail
   credentials.

## Consequences

- Outbound transactional volume is no longer capped by a personal
  Gmail account.
- Bounces and complaints are now durable: every event ends up either
  in the `email_suppressions` table (where admins can see and manage
  it) or in structured logs.
- Provider lock-in is minimal — the same adapter contract gives us a
  one-line escape hatch back to Gmail or onward to Resend / SendGrid.
- Rolling Postmark's webhook Basic-auth credentials becomes a
  recurring secret-rotation chore, but it is the same chore we already
  run for Razorpay / Garmin / Stripe webhook secrets.
