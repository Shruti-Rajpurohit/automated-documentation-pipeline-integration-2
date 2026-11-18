ALTER TABLE "products" RENAME COLUMN "repo_url" TO "source_repo_url";
ALTER TABLE "products" ADD COLUMN "source_repo_path" text DEFAULT '' NOT NULL;
ALTER TABLE "products" ADD COLUMN "docs_repo_path" text DEFAULT '' NOT NULL;
ALTER TABLE "products" ADD COLUMN "default_branch" text DEFAULT 'main' NOT NULL;
ALTER TABLE "products" ADD COLUMN "publish_mode" text DEFAULT 'github_pr' NOT NULL;
ALTER TABLE "products" ADD COLUMN "default_provider" text DEFAULT 'local' NOT NULL;
ALTER TABLE "products" ADD COLUMN "default_model" text DEFAULT 'docline-local-1' NOT NULL;
ALTER TABLE "products" ALTER COLUMN "docs_root" SET DEFAULT '';
ALTER TABLE "documents" ADD COLUMN "doc_kind" text DEFAULT 'other' NOT NULL;
ALTER TABLE "document_edits" ADD COLUMN "action" text DEFAULT 'replace' NOT NULL;
CREATE UNIQUE INDEX "documents_product_path_unique" ON "documents" USING btree ("product_id", "path");

UPDATE "documents"
SET "doc_kind" = CASE
  WHEN lower("path") ~ '(^|/)(api|reference|openapi)(/|[-_.]|$)' THEN 'api'
  WHEN lower("path") ~ '(^|/)(developer|setup|sdk|contributing)(/|[-_.]|$)' THEN 'developer'
  WHEN lower("path") ~ '(^|/)(user|guide|tutorial)(/|[-_.]|$)' THEN 'user'
  WHEN lower("path") ~ '(^|/)(blog|changelog|release|releases)(/|[-_.]|$)' THEN 'blog'
  ELSE 'other'
END;
