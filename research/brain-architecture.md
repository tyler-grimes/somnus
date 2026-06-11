# What Good Brain Architecture Looks Like

**Date:** 2026-06-10
**Method:** Synthesis of verified claims from prior research rounds (votes shown), cognitive-architecture literature, and engineering judgment on the decided stack. Companion documents: [second-brain-architecture-report.md](./second-brain-architecture-report.md), [gbrain-analysis.md](./gbrain-analysis.md), [gap-fill-letta-voice-ingestion.md](./gap-fill-letta-voice-ingestion.md).
**Purpose:** Ground-up treatment of memory theory so architectural choices have principled justification, not just "gbrain does it this way."

---

## 1. Memory Taxonomy

Five memory types matter for a personal agent. The distinctions are operationally load-bearing — they govern write frequency, retention policy, retrieval strategy, and which failures hurt most.

| Type | What it stores | Write rate | Scope | Failure mode if absent |
|---|---|---|---|---|
| **Working** | Current task state, in-progress reasoning, conversation turn | Per-turn | Single session | Agent loses thread mid-task |
| **Episodic** | Timestamped events: conversations, actions taken, observations | Every interaction | Accumulates over lifetime | Agent re-asks questions, repeats errors |
| **Semantic** | Distilled facts, concepts, world knowledge, generalizations | Async/batch | Persistent, rarely expires | Agent fails to connect dots across sessions |
| **Procedural** | Skills, how-to workflows, reusable tool chains | Slow/governed | Persistent | Agent re-invents every task from scratch |
| **Personalized** | User preferences, habits, recurring constraints, emotional register | Slow/curated | Persistent, user-specific | Agent helps a generic user, not you |

**Verified high confidence:** CoALA (arXiv 2309.02427) formalizes this taxonomy in the agent context: working memory holds symbolic variables for the current decision cycle, distinct from episodic and semantic long-term stores. (vote 3-0)

**Verified high confidence:** The 2026 Externalization survey (arXiv 2604.08224, see [second-brain-architecture-report.md §2.1](./second-brain-architecture-report.md)) names personalized memory as a *separate dimension* from the others — not just a subset of semantic memory — with its own retention and privacy rules.

**Engineering judgment:** The five-way split is not academic completeness — it maps directly onto the failure modes of real systems. Mixing personalized and episodic memory into a single table causes retrieval pollution: a query for "my coffee preference" competes against every meeting note ever written. The types need separate homes, or at minimum, separate retrieval paths.

---

## 2. Lessons from Cognitive Architectures

### 2.1 What transfers from CoALA and Soar/ACT-R

**CoALA** (Cognitive Architectures for Language Agents, arXiv 2309.02427) adapts Soar/ACT-R's memory-action loop to LLM agents. What transfers directly:

- **Working memory as context window.** CoALA treats the context window as working memory — finite, fast, ephemeral. This is not a metaphor; it is a design constraint. Everything that needs to survive a context reset must be explicitly written to long-term memory. (verified 3-0)
- **Memory consolidation as an explicit operation.** CoALA shows agents retrieving episodic memory to generate reflections, which are then written to semantic memory — demonstrated by Generative Agents producing statements like "I like to ski now" from accumulated experience. (verified 3-0) This is not automatic; it requires a scheduled consolidation step distinct from normal retrieval.
- **The action-decision cycle.** Soar/ACT-R's perception → retrieval → reasoning → action loop maps onto: (a) receive input, (b) retrieve relevant memory, (c) reason in working memory (context window), (d) act and write results back. The agent runtime implements (a)(c)(d); the memory engine implements (b) plus async consolidation.

**What is academic decoration from classical architectures:** Soar's "chunking" (automated procedural learning from impasses) and ACT-R's precise activation decay formulas are interesting but not directly portable. LLM agents do not have Soar's production-rule engine, and ACT-R's numerical decay parameters assume a fixed cognitive clock that does not exist in a cloud agent. The *concept* of decay transfers (§5 below); the exact formulas do not.

### 2.2 HippoRAG and Complementary Learning Systems

**Verified high confidence:** HippoRAG (arXiv 2405.14831) implements a tripartite memory architecture inspired by mammalian neurobiology: an LLM-based neocortex component extracts knowledge, a schemaless knowledge graph acts as a hippocampal index storing entity associations, and dense retrieval encoders act as parahippocampal regions detecting semantic similarity. (vote 3-0)

