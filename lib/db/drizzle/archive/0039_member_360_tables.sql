-- Task #351: Provision the Member 360 tables (Task #166 family) that until
-- now only existed via `drizzle-kit push --force` running in the background
-- of post-merge.sh. Tests that depend on these tables (the bulk-reverse
-- preview tests, documents-verify-bulk, etc.) hit "relation does not exist"
-- on a freshly seeded database because the push race had not finished.
--
-- Every CREATE here is idempotent (IF NOT EXISTS) so it is safe to re-run
-- and safe to layer on top of databases that have already been pushed by
-- drizzle-kit. Subsequent column-additive migrations (0030-0038) are
-- already wrapped in their own DO blocks / IF NOT EXISTS clauses, so this
-- file plus the existing migration chain leaves the schema in the same
-- shape as `lib/db/src/schema/golf.ts`.

-- ─────────────────────────── member_profile_ext ───────────────────────────
CREATE TABLE IF NOT EXISTS "member_profile_ext" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "middle_name" text,
  "preferred_name" text,
  "salutation" text,
  "gender" text,
  "pronouns" text,
  "nationality" text,
  "occupation" text,
  "employer" text,
  "address_line1" text,
  "address_line2" text,
  "city" text,
  "state" text,
  "postal_code" text,
  "country" text,
  "emergency_contact_name" text,
  "emergency_contact_phone" text,
  "emergency_contact_relation" text,
  "preferred_tee" text,
  "dominant_hand" text,
  "preferred_cart" text,
  "shirt_size" text,
  "shoe_size" text,
  "gloves_size" text,
  "kyc_status" text NOT NULL DEFAULT 'pending',
  "kyc_verified_at" timestamptz,
  "kyc_verified_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "is_vip" boolean NOT NULL DEFAULT false,
  "internal_tags" jsonb DEFAULT '[]'::jsonb,
  "two_factor_enabled" boolean NOT NULL DEFAULT false,
  "two_factor_method" text,
  "joining_fee" numeric(12,2) NOT NULL DEFAULT '0',
  "refundable_deposit" numeric(12,2) NOT NULL DEFAULT '0',
  "credit_limit" numeric(12,2) NOT NULL DEFAULT '0',
  "lifecycle_status" text NOT NULL DEFAULT 'active',
  "lifecycle_status_until" timestamptz,
  "lifecycle_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "member_profile_ext_member_unique" ON "member_profile_ext"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_profile_ext_org_idx" ON "member_profile_ext"("organization_id");
CREATE INDEX IF NOT EXISTS "member_profile_ext_status_idx" ON "member_profile_ext"("organization_id", "lifecycle_status");

-- ─────────────────────────── member_documents ─────────────────────────────
CREATE TABLE IF NOT EXISTS "member_documents" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "document_type" text NOT NULL,
  "title" text NOT NULL,
  "file_url" text NOT NULL,
  "mime_type" text,
  "file_size" integer,
  "expires_at" timestamptz,
  "is_verified" boolean NOT NULL DEFAULT false,
  "verified_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "verified_at" timestamptz,
  "is_rejected" boolean NOT NULL DEFAULT false,
  "rejected_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "rejected_at" timestamptz,
  "rejection_reason" text,
  "uploaded_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_documents_member_idx" ON "member_documents"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_documents_type_idx" ON "member_documents"("organization_id", "document_type");

-- ─────────────────────── member_document_versions ─────────────────────────
CREATE TABLE IF NOT EXISTS "member_document_versions" (
  "id" serial PRIMARY KEY,
  "member_document_id" integer NOT NULL REFERENCES "member_documents"("id") ON DELETE CASCADE,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "file_url" text NOT NULL,
  "mime_type" text,
  "file_size" integer,
  "replaced_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "replaced_at" timestamptz NOT NULL DEFAULT now(),
  "source" text NOT NULL DEFAULT 'replace',
  "restored_from_version_id" integer
);
CREATE INDEX IF NOT EXISTS "member_document_versions_doc_idx" ON "member_document_versions"("member_document_id");

