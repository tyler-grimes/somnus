# Graph View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Obsidian-style force-directed graph of the brain's pages/edges to the BMO web console.

**Architecture:** Two read-only Express routes in `dashboard/server.ts` (`/api/graph` for the whole graph, `/api/page/:id` for click-popover detail), backed by a pure `buildGraph` helper (degree + node cap). One new "graph" window in the static `public/index.html` renders a hand-rolled canvas force simulation with zoom/pan/drag/hover and a detail popover. No schema, migration, dependency-at-runtime, or auth change.

**Tech Stack:** TypeScript + Express + `pg` (server), vanilla JS + Canvas 2D (client). Tests via `node --test` + `tsx`.

Spec: `docs/superpowers/specs/2026-06-13-graph-view-design.md`

---

## File Structure

- **Create** `dashboard/graph.ts` — pure graph-building helper (`buildGraph`: dedupe-free passthrough, degree count, node cap). No I/O, fully unit-testable.
- **Create** `dashboard/graph.test.ts` — `node --test` coverage for `buildGraph`.
- **Modify** `dashboard/package.json` — add `tsx` devDep + `test` script.
- **Modify** `dashboard/server.ts` — two new read-only routes using `buildGraph`.
- **Modify** `dashboard/public/index.html` — `TYPE_COLOR`, graph window registration, `poll` skip, `defaultLayout` slot, `initGraph` (sim + draw + interaction + popover), CSS.

---

## Task 1: Pure graph-building helper (`buildGraph`) + test tooling

**Files:**
- Create: `dashboard/graph.ts`
- Create: `dashboard/graph.test.ts`
- Modify: `dashboard/package.json`

- [ ] **Step 1: Add test tooling to `dashboard/package.json`**

Add `"test"` to `scripts` and `tsx` to `devDependencies`:

```json
{
  "name": "somnus-dashboard",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "node --import tsx --test *.test.ts"
  },
  "dependencies": {
    "express": "^4.21.2",
    "pg": "^8.16.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3"
  }
}
```

Then install:

Run: `cd dashboard && npm install`
Expected: `tsx` added, no errors.

- [ ] **Step 2: Write the failing test** — `dashboard/graph.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from './graph.ts';

const n = (id: string, weight = 0.5) => ({ id, slug: id, type: 'note', title: id.toUpperCase(), emotional_weight: weight });

test('counts degree in both directions', () => {
  const g = buildGraph([n('a'), n('b'), n('c')], [
    { source: 'a', target: 'b', type: 'mentions' },
    { source: 'b', target: 'c', type: 'mentions' },
  ]);
  const deg = Object.fromEntries(g.nodes.map((x) => [x.id, x.degree]));
  assert.deepEqual(deg, { a: 1, b: 2, c: 1 });
  assert.equal(g.capped, false);
  assert.equal(g.total, 3);
});

test('orphan nodes get degree 0 and survive', () => {
  const g = buildGraph([n('a'), n('lonely')], [{ source: 'a', target: 'a', type: 'self' }]);
  assert.equal(g.nodes.find((x) => x.id === 'lonely')!.degree, 0);
  assert.equal(g.nodes.length, 2);
});

test('caps to top-N by weight and drops dangling links', () => {
  const nodes = [n('keep1', 0.9), n('keep2', 0.8), n('drop', 0.1)];
  const links = [
    { source: 'keep1', target: 'keep2', type: 'x' },
    { source: 'keep1', target: 'drop', type: 'x' }, // references a dropped node
  ];
  const g = buildGraph(nodes, links, 2);
  assert.equal(g.capped, true);
  assert.equal(g.total, 3);
  assert.deepEqual(g.nodes.map((x) => x.id).sort(), ['keep1', 'keep2']);
  assert.equal(g.links.length, 1); // dangling link to 'drop' removed
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd dashboard && npm test`
Expected: FAIL — `Cannot find module './graph.ts'` (or similar).

- [ ] **Step 4: Implement `dashboard/graph.ts`**

