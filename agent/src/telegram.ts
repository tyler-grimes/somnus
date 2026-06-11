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
import {
  autoModeStatus,
  CHAT_MODELS,
  getChatModel,
  runAgentTurn,
  setAutoMode,
  setChatModel,
} from "./agent.js";
import { logFriction } from "./db.js";
import { resolveApproval } from "./approvals.js";
import { activeSkills, approveSkill, pendingSkills, rejectSkill } from "./skills.js";

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

export function createBot(
  opts: {
    onDreamRequested?: () => Promise<void>;
    onBriefingRequested?: () => Promise<void>;
  } = {},
): Bot {
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

  // Approve/Deny buttons for gated tool calls (Bash). The allowlist
  // middleware above already guarantees these come only from Tyler.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const match = /^(approve|always|auto|deny):([a-f0-9-]+)$/.exec(data);
    if (!match) return ctx.answerCallbackQuery();
    const decision = match[1] as "approve" | "always" | "auto" | "deny";
    const known = resolveApproval(match[2], decision);
    const labels = {
      approve: "✅ approved",
      always: "♻️ always allowed",
      auto: "🤖 full automode enabled",
      deny: "❌ denied",
    };
    await ctx.answerCallbackQuery({ text: known ? labels[decision] : "Expired" });
    await ctx
      .editMessageText(
        `${ctx.callbackQuery.message?.text ?? ""}\n\n${known ? labels[decision] : "⌛ expired"}`,
      )
      .catch(() => {});
  });

  // /auto — Bash automode: "/auto on" (indefinite), "/auto 30" (minutes),
  // "/auto off", bare = status
  bot.command("auto", async (ctx) => {
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (!arg) return ctx.reply(autoModeStatus());
    if (arg === "off") return ctx.reply(setAutoMode(null));
    if (arg === "on") return ctx.reply(setAutoMode("on"));
    const minutes = parseInt(arg, 10);
    if (Number.isNaN(minutes)) return ctx.reply("Usage: /auto on | /auto 30 | /auto off | /auto");
    await ctx.reply(setAutoMode(minutes));
  });

  // /model — show or switch the chat model at runtime
  bot.command("model", async (ctx) => {
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (!arg) {
      await ctx.reply(
        `Chat model: ${getChatModel()}\nSwitch: /model ${Object.keys(CHAT_MODELS).join(" | ")}`,
      );
      return;
    }
    const id = setChatModel(arg);
    await ctx.reply(id ? `Chat model → ${id}` : `Unknown model "${arg}". Options: ${Object.keys(CHAT_MODELS).join(", ")}`);
  });

  // /skills — list; /skills approve <slug> | reject <slug>
  bot.command("skills", async (ctx) => {
    const [action, slug] = (ctx.match ?? "").trim().split(/\s+/);
    if (action === "approve" && slug) {
      return ctx.reply(
        approveSkill(slug)
          ? `✅ Skill "${slug}" activated — Somnus knows it next turn.`
          : `No pending skill named "${slug}".`,
      );
    }
    if (action === "reject" && slug) {
      return ctx.reply(rejectSkill(slug) ? `🗑 Skill "${slug}" rejected.` : `No pending skill named "${slug}".`);
    }
    const active = activeSkills();
    const pending = pendingSkills();
    const lines = [
      `Active (${active.length}):`,
      ...active.map((s) => `• ${s.slug} — ${s.description}`),
      `\nPending review (${pending.length}):`,
      ...pending.map((s) => `• ${s.slug} — ${s.description}`),
    ];
    if (pending.length) lines.push(`\nApprove: /skills approve <slug>  ·  Reject: /skills reject <slug>`);
    await ctx.reply(lines.join("\n"));
  });

  // /brief — send the morning briefing now
  bot.command("brief", async (ctx) => {
    if (!opts.onBriefingRequested) return ctx.reply("Briefing not wired up.");
    await opts.onBriefingRequested();
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

  // NOTE: this handler must NOT await the agent turn. grammY processes
  // updates sequentially, so a handler that blocks on the turn would starve
  // the callback_query updates that carry Bash approval taps — deadlocking
  // every approval until timeout. The inflight chain still serializes turns.
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
    // fire-and-forget: see NOTE above
  });

  return bot;
}
