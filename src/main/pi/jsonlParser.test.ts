import assert from "node:assert/strict";
import { it as test } from "vitest";
import { JsonlFramingParser, type JsonlParseError } from "./jsonlClient.js";
import type { JsonValue } from "./types.js";

function makeParser(): {
  parser: JsonlFramingParser;
  records: JsonValue[];
  errors: JsonlParseError[];
} {
  const records: JsonValue[] = [];
  const errors: JsonlParseError[] = [];
  const parser = new JsonlFramingParser({
    onRecord: (record) => records.push(record),
    onMalformed: (error) => errors.push(error),
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

test("JSONL parser handles multiple records in one chunk", () => {
  const { parser, records, errors } = makeParser();
  parser.push('{"type":"one"}\n{"type":"two"}\n');
  assert.equal(errors.length, 0);
  assert.deepEqual(records, [{ type: "one" }, { type: "two" }]);
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
