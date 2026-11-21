// Docline pipeline engine — pure functions, no I/O.
// Stages: parse diff -> extract signals -> retrieve sections -> draft edits
// -> assemble proposal -> validate. Mirrors the review-behavior contract:
// bounded inputs, evidence-linked edits, human-reviewable output only.

export type SignalKind = "endpoint" | "endpoint_removed" | "symbol" | "env" | "version" | "deprecation";
export type DocumentKind = "api" | "developer" | "user" | "blog" | "other";

const DOC_KINDS: DocumentKind[] = ["api", "developer", "user", "blog", "other"];

export interface Signal {
  kind: SignalKind;
  value: string;
  file: string;
  line: number;
}

export interface DiffFile {
  path: string;
  added: { n: number; text: string }[];
  removed: string[];
  removedLines: { n: number; text: string }[];
  removedCount: number;
}

export interface DocSection {
  documentId: string;
  docPath: string;
  docTitle: string;
  docKind: DocumentKind;
  docVersion: number;
  heading: string;
  level: number;
  body: string; // exact slice of the document, heading line included
}

export interface DraftEdit {
  action: "replace" | "append" | "create";
  documentId: string;
  docPath: string;
  sectionHeading: string;
  before: string;
  after: string;
  evidence: string[];
  docVersion: number;
}

export interface Proposal {
  impactStatement: string;
  uncertainties: string[];
  testsToRun: string[];
  edits: DraftEdit[];
  signals: Signal[];
  llm: boolean;
}

export interface ToneProfileLite {
  voice: string;
  person: string;
  formality: number;
  rules: string[];
}

const MAX_DIFF_FILES = 100;
const MAX_DIFF_BYTES = 250_000;

export class DiffLimitError extends Error {}

// Lockfiles, generated code, tests and docs trees don't carry product signals.
const NOISE_PATH = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock(b)?|composer\.lock|Gemfile\.lock|poetry\.lock)$|\.lock$|\.(test|spec)\.[tj]sx?$|(^|\/)__tests__\/(.*)$|(^|\/)tests?\/(.*)$|^docs\/(.*)$/i;

const ENV_BLOCKLIST = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "HTTP", "HTTPS",
  "JSON", "TODO", "FIXME", "NOTE", "TRUE", "FALSE", "NULL", "API", "URL", "URI",
  "SDK", "CLI", "LTS", "MIT", "ASCII", "UTF", "NODE", "TYPE", "NAME", "NONE",
  // SQL / language keywords that match the SHOUTY_CASE heuristic.
  "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "CREATE", "ALTER", "DROP",
  "TABLE", "INDEX", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "AS",
  "AND", "OR", "NOT", "IN", "IS", "BY", "GROUP", "ORDER", "LIMIT", "OFFSET",
  "VALUES", "INTO", "SET", "DEFAULT", "PRIMARY", "FOREIGN", "KEY", "REFERENCES",
  "CONST", "LET", "VAR", "RETURN", "IMPORT", "EXPORT", "PUBLIC", "PRIVATE",
  "STATIC", "VOID", "INT", "LONG", "CHAR", "BOOL", "FLOAT", "DOUBLE",
]);
// A plausible env var has an underscore or digit; bare words are keywords.
const PLAUSIBLE_ENV = /[_0-9]/;

