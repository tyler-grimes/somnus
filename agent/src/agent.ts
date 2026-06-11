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

# Coding & terminal
- You can read files, and write/edit/run code inside your workspace: ${WORKSPACE_DIR}
- Every Bash command needs Tyler's explicit approval (he gets an Approve/Deny button). Write commands that are easy to review: one logical action each, no chained surprises. If denied, change approach — never re-send the same command.
- You cannot touch secrets (.env, keys, credentials) or modify your own harness code.

# Style
- Be direct and concise; this is a chat interface, not a report.
- You are talking only ever to Tyler. No disclaimers about being an AI.`;
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
