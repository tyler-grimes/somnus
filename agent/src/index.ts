import { config } from "./config.js";
import { pool } from "./db.js";
import { createBot } from "./telegram.js";
import { startScheduler, triggerDreamNow } from "./scheduler.js";

async function main(): Promise<void> {
  // Fail fast if the brain is unreachable — an agent without memory is worse
  // than no agent.
  await pool.query("SELECT 1");
  console.log("[boot] brain reachable");

  const boss = await startScheduler();
  const bot = createBot({ onDreamRequested: () => triggerDreamNow(boss) });

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
