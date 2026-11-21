# Docline — documentation that keeps up with the code

Docline is a self-updating documentation pipeline. It reads a product release
diff, finds the documentation sections that own the topic, drafts updates in
your house voice with evidence citations, and holds everything for human
review. Nothing reaches the docs tree without an explicit approve → publish.

**Stack:** Next.js 16 (App Router) · TypeScript · PostgreSQL via Drizzle ORM · Tailwind CSS 4.

```
Detect ──> Retrieve ──> Draft ──> Review ──> Pull request
release diff   map sections   house voice   human gate   GitHub review
```

## Requirements

- **Node.js 20.9+** (22 LTS recommended). Check with `node -v`.
- **Docker** for the bundled Postgres, or any PostgreSQL 14+ you already run.
- (Optional) Ollama or an `OPENROUTER_API_KEY` for model-assisted drafting.

## Run it locally

From the unzipped folder in VS Code's terminal:

```bash
# 1. configure local settings
cp .env.example .env
# For Compose, set POSTGRES_PASSWORD and use the same password in DATABASE_URL.
# The Compose database defaults to host port 5433 to avoid common conflicts.
# If you choose another host port, set POSTGRES_PORT and update DATABASE_URL.

# 2. install the locked dependencies
npm ci

# 3. start only Postgres (first run downloads the image)
docker compose up -d db

# 4. apply the committed migrations
npx drizzle-kit migrate

# 5. start the app
npm run dev
```

Open **http://localhost:3000**. The first load creates workspace roles but
does not add sample products or documentation. Add a product from **Products**
before starting a run.

> If the zip didn't include `.env`, create it with a `DATABASE_URL` pointing to
> your PostgreSQL instance; for bundled Compose, also set matching
> `POSTGRES_PASSWORD` and `DATABASE_URL` values.

Production mode:

```bash
npm run build && npm start
```

## Configure a product and run the pipeline

1. Open **Products → Add product**. Provide a name and a source GitHub URL or
   an absolute local checkout path inside `REPOSITORY_ROOTS` (default:
   `./repos`). Documentation can share the source repo or use a separate repo.
2. Select **Sync documentation** to import Markdown, MDX, RST, and AsciiDoc
   files to the database corpus.
3. Open **New run** and choose **Local Git**, **GitHub compare**, or **Paste
   diff**. Supply revisions/context, choose a provider, and run the pipeline.
4. Review the evidence-linked proposal and edit drafts if needed, then approve
   and publish. The product's publish mode selects **Database**, **Local
   disk**, or **GitHub pull request**. Every mode requires approval.
5. Inspect the session and **Activity** for the result and audit trail.

Roles: **Writer** (create/edit) · **Reviewer** (edit/approve/reject/publish) ·
**Approver** (approve/publish). The sidebar switcher simulates the SSO/identity
layer; server routes enforce the gates.

## Drafting providers

- **Local engine** (default): deterministic signal extraction + tone-aligned
  drafting. No network, no data leaves the workspace.
- **Ollama**: run Ollama and configure `OLLAMA_URL` and (if needed)
  `OLLAMA_URL_ALLOWLIST`. Select an installed model in the UI.
- **OpenRouter**: set `OPENROUTER_API_KEY=...` in `.env` (server-side only,
  never sent to the browser). Provider errors or invalid proposals fall back
  to the deterministic local engine; only validated proposals are reviewable.

## Programmatic trigger

Wire this into a GitHub release action or cron job. CI authenticates with a
machine token (`PIPELINE_API_TOKEN` on the server) since pipeline diffs are
not public:

```bash
curl -X POST http://localhost:3000/api/runs \
  -H "content-type: application/json" \
  -H "authorization: Bearer $PIPELINE_API_TOKEN" \
  -d '{
    "productId": "<configured-product-id>",
    "baseRevision": "v1.0.0",
    "headRevision": "v1.1.0",
    "changeSummary": "One paragraph about the release.",
    "provider": "local",
    "model": "docline-local-1",
    "diffText": "<unified diff of the release>",
    "triggerType": "WEBHOOK"
  }'
```

Returns `{ sessionId, status }`; the session appears in the review queue.

## GitHub webhook trigger

Point a repository webhook at `POST /api/webhooks/github` (content type
`application/json`, **push** and **pull request** events). The server verifies
`X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET` (constant-time compare;
the route fails closed with 503 when the secret is unset), maps the pushed
repository to a product via its configured repo URL, resolves the
`before...after` compare diff from the GitHub API itself, and durably queues the
same pipeline in PostgreSQL. The response carries `{ status, jobId, jobStatus }`.
Poll `GET /api/jobs/{jobId}` for status and the resulting session.

Optional environment: `GITHUB_TOKEN` for private repositories and
`GITHUB_API_BASE` for GitHub Enterprise. Webhook runs use the product's
configured provider and model. Tag pushes, branch
deletions, branch creations, and pushes to unmapped repositories are
acknowledged with `{ "status": "ignored" }` rather than creating noise
sessions.