-- ─────────────────────────── member_consents ──────────────────────────────
CREATE TABLE IF NOT EXISTS "member_consents" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "consent_type" text NOT NULL,
  "granted" boolean NOT NULL,
  "version" text,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  "source" text,
  "ip_address" text,
  "evidence_url" text,
  "recorded_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "member_consents_member_idx" ON "member_consents"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_consents_type_idx" ON "member_consents"("organization_id", "consent_type");

-- ─────────────────────────── member_comm_prefs ────────────────────────────
CREATE TABLE IF NOT EXISTS "member_comm_prefs" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "category" text NOT NULL,
  "email_enabled" boolean NOT NULL DEFAULT true,
  "sms_enabled" boolean NOT NULL DEFAULT false,
  "push_enabled" boolean NOT NULL DEFAULT true,
  "whatsapp_enabled" boolean NOT NULL DEFAULT false,
  "in_app_enabled" boolean NOT NULL DEFAULT true,
  "quiet_hours_start" text,
  "quiet_hours_end" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "member_comm_prefs_member_cat_unique" ON "member_comm_prefs"("club_member_id", "category");
CREATE INDEX IF NOT EXISTS "member_comm_prefs_org_idx" ON "member_comm_prefs"("organization_id");

-- ─────────────────────────── member_family_links ──────────────────────────
CREATE TABLE IF NOT EXISTS "member_family_links" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "primary_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "linked_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "relationship" text NOT NULL,
  "is_primary_payer" boolean NOT NULL DEFAULT false,
  "can_book_on_behalf" boolean NOT NULL DEFAULT false,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "member_family_links_pair_unique" ON "member_family_links"("primary_member_id", "linked_member_id");
CREATE INDEX IF NOT EXISTS "member_family_links_linked_idx" ON "member_family_links"("linked_member_id");
CREATE INDEX IF NOT EXISTS "member_family_links_org_idx" ON "member_family_links"("organization_id");

-- ──────────────────────── member_lifecycle_events ─────────────────────────
CREATE TABLE IF NOT EXISTS "member_lifecycle_events" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "effective_from" timestamptz NOT NULL DEFAULT now(),
  "effective_until" timestamptz,
  "from_value" text,
  "to_value" text,
  "reason" text,
  "internal_notes" text,
  "fee_impact" numeric(12,2),
  "performed_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_lifecycle_events_member_idx" ON "member_lifecycle_events"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_lifecycle_events_org_type_idx" ON "member_lifecycle_events"("organization_id", "event_type");

-- ─────────────────────────── member_disciplinary ──────────────────────────
CREATE TABLE IF NOT EXISTS "member_disciplinary" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "incident_date" timestamptz NOT NULL,
  "category" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'warning',
  "description" text NOT NULL,
  "fine_amount" numeric(12,2),
  "status" text NOT NULL DEFAULT 'open',
  "resolution_notes" text,
  "resolved_at" timestamptz,
  "recorded_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_disciplinary_member_idx" ON "member_disciplinary"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_disciplinary_org_status_idx" ON "member_disciplinary"("organization_id", "status");

-- ───────────────────────── member_internal_notes ──────────────────────────
CREATE TABLE IF NOT EXISTS "member_internal_notes" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "author_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE RESTRICT,
  "body" text NOT NULL,
  "category" text,
  "is_pinned" boolean NOT NULL DEFAULT false,
  "visibility" text NOT NULL DEFAULT 'staff',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_internal_notes_member_idx" ON "member_internal_notes"("club_member_id");