/** Parse a unified diff into per-file added lines with real line numbers. */
export function parseDiff(diffText: string): DiffFile[] {
  if (new TextEncoder().encode(diffText).byteLength > MAX_DIFF_BYTES) {
    throw new DiffLimitError(`Diff exceeds the ${MAX_DIFF_BYTES}-byte limit`);
  }
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let newLine = 0;
  let oldLine = 0;
  let oldPath = "";
  const lines = diffText.split("\n");

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      current = null;
      oldPath = "";
      continue;
    }
    if (raw.startsWith("--- a/")) {
      oldPath = raw.slice(6).trim();
      continue;
    }
    if (raw.startsWith("+++ b/")) {
      const path = raw.slice(6).trim();
      if (NOISE_PATH.test(path)) {
        current = null;
        continue;
      }
      current = { path, added: [], removed: [], removedLines: [], removedCount: 0 };
      files.push(current);
      if (files.length > MAX_DIFF_FILES) {
        throw new DiffLimitError(`Diff changes more than ${MAX_DIFF_FILES} files`);
      }
      continue;
    }
    if (raw === "+++ /dev/null") {
      if (oldPath && !NOISE_PATH.test(oldPath)) {
        current = { path: oldPath, added: [], removed: [], removedLines: [], removedCount: 0 };
        files.push(current);
        if (files.length > MAX_DIFF_FILES) {
          throw new DiffLimitError(`Diff changes more than ${MAX_DIFF_FILES} files`);
        }
      } else {
        current = null;
      }
      continue;
    }
    if (raw.startsWith("+++ ")) {
      // /dev/null (deleted file) — skip
      current = null;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+")) {
      current.added.push({ n: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("--- ")) {
      // File header, not a removed source line.
      continue;
    } else if (raw.startsWith("-")) {
      current.removed.push(raw.slice(1));
      current.removedLines.push({ n: oldLine, text: raw.slice(1) });
      current.removedCount++;
      oldLine++;
    } else {
      newLine++;
      oldLine++;
    }
  }
  return files.filter((f) => f.added.length > 0 || f.removedCount > 0);
}