## GitHub pull-request publishing

Set `GITHUB_TOKEN` to a GitHub App or fine-grained token with read access to
the docs repository and permission to create branches and pull requests.
`GITHUB_API_BASE` may point to a GitHub Enterprise API. The product's docs
repository selects the documentation repository; when empty, the source
repository is used. The configured docs root must contain every proposed
document path. Set these values through **Products**. Remote file content
is compared with the reviewed snapshot, so stale docs block publishing rather
than being overwritten. A successful publish changes the session to
`PR_OPEN` and records the pull request URL; it does not merge or deploy docs.
When GitHub sends the merged pull-request event to this endpoint, the session
is updated to `PUBLISHED` and the internal documentation snapshot is updated
when its version still matches the reviewed base. If the snapshot has changed,
the merge remains published and an audit event records that synchronization
was skipped.

For a combined source/docs repository, leave the docs repository blank.

## Project map

```
src/db/schema.ts            tables: users, products, tone_profiles, documents,
                            sessions, document_edits, audit_events, jobs
src/lib/pipeline/engine.ts  diff parsing, signal extraction, retrieval,
                            tone drafting, proposal validation (pure TS)
src/lib/pipeline/llm.ts     Ollama/OpenRouter providers with validation
src/lib/actions.ts          runPipeline / editDraft / decide orchestration
src/lib/seed.ts             idempotent workspace-role bootstrap
src/app/products            product onboarding and configuration
src/lib/pipeline/docs.ts    document classification and repository paths
src/lib/pipeline/local-publisher.ts  guarded local-disk publication
src/app/api/runs            POST: run the pipeline
src/app/api/webhooks/github POST: verified GitHub push → durable job queue
src/app/api/jobs             GET: authenticated TypeScript job status
src/app/api/sessions/[id]   delete, actions (approve/reject/publish), edit
src/app/...                 dashboard, new run, review console, docs, activity, settings
Dockerfile · docker-compose.yml · drizzle.config.ts
```

## Troubleshooting

- `address already in use` on the configured Postgres host port → another
  service is bound to it. Set `POSTGRES_PORT` and the matching port in
  `DATABASE_URL` to an available value.
- `relation "sessions" does not exist` → tables not created:
  `npx drizzle-kit migrate`.
- First build downloads web fonts once (cached afterwards); builds offline after that.

## Architecture — unified application

```
 browser / CI ──► Next.js 16 · TypeScript ── PostgreSQL
                   dashboard, pipeline,       Drizzle, sessions,
                   review, jobs, API            and durable queue
```

Docline is a single Next.js + PostgreSQL application. The TypeScript pipeline
handles diff parsing, section retrieval, model-assisted drafting, validation,
review sessions, publication, and durable background jobs in one service.
Ollama and OpenRouter are optional drafting providers; PostgreSQL is the
application's only database.

## Deploy — Docker Compose (one command)

```bash
  cp .env.example .env        # set required secrets, POSTGRES_PASSWORD, SSO_PROXY_SECRET, and GITHUB_TOKEN
docker compose up --build
```

  Generate deployment secrets rather than using the placeholders in `.env.example`
  (for example, `openssl rand -hex 32`); configure `SSO_PROXY_SECRET` to match
  your trusted identity proxy, and set `POSTGRES_PASSWORD` consistently with the
  Compose database URL. Compose defaults to SSO mode; only set `DOCLINE_AUTH_MODE=demo` and
`DOCLINE_DEMO_MODE=1` for isolated evaluation deployments.
  Provision SSO users and roles in the web `users` table before they sign in.
  Compose runs **web** on `:3000` and PostgreSQL on loopback port `5433` by
  default. Configure each product's docs repository and root through **Products**
  before production publishing.

**Operational responsibilities:** keep each installation isolated as a
  single-tenant deployment, back up PostgreSQL, and define retention for
  completed/failed jobs and review records. Jobs retry up to five times and
  recover expired worker leases. Optional completion notifications can use
  Resend and Slack; configure them with the variables in `.env.example`.
  Suggested documentation checks are recorded for reviewers but are not
  executed by the pipeline; configure required checks in the documentation
  repository's PR settings.

  **Production topology:** put the web service behind your TLS terminator/SSO
  proxy (`DOCLINE_AUTH_MODE=sso` + `SSO_PROXY_SECRET`), set strong
  `GITHUB_WEBHOOK_SECRET` and `DOCLINE_SESSION_SECRET` values, and provision
  real users. Schema changes ship as reviewed SQL files in `drizzle/` (applied
  with `drizzle-kit migrate`; the dev-only `push --force` is never run in
  containers). Air-gapped installs can use the deterministic local engine or a
  pinned on-device Ollama model.

  Approval and publication are separate: an approved session is published only
  after a human decision, and publishers re-check document versions before
  writing.
