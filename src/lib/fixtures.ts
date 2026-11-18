// Sample release events for the demo workspace (Nimbus Systems).
// These are real unified diffs the pipeline parser can ingest end-to-end.

export interface ReleaseFixture {
  id: string;
  productId: string;
  label: string;
  description: string;
  baseRevision: string;
  headRevision: string;
  changeSummary: string;
  diff: string;
}

export const FIXTURES: ReleaseFixture[] = [
  {
    id: "fx-relay-240",
    productId: "p-relay",
    label: "Relay v2.4.0 — top-k queries",
    description: "New /v1/query/topk endpoints, SDK export, candidate tuning env vars, radius deprecation.",
    baseRevision: "v2.3.0",
    headRevision: "v2.4.0",
    changeSummary:
      "Ships top-k candidate queries with a dedicated endpoint pair and SDK export. Adds RELAY_MAX_CANDIDATES and RELAY_CANDIDATE_TTL_MS. Deprecates the radius parameter.",
    diff: `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,6 +1,6 @@
 {
   "name": "@nimbus/relay",
-  "version": "2.3.0",
+  "version": "2.4.0",
   "private": true,
   "main": "dist/index.js"
 }
diff --git a/src/api/routes.ts b/src/api/routes.ts
--- a/src/api/routes.ts
+++ b/src/api/routes.ts
@@ -39,6 +39,8 @@ export function registerRoutes(router: Router) {
   router.post("/v1/streams", handlers.createStream);
   router.post("/v1/query", handlers.query);
   router.get("/v1/streams", handlers.listStreams);
+  router.post("/v1/query/topk", handlers.queryTopK);
+  router.get("/v1/query/topk/:id/status", handlers.topkStatus);
   return router;
 }
diff --git a/packages/sdk/src/index.ts b/packages/sdk/src/index.ts
--- a/packages/sdk/src/index.ts
+++ b/packages/sdk/src/index.ts
@@ -10,6 +10,14 @@ export { RelayClient } from "./client";
 
 import { encodeFilter } from "./filter";
 
+export async function queryTopK(
+  client: RelayClient,
+  opts: { stream: string; k: number; filter?: Filter }
+) {
+  const res = await client.request("POST /v1/query/topk", opts);
+  return res.candidates;
+}
+
 export { encodeFilter };
diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -4,6 +4,8 @@ export const config = {
   port: envInt("RELAY_PORT", 7714),
   flushIntervalMs: envInt("RELAY_FLUSH_INTERVAL", 250),
   batchSize: envInt("RELAY_BATCH_SIZE", 500),
+  maxCandidates: envInt("RELAY_MAX_CANDIDATES", 1000),
+  candidateTtlMs: envInt("RELAY_CANDIDATE_TTL_MS", 300000),
 };
diff --git a/src/api/query.ts b/src/api/query.ts
--- a/src/api/query.ts
+++ b/src/api/query.ts
@@ -78,10 +78,8 @@ function buildQuery(params: QueryParams) {
   if (!params.stream) throw new Error("stream is required");
-  const radius = params.radius ?? DEFAULT_RADIUS;
-  return { stream: params.stream, radius, filter: params.filter };
+  // The \`radius\` parameter is deprecated; use topk with k instead.
+  return { stream: params.stream, filter: params.filter };
 }
`,
  },
  {
    id: "fx-foundry-1100",
    productId: "p-foundry",
    label: "Foundry v1.10.0 — gradual rollouts",
    description: "Rollout endpoints for flags, SDK rollout helpers, rollout salt configuration.",
    baseRevision: "v1.9.1",
    headRevision: "v1.10.0",
    changeSummary:
      "Introduces gradual rollouts: percentage ramps per flag via new endpoints and SDK helpers. Requires FOUNDRY_ROLLOUT_SALT for deterministic bucketing.",
    diff: `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,5 +1,5 @@
 {
   "name": "@nimbus/foundry",
-  "version": "1.9.1",
+  "version": "1.10.0",
   "private": true
 }
diff --git a/src/server/routes.ts b/src/server/routes.ts
--- a/src/server/routes.ts
+++ b/src/server/routes.ts
@@ -28,5 +28,7 @@ export function mount(app: Express) {
   app.post("/v1/flags", createFlag);
   app.post("/v1/flags/{key}/evaluate", evalFlag);
   app.get("/v1/flags", listFlags);
+  app.post("/v1/flags/{key}/rollouts", createRolloutHandler);
+  app.patch("/v1/flags/{key}/rollouts/{id}", advanceRollout);
 }
diff --git a/sdk/src/rollouts.ts b/sdk/src/rollouts.ts
new file mode 100644
--- /dev/null
+++ b/sdk/src/rollouts.ts
@@ -0,0 +1,12 @@
+import { hash } from "./hash";
+
+export function createRollout(flagKey: string, steps: number[]) {
+  return { flagKey, steps, createdAt: Date.now() };
+}
+
+export function hashBucket(subjectId: string, salt: string) {
+  return hash(salt + ":" + subjectId) % 100;
+}
diff --git a/src/server/config.ts b/src/server/config.ts
--- a/src/server/config.ts
+++ b/src/server/config.ts
@@ -7,5 +7,6 @@ export const serverConfig = {
   sdkKey: requireEnv("FOUNDRY_SDK_KEY"),
   pollIntervalMs: intFromEnv("FOUNDRY_POLL_INTERVAL", 15000),
+  rolloutSalt: requireEnv("FOUNDRY_ROLLOUT_SALT"),
 };
`,
  },
];
