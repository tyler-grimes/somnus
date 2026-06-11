/**
 * brain-mcp — the memory engine's MCP server (stdio).
 *
 * This is the architectural seam: the brain (Postgres) is the durable asset,
 * and every agent runtime talks to it only through these tools. Swapping the
 * agent later costs nothing; the brain never moves.
 *
 * v1 tools:
 *   search_memory   — hybrid retrieval (FTS arm + trigram facts arm; vector arm
 *                     lands once an embedding pipeline exists)
 *   remember_fact   — write an atomic fact (bitemporal; never overwrites)
 *   supersede_fact  — close an old fact and link its replacement
 *   core_blocks     — render the always-in-context user-model blocks
 *   recent_episodes — recent conversation/event context
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";
import { embedText } from "./embeddings.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

const server = new McpServer({ name: "brain", version: "0.1.0" });

server.tool(
  "search_memory",
  "Search the second brain's memory: page chunks (full-text) and facts (fuzzy). Returns the most relevant memories for a query.",
  { query: z.string().min(1).describe("What to search for") },
  async ({ query }) => {
    const qVec = await embedText(query);
    // Chunks: hybrid RRF (FTS + vector) when embeddings exist; FTS-only otherwise
    const chunks = qVec
      ? await pool.query(
          `WITH fts AS (
             SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.fts_vector, q) DESC) AS rk
               FROM content_chunks c, plainto_tsquery('english', $1) q
              WHERE c.fts_vector @@ q LIMIT 50
           ),
           vec AS (
             SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $2::halfvec) AS rk
               FROM content_chunks WHERE embedding IS NOT NULL
              ORDER BY embedding <=> $2::halfvec LIMIT 50
           ),
           fused AS (
             SELECT COALESCE(fts.id, vec.id) AS id,
                    COALESCE(1.0/(60+fts.rk), 0) + COALESCE(1.0/(60+vec.rk), 0) AS score
               FROM fts FULL OUTER JOIN vec ON fts.id = vec.id
           )
           SELECT p.title, p.slug, c.chunk_text
             FROM fused
             JOIN content_chunks c ON c.id = fused.id
             JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL
            ORDER BY fused.score DESC LIMIT 8`,
          [query, qVec],
        )
      : await pool.query(
          `SELECT p.title, p.slug, c.chunk_text
             FROM content_chunks c
             JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL,
                  plainto_tsquery('english', $1) q
            WHERE c.fts_vector @@ q
            ORDER BY ts_rank(c.fts_vector, q) DESC
            LIMIT 8`,
          [query],
        );
    // Facts: trigram + vector blend when available; trigram/substring otherwise
    const facts = qVec
      ? await pool.query(
          `SELECT kind, claim, valid_from, valid_until, confidence
             FROM facts
            WHERE superseded_at IS NULL
              AND (claim ILIKE '%' || $1 || '%' OR similarity(claim, $1) > 0.2
                   OR (embedding IS NOT NULL AND (embedding <=> $2::halfvec) < 0.55))
            ORDER BY COALESCE(1 - (embedding <=> $2::halfvec), 0) + similarity(claim, $1) DESC,
                     notability DESC
            LIMIT 6`,
          [query, qVec],
        )
      : await pool.query(
          `SELECT kind, claim, valid_from, valid_until, confidence
             FROM facts
            WHERE superseded_at IS NULL
              AND (claim ILIKE '%' || $1 || '%' OR similarity(claim, $1) > 0.2)
            ORDER BY similarity(claim, $1) DESC, notability DESC
            LIMIT 6`,
          [query],
        );
    const lines: string[] = [];
    if (facts.rowCount) {
      lines.push("## Facts");
      for (const f of facts.rows) {
        const span = f.valid_from
          ? ` (since ${f.valid_from.toISOString().slice(0, 10)}${f.valid_until ? `, until ${f.valid_until.toISOString().slice(0, 10)}` : ""})`
          : "";
        lines.push(`- [${f.kind}] ${f.claim}${span}`);
      }
    }
    if (chunks.rowCount) {
      lines.push("## Pages");
      for (const c of chunks.rows) {
        lines.push(`### ${c.title} (${c.slug})\n${c.chunk_text}`);
      }
    }
    return {
      content: [
        {
          type: "text" as const,
          text: lines.length ? lines.join("\n") : "No memories matched.",
        },
      ],
    };
  },
);

server.tool(
  "remember_fact",
  "Store an atomic fact about the user or their world. Facts are bitemporal and append-only — to change one, use supersede_fact.",
  {
    kind: z.enum(["event", "preference", "commitment", "belief", "fact", "habit", "persona"]),
    claim: z.string().min(3).describe("One self-contained sentence"),
    valid_from: z.string().date().optional().describe("When this became true (YYYY-MM-DD)"),
    confidence: z.number().min(0).max(1).optional(),
  },
  async ({ kind, claim, valid_from, confidence }) => {
    const emb = await embedText(claim);
    const res = await pool.query(
      `INSERT INTO facts (kind, claim, valid_from, confidence, source, embedding)
       VALUES ($1, $2, $3, COALESCE($4, 0.8), 'mcp:remember_fact', $5::halfvec)
       RETURNING id`,
      [kind, claim, valid_from ?? null, confidence ?? null, emb],
    );
    return {
      content: [{ type: "text" as const, text: `Stored fact ${res.rows[0].id}` }],
    };
  },
);

server.tool(
  "supersede_fact",
  "Replace a fact that is no longer true: closes the old fact (keeps history) and stores the corrected one.",
  {
    old_fact_id: z.string().uuid(),
    kind: z.enum(["event", "preference", "commitment", "belief", "fact", "habit", "persona"]),
    new_claim: z.string().min(3),
    valid_from: z.string().date().optional(),
  },
  async ({ old_fact_id, kind, new_claim, valid_from }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const emb = await embedText(new_claim);
      const ins = await client.query(
        `INSERT INTO facts (kind, claim, valid_from, source, embedding)
         VALUES ($1, $2, $3, 'mcp:supersede_fact', $4::halfvec) RETURNING id`,
        [kind, new_claim, valid_from ?? null, emb],
      );
      const upd = await client.query(
        `UPDATE facts
            SET superseded_at = now(), superseded_by = $2,
                valid_until = COALESCE(valid_until, CURRENT_DATE)
          WHERE id = $1 AND superseded_at IS NULL`,
        [old_fact_id, ins.rows[0].id],
      );
      if (upd.rowCount === 0) throw new Error("old fact not found or already superseded");
      await client.query("COMMIT");
      return {
        content: [
          { type: "text" as const, text: `Superseded ${old_fact_id} → ${ins.rows[0].id}` },
        ],
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },
);

server.tool(
  "core_blocks",
  "Render the always-in-context user-model blocks: active preferences, commitments, and beliefs, ranked by notability. Bounded output (~2k tokens).",
  {},
  async () => {
    const res = await pool.query(
      `SELECT kind, claim
         FROM facts
        WHERE superseded_at IS NULL
          AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
          AND kind IN ('preference','commitment','belief','habit')
        ORDER BY notability DESC, recorded_at DESC
        LIMIT 30`,
    );
    const byKind = new Map<string, string[]>();
    for (const r of res.rows) {
      if (!byKind.has(r.kind)) byKind.set(r.kind, []);
      byKind.get(r.kind)!.push(r.claim);
    }
    const lines: string[] = [];
    for (const [kind, claims] of byKind) {
      lines.push(`## ${kind}s`);
      for (const c of claims) lines.push(`- ${c}`);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: lines.length ? lines.join("\n") : "No core memory yet.",
        },
      ],
    };
  },
);

server.tool(
  "recent_episodes",
  "Recent conversation turns and events, newest first.",
  {
    limit: z.number().int().min(1).max(50).optional(),
    source: z.string().optional().describe("Filter: telegram|cli|voice|ingestion|dream_cycle"),
  },
  async ({ limit, source }) => {
    const res = await pool.query(
      `SELECT source, role, left(content, 500) AS content, created_at
         FROM episodes
        WHERE ($2::text IS NULL OR source = $2)
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit ?? 15, source ?? null],
    );
    const text = res.rows
      .map(
        (r) =>
          `[${r.created_at.toISOString()}] ${r.source}/${r.role}: ${r.content}`,
      )
      .join("\n");
    return {
      content: [{ type: "text" as const, text: text || "No episodes yet." }],
    };
  },
);

server.tool(
  "log_friction",
  "Log a friction event: something that confused you, blocked you, failed, or that the user keeps asking for repeatedly. The nightly dream cycle clusters these and drafts new skills from recurring patterns.",
  {
    friction_type: z.enum(["confusion", "blocker", "repeated_task", "slow_path", "failure"]),
    description: z.string().min(5).describe("One self-contained sentence describing the friction"),
  },
  async ({ friction_type, description }) => {
    const res = await pool.query(
      `INSERT INTO friction_events (friction_type, description, context)
       VALUES ($1, $2, '{"source":"mcp:log_friction"}') RETURNING id`,
      [friction_type, description],
    );
    return {
      content: [{ type: "text" as const, text: `Logged friction ${res.rows[0].id}` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("brain-mcp ready (stdio)");
