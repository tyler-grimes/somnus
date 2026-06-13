/**
 * cc.sh spend spool → spend_log. The cc.sh wrapper runs without DATABASE_URL
 * (deliberately scrubbed from its env), so it appends JSONL lines to the
 * workspace; this sweep ingests them every 10 minutes (scheduler.ts).
 * Subscription-billed sessions report ~$0 — these rows are observability
 * (sessions/day, repos touched) more than budget.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SpoolEntry {
  ts: string;
  usd: number;
  session_id: string | null;
  dir: string;
}

export function parseSpoolLines(raw: string): Array<{ entry: SpoolEntry; rawLine: string }> {
  const results: Array<{ entry: SpoolEntry; rawLine: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const o = JSON.parse(trimmed);
      if (typeof o.ts !== "string" || typeof o.usd !== "number") throw new Error("bad shape");
      results.push({
        entry: {
          ts: o.ts,
          usd: o.usd,
          session_id: o.session_id ?? null,
          dir: String(o.dir ?? ""),
        },
        rawLine: trimmed,
      });
    } catch {
      console.error("[cc-spend] dropping malformed line:", trimmed.slice(0, 200));
    }
  }
  return results;
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
    const raw = fs.readFileSync(file, "utf8");
    const pairs = parseSpoolLines(raw);
    let ok = 0;
    for (const { entry: e, rawLine } of pairs) {
      // Compute a deterministic UUID-shaped id from the raw line so that
      // re-ingesting the same line (crash recovery) is a no-op (db does
      // ON CONFLICT (id) DO NOTHING).
      const h = createHash("sha256").update(rawLine).digest("hex");
      const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      try {
        await logSpend({
          id,
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
    if (pairs.length > 0 && ok === 0) {
      // Wholesale failure (DB down?) — keep the file; orphan recovery retries
      throw new Error(`[cc-spend] all ${pairs.length} rows failed; keeping ${file} for retry`);
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
