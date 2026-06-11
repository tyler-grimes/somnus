/**
 * Postgres-native job scheduling via pg-boss — no Redis, queue lives in the
 * same database as the brain (its own `pgboss` schema).
 */
import { PgBoss } from "pg-boss";
import { config } from "./config.js";
import { runDreamCycle } from "./dream.js";

const DREAM_QUEUE = "dream-cycle";

/** Proactive push to Tyler — raw Bot API call, no grammY instance needed. */
export async function notifyTelegram(text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramAllowedUserId,
      text: text.slice(0, 4000),
    }),
  });
  if (!res.ok) console.error("[notify] telegram send failed:", res.status, await res.text());
}

export async function startScheduler(): Promise<PgBoss> {
  const boss = new PgBoss(config.databaseUrl);
  boss.on("error", (err: Error) => console.error("[pg-boss]", err));
  await boss.start();

  await boss.createQueue(DREAM_QUEUE);
  // Nightly at 04:00 local — memory matures while Tyler sleeps
  await boss.schedule(DREAM_QUEUE, "0 4 * * *", {}, { tz: config.timezone });

  await boss.work(DREAM_QUEUE, async () => {
    console.log("[dream] cycle starting");
    const report = await runDreamCycle();
    console.log(report);
    await notifyTelegram(report);
  });

  console.log(`[boot] scheduler up — dream cycle at 04:00 ${config.timezone}`);
  return boss;
}

export async function triggerDreamNow(boss: PgBoss): Promise<void> {
  await boss.send(DREAM_QUEUE, {}, { singletonKey: "manual-dream" });
}
