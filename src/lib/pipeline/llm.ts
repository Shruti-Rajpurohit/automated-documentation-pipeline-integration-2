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
  docKind?: string;
}

export interface LLMProviderResult {
  proposal: Proposal | null;
  reason: string | null;
}

interface LLMInput {
  model: string;
  productName: string;
  changeSummary: string;
  diffText: string;
  tone: ToneProfileLite;
  docs: DocLike[];
  sections: DocSection[];
  signals: Signal[];
}

interface ParsedEdit {
  action?: "replace" | "append" | "create";
  docPath: string;
  sectionHeading: string;
  content: string;
  evidence?: string[];
}

interface ParsedResponse {
  impactStatement?: string;
  uncertainties?: string[];
  testsToRun?: string[];
  edits?: ParsedEdit[];
}

const MAX_DIFF_CHARS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

function rejected(provider: "openrouter" | "ollama", reason: string): LLMProviderResult {
  console.warn("[docline] LLM proposal failed/rejected:", `${provider}: ${reason}`);
  return { proposal: null, reason };
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function headingLine(section: DocSection): string {
  return `${"#".repeat(Math.max(1, Math.min(section.level, 4)))} ${section.heading}`;
}

function startsWithHeading(content: string, heading: string): boolean {
  return new RegExp(`^#{1,4}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:\\r?\\n|$)`)
    .test(content);
}

function startsWithMarkdownHeading(content: string): boolean {
  return /^#{1,4}\s+\S.*(?:\r?\n|$)/.test(content);
}

function proposalFromOutput(
  input: LLMInput,
  provider: "openrouter" | "ollama",
  raw: string
): LLMProviderResult {
  let parsed: ParsedResponse;
  try {
    const parsedValue: unknown = JSON.parse(stripJsonFence(raw));
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return rejected(provider, "invalid_proposal_shape: expected a JSON object");
    }
    parsed = parsedValue as ParsedResponse;
  } catch (error) {
    return rejected(
      provider,
      `invalid_json: ${error instanceof Error ? error.message : "parse failed"}`
    );
  }
  if (!Array.isArray(parsed.edits) || typeof parsed.impactStatement !== "string" || !parsed.impactStatement) {
    return rejected(provider, "invalid_proposal_shape: impactStatement and edits are required");
  }
  if (
    (parsed.uncertainties !== undefined &&
      (!Array.isArray(parsed.uncertainties) || parsed.uncertainties.some((item) => typeof item !== "string"))) ||
    (parsed.testsToRun !== undefined &&
      (!Array.isArray(parsed.testsToRun) || parsed.testsToRun.some((item) => typeof item !== "string")))
  ) {
    return rejected(provider, "invalid_proposal_shape: uncertainties and testsToRun must be string arrays");
  }

  const edits: Proposal["edits"] = [];
  for (const edit of parsed.edits) {
    if (
      !edit ||
      typeof edit.docPath !== "string" ||
      typeof edit.sectionHeading !== "string" ||
      typeof edit.content !== "string" ||
      !edit.content.trim() ||
      (edit.evidence !== undefined &&
        (!Array.isArray(edit.evidence) || edit.evidence.some((ref) => typeof ref !== "string")))
    ) {
      return rejected(provider, "invalid_proposal_shape: malformed edit");
    }
    const doc = input.docs.find((item) => item.path === edit.docPath);
    if (!doc) return rejected(provider, `unknown_document: ${edit.docPath}`);
    const action = edit.action ?? "append";
    if (action !== "replace" && action !== "append" && action !== "create") {
      return rejected(provider, `invalid_action: ${String(action)}`);
    }
    const section = action === "create"
      ? undefined
      : input.sections.find((candidate) =>
        candidate.docPath === edit.docPath && candidate.heading === edit.sectionHeading
      );
    if (action !== "create" && !section) {
      return rejected(provider, `unmatched_section: ${edit.docPath} / ${edit.sectionHeading}`);
    }
    const content = edit.content.trim();
    const titleLine = section ? headingLine(section) : `## ${edit.sectionHeading}`;
    const before = action === "create" ? "" : section!.body;
    const after = action === "replace"
      ? (startsWithHeading(content, edit.sectionHeading) ? content : `${titleLine}\n\n${content}`)
      : action === "append"
        ? `${before}\n\n${content}`
        : (startsWithMarkdownHeading(content) ? content : `## ${edit.sectionHeading}\n\n${content}`);
    edits.push({
      action,
      documentId: doc.id,
      docPath: edit.docPath,
      sectionHeading: edit.sectionHeading,
      before,
      after,
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
  let files;
  try {
    files = parseDiff(input.diffText);
  } catch (error) {
    return rejected(provider, `diff_parse_failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const invalid = validateProposal(proposal, input.docs, files, input.sections);
  return invalid
    ? rejected(provider, `proposal_validation_failed: ${invalid}`)
    : { proposal, reason: null };
}

function changedFiles(files: ReturnType<typeof parseDiff>) {
  return files.map((file) => file.path);
}

function systemPrompt(input: LLMInput): string {
  return [
    "You are Docline, a documentation maintenance engine.",
    `House voice for ${input.productName}: ${input.tone.voice}.`,
    `Person: ${input.tone.person}. Formality (1 casual-5 formal): ${input.tone.formality}.`,
    `Rules: ${input.tone.rules.join("; ")}.`,
    'Return only JSON in this exact shape: {"impactStatement": string, "uncertainties": string[], "testsToRun": string[], "edits": [{"action": "replace"|"append"|"create", "docPath": string, "sectionHeading": string, "content": string, "evidence": string[]}]}',
    "Review EVERY document kind present in the supplied sections (`api` reference, `developer` setup guide, `user` guide, and `other`/README). Produce separate edits for EACH affected guide and EACH affected section—do not stop after updating only README.md. If a new feature (such as a new endpoint, flow, or setting) has no existing section in an affected guide, use action `create` in that guide.",
    "Use only the supplied document sections. For replace/append, target one supplied section. For create, target a supplied document with a new section heading.",
    "Do not return a before field or repeat unchanged section text. Return only the new/replacement prose in content.",
    "Evidence entries must copy either an exact path:Lnum reference from the diff or a path from changedFiles.",
  ].join("\n");
}

function userPrompt(input: LLMInput, diffText: string, files: ReturnType<typeof parseDiff>, correctionRequired?: string) {
  return JSON.stringify({
    changeSummary: input.changeSummary,
    signals: input.signals,
    sections: input.sections.map((section) => ({
      docPath: section.docPath,
      docKind: section.docKind,
      sectionHeading: section.heading,
      content: section.body,
    })),
    changedFiles: changedFiles(files),
    diffText,
    ...(correctionRequired ? { correctionRequired } : {}),
  });
}

async function requestWithRetry(
  input: LLMInput,
  provider: "openrouter" | "ollama"
): Promise<LLMProviderResult> {
  let correctionRequired: string | undefined;
  const boundedInput = {
    ...input,
    diffText: input.diffText.slice(0, MAX_DIFF_CHARS),
  };
  const files = parseDiff(boundedInput.diffText);
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const body = userPrompt(boundedInput, boundedInput.diffText, files, correctionRequired);
      let raw: string | undefined;
      if (provider === "openrouter") {
        const key = process.env.OPENROUTER_API_KEY;
        if (!key) return rejected(provider, "OPENROUTER_API_KEY_not_configured");
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "HTTP-Referer": "http://localhost",
            "X-Title": "Docline",
          },
          body: JSON.stringify({
            model: boundedInput.model || process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
            temperature: 0.2,
            messages: [
              { role: "system", content: systemPrompt(boundedInput) },
              { role: "user", content: body },
            ],
            response_format: { type: "json_object" },
          }),
        });
        if (!response.ok) return rejected(provider, `http_${response.status}`);
        let json: { choices?: { message?: { content?: string } }[] };
        try {
          json = await response.json() as typeof json;
        } catch (error) {
          correctionRequired = `invalid_provider_response_json: ${error instanceof Error ? error.message : "parse failed"}`;
          continue;
        }
        raw = json.choices?.[0]?.message?.content;
      } else {
        const baseUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
        const response = await fetch(`${baseUrl}/api/generate`, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: boundedInput.model,
            system: systemPrompt(boundedInput),
            prompt: body,
            format: "json",
            stream: false,
            options: { temperature: 0.2 },
          }),
        });
        if (!response.ok) return rejected(provider, `http_${response.status}`);
        let json: { response?: string };
        try {
          json = await response.json() as typeof json;
        } catch (error) {
          correctionRequired = `invalid_provider_response_json: ${error instanceof Error ? error.message : "parse failed"}`;
          continue;
        }
        raw = json.response;
      }

      if (!raw) {
        correctionRequired = "The model returned no response content. Return the required JSON object.";
      } else {
        const result = proposalFromOutput(boundedInput, provider, raw);
        if (result.proposal) return result;
        correctionRequired = result.reason ?? "The proposal was invalid. Return corrected JSON.";
      }
    } catch (error) {
      const reason = `request_failed: ${error instanceof Error ? error.message : "unknown error"}`;
      if (attempt === 1) return rejected(provider, reason);
      correctionRequired = reason;
    } finally {
      clearTimeout(timeout);
    }
  }
  return rejected(provider, correctionRequired ?? "retry_exhausted");
}

export async function tryOpenRouter(input: LLMInput): Promise<LLMProviderResult> {
  return requestWithRetry(input, "openrouter");
}

export async function tryOllama(input: LLMInput): Promise<LLMProviderResult> {
  return requestWithRetry(input, "ollama");
}

/** Local deterministic drafting — always available, evidence-linked. */
export function localProposal(input: {
  diffText: string;
  tone: ToneProfileLite;
  docs: DocLike[];
}): Proposal {
  const files = parseDiff(input.diffText);
  const signals = extractSignals(files);
  return buildProposal({ docs: input.docs, files, signals, tone: input.tone, diffText: input.diffText });
}
