# Gap-Fill Research: Letta, Voice Pipeline, Telegram Layer, Hard-Source Ingestion

**Date:** 2026-06-10
**Method:** Targeted gap-fill round with 3-vote adversarial verification; 25 claims survived. Companion to [second-brain-architecture-report.md](./second-brain-architecture-report.md) — this round covers ONLY the gaps that report flagged as unverified (its §1.2, §4.3, §5, and open questions 1 and 3). Findings below merge semantic duplicates; per-claim votes are cited inline.
**Scope note:** Strong verified coverage landed on Letta (8 claims), Pipecat+Mem0 voice memory (4), Telegram long-polling vs webhooks (4), iMessage ingestion (6), and Slack user-token export (3). **No claims survived** on CrewAI / Mastra / OpenAI Agents SDK / Pydantic AI, LiveKit Agents, OpenAI Realtime API, aiogram, browser-history capture, or ChatGPT/Claude history import — those remain engineering judgment, flagged as such in §6.

---

## Executive summary

The headline answer: **nothing in this round overturns the recommended architecture** (Claude Agent SDK + self-owned Postgres/pgvector memory engine + Telegram thin client) — and the Letta findings actively strengthen it. Letta's memory design is genuinely good (always-in-context memory blocks; built-in sleep-time consolidation agents), but its **self-host Docker path now carries an official deprecation notice** ("no longer an actively maintained or supported Letta product surface"), its self-hosted storage layer is **the same Postgres+pgvector substrate** you'd build yourself, and Letta Cloud's API plan imposes a **$20/month platform floor** before any LLM usage — so the honest assessment is *steal Letta's patterns, don't return to the platform*. On voice, Pipecat ships a first-party Mem0 memory service that does automatic capture and per-utterance retrieval inline in the voice pipeline — proof the "voice with persistent memory" problem is solved in 2026, and the designated upgrade path if you outgrow Telegram voice notes. On the Telegram layer, both grammY's and python-telegram-bot's official docs converge: **long polling is the correct default** for an always-on single-user bot (zero inbound networking, no domain/SSL/port constraints). On ingestion, the iMessage story is confirmed two-track (BlueBubbles on a Mac host for near-real-time + imessage-exporter, which runs on Linux, for backfill), and the Slack user-token export path (self-provisioned xoxp app, public + private channels, no admin export needed) is verified end-to-end including survival of Slack's 2025 rate-limit crackdown.

---

## 1. Letta in 2026 — the honest assessment

### 1.1 Memory blocks: always-in-context core memory *(verified, high confidence)*

Letta's core memory unit is the **memory block**: a structured, labeled section of the agent's context window that persists across all interactions and is **always visible — no retrieval step** (vote 3-0). Each block has exactly four fields — `label`, `description`, `value`, and a character-count `limit` — and the **`description` is the primary signal the agent uses to decide how to read/write the block**; the default `persona` and `human` blocks get auto-generated descriptions (vote 3-0). Blocks **can be shared between multiple agents** ("update once, visible everywhere"), and they are the unit sleep-time agents operate on (vote 2-1).

- Source: https://docs.letta.com/guides/core-concepts/memory/memory-blocks + https://docs.letta.com/guides/agents/architectures/sleeptime/ (both fetched live 2026-06-10)
- **Architectural contrast with your Postgres memory engine:** memory blocks are *in-context* memory (pinned to the system prompt, XML-formatted), versus retrieval-based memory where everything must be searched and fetched. Important scoping: this is a per-tier contrast, not per-system — Letta's archival/recall tiers are themselves retrieval-based (and pgvector-backed), and blocks are size-limited (~2,000 chars default), so they hold only a bounded always-visible core.
- **What to steal:** a small set of size-bounded, labeled, *always-injected* user-model blocks (persona, human, current-projects) rendered from your `facts` table into every prompt — Letta's design proves the description field and the hard character limit are the two load-bearing details.

