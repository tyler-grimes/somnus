# Second-Brain Agentic System — Architecture Research Report

**Date:** 2026-06-10
**Method:** Multi-source research with 3-vote adversarial verification. 21 claims survived; 4 were refuted (listed in "Refuted claims" below). Companion document: [gbrain-analysis.md](./gbrain-analysis.md) (full repo teardown).
**Scope note:** Verified findings cover frameworks, memory layers, skills/self-improvement, and the Gmail/GCal/Obsidian ingestion layer. Letta's current state, CrewAI/Mastra/OpenAI Agents SDK, Telegram-bot frameworks, and voice pipelines did **not** survive verification or were not adversarially verified — they appear only in the recommendation as engineering judgment, flagged as such.

---

## Executive summary

The 2026 state of the art has converged on a **harness-centric** view: agent capability and reliability come less from model weights and more from the external infrastructure around the model — memory stores, tool registries, skill libraries, sandboxes, evaluators, and approval loops — with "self-evolving harnesses" named as the emerging frontier (arXiv 2604.08224). For your self-improving requirement, the **Agent Skills format (SKILL.md)** is the load-bearing standard: plain directories of markdown + scripts with progressive disclosure, now an open spec, which agents can generate and edit programmatically — and MUSE-Autoskill (ByteDance, May 2026) demonstrates a working runtime loop where an agent creates skills, gates them behind unit tests, and registers only passing ones. The critical counter-evidence: **naively self-authored skills add roughly nothing** (SkillsBench: −1.3pp average vs +16.2pp for human-curated), and unbounded libraries suffer "library drift" — so the self-improvement loop must include test-gating, outcome-driven retirement, a bounded active cap, and periodic human curation. On memory, vendor head-to-head benchmarks proved unreliable under verification (four such claims refuted); what survives is architectural: Zep/Graphiti is a temporally-aware knowledge graph engine, Mem0 trades accuracy for ~91% lower p95 latency vs full-context, and the academic consensus says **personalized memory (the user model) should be a dedicated layer** separate from task/episodic memory. The ingestion story is now strongly first-party: Google ships 50+ managed MCP servers including Gmail/Calendar/Drive (Developer Preview; Gmail writes limited to drafts/labels), and Obsidian's local-rest-api plugin ships a built-in MCP server with full vault CRUD.

**Recommended architecture in one line:** a gbrain-style **memory engine (Postgres + pgvector + temporal facts, exposed over MCP)** kept separate from a **replaceable agent runtime (Claude Agent SDK)**, with a **test-gated, governance-bounded skill library** in the open SKILL.md format, ingesting via first-party MCP servers (Google, Obsidian) plus your own connectors, fronted by Telegram/CLI/voice clients that all talk to the same agent.

---

## 1. Agentic frameworks

### 1.1 Claude Agent SDK vs LangChain Deep Agents — the model-lock-in axis *(verified, high confidence)*

As of April 2026, **LangChain Deep Agents supports any model provider** (Anthropic, OpenAI, Google, 100+ others), whereas the **Claude Agent SDK only supports Claude models** (via Anthropic API, Bedrock, Vertex, Azure/Foundry). Verified against both LangChain's comparison page and Anthropic's own SDK docs (which list only Claude-model access routes).

