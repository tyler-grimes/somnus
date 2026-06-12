import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSession } from "./cc-ingest.js";

function withTempJsonl(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cc-ingest-test-"));
  const path = join(dir, "550e8400-e29b-41d4-a716-446655440000.jsonl");
  writeFileSync(path, content);
  try {
    fn(path);
  } finally {
    try { unlinkSync(path); } catch { /* ignore */ }
    try { rmdirSync(dir); } catch { /* ignore */ }
  }
}

describe("parseSession", () => {
  it("extracts title, taskPrompt, and resultSummary from a normal session", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "Fix the bug in login flow" } }),
      JSON.stringify({ type: "ai-title", title: "Fix login bug" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I've identified the issue in auth.ts" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done! The fix is committed." }] } }),
    ].join("\n");

    withTempJsonl(lines, (path) => {
      const result = parseSession(path);
      assert.equal(result.title, "Fix login bug");
      assert.equal(result.taskPrompt, "Fix the bug in login flow");
      assert.equal(result.resultSummary, "Done! The fix is committed.");
      assert.equal(result.sessionId, "550e8400-e29b-41d4-a716-446655440000");
    });
  });

  it("returns null title when ai-title is missing", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "Add tests for the auth module" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Tests added." }] } }),
    ].join("\n");

    withTempJsonl(lines, (path) => {
      const result = parseSession(path);
      assert.equal(result.title, null);
      assert.equal(result.taskPrompt, "Add tests for the auth module");
      assert.equal(result.resultSummary, "Tests added.");
    });
  });

  it("handles empty file gracefully", () => {
    withTempJsonl("", (path) => {
      const result = parseSession(path);
      assert.equal(result.title, null);
      assert.equal(result.taskPrompt, null);
      assert.equal(result.resultSummary, null);
    });
  });

  it("truncates resultSummary to 2000 chars", () => {
    const longText = "a".repeat(3000);
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: longText }] } }),
    ].join("\n");

    withTempJsonl(lines, (path) => {
      const result = parseSession(path);
      assert.equal(result.resultSummary?.length, 2000);
    });
  });

  it("uses last assistant message as resultSummary", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "First response" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Final response" }] } }),
    ].join("\n");

    withTempJsonl(lines, (path) => {
      const result = parseSession(path);
      assert.equal(result.resultSummary, "Final response");
    });
  });

  it("handles array content blocks with tool_use mixed in", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Refactor the auth module" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "auth.ts" } },
            { type: "text", text: "Refactoring complete." },
          ],
        },
      }),
    ].join("\n");

    withTempJsonl(lines, (path) => {
      const result = parseSession(path);
      assert.equal(result.taskPrompt, "Refactor the auth module");
      assert.equal(result.resultSummary, "Refactoring complete.");
    });
  });

  it("skips malformed JSON lines without throwing", () => {
    const lines = [
      "not-json",
      JSON.stringify({ type: "ai-title", title: "Valid session" }),
      "{broken",
      JSON.stringify({ type: "user", message: { content: "Do the thing" } }),
    ].join("\n");

    withTempJsonl(lines, (path) => {
      const result = parseSession(path);
      assert.equal(result.title, "Valid session");
      assert.equal(result.taskPrompt, "Do the thing");
    });
  });
});
