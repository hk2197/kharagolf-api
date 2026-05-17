# E2E: Wallet withdrawal "Txn #N" reference jumps to the matching ledger row

Covers Task #1266. Canonical Playwright `runTest` plan for the
`SideGamesAdmin` → `WalletPanel` flow added in Task #1104, where tapping
a withdrawal's `Txn #N` reference asks the API for that older txn via
`?includeTxnIds=`, expands the visible ledger window and scrolls to /
highlights the matching row.

The API path is already covered in
`artifacts/api-server/src/tests/side-game-settle-flow.test.ts`
("GET /wallet?includeTxnIds= surfaces older txns beyond the recent-50
window"). This e2e adds the missing user-facing coverage for the
click → fetch → scroll → highlight flow.

Replay it from any agent notebook with
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
using the bodies below.

## Surface under test

- File: `artifacts/kharagolf-web/src/components/SideGamesAdmin.tsx`
  (the `WalletPanel` sub-component, lines ~770–1245).
- Mounted from: `artifacts/kharagolf-web/src/pages/leagues.tsx` inside
  the league-detail sheet's "rounds" tab.
- Endpoints exercised:
  - `GET /api/organizations/:orgId/leagues`
    (used by the leagues list to render cards).
  - `GET /api/organizations/:orgId/leagues/:leagueId`
    (league-detail sheet load).
  - `GET /api/wallet?organizationId=&currency=INR[&includeTxnIds=…]`
    (the recent-50 window + the on-click expansion path).
  - `GET /api/wallet/payout-account?organizationId=`
  - `GET /api/wallet/withdrawals?organizationId=`
- Auth: any authenticated app_user in the same organization can render
  the rounds tab + WalletPanel. We promote the freshly-logged-in user
  to `org_admin` anyway so the leagues list/detail surfaces never gate
  on role and so the test can wipe + reseed leagues for the org.
- Selectors exercised here (Task #1493 added stable `data-testid`
  props, so we now select by id rather than by visible text or by
  CSS-class fallbacks):
  - `[data-testid="wallet-recent-transactions-table"]` — the
    "Recent transactions" table wrapper. Used to wait for mount.
  - `[data-testid="wallet-recent-transactions-heading"]` — the
    section heading above that table.
  - `[data-testid="wallet-txn-row-${txnId}"]` — one row per loaded
    ledger txn. The same `<tr>` still carries the legacy
    `id="wallet-txn-${txnId}"` so `scrollIntoView` /
    `document.getElementById` paths in the WalletPanel keep working.
    Highlighted state adds Tailwind class `bg-amber-300/20`.
  - `[data-testid="wallet-withdrawals-table"]` — the withdrawals
    table wrapper.
  - `[data-testid="wallet-withdrawal-row-${withdrawalId}"]` — one
    `<tr>` per withdrawal.
  - `[data-testid="wallet-withdrawal-txn-link-${oldDebitTxnId}"]` —
    the deep-link button inside the withdrawal row (rendered only
    while `w.debitTxnId` is non-null). The companion
    `[data-testid="wallet-withdrawal-refund-link-${refundTxnId}"]`
    targets the refund button when `w.refundTxnId` is non-null.

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-walletjump-" + Date.now(),
     email: "walletjump-e2e-" + Date.now() + "@example.com",
     first_name: "Wallet", last_name: "Jumper" }

3. [Browser] Navigate to /api/login?returnTo=%2F. Wait for the redirect
   chain to settle. Don't visually verify yet.