```ts
/** Pure graph-building: degree counting + a node cap so a large brain can't
 *  wedge the O(n^2) client sim. No I/O — unit-tested in graph.test.ts. */

export interface GraphNodeIn {
  id: string;
  slug: string;
  type: string;
  title: string;
  emotional_weight: number;
}
export interface GraphLinkIn {
  source: string;
  target: string;
  type: string;
}
export interface GraphNodeOut {
  id: string;
  slug: string;
  type: string;
  title: string;
  weight: number;
  degree: number;
}
export interface GraphPayload {
  nodes: GraphNodeOut[];
  links: GraphLinkIn[];
  capped: boolean;
  total: number;
}

export function buildGraph(
  nodes: GraphNodeIn[],
  links: GraphLinkIn[],
  maxNodes = 800,
): GraphPayload {
  const total = nodes.length;
  let kept = nodes;
  let capped = false;
  if (nodes.length > maxNodes) {
    kept = [...nodes].sort((a, b) => b.emotional_weight - a.emotional_weight).slice(0, maxNodes);
    capped = true;
  }
  const keepIds = new Set(kept.map((x) => x.id));
  const keptLinks = links.filter((l) => keepIds.has(l.source) && keepIds.has(l.target));

  const degree = new Map<string, number>();
  for (const l of keptLinks) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  return {
    nodes: kept.map((x) => ({
      id: x.id,
      slug: x.slug,
      type: x.type,
      title: x.title,
      weight: x.emotional_weight,
      degree: degree.get(x.id) ?? 0,
    })),
    links: keptLinks,
    capped,
    total,
  };
}
```

Note on a self-loop edge (`source === target`, e.g. the `drop`/`self` test data): it
adds 2 to that node's degree, which is harmless for sizing. Real edges are between
distinct pages.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd dashboard && npm test`
Expected: PASS — 3 tests pass. (Note: the `'self'` self-loop in test 2 gives node `a` degree 2; the assertion only checks `lonely`'s degree and node count, so it passes.)

- [ ] **Step 6: Commit**

```bash
git add dashboard/graph.ts dashboard/graph.test.ts dashboard/package.json dashboard/package-lock.json
git commit -m "feat(dashboard): buildGraph helper — degree + node cap for graph view

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: `/api/graph` route

**Files:**
- Modify: `dashboard/server.ts` (add import at top; add route alongside the other `app.get('/api/...')` handlers, e.g. after `/api/scheduler`)

- [ ] **Step 1: Add the import** near the top of `dashboard/server.ts` (after the existing `import` lines)

```ts
import { buildGraph } from './graph.js';
```

- [ ] **Step 2: Add the route** (place after the `app.get('/api/scheduler', ...)` handler)

```ts
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
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd dashboard && npm run build`
Expected: `tsc` exits clean (no output).

- [ ] **Step 4: Commit**

```bash
git add dashboard/server.ts
git commit -m "feat(dashboard): /api/graph route — pages + active edges

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `/api/page/:id` detail route

**Files:**
- Modify: `dashboard/server.ts` (add a UUID regex const + the route, after `/api/graph`)

- [ ] **Step 1: Add the route** (place right after the `/api/graph` handler)

```ts
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
```

Note: distinct path from `/api/chat/:id`, so no route-ordering conflict. The
UUID guard avoids the "invalid-UUID 500" gotcha noted in HANDOFF.

- [ ] **Step 2: Build to verify it compiles**

Run: `cd dashboard && npm run build`
Expected: `tsc` exits clean.

- [ ] **Step 3: Commit**

```bash
git add dashboard/server.ts
git commit -m "feat(dashboard): /api/page/:id — node detail for graph popover

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Graph window + canvas force simulation (frontend)

**Files:**
- Modify: `dashboard/public/index.html`

This is one cohesive unit (`initGraph`) plus the glue to register the window and
keep the 8-second poll loop from wiping the canvas. Apply all five edits.

- [ ] **Step 1: Add CSS** — insert after the `.win .body::-webkit-scrollbar-thumb` rule (around line 338)