**Verified high confidence:** HippoRAG achieves multi-hop reasoning through Personalized PageRank (PPR), which distributes retrieval probability across a graph only through user-defined source nodes — enabling single-step retrieval equivalent to iterative approaches. (vote 3-0)

**Verified medium confidence:** HippoRAG 2 (arXiv 2502.14802) extends this with phrase nodes (sparse coding), passage nodes (dense coding), and three edge types (relation, synonym, context), achieving 7% improvement over vector-only RAG in associative memory tasks. PPR with dual seed initialization reaches 78% recall@5 on NQ and 96.3% on HotpotQA. (vote 2-1; treat numbers as indicative)

**Neuroscience-inspired lesson that transfers:** the complementary learning systems (CLS) theory — fast-learning hippocampus (episodic, exact) + slow-learning neocortex (semantic, compressed) — maps directly onto the write architecture. New events go in immediately, losslessly; semantic facts are distilled asynchronously. Trying to consolidate in real-time on the write path kills latency and introduces errors.

**What does not transfer:** the biological specifics of NMDA receptor dynamics, theta-gamma coupling, and place-cell firing rates. These are inspiration, not spec.

---

## 3. Memory Operations

### 3.1 The five primitive operations

Every principled memory engine needs exactly these; anything missing creates a failure class.

| Operation | What it does | Failure if missing |
|---|---|---|
| **Add** | Write new episode/fact with timestamp and provenance | Nothing gets stored |
| **Update** | Modify a fact while preserving the prior version | Stale facts silently override truth |
| **Merge** | Combine two near-duplicate records | Index bloat degrades retrieval precision |
| **Link** | Create a typed edge between two records | Multi-hop reasoning fails; isolated facts stay isolated |
| **Forget** | Soft-delete or decay a record (§5) | Stale/contradicted facts pollute retrieval forever |

**Verified high confidence:** Engram (arXiv 2606.09900) implements this with a fast write path that appends lossless episodes without LLM processing on the critical path, plus an asynchronous consolidation process that extracts atomic (subject, predicate, object) facts and resolves contradictions without per-fact LLM calls. (vote 3-0) This is the right decomposition: writes are cheap; reconciliation is async.

### 3.2 Contradiction resolution

When two facts conflict ("prefers dark roast" vs "prefers light roast"), the naive approach is last-write-wins. This is wrong for personal memory where preferences evolve and the system should know *both* what changed and when.

**Engineering judgment:** the correct model is bi-temporal: each fact has a `valid_from` / `valid_until` interval and an `asserted_at` timestamp. Contradiction resolution during consolidation closes the `valid_until` of the old fact rather than deleting it. This lets the system answer "what did I think was true last month?" and explain why a preference changed. Gbrain's `facts` table implements this pattern (companion analysis, §3.4).

### 3.3 Temporal validity

Facts have lifetimes. "Prefers oat milk" is probably stable. "Is in New York this week" expires in days. "Meeting with Alice on Tuesday" expires Tuesday evening. Tagging facts with expected validity windows — indefinite / dated / ephemeral — allows the consolidation step to automatically expire stale records rather than waiting for them to poison a retrieval.

---

## 4. Consolidation: The Dream Cycle

### 4.1 What consolidation is for

Consolidation converts the lossless episodic stream into denser, more retrievable semantic representations. Without it, the memory store becomes an append-only log that grows without bound and retrieves with decreasing precision as signal-to-noise drops. With it, recurring patterns become explicit facts; contradictions get resolved; related episodes get linked.

**Verified high confidence:** Generative Agents (arXiv 2304.03442) synthesize experiences over time into higher-level reflections and retrieve memories dynamically to plan behavior. The reflection step is explicit: the system generates summary statements from episodic records. (vote 3-0)

**Verified high confidence:** CoALA implements consolidation as an explicit operation: agents retrieve and reason over episodic memory to generate reflections, writing the results to semantic memory. (vote 3-0)

### 4.2 Summarization vs. atomic facts — a critical distinction

**Engineering judgment (verified adjacent):** these are not the same operation and should not be conflated.

