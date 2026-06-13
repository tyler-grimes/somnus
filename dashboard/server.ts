import express from 'express';
import { Pool } from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildGraph } from './graph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json({ limit: '64kb' }));
const CHAT_TOKEN = process.env.CHAT_TOKEN ?? '';
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
          SELECT name, state,
                 completed_on AS completedon,
                 started_on   AS startedon,
                 created_on   AS createdon,
                 row_number() OVER (PARTITION BY name ORDER BY created_on DESC) AS rn
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

app.get('/api/graph', async (_req, res) => {
  try {
    const [nodesQ, linksQ] = await Promise.all([
      pool.query(`SELECT id, slug, type, title, emotional_weight FROM pages WHERE deleted_at IS NULL`),
      pool.query(`SELECT from_page_id AS source, to_page_id AS target, link_type AS type FROM edges WHERE valid_until IS NULL`),
    ]);
    res.json(buildGraph(nodesQ.rows as any, linksQ.rows as any));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/api/page/:id', async (req, res) => {
  const { id } = req.params;
  if (!PAGE_ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const pageQ = await pool.query(
      `SELECT type, title, compiled_truth FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (pageQ.rowCount === 0) return res.status(404).json({ error: 'not found' });
    const [factQ, linkQ] = await Promise.all([
      pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM facts WHERE page_id = $1 AND superseded_at IS NULL`,
        [id],
      ),
      pool.query(
        `SELECT p.id, p.title, p.type, e.link_type AS "linkType", (e.from_page_id = $1) AS outgoing
           FROM edges e
           JOIN pages p ON p.id = CASE WHEN e.from_page_id = $1 THEN e.to_page_id ELSE e.from_page_id END
          WHERE (e.from_page_id = $1 OR e.to_page_id = $1) AND e.valid_until IS NULL AND p.deleted_at IS NULL`,
        [id],
      ),
    ]);
    const page = pageQ.rows[0] as { type: string; title: string; compiled_truth: string | null };
    const ct = page.compiled_truth ?? '';
    res.json({
      title: page.title,
      type: page.type,
      compiledTruth: ct.length > 400 ? ct.slice(0, 400) + '…' : ct,
      factCount: factQ.rows[0].n,
      links: linkQ.rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/chat', async (req, res) => {
  if (CHAT_TOKEN && req.get('x-somnus-token') !== CHAT_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const text = (req.body?.text ?? '').toString().trim();
  if (!text) return res.status(400).json({ error: 'empty message' });
  if (text.length > 4000) return res.status(400).json({ error: 'message too long' });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO web_chat (prompt) VALUES ($1) RETURNING id`, [text]);
    res.json({ id: rows[0].id });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// /history MUST be registered before /:id — Express matches in order, and
// otherwise "history" would be captured as an :id (invalid UUID → 500).
app.get('/api/chat/history', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT prompt, reply, status, created_at FROM web_chat
       ORDER BY created_at DESC LIMIT 20`);
    res.json(rows.reverse());
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/chat/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status, reply FROM web_chat WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] http://0.0.0.0:${PORT}`);
});
