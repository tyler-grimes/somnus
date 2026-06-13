# Edge Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the `edges` table with logical relationships (structural + LLM-derived) so the dashboard graph view shows connected nodes, both as a one-time backfill and an ongoing dream-cycle phase.

**Architecture:** A new `agent/src/edges.ts` holds pure derivation helpers (`structuralEdges`, `resolveSemanticEdges`) + an idempotent `insertEdges` + a `linkPageRows` orchestrator that calls the LLM (lazy-imported). The dream cycle gets a `linkPages` phase; a standalone `backfill-edges.ts` script runs the same logic once over all pages.

**Tech Stack:** TypeScript, `pg`, zod, Anthropic SDK (via existing `extractStructured`), `node --test` + `tsx`.

Spec: `docs/superpowers/specs/2026-06-13-edge-linking-design.md`

---

## File Structure

- **Create** `agent/src/edges.ts` — edge derivation. Pure fns (`structuralEdges`, `resolveSemanticEdges`) at module top so they're testable without env/SDK; `insertEdges` (DB) and `linkPageRows` (LLM orchestration, lazy-imports `llm.js`) below. Owns `EdgeSpec`, `PageRow`, `CandidatePage`, `EDGE_SCHEMA`, `SEMANTIC_LINK_TYPES`.
- **Create** `agent/src/edges.test.ts` — `node --test` for the two pure fns.
- **Modify** `agent/src/dream.ts` — import + `linkPages` phase in the `phases` array after `reflect`.
- **Create** `agent/src/backfill-edges.ts` — one-time script over all active pages.
- **Modify** `agent/package.json` — add `backfill-edges` script.

---

## Task 1: `edges.ts` derivation module + tests

**Files:**
- Create: `agent/src/edges.ts`
- Create: `agent/src/edges.test.ts`

- [ ] **Step 1: Write the failing test** — `agent/src/edges.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { structuralEdges, resolveSemanticEdges } from "./edges.ts";

const page = (id: string, slug: string, type: string, effective_date: string | null = null) =>
  ({ id, slug, type, effective_date });

test("structuralEdges links consecutive daily pages chronologically", () => {
  const pages = [
    page("d2", "daily-2026-06-12", "daily"),
    page("d1", "daily-2026-06-11", "daily"),
    page("d3", "daily-2026-06-13", "daily"),
  ];
  const chain = structuralEdges(pages).filter((s) => s.linkType === "precedes");
  assert.deepEqual(chain.map((s) => [s.fromId, s.toId]), [["d1", "d2"], ["d2", "d3"]]);
  assert.ok(chain.every((s) => s.linkSource === "structural"));
});

test("structuralEdges links a gap_analysis to its day's daily page (UTC)", () => {
  const pages = [
    page("d1", "daily-2026-06-11", "daily"),
    page("g1", "gap-foo", "gap_analysis", "2026-06-11T23:30:00.000Z"),
  ];
  const prov = structuralEdges(pages).filter((s) => s.linkType === "raised_on");
  assert.deepEqual(prov, [{ fromId: "g1", toId: "d1", linkType: "raised_on", linkSource: "structural" }]);
});

test("structuralEdges: gap with no matching daily yields no provenance edge", () => {
  const pages = [page("g1", "gap-foo", "gap_analysis", "2026-06-20T10:00:00.000Z")];
  assert.equal(structuralEdges(pages).length, 0);
});

test("structuralEdges: a single daily page yields no chain edges", () => {
  assert.equal(structuralEdges([page("d1", "daily-2026-06-11", "daily")]).length, 0);
});

test("resolveSemanticEdges maps slugs, drops unknown targets and self-loops", () => {
  const map = new Map([["a", "ida"], ["b", "idb"]]);
  const out = resolveSemanticEdges(
    [
      { from_slug: "a", to_slug: "b", link_type: "relates_to" },
      { from_slug: "a", to_slug: "ghost", link_type: "blocks" },
      { from_slug: "a", to_slug: "a", link_type: "duplicates" },
    ],
    map,
  );
  assert.deepEqual(out, [{ fromId: "ida", toId: "idb", linkType: "relates_to", linkSource: "llm_extract" }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent && npm test`
