import { describe, it, expect } from "vitest";
import { renderMarkdownBlocks, markdownToHtml } from "../utils/markdown";

describe("markdown fenced code blocks", () => {
  it("parses a simple fenced code block", () => {
    const blocks = renderMarkdownBlocks("```\nfoo\nbar\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "code-block", language: null, text: "foo\nbar" });
  });

  it("captures the language hint", () => {
    const blocks = renderMarkdownBlocks("```ts\nconst x = 1;\n```");
    expect(blocks[0]).toMatchObject({ kind: "code-block", language: "ts", text: "const x = 1;" });
  });

  it("does not treat inline backticks as a fence", () => {
    const blocks = renderMarkdownBlocks("Use `foo` here");
    expect(blocks.some(b => b.kind === "code-block")).toBe(false);
  });

  it("emits a <pre><code> wrapper in HTML", () => {
    const html = markdownToHtml("```\n<x>\n```");
    expect(html).toContain("<pre><code>&lt;x&gt;</code></pre>");
  });

  it("handles an unterminated fence by consuming the rest", () => {
    const blocks = renderMarkdownBlocks("```\nstill code\nmore code");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code-block", text: "still code\nmore code" });
  });
});

describe("markdown pipe tables", () => {
  it("parses a simple pipe table", () => {
    const md = "| Club | Yards |\n| --- | --- |\n| 7i | 150 |\n| 6i | 165 |";
    const blocks = renderMarkdownBlocks(md);
    expect(blocks).toHaveLength(1);
    const table = blocks[0];
    if (table.kind !== "table") throw new Error("expected table");
    expect(table.header.map(c => c.map(i => i.text).join(""))).toEqual(["Club", "Yards"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].map(c => c.map(i => i.text).join(""))).toEqual(["7i", "150"]);
  });

  it("captures column alignments", () => {
    const md = "| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |";
    const blocks = renderMarkdownBlocks(md);
    const table = blocks[0];
    if (table.kind !== "table") throw new Error("expected table");
    expect(table.alignments).toEqual(["left", "center", "right"]);
  });

  it("renders inline markdown inside cells", () => {
    const md = "| Name | Note |\n| --- | --- |\n| **Pro** | use `7i` |";
    const blocks = renderMarkdownBlocks(md);
    const table = blocks[0];
    if (table.kind !== "table") throw new Error("expected table");
    expect(table.rows[0][0][0]).toEqual({ type: "bold", text: "Pro" });
    expect(table.rows[0][1].some(i => i.type === "code" && i.text === "7i")).toBe(true);
  });

  it("does not parse a pipe paragraph without a separator", () => {
    const blocks = renderMarkdownBlocks("a | b | c");
    expect(blocks.every(b => b.kind !== "table")).toBe(true);
  });

  it("emits an HTML table", () => {
    const md = "| h1 | h2 |\n| --- | --- |\n| a | b |";
    const html = markdownToHtml(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>h1</th>");
    expect(html).toContain("<td>a</td>");
  });
});
