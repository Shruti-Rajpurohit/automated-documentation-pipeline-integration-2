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

function proposalFromOutput(input: {
  model: string;
  changeSummary: string;
  diffText: string;
  docs: DocLike[];
  sections: DocSection[];
  signals: Signal[];
}, raw: string): Proposal | null {
  const files = parseDiff(input.diffText);
  const parsed = JSON.parse(raw) as {
    impactStatement?: string;
    uncertainties?: string[];
    testsToRun?: string[];
    edits?: {
      action?: "replace" | "append" | "create";
      docPath: string;
      sectionHeading: string;
      before?: string;
      after: string;
      evidence?: string[];
    }[];
  };
  if (!Array.isArray(parsed.edits) || typeof parsed.impactStatement !== "string" || !parsed.impactStatement) return null;
  const edits: Proposal["edits"] = [];
  for (const edit of parsed.edits) {
    const doc = input.docs.find((item) => item.path === edit.docPath);
    if (!doc) return null;
    const action = edit.action ?? "append";
    if (!["replace", "append", "create"].includes(action)) return null;
    edits.push({
      action,
      documentId: doc.id,
      docPath: edit.docPath,
      sectionHeading: edit.sectionHeading,
      before: action === "create" ? "" : edit.before ?? "",
      after: edit.after,
      evidence: edit.evidence ?? [],
      docVersion: doc.version,
    });
  }
  const proposal: Proposal = {
    impactStatement: parsed.impactStatement,
    uncertainties: parsed.uncertainties ?? [],
    testsToRun: parsed.testsToRun ?? [],
    signals: input.signals,
    llm: true,
    edits,
  };
  const invalid = validateProposal(proposal, input.docs, files, input.sections);
  return invalid ? null : proposal;
}

/**
 * Try a hosted model via OpenRouter. The model must return proposal JSON
 * whose edits target retrieved docs and cite evidence from the source diff.
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
    '{"impactStatement": string, "uncertainties": string[], "testsToRun": string[], "edits": [{"action": "replace"|"append"|"create", "docPath": string, "sectionHeading": string, "before": string, "after": string, "evidence": string[]}]}',
    "Hard constraints: target only supplied retrieved sections and document paths. For replace, before is the exact section and after is its complete replacement. For append, before is the exact section and after begins with the unchanged before text followed by new prose. For create, choose a supplied document, use a new sectionHeading, set before to an empty string, and begin after with the new markdown heading. Evidence entries must be refs like path:Lnum from supplied evidence lines; do not invent identifiers.",
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
    return proposalFromOutput(input, raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function tryOllama(input: {
    model: string;
    productName: string;
    changeSummary: string;
    diffText: string;
    tone: ToneProfileLite;
    docs: DocLike[];
    sections: DocSection[];
    signals: Signal[];
  }): Promise<Proposal | null> {
    const files = parseDiff(input.diffText);
    const evidenceLines = files
      .flatMap((file) => file.added.map((line) => `${file.path}:L${line.n} ${line.text.trim()}`))
      .slice(0, 120)
      .join("\n");
    const system = [
      "You are Docline, a documentation maintenance engine.",
      `House voice for ${input.productName}: ${input.tone.voice}.`,
      `Person: ${input.tone.person}. Formality (1 casual-5 formal): ${input.tone.formality}.`,
      `Rules: ${input.tone.rules.join("; ")}.`,
      'Return only JSON with impactStatement, uncertainties, testsToRun, and edits. Each edit has action ("replace", "append", or "create"), docPath, sectionHeading, before, after, and evidence.',
      "Use only the supplied sections and evidence. Replace must provide a complete replacement for the exact before section. Append must preserve before at the start of after. Create uses an empty before, a new section heading, and an after body beginning with that heading. Evidence must cite supplied diff lines.",
    ].join("\n");
    const user = JSON.stringify({
      changeSummary: input.changeSummary,
      signals: input.signals,
      sections: input.sections.slice(0, 6).map((section) => ({
        docPath: section.docPath,
        sectionHeading: section.heading,
        before: section.body,
      })),
      evidenceLines,
    });
    const baseUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: input.model,
          system,
          prompt: user,
          format: "json",
          stream: false,
          options: { temperature: 0.2 },
        }),
      });
      if (!response.ok) return null;
      const result = await response.json() as { response?: string };
      if (!result.response) return null;
      return proposalFromOutput(input, result.response);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
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