```css
.graph-canvas{ display:block; cursor:grab; touch-action:none; }
.graph-legend{ position:absolute; bottom:4px; left:6px; display:flex; flex-wrap:wrap; gap:6px; font-size:9px; color:var(--gray); pointer-events:none; z-index:3; }
.graph-legend span{ display:flex; align-items:center; gap:3px; }
.graph-legend i{ width:8px; height:8px; display:inline-block; }
.graph-legend .graph-refresh{ pointer-events:auto; cursor:pointer; color:#ebdbb2; font-size:12px; }
.graph-pop{ position:absolute; width:180px; max-height:72%; overflow:auto; background:#282828; border:2px solid var(--accent); padding:6px 8px; font-size:11px; z-index:5; box-shadow:3px 3px 0 #1d2021; }
.graph-pop .gp-x{ position:absolute; top:2px; right:6px; cursor:pointer; color:var(--gray); }
.graph-pop .gp-ttl{ color:#ebdbb2; font-weight:bold; padding-right:14px; word-break:break-word; }
.graph-pop .gp-type{ color:var(--gray); font-size:9px; margin:2px 0 4px; }
.graph-pop .gp-truth{ color:#d5c4a1; margin-bottom:4px; }
.graph-pop .gp-link{ cursor:pointer; color:#83a598; padding:1px 0; }
.graph-pop .gp-link:hover{ color:#8ec07c; }
```

- [ ] **Step 2: Register the graph window** — add an entry to the `WINDOWS` array (around line 446-452). Mark it `custom:true` (the poll loop and renderless flow key off this):

```js
  { id:'graph',     title:'graph',     sub:'pages · edges', accent:'#8ec07c', custom:true },
```

(Add it as the last element of the `WINDOWS` array, after the `scheduler` entry.)

- [ ] **Step 3: Give the window a default-layout slot** — in `defaultLayout()`, add `'graph'` to the `order` array (around line 461):

```js
  const order = ['scheduler','graph','memory','episodes','sessions','spend'];
```

- [ ] **Step 4: Skip custom windows in `poll`** — at the top of `async function poll(def)` (around line 609), bail before fetching so the 8s loop never overwrites the canvas:

```js
async function poll(def){
  const e = els[def.id]; if(!e) return;
  if(def.custom) return;            // custom windows (graph) manage their own body
  try { const r = await fetch(def.api, {cache:'no-store'}); const d = await r.json();
    e.body.innerHTML = def.render(d);
  } catch(err){ e.body.innerHTML = `<div class="err">offline — ${esc(err.message||err)}</div>`; }
}
```

- [ ] **Step 5: Add `initGraph`** — paste this function into the `// =================== rendering ===================` section (e.g. right after `renderScheduler`, before `// =================== polling ===================`):

