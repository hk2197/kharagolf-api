# Translation glossary notes

Per-language decisions that came out of the native-speaker review passes
on the wallet / admin / domain-status i18n packs. Use these as the
reference when adding or editing a sibling pack so the same calls are
made consistently across files.

The packs reviewed so far:

- **#1268** — admin email packs (`adminEmailI18n.ts`).
- **#1485** — wallet auto-refund finance digest
  (`walletTopupRefundDigestI18n.ts`).
- **#1823** — wallet withdrawal SMS pack
  (`walletWithdrawalI18n.ts`).

Subsequent passes should append to this file, not rewrite it.

---

## Per-language decisions

### German (de)

**Register: formal `Sie` / `Ihr`, never `du` / `dein`.**

The first wallet packs (push, in-app, email — Tasks #919 / #1069)
shipped with the casual `du` / `Deine` register because the original
copywriter pulled from a consumer-marketing tone. The #1485 review
established that anything finance-adjacent (digest emails, payment
receipts, withdrawal notices) must use the polite `Sie` / `Ihr`
register that German banks and German B2B SaaS use, regardless of
whether the recipient is a member or an admin.

- `walletTopupRefundDigestI18n.ts` — already on `Sie` (#1485).
- `walletWithdrawalI18n.ts` — switched to `Sie` (#1823). Specifically
  `Deine Auszahlung` → `Ihre Auszahlung`, `aus deinem Wallet` → `aus
  Ihrem Wallet`, `du kannst es erneut versuchen` → `Sie können es
  erneut versuchen`.
- Any new finance / payments pack — start on `Sie`.

The casual `du` register is still acceptable for purely social /
gameplay copy (e.g. spectator and highlight pushes), so don't blanket-
rewrite those packs without re-reading them.

### Spanish (es)

- **`labelCadence`**: `Frecuencia`, never `Cadencia`. `Cadencia`
  is a calque of English "cadence" that survives only in music and
  prosody — a Spanish reader expects `Frecuencia` for the
  weekly/monthly knob (#1485).
- **Wallet noun**: keep `billetera` everywhere it already appears
  (the Latin-American term used by the original #1069 copy). Don't
  switch some packs to `monedero` or to the bare English `Wallet` —
  pick-your-own-Spanish in sibling notices is worse than the slight
  Iberian/LatAm split.
- **`reversed` (banking)**: `Retiro revertido` is intentionally
  retained (#1823). Both `revertido` and `anulado` are in current
  Latin-American banking use (Mercado Pago, Banamex, etc. all use
  `revertido` for chargebacks); the calque concern that hit
  `cadencia` does not apply here. Don't "fix" it to `estornado`
  (that is Brazilian Portuguese, not Spanish).
- **Register**: keep informal `tú` / `tu` (matches the digest's
  `úsalo`). Spanish-language fintech (Nubank ES, Mercado Pago, BBVA
  consumer app) is consistently informal in member-facing copy.

### Portuguese (pt — Brazilian)

- **`labelCadence`**: `Frequência`, never `Cadência` (#1485). Same
  calque story as Spanish.
- **Wallet noun**: keep `carteira`, matching #1069 / #1485.
- **`reversed` (banking)**: `Saque estornado`, never `Saque
  revertido` (#1823). Brazilian banking (Bacen circulars, Itaú,
  Bradesco, Pix docs) consistently uses `estorno` / `estornado` for
  the financial-reversal sense; `revertido` reads as a literal
  English calque and a reader will think "reverted" rather than
  "credited back."
- **Register**: informal `você` / `seu`, matching the digest. This
  matches Brazilian fintech norms (Nubank, PicPay, Mercado Pago BR).

### French (fr)

- **`labelCadence`**: `Fréquence`. (`Cadence` exists in French but
  for finance dashboards readers strongly expect `Fréquence`.)
- **Register**: formal `vous` / `votre`. French member-facing
  banking copy is universally formal, even for casual-feeling
  fintech apps (Lydia, Revolut FR).
- **`reversed` (banking)**: kept as `annulé` (#1823). The technically
  correct term is `contrepassé`, but it's accountancy jargon that
  most members will not parse from a 160-char SMS. `Annulé` is the
  member-facing word every French neobank uses for an unwound
  payment, so stay with it.

### Filipino (fil)

- **`labelCadence`**: `Dalas`, not `Kadensiya` (#1485).
- **`reversed`**: `Binawi` is kept (#1823). The English loan
  `na-reverse` is more colloquial in Manila banking apps but the
  pack is a mix of Filipino and English already, and `binawi` is
  unambiguous in the SMS context (`Binawi ang withdrawal: …
  na-refund`).
- **Register**: informal `iyong` / `mo` is kept across the wallet
  packs.

### Zulu (zu)

- **`labelCadence`**: `Ukuvama`, not `iKhandlela` or `iKhayidense`
  (#1485).
- **`reversed`**: `kuhoxisiwe` (the existing test in
  `walletWithdrawalI18n.test.ts` pins this on purpose — do not
  flip it back to `kubuyiselwe emuva` or similar). #1823 confirmed
  this is correct.

### Hindi (hi)

- **`reversed`**: `पलट दी गई` (NOT `वापस ले ली गई`), pinned by an
  existing test in `walletWithdrawalI18n.test.ts`. `वापस ले ली गई`
  reads as "taken back" (e.g. an offer or statement being retracted)
  whereas `पलट दी गई` is the standard "reversed" idiom for a
  transaction.
- **Wallet noun**: transliteration `वॉलेट` is the consistent choice
  across all wallet packs.
- **Orphaned-payments job (admin context)**: use `अनाथ-भुगतान कार्य`,
  not the literal `अनाथ-भुगतान काम` (#1485 admin pack decision).
- **Hindi danda**: use `।` for sentence-end punctuation in
  Devanagari, including UTR / reason suffixes (`UTR {utr}।`,
  `कारण: {reason}।`). `walletWithdrawalI18n.ts` already does this.

### Yoruba (yo)

- **Orphaned payment**: `òrúkàn` (from `ọmọ òrúkàn`, lit. "orphan
  child"), not `aláìní òbí` (#1485). Wallet/finance docs we sampled
  all use `òrúkàn` for the metaphorical "orphaned record" sense.
- **Register**: informal `rẹ` is acceptable in member-facing SMS.

### Hausa (ha)

- **Plural / gender-neutral pronouns**: `kuɗin ku`, `walat ɗinku`
  (the gender-neutral plural), never `kuɗin ka` / `walat ɗinka`
  (the masculine singular). Pinned by an existing test in
  `walletWithdrawalI18n.test.ts`.
- **`reversed`**: distinct verb `An soke cire kuɗi` for the title,
  also pinned by test. Don't reuse the `gaza` (failed) phrasing.

### Amharic (am)

- **Ethiopic full stop `።`** (U+1362) for sentence ends in the
  withdrawal SMS suffixes. `UTR {utr}።` and `ምክንያት: {reason}።`,
  not the ASCII `.`. Pinned by an existing test in
  `walletWithdrawalI18n.test.ts`.

### Afrikaans (af)

- **`reversed`**: `omgekeer`, not `teruggekeer` (#1823).
  `Teruggekeer` is intransitive ("returned" / "came back"), so
  `Onttrekking is teruggekeer` reads as "the withdrawal came back"
  — close, but `omgekeer` ("inverted / reversed") is the verb every
  Afrikaans banking site uses for a transaction reversal. Updated
  both `reversedTitle` and `reversedBody`.
- **Register**: informal `jy` / `jou` is retained (the digest pack
  uses passive constructions and has no `jy` / `u` precedent; we
  did not extend the German register switch here because Afrikaans
  consumer-banking SMS still mixes `jy` and `u` in roughly equal
  measure).

### Arabic (ar)

- **`destination` and `reason`**: stay LTR, mid-sentence. The
  Arabic strings already use the standard convention of leaving
  payment-network strings in their original form.
- **Period punctuation**: ASCII `.` is used (modern Arabic web
  convention) rather than the Arabic full stop, matching what
  `walletRefundI18n.ts` and `adminEmailI18n.ts` already do.

### CJK (ja / ko / zh)

- **Punctuation**: full-width `。` and `：` are used in every CJK
  pack. Don't mix half-width punctuation in (it looks broken in
  many SMS gateways' previews).
- **Korean particle agreement**: `(으)로` for the destination
  particle — the existing pack already does this and it is the
  right pattern when the runtime can't introspect the trailing
  consonant of `{destination}`.
- **Register**: Korean uses the `-습니다` polite-formal level
  throughout; Chinese uses `您` (formal `you`). Both are pinned by
  fintech-app convention.

### Thai (th) / Indonesian (id) / Malay (ms) / Vietnamese (vi)

- **Punctuation**: Thai pack intentionally has no trailing `.` /
  `។` on the suffixes, matching Thai conventions of using a space
  rather than a period. The other three use ASCII `.`.
- **`reversed`**: `dibatalkan` (id, ms) / `đã bị hủy` (vi) is
  retained (#1823). The literal "cancel" reading is acceptable in
  these languages' fintech idiom for a member-facing SMS
  ("payment / withdrawal was undone / called off"), and the
  refund clause that follows makes the meaning unambiguous.
- **Register**: id uses the capitalised polite `Anda`; ms uses
  `anda`; vi uses informal `bạn`; th uses `คุณ`. Match these in
  any new sibling pack.

---

## What review passes do NOT change

- Currency formatting (handled by `formatRefundAmount` in
  `walletRefundI18n.ts`, not in the per-language packs).
- Placeholder names (`{amount}`, `{currency}`, `{destination}`,
  `{utr}`, `{reason}`, `{orgName}`, etc.).
- HTML markup expected by the email templates (e.g. the
  `<strong style="color:#fff;">{orgName}</strong>` wrapping in the
  digest pack's intro paragraph).
- Test-pinned strings — search the corresponding `*.test.ts` file
  before changing a wording that looks improvable; if a `toContain`
  is asserting a specific noun or verb, that is on purpose and the
  decision rationale lives in this file.
