import {
  buildProposal,
  extractSignals,
  parseDiff,
  validateProposal,
  type DocSection,
  type Proposal,
  type Signal,
  type ToneProfileLite,
} from "./engine";

interface DocLike {
  id: string;
  path: string;
  title: string;
  content: string;
  version: number;
}

/**
 * Try a hosted model via OpenRouter. The model must return proposal JSON
 * whose edits are exact-target (before text must appear verbatim in the
 * cited document) and evidence-linked (refs must exist in the diff).
 * Any failure returns null and the caller falls back to the local engine.
 */
export async function tryOpenRouter(input: {
  model: string;
  productName: string;
  changeSummary: string;
  diffText: string;
  tone: ToneProfileLite;
  docs: DocLike[];
  sections: DocSection[];
  signals: Signal[];
}): Promise<Proposal | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  const files = parseDiff(input.diffText);
  const evidenceLines = files
    .flatMap((f) => f.added.map((a) => `${f.path}:L${a.n} ${a.text.trim()}`))
    .slice(0, 120)
    .join("\n");

  const sectionPayload = input.sections.slice(0, 6).map((s) => ({
    docPath: s.docPath,
    sectionHeading: s.heading,
    before: s.body,
  }));

  const system = [
    "You are Docline, a documentation maintenance engine.",
    `House voice for ${input.productName}: ${input.tone.voice}.`,
    `Person: ${input.tone.person}. Formality (1 casual-5 formal): ${input.tone.formality}.`,
    `Rules: ${input.tone.rules.join("; ")}.`,
    "Return ONLY JSON with shape:",
    '{"impactStatement": string, "uncertainties": string[], "testsToRun": string[], "edits": [{"docPath": string, "sectionHeading": string, "before": string, "after": string, "evidence": string[]}]}',
    "Hard constraints: before must be copied verbatim from the supplied section; after must begin with the exact before text; evidence entries must be refs like path:Lnum from the supplied evidence lines; do not invent identifiers that are not in the signals list.",
  ].join("\n");

  const user = JSON.stringify({
    changeSummary: input.changeSummary,
    signals: input.signals,
    sections: sectionPayload,
    evidenceLines,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: input.model || process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      impactStatement?: string;
      uncertainties?: string[];
      testsToRun?: string[];
      edits?: {
        docPath: string;
        sectionHeading: string;
        before: string;
        after: string;
        evidence?: string[];
      }[];
    };
    if (!Array.isArray(parsed.edits) || typeof parsed.impactStatement !== "string" || !parsed.impactStatement) return null;

    const proposal: Proposal = {
      impactStatement: parsed.impactStatement,
      uncertainties: parsed.uncertainties ?? [],
      testsToRun: parsed.testsToRun ?? [],
      signals: input.signals,
      llm: true,
      edits: parsed.edits.map((e) => {
        const doc = input.docs.find((d) => d.path === e.docPath)!;
        return {
          documentId: doc?.id ?? "",
          docPath: e.docPath,
          sectionHeading: e.sectionHeading,
          before: e.before,
          after: e.after,
          evidence: e.evidence ?? [],
          docVersion: doc?.version ?? 0,
        };
      }),
    };
    const invalid = validateProposal(proposal, input.docs, files, input.sections);
    if (invalid) return null;
    return proposal;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Local deterministic drafting — always available, evidence-linked. */
export function localProposal(input: {
  diffText: string;
  tone: ToneProfileLite;
  docs: DocLike[];
}): Proposal {
  const files = parseDiff(input.diffText);
  const signals = extractSignals(files);
  return buildProposal({ docs: input.docs, files, signals, tone: input.tone });
}