- Source: https://docs.langchain.com/oss/python/deepagents/comparison, cross-checked against https://code.claude.com/docs/en/agent-sdk/overview (vote 3-0)
- Implication: if you want provider optionality (or open-weight fallback), Deep Agents is the hedge. If you commit to Claude, the Agent SDK gives you native Agent Skills execution, subagents, hooks, and MCP client support out of the box — the tightest fit for the skill-library design below.
- Note: an earlier claim that the Claude Agent SDK supports only sandbox-local execution (vs Deep Agents' remote-sandbox option) was **refuted 0-3** — do not weight deployment-model differences in this choice.

### 1.2 What was not verified

Letta (your prior choice), CrewAI, Mastra, and the OpenAI Agents SDK produced no claims that survived adversarial verification in this run. The gbrain teardown (companion doc, §7) observes that Letta is "agent-first with memory inside" while gbrain is "memory-first with the agent outside" — a useful framing, but treat any Letta-specifics as unverified as of this report.

---

## 2. Memory layers

### 2.1 The academic frame: personalized memory is its own layer *(verified, high confidence)*

The 2026 survey "Externalization in LLM Agents" (arXiv 2604.08224, SJTU/CMU et al.) defines **personalized memory** as a distinct dimension of externalized state — alongside working context, episodic experience, and semantic knowledge — that stores stable user-specific information (preferences, habits, recurring constraints, prior interactions) and argues it is "the layer that lets an agent adapt over time without confusing long-term user modeling with general task knowledge," with its own retention, retrieval, and privacy rules. (vote 3-0)

**Design consequence:** the "know me better than I know myself" goal should be a **dedicated user-model store** — not facts mixed into a general RAG index. This matches gbrain's `facts` table (temporal validity, provenance, markdown-fence editing) and Letta's core-memory blocks.

### 2.2 Zep / Graphiti *(verified, high confidence)*

Zep's core memory component is **Graphiti**, a temporally-aware knowledge graph engine that ingests both unstructured conversational data and structured business data while preserving the history of relationships over time (bi-temporal edges with validity intervals). Open source (Apache 2.0, getzep/graphiti), corroborated by Neo4j and third-party 2026 reviews. (arXiv 2501.13956, vote 3-0)

### 2.3 Mem0 *(verified, medium confidence — vendor paper, single benchmark)*

Mem0 attains **91% lower p95 latency** (1.44s vs 17.1s) and >90% token savings versus feeding full conversation history to the LLM (LOCOMO, GPT-4o-mini). **Important:** this is a speed/cost trade-off — in the same paper, full-context scored *higher accuracy* than Mem0. All authors are Mem0 employees. (arXiv 2504.19413, vote 3-0)

### 2.4 The benchmark wars are noise *(refuted claims — read this)*

Four memory-vendor benchmark-superiority claims were **refuted** under adversarial verification:

- Mem0's "26% improvement over OpenAI memory" (vote 1-2)
- Zep beating MemGPT/Letta on DMR, 94.8% vs 93.4% (vote 0-3)
- Zep's "up to 18.5% accuracy / 90% latency win" on LongMemEval (vote 1-2)

Each vendor's evaluation of *competitors* is contested (e.g., Zep published a rebuttal of Mem0's methodology and vice versa). **Choose your memory layer on architecture fit, operational simplicity, and data ownership — not published head-to-head numbers.**

### 2.5 Plain-file memory

Not separately adversarially verified, but two verified facts make it viable as a *component*: (a) Agent Skills demonstrate that plain markdown-with-frontmatter is a robust, agent-editable persistence format (§3.1), and (b) gbrain's facts-as-markdown-fence round-trip (companion doc §3.4) shows plain-file views over a database give you human auditability — strikethrough-to-forget — without giving up indexed retrieval.

---

## 3. Self-improvement and skill learning

This is your critical requirement, and it is where 2026 research is richest — both the mechanism and its failure modes are now documented.

### 3.1 Agent Skills (SKILL.md) is the standard substrate *(verified, high confidence)*

Three verified facts (each vote 3-0, Anthropic engineering blog Oct 2025 + current platform docs + the open spec at agentskills.io):

1. **Format:** a skill is a directory containing `SKILL.md` whose YAML frontmatter requires only `name` and `description` — a plain-file format an agent can generate and edit programmatically. Became an **open standard in Dec 2025** (adopted by Microsoft, OpenCode, others).
2. **Progressive disclosure** is the core design principle, in three levels: frontmatter metadata always in context (~100 tokens/skill), SKILL.md body loaded when triggered (<5k tokens), linked files/resources loaded only as needed. A large skill library stays cheap until used.
3. **Skills bundle executable code** — scripts the agent runs at its discretion — so the library encodes reusable *tools*, not just instructions. (Caveat: needs a bash/code-exec environment; Claude Code skills run with full host access.)