/** Extract reviewable signals from added lines. */
export function extractSignals(files: DiffFile[]): Signal[] {
  const seen = new Set<string>();
  const out: Signal[] = [];
  const push = (s: Signal) => {
    const key = `${s.kind}:${s.value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  for (const f of files) {
    for (const { n, text } of f.added) {
      const m1 = /\b(GET|POST|PUT|PATCH|DELETE)\b[\s"'`(]*(\/[\w\-./{}:]+)/.exec(text);
      const m2 = m1
        ? null
        : /\.(get|post|put|patch|delete)\(\s*["'`](\/[\w\-./{}:]+)["'`]/i.exec(text);
      if (m1) {
        push({ kind: "endpoint", value: `${m1[1]} ${m1[2]}`, file: f.path, line: n });
      } else if (m2) {
        push({
          kind: "endpoint",
          value: `${m2[1].toUpperCase()} ${m2[2]}`,
          file: f.path,
          line: n,
        });
      }

      const sym = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_]\w*)/.exec(text);
      if (sym) push({ kind: "symbol", value: sym[1], file: f.path, line: n });

      const envs = text.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? [];
      for (const e of envs) {
        if (!ENV_BLOCKLIST.has(e) && PLAUSIBLE_ENV.test(e)) push({ kind: "env", value: e, file: f.path, line: n });
      }

      const ver = /\bv?(\d+\.\d+\.\d+)\b/.exec(text);
      if (ver) push({ kind: "version", value: ver[1], file: f.path, line: n });

      if (/deprecat/i.test(text)) {
        const tok = /[`'"]([\w./{}:-]+)[`'"]/.exec(text);
        push({
          kind: "deprecation",
          value: tok ? tok[1] : text.trim().slice(0, 60),
          file: f.path,
          line: n,
        });
      }
    }
    for (const { n, text } of f.removedLines) {
      const removedEndpoint = /\b(GET|POST|PUT|PATCH|DELETE)\b[\s"'`(]*(\/[\w\-./{}:]+)/.exec(text);
      if (removedEndpoint) {
        push({
          kind: "endpoint_removed",
          value: `${removedEndpoint[1]} ${removedEndpoint[2]}`,
          file: f.path,
          line: n,
        });
      }
    }
  }

  const cap = (kind: SignalKind, max: number) =>
    out.filter((s) => s.kind === kind).slice(0, max);
  // Version: a package.json "version" field outranks an incidental x.y.z in
  // dependency bumps — sort those first before capping.
  const versions = out.filter((s) => s.kind === "version");
  versions.sort((a, b) => {
    const aPkg = a.file.endsWith("package.json") ? 0 : 1;
    const bPkg = b.file.endsWith("package.json") ? 0 : 1;
    return aPkg - bPkg;
  });
  const rest = [
    ...cap("endpoint", 6),
    ...cap("endpoint_removed", 4),
    ...cap("symbol", 8),
    ...cap("env", 8),
    ...cap("deprecation", 4),
  ].filter((s) => s.kind !== "version");
  return [...rest, ...versions.slice(0, 2)];
}

/** Split markdown into headed sections. body is an exact slice of content. */
export function splitSections(doc: {
  id: string;
  path: string;
  title: string;
  content: string;
  version: number;
  docKind?: string;
}): DocSection[] {
  const lines = doc.content.split("\n");
  const marks: { idx: number; level: number; heading: string }[] = [];
  let inFence = false;
  lines.forEach((l, idx) => {
    // '#' inside a fenced code block is a comment or output, not a heading.
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = /^(#{1,4})\s+(.*)$/.exec(l);
    if (m) marks.push({ idx, level: m[1].length, heading: m[2].trim() });
  });
  const sections: DocSection[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i];
    // An H1 document title is front-matter: it ends at the next H1 or H2.
    const endLevel = start.level === 1 ? 2 : start.level;
    let end = lines.length;
    for (let j = i + 1; j < marks.length; j++) {
      if (marks[j].level <= endLevel) {
        end = marks[j].idx;
        break;
      }
    }
    const body = lines.slice(start.idx, end).join("\n").replace(/\n+$/, "");
    sections.push({
      documentId: doc.id,
      docPath: doc.path,
      docTitle: doc.title,
      docKind: docKindOf(doc),
      docVersion: doc.version,
      heading: start.heading,
      level: start.level,
      body,
    });
  }
  return sections;
}

const camelLast = (v: string): string | null => {
  const parts = v.split(/(?=[A-Z])|[_-]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? v;
  return last.length >= 4 ? last.toLowerCase() : null;
};

/** Weighted match tokens: exact hits score highest, family tokens allow
 *  retrieval to find sections that discuss the surrounding feature. */
const matchTokens = (s: Signal): { t: string; w: number }[] => {
  if (s.kind === "endpoint") {
    const path = s.value.split(" ")[1] ?? s.value;
    const segs = path.split("/").filter(Boolean);
    const last = (segs[segs.length - 1] ?? path).replace(/[{}]/g, "");
    const toks = [{ t: path, w: 3 }];
    if (last.length >= 4) toks.push({ t: last, w: 2 });
    if (segs.length >= 2) toks.push({ t: "/" + segs.slice(0, 2).join("/"), w: 2 });
    return toks;
  }
  if (s.kind === "symbol") {
    const toks = [{ t: s.value, w: 3 }];
    const cl = camelLast(s.value);
    if (cl) toks.push({ t: cl, w: 1 });
    return toks;
  }
  if (s.kind === "env") {
    const prefix = s.value.split("_")[0];
    const toks = [{ t: s.value, w: 2 }];
    if (prefix && prefix.length >= 3) toks.push({ t: `${prefix}_`, w: 1 });
    return toks;
  }
  if (s.kind === "deprecation")
    return [{ t: s.value.replace(/[^\w./-]/g, ""), w: 3 }];
  return [];
};

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function documentKind(path: string): DocumentKind {
  if (/(^|\/)(api|reference|openapi)(\/|[-_.]|$)/i.test(path)) return "api";
  if (/(^|\/)(developer|setup|sdk|contributing)(\/|[-_.]|$)/i.test(path)) return "developer";
  if (/(^|\/)(user|guide|tutorial)(\/|[-_.]|$)/i.test(path)) return "user";
  if (/(^|\/)(blog|changelog|release|releases)(\/|[-_.]|$)/i.test(path)) return "blog";
  return "other";
}

function docKindOf(doc: { path: string; docKind?: string }): DocumentKind {
  return DOC_KINDS.find((kind) => kind === doc.docKind) ?? documentKind(doc.path);
}

function sectionScore(body: string, s: Signal): number {
  const hay = body.toLowerCase();
  let w = 0;
  for (const { t, w: tw } of matchTokens(s)) {
    // Word-boundary matching: "list" must not match "listed" or "playlist".
    if (t.length < 4) continue;
    const re = new RegExp(`\\b${escapeRe(t.toLowerCase())}`, "i");
    if (re.test(hay.replace(/\n/g, " "))) w = Math.max(w, tw);
  }
  return w;
}

const RETRIEVAL_STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "and", "any", "are", "because",
  "been", "before", "being", "between", "both", "but", "can", "could", "did",
  "does", "doing", "down", "during", "each", "few", "for", "from", "further",
  "had", "has", "have", "having", "here", "hers", "him", "his", "how", "into",
  "its", "itself", "just", "more", "most", "much", "must", "new", "nor", "not",
  "now", "off", "once", "only", "other", "our", "out", "over", "own", "same",
  "should", "some", "such", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "those", "through", "too", "under", "until",
  "very", "was", "were", "what", "when", "where", "which", "while", "who",
  "whom", "why", "will", "with", "would", "you", "your", "added", "adding",
  "change", "changed", "changes", "changing", "documentation", "docs", "feature",
  "features", "fix", "fixed", "implement", "implemented", "release", "updated",
  "update", "updates", "updating", "readme", "diff", "file", "files", "line",
  "lines", "true", "false", "null", "none", "const", "let", "var", "return",
  "class", "function", "import", "export", "from", "async", "await", "string",
  "number", "boolean", "get", "set", "post", "put", "patch", "delete", "http",
  "https", "json", "api",
]);
const MAX_RETRIEVAL_KEYWORDS = 500;
const DEFAULT_RETRIEVAL_BUDGET = 32_000;

