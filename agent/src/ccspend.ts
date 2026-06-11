/**
 * cc.sh spend spool → spend_log. The cc.sh wrapper runs without DATABASE_URL
 * (deliberately scrubbed from its env), so it appends JSONL lines to the
 * workspace; this sweep ingests them every 10 minutes (scheduler.ts).
 * Subscription-billed sessions report ~$0 — these rows are observability
 * (sessions/day, repos touched) more than budget.
 */
import fs from "node:fs";
import path from "node:path";
import { logSpend } from "./db.js";
import { config } from "./config.js";

export interface SpoolEntry {
  ts: string;
  usd: number;
  session_id: string | null;
  dir: string;
}

const SPOOL_PATH = path.join(
  config.workspaceDir || path.resolve(import.meta.dirname, "../../workspace"),
  ".cc-spend.jsonl",
);

export function parseSpoolLines(raw: string): SpoolEntry[] {
  const entries: SpoolEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.ts !== "string" || typeof o.usd !== "number") throw new Error("bad shape");
      entries.push({
        ts: o.ts,
        usd: o.usd,
        session_id: o.session_id ?? null,
        dir: String(o.dir ?? ""),
      });
    } catch {
      console.error("[cc-spend] dropping malformed line:", line.slice(0, 200));
    }
  }
  return entries;
}

/** Returns the number of entries ingested. Rename-then-read keeps concurrent
 *  cc.sh appends safe: they just start a fresh spool file. */
export async function sweepCcSpend(spoolPath: string = SPOOL_PATH): Promise<number> {
  if (!fs.existsSync(spoolPath)) return 0;
  const ingestPath = spoolPath + ".ingest";
  fs.renameSync(spoolPath, ingestPath);
  const entries = parseSpoolLines(fs.readFileSync(ingestPath, "utf8"));
  for (const e of entries) {
    await logSpend({
      model: "claude-code-session",
      purpose: `cc:${e.dir}${e.session_id ? ` ${e.session_id}` : ""}`,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: e.usd,
    });
  }
  fs.unlinkSync(ingestPath);
  return entries.length;
}
