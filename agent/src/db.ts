import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
pool.on('error', (err) => { console.error('[db] idle client error:', err); });

export async function logEpisode(e: {
  sessionId?: string;
  source: "telegram" | "cli" | "web" | "voice" | "ingestion" | "dream_cycle";
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  costUsd?: number;
  tokenInput?: number;
  tokenOutput?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO episodes (session_id, source, role, content, cost_usd, token_input, token_output)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.sessionId ?? null,
      e.source,
      e.role,
      e.content,
      e.costUsd ?? null,
      e.tokenInput ?? null,
      e.tokenOutput ?? null,
    ],
  );
}

export async function logSpend(s: {
  id?: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt?: string;
}): Promise<void> {
  if (s.id !== undefined) {
    await pool.query(
      `INSERT INTO spend_log (id, model, purpose, input_tokens, output_tokens, cost_usd, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.model, s.purpose, s.inputTokens, s.outputTokens, s.costUsd, s.createdAt ?? null],
    );
  } else {
    await pool.query(
      `INSERT INTO spend_log (model, purpose, input_tokens, output_tokens, cost_usd, created_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))`,
      [s.model, s.purpose, s.inputTokens, s.outputTokens, s.costUsd, s.createdAt ?? null],
    );
  }
}

export async function logFriction(f: {
  frictionType: "confusion" | "blocker" | "repeated_task" | "slow_path" | "failure";
  description: string;
  episodeId?: string;
  context?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO friction_events (friction_type, description, episode_id, context)
     VALUES ($1, $2, $3, $4)`,
    [f.frictionType, f.description, f.episodeId ?? null, JSON.stringify(f.context ?? {})],
  );
}

/** Budget gate: total spend since local midnight (timezone-aware). */
export async function spentTodayUsd(): Promise<number> {
  const res = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM spend_log
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1`,
    [config.timezone],
  );
  return Number(res.rows[0].total);
}
