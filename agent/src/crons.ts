/**
 * User-defined crons: persistence + due-matching. The pure helpers
 * (isValidCron, dueSlot) carry the scheduling logic and are unit-tested
 * without a DB. The ticker (scheduler.ts) and the SDK tools (scheduler-tools.ts)
 * are the only callers of the async DB functions.
 */
import { CronExpressionParser } from "cron-parser";
import { config } from "./config.js";
import { pool } from "./db.js";

export const MAX_CRONS = 25;

export interface CronRow {
  id: string;
  name: string;
  cron_expr: string;
  prompt: string;
  tz: string;
  enabled: boolean;
  last_run_at: string | Date | null;
}

export function isValidCron(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure due-check. Returns the most-recent scheduled slot <= now if that slot is
 * newer than lastRunAt, else null. Invalid expressions return null (never throw).
 * Running only the most-recent slot means a missed tick fires once, no backlog.
 */
export function dueSlot(cronExpr: string, tz: string, lastRunAt: Date | null, now: Date): Date | null {
  let slot: Date;
  try {
    const it = CronExpressionParser.parse(cronExpr, { currentDate: now, tz });
    slot = it.prev().toDate();
  } catch {
    return null;
  }
  if (!lastRunAt || slot.getTime() > lastRunAt.getTime()) return slot;
  return null;
}

export async function addCron(input: {
  name: string;
  cronExpr: string;
  prompt: string;
  tz?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!isValidCron(input.cronExpr)) {
    return { ok: false, error: `invalid cron expression: "${input.cronExpr}"` };
  }
  const count = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_crons WHERE enabled`);
  if ((count.rows[0]?.n ?? 0) >= MAX_CRONS) {
    return { ok: false, error: `cron limit reached (${MAX_CRONS}) — cancel one first` };
  }
  try {
    await pool.query(
      `INSERT INTO user_crons (name, cron_expr, prompt, tz) VALUES ($1, $2, $3, $4)`,
      [input.name, input.cronExpr, input.prompt, input.tz ?? config.timezone],
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("user_crons_name_key") || msg.toLowerCase().includes("duplicate")) {
      return { ok: false, error: `a cron named "${input.name}" already exists` };
    }
    return { ok: false, error: msg };
  }
}

export async function listCrons(): Promise<CronRow[]> {
  const res = await pool.query<CronRow>(
    `SELECT id, name, cron_expr, prompt, tz, enabled, last_run_at
       FROM user_crons ORDER BY enabled DESC, name`,
  );
  return res.rows;
}

export async function cancelCron(name: string): Promise<boolean> {
  const res = await pool.query(`DELETE FROM user_crons WHERE name = $1`, [name]);
  return (res.rowCount ?? 0) > 0;
}

export async function dueCrons(now: Date): Promise<Array<{ row: CronRow; slot: Date }>> {
  const res = await pool.query<CronRow>(
    `SELECT id, name, cron_expr, prompt, tz, enabled, last_run_at FROM user_crons WHERE enabled`,
  );
  const out: Array<{ row: CronRow; slot: Date }> = [];
  for (const row of res.rows) {
    const last = row.last_run_at ? new Date(row.last_run_at) : null;
    const slot = dueSlot(row.cron_expr, row.tz, last, now);
    if (slot) out.push({ row, slot });
  }
  return out;
}

export async function markRan(id: string, slot: Date): Promise<void> {
  await pool.query(`UPDATE user_crons SET last_run_at = $2 WHERE id = $1`, [id, slot.toISOString()]);
}
