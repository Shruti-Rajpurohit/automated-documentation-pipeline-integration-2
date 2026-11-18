ALTER TABLE "sessions" ADD COLUMN "delivery_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");