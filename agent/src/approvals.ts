/**
 * Human-in-the-loop approval over Telegram.
 *
 * Flow: canUseTool wants a risky action → requestApproval() sends Tyler a
 * message with Approve/Deny buttons and parks the turn on a promise →
 * telegram.ts resolves it from the callback_query → the tool call proceeds
 * or is denied. Unanswered requests deny after a timeout.
 *
 * Sends via raw Bot API (fetch) to avoid a circular import with telegram.ts.
 */
import crypto from "node:crypto";
import { config } from "./config.js";

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export type ApprovalDecision = "approve" | "always" | "auto" | "deny";

const pending = new Map<string, (decision: ApprovalDecision) => void>();

export async function requestApproval(description: string): Promise<ApprovalDecision> {
  const id = crypto.randomUUID().slice(0, 8);

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
            [
              { text: "✅ Once", callback_data: `approve:${id}` },
              { text: "♻️ Always", callback_data: `always:${id}` },
            ],
            [
              { text: "🤖 Full auto", callback_data: `auto:${id}` },
              { text: "❌ Deny", callback_data: `deny:${id}` },
            ],
          ],
        },
      }),
    },
  );
  if (!res.ok) {
    console.error("[approvals] failed to send request:", res.status, await res.text());
    return "deny"; // can't reach Tyler → fail closed
  }

  return new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve("deny"); // timeout → fail closed
    }, APPROVAL_TIMEOUT_MS);
    pending.set(id, (decision) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(decision);
    });
  });
}

/** Called by the Telegram callback_query handler. Returns false if unknown/expired. */
export function resolveApproval(id: string, decision: ApprovalDecision): boolean {
  const resolver = pending.get(id);
  console.log(
    `[approvals] callback id=${id} decision=${decision} known=${Boolean(resolver)} pending=${pending.size}`,
  );
  if (!resolver) return false;
  resolver(decision);
  return true;
}
