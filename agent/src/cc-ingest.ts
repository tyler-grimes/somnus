import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";

const CLAUDE_PROJECTS_DIR = join(process.env.HOME ?? "/root", ".claude", "projects");

function walkJsonl(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...walkJsonl(fullPath));
      } else if (stat.isFile() && extname(entry) === ".jsonl") {
        results.push(fullPath);
      }
    } catch {
      // skip unreadable entries
    }
  }
  return results;
}

export function findNewSessions(knownIds: Set<string>): string[] {
  const allPaths = walkJsonl(CLAUDE_PROJECTS_DIR);
  return allPaths.filter((p) => !knownIds.has(basename(p, ".jsonl")));
}

function extractText(val: unknown): string | null {
  if (typeof val === "string") return val || null;
  if (Array.isArray(val)) {
    const block = (val as Array<Record<string, unknown>>).find((b) => b.type === "text");
    return block ? ((block.text as string) ?? null) : null;
  }
  return null;
}

export interface ParsedSession {
  sessionId: string;
  jsonlPath: string;
  title: string | null;
  taskPrompt: string | null;
  resultSummary: string | null;
}

export function parseSession(jsonlPath: string): ParsedSession {
  const sessionId = basename(jsonlPath, ".jsonl");
  let title: string | null = null;
  let taskPrompt: string | null = null;
  let lastAssistantText: string | null = null;

  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return { sessionId, jsonlPath, title, taskPrompt, resultSummary: null };
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type as string | undefined;

    if (type === "ai-title" && title === null) {
      title = (obj.title as string) ?? null;
    } else if (type === "user" && taskPrompt === null) {
      const msg = obj.message as Record<string, unknown> | undefined;
      taskPrompt = extractText(msg?.content ?? obj.content);
    } else if (type === "assistant") {
      const msg = obj.message as Record<string, unknown> | undefined;
      const text = extractText(msg?.content ?? obj.content);
      if (text !== null) lastAssistantText = text;
    }
  }

  return {
    sessionId,
    jsonlPath,
    title,
    taskPrompt,
    resultSummary: lastAssistantText ? lastAssistantText.slice(0, 2000) : null,
  };
}

export async function ingestNewSessions(): Promise<number> {
  const { pool } = await import("./db.js");
  const res = await pool.query<{ session_id: string }>("SELECT session_id FROM cc_sessions");
  const knownIds = new Set(res.rows.map((r) => r.session_id));

  const newPaths = findNewSessions(knownIds);
  if (newPaths.length === 0) return 0;

  let count = 0;
  for (const jsonlPath of newPaths) {
    const parsed = parseSession(jsonlPath);
    await pool.query(
      `INSERT INTO cc_sessions (session_id, title, task_prompt, result_summary, jsonl_path)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id) DO NOTHING`,
      [parsed.sessionId, parsed.title, parsed.taskPrompt, parsed.resultSummary, parsed.jsonlPath],
    );
    count++;
  }
  return count;
}
