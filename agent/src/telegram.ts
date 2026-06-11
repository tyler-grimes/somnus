/**
 * Telegram gateway — long-polling (zero inbound ports), single-user allowlist.
 *
 * Security invariants:
 *  - Messages from anyone but TELEGRAM_ALLOWED_USER_ID are dropped before any
 *    LLM call, DB write, or reply. Drops are counted and logged to stderr.
 *  - Long polling only: outbound HTTPS to api.telegram.org, nothing listens.
 */
import { Bot } from "grammy";
import { config } from "./config.js";
import { runAgentTurn } from "./agent.js";
import { logFriction } from "./db.js";

const TELEGRAM_MAX_LEN = 4000;

function chunk(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LEN) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX_LEN) {
    // Prefer breaking on a paragraph or line boundary
    let cut = rest.lastIndexOf("\n\n", TELEGRAM_MAX_LEN);
    if (cut < TELEGRAM_MAX_LEN / 2) cut = rest.lastIndexOf("\n", TELEGRAM_MAX_LEN);
    if (cut < TELEGRAM_MAX_LEN / 2) cut = TELEGRAM_MAX_LEN;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function createBot(opts: { onDreamRequested?: () => Promise<void> } = {}): Bot {
  const bot = new Bot(config.telegramBotToken);
  let droppedCount = 0;

  // SECURITY GATE — must be the first middleware. Single-user allowlist.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.telegramAllowedUserId) {
      droppedCount++;
      console.error(
        `[telegram] dropped message from unauthorized user id=${ctx.from?.id ?? "unknown"} (total dropped: ${droppedCount})`,
      );
      return; // no reply — don't reveal the bot is alive
    }
    await next();
  });

  // /dream — manually trigger the nightly consolidation cycle
  bot.command("dream", async (ctx) => {
    if (!opts.onDreamRequested) {
      await ctx.reply("Dream cycle not wired up in this process.");
      return;
    }
    await ctx.reply("Starting dream cycle — report follows when done.");
    await opts.onDreamRequested();
  });

  // One agent turn at a time: serialize messages so concurrent turns don't
  // interleave writes to the brain or race the session.
  let inflight: Promise<void> = Promise.resolve();

  bot.on("message:text", (ctx) => {
    const text = ctx.message.text;
    inflight = inflight.then(async () => {
      const typing = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 5000);
      ctx.replyWithChatAction("typing").catch(() => {});
      try {
        const reply = await runAgentTurn(text, "telegram");
        for (const part of chunk(reply)) {
          await ctx.reply(part);
        }
      } catch (err) {
        console.error("[telegram] agent turn failed:", err);
        const msg = err instanceof Error ? err.message : String(err);
        // Failures are skill-loop fuel: log them as friction
        await logFriction({
          frictionType: "failure",
          description: `Agent turn failed on: "${text.slice(0, 200)}" — ${msg.slice(0, 300)}`,
        }).catch(() => {});
        await ctx.reply(`Something went wrong: ${msg}`).catch(() => {});
      } finally {
        clearInterval(typing);
      }
    });
    return inflight;
  });

  return bot;
}
