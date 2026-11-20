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

export type ProgressCallback = (stage: string) => Promise<void> | void;

interface LLMInput {
  model: string;
  productName: string;
  changeSummary: string;
  diffText: string;
  tone: ToneProfileLite;
  docs: DocLike[];
  sections: DocSection[];
  signals: Signal[];
  thoroughAudit?: boolean;
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
const MAX_DOCUMENTS = 5;
const MAX_DOCUMENT_CHARS = 10_000;
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 300_000);

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
          num_ctx: Number(process.env.OLLAMA_NUM_CTX || 8192),
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

async function analyzeImpactReport(
  input: LLMInput,
  provider: Provider,
  onProgress?: ProgressCallback
): Promise<ImpactReport | LLMProviderResult> {
  await onProgress?.("Pass 1/3: Analyzing release diff");
  const prompt = JSON.stringify({
    changeSummary: input.changeSummary,
    diffText: input.diffText.slice(
      0,
      provider === "ollama" ? 20_000 : MAX_ANALYSIS_DIFF_CHARS
    ),
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

interface DocumentContext {
  docPath: string;
  docKind: DocKind;
  sections: DocSection[];
  promptSections: DocSection[];
}

function documentContexts(input: LLMInput, report: ImpactReport): DocumentContext[] {
  const priority = new Map(report.affected_kinds.map((kind, index) => [kind, index]));
  const grouped = new Map<string, DocumentContext>();
  for (const section of input.sections) {
    let group = grouped.get(section.docPath);
    if (!group) {
      const newGroup: DocumentContext = {
        docPath: section.docPath,
        docKind: DOC_KINDS.includes(section.docKind as DocKind)
          ? section.docKind as DocKind
          : "other",
        sections: [],
        promptSections: [],
      };
      grouped.set(section.docPath, newGroup);
      group = newGroup;
    }
    group.sections.push(section);
  }
  const orderedGroups = [...grouped.values()]
    .sort((a, b) =>
      (priority.get(a.docKind) ?? DOC_KINDS.length) -
        (priority.get(b.docKind) ?? DOC_KINDS.length)
    );
  const selectedGroups: DocumentContext[] = [];
  for (const kind of report.affected_kinds) {
    const group = orderedGroups.find((candidate) =>
      candidate.docKind === kind && !selectedGroups.includes(candidate)
    );
    if (group) selectedGroups.push(group);
  }
  for (const group of orderedGroups) {
    if (selectedGroups.length >= MAX_DOCUMENTS) break;
    if (!selectedGroups.includes(group)) selectedGroups.push(group);
  }
  return selectedGroups
    .map((group) => {
      let used = 0;
      const promptSections: DocSection[] = [];
      for (const section of group.sections) {
        const remaining = MAX_DOCUMENT_CHARS - used;
        if (remaining <= 0) break;
        const body = section.body.length <= remaining
          ? section.body
          : `${section.body.slice(0, Math.max(0, remaining - 40))}\n[section context truncated]`;
        promptSections.push({ ...section, body });
        used += body.length;
      }
      return { ...group, promptSections };
    });
}

function writerSystemPrompt(input: LLMInput, report: ImpactReport, docPath: string): string {
  const group = input.sections[0];
  const kinds = report.affected_kinds.join(", ") || "none";
  return [
    "You are Docline's Documentation Writer. Produce minimal, accurate reviewable documentation patches.",
    `House voice for ${input.productName}: ${input.tone.voice}.`,
    `Person: ${input.tone.person}. Formality (1 casual-5 formal): ${input.tone.formality}.`,
    `Rules: ${input.tone.rules.join("; ")}.`,
    `Write only the single document ${docPath}${group ? ` (${group.docKind})` : ""}.`,
    `Stage 1 affected_kinds: ${kinds}. Stage 1 documentation_gaps: ${JSON.stringify(report.documentation_gaps)}.`,
    'Return ONLY this JSON schema: {"impactStatement": string, "uncertainties": string[], "testsToRun": string[], "edits": [{"action": "replace"|"append"|"create", "docPath": string, "sectionHeading": string, "content": string, "evidence": string[]}]}',
    "Produce separate edits for EVERY affected section and gap in this document. Do not write edits for any other document.",
    "Use only supplied section context and changedFiles. Do not use or request the raw diff. For replace/append target a supplied section; for create target a supplied document with a new heading.",
    'For "replace", return the COMPLETE updated section body, preserving all still-accurate paragraphs, numbered steps, screenshots/image links, code blocks, and sub-headings. ONLY modify the specific lines, model names, endpoints, or limits that changed; never delete or summarize away unrelated setup steps or instructions.',
    'For "append", return ONLY the new prose or subsection to add to the end of the existing section; do not repeat the existing section.',
    'For "create", return the new section body; do not return a "before" field. Create a section for a documented gap when this document has no existing section for it.',
    "Evidence must copy a changedFiles path.",
  ].join("\n");
}

async function generateProposalForDocument(
  input: LLMInput,
  provider: Provider,
  report: ImpactReport,
  context: DocumentContext,
  changed: string[]
): Promise<LLMProviderResult> {
  const scopedInput = {
    ...input,
    docs: input.docs.filter((doc) => doc.path === context.docPath),
    sections: context.sections,
  };
  const prompt = {
    impactReport: report,
    changedFiles: changed,
    document: {
      docPath: context.docPath,
      docKind: context.docKind,
      sections: context.promptSections.map((section) => ({
        sectionHeading: section.heading,
        content: section.body,
      })),
    },
  };
  let correctionRequired: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await requestModel(
      provider,
      input.model,
      writerSystemPrompt(scopedInput, report, context.docPath),
      JSON.stringify({
        ...prompt,
        ...(correctionRequired ? { correctionRequired } : {}),
      })
    );
    if (!response.raw) return rejected(provider, response.reason ?? "empty_model_response");
    const result = proposalFromOutput(scopedInput, provider, response.raw);
    if (result.proposal) return result;
    correctionRequired = result.reason ?? "The proposal was invalid. Return corrected JSON.";
  }
  return rejected(provider, `proposal_retry_exhausted: ${correctionRequired ?? "unknown validation error"}`);
}

function auditedAfter(edit: Proposal["edits"][number], section: DocSection | undefined, content: string) {
  const trimmed = content.trim();
  if (edit.action === "replace") {
    const title = section ? headingLine(section) : `## ${edit.sectionHeading}`;
    return startsWithHeading(trimmed, edit.sectionHeading) ? trimmed : `${title}\n\n${trimmed}`;
  }
  if (edit.action === "append") return `${edit.before}\n\n${trimmed}`;
  return startsWithMarkdownHeading(trimmed) ? trimmed : `## ${edit.sectionHeading}\n\n${trimmed}`;
}

async function selfAuditProposal(
  input: LLMInput,
  provider: Provider,
  report: ImpactReport,
  proposal: Proposal,
  onProgress?: ProgressCallback
): Promise<Proposal> {
  const files = parseDiff(input.diffText);
  const auditedEdits = [...proposal.edits];
  for (let index = 0; index < proposal.edits.length; index++) {
    const edit = proposal.edits[index];
    const section = input.sections.find((candidate) =>
      candidate.docPath === edit.docPath && candidate.heading === edit.sectionHeading
    );
    await onProgress?.(
      `Pass 3/3: Auditing ${edit.docPath.split("/").pop() ?? edit.docPath} (${index + 1} of ${proposal.edits.length})`
    );
    const response = await requestModel(
      provider,
      input.model,
      [
        "You are Docline's documentation self-auditor.",
        "Check that the edit preserves all still-valid steps, screenshots, code blocks, and sub-headings; includes exact literal facts required by the ImpactReport for this guide; and follows every supplied house writing rule.",
        'Return only JSON: {"approved": boolean, "content": string, "reason": string}. If approved, content must be the full section body for replace, only new prose for append, or new section body for create.',
      ].join("\n"),
      JSON.stringify({
        impactReport: report,
        documentPath: edit.docPath,
        sectionHeading: edit.sectionHeading,
        originalSection: section?.body ?? null,
        edit: { action: edit.action, content: edit.after },
        writingRules: {
          voice: input.tone.voice,
          person: input.tone.person,
          formality: input.tone.formality,
          rules: input.tone.rules,
        },
      })
    );
    if (!response.raw) {
      console.warn("[docline] Self-audit failed; keeping validated draft:", response.reason);
      continue;
    }
    let audit: { approved?: boolean; content?: string; reason?: string };
    try {
      audit = JSON.parse(stripJsonFence(response.raw)) as typeof audit;
    } catch (error) {
      console.warn(
        "[docline] Self-audit returned invalid JSON; keeping validated draft:",
        error instanceof Error ? error.message : "parse failed"
      );
      continue;
    }
    if (audit.approved !== true || typeof audit.content !== "string" || !audit.content.trim()) continue;
    const content = audit.content.trim();
    if (
      edit.action === "replace" &&
      section &&
      section.body.length > 300 &&
      content.length < section.body.length * 0.45
    ) continue;
    const candidateEdit = { ...edit, after: auditedAfter(edit, section, content) };
    const candidate: Proposal = {
      ...proposal,
      edits: auditedEdits.map((current, currentIndex) =>
        currentIndex === index ? candidateEdit : current
      ),
    };
    const invalid = validateProposal(candidate, input.docs, files, input.sections);
    if (!invalid) auditedEdits[index] = candidateEdit;
  }
  return { ...proposal, edits: auditedEdits };
}

async function generateProposalFromImpact(
  input: LLMInput,
  provider: Provider,
  report: ImpactReport,
  onProgress?: ProgressCallback
): Promise<LLMProviderResult> {
  const files = parseDiff(input.diffText);
  const contexts = documentContexts(input, report);
  if (contexts.length === 0) return rejected(provider, "no_retrieved_document_sections");
  const changed = changedFiles(files);
  const combined: Proposal = {
    impactStatement: report.technical_summary || "Documentation updates are required.",
    uncertainties: [],
    testsToRun: [],
    edits: [],
    signals: input.signals,
    llm: true,
  };
  const failures: string[] = [];
  for (let index = 0; index < contexts.length; index++) {
    const context = contexts[index];
    await onProgress?.(
      `Pass 2/3: Drafting ${context.docPath.split("/").pop() ?? context.docPath} (${index + 1} of ${contexts.length})`
    );
    const result = await generateProposalForDocument(
      input,
      provider,
      report,
      context,
      changed
    );
    if (!result.proposal) {
      const failure = `${context.docPath}: drafting failed (${result.reason ?? "unknown error"}); review this guide manually.`;
      failures.push(failure);
      continue;
    }
    combined.edits.push(...result.proposal.edits);
    combined.uncertainties.push(...result.proposal.uncertainties);
    combined.testsToRun.push(...result.proposal.testsToRun);
  }
  if (combined.edits.length === 0) {
    return rejected(provider, failures.join(" ") || "no_reviewable_edits");
  }
  combined.uncertainties.push(...failures);
  const invalid = validateProposal(combined, input.docs, files, input.sections);
  if (invalid) return rejected(provider, `combined_proposal_validation_failed: ${invalid}`);
  return {
    proposal: input.thoroughAudit === false
      ? combined
      : await selfAuditProposal(input, provider, report, combined, onProgress),
    reason: null,
  };
}

async function requestWithRetry(
  input: LLMInput,
  provider: Provider,
  onProgress?: ProgressCallback
): Promise<LLMProviderResult> {
  let impact: ImpactReport | LLMProviderResult;
  try {
    impact = await analyzeImpactReport(input, provider, onProgress);
  } catch (error) {
    return rejected(provider, `impact_analysis_failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if ("proposal" in impact) return impact;
  try {
    return await generateProposalFromImpact(input, provider, impact, onProgress);
  } catch (error) {
    return rejected(provider, `proposal_generation_failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export async function tryOpenRouter(
  input: LLMInput,
  onProgress?: ProgressCallback
): Promise<LLMProviderResult> {
  return requestWithRetry(input, "openrouter", onProgress);
}

export async function tryOllama(
  input: LLMInput,
  onProgress?: ProgressCallback
): Promise<LLMProviderResult> {
  return requestWithRetry(input, "ollama", onProgress);
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