-- ─────────────────────────── member_audit_log ─────────────────────────────
CREATE TABLE IF NOT EXISTS "member_audit_log" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "actor_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "actor_name" text,
  "actor_role" text,
  "entity" text NOT NULL,
  "entity_id" integer,
  "action" text NOT NULL,
  "field_changes" jsonb,
  "reason" text,
  "metadata" jsonb,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_audit_member_idx" ON "member_audit_log"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_audit_org_created_idx" ON "member_audit_log"("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "member_audit_entity_idx" ON "member_audit_log"("entity", "entity_id");

-- ──────────────────────────── member_levies ───────────────────────────────
CREATE TABLE IF NOT EXISTS "member_levies" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "amount" numeric(12,2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'INR',
  "scope" text NOT NULL DEFAULT 'all',
  "scope_filter" jsonb,
  "due_date" timestamptz,
  "status" text NOT NULL DEFAULT 'draft',
  "applied_at" timestamptz,
  "applied_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_levies_org_idx" ON "member_levies"("organization_id");

-- ───────────────────────── member_levy_charges ────────────────────────────
CREATE TABLE IF NOT EXISTS "member_levy_charges" (
  "id" serial PRIMARY KEY,
  "levy_id" integer NOT NULL REFERENCES "member_levies"("id") ON DELETE CASCADE,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "amount" numeric(12,2) NOT NULL,
  "paid" boolean NOT NULL DEFAULT false,
  "paid_at" timestamptz,
  "status" text NOT NULL DEFAULT 'unpaid',
  "paid_amount" numeric(12,2) NOT NULL DEFAULT '0',
  "refunded_amount" numeric(12,2) NOT NULL DEFAULT '0',
  "waived_reason" text,
  "invoice_id" integer,
  "last_receipt_status" text,
  "last_receipt_reason" text,
  "last_receipt_kind" text,
  "last_receipt_amount" numeric(12,2),
  "last_receipt_note" text,
  "last_receipt_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "member_levy_charges_unique" ON "member_levy_charges"("levy_id", "club_member_id");
CREATE INDEX IF NOT EXISTS "member_levy_charges_member_idx" ON "member_levy_charges"("club_member_id");

-- ─────────────────────── member_levy_charge_events ────────────────────────
CREATE TABLE IF NOT EXISTS "member_levy_charge_events" (
  "id" serial PRIMARY KEY,
  "charge_id" integer NOT NULL REFERENCES "member_levy_charges"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "reverses_event_id" integer REFERENCES "member_levy_charge_events"("id") ON DELETE SET NULL,
  "amount" numeric(12,2) NOT NULL DEFAULT '0',
  "method" text,
  "processor_reference" text,
  "note" text,
  "reason" text,
  "actor_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "actor_name" text,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_levy_charge_events_charge_idx" ON "member_levy_charge_events"("charge_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "member_levy_charge_events_org_time_idx" ON "member_levy_charge_events"("organization_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "member_levy_charge_events_member_idx" ON "member_levy_charge_events"("club_member_id");

-- ────────────────────── member_levy_charge_payments ───────────────────────
CREATE TABLE IF NOT EXISTS "member_levy_charge_payments" (
  "id" serial PRIMARY KEY,
  "levy_charge_id" integer NOT NULL REFERENCES "member_levy_charges"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "amount" numeric(12,2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'INR',
  "provider" text NOT NULL,
  "provider_payment_id" text,
  "provider_order_id" text,
  "source" text NOT NULL,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "member_levy_charge_payments_provider_unique"
  ON "member_levy_charge_payments"("provider", "provider_payment_id")
  WHERE "provider_payment_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "member_levy_charge_payments_charge_idx" ON "member_levy_charge_payments"("levy_charge_id");

-- ─────────────────────── member_levy_receipt_attempts ─────────────────────
CREATE TABLE IF NOT EXISTS "member_levy_receipt_attempts" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "charge_id" integer NOT NULL REFERENCES "member_levy_charges"("id") ON DELETE CASCADE,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "levy_name" text NOT NULL,
  "currency" text NOT NULL,
  "transaction_amount" numeric(12,2) NOT NULL,
  "new_balance" numeric(12,2) NOT NULL,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "push_status" text,
  "push_attempts" integer NOT NULL DEFAULT 0,
  "last_push_at" timestamptz,
  "last_push_error" text,
  "last_push_retry_at" timestamptz,
  "push_retry_exhausted_at" timestamptz,
  "sms_status" text,
  "sms_attempts" integer NOT NULL DEFAULT 0,
  "last_sms_at" timestamptz,
  "last_sms_error" text,
  "last_sms_retry_at" timestamptz,
  "sms_retry_exhausted_at" timestamptz,
  "whatsapp_status" text,
  "whatsapp_attempts" integer NOT NULL DEFAULT 0,
  "last_whatsapp_at" timestamptz,
  "last_whatsapp_error" text,
  "last_whatsapp_retry_at" timestamptz,
  "whatsapp_retry_exhausted_at" timestamptz,
  "push_exhaustion_notified_at" timestamptz,
  "sms_exhaustion_notified_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "member_levy_receipt_attempts_charge_idx" ON "member_levy_receipt_attempts"("charge_id");
CREATE INDEX IF NOT EXISTS "member_levy_receipt_attempts_org_idx" ON "member_levy_receipt_attempts"("organization_id");
CREATE INDEX IF NOT EXISTS "member_levy_receipt_attempts_member_idx" ON "member_levy_receipt_attempts"("club_member_id");

-- ───────────────────── levy_ledger_email_schedules ────────────────────────
CREATE TABLE IF NOT EXISTS "levy_ledger_email_schedules" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "levy_id" integer NOT NULL REFERENCES "member_levies"("id") ON DELETE CASCADE,
  "frequency" text NOT NULL,
  "recipients" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "last_sent_at" timestamptz,
  "next_run_at" timestamptz NOT NULL,
  "created_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "levy_ledger_email_schedules_unique" ON "levy_ledger_email_schedules"("organization_id", "levy_id");
CREATE INDEX IF NOT EXISTS "levy_ledger_email_schedules_next_run_idx" ON "levy_ledger_email_schedules"("next_run_at");

CREATE TABLE IF NOT EXISTS "levy_ledger_email_runs" (
  "id" serial PRIMARY KEY,
  "schedule_id" integer NOT NULL REFERENCES "levy_ledger_email_schedules"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  "period_start" timestamptz,
  "period_end" timestamptz NOT NULL,
  "recipients" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "row_count" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL,
  "error_message" text
);
CREATE INDEX IF NOT EXISTS "levy_ledger_email_runs_schedule_idx" ON "levy_ledger_email_runs"("schedule_id", "sent_at");

CREATE TABLE IF NOT EXISTS "levy_ledger_email_org_schedules" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "frequency" text NOT NULL,
  "recipients" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "delivery_format" text NOT NULL DEFAULT 'combined',
  "last_sent_at" timestamptz,
  "next_run_at" timestamptz NOT NULL,
  "created_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "levy_ledger_email_org_schedules_unique" ON "levy_ledger_email_org_schedules"("organization_id");
CREATE INDEX IF NOT EXISTS "levy_ledger_email_org_schedules_next_run_idx" ON "levy_ledger_email_org_schedules"("next_run_at");

CREATE TABLE IF NOT EXISTS "levy_ledger_email_org_runs" (
  "id" serial PRIMARY KEY,
  "schedule_id" integer NOT NULL REFERENCES "levy_ledger_email_org_schedules"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  "period_start" timestamptz,
  "period_end" timestamptz NOT NULL,
  "recipients" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "row_count" integer NOT NULL DEFAULT 0,
  "levy_count" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL,
  "error_message" text
);
CREATE INDEX IF NOT EXISTS "levy_ledger_email_org_runs_schedule_idx" ON "levy_ledger_email_org_runs"("schedule_id", "sent_at");

-- ────────────────────────── member_milestones ─────────────────────────────
CREATE TABLE IF NOT EXISTS "member_milestones" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "milestone_type" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "course_name" text,
  "hole_number" integer,
  "yardage" integer,
  "club" text,
  "witnesses" text,
  "details" text,
  "verified" boolean NOT NULL DEFAULT false,
  "verified_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_milestones_member_idx" ON "member_milestones"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_milestones_org_type_idx" ON "member_milestones"("organization_id", "milestone_type");

-- ────────────────────────── member_access_cards ───────────────────────────
CREATE TABLE IF NOT EXISTS "member_access_cards" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "card_type" text NOT NULL DEFAULT 'rfid',
  "card_number" text NOT NULL,
  "card_label" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "deactivated_at" timestamptz,
  "deactivated_reason" text,
  "last_seen_at" timestamptz,
  "issued_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "member_access_cards_number_unique" ON "member_access_cards"("organization_id", "card_number");
CREATE INDEX IF NOT EXISTS "member_access_cards_member_idx" ON "member_access_cards"("club_member_id");

CREATE TABLE IF NOT EXISTS "member_access_log" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "club_member_id" integer REFERENCES "club_members"("id") ON DELETE SET NULL,
  "card_id" integer REFERENCES "member_access_cards"("id") ON DELETE SET NULL,
  "card_number" text,
  "zone" text,
  "result" text NOT NULL DEFAULT 'granted',
  "reason" text,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_access_log_member_idx" ON "member_access_log"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_access_log_org_time_idx" ON "member_access_log"("organization_id", "occurred_at");

-- ──────────────────────── member_committee_roles ──────────────────────────
CREATE TABLE IF NOT EXISTS "member_committee_roles" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "committee" text NOT NULL,
  "position" text NOT NULL,
  "term_start" timestamptz NOT NULL,
  "term_end" timestamptz,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_committee_roles_member_idx" ON "member_committee_roles"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_committee_roles_org_idx" ON "member_committee_roles"("organization_id", "committee");

-- ──────────────────────── member_saved_segments ───────────────────────────
CREATE TABLE IF NOT EXISTS "member_saved_segments" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "owner_user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "filters" jsonb NOT NULL,
  "is_shared" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_saved_segments_org_idx" ON "member_saved_segments"("organization_id");
CREATE INDEX IF NOT EXISTS "member_saved_segments_owner_idx" ON "member_saved_segments"("owner_user_id");

-- ─────────────────────────── member_messages ──────────────────────────────
CREATE TABLE IF NOT EXISTS "member_messages" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sender_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "channel" text NOT NULL DEFAULT 'in_app',
  "subject" text,
  "body" text NOT NULL,
  "status" text NOT NULL DEFAULT 'sent',
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  "read_at" timestamptz,
  "error_message" text,
  "related_entity" text,
  "related_entity_id" integer
);
CREATE INDEX IF NOT EXISTS "member_messages_member_idx" ON "member_messages"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_messages_org_time_idx" ON "member_messages"("organization_id", "sent_at");
CREATE INDEX IF NOT EXISTS "member_messages_related_idx" ON "member_messages"("related_entity", "related_entity_id");

-- ───────────────────────── member_data_requests ───────────────────────────
CREATE TABLE IF NOT EXISTS "member_data_requests" (
  "id" serial PRIMARY KEY,
  "club_member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "request_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "due_by" timestamptz,
  "resolved_at" timestamptz,
  "notes" text,
  "artifact_url" text,
  "handler_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "last_notification_kind" text,
  "last_notified_at" timestamptz,
  "last_email_status" text,
  "last_email_at" timestamptz,
  "last_email_error" text,
  "last_in_app_message_id" integer REFERENCES "member_messages"("id") ON DELETE SET NULL,
  "last_in_app_at" timestamptz,
  "last_push_status" text,
  "last_push_at" timestamptz,
  "last_push_error" text,
  "last_sms_status" text,
  "last_sms_at" timestamptz,
  "last_sms_error" text,
  "push_attempts" integer NOT NULL DEFAULT 0,
  "sms_attempts" integer NOT NULL DEFAULT 0,
  "last_push_retry_at" timestamptz,
  "last_sms_retry_at" timestamptz,
  "push_retry_exhausted_at" timestamptz,
  "sms_retry_exhausted_at" timestamptz,
  "last_whatsapp_status" text,
  "last_whatsapp_at" timestamptz,
  "last_whatsapp_error" text,
  "whatsapp_attempts" integer NOT NULL DEFAULT 0,
  "last_whatsapp_retry_at" timestamptz,
  "whatsapp_retry_exhausted_at" timestamptz,
  "email_attempts" integer NOT NULL DEFAULT 0,
  "last_email_retry_at" timestamptz,
  "email_retry_exhausted_at" timestamptz,
  "email_exhaustion_notified_at" timestamptz,
  "push_exhaustion_notified_at" timestamptz,
  "sms_exhaustion_notified_at" timestamptz,
  "whatsapp_exhaustion_notified_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "member_data_requests_member_idx" ON "member_data_requests"("club_member_id");
CREATE INDEX IF NOT EXISTS "member_data_requests_org_status_idx" ON "member_data_requests"("organization_id", "status");
