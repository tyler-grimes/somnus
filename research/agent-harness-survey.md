# Agent Harness Survey: Adopt vs Build for the Second-Brain Plumbing Half

**Date:** 2026-06-10
**Scope:** Agent/interface plumbing only (Telegram wiring, sessions, voice, MCP client, skills, scheduling, multi-interface). The memory engine (Postgres) is being built in-house and is out of scope here.
**Primary target analyzed:** [openclaw/openclaw](https://github.com/openclaw/openclaw) — clone at `/tmp/openclaw-survey`, commit `418d7e1e83c560c14139cd8c1e043b8f374a446c` (2026-06-10, v2026.6.2 in package.json; latest stable release v2026.6.5). All `file:line` references below are relative to the repo root at that commit.

---

## TL;DR — Recommendation: **ADOPT OpenClaw** (with a hardening checklist), NanoClaw as the adopt-lite fallback

OpenClaw is the project the gbrain analysis referenced ("OpenClaw/Hermes" host agent). It was renamed from **Clawdbot → Moltbot → OpenClaw** in late 2025 and is now the most-starred non-aggregator repo on GitHub (~378k stars). Every single item on the plumbing requirements list — Telegram via grammY, durable sessions, voice-note STT/TTS, **native MCP client**, SKILL.md skills, SQLite-persisted cron with proactive channel delivery, and CLI/WebChat/HTTP interfaces sharing the same sessions — is already implemented and documented. It even ships a native "dreaming" memory-consolidation cycle. The integration point for the Postgres brain is a one-stanza config change (`mcp.servers`). The costs: a very large (~20k file) fast-moving codebase you won't fully audit, and a rough security history that demands disciplined hardening. A from-scratch build (grammY + Agent SDK + pg-boss) is ~2-4 weeks to reach 60% of this; the remaining 40% (streaming-to-chat ergonomics, pairing, compaction, multi-interface) is where the real time goes.

---

## 1. What OpenClaw is

- "Multi-channel AI gateway with extensible messaging integrations" (`package.json:3`); README: "Your own personal AI assistant. Any OS. Any Platform."
- Single long-lived Node gateway daemon owning all channels, sessions, and provider connections; CLI/apps/web UIs connect as WebSocket control-plane clients (`docs/concepts/architecture.md:8-50`). Not gateway+workers — one process.
- MIT license, "OpenClaw Foundation" (`LICENSE:1-3`). Node >= 22.19.0 required (`package.json` engines), Node 24 in Docker.
- The agent loop is **its own** (adapted from Mario Zechner's pi-mono, credited in `THIRD_PARTY_NOTICES.md` — upstream `github.com/earendil-works/pi-mono`). It is **not** built on the Claude Agent SDK. Multi-provider via `packages/llm-core` + model catalog; Anthropic/OpenAI/etc. with fallback chains (`agents.defaults.model.primary` / `.fallbacks`).

## 2. Architecture: Telegram → agent loop → Telegram

**Inbound path:**
1. **grammY** bot (`grammy@1.43.0`, `@grammyjs/runner`, `@grammyjs/transformer-throttler` — `extensions/telegram/package.json`; re-exported at `extensions/telegram/src/bot.runtime.ts:4`). Bot created in `createTelegramBotCore()` (`extensions/telegram/src/bot-core.ts:108`), polling by default, webhook optional; sequentialized + API-throttled middleware.
2. Handlers registered in `extensions/telegram/src/bot-handlers.runtime.ts` (~line 150-169; message handler ~1695). Inbound text fragments are **debounced ~1.5s and aggregated** before dispatch (`bot-handlers.runtime.ts:475-575`) — nice touch for people who send four-message bursts.
3. Normalization into a channel-agnostic envelope: `buildTelegramInboundContextPayload()` (`extensions/telegram/src/bot-message-context.session.ts:157-203`) → `BuiltChannelInboundEventContext`.
4. Dispatch into the gateway contract `runChannelInboundEvent()` (`extensions/telegram/src/bot-message-dispatch.ts:1873-1894`) with an adapter exposing `ingest()` / `resolveTurn()` / `runDispatch()`.
5. Agent execution: `Agent` class (`packages/agent-core/src/agent.ts:202`) and `runAgentLoop()` (`packages/agent-core/src/agent-loop.ts:164`; 901-line file — compact, readable).

**Outbound path:** reply pipeline (`bot-message-dispatch.ts:1852-1870`) → `sendMessageTelegram()` et al. in `extensions/telegram/src/send.ts`, with markdown→Telegram-HTML conversion via `markdownToTelegramHtml()` (`extensions/telegram/src/format.ts:139`).

**Sessions:** keyed per channel+chat(+thread): `agent:<agentId>:telegram:<chatId>` for DMs, group/topic variants for forums (`extensions/telegram/src/conversation-route.ts`). Store path per agent (`bot-message-context.session.ts:94-102`; `src/config/sessions/store.ts`). `/reset` and `/new` commands (`src/auto-reply/reply/commands-reset.ts:35-109`), `/compact` context compaction (`src/auto-reply/reply/commands-compact.ts`), per-session history limits (`src/auto-reply/reply/history.ts:50-63`).

**Long-running turns:** typing indicators sent early and coalesced on a 4s window (`bot-message-dispatch.ts:674-687`, constant ~line 100; `sendTypingTelegram()` at `send.ts:1029`). Streaming draft replies gated on `DRAFT_MIN_INITIAL_CHARS = 30` (`bot-message-dispatch.ts:155`), lane-based delivery (tool progress / reasoning / answer). Chunking via `splitTelegramPlainTextChunks()` (`send.ts:170`), 4000-char chunks (`send.ts:771-773`), sequenced sends with throttling (`send.ts` ~708-752).

## 3. Voice

- **Inbound voice notes → STT:** handled by the media-understanding pipeline — `runAudioTranscription()` (`src/media-understanding/audio-transcription-runner.ts:15-53`). Providers via plugin extensions: OpenAI, Deepgram (`extensions/deepgram/audio.ts`, nova-3), Mistral, Google, Azure Speech, xAI, plus a local-CLI escape hatch (`type: "cli"` in `src/config/types.tools.ts:34-124` — e.g. whisper.cpp). Telegram voice-note vs audio-file distinction documented at `docs/channels/telegram.md:679-685`; transcripts feed mention-gating and the agent prompt (`{{Transcript}}` template var).
- **Outbound TTS:** `src/tts/tts.ts` (`synthesizeSpeech`/`streamSpeech`), provider registry `src/tts/provider-registry.ts:1-63`; ElevenLabs/OpenAI/Azure/Google/Inworld/local-CLI. Telegram voice-note replies via `resolveTelegramVoiceSend()` (`extensions/telegram/src/voice.ts:4-36`, ogg/mpeg/mp4 with fallback).
- Bonus: full phone-call plugin (Twilio/Telnyx/Plivo) with realtime STT/TTS (`extensions/voice-call/`, `docs/plugins/voice-call.md`).

**Verdict: complete STT/TTS round-trip, config-only.**

## 4. MCP client support — the critical integration point

**Native, first-class.** Not delegated to an underlying coding agent.

- Config schema: `McpServerConfig` (`src/config/types.mcp.ts:24`) supports **stdio** (`command`/`args`/`env`/`cwd`) and **HTTP** (`url`, `transport: "sse" | "streamable-http"` at `types.mcp.ts:40`), timeouts, mTLS, OAuth (tokens in state, not config). Declared under `mcp.servers` in `~/.openclaw/openclaw.json` (`docs/gateway/configuration-reference.md:89-186`).
- Runtime: `SessionMcpRuntimeManager` (`src/agents/agent-bundle-mcp-runtime.ts:1`, factory ~line 864) connects per session, calls `listTools()`, applies per-server/global `toolFilter`, and surfaces MCP tools as **native agent tools** in the loop; materialization in `src/agents/agent-bundle-mcp-materialize.ts`.
- CLI management: `openclaw mcp add | set | configure | tools | login` (`docs/cli/mcp.md`).
- OpenClaw can also act as an MCP **server** (`openclaw mcp serve`, `src/mcp/tools-stdio-server.ts`) — useful later if Claude Code should drive the same gateway.

## 5. Skills

- Claude-style **SKILL.md** (YAML frontmatter + markdown body) with OpenClaw extensions (`metadata.openclaw.requires/install`) — example `skills/nano-pdf/SKILL.md:1-39`; ~100 bundled skills in `skills/`.
- Loader walks workspace `.openclaw/skills/` (highest precedence), bundled, and `skills.load.extraDirs` (`src/skills/loading/workspace.ts`); entries typed in `src/skills/types.ts:83-91`; injected into the system prompt via `formatSkillsForPrompt()` (`src/agents/sessions/system-prompt.ts:73`).
- **Not sandboxed by default** — skills inherit the agent's exec policy; only remapped into the container when sandboxing is on (`src/agents/embedded-agent-runner/sandbox-skills.ts:62-89`). Treat third-party skills as untrusted code (see §7).

## 6. Scheduling / proactive messages — dream-cycle ready

- Built-in **cron service** in the gateway (`src/cron/`): `service.ts` (runtime), `store.ts` (**SQLite-persisted** jobs), `run-log.ts` (history). Job types: `at` (one-shot), `every` (interval), `cron` (5/6-field + timezone).
- Execution styles: main-session system event, **isolated agent turn** (fresh `cron:<jobId>` session), persistent custom session, or plain shell command (`docs/automation/cron-jobs.md`).
- **Proactive delivery:** `--announce --channel telegram --to <recipient>` pushes the run output to a channel via `sendCronAnnouncePayloadStrict()` (`src/cron/delivery.ts`). Exactly what dream-cycle pings need.
- Separate **heartbeat** wake mechanism (`agents.defaults.heartbeat.every`) for ambient check-ins.
- Notably, OpenClaw already has its own **"dreaming"** memory-consolidation subsystem (`plugins.entries.memory-core.config.dreaming`, `docs/concepts/dreaming`, `DREAMS.md` diary in `docs/concepts/memory.md`) — conceptual validation of the user's design, and a slot to displace.

## 7. Maturity & security posture

| Metric | Value (2026-06-10, GitHub API) |
|---|---|
| Stars / forks | 378,061 / 79,063 |
| Open issues+PRs | ~7,997 (high; triage lags growth) |
| Contributors | 363 listed by API; trackers cite 2.3k+ |
| Created | 2025-11-24 (≈6.5 months old; Clawdbot/Moltbot lineage) |
| Releases | CalVer, near-daily betas, ~weekly stables (v2026.6.1→v2026.6.6-beta.1 in one week) |
| License | MIT |

**Security history is the big caveat.** Early 2026: [CVE-2026-25253](https://thehackernews.com/2026/02/clawjacked-flaw-lets-malicious-sites.html) one-click RCE (CVSS 8.8, patched v2026.1.29); "ClawJacked" WebSocket hijack; [CVE-2026-32922 privilege escalation](https://www.armosec.io/blog/cve-2026-32922-openclaw-privilege-escalation-cloud-security/); the **ClawHavoc** campaign — [341+ malicious skills on ClawHub](https://www.termdock.com/en/blog/clawhub-malicious-skills-incident) (AMOS infostealer; later scans claimed ~800); [30k+ internet-exposed gateways](https://thenewstack.io/openclaw-github-stars-security/) found unauthenticated. Project response: VirusTotal skill scanning, an in-repo OpenGrep rulepack run on every PR (`security/README.md:1-137`), and an explicit threat model (`SECURITY.md:4-7`): single trusted operator, **not** a multi-tenant boundary; prompt injection without a policy bypass is out of scope (`SECURITY.md:45-116`).

**Real mitigations available (off by default — turn them on):** `gateway.bind: loopback` + auth token; DM pairing default (`dmPolicy: "pairing"`, 8-char codes, 1h expiry — `docs/channels/pairing.md:10-47`); Docker/SSH sandbox runtimes (`agents.defaults.sandbox.mode`, default `off` — `SECURITY.md:142-145`); exec approval gates binding command/cwd/env (`SECURITY.md:237-239`); `tools.fs.workspaceOnly` / `applyPatch.workspaceOnly`; plugin allowlist `plugins.allow` (plugins run **in-process, unsandboxed** — `SECURITY.md:147-153`); non-root Docker image with `cap_drop` + `no-new-privileges` (`docker-compose.yml:56-60`).

**Hardening checklist for this deployment:** loopback bind (Tailscale for remote), token auth, pairing-mode Telegram DMs, `sandbox.mode: "non-main"` or `"all"`, zero ClawHub skills (hand-write the few needed), pin a release and review CHANGELOG before upgrades, HTTP endpoints stay disabled.

## 8. Extensibility

- **CLI interface: already exists.** `openclaw chat` / `openclaw tui` attach to the same gateway sessions (`docs/cli/tui.md`, `--session <key>`); WebChat and Control UI over the same WebSocket RPC (`docs/web/webchat.md`, `docs/web/control-ui.md`); optional OpenAI-compatible `/v1/chat/completions` + `/v1/responses` HTTP endpoints (disabled by default). Custom clients implement the documented WS protocol (`docs/gateway/protocol.md`, challenge-signed connect, typed req/res/event frames, protocol v4).
- **Custom MCP servers:** config-only (§4).
- **Hooks:** rich typed lifecycle system (`docs/plugins/hooks.md`) — `before_tool_call` / `after_tool_call`, `agent_turn_prepare`, `before_prompt_build`, `message_received` / `message_sent`, `session_start/end`, `before/after_compaction`, plus operator-level `HOOK.md` scripts (`docs/automation/hooks.md`). Plugin SDK (`packages/plugin-sdk`, `definePluginEntry({register(api)})`) with capability registration (`api.registerChannel`, `registerProvider`, `registerSpeechProvider`, ... — `docs/plugins/architecture.md:32-286`). Adding a channel is a documented contract (`docs/plugins/sdk-channel-plugins.md`).
- **Memory is a pluggable slot:** `plugins.slots.memory` selects the active memory plugin or `"none"` (`docs/gateway/configuration-reference.md:358`); built-in is SQLite FTS5+vector hybrid (`docs/concepts/memory-builtin.md`); Honcho shows a third-party backend precedent (`docs/concepts/memory-honcho.md`); `packages/memory-host-sdk` is the engine SDK.

---

## 9. Integration sketch: plugging the Postgres brain into OpenClaw

```
Telegram ⇄ OpenClaw gateway (daemon, loopback+token)
              │  agent loop (pi-derived, packages/agent-core)
              ├─ mcp.servers.gbrain  ──stdio/streamable-http──▶  YOUR Postgres memory MCP server
              │     tools: memory_store / memory_recall / memory_link / ...
              ├─ cron: dream-cycle job (isolated session, --announce → telegram)
              ├─ hooks plugin (optional): agent_end / message_received → episodic capture into Postgres
              └─ openclaw chat (CLI), WebChat — same sessions
```

1. **Expose the brain as an MCP server** (stdio for same-host, `streamable-http` if containerized) and register it:
   ```json5
   // ~/.openclaw/openclaw.json
   {
     mcp: { servers: { gbrain: {
       command: "node", args: ["/path/to/brain-mcp/dist/index.js"],
       env: { DATABASE_URL: "postgres://..." }
     } } }
   }
   ```
   Tools appear natively in every agent turn via `SessionMcpRuntimeManager` (`src/agents/agent-bundle-mcp-runtime.ts`). Use `toolFilter` to keep the surface tight.
2. **Displace built-in memory:** set `plugins.slots.memory: "none"` and disable `memorySearch`, so the Postgres brain is the sole long-term store (optionally keep `MEMORY.md` as cheap scratch). Add a system-prompt nudge (workspace `AGENTS.md`) telling the agent to use `gbrain` tools for recall/store.
3. **Dream cycle:** `openclaw cron create "0 4 * * *" --name dream --session isolated --message "Run the dream cycle: consolidate today's memories via gbrain tools" --announce --channel telegram --to <you>`. Jobs persist in SQLite; run history via `openclaw cron runs`.
4. **Voice:** set `tools.media.audio` provider (OpenAI/Deepgram or local whisper CLI) — inbound Telegram voice notes auto-transcribe into the turn; optionally TTS replies.
5. **Capture hooks (optional, later):** small plugin registering `agent_end` / `message_received` to stream episodic events into Postgres outside the tool-call path.
6. **Harden** per the checklist in §7.

Deeper alternative if MCP latency/granularity disappoints: implement a `memory-host-sdk` engine so the brain serves the native `memory_search`/`memory_get` tools — but start with MCP; it's the designed seam and matches gbrain's original architecture.

---

## 10. Alternatives (web survey only, not cloned)

- **[NanoClaw](https://github.com/qwibitai/nanoclaw)** — "lightweight alternative to OpenClaw that runs in containers for security." ~3,900 LOC across ~15 files, MIT, **built directly on Anthropic's Claude Agent SDK** (so SKILL.md, MCP, and the Claude Code toolset come from the SDK, not bespoke code). WhatsApp/Telegram/Slack/Discord/email channels, memory, scheduled jobs; every agent group runs in an isolated Docker (or Apple Container) sandbox with explicit mounts. This is essentially the "grammY + Agent SDK" hand-roll already written and auditable in an afternoon — the strongest fallback if OpenClaw's size/security record is disqualifying, and the best code reference for a BUILD path.
- **[HKUDS/nanobot](https://github.com/HKUDS/nanobot)** — lightweight open-source agent from the HKU data-science group; gateway mode wires Telegram, Discord, WhatsApp, Slack, and email to an agent loop, plus WebUI/API. MCP support landed v0.1.4 (Feb 2026); active releases through v0.2.x with project workspaces and broader provider support. Python ecosystem; smaller and simpler than OpenClaw but younger plumbing (streaming/chunking/pairing less battle-tested).
- **[Hermes Agent](https://www.scriptbyai.com/hermes-agent/)** — the "Hermes" in the gbrain report's "OpenClaw/Hermes" reference; a self-improving personal agent covering Telegram/Discord/Slack/WhatsApp/Signal/email/CLI/desktop/web, with docs for memory, skills, MCP, cron — and a dedicated migration command that imports OpenClaw data. Worth watching as an OpenClaw-compatible escape hatch; too young to bet on as primary today.

---

## 11. Verdict

**ADOPT OpenClaw** for the plumbing half. Rationale: (a) requirement coverage is 100%, including the exotic ones (voice round-trip, proactive cron→Telegram, CLI+chat sharing sessions); (b) the brain integration is the *designed* seam (native MCP client + pluggable memory slot), so the in-house Postgres engine stays cleanly decoupled and portable — if OpenClaw goes sideways, the brain MCP server moves to NanoClaw/Hermes/hand-rolled host unchanged; (c) the Telegram ergonomics (debounced inbound bursts, draft streaming, typing coalescing, HTML conversion, chunking) represent months of polish that a rebuild would slog through.

**If BUILD is later forced** (e.g., security trajectory worsens), the components list: **grammY** (+runner/throttler) for Telegram; **@anthropic-ai/claude-agent-sdk** for the loop, SKILL.md, and MCP client for free; **pg-boss** on the existing Postgres for cron/dream-cycle; whisper.cpp or OpenAI STT for voice notes; a thin session-key→SDK-session map in Postgres; Ink or plain REPL for CLI. NanoClaw's source is the cheat sheet — that stack is precisely its architecture. Estimate 2-4 weeks to parity on the narrow feature set, with streaming-to-Telegram polish the long tail.

### Sources
- [openclaw/openclaw](https://github.com/openclaw/openclaw) (code at commit `418d7e1e`), [docs.openclaw.ai](https://docs.openclaw.ai/)
- [Star History — openclaw/openclaw](https://www.star-history.com/openclaw/openclaw/) · [The New Stack — most-starred status, but is it safe?](https://thenewstack.io/openclaw-github-stars-security/) · [Medium — OpenClaw beat React's record in 60 days](https://medium.com/@aftab001x/openclaw-just-beat-reacts-10-year-github-record-in-60-days-now-nobody-knows-what-to-do-with-it-937b8f370507)
- [The Hacker News — ClawJacked / CVE-2026-25253](https://thehackernews.com/2026/02/clawjacked-flaw-lets-malicious-sites.html) · [Termdock — ClawHub 341 malicious skills](https://www.termdock.com/en/blog/clawhub-malicious-skills-incident) · [ARMO — CVE-2026-32922](https://www.armosec.io/blog/cve-2026-32922-openclaw-privilege-escalation-cloud-security/) · [Conscia — the OpenClaw security crisis](https://conscia.com/blog/the-openclaw-security-crisis/) · [Infosecurity — six new vulnerabilities](https://www.infosecurity-magazine.com/news/researchers-six-new-openclaw/) · [Kaspersky — Clawdbot/Moltbot risks](https://www.kaspersky.com/blog/moltbot-enterprise-risk-management/55317/)
- [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) · [nanoclaw.dev](https://nanoclaw.dev/) · [VirtusLab on NanoClaw](https://virtuslab.com/blog/ai/nano-claw-your-personal-ai-butler) · [HKUDS/nanobot](https://github.com/HKUDS/nanobot) · [Hermes Agent](https://www.scriptbyai.com/hermes-agent/) · [agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw)
