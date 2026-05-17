# Runbook — Apply migration 0059 (FK / index canonicalization) to production

**Migration file:** `lib/db/drizzle/0059_canonicalize_fk_names.sql`
**Owner:** Platform / DB on-call
**Risk:** Low — DDL only, idempotent, no data rows touched.
**Estimated wall-clock:** < 60 s of DDL. Schedule a 15-minute low-traffic
window to allow for verification.

## Why this exists

`pnpm --filter @workspace/db sync` was emitting ~1100 paired
`DROP CONSTRAINT` / `ADD CONSTRAINT` statements on every introspect against
production because the live DB carried both the legacy truncated /
short-form FK names AND drizzle's newer canonical names. Migration 0059
deduplicates each pair (drops the legacy or renames it to the canonical
name, depending on which is already present) and removes nine orphan
indexes the schema no longer declares. Dev, CI, and task-agent containers
already pick this up via `scripts/post-merge.sh`. This runbook covers
applying the same migration to **production** so prod stops drifting and
future deploys do not retrigger the constraint churn.

## Pre-flight

1. Confirm the prod `DATABASE_URL` is exported in your shell (use the
   prod credentials vault — never read it from a workflow env).
2. Confirm there is no in-flight deploy. The migration takes brief
   `ACCESS EXCLUSIVE` locks on each affected table while renaming /
   dropping constraints; concurrent long-running transactions on those
   tables can block the rename.
3. Take a logical backup snapshot or confirm the most recent automated
   snapshot is < 24 h old. Renames are reversible, but the index drops
   are not (the old index definitions live only in this runbook below).

## Apply