4. [DB] Promote the freshly-logged-in user to org_admin in BOTH the
   app_users table AND the active session blob (req.user is read from
   sessions.sess.user, not the DB), then seed a deterministic league +
   club_wallet + 60 fresh credit txns + 1 OLD debit txn + 1 withdrawal
   that points at the OLD debit so the click-to-expand path is the
   only way the row can become visible.

   UPDATE app_users SET role='org_admin'
     WHERE id = (SELECT id FROM app_users ORDER BY id DESC LIMIT 1)
     RETURNING id AS user_id, organization_id AS org_id;

   UPDATE sessions
      SET sess = jsonb_set(jsonb_set(sess, '{user,role}', '"org_admin"'),
                            '{user,organizationId}', to_jsonb(${org_id}::int))
    WHERE (sess->'user'->>'id')::int = ${user_id};

   -- Wipe any pre-existing leagues in this org so the search filter
   -- returns exactly one card. The test owns the org for this run.
   DELETE FROM leagues WHERE organization_id = ${org_id};

   -- Stable, searchable suffix so the list filter can target this run
   -- only even if the table later contains other "Wallet …" leagues.
   --   tag = 'WJ' || floor(random()*1000000)::int
   INSERT INTO leagues (organization_id, name, format, type, status)
     VALUES (${org_id}, 'WALLET_E2E_' || ${tag},
             'stableford', 'individual', 'draft')
     RETURNING id AS league_id;

   -- One wallet for (org, user, INR). Reuse if a prior run left one.
   INSERT INTO club_wallets (organization_id, user_id, currency, balance)
     VALUES (${org_id}, ${user_id}, 'INR', '0.00')
     ON CONFLICT (organization_id, user_id, currency)
       DO UPDATE SET balance = EXCLUDED.balance
     RETURNING id AS wallet_id;

   -- Wipe any prior txns/withdrawals on this wallet so the fixture is
   -- deterministic regardless of past runs.
   DELETE FROM club_wallet_withdrawals WHERE wallet_id = ${wallet_id};
   DELETE FROM club_wallet_txns        WHERE wallet_id = ${wallet_id};

   -- The OLD debit txn we'll deep-link to. Backdated 7 days so it is
   -- guaranteed to fall outside the recent-50 window the WalletPanel
   -- loads on mount.
   INSERT INTO club_wallet_txns
     (wallet_id, kind, amount, currency, source_type, balance_after,
      created_at, note)
     VALUES (${wallet_id}, 'debit', '100.00', 'INR',
             'wallet_withdrawal_debit', '0.00',
             now() - interval '7 days',
             'Withdrawal debit (e2e-${tag})')
     RETURNING id AS old_debit_txn_id;

   -- 60 fresh credits, all NEWER than the OLD debit, spaced 1s apart so
   -- the order is deterministic. Recent-50 endpoint orders by created_at
   -- DESC LIMIT 50 → the OLD debit is at position 61 = invisible until
   -- includeTxnIds asks for it.
   INSERT INTO club_wallet_txns
     (wallet_id, kind, amount, currency, source_type, balance_after,
      created_at)
     SELECT ${wallet_id}, 'credit', '0.01', 'INR', 'e2e_pad', '0.00',
            now() - (interval '1 second' * (60 - g.i))
       FROM generate_series(1, 60) AS g(i);

   -- The withdrawal that surfaces the deep-link button. Status
   -- 'processing' is enough — the link is rendered whenever
   -- debit_txn_id is non-null. payout_account_id is left null (the
   -- WalletPanel renders the row regardless).
   INSERT INTO club_wallet_withdrawals
     (wallet_id, organization_id, user_id, amount, currency, method,
      status, debit_txn_id, requested_at)
     VALUES (${wallet_id}, ${org_id}, ${user_id}, '100.00', 'INR',
             'upi', 'processing', ${old_debit_txn_id}, now())
     RETURNING id AS withdrawal_id;

5. [Browser] Navigate to /leagues. Wait for the page header
   ("Leagues" / "Season-long Competitions") to render. Dismiss any Vite
   runtime overlay if present.

6. [Browser] Use the search input (placeholder contains "Search leagues")
   at the top of the page to type "WALLET_E2E_${tag}". Wait until
   exactly one league card is visible — the one whose <h3> text equals
   "WALLET_E2E_${tag}".

7. [Browser] Click the visible league card (the one whose <h3> contains
   "WALLET_E2E_${tag}"). The right-side league detail sheet opens with
   the "Overview" tab selected by default.

8. [Browser] Inside the open sheet, click the tab whose visible text is
   "rounds" (the tab strip lives in the sheet header; tabs are plain
   buttons, not Radix tabs). Wait until the "Side Games" heading
   inside the sheet body is visible — that confirms SideGamesAdmin and
   its WalletPanel are mounted.

9. [Browser] Wait for the WalletPanel's "Recent transactions" table to
   render. Concretely: poll until the element matching the CSS
   selector `[data-testid="wallet-recent-transactions-table"]` is
   attached AND it contains at least 8 rows matching
   `[data-testid^="wallet-txn-row-"]` within the open sheet — that
   confirms the wallet GET resolved and the panel mounted the table.
   (The panel loads the recent 50 txns into state but only renders 8
   rows initially via `visibleCount = max(8, …)`. The deep-link click
   in step 11 expands `visibleCount` to include the highlighted row.)

10. [Verify] BASELINE — the OLD debit txn is NOT in the loaded window,
    but the deep-link button IS visible inside the withdrawals table:
    - The element with CSS selector
      `[data-testid="wallet-txn-row-${old_debit_txn_id}"]` does NOT
      exist.
    - The element with CSS selector
      `[data-testid="wallet-withdrawal-txn-link-${old_debit_txn_id}"]`
      IS visible inside the open sheet (the withdrawals table's first
      row).

