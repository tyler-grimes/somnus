import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpoolLines } from "./ccspend.js";

test("parses valid JSONL lines", () => {
  const raw =
    `{"ts":"2026-06-11T20:00:00Z","usd":0.42,"session_id":"abc","dir":"/app/workspace/repos/x"}\n` +
    `{"ts":"2026-06-11T21:00:00Z","usd":0,"session_id":null,"dir":"/app/workspace/repos/y"}\n`;
  const entries = parseSpoolLines(raw);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].usd, 0.42);
  assert.equal(entries[0].session_id, "abc");
  assert.equal(entries[1].usd, 0);
  assert.equal(entries[1].session_id, null);
});

test("drops malformed lines, keeps good ones", () => {
  const raw =
    `not json at all\n` +
    `{"ts":"2026-06-11T20:00:00Z"}\n` + // missing usd → bad shape
    `{"ts":"2026-06-11T20:00:00Z","usd":1.5,"session_id":"s","dir":"/d"}\n` +
    `\n`; // blank line ignored
  const entries = parseSpoolLines(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].usd, 1.5);
});

test("empty input yields empty array", () => {
  assert.deepEqual(parseSpoolLines(""), []);
});
