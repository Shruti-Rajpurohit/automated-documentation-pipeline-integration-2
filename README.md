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
- (Optional) an `OPENROUTER_API_KEY` if you want hosted-model drafting.

## Run it locally

From the unzipped folder in VS Code's terminal:

```bash
# 1. configure the local database settings in .env
cp .env.example .env
# Set POSTGRES_PASSWORD=postgres and make DATABASE_URL use the same password.

# 2. install dependencies
npm install

# 3. start only Postgres (first run downloads the image)
docker compose up -d db

# 4. apply the committed migrations (push is for schema iteration only;
#    a database created by migrate stays reproducible)
npx drizzle-kit migrate

# 5. start the app
npm run dev
```

Open **http://localhost:3000**. On first load the app seeds a demo workspace
(Nimbus Systems: 2 products, 8 styled docs, 4 review sessions in different
states). No extra seed step needed.

> If the zip didn't include `.env`, create it with a `DATABASE_URL` pointing to
> your PostgreSQL instance; for bundled Compose, also set matching
> `POSTGRES_PASSWORD` and `DATABASE_URL` values.

Production mode:

```bash
npm run build && npm start
```

## Drive the pipeline (demo walkthrough)

1. Sidebar → **New run** → product **Relay** → release event
   **"Relay v2.4.0 — top-k queries"** (it carries a real unified diff) →
   **Run pipeline**.
2. You land on the **review console**: per-section diffs with evidence links
   (`src/api/routes.ts:L42`), uncertainties, and suggested checks.
3. Drafts are editable in place (**Edit draft**). Edits are audited with actor,
   before/after, and timestamp.
4. In the sidebar, act as **Reviewer** (Marcus) → **Approve** → **Create pull
   request**. Publishing verifies the remote docs snapshot before creating a
   branch and pull request. The normal repository review/merge process remains
   the final gate.
5. In local development, set `PUBLISH_DESTINATION=database` to use the demo
   document store instead. Production Compose defaults to `github_pr`.
6. Check the session's pull request link and **Activity** (audit trail).
7. Try the reject path on a fresh run: rejection needs a reason and is stored
   with the session for the evaluation corpus.

Roles: **Writer** (create/edit) · **Reviewer** (edit/approve/reject/publish) ·
**Approver** (approve/publish). The sidebar switcher simulates the SSO/identity
layer; server routes enforce the gates.

## Drafting engines

- **Local engine** (default): deterministic signal extraction + tone-aligned
  drafting. No network, no data leaves the workspace.
- **OpenRouter LLM**: set `OPENROUTER_API_KEY=...` in `.env` (server-side only,
  never sent to the browser). The model must return evidence-linked JSON; any
  invalid proposal falls back to the local engine.

## Programmatic trigger

Wire this into a GitHub release action or cron job. CI authenticates with a
machine token (`PIPELINE_API_TOKEN` on the server) since pipeline diffs are
not public:

```bash
curl -X POST http://localhost:3000/api/runs \
  -H "content-type: application/json" \
  -H "authorization: Bearer $PIPELINE_API_TOKEN" \
  -d '{
    "productId": "p-relay",
    "baseRevision": "v2.4.0",
    "headRevision": "v2.4.1",
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

Optional environment: `GITHUB_TOKEN` for private repositories,
`GITHUB_API_BASE` for GitHub Enterprise, `DEFAULT_PROVIDER` / `DEFAULT_MODEL`
to choose the drafting engine for webhook runs. Tag pushes, branch
deletions, branch creations, and pushes to unmapped repositories are
acknowledged with `{ "status": "ignored" }` rather than creating noise
sessions.

## GitHub pull-request publishing

Set `GITHUB_TOKEN` to a GitHub App or fine-grained token with read access to
the docs repository and permission to create branches and pull requests.
`GITHUB_API_BASE` may point to a GitHub Enterprise API. The product's
`docs_repo_url` selects the documentation repository; when empty, `repo_url`
is used. `docs_root` must contain every proposed document path. Configure
these product fields in PostgreSQL before production use. Remote file content
is compared with the reviewed snapshot, so stale docs block publishing rather
than being overwritten. A successful publish changes the session to
`PR_OPEN` and records the pull request URL; it does not merge or deploy docs.
When GitHub sends the merged pull-request event to this endpoint, the session
is updated to `PUBLISHED` and the internal documentation snapshot is updated
when its version still matches the reviewed base. If the snapshot has changed,
the merge remains published and an audit event records that synchronization
was skipped.

For example, configure a product with:

```sql
UPDATE products
SET docs_repo_url = 'https://github.com/acme/docs',
    docs_root = 'docs/relay'
WHERE id = 'p-relay';
```

## Project map

```
src/db/schema.ts            tables: users, products, tone_profiles, documents,
                            sessions, document_edits, audit_events, jobs
src/lib/pipeline/engine.ts  diff parsing, signal extraction, retrieval,
                            tone drafting, proposal validation (pure TS)
src/lib/pipeline/llm.ts     OpenRouter bridge with validator + local fallback
src/lib/actions.ts          runPipeline / editDraft / decide orchestration
src/lib/fixtures.ts         sample release events (real unified diffs)
src/lib/seed.ts             demo workspace seeding (auto, idempotent)
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

- `ECONNREFUSED 127.0.0.1:5433` → Postgres isn't running: `docker compose up -d`.
- `relation "sessions" does not exist` → tables not created: `npx drizzle-kit push`.
- Reset the demo completely:
  `docker compose down -v && docker compose up -d && npx drizzle-kit push`,
  then reload the app (it reseeds on first load).
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
                 │  FastAPI  (backend/, :8000)  │── SQLite (volume)
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
| SQLite models              | `src/db/schema.ts` (PostgreSQL)          |
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

- **web** on `:3000` — Next.js; creates/upgrades Postgres tables on boot.
- **api** on `127.0.0.1:8000` — FastAPI; loopback-only publish by design
  (clients never reach it directly; the trusted proxy does). Provisions the
  three review identities on boot. Mount product + docs git checkouts into
  `./repos` (both must live under `REPOSITORY_ROOTS=/srv/repos`).
- **db** on `:5432` — PostgreSQL for the web tier and both durable job queues.
- Configure each product's `docs_repo_url` and `docs_root` before production
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
