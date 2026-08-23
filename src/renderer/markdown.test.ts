import { describe, expect, it } from "vitest";
import {
  isAllowedExternalHref,
  parseInlineMarkdown,
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