4. **Roadmap:** Anthropic's stated goal (Oct 2025) is agents that "create, edit, and evaluate Skills on their own, letting them codify their own patterns of behavior into reusable capabilities" — exactly your requirement. By June 2026 this is *partially* realized: the shipped skill-creator tooling has Create/Eval/Improve/Benchmark modes, but fully autonomous skill self-authoring is not a turnkey product feature. (vote 3-0)

### 3.2 The academic taxonomy *(verified, high confidence)*

The Externalization survey (arXiv 2604.08224) gives skill acquisition four modes — **Authored, Distilled, Discovered, Composed** — where "Distilled" is precisely your loop: recurring successful structures in execution traces are "promoted into explicit reusable procedure." It calls this "the main path by which accumulated experience becomes codified expertise." The same paper argues reliability now depends primarily on the external **harness layer** (memory stores, tool registries, sandboxes, evaluators, test harnesses, approval loops) rather than model weights, and names **self-evolving harnesses** as an emerging direction. (votes 3-0, 3-0)

### 3.3 A working reference implementation: MUSE-Autoskill *(verified; design high confidence, benchmark numbers self-reported)*

MUSE-Autoskill (ByteDance + RIT, arXiv 2605.27366, May 2026) implements the full loop you want:

- **Five-stage lifecycle:** creation → memory → management → evaluation → refinement; skills are "long-lived, evolving assets," not one-off outputs. The agent creates new skills *at runtime* via a built-in `skill_create` capability when existing skills are insufficient. (vote 3-0)
- **Test-gated registration:** each new skill ships with unit tests run in a sandbox; it enters the Skill Bank **only if all tests pass**. Failures trigger the agent to inspect the error trace and invoke `update_skill` — a create → evaluate → register reflection loop. (vote 3-0)
- **Portability:** skills are externalized as SKILL.md documents + scripts (the Agent Skills format). A *different* agent (Hermes) using MUSE-generated skills improved 47.89% → 58.40% (+10.51pp), closing ~79% of the gap to human-authored skills. (vote 3-0; authors' own benchmark, preprint, no independent replication)

### 3.4 The failure modes — why naive self-improvement doesn't work *(verified)*

- **Self-authored skills ≈ zero gain by default** *(high confidence)*: on SkillsBench (arXiv 2602.12670 primary; 86 tasks, 7,308 trajectories), LLM-authored skills provided **no average benefit (−1.3pp**, reported as +0.0pp by a secondary paper**)** while human-curated skills delivered **+16.2pp**. Gains vary hugely by domain (+4.5pp SWE to +51.9pp healthcare); one model (Opus 4.6) eked out +1.4pp self-generated. (vote 3-0)
- **Library drift** *(high confidence on phenomenon; term coined by one preprint)*: unbounded skill accumulation without lifecycle management causes retrieval degradation, false-positive skill injections, and performance stagnation (arXiv 2605.19576, corroborated by concurrent SkillOps/SoK papers). (vote 3-0)
- **The fix that worked — "Ratchet"** *(medium confidence: single preprint, one benchmark, 3 seeds)*: outcome-driven retirement + bounded active cap + meta-skill authoring raised held-out pass@1 on MBPP+ hard-100 from 0.258 baseline to a 0.584 late-window mean over 100 self-evolution rounds (arXiv 2605.19576 / extended 2605.22148). (vote 3-0)

**Design consequence — the self-improvement loop must be governed:**

1. Log friction/failures continuously (gbrain's `friction.ts` JSONL protocol is a ready-made substrate — companion doc §8.9).
2. Nightly: cluster recurring patterns; when a cluster crosses a threshold, draft a skill ("Distilled" mode).
3. Gate: generate unit tests, run in sandbox, register only on pass; on failure, reflect and `update_skill` (MUSE pattern).
4. Govern: track per-skill outcome contribution, retire losers, cap the active set (Ratchet pattern).
5. Curate: periodic human review — the +16.2pp human-curated vs −1.3pp self-authored gap means your own editing pass is the single highest-leverage activity in the whole system.

---

## 4. Ingestion / connection layer

### 4.1 Google-managed MCP servers *(verified, high confidence)*

- As of Google Cloud Next '26 (April 2026), Google offers **50+ Google-managed MCP servers** GA or in preview. (vote 3-0)
- Coverage includes **Workspace APIs: Gmail, Drive, Calendar, People, Chat** — first-party, Google-hosted endpoints (e.g., `https://gmailmcp.googleapis.com/mcp/v1`, `https://calendarmcp.googleapis.com/mcp/v1`) with OAuth 2.0, so no self-hosted community connectors needed. (vote 3-0)
- **Write actions are supported, with limits:** Calendar MCP has full read/write (`create_event`, `update_event`, `delete_event`, `respond_to_event`). Gmail MCP writes are **drafts and labels only — no send tool**. (vote 3-0)
- **Caveats that must drive your design:** all five Workspace MCP servers are **Developer Preview** (not GA); setup requires a GCP project with the APIs + MCP API enabled; consumer @gmail.com support is not explicitly documented. For sending email, fall back to the regular Gmail API with your own OAuth refresh + incremental sync — which the gbrain teardown also recommends over agent-run collector scripts (companion doc, Skip #5).

### 4.2 Obsidian *(verified, high confidence)*

The **obsidian-local-rest-api** plugin (v4.1.3, June 2026) provides:

- **Full CRUD on any vault file** via REST (GET/PUT/POST/PATCH/DELETE on `/vault/{filename}`, including targeted PATCH by heading/block-ref/frontmatter). (vote 3-0)
- A **built-in MCP server** since v4.0.0 (May 2026) at `https://127.0.0.1:27124/mcp/` with bearer-token auth — AI agents connect directly, no community bridge needed (stdio-only clients use the generic `mcp-remote` shim). (vote 3-0)
- **Deployment caveat:** the API is served by the plugin *inside a running Obsidian instance*, bound to localhost. On a headless VM you either (a) run Obsidian headless (xvfb), (b) sync the vault (Syncthing/git) and operate on the markdown files directly — a vault is just files, and your agent has a filesystem — or (c) keep Obsidian on a desktop and tunnel (Tailscale). Option (b) is the most robust for 24/7 operation; reserve the MCP/REST path for when you need Obsidian-native features.

### 4.3 Everything else (iMessage, Telegram, Slack, browsing, LLM chat history)

No claims in these areas survived adversarial verification in this run — treat as unverified. The gbrain pattern that *did* get a full teardown is worth copying regardless of connector: a supervised **ingestion daemon** (pluggable sources, dedup, rate limits, health probes) plus an **inbox-folder capture channel** (`~/inbox/` + iOS Shortcuts) as the cheapest week-one capture path (companion doc §4, Steal #12).

---

## 5. Interfaces (chat, CLI, voice)

No interface-layer claims were adversarially verified in this run; this section is engineering judgment plus the gbrain teardown. The verified architecture facts still constrain the design: because the agent runtime is a single always-on process with MCP connections and a skill library, **all three interfaces should be thin clients of the same agent**, not separate agents:

- **Telegram bot** as primary mobile surface (long-polling bot talking to the agent's API/queue).
- **CLI/SSH** directly into the agent runtime on the VM (the Claude Agent SDK is natively a CLI-shaped harness).
- **Voice** wired *through* the Telegram/agent layer (voice notes → STT → same agent; TTS on the return path) rather than a parallel voice agent — also the gbrain recommendation (companion doc, Skip #8).

---

## 6. gbrain: what to adopt

Full teardown in [gbrain-analysis.md](./gbrain-analysis.md). The one framing that matters: **gbrain is not an agent — it is a memory engine + maintenance daemon that a host agent plugs into over MCP.** Top adoptions (see companion doc §8 for all 13):

1. **The seam:** memory engine as an MCP server; agent platform(s) as replaceable clients.
2. **Single Postgres** for pages + chunks (pgvector) + FTS + typed edges + temporal facts + a Postgres-native job queue.
3. **Hybrid retrieval** (RRF over FTS + vector, intent-weighted, recency decay).
4. **Dream cycle:** ordered idempotent nightly phases (sync → extract facts → consolidate → reflect → embed → purge).
5. **Facts with temporal validity + provenance**, editable as markdown fences.
6. **Friction/failure logging as the substrate for skill creation** — the loop gbrain itself didn't finish, which §3.4 above now tells you how to finish safely.
7. **Model tiering + spend log + daily budget gate** — mandatory for an unattended 24/7 system.

Skip: the codebase as a dependency, the 95-tool MCP surface, OAuth 2.1 server, admin SPA, regex-only graph extraction as an end state.

---

## 7. Recommended architecture

```
┌─────────────────────────────── Cloud VM (24/7) ────────────────────────────────┐
│                                                                                │
│  INTERFACES                AGENT RUNTIME                 BRAIN (the moat)      │
│  ┌──────────────┐        ┌──────────────────────┐      ┌────────────────────┐ │
│  │ Telegram bot │──────▶ │ Claude Agent SDK     │ MCP  │ Postgres + pgvector│ │
│  │ CLI (ssh)    │──────▶ │  - session loop      │◀────▶│  pages/chunks/FTS  │ │
│  │ Voice (STT/  │──────▶ │  - Agent Skills dir  │      │  typed-edge graph  │ │
│  │  TTS via TG) │        │  - subagents/hooks   │      │  temporal facts +  │ │
│  └──────────────┘        │  - budget gate       │      │   user model       │ │
│                          └──────┬───────────────┘      │  job queue         │ │
│                                 │ MCP clients          │  friction log      │ │
│                                 ▼                      └─────────┬──────────┘ │
│   ┌─────────────────────────────────────────────┐               │            │
│   │ INGESTION                                   │     NIGHTLY DREAM CYCLE    │
│   │ Google-managed MCP: Gmail(draft/label),     │     - sync sources         │
│   │   Calendar(full CRUD), Drive  [Dev Preview] │     - extract/expire facts │ │
│   │ Gmail API direct (send + sync tokens)       │     - consolidate, reflect │ │
│   │ Obsidian vault: synced files (+ plugin MCP  │     - cluster friction →   │ │
│   │   when Obsidian is running)                 │       DRAFT SKILL          │ │
│   │ Ingestion daemon + ~/inbox/ capture folder  │     - test-gate → register │ │
│   │ (iMessage/Slack/Telegram/browser: custom)   │     - retire losers, cap N │ │
│   └─────────────────────────────────────────────┘     - re-embed, purge      │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Component choices, justified by verified findings:**

| Layer | Choice | Why (finding §) |
|---|---|---|
| Philosophy | Harness around a cloud LLM; brain ≠ agent | §3.2 harness layer; gbrain seam §6.1 |
| Agent runtime | **Claude Agent SDK** (Python/TS — TS recommended to keep one language with connectors) | Native Agent Skills execution + MCP client (§3.1); accept Claude lock-in (§1.1). Hedge: keep skills in the open SKILL.md standard so a Deep Agents migration is cheap |
| Memory store | **Single Postgres + pgvector** you own; dedicated **personalized-memory** tables (temporal facts, provenance) distinct from episodic/semantic stores | §2.1 personalized layer; §2.4 don't buy on benchmarks; gbrain schema §6.2 |
| Optional graph | Add **Graphiti** (Apache 2.0) later if typed edges + recency decay prove insufficient for relationship/time queries | §2.2 |
| Skills | SKILL.md library, progressive disclosure; **test-gated creation + outcome-driven retirement + bounded cap + monthly human curation** | §3.1, §3.3 MUSE, §3.4 SkillsBench/Ratchet |
| Gmail/GCal | Google-managed MCP (Calendar full write; Gmail read/draft/label) + direct Gmail API for send/sync | §4.1 |
| Obsidian | Synced vault files as primary; plugin's built-in MCP as secondary | §4.2 |
| Interfaces | Telegram bot primary; CLI on the VM; voice routed through the agent | §5 |
| Cost safety | Model tiering + spend log + daily budget gate | gbrain §6.7 — non-negotiable for unattended 24/7 |

**Build order:** (1) Postgres schema + facts/user-model tables + inbox-folder ingestion → (2) Claude Agent SDK loop + Telegram → (3) Google MCP + Obsidian sync → (4) dream cycle → (5) friction logging → (6) the governed skill loop. Self-improvement comes *last* because §3.4 shows it is net-negative without the gates built first.

---

## Refuted claims (transparency)

| Claim | Vote |
|---|---|
| Claude Agent SDK supports only sandbox-local execution vs Deep Agents' remote-sandbox option | 0-3 |
| Mem0 achieves 26% improvement over OpenAI memory on LOCOMO (LLM-as-Judge) | 1-2 |
| Zep beats MemGPT/Letta on DMR (94.8% vs 93.4%) | 0-3 |
| Zep: up to 18.5% accuracy gain and 90% latency reduction on LongMemEval vs full-context | 1-2 |

## Caveats

- **Vendor-authored evidence:** Mem0's latency figure is from Mem0's own paper (single benchmark, single model); Zep's architecture description is from Zep's paper (descriptive, so acceptable); Google and Anthropic facts come from their own docs (appropriate for availability/format claims, but expect marketing framing).
- **Preprint-heavy:** the Externalization survey, MUSE-Autoskill, SkillsBench, and Library Drift/Ratchet are all 2026 arXiv preprints, not peer-reviewed, mostly self-reported results without independent replication. Treat exact numbers (+10.51pp, 0.258→0.584) as indicative, not load-bearing.
- **Number correction:** cite SkillsBench as arXiv 2602.12670 with "−1.3pp average" for self-authored skills; the "+0.0pp" figure is a secondary paper's rounding.
- **Developer Preview risk:** Google Workspace MCP servers (Gmail/Calendar/etc.) are preview, may change, lack a Gmail send tool, and consumer-account support is undocumented.
- **Time-sensitivity:** everything verified as of 2026-06-10 in a fast-moving field; the Anthropic skills roadmap is "partially realized," the open Agent Skills standard is ~6 months old, and obsidian-local-rest-api's MCP server shipped 4 weeks ago.
- **Coverage gaps:** no verified claims on Letta's 2026 state, CrewAI/Mastra/OpenAI Agents SDK, vector-DB selection, Telegram/voice tooling, or iMessage/Slack/browser ingestion — those parts of the recommendation are judgment, not verified findings.

## Open questions

1. How does Letta's 2026 runtime + memory architecture actually compare to a Zep/Graphiti or self-hosted Postgres design? The vendor benchmark disputes (3 refuted claims) left head-to-head quality genuinely unresolved.
2. Do Google's Workspace MCP servers work with consumer @gmail.com accounts, and when do they reach GA / gain a send-email tool?
3. What is the best 2026 voice pipeline (STT/TTS/duplex) for a single-user Telegram-mediated agent — and does any framework integrate it with persistent agent memory out of the box?
4. Can the Ratchet-style skill-governance results (single benchmark, code tasks) transfer to a personal-assistant skill library where "outcomes" are fuzzy — what is the right outcome signal for retiring a personal skill?