```js
// =================== graph view ===================
const TYPE_COLOR = { person:'#fb4934', concept:'#8ec07c', meeting:'#fabd2f', note:'#83a598', daily:'#d3869b', email:'#fe8019' };
const TYPE_FALLBACK = '#a89984';

async function initGraph(e){
  if (e._graphCleanup) e._graphCleanup();
  e.body.style.padding = '0'; e.body.style.overflow = 'hidden'; e.body.style.position = 'relative';
  e.body.innerHTML = '';

  let nodes = [], links = [], byId = new Map();
  let raf = 0, alpha = 1, observer = null, popover = null;
  const cam = { x:0, y:0, scale:1 };
  let dragNode = null, panning = false, hoverNode = null, selectedId = null;

  const canvas = document.createElement('canvas');
  canvas.className = 'graph-canvas';
  const ctx = canvas.getContext('2d');

  const bw = () => e.body.clientWidth || 400;
  const bh = () => e.body.clientHeight || 300;
  function fit(){
    const w = bw(), h = bh(), dpr = window.devicePixelRatio || 1;
    canvas.width = w*dpr; canvas.height = h*dpr;
    canvas.style.width = w+'px'; canvas.style.height = h+'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  const s2w = (sx,sy) => ({ x:(sx-cam.x)/cam.scale, y:(sy-cam.y)/cam.scale });
  const radius = n => 3 + Math.min(9, n.degree);

  function neighborSet(node){
    const s = new Set([node]);
    for (const l of links){ if(l.source===node.id) s.add(byId.get(l.target)); if(l.target===node.id) s.add(byId.get(l.source)); }
    s.delete(undefined); return s;
  }

  function step(){
    const cx = bw()/2, cy = bh()/2;
    for (let i=0;i<nodes.length;i++){
      const a = nodes[i];
      for (let j=i+1;j<nodes.length;j++){
        const b = nodes[j];
        let dx = a.x-b.x, dy = a.y-b.y; const d2 = dx*dx+dy*dy || 0.01; const d = Math.sqrt(d2);
        const f = 600/d2; const fx=(dx/d)*f, fy=(dy/d)*f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
    for (const l of links){
      const a = byId.get(l.source), b = byId.get(l.target); if(!a||!b) continue;
      let dx = b.x-a.x, dy = b.y-a.y; const d = Math.sqrt(dx*dx+dy*dy) || 0.01;
      const f = (d-60)*0.02; const fx=(dx/d)*f, fy=(dy/d)*f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    for (const n of nodes){
      n.vx += (cx-n.x)*0.0015; n.vy += (cy-n.y)*0.0015;
      if (n===dragNode){ n.vx=0; n.vy=0; continue; }
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx*alpha; n.y += n.vy*alpha;
    }
    alpha *= 0.992; if (alpha < 0.02) alpha = 0.02;
  }

  function draw(){
    ctx.clearRect(0,0,bw(),bh());
    ctx.save(); ctx.translate(cam.x,cam.y); ctx.scale(cam.scale,cam.scale);
    const hl = hoverNode ? neighborSet(hoverNode) : null;
    ctx.lineWidth = 1/cam.scale;
    for (const l of links){
      const a = byId.get(l.source), b = byId.get(l.target); if(!a||!b) continue;
      const on = hl && (a===hoverNode || b===hoverNode);
      ctx.strokeStyle = on ? 'rgba(235,219,178,0.6)' : 'rgba(168,153,132,0.18)';
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    }
    for (const n of nodes){
      const r = radius(n), dim = hl && !hl.has(n);
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fillStyle = TYPE_COLOR[n.type] || TYPE_FALLBACK;
      ctx.fillRect(n.x-r, n.y-r, r*2, r*2);
      if (n.id===selectedId){ ctx.strokeStyle='#ebdbb2'; ctx.lineWidth=2/cam.scale; ctx.strokeRect(n.x-r-2,n.y-r-2,r*2+4,r*2+4); }
    }
    ctx.globalAlpha = 1;
    if (hl){
      ctx.fillStyle='#ebdbb2'; ctx.font=`${Math.max(9,11/cam.scale)}px monospace`;
      for (const n of hl){ if(n) ctx.fillText(n.title||n.slug, n.x+radius(n)+2, n.y+3); }
    }
    ctx.restore();
  }

  function loop(){
    if (!document.hidden){ if (alpha > 0.025) step(); draw(); }
    raf = requestAnimationFrame(loop);
  }

  function nodeAt(sx,sy){
    const w = s2w(sx,sy); let best=null, bestD=Infinity;
    for (const n of nodes){ const r=radius(n)+3; const dx=n.x-w.x, dy=n.y-w.y; const d=dx*dx+dy*dy; if(d<r*r && d<bestD){ best=n; bestD=d; } }
    return best;
  }

  canvas.addEventListener('pointermove', ev=>{
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX-rect.left, sy = ev.clientY-rect.top;
    if (dragNode){ const w = s2w(sx,sy); dragNode.x=w.x; dragNode.y=w.y; alpha=Math.max(alpha,0.3); return; }
    if (panning){ cam.x += ev.movementX; cam.y += ev.movementY; return; }
    const hit = nodeAt(sx,sy);
    if (hit!==hoverNode){ hoverNode=hit; canvas.style.cursor = hit?'pointer':'grab'; }
  });
  canvas.addEventListener('pointerdown', ev=>{
    canvas.setPointerCapture(ev.pointerId);
    const rect = canvas.getBoundingClientRect();
    const hit = nodeAt(ev.clientX-rect.left, ev.clientY-rect.top);
    if (hit){ dragNode = hit; } else { panning = true; canvas.style.cursor='grabbing'; }
  });
  canvas.addEventListener('pointerup', ev=>{
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX-rect.left, sy = ev.clientY-rect.top;
    if (dragNode && nodeAt(sx,sy)===dragNode) openPopover(dragNode, sx, sy);
    dragNode = null; panning = false; canvas.style.cursor='grab';
  });
  canvas.addEventListener('wheel', ev=>{
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX-rect.left, sy = ev.clientY-rect.top;
    const before = s2w(sx,sy);
    cam.scale = Math.max(0.2, Math.min(4, cam.scale*(ev.deltaY<0 ? 1.1 : 1/1.1)));
    cam.x = sx - before.x*cam.scale; cam.y = sy - before.y*cam.scale;
  }, { passive:false });

  function closePopover(){ if(popover){ popover.remove(); popover=null; } }
  async function openPopover(node, sx, sy){
    selectedId = node.id; closePopover();
    popover = document.createElement('div'); popover.className = 'graph-pop';
    popover.style.left = Math.max(2, Math.min(sx, bw()-184)) + 'px';
    popover.style.top  = Math.max(2, Math.min(sy, bh()-90)) + 'px';
    popover.innerHTML = '<div class="empty">loading…</div>';
    e.body.appendChild(popover);
    try {
      const r = await fetch('/api/page/'+node.id, {cache:'no-store'});
      const d = await r.json();
      if (d.error){ popover.innerHTML = `<div class="err">${esc(d.error)}</div>`; return; }
      const linkRows = (d.links||[]).map(l=>`<div class="gp-link" data-id="${esc(l.id)}">${l.outgoing?'→':'←'} <b>${esc(l.linkType)}</b> ${esc(l.title)}</div>`).join('');
      popover.innerHTML = `
        <div class="gp-x">×</div>
        <div class="gp-ttl">${esc(d.title)}</div>
        <div class="gp-type">${esc(d.type)} · ${d.factCount} facts</div>
        ${d.compiledTruth ? `<div class="gp-truth">${esc(d.compiledTruth)}</div>` : ''}
        ${linkRows ? `<div class="gp-links">${linkRows}</div>` : ''}`;
      popover.querySelector('.gp-x').onclick = closePopover;
      popover.querySelectorAll('.gp-link').forEach(el => el.onclick = ()=>{
        const t = byId.get(el.dataset.id);
        if (t){ cam.x = bw()/2 - t.x*cam.scale; cam.y = bh()/2 - t.y*cam.scale; openPopover(t, bw()/2, bh()/2); }
      });
    } catch(err){ popover.innerHTML = `<div class="err">offline</div>`; }
  }

  e.body.appendChild(canvas);
  const legend = document.createElement('div');
  legend.className = 'graph-legend';
  legend.innerHTML = Object.entries(TYPE_COLOR).map(([t,c])=>`<span><i style="background:${c}"></i>${t}</span>`).join('') + '<span class="graph-refresh" title="refresh">↻</span>';
  e.body.appendChild(legend);
  legend.querySelector('.graph-refresh').onclick = load;

  observer = new ResizeObserver(fit); observer.observe(e.body); fit();

  async function load(){
    closePopover();
    try {
      const r = await fetch('/api/graph', {cache:'no-store'});
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      const w = bw(), h = bh(), N = d.nodes.length || 1;
      nodes = d.nodes.map((n,i)=>{ const a=(i/N)*Math.PI*2; return {...n, x:w/2+Math.cos(a)*120+(i%7), y:h/2+Math.sin(a)*120+(i%5), vx:0, vy:0}; });
      links = d.links; byId = new Map(nodes.map(n=>[n.id,n])); alpha = 1; selectedId = null; hoverNode = null;
      const old = e.body.querySelector('.empty'); if(old) old.remove();
      if (!nodes.length){ const em=document.createElement('div'); em.className='empty'; em.textContent='no pages yet'; e.body.appendChild(em); }
    } catch(err){
      const m = document.createElement('div'); m.className='err'; m.textContent = 'graph offline — '+(err.message||err);
      e.body.appendChild(m);
    }
  }
  await load();
  loop();

  e._graphCleanup = ()=>{ cancelAnimationFrame(raf); if(observer) observer.disconnect(); closePopover(); };
}
```

