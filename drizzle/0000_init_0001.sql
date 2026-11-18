CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"actor_id" text,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_edits" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"document_id" text NOT NULL,
	"doc_path" text NOT NULL,
	"section_heading" text NOT NULL,
	"before_content" text NOT NULL,
	"after_content" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"doc_version" integer NOT NULL,
	"edited_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"format" text DEFAULT 'md' NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"repo_url" text DEFAULT '' NOT NULL,
	"docs_root" text DEFAULT 'docs' NOT NULL,
	"tone_profile_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"trigger_type" text DEFAULT 'MANUAL' NOT NULL,
	"base_revision" text NOT NULL,
	"head_revision" text NOT NULL,
	"change_summary" text DEFAULT '' NOT NULL,
	"provider" text DEFAULT 'local' NOT NULL,
	"model" text DEFAULT 'docline-local-1' NOT NULL,
	"diff_text" text DEFAULT '' NOT NULL,
	"proposal" jsonb,
	"impact_statement" text DEFAULT '' NOT NULL,
	"uncertainties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tests_to_run" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejection_reason" text,
	"created_by_id" text,
	"reviewed_by_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tone_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"voice" text NOT NULL,
	"person" text DEFAULT 'second' NOT NULL,
	"formality" integer DEFAULT 2 NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"hue" integer DEFAULT 200 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_session_idx" ON "audit_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "edits_session_idx" ON "document_edits" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "documents_product_idx" ON "documents" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_product_idx" ON "sessions" USING btree ("product_id");