### 1.2 Sleep-time agents: built-in background memory consolidation *(verified, medium confidence — feature is experimental and in architectural transition)*

Letta supports dedicated background **sleep-time agents** that share memory blocks with a primary agent and modify them asynchronously while running in the background (vote 2-1). Enabling it is a single flag — `enable_sleeptime: true` at agent creation — which auto-provisions a primary agent (with `conversation_search` / `archival_memory_search` tools) plus a paired sleep-time agent with tools to manage the primary's memory blocks (vote 3-0; corroborated by the letta-python SDK, fires every N steps, default 5).

- Source: https://docs.letta.com/guides/agents/architectures/sleeptime/
- **Caveats that drove the split votes:** (a) the docs themselves label sleep-time agents "experimental and may be unstable" and warn frequent triggering "can be expensive"; (b) Letta's official blog "Our next phase" (2026-03-16) announces server-side sleep-time agents **will be replaced** by a client-side subagent system, with memory moving to a git-backed MemFS. The capability exists as of June 2026, but you'd be building on an architecture the vendor has publicly scheduled for replacement.
- **What to steal:** this is exactly your planned nightly **dream cycle** (prior report §6.4) — a separate consolidation process operating on shared memory state. A plain Postgres+pgvector engine needs custom code for this, and that custom code is already in your build order.

### 1.3 Self-hosting Letta is now officially unsupported *(verified, high confidence)*

Letta's docs carry a deprecation notice: **"The Docker image is no longer an actively maintained or supported Letta product surface"** (vote 3-0; confirmed verbatim on two official pages, with the steer "use Letta Code local mode instead").

- Source: https://docs.letta.com/guides/docker/ + https://docs.letta.com/letta-code/docker/
- Softening context (does not change the conclusion): full Docker instructions are still published and `letta/letta` images were still being pushed as of 2026-05-14 (v0.16.8). But an always-on personal system built on a vendor-declared unsupported surface is a maintenance trap — this directly undermines the "self-host Letta on the VM" path.

### 1.4 Self-hosted Letta = the same substrate you'd build anyway *(verified, high confidence)*

The self-hosted deployment's storage layer is **PostgreSQL with the pgvector extension** (data persisted at `~/.letta/.persist/pgdata`, API on port 8283; external DBs must `CREATE EXTENSION IF NOT EXISTS vector`) (vote 3-0; corroborated by Docker Hub, GitHub issue #3200 showing Postgres is not swappable, and AWS's Aurora-PostgreSQL production writeup).

- Source: https://docs.letta.com/guides/docker/
- **Implication:** choosing self-hosted Letta over a DIY Postgres+pgvector engine is not a database decision — it sits on the identical substrate. The trade is Letta's runtime/orchestration layer (now deprecated as a self-host surface, §1.3) versus your own schema, which you control.

### 1.5 Letta Cloud pricing *(verified, high confidence)*

Letta Cloud's API plan — the plan required for automated/scripted usage and external apps (the Free Personal plan explicitly excludes automated API use) — costs **$20/month base + $0.10/active agent/month + $0.00015/sec tool execution + pay-as-you-go LLM usage** (vote 3-0). So a single always-on agent carries a ~$20.10/month fixed platform floor before any model spend.

- Source: https://docs.letta.com/guides/cloud/plans + https://docs.letta.com/letta-code/pricing
- Note: the docs' FAQ inconsistently calls the API plan "purely usage-based" — either reading still implies a fixed monthly platform cost that a self-hosted Postgres deployment doesn't have (though your VM has its own infra cost; the differentiator is the platform fee, not total TCO).

### 1.6 Verdict on returning to Letta