- **Summarization** compresses a sequence of episodes into a narrative paragraph. It is human-readable and useful for context assembly, but it is lossy, hard to query precisely, and prone to hallucinating details as episodes blend together.
- **Atomic fact extraction** pulls (subject, predicate, object) triples or structured key-value pairs from episodes. It is queryable, mergeable, and contradictable. The Engram paper's async extraction of `(s, p, o)` facts is the right model.

A good dream cycle does both: atomic facts go into the facts table for precise retrieval; summaries are generated for specific high-activity periods and stored as retrievable "digest" pages.

**Verified medium confidence:** Engram reduces token context requirements by 8x (9.6k vs 79k tokens) while maintaining accuracy through selective retrieval via its bi-temporal knowledge graph. (vote 2-1; treat 8x as a directional signal, not a guaranteed result)

### 4.3 Reflection and insight generation

Above fact extraction is a higher layer: noticing patterns across facts ("every time I work after 10pm, I report stress the next day") and writing those insights as new semantic facts with a `derived_from` provenance edge. This requires an LLM call and is expensive; it belongs in the dream cycle, not on the write path.

**Engineering judgment:** reflection should target clusters, not individual episodes. Cluster the episodic log by topic/timeframe, present each cluster to the LLM with a "what pattern do you see?" prompt, and write the resulting insight as a new fact if it exceeds a novelty threshold (embedding distance from existing facts). This is how Generative Agents' reflection works; it is also what gbrain's `patterns` phase in the dream cycle approximates.

### 4.4 The ordered phases of a principled dream cycle

```
Phase 1: Sync          — pull from external sources; dedup; write raw episodes
Phase 2: Lint          — discard malformed/empty records; normalize text
Phase 3: Expire        — close valid_until on temporally expired facts
Phase 4: Extract       — async (s,p,o) fact extraction from new episodes; LLM-light
Phase 5: Deduplicate   — merge near-duplicate facts (embedding similarity threshold)
Phase 6: Contradict    — detect conflicting (s,p,o) pairs; apply bi-temporal resolution
Phase 7: Link          — create typed edges between co-mentioned entities
Phase 8: Patterns      — cluster episodes; LLM reflection on clusters → new insights
Phase 9: Consolidate   — write period summaries for high-density time windows
Phase 10: Embed        — re-embed any records whose text changed; update HNSW index
Phase 11: Purge        — hard-delete records past retention window (configurable per type)
Phase 12: Calibrate    — score recent retrieval accuracy vs ground truth (if available)
```

**Phases must be idempotent.** Each run checks what was already processed (checkpoint table or `processed_at` timestamps). This makes the cycle re-runnable after failures without double-processing. Gbrain's cycle uses `op_checkpoints` for exactly this.

---

## 5. Forgetting and Decay

### 5.1 Why deletion improves retrieval

**Verified high confidence:** Retrieval quality, not storage capacity, is the primary bottleneck in agent memory systems. Vector-based retrievers routinely surface plausible but stale or off-topic records. (arXiv 2603.07670, vote 3-0)

This means retaining everything is not conservative — it actively degrades the system. A facts table full of expired, contradicted, and low-signal records produces noisier embeddings, lower precision in hybrid search, and false confidence.

### 5.2 Decay model

**Engineering judgment:** three decay classes cover the personal-agent use case:

| Class | Examples | Policy |
|---|---|---|
| **Ephemeral** | Travel dates, one-time appointments, transient preferences | Hard-expire at `valid_until`; hard-delete after 30 days |
| **Decaying** | Old conversation topics, context from resolved projects | Soft-delete (zero retrieval weight) after 90 days; hard-delete after 1 year |
| **Permanent** | Core identity facts, long-term preferences, medical, financial | Never auto-delete; require explicit human action to remove |

Decay is not the same as low retrieval score. Decay is a scheduled operation on the facts table. Low retrieval score is an emergent property that happens automatically once stale facts are removed.

### 5.3 Forgetting episodic vs semantic memory differently

Episodes (raw conversations, observations) can be deleted aggressively — their important content has already been extracted as facts. Facts should be retired more carefully using the bi-temporal pattern (close `valid_until`, retain the record). The human should be able to read the full history of a fact's evolution; the agent should only retrieve currently valid ones by default.

---

