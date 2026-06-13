/** One-time: derive + insert edges over ALL active pages. Reuses the dream
 *  cycle's linkPageRows so behavior matches. Run inside the agent container:
 *    docker compose --profile agent exec -T agent npm run backfill-edges
 *  Idempotent (ON CONFLICT DO NOTHING) — safe to run more than once. */
import { pool } from "./db.js";
import { linkPageRows, fetchCandidatePages } from "./edges.js";

async function main() {
  const rows = await fetchCandidatePages(pool);
  console.log(`[backfill-edges] linking ${rows.length} pages`);
  const r = await linkPageRows(pool, rows);
  console.log(`[backfill-edges] inserted ${r.inserted} edges (${r.structural} structural, ${r.semantic} semantic candidates)`);
  await pool.end();
}

main().catch((err) => {
  console.error("[backfill-edges] failed:", err);
  process.exit(1);
});
