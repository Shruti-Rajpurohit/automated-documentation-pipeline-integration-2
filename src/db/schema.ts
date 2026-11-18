import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull(), // WRITER | REVIEWER | APPROVER | SYSTEM
  hue: integer("hue").notNull().default(200),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const toneProfiles = pgTable("tone_profiles", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  voice: text("voice").notNull(),
  person: text("person").notNull().default("second"),
  formality: integer("formality").notNull().default(2), // 1 casual - 5 formal
  rules: jsonb("rules").$type<string[]>().notNull().default([]),
  samples: jsonb("samples").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  tagline: text("tagline").notNull().default(""),
  repoUrl: text("repo_url").notNull().default(""),
  docsRoot: text("docs_root").notNull().default("docs"),
  docsRepoUrl: text("docs_repo_url").notNull().default(""),
  toneProfileId: text("tone_profile_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    path: text("path").notNull(),
    title: text("title").notNull(),
    format: text("format").notNull().default("md"),
    content: text("content").notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("documents_product_idx").on(t.productId)]
);

// A pipeline run that produced a reviewable proposal.
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(), // AWAITING_REVIEW | APPROVED | REJECTED | PR_OPEN | PUBLISHED | NO_UPDATE | NEEDS_INVESTIGATION
    triggerType: text("trigger_type").notNull().default("MANUAL"), // MANUAL | RELEASE | WEBHOOK
    baseRevision: text("base_revision").notNull(),
    headRevision: text("head_revision").notNull(),
    changeSummary: text("change_summary").notNull().default(""),
    provider: text("provider").notNull().default("local"), // local | openrouter
    model: text("model").notNull().default("docline-local-1"),
    diffText: text("diff_text").notNull().default(""),
    proposal: jsonb("proposal").$type<Record<string, unknown>>(),
    impactStatement: text("impact_statement").notNull().default(""),
    uncertainties: jsonb("uncertainties").$type<string[]>().notNull().default([]),
    testsToRun: jsonb("tests_to_run").$type<string[]>().notNull().default([]),
    rejectionReason: text("rejection_reason"),
    deliveryId: text("delivery_id"), // webhook dedupe: X-GitHub-Delivery
    createdById: text("created_by_id"),
    reviewedById: text("reviewed_by_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sessions_status_idx").on(t.status),
    index("sessions_product_idx").on(t.productId),
  ]
);

export const documentEdits = pgTable(
  "document_edits",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    documentId: text("document_id").notNull(),
    docPath: text("doc_path").notNull(),
    sectionHeading: text("section_heading").notNull(),
    beforeContent: text("before_content").notNull(),
    afterContent: text("after_content").notNull(),
    evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
    docVersion: integer("doc_version").notNull(), // snapshot at proposal time
    editedById: text("edited_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("edits_session_idx").on(t.sessionId)]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("audit_session_idx").on(t.sessionId)]
);

export const pipelineJobs = pgTable(
  "pipeline_jobs",
  {
    id: text("id").primaryKey(),
    jobType: text("job_type").notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("pipeline_jobs_ready_idx").on(t.status, t.availableAt, t.createdAt),
  ]
);