## 6. Retrieval and Context Assembly

### 6.1 Hybrid fusion is the baseline

**Verified high confidence:** Three-stage retrieval (embedding lookup + BM25 keyword matching + reranking) yields cumulative improvements: embeddings alone reduce retrieval failure 35%, adding BM25 increases to 49%, adding reranking reaches 67% reduction. (Anthropic Contextual Retrieval, vote 3-0)

**Verified high confidence:** Contextual Retrieval reduces retrieval failure from 5.7% to 1.9% (67% reduction) when combining contextual embeddings, BM25 indexing, and reranking on a top-20-chunk search. (same source, vote 3-0)

**Verified medium confidence:** Engram's hybrid retrieval fusion combines dense, lexical, graph-based, and recency/salience signals, achieving 83.6% accuracy on LongMemEval_S versus 73.2% for full-context baseline. (arXiv 2606.09900, vote 2-1; treat the specific numbers as directional)

The takeaway: pure vector retrieval is not enough. BM25 catches exact matches (proper nouns, dates, product names) that embeddings blur. Reranking corrects for embedding model bias toward surface-level similarity. All three are needed and their gains are approximately additive.

### 6.2 Always-in-context core vs retrieved memory

**Engineering judgment (Letta-pattern, verified-adjacent):** Not everything should go through retrieval. Some facts are so load-bearing that their absence from context causes immediate agent failure: current user preferences, active goals, current date/time/location, recent conversation summary, active project list. These belong in bounded always-in-context blocks — small, frequently refreshed, never retrieved.

