import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpoolLines } from "./ccspend.js";

test("parses valid JSONL lines", () => {
  const raw =
    `{"ts":"2026-06-11T20:00:00Z","usd":0.42,"session_id":"abc","dir":"/app/workspace/repos/x"}\n` +
    `{"ts":"2026-06-11T21:00:00Z","usd":0,"session_id":null,"dir":"/app/workspace/repos/y"}\n`;
  const pairs = parseSpoolLines(raw);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].entry.usd, 0.42);
  assert.equal(pairs[0].entry.session_id, "abc");
  assert.equal(pairs[1].entry.usd, 0);
  assert.equal(pairs[1].entry.session_id, null);
});

test("drops malformed lines, keeps good ones", () => {
  const raw =
    `not json at all\n` +
    `{"ts":"2026-06-11T20:00:00Z"}\n` + // missing usd → bad shape
    `{"ts":"2026-06-11T20:00:00Z","usd":1.5,"session_id":"s","dir":"/d"}\n` +
    `\n`; // blank line ignored
  const pairs = parseSpoolLines(raw);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].entry.usd, 1.5);
});

test("empty input yields empty array", () => {
  assert.deepEqual(parseSpoolLines(""), []);
});
