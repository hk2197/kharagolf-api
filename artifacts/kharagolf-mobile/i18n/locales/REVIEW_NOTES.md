# Committee case translation review — sign-off

Scope: `handicapCommittee.json` for all 21 supported locales
(en, hi, ar, es, fr, de, pt, ja, ko, zh, th, ms, id, vi, fil, sw, af, am, ha, zu, yo).
Reviewed in task #1689.

## Per-locale outcome

| Locale | Status | Notes |
| --- | --- | --- |
| en | source | No changes (English is the source of truth) |
| es | edited | `summary.subject` "Sujeto" → "Asunto" (correct sense of "subject" for a case topic) |
| ar | edited | `pendingPeer.empty` gender agreement (هذا → هذه); added preposition `في` to `summary.openedAt`, `peerResponses.respondedAt`, `pendingPeer.invited` so date templates read naturally |
| fr | edited | Aligned peer-reviewer terminology to `évaluateurs` in `peerSummary.badgeAccessibility` and `peerSummary.sheetTitle` (was `relecteurs`, inconsistent with `peerModal` and `reviewerFallback`); `peerResponses.respondedAt` "Répondu {{date}}" → "A répondu le {{date}}" |
| de | edited | `summary.openedAt` "Eröffnet {{date}}" → "Eröffnet am {{date}}" (other date keys already used `am`) |
| pt | reviewed, no changes | Reads naturally; date prepositions (`em`) and tense already consistent |
| hi | edited | `peerSummary.badge` / `openedHeading` / `notYetOpenedHeading` — feminine `खोली` → masculine `खोला` to agree with the implicit object निमंत्रण (masculine) |
| ja | edited | `summary.openedAt` "に作成" (created) → "に開設" (opened) — matches the actual English meaning |
| ko | reviewed, no changes | Honorific level and tense are consistent |
| zh | edited | `summary.openedAt` "{{date}} 打开" → "于 {{date}} 开立"; `pendingPeer.invited` and `invitedWithSeen` prefixed with `于` so they parse as full sentences rather than "[date] invitation" |
| th | edited | `peerResponses.seenRelative` and `respondedAt` — added missing `เมื่อ` to match the pattern already used in `peerSummary.seenRelative` and `summary.openedAt` |
| ms | reviewed, no changes | Tense (passive `Di-`) and date templates already consistent |
| id | reviewed, no changes | Tense and phrasing consistent |
| vi | reviewed, no changes | Tense markers (`Đã`) and date phrasing consistent |
| fil | reviewed, no changes | Tense and phrasing consistent |
| sw | reviewed, no changes | Subject concord and noun classes are correct (Class 9 `i-` for the invitation in `seenRelative`, Class 1 `a-` for the human invitee in `invitedRelative`). `Mhusika` for `summary.subject` is intentional (the player whose handicap is being reviewed) |
| af | reviewed, no changes | Tense and phrasing consistent |
| am | reviewed, no changes | SOV ordering (e.g. `{{date}} ተከፈተ`) is grammatical for date templates |
| ha | edited | `peerSummary.invitedRelative`, `pendingPeer.invited`, `pendingPeer.invitedWithSeen` rewritten from ungrammatical "An gayyace {{...}}" (passive verb missing required object pronoun) to "An aika gayyata {{...}}" (Invitation was sent ...), which is pronoun-neutral and works for any number of invitees |
| zu | edited | `peerResponses.recommendations.dispute` "Kuphikiswa" (present passive, "is being disputed") → "Kuphikisiwe" (perfect, "has been disputed") — consistent with the perfect form used in `confirm` and `responded` |
| yo | edited | Added subject markers to bare verbs in time-context strings (`Rí` / `Pè` / `Dáhùn` → `A rí` / `A pè` / `A dáhùn` / `A ti dáhùn` for the perfect); recommendations badges cleaned up — removed stray `Tí` relative-clause prefix and ungrammatical low-tone `à` so `confirm` / `dispute` read as `Jẹ́risí` / `Tako` |

## Reviewer focus areas from the original task

- **Sentence templates with `{{date}}` interpolation** — corrected in ar, de, fr, ja, th, zh (added missing prepositions / fixed verbs); other locales already had natural phrasing
- **Sentence templates with `{{relative}}` interpolation** — fixed past-tense markers in yo, restructured ungrammatical Hausa, fixed Thai consistency
- **Sentence templates with `{{count}}` interpolation** — reviewed; no agreement issues found in the existing strings (counts always appear in parentheses, which works across all 21 languages)
- **Plural agreement and noun classes** — Arabic gender agreement fixed; Zulu tense corrected; Swahili noun-class concord verified correct as-is
- **Smaller communities (ar, am, ha, sw, yo, zu)** — all six reviewed line-by-line; ar/ha/yo/zu received fixes, am and sw read naturally as-is

## Out-of-scope finding (filed as follow-up #2101)

The original task brief asked for review of `relative.past.*` and `relative.future.*` plural forms. These keys do **not** exist in any locale's `handicapCommittee.json` (or in `common.json`) — the `{{relative}}` placeholder is currently filled by a JS formatter on the screen, not by an i18n catalogue. Adding a real translated `relative` namespace and switching the renderer over is tracked in follow-up task #2101; no per-language plural-form work is possible until those keys are introduced.

## Verification

- All 21 `handicapCommittee.json` files re-validated as JSON
- `pnpm run lint:mobile-translations` passes (no new missing keys, no untranslated fallbacks; baseline unchanged)
