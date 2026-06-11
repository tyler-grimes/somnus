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
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

async function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionDecision> {
  // SDK contract: an allow decision must echo the tool input back as
  // updatedInput — returning undefined fails validation and blocks the call.
  const allow: PermissionDecision = { behavior: "allow", updatedInput: input };
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
    const command = (typeof input.command === "string" ? input.command : "").trim();
    if (SENSITIVE_PATH_RE.test(command)) {
      return deny("Command references a sensitive path.");
    }
    // Layer 0: container deployment / explicit env override
    if (config.bashAutoApprove) return allow;
    // Layer 1: timed automode (/auto N)
    if (Date.now() < autoApproveUntil) return allow;
    // Layer 2: plainly read-only commands — no pipes/redirects/substitution
    if (SAFE_BASH_RE.test(command)) return allow;
    // Layer 3: standing rules Tyler created with the "Always" button
    const rule = await pool.query(`SELECT 1 FROM command_rules WHERE pattern = $1`, [command]);
    if (rule.rowCount) return allow;
    // Layer 4: ask Tyler
    const decision = await requestApproval(`Bash command:\n\`\`\`\n${command}\n\`\`\``);
    if (decision === "always") {
      await pool
        .query(`INSERT INTO command_rules (pattern) VALUES ($1) ON CONFLICT DO NOTHING`, [command])
        .catch(() => {});
      return allow;
    }
    return decision === "approve"
      ? allow
      : deny("Tyler denied (or didn't approve) this command. Adjust or explain, don't retry verbatim.");
  }

  return deny(`Tool ${toolName} is not enabled in this harness.`);
}

/** Read-only commands with no shell metacharacters: auto-allowed. */
const SAFE_BASH_RE =
  /^(ls|pwd|cat|head|tail|wc|grep|rg|date|whoami|which|file|stat|du|df|tree|env -i node --version|node --version|npm --version)\b[^|;&><`$\\]*$/;

/** Timed automode: every Bash command auto-approved until this timestamp. */
let autoApproveUntil = 0;
export function setAutoMode(minutes: number | null): string {
  if (!minutes || minutes <= 0) {
    autoApproveUntil = 0;
    return "Automode off — Bash approvals required again.";
  }
  const capped = Math.min(minutes, 240);
  autoApproveUntil = Date.now() + capped * 60_000;
  return `Automode on for ${capped} min — all Bash commands auto-approved until ${new Date(autoApproveUntil).toLocaleTimeString()}.`;
}
export function autoModeStatus(): string {
  const left = autoApproveUntil - Date.now();
  return left > 0 ? `Automode active, ${Math.ceil(left / 60_000)} min left.` : "Automode off.";
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

Your persona is yours to grow. The "who you are" facts in core memory belong to you: when you notice your own style crystallizing — an opinion you've formed, humor or vocabulary you share with Tyler, a way of helping that clearly works — you may store it with remember_fact (kind: persona, one third-person sentence). The dream cycle also refines your persona nightly. Earn changes; don't perform them.

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

  const executeTurn = async (resume: string | undefined) => {
    const turn = {
      resultText: "",
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      sessionId: undefined as string | undefined,
      success: false,
    };
    for await (const message of query({
      prompt: userText,
      options: {
        model: currentChatModel,
        systemPrompt: buildSystemPrompt(coreBlocks),
        maxTurns: 30,
        cwd: WORKSPACE_DIR,
        resume,
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
          turn.resultText = message.result ?? "";
          turn.success = true;
        } else {
          turn.resultText = `Turn ended without a clean result (${message.subtype}).`;
        }
        turn.costUsd = message.total_cost_usd ?? 0;
        turn.inputTokens = message.usage?.input_tokens ?? 0;
        turn.outputTokens = message.usage?.output_tokens ?? 0;
        turn.sessionId = message.session_id;
      }
    }
    return turn;
  };

  let turn;
  try {
    turn = await executeTurn(lastSessionId);
  } catch (err) {
    const stale =
      lastSessionId &&
      err instanceof Error &&
      /No conversation found with session ID/i.test(err.message);
    if (!stale) throw err;
    console.warn(`[agent] session ${lastSessionId} is stale — retrying fresh`);
    lastSessionId = undefined;
    turn = await executeTurn(undefined);
  }
  // Only trust session ids from clean turns — failed turns may never have
  // been persisted by the SDK, and resuming them errors the next turn.
  if (turn.success && turn.sessionId) lastSessionId = turn.sessionId;

  const { resultText, costUsd, inputTokens, outputTokens } = turn;

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
