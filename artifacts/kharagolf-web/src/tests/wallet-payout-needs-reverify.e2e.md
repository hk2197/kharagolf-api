# E2E: Wallet "Re-save your account" banner clears `needs_attention`

Covers Task #1871. Canonical Playwright `runTest` plan for the
`SideGamesAdmin` → `WalletPanel` flow added in Task #1511, where the
daily payout-account re-verification cron (Task #1119) flipping a
member's saved UPI / bank to `needs_attention` surfaces an inline
"Re-save your UPI / bank to resume withdrawals" banner with the
persisted `verificationFailureReason`, disables the Withdraw button,
and the banner's "Re-save account" CTA jumps the member straight into
the saved-account form. Submitting the form clears `needs_attention`
and re-enables Withdraw.

The mobile-side mirror lives at
`artifacts/kharagolf-mobile/__tests__/wallet-payout-needs-reverify-e2e.test.tsx`.

The unit-level coverage already exists:
`artifacts/kharagolf-web/src/components/__tests__/WalletPayoutNeedsReverifyBanner.test.tsx`
covers the banner copy / CTA visibility in isolation, but it doesn't
exercise the click → form-open → POST `/wallet/payout-account` →
refetch → button-re-enable cycle. This e2e adds the missing user-facing
coverage for that cycle.

Replay it from any agent notebook with
`runTest({ testReplitAuth: true, testPlan, relevantTechnicalDocumentation })`
using the bodies below.

## Surface under test

- File: `artifacts/kharagolf-web/src/components/SideGamesAdmin.tsx`
  (the `WalletPanel` sub-component + the exported
  `WalletPayoutNeedsReverifyBanner`).
- Mounted from: `artifacts/kharagolf-web/src/pages/leagues.tsx` inside
  the league-detail sheet's "rounds" tab — same mount point as the
  Task #1266 deep-link e2e (`wallet-txn-ref-deeplink.e2e.md`).
- Endpoints exercised:
  - `GET  /api/organizations/:orgId/leagues`
  - `GET  /api/organizations/:orgId/leagues/:leagueId`
  - `GET  /api/wallet?organizationId=&currency=INR`
  - `GET  /api/wallet/payout-account?organizationId=`
  - `GET  /api/wallet/withdrawals?organizationId=`
  - `POST /api/wallet/payout-account` (intercepted via
    `page.route` — see step 7).
- Auth: any authenticated app_user in the same organization can render
  the rounds tab + WalletPanel, but we promote the freshly-logged-in
  user to `org_admin` so the leagues list/detail surfaces never gate on
  role and so the test can wipe + reseed leagues for the org.
- Selectors exercised here (Task #1493 / #1511 added stable
  `data-testid` props, so we select by id rather than visible text):
  - `[data-testid="banner-wallet-payout-needs-reverify"]` — the
    `<WalletPayoutNeedsReverifyBanner>` container; only mounted when
    `payout.account.verificationStatus === 'needs_attention'`.
  - `[data-testid="button-wallet-payout-needs-reverify-fix"]` — the
    "Re-save account" CTA inside that banner. Hidden when
    `accountFormOpen` is true so the form below isn't duplicated.
  - `[data-testid="wallet-payout-account-form"]` — the saved-account
    edit form container (only mounted while `accountFormOpen` is true).
  - `[data-testid="wallet-payout-account-method-tab-upi"]` /
    `…-method-tab-bank_account` — method tabs inside the form.
  - `[data-testid="wallet-payout-account-name"]` — holder-name input.
  - `[data-testid="wallet-payout-account-upi"]` — UPI VPA input
    (rendered only when method=upi).
  - `[data-testid="wallet-payout-account-submit"]` — the Save / Update
    account submit button.
  - `[data-testid="wallet-withdraw-toggle"]` — the "↑ Withdraw" button
    in the wallet header. Disabled when
    `verificationStatus === 'needs_attention'` (Task #1511 guard).

## Test plan

```text
1. [New Context] Create a new browser context.

2. [OIDC] Configure the next login claims to:
   { sub: "test-walletreverify-" + Date.now(),
     email: "walletreverify-e2e-" + Date.now() + "@example.com",
     first_name: "Wallet", last_name: "Reverify" }

3. [Browser] Navigate to /api/login?returnTo=%2F. Wait for the redirect
   chain to settle. Don't visually verify yet.

4. [DB] Promote the freshly-logged-in user to org_admin in BOTH the
   app_users table AND the active session blob (req.user is read from
   sessions.sess.user, not the DB). Then seed a deterministic league +
   club_wallet (with a positive balance so the Withdraw button isn't
   gated by `balance <= 0` on its own) + a `wallet_payout_accounts`
   row whose verified_at is populated but whose verification_status is
   'needs_attention' (mirrors what the daily cron leaves behind on a
   bounce).

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
   --   tag = 'WR' || floor(random()*1000000)::int
   INSERT INTO leagues (organization_id, name, format, type, status)
     VALUES (${org_id}, 'WALLET_REVERIFY_E2E_' || ${tag},
             'stableford', 'individual', 'draft')
     RETURNING id AS league_id;

   -- One wallet for (org, user, INR) with ₹250 sitting on it. Reuse if
   -- a prior run left one. The positive balance is what isolates the
   -- "Withdraw is disabled because of needs_attention" assertion from
   -- the unrelated "Withdraw is disabled because balance <= 0" guard.
   INSERT INTO club_wallets (organization_id, user_id, currency, balance)
     VALUES (${org_id}, ${user_id}, 'INR', '250.00')
     ON CONFLICT (organization_id, user_id, currency)
       DO UPDATE SET balance = '250.00'
     RETURNING id AS wallet_id;

   -- Wipe any prior payout-account / txns / withdrawals on this wallet
   -- so the fixture is deterministic across runs.
   DELETE FROM club_wallet_withdrawals WHERE wallet_id = ${wallet_id};
   DELETE FROM club_wallet_txns        WHERE wallet_id = ${wallet_id};
   DELETE FROM wallet_payout_accounts
     WHERE organization_id = ${org_id} AND user_id = ${user_id};

   -- The cron-flagged saved account. verified_at stays populated when
   -- the cron flips status to needs_attention (so the saved-account
   -- screen can keep showing the prior verification timestamp); only
   -- verification_status + verification_failure_reason change.
   -- razorpay_fund_account_id must be non-null too so the wallet
   -- payout API treats this as a registered account.
   INSERT INTO wallet_payout_accounts
     (organization_id, user_id, method, account_holder_name,
      upi_vpa, razorpay_contact_id, razorpay_fund_account_id,
      verified_at, verified_holder_name,
      verification_status, verification_failure_reason)
     VALUES (${org_id}, ${user_id}, 'upi', 'Wallet Reverify',
             'walletreverify@upi', 'cont_e2e_${tag}',
             'fa_e2e_${tag}',
             now() - interval '1 day', 'Wallet Reverify',
             'needs_attention',
             'VPA inactive at upstream bank')
     RETURNING id AS account_id;

5. [Browser] Navigate to /leagues. Wait for the page header
   ("Leagues" / "Season-long Competitions") to render. Dismiss any
   Vite runtime overlay if present.

6. [Browser] Use the search input (placeholder contains "Search
   leagues") at the top of the page to type
   "WALLET_REVERIFY_E2E_${tag}". Wait until exactly one league card is
   visible — the one whose <h3> text equals
   "WALLET_REVERIFY_E2E_${tag}". Click it. Inside the open sheet,
   click the tab whose visible text is "rounds" (plain button, not a
   Radix tab). Wait until the "Side Games" heading inside the sheet
   body is visible — that confirms SideGamesAdmin and its WalletPanel
   are mounted.

7. [Browser Route] Install a Playwright route handler on
   `**/api/wallet/payout-account` so the e2e can exercise the form's
   submit branch WITHOUT hitting the live Razorpay account on file in
   `RAZORPAY_KEY_ID` (rzp_live_*). The handler must:
     - On the POST request only, fulfil with a 200 JSON body that
       mirrors the real api-server's success shape — i.e.
       `{ account: { id: ${account_id}, method: 'upi',
                     accountHolderName: 'Wallet Reverify',
                     upiVpa: 'walletreverify@upi',
                     bankAccountNumberLast4: null, bankIfsc: null,
                     verified: true, verifiedAt: <ISO>,
                     verifiedHolderName: 'Wallet Reverify',
                     verificationStatus: 'verified',
                     verificationFailureReason: null,
                     hasRazorpayFundAccount: true,
                     updatedAt: <ISO> } }`.
       This stops the real route from creating a fund-account against
       the live Razorpay key.
     - On every other method (GET in particular), call `route.fallback()`
       so the WalletPanel's payout-account query keeps hitting the real
       api-server. The post-save invalidation then reads the row we
       update in step 9 below.

8. [Verify] BASELINE — banner is visible with the persisted reason
   AND the Withdraw button is disabled:
   - data-testid="banner-wallet-payout-needs-reverify" IS visible
     inside the open sheet. Its text contains both
     "Re-save your UPI to resume withdrawals" AND
     "Reason: VPA inactive at upstream bank" (the banner concatenates
     the persisted `verificationFailureReason`).
   - data-testid="wallet-withdraw-toggle" IS visible AND has the
     `disabled` attribute (the panel renders a real `<button disabled>`
     when verificationStatus === 'needs_attention'; with balance > 0
     and `verified: true`, this is the only thing that can be disabling
     it). Cross-check via the button's `title` attribute, which
     contains "Re-save your UPI / bank to resume withdrawals" on this
     code path.
   - data-testid="wallet-payout-account-form" does NOT exist yet
     (the form only renders while `accountFormOpen` is true).
   - data-testid="button-wallet-payout-needs-reverify-fix" IS visible
     (the CTA hides itself once the form is open, so its presence here
     also proves accountFormOpen is still false).

9. [Browser] Click data-testid="button-wallet-payout-needs-reverify-fix".
   The CTA's onClick fires `setWithdrawOpen(false); setAccountFormOpen(true)`.

   [Verify] After the click:
   - data-testid="wallet-payout-account-form" IS visible inside the
     sheet. (The CTA is hidden now too — the banner stays mounted but
     its button conditional flips off.)
   - The "UPI" method tab
     (`[data-testid="wallet-payout-account-method-tab-upi"]`) is
     visible — the form defaults to method=upi for UPI accounts.

10. [DB] Simulate a successful upstream re-verification by flipping the
    DB row to verified BEFORE the form submit (so the post-save
    refetch in step 12 sees the verified row even though the live
    Razorpay call was intercepted in step 7):
    UPDATE wallet_payout_accounts
       SET verification_status = 'verified',
           verification_failure_reason = NULL,
           verified_at = now(),
           verified_holder_name = 'Wallet Reverify',
           updated_at = now()
     WHERE id = ${account_id};

11. [Browser] Fill the form and submit:
    - Click data-testid="wallet-payout-account-method-tab-upi"
      (defensive — the form already starts on this tab).
    - Focus data-testid="wallet-payout-account-name", clear it, type
      "Wallet Reverify".
    - Focus data-testid="wallet-payout-account-upi", clear it, type
      "walletreverify@upi".
    - Click data-testid="wallet-payout-account-submit". The intercepted
      POST resolves with the success body from step 7, which fires
      saveAccount.onSuccess → setAccountFormOpen(false) →
      qc.invalidateQueries(["wallet-payout-account", orgId]) → the
      payout-account GET re-fires and now reads the row updated in
      step 10 — verificationStatus 'verified', no failure reason.

12. [Verify] AFTER SUBMIT — banner is gone AND the Withdraw button is
    re-enabled. (Allow up to 5 s for the invalidated GET to settle.)
    - data-testid="wallet-payout-account-form" does NOT exist (the
      success handler closed the form).
    - data-testid="banner-wallet-payout-needs-reverify" does NOT
      exist (the banner conditional unmounts when verificationStatus
      flips off 'needs_attention').
    - data-testid="wallet-withdraw-toggle" IS visible AND does NOT
      carry the `disabled` attribute. Its `title` attribute now
      contains "Withdraw to UPI / bank".

13. [DB] Cleanup (run regardless of pass/fail to keep the dev DB tidy):
    DELETE FROM wallet_payout_accounts WHERE id = ${account_id};
    DELETE FROM club_wallet_withdrawals WHERE wallet_id = ${wallet_id};
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

WHY THE POST IS INTERCEPTED
- The api-server's POST /api/wallet/payout-account calls Razorpay's
  live `/v1/contacts` + `/v1/fund_accounts` + `/v1/payments/validate/vpa`
  endpoints (see `artifacts/api-server/src/lib/razorpay.ts`).
  `RAZORPAY_KEY_ID` in this environment starts with `rzp_live_`, so an
  unstubbed POST would create a real contact / fund-account against the
  live merchant account every test run — destructive.
- Step 7 therefore installs `page.route('**/api/wallet/payout-account', …)`
  to fulfil the POST with a synthetic verified response while letting
  every GET fall through to the real api-server. Combined with the
  step-10 DB UPDATE, the post-save invalidation refetches the now-
  verified row from the real route — the banner unmounts and the
  Withdraw button re-enables exactly the same way it would after a
  real successful Razorpay verification.

ENDPOINTS THIS TEST RELIES ON
- GET  /api/organizations/:orgId/leagues
    → list of leagues for the org. No role gate.
- GET  /api/organizations/:orgId/leagues/:leagueId
    → league detail (rendered by the right-side sheet).
- GET  /api/wallet?organizationId=&currency=INR
    → { wallet, transactions[] }. WalletPanel uses this for the
      balance + recent ledger; we don't assert on the ledger here.
- GET  /api/wallet/payout-account?organizationId=
    → { account, limits }. Drives the banner conditional and the
      Withdraw-button disabled state. Returns
      verificationStatus / verificationFailureReason directly off
      the wallet_payout_accounts row.
- POST /api/wallet/payout-account
    → On success returns the same shape as GET, with
      verificationStatus='verified' and verificationFailureReason=null.
      Live route hits Razorpay; the e2e intercepts it (see above).
- GET  /api/wallet/withdrawals?organizationId=
    → { withdrawals[] }. Empty in this fixture.

WALLETPANEL BEHAVIOUR (artifacts/kharagolf-web/src/components/SideGamesAdmin.tsx)
- The Withdraw button is disabled when:
    withdrawBusy
    || balance <= 0
    || !payout?.account?.verified
    || payout?.account?.verificationStatus === 'needs_attention'
  Task #1511 added the last guard: the cron leaves verifiedAt populated
  (so the saved-account screen can keep showing the prior verification
  timestamp) but flips verificationStatus to 'needs_attention'. Without
  the extra guard the button would still render enabled and clicking
  it would only surface the API's PAYOUT_ACCOUNT_NEEDS_REVERIFY error.
- <WalletPayoutNeedsReverifyBanner> renders nothing unless
  verificationStatus === 'needs_attention'. When it renders, the
  visible body always contains "Re-save your UPI to resume withdrawals"
  (or "Re-save your bank account to resume withdrawals" for bank
  accounts), and appends "Reason: <verificationFailureReason>" when
  the cron persisted a reason.
- The banner's "Re-save account" CTA fires
  `setWithdrawOpen(false); setAccountFormOpen(true)`. The CTA is
  hidden (`!accountFormOpen` guard) once the form is open so the
  button doesn't duplicate the form below.
- saveAccount.onSuccess closes the form (`setAccountFormOpen(false)`)
  AND calls `qc.invalidateQueries(["wallet-payout-account", orgId])`.
  The next GET /api/wallet/payout-account refetch returns the freshly
  verified row, the banner conditional unmounts, and the Withdraw
  button re-enables.

PAYOUT ACCOUNT FORM PRE-FILL
- The form's local state (acctMethod / acctName / acctUpi / acctBank /
  acctIfsc) is initialised from `payout.account` via inline default
  fallbacks. In the real UI a member re-saving an account types the
  same VPA they already had on file; this plan therefore types the
  fixture's UPI VPA verbatim (step 11) instead of relying on the form
  to remember it. Avoids a flaky "the input was empty when I clicked
  submit" race during the test.

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
    DEFAULT 'pending', debit_txn_id, refund_txn_id, requested_at, ...)
- wallet_payout_accounts(id, organization_id, user_id,
    method text NOT NULL,                    -- 'upi' | 'bank_account'
    account_holder_name text NOT NULL,
    upi_vpa text, bank_account_number text, bank_ifsc text,
    razorpay_contact_id text, razorpay_fund_account_id text,
    verified_at timestamp, verified_holder_name text,
    verification_status text NOT NULL DEFAULT 'unverified',
    verification_failure_reason text,
    created_at, updated_at, ...)
    UNIQUE (organization_id, user_id).

ENVIRONMENT
- The dev DB is shared with the user — never assert on absolute counts
  outside the seeded org, and always namespace seeded names with the
  randomly-generated ${tag}.
```

## Last verified

Plan first authored on 2026-04-30 to cover the Task #1871 cycle:
seeded a `wallet_payout_accounts` row with
verification_status='needs_attention' + persisted failure reason,
opened the league sheet → rounds tab → WalletPanel, verified the
banner showed the persisted reason and the Withdraw button was
disabled, intercepted the Razorpay-bound POST, flipped the DB row to
verified to mirror the upstream re-verification, typed the VPA into
the form and submitted, and confirmed the banner unmounted and the
Withdraw button re-enabled (no `disabled` attribute) with its tooltip
flipping to "Withdraw to UPI / bank".
