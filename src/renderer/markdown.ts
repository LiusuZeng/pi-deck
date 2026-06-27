export type InlineToken =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: InlineToken[] }
  | { type: "link"; text: string; href: string };

export type MarkdownBlock =
  | { type: "paragraph"; children: InlineToken[] }
  | { type: "heading"; level: 1 | 2 | 3; children: InlineToken[] }
  | { type: "list"; items: InlineToken[][] }
  | { type: "quote"; children: InlineToken[] }
  | { type: "code"; code: string; language?: string };

export function parseSafeMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraphLines: string[] = [];
  let listItems: InlineToken[][] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push({
      type: "paragraph",
      children: parseInlineMarkdown(paragraphLines.join(" ")),
    });
    paragraphLines = [];
  };

  const flushList = (): void => {
    if (listItems.length === 0) {
      return;
    }
    blocks.push({ type: "list", items: listItems });
    listItems = [];
  };

  const flushTextBlocks = (): void => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = line.match(/^```([^`]*)$/);

    if (fence !== null) {
      flushTextBlocks();
      const rawLanguage = (fence[1] ?? "").trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length) {
        const codeLine = lines[index] ?? "";
        if (codeLine.startsWith("```")) {
          break;
        }
        codeLines.push(codeLine);
        index += 1;
      }
      const block: MarkdownBlock = {
        type: "code",
        code: codeLines.join("\n"),
      };
      if (rawLanguage.length > 0) {
        block.language = rawLanguage.slice(0, 32);
      }
      blocks.push(block);
      continue;
    }

    if (line.trim().length === 0) {
      flushTextBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading !== null) {
      flushTextBlocks();
      blocks.push({
        type: "heading",
        level: heading[1]?.length as 1 | 2 | 3,
        children: parseInlineMarkdown(heading[2] ?? ""),
      });
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet !== null) {
      flushParagraph();
      listItems.push(parseInlineMarkdown(bullet[1] ?? ""));
      continue;
    }

    const quote = line.match(/^>\s?(.+)$/);
    if (quote !== null) {
      flushTextBlocks();
      blocks.push({
        type: "quote",
        children: parseInlineMarkdown(quote[1] ?? ""),
      });
      continue;
    }

    flushList();
    paragraphLines.push(line.trim());
  }

  flushTextBlocks();
  return blocks;
}

export function parseInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;

  const pushText = (value: string): void => {
    if (value.length === 0) {
      return;
    }
    const last = tokens[tokens.length - 1];
    if (last?.type === "text") {
      last.text += value;
      return;
    }
    tokens.push({ type: "text", text: value });
  };

  while (cursor < text.length) {
    const nextCode = text.indexOf("`", cursor);
    const nextStrong = text.indexOf("**", cursor);
    const nextLink = text.indexOf("[", cursor);
    const next = smallestNonNegative(nextCode, nextStrong, nextLink);

    if (next === -1) {
      pushText(text.slice(cursor));
      break;
    }

    if (next > cursor) {
      pushText(text.slice(cursor, next));
      cursor = next;
    }

    if (next === nextCode) {
      const close = text.indexOf("`", cursor + 1);
      if (close === -1) {
        pushText(text[cursor] ?? "");
        cursor += 1;
        continue;
      }
      tokens.push({ type: "code", text: text.slice(cursor + 1, close) });
      cursor = close + 1;
      continue;
    }

    if (next === nextStrong) {
      const close = text.indexOf("**", cursor + 2);
      if (close === -1) {
        pushText(text.slice(cursor, cursor + 2));
        cursor += 2;
        continue;
      }
      tokens.push({
        type: "strong",
        children: parseInlineMarkdown(text.slice(cursor + 2, close)),
      });
      cursor = close + 2;
      continue;
    }

    const closeText = text.indexOf("]", cursor + 1);
    const openHref = closeText === -1 ? -1 : text.indexOf("(", closeText + 1);
    const closeHref = openHref === -1 ? -1 : text.indexOf(")", openHref + 1);
    if (closeText === -1 || openHref !== closeText + 1 || closeHref === -1) {
      pushText(text[cursor] ?? "");
      cursor += 1;
      continue;
    }

    const label = text.slice(cursor + 1, closeText);
    const href = text.slice(openHref + 1, closeHref).trim();
    if (isAllowedExternalHref(href)) {
      tokens.push({ type: "link", text: label, href });
    } else {
      pushText(text.slice(cursor, closeHref + 1));
    }
    cursor = closeHref + 1;
  }

  return tokens;
}

export function isAllowedExternalHref(href: string): boolean {
  try {
    const url = new URL(href);
    return (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function smallestNonNegative(...values: number[]): number {
  const candidates = values.filter((value) => value >= 0);
  return candidates.length === 0 ? -1 : Math.min(...candidates);
}
