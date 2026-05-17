export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string };

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; inlines: MarkdownInline[] }
  | { kind: "paragraph"; inlines: MarkdownInline[] }
  | { kind: "list-item"; ordered: boolean; marker: string; inlines: MarkdownInline[] }
  | { kind: "spacer" };

const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;

export function parseInlines(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let last = 0;
  text.replace(INLINE_RE, (match, _g, offset: number) => {
    if (offset > last) out.push({ type: "text", text: text.slice(last, offset) });
    if (match.startsWith("**") && match.endsWith("**")) {
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

export function parseMarkdownBlocks(md: string): MarkdownBlock[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push({ kind: "paragraph", inlines: parseInlines(para.join(" ")) });
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
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
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => HTML_ESCAPE[c]);
}

function inlineToHtml(inline: MarkdownInline): string {
  switch (inline.type) {
    case "bold": return `<strong>${escapeHtml(inline.text)}</strong>`;
    case "italic": return `<em>${escapeHtml(inline.text)}</em>`;
    case "code": return `<code>${escapeHtml(inline.text)}</code>`;
    default: return escapeHtml(inline.text);
  }
}

export function markdownToHtml(md: string): string {
  const blocks = parseMarkdownBlocks(md);
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
    }
  }
  closeList();
  return out.join("\n");
}
