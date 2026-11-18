export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { startPipelineJobWorker } = await import("./src/lib/jobs/worker");
    startPipelineJobWorker();
  }
}
