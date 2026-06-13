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
import { runGapAnalysis } from "./gap-analysis.js";

const DREAM_QUEUE = "dream-cycle";
const BRIEFING_QUEUE = "morning-briefing";
const CC_SPEND_QUEUE = "cc-spend-sweep";
const CC_INGEST_QUEUE = "cc-ingest-sweep";
const GAP_ANALYSIS_QUEUE = "gap-analysis";

/** Proactive push to the owner — raw Bot API call, no grammY instance needed. */
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
  // Nightly at 04:00 local — memory matures while the owner sleeps
  await boss.schedule(DREAM_QUEUE, "0 4 * * *", {}, { tz: config.timezone });

  await boss.work(DREAM_QUEUE, async () => {
    console.log("[dream] cycle starting");
    const report = await runDreamCycle();
    console.log(report);
    await notifyTelegram(report);
    // Chain gap analysis onto dream completion: it researches against the
    // facts/embeddings the dream cycle just consolidated, and won't re-flag
    // problems the dream cycle resolved. Runs whenever dream actually
    // finishes, no clock race.
    await boss.send(GAP_ANALYSIS_QUEUE, {}, { singletonKey: "gap-analysis" });
    console.log("[dream] enqueued gap analysis");
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

  await boss.createQueue(GAP_ANALYSIS_QUEUE);
  // No standalone schedule: chained off dream completion (see DREAM_QUEUE
  // handler) so it researches freshly consolidated memory. Manual /gaps
  // still enqueues directly via triggerGapAnalysisNow. Clear any stale cron
  // left by an older version that scheduled this at 03:00 (self-healing).
  await boss.unschedule(GAP_ANALYSIS_QUEUE).catch(() => {});
  await boss.work(GAP_ANALYSIS_QUEUE, async () => {
    console.log("[gap-analysis] starting");
    try {
      const result = await runGapAnalysis();
      console.log(
        `[gap-analysis] done — ${result.gapsFound} gaps found, ${result.researched} researched, ${result.highPriority} high-priority, telegram: ${result.telegramSent}`,
      );
    } catch (err) {
      console.error("[gap-analysis] job failed:", err);
    }
  });

  console.log(
    `[boot] scheduler up — dream cycle 04:00 (→ gap analysis), briefing 08:00 ${config.timezone}`,
  );
  return boss;
}

export async function triggerBriefingNow(boss: PgBoss): Promise<void> {
  await boss.send(BRIEFING_QUEUE, {}, { singletonKey: "manual-briefing" });
}

export async function triggerDreamNow(boss: PgBoss): Promise<void> {
  await boss.send(DREAM_QUEUE, {}, { singletonKey: "manual-dream" });
}

export async function triggerGapAnalysisNow(boss: PgBoss): Promise<void> {
  await boss.send(GAP_ANALYSIS_QUEUE, {}, { singletonKey: "gap-analysis" });
}
