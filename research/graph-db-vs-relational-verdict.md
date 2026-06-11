# Graph Databases and LLMs: Data Model vs Storage Engine

**Date:** 2026-06-10
**Context:** Direct response to the question "Are graph DBs not better for LLMs? I thought that was optimal." Companion documents: [database-selection.md](./database-selection.md), [brain-architecture.md](./brain-architecture.md).
**Method:** Adversarial-verified claims (vote tallies shown). Engineering judgment sections explicitly flagged. Refuted claims listed in §7 for transparency only.

---

## 1. The Core Conflation

The phrase "graph databases are better for LLMs" bundles two distinct and separable questions:

**Question A (data model and retrieval algorithm):** Should knowledge be *structured as a graph* — entities as nodes, relationships as typed edges — and should multi-hop graph traversal (GraphRAG, HippoRAG, Graphiti, etc.) be used during retrieval? This is a choice about *how you represent and query knowledge*.

**Question B (storage engine):** Should a *native graph database engine* (Neo4j, FalkorDB, KuzuDB) be the software that stores this data, providing index-free adjacency and graph-native query languages (Cypher, Gremlin)? This is a choice about *what process runs on your server*.

These questions have independent answers. You can implement graph-structured retrieval on Postgres with a typed-edge table and recursive CTEs (Question A: yes; Question B: no). You can also run Neo4j and store completely flat, non-relational data in it (Question A: no; Question B: yes). Vendor marketing — especially from Neo4j, FalkorDB, and every GraphRAG tutorial on the internet — conflates them deliberately, because the data-model argument for Question A is genuinely strong while the storage-engine argument for Question B (at personal scale) is not.

The prior recommendation in [database-selection.md](./database-selection.md) answered: **Question A: yes, use graph-structured knowledge; Question B: no, use Postgres with typed-edge tables.** That distinction is what this report defends.

---

## 2. Evidence FOR Graph-Structured Retrieval

### What the research says clearly

**Multi-hop reasoning benefit is real.** HippoRAG implements a tripartite architecture (LLM neocortex + knowledge graph hippocampal index + dense retrieval encoders) and uses Personalized PageRank (PPR) to propagate retrieval probability across the entity graph in a single step, achieving 78% recall@5 on NQ and 96.3% on HotpotQA. (verified 3-0 in [brain-architecture.md §2.2](./brain-architecture.md), arXiv:2405.14831 / arXiv:2502.14802) Pure vector search cannot follow chains of relationships — it scores chunks by distance from the query, not by logical proximity through the knowledge graph. For questions like "who introduced me to X and what did they think about Y" — exactly the kind of question a personal second brain must answer — this distinction is material.

