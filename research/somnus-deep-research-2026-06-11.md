# Somnus Research Report — 2026-06-11

**Method:** Deep codebase analysis + 5 parallel research agents + synthesis from verified prior research corpus (brain-architecture.md, database-selection.md, gap-fill-letta-voice-ingestion.md).

---

## Executive Summary

Somnus is ~70% of the way to a production-grade personal agent. The architecture is sound (Postgres+pgvector brain, Claude Agent SDK runtime, MCP tool surface, nightly dream cycle). The gaps cluster into five areas:

1. **Retrieval** — missing reranking and temporal weighting; RRF alone leaves 10-15 NDCG points on the table
2. **Cost** — no prompt caching; system prompt re-billed every turn; ~$45/month achievable vs ~$75/month current
3. **Context** — sessions grow unboundedly; no proactive reset; dream summaries don't flow back into context
4. **Autonomy** — purely reactive; no proactive behaviors; limited tool surface; no event-driven triggers beyond Telegram
5. **Security** — prompt-level sandboxing is not a security boundary; no injection detection on memory ingestion; approval tokens not HMAC-signed

The report concludes with a prioritized backlog (P0/P1/P2) of 24 improvements.

---

## 1. Memory System Optimization

### 1.1 Current State

Somnus uses hybrid RRF retrieval (brain-mcp/src/index.ts:33-116):
- **FTS arm**: `plainto_tsquery` on `content_chunks.fts_vector`
- **Vector arm**: `embedding <=> $query_vec` on HALFVEC(1536) with HNSW index
- **Fusion**: RRF with k=60, top-8 chunks + top-6 facts

This is a solid baseline but leaves significant quality on the table.

### 1.2 Gaps

**No reranking.** Cross-encoder reranking after RRF yields +8-15 NDCG points on BEIR benchmarks. The current path returns whatever RRF ranks highest, which often includes false positives.

**No temporal weighting.** A well-written 2-year-old fact can outscore a recent one if semantically closer. Personal memory has strong recency bias ("What did I decide about X?" should surface the most recent decision).

**No graph retrieval.** HippoRAG-style PPR over entity co-occurrence graphs enables multi-hop queries ("What was I working on when I met Alice?"). The `edges` table exists but is unused in retrieval.

**Single embedding model.** `text-embedding-3-small` handles both short facts (10-50 tokens) and longer chunks (100-500 tokens). This is acceptable but not optimal.

### 1.3 Recommendations

| Change | Effort | Impact | Priority |
|--------|--------|--------|----------|
| Add BGE-reranker-v2-m3 after RRF (top-30 → top-5) | Low | +8-12 NDCG | P0 |
| Add exponential temporal decay (λ=0.001/day) + `is_evergreen` bypass | Low | +precision on recent queries | P0 |
| Track `retrieval_count` + `last_retrieved_at`, boost frequent facts | Low | Implements spacing effect | P1 |
| Migrate to `gte-large-en-v1.5` (free, 1024d, self-hosted) | Medium | Better quality, lower cost | P2 |
| Add entity graph + PPR traversal (HippoRAG pattern) | High | +10-20 on multi-hop queries | P2 |

**Reranking implementation:**
```python
# After RRF returns top-30, rerank with BGE
from FlagEmbedding import FlagReranker
reranker = FlagReranker('BAAI/bge-reranker-v2-m3')
scores = reranker.compute_score([(query, chunk.text) for chunk in candidates])
reranked = sorted(zip(candidates, scores), key=lambda x: x[1], reverse=True)[:5]
```

**Temporal decay in SQL:**
```sql
SELECT *, 
  rrf_score * EXP(-0.001 * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400)
    * LN(1 + COALESCE(retrieval_count, 0) + 1) AS final_score
FROM memory_rrf_results
WHERE NOT is_evergreen OR ...
ORDER BY final_score DESC LIMIT 10;
```