Expected: FAIL — cannot find `./edges.ts`.

- [ ] **Step 3: Implement `agent/src/edges.ts`**

```ts
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
  effective_date: string | null;
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
export const SEMANTIC_LINK_TYPES = "relates_to | duplicates | blocks | depends_on";

export const EDGE_SCHEMA = z.object({
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
function utcDay(ts: string): string {
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

/** Insert specs idempotently via the (from,to,type) partial unique index. */
export async function insertEdges(pool: Pool, specs: EdgeSpec[]): Promise<number> {
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
  const { extractStructured } = await import("./llm.js");
  const slugToId = new Map(rows.map((r) => [r.slug, r.id]));
  const structural = structuralEdges(rows);

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
  const semantic = resolveSemanticEdges(out.edges, slugToId);

  const inserted = await insertEdges(pool, [...structural, ...semantic]);
  return { inserted, structural: structural.length, semantic: semantic.length };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd agent && npm test`
Expected: PASS — the 5 new `edges` tests pass alongside the existing suite.

- [ ] **Step 5: Build to confirm types**

Run: `cd agent && npm run build`
Expected: tsc clean.

- [ ] **Step 6: Commit**

```bash
git add agent/src/edges.ts agent/src/edges.test.ts
git commit -m "feat(agent): edge derivation — structural + LLM page linking helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: `linkPages` dream-cycle phase

**Files:**
- Modify: `agent/src/dream.ts`

- [ ] **Step 1: Add the import** — after the existing `import { SKILLS_PENDING_DIR } from "./skills.js";` line near the top of `dream.ts`:

```ts
import { linkPageRows, type CandidatePage } from "./edges.js";
```

- [ ] **Step 2: Add the phase function** — place it after the `reflect()` function (ends ~line 193) and before the Phase 4 cluster section:

```ts
// ---------- Phase 3.5: derive edges between pages ----------
async function linkPages(): Promise<string> {
  const pages = await pool.query<CandidatePage>(
    `SELECT id, slug, type, effective_date,
            title, left(coalesce(compiled_truth, title), 300) AS summary
       FROM pages
      WHERE deleted_at IS NULL
      ORDER BY (updated_at > now() - interval '36 hours') DESC,
               emotional_weight DESC, updated_at DESC
      LIMIT 40`,
  );
  if (pages.rowCount === 0) return "edges: no pages to link";
  const r = await linkPageRows(pool, pages.rows);
  return `edges: +${r.inserted} linked (${r.structural} structural, ${r.semantic} semantic candidates)`;
}
```

- [ ] **Step 3: Register the phase** — in `runDreamCycle`, insert `["link", linkPages]` into the `phases` array immediately after the `["reflect", reflect]` entry:

```ts
  const phases: Array<[string, () => Promise<string>]> = [
    ["extract", extractFacts],
    ["contradict", resolveContradictions],
    ["reflect", reflect],
    ["link", linkPages],
    ["persona", evolvePersona],
    ["cluster", clusterFriction],
    ["skills", draftSkills],
    ["embed", embedBacklog],
    ["decay", decayAndPurge],
  ];
```

- [ ] **Step 4: Build**

Run: `cd agent && npm run build`
Expected: tsc clean.

- [ ] **Step 5: Run tests** (confirm nothing broke)

Run: `cd agent && npm test`
Expected: PASS (all existing + edges tests).

- [ ] **Step 6: Commit**

```bash
git add agent/src/dream.ts
git commit -m "feat(dream): linkPages phase — derive page edges nightly

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `backfill-edges.ts` one-time script

**Files:**
- Create: `agent/src/backfill-edges.ts`
- Modify: `agent/package.json`

- [ ] **Step 1: Create `agent/src/backfill-edges.ts`**

```ts
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
```

