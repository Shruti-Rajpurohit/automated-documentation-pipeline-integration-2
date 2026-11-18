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
Poll `GET /api/jobs/{jobId}` for status and the resulting session. The Python
service exposes its queue status through `GET /api/backend/jobs/{jobId}`.

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
src/app/api/backend/[...path] trusted-proxy bridge to the Python service
src/app/api/sessions/[id]   actions (approve/reject/publish), edit (draft edits)
src/app/...                 dashboard, new run, review console, docs, activity, settings
backend/app/                FastAPI pipeline service (analyzer, finder,
                            patch writer, review persistence, webhooks)
backend/tests/              Python test suite (python -m unittest discover)
Dockerfile / backend/Dockerfile · docker-compose.yml · drizzle.config.ts
```

## Troubleshooting

- `address already in use` on the configured Postgres host port → another
  service is bound to it. Set `POSTGRES_PORT` and the matching port in
  `DATABASE_URL` to an available value.
- `relation "sessions" does not exist` → tables not created:
  `npx drizzle-kit migrate`.
- First build downloads web fonts once (cached afterwards); builds offline after that.

## Architecture — two tiers, one product

```
                 ┌──────────────────────────────┐
 browser / CI ──►│  Next.js  (this app, :3000)  │── PostgreSQL (Drizzle + jobs)
  one origin     │  dashboard · TS pipeline ·   │
                 │  review console · audit      │
                 └──────────────┬───────────────┘
                                │ trusted proxy:
                                │ /api/backend/* injects
                                │ X-Authenticated-User-ID +
                                │ X-Auth-Proxy-Secret
                                ▼
                 ┌──────────────────────────────┐
                 │ FastAPI  (backend/, :8000)  │── SQLite review store
                 │  git-native diff analysis ·  │── product/docs git
                 │  Ollama / OpenRouter drafts  │   checkouts on disk
                 │  PostgreSQL job queue       │── PostgreSQL
                 └──────────────────────────────┘
```

**Web tier (Next.js 16 + PostgreSQL)** — the dashboard, review console, docs
tree, roles, audit trail, plus a self-contained TypeScript pipeline
(`src/lib/pipeline/`) that works from pasted diffs or verified GitHub
webhooks. It can serve clients entirely on its own.

**Pipeline service (`backend/` — FastAPI + SQLite + Ollama/OpenRouter)** — the
original Python service, vendored in and productionized: it compares two
revisions of a real git checkout, scans a documentation working tree on disk,
drafts evidence-linked patches with a local or hosted model, and persists
review sessions with role-gated approve/reject. Use it for enterprise
customers whose compliance teams require analysis to run against their own
source trees without code ever leaving their network.

They integrate through `/api/backend/*`: the Next.js server is the
**trusted proxy** the FastAPI service is designed for — it strips
client-supplied identity and injects `X-Authenticated-User-ID` /
`X-Auth-Proxy-Secret` server-side (secret never reaches the browser). The
dashboard role switcher maps to provisioned backend users via
`BACKEND_USER_MAP` (default `{"WRITER":1,"REVIEWER":2,"APPROVER":3}`).

Module mapping between the tiers (the TS engine mirrors the Python contract):

| FastAPI service            | Here                                     |
| -------------------------- | ---------------------------------------- |
| analyzer / diff parsing    | `src/lib/pipeline/engine.ts`             |
| Ollama/OpenRouter clients  | `src/lib/pipeline/llm.ts` (+ local engine) |
| session/review endpoints   | `src/app/api/runs`, `src/app/api/sessions/[id]/*` |
| SQLite review models       | backend database (separate from web tier) |
| trusted-proxy auth headers | `src/app/api/backend/[...path]/route.ts` |
| Next.js dashboard          | `src/app/*` (this app)                   |

## Deploy — Docker Compose (one command)

```bash
cp .env.example .env        # set required secrets, POSTGRES_PASSWORD, SSO_PROXY_SECRET, and GITHUB_TOKEN
docker compose up --build
```

Generate deployment secrets rather than using the placeholders in `.env.example`
(for example, `openssl rand -hex 32`); set the same `AUTH_PROXY_SECRET` for web
and API, configure `SSO_PROXY_SECRET` to match the trusted identity proxy, and
set `POSTGRES_PASSWORD` consistently with the Compose database URL. Compose
defaults to SSO mode; only set `DOCLINE_AUTH_MODE=demo` and
`DOCLINE_DEMO_MODE=1` for isolated evaluation deployments.
The web `users` table must contain the SSO users and roles before they sign in;
the Python identities are provisioned separately.

- **web** on `:3000` — Next.js; creates/upgrades Postgres tables on boot.
- **api** on `127.0.0.1:8000` — FastAPI; loopback-only publish by design
  (clients never reach it directly; the trusted proxy does). Provisions the
  three review identities on boot. Mount product + docs git checkouts into
  `./repos` (both must live under `REPOSITORY_ROOTS=/srv/repos`).
- **db** on `127.0.0.1:5433` by default (container port `5432`) — PostgreSQL
  for the web tier and both durable job queues.
- Configure each product's docs repository and root through **Products** before production
  publishing. The Python queue worker is enabled by `QUEUE_DATABASE_URL`, which
  Compose points at this same PostgreSQL service.

**Operational responsibilities:** keep each installation isolated as a
single-tenant deployment, back up PostgreSQL and the Python SQLite data volume,
and define retention for completed/failed jobs and review records. Jobs retry
up to five times and recover expired worker leases; completion notifications
are not sent, so consumers should poll the job-status endpoints. Suggested
documentation checks are recorded for reviewers but are not executed by the
pipeline; configure required checks in the documentation repository's PR
settings.

Talk to the Python tier through the proxy:

The bridge requires a Docline session (cookie above); the backend user is
derived from the signed-in user's database role — no client-chosen roles.

```bash
curl -b cookies.txt http://localhost:3000/api/backend/healthz
curl -b cookies.txt -X POST http://localhost:3000/api/backend/sessions \
  -H "content-type: application/json" \
  -d '{
    "source_repo": "/srv/repos/my-product",
    "docs_repo": "/srv/repos/my-product-docs",
    "base_revision": "v1.2.0",
    "head_revision": "v1.3.0",
    "model_name": "qwen2.5-coder:7b",
    "provider": "ollama"
  }'
```

**Production topology:** put `web` behind your TLS terminator/SSO proxy (set
`DOCLINE_AUTH_MODE=sso` + `SSO_PROXY_SECRET`), keep `api` unpublished (compose
already binds it to loopback), set strong `AUTH_PROXY_SECRET` /
`GITHUB_WEBHOOK_SECRET` / `DOCLINE_SESSION_SECRET`, and provision real users
with `python -m app.db.provision_user`. House style is per-project:
`python -m app.db.provision_project` or a `PROJECT_CONTEXT.md` at the checkout
root (auto-registers on first run). Schema changes ship as reviewed SQL files
in `drizzle/` (applied on boot with `drizzle-kit migrate`; the dev-only
`push --force` is never run in containers). Air-gapped installs: run the TS
local engine, or the Python tier with a pinned Ollama model (`OLLAMA_URL` /
`OLLAMA_URL_ALLOWLIST` are server-side) — no external calls.

**Approval semantics differ per tier, by design:** the web tier splits
*approve* (decision) from *publish* (write); a session is APPROVED, then a
publisher ships it atomically. The Python tier's `/approve` *is* the write —
it re-verifies file hashes and applies the patch to the docs working tree in
the same call. Both require a human decision before anything is written.
