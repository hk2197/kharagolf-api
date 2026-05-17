export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

export type TableAlign = "left" | "right" | "center" | null;

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; inlines: MarkdownInline[] }
  | { kind: "paragraph"; inlines: MarkdownInline[] }
  | { kind: "list-item"; ordered: boolean; marker: string; inlines: MarkdownInline[] }
  | { kind: "code-block"; language: string | null; text: string }
  | {
      kind: "table";
      header: MarkdownInline[][];
      rows: MarkdownInline[][][];
      alignments: TableAlign[];
    }
  | { kind: "spacer" };

const INLINE_RE = /(\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
const LINK_RE = /^\[([^\]]+)\]\(([^)\s]+)\)$/;
const FENCE_RE = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;

export function parseInlines(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let last = 0;
  text.replace(INLINE_RE, (match, _g, offset: number) => {
    if (offset > last) out.push({ type: "text", text: text.slice(last, offset) });
    const linkMatch = LINK_RE.exec(match);
    if (linkMatch) {
      out.push({ type: "link", text: linkMatch[1], href: linkMatch[2] });
    } else if (match.startsWith("**") && match.endsWith("**")) {
      out.push({ type: "bold", text: match.slice(2, -2) });
    } else if (match.startsWith("*") && match.endsWith("*")) {
      out.push({ type: "italic", text: match.slice(1, -1) });
    } else if (match.startsWith("`") && match.endsWith("`")) {
      out.push({ type: "code", text: match.slice(1, -1) });
    }
    last = offset + match.length;
    return match;
  });
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map(c => c.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") && !/^:?-{3,}:?$/.test(trimmed)) return false;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every(c => /^:?-{3,}:?$/.test(c));
}

function parseAlignments(sepLine: string): TableAlign[] {
  return splitTableRow(sepLine).map(c => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

export function renderMarkdownBlocks(md: string): MarkdownBlock[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push({ kind: "paragraph", inlines: parseInlines(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Fenced code block: ``` or ```lang ... ```
    const fenceOpen = FENCE_RE.exec(line);
    if (fenceOpen) {
      flushPara();
      const language = fenceOpen[1] ? fenceOpen[1] : null;
      const codeLines: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (FENCE_CLOSE_RE.test(lines[j].trimEnd())) { closed = true; break; }
        codeLines.push(lines[j]);
        j++;
      }
      blocks.push({ kind: "code-block", language, text: codeLines.join("\n") });
      i = closed ? j : j - 1;
      continue;
    }

    // Pipe table: header line + separator line + zero or more body rows.
    if (
      line.includes("|")
      && i + 1 < lines.length
      && isTableSeparator(lines[i + 1].trimEnd())
    ) {
      flushPara();
      const headerCells = splitTableRow(line);
      const alignments = parseAlignments(lines[i + 1].trimEnd());
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length) {
        const l = lines[j].trimEnd();
        if (l.trim() === "" || !l.includes("|")) break;
        rows.push(splitTableRow(l));
        j++;
      }
      blocks.push({
        kind: "table",
        header: headerCells.map(parseInlines),
        rows: rows.map(r => r.map(parseInlines)),
        alignments,
      });
      i = j - 1;
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      blocks.push({ kind: "spacer" });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, inlines: parseInlines(heading[2]) });
      continue;
    }
    const ulItem = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ulItem) {
      flushPara();
      blocks.push({ kind: "list-item", ordered: false, marker: "•", inlines: parseInlines(ulItem[1]) });
      continue;
    }
    const olItem = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (olItem) {
      flushPara();
      blocks.push({ kind: "list-item", ordered: true, marker: `${olItem[1]}.`, inlines: parseInlines(olItem[2]) });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => HTML_ESCAPE[c]);
}

function inlineToHtml(inline: MarkdownInline): string {
  switch (inline.type) {
    case "bold": return `<strong>${escapeHtml(inline.text)}</strong>`;
    case "italic": return `<em>${escapeHtml(inline.text)}</em>`;
    case "code": return `<code>${escapeHtml(inline.text)}</code>`;
    case "link": return `<a href="${escapeHtml(inline.href)}">${escapeHtml(inline.text)}</a>`;
    default: return escapeHtml(inline.text);
  }
}

function alignToCss(a: TableAlign): string {
  if (a === "left") return ' style="text-align:left"';
  if (a === "right") return ' style="text-align:right"';
  if (a === "center") return ' style="text-align:center"';
  return "";
}

export function markdownToHtml(md: string): string {
  const blocks = renderMarkdownBlocks(md);
  const out: string[] = [];
  let listOpen: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listOpen) { out.push(`</${listOpen}>`); listOpen = null; }
  };
  for (const block of blocks) {
    if (block.kind === "list-item") {
      const want = block.ordered ? "ol" : "ul";
      if (listOpen !== want) { closeList(); out.push(`<${want}>`); listOpen = want; }
      out.push(`<li>${block.inlines.map(inlineToHtml).join("")}</li>`);
      continue;
    }
    closeList();
    if (block.kind === "heading") {
      out.push(`<h${block.level}>${block.inlines.map(inlineToHtml).join("")}</h${block.level}>`);
    } else if (block.kind === "paragraph") {
      out.push(`<p>${block.inlines.map(inlineToHtml).join("")}</p>`);
    } else if (block.kind === "code-block") {
      out.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`);
    } else if (block.kind === "table") {
      const headHtml = block.header
        .map((cell, i) => `<th${alignToCss(block.alignments[i] ?? null)}>${cell.map(inlineToHtml).join("")}</th>`)
        .join("");
      const bodyHtml = block.rows
        .map(row => `<tr>${row
          .map((cell, i) => `<td${alignToCss(block.alignments[i] ?? null)}>${cell.map(inlineToHtml).join("")}</td>`)
          .join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
    }
  }
  closeList();
  return out.join("\n");
}
