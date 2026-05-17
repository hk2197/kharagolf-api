-- Task #1101 — Let admins snooze the periodic HTTPS-failed re-nudge while
-- they fix DNS. The re-nudge job (renudgeStaleCustomDomainHttpsFailures)
-- skips orgs whose snooze-until is still in the future, and the snooze
-- auto-clears once the cert flips to 'active' or the custom domain is
-- cleared.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "custom_domain_cert_renudge_snoozed_until" timestamp with time zone;
