# Soak partner — cadence & feedback template

**Status:** Stub (Wave 0 / Task #935 W0-6)
**Owner:** Founder (KHARAGOLF)
**Last updated:** 2026-04-21

## Purpose

One real, non-technical club admin agrees to be the standing soak partner
for Wave 2 / Wave 3 ops features. Every feature touching the day-to-day
running of a club ships first behind a feature flag for this club, gets
a week of usage, and graduates only after their feedback is incorporated.

## Active soak partner

| Field | Value |
|---|---|
| Club name | **TBD — fill in once contract signed** |
| Primary contact (admin) | TBD |
| Email | TBD |
| Phone / WhatsApp | TBD |
| Feature flag tenant id | TBD (set when org is created) |
| Start date | TBD |

## Cadence

- **Weekly 30-min call** (Monday 14:00 IST). Agenda template below.
- **Async channel:** dedicated WhatsApp group named "KHARAGOLF × {club}" so
  the admin can drop screenshots / voice notes any time. Replies within
  one business day during Wave 2/3.
- **Monthly steering review:** 60 min, end-of-month. Review the prior
  four weeks' feedback themes, agree the next month's roadmap.

## Weekly call agenda (template)

```
1. Wins from last week (5 min)
   - What worked? Any moments of "this saved me time"?

2. Friction this week (10 min)
   - What broke? What was confusing?
   - Any workarounds the admin had to invent?

3. Members & golfers feedback (5 min)
   - Anything the admin heard from members that we should know?

4. Upcoming features preview (5 min)
   - Demo the next thing landing behind their flag.
   - Get a thumbs up / thumbs down before we ship to wider beta.

5. Action items (5 min)
   - Owner + due date for every item raised above.
   - Captured in the WhatsApp group as a pinned message.
```

## Feedback log

- Live document at `docs/operations/soak-partner-feedback.md` (created
  on first call).
- Each entry: date, raised-by, theme, severity (blocker / nice-to-have),
  ticket id once filed, status.

## Graduation criteria for any feature

A feature only graduates from "behind soak partner flag" to "all clubs"
when **all three** of:

1. The soak admin has used it on a real workflow at least 3 times.
2. No outstanding blocker-severity feedback against it.
3. At least one positive testimonial from the admin captured in the log.

## Compensation / commitment

Soak partner gets:

- Lifetime free Pro tier for their club.
- First-look access to every feature.
- Public credit in launch posts (with their consent).

In return, they commit to the weekly call and async responsiveness for
the duration of Wave 2 + Wave 3 (~3 months).
