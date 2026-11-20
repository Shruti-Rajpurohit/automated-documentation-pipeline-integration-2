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

type DocKind = "api" | "developer" | "user" | "blog" | "other";

interface ImpactReport {
  decision: "update_required" | "no_update" | "human_investigation";
  technical_summary: string;
  user_impact: string;
  documentation_gaps: string[];
  affected_kinds: DocKind[];
}

const DOC_KINDS: DocKind[] = ["api", "developer", "user", "blog", "other"];
const MAX_ANALYSIS_DIFF_CHARS = 30_000;
const MAX_STAGE2_SECTION_CHARS = 28_000;
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
    if (
      action === "replace" &&
      section!.body.length > 300 &&
      content.length < section!.body.length * 0.45
    ) {
      return rejected(
        provider,
        "replace_too_destructive: replace must preserve unchanged steps, screenshots, and sub-headings — use append or return the full updated section"
      );
    }
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

type Provider = "openrouter" | "ollama";

type ProviderResponse = { raw?: string; reason?: string };

async function requestModel(
  provider: Provider,
  model: string,
  system: string,
  prompt: string
): Promise<ProviderResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    if (provider === "openrouter") {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return { reason: "OPENROUTER_API_KEY_not_configured" };
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
          model: model || process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
          temperature: 0.2,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (response.status === 429) {
        return {
          reason: "openrouter_rate_limited (429): selected free/cloud model is temporarily busy — retry or pick another model",
        };
      }
      if (!response.ok) return { reason: `http_${response.status}` };
      let json: { choices?: { message?: { content?: string } }[] };
      try {
        json = await response.json() as typeof json;
      } catch (error) {
        return { reason: `invalid_provider_response_json: ${error instanceof Error ? error.message : "parse failed"}` };
      }
      return json.choices?.[0]?.message?.content
        ? { raw: json.choices[0].message.content }
        : { reason: "empty_model_response" };
    }

    const baseUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        system,
        prompt,
        format: "json",
        stream: false,
        options: {
          temperature: 0.2,
          num_ctx: Number(process.env.OLLAMA_NUM_CTX || 16384),
        },
      }),
    });
    if (!response.ok) return { reason: `http_${response.status}` };
    let json: { response?: string };
    try {
      json = await response.json() as typeof json;
    } catch (error) {
      return { reason: `invalid_provider_response_json: ${error instanceof Error ? error.message : "parse failed"}` };
    }
    return json.response ? { raw: json.response } : { reason: "empty_model_response" };
  } catch (error) {
    return { reason: `request_failed: ${error instanceof Error ? error.message : "unknown error"}` };
  } finally {
    clearTimeout(timeout);
  }
}