### 1.4 Memory Architecture Comparison (2025-2026)

| System | Storage | Retrieval | Temporal | Multi-hop | Maturity |
|--------|---------|-----------|----------|-----------|----------|
| MemGPT/Letta | Vector + in-context | Agent-driven tool calls | None native | Poor | Production |
| HippoRAG v2 | Vector + KG | PPR + dense | None | Excellent | Research |
| Zep Graphiti | Vector + temporal KG | Hybrid + graph + recency | Excellent | Good | Production |
| Somnus (current) | Vector + FTS | RRF | None | Poor | Production |
| **Somnus (target)** | Vector + FTS + KG | RRF + rerank + decay | Good | Good | — |

---

## 2. Cost Optimization

### 2.1 Current Token Profile

**Fixed cost per turn (always paid):**

| Component | Tokens | Source |
|-----------|--------|--------|
| System prompt (persona, identity, memory, coding, style) | ~1,400 | buildSystemPrompt() |
| Core blocks (30 facts rendered inline) | ~450 | renderCoreBlocks() |
| Skills section | ~200 | skillsPromptSection() |
| 6 MCP tool schemas | ~900 | Each tool's name + Zod schema |
| **Fixed subtotal** | **~2,950** | Billed every single turn |

**Variable cost per turn:**

| Component | Tokens (typical) |
|-----------|------------------|
| User message | ~30-80 |
| Conversation history (via SDK session resume) | ~500-3,000 |
| Tool call results | ~400-800 |
| Assistant output | ~150-400 |

**Realistic per-turn total: 3,500-6,000 input + 150-400 output tokens**

### 2.2 Monthly Cost Model (Claude Sonnet 4.6: $3/$15 per MTok)

| Scenario | Daily Chat | Dream Cycle | Total Daily | Monthly |
|----------|------------|-------------|-------------|---------|
| 50 msg/day (light) | $0.88 | $0.50 | $1.38 | **$41** |
| 100 msg/day (active) | $1.95 | $0.50 | $2.45 | **$73** |
| 100 msg/day + tool chains | $2.40 | $0.60 | $3.00 | **$90** |

### 2.3 Caching Opportunities

Claude's `cache_control: "ephemeral"` has 5-minute TTL. Cache reads cost 10% of normal input; writes cost 25% extra for first write.

**Tier 1 — Immediate wins:**

The system prompt static text (~1,200 tokens) is identical across every turn in a session. Mark up to `<core_memory>` with `cache_control: "ephemeral"`.

```typescript
// Before: string system prompt
systemPrompt: buildSystemPrompt(coreBlocks)

// After: structured with cache breakpoint
system: [
  { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: "ephemeral" },
  { type: "text", text: `<core_memory>\n${coreBlocks}\n</core_memory>` }
]
```

**Expected savings from caching:**
- At 50 msgs/day: ~$5/month (12%)
- At 100 msgs/day: ~$10/month (14%)

### 2.4 Model Routing

**Keep Opus for dream cycle** — memory consolidation errors compound. $0.50/night is already economical.

**Haiku routing opportunities (60-70% cheaper):**

Turns suitable for Haiku ($1/$5 per MTok):
- Simple status queries: "what time is it", "what's my spending today"
- Acknowledgments: "got it", "thanks", "ok"
- Fact-capture confirmations

```typescript
const HAIKU_PATTERNS = [
  /^(ok|got it|thanks?|sure|yes|no|k|done)\b/i,
  /^(what('s| is) (my |today's )?(spend|budget|cost|balance))/i,
  /^(list|show|what are) (my )?(open threads?|tasks?|commitments?)/i,
];
```

**Expected savings: ~$7/month at 100 msg/day (15% of turns → Haiku)**

### 2.5 Combined Optimization Projection

