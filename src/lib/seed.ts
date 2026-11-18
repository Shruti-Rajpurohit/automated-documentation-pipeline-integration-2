import { db } from "@/db";
import {
  auditEvents,
  documentEdits,
  documents,
  products,
  sessions,
  toneProfiles,
  users,
} from "@/db/schema";
import { decide, runPipeline, serverActorByRole, uid } from "./actions";
import { FIXTURES } from "./fixtures";
import { splitSections } from "./pipeline/engine";

/* ------------------------------------------------------------------ */
/* Demo workspace: Nimbus Systems — two products, house-styled docs.  */
/* ------------------------------------------------------------------ */

const RELAY_QUICKSTART = `# Quickstart

Relay is the event query API for Nimbus products. You write events, then you query them. That is the whole job.

## Authenticate

Every request carries your API key in the \`x-api-key\` header. Keys are per workspace and you can rotate them any time.

\`\`\`bash
curl -H "x-api-key: $KEY" https://relay.nimbus.dev/v1/streams
\`\`\`

## Write events

POST a batch of events to a stream. Keep batches under 5 MB and the service acknowledges them in order.

\`\`\`bash
curl -X POST https://relay.nimbus.dev/v1/streams \\
  -H "x-api-key: $KEY" \\
  -d '{"stream":"orders","events":[{"type":"created"}]}'
\`\`\`

## Query events

You query with \`POST /v1/query\`. Send a stream, a filter, and get back the events that match. Filters compose, so start narrow.

\`\`\`ts
const res = await relay.query({ stream: "orders", filter: { status: "late" } });
\`\`\`

Page the response with \`next_cursor\`. When it comes back null, you are done.`;

const RELAY_API_REF_BASE = `# API reference

Base URL: \`https://relay.nimbus.dev\`. All endpoints speak JSON. Errors carry a machine-readable \`code\`.

## Authentication

Send your key as \`x-api-key\`. Missing keys get a 401; the wrong workspace gets a 403. There is no session state to manage.

## Querying

\`POST /v1/query\` runs a query over a stream and returns matching events in ingestion order.

| Parameter | Type | Notes |
| --- | --- | --- |
| \`stream\` | string | Required. The stream to scan. |
| \`filter\` | object | Composed matchers. Omit to scan everything. |
| \`radius\` | integer | Optional scan radius around anchor events. Defaults to 64. |
| \`limit\` | integer | Max results per page. 500 ceiling. |

You page with the \`next_cursor\` field. When it is null, you are done.

## Errors

| Code | Meaning |
| --- | --- |
| \`STREAM_NOT_FOUND\` | The stream does not exist in this workspace. |
| \`FILTER_INVALID\` | A matcher failed to parse. Fix it and retry. |
| \`RATE_LIMITED\` | Back off. The retry-after header tells you for how long. |

## Rate limits

The default budget is 600 requests per minute per workspace. Writes and queries share the budget. If you need more, ask — the answer is usually yes.`;

// This block is what session "s-230-published" published into Rate limits.
const RELAY_230_BLOCK = `

### What's new in 2.3.0

- Write batches now retry with jittered backoff when the service answers \`RATE_LIMITED\`. You do not need to build your own retry loop.
- Partially-acknowledged batches keep their flush cadence, so retries no longer stall a quiet stream.

These changes are verified against the release diff (src/api/write.ts:L41, src/config.ts:L9).`;

const RELAY_API_REF = RELAY_API_REF_BASE.replace(
  "## Rate limits\n\nThe default budget is 600 requests per minute per workspace. Writes and queries share the budget. If you need more, ask — the answer is usually yes.",
  "## Rate limits\n\nThe default budget is 600 requests per minute per workspace. Writes and queries share the budget. If you need more, ask — the answer is usually yes." +
    RELAY_230_BLOCK
);

const RELAY_230_CHANGELOG_ENTRY = `## v2.3.0 — Nov 12

- Batched writes retry with jittered backoff instead of giving up.
- Flush interval honors partially-acknowledged batches.
- Fixes cursor drift on streams with heavy deletes.`;

