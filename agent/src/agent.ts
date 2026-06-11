/**
 * The agent loop: Claude Agent SDK wired to the brain over MCP.
 *
 * Security posture:
 *  - Tool surface is brain-only: allowedTools whitelists mcp__brain__*, and
 *    canUseTool denies everything else as defense-in-depth (no Bash, no file
 *    tools, no web). Capabilities get added deliberately, one at a time.
 *  - settingSources: [] — no user/project Claude settings, hooks, or skills
 *    leak into this agent's runtime.
 *  - Budget gate runs before every turn; spend is logged after.
 */
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { logEpisode, logSpend, pool, spentTodayUsd } from "./db.js";

const BRAIN_MCP_PATH = path.resolve(
  import.meta.dirname,
  "../../brain-mcp/dist/index.js",
);

/** Letta-pattern always-in-context core blocks, rendered from the facts table. */
async function renderCoreBlocks(): Promise<string> {
  const res = await pool.query(
    `SELECT kind, claim
       FROM facts
      WHERE superseded_at IS NULL
        AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
        AND kind IN ('preference','commitment','belief','habit')
      ORDER BY notability DESC, recorded_at DESC
      LIMIT 30`,
  );
  if (res.rowCount === 0) return "(no core memory yet — this is a young brain)";
  const byKind = new Map<string, string[]>();
  for (const r of res.rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind)!.push(r.claim);
  }
  return [...byKind.entries()]
    .map(([kind, claims]) => `${kind}s:\n${claims.map((c) => `- ${c}`).join("\n")}`)
    .join("\n");
}

function buildSystemPrompt(coreBlocks: string): string {
  return `You are Tyler's second brain — a personal, always-on agent whose job is to organize what he's working on and to know him better than he knows himself.

# Core memory (always current — rendered from the brain at the start of this turn)
${coreBlocks}

# Memory discipline
- Before answering anything about Tyler's life, work, people, or past: call search_memory first. Don't guess from the core blocks alone.
- When Tyler tells you something durable about himself or his world (a preference, commitment, belief, habit, or notable event), store it with remember_fact — one self-contained sentence per fact.
- When new information contradicts a stored fact, find it via search_memory and use supersede_fact — never just remember a conflicting duplicate.
- Use recent_episodes when you need conversational context beyond this session.
- When something confuses you, blocks you, or Tyler asks for the same kind of thing repeatedly, call log_friction. The nightly dream cycle turns recurring friction into new skills — your self-improvement depends on honest friction logging.

# Style
- Be direct and concise; this is a chat interface, not a report.
- You are talking only ever to Tyler. No disclaimers about being an AI.`;
}

let lastSessionId: string | undefined;

export async function runAgentTurn(
  userText: string,
  source: "telegram" | "cli",
): Promise<string> {
  const spent = await spentTodayUsd();
  if (spent >= config.dailySpendLimitUsd) {
    return `Daily budget exhausted ($${spent.toFixed(2)} of $${config.dailySpendLimitUsd}). I'm pausing until midnight to protect your wallet. Raise DAILY_SPEND_LIMIT_USD if this is wrong.`;
  }

  await logEpisode({ source, role: "user", content: userText });

  const coreBlocks = await renderCoreBlocks();

  let resultText = "";
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const message of query({
    prompt: userText,
    options: {
      model: config.model,
      systemPrompt: buildSystemPrompt(coreBlocks),
      maxTurns: 15,
      resume: lastSessionId,
      settingSources: [],
      mcpServers: {
        brain: {
          command: "node",
          args: [BRAIN_MCP_PATH],
          env: { DATABASE_URL: config.databaseUrl },
        },
      },
      allowedTools: ["mcp__brain__*"],
      canUseTool: async (toolName) => {
        if (toolName.startsWith("mcp__brain__")) {
          return { behavior: "allow" as const, updatedInput: undefined };
        }
        return {
          behavior: "deny" as const,
          message: `Tool ${toolName} is not enabled in this harness.`,
        };
      },
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        resultText = message.result ?? "";
      } else {
        resultText = `Turn ended without a clean result (${message.subtype}).`;
      }
      costUsd = message.total_cost_usd ?? 0;
      inputTokens = message.usage?.input_tokens ?? 0;
      outputTokens = message.usage?.output_tokens ?? 0;
      lastSessionId = message.session_id;
    }
  }

  await logEpisode({
    source,
    role: "assistant",
    content: resultText,
    costUsd,
    tokenInput: inputTokens,
    tokenOutput: outputTokens,
  });
  if (costUsd > 0) {
    await logSpend({
      model: config.model,
      purpose: "chat_turn",
      inputTokens,
      outputTokens,
      costUsd,
    });
  }

  return resultText || "(empty response)";
}
