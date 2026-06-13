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
