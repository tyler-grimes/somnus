import { test } from "node:test";
import assert from "node:assert/strict";
import { structuralEdges, resolveSemanticEdges } from "./edges.js";

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
