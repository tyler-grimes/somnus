# Graph View — Obsidian-style node graph on the BMO console

> Design spec. Status: approved 2026-06-13. Next: implementation plan.

## Goal

Add a force-directed graph view to the web console (`dashboard/`) that shows the
brain's pages as nodes and the typed `edges` table as links — the Obsidian
"graph view" experience, on-theme with the gruvbox 8-bit BMO console.

The `pages` + `edges` tables already form a typed directed graph, so this is a
read/visualize feature: no schema change, no new write path, no auth change.

## Scope

**In:**
- Nodes = `pages` (active only), links = `edges` (active only).
- New `/api/graph` endpoint (whole graph, lightweight) + `/api/page/:id`
  endpoint (lazy node detail for the click popover).
- New `graph` window in the console: hand-rolled canvas force simulation,
  pixel-art nodes, zoom/pan/drag/hover, click → detail popover.

**Out (YAGNI — easy to add later):**
- Fact / friction / drafted-skill nodes.
- Edge-type filtering UI, search-to-focus.
- Time-travel over bitemporal edges (only active edges shown).

## Architecture

Pure addition. Two server routes + one window config entry + one render
function. Touches no existing window, query, or write path.

```
browser (index.html)                    server.ts                 Postgres
─────────────────────                   ─────────                 ────────
WINDOWS[].render = renderGraph
  └─ GET /api/graph ───────────────────► pages + edges query ────► pages, edges
       └─ force sim + canvas draw
       └─ click node:
            GET /api/page/:id ──────────► page detail query ─────► pages, facts, edges
              └─ popover
```

## Backend (dashboard/server.ts)

Both routes are read-only, follow the existing `/api/*` async handler pattern,
and run against the same pool the other dashboard queries use.

### `GET /api/graph`

```sql
-- nodes
SELECT id, slug, type, title, emotional_weight
  FROM pages
 WHERE deleted_at IS NULL;

-- links (active edges only)
SELECT from_page_id AS source, to_page_id AS target, link_type
  FROM edges
 WHERE valid_until IS NULL;
```

- Degree is computed in JS from the links array (count per node id) and attached
  to each node for sizing.
- **Node cap:** if `nodes.length > MAX_NODES` (default 800), keep the top
  `MAX_NODES` by `emotional_weight DESC`, drop links that reference a dropped
  node, and set `capped: true` in the response. Protects the O(n²) sim and the
  canvas from a very large brain.
- Response:
  ```json
  {
    "nodes": [{"id":"…","slug":"…","type":"person","title":"…","weight":0.7,"degree":4}],
    "links": [{"source":"…","target":"…","type":"works_at"}],
    "capped": false,
    "total": 123
  }
  ```

### `GET /api/page/:id`

Lazy detail for the popover (keeps `/api/graph` small).

```sql
SELECT id, type, title, compiled_truth FROM pages WHERE id = $1 AND deleted_at IS NULL;
SELECT count(*)::int AS n FROM facts WHERE page_id = $1 AND superseded_at IS NULL;
-- neighbors (both directions, active edges), joined to page titles
SELECT p.id, p.title, p.type, e.link_type, (e.from_page_id = $1) AS outgoing
  FROM edges e
  JOIN pages p ON p.id = CASE WHEN e.from_page_id = $1 THEN e.to_page_id ELSE e.from_page_id END
 WHERE (e.from_page_id = $1 OR e.to_page_id = $1) AND e.valid_until IS NULL AND p.deleted_at IS NULL;
```

- Validate `:id` is a UUID; 400 on malformed, 404 if no such page (mirror the
  existing `/api/chat/:id` UUID-guard gotcha).
- Response:
  ```json
  {
    "title": "…", "type": "concept",
    "compiledTruth": "…(truncated ~400 chars, ellipsis if longer)…",
    "factCount": 12,
    "links": [{"id":"…","title":"…","type":"person","linkType":"founded","outgoing":true}]
  }
  ```

## Frontend (dashboard/public/index.html)

### Window registration

Add to the `WINDOWS` array (same shape as the others):

```js
{ id:'graph', title:'graph', sub:'pages · edges', accent:'#8ec07c', api:'/api/graph', render:renderGraph }
```

`renderGraph` differs from the table renders (which set `innerHTML` once): it
builds a `<canvas>` in the window body, starts an animation loop, and wires
pointer/wheel handlers. It must clean up its RAF + listeners when the window is
re-rendered or closed.

### Force simulation (hand-rolled, no deps)

Per frame, for the node set:
- **Link spring:** pull edge endpoints toward a target distance.
- **Repulsion:** pairwise node repulsion (O(n²); fine to ~800 nodes).
- **Centering:** gentle pull toward canvas center so the graph doesn't drift.
- **Integrate + damp:** `v = (v + force) * DAMPING`; `pos += v`.
- Settles on its own; pinned nodes (being dragged) skip integration.

### Rendering (pixel-art, gruvbox)

- Nodes = small squares. **Color by `page.type`** via a `TYPE_COLOR` map
  (person/concept/meeting/note/daily/email → distinct gruvbox hues). **Size by
  degree** (clamped min/max). Orphan nodes (degree 0) render at min size,
  drifting free.
- Edges = 1px dimmed lines.
- Hover highlights the node + its direct neighbors and dims everything else.
- A small type→color **legend** in a corner of the window.
- Empty state ("no pages yet") when `nodes` is empty.

### Interaction

- **Scroll** = zoom (canvas transform around cursor).
- **Drag background** = pan.
- **Drag node** = pin + reposition.
- **Hover** = neighbor highlight.
- **Click node** = `GET /api/page/:id` → render popover (gruvbox panel) near the
  node: title, type, compiled_truth snippet, fact count, and a clickable list of
  linked pages. Clicking a linked page selects/recenters that node.

### Performance

- Pause the RAF loop when the window is minimized or off-screen; resume on
  focus. (The console already tracks window focus state.)
- Cancel RAF + remove listeners on teardown to avoid leaks across re-renders.

## Theme / UX

- Matches the existing gruvbox 8-bit BMO aesthetic (same window chrome, fonts,
  accents). Draggable/resizable like every other window — inherits the existing
  window machinery; only the body content is custom.

## Error handling

- `/api/graph`: on query error, return 500 with `{error}` (matches other
  endpoints); the render shows an error state instead of a blank canvas.
- `/api/page/:id`: UUID-guard (400 on malformed before the DB call), 404 on
  missing page.
- Frontend: failed detail fetch → popover shows a short error line, graph keeps
  running.

## Testing / verification

- Dashboard currently has no automated test harness; keep parity. Verify via:
  1. `npm run build` (tsc) clean for `dashboard/`.
  2. Manual: open `http://somnus-vm:3001/`, open the graph window, confirm nodes
     render colored-by-type, edges connect, hover highlights, click opens a
     popover with real page detail, zoom/pan/drag work.
  3. Confirm `/api/graph` and `/api/page/:id` return well-formed JSON against the
     live (read-only) data.
- If a lightweight server test is cheap to add (pure response-shape assertion
  against a fixture), add it; otherwise rely on the build + manual pass, matching
  the rest of the dashboard.

## Files touched

- `dashboard/server.ts` — two new read-only routes.
- `dashboard/public/index.html` — one `WINDOWS` entry + `renderGraph` (+ the
  `TYPE_COLOR` map and popover markup/styles).

No schema change, no migration, no new dependency, no auth change.
