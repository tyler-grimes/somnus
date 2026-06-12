/**
 * Direct Anthropic SDK helper for background (non-agentic) LLM work:
 * structured extraction with schema validation + spend accounting.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "./config.js";
import { logSpend } from "./db.js";

const client = new Anthropic();

// $/MTok — used for the budget gate; close enough for a cap, not for invoicing.
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK["claude-opus-4-8"];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export async function extractStructured<T extends z.ZodType>(opts: {
  purpose: string;
  system: string;
  user: string;
  schema: T;
  maxTokens?: number;
  model?: string;
}): Promise<z.infer<T>> {
  const model = opts.model ?? config.dreamModel;
  const response = await client.messages.parse({
    model,
    max_tokens: opts.maxTokens ?? 8000,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    output_config: { format: zodOutputFormat(opts.schema) },
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  await logSpend({
    model,
    purpose: opts.purpose,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`extraction failed (${opts.purpose}): stop_reason=${response.stop_reason}`);
  }
  return response.parsed_output;
}
