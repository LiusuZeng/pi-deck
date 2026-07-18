import assert from "node:assert/strict";
import { it as test } from "vitest";
import {
  JsonlFramingParser,
  type JsonlFramingParserOptions,
  type JsonlParseError,
} from "./jsonlClient.js";
import type { JsonValue } from "./types.js";

function makeParser(
  options: Pick<JsonlFramingParserOptions, "maxLineBytes"> = {},
): {
  parser: JsonlFramingParser;
  records: JsonValue[];
  errors: JsonlParseError[];
} {
  const records: JsonValue[] = [];
  const errors: JsonlParseError[] = [];
  const parser = new JsonlFramingParser({
    onRecord: (record) => records.push(record),
    onMalformed: (error) => errors.push(error),
    ...options,
  });
  return { parser, records, errors };
}

test("JSONL parser handles records split across chunks", () => {
  const { parser, records, errors } = makeParser();
  parser.push('{"type":"response","id":"1","result":"hel');
  assert.equal(records.length, 0);
  parser.push('lo"}\n');
  assert.equal(errors.length, 0);
  assert.deepEqual(records, [{ type: "response", id: "1", result: "hello" }]);
});

test("JSONL parser handles many records in one chunk in order", () => {
  const { parser, records, errors } = makeParser();
  const count = 10_000;
  parser.push(
    Array.from({ length: count }, (_, id) => JSON.stringify({ id })).join(
      "\n",
    ) + "\n",
  );
  assert.equal(errors.length, 0);
  assert.equal(records.length, count);
  assert.deepEqual(records[0], { id: 0 });
  assert.deepEqual(records.at(-1), { id: count - 1 });
});

test("JSONL parser treats embedded U+2028 and U+2029 as JSON string content, not framing", () => {
  const { parser, records, errors } = makeParser();
  const text = `before\u2028middle\u2029after`;
  const line = JSON.stringify({ type: "unicode", text });
  const splitAt = line.indexOf("middle");
  parser.push(Buffer.from(line.slice(0, splitAt), "utf8"));
  parser.push(Buffer.from(line.slice(splitAt) + "\n", "utf8"));
  assert.equal(errors.length, 0);
  assert.deepEqual(records, [{ type: "unicode", text }]);
});

test("JSONL parser reports malformed JSON records", () => {
  const { parser, records, errors } = makeParser();
  parser.push('{ this is not json }\n{"ok":true}\n');
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { ok: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Expected|Unexpected|JSON/i);
});

test("JSONL parser bounds an oversized unterminated line and resumes after its LF", () => {
  const { parser, records, errors } = makeParser({ maxLineBytes: 16 });
  parser.push('{"text":"this is too long');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exceeds maximum size of 16 bytes/i);
  assert.equal(errors[0].line, "");

  parser.push(' and is discarded"}\n{"ok":true}\n');
  assert.equal(errors.length, 1);
  assert.deepEqual(records, [{ ok: true }]);
});

test("JSONL parser accepts the exact byte limit and rejects one byte over it", () => {
  const exactLine = JSON.stringify("é");
  const exactBytes = Buffer.byteLength(exactLine, "utf8");
  const { parser, records, errors } = makeParser({
    maxLineBytes: exactBytes,
  });

  const exactChunk = Buffer.from(`${exactLine}\n`, "utf8");
  parser.push(exactChunk.subarray(0, 2)); // Split the two-byte "é".
  parser.push(exactChunk.subarray(2));
  parser.push(`${exactLine} \n`);

  assert.deepEqual(records, ["é"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, new RegExp(`${exactBytes} bytes`));
});