11. [Browser] Click the element with CSS selector
    `[data-testid="wallet-withdrawal-txn-link-${old_debit_txn_id}"]`.
    This triggers focusTxn() → setExtraTxnIds() → refetch
    /api/wallet?…&includeTxnIds=${old_debit_txn_id} → the old txn
    lands in the data → the visibleCount expands to include it
    (keyed off `extraTxnIds`, see Task #1491) → the row is rendered,
    scrolled into view, and highlighted via Tailwind class
    `bg-amber-300/20`.

    Once the includeTxnIds refetch resolves (typically <1 s in dev)
    the row is mounted AND highlighted. After ~4 s the focusTxn()
    timer clears highlightTxnId back to null, but the row STAYS
    mounted because `visibleCount` keys off `extraTxnIds` (which is
    sticky for the panel's lifetime). Step 13 explicitly verifies
    the row still exists past the highlight-clear timer.

12. [Verify] Soon after the click (allow up to 8 s for the
    includeTxnIds refetch to land in dev), the matching ledger row is
    mounted AND highlighted AND visible:
    - The element with CSS selector
      `[data-testid="wallet-txn-row-${old_debit_txn_id}"]` exists.
      Use `.waitFor({ state: 'attached', timeout: 8000 })` to give
      the refetch room to resolve.
    - That element's `class` attribute contains the substring
      `bg-amber-300/20` (the highlight class — assert this within
      ~3 s of the click so the highlight timer hasn't fired yet).
    - The text content of that row contains both the substring
      `#${old_debit_txn_id}` (the leading "#id" badge) and the
      seeded note "Withdrawal debit (e2e-${tag})".
    - The row is visible in the viewport (Playwright
      `isInViewport()` / `isVisible()` returns true).

13. [Verify] After the highlight clears (sleep for ~5 s — long enough
    for the focusTxn() ~4 s timer to have cleared `highlightTxnId`),
    the deep-link row MUST still be mounted (Task #1491 — visibility
    is keyed off `extraTxnIds`, not `highlightTxnId`):
    - The element with CSS selector
      `[data-testid="wallet-txn-row-${old_debit_txn_id}"]` still
      exists / is attached.
    - Its text content still contains both `#${old_debit_txn_id}`
      and the seeded note "Withdrawal debit (e2e-${tag})".
    - Its `class` attribute NO LONGER contains `bg-amber-300/20`
      (the highlight has auto-cleared, but the row itself remains).

14. [DB] Cleanup (run regardless of pass/fail to keep the dev DB tidy):
    DELETE FROM club_wallet_withdrawals WHERE id = ${withdrawal_id};
    DELETE FROM club_wallet_txns        WHERE wallet_id = ${wallet_id};
    DELETE FROM club_wallets            WHERE id = ${wallet_id};
    DELETE FROM leagues                 WHERE id = ${league_id};
```

## Technical documentation passed alongside the plan

```text
APP UNDER TEST
- kharagolf-web mounted at "/"; the leagues page is /leagues.
- api-server at /api/* with cookie sessions and Replit OIDC.
- /api/login?returnTo=<safe-path> auto-redirects there after the bypass
  (unless path is "/" or "/login").

AUTH GOTCHA
- The auth middleware sets req.user = sessions.sess.user. Updating
  app_users.role does NOT change req.user; you MUST also patch
  sessions.sess via jsonb_set as in step 4. Without that the leagues
  list / detail / rounds endpoints can 403 in some environments.

ENDPOINTS THIS TEST RELIES ON
- GET /api/organizations/:orgId/leagues
    → list of leagues for the org. No role gate.
- GET /api/organizations/:orgId/leagues/:leagueId
    → league detail (rendered by the right-side sheet).
- GET /api/wallet?organizationId=&currency=INR[&includeTxnIds=…]
    → { wallet, transactions[] }. Returns the most-recent 50 txns for
      (org, user, currency) ordered by created_at DESC. The optional
      includeTxnIds query expands the response to also surface those
      specific wallet-owned txn ids (capped at 25, foreign txns are
      filtered out). This is the API path Task #1104 added; the e2e
      verifies the click → fetch → scroll → highlight path that calls
      it.
- GET /api/wallet/payout-account?organizationId=
- GET /api/wallet/withdrawals?organizationId=
    → { withdrawals[] } for this user/org, ordered desc by requested_at.

WALLETPANEL BEHAVIOUR (artifacts/kharagolf-web/src/components/SideGamesAdmin.tsx)
- On mount and after any extraTxnIds change, fires
  GET /api/wallet?…&includeTxnIds=… (only if extraTxnIds is non-empty)
  in parallel with payout-account + withdrawals.
- focusTxn(id) (Task #1491 update):
    - ALWAYS pushes `id` into `extraTxnIds` (the sticky deep-link set
      that drives both the includeTxnIds refetch AND the visibleCount
      below). Once an id lands in extraTxnIds it stays there for the
      lifetime of the panel.
    - if `id` is already in `data.transactions`, scrolls to
      document.getElementById(`wallet-txn-${id}`) and applies the
      highlight class for ~2.4 seconds.
    - otherwise also sets highlightTxnId; once the refetched data
      lands and includes the row, the second useEffect scrolls to it
      and the highlight auto-clears after ~4 s.
- The "Recent transactions" table renders txns.slice(0, visibleCount):
    visibleCount = max(8, max(indexOf(id)+1) for id in extraTxnIds)
  → after the click, the slice expands to include every deep-linked
    row, and STAYS expanded — the row remains mounted even after the
    highlight timer clears (Task #1491).
- Highlight is the Tailwind class `bg-amber-300/20` on the <tr>
  whose `id` is `wallet-txn-${t.id}` and whose
  `data-testid` is `wallet-txn-row-${t.id}` (Task #1493). The legacy
  `id` is preserved because focusTxn()'s scroll path still uses
  `document.getElementById`. Highlight clears after ~2.4 s
  (already-loaded path) or ~4 s (refetch path); the ROW itself stays
  mounted (Task #1491).

WITHDRAWAL ROW DEEP-LINK
- For each withdrawal w in the withdrawals table, the WalletPanel
  renders a button with the visible text `Txn #${w.debitTxnId}` when
  debitTxnId is non-null (and a separate `Refund #${w.refundTxnId}`
  button when refundTxnId is non-null). Both buttons call focusTxn()
  with the matching id. After Task #1493 these buttons also carry
  `data-testid="wallet-withdrawal-txn-link-${w.debitTxnId}"` and
  `data-testid="wallet-withdrawal-refund-link-${w.refundTxnId}"` so
  selectors stay stable across copy / translation changes.
- The withdrawals section also exposes
  `data-testid="wallet-withdrawals-heading"`,
  `data-testid="wallet-withdrawals-table"`, and
  `data-testid="wallet-withdrawal-row-${w.id}"` per row.
- Only the first 8 withdrawal rows are rendered, so seeding exactly
  one withdrawal guarantees the deep-link button is visible.

DB SCHEMAS (lib/db/src/schema/golf.ts)
- sessions(sid varchar pk, sess jsonb, expire timestamp)
- app_users(id, replit_user_id, email, role, organization_id, ...)
- leagues(id, organization_id, name, format, type, status, ...)
- club_wallets(id, organization_id, user_id, currency, balance, ...)
    UNIQUE (organization_id, user_id, currency).
- club_wallet_txns(id, wallet_id, kind text, amount numeric,
    currency text, source_type text NOT NULL, source_id, payment_ref,
    note, balance_after numeric NOT NULL, created_at, ...)
- club_wallet_withdrawals(id, wallet_id, organization_id, user_id,
    amount, currency, method text NOT NULL, status text NOT NULL
    DEFAULT 'pending', debit_txn_id INT references club_wallet_txns.id
    ON DELETE SET NULL, refund_txn_id, requested_at, ...)
    Cleanup order: withdrawals → txns → wallet (txns FK cascades on
    wallet delete, but deleting txns before withdrawals is safer
    because the FK is ON DELETE SET NULL on debit_txn_id).

ENVIRONMENT
- The dev DB is shared with the user — never assert on absolute counts
  outside the seeded org, and always namespace seeded names with the
  randomly-generated ${tag}.
```

## Last verified

2026-04-29 — Task #1491 update. Plan now also asserts the deep-link
row is still mounted ~5 s after the click (after the highlight timer
clears) — the row's visibility is now keyed off the sticky
`extraTxnIds` set instead of the short-lived `highlightTxnId`.

2026-04-24 — Task #1266 initial commit. Run via
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
returned status `success`: opened the seeded league, switched to the
rounds tab, confirmed Side Games / Recent transactions rendered,
clicked the withdrawal's `Txn #${old_debit_txn_id}` reference, and
confirmed the matching ledger row was mounted with the
`bg-amber-300/20` highlight class, the correct seeded note, and
visible in the viewport.
