-- Task #2150 — Per-user opt-out for the security heads-up email sent
-- when a fresh Apple or Google sign-in identity is attached to the
-- player's KHARAGOLF account
-- (`sendSocialLinkAddedSecurityEmail`, added in Task #1736; gate added
-- in `routes/wave3.ts` POST /portal/me/social-links/:provider).
--
-- Until now the alert always sent — Task #1736 intentionally bypassed
-- the broader `privacy` comm-prefs opt-out so a hijacker couldn't
-- pre-mute the alert by flipping the umbrella category before
-- attaching their own provider. That trade-off suppresses noise for
-- the typical user but punishes power users who link/unlink
-- frequently (e.g. during testing). This per-event flag lets THEM
-- mute just this one notice while the umbrella `privacy` category
-- stays out of the picture entirely.
--
-- Defaults to true so every existing player keeps receiving the
-- heads-up unless they explicitly silence it from the Communications
-- preferences page. Wrapped in `IF NOT EXISTS` so reruns and fresh DB
-- bootstraps both succeed.

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_social_link_added" boolean NOT NULL DEFAULT true;
