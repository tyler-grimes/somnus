/**
 * cc.sh spend spool → spend_log. The cc.sh wrapper runs without DATABASE_URL
 * (deliberately scrubbed from its env), so it appends JSONL lines to the
 * workspace; this sweep ingests them every 10 minutes (scheduler.ts).
 * Subscription-billed sessions report ~$0 — these rows are observability
 * (sessions/day, repos touched) more than budget.
 */
import fs from "node:fs";
import path from "node:path";

export interface SpoolEntry {
  ts: string;
  usd: number;
  session_id: string | null;
  dir: string;
}

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
 *  cc.sh appends safe: they just start a fresh spool file. A leftover
 *  .ingest file (crash between rename and unlink) is recovered first;
 *  individual failed rows are logged and dropped; a wholesale failure (DB
 *  down) keeps the file for retry. */
export async function sweepCcSpend(spoolPath?: string): Promise<number> {
  const { logSpend } = await import("./db.js");
  const { config } = await import("./config.js");
  const resolvedPath = spoolPath ?? path.join(
    config.workspaceDir || path.resolve(import.meta.dirname, "../../workspace"),
    ".cc-spend.jsonl",
  );
  const ingestPath = resolvedPath + ".ingest";
  let ingested = 0;

  const ingestFile = async (file: string): Promise<void> => {
    const entries = parseSpoolLines(fs.readFileSync(file, "utf8"));
    let ok = 0;
    for (const e of entries) {
      try {
        await logSpend({
          model: "claude-code-session",
          purpose: `cc:${e.dir}${e.session_id ? ` ${e.session_id}` : ""}`,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: e.usd,
          createdAt: e.ts,
        });
        ok++;
        ingested++;
      } catch (err) {
        console.error("[cc-spend] logSpend failed:", err);
      }
    }
    if (entries.length > 0 && ok === 0) {
      // Wholesale failure (DB down?) — keep the file; orphan recovery retries
      throw new Error(`[cc-spend] all ${entries.length} rows failed; keeping ${file} for retry`);
    }
    fs.unlinkSync(file);
  };

  // Recover a file orphaned by a crash between rename and unlink
  if (fs.existsSync(ingestPath)) await ingestFile(ingestPath);

  if (fs.existsSync(resolvedPath)) {
    fs.renameSync(resolvedPath, ingestPath);
    await ingestFile(ingestPath);
  }
  return ingested;
}
