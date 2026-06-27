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

  it("allows only http, https, and mailto external hrefs", () => {
    expect(isAllowedExternalHref("https://example.com")).toBe(true);
    expect(isAllowedExternalHref("http://example.com")).toBe(true);
    expect(isAllowedExternalHref("mailto:user@example.com")).toBe(true);
    expect(isAllowedExternalHref("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalHref("/relative")).toBe(false);
  });
});
