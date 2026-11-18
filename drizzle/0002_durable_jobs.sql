CREATE TABLE "pipeline_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"dedupe_key" text NOT NULL UNIQUE,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"result" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pipeline_jobs_ready_idx" ON "pipeline_jobs" USING btree ("status", "available_at", "created_at");