function normalizeSearchText(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function retrievalTerms(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized
    .split(/\s+/)
    .filter((term) => term.length >= 4 && !RETRIEVAL_STOPWORDS.has(term));
}

interface RetrievalOptions {
  signals: Signal[];
  diffText?: string;
  changeSummary?: string;
  changedFiles?: string[];
  maxSectionsPerDoc?: number;
  maxChars?: number;
}

/** Retrieve relevant sections across document kinds within a bounded context budget. */
export function retrieveSections(
  docs: { id: string; path: string; title: string; content: string; version: number; docKind?: string }[],
  options: RetrievalOptions
): { section: DocSection; matched: Signal[] }[] {
  const maxSectionsPerDoc = options.maxSectionsPerDoc ?? 4;
  const maxChars = options.maxChars ?? DEFAULT_RETRIEVAL_BUDGET;
  const changedFiles = options.changedFiles ?? [];
  const keywords = new Map<string, number>();
  const addKeywords = (text: string, weight: number) => {
    for (const term of retrievalTerms(text)) {
      if (keywords.has(term)) {
        keywords.set(term, Math.max(keywords.get(term) ?? 0, weight));
      } else if (keywords.size < MAX_RETRIEVAL_KEYWORDS) {
        keywords.set(term, weight);
      }
    }
  };
  addKeywords(options.changeSummary ?? "", 3);
  addKeywords(changedFiles.join("\n"), 2);
  const changedLines = (options.diffText ?? "").split(/\r?\n/).filter((line) =>
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---"))
  );
  addKeywords(changedLines.map((line) => line.slice(1)).join("\n"), 1);

  const candidates = docs.flatMap((doc) =>
    splitSections(doc).map((section) => {
      const matched = options.signals.filter((signal) =>
        signal.kind !== "version" &&
        signal.kind !== "endpoint_removed" &&
        sectionScore(`${section.heading}\n${section.body}`, signal) > 0
      );
      const haystack = ` ${normalizeSearchText(
        `${section.heading}\n${section.body}\n${doc.title}\n${doc.path}`
      )} `;
      const keywordScore = [...keywords].reduce(
        (score, [term, weight]) => score + (haystack.includes(` ${term} `) ? weight : 0),
        0
      );
      const signalScore = matched.reduce(
        (score, signal) => score + sectionScore(`${section.heading}\n${section.body}`, signal),
        0
      );
      return { section, matched, score: keywordScore + signalScore };
    })
  ).sort((a, b) =>
    b.score - a.score ||
    a.section.docPath.localeCompare(b.section.docPath) ||
    a.section.heading.localeCompare(b.section.heading)
  );

  const kindsPresent = [...new Set(docs.map(docKindOf))];
  const kindBudget = Math.floor(maxChars / Math.max(kindsPresent.length, 1));
  const selected: { section: DocSection; matched: Signal[] }[] = [];
  const selectedIds = new Set<string>();
  const sectionCounts = new Map<string, number>();
  let usedChars = 0;
  const addCandidate = (
    candidate: (typeof candidates)[number],
    maxCandidateChars = maxChars - usedChars
  ) => {
    const { section } = candidate;
    const key = `${section.docPath}\0${section.heading}`;
    if (
      selectedIds.has(key) ||
      (sectionCounts.get(section.docPath) ?? 0) >= maxSectionsPerDoc ||
      section.body.length > maxCandidateChars ||
      section.body.length > maxChars - usedChars
    ) return false;
    selected.push({ section, matched: candidate.matched });
    selectedIds.add(key);
    sectionCounts.set(section.docPath, (sectionCounts.get(section.docPath) ?? 0) + 1);
    usedChars += section.body.length;
    return true;
  };

  // Reserve one relevant section per present document kind before filling by score.
  for (const kind of kindsPresent) {
    const ofKind = candidates.filter(({ section }) => section.docKind === kind);
    const top = ofKind.find(({ section }) => section.body.length <= kindBudget);
    if (top) {
      addCandidate(top, kindBudget);
    } else {
      const fallback = ofKind.find(({ section }) =>
        section.body.length <= maxChars - usedChars
      );
      if (fallback) addCandidate(fallback);
    }
  }
  for (const candidate of candidates) {
    if (candidate.score > 0) addCandidate(candidate);
  }

  return selected;
}

/** Broad but bounded context for providers when keyword retrieval is too sparse. */
export function fallbackSectionsByKind(
  docs: { id: string; path: string; title: string; content: string; version: number; docKind?: string }[],
  signals: Signal[],
  changedFiles: string[],
  maxChars = 24_000
): DocSection[] {
  const selected: DocSection[] = [];
  let usedChars = 0;
  const selectedSections = new Set<string>();
  const changedTokens = [...new Set(changedFiles.flatMap((path) => {
    const stem = (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
    return stem
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\-\s]+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 4);
  }))];
  const candidatesByKind = DOC_KINDS.map((kind) =>
    docs
      .filter((doc) => docKindOf(doc) === kind)
      .flatMap((doc) => splitSections(doc).map((section) => {
        const haystack = `${section.heading}\n${section.body}\n${doc.title}\n${doc.path}`.toLowerCase();
        const signalScore = signals.reduce((score, signal) => (
          score + sectionScore(`${section.heading}\n${section.body}`, signal)
        ), 0);
        const pathScore = changedTokens.reduce((score, token) => (
          score + (new RegExp(`\\b${escapeRe(token)}\\b`, "i").test(haystack) ? 1 : 0)
        ), 0);
        return { section, score: signalScore + pathScore };
      }))
      .sort((a, b) => b.score - a.score || a.section.docPath.localeCompare(b.section.docPath))
  );
  const addOne = (candidates: (typeof candidatesByKind)[number], maxSectionChars: number) => {
    const candidate = candidates.find(({ section }) =>
      section.body.length > 0 &&
      section.body.length <= maxSectionChars &&
      usedChars + section.body.length <= maxChars &&
      !selectedSections.has(`${section.docPath}:${section.heading}`)
    );
    if (!candidate) return;
    selected.push(candidate.section);
    selectedSections.add(`${candidate.section.docPath}:${candidate.section.heading}`);
    usedChars += candidate.section.body.length;
  };
  for (const candidates of candidatesByKind) addOne(candidates, Math.min(4_800, maxChars));
  for (const candidates of candidatesByKind) addOne(candidates, maxChars);
  return selected;
}

