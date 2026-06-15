/**
 * In-process Agent-SDK MCP server exposing scheduling tools. Scheduling is an
 * agent-runtime concern (the agent owns the pg-boss scheduler), so it lives
 * here rather than in the brain's memory MCP. Wired into agent.ts mcpServers.
 */
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { addCron, listCrons, cancelCron } from "./crons.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const scheduleCron = tool(
  "schedule_cron",
  "Schedule a recurring task for the owner. `schedule` MUST be a standard 5-field " +
    "cron expression (minute hour day-of-month month day-of-week): e.g. '0 8 * * *' = " +
    "daily 8am, '0 9 * * 1-5' = weekdays 9am, '*/30 * * * *' = every 30 minutes. When the " +
    "cron fires, `prompt` runs as a turn and the result is sent to the owner on Telegram. " +
    "`name` is a short kebab-case handle. Returns an error string if the expression is " +
    "invalid or the name is taken — relay it to the owner and try again.",
  { name: z.string(), schedule: z.string(), prompt: z.string() },
  async ({ name, schedule, prompt }) => {
    const r = await addCron({ name, cronExpr: schedule, prompt });
    return text(
      r.ok
        ? `Scheduled "${name}" (${schedule}). It will run and report on Telegram.`
        : `Could not schedule: ${r.error}`,
    );
  },
);

const listCronsTool = tool(
  "list_crons",
  "List the owner's scheduled recurring tasks (crons).",
  {},
  async () => {
    const rows = await listCrons();
    if (!rows.length) return text("No crons scheduled.");
    return text(
      rows
        .map((c) => `• ${c.name} [${c.cron_expr}]${c.enabled ? "" : " (disabled)"} — ${c.prompt.slice(0, 80)}`)
        .join("\n"),
    );
  },
);

const cancelCronTool = tool(
  "cancel_cron",
  "Cancel (delete) a scheduled cron by its name.",
  { name: z.string() },
  async ({ name }) => {
    const ok = await cancelCron(name);
    return text(ok ? `Canceled "${name}".` : `No cron named "${name}".`);
  },
);

export const schedulerMcpServer = createSdkMcpServer({
  name: "scheduler",
  version: "1.0.0",
  tools: [scheduleCron, listCronsTool, cancelCronTool],
});
