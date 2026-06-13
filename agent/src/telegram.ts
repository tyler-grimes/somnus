/**
 * Telegram gateway — long-polling (zero inbound ports), single-user allowlist.
 *
 * Security invariants:
 *  - Messages from anyone but TELEGRAM_ALLOWED_USER_ID are dropped before any
 *    LLM call, DB write, or reply. Drops are counted and logged to stderr.
 *  - Long polling only: outbound HTTPS to api.telegram.org, nothing listens.
 */
import fs from "node:fs";
import path from "node:path";
import { Bot } from "grammy";
import { config } from "./config.js";
import { logEpisode, pool } from "./db.js";
import {
  autoModeStatus,
  CHAT_MODELS,
  getChatModel,
  runTurnExclusive,
  setAutoMode,
  setChatModel,
} from "./agent.js";
import { logFriction } from "./db.js";
import { WORKSPACE_DIR } from "./agent.js";
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
    onGapAnalysisRequested?: () => Promise<void>;
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
  // middleware above keeps strangers out; the HMAC inside the callback_data
  // (verified by resolveApproval) is the second, independent layer — a
  // token the server didn't mint resolves nothing.
  bot.on("callback_query:data", async (ctx) => {
    const decision = resolveApproval(ctx.callbackQuery.data);
    const labels = {
      approve: "✅ approved",
      always: "♻️ always allowed",
      auto: "🤖 full automode enabled",
      deny: "❌ denied",
    };
    await ctx.answerCallbackQuery({ text: decision ? labels[decision] : "Expired" });
    await ctx
      .editMessageText(
        `${ctx.callbackQuery.message?.text ?? ""}\n\n${decision ? labels[decision] : "⌛ expired"}`,
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

  // /gaps — manually trigger proactive gap analysis
  bot.command("gaps", async (ctx) => {
    if (!opts.onGapAnalysisRequested) {
      await ctx.reply("Gap analysis not wired up in this process.");
      return;
    }
    await ctx.reply(
      "Starting gap analysis — I'll send findings if anything high-priority turns up.",
    );
    await opts.onGapAnalysisRequested();
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

  // Files, photos, voice notes → workspace/inbox/ + a page in the brain.
  // The dream cycle and future ingestion phases eat from this folder.
  bot.on(["message:document", "message:photo", "message:voice", "message:audio"], async (ctx) => {
    try {
      const msg = ctx.message;
      const caption = msg.caption ?? "";
      const tgFile = await ctx.getFile();
      if (!tgFile.file_path) return void (await ctx.reply("Couldn't fetch that file from Telegram."));

      const inbox = path.join(WORKSPACE_DIR, "inbox");
      fs.mkdirSync(inbox, { recursive: true });
      const original =
        msg.document?.file_name ?? path.basename(tgFile.file_path) ?? "file.bin";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const saved = path.join(inbox, `${stamp}-${path.basename(original)}`);

      const res = await fetch(
        `https://api.telegram.org/file/bot${config.telegramBotToken}/${tgFile.file_path}`,
      );
      if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
      fs.writeFileSync(saved, Buffer.from(await res.arrayBuffer()));

      const kindLabel = msg.photo ? "photo" : msg.voice ? "voice note" : msg.audio ? "audio" : "document";
      const title = caption || `${kindLabel}: ${original}`;
      await pool.query(
        `INSERT INTO pages (slug, type, title, timeline, frontmatter, effective_date)
         VALUES ($1, 'note', $2, $3, $4, now())`,
        [
          `inbox-${stamp}-${path.basename(original).toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}`,
          title,
          `${config.ownerName} sent a ${kindLabel} via Telegram on ${new Date().toISOString()}.\nSaved at: ${saved}${caption ? `\nCaption: ${caption}` : ""}`,
          JSON.stringify({ source: "telegram_upload", file: saved, kind: kindLabel }),
        ],
      );
      await logEpisode({
        source: "ingestion",
        role: "user",
        content: `[${kindLabel} received: ${original}]${caption ? ` ${caption}` : ""} → ${saved}`,
      });
      await ctx.reply(
        `📥 Saved ${kindLabel} to inbox${caption ? " with your note" : ""}. I'll remember it.`,
      );
    } catch (err) {
      console.error("[telegram] file capture failed:", err);
      await ctx.reply("File capture failed — check the console.").catch(() => {});
    }
  });

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
        const reply = await runTurnExclusive(text, "telegram");
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