- [ ] **Step 2: Add the `backfill-edges` script to `agent/package.json`** — add to the `scripts` block (after `"cli"`). The container runs compiled output, so it points at `dist/`:

```json
    "backfill-edges": "node dist/backfill-edges.js",
```

(Resulting scripts block:)

```json
  "scripts": {
    "build": "tsc",
    "dev": "node --env-file=../.env --import tsx src/index.ts",
    "start": "node --env-file=../.env dist/index.js",
    "start:docker": "node dist/index.js",
    "cli": "node --env-file=../.env dist/cli.js",
    "backfill-edges": "node dist/backfill-edges.js",
    "test": "node --env-file-if-exists=../.env --import tsx --test src/*.test.ts"
  },
```

- [ ] **Step 3: Build**

Run: `cd agent && npm run build`
Expected: tsc clean; produces `agent/dist/backfill-edges.js`.

- [ ] **Step 4: Commit**

```bash
git add agent/src/backfill-edges.ts agent/package.json
git commit -m "feat(agent): backfill-edges script — link existing pages once

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Deploy, backfill, verify

**Files:** none (integration + ops). The controller (not a subagent) runs this against production.

- [ ] **Step 1: Push** — `git push origin main` (after the feature branch is merged to main).

- [ ] **Step 2: Deploy** — `bash tools/deploy.sh`
Expected: VM rebuilds the agent image, containers come up healthy.

- [ ] **Step 3: Run the backfill in the container**

Run: `ssh somnus-vm 'cd ~/somnus && docker compose --profile agent exec -T agent npm run backfill-edges'`
Expected: logs `linking 16 pages` then `inserted N edges (S structural, L semantic candidates)` with N > 0.

- [ ] **Step 4: Verify idempotency** — run the same command again.
Expected: `inserted 0 edges` (everything already present; `ON CONFLICT DO NOTHING`).

- [ ] **Step 5: Verify via the API** (dashboard binds the tailnet IP, not localhost)

Run: `ssh somnus-vm 'curl -s 100.96.104.68:3001/api/graph | python3 -c "import sys,json; d=json.load(sys.stdin); print(\"nodes\",len(d[\"nodes\"]),\"links\",len(d[\"links\"]))"'`
Expected: `links` > 0.

- [ ] **Step 6: Done** — report status. Browser confirmation (lines drawn, popover lists neighbors with link types) is the user's to eyeball at `http://somnus-vm:3001/`.

---

## Self-Review

- **Spec coverage:** structural temporal chain + provenance (Task 1 `structuralEdges`); LLM semantic edges with controlled vocab + Sonnet (Task 1 `linkPageRows`, `EDGE_SCHEMA`, `SEMANTIC_LINK_TYPES`); idempotent insert via partial unique index (Task 1 `insertEdges` `ON CONFLICT … WHERE valid_until IS NULL`); ongoing dream phase, bounded to 40 + recency-prioritized (Task 2 `linkPages`); one-time backfill over all pages (Task 3); unknown-slug/self-loop dropping (Task 1 `resolveSemanticEdges`); no schema change; deploy + verify links>0 (Task 4). All spec sections mapped.
- **Type consistency:** `EdgeSpec {fromId,toId,linkType,linkSource}`, `PageRow {id,slug,type,effective_date}`, `CandidatePage extends PageRow {title,summary}` defined in Task 1 and consumed unchanged in Tasks 2–3. `linkPageRows(pool, rows)` returns `{inserted, structural, semantic}` — used identically in dream phase and backfill. SQL selects `title` and `summary` matching `CandidatePage`. `EDGE_SCHEMA.edges[].link_type` enum matches the `SEMANTIC_LINK_TYPES` string in the prompt.
- **Placeholder scan:** none; every code step is complete.
- **Decoupling note:** `edges.test.ts` imports only the two pure fns; `edges.ts` keeps `extractStructured` behind a lazy `await import("./llm.js")`, so the test never constructs the Anthropic client. `config` is a normal import (existing tests prove it loads under the dummy local `.env`).
- **Scope:** single plan.
