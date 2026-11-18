// Docline pipeline engine — pure functions, no I/O.
// Stages: parse diff -> extract signals -> retrieve sections -> draft edits
// -> assemble proposal -> validate. Mirrors the review-behavior contract:
// bounded inputs, evidence-linked edits, human-reviewable output only.

export type SignalKind = "endpoint" | "endpoint_removed" | "symbol" | "env" | "version" | "deprecation";

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

/** Retrieve the strongest section per document; changelog always qualifies. */
export function retrieveSections(
  docs: { id: string; path: string; title: string; content: string; version: number }[],
  signals: Signal[],
  maxDocs = 4
): { section: DocSection; matched: Signal[] }[] {
  const ranked: { section: DocSection; matched: Signal[]; score: number }[] = [];

  for (const doc of docs) {
    const sections = splitSections(doc);
    const isChangelog = /changelog|release-notes|releases/i.test(doc.path);
    let best: { section: DocSection; matched: Signal[]; score: number } | null = null;
    for (const section of sections) {
      const matched = signals.filter((s) => s.kind !== "version" && s.kind !== "endpoint_removed" && sectionScore(section.body, s) > 0);
      const score = matched.reduce((a, s) => a + sectionScore(section.body, s), 0);
      if (score > 0 && (!best || score > best.score)) best = { section, matched, score };
    }
    if (!best && isChangelog && sections.length > 0) {
      best = { section: sections[0], matched: [], score: 0.5 };
    }
    if (best) ranked.push(best);
  }

  ranked.sort((a, b) => b.score - a.score);
  const chosen = ranked.filter((r) => r.score > 0).slice(0, maxDocs);
  const changelog = ranked.find((r) => r.score === 0.5);
  if (changelog && !chosen.includes(changelog)) chosen.push(changelog);
  return chosen.slice(0, maxDocs + 1);
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
  docs: { id: string; path: string; title: string; content: string; version: number }[];
  files: DiffFile[];
  signals: Signal[];
  tone: ToneProfileLite;
  llm?: boolean;
}): Proposal {
  const { docs, files, signals, tone } = input;
  const version = signals.find((s) => s.kind === "version")?.value ?? null;
  const retrieved = retrieveSections(docs, signals);
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
      ...f.added.map((a) => `${f.path}:L${a.n}`),
      ...f.removedLines.map((r) => `${f.path}:L${r.n}`),
    ])
  );
  for (const e of p.edits) {
    const doc = docs.find((d) => d.path === e.docPath);
    if (!doc) return `Edit targets unknown document ${e.docPath}.`;
    if (allowedSections) {
      const section = allowedSections.find(
        (s) => s.docPath === e.docPath && s.heading === e.sectionHeading
      );
      if (!section || section.body !== e.before) {
        return `Edit target ${e.docPath} / ${e.sectionHeading} was not retrieved for this run.`;
      }
    }
    if (e.action === "create") {
      if (e.before !== "") return `Create edit in ${e.docPath} must not replace existing prose.`;
      if (allowedSections && !allowedSections.some((s) => s.docPath === e.docPath)) {
        return `New section target ${e.docPath} was not retrieved for this run.`;
      }
      const heading = new RegExp(`^#{1,4}\\s+${escapeRe(e.sectionHeading)}\\s*$`, "m");
      if (heading.test(doc.content)) return `Section ${e.sectionHeading} already exists in ${e.docPath}.`;
      if (!heading.test(e.after)) return `Create edit for ${e.docPath} must start with its new section heading.`;
    } else {
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
