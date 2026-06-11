/**
 * CLI interface — same brain, same agent, no Telegram required.
 * Usage: npm run cli  (or: node --env-file=../.env dist/cli.js)
 */
import readline from "node:readline/promises";
import { pool } from "./db.js";
import { runAgentTurn } from "./agent.js";

async function main(): Promise<void> {
  await pool.query("SELECT 1");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("second brain CLI — empty line or Ctrl-C to exit\n");

  for (;;) {
    const line = (await rl.question("you> ")).trim();
    if (!line) break;
    try {
      const reply = await runAgentTurn(line, "cli");
      console.log(`\nbrain> ${reply}\n`);
    } catch (err) {
      console.error("error:", err instanceof Error ? err.message : err);
    }
  }
  rl.close();
  await pool.end();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