function parseImpactReport(raw: string): { report?: ImpactReport; reason?: string } {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonFence(raw));
  } catch (error) {
    return { reason: `invalid_json: ${error instanceof Error ? error.message : "parse failed"}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "invalid_impact_report: expected a JSON object" };
  }
  const report = value as Partial<ImpactReport>;
  if (
    (report.decision !== "update_required" &&
      report.decision !== "no_update" &&
      report.decision !== "human_investigation") ||
    typeof report.technical_summary !== "string" ||
    typeof report.user_impact !== "string" ||
    !Array.isArray(report.documentation_gaps) ||
    report.documentation_gaps.some((gap) => typeof gap !== "string") ||
    !Array.isArray(report.affected_kinds) ||
    report.affected_kinds.some((kind) => !DOC_KINDS.includes(kind as DocKind))
  ) {
    return { reason: "invalid_impact_report: required fields or values are invalid" };
  }
  return {
    report: {
      decision: report.decision,
      technical_summary: report.technical_summary,
      user_impact: report.user_impact,
      documentation_gaps: report.documentation_gaps,
      affected_kinds: [...new Set(report.affected_kinds as DocKind[])],
    },
  };
}

function impactSystemPrompt(): string {
  return [
    "You are Docline's Impact Analyst. Analyze a release diff and its documentation section index.",
    'Return only JSON with keys: {"decision":"update_required"|"no_update"|"human_investigation","technical_summary":string,"user_impact":string,"documentation_gaps":string[],"affected_kinds":("api"|"developer"|"user"|"blog"|"other")[]}.',
    "List specific documentation gaps by guide in documentation_gaps. Include every document kind that needs an update in affected_kinds. Do not invent implementation details.",
    "Preserve exact literal strings from diffText in technical_summary and documentation_gaps, especially model IDs, API route paths, HTTP methods, request/response field names, environment variables, and numeric limits (for example, exactly 3 images).",
  ].join("\n");
}

function compactSectionIndex(sections: DocSection[]) {
  return sections.slice(0, 160).map((section) => ({
    docPath: section.docPath,
    docKind: section.docKind,
    sectionHeading: section.heading,
    snippet: section.body.replace(/\s+/g, " ").slice(0, 180),
  }));
}

async function analyzeImpactReport(input: LLMInput, provider: Provider): Promise<ImpactReport | LLMProviderResult> {
  const prompt = JSON.stringify({
    changeSummary: input.changeSummary,
    diffText: input.diffText.slice(0, MAX_ANALYSIS_DIFF_CHARS),
    sectionIndex: compactSectionIndex(input.sections),
  });
  let correctionRequired: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await requestModel(
      provider,
      input.model,
      impactSystemPrompt(),
      correctionRequired ? JSON.stringify({ prompt: JSON.parse(prompt), correctionRequired }) : prompt
    );
    if (!response.raw) return rejected(provider, response.reason ?? "empty_model_response");
    const parsed = parseImpactReport(response.raw);
    if (parsed.report) return parsed.report;
    correctionRequired = parsed.reason ?? "invalid_impact_report";
  }
  return rejected(provider, `impact_report_rejected: ${correctionRequired ?? "retry_exhausted"}`);
}

function stage2Sections(input: LLMInput, report: ImpactReport): {
  section: DocSection;
  content: string;
}[] {
  const priority = new Map(report.affected_kinds.map((kind, index) => [kind, index]));
  const ordered = input.sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) =>
      (priority.get(a.section.docKind as DocKind) ?? DOC_KINDS.length) -
        (priority.get(b.section.docKind as DocKind) ?? DOC_KINDS.length) ||
      a.index - b.index
    );
  const selected: { section: DocSection; content: string }[] = [];
  const selectedIds = new Set<string>();
  let used = 0;
  const sectionSize = (section: DocSection) => JSON.stringify({
    docPath: section.docPath,
    docKind: section.docKind,
    sectionHeading: section.heading,
    content: section.body,
  }).length;
  const addSection = (section: DocSection, maxSize = MAX_STAGE2_SECTION_CHARS - used) => {
    const key = `${section.docPath}\0${section.heading}`;
    if (selectedIds.has(key)) return false;
    const content = section.body;
    const size = sectionSize(section);
    if (size > maxSize || used + size > MAX_STAGE2_SECTION_CHARS) return false;
    selected.push({ section, content });
    selectedIds.add(key);
    used += size;
    return true;
  };
  const affectedKinds = report.affected_kinds.filter((kind) =>
    ordered.some(({ section }) => section.docKind === kind)
  );
  const perKindBudget = Math.floor(MAX_STAGE2_SECTION_CHARS / Math.max(affectedKinds.length, 1));
  for (const kind of affectedKinds) {
    const ofKind = ordered.filter(({ section }) => section.docKind === kind);
    const top = ofKind.find(({ section }) => sectionSize(section) <= perKindBudget);
    if (top) {
      addSection(top.section, perKindBudget);
    } else {
      const fallback = ofKind.find(({ section }) =>
        sectionSize(section) <= MAX_STAGE2_SECTION_CHARS - used
      );
      if (fallback) addSection(fallback.section);
    }
  }
  for (const { section } of ordered) {
    addSection(section);
  }
  return selected;
}

function writerSystemPrompt(input: LLMInput, report: ImpactReport): string {
  const kinds = report.affected_kinds.join(", ") || "none";
  return [
    "You are Docline's Documentation Writer. Produce minimal, accurate reviewable documentation patches.",
    `House voice for ${input.productName}: ${input.tone.voice}.`,
    `Person: ${input.tone.person}. Formality (1 casual-5 formal): ${input.tone.formality}.`,
    `Rules: ${input.tone.rules.join("; ")}.`,
    `Stage 1 affected_kinds: ${kinds}. Stage 1 documentation_gaps: ${JSON.stringify(report.documentation_gaps)}.`,
    'Return ONLY this JSON schema: {"impactStatement": string, "uncertainties": string[], "testsToRun": string[], "edits": [{"action": "replace"|"append"|"create", "docPath": string, "sectionHeading": string, "content": string, "evidence": string[]}]}',
    "Produce separate edits for EVERY affected guide (`api`, `developer`, `user`, `other`/README) listed in affected_kinds and documentation_gaps, and every affected section. Do not stop after updating README.md. If an affected guide has no existing section for a documented gap, use action `create` in that guide.",
    "Use only supplied full sections and changedFiles. Do not use or request the raw diff. For replace/append target a supplied section; for create target a supplied document with a new heading.",
    'For "replace", return the COMPLETE updated section body, preserving all still-accurate paragraphs, numbered steps, screenshots/image links, code blocks, and sub-headings. ONLY modify the specific lines, model names, endpoints, or limits that changed; never delete or summarize away unrelated setup steps or instructions.',
    'For "append", return ONLY the new prose or subsection to add to the end of the existing section; do not repeat the existing section.',
    'For "create", return the new section body; do not return a "before" field.',
    "Evidence must copy a changedFiles path.",
  ].join("\n");
}

async function generateProposalFromImpact(
  input: LLMInput,
  provider: Provider,
  report: ImpactReport
): Promise<LLMProviderResult> {
  const files = parseDiff(input.diffText);
  const sections = stage2Sections(input, report);
  const basePrompt = {
    impactReport: report,
    changedFiles: changedFiles(files),
    sections: sections.map(({ section, content }) => ({
      docPath: section.docPath,
      docKind: section.docKind,
      sectionHeading: section.heading,
      content,
    })),
  };
  let correctionRequired: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await requestModel(
      provider,
      input.model,
      writerSystemPrompt(input, report),
      JSON.stringify({
        ...basePrompt,
        ...(correctionRequired ? { correctionRequired } : {}),
      })
    );
    if (!response.raw) return rejected(provider, response.reason ?? "empty_model_response");
    const result = proposalFromOutput(input, provider, response.raw);
    if (result.proposal) return result;
    correctionRequired = result.reason ?? "The proposal was invalid. Return corrected JSON.";
  }
  return rejected(provider, `proposal_retry_exhausted: ${correctionRequired ?? "unknown validation error"}`);
}

async function requestWithRetry(input: LLMInput, provider: Provider): Promise<LLMProviderResult> {
  let impact: ImpactReport | LLMProviderResult;
  try {
    impact = await analyzeImpactReport(input, provider);
  } catch (error) {
    return rejected(provider, `impact_analysis_failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if ("proposal" in impact) return impact;
  try {
    return await generateProposalFromImpact(input, provider, impact);
  } catch (error) {
    return rejected(provider, `proposal_generation_failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
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