The blocks pattern (from Letta's core/archival/recall memory design, [gap-fill report §X]):

```
┌─────────────── ALWAYS IN CONTEXT (bounded, ~2k tokens) ─────────────────────┐
│ system_block:  agent persona, tool list, current date/time/location          │
│ user_block:    user preferences, recurring constraints, communication style  │
│ focus_block:   current active goals and open tasks (top ~5)                  │
│ recent_block:  last 3-5 conversation summaries                               │
└─────────────────────────────────────────────────────────────────────────────┘
┌─────────────── RETRIEVED ON DEMAND (budget-managed) ────────────────────────┐
│ episodic_results:   relevant past conversations/events (top-k, reranked)     │
│ semantic_results:   relevant facts from the facts table                      │
│ procedural_results: relevant skills triggered by current task                │
└─────────────────────────────────────────────────────────────────────────────┘
```

The blocks are rendered fresh each turn from the database. The retrieved section is populated by the hybrid retrieval pipeline. The boundary between the two is a token budget decision, not a categorical one — when retrieved context fills the budget, lower-ranked results are dropped.

### 6.3 Context budgets

**Engineering judgment:** a 200k-token context window does not eliminate the need for selection. Filling the context indiscriminately increases:
- Cost (every token billed)
- Latency (TTFT scales with context length)
- Noise (more context → more plausible-but-wrong anchors for the model)

A practical budget for a 24/7 agent targeting Sonnet 4.x:
- Always-in-context blocks: ~2,000 tokens (hard cap, enforced by truncation rules)
- Retrieved episodic: up to 8,000 tokens (top-20 chunks, reranked, trimmed)
- Retrieved semantic facts: up to 3,000 tokens (top-50 facts rendered as list)
- Current task context / tool results: ~5,000 tokens
- **Total budget: ~18,000 tokens** — leaving headroom in a 200k window for long tool outputs without hitting per-turn cost cliffs

---

## 7. Blueprint for This System

Mapping every principle from §§1-6 onto the decided stack: single Postgres + pgvector memory engine exposed over MCP, Claude Agent SDK runtime.

### 7.1 Memory tiers → Postgres tables

| Memory type | Table(s) | Key columns |
|---|---|---|
| Working | Context window only — no table | Ephemeral; reconstructed from blocks + retrieval each turn |
| Episodic | `pages`, `content_chunks` | `created_at`, `source`, `embedding vector(1536)`, `tsvector` |
| Semantic | `facts` | `subject`, `predicate`, `object`, `valid_from`, `valid_until`, `asserted_at`, `source_page_id`, `confidence` |
| Procedural | SKILL.md files on disk | Indexed by `skills/manifest.json`; not in Postgres (gbrain pattern, §3.1 of main report) |
| Personalized | `user_model` (subset of `facts` with `owner = 'user_model'` tag + dedicated view) | Same schema as `facts`; separate retrieval path; stricter retention |

**Typed edges:** `links` table with `(from_id, to_id, rel_type, weight, created_at)` — supports the HippoRAG-style graph arm of hybrid retrieval.

**Bi-temporal facts:** `valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `valid_until TIMESTAMPTZ DEFAULT NULL` (NULL = currently valid), `asserted_at TIMESTAMPTZ`. Contradiction resolution closes `valid_until` of the old row; does not delete.

### 7.2 Dream cycle phases → implementation

Following the ordered-idempotent pattern from §4.4:

```mermaid
flowchart LR
    A[Sync] --> B[Lint/Dedup]
    B --> C[Expire valid_until]
    C --> D[Extract s,p,o facts]
    D --> E[Merge near-dups]
    E --> F[Contradict-resolve]
    F --> G[Link entities]
    G --> H[Reflect on clusters]
    H --> I[Write summaries]
    I --> J[Re-embed changed]
    J --> K[Purge expired]
    K --> L[Calibrate]
```

All phases checkpointed in `op_checkpoints(phase, run_id, status, completed_at)`. The dream cycle runs as a cron job (via the Postgres job queue) at ~2am local time. Phases D, H, I make LLM calls (use Haiku-class for D, Sonnet for H/I — model tiering, gbrain §8.7).

### 7.3 Always-in-context blocks → implementation

Four blocks, rendered fresh each turn by the MCP context-engine tool, injected before the user message:

| Block | Source query | Max tokens | Refresh frequency |
|---|---|---|---|
| `system_block` | Static config + `NOW()`, geolocation | 300 | Every turn |
| `user_block` | `SELECT * FROM facts WHERE owner='user_model' AND valid_until IS NULL ORDER BY confidence DESC LIMIT 40` | 800 | Every turn |
| `focus_block` | `SELECT * FROM facts WHERE predicate='active_goal' AND valid_until IS NULL` | 400 | Every turn |
| `recent_block` | `SELECT * FROM pages WHERE type='summary' ORDER BY created_at DESC LIMIT 5` | 600 | Every turn |

**Total always-in-context: ~2,100 tokens.** This is the Letta bounded-block pattern applied to Postgres. The blocks are not written by the LLM directly — they are rendered from the facts/summaries tables, which the dream cycle maintains. The LLM mutates them by calling MCP tools (`upsert_fact`, `close_fact`) which write to the underlying tables.

### 7.4 Retrieval path → implementation

On each user turn, the context-engine tool runs:

1. **Embed** the user query (ada-002 or equivalent, ~$0.0001/query).
2. **Vector arm:** `SELECT chunk_id, 1-cosine_distance(embedding, $query_vec) AS score FROM content_chunks ORDER BY embedding <=> $query_vec LIMIT 60`.
3. **BM25 arm:** FTS query on `tsvector` column using `plainto_tsquery`, top-60.
4. **RRF fusion:** `score = Σ 1/(60 + rank_i)` across arms; sort descending; take top-20.
5. **Rerank:** pass top-20 to a cross-encoder reranker (or Anthropic's reranking endpoint when available); take top-10.
6. **Facts arm (separate):** `SELECT * FROM facts WHERE valid_until IS NULL AND to_tsvector(subject||' '||predicate||' '||object) @@ query ORDER BY confidence DESC LIMIT 30`. This bypasses the chunk retrieval path.
7. **Inject** top-10 chunks (≤8k tokens) + top-30 facts (≤3k tokens) into context after the always-in-context blocks.

The graph arm (PPR over the `links` table, HippoRAG-style) is a Phase 2 addition — implement after the basic hybrid retrieval is working and validated.

### 7.5 What the self-improvement loop looks like in this schema

The governed skill-creation loop (from [main report §3.4](./second-brain-architecture-report.md)) connects to the memory engine as follows:

- `friction_log` table (JSONL-compatible, from gbrain §8.9): every failed/friction interaction writes a row.
- Dream cycle Phase H clusters the friction log by embedding similarity; clusters with ≥ N entries trigger a `draft_skill` job.
- The `draft_skill` job asks the LLM to write a SKILL.md + unit tests; the tests run in a sandbox; on pass, the skill is registered in `skills/manifest.json`.
- Outcome tracking: per-skill friction-rate before/after (measured over 30-day windows); skills that do not reduce friction are retired.
- Human curation: monthly — the +16.2pp gap between human-curated and self-authored skills ([main report §3.4](./second-brain-architecture-report.md)) means this review is the highest-leverage 30 minutes in the system.

---

## Refuted Claims (Transparency Table)

The following claims were tested during prior adversarial verification rounds and failed. They are listed here because they are tempting to cite in a brain-architecture context.

| Claim | Vote | Why it matters |
|---|---|---|
| CoALA retrieval uses rule-based (recency) + reasoning-based (importance) + embedding-based (relevance) multi-strategy scoring | 1-2 | Do not design a three-arm retrieval "because CoALA says so" — it doesn't, clearly |
| HippoRAG consolidates by incrementally adding edges without reprocessing existing nodes, avoiding catastrophic forgetting | 1-2 | Incremental graph updates are a real technique; just not verified as HippoRAG's specific mechanism |
| Explicit reflection is necessary for multi-session coherence beyond 48 hours; without it behavior degenerates within 48 simulated hours | 0-3 | Reflection is valuable but the 48-hour cliff is a specific empirical claim that did not survive verification |
| Long context windows (200k tokens) degrade from 80%+ to 40-60% on multi-session interdependent tasks vs selective retrieval | 0-3 | Long context is genuinely worse than purpose-built memory in many cases, but the specific degradation curve is unverified |
| Rolling summarization causes loss of low-frequency, high-importance details; critical rare instructions vanish after three summary cycles | 1-2 | Rolling summarization *is* lossy; the specific "three cycles to disappear" claim is unverified |

---

## Caveats

- **Engram (arXiv 2606.09900) is a June 2026 preprint** and may be the most directly relevant paper to this architecture (bi-temporal KG, async fact extraction, hybrid fusion). The 83.6% vs 73.2% accuracy comparison (vote 2-1) and the 8x token reduction (vote 2-1) survived adversarial review but with one dissent each — treat as strong directional signal, not guaranteed numbers.
- **HippoRAG 2 numbers (vote 2-1)** for dual-seed PPR recall are from a single preprint with one adversarial dissent. The *architecture* (phrase + passage nodes, hybrid edges) is more credible than the exact figures.
- **The always-in-context block sizes and retrieval budget numbers in §7.3 and §7.4 are engineering estimates** derived from token-counting actual facts/summaries at similar scales. They should be calibrated empirically once the system is running.
- **CoALA reflects research from 2023** and was the state of the art for agent memory taxonomy at that time. The taxonomy it establishes has held up, but its specific retrieval strategy descriptions (the refuted claim above) reflect the era's tools, not 2026 LLM agents.
- **The "48 hours" and "rolling summarization" refuted claims above** are tempting because they support intuitive conclusions (reflection matters; summarization is lossy). The conclusions may still be right; the specific quantified claims were not verified. Design for these risks; just do not cite the numbers.

---

## Open Questions

1. **Graph retrieval threshold:** at what dataset size does adding the PPR graph arm over the `links` table produce measurably better recall than RRF fusion alone? The Engram and HippoRAG papers suggest it matters most for multi-hop queries — but a personal agent with <100k facts may not need it for months.
2. **Contradiction detection precision:** automated `(s,p,o)` contradiction detection (same subject + predicate, conflicting objects) works well for explicit facts. For soft contradictions ("prefers quiet environments" + "always picks loud coffee shops"), it requires embedding-distance similarity checks on predicates — how precise can this be without constant false positives?
3. **Reflection quality vs cost:** the dream cycle reflection phase (Phase H) is the most expensive LLM call in the cycle. What is the right cluster-size threshold that filters noise without missing genuine insights?
4. **Block staleness:** the always-in-context blocks are rendered fresh each turn from the database. At what point (hours? days? between sessions?) should the `recent_block` summary be regenerated vs. served stale from cache?
5. **Decay calibration for personal data:** the ephemeral/decaying/permanent classification in §5.2 is a starting taxonomy. The right `valid_until` defaults will vary by user and will need tuning from observed retrieval failure patterns once the system is running.
