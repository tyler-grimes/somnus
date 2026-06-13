import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { skillsBase } from "./skills.js";

test("skillsBase prefers an explicit SKILLS_DIR (the persistent volume in prod)", () => {
  assert.equal(skillsBase("/home/node/.claude/somnus", "/app"), "/home/node/.claude/somnus");
});

test("skillsBase falls back to repo-root .claude when SKILLS_DIR is unset", () => {
  assert.equal(skillsBase("", "/repo"), path.join("/repo", ".claude"));
});