const RELAY_CHANGELOG = `# Changelog

Notable changes to the Relay API. Versioned, dated, plain.

${RELAY_230_CHANGELOG_ENTRY}

## v2.2.0 — Oct 2

- You can page query results with \`next_cursor\`.
- Workspace budgets are visible in the dashboard.
- Streams can be paused without dropping their write buffer.`;

const RELAY_CONFIG = `# Configuration

Relay runs on environment variables. Set them before startup; the service does not reload them live.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| \`RELAY_PORT\` | 7714 | Port the API binds to. |
| \`RELAY_FLUSH_INTERVAL\` | 250 | Milliseconds between write flushes. |
| \`RELAY_BATCH_SIZE\` | 500 | Max events per write batch. |

## Networking

The service binds to \`0.0.0.0\` by default. Put it behind your load balancer and terminate TLS there if that is your house style.

## Observability

Ship logs as JSON and scrape \`/metrics\`. The metrics are boring by design — boring means predictable.`;

const FOUNDRY_OVERVIEW = `# Foundry overview

Foundry is the flag service. You define a flag once and evaluate it everywhere — edge workers, backend jobs, mobile clients.

## Core concepts

A flag has a key, a default, and optional targeting. An environment pins which flag states you see. An evaluation answers one question: for this subject, on this flag, what value do I serve.

## Rollouts

Rollouts change how many subjects see a variant. You start at one percent and ramp when the graphs stay boring. If they do not, you stop the ramp and the previous state is still there.

## Ownership

Every flag has an owner. Ownership decides who gets paged when a flag misbehaves, so pick a person, not a team alias.`;

const FOUNDRY_TARGETING = `# Targeting

Targeting decides who sees what. Rules evaluate top to bottom; the first match wins.

## Building audiences

An audience is a saved rule — plan is scale, country is DE, that kind of thing. Reuse audiences instead of retyping conditions.

## Evaluating flags

Clients call \`POST /v1/flags/{key}/evaluate\` with a subject key and attributes. The answer is deterministic: same subject, same result, until you change the flag.

| Field | Notes |
| --- | --- |
| \`subject\` | Stable id. A user id beats an email. |
| \`attributes\` | Free-form map used by targeting rules. |

## Kill switches

Every production flag should ship with a kill switch rule at the top. When in doubt, off is a valid answer.`;

const FOUNDRY_SDK = `# SDKs

Official SDKs: TypeScript, Go, and Python. They behave the same on purpose.

## Install

\`\`\`bash
npm add @nimbus/foundry-sdk
\`\`\`

## SDK configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| \`FOUNDRY_SDK_KEY\` | — | Required. Server-side key. |
| \`FOUNDRY_POLL_INTERVAL\` | 15000 | Milliseconds between flag syncs. |
| \`FOUNDRY_OFFLINE\` | false | Serve defaults without network. |

## Offline mode

With offline mode on, the SDK serves flag defaults and skips the network entirely. Good for tests, bad for truths.`;

const FOUNDRY_CHANGELOG = `# Changelog

All Foundry changes. Short, dated, honest.

## v1.9.1 — Nov 20

- Evaluation timeouts no longer cascade into full flag refreshes.
- The Python SDK pins a saner default timeout.

## v1.9.0 — Nov 6

- Saved audiences are shareable across environments.
- Adds \`subject_expires_at\` for short-lived evaluations.`;

/* ------------------------------------------------------------------ */

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const daysAgo = (d: number, h = 0) => new Date(Date.now() - d * 86_400_000 - h * 3_600_000);

async function auditRow(
  sessionId: string | null,
  actorId: string | null,
  action: string,
  detail: Record<string, unknown>,
  at: Date
) {
  await db.insert(auditEvents).values({ id: uid(), sessionId, actorId, action, detail, createdAt: at });
}

