import { describe, expect, it } from "vitest";
import {
  isAllowedExternalHref,
  parseInlineMarkdown,
  parsePlainTextAutolinks,
  parseSafeMarkdown,
} from "./markdown.js";

describe("safe markdown parser", () => {
  it("keeps raw html as text instead of executable markup", () => {
    const blocks = parseSafeMarkdown("Hello <script>alert('x')</script>");

    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", text: "Hello <script>alert('x')</script>" }],
      },
    ]);
  });

  it("only creates link tokens for explicitly allowed external schemes", () => {
    const tokens = parseInlineMarkdown(
      "[ok](https://example.com) [mail](mailto:user@example.com) [bad](javascript:alert(1)) [relative](/docs)",
    );

    expect(tokens).toContainEqual({
      type: "link",
      text: "ok",
      href: "https://example.com",
    });
    expect(tokens).toContainEqual({
      type: "link",
      text: "mail",
      href: "mailto:user@example.com",
    });
    expect(JSON.stringify(tokens)).not.toContain('"href":"javascript:');
    expect(JSON.stringify(tokens)).not.toContain('"href":"/docs"');
  });

  it("autolinks bare allowed URLs in inline markdown", () => {
    const tokens = parseInlineMarkdown(
      "Message link: https://rippling.slack.com/archives/C123/p123",
    );

    expect(tokens).toEqual([
      { type: "text", text: "Message link: " },
      {
        type: "link",
        text: "https://rippling.slack.com/archives/C123/p123",
        href: "https://rippling.slack.com/archives/C123/p123",
      },
    ]);
  });

  it("keeps trailing sentence punctuation out of bare URL hrefs", () => {
    const tokens = parseInlineMarkdown("See (https://example.com/path).");

    expect(tokens).toEqual([
      { type: "text", text: "See (" },
      {
        type: "link",
        text: "https://example.com/path",
        href: "https://example.com/path",
      },
      { type: "text", text: ")." },
    ]);
  });

  it("autolinks mailto URLs but not disallowed bare schemes", () => {
    const tokens = parseInlineMarkdown(
      "Email mailto:user@example.com but not javascript:alert(1) or file:///etc/passwd",
    );

    expect(tokens).toContainEqual({
      type: "link",
      text: "mailto:user@example.com",
      href: "mailto:user@example.com",
    });
    expect(JSON.stringify(tokens)).not.toContain('"href":"javascript:');
    expect(JSON.stringify(tokens)).not.toContain('"href":"file:');
  });

  it("does not autolink URLs inside code spans or fenced blocks", () => {
    expect(parseInlineMarkdown("`https://example.com`")).toEqual([
      { type: "code", text: "https://example.com" },
    ]);

    expect(parseSafeMarkdown("```\nhttps://example.com\n```")).toEqual([
      { type: "code", code: "https://example.com" },
    ]);
  });

  it("autolinks plain tool-card text without applying full markdown", () => {
    const tokens = parsePlainTextAutolinks(
      "**raw** output: https://example.com/logs",
    );

    expect(tokens).toEqual([
      { type: "text", text: "**raw** output: " },
      {
        type: "link",
        text: "https://example.com/logs",
        href: "https://example.com/logs",
      },
    ]);
  });

  it("parses common chat markdown blocks without using raw html", () => {
    const blocks = parseSafeMarkdown(
      [
        "## Heading",
        "",
        "- **bold** item",
        "- `code` item",
        "",
        "```ts",
        "const value = '<b>text</b>';",
        "```",
      ].join("\n"),
    );

    expect(blocks[0]).toMatchObject({ type: "heading", level: 2 });
    expect(blocks[1]).toMatchObject({ type: "list" });
    expect(blocks[2]).toEqual({
      type: "code",
      language: "ts",
      code: "const value = '<b>text</b>';",
    });
  });

  it("parses GFM pipe tables with alignment and safe inline tokens", () => {
    const blocks = parseSafeMarkdown(
      [
        "Name | Details | Link",
        ":--- | :---: | ---:",
        "Ada | **bold** and `a|b` | [docs](https://example.com)",
        "Grace | escaped \\| pipe | plain",
      ].join("\n"),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "table",
      alignments: ["left", "center", "right"],
    });
    const table = blocks[0];
    if (table?.type !== "table") throw new Error("Expected a table");
    expect(table.rows[0]?.[1]).toEqual([
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " and " },
      { type: "code", text: "a|b" },
    ]);
    expect(table.rows[1]?.[1]).toEqual([
      { type: "text", text: "escaped | pipe" },
    ]);
    expect(table.rows[0]?.[2]).toContainEqual({
      type: "link",
      text: "docs",
      href: "https://example.com",
    });
  });

  it("leaves malformed tables as ordinary text", () => {
    const blocks = parseSafeMarkdown(
      ["One | Two", "--- | not-a-delimiter", "still ordinary"].join("\n"),
    );

    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "text",
            text: "One | Two --- | not-a-delimiter still ordinary",
          },
        ],
      },
    ]);
  });

  it("allows only http, https, and mailto external hrefs", () => {
    expect(isAllowedExternalHref("https://example.com")).toBe(true);
    expect(isAllowedExternalHref("http://example.com")).toBe(true);
    expect(isAllowedExternalHref("mailto:user@example.com")).toBe(true);
    expect(isAllowedExternalHref("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalHref("/relative")).toBe(false);
  });
});