Run the migration directly with `psql`. The whole file is a single
`DO $$ ... $$` block, so it either succeeds or rolls back as one
statement. `ON_ERROR_STOP=1` is fine here because every operation
inside the block already guards on `pg_constraint` / `IF EXISTS`.

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/drizzle/0059_canonicalize_fk_names.sql
```

Expected output: `DO` (a single line). No `NOTICE` or `WARNING` rows
should be printed.

## Verify

1. **Constraint count check** — every legacy FK name listed below should
   no longer exist; every canonical FK name should be present exactly
   once.

   ```bash
   psql "$PROD_DATABASE_URL" -f - <<'SQL'
   SELECT conname FROM pg_constraint
   WHERE conname IN (
     'announcement_read_receipts_announcement_id_tournament_announcem',
     'delivery_receipt_lines_purchase_order_line_id_purchase_order_li',
     'member_account_charges_pos_transaction_id_pos_transactions_id_f',
     'member_account_charges_vendor_operator_id_vendor_operators_id_f',
     'staff_checkins_volunteer_assignment_id_volunteer_assignments_id',
     'store_credit_transactions_account_id_store_credit_accounts_id_f',
     'delivery_receipt_lines_delivery_receipt_id_delivery_receipts_id',
     'staff_checkins_caddie_assignment_id_caddie_event_assignments_id',
     'course_review_reports_user_fk',
     'course_review_reports_review_fk',
     'course_reviews_course_fk',
     'course_reviews_org_fk',
     'course_reviews_user_fk',
     'tee_dyn_pricing_audit_actor_fk',
     'tee_dyn_pricing_audit_org_fk',
     'tee_dyn_pricing_config_org_fk',
     'tee_dyn_pricing_mods_course_fk',
     'tee_dyn_pricing_mods_org_fk',
     'tee_dyn_pricing_tiers_course_fk',
     'tee_dyn_pricing_tiers_org_fk'
   );
   SQL
   ```

   Expected: zero rows.

   Then confirm the canonical names exist exactly once each (no duplicates,
   no missing renames):

   ```bash
   psql "$PROD_DATABASE_URL" -f - <<'SQL'
   WITH expected(conname) AS (VALUES
     ('announcement_read_receipts_announcement_id_fk'),
     ('delivery_receipt_lines_purchase_order_line_id_fk'),
     ('member_account_charges_pos_transaction_id_fk'),
     ('member_account_charges_vendor_operator_id_fk'),
     ('staff_checkins_volunteer_assignment_id_fk'),
     ('store_credit_transactions_account_id_fk'),
     ('delivery_receipt_lines_delivery_receipt_id_fk'),
     ('staff_checkins_caddie_assignment_id_fk'),
     ('course_review_reports_reporter_user_id_app_users_id_fk'),
     ('course_review_reports_review_id_course_reviews_id_fk'),
     ('course_reviews_course_id_courses_id_fk'),
     ('course_reviews_organization_id_organizations_id_fk'),
     ('course_reviews_user_id_app_users_id_fk'),
     ('tee_dynamic_pricing_audit_actor_user_id_app_users_id_fk'),
     ('tee_dynamic_pricing_audit_organization_id_organizations_id_fk'),
     ('tee_dynamic_pricing_config_organization_id_organizations_id_fk'),
     ('tee_dynamic_pricing_modifiers_course_id_courses_id_fk'),
     ('tee_dynamic_pricing_modifiers_organization_id_fk'),
     ('tee_dynamic_pricing_tiers_course_id_courses_id_fk'),
     ('tee_dynamic_pricing_tiers_organization_id_organizations_id_fk')
   )
   SELECT e.conname,
          COALESCE((SELECT count(*) FROM pg_constraint c WHERE c.conname = e.conname), 0) AS n
   FROM expected e
   WHERE COALESCE((SELECT count(*) FROM pg_constraint c WHERE c.conname = e.conname), 0) <> 1
   ORDER BY e.conname;
   SQL
   ```

   Expected: zero rows. Any row means a canonical FK is missing (`n = 0`)
   or duplicated (`n > 1`) — investigate before declaring success.

2. **Drift check** — run drizzle's introspect path against prod and
   confirm the diff is now a true no-op. Use the same wrapper CI uses
   so the destructive-statement gate is active:

   ```bash
   DATABASE_URL="$PROD_DATABASE_URL" \
     POST_MERGE_FORCE_INTROSPECT=1 DRY_RUN=1 \
     pnpm --filter @workspace/db sync
   ```

   Expected last line: `database already matches schema. No-op.`
   No `DROP CONSTRAINT` / `ADD CONSTRAINT` / `DROP INDEX` lines should
   appear in the printed diff.

3. **Smoke** — hit `/healthz` on the API artifact and pull a single row
   from each of the affected tables (e.g. `course_reviews`,
   `member_account_charges`, `staff_checkins`) to confirm reads still
   work end-to-end.

## Rollback

The constraint renames are reversible (`ALTER TABLE … RENAME CONSTRAINT
<canonical> TO <legacy>`) but should not be necessary — the schema
files now reference only the canonical names, so reverting renames
would re-introduce the diff churn.

The dropped indexes are not recreated by the schema (that is the whole
point), so a true rollback is only meaningful if a query plan
regression appears. If that happens, recreate them from this list:

| Index name | Notes |
| --- | --- |
| `tournament_staff_unique` | Replaced by a different unique key in the schema. |
| `league_staff_unique` | Replaced by a different unique key in the schema. |
| `locker_audit_org_idx` | Per-org index drizzle no longer emits. |
| `locker_assignments_org_idx` | Per-org index drizzle no longer emits. |
| `tee_schedule_templates_org_course_idx` | Replaced by a differently-keyed unique index. |
| `member_levy_charge_events_reverses_idx` | Replaced by a differently-keyed unique index. |
| `uq_round_submissions_marker_share_token` | Replaced by a differently-keyed unique index. |
| `shots_player_tournament_round_hole_shot_unique` | Replaced by a differently-keyed unique index. |
| `shots_user_gp_round_hole_shot_unique` | Replaced by a differently-keyed unique index. |

If you must restore one, dump its definition from a snapshot
(`pg_get_indexdef`) before recreating it `CONCURRENTLY` — none of these
were used by an FK, so a non-blocking rebuild is safe.

## Full rename / drop list (for the change ticket)

### Foreign key constraints — drop legacy, keep / rename to canonical

| Table | Legacy name | Canonical name |
| --- | --- | --- |
| `announcement_read_receipts` | `announcement_read_receipts_announcement_id_tournament_announcem` | `announcement_read_receipts_announcement_id_fk` |
| `delivery_receipt_lines` | `delivery_receipt_lines_purchase_order_line_id_purchase_order_li` | `delivery_receipt_lines_purchase_order_line_id_fk` |
| `member_account_charges` | `member_account_charges_pos_transaction_id_pos_transactions_id_f` | `member_account_charges_pos_transaction_id_fk` |
| `member_account_charges` | `member_account_charges_vendor_operator_id_vendor_operators_id_f` | `member_account_charges_vendor_operator_id_fk` |
| `staff_checkins` | `staff_checkins_volunteer_assignment_id_volunteer_assignments_id` | `staff_checkins_volunteer_assignment_id_fk` |
| `store_credit_transactions` | `store_credit_transactions_account_id_store_credit_accounts_id_f` | `store_credit_transactions_account_id_fk` |
| `delivery_receipt_lines` | `delivery_receipt_lines_delivery_receipt_id_delivery_receipts_id` | `delivery_receipt_lines_delivery_receipt_id_fk` |
| `staff_checkins` | `staff_checkins_caddie_assignment_id_caddie_event_assignments_id` | `staff_checkins_caddie_assignment_id_fk` |
| `course_review_reports` | `course_review_reports_user_fk` | `course_review_reports_reporter_user_id_app_users_id_fk` |
| `course_review_reports` | `course_review_reports_review_fk` | `course_review_reports_review_id_course_reviews_id_fk` |
| `course_reviews` | `course_reviews_course_fk` | `course_reviews_course_id_courses_id_fk` |
| `course_reviews` | `course_reviews_org_fk` | `course_reviews_organization_id_organizations_id_fk` |
| `course_reviews` | `course_reviews_user_fk` | `course_reviews_user_id_app_users_id_fk` |
| `tee_dynamic_pricing_audit` | `tee_dyn_pricing_audit_actor_fk` | `tee_dynamic_pricing_audit_actor_user_id_app_users_id_fk` |
| `tee_dynamic_pricing_audit` | `tee_dyn_pricing_audit_org_fk` | `tee_dynamic_pricing_audit_organization_id_organizations_id_fk` |
| `tee_dynamic_pricing_config` | `tee_dyn_pricing_config_org_fk` | `tee_dynamic_pricing_config_organization_id_organizations_id_fk` |
| `tee_dynamic_pricing_modifiers` | `tee_dyn_pricing_mods_course_fk` | `tee_dynamic_pricing_modifiers_course_id_courses_id_fk` |
| `tee_dynamic_pricing_modifiers` | `tee_dyn_pricing_mods_org_fk` | `tee_dynamic_pricing_modifiers_organization_id_fk` |
| `tee_dynamic_pricing_tiers` | `tee_dyn_pricing_tiers_course_fk` | `tee_dynamic_pricing_tiers_course_id_courses_id_fk` |
| `tee_dynamic_pricing_tiers` | `tee_dyn_pricing_tiers_org_fk` | `tee_dynamic_pricing_tiers_organization_id_organizations_id_fk` |

For each row: if the canonical name already exists, the migration drops
the legacy. Otherwise it renames the legacy to the canonical name. No
constraint is removed without an equivalent already in place.

### Indexes dropped (not recreated by the schema)

- `tournament_staff_unique`
- `league_staff_unique`
- `locker_audit_org_idx`
- `locker_assignments_org_idx`
- `tee_schedule_templates_org_course_idx`
- `member_levy_charge_events_reverses_idx`
- `uq_round_submissions_marker_share_token`
- `shots_player_tournament_round_hole_shot_unique`
- `shots_user_gp_round_hole_shot_unique`

## After the window

- Record the apply timestamp and the verify-step output in the
  change-management ticket.
- If the drift check still reports any FK rename or index drop, capture
  the diff and open a follow-up — the schema files may have drifted
  again since 0059 was authored.
