/**
 * Morning briefing — 08:00 daily: active commitments + open threads from the
 * latest daily reflection page + yesterday's spend, pushed to Telegram.
 */
import { logEpisode, pool } from "./db.js";

export async function buildMorningBriefing(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`☀️ Somnus — ${today}`];

  const commitments = await pool.query(
    `SELECT claim, valid_until FROM facts
      WHERE kind = 'commitment' AND superseded_at IS NULL
        AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
      ORDER BY valid_until ASC NULLS LAST, notability DESC
      LIMIT 10`,
  );
  if (commitments.rowCount) {
    lines.push("\nCommitments:");
    for (const c of commitments.rows) {
      const due = c.valid_until ? ` (by ${c.valid_until.toISOString().slice(0, 10)})` : "";
      lines.push(`• ${c.claim}${due}`);
    }
  }

  const daily = await pool.query(
    `SELECT compiled_truth FROM pages
      WHERE type = 'daily' AND deleted_at IS NULL AND compiled_truth IS NOT NULL
      ORDER BY effective_date DESC LIMIT 1`,
  );
  if (daily.rowCount) {
    const text: string = daily.rows[0].compiled_truth;
    const idx = text.indexOf("Open threads:");
    if (idx >= 0) {
      const threads = text
        .slice(idx + "Open threads:".length)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
        .slice(0, 6);
      if (threads.length) {
        lines.push("\nOpen threads:");
        for (const t of threads) lines.push(`• ${t.slice(2)}`);
      }
    }
  }

  const spend = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend_log
      WHERE created_at >= date_trunc('day', now()) - interval '1 day'
        AND created_at < date_trunc('day', now())`,
  );
  const spent = Number(spend.rows[0].total);
  if (spent > 0) lines.push(`\nYesterday's model spend: $${spent.toFixed(2)}`);

  if (lines.length === 1) lines.push("\nNo open commitments or threads. Clean slate.");

  const briefing = lines.join("\n");
  await logEpisode({ source: "dream_cycle", role: "system", content: briefing });
  return briefing;
}
