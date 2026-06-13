import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { pool } from "./db.js";
import { createBot } from "./telegram.js";
import { initPolicy } from "./agent.js";
import { startScheduler, triggerBriefingNow, triggerDreamNow, triggerGapAnalysisNow } from "./scheduler.js";

/**
 * Claude Code strips credential env vars (CLAUDE_CODE_OAUTH_TOKEN,
 * GITHUB_TOKEN*) from Bash child environments, so cc.sh can't inherit them
 * through the harness. Hand them over via a 0600 file instead. The filename
 * contains "credentials" on purpose: SENSITIVE_PATH_RE blocks the agent's
 * own Read/Bash from touching it, even in automode. Exposure is unchanged —
 * same-UID processes could already read /proc/<agent>/environ.
 */
function writeCcCredentials(): void {
  if (!config.bashAutoApprove) return; // container-only; local dev uses real host tools
  const lines: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (v && (k === "CLAUDE_CODE_OAUTH_TOKEN" || k.startsWith("GITHUB_TOKEN"))) {
      lines.push(`${k}=${v}`);
    }
  }
  if (lines.length === 0) return;
  const dir = path.join(os.homedir(), ".claude");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ".somnus-credentials");
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  console.log(`[boot] cc.sh credentials file written (${lines.length} entries)`);
}

async function main(): Promise<void> {
  // Fail fast if the brain is unreachable — an agent without memory is worse
  // than no agent.
  await pool.query("SELECT 1");
  console.log("[boot] brain reachable");
  writeCcCredentials();
  await initPolicy();

  const boss = await startScheduler();
  const bot = createBot({
    onDreamRequested: () => triggerDreamNow(boss),
    onBriefingRequested: () => triggerBriefingNow(boss),
    onGapAnalysisRequested: () => triggerGapAnalysisNow(boss),
  });

  const shutdown = async (signal: string) => {
    console.log(`[boot] ${signal} received, stopping`);
    await bot.stop();
    await boss.stop();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(
    `[boot] starting long-polling bot (allowed user: ${config.telegramAllowedUserId}, model: ${config.model}, daily cap: $${config.dailySpendLimitUsd})`,
  );
  await bot.start();
}

main().catch((err) => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});
