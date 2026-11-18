import { NextResponse } from "next/server";
import { resolveRequestActor } from "@/lib/identity";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await resolveRequestActor(req))) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const ollamaUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  let ollama: { available: boolean; models: string[]; error?: string } = {
    available: false,
    models: [],
  };
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
    const result = await response.json() as { models?: { name?: string }[] };
    ollama = { available: true, models: (result.models ?? []).flatMap((model) => model.name ? [model.name] : []) };
  } catch (error) {
    ollama.error = error instanceof Error ? error.message : "Ollama is unreachable.";
  }
  return NextResponse.json({
    ollama,
    openrouter: {
      configured: Boolean(process.env.OPENROUTER_API_KEY),
      models: ["google/gemini-2.5-flash", "anthropic/claude-3.7-sonnet", "openai/gpt-4.1"],
    },
    deterministic: true,
  });
}