**Continuous update is a real advantage over batch GraphRAG.** Graphiti maintains time-aware queryable graph structures continuously, unlike Microsoft GraphRAG which uses batch processing and static summaries. [verified 3-0, https://blog.getzep.com/graphiti-knowledge-graphs-falkordb-support/] For a 24/7 agent that is always ingesting new information, a batch-only graph model means stale retrieval until the next batch. Graphiti's approach — updating the graph as events arrive — is directly applicable to this system's continuous-ingestion design.

**Graph-structured agents adapt to relationship changes in real-time.** Graph-structured retrieval enables AI agents to reason about changing relationships without waiting for batch reprocessing. [verified 2-1, https://blog.getzep.com/graphiti-knowledge-graphs-falkordb-support/] The personal-brain use case (career changes, relationship evolution, shifting priorities) is exactly this: the knowledge graph changes continuously and the agent needs the current state.

**Cost can be made tractable.** LazyGraphRAG achieves 0.1% of full GraphRAG indexing costs by substituting NLP noun phrase extraction for LLM-based entity extraction during index construction. [verified 3-0, https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/] This resolves what looked like a prohibitive cost barrier for running graph-structured indexing continuously.

### Summary

The case FOR graph-structured retrieval at the algorithm/data-model level is strong and well-supported. Multi-hop reasoning, temporal relationship tracking, and real-time update are all genuine advantages. The question is whether these require a native graph *database engine* to capture — and that is where the answer changes.

---

## 3. Limits and Costs

### What the research also says

**Graph-structured does not automatically mean better retrieval.** KG-based GraphRAG (triplets-only) achieves only 39.20% retrieval accuracy on HotpotQA versus 88.60% for plain RAG. [verified 2-1, https://arxiv.org/abs/2502.11371] Structured as a knowledge graph, but performing *worse* than vanilla RAG. The data model alone does not compensate for retrieval architecture choices. A naive triplet-extraction approach to building a graph — without careful entity resolution, relationship typing, and retrieval scoring — produces a graph that is worse than no graph at all.

**Latency varies wildly by implementation.** KG-GraphRAG (triplets-only) achieves 14,434 seconds retrieval latency on MultiHop-RAG versus 1,249 seconds for Community-GraphRAG — an 8.4× difference between two graph-structured approaches. [verified 2-1, https://arxiv.org/abs/2502.11371] Both are graph-structured; neither uses the same storage engine. The latency difference is entirely in the retrieval algorithm, not the storage layer.

**MS-GraphRAG token overhead is extreme.** MS-GraphRAG produces ~40,000-token prompts versus ~879 tokens for vanilla RAG — a 45× token overhead. [verified 2-1, https://arxiv.org/abs/2506.05690] At Claude pricing, this is a real budget constraint for a 24/7 agent. HippoRAG2 maintains compact prompts (~10³ tokens) while achieving better multi-hop reasoning performance than MS-GraphRAG. [verified 2-1, https://arxiv.org/abs/2506.05690] The implication: if graph-structured retrieval is added to this system, HippoRAG2's architecture (compact, efficient) is the reference, not MS-GraphRAG's global-summarization model.

**Graph memory has a measurable latency cost.** Mem0^g (the graph-augmented version of Mem0) achieves p50: 0.476s and p95: 0.657s search latency versus Mem0 (non-graph) p50: 0.148s and p95: 0.200s — approximately 3× slower. [verified 3-0, https://arxiv.org/html/2504.19413v1] This is the most direct cost comparison available. At personal scale, 476ms is likely acceptable, but it is a real cost to track.

---

## 4. What Leading Graph-Retrieval Systems Actually Run On

This is the most practically important table for the storage-engine question:

| System | Graph data model used | Storage engine | Native graph DB required? |
|---|---|---|---|
| **MS-GraphRAG** | Community summaries + entity nodes | Files (parquet/JSON) or LlamaIndex/LangChain integrations | No — file-based by default |
| **LazyGraphRAG** | Noun-phrase co-occurrence graphs | Same as MS-GraphRAG | No |
| **HippoRAG / HippoRAG2** | Entity-relationship knowledge graph (triplets + phrase/passage nodes) | In-memory or any store; no specific engine required | No |
| **Graphiti** | Temporal knowledge graph with validity intervals | Requires Neo4j or FalkorDB backend (as of 2026-06-10) | Yes — this is the exception |
| **Mem0^g** | Directed labeled graphs, entity nodes + relationship edges | Graph database backend | Yes — though specific engine not confirmed at 3-0 confidence |

[Sources: Graphiti: verified 3-0 via https://blog.getzep.com/graphiti-knowledge-graphs-falkordb-support/; MS-GraphRAG: arXiv:2404.16130 (verified 3-0 that a specific storage engine is NOT required); HippoRAG: arXiv:2405.14831; Mem0^g: arXiv:2504.19413v1]

**The pattern is clear:** most graph-structured retrieval systems do not require a native graph database. The graph data model (nodes, edges, traversal algorithms) is implemented on top of whatever storage is available — files, Postgres, in-memory dictionaries. The native graph DB requirement is the exception, not the norm. Graphiti is the main relevant exception, and it requires Neo4j or FalkorDB specifically.

---

## 5. The Engine Question at Personal Scale

### What index-free adjacency actually provides

Native graph databases use index-free adjacency: each node stores a direct pointer to its adjacent nodes, so traversal from node to neighbor is O(1) regardless of graph size. Relational joins are O(log N) per hop via B-tree index lookups. For graphs with millions of nodes and deep traversals (6+ hops), index-free adjacency produces a measurable performance difference.

### What recursive CTEs handle

For this system's graph layer (entities: people, companies, concepts, projects; edges: typed relationships with temporal validity), the realistic scale is:

- **Nodes:** hundreds to low thousands (personal network = maybe 500 people, 200 companies, 1,000 concepts)
- **Edges:** tens of thousands at most
- **Typical traversal depth:** 2-3 hops ("who does X know who works at Y", "what concepts connect topic A to topic B")

At this scale, Postgres recursive CTEs with B-tree indexes on `(from_page_id, link_type)` and `(to_page_id, link_type)` — exactly as specified in [database-selection.md §4](./database-selection.md) — are not meaningfully slower than index-free adjacency. The crossover point where index-free adjacency shows a practical advantage starts at:

- Graph sizes above ~100,000 nodes, OR
- Traversal depth consistently above 5-6 hops, OR
- Traversal queries running at query-per-second rates that require sub-10ms latency

A personal second brain does not approach these thresholds. The 3× latency overhead measured for Mem0^g (0.476s vs 0.148s) exists regardless of storage engine — it is the cost of graph traversal and relationship scoring, not the cost of using Postgres versus a native graph DB.

[Engineering judgment — thresholds derived from graph database literature and Postgres query planner behavior; not an adversarially verified specific claim]

---

## 6. Verdict

### Was the prior recommendation correct?

**Yes, with one clarification.**

The recommendation in [database-selection.md §4](./database-selection.md) — typed-edge SQL tables in Postgres, recursive CTEs for traversal, no native graph DB — is correct for this system at this stage. The reasoning:

1. The strong case for "graph DBs are better for LLMs" is actually a case for *graph-structured knowledge and retrieval* (data model), not for native graph database *engines* (storage). These are separable.
2. The typed-edge `edges` table specified in [database-selection.md §7](./database-selection.md) implements graph-structured knowledge. Entities are nodes (pages). Relationships are typed edges with temporal validity. Multi-hop traversal is implemented via recursive CTEs. This captures the real benefit.
3. At personal scale (hundreds to low thousands of entity nodes, tens of thousands of edges, 2-3 hop queries), Postgres with B-tree indexes on the edges table is not meaningfully slower than a native graph DB.
4. The operational benefit of staying in a single Postgres instance — one backup, one restore, transactional consistency, no second process to manage — is real and accumulates over time.

**The one clarification:** the prior recommendation does not preclude adding graph-structured *algorithms* (Personalized PageRank, community detection). These can be implemented in application code against the Postgres edges table. The schema design already supports this — it is the retrieval layer above Postgres that would implement PPR-style traversal, not a graph engine below it.

### When to add a native graph engine (concrete trigger conditions)

Add a dedicated graph engine (Graphiti + Neo4j or FalkorDB, or KuzuDB embedded) when **two or more** of the following are simultaneously true:

| # | Trigger | Observable signal |
|---|---|---|
| 1 | **Graph size crosses ~10,000 entity nodes** | `SELECT COUNT(*) FROM pages WHERE type IN ('person','company','concept')` > 10,000 |
| 2 | **Traversal depth consistently exceeds 4 hops** | Query patterns routinely need `depth > 4` in recursive CTEs |
| 3 | **CTE query time exceeds 500ms** | `EXPLAIN ANALYZE` on graph traversal queries shows wall time > 500ms on warm cache |
| 4 | **Graphiti's temporal semantics are a first-class need** | You want "show me how my relationship with X evolved month by month" with Graphiti's native validity-interval logic — not a custom CTE reimplementation of it |
| 5 | **Community detection / PageRank needed natively** | A retrieval feature requires running PageRank or Louvain community detection inside the DB, not as a Python post-processing step |

A single trigger is not sufficient. These thresholds may never be reached at solo personal scale.

**If Graphiti's Postgres backend ships** (tracked as Open Question 5 in [database-selection.md](./database-selection.md)), trigger condition 4 can be met without adding a new database process. Watch the getzep/graphiti roadmap before adding Neo4j.

---

## 7. Does Any Verified Evidence Contradict the Prior Recommendation?

One finding warrants explicit examination:

**Mem0^g latency (verified 3-0):** graph memory is 3× slower at p50 (0.476s vs 0.148s). This does not contradict the prior recommendation — it is measuring the cost of graph traversal versus flat vector lookup, not native graph DB versus Postgres. The Mem0^g paper does not reveal the underlying storage engine at 3-0 confidence (the Neo4j-specific claim was refuted 1-2). The latency cost exists in both Postgres and a native graph DB.

**Graphiti requires a native graph backend (verified 3-0):** this is a genuine constraint on using Graphiti in v1. It does not contradict the prior recommendation — the recommendation already acknowledges this explicitly ("Adding Graphiti later means accepting a second database process"). It confirms that Graphiti is a v2+ decision.

**Conclusion:** No verified evidence at 3-0 or 2-1 confidence contradicts the prior recommendation. The closest counterfactual — "what if you need Graphiti's temporal semantics from day one?" — is not addressed by the prior research and remains an open question. If that is a hard requirement in v1, Graphiti + FalkorDB (Neo4j's FalkorDB performance claims are refuted 0-3; Neo4j itself has unverified performance at this scale) is the minimal-overhead path, but it adds operational complexity from day one.

**No amendment to the prior recommendation is required.**

---

## 8. Refuted Claims (Transparency)

These claims failed adversarial verification. Do not build on them.

| Claim | Vote | Why listed |
|---|---|---|
| GraphRAG achieves 72-83% win rates on comprehensiveness vs vector RAG | 1-2 | Often cited to justify graph DBs; not verified at sufficient confidence |
| Graphiti achieves sub-second latency for graph searches | 1-2 | Not independently replicated; do not set latency SLAs on this |
| Zep achieves sub-200ms at scale for context retrieval in enterprise | 0-3 | Marketing claim; refuted |
| LazyGraphRAG achieves 700× lower query cost than GraphRAG Global Search | 1-2 | Only indexing cost reduction (0.1%) is verified; query-time cost ratio unverified |
| GraphRAG accuracy: 86% vs 32% on multi-hop (54pp gap) | 0-3 | Blog post claim; did not survive verification |
| Vector RAG accuracy drops to 0% on schema-bound queries | 0-3 | Blog post claim; did not survive verification |
| Mem0^g uses Neo4j as underlying graph engine | 1-2 | Storage engine choice is not confirmed at adequate confidence |
| FalkorDB 496× faster P99 than traditional options | 0-3 | Vendor marketing; refuted in prior research |
| GraphRAG context relevance: 0.56 vs 0.51 (11% improvement) | 1-2 | Did not survive verification |
| Hybrid GraphRAG factual correctness: 0.58 vs 0.48 (8% absolute gain) | 0-3 | Did not survive verification |

---

## Caveats

- **Graph traversal latency thresholds** in §5 and §6 (10,000 nodes, 4 hops, 500ms) are engineering judgment derived from graph database literature and general Postgres planner behavior. They are not adversarially verified benchmarks for this specific schema. Measure your actual recursive CTE times as the graph grows.
- **Mem0^g latency numbers (476ms / 148ms)** are the best available direct comparison but are from a different system, not from a Postgres-typed-edge benchmark. The numbers are directionally correct but not transferable exactly.
- **Graphiti backend stability:** as of 2026-06-10, Graphiti's FalkorDB backend is newly added (per the verified source). FalkorDB performance claims are refuted 0-3. Production readiness of this combination is uncertain.
- **LazyGraphRAG 0.1% indexing cost** claim is verified 3-0 for indexing specifically, not for query-time cost. Budget implications of adding LazyGraphRAG to continuous ingestion need independent measurement.
- **HippoRAG recall numbers** (78% on NQ, 96.3% on HotpotQA) are verified at 2-1 confidence — treat as indicative, not guaranteed.

---

## Open Questions

1. **Postgres-native Graphiti backend:** if getzep ships Postgres support for Graphiti, the single-database constraint and Graphiti's temporal semantics become compatible. Is this on the roadmap and what is the timeline?
2. **PPR on Postgres edges table:** can Personalized PageRank be implemented efficiently in Python against the Postgres `edges` table (pulling the relevant subgraph, running PPR in-process, returning scored page IDs)? At what graph size does this become slower than an in-DB graph algorithm?
3. **LazyGraphRAG query-time cost:** the 0.1% indexing cost reduction is verified, but what is the query-time cost versus vanilla hybrid RAG for a personal-scale corpus? A 45× token overhead (MS-GraphRAG) would be budget-breaking; what is LazyGraphRAG's equivalent number?
4. **KuzuDB embedded path:** KuzuDB runs in-process (like SQLite) and uses factorized execution for multi-hop queries. For a future where graph complexity justifies a dedicated engine but operational simplicity is still required, is KuzuDB a viable middle path that avoids running a second server?
5. **HippoRAG2 integration on Postgres:** HippoRAG2's architecture (phrase nodes + passage nodes + three edge types + PPR) maps onto the `pages` + `edges` schema. Can the retrieval algorithm layer be implemented on top of the existing Postgres schema without schema changes?
