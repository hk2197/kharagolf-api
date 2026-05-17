-- Task #147: Club document library (operational docs + event attachments)

CREATE TABLE IF NOT EXISTS "operational_documents" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "category" text NOT NULL DEFAULT 'general',
  "object_path" text NOT NULL,
  "filename" text,
  "content_type" text,
  "file_size" integer,
  "visibility" text NOT NULL DEFAULT 'public',
  "uploaded_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "operational_documents_org_idx" ON "operational_documents"("organization_id");

CREATE TABLE IF NOT EXISTS "event_documents" (
  "id" serial PRIMARY KEY NOT NULL,
  "document_id" integer NOT NULL REFERENCES "operational_documents"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "event_id" integer NOT NULL,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "event_documents_doc_event_unique" ON "event_documents"("document_id", "event_type", "event_id");
CREATE INDEX IF NOT EXISTS "event_documents_event_idx" ON "event_documents"("event_type", "event_id");