| State | Monthly Cost (100 msg/day) |
|-------|---------------------------|
| Current (no caching, all Sonnet) | ~$73 |
| + Tier 1 caching | ~$63 (-14%) |
| + Haiku routing | ~$55 (-25%) |
| + Dream cycle consolidation | ~$50 (-32%) |
| + Session reset guard | ~$45 (-38%) |

---

## 3. Context Management

### 3.1 Current State

Somnus uses Claude Agent SDK with `resume: lastSessionId` (agent.ts:342). The SDK replays full conversation history server-side. As sessions grow, context fills unboundedly until hitting the ~200k limit and hard-failing.

**No automatic compression.** The SDK does not summarize or truncate.

**Stale-session guard exists** (agent.ts:345-351) but only catches `"No conversation found with session ID"` — not context overflow.

### 3.2 Gaps

**Sessions grow unboundedly.** 20-40 resumed turns with heavy tool use could approach the context limit within days.

**Dream summaries don't flow back.** The dream cycle writes `daily-{date}` pages via `reflect()` (dream.ts:136-167), but `renderCoreBlocks()` only queries the `facts` table. Daily summaries sit in `pages` unused.

**No session reset after dream cycle.** The dream cycle extracts everything valuable, but the next morning continues the stale session.

### 3.3 Recommendations

**P0 — Prevent context overflow:**

Add token-count guard after each turn:

```typescript
// In runAgentTurn, after executeTurn
if (turn.inputTokens > 40_000) {
  console.log(`[agent] context budget exceeded (${turn.inputTokens}), resetting session`);
  lastSessionId = undefined;
}
```

**P1 — Feed dream summaries back into context:**

```typescript
// Add to renderCoreBlocks() or create renderRecentSummaries()
const summaries = await pool.query(
  `SELECT compiled_truth FROM pages 
   WHERE type = 'daily' AND deleted_at IS NULL 
   ORDER BY effective_date DESC LIMIT 3`
);
// Inject as <recent_memory> block, hard-capped at 600 tokens
```

**P2 — Reset session after dream cycle:**

```typescript
// Export from agent.ts
export function clearLastSessionId(): void {
  lastSessionId = undefined;
}

// In runDreamCycle() after phases complete
await import('./agent.js').then(m => m.clearLastSessionId());
```

**P3 — Token-cap enforcement on core blocks:**

The current `LIMIT 30` doesn't prevent verbose facts from consuming >2k tokens. Add hard truncation at 2,000 tokens (~8,000 chars).

### 3.4 The Right Architecture (Letta Pattern Applied)

