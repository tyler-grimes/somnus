import express from 'express';
import { Pool } from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
const PORT = 3001;
const TZ = process.env.TZ ?? 'America/Denver';
const QUEUES = ['dream-cycle', 'gap-analysis', 'morning-briefing', 'cc-spend-sweep', 'cc-ingest-sweep'];

app.use(express.static(join(__dirname, '../public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/api/episodes', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, session_id, source, role,
             left(content, 300) AS content,
             tool_name, cost_usd, created_at
      FROM episodes
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/cc-sessions', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT session_id, title,
             left(task_prompt, 200)    AS task_prompt,
             left(result_summary, 300) AS result_summary,
             jsonl_path, ingested_at
      FROM cc_sessions
      ORDER BY ingested_at DESC
      LIMIT 20
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/memory', async (_req, res) => {
  try {
    const [total, recent24h, recentFacts] = await Promise.all([
      pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM facts WHERE superseded_at IS NULL'),
      pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM facts WHERE superseded_at IS NULL AND created_at >= now() - INTERVAL '24 hours'"),
      pool.query(`
        SELECT kind, left(claim, 200) AS claim, visibility, confidence, source, created_at
        FROM facts
        WHERE superseded_at IS NULL
        ORDER BY created_at DESC
        LIMIT 20
      `),
    ]);
    res.json({
      total: total.rows[0].n,
      added_24h: recent24h.rows[0].n,
      recent: recentFacts.rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/spend', async (_req, res) => {
  try {
    const [today, week] = await Promise.all([
      pool.query<{ today_cost: number }>(`
        SELECT COALESCE(SUM(cost_usd), 0)::float AS today_cost
        FROM spend_log
        WHERE created_at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1
      `, [TZ]),
      pool.query(`
        SELECT
          (date_trunc('day', created_at AT TIME ZONE $1))::date AS day,
          COALESCE(SUM(cost_usd), 0)::float                     AS cost,
          COALESCE(SUM(input_tokens + output_tokens), 0)::int    AS tokens
        FROM spend_log
        WHERE created_at >= now() - INTERVAL '7 days'
        GROUP BY 1
        ORDER BY 1
      `, [TZ]),
    ]);
    res.json({
      today: today.rows[0].today_cost,
      week: week.rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/scheduler', async (_req, res) => {
  try {
    const [jobs, schedules] = await Promise.all([
      pool.query(`
        WITH ranked AS (
          SELECT name, state, completedon, startedon, createdon,
                 row_number() OVER (PARTITION BY name ORDER BY createdon DESC) AS rn
          FROM pgboss.job
          WHERE name = ANY($1)
        )
        SELECT name, state, completedon, startedon, createdon
        FROM ranked
        WHERE rn = 1
      `, [QUEUES]),
      pool.query(`
        SELECT name, cron, timezone
        FROM pgboss.schedule
        WHERE name = ANY($1)
      `, [QUEUES]),
    ]);

    const jobMap = new Map(jobs.rows.map((r: Record<string, unknown>) => [r['name'], r]));
    const schedMap = new Map(schedules.rows.map((r: Record<string, unknown>) => [r['name'], r]));

    res.json(QUEUES.map(name => {
      const job = jobMap.get(name) as Record<string, unknown> | undefined;
      const sched = schedMap.get(name) as Record<string, unknown> | undefined;
      return {
        name,
        cron: sched?.['cron'] ?? null,
        timezone: sched?.['timezone'] ?? null,
        state: job?.['state'] ?? null,
        completedon: job?.['completedon'] ?? null,
        startedon: job?.['startedon'] ?? null,
        createdon: job?.['createdon'] ?? null,
      };
    }));
  } catch (err) {
    // pgboss schema may not exist yet if agent hasn't started
    res.json(QUEUES.map(name => ({ name, state: null, error: String(err) })));
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] http://0.0.0.0:${PORT}`);
});
