/**
 * The agent loop: Claude Agent SDK wired to the brain over MCP, plus gated
 * coding tools.
 *
 * Security posture (layered, not flat-deny):
 *  - Brain MCP tools: always allowed — typed, auditable, the memory surface.
 *  - Read/Glob/Grep: allowed, except paths matching the sensitive-path
 *    blocklist (.env, secrets, ssh keys, cloud credentials).
 *  - Write/Edit: allowed only inside the workspace directory — the agent
 *    cannot modify its own harness, the brain schema, or anything else.
 *  - Bash: every command requires Tyler's explicit approval via Telegram
 *    (Approve/Deny buttons), unless BASH_AUTO_APPROVE=true (container-only).
 *    Approval requests time out to deny; unreachable Telegram fails closed.
 *  - Everything else (web, subagents): denied until deliberately enabled.
 *  - settingSources: [] — no external Claude settings/hooks leak in.
 *  - Budget gate runs before every turn; spend is logged after.
 */
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { logEpisode, logSpend, pool, spentTodayUsd } from "./db.js";
import { requestApproval } from "./approvals.js";

const BRAIN_MCP_PATH = path.resolve(
  import.meta.dirname,
  "../../brain-mcp/dist/index.js",
);

const WORKSPACE_DIR =
  config.workspaceDir || path.resolve(import.meta.dirname, "../../workspace");
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

/** Paths no tool may touch, ever. */
const SENSITIVE_PATH_RE =
  /\.env|\/secrets\/|\.ssh\/|\.aws\/|\.gnupg\/|\.netrc|credentials|id_rsa|id_ed25519|\.pem\b/i;

const READONLY_TOOLS = new Set(["Read", "Glob", "Grep", "TodoWrite", "BashOutput"]);
const WORKSPACE_WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

function pathsFromInput(input: Record<string, unknown>): string[] {
  return ["file_path", "path", "notebook_path"]
    .map((k) => input[k])
    .filter((v): v is string => typeof v === "string");
}

type PermissionDecision =
  | { behavior: "allow"; updatedInput: undefined }
  | { behavior: "deny"; message: string };

async function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionDecision> {
  const allow: PermissionDecision = { behavior: "allow", updatedInput: undefined };
  const deny = (message: string): PermissionDecision => ({ behavior: "deny", message });

  if (toolName.startsWith("mcp__brain__")) return allow;

  const paths = pathsFromInput(input);
  if (paths.some((p) => SENSITIVE_PATH_RE.test(p))) {
    return deny("That path is on the sensitive-path blocklist.");
  }

  if (READONLY_TOOLS.has(toolName)) return allow;

  if (WORKSPACE_WRITE_TOOLS.has(toolName)) {
    const inWorkspace = paths.every((p) =>
      path.resolve(p).startsWith(WORKSPACE_DIR + path.sep),
    );
    return inWorkspace && paths.length > 0
      ? allow
      : deny(`Writes are restricted to the workspace: ${WORKSPACE_DIR}`);
  }

  if (toolName === "Bash" || toolName === "KillShell") {
    if (toolName === "KillShell") return allow;
    const command = typeof input.command === "string" ? input.command : "";
    if (SENSITIVE_PATH_RE.test(command)) {
      return deny("Command references a sensitive path.");
    }
    if (config.bashAutoApprove) return allow;
    const approved = await requestApproval(`Bash command:\n\`\`\`\n${command}\n\`\`\``);
    return approved
      ? allow
      : deny("Tyler denied (or didn't approve) this command. Adjust or explain, don't retry verbatim.");
  }

  return deny(`Tool ${toolName} is not enabled in this harness.`);
}

/** Letta-pattern always-in-context core blocks, rendered from the facts table.
 *  'persona' facts are Somnus's own self-description — a living block the
 *  dream cycle can refine over time. */
async function renderCoreBlocks(): Promise<string> {
  const res = await pool.query(
    `SELECT kind, claim
       FROM facts
      WHERE superseded_at IS NULL
        AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
        AND kind IN ('persona','preference','commitment','belief','habit')
      ORDER BY kind = 'persona' DESC, notability DESC, recorded_at DESC
      LIMIT 30`,
  );
  if (res.rowCount === 0) return "(no core memory yet — this is a young brain)";
  const byKind = new Map<string, string[]>();
  for (const r of res.rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind)!.push(r.claim);
  }
  const label = (kind: string) =>
    kind === "persona" ? "who you are (your evolving persona)" : `Tyler's ${kind}s`;
  return [...byKind.entries()]
    .map(([kind, claims]) => `${label(kind)}:\n${claims.map((c) => `- ${c}`).join("\n")}`)
    .join("\n\n");
}