```
┌─────────────── ALWAYS IN CONTEXT (~2,500 tokens) ─────────────────────┐
│ system_block:  persona, tools, current date (static, cached)          │
│ core_block:    preferences, commitments, beliefs, habits (from facts) │
│ recent_block:  last 3 daily summaries (from pages, NEW)               │
└───────────────────────────────────────────────────────────────────────┘
┌─────────────── RETRIEVED ON DEMAND ───────────────────────────────────┐
│ search_memory:   top-5 reranked chunks + top-6 facts                  │
│ recent_episodes: explicit tool call for thread resumption             │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 4. True Autonomy

### 4.1 Current State

Somnus is **reactive**: responds to Telegram messages, runs scheduled jobs (dream 04:00, briefing 08:00). No proactive behaviors beyond the fixed cron schedule.

**Existing autonomy features:**
- Automode toggle for Bash commands
- Claude Code delegation (cc.sh)
- Terminal control (term.sh)
- Morning briefing (commitments, threads, spend)

### 4.2 What's Missing

**Proactive behaviors that would unlock value:**

| Behavior | Trigger | Value |
|----------|---------|-------|
| Pre-meeting research | Calendar event T-30min | Tyler arrives informed |
| Competitor news monitoring | RSS poll + keyword match | Early signal on market changes |
| Draft document sections | Idle detection + open thread | Progress while Tyler sleeps |
| Memory surfacing before questions | Semantic similarity to recent context | Answers before Tyler asks |
| Recurring task anticipation | Pattern detection in episodes | "You usually do X on Tuesdays" |

**Tool gaps:**

| Integration | Value | Implementation Path |
|-------------|-------|---------------------|
| Google Calendar read/write | Meeting prep, scheduling | OAuth + Calendar API |
| Gmail read | Email triage, context | OAuth + Gmail API + Pub/Sub |
| Web search | Research, fact-checking | Tavily/Exa/Perplexity API |
| Code sandbox | Safe execution | e2b/Modal container |
| Push notifications | Proactive alerts | Already have via Telegram |
| Voice I/O | Hands-free | Whisper + ElevenLabs |

**Event-driven gaps:**

Current: Telegram webhook + pg-boss cron

Missing:
- Gmail push (Pub/Sub watch → new email trigger)
- Calendar push (channel watch → event change trigger)
- GitHub webhooks (PR opened → review trigger)
- RSS polling (news feed → digest trigger)

### 4.3 Multi-Agent Orchestration

**When to spawn sub-agents:**
1. Task has cleanly separable context (doesn't need parent's full state)
2. Token cost of subtask > 3-5x spawning overhead
3. Failure should be isolable
4. Can run in parallel with other work

**Handle inline when:**
- Single-shot lookup/transformation (<1 tool call)
- Needs dense shared context from parent
- Latency-critical
- Tight read/write coherence needed

**Somnus-specific spawn triggers:**
1. Parallel retrieval across independent knowledge domains
2. Long synthesis tasks overflowing context window
3. Background jobs (nightly backfill, research tasks)

### 4.4 Recommendations

**P1 — Add session-triggered proactive behaviors:**

```typescript
// After each user turn, check for proactive opportunities
async function checkProactiveOpportunities(userText: string): Promise<string | null> {
  // Check calendar for meetings in next hour
  // Check if user's query relates to a known open thread
  // Check if friction pattern matches a known skill
  return null; // or proactive message to append
}
```

**P2 — Add calendar integration:**

- OAuth flow for Google Calendar (one-time setup)
- Store credentials in `settings` table
- Add MCP tool: `list_upcoming_events(hours: number)`
- Morning briefing pulls from calendar

**P2 — Add RSS polling for news monitoring:**

- pg-boss job: poll configured feeds every 15 min
- Filter by keyword match against Tyler's interests (from facts)
- Store summaries as episodes with source=rss
- Surface in morning briefing

---

## 5. Security & Privacy

### 5.1 Current Threat Model

| Layer | Protection | Status |
|-------|------------|--------|
| Telegram auth | `TELEGRAM_ALLOWED_USER_ID` filter | ✓ Implemented |
| Path blocklist | `.env`, `.ssh`, credentials blocked | ✓ Implemented |
| Workspace writes | Only `WORKSPACE_DIR` writable | ✓ Implemented |
| Bash approval | Telegram buttons for each command | ✓ Implemented |
| Spend limit | `DAILY_SPEND_LIMIT_USD` | ✓ Implemented |
| Automode | Persistent, can be toggled off | ✓ Implemented |

### 5.2 Critical Gaps

**1. No OS-level sandbox for Bash**

System prompt restriction ("cannot modify own harness") is not a security boundary. A successful prompt injection bypasses it completely.

**Fix:** Docker container with limited mounts, or `firejail`/`bubblewrap`.

**2. Callback data not HMAC-signed**

Telegram approval buttons can be replayed if bot token leaks.

**Fix:**
```typescript
callback_data = HMAC(secret, `${command_id}:${timestamp}`);
// Expire after 60 seconds
```

**3. No injection detection on memory ingestion**

Poisoned web content enters the brain without inspection. Indirect prompt injection is the highest-severity risk.

**Fix:** Dual-LLM extraction — unprivileged LLM processes external content, returns structured summaries, cannot invoke tools.

### 5.3 High-Priority Gaps

**4. `visibility` field unused**

All memory is equally trusted and retrievable. The schema has `visibility` but retrieval doesn't filter on it.

**Fix:** Add `source_trust` to queries; external-sourced chunks never trigger bash/file operations.

**5. No audit log**

No forensic reconstruction of why the agent took an action.

**Fix:** Append-only `agent_audit` table; agent has INSERT but not DELETE.

**6. Environment variable access not blocked**

`env` or `printenv` via bash returns all API keys.

**Fix:** Add to SAFE_BASH_RE blocklist; validator checks for `env`, `printenv`, `/proc/*/environ`.

### 5.4 Medium-Priority Gaps

| Gap | Risk | Fix |
|-----|------|-----|
| No memory TTL | Stale/poisoned facts accumulate | `expires_at` column + nightly sweep |
| No encryption at rest | DB readable if host compromised | macOS FileVault (verify enabled) |
| No right-to-deletion | Can't purge a topic including embeddings | DELETE + REINDEX workflow |
| Third-party content auto-stored | Privacy violation | Explicit `/store-this` command |
| No canary facts | Can't detect retrieval manipulation | 3-5 canary facts, nightly check |
| No rate limit on writes | Injection loop could exhaust resources | 100 writes/hour cap in MCP handler |

### 5.5 State of the Art in Injection Defense

| Defense | Mechanism | Effectiveness | Status in Somnus |
|---------|-----------|---------------|------------------|
| Spotlighting/StruQ | XML delimiters around data | ~60-70% reduction | Not implemented |
| Input filtering | Regex/classifier on ingested content | ~40-50% | Not implemented |
| Dual LLM pattern | Separate privileged/unprivileged LLMs | High but expensive | Not implemented |
| Human-in-the-loop | Approve all consequential actions | Near-complete | ✓ Bash approval |
| Tool whitelisting | Registry enforced server-side | Prevents tool abuse | Partial (MCP tools) |
| Memory provenance | Tag chunks with source trust level | Reduces retrieval attack | Not implemented |

---

## 6. Dream Cycle Improvements

### 6.1 Current Phases (dream.ts)

```
1. extract      — facts from episodes
2. contradict   — supersede conflicting facts
3. reflect      — write daily summary page
4. persona      — evolve Somnus's self-description
5. cluster      — group friction events
6. skills       — draft SKILL.md from hot clusters
7. embed        — backfill missing vectors
8. decay        — notability decay + purge
```

### 6.2 Gaps

**Missing phases from the principled architecture (brain-architecture.md §4.4):**

| Phase | Purpose | Status |
|-------|---------|--------|
| Sync | Pull from external sources | Not implemented |
| Lint | Discard malformed records | Not implemented |
| Expire | Close `valid_until` on temporal facts | Not implemented |
| Link | Create typed edges between entities | Not implemented |
| Calibrate | Score retrieval accuracy | Not implemented |

**Contradiction detection is limited.** Uses `similarity(claim, claim) > 0.3` — catches direct conflicts but misses soft contradictions ("prefers quiet" + "always picks loud coffee shops").

**No entity extraction or graph building.** The HippoRAG pattern requires entity extraction at write/consolidation time.

### 6.3 Recommendations

**P1 — Add expire phase:**
```typescript
async function expireFacts(): Promise<string> {
  const expired = await pool.query(
    `UPDATE facts SET superseded_at = now() 
     WHERE valid_until IS NOT NULL AND valid_until < CURRENT_DATE 
       AND superseded_at IS NULL`
  );
  return `expire: ${expired.rowCount} temporal facts closed`;
}
```

**P2 — Add entity extraction + link phase:**
```typescript
// In extract or as separate phase
// Extract entities from new facts
// Create edges in `edges` table for co-occurring entities
```

**P2 — Consolidate period summaries:**

After 30 days, daily pages accumulate. Add hierarchical compression:
- Last 3 days: verbatim
- Last 2 weeks: weekly digest
- Older: monthly digest

---

## Prioritized Backlog

### P0 — Do Immediately (blocks quality/reliability)

| # | Area | Change | Effort | File |
|---|------|--------|--------|------|
| 1 | Context | Add token-count guard (>40k → reset session) | Low | agent.ts:340 |
| 2 | Retrieval | Add BGE-reranker-v2-m3 after RRF | Low | brain-mcp/src/index.ts |
| 3 | Retrieval | Add exponential temporal decay + `is_evergreen` | Low | brain-mcp/src/index.ts |
| 4 | Security | HMAC-sign Telegram callback data with expiry | Low | approvals.ts |
| 5 | Cost | Add cache_control to static system prompt | Medium | agent.ts:200 |

### P1 — Do This Week (significant value)

| # | Area | Change | Effort | File |
|---|------|--------|--------|------|
| 6 | Context | Feed daily summaries back into system prompt | Low | agent.ts:177 |
| 7 | Context | Reset session after dream cycle | Low | dream.ts:377, agent.ts |
| 8 | Cost | Add Haiku router for trivial turns | Medium | agent.ts:275 |
| 9 | Dream | Add expire phase for temporal facts | Low | dream.ts |
| 10 | Retrieval | Track retrieval_count + last_retrieved_at | Medium | brain-mcp, schema |
| 11 | Security | Add audit log table (append-only) | Medium | schema, agent.ts |
| 12 | Security | Block env/printenv in Bash validator | Low | agent.ts:126 |

### P2 — Do This Month (substantial improvements)

| # | Area | Change | Effort | File |
|---|------|--------|--------|------|
| 13 | Autonomy | Add Google Calendar integration | High | New MCP tool |
| 14 | Autonomy | Add RSS polling for news monitoring | Medium | scheduler.ts |
| 15 | Security | Add injection detection on memory writes | High | brain-mcp/src/index.ts |
| 16 | Security | Implement source_trust filtering in retrieval | Medium | brain-mcp/src/index.ts |
| 17 | Dream | Add entity extraction + link phase | High | dream.ts |
| 18 | Dream | Consolidate period summaries (weekly/monthly) | Medium | dream.ts |
| 19 | Cost | Combine reflect + evolve_persona into single call | Low | dream.ts |
| 20 | Retrieval | Migrate to gte-large-en-v1.5 (free, self-hosted) | Medium | embeddings.ts |

### P3 — Future (when scale demands)

| # | Area | Change | Effort |
|---|------|--------|--------|
| 21 | Retrieval | Add PPR graph traversal (HippoRAG pattern) | High |
| 22 | Security | Docker sandbox for Bash execution | High |
| 23 | Autonomy | Gmail integration with Pub/Sub triggers | High |
| 24 | Autonomy | Voice I/O (Whisper + ElevenLabs) | High |

---

## Appendix: Key References

**Memory Architectures:**
- CoALA (arXiv 2309.02427) — agent memory taxonomy
- HippoRAG (arXiv 2405.14831) — PPR graph retrieval
- Engram (arXiv 2606.09900) — bi-temporal KG, hybrid retrieval
- MemGPT/Letta — OS-style memory paging

**Retrieval:**
- Anthropic Contextual Retrieval — 67% retrieval failure reduction
- BEIR benchmark — standard retrieval eval
- BGE-reranker-v2-m3 — SOTA open-source reranker

**Security:**
- Greshake et al. (2023) — indirect prompt injection
- OWASP LLM Top 10 (2024) — LLM01, LLM03
- Microsoft BIPIA — injection attack surface taxonomy
- Simon Willison — dual LLM pattern

**Agent Patterns:**
- Anthropic "Building Effective Agents" (Dec 2024)
- ReAct (arXiv 2210.03629) — thought/action loop
- LangGraph — graph-based agent runtime