// Published prose carries no internal source refs — citations belong to the
// review record (evidence metadata), not to customer-facing documentation.
function bulletFor(s: Signal): string {
  switch (s.kind) {
    case "endpoint":
      return `The changed source defines \`${s.value}\`.`;
    case "symbol":
      return `The changed source exports \`${s.value}\`.`;
    case "env":
      return `The changed source references the configuration variable \`${s.value}\`.`;
    case "deprecation":
      return `The changed source marks \`${s.value}\` as deprecated.`;
    default:
      return "";
  }
}

/** Draft the replacement text for one section, aligned to the house tone. */
export function draftSectionEdit(
  section: DocSection,
  matched: Signal[],
  version: string | null,
  tone: ToneProfileLite
): DraftEdit {
  const releaseHeading = version ? `What's new in ${version}` : "Latest update";
  const evidence = matched.map((s) => `${s.file}:L${s.line}`);
  const lines: string[] = [];

  const bullets = matched.map(bulletFor).filter(Boolean);
  const headLevel = Math.min(section.level + 1, 4);
  const hashes = "#".repeat(headLevel);

  lines.push("", `${hashes} ${releaseHeading}`, "");
  const lead = matched.find((s) => s.kind === "endpoint") ?? matched.find((s) => s.kind === "symbol");
  if (lead && tone.person === "second") {
    lines.push(
      lead.kind === "endpoint"
        ? `You can now call \`${lead.value}\` directly.`
        : `You can now import \`${lead.value}\` from the SDK alongside the calls you already make.`,
      ""
    );
  }
  for (const b of bullets) lines.push(`- ${b}`);

  let block = lines.join("\n");
  // Tone guardrails: house style bans exclamation marks — but never rewrite
  // inside code fences or inline code, where ! is syntax (shebangs, !=, etc).
  block = block
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((chunk, i) => (i % 2 === 1 ? chunk : chunk.replace(/!/g, ".")))
    .join("");

  return {
    action: "append",
    documentId: section.documentId,
    docPath: section.docPath,
    sectionHeading: section.heading,
    before: section.body,
    after: section.body + block,
    evidence,
    docVersion: section.docVersion,
  };
}