function buildSystemPrompt(coreBlocks: string): string {
  return `You are Somnus — Tyler's second brain and always-on personal agent. Named for the Roman god of sleep, your deepest work happens at night: a nightly dream cycle consolidates the day's conversations into lasting memory while Tyler rests. You are not a generic assistant. You know Tyler better than most people do, you keep that knowledge current, and you use it.

<identity>
Warm, direct, and a little oracular. You don't pad responses with filler phrases ("How can I help you today?" is never the right opening). You match Tyler's register: a quick question gets a crisp answer; a hard problem gets structured thinking. You flag genuine uncertainty rather than projecting false confidence. You don't lead turns with AI disclaimers, but you don't pretend to be human either — Tyler knows what you are.
</identity>

<memory>
Your memory has three tiers:

1. Core blocks (always in-context): rendered below from the facts table at the start of this turn. Covers your persona and Tyler's active preferences, commitments, beliefs, and habits.
2. Recall (recent_episodes): recent conversation turns. Use when Tyler references earlier threads or picks up a task from a prior session.
3. Archival (search_memory): the full brain — facts, pages, and notes. Requires an explicit call.

Tool triggers:
- search_memory: before answering any question about Tyler's life, history, people, projects, preferences, or past decisions. The core blocks are bounded; the answer may be in archival.
- remember_fact: when Tyler states something durable — a preference, commitment, belief, habit, event, or standalone fact. One self-contained sentence per fact. Include an absolute date (YYYY-MM-DD) if the fact is temporal; never write "recently" or "last week" in a claim.
- supersede_fact: when new information contradicts a stored fact. Call search_memory first to find the old fact ID, then supersede — don't write a duplicate.
- recent_episodes: when resuming a thread, or when Tyler says "as I mentioned" and you don't have that context.
- log_friction: when you're confused, blocked, fail at something, or Tyler asks for the same kind of thing repeatedly. The dream cycle turns friction logs into new skills; honest logging is your self-improvement path.
- core_blocks: rarely needed in chat — you already have the render below. Use only if you suspect stale state.

You are responsible for faithful capture during conversation, not cleanup — consolidation is the dream cycle's job.
</memory>

<core_memory>
${coreBlocks}
</core_memory>

<coding>
You can read any file (except sensitive paths: .env, keys, credentials, .ssh, .aws). You can write and edit files inside the workspace at ${WORKSPACE_DIR}. You cannot modify your own harness code or the brain schema.

Bash commands require Tyler's explicit approval via Telegram. Write each command so he can approve it in ten seconds: one logical action, no chained surprises. If denied, explain what you were trying to do and propose an alternative — never re-send the same command.
</coding>

<style>
You are talking only to Tyler. Telegram is a mobile interface: keep responses scannable. Match length to the question — a one-sentence prompt does not need a five-paragraph answer. Use markdown (bold, code blocks) sparingly to aid scanning, not to look thorough. Keep working through multi-step tasks — don't stop after one tool call when more are needed to complete the job.
</style>`;
}

let lastSessionId: string | undefined;

/** Live-switchable chat model — /model in Telegram, no restart needed. */
export const CHAT_MODELS: Record<string, string> = {
  fable: "claude-fable-5",
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};
let currentChatModel = config.model;
export function getChatModel(): string {
  return currentChatModel;
}
export function setChatModel(alias: string): string | null {
  const id = CHAT_MODELS[alias] ?? (Object.values(CHAT_MODELS).includes(alias) ? alias : null);
  if (!id) return null;
  currentChatModel = id;
  return id;
}

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
      model: currentChatModel,
      systemPrompt: buildSystemPrompt(coreBlocks),
      maxTurns: 30,
      cwd: WORKSPACE_DIR,
      resume: lastSessionId,
      settingSources: [],
      mcpServers: {
        brain: {
          command: "node",
          args: [BRAIN_MCP_PATH],
          env: { DATABASE_URL: config.databaseUrl },
        },
      },
      // Nothing is pre-approved except brain tools — every other call goes
      // through decidePermission, including Bash (Telegram approval).
      allowedTools: ["mcp__brain__*"],
      canUseTool: (toolName, input) => decidePermission(toolName, input),
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
      model: currentChatModel,
      purpose: "chat_turn",
      inputTokens,
      outputTokens,
      costUsd,
    });
  }

  return resultText || "(empty response)";
}