**Don't return to it as the foundation; mine it for design.** The three viable paths all lose to the recommended architecture for this use case: (a) self-host Docker — officially unsupported (§1.3); (b) Letta Cloud — $20/mo floor, data lives in their cloud, and the memory engine stops being *yours* (the prior report's central "brain = the moat, agent = replaceable" principle); (c) wait for the new client-side/MemFS architecture — announced but in transition, the worst time to commit. What you liked about Letta is reproducible on your own engine: memory blocks → bounded always-injected user-model sections (§1.1); sleep-time agents → the dream cycle you already planned (§1.2).

---

## 2. Other agent runtimes (CrewAI, Mastra, OpenAI Agents SDK, Pydantic AI)

**No claims survived adversarial verification in this round** — same outcome as the prior round. Two consecutive verification rounds failing to surface a verified reason to displace the Claude Agent SDK is itself weak evidence of the status quo: nothing here changes the runtime choice. Treat any specifics about these four frameworks as unverified; the prior report's reasoning stands (native SKILL.md execution + subagents + hooks + MCP client in the Agent SDK, with the open-standard skill format as the migration hedge).

---

## 3. Voice pipeline

### 3.1 Pipecat + Mem0: voice agents with persistent memory exist off-the-shelf *(verified, high confidence)*

Pipecat ships a **first-party Mem0 integration**: a `Mem0MemoryService` class in `pipecat.services.mem0` (in-tree in the pipecat-ai package), installed via `pip install "pipecat-ai[mem0]"` with a `MEM0_API_KEY` (vote 3-0; self-hosted Mem0 via `local_config` also supported). It is actively maintained — improved as recently as Pipecat v0.0.108 (March 2026), unchanged through the 1.0 migration.

How it works (all vote 3-0, confirmed in both Mem0's and Pipecat's own docs):

- The memory service is a **pipeline stage between the context aggregator and the LLM service** — retrieval/injection happens inline in the voice pipeline (`transport.input() → stt → user_context → memory → llm → transport.output()`), not in a separate application layer.
- **Capture is automatic:** every user/assistant message flowing through the pipeline is stored to Mem0 (keyed by `user_id` / `agent_id` / optional `run_id`), fire-and-forget in background threads, no explicit save calls.
- **On each new user utterance,** relevant memories are searched and injected into LLM context before generation, with tunable `search_limit` (default 10), `search_threshold` (0.0–1.0, default 0.1), and `add_as_system_message` (default true).
- Sources: https://docs.mem0.ai/integrations/pipecat + https://docs.pipecat.ai/server/services/memory/mem0 + pipecat-ai/pipecat repo (src/pipecat/services/mem0/)

### 3.2 What this means for your design

