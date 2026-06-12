/**
 * Postgres-native job scheduling via pg-boss — no Redis, queue lives in the
 * same database as the brain (its own `pgboss` schema).
 */
import { PgBoss } from "pg-boss";
import { config } from "./config.js";
import { runDreamCycle } from "./dream.js";
import { buildMorningBriefing } from "./briefing.js";
import { sweepCcSpend } from "./ccspend.js";
import { ingestNewSessions } from "./cc-ingest.js";

const DREAM_QUEUE = "dream-cycle";
const BRIEFING_QUEUE = "morning-briefing";
const CC_SPEND_QUEUE = "cc-spend-sweep";
const CC_INGEST_QUEUE = "cc-ingest-sweep";

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

  await boss.createQueue(BRIEFING_QUEUE);
  // Morning briefing at 08:00 local — commitments, open threads, spend
  await boss.schedule(BRIEFING_QUEUE, "0 8 * * *", {}, { tz: config.timezone });
  await boss.work(BRIEFING_QUEUE, async () => {
    const briefing = await buildMorningBriefing();
    await notifyTelegram(briefing);
  });

  await boss.createQueue(CC_SPEND_QUEUE);
  // Every 10 minutes: ingest cc.sh session costs spooled to the workspace
  await boss.schedule(CC_SPEND_QUEUE, "*/10 * * * *", {}, { tz: config.timezone });
  await boss.work(CC_SPEND_QUEUE, async () => {
    const n = await sweepCcSpend();
    if (n > 0) console.log(`[cc-spend] ingested ${n} session record(s)`);
  });

  await boss.createQueue(CC_INGEST_QUEUE);
  // Every 15 minutes: ingest new CC session JSONL transcripts from ~/.claude/projects
  await boss.schedule(CC_INGEST_QUEUE, "*/15 * * * *", {}, { tz: config.timezone });
  await boss.work(CC_INGEST_QUEUE, async () => {
    const n = await ingestNewSessions();
    if (n > 0) console.log(`[cc-ingest] ingested ${n} session transcript(s)`);
  });

  console.log(
    `[boot] scheduler up — dream cycle 04:00, briefing 08:00 ${config.timezone}`,
  );
  return boss;
}

export async function triggerBriefingNow(boss: PgBoss): Promise<void> {
  await boss.send(BRIEFING_QUEUE, {}, { singletonKey: "manual-briefing" });
}

export async function triggerDreamNow(boss: PgBoss): Promise<void> {
  await boss.send(DREAM_QUEUE, {}, { singletonKey: "manual-dream" });
}