- [ ] **Step 6: Initialize the graph at boot** — in `function boot()` (around line 723), after `WINDOWS.forEach(def => makeWindow(...))`, init the graph once:

```js
function boot(){
  const layout = loadLayout(), dflt = defaultLayout();
  WINDOWS.forEach(def => makeWindow(def, layout[def.id] || dflt[def.id]));
  if (els.graph) initGraph(els.graph);
  bmoRestore();
  pollAll(); setInterval(pollAll, 8000);
}
```

- [ ] **Step 7: Build the dashboard** (sanity — `index.html` is static, but confirm server still compiles)

Run: `cd dashboard && npm run build`
Expected: `tsc` exits clean.

- [ ] **Step 8: Commit**

```bash
git add dashboard/public/index.html
git commit -m "feat(dashboard): graph view window — canvas force sim, zoom/pan/drag, click popover

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Deploy + manual verification

**Files:** none (deploy + verify)

- [ ] **Step 1: Push**

Run: `git push origin main`
Expected: refs updated.

- [ ] **Step 2: Deploy**

Run: `bash tools/deploy.sh`
Expected: VM pulls, rebuilds the dashboard image, all 3 containers come up; final `docker compose ps` shows `dashboard` Up.

- [ ] **Step 3: Verify the API (read-only, against live data)**

Run: `ssh somnus-vm 'curl -s localhost:3001/api/graph | head -c 400; echo; echo ---; curl -s -o /dev/null -w "%{http_code}\n" localhost:3001/api/page/not-a-uuid'`
Expected: first command prints a JSON object with `nodes`/`links`/`capped`/`total`; second prints `400` (UUID guard).

- [ ] **Step 4: Manual browser check** — open `http://somnus-vm:3001/`

