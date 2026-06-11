/**
 * Configuration. Fail fast and loud on anything missing — a half-configured
 * always-on agent is a security bug, not a convenience.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  /** The ONLY Telegram user this bot will talk to. Everything else is dropped. */
  telegramAllowedUserId: Number(required("TELEGRAM_ALLOWED_USER_ID")),
  databaseUrl: required("DATABASE_URL"),
  /** Hard daily ceiling. Agent refuses to run once crossed. */
  dailySpendLimitUsd: Number(process.env.DAILY_SPEND_LIMIT_USD ?? "10"),
  model: process.env.AGENT_MODEL ?? "claude-opus-4-8",
  /** Background maintenance model (dream cycle). Sonnet per Tyler's
   *  haiku/sonnet-for-background-agents preference. */
  dreamModel: process.env.DREAM_MODEL ?? "claude-sonnet-4-6",
  timezone: process.env.TZ ?? "America/Denver",
  /** Scratch directory the agent may write to and run code in. */
  workspaceDir: process.env.WORKSPACE_DIR ?? "",
  /**
   * Skip Telegram approval for Bash commands. Leave false on a host machine;
   * set true only when the agent runs inside a locked-down container.
   */
  bashAutoApprove: process.env.BASH_AUTO_APPROVE === "true",
};

if (!Number.isInteger(config.telegramAllowedUserId) || config.telegramAllowedUserId <= 0) {
  console.error("TELEGRAM_ALLOWED_USER_ID must be a positive integer (your numeric Telegram user id)");
  process.exit(1);
}
