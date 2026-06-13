/** Edge derivation for the page graph. The pure functions (structuralEdges,
 *  resolveSemanticEdges) sit at module top so edges.test.ts can import them
 *  without booting the Anthropic SDK; linkPageRows lazy-imports llm.js. */
import type { Pool } from "pg";
import { z } from "zod";
import { config } from "./config.js";

export interface PageRow {
  id: string;
  slug: string;
  type: string;
  effective_date: string | Date | null; // pg hydrates timestamptz as a JS Date
}
export interface CandidatePage extends PageRow {
  title: string;
  summary: string;
}
export interface EdgeSpec {
  fromId: string;
  toId: string;
  linkType: string;
  linkSource: string;
}

/** Controlled vocab for LLM-proposed edges (also embedded in the prompt). */
const SEMANTIC_LINK_TYPES = "relates_to | duplicates | blocks | depends_on";

const EDGE_SCHEMA = z.object({
  edges: z
    .array(
      z.object({
        from_slug: z.string(),
        to_slug: z.string(),
        link_type: z.enum(["relates_to", "duplicates", "blocks", "depends_on"]),
      }),
    )
    .describe("Meaningful typed relationships between the given pages"),
});

/** YYYY-MM-DD (UTC) — matches how daily slugs are built (Date.toISOString). */
function utcDay(ts: string | Date): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Deterministic edges: daily temporal chain + gap_analysis→its-day provenance. */
export function structuralEdges(pages: PageRow[]): EdgeSpec[] {
  const specs: EdgeSpec[] = [];
  const slugToId = new Map(pages.map((p) => [p.slug, p.id]));

  const dailies = pages
    .filter((p) => p.type === "daily")
    .sort((a, b) => a.slug.localeCompare(b.slug)); // daily-YYYY-MM-DD sorts chronologically
  for (let i = 0; i + 1 < dailies.length; i++) {
    specs.push({ fromId: dailies[i].id, toId: dailies[i + 1].id, linkType: "precedes", linkSource: "structural" });
  }

  for (const p of pages) {
    if (p.type !== "gap_analysis" || !p.effective_date) continue;
    const dayId = slugToId.get(`daily-${utcDay(p.effective_date)}`);
    if (dayId && dayId !== p.id) {
      specs.push({ fromId: p.id, toId: dayId, linkType: "raised_on", linkSource: "structural" });
    }
  }
  return specs;
}

/** Map LLM edges (by slug) to specs; drop unknown slugs and self-loops. */
export function resolveSemanticEdges(
  llmEdges: Array<{ from_slug: string; to_slug: string; link_type: string }>,
  slugToId: Map<string, string>,
): EdgeSpec[] {
  const specs: EdgeSpec[] = [];
  for (const e of llmEdges) {
    const fromId = slugToId.get(e.from_slug);
    const toId = slugToId.get(e.to_slug);
    if (!fromId || !toId || fromId === toId) continue;
    specs.push({ fromId, toId, linkType: e.link_type, linkSource: "llm_extract" });
  }
  return specs;
}

/** Fetch up to 40 non-deleted pages as candidates for edge derivation.
 *  When recencyBoost is true, pages updated in the last 36 hours sort first
 *  (used by the dream cycle); otherwise ranked by emotional weight alone. */
export async function fetchCandidatePages(
  pool: Pool,
  opts?: { recencyBoost?: boolean },
): Promise<CandidatePage[]> {
  const order = opts?.recencyBoost
    ? "(updated_at > now() - interval '36 hours') DESC, emotional_weight DESC, updated_at DESC"
    : "emotional_weight DESC, updated_at DESC";
  const result = await pool.query(
    `SELECT id, slug, type, effective_date, title,
            left(coalesce(compiled_truth, title), 300) AS summary
     FROM pages
     WHERE deleted_at IS NULL
     ORDER BY ${order}
     LIMIT 40`,
  );
  return result.rows as CandidatePage[];
}

/** Insert specs idempotently via the (from,to,type) partial unique index. */
async function insertEdges(pool: Pool, specs: EdgeSpec[]): Promise<number> {
  let inserted = 0;
  for (const s of specs) {
    const res = await pool.query(
      `INSERT INTO edges (from_page_id, to_page_id, link_type, link_source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (from_page_id, to_page_id, link_type) WHERE valid_until IS NULL
       DO NOTHING`,
      [s.fromId, s.toId, s.linkType, s.linkSource],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/** Derive structural + LLM edges over candidate pages and insert them.
 *  Lazy-imports llm.js so importing this module stays SDK-free for tests. */
export async function linkPageRows(
  pool: Pool,
  rows: CandidatePage[],
): Promise<{ inserted: number; structural: number; semantic: number }> {
  const slugToId = new Map(rows.map((r) => [r.slug, r.id]));

  // Structural edges are exact and free — insert them first so a later LLM
  // failure can't drop them.
  const structural = structuralEdges(rows);
  let inserted = await insertEdges(pool, structural);

  // Semantic edges are best-effort. Deliberately config.model (Sonnet), NOT the
  // Opus dream model: light classification, cost-conscious by design.
  let semantic: EdgeSpec[] = [];
  try {
    const { extractStructured } = await import("./llm.js");
    const out = await extractStructured({
      purpose: "link_pages",
      model: config.model,
      system:
        `You connect pages in ${config.ownerName}'s second brain with typed relationships. ` +
        `Only link pages that are genuinely related. Link types: ${SEMANTIC_LINK_TYPES}. ` +
        `Use the exact slugs given in [brackets]; never invent a slug. Omit weak or speculative links.`,
      user: rows.map((r) => `[${r.slug}] (${r.type}) ${r.title}\n${r.summary}`).join("\n\n").slice(0, 40_000),
      schema: EDGE_SCHEMA,
      maxTokens: 4000,
    });
    semantic = resolveSemanticEdges(out.edges, slugToId);
    inserted += await insertEdges(pool, semantic);
  } catch (err) {
    console.error("[edges] semantic linking failed (structural edges kept):", err);
  }

  return { inserted, structural: structural.length, semantic: semantic.length };
}