Confirm, in the new **graph** window:
- Nodes render as squares colored by type; a legend shows the type→color key.
- Edges connect related pages; orphan pages float free.
- Hovering a node highlights it + its neighbors and dims the rest; labels appear.
- Scroll zooms, dragging the background pans, dragging a node repositions it.
- Clicking a node opens a popover with title, type, fact count, compiled_truth
  snippet, and clickable linked pages; clicking a linked page recenters on it.
- The `↻` refreshes; the graph is not wiped by the 8-second poll cycle.

- [ ] **Step 5: Done** — no further commit (deploy is the artifact). Report status to the user.

---

## Self-Review

- **Spec coverage:** `/api/graph` (Task 2), `/api/page/:id` with UUID guard + 404 (Task 3), node cap + degree (Task 1), pages-only/active-edges-only (Tasks 2/3 SQL), canvas sim + pixel nodes colored-by-type + sized-by-degree (Task 4), zoom/pan/drag/hover + popover + linked-page nav (Task 4), legend + empty/error states (Task 4), RAF pause on `document.hidden` + alpha cooling + teardown (Task 4), theme/no-auth-change (Task 4), build+manual verification (Task 5). All spec sections mapped.
- **Type consistency:** `buildGraph(nodes, links, maxNodes)` signature and `GraphPayload` (`nodes/links/capped/total`) are consistent across Tasks 1–2. `/api/page/:id` response keys (`title/type/compiledTruth/factCount/links[].{id,title,type,linkType,outgoing}`) match the popover consumer in Task 4. `def.custom` flag set in Task 4 Step 2 and read in Task 4 Step 4. `initGraph`/`load`/`openPopover`/`closePopover`/`_graphCleanup` names consistent within Task 4.
- **Placeholder scan:** no TBD/TODO; every code step has complete code.
- **Scope:** single plan, no decomposition needed.
