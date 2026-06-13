/** One-time: derive + insert edges over ALL active pages. Reuses the dream
 *  cycle's linkPageRows so behavior matches. Run inside the agent container:
 *    docker compose --profile agent exec -T agent npm run backfill-edges
 *  Idempotent (ON CONFLICT DO NOTHING) — safe to run more than once. */
import { pool } from "./db.js";
import { linkPageRows, type CandidatePage } from "./edges.js";

async function main() {
  const pages = await pool.query<CandidatePage>(
    `SELECT id, slug, type, effective_date,
            title, left(coalesce(compiled_truth, title), 300) AS summary
       FROM pages
      WHERE deleted_at IS NULL
      ORDER BY emotional_weight DESC, updated_at DESC
      LIMIT 40`,
  );
  console.log(`[backfill-edges] linking ${pages.rowCount} pages`);
  const r = await linkPageRows(pool, pages.rows);
  console.log(`[backfill-edges] inserted ${r.inserted} edges (${r.structural} structural, ${r.semantic} semantic candidates)`);
  await pool.end();
}

main().catch((err) => {
  console.error("[backfill-edges] failed:", err);
  process.exit(1);
});