/** Assemble the full review proposal from retrieved sections. */
export function buildProposal(input: {
  docs: { id: string; path: string; title: string; content: string; version: number; docKind?: string }[];
  files: DiffFile[];
  signals: Signal[];
  tone: ToneProfileLite;
  diffText?: string;
  changeSummary?: string;
  llm?: boolean;
}): Proposal {
  const { docs, files, signals, tone } = input;
  const version = signals.find((s) => s.kind === "version")?.value ?? null;
  const diffText = input.diffText ?? files.flatMap((file) => [
    ...file.removedLines.map((line) => `-${line.text}`),
    ...file.added.map((line) => `+${line.text}`),
  ]).join("\n");
  const retrieved = retrieveSections(docs, {
    signals,
    diffText,
    changeSummary: input.changeSummary,
    changedFiles: files.map((file) => file.path),
  });
  const edits = retrieved.map(({ section, matched }) => {
    const isChangelog = /changelog|release/i.test(section.docPath);
    // A changelog summarizes the whole release, even when its own prose
    // does not mention any signal yet.
    const effective =
      isChangelog && matched.length === 0
        ? signals.filter((s) => s.kind !== "version").slice(0, 6)
        : matched;
    return draftSectionEdit(section, effective, version, tone);
  });

  const covered = new Set(retrieved.flatMap((r) => r.matched.map((m) => `${m.kind}:${m.value.toLowerCase()}`)));
  const uncovered = signals.filter(
    (s) => s.kind !== "version" && !covered.has(`${s.kind}:${s.value.toLowerCase()}`)
  );

  const count = (k: SignalKind) => signals.filter((s) => s.kind === k).length;
  const parts: string[] = [];
  if (count("endpoint")) parts.push(`${count("endpoint")} endpoint${count("endpoint") > 1 ? "s" : ""}`);
  if (count("symbol")) parts.push(`${count("symbol")} SDK export${count("symbol") > 1 ? "s" : ""}`);
  if (count("env")) parts.push(`${count("env")} configuration variable${count("env") > 1 ? "s" : ""}`);
  const dep = signals.find((s) => s.kind === "deprecation");
  const impactStatement =
    (parts.length
      ? `${version ? `Release ${version} ` : "This release "}changes ${parts.join(", ")}.`
      : signals.length
        ? "The diff contains signals that need human interpretation."
        : "No user-facing API surface was detected in this diff.") +
    (dep ? ` It deprecates \`${dep.value}\`.` : "") +
    ` ${edits.length} documentation section${edits.length === 1 ? " maps" : "s map"} to these changes.`;

  const removed = files.reduce((a, f) => a + f.removedCount, 0);
  const added = files.reduce((a, f) => a + f.added.length, 0);
  const uncertainties = uncovered.map(
    (s) => `No documentation mentions \`${s.value}\` (${s.file}:L${s.line}). Confirm whether it is user-facing before publishing.`
  );
  for (const s of signals.filter((x) => x.kind === "endpoint_removed")) {
    uncertainties.push(
      `\`${s.value}\` was removed from the source (${s.file}). Review docs for stale references — removal proposals need human judgment.`
    );
  }
  if (removed > added) {
    uncertainties.push(
      `The diff removes more than it adds (${removed} removed vs ${added} added). Skim behavior changes that signals cannot express.`
    );
  }

  const firstEndpoint = signals.find((s) => s.kind === "endpoint");
  const testsToRun = [
    "Render every edited page and check anchors, code fences, and links.",
    ...(firstEndpoint ? [`Replay the \`${firstEndpoint.value}\` examples against staging.`] : []),
    ...(dep ? [`Search the docs for remaining \`${dep.value}\` mentions after the deprecation note ships.`] : []),
  ];

  return {
    impactStatement,
    uncertainties,
    testsToRun,
    edits: edits.filter((e) => e.after !== e.before),
    signals,
    llm: input.llm ?? false,
  };
}

