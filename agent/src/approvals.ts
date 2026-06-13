/**
 * Human-in-the-loop approval over Telegram.
 *
 * Flow: canUseTool wants a risky action → requestApproval() sends the owner a
 * message with Approve/Deny buttons and parks the turn on a promise →
 * telegram.ts resolves it from the callback_query → the tool call proceeds
 * or is denied. Unanswered requests deny after a timeout.
 *
 * Tokens are self-verifying (security research #1): callback_data carries
 * `<decision>:<nonce>:<exp>:<hmac>` — a 64-bit nonce, an expiry, and a
 * truncated HMAC-SHA256 over all three under a server secret. The handler
 * rejects anything it didn't mint, independent of the Telegram allowlist,
 * so the allowlist middleware is defense-in-depth instead of the only line.
 * (Telegram caps callback_data at 64 bytes; this format uses 46.)
 *
 * Sends via raw Bot API (fetch) to avoid a circular import with telegram.ts.
 */
import crypto from "node:crypto";
import { config } from "./config.js";

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** HMAC key. APPROVAL_SIGNING_SECRET (hex, 32+ bytes, distinct from the bot
 *  token) if configured; otherwise an ephemeral per-boot secret — safe
 *  because pending approvals live in this process's memory and don't survive
 *  a restart anyway. */
const SIG_SECRET = config.approvalSigningSecret
  ? Buffer.from(config.approvalSigningSecret, "hex")
  : crypto.randomBytes(32);
if (!config.approvalSigningSecret) {
  console.warn(
    "[approvals] APPROVAL_SIGNING_SECRET not set — using an ephemeral signing key (fine, but set one in .env for stability: openssl rand -hex 32)",
  );
}

export type ApprovalDecision = "approve" | "always" | "auto" | "deny";

const CODE: Record<ApprovalDecision, string> = { approve: "a", always: "l", auto: "u", deny: "d" };
const DECODE: Record<string, ApprovalDecision> = { a: "approve", l: "always", u: "auto", d: "deny" };

function sign(decisionCode: string, nonce: string, expSec: number): string {
  return crypto
    .createHmac("sha256", SIG_SECRET)
    .update(`${decisionCode}:${nonce}:${expSec}`)
    .digest("hex")
    .slice(0, 16); // 64-bit tag
}

interface PendingEntry {
  exp: number;
  cmdHash: string; // binds the nonce to the exact action text that was shown
  resolve: (decision: ApprovalDecision) => void;
}

const pending = new Map<string, PendingEntry>();

export async function requestApproval(description: string): Promise<ApprovalDecision> {
  const nonce = crypto.randomBytes(8).toString("hex"); // 64-bit, not 32
  const exp = Math.floor((Date.now() + APPROVAL_TIMEOUT_MS) / 1000);
  const cmdHash = crypto.createHash("sha256").update(description).digest("hex").slice(0, 16);

  const btn = (text: string, decision: ApprovalDecision) => {
    const code = CODE[decision];
    return { text, callback_data: `${code}:${nonce}:${exp}:${sign(code, nonce, exp)}` };
  };

  const res = await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramAllowedUserId,
        text: `🔐 Approval needed:\n\n${description.slice(0, 3500)}`,
        reply_markup: {
          inline_keyboard: [
            [btn("✅ Once", "approve"), btn("♻️ Always", "always")],
            [btn("🤖 Full auto", "auto"), btn("❌ Deny", "deny")],
          ],
        },
      }),
    },
  );
  if (!res.ok) {
    console.error("[approvals] failed to send request:", res.status, await res.text());
    return "deny"; // can't reach owner → fail closed
  }

  return new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(nonce);
      resolve("deny"); // timeout → fail closed
    }, APPROVAL_TIMEOUT_MS);
    pending.set(nonce, {
      exp,
      cmdHash,
      resolve: (decision) => {
        clearTimeout(timer);
        pending.delete(nonce);
        resolve(decision);
      },
    });
  });
}

/** Called by the Telegram callback_query handler with the raw callback_data.
 *  The HMAC check is the validation: forged, tampered, expired, or unknown
 *  tokens all return null. Returns the decision on success. */
export function resolveApproval(raw: string): ApprovalDecision | null {
  const parts = raw.split(":");
  if (parts.length !== 4) return null;
  const [code, nonce, expStr, sig] = parts;
  const decision = DECODE[code];
  const exp = Number(expStr);
  if (!decision || !nonce || !Number.isFinite(exp)) return null;
  if (Math.floor(Date.now() / 1000) > exp) return null; // expiry baked into the token
  const good = sign(code, nonce, exp);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) {
    console.warn(`[approvals] rejected callback with bad signature (nonce=${nonce})`);
    return null;
  }
  const entry = pending.get(nonce);
  console.log(
    `[approvals] callback nonce=${nonce} decision=${decision} cmd=${entry?.cmdHash ?? "?"} known=${Boolean(entry)} pending=${pending.size}`,
  );
  if (!entry) return null;
  entry.resolve(decision);
  return decision;
}