The verified finding proves real-time voice with persistent memory is a solved, productized pattern in 2026 — but note *whose* memory: the off-the-shelf path stores memory in **Mem0**, not your Postgres engine. Wiring Pipecat to your own memory engine means writing a custom frame-processor stage (the Mem0MemoryService source is the template — it's just a pipeline stage that intercepts context frames). **Recommendation unchanged from the prior report's §5:** start with the Telegram voice-note round-trip (voice note → STT → the same agent with your Postgres memory → TTS reply), because it reuses the entire agent + memory stack with zero new infrastructure. Adopt Pipecat *later* if you want full-duplex/low-latency conversation, implementing a thin custom memory stage against your MCP memory engine instead of Mem0.

### 3.3 Not verified this round

LiveKit Agents, the OpenAI Realtime API, and specific STT/TTS vendor choices for the Telegram round-trip (Whisper vs Deepgram; ElevenLabs vs OpenAI TTS) produced no surviving claims. The STT/TTS vendor choice is low-risk and swappable behind a skill; pick on price/latency at build time.

---

## 4. Telegram bot layer

### 4.1 Long polling is the official default for an always-on VM bot *(verified, high confidence — both major frameworks' docs agree)*

- **grammY** (TypeScript): the docs recommend long polling as the default for bots on always-on servers/VPSes — "If you don't have a good reason to use webhooks, then note that there are no major drawbacks to long polling, and — according to our experience — you will spend much less time fixing things. Webhooks can be a bit nasty from time to time." Long polling explicitly suits "machines that actively run your bot 24/7" (vote 3-0). Source: https://grammy.dev/guide/deployment-types
- **python-telegram-bot**: official wiki guidance is that polling "works fine for smaller to medium-sized bots and for testing"; "You should have a good reason to switch from polling to a webhook. Don't do it simply because it sounds cool" — webhooks pay off mainly under heavy traffic (vote 3-0). Source: https://github.com/python-telegram-bot/python-telegram-bot/wiki/Webhooks
- A single-user personal agent is the smallest possible bot; both ecosystems put it squarely in long-polling territory.

### 4.2 Long polling needs zero inbound networking; webhooks need HTTPS + four allowed ports *(verified, high confidence)*

- Long polling: **no domain, no public URL, no SSL certificate** — `bot.start()` and done; outbound HTTPS to api.telegram.org is the only network requirement, works behind NAT/firewalls (vote 3-0; corroborated by Telegram's official webhook guide). One process per bot token (409 Conflict otherwise).
- Webhooks: **HTTPS/TLS mandatory** (no plain HTTP) and Telegram delivers only to ports **443, 80, 88, 8443** (vote 3-0; core.telegram.org/bots/webhooks + Bot API setWebhook reference). All of that is infrastructure a long-polling VM deployment avoids entirely.
- Sources: https://grammy.dev/guide/deployment-types, https://github.com/python-telegram-bot/python-telegram-bot/wiki/Webhooks, https://core.telegram.org/bots/webhooks

### 4.3 Framework pick

aiogram produced no verified claims. Between the two verified options, **grammY** wins on language coherence if the agent runtime is TypeScript (the prior report's recommendation — one language across runtime + connectors); python-telegram-bot is the equivalent choice in a Python stack. Either way: **long polling, no webhook infrastructure.**

---

## 5. Ingestion for the hard sources

### 5.1 iMessage — two-track: Mac-host relay for real-time, cross-platform exporter for backfill

**BlueBubbles (real-time track)** *(verified, high confidence on capability; medium on the macOS-only framing — vote 2-1 on that component)*:

- BlueBubbles server is a macOS-only relay — it **cannot run directly on a Linux cloud VM** (macOS-native dependencies: AppleScript, node-mac-permissions, direct chat.db access). A Mac host (e.g., Mac mini relay) is the practical requirement; the only documented workaround is a full macOS VM (Docker-OSX/KVM), which cloud VMs rarely support and Apple's terms frown on (vote 2-1). Source: https://github.com/BlueBubblesApp/bluebubbles-server + https://bluebubbles.app/faq
- It exposes a **versioned REST API** (e.g., `POST /api/v1/message/text`, `GET /api/v1/message`, `POST /api/v1/chat/query`, attachment upload) alongside Socket.IO, password-authenticated, tunnel-friendly (ngrok/Tailscale) — programmatic access for a cloud-hosted agent is first-class (vote 3-0).
- Ingestion mechanism: it **reads the macOS iMessage chat.db and listens for new/updated messages** (event-driven polling), emitting webhooks for new messages/read receipts/typing — a near-real-time source, not a one-shot exporter (vote 3-0). Actively maintained (v1.9.9 May 2025, active triage into macOS 26). Known macOS Tahoe (26.x) rough edges: Private API helper injection issues on Tahoe beta (#776), an Electron crash on client connect (#761), and Tahoe's new `any;-;` chat GUID prefix confusing downstream consumers.

**imessage-exporter (backfill track)** *(verified, high confidence)*:

- A Rust CLI + `imessage_database` library exporting to txt/HTML; release **4.1.0 (2026-05-29)** supports every iMessage feature through **macOS Tahoe 26.5.x / iOS 26.5.x** — tapbacks, edited messages, replies/threads, attachments, audio, handwriting (vote 3-0; maintainer's self-claim, but the feature matrix is documented per-feature). Source: https://github.com/ReagentX/imessage-exporter
- Reads `~/Library/Messages/chat.db` by default but `--db-path` accepts **the root of an iOS device backup — including encrypted backups** (`--cleartext-password` or interactive prompt, v4.1.0) (vote 3-0).
- The binary **runs on macOS, Linux, and Windows** — so your cloud Linux VM can run it against a copied chat.db or synced iPhone backup; non-macOS needs ImageMagick + ffmpeg for attachment conversion (HEIC→JPEG, CAF/MOV→MP4) (vote 3-0). Caveat: you still need to *get* the backup/chat.db to the VM; it does not pull from iCloud.

**Recommended iMessage pipeline:** Mac mini (or any always-on Mac) running BlueBubbles → webhook/REST into the VM's ingestion daemon for near-real-time; periodic imessage-exporter runs (on the Mac, or on the VM against a synced backup) for full-fidelity historical backfill and as the fallback if the relay dies.

### 5.2 Slack — user-token self-service export works, no admin needed *(verified, high confidence)*

- **sebseager/slack-exporter** exports messages + file attachments from **public AND private channels** (anything your account can see, incl. DMs/MPIMs) via Slack's Conversations API (`conversations.list/history/replies`, `files.list`), as a standalone Python script or Flask bot. Repo active (last push 2026-03-07) (vote 3-0). Source: https://github.com/sebseager/slack-exporter
- Auth is a **personal xoxp user-level OAuth token**, self-provisioned by creating a personal Slack app from the repo's `slack.yaml` manifest and installing it to the workspace — no admin-issued export required (vote 3-0).
- Slack's own token docs confirm the premise: **user tokens grant the same access the user has** — "the channels, conversations, users, reactions, and so on that they can see" — gated by requested scopes (`channels:history`, `groups:history`, `im:history`, `mpim:history`); bot tokens cannot reach your DMs/private channels (vote 3-0). Source: https://docs.slack.dev/authentication/tokens
- **Rate-limit crackdown survived:** Slack's May 29, 2025 cuts (1 req/min, 15 messages on conversations.history for non-Marketplace apps) were the strongest refutation candidate, but Slack's June 3, 2025 clarification exempts "internal customer-built apps" — which a personal app created in your own workspace is. Residual risk: employer-controlled workspaces with admin app-approval can block the install.

### 5.3 Not verified this round

Browser history / read-later capture and ChatGPT/Claude conversation-history import produced no surviving claims. Engineering judgment: both vendors ship account-level data export (JSON archives) suitable for one-shot import into the ingestion daemon; browser capture is best handled via the `~/inbox/` capture-folder pattern (prior report §4.3) plus a read-later service's export until a verified connector emerges. Treat as unverified.

---

## 6. Updated recommendations

**Does anything change the recommended architecture (Claude Agent SDK + Postgres memory engine + Telegram thin client)? No — it survives this round strengthened.** Specific updates:

| Decision | Update | Basis |
|---|---|---|
| Agent runtime | **Unchanged: Claude Agent SDK.** Second consecutive round with no verified challenger (CrewAI/Mastra/OpenAI SDK/Pydantic AI all unverified) | §2 |
| Letta | **Do not return.** Self-host surface officially deprecated; Cloud = $20/mo floor + brain leaves your control; new architecture in transition. Steal: bounded always-in-context memory blocks (label/description/value/limit) rendered from your facts table; sleep-time pattern ≈ your dream cycle | §1.1–1.6 |
| Memory engine | **Unchanged: your Postgres + pgvector.** Self-hosted Letta runs on the identical substrate — the DIY path forgoes a deprecated runtime, not a better database. Add a "core blocks" view: 2–4 size-capped user-model sections injected into every agent prompt | §1.1, §1.4 |
| Telegram layer | **Confirmed: long-polling thin client** (grammY if TS, python-telegram-bot if Python). Zero inbound networking; skip webhooks/SSL/port management entirely | §4 |
| Voice | **Unchanged for v1:** Telegram voice note → STT → same agent → TTS. **Named upgrade path:** Pipecat, replacing its Mem0MemoryService with a thin custom pipeline stage that hits your MCP memory engine (the inline retrieve→inject→auto-store pattern is verified and copyable) | §3 |
| iMessage | **New, concrete:** Mac mini relay running BlueBubbles (REST + webhooks → ingestion daemon) for near-real-time; imessage-exporter (runs on the Linux VM against synced backups) for backfill + fallback. Budget for Tahoe quirks | §5.1 |
| Slack | **New, concrete:** personal xoxp app from slack-exporter's manifest; ingest public+private+DM history via Conversations API into the daemon. Works without admin export; verify your workspace allows self-installed apps | §5.2 |
| Browser / LLM-chat history | Still unverified — use export archives + inbox-folder capture; defer connectors | §5.3 |

**Build-order impact:** none to the prior report's sequence. The iMessage Mac-relay is the only new hardware dependency (an always-on Mac); everything else slots into the existing ingestion-daemon design.

---

## Caveats

- **Vendor docs dominate:** nearly all Letta, Pipecat/Mem0, and Slack findings come from the vendors' own documentation — appropriate for behavior/pricing/API-shape claims, but expect framing; no independent benchmarks were claimed or verified here.
- **Letta is mid-transition:** sleep-time agents are documented as experimental, and Letta's March 2026 blog schedules the server-side architecture (and the Docker surface) for replacement by a client-side/MemFS design. Any Letta specifics here may be stale within months; the *deprecation* finding is the durable one.
- **Letta pricing inconsistency:** the docs' own FAQ contradicts the $20/mo pricing card ("purely usage-based") — the fixed-floor conclusion holds on either reading, but exact dollars may shift.
- **Split votes:** sleep-time architecture claims (2-1, 2-1) split over the transition question; BlueBubbles "macOS-only" (2-1) split over the macOS-VM-on-Linux loophole. Both findings carry those qualifications above.
- **Mem0 vs your engine:** the verified Pipecat memory integration is Mem0-specific; "swap in your own memory stage" is an inference from the (verified) pipeline-stage architecture, not a verified product feature.
- **Slack rate limits:** the internal-app exemption rests on Slack's June 2025 clarification; policy could tighten again, and the March 3, 2026 enforcement wave for distributed apps shows Slack is actively moving here.
- **iMessage/Tahoe:** BlueBubbles' macOS 26 issues (#761, #776, GUID prefix change) are open at time of writing; "every iMessage feature" for imessage-exporter is the maintainer's claim.
- **Coverage gaps remain:** CrewAI/Mastra/OpenAI Agents SDK/Pydantic AI, LiveKit, OpenAI Realtime, aiogram, STT/TTS vendor choice, browser capture, and ChatGPT/Claude import are all still unverified.

## Open questions

1. When Letta's client-side subagent + git-backed MemFS architecture ships, does it become a viable *library* (rather than platform) to embed over your own storage — i.e., worth a re-evaluation round in late 2026?
2. What is the cheapest reliable Mac-host option for the BlueBubbles relay (home Mac mini vs hosted Mac (MacStadium/AWS EC2 Mac) vs iPhone-backup-sync-only with no relay), and how do Tahoe's Private API breakages settle?
3. For the eventual Pipecat upgrade: what is the latency budget of an MCP round-trip to the Postgres memory engine inside a real-time voice pipeline, and does it require a local cache layer (Letta-style in-context blocks) to stay conversational?
4. Do ChatGPT and Claude account exports preserve enough structure (timestamps, threading, tool calls) for faithful episodic-memory import, and at what cadence can they be re-exported without manual clicking?