/** Validate an (LLM or local) proposal against ground truth before review. */
export function validateProposal(
  p: Proposal,
  docs: { path: string; content: string }[],
  files: DiffFile[],
  allowedSections?: DocSection[]
): string | null {
  const validRefs = new Set(
    files.flatMap((f) => [
      f.path,
      ...f.added.map((a) => `${f.path}:L${a.n}`),
      ...f.removedLines.map((r) => `${f.path}:L${r.n}`),
    ])
  );
  for (const e of p.edits) {
    const doc = docs.find((d) => d.path === e.docPath);
    if (!doc) return `Edit targets unknown document ${e.docPath}.`;
    if (e.action === "create") {
      if (e.before !== "") return `Create edit in ${e.docPath} must not replace existing prose.`;
      if (allowedSections && !allowedSections.some((s) => s.docPath === e.docPath)) {
        return `New section target ${e.docPath} was not retrieved for this run.`;
      }
      const heading = new RegExp(`^#{1,4}\\s+${escapeRe(e.sectionHeading)}\\s*$`, "m");
      if (heading.test(doc.content)) return `Section ${e.sectionHeading} already exists in ${e.docPath}.`;
      if (!new RegExp(`^#{1,4}\\s+${escapeRe(e.sectionHeading)}\\s*(?:\\r?\\n|$)`).test(e.after)) {
        return `Create edit for ${e.docPath} must start with its new section heading.`;
      }
    } else {
      if (allowedSections) {
        const section = allowedSections.find(
          (s) => s.docPath === e.docPath && s.heading === e.sectionHeading && s.body === e.before
        );
        if (!section) {
          return `Edit target ${e.docPath} / ${e.sectionHeading} was not retrieved for this run.`;
        }
      }
      if (!doc.content.includes(e.before))
        return `Edit target in ${e.docPath} no longer matches the document.`;
      // Uniqueness: replacing a repeated fragment would hit an arbitrary match.
      if (doc.content.split(e.before).length - 1 !== 1)
        return `Edit target in ${e.docPath} is not unique in the document.`;
      if (e.action === "append" && !e.after.startsWith(e.before))
        return `Append edit in ${e.docPath} must preserve the original section text at the start.`;
    }
    if (e.evidence.length === 0)
      return `Edit in ${e.docPath} cites no evidence.`;
    const badRef = e.evidence.find((ref) => !validRefs.has(ref));
    if (badRef) return `Edit cites evidence ${badRef} that is not in the supplied diff.`;
  }
  return null;
}