async function doSeed() {
  // The demo workspace (users, docs, historical sessions) is seeded only in
  // development or when explicitly requested — never into a production DB.
  if (process.env.NODE_ENV === "production" && process.env.DOCLINE_SEED_DEMO !== "1") return;
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) return;

  await db.insert(users).values([
    { id: "u-bot", name: "Pipeline Bot", email: "bot@docline.dev", role: "SYSTEM", hue: 160 },
    { id: "u-writer", name: "Priya Nair", email: "priya@nimbus.dev", role: "WRITER", hue: 265 },
    { id: "u-reviewer", name: "Marcus Bell", email: "marcus@nimbus.dev", role: "REVIEWER", hue: 210 },
    { id: "u-approver", name: "Dana Okafor", email: "dana@nimbus.dev", role: "APPROVER", hue: 145 },
  ]);

  await db.insert(toneProfiles).values([
    {
      id: "t-relay",
      productId: "p-relay",
      voice: "Direct, code-first, unhurried confidence",
      person: "second",
      formality: 2,
      rules: [
        "Sentence-case headings",
        "No exclamation marks, ever",
        "Lead with what the user can do",
        "Code over adjectives",
        "Every claim cites a source line",
      ],
      samples: [
        "You page with the `next_cursor` field. When it is null, you are done.",
        "If you need more, ask — the answer is usually yes.",
      ],
    },
    {
      id: "t-foundry",
      productId: "p-foundry",
      voice: "Plain-spoken, precise, gently opinionated",
      person: "second",
      formality: 2,
      rules: [
        "Sentence-case headings",
        "No exclamation marks, ever",
        "State the rule, then the exception",
        "Short sentences beat correct ones",
        "Every claim cites a source line",
      ],
      samples: [
        "When in doubt, off is a valid answer.",
        "Good for tests, bad for truths.",
      ],
    },
  ]);

  await db.insert(products).values([
    {
      id: "p-relay",
      name: "Relay",
      slug: "relay",
      tagline: "Event query API",
      repoUrl: "github.com/nimbus-systems/relay",
      docsRoot: "docs/relay",
      toneProfileId: "t-relay",
    },
    {
      id: "p-foundry",
      name: "Foundry",
      slug: "foundry",
      tagline: "Feature flag platform",
      repoUrl: "github.com/nimbus-systems/foundry",
      docsRoot: "docs/foundry",
      toneProfileId: "t-foundry",
    },
  ]);

  const relayApiStub = { id: "d-relay-api", path: "docs/relay/api-reference.md", title: "API reference", version: 2 };
  const relayChangelogStub = { id: "d-relay-changelog", path: "docs/relay/changelog.md", title: "Changelog", version: 2 };

  await db.insert(documents).values([
    { id: "d-relay-quickstart", productId: "p-relay", path: "docs/relay/quickstart.md", title: "Quickstart", content: RELAY_QUICKSTART, version: 1, updatedAt: daysAgo(21) },
    { ...relayApiStub, productId: "p-relay", content: RELAY_API_REF, updatedAt: daysAgo(6) },
    { id: "d-relay-config", productId: "p-relay", path: "docs/relay/configuration.md", title: "Configuration", content: RELAY_CONFIG, version: 1, updatedAt: daysAgo(13) },
    { ...relayChangelogStub, productId: "p-relay", content: RELAY_CHANGELOG, updatedAt: daysAgo(6) },
    { id: "d-foundry-overview", productId: "p-foundry", path: "docs/foundry/overview.md", title: "Overview", content: FOUNDRY_OVERVIEW, version: 1, updatedAt: daysAgo(30) },
    { id: "d-foundry-targeting", productId: "p-foundry", path: "docs/foundry/targeting.md", title: "Targeting", content: FOUNDRY_TARGETING, version: 1, updatedAt: daysAgo(9) },
    { id: "d-foundry-sdk", productId: "p-foundry", path: "docs/foundry/sdks.md", title: "SDKs", content: FOUNDRY_SDK, version: 1, updatedAt: daysAgo(16) },
    { id: "d-foundry-changelog", productId: "p-foundry", path: "docs/foundry/changelog.md", title: "Changelog", content: FOUNDRY_CHANGELOG, version: 1, updatedAt: daysAgo(9) },
  ]);

  /* --- S1: published historical session (Relay v2.3.0) ------------- */

  const s1at = daysAgo(6, 1);
  const apiBefore = splitSections({ ...relayApiStub, content: RELAY_API_REF_BASE }).find((s) => s.heading === "Rate limits")!;
  const apiAfter = splitSections({ ...relayApiStub, content: RELAY_API_REF }).find((s) => s.heading === "Rate limits")!;
  const strippedChangelog = RELAY_CHANGELOG.replace(`${RELAY_230_CHANGELOG_ENTRY}\n\n`, "");
  const chBefore = splitSections({ ...relayChangelogStub, content: strippedChangelog })[0];
  const chAfter = splitSections({ ...relayChangelogStub, content: RELAY_CHANGELOG })[0];

  await db.insert(sessions).values({
    id: "s-230-published",
    productId: "p-relay",
    title: "Relay v2.3.0 — batched writes & flush fixes",
    status: "PUBLISHED",
    triggerType: "RELEASE",
    baseRevision: "v2.2.0",
    headRevision: "v2.3.0",
    changeSummary: "Batched writes retry with jittered backoff; flush honors partial acks.",
    provider: "local",
    model: "docline-local-1",
    diffText: "",
    proposal: { llm: false, signalCount: 4, fileCount: 3 },
    impactStatement: "Release 2.3.0 changes write retry behavior and flush cadence. 2 documentation sections map to these changes.",
    uncertainties: [],
    testsToRun: ["Render every edited page and check anchors, code fences, and links."],
    createdById: "u-writer",
    reviewedById: "u-reviewer",
    publishedAt: new Date(s1at.getTime() + 31 * 60_000),
    createdAt: s1at,
    updatedAt: new Date(s1at.getTime() + 31 * 60_000),
  });
  await db.insert(documentEdits).values([
    {
      id: "e-s1-api",
      sessionId: "s-230-published",
      documentId: "d-relay-api",
      docPath: relayApiStub.path,
      sectionHeading: "Rate limits",
      beforeContent: apiBefore.body,
      afterContent: apiAfter.body,
      evidence: ["src/api/write.ts:L41", "src/config.ts:L9"],
      docVersion: 1,
      editedById: "u-writer",
      createdAt: s1at,
    },
    {
      id: "e-s1-changelog",
      sessionId: "s-230-published",
      documentId: "d-relay-changelog",
      docPath: relayChangelogStub.path,
      sectionHeading: "Changelog",
      beforeContent: chBefore.body,
      afterContent: chAfter.body,
      evidence: ["src/api/write.ts:L41"],
      docVersion: 1,
      createdAt: s1at,
    },
  ]);
  await auditRow("s-230-published", null, "RUN_STARTED", { trigger: "RELEASE", base: "v2.2.0", head: "v2.3.0", provider: "local", model: "docline-local-1" }, s1at);
  await auditRow("s-230-published", null, "PROPOSAL_READY", { llm: false, status: "AWAITING_REVIEW" }, new Date(s1at.getTime() + 5 * 60_000));
  await auditRow("s-230-published", "u-writer", "EDIT_APPLIED", { docPath: relayChangelogStub.path, section: "Changelog", deltaChars: 24 }, new Date(s1at.getTime() + 12 * 60_000));
  await auditRow("s-230-published", "u-reviewer", "APPROVED", {}, new Date(s1at.getTime() + 24 * 60_000));
  await auditRow("s-230-published", null, "DOC_PUBLISHED", { docPath: relayApiStub.path, fromVersion: 1, toVersion: 2 }, new Date(s1at.getTime() + 31 * 60_000));
  await auditRow("s-230-published", null, "DOC_PUBLISHED", { docPath: relayChangelogStub.path, fromVersion: 1, toVersion: 2 }, new Date(s1at.getTime() + 31 * 60_000 + 4000));
  await auditRow("s-230-published", "u-approver", "PUBLISHED", { edits: 2 }, new Date(s1at.getTime() + 31 * 60_000 + 9000));

  /* --- S3: rejected session (Foundry v1.9.1 tone violation) -------- */

  const s3at = daysAgo(2, 2);
  const targetingStub = { id: "d-foundry-targeting", path: "docs/foundry/targeting.md", title: "Targeting", version: 1 };
  const targetSection = splitSections({ ...targetingStub, content: FOUNDRY_TARGETING }).find((s) => s.heading === "Evaluating flags")!;
  const promo = `

### Evaluation, but faster

Supercharge your evaluations with the new timeout engine — it is blazing fast, incredibly resilient, and honestly a little magical. Numbers? Who needs them.`;
  await db.insert(sessions).values({
    id: "s-191-rejected",
    productId: "p-foundry",
    title: "Foundry v1.9.1 — evaluation timeout handling",
    status: "REJECTED",
    triggerType: "MANUAL",
    baseRevision: "v1.9.0",
    headRevision: "v1.9.1",
    changeSummary: "Timeout isolation changes for flag evaluation.",
    provider: "local",
    model: "docline-local-1",
    diffText: "",
    proposal: { llm: false, signalCount: 2, fileCount: 2 },
    impactStatement: "Release 1.9.1 changes evaluation timeout behavior. 1 documentation section maps to these changes.",
    uncertainties: ["The diff does not state the new default timeout. Confirm the number before publishing."],
    testsToRun: ["Render every edited page and check anchors, code fences, and links."],
    rejectionReason:
      "Tone check failed — 'supercharge', 'blazing' and 'magical' are not our voice, and no timeout numbers appear in the v1.9.1 diff. Rewrite with evidence or drop the section.",
    createdById: "u-writer",
    reviewedById: "u-reviewer",
    createdAt: s3at,
    updatedAt: new Date(s3at.getTime() + 95 * 60_000),
  });
  await db.insert(documentEdits).values([
    {
      id: "e-s3-targeting",
      sessionId: "s-191-rejected",
      documentId: "d-foundry-targeting",
      docPath: targetingStub.path,
      sectionHeading: "Evaluating flags",
      beforeContent: targetSection.body,
      afterContent: targetSection.body + promo,
      evidence: ["src/server/evaluate.ts:L58"],
      docVersion: 1,
      createdAt: s3at,
    },
  ]);
  await auditRow("s-191-rejected", null, "RUN_STARTED", { trigger: "MANUAL", base: "v1.9.0", head: "v1.9.1", provider: "local", model: "docline-local-1" }, s3at);
  await auditRow("s-191-rejected", null, "PROPOSAL_READY", { llm: false, status: "AWAITING_REVIEW" }, new Date(s3at.getTime() + 4 * 60_000));
  await auditRow("s-191-rejected", "u-reviewer", "REJECTED", { reason: "Tone violations; unverifiable claims." }, new Date(s3at.getTime() + 95 * 60_000));

  /* --- S2 & S4: live engine runs ----------------------------------- */

  const relayFx = FIXTURES.find((f) => f.id === "fx-relay-240")!;
  await runPipeline(
    {
      productId: relayFx.productId,
      baseRevision: relayFx.baseRevision,
      headRevision: relayFx.headRevision,
      changeSummary: relayFx.changeSummary,
      provider: "local",
      model: "docline-local-1",
      diffText: relayFx.diff,
      triggerType: "RELEASE",
      actor: await serverActorByRole("WRITER"),
      title: relayFx.label,
    },
    { at: hoursAgo(3) }
  );

  const foundryFx = FIXTURES.find((f) => f.id === "fx-foundry-1100")!;
  const s4 = await runPipeline(
    {
      productId: foundryFx.productId,
      baseRevision: foundryFx.baseRevision,
      headRevision: foundryFx.headRevision,
      changeSummary: foundryFx.changeSummary,
      provider: "local",
      model: "docline-local-1",
      diffText: foundryFx.diff,
      triggerType: "WEBHOOK",
      actor: await serverActorByRole("WRITER"),
      title: foundryFx.label,
    },
    { at: hoursAgo(0.8) }
  );
  await decide({
    sessionId: s4.sessionId,
    action: "approve",
    actor: await serverActorByRole("REVIEWER"),
    at: hoursAgo(0.55),
  });
}

const globalSeed = globalThis as typeof globalThis & {
  __doclineSeed?: Promise<void>;
};

/** Idempotent, race-safe seeding. Called from server components. */
export function ensureSeed(): Promise<void> {
  globalSeed.__doclineSeed ??= doSeed().catch((err) => {
    console.error("Docline seed failed:", err);
    globalSeed.__doclineSeed = undefined;
  }) as Promise<void>;
  return globalSeed.__doclineSeed;
}
