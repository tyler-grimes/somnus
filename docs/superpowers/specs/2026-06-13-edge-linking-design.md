# Edge Linking — logical relationships between brain pages

> Design spec. Status: approved 2026-06-13. Next: implementation plan.

## Goal

Populate the `edges` table with logically meaningful relationships between
`pages`, so the dashboard graph view shows connected nodes instead of a dust
cloud. Two parts: a one-time **backfill** of existing pages, and an **ongoing
dream-cycle phase** so new pages keep linking.

The current brain has 16 pages (3 `daily`, 13 `gap_analysis`) and zero edges.

## Approach: hybrid (structural + LLM)

Edges come from three derivers, all writing to the existing `edges` table. No
schema change — `link_type` and `link_source` are free-text `TEXT` columns.

### Structural edges (deterministic, no LLM)

1. **Temporal chain** — order `daily` pages by date; link each consecutive pair
   `earlier → later` with `link_type='precedes'`, `link_source='structural'`.
   The day comes from the slug (`daily-YYYY-MM-DD`).
2. **Provenance** — each `gap_analysis` page links to the `daily` page for its
   own day: `gap → daily` with `link_type='raised_on'`,
   `link_source='structural'`. The day is derived from the gap page's
   `effective_date AT TIME ZONE 'UTC'` formatted `YYYY-MM-DD`, matched to the
   `daily-<date>` slug (daily slugs are built from `new Date().toISOString()`,
   which is UTC — so the provenance join MUST use UTC to line up). Skipped if no
   such daily page exists.

### Semantic edges (LLM)

3. One `extractStructured` call receives a compact list of candidate pages
   (`slug`, `type`, `title`, `compiled_truth` truncated to ~300 chars) and
   returns typed edges over a small controlled vocabulary:
   - `relates_to` — same topic / thematically connected
   - `duplicates` — substantially the same item
   - `blocks` — A must resolve before B can
   - `depends_on` — A needs B
   Each edge is `{ from_slug, to_slug, link_type }`. Written with
   `link_source='llm_extract'`. Model: **Sonnet** (`config.model`), not the
   Opus dream model — cost-conscious, this is light classification.

## Components

### `agent/src/edges.ts` (new) — pure + I/O-light helpers

Keep the derivation logic testable and separate from the dream orchestrator.

- `structuralEdges(pages): EdgeSpec[]` — **pure**. Input: array of
  `{ id, slug, type, effective_date }`. Output: `EdgeSpec[]` where
  `EdgeSpec = { fromId, toId, linkType, linkSource }`. Computes the temporal
  daily chain + gap→daily provenance using slug/date logic only (no DB). Unit-tested.
- `resolveSemanticEdges(llmEdges, slugToId): EdgeSpec[]` — **pure**. Maps the
  LLM's `{from_slug,to_slug,link_type}` to `EdgeSpec` via a slug→id map;
  drops any edge with an unknown slug or `fromId === toId` (self-loop).
  `link_source='llm_extract'`. Unit-tested.
- `insertEdges(pool, specs): Promise<number>` — inserts each spec with
  `INSERT INTO edges (from_page_id, to_page_id, link_type, link_source)
   VALUES ($1,$2,$3,$4)
   ON CONFLICT (from_page_id, to_page_id, link_type) WHERE valid_until IS NULL
   DO NOTHING`
  (targets the existing `edges_dedup_idx` partial unique index). Returns count
  inserted. Idempotent — safe to re-run.
- `EDGE_SCHEMA` (zod) + `SEMANTIC_LINK_TYPES` constant — the LLM output schema
  and the controlled vocab, shared by the dream phase and the backfill script.

### `agent/src/dream.ts` — new phase `linkPages`

Added to the `phases` array after `reflect` (so the night's fresh daily page is
linkable). Behavior:
1. Load candidate pages: those with `updated_at > now() - interval '36 hours'`
   (the existing `EPISODE_WINDOW`) as **focus**, UNION the most-recent / highest
   `emotional_weight` pages as context, capped at **40 pages total**
   (`deleted_at IS NULL`).
2. `structuralEdges(candidates)` → specs.
3. LLM pass over the candidates → `resolveSemanticEdges(...)` → specs.
4. `insertEdges(pool, [...structural, ...semantic])`.
5. Return `edges: +N linked (S structural, L semantic)`.

Wrapped by the existing per-phase try/catch and spend gate. Sonnet for the LLM call.

### `agent/src/backfill-edges.ts` (new) — one-time script

A small standalone `npm run`-able script that runs the same
derivation over **all** active pages (no recency filter, same 40-cap guard —
fine for the current 16), then exits. Run once against production to connect the
existing graph immediately. Reuses `edges.ts` helpers so logic isn't duplicated.

## Data flow

```
pages (daily + gap_analysis)
   │
   ├─ structuralEdges()  ── temporal chain + gap→day provenance ──┐
   │                                                              │
   └─ LLM (Sonnet) ── typed semantic edges ── resolveSemanticEdges┤
                                                                  ▼
                                                       insertEdges() (ON CONFLICT DO NOTHING)
                                                                  ▼
                                                            edges table
                                                                  ▼
                                              /api/graph (already live) → graph view
```

## Error handling

- Dream phase: any failure surfaces as `edges: FAILED — <msg>` in the 🌙 report
  (existing per-phase try/catch); never blocks other phases.
- LLM returns malformed/unknown slugs → `resolveSemanticEdges` drops them; no throw.
- `insertEdges` conflicts are swallowed by `ON CONFLICT DO NOTHING`.
- Backfill script: log inserted count; non-zero exit on a hard DB error.

## Testing

- `agent/src/edges.test.ts` (node:test, like existing agent tests):
  - `structuralEdges`: daily chain links consecutive days in order; gap→daily
    provenance matches by UTC date; no daily for a date → no provenance edge;
    single daily → no chain edges.
  - `resolveSemanticEdges`: maps known slugs; drops unknown-slug edges and
    self-loops; sets `link_source='llm_extract'`.
- `insertEdges` idempotency is covered by the `ON CONFLICT` clause; verified
  manually against the live DB during deploy (running the backfill twice inserts
  N then 0).
- Verify after deploy: backfill once → `/api/graph` shows `links > 0`; graph
  window draws lines; popover lists the linked neighbors with their link types.

## Files touched

- Create: `agent/src/edges.ts`, `agent/src/edges.test.ts`,
  `agent/src/backfill-edges.ts`.
- Modify: `agent/src/dream.ts` (import + `linkPages` phase in the array),
  `agent/package.json` (a `backfill-edges` script).

No schema change, no migration, no dashboard change (the graph view already
renders whatever edges exist).
