import type { ReactNode } from "react";

/** Minimal, dependency-free markdown renderer for our trusted docs corpus.
 *  Supports: fenced code, h1–h4, tables, bulleted + numbered lists, links,
 *  bold, italics, inline code. */

function inline(text: string): ReactNode[] {
  // Split on inline code first so emphasis/link rules never touch code spans.
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith("`") && p.endsWith("`") ? (
      <code key={i}>{p.slice(1, -1)}</code>
    ) : (
      <span key={i}>{linkify(p, i)}</span>
    )
  );
}

function linkify(text: string, keyBase: number): ReactNode {
  const parts = text.split(/(\[[^\]]+\]\([^)]+\))/g);
  if (parts.length === 1) return strongify(text, keyBase);
  return parts.map((p, i) => {
    const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
    if (m) {
      const href = m[2];
      const safe = /^(https?:|mailto:|\/|#)/.test(href);
      return (
        <a
          key={`${keyBase}-${i}`}
          href={safe ? href : "#"}
          className="text-sky underline decoration-sky/40 underline-offset-2 hover:decoration-sky"
          {...(safe && href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
        >
          {emphasize(m[1], `${keyBase}-${i}-t`)}
        </a>
      );
    }
    return <span key={`${keyBase}-${i}`}>{strongify(p, `${keyBase}-${i}`)}</span>;
  });
}

function strongify(text: string, keyBase: number | string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return emphasize(text, `${keyBase}`);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={`${keyBase}-${i}`} className="font-semibold text-snow/90">
        {emphasize(p.slice(2, -2), `${keyBase}-${i}-b`)}
      </strong>
    ) : (
      <span key={`${keyBase}-${i}`}>{emphasize(p, `${keyBase}-${i}`)}</span>
    )
  );
}

function emphasize(text: string, keyBase: number | string): ReactNode {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  if (parts.length === 1) return text;
  return parts.map((p, i) => {
    const isEm =
      (p.startsWith("*") && p.endsWith("*") && p.length > 2) ||
      (p.startsWith("_") && p.endsWith("_") && p.length > 2);
    return isEm ? (
      <em key={`${keyBase}-${i}`} className="text-snow/85">
        {p.slice(1, -1)}
      </em>
    ) : (
      <span key={`${keyBase}-${i}`}>{p}</span>
    );
  });
}

export function Markdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*(```|~~~)/.test(line)) {
      const fence = line.trim().slice(0, 3);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++}>
          <code>{buf.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const Tag = (`h${Math.min(level, 4)}`) as "h1";
      blocks.push(<Tag key={key++} className={`md-h${level}`}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }

    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i]
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <table key={key++}>
          <thead>
            <tr>{head?.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((r, j) => (
              <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }

    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2));
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="list-decimal">
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    blocks.push(<p key={key++}>{inline(line)}</p>);
    i++;
  }

  return <div className="md">{blocks}</div>;
}
